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
