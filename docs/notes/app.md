# App track notes (planner/ and planner/serve.py)

> **Shortcuts, multi-select, Export (2026-11-05, E17 `eval:keys`):** every keyboard shortcut now goes through one
> registry, `planner/keymap.js` (`createKeymap` in main.js, `ctx.keys`). A module registers `{ id, group, label, keys,
> run, when?, priority?, repeat?, inInputs? }`; combos are `mod+shift+/` style (`mod` = ⌘ on a Mac, Ctrl elsewhere;
> letters from `e.key`, punctuation and digits from `e.code`; modifiers match exactly). One keydown listener in
> `input.js` dispatches after the shell's key filter (dialogs, pages, sheets still swallow keys first), skipping
> inputs unless `inInputs`. Several commands may share a key: the highest `priority` whose `when()` passes runs (Esc:
> ruler 20, Adjust floor 10, deselect 0). `describe()` lists gestures (Shift+click, drag) without running them.
> `ui/shortcuts.js` builds the Shortcuts sheet from `keys.list()` (⌘?, ⌘/ or ?), so a registered shortcut is listed
> with nothing else to update; tooltips and keycaps use `keys.lookup(id)`. The engine's keys are in `input.js`
> (`registerEngineKeys`), the workspace's (Delete + Undo, ⌘Z, Esc for Adjust floor, O, ⌘E) in `ui/workspace.js`, `/`
> in the Library. New: ⌘A select all, arrows move 1 cm (Shift 10 cm; ↑ away from the camera), ⌘D duplicate (30 cm
> right), O occlusion, ⌘E export, `/` also opens the Library.
>
> **Selection is a set** in the engine (`getSelection()`, `isSelected()`, `select(uid, { toggle, add })`,
> `selectMany`, `selectAll`); `getSelected()` is its primary (picked last), which the label, grip and height field
> follow, so one selected piece behaves as before and the hook is unchanged. Shift+click toggles a piece (a Shift press
> on a piece waits: a click toggles, a drag lifts); Shift/⌘-click toggles rows in In the scene. A drag on any selected
> piece moves the whole selection; R, the grip and −15°/+15° turn a group about the middle of its positions;
> `nudgeSelected`, Drop to floor, Remove (one toast, one Undo: `restoreItems`) and ⌘D act on all of them. The overlay
> draws a dashed footprint for each non-primary piece; the bar shows "n selected" with the group actions only.
>
> **Export** (`ui/export.js`, the Export tool, ⌘E): `engine.exportImage({ longEdge, type, quality })` captures the same
> passes as a render at the photo's size (or a preset: 2048, 1280, 800 px, smaller than the photo only), as JPEG or PNG,
> and the sheet saves it as a download (Share… on a phone that shares files). Before and after puts the photo next to
> the scene (above it for a wide photo) with small tags. Nothing is sent to the server; the choices are kept in
> `localStorage` (`midstudy.export`). Not in the `window.midstudy` hook (the contract is unchanged); E17 uses
> `window.midstudyCtx.exporter`.
>
> **v2 port (2026-11-06):** the same behaviour in TypeScript: `planner/keymap.ts` with the pure combos in
> `planner/logic/keymap.ts`, the selection set in `planner/logic/selection.ts` (engine.ts keeps the state),
> `planner/ui/shortcuts.ts`, `planner/ui/export.ts` (+ `ui/logic/export.ts`) and the Settings sheet `ui/settings.ts`
> (+ `ui/logic/settings.ts`). `ctx.keys` is part of `UiContext` (ui/seam.ts). The Export sheet opens once its preview
> is captured (v2's capture is asynchronous), so E17 waits for it.

> **Since verify round 2 (see `verify-fix-2.md`):** the Scenes page no longer shows a stray "null" (scenes.js filtered
> nothing into `replaceChildren`); a scene opens with its layout on any device (this device's own choice, else the
> layout saved last anywhere); a wake always gets one frame (Set scale redrew only on the next pointer move in slow
> software rendering); the ruler has its own fixed-height row (no photo jump, the phone's instruction readable); the
> selection label stays left of the phone's lift column; phone toasts sit at the top while a sheet is open; phone
> Compare has Swap A and B; pieces added from a 3D file get a rendered thumbnail (`PUT /api/library/items/<id>/thumb`).
> `serve.py`: APP0 kept only as plain JFIF in client JPEGs, `jpeg_size` steps over RSTn/TEM and an unreadable render
> size is 400, ASCII-only `Content-Length`, a stalled body is 408, the early-413 drain ends in 5 s, a malformed
> `--allowed-host` is refused, the scene API leaves out the camera make and model.

> **Since verify round 1 (see `verify-fix-1.md`):** `serve.py` serves an allowlist only (`/planner/`, `/library/`
> assets, `/scenes/` photo/depth/thumb, `/renders/`), never `/library/<id>/source.*`; strips metadata from client JPEGs
> (render, thumb); restores deleted scenes (`POST /api/scenes/<name>/restore`, `trash` in `GET /api/scenes`); trashes
> deleted layouts; stores layout `title`s; refuses duplicate `Content-Length`, junk `Host`s and any `--costs-file` other
> than `<library-dir>/costs.csv`; answers 411/413 before the body. The planner: drags keep the grabbed point under the
> pointer, a mouse press-drags unselected pieces, the open layout comes back on reload, Undo for layout and scene
> deletes (Recently deleted on the Scenes page), Set scale from the ruler, a fine horizon drag on the phone, one toast at
> a time on the phone, 44 px targets in Compare and the viewer, layout names as typed. The "Known gaps" entry "Deleting
> a scene has no undo" is fixed.

> **Since integration (see `integrate.md`):** three fixes landed. The depth pre-pass scales `depth.png` by
> `height / calib height` after Adjust floor changes the height (occlusion was wrong for manual cameras; E4.15 checks
> it). `serve.py` answers an empty `library.json` for a fresh library folder instead of a 404 console error. The
> overlay SVG (footprint, guide, horizon, ruler) is clipped to the visible photo, so it no longer spills over the
> letterbox. The real path (`npm run eval:real`) passes end to end with real MoGe. The "Known gaps" below still hold,
> except that HEIC through the real `midstudy-calib` is now checked by `eval:real`.

What the app track built on branch `v1` (not committed: the integration agent commits), how to run it, and what is
left. Spec: PLAN.md §4, contract/CONTRACT.md §2 and §4.

## What's here

### `planner/serve.py` (stdlib only)

nook's server with the rooms, the `--scan-api` proxy, `--room-dir`/`--room-file`, flat (scene-less) layouts and the
legacy-layout code removed. Kept as nook had them: the library API and its job queue (§2.8), the URL fetcher (§2.9),
the `X-Midstudy` / Origin / Host rules, path normalisation, the spend cap (renders included), costs.csv.

New (contract §4.4, §4.7):

- `--scenes-dir` (default `scenes/`) and `--calib CMD` (default `uv run --project calib midstudy-calib`). `--calib` is
  `shlex.split` once at startup and always run as an argument list without a shell. Only paths the server made go into
  it (the private temp upload, the scene folder, render files); filenames and titles from clients never do.
- `SceneService`: scenes on disk, `scene.json` writes under one lock, and the calibration queue (its own thread, one job
  at a time, 600 s timeout, the server's environment so `MIDSTUDY_CALIB_MOCK` reaches it). A job's result is the tool's
  last stdout JSON line; on failure the job message is its `error` sentence (or its last `midstudy-calib:` stderr line).
  On success the camera is copied from `calib.json` only when `camera_source` is `auto` or `default`.
- Routes: `GET/POST /api/scenes`, `GET /api/scenes/jobs[/<id>]`, `GET/PUT/DELETE /api/scenes/<name>`,
  `PUT …/thumb`, `POST …/calibrate` (409 while one runs; `fit`, or `run` on a temp copy of `source.*` when `photo.jpg`
  is missing), layouts per scene (`?scene=` required: 400 without, 404 unknown). PUT layout normalises the body to
  layout.schema.json (unknown keys dropped, `uid`/`render`/`rotation_y_deg` defaulted, `scene_name`/`updated` set).
- Delete moves `scenes/<name>/` to `scenes/.trash/<name>-<stamp>/` with `layouts/<name>/` inside as `layouts/`. A queued
  calibration is dropped; a running one's result is ignored, and if the tool re-creates the folder after the move,
  that leftover (no `scene.json`) is removed.
- `calib_status`: `pending`/`running` from the job, else `failed` (last job failed, or no `calib.json` and no job: lost
  to a restart), else `done`. Asset URLs carry `?v=<mtime>`.
- Static: `/scenes/<slug>/(photo.jpg|depth.png|thumb.jpg)` only (regex on the normalised path); everything else under
  `/scenes/` is 404. **Privacy:** the server also refuses `fixtures/photos/` and any image file at the repo root (the user
  drops camera originals with location data there), whatever the spelling.
- Render: `scene` (404 unknown), `layout`, `keep_room` + `mask` (PNG data URI; 400 when missing or not the photo's
  size). nano-banana with a scene sends `image_urls: [composite, scene photo]` and the reference prompt (contract §4.7);
  other models get the composite and nook's prompt. Keep-room writes `<name>-raw.jpg`, runs
  `<calib> align <photo> <raw> <mask> --out .<name>.aligned.jpg` and renames it into `<name>.jpg` only when `applied`;
  any failure (no `calib/`, the stub, a bad exit) is "not applied" with the reason, and `<name>.jpg` is the raw output.
  Meta gains `scene, layout, reference, keep_room, aligned, raw_url, out_w, out_h`; `GET /api/renders?scene=` filters.

### The planner (browser)

| File | What |
|---|---|
| `engine.js` | rewritten. The photo, the locked camera, the furniture passes, items, selection, Adjust floor state, layouts, render capture and mask, all API calls. Its header lists every getter, action and event. |
| `input.js` | rewritten: item drag (Shift = lift), tap, two-finger pinch + pan, middle-drag pan, drag-to-pan when zoomed, wheel / trackpad-pinch zoom, keys. No orbit, no walking. |
| `data.js` | `createScenes` (list, polling while a scene calibrates, XHR upload with progress, rename, delete) + nook's `createLibrary` unchanged. |
| `main.js` | wiring and `window.midstudy` (contract §2.4 carried + §4.6). |
| `ui/workspace.js` | top bar (scene switcher → Scenes page), the tools (Adjust floor, Occlusion, Fit, Render), selection bar + phone lift column (§2.10), the Adjust floor card, overlays (footprint, grip, label, guide line, horizon line + handle, ruler), opening/calibrating card, no-scene card, phone hint; computes the photo's stage. |
| `ui/scenes.js` | the Scenes page (grid, New scene, rename, delete, upload progress, open-when-calibrated) and the always-present file input. |
| `ui/panels/scene.js` | Scene panel: camera card (source, values, Adjust floor…, Calibrate again), Occlusion / grid / contact shadows, Look (exposure, warmth; furniture only) with Save. |
| `ui/panels/renders.js` | Render confirm (preview at 1024 px, model, Keep room exact, prompt), viewer (Sent / Render / Raw), Compare picking, Compare view. |
| `ui/panels/{library,libsheets,inroom,layouts}.js` | nook's, with splat, hanging, rooms and homeserver wording removed. |
| `styles/scenes.css` | new: tools, Adjust floor, horizon, Scenes page, Scene panel, Compare. Dead nook CSS (walk bar, measure banner, size card, Room panel, retrain, rooms list, shell) was removed from the other sheets. |

Deleted: `ui/rooms.js`, `ui/rooms/*`, `ui/retrain.js`, `ui/panels/room.js`, `styles/rooms.css`, Spark from the importmap.

### How it draws (engine.js)

1. **Furniture pass** into a half-float, 4× MSAA target (premultiplied, transparent): a full-screen **depth pre-pass**
   (renderOrder −1000, colour writes off, `depthFunc: Always`) writes `depth.png + 3 cm` as `gl_FragDepth` using the
   camera's own projection matrix (view offset included), then the GLBs, contact shadows and the grid with normal
   depth testing. Depth 0 discards (never occludes). Off when Occlusion is off or there's no depth.
2. **Screen**: the photo through a `NoColorSpace` texture and a shader with no tone mapping or colour conversion (its
   bytes as they are), then the furniture target composited over it with un-premultiply → warmth tint → exposure +
   ACES Filmic (three.js constants, in the shader) → sRGB, clipped to the photo's rectangle (letterbox bars stay bars).
   Both shaders are custom, so screen and capture go through identical maths.
- `depth.png` is decoded in JS (PNG parse + `DecompressionStream('deflate')` + unfilter) because browsers decode 16-bit
  PNGs to 8 bits; it's a `RedFormat`/`FloatType` texture with nearest filtering.
- **Letterbox, zoom, pan**: the stage is the window minus the chrome (workspace's `syncStage`). The photo is
  contain-fitted at zoom 1 and `camera.setViewOffset(s·W, s·H, canvasLeft − ox, canvasTop − oy, canvasW, canvasH)`
  makes the canvas a window onto the photo's rectangle; `camera.aspect` is always W/H. Zoom 1–4× keeps the point under
  the pinch/cursor still; pan is clamped so the photo covers the stage when it's bigger.
- **Projection**: `projectPhoto`, `photoToFloor`, `floorToPhoto`, picking rays and the horizon use contract §4.1 maths
  directly (not three's camera), so they're exact in photo pixels. The golden scenes agree to < 0.001 px.
- **Capture** (render): the same two passes into a W × H target (photo resolution, no view offset, no grid), read back,
  JPEG q0.92. **Mask**: items (and their shadow quads) drawn white with the depth pre-pass on, read back, then O(n) box
  dilation by 3 % of the width (up, left, right) and 6 % downward (shadow), PNG.
- New pieces land per §4.5 (centre of the visible photo, else the centre of its lower third, 1–6 m Euclidean from the
  camera, else 2.5 m ahead), then nook's ring search for a free spot. A library item without a GLB shows as a dashed
  box at its dims ("No GLB").

### Hook notes (contract §4.6)

- `ready` resolves after the first state settles: a scene opened (`?scene=`, else the last scene on this device), or
  the Scenes page shown.
- `openScene(name)` waits for a scene that's still calibrating, then resolves once the photo (and depth) are on screen
  (two frames). It closes the Scenes page. Opening clears placed items and selects nothing.
- `setCamera` marks the camera `manual` unless it equals the saved camera; `resetCamera` goes to `calib.json`'s camera
  (`auto`), or the default (`default`) without one; `saveScene` PUTs `{title, camera, camera_source, look}`.
- `renderView({ keepRoom })` captures and (with keepRoom) builds the mask itself; no dialog. `compare(a, b)` opens the
  Compare view (it fetches the renders list if needed).
- `window.midstudyCtx` (ctx with engine, scenes, shell…) stays for manual checks; evals use `window.midstudy` only.

### Test handles

All of §4.6, each present **once** in the DOM: the tools are built per mode (desktop top bar or phone row) and the
selection bar / lift column / Adjust floor card are rebuilt per mode, never duplicated. `scene-file` (the file input,
`accept="image/*,.heic,.heif"`) is always in the page; `scene-new` lives on the Scenes page; `scene-card` carries
`data-scene`; `scene-delete` is a visible button on each card (it asks to confirm). `keep-room` is the checkbox in the
Render dialog (default off), `render-go` its Render button. `compare` is the Renders panel's Compare button.

## How to run

```sh
nix develop -c npm install            # once (playwright-core, three for evals)
# dev server, fal mocked and calibration stubbed with the golden calibrations ($0, nothing paid):
env -u FAL_KEY MIDSTUDY_NO_DOTENV=1 NOOK_NO_DOTENV=1 MIDSTUDY_FAL_MOCK=fixtures/fal MIDSTUDY_CALIB_MOCK=fixtures/calib \
  nix develop -c python3 planner/serve.py --port 8800 --daily-spend-usd 0 --calib "python3 fixtures/stub_calib.py" \
  --scenes-dir evals/out/dev/scenes --layouts-dir evals/out/dev/layouts --renders-dir evals/out/dev/renders
# then http://127.0.0.1:8800/planner/ ; New scene with fixtures/scenes/<id>/photo.jpg gives an exact camera and depth.
# With calib/ built, drop --calib to use the real midstudy-calib (MIDSTUDY_CALIB_MOCK still skips MoGe for known photos).
```

`serve.py` needs Python ≥ 3.10 (the dev shell's 3.12; the macOS system 3.9 can't parse its annotations).

Dev scripts I used (scratch, git-ignored, in `evals/out/app-build/`): `serve.sh` (free port from 8800, mocks, data dir
`data-<port>/`), `shot.mjs` (golden scene → item → behind the sofa → Adjust floor → keep-room render, screenshots),
`real.mjs` (a real photo through the file input), `pinch.mjs` (CDP two-finger pinch, Fit, Calibrate again),
`compare_dbg.mjs`, `pages.mjs` (Scenes page and panels on both sizes).

Evals (evals track): `nix develop -c npm run eval:scenes-api|eval:planner|eval:occlusion|eval:floor|eval:render|eval:phone|eval:library|eval:all`.
At the end of the app track's session `eval:all` passed E1, E3–E9 (129, 55, 19, 34, 36, 65, 39, 42 checks); E2 is the
calib track's.

## Known gaps / left for others

- **Not tried on a real phone.** iOS Safari: `accept="image/*"` offers the camera roll; HEIC upload works only with the
  real `midstudy-calib` (the stub is JPEG-only). `DecompressionStream` needs Safari ≥ 16.4 for depth.png.
- The real camera original (`fixtures/photos/upper-lounge-camera.jpeg`) went through the UI with the default `--calib`
  (real MoGe-2 on MPS, fal mocked): calibrated in 9.9 s (fov 72.75°, height 1.352 m, pitch −7.84°, roll 0.26°, floor
  found), the grid sits on the floor, a chair and a cube look right in place and the cube is hidden by the sofa; a
  keep-room render applied (2891 inliers, 0.05 px, identity in mock mode). With the stub instead, a real photo opens on
  the default camera in Adjust floor ("Check the floor"). Scratch scenes for this are under `evals/out/app-build/`.
- The §4.5 landing rule can drop a new piece inside real furniture (e.g. inside the golden sofa in `steep-roll`, where
  occlusion then hides it completely). A smarter spot (depth-aware) would help; the spec's rule is followed as written.
- Thumbnails are the plain photo (made on first open), not the photo with furniture.
- "Render again" re-sends the old picture; keep-room is disabled there (its mask would not match).
- Compare compares two renders; comparing a render against the plain photo isn't offered.
- Deleting a scene has no undo in the UI (the server keeps it in `scenes/.trash/`).
- Evals that write to the same `evals/out/<eval>/` folder must not run concurrently (two runs of E9 at once produced
  two scenes and a false failure once; one run at a time passes).

## State machines W1: planner-engine-base (sm1-planner-engine-base)

From `docs/notes/state-machines-plan.md`, package planner-engine-base (guard-only fixes, no contract change):

- **Capture mutex.** `exclusive(fn)` in `planner/engine.ts` chains every capture after the one before (a failure
  doesn't break the chain) and counts `captureBusy` from the call to the settle (`engine.isCapturing()`); `holding()`
  goes through it, so `captureCanvas` and `captureMask` run one at a time (they never nest: `renderViewInternal` calls
  them in sequence). `modelThumbnail` keeps its GLB load outside and puts only its render and read-back (and
  `thumbTargets`, which now disposes the old targets on a size change) inside. `withFullFrame` has an `inFullFrame`
  tripwire that throws if it is entered twice. Before: two overlapping exports differed by 246 levels and left the grid
  hidden; two overlapping keep-room captures left the pieces white (the mask material).
- **Align follow by job id.** `alignRoom` passes the 202's job id to `followAlign(name, jobId)`, which polls
  `GET /api/rooms/jobs/<id>` and reads the room for the poses at the end. The pure step is `jobOutcome(httpStatus,
  status)` in the new `planner/logic/jobs.ts` (TScert, baselined): 404 is lost (the job store never prunes), no answer
  or another error status waits, done/failed end it, any other status waits (the loop's limit ends it as lost). Every
  exit emits a terminal `room` phase: `aligned`, or `align-failed` with the job's message, or with "the alignment was
  lost (the server restarted?)" (lost, a 404 on the room, or the loop running out). The toast only for the room still
  open. Before, a 404 returned silently and the UI stayed "aligning", and 'none'/'done' after a restart read as success.
  `waitForRoom` keeps no overall limit while busy (documented at it).
- **Render loop.** `renderErrorReported` resets when a scene opens (one 'Rendering failed' per scene, not per session;
  its declaration moved up next to `holdFrames`). On WebGPU, `device.lost` reports "The GPU was lost; reload the page"
  (a type guard on `renderer.backend`; re-creating the renderer is deferred).
- **Splat key** (wont-fix): a comment at `setPhoto` that the key relies on a fresh depth DataTexture per photo.
- **Tests.** `npm run test:planner` (`node --test planner/test/*.test.mjs`, picked up by `check:tests`): the
  `jobOutcome` table. `npm run eval:engine-races` (`planner/ui/test/engine-races.mjs`, through the eval lock; not in
  `eval:all`, whose `evals/all.mjs` is the evals track's): overlapping exports, overlapping keep-room captures (the
  POST is refused by `page.route`, nothing is sent), a throwing frame callback counted per scene, and a job routed to
  one "running" then 404. All five checks were red at 3a25cc6 and pass now.
- **Deviations.** `waitForRoom`'s default for a member with no `scene_object` (taken as calibrated) is left as is: the
  fix entry defers it to server-domain, while the plan's seam note gives it to this package; not changed here, to be
  settled with the server's room GET shape.

## State machines W1: planner-ui-shell (sm1-planner-ui-shell)

docs/notes/state-machines-plan.md, package planner-ui-shell. What changed:

- **Phone sheet.** `shell.setDetent` acts only while the sheet is open (`logic/chrome.ts detentAllowed`, TScert);
  openPanel uses the internal `applyDetent`. An awaited Library Place (or a job's Place) that settles after the user
  closed the sheet no longer reopens it at peek. `closePanel` drops a drag still down, and `onUp` returns when the
  sheet is closed, so a late pointerup cannot reopen it. A mode change that closes or opens a panel now calls its
  onClose / onOpen and sends `'panel'` (1440 → 375 with the Scene panel open: `{ id: 'scene', open: false }`).
- **One layer stack.** `shell.pushLayer(kind, cancel) → { remove() }` (idempotent) and `shell.topLayer()`; kinds
  confirm, menu, page, sheet, modal. Confirms, menus and the Scenes page use it, and so does `sheet.ts` (it dropped its
  Esc key filter). One Esc cancels one layer (`logic/layers.ts escTarget`, TScert: in a field it still closes a sheet,
  modal, confirm or menu, never the page) and is recorded so the engine's key filter swallows it: it never reaches the
  keymap (deselect, leave Adjust floor or the ruler) or a lower layer. The engine's filter is now
  `escDone || keyFilters.some(...) || layers.length > 0`: the filters run before the any-layer swallow, so the
  Shortcuts key still closes its sheet and the renders arrows still step. A mode change cancels open menus and
  confirms (a confirm answers its cancel value). `addKeyFilter`'s remover checks `i >= 0`. **This changes v1**: v1 let
  an Esc fall through (close the page, then also deselect; close a confirm, then also the sheet under it). The
  fall-through was the risk, so it goes on purpose.
- **Renders modal.** Not touched here (planner-ui-renders owns renders.ts): until it pushes a `'modal'` layer, its own
  key filter still handles Esc and the arrows when no shell layer is above it; with a confirm or sheet above it, one
  Esc now closes only that.
- **Toasts.** `toast(…, { onGone })`, called once on every exit; the handle's `close()` / `update()` are inert after,
  the action's click does nothing once the toast is closed, and `.toast.is-leaving` takes no pointer (kit.css).
- **Tooltips.** The tip timer rechecks the mode and every mode change hides the tip.
- **Shared helpers.** `ui/epoch.ts uiEpoch(engine)` (`now()`: scene loading / opened / closed / failed; `items()`:
  loading / closed only, so a room photo switch keeps it) and `shell.epoch`, one instance the shell keeps (that is
  also what keeps knip quiet until the other packages import it). `sheet.ts isSheetOpen()` (marked `@public` for knip
  until planner-ui-sheets uses it).
- **Tests.** `npm run test:ui-machines` (`node --test planner/ui/test/machines-*.test.mjs`, in check:tests):
  machines-shell.test.mjs bundles layers.ts, chrome.ts and epoch.ts with esbuild. `planner/ui/test/smoke.mjs` is now a
  runner over `planner/ui/test/sections/*.mjs` (`export async function run(ctx)`; ctx: ev, srv, browser, H (the
  harness), scene, seedScene, open, phone (any size, `setup(context)` for `context.route` holds before load),
  goldenRoom()); `-- --only shell` runs one. The old cases moved unchanged to sections/base.mjs; this package's are in
  sections/shell.mjs.

Deviations: `tscert-ratchet --files … --update` exits before writing (the `--files` path never rewrites the baseline),
and a full `--update` would rewrite every area's entries, so the two new functions were appended to
tscert/baseline.json by hand in its sorted order. The held GET in the Place check is the probe's `model.glb`, held on
the context from before the page loads: the Library's thumbnails load the GLB on their own, so a hold set later finds
it cached. The shell section seeds its own scene (a scene with a saved layout would load the held GLB at start-up).

## State machines W1: planner-gpu-splat-sort (2026-11-07)

The splat layer's CPU sort (the WebGL2 fallback) and its settle(), per docs/notes/state-machines-plan.md:

- `planner/logic/splats.ts` (new, import-free, 4 functions certified and in tscert/baseline.json): the CPU sort's
  state `CpuSort {worker none|up|down, pending {id,key,version,superseded}, sortedKey, setChanged}`, `cpuSortAction`
  (none / here / post / wait), `cpuReplyVerdict` (ignore / drop / apply; a reply overtaken by a main-thread sort is
  dropped), and `sortKey` (now with camera.near; far stays out, neither sort uses it).
- `planner/gpu/splat-layer.ts`: a set change, a settle() and a down worker sort on the main thread (sort-cpu.ts on a
  copy of the set the layer keeps), so a new set never draws a blank frame; camera and transform changes still go to
  the worker. A worker that fails to load, sends an unreadable message or answers with a fatal error is down for good
  (terminated, one warning, onChange); a non-fatal error (the worker's version check) only drops and re-decides. After
  every apply or drop the layer decides again for the latest key. settle() resolves or rejects at once: the waiter
  queue and its 30 s timeout are gone (no caller passed timeoutMs). add() of an existing uid rebuilds once. After
  dispose() add/remove/render/update throw and settle rejects. `stats().cpuWorker` says none/up/down.
- `sort-messages.ts`: 'error' carries `fatal`. `sort.worker.ts`: try/catch around 'set' and 'sort'; a failed set is
  remembered and answers later sorts fatal.
- Demo: `?sortWorker=throw-load|throw-sort|throw-uncaught` (Blob-URL workers), `addItem({settle:false})`,
  `capture({settle:false})`, `settleMs`, `nudgeSplats`; window 'error'/'unhandledrejection' reject `ready`.
  check.mjs: a new section (`--only=worker`, also in `webgl`), WG.06–WG.10: red before (30 s settle rejections, blank
  first frames), green after. The perf notes now say the first splat frame includes the main-thread sort and the
  worker's time shows only once a frame moved.
- Tests: `npm run test:splats` (planner/gpu/test/*.test.mjs, in knip's entries).
- Deviation: the worker gets a 'set' as a structured-clone copy (the layer keeps its own), as designed; a fatal
  'error' marks the worker down whatever its id (any fatal answer means it cannot sort), not only for the pending id.

## State machines W2: planner-engine-scene (2026-11-08)

Scene-scoped async work in `planner/engine.ts`, per docs/notes/state-machines-plan.md:

- **Open/close.** The open records its target even on a room switch (`getSceneLoad().name`, `loading` stays false). A
  press on the photo being opened is dropped. `waitForScene` takes `alive`, and a superseded open or recalibrate stops
  polling. `saveScene` and `recalibrate` check `sceneToken` after their awaits. `ScenePhase` types the 'scene' event.
- **Layouts by scope.** `scopeGuard()` / `stillIn(g)` (`scopeGen` bumps on a non-switching open and on close, not on a
  room photo switch) guard load, save, delete, restore, list and `setRoomScale`. `rememberLayout` takes the scope.
- **Dirty.** Explicit baselines: `markLayoutCleanAs(sig)`, from the layout as sent (save) or as landed (load);
  `quietly` recounts at zero, so an edit made while quiet counts.
- **Ruler.** `resetRuler()` (one event, inactive); the ruler needs Adjust floor; every point change makes a new array,
  which is how `setRoomScale` sees a point moved during its PUT.
- **Look.** `lookPending` remembers the scene the change was made in; PUTs chain (`lookChain`); `saveScene` waits for
  the chain. pagehide and hidden still send at once.
- **Renders.** `id` on every 'render' event; a request with no answer reports `renderLostText()` with `lost: true` and
  refreshes the list at 5, 30 and 90 s. `listRendersInternal` is query-scoped and latest-wins.
- **Lists, startup, camera, recalibrate.** Latest-wins scene and room lists; `startScene` yields to an open the user
  made during startup; `sourceAfterReset` (camera.ts); `recalibrate` follows its job by id (404 = 'recalibrate-failed').
- **Tests.** Sections after `align` in `planner/ui/test/engine-races.mjs`; two tables in `planner/test/states.test.mjs`.

Deviations: `recalibrate` resolves null when superseded (it was the scene summary). A `'failed'` render event also
carries `lost: true` (the seam text asks for it; the fix's design did not). `followLostRender` allows one second of
slack, as `created` has whole seconds. The baseline entries were added by hand in sorted order (`--files --update`
does not write, as W1 noted). planner/bus.ts needed no change: EngineEvents is in engine.ts.

## State machines W3: planner-engine-items (2026-11-08)

Pieces and the room view in `planner/engine.ts`, per docs/notes/state-machines-plan.md:

- **Placement chain.** `placed(fn)`: park, unpark, re-project and a layout load's clear-and-add run one at a time.
  `projectToPose(r)` re-projects after a load lands. A pose change ends a drag. `floorPlanShown` resets on close and on
  a non-switching open; Align photos needs the plan shown.
- **Adds and rebuilds.** `pendingUids` reserves a uid during its add. Adds and rebuilds wait for captures
  (`capturesIdle`), then attach in one synchronous step. `r.sig` is written only after a rebuild attached, so a failed
  one is retried. An add that lands after a library change is rebuilt (`syncPiece`).
- **Drag.** A second begin ends the first; `resetDrag`; begins are refused with the ruler or Align photos on; `selected`
  is gone (`primary()`), and removal goes through `setSelection`.
- **Library.** Latest read wins; `libraryReady()` waits out reads that start meanwhile. Thumbnail PUT 503 or no answer:
  retried on the next read. The file caches evict only their own promise.
- **Tests.** Sections before `scene: open and close` in `planner/ui/test/engine-races.mjs` (`--items` stops after them).

Differs from v1 (contract §0): a failed library re-read keeps the previous list; v1 emptied it and every piece of the
next layout went missing. The first read failing still leaves [].

Additions and limits: a load that finds the photo unplaced parks first (its pose can go while it waits in the chain).
`syncPiece` drops a rebuild in flight when the library goes back to what the piece draws. `getItemGroupCount()` is a new
probe for the orphan check. A load in the chain waits for an earlier load's GLB fetches, even a cancelled one. The
capture-wait on attach has no red test (the window is too narrow to hit reliably). The new room saga stays deferred.
## State machines W3: planner-core-stores (2026-11-08)

The scenes and library stores in `planner/data.ts`, per docs/notes/state-machines-plan.md. Tests: `planner/test/stores.test.mjs`.

- **Scenes poll.** A failure with a fresher 'scenes' answer behind it does nothing; otherwise offline and the 10 s retry
  (`pollDelay`). `listScenesInternal({ report })`: only an outage's first failure is reported.
- **Calibration shadow.** `announced` gives each finish one event, whichever of the poll or the upload's answer lands
  first; a listing prunes what it no longer has, except busy entries.
- **Library jobs.** Answers are sequenced (`freshAnswer`); a job an in-flight answer may predate is kept (`mergeJobs`,
  `trackedAt`). A busy job missing from a fresh answer gets one 'job-failed' with `jobLostText`, a reload and a spend read.
  Backoff with `jobsPollMs`; one report per run.
- **API probe.** An undecided probe retries every 10 s, at most 5 times; only a first probe can set `api` false.
- **Upload.** `xhr.onabort` rejects and reports. Nothing calls abort today.

Deviations and notes: `jobChange` now needs a busy 'before' (a narrowing from v1; no differential test covers it).
`listScenesInternal` was already latest-wins inline from W2 (`scenesListGen`), so only `{ report }` was added and
`freshAnswer` is used by the jobs poll alone. The brief says both "10 s after 3 failures" and "from the fourth": the
fourth failure in a row is the first followed by 10 s. A jobs failure older than an applied answer is not counted as an
outage. test:planner already existed (W1). Baseline entries added by hand, sorted.
## State machines W3: planner-ui-workspace (2026-11-08)

`planner/ui/workspace.ts` and friends, per docs/notes/state-machines-plan.md:

- **Undo.** `lastRemoved` carries `ep` from `shell.epoch.items()`; `edit.undo` asks `undoUsable`, and an items() move clears
  the slot (a room's photo switch does not). The undo closure restores once. `ctx.workspace.removeWithUndo(uids)` is the
  one channel; In the scene's Remove goes through it.
- **Height +/−.** The repeat is tied to the press's piece and ends with its button or selection; `pressed` clears only
  when the pointer leaves while down.
- **Chip.** `rendering` is `{ n, t0 }` (`renderStarted`, `renderEnded`), so it stays until the last render ends.
- **Drags.** The horizon and ruler handle drags end when their mode goes off, in the 'adjust' / 'ruler' listeners and in
  pointermove.
- **Adjust floor.** One `floorBusy` latch for Looks right and Set scale, buttons disabled from it. Looks right says and
  closes nothing if the photo changed or Adjust floor was left during the save.
- **Tests.** `planner/ui/test/machines-workspace.test.mjs`, `planner/ui/test/sections/workspace.mjs`.

Deviations: the undo closure also checks `epoch.items()`, and each removal's toast closes when the items epoch moves (the
design only cleared the slot, which left a live Undo button that could restore into another scene). `applyTrue` also
checks `floorBusy`, so Enter can't rescale a scene's camera during a Looks right. The chip counts rather than keys on the
render event's `id`, as the design says; the seam's note about keying on the id is not needed for a count. The Renders
panel half of the render fix is planner-ui-renders'.
## State machines W3: planner-ui-renders (2026-11-08)

`planner/ui/panels/renders.ts`, `planner/ui/logic/renders.ts`:

- **run().** Captures `shell.epoch.now()`. Settling after the epoch moved drops only its own row; a failure is one toast
  "A render of <title> failed", a success (and its not-aligned toast) shows nothing.
- **A request with no answer.** `failureReason` names 'the connection dropped'; the row reads "May still finish" rather
  than "Not charged", and Retry's confirm says the first may have finished.
- **Viewer** by name (`viewerIndex`). **openConfirm** rechecks the epoch after the capture and the past-picture load.
  **Picks** pruned on 'renders' (`prunePicks`). **The modal** is a shell 'modal' layer; Esc comes through the stack, the
  filter keeps the arrows, gated on `topLayer() === 'modal'`.
- **Tests.** `machines-renders.test.mjs`; `sections/renders.mjs` (holds POST /api/render).

Deviations: no 60 s list refresh in the panel. The engine's `followLostRender` (W2) already asks again at 5, 30 and 90 s,
so a second timer would only duplicate it; the section checks the engine's GET. `moved()` also removes its own row if it
is still listed (a run's photo switch keeps the list; the row would otherwise stay "Rendering…" forever). "Not charged"
on a lost row was false, so the row's line changed too (the brief named only the Retry confirm).
## State machines W4: planner-ui-sheets (2026-11-08)

- **Export.** One `exporting` promise across sheets; a run closes its own handle; a sheet opened during a run has Save off
  until it ends. `open()` returns after the capture if any sheet opened meanwhile.
- **Settings.** A `saving` latch shared by Enter and Save; a save closes its own handle; same `isSheetOpen()` check.
- **Product page.** A paste during a read stays in the box with "Still reading the last one; paste again in a moment".
  `seq` is gone. The bookmarklet's reset timer is cleared before a new one.
- **Add / Edit sheets.** `adding` holds the sources in flight (link, or file name|size|lastModified); the 'spend' listener
  goes with the Add sheet.
- **Library add.** Scoped to `shell.epoch.items()`: no select or toast after it moved, the Undo does nothing, and the phone
  detent drops to peek only while the Library is the open panel.
- **Tests.** `planner/ui/test/sections/sheets.mjs`.

Deviations: `lib.addFromUrl`, `addFromFile` and `edit` already report their failures, and main.ts toasts every engine
error, so a failure after closing the sheet was never hidden; the planned toast would be a second one. `toastIfClosed`
toasts only an error nothing reported yet. The 'spend' listener count wraps `lib.events` (a Bus) directly: it is not an
EventTarget, so the planned wrap of EventTarget.prototype would see nothing. A paste during a read lets the browser's paste
happen (no preventDefault), so the page does stay in the box as the design says.
