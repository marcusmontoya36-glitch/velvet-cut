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
   **Camera height and lens:** about every 3rd shot is seen **from above** (looking down: keystone with the top of the frame
   closer, plus a slow downward tilt) or **from below** (looking up), with a slight **dutch tilt** on some. An optional
   **fisheye** lens (Subtle/Strong) goes on some low-angle and close shots. These are perspective warps of your own footage,
   always fully inside the frame so there are no black edges. Medium and close framings stay dominant, and wide is at most 1 in 5.
   The preview uses CSS `matrix3d` (fisheye and boomerangs use WebGL). The ffmpeg export uses `perspective` and `lenscorrection`,
   and the real-time export uses the same WebGL shader. You can override any of it per clip in the Clip tab.
5b. **⏱ Extend** (Off / ×1.5 / ×2 / 30 s / 60 s). Makes the edit longer **using only your footage**, with no generated frames:
   - slow motion (0.5×) on the sharpest, steadiest stretches. At export, in-between frames are made with frame blending
     (**Fast, the default**) or `minterpolate` (Smooth, opt-in, much slower, ffmpeg engine only); 60 fps sources just get retimed.
   - boomerang loops (forward, then back) of best moments.
   - replays of best moments later on from another "camera": above or below, mirrored, sometimes fisheye.
   Per clip: Speed (0.75 / 0.5 / 0.33×) and 🔁 Boomerang in the Clip tab.
6. **Export MP4 for iPhone (v7: fast path).** The exporter picks the fastest path that can do the job:
   1. **Stream copy (remux)** when nothing needs rendering (plain trims/joins of same-format H.264/HEVC clips, Source size):
      samples are copied into a new MP4 in well under a second. Starts at the keyframe at or before each in point.
   2. **WebCodecs (default)**: mp4box.js demuxes the sources, `VideoDecoder` decodes, a WebGL shader draws the camera moves,
      angles, fisheye, color, sharpen, crossfades and slow-mo blends, the GPU converts to I420 (BT.709 limited range), and
      the hardware `VideoEncoder` (H.264 High, Safari 16.4+/Chrome) encodes. Audio is mixed/time-stretched in JS and encoded once
      with `AudioEncoder` AAC (or, where that is missing, ffmpeg.wasm encodes only the audio and copies the video).
      `mp4-muxer` writes the MP4 with moov first (faststart). One encode, no WebM→MP4 transcode. Progress shows speed and ETA.
   3. **ffmpeg.wasm (fallback / "Compatible" engine)**: the chunked export (WORKERFS mounts, per-shot pieces, joined, AAC once,
      `+faststart`). Used automatically for Smooth slow-mo, sources WebCodecs can't decode, or if the fast path fails; or pick it
      in Export → Engine for denoise/stabilize.
   **⚡ Quick export** (Export tab) = 720p, Good quality, fastest engine. The result can be previewed in-page before saving.

After an Auto Edit, the normal timeline tools still work: trim, split, reorder, delete, captions, undo.
Changing a setting re-plans instantly because the analysis is cached.

**Import is instant:** it only creates an object URL and reads metadata. The poster frame (from a `#t=` media fragment, no seeking),
the capture date and the save to IndexedDB run in the background. `.mov` blobs are re-typed `video/mp4` with `slice()` (no copy),
because WebKit can refuse `video/quicktime` blob URLs. ffmpeg.wasm loads only when you export. The 31 MB core is
downloaded once with a progress readout into its own cache bucket (`vc-core-v1`), which app updates don't wipe.

**Limits:** analysis takes about 1.5 s for a 10 s clip on a desktop (8× playback) and depends on the phone. Export speed (test
edits, headless Linux with software GL + software H.264, so a real device with a GPU/hardware encoder is faster):
17.5 s edit 34.8 s → ~17 s; ×2 extended 35 s edit 117.8 s → ~39 s (WebKit WebCodecs: 8.7 s / 17.7 s). Stream copy: ~0.1 s.
The fast path skips denoise/stabilize; boomerang reverse frames are cached at ≤960 px. On iPhone, keep exports to roughly 5 minutes at 720p (or use 480p). The
encoded pieces and the final MP4 live in the tab's memory. Real-time export (Export tab) is the fallback; it applies color,
camera moves and crossfades, but not denoise or sharpen.

## 🌗 Shadow recovery (brighten dark areas)
Dark corners and underexposed clips get a local shadow lift. **⚡ Auto Edit** measures each clip's shadow fraction
(share of luma below 20 %) and applies it automatically (Auto Edit settings → **🌗 Brighten dark areas**, on by default).
Per clip: **Clip tab → Shadows** (0–100) with an **Auto shadows** box (shows `Auto (n)`; untick it to set your own value, 0 = off).

How it works (identical model in the preview, the fast WebCodecs export and the ffmpeg.wasm fallback):
- A coarse local-brightness map (64-cell grid of √luma, blurred; edge-aware so bright/dark edges don't halo) decides
  what counts as "a dark area". Pixels in dark areas get a gamma lift on the lows plus mild CLAHE-style local contrast.
- The lift multiplies R, G and B by the same gain, so hue doesn't change and skin stays natural (no colour cast).
  Highlights are protected: no channel is lifted past 80 %, which leaves room for the auto grade so nothing clips.
- Lifted shadows get a slight 5-tap denoise in proportion to the gain, so sensor noise doesn't turn into blotches.
- Preview and fast export run it as a WebGL shader (two tiny passes build the map). ffmpeg does the same in YUV with
  8-bit LUTs (`lut`/`lut2`/`maskedmerge`) on 4:2:0 planes.
- When the lift is on, Auto Edit's "too dark" cut only drops near-black frames, and dim frames aren't flagged blurry.

Measured on synthetic underexposed 720p clips (gamma 1.9 ×0.6 + noise), auto strength 85: luma of shadow pixels
7–15 → 46–53 /255, frame mean 25–34 → 76–83, highlight clipping 0 % → ≤ 0.07 %. Normally exposed clips get 0–20.
Export cost on the test box: fast path +8–27 %, ffmpeg.wasm +49 %.

## 🎥 Multi-cam (same scene, several phones/angles)
Upload several clips of the same scene from different spots and run **⚡ Auto Edit**. The app finds which clips
belong together, lines them up on one shared timeline, and cuts between the cameras. It never replays the scene once
per clip. After every run the Auto tab says what it found: **“🎥 3 angles synced ✓ (by sound 100%)”** or
**“🎥 Angles not matched …”** with the reason.

- **Sync by sound:** each clip's AAC track is decoded on the device and filtered down to 8 kHz. iPhone `.mov`
  (HEVC or H.264, AAC 44.1/48 kHz, spatial-audio, metadata and timecode tracks) is handled by picking the AAC track
  and trying, in order: WebCodecs AudioDecoder → ADTS + Web Audio → audio-only .m4a + Web Audio → whole file (small
  files only) → ffmpeg.wasm audio-only. ffmpeg reads the file in place and downloads the engine once. Each clip's
  row in the 🎥 panel says how its sound was read, or why it couldn't be.
  Levels are normalised, so a quiet or far-away phone still matches (tested at −55 dBFS). The search covers every
  offset, including cameras that started minutes apart, different lengths and partial overlaps (≥ 1.5 s). A 100 Hz
  onset envelope gives a coarse match, and GCC-PHAT on the waveform refines it to under 1 ms. Each pair gets a
  confidence score. A weaker match is accepted when a third camera confirms it (lag AB + lag BC ≈ lag AC). If the
  sound doesn't match, clips whose capture times overlap are grouped by date. The date comes from iPhone's
  `com.apple.quicktime.creationdate`, falling back to `mvhd`.
- **🎥 Same scene — different angles:** tick clips in the 🎥 panel and tap it to force them into one multi-cam
  group. It still uses the sound if it matches at all; otherwise the clips are **lined up by their start** (for
  example, the scene filmed again from another spot), and each angle keeps its own sound. Nudge with −1 s / −0.1 s /
  −1 frame / +1 frame / +0.1 s / +1 s. The **sync view** draws every camera's sound hits on the shared timeline, so
  matching patterns line up vertically when the sync is right (replays show as light bands).
- **“Are these the same scene from different angles?”** appears when clips weren't matched but have a similar
  length and look. Tap Yes to group them; No hides the question for those clips.
- **🔁 Every-angle replays** (Auto Edit settings, Auto ≈ 1 per 30 s, or 1–6, or Off): highlight moments, scored
  on loud/busy sound, motion and sharpness where ≥ 2 cameras saw them, play back to back from every camera (A, then
  B, then C; 1.6/2.2/3 s each depending on pace; slight 0.8× slow-mo optional; hard cuts or 0.2 s dissolve), and
  then the edit carries on. **Clip tab → 🔁 Mark moment — show all angles** does the same by hand for the moment
  just before the playhead.
- **Auto Edit settings:** Multi-cam (auto/off), Between cameras (hard cut, 0.2 s dissolve, 0.4 s) and Camera pace
  (fast 1.5–3 s / normal 2–5 s / slow 3–7 s). It cuts to whichever angle is sharpest and steadiest at that moment,
  avoids long runs on one camera, gives every camera a share, and lands cuts on beats. It drops moments where every
  camera is bad.
- **Continuous sound:** for clips synced by sound, the longest camera is the master track. Every shot plays the
  master's sound for its exact moment, so the audio runs straight through camera switches.
- In the Clip tab, **Camera** switches a selected shot to another angle of the same moment.

**Multi-cam limits:**
- Clock drift between devices isn't corrected (fine for clips of a few minutes).
- Clips lined up by start are only as accurate as your nudges. Takes filmed one after another are never truly in
  sync, so the cuts show the same action from different takes.
- The look-alike prompt is a heuristic (length, brightness, colour). It can miss angles that look very different,
  or ask about unrelated clips.
- A camera whose frames fall between the output's frames can be up to half a frame (≤ 17 ms) off the sound.
- Changing nudges or groups re-plans the edit and drops manual camera picks and manual replays.
- Boomerangs and the real-time export use each camera's own sound.

## Features

| Area | What works |
|---|---|
| Import | File picker or drag-drop (mp4 / mov / m4v / webm). Files are kept in the browser (IndexedDB). |
| Timeline | Multiple clips, thumbnails, zoom, tap-to-seek, drag clip edges to trim, drag to reorder (mouse) or ◀ ▶ Move buttons (touch), split at playhead, duplicate, delete, per-clip mute, undo (↶ / Ctrl+Z, Shift+Ctrl+Z redo). |
| Preview | Seamless-ish playback across clips, live color + captions. |
| Text | Add text at playhead, drag it on the preview, size / color / X / Y / start / end / background box. Burned into export (rendered as PNG overlays, identical look to preview). SRT export and SRT import. |
| Color | Brightness, contrast, saturation, warmth for the whole project — preview (CSS filter) and export (ffmpeg `eq` + `colorbalance`, close but not pixel-identical). |
| Projects | Autosaves 1 s after each change; Projects list (open / delete / new); reopens the last project on launch. Storage usage shown. |
| Export A | **Fast MP4** (stream copy → WebCodecs hardware H.264 + AAC, moov first) with **ffmpeg.wasm** fallback → H.264/AAC MP4 (480p / 720p / 1080p / source, 3 quality levels). Mixed sizes/orientations are letterboxed to the first clip's shape. |
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
- Shadow recovery: very dark footage is noisy and lifting it shows the noise (the denoise is light on purpose). Pure
  black (crushed) areas have nothing to recover. Under fisheye, keystone, or a zoom that changes inside a clip, the ffmpeg path uses the clip's
  average zoom for the brightness grid, so its result can differ slightly from the preview. GL vs ffmpeg typically differ by ~2/255.
  The ffmpeg path assumes BT.709 colour. The real-time export (Export tab) applies the lift only where WebGL is available.
- No free multi-track editing or music track yet (multi-cam uses one master sound track).

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
wcexport.js                            fast export: remux, WebCodecs decode/render/encode, mp4 muxing
multicam.js                            multi-cam: audio sync (onset xcorr + GCC-PHAT), grouping, camera switching plan
fx.js                                  WebGL renderer (camera, angles, fisheye, color, blend) shared by preview + exports
ai.js                                  silence/motion/black detection, auto color, transcript timing
hooks.js                               optional cloud/self-hosted enhance hooks
sw.js  manifest.webmanifest  icons/    PWA
vendor/webcodecs/                      mp4box.js 2.6.0 (BSD-3) + mp4-muxer 5.2.2 (MIT)
vendor/ffmpeg/                         @ffmpeg/ffmpeg 0.12.15 + @ffmpeg/core 0.12.10 (single-thread, LGPL/GPL — see their licenses)
shots/                                 UI screenshots
```
Keyboard: Space play/pause · S split · I / O set in/out · ← → frame step (Shift = 1 s) · Delete remove ·
Ctrl/Cmd+Z undo · Ctrl/Cmd+S save · Esc privacy screen.
