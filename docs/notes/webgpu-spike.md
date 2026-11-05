# webgpu-spike notes (v2 phase 1x, branch `v2-webgpu-spike`)

Question: can midstudy's renderer move to WebGPU (three.js `WebGPURenderer` + TSL, WebGL2 fallback built in), and
can we draw Gaussian splats without Spark (WebGL2-only)? Answer, with working code and numbers below: **go for
Phase 4**, with the conditions in "Go/no-go".

Everything is new files under `planner/gpu/` (nothing else in `planner/` changed). Plus `@types/three@0.180.0` in
`package.json` (shared-append).

## What exists

| File | What |
|---|---|
| `planner/gpu/splat-data.ts` | `decodeSplat(bytes)`: splat.spz (gzip, SPZ v2 exactly as §1 / `pipeline/.../splat.py` writes it) and 3DGS PLY → `SplatData { count, centers, covariances (Σ = R S² Rᵀ, item frame), colors (sRGB bytes + alpha), min, max }`. Pure (no DOM/three), runs in Node. |
| `planner/gpu/radix-sort.ts` | `GpuRadixSort`: stable LSD radix sort of u32 keys + u32 values in three.js compute nodes (TSL): 8-bit digits, 1–4 passes, 3 dispatches per pass (workgroup-atomic histogram → one-workgroup scan → scatter with stable in-block ranks from 256-bit per-digit masks + `countOneBits`). WebGPU backend only. |
| `planner/gpu/splat-layer.ts` | `SplatLayer` (interface below): data textures, the key kernel, the GPU sort or the CPU worker sort, the TSL draw material (Spark 2.4's projection), its own half-float target. |
| `planner/gpu/sort-cpu.ts`, `sort-worker.ts`, `sort-messages.ts` | The CPU sort (same 16-bit keys, stable counting sort, 262,144 splats in ~7 ms in Node) in a module worker; the WebGL2 path, and the reference the GPU sort is checked against. |
| `planner/gpu/passes.ts` | TSL ports of engine.js's screen passes: the photo exactly as is + letterbox, the depth pre-pass (depth.png → depth buffer, +3 cm, colour off), the furniture composite (un-premultiply, warmth, exposure, ACES, sRGB), the splat composite (multiplier, sRGB). |
| `planner/gpu/light-rig.ts` | v1's lighting at the default Look: LightProbe from lighting.json's SH (v1's `rotateSH`), key DirectionalLight, reflections from the photo (v1's env bake in TSL, PMREM by three), the PCSS shadow catcher in TSL with its own shadow map, `ProbeStandardNodeMaterial`/`ProbePhysicalNodeMaterial` (v1's `MIDSTUDY_PROBE_DIFFUSE` as a node-material class + a uniform). |
| `planner/gpu/demo/` | `index.html` + `demo.ts` (a golden scene drawn as engine.js draws it, hook `window.gpuDemo`), `probe.html` + `probe.ts` (capabilities), `check.mjs` (the comparison and numbers), `assets.mjs`, `tools.mjs` (esbuild from the pinned nixpkgs + a static server), `unit.mjs` (Node checks), `depth-png.ts`. |
| `planner/gpu/tsconfig.json`, `tsconfig.worker.json` | Strict TS, REFACTOR.md §3's flags. |

## Commands

```sh
cd <worktree>
nix develop -c npm install                     # once
TSC=$(nix build --no-link --print-out-paths github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c#typescript)/bin/tsc
$TSC -p planner/gpu/tsconfig.json && $TSC -p planner/gpu/tsconfig.worker.json      # strict types: clean
nix develop -c node planner/gpu/demo/unit.mjs  # decoders, covariance, CPU sort (Node, no browser)
nix develop -c node scripts/eval-lock.mjs -- node planner/gpu/demo/check.mjs                    # WG: v1 vs WebGPU vs WebGL2 (~6–10 min)
nix develop -c node scripts/eval-lock.mjs --exclusive -- node planner/gpu/demo/check.mjs --perf --only=perf   # the numbers
```
Output: `evals/out/webgpu-spike/` (`v1-*.jpg`, `webgpu-*.png`, `webgl-*.png`, `dbg-*.png`, `summary.json`, `results.json`).
`check.mjs` uses the harness: serve.py with the fal mock ($0) builds the Idol chair's splat.spz through the real
(mocked) pipeline, v1's planner renders the reference composites, the demo is served from 127.0.0.1 (secure context).

## The SplatLayer interface (for the Phase 4 swap)

```ts
import { decodeSplat } from './gpu/splat-data.ts'          // splat.spz (gzip SPZ v2) or splat.ply → SplatData
import { SplatLayer } from './gpu/splat-layer.ts'
import { createFrame, createSplatComposite } from './gpu/passes.ts'

const layer = new SplatLayer({ renderer, workerUrl })      // sort: 'gpu' on WebGPU (compute radix sort), 'cpu' on WebGL2
layer.add(uid, await decodeSplat(bytes), itemGroup)        // the group's matrixWorld places the splats (item frame, §1)
layer.remove(uid) · layer.has(uid) · layer.itemSplats(uid) · layer.itemIds() · layer.splats
layer.setColorMultiplier(r, g, b)                           // exposure × warmth × white_balance × level (§4.5, §4.8)
layer.update(camera)                                        // sort if the camera, a transform or the set changed
layer.render(camera, w, h, drawDepth)                       // into layer.target (half float, linear, premultiplied):
                                                            // clear, drawDepth() = photo pre-pass + meshes depth-only,
                                                            // then the splats (depth-tested, no depth writes)
const quad = new QuadMesh(createSplatComposite(frame, layer.target, layer.gain))   // the screen pass (no ACES)
await layer.settle(camera)                                  // a capture: the order is for this camera and set
layer.stats() · layer.dispose()
```
A render capture is `await layer.settle(captureCamera)`, then the same passes into a photo-sized target, then
`renderer.readRenderTargetPixelsAsync` (async on both backends: rows top-down on WebGPU, bottom-up on WebGL2).
Up to 256 items (item slots); the set is rebuilt and re-uploaded on add/remove (fine for furniture: a few items).

How it draws (Spark 2.4's maths, so v1 and v2 look alike): per splat an instanced quad; the item-frame covariance
turned into view space with the item's and the camera's rotations and projected with the perspective Jacobian (EWA);
0.3 px² blur with Spark's opacity compensation; the quad spans √8 σ along the 2D eigenvectors (≤ 512 px); fragments
`a·exp(−r²/2)`, discarded below 0.5/255; colours sRGB → linear, premultiplied, `(1, 1 − src α)` blending into a
half-float target, back to front; the splat's center depth is tested, never written. Data: three RGBA32F textures
(center + slot, covariance, covariance + packed colour + alpha) and a 4 × 256 RGBA32F item-transform texture, read
with `textureLoad` on both backends; the order is an instanced `u32` vertex attribute (WebGPU: the radix sort's
storage buffer; WebGL2: uploaded from the worker).

Sort keys: the depth along the view axis, quantized to 16 bits over the frame's depth range (the placed items'
bounds), far = 0; splats behind the near plane get the largest key. 16 bits over a 1.5–6 m range is 0.07 mm per step
(Spark sorts 32-bit float depths; the GPU sort also does 24 and 32-bit keys, 3 and 4 passes, checked exact).

## What the check shows (WG, `check.mjs`, golden living-wide, 1600 × 1200 composites)

Same cases on three renderers: v1 (WebGLRenderer + Spark 2.4, its own `renderView` composite), the demo on
**WebGPU** (Dawn on SwiftShader, GPU radix sort) and on the **WebGL2 fallback** (`forceWebGL`, CPU worker sort),
judged with E13/E4/E16's own measures (`evals/lib/images.py`):

| Check (E13 / E4 / E16 style) | v1 | WebGPU | WebGL2 |
|---|---|---|---|
| splat probe (80 × 120 × 50 cm) edges vs its projected box, tol 3 % | pass (≤ 7 px) | pass (≤ 7 px) | pass (≤ 7 px) |
| probe magenta inside its silhouette / green stand-in never drawn | 100 % | 100 % | 100 % |
| Idol chair (262,144 splats) vs where its splat.spz points project, tol 5 % | 3 px | 3 px | 3 px |
| near splat in front of a far one, render right after placing | 100 % (94.3 % once under load) | 100 % | 100 % |
| sofa hides the splat behind it / occlusion off shows it | 100 % / 100 % | 100 % / 100 % | 100 % / 100 % |
| lit grey box faces vs lighting.json (E16, ±12 %) | +2.4…+3.1 % | +2.3…+2.9 % | +2.3…+2.9 % |
| its floor shadow away from the light (E16, ≤ 35°) | 10.4° | 10.3° | 10.3° |
| photo corners as is | mean 0.03 (JPEG) | 0 | 0 |

Region by region against v1's composite of the same case (per-pixel max channel difference; v1's composite is a
JPEG q92, so ~1 is noise): splat cases mean 1.3–2.3 (p99 10–27), the Idol chair mean 2.3, the lit box mean 1.4
(p99 17), the floor around it 0.7, the unlit probe 1.6, the splat chair with its cast + contact shadow 2.2 (floor
1.5), cast shadows only 1.4 / 2.1 (floor 0.7 / 1.2). WebGPU and WebGL2 draw the same picture (checked per case).
GPU radix sort: equal to a stable CPU sort of its own keys for 302,350 splats (Idol chair + probe) at 16, 24 and 32
bits; the GPU-sorted and CPU-sorted frames are identical (mean 0). SPZ and PLY of one probe draw alike (mean 0.99).

Runs: WG 63/67 (run 3: WebGPU all green; the 4 WebGL2 fails were the colour-mask bug below), then 60/67 (run 4:
every WebGPU and WebGL2 self-check green; the 7 fails were v1's references flaking under machine load 13–47: an
all-black v1 `lit` composite and v1's own order race at 94.3 %). FINAL_RUN_PLACEHOLDER

## Numbers (262,144 splats: the Idol chair; SwiftShader, so compare relatively; `--perf` under `--exclusive`)

Measured 2026-11-05, 1280 × 800 view, the chair at (1.25, 0, −3.1) on living-wide with its contact and cast
shadows, occlusion on (`evals/out/webgpu-spike/summary.json` → kept as `evals/out/wg-perf1-summary.json`):

| | WebGPU, GPU sort | WebGPU, CPU sort | WebGL2 fallback, CPU sort | v1: Spark 2.4 on WebGL |
|---|---|---|---|---|
| sort, 262,144 splats | **72–84 ms** GPU time (timestamp queries; keys + 2 radix passes, 7 dispatches) | 1.5 ms (worker) | 3.5 ms (worker) | 3.8 s per re-sort (move 1 mm → settled: Spark renders a depth read-back pass of every splat, then sorts in its worker) |
| splat pass alone | 4.8–5.2 s | 4.6–4.8 s | (not synced: see below) | 3.8 s |
| whole frame (photo, furniture, shadows, splats, composites) | 4.9 s with a sort, 4.9 s without | 4.8 s | 4.7 s | — |
| time to the first splat frame (fetch, decode, upload, sort, draw) | 13.8 s (≈ 6.5 s of it compiling the 7 compute pipelines) | 7.3 s | 6.9 s | 29.0 s (add 0.2 s, first sort 24.9 s, draw 4.1 s) |
| decode splat.spz | 41 ms (browser), 35 ms (Node) | 41 ms | 40 ms | (Spark's own, in add: 0.2 s) |
| splat memory on the GPU | 17.1 MB (48 B/splat textures + 16 B/splat sort buffers) | 13.6 MB | 13.6 MB | 5.2 MB (packed 16 B/splat + ordering 4 B/splat) |

What the numbers say:
- **The draw is SwiftShader's triangle cost, not our shader.** The splat pass takes ~5 s with the full projection,
  with a debug shader that only projects the center, and with one that draws a fixed grid of quads with no texture
  reads at all (5.2 / 5.2 / 5.3 s, `splatDebug=center|grid`): 524,288 tiny triangles bound it. Spark draws the same
  count in 3.8 s on ANGLE's SwiftShader. On a real GPU both are milliseconds; not measurable here.
- **The sort is no longer the bottleneck.** Spark's re-sort costs a full extra pass of every splat on SwiftShader
  (its depth read-back) plus a round trip; the GPU radix sort is 72–84 ms of compute and lands in the same frame;
  the worker sort is 1.5–3.5 ms (and on SwiftShader, where "GPU" is the CPU, faster than the GPU sort).
- **First frame:** pipeline compilation dominates on SwiftShader; ours is 2–4× quicker to a first splat frame than
  Spark's. On WebGPU the 7 compute pipelines cost ~6.5 s to compile in software (`sort: 'cpu'` avoids it).
- JS heap deltas read 0 (Chrome's `performance.memory` is coarse in the headless shell); GPU bytes are computed
  from the buffers each side allocates. The WebGL2 "splat pass alone" timing isn't synced (a 1-pixel read of the
  canvas doesn't wait for an off-screen target there), so only its whole-frame number counts.

## Go/no-go for Phase 4: GO, with conditions

Evidence: every E13/E4/E16-style judgement passes on WebGPU and on the WebGL2 fallback, and both match v1 region by
region (above); the splat renderer needs no Spark and draws Idol's 262,144-splat chair like Spark does; the GPU sort
is exact; the photo is byte-exact; WebGPU and WebGL2 draw the same picture. Conditions for the swap:
1. Run E1–E16 on both backends (`MIDSTUDY_WEBGPU=0` for the fallback), twice, per REFACTOR.md §4.4. The spike ran
   its own E13/E4/E16-like checks, not the real evals against a ported engine.
2. Port what the spike didn't (list below), above all async captures and thumbnails.
3. Keep three.js pinned at 0.180.0 and keep the workarounds below (each found and measured here); re-run WG on any
   three upgrade.
4. Speed on a real GPU is unmeasured (no GPU here). If phones are slow, the CPU sort is a flag away (`sort: 'cpu'`)
   on WebGPU too, and the WebGL2 fallback is the same draw path.

## What the swap must change in the engine (engine.js → the TS engine, Phase 4)

- **Renderer:** `new WebGPURenderer({ forceWebGL })` (WebGL2 when `navigator.gpu` is missing or `?webgpu=0` /
  `MIDSTUDY_WEBGPU=0`); `await renderer.init()` before the first frame (engine `init()` becomes the place);
  `outputColorSpace = LinearSRGBColorSpace` and `NoToneMapping` (no output pass: the passes write sRGB bytes
  themselves, as v1's ShaderMaterials do), `autoClear = false`. `setAnimationLoop` stays.
- **Passes:** every `ShaderMaterial` becomes a TSL `NodeMaterial`: photo, depth pre-pass, furniture composite, splat
  composite (`passes.ts`, done), floor grid (`createGridMaterial`, ported, not compared), catcher and env bake
  (`light-rig.ts`, done). Full-screen passes are `QuadMesh`es. `gl_FragCoord` with v1's `uTarget.y − y` flip →
  `screenCoordinate` (top-left on both backends); `gl_FragDepth` → `material.depthNode =
  viewZToPerspectiveDepth(...)`; the pre-pass needs `vertexNode = vec4(positionGeometry.xy, 0, 1)`.
- **Clears:** use `clearTarget()` (`passes.ts`) for every clear. three 0.180's WebGL2 backend has two clear bugs,
  both found and measured here (WebGPU clears with load ops and has neither): it doesn't force the colour mask on, so
  a clear after a `colorWrite: false` draw (the depth pre-pass, a shadow map) kept the previous frame (a removed piece
  reappeared in the next capture); and clearing the canvas doesn't bind the default framebuffer, so the clear hit the
  furniture target's resolve framebuffer and the composite painted the clear colour over the whole photo (a black
  view at Fit on WebGL2, while captures were fine). Found with a GL call trace (`node planner/gpu/demo/gltrace.mjs`).
- **Render targets / splat depth:** `WebGLRenderTarget` → `RenderTarget`. WebGPU can't resolve or share the MSAA
  furniture target's depth with a single-sample target, so the splat pass draws its own depth: the photo pre-pass
  plus the meshes depth-only (`DEPTH_LAYER` + `overrideMaterial`) as `SplatLayer.render`'s `drawDepth`. v1's
  `splatRT` sharing `furnDepth` goes away.
- **Splats:** Spark (`SplatMesh`, `SparkRenderer`, `SPLAT_LAYER`, `onDirty`, `settleSplats`) → `SplatLayer` +
  `decodeSplat`; `getState().items[].splats` = `layer.itemSplats(uid)`; the splat composite gain =
  `layer.setColorMultiplier(...)`. v1's `splatKey` redraw cache can stay (the GPU sort already runs only when its
  key changes). Spark leaves the bundle (and the CDN).
- **Lighting (`lighting.js`):** the `ShaderChunk` patch → `ProbeStandardNodeMaterial` / `ProbePhysicalNodeMaterial`
  registered in `renderer.library` (three refuses to redefine a material: delete its entry first) + the `iblDiffuse`
  uniform (0 with lighting.json, 1 without; nothing recompiles). The catcher reads its **own** shadow map of
  `CASTER_LAYER` objects: three's WebGPU renders a light's shadow map only for lit receivers, so v1's "read three's
  map" doesn't carry over; splat items' caster copies go on `CASTER_LAYER` (no `casterMat`). Casters' `shadowSide`
  is set to WebGL's flipped default (`flipSides`): WebGLRenderer's shadow pass draws back faces, three's WebGPU pass
  the material's side, and without this a box on the floor shadowed its own footprint (measured on the splat chair).
  Not ported yet: the default-mode `RoomEnvironment` PMREM (`PMREMGenerator.fromScene` exists in three/webgpu),
  turning/strength/ambient controls (pure JS maths, reuse `rotateSH` etc.), `maskMode` is ported (`rig.maskMode`).
- **Captures:** `readRenderTargetPixels` (sync) → `await renderer.readRenderTargetPixelsAsync` (rows top-down on
  WebGPU, bottom-up on WebGL2): `captureComposite` and `captureMask` become async, and `ui/panels/renders.js`
  (calls `engine.captureComposite` synchronously today) must await it. Keep one capture target (resized) instead of
  one per capture. Splats: `await layer.settle(captureCamera)` before drawing (v1's `settleSplats`).
- **Thumbnails (`modelThumbnail`):** a second `WebGLRenderer` per piece + `forceContextLoss` → the main
  WebGPURenderer into a 256² target, `PMREMGenerator(renderer).fromScene(new RoomEnvironment())`, ACES + sRGB in a
  small composite (the output conversion is off), `readRenderTargetPixelsAsync` → JPEG. Or keep a tiny
  WebGLRenderer just for thumbnails. Scene thumbnails are a 2D canvas: unchanged.
- **Loaders:** GLTFLoader/DRACO/Meshopt unchanged; `KTX2Loader.detectSupport(renderer)` after `init()`. GLB
  materials convert to node materials automatically; `LineDashedMaterial` (missing-item edges) is supported.

## Risks

- **three.js WebGPURenderer maturity.** Found in one spike: two WebGL2-backend clear bugs (above), three's WebGPU vs
  WebGL shadow sides, `NodeLibrary.addMaterial` refusing redefinitions. The fallback needs its own eval runs: both
  clear bugs passed every WebGPU check and showed only on WebGL2. The spike also reaches into internals:
  `backend.isWebGPUBackend`, `backend.state.setColorMask`, `builder.context.iblIrradiance` (the radiance-only
  environment), `library.materialNodes`, `isShadowPassMaterial`. Pin 0.180.0; WG catches regressions.
- **No real GPU here.** All timings are SwiftShader (software); correctness is what the evals prove. Mobile GPU
  limits used: workgroups of 256 invocations (the WebGPU default limit), 9 KB of workgroup memory (default 16 KB),
  float32 textures read with `textureLoad` (no filtering needed). iOS: WebGPU in Safari 26+; older phones take the
  WebGL2 fallback (same draw, CPU sort), which must stay first-class in the evals.
- **First-frame cost.** Pipeline compilation (the radix kernels, the splat material, node materials) dominates the
  first splat frame on SwiftShader (numbers below). On a real GPU it is far smaller but non-zero; `renderer.compileAsync`
  at scene open can hide it.
- **Memory.** The layer keeps 48 B/splat of float textures + 16 B/splat of sort buffers (+ the item texture), about
  3–4× Spark's packed 16 B/splat. Fine for a few furniture pieces at 262,144 splats each; packing (f16 covariance,
  u8 colour) would bring it to ~28 B/splat.
- **A v1 quirk kept:** the letterbox bars are meant to be `0x0e0f11` but v1 writes the `Color`'s linear components
  as bytes, so they come out (1, 1, 1); the spike draws the same (checked). Fixing it is a one-line, visible change
  for later, not part of the swap.
- **Parity details.** Spark's sort uses 32-bit float depths, ours 16-bit over the items' depth range (0.07 mm steps
  at 1.5–6 m); measured identical-looking (region diffs above). The blur/compensation and the √8 σ quad are Spark's.

## Decisions (with reasons)

- **Splat data in textures, order as an instanced attribute** (not storage buffers in the vertex stage): the same
  TSL material runs on both backends (`textureLoad` is native on both; three emulates vertex-stage storage reads on
  WebGL2 through PBO textures, which this avoids). The GPU sort writes a `StorageInstancedBufferAttribute` that is
  both a storage buffer (compute) and the instanced vertex buffer (draw).
- **LSD radix sort, 8-bit digits, stable in-block ranking by 256-bit masks + `countOneBits`** (not one 16-bit
  counting pass with global atomics): deterministic order (an atomic scatter isn't stable, so frames would differ
  run to run and evals would flake), 3 dispatches per pass, no decoupled look-back (WebGPU has no forward-progress
  guarantee). The kernels are TSL with one `wgslFn` (popcount); each pass's constants are baked (no uniform writes
  between dispatches of one submission).
- **16-bit keys over the items' depth range** by default: 2 passes; enough precision (0.07 mm steps); 24/32-bit
  available and checked.
- **The catcher has its own shadow map** (see swap list): also lets splat items cast without a lit receiver.
- **Spark's projection maths, not a "better" one:** v1 parity was the bar (E13 and the region diffs).
- **CPU sort = the same keys, a stable counting sort in a module worker:** identical order to the GPU sort (frame
  diff 0), ~7 ms for 262,144 splats in Node; a Rust/WASM kernel can replace `sort-cpu.ts` behind `sort-messages.ts`.

## Requests to other tracks

- **engine (Phase 2):** keep captures async-ready (`captureComposite` / `captureMask` returning Promises) and the
  render passes in one module, so the Phase 4 swap replaces materials, not structure; route every clear through one
  helper. The splat pass's `drawDepth` needs the meshes on a layer of their own (or a list).
- **ui (Phase 2):** `renders.js` must `await engine.captureComposite(...)`.
- **f-toolchain:** the bundle needs `three/webgpu`, `three/tsl` and `three/addons` from npm (no import map), a second
  entry for `planner/gpu/sort-worker.ts` (a module worker URL), and `@types/three@0.180.0` (added to package.json
  here). TSL's typings need `ShaderNodeObject<UniformNode<T>>` parameter types under `exactOptionalPropertyTypes`
  (generic `ShaderNodeObject<Node>` doesn't accept them); eslint's no-`as` rule is met with `Reflect.get` for three's
  internals.
- **pipeline:** none (splat.spz as written decodes; checked against `splat.py`'s reader).

## What's left

- Port the remaining engine pieces listed above (RoomEnvironment default mode, the Look controls' SH turning,
  thumbnails, async captures) and run E1–E16 on both backends (Phase 4, `webgpu-swap`).
- Real-GPU numbers (a phone and a desktop GPU); `renderer.compileAsync` to hide pipeline compiles.
- Optional: pack the splat textures (~28 B/splat), cull splats on the GPU and draw indirect (fewer vertices), a
  Rust/WASM CPU sort.
