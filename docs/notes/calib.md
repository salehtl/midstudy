# Calib track notes

## v2 (calib track of the refactor, branch `v2-calib`, 2026-11-05)

`calib/` stays Python (MoGe-2 on PyTorch) and now is typed, validated and warm. Nothing it writes changed: on the five
golden scenes and the lounge photo, real MoGe-2 on MPS, v1's one-shot, v2's one-shot and the v2 worker give the same
`calib.json` and `lighting.json` (timings aside) and byte-identical `depth.png`.

### What's new

| Path | What |
|---|---|
| `src/midstudy_calib/contract_types.py` | TypedDicts generated from `contract/calib.schema.json`, `contract/lighting.schema.json` and calib's own `schemas/calib-cli.schema.json` by `scripts/gen_contract_types.py` (a small generator for the subset of JSON Schema these use; required keys plain, others `NotRequired`, `Literal` for const/enum). `tests/test_contract_types.py` fails when it or the schema copies drift, and checks each TypedDict's keys against its schema. |
| `src/midstudy_calib/schemas/` | `calib.schema.json`, `lighting.schema.json`: byte copies of `contract/` (written by the generator; the Nix package carries `src/` only). `calib-cli.schema.json`: calib's own, the stdout results of every command (`run`/`fit`, `ingest`, `light`, `align`, the error) and the worker's request. |
| `validate.py` | jsonschema (a runtime dependency now), Draft 2020-12, one registry of the three files. `fit` computes everything first, then checks `calib.json` and `lighting.json` (a mock's too) and only then writes `depth.png`, `lighting.json`, `calib.json`; every result line and worker response is checked too. A mismatch is a bug: exit 1 with `calibration failed unexpectedly (ContractViolation: calib.json doesn't match calib.schema.json: camera/fov_y_deg: …)` and nothing written. |
| `records.py` | the hand-written types: `Model`, `Device`, the diagnostic keys calib adds (`CalibOut.fallback_reason`, `FittedFloor.normal_camera`, `MogeInfo`), `Result`. |
| `worker.py`, `cli.py serve` | the warm worker (contract §4.3 Worker): JSON lines on stdin/stdout, MoGe kept loaded, the one-shot code path per request (`cli.dispatch`), failures answered `ok: false` without stopping, EOF exits 0. `serve --model/--device` are the requests' defaults. The one-shot CLI is unchanged (same arguments, output, exit codes; `serve` is the only addition to `--help`). |
| `moge_runner.py` | the one untyped boundary (MoGe, torch), wrapped once: typed `MogeOutput` arrays out. One network held per process. Builds MoGe without its random init (`_no_weight_init`, then `load_state_dict(strict=True)`), pins the vitl revision (`cb0e8bb…`, the one `nix/moge-weights.nix` fetches; falls back to the Hub's main), and imports MoGe without `scipy.signal` (`import_moge`). |
| `scripts/bench.py` | one-shot vs worker wall time on the golden scenes and the lounge, and `--compare` of two output folders. |
| `scripts/check.sh` | calib's own check: generator `--check`, ruff and pyright `--strict` over `src`, `tests` and `scripts` (v1's `calib_report.py` typed too). f-toolchain's `npm run check:py` (`scripts/check.mjs py`) runs the same pyright and ruff through calib's `[tool.pyright]` and `[tool.ruff]`; checked with its exact invocation: clean. |
| `tests/` | 103 tests (62 in v1): `test_contract_types.py`, `test_worker.py` (protocol, mock parity with the one-shot CLI, failures, no torch under the mock), `test_moge_runner.py` (init skip, one model, pin, the `scipy.signal` stand-in, and the fast build against MoGe's own `from_pretrained` weight for weight when the weights are cached), shared helpers in `synthetic.py` and `cli_run.py`. |

### How to run and check

```sh
nix develop -c uv sync --project calib
nix develop -c bash calib/scripts/check.sh                       # generated files, ruff, pyright --strict: one line each
nix develop -c bash -c 'cd calib && uv run pytest -q'             # 103 tests, ~40 s, vitl weights used when cached
nix develop -c uv run --project calib python calib/scripts/gen_contract_types.py   # after a schema change
printf '%s\n' '{"id":"a","cmd":"fit","args":["/abs/scene"]}' | nix develop -c uv run --project calib midstudy-calib serve
nix develop -c uv run --project calib python calib/scripts/bench.py --mode both --label mine      # real MoGe, $0
nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib -- --mock                          # E2 ingest
nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib                                    # E2 real MoGe
```

### Measurements (M3 Max, MPS, vitl, real MoGe-2; the Mac shared with other agents)

Wall time of `run <photo> --out <dir>`, per photo, as `fastest / median` over 3 interleaved rounds (v1 one-shot, v2
one-shot, v2 worker, alternating), `calib/scripts/bench.py` under `eval-lock --exclusive`, load average 2–9 (the
quietest window of the day). One-shot = `python -m midstudy_calib.cli` per photo (`uv run` adds about 0.02 s); worker =
one `serve` process per round, the first request timed from spawn, the others request to response.

| photo | v1 one-shot | v2 one-shot | worker, first | worker, later |
|---|---|---|---|---|
| living-wide | 10.1 / 10.2 s | 5.4 / 5.6 s | 5.2 / 5.3 s | — |
| steep-roll | 9.8 / 10.0 s | 5.6 / 5.6 s | — | 1.0 / 1.0 s |
| portrait | 9.9 / 10.0 s | 5.6 / 5.7 s | — | 0.9 / 0.9 s |
| living-cool | 9.9 / 10.0 s | 5.4 / 5.6 s | — | 0.9 / 0.9 s |
| living-warm | 10.0 / 10.0 s | 5.4 / 5.5 s | — | 0.9 / 0.9 s |
| lounge (`upper-lounge-camera.jpeg`) | 10.0 / 10.2 s | 5.7 / 5.7 s | — | 1.0 / 1.0 s |
| all | 9.8 / 10.0 s (n=18) | 5.4 / 5.6 s (n=18) | 5.2 / 5.3 s (n=3) | 0.9 / 0.9 s (n=15) |

So a calibration after the first takes **0.9 s instead of 10.0 s (−91 %)** through the worker, and a one-shot run
**5.6 s instead of 10.0 s (−44 %)** (REFACTOR.md §4.1 asked for ≥ 30 % from the second photo on). Earlier rounds with
the Mac at load 10–23 gave the same picture, noisier (v1 11.2 / 13.2 s, v2 6.8 / 11.8 s, worker later 0.9 / 1.6 s).

Where the time goes (medians of the quiet rounds; `moge.load_s`, `moge.infer_s`, `moge.floor_fit_s`, `fit.elapsed_s`):

| | load | infer | floor fit | light fit | rest (start, imports, ingest, PNG, writes) |
|---|---|---|---|---|---|
| v1 one-shot | 4.0 s | 2.0 s | 0.08 s | 0.23 s | 3.7 s |
| v2 one-shot | 0.47 s | 2.8 s | 0.08 s | 0.18 s | 2.1 s |
| worker, later | 0 | 0.61 s | 0.07 s | 0.17 s | 0.07 s |

- **Load** (v1 4.0 s): importing MoGe (most of it `scipy.signal`), asking the Hub whether `main` moved, building
  DINOv2 ViT-L with random weights that are all thrown away, and reading the checkpoint (one by one at load ~13: 1.9,
  0.5, 3.4 and 0.2 s). v2 skips the init, pins the revision and defers `scipy.signal`: 0.47 s.
- **Infer**: the first inference in a process (Metal compiles its kernels) is 2.0 s, later ones 0.6 s. v2's first is
  0.7 s slower because MoGe's focal solver now imports `scipy.optimize` on first use (it came with `scipy.signal`
  before); net, the deferral saves about 0.9 s (measured: import + build + first inference 3.7 vs 4.6 s, fastest of 4).
- **Fit without MoGe** (cached MoGe outputs of the six scenes, `fit` end to end, v1 and v2 processes alternating, 4
  rounds of 3, load 15): fastest 379 ms → 277 ms (−27 %), median 466 → 425 ms. Lighting 0.23 → 0.18 s in the quiet
  rounds above; floor fit unchanged at 0.08 s (left as is: the RANSAC's score sums would need a different summation
  order to be faster, which isn't bit-identical).
- **Same results**: with real MoGe on MPS, v1 one-shot, v2 one-shot and the worker wrote the same `calib.json` and
  `lighting.json` (timings aside) and byte-identical `depth.png` for all six photos in every round. E2's results are
  unchanged (132/132, the same values as in STATUS.md).

Evals on `v2-calib` (2026-11-05): pytest 103/103 (102 + 1 skipped without `fixtures/photos/`); `calib/scripts/check.sh` clean; `eval:calib -- --mock` 58/58; `eval:calib` (real
MoGe-2) 132/132 in 95.7 s (load ~35); `eval:real` 31/31 in 66.6 s (lounge camera FOV 69.63, height 1.432, pitch −7.84,
roll 0.26, as before).

### Decisions

- **The worker reuses the one-shot code path** (`cli.dispatch` per request), so a worker response is the one-shot
  result by construction; the tests compare files and result lines between the two under the mock, and the bench
  compares them with real MoGe.
- **One model held, on the device it last ran on.** A request for another model replaces it (never two ViT-Ls in
  memory); an MPS failure under `auto` retries on the CPU as before and the next request moves the network back.
  `moge.load_s` is the time this request spent loading (0 when warm).
- **Skipping MoGe's random init is safe only because every weight is then loaded**: `strict=True` fails otherwise and
  the slow path (MoGe's own `strict=False`) runs. Measured identical state dicts and outputs, CPU and MPS.
- **The `scipy.signal` stand-in** is in `sys.modules` only while MoGe imports; its `fftconvolve` (unused by inference)
  imports the real module on first call, and dunder lookups don't trigger it. Net gain about 0.9 s per cold start
  (scipy.optimize, which MoGe's focal solver needs, is now imported at the first inference instead).
- **Fit speedups that keep results bit-identical** (checked on the six scenes): sRGB through a lookup table; crease
  pairs tested only where both samples are usable; the weight-free parts of the light's least squares computed once
  for its six robust iterations; each neighbour dot product once; the floor's `nan_to_num` once.
- **Not taken:** a faster PNG level for `depth.png` (zlib 1 saves 15 ms but the file grows 40–100 %, and the phone
  downloads it); float32 or a coarser direction grid in the lighting fit (changes results); `x**4` as two squarings in
  the shades-of-grey mean (not bit-identical).
- **jsonschema at run time**, not only in tests: the task asks for every file and result to be checked before it is
  written; it costs about 1 ms per document.
- **calib-cli.schema.json lives in calib** (contract/ is f-contract's); `id` is an optional property of every result so
  one-shot lines and worker responses share one schema.

### Requests to other tracks

- **packaging** (`nix/midstudy-calib.nix`): add `ps.jsonschema` to the Python env and `midstudy_calib.worker,
  midstudy_calib.validate, midstudy_calib.contract_types, jsonschema` to the import check; `src/midstudy_calib/schemas/*.json`
  must stay in the package (`cp -r src` does it). `nix/module.nix`: add `serve` to the `run | fit` case of the
  calibDevice shim, so `serve --device X` sets the device of every worker request.
- **f-contract**: adopt `calib/src/midstudy_calib/schemas/calib-cli.schema.json` as `contract/calib-cli.schema.json`
  (the server validates calib's output and the worker protocol from it); then calib's copy becomes a generated copy
  (one line in `gen_contract_types.py`'s `SOURCES`). Any change to `contract/calib.schema.json` or
  `lighting.schema.json` needs `gen_contract_types.py` re-run (a test fails until then): **after merging v2-f-contract**
  (it adds `title`s to the `$defs`) the two schema copies in `calib/src/midstudy_calib/schemas/` must be regenerated;
  `contract_types.py` itself comes out the same (checked against v2-f-contract's schemas).
- **server-core / server-routes** (Phase 2): the worker client as contract §4.3 Worker says (start on the first
  calibration, restart after a crash, one-shot fallback, align stays one-shot).
- **f-toolchain**: your `check.mjs py` (`pyright --project calib --pythonpath calib/.venv/bin/python`, `ruff check calib`)
  is clean on this branch; it could also run `uv run --project calib python calib/scripts/gen_contract_types.py --check`
  (pytest covers that too). calib's `[tool.ruff]` selects more rules than the defaults; keep it.
- **integration**: `fixtures/stub_calib.py` has no `serve`; the server's one-shot fallback covers it (the stub exits 2
  at once), or the stub can gain a stdlib `serve` later.
- **whoever makes worktrees**: `fixtures/photos/` is git-ignored, so worktrees don't have it. For E2 real and
  `eval:real` I symlinked the three photos `evals/calib_eval.py` names from the main checkout (read only, never
  `private/`) and removed the links at the end.

### Left

- `requires-python` is still `<3.13` while the Nix package runs 3.13 (HANDOFF R3); the code is 3.12+ (PEP 695 aliases).

## v1 notes

> **Since verify round 2 (see `verify-fix-2.md`):** with an EXIF focal length within 8° of MoGe's FOV, `fit` uses the
> EXIF FOV, keeps MoGe's pitch and roll, multiplies the height by `k = tan(fov_moge/2) / tan(fov_exif/2)` and scales
> `depth.png` to agree with that camera's floor (`fov_source`, `moge.{height_m, scale, depth_scale}` in calib.json).
> On the golden scenes given their true FOV as EXIF: height within 2 %, depth within 5 %, furniture drawn within 3 % of
> its size (was 7–10 % too big). Lounge: FOV 69.63 (EXIF), height 1.432 (MoGe 1.352). Ingest passes a JPEG through only
> with plain 16-byte JFIF APP0s (a JFXX or JFIF thumbnail is re-encoded away). PLAN.md §4.3 and contract §4.3 changed
> with it. The golden scenes themselves (no EXIF) still miss E2's FOV/height/depth tolerances: nothing to correct with.

> **Since verify round 1 (see `verify-fix-1.md`):** ingest's pass-through walks the whole JPEG (between progressive
> scans too) and requires nothing after EOI, so an appended GPS JPEG, mid-scan EXIF or padding are re-encoded (5 new
> pytest cases, 3 new E2 `--mock` checks); the over-25 MB message reads "the photo is 25.1 MB, over the 25 MB limit".
> The verifiers measured MoGe's scale bias in what the user sees (furniture 3–12 % too big on golden, likely 5–25 % on
> the lounge, through the floor the planner uses, not depth.png); the planner now lets the user set the scale from a
> known length (Adjust floor → Ruler → Set scale). Using the EXIF FOV is left to the plan owner.

> **Since integration (see `integrate.md`):** the integration agent kept E2's PLAN.md tolerances and the golden scenes
> as they are, so E2 real is 53/60 (the 7 golden misses below, plus 3 new scale-free depth checks that pass at
> 0.7–1.1 %). The depth masking described here (max(4 cm, 1.2 % of depth), below-floor zeroing, unmasked without a
> floor) is now in contract §4.2/§4.3. The real path (`npm run eval:real`) runs this CLI through `serve.py` on the
> lounge photos and a HEIC of one; all calibrate with the floor found and agree within 0.5° and 4 mm.

What the calib track built in `calib/` (`midstudy-calib`, contract §4.3), how to run it, what it measured, and what's left.
Measured on 2026-11-04 on the M3 Max (MPS), MoGe-2 ViT-L.

## Summary

- `midstudy-calib run | ingest | fit | align` works end to end with the contract's stdout/stderr/exit rules, the
  `MIDSTUDY_CALIB_MOCK` mode, the fallbacks and device selection. 32 unit tests pass; `evals/calib_eval.py` passes
  27/27 (`--self-test`), 47/47 (`--mock`), and **50/57 with the real model**.
- **Pitch and roll are right everywhere**, signs included: within 0.7° and 0.2° of truth on all three golden scenes.
- **MoGe does badly on the synthetic golden scenes for FOV and metric scale, and well on the real photo.** On the
  golden renders it overestimates the vertical FOV by 3.6–7.5° and underestimates scale by 8–19%. The scale error
  tracks the focal error almost exactly (ratios 1.18/1.12/1.08 against 1.17/1.11/1.07), and the depth *shape* is
  right: the median depth error after one global scale is 0.7–1.1%. All 7 failing E2 checks come from this:
  living-wide FOV, height and depth; portrait FOV, height and depth; steep-roll depth (10.3% against the 10% limit).
  On the real lounge photo the FOV is 3.1° from the EXIF estimate, and the measured sizes are plausible (see below).
  I did not edit `fixtures/` or the eval. The integration agent decides whether the golden FOV, height and depth
  tolerances should change, for example by comparing depth after a global scale.

## What's in `calib/`

| Path | What |
|---|---|
| `pyproject.toml`, `uv.lock` | uv project, Python 3.12. Deps: numpy, pillow, pillow-heif, opencv-python-headless, torch (2.15.0 locked), huggingface-hub, and `moge @ git+https://github.com/microsoft/MoGe@07444410f1e33f402353b99d6ccd26bd31e469e8`. Dev deps: pytest, jsonschema. |
| `src/midstudy_calib/cli.py` | argparse CLI and the output contract. During the work, fd 1 is pointed at stderr, so nothing torch or a C library prints can reach stdout. The final JSON is the only stdout line. A failure exits 1 with `{"ok": false, "error"}` and `midstudy-calib: <sentence>` as the last stderr line. |
| `src/midstudy_calib/ingest.py` | Sniffs the type, applies the guards, orients, converts to sRGB, downsizes, writes `photo.jpg` with no metadata, passes clean JPEGs through byte for byte, reads EXIF and computes the EXIF FOV. |
| `src/midstudy_calib/fit.py` | The mock, the MoGe path, the fallbacks, and writing `calib.json` and `depth.png`. |
| `src/midstudy_calib/floor.py` | numpy only: the RANSAC floor plane, frame conversion, camera from plane, and depth masking. |
| `src/midstudy_calib/moge_runner.py` | Device pick, model load (on CPU, then moved) and inference. |
| `src/midstudy_calib/align.py` | Keep-room registration and composite. |
| `tests/` | `test_floor.py` (conventions against golden truth, steep and through-glass cases), `test_ingest.py`, `test_cli.py` (contract, mock, fallbacks, schema), `test_align.py`. |
| `scripts/calib_report.py` | The measurement and overlay script behind the numbers below. |

### Pins and checkpoints

- **MoGe commit `07444410f1e33f402353b99d6ccd26bd31e469e8`** (v2.0.0, 2025-11-02), the last code commit before
  upstream HEAD `74fbce0` ("V3", 2026-08-19). V3 is MoGe-3: it needs CUDA-only `flex-gemm` and Gradio 6, and its uv
  config only allows Linux and Windows. MoGe-2's own extra dependencies are dropped with
  `[tool.uv] exclude-dependencies = ["gradio", "opencv-python", "pipeline"]`. The inference path needs none of them,
  and `opencv-python` would clash with `opencv-python-headless`. `utils3d` stays pinned by MoGe to `3fab839f…`.
- **Hugging Face checkpoints, checked on 2026-11-04** (`/api/models?author=Ruicheng`): `moge-2-vitl-normal`,
  `moge-2-vitb-normal`, `moge-2-vits-normal`, `moge-2-vitl` (no normals), the `-onnx` variants, `moge-vitl` (v1), and
  `moge-3-vitl` / `moge-3-vitg` (need the V3 code). `--model vitl|vitb|vits` maps to
  `Ruicheng/moge-2-{size}-normal`. **The default is `vitl`** (`Ruicheng/moge-2-vitl-normal`), the one whose sizes
  are plausible on the real photo (see "Model size" below).
- Weights go to the Hugging Face cache (`~/.cache/huggingface/hub`, or `HF_HOME`), never into the repo.
  **The first download of vitl-normal (1.32 GB) took 20.8 s.** Loading from cache takes 3.9 s.

## How to run

```sh
nix develop -c uv sync --project calib                          # once (about 2.5 min the first time, 944 MB .venv)
nix develop -c uv run --project calib midstudy-calib run <photo> --out <scene-dir>
nix develop -c uv run --project calib midstudy-calib fit <scene-dir> [--model vitb] [--device cpu] [--no-depth]
nix develop -c uv run --project calib midstudy-calib align <photo.jpg> <raw.jpg> <mask.png> --out <final.jpg>
MIDSTUDY_CALIB_MOCK=fixtures/calib nix develop -c uv run --project calib midstudy-calib run fixtures/scenes/living-wide/photo.jpg --out /tmp/x
nix develop -c bash -c 'cd calib && uv run pytest -q'          # 32 tests, about 12 s, no weights needed
nix develop -c uv run --project calib python calib/scripts/calib_report.py   # golden + real photos -> evals/out/calib/report/, overlays/
nix develop -c evals/py evals/calib_eval.py [--mock | --self-test]          # the evals track's E2
```

The server's default `--calib "uv run --project calib midstudy-calib"` works from the repo root. Each call loads
the model again (about 4 s). A first calibration on a fresh machine also downloads 1.3 GB.

## Behaviour details (beyond or pinning the contract)

- **Frames.** MoGe returns points and normals in the OpenCV camera frame (x right, y down, z forward, z = view-axis
  depth). I checked this against the golden floors: the median MoGe normal on floor pixels matches
  `diag(1,−1,−1)·Rᵀ·ŷ`. With `n` the floor's unit normal pointing up and converted to three.js camera axes
  (`n3 = (n.x, −n.y, −n.z)`), the code uses `pitch = asin(−n3.z)`, `roll = atan2(n3.x, n3.y)` and `height = d` for the
  plane `n·p + d = 0`. This follows from `R = Rx(pitch)·Rz(roll)`, where world up seen from the camera is
  `(cos p sin r, cos p cos r, −sin p)`.
  **Signs were verified on the golden scenes, not only by reasoning.** MoGe gives steep-roll (truth +2°) +1.96°,
  portrait (truth −1°) −1.19°, and all pitches negative within 0.7°. In `test_floor.py`, exact point maps built
  from truth.json and depth.png return the truth cameras within 0.1° and 5 mm, and project truth.json's open-floor
  points within 1 px.
- **FOV** = `2·atan(0.5 / fy)`, with MoGe's normalized `fy` (units of image height). `principal` is MoGe's `(cx, cy)`,
  which MoGe-2 always reports as `[0.5, 0.5]`.
- **Floor RANSAC** (`floor.fit_floor`):
  - Candidates are pixels whose MoGe normal has `n·(−ŷ_cv) > 0.15`. Any floor passes this for pitch ≥ −80° and
    |roll| ≤ 20°. Ceilings and walls facing a downward-looking camera fail it.
  - Hypotheses use 3 points. A hypothesis is kept when the camera is 0.15–3.5 m above the plane, on its up side.
  - A pixel is an inlier when it is within `max(4 cm, 1.2% of its depth)` of the plane and its own normal is within
    30° of the plane's.
  - Each inlier is weighted by `0.2 + (row/h)²`, so the bottom of the image counts about 6× as much as the top. This
    is how the room's floor beats a lower floor seen through glass (`test_lower_floor_through_glass_loses`).
  - The winner is refined three times by least squares. `inlier_ratio` is inliers / all pixels at the depth size.
  - Under 2% inliers means `floor.found: false`.
- **depth.png** is MoGe's z in mm at photo.jpg's aspect, long side 1024. MoGe runs on that downsized image, about
  1.8–2.4 s on MPS.
  - 0 where MoGe's mask says invalid, or the depth is over 65.535 m.
  - 0 on the floor within `max(4 cm, 1.2% of depth)`. The contract says 4 cm; far away MoGe is noisier.
  - 0 **below** the floor plane (reflections, the void behind the glass balustrade). The floor is always nearer
    along those rays, so they could never hide anything standing on it.
  - On golden: 0.1–0.5% of true non-floor pixels are zeroed, 0.3–0.7% of true floor pixels are left non-zero, and
    all `floor_points` are 0.
- **Fallbacks:**
  - No floor (or under 2% inliers): `source: "moge-2"`, `floor.found: false`, MoGe's FOV, height 1.40, pitch −10,
    roll 0. depth.png is still written, with `floor_masked: false`.
  - Model load failure (offline with no cached weights, missing package): `exif` (FOV from EXIF) or `default`
    (FOV 55), `depth: null`, `fallback_reason` in calib.json. Exit 0 in both cases.
  - An inference failure on mps/cuda under `--device auto` retries on the CPU before falling back.
- **Device:** `auto` picks cuda, then mps, then cpu. `PYTORCH_ENABLE_MPS_FALLBACK=1` is set before torch is
  imported. An explicit device that isn't available uses cpu, with a log line. fp16 autocast runs on cuda and mps,
  not on cpu.
- **Mock:** looks up `<dir>/<sha256 photo.jpg>/`, then `<dir>/<sha256 source.*>/`. On a miss it writes the `default`
  fallback, with the EXIF block when there is one. It never imports torch.
- **Ingest guards:**
  - Size: 25 MB, checked before reading.
  - Type: sniffed from the bytes. JPEG, PNG, WebP, and HEIC/HEIF (ftyp brands `heic heix hevc hevx heim heis hevm
    hevs`, or `mif1/msf1/mif2/miaf` unless the file is AVIF-only). AVIF and everything else are refused with
    "that file isn't a JPEG, PNG, HEIC or WebP image".
  - Pixels: `Image.MAX_IMAGE_PIXELS = 100 MP`, with the bomb warning raised as an error. Over 100 MP is refused
    with a sentence before decoding.
  - Truncated or corrupt files are refused.
  - Nothing is written for a refused upload.
- **Ingest conversion:**
  - EXIF orientation is applied (pillow-heif already applies HEIF rotation and resets the tag, so the HEIC and JPEG
    paths agree).
  - The ICC profile is converted to sRGB with the perceptual intent (Display P3 → sRGB checked).
  - Alpha is flattened onto white. 16-bit grey is scaled.
  - Large JPEGs are decoded with `draft()` first, then resized with Lanczos to a 2048 px long side.
  - The output is JPEG q92 with `info` cleared, because Pillow would otherwise carry a JPEG comment over. The output
    is checked to contain only APP0.
  - **Pass-through:** a JPEG with only JFIF/APP0, no APP1–15 or COM, nothing after EOI, long side ≤ 2048 and RGB is
    copied byte for byte. A clean greyscale JPEG is re-encoded as RGB.
- **calib.json extras** (allowed by the schema): `moge {fov_x_deg, fov_y_deg, input, load_s, infer_s, floor_fit_s}`,
  `floor.normal_camera` (the floor normal in three.js camera axes), and `fallback_reason` on fallbacks.
  `fov_disagreement` appears when MoGe and EXIF differ by more than 8°. Every camera block is clamped to the
  contract ranges and logged when clamped.
- **align** (contract §4.3, §4.7):
  1. Resizes the output to the photo's size.
  2. Finds SIFT features outside the mask (eroded 9 px), working at a 1600 px long side.
  3. Uses a ratio test, then MAGSAC homography (2.5 px), then an ECC homography refinement that is kept only when it
     agrees with the features.
  4. Warps, then composites `photo·(1−α) + warped·α`, with α = the mask blurred by σ = 0.4% of the width and zero
     where the warp has no content.
  - It refuses with `applied: false`, `reason` and no output file when there are fewer than 40 inliers, the median
    residual is over 3 px, or a corner moves by more than 10% of the width.
  - Measured on synthetic nano-banana-like pairs (scaled to 1344 × 768, shifted by 2% / −1.5% and 1%): living-wide
    has about 700 inliers, residual 0.08–0.10 px and a homography error ≤ 0.05 px. The lounge photo has about 2,300
    inliers, residual 0.13–0.22 px and an error ≤ 0.42 px. The identity applies, and an unrelated image is refused.
    It takes 0.2–0.3 s.

## Measurements

### Golden scenes (vitl, MPS): fitted vs truth.json

| scene | fov (truth) | height (truth) | pitch (truth) | roll (truth) | depth median err | after one global scale | floor inliers | runtime |
|---|---|---|---|---|---|---|---|---|
| living-wide | 62.46 (55) **+7.46** | 1.185 (1.40) **−15.4%** | −9.32 (−10) +0.68 | −0.05 (0) | **19.2%** | 0.7% | 0.279 | 10.0 s |
| steep-roll | 68.60 (65) +3.60 | 1.476 (1.60) −7.8% | −25.54 (−25) −0.54 | +1.96 (+2) | **10.3%** | 0.7% | 0.483 | 9.9 s |
| portrait | 75.85 (70) **+5.85** | 1.114 (1.25) **−10.9%** | −7.95 (−8) +0.05 | −1.19 (−1) | **16.5%** | 1.1% | 0.325 | 9.9 s |

Bold values fail E2 (fov 5°, height 10%, depth 10%). The scale needed to match truth is 1.24, 1.12 and 1.20.
Floor rmse is 0.5–0.6 cm.

### Real photos (fixtures/photos/, vitl, MPS)

| photo | photo.jpg | fov_y | height | pitch | roll | floor found / inliers / rmse | EXIF fov_y | device | runtime (wall, elapsed_s) |
|---|---|---|---|---|---|---|---|---|---|
| upper-lounge-camera.jpeg (P3, EXIF, 5712 × 3213) | 2048 × 1152 | 72.75 | 1.352 | −7.84 | +0.26 | yes / 0.251 / 0.9 cm | 69.63 (14 mm) | mps | 10.4 s, 9.45 s |
| upper-lounge.jpg (no EXIF) | 2000 × 1125 | 73.06 | 1.356 | −7.92 | +0.28 | yes / 0.251 / 0.8 cm | — | mps | 10.4 s, 9.72 s |
| upper-lounge-empty-ai.png (AI) | 1671 × 941 | 66.31 | 1.334 | −7.62 | −0.14 | yes / 0.304 / 0.6 cm | — | mps | 10.4 s, 9.74 s |

- **CPU only** (`--device cpu`, upper-lounge.jpg): MoGe inference takes 4.5 s against about 2 s on MPS, and the run
  takes 12.7 s wall. The result matches MPS within 1 mm and 0.01°.
- **Runtime breakdown on MPS:** about 3 s Python and torch imports, 3.9 s model load, 1.8–2.4 s inference, 0.06 s
  floor fit.
- **Sanity on the lounge** (camera original): points from depth.png and the fitted camera, as heights above the
  floor.
  - Coffee table top: 37–39 cm (notes say 35–40).
  - Sofa seat: 45 cm (about 45).
  - Wall at the top of the back doorway: 2.16–2.25 m (2.1–2.4).
  - The rug's near-right corner, mapped photo → floor with the fitted camera, is **89.8°**, so FOV, pitch and roll
    agree with each other.
  - The camera original and the metadata-free copy agree within 0.3° and 4 mm. The AI version gives the same camera
    within 1.8 cm and 0.3°, with a 6.4° narrower FOV (its framing differs).
- **EXIF FOV passed to MoGe** (an experiment; not what the code does, because the contract says MoGe's FOV wins):
  height 1.394 and door 2.02 m, against 1.352 and 2.16 m. Both are plausible, so neither is clearly better.

### Model size (all three on all photos)

| | living-wide fov/h | steep-roll fov/h | portrait fov/h | lounge fov (EXIF 69.6) | lounge h (orig/copy/AI) | lounge door top | lounge sofa seat |
|---|---|---|---|---|---|---|---|
| vitl (default) | +7.5 / −15% | +3.6 / −8% | +5.9 / −11% | 72.8 | 1.352 / 1.356 / 1.334 | 2.16–2.25 m | 45 cm |
| vitb | +5.6 / −18% | −2.4 / −9% | +1.8 / −10% | 70.9 | 1.262 / 1.264 / 1.446 | 2.25–2.34 m | 45 cm |
| vits | +3.7 / −9% | −4.5 / −17% | −2.1 / +5% | 65.9 | 1.330 / 1.341 / 1.460 | 1.88–1.95 m (too low) | 33 cm (too low) |

None passes every golden check. vitl is the most consistent on the real room, so it stays the default. Changing
`num_tokens` (1200–3600) or flipping the image moves the FOV by 1° at most.

### Overlays (looked at each one)

These are in `evals/out/calib/overlays/` (git-ignored). `*-grid.jpg` is the 50 cm floor grid out to 8 m from the
fitted camera in cyan, plus the true camera in magenta on golden scenes. `*-depth.jpg` shows depth.png, with zeros
(masked floor) in green. `-vitb` / `-vits` variants exist too.

- **golden-living-wide:** the cyan grid lies on the floor. Near the bottom it nearly coincides with the truth grid.
  Further away it pulls apart because of the FOV and scale error: the fitted horizon is lower, and cells are larger
  in metres per pixel.
- **golden-steep-roll:** on the floor, close to truth across the rug. The same far-field divergence, smaller.
- **golden-portrait:** on the floor, close near the camera, diverging toward the back wall.
- **real-upper-lounge-camera:** **the grid sits on the floor.**
  - Its transverse lines are parallel to the rug's near edge.
  - The receding lines run parallel to the stone curb and the rug's right edge, and converge with the corridor.
  - The depth overlay masks the whole rug and marble floor, including the far corridor floor. The curb, the glass
    balustrade, the sofa, the table, the stool and the bag are not masked.
  - The grid continues over the void beyond the glass, as the y = 0 plane should.
- **real-upper-lounge** (no EXIF): the same as the camera original. The grid sits on the floor.
- **real-upper-lounge-empty-ai:** the grid sits on the polished floor and follows the corridor and the curb.

## Privacy

- I never opened, listed or read `fixtures/photos/private/`. That is where the user's
  `AD9729E1-593E-4443-9BCD-B0519A7265F1_1_201_a` original with location data presumably is; I didn't look for it
  anywhere else either.
- Nothing from `fixtures/photos/` is copied anywhere tracked. Real-photo outputs live only under `evals/out/calib/`,
  and `calib_report.py` deletes their `source.*` after each run.
- `fixtures/photos-public/` was **not created**: `fixtures/photos/` has photos, so no download was needed.

## Left for others / known gaps

- **Golden FOV, scale and depth tolerances:** E2 fails 7 of 57 checks with the real model, all from MoGe's FOV and
  scale bias on the CG renders. The integration agent decides. Options:
  - Keep the checks and accept the misses as known.
  - Loosen FOV and height for golden scenes only.
  - Compare depth after a global scale (0.7–1.1% here).
  - Keep golden scenes for convention and signs (pitch, roll, masking), and judge FOV and scale on real photos
    against EXIF and known sizes.
- Each `fit` reloads the model (about 4 s). A persistent worker would cut that, but the server's job model is one
  process per scene.
- Depth edges are MoGe's bilinear upsampling, so occlusion can halo by a few pixels at object borders (PLAN §11). I
  didn't add an edge cleanup.
- Only one real room (three versions of it) was measured. Portrait, steep and rug-heavy real photos are untested
  beyond the synthetic floor tests.
- The Hugging Face cache also holds `moge-2-vitb-normal` (400 MB), `moge-2-vits-normal` (134 MB) and `moge-2-vitl`
  (1.2 GB, no normals), downloaded only for the comparison above. The last one can be deleted.
- Packaging (PLAN §9): `calib/uv.lock` locks macOS-friendly torch from PyPI. For CUDA on homeserver, the packager needs
  `torch-bin`. `utils3d` and `moge` are git dependencies (pinned commits above).

## State machines W1: calib-moge-device

- `moge_runner.infer`: `Loaded.device` is now `str | None`; it is set to None before `net.to(device)` and to the
  device after the move returns. A move that raises midway (an MPS out-of-memory can leave layers on both devices)
  so leaves the device unknown, and `fit._infer`'s cpu retry moves the whole network instead of skipping the move
  because the field still said `cpu`. No failed-device memory for `pick_device`: one transient MPS fault would pin
  a warm worker to cpu for its whole life.
- `_checkpoint` returns `(path, revision)`: the pinned sha, or `"main"` when the pinned one couldn't be had.
  `Loaded.revision` (required) and `MogeOutput.revision` (default `"main"`, so `fit.py` and the tests' fakes build
  unchanged) carry it. Writing it to `calib.json` (`records.MogeInfo.revision`, `fit._moge`) is calib-scene-files'
  part of the same fix; this package doesn't touch `fit.py` or `records.py`.
- Tests: `test_failed_move_forces_a_full_move_on_retry`, `test_pinned_revision_is_recorded`, and
  `test_one_model_at_a_time` / `test_pinned_revision_then_main` updated for the tuple.
