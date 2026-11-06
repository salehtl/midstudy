# midstudy status (v2)

As of 2026-11-06, branch `v2`. The plan is [REFACTOR.md](REFACTOR.md); each track's notes are in `docs/notes/`.

## What v2 is

- **Planner, server, `midstudy-add`:** strict TypeScript (no `any`, `!` or casts; eslint strict-type-checked, knip),
  run by Node 22 directly (`node server/src/main.ts`, `node pipeline/src/cli.ts`). Pure logic is certified by TScert
  (704 of 738 units).
- **Kernels:** Rust → WebAssembly (`core/`): media sanitisers, geometry and raster, splats, imaging, the product size
  reader (linear time). Kani (21 harnesses), Miri, 14 fuzz targets, differential tests against v1.
- **Proofs:** Lean 4 + Mathlib (`proofs/`), 504 theorems: the camera model, rotations, units, lighting, the hull, and
  executable models of the strippers, identical to the Rust on ~190,000 inputs.
- **Calibration:** Python, pyright strict, outputs validated against the schemas, and a warm MoGe worker.
- **Contract:** API schemas for every route; types and validators generated; the server validates its answers and
  files in strict mode.
- **Renderer:** WebGPU by default (three.js WebGPURenderer, TSL passes, the planner's own splat renderer with a GPU
  sort), WebGL2 fallback built in (`?webgpu=0`). Spark and every GLSL string are gone.
- v1 (`serve.py`, `product_page.py`, the Python pipeline, the planner's JS) is deleted.

## Evals (final tree)

`eval:all` 14/14 on WebGPU and 14/14 on the WebGL2 fallback (E1 220, E3 56, E4 21, E5 35, E6 37, E7 79, E8 72, E9 49,
E11 29, E12 27, E13 51, E14 409, E15 135, E16 57). `npm run check` all ok. Earlier on the same code: real-MoGe
`eval:calib` 132/132, `eval:real` 32/32, `eval:ui-smoke` 41/41.

## Speed (E17 A/B against v1, interleaved, exclusive; software GPU)

v2 is faster than v1 on every metric; none is worse. Calibration from the second photo −85 % (0.95 s), desktop load
−23 % (to `ready` −37 %), API calls 0.48–0.83×, requests 53 → 27 with no CDN, Idol add 1.88×, worst product page 592 ms,
scene open 1.26×. Missed targets: planner load −40 %, keep-room mask 3×, product p95 2×, CLI 3×.
WebGPU was measured only on SwiftShader (slower there on load, scene open and drags: shader compiles in software);
judge it in Safari or Helium on Metal, with and without `?webgpu=0`.

## Open

- `main` has 8 commits written against v1 files since the fork (`e1b717f..main`: keyboard shortcuts and Export, GPT
  Image 2 renders, the daily fal budget in Settings, the light-colour fix, headless-Chrome evals): not yet ported to v2.
- Phase 4 stopped early (usage limit). Fixed: the product route no longer hangs on a page or feed body that doesn't
  decode as its Content-Encoding says (422 in ~10 ms, as v1; gzip with trailing junk is now 422 where v1 read it), and
  picture links to private or loopback IPv4 written in decimal, hex, octal, short or percent-encoded form are dropped
  (v1 kept them). The other findings (all low, plus three medium rigor ones: kernel differential tests in no gate,
  TS re-implementations of the proved slug and photo-extension rules, Python-compatibility helpers duplicated) are
  in `.claude/worktrees/rf-verify-*/evals/out/`, not fixed.
- `v2-webgpu`'s last commit (lazy environment maps, `25a9c3a`) is left out: it broke E16.33.
- Fuzz corpora trimmed to 40 seeds per target (332 files, ~1.3 MB); fuzz runs grow the rest locally.
- Not verified: live fal, a real GPU or phone, the Linux packaging (Nix is evaluated, not built on Linux).
