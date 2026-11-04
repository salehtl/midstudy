# midstudy contract

The shared spec between the **planner** (`planner/`, with its server `planner/serve.py`), the **calibration** CLI (`calib/`, `midstudy-calib`) and the **furniture pipeline** (`pipeline/`, `midstudy-add`). They share only the files and HTTP routes described here. Conventions (units, axes, item frame, slugs) are in [CLAUDE.md](../CLAUDE.md) and apply everywhere. [PLAN.md](../PLAN.md) is the plan; where this file and PLAN.md disagree, PLAN.md wins and this file gets fixed.

Sections 1–3 are nook's contract with the scan, rooms, iOS, Spark and hosting parts removed and the names changed (`nook` → `midstudy`). Section 4 is PLAN.md §4 with the details pinned down. Section 5 covers fixtures and evals.

Schemas: [library.schema.json](library.schema.json), [layout.schema.json](layout.schema.json), [scene.schema.json](scene.schema.json), [calib.schema.json](calib.schema.json).

---

## 1. Files on disk

```
library/library.json          furniture library (library.schema.json); versioned in git
library/costs.csv             one row per paid or mock call: date,id,engine,cost_usd,mock,input; versioned in git
library/<id>/model.glb        normalized mesh, always present
library/<id>/splat.ply        normalized 3DGS splat, optional (kept in the format; the v1 planner draws GLB only)
library/<id>/thumb.jpg        square thumbnail, optional
library/<id>/source.<ext>     the input image or model, as given (camera metadata included: never served)
library/<id>/raw/             untouched engine outputs (debugging only, never served)
library/.trash/<id>-<stamp>/  deleted items (§2.8), never served
scenes/<name>/...             one scene per uploaded photo (§4.2)
scenes/.trash/<name>-<stamp>/ deleted scenes, with their layouts and trash.json {name, title, deleted}
layouts/<scene>/<layout>.json a scene's layouts (layout.schema.json)
layouts/<scene>/.trash/<layout>-<stamp>.json  deleted layouts
renders/<name>.jpg ...        renders (§2.6, §4.7)
```

`scenes/`, `layouts/`, `renders/` and `library/<id>/` are user data and git-ignored.

### Normalized assets

Both `model.glb` and `splat.ply` are stored **already in the item frame**: no runtime transform is needed beyond the item's placement.

- **`model.glb`**: axis-aligned bounds have footprint center at x = z = 0 (±1 cm), min y = 0 (±0.5 cm), and size equal to `dims_cm` within **2 % per axis** (X = w, Y = h, Z = d). Materials and textures from the source are preserved.
- **`splat.ply`**: standard 3DGS PLY, fitted with a **uniform** scale that matches height (1st–99th percentile of positions: height within 5 % of `dims_cm.h`, min y within ±3 cm of 0, footprint center within 5 cm of the origin).

---

## 2. Planner (carried from nook)

A static web app in `planner/` (three.js `0.180.0` via importmap, no build step) plus `planner/serve.py` (Python stdlib only). Sections 2.1–2.10 keep nook's numbering, which the code's comments cite. What's new for scenes is in §4.

> **State since the integration commit:** `planner/` implements §4 (scenes, the locked photo camera, occlusion, Adjust floor, keep-room renders, Compare); rooms, splats, Spark, the shell, hanging, retrain and `--scan-api` are gone.

### 2.1 Server

```
python3 planner/serve.py [--port 8765] [--host 127.0.0.1] [--library-dir library] [--costs-file library/costs.csv]
                         [--layouts-dir layouts] [--renders-dir renders] [--scenes-dir scenes]
                         [--calib "uv run --project calib midstudy-calib"] [--midstudy-add "uv run --project pipeline midstudy-add"]
                         [--daily-spend-usd 2] [--allowed-host NAME ...]
```

- Serves the planner at `/planner/`; `GET /` redirects there. Static files get correct MIME types, `X-Content-Type-Options: nosniff` and no caching. **Static is an allowlist:** `/planner/…` (the app's own files), `/library/…` (§2.8), `/scenes/…` (§4.4) and `/renders/…`; every other path is `404`, whatever its spelling or case. (The repo also holds the user's photos, camera originals dropped at the root with or without an extension, scratch scenes and the tracked `costs.csv`, and APFS is case-insensitive.)
- All `/api` responses are JSON (errors are `{"error": "<one sentence>"}`).
- Removed from nook: `/api/room`, `/api/rooms*`, `--room-file`, `--room-dir`, `--scan-api` and `/api/scan/*`, flat (scene-less) layouts.
- Evals and agents always start it with `MIDSTUDY_NO_DOTENV=1`, `MIDSTUDY_FAL_MOCK=fixtures/fal` and `--daily-spend-usd 0` (§5.3).

### 2.2 URL parameters

- `?library=<url>`: library to load (default `/library/library.json`). Asset paths resolve relative to it. A missing library is an empty library, not an error.
- `?scene=<name>`: the scene to open (§4.5).

### 2.3 Features carried from nook

- **Library panel:** lists items (thumbnail, name, W×D×H cm); a tap adds the item to the scene (§4.5 says where). The library manager (§2.8) adds, edits, removes and restores items. An item with a GLB and no thumbnail (an add from a 3D file: midstudy-add makes thumbnails from photos only) gets one from the planner: a 256 px render of the model, stored with `PUT /api/library/items/<id>/thumb` (§2.8), one item at a time, only for the server's own `/library/library.json`.
- **Items:** select by tap; drag moves the selected item on the floor plane at its own elevation; a grip on its footprint rotates it around Y only, as do −15°/+15° buttons. Keyboard: `R` rotates 15°, `Delete`/`Backspace` removes (with undo), `Esc` deselects. The selected item shows its name and W×D×H cm. Contact shadows follow every item on the floor.
- **Layouts:** save / load / delete / switch, with unsaved-change warnings (§2.7).
- **Errors:** anything that fails shows a small non-blocking message and is pushed to `window.midstudy.errors`. Nothing throws an uncaught exception.
- **Desktop and phone:** usable at 1280 × 800 (panels collapse, cover at most a third of the view) and at 390 × 844 with touch only (bottom sheets, every action has a touch control, targets ≥ 44 px, no horizontal page scroll).

### 2.4 `window.midstudy` test hook (carried part)

Exposed once the module has loaded. Every method that loads something returns a Promise that resolves **after** it has loaded (rejects on failure). §4.6 adds the scene methods.

```ts
interface Midstudy {
  ready: Promise<void>                       // first page state settled (a scene opened, or the Scenes page shown)
  errors: string[]
  getLibrary(): LibraryItem[]                // items from library.json, as-is
  addItem(id: string, opts?: { position?: [x, y, z], rotation_y_deg?: number }): Promise<string>  // resolves with a new uid
  moveItem(uid: string, opts: { position?: [x, y, z], rotation_y_deg?: number }): void
  selectItem(uid: string | null): void       // as a tap on the item; null clears the selection
  removeItem(uid: string): void
  clearItems(): void
  saveLayout(name: string, opts?: { title?: string }): Promise<void>  // PUT /api/layouts/<name>?scene=<open scene>; title: the name as typed
  loadLayout(name: string): Promise<void>    // replaces the current items
  listLayouts(): Promise<string[]>
  getState(): State                          // §4.6
  getRenderSettings(): { toneMapping: 'aces', exposure: number, warmth: number, contactShadows: boolean, shadowCount: number }
  setRenderSettings(s: Partial<{ exposure: number, warmth: number, contactShadows: boolean }>): void  // live; saved with the scene
  renderView(opts?): Promise<RenderMeta>     // §4.7; no confirmation dialog from the hook
  listRenders(): Promise<RenderMeta[]>       // newest first; §4.7 adds ?scene=
  libraryJobs(): Promise<LibraryJob[]>
  addItemFromFile(file: File, meta: Meta): Promise<LibraryJob>
  addItemFromUrl(url: string, meta: Meta): Promise<LibraryJob>
  editLibraryItem(id: string, patch: object): Promise<Item | LibraryJob>
  removeLibraryItem(id: string): Promise<void>
  restoreLibraryItem(id: string): Promise<Item>
}
```

`position[1]` is the item's **elevation**: the height of its bottom above the floor, in meters, clamped to 0–4 (§2.10). Removed from nook's hook: `loadRoom`, `setView`, `gotoViewpoint`, `relight`, `setTrueColor`, `listRooms`, `openRoom`, `saveRoom`, `setShell`, `hangItem`, `retrainDefaults`, `retrainRoom`.

### 2.5 Acceptance carried from nook (checked by the §6.2 evals in PLAN.md)

- An added item's `worldBounds` size matches its `dims_cm` within 2 %, with min y = elevation (±1 cm). Rotating 90° swaps the X and Z extents. Rotation is around Y only.
- Layouts round-trip: positions within 1 mm, rotation within 0.1°.
- No uncaught exceptions or console errors in normal use with the fixtures. A missing or corrupt asset shows an error and the rest keeps working.

### 2.6 Render API (carried; §4.7 adds the scene reference and keep-room)

- `POST /api/render` with `{ "image": "data:image/jpeg;base64,...", "model"?: "kontext" | "nano-banana" | "qwen", "prompt"?: string, "layout"?: string, ...§4.7 }`:
  - Calls fal synchronously (`https://fal.run/<endpoint>`, `Authorization: Key $FAL_KEY`) with the image as a data URI. FAL_KEY comes from the environment or `.env`, same rules as the pipeline (§3.3, including `MIDSTUDY_NO_DOTENV`). The key never reaches the browser.
  - The image is used without the metadata it may carry (APP1–APP15, comments, anything after EOI are dropped, and APP0 is kept only as a plain 16-byte JFIF header: a JFIF thumbnail or a JFXX extension, which can hold a whole JPEG with its own EXIF and GPS, is dropped; the image data is not re-encoded): that is what is saved, served and sent to fal. The same holds for `PUT /api/scenes/<name>/thumb` and `PUT /api/library/items/<id>/thumb`.
  - The image's size must be readable from its frame header (fill bytes and the length-less markers TEM and RST0–7 are stepped over): qwen is priced by it, so a composite whose size can't be read is `400`, never guessed.
  - Saves `<renders>/<name>.jpg` (the result), `<name>-input.jpg` and `<name>.json` (metadata). `<name>` is `render-YYYYMMDD-HHMMSS` (UTC), numeric suffix on collision.
  - Appends a cost row (`engine` = `render:<model>`), even if the download after a billed call fails.
  - `200` with the metadata: `{ name, url, input_url, model, endpoint, cost_usd, mock, prompt, created, layout, width, height, ...§4.7 }`. URLs are site paths (`/renders/<name>.jpg`); renders are served statically.
  - Errors: `400` bad image or unknown model, `503 {"error": "FAL_KEY not set: add FAL_KEY=... to midstudy/.env"}` without a key outside mock mode, `502` when fal fails, `402` over the spend cap (§2.9).
- `GET /api/renders` → `{ "renders": [metadata, ...] }`, newest first.
- **Mock** (`MIDSTUDY_FAL_MOCK` set): no network calls; the result is a copy of the input, `mock: true`, `cost_usd: 0` (its real price with `MIDSTUDY_FAL_MOCK_COST=1`, evals only).

| model | fal endpoint | arguments | cost recorded |
|---|---|---|---|
| `kontext` | `fal-ai/flux-pro/kontext` | `image_url`, `prompt`, `output_format: "jpeg"` | $0.04 |
| `nano-banana` (default) | `fal-ai/nano-banana/edit` | `image_urls`, `prompt`, `output_format: "jpeg"` | $0.0398 |
| `qwen` | `fal-ai/qwen-image-edit` | `image_url`, `prompt`, `output_format: "jpeg"` | $0.03 × megapixels of the input |

### 2.7 Layouts (per scene)

| Method and path | Response |
|---|---|
| `GET /api/layouts?scene=<name>` | `200 {"layouts": ["name", ...], "details": [{"name", "items", "updated"}]}`, sorted by name |
| `GET /api/layouts/<layout>?scene=<name>` | `200` the layout, `404` when absent |
| `PUT /api/layouts/<layout>?scene=<name>` | Writes `layouts/<scene>/<layout>.json` (layout.schema.json); the server sets `scene_name` and `updated`. `200` the stored layout |
| `DELETE /api/layouts/<layout>?scene=<name>` | `200 {"ok": true, "trash"}`: the file moves to `layouts/<scene>/.trash/<layout>-<UTC stamp>.json` (never listed); `404` when absent |

The planner's Undo of a delete PUTs the layout back as it read it first. A layout may carry `title`, the name as the user typed it ("Phone A", at most 120 characters; `400` otherwise), shown instead of the slug; `details` list it.

`<layout>` must be a slug (`400` otherwise; a slug never ends in a newline: every slug check matches the whole string). `scene` is required (`400` without it) and must name an existing scene (`404`). A layout saved in one scene is never listed in another. Layout items carry `dims_cm`, so a layout placing a deleted library item still loads with a "missing item" placeholder box at those dims (or 50 cm cubed).

### 2.8 Library API (carried from nook v4)

Library writes go to `--library-dir` (default `library/`). The server runs `--midstudy-add CMD` (default `uv run --project pipeline midstudy-add`) with `--library <library-dir>`.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/library` | | `200` the `library.json` (empty `items` when there's none), plus `"trash": [{id, name, deleted}]` |
| `POST /api/library/items` | **Raw body**, `Content-Length` required. Headers: `X-Midstudy-Kind: model \| image`, `X-Midstudy-Filename: <name.ext>`, `X-Midstudy-Meta: <base64 of JSON meta>` | `202 {job, cost_usd_estimate}` |
| `POST /api/library/items/from-url` | JSON `{image_url, ...meta}` | `202 {job, cost_usd_estimate}` |
| `GET /api/library/jobs` | | `200 {"jobs": [job, ...]}`, newest first |
| `GET /api/library/jobs/<id>` | | `200` the job object itself, or `404` |
| `PATCH /api/library/items/<id>` | any of `name`, `category`, `mount`, `yaw` (0/90/180/270, relative), `default_render`, `dims_cm` | `200` the item, or `202 {job}` when `dims_cm` or `yaw` changed |
| `DELETE /api/library/items/<id>` | | `200 {"ok": true}`: entry and folder move to `library/.trash/<id>-<UTC stamp>/` |
| `POST /api/library/items/<id>/restore` | | `200` the item (newest trashed copy), `404` when none, `409` when the id exists again |
| `PUT /api/library/items/<id>/thumb` | `{"image": "data:image/jpeg;base64,…"}` ≤ 2 MB (the planner's render of the model) | `200` the item: `<id>/thumb.jpg` written without metadata (§2.6), `assets.thumb` set; `404` unknown id, `400` not a JPEG, `413` over 2 MB, `503` while a job holds the library |

**Meta:** `name` and `dims_cm` `{w,d,h}` required; `id` (default: slug of `name`), `category`, `mount`, `yaw`, `engine` (`sam3d` \| `trellis2` for images; `glb` for models), `prompt`, `resolution`. Anything wrong is `400` with one actionable sentence.

**Bodies:** `model` is a `.glb`, or a `.zip` holding one `.obj` with its `.mtl` and textures (`.usdz`: "convert to GLB first"); `image` is a JPEG, PNG, HEIC or WebP. **Limits:** models 200 MB, images 20 MB (`413`), `411` without a length. Zips: only `.obj .mtl .png .jpg .jpeg` extracted; no absolute paths, `..` or links; at most 500 MB unpacked and 1,000 entries. Uploads land in a private temp folder, never under a served path.

**Jobs:** one queue, one job at a time, in memory (a restart forgets them). Job object: `{id: "l-…", kind: "add" | "rescale", item_id, status: "queued" | "running" | "done" | "failed", engine, cost_usd_estimate, cost_usd, mock, created, started, finished, message, item}`. A failed job's `message` is `midstudy-add`'s stderr line. Re-adding an id replaces it (upsert) and says so.

**One writer:** every library write takes `<library>/.lock` (`flock`); PATCH, DELETE and restore wait up to 60 s for a running job, then answer `503`.

**What `/library/` serves:** item assets (`<id>/model.glb`, `splat.ply`, `thumb.jpg`) and `library.json` (an empty library, `{"version": 1, "items": []}`, while the folder has none yet). `source.<ext>` (the upload as given: a phone photo's EXIF and GPS), `raw/`, `.trash/`, `.lock` and `costs.csv` get `404`.

**Privacy:** what an image engine uploads to fal is `raw/engine-input.jpg` (or `.png` with transparency), a copy made by `midstudy-add`: EXIF orientation applied, no EXIF, GPS, XMP, IPTC or comments (the ICC profile stays). `source.<ext>` keeps the original and is never served. A model's embedded textures lose their camera metadata in `model.glb` (JPEG: APP1–APP15, comments, JFIF thumbnails and JFXX, anything after EOI; PNG: `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`), the image data kept as it is: a user's own GLB can embed a geotagged photo, and `model.glb` is served.

Acceptance (`npm run eval:library`): L8 mock adds of a `.glb`, an OBJ zip, a photo and a URL end `done` and the library validates; L9 delete then restore round-trips byte for byte; L10 bad zips are refused with nothing written; L11 `PATCH dims_cm` refits at $0.

### 2.9 Mutating requests and money (carried)

These rules apply to every `POST`, `PUT`, `PATCH` and `DELETE` that `serve.py` answers, including the scene routes (§4.4), layouts and `/api/render`.

- **Forged requests:** a mutating request needs `X-Midstudy: 1` and an `Origin` that is absent or equal to the page's own origin. Otherwise `403 {"error": "cross-site request refused"}` and nothing changes.
- **Host names:** every request must carry a loopback `Host` (`127.0.0.1`, `localhost`, `[::1]`, any port) or one given with `--allowed-host`, exactly `name[:port]` (`127.0.0.1:80@evil.example` and `[::1]evil.example` don't pass); otherwise `403`, also for a request with no `Host`. An `--allowed-host` that isn't `name[:port]` (a URL, say) is refused at startup.
- **Framing:** more than one `Content-Length` header is `400`, and so is one that isn't ASCII digits. A `411` or `413` is sent before reading the body (then a drain of at most 5 s, even for a client that sends nothing, and the connection closes); a body that stops arriving is dropped after 30 s with `408` and one sentence (`MIDSTUDY_SOCKET_TIMEOUT`, evals only, shortens the 30 s).
- **Paths:** static paths are normalized (percent-decoding, `.` and `..`) **before** any rule about what is served, so `/./library/costs.csv` gets the same `404` as the plain path. The same holds for `/scenes/`.
- **Spend cap:** `--daily-spend-usd N` (default `2`; a flag only, no route changes it) covers every paid call: library adds and `/api/render`. It reads `<library-dir>/costs.csv`, the file `midstudy-add` writes, so a `--costs-file` that isn't that file is refused at startup. A call that costs more than the whole cap gets a `402` that says so. Before a paid call the server reserves the estimate against today's (UTC) total from `costs.csv`; a request that would cross the cap gets `402 {"error", "spent_usd", "cap_usd"}` and no call is made. Mock calls cost $0 and count for nothing (unless `MIDSTUDY_FAL_MOCK_COST=1`). `GET /api/spend` → `{"day", "spent_usd", "reserved_usd", "cap_usd"}`. Cost rows are appended under `costs.csv.lock`.
- **URL fetches** (from-URL add): the server downloads the image itself (http/https only, host resolved once and pinned, every redirect re-checked, at most 3, 20 s, 20 MB, `image/*` only). Private, loopback, link-local, CGNAT, tailnet and multicast addresses (and their IPv4-mapped forms) are refused with `400`. `MIDSTUDY_FETCH_ALLOW=<host>:<port>` (evals only) exempts exactly one address.

Acceptance: W1 forged mutations get `403` everywhere; W2 with `--daily-spend-usd 0.03` and `MIDSTUDY_FAL_MOCK_COST=1`, the second $0.02 add is `402`; W3 private URLs are refused without a connection; W4 `/library/costs.csv`, `.trash/`, `raw/` and `source.*` are `404`, in any case or spelling.

### 2.10 Elevation (carried; wall hanging dropped)

A placed item's `position[1]` is its bottom's height above the floor, 0–4 m (clamped). Desktop: `Shift`+drag or `PageUp`/`PageDown` (1 cm, 10 cm with `Shift`). Phone: an **Up / Down** control (drag handle, `+`/`−` buttons of 1 cm that repeat when held, the height in cm, editable). A raised item (bottom > 2 cm up) drops its contact shadow and shows a faint guide line to the floor while selected. **Drop to floor** puts it back at 0. Handles: `elev-up`, `elev-down`, `elev-value`, `drop`. Library items may still carry `mount: "wall"`; v1 places them on the floor like any other item.

---

## 3. Pipeline (carried)

A uv project in `pipeline/` (Python 3.12), console script `midstudy-add`, package `midstudy_pipeline`. No feature work in v1.

### 3.1 CLI

```
uv run --project pipeline midstudy-add INPUT --name NAME --dims WxDxH
    [--id SLUG] [--category TEXT] [--engine sam3d|trellis2|glb] [--prompt TEXT]
    [--yaw 0|90|180|270] [--resolution 512|1024|1536] [--library DIR] [--notes TEXT] [--mount floor|wall]
uv run --project pipeline midstudy-add --rescale ID [--dims WxDxH] [--yaw 0|90|180|270] [--library DIR]
```

- `INPUT`: a local image or image URL (`sam3d`, `trellis2`), a `.glb`/`.gltf`, or an OBJ `.zip` (`glb`). `.usdz` fails with "convert to GLB first".
- `--dims`: centimeters `W x D x H` (`x` or `×`, spaces and decimals allowed). Required for adds.
- `--id` defaults to a slug of `--name`; re-running an id **replaces** it (upsert) and says so. `--engine` defaults to `sam3d`.
- Image engines get a metadata-free, upright copy of the photo (`raw/engine-input.<ext>`, §2.8 Privacy); `source.<ext>` keeps the input as given.
- `--yaw`: extra rotation around Y after the engine's default orientation; positive is counterclockwise seen from above, so `--yaw 90` turns +X into −Z. The planner's `rotation_y_deg` uses the same sign.
- `--rescale ID` refits an existing item from its normalized assets: no model call, `cost_usd: 0`, no cost row.
- Exit 0 on success; the **last line of stdout** is one JSON object `{"id", "engine", "cost_usd", "mock", "paths", "fit"}`. Every failure exits non-zero with **one actionable line on stderr** prefixed `midstudy-add: `.

### 3.2 Engines

| `--engine` | fal endpoint | arguments | cost recorded |
|---|---|---|---|
| `sam3d` (default) | `fal-ai/sam-3/3d-objects` | `image_url`, `prompt`, `export_textured_glb: true` | $0.02 |
| `trellis2` | `fal-ai/trellis-2` | `image_url`, `resolution` | $0.25 / $0.30 / $0.35 for 512 / 1024 / 1536 |
| `glb` | none | | $0.00 |

The engines' frames are in `fixtures/fal/NOTES.md`.

### 3.3 Credentials and mock mode

- `FAL_KEY` from the environment, else from `.env` at the repo root, unless `MIDSTUDY_NO_DOTENV=1`.
- **`MIDSTUDY_FAL_MOCK=<dir>`**: no network calls to fal. Each call returns `<dir>/<slug>/response.json` (`sam-3-3d-objects`, `trellis-2`), file URLs resolve to `<dir>/<slug>/files/<basename>`. Mock runs record `mock: true`, `cost_usd: 0`; `FAL_KEY` isn't needed. `MIDSTUDY_FAL_MOCK_COST=1` (evals only) records the real price instead.

### 3.4 Normalization, library entry, acceptance

Orientation from NOTES.md, then `--yaw`; translate to the footprint center and min y = 0; scale (GLB per axis, splat uniformly); write; self-check (§1) and refuse to upsert a bad item. The entry has `id, name, category, dims_cm, assets, default_render, source {engine, input, prompt, cost_usd, mock, created}, fit`; then a cost row; writes are atomic; every write takes `<library>/.lock`. `npm run eval:pipeline` (L1–L7 and the v4 additions) must pass.

---

## 4. midstudy: scenes, camera, calibration, server, planner, hook, render

### 4.1 Camera model and world frame

- World: meters, right-handed, **Y-up**, the floor is the plane **y = 0**. The camera stands at x = z = 0 and looks along −Z (yaw is always 0).
- The scene camera is a three.js `PerspectiveCamera(fov_y_deg, w / h, near, far)` at `(0, height_m, 0)` with `camera.rotation.set(pitch, 0, roll, 'YXZ')` in radians. The principal point is the image center in v1 (`calib.json` records MoGe's, unused).
- **The camera block**, the same object in every file and API:

```json
{ "fov_y_deg": 55.0, "height_m": 1.40, "pitch_deg": -12.0, "roll_deg": 0.0 }
```

Ranges (every writer clamps): `fov_y_deg` 20–110, `height_m` 0.2–3.0, `pitch_deg` −80…+30, `roll_deg` −20…+20. The default camera (no calibration) is `{55, 1.40, −10, 0}`.

**Projection, exactly** (the golden scenes check this against three.js renders, §5.1):

```
R      = Ry(0) · Rx(pitch) · Rz(roll)          camera-to-world rotation (three.js Euler order 'YXZ')
           Rx(a) = [[1,0,0],[0,cos a,−sin a],[0,sin a,cos a]]     Rz(b) = [[cos b,−sin b,0],[sin b,cos b,0],[0,0,1]]
p_c    = Rᵀ · (p − (0, height_m, 0))           camera coordinates: x right, y up, looking along −z
d      = −p_c.z                                depth along the view axis (what depth.png stores), > 0 in front
f      = (H / 2) / tan(fov_y / 2)              focal length in pixels, square pixels (W, H = photo size)
px     = W / 2 + f · p_c.x / d
py     = H / 2 − f · p_c.y / d
```

Pixel coordinates are continuous, with (0, 0) at the **top-left corner** of the top-left pixel, x to the right and y **down**; pixel (i, j) covers [i, i+1) × [j, j+1) and its center is (i + 0.5, j + 0.5). "Photo pixels" in the hook mean these coordinates on `photo.jpg` at its full size.

**Signs:** negative pitch looks down: with roll 0 the horizon is the row `py = H/2 − f · tan(−pitch)`, above the center. Positive roll turns the camera counterclockwise as seen from behind it, so the horizon **falls to the right** in the photo (its right end is lower). Positive `rotation_y_deg` on an item is counterclockwise seen from above (+X turns toward −Z).

**Inverse (photo → floor):** the ray through photo pixel (px, py) has camera direction `((px − W/2) / f, −(py − H/2) / f, −1)` and world direction `R · that`. If its world y component is ≥ 0 the pixel is at or above the horizon (no floor point: `null`); else the floor point is `C + t · dir` with `t = −height_m / dir.y`.

**Zoom and pan** are 2D only: `camera.setViewOffset` crops the same projection; they never change the camera block, and photo-pixel coordinates are unaffected.

### 4.2 Scenes on disk

```
scenes/<name>/source.<ext>   the upload as given (jpg, png, heic or webp, from its bytes): never served
scenes/<name>/photo.jpg      normalized: EXIF orientation applied, sRGB JPEG q92, long side ≤ 2048 px, no metadata
scenes/<name>/calib.json     the automatic calibration (calib.schema.json), written by midstudy-calib
scenes/<name>/depth.png      optional: 16-bit grayscale PNG, mm along the view axis (§4.1's d), long side ≤ 1024 px,
                             same aspect as photo.jpg; 0 = no occluder (the floor, below the floor, sky, unknown: §4.3 Fit)
scenes/<name>/scene.json     scene.schema.json: version, title, created, saved, camera (in use), camera_source, look, upload
scenes/<name>/thumb.jpg      thumbnail (made by the planner)
scenes/.trash/<name>-<UTC stamp>/          a deleted scene; its layouts move inside it as layouts/
layouts/<name>/<layout>.json               the scene's layouts (layout.schema.json, scene_name = <name>)
renders/<render>.jpg, -input.jpg, .json, optional -raw.jpg   (§4.7)
```

- `<name>` is `scene-YYYYMMDD-HHMMSS` (UTC of the upload), with `-2`, `-3`… on collision. It's a slug and never changes; `title` is free text.
- `depth.png` pixel (i, j) holds the depth at the center of the photo region it covers: the depth map is the same projection at a smaller size (`f` scales with H). Upsampling to the photo's size uses nearest or bilinear lookup on these centers.
- `camera_source`: `auto` (copied from `calib.json` by the last successful calibration), `manual` (the user changed it in Adjust floor), `default` (no calibration result yet, or it failed).
- `calib.json` `source` (what the calibration was based on) is independent of `camera_source`: a fallback calibration (`exif`, `default`, or `floor.found: false`) still sets `camera_source: auto`, and the planner flags it (§4.5).

`calib.json` (calib.schema.json):

```json
{ "version": 1,
  "source": "moge-2" | "exif" | "default" | "truth",
  "model": "Ruicheng/moge-2-vitl-normal" | null,
  "image": { "w": 2048, "h": 1536 },
  "camera": { …camera block… },
  "principal": [0.5, 0.5],
  "floor": { "found": true, "inlier_ratio": 0.31, "rmse_m": 0.012 },
  "depth": { "file": "depth.png", "w": 1024, "h": 768, "floor_masked": true } | null,
  "exif": { "focal_35mm": 26, "fov_y_deg": 51.2, "make": "Apple", "model": "iPhone 18 Pro" } | null,
  "fov_disagreement": { "moge_deg": 61.0, "exif_deg": 69.6 },        // only when they differ by more than 8°
  "fov_source": "exif" | "moge",                                      // whose FOV the camera uses (§4.3 Fit)
  "moge": { "fov_y_deg": 72.75, "height_m": 1.352, "scale": 1.059, "depth_scale": 1.107, … },  // MoGe's own, and the correction
  "device": "mps" | "cuda" | "cpu" | null, "elapsed_s": 6.2 }
```

`"truth"` is used only by the golden scenes (§5.1).

### 4.3 Calibration (`calib/`, console script `midstudy-calib`)

A uv project (Python 3.12) with Pillow, pillow-heif, numpy, torch, opencv-python-headless and MoGe-2 (`git+https://github.com/microsoft/MoGe` pinned to a commit). Weights come from Hugging Face on first use, cached outside the repo.

```
midstudy-calib run <upload> --out <scene-dir> [--model vitl|vitb|vits] [--device auto|cuda|mps|cpu] [--no-depth]
midstudy-calib ingest <upload> --out <scene-dir>        # photo.jpg + source.<ext> only
midstudy-calib fit <scene-dir> [--model ...] [--device ...] [--no-depth]   # calib.json (+ depth.png) from photo.jpg
midstudy-calib align <photo.jpg> <raw.jpg> <mask.png> --out <final.jpg>   # keep-room composite (§4.7)
```

**Output contract (all commands):** progress goes to stderr. The **last stdout line** is one JSON object:

| command | success (exit 0) |
|---|---|
| `run`, `fit` | the `calib.json` contents plus `"ok": true` |
| `ingest` | `{"ok": true, "photo": "photo.jpg", "source": "source.<ext>", "image": {"w", "h"}}` |
| `align` | `{"ok": true, "applied": bool, "inliers": int, "residual_px": number \| null, "reason"?: string}` |

A failure exits **1** with `{"ok": false, "error": "<one sentence>"}` as the last stdout line and `midstudy-calib: <the same sentence>` as the last stderr line. The server shows that sentence. A fallback calibration is a success (exit 0).

**Files:** `--out` may already exist (the server creates the scene folder first). The tool writes only `source.<ext>`, `photo.jpg`, `calib.json` and `depth.png` there, each atomically (temp file + rename), and never touches `scene.json`, `thumb.jpg` or anything else. `fit` without depth removes a stale `depth.png`. `run` writes `photo.jpg` before it starts the model, so the planner can show the photo while it calibrates.

**Ingest:**
- Accepts JPEG, PNG, HEIC/HEIF and WebP up to 25 MB, recognized by their bytes, not the name (anything else: exit 1, "that file isn't a JPEG, PNG, HEIC or WebP image").
- Applies the EXIF orientation, converts to sRGB with the embedded ICC profile (iPhones write Display P3), downsizes to a 2048 px long side, writes `photo.jpg` (q92) with **no metadata at all** (no EXIF, GPS, XMP, ICC, comments): it is served and sent to fal. `source.<ext>` keeps the original bytes and is never served.
- **Pass-through:** a JPEG that needs none of that (APP0 only as plain 16-byte JFIF headers, without a thumbnail or a JFXX extension; no EXIF/XMP/ICC/comment **anywhere in the file**, including between progressive scans, **not one byte after its end-of-image marker**: no appended second image, no padding, long side ≤ 2048) is copied **byte for byte**, so `photo.jpg`'s SHA-256 equals the upload's. Anything else is re-encoded. The golden scenes rely on this for the mock (§5.1).

**EXIF FOV:** read from `source.<ext>` (EXIF `FocalLengthIn35mmFilm`, plus make and model). The 35 mm equivalent refers to the diagonal of the sensor's native **4:3** frame (the full-frame diagonal, 43.27 mm, so a 34.61 × 25.96 mm frame). The photo is the largest crop of that frame with the photo's aspect: wider than 4:3 (16:9) keeps the long side, squarer keeps the short side. The vertical FOV is `2 · atan(v_mm / (2 · f35))` with `v_mm` the crop's extent along the photo's vertical axis. For `fixtures/photos/upper-lounge-camera.jpeg` (14 mm, 16:9 landscape) that is 102.1° horizontal and 69.6° vertical. When MoGe runs and the EXIF FOV is within 8° of MoGe's, the camera uses the EXIF FOV and MoGe's scale is corrected (Fit, below; `fov_source: "exif"`); otherwise MoGe's FOV is used (`fov_source: "moge"`) and a difference over 8° adds `fov_disagreement` (a cropped or edited photo keeps the lens's focal length, so its EXIF FOV is wrong).

**Fit:** MoGe-2 gives a metric point map, normals and intrinsics. Fit the floor with RANSAC over points whose normal points up relative to the camera and that lie below it; prefer the largest such plane in the lower part of the image (beware reflective floors and floors seen through glass: the real lounge photo has both). The plane gives `height_m`, `pitch_deg`, `roll_deg` (in §4.1's convention: the camera is re-expressed so the floor normal is world +Y and yaw is 0); the intrinsics give `fov_y_deg`. **With a known FOV** (EXIF, as above): MoGe-2's FOV runs wide (3.6–7.5° on the golden renders, 3.1° over EXIF on the lounge photo) and its metric scale is short by about the same focal ratio, while its pitch and roll are right. So the camera takes the EXIF FOV, MoGe's pitch and roll, and `height_m × k` with `k = tan(fov_moge / 2) / tan(fov_exif / 2)`; `depth.png` is MoGe's depth times the median ratio, over MoGe's floor pixels, between that camera's floor depth and MoGe's own, so the depth agrees with the floor the planner draws. Measured on the golden scenes with their true FOV given as EXIF: height within 2 %, depth within 5 %, furniture drawn within 3 % of its size (MoGe's own FOV: 7–10 % too big). `depth.png` holds MoGe's depth along the view axis with floor pixels set to 0: at least those within 4 cm of the plane (the tool uses max(4 cm, 1.2 % of the depth), as MoGe is noisier far away), plus every pixel below the plane (reflections in a shiny floor, a lower floor seen through glass), which could never hide anything standing on the floor. With no floor found, `depth.png` is MoGe's depth unmasked (`floor_masked: false`). `inlier_ratio` is the share of image pixels on the plane.

**Fallbacks:** no floor → `floor.found: false`, MoGe's FOV, height 1.40, pitch −10, roll 0. MoGe unavailable or failed → `source: "exif"` (FOV from EXIF) or `"default"` (FOV 55), height 1.40, pitch −10, `depth: null`.

**Device:** `auto` picks cuda, then mps (with `PYTORCH_ENABLE_MPS_FALLBACK=1`), then cpu.

**Align** (opencv-python-headless): resize the model output to the photo's size, estimate a homography from the output to the photo from features outside the mask (ORB + RANSAC, or ECC), warp, composite `photo × (1 − mask) + warped × mask` with the mask feathered, write `<final.jpg>`. Fewer than 40 inliers or a median residual over 3 px: write nothing, `applied: false` with a `reason`, exit 0. Always runs for real (an identical image is the identity and must apply).

**Mock:** with `MIDSTUDY_CALIB_MOCK=<dir>` (e.g. `fixtures/calib`), `fit` never loads MoGe: it looks up `<dir>/<sha256 of photo.jpg>/`, then `<dir>/<sha256 of source.<ext>>/`, and copies that `calib.json` and `depth.png`; with no match it writes the `default` fallback. `ingest` and `align` still run for real.

**Stub:** `fixtures/stub_calib.py` (stdlib only) has the same CLI and output contract for development and fast evals: JPEG only, strips metadata without re-encoding (can't rotate, resize or convert colour), mock or `default` fit, and `align` answers `applied: false`. Run the server with `--calib "python3 fixtures/stub_calib.py"`.

### 4.4 Server additions (`planner/serve.py`, stdlib only)

`--scenes-dir` (default `scenes/`) and `--calib CMD` (default `uv run --project calib midstudy-calib`; the Nix package passes its own binary). Calibration runs as jobs in **their own queue** (separate from the library queue), one at a time, each with a 600 s timeout, with the server's environment (so `MIDSTUDY_CALIB_MOCK` reaches it). Every mutating route follows §2.9.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/scenes` | | `200 {"scenes": [scene, ...], "trash": [{name, title, created, deleted}, ...]}`, newest first (by `created`, ties by the name's collision suffix as a number: `-10` before `-9`); `trash` lists the deleted scenes |
| `POST /api/scenes` | raw photo body, `Content-Length` required, `X-Midstudy-Filename` required, optional `X-Midstudy-Meta` (base64 JSON `{title}`) | `202 {job, scene: name}` |
| `GET /api/scenes/jobs` | | `200 {"jobs": [job, ...]}`, newest first |
| `GET /api/scenes/jobs/<id>` | | `200` the job object itself, `404` unknown |
| `GET /api/scenes/<name>` | | `200` scene.json + the scene object's fields + `calib` (calib.json without `exif.make`/`exif.model`, or null); `404` unknown |
| `PUT /api/scenes/<name>` | JSON with any of `title`, `camera`, `camera_source`, `look` | `200` as GET; `saved` stamped unless only `title` changed; camera values clamped; unknown keys or bad values `400` |
| `PUT /api/scenes/<name>/thumb` | `{"image": "data:image/jpeg;base64,…"}` ≤ 2 MB | `200 {"ok": true, "thumb_url"}` |
| `POST /api/scenes/<name>/calibrate` | | `202 {job}`: runs `fit` (or `run` on `source.<ext>` when `photo.jpg` is missing); `409` while one is queued or running for that scene |
| `DELETE /api/scenes/<name>` | | `200 {"ok": true, "trash": "scenes/.trash/<name>-<stamp>"}`: the folder and `layouts/<name>/` move there; a queued job for it is dropped, a running one's result is ignored |
| `POST /api/scenes/<name>/restore` | | `200` the scene object: the newest trashed copy and its layouts move back (its renders show again); `404` none in the trash, `409` a scene (or layouts) by that name exists |
| layouts | | §2.7 (`?scene=`) |

**Upload** (`POST /api/scenes`): `411` without `Content-Length`, `413` over 25 MB, `400` with one sentence when the body isn't a JPEG, PNG, HEIC or WebP (sniffed from its bytes). The body goes to a private temp file, never under a served path. The server then creates `scenes/<name>/scene.json` (`title` from the meta or null, `created` now, `saved` null, the default camera, `camera_source: "default"`, `upload: {filename, ext, bytes}`), queues `<calib> run <temp file> --out scenes/<name>` and answers `202`. The scene exists (and is listed, `calib_status: "pending"`) from that moment.

**When a calibration job ends:** on success, if the scene's `camera_source` is `auto` or `default`, its camera becomes `calib.json`'s and `camera_source` becomes `auto` (a `manual` camera is never overwritten). On failure the scene keeps its camera and the job's message is the tool's error sentence.

**Job object:** `{ "id": "c-20261104-201500-ab12", "kind": "calibrate", "scene": "<name>", "status": "queued" | "running" | "done" | "failed", "created", "started", "finished", "message": "human-readable status line", "calib": calib.json | null }`. The API never serves the camera's make or model: `calib` (here and in `GET /api/scenes/<name>`) leaves out `exif.make` and `exif.model`, which stay in calib.json on disk. Jobs live in memory; a restart forgets them.

**Scene object** (list and GET):

```json
{ "name": "scene-20261104-201500", "title": "Upper lounge" | null, "created": "<ISO UTC>", "saved": "<ISO UTC>" | null,
  "photo_url": "/scenes/scene-20261104-201500/photo.jpg" | null, "thumb_url": "…/thumb.jpg" | null, "depth_url": "…/depth.png" | null,
  "w": 2048 | null, "h": 1152 | null, "camera_source": "auto", "floor_found": true | null, "layouts": 2,
  "calib_status": "pending" | "running" | "done" | "failed", "calib_error": "<sentence>" | null }
```

`photo_url` is null until `photo.jpg` exists; `w`/`h` are `photo.jpg`'s size. `floor_found` is `calib.json`'s `floor.found` (null without one). `calib_status`: `pending` while a job is queued, `running` while it runs, else `done` when `calib.json` exists and the last job (if any) succeeded, else `failed` (including a calibration lost to a restart). Asset URLs may carry a `?v=<mtime>` cache buster.

**Static:** `/scenes/<name>/photo.jpg`, `depth.png` and `thumb.jpg` are served (`nosniff`). Everything else under `/scenes/` gets `404`: `source.*`, `calib.json` (use the API), `scene.json`, `.trash/`, folder listings, and the same paths spelled with `.`/`..`/percent-encoding (§2.9 Paths).

### 4.5 Planner

- **Scenes page** (replaces Rooms): scene thumbnails, newest first, **New scene** (a file input that accepts camera-roll photos on iOS: `accept="image/*"`), per-scene rename and delete. A scene still calibrating shows its photo (once `photo_url` is set) with a spinner and opens when done. `?scene=<name>` opens a scene; without it, the last scene opened on this device, else the Scenes page.
- **The view:** the photo fills the view, contain-fit with letterbox bars; the 3D canvas is registered to it (same aspect, camera from `scene.json`). The photo is drawn **exactly as is**: no tone mapping, exposure or warmth. Look and ACES apply to the furniture only. Pinch or wheel zoom and two-finger or middle-drag pan are 2D (`setViewOffset`), up to 4×; **Fit** resets them.
- **Floor check:** when a scene first opens, and whenever **Adjust floor** is on, a 50 cm grid is drawn on y = 0 out to 8 m, fading with distance. Adjust floor has sliders for camera height (cm), field of view (°) and roll (°); dragging the horizon line sets the pitch (the line follows the pointer, but at most 0.12° of tilt per CSS pixel on a small photo, so the phone at Fit gets fine control). An optional two-tap ruler shows a floor distance in cm; typing the real length of what it measured (**Set scale**, handles `ruler-true`, `ruler-set`) scales the camera height so it reads that length, which fixes the scene's scale (MoGe's metric scale can be 5–15 % off without an EXIF focal length). While the ruler is on, its row (the instruction, then the length field) keeps one height, so the photo doesn't move between the taps. **Looks right** saves the scene (`camera_source: "manual"` if anything changed). **Reset** goes back to `calib.json`'s camera (`auto`). A scene whose `floor.found` is false or whose `calib.source` isn't `moge-2` (or `truth`) opens in Adjust floor with a one-line note ("Check the floor").
- **Items:** as §2.3 and §2.10. A drag keeps the grabbed point of the piece under the pointer (it slides on the horizontal plane through that point); a mouse or pen press on any piece selects and drags it at once, touch keeps "tap, then drag". A new item lands where the ray through the view center hits the floor (or, if that misses, the ray through the center of the lower third), when that point is 1–6 m from the camera; else 2.5 m straight ahead. Missing library items show a placeholder box.
- **Lighting:** three.js `RoomEnvironment` plus a key light; Look (exposure, warmth) is saved in `scene.json`.
- **Occlusion:** with a `depth.png`, a full-screen pass writes the photo's depth into the depth buffer before the items draw (colour writes off), so an item fragment is hidden where the photo has something nearer, with a 3 cm tolerance. Depth 0 never occludes. **Occlusion** toggle, on by default when the scene has depth. `depth.png` is metric in the calibration's frame, so when the camera's `height_m` differs from `calib.json`'s (Adjust floor), the depth is scaled by `height_m / calib height_m` first; without a measured floor (`floor.found` false, or a fallback source) it is used as it is.
- **Layouts:** per scene (§2.7), with unsaved-change warnings ("unsaved" means the pieces differ from the layout as saved or loaded, so Remove then Undo isn't). A scene opens with a layout: each device remembers the layout it last had open in each scene and when it chose it (saved, loaded, or none after deleting it); the scene reopens with that one, unless a layout was saved later on any device (`updated`), or the device has never had the scene open: then it opens with the most recently saved layout. So a reload keeps this device's choice, and the phone opens a scene with the layout the desktop just saved. Deleting a layout, a scene or a library item can be undone; deleted scenes are listed under Recently deleted on the Scenes page, with Restore.
- **Render and Compare** (§4.7): in the Renders panel, pick two renders for a full-screen compare: side by side on desktop, a draggable split slider on both, swipe on the phone, and Swap A and B on both (`compare-swap`).
- **Removed from nook:** orbit, seated / standing / walk, viewpoints, room alignment and picks, shell, hang on wall, retrain, splat drawing, LoD, True colour, Spark.

### 4.6 Hook additions (`window.midstudy`)

```ts
type Camera = { fov_y_deg: number, height_m: number, pitch_deg: number, roll_deg: number }
type Scene = /* the §4.4 scene object */
listScenes(): Promise<Scene[]>
createScene(file: File, meta?: { title?: string }): Promise<{ job, scene: string }>   // resolves when the upload is accepted (202)
waitForScene(name: string): Promise<Scene>          // resolves when calib_status is done or failed
openScene(name: string): Promise<void>              // resolves when the photo (and depth, if any) are shown
deleteScene(name: string): Promise<void>
getCamera(): Camera
setCamera(partial: Partial<Camera>): void           // live, clamped; doesn't save
resetCamera(): void                                 // back to calib.json's camera
saveScene(): Promise<void>                          // PUT /api/scenes/<name> (camera, camera_source, look, title)
setAdjustFloor(on: boolean): void
setOcclusion(on: boolean): void
getScreenRect(uid: string): { x, y, w, h } | null   // the item's projected bounds in photo pixels (§4.1), not CSS px
photoToFloor(px: number, py: number): [x, 0, z] | null   // §4.1 inverse; null at or above the horizon
floorToPhoto([x, y, z]): [px, py]                   // §4.1 projection (any point, despite the name)
renderView(opts?: { model?: string, prompt?: string, keepRoom?: boolean }): Promise<RenderMeta>
compare(a: string, b: string): void                 // opens Compare with two render names
getState(): {
  scene: { name, title, camera: Camera, camera_source, floor_found, hasDepth, occlusion, adjustFloor } | null,
  items: Array<{ uid, id, render: 'glb', position: [x, y, z], rotation_y_deg, worldBounds: { min, max }, missing?: boolean }>,
  layout: string | null,       // the layout last loaded or saved
  dirty: boolean,              // unsaved layout changes
}
```

Test handles (`data-midstudy`): `scene-new`, `scene-file`, `scene-card`, `scene-delete`, `scene-undo`, `scene-restore`, `layout-undo`, `ruler-true`, `ruler-set`, `compare-swap`, `adjust-floor`, `cam-height`, `cam-fov`, `cam-roll`, `horizon`, `floor-ok`, `floor-reset`, `occlusion`, `zoom-fit`, `render`, `render-go`, `keep-room`, `compare`, and from nook `elev-up`, `elev-down`, `elev-value`, `drop`, `lib-add`, `lib-remove`, `lib-undo`, `missing-item`. `scene-card` elements also carry `data-scene="<name>"`.

### 4.7 Render

- **Capture:** the full photo frame at the photo's resolution (view offset cleared, no UI): photo plus furniture, Look applied to the furniture only, JPEG.
- `POST /api/render` gains `scene` (required for a reference; `404` unknown) and `layout`. For `nano-banana` with a scene, the server sends `image_urls: [composite, scene photo]` and, unless a prompt is given, the default prompt below. Other models get the composite only, with nook's prompt (§2.6).
- **Default prompt (with the reference):** *"Image 1 is a photo of a room with 3D models of furniture placed in it. Image 2 is the same room as photographed. Make the furniture in image 1 look like it was photographed in this room: realistic materials, lighting, reflections and contact shadows that match the room's light. Keep the camera, the room and everything already in it exactly as in image 2. Keep each piece of furniture's position, size, shape and color. Do not add, remove or move anything."*
- **Output size:** nano-banana/edit snaps to about 1 MP (measured: 2000 × 1125 in → 1344 × 768 out) and the framing drifts by 1–2 % of the width, so the output is never pixel-aligned with the photo. The render is shown at its own size, not upscaled.
- **Keep room exact** (render dialog toggle `keep-room`, **default off**): the request also carries `keep_room: true` and `mask`, a PNG data URI at the photo's size (items white on black, dilated by 3 % of the photo width, more below each item for its shadow). After fal returns, the server writes the output as `<name>-raw.jpg` and runs `<calib> align <scene photo.jpg> <name>-raw.jpg <mask> --out <name>.jpg`; when `applied` is false, `<name>.jpg` is a copy of the raw output and the meta says why. Without keep-room there is no `-raw.jpg`.
- **Meta** gains `scene`, `layout`, `reference: bool` (the scene photo was sent), `keep_room: bool`, `aligned: {applied, inliers, residual_px, reason?} | null` (null without keep-room), `raw_url` (null without keep-room), `out_w`, `out_h` (the result's size). `GET /api/renders?scene=<name>` lists one scene's renders.
- **Mock:** the result is a copy of the input, $0, so align sees the identity and must apply.

---

## 5. Fixtures and evals

### 5.1 Golden scenes (`fixtures/scenes/`, `fixtures/calib/`)

`fixtures/make_scene.mjs` renders one textured room (oak plank floor, plaster walls, rug, door with casing, window, painting, floor lamp) with three.js 0.180.0 in headless Helium from a known camera. Each scene has a box **sofa** (2.0 × 0.82 × 0.9 m) and a **table** (1.0 × 0.42 × 0.55 m, top and four legs, turned 12°) at known positions. Same room and objects, three cameras:

| id | size | camera |
|---|---|---|
| `living-wide` | 1600 × 1200 | fov 55, height 1.40, pitch −10, roll 0 |
| `steep-roll` | 1600 × 1200 | fov 65, height 1.60, pitch −25, roll 2 |
| `portrait` | 1200 × 1600 | fov 70, height 1.25, pitch −8, roll −1 |

Files in `fixtures/scenes/<id>/`:
- `photo.jpg`: the photo (JFIF only, no metadata, so ingest passes it through byte for byte).
- `truth.json`: `{version, id, image: {w, h}, camera, depth: {file, w, h}, objects: {sofa, table}, floor_points}`. Each object has `center` (footprint center on the floor), `size_m {w, h, d}`, `rotation_y_deg`, `corners` (8 world points of its bounding box, ordered bottom then top, each ring back-left, back-right, front-right, front-left, front = local +Z; names in `corner_names`), `corner_px` (their §4.1 projection on the photo) and `parts` (the boxes it is built from, with their corners). `floor_points` are open-floor points (`world`, `px`) where `depth.png` is 0.
- `depth.png`: exact depth along the view axis (mm), floor within 4 cm masked to 0, at most 1024 px on the long side.
- `calib.json`: calib.schema.json with `source: "truth"` and the true camera.
- `ids.png`: 8-bit RGB id masks at the photo's size, each object rendered **alone** (no occlusion), antialiased like the photo: R = sofa, G = table; threshold at 128.

`fixtures/calib/<sha256 of photo.jpg>/{calib.json, depth.png}` are copies that the calib mock (`MIDSTUDY_CALIB_MOCK=fixtures/calib`) serves for those photos.

**Self-check:** `evals/py fixtures/check_scenes.py` reimplements §4.1 in numpy and checks every scene against the renders: each object's projected silhouette matches its id mask (IoU ≥ 0.985, bounding box within 1 px), every sofa corner lands on the sofa (≤ 1.5 px), the true camera beats the same camera with roll negated or pitch off by 0.5° or negated (this pins the signs), `depth.png` equals the ray-plane view-axis depth on the sofa's front face and the back wall (median error well under 1 mm; it is *not* the Euclidean distance), open floor is 0, calib.json validates, and the mock copies are identical. It writes marker images to `evals/out/check-scenes/`. Re-running `make_scene.mjs` regenerates everything (its JPEG bytes may differ run to run; it removes the old `fixtures/calib/<sha>/`), and the self-check must pass after it.

### 5.2 Carried evals

- `npm run eval:pipeline` (`evals/pipeline_offline.sh`): `midstudy-add` against `fixtures/fal`, offline, $0 (§3).
- `npm run eval:library` (`evals/library_api.sh`): the library API, URL fetch rules and spend cap (§2.8–2.9), mocked, $0. Picks free ports unless `MIDSTUDY_EVAL_LIBRARY_PORT` is set.
- `evals/validate_library.py <library.json>` checks any library against §1 and the schema; `evals/py` runs these helpers with pinned deps.

The evals track added PLAN.md §6.2 (`eval:scenes-api`, `eval:calib`, `eval:planner`, `eval:occlusion`, `eval:floor`, `eval:render`, `eval:phone`, `eval:all`; see `evals/README.md`). `npm run eval:real` (`evals/real_path.mjs`, not in `eval:all`) is the real path on this Mac: the default `--calib` (real MoGe-2) on the photos in `fixtures/photos/`, the real `midstudy-add` (GLB), fal mocked.

### 5.3 Rules every eval and agent follows

- fal is mocked: `MIDSTUDY_FAL_MOCK=fixtures/fal`, `MIDSTUDY_NO_DOTENV=1` (and `NOOK_NO_DOTENV=1`), `FAL_KEY` unset, and `serve.py --daily-spend-usd 0` unless an eval tests the cap with mock costs. Nothing reads `.env`. Only the main session makes live calls (PLAN.md §8).
- Calibration in fast evals: `--calib "python3 fixtures/stub_calib.py"` or the real CLI with `MIDSTUDY_CALIB_MOCK=fixtures/calib`. `eval:calib` runs the real model.
- Real photos in `fixtures/photos/` are git-ignored and never copied anywhere tracked; `fixtures/photos/private/` is never opened.
- Servers pick a free port and are stopped at the end. Scratch output goes to `evals/out/`.
- Headless browser: Helium (`/Applications/Helium.app/Contents/MacOS/Helium`, or `MIDSTUDY_BROWSER`) with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, driven by `playwright-core`.
