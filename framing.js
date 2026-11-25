// Subject-aware framing ("Keep her in frame").
// Per analysed frame: people (MediaPipe Pose Landmarker, client-side; up to 2 people) + the action area
// (motion energy + skin, always computed, and the fallback when the model can't load). Per moment a
// PROTECTED REGION = target person (the one picked with Set focus, else the one whose motion dominates)
// ∪ action area ∪ contact zone (where the two bodies meet, incl. the other person's face/mouth near her).
// Every virtual camera move is then fitted so that region stays inside the visible output with a margin,
// measured through the real crop -> keystone/tilt -> fisheye mapping (render.js outToCrop/cropToOut).
import { cropToOut, camAt } from './render.js';

const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const TIGHTNESS = { loose: { margin: 0.12, zoomK: 0.6 }, balanced: { margin: 0.08, zoomK: 1 }, tight: { margin: 0.05, zoomK: 1 } };

// ---------------- pose model (lazy, optional) ----------------
let posePromise = null, poseFail = null;
const base = () => new URL('vendor/mediapipe/', location.href).href;
export function loadPose(timeoutMs = 15000) {
  if (globalThis.__noPose) return Promise.resolve(null);
  if (!posePromise) {
    posePromise = (async () => {
      const { PoseLandmarker } = await import('./vendor/mediapipe/vision_bundle.mjs');
      const fileset = { wasmLoaderPath: base() + 'vision_wasm_internal.js', wasmBinaryPath: base() + 'vision_wasm_internal.wasm' };
      return await PoseLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: base() + 'pose_landmarker_lite.task', delegate: 'CPU' },
        runningMode: 'IMAGE', numPoses: 2, minPoseDetectionConfidence: 0.35, minPosePresenceConfidence: 0.35, minTrackingConfidence: 0.35,
      });
    })().catch(e => { poseFail = e?.message || String(e); console.warn('[framing] pose model unavailable, using motion + skin', e); return null; });
  }
  return Promise.race([posePromise, new Promise(r => setTimeout(() => r(null), timeoutMs))]);
}
export const poseStatus = () => (poseFail ? 'fallback: ' + poseFail : posePromise ? 'pose' : 'not loaded');
/** people in a frame (canvas/ImageData): [{ box:[x0,y0,x1,y1], face:[...]|null, score }] in 0..1 frame coords */
export function detectPeople(pl, img) {
  if (!pl) return null;
  let r; try { r = pl.detect(img); } catch (e) { return null; }
  return (r.landmarks || []).map((lm) => {
    const vis = lm.filter(p => (p.visibility ?? 1) > 0.3 && p.x > -0.1 && p.x < 1.1 && p.y > -0.1 && p.y < 1.1);
    if (vis.length < 4) return null;
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (const p of vis) { x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y); }
    // joints are inside the body: pad for flesh/hair/hands/feet (more on top for the head)
    const w = x1 - x0, h = y1 - y0, pw = Math.max(0.03, w * 0.12), ph = Math.max(0.03, h * 0.08);
    const f = lm.slice(0, 11).filter(p => (p.visibility ?? 1) > 0.3);
    let face = null;
    if (f.length >= 3) {
      let a = 1, b = 1, c = 0, d = 0; for (const p of f) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); }
      const s = Math.max(c - a, d - b, 0.03); face = [a - s * 0.5, b - s * 0.8, c + s * 0.5, d + s * 0.6].map(v => clamp(v, 0, 1));
    }
    const box = [x0 - pw, y0 - ph * 2, x1 + pw, y1 + ph].map(v => clamp(v, 0, 1));
    if (face) { box[0] = Math.min(box[0], face[0]); box[1] = Math.min(box[1], face[1]); box[2] = Math.max(box[2], face[2]); box[3] = Math.max(box[3], face[3]); }
    // upper body (landmarks 0-12: face + shoulders, extended to mid-chest) and lower body (23-26: hips + knees)
    const V = (i) => { const p = lm[i]; return p && (p.visibility ?? 1) > 0.3 && p.x > -0.2 && p.x < 1.2 && p.y > -0.2 && p.y < 1.2 ? p : null; };
    const bb = (idx) => { const q = idx.map(V).filter(Boolean); if (q.length < 2) return null; let a = 1, b = 1, c = 0, d = 0; for (const p of q) { a = Math.min(a, p.x); b = Math.min(b, p.y); c = Math.max(c, p.x); d = Math.max(d, p.y); } return [a, b, c, d]; };
    const hipY = [V(23), V(24)].filter(Boolean).map(p => p.y), shY = [V(11), V(12)].filter(Boolean).map(p => p.y);
    let up = bb([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    if (up) {
      const w = up[2] - up[0], shy = shY.length ? Math.max(...shY) : up[3], hy = hipY.length ? Math.min(...hipY) : null;
      up = [up[0] - Math.max(0.025, w * 0.2), face ? Math.min(face[1], up[1]) : up[1] - 0.05, up[2] + Math.max(0.025, w * 0.2), hy != null ? shy + (hy - shy) * 0.45 : shy + 0.08];
    }
    let lo = bb([23, 24, 25, 26]);
    if (lo) {
      const w = lo[2] - lo[0], hy = Math.min(...(hipY.length ? hipY : [lo[1]])), knees = [V(25), V(26)].some(Boolean);
      lo = [lo[0] - Math.max(0.04, w * 0.35), hy - 0.05, lo[2] + Math.max(0.04, w * 0.35), knees ? lo[3] + 0.05 : hy + 0.22];
    }
    const r3 = (b) => b && b.map(v => +clamp(v, 0, 1).toFixed(3));
    return { box: box.map(v => +v.toFixed(3)), face: face && face.map(v => +v.toFixed(3)), up: r3(up), lo: r3(lo), full: !!(face && hipY.length), kn: !!(lo && [V(25), V(26)].some(Boolean)), an: [V(27), V(28)].some(Boolean), score: +(vis.length / lm.length).toFixed(2) };
  }).filter(Boolean);
}

/** detectPeople, plus a second look at the left / right part of the frame when only one person was found
 * (the detector often returns one box for two overlapping bodies, e.g. kneeling in front of a standing person) */
let cropCv = null;
function addSigs(a, cv) {
  // appearance signature per person: mean colour of the upper and the lower half of the body box
  try {
    const W = cv.width, H = cv.height, d = cv.getContext('2d').getImageData(0, 0, W, H).data;
    for (const p of a) {
      const b = p.box, sig = [];
      for (const [y0, y1] of [[b[1], (b[1] + b[3]) / 2], [(b[1] + b[3]) / 2, b[3]]]) {
        let r = 0, g = 0, bl = 0, n = 0;
        const xa = Math.floor((b[0] + (b[2] - b[0]) * 0.25) * W), xb = Math.ceil((b[2] - (b[2] - b[0]) * 0.25) * W);
        for (let y = Math.floor(y0 * H); y < Math.min(H, Math.ceil(y1 * H)); y += 2) for (let x = Math.max(0, xa); x < Math.min(W, xb); x += 2) { const k = (y * W + x) * 4; r += d[k]; g += d[k + 1]; bl += d[k + 2]; n++; }
        sig.push(n ? +(r / n / 255).toFixed(3) : 0, n ? +(g / n / 255).toFixed(3) : 0, n ? +(bl / n / 255).toFixed(3) : 0);
      }
      p.sig = sig;
    }
  } catch { /* tainted / no canvas */ }
  return a;
}
export function detectPeopleMulti(pl, cv) {
  const a = detectPeople(pl, cv); if (!a) return a;
  if (a.length !== 1 || typeof document === 'undefined') return addSigs(a, cv);
  const A = a[0].box, cx = (A[0] + A[2]) / 2, W = cv.width, H = cv.height;
  cropCv ||= document.createElement('canvas');
  // left part, right part, then the lower 60 % (kneeling / bent-over / lying bodies)
  for (const [x0, x1, y0] of [[0, Math.min(1, cx + 0.05), 0], [Math.max(0, cx - 0.05), 1, 0], [0, 1, 0.4]]) {
    if (x1 - x0 < 0.25) continue;
    const sw = Math.round((x1 - x0) * W), sh = Math.round((1 - y0) * H); cropCv.width = sw; cropCv.height = sh;
    cropCv.getContext('2d').drawImage(cv, x0 * W, y0 * H, sw, sh, 0, 0, sw, sh);
    const r = detectPeople(pl, cropCv) || [];
    const mapB = (b) => b && [x0 + b[0] * (x1 - x0), y0 + b[1] * (1 - y0), x0 + b[2] * (x1 - x0), y0 + b[3] * (1 - y0)].map(v => +v.toFixed(3));
    for (const p of r) {
      const q = { ...p, box: mapB(p.box), face: mapB(p.face), up: mapB(p.up), lo: mapB(p.lo), second: true };
      const i = area(inter(q.box, A)) / Math.max(1e-6, Math.min(area(q.box), area(A)));
      const fd = q.face && a[0].face ? Math.hypot((q.face[0] + q.face[2] - a[0].face[0] - a[0].face[2]) / 2, (q.face[1] + q.face[3] - a[0].face[1] - a[0].face[3]) / 2) : 1;
      // a plausible body: the face small next to the body and (unless lying down) in its top part
      const B = q.box, bw = B[2] - B[0], bh = B[3] - B[1], F = q.face;
      const fw0 = a[0].face ? a[0].face[2] - a[0].face[0] : 0; // two people in one shot have faces of a similar size
      const ok = (!F || !fw0 || (F[2] - F[0]) >= 0.6 * fw0) && (!F || (area(F) <= 0.2 * area(B) && (F[3] - F[1]) <= 0.45 * bh && (bw > bh || (F[1] - B[1]) <= 0.45 * bh)));
      const fin = F && inside({ x: (F[0] + F[2]) / 2, y: (F[1] + F[3]) / 2 }, A); // its face on the first body = a guess on her torso
      if (ok && fd > 0.06 && i < (fin ? 0.5 : 0.7) && area(q.box) > 0.01) { a.push(q); return addSigs(a, cv); }
    }
  }
  return addSigs(a, cv);
}

// ---------------- action area (motion + skin), from the analysis frame ----------------
/** weighted mass bounding box of moving / skin pixels. d = RGBA, g1/g2 grey of this and the next frame */
export function actionBox(d, g1, g2, w, h, sh) {
  const cols = new Float32Array(w), rows = new Float32Array(h), mc = new Float32Array(w), mr = new Float32Array(h);
  const GX = 16, GY = 9, grid = new Float32Array(GX * GY);
  const m = Math.max(Math.abs(sh.dx), Math.abs(sh.dy)) + 1;
  let tot = 0, mot = 0, mtot = 0;
  for (let y = m; y < h - m; y++) for (let x = m; x < w - m; x++) {
    const i = y * w + x, k = i * 4, r = d[k], gg = d[k + 1], b = d[k + 2];
    const mv = Math.abs(g1[i] - g2[(y + sh.dy) * w + x + sh.dx]) / 255;
    const skin = r > 95 && gg > 40 && b > 20 && r > gg && r > b && r - Math.min(gg, b) > 15 && Math.abs(r - gg) > 15 ? 1 : 0;
    const wt = (mv > 0.04 ? mv * 4 : 0) + skin * 0.6;
    cols[x] += wt; rows[y] += wt; tot += wt;
    if (mv > 0.04) { mot += mv; mc[x] += mv; mr[y] += mv; mtot += mv; grid[Math.min(GY - 1, (y * GY / h) | 0) * GX + Math.min(GX - 1, (x * GX / w) | 0)] += mv; }
  }
  if (tot < 1e-6) return null;
  const span = (arr, n, T = tot) => { // 6 % .. 94 % of the mass
    let acc = 0, a = 0, b = n - 1; const lo = T * 0.06, hi = T * 0.94;
    for (let i = 0; i < n; i++) { acc += arr[i]; if (acc < lo) a = i + 1; if (acc <= hi) b = i + 1; }
    return [a / n, Math.min(1, (b + 1) / n)];
  };
  const [x0, x1] = span(cols, w), [y0, y1] = span(rows, h);
  // motion-only box (used when people are detected: skin colour also matches beige walls / sheets)
  let mbox = null;
  if (mtot / (w * h) > 0.002) { const [a0, a1] = span(mc, w, mtot), [b0, b1] = span(mr, h, mtot); mbox = [a0, b0, a1, b1].map(v => +v.toFixed(3)); }
  const cell = (w * h) / (GX * GY), mg = Array.from(grid, v => +(v / cell).toFixed(3));
  return { box: [x0, y0, x1, y1].map(v => +v.toFixed(3)), mbox, mg, mot: +(mot / (w * h)).toFixed(4), mass: +(tot / (w * h)).toFixed(3) };
}

// ---------------- protected region ----------------
const area = (b) => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
const inter = (a, b) => [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.min(a[2], b[2]), Math.min(a[3], b[3])];
const union = (a, b) => (!a ? b : !b ? a : [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
const grow = (b, k) => { const w = (b[2] - b[0]) * k, h = (b[3] - b[1]) * k; return [b[0] - w, b[1] - h, b[2] + w, b[3] + h].map(v => clamp(v, 0, 1)); };
const inside = (p, b) => p && p.x >= b[0] && p.x <= b[2] && p.y >= b[1] && p.y <= b[3];
// motion inside a box from the 16x9 motion grid (partial cells weighted by overlap)
function gridMotion(mg, b) {
  if (!mg) return 0;
  const GX = 16, GY = 9; let m = 0;
  for (let j = 0; j < GY; j++) for (let i = 0; i < GX; i++) {
    const ov = Math.max(0, Math.min(b[2], (i + 1) / GX) - Math.max(b[0], i / GX)) * Math.max(0, Math.min(b[3], (j + 1) / GY) - Math.max(b[1], j / GY));
    if (ov > 0) m += mg[j * GX + i] * ov;
  }
  return m;
}
/**
 * Who is "her" across the whole video (no gender classifier): people are linked into tracks from sample to sample.
 * Whenever two or more people are in a frame, the one moving most (motion per body area) gets a "her" vote and the
 * others a "not her" vote; Set focus is a strong vote. Per sample s._tg = her box when we are confident, else null
 * (then the protected region keeps everyone + all the movement).
 */
const tgCache = new WeakMap();
export function assignTargets(samples, focusAt = () => null) {
  if (!samples?.length) return;
  const sig = samples.length + '|' + samples.slice(0, 40).map(s => { const f = focusAt(s.t); return f ? f.x.toFixed(2) + f.y.toFixed(2) : '-'; }).join('');
  if (tgCache.get(samples) === sig) return;
  tgCache.set(samples, sig);
  const ctr = (b) => [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const iou = (a, b) => { const i = area(inter(a, b)); return i / Math.max(1e-6, area(a) + area(b) - i); };
  const dens = (s, b) => (s.mg ? gridMotion(s.mg, b) : s.mb ? area(inter(b, s.mb)) * 0.05 : 0) / Math.max(1e-4, area(b));
  const tracks = [], ids = new Map();
  for (const s of samples) {
    const ppl = s.ppl || [], mine = new Array(ppl.length).fill(null);
    // link people to tracks by the globally best pairs (a small person inside a big one's old box must not steal his track)
    const pairs = [];
    ppl.forEach((p, i) => tracks.forEach(tr => { if (s.t - tr.lt > 3) return; const [ax, ay] = ctr(tr.last), [bx, by] = ctr(p.box); const d = Math.hypot(ax - bx, ay - by) + 0.5 * (1 - iou(tr.last, p.box)); if (d < 0.65) pairs.push({ i, tr, d }); }));
    pairs.sort((a, b) => a.d - b.d);
    const usedT = new Set();
    for (const { i, tr } of pairs) if (!mine[i] && !usedT.has(tr)) { mine[i] = tr; usedT.add(tr); }
    ppl.forEach((p, i) => {
      if (!mine[i]) { mine[i] = { id: tracks.length, her: 0, not: 0, last: p.box, lt: s.t }; tracks.push(mine[i]); }
      const best = mine[i]; best.last = p.box; best.lt = s.t;
      const f = focusAt(s.t); if (f && inside(f, p.box)) best.her += 50;
    });
    if (ppl.length >= 2) {
      const d = ppl.map(p => dens(s, p.box)), mx = Math.max(...d), k = d.indexOf(mx), second = Math.max(...d.filter((_, i) => i !== k));
      if (mx > 1e-4 && mx >= second * 1.25) mine.forEach((tr, i) => { if (i === k) tr.her++; else tr.not++; });
    }
    ids.set(s, mine);
  }
  // appearance identities: when two people were seen together, split all detections into 2 by colour signature
  const dets = []; for (const s of samples) for (const p of s.ppl || []) if (p.sig) dets.push({ s, p });
  const pair = samples.find(s => s.ppl?.length >= 2 && s.ppl[0].sig && s.ppl[1].sig);
  let cl = null;
  if (pair && dets.length >= 4) {
    const dist = (a, b) => a.reduce((t, v, i) => t + (v - b[i]) ** 2, 0);
    let C = [pair.ppl[0].sig.slice(), pair.ppl[1].sig.slice()];
    if (dist(C[0], C[1]) > 0.003) {
      cl = new Map();
      for (let it = 0; it < 8; it++) {
        for (const s of samples) {
          const ps = (s.ppl || []).filter(p => p.sig); if (!ps.length) continue;
          if (ps.length >= 2) { // two people in one frame are two different identities
            const a = dist(ps[0].sig, C[0]) + dist(ps[1].sig, C[1]), b = dist(ps[0].sig, C[1]) + dist(ps[1].sig, C[0]);
            cl.set(ps[0], a <= b ? 0 : 1); cl.set(ps[1], a <= b ? 1 : 0); for (const p of ps.slice(2)) cl.set(p, dist(p.sig, C[0]) <= dist(p.sig, C[1]) ? 0 : 1);
          } else cl.set(ps[0], dist(ps[0].sig, C[0]) <= dist(ps[0].sig, C[1]) ? 0 : 1);
        }
        C = [0, 1].map(k => { const m = dets.filter(x => cl.get(x.p) === k); return m.length ? m[0].p.sig.map((_, i) => m.reduce((t, x) => t + x.p.sig[i], 0) / m.length) : C[k]; });
      }
    }
  }
  if (cl) {
    // which identity is her: Set focus, else who moves more (motion per body area, overlap with the other removed)
    const vote = [0, 0];
    const exd = (s, b, o) => { const ov = o ? inter(b, o) : null, ao = ov && area(ov) > 0 ? area(ov) : 0; const m = (s.mg ? gridMotion(s.mg, b) - (ao ? gridMotion(s.mg, ov) : 0) : 0); return m / Math.max(1e-4, area(b) - ao); };
    for (const s of samples) {
      const ps = (s.ppl || []).filter(p => cl.has(p));
      const f = focusAt(s.t); for (const p of ps) if (f && inside(f, p.box)) vote[cl.get(p)] += 50;
      const a = ps.find(p => cl.get(p) === 0), b = ps.find(p => cl.get(p) === 1);
      if (a && b) { const da = exd(s, a.box, b.box), db = exd(s, b.box, a.box); if (Math.max(da, db) > 1e-4 && Math.max(da, db) >= Math.min(da, db) * 1.15) vote[da > db ? 0 : 1]++; }
    }
    const herK = vote[0] === vote[1] ? null : vote[0] > vote[1] ? 0 : 1;
    if (herK != null) {
      for (const s of samples) {
        const ps = (s.ppl || []);
        const her = ps.find(p => cl.get(p) === herK), him = ps.find(p => cl.has(p) && cl.get(p) !== herK);
        s._tg = her ? her.box : null; s._tgP = her || null; s._him = him || null;
      }
      // a lone detection that sits where he was in the neighbouring frames (and not where she was) is him
      const iou = (a, b) => { const i = area(inter(a, b)); return i / Math.max(1e-6, area(a) + area(b) - i); };
      for (let i = 0; i < samples.length; i++) {
        const s = samples[i]; if (!s._tg || s._him || (s.ppl || []).length !== 1) continue;
        const nb = [samples[i - 1], samples[i + 1]].filter(Boolean);
        const likeHim = nb.some(n => n._him && iou(n._him.box, s._tg) > 0.6), likeHer = nb.some(n => n._tg && n._him && iou(n._tg, s._tg) > 0.5);
        if (likeHim && !likeHer) { s._him = s.ppl[0]; s._tg = null; s._tgP = null; }
      }
      return;
    }
  }
  for (const s of samples) {
    const mine = ids.get(s) || [], ppl = s.ppl || [];
    let tg = null;
    if (mine.length) {
      const sc = mine.map(tr => (tr.her - tr.not) / (tr.her + tr.not + 1));
      const k = sc.indexOf(Math.max(...sc));
      if (sc[k] > 0.2) tg = ppl[k].box;
      else if (ppl.length === 1 && mine[0].not === 0) tg = ppl[0].box; // the only person in view, never seen as "the other one"
      else if (ppl.length >= 2) { // no history: the one moving most in this frame, if clear
        const d = ppl.map(p => dens(s, p.box)), mx = Math.max(...d), j = d.indexOf(mx);
        if (mx > 1e-4 && mx >= Math.max(...d.filter((_, i) => i !== j)) * 1.5) tg = ppl[j].box;
      }
    }
    s._tg = tg; s._tgP = tg ? ppl.find(p => p.box === tg) || null : null;
    // him = the other person in view (nearest to her when there are several)
    let him = null;
    if (!tg) ppl.forEach((p, i) => { const tr = mine[i]; if (tr && tr.not > tr.her && (!him || area(p.box) > area(him.box))) him = p; });
    if (tg) for (const p of ppl) { if (p.box === tg) continue; const d = (q) => Math.hypot((q.box[0] + q.box[2]) / 2 - (tg[0] + tg[2]) / 2, (q.box[1] + q.box[3]) / 2 - (tg[1] + tg[3]) / 2); if (!him || d(p) < d(him)) him = p; }
    s._him = him;
  }
}
/**
 * POV vs third-person for one video, from the people data: third-person = two people with visible heads in a good
 * share of frames; POV = one full person while the other shows up only as a headless partial body / hands at the
 * frame edge (and handheld camera shake makes POV more likely). 'solo' = never a second person.
 */
export function classifyPov(samples) {
  let withP = 0, two = 0, partial = 0, second = 0, bot = 0, botN = 0; const sh = [], vx = [], vy = [], fr2 = [];
  for (const s of samples || []) {
    if (s.gm != null) { vx.push(s.gm); vy.push(0); }
    // movement along the bottom edge outside her body (his hips / hands entering the shot)
    if (s.mg && s.ppl?.length === 1) {
      const b = s.ppl[0].box; let m = 0, tot = 0;
      for (let j = 0; j < 9; j++) for (let i = 0; i < 16; i++) { const v = s.mg[j * 16 + i]; tot += v; if (j >= 7 && ((i + 0.5) / 16 < b[0] - 0.02 || (i + 0.5) / 16 > b[2] + 0.02 || (j + 0.5) / 9 > b[3])) m += v; }
      if (tot > 0.05) { bot += m / tot; botN++; }
    }
    const ppl = s.ppl; if (!ppl?.length) continue;
    withP++;
    const heads = ppl.filter(p => p.face).length;
    if (ppl.length >= 2) second++;
    if (ppl.length >= 2 && heads >= 2) { two++; fr2.push(ppl.filter(p => p.face).map(p => [(p.face[0] + p.face[2]) / 2, (p.face[1] + p.face[3]) / 2])); }
    else if (ppl.some(p => !p.face && (p.box[3] > 0.96 || p.box[0] < 0.04 || p.box[2] > 0.96))) partial++;
  }
  // a real second person shows up again in about the same place; one-off phantom bodies (pose model guesses on
  // his legs / the sheets in POV shots) do not
  two = fr2.filter((fs, i) => fs.every(c => fr2.some((o, j) => j !== i && o.some(d => Math.hypot(c[0] - d[0], c[1] - d[1]) < 0.15)))).length;
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };
  const mx = med(vx), my = med(vy), shake = vx.length ? med(vx.map((v, i) => Math.hypot(v - mx, vy[i] - my))) : 0; // handheld jitter (frame widths / s)
  const f2 = withP ? two / withP : 0, fp = withP ? partial / withP : 0, fb = botN ? bot / botN : 0;
  const handheld = shake >= 1; // median global shift between the two analysis frames >= 1 px (at 120 px wide)
  const need = handheld ? 0.4 : 0.3;
  // two heads seen often enough = third-person; otherwise POV (his head never shows) or one person only
  const kind = withP < 3 ? 'unknown' : f2 >= need && f2 >= fp ? 'third' : (fp >= 0.1 || handheld || f2 > 0) ? 'pov' : 'solo';
  return { kind, two: +f2.toFixed(2), partial: +fp.toFixed(2), bottom: +fb.toFixed(2), second: withP ? +(second / withP).toFixed(2) : 0, shake: +shake.toFixed(3) };
}
/**
 * protected box for one sample. focus = {x, y} (her, picked with Set focus) or null.
 * Returns { box, target (person box|null), how: 'pose'|'motion' }
 */
export function protectedOf(s, focus = null) {
  const ab = s.ab ? grow(s.ab, 0.06) : null, ppl = s.ppl || [];
  const mab = s.mb || null;
  if (!ppl.length) {
    // no person found (or no model): be conservative, the motion/skin mass box trims her extremities
    let box = s.ab ? grow(s.ab, s.ppl ? 0.12 : 0.2) : null;
    if (!box || area(box) < 0.01) box = union(box, [clamp((s.cx ?? 0.5) - 0.22, 0, 1), clamp((s.cy ?? 0.5) - 0.3, 0, 1), clamp((s.cx ?? 0.5) + 0.22, 0, 1), clamp((s.cy ?? 0.5) + 0.3, 0, 1)]);
    if (focus) box = union(box, [focus.x - 0.08, focus.y - 0.1, focus.x + 0.08, focus.y + 0.1].map(v => clamp(v, 0, 1)));
    return { box, target: null, how: 'motion' };
  }
  // target: the person under the focus point, else her track (assignTargets), else the one sharing most of the action
  let tgt = null;
  if (s._tg !== undefined && !(focus && !inside(focus, s._tg || [0, 0, 0, 0]) && ppl.some(p => inside(focus, p.box)))) {
    if (s._tg) tgt = ppl.find(p => p.box === s._tg) || { box: s._tg };
    else { // she was not detected in this frame (edge, blur, occlusion): keep everyone + all the movement
      let box = ppl.reduce((u, p) => union(u, p.box), null);
      if (s.ab) box = union(box, grow(s.mb || s.ab, 0.1));
      if (focus) box = union(box, [focus.x - 0.08, focus.y - 0.1, focus.x + 0.08, focus.y + 0.1].map(v => clamp(v, 0, 1)));
      return { box: box.map(v => +v.toFixed(3)), target: null, how: 'unsure' };
    }
  }
  if (tgt) { /* from the track */ }
  else if (focus) tgt = ppl.find(p => inside(focus, p.box)) || ppl.reduce((a, p) => { const d = (q) => Math.hypot((q.box[0] + q.box[2]) / 2 - focus.x, (q.box[1] + q.box[3]) / 2 - focus.y); return !a || d(p) < d(a) ? p : a; }, null);
  else tgt = ppl.reduce((a, p) => { const sc = (q) => (mab ? area(inter(q.box, mab)) : ab ? area(inter(q.box, ab)) * 0.3 : 0) + area(q.box) * 0.1; return !a || sc(p) > sc(a) ? p : a; }, null);
  let box = tgt.kn === false ? herPad(tgt) : tgt.box; // no knees found: her legs are below the box (cut off by the pose model)
  for (const o of ppl) {
    if (o === tgt) continue;
    const near = inter(grow(tgt.box, 0.12), grow(o.box, 0.12));
    if (area(near) > 0) { // the two bodies meet: keep the contact zone and the other face if it is at her body (oral)
      box = union(box, near);
      if (o.face && area(inter(o.face, grow(tgt.box, 0.15))) > 0) box = union(box, o.face);
    }
  }
  // the moving action near her is always protected (motion only: skin tones also match beige walls / sheets)
  if (s.mb) { const near = inter(s.mb, grow(box, 0.25)); if (area(near) > 0) box = union(box, near); }
  return { box: box.map(v => +v.toFixed(3)), target: tgt.box, how: 'pose' };
}
/** how well a frame shows her: 0 (absent / tiny / cut by the frame edge) .. 1 */
export function framingScore(s) {
  const ppl = s.ppl;
  if (!ppl) return null; // no model -> no opinion
  if (!ppl.length) return 0.1;
  const t = protectedOf(s).target || ppl[0].box;
  const size = clamp(Math.sqrt(area(t) / 0.12), 0, 1);
  const edges = [t[0] < 0.01, t[1] < 0.01, t[2] > 0.99, t[3] > 0.99].filter(Boolean).length;
  // does the person we frame hold the action? (no gender classifier: a still bystander with the action
  // happening off to the side / out of frame scores low)
  let act = 0.5;
  if (s.mb) act = clamp(area(inter(s.mb, grow(t, 0.1))) / Math.max(1e-4, area(s.mb)), 0, 1);
  else act = 0.25; // no clear movement in view: the action is probably elsewhere / out of frame
  return +(clamp(0.35 + 0.65 * size, 0, 1) * (1 - 0.18 * edges) * (0.4 + 0.6 * act)).toFixed(3);
}

// ---------------- camera fitting ----------------
const ease = (p) => (1 - Math.cos(Math.PI * clamp(p, 0, 1))) / 2;
/** output-space bounding box of a source-space box under camera cam at progress p (null if behind / invalid) */
export function boxInOut(cam, p, box, aspect) {
  const { z, cx, cy } = camAt(cam, p), l = cx - 0.5 / z, t = cy - 0.5 / z;
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  const N = 6;
  for (let i = 0; i <= N; i++) for (const [x, y] of [[box[0] + (box[2] - box[0]) * i / N, box[1]], [box[0] + (box[2] - box[0]) * i / N, box[3]], [box[0], box[1] + (box[3] - box[1]) * i / N], [box[2], box[1] + (box[3] - box[1]) * i / N]]) {
    const u = (x - l) * z, v = (y - t) * z;
    const [ox, oy] = (cam.ks || cam.roll || cam.fish) ? cropToOut(cam, u, v, aspect) : [u, v];
    a = Math.min(a, ox); b = Math.min(b, oy); c = Math.max(c, ox); d = Math.max(d, oy);
  }
  return [a, b, c, d];
}
/** true if box is inside the output (with margin m) at progress p */
export function boxInside(cam, p, box, aspect, m = 0) {
  if (!cam) return box[0] >= -1e-3 && box[1] >= -1e-3 && box[2] <= 1.001 && box[3] <= 1.001;
  const o = boxInOut(cam, p, box, aspect);
  return o[0] >= m - 1e-3 && o[1] >= m - 1e-3 && o[2] <= 1 - m + 1e-3 && o[3] <= 1 - m + 1e-3;
}
/**
 * Fit a camera move so boxAt(p) stays inside with margin. keys = [{ p, box }] (smoothed protected boxes).
 * Order of remedies: pan/tilt the crop, then a gentler zoom, then soften keystone / dutch / fisheye.
 * If her region is bigger than the frame allows with margin, the margin shrinks (never crops her).
 */
export function fitCam(cam0, keys, { margin = 0.08, aspect = 16 / 9, zoomK = 1, warpFirst = false } = {}) {
  if (!cam0 || !keys.length) return cam0;
  const base = { ...cam0 };
  if (zoomK !== 1) { base.z0 = 1 + (base.z0 - 1) * zoomK; base.z1 = 1 + (base.z1 - 1) * zoomK; }
  // margin the frame can actually give (her box can be nearly as big as the frame, or touch its edge)
  const mOf = (box) => clamp(Math.min(margin, (1 - (box[2] - box[0])) / 2 - 0.002, (1 - (box[3] - box[1])) / 2 - 0.002, box[0], box[1], 1 - box[2], 1 - box[3]), 0, margin);
  const worst = (cam) => {
    let w = null;
    for (const k of keys) {
      const m = mOf(k.box), o = boxInOut(cam, k.p, k.box, aspect), ex = Math.max(m - o[0], m - o[1], o[2] - 1 + m, o[3] - 1 + m);
      if (ex > 1e-3 && (!w || ex > w.ex)) w = { ...k, ex, o, m };
    }
    return w;
  };
  // 1) pan / tilt the crop (mostly at the key that fails, a little at the other: smooth path)
  const panFit = (cam) => {
    for (let it = 0; it < 40; it++) {
      const k = worst(cam); if (!k) return true;
      const e = ease(k.p), { z } = camAt(cam, k.p), o = k.o, m = k.m;
      if (o[2] - o[0] > 1 - 2 * m + 1e-3 || o[3] - o[1] > 1 - 2 * m + 1e-3) return false; // too big at this zoom
      let dx = 0, dy = 0;
      if (o[0] < m) dx = (o[0] - m) / z; else if (o[2] > 1 - m) dx = (o[2] - 1 + m) / z;
      if (o[1] < m) dy = (o[1] - m) / z; else if (o[3] > 1 - m) dy = (o[3] - 1 + m) / z;
      const w0 = 1 - e * 0.7, w1 = 0.3 + e * 0.7, before = cam.x0 + cam.y0 + cam.x1 + cam.y1;
      const m0 = 0.5 / Math.max(1, cam.z0), m1 = 0.5 / Math.max(1, cam.z1);
      cam.x0 = clamp(cam.x0 + dx * w0 * 1.05, m0, 1 - m0); cam.x1 = clamp(cam.x1 + dx * w1 * 1.05, m1, 1 - m1);
      cam.y0 = clamp(cam.y0 + dy * w0 * 1.05, m0, 1 - m0); cam.y1 = clamp(cam.y1 + dy * w1 * 1.05, m1, 1 - m1);
      if (Math.abs(cam.x0 + cam.y0 + cam.x1 + cam.y1 - before) < 1e-5 && Math.abs(dx) + Math.abs(dy) > 1e-5) {
        // pinned against the frame edge on one key: move both keys fully
        const b2 = cam.x0 + cam.y0 + cam.x1 + cam.y1;
        cam.x0 = clamp(cam.x0 + dx, m0, 1 - m0); cam.x1 = clamp(cam.x1 + dx, m1, 1 - m1); cam.y0 = clamp(cam.y0 + dy, m0, 1 - m0); cam.y1 = clamp(cam.y1 + dy, m1, 1 - m1);
        if (Math.abs(cam.x0 + cam.y0 + cam.x1 + cam.y1 - b2) < 1e-5) return false;
      }
    }
    return !worst(cam);
  };
  const variant = (zs, ws) => {
    const c = { ...base, z0: 1 + (base.z0 - 1) * zs, z1: 1 + (base.z1 - 1) * zs };
    if (base.ks) c.ks = base.ks * ws; if (base.roll) c.roll = base.roll * ws; if (base.fish) c.fish = base.fish * ws;
    return c;
  };
  let best = null;
  const warped = base.ks || base.roll || base.fish;
  // hide mode: the tight crop matters more than the look -> soften the warp before giving up zoom
  if (warpFirst && warped) for (const ws of [1, 0.6, 0.3, 0]) { const c = variant(1, ws); if (panFit(c)) { best = c; break; } }
  // 2) a gentler zoom (largest zoom that keeps her in), 3) only then soften keystone / dutch tilt / fisheye
  if (!best) for (const ws of warped ? [1, 0.6, 0.3, 0] : [1]) {
    let c = variant(1, ws);
    if (panFit(c)) { best = c; break; }
    c = variant(0, ws);
    if (!panFit(c)) continue;
    let lo = 0, hi = 1; best = c;
    for (let i = 0; i < 6; i++) { const mid = (lo + hi) / 2, t = variant(mid, ws); if (panFit(t)) { lo = mid; best = t; } else hi = mid; }
    break;
  }
  const cam = best || variant(0, 0); // nothing a crop can do (she fills the frame): full frame, no warp
  if (!best) panFit(cam);
  if (!cam.ks) { delete cam.ks; delete cam.angle; } if (!cam.roll) delete cam.roll; if (!cam.fish) delete cam.fish;
  for (const f of ['z0', 'z1', 'x0', 'y0', 'x1', 'y1']) cam[f] = +(+cam[f]).toFixed(3);
  if (cam.z0 < 1.02) cam.z0 = 1; if (cam.z1 < 1.02) cam.z1 = 1; // a 1-2 % zoom is invisible but can clip her at the edge
  if (cam.ks) cam.ks = +cam.ks.toFixed(3); if (cam.roll) cam.roll = +cam.roll.toFixed(2); if (cam.fish) cam.fish = +cam.fish.toFixed(3);
  // rounding can nudge a box over the edge by a hair: re-check
  if (worst(cam) && !panFit(cam)) { cam.z0 = cam.z1 = 1; delete cam.ks; delete cam.angle; delete cam.roll; delete cam.fish; }
  if (cam.z0 <= 1.001 && cam.z1 <= 1.001 && !cam.ks && !cam.roll && !cam.fish) cam.fitted = 'full';
  else if (JSON.stringify(cam) !== JSON.stringify(cam0)) cam.fitted = true;
  return cam;
}
/**
 * protected-box keys for a shot (source times a..b): per 0.1 of progress, the union of the protected boxes within
 * ±0.4 s (conservative, so the camera never chases single-frame jitter), lightly smoothed.
 */
// a box within 4 % of the frame edge almost certainly continues past it (hair, hands, legs): treat it as touching,
// so no zoom / warp may cut that side
const snapEdges = (b) => {
  if (!b) return b;
  const r = [b[0] < 0.04 ? 0 : b[0], b[1] < 0.04 ? 0 : b[1], b[2] > 0.96 ? 1 : b[2], b[3] > 0.96 ? 1 : b[3]];
  if (r[3] - r[1] > 0.85) { r[1] = 0; r[3] = 1; } // she nearly fills the height: she continues past both edges
  if (r[2] - r[0] > 0.85) { r[0] = 0; r[2] = 1; }
  return r;
};
export function shotKeys(samples, a, b, focusAt = () => null, speed = 1) {
  const ss = (samples || []).filter(s => s.t >= a - 0.6 && s.t <= b + 0.6);
  if (!ss.length) return [];
  assignTargets(samples, focusAt);
  const pb = ss.map(s => ({ t: s.t, box: protectedOf(s, focusAt(s.t)).box }));
  const keys = [];
  for (let i = 0; i <= 10; i++) {
    const t = a + (b - a) * i / 10;
    // samples within ±0.4 s plus the two that bracket t (analysis samples can be ~1 s apart and she moves in between)
    let prev = null, next = null;
    for (const x of pb) { if (x.t <= t && (!prev || x.t > prev.t)) prev = x; if (x.t >= t && (!next || x.t < next.t)) next = x; }
    const use = pb.filter(x => Math.abs(x.t - t) <= 0.4 || x === prev || x === next);
    keys.push({ p: i / 10, box: snapEdges(use.reduce((u, x) => union(u, x.box), null)) });
  }
  return keys;
}
export { union as boxUnion };

// ---------------- "Hide his upper body" (third-person shots) ----------------
const topPart = (b, f) => [b[0], b[1], b[2], b[1] + (b[3] - b[1]) * f];
/** what of him must NOT show: tight = head + shoulders + upper torso, ctx (context shot) = head only */
function exclOf(him, ctx) {
  if (ctx) return him.face ? grow(him.face, 0.35) : topPart(him.box, 0.16);
  return him.up || topPart(him.box, 0.4);
}
/**
 * per-shot keys for hide mode: box = her full body + his hips/thighs (and where they touch) [+ the movement at her],
 * ex = his head/shoulders/upper torso (context shots: only his head). Same smoothing as shotKeys.
 */
// her pose box grown for the tight hide crops: pose boxes stop at the last visible joint, so folded / kneeling
// legs (no knees found) get a lot of extra room below, and hair / hands a little all round
function herPad(p) {
  if (!p) return null; const b = p.box || p, w = b[2] - b[0], h = b[3] - b[1];
  const down = p.kn === false ? Math.max(0.2, 0.9 * h) : p.an === false ? (h < 1.6 * w ? Math.max(0.25, 0.6 * h) : 0.15 * h) : 0.1 * h, side = Math.max(0.03, 0.25 * w);
  return [Math.max(0, b[0] - side), Math.max(0, b[1] - 0.12 * h), Math.min(1, b[2] + side), Math.min(1, b[3] + down)];
}
export function hideKeys(samples, a, b, focusAt = () => null, ctx = false) {
  const ss = (samples || []).filter(s => s.t >= a - 0.6 && s.t <= b + 0.6);
  if (!ss.length) return [];
  assignTargets(samples, focusAt);
  const pb = ss.map(s => {
    const her = s._tg, him = s._him;
    if (!her && him) { // only he was detected here: she is where she was just before / after (grown), plus any movement below his chest
      const ex = exclOf(him, ctx), lo = him.lo || [him.box[0], him.box[1] + (him.box[3] - him.box[1]) * 0.45, him.box[2], him.box[3]];
      let pv = null, nx = null;
      for (const o of samples) { if (!o._tg || Math.abs(o.t - s.t) > 3) continue; if (o.t < s.t && (!pv || o.t > pv.t)) pv = o; if (o.t > s.t && (!nx || o.t < nx.t)) nx = o; }
      if (!pv && !nx) return { t: s.t, box: protectedOf(s, focusAt(s.t)).box, ex }; // no idea where she is: keep everyone
      let box = grow(union(herPad(pv && (pv._tgP || pv._tg)), herPad(nx && (nx._tgP || nx._tg))), 0.1);
      if (!pv || !nx) { const g = Math.min(0.15, 0.1 * Math.abs(s.t - (pv || nx).t)); box = [box[0] - g, box[1] - g, box[2] + g, box[3] + g].map(v => clamp(v, 0, 1)); } // she may have moved on since
      box = union(box, lo);
      box = union(box, [Math.max(0, him.box[0] - 0.03), ex[3], Math.min(1, him.box[2] + 0.03), him.box[3]]); // she is likely in front of him (that is why she was missed)
      if (s.mb) { const below = inter(grow(s.mb, 0.05), [0, ex[3], 1, 1]); if (area(below) > 0) box = union(box, below); }
      return { t: s.t, box, ex };
    }
    if (!her) return { t: s.t, box: protectedOf(s, focusAt(s.t)).box, ex: null }; // not sure who she is: keep everyone
    let box = herPad(s._tgP || her), ex = null;
    if (him) {
      ex = exclOf(him, ctx);
      const lo = ctx ? [him.box[0], ex[3], him.box[2], him.box[3]] : (him.lo || [him.box[0], him.box[1] + (him.box[3] - him.box[1]) * 0.45, him.box[2], him.box[1] + (him.box[3] - him.box[1]) * 0.8]);
      if (area(inter(grow(lo, 0.25), grow(her, 0.25))) > 0) {
        box = union(box, lo);
        const ct = inter(grow(her, 0.12), grow(lo, 0.12)); if (area(ct) > 0) box = union(box, ct);
      }
    }
    if (s.mb) { const nm = inter(s.mb, grow(her, 0.15)); if (area(nm) > 0) box = union(box, nm); }
    return { t: s.t, box, ex };
  });
  // a one-off jump of her box up into his upper body is the pose model merging the two of them: trim it back
  const tops = pb.filter(x => x.ex).map(x => x.box[1]).sort((u, v) => u - v);
  if (tops.length >= 3) {
    const mt = tops[tops.length >> 1];
    for (const x of pb) if (x.ex && x.box[1] < mt - 0.12 && x.box[1] < x.ex[3] && x.box[1] >= x.ex[1] - 0.1) x.box = [x.box[0], mt - 0.06, x.box[2], x.box[3]];
  }
  const keys = [];
  for (let i = 0; i <= 10; i++) {
    const t = a + (b - a) * i / 10;
    let prev = null, next = null;
    for (const x of pb) { if (x.t <= t && (!prev || x.t > prev.t)) prev = x; if (x.t >= t && (!next || x.t < next.t)) next = x; }
    const use = pb.filter(x => Math.abs(x.t - t) <= 0.4 || x === prev || x === next);
    let kb = use.reduce((u, x) => union(u, x.box), null);
    // past the first / last analysis frame she may have moved on: allow for it (about 0.1 of the frame per second)
    if (kb) { // between two analysis frames she can wander off the straight line too (about 0.03 of the frame per second)
      const g = (!prev || !next) ? Math.min(0.15, 0.1 * Math.abs(t - (prev || next).t)) : Math.min(0.06, 0.03 * (next.t - prev.t));
      if (g > 0.01) kb = [kb[0] - g, kb[1] - g, kb[2] + g, kb[3] + g].map(v => clamp(v, 0, 1));
    }
    keys.push({ p: i / 10, box: kb, ex: use.reduce((u, x) => (x.ex ? union(u, x.ex) : u), null) });
  }
  return keys;
}
/**
 * Tightest crop (frame aspect) that holds box with margin, slid inside its slack to show as little of ex as possible.
 * Returns { z, cx, cy } in source units.
 */
function tightCrop(P, E, margin, zMax) {
  const m = clamp(Math.min(margin, (1 - (P[2] - P[0])) / 2 - 0.002, (1 - (P[3] - P[1])) / 2 - 0.002, P[0], P[1], 1 - P[2], 1 - P[3]), 0, margin);
  const sz = clamp(Math.max(P[2] - P[0] + 2 * m, P[3] - P[1] + 2 * m, 1 / zMax), 0, 1);
  const lx = Math.max(0, P[2] + m - sz), hx = Math.min(1 - sz, P[0] - m), ly = Math.max(0, P[3] + m - sz), hy = Math.min(1 - sz, P[1] - m);
  const pcx = (P[0] + P[2]) / 2, pcy = (P[1] + P[3]) / 2;
  let best = null;
  for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
    const l = hx >= lx ? lx + (hx - lx) * i / 16 : clamp(pcx - sz / 2, 0, 1 - sz), t = hy >= ly ? ly + (hy - ly) * j / 16 : clamp(pcy - sz / 2, 0, 1 - sz);
    const vis = E ? area(inter(E, [l, t, l + sz, t + sz])) : 0;
    const sc = vis * 100 + Math.hypot(l + sz / 2 - pcx, t + sz / 2 - pcy) * 0.01;
    if (!best || sc < best.sc) best = { sc, l, t };
  }
  return { z: 1 / sz, cx: best.l + sz / 2, cy: best.t + sz / 2 };
}
/** hide-mode camera: tight crops on her (+ his lower body) away from his upper body, then the same safety fit as v11 */
export function fitHide(cam0, keys, { margin = 0.08, aspect = 16 / 9, zMax = 2.5, ctx = false } = {}) {
  if (!cam0 || !keys.length) return cam0;
  margin *= 0.5; // her box is already padded for the hide crops (missing legs / hair / movement between frames)
  const U = (ks, f) => ks.reduce((u, k) => (k[f] ? union(u, k[f]) : u), null);
  const A = keys.filter(k => k.p <= 0.5), B = keys.filter(k => k.p >= 0.5);
  const c0 = tightCrop(U(A, 'box'), U(A, 'ex'), margin, zMax), c1 = tightCrop(U(B, 'box'), U(B, 'ex'), margin, zMax);
  const cam = { ...cam0, z0: c0.z, x0: c0.cx, y0: c0.cy, z1: c1.z, x1: c1.cx, y1: c1.cy };
  // keep a little of the planned move's character (push in / pull back) when there is room
  if (cam0.type === 'push' || cam0.type === 'punch' || cam0.type === 'close') cam.z1 = Math.min(zMax, cam.z1 * 1.05);
  if (cam0.type === 'pull') cam.z0 = Math.min(zMax, cam.z0 * 1.05);
  const out = fitCam(cam, keys, { margin, aspect, zoomK: 1, warpFirst: true });
  // never zoom past what holds her whole box (each half of the move)
  for (const [z, ks] of [['z0', A], ['z1', B]]) { const q = U(ks, 'box'); if (q) { const big = Math.max(q[2] - q[0], q[3] - q[1], 1e-3); out[z] = big >= 0.9 ? 1 : +Math.max(1, Math.min(out[z], 1 / big)).toFixed(3); } if (out[z] < 1.1) out[z] = 1; } // under 1.1x hides nothing, only risks her edges
  // she reaches a frame edge (feet at the bottom, ...): make the crop touch that edge exactly
  const P = U(keys, 'box');
  if (P) for (const [x, y] of [['x0', 'y0'], ['x1', 'y1']]) {
    // camAt clamps the centre into the frame, so 1 / 0 = flush with that edge all through the move
    const h = 0.49 / Math.max(1, out[y === 'y0' ? 'z0' : 'z1']); // just reach that edge (camAt clamps the overshoot)
    if (P[3] >= 0.985) out[y] = Math.max(out[y], 1 - h); else if (P[1] <= 0.015) out[y] = Math.min(out[y], h);
    if (P[2] >= 0.985) out[x] = Math.max(out[x], 1 - h); else if (P[0] <= 0.015) out[x] = Math.min(out[x], h);
  }
  // last check over the whole move (the eased zoom / pan between the two ends): every key's box must show
  const okAll = (c) => keys.every(k => !k.box || boxInside(c, k.p, k.box, aspect, 0));
  if (!okAll(out)) {
    const zm = Math.min(out.z0, out.z1), c2 = { ...out, z0: zm, z1: zm };
    if (okAll(c2)) Object.assign(out, c2);
    else { Object.assign(out, { z0: 1, z1: 1, x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5, fitted: 'full' }); delete out.ks; delete out.angle; delete out.roll; delete out.fish; }
  }
  out.hide = ctx ? 'ctx' : 'tight';
  return out;
}
/** how much of a box shows in the output of cam at p (0..1, sampled) */
export function visibleFrac(cam, p, b, aspect = 16 / 9) {
  let k = 0, t = 0;
  for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) { const x = b[0] + (b[2] - b[0]) * i / 8, y = b[1] + (b[3] - b[1]) * j / 8; t++; if (boxInside(cam, p, [x, y, x, y], aspect, 0)) k++; }
  return k / t;
}
