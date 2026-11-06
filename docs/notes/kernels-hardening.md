# kernels-hardening (v2 Phase 2): the media, geom and raster kernels made rigorous and fast

Branch `v2-kernels-hardening` (from `v2` at `979677c`). Owns `core/crates/{media,geom,raster,wasm-web,wasm-node}/**`,
`core/js/{web,node}.ts`, `core/fuzz/**`, `core/miri.txt`. Every public API of the crates and of both faces is unchanged
except additions (listed under Interfaces). Everything below was run on rabbit on 2026-11-06 (01:25–05:00), fal never
involved, headless Chrome from `$PUPPETEER_EXECUTABLE_PATH` (147.0.7727.15) only, through the eval lock where it
measured time. The machine was shared with Phase 2's other tracks: load averages are given with the timings.

## What changed

| Area | What | Where |
|---|---|---|
| Proofs track findings | geom LEAN.md 13 restated (four quarter turns give back the stored angle **except −180**, which comes back as 180, as in v1: compare `wrap_deg` of both sides, exact otherwise); the proptest `four_quarter_turns` now draws one case in ten next to ±180 and a unit test pins the four exceptional angles `k/1e7`, `k ∈ [−1 799 999 999, −1 799 999 996]`. LEAN.md 7 restated: up is up only **ahead of the camera's foot** (z < 0), with the exact formula `Δpy = f·δ·z/(d·d')` checked by a new property (`raising_a_point_moves_its_pixel_by_the_formula`) and a steep-down unit case. No behaviour change. | `geom/LEAN.md`, `geom/tests/props.rs`, `geom/src/camera.rs` |
| Miri | `core/miri.txt` = media, raster, geom. Under Miri: proptest runs 4 cases with no failure file (Miri's isolation has no `getcwd`, which proptest's file persistence needs), exhaustive loops sample (every 251st value, 8 dilation trials), the golden tests that read fixtures are `#[cfg_attr(miri, ignore)]`, the full-size env map in `refuses_bad_buffers` becomes 16 × 8. `check:rust` runs it as is (no MIRIFLAGS needed). | `core/miri.txt`, the tests |
| Kani | `media/src/proofs.rs` (16 harnesses) and `raster/src/proofs.rs` (5), table below. Refactors for them, no behaviour change: `jpeg::find_ff` is the plain `position` scan under `cfg(kani)` (CBMC needs minutes for the 64-byte block scan inside the walk's loops; two harnesses prove the block scan equal to it), and `http::digits_value` (the Content-Length digit fold), `png::walk` (the PNG chunk walk, without the plan's allocation) and raster's `png::unfilter_rows` (the decoder's pixel stage) are functions of their own. | `*/src/proofs.rs` |
| Bounded exhaustive tests | Where Kani didn't finish (string-heavy parsers): `media/tests/exhaustive.rs` runs every input up to a bound through every parser; `raster/src/png.rs` `every_small_image` runs the pixel stage on every small image. Table below. | |
| Fuzzing | Every target now checks invariants that were only property-tested (exactness of `Removed::any` / `changed`, plan = strip, pass-through = frame, both GLB layouts alike, a decoded depth.png re-encodes and decodes to the same image); a new target `media_misc` (base64 ×3, meta, data URIs, slugs and v1's name order, zip entries and plans, sniff); seeds from `evals/lib/metadata.py`'s GPS canaries and the fixtures (`media/fuzz/seeds.py`); dictionaries; `core/fuzz/campaign.sh` (one campaign) and `core/fuzz/minimize.sh` (merge into the tracked corpus); tracked minimised corpora `fuzz/corpus/<target>/` (inputs ≤ 8 KiB), which `check:fuzz` reads as seeds (raster's hand-made seeds moved there from `fuzz/seeds/`, which `check:fuzz` never read). | `core/crates/{media,raster}/fuzz/`, `core/fuzz/` |
| Differential fuzzing | `media/tests/diff_fuzz.py`: random havoc mutations of diff_v1's corpus and of the fuzz corpora for a set time, through v1's own functions and `examples/difftool`, comparing decisions and bytes; unexpected cases saved to `evals/out/kh/diff-fuzz/failures/`. | `media/tests/diff_fuzz.py` |
| Fix from differential fuzzing | `path::static_route` redirected only a target whose path before `?`/`#` is exactly `/`; v1 redirects when `urlsplit(target).path == "/"`, which also strips leading C0 controls and spaces, removes tabs and line breaks, and splits off a scheme and a `//netloc` (so `http://127.0.0.1:8765/`, RFC 9112's absolute form, and `x:/` redirect in v1). Now `path_is_root` (an addition) emulates CPython 3.12's `urlsplit` exactly for this test; where `urlsplit` raises (unbalanced or invalid brackets in a netloc), v1's handler crashed: `EXPECTED["path-v1-crash"]`. | `media/src/path.rs` |
| Zero-copy (Node) | `jpeg::strip_plan`, `png::strip_plan` (additions; `media/src/plan.rs`): the stripped file as ranges of the input plus the few bytes the strip writes itself (a JFIF header cut to 16 bytes). `strip` is now `strip_plan` + `apply` (one code path). wasm-node exports `jpeg_strip_plan`, `png_strip_plan`; node.ts adds `stripJpegPieces`, `stripPngPieces` (views of the input: only the plan crosses the boundary) and `stripJpeg` / `stripPng` now join the pieces once instead of copying the output out of wasm memory. | `media`, `wasm-node`, `core/js/node.ts` |
| GLB | The binary chunk is written straight into the output file (it was copied into its own `Vec` first, then into the file): one copy less of nearly the whole file. | `media/src/glb.rs` |
| Depth | `mm_to_m_into` with scale 1 (the planner's case) multiplies by 0.001 instead of dividing by 1000: the same f32 bits for all 65,536 samples (checked exhaustively against v1's division by a new test, and by `diff.mjs`). | `raster/src/depth.rs` |
| wasm size | The env map sampler used `f64::clamp(0.0, w − 1.0)`; with a runtime bound its assert (whose message formats both bounds with `{:?}`) linked Rust's whole float formatter (Grisu + Dragon, ~20 KB before wasm-opt). `max` then `min` gives the same texel for every input (NaN → 0 either way) and no panic path. | `raster/src/envmap.rs` |
| Lint and docs | `#![deny(missing_docs)]` in all five crates (every public item already had docs; now enforced); the crate-level `many_single_char_names` allows carry a `reason`; clippy pedantic `-D warnings` clean on the host and on wasm32. A README per crate stating its guarantees and how each is checked. The two `examples/bench.rs` (media, raster) collided in `target/*/examples/` (cargo warned it will become an error): renamed `bench-media`, `bench-raster`. | |
| Benchmarks | `media/tests/bench_inputs.py` (deterministic inputs), `media/tests/bench_matrix.mjs` (v1 Python, native, wasm, any extra build, rounds interleaved), `wasm-web/tests/browser/bench.ts` + `bench-run.mjs` (headless Chrome, one bundle per build, rounds interleaved), `wasm-node/js-test/bench.ts` (`jpeg-pieces`, `png-pieces` ops). | |

## Commands

```sh
# Rust (from core/)
nix develop ..#default -c cargo test --workspace                       # unit, property, golden, exhaustive tests
nix develop ..#nightly -c cargo kani --workspace                       # every Kani harness (check:rust does this)
MIRI_SYSROOT=$PWD/../build/miri/sysroot nix develop ..#nightly -c cargo miri test -p midstudy-media  # (raster, geom)
# Fuzzing (repo root)
nix develop -c evals/py core/crates/media/fuzz/seeds.py                # seeds into evals/out/kh/fuzz-seeds/
nix develop .#nightly -c core/fuzz/campaign.sh jpeg_strip 1200          # one 20-minute campaign (ASan)
nix develop .#nightly -c core/fuzz/minimize.sh jpeg_strip               # merge into fuzz/corpus/jpeg_strip/
# Against v1 (repo root; build the difftool first: (cd core && cargo build --release --example difftool -p midstudy-media))
nix develop -c evals/py core/crates/media/tests/diff_v1.py --seed 7
nix develop -c evals/py core/crates/media/tests/diff_fuzz.py --seconds 1200 --corpus jpeg=core/crates/media/fuzz/corpus/jpeg_strip …
# Benchmarks (repo root, a quiet machine)
nix develop -c evals/py core/crates/media/tests/bench_inputs.py
nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/media/tests/bench_matrix.mjs --pieces
nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/wasm-web/tests/bench.mjs
nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/wasm-web/tests/browser/bench-run.mjs --build before=<dir> --build after=.
```

The "before" of every A/B below is a snapshot of `979677c` (its `build/wasm/{web,node}`, `core/js/*.ts`, the test
scripts and the release bench binaries) in `evals/out/kh/before/` (git-ignored); `evals/out/kh/run-after.sh` runs the
A/B. Logs and JSON results are in `evals/out/kh/`.

## Results

### Kani (Kani 0.68.0, CBMC 6.11.0, the nightly shell)

Final run, on the code as committed (04:39, load 11–16): `cargo kani --workspace -j 4 --output-format terse`:
**21 harnesses, 21 verified, 0 failures**, 244 s wall, 627 s of verification in all. check:rust runs the same
harnesses one at a time (`cargo kani --workspace`): the sequential run at 03:45 (load 9–40) verified 20 of 21 and gave
the times below; the 21st, then `png_strip_short`, ran CBMC out of memory on the strip plan's `Vec`, so the chunk walk
became `png::walk`, which allocates nothing, and `png_walk_short` verifies it at the same bound in 11.5 s.

| Harness | Every input up to | Proves (besides no panic, overflow or out-of-bounds) | s |
|---|---|---|---|
| media `sniff_short` | 16 bytes | JPEG iff `FF D8 FF`, PNG iff the signature | 45.3 |
| `step_moves_forward_in_bounds` | 10 bytes, every offset | `at < next ≤ len`, items inside the input (so every JPEG walk ends) | 56.1 |
| `scan_end_finds_a_marker` | 10 bytes, every start | the end is an `FF` followed by neither `00` nor RST | 61.0 |
| `frame_info_short` | 16 bytes | a size is never zero, the marker is an SOF | 52.5 |
| `find_ff_blocks_is_position` / `_one_block` | 8 bytes / every 65 bytes | the SIMD-friendly block scan = `position` | 15.5 / 9.2 |
| `png_walk_short` | 32 bytes | signature first, whole chunks in order, all of the input iff nothing removed | 11.5 |
| `png_size_short` | 26 bytes | an answer only with the signature and IHDR | 0.6 |
| `glb_container_short` | 40 bytes | the chunks lie inside the header's length | 35.4 |
| `glb_layout_arithmetic` | every `usize` | padding < 16, removed a multiple of 16, nothing lost; `pad4` | 0.1 |
| `same_bytes_is_eq` / `_one_block` | 6 bytes each / 65 bytes | the XOR-fold comparison = `==` | 10.8 / 3.4 |
| `is_slug_is_the_regex` | 8 bytes, any UTF-8 | `is_slug` = `^[a-z0-9][a-z0-9-]{0,63}$` | 42.6 |
| `digits_value_is_exact` | 16 bytes | a value iff 1–15 ASCII digits, equal to their number, < 10¹⁵ | 17.8 |
| `content_length_short` | 4 bytes | several values refused | 21.5 |
| `base64_forgiving_short` | 8 bytes | at most 3 bytes per 4 characters | 40.7 |
| raster `paeth_is_the_spec` | all 2²⁴ | Paeth = the PNG spec's predictor | 1.2 |
| `unfilter_inverts_filter_8bit` | rows of 4 bytes, every filter byte | unfilter ∘ spec filter = id; unknown filters refused, row untouched | 132.3 |
| `unfilter_inverts_filter_16bit` | rows of 2 pixels | the same with 2 bytes a pixel | 99.0 |
| `header_is_checked` | all 2¹⁰⁴ IHDRs | accepted = gray 8/16, non-interlaced, 1 px to 16 Mpx | 7.0 |
| `next_chunk_short` | 20 bytes | length, CRC and the rest consistent | 32.6 |

Not in Kani (timed out at 5 minutes, or ran out of memory, at the
bounds tried, under load 15–40): `normalize`/`static_route` (3 bytes), `host_name` (4), `meta::decode` (4), CPython's
base64 (4: verified once in 133 s, then dropped as too slow for the gate), data URIs (2 after the 22-byte prefix, 3
after `data:`), `zip::decide` (3), the JSON reader (4), `glb::strip` (22), `jpeg::strip` + `is_clean` + `passthrough`
together (4), `zip::megabytes` (64-bit division: Lean proves it, `megabytes_eq_roundHalfEven`), the raster decoder
(33) and its row loop (2 × 2). All are covered by the bounded exhaustive tests:

| Exhaustive test | Inputs |
|---|---|
| `every_short_byte_string`: every parser | all 65,793 byte strings of 0–2 bytes |
| `every_short_path`: normalize, resolve, static route (+ every string parser) | 111,151 strings of ≤ 4 of 18 special characters; 19,531 of ≤ 6 of `/ . %2e %2f x` |
| `every_short_host`: host name, Host decision (+ every string parser) | 579,195 strings of ≤ 5 of 14 characters |
| `every_short_base64`: CPython strict/lenient, forgiving, meta, data URIs | 402,234 strings of ≤ 5 of 13 characters |
| `every_short_zip_name`: entry decisions | 402,234 names × 3 (UTF-8 file, cp437 directory, link) |
| `every_short_gltf_json`: the JSON reader through `glb::strip`, both layouts | 69,905 texts of ≤ 4 JSON characters, 820 of ≤ 3 glTF fragments |
| `every_short_jpeg`: strip, plan, clean, frame, pass-through | 579,195 JPEGs of ≤ 5 of 14 structural tokens |
| `every_short_png`: strip, plan, size | 16,105 PNGs of ≤ 4 of 11 chunk tokens |
| raster `every_small_image`: the pixel stage | 36,610 images (8-bit ≤ 2 × 2, 16-bit ≤ 2 × 1) |

3.1 M inputs, 2.4 s in debug (`cargo test`), no failure.

### Miri (`cargo miri test -p <crate>`, as check:rust runs it, 03:45, load 9–17)

| Crate | Tests | Wall |
|---|---|---|
| midstudy-media | 47 unit + 8 exhaustive (1-byte bounds under Miri) + 16 property | 270 s (228 s again at 04:40 on the final code) |
| midstudy-raster | 21 unit + 7 property (2 golden ignored) | 134 s |
| midstudy-geom | 25 unit + 15 property (5 golden ignored) | 19 s |

No undefined behaviour. Before: no `core/miri.txt`; gate-1's manual run needed `MIRIFLAGS=-Zmiri-disable-isolation`
and `PROPTEST_CASES=4` and lost raster's env-map tests (one was still running after 36 min).

### Fuzzing (cargo-fuzz 0.13.1, nightly-2026-08-21, ASan)

| Target | Round 1 (20 min) | Round 2 | Round 3 (20 min, final code) | Total | Coverage (edges) |
|---|---|---|---|---|---|
| jpeg_strip | 75.1 M | 13.5 M (10 min, plans) | 55.1 M | 143.7 M, 50 min | 390 |
| png_strip | 109.2 M (7 min: stopped by the harness finding below) | 154.9 M (10 min) | 249.5 M + 38.4 M (3 min, `walk`) | 552.0 M, 40 min | 179 |
| glb_strip | 398.0 M | – | 295.9 M | 693.9 M, 40 min | 1,179 |
| path_normalize | 46.4 M | – | 70.0 M | 116.4 M, 40 min | 576 |
| host_check | 387.0 M | – | 358.8 M | 745.8 M, 40 min | 392 |
| decode_png | 0.3 M (full-size depth maps) | 126.4 M (small inputs, 20 min) | 0.5 M | 127.2 M, 60 min | 1,516 |
| media_misc (new) | 67.5 M | – | 83.0 M | 150.5 M, 40 min | 1,419 |
| mask_and_env | 156.3 M | – | 159.3 M | 315.6 M, 40 min | 350 |

No crash, no ASan report, no failure of the crates. Three of the new harness assertions failed (two in 15-second smoke
runs, one in round 1): one was the harness's mistake (a zip entry's suffix is that of its last segment that isn't
empty or `.`, as `PurePosixPath` reads it: `x/evil.obj///.` is an `.obj`), two are v1 behaviour (kept, pinned by unit
tests): `frame_info` reads the frame fields after an SOF marker even when its segment is too short to hold
them, as v1's `jpeg_size` does, so a strip that drops fill bytes there changes what it reads
(`frame_info_reads_past_a_short_sof_like_v1`); `png::size` reads bytes 16..24 whatever IHDR's length, as v1's
`png_size` does (`size_reads_fixed_offsets_like_v1`). Tracked corpora after merging every round: 4,428 inputs, 684 KB
(`fuzz/corpus/<target>/`, inputs ≤ 8 KiB).

### Differential testing against v1

- `diff_fuzz.py`, 20 minutes, seed 12, on the code before the one-pass GLB assembly and `png::walk` (both
  behaviour-preserving, rechecked by `diff_v1.py` below): **31,923,450 cases**, every
  difference an expected one: jpeg-strip, jpeg-size, jpeg-clean, png-strip, png-size, sniff, host and path-normalize
  all identical (2.4–4.8 M cases each); path-route 4,773,600, 13 `path-v1-crash`; jpeg-passthrough 4,693
  `pass-decode`; glb 895,050, 1,738 expected (`glb-*`). The first run (seed 11) found the `/` redirect difference
  (`\0/`, ` /`: 3 cases in 133,750) and then crashed on v1's `urlsplit` raising: both fixed, see What changed.
- `diff_v1.py`: seed 7 after the one-pass GLB assembly and seed 8 on the code as committed: 102,349 cases each, every
  difference an expected one (jpeg-strip, png-strip, path-route, host, slug, base64, meta, data-uri, sniff-calib all
  identical), privacy 17/17 clean.
- Rust ↔ wasm: `face.test.ts` 12/12 (the GPS-canary corpus byte for byte against the native build; the strip pieces).
- web face: `diff.mjs` (seed 20261106, N 3000) 49/49 groups, env map (bilinear) and depth exact; `v1-sync.mjs` 28/28;
  `worker.mjs` 8/8; `tests/browser/run.sh` 10/10 in headless Chrome 147; `scripts/wasm-smoke.mjs` ok (Node and Chrome).

### Performance, before (979677c) and after, interleaved A/B

Media, Node 22.23 and Python 3.12, ms, median of 5 rounds of medians of 15 (03:42, exclusive lock, load 4–5; the GLB
rows from 04:36, load 14–19, after the one-pass GLB assembly):

| Input | v1 Python | native before → after | wasm in Node before → after | wasm, zero-copy pieces |
|---|---|---|---|---|
| photo-like 12 MP JPEG q92 + EXIF/GPS (6.2 MB) | 2.68 | 0.42 → 0.41 | **1.17 → 0.93** | **0.56** |
| the same + 200 KB after EOI | 2.69 | 0.42 → 0.41 | 1.14 → 0.90 | – |
| noisy 3 MP PNG + eXIf (7.6 MB) | 0.87 | 0.10 → 0.10 | **0.58 → 0.34** | **0.14** |
| smooth 12 MP JPEG, nothing to strip (335 KB) | 0.024 | 0.008 → 0.008 | 0.045 → 0.041 | 0.023 |
| GLB textured with the photo (6.2 MB), compact | 3.84 | **0.63 → 0.54** | 1.36 → 1.33 | – |
| SheenChair.glb (4.1 MB, 7 PNGs, nothing to strip) | 0.95 | **0.27 → 0.21** | 0.81 → 0.77 | – |
| gps-glb (2.7 KB) | 0.043 | 0.006 → 0.006 | 0.020 → 0.022 | – |

Raster: native (median of 3) depth.png filter 0 1.14 → 1.09 ms, env map bilinear 5.78 → 5.44, mipmapped 15.8 → 15.3,
the rest unchanged; Node wasm (3 rounds each) depth filter 0 1.71 → 1.66 ms (v1 JS 10.7), the mask 2.55 (v1 19.1),
10⁶ projections 6.5 (v1 21.0), 10⁵ hit tests 20.7 (v1 133), unchanged within 2 %. Headless Chrome 147 (5 rounds):

| Task | v1 JS | wasm before → after |
|---|---|---|
| depth.png 1024 × 768, filter 0 | 4.8 | 1.8 → 1.7 |
| depth.png, every row Paeth | 6.4 | 5.8 → 5.7 |
| keep-room mask 2048 × 1152 (+ PNG) | 17.2 | 2.7 → 2.7 (6.9 → 6.8) |
| 10⁶ projections (one batch) | 22.3 | 6.2 → 6.2 |
| 10⁵ hit tests | 107.8 | 19.1 → 19.4 |
| env map 512 × 256, mipmapped / bilinear | 49.8 (JS transcription) | 32.8 → 33.5 / 15.1 → 15.6 |

wasm size (after wasm-opt): web 176,108 → **154,096 bytes (−12.5 %)**; node 114,406 → 119,591 (+4.5 %: the plan
exports, `path_is_root`, the digit fold).

## Decisions (and where v1 and the contract differ)

1. **Kept v1's behaviour where fuzzing found it odd**: `frame_info` past a short SOF segment, `png::size` at fixed
   offsets (the contract's "never guessed" is about the frame header; v1 reads the fields after the marker whatever the
   segment's length, and the proofs track's model does the same). Pinned by tests, noted here.
2. **The `/` redirect follows v1's `urlsplit`**: the contract says "`GET /` redirects there" (§2.1); v1 also redirected
   absolute-form targets (`http://host/`) and targets with leading C0 controls, tabs or line breaks, which the contract
   doesn't mention. Kept v1 (the contract isn't contradicted, only less specific).
3. **Bounded exhaustive tests where Kani can't finish** (the task's fallback), with each bound stated; Kani kept for
   the byte walks and arithmetic, where it finishes in seconds to two minutes.
4. **Under Kani, `find_ff` is the plain scan**, proved equal to the production block scan (8 bytes; every 65-byte
   input); all other code Kani checks is the production code.
5. **Zero-copy for JPEG and PNG through plans** (the output is ranges of the input), not for GLB: its output
   interleaves rewritten JSON with stripped textures; there the binary chunk is now copied once instead of twice.
6. **No Paeth work**: every depth.png the calib track writes (Pillow) uses filter 0 on every row (checked on all ten
   depth fixtures), so a Paeth-filtered decode is not on the planner's path; three formulations tried natively were
   slower than the current one (3.47 ms against 3.92 and 4.77 for the unfilter alone).
7. **No hand-written SIMD128**: the hot loops already vectorise (k-geom, k-media), and safe Rust has no v128 load from
   a slice. The one SIMD-related regression (Paeth with SIMD128, k-geom's notes) is off the path (6).
8. **Formatting bloat**: removing Rust's float formatter from the web build (one `f64::clamp`) is the large win.
   The integer formatter and the error `Display` impls stay: the panic paths of std (bounds checks, capacity) link
   `core::fmt` anyway, and the messages' wording is checked by the evals.
9. The two bench examples are renamed (`bench-media`, `bench-raster`): `cargo` warned that their shared output name will
   become an error. `core/crates/wasm-node/build-node.sh` is deleted (unused since `npm run build`); `build-web.sh` stays
   for the no-SIMD comparison build.

## Interfaces added (nothing removed or changed)

- `midstudy_media::plan::{Plan, Piece}`, `jpeg::strip_plan`, `png::strip_plan`, `path::path_is_root`.
- wasm-node exports `jpeg_strip_plan`, `png_strip_plan` (envelope: the counts, then pieces: `start`, `end` or
  `0xFFFFFFFF`, `len`, bytes).
- `core/js/node.ts`: `stripJpegPieces`, `stripPngPieces`, type `StrippedPieces<R>` (`pieces`, `length`, `unchanged`,
  `removed`); `stripJpeg` / `stripPng` return a fresh exact buffer (was a view into the envelope).
- `core/js/web.ts`: unchanged.
- Behaviour: `staticRoute` / `static_route` now also redirect what v1 redirected (Decision 2).

## Requests

- **f-toolchain** (`scripts/check.mjs`): check:rust's Kani step (`cargo kani --workspace`, sequential) takes about
  10 minutes (627 s of verification measured at load 11–16); `cargo kani --workspace -j 4 --output-format terse` (Kani
  0.68 supports it) took 244 s wall for the same 21 harnesses. A `--harness-timeout` (needs `-Z unstable-options`) would bound a
  regression. Miri adds about 7 minutes (no MIRIFLAGS needed now). check:fuzz has 8 targets (media 6, raster 2).
- **server-core / server-routes**: `staticRoute` redirects absolute-form targets whose path is `/` (as v1); if the
  server rewrites absolute-form to origin-form first, nothing changes. For JPEG/PNG writes use `stripJpegPieces` /
  `stripPngPieces` with `fs.writev` (or a stream) to skip even the join.
- **proofs / proofs-final**: re-run `nix develop -c proofs/diff/run.sh` on the merged tree: `jpeg::strip` is now
  `strip_plan` + `apply` and `png::strip` walks through `png::walk` (names and results unchanged).
- **integration**: `core/crates/*/js-test` and `tests/` TS harnesses are still outside every tsconfig (gate-1's note);
  that needs a tsconfig (f-toolchain's paths).

## Left

- Kani bounds are small for the string-heavy parsers (exhaustive tests instead) and the decoder as a whole (fuzzed).
- The GLB rewrite isn't a plan: wasm still copies the output out (1.33 ms against 0.54 native for 6.2 MB).
- wasm-node grew 5 KB with the plan exports; the old `jpeg_strip` / `png_strip` exports stay (API additions only).
- Linux untested (Kani is packaged for aarch64-darwin only).
