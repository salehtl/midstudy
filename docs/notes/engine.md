# engine (v2 Phase 2): the planner engine in strict TypeScript on the kernels

Branch `v2-engine` (worktree `.claude/worktrees/rf-engine`), from `v2` at `979677c`. Plan: docs/REFACTOR.md §1–§8; the
interfaces Phase 1 built: docs/notes/gate-1.md; the TScert guide: `tscert/README.md` (there is no
`docs/notes/tscert.md`; gate-1 says so). Owned: `planner/{main,engine,lighting,input,data}.*`, `planner/logic/**`,
`tsconfig.planner.json`, this note, and entries in the shared-append `tscert/baseline.json`.

Everything below was run on rabbit on 2026-11-06 (local time, UTC+4) with fal mocked, headless Chrome from `$PUPPETEER_EXECUTABLE_PATH`
(through the harness), never Helium, every eval through `scripts/eval-lock.mjs`.

## What exists

`planner/engine.js` (2,402 lines), `lighting.js` (488), `input.js` (143), `data.js` (278) and `main.js` (114) are gone;
the same names in TypeScript replace them, so `'./engine.js'` specifiers (the legacy `planner/ui/**/*.js`) keep
resolving. Every export name, the engine object's methods and events and the `window.midstudy` hook are v1's.

| File | What |
|---|---|
| `planner/engine.ts` | The engine shell (state, scenes, items, layouts, renders, the API calls, the render loop). Pure decisions come from `logic/`, geometry from the kernels (`core/js/web.ts`), passes from `engine.passes.ts`. Typed public API: `engine` (`Engine = typeof engine`), `EngineEvents` (each event's detail), `PlannerState`, `ItemInfo`, `Shot`/`ShotPromise`, `MaskShot`, `RulerState`, `Footprint`, `ItemSnapshot`, `LibraryEntry`, `RequestError`, … |
| `planner/engine.passes.ts` | **Every render pass** (WebGPU spike's request): the photo pass, the occlusion depth pre-pass, the furniture composite (Look, ACES, sRGB), the splat composite, the floor grid, the keep-room mask material and draw, the lights' environment bake and floor-shadow catcher, the render targets, **the one clear helper** (`clearTarget`), a frame's pass order (`drawFrame`, v1's `drawTo`, with the splat redraw cache), the full-frame capture setup and the read-back. `SPLAT_LAYER` (1) and **`DEPTH_LAYER` (2): the pieces' depth-writing meshes**, so a splat pass that draws its own depth can draw exactly them. |
| `planner/engine.worker.ts` | The kernel worker (bundled to `planner/dist/engine.worker.js`): `serveKernels` for depth.png's decode. The engine falls back to the main thread when it can't start, dies or fails. |
| `planner/lighting.ts` | The light rig (§4.8) on the kernels: SH rotation and refit, irradiance, band scaling, the turn between two directions, the splats' colour level, azimuth/elevation; the catcher's numbers from `logic/look.ts`. |
| `planner/input.ts` | Pointer, wheel and keyboard; what each gesture and key means is `logic/input.ts`. |
| `planner/data.ts` | The scenes and library stores; formatting, prices and messages from `logic/`. |
| `planner/main.ts` | The entry and the `window.midstudy` hook (typed `Window.midstudy`, `Window.midstudyCtx`). |
| `planner/logic/*.ts` | The functional core, **149 functions, all certified by TScert** and in `tscert/baseline.json`: `num` (round, wraps, clamps, elevation steps), `camera` (§4.1 ranges and default, v1's clamp, setCamera's merge, sameness, the scene's dirty signature, the camera source after a change, the floor-check note, the occlusion depth scale), `look` (§4.8: lookFrom, setLighting's merge with the freeze, Reset, what is saved, the values in use, getLighting's report, the light's status, the warmth tint, the catcher's keep, penumbra and shadow camera), `view` (stage, contain-fit, zoom 1–4, pan, client ↔ photo px, the view offset and the passes' rect), `layout` (the layout's dirty state, names shown, which layout a scene opens with, the saved document, the load toasts), `scenes` (the landing choice: ?scene=, else the last scene, else the Scenes page; calibration states), `messages` (every error sentence and the hook's argument checks), `money` (render and add prices), `text` (sizes, dollars, dates, bytes, titles, error lines, upload names), `library` (what a piece draws, splat assets, stand-ins, valid dims, thumbnails due, job states), `input` (tap slop, grab pad, tap test, pan test, wheel factor, the key map). |
| `planner/engine.test.mjs` | Differential test of `logic/` against v1's own JavaScript (copied verbatim from `979677c`, lines cited) and the kernels' clamp, on random and junk inputs. |
| `tsconfig.planner.json` | Lists `core/js/web.ts` (a composite project must list every file it compiles; the planner imports it). |

### The kernels (core/js/web.ts) in the engine

| v1 JavaScript (deleted) | Now |
|---|---|
| `projectPhoto`, `photoRay`, `photoToFloor`, `floorToPhoto`, `worldToScreen`'s projection, `horizonAt`, `setPitchFromHorizon` | `SceneCamera` (`project`, `ray`, `photoToFloor`, `floorToPhoto`, `horizonAt`, `pitchFromHorizon`), one per camera block and photo size (`kcam()`, re-made when either changes) |
| `planePointAt` (raycaster.ray.intersectPlane, 60 m) | `SceneCamera.planePointAt`; three's raycaster stays for meshes (picking, the grabbed point) |
| `landingSpot` | `SceneCamera.landingSpot(view, visible, taken)` |
| `convexHull`, `pointInHull`, `distToHull`, `hitItemAt`'s screen test | `SceneCamera.hitBox` (`'behind'` → the mesh raycast, as v1) |
| `boxCorners`, `worldBounds`, `getFootprint`, `getScreenRect` | `boxCorners`, `worldBounds`, `footprint`, `SceneCamera.screenRect` |
| drag maths (`dragHeight`, the lift plane, move/lift/rotate, the grip angle) | `dragHeight`, `liftPlane`, `dragMove`, `dragLift`, `gripAngle`, `dragRotate` |
| `setRulerTrueLength`'s maths | `rulerRescale` |
| `loadDepth` (JS PNG unfilter) | `KernelWorker.decodeDepth` in `engine.worker.ts`; v1's two refusals ("depth.png is not a PNG", "must be a 16-bit grayscale PNG (got …)") checked first in the shell with v1's words |
| `captureMask`'s threshold, `dilate` and the canvas PNG | `keepRoomMask(rgba, w, h, { png: true })` (on the main thread: a few ms; a worker's copy and round trip cost more) |
| `rotateSH`, `irradianceAt`, `scaleBands`, `maxBandScale`, `turnBetween`, `azElOf`, `dirOf` | the kernels of the same names (`rotateSh`) |
| `splatGain`, the splat pass's `warmthTint × exposure × gain` | `splatGain`, `splatMultiplier` |

Clamps, wraps, rounding and the other small maths are certified TypeScript in `logic/` (the kernels have them too;
one call costs about what the JS costs, k-geom measured, and the differential test checks the two clamps agree).

## Decisions

1. **The environment map stays v1's GPU bake on WebGL**, now in `engine.passes.ts` (`createEnvBake`), and is built
   when a frame needs it, once per photo and camera. k-geom measured the bake at 1.6 ms on SwiftShader against 35 ms for
   the CPU kernel (115 ms in the worker with the JPEG decode) and asked for the bake to stay (gate-1 repeats it); the
   WebGPU spike already ported the bake to TSL. What changed is the waste around it: v1's `apply()` rebuilt an SH
   environment map (a 64 × 32 CPU loop + a PMREM) and re-baked the photo's on every `setData`/`setCamera`, i.e. two
   bakes and four PMREMs per scene open, of which one was used. Now `fitShadow` (before every furniture frame) makes
   the photo's map when its key (photo, camera) changed and the SH map only while the photo's can't be made (never
   in practice: the photo is in before lighting.json is read). Same picture (E16 57/57, the metal probe included).
   `KernelWorker.envMapFromImage` stays the fallback for a renderer without the bake.
2. **captureComposite and captureMask return Promises** (WebGPU reads back asynchronously). `captureMask` is a real
   async function. `captureComposite` returns `Promise<Shot> & Shot`: a resolved Promise that also carries the shot's
   fields, because the legacy `planner/ui/panels/renders.js` (the ui track's, not ported on this branch) still reads
   `shot.dataUrl` synchronously; the TS port awaits it, and integration drops the fields. A capture that can't be made
   throws at once, as v1 did (renders.js's try/catch sees it; so does an awaiting caller's).
3. **Kernels load with a top-level await** in engine.ts, started before the renderer and the lights are made and
   awaited before the first kernel call (`applyCamera()` at the end of module set-up), so `window.midstudy` appears
   only with the kernels. A failed load is reported ("Could not load the planner kernels") and the page still comes
   up.
4. **Lenient JSON, as v1** (no generated validators in the planner): server answers are read at literal keys through
   small narrowing helpers, raw objects kept where v1 passed them through (`getScene()`, library entries, layout
   details, renders, the scenes list), and library entries and scene list entries updated in place where v1 did
   (a generated thumbnail, a scene's thumb_url). `contract/gen/validate.js` (558 KB, strict) would reject answers v1
   accepted; the server's strict mode is where the schemas are enforced.
5. **v1's export names are kept** (`LIBRARY_URL`, `round`, `clone`, `isNum`, `wrapDeg`, `withMidstudy`, `DEFAULT_CAMERA`,
   `clampCamera`, `LOOK_DEFAULT`, `prettyLayout`, `dimsText`, `quiet`, `MAX_ELEVATION`, `CAMERA_RANGE`, `RENDER_MODELS`,
   `fmtUsd`, `renderPrice`, `SLUG`; data's `friendlyDate`, `relDate`, `clock`, `sceneTitle`, `fmtBytes`, `LIB_PRICE`,
   `DEFAULT_IMAGE_ENGINE`, `MODEL_EXT`, `estimateCost`, `createScenes`, `createLibrary`; lighting's `V1_KEY_DIR`,
   `V1_SOFTNESS`, `createLighting`). Those nothing imports today, and the typed API added for the ui port, carry
   `@public` so knip (check:dead) leaves them (knip always ignores `@public`). lighting.js's maths exports
   (`rotateSH`, `irradianceAt`, …, `azElOf`, `dirOf`) are gone: only engine.js imported them, and they are the kernels now.
6. **WebGPU preparation** (docs/notes/webgpu-spike.md on `v2-webgpu-spike`): every pass in one module, every clear
   through `clearTarget`, async captures, and `DEPTH_LAYER` on exactly the meshes that write depth in the furniture pass
   (not a placeholder's see-through fill, a contact shadow, a splat item's hidden stand-in or its shadow-only caster).
   The readback (`readPixels`) is one function, synchronous on WebGL; the swap makes it `readRenderTargetPixelsAsync`.
   Spark 2.4 and `WebGLRenderer` stay.
7. **No CDN**: `THREE_LIBS = new URL('libs/', import.meta.url).href` (the build copies Draco and Basis to
   `planner/dist/libs/`); the build's CDN warning is gone.
8. **Performance marks** (E17 can read them): `performance.measure('midstudy:<step>')` for `scene-open` (call →
   resolution), `photo` (fetch + decode), `depth-decode` (the worker's decode, after the fetch), `envmap` (bake + PMREM,
   in lighting.ts), `item-add`, `render-capture` (the composite) and `mask-build` (render, read-back, kernel, PNG, data
   URL). Checked in the browser: all seven appear (evals/out/engine/marks.mjs, a scratch check).
9. **TScert shapes** (what was refused, and the rewrite): an index by a `0 | 1 | 2` union ("a numeric array key needs
   one array index": three explicit calls); `JSON.stringify` of an object ("no derivation": compare fields, or
   stringify a `number[]`); `map` with a closure capturing a parameter for a `number[]` result (a `for…of` push);
   an unannotated module constant used from another module (call an exported function instead); `String(unknown)`
   (the shell passes the text). The layout's dirty signature now stringifies v1's sorted rows as text (same equality as
   v1's, which the differential test checks), not v1's arrays: the signature is internal.

### Where v1 and the port differ (all outside what any eval or the UI sends)

- `lighting.json` must have 9 SH rows of 3 numbers, a key direction and colour of 3 numbers, and numeric intensity and
  softness, else the v1 lights (v1 checked only the row count and that direction was an array, and drew NaNs).
- A damaged depth.png (beyond v1's two refusals) is refused with the decoder's words (k-geom decision 2: it checks
  CRCs and lengths where v1 read zeros).
- Values of the wrong type in server answers or hook arguments are read as absent where v1 would have used them as
  they were (a numeric title, a non-string camera_source, a layout entry that isn't an object, a truthy non-string
  asset path). Messages print an object argument as `[object Object]` as v1's template did.
- `estimateCost` of an engine named like an `Object.prototype` member (`toString`) is 0 (v1 returned the function).
- `rememberLayout` with a non-string server timestamp uses now (v1: `Date.parse(String(at))`).
- Not visible, but different work: the environment maps (decision 1); PMREM render targets are disposed when replaced
  (v1 disposed only their textures); bounds, corners and screen rects come from the kernels and no longer refresh the
  pieces' world matrices as a side effect (three refreshes them before every render and raycast, as before).

## Commands

```sh
nix develop -c npm ci && nix develop -c npm run build          # once; the build bundles engine.worker.ts too
nix develop -c node planner/engine.test.mjs                     # logic vs v1 + the kernels' clamp (SEED=, N=)
nix develop -c node scripts/tscert-ratchet.mjs --files planner/logic/camera.ts   # one module
nix develop -c npm run check:tscert                             # the ratchet (149 baselined)
nix develop -c npx tsc -p tsconfig.planner.json --noEmit        # or npm run check:types
nix develop -c npm run check:lint && nix develop -c npm run check:dead
nix develop -c node scripts/eval-lock.mjs -- npm run eval:planner   # and the nine other browser evals below
nix develop -c node scripts/eval-lock.mjs --exclusive -- node evals/perf.mjs --target before:<base> --target after:. --only load,scene,edit
```

## Results

### Checks (run here, on the tree as committed)

| Check | Result |
|---|---|
| `npm run build` | ok: `planner/dist/app.js` 358 kB + 4 chunks, 1 worker (`engine.worker.js`, sharing the kernels' chunk), 19 files from 49 inputs, **no CDN warning** (v1's THREE_LIBS was the one) |
| `check:types` | ok: no errors in planner, core-web, core-node, contract |
| `check:lint` | ok: 20 .ts files, no problems (no `any`, `!`, casts but `as const`, ts-comments) |
| `check:dead` | ok: knip, no unused files, exports or dependencies |
| `check:tscert` | ok: **149/149 certified**, all 149 baselined (11 modules, every function of `planner/logic/`) |
| `check:ownership` (`MIDSTUDY_TRACK=engine`, base `979677c`) | ok: every changed path owned |
| `npm run test:engine` (`planner/engine.test.mjs`) | 11/11 groups, seed 20261106 N 4000 and seed 7 N 20000: the logic gives exactly v1's results (numbers bit for bit) for the clamps, wraps and rounding, setCamera's merge and sameness, the floor note and depth scale, lookFrom / setLighting (with the freeze) / Reset / lookToSave / warmthTint, resolvedLook (with the kernels' azElOf and dirOf), the catcher's keep, penumbra and shadow camera, the whole view (stage, clamp, zoom, pan, client ↔ photo, visible rect, getView), the layout's dirty-state equality, prettyLayout and layoutToOpen, the formats and prices, the tap slop and key map; and the logic's clampCamera equals the kernels' |
| `performance.measure('midstudy:*')` (scratch `evals/out/engine/marks.mjs`, through the lock) | 14/14: all seven steps measured, no page or console error. First open in a page: scene-open 3,096 ms (with the page's start), photo 11, depth-decode 12 (the worker starting), envmap 440 (first shader compiles); a second open: 113, 0.2, 2.4, 6.8 ms. item-add 0.9 ms, render-capture 1,067 ms and mask-build 255 ms (the first capture in a page) |

Rust: not touched (no clippy, Miri or fuzz to run for this track).

### Evals (legacy server, bundled planner, headless Chrome 147; each through the eval lock)

| Eval | v1 (gate-1) | Round 1 (`fea0c3a`, 02:04–02:12) | Round 2 (`3cf8e2a`, the final code, 02:52–02:58) |
|---|---|---|---|
| E3 planner | 56 | **56/56** | **56/56** |
| E4 occlusion | 21 | **21/21** | **21/21** |
| E5 floor | 35 | **35/35** | **35/35** |
| E6 render | 37 | **37/37** | **37/37** |
| E9 phone | 49 | **49/49** | **49/49** |
| E11 ux | 29 | **29/29** | **29/29** |
| E12 ux2 | 27 | **27/27** | **27/27** |
| E13 splat | 51 | **51/51** | **51/51** |
| E15 product-ui | 135 | **135/135** | **135/135** |
| E16 lighting | 57 | **57/57** | **57/57** |

Every eval passed on its first run in both rounds (497 checks each; the Mac was busy with other agents throughout). The counts are gate-1's (one check of each is the harness's build). Round 2 ran on the code as committed (the depth-layer change and the test script came after round 1).

### Performance: E17's planner metrics, before and after

"Before" is `979677c` exactly (`git archive` into `evals/out/engine/base/`, node_modules linked, built with the same
`scripts/build.mjs`), so both sides are measured by the same E17 with their own harness, server and bundle.

1. **Before alone** (`--repo evals/out/engine/base --only load,scene,edit`, `--exclusive`, 01:30–01:36, load 4–15):
   planner_load_desktop 1.71 s, _warm 1.90 s, _phone 1.72 s, scene_open 848 ms, add_item_glb 4.5 ms, render_capture
   379 ms, render_keep_room 751 ms, add_item_splat 83 ms, splat_first_frame 377 ms, drag_splat 3.04 s (p95 3.81 s),
   render_capture_splat 11.54 s (`evals/out/engine/perf-before.json`).
2. **A/B, interleaved ABBA** (`--target before:evals/out/engine/base --target after:. --only load,scene,edit`, 5 runs + 1
   warm-up each, `--exclusive`, 02:15–02:27, load 5–16; `evals/out/engine/perf-ab.json`):

| Metric | Before | After | Ratio | E17's verdict |
|---|---:|---:|---:|---|
| planner_load_desktop | 1.83 s | **1.51 s** | 0.83 | same (allowance 21 %) |
| planner_load_desktop_warm | 1.92 s | **1.55 s** | 0.81 | **better** |
| planner_load_phone | 1.87 s | **1.47 s** | 0.79 | same (allowance 29 %) |
| scene_open | 922 ms | **157 ms** | **0.17** | **better** (samples 923–955 ms vs 119–762 ms) |
| add_item_glb / _textured | 4.4 / 22.9 ms | 4.8 / 22.7 ms | 1.09 / 0.99 | same |
| drag_frames_p50 / p95 | 66.7 / 67.7 ms | 66.7 / 75.0 ms | 1.00 / 1.11 | same |
| render_capture (client) | 403 (395) ms | 397 (390) ms | 0.99 | same |
| render_keep_room (client) | 747 (702) ms | 729 (684) ms | 0.98 | same |
| add_item_splat | 82.1 ms | 82.3 ms | 1.00 | same |
| splat_first_frame | 389 ms | 400 ms | 1.03 | same |
| drag_splat | 3.01 s | 3.77 s | 1.25 | WORSE (see 3) |
| render_capture_splat | 11.43 s | 11.52 s | 1.01 | same |

   Planner load, after: 27 requests (23 before: + the worker, its chunk, the wasm), 1,632 KB (1,431: + the 176 KB wasm),
   `window.midstudy` at 103 ms (98: the kernels' top-level await), ready at 1,371 ms (1,811), main-thread task time
   899 ms (1,726). scene_open is 5.9× faster at the median: v1 made two photo bakes and four PMREMs per open (only one
   of them used) on the main thread; now one bake and one PMREM in the first frame, and depth.png in the worker.
3. **drag_splat re-measured** (`--only edit --runs 7`, A/B again, `--exclusive`, 02:37–02:52, load 18–27;
   `evals/out/engine/perf-ab-edit.json`): **2.84 s → 2.88 s (1.01), "no regression beyond the allowance"**; every edit
   metric 0.90–1.06. The metric is bimodal in both builds: 5 moves take ~14–15 s or ~18–20 s, depending on whether one
   more 3.6 s splat frame falls inside the window (before: 17.2, 15.2, 14.2, 13.9, 17.2, 13.8, 14.2 s; after: 13.7,
   10.5, 13.8, 19.9, 14.4, 14.9, 14.6 s; v1's own baseline p95 is 3.81 s per move for that reason). A logged run of the
   same drag in each build (`evals/out/engine/dragsplat.mjs`: every splat-pass render, Spark's onDirty, the input)
   draws the same splat frames (2 after the add, 4 during the drag); the per-frame cost is the same (p50 3.62 vs 3.68 s).
   The first A/B's 1.25 was 3 of 5 runs on the slow side against 1 of 5.

Against REFACTOR §4.1: **scene open ≥ 3× met** (5.9× at the median, the depth decode off the main thread). Planner cold
load: 17–21 % faster (the "≥ 40 %" target is the bundle's and this track's together; most of the remaining time is
SwiftShader's WebGL set-up). Keep-room mask: the kernel builds mask and PNG in a few ms, but render_keep_room's client
time is dominated by the composite and the mask render and read-back on SwiftShader (684 vs 702 ms): no 3× on that
metric. Hit tests: the kernels' (k-geom measured 7.2× for 10⁵ in Node); E17 has no metric for them.

## Requests

- **ui**: `planner/ui/panels/renders.ts` must `await engine.captureComposite(...)` (as the spike asked); the shot's
  fields on the Promise are a Phase 2 bridge for the legacy renders.js. Types for the port: `Engine`, `EngineEvents`
  (an event's `detail` by name), `PlannerState`, `ItemInfo`, `LibraryEntry` (the raw entry, read at literal keys),
  `RulerState`, `Footprint`, `ItemSnapshot`, `InputHandle` (`setKeyFilter(fn | null)`), `Scenes`, `Library`;
  `engine.getScene()` is the scene JSON plus `{name, w, h, camera, camera_source, hasDepth}`.
- **integration (Phase 3)**: drop the shot fields from `captureComposite` once renders.ts awaits (type `Promise<Shot>`);
  remove `planner/**/*.js` from knip's `ignore` at cutover (planner/main.js, engine.js, lighting.js, input.js, data.js
  are already gone); `tsconfig.planner.json` lists `core/js/web.ts`, which the core-web area also checks.
- **kernels-hardening**: `core/crates/wasm-web/tests/v1-sync.mjs` reads `planner/engine.js` and `planner/lighting.js`,
  which this branch deletes: read them from git (`git show 979677c:planner/engine.js`). `KernelWorker` has no
  `error` handling: a call to a worker that failed to load never settles (the engine races each call with the
  Worker's `error` event and falls back to the main thread); worth handling in the face. `serveKernels(self)` doesn't
  type-check under the planner's DOM lib (`self` is a `Window`): `engine.worker.ts` adapts it in four lines.
- **f-perf (E17)**: the `midstudy:*` measures above can replace the hook-level timings for scene open, item add,
  capture and mask (`performance.getEntriesByType('measure')`).
- **webgpu-swap (Phase 4)**: `engine.passes.ts` is the place (materials → TSL `NodeMaterial`s, `clearTarget` gets the
  WebGL2 clear workarounds, `readPixels` → `readRenderTargetPixelsAsync`, `drawFrame`'s splat pass → `SplatLayer.render`
  with `drawDepth` = the photo pre-pass + `DEPTH_LAYER` depth-only).

## What's left

- **The environment map from the kernels is not used on WebGL** (decision 1, with k-geom's numbers); it is the
  fallback for a renderer without the bake. The SH-made map (a JS loop) is kept as v1's fallback, built only when needed.
- **captureComposite's bridge**: the shot's fields on the Promise go when ui/panels/renders.ts awaits (integration).
- **The UI on this branch is still the legacy JS** (`planner/ui/**/*.js`, the ui track's): main.ts imports it with
  allowJs; the typed seam (`Engine`, `EngineEvents`, `PlannerState`, …) is ready for the port.
- `npm run test:engine` is not in `npm run check` (scripts/check.mjs is f-toolchain's / integration's): worth adding.
- The shells (engine.ts, lighting.ts, input.ts, data.ts, main.ts, the passes, the worker) are checked by tsc strict,
  lint and the ten browser evals; TScert covers the 149 functions of `planner/logic/`.
- A quiet-machine A/B (the load average was 5–27 during these runs) would tighten the numbers; the verdicts above are E17's own,
  with its noise allowance.
