// Export engines: (1) ffmpeg.wasm (single-thread, no special headers needed), (2) real-time canvas + MediaRecorder.
import { FFmpeg } from './vendor/ffmpeg/index.js';
import { cssFilter, warmthColor, drawCaption, containRect, outputSize, ffColorFilter, clipColor, camAt, camFF, enhFF } from './render.js';

let ff = null;
const abs = (p) => new URL(p, location.href).href;
const extOf = (name, type) => (name.match(/\.(\w{2,4})$/)?.[1] || (type || '').split('/')[1] || 'mp4').toLowerCase();

async function getFF(onLog) {
  if (!ff) {
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
  onProgress(0, 'Loading ffmpeg engine (~31 MB, cached after first time)…');
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
  const total = clips.reduce((a, c) => a + (c.out - c.in), 0);
  const [W, H] = outputSize(clips, opts.res);
  const v = document.createElement('video');
  v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:-10px;top:-10px;width:2px;height:2px;opacity:0.01;pointer-events:none';
  document.body.appendChild(v);
  // prime element + audio graph inside the user gesture
  const first = media.get(clips[0].mediaId);
  v.src = first.url;
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  ac.resume();
  const src = ac.createMediaElementSource(v);
  const gain = ac.createGain();
  const dest = ac.createMediaStreamDestination();
  src.connect(gain).connect(dest);
  gain.gain.value = 0;
  const primed = v.play().catch(() => {}); // unlock playback while still inside the tap
  let cancelled = false;

  async function run() {
    const { onProgress = () => {} } = opts;
    await primed; v.pause();
    const mime = pickRecorderMime();
    if (mime === null) throw new Error('MediaRecorder not supported in this browser');
    const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const hasFilter = 'filter' in ctx;
    let filt = cssFilter(proj.color), cam = null, camP = 0;
    const warm = warmthColor(proj.color.w);
    const vstream = cv.captureStream(30);
    const stream = new MediaStream([...vstream.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    const rec = new MediaRecorder(stream, { mimeType: mime || undefined, videoBitsPerSecond: Math.round(W * H * 30 * 0.12), audioBitsPerSecond: 160000 });
    const chunks = [];
    rec.ondataavailable = e => e.data && e.data.size && chunks.push(e.data);
    const stopped = new Promise(r => rec.onstop = r);
    const caps = opts.burnCaptions ? proj.captions : [];
    const draw = (gt) => {
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      if (v.videoWidth) {
        if (hasFilter) ctx.filter = filt;
        const { z, cx, cy } = camAt(cam, camP);
        if (z > 1.0005) { // dynamic camera: draw the crop window of the letterboxed frame
          const [dx, dy, dw, dh] = containRect(v.videoWidth, v.videoHeight, W, H);
          const sw = W / z, sh = H / z, sx = cx * W - sw / 2, sy = cy * H - sh / 2;
          const k = W / sw;
          ctx.drawImage(v, (dx - sx) * k, (dy - sy) * k, dw * k, dh * k);
        } else ctx.drawImage(v, ...containRect(v.videoWidth, v.videoHeight, W, H));
        if (hasFilter) ctx.filter = 'none';
      }
      if (warm) { ctx.globalCompositeOperation = 'soft-light'; ctx.fillStyle = warm; ctx.fillRect(0, 0, W, H); ctx.globalCompositeOperation = 'source-over'; }
      for (const c of caps) if (gt >= c.start && gt < c.end) drawCaption(ctx, c, W, H);
    };
    let offset = 0, started = false;
    for (let i = 0; i < clips.length && !cancelled; i++) {
      const c = clips[i], m = media.get(c.mediaId);
      if (v.src !== m.url) v.src = m.url;
      await seekTo(v, c.in);
      filt = cssFilter(clipColor(proj, c)); cam = c.cam || null; camP = 0;
      gain.gain.value = c.muted ? 0 : 1;
      draw(offset);
      if (!started) { rec.start(1000); started = true; } else if (rec.state === 'paused') rec.resume();
      await v.play();
      await new Promise(res => {
        let done = false;
        const finish = () => { if (done) return; done = true; clearInterval(iv); v.removeEventListener('ended', finish); res(); };
        const tick = () => {
          if (done) return;
          if (cancelled) return finish();
          const gt = offset + (Math.min(v.currentTime, c.out) - c.in);
          camP = (Math.min(v.currentTime, c.out) - c.in) / Math.max(0.01, c.out - c.in);
          draw(gt);
          onProgress(Math.min(0.99, gt / total), `Recording ${Math.round(gt)}/${Math.round(total)} s (real-time)…`);
          if (v.currentTime >= c.out - 0.02 || v.ended) return finish();
          requestAnimationFrame(tick);
        };
        v.addEventListener('ended', finish);
        const iv = setInterval(() => { if (v.currentTime >= c.out - 0.02 || v.ended || cancelled) finish(); }, 100); // rAF stalls in background tabs
        tick();
      });
      v.pause();
      if (i < clips.length - 1 && rec.state === 'recording') rec.pause();
      offset += c.out - c.in;
    }
    if (rec.state !== 'inactive') rec.stop();
    await stopped;
    v.remove(); ac.close();
    if (cancelled) throw new Error('Cancelled');
    const type = (mime || chunks[0]?.type || 'video/webm').split(';')[0];
    onProgress(1, 'Done');
    return { blob: new Blob(chunks, { type }), ext: type.includes('mp4') ? 'mp4' : 'webm', W, H };
  }
  return { run, cancel: () => { cancelled = true; try { v.pause(); } catch {} } };
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
  const d = clips.map(c => Math.max(2 / FPS, q(c.out - c.in)));
  const xf = +proj.xfade || 0;
  const X = clips.slice(0, -1).map((c, j) => { const x = q(Math.min(xf, d[j] / 3, d[j + 1] / 3)); return x >= 3 / FPS ? x : 0; });
  const P = []; { let t = 0; for (const di of d) { P.push(t); t += di; } } // preview-timeline start of each clip
  const outTotal = d.reduce((a, b) => a + b, 0) - X.reduce((a, b) => a + b, 0);
  const [W, H] = outputSize(clips, opts.res);
  let logTail = [], collecting = null, pieceBase = 0, pieceLen = 1;
  onProgress(0, 'Loading ffmpeg engine (~31 MB, cached after first time)…');
  const f = await getFF((m) => {
    logTail.push(m); if (logTail.length > 40) logTail.shift();
    if (collecting) collecting.push(m);
    const t = /time=(\d+):(\d+):([\d.]+)/.exec(m);
    if (t) { const s = +t[1] * 3600 + +t[2] * 60 + +t[3]; onProgress(Math.min(0.97, (pieceBase + Math.min(s, pieceLen)) / outTotal * 0.97), 'Encoding…'); }
  });
  const ids = [...new Set(clips.map(c => c.mediaId))];
  const list = ids.map(id => { const m = media.get(id); if (!m) throw new Error('Missing media for a clip — re-import it.'); return { id, ...m }; });
  onProgress(0, 'Opening sources…');
  const { paths, mounted } = await mountSources(f, list);
  const hasAudio = new Map();
  for (const id of ids) {
    collecting = [];
    try { await f.exec(['-hide_banner', '-i', paths.get(id)]); } catch {}
    hasAudio.set(id, collecting.some(l => /Stream #.*Audio:/.test(l)));
    collecting = null;
  }
  // captions (preview-timeline times)
  const caps = opts.burnCaptions ? (proj.captions || []).filter(c => c.text && c.end > c.start) : [];
  for (let j = 0; j < caps.length; j++) await f.writeFile(`cap${j}.png`, await captionPng(caps[j], W, H));

  // video+audio chain for one portion of a clip -> labels
  const chain = (fc, inIdx, c, start, len, tag) => {
    const N = Math.round(len * FPS);
    const cam = c.cam && (c.cam.z0 > 1.001 || c.cam.z1 > 1.001) ? c.cam : null;
    const k = cam && !c.enh?.stab ? Math.min(2, Math.max(1, Math.min(c.w || W, c.h || H) / Math.min(W, H))) : 1;
    const NW = Math.round(W * k / 2) * 2, NH = Math.round(H * k / 2) * 2;
    const v = [`[${inIdx}:v]setpts=PTS-STARTPTS`, `fps=${FPS}`, `scale=${NW}:${NH}:force_original_aspect_ratio=decrease`, `pad=${NW}:${NH}:(ow-iw)/2:(oh-ih)/2:black`, 'setsar=1'];
    if (c.enh?.stab) v.push('deshake=rx=32:ry=32:edge=mirror');
    if (cam) v.push(camFF(cam, d[clips.indexOf(c)], start, W, H, FPS)); else if (NW !== W) v.push(`scale=${W}:${H}`);
    const en = enhFF(proj, c); if (en) v.push(en);
    v.push('setsar=1', 'format=yuv420p', `tpad=stop_mode=clone:stop_duration=1`, `trim=end_frame=${N}`, 'setpts=PTS-STARTPTS');
    fc.push(v.join(',') + `[v${tag}]`);
    if (hasAudio.get(c.mediaId) && !c.muted) fc.push(`[${inIdx}:a]asetpts=PTS-STARTPTS,aresample=44100,aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=duration=${(N / FPS).toFixed(4)}[a${tag}]`);
    else fc.push(`anullsrc=channel_layout=stereo:sample_rate=44100,atrim=duration=${(N / FPS).toFixed(4)}[a${tag}]`);
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
      onProgress(Math.min(0.97, pieceBase / outTotal * 0.97), `Shot ${i + 1}/${clips.length}…`);
      if (len >= 1 / FPS) {
        const args = ['-hide_banner', '-nostdin', '-ss', (c.in + s0).toFixed(3), '-t', (len + 0.5).toFixed(3), '-i', paths.get(c.mediaId)];
        const fc = []; chain(fc, 0, c, s0, len, 'b');
        const vl = addCaps(fc, args, 1, 'vb', P[i] + s0, len);
        await runPiece(args, fc, vl, 'ab', `p${pieces.length}.mkv`, len);
      }
      if (s1 > 0) { // crossfade into next shot
        const n = clips[i + 1];
        const args = ['-hide_banner', '-nostdin',
          '-ss', (c.in + d[i] - s1).toFixed(3), '-t', (s1 + 0.5).toFixed(3), '-i', paths.get(c.mediaId),
          '-ss', n.in.toFixed(3), '-t', (s1 + 0.5).toFixed(3), '-i', paths.get(n.mediaId)];
        const fc = [];
        chain(fc, 0, c, d[i] - s1, s1, 'x'); chain(fc, 1, n, 0, s1, 'y');
        fc.push(`[vx][vy]xfade=transition=fade:duration=${s1.toFixed(4)}:offset=0[vt]`, `[ax][ay]acrossfade=d=${s1.toFixed(4)}[at]`);
        const vl = addCaps(fc, args, 2, 'vt', P[i] + d[i] - s1, s1);
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
