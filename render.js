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

// ---- crop (per clip, in displayed-source coordinates [x0, y0, x1, y1], 0..1) and fill ----
export const CROP_ASPECTS = { free: 0, '9:16': 9 / 16, '4:5': 4 / 5, '1:1': 1, '16:9': 16 / 9 };
export function clipCrop(c) {
  const r = c?.crop;
  if (!Array.isArray(r) || r.length !== 4 || !(r[2] - r[0] > 0.02) || !(r[3] - r[1] > 0.02)) return null;
  if (r[0] <= 0.001 && r[1] <= 0.001 && r[2] >= 0.999 && r[3] >= 0.999) return null;
  return r;
}
/** size of the part of the source a clip shows (after its crop) */
export function shownSize(c) {
  const r = clipCrop(c) || [0, 0, 1, 1];
  return [(c?.w || 1280) * (r[2] - r[0]), (c?.h || 720) * (r[3] - r[1])];
}
/**
 * The source rectangle actually shown in a W×H frame: the clip's crop, then (fill) trimmed to the frame's shape
 * so there are no black bars. fill: 'auto' (only when at most ~25% would be lost), 'always', 'off'.
 * Returns null when the whole source is shown (contained).
 */
export function viewCrop(c, W, H, fill = 'auto') {
  const r = clipCrop(c);
  if (fill === 'off' || !W || !H) return r;
  const [sw, sh] = shownSize(c), a = sw / sh, A = W / H, keep = Math.min(a / A, A / a);
  const fc = Array.isArray(c?.fc) ? c.fc : null; // where the people are in this shot (source 0..1), from the analysis
  if (keep > 0.985 || (fill !== 'always' && keep < (fc ? 0.6 : 0.75))) return r;
  let [x0, y0, x1, y1] = r || [0, 0, 1, 1];
  if (a > A) { const w = (x1 - x0) * A / a; const nx = fc ? Math.max(x0, Math.min(x1 - w, fc[0] - w / 2)) : x0 + ((x1 - x0) - w) / 2; x0 = nx; x1 = x0 + w; }
  else { const h = (y1 - y0) * a / A; const ny = fc ? Math.max(y0, Math.min(y1 - h, fc[1] - h * 0.45)) : y0 + ((y1 - y0) - h) * 0.4; y0 = ny; y1 = y0 + h; } // keep a bit more of the top (faces)
  return [x0, y0, x1, y1];
}
/** ffmpeg crop filter for a source rectangle (after autorotate, so displayed orientation), '' for none */
export function cropFF(r) {
  if (!r) return '';
  const f = (x) => (+x).toFixed(5);
  return `crop=trunc(iw*${f(r[2] - r[0])}/2)*2:trunc(ih*${f(r[3] - r[1])}/2)*2:trunc(iw*${f(r[0])}):trunc(ih*${f(r[1])})`;
}
/** output frame: the shape (portrait / square / landscape) most of the edit is in, sized like its first clip */
export function outputSize(clips, res) {
  const kind = (c) => { const [w, h] = shownSize(c), a = w / h; return a > 1.15 ? 'L' : a < 0.87 ? 'P' : 'S'; };
  const tot = {}; for (const x of clips) if (x?.w && x?.h) tot[kind(x)] = (tot[kind(x)] || 0) + Math.max(0.1, (x.out ?? 1) - (x.in ?? 0));
  const best = Object.keys(tot).sort((a, b) => tot[b] - tot[a])[0];
  const c = (best && clips.find(x => x?.w && x?.h && kind(x) === best)) || clips[0];
  let [w, h] = c?.w ? shownSize(c) : [1280, 720];
  if (res !== 'src') {
    // never upscale past the source: a cropped clip may come back up to the size class of its uncropped video
    const up = c?.w ? Math.max(1, Math.min(c.w, c.h) / Math.max(1, Math.min(w, h))) : 1;
    const s = Math.min(up, +res / Math.min(w, h));
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
  if (!e || e.hdr) return p; // HDR sources get no automatic grade (also fixes projects saved before v14)
  let b = e.b || 0, c = e.c || 1, s = e.s || 1;
  // the automatic grade never stacks on top of a shadow lift: brightening + contrast + saturation over lifted
  // shadows pushed skin into clipping (washed-out, pink/orange, banded). Also applied to clips from older projects.
  if (shadowAmt(clip) >= 0.05) { b = Math.min(b, 0.03); c = Math.min(c, 1.05); s = Math.min(s, 1.05); }
  return { b: p.b + b, c: p.c * c, s: p.s * s, w: p.w };
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
/** multi-cam program audio for a clip: { mediaId, off } (master time = clip time + off), or null = own sound */
export function programAudio(c, media) {
  const af = c.audioFrom;
  if (!af || af.mediaId === c.mediaId || c.boom || !media.get(af.mediaId)) return null; // slow-mo stretches the master sound too
  return af;
}
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

// ---------- shadow recovery (local, luminance-masked lift) — shared by preview, fast export and ffmpeg ----------
// One definition, three implementations (fx.js shader, shadowFF below, shadowRef for tests):
//   Y  = BT.709 luma of the pixel, Q = sqrt(Y)
//   B  = local mean of Q: area-average Q onto a 64-texel-wide grid, gaussian blur (σ = 1 texel), bilinear upsample
//   M  = mix(B, Q, smoothstep(0.04, 0.16, |Q - B|))^2   (edge-aware base: no halos around bright/dark edges)
//   w  = 1 - smoothstep(0.30, 0.75, M)                    (highlight protection: bright areas are left alone)
//   fM = mix(M, M^(1-0.6s), w);  kb = min(fM / max(M, .004), 1 + 3s)   (gamma lift of the local base)
//   k  = clamp(kb * ((Y+.02)/(M+.02))^(0.25 s w), 0.5, 4)  (mild local contrast, CLAHE-like, only where lifted)
//   cd = mix(c, avg5(c), clamp((k-1)/4, 0, 0.6))          (light denoise where shadows were lifted)
//   k' = min(k, max(1, PEAK / P)), P = max(R,G,B)          highlight guard: never lifts any channel past PEAK, so
//                                                          skin/warm tones don't clip red and shift hue (leaves headroom for the grade)
//   out = clamp(cd * k')
// Multiplying R, G and B by the same k keeps hue and skin tones (no colour cast).
export const SHADOW_BASE = 64;
export const shadowAmt = (c) => {
  // automatic lift is capped at 0.5 (older projects could carry up to 0.85); a hand-set slider value is used as is
  const v = c?.shadow != null ? c.shadow / 100 : (c?.enh?.hdr ? 0 : Math.min(0.5, c?.enh?.shadow || 0));
  return Math.max(0, Math.min(1, +v || 0));
};
export const SHADOW_PEAK = 0.8; // headroom for the auto grade after the lift (brightness x1.12, contrast 1.15)
export function shadowK(s, Y, B, P = Y) {
  const Q = Math.sqrt(Math.max(0, Y)), e = Math.max(0, Math.min(1, (Math.abs(Q - B) - 0.04) / 0.12)), a = e * e * (3 - 2 * e);
  const M = Math.pow(B + (Q - B) * a, 2);
  const gam = 1 - 0.6 * s, kMax = 1 + 3 * s, lc = 0.25 * s;
  const t = Math.max(0, Math.min(1, (M - 0.3) / 0.45)), w = 1 - t * t * (3 - 2 * t);
  const fM = M * (1 - w) + Math.pow(Math.max(M, 1e-4), gam) * w;
  const kb = Math.min(fM / Math.max(M, 0.004), kMax);
  const k = Math.max(0.5, Math.min(4, kb * Math.pow((Y + 0.02) / (M + 0.02), lc * w)));
  return Math.min(k, Math.max(1, SHADOW_PEAK / Math.max(P, 0.001)));
}
export const shadowBaseSize = (w, h) => w >= h ? [SHADOW_BASE, Math.max(4, Math.round(SHADOW_BASE * h / w))] : [Math.max(4, Math.round(SHADOW_BASE * w / h)), SHADOW_BASE];
/**
 * ffmpeg filtergraph lines for the same shadow lift on a W×H frame: [inL] -> [outL] (yuv420p in and out).
 * 8-bit LUT based (lut / lut2 / maskedmerge / convolution), so it stays fast in ffmpeg.wasm.
 */
export function shadowFF(s, W, H, inL, outL, zoom = 1) {
  const gam = (1 - 0.6 * s).toFixed(4), kMax = (1 + 3 * s).toFixed(4), lc = (0.25 * s).toFixed(4);
  // zoom: the frame is a crop (1/zoom) of the source, so the base grid is coarser to cover the same source area
  const [bw0, bh0] = shadowBaseSize(W, H), bw = Math.max(4, Math.round(bw0 / zoom)), bh = Math.max(4, Math.round(bh0 / zoom)), id = outL.replace(/\W/g, '');
  // Works in YUV: scaling R,G,B by k == scaling (Y-16) and (Cb-128), (Cr-128) by k, so no RGB round trip.
  // Y here is the BT.709 luma of the frame: (Y-16)/219. x = Y (tv range), y = base B (0..255 -> 0..1)
  const Yn = 'clip((x-16)/219,0,1)';
  const kExpr = `st(6,${Yn});st(7,sqrt(ld(6)));st(9,clip((abs(ld(7)-y/255)-0.04)/0.12,0,1));st(8,ld(9)*ld(9)*(3-2*ld(9)));` +
    `st(0,pow(y/255+(ld(7)-y/255)*ld(8),2));st(9,clip((ld(0)-0.3)/0.45,0,1));st(1,1-ld(9)*ld(9)*(3-2*ld(9)));` +
    `st(2,min((ld(0)*(1-ld(1))+pow(max(ld(0),0.0001),${gam})*ld(1))/max(ld(0),0.004),${kMax}));` +
    `st(3,clip(ld(2)*pow((ld(6)+0.02)/(ld(0)+0.02),${lc}*ld(1)),0.5,4));` +
    `ld(3)/4*255`;
  const k = '(y*4/255)';
  return [
    `[${inL}]format=yuv420p,split=3[${id}v][${id}c][${id}pc]`,
    `[${id}c]extractplanes=y,split=2[${id}y0][${id}y1]`,
    `[${id}y1]lut=c0='sqrt(clip((val-16)/219,0,1))*255',scale=${bw}:${bh}:flags=area,gblur=sigma=1:steps=3,scale=${W}:${H}:flags=bilinear[${id}q]`,
    `[${id}y0][${id}q]lut2=c0='${kExpr}'[${id}kr]`,
    // peak channel P = max(R,G,B) from Y/Cb/Cr (BT.709, tv range) at chroma resolution, for the highlight guard
    `[${id}pc]extractplanes=y+u+v[${id}py][${id}pu][${id}pv]`,
    `[${id}py]scale=${W >> 1}:${H >> 1}:flags=area,split=3[${id}py0][${id}py1][${id}py2]`,
    `[${id}pu]split=2[${id}pu0][${id}pu1]`, `[${id}pv]split=2[${id}pv0][${id}pv1]`,
    `[${id}py0][${id}pv0]lut2=c0='clip((x-16)/219+1.5748*(y-128)/224,0,1)*255'[${id}pr]`,
    `[${id}py1][${id}pu0]lut2=c0='clip((x-16)/219+1.8556*(y-128)/224,0,1)*255'[${id}pb]`,
    `[${id}pu1][${id}pv1]lut2=c0='clip(128-0.1873*(x-128)*255/224-0.4681*(y-128)*255/224,0,255)'[${id}go]`,
    `[${id}py2][${id}go]lut2=c0='clip((x-16)/219+(y-128)/255,0,1)*255'[${id}pg]`,
    `[${id}pr][${id}pb]blend=all_mode=lighten[${id}prb]`,
    `[${id}prb][${id}pg]blend=all_mode=lighten,scale=${W}:${H}:flags=bilinear[${id}pk]`,
    `[${id}kr][${id}pk]lut2=c0='min(x*4/255,max(1,${SHADOW_PEAK}/max(y/255,0.001)))/4*255',split=2[${id}k0][${id}k1]`,
    // stay in 4:2:0: chroma planes get a half-size copy of the gain/mask maps
    `[${id}k0]lut=c0='clip((val*4/255-1)/4,0,0.6)*255',split=2[${id}w0][${id}wh]`,
    `[${id}wh]scale=${W >> 1}:${H >> 1}:flags=area,split=2[${id}w1][${id}w2]`,
    `[${id}w0][${id}w1][${id}w2]mergeplanes=0x001020:yuv420p[${id}w]`,
    `[${id}k1]split=2[${id}ka][${id}kh]`,
    `[${id}kh]scale=${W >> 1}:${H >> 1}:flags=area,split=2[${id}kb][${id}kc]`,
    `[${id}ka][${id}kb][${id}kc]mergeplanes=0x001020:yuv420p[${id}k]`,
    `[${id}v]split=2[${id}s0][${id}s1]`,
    `[${id}s1]convolution=0m='0 1 0 1 1 1 0 1 0':1m='0 1 0 1 1 1 0 1 0':2m='0 1 0 1 1 1 0 1 0':0rdiv=0.2:1rdiv=0.2:2rdiv=0.2[${id}bl]`,
    `[${id}s0][${id}bl][${id}w]maskedmerge[${id}cd]`,
    `[${id}cd][${id}k]lut2=c0='clip(16+(x-16)*${k},16,235)':c1='clip(128+(x-128)*${k},16,240)':c2='clip(128+(x-128)*${k},16,240)'[${outL}]`,
  ];
}
