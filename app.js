import * as DB from './db.js';
import { shadowAmt, cssFilter, warmthColor, fmtTime, toSrt, parseSrt, outputSize, FONT_STACK, clipColor, camCss, xfadeDurations, containRect, camAt, clipDur, fwdDur, clipSpeed, srcAt, camP, hasFish, outToCrop, cropToOut, programAudio, viewCrop, clipCrop, CROP_ASPECTS } from './render.js';
import { audioFeatures, groupClips, planMulticam, camsCovering, addAngleReplays, replaySequence } from './multicam.js';
import { createFx } from './fx.js';
import { exportChunked, cancelFF, createRealtimeExport, once } from './exporter.js';
import { canRemux, remuxExport, wcBlocker, createWcExport, videoColor } from './wcexport.js';
import { analyzeRange, planEdit, planCamera, enhanceFor, orderShots, readCaptureTime, loadAutoSettings, saveAutoSettings, unlockAnalysis, camFor, subjectOf, subjectFromFocus, LEVELS, CAM_TYPES, trackPoint, makeTemplate, grayOf, parseXf, xfValue, lookOf, extendShots, editLength, setFraming } from './autoedit.js';
import { loadPose, poseStatus, fitCam, shotKeys, protectedOf, boxUnion, TIGHTNESS, classifyPov, hideKeys, fitHide } from './framing.js';
import { suggestCuts, videoStats, autoColor, timeTranscript } from './ai.js';
import { loadAI, saveAI, HOOKS, providerReady, runHook } from './hooks.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;

const newProject = () => ({ id: uid(), name: 'Untitled project', clips: [], captions: [], color: { b: 0, c: 1, s: 1, w: 0 }, xfade: 0.5, xfadeType: 'fade', focus: {}, created: Date.now(), updated: Date.now() });
const S = {
  proj: newProject(), media: new Map(), sel: null, selCap: null, t: 0, playing: false, idx: -1,
  pxs: 30, mutedAll: false, sugg: [], undo: [], redo: [], switching: false, exportJob: null, analysis: new Map(), autoJob: null, xf: null, focusMode: false,
  mcFeat: new Map(), // mediaId -> audio sync features (or null = no usable sound), this session only
  mcDiag: new Map(), // mediaId -> { via, tried:[{via, err}], tracks, level, ms } how its sound was read (sync report)
};
window.__S = S; // handy for debugging

// ---------------- helpers ----------------
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('show'), ms); }
function modal(title, bodyEl, buttons = [{ label: 'Close' }]) {
  return new Promise((res) => {
    $('#mTitle').textContent = title;
    const body = $('#mBody'); body.innerHTML = '';
    if (typeof bodyEl === 'string') body.innerHTML = bodyEl; else body.appendChild(bodyEl);
    const bb = $('#mBtns'); bb.innerHTML = '';
    for (const b of buttons) {
      const el = document.createElement('button'); el.textContent = b.label; if (b.cls) el.className = b.cls;
      el.onclick = async () => { if (b.onClick && (await b.onClick()) === false) return; $('#modal').classList.remove('show'); res(b.value); };
      bb.appendChild(el);
    }
    $('#modal').classList.add('show');
  });
}
const closeModal = () => $('#modal').classList.remove('show');
const html = (s) => { const d = document.createElement('div'); d.innerHTML = s; return d; };
const esc = (s) => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const clips = () => S.proj.clips;
const total = () => clips().reduce((a, c) => a + clipDur(c), 0);
function starts() { let t = 0; return clips().map(c => { const s = t; t += clipDur(c); return s; }); }
function locate(t) {
  const st = starts(), cs = clips();
  for (let i = 0; i < cs.length; i++) { const d = clipDur(cs[i]); if (t < st[i] + d - 1e-4 || i === cs.length - 1) return { idx: i, local: clamp(t - st[i], 0, d) }; }
  return { idx: -1, local: 0 };
}
const selClip = () => clips().find(c => c.id === S.sel);
const selCap = () => S.proj.captions.find(c => c.id === S.selCap);

// ---------------- undo / mutate / autosave ----------------
const snap = () => JSON.stringify({ clips: S.proj.clips, captions: S.proj.captions, color: S.proj.color, xfade: S.proj.xfade || 0, xfadeType: S.proj.xfadeType || 'fade', focus: S.proj.focus || {}, autoCuts: S.proj.autoCuts || [], autoEnh: S.proj.autoEnh || {}, mc: S.proj.mc || null });
function mutate(fn, { render = true } = {}) {
  S.undo.push(snap()); if (S.undo.length > 80) S.undo.shift(); S.redo = [];
  fn();
  afterChange(render);
}
function restore(js) { const o = JSON.parse(js); Object.assign(S.proj, o); }
function undo() { if (!S.undo.length) return toast('Nothing to undo'); S.redo.push(snap()); restore(S.undo.pop()); afterChange(true); }
function redo() { if (!S.redo.length) return; S.undo.push(snap()); restore(S.redo.pop()); afterChange(true); }
function afterChange(render) {
  S.proj.updated = Date.now();
  S.t = clamp(S.t, 0, total());
  if (render) renderAll();
  scheduleSave();
}
let saveT;
function scheduleSave() { clearTimeout(saveT); saveT = setTimeout(() => saveProject(true), 1200); }
async function saveProject(silent) {
  if (!S.proj.clips.length && !S.proj.captions.length && silent) return;
  try {
    S.proj.name = $('#projName').value.trim() || 'Untitled project';
    await DB.putProject(JSON.parse(JSON.stringify(S.proj)));
    localStorage.setItem('vc.last', S.proj.id);
    if (!silent) toast('Saved on this device ✓');
  } catch (e) { toast('Save failed: ' + e.message, 5000); }
}

// ---------------- media import ----------------
// Import is instant: object URL + metadata only. The poster frame, capture time and saving to IndexedDB
// happen in the background, and nothing here touches ffmpeg or seeks through the video.
function waitEv(el, ev, ms) {
  return new Promise((res, rej) => {
    const ok = () => { done(); res(true); }, bad = () => { done(); rej(new Error('Media error ' + (el.error?.code || ''))); };
    const to = setTimeout(() => { done(); rej(new Error('timeout:' + ev)); }, ms);
    const done = () => { clearTimeout(to); el.removeEventListener(ev, ok); el.removeEventListener('error', bad); };
    el.addEventListener(ev, ok); el.addEventListener('error', bad);
  });
}
async function probe(url) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'metadata';
  try {
    const p = waitEv(v, 'loadedmetadata', 12000); v.src = url; await p;
    let duration = v.duration;
    if (!isFinite(duration)) { // MediaRecorder webm: force duration
      try { const q = waitEv(v, 'seeked', 3000); v.currentTime = 1e7; await q; } catch {}
      duration = isFinite(v.duration) ? v.duration : v.currentTime;
    }
    return { duration, w: v.videoWidth, h: v.videoHeight };
  } finally { v.removeAttribute('src'); v.load(); }
}
// Poster frame without seeking: a media fragment (#t=) makes Safari render that frame; fallback = muted play.
async function posterFrame(url) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.setAttribute('playsinline', ''); v.preload = 'auto';
  v.style.cssText = 'position:fixed;left:0;bottom:0;width:32px;height:18px;opacity:0.01;pointer-events:none;z-index:-1';
  document.body.appendChild(v);
  try {
    const p = waitEv(v, 'loadeddata', 2500); v.src = url + '#t=0.15';
    try { await p; } catch {
      try { const pp = v.play(); await Promise.race([pp, new Promise((_, r) => setTimeout(() => r(new Error('t')), 2000))]); await new Promise(r => setTimeout(r, 120)); v.pause(); } catch {}
    }
    if (v.readyState < 2 || !v.videoWidth) return '';
    const th = document.createElement('canvas');
    th.width = 120; th.height = Math.round(120 * v.videoHeight / v.videoWidth) || 68;
    th.getContext('2d').drawImage(v, 0, 0, th.width, th.height);
    return th.toDataURL('image/jpeg', 0.6);
  } catch { return ''; }
  finally { v.removeAttribute('src'); v.load(); v.remove(); }
}
// iOS/WebKit can refuse a blob typed video/quicktime; the same bytes typed video/mp4 play fine (no copy: slice()).
const playableBlob = (f, name = f.name) => (/\.mov$/i.test(name || '') || f.type === 'video/quicktime') ? f.slice(0, f.size, 'video/mp4') : f;
async function importFiles(files, { add = true, onProgress, deferFinish = false } = {}) {
  files = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv|hevc)$/i.test(f.name));
  if (!files.length) { toast('No video files found'); return []; }
  DB.persist();
  const added = [];
  const t0 = performance.now();
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const msg = `Importing ${files.length > 1 ? `${i + 1} of ${files.length}` : f.name}…`;
    onProgress ? onProgress(msg) : toast(msg, 10000);
    const id = uid();
    let url = URL.createObjectURL(playableBlob(f)), info;
    try { info = await probe(url); }
    catch (e) {
      URL.revokeObjectURL(url); url = URL.createObjectURL(f); // retry with the original type
      try { info = await probe(url); } catch { URL.revokeObjectURL(url); toast(`Can't play ${f.name} in this browser (codec?). Try converting to H.264 MP4.`, 6000); continue; }
    }
    if (!info.w || !info.h) { URL.revokeObjectURL(url); toast(`${f.name}: this browser can't decode its video (HEVC/H.265 needs Safari or a recent Chrome). Try “Most Compatible” in iPhone Camera settings or convert to H.264.`, 8000); continue; }
    const rec = { id, blob: f, name: f.name, type: f.type, capture: null, order: Date.now() + i, thumb: '', ...info };
    S.media.set(id, { ...rec, url });
    added.push({ id: uid(), mediaId: id, name: f.name.replace(/\.\w+$/, ''), in: 0, out: r2(info.duration), dur: info.duration, w: info.w, h: info.h, muted: false });
  }
  console.info(`[import] ${added.length} file(s) ready in ${Math.round(performance.now() - t0)} ms`);
  window.__lastImportMs = performance.now() - t0;
  if (!added.length) return [];
  if (!deferFinish) finishImport(added.map(c => c.mediaId));
  if (!add) return added;
  mutate(() => { S.proj.clips.push(...added); S.sel = added[0].id; });
  toast(`Added ${added.length} clip${added.length > 1 ? 's' : ''}`);
  if (S.idx < 0) seek(S.t);
  return added;
}
// background work after import: capture time, poster frame, save the original file in IndexedDB
let finishQ = Promise.resolve();
function finishImport(ids) {
  finishQ = finishQ.then(async () => {
    for (const id of ids) {
      const m = S.media.get(id); if (!m) continue;
      try { if (m.capture == null) m.capture = (await readCaptureTime(m.blob)) || m.blob.lastModified || null; } catch {}
      if (!m.thumb) { try { m.thumb = await posterFrame(m.url); if (m.thumb) renderTimeline(); } catch {} }
      const { url, ...rec } = m;
      try { await DB.putMedia(rec); } catch (e) { toast('Couldn’t save this clip on the device (storage full or Private Browsing) — it works until you close the tab.', 6000); }
    }
  });
  return finishQ;
}
// ---------------- preview playback ----------------
// Two stacked <video> elements: the next shot is pre-seeked in the hidden one and faded in over the
// outgoing shot, so the preview shows the same crossfades / dips as the export.
let player = $('#player'), player2 = $('#player2');
let blessed2 = false;
const xfadeAt = (i) => xfadeDurations(clips(), S.proj.xfade || 0)[i] || 0;
async function loadIdx(idx, local, play) {
  const c = clips()[idx]; if (!c) return;
  const m = S.media.get(c.mediaId); if (!m) return;
  S.switching = true;
  cancelXf();
  try {
    if (player.dataset.mid !== c.mediaId) {
      player.dataset.mid = c.mediaId; player.src = m.url;
      await waitEv(player, 'loadedmetadata', 10000).catch(() => {});
    }
    S.idx = idx; S.rev = null;
    player.muted = S.mutedAll || c.muted || !!previewProg(c);
    player.playbackRate = clipSpeed(c);
    const target = srcAt(c, local);
    if (Math.abs(player.currentTime - target) > 0.03) { player.currentTime = target; await waitEv(player, 'seeked', 3000).catch(() => {}); }
    // starting inside a boomerang's reverse half: run the clock with the frame we have
    if (play && c.boom && local > fwdDur(c)) { S.rev = { t0: performance.now() - (local - fwdDur(c)) * 1000 }; }
    else if (play) await player.play().catch(e => { S.playing = false; updatePlayBtn(); });
  } finally { S.switching = false; applyLook(); prepNext(); }
}
// load + seek the next shot into the hidden player (paused) so the crossfade can start instantly
let prepToken = 0;
async function prepNext() {
  const j = S.idx + 1, n = clips()[j], tok = ++prepToken;
  if (!n || !xfadeAt(S.idx)) return;
  const m = S.media.get(n.mediaId); if (!m) return;
  const el = player2;
  try {
    if (el.dataset.mid !== n.mediaId) { el.dataset.mid = n.mediaId; el.src = m.url; await waitEv(el, 'loadedmetadata', 5000).catch(() => {}); }
    if (tok !== prepToken) return;
    el.pause(); el.playbackRate = clipSpeed(n);
    if (Math.abs(el.currentTime - n.in) > 0.03) { el.currentTime = n.in; await waitEv(el, 'seeked', 2000).catch(() => {}); }
    if (tok === prepToken) el.dataset.ready = `${j}:${n.in}`;
  } catch {}
}
function startXf(j, X) {
  const n = clips()[j];
  S.xf = { j, X, started: false };
  const el = player2;
  el.muted = true; // iOS allows one audible video at a time; audio switches at the cut
  setZ(el, 2); setZ(player, 1);
  if (el.dataset.ready !== `${j}:${n.in}`) { el.currentTime = n.in; }
  el.playbackRate = clipSpeed(n);
  el.play().then(() => { if (S.xf && S.xf.j === j) S.xf.started = true; }).catch(() => { S.xf = null; });
}
function setXfAlpha(a) {
  if (S.proj.xfadeType === 'black') { setOp(player, a < 0.5 ? 1 - 2 * a : 0); setOp(player2, a < 0.5 ? 0 : 2 * a - 1); }
  else { setOp(player, 1); setOp(player2, a); }
}
function swapXf() {
  const j = S.xf.j; S.xf = null; S.rev = null;
  const old = player; player = player2; player2 = old;
  old.pause(); setOp(old, 0); setZ(old, 0); old.dataset.ready = '';
  setOp(player, 1); setZ(player, 1);
  S.idx = j;
  player.muted = S.mutedAll || clips()[j].muted || !!previewProg(clips()[j]);
  applyLook(); prepNext();
}
function cancelXf() {
  if (!S.xf) { setOp(player2, 0); setOp(player, 1); return; }
  S.xf = null; player2.pause(); setOp(player2, 0); setOp(player, 1);
}
// ---- GL layer: fisheye shots and the reversed half of boomerangs are drawn on a canvas over their player ----
const fxLayers = new Map();
function fxOf(el) {
  let o = fxLayers.get(el);
  if (!o) {
    const cv = document.createElement('canvas'); cv.className = 'fxlayer'; cv.style.opacity = 0;
    $('#stage').insertBefore(cv, $('#focusLayer'));
    let fx = null; try { fx = createFx(cv); } catch (e) { console.warn('WebGL unavailable', e); }
    o = { cv, fx, on: false }; fxLayers.set(el, o);
  }
  return o;
}
function setOp(el, a) {
  el._op = a; const o = fxLayers.get(el);
  if (o && o.on) { el.style.opacity = 0; o.cv.style.opacity = a; } else { el.style.opacity = a; if (o) o.cv.style.opacity = 0; }
}
function setZ(el, z) { el.style.zIndex = z; const o = fxLayers.get(el); if (o) o.cv.style.zIndex = z; }
// draw el's clip through WebGL (src = the video, or a cached frame while a boomerang plays backwards)
function fxDraw(el, c, p, src) {
  const o = fxOf(el); if (!o.fx) return false;
  const st = $('#stage'), dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = Math.min(1280, Math.round(st.clientWidth * dpr)), h = Math.round(w * st.clientHeight / Math.max(1, st.clientWidth));
  if (o.cv.width !== w || o.cv.height !== h) { o.cv.width = w; o.cv.height = h; }
  src = src || el;
  const [OW, OH] = outSize();
  const ok = o.fx.draw(src, src.videoWidth || src.width, src.videoHeight || src.height, c.cam, p, { shadow: shadowAmt(c), crop: S.cropEdit?.clipId === c.id ? null : viewCrop(c, OW, OH, S.proj.fill) });
  const f = cssFilter(clipColor(S.proj, c)); if (o.cv.style.filter !== f) o.cv.style.filter = f;
  o.cv.style.zIndex = el.style.zIndex || getComputedStyle(el).zIndex || 0;
  if (ok !== o.on) { o.on = ok; setOp(el, el._op ?? +(el.style.opacity || 1)); }
  return ok;
}
function fxOff(el) { const o = fxLayers.get(el); if (o && o.on) { o.on = false; setOp(el, el._op ?? 1); } }
// boomerang frame cache (forward half), small frames, released when the shot ends
const boomCache = { id: null, frames: [] };
function boomCapture(el, c) {
  if (!c?.boom || !el.videoWidth) return;
  if (boomCache.id !== c.id) { boomCache.id = c.id; boomCache.frames = []; }
  const fr = boomCache.frames, t = el.currentTime;
  if (fr.length && t <= fr[fr.length - 1].t + 0.02) return;
  if (fr.length > 120) return;
  const w = Math.min(640, el.videoWidth), h = Math.round(w * el.videoHeight / el.videoWidth);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h; cv.getContext('2d').drawImage(el, 0, 0, w, h);
  fr.push({ t, cv });
}
function boomFrame(c, t) {
  if (boomCache.id !== c.id || !boomCache.frames.length) return null;
  let b = boomCache.frames[0]; for (const f of boomCache.frames) if (Math.abs(f.t - t) < Math.abs(b.t - t)) b = f;
  return b.cv;
}
// timeline-local time of the clip in el
function localOf(el, c) {
  if (el === player && S.rev) return fwdDur(c) + (performance.now() - S.rev.t0) / 1000;
  return clamp((el.currentTime - c.in) / clipSpeed(c), 0, fwdDur(c));
}
function seek(t) {
  S.t = clamp(t, 0, total());
  if (!clips().length) { S.idx = -1; player.removeAttribute('src'); player.dataset.mid = ''; tickUI(); return; }
  const { idx, local } = locate(S.t);
  loadIdx(idx, local, S.playing);
  tickUI();
}
async function play() {
  if (!clips().length) return;
  if (S.t >= total() - 0.05) S.t = 0;
  S.playing = true; updatePlayBtn();
  if (!blessed2) { // bless the second player inside this tap so iOS lets it play (and unmute) later
    blessed2 = true;
    const c = clips()[locate(S.t).idx], m = c && S.media.get(c.mediaId);
    if (m && !player2.getAttribute('src')) { player2.dataset.mid = c.mediaId; player2.src = m.url; }
    const pp = player2.play(); if (pp) pp.then(() => { if (!S.xf) player2.pause(); }).catch(() => {});
  }
  if (mcA && !mcA.dataset.blessed) { // let iOS play the program-audio element later (needs this tap)
    const pc = clips().find(c => previewProg(c)), pa = pc && previewProg(pc);
    if (pc) { mcA.dataset.blessed = '1'; const m = S.media.get(pa.mediaId); mcA.dataset.mid = pa.mediaId; mcA.src = m.url; mcA.muted = true; const pp = mcA.play(); if (pp) pp.then(() => { mcA.pause(); mcA.muted = S.mutedAll; }).catch(() => {}); }
  }
  const { idx, local } = locate(S.t);
  await loadIdx(idx, local, true);
}
function pause() { S.playing = false; player.pause(); mcA?.pause(); cancelXf(); if (S.rev) { const c = clips()[S.idx]; S.rev = null; if (c) { S.t = clamp(S.t, 0, total()); seek(S.t); } } updatePlayBtn(); }
function updatePlayBtn() { $('#btnPlay').textContent = S.playing ? '❚❚' : '▶'; }
function loop() {
  if (S.playing && !S.switching && S.idx >= 0) {
    const c = clips()[S.idx];
    if (!c) pause();
    else {
      const st = starts()[S.idx], D = clipDur(c);
      // boomerang: at the end of the forward half, freeze the video and play the captured frames backwards
      if (c.boom && !S.rev && (player.currentTime >= c.out - 0.03 || player.ended)) { boomCapture(player, c); player.pause(); S.rev = { t0: performance.now() }; }
      if (!S.rev) boomCapture(player, c);
      if (S.xf) { const n = clips()[S.xf.j]; if (n?.boom) boomCapture(player2, n); }
      const l = localOf(player, c);
      S.t = st + Math.min(D, l);
      const last = S.idx >= clips().length - 1;
      const X = last ? 0 : xfadeAt(S.idx), rem = D - l;
      if (X > 0 && !S.xf && rem <= X && rem > 0.06) startXf(S.idx + 1, rem);
      if (S.xf) setXfAlpha(clamp(1 - rem / S.xf.X, 0, 1));
      const ended = c.boom ? l >= D - 0.03 : (player.currentTime >= c.out - 0.03 || player.ended);
      if (ended) {
        if (S.xf && S.xf.started) swapXf();
        else if (!last) { S.t = st + D; S.rev = null; loadIdx(S.idx + 1, 0, true); }
        else { pause(); S.t = total(); }
      }
    }
    tickUI();
  }
  syncProgramAudio();
  renderProtBox();
  requestAnimationFrame(loop);
}
// multi-cam preview: the sound comes from the master camera on a hidden <audio>, so it runs on through camera cuts
const mcA = document.getElementById('mcAudio');
// a multi-cam shot plays the group's master sound (also on the master camera's own shots, so there's no hand-off)
function previewProg(c) {
  if (!c || c.boom) return null;
  const af = programAudio(c, S.media); if (af) return af;
  const g = c.mc && (S.proj.mc?.groups || []).find(x => x.id === c.mc.group);
  return g && g.master === c.mediaId ? { mediaId: c.mediaId, off: 0 } : null;
}
function syncProgramAudio() {
  if (!mcA) return;
  const c = S.idx >= 0 ? clips()[S.idx] : null;
  const af = S.playing && c && !c.muted ? previewProg(c) : null;
  if (!af) { if (!mcA.paused && !S.switching) mcA.pause(); return; }
  if (S.switching) return; // keep playing straight through the cut
  const m = S.media.get(af.mediaId);
  if (mcA.dataset.mid !== af.mediaId) { mcA.dataset.mid = af.mediaId; mcA.src = m.url; }
  mcA.muted = S.mutedAll;
  const sp = clipSpeed(c); if (Math.abs(mcA.playbackRate - sp) > 0.01) mcA.playbackRate = sp;
  const want = player.currentTime + af.off;
  if (Math.abs(mcA.currentTime - want) > 0.15) mcA.currentTime = Math.max(0, want);
  if (mcA.paused) mcA.play().catch(() => {});
}

function lookFor(el, c, p, src) {
  const f = cssFilter(clipColor(S.proj, c));
  if (el.style.filter !== f) el.style.filter = f;
  el.style.transform = c.cam ? camCss(c.cam, p, el.clientWidth || 1600, el.clientHeight || 900) : '';
  // fisheye, shadow recovery, crop / fill (and boomerang reverse frames) need WebGL; everything else is a CSS transform on the <video>
  const [OW, OH] = outSize(), editing = S.cropEdit?.clipId === c.id;
  if (editing) { el.style.transform = ''; el.style.filter = ''; fxOff(el); return; } // crop tool: show the whole, untouched frame
  if ((hasFish(c.cam) || src || shadowAmt(c) > 0 || viewCrop(c, OW, OH, S.proj.fill)) && fxDraw(el, c, p, src)) return;
  fxOff(el);
}
function applyLook() {
  const c = clips()[S.idx];
  if (!c) { player.style.transform = ''; fxOff(player); return; }
  const l = S.playing ? localOf(player, c) : clamp(S.t - starts()[S.idx], 0, clipDur(c));
  const rsrc = S.playing && S.rev ? boomFrame(c, srcAt(c, l)) : null;
  lookFor(player, c, camP(c, l), rsrc);
  if (S.xf) { const n = clips()[S.xf.j]; if (n) lookFor(player2, n, camP(n, localOf(player2, n))); }
  else fxOff(player2);
  renderFocusDot();
}
function tickUI() {
  const T = total();
  applyLook();
  $('#tc').textContent = `${fmtTime(S.t)} / ${fmtTime(T)}`;
  const sc = $('#scrub'); sc.max = T; if (document.activeElement !== sc) sc.value = S.t;
  $('#playhead').style.left = (S.t * S.pxs) + 'px';
  renderCapsOverlay();
  if (S.playing) { // keep playhead visible
    const tl = $('#timeline'), x = S.t * S.pxs;
    if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 40) tl.scrollLeft = x - 40;
  }
}

// ---------------- stage sizing / color ----------------
function fitStage() {
  const wrap = $('#stageWrap'), st = $('#stage');
  const ec = S.cropEdit && clips().find(x => x.id === S.cropEdit.clipId);
  const [OW, OH] = ec ? [ec.w || 16, ec.h || 9] : clips().length ? outSize() : [16, 9];
  const ar = OW / OH;
  const W = wrap.clientWidth, H = wrap.clientHeight;
  let w = W, h = W / ar; if (h > H) { h = H; w = H * ar; }
  st.style.width = w + 'px'; st.style.height = h + 'px'; st.style.aspectRatio = 'auto';
  renderCapsOverlay(true);
}
function applyColor() {
  const c = S.proj.color;
  player.style.filter = cssFilter(clipColor(S.proj, clips()[S.idx]));
  let tint = $('#stage .tint');
  if (!tint) { tint = document.createElement('div'); tint.className = 'tint'; $('#stage').insertBefore(tint, $('#capLayer')); }
  tint.style.background = warmthColor(c.w) || 'transparent';
  $('#colB').value = c.b; $('#colC').value = c.c; $('#colS').value = c.s; $('#colW').value = c.w;
  $('#cbV').textContent = c.b.toFixed(2); $('#ccV').textContent = c.c.toFixed(2); $('#csV').textContent = c.s.toFixed(2); $('#cwV').textContent = c.w.toFixed(2);
}

// ---------------- caption overlay ----------------
function renderCapsOverlay(force) {
  const layer = $('#capLayer'), H = $('#stage').clientHeight;
  const vis = S.proj.captions.filter(c => (S.t >= c.start && S.t < c.end) || (!S.playing && c.id === S.selCap));
  const ids = vis.map(c => c.id).join(',') + '|' + (force ? Math.random() : '');
  if (layer.dataset.ids === ids && !renderCapsOverlay.dirty) return;
  layer.dataset.ids = ids; renderCapsOverlay.dirty = false;
  layer.innerHTML = '';
  for (const c of vis) {
    const el = document.createElement('div');
    el.className = 'cap' + (c.id === S.selCap ? ' sel' : '');
    el.textContent = c.text;
    el.style.left = c.x * 100 + '%'; el.style.top = c.y * 100 + '%';
    el.style.fontSize = (c.size / 100 * H) + 'px'; el.style.color = c.color; el.style.fontFamily = FONT_STACK;
    el.style.background = c.box ? 'rgba(0,0,0,.55)' : 'transparent';
    el.onpointerdown = (e) => startCapDrag(e, c, el);
    layer.appendChild(el);
  }
}
function startCapDrag(e, cap, el) {
  e.preventDefault();
  selectCap(cap.id);
  const rect = $('#stage').getBoundingClientRect();
  const before = snap(); let moved = false;
  const mv = (ev) => {
    moved = true;
    cap.x = r2(clamp((ev.clientX - rect.left) / rect.width, 0.02, 0.98));
    cap.y = r2(clamp((ev.clientY - rect.top) / rect.height, 0.03, 0.97));
    el.style.left = cap.x * 100 + '%'; el.style.top = cap.y * 100 + '%';
  };
  const up = () => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    if (moved) { S.undo.push(before); S.redo = []; afterChange(false); renderCapInspector(); }
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

// ---------------- timeline ----------------
function renderTimeline() {
  const T = total(), pxs = S.pxs;
  const inner = $('#tlInner');
  inner.style.width = (T * pxs + 160) + 'px';
  // ruler
  const steps = [0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300];
  const step = steps.find(s => s * pxs >= 60) || 600;
  let rh = '';
  for (let t = 0; t <= T + step; t += step) rh += `<span style="left:${t * pxs}px">${fmtTime(t, false)}</span>`;
  $('#ruler').innerHTML = rh;
  // clips
  const lane = $('#lane'); lane.innerHTML = '';
  const st = starts();
  clips().forEach((c, i) => {
    const el = document.createElement('div');
    el.className = 'clip' + (c.id === S.sel ? ' sel' : '');
    el.style.left = st[i] * pxs + 'px'; el.style.width = Math.max(14, (c.out - c.in) * pxs - 2) + 'px';
    const m = S.media.get(c.mediaId);
    const th = c.thumb || m?.thumb; if (th) el.style.backgroundImage = `url(${th})`;
    el.innerHTML = `<div class="badge">${c.muted ? '🔇' : ''}${c.cam && c.cam.type !== 'wide' ? '🎥' + c.cam.type : ''}${c.enh ? '✨' : ''}${m ? '' : '⚠️ missing'}</div><div class="nm">${esc(c.name)} · ${fmtTime(c.out - c.in)}</div><div class="h l"></div><div class="h r"></div>`;
    el.dataset.id = c.id;
    el.onpointerdown = (e) => clipPointer(e, c, el);
    lane.appendChild(el);
    // suggestion overlays
    for (const s of S.sugg.filter(s => s.clipId === c.id && s.on)) {
      const a = Math.max(s.start, c.in), b = Math.min(s.end, c.out); if (b <= a) continue;
      const m2 = document.createElement('div'); m2.className = 'cutmark';
      m2.style.left = (st[i] + a - c.in) * pxs + 'px'; m2.style.width = (b - a) * pxs + 'px';
      lane.appendChild(m2);
    }
  });
  // captions lane
  const cl = $('#capLane'); cl.innerHTML = '';
  for (const c of S.proj.captions) {
    const el = document.createElement('div');
    el.className = 'capblk' + (c.id === S.selCap ? ' sel' : '');
    el.style.left = c.start * pxs + 'px'; el.style.width = Math.max(16, (c.end - c.start) * pxs - 2) + 'px';
    el.textContent = c.text || '…';
    el.onclick = (e) => { e.stopPropagation(); selectCap(c.id); seek(c.start + 0.01); };
    cl.appendChild(el);
  }
  $('#tlInfo').textContent = `${clips().length} clip${clips().length === 1 ? '' : 's'} · ${fmtTime(T)}`;
  $('#dropHint').style.display = clips().length ? 'none' : 'flex';
  tickUI();
}

function clipPointer(e, c, el) {
  const handle = e.target.classList.contains('h') ? (e.target.classList.contains('l') ? 'l' : 'r') : null;
  const x0 = e.clientX, y0 = e.clientY;
  if (handle) {
    e.preventDefault(); e.stopPropagation();
    if (S.sel !== c.id) { S.sel = c.id; renderClipInspector(); }
    const before = snap(), o = { in: c.in, out: c.out };
    let moved = false;
    const mv = (ev) => {
      moved = true;
      const ds = (ev.clientX - x0) / S.pxs;
      if (handle === 'l') c.in = r2(clamp(o.in + ds, 0, c.out - 0.1));
      else c.out = r2(clamp(o.out + ds, c.in + 0.1, c.dur));
      renderTimeline(); renderClipInspector();
      const st = starts()[clips().indexOf(c)];
      S.t = handle === 'l' ? st : st + (c.out - c.in) - 0.01; seek(S.t);
    };
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); if (moved) { S.undo.push(before); S.redo = []; afterChange(true); } };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
    return;
  }
  // tap = select + seek; mouse drag = reorder
  let dragging = false; const before = snap();
  const laneRect = $('#lane').getBoundingClientRect();
  const mv = (ev) => {
    if (e.pointerType !== 'mouse') return;
    if (!dragging && Math.abs(ev.clientX - x0) > 8) { dragging = true; el.classList.add('dragging'); }
    if (dragging) el.style.transform = `translateX(${ev.clientX - x0}px)`;
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up);
    if (dragging) {
      const t = (ev.clientX - laneRect.left + $('#timeline').scrollLeft * 0) / S.pxs;
      const cs = clips(), from = cs.indexOf(c);
      cs.splice(from, 1);
      const st = starts();
      let to = cs.length;
      for (let i = 0; i < cs.length; i++) if (t < st[i] + (cs[i].out - cs[i].in) / 2) { to = i; break; }
      cs.splice(to, 0, c);
      S.undo.push(before); S.redo = []; afterChange(true);
      return;
    }
    if (Math.abs(ev.clientX - x0) < 8 && Math.abs(ev.clientY - y0) < 8) {
      S.sel = c.id; S.selCap = null;
      showTab('clip');
      const t = (ev.clientX - laneRect.left) / S.pxs;
      seek(t); renderTimeline(); renderClipInspector();
    }
  };
  window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
}

// ---------------- inspectors ----------------
function renderClipInspector() {
  const c = selClip();
  $('#clipEmpty').hidden = !!c; $('#clipInspector').hidden = !c;
  if (!c) return;
  $('#ciName').textContent = c.name;
  const xt = c.boom ? ' · boomerang' : '', sp = clipSpeed(c) < 1 ? ` · ${clipSpeed(c)}× slow-mo` : '';
  $('#ciInfo').textContent = ` ${c.w}×${c.h} · source ${fmtTime(c.dur)} · using ${fmtTime(c.out - c.in)}${sp}${xt} → ${fmtTime(clipDur(c))} on the timeline`;
  if (document.activeElement !== $('#ciIn')) $('#ciIn').value = c.in;
  if (document.activeElement !== $('#ciOut')) $('#ciOut').value = c.out;
  $('#ciIn').max = c.dur; $('#ciOut').max = c.dur;
  { const k = S.analysis.get(c.mediaId)?.pov?.kind; $('#ciPov').value = S.proj.pov?.[c.mediaId] || 'auto';
    $('#ciPovAuto').textContent = `Auto (${k === 'third' ? 'third-person' : k === 'pov' ? 'POV' : k === 'solo' ? 'one person' : 'not analysed'})`; }
  $('#ciCam').value = c.cam?.type || 'none'; $('#ciFlip').checked = !!c.cam?.flip; $('#ciFlip').disabled = !c.cam;
  $('#ciAngle').value = c.cam?.angle || 'none'; $('#ciAngle').disabled = !c.cam;
  $('#ciLens').value = c.cam?.roll && c.cam?.fish ? 'both' : c.cam?.roll ? 'dutch' : c.cam?.fish ? 'fish' : 'none'; $('#ciLens').disabled = !c.cam;
  $('#ciSpeed').value = String(clipSpeed(c)); if ($('#ciSpeed').selectedIndex < 0) $('#ciSpeed').value = '1';
  $('#ciBoom').checked = !!c.boom;
  const shv = Math.round(shadowAmt(c) * 100), shAuto = c.shadow == null;
  if (document.activeElement !== $('#ciShadow')) $('#ciShadow').value = shv;
  $('#ciShadowV').textContent = shAuto ? (c.enh?.hdr ? 'Auto (off · HDR video)' : c.enh?.shadow ? `Auto (${shv})` : 'Auto (off)') : String(shv);
  { const cr = clipCrop(c); $('#ciCrop').textContent = cr ? `✂️ Crop (${Math.round((cr[2] - cr[0]) * 100)}×${Math.round((cr[3] - cr[1]) * 100)}%)` : '✂️ Crop'; $('#ciCrop').classList.toggle('on', !!cr); $('#ciCropReset').disabled = !cr; }
  $('#pjFill').value = S.proj.fill || 'auto';
  $('#ciShadowAuto').checked = shAuto;
  renderMcPicker(c);
  const fo = c.focus || S.proj.focus?.[c.mediaId];
  $('#ciFocusInfo').textContent = fo ? `Focus set${fo.track?.length ? `, tracked over ${fo.track.length} frames` : ''}${c.focus ? ' (this shot only)' : ' (whole video)'}.` : 'No focus: crops follow motion and skin tone automatically.';
  $('#ciFocus').classList.toggle('on', S.focusMode);
  $('#ciMute').textContent = c.muted ? '🔊 Unmute' : '🔇 Mute';
  $('#ciMute').classList.toggle('on', c.muted);
}
function renderCapInspector() {
  const c = selCap();
  $('#capEmpty').hidden = !!c; $('#capInspector').hidden = !c;
  if (!c) return;
  if (document.activeElement !== $('#cpText')) $('#cpText').value = c.text;
  $('#cpStart').value = c.start; $('#cpEnd').value = c.end;
  $('#cpSize').value = c.size; $('#cpSizeV').textContent = c.size + '%';
  $('#cpX').value = c.x; $('#cpY').value = c.y; $('#cpColor').value = c.color; $('#cpBox').checked = !!c.box;
}
function selectCap(id) { S.selCap = id; showTab('text'); renderCapInspector(); renderTimeline(); renderCapsOverlay.dirty = true; renderCapsOverlay(); }
function renderAll() { fitStage(); const ex = $('#exXf'); if (ex) ex.value = xfValue(S.proj); renderAuto(); renderTimeline(); renderClipInspector(); renderCapInspector(); applyColor(); fitStage(); renderCapsOverlay.dirty = true; renderCapsOverlay(); renderSugg(); }
function showTab(name) {
  $$('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.panel').forEach(p => p.classList.toggle('on', p.id === 'tab-' + name));
}

// ---------------- clip actions ----------------
function splitAt(t) {
  const { idx, local } = locate(t); const c = clips()[idx];
  if (!c || local < 0.05 || local > c.out - c.in - 0.05) return toast('Move the playhead inside a clip to split');
  mutate(() => {
    const cut = r2(c.in + local);
    const b = { ...c, id: uid(), in: cut };
    c.out = cut; clips().splice(idx + 1, 0, b); S.sel = b.id;
  });
  toast('Split ✂');
}
function delSel() {
  const c = selClip(); if (!c) return;
  mutate(() => { const i = clips().indexOf(c); clips().splice(i, 1); S.sel = clips()[Math.min(i, clips().length - 1)]?.id || null; S.sugg = S.sugg.filter(s => s.clipId !== c.id); });
  seek(S.t);
}
function moveSel(d) {
  const c = selClip(); if (!c) return; const cs = clips(), i = cs.indexOf(c), j = i + d;
  if (j < 0 || j >= cs.length) return;
  mutate(() => { cs.splice(i, 1); cs.splice(j, 0, c); });
}

// ---------------- AI: suggest cuts ----------------
let aiAbort = null;
async function analyze() {
  const scope = $('#aiScope').value;
  const targets = scope === 'all' ? clips() : [selClip()].filter(Boolean);
  if (!targets.length) return toast('Select a clip first (or choose “All clips”)');
  if (aiAbort) { aiAbort.abort(); return; }
  aiAbort = new AbortController();
  const btn = $('#aiAnalyze'); btn.textContent = '■ Stop';
  const opts = { db: +$('#aiDb').value, min: +$('#aiMin').value, mode: $('#aiMode').value };
  S.sugg = []; let noAudio = 0;
  try {
    for (let k = 0; k < targets.length; k++) {
      const c = targets[k], m = S.media.get(c.mediaId);
      const { regions, hadAudio } = await suggestCuts(c, m, opts, (f, msg) => { $('#aiProgress').textContent = `${msg} clip ${k + 1}/${targets.length} · ${Math.round(f * 100)}%`; }, aiAbort.signal);
      if (!hadAudio && opts.mode !== 'motion') noAudio++;
      regions.forEach(r => S.sugg.push({ id: uid(), clipId: c.id, start: r2(r.start), end: r2(r.end), reasons: [...r.reasons], on: true }));
    }
    $('#aiProgress').textContent = `Found ${S.sugg.length} region${S.sugg.length === 1 ? '' : 's'} (${fmtTime(S.sugg.reduce((a, s) => a + s.end - s.start, 0))} total).` + (noAudio ? ` ${noAudio} clip(s) had no decodable audio — used motion only.` : '');
  } catch (e) { $('#aiProgress').textContent = 'Analysis failed: ' + e.message; }
  aiAbort = null; btn.textContent = '🔍 Analyze';
  renderSugg(); renderTimeline();
}
function renderSugg() {
  const box = $('#aiResults'); box.innerHTML = '';
  if (!S.sugg.length) return;
  for (const s of S.sugg) {
    const c = clips().find(x => x.id === s.clipId); if (!c) continue;
    const row = document.createElement('div'); row.className = 'sugg';
    row.innerHTML = `<input type="checkbox" ${s.on ? 'checked' : ''}><div class="t">${esc(c.name)} · ${fmtTime(s.start)}–${fmtTime(s.end)} (${(s.end - s.start).toFixed(1)}s)${s.reasons.map(r => `<span class="tag">${r}</span>`).join('')}</div><button class="ghost">▶</button>`;
    row.querySelector('input').onchange = (e) => { s.on = e.target.checked; renderTimeline(); };
    row.querySelector('button').onclick = () => { const i = clips().indexOf(c); seek(starts()[i] + Math.max(0, s.start - c.in)); };
    box.appendChild(row);
  }
  const bar = document.createElement('div'); bar.className = 'btnrow';
  bar.innerHTML = `<button class="primary">✂ Remove checked</button><button>Clear</button>`;
  bar.children[0].onclick = applySugg;
  bar.children[1].onclick = () => { S.sugg = []; renderSugg(); renderTimeline(); $('#aiProgress').textContent = ''; };
  box.appendChild(bar);
}
function applySugg() {
  const on = S.sugg.filter(s => s.on); if (!on.length) return;
  let removed = 0;
  mutate(() => {
    const out = [];
    for (const c of clips()) {
      const rs = on.filter(s => s.clipId === c.id).sort((a, b) => a.start - b.start);
      if (!rs.length) { out.push(c); continue; }
      let cur = c.in, first = true;
      for (const r of rs) {
        const a = Math.max(r.start, c.in), b = Math.min(r.end, c.out);
        if (a - cur >= 0.2) { out.push({ ...c, id: first ? c.id : uid(), in: r2(cur), out: r2(a) }); first = false; }
        removed += Math.max(0, b - Math.max(a, cur));
        cur = Math.max(cur, b);
      }
      if (c.out - cur >= 0.2) out.push({ ...c, id: first ? c.id : uid(), in: r2(cur), out: c.out });
    }
    S.proj.clips = out; S.sugg = [];
  });
  $('#aiProgress').textContent = `Removed ${removed.toFixed(1)}s. Undo with ↶ / Ctrl+Z.`;
  seek(Math.min(S.t, total()));
}

// ---------------- AI: auto color ----------------
async function doAutoColor() {
  if (!clips().length) return toast('Import a clip first');
  toast('Analyzing color…', 8000);
  const samples = [];
  for (const c of clips().slice(0, 6)) {
    const m = S.media.get(c.mediaId); if (!m) continue;
    const step = Math.max(0.5, (c.out - c.in) / 5);
    samples.push(...await videoStats(m.url, c.in, c.out, step));
  }
  const col = await autoColor(samples);
  if (!col) return;
  mutate(() => { S.proj.color = col; });
  toast(`Auto color: brightness ${col.b}, contrast ${col.c}, saturation ${col.s}`);
}

// ---------------- AI: captions ----------------
function addCaption(text = 'Your text', start = S.t, end = null, extra = {}) {
  const c = { id: uid(), text, start: r2(start), end: r2(end ?? Math.min(start + 3, Math.max(total(), start + 3))), x: 0.5, y: 0.85, size: 6, color: '#ffffff', box: false, ...extra };
  S.proj.captions.push(c);
  return c;
}
let rec = null;
function liveDictate() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return modal('Live dictate not available', html(`<p>This browser has no SpeechRecognition API (Chrome desktop, Edge and iPhone Safari 14.5+ usually do). Use <b>Paste transcript</b> instead — it accepts plain text, timestamped lines or SRT.</p>`));
  if (rec) { rec.stop(); return; }
  if (!clips().length) return toast('Import a clip first');
  rec = new SR(); rec.continuous = true; rec.interimResults = true; rec.lang = navigator.language || 'en-US';
  let segStart = null; const before = snap(); let added = 0;
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (segStart == null) segStart = Math.max(0, S.t - 0.4);
      if (e.results[i].isFinal) {
        const txt = e.results[i][0].transcript.trim();
        if (txt) { addCaption(txt, segStart, Math.max(S.t, segStart + 1)); added++; renderTimeline(); }
        segStart = null;
      }
    }
  };
  rec.onend = () => { rec = null; $('#acLive').textContent = '🎙 Live dictate'; pause(); if (added) { S.undo.push(before); S.redo = []; afterChange(true); } $('#acNote').textContent = `Dictation stopped · ${added} caption(s) added.`; };
  rec.onerror = (e) => { $('#acNote').textContent = 'Speech error: ' + e.error; };
  rec.start(); play();
  $('#acLive').textContent = '■ Stop dictation';
  $('#acNote').textContent = 'Listening via microphone while the timeline plays. Speak the lines (or let speakers play into the mic). Captions are timed to the playhead.';
}
function pasteTranscript() {
  const body = html(`<p class="muted small">Paste plain text (spread evenly), lines like <code>[0:12] line</code>, or SRT. Applies to: <select id="ptScope"><option value="all">whole timeline</option><option value="sel">selected clip</option><option value="ph">playhead → end</option></select></p><textarea id="ptText" rows="10" placeholder="Paste transcript…"></textarea>`);
  modal('Paste transcript → captions', body, [{ label: 'Cancel' }, {
    label: 'Create captions', cls: 'primary', onClick: () => {
      const txt = $('#ptText').value.trim(); if (!txt) return false;
      const scope = $('#ptScope').value; let t0 = 0, t1 = total() || 10;
      if (scope === 'sel' && selClip()) { const i = clips().indexOf(selClip()); t0 = starts()[i]; t1 = t0 + selClip().out - selClip().in; }
      if (scope === 'ph') t0 = S.t;
      const items = timeTranscript(txt, t0, t1, parseSrt);
      mutate(() => items.forEach(it => addCaption(it.text, it.start, it.end)));
      toast(`Added ${items.length} captions`);
    }
  }]);
}

// ---------------- AI hooks ----------------
async function hook(op) {
  const cfg = loadAI(); const h = HOOKS[op];
  if (!providerReady(cfg)) {
    return modal(`${h.title} — connect later`, html(`<p>${h.desc}</p><p>No AI provider is connected yet, so this is a placeholder. The editor works fully without it.</p>
      <p><b>Turn it on (2 min):</b> get a key at <b>fal.ai/dashboard/keys</b> → ⚙️ Settings → Provider: fal.ai → paste the key → Save → tap Enhance.</p>
      <p class="muted small">fal.ai bills per use from your own fal account (add credits there). Keys stay in this browser’s localStorage only. Hosted providers may refuse explicit footage — “My own endpoint” (home GPU box) avoids that.</p>`),
      [{ label: 'Later' }, { label: 'Open Settings', cls: 'primary', onClick: () => { setTimeout(openSettings, 50); } }]);
  }
  let input;
  if (op === 'img2vid') {
    const f = await pickFile('image/*'); if (!f) return;
    input = { blob: f, name: f.name };
  } else {
    const c = selClip(); if (!c) return toast('Select a clip first');
    const m = S.media.get(c.mediaId); input = { blob: m.blob, name: m.name, in: c.in, out: c.out, dur: c.dur };
  }
  const where = cfg.provider === 'custom' ? cfg.customUrl : cfg.provider;
  const ok = await modal('Send off this device?', html(`<p>This uploads <b>${esc(input.name)}</b> (${(input.blob.size / 1048576).toFixed(1)} MB) to <b>${esc(where)}</b> for “${h.title}”. Only continue if you’re OK with that provider seeing it.</p>`), [{ label: 'Cancel', value: false }, { label: 'Upload', cls: 'primary', value: true }]);
  if (!ok) return;
  try {
    const out = await runHook(op, input, cfg, (s) => toast(s, 60000));
    toast(`${h.title} done — added to the timeline`, 4000);
    const file = new File([out], `${h.title.replace(/\W+/g, '-')}-${Date.now()}.mp4`, { type: out.type || 'video/mp4' });
    await importFiles([file]);
  } catch (e) {
    toast('', 1);
    modal(e.notWired ? 'Not available with this provider' : e.policy ? 'Blocked by provider' : 'AI enhance failed', html(`<p>${esc(e.message)}</p>`));
  }
}
function pickFile(accept) {
  return new Promise(res => { const i = document.createElement('input'); i.type = 'file'; i.accept = accept; i.onchange = () => res(i.files[0]); i.click(); });
}

// ---------------- export ----------------
function exportOpts(onProgress) { return { res: $('#exRes').value, crf: +$('#exQ').value, burnCaptions: $('#exCaps').checked, onProgress }; }
function setExportUI(busy) {
  $('#exFf').disabled = busy; $('#exRt').disabled = busy; $('#exQuick').disabled = busy; $('#exCancel').hidden = !busy;
  if (busy) { $('#exLink').hidden = true; $('#exBar').style.width = '0'; }
}
// progress text with an ETA for engines that don't give one
function withEta(set) {
  const t0 = performance.now();
  return (f, msg) => {
    let m = msg;
    if (f > 0.04 && f < 1 && !/left/.test(msg)) { const el = (performance.now() - t0) / 1000, eta = el / f * (1 - f); m += ` · about ${Math.ceil(eta)} s left`; }
    set(f, m + (f > 0 && f < 1 ? ` (${Math.round(f * 100)}%)` : ''));
  };
}
const prog = withEta((f, msg) => { $('#exBar').style.width = Math.round(f * 100) + '%'; $('#exStatus').textContent = msg; });
const PATH_NAMES = { remux: 'stream copy, no re-encode', webcodecs: 'hardware H.264 encoder (WebCodecs)', ffmpeg: 'ffmpeg.wasm (compatible engine)' };
/** fastest engine that can do this edit: stream copy -> WebCodecs (hardware) -> ffmpeg.wasm */
async function bestExport(p, engine = $('#exEngine')?.value || 'auto') {
  const opts = exportOpts(p);
  if (engine !== 'ffmpeg') {
    try {
      const srcMin = Math.min(...clips().map(c => Math.min(c.w || 9999, c.h || 9999)));
      if ((opts.res === 'src' || srcMin <= +opts.res) && await canRemux(S.proj, S.media, opts)) { S.exportJob = { cancel() {} }; return await remuxExport(S.proj, S.media, opts); }
      const why = await wcBlocker(S.proj, S.media, opts);
      if (!why) { const job = createWcExport(S.proj, S.media, opts); S.exportJob = job; return await job.run(); }
      console.info('[export] fast path not available:', why); p(0, `Using the compatible engine (${why})…`);
    } catch (e) {
      if (e?.message === 'Cancelled') throw e;
      console.warn('[export] fast path failed, falling back to ffmpeg.wasm', e); p(0, 'Fast export hit a problem, so using the compatible engine…');
    }
  }
  S.exportJob = { cancel: cancelFF };
  const r = await exportChunked(S.proj, S.media, opts); r.path = 'ffmpeg'; return r;
}
function finishExport(res, t0) {
  const a = $('#exLink');
  if (a.href) URL.revokeObjectURL(a.href);
  a.href = URL.createObjectURL(res.blob);
  a.download = `${(S.proj.name || 'export').replace(/[^\w-]+/g, '_')}.${res.ext}`;
  a.hidden = false;
  a.textContent = `⬇ Save ${res.ext.toUpperCase()} (${(res.blob.size / 1048576).toFixed(1)} MB, ${res.W}×${res.H})`;
  $('#exStatus').textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s${res.path ? ' · ' + PATH_NAMES[res.path] : ''}. On iPhone: tap Save, then Share → Save Video.`;
  window.__lastExport = res;
}
async function doExportFF() {
  if (!clips().length) return toast('Timeline is empty');
  const big = [...new Set(clips().map(c => c.mediaId))].reduce((a, id) => a + (S.media.get(id)?.blob.size || 0), 0);
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if ($('#exEngine').value === 'ffmpeg' && ((isIOS && big > 150e6) || big > 1.2e9)) {
    const go = await modal('Heavy export', html(`<p>Sources total ${(big / 1048576).toFixed(0)} MB. ffmpeg.wasm keeps everything in memory${isIOS ? ' and iPhone Safari may reload the tab' : ''}. <b>Real-time export</b> is safer for big files.</p>`), [{ label: 'Cancel', value: false }, { label: 'Try anyway', cls: 'primary', value: true }]);
    if (!go) return;
  }
  pause(); setExportUI(true); const t0 = performance.now();
  try { finishExport(await bestExport(prog), t0); }
  catch (e) { $('#exStatus').textContent = 'Export failed: ' + (e.message || e); console.error(e); }
  S.exportJob = null; setExportUI(false);
}
async function doExportRT() {
  if (!clips().length) return toast('Timeline is empty');
  pause(); setExportUI(true); const t0 = performance.now();
  try {
    const job = createRealtimeExport(S.proj, S.media, exportOpts(prog)); // created inside the click (iOS autoplay)
    S.exportJob = job;
    finishExport(await job.run(), t0);
  } catch (e) { $('#exStatus').textContent = 'Export failed: ' + (e.message || e); console.error(e); }
  S.exportJob = null; setExportUI(false);
}
function downloadText(name, text) {
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' })); a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

// ---------------- Focus point + per-clip framing ----------------
const camLevel = () => +($('#auCamL')?.value || 2);
function subjForClip(c, a = c.in, b = c.out) {
  const pr = keepFrameOn() && subjectFromProtected(c, a, b); // already in frame coordinates
  if (pr && !(c.focus || S.proj.focus?.[c.mediaId])) return pr;
  const s = subjectFromFocus(c.focus || S.proj.focus?.[c.mediaId], a, b) || pr || subjectOf(S.analysis.get(c.mediaId)?.samples, a, b);
  if (!s || s === pr) return s;
  // source coordinates -> frame coordinates (crop / fill / letterbox)
  const { f } = frameMap(c.mediaId, c), m = (x, y) => { const q = f([x, y, x, y]); return [q[0], q[1]]; };
  const [cx, cy] = m(s.cx, s.cy), [cx1, cy1] = m(s.cx1 ?? s.cx, s.cy1 ?? s.cy);
  return { ...s, cx, cy, cx1, cy1 };
}
function recam(c, type = c.cam?.type, flip = c.cam?.flip, look = lookOf(c.cam)) {
  c.cam = !type || type === 'none' ? null : camFor(type, subjForClip(c), LEVELS[camLevel()] || LEVELS[2], !!flip, look);
  if (c.cam) c.cam = fitFor(c, c.cam);
}
// ---- "Keep her in frame": protected region (her + the action + where the bodies meet) is always inside the virtual camera ----
const keepFrameOn = () => loadAutoSettings().keepFrame !== false;
// focus point (Set focus tap) for a video at source time t — picks which person is "her" and is remembered per video
function focusAtFor(c) {
  const fo = c.focus || S.proj.focus?.[c.mediaId]; if (!fo) return () => null;
  return (t) => { const tr = fo.track || []; if (!tr.length) return { x: fo.x, y: fo.y };
    const q = tr.reduce((m, k) => Math.abs(k.t - t) < Math.abs(m.t - t) ? k : m, tr[0]); return { x: q.x, y: q.y }; };
}
// source box (0..1 of the video) -> output frame (0..1), clips with another aspect are letterboxed into the first clip's frame
// and only the cropped / filled part of the source (viewCrop) is in the frame
function frameMap(mediaId, c) {
  const m = S.media.get(mediaId), [W, H] = outputSize(clips().length ? clips() : [{ w: m?.w, h: m?.h }], 'src');
  const sw = m?.w || c?.w || W, sh = m?.h || c?.h || H;
  const r = viewCrop({ w: sw, h: sh, crop: c && c.crop !== undefined ? c.crop : S.proj.crops?.[mediaId] }, W, H, S.proj.fill) || [0, 0, 1, 1];
  const [dx, dy, dw, dh] = containRect(sw * (r[2] - r[0]), sh * (r[3] - r[1]), W, H);
  const X = (x) => clamp((dx + (x - r[0]) / (r[2] - r[0]) * dw) / W, 0, 1), Y = (y) => clamp((dy + (y - r[1]) / (r[3] - r[1]) * dh) / H, 0, 1);
  const f = (b) => b && [X(b[0]), Y(b[1]), Math.max(X(b[2]), X(b[0]) + 0.01), Math.max(Y(b[3]), Y(b[1]) + 0.01)];
  return { f, aspect: W / H };
}
const outSize = () => outputSize(clips(), 'src');
function keysFor(c, a = c.in, b = c.out) {
  const sm = S.analysis.get(c.mediaId)?.samples; if (!sm?.length) return [];
  const { f } = frameMap(c.mediaId, c);
  return shotKeys(sm, a, b, focusAtFor(c)).map(k => ({ p: k.p, box: f(k.box) }));
}
function subjectFromProtected(c, a, b) {
  const k = keysFor(c, a, b); if (!k.length) return null;
  const ctr = (bx) => [(bx[0] + bx[2]) / 2, (bx[1] + bx[3]) / 2];
  const U = (a) => a.reduce((u, x) => boxUnion(u, x.box), null), A = U(k.slice(0, 3)), B = U(k.slice(-3)); if (!A || !B) return null;
  const [cx, cy] = ctr(A), [cx1, cy1] = ctr(B);
  return { cx, cy, cx1, cy1, conf: 0.8 };
}
// ---- "Hide his upper body" on third-person clips ----
function povOf(mediaId) { const o = S.proj.pov?.[mediaId]; const k = S.analysis.get(mediaId)?.pov?.kind; return o || k || 'unknown'; }
const isThird = (mediaId) => povOf(mediaId) === 'third';
// which shots hide him: 'most' = 4 of every 5 third-person shots (the 5th is a wider context shot that still hides his face)
function hider(st) {
  let k = 0;
  return (s) => {
    delete s.hide;
    if (st.hideMan === 'off' || !isThird(s.mediaId)) return;
    s.hide = st.hideMan === 'all' || k % 5 !== 2 ? 'tight' : 'ctx'; k++;
  };
}
function assignHide(shots, st) { const h = hider(st); shots.forEach(h); }
function fitFor(c, cam, st = loadAutoSettings()) {
  if (cam && c.hide && st.hideMan !== 'off' && isThird(c.mediaId)) {
    const sm = S.analysis.get(c.mediaId)?.samples;
    if (sm?.length) {
      const { f, aspect } = frameMap(c.mediaId, c), ctx = c.hide === 'ctx';
      const keys = hideKeys(sm, c.in, c.out, focusAtFor(c), ctx).map(k => ({ p: k.p, box: f(k.box), ex: f(k.ex) }));
      const T = TIGHTNESS[st.frameTight] || TIGHTNESS.balanced;
      if (keys.length) return fitHide(cam, keys, { margin: T.margin, aspect, ctx, zMax: st.frameTight === 'loose' ? 2 : 2.5 });
    }
  }
  if (!cam || st.keepFrame === false) return cam;
  const keys = keysFor(c); if (!keys.length) return cam;
  const T = TIGHTNESS[st.frameTight] || TIGHTNESS.balanced;
  return fitCam(cam, keys, { margin: T.margin, zoomK: T.zoomK, aspect: frameMap(c.mediaId, c).aspect });
}
// preview overlay: the protected box drawn through the current camera
function renderProtBox() {
  const cv = $('#protBox'); if (!cv) return;
  const on = $('#pvProt')?.checked, c = clips()[S.idx];
  if (!on || !c) { if (!cv.hidden) { cv.hidden = true; } return; }
  cv.hidden = false;
  const st = $('#stage'), W = st.clientWidth, H = st.clientHeight;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const g = cv.getContext('2d'); g.clearRect(0, 0, W, H);
  const sm = S.analysis.get(c.mediaId)?.samples; if (!sm?.length) return;
  const t = player.currentTime, fa = focusAtFor(c);
  const near = sm.filter(x => Math.abs(x.t - t) <= 0.4); if (!near.length) return;
  const hk = c.hide ? hideKeys(sm, Math.max(c.in, t - 0.4), Math.min(c.out, t + 0.4), fa, c.hide === 'ctx')[5] : null;
  const box = hk?.box || near.reduce((u, x) => boxUnion(u, protectedOf(x, fa(x.t)).box), null); if (!box) return;
  const pts = [];
  for (let i = 0; i <= 12; i++) { const u = i / 12; pts.push([box[0] + (box[2] - box[0]) * u, box[1]]); }
  for (let i = 0; i <= 12; i++) { const u = i / 12; pts.push([box[2], box[1] + (box[3] - box[1]) * u]); }
  for (let i = 0; i <= 12; i++) { const u = i / 12; pts.push([box[2] - (box[2] - box[0]) * u, box[3]]); }
  for (let i = 0; i <= 12; i++) { const u = i / 12; pts.push([box[0], box[3] - (box[3] - box[1]) * u]); }
  let inside = true;
  g.beginPath();
  pts.forEach(([x, y], i) => { const [sx, sy] = contentToStage(x, y); if (sx < 0 || sx > 1 || sy < 0 || sy > 1) inside = false; i ? g.lineTo(sx * W, sy * H) : g.moveTo(sx * W, sy * H); });
  g.closePath(); g.lineWidth = 2; g.setLineDash([6, 4]); g.strokeStyle = inside ? '#3ee08f' : '#ff4d6d'; g.stroke();
  g.setLineDash([]); g.fillStyle = inside ? '#3ee08f' : '#ff4d6d'; g.font = '12px system-ui'; g.fillText(inside ? 'her + action ✓' : 'outside crop', 8, H - 10);
  if (c.hide) { // his upper body (kept out of the shot when possible)
    const ex = hk?.ex;
    if (ex) { const q = [[ex[0], ex[1]], [ex[2], ex[1]], [ex[2], ex[3]], [ex[0], ex[3]]].map(([x, y]) => contentToStage(x, y));
      g.beginPath(); q.forEach(([sx, sy], i) => i ? g.lineTo(sx * W, sy * H) : g.moveTo(sx * W, sy * H)); g.closePath(); g.setLineDash([3, 3]); g.strokeStyle = '#ffb02e'; g.stroke(); g.setLineDash([]);
      g.fillStyle = '#ffb02e'; g.fillText(c.hide === 'ctx' ? 'his face (hidden)' : 'his upper body (hidden)', 8, H - 26); }
  }
}
// stage (0..1) <-> video content (0..1), accounting for letterboxing, the current camera zoom and mirroring
function stageGeom() {
  const st = $('#stage'), W = st.clientWidth, H = st.clientHeight, c = clips()[S.idx];
  const [OW, OH] = outSize(), r = (c && S.cropEdit?.clipId !== c.id && viewCrop(c, OW, OH, S.proj.fill)) || [0, 0, 1, 1];
  const [dx, dy, dw, dh] = containRect((player.videoWidth || W) * (r[2] - r[0]), (player.videoHeight || H) * (r[3] - r[1]), W, H);
  const p = c ? camP(c, clamp(S.t - starts()[S.idx], 0, clipDur(c))) : 0;
  return { W, H, dx, dy, dw, dh, r, cam: camAt(c?.cam || null, p), flip: !!c?.cam?.flip, look: c?.cam || null };
}
function stageToContent(sx, sy) {
  const g = stageGeom(); if (g.flip) sx = 1 - sx;
  [sx, sy] = outToCrop(g.look, sx, sy, g.W / g.H);
  const ex = g.cam.cx + (sx - 0.5) / g.cam.z, ey = g.cam.cy + (sy - 0.5) / g.cam.z;
  const u = clamp((ex * g.W - g.dx) / g.dw, 0, 1), v = clamp((ey * g.H - g.dy) / g.dh, 0, 1);
  return [g.r[0] + u * (g.r[2] - g.r[0]), g.r[1] + v * (g.r[3] - g.r[1])];
}
function contentToStage(x, y) {
  const g = stageGeom();
  x = (x - g.r[0]) / (g.r[2] - g.r[0]); y = (y - g.r[1]) / (g.r[3] - g.r[1]);
  const ex = (g.dx + x * g.dw) / g.W, ey = (g.dy + y * g.dh) / g.H;
  let sx = 0.5 + (ex - g.cam.cx) * g.cam.z, sy = 0.5 + (ey - g.cam.cy) * g.cam.z;
  [sx, sy] = cropToOut(g.look, sx, sy, g.W / g.H);
  if (g.flip) sx = 1 - sx;
  return [sx, sy];
}
function renderFocusDot() {
  const dot = $('#focusDot'); if (!dot) return;
  const c = clips()[S.idx], fo = c && (c.focus || S.proj.focus?.[c.mediaId]);
  const show = fo && !S.playing && ($('#tab-clip').classList.contains('on') || S.focusMode);
  dot.hidden = !show; if (!show) return;
  const t = player.currentTime, tr = fo.track || [];
  let p = fo; if (tr.length) { p = tr.reduce((m, q) => Math.abs(q.t - t) < Math.abs(m.t - t) ? q : m, tr[0]); }
  const [sx, sy] = contentToStage(p.x, p.y);
  dot.style.left = (sx * 100) + '%'; dot.style.top = (sy * 100) + '%';
}
function setFocusMode(on) {
  S.focusMode = on; if (on) pause();
  $('#stage').classList.toggle('focusing', on); $('#ciFocus').classList.toggle('on', on);
  $('#ciFocus').textContent = on ? '✕ Cancel focus' : '🎯 Set focus';
}
async function onFocusTap(e) {
  e.preventDefault();
  const c = clips()[S.idx]; if (!c) return setFocusMode(false);
  unlockAnalysis(); // tap = user gesture: lets the tracker play the video on iOS
  const r = $('#stage').getBoundingClientRect();
  const [x, y] = stageToContent((e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height);
  setFocusMode(false);
  const all = $('#ciFocusAll').checked, m = S.media.get(c.mediaId);
  // template from the frame on screen right now
  const W = 160, H = Math.max(36, Math.round(160 * (player.videoHeight || 9) / (player.videoWidth || 16) / 2) * 2);
  const cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  let track = [];
  try {
    cx.drawImage(player, 0, 0, W, H);
    const tpl = makeTemplate(grayOf(cx.getImageData(0, 0, W, H).data, W, H), W, H, x, y);
    const [t0, t1] = all ? [0, m.duration] : [c.in, c.out];
    track = await trackPoint(m.url, t0, t1, tpl, { onTick: (f) => toast(`Tracking focus… ${Math.round(f * 100)}%`, 3000) });
  } catch (err) { console.warn('focus tracking failed', err); }
  const focus = { x: +x.toFixed(3), y: +y.toFixed(3), t: +player.currentTime.toFixed(2), track };
  mutate(() => {
    if (all) { S.proj.focus = { ...(S.proj.focus || {}), [c.mediaId]: focus }; clips().forEach(k => { if (k.mediaId === c.mediaId && !k.focus) recam(k, k.cam?.type || 'medium'); }); }
    else { c.focus = focus; recam(c, c.cam?.type || 'medium'); }
  });
  toast(track.length ? `Focus set and tracked ✓ (${track.length} points)` : 'Focus set ✓ (fixed point)');
  seek(S.t);
}
// ---------------- Crop tool (per clip; before auto-framing and in every export) ----------------
const cropRound = (r) => r.map(v => +clamp(v, 0, 1).toFixed(4));
function cropTargets(c, all) { return all ? clips().filter(k => k.mediaId === c.mediaId) : [c]; }
function startCrop() {
  const c = selClip() || clips()[S.idx]; if (!c) return toast('Tap a clip first');
  if (S.focusMode) setFocusMode(false);
  pause();
  const i = clips().indexOf(c); if (i !== S.idx) seek(starts()[i] + 0.05);
  S.cropEdit = { clipId: c.id, r: (clipCrop(c) || [0, 0, 1, 1]).slice(), aspect: 'free' };
  document.body.classList.add('cropping');
  $('#cropLayer').hidden = false; $('#cropBar').hidden = false;
  $('#cropAsp').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.a === 'free'));
  fitStage(); seek(S.t); drawCropRect();
  $('#stage').scrollIntoView?.({ block: 'center' }); // phones: the Crop button sits below the preview
}
function endCrop(apply) {
  const E = S.cropEdit; if (!E) return;
  S.cropEdit = null;
  document.body.classList.remove('cropping');
  $('#cropLayer').hidden = true; $('#cropBar').hidden = true;
  const c = clips().find(k => k.id === E.clipId);
  if (apply && c) {
    const all = $('#cropAll').checked, r = cropRound(E.r), full = !clipCrop({ crop: r });
    mutate(() => {
      for (const k of cropTargets(c, all)) { if (full) delete k.crop; else k.crop = r.slice(); if (k.cam) recam(k); }
      if (all) S.proj.crops = { ...(S.proj.crops || {}), [c.mediaId]: full ? [0, 0, 1, 1] : r.slice() };
    });
    toast(full ? 'Crop removed' : 'Cropped ✓');
  }
  fitStage(); seek(S.t);
}
function resetCrop() {
  const c = selClip() || clips()[S.idx]; if (!c) return;
  mutate(() => { for (const k of clips()) if (k.mediaId === c.mediaId || k === c) { delete k.crop; if (k.cam) recam(k); } S.proj.crops = { ...(S.proj.crops || {}), [c.mediaId]: [0, 0, 1, 1] }; });
  fitStage(); seek(S.t); toast('Crop reset — whole video');
}
function drawCropRect() {
  const E = S.cropEdit; if (!E) return;
  const el = $('#cropRect'), [x0, y0, x1, y1] = E.r;
  el.style.left = x0 * 100 + '%'; el.style.top = y0 * 100 + '%'; el.style.width = (x1 - x0) * 100 + '%'; el.style.height = (y1 - y0) * 100 + '%';
}
// aspect (width / height in pixels) -> the largest box of that shape centred on the current box
function cropToAspect(E, a) {
  const st = $('#stage'), W = st.clientWidth || 1, H = st.clientHeight || 1, c = clips().find(k => k.id === E.clipId);
  const A = CROP_ASPECTS[a]; if (!A) return;
  const ar = (c?.w || W) / (c?.h || H); // source aspect: normalized units -> pixels
  const cx = (E.r[0] + E.r[2]) / 2, cy = (E.r[1] + E.r[3]) / 2;
  let w = 1, h = ar / A; if (h > 1) { h = 1; w = A / ar; }
  const x0 = clamp(cx - w / 2, 0, 1 - w), y0 = clamp(cy - h / 2, 0, 1 - h);
  E.r = [x0, y0, x0 + w, y0 + h];
}
function bindCrop() {
  $('#ciCrop').onclick = startCrop;
  $('#ciCropReset').onclick = resetCrop;
  $('#pjFill').onchange = (e) => { mutate(() => { S.proj.fill = e.target.value; clips().forEach(k => { if (k.cam) recam(k); }); }); fitStage(); seek(S.t); };
  $('#cropDone').onclick = () => endCrop(true);
  $('#cropCancel').onclick = () => endCrop(false);
  $('#cropReset').onclick = () => { const E = S.cropEdit; if (!E) return; E.r = [0, 0, 1, 1]; if (E.aspect !== 'free') cropToAspect(E, E.aspect); drawCropRect(); };
  $('#cropAsp').onclick = (e) => {
    const b = e.target.closest('button'); const E = S.cropEdit; if (!b || !E) return;
    E.aspect = b.dataset.a; $('#cropAsp').querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    if (E.aspect !== 'free') cropToAspect(E, E.aspect); drawCropRect();
  };
  const layer = $('#cropLayer'); let drag = null;
  layer.addEventListener('pointerdown', (e) => {
    const E = S.cropEdit; if (!E) return;
    e.preventDefault();
    const h = e.target.dataset?.h, inRect = e.target.closest('#cropRect');
    if (!h && !inRect) return;
    try { layer.setPointerCapture(e.pointerId); } catch {}
    drag = { id: e.pointerId, h: h || 'move', x: e.clientX, y: e.clientY, r0: E.r.slice() };
  });
  layer.addEventListener('pointermove', (e) => {
    const E = S.cropEdit; if (!E || !drag || e.pointerId !== drag.id) return;
    e.preventDefault();
    const rc = layer.getBoundingClientRect(), dx = (e.clientX - drag.x) / rc.width, dy = (e.clientY - drag.y) / rc.height;
    let [x0, y0, x1, y1] = drag.r0; const MIN = 0.08;
    if (drag.h === 'move') {
      const w = x1 - x0, h = y1 - y0; x0 = clamp(x0 + dx, 0, 1 - w); y0 = clamp(y0 + dy, 0, 1 - h); x1 = x0 + w; y1 = y0 + h;
    } else {
      // the opposite corner stays put
      const L = drag.h.includes('w'), T = drag.h.includes('n');
      let ax = L ? x1 : x0, ay = T ? y1 : y0, px = clamp((L ? x0 : x1) + dx, 0, 1), py = clamp((T ? y0 : y1) + dy, 0, 1);
      let w = Math.max(MIN, Math.abs(px - ax)), h = Math.max(MIN, Math.abs(py - ay));
      const A = CROP_ASPECTS[E.aspect];
      if (A) {
        const ar = rc.width / rc.height; // normalized -> pixels
        if (w * ar / h > A) w = h * A / ar; else h = w * ar / A;
        const wMax = L ? ax : 1 - ax, hMax = T ? ay : 1 - ay; // keep inside the frame, shape locked
        const s = Math.min(1, wMax / w, hMax / h); w *= s; h *= s;
      } else { w = Math.min(w, L ? ax : 1 - ax); h = Math.min(h, T ? ay : 1 - ay); }
      x0 = L ? ax - w : ax; x1 = x0 + w; y0 = T ? ay - h : ay; y1 = y0 + h;
    }
    E.r = [x0, y0, x1, y1]; drawCropRect();
  });
  const up = (e) => { if (drag && e.pointerId === drag.id) drag = null; };
  layer.addEventListener('pointerup', up); layer.addEventListener('pointercancel', up);
  addEventListener('resize', () => { if (S.cropEdit) drawCropRect(); });
}
function bindFocus() {
  $('#ciFocus').onclick = () => setFocusMode(!S.focusMode);
  $('#focusLayer').addEventListener('pointerdown', onFocusTap);
  $('#ciFocusClr').onclick = () => { const c = selClip() || clips()[S.idx]; if (!c) return; mutate(() => { if (c.focus) { c.focus = null; recam(c); } else if (S.proj.focus?.[c.mediaId]) { delete S.proj.focus[c.mediaId]; clips().forEach(k => { if (k.mediaId === c.mediaId) recam(k); }); } }); };
  $('#ciPov').onchange = (e) => { const c = selClip(); if (!c) return; const v = e.target.value, st = loadAutoSettings();
    mutate(() => {
      S.proj.pov = { ...(S.proj.pov || {}) }; if (v === 'auto') delete S.proj.pov[c.mediaId]; else S.proj.pov[c.mediaId] = v;
      let k = 0;
      clips().forEach(x => { if (x.mediaId !== c.mediaId) return;
        if (st.hideMan !== 'off' && isThird(x.mediaId)) { x.hide = st.hideMan === 'all' || k % 5 !== 2 ? 'tight' : 'ctx'; k++; recam(x, x.cam?.type || 'medium'); }
        else if (x.hide) { delete x.hide; recam(x); } });
    }); seek(S.t); };
  $('#ciCam').onchange = (e) => { const c = selClip(); if (!c) return; mutate(() => recam(c, e.target.value, $('#ciFlip').checked)); seek(S.t); };
  $('#ciFlip').onchange = (e) => { const c = selClip(); if (!c?.cam) return; mutate(() => recam(c, c.cam.type, e.target.checked)); seek(S.t); };
  const L = () => LEVELS[camLevel()] || LEVELS[2], fishK = () => +$('#auFish').value || 0.18;
  $('#ciAngle').onchange = (e) => { const c = selClip(); if (!c?.cam) return; const lk = lookOf(c.cam), v = e.target.value;
    mutate(() => recam(c, c.cam.type, c.cam.flip, { ...lk, angle: v === 'none' ? undefined : v, ks: v === 'none' ? undefined : (lk.ks || L().ks) })); seek(S.t); };
  $('#ciLens').onchange = (e) => { const c = selClip(); if (!c?.cam) return; const lk = lookOf(c.cam), v = e.target.value;
    const roll = v === 'dutch' || v === 'both' ? (lk.roll || L().roll) : undefined, fish = v === 'fish' || v === 'both' ? (lk.fish || fishK()) : undefined;
    mutate(() => recam(c, c.cam.type, c.cam.flip, { ...lk, roll, fish })); seek(S.t); };
  $('#ciSpeed').onchange = (e) => { const c = selClip(); if (!c) return; const v = +e.target.value; mutate(() => { if (v >= 1) delete c.speed; else c.speed = v; }); seek(S.t); };
  $('#ciMcCam').onchange = (e) => { const c = selClip(); if (c) setClipCamera(c, e.target.value); };
  // Shadows: drag = live preview, release = one undo step
  let shDrag = null; // { had, prev } while dragging
  $('#ciShadow').oninput = (e) => { const c = selClip(); if (!c) return; if (!shDrag) shDrag = { had: c.shadow != null, prev: c.shadow }; c.shadow = +e.target.value; $('#ciShadowV').textContent = e.target.value; $('#ciShadowAuto').checked = false; applyLook(); };
  $('#ciShadow').onchange = (e) => { const c = selClip(); if (!c) return; const v = +e.target.value; if (shDrag) { if (shDrag.had) c.shadow = shDrag.prev; else delete c.shadow; } shDrag = null; mutate(() => { c.shadow = v; }); };
  $('#ciShadowAuto').onchange = (e) => { const c = selClip(); if (!c) return; mutate(() => { if (e.target.checked) delete c.shadow; else c.shadow = Math.round(shadowAmt(c) * 100); }); };
  $('#ciBoom').onchange = (e) => { const c = selClip(); if (!c) return; mutate(() => { if (e.target.checked) c.boom = true; else delete c.boom; }); seek(S.t); };
  $('#exXf').onchange = (e) => { const v = parseXf(e.target.value); mutate(() => { S.proj.xfade = v.xfade; S.proj.xfadeType = v.xfadeType; }); };
}

// ---------------- Auto Edit ----------------
const CAM_NAMES = { 1: 'Subtle', 2: 'Medium', 3: 'Bold' };
function readAutoUI() {
  return { order: $('#auOrder').value, xfade: $('#auXfade').value, strict: $('#auStrict').value, altAngle: $('#auAlt').checked,
    color: $('#auColor').checked, shadows: $('#auShadows').checked, denoise: $('#auDenoise').checked, sharpen: $('#auSharpen').checked, stabilize: $('#auStab').checked,
    camera: $('#auCam').checked, camLevel: +$('#auCamL').value,
    angles: $('#auAngles').checked, dutch: $('#auDutch').checked, fish: $('#auFish').value, extend: $('#auExtend').value, slowmo: $('#auSlow').value,
    multicam: $('#auMc').value, mcXfade: $('#auMcXf').value, mcPace: $('#auMcPace').value, mcReplay: $('#auMcReplay').value, mcReplaySlow: $('#auMcRSlow').checked,
    keepFrame: $('#auKeep').checked, frameTight: $('#auTight').value, hideMan: $('#auHide').value };
}
function writeAutoUI(st) {
  $('#auOrder').value = st.order; $('#auXfade').value = String(st.xfade); $('#auStrict').value = st.strict;
  $('#auColor').checked = st.color; $('#auShadows').checked = st.shadows !== false; $('#auDenoise').checked = st.denoise; $('#auSharpen').checked = st.sharpen; $('#auStab').checked = st.stabilize;
  $('#auCam').checked = st.camera; $('#auCamL').value = st.camLevel; $('#auCamV').textContent = CAM_NAMES[st.camLevel] || 'Medium';
  $('#auCamL').disabled = !st.camera; $('#auAlt').checked = !!st.altAngle;
  $('#auAngles').checked = !!st.angles; $('#auDutch').checked = !!st.dutch; $('#auFish').value = String(st.fish ?? '0');
  $('#auExtend').value = String(st.extend || '0'); $('#auSlow').value = st.slowmo || 'fast';
  $('#auMc').value = st.multicam || 'auto'; $('#auMcXf').value = String(st.mcXfade ?? '0.2'); $('#auMcPace').value = st.mcPace || 'normal';
  $('#auMcReplay').value = String(st.mcReplay ?? 'auto'); $('#auMcRSlow').checked = st.mcReplaySlow !== false;
  $('#auKeep').checked = st.keepFrame !== false; $('#auTight').value = st.frameTight || 'balanced'; $('#auHide').value = st.hideMan || 'most'; $('#auTight').disabled = st.keepFrame === false;
  setFraming(st.keepFrame !== false);
}
function bindAuto() {
  writeAutoUI(loadAutoSettings());
  const fi = $('#autoFile');
  const pick = () => { if (S.autoJob) return toast('Auto Edit is already running'); unlockAnalysis(); fi.click(); };
  $('#auPick').onclick = pick; $('#btnAuto').onclick = () => { showTab('auto'); pick(); }; $('#btnAuto2').onclick = pick;
  fi.onchange = () => { const f = [...fi.files]; fi.value = ''; if (f.length) autoEdit(f); };
  $('#auRerun').onclick = () => { unlockAnalysis(); autoEdit(null); };
  $('#auCancel').onclick = () => { S.autoJob?.abort(); S.exportJob?.cancel?.(); };
  $('#auExport').onclick = doExportAuto;
  $('#auCamL').oninput = () => { $('#auCamV').textContent = CAM_NAMES[$('#auCamL').value]; };
  ['#auOrder', '#auXfade', '#auStrict', '#auColor', '#auShadows', '#auDenoise', '#auSharpen', '#auStab', '#auCam', '#auCamL', '#auAlt', '#auAngles', '#auDutch', '#auFish', '#auExtend', '#auSlow', '#auMc', '#auMcXf', '#auMcPace', '#auMcReplay', '#auMcRSlow', '#auKeep', '#auTight', '#auHide'].forEach(id => $(id).addEventListener('change', () => {
    const st = readAutoUI(); saveAutoSettings(st); setFraming(st.keepFrame !== false); $('#auCamL').disabled = !st.camera; $('#auTight').disabled = !st.keepFrame; setFraming(st.keepFrame);
    if (S.analysis.size && S.proj.autoCuts && !S.autoJob) { $('#auStatus').textContent = 'Settings changed — re-editing…'; autoEdit(null); }
  }));
}
const auProg = (f, msg) => { $('#auBar').style.width = Math.round(f * 100) + '%'; $('#auStatus').textContent = msg + (f > 0 && f < 1 ? ` · ${Math.round(f * 100)}%` : ''); };

/** One-tap Auto Edit. files = new File[] to import, or null to re-run on this project's source videos. */
async function autoEdit(files) {
  if (S.autoJob) return;
  const st = readAutoUI(); saveAutoSettings(st);
  const ac = new AbortController(); S.autoJob = ac;
  pause(); showTab('auto');
  $('#auCancel').hidden = false; $('#auPick').disabled = $('#auRerun').disabled = true; $('#auExportBox').hidden = true;
  $('#tab-auto').scrollIntoView?.({ block: 'nearest' });
  const t0 = performance.now();
  let newMids = null;
  try {
    let mids;
    if (files) {
      auProg(0, 'Importing…');
      const added = await importFiles(files, { add: false, deferFinish: true, onProgress: (m) => auProg(0.01, m) });
      if (!added?.length) throw new Error('No playable videos were imported');
      mids = added.map(c => c.mediaId); newMids = mids;
    } else {
      mids = [...new Set([...clips(), ...(S.proj.autoCuts || [])].map(c => c.mediaId))].filter(id => S.media.has(id));
      if (!mids.length) throw new Error('No videos in this project yet — tap “Auto Edit — pick videos”.');
    }
    // 1) analyse (cached per video, so changing settings re-plans instantly)
    const totalDur = mids.reduce((a, id) => a + (S.media.get(id).duration || 1), 0);
    let done = 0;
    const items = [];
    for (let i = 0; i < mids.length; i++) {
      const id = mids[i], m = S.media.get(id);
      if (m.captureMeta === undefined) m.captureMeta = await readCaptureTime(m.blob);
      if (m.capture == null) m.capture = m.captureMeta || m.blob.lastModified || null;
      let an = S.analysis.get(id);
      const ta = performance.now();
      if (an && (st.keepFrame !== false || st.hideMan !== 'off') && an.pv !== 4) an = null; // analysed without (current) people detection: redo
      if (!an) {
        let pose = null;
        if (st.keepFrame !== false || st.hideMan !== 'off') { auProg(0.9 * done / totalDur, 'Loading the people detector…'); pose = await loadPose(); }
        an = await analyzeRange(m.url, 0, m.duration, { signal: ac.signal, pose,
          onTick: (f) => auProg(0.9 * (done + f * m.duration) / totalDur, `Analyzing clip ${i + 1} of ${mids.length}…`) });
        console.info(`[auto] analysed ${m.name} (${m.duration.toFixed(1)} s) in ${Math.round(performance.now() - ta)} ms via ${an.mode}, ${an.samples.length} samples`);
        an.posed = !!pose; an.pv = 4; an.pov = classifyPov(an.samples);
        console.info(`[framing] ${m.name}: ${an.pov.kind} (two heads ${an.pov.two}, partial ${an.pov.partial}, shake ${an.pov.shake})`);
        S.analysis.set(id, an);
      }
      // baked-in black bars (e.g. padding from cropping / re-framing in Photos): trimmed by a default crop for this video
      // unless the crop was set by hand (an explicit "whole frame" is kept as [0, 0, 1, 1])
      if (an.bars && !S.proj.crops?.[id]) { S.proj.crops = { ...(S.proj.crops || {}), [id]: an.bars.slice() }; console.info(`[crop] ${m.name}: baked black bars trimmed`, an.bars); }
      done += m.duration;
      items.push({ mediaId: id, name: m.name.replace(/\.\w+$/, ''), in: 0, out: r2(m.duration), dur: m.duration, w: m.w, h: m.h,
        order: m.order ?? i, capture: m.capture, samples: an.samples, step: an.step });
    }
    // 1b) multi-cam: clips filmed at the same time (matched by their sound) share one timeline
    let groups = [];
    if (st.multicam !== 'off' && mids.length >= 2) {
      auProg(0.9, 'Matching camera angles by sound…');
      groups = await syncCameras(mids);
    } else if (S.proj.mc) S.proj.mc.groups = [];
    // 2) plan shots, enhancement and camera
    auProg(0.92, 'Choosing the best shots…');
    const inGroup = new Set(groups.flatMap(g => g.members.map(m => m.mediaId)));
    const plan = planEdit(items, { ...st, skip: inGroup });
    const enh = {};
    for (const it of items) {
      const m = S.media.get(it.mediaId);
      if (m && m.hdr === undefined && m.blob) m.hdr = await videoColor(m.blob);
      enh[it.mediaId] = enhanceFor(it.samples, { ...st, hdr: m?.hdr && m.hdr !== 'wide' ? m.hdr : null });
    }
    const xf = parseXf(groups.length ? st.mcXfade : st.xfade);
    const itemMap = new Map(items.map(it => [it.mediaId, it]));
    const units = plan.keep.map(s => ({ shots: [s], cap: (s.capture ?? Infinity) + s.in * 1000, order: s.order, in: s.in, score: s.score }));
    const mcCuts = [];
    for (const g of groups) {
      const r = planMulticam(g, itemMap, { framing: st.keepFrame !== false, xfade: xf.xfade, pace: st.mcPace, lapRef: plan.lapRef, envOf: (id) => S.mcFeat.get(id)?.env, nudge: S.proj.mc?.nudge });
      if (!r?.shots.length) continue;
      g.master = r.master;
      // every-angle replays: highlight moments played back to back from each camera, then the edit carries on
      g.moments = [];
      if (st.mcReplay !== '0') {
        const rr = addAngleReplays(r.shots, g, itemMap, { count: st.mcReplay || 'auto', len: REPLAY_LEN[st.mcPace] || 2.2, slow: st.mcReplaySlow !== false ? 0.8 : 1,
          xfade: xf.xfade, lapRef: plan.lapRef, envOf: (id) => S.mcFeat.get(id)?.env, nudge: S.proj.mc?.nudge });
        r.shots = rr.shots; g.moments = rr.moments;
      }
      r.shots.forEach(s => { s.name = `${s.mc.replay ? '🔁' : '🎥'}${camLetter(s.mc.cam)} ${s.name}`; });
      const mem = g.members.map(m => itemMap.get(m.mediaId)).filter(Boolean);
      units.push({ shots: r.shots, cap: Math.min(...mem.map(it => it.capture ?? Infinity)), order: Math.min(...mem.map(it => it.order)), in: 0, score: r.shots.reduce((a, s) => a + s.score, 0) / r.shots.length });
      for (const c of r.cuts) {
        const it = itemMap.get(c.mediaId), mid = (c.in + c.out) / 2;
        const th = (it.samples || []).reduce((b, x) => (!b || Math.abs(x.t - mid) < Math.abs(b.t - mid) ? x : b), null)?.thumb || '';
        mcCuts.push({ ...c, in: r2(c.in), out: r2(c.out), id: uid(), name: it.name, dur: it.dur, w: it.w, h: it.h, score: 0, order: it.order, capture: it.capture, thumb: th });
      }
    }
    if (st.order === 'best') units.sort((a, b) => b.score - a.score);
    else if (st.order === 'capture') units.sort((a, b) => (a.cap - b.cap) || (a.order - b.order) || (a.in - b.in));
    else units.sort((a, b) => (a.order - b.order) || (a.in - b.in));
    let shots = units.flatMap(u => u.shots);
    if (!shots.length) throw new Error('Every part looked bad with these settings — try “Loose” sensitivity.');
    // Extend (only the real footage): slow-mo on the best stretches, boomerangs, replays from another angle
    const ext = extendShots(shots, st.extend, { xfade: xf.xfade, lapRef: plan.lapRef });
    shots = ext.shots;
    assignHide(shots, st);
    // planCamera splits long shots, so the 'most' pattern is re-dealt per final clip inside the fit hook
    const hideNext = hider(st);
    if (st.camera) { shots = planCamera(shots, st.camLevel, { xfade: xf.xfade, altAngle: st.altAngle, angles: st.angles, dutch: st.dutch, fish: st.fish,
      subjFn: (s, a, b) => subjectFromFocus(S.proj.focus?.[s.mediaId], a, b) || (st.keepFrame !== false && subjectFromProtected(s, a, b)) || null,
      fit: (st.keepFrame !== false || st.hideMan !== 'off') ? (s, cam) => { hideNext(s); return fitFor(s, cam, st); } : null });
      for (const s of shots) if (!s.cam) delete s.hide; }
    else for (const s of shots) { delete s.wantAngle; delete s.wantFish; delete s.flipAngle; delete s.camType; if (s.hide) s.cam = fitFor(s, { type: 'medium', z0: 1, z1: 1, x0: 0.5, y0: 0.5, x1: 0.5, y1: 0.5 }, st); }
    const newClips = shots.map((s, k) => {
      const shake = s.samples?.length ? s.samples.map(x => x.shake).sort((a, b) => a - b)[Math.floor(s.samples.length / 2)] : 0;
      const e = (st.color || st.shadows || st.denoise || st.sharpen || st.stabilize) ? { ...enh[s.mediaId], stab: !!(st.stabilize && shake > 0.015) } : null;
      const o = { id: uid(), mediaId: s.mediaId, name: `${s.name} · ${k + 1}${s.ext === 'slow' ? ' · slow-mo' : s.ext === 'boom' ? ' · boomerang' : s.ext === 'replay' ? ' · replay' : s.ext === 'angles' ? ' · every angle' : ''}`, in: s.in, out: s.out, dur: s.dur, w: s.w, h: s.h, muted: false,
        enh: e, cam: st.camera || s.hide ? s.cam : null, score: s.score, capture: s.capture, order: s.order, thumb: s.thumb || '' };
      if (S.proj.crops?.[s.mediaId]) o.crop = S.proj.crops[s.mediaId].slice();
      { // where the people are (median subject centre): the "no black bars" fill keeps them in
        const ss = (s.samples || []).filter(x => Number.isFinite(x.cx) && Number.isFinite(x.cy)), md = (k) => ss.map(x => x[k]).sort((a, b) => a - b)[ss.length >> 1];
        if (ss.length >= 3) o.fc = [+md('cx').toFixed(3), +md('cy').toFixed(3)];
      }
      if (s.speed && s.speed < 1) o.speed = s.speed;
      if (s.boom) o.boom = true;
      if (s.hide) o.hide = s.hide;
      if (s.ext) o.ext = s.ext;
      if (s.mc) o.mc = { ...s.mc };
      if (s.audioFrom && s.audioFrom.mediaId !== s.mediaId) o.audioFrom = { ...s.audioFrom };
      return o;
    });
    const cuts = [...plan.cuts, ...mcCuts].map(c => ({ id: c.id, mediaId: c.mediaId, name: c.name, in: c.in, out: c.out, dur: c.dur, w: c.w, h: c.h, reasons: c.reasons, thumb: c.thumb, score: c.score, capture: c.capture, order: c.order }));
    mutate(() => {
      S.proj.clips = newClips; S.proj.autoCuts = cuts; S.proj.autoEnh = enh; S.proj.xfade = xf.xfade; S.proj.xfadeType = xf.xfadeType; S.sugg = [];
      S.proj.slowmo = st.slowmo || 'fast';
      S.proj.extendInfo = ext.ops.length ? { base: +ext.base.toFixed(2), length: +ext.length.toFixed(2), target: +ext.target.toFixed(2), ops: ext.ops } : null;
      S.sel = newClips[0]?.id || null;
      if (S.proj.name === 'Untitled project') { S.proj.name = 'Auto edit ' + new Date().toLocaleDateString(); $('#projName').value = S.proj.name; }
    });
    S.t = 0; seek(0);
    auProg(1, `${mids.length >= 2 && st.multicam !== 'off' ? mcSummary(mids, groups) + ' · ' : ''}Done in ${((performance.now() - t0) / 1000).toFixed(0)} s. Preview it, tweak anything on the timeline, then export.`);
    window.__lastPlan = { plan, settings: st, ext };
  } catch (e) {
    auProg(0, e.message === 'Cancelled' ? 'Cancelled.' : 'Auto Edit failed: ' + (e.message || e));
    console.error(e);
  } finally {
    S.autoJob = null; $('#auCancel').hidden = true; $('#auPick').disabled = $('#auRerun').disabled = false;
    if (newMids) finishImport(newMids); // poster/capture/save after analysis so they don't compete for the decoder
    renderAuto();
  }
}
// ---------------- Multi-cam ----------------
const camLetter = (i) => 'ABCDEFGHIJKL'[i] || String(i + 1);
const mcState = () => (S.proj.mc ||= { groups: [], assign: {}, nudge: {} });
const mcGroupOf = (gid) => (S.proj.mc?.groups || []).find(g => g.id === gid);
const mcOff = (g, id) => { const m = g?.members.find(x => x.mediaId === id); return m ? m.off + (S.proj.mc?.nudge?.[id] || 0) : null; };
/** find clips filmed at the same time (by their sound); cached until the set of videos or the manual grouping changes */
async function syncCameras(mids) {
  const mc = mcState();
  for (let i = 0; i < mids.length; i++) {
    const id = mids[i];
    if (!S.mcFeat.has(id)) {
      auProg(0.9, `Matching camera angles by sound… ${i + 1}/${mids.length}`);
      const diag = {};
      let f = null; try { f = await audioFeatures(S.media.get(id).blob, diag); } catch (e) { console.warn('[mc] no audio features', e); (diag.tried ||= []).push({ via: 'all', err: e.message || String(e) }); }
      S.mcFeat.set(id, f); S.mcDiag.set(id, diag);
      console.info(`[mc] sound of ${S.media.get(id).name}: ${f ? `${diag.via}, ${f.dur.toFixed(1)} s, ${diag.level} dB` : 'NOT READ'} in ${diag.ms} ms`, JSON.stringify({ tried: diag.tried, tracks: diag.tracks }));
    }
  }
  const key = [...mids].sort().join(',') + '|' + JSON.stringify(mc.assign || {});
  if (mc.key === key && mc.groups) return mc.groups;
  const t0 = performance.now();
  const list = mids.map(id => { const m = S.media.get(id); return { mediaId: id, dur: m.duration, feat: S.mcFeat.get(id), capture: m.captureMeta ?? null, size: m.blob?.size }; });
  const gs = groupClips(list, { assign: mc.assign || {}, prev: mc.groups || [] });
  mc.pairs = gs.pairs || []; mc.groups = [...gs];
  mc.key = key;
  console.info('[mc] pairs', JSON.stringify(mc.pairs));
  console.info(`[mc] sync ${mids.length} clips in ${Math.round(performance.now() - t0)} ms:`, JSON.stringify(mc.groups.map(g => g.members.map(m => [S.media.get(m.mediaId)?.name, m.off, m.conf, m.method]))));
  return mc.groups;
}
function mcRerun(msg) { if (S.autoJob) return; $('#auStatus').textContent = msg; autoEdit(null); }
const REPLAY_LEN = { fast: 1.6, normal: 2.2, slow: 3 }; // seconds per angle in an every-angle replay
const nmOf = (id) => S.media.get(id)?.name || '?';
/** one line for the status: "🎥 3 angles synced ✓ (by sound 92%)" / "🎥 Angles not matched …" */
function mcSummary(mids, groups) {
  if (!groups.length) {
    const noSound = mids.filter(id => S.mcFeat.has(id) && !S.mcFeat.get(id));
    return noSound.length ? `🎥 Angles not matched — couldn't read the sound of ${noSound.length} clip${noSound.length > 1 ? 's' : ''} (see Multi-cam below)` : '🎥 Angles not matched by sound';
  }
  return groups.map(g => {
    const ms = g.members.filter(m => m.method !== 'ref'), how = ms.every(m => m.method === 'audio') ? `by sound ${Math.round(Math.min(...ms.map(m => m.conf)) * 100)}%` : ms.some(m => m.method === 'start') ? 'lined up by start — nudge if needed' : ms.some(m => m.method === 'time') ? 'by capture time' : 'grouped by you';
    return `🎥 ${g.members.length} angles synced ✓ (${how})`;
  }).join(' · ');
}
/** clips that look like the same scene (not grouped): similar length + similar look */
function lookAlike(ids) {
  const stat = (id) => { const ss = S.analysis.get(id)?.samples || []; const m = S.media.get(id); const av = (k) => ss.reduce((a, x) => a + (x[k] || 0), 0) / Math.max(1, ss.length); return { d: m?.duration || 0, l: av('luma'), sat: av('sat'), port: (m?.h || 0) > (m?.w || 0) }; };
  const st = ids.map(id => ({ id, ...stat(id) }));
  const out = [];
  for (const x of st) {
    const sim = st.filter(y => y !== x && Math.min(x.d, y.d) / Math.max(x.d, y.d) >= 0.4 && Math.abs(x.l - y.l) < 0.18 && Math.abs(x.sat - y.sat) < 0.2);
    if (sim.length) out.push(x.id);
  }
  return out;
}
function groupAsScene(ids, msg) {
  if (ids.length < 2) return toast('Pick at least two clips');
  const gid = 'g' + uid();
  mutate(() => { const mcs = mcState(); mcs.assign ||= {}; ids.forEach(id => { mcs.assign[id] = gid; }); mcs.key = ''; delete mcs.noPrompt; });
  mcRerun(msg || 'Grouping as one scene from different angles…');
}
function syncView(g, mc) {
  const cv = document.createElement('canvas'); cv.className = 'mcview'; const W = 640, rowH = 22, H = rowH * g.members.length + 14;
  cv.width = W; cv.height = H; const x = cv.getContext('2d');
  const offs = g.members.map(m => m.off + (mc.nudge?.[m.mediaId] || 0)), durs = g.members.map(m => S.media.get(m.mediaId)?.duration || 0);
  const G0 = Math.min(...offs), G1 = Math.max(...offs.map((o, i) => o + durs[i])), sx = (t) => (t - G0) / Math.max(1e-6, G1 - G0) * (W - 40) + 36;
  x.fillStyle = '#111'; x.fillRect(0, 0, W, H); x.font = '12px sans-serif';
  g.members.forEach((m, i) => {
    const y = i * rowH + 4, env = S.mcFeat.get(m.mediaId)?.env;
    x.fillStyle = '#aaa'; x.fillText(camLetter(i), 8, y + 15);
    x.fillStyle = '#2a2a33'; x.fillRect(sx(offs[i]), y, sx(offs[i] + durs[i]) - sx(offs[i]), rowH - 4);
    if (env) { // sound "hits" (onset envelope) — matching patterns line up vertically when the sync is right
      x.fillStyle = ['#ff5c8a', '#5cd6ff', '#9dff5c', '#ffcf5c', '#c38bff'][i % 5];
      const px0 = Math.floor(sx(offs[i])), px1 = Math.ceil(sx(offs[i] + durs[i]));
      for (let px = px0; px < px1; px++) {
        const t0 = ((px - 36) / (W - 40)) * (G1 - G0) + G0 - offs[i], t1 = t0 + (G1 - G0) / (W - 40);
        let v = 0; for (let k = Math.max(0, Math.floor(t0 * 100)); k < Math.min(env.length, t1 * 100); k++) v = Math.max(v, env[k]);
        const h = Math.min(rowH - 4, v * 3); x.fillRect(px, y + rowH - 4 - h, 1, h);
      }
    } else { x.fillStyle = '#777'; x.fillText('no sound read', sx(offs[i]) + 4, y + 14); }
  });
  (g.moments || []).forEach(mo => { x.fillStyle = 'rgba(255,255,255,.18)'; x.fillRect(sx(mo.g0), 0, Math.max(2, sx(mo.g1) - sx(mo.g0)), H - 12); });
  x.fillStyle = '#888'; x.fillText(`${fmtTime(0)}`, 36, H - 2); x.fillText(fmtTime(G1 - G0), W - 44, H - 2);
  return cv;
}
function diagLine(id) {
  const d = S.mcDiag.get(id); if (!d) return '';
  if (S.mcFeat.get(id)) return `sound read (${d.via}${d.level != null ? `, ${d.level} dB` : ''})`;
  const why = (d.tried || []).map(t => `${t.via}: ${t.err}`).join('; ');
  return `⚠ couldn't read the sound${d.tracks ? ` (tracks: ${d.tracks.map(t => t.codec).join(', ') || 'none'})` : ''}${why ? ` — ${why}` : ''}`;
}
function renderMcBox(box) {
  const mc = S.proj.mc, st = readAutoUI();
  const mids = [...new Set([...clips(), ...(S.proj.autoCuts || [])].map(c => c.mediaId))].filter(id => S.media.has(id));
  if (st.multicam === 'off' || mids.length < 2 || !mc) return;
  const groups = mc.groups || [], wrap = document.createElement('div'); wrap.className = 'mcbox';
  const inG = new Set(groups.flatMap(g => g.members.map(m => m.mediaId)));
  const opts = (id) => {
    const cur = mc.assign?.[id] || 'auto';
    return `<option value="auto"${cur === 'auto' ? ' selected' : ''}>Auto</option><option value="none"${cur === 'none' ? ' selected' : ''}>Not multi-cam</option>` +
      groups.map((g, gi) => `<option value="${g.id}"${cur === g.id ? ' selected' : ''}>In multi-cam ${gi + 1}</option>`).join('') + `<option value="new">New multi-cam group</option>`;
  };
  const others = mids.filter(id => !inG.has(id));
  const promptKey = others.slice().sort().join(',');
  const alike = !groups.length && mc.noPrompt !== promptKey ? lookAlike(others) : [];
  let h = `<div class="mcstat ${groups.length ? 'ok' : 'no'}">${esc(mcSummary(mids, groups))}</div>`;
  if (alike.length >= 2) h += `<div class="mcprompt">These ${alike.length} clips look alike (similar length and look). <b>Are these the same scene from different angles?</b>
    <div class="row"><button class="primary mcyes">Yes — cut between the angles</button><button class="mcno">No</button></div></div>`;
  groups.forEach((g, gi) => {
    const mem = [...g.members].sort((a, b) => a.off - b.off);
    h += `<div class="mcg" data-g="${g.id}"><b>🎥 Multi-cam ${gi + 1}</b> · ${mem.length} angles synced${g.master ? ` · 🔊 sound from ${esc(nmOf(g.master))}` : ''}${g.moments?.length ? ` · 🔁 ${g.moments.length} every-angle replay${g.moments.length > 1 ? 's' : ''}` : ''}<div class="mcviewbox"></div>`;
    mem.forEach(m => {
      const k = g.members.indexOf(m), nud = mc.nudge?.[m.mediaId] || 0;
      const how = m.method === 'ref' ? 'reference' : m.method === 'audio' ? `by sound ${Math.round(m.conf * 100)}%` : m.method === 'time' ? 'by capture time (±1 s, check it)' : m.method === 'start' ? 'lined up by start (sound didn\u2019t match) — nudge to sync' : 'manual';
      h += `<div class="mcrow" data-id="${m.mediaId}"><span class="mccam">${camLetter(k)}</span><span class="mcname">${esc(nmOf(m.mediaId))}<br><span class="muted small">starts at ${(m.off + nud).toFixed(3)} s · ${how}${nud ? ` · nudged ${nud > 0 ? '+' : ''}${Math.round(nud * 1000)} ms` : ''}<br>${esc(diagLine(m.mediaId))}</span></span>
        <span class="mcnudge"><button data-d="-1">−1s</button><button data-d="-0.1">−0.1s</button><button data-d="${(-1 / 30).toFixed(4)}">−1f</button><button data-d="${(1 / 30).toFixed(4)}">+1f</button><button data-d="0.1">+0.1s</button><button data-d="1">+1s</button></span>
        <select class="mcassign">${opts(m.mediaId)}</select></div>`;
    });
    h += `</div>`;
  });
  if (others.length) {
    h += `<div class="mcg"><b>Other videos</b> <span class="muted small">— tick the clips that show the same scene:</span>`;
    others.forEach(id => { h += `<div class="mcrow" data-id="${id}"><label class="chk mcpick"><input type="checkbox" class="mcsel" value="${id}" checked></label><span class="mcname">${esc(nmOf(id))}<br><span class="muted small">${esc(diagLine(id))}</span></span><select class="mcassign">${opts(id)}</select></div>`; });
    h += `<button class="wide primary mcscene">🎥 Same scene — different angles (group the ticked clips)</button></div>`;
  }
  h += `<button class="wide mcresync">↻ Re-sync by sound (clears nudges and manual groups)</button>`;
  wrap.innerHTML = h;
  groups.forEach(g => { const vb = wrap.querySelector(`.mcg[data-g="${g.id}"] .mcviewbox`); if (vb) vb.appendChild(syncView(g, mc)); });
  wrap.querySelectorAll('.mcnudge button').forEach(b => b.onclick = () => {
    const id = b.closest('.mcrow').dataset.id, mcs = mcState();
    mutate(() => { mcs.nudge ||= {}; const v = Math.round(((mcs.nudge[id] || 0) + +b.dataset.d) * 1000) / 1000; if (Math.abs(v) < 1e-4) delete mcs.nudge[id]; else mcs.nudge[id] = v; });
    mcRerun('Sync nudged — re-cutting…');
  });
  wrap.querySelectorAll('.mcassign').forEach(sel => sel.onchange = () => {
    const id = sel.closest('.mcrow').dataset.id, mcs = mcState();
    mutate(() => { mcs.assign ||= {}; if (sel.value === 'auto') delete mcs.assign[id]; else mcs.assign[id] = sel.value === 'new' ? 'g' + uid() : sel.value; });
    mcRerun('Multi-cam grouping changed — re-syncing…');
  });
  const sc = wrap.querySelector('.mcscene'); if (sc) sc.onclick = () => groupAsScene([...wrap.querySelectorAll('.mcsel:checked')].map(i => i.value));
  const y = wrap.querySelector('.mcyes'); if (y) y.onclick = () => groupAsScene(alike);
  const n = wrap.querySelector('.mcno'); if (n) n.onclick = () => { mutate(() => { mcState().noPrompt = promptKey; }); renderAuto(); };
  wrap.querySelector('.mcresync').onclick = () => { mutate(() => { const mcs = mcState(); mcs.assign = {}; mcs.nudge = {}; mcs.key = ''; }); mcRerun('Re-syncing by sound…'); };
  box.appendChild(wrap);
}
/** Clip tab / preview: replay the moment just before the playhead from every camera, then carry on */
function markMomentAllAngles() {
  const { idx, local } = locate(S.t); const c = clips()[idx];
  const g = c?.mc ? mcGroupOf(c.mc.group) : null;
  if (!c || !g) return toast('This works on multi-cam shots — group the clips with “🎥 Same scene — different angles” first');
  if (c.mc.replay) return toast('Move the playhead onto a live shot (not a replay)');
  const len = REPLAY_LEN[readAutoUI().mcPace] || 2.2;
  const src = c.in + local * clipSpeed(c), co = mcOff(g, c.mediaId), T = src + co;
  const cams = g.members.map((m, k) => { const md = S.media.get(m.mediaId); return md && { mediaId: m.mediaId, off: mcOff(g, m.mediaId), dur: md.duration, name: md.name.replace(/\.\w+$/, ''), w: md.w, h: md.h, k }; }).filter(Boolean);
  const m1 = T, m0 = Math.max(T - len, Math.min(...cams.map(x => x.off)));
  const mst = g.master && cams.find(x => x.mediaId === g.master);
  const seq = replaySequence(cams, m0, m1, { slow: readAutoUI().mcReplaySlow !== false ? 0.8 : 1, xfade: S.proj.xfade || 0, group: g.id, master: mst || null });
  if (seq.length < 2) return toast('Fewer than two cameras were recording at this moment');
  const cut = +(c.in + local * clipSpeed(c)).toFixed(4);
  mutate(() => {
    const tail = { ...c, id: uid(), in: cut, mc: { ...c.mc, g0: +T.toFixed(4) } };
    c.out = cut; c.mc = { ...c.mc, g1: +T.toFixed(4) };
    const ins = seq.map(s => ({ id: uid(), mediaId: s.mediaId, name: `🔁${camLetter(s.mc.cam)} ${s.name} · every angle`, in: s.in, out: s.out, dur: s.dur, w: s.w, h: s.h, muted: false,
      enh: S.proj.autoEnh?.[s.mediaId] ? { ...S.proj.autoEnh[s.mediaId], stab: false } : (c.enh ? { ...c.enh } : null), cam: null, score: 0.6, capture: c.capture, order: c.order, thumb: '',
      ...(s.speed ? { speed: s.speed } : {}), ext: 'angles', mc: { ...s.mc }, ...(S.proj.crops?.[s.mediaId] ? { crop: S.proj.crops[s.mediaId].slice() } : {}), ...(s.audioFrom.mediaId !== s.mediaId ? { audioFrom: { ...s.audioFrom } } : {}) }));
    const cs = clips(); const i = cs.indexOf(c);
    const head = c.out - c.in > 0.05 ? 1 : 0; if (!head) cs.splice(i, 1);
    cs.splice(i + head, 0, ...ins, tail); S.sel = ins[0].id;
    { const st = loadAutoSettings(); if (st.hideMan !== 'off') for (const x of ins) if (isThird(x.mediaId)) { x.hide = 'tight'; recam(x, 'medium'); } }
    (g.moments ||= []).push({ g0: +m0.toFixed(2), g1: +m1.toFixed(2), cams: seq.map(x => x.mc.cam), manual: true });
  });
  toast(`🔁 Moment replayed from ${seq.length} angles`);
}
/** Clip tab: pick which real camera shows this multi-cam segment */
function renderMcPicker(c) {
  const row = $('#ciMcRow'), sel = $('#ciMcCam'); if (!row) return;
  const g = c.mc ? mcGroupOf(c.mc.group) : null, o = g ? mcOff(g, c.mediaId) : null;
  const ab = $('#ciAngles'); if (ab) ab.hidden = !g || o == null || !!c.mc?.replay;
  if (!g || o == null) { row.hidden = true; return; }
  const a = c.in + o, b = c.out + o;
  const avail = camsCovering(g, a, b, (id) => S.media.get(id)?.duration, S.proj.mc?.nudge || {});
  row.hidden = false;
  sel.innerHTML = g.members.map((m, k) => {
    const ok = avail.includes(m);
    return `<option value="${m.mediaId}"${m.mediaId === c.mediaId ? ' selected' : ''}${ok ? '' : ' disabled'}>Cam ${camLetter(k)} · ${esc(S.media.get(m.mediaId)?.name || '?')}${ok ? '' : ' (not recording then)'}</option>`;
  }).join('');
}
function setClipCamera(c, newId) {
  const g = mcGroupOf(c.mc?.group); if (!g || newId === c.mediaId) return;
  const oOld = mcOff(g, c.mediaId), oNew = mcOff(g, newId), m = S.media.get(newId); if (oOld == null || oNew == null || !m) return;
  const oldId = c.mediaId, aud = programAudio(c, S.media)?.mediaId || oldId; // keep the sound that was playing
  const k = g.members.findIndex(x => x.mediaId === newId);
  mutate(() => {
    const a = c.in + oOld, b = c.out + oOld;
    c.mediaId = newId; c.in = +(a - oNew).toFixed(4); c.out = +(b - oNew).toFixed(4);
    c.dur = m.duration; c.w = m.w; c.h = m.h; c.mc.cam = k;
    c.name = `🎥${camLetter(k)} ${m.name.replace(/\.\w+$/, '')}` + (c.name.match(/ · \d+.*$/)?.[0] || '');
    if (aud !== newId) c.audioFrom = { mediaId: aud, off: +(oNew - mcOff(g, aud)).toFixed(4) }; else delete c.audioFrom;
    if (c.enh && S.proj.autoEnh?.[newId]) c.enh = { ...S.proj.autoEnh[newId], stab: c.enh.stab };
    if (c.cam) recam(c);
  });
  seek(S.t);
}
function renderAuto() {
  const box = $('#auResult'); if (!box) return;
  const cuts = S.proj.autoCuts || [];
  const auto = clips().some(c => c.enh || c.cam || c.mc) || cuts.length || S.proj.mc?.groups?.length;
  $('#auExportBox').hidden = !clips().length || !!S.autoJob;
  if (!auto) { box.innerHTML = ''; return; }
  const cutT = cuts.reduce((a, c) => a + c.out - c.in, 0);
  const srcN = new Set([...clips(), ...cuts].map(c => c.mediaId)).size;
  const camN = clips().filter(c => c.cam && c.cam.type !== 'wide').length;
  const outLen = total() - xfadeDurations(clips(), S.proj.xfade || 0).reduce((x, y) => x + y, 0);
  const angN = clips().filter(c => c.cam?.angle).length, fishN = clips().filter(c => hasFish(c.cam)).length;
  const ei = S.proj.extendInfo, cnt = (k) => (ei?.ops || []).filter(o => o.kind === k).length;
  const mcN = clips().filter(c => c.mc).length, mcG = new Set(clips().filter(c => c.mc).map(c => c.mc.group)).size;
  const mcLine = mcN ? `<br>🎥 Multi-cam: ${mcN} cuts between ${new Set(clips().filter(c => c.mc).map(c => c.mediaId)).size} synced angles${mcG > 1 ? ` in ${mcG} groups` : ''}, ${(S.proj.mc?.groups || []).some(g => !g.master) ? 'each angle with its own sound (lined up by start)' : 'one continuous sound track'}${(() => { const n = (S.proj.mc?.groups || []).reduce((a, g) => a + (g.moments?.length || 0), 0); return n ? ` · 🔁 ${n} every-angle replay${n > 1 ? 's' : ''}` : ''; })()}` : '';
  const extLine = ei ? `<br>⏱ Extended ${ei.base.toFixed(1)} s → ${ei.length.toFixed(1)} s (target ${ei.target.toFixed(1)} s): ${cnt('slow')} slow-mo, ${cnt('boom')} boomerang, ${cnt('replay')} replay${cnt('replay') === 1 ? '' : 's'}` : '';
  box.innerHTML = `<div class="ausum"><b>${clips().length} shots · ${fmtTime(outLen)}</b> from ${srcN} video${srcN === 1 ? '' : 's'}${S.proj.xfade ? ` · ${S.proj.xfade}s ${S.proj.xfadeType === 'black' ? 'dips to black' : 'crossfades'}` : ' · hard cuts'}${camN ? ` · ${camN} camera moves` : ''}${angN ? ` · ${angN} from above/below` : ''}${fishN ? ` · ${fishN} fisheye` : ''}${mcLine}${extLine}<br>
    <span class="muted">Cut ${cuts.length} bad part${cuts.length === 1 ? '' : 's'} (${fmtTime(cutT)}). Tap Restore to put one back.</span></div>`;
  renderMcBox(box);
  for (const c of cuts) {
    const row = document.createElement('div'); row.className = 'aucut';
    row.innerHTML = `${c.thumb ? `<img src="${c.thumb}" alt="">` : '<img alt="">'}<div class="t">${esc(c.name)} · ${fmtTime(c.in)}–${fmtTime(c.out)} (${(c.out - c.in).toFixed(1)}s)<br>${c.reasons.map(r => `<span class="tag">${esc(r)}</span>`).join('')}</div><button>↩ Restore</button>`;
    row.querySelector('button').onclick = () => restoreCut(c.id);
    box.appendChild(row);
  }
  if (cuts.length > 1) {
    const b = document.createElement('button'); b.className = 'wide'; b.textContent = '↩ Restore all';
    b.onclick = () => [...cuts].forEach(c => restoreCut(c.id)); box.appendChild(b);
  }
}
function restoreCut(id) {
  const cut = (S.proj.autoCuts || []).find(c => c.id === id); if (!cut) return;
  mutate(() => {
    const cs = clips();
    const clip = { id: uid(), mediaId: cut.mediaId, name: `${cut.name} · restored`, in: cut.in, out: cut.out, dur: cut.dur, w: cut.w, h: cut.h, muted: false,
      enh: S.proj.autoEnh?.[cut.mediaId] ? { ...S.proj.autoEnh[cut.mediaId] } : null, cam: null, capture: cut.capture, order: cut.order, thumb: cut.thumb || '', ...(S.proj.crops?.[cut.mediaId] ? { crop: S.proj.crops[cut.mediaId].slice() } : {}) };
    // put it back next to its neighbours from the same video (by source time)
    let at = -1;
    cs.forEach((c, i) => { if (c.mediaId === cut.mediaId && c.in <= cut.in) at = i; });
    if (at < 0) { const j = cs.findIndex(c => c.mediaId === cut.mediaId); at = j < 0 ? cs.length - 1 : j - 1; }
    cs.splice(at + 1, 0, clip); S.sel = clip.id;
    S.proj.autoCuts = S.proj.autoCuts.filter(c => c.id !== id);
  });
  toast('Restored ↩ (undo with ↶)');
}
async function doExportAuto() {
  if (!clips().length) return toast('Nothing to export yet');
  if (S.exportJob) return;
  pause();
  const bar = $('#auExBar'), stt = $('#auExStatus'), link = $('#auExLink'), pv = $('#auPreview');
  $('#auExport').disabled = true; $('#auCancel').hidden = false; link.hidden = true; pv.hidden = true;
  const t0 = performance.now();
  const p = withEta((f, msg) => { bar.style.width = Math.round(f * 100) + '%'; stt.textContent = msg; });
  try {
    const res = await bestExport(p, 'auto');
    if (link.href) URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(res.blob);
    link.download = `${(S.proj.name || 'auto-edit').replace(/[^\w-]+/g, '_')}.mp4`;
    link.textContent = `⬇ Save MP4 (${(res.blob.size / 1048576).toFixed(1)} MB, ${res.W}×${res.H}, ${fmtTime(res.duration)})`;
    link.hidden = false; pv.src = link.href; pv.hidden = false;
    stt.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(1)} s · ${PATH_NAMES[res.path] || ''}. Watch it below. On iPhone: tap Save, then Share → Save Video.`;
    window.__lastExport = res;
  } catch (e) { stt.textContent = e?.message === 'Cancelled' ? 'Cancelled.' : 'Export failed: ' + (e.message || e) + ' — try 480p, or Export tab → Real-time export.'; console.error(e); }
  S.exportJob = null; $('#auExport').disabled = false; $('#auCancel').hidden = true;
}

// ---------------- projects / settings ----------------
async function openProject(id) {
  const p = await DB.getProject(id); if (!p) return;
  pause();
  for (const m of S.media.values()) URL.revokeObjectURL(m.url);
  S.media.clear();
  for (const mid of new Set([...p.clips, ...(p.autoCuts || [])].map(c => c.mediaId))) {
    const rec = await DB.getMedia(mid);
    if (rec) S.media.set(mid, { ...rec, url: URL.createObjectURL(playableBlob(rec.blob, rec.name)) });
  }
  S.proj = p; S.sel = p.clips[0]?.id || null; S.selCap = null; S.undo = []; S.redo = []; S.sugg = []; S.analysis.clear();
  $('#projName').value = p.name; player.dataset.mid = ''; player2.dataset.mid = ''; S.t = 0; S.idx = -1;
  localStorage.setItem('vc.last', p.id);
  renderAll(); seek(0);
}
async function openProjects() {
  const list = (await DB.listProjects()).sort((a, b) => b.updated - a.updated);
  const est = await DB.estimate();
  const body = html(`<div class="plist">${list.map(p => `<div class="p" data-id="${p.id}"><div class="t"><b>${esc(p.name)}</b><br><span class="muted small">${p.clips.length} clips · ${new Date(p.updated).toLocaleString()}${p.id === S.proj.id ? ' · open' : ''}</span></div><button data-act="open">Open</button><button data-act="del" class="danger">🗑</button></div>`).join('') || '<p class="muted">No saved projects yet.</p>'}</div>
    <p class="muted small">${est ? `Storage used: ${(est.usage / 1048576).toFixed(0)} MB of ~${(est.quota / 1048576).toFixed(0)} MB.` : ''} Projects + original clips are stored in this browser only (IndexedDB).</p>`);
  body.onclick = async (e) => {
    const b = e.target.closest('button'); if (!b) return; const id = b.closest('.p').dataset.id;
    if (b.dataset.act === 'open') { closeModal(); openProject(id); }
    if (b.dataset.act === 'del') {
      if (!confirm('Delete this project and its stored clips?')) return;
      await DB.delProject(id); await DB.gcMedia(id === S.proj.id ? [] : [...S.media.keys()]);
      if (id === S.proj.id) newProj(true);
      closeModal(); openProjects();
    }
  };
  modal('Projects', body, [{ label: '＋ New project', onClick: () => newProj() }, { label: 'Close', cls: 'primary' }]);
}
async function newProj(skipSave) {
  if (!skipSave) await saveProject(true);
  pause(); for (const m of S.media.values()) URL.revokeObjectURL(m.url);
  S.media.clear(); S.proj = newProject(); S.sel = S.selCap = null; S.undo = []; S.redo = []; S.sugg = []; S.t = 0; S.idx = -1;
  player.removeAttribute('src'); player.dataset.mid = ''; player2.dataset.mid = ''; $('#projName').value = S.proj.name;
  renderAll();
}
function openSettings() {
  const c = loadAI();
  const body = html(`
    <h3>AI provider (optional)</h3>
    <label>Provider<select id="sProv">
      <option value="none">None — local tools only</option>
      <option value="custom">My own endpoint (self-hosted GPU / ComfyUI)</option>
      <option value="fal">fal.ai (Enhance / Upscale / Polish)</option><option value="replicate">Replicate</option><option value="runway">Runway</option>
    </select></label>
    <div class="keyrow"><label>Custom endpoint URL<input id="sUrl" placeholder="https://my-gpu.local:8000/enhance" value="${esc(c.customUrl)}"></label></div>
    <label>Custom endpoint token<input id="sTok" type="password" value="${esc(c.customToken)}"></label>
    <label>fal.ai key<input id="sFal" type="password" autocomplete="off" placeholder="paste key from fal.ai/dashboard/keys" value="${esc(c.fal)}"></label>
    <p class="muted small"><b>fal.ai:</b> get a key at <a href="https://fal.ai/dashboard/keys" target="_blank" rel="noopener">fal.ai/dashboard/keys</a> — paste here — pick “fal.ai” above — Save — select a clip and tap Enhance. Enhance = Topaz Artemis HQ · Upscale = Topaz Proteus 2× (Real-ESRGAN fallback) · AI polish = Artemis HQ 2×. Billed to your fal account.</p>
    <label>Replicate token<input id="sRep" type="password" value="${esc(c.replicate)}"></label>
    <label>Runway key<input id="sRun" type="password" value="${esc(c.runway)}"></label>
    <p class="muted small">Keys are stored only in this browser (localStorage) and are only used when you press an Enhance button and confirm the upload.</p>
    <h3>Privacy</h3>
    <label class="chk"><input type="checkbox" id="sBlur" ${localStorage.getItem('vc.blurOnHide') !== '0' ? 'checked' : ''}> Hide the screen when switching apps/tabs</label>
    <h3>Danger zone</h3>
    <button id="sWipe" class="danger">Erase all projects, clips & keys on this device</button>`);
  body.querySelector('#sProv').value = c.provider;
  body.querySelector('#sWipe').onclick = async () => {
    if (!confirm('Erase everything stored by this app on this device?')) return;
    localStorage.clear(); indexedDB.deleteDatabase('velvetcut'); location.reload();
  };
  modal('Settings', body, [{ label: 'Cancel' }, {
    label: 'Save', cls: 'primary', onClick: () => {
      let prov = $('#sProv').value;
      if (prov === 'none') { if ($('#sFal').value.trim()) prov = 'fal'; else if ($('#sUrl').value.trim()) prov = 'custom'; else if ($('#sRep').value.trim()) prov = 'replicate'; else if ($('#sRun').value.trim()) prov = 'runway'; }
      saveAI({ provider: prov, customUrl: $('#sUrl').value.trim(), customToken: $('#sTok').value.trim(), fal: $('#sFal').value.trim(), replicate: $('#sRep').value.trim(), runway: $('#sRun').value.trim() });
      localStorage.setItem('vc.blurOnHide', $('#sBlur').checked ? '1' : '0');
      toast('Settings saved on this device');
    }
  }]);
}
function privacy(on) { if (on) pause(); $('#privacy').classList.toggle('show', on); }

// ---------------- wire up ----------------
function bind() {
  // age gate
  const g = () => { $('#gateEnter').disabled = !($('#gateAge').checked && $('#gateConsent').checked); };
  $('#gateAge').onchange = g; $('#gateConsent').onchange = g;
  $('#gateEnter').onclick = () => { localStorage.setItem('vc.age18', String(Date.now())); $('#ageGate').classList.remove('show'); };
  if (localStorage.getItem('vc.age18')) $('#ageGate').classList.remove('show');

  $$('.tabs button').forEach(b => b.onclick = () => showTab(b.dataset.tab));
  bindAuto(); bindFocus(); bindCrop();
  const fi = $('#fileInput');
  $('#btnImport').onclick = $('#btnImport2').onclick = () => fi.click();
  fi.onchange = () => { importFiles(fi.files); fi.value = ''; };
  const dz = $('#stageWrap');
  ['dragenter', 'dragover'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $('#dropHint').classList.add('drag'); }));
  ['dragleave', 'drop'].forEach(ev => document.addEventListener(ev, e => { e.preventDefault(); $('#dropHint').classList.remove('drag'); }));
  document.addEventListener('drop', e => { if (e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files); });

  $('#btnPlay').onclick = () => S.playing ? pause() : play();
  $('#scrub').oninput = (e) => seek(+e.target.value);
  $('#btnMuteAll').onclick = () => { S.mutedAll = !S.mutedAll; player.muted = S.mutedAll || selClip()?.muted; $('#btnMuteAll').textContent = S.mutedAll ? '🔇' : '🔊'; };
  [player, player2].forEach(el => el.addEventListener('pause', () => { if (el === player && S.playing && !S.switching && !S.xf && !player.ended && player.currentTime < (clips()[S.idx]?.out ?? 0) - 0.1) { S.playing = false; updatePlayBtn(); } }));

  $('#zoom').oninput = (e) => { S.pxs = +e.target.value; renderTimeline(); };
  $('#lane').addEventListener('pointerdown', (e) => { if (e.target.id === 'lane') seek((e.clientX - $('#lane').getBoundingClientRect().left) / S.pxs); });
  $('#ruler').addEventListener('pointerdown', (e) => {
    const rect = $('#ruler').getBoundingClientRect(); seek((e.clientX - rect.left) / S.pxs);
    const mv = (ev) => seek((ev.clientX - rect.left) / S.pxs);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv); window.addEventListener('pointerup', up);
  });

  // clip inspector
  const setNum = (key) => (e) => { const c = selClip(); if (!c) return; const v = +e.target.value; mutate(() => { if (key === 'in') c.in = r2(clamp(v, 0, c.out - 0.1)); else c.out = r2(clamp(v, c.in + 0.1, c.dur)); }); seek(S.t); };
  $('#ciIn').onchange = setNum('in'); $('#ciOut').onchange = setNum('out');
  $('#ciSetIn').onclick = () => { const { idx, local } = locate(S.t); const c = clips()[idx]; if (!c) return; S.sel = c.id; mutate(() => { c.in = r2(clamp(c.in + local, 0, c.out - 0.1)); }); seek(starts()[idx]); };
  $('#ciSetOut').onclick = () => { const { idx, local } = locate(S.t); const c = clips()[idx]; if (!c) return; S.sel = c.id; mutate(() => { c.out = r2(clamp(c.in + local, c.in + 0.1, c.dur)); }); };
  $('#ciSplit').onclick = () => splitAt(S.t);
  $('#ciAngles').onclick = markMomentAllAngles;
  $('#pvAngles') && ($('#pvAngles').onclick = markMomentAllAngles);
  $('#ciMute').onclick = () => { const c = selClip(); if (!c) return; mutate(() => { c.muted = !c.muted; }); player.muted = S.mutedAll || c.muted || !!previewProg(c); };
  $('#ciDup').onclick = () => { const c = selClip(); if (!c) return; mutate(() => { const i = clips().indexOf(c); const d = { ...c, id: uid() }; clips().splice(i + 1, 0, d); S.sel = d.id; }); };
  $('#ciLeft').onclick = () => moveSel(-1); $('#ciRight').onclick = () => moveSel(1);
  $('#ciDel').onclick = delSel;

  // captions
  $('#capAdd').onclick = () => { if (!clips().length) return toast('Import a clip first'); let c; mutate(() => { c = addCaption('Your text', S.t); }); selectCap(c.id); setTimeout(() => $('#cpText').select(), 50); };
  $('#capSrt').onclick = () => S.proj.captions.length ? downloadText(`${S.proj.name.replace(/\W+/g, '_')}.srt`, toSrt(S.proj.captions)) : toast('No captions yet');
  $('#srtInput').onchange = async (e) => { const f = e.target.files[0]; if (!f) return; const items = parseSrt(await f.text()); mutate(() => items.forEach(it => addCaption(it.text, it.start, it.end))); toast(`Imported ${items.length} captions`); e.target.value = ''; };
  const capSet = (fn, live) => (e) => { const c = selCap(); if (!c) return; if (live) { fn(c, e.target); renderCapsOverlay.dirty = true; renderCapsOverlay(); renderTimeline(); scheduleSave(); } else mutate(() => fn(c, e.target)); renderCapInspector(); };
  $('#cpText').addEventListener('focus', () => { S.undo.push(snap()); });
  $('#cpText').oninput = capSet((c, el) => c.text = el.value, true);
  $('#cpStart').onchange = capSet((c, el) => { c.start = r2(Math.max(0, +el.value)); if (c.end <= c.start) c.end = c.start + 1; });
  $('#cpEnd').onchange = capSet((c, el) => { c.end = r2(Math.max(c.start + 0.1, +el.value)); });
  $('#cpSize').oninput = capSet((c, el) => c.size = +el.value, true);
  $('#cpX').oninput = capSet((c, el) => c.x = +el.value, true);
  $('#cpY').oninput = capSet((c, el) => c.y = +el.value, true);
  $('#cpColor').oninput = capSet((c, el) => c.color = el.value, true);
  $('#cpBox').onchange = capSet((c, el) => c.box = el.checked);
  $('#cpDel').onclick = () => { mutate(() => { S.proj.captions = S.proj.captions.filter(c => c.id !== S.selCap); S.selCap = null; }); };

  // color
  const colSet = (k) => (e) => { S.proj.color[k] = +e.target.value; applyColor(); scheduleSave(); };
  ['colB:b', 'colC:c', 'colS:s', 'colW:w'].forEach(p => { const [id, k] = p.split(':'); const el = $('#' + id); el.addEventListener('pointerdown', () => S.undo.push(snap())); el.oninput = colSet(k); });
  $('#colReset').onclick = () => mutate(() => { S.proj.color = { b: 0, c: 1, s: 1, w: 0 }; });
  $('#colAuto').onclick = doAutoColor;

  // AI
  $('#aiAnalyze').onclick = analyze;
  $('#acLive').onclick = liveDictate; $('#acPaste').onclick = pasteTranscript;
  $$('[data-hook]').forEach(b => b.onclick = () => hook(b.dataset.hook));
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  $('#acNote').textContent = SR ? 'Live dictate listens through the mic while the timeline plays.' : 'This browser lacks speech recognition — use Paste transcript (text, timestamps or SRT).';

  // export
  $('#exFf').onclick = doExportFF; $('#exRt').onclick = doExportRT;
  $('#exQuick').onclick = () => { $('#exRes').value = '720'; $('#exQ').value = '23'; $('#exEngine').value = 'auto'; doExportFF(); };
  $('#exCancel').onclick = () => { S.exportJob?.cancel(); $('#exStatus').textContent = 'Cancelled'; };

  // top bar
  $('#btnSave').onclick = () => saveProject(false);
  $('#btnProjects').onclick = openProjects;
  $('#btnSettings').onclick = openSettings;
  $('#btnPrivacy').onclick = () => privacy(true);
  $('#privacy').onclick = () => privacy(false);
  $('#projName').onchange = () => scheduleSave();
  document.addEventListener('visibilitychange', () => { if (document.hidden && localStorage.getItem('vc.blurOnHide') !== '0' && !S.exportJob) privacy(true); });

  // keyboard
  document.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName) && e.key !== 'Escape') return;
    const k = e.key.toLowerCase();
    if (k === ' ') { e.preventDefault(); S.playing ? pause() : play(); }
    else if (k === 'escape') privacy(!$('#privacy').classList.contains('show'));
    else if (k === 's' && !e.metaKey && !e.ctrlKey) splitAt(S.t);
    else if (k === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); saveProject(false); }
    else if (k === 'z' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); e.shiftKey ? redo() : undo(); }
    else if (k === 'delete' || k === 'backspace') { if (S.selCap && $('#tab-text').classList.contains('on')) $('#cpDel').click(); else delSel(); }
    else if (k === 'arrowleft') seek(S.t - (e.shiftKey ? 1 : 1 / 30));
    else if (k === 'arrowright') seek(S.t + (e.shiftKey ? 1 : 1 / 30));
    else if (k === 'i') $('#ciSetIn').click();
    else if (k === 'o') $('#ciSetOut').click();
  });
  // undo button in topbar
  const ub = document.createElement('button'); ub.textContent = '↶'; ub.title = 'Undo (Ctrl+Z)'; ub.onclick = undo;
  $('.topbtns').prepend(ub);

  new ResizeObserver(fitStage).observe($('#stageWrap'));
  window.addEventListener('resize', () => renderTimeline());
}

async function init() {
  bind();
  renderAll();
  requestAnimationFrame(loop);
  const last = localStorage.getItem('vc.last');
  if (last) { try { await openProject(last); } catch (e) { console.warn(e); } }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();

// test/debug hooks
window.VC = { S, fitFor: (c, cam) => fitFor(c, cam), keysFor: (c) => keysFor(c), frameMap: (id) => frameMap(id), importFiles, autoEdit, restoreCut, doExportAuto, splitAt, seek, play, pause, analyze, applySugg, addCaption, mutate, saveProject, openProject, doExportFF, doExportRT, total, showTab, renderAll };
