// AI enhance hooks. Keys live ONLY in localStorage on this device (never in the repo).
// Nothing is uploaded unless the user presses a hook button AND confirms the upload dialog.
import { trimClip } from './exporter.js';

const KEY = 'vc.ai';
export function loadAI() {
  try { return Object.assign({ provider: 'none', fal: '', replicate: '', runway: '', customUrl: '', customToken: '' }, JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { return { provider: 'none' }; }
}
export function saveAI(cfg) { localStorage.setItem(KEY, JSON.stringify(cfg)); }

export const HOOKS = {
  enhance: { title: 'Enhance clip', desc: 'Denoise + sharpen the selected clip (fal.ai: Topaz Artemis HQ, same resolution).' },
  upscale: { title: 'Upscale', desc: 'Upscale the selected clip 2× (fal.ai: Topaz Proteus 2×, falls back to Real-ESRGAN 2×).' },
  polish: { title: 'AI polish', desc: 'Clean up + 2× upscale (fal.ai: Topaz Artemis HQ 2×). For color, use Auto color in the editor.' },
  img2vid: { title: 'Image → video', desc: 'Animate a still image into a short clip (needs your own endpoint).' },
};

export function providerReady(cfg) {
  switch (cfg.provider) {
    case 'custom': return !!cfg.customUrl;
    case 'fal': return !!cfg.fal;
    case 'replicate': return !!cfg.replicate;
    case 'runway': return !!cfg.runway;
    default: return false;
  }
}

// ---------------- fal.ai ----------------
const FAL_REST = 'https://rest.fal.ai';
const FAL_QUEUE = 'https://queue.fal.run';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Which fal model(s) each button uses. First entry is tried first; later entries are fallbacks.
export const FAL_PLAN = {
  enhance: [{ model: 'fal-ai/topaz/upscale/video', label: 'Topaz Artemis HQ (denoise + sharpen)', input: { model: 'Artemis HQ', upscale_factor: 1, H264_output: true } }],
  upscale: [
    { model: 'fal-ai/topaz/upscale/video', label: 'Topaz Proteus 2×', input: { model: 'Proteus', upscale_factor: 2, H264_output: true } },
    { model: 'fal-ai/video-upscaler', label: 'Real-ESRGAN 2×', input: { scale: 2 } },
  ],
  polish: [{ model: 'fal-ai/topaz/upscale/video', label: 'Topaz Artemis HQ 2×', input: { model: 'Artemis HQ', upscale_factor: 2, H264_output: true } }],
};

class FalError extends Error {
  constructor(msg, { status, policy, auth, fallback } = {}) { super(msg); this.status = status; this.policy = policy; this.auth = auth; this.fallback = fallback; }
}

async function falErr(res, what) {
  let detail = '';
  try {
    const j = await res.clone().json();
    const d = j.detail ?? j.error ?? j.message ?? j;
    detail = typeof d === 'string' ? d : Array.isArray(d) ? d.map(x => x.msg || x.message || JSON.stringify(x)).join('; ') : JSON.stringify(d);
  } catch { try { detail = (await res.text()).slice(0, 300); } catch {} }
  const s = res.status;
  const policyRe = /content|policy|nsfw|safety|moderat|not allowed|inappropriate|flagged/i;
  if (s === 401) return new FalError('fal.ai rejected the key (401). Re-copy it from fal.ai/dashboard/keys into ⚙️ Settings.', { status: s, auth: true });
  if (s === 403) {
    if (/balance|credit|billing|payment|locked|exhausted/i.test(detail)) return new FalError(`fal.ai says the account has no credits / billing is off (403). Add credits at fal.ai/dashboard/billing. ${detail}`, { status: s, auth: true });
    if (policyRe.test(detail)) return new FalError(`fal.ai refused this clip under its content policy (403). Hosted providers may block explicit footage — use “My own endpoint” for that. Details: ${detail}`, { status: s, policy: true });
    return new FalError(`fal.ai refused the request (403) during ${what}. Check the key/credits. ${detail}`, { status: s, auth: true });
  }
  if (s === 422 && policyRe.test(detail)) return new FalError(`fal.ai refused this clip under its content policy (422). Hosted providers may block explicit footage — use “My own endpoint” for that. Details: ${detail}`, { status: s, policy: true });
  if (s === 422) return new FalError(`fal.ai couldn't process this clip (422) during ${what}: ${detail || 'invalid input'}. Try a shorter MP4 (H.264).`, { status: s, fallback: true });
  if (s === 404) return new FalError(`fal.ai model not found (404) during ${what}. ${detail}`, { status: s, fallback: true });
  if (s === 429) return new FalError('fal.ai is rate-limiting (429). Wait a minute and try again.', { status: s });
  return new FalError(`fal.ai error ${s} during ${what}${detail ? ': ' + detail : ''}`, { status: s, fallback: s >= 500 });
}

async function falUpload(blob, name, key, onStatus) {
  const type = blob.type || 'video/mp4';
  const file_name = (name || 'clip').replace(/[^\w.-]+/g, '_') + (/\.\w{2,4}$/.test(name || '') ? '' : '.mp4');
  onStatus(`Uploading ${(blob.size / 1048576).toFixed(1)} MB to fal.ai…`);
  const init = await fetch(`${FAL_REST}/storage/upload/initiate?storage_type=fal-cdn-v3`, {
    method: 'POST', headers: { Authorization: `Key ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content_type: type, file_name }),
  });
  if (!init.ok) throw await falErr(init, 'upload');
  const { upload_url, file_url } = await init.json();
  const put = await fetch(upload_url, { method: 'PUT', headers: { 'Content-Type': type }, body: blob });
  if (!put.ok) throw await falErr(put, 'upload');
  return file_url;
}

async function falRun(model, input, key, label, onStatus) {
  const auth = { Authorization: `Key ${key}` };
  onStatus(`Submitting to ${label}…`);
  const sub = await fetch(`${FAL_QUEUE}/${model}`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  if (!sub.ok) throw await falErr(sub, 'submit');
  const { request_id, status_url, response_url } = await sub.json();
  const base = `${FAL_QUEUE}/${model.split('/').slice(0, 2).join('/')}/requests/${request_id}`;
  const sUrl = status_url || `${base}/status`, rUrl = response_url || base;
  const t0 = Date.now(); let wait = 2000;
  for (;;) {
    if (Date.now() - t0 > 45 * 60 * 1000) throw new FalError(`${label} timed out after 45 min (request ${request_id}).`);
    await sleep(wait); wait = Math.min(wait + 1000, 5000);
    const st = await fetch(`${sUrl}${sUrl.includes('?') ? '&' : '?'}logs=1`, { headers: auth });
    if (!st.ok) { if (st.status >= 500) continue; throw await falErr(st, 'status'); }
    const j = await st.json();
    const secs = Math.round((Date.now() - t0) / 1000);
    if (j.status === 'IN_QUEUE') onStatus(`${label}: queued${j.queue_position != null ? ` (#${j.queue_position + 1})` : ''} · ${secs}s`);
    else if (j.status === 'IN_PROGRESS') { const last = j.logs?.length ? j.logs[j.logs.length - 1].message : ''; onStatus(`${label}: processing · ${secs}s${last ? ' · ' + String(last).slice(0, 60) : ''}`); }
    else if (j.status === 'COMPLETED') break;
  }
  const res = await fetch(rUrl, { headers: auth });
  if (!res.ok) throw await falErr(res, 'result');
  const out = await res.json();
  const url = out?.video?.url || out?.data?.video?.url || out?.output?.video?.url;
  if (!url) throw new FalError(`${label} finished but returned no video. ${JSON.stringify(out).slice(0, 200)}`, { fallback: true });
  onStatus('Downloading result…');
  const vid = await fetch(url);
  if (!vid.ok) throw new FalError(`Couldn't download the result (${vid.status}).`);
  const b = await vid.blob();
  return b.type.startsWith('video/') ? b : new Blob([b], { type: 'video/mp4' });
}

async function falAdapter(op, input, cfg, onStatus) {
  if (op === 'img2vid') {
    const e = new Error('Image → video isn’t wired to fal.ai: its image-to-video models block explicit content and cost per clip. Use ⚙️ Settings → “My own endpoint” (e.g. a self-hosted Wan / LTX image-to-video box) for this button.');
    e.notWired = true; throw e;
  }
  const plan = FAL_PLAN[op];
  if (!plan) throw new Error(`Unknown AI action: ${op}`);
  const key = cfg.fal.trim();
  let blob = input.blob;
  // Trim to the selected in/out first so you only upload (and pay for) the part you kept.
  if (input.in != null && input.out != null && (input.in > 0.05 || (input.dur && input.out < input.dur - 0.05) || !input.dur)) {
    try { onStatus('Trimming to your selection…'); blob = await trimClip(input.blob, input.name, input.in, input.out); }
    catch { blob = input.blob; onStatus('Trim failed — uploading the full clip'); }
  }
  const video_url = await falUpload(blob, input.name, key, onStatus);
  let lastErr;
  for (const step of plan) {
    try { return await falRun(step.model, { video_url, ...step.input }, key, step.label, onStatus); }
    catch (e) {
      lastErr = e;
      if (e.policy || e.auth || !e.fallback) throw e;
      onStatus(`${step.label} failed — trying fallback…`);
    }
  }
  throw lastErr;
}

/**
 * Run a hook. Returns a Blob (video) to add to the timeline, or throws.
 * input: {blob, name, in, out, dur}
 *  - custom: POST multipart (file, op, in, out) to your own endpoint; response must be the video bytes.
 *  - fal: fully wired (see FAL_PLAN above).
 *  - replicate / runway: stubs — see README.
 */
export async function runHook(op, input, cfg, onStatus = () => {}) {
  if (cfg.provider === 'custom') {
    const fd = new FormData();
    fd.append('file', input.blob, input.name || 'clip.mp4');
    fd.append('op', op);
    if (input.in != null) { fd.append('in', input.in); fd.append('out', input.out); }
    onStatus('Uploading to your endpoint…');
    const r = await fetch(cfg.customUrl, { method: 'POST', body: fd, headers: cfg.customToken ? { Authorization: 'Bearer ' + cfg.customToken } : {} });
    if (!r.ok) throw new Error(`Endpoint returned ${r.status}`);
    onStatus('Downloading result…');
    return await r.blob();
  }
  const adapters = { fal: falAdapter, replicate: null, runway: null };
  const fn = adapters[cfg.provider];
  if (!fn) {
    const e = new Error(`The ${cfg.provider} adapter isn't wired yet. Pick fal.ai or “My own endpoint” in ⚙️ Settings. Your key is saved locally; see README → "AI enhance".`);
    e.notWired = true; throw e;
  }
  return fn(op, input, cfg, onStatus);
}
