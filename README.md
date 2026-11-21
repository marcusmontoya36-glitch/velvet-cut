# Velvet Cut — private, local-first adult video editor (18+)

A small progressive web app for editing **your own** adult videos (consenting adults 18+ only).
Everything runs in the browser: clips, projects, analysis and export never leave the device unless
you press an optional cloud “Enhance” button **and** confirm the upload.

No build step, no server code, no paid APIs required.

## Open it

The app must be served over `http(s)://` (ES modules + service worker don't run from `file://`).

**Desktop (Mac/PC):**
```sh
cd adult-editor
./serve.sh            # or: python3 -m http.server 8080
# open http://localhost:8080 in Chrome, Edge or Safari
```

**iPhone:** host the folder on any static HTTPS host, open it in Safari, then
Share → **Add to Home Screen** for an app icon. Options:
- GitHub Pages (private repo + Pages, or a public repo — the app contains no media)
- Netlify Drop (drag the folder onto app.netlify.com/drop)
- From the desktop: `./serve.sh` + `cloudflared tunnel --url http://localhost:8080` (temporary HTTPS link)

Videos you import on the phone stay in that phone's Safari storage.


## ⚡ Auto Edit (one tap)

Tap **⚡ Auto Edit**, pick one or more videos, and the app edits them on the device:

1. **Analyze** each video at low resolution (120 px frames, 2 samples/s, fewer on long clips). It plays a muted hidden `<video>`
   at 8× speed and grabs frames with `requestVideoFrameCallback`, because per-frame seeking is very slow on iOS. If the
   browser stalls, it falls back to short-timeout seeks, and a watchdog makes sure analysis never hangs. The whole file is never loaded into memory.
2. **Cut bad shots.** Parts that are blurry (low Laplacian variance compared with the sharpest footage), too dark, blown out,
   shaky (erratic global motion between frames), frozen/static, too short, or near-duplicates get cut. Every cut is listed
   with its reasons and a thumbnail, and **↩ Restore** puts it back. Sensitivity can be Loose, Normal or Strict.
3. **Arrange.** Shots are split at scene changes, then ordered by capture time (MP4/MOV `mvhd` date), by file order, or
   best shots first. **Smooth transitions are on by default:** a 0.5 s crossfade (or 0.3 / 0.8 s, dip to black, or hard cuts).
   The preview blends two video players, so what you see is what gets exported.
4. **Enhance.** Per-video automatic brightness, contrast and saturation (shown in the preview). Denoise (`hqdn3d`), sharpen (`unsharp`)
   and stabilize (`deshake`, only on slightly shaky kept shots) are applied in the export.
5. **🎥 Dynamic camera** (on by default at Medium; Subtle/Medium/Bold). Any shot longer than about 3 s (Medium) is split into 2–3
   angles at its calmest moments, and the angles overlap by the crossfade so the same moment blends from one framing into the next.
   Framings alternate tight and loose: push-in, punch-in (1.9×), pan, close (1.7×), pull-back, medium (1.4×), tilt. Wide is at most about 1 in 5.
   Push-ins and pull-backs change the zoom by 25–35%. The optional mirrored **alt angle** flips every 4th shot. The crop follows the
   subject from motion plus skin-tone saliency, or a **focus point**: Clip tab → 🎯 Set focus → tap her in the preview. The point is
   template-tracked through the video and drives every crop and move. You can also pick a framing per clip.
   No person or gender classification is done. Everything shows live in the preview and in both export engines.
6. **Export MP4 for iPhone.** Uses the chunked ffmpeg.wasm export: the source files are mounted read-only with WORKERFS (not
   copied into memory), each shot and each crossfade is encoded as a small piece (H.264 yuv420p, 30 fps, capped bitrate), and
   then the pieces are joined. Video is stream-copied, and audio is encoded once to AAC with `+faststart`. The result can be
   previewed in-page before saving.

After an Auto Edit, the normal timeline tools still work: trim, split, reorder, delete, captions, undo.
Changing a setting re-plans instantly because the analysis is cached.

**Import is instant:** it only creates an object URL and reads metadata. The poster frame (from a `#t=` media fragment, no seeking),
the capture date and the save to IndexedDB run in the background. `.mov` blobs are re-typed `video/mp4` with `slice()` (no copy),
because WebKit can refuse `video/quicktime` blob URLs. ffmpeg.wasm loads only when you export. The 31 MB core is
downloaded once with a progress readout into its own cache bucket (`vc-core-v1`), which app updates don't wipe.

**Limits:** analysis takes about 1.5 s for a 10 s clip on a desktop (8× playback) and depends on the phone. Export speed is
about 0.5 to 1× real time at 720p on a desktop. On iPhone, keep exports to roughly 5 minutes at 720p (or use 480p). The
encoded pieces and the final MP4 live in the tab's memory. Real-time export (Export tab) is the fallback; it applies color,
camera moves and crossfades, but not denoise or sharpen.

## Features

| Area | What works |
|---|---|
| Import | File picker or drag-drop (mp4 / mov / m4v / webm). Files are kept in the browser (IndexedDB). |
| Timeline | Multiple clips, thumbnails, zoom, tap-to-seek, drag clip edges to trim, drag to reorder (mouse) or ◀ ▶ Move buttons (touch), split at playhead, duplicate, delete, per-clip mute, undo (↶ / Ctrl+Z, Shift+Ctrl+Z redo). |
| Preview | Seamless-ish playback across clips, live color + captions. |
| Text | Add text at playhead, drag it on the preview, size / color / X / Y / start / end / background box. Burned into export (rendered as PNG overlays, identical look to preview). SRT export and SRT import. |
| Color | Brightness, contrast, saturation, warmth for the whole project — preview (CSS filter) and export (ffmpeg `eq` + `colorbalance`, close but not pixel-identical). |
| Projects | Autosaves 1 s after each change; Projects list (open / delete / new); reopens the last project on launch. Storage usage shown. |
| Export A | **ffmpeg.wasm** → H.264/AAC MP4 (480p / 720p / 1080p / source, 3 quality levels). Mixed sizes/orientations are letterboxed to the first clip's shape. |
| Export B | **Real-time export** (canvas + MediaRecorder): plays the timeline once and records it. Light on memory; on iPhone Safari it produces MP4 (H.264), on Chrome MP4 or WebM depending on build. |
| Privacy | 18+ gate on first load (both boxes required), 🙈 / Esc privacy screen, auto-hide when switching apps (Settings), `noindex` meta, “erase everything on this device” in Settings. |
| PWA | Manifest, icons, offline service worker (app shell + ffmpeg engine cached after first export). |

### AI assist
- **Suggest cuts (local):** decodes audio at 8 kHz with WebAudio (RMS dB per 0.1 s) and samples frames
  (64×36) for motion and black frames. Modes: silence OR still, silence AND still, silence only, motion only.
  Threshold dB + min length adjustable. Results are listed with checkboxes, previewable (▶), highlighted on the
  timeline, and “Remove checked” splits the clips around them (undoable).
- **Auto color (local):** samples frames, estimates exposure / contrast / saturation and sets the color sliders.
- **Auto caption:**
  - *Live dictate* uses the browser SpeechRecognition API (Chrome/Edge/Safari). Note: it listens to the
    **microphone**, not the file — it plays the timeline and times what it hears to the playhead.
  - *Paste transcript* accepts SRT, `[0:12] line` timestamped lines, or plain text (spread across the
    timeline / selected clip / playhead→end by word count).
- **Enhance / Upscale / AI polish / Image → video:** buttons call optional hooks in `hooks.js`. With no
  provider configured they show a “connect later” placeholder and never block editing.

### Settings (⚙️)
Optional keys for fal.ai, Replicate, Runway, or **your own endpoint** — stored only in `localStorage`.
Nothing is sent unless you press a hook button and confirm the upload dialog.

## Known limits
- **ffmpeg.wasm is heavy.** Single-threaded WebAssembly (no special server headers needed), roughly
  0.5–2× real-time at 720p on a laptop; 1080p is several times slower. The ~31 MB engine downloads on first
  export (then cached). All source files are copied into wasm memory (hard cap ≈ 2 GB; practical ≈ 1 GB).
- **iPhone export:** Safari tabs get ~1–1.5 GB before iOS reloads them. ffmpeg.wasm export works for
  short/small projects (the app warns above ~150 MB of sources); for longer edits use **Real-time export**,
  keep the screen on and Safari in front (backgrounding pauses it). Save the result via Save → Share → Save Video.
- Real-time export takes as long as the edit, captures at screen-refresh rate (~30 fps), and briefly holds
  the last frame while switching clips. On Safari versions without canvas `ctx.filter`, color adjustments
  are skipped in real-time export (captions still burn in) — use the ffmpeg export for color.
- HEVC (iPhone “High Efficiency”) `.mov`: previews in Safari; Chrome on Windows/Linux may not decode it.
  If import says “can't play”, set iPhone Camera → Formats → Most Compatible, or convert to H.264.
- Suggest-cuts decodes the whole file's audio; files > 700 MB skip audio and use motion only.
- Browser storage can be evicted if the device runs low on space; the app requests persistent storage,
  but keep originals elsewhere. Clearing Safari website data deletes projects.
- Live dictate needs a microphone and works best in a quiet room.
- No multi-track (one video track + one text track), no audio mixing / music track yet.

## AI enhance (fal.ai — wired)
**Turn it on:** get a key at [fal.ai/dashboard/keys](https://fal.ai/dashboard/keys) → ⚙️ Settings → Provider **fal.ai** →
paste the key → Save → select a clip → tap **Enhance**. The key is stored only in that browser's localStorage
(never in this repo). Usage is billed to your own fal account.

| Button | fal.ai model | Settings |
|---|---|---|
| 🪄 Enhance clip | `fal-ai/topaz/upscale/video` | Artemis HQ, 1× (denoise + sharpen, same size) |
| ⬆ Upscale | `fal-ai/topaz/upscale/video` → fallback `fal-ai/video-upscaler` | Proteus 2× → Real-ESRGAN 2× |
| ✨ AI polish | `fal-ai/topaz/upscale/video` | Artemis HQ 2× (no generative re-grade; use Auto color for color) |
| 🖼→🎞 Image → video | — | not wired on fal (hosted i2v models block explicit content); use your own endpoint |

Flow (`hooks.js` → `falAdapter`): trim the selected in/out with ffmpeg.wasm (stream copy) → upload to fal storage
(`POST rest.fal.ai/storage/upload/initiate` + `PUT`) → `POST queue.fal.run/<model>` → poll `status_url` until
`COMPLETED` → fetch `response_url` → download `video.url` → imported as a new clip. 401/403/422 come back as clear
messages (bad key, no credits, content-policy refusal). Hosted providers may refuse explicit footage.

**Own endpoint (also wired):** Settings → “My own endpoint”. The app POSTs multipart `file, op, in, out` with
`Authorization: Bearer <token>` and expects video bytes back (CORS required). Use this for a home GPU box
(ComfyUI, Real-ESRGAN/Video2X, RIFE, open-weights image-to-video) — the reliable path for explicit material
and the only path for Image → video. Replicate/Runway remain stubs in `hooks.js`.

## Files
```
index.html  styles.css  app.js        UI + state + timeline + preview
db.js                                  IndexedDB (media blobs + projects)
render.js                              shared caption/color drawing, SRT helpers
exporter.js                            ffmpeg.wasm export + real-time MediaRecorder export
ai.js                                  silence/motion/black detection, auto color, transcript timing
hooks.js                               optional cloud/self-hosted enhance hooks
sw.js  manifest.webmanifest  icons/    PWA
vendor/ffmpeg/                         @ffmpeg/ffmpeg 0.12.15 + @ffmpeg/core 0.12.10 (single-thread, LGPL/GPL — see their licenses)
shots/                                 UI screenshots
```
Keyboard: Space play/pause · S split · I / O set in/out · ← → frame step (Shift = 1 s) · Delete remove ·
Ctrl/Cmd+Z undo · Ctrl/Cmd+S save · Esc privacy screen.
