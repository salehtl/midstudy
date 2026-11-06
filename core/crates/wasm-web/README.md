# midstudy-wasm-web

The planner's WebAssembly build of `midstudy-geom` and `midstudy-raster` (wasm-bindgen 0.2.121, `--target web`,
SIMD128). `npm run build` writes it to `build/wasm/web/`; `core/js/web.ts` is its typed face (strict TypeScript), which
the planner bundles, with a Web Worker side (`serveKernels`, `KernelWorker`).

## Guarantees, and how each is checked

| Guarantee | How it is checked |
|---|---|
| **Nothing panics or traps across the boundary.** Lengths are checked; bad input is a thrown `Error` (`JsError`) or `undefined`, never a wasm trap. No `unsafe` (the workspace forbids it; wasm-bindgen's glue passes). | Clippy `-D warnings` (pedantic) on wasm32; the crates' own guarantees (their READMEs: Kani, fuzzing, Miri); the face tests below feed bad buffers. |
| **The face computes what the crates compute**, and what v1 computed. | `tests/diff.mjs` (v1's lifted code vs the face: 49 groups), `tests/worker.mjs` (the worker protocol over a `MessageChannel`, transfers, errors), `tests/browser/run.sh` (headless Chrome: `loadKernels` over fetch, a module worker, the env map against v1's own GPU bake), and `scripts/wasm-smoke.mjs` (the golden scenes through the official build, in Node and Chrome). |
| **Zero-copy where it counts.** The camera's per-call inputs and results go through a 32-f64 scratch in wasm memory (no allocation per call); heavy results (`DepthResult`, `MaskResult`, `EnvResult`, `F64Buf`) expose `ptr()`/`len()` so the face views them in place and copies only what it keeps or transfers. | `tests/bench.mjs` (Node) and `tests/browser/bench.ts` + `bench-run.mjs` (headless Chrome) time each kernel against v1's JS, before and after a change (docs/notes/kernels-hardening.md). |
| **Small.** No float formatting is linked (no `f64::clamp` with runtime bounds, whose panic message formats floats); `panic = "abort"`, LTO and `wasm-opt -O3` (the workspace profile and `scripts/build.mjs`). | `twiggy top` on `core/target/wasm32-unknown-unknown/release/midstudy_wasm_web.wasm` (names kept before wasm-opt); the size is recorded in the notes. |

## Commands (repository root)

```sh
nix develop -c npm run build                                     # build/wasm/web/ (and the planner bundle)
nix develop -c node core/crates/wasm-web/tests/diff.mjs          # differential test against v1 (SEED=, N=)
nix develop -c node core/crates/wasm-web/tests/worker.mjs
core/crates/wasm-web/tests/browser/run.sh                        # the face in headless Chrome
nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/wasm-web/tests/bench.mjs
nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/wasm-web/tests/browser/bench-run.mjs \
  --build before=<snapshot dir> --build now=.                    # A/B in headless Chrome
```
