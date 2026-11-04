# midstudy v1 plan

midstudy is a fork of [nook](https://github.com/salehtl/nook) for the same goal: seeing furniture in your own room before you buy it. It drops the room scan. The room is **one photo from a phone**. Furniture is still made from photos at real-world size (Meta's SAM 3D Objects on fal, as in nook). You place the 3D pieces on the photo's floor, turn and move them, save layouts, and render a photoreal image with an image-edit model.

This file is the plan and the spec. It is owned by the main session. Build agents read it directly; they don't get summaries of it.

---

## 1. User story

1. **New scene:** upload a phone photo of a room (JPEG, HEIC, PNG or WebP). Within seconds the scene opens with a 50 cm grid drawn on the photo's floor. If the grid doesn't sit on the floor, **Adjust floor** fixes it with three sliders and a drag.
2. **Add furniture:** from the Library panel, exactly as in nook (photo, image link, GLB or zipped OBJ; SAM 3D by default).
3. **Place:** tap a library item and it lands on the floor in front of the camera. Drag it to move it across the floor: dragging it away shrinks it with perspective, dragging it closer grows it. A grip turns it. Up / Down raises it (shelves, lamps on a table).
4. **Occlusion:** a piece placed behind the real sofa in the photo is hidden by it.
5. **Layouts:** save several layouts per scene and switch between them.
6. **Render:** one button sends the composite (photo plus 3D pieces) to nano-banana with the original photo as a reference, about $0.04. Renders are kept per scene and layout.
7. **Compare:** pick two renders and compare them side by side or with a split slider.
8. Works on the phone (390 × 844, touch only) and the desktop.

The camera never moves. The photo is the only viewpoint. Pinch or wheel zoom is a 2D zoom into the photo (up to 4×) that keeps the 3D registered.

---

## 2. What carries over from nook

| Keep (adapt) | Drop |
|---|---|
| `pipeline/` (`nook-add` → `midstudy-add`): SAM 3D / Trellis 2 / GLB / OBJ zip, normalization, fal mock | `ios/` (Nook Scan) |
| `planner/serve.py`: static server, library API (§2.8), mutating-request and money rules (§2.9), render API (§2.6), layouts | `scan/`, `gsplat/`, `poses/`, the jobs-server proxy (`--scan-api`), retrain |
| `planner/` UI kit, shell, workspace, sheet, library panel, renders panel, phone layout | Spark, splat rooms, LoD, splat-baked environment, True colour, alignment picks, RoomPlan shell, viewpoints, seated / standing / walk |
| `contract/library.schema.json`, `layout.schema.json` (scene instead of room) | `room.schema.json`, `capture.schema.json`, `roomplan.schema.json` |
| Evals: `pipeline_offline.sh`, `library_api.sh`, `validate_library.py`, mocks in `fixtures/fal`, `fixtures/models`, `fixtures/library*` | Scan, iOS, sharpness, quality, remote and hosted evals; `deploy/` (Cloudflare copy) |
| `fixtures/make_capture.mjs` (becomes `fixtures/make_scene.mjs`, the golden-scene renderer) | `docs/plans/`, `docs/SCANNING.md` |
| `nix/` as a reference for packaging (§9) | `nix/gsplat.nix`, `nook-gsplat.nix`, `poses.nix` |

Splat furniture (`splat.ply` items) may stay in the library format, but the planner draws GLB only in v1.

### Renames

`nook` → `midstudy` wherever a user or another program sees it: the CLI (`midstudy-add`), the Python package (`midstudy_pipeline`), env vars (`MIDSTUDY_FAL_MOCK`, `MIDSTUDY_FAL_MOCK_COST`, `MIDSTUDY_NO_DOTENV`, `MIDSTUDY_FETCH_ALLOW`, `MIDSTUDY_CALIB_MOCK`), the mutation header (`X-Midstudy: 1`), upload headers (`X-Midstudy-Kind`, `-Filename`, `-Meta`), the test hook (`window.midstudy`) and test handles (`data-midstudy="…"`). Internal identifiers may keep old names where renaming adds risk and nothing else.

---

## 3. Repo layout and ownership

| Path | Owner (build phase) |
|---|---|
| `planner/` (browser app and `planner/serve.py`) | app track |
| `calib/` (uv project, `midstudy-calib`) | calib track |
| `pipeline/` | foundation (rename only); no feature work in v1 |
| `contract/`, `CLAUDE.md`, `PLAN.md`, `fixtures/scenes/`, `fixtures/calib/` | foundation; read-only afterwards except for the integration agent |
| `evals/` | evals track (new evals); foundation (carried evals) |
| `nix/`, `flake.nix` packages, `docs/HANDOFF.md` | packaging |
| `docs/notes/<track>.md` | each track writes its own: what it built, how to run it, known gaps |
| `scenes/`, `library/`, `layouts/`, `renders/` | user data written by the tools (git-ignored, except `library/library.json` and `costs.csv` as in nook) |

Conventions stay nook's: meters in 3D, centimeters only in `dims_cm`; right-handed, Y-up; floor at y = 0; item origin at the footprint center on the floor, front faces +Z; ids are slugs `^[a-z0-9][a-z0-9-]{0,63}$`.

---

## 4. Spec

### 4.1 Camera model and world frame

- World: meters, Y-up, the floor is the plane y = 0.
- The scene camera is a three.js `PerspectiveCamera` at `(0, height_m, 0)`, with `camera.rotation.set(pitch, 0, roll, 'YXZ')` in radians (yaw is always 0, so the camera looks along −Z, tilted down by a negative pitch). `fov` is `fov_y_deg`, `aspect` is the photo's width / height. The principal point is the image center in v1 (an off-center one from MoGe is recorded but not used).
- The camera block, used in every file and API:

```json
{ "fov_y_deg": 55.0, "height_m": 1.40, "pitch_deg": -12.0, "roll_deg": 0.0 }
```

Ranges: `fov_y_deg` 20–110, `height_m` 0.2–3.0, `pitch_deg` −80…+30, `roll_deg` −20…+20 (clamped).

### 4.2 Scenes on disk

```
scenes/<name>/source.<ext>   the upload as given (never served)
scenes/<name>/photo.jpg      normalized: EXIF orientation applied, sRGB JPEG q92, long side ≤ 2048 px
scenes/<name>/calib.json     the automatic calibration (calib.schema.json); written by midstudy-calib
scenes/<name>/depth.png      optional: 16-bit grayscale PNG, metric depth along the camera's view axis in mm,
                             long side ≤ 1024 px, same aspect as photo.jpg; 0 = no occluder (sky, unknown, or floor)
scenes/<name>/scene.json     scene.schema.json: title, created, saved, camera (the one in use), camera_source, look
scenes/<name>/thumb.jpg      thumbnail (made by the planner)
scenes/.trash/<name>-<UTC stamp>/   deleted scenes
layouts/<scene>/<layout>.json       a scene's layouts (layout.schema.json with scene_name)
renders/<name>.jpg, <name>-input.jpg, <name>.json, optional <name>-raw.jpg   (§4.7)
```

`<name>` is `scene-YYYYMMDD-HHMMSS` (UTC, numeric suffix on collision). `title` is free text.

`calib.json`:

```json
{ "version": 1,
  "source": "moge-2" | "exif" | "default" | "truth",
  "model": "Ruicheng/moge-2-vitl-normal" | null,
  "image": { "w": 2048, "h": 1536 },
  "camera": { …camera block… },
  "principal": [0.5, 0.5],
  "floor": { "found": true, "inlier_ratio": 0.31, "rmse_m": 0.012 },
  "depth": { "file": "depth.png", "w": 1024, "h": 768, "floor_masked": true } | null,
  "exif": { "focal_35mm": 26, "fov_y_deg": 51.2 } | null,
  "device": "mps" | "cuda" | "cpu" | null, "elapsed_s": 6.2 }
```

`"truth"` is used only by the golden scenes (§6.1). `scene.json`'s `camera_source` is `auto` (copied from `calib.json`), `manual` (the user adjusted it) or `default`.

### 4.3 Calibration (`calib/`, console script `midstudy-calib`)

A uv project (Python 3.12) with Pillow, pillow-heif, numpy, torch and MoGe-2 (`git+https://github.com/microsoft/MoGe` pinned to a commit). Weights come from Hugging Face on first use (cached outside the repo).

```
midstudy-calib run <upload> --out <scene-dir> [--model vitl|vitb|vits] [--device auto|cuda|mps|cpu] [--no-depth]
midstudy-calib ingest <upload> --out <scene-dir>        # photo.jpg + source.<ext> only
midstudy-calib fit <scene-dir> [...]                    # calib.json + depth.png from photo.jpg
midstudy-calib align <photo.jpg> <raw.jpg> <mask.png> --out <final.jpg>   # keep-room composite (§4.7)
```

- `run` = `ingest` + `fit`. Prints one JSON line to stdout (the `calib.json` contents plus `ok: true`), progress to stderr, exit 1 with a one-sentence error on failure.
- **Ingest:** accepts JPEG, PNG, HEIC/HEIF and WebP up to 25 MB. Applies EXIF orientation, converts to sRGB using the embedded ICC profile (iPhones write Display P3), downsizes to a 2048 px long side, and reads the EXIF focal length (35 mm equivalent) and camera model into `calib.json`. **Privacy:** `photo.jpg` carries no metadata at all (no EXIF, no GPS, no XMP), since it's served and sent to fal. `source.<ext>` keeps the original as uploaded, is never served, and goes to the trash with the scene.
- **EXIF FOV:** the 35 mm equivalent refers to the diagonal of the sensor's native 4:3 frame. A 16:9 phone photo is a crop of that frame that keeps the width, so compute the 4:3 frame's FOV first, then crop. Check it on `fixtures/photos/upper-lounge-camera.jpeg` (14 mm equivalent: about 100° horizontal, 70° vertical). When MoGe runs, its FOV wins, and the EXIF FOV is recorded beside it as a sanity check (a disagreement over 8° is logged in `calib.json` as `fov_disagreement`).
- **Ultrawide is normal:** phones shoot rooms on the 0.5× lens (the user's own photo is 14 mm equivalent). iOS corrects the distortion, so the pinhole model holds roughly; v1 supports FOV up to 110° vertical and doesn't warn about ultrawide.
- **Fit:** MoGe-2 gives a metric point map, normals and intrinsics. Fit the floor plane with RANSAC over points whose normal points up relative to the camera and that lie below it; prefer the largest such plane in the lower part of the image. The plane gives `height_m`, `pitch_deg` and `roll_deg`; the intrinsics give `fov_y_deg`. Write `depth.png` with the floor pixels (within 4 cm of the plane) set to 0, so the floor never hides furniture.
- **Fallbacks:** no floor found → `floor.found: false`, the camera from MoGe's FOV with height 1.40 and pitch −10; MoGe unavailable or failed → `source: "exif"` (FOV from the 35 mm focal length) or `"default"` (FOV 55), height 1.40, pitch −10, no depth. A fallback is a success (exit 0) that the planner flags ("Check the floor").
- **Device:** `auto` picks cuda, then mps (with `PYTORCH_ENABLE_MPS_FALLBACK=1`), then cpu. The Mac (M3 Max, 36 GB) runs it locally during development; homeserver's RTX 2060 runs it once hosted.
- **Align** (opencv-python-headless): resize the model's output to the photo's size, estimate a homography from the output to the photo using features outside the mask (ORB + RANSAC, or ECC), warp, then composite `photo × (1 − mask) + warped × mask` with the mask feathered. Print one JSON line: `{ok, inliers, residual_px, applied}`. If there are fewer than 40 inliers or the median residual is over 3 px, write nothing, exit 0 with `applied: false` and a `reason`. Always runs for real (no mock needed: with an identical image it's the identity).
- **Mock:** with `MIDSTUDY_CALIB_MOCK=<dir>` (e.g. `fixtures/calib`), `fit` never loads MoGe: when `photo.jpg`'s SHA-256 matches `<dir>/<sha>/`, it copies that `calib.json` and `depth.png`; otherwise it writes the `default` fallback. `ingest` still runs for real.

### 4.4 Server additions (`planner/serve.py`, stdlib only)

`serve.py` gains `--scenes-dir` (default `scenes/`) and `--calib CMD` (default `uv run --project calib midstudy-calib`; the Nix package passes its own binary). It runs `midstudy-calib run` as a job, like library jobs (one queue for calibration, separate from the library queue; one at a time). Every mutating route follows nook's §2.9 rules with `X-Midstudy: 1`.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/scenes` | | `200 {"scenes": [scene, ...]}`, newest first |
| `POST /api/scenes` | raw photo body, `Content-Length` required, headers `X-Midstudy-Filename`, optional `X-Midstudy-Meta` (base64 JSON `{title}`) | `202 {job, scene: name}` |
| `GET /api/scenes/jobs`, `GET /api/scenes/jobs/<id>` | | job objects (nook §2.8 shape, `kind: "calibrate"`, `scene`) |
| `GET /api/scenes/<name>` | | `200` scene.json merged with `calib` (calib.json) and asset URLs, `404` unknown |
| `PUT /api/scenes/<name>` | scene.json (title, camera, camera_source, look) | `200` the stored scene; `saved` stamped unless only `title` changed |
| `PUT /api/scenes/<name>/thumb` | `{"image": "data:image/jpeg;base64,…"}` ≤ 2 MB | `200` |
| `POST /api/scenes/<name>/calibrate` | | `202 {job}`: re-runs `fit`; on success the scene's camera is replaced only if `camera_source` is `auto` or `default` |
| `DELETE /api/scenes/<name>` | | `200 {"ok": true, "trash": …}`: the scene folder and `layouts/<name>/` move to `scenes/.trash/` |
| `GET/PUT/DELETE /api/layouts/<layout>?scene=<name>`, `GET /api/layouts?scene=<name>` | | as nook §2.7 with `scene` for `room` (no v1 layouts) |

The scene object: `{name, title, created, saved, photo_url, thumb_url | null, depth_url | null, w, h, camera_source, floor_found, layouts, calib_status: "pending" | "running" | "done" | "failed"}`.

Static: `/scenes/<name>/photo.jpg`, `depth.png` and `thumb.jpg` are served; `source.*`, `calib.json` (served through the API instead) and `.trash/` get `404`. A scene exists from the moment its upload is accepted (`calib_status: "pending"`), so the planner can show it while it calibrates.

Upload limits: 25 MB (`413`), `411` without a length, and a body that isn't one of the four image types gets `400` with one sentence.

### 4.5 Planner

- **Scenes page** (replaces Rooms): a grid of scene thumbnails, newest first, with **New scene** (file picker that accepts camera roll photos on iOS) and per-scene rename and delete. A scene still calibrating shows its photo with a spinner and opens when done. `?scene=<name>` opens a scene; without it, the last scene opened on this device, else the Scenes page.
- **The view:** the photo fills the view, contain-fit with letterbox bars, and the 3D view is registered to it (same aspect; camera from `scene.json`). The photo is drawn **exactly as is**: no tone mapping, exposure or warmth. Look (exposure, warmth) and ACES apply to the furniture only. Pinch or wheel zoom and two-finger or middle-drag pan are 2D only (`camera.setViewOffset`), up to 4×, and **Fit** resets them.
- **Floor check:** after a scene first opens, and whenever **Adjust floor** is on, a 50 cm grid is drawn on y = 0 out to 8 m, fading with distance. Adjust floor has sliders for camera height (cm), field of view (°) and roll (°), and the horizon line can be dragged to set the pitch. An optional two-tap ruler shows a floor distance in cm, so a known length (a rug, a tile) can be checked. **Looks right** saves the scene (`camera_source: "manual"` if anything changed). **Reset** goes back to the automatic camera. A scene whose `floor.found` is false or whose source isn't `moge-2` opens in Adjust floor with a one-line note.
- **Items:** as nook: add from the library, select, drag on the floor plane at the item's elevation, rotate grip, Up / Down (§2.10 elevation only; no wall hanging in v1), remove with undo, contact shadows, missing-item placeholders. A new item lands where the ray through the view center (or the lower-middle third, if that misses the floor) hits the floor, between 1 and 6 m from the camera, else 2.5 m ahead.
- **Lighting:** three.js `RoomEnvironment` plus a key light; Look is saved in `scene.json`. The render pass does the real matching.
- **Occlusion:** with a `depth.png`, a full-screen pass writes the photo's depth into the depth buffer before the items draw (colour writes off), so an item fragment is hidden where the photo has something nearer, with a 3 cm tolerance. Depth 0 never occludes. **Occlusion** toggle, on by default when the scene has depth.
- **Layouts:** per scene (`?scene=`), save / load / delete / switch, unsaved-change warnings, as nook.
- **Render** (§4.7) and **Compare:** in the Renders panel, select two renders and open a full-screen compare: side by side on desktop, a draggable split slider on both, swipe between them on the phone.
- Removed: orbit, seated / standing / walk, viewpoints, room alignment and picks, shell, hang on wall, retrain, splat items, LoD, True colour.

### 4.6 Hook (`window.midstudy`)

Carried from nook where it still applies (items, library, layouts, renders, look, errors, `getState()`), plus:

```ts
listScenes(): Promise<Scene[]>
createScene(file: File, meta?: { title?: string }): Promise<{ job, scene }>   // resolves when the upload is accepted
waitForScene(name: string): Promise<Scene>                                      // resolves when calib_status is done or failed
openScene(name: string): Promise<void>                                          // resolves when the photo (and depth) are shown
deleteScene(name: string): Promise<void>
getCamera(): Camera; setCamera(partial: Partial<Camera>): void; resetCamera(): void; saveScene(): Promise<void>
setAdjustFloor(on: boolean): void; setOcclusion(on: boolean): void
getScreenRect(uid: string): { x, y, w, h } | null      // the item's projected bounds in photo pixels (not CSS px)
photoToFloor(px: number, py: number): [x, 0, z] | null  // photo pixel → floor point, null above the horizon
floorToPhoto([x, y, z]): [px, py]
renderView(opts?: { model?, prompt?, keepRoom?: boolean }): Promise<RenderMeta>
compare(a: string, b: string): void
getState().scene: { name, title, camera, camera_source, floor_found, hasDepth, occlusion, adjustFloor } | null
```

Test handles (`data-midstudy`): `scene-new`, `scene-file`, `scene-card`, `scene-delete`, `adjust-floor`, `cam-height`, `cam-fov`, `cam-roll`, `horizon`, `floor-ok`, `floor-reset`, `occlusion`, `zoom-fit`, `render`, `render-go`, `keep-room`, `compare`, plus nook's `elev-up`, `elev-down`, `elev-value`, `drop`, `lib-add`, `lib-remove`, `lib-undo`, `missing-item`.

### 4.7 Render

- The capture is the full photo frame at the photo's resolution (view offset cleared, no UI): photo plus furniture, Look applied to the furniture only.
- `POST /api/render` gains `scene` (required for a reference) and `layout`. For `nano-banana`, the server sends `image_urls: [composite, scene photo]` with the default prompt below; other models get the composite only.
- Default prompt: *"Image 1 is a photo of a room with 3D models of furniture placed in it. Image 2 is the same room as photographed. Make the furniture in image 1 look like it was photographed in this room: realistic materials, lighting, reflections and contact shadows that match the room's light. Keep the camera, the room and everything already in it exactly as in image 2. Keep each piece of furniture's position, size, shape and color. Do not add, remove or move anything."*
- **Measured on 2026-11-04 (one live call, real photo, 2000 × 1125 input):** nano-banana/edit returned **1344 × 768** (aspect 1.75 vs 1.778). It snaps to fixed output sizes of about 1 MP, and the framing drifts by roughly 1–2 % of the width. The furniture and room were kept well, and the result looked photographic. So the output is never pixel-aligned with the photo, and keep-room has to register it first.
- **Keep room exact** (render dialog toggle, **default off** until the live check in §8 says otherwise): the request also carries `keep_room: true` and `mask` (a PNG data URI at the photo's size: items white on black, dilated by 3 % of the photo width, more below each item for its shadow). After fal returns, the server runs `midstudy-calib align` (§4.3) and keeps the model's output as `<name>-raw.jpg` and the aligned composite as `<name>.jpg`. When alignment isn't applied, `<name>.jpg` is the raw output and the meta says why.
- The render is shown at its own size (about 1 MP). It's not upscaled in v1.
- Render meta gains `scene`, `layout`, `reference: true|false`, `keep_room`, `aligned: {applied, inliers, residual_px, reason?} | null`, `raw_url`, `out_w`, `out_h`.
- Mock mode as nook: the result is a copy of the input, $0 (so align is the identity and must apply).

---

## 5. Development without homeserver

Everything during the build runs on the Mac. Nothing touches homeserver, and no build step uses ssh.

- **Tools:** `flake.nix` dev shell (aarch64-darwin and x86_64-linux): python312, uv, nodejs_22, git. Run commands as `nix develop -c <cmd>`. Never install tools globally.
- **Browser:** Helium headless for evals (`/Applications/Helium.app/Contents/MacOS/Helium`, flags `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`).
- **Calibration:** MoGe-2 on the Mac (MPS, CPU fallback). Evals that only need a camera use `MIDSTUDY_CALIB_MOCK=fixtures/calib`; `eval:calib` runs the real model.
- **fal:** mocked everywhere (`MIDSTUDY_FAL_MOCK=fixtures/fal`), $0. `.env` now holds a real FAL key (git-ignored). No build agent reads `.env` or makes a paid call: every server an agent starts gets `MIDSTUDY_NO_DOTENV=1` (`NOOK_NO_DOTENV=1` before the renames), the mock variable and `--daily-spend-usd 0`. Only the main session makes live calls, after the build (§8).
- **Real photos:** `fixtures/photos/` (git-ignored) holds the user's own phone photos; read `fixtures/photos/notes.md` for what each one is. It holds the user's lounge: the camera original with EXIF (location removed; 0.5× ultrawide), a copy without metadata, and an AI-generated empty version. `fixtures/photos/private/` holds the untouched original with location data: no agent opens it. Otherwise the calib track downloads 4–6 public-domain or CC0 interior photos from Wikimedia Commons into `fixtures/photos-public/` with a `LICENSES.md` (source URL, author, licence per file).
- **Git:** all work lands on branch `v1` as local commits. Nothing is pushed.

---

## 6. Evals (written before or alongside the code)

### 6.1 Golden scenes (foundation)

`fixtures/make_scene.mjs` (adapted from nook's `make_capture.mjs`) renders a textured room with three.js in headless Helium from a known camera and writes `fixtures/scenes/<id>/photo.jpg`, `truth.json` (the camera block), `depth.png` (exact depth, floor masked) and a `calib.json` with `source: "truth"`. It also copies `calib.json` and `depth.png` into `fixtures/calib/<sha of photo.jpg>/` so the calib mock serves them. Three scenes:

| id | size | camera |
|---|---|---|
| `living-wide` | 1600 × 1200 | fov 55, height 1.40, pitch −10, roll 0 |
| `steep-roll` | 1600 × 1200 | fov 65, height 1.60, pitch −25, roll 2 |
| `portrait` | 1200 × 1600 | fov 70, height 1.25, pitch −8, roll −1 |

Each has a box "sofa" and a table at known positions (in `truth.json`), so occlusion and projection can be checked against geometry.

### 6.2 Task evals (`npm run eval:*`, all $0, mocks unless noted)

| eval | checks |
|---|---|
| E1 `eval:scenes-api` | upload JPEG → `202`, scene listed `pending`, calibrates (mock), `photo.jpg` ≤ 2048, scene JSON has the camera; PUT camera round-trips; delete moves to trash; layouts per scene don't leak across scenes; §2.9 rules (W1–W4) on every new route; spend cap covers `/api/render` |
| E2 `eval:calib` (real MoGe, local) | on each golden scene: fov within 5°, height within 10 %, pitch within 3°, roll within 2°; `depth.png` median error ≤ 10 % on non-floor pixels; on each real photo: exit 0, `floor.found` reported, runtime logged; `upper-lounge-camera.jpeg`'s FOV within 8° of its EXIF estimate, and `photo.jpg` free of any metadata. `--mock` variant checks ingest (HEIC, EXIF-rotated portrait, PNG, WebP, 25 MB limit) without MoGe |
| E3 `eval:planner` | open a golden scene: `floorToPhoto` of truth.json's sofa corners lands within 3 px of the rendered photo's corners; add an item: it sits on y = 0 inside the frame; move it from 2 m to 4 m: `getScreenRect` height shrinks by the projected ratio ±5 %; rotate 90° and save a layout, reload, everything restores |
| E4 `eval:occlusion` | golden `living-wide`: an item behind the sofa has its hidden pixels match the photo there (≥ 95 %); toggled off, the item shows; a scene without depth never occludes |
| E5 `eval:floor` | Adjust floor: changing height, FOV, roll and horizon changes `getCamera()`, Looks right saves `camera_source: "manual"`, reload restores it, Reset brings back `auto` |
| E6 `eval:render` | `renderView()` in mock mode writes the files, the request carries the scene photo as reference for nano-banana, keep-room writes `-raw.jpg` and an applied composite; `midstudy-calib align` on a synthetic pair (the photo scaled to 1344 × 768 and shifted by 2 %) registers within 2 px and refuses an unrelated image; the render lists in the panel, Compare opens with two renders |
| E7 `eval:library` | carried nook library API (L8–L11) under the new names |
| E8 `eval:pipeline` | carried nook pipeline eval under the new names |
| E9 `eval:phone` | at 390 × 844, touch only: new scene, add, drag, rotate, Up / Down, save layout, render and compare are all reachable; every target ≥ 44 px; no horizontal page scroll |
| E10 `eval:all` | runs E1 and E3–E9 (E2 only with `--with-calib`) |

---

## 7. Orchestration

The build runs as one workflow, [.claude/workflows/midstudy-v1.js](.claude/workflows/midstudy-v1.js). Its shape follows *Building agents: when to fold subagents into your main agent loop*:

- **One owner of the spec and of quality.** This file and `contract/` are written centrally. Agents read them directly instead of passing summaries along a chain, so no detail is lost in handoffs. Each agent leaves durable notes in `docs/notes/<track>.md` and returns a small structured result.
- **Evals first.** Golden scenes and the carried evals land in the foundation phase, before any feature work. The evals track writes the acceptance evals from the spec alone, without reading the implementation, so the builders don't grade themselves.
- **Divide by context, not by problem type.** Only work with a clean interface runs in its own agent: calibration (Python/ML behind a CLI and `calib.json`), packaging (Nix, behind the CLIs), and black-box verification. The planner and its server are tightly coupled, so one agent owns both, as in nook.
- **Fold where it's coupled.** Integration and fixes are done by one agent with the whole picture, not by per-area fixers that hand findings back and forth.
- **Parallel only where independent.** The three build tracks write disjoint paths (§3) in the same checkout, and none of them commits. Verifiers are read-only. Only phase-boundary agents commit.
- **Hard limits in the harness, not in prompts alone:** no paid fal calls (mocks), no `.env` reads, no homeserver or ssh, no push. Each phase ends with evals; work that fails them is fixed before moving on.

| phase | agents | writes | commits |
|---|---|---|---|
| Foundation | 1 | the whole tree (copy, strip, rename), flake, contract, golden scenes, carried evals | yes |
| Build | 3 in parallel: calib, app, evals | own paths only (§3) | no |
| Integrate | 1 | anything | yes |
| Verify | up to 2 rounds of 3 read-only verifiers (UX, calibration visuals, contract and security), each round followed by 1 fixer | fixer: anything but `nix/` and `flake.nix` | fixer, per round |
| Package (alongside Verify) | 1 | `nix/`, `flake.nix` packages, `docs/HANDOFF.md` | no |
| Finish | 1 | README, `docs/STATUS.md` | yes |

---

## 8. After the build (needs the user)

1. **Live check (about $0.20, main session, key in `.env`):** two renders of a furnished layout on the real lounge photo, with keep-room on and off, to decide keep-room's default. Then one SAM 3D add to confirm the renamed pipeline against live fal. (The key itself and nano-banana's output size were already checked on 2026-11-04, §4.7.)
2. **Your own photos:** a few real rooms through Adjust floor, to see how often the automatic fit needs fixing.
3. **Hosting on homeserver:** hand the repo to a Claude agent on homeserver with `docs/HANDOFF.md`. It packages calib with CUDA torch, finishes `services.midstudy`, picks the port and host name next to nook, and deploys. Nothing in v1 depends on homeserver before that.

## 9. Packaging (draft only, for the homeserver handoff)

- `flake.nix` packages for x86_64-linux: `midstudy-add` (from nook's `nook-add.nix` and `fal-client.nix`), `midstudy-calib` (torch CUDA via `torch-bin`, MoGe and utils3d packaged, weights fetched as a fixed-output derivation or pre-seeded into the service's cache dir), `midstudy` (the web app wrapper) and `nixosModules.default` (`services.midstudy`: `webPort`, `dataDir`, `falKeyFile`, `dailySpendUsd`, `allowedHosts`, `calibDevice`).
- On the Mac, the packaging agent can only evaluate the Linux outputs (`nix eval`, `nix flake check --no-build` where possible), not build them. `docs/HANDOFF.md` lists exactly what was evaluated, what was never built, and the steps left for the homeserver agent.

## 10. Later (not v1)

- **Clear the room:** erase existing furniture from the photo with an image-edit call, saved as a second plate for the scene.
- **Walls:** wall planes from MoGe normals, for hanging pictures and shelves and snapping pieces against walls.
- **Light matching** before rendering: an environment estimated from the photo.
- **Turn existing furniture in the photo into movable 3D pieces** (SAM 3D can reconstruct objects in a scene photo).

## 11. Risks

- MoGe-2 on MPS may hit unsupported ops: CPU fallback is slower (tens of seconds), still fine for a one-off per scene.
- Depth edges are soft, so occlusion can halo around thin legs. The 3 cm tolerance and the toggle are the v1 answer.
- Ultrawide (0.5×) photos are the common case, and their residual distortion and stretched edges strain the pinhole model. Placement near the photo's edges may drift by a few centimeters; v1 accepts that and the floor check shows it.
- The render model may restyle the room. The reference image and keep-room exist for this; the live check (§8) decides the default.
