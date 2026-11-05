# k-geom (v2 Phase 1): Rust geometry and raster kernels, their wasm build and TS face

Branch `v2-k-geom` (from `v2` at 0d40ff5). Plan: docs/REFACTOR.md §1–§8. Owned paths: `core/crates/{geom,raster,wasm-web}/**`,
`core/js/web.ts` (+ `core/Cargo.lock` entries). No `unsafe` anywhere (`forbid(unsafe_code)`; the wasm-bindgen macro's own
code compiles under it).

## What exists

| Where | What |
|---|---|
| `core/crates/geom` (`midstudy-geom`) | f64, no allocation. `camera`: the camera block, v1's clamps (`CameraBlock::clamped`, `same_as`), `Camera` (f, R = Rx·Rz, `project`, `floor_to_photo`, `ray_dir`/`ray`, `photo_to_floor`, `horizon_at`, `pitch_from_horizon`), the 0.12°/CSS px horizon-drag cap (`horizon_drag_gain`, `horizon_drag_row`), `depth_scale`, `turn_to_world`. `item`: poses (rotation_y ccw from above), `box_corners` (truth.json's order), `world_bounds`, `footprint`, `screen_rect`, `clamp_elevation`, `rotate_by`. `hull`: monotone chain, `point_in_hull`, `dist_to_hull`, `hull_hit`, `SmallHull` (stack). `drag`: three.js `Ray.intersectPlane`, `plane_point_at` (60 m cap), `drag_height`, `lift_plane`, `drag_move`/`drag_lift`/`grip_angle`/`drag_rotate`. `floor`: `landing_spot`, `ruler_length`, `ruler_rescale`. `look`: the Look's clamps (`LookNumber`), `az_el_of`, `dir_of`, `turn_between` (three.js quaternion maths), `v1_key_dir`. `jsmath`: `Math.round`, `Math.min/max` (NaN, ±0), V8's `Math.hypot`, `wrapDeg`, `wrapAz`, `round(v, n)` — so thresholded decisions take v1's branch. `view`: client ↔ photo px. `LEAN.md`: what the proofs track should prove. |
| `core/crates/raster` (`midstudy-raster`) | `png`: the depth.png decoder (8/16-bit grayscale, non-interlaced, all five filters, `miniz_oxide`, CRCs checked; the module denies `indexing_slicing`, `arithmetic_side_effects`, `cast_possible_truncation`). `depth`: mm → metres (× scale; scale 1 is v1's `Float32Array` bit for bit). `mask`: silhouette from the RGBA readback (bottom-up rows), v1's two-pass dilation (column pass row-major with per-column counters), `keep_room_mask` (+ coverage), `encode_mask_png`. `pngenc`: minimal PNG writer (gray8/gray16/RGBA8). `envmap`: the environment map from the photo (v1's shader: directions → camera frame, mirrored behind, clamped to the frame, sRGB → linear, ACES undone) with `Mipmapped { max_anisotropy }` (box mip chain, LOD from 2×2-quad derivatives, EXT_texture_filter_anisotropic sampling; v1's GPU path) or `Bilinear`; f32 or half-float output. `color`: sRGB, three.js ACES and v1's inverse, three.js `Matrix3.invert`. `sh`: the irradiance basis, v1's 96 Fibonacci directions and Gauss–Jordan, `rotate_sh` (band 0 kept, band 1 exact, band 2 evaluate-turn-refit), `rotate_sh_v1` (v1's full refit), `irradiance_at`, `scale_bands`, `max_band_scale`, `splat_gain`, `warmth_tint`, `splat_multiplier`. `half`: f32 ↔ binary16 (round to nearest even). `fuzz/`: cargo-fuzz targets `decode_png`, `mask_and_env`, hand-made seeds and a PNG dictionary. |
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
- Differential (`diff.mjs`, seed 20261105 N 3000 and seed 777 N 10 000): 49/49 groups pass. Worst relative errors:
  projectPhoto 1.3e-13, photoToFloor 6.4e-14, ray 5e-16, horizonAt 5.5e-16, setPitchFromHorizon 4.5e-16, screen rect
  9.2e-12, planePointAt 2.6e-14, rotateSH 2.0e-15, maxBandScale 3.5e-13, splatGain 2.8e-15; exact: clampCamera, Look
  clamps, wrapDeg, wrapAz, round, clampElev, depthScale, rotateSelected, convexHull, pointInHull, distToHull, hitItemAt,
  landingSpot, dragHeight, drags (move/lift/rotate), ruler, depth.png (golden, 300 random PNGs over all filters and
  both depths: f32 bit for bit), keep-room mask and dilate (303 sizes incl. 2048×1152: every pixel and the coverage),
  irradianceAt, scaleBands, turnBetween, warmthTint, the env map (bilinear) against the transcribed shader.
- Worker test 8/8; v1-sync 27/27 blocks exact.
- Fuzz (no ASan runtime in nixpkgs' rustc, so `-s none`; the code is safe Rust, panics are what's hunted):
  `decode_png` 73 M runs in 3 min (CRCs skipped by the `fuzzing` feature), 373 edges, no crash; `mask_and_env` 14.7 M
  runs, no crash.
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
   6.28318531; with those, steep pixels move ~1e-4 relative). The GPU's exact mip filtering isn't reproducible (driver);
   not compared against SwiftShader's render yet (open). Output rows: row 0 looks down (v ≈ 0), as a `DataTexture`
   with `flipY` false reads it; default half floats for a `HalfFloatType` texture like v1's target.
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

BENCH_TABLE

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
  `KernelWorker.envMapFromImage(photoBlob, { rotation: R.elements, fov_y_deg })` → `DataTexture(data, 512, 256,
  RGBAFormat, HalfFloatType)`, `flipY` false, `LinearFilter`, `EquirectangularReflectionMapping`, linear-sRGB, then
  `pmrem.fromEquirectangular` as v1. Mask: readback (bottom-up) → `KernelWorker.keepRoomMask(rgba, w, h, { png: true })`
  → `data:image/png;base64,…`. Hit tests: `hitBox` → `'behind'` means raycast as v1.
- **proofs**: `core/crates/geom/LEAN.md` on branch `v2-k-geom`.
- **kernels-hardening**: Miri on raster (not run here), longer fuzz campaigns, Kani if packaged.

## Left / open

- The mipmapped env map isn't compared with v1's GPU bake in a browser (only the bilinear path with the shader's maths).
- Miri not run; eslint not run (no config on this branch); TScert n/a (no `logic/` module here).
