import * as DB from './db.js';
import { cssFilter, warmthColor, fmtTime, toSrt, parseSrt, outputSize, FONT_STACK, clipColor, camCss } from './render.js';
import { exportChunked, cancelFF, createRealtimeExport, once } from './exporter.js';
import { analyzeRange, planEdit, planCamera, enhanceFor, orderShots, readCaptureTime, loadAutoSettings, saveAutoSettings } from './autoedit.js';
import { suggestCuts, videoStats, autoColor, timeTranscript } from './ai.js';
import { loadAI, saveAI, HOOKS, providerReady, runHook } from './hooks.js';

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const r2 = (x) => Math.round(x * 100) / 100;

const newProject = () => ({ id: uid(), name: 'Untitled project', clips: [], captions: [], color: { b: 0, c: 1, s: 1, w: 0 }, created: Date.now(), updated: Date.now() });
const S = {
  proj: newProject(), media: new Map(), sel: null, selCap: null, t: 0, playing: false, idx: -1,
  pxs: 30, mutedAll: false, sugg: [], undo: [], redo: [], switching: false, exportJob: null, analysis: new Map(), autoJob: null,
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
const total = () => clips().reduce((a, c) => a + (c.out - c.in), 0);
function starts() { let t = 0; return clips().map(c => { const s = t; t += c.out - c.in; return s; }); }
function locate(t) {
  const st = starts(), cs = clips();
  for (let i = 0; i < cs.length; i++) { const d = cs[i].out - cs[i].in; if (t < st[i] + d - 1e-4 || i === cs.length - 1) return { idx: i, local: clamp(t - st[i], 0, d) }; }
  return { idx: -1, local: 0 };
}
const selClip = () => clips().find(c => c.id === S.sel);
const selCap = () => S.proj.captions.find(c => c.id === S.selCap);

// ---------------- undo / mutate / autosave ----------------
const snap = () => JSON.stringify({ clips: S.proj.clips, captions: S.proj.captions, color: S.proj.color, xfade: S.proj.xfade || 0, autoCuts: S.proj.autoCuts || [], autoEnh: S.proj.autoEnh || {} });
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
async function probe(url) {
  const v = document.createElement('video');
  v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
  await once(v, 'loadedmetadata');
  if (!isFinite(v.duration)) { // MediaRecorder webm: force duration
    v.currentTime = 1e7; await once(v, 'seeked'); v.currentTime = 0; await once(v, 'seeked');
  }
  const info = { duration: v.duration, w: v.videoWidth, h: v.videoHeight };
  v.currentTime = Math.min(0.5, info.duration / 3);
  try { await Promise.race([once(v, 'seeked'), new Promise((_, r) => setTimeout(() => r(), 4000))]); } catch {}
  const th = document.createElement('canvas');
  const tw = 120; th.width = tw; th.height = Math.round(tw * (info.h || 9) / (info.w || 16)) || 68;
  try { th.getContext('2d').drawImage(v, 0, 0, th.width, th.height); info.thumb = th.toDataURL('image/jpeg', 0.6); } catch { info.thumb = ''; }
  v.removeAttribute('src'); v.load();
  return info;
}
async function importFiles(files, { add = true } = {}) {
  files = [...files].filter(f => f.type.startsWith('video/') || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name));
  if (!files.length) return toast('No video files found');
  DB.persist();
  const added = [];
  for (const f of files) {
    toast(`Importing ${f.name}…`, 10000);
    const id = uid(), url = URL.createObjectURL(f);
    let info;
    try { info = await probe(url); }
    catch (e) { URL.revokeObjectURL(url); toast(`Can't play ${f.name} in this browser (codec?). Try converting to H.264 MP4.`, 6000); continue; }
    const capture = (await readCaptureTime(f)) || f.lastModified || null;
    const rec = { id, blob: f, name: f.name, type: f.type, capture, order: Date.now() + added.length, ...info };
    S.media.set(id, { ...rec, url });
    try { await DB.putMedia(rec); } catch (e) { toast('Storage full — clip works now but won’t be saved: ' + e.message, 6000); }
    added.push({ id: uid(), mediaId: id, name: f.name.replace(/\.\w+$/, ''), in: 0, out: r2(info.duration), dur: info.duration, w: info.w, h: info.h, muted: false });
  }
  if (!added.length) return [];
  if (!add) return added;
  mutate(() => { S.proj.clips.push(...added); S.sel = added[0].id; });
  toast(`Added ${added.length} clip${added.length > 1 ? 's' : ''}`);
  if (S.idx < 0) seek(S.t);
  return added;
}

// ---------------- preview playback ----------------
const player = $('#player');
async function loadIdx(idx, local, play) {
  const c = clips()[idx]; if (!c) return;
  const m = S.media.get(c.mediaId); if (!m) return;
  S.switching = true;
  try {
    if (player.dataset.mid !== c.mediaId) {
      player.dataset.mid = c.mediaId; player.src = m.url;
      await once(player, 'loadedmetadata');
    }
    S.idx = idx;
    player.muted = S.mutedAll || c.muted;
    const target = c.in + local;
    if (Math.abs(player.currentTime - target) > 0.03) { player.currentTime = target; await once(player, 'seeked').catch(() => {}); }
    if (play) await player.play().catch(e => { S.playing = false; updatePlayBtn(); });
  } finally { S.switching = false; applyLook(); }
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
  const { idx, local } = locate(S.t);
  await loadIdx(idx, local, true);
}
function pause() { S.playing = false; player.pause(); updatePlayBtn(); }
function updatePlayBtn() { $('#btnPlay').textContent = S.playing ? '❚❚' : '▶'; }
function loop() {
  if (S.playing && !S.switching && S.idx >= 0) {
    const c = clips()[S.idx];
    if (!c) pause();
    else {
      const st = starts()[S.idx];
      S.t = st + (player.currentTime - c.in);
      if (player.currentTime >= c.out - 0.03 || player.ended) {
        if (S.idx < clips().length - 1) { S.t = st + (c.out - c.in); loadIdx(S.idx + 1, 0, true); }
        else { pause(); S.t = total(); }
      }
    }
    tickUI();
  }
  requestAnimationFrame(loop);
}

function applyLook() {
  const c = clips()[S.idx];
  if (!c) { player.style.transform = ''; return; }
  const f = cssFilter(clipColor(S.proj, c));
  if (player.style.filter !== f) player.style.filter = f;
  const st = starts()[S.idx], d = Math.max(0.01, c.out - c.in);
  const p = clamp((S.t - st) / d, 0, 1);
  player.style.transform = c.cam ? camCss(c.cam, p) : '';
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
  const c = clips()[0];
  const ar = c && c.w && c.h ? c.w / c.h : 16 / 9;
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
  $('#ciInfo').textContent = ` ${c.w}×${c.h} · source ${fmtTime(c.dur)} · using ${fmtTime(c.out - c.in)}`;
  if (document.activeElement !== $('#ciIn')) $('#ciIn').value = c.in;
  if (document.activeElement !== $('#ciOut')) $('#ciOut').value = c.out;
  $('#ciIn').max = c.dur; $('#ciOut').max = c.dur;
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
function renderAll() { renderAuto(); renderTimeline(); renderClipInspector(); renderCapInspector(); applyColor(); fitStage(); renderCapsOverlay.dirty = true; renderCapsOverlay(); renderSugg(); }
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
  $('#exFf').disabled = busy; $('#exRt').disabled = busy; $('#exCancel').hidden = !busy;
  if (busy) { $('#exLink').hidden = true; $('#exBar').style.width = '0'; }
}
const prog = (f, msg) => { $('#exBar').style.width = Math.round(f * 100) + '%'; $('#exStatus').textContent = msg + (f > 0 && f < 1 ? ` ${Math.round(f * 100)}%` : ''); };
function finishExport(res, t0) {
  const a = $('#exLink');
  if (a.href) URL.revokeObjectURL(a.href);
  a.href = URL.createObjectURL(res.blob);
  a.download = `${(S.proj.name || 'export').replace(/[^\w-]+/g, '_')}.${res.ext}`;
  a.hidden = false;
  a.textContent = `⬇ Save ${res.ext.toUpperCase()} (${(res.blob.size / 1048576).toFixed(1)} MB, ${res.W}×${res.H})`;
  $('#exStatus').textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(0)}s. On iPhone: tap Save, then Share → Save Video.`;
  window.__lastExport = res;
}
async function doExportFF() {
  if (!clips().length) return toast('Timeline is empty');
  const big = [...new Set(clips().map(c => c.mediaId))].reduce((a, id) => a + (S.media.get(id)?.blob.size || 0), 0);
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if ((isIOS && big > 150e6) || big > 1.2e9) {
    const go = await modal('Heavy export', html(`<p>Sources total ${(big / 1048576).toFixed(0)} MB. ffmpeg.wasm keeps everything in memory${isIOS ? ' and iPhone Safari may reload the tab' : ''}. <b>Real-time export</b> is safer for big files.</p>`), [{ label: 'Cancel', value: false }, { label: 'Try anyway', cls: 'primary', value: true }]);
    if (!go) return;
  }
  pause(); setExportUI(true); const t0 = performance.now();
  S.exportJob = { cancel: cancelFF };
  try { finishExport(await exportChunked(S.proj, S.media, exportOpts(prog)), t0); }
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

// ---------------- Auto Edit ----------------
const CAM_NAMES = { 1: 'Subtle', 2: 'Medium', 3: 'Bold' };
function readAutoUI() {
  return { order: $('#auOrder').value, xfade: +$('#auXfade').value, strict: $('#auStrict').value,
    color: $('#auColor').checked, denoise: $('#auDenoise').checked, sharpen: $('#auSharpen').checked, stabilize: $('#auStab').checked,
    camera: $('#auCam').checked, camLevel: +$('#auCamL').value };
}
function writeAutoUI(st) {
  $('#auOrder').value = st.order; $('#auXfade').value = String(st.xfade); $('#auStrict').value = st.strict;
  $('#auColor').checked = st.color; $('#auDenoise').checked = st.denoise; $('#auSharpen').checked = st.sharpen; $('#auStab').checked = st.stabilize;
  $('#auCam').checked = st.camera; $('#auCamL').value = st.camLevel; $('#auCamV').textContent = CAM_NAMES[st.camLevel] || 'Medium';
  $('#auCamL').disabled = !st.camera;
}
function bindAuto() {
  writeAutoUI(loadAutoSettings());
  const fi = $('#autoFile');
  const pick = () => { if (S.autoJob) return toast('Auto Edit is already running'); fi.click(); };
  $('#auPick').onclick = pick; $('#btnAuto').onclick = () => { showTab('auto'); pick(); }; $('#btnAuto2').onclick = pick;
  fi.onchange = () => { const f = [...fi.files]; fi.value = ''; if (f.length) autoEdit(f); };
  $('#auRerun').onclick = () => autoEdit(null);
  $('#auCancel').onclick = () => { S.autoJob?.abort(); S.exportJob?.cancel?.(); };
  $('#auExport').onclick = doExportAuto;
  $('#auCamL').oninput = () => { $('#auCamV').textContent = CAM_NAMES[$('#auCamL').value]; };
  ['#auOrder', '#auXfade', '#auStrict', '#auColor', '#auDenoise', '#auSharpen', '#auStab', '#auCam', '#auCamL'].forEach(id => $(id).addEventListener('change', () => {
    const st = readAutoUI(); saveAutoSettings(st); $('#auCamL').disabled = !st.camera;
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
  try {
    let mids;
    if (files) {
      auProg(0, 'Importing…');
      const added = await importFiles(files, { add: false });
      if (!added?.length) throw new Error('No playable videos were imported');
      mids = added.map(c => c.mediaId);
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
      if (m.capture == null) m.capture = (await readCaptureTime(m.blob)) || m.blob.lastModified || null;
      let an = S.analysis.get(id);
      if (!an) {
        an = await analyzeRange(m.url, 0, m.duration, { signal: ac.signal,
          onTick: (f) => auProg(0.9 * (done + f * m.duration) / totalDur, `Analyzing video ${i + 1}/${mids.length} (blur, light, shake, scenes)`) });
        S.analysis.set(id, an);
      }
      done += m.duration;
      items.push({ mediaId: id, name: m.name.replace(/\.\w+$/, ''), in: 0, out: r2(m.duration), dur: m.duration, w: m.w, h: m.h,
        order: m.order ?? i, capture: m.capture, samples: an.samples, step: an.step });
    }
    // 2) plan shots, enhancement and camera
    auProg(0.92, 'Choosing the best shots…');
    const plan = planEdit(items, st);
    if (!plan.keep.length) throw new Error('Every part looked bad with these settings — try “Loose” sensitivity.');
    const enh = {};
    for (const it of items) enh[it.mediaId] = enhanceFor(it.samples, st);
    let shots = plan.keep;
    if (st.camera) shots = planCamera(shots, st.camLevel);
    const newClips = shots.map((s, k) => {
      const shake = s.samples?.length ? s.samples.map(x => x.shake).sort((a, b) => a - b)[Math.floor(s.samples.length / 2)] : 0;
      const e = (st.color || st.denoise || st.sharpen || st.stabilize) ? { ...enh[s.mediaId], stab: !!(st.stabilize && shake > 0.3) } : null;
      return { id: uid(), mediaId: s.mediaId, name: `${s.name} · ${k + 1}`, in: s.in, out: s.out, dur: s.dur, w: s.w, h: s.h, muted: false,
        enh: e, cam: st.camera ? s.cam : null, score: s.score, capture: s.capture, order: s.order, thumb: s.thumb || '' };
    });
    const cuts = plan.cuts.map(c => ({ id: c.id, mediaId: c.mediaId, name: c.name, in: c.in, out: c.out, dur: c.dur, w: c.w, h: c.h, reasons: c.reasons, thumb: c.thumb, score: c.score, capture: c.capture, order: c.order }));
    mutate(() => {
      S.proj.clips = newClips; S.proj.autoCuts = cuts; S.proj.autoEnh = enh; S.proj.xfade = st.xfade; S.sugg = [];
      S.sel = newClips[0]?.id || null;
      if (S.proj.name === 'Untitled project') { S.proj.name = 'Auto edit ' + new Date().toLocaleDateString(); $('#projName').value = S.proj.name; }
    });
    S.t = 0; seek(0);
    auProg(1, `Done in ${((performance.now() - t0) / 1000).toFixed(0)} s. Preview it, tweak anything on the timeline, then export.`);
    window.__lastPlan = { plan, settings: st };
  } catch (e) {
    auProg(0, e.message === 'Cancelled' ? 'Cancelled.' : 'Auto Edit failed: ' + (e.message || e));
    console.error(e);
  } finally {
    S.autoJob = null; $('#auCancel').hidden = true; $('#auPick').disabled = $('#auRerun').disabled = false;
    renderAuto();
  }
}
function renderAuto() {
  const box = $('#auResult'); if (!box) return;
  const cuts = S.proj.autoCuts || [];
  const auto = clips().some(c => c.enh || c.cam) || cuts.length;
  $('#auExportBox').hidden = !clips().length || !!S.autoJob;
  if (!auto) { box.innerHTML = ''; return; }
  const cutT = cuts.reduce((a, c) => a + c.out - c.in, 0);
  const srcN = new Set([...clips(), ...cuts].map(c => c.mediaId)).size;
  const camN = clips().filter(c => c.cam && c.cam.type !== 'wide').length;
  box.innerHTML = `<div class="ausum"><b>${clips().length} shots · ${fmtTime(total())}</b> from ${srcN} video${srcN === 1 ? '' : 's'}${S.proj.xfade ? ` · ${S.proj.xfade}s crossfades` : ''}${camN ? ` · ${camN} camera moves` : ''}<br>
    <span class="muted">Cut ${cuts.length} bad part${cuts.length === 1 ? '' : 's'} (${fmtTime(cutT)}). Tap Restore to put one back.</span></div>`;
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
      enh: S.proj.autoEnh?.[cut.mediaId] ? { ...S.proj.autoEnh[cut.mediaId] } : null, cam: null, capture: cut.capture, order: cut.order, thumb: cut.thumb || '' };
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
  S.exportJob = { cancel: cancelFF };
  const p = (f, msg) => { bar.style.width = Math.round(f * 100) + '%'; stt.textContent = msg + (f > 0 && f < 1 ? ` ${Math.round(f * 100)}%` : ''); };
  try {
    const res = await exportChunked(S.proj, S.media, exportOpts(p));
    if (link.href) URL.revokeObjectURL(link.href);
    link.href = URL.createObjectURL(res.blob);
    link.download = `${(S.proj.name || 'auto-edit').replace(/[^\w-]+/g, '_')}.mp4`;
    link.textContent = `⬇ Save MP4 (${(res.blob.size / 1048576).toFixed(1)} MB, ${res.W}×${res.H}, ${fmtTime(res.duration)})`;
    link.hidden = false; pv.src = link.href; pv.hidden = false;
    stt.textContent = `Done in ${((performance.now() - t0) / 1000).toFixed(0)} s. Watch it below. On iPhone: tap Save, then Share → Save Video.`;
    window.__lastExport = res;
  } catch (e) { stt.textContent = 'Export failed: ' + (e.message || e) + ' — try 480p, or Export tab → Real-time export.'; console.error(e); }
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
    if (rec) S.media.set(mid, { ...rec, url: URL.createObjectURL(rec.blob) });
  }
  S.proj = p; S.sel = p.clips[0]?.id || null; S.selCap = null; S.undo = []; S.redo = []; S.sugg = []; S.analysis.clear();
  $('#projName').value = p.name; player.dataset.mid = ''; S.t = 0; S.idx = -1;
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
  player.removeAttribute('src'); player.dataset.mid = ''; $('#projName').value = S.proj.name;
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
      saveAI({ provider: $('#sProv').value, customUrl: $('#sUrl').value.trim(), customToken: $('#sTok').value.trim(), fal: $('#sFal').value.trim(), replicate: $('#sRep').value.trim(), runway: $('#sRun').value.trim() });
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
  bindAuto();
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
  player.addEventListener('pause', () => { if (S.playing && !S.switching && !player.ended && player.currentTime < (clips()[S.idx]?.out ?? 0) - 0.1) { S.playing = false; updatePlayBtn(); } });

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
  $('#ciMute').onclick = () => { const c = selClip(); if (!c) return; mutate(() => { c.muted = !c.muted; }); player.muted = S.mutedAll || c.muted; };
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
window.VC = { S, importFiles, autoEdit, restoreCut, doExportAuto, splitAt, seek, play, pause, analyze, applySugg, addCaption, mutate, saveProject, openProject, doExportFF, doExportRT, total, showTab, renderAll };
