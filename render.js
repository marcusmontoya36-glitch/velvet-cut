// Shared rendering helpers so preview, real-time export and ffmpeg export look the same.
export const FONT_STACK = '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif';

export function cssFilter(c) {
  return `brightness(${(1 + c.b).toFixed(3)}) contrast(${c.c.toFixed(3)}) saturate(${c.s.toFixed(3)})`;
}
export function warmthColor(w) {
  if (!w) return null;
  const a = Math.min(1, Math.abs(w)) * 0.55;
  return w > 0 ? `rgba(255,140,30,${a})` : `rgba(30,120,255,${a})`;
}
// ffmpeg equivalent (approximate) of the CSS preview filter.
export function ffColorFilter(c) {
  const parts = [];
  if (c.b || c.c !== 1 || c.s !== 1) {
    // CSS brightness multiplies; eq brightness adds. Map roughly.
    parts.push(`eq=brightness=${(c.b * 0.6).toFixed(3)}:contrast=${c.c.toFixed(3)}:saturation=${c.s.toFixed(3)}`);
  }
  if (c.w) {
    const k = (c.w * 0.18).toFixed(3);
    parts.push(`colorbalance=rm=${k}:bm=${(-k).toFixed(3)}:rh=${(k / 2).toFixed(3)}:bh=${(-k / 2).toFixed(3)}`);
  }
  return parts.join(',');
}

function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = '';
    for (const w of words) {
      const t = line ? line + ' ' + w : w;
      if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t;
    }
    out.push(line);
  }
  return out;
}

// Draw one caption on a canvas of size W x H. cap.size is % of frame height.
export function drawCaption(ctx, cap, W, H) {
  const fs = Math.max(8, (cap.size / 100) * H);
  ctx.save();
  ctx.font = `800 ${fs}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, cap.text || '', W * 0.9);
  const lh = fs * 1.15;
  const cx = cap.x * W, cy = cap.y * H;
  const top = cy - (lines.length * lh) / 2 + lh / 2;
  if (cap.box) {
    const w = Math.max(...lines.map(l => ctx.measureText(l).width)) + fs * 0.7;
    const h = lines.length * lh + fs * 0.3;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    roundRect(ctx, cx - w / 2, cy - h / 2, w, h, fs * 0.2);
    ctx.fill();
  }
  ctx.shadowColor = 'rgba(0,0,0,0.85)';
  ctx.shadowBlur = fs * 0.25;
  ctx.shadowOffsetY = fs * 0.06;
  ctx.fillStyle = cap.color || '#ffffff';
  lines.forEach((l, i) => ctx.fillText(l, cx, top + i * lh));
  ctx.restore();
}
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}

// Fit src (sw x sh) into dst (W x H), letterboxed.
export function containRect(sw, sh, W, H) {
  const s = Math.min(W / sw, H / sh);
  const w = sw * s, h = sh * s;
  return [(W - w) / 2, (H - h) / 2, w, h];
}

export function outputSize(clips, res) {
  const c = clips[0];
  let w = c?.w || 1280, h = c?.h || 720;
  if (res !== 'src') {
    const s = Math.min(1, +res / Math.min(w, h)); // never upscale
    w *= s; h *= s;
  }
  return [Math.max(2, Math.round(w / 2) * 2), Math.max(2, Math.round(h / 2) * 2)];
}
export function fmtTime(t, ms = true) {
  t = Math.max(0, t || 0);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = ms ? s.toFixed(1).padStart(4, '0') : String(Math.floor(s)).padStart(2, '0');
  return (h ? h + ':' + String(m).padStart(2, '0') : m) + ':' + ss;
}
export function srtTime(t) {
  const ms = Math.round(t * 1000);
  const h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = Math.floor(ms / 1000) % 60, r = ms % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(r).padStart(3, '0')}`;
}
export function toSrt(caps) {
  return [...caps].sort((a, b) => a.start - b.start)
    .map((c, i) => `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`).join('\n');
}
export function parseSrt(txt) {
  const out = [];
  const re = /(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)[^\n]*\n([\s\S]*?)(?=\n\s*\n|$)/g;
  let m;
  const ts = (a, b, c, d) => +a * 3600 + +b * 60 + +c + +d / 1000;
  while ((m = re.exec(txt.replace(/\r/g, '')))) {
    out.push({ start: ts(m[1], m[2], m[3], m[4]), end: ts(m[5], m[6], m[7], m[8]), text: m[9].trim() });
  }
  return out;
}

// ---------- per-clip enhancement + dynamic camera (shared by preview, real-time export and ffmpeg export) ----------
// Combined colour = project colour × clip auto-enhance.
export function clipColor(proj, clip) {
  const p = proj.color, e = clip?.enh;
  if (!e) return p;
  return { b: p.b + (e.b || 0), c: p.c * (e.c || 1), s: p.s * (e.s || 1), w: p.w };
}
const ease = (p) => (1 - Math.cos(Math.PI * Math.max(0, Math.min(1, p)))) / 2;
// Camera state at progress p (0..1) through the clip: zoom z and the normalized centre of the crop window.
export function camAt(cam, p) {
  if (!cam) return { z: 1, cx: 0.5, cy: 0.5 };
  const e = ease(p);
  const z = Math.max(1, cam.z0 + (cam.z1 - cam.z0) * e);
  const m = 0.5 / z;
  const cx = Math.max(m, Math.min(1 - m, cam.x0 + (cam.x1 - cam.x0) * e));
  const cy = Math.max(m, Math.min(1 - m, cam.y0 + (cam.y1 - cam.y0) * e));
  return { z, cx, cy };
}
// ---------- simulated high / low angles (keystone), dutch tilt and fisheye ----------
// The warp is defined in output space after the crop: output uv -> (fisheye) -> homography -> crop-space uv.
// warpQuad gives the crop-space points that land on the output corners TL, TR, BR, BL (all inside the frame,
// so there are never black edges). angle 'high' = camera above looking down (top of frame wider/closer),
// 'low' = camera below looking up (bottom wider). ks = keystone strength, roll = dutch tilt in degrees.
export function warpQuad(cam, aspect = 16 / 9) {
  if (!cam || (!cam.ks && !cam.roll)) return null;
  const ks = Math.min(0.4, Math.abs(cam.ks || 0));
  const kt = cam.angle === 'high' ? ks : 0, kb = cam.angle === 'low' ? ks : 0;
  const a = aspect;
  let pts = [[-a / 2 * (1 - kt), -0.5], [a / 2 * (1 - kt), -0.5], [a / 2 * (1 - kb), 0.5], [-a / 2 * (1 - kb), 0.5]];
  const r = (cam.roll || 0) * Math.PI / 180;
  if (r) {
    const c = Math.cos(r), sn = Math.sin(r), as = Math.abs(sn);
    const sc = Math.max(c + a * as, c + as / a); // shrink so the rotated window stays inside the frame
    pts = pts.map(([x, y]) => [(x * c - y * sn) / sc, (x * sn + y * c) / sc]);
  }
  return pts.map(([x, y]) => [x / a + 0.5, y + 0.5]);
}
// homography mapping the unit square (0,0),(1,0),(1,1),(0,1) onto quad q -> 3x3 row-major
export function squareToQuad(q) {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const sx = x0 - x1 + x2 - x3, sy = y0 - y1 + y2 - y3;
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  const dx1 = x1 - x2, dx2 = x3 - x2, dy1 = y1 - y2, dy2 = y3 - y2, den = dx1 * dy2 - dx2 * dy1;
  const g = (sx * dy2 - dx2 * sy) / den, h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
}
const mul3 = (A, B) => { const R = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) R.push(A[i * 3] * B[j] + A[i * 3 + 1] * B[3 + j] + A[i * 3 + 2] * B[6 + j]); return R; };
function inv3(m) {
  const [a, b, c, d, e, f, g, h, i] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return [A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map(x => x / det);
}
export const hasWarp = (cam) => !!(cam && (cam.ks || cam.roll));
export const hasFish = (cam) => !!(cam && cam.fish > 0.005);
// CSS transform for the preview <video> (element is the stage size, origin centre; overflow hidden on the stage).
// W, H = element size in px (needed for the keystone / tilt matrix). Fisheye can't be done in CSS: the preview
// draws those shots with WebGL (fx.js) instead.
export function camCss(cam, p, W = 1600, H = 900) {
  const { z, cx, cy } = camAt(cam, p);
  const fl = cam?.flip ? 'scaleX(-1) ' : '';
  let wm = '';
  const q = warpQuad(cam, W / H);
  if (q) {
    // output px (centred) -> crop px (centred): N^-1 * Hn * N ; CSS needs the inverse (crop -> output)
    const N = [1 / W, 0, 0.5, 0, 1 / H, 0.5, 0, 0, 1], Ni = [W, 0, -W / 2, 0, H, -H / 2, 0, 0, 1];
    const M = inv3(mul3(Ni, mul3(squareToQuad(q), N)));
    const k = M[8], m = M.map(x => +(x / k).toPrecision(9));
    wm = `matrix3d(${m[0]},${m[3]},0,${m[6]},${m[1]},${m[4]},0,${m[7]},0,0,1,0,${m[2]},${m[5]},0,1) `;
  }
  if (z <= 1.0005) return (fl + wm).trim();
  return `${fl}${wm}scale(${z.toFixed(4)}) translate(${((0.5 - cx) * 100).toFixed(3)}%, ${((0.5 - cy) * 100).toFixed(3)}%)`;
}
// ffmpeg filters for the warp + fisheye, applied to the W×H output of camFF (before hflip)
export function warpFF(cam, W, H) {
  const parts = [];
  const q = warpQuad(cam, W / H);
  if (q) {
    const P = (i) => `${(q[i][0] * W).toFixed(2)}:${(q[i][1] * H).toFixed(2)}`;
    parts.push(`perspective=${P(0)}:${P(1)}:${P(3)}:${P(2)}:interpolation=linear:sense=source`);
  }
  if (hasFish(cam)) {
    // GL/preview maps output radius r -> r*(1-k+k r^2). Same thing = lenscorrection(k1) then centre crop (1-k) and scale back.
    const k = Math.min(0.45, cam.fish), k1 = Math.min(1, k / Math.pow(1 - k, 3));
    const cw = Math.round(W * (1 - k) / 2) * 2, ch = Math.round(H * (1 - k) / 2) * 2;
    parts.push(`lenscorrection=k1=${k1.toFixed(4)}:k2=0:i=bilinear`, `crop=${cw}:${ch}`, `scale=${W}:${H}:flags=bicubic`);
  }
  return parts.join(',');
}
// ---------- clip timing: slow motion (speed < 1) and boomerang (forward then reverse) ----------
export const clipSpeed = (c) => Math.min(1, Math.max(0.25, c?.speed || 1));
export const fwdDur = (c) => (c.out - c.in) / clipSpeed(c);
export const clipDur = (c) => fwdDur(c) * (c.boom ? 2 : 1);
// source time shown at timeline-local time l
export function srcAt(c, l) {
  const F = fwdDur(c), sp = clipSpeed(c);
  if (c.boom && l > F) l = Math.max(0, 2 * F - l);
  return c.in + Math.min(F, Math.max(0, l)) * sp;
}
// camera progress at local time l (a boomerang plays the camera move back too, like reversing the rendered shot)
export function camP(c, l) {
  const F = Math.max(0.01, fwdDur(c));
  if (c.boom) return Math.max(0, Math.min(1, l <= F ? l / F : (2 * F - l) / F));
  return Math.max(0, Math.min(1, l / F));
}
// crossfade length at each boundary j (between clip j and j+1), shared by preview, real-time and ffmpeg export
export function xfadeDurations(clips, xf, fps = 30) {
  const q = (x) => Math.round(x * fps) / fps;
  const d = clips.map(c => Math.max(2 / fps, q(clipDur(c))));
  return clips.slice(0, -1).map((c, j) => { const x = q(Math.min(xf || 0, d[j] / 3, d[j + 1] / 3)); return x >= 3 / fps ? x : 0; });
}
/**
 * ffmpeg filter that applies the camera move on a W×H frame (input already W*k × H*k).
 * d = clip duration (s), off = seconds into the clip where this piece starts, n = piece duration.
 */
export function camFF(cam, d, off, W, H, fps = 30) {
  if (!cam) return '';
  const moving = Math.abs(cam.z1 - cam.z0) > 0.001 || Math.abs(cam.x1 - cam.x0) > 0.001 || Math.abs(cam.y1 - cam.y0) > 0.001;
  if (!moving) {
    if (cam.z0 <= 1.001) return `scale=${W}:${H}`;
    // static crop - exact, no rounding jitter
    const cw = `trunc(iw/${cam.z0.toFixed(4)}/2)*2`, ch = `trunc(ih/${cam.z0.toFixed(4)}/2)*2`;
    return `crop=${cw}:${ch}:'max(0,min(iw-ow,iw*${cam.x0.toFixed(4)}-ow/2))':'max(0,min(ih-oh,ih*${cam.y0.toFixed(4)}-oh/2))',scale=${W}:${H}`;
  }
  const N = Math.max(1, d * fps).toFixed(2);
  const E = `((1-cos(PI*min(1,(on+${(off * fps).toFixed(2)})/${N})))/2)`;
  const lerp = (a, b) => `(${a.toFixed(4)}+(${(b - a).toFixed(4)})*${E})`;
  return `zoompan=z='max(1,${lerp(cam.z0, cam.z1)})':x='max(0,min(iw-iw/zoom,iw*${lerp(cam.x0, cam.x1)}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,ih*${lerp(cam.y0, cam.y1)}-ih/zoom/2))':d=1:s=${W}x${H}:fps=${fps}`;
}
// enhancement filters (denoise / colour / sharpen) for ffmpeg
export function enhFF(proj, clip) {
  const e = clip.enh || {};
  const parts = [];
  if (e.dn) parts.push(e.dn > 1 ? 'hqdn3d=3:2.5:6:6' : 'hqdn3d=1.5:1.5:4:4');
  const col = ffColorFilter(clipColor(proj, clip));
  if (col) parts.push(col);
  if (e.sh) parts.push('unsharp=5:5:0.7:5:5:0');
  return parts.join(',');
}
// output (0..1) -> crop-space (0..1) for a camera look: fisheye then keystone/tilt (same as the shader in fx.js)
export function outToCrop(cam, u, v, aspect = 16 / 9) {
  if (hasFish(cam)) {
    const k = Math.min(0.45, cam.fish), dx = (u - 0.5) * aspect, dy = v - 0.5, r2 = (dx * dx + dy * dy) / (aspect * aspect / 4 + 0.25);
    const f = 1 - k + k * r2; u = 0.5 + dx * f / aspect; v = 0.5 + dy * f;
  }
  const q = warpQuad(cam, aspect);
  if (q) { const m = squareToQuad(q), w = m[6] * u + m[7] * v + m[8]; return [(m[0] * u + m[1] * v + m[2]) / w, (m[3] * u + m[4] * v + m[5]) / w]; }
  return [u, v];
}
// inverse of outToCrop (a few Newton-free fixed-point steps; the mapping is close to identity)
export function cropToOut(cam, x, y, aspect = 16 / 9) {
  let u = x, v = y;
  for (let i = 0; i < 12; i++) { const [a, b] = outToCrop(cam, u, v, aspect); u += x - a; v += y - b; }
  return [u, v];
}
