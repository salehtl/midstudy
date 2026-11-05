# k-geom (v2 Phase 1): Rust geometry and raster kernels, their wasm build and TS face

Branch `v2-k-geom` (from `v2` at 0d40ff5). Plan: docs/REFACTOR.md §1–§8. Owned paths: `core/crates/{geom,raster,wasm-web}/**`,
`core/js/web.ts` (+ `core/Cargo.lock` entries). No `unsafe` anywhere (`forbid(unsafe_code)`; the wasm-bindgen macro's own
code compiles under it).

## What exists

| Where | What |
|---|---|
| `core/crates/geom` (`midstudy-geom`) | f64, no allocation. `camera`: the camera block, v1's clamps (`CameraBlock::clamped`, `same_as`), `Camera` (f, R = Rx·Rz, `project`, `floor_to_photo`, `ray_dir`/`ray`, `photo_to_floor`, `horizon_at`, `pitch_from_horizon`), the 0.12°/CSS px horizon-drag cap (`horizon_drag_gain`, `horizon_drag_row`), `depth_scale`, `turn_to_world`. `item`: poses (rotation_y ccw from above), `box_corners` (truth.json's order), `world_bounds`, `footprint`, `screen_rect`, `clamp_elevation`, `rotate_by`. `hull`: monotone chain, `point_in_hull`, `dist_to_hull`, `hull_hit`, `SmallHull` (stack). `drag`: three.js `Ray.intersectPlane`, `plane_point_at` (60 m cap), `drag_height`, `lift_plane`, `drag_move`/`drag_lift`/`grip_angle`/`drag_rotate`. `floor`: `landing_spot`, `ruler_length`, `ruler_rescale`. `look`: the Look's clamps (`LookNumber`), `az_el_of`, `dir_of`, `turn_between` (three.js quaternion maths), `v1_key_dir`. `jsmath`: `Math.round`, `Math.min/max` (NaN, ±0), V8's `Math.hypot`, `wrapDeg`, `wrapAz`, `round(v, n)` — so thresholded decisions take v1's branch. `view`: client ↔ photo px. `LEAN.md`: what the proofs track should prove. |
| `core/crates/raster` (`midstudy-raster`) | `png`: the depth.png decoder (8/16-bit grayscale, non-interlaced, all five filters unfiltered one byte chain at a time, `miniz_oxide`, CRCs checked; the module denies `indexing_slicing`, `arithmetic_side_effects`, `cast_possible_truncation`). `depth`: mm → metres (× scale; scale 1 is v1's `Float32Array` bit for bit). `mask`: silhouette from the RGBA readback (bottom-up rows), v1's box dilation (rows: each run of set pixels fills its reach; columns: row-major sweeps with a counter per column), `keep_room_mask` (+ coverage), `encode_mask_png`. `pngenc`: minimal PNG writer (gray8/gray16/RGBA8). `envmap`: the environment map from the photo (v1's shader: directions → camera frame, mirrored behind, clamped to the frame, sRGB → linear, ACES undone) with `Mipmapped { max_anisotropy }` (box mip chain, LOD from 2×2-quad derivatives, EXT_texture_filter_anisotropic sampling; v1's GPU path) or `Bilinear`; f32 or half-float output. `color`: sRGB, three.js ACES and v1's inverse, three.js `Matrix3.invert`. `sh`: the irradiance basis, v1's 96 Fibonacci directions and Gauss–Jordan, `rotate_sh` (band 0 kept, band 1 exact, band 2 evaluate-turn-refit), `rotate_sh_v1` (v1's full refit), `irradiance_at`, `scale_bands`, `max_band_scale`, `splat_gain`, `warmth_tint`, `splat_multiplier`. `half`: f32 ↔ binary16 (round to nearest even). `fuzz/`: cargo-fuzz targets `decode_png`, `mask_and_env`, hand-made seeds and a PNG dictionary. |
| `core/crates/wasm-web` (`midstudy-wasm-web`) | wasm-bindgen `=0.2.121` exports. `Camera` class with a 32-f64 scratch in wasm memory (inputs of item calls and every result go through it: no allocation per call), `F64Buf` (zero-copy buffers), result classes with `ptr()`/`len()` (`DepthResult`, `MaskResult` (+`toPng`), `EnvResult`), free functions for the clamps, items, hulls, drags, light. Matrices cross as three.js `Matrix3.elements`. Errors are thrown `Error`s, never traps. `build-web.sh`: the build until f-toolchain's lands. |
| `core/js/web.ts` | The typed face (strict TS, no `any`/casts/`!`): `loadKernels(url|bytes|module)`, `loadKernelsSync`, `SceneCamera` (project, floorToPhoto, photoToFloor, ray, horizonAt, pitchFromHorizon, screenRect, hitBox, landingSpot, planePointAt, projectMany; `dispose()` + a FinalizationRegistry), `clampCamera`, `clampLook`, wraps, items, hulls, drags, ruler, light, `decodeDepth`, `keepRoomMask`, `envMap`; the worker side `serveKernels(port)` and the client `KernelWorker` (`decodeDepth`, `keepRoomMask`, `envMap`, `envMapFromImage` (createImageBitmap + OffscreenCanvas in the worker)), inputs and results transferred. |

## Commands (repo root; `NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c`)

```sh
# Rust: tests (unit, golden, proptest), clippy -D warnings (host and wasm32), fmt
(cd core && nix shell $NP#cargo $NP#rustc $NP#clippy $NP#rustfmt -c sh -c '
  cargo test -p midstudy-geom -p midstudy-raster -p midstudy-wasm-web &&
  cargo clippy -p midstudy-geom -p midstudy-raster -p midstudy-wasm-web --all-targets -- -D warnings &&
  RUSTFLAGS="-C target-feature=+simd128" cargo clippy --target wasm32-unknown-unknown -p midstudy-wasm-web -- -D warnings &&
  cargo fmt --check -p midstudy-geom -p midstudy-raster -p midstudy-wasm-web')
core/crates/wasm-web/build-web.sh             # build/wasm/web/ (SIMD128); --no-simd → build/wasm/web-nosimd/
nix develop -c node core/crates/wasm-web/tests/diff.mjs        # differential vs v1 (SEED=, N= ; default N 3000)
nix develop -c node core/crates/wasm-web/tests/v1-sync.mjs     # the lifted v1 blocks are still v1's text
nix develop -c node core/crates/wasm-web/tests/worker.mjs      # serveKernels/KernelWorker over a MessageChannel
core/crates/wasm-web/tests/browser/run.sh                      # the face in headless Chrome (fetch init, real Worker)
nix develop -c node scripts/eval-lock.mjs -- node core/crates/wasm-web/tests/bench.mjs   # v1 JS vs wasm
(cd core && cargo run --release -p midstudy-raster --example bench)                      # native timings
nix develop -c evals/py core/crates/raster/tests/support/pil_depth.py   # Pillow's decode digests (golden_depth.rs)
(cd core/crates/raster && nix shell $NP#cargo-fuzz $NP#cargo $NP#rustc -c sh -c \
  'RUSTC_BOOTSTRAP=1 cargo fuzz run -s none decode_png <corpus> fuzz/seeds/decode_png -- -dict=fuzz/png.dict -max_total_time=180')
python3 core/crates/wasm-web/tests/v1/lift.py   # regenerate tests/v1/{engine,lighting}.mjs from planner/ (templates)
# TS: strict type check of the face with REFACTOR §3's flags (no tsconfig on this branch yet)
nix shell $NP#typescript -c tsc --noEmit --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes \
  --noImplicitOverride --noPropertyAccessFromIndexSignature --useUnknownInCatchVariables --verbatimModuleSyntax \
  --erasableSyntaxOnly --allowImportingTsExtensions --target es2023 --module nodenext --moduleResolution nodenext \
  --lib es2023,dom,dom.iterable --skipLibCheck core/js/web.ts core/crates/wasm-web/tests/port-types.ts
```

## Results (2026-11-05, this branch)

- `cargo test`: geom 25 unit + 5 golden + 13 proptest (4000 cases each); raster 19 unit + 2 golden + 7 proptest
  (2000 cases each). clippy `-D warnings` clean on host and wasm32; fmt clean.
- Golden scenes: all 80 object corners project onto `corner_px` within 4.95e-4 px (the file rounds to 1e-3:
  `toFixed(3)`, so the task's "1e-6 px of corner_px" is checked against the harness's full-precision §4.1 instead: 320
  corners within 2.3e-13 px); floor points round-trip within 1.8e-15 m (the file's rounded px within the rounding's
  reach, 7e-6 m); horizon, roll and pitch signs pinned; truth.json's corners rebuilt from the item frame (to its 6
  decimals); lighting.json's `world.key_direction` = R · key (2e-6, its rounding). depth.png: the decoder equals Pillow
  on all five golden files (SHA-256 of the samples) and open floor reads 0.
- Differential (`diff.mjs`; seeds 20261105 N 3000, 777 N 10 000, 4242 N 6000; the last two runs after the final
  changes): 49/49 groups pass. Worst relative errors:
  projectPhoto 1.3e-13, photoToFloor 6.4e-14, ray 5e-16, horizonAt 5.5e-16, setPitchFromHorizon 4.5e-16, screen rect
  9.2e-12, planePointAt 2.6e-14, rotateSH 2.0e-15, maxBandScale 3.5e-13, splatGain 2.8e-15; exact: clampCamera, Look
  clamps, wrapDeg, wrapAz, round, clampElev, depthScale, rotateSelected, convexHull, pointInHull, distToHull, hitItemAt,
  landingSpot, dragHeight, drags (move/lift/rotate), ruler, depth.png (golden, 300 random PNGs over all filters and
  both depths: f32 bit for bit), keep-room mask and dilate (303 sizes incl. 2048×1152: every pixel and the coverage),
  irradianceAt, scaleBands, turnBetween, warmthTint, the env map (bilinear) against the transcribed shader.
- Worker test 8/8 (MessageChannel, transfers, errors); v1-sync 28/28 blocks exact.
- Headless Chrome (`tests/browser/run.sh`): 10/10. `loadKernels` over fetch, a module Worker, `envMapFromImage` (worker
  decode) equal to the same decode on the main thread; an `<img>` decode differs from `createImageBitmap`'s by at most
  1 level in 11 % of bytes (JPEG decoder paths), so a worker-made map is within that of what v1 sampled. Against v1's
  own GPU bake (its shader, lifted; the photo texture made as engine.js makes it): the mipmapped CPU map differs by
  2.1 % of the mean (median 0.45 %, p95 12 %), plain bilinear by 2.2 % (median 0.01 %, p95 16 %): most of the sphere
  is the clamped frame edge (identical), and inside the frame the mipmapped lookup is the closer one.
- Fuzz (no ASan runtime in nixpkgs' rustc, so `-s none`; the code is safe Rust, panics are what's hunted):
  `decode_png` 73 M runs in 3 min, then 28 M in 90 s after the last changes (CRCs skipped by the `fuzzing` feature),
  373 edges, no crash; `mask_and_env` 14.7 M + 30.8 M runs, no crash.
- Benchmarks: see below.

## Decisions (and where v1 and the contract differ)

1. **photoToFloor's horizon test is v1's**: none when the *unit* ray's y ≥ −1e-9 (the contract says y ≥ 0). The band
   between is floor points more than 1e9 · height away; the differential test notes any case within rounding of the
   threshold (none hit at N 10 000). The harness (`evals/lib/harness.mjs`) uses y ≥ 0; the diff notes that too.
2. **The PNG decoder is stricter than v1** (v1's `loadDepth` never sees bad files from Pillow): it checks chunk CRCs,
   refuses truncated chunks, a missing IEND, filter types above 4 (v1 decodes them as Paeth), compression/filter method
   ≠ 0, and image data of the wrong length (v1 reads missing bytes as 0). On valid files it is bit-identical; the
   diff counts v1-decodes/v2-refuses on damaged files as notes (18 of 300 damaged files).
3. **SH rotation**: band 0 kept, band 1 turned exactly, band 2 refitted as v1 does over its 96 directions, keeping the
   refit's leak into band 0 (three.js's L20 basis `0.743125 z² − 0.247708` is not zero-mean: 3.3e-7), so the turned
   probe's irradiance is exactly the original's in turned directions (prop test) and v1's within 2e-15.
4. **Environment map**: the CPU emulates v1's mipmapped, anisotropy-4 lookup (the default); `anisotropy 0` is plain
   bilinear and equals the JS transcription of v1's shader exactly when both use π (v1's GLSL wrote 3.14159265 and
   6.28318531; with those, steep pixels move ~1e-4 relative). A GPU's exact mip filtering isn't reproducible (driver);
   against SwiftShader's run of v1's shader the mipmapped CPU map is within 2.1 % on average (see Results). Output rows:
   row 0 looks down (v ≈ 0), as a `DataTexture` with `flipY` false reads it; default half floats for a `HalfFloatType`
   texture like v1's target. Measured: v1's GPU bake is 20× faster than the CPU kernel (Benchmarks), so the engine
   should keep the bake.
5. **world bounds of an empty box**: three.js returns a box with min > max untransformed; replicated (found by the diff).
6. **wrapAz** is v1's bit for bit, which makes the azimuth clamp idempotent only to 2 ulps of 360 (prop test allows it).
7. **The 0.12°/CSS px cap lives in geom** (`horizon_drag_gain`, `horizon_drag_row`, with the property
   |Δpitch| ≤ 0.12°·|Δy| proven in a prop test); the pointer bookkeeping stays in TS.
8. **Boundary**: the camera's hot calls use a scratch in wasm memory (the face fills/reads it through a cached
   `Float64Array` view, re-made when memory grows); heavy results are viewed in place and copied once (needed anyway
   to transfer them out of the worker). Matrices are three.js column-major.
9. **The mask PNG is 8-bit grayscale** (v1's canvas wrote RGBA with the same 0/255 values).
10. Clippy pedantic at `-D warnings`: crates allow `many_single_char_names` (maths names); tests allow unwrap/expect.

## Benchmarks

M3 Max (14 cores), Node 22.23, median of 7 (9 native) after a warm-up, wasm timings including the copy out of wasm
memory. The machine was shared and loaded (load average 10–11) and the exclusive eval lock was unavailable (see the
request about the lock), so these are back-to-back comparisons on a busy machine, not quiet-machine numbers.

Node 22.23 (`tests/bench.mjs`, final run, load average 14.7) and native (`examples/bench.rs`, same run), ms:

| task | v1 JS | wasm, SIMD128 | wasm, no SIMD | native |
|---|---|---|---|---|
| depth.png 1024×768 decode, filter 0 (golden file) | 12.95 | **1.93** (6.7×) | 1.95 | 1.23 |
| depth.png 1024×768 decode, every row Paeth | 13.61 | **5.93** (2.3×) | 4.38 (3.1×) | 4.69 |
| keep-room mask 2048×1152 (threshold, dilate, coverage) | 20.41 | **2.63** (7.8×) | 5.18 | 1.63 |
| its PNG, zlib level 6 / 1 (v1: canvas `toDataURL`, not in Node) | – | 4.24 / 0.82 | – | 2.68 / – |
| 10⁵ on-screen hit tests (`hitItemAt` vs `hitBox`, one call each) | 156.8 | **21.8** (7.2×) | – | – |
| 10⁶ projections, one batch (`projectMany`, incl. 48 MB of copies) | 22.58 | 7.68 (2.9×) | 6.78 | 0.83 |
| 10⁶ projections, one call each through the face | 22.58 | 20.36 (1.1×) | – | – |
| env map 512×256 from 2048×1536, mipmapped aniso 4 / bilinear | GPU (see below); JS transcription 100.3 | 35.5 / 17.2 | 33.8 / 16.1 | 17.1 / 6.9 |

Headless Chrome 147 (`tests/browser/run.sh`, warm medians): depth.png decode v1 5.8 → wasm 2.8 ms (2.1×; the worker
round trip 3.2 ms, off the main thread); keep-room mask v1 17.7 → 2.8 ms (6.3×), 6.7 ms with its PNG; the CPU
environment map 35.4 ms on the main thread (115 ms in the worker including the 1600×1200 JPEG decode), against **v1's
own GPU bake at 1.6 ms** (SwiftShader, readback included).

Against REFACTOR §4.1's targets: keep-room mask and hit tests ≥ 3× (6–8×). Depth decode 2.1–6.7× by filter mix and
runtime, and in v2 it leaves the main thread. **The environment map should stay a GPU pass** for WebGL (the CPU kernel
is 20× slower than even SwiftShader's bake); the kernel is the reference and a fallback for a renderer without that
pass (WebGPU before its TSL port). Single small calls (one projection, one clamp) cost about what v1's JS costs: batch
them (`projectMany`) or keep them in TS where that is simpler.

SIMD128: the kernels are written as straight loops that LLVM vectorises when `+simd128` is on (the wasm carries
v128/i8x16/i32x4/f64x2 code). Measured with and without: filter-0 depth decode 2× faster, the mask 1.4×, projections
and the environment map unchanged, and Paeth decode *slower* (5.7 against 4.2 ms: the SLP vectoriser paired the two
byte chains of 16-bit samples), fixed by unfiltering one chain at a time. No hand-written `core::arch::wasm32` code:
safe Rust has no v128 load from a slice (`v128_load` is `unsafe`, which these crates forbid), and what is left scalar
is sequential by nature (the PNG filters' left-to-right chains, the row scan of the dilation).

## Requests to other tracks

- **f-toolchain**: build `build/wasm/web/` as `build-web.sh` does: `cargo build --release --target wasm32-unknown-unknown
  -p midstudy-wasm-web` with `RUSTFLAGS=-C target-feature=+simd128` (put it in `core/.cargo/config.toml` under
  `[target.wasm32-unknown-unknown]`), `wasm-bindgen --target web --out-dir build/wasm/web` (0.2.121, file names
  `midstudy_wasm_web.js`/`_bg.wasm`, which `core/js/web.ts` imports), then `wasm-opt -O3` with
  `--enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext --enable-mutable-globals
  --enable-reference-types --enable-multivalue`. nixpkgs' rustc 1.95 already ships the wasm32-unknown-unknown std; the
  link needs `lld` on PATH (nixpkgs#lld). The planner bundle needs a worker entry (`import { serveKernels } from
  '…/core/js/web.ts'; serveKernels(self, wasmUrl)`, see `tests/browser/worker.ts`) and must serve
  `midstudy_wasm_web_bg.wasm` (pass its URL to `loadKernels`). tsconfig: `lib` with `dom` (the face uses Worker,
  MessageEvent, OffscreenCanvas types). Fuzz smoke in `check:rust`: `RUSTC_BOOTSTRAP=1 cargo fuzz run -s none …` (the
  nixpkgs rustc has no ASan runtime). Optional `clippy.toml`: `allow-unwrap-in-tests = true`.
- **Owner of scripts/eval-lock.mjs (main session)**: two `--exclusive` waiters deadlock (each holds part of the slots
  while waiting for the rest: k-geom held slot 1 while f-perf held 0 and 2; I released mine), and one-slot waiters
  starve an exclusive one (they take each slot it frees). Suggest: exclusive takes slots only when all are free, or a
  queue file.
- **engine**: use `SceneCamera` for §4.1 (dispose it on camera change), `clampCamera`/`clampLook` for the clamps. Depth:
  `KernelWorker.decodeDepth` → `DataTexture(data, w, h, RedFormat, FloatType)` as v1 (scale stays a uniform). Env map:
  keep v1's GPU bake on WebGL (1.6 ms on SwiftShader against 35 ms for the CPU kernel); where that pass doesn't exist
  yet (WebGPU), `KernelWorker.envMapFromImage(photoBlob, { rotation: R.elements, fov_y_deg })` → `DataTexture(data, 512,
  256, RGBAFormat, HalfFloatType)`, `flipY` false, `LinearFilter`, `EquirectangularReflectionMapping`, linear-sRGB,
  then `pmrem.fromEquirectangular` as v1. Mask: readback (bottom-up) → `KernelWorker.keepRoomMask(rgba, w, h, { png: true })`
  → `data:image/png;base64,…`. Hit tests: `hitBox` → `'behind'` means raycast as v1.
- **webgpu-spike / webgpu-swap**: until the env bake is ported to TSL, `KernelWorker.envMapFromImage` gives the same
  reflections map without any GLSL (mean 2 % from v1's GPU bake), as a half-float `DataTexture` for PMREM.
- **proofs**: `core/crates/geom/LEAN.md` on branch `v2-k-geom`.
- **kernels-hardening**: Miri on raster (not run here), longer fuzz campaigns, Kani if packaged.

## Left / open

- Miri and Kani not run (kernels-hardening's); eslint not run (no config on this branch yet); TScert n/a (no `logic/`).
- Benchmarks ran on a loaded machine (load 10–15) in one eval-lock slot: the exclusive lock was contended (see the
  request). Re-measure on a quiet machine for E17.
- Paeth-heavy depth.png decodes 1.4 ms slower with SIMD128 than without (LLVM pairs the two byte chains); per-chain
  loops were slower still in wasm, so the chunked form stays. A hand-written Paeth needs unsafe v128 loads.
- The env map's GPU-like filtering is an approximation of a driver's (2 % mean difference from SwiftShader).
