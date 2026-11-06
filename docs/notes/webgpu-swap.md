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

## The spike's check (planner/gpu/demo/check.mjs)

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
9. **Kept from the spike as measured:** three 0.180.0 pinned; the two WebGL2 clear workarounds (`clearTarget`); the
   letterbox bars written as the Color's linear components (v1's quirk, (1, 1, 1)); 16-bit sort keys; data textures +
   an instanced order attribute (one TSL material for both backends).

## Open issues

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
