# midstudy contract

The shared spec between the **planner** (`planner/`, with its server `planner/serve.py`), the **calibration** CLI (`calib/`, `midstudy-calib`) and the **furniture pipeline** (`pipeline/`, `midstudy-add`). They share only the files and HTTP routes described here. Conventions (units, axes, item frame, slugs) are in [CLAUDE.md](../CLAUDE.md) and apply everywhere. [PLAN.md](../PLAN.md) is the plan; where this file and PLAN.md disagree, PLAN.md wins and this file gets fixed.

Sections 1–3 are nook's contract with the scan, rooms, iOS and hosting parts removed and the names changed (`nook` → `midstudy`). Section 4 is PLAN.md §4 with the details pinned down. Section 5 covers fixtures and evals. **v1.1 (2026-11-05, PLAN.md §12):** the `idol` engine (the default), the stand-in box for splat-only items, `splat.spz`, per-axis splat fitting, and the planner drawing splats with Spark (§1, §3.2, §3.4, §4.5 Splats).

Schemas: [library.schema.json](library.schema.json), [layout.schema.json](layout.schema.json), [scene.schema.json](scene.schema.json), [calib.schema.json](calib.schema.json), [lighting.schema.json](lighting.schema.json).

---

## 1. Files on disk

```
library/library.json          furniture library (library.schema.json); versioned in git
library/costs.csv             one row per paid or mock call: date,id,engine,cost_usd,mock,input; versioned in git
library/<id>/model.glb        normalized mesh, always present (for `idol`: a stand-in box at dims_cm, never drawn)
library/<id>/splat.ply        normalized 3DGS splat, optional (`idol`, `sam3d`)
library/<id>/splat.spz        the same splat compressed for drawing (gzipped SPZ), written with every splat.ply
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

`model.glb`, `splat.ply` and `splat.spz` are stored **already in the item frame**: no runtime transform is needed beyond the item's placement.

- **`model.glb`**: axis-aligned bounds have footprint center at x = z = 0 (±1 cm), min y = 0 (±0.5 cm), and size equal to `dims_cm` within **2 % per axis** (X = w, Y = h, Z = d). Materials and textures from the source are preserved. **Stand-in:** an `idol` item has no mesh (Idol makes only a splat), so its `model.glb` is a plain box exactly at `dims_cm` (one untextured material). The planner never draws it; it gives the item its exact size for selecting, dragging, stacking, `worldBounds` and the contact shadow (§4.5 Splats). An item is a stand-in exactly when `source.engine` is `idol`.
- **`splat.ply`**: standard binary 3DGS PLY (`x y z f_dc_0..2 opacity scale_0..2 rot_0..3`, plus `f_rest_*` only when nothing rotated them; `nx ny nz` dropped), fitted **per axis**: the extent of the splat centers equals `dims_cm` on each axis, and each Gaussian's covariance is stretched by the same scale (Σ' = S Σ S, written back as `scale_*` and `rot_*`). The **extent** is a percentile range of the centers, by engine: the **1st–99th** for `sam3d` (its splat has floaters; this range matches its GLB within 1 %, measured on the fixture) and the **0.1th–99.9th** for `idol` (dense and nearly floater-free: the 1st–99th cuts 3–7 % of the real surface, measured on the fixture), the 1st–99th for anything else. Checks, on that extent: size within **2 % per axis** of `dims_cm`, min y within ±1 cm of 0, footprint center within 1 cm of the origin.
- **`splat.spz`**: the splats of `splat.ply`, same frame, same positions (Spark reads both as they are), as **SPZ version 2** (Niantic's format), gzip-compressed: a 16-byte little-endian header (`0x5053474e` "NGSP", version 2, the count, SH degree 0, 12 fractional bits, flags 0, reserved 0), then positions (24-bit fixed point), alphas, colours, scales, rotations (3 bytes, the quaternion's x y z with w ≥ 0). At most **262,144** splats: above that, the ones that cover the least are dropped: they are ranked by opacity × the area of their two largest axes (a live SAM 3D splat has 760,000–880,000; ranking by opacity alone kept only its small inner splats). This is what the planner draws: **at most 6 MB**. Every write of `splat.ply` (add and `--rescale`) writes it too.

---

## 2. Planner (carried from nook)

A static web app in `planner/` (three.js `0.180.0` via importmap, no build step) plus `planner/serve.py` (Python stdlib only). Sections 2.1–2.10 keep nook's numbering, which the code's comments cite. What's new for scenes is in §4.

> **State since the integration commit:** `planner/` implements §4 (scenes, the locked photo camera, occlusion, Adjust floor, keep-room renders, Compare); rooms, the shell, hanging, retrain and `--scan-api` are gone. Splat items came back in v1.1 (§4.5 Splats), drawn with Spark; splat rooms did not.

### 2.1 Server

```
python3 planner/serve.py [--port 8765] [--host 127.0.0.1] [--library-dir library] [--costs-file library/costs.csv]
                         [--layouts-dir layouts] [--renders-dir renders] [--scenes-dir scenes]
                         [--calib "uv run --project calib midstudy-calib"] [--midstudy-add "uv run --project pipeline midstudy-add"]
                         [--daily-spend-usd 2] [--allowed-host NAME ...]
```

- Serves the planner at `/planner/`; `GET /` redirects there. Static files get correct MIME types (`.spz` is `application/octet-stream`, sent as stored: no `Content-Encoding`), `X-Content-Type-Options: nosniff` and no caching. **Static is an allowlist:** `/planner/…` (the app's own files), `/library/…` (§2.8), `/scenes/…` (§4.4) and `/renders/…`; every other path is `404`, whatever its spelling or case. (The repo also holds the user's photos, camera originals dropped at the root with or without an extension, scratch scenes and the tracked `costs.csv`, and APFS is case-insensitive.)
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
  addItem(id: string, opts?: { position?: [x, y, z], rotation_y_deg?: number }): Promise<string>  // resolves with a new uid once what it draws (GLB or splat) has loaded
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
  readProductPage(url: string, opts?: { llm?: boolean, html?: string }): Promise<ProductResult>  // §2.11; adds nothing (html: a pasted page, url may be '')
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
| `POST /api/library/product` | JSON `{url, llm?}` or `{html, url?, llm?}` | `200` what the product page (or a pasted copy of it) says (§2.11); adds nothing |
| `GET /api/library/jobs` | | `200 {"jobs": [job, ...]}`, newest first |
| `GET /api/library/jobs/<id>` | | `200` the job object itself, or `404` |
| `PATCH /api/library/items/<id>` | any of `name`, `category`, `mount`, `yaw` (0/90/180/270, relative), `default_render`, `dims_cm` | `200` the item, or `202 {job}` when `dims_cm` or `yaw` changed |
| `DELETE /api/library/items/<id>` | | `200 {"ok": true}`: entry and folder move to `library/.trash/<id>-<UTC stamp>/` |
| `POST /api/library/items/<id>/restore` | | `200` the item (newest trashed copy), `404` when none, `409` when the id exists again |
| `PUT /api/library/items/<id>/thumb` | `{"image": "data:image/jpeg;base64,…"}` ≤ 2 MB (the planner's render of the model) | `200` the item: `<id>/thumb.jpg` written without metadata (§2.6), `assets.thumb` set; `404` unknown id, `400` not a JPEG, `413` over 2 MB, `503` while a job holds the library |

**Meta:** `name` and `dims_cm` `{w,d,h}` required; `id` (default: slug of `name`), `category`, `mount`, `yaw`, `engine` (`idol` (default) \| `sam3d` \| `trellis2` \| `rug` for images; `glb` for models, where any other engine is a `400`), `prompt`, `resolution`. `cost_usd_estimate` is the engine's price from §3.2 ($0.10 for `idol`). Anything wrong is `400` with one actionable sentence.

**Bodies:** `model` is a `.glb`, or a `.zip` holding one `.obj` with its `.mtl` and textures (`.usdz`: "convert to GLB first"); `image` is a JPEG, PNG, HEIC or WebP. **Limits:** models 200 MB, images 20 MB (`413`), `411` without a length. Zips: only `.obj .mtl .png .jpg .jpeg` extracted; no absolute paths, `..` or links; at most 500 MB unpacked and 1,000 entries. Uploads land in a private temp folder, never under a served path.

**Jobs:** one queue, one job at a time, in memory (a restart forgets them). Job object: `{id: "l-…", kind: "add" | "rescale", item_id, status: "queued" | "running" | "done" | "failed", engine, cost_usd_estimate, cost_usd, mock, created, started, finished, message, item}`. A failed job's `message` is `midstudy-add`'s stderr line. Re-adding an id replaces it (upsert) and says so.

**One writer:** every library write takes `<library>/.lock` (`flock`); PATCH, DELETE and restore wait up to 60 s for a running job, then answer `503`.

**What `/library/` serves:** item assets (`<id>/model.glb`, `splat.ply`, `splat.spz`, `thumb.jpg`) and `library.json` (an empty library, `{"version": 1, "items": []}`, while the folder has none yet). `source.<ext>` (the upload as given: a phone photo's EXIF and GPS), `raw/`, `.trash/`, `.lock` and `costs.csv` get `404`.

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
- **Page fetches** (product page, §2.11, added 2026-11-05): the same address rules (resolved once and pinned, every redirect and every hop re-checked, private addresses refused with `400` before any connection, `MIDSTUDY_FETCH_ALLOW` the only exemption), at most **5** redirects, **20 s** for the page and its feeds together, the first **10 MB** of the page (the rest is cut, with a warning), feeds 2 MB, `gzip`/`deflate` bodies decoded within the same limits, `User-Agent: midstudy/1.0 (product page reader)`, no cookies kept. Only `text/html` or `application/xhtml+xml` pages (feeds: JSON or `text/javascript`). Feeds go to the page's own origin only. The server **never downloads the page's pictures**: it only lists their links; the one the user picks goes through the from-URL add above, with its own checks.

Acceptance: W1 forged mutations get `403` everywhere; W2 with `--daily-spend-usd 0.03` and `MIDSTUDY_FAL_MOCK_COST=1`, the second $0.02 add is `402`; W3 private URLs are refused without a connection; W4 `/library/costs.csv`, `.trash/`, `raw/` and `source.*` are `404`, in any case or spelling.

### 2.10 Elevation (carried; wall hanging dropped)

A placed item's `position[1]` is its bottom's height above the floor, 0–4 m (clamped). Desktop: `Shift`+drag or `PageUp`/`PageDown` (1 cm, 10 cm with `Shift`). Phone: an **Up / Down** control (drag handle, `+`/`−` buttons of 1 cm that repeat when held, the height in cm, editable). A raised item (bottom > 2 cm up) drops its contact shadow and shows a faint guide line to the floor while selected. **Drop to floor** puts it back at 0. Handles: `elev-up`, `elev-down`, `elev-value`, `drop`. Library items may still carry `mount: "wall"`; v1 places them on the floor like any other item.

### 2.11 Product page (added 2026-11-05)

Paste a shop's product link; the server reads the page and answers what it found. **It adds nothing**: the planner prefills the Add furniture form, the user checks it, and **Make** posts the chosen picture to `from-url` (§2.8) as any image-link add. The extractor is `planner/product_page.py` (stdlib only, loaded by `serve.py` from its own folder, so it works under `python3 -I`).

`POST /api/library/product` with JSON `{"url": "https://…", "llm"?: true}` (§2.9 rules: `X-Midstudy`, `Origin`, `Host`). `llm: false` skips the language model (layer 4).

**200** (field order is free; every key is always present):

```json
{ "url": "<the page's final URL, after redirects>",
  "name": "BILLY bookcase, black oak effect" | null,
  "category": "bookcase" | null,
  "is_rug": false,
  "dims_candidates": [
    { "w": 80.0, "d": 27.9, "h": 106.0, "unit": "in", "label": "31 1/2x11x41 3/4\"" | null,
      "unit_note": "from inches: 31 1/2 × 11 × 41 3/4 in" | null, "notes": ["length read as width"],
      "quote": "<the text the numbers came from, ≤ 200 chars>", "source": "jsonld" } ],
  "variants": [ { "label": "8' x 10'", "dims_index": 3 | null } ],
  "images": [ { "url": "https://…/front.jpg", "w": 2000 | null, "h": 2000 | null, "kind": "product" } ],
  "source_layers_used": ["jsonld", "opengraph"],
  "cost_usd": 0, "mock": false,
  "warnings": ["<one sentence each>"] }
```

- **`dims_candidates`**: every distinct size reading, **best first**, in **cm** rounded to 0.1. `w`, `d`, `h` are > 0, or `h` is null when the page has no height (not for a rug: below). `unit` is the unit the page used (`cm`, `mm`, `m`, `in`, `ft`); `unit_note` says how it was converted when that wasn't cm; `notes` say how labels were mapped. `quote` is the page text, structured value or feed text the numbers came from. `source`: `jsonld`, `microdata`, `shopify`, `woocommerce`, `text` or `llm`. Readings within 0.5 cm on every axis are one candidate (the better source's). At most 16.
- **Order:** a shop's size options (variants) in the shop's order, its default first; else explicit `width`/`depth`/`height` in JSON-LD or microdata; feeds; then page text (a reading introduced by "overall", "dimensions" or "assembled" before others); then `llm`.
- **Mapping:** labels win: W/width, D/depth, H/height (also before or after the number: `200W x 90D x 85H cm`, `34 H x 84 W x 38 D in`, `200 (W) x 90 (D) x 85 (H) cm`, `18" Dia x 22" H`; and Breite/Tiefe/Höhe, largeur/profondeur/hauteur, ancho/fondo/alto, larghezza/profondità/altezza, breedte/diepte/hoogte). An **order key** next to unlabelled numbers sets their axes: `200 x 90 x 85 cm (W x D x H)`, `W x D x H: 84 x 38 x 34 in`, `(HxWxD): 180 x 80 x 40 cm`. **L/length is read as width** (note "length read as width"); when the same reading also labels a W, the longer of the two is the width and the other the depth (`78.7"L x 35.4"W` is a sofa 199.9 wide; Floyd's `16” W x 13” L` keeps W 16), except on a bed, whose length runs head to foot and is the depth. A WooCommerce `dimensions` field (length × width × height) is read w = length, d = width, h = height (note). An unlabelled triple "A × B × C" is W × D × H (note "read as W × D × H"). Rug sizes ("8' x 10'", "160 x 230 cm", "3*4") are W × D in the order given. An unlabelled pair in a structured size (JSON-LD `size`, a variant) on a piece that isn't a rug is W × D with `h` null (note "read as W × D"); in page text such pairs are left out as too ambiguous. Readings introduced by box, package, packaging, carton, shipping, seat, arm, leg, drawer, cushion, interior, opening, clearance or shelf depth are not the piece's size and are left out. Page text inside header, footer, nav, aside or a related / recommended / "complete the look" block counts only when the rest of the page has no size. A range (`W 180–220 cm`) is read as its smaller end, with the note "width extends to 220 cm". One size written twice (also in two units, within 1 %) is one candidate, the metric one.
- **Units:** cm, mm, m; inches (`"`, `″`, `”`, `''`, in, inch, inches) and feet (`'`, `′`, `’`, ft, feet, foot), feet and inches together (`7' 6"`), fractions (`31 1/2`, `41 ¾`), decimal commas (`80,5 cm`). 1 in = 2.54 cm, 1 ft = 30.48 cm. A size with **no unit** in structured data or a size option takes the unit the page measures in elsewhere (`(m)`, `cm`, `in`…), with a note ("no unit on the page: read as m, as the page's other sizes"), or cm when that unit would make it implausible (`160*230` on a page that measures in m); with no hint it is left out with a warning. Size options that can't be read at all are named in a warning. In page text, unitless numbers count only on a line that is little more than the size (an `<option>`) or when labelled. A reading outside 1–2000 cm on any axis is left out.
- **Rugs:** `is_rug` is true when rug, carpet, runner, kilim, dhurrie or tapis is the head noun of the name, category, a breadcrumb or the product type (the category rule below: "Kilim Ottoman" is an ottoman). A rug's `h` is its thickness (wins), pile height, pile or height (≤ 5 cm) when the page gives one (a unitless `Thickness: 0.25` is inches on a page in inches or feet, else cm, with a note), else **1** with the note "thickness not on the page: 1 cm assumed". The planner then picks the Flat rug engine.
- **`variants`**: the shop's size options, when it has more than one (Shopify options named Size/Dimensions, WooCommerce size attributes, JSON-LD `hasVariant` sizes, offer names), without samples or swatches. **The size the link names comes first** (Shopify `?variant=<id>`, matched to the feed's variants or JSON-LD urls; WooCommerce `?attribute_pa_<size>=<slug>`), with the note "the size picked in the link"; else the shop's default. `dims_index` points into `dims_candidates`, null when that label couldn't be read. Empty when the page has one size.
- **`category`**: one plain word or two from the name, product type or breadcrumbs (rug, sofa, armchair, chair, stool, bench, coffee table, side table, dining table, table, desk, bed, bedside table, dresser, wardrobe, bookcase, shelf, cabinet, sideboard, tv stand, lamp, mirror, ottoman, plant), or null: the keyword that ends last, outside brackets ("Desk Lamp" is a lamp, a sofa bed a sofa).
- **`images`**: the product's pictures, at most 12, product first (JSON-LD `image`, feed images, then `og:image`, then large `<img>` in the product area: at least 500 px on the long side, a file name or alt text sharing a word with the name or the link, and not inside header, footer, nav, aside or a related / recommended / upsell / cart / menu / reviews block), absolute `https`/`http` links only (no `data:`, protocol-relative links get `https:`), never to a private, loopback or `.local` address (the browser would request it), one per picture (the same host and path with other size parameters or scheme is one; its largest copy, https over http, is kept). `kind`: `product`, `variant`, `og` or `page`. The planner shows them with `referrerpolicy="no-referrer"`.
- **`source`**: sizes from feed descriptions, meta or JSON-LD descriptions and script strings are `text` (layer 3); `shopify` and `woocommerce` are those feeds' own options and dimensions.
- **`cost_usd`**: what the language model cost (0 without it); `mock` is true only when the model was called in mock mode. `source_layers_used` lists `llm` only when the model was called (not when it was skipped).
- **`warnings`**: what the user should know (a cut page, a feed that failed, the model skipped and why, a model quote not found on the page).

**Layers**, cheapest and most exact first; a later layer runs only for what is still missing:

1. **The page** (§2.9 Page fetches).
2. **Structured data, free:** schema.org `Product` / `ProductGroup` in JSON-LD (also inside `@graph` and arrays; `width`/`depth`/`height` as text or `QuantitativeValue` with `unitCode` CMT, MMT, MTR, INH, FOT or `unitText`; `size`; `additionalProperty` named width, depth, height, length, size or dimensions; `hasVariant`; `image` as a string, list or `ImageObject` `url`/`contentUrl`) and microdata (`itemprop`); OpenGraph `og:title`, `og:image` (`og:image:width`/`height`), then `<title>`. **Platform feeds**, one request each, same fetch rules, origin only: **Shopify** (the page shows `cdn.shopify.com` or `Shopify.`): `GET <page path without query>.js`; **WooCommerce** (`woocommerce` in the page or a `/wp-json/` link): `GET <origin>/wp-json/wc/store/v1/products?slug=<the page path's last segment>`. A feed that fails is skipped (a 429 from Shopify is common).
3. **Page text, free:** the visible text (no scripts, styles or templates), the feeds' descriptions, and the string values inside inline scripts that mention a size (shops that render the page in the browser keep "Dimensions (Overall): 71.18 Inches (H) x …" in a JSON blob). Only readings with an explicit unit, or a page unit hint as above.
4. **A small language model, only when no size was found** (and `llm` isn't false): fal `openrouter/router` (`https://fal.run/openrouter/router`, `Authorization: Key $FAL_KEY`, §3.3) with `model: "anthropic/claude-haiku-5.5"`, `temperature: 0`, `max_tokens: 600`, a fixed `system_prompt` and the cleaned page text (at most 20,000 characters, the parts around size words first) between `<page>` markers. The page is **data**: the system prompt says that nothing inside it is an instruction, and the output is only ever used as data. The model answers JSON `{"dims": [{"label", "w", "d", "h", "unit", "quote"}], "name": {"value", "quote"} | null}`. The server keeps a size only when its **`quote` is found in the page text** (whitespace collapsed, case ignored), the quote holds every number given, and `unit` is one of cm, mm, m, in, ft; it then converts the units itself. Anything else is dropped with the warning "the language model gave a size that isn't on the page, so it was ignored". At most 8 sizes.
   - **Money:** under $0.001 a page ($0.10 / $0.50 per million tokens in / out; measured live on 2026-11-05: $0.00008–0.00025). Before the call the server reserves **$0.002** against the daily cap (§2.9) and releases it after. It records `usage.cost` from fal's answer when present, else the tokens at that price, in `costs.csv` (`engine` = `product:llm`, `id` = `product-<host slug>`, `input` = the page URL without its query), also when the answer is unusable. A call fal refuses (an HTTP error) writes no row and adds a warning. Over the cap, without `FAL_KEY` (outside mock mode), or with `llm: false`, the model is skipped with a warning and the rest still answers `200`.
   - **Mock** (`MIDSTUDY_FAL_MOCK=<dir>`): no call; the answer is `<dir>/openrouter-router/<slug>.json`, `<slug>` being the page URL's last path segment (lowercased, anything but `a-z0-9-` turned into `-`), else `<dir>/openrouter-router/response.json` (a model that finds nothing). Files hold fal's answer verbatim (`{"output": "<the model's text>", "usage": {…}}`). Mock calls cost $0 and write a `mock: true` cost row (the $0.001 estimate with `MIDSTUDY_FAL_MOCK_COST=1`).

**Pasted pages** (added 2026-11-05, for shops that block automatic reading): the body may carry `html`, the page's source as the user's own browser copied it, instead of the server fetching it. Then **nothing is fetched** (not the page, not a feed, not a picture); the page is read by the same layers otherwise. Its address is, in order: a first line `<!-- midstudy-page: <address> -->` (what the planner's **Copy page for midstudy** bookmarklet writes before `document.documentElement.outerHTML`), else `url`, else the page's `<link rel=canonical>` or `og:url`; it must be http(s) and is never resolved. No address: `400` "the pasted page doesn't say its address: paste its link in Product page link too". Text that isn't HTML, or `html` that isn't non-empty text: `400`. Over 10 MB: cut, with the same warning. A pasted robot check: `422` (not `blocked`) "that's the shop's robot check, not the product: …". The planner's Product page source has a **Paste the page instead** section (closed; opened by a blocked answer): three steps, the bookmarklet as a draggable link (clicking it in midstudy only says to drag it) with **Copy its address** for phones, and a box that reads a paste straight from the clipboard (the source never sits in the box) and sends `{html}` with the link field's address when it holds one. After a pasted read the link field shows the answer's `url`. Handles: `product-paste-open`, `product-paste`, `product-bookmarklet`, `product-bookmarklet-copy`.

**Errors:** `400` with one sentence for a body without `url` (or `html`), a link that isn't http(s), is malformed, has no host, doesn't resolve, or resolves to a private address. A link's `user:password@` and `#fragment` are never kept (not in `url`, not in `costs.csv`). The work after the download is bounded too (10 s, then `422` "the page took too long to read"); no page can hold the server: size patterns run in linear time. `422 {"error", "blocked": true}` when the shop refuses (401, 403, 429, 503, or a `200` that is a robot check with no product data in it): **"This shop blocks automatic reading: paste the image link and size instead."** (a 429 adds "or try again in a minute"). `422 {"error"}` when the link isn't a web page (an image: "that's a picture: use Image link"), answers another error, times out, or holds no product (no name and no picture).

**Planner:** Add furniture gets a **Product page** source: a link field, **Read** (a loading state while it reads), then the form prefilled: Name, W × D × H (a size picker when there are several candidates), Category (when empty), the Flat rug engine when `is_rug`, a strip of the page's pictures to choose from (the first chosen), and the notes (unit notes, warnings, and what the model cost). Every field stays editable; nothing is added until **Make**, which sends the chosen picture to `addFromUrl`. A blocked page shows the error with a way to switch to **Image link**. The route's `4xx` answers are the page's answer, shown in the form and not pushed to `window.midstudy.errors`; a server that doesn't answer, or a `5xx`, is an app error (§2.3). Product page is the first source and the default; on the phone its button reads "Product". Desktop and phone (390 px: no sideways scroll, targets ≥ 44 px). Handles: `lib-src-product` (the source button), `product-url`, `product-read`, `product-status`, `product-size` (each size choice, with `data-index`), `product-pic` (each picture, with `data-index`), `product-notes`, `product-error`, `product-use-link`. Hook (§2.4): `readProductPage(url: string, opts?: { llm?: boolean }): Promise<ProductResult>` (the `200` body; rejects with the error sentence).

Acceptance: `npm run eval:product` (synthetic pages in `fixtures/product-pages/`, model mocked, $0, in `eval:all`), `npm run eval:product-ui` (the form, desktop and phone, in `eval:all`), `npm run eval:product-live` (the golden set in `evals/product_golden.json` against the real shops, no model unless asked; not in `eval:all`).

---

## 3. Pipeline (carried)

A uv project in `pipeline/` (Python 3.12), console script `midstudy-add`, package `midstudy_pipeline`. v1.1 added the `idol` engine, the stand-in box, `splat.spz` and per-axis splat fitting (PLAN.md §12).

### 3.1 CLI

```
uv run --project pipeline midstudy-add INPUT --name NAME --dims WxDxH
    [--id SLUG] [--category TEXT] [--engine idol|sam3d|trellis2|glb|rug] [--prompt TEXT]
    [--yaw 0|90|180|270] [--resolution 512|1024|1536] [--library DIR] [--notes TEXT] [--mount floor|wall]
uv run --project pipeline midstudy-add --rescale ID [--dims WxDxH] [--yaw 0|90|180|270] [--library DIR]
```

- `INPUT`: a local image or image URL (`idol`, `sam3d`, `trellis2`, `rug`), a `.glb`/`.gltf`, or an OBJ `.zip` (`glb`). `.usdz` fails with "convert to GLB first".
- `--dims`: centimeters `W x D x H` (`x` or `×`, spaces and decimals allowed). Required for adds.
- `--id` defaults to a slug of `--name`; re-running an id **replaces** it (upsert) and says so. `--engine` defaults to `idol`.
- Image engines get a metadata-free, upright copy of the photo (`raw/engine-input.<ext>`, §2.8 Privacy); `source.<ext>` keeps the input as given.
- `--yaw`: extra rotation around Y after the engine's default orientation; positive is counterclockwise seen from above, so `--yaw 90` turns +X into −Z. The planner's `rotation_y_deg` uses the same sign.
- `--rescale ID` refits an existing item from its normalized assets: no model call, `cost_usd: 0`, no cost row.
- Exit 0 on success; the **last line of stdout** is one JSON object `{"id", "engine", "cost_usd", "mock", "paths", "fit"}` (`paths.spz` beside `paths.splat`). Every failure exits non-zero with **one actionable line on stderr** prefixed `midstudy-add: `.

### 3.2 Engines

| `--engine` | fal endpoint | arguments | cost recorded |
|---|---|---|---|
| `idol` (default) | `speridlabs/idol` | `image_url`, `image_type: "real"`, `num_gaussians: 262144` | $0.10 |
| `sam3d` | `fal-ai/sam-3/3d-objects` | `image_url`, `prompt`, `export_textured_glb: true` | $0.02 |
| `trellis2` | `fal-ai/trellis-2` | `image_url`, `resolution` | $0.25 / $0.30 / $0.35 for 512 / 1024 / 1536 |
| `glb` | none | | $0.00 |
| `rug` | none | | $0.00 |

- **`sam3d` when it finds nothing** (fal 422 "Auto-segmentation produced no masks", refused before running, so not charged): it asks again with `detection_threshold: 0.2`, then with `mask_urls` holding a mask of the piece (`raw/mask.png`: the picture without its plain margin, or the whole picture), then fails with one plain line. `MIDSTUDY_FAL_MOCK_NO_MASKS=N` (evals) makes the first N mocked calls answer that way.
- **`idol`** (added 2026-11-05; [speridlabs/idol](https://github.com/speridlabs/idol-sdk), Apache-2.0): one picture of one object to a 3D Gaussian splat. It removes the background and frames the object itself. The response has `model_mesh` (the splat, a PLY despite the name: the only file fetched), `model_glb` (a point-cloud preview of the splat centers, not fetched), `preprocessed_image` (not fetched), `camera` (`yaw`, `pitch` in radians, `radius`, `fov` in degrees: the predicted view of the input) and `num_gaussians`. Measured live: 15 s, 262,144 splats, DC colour only, 17.8 MB. No mesh: `midstudy-add` writes the stand-in box `model.glb` (§1) and `default_render: "splat"`; `prompt` is null. A failed call that fal charged keeps its outputs in `<library>/_failed/`, as for the other engines.
- **`rug`** (added 2026-11-05): a rug pictured from straight above (a shop's picture) laid flat, with no model call. The picture's plain margin is cropped, it is turned a quarter when that matches W × D better, and it becomes the unlit top face of a W × D × H slab (H is the thickness, about 1 cm; sides in the rug's edge colour). The picture's top edge is the back (−Z). GLB only, no splat; `prompt` is null.

The engines' frames are in `fixtures/fal/NOTES.md`.

### 3.3 Credentials and mock mode

- `FAL_KEY` from the environment, else from `.env` at the repo root, unless `MIDSTUDY_NO_DOTENV=1`.
- **`MIDSTUDY_FAL_MOCK=<dir>`**: no network calls to fal. Each call returns `<dir>/<slug>/response.json` (`sam-3-3d-objects`, `trellis-2`, `speridlabs-idol`: the endpoint without `fal-ai/`, `/` → `-`), file URLs resolve to `<dir>/<slug>/files/<basename>`. Mock runs record `mock: true`, `cost_usd: 0`; `FAL_KEY` isn't needed. `MIDSTUDY_FAL_MOCK_COST=1` (evals only) records the real price instead.

### 3.4 Normalization, library entry, acceptance

Orientation from NOTES.md, then `--yaw`; translate to the footprint center and min y = 0; scale per axis (GLB, and splat with its covariances, §1); write (`splat.spz` from the written `splat.ply`); self-check (§1) and refuse to upsert a bad item. The entry has `id, name, category, dims_cm, assets {glb, splat, spz, thumb}, default_render, source {engine, input, prompt, cost_usd, mock, created}, fit` (`source.input`: a URL as given, a local file by its name only, never a path; the server passes the upload's name); `default_render` is `"splat"` when the item has a splat (`idol`, `sam3d`), else `"glb"`; then a cost row; writes are atomic; every write takes `<library>/.lock`. `npm run eval:pipeline` (L1–L7 and the v4 additions) must pass.

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
scenes/<name>/lighting.json  optional: the room's light inferred from the photo (lighting.schema.json, §4.8), written by
                             midstudy-calib with calib.json; absent after a fallback calibration (no MoGe)
scenes/<name>/depth.png      optional: 16-bit grayscale PNG, mm along the view axis (§4.1's d), long side ≤ 1024 px,
                             same aspect as photo.jpg; 0 = no occluder (the floor, below the floor, sky, unknown: §4.3 Fit)
scenes/<name>/scene.json     scene.schema.json: version, title, created, saved, camera (in use), camera_source, look
                             (furniture look and lighting controls, §4.8), upload
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
midstudy-calib light <scene-dir> [--model ...] [--device ...]   # lighting.json only, for a scene calibrated before it (§4.8);
                                                                # camera: calib.json's when its floor was found, else this run's floor fit
midstudy-calib align <photo.jpg> <raw.jpg> <mask.png> --out <final.jpg>   # keep-room composite (§4.7)
```

**Output contract (all commands):** progress goes to stderr. The **last stdout line** is one JSON object:

| command | success (exit 0) |
|---|---|
| `run`, `fit` | the `calib.json` contents plus `"ok": true` |
| `ingest` | `{"ok": true, "photo": "photo.jpg", "source": "source.<ext>", "image": {"w", "h"}}` |
| `light` | `{"ok": true, "lighting": true, "cct_k", "confidence", "elapsed_s"}`, or `{"ok": true, "lighting": false, "reason"}` when the photo shows too little (nothing written) |
| `align` | `{"ok": true, "applied": bool, "inliers": int, "residual_px": number \| null, "reason"?: string}` |

A failure exits **1** with `{"ok": false, "error": "<one sentence>"}` as the last stdout line and `midstudy-calib: <the same sentence>` as the last stderr line. The server shows that sentence. A fallback calibration is a success (exit 0).

**Files:** `--out` may already exist (the server creates the scene folder first). The tool writes only `source.<ext>`, `photo.jpg`, `calib.json`, `depth.png` and `lighting.json` there, each atomically (temp file + rename), and never touches `scene.json`, `thumb.jpg` or anything else. `fit` without depth removes a stale `depth.png`; a fit that can't infer the light (a fallback without MoGe, or too few usable pixels) removes a stale `lighting.json`. `--no-depth` doesn't affect `lighting.json`. `run` writes `photo.jpg` before it starts the model, so the planner can show the photo while it calibrates.

**Ingest:**
- Accepts JPEG, PNG, HEIC/HEIF and WebP up to 25 MB, recognized by their bytes, not the name (anything else: exit 1, "that file isn't a JPEG, PNG, HEIC or WebP image").
- Applies the EXIF orientation, converts to sRGB with the embedded ICC profile (iPhones write Display P3), downsizes to a 2048 px long side, writes `photo.jpg` (q92) with **no metadata at all** (no EXIF, GPS, XMP, ICC, comments): it is served and sent to fal. `source.<ext>` keeps the original bytes and is never served.
- **Pass-through:** a JPEG that needs none of that (APP0 only as plain 16-byte JFIF headers, without a thumbnail or a JFXX extension; no EXIF/XMP/ICC/comment **anywhere in the file**, including between progressive scans, **not one byte after its end-of-image marker**: no appended second image, no padding, long side ≤ 2048) is copied **byte for byte**, so `photo.jpg`'s SHA-256 equals the upload's. Anything else is re-encoded. The golden scenes rely on this for the mock (§5.1).

**EXIF FOV:** read from `source.<ext>` (EXIF `FocalLengthIn35mmFilm`, plus make and model). The 35 mm equivalent refers to the diagonal of the sensor's native **4:3** frame (the full-frame diagonal, 43.27 mm, so a 34.61 × 25.96 mm frame). The photo is the largest crop of that frame with the photo's aspect: wider than 4:3 (16:9) keeps the long side, squarer keeps the short side. The vertical FOV is `2 · atan(v_mm / (2 · f35))` with `v_mm` the crop's extent along the photo's vertical axis. For `fixtures/photos/upper-lounge-camera.jpeg` (14 mm, 16:9 landscape) that is 102.1° horizontal and 69.6° vertical. When MoGe runs and the EXIF FOV is within 8° of MoGe's, the camera uses the EXIF FOV and MoGe's scale is corrected (Fit, below; `fov_source: "exif"`); otherwise MoGe's FOV is used (`fov_source: "moge"`) and a difference over 8° adds `fov_disagreement` (a cropped or edited photo keeps the lens's focal length, so its EXIF FOV is wrong).

**Fit:** MoGe-2 gives a metric point map, normals and intrinsics. Fit the floor with RANSAC over points whose normal points up relative to the camera and that lie below it; prefer the largest such plane in the lower part of the image (beware reflective floors and floors seen through glass: the real lounge photo has both). The plane gives `height_m`, `pitch_deg`, `roll_deg` (in §4.1's convention: the camera is re-expressed so the floor normal is world +Y and yaw is 0); the intrinsics give `fov_y_deg`. **With a known FOV** (EXIF, as above): MoGe-2's FOV runs wide (3.6–7.5° on the golden renders, 3.1° over EXIF on the lounge photo) and its metric scale is short by about the same focal ratio, while its pitch and roll are right. So the camera takes the EXIF FOV, MoGe's pitch and roll, and `height_m × k` with `k = tan(fov_moge / 2) / tan(fov_exif / 2)`; `depth.png` is MoGe's depth times the median ratio, over MoGe's floor pixels, between that camera's floor depth and MoGe's own, so the depth agrees with the floor the planner draws. Measured on the golden scenes with their true FOV given as EXIF: height within 2 %, depth within 5 %, furniture drawn within 3 % of its size (MoGe's own FOV: 7–10 % too big). `depth.png` holds MoGe's depth along the view axis with floor pixels set to 0: at least those within 4 cm of the plane (the tool uses max(4 cm, 1.2 % of the depth), as MoGe is noisier far away), plus every pixel below the plane (reflections in a shiny floor, a lower floor seen through glass), which could never hide anything standing on the floor. With no floor found, `depth.png` is MoGe's depth unmasked (`floor_masked: false`). `inlier_ratio` is the share of image pixels on the plane.

**Fallbacks:** no floor → `floor.found: false`, MoGe's FOV, height 1.40, pitch −10, roll 0. MoGe unavailable or failed → `source: "exif"` (FOV from EXIF) or `"default"` (FOV 55), height 1.40, pitch −10, `depth: null`.

**Device:** `auto` picks cuda, then mps (with `PYTORCH_ENABLE_MPS_FALLBACK=1`), then cpu.

**Align** (opencv-python-headless): resize the model output to the photo's size, estimate a homography from the output to the photo from features outside the mask (ORB + RANSAC, or ECC), warp, composite `photo × (1 − mask) + warped × mask` with the mask feathered, write `<final.jpg>`. Fewer than 40 inliers or a median residual over 3 px: write nothing, `applied: false` with a `reason`, exit 0. Always runs for real (an identical image is the identity and must apply).

**Mock:** with `MIDSTUDY_CALIB_MOCK=<dir>` (e.g. `fixtures/calib`), `fit` never loads MoGe: it looks up `<dir>/<sha256 of photo.jpg>/`, then `<dir>/<sha256 of source.<ext>>/`, and copies that `calib.json`, `depth.png` and `lighting.json` (each when present); with no match it writes the `default` fallback and no `lighting.json`. `ingest` and `align` still run for real.

**Stub:** `fixtures/stub_calib.py` (stdlib only) has the same CLI and output contract for development and fast evals: JPEG only, strips metadata without re-encoding (can't rotate, resize or convert colour), mock (including `lighting.json`) or `default` fit, and `align` answers `applied: false`. Run the server with `--calib "python3 fixtures/stub_calib.py"`.

**Lighting** (§4.8): after the floor fit, `fit` infers the room's light from the photo's pixels and MoGe's normals and writes `lighting.json`. It runs on MoGe's output at depth size, needs no other model, costs nothing and adds about a second.

#### Worker (`midstudy-calib serve`)

`midstudy-calib serve [--model vitl|vitb|vits] [--device auto|cuda|mps|cpu]` answers the commands above as one long-lived process that keeps MoGe-2 loaded (one model at a time, on the device it last ran on), so only its first calibration pays for starting Python and torch, loading the network and the device's first inference. Measured on the M3 Max (MPS, vitl; `calib/scripts/bench.py`, `docs/notes/calib.md`): a one-shot calibration takes 5.6 s (v1: 10.0 s); through the worker the first takes 5.3 s and every later one 0.9 s. `--model` and `--device` are the defaults of the requests that name none (so a device the server's `--calib` command fixes applies to every request).

**Protocol** (stdin and stdout, UTF-8, one JSON object per line; `calib/src/midstudy_calib/schemas/calib-cli.schema.json`):
- Request: `{"id": "<1–200 characters>", "cmd": "run" | "fit" | "light" | "align" | "ingest", "args": [...]}`, where `args` are the one-shot command's arguments after its name, e.g. `{"id": "c-20261105-221500-ab12", "cmd": "fit", "args": ["/abs/scenes/x", "--no-depth"]}`.
- Response: `{"id": <the request's id>, …}`, the rest being exactly the one-shot command's last stdout line (the same object, checked against the same schema). Requests are answered one at a time, in order, and nothing else is written to stdout. The files are written exactly as by the one-shot command.
- Progress goes to stderr as the one-shot commands write it; a failed request also writes `midstudy-calib: <sentence>` there.
- A request that fails (not JSON, not a valid request, arguments the CLI refuses, a command that fails) is answered `{"id", "ok": false, "error": "<one sentence>"}` (`id` null when the request had no usable one), and the worker carries on.
- End of input exits 0. SIGINT answers the request in flight with `"interrupted"` and exits 1.
- The environment is read for every request as the one-shot commands read it (`MIDSTUDY_CALIB_MOCK` works exactly as there); relative paths are relative to the worker's working directory.

**The server's side** (§4.4):
- Start the worker (`<calib> serve`, with the one-shot commands' working directory and environment) on the first calibration job, not at startup, and keep it for the next ones.
- Send the calibration queue's `run`, `fit` and `light` jobs to it, one at a time (the job id makes a good request id). Read its stderr continuously (the job's progress) and its response line within the job's timeout (600 s); handle the response exactly as the one-shot result.
- `align` (the render path) stays one-shot, so a render never waits behind a calibration.
- Crash: when the worker can't be started, exits, or answers anything but a JSON object with the request's id, kill it (SIGTERM, then SIGKILL after 5 s) and run that job with the one-shot command; the next job starts a new worker. After 3 such failures in a row, use the one-shot command for the rest of the server's life. This covers `--calib "python3 fixtures/stub_calib.py"` too: the stub has no `serve` and exits 2 at once. An `ok: false` answer is the job's failure, not the worker's.
- Timeout: a request still running at the job's timeout fails the job with the one-shot timeout message; kill the worker, and the next job starts another.
- Idle and shutdown: the server may close the worker's stdin after it has been idle for a while (e.g. 10 minutes) to give its memory back (MoGe-2 ViT-L holds about 1.3 GB on the GPU); the next calibration starts it again. On shutdown, close stdin, wait up to 5 s, then kill it.

### 4.4 Server additions (`planner/serve.py`, stdlib only)

`--scenes-dir` (default `scenes/`) and `--calib CMD` (default `uv run --project calib midstudy-calib`; the Nix package passes its own binary). Calibration runs as jobs in **their own queue** (separate from the library queue), one at a time, each with a 600 s timeout, with the server's environment (so `MIDSTUDY_CALIB_MOCK` reaches it). Every mutating route follows §2.9.

| Method and path | Request | Response |
|---|---|---|
| `GET /api/scenes` | | `200 {"scenes": [scene, ...], "trash": [{name, title, created, deleted}, ...]}`, newest first (by `created`, ties by the name's collision suffix as a number: `-10` before `-9`); `trash` lists the deleted scenes |
| `POST /api/scenes` | raw photo body, `Content-Length` required, `X-Midstudy-Filename` required, optional `X-Midstudy-Meta` (base64 JSON `{title}`) | `202 {job, scene: name}` |
| `GET /api/scenes/jobs` | | `200 {"jobs": [job, ...]}`, newest first |
| `GET /api/scenes/jobs/<id>` | | `200` the job object itself, `404` unknown |
| `GET /api/scenes/<name>` | | `200` scene.json + the scene object's fields + `calib` (calib.json without `exif.make`/`exif.model`, or null) + `lighting` (lighting.json as it is, or null without one) + `lighting_status` (`done` with it; else from the scene's newest light job `pending`, `running`, `failed` or `none` (it found no light); else `pending`/`running` while the scene calibrates; else `missing`) + `lighting_error` (string or null); `404` unknown |
| `PUT /api/scenes/<name>` | JSON with any of `title`, `camera`, `camera_source`, `look` | `200` as GET; `saved` stamped unless only `title` changed; camera values and look numbers clamped (§4.8); a `look` replaces only the keys it carries, and a key set to null is removed; unknown keys or bad values `400` |
| `PUT /api/scenes/<name>/thumb` | `{"image": "data:image/jpeg;base64,…"}` ≤ 2 MB | `200 {"ok": true, "thumb_url"}` |
| `POST /api/scenes/<name>/calibrate` | | `202 {job}`: runs `fit` (or `run` on `source.<ext>` when `photo.jpg` is missing); `409` while one is queued or running for that scene |
| `POST /api/scenes/<name>/light` | | `202 {job}` (kind `light`): runs `light` on the calibration queue for a scene without `lighting.json` (§4.8 backfill); the same job again while one is queued or running; `200 {"lighting_status": "done"}` without a job when it has one; `409` while the scene calibrates or without `photo.jpg`. It never changes `scene.json`, the camera, `calib.json` or `calib_status`. Light job ids start `l-` (calibration jobs `c-`); a light job carries `lighting: true\|false\|null` and appears in the jobs list. A calibration newer than the newest light job decides `lighting_status`; an unreadable `lighting.json` counts as missing |
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

**Static:** `/scenes/<name>/photo.jpg`, `depth.png` and `thumb.jpg` are served (`nosniff`). Everything else under `/scenes/` gets `404`: `source.*`, `calib.json` and `lighting.json` (use the API), `scene.json`, `.trash/`, folder listings, and the same paths spelled with `.`/`..`/percent-encoding (§2.9 Paths).

### 4.5 Planner

- **Scenes page** (replaces Rooms): scene thumbnails, newest first, **New scene** (a file input that accepts camera-roll photos on iOS: `accept="image/*"`), per-scene rename and delete. A scene still calibrating shows its photo (once `photo_url` is set) with a spinner and opens when done. `?scene=<name>` opens a scene; without it, the last scene opened on this device, else the Scenes page.
- **The view:** the photo fills the view, contain-fit with letterbox bars; the 3D canvas is registered to it (same aspect, camera from `scene.json`). The photo is drawn **exactly as is**: no tone mapping, exposure or warmth. Look and ACES apply to the furniture only. Pinch or wheel zoom and two-finger or middle-drag pan are 2D (`setViewOffset`), up to 4×; **Fit** resets them.
- **Floor check:** when a scene first opens, and whenever **Adjust floor** is on, a 50 cm grid is drawn on y = 0 out to 8 m, fading with distance. Adjust floor has sliders for camera height (cm), field of view (°) and roll (°); dragging the horizon line sets the pitch (the line follows the pointer, but at most 0.12° of tilt per CSS pixel on a small photo, so the phone at Fit gets fine control). An optional two-tap ruler shows a floor distance in cm; typing the real length of what it measured (**Set scale**, handles `ruler-true`, `ruler-set`) scales the camera height so it reads that length, which fixes the scene's scale (MoGe's metric scale can be 5–15 % off without an EXIF focal length). While the ruler is on, its row (the instruction, then the length field) keeps one height, so the photo doesn't move between the taps. **Looks right** saves the scene (`camera_source: "manual"` if anything changed). **Reset** goes back to `calib.json`'s camera (`auto`). A scene whose `floor.found` is false or whose `calib.source` isn't `moge-2` (or `truth`) opens in Adjust floor with a one-line note ("Check the floor").
- **Items:** as §2.3 and §2.10. A drag keeps the grabbed point of the piece under the pointer (it slides on the horizontal plane through that point); a mouse or pen press on any piece selects and drags it at once, touch keeps "tap, then drag". A new item lands where the ray through the view center hits the floor (or, if that misses, the ray through the center of the lower third), when that point is 1–6 m from the camera; else 2.5 m straight ahead. Missing library items show a placeholder box.
- **Lighting** (§4.8): a scene with `lighting.json` lights the furniture with the light inferred from its photo (ambient light probe, key light, a soft floor shadow that falls on the photo); one without keeps the v1 lights (three.js `RoomEnvironment` plus a key light, no cast shadow). Scene › Look has the controls; Look is saved in `scene.json`.
- **Occlusion:** with a `depth.png`, a full-screen pass writes the photo's depth into the depth buffer before the items draw (colour writes off), so an item fragment is hidden where the photo has something nearer, with a 3 cm tolerance. Depth 0 never occludes. **Occlusion** toggle, on by default when the scene has depth. `depth.png` is metric in the calibration's frame, so when the camera's `height_m` differs from `calib.json`'s (Adjust floor), the depth is scaled by `height_m / calib height_m` first; without a measured floor (`floor.found` false, or a fallback source) it is used as it is.
- **Layouts:** per scene (§2.7), with unsaved-change warnings ("unsaved" means the pieces differ from the layout as saved or loaded, so Remove then Undo isn't). A scene opens with a layout: each device remembers the layout it last had open in each scene and when it chose it (saved, loaded, or none after deleting it); the scene reopens with that one, unless a layout was saved later on any device (`updated`), or the device has never had the scene open: then it opens with the most recently saved layout. So a reload keeps this device's choice, and the phone opens a scene with the layout the desktop just saved. Deleting a layout, a scene or a library item can be undone; deleted scenes are listed under Recently deleted on the Scenes page, with Restore.
- **Render and Compare** (§4.7): in the Renders panel, pick two renders for a full-screen compare: side by side on desktop, a draggable split slider on both, swipe on the phone, and Swap A and B on both (`compare-swap`).
- **Splats** (v1.1): [Spark](https://sparkjs.dev) `2.4.0` (`@sparkjsdev/spark`, `https://cdn.jsdelivr.net/npm/@sparkjsdev/spark@2.4.0/dist/spark.module.js` in the importmap, beside three.js; no build step) draws splat items.
  - An item **draws as a splat** when its library entry's `default_render` is `"splat"` and it has `assets.spz` (preferred: what phones can load) or else `assets.splat`; otherwise as its GLB. A missing or broken splat falls back to the GLB with a non-blocking error (§2.3 Errors).
  - A splat item still loads its GLB, **never drawn** (no colour and no depth: writing depth would cut the splat), for picking, dragging, `worldBounds`, stacking and the contact shadow. So its size and bounds are exactly `dims_cm` (§2.5), as for a mesh. The splat is a child of the item's group: position, rotation and elevation move it, nothing else.
  - **Occlusion** hides splats like meshes: they draw after the photo's depth pass and test against it (same 3 cm tolerance); between items, Spark sorts splats and meshes hide what's behind them.
  - **Colour:** splat colours are photo colours (Idol and SAM 3D bake the light in), so they are not lit or tone-mapped (no ACES); Look's exposure and warmth apply to them as a plain multiplier, so a Look change still moves splats and meshes together, times the room's light (§4.8: `white_balance` and the share of the light the strength and ambient controls keep).
  - **Render** (§4.7): the capture includes splat items, sorted for the capture camera; the keep-room mask covers them (their box is enough, as the mask is dilated anyway).
  - **Shows as** (the library Edit sheet, `PATCH default_render`, §2.8): Splat or Mesh, offered only for items with a splat **and** a real mesh (`sam3d`); not for `idol` (its GLB is a stand-in box), nor for items without a splat. Placed copies switch at once.
  - The contact shadow of a splat item never darkens the splat above its bottom 30 % (nook's depth-only proxy does this).
- **Removed from nook:** orbit, seated / standing / walk, viewpoints, room alignment and picks, shell, hang on wall, retrain, splat rooms, LoD, True colour.

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
getLighting(): Lighting                            // §4.8
setLighting(partial: Partial<LookSettings>): void  // §4.8; live, clamped; the Look saves itself (PUT {look} 0.7 s after the last change, at once on a scene switch or page hide)
resetLighting(): void                              // §4.8: back to the inferred light
getState(): {
  scene: { name, title, camera: Camera, camera_source, floor_found, hasDepth, occlusion, adjustFloor } | null,
  items: Array<{ uid, id, render: 'glb' | 'splat', splats?: number, position: [x, y, z], rotation_y_deg, worldBounds: { min, max }, missing?: boolean }>,
                               // render: what is drawn (§4.5 Splats); splats: the number of splats drawn (splat items only);
                               // worldBounds come from the GLB (the stand-in box for idol), whatever is drawn
  layout: string | null,       // the layout last loaded or saved
  dirty: boolean,              // unsaved layout changes
}
```

Test handles (`data-midstudy`): the Look controls of §4.8, `scene-new`, `scene-file`, `scene-card`, `scene-delete`, `scene-undo`, `scene-restore`, `layout-undo`, `ruler-true`, `ruler-set`, `compare-swap`, `adjust-floor`, `cam-height`, `cam-fov`, `cam-roll`, `horizon`, `floor-ok`, `floor-reset`, `occlusion`, `zoom-fit`, `render`, `render-go`, `keep-room`, `compare`, and from nook `elev-up`, `elev-down`, `elev-value`, `drop`, `lib-add`, `lib-remove`, `lib-undo`, `missing-item`. v1.1: `lib-engine` (the Add form's Model choice: buttons with `data-value` = the engine and `aria-pressed`, in the order `idol`, `sam3d`, `trellis2`, `rug`, labels names only: Idol, SAM 3D, TRELLIS 2, Flat rug), `lib-cost` (its price box, e.g. "$0.10"), `lib-shows-as` (the Edit sheet's Shows as: buttons `data-value` `splat` / `glb`, labels Splat / Mesh, `aria-pressed`). `scene-card` elements also carry `data-scene="<name>"`.

### 4.7 Render

- **Capture:** the full photo frame at the photo's resolution (view offset cleared, no UI): photo plus furniture, Look applied to the furniture only, JPEG.
- `POST /api/render` gains `scene` (required for a reference; `404` unknown) and `layout`. For `nano-banana` with a scene, the server sends `image_urls: [composite, scene photo]` and, unless a prompt is given, the default prompt below. Other models get the composite only, with nook's prompt (§2.6).
- **Default prompt (with the reference):** *"Image 1 is a photo of a room with 3D models of furniture placed in it. Image 2 is the same room as photographed. Make the furniture in image 1 look like it was photographed in this room: realistic materials, lighting, reflections and contact shadows that match the room's light. Keep the camera, the room and everything already in it exactly as in image 2. Keep each piece of furniture's position, size, shape and color. Do not add, remove or move anything."*
- **Output size:** nano-banana/edit snaps to about 1 MP (measured: 2000 × 1125 in → 1344 × 768 out) and the framing drifts by 1–2 % of the width, so the output is never pixel-aligned with the photo. The render is shown at its own size, not upscaled.
- **Keep room exact** (render dialog toggle `keep-room`, **default on** since the live check on 2026-11-05, PLAN.md §8; the hook's `renderView()` still defaults `keepRoom` to false): the request also carries `keep_room: true` and `mask`, a PNG data URI at the photo's size (items white on black, dilated by 3 % of the photo width, more below each item for its shadow). After fal returns, the server writes the output as `<name>-raw.jpg` and runs `<calib> align <scene photo.jpg> <name>-raw.jpg <mask> --out <name>.jpg`; when `applied` is false, `<name>.jpg` is a copy of the raw output and the meta says why. Without keep-room there is no `-raw.jpg`.
- **Meta** gains `scene`, `layout`, `reference: bool` (the scene photo was sent), `keep_room: bool`, `aligned: {applied, inliers, residual_px, reason?} | null` (null without keep-room), `raw_url` (null without keep-room), `out_w`, `out_h` (the result's size). `GET /api/renders?scene=<name>` lists one scene's renders.
- **Mock:** the result is a copy of the input, $0, so align sees the identity and must apply.

### 4.8 Lighting inferred from the photo (added 2026-11-05)

Furniture is lit by the light of the room in the photo: an ambient light probe, one key light with a soft shadow on the floor, and simple controls. Mesh pieces are lit by it; splat pieces (their light is baked into their colours) are colour-matched to it and cast the shadow of their hidden box.

**`lighting.json`** (lighting.schema.json), written by `midstudy-calib fit`/`run` next to `calib.json` (§4.3), rewritten by every recalibration, removed by one that can't infer it:

```json
{ "version": 1,
  "source": "photo" | "truth",
  "frame": "camera",
  "image": { "w": 2048, "h": 1152 },
  "camera": { …the camera block the fit used (calib.json's)… },
  "ambient": { "sh": [[r, g, b], … 9 rows] },
  "key": { "direction": [x, y, z], "color": [r, g, b], "intensity": 2.1, "softness": 0.35, "confidence": 0.8 },
  "white_balance": { "rgb": [r, g, b], "cct_k": 4700 },
  "floor": { "radiance": [r, g, b] },
  "fit": { …diagnostics, free-form… } }
```

- **Units:** three.js 0.180 light units in linear sRGB, for the planner's furniture pipeline (ACES Filmic, exposure 1, then sRGB). A diffuse surface of albedo ρ lit by `ambient` (a `THREE.LightProbe` with these coefficients, intensity 1) and `key` (a `THREE.DirectionalLight(color, intensity)` shining from `direction`) looks as it would in the photo. `source: "truth"` (golden scenes only) is the scenes' own lights.
- **Frame: the camera's**, three.js axes (x right, y up, z towards the viewer, so the camera looks along −z). World = R · camera with R = Rx(pitch) · Rz(roll) of the scene's **current** camera (§4.1). So after Adjust floor the planner rotates the same light again and nothing is rewritten; `camera` only records what the fit used.
- **`ambient.sh`**: 9 RGB coefficients in three.js `SphericalHarmonics3` order, [L00, L1−1 (y), L10 (z), L11 (x), L2−2 (xy), L2−1 (yz), L20 (3z² − 1), L21 (xz), L22 (x² − y²)]: the radiance coefficients `LightProbe` takes (three.js turns them into irradiance with `shGetIrradianceAt`). The key light isn't in it. To the world frame: L00 stays; band 1 is the vector (x: L11, y: L1−1, z: L10) and turns with R; band 2 (zero in v1 fits, but readers must handle it) can be rotated by evaluating the probe's irradiance at a fixed set of directions, turning them, and refitting.
- **`key`**: `direction` is the unit vector **towards** the light (a DirectionalLight's position minus its target), camera frame. `color` is linear RGB with its largest component 1; `intensity` the DirectionalLight intensity. `softness` (0–1) is how soft its shadow is: 0 a hard sun edge, 1 a very diffuse light with only a faint shadow close under the piece. `confidence` (0–1) is how clearly the photo shows one directional light; when it is low the fit has already moved the direction towards overhead and raised `softness`, so the planner uses `key` as given.
- **`white_balance`**: the room light's overall colour (linear RGB, luminance 1) and its correlated colour temperature, for the Look panel's readout and for colour-matching splats. **`floor`** (optional): the median linear radiance of the floor's pixels.

**How the fit works** (calib track; details in `calib/src/midstudy_calib/lighting.py`): the photo is linearised and taken back through ACES Filmic; over-exposed and near-black pixels are dropped. Pairs of pixels on the two sides of a crease in MoGe's geometry (a box's top and front, two walls at a corner; same depth, similar colour, so most likely the same material) give brightness ratios that depend only on the light. A hemisphere-like ambient (brighter from above than from below) plus one key light is fitted to those ratios over a grid of directions, with weak priors on the ambient's up/down gradient and the key's elevation (shading alone barely tells "key high above" from "fill brighter from above"). Level and colour then come from the pixels with two assumptions about rooms: the brighter surfaces (walls, ceiling) have an albedo near 0.8 (the 85th percentile), and the room's materials average out to grey (shades of grey). Measured on the golden scenes and the lounge: `docs/notes/lighting.md`.

**Look** (`scene.json` `look`, saved by `PUT /api/scenes/<name>`; every key optional, missing keys take the default; the server clamps numbers and refuses other keys and types with `400`):

| key | type, range | default | what it does |
|---|---|---|---|
| `exposure` | 0.25–4 | 1 | furniture exposure (v1) |
| `warmth` | −1–1 | 0 | furniture warm/cool tint (v1) |
| `contact_shadows` | bool | true | the soft dark patch under each piece on the floor (v1, now saved) |
| `auto_light` | bool | true | **Auto lighting**: the key's direction and softness follow `lighting.json` (or the v1 key light without one) |
| `light_azimuth_deg` | −180–180 | inferred | where the key light comes from, world frame, seen from above: 0 from straight ahead (the far side of the photo, −Z), 90 from the right (+X), ±180 from behind the camera. Used when `auto_light` is false |
| `light_elevation_deg` | 5–90 | inferred | the key light's height above the floor's horizon. Used when `auto_light` is false |
| `light_softness` | 0–1 | inferred | how soft the floor shadow is: its penumbra widens with the distance from what casts it, tan of the light's angular radius = 0.006 + 0.6 · softness². Used when `auto_light` is false |
| `light_strength` | 0–3 | 1 | multiplies the directional light: the key light's intensity and, with `lighting.json`, the ambient SH's directional part (bands 1–2, capped so that no direction drops below 5 % of band 0). 0 leaves the even ambient only (no shading from any side, no cast shadow) |
| `ambient` | 0–3 | 1 | multiplies the ambient light (the light probe, or the v1 environment and hemisphere lights) |
| `cast_shadows` | bool | true with `lighting.json`, false without | the key light's shadow on the floor |

With `lighting.json`, a light direction away from the inferred one **turns the whole light**: the ambient SH is rotated with the key, by the shortest rotation from the inferred key direction to the new one, so the room's light really comes from there (a mostly-ambient room still responds). At the inferred direction and `light_strength` 1 everything is exactly `lighting.json`.

Moving the light direction or softness turns `auto_light` off and saves the values it set. **Reset** (`light-reset`) is `resetLighting()`: `auto_light` true, `light_strength` 1, `ambient` 1, `exposure` 1, `warmth` 0, `cast_shadows` and `contact_shadows` back to their defaults, and the stored direction and softness removed.

**Planner:**
- **Meshes:** with `lighting.json`, the light probe (rotated to the world frame, then turned and scaled by the controls above) replaces `RoomEnvironment` and the hemisphere light, lit materials taking their diffuse ambient from the probe alone. **Reflections** come from the photo itself: an environment map made by projecting the photo around the room (every direction turned into the camera frame and looked up in the photo; directions behind the camera see the front mirrored, directions past the frame its nearest edge), its pixels taken back to radiance as the fit did (sRGB to linear, ACES undone), times `ambient`, so metal and gloss reflect the room (an environment map from the SH is the fallback until the photo is in), and one `DirectionalLight` comes from the key's world direction with its colour and intensity (times `light_strength`). Its shadow, and that of the ambient's directional part (a piece blocks the room's light from above and from the windows, not its even part: a full shadow keeps band 0's share of the floor's light), falls on an invisible floor at y = 0 (a shadow catcher: three.js `ShadowMaterial` or the same idea) composited over the photo with the furniture, so the photo's own pixels are only ever darkened where a piece's shadow falls and are otherwise exactly as they are (§4.5). Real things in the photo nearer than the floor hide the shadow as they hide the furniture (Occlusion). Contact shadows stay, as an option. Materials keep their own maps; only lit materials are affected. **Unlit materials** (KHR_materials_unlit, the Flat rug's top, the eval probe) keep exactly their colours, whatever the lighting settings (they may still cast a shadow).
- **Splats** (Gaussian splats carry their source photo's light): colour-matched to the room instead of lit, in the splat pass's plain multiplier (§4.5): exposure × warmth × `white_balance.rgb` (the room light's colour, luminance 1) × level, where level = (A·ambient + K·light_strength) / (A + K) with A the probe's irradiance on an up-facing surface and K half the key's (1 at the defaults; without `lighting.json` the same with the v1 lights). No directional term. Their hidden GLB or stand-in box casts the floor shadow through a copy of it that draws nothing (no colour, no depth) but casts.
- **Without `lighting.json`** (an older scene, a fallback calibration): the v1 lights exactly, no cast shadow unless `cast_shadows` is turned on; the controls still work on those lights (`auto_light` then means the v1 key direction).
- **Backfill** (scenes calibrated before `lighting.json` existed): opening a scene whose `lighting_status` is `missing` starts `POST /api/scenes/<name>/light` (the `light` step alone: MoGe-2 on the photo and the fit, a few seconds, $0; no recalibration, the camera and depth stay). The planner keeps the v1 lights meanwhile, polls the scene, and lights the furniture as soon as `lighting.json` is there; Auto lighting then follows it. A scene that is `none` (no clear light) or `failed` keeps the v1 lights; Scene › Look offers **Infer lighting** to try again.
- **Scene › Look** has: Auto lighting (`light-auto`) with Reset (`light-reset`), the light direction as a draggable sun handle or compass (`light-dir`: drag sets azimuth and elevation; it also works by touch), sliders for strength (`light-strength`), softness (`light-softness`), ambient (`light-ambient`), exposure (`look-exposure`) and warmth (`look-warmth`), and toggles for the floor shadow (`light-shadows`) and contact shadows (`contact-shadows`). Changes apply live and save themselves (`PUT /api/scenes/<name>` with `{look}` 0.7 s after the last change, and at once when another scene opens or the page hides), so the scene is never left unsaved by the Look; Save scene is for the camera. On the phone (390 × 844) every control is reachable by touch with targets ≥ 44 px and no sideways scroll.

**Hook** (§4.6):

```ts
type LookSettings = { exposure, warmth, contact_shadows, auto_light, light_azimuth_deg, light_elevation_deg, light_softness,
                      light_strength, ambient, cast_shadows }        // as the table above
type Lighting = LookSettings & {
  source: 'photo' | 'truth' | 'default',     // lighting.json's source, or 'default' without one
  inferred: { azimuth_deg, elevation_deg, softness, direction: [x, y, z], color: [r, g, b], intensity, cct_k: number | null } | null,
                                              // lighting.json's key in the world frame of the current camera (null without one)
  key: { azimuth_deg, elevation_deg, direction: [x, y, z], color: [r, g, b], intensity, softness },  // in use, world frame
}
getLighting(): Lighting          // light_azimuth_deg etc. are the values in use (inferred ones while auto_light is on)
setLighting(partial): void       // live; light_azimuth_deg, light_elevation_deg or light_softness turn auto_light off unless it is given too
resetLighting(): void
// getLighting() also carries status ('done'|'missing'|'pending'|'running'|'none'|'failed', the backfill) and error
```

`getRenderSettings()` keeps its v1 fields; `setRenderSettings({contactShadows})` is the same as `setLighting({contact_shadows})`.

---

## 5. Fixtures and evals

### 5.1 Golden scenes (`fixtures/scenes/`, `fixtures/calib/`)

`fixtures/make_scene.mjs` renders one textured room (oak plank floor, plaster walls, rug, door with casing, window, painting, floor lamp) with three.js 0.180.0 in headless Helium from a known camera under known lights. Each scene has a box **sofa** (2.0 × 0.82 × 0.9 m) and a **table** (1.0 × 0.42 × 0.55 m, top and four legs, turned 12°) at known positions. Same room and objects, three cameras, and two more lightings with the living-wide camera:

| id | size | camera |
|---|---|---|
| `living-wide` | 1600 × 1200 | fov 55, height 1.40, pitch −10, roll 0 |
| `steep-roll` | 1600 × 1200 | fov 65, height 1.60, pitch −25, roll 2 |
| `portrait` | 1200 × 1600 | fov 70, height 1.25, pitch −8, roll −1 |
| `living-cool` | 1600 × 1200 | as living-wide; cool daylight key from the far left, in front of the camera (shadows fall towards the camera); lamp off |
| `living-warm` | 1600 × 1200 | as living-wide; warm evening key from the right, high; dim warm fill; lamp off |

The first three are lit by `DAYLIGHT` (`make_scene.mjs`): a hemisphere light (sky `0xfff6ea`, ground `0xb9a48c`, 1.9), a sun `DirectionalLight(0xfff1df, 2.2)` from (3.2, 5.0, 1.5) towards (−0.4, 0, −3.0) with soft shadows, and a warm lamp `PointLight(0xffd9a0, 1.6, 4, 2)` in the lamp shade. Walls and ceiling cast no shadows (the sun reaches the room from behind the camera).

Files in `fixtures/scenes/<id>/`:
- `photo.jpg`: the photo (JFIF only, no metadata, so ingest passes it through byte for byte).
- `truth.json`: `{version, id, image: {w, h}, camera, depth: {file, w, h}, objects: {sofa, table}, floor_points}`. Each object has `center` (footprint center on the floor), `size_m {w, h, d}`, `rotation_y_deg`, `corners` (8 world points of its bounding box, ordered bottom then top, each ring back-left, back-right, front-right, front-left, front = local +Z; names in `corner_names`), `corner_px` (their §4.1 projection on the photo) and `parts` (the boxes it is built from, with their corners). `floor_points` are open-floor points (`world`, `px`) where `depth.png` is 0.
- `depth.png`: exact depth along the view axis (mm), floor within 4 cm masked to 0, at most 1024 px on the long side.
- `calib.json`: calib.schema.json with `source: "truth"` and the true camera.
- `lighting.json`: lighting.schema.json with `source: "truth"`: the hemisphere light as `ambient.sh` (exactly bands 0 and 1) and the sun as `key`, in the true camera's frame (§4.8); the lamp, a local light, is left out. `truth.json` gains `lights` (the light definitions above, world frame).
- `ids.png`: 8-bit RGB id masks at the photo's size, each object rendered **alone** (no occlusion), antialiased like the photo: R = sofa, G = table; threshold at 128.

`fixtures/calib/<sha256 of photo.jpg>/{calib.json, depth.png, lighting.json}` are copies that the calib mock (`MIDSTUDY_CALIB_MOCK=fixtures/calib`) serves for those photos.

**Self-check:** `evals/py fixtures/check_scenes.py` reimplements §4.1 in numpy and checks every scene against the renders: each object's projected silhouette matches its id mask (IoU ≥ 0.985, bounding box within 1 px), every sofa corner lands on the sofa (≤ 1.5 px), the true camera beats the same camera with roll negated or pitch off by 0.5° or negated (this pins the signs), `depth.png` equals the ray-plane view-axis depth on the sofa's front face and the back wall (median error well under 1 mm; it is *not* the Euclidean distance), open floor is 0, calib.json validates, and the mock copies are identical. It writes marker images to `evals/out/check-scenes/`. Re-running `make_scene.mjs` regenerates everything (its JPEG bytes may differ run to run; it removes the old `fixtures/calib/<sha>/`), and the self-check must pass after it. `--only <id>` renders one scene; `--lights-only` rewrites `truth.json`'s `lights` and `lighting.json` without rendering.

### 5.2 Carried evals

- `npm run eval:pipeline` (`evals/pipeline_offline.sh`): `midstudy-add` against `fixtures/fal`, offline, $0 (§3).
- `npm run eval:library` (`evals/library_api.sh`): the library API, URL fetch rules and spend cap (§2.8–2.9), mocked, $0. Picks free ports unless `MIDSTUDY_EVAL_LIBRARY_PORT` is set.
- `evals/validate_library.py <library.json>` checks any library against §1 and the schema; `evals/py` runs these helpers with pinned deps.

v1.1 adds `npm run eval:splat` (E13, `evals/splat.mjs`, in `eval:all`): an `idol` add through the library API against the mock validates; on golden living-wide a splat probe (a magenta splat box with its stand-in box) and the Idol chair draw as splats at their true size and position, the photo hides the probe behind the sofa, Render's composite and keep-room mask include them, Shows as switches a `sam3d` item, GLB items and a Flat rug look the same with splats in the scene, the add form defaults to Idol at $0.10, and the phone (390 × 844) loads the Idol item's `splat.spz` (≤ 6 MB) within 30 s. `eval:pipeline` adds the `idol` engine and `splat.spz` checks.

The evals track added PLAN.md §6.2 (`eval:scenes-api`, `eval:calib`, `eval:planner`, `eval:occlusion`, `eval:floor`, `eval:render`, `eval:phone`, `eval:all`; see `evals/README.md`). `npm run eval:real` (`evals/real_path.mjs`, not in `eval:all`) is the real path on this Mac: the default `--calib` (real MoGe-2) on the photos in `fixtures/photos/`, the real `midstudy-add` (GLB), fal mocked.

### 5.3 Rules every eval and agent follows

- fal is mocked: `MIDSTUDY_FAL_MOCK=fixtures/fal`, `MIDSTUDY_NO_DOTENV=1` (and `NOOK_NO_DOTENV=1`), `FAL_KEY` unset, and `serve.py --daily-spend-usd 0` unless an eval tests the cap with mock costs. Nothing reads `.env`. Only the main session makes live calls (PLAN.md §8).
- Calibration in fast evals: `--calib "python3 fixtures/stub_calib.py"` or the real CLI with `MIDSTUDY_CALIB_MOCK=fixtures/calib`. `eval:calib` runs the real model.
- Real photos in `fixtures/photos/` are git-ignored and never copied anywhere tracked; `fixtures/photos/private/` is never opened.
- Servers pick a free port and are stopped at the end. Scratch output goes to `evals/out/`.
- Headless browser: Helium (`/Applications/Helium.app/Contents/MacOS/Helium`, or `MIDSTUDY_BROWSER`) with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, driven by `playwright-core`.
