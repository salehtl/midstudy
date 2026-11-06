# webgpu-swap (v2 Phase 4): the planner on WebGPURenderer, gated

Branch `v2-webgpu` (worktree `.claude/worktrees/rf-webgpu`), from `v2-int-planner` at `60dba50` (the integrated planner:
strict TS on the WASM kernels, WebGL + Spark), with `v2-webgpu-spike` (`f4fb413`) merged in. The plan is
docs/REFACTOR.md §1 ("WebGPU is gated"); the spike's findings are docs/notes/webgpu-spike.md. Everything below ran on
rabbit on 2026-11-06 with fal mocked, the legacy server (`MIDSTUDY_SERVER` unset), headless Chrome from
`$PUPPETEER_EXECUTABLE_PATH` through the harness (never Helium), every eval through `scripts/eval-lock.mjs`. Nothing
was pushed.

## What changed

The planner renders with three.js 0.180.0's `WebGPURenderer` (`three/webgpu`): WebGPU where the browser has an adapter,
its built-in WebGL2 backend otherwise. One code path: every pass is TSL and compiles to WGSL or GLSL; no second
renderer is kept alive (the thumbnails' second `WebGLRenderer` is gone too), no Spark, no GLSL string anywhere.

| Area | Before (v2-int-planner) | Now |
|---|---|---|
| Renderer | `WebGLRenderer`, sync | `WebGPURenderer({ forceWebGL: ?webgpu=0 })`, `await renderer.init()` at module start (the kernels load meanwhile), output colour space linear and no output tone mapping (the passes write sRGB bytes themselves, as v1's ShaderMaterials did), `autoClear` off |
| Passes (`planner/gpu/passes.ts`, new home of every material) | GLSL `ShaderMaterial`s in `engine.passes.ts` | TSL `NodeMaterial`s from the spike, finished: photo, depth pre-pass (`depthNode` = `viewZToPerspectiveDepth`, a clip-space `vertexNode`), furniture composite (ACES + sRGB), splat composite, grid, the environment bake, the PCSS floor catcher (now also v1's mask rule: white without the alpha test), `clearTarget` with the spike's two WebGL2 workarounds; photo and depth textures made here |
| Frame (`planner/engine.passes.ts`) | furniture MSAA pass → Spark pass sharing its depth texture → screen | furniture MSAA pass → `SplatLayer.render` into its own target over a depth of its own (the pre-pass twin + the pieces' meshes depth-only, each with a depth material of its own side, via `setRenderObjectFunction`) → screen. The splat pass keeps v1's redraw key. Contact shadows and `onDepthLayer` moved here (the demo shares them) |
| Splats | Spark 2.4 `SplatMesh` + `SparkRenderer` (2.8 MB lazy chunk), `settleSplats` polling Spark's state | `planner/gpu/splat-layer.ts` (the spike's): GPU radix sort on WebGPU, `sort.worker.ts` on WebGL2; decoded files shared by placed copies; `onChange` (a landed worker sort) bumps the splat key and wakes the loop; `settle(camera)` before captures |
| Lighting (`planner/lighting.ts`) | `ShaderChunk` patch + `MIDSTUDY_PROBE_DIFFUSE` define; catcher read three's shadow map | `ProbeStandardNodeMaterial` / `ProbePhysicalNodeMaterial` registered in `renderer.library` + one `iblDiffuse` uniform (0 with lighting.json, 1 without: no recompiles); the catcher renders its own shadow map of `CASTER_LAYER` (casters' layer follows `castShadow`; splat items' caster copies are on it); every caster's `shadowSide` set to WebGL's flipped default (v1's shadows); RoomEnvironment and the photo environment through three/webgpu's `PMREMGenerator` (the photo env's PMREM target reused); everything else (the SH turn, strength, ambient, keep, softness, the mode switch) unchanged, on the kernels |
| Captures | sync read-back inside a Promise | `readRgba`: `readRenderTargetPixelsAsync`, tight top-down rows on both backends (WebGL reads bottom-up; WebGPU pads rows to 256 bytes, so a 1200 px wide portrait comes back with 4,864-byte rows); `captureShot` and `captureMask` hold the view (`holdFrames`) across their awaits (a frame drawn mid-capture would see the capture's camera, targets, or the mask's white materials); one capture target and one mask target, kept and resized |
| Thumbnails | a second `WebGLRenderer` per piece, ACES + sRGB output, `forceContextLoss` | the main renderer: the model into a 256² half-float MSAA target (RoomEnvironment's map from the lights, its diffuse light on for the thumbnail whatever the scene), the furniture composite (ACES + sRGB) over 0xe7e4df written as is, `readRgba` → JPEG |
| Build | three.module.js for 'three'; Spark chunk; `.glsl` loader | `three` resolved to `three.webgpu.js` for the addons (three's own import map for WebGPU does this; three.module.js, i.e. WebGLRenderer, leaves the bundle: 143 kB); `planner/gpu/sort.worker.ts` is a worker entry (renamed from `sort-worker.ts` so the build's `*.worker.ts` rule picks it up: `planner/dist/sort.worker.js`); `@sparkjsdev/spark` removed from package.json |
| The spike's demo | its own light rig (a second copy of the SH maths), its own depth decoder, its own frame | draws with the engine's modules (`createPasses`, `drawFrame`, `createLighting`, `SplatLayer`, the kernels' `decodeDepth`): `light-rig.ts`, `demo/depth-png.ts`, `demo/probe.{ts,html}` (an unused capability probe) and the gpu tsconfigs removed; `tools.mjs` builds with the project's esbuild and copies the kernels' wasm |

## Checks (static)

Run on the final tree (each `nix develop -c npm run check -- <name>`):

| Check | Result |
|---|---|
| `check:types` | ok: no errors in planner, core-web, core-node, contract (planner/gpu and the demo are in the planner area now: their own tsconfigs and `.ts` import specifiers are gone; the sort worker uses the DOM-typed `self`, as `engine.worker.ts` does) |
| `check:lint` | ok: 60 `.ts` files, no problems (the spike's code made lint-clean: `void` on three's `render`/`clear`/`compute`, which return a Promise only before `init()`; a `RenderTarget` type guard instead of an `any` return; template numbers through `String`) |
| `check:dead` | ok: knip, no unused files, exports or dependencies (the demo's `demo.ts` and `*.mjs` are entries; the spike's internal constants unexported; its `referenceOrder` and `debugShaders` removed) |
| `check:tscert` | ok: 320/320 certified, all 320 baselined (no logic module changed) |
| `check:planner` | ok: engine logic vs v1 11/11 groups; UI logic vs v1 204,019 checks; bus 5 cases |
| `check:gen` | ok: contract/gen and the contract crate's schema are what the schemas generate (CONTRACT.md's splat paragraph changed: prose only) |
| `node planner/gpu/demo/unit.mjs` | all passed (SPZ vs PLY decode, Σ = R S² Rᵀ, the CPU sort's order, stability and culling; 262,144 splats sorted in 6.6 ms in Node) |
| `npm run build` | `planner/dist/app.js` 1,179,936 B + a 21 kB chunk, `engine.worker.js`, `sort.worker.js` (1.4 kB); no CDN URL. v2-int-planner: 378,295 B + a 535 kB chunk loaded at start (three's WebGL build, shared with Spark) + 21 kB, and Spark's 2.8 MB chunk on the first splat item. Start-up JavaScript 1,201 kB against 934 kB (+29 %: three's WebGPU build with its node system and both backends, 538 kB of it); no lazy 2.8 MB any more |

## The gate: every browser eval twice per backend

**Passed.** The ten browser evals the task names (`eval:planner`, `eval:occlusion`, `eval:floor`, `eval:render`,
`eval:phone`, `eval:ux`, `eval:ux2`, `eval:splat`, `eval:lighting`, `eval:product-ui`), each run through
`scripts/eval-lock.mjs` with the legacy server: twice with WebGPU (the harness default: `--enable-unsafe-webgpu
--use-webgpu-adapter=swiftshader`) and twice with `MIDSTUDY_WEBGPU=0` (no WebGPU flags: no adapter, three falls back to
WebGL2 by itself, which the console's "running under WebGL2 backend" warning confirmed). Rounds B and C ran on the same
planner, scripts and evals trees (`git rev-parse <commit>:planner` = `ce760eb`, rounds B on `3929050` and C on
`c5a445d`, which differ only in docs/notes), every run on its first try, two at a time (never the same eval twice at
once: an eval's `evals/out/<slug>/` is shared by its runs and wiped at its start; round A's first attempt lost E4 to
that collision and was restarted). Logs: `evals/out/webgpu-swap/<round>-<backend>-<eval>.log`, summaries
`<round>.summary`.

| Eval | B WebGPU | B WebGL2 | C WebGPU | C WebGL2 | A (pre-check) WebGPU · WebGL2 |
|---|---|---|---|---|---|
| E3 planner | **56/56 (41 s)** | **56/56 (40 s)** | **56/56 (41 s)** | **56/56 (40 s)** | 56/56 · 56/56 |
| E4 occlusion | **21/21 (14 s)** | **21/21 (13 s)** | **21/21 (14 s)** | **21/21 (13 s)** | 21/21 · 21/21 |
| E5 floor | **35/35 (22 s)** | **35/35 (21 s)** | **35/35 (22 s)** | **35/35 (21 s)** | 35/35 · 35/35 |
| E6 render | **37/37 (20 s)** | **37/37 (20 s)** | **37/37 (20 s)** | **37/37 (20 s)** | 37/37 · 37/37 |
| E9 phone | **49/49 (43 s)** | **49/49 (43 s)** | **49/49 (43 s)** | **49/49 (43 s)** | 49/49 · 49/49 |
| E11 ux | **29/29 (51 s)** | **29/29 (44 s)** | **29/29 (50 s)** | **29/29 (45 s)** | 29/29 · 29/29 |
| E12 ux2 | **27/27 (61 s)** | **27/27 (56 s)** | **27/27 (60 s)** | **27/27 (56 s)** | 10/11 · 10/11 |
| E13 splat | **51/51 (118 s)** | **51/51 (98 s)** | **51/51 (122 s)** | **51/51 (94 s)** | 51/51 · 51/51 |
| E16 lighting | **57/57 (120 s)** | **57/57 (104 s)** | **57/57 (122 s)** | **57/57 (106 s)** | 57/57 · 55/57 |
| E15 product-ui | **135/135 (33 s)** | **135/135 (32 s)** | **135/135 (34 s)** | **135/135 (33 s)** | 135/135 · 135/135 |
| **total** | **497/497** | **497/497** | **497/497** | **497/497** | 480/481 · 478/481 (E12 stopped at its exception) |

Round A was the pre-check, on the tree before the last two fixes (`5d7345a`, later evals of it on newer builds): it
found both remaining bugs. **E12.10** (both backends): `window.midstudy` was undefined right after a reload's load event
(fixed by `planner/ready.ts`, see Decisions). **E16.20/.21** (WebGL2): after `light_strength` 0 → 1 the box and its
shadow vanished from every capture until the page reloaded; reproduced every time by replaying E16's control sequence
(`evals/out/webgpu-swap/repro-e16.mjs`), the console showing "Rendering failed: Cannot read properties of null (reading
'depthTexture')" and then invalid multisample formats and incomplete framebuffers: three 0.180's shadow-node
lifecycle (see Decisions). After both fixes: E12 27/27 on both backends and E16 57/57 on WebGL2 as pre-checks, the
replay 3 rounds × 7 captures with the box in every one on both backends, then rounds B and C.

Extra, not in the gate: `eval:ui-smoke` (the UI's browser smoke test, with int-planner's start-up race checks: resize
events from the first script, 3 loads each) **41/41 on WebGPU and 41/41 on WebGL2**; and a scratch check that
`?webgpu=0` gives a WebGL2 canvas while the browser has WebGPU (and the default a WebGPU one), both rendering
(`evals/out/webgpu-swap/urlswitch.mjs`).

The timing check that flaked once in int-planner (E13.38, the Library row's "…" click with a splat in view) passed in
every run; the 1-minute load was 5–14 during the rounds.

## The spike's check (planner/gpu/demo/check.mjs)

`nix develop -c node scripts/eval-lock.mjs -- node planner/gpu/demo/check.mjs`, twice: on `f21bee0` **WG 72/72** in
359 s, and after round C on `c5a445d` **WG 72/72** in 342 s (the same planner tree; `evals/out/webgpu-swap/wg-try1.log`,
`wg-try2.log`; the spike's own final run was 69/69 with 2 skipped). Its reference column ("v1") is now the planner itself on the harness's
default browser (WebGPU): the same renderer as the demo, so its `order` case no longer loses Spark's sort race and
nothing is skipped.

| What | WebGPU (GPU sort) | WebGL2 (worker sort) |
|---|---|---|
| the demo opens on the backend asked for; letterbox bars exactly (1, 1, 1), the photo at Fit within mean 1.9 | yes | yes |
| splat probe within 3 % of its projected box; magenta inside its silhouette, stand-in never drawn | ≤ 7 px; 100 % | ≤ 7 px; 100 % |
| Idol chair (262,144 splats) where its splat.spz points project | ≤ 3 px | ≤ 3 px |
| near splat in front of a far one right after placing | 100 % | 100 % |
| the sofa hides a splat behind it / occlusion off shows it | 100 % / 100 % | 100 % / 100 % |
| lit box faces vs lighting.json (±12 %) / floor shadow away from the light | +2.3…+2.6 % / yes | +2.3…+2.6 % / yes |
| region diffs against the planner's own composite (JPEG q92), every case | items mean 1.30–1.97, floor 0.71–1.79, photo 0.03 | the same ±0.04 |
| splat.spz and splat.ply of one probe | mean 0.99 | mean 0.99 |
| GPU radix sort = a stable CPU sort of its keys (302,350 splats) | 16, 24 and 32-bit: 0 mismatches | — |
| worker sort and GPU sort draw the same picture | mean 0 | — |
| no WebGPU flags at all: falls back to WebGL2 by itself, same picture | — | mean 0 |
| the two backends, every case, whole frame | mean ≤ 0.018, p99 0 | |
| page or console errors | none | none |

## Numbers

## Decisions

1. **The spike's modules, not a rewrite; the engine's structure, not the demo's.** `engine.passes.ts` keeps the frame
   order and `lighting.ts` keeps its API and every number (both were already shaped for this: "the swap replaces
   materials, not structure"); the materials come from the spike, finished. The demo now draws with those modules, so
   `check.mjs` judges the planner's real render code on both backends instead of a second implementation (it had its
   own SH maths, a duplicate of the kernels', and its own depth decoder: both gone, as int-planner removed duplicates).
2. **One `iblDiffuse` uniform instead of a define per material.** The probe replaces the environment's diffuse light
   in photo mode; a uniform switches it for every lit material without a recompile. Thumbnails turn it on for their
   own render (`withDiffuseIbl`): in v1 a thumbnail of a piece placed in a photo-mode scene lost its diffuse IBL
   through the shared material's define; now it never does.
3. **The catcher draws its own shadow map** (the spike's finding: three's WebGPU renderer draws a light's map only for
   lit receivers, so unlit probes and splat items would cast nothing). `CASTER_LAYER` membership follows v1's
   `castShadow` rule, so the same objects cast as in v1; splat items' caster copies stay on layer 0 too (with
   `colorWrite`/`depthWrite` off), so they still shadow lit pieces through three's map, as in v1.
4. **v1's shadow sides on both backends** (`shadowSide` = the flipped side when unset), on GLB materials (shared with the
   glb cache: idempotent) and the caster material.
5. **The splat pass's mesh depth uses a depth material per side** (`setRenderObjectFunction`): the depth a piece writes
   there is the depth its own material writes in the furniture pass (the spike's demo used one front-side override,
   which would skip the back faces of double-sided geometry; not measured to matter on the evals' pieces). The function is reset to three's (null) after: the typings can't restore an
   arbitrary previous one, and nothing in the planner sets one.
6. **Captures hold the view for their whole duration** (`holding()`), not only renderView: `captureComposite` is public
   (the Renders panel calls it) and both captures now await read-backs and sorts with the camera, the targets and (the
   mask) the materials changed.
7. **`three` → `three.webgpu.js` in the bundle** (an esbuild resolve rule in `scripts/build.mjs` and the demo's
   `tools.mjs`): three's own WebGPU import map does the same; the WebGL build (143 kB) left the bundle, and a future
   addon needing a WebGL-only export fails the build instead of shipping a second renderer.
8. **`?webgpu=0`** forces the WebGL2 backend from the URL (the spike's suggestion; for checking a real device). The
   harness's `MIDSTUDY_WEBGPU=0` hides WebGPU from the browser instead; three then falls back by itself, with a console
   warning ("WebGPU is not available, running under WebGL2 backend"), not an error.
9. **The key light always casts; the Look's floor-shadow switch is the shadow's intensity.** three 0.180's
   `AnalyticLightNode.setup` disposes the light's `ShadowNode` (its `shadowMap` set to null) whenever a material builds
   while `castShadow` is false, while node states built with it true keep that node: switching `castShadow` off and
   on (E16's strength 0 → 1) threw in every following frame. With `castShadow` fixed, `shadow.intensity` 0 gives
   `mix(1, s, 0) = 1` exactly (same pixels as no shadow), `shadow.autoUpdate` false skips the map's renders, and the
   catcher and the engine's shadow box follow `lights.castsShadow()`. v1's behaviour is kept; the cost is the map's
   memory in scenes that never show a shadow.
10. **`window.midstudy.ready` before the module graph's awaits** (`planner/ready.ts`, imported first by main.ts, no
   top-level await of its own, so it runs before engine.ts's): the engine now awaits `renderer.init()` (an adapter
   request, also on the WebGL2 fallback, which asks first) on top of the kernels, which pushed main.ts's hook past the
   page's load event; v1 installed the hook during its module's evaluation, and E12 reads `ready` right after a
   reload's load event. The stub holds the same `ready` Promise and `errors`; main.ts installs the whole hook as before.
11. **Kept from the spike as measured:** three 0.180.0 pinned; the two WebGL2 clear workarounds (`clearTarget`); the
   letterbox bars written as the Color's linear components (v1's quirk, (1, 1, 1)); 16-bit sort keys; data textures +
   an instanced order attribute (one TSL material for both backends).

## Open issues

- **three.js 0.180 bugs worked around, so the pin matters** (re-run WG and E16 on both backends on any upgrade): the
  spike's two WebGL2 clear bugs (`clearTarget`), and the shadow-node lifecycle bug above (the key light now always
  casts; its shadow's intensity is the switch). The cost of the latter: three allocates the key's 2048² shadow map as
  soon as a lit piece is drawn, also in a scene whose floor shadow is off (it is never rendered while off). Also
  reaching into internals, as the spike did: `backend.isWebGPUBackend`, `backend.state` (`setColorMask`,
  `bindFramebuffer`), `builder.context.iblIrradiance`, `library.materialNodes`, `isShadowPassMaterial`, and
  `PMREMGenerator.fromEquirectangular` (present in 0.180's three/webgpu, missing from @types/three 0.180).
- **One WGSL string remains**: the GPU radix sort's popcount (`wgslFn`, `countOneBits`): TSL 0.180 has no bit-count
  node. It is WebGPU-only compute (the WebGL2 fallback sorts in the worker); no GLSL remains anywhere.
- **Start-up JavaScript +29 %** (1,201 kB against 934 kB): three's WebGPU build carries the node system and both
  backends. Spark's 2.8 MB lazy chunk is gone. E17's load metrics below say what it costs on SwiftShader.
- **window.midstudy before the planner has loaded** holds `ready` and `errors` only (planner/ready.ts); v1's held every
  method at once. Every eval waits for `ready` before calling methods (the harness and E11 do; E12 reads only `ready`).
- **No real GPU here**: every number is SwiftShader (WebGPU on Dawn's, WebGL on ANGLE's). The spike's risks stand
  (mobile limits, first-frame pipeline compiles: `compileAsync` at scene open could hide them; splat memory 48 B/splat).
- **Not done (unchanged from the spike):** packing the splat textures, GPU culling and indirect draws, a Rust/WASM CPU
  sort, real-device numbers.

## Interfaces

- `planner/gpu/passes.ts`: `createFrame`, `setFrame`, `Frame`, `createPhotoPass` (`node`, `setPhoto`),
  `createDepthPrepass` (`scale`, `setDepth`), `createFurnitureComposite` (`exposure`, `tint`), `createSplatComposite`,
  `createGridMaterial`, `createEnvBake`, `createCatcher`, `clearTarget`, `render`, `isWebGPU`, `photoTexture`,
  `depthTexture`, `BAR`, types `U<T>`, `T`.
- `planner/engine.passes.ts`: `createPasses(renderer)` → `Passes`, `drawFrame(p, target, { scene, camera, furniture,
  splats })`, `withFullFrame(p, camera, aspect, w, h, async fn, restore)`, `readRgba(renderer, rt, w, h)` (tight,
  top-down), `captureTarget`, `maskTarget`, `drawMask`, `setScreen`, `sizeTargets`, `setSplatSource`,
  `makeContactShadow`, `SHADOW_Y`, `onDepthLayer`, `noRaycast`.
- `planner/lighting.ts`: as before (`createLighting({ renderer, scene, photo: { node, frame } })`), minus `forget`,
  plus `roomEnvironment` and `withDiffuseIbl(fn)`.
- `planner/gpu/splat-layer.ts`: `SplatLayer({ renderer, sort?, keyBits?, workerUrl?, onChange? })` (the spike's, minus
  its colour gain, which is the composite's uniform, and its debug draws); `planner/gpu/sort.worker.ts` →
  `planner/dist/sort.worker.js`.
- The engine's API and the `window.midstudy` hook are unchanged (`getState().items[].splats` is the decoded count, as
  Spark's `numSplats` was). URL: `?webgpu=0`.
