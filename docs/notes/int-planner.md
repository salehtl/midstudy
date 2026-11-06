# int-planner (v2 Phase 3): the planner half integrated

Branch `v2-int-planner` (worktree `.claude/worktrees/rf-int-planner`), from `v2` at `979677c`. The plan is
docs/REFACTOR.md; what the tracks built is docs/notes/engine.md and docs/notes/ui.md (both merged here) and
docs/notes/gate-1.md. The backend half (server, CLI, kernels-hardening) is integrated in parallel on another branch;
every eval here ran on the **legacy server** (`python3 planner/serve.py`, the harness default). Everything below was
run on rabbit on 2026-11-06 with fal mocked, headless Chrome from `$PUPPETEER_EXECUTABLE_PATH` (through the harness),
never Helium, every eval through `scripts/eval-lock.mjs`. Nothing was pushed.

## What merged

`git merge --no-ff`, in this order:

| # | Branch | Tip | Merge | Conflicts |
|---|---|---|---|---|
| 1 | `v2-engine` | `434033d` | `4a5e168` | none |
| 2 | `v2-ui` | `4c3fa42` | `3f494a9` | `tscert/baseline.json` (shared-append, both from an empty list): the union, sorted as `--update` writes it, 149 + 195 = 344 functions |

The merged tree built, linted and passed knip, but `check:types` failed with 9 errors in `planner/main.ts`: every
area's `mount(ctx: UiContext)` refused main.ts's context, because the engine's `events` was a plain `EventTarget` and
the seam's `Engine` declared typed listeners. That is where the work started.

## What changed, and why

### 1. The seam meets exactly (`8f0509e`)

| What | Before | Now |
|---|---|---|
| The UI's view of the engine | `ui/seam.ts` declared its own `Engine`, `ScenesStore`, `LibraryStore`, their events and every data shape (a trust boundary: main.js passed untyped objects) | `ui/seam.ts` re-exports the real types and helpers (`Engine` = `typeof engine`, `Library`, the wire types, `dimsText`, `quiet`, `CAMERA_RANGE`, …) and declares only `UiContext` and the one area API anything uses (`workspace.setAdjust`). `main.ts` builds `ctx: UiContext`, and `areas` is typed `{ mount(c: UiContext): void }`, so tsc checks the UI against the real engine and stores |
| Events | engine and stores: `EventTarget` + `CustomEvent`, read with `e instanceof CustomEvent` and `Reflect.get`; the shell: the UI's typed `Bus` | `planner/bus.ts` (moved from `ui/bus.ts`, unchanged): `engine.events`, `scenes.events` and `lib.events` are typed `Bus`es, exposed listen-only as `Events<EngineEvents>`, `Events<ScenesEvents>`, `Events<LibEvents>`. Every listener gets `CustomEvent<Detail>`; main.ts's toast/error listeners read `e.detail` directly. `ui/test/bus.mjs` checks the Bus dispatches as an EventTarget (order, a listener added twice, cancel, removal during dispatch, a throwing listener reported through `reportError`) |
| The server's JSON | engine: `JsonObject` / `Record<string, unknown>` (lenient, read at literal keys); UI: its own structured declarations of the same answers | **`planner/wire.ts`**: one tolerant shape per answer the engine, the stores and the UI share (`LibraryEntry`, `LibraryJob`, `TrashedItem`, `Spend`, `SceneSummary`, `CalibInfo`, `TrashedScene`, `SceneCreated`, `LayoutSummary`, `RenderMeta`), each with a reader. A value that has the shape is kept **as it is** (so the hook's `getLibrary()`, `listRenders()`, `listScenes()` still hand back the server's objects, contract §2.4); a field of the wrong type is read as absent (the reader returns a copy without it); an entry without what it can't do without (an id, a name, a render's URLs) is left out. The engine reads them where the answers arrive (library.json, `/api/scenes`, `/api/layouts`, `/api/renders`, `POST /api/render`) and the stores likewise (jobs, trash, spend, the upload's 202, PATCH and restore) |
| `captureComposite` | `Promise<Shot> & Shot` (a Phase 2 bridge: the shot's fields on the Promise, for the legacy renders.js) | `Promise<Shot>`, the capture made at once inside the Promise's executor (a capture that can't be made rejects) |
| Small type gaps | `getItem(uid: string)` while the UI passes `string \| null`; `scenes.getScene(name: string)` likewise; `postRender`'s `prompt` under `exactOptionalPropertyTypes`; toast kinds `string` vs the shell's `'info' \| 'ok' \| 'error'` | `getItem` / `getScene` take `string \| null`; `prompt?: string \| null \| undefined`; `ToastKind` lives in `logic/messages.ts` and both the engine's 'toast' event and the shell use it; `getScene()` is a typed `SceneInfo` (the scene object, `calib: CalibInfo \| null`, w, h, camera, camera_source, hasDepth) |
| Dead API | `ctx.renders` (openConfirm/openViewer/openCompare/getPending and an EventTarget nobody listened to), `ctx.scenesPage`, `ctx.library`, `ctx.workspace.requestRender`; the scenes store's 'upload' event (no listener), `lib.estimate`, `lib.refreshTrash` | removed (no caller anywhere: UI, main, evals, the webgpu spike) |

### 2. No duplicate logic, TypeScript only (`72a2162`)

**The kernels compute the contract's numeric rules; the TypeScript no longer does.** The engine track had kept
certified TypeScript twins of the kernels' small maths (its decision: "Clamps, wraps, rounding and the other small
maths are certified TypeScript in logic/ (the kernels have them too)"). Now each exists once, in Rust (which is also
what the Lean proofs and the Rust tests cover):

| Rule | TS twin removed | Now |
|---|---|---|
| Camera ranges, default, clamp (§4.1); setCamera's merge | `logic/camera.ts` `CAMERA_RANGE`, `DEFAULT_CAMERA`, `clampCamera`, `mergeCamera` | engine.ts `clampCamera(json, base)` reads the fields (a non-number is NaN) and calls the kernels' `clampCamera`; the merge is `clampCamera(p, cam)` (NaN takes cam's). `CAMERA_RANGE` is re-exported from `core/js/web.ts` |
| Occlusion depth scale (§4.5) | `logic/camera.ts` `depthScaleOf` | kernels `depthScale` |
| Look clamps and defaults (§4.8) | `logic/look.ts` `numOrNull`, `azOrNull`, and `clampNum` uses | `lookFrom`, `patchLook` take `Kernels` and call `clampLook` (`lookNum`) |
| v1's `round(v, n)`, `wrapDeg`, `wrapAz` | `logic/num.ts` `round`, `wrapDeg`, `wrapAz`, `clampNum` | `logic/num.ts` `Kernels` (roundTo, wrapDeg, wrapAz, clampLook), passed by the shell to `lookFrom`, `patchLook`, `lightingReport`, `roundAll`, `layoutSig`, `docItem`, `viewReport` (the "trigonometry comes in as parameters" pattern both tracks used; TScert certifies it) |
| Elevation range and setElevation's rounding (§2.10); the rotate step | `logic/num.ts` `clampElev`, `elevationOf`, `turnBy`; the UI's `elevMeters` clamp | kernels `clampElevation`, `roundTo`, `rotateBy`; the UI's height field only rounds to the cm (`setElevation` clamps) |
| Warmth tint | `logic/look.ts` `warmthTint` | the kernels' tint, read as `splatMultiplier(warmth, 1, [1, 1, 1])` (× 1 is exact) |
| Horizon drag gain and row (§4.5) | `ui/logic/workspace.ts` `horizonDragRow` | kernels `horizonDragGain`, `horizonDragRow` |
| The sun dial's azimuth wrap and elevation range (§4.8) | `ui/logic/sundial.ts` `wrapAz` (wrapDeg semantics), `clampEl` | `DialMath` (sin, cos, atan2 from Math; `wrapDeg` and `clampLook('light_elevation_deg')` from the kernels) passed to `spot`, `fromPointer`, `dialKey`, `lightWords`, `lightValueText` |

What stays TypeScript is presentation arithmetic the kernels don't have: text with `toFixed`, CSS pixel positions,
SVG numbers (the dial's `r1`, the icons' `round3`), the view's pixel maths (no kernel computes it), sizes and prices.

**The UI no longer re-implements `planner/logic`:**

| UI twin | Now |
|---|---|
| `ui/logic/dates.ts` (`clockText`, `dayDateText`, `shortDateText`) and `panels/common.ts` `clock`, `dayDate`, `shortDate` (the same Date reading as data.ts) | gone; the panels use data.ts's `clock`, `relDate` (v1's relDate is the panels' dayDate exactly) and a new `shortDate`, formatted by `logic/text.ts` (`clockText`, `relText`, new `shortText`) |
| `ui/logic/layouts.ts` `pretty` (= `prettyLayout`) and `checkName`'s injected slug test | gone: the panel's names are `engine.layoutDisplayName` (which already falls back to `prettyLayout`); `checkName` imports `isSlug` from `logic/layout.ts` |
| `ui/logic/scenes.ts` `isCalibrating` (= `sceneBusy`) | `sceneBusy` from `logic/scenes.ts` |
| `ui/logic/library.ts` `itemName` (= the engine's name-or-id) and the same expression inline in libsheets and common | `libName` from `logic/library.ts` (now on `{ id, name? }`), also used by the engine for placed pieces; `placedMark`'s "cm up" is `upText` |
| `ui/logic/libforms.ts` `Dims` | `DimsCm` (`logic/text.ts`) |

**Dead code removed:** v1 export names nothing imports (`round`, `wrapDeg`, `clone`, `isNum`, `LIBRARY_URL`,
`DEFAULT_CAMERA`, `clampCamera`, `LOOK_DEFAULT`, `prettyLayout`, `SLUG` exports; data's `MODEL_EXT`; `logic/look.ts`
`LOOK_DEFAULT`), the `@public` tags that hid them from knip, and twenty engine members no code, eval or branch calls
(`three`, `getScenesList`, `getCalibCamera`, `getStageRect`, `getDirty`, `getItemBounds`, `getLook`, `getLayouts`,
`getLayoutTitle`, `getLightingStatus`, `saveThumbnail`, `clearRuler`, `refreshLayouts`, `setLayoutName`,
`captureMask`, `settleSplats`, `toast`, `wake`, `projectPhoto`, `clientToPhoto`; the functions stay where the engine
uses them), and the write-only `layoutNames`. Engine types only the engine uses are no longer exported.

**TypeScript only:** no `planner/**/*.js` remains (49 `.ts` files). `tsconfig.planner.json` drops `allowJs`/`checkJs`
and the `.js` include; knip's `planner/**/*.js` ignore and `{ts,js}` globs go; `scripts/build.mjs` builds
`planner/main.ts` and `*.worker.ts` only; `eslint.config.js`'s comment says so. `tsconfig.planner.json` still lists
`core/js/web.ts` (the engine's request: keep it or make it a project reference): kept, because a reference needs the
core-web area to emit declarations and every area is `noEmit`.

**Tests in a gate:** `npm run test:ui` (the UI logic against v1 and the bus), `npm run eval:ui-smoke` (the UI's
browser smoke test: it starts a server and a browser, so it is an eval and goes through the lock; not in `eval:all`)
and **`npm run check:planner`** (in `npm run check`, after tscert): runs `test:engine` and `test:ui` (they load the
wasm kernels; the check builds the wasm first).

### 3. A start-up race the kernels' rounding exposed (`d67d85a`)

Round 1 of the evals (on `110bbb6`) passed everything but E13: its first run missed a timing check (E13.38, see the
evals), and its re-run failed "no page errors" (E13.48): `TypeError: Cannot read properties of undefined (reading
'roundTo')`, from the engine's `resize` listener → `emitView` →
`getView` → `viewReport` → the kernels' `roundTo` (stack in `evals/out/int-planner/prefix-round1-splat-rerun.log`). The
listener is registered while the module sets up, before it awaits the kernels; a resize in that window (a phone
context starting) reached a kernel the wasm hadn't loaded yet. With v1's `round` in TypeScript that path never
needed the kernels. Fix: `emitView` emits only once `kernelsLoaded()` (nobody listens before: the UI mounts after
the kernels and reads the view then); the resize's own work (renderer size, targets, view offset) still runs.
Checked both ways with resize events fired every millisecond from the first script, 6 loads × desktop and phone
(`evals/out/int-planner/resize-race.mjs`, scratch): without the guard both page kinds throw, with it neither does.
The same check is now part of `eval:ui-smoke` (3 loads each). Every other engine path that runs before the kernels
(the input wake-ups, `error`/`unhandledrejection`, `pagehide`) touches no kernel; everything else runs after the UI
mounts, which is after the kernels. Both eval rounds below ran on the tree with this fix.

### TScert

`tscert/baseline.json` 344 → **320**: 26 entries removed on purpose, every one a deleted duplicate
(`camera.ts#(init)`, `#clampCamera`, `#depthScaleOf`, `#mergeCamera`; `look.ts#(init)`, `#azOrNull`, `#numOrNull`,
`#warmthTint`; `num.ts#clampElev`, `#clampNum`, `#elevationOf`, `#round`, `#turnBy`, `#wrapAz`, `#wrapDeg`;
`ui/logic/dates.ts#(init)`, `#clockText`, `#dayDateText`, `#pad2`, `#shortDateText`; `ui/logic/layouts.ts#pretty`;
`ui/logic/library.ts#itemName`; `ui/logic/scenes.ts#isCalibrating`; `ui/logic/sundial.ts#clampEl`, `#wrapAz`;
`ui/logic/workspace.ts#horizonDragRow`), and 2 new (`logic/look.ts#lookNum`, `logic/text.ts#shortText`). Every
function whose signature changed (`lookFrom`, `patchLook`, `lightingReport`, `roundAll`, `layoutSig`, `poseText`,
`docItem`, `viewReport`, `validDims`, `libName`, `checkName`, the dial's functions, `elevMeters`) certifies:
**320/320**. `tscert/config.json` already had `planner/ui/logic/**`.

## Checks (run here, on the tree as committed: `d67d85a` and later commits that touch only notes)

| Check | Result |
|---|---|
| `npm run build` | ok: `planner/dist/app.js` 378,295 B ("369 kB"; 371 kB right after the merges), 4 chunks, the worker; no CDN warning |
| `check:ownership` (`MIDSTUDY_TRACK=int-planner`) | ok: 78 changed paths, all owned (int-planner owns `**`) |
| `check:gen` | ok |
| `check:types` | ok: no errors in planner, core-web, core-node, contract (the planner area has no `allowJs` now) |
| `check:lint` | ok: 51 `.ts` files, no problems (no `any`, `!`, casts but `as const`, ts-comments) |
| `check:dead` | ok: knip, no unused files, exports or dependencies (with `planner/**/*.js` no longer ignored) |
| `check:tscert` | ok: **320/320 certified**, all 320 baselined (24 files) |
| `check:planner` (new) | ok: engine logic vs v1 11/11 groups; UI logic vs v1 204,019 checks, no difference; bus 5 cases |
| `npm run test:engine`, seed 7, N 20,000 | 11/11 groups pass |
| `npm run test:ui` (logic-vs-v1), seed 12345, 20,000 rounds | 1,020,019 checks, no difference from v1 |
| `npm run eval:ui-smoke` (through the lock) | **41/41** (the ui track's 39 + the two start-up checks) |
| `core/crates/wasm-web/tests/v1-sync.mjs` | PASS: "28 with planner/ gone" (it already handles the cutover) |

## Evals (legacy server, bundled planner, headless Chrome; each through the eval lock)

`evals/out/int-planner/summary.txt` (rounds A and B) and `summary-pre-fix.txt` (round 1, before `d67d85a`). Load
averages were 14–47 throughout (other agents' work); every wall time includes waiting for a lock slot.

| Eval | gate-1 / Phase 2 | Round 1 (`110bbb6`) | Round A (`d67d85a`) | Round B (`d67d85a`) |
|---|---|---|---|---|
| E3 planner | 56 | 56/56 | **56/56** | **56/56** |
| E4 occlusion | 21 | 21/21 | **21/21** | **21/21** |
| E5 floor | 35 | 35/35 | **35/35** | **35/35** |
| E6 render | 37 | 37/37 | **37/37** | **37/37** |
| E9 phone | 49 | 49/49 | **49/49** | **49/49** |
| E11 ux | 29 | 29/29 | **29/29** | **29/29** |
| E12 ux2 | 27 | 27/27 | **27/27** | **27/27** |
| E13 splat | 51 | 50/51 (E13.38), re-run 50/51 (E13.48) | **51/51** | **51/51** |
| E16 lighting | 57 | 57/57 | **57/57** | **57/57** |
| E15 product-ui | 135 | 135/135 | **135/135** | **135/135** |

Round 1's two E13 failures: E13.38 (the Library row's "…" button never became "stable" for Playwright within 20 s,
at load 28–47 with a splat in view; the eval's own comment warns of seconds-long frames on SwiftShader) passed on the
re-run and in both later rounds; E13.48 was the start-up race above, fixed in `d67d85a`. Rounds A and B: 497/497
each, every eval on its first run.

## Performance: E17's planner metrics against v1's baseline

`npm run eval:perf -- --only load,scene,edit --compare evals/perf/baseline.json` through the lock, **not exclusive**,
on `d67d85a`, 5 runs + 1 warm-up (`evals/out/int-planner/perf.log`, results `perf-results.json`). The baseline is v1's
(f-perf, mean 1-minute load 8.1); this run's mean load was **20.8** (36 by the end of the edit suite). Three edit
metrics came out WORSE in that run (`add_item_glb_textured` 3.04, noise 153 %; `drag_frames_p95` 9.15, noise 67 %;
`render_capture_server` 1.80, the Python server's own share), so the edit suite was re-run once, as a timing failure
must be (`perf-edit-rerun.log`, mean load 21.5): **no regression beyond the allowance**, all three back to 0.90, 1.15
and 1.00. Ratio = now / v1 (median); E17's verdict uses its allowance (10 % + the metric's noise).

| Metric | v1 baseline | Now | Ratio | Verdict |
|---|---:|---:|---:|---|
| planner_load_desktop | 1.80 s | 1.43 s | **0.79** | same (allowance +82 %) |
| planner_load_desktop_warm | 1.79 s | 1.52 s | **0.85** | same |
| planner_load_phone | 1.76 s | 1.59 s | **0.90** | same |
| scene_open | 842.9 ms | 119.1 ms | **0.14** | **better** (7.1×) |
| add_item_glb | 4.7 ms | 4.7 ms | 1.00 | same |
| add_item_glb_textured | 24.8 ms | 22.3 ms | 0.90 | same (run 1: 75.3 ms, 3.04, WORSE at load 36) |
| drag_frames_p50 / p95 | 66.6 / 68.3 ms | 66.6 / 78.3 ms | 1.00 / 1.15 | same (run 1 p95: 625 ms, 9.15, WORSE) |
| render_capture (client / server) | 405.9 (398.6 / 7.5) ms | 380.0 (373.0 / 7.5) ms | 0.94 (0.94 / 1.00) | same (run 1 server: 13.5 ms, 1.80, WORSE) |
| render_keep_room (client / server) | 745.7 (700.3 / 45.7) ms | 745.3 (700.6 / 45.2) ms | 1.00 (1.00 / 0.99) | same |
| add_item_splat | 156.7 ms | 82.8 ms | 0.53 | same (allowance +110 %) |
| splat_first_frame | 302.9 ms | 354.5 ms | 1.17 | same |
| drag_splat | 3.04 s | 2.98 s | 0.98 | same |
| render_capture_splat | 11.47 s | 10.85 s | 0.95 | same |

Planner load: 27 requests on the desktop (24 on the phone), 1,645 KB, none external, `ready` at ~0.9 s. Against
REFACTOR §4.1: **scene open ≥ 3× is met** (7.1×); **planner cold load ≥ 40 % is not** (21 % desktop, 10 % phone, as
the engine track measured: most of what is left is SwiftShader's WebGL set-up); **keep-room mask ≥ 3× is not**
(`render_keep_room_client` 1.00: the kernel's mask and PNG take a few ms, the mask render and read-back on SwiftShader
dominate). Not an A/B: the machine was about 2.5× as loaded as when the baseline was recorded, which slows "now", so
the ratios are pessimistic rather than precise.

## Decisions

1. **Narrowing readers, not casts, not copies.** A type guard per shape keeps the server's object (the hook's as-is
   promise holds for well-formed answers) and gives the UI its structured type; no `as`, no `any`. The shapes are the
   ui track's tolerant declarations, moved to one place: they say what the planner tolerates, not what
   `contract/gen/types.ts` promises (the engine track's decision 4: the strict validators would refuse answers v1
   accepted; the server's strict mode enforces the schemas).
2. **The kernels own every numeric rule they export**, including v1's `round` (the engine notes listed "clamps, wraps,
   rounding" as the duplicated maths). Certified logic takes them as parameters; the shells call them. The price: the
   logic needs the kernels loaded. The engine awaits them before its first call, as before; if they fail to load the
   planner reports it, as before, and now the Look and view reports fail too (the projection already did).
3. **One kernel result is not bit-identical to v1:** the horizon drag's row. Rust's `tan` in wasm and V8's `Math.tan`
   differ in the last bit for some inputs (5 of 4,000 random drags, ~1e-16 relative). `test:ui` compares that row to
   1e-12 relative; everything else is still compared bit for bit (Object.is). After `pitchFromHorizon` and the clamp's
   6 decimals the camera is the same.
4. **Behaviour differences, only on malformed answers** (the tools never write them; the evals don't send them): a
   library entry, scene, layout, render, job or trashed item with a field of the wrong type has that field read as
   absent (v1 used it as it was), and one without its id/name/URLs is left out (v1 kept it); a POST /api/render answer
   that isn't a render is reported as "Render failed" (v1 announced an empty render). A layout's placeholder for a
   missing piece takes only `w`, `d`, `h` of the layout's `dims_cm` (v1 copied every key).
5. **The Bus instead of EventTarget for the engine and the stores.** A listener now gets the detail's type; nothing
   dispatches into them from outside (they are listen-only), and `bus.mjs` pins the dispatch semantics to an
   EventTarget's.
6. **Kept from Phase 2 on purpose:** the two v1 quirks the ui track recorded (the desktop Drop to floor tooltip's "null"
   keycap; the Scenes page's 940 px width that never applied) — behaviour first, a fixer's call; `pageSize` in the
   product form differs from `fmtBytes` (≥ 1 KB for nothing, no GB), so it is not a duplicate.

## Open

- **REFACTOR §4.1:** planner cold load (≥ 40 %) and the keep-room mask (≥ 3×) are missed, with the numbers above; a
  quiet-machine A/B would tighten every ratio (load 15–36 during these runs).
- **The kernels must load for the planner's maths now** (clamps, the Look, the view's and lighting's reports, layout
  signatures), not only for the projection. A failed wasm load was already fatal to the planner in practice (no
  projection, no hit tests); it is reported the same way ("Could not load the planner kernels").
- **Malformed answers** read differently from v1 (Decisions 4); nothing the tools write is affected.
- **The horizon drag's row** differs from v1 in the last bit for some inputs (Decisions 3).
- **Shared files** may conflict with the backend half's merge (the list above); `scripts/check.mjs`'s `ORDER` line
  most likely.
- **E13.38** (the Library row's "…" click) is a timing check that can miss at load ≈ 40 with a splat in view; it
  passed on the re-run and in both rounds.
- Kept for a fixer, as the ui track recorded: the desktop Drop to floor tooltip's "null" keycap and the Scenes page's
  940 px width that never applies (v1's behaviour).

## Interfaces after integration

- `planner/engine.ts`: `engine` (`Engine = typeof engine`): `events: Events<EngineEvents>` (listen-only), the getters
  and actions in the header comment, `captureComposite(opts): Promise<Shot>`, `getScene(): SceneInfo | null`,
  `getItem(uid: string | null)`; exported types `Engine`, `Shot`, `ItemInfo`, `ItemSnapshot`, `DeletedLayout`,
  `SavedScene`, `SceneLoad`, `PlannerState`, `RenderSettings`, `InputHandle`, `Req`, `RequestError` and the
  re-exported `Camera`, `LightingReport`,
  `LibraryEntry`, `RenderMeta`; values `CAMERA_RANGE` (the kernels'), `MAX_ELEVATION`, `RENDER_MODELS`, `dimsText`,
  `fmtUsd`, `quiet`, `renderPrice`, `withMidstudy`. The `window.midstudy` hook is unchanged (contract §2.4, §4.6).
- `planner/data.ts`: `createScenes` → `Scenes` (`events: Events<ScenesEvents>`: 'scenes', 'ready', 'failed'),
  `createLibrary` → `Library` (`events: Events<LibEvents>`: 'jobs', 'job-done', 'job-failed', 'spend', 'trash'; typed
  answers), `clock`, `relDate`, `shortDate`, `friendlyDate`, `sceneTitle`, `fmtBytes`, `estimateCost`, `LIB_PRICE`,
  `DEFAULT_IMAGE_ENGINE`.
- `planner/wire.ts`: the shapes and readers above (`libraryEntry`/`libraryEntries`, `libraryJob`/`libraryJobs`,
  `isLibraryJob`, `trashedItems`, `spendOf`, `sceneSummary`/`sceneSummaries`, `calibInfo`, `trashedScenes`,
  `sceneCreated`, `layoutSummaries`, `renderMeta`/`renderMetas`).
- `planner/bus.ts`: `Events<M>`, `Bus<M>`, `Listener<D>`.
- `planner/logic/num.ts`: `Kernels` (roundTo, wrapDeg, wrapAz, clampLook) and `LookKey`, what a shell passes the
  logic; `planner/ui/logic/sundial.ts`: `DialMath`.
- `planner/ui/seam.ts`: `UiContext` and the UI's re-exports (including the kernels' `clampLook`, `horizonDragGain`,
  `horizonDragRow`, `wrapDeg`).
- npm: `test:ui`, `eval:ui-smoke` (through the lock), `check:planner` (in `npm run check`).

## Shared files this branch touches (for the merge with the backend half)

`package.json` (scripts `check:planner`, `test:ui`, `eval:ui-smoke`), `scripts/check.mjs` (the `planner` check and
its place in `ORDER`), `scripts/build.mjs` (main.ts only), `knip.json`, `eslint.config.js` (a comment),
`tsconfig.planner.json`, `tscert/baseline.json` (planner entries only). If the backend half also adds a check, the
`ORDER` line in `scripts/check.mjs` conflicts textually: keep both names.
