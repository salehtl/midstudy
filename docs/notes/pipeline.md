# pipeline (v2 Phase 2): midstudy-add in TypeScript over Rust kernels

Branch `v2-pipeline` (from `v2` at 979677c). Owns `pipeline/**`, `core/crates/{splat,imaging,wasm-pipeline}/**`,
`core/js/pipeline.ts`, `tsconfig.pipeline.json`; appended to `core/Cargo.lock`, `tscert/baseline.json`, `knip.json`.

`node pipeline/src/cli.ts` is v1's `midstudy-add` (contract §3.1): the same arguments and help, the same stdout lines
and stderr sentences, exit codes, library entries, cost rows, engines, mock behaviour and refusals, with the
post-processing in Rust (wasm) and glTF-Transform. `MIDSTUDY_ADD=next` selects it in E7, E8, E13 and E17.

## What exists

**Rust (wasm32, Node target)**

- `core/crates/splat` (`midstudy-splat`): the PLY reader and writer v1's `splat.py` reads (binary little/big endian,
  the property types, nx/ny/nz dropped, f_rest_* dropped after a rotation or a stretch), the per-axis fit
  (Σ' = A Σ Aᵀ with A = diag(scale)·R, a cyclic Jacobi 3 × 3 eigensolver, eigenvalues ascending as `eigh`, det +1,
  w ≥ 0 quaternions, v1's 1e-14 variance floor), numpy's linear percentiles bit for bit (`select_nth`, `_lerp`), the
  written file's self-check extents, and SPZ v2 (header, 24-bit positions, alpha, colour, scales, rotations; above
  262,144 splats the ones that cover the least are dropped: opacity × the area of their two largest axes) with its
  read-back check.
- `core/crates/imaging` (`midstudy-imaging`): what v1 did with Pillow 13.0.0 + libjpeg-turbo 3.2.0, pixel for pixel:
  a baseline/progressive/restart JPEG decoder (islow IDCT, fancy upsampling, libjpeg-turbo's colour tables, CMYK and
  Adobe), PNG (png 0.18: 1/L/LA/P/tRNS/RGB/RGBA/I;16, ICC) and WebP (image-webp) decoding, EXIF/XMP orientation,
  Pillow's conversions, Pillow 13's Lanczos resampler (`Resample.c`: coefficients, 22-bit fixed point, and its pass
  order: vertical first when the height shrinks by more than twice the width), `ImageOps.fit`, `thumbnail` sizes, a
  libjpeg-turbo-exact JPEG encoder (q88/q90/q92, 4:2:0, JFIF 1.01, ICC in APP2), and v1's rug texture (margin crop,
  quarter turn, ≤ 2,048 px, edge colour) and SAM 3D mask.
- `core/crates/wasm-pipeline` (wasm-bindgen 0.2.121): `splat_normalize`, `spz_encode`, `spz_check`, `image_probe`,
  `image_engine_input`, `pixels_engine_input` (decoded HEIC pixels), `image_thumb`, `image_rug`, `image_mask`. Every
  call returns an envelope (`00` + payload, or `01` + offset + code + detail); nothing panics across.
- `core/js/pipeline.ts`: the typed face (strict, no `any`, no casts), loaded lazily.

**TypeScript (`pipeline/src`, run by Node 22's type stripping)**

- `cli.ts` (v1's `run`/`add`/`rescale`/`main`), `fal.ts` (the engines; `MockFal`; `LiveFal` speaking fal-client
  1.0.3's protocol: the CDN v3 token kept until it expires, the CDN upload with the storage upload as fallback, the
  queue submit, status polls with logs every 0.1 s, the result, its retries and backup domains), `glb.ts` (glTF-Transform
  4.5.1: .glb/.gltf read with v1's refusals, external files packed, the two wrapper nodes, trimesh's bounds, the stand-in
  box written byte for byte as v1's), `splat.ts`, `images.ts` (HEIC through libheif-js), `objzip.ts` (the zip read as
  Python's zipfile reads it, the media kernels' zip policy, fflate, obj2gltf), `rug.ts` (glTF-Transform,
  KHR_materials_unlit top), `library.ts` (Python's json.dumps and csv rows, atomic writes, strict-mode schema checks),
  `lock.ts` (the v2 lock), `io.ts` (synchronous, ordered stdout/stderr), `errors.ts`, `fsx.ts`, `pytext.ts`.
- `logic/` (pure, TScert): `pyjson` (json.loads/dumps with ints, floats, key order and the C scanner's messages),
  `pyformat` (`%.Nf`, `:%`, `:g`, `round`, `:,`, `strip`, `repr`, csv), `args` (argparse, prefixes and messages),
  `inputs`, `frames`, `fit`, `entry`, `pypath`, `lock`.

**Tests and tools**

- `pipeline/test/logic.test.ts` (11 tests; expected values printed by Python 3.12 and v1's own functions),
  `lock.test.ts` (6: mutual exclusion across six processes, dead-owner and hour-old reclaim, waiting, release rules,
  Ctrl-C and SIGTERM on a running CLI), `fal.test.ts` (7: LiveFal against a scripted fetch, MockFal's log, the key).
- `pipeline/test/compare_v1.py` + `v1_mock_log.py`: v1 and v2 on the same 77 cases (below).
- `core/crates/imaging/tests/diff_pillow.py` + `examples/difftool.rs`: the imaging crate against v1's own functions.
- cargo-fuzz: `core/crates/splat/fuzz` (`ply_fit`, `spz_roundtrip`), `core/crates/imaging/fuzz` (`decode`,
  `picture_ops`), each asserting invariants.

## Commands

```sh
nix develop -c npm run build                                   # build/wasm/pipeline (and the rest)
nix develop -c node pipeline/src/cli.ts --help
env -u FAL_KEY nix develop -c node --test pipeline/test/logic.test.ts pipeline/test/lock.test.ts pipeline/test/fal.test.ts
nix develop -c uv run -q --offline --project pipeline python pipeline/test/compare_v1.py   # → evals/out/pipeline-compare/
(cd core && nix develop .. -c cargo build --release --example difftool -p midstudy-imaging)
nix develop -c uv run -q --offline --project pipeline python core/crates/imaging/tests/diff_pillow.py --seed 2
MIDSTUDY_ADD=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:pipeline         # E8
MIDSTUDY_ADD=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:library          # E7, legacy server
MIDSTUDY_ADD=next nix develop -c node scripts/eval-lock.mjs -- npm run eval:splat            # E13
W=$(pwd); nix develop -c node scripts/eval-lock.mjs --exclusive -- node evals/perf.mjs --only cli --runs 7 \
  --target v1:$W --target v2:$W:MIDSTUDY_ADD=next                                           # E17 cli, A/B
```

MIDSTUDY_FAL_MOCK_LOG=<file> makes either CLI (v1 through `pipeline/test/v1_mock_log.py`) append one JSON line per
upload (`file`, `content_type`, `bytes`, `sha256`, `url`), call (`endpoint`, `url`, `arguments`) and fetch.

## Evals (2026-11-06, all through `scripts/eval-lock.mjs`, fal mocked, $0)

| Eval | `MIDSTUDY_ADD=next` | legacy (same worktree) | Notes |
|---|---|---|---|
| E8 eval:pipeline | **72/72** (three runs, the last after the last code change) | 72/72 | includes the next-only cover check (a 400,000-splat shell through a mocked SAM 3D) and validate_library.py (18 items, 0 failing) |
| E7 eval:library (legacy server) | **78/79** | 79/79 | the one failure is `cost rows use their own lock file, next to costs.csv` (`[ -e "$LIB/costs.csv.lock" ]`): v2 appends under `costs.csv.lock.d`, which it removes; see Requests. L8 and v1.1 validate_library.py checks pass; the library: 8 items, 0 failing |
| E13 eval:splat | **51/51** (twice) | — | the library parts (E13.03–E13.11: Idol, SAM 3D and rug adds through the API, entries, validate_library.py, splat.spz served) and the drawing checks; its library: 5 items, 0 failing |

validate_library.py on every library produced: E8's (18/18), E7's (8/8), E13's (5/5), the comparison's two (40/40 each)
and the smoke runs.

## Against v1, file by file (`pipeline/test/compare_v1.py`)

77 cases on the same inputs, v1 through `pipeline/test/v1_mock_log.py`, v2 with `MIDSTUDY_STRICT=1`: the fal
fixtures (Idol, SAM 3D with 0, 1, 2 and 3 "no masks" answers, TRELLIS 2 at 1024), every EXIF orientation, the privacy
fixtures of `evals/lib/metadata.py` (GPS JPEG, trailing JPEG, mid-scan APP1, zero padding, GPS PNG, JFXX, GPS texture
GLB, 12 MP), ICC+XMP+COM, grey, CMYK, 4:4:4, WebP, HEIC, RGBA and palette PNGs with transparency, 16-bit PNG, a
5,200 px photo, SheenChair (7 textures, KHR extensions), a `.gltf` with its buffer beside it, an OBJ zip, three rugs
and a plain picture, four `--rescale`s, a replace, `MIDSTUDY_FAL_MOCK_COST=1`, `--help` and 29 refusals (argparse errors,
`--dims`, ids, USD, model/photo mismatches, URLs under the mock, bad zips, `--library` a file, a missing mock folder).

- **Identical:** the exit codes, every stdout line and every stderr sentence in all 77 cases; the fal request
  log (endpoint, queue URL, arguments, uploaded bytes and their SHA-256, fetches) in 71 of 77, the six others only in
  an uploaded PNG's or a HEIC photo's bytes (below); every library entry (minus `created`), every cost row (minus the
  date). Files: **211 byte for byte** — every source file (40), engine-input.jpg (32 of 33: all but the HEIC's),
  thumb.jpg (34 of 35: all but the HEIC's), rug-texture.jpg (3), raw/request.json and response.json (32 each), the fal
  outputs kept in raw/ (36), and the stand-in model.glb of every Idol item not rescaled.
- **Equivalent (61), each within the contract's tolerances, by kind:**
  - *gltf-writer* (37 model.glb, 3 raw/rug.glb): written by glTF-Transform 4.5.1 (the task's choice) instead of v1's
    JSON edit. Same node paths, vertex and index data, materials once glTF's default values are filled in, images byte
    for byte, extensions; world matrices equal within 8e-16 (source `matrix` nodes become TRS). The JSON differs:
    `asset.generator` is "glTF-Transform v4.5.1" (v1 kept the source's), default values are left out, each texture
    gets an explicit REPEAT sampler, buffers are laid out anew. After a `--rescale` of a rug, the new item frame's
    scale differs from v1's by 2.2e-8 relative (0.03 µm on a 1.6 m rug): v1 measured with trimesh, whose scene graph
    snaps a world transform within 1e-5 of rigid to rigid (`fix_rigid`) and so measured the rug without its first
    frame's 0.99999998 scale; v2 measures it exactly. The fit errors printed and stored are the same.
  - *eigenvector-signs* (7 splat.ply, 7 splat.spz): positions, colours, opacities and the three log-scales are bit for
    bit v1's; the rotations differ because v1's `numpy.linalg.eigh` (LAPACK) and v2's Jacobi solver pick different but
    equivalent eigenvector signs. The Gaussians (covariances) agree to 2e-11 relative at most (1e-15 at p99). In
    splat.spz the 8-bit rotations then quantize different quaternions; held against its own splat.ply, v2's rotation
    error is no worse than v1's (relative covariance error at p99: 0.070–0.113 against 0.108–0.128). splat.spz is
    also gzipped at level 4 (Decisions): its size differs by −0.5 % to +0.01 %, and its gzip header's XFL byte.
  - *png-deflate* (2 engine-input.png, 2 mask.png; 5 upload log lines): pixels, ICC profile and chunks identical; the
    compressed stream differs because v1's Pillow 13 wheel deflates with zlib-ng (`1.3.1.zlib-ng`, level 6
    `deflate_medium`) and v2 with miniz_oxide. Byte identity would need zlib-ng's deflate ported; not done.
  - *heic-decoder* (engine-input.jpg and thumb.jpg of the HEIC photo; 1 upload log line): libheif-js 1.23.5 (the newest
    on npm, pinned in package.json) against pillow-heif 1.8.1's libheif 1.23.6 + libde265 1.1.3: the decoded pixels
    differ by at most 3 levels in 0.3 % of the engine input's pixels (thumbnail: at most 6, 1 %).
  - *obj-converter* (the OBJ zip's model.glb): obj2gltf (the task's choice) instead of trimesh: same bounds, 12
    triangles and 20 vertices, one texture; another vertex layout and material.

Found and fixed through this comparison: Pillow 13 runs its resampler's vertical pass first when the height shrinks by
more than twice the width (portrait thumbnails, tall photos); v2 now does the same (the differential test gained
portrait and tall cases, `diff_pillow.py --seed 2`: 680/680 identical). glTF-Transform's writer drops any translation,
rotation or scale within 1e-5 of the identity (a rug's 0.99999998 item-frame scale); v2 writes every node's transform
as computed.

## Performance (E17 `cli`, wall time incl. start-up, A/B interleaved, `--exclusive`, 7 runs + 1 warm-up)

| metric | v1 (uv run, Python) | v2 before | v2 now | now / v1 |
|---|---|---|---|---|
| add_cli_idol (262k splats) | 873.5 ms | 637.3 ms | **449.1 ms** | 0.51 |
| add_cli_sam3d | 422.4 ms | 312.4 ms | **255.1 ms** | 0.60 |
| add_cli_glb (SheenChair) | 180.2 ms | 137.3 ms | **135.8 ms** | 0.75 |
| add_cli_rug | 196 ms | 140.2 ms | **135.6 ms** | 0.69 |

("v2 before": the first measurement, with v1's gzip level 9 and the read-back; load 4.1–7.2 during both runs; v1's
baseline file, evals/perf/baseline.json, has 852/413/175/191 ms.) Start-up alone: `--help` takes 160 ms in v1 (uv,
Python, numpy) and 80 ms in v2 (Node, type stripping, the module graph: ~50 ms of it is ESM loading). Where v2's
Idol add goes (one run, loaded machine): engine input 16 ms, the splat fit 234 ms (PLY parse, 262,144 Jacobi
solves, PLY write, both extents), SPZ encode 49 ms, gzip 109 ms (level 9 took 302 ms), the SPZ check 31 ms,
thumbnail 14 ms. v1 spent 243 ms in `zlib.compress` and ~340 ms in `eigh`, `det`, the covariance transform and
`matrix_to_quat` (f-perf). The glb and rug adds are mostly start-up: the post-processing itself is ~40 ms (glb:
wasm 18 ms, glTF-Transform 17 ms).

## Decisions

- **splat.spz gzip level 4**, not v1's 9: on the Idol fixture 109 ms instead of 302 ms for 0.63 % more bytes
  (3,118,822 against 3,099,316; level 1: 72 ms, +3.8 %). The contract names no level; the file stays well under
  6 MB. The SPZ check runs on the payload before gzip instead of reading the file back and gunzipping it (v1), the
  same check without 38 ms of I/O.
- **The library lock** (task spec): `mkdir <library>/.lock.d` + `owner.json` {pid, host, cmd, started}; waiters poll
  every 50 ms and say "waiting for another library write to finish (<library>/.lock)" once, as v1 did; a lock is
  stale when its owner's pid is dead on this host or it is older than 3,600 s; a reclaimer renames it aside (one
  winner), checks it moved the lock it judged (else puts it back) and removes it; release removes only its own lock.
  costs.csv appends take `<costs file>.lock.d` the same way. Lives in `pipeline/src/lock.ts` + `logic/lock.ts` until
  integration moves it to `common/`. Known window: if a third writer creates a new lock in the microseconds between a
  reclaimer's rename aside and its put-back, two can hold it; it needs a stale lock and three concurrent writers.
- **Interrupts:** Node sees a signal only when its event loop turns, and the steps run synchronously (the kernels; a
  mocked fal answers at once), so `cli.ts` yields between steps (`tick()`). Ctrl-C then releases the locks, removes
  the staging folder, prints "midstudy-add: interrupted" and exits 130 (v1's KeyboardInterrupt); SIGTERM cleans up and
  re-raises itself, so the parent sees death by SIGTERM as with v1 (whose flock went with the process).
- **Output** is written synchronously (`fs.writeSync`, EAGAIN waited out): lines reach a reader that merges stdout and
  stderr in the order they were written, as v1's flushed prints did.
- **The fal key** is returned by `loadFalKey` and handed to `LiveFal`; v2 never writes `FAL_KEY` into its environment
  (v1 set `os.environ["FAL_KEY"]` in-process; nothing observable depends on it). The live client follows fal-client
  1.0.3 where the earlier draft did not: the CDN token is cached until `expires_at`, a failed token request fails
  the upload (fal-client builds its CDN client before the fallback chain) with httpx's message, and only a failed
  CDN upload falls back to the storage upload. The token request carries no fal-client User-Agent, as in fal-client
  (it is a plain httpx request); v2 sends Node's default User-Agent there instead of httpx's.
- **Not ported:** Pillow's `reducing_gap=2.0` pre-reduction in `thumbnail`, which only acts on an engine input of
  16,384 px or more on its long side: v2 resamples such a picture directly (still Lanczos, slightly different pixels).
  And argparse's terminal width: v1's `--help` wraps to the terminal's width (or `$COLUMNS`) − 2; v2 prints the help
  as argparse lays it out without a terminal (80 columns), which is what every pipe, eval and the server get.
- **Errors v1 raised from Python internals** keep Python's names: OSError subclasses with `[Errno N] …: '<path>'`
  (macOS errno texts), `rmtree` refusing a file or a symbolic link at the item's folder, `AttributeError` /
  `TypeError` / `ValueError` for malformed library entries in `--rescale`.

**Where v1 and the contract disagree** (v1 kept): none found beyond the lock file names: the contract (§3.4) says
every write takes `<library>/.lock`; v1 used `flock` on that file; v2 uses `<library>/.lock.d` (this task's
protocol) and says `(<library>/.lock)` in its waiting line, as v1 did.

## Requests

1. **evals** (E7): `cost rows use their own lock file, next to costs.csv` checks that `costs.csv.lock` exists; v2's
   CLI uses `costs.csv.lock.d` and removes it, so this check fails with `MIDSTUDY_ADD=next` by design. Suggest
   checking the v2 protocol instead (no `costs.csv.lock.d` left behind after the adds, or either name).
2. **server-core / integration:** until the server takes the same `.lock.d` locks, the legacy `serve.py` (flock on
   `<library>/.lock` and `costs.csv.lock`) and the v2 CLI do not exclude each other: a delete, restore or rename by the
   server, or a render's cost row, can interleave with a CLI add. Move `pipeline/src/lock.ts` and `logic/lock.ts` to
   `common/` and use them in the server for every library write and costs.csv append. `/library/.lock.d/…` must be
   404 like `/library/.lock` (W4).
3. **contract (foundation/integration):** §3.4's "every write takes `<library>/.lock`" → `<library>/.lock.d`
   (+ `owner.json`), costs.csv appends `<costs file>.lock.d`; §3.3 could name `MIDSTUDY_FAL_MOCK_LOG`.
4. **Cargo.lock:** adding png 0.18 and image-webp brought a second miniz_oxide and quick-error into `core/Cargo.lock`,
   so cargo rewrote two existing dependency references to name their versions (`"miniz_oxide"` →
   `"miniz_oxide 0.8.9"` in midstudy-raster, `"quick-error"` → `"quick-error 1.2.3"` in rusty-fork). Everything else
   in the file is added lines.
5. **check:fuzz** now finds four more targets (`core/crates/splat/fuzz`: `ply_fit`, `spz_roundtrip`;
   `core/crates/imaging/fuzz`: `decode`, `picture_ops`): about four more minutes at 60 s each.
6. **kernels-hardening:** if `core/miri.txt` is added, `midstudy-splat` and `midstudy-imaging` can be listed (results
   below); their tests have no proptest blocks.

## What's left

- PNG byte identity with v1 (zlib-ng's `deflate_medium`), and the eigenvector signs of LAPACK: both differences are
  in the encoding, not the content.
- Live fal: the protocol is unit-tested against a scripted fetch only; the first live run (main session) should diff
  its MIDSTUDY_FAL_MOCK_LOG-style record against v1's.
- TScert certifies 110 of the 121 logic functions; `args.isEngine/isMount/store`, `fit.errorsPct/glbFlat/
  glbSelfCheck/splatSelfCheck`, `pyjson.plain/scanObject` are unverified (proof search), `pyformat.pyFloat` and
  `pyjson.scanValue` unsupported (source).

## Rust checks

- `check:rust`: ok — fmt, clippy `-D warnings`, 165 tests in the workspace (31 of them the pipeline crates').
- `diff_pillow.py --seed 2`: 680/680 identical (decode 207, encode 35, engine input 207, thumbnail 207, rug 8, mask
  16; PNG outputs by pixels and ICC).
- cargo-fuzz on the nightly with ASan (as check:fuzz runs them), 60 s each, no crash: `ply_fit` 895,091 runs,
  `spz_roundtrip` 2,380,862, `decode` 2,139,584, `picture_ops` 2,238 (it builds a picture from the input and runs the
  engine input, thumbnail, rug texture and mask on it: slow under ASan).
- Miri (nightly, gate-1's setting: `MIRIFLAGS=-Zmiri-disable-isolation`, the sysroot in `build/miri/`), `cargo miri
  test --lib`, no undefined behaviour: `midstudy-splat` 11 passed (8 s), `midstudy-imaging` 13 passed (20 s). The
  six tests over thousands of splats or pixels are `#[cfg_attr(miri, ignore)]` (the fit's two 9,261-splat grids, the
  263,144-splat SPZ cap, the 800 × 800 rug and mask pictures, the 360 × 480 resample): the first of them was still
  running after 25 minutes.
