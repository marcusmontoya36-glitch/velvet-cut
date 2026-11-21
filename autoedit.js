// Auto Edit: on-device shot analysis (blur / exposure / shake / static / duplicates / scene cuts),
// shot planning + ordering, per-clip enhancement settings and "Dynamic camera" framing.
// Everything runs in the browser by seeking a hidden <video> and reading small canvas frames,
// so memory stays flat no matter how long the clip is (it never loads the whole file).
import { once } from './exporter.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[clamp(Math.floor(s.length * p), 0, s.length - 1)]; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const AUTO_DEFAULTS = {
  order: 'capture',      // capture | file | best
  xfade: 0.4,            // seconds, 0 = hard cuts
  strict: 'normal',      // loose | normal | strict
  color: true, denoise: true, sharpen: true, stabilize: true,
  camera: true, camLevel: 2, // 1 subtle, 2 medium, 3 bold
};
export function loadAutoSettings() {
  try { return { ...AUTO_DEFAULTS, ...JSON.parse(localStorage.getItem('vc.auto') || '{}') }; } catch { return { ...AUTO_DEFAULTS }; }
}
export function saveAutoSettings(s) { localStorage.setItem('vc.auto', JSON.stringify(s)); }

// ---------- capture time from MP4/MOV metadata (mvhd creation_time), without reading the whole file ----------
export async function readCaptureTime(blob) {
  try {
    const rd = async (off, len) => new DataView(await blob.slice(off, off + len).arrayBuffer());
    let off = 0, guard = 0;
    while (off + 8 <= blob.size && guard++ < 64) {
      const h = await rd(off, 16);
      let size = h.getUint32(0); const type = String.fromCharCode(h.getUint8(4), h.getUint8(5), h.getUint8(6), h.getUint8(7));
      let hdr = 8;
      if (size === 1) { size = Number(h.getBigUint64(8)); hdr = 16; } else if (size === 0) size = blob.size - off;
      if (size < 8) break;
      if (type === 'moov') {
        const len = Math.min(size, 8 * 1024 * 1024);
        const mv = new Uint8Array(await blob.slice(off, off + len).arrayBuffer());
        for (let i = hdr; i < mv.length - 24; i++) {
          if (mv[i] === 0x6d && mv[i + 1] === 0x76 && mv[i + 2] === 0x68 && mv[i + 3] === 0x64) { // 'mvhd'
            const dv = new DataView(mv.buffer, i + 4);
            const ver = dv.getUint8(0);
            const secs = ver === 1 ? Number(dv.getBigUint64(4)) : dv.getUint32(4);
            if (!secs) return null;
            const ms = (secs - 2082844800) * 1000; // 1904 epoch -> unix
            return ms > 946684800000 && ms < Date.now() + 864e5 * 365 ? ms : null;
          }
        }
        return null;
      }
      off += size;
    }
  } catch {}
  return null;
}

// ---------- per-frame metrics ----------
function toGray(d, n) {
  const g = new Float32Array(n);
  for (let i = 0, j = 0; j < n; i += 4, j++) g[j] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
  return g;
}
function lapVar(g, w, h) {
  let s = 0, s2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const v = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    s += v; s2 += v * v; n++;
  }
  const m = s / n; return s2 / n - m * m;
}
function half(g, w, h) {
  const w2 = w >> 1, h2 = h >> 1, o = new Float32Array(w2 * h2);
  for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
    const i = 2 * y * w + 2 * x; o[y * w2 + x] = (g[i] + g[i + 1] + g[i + w] + g[i + w + 1]) / 4;
  }
  return { g: o, w: w2, h: h2 };
}
function sad(a, b, w, h, dx, dy, step = 1) {
  const m = Math.max(Math.abs(dx), Math.abs(dy)) + 1;
  let s = 0, n = 0;
  for (let y = m; y < h - m; y += step) for (let x = m; x < w - m; x += step) { s += Math.abs(a[y * w + x] - b[(y + dy) * w + x + dx]); n++; }
  return s / Math.max(1, n);
}
// global translation b relative to a, coarse-to-fine (range ~±14 px at analysis width)
function shift(a, b, w, h) {
  const A = half(a, w, h), B = half(b, w, h);
  let best = [0, 0], bv = Infinity;
  for (let dy = -6; dy <= 6; dy++) for (let dx = -7; dx <= 7; dx++) { const v = sad(A.g, B.g, A.w, A.h, dx, dy, 2); if (v < bv) { bv = v; best = [dx, dy]; } }
  let fx = best[0] * 2, fy = best[1] * 2; bv = Infinity; let fb = [fx, fy];
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = sad(a, b, w, h, fx + dx, fy + dy); if (v < bv) { bv = v; fb = [fx + dx, fy + dy]; } }
  // trust the global shift only if it explains the change much better than "no motion"
  // (moving subjects on a still camera otherwise look like camera shake)
  const s0 = sad(a, b, w, h, 0, 0);
  if ((fb[0] || fb[1]) && !(s0 > bv * 1.6 && s0 - bv > 3)) return { dx: 0, dy: 0, resid: s0 / 255 };
  return { dx: fb[0], dy: fb[1], resid: bv / 255 };
}
function signature(g, w, h) { // 16x9 normalized thumbnail
  const sw = 16, sh = 9, o = new Float32Array(sw * sh);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) o[Math.min(sh - 1, Math.floor(y * sh / h)) * sw + Math.min(sw - 1, Math.floor(x * sw / w))] += g[y * w + x];
  const cnt = (w / sw) * (h / sh); for (let i = 0; i < o.length; i++) o[i] /= cnt * 255;
  return o;
}
const sigDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; };
function hist(d, n) {
  const h = new Float32Array(24); // 8 bins per channel
  for (let i = 0; i < n * 4; i += 4) { h[d[i] >> 5]++; h[8 + (d[i + 1] >> 5)]++; h[16 + (d[i + 2] >> 5)]++; }
  for (let i = 0; i < 24; i++) h[i] /= n; return h;
}
const histDiff = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / 3; }; // 0..2 -> 0..~0.67

// subject centre: local motion (after global compensation) + skin tone + centre prior
function subject(d, g1, g2, w, h, sh) {
  let sx = 0, sy = 0, sw = 0;
  const m = Math.max(Math.abs(sh.dx), Math.abs(sh.dy)) + 1;
  for (let y = m; y < h - m; y += 2) for (let x = m; x < w - m; x += 2) {
    const i = y * w + x, k = i * 4;
    const r = d[k], gg = d[k + 1], b = d[k + 2];
    const mot = Math.abs(g1[i] - g2[(y + sh.dy) * w + x + sh.dx]) / 255;
    const skin = r > 95 && gg > 40 && b > 20 && r > gg && r > b && r - Math.min(gg, b) > 15 && Math.abs(r - gg) > 15 ? 1 : 0;
    const cx = (x / w - 0.5), cy = (y / h - 0.45);
    const prior = Math.exp(-(cx * cx + cy * cy) / 0.08);
    const wt = (mot * 4 + skin * 0.8) * (0.35 + prior) + prior * 0.05;
    sx += x * wt; sy += y * wt; sw += wt;
  }
  return sw > 0 ? { cx: sx / sw / w, cy: sy / sw / h, conf: clamp(sw / ((w * h) / 4) * 4, 0, 1) } : { cx: 0.5, cy: 0.5, conf: 0 };
}

/**
 * Sample a media range. Seeks pairs (t, t+dt) so we can measure frame-to-frame motion.
 * Returns {samples, step}. Each sample: {t, luma, sd, sat, dark, bright, lap, vx, vy, resid, still, cut, sig, cx, cy, thumb}
 */
export async function analyzeRange(url, t0, t1, { onTick, signal, maxSamples = 360 } = {}) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto'; v.src = url;
  await once(v, 'loadedmetadata');
  try { await v.play(); v.pause(); } catch {} // muted inline play nudges iOS Safari to decode frames
  const span = Math.max(0.1, t1 - t0);
  const step = clamp(span / maxSamples, 1 / 3, 2.5);      // ~3 samples/s, fewer on long clips
  const dt = 0.045;                                        // ~1 frame at 30 fps, 2-3 at 60 fps
  const AW = 160, AH = Math.max(36, Math.round(AW * (v.videoHeight || 9) / (v.videoWidth || 16) / 2) * 2);
  const cv = document.createElement('canvas'); cv.width = AW; cv.height = AH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const tc = document.createElement('canvas'); tc.width = 96; tc.height = Math.round(96 * AH / AW);
  const tctx = tc.getContext('2d');
  const grab = async (t) => {
    const p = once(v, 'seeked'); v.currentTime = t;
    await Promise.race([p, new Promise(r => setTimeout(r, 5000))]);
    ctx.drawImage(v, 0, 0, AW, AH);
    return ctx.getImageData(0, 0, AW, AH).data;
  };
  const out = [];
  let prevG = null, prevSig = null, prevHist = null;
  const n = AW * AH;
  for (let t = t0 + step / 2; t < t1; t += step) {
    if (signal?.aborted) throw new Error('Cancelled');
    const d1 = await grab(Math.min(t, t1 - dt - 0.01));
    const g1 = toGray(d1, n);
    const thumb = (tctx.drawImage(cv, 0, 0, tc.width, tc.height), tc.toDataURL('image/jpeg', 0.55));
    const d2 = await grab(Math.min(t + dt, t1 - 0.005));
    const g2 = toGray(d2, n);
    let luma = 0, sat = 0, dark = 0, bright = 0, sd = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      luma += g1[j]; if (g1[j] < 24) dark++; if (g1[j] > 238) bright++;
      const mx = Math.max(d1[i], d1[i + 1], d1[i + 2]), mn = Math.min(d1[i], d1[i + 1], d1[i + 2]);
      sat += mx ? (mx - mn) / mx : 0;
    }
    luma /= n; for (let j = 0; j < n; j++) sd += (g1[j] - luma) ** 2;
    sd = Math.sqrt(sd / n) / 255; luma /= 255; sat /= n; dark /= n; bright /= n;
    const sh = shift(g1, g2, AW, AH);
    const sig = signature(g1, AW, AH), hs = hist(d1, n);
    const still = prevG ? sad(prevG, g1, AW, AH, 0, 0, 2) / 255 : null;   // vs previous sample (≈step s apart)
    const cut = prevSig ? Math.min(1, sigDiff(prevSig, sig) * 4) * 0.5 + Math.min(1, histDiff(prevHist, hs) * 2.5) * 0.5 : 0;
    const subj = subject(d1, g1, g2, AW, AH, sh);
    out.push({ t: r2(t), luma, sd, sat, dark, bright, lap: lapVar(g1, AW, AH), vx: sh.dx / AW / dt, vy: sh.dy / AW / dt, resid: sh.resid, still, cut, sig, ...subj, thumb });
    prevG = g1; prevSig = sig; prevHist = hs;
    onTick && onTick(clamp((t - t0) / span, 0, 1));
  }
  v.removeAttribute('src'); v.load();
  // shake = erratic velocity (deviation from neighbours) + very fast whips
  for (let i = 0; i < out.length; i++) {
    const a = out[i - 1] || out[i + 1] || out[i], b = out[i + 1] || out[i - 1] || out[i];
    const mx = (a.vx + b.vx) / 2, my = (a.vy + b.vy) / 2;
    const jit = Math.hypot(out[i].vx - mx, out[i].vy - my);
    out[i].speed = Math.hypot(out[i].vx, out[i].vy);
    out[i].shake = Math.max(jit, out[i].speed * 0.5);
  }
  return { samples: out, step };
}

const STRICT = {
  loose:  { blur: 0.22, blurAbs: 6,  dark: 0.07, blown: 0.93, shake: 1.6, still: 0.0025, minKeep: 0.8, dup: 0.018 },
  normal: { blur: 0.35, blurAbs: 10, dark: 0.11, blown: 0.88, shake: 1.0, still: 0.004,  minKeep: 1.0, dup: 0.03 },
  strict: { blur: 0.5,  blurAbs: 16, dark: 0.16, blown: 0.82, shake: 0.6, still: 0.006,  minKeep: 1.4, dup: 0.045 },
};

/** Flag bad samples. lapRef = reference sharpness (median of sharp-ish samples across ALL clips). */
function flagSamples(samples, lapRef, P) {
  for (const s of samples) {
    const r = []; s.soft = false;
    if (s.lap < Math.max(P.blurAbs, lapRef * P.blur) && !(s.luma < P.dark)) r.push('blurry');
    if (s.luma < P.dark || (s.dark > 0.75 && s.luma < P.dark * 1.8) || (s.luma < P.dark * 1.35 && s.sd < 0.08)) r.push('too dark');
    if (s.luma > P.blown || s.bright > 0.55) r.push('blown out');
    if (s.shake > P.shake) r.push('shaky');
    s.bad = r;
  }
  // static: consecutive samples nearly identical for >= ~1.5 s
  let i = 0;
  while (i < samples.length) {
    if (samples[i].still != null && samples[i].still < P.still) {
      let j = i; while (j + 1 < samples.length && samples[j + 1].still != null && samples[j + 1].still < P.still) j++;
      const first = Math.max(0, i - 1); // the sample before the run is the first frozen frame
      const len = samples[j].t - samples[first].t;
      if (len >= 1.2) for (let k = first; k <= j; k++) samples[k].bad.push('static');
      i = j + 1;
    } else i++;
  }
}
function quality(s, lapRef) {
  const sharp = clamp(s.lap / Math.max(1, lapRef), 0, 1.5);
  const expo = 1 - clamp(Math.abs(s.luma - 0.47) / 0.47, 0, 1);
  const steady = 1 - clamp(s.shake / 1.5, 0, 1);
  const life = s.still == null ? 0.5 : clamp(s.still / 0.03, 0, 1); // some motion is good
  return +(sharp * 0.4 + expo * 0.25 + steady * 0.2 + life * 0.15).toFixed(3);
}

/**
 * Turn analysed media into kept shots + cuts.
 * items: [{mediaId, name, in, out, dur, w, h, order, capture, samples, step}]
 */
export function planEdit(items, settings) {
  const P = STRICT[settings.strict] || STRICT.normal;
  const allLap = items.flatMap(it => it.samples.filter(s => s.luma > 0.12 && s.luma < 0.88).map(s => s.lap));
  const lapRef = pct(allLap, 0.7) || 50;
  const keep = [], cuts = [];
  for (const it of items) {
    flagSamples(it.samples, lapRef, P);
    const S = it.samples, h = it.step / 2;
    const bounds = (k) => [clamp(S[k].t - h, it.in, it.out), clamp(S[k].t + h, it.in, it.out)];
    // ignore isolated single bad samples (except exposure) - avoids chopping on one soft frame
    S.forEach((s, k) => {
      if (s.bad.length && s.bad.every(r => r === 'blurry' || r === 'shaky')) {
        const pb = S[k - 1]?.bad.length, nb = S[k + 1]?.bad.length;
        if (!pb && !nb && S.length > 2) s.soft = true;
      }
    });
    let runs = [];
    for (let k = 0; k < S.length; k++) {
      const isBad = S[k].bad.length > 0 && !S[k].soft;
      const [a, b] = bounds(k);
      const last = runs[runs.length - 1];
      const sceneCut = k > 0 && S[k].cut > 0.42;
      if (last && last.bad === isBad && !(sceneCut && !isBad)) { last.end = b; last.ks.push(k); }
      else runs.push({ bad: isBad, start: k === 0 ? it.in : a, end: b, ks: [k], scene: sceneCut });
    }
    if (runs.length) runs[runs.length - 1].end = it.out;
    // short good runs between bad -> cut
    for (const r of runs) if (!r.bad && r.end - r.start < P.minKeep) { r.bad = true; r.short = true; }
    // merge adjacent bad runs
    const merged = [];
    for (const r of runs) { const l = merged[merged.length - 1]; if (l && l.bad && r.bad) { l.end = r.end; l.ks.push(...r.ks); l.short = l.short && r.short; } else merged.push({ ...r }); }
    for (const r of merged) {
      const ss = r.ks.map(k => S[k]);
      const score = +(ss.reduce((a, s) => a + quality(s, lapRef), 0) / Math.max(1, ss.length)).toFixed(3);
      const base = { mediaId: it.mediaId, name: it.name, in: r2(r.start), out: r2(r.end), dur: it.dur, w: it.w, h: it.h, score, order: it.order, capture: it.capture };
      if (r.bad) {
        const reasons = [...new Set(ss.flatMap(s => s.soft ? [] : s.bad))];
        if (!reasons.length) reasons.push('too short');
        const mid = ss[Math.floor(ss.length / 2)];
        cuts.push({ ...base, id: uid(), reasons, thumb: mid?.thumb || '' });
      } else {
        const sig = new Float32Array(144); ss.forEach(s => s.sig.forEach((v, i) => sig[i] += v / ss.length));
        keep.push({ ...base, sig, samples: ss, thumb: ss[Math.floor(ss.length / 2)]?.thumb || '' });
      }
    }
  }
  // near-duplicate shots: keep the better one
  const kept = [];
  for (const k of [...keep].sort((a, b) => b.score - a.score)) {
    const twin = kept.find(o => sigDiff(o.sig, k.sig) < P.dup);
    if (twin) cuts.push({ mediaId: k.mediaId, name: k.name, in: k.in, out: k.out, dur: k.dur, w: k.w, h: k.h, score: k.score, order: k.order, capture: k.capture, id: uid(), reasons: ['duplicate'], thumb: k.thumb });
    else kept.push(k);
  }
  orderShots(kept, settings.order);
  cuts.sort((a, b) => a.order - b.order || a.in - b.in);
  return { keep: kept, cuts, lapRef };
}
export function orderShots(arr, mode) {
  const cap = (s) => (s.capture ?? Infinity) + s.in * 1000;
  if (mode === 'best') arr.sort((a, b) => b.score - a.score);
  else if (mode === 'capture') arr.sort((a, b) => (cap(a) - cap(b)) || (a.order - b.order) || (a.in - b.in));
  else arr.sort((a, b) => a.order - b.order || a.in - b.in);
  return arr;
}

// ---------- enhancement (per source clip) ----------
export function enhanceFor(samples, settings) {
  const good = samples.filter(s => !s.bad?.length || s.soft);
  const ss = good.length ? good : samples;
  const avg = (k) => ss.reduce((a, s) => a + s[k], 0) / Math.max(1, ss.length);
  const L = avg('luma'), SD = avg('sd'), SAT = avg('sat');
  const e = { b: 0, c: 1, s: 1, dn: 0, sh: 0, stab: false };
  if (settings.color) {
    e.b = +clamp((0.47 - L) * 0.6, -0.2, 0.3).toFixed(2);
    e.c = +clamp(0.21 / Math.max(0.05, SD), 0.95, 1.3).toFixed(2);
    e.s = +clamp(SAT < 0.2 ? 1.25 : SAT > 0.5 ? 1.0 : 1.12, 0.9, 1.35).toFixed(2);
  }
  if (settings.denoise) e.dn = L < 0.3 ? 2 : 1;          // darker footage is noisier
  if (settings.sharpen) e.sh = 1;
  return e;
}

// ---------- Dynamic camera ----------
const LEVELS = {
  1: { zMed: 1.12, zClose: 1.22, push: 0.08, pan: 0.04, punchMin: 9 },
  2: { zMed: 1.2, zClose: 1.4, push: 0.14, pan: 0.07, punchMin: 6 },
  3: { zMed: 1.3, zClose: 1.65, push: 0.22, pan: 0.1, punchMin: 4 },
};
function subjectOf(samples, a, b) {
  const ss = samples.filter(s => s.t >= a - 0.01 && s.t <= b + 0.01);
  const use = ss.length ? ss : samples;
  // confidence-weighted, outlier-robust (median), then pulled slightly to centre
  const cx = median(use.map(s => s.cx)), cy = median(use.map(s => s.cy));
  const conf = median(use.map(s => s.conf || 0));
  const k = 0.35 + 0.5 * conf;
  return { cx: 0.5 + (cx - 0.5) * k, cy: 0.5 + (cy - 0.5) * k };
}
// clamp centre so the crop window stays inside the frame
export function clampCenter(cx, cy, z) { const m = 0.5 / z; return [clamp(cx, m, 1 - m), clamp(cy, m, 1 - m)]; }

/** Split long shots into punch-in "angles" and assign a framing to every shot so cuts read like multi-cam. */
export function planCamera(shots, level) {
  const L = LEVELS[level] || LEVELS[2];
  const out = [];
  for (const s of shots) {
    const len = s.out - s.in;
    if (len >= L.punchMin * 1.6 && s.samples?.length) {
      // split into 2-3 parts at evenly spaced points (punch-in cuts on the same shot)
      const parts = clamp(Math.floor(len / L.punchMin), 2, 3);
      for (let p = 0; p < parts; p++) {
        const a = r2(s.in + len * p / parts), b = p === parts - 1 ? s.out : r2(s.in + len * (p + 1) / parts);
        out.push({ ...s, in: a, out: b, punch: p > 0 });
      }
    } else out.push({ ...s });
  }
  // cycle of framings; consecutive shots never repeat the same framing
  const cycle = ['wide', 'push', 'close', 'pan', 'medium', 'pull', 'tilt', 'close'];
  let ci = 0, prev = null;
  for (const s of out) {
    let type = cycle[ci++ % cycle.length];
    if (s.punch && (prev === 'close' || prev === 'push')) type = 'wide';
    else if (s.punch) type = 'close';
    if (type === prev) type = cycle[ci++ % cycle.length];
    prev = type;
    s.cam = camFor(type, subjectOf(s.samples || [], s.in, s.out), L);
  }
  return out;
}
export function camFor(type, subj, L) {
  const { cx, cy } = subj;
  const mk = (z0, z1, x0, y0, x1, y1) => {
    const [a, b] = clampCenter(x0, y0, z0), [c, d] = clampCenter(x1, y1, z1);
    return { type, z0: +z0.toFixed(3), z1: +z1.toFixed(3), x0: +a.toFixed(3), y0: +b.toFixed(3), x1: +c.toFixed(3), y1: +d.toFixed(3) };
  };
  switch (type) {
    case 'wide': return mk(1, 1, 0.5, 0.5, 0.5, 0.5);
    case 'medium': return mk(L.zMed, L.zMed, cx, cy, cx, cy);
    case 'close': return mk(L.zClose, L.zClose + 0.04, cx, cy, cx, cy);
    case 'push': return mk(1.02, 1.02 + L.push * 1.6, 0.5, 0.5, cx, cy);
    case 'pull': return mk(1.02 + L.push * 1.6, 1.02, cx, cy, 0.5, 0.5);
    case 'pan': { const z = L.zMed; const dir = cx < 0.5 ? 1 : -1; return mk(z, z, cx - dir * L.pan, cy, cx + dir * L.pan, cy); }
    case 'tilt': { const z = L.zMed; return mk(z, z, cx, cy + L.pan * 0.8, cx, cy - L.pan * 0.8); }
  }
  return null;
}
