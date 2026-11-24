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
    return { box: box.map(v => +v.toFixed(3)), face: face && face.map(v => +v.toFixed(3)), score: +(vis.length / lm.length).toFixed(2) };
  }).filter(Boolean);
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
    const ppl = s.ppl || [], used = new Set(), mine = [];
    for (const p of ppl) {
      let best = null, bd = 1e9;
      for (const tr of tracks) {
        if (used.has(tr) || s.t - tr.lt > 3) continue;
        const [ax, ay] = ctr(tr.last), [bx, by] = ctr(p.box), d = Math.hypot(ax - bx, ay - by) - 0.4 * iou(tr.last, p.box);
        if (d < bd) { bd = d; best = tr; }
      }
      if (!best || bd > 0.3) { best = { id: tracks.length, her: 0, not: 0, last: p.box, lt: s.t }; tracks.push(best); }
      used.add(best); best.last = p.box; best.lt = s.t; mine.push(best);
      const f = focusAt(s.t); if (f && inside(f, p.box)) best.her += 50;
    }
    if (ppl.length >= 2) {
      const d = ppl.map(p => dens(s, p.box)), mx = Math.max(...d), k = d.indexOf(mx), second = Math.max(...d.filter((_, i) => i !== k));
      if (mx > 1e-4 && mx >= second * 1.25) mine.forEach((tr, i) => { if (i === k) tr.her++; else tr.not++; });
    }
    ids.set(s, mine);
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
    s._tg = tg;
  }
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
  let box = tgt.box;
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
export function fitCam(cam0, keys, { margin = 0.08, aspect = 16 / 9, zoomK = 1 } = {}) {
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
  // 2) a gentler zoom (largest zoom that keeps her in), 3) only then soften keystone / dutch tilt / fisheye
  for (const ws of warped ? [1, 0.6, 0.3, 0] : [1]) {
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
