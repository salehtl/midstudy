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

RESULTS_PLACEHOLDER
