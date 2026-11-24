// Multi-cam: find clips that were recorded at the same time (by their audio), put them on one shared
// timeline, and cut between the cameras. Everything runs on-device.
//
// Sync = two stages:
//   1. coarse: spectral-flux onset envelopes at 100 Hz, full cross-correlation by FFT (any offset, ±10 ms)
//   2. fine:   GCC-PHAT on the 8 kHz waveforms around the coarse lag (robust to different mics / EQ / room),
//              parabolic peak interpolation -> sub-millisecond resolution
// Fallback when there is no usable audio: the capture time in the file metadata (1 s resolution).
import { demux, byteReader } from './wcexport.js';
import { quality } from './autoedit.js';

const RATE = 8000, HOP = 80, ENV_HZ = RATE / HOP; // 100 Hz envelope
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// ---------------- FFT (radix-2, in place) ----------------
function fft(re, im, inv = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (inv ? 2 : -2) * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang), h = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < h; k++) {
        const a = i + k, b = a + h;
        const xr = re[b] * cr - im[b] * ci, xi = re[b] * ci + im[b] * cr;
        re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        const t = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = t;
      }
    }
  }
  if (inv) for (let i = 0; i < n; i++) { re[i] /= n; im[i] /= n; }
}
const pow2 = (n) => { let p = 1; while (p < n) p <<= 1; return p; };

// ---------------- audio extraction (mono, 8 kHz) ----------------
// iPhone .mov (HEVC or H.264 + AAC 44.1/48 kHz, often with spatial-audio, metadata and timecode tracks) must
// work in Safari, so several decoders are tried in turn and each failure is recorded for the sync report:
//   1. WebCodecs AudioDecoder on the AAC samples (no container parsing by the browser at all)
//   2. ADTS stream -> decodeAudioData        3. audio-only .m4a -> decodeAudioData
//   4. whole file -> decodeAudioData (small files only: Safari copies it into memory)
//   5. ffmpeg.wasm, audio only (reads the file in place via WORKERFS; downloads the engine once)
// Everything is box-filtered down to 8 kHz while streaming, so long clips stay small in memory.
import { Muxer, ArrayBufferTarget } from './vendor/webcodecs/mp4-muxer.js';
const SFI = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
const MAX_SEC = 3 * 3600;
/** streaming box-filter resampler native rate -> 8 kHz (mono) */
function resampler(rate) {
  const r = rate / RATE; let cap = 1 << 16, out = new Float32Array(cap), n = 0, acc = 0, cnt = 0, pos = 0, next = r;
  const push = (v) => { acc += v; cnt++; pos++; while (pos >= next) { if (n >= cap) { const o = new Float32Array(cap *= 2); o.set(out); out = o; } out[n++] = cnt ? acc / cnt : 0; acc = 0; cnt = 0; next += r; } };
  return { push, done: () => out.subarray(0, n), get n() { return n; } };
}
function bufferToMono8k(buf) {
  const rs = resampler(buf.sampleRate), ch = buf.numberOfChannels, d = [];
  for (let c = 0; c < ch; c++) d.push(buf.getChannelData(c));
  for (let i = 0; i < buf.length; i++) { let v = 0; for (let c = 0; c < ch; c++) v += d[c][i]; rs.push(v / ch); }
  return rs.done();
}
async function decodeAt(ab, rate = RATE) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AC) throw new Error('no Web Audio');
  let ac; try { ac = new AC(1, rate, rate); } catch { ac = new AC(1, 44100, 44100); } // old WebKit: 44.1–96 kHz only
  const buf = await new Promise((res, rej) => { const p = ac.decodeAudioData(ab, res, rej); if (p?.then) p.then(res, rej); });
  return buf.sampleRate === RATE && buf.numberOfChannels === 1 ? buf.getChannelData(0) : bufferToMono8k(buf);
}
const withTimeout = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(what + ' timed out')), ms))]);
function aacInfo(a) {
  if (!a || !/^mp4a/.test(a.codec) || !a.samples?.length) throw new Error(a ? `audio codec ${a.codec} is not AAC` : 'no audio track');
  const asc = a.asc; if (!asc || asc.length < 2) throw new Error('no AAC config');
  const ot = asc[0] >> 3, fi = ((asc[0] & 7) << 1) | (asc[1] >> 7), ch = (asc[1] >> 3) & 15;
  return { ot, fi, ch: ch || a.channels || 2, rate: SFI[fi] || a.sampleRate };
}
async function viaWebCodecs(dm) {
  const a = dm.audio, k = aacInfo(a);
  if (typeof AudioDecoder === 'undefined') throw new Error('no AudioDecoder');
  const cfg = { codec: 'mp4a.40.2', sampleRate: k.rate, numberOfChannels: k.ch, description: a.asc };
  if (!(await AudioDecoder.isConfigSupported(cfg)).supported) throw new Error('AAC not supported by AudioDecoder');
  let rs = null, err = null, plane = null;
  const dec = new AudioDecoder({
    output: (ad) => {
      try {
        if (!rs) rs = resampler(ad.sampleRate);
        const n = ad.numberOfFrames, C = ad.numberOfChannels;
        if (!plane || plane.length < n) plane = new Float32Array(n);
        const mix = new Float32Array(n);
        const planar = /planar/.test(ad.format || 'f32-planar');
        if (planar) for (let c = 0; c < C; c++) { ad.copyTo(plane, { planeIndex: c, format: 'f32-planar' }); for (let i = 0; i < n; i++) mix[i] += plane[i] / C; }
        else { const il = new Float32Array(n * C); ad.copyTo(il, { planeIndex: 0, format: 'f32' }); for (let i = 0; i < n; i++) { let v = 0; for (let c = 0; c < C; c++) v += il[i * C + c]; mix[i] = v / C; } }
        for (let i = 0; i < n; i++) rs.push(mix[i]);
      } catch (e) { err = e; } finally { ad.close(); }
    },
    error: (e) => { err = e; },
  });
  dec.configure(cfg);
  const rd = byteReader(dm.blob);
  for (const s of a.samples) {
    if (err) break;
    if (s.cts > MAX_SEC) break;
    const data = await rd(s.offset, s.size);
    dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(s.cts * 1e6), duration: Math.round(s.dur * 1e6), data }));
    if (dec.decodeQueueSize > 64) await new Promise(r => setTimeout(r, 0));
  }
  if (!err) await dec.flush().catch(e => { err = e; });
  try { dec.close(); } catch {}
  if (err) throw err instanceof Error ? err : new Error(String(err?.message || err));
  if (!rs?.n) throw new Error('AudioDecoder gave no audio');
  return rs.done();
}
async function adtsBytes(dm) {
  const a = dm.audio, k = aacInfo(a);
  if (k.ot < 1 || k.ot > 4 || k.fi > 12) throw new Error('AAC profile not ADTS-compatible'); // HE-AAC decodes as LC
  const rd = byteReader(dm.blob);
  const total = a.samples.reduce((s, x) => s + x.size + 7, 0), out = new Uint8Array(total);
  let o = 0;
  for (const s of a.samples) {
    const len = s.size + 7, d = await rd(s.offset, s.size);
    out[o] = 0xff; out[o + 1] = 0xf1; out[o + 2] = ((k.ot - 1) << 6) | (k.fi << 2) | (k.ch >> 2);
    out[o + 3] = ((k.ch & 3) << 6) | (len >> 11); out[o + 4] = (len >> 3) & 0xff; out[o + 5] = ((len & 7) << 5) | 0x1f; out[o + 6] = 0xfc;
    out.set(d, o + 7); o += len;
  }
  return out.buffer;
}
async function m4aBytes(dm) {
  const a = dm.audio, k = aacInfo(a);
  const target = new ArrayBufferTarget();
  const mux = new Muxer({ target, audio: { codec: 'aac', sampleRate: k.rate, numberOfChannels: k.ch }, fastStart: 'in-memory', firstTimestampBehavior: 'offset' });
  const rd = byteReader(dm.blob), meta = { decoderConfig: { codec: 'mp4a.40.2', sampleRate: k.rate, numberOfChannels: k.ch, description: a.asc } };
  let t = 0;
  for (const s of a.samples) { const d = await rd(s.offset, s.size); mux.addAudioChunkRaw(new Uint8Array(d), 'key', Math.round(t * 1e6), Math.round(s.dur * 1e6), meta); t += s.dur; }
  mux.finalize();
  return target.buffer;
}
async function viaFFmpeg(blob) {
  const { getFF } = await import('./exporter.js');
  const f = await getFF();
  const file = blob instanceof File ? blob : new File([blob], 'clip.mov');
  const dir = '/mca' + Math.random().toString(36).slice(2, 7);
  await f.createDir(dir); await f.mount('WORKERFS', { files: [file] }, dir);
  try {
    const code = await f.exec(['-v', 'error', '-i', `${dir}/${file.name}`, '-vn', '-sn', '-dn', '-ac', '1', '-ar', String(RATE), '-t', String(MAX_SEC), '-f', 'f32le', 'mca.pcm']);
    if (code !== 0) throw new Error('ffmpeg audio extract failed');
    const d = await f.readFile('mca.pcm');
    return new Float32Array(d.buffer, d.byteOffset, d.byteLength >> 2).slice();
  } finally { try { await f.deleteFile('mca.pcm'); } catch {} try { await f.unmount(dir); await f.deleteDir(dir); } catch {} }
}
/** test hook: window.__mcOnly = ['webcodecs'|'adts'|'m4a'|'file'|'ffmpeg', …] restricts the decoders tried */
const allowed = (k) => !globalThis.__mcOnly || globalThis.__mcOnly.includes(k);
/**
 * mono Float32Array at 8 kHz of the clip's audio (level-normalised), or null. diag (optional) receives
 * { via, tried: [{ via, err }], tracks, ms } so the UI can say why a clip couldn't be matched.
 */
export async function extractAudio(blob, diag = {}) {
  const t0 = performance.now(); diag.tried = [];
  let dm = null, x = null, skip = 0;
  try { dm = await demux(blob); diag.tracks = dm.audioTracks; skip = dm.audio?.skip || 0; } catch (e) { diag.tried.push({ via: 'demux', err: e.message || String(e) }); }
  const steps = [
    ['webcodecs', () => viaWebCodecs(dm), true],
    ['adts', async () => decodeAt(await adtsBytes(dm)), true],
    ['m4a', async () => decodeAt(await m4aBytes(dm)), true], // no edit list written: priming still in, like ADTS
    ['file', async () => { if (blob.size > 300 * 1048576) throw new Error('file too big to decode in one piece'); return decodeAt(await blob.arrayBuffer()); }, false],
    ['ffmpeg', () => viaFFmpeg(blob), false],
  ];
  for (const [via, fn, needsSkip] of steps) {
    if (!allowed(via) || x) continue;
    if (via !== 'file' && via !== 'ffmpeg' && !dm?.audio) { diag.tried.push({ via, err: dm ? 'no audio track' : 'could not read file' }); continue; }
    if (via !== 'file' && via !== 'ffmpeg' && dm && !dm.audio?.samples?.length) continue;
    try {
      const y = await withTimeout(fn(), via === 'ffmpeg' ? 240000 : 90000, via);
      if (!y || y.length < RATE / 2) throw new Error('no samples');
      let e = 0; for (let i = 0; i < y.length; i += 7) e += y[i] * y[i];
      if (e / Math.max(1, y.length / 7) < 1e-11) throw new Error('silent');
      x = needsSkip && skip ? y.subarray(Math.round(skip * RATE)) : y; diag.via = via;
    } catch (e) { diag.tried.push({ via, err: (e && e.message) || String(e) }); }
  }
  diag.ms = Math.round(performance.now() - t0);
  if (!x) return null;
  // level-normalise (quiet cameras / far-away phones): RMS of the louder quarter -> -56 dBFS. Low on purpose: the
  // onset envelope's log(1 + 1000·|X|) is then nearly linear, which tested best for quiet/far cameras
  const blk = RATE / 10, rms = [];
  for (let i = 0; i + blk <= x.length; i += blk) { let e = 0; for (let j = i; j < i + blk; j++) e += x[j] * x[j]; rms.push(Math.sqrt(e / blk)); }
  rms.sort((p, q) => p - q);
  const ref = rms.length ? rms[Math.floor(rms.length * 0.75)] : 0;
  diag.level = ref ? +(20 * Math.log10(ref)).toFixed(1) : null;
  const tgt = globalThis.__mcNorm ?? 0.0015;
  if (tgt > 0 && ref > 1e-6) { const g = tgt / ref, out = new Float32Array(x.length); for (let i = 0; i < x.length; i++) out[i] = Math.max(-1, Math.min(1, x[i] * g)); x = out; }
  return x;
}

// ---------------- features ----------------
/** onset envelope (spectral flux of log magnitudes), 100 Hz, zero-mean / unit-variance */
export function onsetEnvelope(x) {
  const N = 256, frames = Math.max(0, Math.floor((x.length - N) / HOP) + 1);
  const env = new Float32Array(frames), win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
  const re = new Float64Array(N), im = new Float64Array(N), prev = new Float32Array(N / 2), cur = new Float32Array(N / 2);
  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = x[o + i] * win[i]; im[i] = 0; }
    fft(re, im);
    let flux = 0;
    for (let k = 2; k < N / 2; k++) { // 60 Hz .. 4 kHz
      cur[k] = Math.log(1 + 1000 * Math.hypot(re[k], im[k]));
      const d = cur[k] - prev[k]; if (d > 0 && f > 0) flux += d;
    }
    prev.set(cur); env[f] = flux;
  }
  // remove slow level changes (0.5 s moving average) and normalise
  const W = 25, out = new Float32Array(frames); let s = 0;
  for (let i = 0; i < frames; i++) {
    s += env[i]; if (i >= 2 * W + 1) s -= env[i - 2 * W - 1];
    const j = i - W; if (j >= 0) out[j] = env[j] - s / Math.min(i + 1, 2 * W + 1);
  }
  for (let j = Math.max(0, frames - W); j < frames; j++) out[j] = 0;
  let m = 0, v = 0; for (const e of out) m += e; m /= Math.max(1, frames);
  for (let i = 0; i < frames; i++) { out[i] = Math.max(-1, out[i] - m); v += out[i] * out[i]; }
  v = Math.sqrt(v / Math.max(1, frames)) || 1;
  for (let i = 0; i < frames; i++) out[i] /= v;
  return out;
}
export async function audioFeatures(blob, diag = {}) {
  const x = await extractAudio(blob, diag);
  if (!x || x.length < RATE) { if (x) diag.tried.push({ via: diag.via, err: 'under 1 s of sound' }); return null; }
  return { x, env: onsetEnvelope(x), dur: x.length / RATE };
}

// ---------------- sync ----------------
/**
 * coarse lag between two envelopes: b(t) ≈ a(t + lag). Returns { lag (s), z, peak, ratio, overlap (s) }.
 */
export function coarseLag(ea, eb) {
  const Na = ea.length, Nb = eb.length, n = pow2(Na + Nb);
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(ea); br.set(eb);
  fft(ar, ai); fft(br, bi);
  for (let k = 0; k < n; k++) { const r = ar[k] * br[k] + ai[k] * bi[k], i = ai[k] * br[k] - ar[k] * bi[k]; ar[k] = r; ai[k] = i; }
  fft(ar, ai, true); // ar[k] = sum a[m+k] b[m]
  const minOv = Math.min(300, Math.floor(0.4 * Math.min(Na, Nb)));
  const vals = [];
  let best = -Infinity, bestL = 0;
  for (let L = -(Nb - 1); L <= Na - 1; L++) {
    const ov = Math.min(Na, L + Nb) - Math.max(0, L);
    if (ov < minOv) continue;
    const r = ar[(L + n) % n] / Math.sqrt(ov * Math.min(Na, Nb)); // mild preference for bigger overlaps
    vals.push(r);
    if (r > best) { best = r; bestL = L; }
  }
  if (!vals.length) return null;
  const sorted = Float64Array.from(vals).sort(), med = sorted[sorted.length >> 1];
  const mad = Float64Array.from(vals, v => Math.abs(v - med)).sort()[vals.length >> 1] * 1.4826 || 1e-9;
  // top candidates (local maxima at least 150 ms apart): periodic sound (beats, claps) gives several
  const cand = [];
  for (let L = -(Nb - 1); L <= Na - 1; L++) {
    const ov = Math.min(Na, L + Nb) - Math.max(0, L); if (ov < minOv) continue;
    const r = ar[(L + n) % n] / Math.sqrt(ov * Math.min(Na, Nb));
    if ((r - med) / mad < 4) continue;
    const near = cand.findIndex(c => Math.abs(c.L - L) <= 15);
    if (near >= 0) { if (r > cand[near].r) cand[near] = { L, r }; } else cand.push({ L, r });
  }
  cand.sort((p, q) => q.r - p.r);
  const second = cand[1]?.r ?? med;
  const ov = (Math.min(Na, bestL + Nb) - Math.max(0, bestL)) / ENV_HZ;
  return { lag: bestL / ENV_HZ, z: (best - med) / mad, peak: best, ratio: second > 0 ? best / second : 9, overlap: ov,
    cands: cand.slice(0, 4).map(c => ({ lag: c.L / ENV_HZ, z: (c.r - med) / mad, overlap: (Math.min(Na, c.L + Nb) - Math.max(0, c.L)) / ENV_HZ })) };
}
/** sub-ms refinement around lag0 with GCC-PHAT on the waveforms */
export function refineLag(xa, xb, lag0) {
  const L0 = Math.round(lag0 * RATE);
  const s0 = Math.max(0, L0), s1 = Math.min(xa.length, L0 + xb.length); // overlap in a-samples
  let len = s1 - s0; if (len < RATE) return { lag: lag0, sharp: 0 };
  const use = Math.min(len, 30 * RATE), start = s0 + Math.floor((len - use) / 2);
  const n = pow2(use * 2);
  const ar = new Float64Array(n), ai = new Float64Array(n), br = new Float64Array(n), bi = new Float64Array(n);
  for (let i = 0; i < use; i++) { const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / use); ar[i] = xa[start + i] * w; br[i] = (xb[start - L0 + i] || 0) * w; }
  fft(ar, ai); fft(br, bi);
  const lo = Math.floor(150 / RATE * n), hi = Math.floor(3600 / RATE * n);
  for (let k = 0; k < n; k++) {
    const kk = k <= n / 2 ? k : n - k;
    if (kk < lo || kk > hi) { ar[k] = ai[k] = 0; continue; }
    const r = ar[k] * br[k] + ai[k] * bi[k], i = ai[k] * br[k] - ar[k] * bi[k], m = Math.hypot(r, i) + 1e-12;
    ar[k] = r / m; ai[k] = i / m;
  }
  fft(ar, ai, true);
  const W = Math.round(0.04 * RATE); // search ±40 ms around the coarse lag
  let bk = 0, bv = -Infinity, sum = 0, cnt = 0;
  for (let k = -W; k <= W; k++) { const v = ar[(k + n) % n]; if (v > bv) { bv = v; bk = k; } sum += Math.abs(v); cnt++; }
  const y0 = ar[(bk - 1 + n) % n], y1 = bv, y2 = ar[(bk + 1 + n) % n], den = y0 - 2 * y1 + y2;
  const frac = den < 0 ? clamp(0.5 * (y0 - y2) / den, -0.5, 0.5) : 0;
  return { lag: (L0 + bk + frac) / RATE, sharp: bv / (sum / cnt + 1e-12) };
}
/** full pairwise sync. Returns null or { lag, conf (0..1), z, method:'audio' } with b(t) ≈ a(t + lag) */
export function syncPair(fa, fb) {
  if (!fa || !fb) return null;
  const c = coarseLag(fa.env, fb.env); if (!c) return null;
  // check the strongest few coarse candidates on the waveforms; the true lag gives a much sharper GCC-PHAT peak
  const tried = (c.cands.length ? c.cands : [{ lag: c.lag, z: c.z, overlap: c.overlap }]).slice(0, 3).map(k => ({ ...k, ...refineLag(fa.x, fb.x, k.lag), coarse: k.lag }));
  tried.sort((p, q) => q.sharp - p.sharp);
  const b = tried[0], runner = tried[1]?.sharp || 0;
  const conf = clamp((b.z - 6) / 10, 0, 1) * clamp((b.sharp - 8) / 12, 0, 1) * clamp((b.sharp / Math.max(1, runner) - 1.1) / 0.6, 0, 1);
  return { lag: b.lag, coarse: b.coarse, z: +b.z.toFixed(1), ratio: +c.ratio.toFixed(2), sharp: +b.sharp.toFixed(1), sharp2: +runner.toFixed(1), overlap: b.overlap, conf: +conf.toFixed(2) };
}
export const SYNC_MIN_CONF = 0.15;
// a weaker match still counts when a third camera confirms it (lag AB + lag BC ≈ lag AC within 60 ms)
const weakPair = (r) => r && r.z >= 4.5 && r.sharp >= 7 && r.overlap >= 1.5;

/**
 * Group clips recorded at the same time.
 * list: [{ mediaId, dur, feat, capture (ms from metadata or null), size }]
 * assign: { mediaId: 'none' | groupId } manual grouping, nudge: { mediaId: seconds }
 * Returns [{ id, ref, members: [{ mediaId, off, conf, method }] }]; off = where the clip's t=0 sits on the group timeline.
 */
export function groupClips(list, { assign = {}, prev = [] } = {}) {
  const byId = new Map(list.map(x => [x.mediaId, x]));
  const free = list.filter(x => !assign[x.mediaId]);
  const edges = [], pairs = new Map();
  const key = (a, b) => a + '|' + b;
  const pair = (a, b) => { // cached
    const k = key(a.mediaId, b.mediaId); if (pairs.has(k)) return pairs.get(k);
    let r = syncPair(a.feat, b.feat);
    if (r && a.size && a.size === b.size && Math.abs(a.dur - b.dur) < 0.05 && Math.abs(r.lag) < 0.02) r = null; // same file twice
    pairs.set(k, r); return r;
  };
  // triangle check: weak pairs confirmed by a consistent third camera
  const lagOf = (a, b) => { const r = pair(a, b); return r ? r.lag : null; };
  const confirmed = (a, b) => free.some(c => {
    if (c === a || c === b) return false;
    const ab = lagOf(a, b), ac = lagOf(a, c), bc = lagOf(b, c);
    if (ab == null || ac == null || bc == null || !weakPair(pair(a, c)) || !weakPair(pair(b, c))) return false;
    return Math.abs(ab + bc - ac) < 0.06;
  });
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
    const a = free[i], b = free[j];
    const r = pair(a, b);
    if (r && r.conf >= SYNC_MIN_CONF && r.overlap >= 1.5) { edges.push({ a: a.mediaId, b: b.mediaId, lag: r.lag, conf: r.conf, method: 'audio', r }); continue; }
    if (weakPair(r) && confirmed(a, b)) { edges.push({ a: a.mediaId, b: b.mediaId, lag: r.lag, conf: Math.max(r.conf, 0.3), method: 'audio', r, tri: true }); continue; }
    // metadata fallback: recording intervals overlap (different devices running at the same time)
    if (a.capture && b.capture && (!a.feat || !b.feat || !r || r.conf < 0.1)) {
      const lag = (b.capture - a.capture) / 1000, ov = Math.min(a.dur, lag + b.dur) - Math.max(0, lag);
      if (ov >= 2 && Math.abs(lag) > 0.5) edges.push({ a: a.mediaId, b: b.mediaId, lag, conf: 0.2, method: 'time' });
    }
  }
  // union-find over accepted edges, then a max-confidence spanning tree per component
  const parent = new Map(free.map(x => [x.mediaId, x.mediaId]));
  const find = (x) => { while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  edges.sort((p, q) => q.conf - p.conf);
  const tree = [];
  for (const e of edges) { const ra = find(e.a), rb = find(e.b); if (ra !== rb) { parent.set(ra, rb); tree.push(e); } }
  const comps = new Map();
  for (const x of free) { const r = find(x.mediaId); if (!comps.has(r)) comps.set(r, []); comps.get(r).push(x.mediaId); }
  const groups = [];
  const build = (ids, treeEdges) => {
    const ref = ids.reduce((p, q) => (byId.get(q).dur > byId.get(p).dur ? q : p));
    const off = new Map([[ref, 0]]), info = new Map([[ref, { conf: 1, method: 'ref' }]]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const e of treeEdges) {
        if (off.has(e.a) && !off.has(e.b)) { off.set(e.b, off.get(e.a) + e.lag); info.set(e.b, { conf: e.conf, method: e.method }); grew = true; }
        else if (off.has(e.b) && !off.has(e.a)) { off.set(e.a, off.get(e.b) - e.lag); info.set(e.a, { conf: e.conf, method: e.method }); grew = true; }
      }
    }
    const mn = Math.min(...off.values());
    return { ref, members: [...off.entries()].map(([mediaId, o]) => ({ mediaId, off: +(o - mn).toFixed(4), ...info.get(mediaId) })) };
  };
  for (const ids of comps.values()) {
    if (ids.length < 2) continue;
    const g = build(ids, tree.filter(e => ids.includes(e.a)));
    // stable id: reuse a previous group's id if it shares members
    const old = prev.find(p => p.members.some(m => ids.includes(m.mediaId)) && !groups.some(q => q.id === p.id));
    g.id = old?.id || 'g' + ids.slice().sort().join('').replace(/[^\w]/g, '').slice(0, 10);
    groups.push(g);
  }
  // manual assignments: force a clip into a group (offset from audio if it matches at all, else metadata, else 0)
  for (const [mid, gid] of Object.entries(assign)) {
    if (gid === 'none' || !byId.has(mid)) continue;
    let g = groups.find(q => q.id === gid);
    if (!g) { g = { id: gid, ref: mid, members: [{ mediaId: mid, off: 0, conf: 1, method: 'manual' }] }; groups.push(g); continue; }
    if (g.members.some(m => m.mediaId === mid)) continue;
    const me = byId.get(mid);
    let best = null;
    for (const m of g.members) {
      const o = byId.get(m.mediaId); if (!o) continue;
      const r = pair(o, me);
      // only trust the sound if it really matches; otherwise line the clips up by their start (offset 0) and let
      // the user nudge — e.g. the same scene filmed again from another spot, not at the same time
      if (r && (r.conf >= SYNC_MIN_CONF || (weakPair(r) && r.conf >= 0.05)) && (!best || r.conf > best.conf)) best = { off: m.off + r.lag, conf: r.conf, z: r.z, method: 'audio' };
      if (!best && o.capture && me.capture) {
        const lag = (me.capture - o.capture) / 1000, ov = Math.min(o.dur, lag + me.dur) - Math.max(0, lag);
        if (ov >= 2) best = { off: m.off + lag, conf: 0.2, method: 'time' };
      }
    }
    g.members.push({ mediaId: mid, off: +(best?.off ?? (g.members.find(x => x.mediaId === g.ref)?.off ?? 0)).toFixed(4), conf: best?.conf ?? 0, method: best?.method || 'start' });
  }
  for (const g of groups) { const mn = Math.min(...g.members.map(m => m.off)); g.members.forEach(m => { m.off = +(m.off - mn).toFixed(4); }); }
  const out = groups.filter(g => g.members.length >= 2 || assign[g.members[0]?.mediaId] === g.id);
  out.pairs = [...pairs.entries()].map(([k, r]) => ({ k, lag: r ? +r.lag.toFixed(3) : null, conf: r?.conf ?? 0, z: r?.z ?? 0, sharp: r?.sharp ?? 0, overlap: r ? +r.overlap.toFixed(1) : 0 }));
  return out;
}

// ---------------- planning: cut between cameras ----------------
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 1e6) / 1e6; }; }
const PACE = { fast: [1.5, 3], normal: [2, 5], slow: [3, 7] };
/**
 * group: { id, members:[{mediaId, off}] }, items: Map(mediaId -> analysed item {samples (flagged), step, dur, w, h, name, capture, order})
 * opts: { xfade, pace, lapRef, envOf(mediaId) -> onset envelope (100 Hz) or null, nudge }
 * Returns { shots, cuts, master } — shots overlap by the crossfade so every dissolve blends the same moment
 * and the program audio (from one master camera) runs on without a gap.
 */
export function planMulticam(group, items, opts = {}) {
  const FPS = 30, q = (x) => Math.round(x * FPS) / FPS;
  const X = q(opts.xfade || 0);
  const [pmin, pmax] = PACE[opts.pace] || PACE.normal;
  const lapRef = opts.lapRef || 50;
  const cams = group.members.map(m => ({ ...m, off: m.off + (opts.nudge?.[m.mediaId] || 0), it: items.get(m.mediaId) })).filter(c => c.it);
  if (cams.length < 2) return null;
  const G0 = Math.min(...cams.map(c => c.off)), G1 = Math.max(...cams.map(c => c.off + c.it.dur));
  const covers = (c, a, b) => a >= c.off + 0.02 && b <= c.off + c.it.dur - 0.05;
  // per-camera score at group time g (nearest analysis sample)
  const sAt = (c, g) => {
    const ss = c.it.samples, t = g - c.off; if (!ss?.length) return null;
    let lo = 0, hi = ss.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ss[mid].t < t) lo = mid + 1; else hi = mid; }
    const s = lo > 0 && Math.abs(ss[lo - 1].t - t) < Math.abs(ss[lo].t - t) ? ss[lo - 1] : ss[lo];
    return Math.abs(s.t - t) <= (c.it.step || 0.5) ? s : null;
  };
  // a flag that covers most of a camera's footage is its baseline (e.g. a tight shot of a moving subject reads
  // as "shaky"), not a passing problem: don't let it lock that angle out of the edit
  for (const c of cams) {
    const ss = c.it.samples || [], fr = (r) => ss.filter(x => x.bad?.includes(r)).length / Math.max(1, ss.length);
    c.base = new Set(['shaky', 'blurry'].filter(r => fr(r) > 0.4));
  }
  const badOf = (c, s) => s && !s.soft && s.bad?.length && s.bad.some(r => !c.base.has(r));
  // each camera's own typical quality: a tight or plain angle naturally measures softer than a wide one,
  // so a camera is judged against its own baseline (plus a little absolute quality)
  for (const c of cams) { const qs = (c.it.samples || []).map(x => quality(x, lapRef)).sort((a, b) => a - b); c.med = qs.length ? qs[qs.length >> 1] : 0.45; }
  const weak = (c, s) => badOf(c, s) || (s && quality(s, lapRef) < c.med - 0.12);
  const winScore = (c, a, b) => {
    let sum = 0, n = 0, bad = 0, fq = 0, nf = 0, am = 0, found = 0, ok = 0;
    for (let g = a; g <= b + 1e-6; g += 0.25) { const s = sAt(c, g); if (!s) continue; n++; sum += quality(s, lapRef); if (badOf(c, s)) bad++; if (s.fq != null) { fq += s.fq; nf++; if (s.fq >= 0.5) ok++; } if (s.ppl?.length) found++; am += s.am || 0; }
    return n ? { q: sum / n, bad: bad / n, fq: nf ? fq / nf : null, okF: nf ? ok / nf : 1, am: am / n, found } : { q: c.med, bad: 0, fq: null, okF: 1, am: 0, found: 0 };
  };
  const used = new Map(); let usedAll = 0;
  // master audio: the camera covering most of the group (ties: the one with the best average picture is not
  // relevant to sound, so prefer the longest)
  const master = cams.reduce((p, c) => (c.it.dur > p.it.dur ? c : p));
  // clips lined up by start (sound didn't match, e.g. the scene filmed again) keep their own sound: one camera's
  // track would not fit the others' picture
  const ownAudio = group.members.some(m => m.method === 'start');
  const env = opts.envOf?.(master.mediaId) || null, ENV = 100;
  const snap = (g, lo, hi) => { // move a cut onto the strongest audio onset nearby (cuts land on hits)
    if (!env) return g;
    let best = g, bv = 1.5; // must be a clear onset
    for (let t = Math.max(lo, g - 0.35); t <= Math.min(hi, g + 0.35); t += 0.01) {
      const i = Math.round((t - master.off) * ENV); if (i < 1 || i >= env.length) continue;
      const v = env[i] - 0.4 * Math.abs(t - g); if (v > bv) { bv = v; best = t; }
    }
    return best;
  };
  const rand = rng([...group.id].reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
  const segs = [], cuts = [];
  let g = q(G0), prev = null, run = 0;
  const lastUse = new Map();
  while (g < G1 - 0.6) {
    const want = pmin + (pmax - pmin) * rand();
    let best = null;
    const cand = [];
    for (const c of cams) {
      if (!covers(c, g, g + Math.min(1, G1 - g - 0.1))) continue;
      const maxL = c.off + c.it.dur - 0.05 - g;
      const L = Math.min(want, maxL);
      if (L < Math.min(1, G1 - g - 0.1)) continue;
      cand.push({ c, L, w: winScore(c, g, g + L) });
    }
    const amMax = Math.max(1e-6, ...cand.map(x => x.w.am));
    const pplHere = opts.framing !== false && cand.some(x => x.w.found > 0);
    for (const { c, L, w } of cand) {
      let sc = w.q + 2 * (w.q - c.med) - 1.2 * w.bad;
      // keep her in frame: absolute preference for the angle that shows her and the action (not relative to its own baseline)
      if (pplHere && w.fq != null) sc += 2.0 * (w.fq - 0.6) + 0.5 * (w.am / amMax - 0.6) - 1.6 * (1 - w.okF); // she is missing / badly framed on part of this window
      if (c === prev) sc -= run + L > pmax ? 1.0 : 0.35;           // keep switching
      const nCover = cams.filter(o => covers(o, g, g + 1)).length;
      sc += 0.6 * Math.max(0, 1 / nCover - (used.get(c.mediaId) || 0) / Math.max(1, usedAll)); // give every angle screen time
      sc += Math.min(0.1, ((g - (lastUse.get(c.mediaId) ?? G0 - 10)) / 30));
      if (!best || sc > best.sc) best = { c, L, sc, w };
    }
    if (!best) { g = q(g + 0.5); prev = null; continue; } // nobody covers this moment
    if (best.w.bad > 0.6 && cams.every(c => !covers(c, g, g + 1) || winScore(c, g, g + 1).bad > 0.6)) {
      // every camera is bad here: cut it out (jump cut), like single-camera Auto Edit
      const a = g; let b = g;
      while (b < G1 - 0.5 && cams.every(c => !covers(c, b, b + 0.5) || winScore(c, b, b + 0.5).bad > 0.6)) b += 0.5;
      b = q(Math.max(b, a + 0.5));
      cuts.push({ mediaId: best.c.mediaId, in: a - best.c.off, out: b - best.c.off, reasons: ['all cameras bad'] });
      g = b; prev = null; run = 0; continue;
    }
    // end early if this camera turns bad inside the window (switch away from it)
    let end = g + best.L;
    for (let t = g + 1; t < end; t += 0.25) { if (weak(best.c, sAt(best.c, t)) && weak(best.c, sAt(best.c, t + 0.25))) { end = t; break; } }
    if (end < G1 - 0.6) end = snap(end, g + 1, Math.min(best.c.off + best.c.it.dur - 0.05, g + best.L + 0.35));
    end = q(Math.min(end, best.c.off + best.c.it.dur - 0.05, G1));
    if (end - g < 1 / FPS * 3) { g = q(g + 0.5); continue; }
    const tail = G1 - end;
    if (tail > 0 && tail < 1 && covers(best.c, g, G1 - 0.06)) end = q(G1 - 0.06); // don't leave a sliver
    segs.push({ c: best.c, a: g, b: end });
    run = best.c === prev ? run + (end - g) : end - g;
    prev = best.c; lastUse.set(best.c.mediaId, end);
    used.set(best.c.mediaId, (used.get(best.c.mediaId) || 0) + (end - g)); usedAll += end - g;
    g = end;
  }
  // merge same-camera neighbours (can happen after a skipped stretch is avoided)
  const merged = [];
  for (const s of segs) { const l = merged[merged.length - 1]; if (l && l.c === s.c && Math.abs(l.b - s.a) < 1e-6 && l.b - l.a < pmax) l.b = s.b; else merged.push({ ...s }); }
  // shots: extend each out by the crossfade so the dissolve covers the same instant from both cameras
  const shots = merged.map((s, i) => {
    const n = merged[i + 1], joined = n && Math.abs(n.a - s.b) < 1e-6;
    let b = s.b;
    if (joined && X > 0) b = Math.min(s.b + X, s.c.off + s.c.it.dur - 0.02);
    // audio source: master if it covers this stretch, else the camera's own sound
    const af = !ownAudio && covers(master, s.a, b) ? master : s.c;
    const it = s.c.it, tin = +(s.a - s.c.off).toFixed(4), tout = +(b - s.c.off).toFixed(4);
    return {
      mediaId: s.c.mediaId, name: it.name, in: tin, out: tout, dur: it.dur, w: it.w, h: it.h,
      score: +winScore(s.c, s.a, s.b).q.toFixed(3), order: it.order, capture: it.capture,
      samples: (it.samples || []).filter(x => x.t >= tin - 0.3 && x.t <= tout + 0.3), thumb: '',
      mc: { group: group.id, g0: +s.a.toFixed(4), g1: +s.b.toFixed(4), cam: cams.indexOf(s.c) },
      audioFrom: { mediaId: af.mediaId, off: +(s.c.off - af.off).toFixed(4) },
    };
  });
  return { shots, cuts, master: ownAudio ? null : master.mediaId, span: [G0, G1] };
}
/** cameras that can show group-time range [a, b] */
export function camsCovering(group, a, b, durOf, nudge = {}) {
  return group.members.filter(m => { const o = m.off + (nudge[m.mediaId] || 0), d = durOf(m.mediaId); return d && a >= o - 0.01 && b <= o + d + 0.01; });
}

// ---------------- every-angle replays ----------------
/**
 * The same moment [m0, m1] (group time) from every camera that saw it, back to back (A, B, C …).
 * cams: [{ mediaId, off (incl. nudge), dur, name, w, h, k (camera index) }]
 * opts: { slow (speed of the replays, 1 = real time), xfade, master: { mediaId, off } | null, group (id) }
 */
export function replaySequence(cams, m0, m1, opts = {}) {
  const X = opts.xfade || 0, sp = opts.slow && opts.slow < 1 ? opts.slow : 1;
  const ok = cams.filter(c => m0 >= c.off + 0.02 && m1 <= c.off + c.dur - 0.05).sort((a, b) => a.k - b.k);
  return ok.map((c, i) => {
    const last = i === ok.length - 1;
    // keep the visible length of every angle at (m1-m0)/speed: the dissolve into the next one eats X
    const ext = last ? 0 : X * sp;
    const tin = +(m0 - c.off).toFixed(4), tout = +Math.min(c.dur - 0.02, m1 - c.off + ext).toFixed(4);
    const m = opts.master, af = m && m0 >= m.off && m1 <= m.off + m.dur ? m : c;
    const s = { mediaId: c.mediaId, name: c.name, in: tin, out: tout, dur: c.dur, w: c.w, h: c.h, score: 0.6, order: c.order, capture: c.capture,
      samples: (c.samples || []).filter(x => x.t >= tin - 0.3 && x.t <= tout + 0.3), thumb: '',
      mc: { group: opts.group, g0: +m0.toFixed(4), g1: +m1.toFixed(4), cam: c.k, replay: true }, replay: true, ext: 'angles',
      audioFrom: { mediaId: af.mediaId, off: +(c.off - af.off).toFixed(4) } };
    if (sp < 1) s.speed = sp;
    return s;
  });
}
/**
 * Pick highlight moments in a planned multi-cam edit and insert an every-angle replay after each one.
 * shots: planMulticam(...).shots. opts: { count: 'auto' | n, len (s per angle), slow, xfade, lapRef, envOf, nudge }
 * Highlight score per moment = loud/busy sound (onset envelope) + motion + sharpness, only where ≥ 2 cameras saw it.
 */
export function addAngleReplays(shots, group, items, opts = {}) {
  const len = opts.len || 2.2, nudge = opts.nudge || {};
  const cams = group.members.map((m, k) => { const it = items.get(m.mediaId); return it && { ...it, mediaId: m.mediaId, off: m.off + (nudge[m.mediaId] || 0), k }; }).filter(Boolean);
  if (cams.length < 2 || !shots.length) return { shots, moments: [] };
  const master = cams.find(c => c.mediaId === group.master) || cams.reduce((p, c) => (c.dur > p.dur ? c : p));
  const ownAudio = !group.master;
  const env = opts.envOf?.(master.mediaId) || null;
  const lapRef = opts.lapRef || 50;
  const G0 = shots[0].mc.g0, G1 = shots[shots.length - 1].mc.g1;
  const sampleNear = (c, t) => { const ss = c.samples || []; let b = null; for (const x of ss) if (!b || Math.abs(x.t - t) < Math.abs(b.t - t)) b = x; return b && Math.abs(b.t - t) <= (c.step || 0.5) + 0.01 ? b : null; };
  const cand = [];
  for (let g = G0 + len + 3; g <= G1 - len * 0.5; g += 0.5) {
    const m0 = g - len, m1 = g;
    const see = cams.filter(c => m0 >= c.off + 0.05 && m1 <= c.off + c.dur - 0.1);
    if (see.length < 2) continue;
    // must end inside a live (non-replay) shot, not right at its edges
    if (!shots.some(s => !s.mc.replay && s.mc.g0 + 0.3 < m1 && m1 < s.mc.g1 - 0.3)) continue;
    let au = 0, n = 0;
    if (env) for (let t = m0; t <= m1; t += 0.01) { const i = Math.round((t - master.off) * 100); if (i >= 0 && i < env.length) { au += Math.max(0, env[i]); n++; } }
    au = n ? au / n : 0;
    let mo = 0, q = 0, bad = 0, k = 0;
    for (const c of see) for (let t = m0; t <= m1; t += 0.5) {
      const s = sampleNear(c, t - c.off); if (!s) continue; k++;
      mo += (s.still || 0) + Math.hypot(s.vx || 0, s.vy || 0) * 0.02; q += quality(s, lapRef); if (s.bad?.length && !s.soft) bad++;
    }
    if (!k || bad / k > 0.3) continue;
    cand.push({ m0, m1, au, mo: mo / k, q: q / k, n: see.length });
  }
  if (!cand.length) return { shots, moments: [] };
  const mx = (f) => Math.max(1e-9, ...cand.map(f));
  const A = mx(c => c.au), M = mx(c => c.mo), Q = mx(c => c.q);
  cand.forEach(c => { c.sc = 0.45 * c.au / A + 0.35 * c.mo / M + 0.2 * c.q / Q + 0.05 * (c.n - 2); });
  const span = G1 - G0;
  const count = opts.count === 'auto' || opts.count == null ? clamp(Math.round(span / 30), 1, 4) : clamp(+opts.count || 0, 0, 8);
  const gap = Math.max(len * 3 + 4, span / (count + 1) * 0.6);
  const picked = [];
  for (const c of [...cand].sort((a, b) => b.sc - a.sc)) { if (picked.length >= count) break; if (picked.every(p => Math.abs(p.m1 - c.m1) >= gap)) picked.push(c); }
  picked.sort((a, b) => a.m1 - b.m1);
  let out = shots.map(s => ({ ...s, mc: { ...s.mc } }));
  const moments = [];
  for (const p of picked) {
    const i = out.findIndex(s => !s.mc.replay && s.mc.g0 + 0.3 < p.m1 && p.m1 < s.mc.g1 - 0.3); if (i < 0) continue;
    const s = out[i], co = s.mc.g0 - s.in; // camera offset of this shot (group time of its t=0)
    const seq = replaySequence(cams, p.m0, p.m1, { slow: opts.slow, xfade: opts.xfade, group: group.id, master: ownAudio ? null : { mediaId: master.mediaId, off: master.off, dur: master.dur } });
    if (seq.length < 2) continue;
    const head = { ...s, out: +(p.m1 - co).toFixed(4), mc: { ...s.mc, g1: +p.m1.toFixed(4) } };
    const tail = { ...s, in: +(p.m1 - co).toFixed(4), mc: { ...s.mc, g0: +p.m1.toFixed(4) } };
    out.splice(i, 1, head, ...seq, tail);
    // a sliver of live footage after the replay looks like a glitch: let the next live shot start at the moment instead
    const ti = i + 1 + seq.length, nx = out[ti + 1];
    if (tail.mc.g1 - tail.mc.g0 < 1 && nx && !nx.mc.replay) {
      const nc = cams.find(c => c.mediaId === nx.mediaId), d = nx.mc.g0 - p.m1;
      if (nc && p.m1 >= nc.off + 0.02 && d > 0) { out.splice(ti, 1); nx.in = +(nx.in - d).toFixed(4); nx.mc.g0 = +p.m1.toFixed(4); if (nx.audioFrom && nx.audioFrom.mediaId !== nx.mediaId) { /* same offset still valid */ } }
    }
    moments.push({ g0: +p.m0.toFixed(2), g1: +p.m1.toFixed(2), cams: seq.map(x => x.mc.cam), score: +p.sc.toFixed(2) });
  }
  return { shots: out, moments };
}
