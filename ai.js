// Local "AI assist": silence / low-motion / black detection, auto color, transcript timing.
import { once } from './exporter.js';

// ---- audio: RMS dB per window (decoded at 8 kHz mono to save memory) ----
export async function audioLevels(blob, win = 0.1) {
  if (blob.size > 700 * 1024 * 1024) return null; // too big to decode in-browser safely
  const buf = await blob.arrayBuffer();
  let audio;
  try {
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new OAC(1, 1, 8000);
    audio = await new Promise((res, rej) => {
      const p = ctx.decodeAudioData(buf, res, rej);
      if (p && p.then) p.then(res, rej);
    });
  } catch { return null; } // no audio track or unsupported codec
  const sr = audio.sampleRate, n = Math.floor(win * sr);
  const chs = [...Array(audio.numberOfChannels)].map((_, i) => audio.getChannelData(i));
  const out = new Float32Array(Math.ceil(audio.length / n));
  for (let w = 0; w < out.length; w++) {
    let sum = 0, cnt = 0;
    for (const ch of chs) for (let i = w * n, e = Math.min(ch.length, i + n); i < e; i++) { sum += ch[i] * ch[i]; cnt++; }
    out[w] = 10 * Math.log10(sum / Math.max(1, cnt) + 1e-10);
  }
  return { db: out, win };
}

// ---- video: motion + luma per sample by seeking a hidden <video> ----
export async function videoStats(url, t0, t1, step, onTick, signal) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await once(v, 'loadedmetadata');
  const cw = 64, ch = 36;
  const cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  const res = [];
  let prev = null;
  for (let t = t0; t < t1; t += step) {
    if (signal?.aborted) break;
    v.currentTime = Math.min(t + step / 2, t1 - 0.01);
    await once(v, 'seeked');
    ctx.drawImage(v, 0, 0, cw, ch);
    const d = ctx.getImageData(0, 0, cw, ch).data;
    const g = new Float32Array(cw * ch);
    let luma = 0, sat = 0;
    for (let i = 0, j = 0; i < d.length; i += 4, j++) {
      const r = d[i], gg = d[i + 1], b = d[i + 2];
      g[j] = 0.299 * r + 0.587 * gg + 0.114 * b;
      luma += g[j];
      const mx = Math.max(r, gg, b), mn = Math.min(r, gg, b);
      sat += mx ? (mx - mn) / mx : 0;
    }
    luma /= g.length * 255; sat /= g.length;
    let motion = 0;
    if (prev) { for (let j = 0; j < g.length; j++) motion += Math.abs(g[j] - prev[j]); motion /= g.length * 255; }
    let sd = 0; const mean = luma * 255;
    for (let j = 0; j < g.length; j++) sd += (g[j] - mean) ** 2;
    sd = Math.sqrt(sd / g.length) / 255;
    res.push({ t, motion: prev ? motion : null, luma, sat, sd });
    prev = g;
    onTick && onTick((t - t0) / (t1 - t0));
  }
  if (res.length > 1) res[0].motion = res[1].motion;
  v.removeAttribute('src'); v.load();
  return res;
}

/**
 * Analyze one clip (media-time range clip.in..clip.out).
 * Returns regions [{start,end,reasons:Set}] in media time.
 */
export async function suggestCuts(clip, mediaRec, opts, onTick, signal) {
  const span = clip.out - clip.in;
  const step = Math.max(0.25, Math.min(2, span / 400));
  onTick && onTick(0, 'Listening for silence…');
  const audio = opts.mode === 'motion' ? null : await audioLevels(mediaRec.blob);
  onTick && onTick(0.05, 'Sampling frames…');
  const vs = opts.mode === 'silence' ? [] : await videoStats(mediaRec.url, clip.in, clip.out, step, f => onTick && onTick(0.05 + f * 0.95, 'Sampling frames…'), signal);
  // adaptive motion threshold: a fraction of the clip's median motion, with a floor
  const ms = vs.map(s => s.motion).filter(m => m != null).sort((a, b) => a - b);
  const med = ms.length ? ms[Math.floor(ms.length / 2)] : 0;
  const motionThr = Math.max(0.004, med * 0.25);
  const bins = [];
  for (let t = clip.in; t < clip.out; t += step) {
    const reasons = new Set();
    let silent = false;
    if (audio) {
      const a = Math.floor(t / audio.win), b = Math.ceil((t + step) / audio.win);
      let mx = -Infinity;
      for (let i = a; i < b && i < audio.db.length; i++) mx = Math.max(mx, audio.db[i]);
      silent = mx < opts.db;
    } else if (opts.mode !== 'motion') silent = false;
    const s = vs.find(x => Math.abs(x.t - t) < step / 2);
    const still = s ? s.motion != null && s.motion < motionThr : false;
    const black = s ? s.luma < 0.06 && s.sd < 0.03 : false;
    if (black) reasons.add('black');
    if (opts.mode === 'either') { if (silent) reasons.add('silence'); if (still) reasons.add('still'); }
    else if (opts.mode === 'both') { if (silent && still) { reasons.add('silence'); reasons.add('still'); } }
    else if (opts.mode === 'silence') { if (silent) reasons.add('silence'); }
    else if (opts.mode === 'motion') { if (still) reasons.add('still'); }
    bins.push({ t, end: Math.min(clip.out, t + step), reasons });
  }
  const regions = [];
  let cur = null;
  for (const b of bins) {
    if (b.reasons.size) {
      if (!cur) cur = { start: b.t, end: b.end, reasons: new Set(b.reasons) };
      else { cur.end = b.end; b.reasons.forEach(r => cur.reasons.add(r)); }
    } else if (cur) { regions.push(cur); cur = null; }
  }
  if (cur) regions.push(cur);
  return { regions: regions.filter(r => r.end - r.start >= opts.min), hadAudio: !!audio };
}

// ---- auto color: sample a few frames, nudge toward a balanced exposure ----
export async function autoColor(samples) {
  // samples: [{luma, sd, sat}]
  if (!samples.length) return null;
  const avg = k => samples.reduce((a, s) => a + s[k], 0) / samples.length;
  const L = avg('luma'), SD = avg('sd'), SAT = avg('sat');
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  return {
    b: +clamp((0.48 - L) * 0.7, -0.3, 0.35).toFixed(2),
    c: +clamp(0.22 / Math.max(0.05, SD), 0.9, 1.35).toFixed(2),
    s: +clamp(SAT < 0.22 ? 1.25 : SAT > 0.5 ? 0.95 : 1.1, 0.8, 1.4).toFixed(2),
    w: +(SAT < 0.3 ? 0.15 : 0).toFixed(2),
  };
}

// ---- transcript → timed captions ----
// Accepts SRT, lines like "[01:23] text" / "1:23 text", or plain text (spread across range by word count).
export function timeTranscript(text, t0, t1, parseSrt) {
  const srt = parseSrt(text);
  if (srt.length) return srt;
  const lines = text.replace(/\r/g, '').split('\n').map(l => l.trim()).filter(Boolean);
  const stamp = /^\[?(?:(\d+):)?(\d{1,2}):(\d{2}(?:\.\d+)?)\]?\s*[-–:]?\s*(.*)$/;
  if (lines.length && lines.every(l => stamp.test(l))) {
    const items = lines.map(l => { const m = stamp.exec(l); return { start: (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3], text: m[4] }; });
    return items.map((it, i) => ({ start: it.start, end: items[i + 1]?.start ?? Math.min(t1, it.start + 4), text: it.text }));
  }
  const words = text.split(/\s+/).filter(Boolean);
  const chunks = [];
  let cur = [];
  for (const w of words) { cur.push(w); if (cur.length >= 7 || /[.!?]$/.test(w)) { chunks.push(cur.join(' ')); cur = []; } }
  if (cur.length) chunks.push(cur.join(' '));
  const totalW = words.length || 1, span = Math.max(1, t1 - t0);
  let t = t0;
  return chunks.map(c => { const d = span * c.split(' ').length / totalW; const r = { start: t, end: t + d, text: c }; t += d; return r; });
}
