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
const SFI = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
async function decodeAt(ab, rate) {
  const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  const ac = new AC(1, rate, rate);
  return await new Promise((res, rej) => { const p = ac.decodeAudioData(ab, res, rej); if (p?.then) p.then(res, rej); });
}
// AAC samples from the MP4 -> ADTS stream (only the audio bytes are kept, so a big video costs little memory)
async function adtsOf(blob) {
  const dm = await demux(blob);
  const a = dm.audio; if (!a || !/^mp4a/.test(a.codec) || !a.samples?.length) return null;
  const asc = a.asc; if (!asc || asc.length < 2) return null;
  const ot = asc[0] >> 3, fi = ((asc[0] & 7) << 1) | (asc[1] >> 7), ch = (asc[1] >> 3) & 15;
  if (ot < 1 || ot > 4 || fi > 12) return null; // ADTS can carry AAC Main/LC/SSR/LTP only (HE-AAC decodes as LC)
  const rd = byteReader(blob);
  const total = a.samples.reduce((s, x) => s + x.size + 7, 0), out = new Uint8Array(total);
  let o = 0;
  for (const s of a.samples) {
    const len = s.size + 7, d = await rd(s.offset, s.size);
    out[o] = 0xff; out[o + 1] = 0xf1; out[o + 2] = ((ot - 1) << 6) | (fi << 2) | (ch >> 2);
    out[o + 3] = ((ch & 3) << 6) | (len >> 11); out[o + 4] = (len >> 3) & 0xff; out[o + 5] = ((len & 7) << 5) | 0x1f; out[o + 6] = 0xfc;
    out.set(d, o + 7); o += len;
  }
  // first sample's presentation time (edit lists / priming are ignored: same for every camera of one model)
  return { ab: out.buffer, skip: a.skip || 0 };
}
/** mono Float32Array at 8 kHz of the clip's audio, or null if it has none */
export async function extractAudio(blob) {
  let buf = null;
  let skip = 0;
  try { const ad = await adtsOf(blob); if (ad) { buf = await decodeAt(ad.ab, RATE); skip = Math.round(ad.skip * RATE); } } catch (e) { buf = null; }
  if (!buf) {
    try { buf = await decodeAt(await blob.arrayBuffer(), RATE); } catch { return null; }
  }
  const n = Math.max(0, buf.length - skip), x = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) x[i] += d[i + skip] / buf.numberOfChannels; }
  let e = 0; for (let i = 0; i < n; i += 7) e += x[i] * x[i];
  if (e / Math.max(1, n / 7) < 1e-9) return null; // silent track
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
export async function audioFeatures(blob) {
  const x = await extractAudio(blob);
  if (!x || x.length < RATE) return null;
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
export const SYNC_MIN_CONF = 0.25;

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
  for (let i = 0; i < free.length; i++) for (let j = i + 1; j < free.length; j++) {
    const a = free[i], b = free[j];
    const r = pair(a, b);
    if (r && r.conf >= SYNC_MIN_CONF && r.overlap >= 1.5) { edges.push({ a: a.mediaId, b: b.mediaId, lag: r.lag, conf: r.conf, method: 'audio', r }); continue; }
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
      if (r && (!best || r.conf > best.conf || (best.conf === 0 && r.z > best.z))) best = { off: m.off + r.lag, conf: r.conf, z: r.z, method: r.conf >= SYNC_MIN_CONF ? 'audio' : 'manual' };
      if (!best?.conf && o.capture && me.capture) best = { off: m.off + (me.capture - o.capture) / 1000, conf: 0.2, method: 'time' };
    }
    g.members.push({ mediaId: mid, off: +(best?.off ?? 0).toFixed(4), conf: best?.conf ?? 0, method: best?.method || 'manual' });
  }
  for (const g of groups) { const mn = Math.min(...g.members.map(m => m.off)); g.members.forEach(m => { m.off = +(m.off - mn).toFixed(4); }); }
  return groups.filter(g => g.members.length >= 2 || assign[g.members[0]?.mediaId] === g.id);
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
    let sum = 0, n = 0, bad = 0;
    for (let g = a; g <= b + 1e-6; g += 0.25) { const s = sAt(c, g); if (!s) continue; n++; sum += quality(s, lapRef); if (badOf(c, s)) bad++; }
    return n ? { q: sum / n, bad: bad / n } : { q: c.med, bad: 0 };
  };
  const used = new Map(); let usedAll = 0;
  // master audio: the camera covering most of the group (ties: the one with the best average picture is not
  // relevant to sound, so prefer the longest)
  const master = cams.reduce((p, c) => (c.it.dur > p.it.dur ? c : p));
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
    for (const c of cams) {
      if (!covers(c, g, g + Math.min(1, G1 - g - 0.1))) continue;
      const maxL = c.off + c.it.dur - 0.05 - g;
      const L = Math.min(want, maxL);
      if (L < Math.min(1, G1 - g - 0.1)) continue;
      const w = winScore(c, g, g + L);
      let sc = w.q + 2 * (w.q - c.med) - 1.2 * w.bad;
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
    const af = covers(master, s.a, b) ? master : s.c;
    const it = s.c.it, tin = +(s.a - s.c.off).toFixed(4), tout = +(b - s.c.off).toFixed(4);
    return {
      mediaId: s.c.mediaId, name: it.name, in: tin, out: tout, dur: it.dur, w: it.w, h: it.h,
      score: +winScore(s.c, s.a, s.b).q.toFixed(3), order: it.order, capture: it.capture,
      samples: (it.samples || []).filter(x => x.t >= tin - 0.3 && x.t <= tout + 0.3), thumb: '',
      mc: { group: group.id, g0: +s.a.toFixed(4), g1: +s.b.toFixed(4), cam: cams.indexOf(s.c) },
      audioFrom: { mediaId: af.mediaId, off: +(s.c.off - af.off).toFixed(4) },
    };
  });
  return { shots, cuts, master: master.mediaId, span: [G0, G1] };
}
/** cameras that can show group-time range [a, b] */
export function camsCovering(group, a, b, durOf, nudge = {}) {
  return group.members.filter(m => { const o = m.off + (nudge[m.mediaId] || 0), d = durOf(m.mediaId); return d && a >= o - 0.01 && b <= o + d + 0.01; });
}
