// Auto Edit: on-device shot analysis (blur / exposure / shake / static / duplicates / scene cuts),
// shot planning + ordering, per-clip enhancement settings and "Dynamic camera" framing.
// Everything runs in the browser by seeking a hidden <video> and reading small canvas frames,
// so memory stays flat no matter how long the clip is (it never loads the whole file).

import { actionBox, detectPeople, detectPeopleMulti, framingScore, assignTargets } from './framing.js';
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;
const median = (a) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (a, p) => { if (!a.length) return 0; const s = [...a].sort((x, y) => x - y); return s[clamp(Math.floor(s.length * p), 0, s.length - 1)]; };
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const AUTO_DEFAULTS = {
  order: 'capture',      // capture | file | best
  xfade: '0.5',          // '0' hard cuts | '0.3' | '0.5' | '0.8' crossfade s | 'b0.5' dip to black
  strict: 'normal',      // loose | normal | strict
  color: true, denoise: true, sharpen: true, stabilize: true,
  camera: true, camLevel: 2, altAngle: false, // camLevel 1 subtle, 2 medium, 3 bold
  angles: true,          // simulated high (from above) / low (from below) angles mixed into the rotation
  dutch: true,           // slight dutch tilt on some of the angled shots
  hideMan: 'most',       // third-person clips: hide his upper body on 'most' | 'all' shots | 'off'
  keepFrame: true,       // "Keep her in frame": every camera move keeps her + the action inside the crop
  frameTight: 'balanced', // loose | balanced | tight (margin around her)
  fish: '0.18',          // fisheye lens on some close / low shots: '0' off | '0.18' subtle | '0.32' strong
  extend: '0',           // '0' off | 'x1.5' | 'x2' | 't30' | 't60' (target seconds)
  shadows: true,         // brighten dark areas: local shadow recovery (WebGL / ffmpeg, same maths)
  slowmo: 'fast',        // fast = frame blend (default, works with the hardware encoder) | smooth = motion-interpolated (ffmpeg, slow)
  multicam: 'auto',      // auto = find clips filmed at the same time (by sound) and cut between their angles | off
  mcXfade: '0.2',        // transition between cameras: '0' hard cut | '0.2' quick dissolve | '0.4'
  mcPace: 'normal',      // switch cameras every: fast 1.5-3 s | normal 2-5 s | slow 3-7 s
  mcReplay: 'auto',      // every-angle replays of highlight moments: 'auto' (~1 per 30 s) | '0' off | count
  mcReplaySlow: true,    // replays at 0.8x
};
export function loadAutoSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('vc.auto2') || '{}');
    if ((saved.sv || 0) < 7) { delete saved.slowmo; saved.sv = 7; } // v7: slow-mo defaults to Fast (smooth is opt-in)
    return { ...AUTO_DEFAULTS, ...saved };
  } catch { return { ...AUTO_DEFAULTS }; }
}
export function saveAutoSettings(s) { localStorage.setItem('vc.auto2', JSON.stringify({ ...s, sv: 8 })); }

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
        // iPhone: com.apple.quicktime.creationdate = recording start with time zone ("2026-11-20T15:00:00-0600"),
        // kept when shared; mvhd is often rewritten (export / AirDrop / Photos picker), so prefer the Apple key
        const txt = new TextDecoder('latin1').decode(mv), ki = txt.indexOf('com.apple.quicktime.creationdate');
        if (ki >= 0) {
          const m = txt.slice(ki).match(/(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)([+-]\d\d:?\d\d|Z)?/);
          if (m) { const ms = Date.parse(m[1] + (m[2] ? (m[2] === 'Z' ? 'Z' : m[2].slice(0, 3) + ':' + m[2].slice(-2)) : '')); if (ms > 946684800000) return ms; }
        }
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
    const wt = (mot * 3 + skin * 1.6) * (0.35 + prior) + prior * 0.05;
    sx += x * wt; sy += y * wt; sw += wt;
  }
  return sw > 0 ? { cx: sx / sw / w, cy: sy / sw / h, conf: clamp(sw / ((w * h) / 4) * 4, 0, 1) } : { cx: 0.5, cy: 0.5, conf: 0 };
}

// ---------- shared analysis <video> ----------
// One reusable hidden element. Calling unlockAnalysis() inside a tap "blesses" it on iOS so it may play
// (muted, fast) later even in Low Power Mode, which blocks gesture-less autoplay.
let AV = null;
const BLANK = new URL('vendor/blank.mp4', location.href).href;
export function analysisVideo() {
  if (!AV) {
    AV = document.createElement('video');
    AV.muted = true; AV.defaultMuted = true; AV.playsInline = true;
    AV.setAttribute('muted', ''); AV.setAttribute('playsinline', ''); AV.setAttribute('webkit-playsinline', '');
    AV.preload = 'auto';
    // must stay "visible" (in viewport, non-zero size) or iOS pauses it
    AV.style.cssText = 'position:fixed;left:0;bottom:0;width:48px;height:27px;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(AV);
  }
  return AV;
}
export function unlockAnalysis() {
  const v = analysisVideo();
  try { if (!v.getAttribute('src')) v.src = BLANK; const p = v.play(); if (p) p.then(() => v.pause(), () => {}); } catch {}
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
function waitEv(el, ev, ms) {
  return new Promise((res, rej) => {
    const ok = () => { done(); res(true); }, bad = () => { done(); rej(new Error('Media error ' + (el.error?.code || ''))); };
    const to = setTimeout(() => { done(); rej(new Error('timeout:' + ev)); }, ms);
    const done = () => { clearTimeout(to); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });
}
async function setSrc(v, url) {
  v.pause();
  const p = waitEv(v, 'loadedmetadata', 10000);
  v.src = url;
  await p;
}

/**
 * Sample a media range at ~2 frames/s on 120-px frames.
 * Fast path: play the (muted) video at high speed and grab frames with requestVideoFrameCallback
 * (no per-frame seeking, which is very slow on iOS). Each sample is a pair of consecutive frames so we
 * can measure camera motion. Fallback: seek sampling with short timeouts. A watchdog guarantees it never hangs.
 * Returns {samples, step, mode}.
 */
export async function analyzeRange(url, t0, t1, { onTick, signal, maxSamples = 240, perSec = 2, rate = 8, pose = null } = {}) {
  const v = analysisVideo();
  await setSrc(v, url);
  const span = Math.max(0.1, t1 - t0);
  const step = clamp(span / maxSamples, 1 / perSec, 2.5);
  const AW = 120, AH = Math.max(36, Math.round(AW * (v.videoHeight || 9) / (v.videoWidth || 16) / 2) * 2);
  const cv = document.createElement('canvas'); cv.width = AW; cv.height = AH;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const tc = document.createElement('canvas'); tc.width = 96; tc.height = Math.round(96 * AH / AW);
  const tctx = tc.getContext('2d');
  const n = AW * AH;
  const grab = () => { ctx.drawImage(v, 0, 0, AW, AH); return ctx.getImageData(0, 0, AW, AH).data; };
  // people (pose model) on a 256-px copy of the same frame; null = model not available
  const PW = 256, PH = Math.round(PW * AH / AW);
  const pcv = pose ? document.createElement('canvas') : null; if (pcv) { pcv.width = PW; pcv.height = PH; }
  const people = () => { if (!pose) return null; try { pcv.getContext('2d').drawImage(v, 0, 0, PW, PH); return detectPeopleMulti(pose, pcv); } catch { return null; } };
  const thumb = () => { tctx.drawImage(cv, 0, 0, tc.width, tc.height); return tc.toDataURL('image/jpeg', 0.55); };
  const out = [];
  let prevG = null, prevSig = null, prevHist = null;
  const measure = (d1, d2, dt, t, th, ppl = null) => {
    const g1 = toGray(d1, n), g2 = d2 === d1 ? g1 : toGray(d2, n);
    let luma = 0, sat = 0, dark = 0, bright = 0, sd = 0, shad = 0;
    for (let i = 0, j = 0; j < n; i += 4, j++) {
      luma += g1[j]; if (g1[j] < 24) dark++; if (g1[j] < 51) shad++; if (g1[j] > 238) bright++;
      const mx = Math.max(d1[i], d1[i + 1], d1[i + 2]), mn = Math.min(d1[i], d1[i + 1], d1[i + 2]);
      sat += mx ? (mx - mn) / mx : 0;
    }
    luma /= n; for (let j = 0; j < n; j++) sd += (g1[j] - luma) ** 2;
    sd = Math.sqrt(sd / n) / 255; luma /= 255; sat /= n; dark /= n; bright /= n; shad /= n;
    const okDt = dt > 0.004 && dt < 0.6;
    const sh = okDt ? shift(g1, g2, AW, AH) : { dx: 0, dy: 0, resid: 0 };
    const sig = signature(g1, AW, AH), hs = hist(d1, n);
    const still = prevG ? sad(prevG, g1, AW, AH, 0, 0, 2) / 255 : null;
    const cut = prevSig ? Math.min(1, sigDiff(prevSig, sig) * 4) * 0.5 + Math.min(1, histDiff(prevHist, hs) * 2.5) * 0.5 : 0;
    const subj = subject(d1, g1, g2, AW, AH, sh);
    const ab = actionBox(d1, g1, g2, AW, AH, sh);
    subj.gm = Math.abs(sh.dx) + Math.abs(sh.dy);
    if (ab) { subj.ab = ab.box; subj.am = ab.mot; if (ab.mbox) subj.mb = ab.mbox; subj.mg = ab.mg; }
    if (ppl) subj.ppl = ppl;
    out.push({ t: r2(t), dt: okDt ? dt : null, luma, sd, sat, dark, bright, shad, lap: lapVar(g1, AW, AH),
      vx: okDt ? sh.dx / AW / dt : null, vy: okDt ? sh.dy / AW / dt : null, resid: sh.resid, still, cut, sig, ...subj, thumb: th });
    prevG = g1; prevSig = sig; prevHist = hs;
    onTick && onTick(clamp((t - t0) / span, 0, 1));
  };

  // --- fast path: high-speed muted playback + requestVideoFrameCallback ---
  const playback = () => new Promise((resolve, reject) => {
    let next = t0 + step / 2, pend = null, last = -1, lastProg = performance.now(), done = false;
    const finish = (err) => {
      if (done) return; done = true; clearInterval(wd); v.removeEventListener('ended', onEnd);
      try { v.pause(); v.playbackRate = 1; } catch {}
      err ? reject(err) : resolve();
    };
    const handle = (mt) => {
      if (done) return;
      if (signal?.aborted) return finish(new Error('Cancelled'));
      if (mt <= last + 1e-4) return;
      last = mt; lastProg = performance.now();
      try {
        if (pend) { const d2 = grab(); measure(pend.d, d2, mt - pend.t, pend.t, pend.th, pend.ppl); pend = null; }
        else if (mt >= next && mt < t1) { pend = { d: grab(), t: mt }; pend.th = thumb(); pend.ppl = people(); while (next <= mt) next += step; }
      } catch (e) { return finish(e); }
      if (mt >= t1 - 0.03) finish();
    };
    const onEnd = () => { if (pend) measure(pend.d, pend.d, 0, pend.t, pend.th, pend.ppl); pend = null; finish(); };
    v.addEventListener('ended', onEnd);
    if ('requestVideoFrameCallback' in v) {
      const cb = (now, md) => { handle(md.mediaTime); if (!done) v.requestVideoFrameCallback(cb); };
      v.requestVideoFrameCallback(cb);
    } else {
      const raf = () => { if (done) return; if (v.readyState >= 2) handle(v.currentTime); requestAnimationFrame(raf); };
      requestAnimationFrame(raf);
    }
    // stall watchdog: no new frame for 2.5 s -> give up on playback mode
    const wd = setInterval(() => { if (signal?.aborted) finish(new Error('Cancelled')); else if (performance.now() - lastProg > 2500) finish(new Error('stall')); }, 250);
    try { if (t0 > 0.05) v.currentTime = t0; } catch {}
    v.playbackRate = rate;
    const pp = v.play();
    if (pp) pp.catch((e) => finish(new Error('play blocked: ' + (e?.name || e))));
  });

  // --- fallback: seeks with short timeouts ---
  const seekMode = async (from) => {
    let fails = 0;
    const seek = async (t) => { const p = waitEv(v, 'seeked', 1500); v.currentTime = t; await p; };
    for (let t = from; t < t1; t += step) {
      if (signal?.aborted) throw new Error('Cancelled');
      try {
        await seek(Math.min(t, t1 - 0.08)); const d1 = grab(); const th = thumb(); const ppl = people();
        await seek(Math.min(t + 0.07, t1 - 0.01)); const d2 = grab();
        measure(d1, d2, 0.07, t, th, ppl); fails = 0;
      } catch (e) { if (++fails >= 3) break; }
    }
  };

  let mode = 'playback';
  try { await playback(); }
  catch (e) {
    if (e.message === 'Cancelled') throw e;
    console.warn('playback sampling failed (' + e.message + '), falling back to seeking');
    mode = 'seek';
    const from = out.length ? out[out.length - 1].t + step : t0 + step / 2;
    try { await seekMode(from); } catch (e2) { if (e2.message === 'Cancelled') throw e2; }
  }
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
  // shake = erratic camera motion (deviation from neighbours) expressed as displacement over a typical
  // frame-pair gap, so it doesn't depend on playback speed / dropped frames
  const dts = out.map(s => s.dt).filter(Boolean);
  const dtNom = clamp(median(dts) || 0.1, 0.03, 0.3);
  for (let i = 0; i < out.length; i++) {
    const s = out[i];
    if (s.vx == null) { s.speed = 0; s.shake = 0; continue; }
    const nb = [out[i - 1], out[i + 1]].filter(x => x && x.vx != null);
    const mx = nb.length ? nb.reduce((a, x) => a + x.vx, 0) / nb.length : s.vx;
    const my = nb.length ? nb.reduce((a, x) => a + x.vy, 0) / nb.length : s.vy;
    s.speed = Math.hypot(s.vx, s.vy);
    s.shake = Math.max(Math.hypot(s.vx - mx, s.vy - my), s.speed * 0.5) * dtNom;
  }
  assignTargets(out);
  for (const s of out) { const f = framingScore(s); if (f != null) s.fq = f; }
  return { samples: out, step, mode, pose: !!pose };
}

const STRICT = {
  loose:  { blur: 0.22, blurAbs: 6,  dark: 0.07, blown: 0.93, shake: 0.07, still: 0.0015, minKeep: 0.8, dup: 0.018 },
  normal: { blur: 0.35, blurAbs: 10, dark: 0.11, blown: 0.88, shake: 0.045, still: 0.0025, minKeep: 1.0, dup: 0.03 },
  strict: { blur: 0.5,  blurAbs: 16, dark: 0.16, blown: 0.82, shake: 0.03, still: 0.004,  minKeep: 1.4, dup: 0.045 },
};

/** Flag bad samples. lapRef = reference sharpness (median of sharp-ish samples across ALL clips). */
function flagSamples(samples, lapRef, P, rescue = false) {
  // people detected in this clip at all? then a stretch (>= 1.5 s) with nobody in frame is a bad shot
  const withPpl = samples.filter(s => s.ppl).length, anyone = samples.filter(s => s.ppl?.length).length;
  const pplOn = FRAMING && withPpl >= samples.length * 0.5 && anyone >= withPpl * 0.4;
  for (const s of samples) {
    const r = []; s.soft = false;
    if (s.lap < Math.max(P.blurAbs, lapRef * P.blur) && !(s.luma < (rescue ? P.dark * 1.6 : P.dark))) r.push('blurry'); // dim frames read soft
    // with shadow recovery on, dim footage is brightened instead of cut: only near-black frames count as too dark
    if (rescue) { if (s.luma < 0.035 || (s.dark > 0.92 && s.luma < 0.05)) r.push('too dark'); }
    else if (s.luma < P.dark || (s.dark > 0.75 && s.luma < P.dark * 1.8) || (s.luma < P.dark * 1.35 && s.sd < 0.08)) r.push('too dark');
    if (s.luma > P.blown || s.bright > 0.55) r.push('blown out');
    if (s.shake > P.shake) r.push('shaky');
    s.bad = r;
  }
  if (pplOn) {
    let i = 0;
    while (i < samples.length) {
      if (samples[i].ppl && !samples[i].ppl.length) {
        let j = i; while (j + 1 < samples.length && samples[j + 1].ppl && !samples[j + 1].ppl.length) j++;
        if (samples[j].t - samples[i].t >= 1.4) for (let k = i; k <= j; k++) samples[k].bad.push('nobody in frame');
        i = j + 1;
      } else i++;
    }
  }
  // a moderately shaky sample between two shaky ones is part of the same shaky stretch
  samples.forEach((s, i) => {
    const a = samples[i - 1], b = samples[i + 1];
    if (a && b && !s.bad.includes('shaky') && s.shake > P.shake * 0.5 && a.bad.includes('shaky') && b.bad.includes('shaky')) s.bad.push('shaky');
  });
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
// "Keep her in frame": when people were detected, shots that show her well score higher (and multi-cam prefers them)
let FRAMING = true;
export const setFraming = (v) => { FRAMING = !!v; };
export function quality(s, lapRef) {
  const q = qualityBase(s, lapRef);
  return FRAMING && s.fq != null ? +(q * 0.8 + s.fq * 0.25).toFixed(3) : q;
}
function qualityBase(s, lapRef) {
  const sharp = clamp(s.lap / Math.max(1, lapRef), 0, 1.5);
  const expo = 1 - clamp(Math.abs(s.luma - 0.47) / 0.47, 0, 1);
  const steady = 1 - clamp(s.shake / 0.07, 0, 1);
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
    if (!it.samples.length) { // couldn't read frames (e.g. decoder busy) - keep the whole clip rather than drop it
      if (settings.skip?.has(it.mediaId)) continue;
      keep.push({ mediaId: it.mediaId, name: it.name, in: it.in, out: it.out, dur: it.dur, w: it.w, h: it.h, score: 0.5, order: it.order, capture: it.capture, sig: new Float32Array(144).fill(-9), samples: [], thumb: '' });
      continue;
    }
    // blur reference = geometric mean of the global and this clip's sharpness, so a clip that is simply less
    // detailed (plain walls, soft light) isn't called blurry, but a clip much softer than the rest still is
    const clipLap = pct(it.samples.filter(s => s.luma > 0.12 && s.luma < 0.88).map(s => s.lap), 0.7) || lapRef;
    flagSamples(it.samples, Math.sqrt(lapRef * clipLap), P, settings.shadows !== false);
    if (settings.skip?.has(it.mediaId)) continue; // multi-cam clips: flagged here, cut by the multi-cam planner
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
    runs.forEach((r, i) => {
      if (r.bad) return;
      const len = r.end - r.start, sandwiched = runs[i - 1]?.bad && runs[i + 1]?.bad;
      if (len < P.minKeep || (sandwiched && len < P.minKeep * 1.6)) { r.bad = true; r.short = true; }
    });
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
    const twin = k.samples.length ? kept.find(o => o.samples.length && sigDiff(o.sig, k.sig) < P.dup) : null;
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
  if (settings.shadows !== false) {
    // shadow fraction = share of pixels darker than 20 % luma (older cached analyses: estimated from very-dark share)
    const F = ss.reduce((a, s) => a + (s.shad ?? clamp(s.dark * 1.6 + (0.35 - s.luma), 0, 1)), 0) / Math.max(1, ss.length);
    const k = clamp((F - 0.2) / 0.5, 0, 0.85) * (L < 0.6 ? 1 : 0.6);
    e.shadowFrac = +F.toFixed(3);
    if (k >= 0.08) {
      e.shadow = +k.toFixed(2);
      // the lift does the brightening in the darks: keep the global boost small so highlights don't clip,
      // and soften extra contrast (it would push the lifted shadows back down)
      e.b = Math.min(e.b, 0.12);
      if (e.c > 1) e.c = +(1 + (e.c - 1) * (1 - 0.6 * e.shadow)).toFixed(2);
    }
  }
  return e;
}

// ---------- Dynamic camera ----------
// zMed/zClose/zPunch are crop factors (1.4 = 1/1.4 of the frame), push = relative zoom change over a shot.
export const LEVELS = {
  1: { zMed: 1.22, zClose: 1.45, zPunch: 1.6, push: 0.16, pan: 0.05, split: 4.5, ks: 0.16, roll: 2.5 },
  2: { zMed: 1.4, zClose: 1.7, zPunch: 1.9, push: 0.25, pan: 0.08, split: 3, ks: 0.26, roll: 4 },
  3: { zMed: 1.55, zClose: 1.9, zPunch: 2.2, push: 0.32, pan: 0.1, split: 2.2, ks: 0.32, roll: 6 },
};
export function subjectOf(samples, a, b) {
  if (!samples?.length) return { cx: 0.5, cy: 0.5 };
  const pick = (t0, t1) => { const ss = samples.filter(s => s.t >= t0 - 0.01 && s.t <= t1 + 0.01); return ss.length ? ss : samples; };
  // outlier-robust (median), only lightly pulled toward the centre when detection is unsure
  const at = (ss) => {
    const cx = median(ss.map(s => s.cx)), cy = median(ss.map(s => s.cy)), conf = median(ss.map(s => s.conf || 0));
    const k = 0.75 + 0.25 * conf;
    return [0.5 + (cx - 0.5) * k, 0.5 + (cy - 0.5) * k];
  };
  const mid = (a + b) / 2, [cx, cy] = at(pick(a, mid)), [cx1, cy1] = at(pick(mid, b));
  // smooth: move at most a little across one shot
  return { cx, cy, cx1: cx + clamp(cx1 - cx, -0.08, 0.08), cy1: cy + clamp(cy1 - cy, -0.08, 0.08) };
}
// focus track [{t,x,y}] (media time) -> point at t
export function trackAt(track, t) {
  if (!track?.length) return null;
  if (t <= track[0].t) return track[0];
  for (let i = 1; i < track.length; i++) if (track[i].t >= t) {
    const a = track[i - 1], b = track[i], f = (t - a.t) / Math.max(1e-3, b.t - a.t);
    return { t, x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
  }
  return track[track.length - 1];
}
export function subjectFromFocus(focus, a, b) {
  if (!focus) return null;
  const p = trackAt(focus.track, a) || focus, q = trackAt(focus.track, b) || focus;
  return { cx: p.x, cy: p.y, cx1: q.x, cy1: q.y, focus: true };
}
// clamp centre so the crop window stays inside the frame
export function clampCenter(cx, cy, z) { const m = 0.5 / z; return [clamp(cx, m, 1 - m), clamp(cy, m, 1 - m)]; }

const TIGHT = new Set(['punch', 'close']);
/**
 * Split shots longer than ~3 s into 2-3 angles and give every shot an obvious framing/move, like multi-cam coverage.
 * opts: { xfade, subjFn(shot, a, b) -> subject|null, altAngle }
 * Angles of one continuous shot overlap by the crossfade length, so the dissolve blends the SAME moment from two
 * framings (motion-matched), and split points are moved to the calmest nearby moment.
 */
export function planCamera(shots, level, opts = {}) {
  const L = LEVELS[level] || LEVELS[2];
  const X = opts.xfade || 0;
  const out = [];
  for (const s of shots) {
    const len = s.out - s.in;
    if (len > L.split && !s.boom && !s.mc) { // real multi-cam segments are already short angle changes
      const parts = len >= L.split * 2.2 ? 3 : 2;
      const cuts = [];
      for (let p = 1; p < parts; p++) {
        let tc = s.in + len * p / parts;
        // motion-matched: pick the calmest sample (least change) within ±0.6 s
        const near = (s.samples || []).filter(x => Math.abs(x.t - tc) <= 0.6 && x.still != null);
        if (near.length) tc = near.reduce((m, x) => (x.still < m.still ? x : m)).t;
        cuts.push(r2(tc));
      }
      let a = s.in;
      cuts.concat([s.out]).forEach((b, p) => {
        const inn = p === 0 ? a : Math.max(s.in, r2(a - X)); // overlap = crossfade length
        out.push({ ...s, in: inn, out: b, angle: p });
        a = b;
      });
    } else out.push({ ...s, angle: 0 });
  }
  // framing sequence: mostly medium/close moves; wide at most 1 in 10 here (spec: <= 1 in 5)
  const seq = ['push', 'punch', 'pan', 'close', 'pull', 'medium', 'tilt', 'punch', 'wide', 'close'];
  let k = 0, prev = null, n = 0, nAng = 0, nLow = 0, prevFish = false;
  const fishK = +opts.fish || 0;
  for (const s of out) {
    let type = s.camType || seq[k++ % seq.length];
    // alternate tight / loose on every cut, never repeat
    if (!s.camType && prev && (type === prev || TIGHT.has(type) === TIGHT.has(prev))) {
      const want = !TIGHT.has(prev);
      for (let j = 0; j < seq.length; j++) { const t2 = seq[(k + j) % seq.length]; if (TIGHT.has(t2) === want && t2 !== prev && t2 !== 'wide') { type = t2; break; } }
    }
    prev = type;
    const subj = (opts.subjFn && opts.subjFn(s, s.in, s.out)) || subjectOf(s.samples || [], s.in, s.out);
    const flip = s.flipAngle ?? (!!opts.altAngle && type !== 'wide' && n % 4 === 3);
    // camera height: every 3rd shot is seen from above or below (alternating); replays ask for one explicitly
    const look = {};
    let ang = s.wantAngle ?? (opts.angles && type !== 'wide' && n % 3 === 1 ? (nAng++ % 2 === 0 ? 'high' : 'low') : null);
    if (ang === 'none') ang = null;
    if (ang && (opts.angles !== false || s.wantAngle)) { look.angle = ang; look.ks = L.ks; if (opts.dutch && (ang === 'low' || nAng % 3 === 0)) look.roll = (n % 2 ? -1 : 1) * L.roll; }
    // fisheye: on every other low angle and now and then on a close / punch, never twice in a row
    if (fishK > 0 && type !== 'wide' && !prevFish && (s.wantFish || (ang === 'low' && nLow++ % 2 === 0) || (!ang && (type === 'close' || type === 'punch') && n % 5 === 3))) look.fish = fishK;
    prevFish = !!look.fish;
    s.cam = camFor(type, subj, L, flip, look);
    if (opts.fit && s.cam) s.cam = opts.fit(s, s.cam);
    delete s.wantAngle; delete s.wantFish; delete s.flipAngle; delete s.camType;
    n++;
  }
  return out;
}
/** look = { angle: 'high'|'low', ks, roll, fish } (optional) */
export function camFor(type, subj, L, flip = false, look = {}) {
  const cx = subj.cx, cy = subj.cy, cx1 = subj.cx1 ?? cx, cy1 = subj.cy1 ?? cy;
  const ang = look?.angle;
  // seen from above the camera tilts down through the shot; from below it tilts up
  const tdy = ang === 'high' ? L.pan * 0.5 : ang === 'low' ? -L.pan * 0.5 : 0;
  const mk = (z0, z1, x0, y0, x1, y1) => {
    if (ang || look?.fish) { z0 = Math.max(1.15, z0); z1 = Math.max(1.15, z1); }
    const [a, b] = clampCenter(x0, y0 - tdy, z0), [c, d] = clampCenter(x1, y1 + tdy, z1);
    const o = { type, z0: +z0.toFixed(3), z1: +z1.toFixed(3), x0: +a.toFixed(3), y0: +b.toFixed(3), x1: +c.toFixed(3), y1: +d.toFixed(3) };
    if (flip) o.flip = true;
    if (ang) { o.angle = ang; o.ks = +(look.ks || L.ks || 0.18).toFixed(3); }
    if (look?.roll) o.roll = +look.roll.toFixed(2);
    if (look?.fish) o.fish = +look.fish.toFixed(3);
    return o;
  };
  const mx = (cx + cx1) / 2, my = (cy + cy1) / 2;
  switch (type) {
    case 'wide': return mk(1.0, 1.12, 0.5, 0.5, 0.5 + (mx - 0.5) * 0.5, 0.5 + (my - 0.5) * 0.5); // even wides creep in
    case 'medium': return mk(L.zMed, L.zMed * 1.08, cx, cy, cx1, cy1);
    case 'close': return mk(L.zClose, L.zClose * 1.06, cx, cy, cx1, cy1);
    case 'punch': return mk(L.zPunch, L.zPunch * 1.04, cx, cy, cx1, cy1);
    case 'push': { const z0 = Math.max(1.05, L.zMed * 0.85); return mk(z0, z0 * (1 + L.push + 0.1), (0.5 + cx) / 2, (0.5 + cy) / 2, cx1, cy1); }
    case 'pull': { const z1 = Math.max(1.05, L.zMed * 0.85); return mk(z1 * (1 + L.push + 0.1), z1, cx, cy, (0.5 + cx1) / 2, (0.5 + cy1) / 2); }
    case 'pan': { const z = L.zMed * 1.05, dir = mx < 0.5 ? 1 : -1; return mk(z, z, cx - dir * L.pan, cy, cx1 + dir * L.pan, cy1); }
    case 'tilt': { const z = L.zMed * 1.05; return mk(z, z, cx, cy + L.pan, cx1, cy1 - L.pan); }
  }
  return null;
}
export const lookOf = (cam) => cam ? { angle: cam.angle, ks: cam.ks, roll: cam.roll, fish: cam.fish } : {};
export const CAM_TYPES = ['wide', 'medium', 'close', 'punch', 'push', 'pull', 'pan', 'tilt'];

// ---------- focus tracking (tap a point, follow it through the clip) ----------
// Template matching on 160-px grey frames sampled by fast playback; positions are smoothed.
function grayPatch(g, W, x, y, s) {
  const o = new Float32Array(s * s); let m = 0;
  for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) { const v = g[(y + j) * W + x + i]; o[j * s + i] = v; m += v; }
  m /= s * s; let sd = 0; for (let i = 0; i < o.length; i++) { o[i] -= m; sd += o[i] * o[i]; }
  return { p: o, sd: Math.sqrt(sd / o.length) };
}
function matchAt(g, W, x, y, T, s) {
  let m = 0; for (let j = 0; j < s; j++) for (let i = 0; i < s; i++) m += g[(y + j) * W + x + i];
  m /= s * s; let e = 0;
  for (let j = 0; j < s; j += 1) for (let i = 0; i < s; i += 1) e += Math.abs(g[(y + j) * W + x + i] - m - T[j * s + i]);
  return e / (s * s);
}
export function makeTemplate(gray, W, H, nx, ny) {
  const s = Math.round(W * 0.16); // patch ~16% of width
  const x = clamp(Math.round(nx * W - s / 2), 0, W - s), y = clamp(Math.round(ny * H - s / 2), 0, H - s);
  const t = grayPatch(gray, W, x, y, s);
  return { T: t.p, sd: t.sd, s, W, H, x, y };
}
export function grayOf(img, W, H) { return toGray(img, W * H); }
export async function trackPoint(url, t0, t1, tpl, { signal, onTick, step = 0.25, rate = 8 } = {}) {
  const v = analysisVideo();
  await setSrc(v, url);
  const { W, H, s, T, sd } = tpl;
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  let px = tpl.x, py = tpl.y, first = true;
  const pts = [];
  const onFrame = (mt) => {
    ctx.drawImage(v, 0, 0, W, H);
    const g = toGray(ctx.getImageData(0, 0, W, H).data, W * H);
    let best = Infinity, bx = px, by = py;
    const R = first ? Math.max(W, H) : Math.round(W * 0.1), st = first ? 2 : 1;
    for (let y = Math.max(0, py - R); y <= Math.min(H - s, py + R); y += st)
      for (let x = Math.max(0, px - R); x <= Math.min(W - s, px + R); x += st) {
        const e = matchAt(g, W, x, y, T, s); if (e < best) { best = e; bx = x; by = y; }
      }
    const ok = best < Math.max(6, sd * 0.9);
    if (ok || first) { px = bx; py = by; }
    first = false;
    pts.push({ t: r2(mt), x: (px + s / 2) / W, y: (py + s / 2) / H, ok });
    onTick && onTick(clamp((mt - t0) / Math.max(0.1, t1 - t0), 0, 1));
  };
  await playFrames(v, t0, t1, step, onFrame, signal, rate);
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch {}
  if (!pts.length) return [];
  // smooth: forward + backward exponential average (no jitter, no lag)
  const sm = (k) => { const a = pts.map(p => p[k]); for (let i = 1; i < a.length; i++) a[i] = a[i - 1] + (a[i] - a[i - 1]) * 0.4; for (let i = a.length - 2; i >= 0; i--) a[i] = a[i + 1] + (a[i] - a[i + 1]) * 0.4; return a; };
  const xs = sm('x'), ys = sm('y');
  return pts.map((p, i) => ({ t: p.t, x: +xs[i].toFixed(3), y: +ys[i].toFixed(3) }));
}
// generic single-frame sampler: fast playback + rVFC, falls back to seeking; never hangs
async function playFrames(v, t0, t1, step, onFrame, signal, rate = 8) {
  let last = -1, next = t0;
  const ok = await new Promise((resolve) => {
    let done = false, lastProg = performance.now();
    const finish = (r) => { if (done) return; done = true; clearInterval(wd); v.removeEventListener('ended', onEnd); try { v.pause(); v.playbackRate = 1; } catch {} resolve(r); };
    const handle = (mt) => {
      if (done) return; if (signal?.aborted) return finish(true);
      if (mt <= last + 1e-4) return; last = mt; lastProg = performance.now();
      if (mt >= next && mt <= t1) { try { onFrame(mt); } catch (e) { return finish(false); } while (next <= mt) next += step; }
      if (mt >= t1 - 0.03) finish(true);
    };
    const onEnd = () => finish(true);
    v.addEventListener('ended', onEnd);
    if ('requestVideoFrameCallback' in v) { const cb = (n, md) => { handle(md.mediaTime); if (!done) v.requestVideoFrameCallback(cb); }; v.requestVideoFrameCallback(cb); }
    else { const raf = () => { if (done) return; if (v.readyState >= 2) handle(v.currentTime); requestAnimationFrame(raf); }; requestAnimationFrame(raf); }
    const wd = setInterval(() => { if (performance.now() - lastProg > 2500) finish(false); }, 250);
    try { if (t0 > 0.05) v.currentTime = t0; } catch {}
    v.playbackRate = rate;
    const pp = v.play(); if (pp) pp.catch(() => finish(false));
  });
  if (ok || signal?.aborted) return;
  let fails = 0;
  for (let t = Math.max(next, t0); t <= t1; t += step) {
    if (signal?.aborted) return;
    try { const p = waitEv(v, 'seeked', 1500); v.currentTime = t; await p; onFrame(t); fails = 0; } catch { if (++fails >= 3) return; }
  }
}

export function parseXf(v) { v = String(v ?? '0'); return { xfade: parseFloat(v.replace('b', '')) || 0, xfadeType: v.startsWith('b') ? 'black' : 'fade' }; }
export const xfValue = (proj) => !proj.xfade ? '0' : (proj.xfadeType === 'black' ? 'b' : '') + proj.xfade;

// ---------------- Extend: make the edit longer using only the existing footage ----------------
// Three tools, all from the real clips (no generated frames):
//  slow  - the sharpest / steadiest stretch of a shot is played in slow motion (frames interpolated at export)
//  boom  - a best moment is played forward then backward (boomerang) as an extra shot
//  replay - a best moment is shown again later from another "camera": above / below / mirrored / fisheye
export function parseExtend(v) {
  v = String(v || '0');
  if (v.startsWith('x')) return { mul: +v.slice(1) || 1 };
  if (v.startsWith('t')) return { target: +v.slice(1) || 0 };
  return null;
}
export function editLength(shots, X) {
  const d = shots.map(s => (s.out - s.in) / (s.speed || 1) * (s.boom ? 2 : 1));
  let t = d.reduce((a, b) => a + b, 0);
  for (let j = 0; j < d.length - 1; j++) { const x = Math.min(X || 0, d[j] / 3, d[j + 1] / 3); if (x >= 0.1) t -= x; }
  return t;
}
export function extendShots(shots, setting, { xfade = 0, lapRef = 50 } = {}) {
  const ex = parseExtend(setting);
  const base = editLength(shots, xfade);
  if (!ex || !shots.length) return { shots, base, length: base, target: base, ops: [] };
  const target = ex.mul ? base * ex.mul : Math.max(base, ex.target);
  let out = shots.map(s => ({ ...s }));
  const used = new Map(); // mediaId -> [[a,b]] windows already slowed / reused
  let reuse = false; // once fresh footage runs out, best moments may be shown again (penalised so they rotate)
  const overlaps = (s, a, b) => (used.get(s.mediaId) || []).filter(([x, y]) => a < y - 0.05 && b > x + 0.05).length;
  const free = (s, a, b) => reuse || !overlaps(s, a, b);
  const mark = (s, a, b) => { if (!used.has(s.mediaId)) used.set(s.mediaId, []); used.get(s.mediaId).push([a, b]); };
  // best free window of length w inside a (non-extended) shot: mean quality, bad samples excluded
  const best = (w) => {
    let top = null;
    for (const s of out) {
      if (s.boom || s.replay || s.out - s.in < w + 0.05) continue;
      const ss = (s.samples || []).filter(x => x.t >= s.in && x.t <= s.out);
      for (let a = s.in; a + w <= s.out + 1e-6; a += 0.25) {
        const b = a + w;
        if (!free(s, a, b)) continue;
        const win = ss.filter(x => x.t >= a - 0.1 && x.t <= b + 0.1);
        let sc = win.length ? win.reduce((m, x) => m + (x.bad?.length && !x.soft ? -1 : quality(x, lapRef)), 0) / win.length : (s.score || 0.4);
        if (reuse) sc -= 0.25 * overlaps(s, a, b);
        if (!top || sc > top.sc) top = { s, a: r2(a), b: r2(b), sc };
      }
    }
    return top;
  };
  const ops = [];
  const kinds = ['slow', 'boom', 'replay'];
  // where to put an extra shot: from position p on, the first gap whose neighbours aren't extra shots themselves
  const place = (p) => {
    for (let q = p; q <= out.length; q++) if (!out[q - 1]?.extra && !out[q]?.extra) return q;
    for (let q = p; q <= out.length; q++) if (out[q - 1]?.ext !== out[q]?.ext || !out[q - 1]?.extra) return q; // at least not two of a kind
    return Math.min(p, out.length);
  };
  let angleFlip = 0;
  for (let it = 0; it < 40; it++) {
    const len = editLength(out, xfade), need = target - len;
    if (need < 0.3) break;
    let done = false;
    for (let tries = 0; tries < 3 && !done; tries++) {
      const kind = kinds[(it + tries) % 3];
      if (kind === 'slow') {
        if (reuse) continue; // slowing the same stretch twice adds nothing
        const w = clamp(need, 1, 2.4), c = best(w); if (!c) continue;
        // slow the window in place: [in,a] normal, [a,b] at half speed, [b,out] normal (tiny leftovers are absorbed)
        const s = c.s, i = out.indexOf(s);
        let a = c.a, b = c.b; if (a - s.in < 0.8) a = s.in; if (s.out - b < 0.8) b = s.out;
        const parts = [];
        // overlaps so each crossfade blends the same moment (outgoing normal speed, incoming slow, and back)
        if (a > s.in) parts.push({ ...s, out: a });
        parts.push({ ...s, in: a > s.in ? r2(Math.max(s.in, a - xfade)) : a, out: b, speed: 0.5, ext: 'slow' });
        if (b < s.out) parts.push({ ...s, in: r2(Math.max(s.in, b - xfade / 2)) });
        out.splice(i, 1, ...parts); mark(s, a, b); ops.push({ kind, name: s.name, in: a, out: b, adds: +(b - a).toFixed(2) });
        done = true;
      } else if (kind === 'boom') {
        const f = clamp((need + xfade) / 2, 0.6, 1.2), c = best(f); if (!c) continue;
        const i = out.indexOf(c.s);
        out.splice(place(i + 1), 0, { ...c.s, in: c.a, out: c.b, speed: 0, boom: true, ext: 'boom', extra: true, score: c.sc });
        mark(c.s, c.a, c.b); ops.push({ kind, name: c.s.name, in: c.a, out: c.b, adds: +(2 * (c.b - c.a) - xfade).toFixed(2) });
        done = true;
      } else {
        const w = clamp(need + xfade, 1.5, 3), c = best(w); if (!c) continue;
        const i = out.indexOf(c.s), at = place(Math.min(out.length, i + 3));
        const k = angleFlip++;
        out.splice(at, 0, { ...c.s, in: c.a, out: c.b, speed: 0, replay: true, ext: 'replay', extra: true, score: c.sc,
          wantAngle: k % 2 ? 'low' : 'high', flipAngle: k % 2 === 0, wantFish: k % 3 === 1, camType: k % 2 ? 'close' : 'medium' });
        mark(c.s, c.a, c.b); ops.push({ kind, name: c.s.name, in: c.a, out: c.b, adds: +(c.b - c.a - xfade).toFixed(2) });
        done = true;
      }
    }
    if (!done) { if (reuse) break; reuse = true; } // no fresh footage left: allow reuse once, then stop
  }
  out.forEach(s => delete s.extra);
  return { shots: out, base, length: editLength(out, xfade), target, ops };
}
