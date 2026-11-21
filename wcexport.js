// Fast MP4 export with WebCodecs: sources are demuxed (mp4box.js) and decoded by the browser's (hardware)
// VideoDecoder, every output frame is drawn with the same WebGL look as the preview (fx.js), encoded by the
// (hardware) H.264 VideoEncoder and muxed with mp4-muxer straight into an MP4 with the moov atom first.
// Audio is mixed in JS (crossfades, slow-mo time-stretch, boomerangs) and encoded to AAC with AudioEncoder;
// where AudioEncoder can't do AAC, only the audio is encoded by ffmpeg.wasm and the H.264 is stream-copied.
// Exports with no visual changes are stream-copied without any re-encode (remux).
import { createFile, DataStream, Endianness, MP4BoxBuffer } from './vendor/webcodecs/mp4box.js';
import { Muxer, ArrayBufferTarget } from './vendor/webcodecs/mp4-muxer.js';
import { outputSize, xfadeDurations, clipDur, fwdDur, clipSpeed, srcAt, camP, clipColor, drawCaption, hasWarp, hasFish } from './render.js';
import { createFx } from './fx.js';

const FPS = 30, SR = 48000;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------- capability check ----------------
let capCache = null;
export async function wcCaps(W = 1280, H = 720) {
  const key = W + 'x' + H;
  if (capCache?.key === key) return capCache;
  const out = { key, video: null, aac: false, decode: typeof VideoDecoder !== 'undefined' };
  if (typeof VideoEncoder === 'undefined' || typeof VideoFrame === 'undefined' || !out.decode) return capCache = out;
  const lvl = W * H > 1280 * 720 ? '28' : '1f';
  for (const codec of [`avc1.6400${lvl}`, `avc1.4d00${lvl}`, `avc1.42e0${lvl}`, 'avc1.640028', 'avc1.42e028']) {
    for (const hw of ['prefer-hardware', 'no-preference']) {
      const cfg = { codec, width: W, height: H, bitrate: 5e6, framerate: FPS, avc: { format: 'avc' }, hardwareAcceleration: hw, latencyMode: 'quality' };
      try { const r = await VideoEncoder.isConfigSupported(cfg); if (r.supported) { out.video = { ...cfg, hw }; break; } } catch {}
    }
    if (out.video) break;
  }
  if (typeof AudioEncoder !== 'undefined') {
    try { out.aac = !!(await AudioEncoder.isConfigSupported({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 160000 })).supported; } catch {}
  }
  return capCache = out;
}

// ---------------- demux (mp4 / mov) ----------------
const demuxCache = new WeakMap(); // blob -> Promise<demuxed>
export function demux(blob) {
  if (!demuxCache.has(blob)) demuxCache.set(blob, doDemux(blob));
  return demuxCache.get(blob);
}
async function doDemux(blob) {
  const file = createFile();
  let info = null, err = null;
  file.onReady = (i) => { info = i; };
  file.onError = (e) => { err = e; };
  let pos = 0;
  // read box by box: mp4box tells us where it needs to continue, so a big mdat before the moov is skipped
  for (let guard = 0; !info && !err && pos < blob.size && guard < 400; guard++) {
    const end = Math.min(blob.size, pos + (pos === 0 ? 1 << 20 : 2 << 20));
    const buf = MP4BoxBuffer.fromArrayBuffer(await blob.slice(pos, end).arrayBuffer(), pos);
    const next = file.appendBuffer(buf);
    pos = typeof next === 'number' && next > pos ? next : end;
  }
  if (!info) throw new Error('Could not read this file’s structure' + (err ? ': ' + err : ''));
  const vt = info.videoTracks[0];
  if (!vt) throw new Error('No video track');
  const trak = file.getTrackById(vt.id);
  const entry = trak.mdia.minf.stbl.stsd.entries[0];
  const cbox = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
  let description;
  if (cbox) { const s = new DataStream(undefined, 0, Endianness.BIG_ENDIAN); cbox.write(s); description = new Uint8Array(s.buffer, 8); }
  const samples = file.getTrackSamplesInfo(vt.id);
  const tsc = vt.timescale;
  const off = samples.reduce((m, s) => Math.min(m, s.cts), Infinity);
  const vs = samples.map(s => ({ cts: (s.cts - off) / tsc, dts: (s.dts - off) / tsc, dur: s.duration / tsc, key: !!s.is_sync, offset: s.offset, size: s.size }));
  // phone rotation (tkhd matrix): 1 = 90° clockwise, 2 = 180°, 3 = 270°
  const m = vt.matrix || [65536, 0, 0, 0, 65536, 0];
  const a = m[0] / 65536, b = m[1] / 65536;
  const rot = Math.abs(a) > 0.5 ? (a < 0 ? 2 : 0) : (b > 0 ? 1 : 3);
  const cw = vt.video?.width || entry.width, ch = vt.video?.height || entry.height;
  const res = { codec: vt.codec, description, codedWidth: cw, codedHeight: ch, rot, w: rot % 2 ? ch : cw, h: rot % 2 ? cw : ch,
    fps: vs.length > 1 ? (vs.length - 1) / Math.max(0.001, Math.max(...vs.map(s => s.cts))) : 30, samples: vs, blob, audio: null };
  const at = info.audioTracks[0];
  if (at) {
    const atrak = file.getTrackById(at.id), aen = atrak.mdia.minf.stbl.stsd.entries[0];
    // ISO mp4a carries esds directly; QuickTime-style (iPhone) mp4a v1 nests it in a 'wave' box
    const esds = aen.esds || aen.wave?.esds || (aen.boxes || []).flatMap(b => [b, ...(b.boxes || [])]).find(b => b.type === 'esds');
    let asc = esds?.esd?.descs?.[0]?.descs?.[0]?.data;
    if (!asc || !asc.length) { // synthesize an AAC-LC AudioSpecificConfig
      const fi = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350].indexOf(at.audio?.sample_rate), ch = at.audio?.channel_count || 2;
      asc = fi >= 0 ? [(2 << 3) | (fi >> 1), ((fi & 1) << 7) | (ch << 3)] : null;
    }
    const as = file.getTrackSamplesInfo(at.id), atsc = at.timescale;
    res.audio = { codec: at.codec, sampleRate: at.audio?.sample_rate, channels: at.audio?.channel_count, asc: asc ? new Uint8Array(asc) : null,
      samples: as.map(s => ({ cts: s.cts / atsc, dur: s.duration / atsc, offset: s.offset, size: s.size })) };
  }
  const cfg = { codec: res.codec, codedWidth: cw, codedHeight: ch, description };
  try { res.decodable = !!(await VideoDecoder.isConfigSupported(cfg)).supported; } catch { res.decodable = false; }
  return res;
}
// reads sample bytes through a sliding 4 MB window (sample data is mostly sequential)
function byteReader(blob) {
  let wa = -1, wb = -1, buf = null;
  return async (offset, size) => {
    if (offset < wa || offset + size > wb) { wa = offset; wb = Math.min(blob.size, offset + Math.max(size, 4 << 20)); buf = new Uint8Array(await blob.slice(wa, wb).arrayBuffer()); }
    return buf.subarray(offset - wa, offset - wa + size);
  };
}

// ---------------- decoding: frames of one clip in presentation order ----------------
class FrameReader {
  constructor(dm, t0) {
    this.dm = dm; this.q = []; this.ended = false; this.err = null; this.wake = null;
    this.read = byteReader(dm.blob);
    const s = dm.samples;
    let k = 0; for (let i = 0; i < s.length; i++) { if (s[i].key && s[i].cts <= t0 + 1e-3) k = i; if (s[i].dts > t0 + 2) break; }
    this.next = k;
    this.dec = new VideoDecoder({
      output: (f) => { this.q.push(f); this.q.sort((x, y) => x.timestamp - y.timestamp); this.wake?.(); },
      error: (e) => { this.err = e; this.wake?.(); },
    });
    this.dec.configure({ codec: dm.codec, codedWidth: dm.codedWidth, codedHeight: dm.codedHeight, description: dm.description, optimizeForLatency: false });
  }
  waitOut(ms = 40) { return new Promise(r => { const t = setTimeout(() => { this.wake = null; r(); }, ms); this.wake = () => { clearTimeout(t); this.wake = null; r(); }; }); }
  async ensure(us) {
    for (let guard = 0; guard < 100000; guard++) {
      if (this.err) throw this.err;
      if (this.q.length && this.q[this.q.length - 1].timestamp > us) return;
      if (this.ended) return;
      if (this.next < this.dm.samples.length) {
        if (this.dec.decodeQueueSize > 6) { await this.waitOut(); continue; }
        const s = this.dm.samples[this.next++];
        const data = await this.read(s.offset, s.size);
        this.dec.decode(new EncodedVideoChunk({ type: s.key ? 'key' : 'delta', timestamp: Math.round(s.cts * 1e6), duration: Math.round(s.dur * 1e6), data }));
        if (this.next % 4 === 0) await this.waitOut(0);
      } else { await this.dec.flush().catch(e => { this.err = e; }); this.ended = true; }
    }
  }
  /** frames around source time t (s): f0 = last frame at/before t, f1 = the next one, w = blend weight */
  async at(t) {
    const us = t * 1e6 + 500;
    await this.ensure(us);
    while (this.q.length > 1 && this.q[1].timestamp <= us) this.q.shift().close();
    const f0 = this.q[0], f1 = this.q[1];
    if (!f0) return null;
    const w = f1 && f1.timestamp > f0.timestamp ? Math.max(0, Math.min(1, (us - f0.timestamp) / (f1.timestamp - f0.timestamp))) : 0;
    return { f0, f1, w };
  }
  close() { for (const f of this.q) try { f.close(); } catch {} this.q = []; try { this.dec.close(); } catch {} }
}

// ---------------- audio ----------------
async function decodeAudio(blob) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ac = new AC(2, SR, SR);
  const ab = await blob.arrayBuffer();
  return await new Promise((res, rej) => { const p = ac.decodeAudioData(ab, res, rej); if (p?.then) p.then(res, rej); });
}
// overlap-add time stretch (keeps pitch) for slow motion: returns ~len/sp samples per channel
function stretch(chs, sp) {
  const N = 2048, Hs = 512, Ha = Hs * sp, len = chs[0].length, outLen = Math.ceil(len / sp) + N;
  const win = new Float32Array(N); for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const out = chs.map(() => new Float32Array(outLen)), norm = new Float32Array(outLen);
  for (let k = 0; ; k++) {
    const ia = Math.round(k * Ha), is = k * Hs; if (ia >= len) break;
    for (let i = 0; i < N && is + i < outLen; i++) {
      const w = win[i]; norm[is + i] += w;
      for (let c = 0; c < chs.length; c++) out[c][is + i] += (chs[c][ia + i] || 0) * w;
    }
  }
  for (let c = 0; c < out.length; c++) for (let i = 0; i < outLen; i++) if (norm[i] > 1e-3) out[c][i] /= norm[i];
  return out;
}
async function mixAudio(proj, media, tl, onStage) {
  const clips = proj.clips, total = Math.round(tl.total * SR);
  const L = new Float32Array(total), R = new Float32Array(total);
  const bufs = new Map();
  let any = false;
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i];
    if (c.muted) continue;
    const m = media.get(c.mediaId);
    if (!bufs.has(c.mediaId)) {
      onStage?.('Mixing audio…');
      const dm = await demux(m.blob).catch(() => null);
      let ab = null; if (!dm || dm.audio) { try { ab = await decodeAudio(m.blob); } catch { ab = null; } }
      bufs.set(c.mediaId, ab);
    }
    const ab = bufs.get(c.mediaId); if (!ab) continue;
    any = true;
    const ch = [ab.getChannelData(0), ab.getChannelData(ab.numberOfChannels > 1 ? 1 : 0)];
    const sp = clipSpeed(c), a0 = Math.max(0, Math.round(c.in * SR)), a1 = Math.min(ch[0].length, Math.round(c.out * SR));
    let seg = ch.map(x => x.subarray(a0, a1));
    if (sp < 0.999) seg = stretch(seg, sp);
    const F = fwdDur(c), segLen = Math.round(F * SR);
    const start = Math.round(tl.T[i] * SR), D = Math.round(tl.d[i] * SR);
    const xin = Math.round((i > 0 ? tl.X[i - 1] : 0) * SR), xout = Math.round((i < tl.X.length ? tl.X[i] : 0) * SR);
    const fadeB = Math.round(0.15 * SR);
    for (let n = 0; n < D; n++) {
      const o = start + n; if (o >= total) break;
      let v0, v1;
      if (n < segLen) { v0 = seg[0][n] || 0; v1 = seg[1][n] || 0; } else continue; // boomerang: silent while it plays back
      let g = 1;
      if (xin && n < xin) g *= n / xin;
      if (xout && n > D - xout) g *= (D - n) / xout;
      if (c.boom && n > segLen - fadeB) g *= (segLen - n) / fadeB;
      L[o] += v0 * g; R[o] += v1 * g;
    }
  }
  return any ? [L, R] : null;
}
function wavBytes(chs) {
  const n = chs[0].length, buf = new ArrayBuffer(44 + n * 4), dv = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, 'RIFF'); dv.setUint32(4, 36 + n * 4, true); ws(8, 'WAVE'); ws(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 2, true);
  dv.setUint32(24, SR, true); dv.setUint32(28, SR * 4, true); dv.setUint16(32, 4, true); dv.setUint16(34, 16, true); ws(36, 'data'); dv.setUint32(40, n * 4, true);
  let o = 44; for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) { const v = Math.max(-1, Math.min(1, chs[c][i])); dv.setInt16(o, v < 0 ? v * 32768 : v * 32767, true); o += 2; }
  return new Uint8Array(buf);
}
async function encodeAac(chs, muxer) {
  // Re-time every chunk ourselves: one AAC-LC frame = 1024 samples. WebKit's AudioEncoder (Safari/iPhone)
  // stamps all frames from one AudioData with the same input timestamp, which breaks playback if trusted.
  let nOut = 0, err = null;
  const enc = new AudioEncoder({ output: (chunk, meta) => {
    const data = new Uint8Array(chunk.byteLength); chunk.copyTo(data);
    muxer.addAudioChunkRaw(data, chunk.type || 'key', Math.round(nOut * 1024 / SR * 1e6), Math.round(1024 / SR * 1e6), meta);
    nOut++;
  }, error: (e) => { err = e; } });
  enc.configure({ codec: 'mp4a.40.2', sampleRate: SR, numberOfChannels: 2, bitrate: 160000 });
  const n = chs[0].length, B = 4800;
  for (let s = 0; s < n; s += B) {
    const k = Math.min(B, n - s), data = new Float32Array(k * 2);
    data.set(chs[0].subarray(s, s + k), 0); data.set(chs[1].subarray(s, s + k), k);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: SR, numberOfFrames: k, numberOfChannels: 2, timestamp: Math.round(s / SR * 1e6), data });
    enc.encode(ad); ad.close();
    if (err) throw err;
    if (enc.encodeQueueSize > 20) await sleep(1);
  }
  await enc.flush(); enc.close();
  if (err) throw err;
}

// ---------------- timeline (identical to the ffmpeg export) ----------------
function timeline(clips, xf) {
  const q = (x) => Math.round(x * FPS) / FPS;
  const d = clips.map(c => Math.max(2 / FPS, q(clipDur(c))));
  const X = xfadeDurations(clips, xf, FPS);
  const T = []; let t = 0; d.forEach((di, i) => { T.push(t); t += di - (X[i] || 0); });
  const total = d.reduce((a, b) => a + b, 0) - X.reduce((a, b) => a + b, 0);
  return { d, X, T, total };
}

/** why this project can't take the fast path (null = it can) */
export async function wcBlocker(proj, media, opts = {}) {
  const [W, H] = outputSize(proj.clips, opts.res);
  const caps = await wcCaps(W, H);
  if (!caps.video) return 'this browser has no H.264 WebCodecs encoder';
  for (const id of new Set(proj.clips.map(c => c.mediaId))) {
    const m = media.get(id); if (!m) return 'missing media';
    let dm; try { dm = await demux(m.blob); } catch (e) { return `can’t read ${m.name}`; }
    if (!dm.decodable) return `this browser can’t decode ${dm.codec}`;
    if ((proj.slowmo || 'fast') === 'smooth' && proj.clips.some(c => c.mediaId === id && clipSpeed(c) < 0.999 && dm.fps * clipSpeed(c) < 29)) return 'smooth slow-mo (motion interpolation) needs the ffmpeg engine';
  }
  return null;
}

// ---------------- stream copy (no re-encode) ----------------
function needsNoRender(proj, opts) {
  const p = proj.color || {};
  if ((p.b || 0) !== 0 || (p.c ?? 1) !== 1 || (p.s ?? 1) !== 1 || p.w) return false;
  if (opts.burnCaptions && (proj.captions || []).some(c => c.text)) return false;
  if (proj.clips.length > 1 && (+proj.xfade || 0) > 0) return false;
  return proj.clips.every(c => !c.enh && !c.boom && clipSpeed(c) >= 0.999 && !c.muted && (!c.cam || (c.cam.z0 <= 1.001 && c.cam.z1 <= 1.001 && !c.cam.flip && !hasWarp(c.cam) && !hasFish(c.cam))));
}
export async function canRemux(proj, media, opts) {
  if (!needsNoRender(proj, opts)) return false;
  const ids = [...new Set(proj.clips.map(c => c.mediaId))];
  const dms = await Promise.all(ids.map(id => demux(media.get(id).blob).catch(() => null)));
  if (dms.some(d => !d || !/^(avc1|avc3|hvc1|hev1)/.test(d.codec))) return false;
  const sig = (d) => d.codec + ':' + d.codedWidth + 'x' + d.codedHeight + ':' + Array.from(d.description || []).join(',') + ':' + d.rot + ':' + (d.audio ? d.audio.codec + d.audio.sampleRate + Array.from(d.audio.asc || []).join(',') : 'noaudio');
  return dms.every(d => sig(d) === sig(dms[0])) && (!dms[0].audio || /^mp4a/.test(dms[0].audio.codec));
}
export async function remuxExport(proj, media, opts = {}) {
  const { onProgress = () => {} } = opts;
  const t0 = performance.now();
  const dm0 = await demux(media.get(proj.clips[0].mediaId).blob);
  const hevc = /^(hvc1|hev1)/.test(dm0.codec);
  const target = new ArrayBufferTarget();
  const muxer = new Muxer({ target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
    video: { codec: hevc ? 'hevc' : 'avc', width: dm0.codedWidth, height: dm0.codedHeight, rotation: [0, 90, 180, 270][dm0.rot] },
    audio: dm0.audio ? { codec: 'aac', numberOfChannels: dm0.audio.channels || 2, sampleRate: dm0.audio.sampleRate || 44100 } : undefined });
  const vmeta = { decoderConfig: { codec: dm0.codec, codedWidth: dm0.codedWidth, codedHeight: dm0.codedHeight, description: dm0.description } };
  const ameta = dm0.audio ? { decoderConfig: { codec: 'mp4a.40.2', sampleRate: dm0.audio.sampleRate, numberOfChannels: dm0.audio.channels, description: dm0.audio.asc } } : null;
  let tOut = 0, aOut = 0;
  for (let i = 0; i < proj.clips.length; i++) {
    const c = proj.clips[i], dm = await demux(media.get(c.mediaId).blob), rd = byteReader(dm.blob), s = dm.samples;
    let k = 0; for (let j = 0; j < s.length; j++) if (s[j].key && s[j].cts <= c.in + 1e-3) k = j;
    let last = k; for (let j = k; j < s.length; j++) if (s[j].cts < c.out - 1e-3) last = j;
    const base = s[k].cts; // starts at the keyframe at/before the in point (no re-encode)
    let end = 0;
    for (let j = k; j <= last; j++) {
      const x = s[j], data = await rd(x.offset, x.size);
      const pts = tOut + (x.cts - base), dts = tOut + (x.dts - s[k].dts);
      muxer.addVideoChunkRaw(new Uint8Array(data), x.key ? 'key' : 'delta', Math.max(0, pts * 1e6), x.dur * 1e6, j === k && i === 0 ? vmeta : undefined, (pts - dts) * 1e6);
      end = Math.max(end, x.cts - base + x.dur);
    }
    if (dm.audio && ameta) {
      const ard = byteReader(dm.blob);
      for (const a of dm.audio.samples) {
        if (a.cts + a.dur <= base || a.cts >= base + end) continue;
        const data = await ard(a.offset, a.size);
        muxer.addAudioChunkRaw(new Uint8Array(data), 'key', Math.max(0, aOut + (a.cts - base)) * 1e6, a.dur * 1e6, aOut === 0 && i === 0 ? ameta : undefined);
      }
    }
    tOut += end; aOut = tOut;
    onProgress(Math.min(0.99, (i + 1) / proj.clips.length), `Copying shot ${i + 1} of ${proj.clips.length} (no re-encode)…`);
  }
  muxer.finalize();
  onProgress(1, 'Done');
  return { blob: new Blob([target.buffer], { type: 'video/mp4' }), ext: 'mp4', W: dm0.w, H: dm0.h, duration: tOut, path: 'remux', secs: (performance.now() - t0) / 1000 };
}

// ---------------- fast re-encode ----------------
export function createWcExport(proj, media, opts = {}) {
  let cancelled = false;
  async function run() {
    const { onProgress = () => {} } = opts;
    const t0 = performance.now();
    const clips = proj.clips;
    if (!clips.length) throw new Error('Timeline is empty');
    const [W0, H0] = outputSize(clips, opts.res);
    const W = Math.max(8, Math.round(W0 / 8) * 8), H = Math.max(4, Math.round(H0 / 4) * 4); // I420 packing wants these
    const caps = await wcCaps(W, H);
    if (!caps.video) throw new Error('No H.264 WebCodecs encoder');
    const tl = timeline(clips, +proj.xfade || 0);
    const N = Math.max(1, Math.round(tl.total * FPS));
    const dms = new Map();
    for (const id of new Set(clips.map(c => c.mediaId))) dms.set(id, await demux(media.get(id).blob));
    // audio first (cheap): mixed PCM -> AAC
    onProgress(0.01, 'Mixing audio…');
    const pcm = await mixAudio(proj, media, tl, (m) => onProgress(0.01, m));
    const useAac = !!pcm && caps.aac;
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({ target, fastStart: 'in-memory', firstTimestampBehavior: 'offset',
      video: { codec: 'avc', width: W, height: H, frameRate: FPS },
      audio: useAac ? { codec: 'aac', numberOfChannels: 2, sampleRate: SR } : undefined });
    if (useAac) await encodeAac(pcm, muxer);
    // video encoder
    const q = opts.crf || 23, bpp = q <= 19 ? 0.16 : q >= 28 ? 0.065 : 0.1;
    const bitrate = Math.round(Math.min(16e6, Math.max(1.5e6, W * H * FPS * bpp)));
    let encErr = null;
    const enc = new VideoEncoder({ output: (chunk, meta) => muxer.addVideoChunk(chunk, meta), error: (e) => { encErr = e; } });
    enc.configure({ ...caps.video, bitrate, bitrateMode: 'variable' });
    // renderer
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const fx = createFx(cv);
    if (!fx) throw new Error('WebGL unavailable');
    const caps2 = opts.burnCaptions ? (proj.captions || []).filter(c => c.text && c.end > c.start) : [];
    let cv2 = null, ctx2 = null;
    if (caps2.length) { cv2 = document.createElement('canvas'); cv2.width = W; cv2.height = H; ctx2 = cv2.getContext('2d'); }
    const warmRaw = proj.color?.w || 0;
    const warm = warmRaw ? (warmRaw > 0 ? [1, 140 / 255, 30 / 255, Math.min(1, Math.abs(warmRaw)) * 0.55] : [30 / 255, 120 / 255, 1, Math.min(1, Math.abs(warmRaw)) * 0.55]) : null;
    const readers = new Map(), booms = new Map();
    const getReader = (i) => {
      if (!readers.has(i)) { const c = clips[i]; readers.set(i, new FrameReader(dms.get(c.mediaId), srcAt(c, 0))); }
      return readers.get(i);
    };
    const drawClip = async (i, l, alpha, gain, layer) => {
      const c = clips[i], dm = dms.get(c.mediaId), sp = clipSpeed(c), F = fwdDur(c);
      const look = { alpha, gain, layer, rot: dm.rot, color: clipColor(proj, c), warm, sharp: c.enh?.sh ? 0.35 : 0 };
      const p = camP(c, l), ts = srcAt(c, l);
      if (c.boom && l > F + 0.5 / FPS) { // reverse half: frames kept from the forward half
        const arr = booms.get(i) || []; if (!arr.length) return;
        let b = arr[0]; for (const x of arr) if (Math.abs(x.t - ts) < Math.abs(b.t - ts)) b = x;
        fx.draw(b.bmp, dm.w, dm.h, c.cam, p, look); return;
      }
      const fr = await getReader(i).at(ts); if (!fr) return;
      const blend = sp < 0.999 && fr.f1 && fr.w > 0.02 && fr.w < 0.98; // slow-mo: blend neighbouring frames
      const use = !blend && fr.f1 && fr.w > 0.5 ? fr.f1 : fr.f0;
      fx.draw(use, dm.w, dm.h, c.cam, p, blend ? { ...look, src2: fr.f1, mix: fr.w } : look);
      if (c.boom) {
        let arr = booms.get(i); if (!arr) booms.set(i, arr = []);
        if (!arr.length || ts > arr[arr.length - 1].t + 1e-4) {
          const k = Math.min(1, 960 / Math.max(dm.codedWidth, dm.codedHeight));
          arr.push({ t: ts, bmp: await createImageBitmap(use, { resizeWidth: Math.round(dm.codedWidth * k), resizeHeight: Math.round(dm.codedHeight * k) }) });
        }
      }
    };
    // frames are tagged BT.709 limited range so the H.264 stream is plain yuv420p (what iPhone Photos expects)
    const CS = { primaries: 'bt709', transfer: 'bt709', matrix: 'bt709', fullRange: false };
    let csOk = true;
    const makeFrame = (src, k) => {
      const init = { timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS) };
      if (csOk) { try { return new VideoFrame(src, { ...init, colorSpace: CS }); } catch { csOk = false; } }
      return new VideoFrame(src, init);
    };
    let yuv = null; try { yuv = createYuv(fx, W, H); } catch (e) { console.warn('[wc] I420 pass unavailable, using canvas frames', e); }
    let capKey = '';
    const tStart = performance.now();
    try {
      for (let k = 0; k < N; k++) {
        if (cancelled) throw new Error('Cancelled');
        if (encErr) throw encErr;
        const t = k / FPS;
        // active shots at t (two during a crossfade)
        let i = 0; while (i < clips.length - 1 && t >= tl.T[i] + tl.d[i] - (tl.X[i] || 0) - 1e-6) i++;
        const prev = i > 0 && t < tl.T[i - 1] + tl.d[i - 1] - 1e-6 ? i - 1 : -1;
        for (const [j, r] of readers) if (j < (prev >= 0 ? prev : i)) { r.close(); readers.delete(j); const b = booms.get(j); if (b) { b.forEach(x => x.bmp.close?.()); booms.delete(j); } }
        if (yuv) yuv.begin();
        fx.clear();
        if (prev >= 0) {
          const a = Math.max(0, Math.min(1, (t - tl.T[i]) / (tl.X[prev] || 1)));
          if (proj.xfadeType === 'black') {
            if (a < 0.5) await drawClip(prev, t - tl.T[prev], 1, 1 - 2 * a, false);
            else await drawClip(i, t - tl.T[i], 1, 2 * a - 1, false);
          } else {
            await drawClip(prev, t - tl.T[prev], 1, 1, false);
            await drawClip(i, t - tl.T[i], a, 1, true);
          }
        } else await drawClip(i, t - tl.T[i], 1, 1, false);
        let vf;
        const act = ctx2 ? caps2.filter(cp => { const pt = previewTime(tl, clips, t); return pt >= cp.start && pt < cp.end; }) : [];
        if (yuv) {
          if (act.length) { const key = act.map(c => c.id || c.text).join('|'); if (key !== capKey) { capKey = key; ctx2.clearRect(0, 0, W, H); act.forEach(cp => drawCaption(ctx2, cp, W, H)); } yuv.overlay(cv2); }
          const buf = yuv.read();
          vf = new VideoFrame(buf, { format: 'I420', codedWidth: W, codedHeight: H, timestamp: Math.round(k * 1e6 / FPS), duration: Math.round(1e6 / FPS), colorSpace: CS });
        } else {
          let srcCanvas = cv;
          if (act.length) { ctx2.drawImage(cv, 0, 0); act.forEach(cp => drawCaption(ctx2, cp, W, H)); srcCanvas = cv2; }
          vf = makeFrame(srcCanvas, k);
        }
        enc.encode(vf, { keyFrame: k % (FPS * 2) === 0 }); vf.close();
        while (enc.encodeQueueSize > 6) await sleep(2);
        if (k % 5 === 0 || k === N - 1) {
          const el = (performance.now() - tStart) / 1000, rate = (k + 1) / Math.max(0.001, el), eta = (N - k - 1) / Math.max(0.1, rate);
          onProgress(0.02 + 0.93 * (k + 1) / N, `Encoding ${Math.round(t)}/${Math.round(tl.total)} s · ${(rate / FPS).toFixed(1)}× real time · about ${Math.ceil(eta)} s left`);
        }
      }
      await enc.flush();
    } finally {
      for (const r of readers.values()) r.close();
      for (const b of booms.values()) b.forEach(x => x.bmp.close?.());
      try { enc.close(); } catch {}
    }
    muxer.finalize();
    let blob = new Blob([target.buffer], { type: 'video/mp4' }), audioPath = useAac ? 'aac-webcodecs' : pcm ? 'aac-ffmpeg' : 'none';
    if (pcm && !useAac) { // this browser can't encode AAC: ffmpeg encodes just the audio, video is stream-copied
      onProgress(0.96, 'Adding audio…');
      const { getFF } = await import('./exporter.js');
      const f = await getFF(() => {}, (m) => onProgress(0.96, m));
      await f.writeFile('wv.mp4', new Uint8Array(target.buffer)); await f.writeFile('wa.wav', wavBytes(pcm));
      const code = await f.exec(['-hide_banner', '-nostdin', '-i', 'wv.mp4', '-i', 'wa.wav', '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-tag:v', 'avc1', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', 'wo.mp4']);
      if (code !== 0) throw new Error('adding audio failed');
      const data = await f.readFile('wo.mp4');
      for (const n of ['wv.mp4', 'wa.wav', 'wo.mp4']) try { await f.deleteFile(n); } catch {}
      blob = new Blob([data.buffer], { type: 'video/mp4' });
    }
    onProgress(1, 'Done');
    return { blob, ext: 'mp4', W, H, duration: tl.total, path: 'webcodecs', hw: caps.video.hw, codec: caps.video.codec, audioPath, secs: (performance.now() - t0) / 1000 };
  }
  return { run, cancel: () => { cancelled = true; } };
}
// export time -> preview-timeline time (captions are placed on the preview timeline, like the ffmpeg export)
function previewTime(tl, clips, t) {
  let i = 0; while (i < clips.length - 1 && t >= tl.T[i + 1]) i++;
  let P = 0; for (let j = 0; j < i; j++) P += tl.d[j];
  return P + (t - tl.T[i]);
}

// ---------------- GPU RGB -> I420 (BT.709 limited range) so the H.264 stream is plain yuv420p ----------------
// The look is rendered into an offscreen texture; a second pass packs Y, U and V bytes into an RGBA target laid out
// exactly like an I420 buffer, which is read back once per frame and handed to the encoder.
function createYuv(fx, W, H) {
  const gl = fx.gl;
  if (W % 8 || H % 4) return null;
  const mkT = (w, h) => { const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    [[gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE], [gl.TEXTURE_MIN_FILTER, gl.LINEAR], [gl.TEXTURE_MAG_FILTER, gl.LINEAR]].forEach(([k, v]) => gl.texParameteri(gl.TEXTURE_2D, k, v));
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null); return t; };
  const mkF = (t) => { const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f); gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0); return f; };
  const texA = mkT(W, H), fbA = mkF(texA), OW = W / 4, OH = H * 3 / 2, texB = mkT(OW, OH), fbB = mkF(texB);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) { gl.bindFramebuffer(gl.FRAMEBUFFER, null); return null; }
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  const VS = `attribute vec2 a; varying vec2 v; void main(){ v = vec2(a.x * 0.5 + 0.5, a.y * 0.5 + 0.5); gl_Position = vec4(a, 0.0, 1.0); }`;
  const prog = (fs) => { const p = gl.createProgram(); const sh = (t, src) => { const s = gl.createShader(t); gl.shaderSource(s, src); gl.compileShader(s); if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s)); return s; };
    gl.attachShader(p, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs)); gl.bindAttribLocation(p, 0, 'a'); gl.linkProgram(p); return p; };
  const pY = prog(`precision highp float; uniform sampler2D t; uniform vec2 S;
    vec3 px(vec2 xy) { return texture2D(t, vec2(xy.x / S.x, 1.0 - xy.y / S.y)).rgb; }
    float Yv(vec3 c) { return (16.0 + 219.0 * dot(c, vec3(0.2126, 0.7152, 0.0722))) / 255.0; }
    float Uv(vec3 c) { return (128.0 + 224.0 * dot(c, vec3(-0.114572, -0.385428, 0.5))) / 255.0; }
    float Vv(vec3 c) { return (128.0 + 224.0 * dot(c, vec3(0.5, -0.454153, -0.045847))) / 255.0; }
    void main() {
      float fx = floor(gl_FragCoord.x), fy = floor(gl_FragCoord.y), W = S.x, H = S.y;
      vec4 o;
      if (fy < H) { for (int k = 0; k < 4; k++) { float x = fx * 4.0 + float(k); o[k] = Yv(px(vec2(x + 0.5, fy + 0.5))); } }
      else {
        bool isV = fy >= H * 1.25; float base = isV ? H * 1.25 : H;
        for (int k = 0; k < 4; k++) {
          float b = ((fy - base) * (W / 4.0) + fx) * 4.0 + float(k);
          float uy = floor(b / (W / 2.0)), ux = b - uy * (W / 2.0);
          vec3 c = px(vec2(2.0 * ux + 1.0, 2.0 * uy + 1.0));
          o[k] = isV ? Vv(c) : Uv(c);
        }
      }
      gl_FragColor = o;
    }`);
  const pO = prog(`precision mediump float; varying vec2 v; uniform sampler2D t; void main(){ gl_FragColor = texture2D(t, vec2(v.x, 1.0 - v.y)); }`);
  const ovT = mkT(1, 1);
  const out = new Uint8Array(W * H * 3 / 2);
  return {
    begin() { gl.bindFramebuffer(gl.FRAMEBUFFER, fbA); },
    overlay(canvas) { // captions (2D canvas, transparent) over the rendered frame
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbA); gl.viewport(0, 0, W, H); gl.useProgram(pO);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, ovT); gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      gl.uniform1i(gl.getUniformLocation(pO, 't'), 0);
      gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); gl.disable(gl.BLEND);
    },
    read() {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbB); gl.viewport(0, 0, OW, OH); gl.useProgram(pY); gl.disable(gl.BLEND);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, texA);
      gl.uniform1i(gl.getUniformLocation(pY, 't'), 0); gl.uniform2f(gl.getUniformLocation(pY, 'S'), W, H);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      gl.readPixels(0, 0, OW, OH, gl.RGBA, gl.UNSIGNED_BYTE, out);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return out;
    },
  };
}
