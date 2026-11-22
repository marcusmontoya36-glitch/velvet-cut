// Export engines: (1) ffmpeg.wasm (single-thread, no special headers needed), (2) real-time canvas + MediaRecorder.
import { FFmpeg } from './vendor/ffmpeg/index.js';
import { cssFilter, warmthColor, drawCaption, containRect, outputSize, ffColorFilter, clipColor, camAt, camFF, enhFF, xfadeDurations, warpFF, clipDur, fwdDur, clipSpeed, camP, srcAt, hasWarp, hasFish, programAudio } from './render.js';
import { createFx } from './fx.js';

let ff = null;
const abs = (p) => new URL(p, location.href).href;
const extOf = (name, type) => (name.match(/\.(\w{2,4})$/)?.[1] || (type || '').split('/')[1] || 'mp4').toLowerCase();

export const CORE_CACHE = 'vc-core-v1';
// Download the ~31 MB wasm core once with visible progress and keep it in a dedicated Cache Storage
// bucket that survives app updates (the service worker serves it cache-first from there).
async function warmCore(onP) {
  if (ff || !onP || typeof caches === 'undefined' || !navigator.serviceWorker?.controller) return;
  const url = abs('vendor/ffmpeg/core/ffmpeg-core.wasm');
  try {
    const cache = await caches.open(CORE_CACHE);
    if (await cache.match(url)) return;
    const res = await fetch(url);
    if (!res.ok || !res.body) return;
    const put = cache.put(url, res.clone());
    const total = 32.2e6; let got = 0;
    const rd = res.body.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; got += value.length; onP(Math.min(got, total), total); }
    await put;
  } catch (e) { console.warn('core warm-up failed', e); }
}
export async function preloadEngine(onP) { await warmCore(onP); }
export async function getFF(onLog, onStage) {
  if (!ff) {
    await warmCore(onStage && ((g, t) => onStage(`Loading engine… ${(g / 1048576).toFixed(0)} of ${(t / 1048576).toFixed(0)} MB (one time)`)));
    onStage && onStage('Starting engine…');
    ff = new FFmpeg();
    await ff.load({ coreURL: abs('vendor/ffmpeg/core/ffmpeg-core.js'), wasmURL: abs('vendor/ffmpeg/core/ffmpeg-core.wasm') });
  }
  ff.__onLog = onLog;
  if (!ff.__hooked) { ff.on('log', ({ message }) => ff.__onLog && ff.__onLog(message)); ff.__hooked = true; }
  return ff;
}
// Fast trim (stream copy, no re-encode) so cloud AI only receives the selected range.
export async function trimClip(blob, name, tin, tout) {
  const f = await getFF();
  const ext = extOf(name || '', blob.type);
  const src = `trim_in.${ext}`, dst = `trim_out.${ext === 'mov' ? 'mov' : 'mp4'}`;
  await f.writeFile(src, new Uint8Array(await blob.arrayBuffer()));
  try {
    const code = await f.exec(['-ss', String(tin), '-i', src, '-t', String(Math.max(0.1, tout - tin)), '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', dst]);
    if (code !== 0) throw new Error('trim failed');
    const data = await f.readFile(dst);
    return new Blob([data], { type: dst.endsWith('mov') ? 'video/quicktime' : 'video/mp4' });
  } finally {
    try { await f.deleteFile(src); } catch {}
    try { await f.deleteFile(dst); } catch {}
  }
}
export function cancelFF() { if (ff) { try { ff.terminate(); } catch {} ff = null; } }

async function captionPng(cap, W, H) {
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  drawCaption(cv.getContext('2d'), cap, W, H);
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * proj: {clips, captions, color}; media: Map(mediaId -> {blob,name,type})
 * opts: {res, crf, burnCaptions, onProgress(frac,msg)}
 */
export async function exportFF(proj, media, opts) {
  const { onProgress = () => {} } = opts;
  const clips = proj.clips;
  if (!clips.length) throw new Error('Timeline is empty');
  const total = clips.reduce((a, c) => a + (c.out - c.in), 0);
  let logTail = [];
  let collecting = null;
  onProgress(0, 'Loading engine…');
  const f = await getFF((m) => {
    logTail.push(m); if (logTail.length > 40) logTail.shift();
    if (collecting) collecting.push(m);
    const t = /time=(\d+):(\d+):([\d.]+)/.exec(m);
    if (t) onProgress(Math.min(0.99, (+t[1] * 3600 + +t[2] * 60 + +t[3]) / total), 'Encoding…');
  });

  // Write each source file once.
  const files = new Map();
  const ids = [...new Set(clips.map(c => c.mediaId))];
  for (let i = 0; i < ids.length; i++) {
    const m = media.get(ids[i]);
    if (!m) throw new Error('Missing media for a clip — re-import it.');
    const name = `in${i}.${extOf(m.name, m.type)}`;
    onProgress(0, `Loading source ${i + 1}/${ids.length} into encoder…`);
    await f.writeFile(name, new Uint8Array(await m.blob.arrayBuffer()));
    // probe for an audio stream
    collecting = [];
    try { await f.exec(['-hide_banner', '-i', name]); } catch {}
    const hasAudio = collecting.some(l => /Stream #.*Audio:/.test(l));
    collecting = null;
    files.set(ids[i], { name, hasAudio });
  }

  const [W, H] = outputSize(clips, opts.res);
  const args = ['-hide_banner', '-nostdin'];
  clips.forEach(c => {
    args.push('-ss', c.in.toFixed(3), '-t', (c.out - c.in).toFixed(3), '-i', files.get(c.mediaId).name);
  });
  const caps = opts.burnCaptions ? proj.captions.filter(c => c.text && c.end > c.start && c.start < total) : [];
  for (let j = 0; j < caps.length; j++) {
    const name = `cap${j}.png`;
    await f.writeFile(name, await captionPng(caps[j], W, H));
    args.push('-i', name);
  }
  const fc = [];
  let concatIn = '';
  clips.forEach((c, i) => {
    const d = (c.out - c.in).toFixed(3);
    fc.push(`[${i}:v]setpts=PTS-STARTPTS,scale=${W}:${H}:force_original_aspect_ratio=decrease,pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p,trim=duration=${d}[v${i}]`);
    if (files.get(c.mediaId).hasAudio && !c.muted) {
      fc.push(`[${i}:a]asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${d}[a${i}]`);
    } else {
      fc.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${d}[a${i}]`);
    }
    concatIn += `[v${i}][a${i}]`;
  });
  fc.push(`${concatIn}concat=n=${clips.length}:v=1:a=1[cv][ca]`);
  let last = 'cv';
  const col = ffColorFilter(proj.color);
  if (col) { fc.push(`[${last}]${col}[cc]`); last = 'cc'; }
  caps.forEach((cap, j) => {
    const idx = clips.length + j;
    fc.push(`[${last}][${idx}:v]overlay=0:0:eof_action=repeat:enable='between(t,${cap.start.toFixed(2)},${cap.end.toFixed(2)})'[o${j}]`);
    last = `o${j}`;
  });
  fc.push(`[${last}]format=yuv420p[outv]`);
  args.push('-filter_complex', fc.join(';'), '-map', '[outv]', '-map', '[ca]',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(opts.crf || 23), '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', '-t', total.toFixed(3), 'out.mp4');
  onProgress(0.01, `Encoding ${W}×${H}…`);
  const code = await f.exec(args);
  if (code !== 0) throw new Error('ffmpeg failed (code ' + code + '): ' + logTail.slice(-6).join(' | '));
  const data = await f.readFile('out.mp4');
  // clean FS
  for (const v of files.values()) try { await f.deleteFile(v.name); } catch {}
  for (let j = 0; j < caps.length; j++) try { await f.deleteFile(`cap${j}.png`); } catch {}
  try { await f.deleteFile('out.mp4'); } catch {}
  onProgress(1, 'Done');
  return { blob: new Blob([data.buffer], { type: 'video/mp4' }), ext: 'mp4', W, H, args };
}

// ---------- Real-time export (canvas + MediaRecorder). Works where ffmpeg.wasm is too heavy (iPhone). ----------
export function pickRecorderMime() {
  const c = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1.42E01F,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a',
    'video/mp4;codecs=avc1.42E01E,opus', 'video/mp4',
    'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
  if (typeof MediaRecorder === 'undefined') return null;
  return c.find(m => MediaRecorder.isTypeSupported(m)) || '';
}

export function createRealtimeExport(proj, media, opts) {
  const clips = proj.clips;
  const [W, H] = outputSize(clips, opts.res);
  const X = xfadeDurations(clips, proj.xfade || 0);
  const total = clips.reduce((a, c) => a + clipDur(c), 0) - X.reduce((a, b) => a + b, 0);
  const black = proj.xfadeType === 'black';
  // two players so the next shot can start under the outgoing one (crossfade)
  const mk = () => {
    const v = document.createElement('video');
    v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
    v.style.cssText = 'position:fixed;left:0;top:0;width:2px;height:2px;opacity:0.01;pointer-events:none';
    document.body.appendChild(v); return v;
  };
  const vids = [mk(), mk()];
  vids[0].src = media.get(clips[0].mediaId).url;
  vids[1].src = media.get((clips[1] || clips[0]).mediaId).url;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  ac.resume();
  const dest = ac.createMediaStreamDestination();
  const gains = vids.map(v => { const s = ac.createMediaElementSource(v), g = ac.createGain(); g.gain.value = 0; s.connect(g).connect(dest); return g; });
  const primed = Promise.all(vids.map(v => v.play().catch(() => {}))); // unlock both inside the tap (iOS)
  let cancelled = false;

  async function run() {
    const { onProgress = () => {} } = opts;
    await primed; vids.forEach(v => v.pause());
    const mime = pickRecorderMime();
    if (mime === null) throw new Error('MediaRecorder not supported in this browser');
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const hasFilter = 'filter' in ctx;
    const warm = warmthColor(proj.color.w);
    const vstream = cv.captureStream(30);
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: Math.round(W * H * 30 * 0.12), audioBitsPerSecond: 160000 });
    const chunks = [];
    rec.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise(r => rec.onstop = r);
    const caps = opts.burnCaptions ? proj.captions : [];
    // WebGL draws every shot with the full camera look (crop, high/low angle, dutch tilt, fisheye, mirror)
    let fx = null;
    try { const gc = document.createElement('canvas'); gc.width = W; gc.height = H; fx = createFx(gc); } catch (e) { console.warn('WebGL unavailable, angles/fisheye skipped in real-time export', e); }
    // boomerang: frames captured on the way forward are drawn backwards
    const caches = new Map();
    const capture = (v, c) => {
      if (!c.boom || !v.videoWidth) return;
      let arr = caches.get(c.id); if (!arr) caches.set(c.id, arr = []);
      const t = v.currentTime; if (arr.length && t <= arr[arr.length - 1].t + 0.02) return;
      const cw = Math.min(800, v.videoWidth), ch = Math.round(cw * v.videoHeight / v.videoWidth);
      const cv2 = document.createElement('canvas'); cv2.width = cw; cv2.height = ch; cv2.getContext('2d').drawImage(v, 0, 0, cw, ch);
      arr.push({ t, cv: cv2 });
    };
    const frameAt = (c, t) => { const arr = caches.get(c.id) || []; let b = arr[0]; for (const f of arr) if (Math.abs(f.t - t) < Math.abs(b.t - t)) b = f; return b?.cv; };
    const localOf = (v, c) => (Math.min(v.currentTime, c.out) - c.in) / clipSpeed(c);
    const drawClip = (src, c, alpha, l) => {
      const sw = src.videoWidth || src.width, sh = src.videoHeight || src.height;
      if (!sw || alpha <= 0) return;
      const p = camP(c, l);
      ctx.save();
      ctx.globalAlpha = alpha;
      if (hasFilter) ctx.filter = cssFilter(clipColor(proj, c));
      if (fx && fx.draw(src, sw, sh, c.cam || null, p)) ctx.drawImage(fx.canvas, 0, 0, W, H);
      else {
        if (c.cam?.flip) { ctx.translate(W, 0); ctx.scale(-1, 1); }
        const { z, cx, cy } = camAt(c.cam || null, p);
        const [dx, dy, dw, dh] = containRect(sw, sh, W, H);
        if (z > 1.0005) { const ww = W / z, hh = H / z, sx = cx * W - ww / 2, sy = cy * H - hh / 2, k = W / ww; ctx.drawImage(src, (dx - sx) * k, (dy - sy) * k, dw * k, dh * k); }
        else ctx.drawImage(src, dx, dy, dw, dh);
      }
      ctx.restore();
    };
    const prep = async (v, c) => {
      const url = media.get(c.mediaId).url;
      if (v.src !== url) { v.src = url; await once(v, 'loadedmetadata').catch(() => {}); }
      v.playbackRate = clipSpeed(c);
      await seekTo(v, c.in);
    };
    let offset = 0, started = false, nextStarted = false;
    await prep(vids[0], clips[0]);
    for (let i = 0; i < clips.length && !cancelled; i++) {
      const c = clips[i], cur = vids[i % 2], nxt = vids[(i + 1) % 2], n = clips[i + 1];
      const Xi = X[i] || 0, vol = c.muted ? 0 : 1, D = clipDur(c), F = fwdDur(c);
      cur.playbackRate = clipSpeed(c);
      if (!nextStarted) {
        if (!started) { rec.start(1000); started = true; } else if (rec.state === 'paused') rec.resume();
        await cur.play();
      }
      nextStarted = false;
      // get the following shot ready (seeked, paused) while this one plays
      let nextReady = false;
      const nextPrep = n ? prep(nxt, n).then(() => { nextReady = true; }).catch(() => {}) : null;
      let rev = null; // boomerang reverse phase: performance.now() when it started
      let l = 0;
      await new Promise(res => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearInterval(iv); res(); };
        const tick = () => {
          if (done) return;
          if (cancelled) return finish();
          if (rev == null) {
            l = localOf(cur, c);
            if (c.boom && (cur.currentTime >= c.out - 0.02 || cur.ended)) { capture(cur, c); cur.pause(); rev = performance.now() - Math.max(0, l - F) * 1000; }
          }
          if (rev != null) l = F + (performance.now() - rev) / 1000;
          const rem = D - l;
          if (n && Xi > 0 && rem <= Xi && !nextStarted && nextReady) { nextStarted = true; nxt.playbackRate = clipSpeed(n); nxt.play().catch(() => {}); }
          const a = nextStarted ? Math.max(0, Math.min(1, 1 - rem / Xi)) : 0;
          ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
          if (rev == null) capture(cur, c);
          const curSrc = rev != null ? frameAt(c, srcAt(c, l)) : cur;
          const ln = nextStarted ? localOf(nxt, n) : 0;
          if (nextStarted) capture(nxt, n);
          if (curSrc) {
            if (black) { drawClip(curSrc, c, a < 0.5 ? 1 - 2 * a : 0, l); if (nextStarted) drawClip(nxt, n, a > 0.5 ? 2 * a - 1 : 0, ln); }
            else { drawClip(curSrc, c, 1, l); if (nextStarted) drawClip(nxt, n, a, ln); }
          }
          if (warm) { ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = warm; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; }
          const gt = offset + l;
          for (const cp of caps) if (gt >= cp.start && gt < cp.end) drawCaption(ctx, cp, W, H);
          gains[i % 2].gain.value = rev != null ? 0 : vol * (1 - a);
          if (nextStarted) gains[(i + 1) % 2].gain.value = (n.muted ? 0 : 1) * a;
          onProgress(Math.min(0.99, gt / total), `Recording ${Math.round(gt)}/${Math.round(total)} s (real-time)…`);
          if (l >= D - 0.02 || (!c.boom && (cur.currentTime >= c.out - 0.02 || cur.ended))) return finish();
          requestAnimationFrame(tick);
        };
        // rAF stalls in background tabs: the interval keeps the clock moving
        const iv = setInterval(() => { if (cancelled) finish(); else if (!c.boom && (cur.currentTime >= c.out - 0.02 || cur.ended)) finish(); }, 100);
        tick();
      });
      cur.pause(); gains[i % 2].gain.value = 0; caches.delete(c.id);
      offset += D - (nextStarted ? Math.max(0, localOf(nxt, n)) : 0);
      if (n && !nextStarted) { // no crossfade (or next wasn't ready): pause recording while it loads
        if (rec.state === 'recording') rec.pause();
        await nextPrep;
      }
    }
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    vids.forEach(v => v.remove()); ac.close();
    if (cancelled) throw new Error('Cancelled');
    const type = (mime || chunks[0]?.type || 'video/webm').split(';')[0];
    onProgress(1, 'Done');
    return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm', W, H };
  }
  return { run, cancel: () => { cancelled = true; vids.forEach(v => { try { v.pause(); } catch {} }); } };
}

export async function seekTo(v, t) {
  if (v.readyState < 1) await once(v, 'loadedmetadata');
  if (Math.abs(v.currentTime - t) < 0.01 && v.readyState >= 2) return;
  const p = once(v, 'seeked');
  v.currentTime = t;
  await Promise.race([p, new Promise(r => setTimeout(r, 4000))]);
}

export function once(el, ev) {
  return new Promise((res, rej) => {
    const ok = () => { cleanup(); res(); };
    const bad = () => { cleanup(); rej(new Error('Media error: ' + (el.error?.message || el.error?.code || ev))); };
    const cleanup = () => { el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });
}

// ---------- Chunked export (memory-safe, used by Auto Edit and the main ffmpeg export) ----------
// Sources are mounted read-only with WORKERFS (no copy into wasm memory). Each shot body and each
// crossfade transition is encoded as its own small piece with per-clip enhance + dynamic camera,
// then pieces are joined with the concat demuxer (video stream-copied, audio re-encoded once to AAC).
async function mountSources(f, list) {
  // list: [{id, blob, name, type}] -> Map(id -> path)
  const paths = new Map();
  try {
    try { await f.createDir('/src'); } catch {}
    const blobs = list.map((m, i) => ({ name: `m${i}.${extOf(m.name, m.type)}`, data: m.blob }));
    await f.mount('WORKERFS', { blobs }, '/src');
    list.forEach((m, i) => paths.set(m.id, `/src/${blobs[i].name}`));
    return { paths, mounted: true };
  } catch (e) {
    console.warn('WORKERFS mount failed, copying into memory', e);
    for (let i = 0; i < list.length; i++) {
      const name = `in${i}.${extOf(list[i].name, list[i].type)}`;
      await f.writeFile(name, new Uint8Array(await list[i].blob.arrayBuffer()));
      paths.set(list[i].id, name);
    }
    return { paths, mounted: false };
  }
}

export async function exportChunked(proj, media, opts) {
  const { onProgress = () => {} } = opts;
  const clips = proj.clips;
  if (!clips.length) throw new Error('Timeline is empty');
  const FPS = 30, q = (x) => Math.round(x * FPS) / FPS;
  const d = clips.map(c => Math.max(2 / FPS, q(clipDur(c))));
  const xf = +proj.xfade || 0;
  const X = xfadeDurations(clips, xf, FPS);
  const xfType = proj.xfadeType === 'black' ? 'fadeblack' : 'fade';
  const P = []; { let t = 0; for (const di of d) { P.push(t); t += di; } } // preview-timeline start of each clip
  const outTotal = d.reduce((a, b) => a + b, 0) - X.reduce((a, b) => a + b, 0);
  const [W, H] = outputSize(clips, opts.res);
  let logTail = [], collecting = null, pieceBase = 0, pieceLen = 1;
  onProgress(0, ff ? 'Starting…' : 'Loading engine…');
  let stage = 'Encoding…';
  const f = await getFF((m) => {
    logTail.push(m); if (logTail.length > 40) logTail.shift();
    if (collecting) collecting.push(m);
    const t = /time=(\d+):(\d+):([\d.]+)/.exec(m);
    if (t) { const s = +t[1] * 3600 + +t[2] * 60 + +t[3]; onProgress(Math.min(0.97, (pieceBase + Math.min(s, pieceLen)) / outTotal * 0.97), stage); }
  }, (msg) => onProgress(0, msg));
  const progA = (c) => programAudio(c, media); // multi-cam: sound from the master camera
  const ids = [...new Set(clips.flatMap(c => [c.mediaId, progA(c)?.mediaId].filter(Boolean)))];
  const list = ids.map(id => { const m = media.get(id); if (!m) throw new Error('Missing media for a clip — re-import it.'); return { id, ...m }; });
  onProgress(0, 'Opening sources…');
  const { paths, mounted } = await mountSources(f, list);
  const hasAudio = new Map(), srcFps = new Map();
  for (const id of ids) {
    collecting = [];
    try { await f.exec(['-hide_banner', '-i', paths.get(id)]); } catch {}
    hasAudio.set(id, collecting.some(l => /Stream #.*Audio:/.test(l)));
    const vl = collecting.find(l => /Stream #.*Video:/.test(l)) || '';
    srcFps.set(id, +(/([\d.]+) fps/.exec(vl)?.[1] || /([\d.]+) tbr/.exec(vl)?.[1] || 30));
    collecting = null;
  }
  // source window to read for timeline portion [start, start+len] of a clip -> ['-ss', a, '-t', b]
  const srcWin = (c, start, len, shift = 0) => {
    if (c.boom) return ['-ss', c.in.toFixed(3), '-t', (c.out - c.in + 0.3).toFixed(3)];
    const sp = clipSpeed(c);
    // video inputs seek 1 ms early so a frame sitting exactly on the in point isn't dropped by rounding
    const at = c.in + shift + start * sp - (shift ? 0 : 0.001);
    return ['-ss', Math.max(0, at).toFixed(4), '-t', (len * sp + 0.5).toFixed(3)];
  };
  const slowMode = proj.slowmo || 'fast';
  // captions (preview-timeline times)
  const caps = opts.burnCaptions ? (proj.captions || []).filter(c => c.text && c.end > c.start) : [];
  for (let j = 0; j < caps.length; j++) await f.writeFile(`cap${j}.png`, await captionPng(caps[j], W, H));

  // video+audio chain for one portion of a clip -> labels
  // boomerangs: the forward part is rendered with the camera, then reversed (reads exactly like the preview)
  const chain = (fc, inIdx, c, start, len, tag, aIdx = inIdx) => {
    const N = Math.round(len * FPS);
    const sp = clipSpeed(c), boom = !!c.boom;
    const interp = sp < 0.999 && srcFps.get(c.mediaId) * sp < 29; // slow motion that needs new in-between frames
    const cam = c.cam && (c.cam.z0 > 1.001 || c.cam.z1 > 1.001) ? c.cam : null;
    let k = cam && !c.enh?.stab ? Math.min(2, Math.max(1, Math.min(c.w || W, c.h || H) / Math.min(W, H))) : 1;
    if (interp && slowMode === 'smooth') k = 1; // motion interpolation is the slow part: run it at output size
    const NW = Math.round(W * k / 2) * 2, NH = Math.round(H * k / 2) * 2;
    const v = [`[${inIdx}:v]setpts=PTS-STARTPTS`];
    if (sp < 0.999) v.push(`setpts=PTS/${sp.toFixed(4)}`);
    if (!interp) v.push(`fps=${FPS}`);
    v.push(`scale=${NW}:${NH}:force_original_aspect_ratio=decrease`, `pad=${NW}:${NH}:(ow-iw)/2:(oh-ih)/2:black`, 'setsar=1');
    if (interp) v.push(slowMode === 'smooth' ? `minterpolate=fps=${FPS}:mi_mode=mci:mc_mode=obmc:me_mode=bilat:me=epzs:search_param=16` : `framerate=fps=${FPS}`, `fps=${FPS}`);
    if (c.enh?.stab) v.push('deshake=rx=32:ry=32:edge=mirror');
    const F = fwdDur(c);
    if (cam) v.push(camFF(cam, boom ? F : d[clips.indexOf(c)], boom ? 0 : start, W, H, FPS)); else if (NW !== W) v.push(`scale=${W}:${H}`);
    const wf = c.cam ? warpFF(c.cam, W, H) : ''; if (wf) v.push(wf);
    if (c.cam?.flip) v.push('hflip');
    const en = enhFF(proj, c); if (en) v.push(en);
    if (boom) {
      const Nf = Math.max(2, Math.round(F * FPS)), s0 = Math.round(start * FPS);
      v.push('setsar=1', 'format=yuv420p', 'tpad=stop_mode=clone:stop_duration=1', `trim=end_frame=${Nf}`, 'setpts=PTS-STARTPTS', 'split');
      fc.push(v.join(',') + `[f${tag}][g${tag}]`, `[g${tag}]reverse[r${tag}]`,
        `[f${tag}][r${tag}]concat=n=2:v=1:a=0,trim=start_frame=${s0}:end_frame=${s0 + N},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=1,trim=end_frame=${N},setpts=PTS-STARTPTS,fps=${FPS},settb=1/${FPS}[v${tag}]`);
    } else {
      v.push('setsar=1', 'format=yuv420p', `tpad=stop_mode=clone:stop_duration=1`, `trim=end_frame=${N}`, 'setpts=PTS-STARTPTS', `settb=1/${FPS}`);
      fc.push(v.join(',') + `[v${tag}]`);
    }
    const ad = (N / FPS).toFixed(4);
    const aSrc = aIdx !== inIdx ? progA(c).mediaId : c.mediaId;
    if (hasAudio.get(aSrc) && !c.muted) {
      const a = [`[${aIdx}:a]asetpts=PTS-STARTPTS`, 'aresample=44100', 'aformat=sample_fmts=fltp:channel_layouts=stereo'];
      if (sp < 0.999) a.push(`atempo=${Math.max(0.5, sp).toFixed(4)}`);
      if (boom) a.push(`atrim=duration=${F.toFixed(4)}`, `afade=t=out:st=${Math.max(0, F - 0.15).toFixed(3)}:d=0.15`, 'apad', `atrim=start=${start.toFixed(4)}:duration=${ad}`, 'asetpts=PTS-STARTPTS');
      else a.push('apad', `atrim=duration=${ad}`);
      fc.push(a.join(',') + `[a${tag}]`);
    } else fc.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${ad}[a${tag}]`);
  };
  const addCaps = (fc, args, nInputs, vlab, G, len) => {
    let last = vlab, n = nInputs;
    caps.forEach((cap, j) => {
      const a = cap.start - G, b = cap.end - G;
      if (b <= 0 || a >= len) return;
      args.push('-i', `cap${j}.png`);
      fc.push(`[${last}][${n}:v]overlay=0:0:eof_action=repeat:enable='between(t,${a.toFixed(3)},${b.toFixed(3)})'[c${n}]`);
      last = `c${n}`; n++;
    });
    return last;
  };
  // cap the bitrate so output size (and wasm memory) stays predictable: ~6 Mb/s at 720p, ~13 Mb/s at 1080p
  const maxr = Math.round(W * H * 6.5 * (opts.crf && opts.crf <= 19 ? 1.5 : opts.crf >= 28 ? 0.6 : 1));
  const enc = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', String(opts.crf || 23), '-maxrate', String(maxr), '-bufsize', String(maxr * 2),
    '-pix_fmt', 'yuv420p', '-r', String(FPS),
    '-c:a', 'pcm_s16le', '-ar', '44100', '-ac', '2'];
  const pieces = [];
  const runPiece = async (args, fc, vl, al, name, len) => {
    args.push('-filter_complex', fc.join(';'), '-map', `[${vl}]`, '-map', `[${al}]`, ...enc, name);
    pieceLen = len;
    const code = await f.exec(args);
    if (code !== 0) throw new Error('ffmpeg failed (code ' + code + '): ' + logTail.slice(-6).join(' | '));
    pieces.push(name); pieceBase += len;
  };
  try {
    for (let i = 0; i < clips.length; i++) {
      const c = clips[i];
      const s0 = i > 0 ? X[i - 1] : 0, s1 = i < X.length ? X[i] : 0;
      const len = q(d[i] - s0 - s1);
      stage = `Encoding shot ${i + 1} of ${clips.length}…`;
      onProgress(Math.min(0.97, pieceBase / outTotal * 0.97), stage);
      if (len >= 1 / FPS) {
        const args = ['-hide_banner', '-nostdin', ...srcWin(c, s0, len), '-i', paths.get(c.mediaId)];
        const pa = progA(c); if (pa) args.push(...srcWin(c, s0, len, pa.off), '-i', paths.get(pa.mediaId));
        const fc = []; chain(fc, 0, c, s0, len, 'b', pa ? 1 : 0);
        const vl = addCaps(fc, args, pa ? 2 : 1, 'vb', P[i] + s0, len);
        await runPiece(args, fc, vl, 'ab', `p${pieces.length}.mkv`, len);
      }
      if (s1 > 0) { // crossfade into next shot
        const n = clips[i + 1];
        const args = ['-hide_banner', '-nostdin',
          ...srcWin(c, d[i] - s1, s1), '-i', paths.get(c.mediaId),
          ...srcWin(n, 0, s1), '-i', paths.get(n.mediaId)];
        const fc = [];
        let ni = 2; const pc = progA(c), pn = progA(n);
        const ac = pc ? ni++ : 0; if (pc) args.push(...srcWin(c, d[i] - s1, s1, pc.off), '-i', paths.get(pc.mediaId));
        const an = pn ? ni++ : 1; if (pn) args.push(...srcWin(n, 0, s1, pn.off), '-i', paths.get(pn.mediaId));
        chain(fc, 0, c, d[i] - s1, s1, 'x', ac); chain(fc, 1, n, 0, s1, 'y', an);
        fc.push(`[vx][vy]xfade=transition=${xfType}:duration=${s1.toFixed(4)}:offset=0[vt]`, `[ax][ay]acrossfade=d=${s1.toFixed(4)}[at]`);
        stage = `Crossfade ${i + 1}→${i + 2}…`;
        const vl = addCaps(fc, args, ni, 'vt', P[i] + d[i] - s1, s1);
        await runPiece(args, fc, vl, 'at', `p${pieces.length}.mkv`, s1);
      }
    }
    onProgress(0.97, 'Joining shots…');
    await f.writeFile('list.txt', new TextEncoder().encode(pieces.map(p => `file '${p}'`).join('\n')));
    const code = await f.exec(['-hide_banner', '-nostdin', '-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c:v', 'copy', '-tag:v', 'avc1',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', 'out.mp4']);
    if (code !== 0) throw new Error('join failed: ' + logTail.slice(-6).join(' | '));
    for (const p of pieces) try { await f.deleteFile(p); } catch {}
    pieces.length = 0;
    const data = await f.readFile('out.mp4');
    try { await f.deleteFile('out.mp4'); } catch {}
    onProgress(1, 'Done');
    return { blob: new Blob([data.buffer], { type: 'video/mp4' }), ext: 'mp4', W, H, duration: outTotal };
  } finally {
    for (const p of pieces) try { await f.deleteFile(p); } catch {}
    for (let j = 0; j < caps.length; j++) try { await f.deleteFile(`cap${j}.png`); } catch {}
    try { await f.deleteFile('list.txt'); } catch {}
    if (mounted) { try { await f.unmount('/src'); } catch {} }
    else for (const p of paths.values()) try { await f.deleteFile(p); } catch {}
  }
}
