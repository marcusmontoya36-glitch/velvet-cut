// Optional AI enhance hooks. Keys live ONLY in localStorage on this device.
// Nothing is uploaded unless the user presses a hook button AND confirms the upload dialog.
const KEY = 'vc.ai';
export function loadAI() {
  try { return Object.assign({ provider: 'none', fal: '', replicate: '', runway: '', customUrl: '', customToken: '' }, JSON.parse(localStorage.getItem(KEY) || '{}')); }
  catch { return { provider: 'none' }; }
}
export function saveAI(cfg) { localStorage.setItem(KEY, JSON.stringify(cfg)); }

export const HOOKS = {
  enhance: { title: 'Enhance clip', desc: 'Denoise / sharpen / stabilize the selected clip.' },
  upscale: { title: 'Upscale', desc: 'Upscale the selected clip (e.g. 720p → 4K).' },
  polish: { title: 'AI polish', desc: 'Color-grade and relight the selected clip with a generative model.' },
  img2vid: { title: 'Image → video', desc: 'Animate a still image into a short clip.' },
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

/**
 * Run a hook. Returns a Blob (video) to add to the timeline, or throws.
 * input: {blob, name, in, out}
 *
 * 'custom' is fully wired: POST multipart (file, op, in, out) to your own endpoint
 * (e.g. a self-hosted ComfyUI / Real-ESRGAN / ffmpeg box on your LAN). Response must be the video bytes.
 * fal / replicate / runway are adapter stubs — see README "Wiring real AI enhance".
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
  const adapters = {
    // Fill these in (see README). They receive the clip blob and must return a video Blob.
    fal: null, replicate: null, runway: null,
  };
  const fn = adapters[cfg.provider];
  if (!fn) {
    const e = new Error(`The ${cfg.provider} adapter isn't wired yet. Your key is saved locally; see README → "Wiring real AI enhance".`);
    e.notWired = true; throw e;
  }
  return fn(op, input, cfg, onStatus);
}
