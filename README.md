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
- No multi-track (one video track + one text track), no transitions, no audio mixing / music track yet.

## Wiring real AI enhance (next steps)
`hooks.js` → `runHook(op, input, cfg)` gets `op` (`enhance` | `upscale` | `polish` | `img2vid`) and
`input = { blob, name, in, out }`, and must return a video `Blob`; the result is imported as a new clip.

1. **Own endpoint (already wired):** Settings → “My own endpoint”. The app POSTs multipart
   `file, op, in, out` with `Authorization: Bearer <token>` and expects video bytes back. Point it at a home
   GPU box (e.g. a small FastAPI wrapper around ComfyUI, Real-ESRGAN / Video2X for upscale, RIFE for
   frame interpolation, or an open-weights image-to-video model). The server must send CORS headers. Self-hosting is the
   most reliable path for explicit material — most hosted APIs reject it.
2. **fal.ai / Replicate / Runway:** fill in `adapters.fal` / `adapters.replicate` / `adapters.runway` in
   `hooks.js`: upload the blob (provider storage API), submit the job for the model you choose, poll until
   done, `fetch()` the output URL, return `await res.blob()`. Trim first (`in`/`out`) to cut upload size —
   e.g. run a quick ffmpeg.wasm `-ss/-t -c copy` before upload. Check each provider's content policy first;
   most hosted video models refuse sexual content and may ban accounts for it.
3. Calling hosted APIs straight from the browser exposes the key to that browser only (it is the user's own
   key on their own device), but a tiny proxy is better if you share the app.
4. Better local AI later: Whisper (transformers.js / whisper.cpp wasm) for true file-based auto captions,
   MediaPipe for smart reframe (landscape → vertical crop that follows the people in the shot).

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
