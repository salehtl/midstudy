# cutover (v2 Phase 3): v2 becomes the codebase

The cutover agent of Phase 3, on `v2` itself (worktree `.claude/worktrees/rf-main`), from `ceb8f0e` (v2 after
proofs-final). The plan is docs/REFACTOR.md; what the two integration halves built is docs/notes/int-backend.md and
docs/notes/int-planner.md (and the tracks' notes they merged). Everything below was run on rabbit on 2026-11-06, fal
mocked (`MIDSTUDY_FAL_MOCK=fixtures/fal`, `MIDSTUDY_NO_DOTENV=1`, no `FAL_KEY` anywhere, never `.env`), headless Chrome
from `$PUPPETEER_EXECUTABLE_PATH` only (never Helium), every eval through `scripts/eval-lock.mjs`. The three photos
`evals/calib_eval.py` names were symlinked into `fixtures/photos/` from the main checkout for the real `eval:calib`
and `eval:real` only, and removed afterwards; `fixtures/photos/private/` was never opened. Nothing was pushed.

## 1. What merged

`git merge --no-ff` onto `v2` at `ceb8f0e`:

| # | Branch | Tip | Merge | Conflicts |
|---|---|---|---|---|
| 1 | `v2-int-backend` | `d5af7a5` | `a7e65b2` | none (v2 had moved only in `proofs/` and `docs/notes/proofs-final.md`) |
| 2 | `v2-int-planner` | `60dba50` | `72719f6` | `package.json` (the backend's five `test:*` and the planner's `test:engine`, `test:ui`: unioned), `scripts/check.mjs` (`ORDER`: both new checks, `tests` and `planner`), `tscert/baseline.json` (384 + 320, disjoint: 704, sorted as `--update` writes it) |

`v2-proofs` (`99d3884`) and `v2-proofs-final` (`d868045`) had nothing beyond `v2` (0 commits ahead): not merged.
`v2-webgpu` is Phase 4's and was not touched. **Lockfiles:** `package-lock.json` and `core/Cargo.lock` came from one
side each (the planner half changed neither): `npm ci` installed from it, `npm install --package-lock-only` left it
byte for byte, `cargo metadata --locked` accepted `core/Cargo.lock` (the build and every cargo step run `--locked`).

One merge fix: `check:tests` runs every `test:*` script, which after the union included the planner's
`test:engine` and `test:ui`, also run by `check:planner` (after building the wasm; they print their own summaries,
not node:test's). `scripts/check.mjs` now names them once (`PLANNER_SUITES`): `check:planner` runs them,
`check:tests` skips them.

Notes read: every `docs/notes/*.md` that came in (int-backend, int-planner, engine, ui, server-core, server-scenes,
server-library, product, pipeline, kernels-hardening) and proofs-final (already on `v2`). Their requests to the
integration/cutover are handled below; the rest are in Open issues.

## 2. Cutover

| What | Before | Now |
|---|---|---|
| `evals/lib/harness.mjs` | `MIDSTUDY_SERVER=legacy\|next`, `MIDSTUDY_ADD=legacy\|next` (default legacy); `SERVER`, `ADD`, `STRICT` exports; strict mode only for `next` | `SERVER_CMD = ['node', 'server/src/main.ts']`, `ADD_CMD = 'node pipeline/src/cli.ts'`, `MIDSTUDY_STRICT=1` for every server it starts; the build step always (no "when build.mjs exists") |
| `evals/library_api.sh` (E7) | the same two switches, `uv sync --project pipeline` for legacy | the v2 server and CLI, strict; no uv |
| `evals/pipeline_offline.sh` (E8) | the switch; a legacy-only splat-cover check that imported `midstudy_pipeline` | the v2 CLI, strict, `NODE_USE_ENV_PROXY=1`; the cover check is the one that runs 400,000 splats through a mocked SAM 3D add |
| `contract/tools/record-examples.mjs` (X1) | `SERVER`/`ADD`/`STRICT` from the harness; "recorded: planner/serve.py (MIDSTUDY_SERVER=legacy)" | the harness's commands; strict always |
| Check names | "serve.py starts (…)" in 14 evals | "the server starts (…)" (labels only; what is checked is unchanged) |
| `package.json` `serve` | `python3 planner/serve.py` | `node server/src/main.ts` (`preserve` still builds first) |
| Server defaults (`server/src/logic/cli.ts`) | `--midstudy-add "uv run --project pipeline midstudy-add"` | `--midstudy-add "node pipeline/src/cli.ts"` (run from the repo, as every tool); `--calib` stays `uv run --project calib midstudy-calib`, v2's calib, whose warm worker the server tries first |

E17 (`evals/perf.mjs`) keeps its per-target detection of v1's commands (a target that has `planner/serve.py` runs it):
that is how an A/B against a v1 checkout runs, not a switch of this tree.

## 3. Deleted

### v1

| Path | Lines |
|---|---:|
| `planner/serve.py` | 2,658 |
| `planner/product_page.py` | 2,219 |
| `pipeline/src/midstudy_pipeline/` (9 files) | 1,878 |
| `pipeline/pyproject.toml`, `pipeline/uv.lock`, `pipeline/.python-version` (nothing else used them: the evals' Python helpers have their own pinned environment, `evals/py`) | 354 |
| `planner/*.js` | already gone on `v2-int-planner` (int-planner deleted the last ones) |

`planner/__pycache__/` (v1's, untracked) was removed from the worktree. v1 is unchanged in git since the fork:
`git show 0d40ff5:planner/serve.py` etc.

### What only compared against v1's code in the tree

These can't run without v1 (they import or spawn it) and skipped themselves once it was gone, so they were dead; the
tracks asked for their deletion at the cutover (server-core, server-scenes, server-library, product, int-backend).
Their last results are in those tracks' notes; they still run on `v2-int-backend` (`d5af7a5`), which has v1.

| Deleted | What it did (last result) |
|---|---|
| `server/test/v1_oracle.py`, `differential.test.ts` | the server's pure ports against v1's functions (1,238 cases equal) |
| `server/test/http-diff.test.ts` | v1 and v2 side by side over HTTP (41 GETs, 16 mutations × 5, 12 framings) |
| `server/test/scenes/v1_oracle.py`, `http-diff.test.ts`, 6 of 7 tests in `logic.test.ts` | scenes routes side by side (163 exchanges, 16 files) and the scenes logic against v1 (3,000 + 1,500 + 3,000 random cases…) |
| `server/test/library/v1_library_oracle.py`, `oracle.ts`, `routes.test.ts`, `fake_add.py`, `zip.test.ts`, 2 of 6 tests in `logic.test.ts` | the library API side by side (133 records, library.json byte for byte), `check_meta` (270), `add_command`, `zip_problem` (57 zips) |
| `server/test/product/` (all: `v1_oracle.py`, `oracle.ts`, `sizes.test.ts`, `logic.test.ts`, `pages.test.ts`), and the `test:product` script | the size reader (172,097 requests per seed), the text helpers, 211 page reads side by side: all differential; E14 (409 checks) and E15 (135) remain the reader's checks |
| `pipeline/test/compare_v1.py`, `v1_mock_log.py` | v1 and v2 `midstudy-add` on 77 cases (211 files byte for byte, 61 equivalent, 0 different) |
| `core/crates/media/tests/diff_v1.py`, `diff_fuzz.py`, `bench_v1.py` | the media kernels against v1's Python (102,349 cases), differential fuzzing (31.9 M), v1's column of the benchmark |
| `core/crates/imaging/tests/diff_pillow.py`, `core/crates/imaging/examples/difftool.rs` | the imaging crate against v1's Pillow path (680/680 identical); the difftool served only it |
| `core/crates/wasm-web/tests/v1-sync.mjs`, `v1/lift.py`, `v1/engine.template.mjs`, `v1/lighting.template.mjs` | kept the lifted v1 JS in sync with `planner/*.js` (gone since int-planner: the check could no longer fail); the lifted copies `v1/engine.mjs`, `v1/lighting.mjs` stay, frozen, as `diff.mjs`'s reference |

Kept and adjusted: `core/crates/media/examples/difftool.rs` (the native side of the wasm-vs-native test) and
`core/crates/wasm-node/js-test/face.test.ts`, whose corpus test read diff_v1.py's corpus and now reads the tracked
fuzz corpora of the JPEG, PNG and GLB strippers (`core/crates/media/fuzz/corpus/`, 1,754 inputs, seeded with
`evals/lib/metadata.py`'s GPS canaries): 12/12, every output identical. `core/crates/media/tests/bench_matrix.mjs`
lost its v1 column. Exports only the deleted tests used are now module-local (`parseCsv`, `SYSTEM_PROMPT`,
`PyJsonError`, `literals`, `jsUnescape`) or deleted (`server/src/product/sizes.ts`'s synchronous `textReadings`,
`unitHint`, `thickness`, `llmText`, `lineChains`, `items`, `ItemView`: the reader uses the worker-thread versions);
knip found each. `evals/perf/profile_product.py` stays: E17 uses it on a v1 target.

### Line counts (`git diff --shortstat` from v2's Phase 0 commit `0d40ff5`)

| | Files | Insertions | Deletions |
|---|---:|---:|---:|
| `0d40ff5` → `72719f6` (both halves merged, before the cutover) | 5,347 | 116,615 | 7,200 |
| `0d40ff5` → `4f24bad` (after the cutover and its docs; `f0f1fc6` and the final commit add the E13.24 fix, a comment and these notes) | 5,353 | 110,710 | 14,416 |
| The cutover's two commits (`72719f6` → `4f24bad`) | 95 | 391 | 13,512 |

Of those files, 4,712 are the tracked fuzz corpora (`core/crates/*/fuzz/corpus/`); without them: 635 files, 113,486
insertions, 7,200 deletions before the cutover, and 641 files, 107,581 insertions, 14,416 deletions after it (the 40
deleted files: 12,681 lines, of which 6,755 are v1's code, 354 its Python packaging and 5,572 the v1-only tests and
tools). The tree went from 5,511 tracked files to 5,471. Lines of code, v1 at `0d40ff5` against v2 now: planner 7,212
(JS) → 11,622 (TS, without tests); server 4,877 (Python: serve.py + product_page.py) → 13,422 (`server/src`, of which
the product reader's generated tables are a large part) + 1,553 (`common/`); `midstudy-add` 1,878 (Python) → 3,742
(`pipeline/src`); new: 21,243 lines of Rust in `core/crates/*/src` (+ 2,810 of tests and fuzz targets), 1,504 of
`core/js`, 7,741 of Lean in `proofs/`.

## 4. Docs

- `contract/CONTRACT.md`: §0 (v2 is the only implementation; v1 in history at `0d40ff5`; strict mode also checks
  calibration results; the evals run v2 alone), §2 and §2.1 (the planner bundled from npm, the server's command with
  `--midstudy-add "node pipeline/src/cli.ts"`), §2.8 and §3.4 (the lock directories are the rule; v1's flock files are
  still made, for E7), §2.9, §2.11 (the v2 extractor), §3 and §3.1 (`node pipeline/src/cli.ts` the only command),
  §3.3 (no v1 log wrapper), §4.4 (the worker first), §4.5 (Spark from npm), **§4.8** (the proofs track's note:
  "exactly `lighting.json` at the defaults" holds only while the strength cap is ≥ 1, i.e. `lighting.json`'s darkest
  direction is ≥ 5 % of band 0; and the 96-direction sampling, `defaults_unchanged_iff`, `exactCap`), §5.3 (one server
  and CLI in strict mode; what changed in the evals at the cutover). `contract/scene.schema.json`'s description names
  the server, not serve.py (`contract/gen/` and the Rust bundle regenerated).
- `CLAUDE.md`: the v2 layout, the ownership table after the refactor (app, server, pipeline, kernels, calib, proofs,
  evals, foundation, toolchain, packaging, integration), the tooling (build, every `check:*` with the
  tsc/eslint/knip/cargo/Miri/Kani/fuzz/Lean/TScert commands behind it), the eval lock, the browser rule.
  `scripts/ownership.json` has the same tracks, so `check-ownership.mjs <track>` works for them.
- `README.md`: run v2 locally, build and check, the CLI, evals through the lock on headless Chrome; the Nix packages
  still being v1's.
- `evals/README.md`: no switches; what changed at the cutover.
- `docs/HANDOFF.md` §13: R4 and R5 name v2's server and harness; a note that §3–§5, §9 and §11 describe v1 until the
  packaging is redone (Phase 4). R1–R3 (calib) unchanged: calib has none of them yet.

## 5. Gates

Code states: `53c3c13` (the cutover; `4f24bad` only added docs) and `f0f1fc6` (the fix below, in `planner/engine.ts`,
plus a comment in `common/lock.ts`); the final commit adds these notes. `npm run check` ran in full on `53c3c13`'s
code; after `f0f1fc6`, check:ownership, gen, types, lint, dead and planner were run again (ok) and the rest have
the same inputs (no Rust, Lean, calib, server, pipeline or `logic/` change). Wall times include waiting for an
eval-lock slot; the load average was 2–15 (other agents' work on the Mac).

### `npm run check` (`MIDSTUDY_TRACK=cutover nix develop -c npm run check`): all ok, 32 min 48 s

| Check | Result |
|---|---|
| check:ownership | ok (cutover owns `**`; `check-ownership.mjs` also recognizes every post-refactor track) |
| check:gen | ok: `contract/gen` and `core/crates/contract/schema.json` are what the schemas generate (85 types, 44 schemas) |
| check:types | ok: no errors in planner, server, pipeline, core-web, core-node, contract |
| check:lint | ok: 158 `.ts` files, no problems |
| check:dead | ok: knip, no unused files, exports or dependencies |
| check:tests | ok: 5 suites (contract, library, pipeline, scenes, server), **155 passed**, 0 failed (93 s); 174 before the cutover, the 19 deleted were the v1-differential tests above |
| check:tscert | ok: **704/738 certified, all 704 baselined still certify** (69 files, 210 s). The 34 that don't are int-backend's known ones (product's `PyValue` alias cycle 22, pipeline 10, scenes `isRecord` 1, `jsonLine` 1); every planner function certifies. No tool error this time (load 2–7) |
| check:planner | ok: engine logic vs v1 11/11 groups; UI logic vs v1 204,019 checks, no difference; the bus 5 cases |
| check:py | ok: pyright strict 0 errors, ruff clean |
| check:rust | ok: fmt, clippy `-D warnings`, **205 tests**, Miri on media, raster, geom, splat, imaging, **Kani 21 harnesses** (2 files), 627 s |
| check:fuzz | ok: **14 targets × 60 s**, no crash (decode, picture_ops, glb_strip, host_check, jpeg_strip, media_misc, path_normalize, png_strip, size_json, size_reader, decode_png, mask_and_env, ply_fit, spz_roundtrip), 920 s |
| check:proofs | ok: **24 files, 504 theorems**, Lean 4.29.1, Mathlib v4.29.1, no sorry/admit/new axiom (100 s) |

### Evals (every one through `scripts/eval-lock.mjs`, the v2 server and CLI in strict mode)

| Eval | R1 `53c3c13` | R2 `53c3c13` (beside check:rust) | R3 `53c3c13` | **R4 `f0f1fc6`** | **R5 `f0f1fc6`** |
|---|---|---|---|---|---|
| E1 scenes-api | 220/220 | 220/220 | 220/220 | 220/220 | 220/220 |
| E3 planner | 56/56 | 56/56 | 56/56 | 56/56 | 56/56 |
| E4 occlusion | 21/21 | 21/21 | 21/21 | 21/21 | 21/21 |
| E5 floor | 35/35 | 35/35 | 35/35 | 35/35 | 35/35 |
| E6 render | 37/37 | 37/37 | 37/37 | 37/37 | 37/37 |
| E7 library | 79/79 | 79/79 | 79/79 | 79/79 | 79/79 |
| E8 pipeline | 72/72 | 72/72 | 72/72 | 72/72 | 72/72 |
| E9 phone | 49/49 | 49/49 | 49/49 | 49/49 | 49/49 |
| E11 ux | 29/29 | 29/29 | 29/29 | 29/29 | 29/29 |
| E12 ux2 | 27/27 | 27/27 | 27/27 | 27/27 | 27/27 |
| E13 splat | 51/51 | **50/51** (E13.24: 89.6 %), re-run 51/51 | **50/51** (E13.24: 89.6 %) | 51/51 | 51/51 |
| E14 product | 409/409 | 409/409 | 409/409 | 409/409 | 409/409 |
| E15 product-ui | 135/135 | 135/135 | 135/135 | 135/135 | 135/135 |
| E16 lighting | 57/57 | 57/57 | 57/57 | 57/57 | 57/57 |
| `eval:all` | 14/14 (1,277 checks) | 13/14 | 13/14 | **14/14** | **14/14** |

**E13.24, found and fixed.** "A render right after placing a splat behind another shows the near one in front (≥ 90 %
magenta over the probe)" measured 89.6 % in rounds 2 and 3 (100.0 % in round 1 and in four standalone `eval:splat` runs). The
same value twice is not noise: the composite (`render-…-input.jpg`) showed the far Idol chair drawn over the near
splat probe. Cause: `settleSplats` (the wait for Spark's sort before a capture, v1's logic) called Spark's
`update()` before any frame had run since the piece was added; Spark takes each SplatMesh's world matrix from its
parent's as it stands, and the new piece's group had never had its world matrix updated, so its splats were
generated and sorted where the group was made (the origin, near the camera), the sort "settled", and the capture
drew in that order. v1 never met it: its `worldBounds`, `boxCorners` and `getFootprint` each called `group.updateMatrixWorld(true)`, so
any bounds, corners, screen rect or footprint asked for after an add refreshed the group as a side effect; v2's come
from the kernels, which don't touch three's matrices (the engine track noted that change). Fix (`f0f1fc6`): `scene.updateMatrixWorld()` before Spark's update,
as a render does. Evidence: a scratch copy of E13 (`evals/out/cutover/race/splat-race.mjs`) that repeats the check twelve times in one
page, alternating the eval's own sequence with a variant that adds the chair and asks for the render in one page task
(no frame can run between them): before the fix the variant measured 94.3 % all six times (the eval's sequence
100.0 %), after it 100.0 % all six times. (A first version that ran the variant once per page measured 100.0 % twice:
the race needs the frame timing to line up, which the loop made reliable.) Rounds 4 and 5 then ran on the fixed code.

| Other | Result |
|---|---|
| `eval:selftest` (H0) | 22/22 |
| `check:scenes` | 98/98 |
| `eval:calib -- --mock` (E2 ingest) | 55/55, 1 SKIP (`upper-lounge-camera.jpeg`: no `fixtures/photos/` in the worktree, by the rules for `--mock`) |
| `eval:calib` (E2, real MoGe-2, the three photos linked) | **132/132**, no skip, 83 s |
| `eval:real` (R1, real MoGe-2 through the server's worker, the UI, a GLB add, renders, Compare; `53c3c13`: no splat in it, so the fix doesn't reach it) | **32/32**, 44 s; the lounge photo: fov 69.63° from EXIF (MoGe 72.75°), height 1.432 m, pitch −7.84°, roll 0.26° |
| X1 (`record-examples.mjs --check`: every route's v2 answer against its schema) | 83/83 |
| `eval:ui-smoke` (int-planner's UI flows) | 41/41 on `53c3c13`; 41/41 on `f0f1fc6` |
| `proofs/diff/run.sh 20000` (proofs-final's request, now that kernels-hardening is merged) | all 8 modes identical: jpeg 30,476, png 30,079, slug 20,000, frame 30,476, b64 20,006, meta 20,000, sniff 20,103 (calib's Python agrees on all), wire 20,001 |
| `core/crates/wasm-node/js-test/face.test.ts` | 12/12 (wasm vs native on the tracked corpora: 1,754 inputs identical) |

### E17 (`eval:perf -- --with-calib --compare evals/perf/baseline.json`, once, not exclusive, `53c3c13`): "no regression beyond the allowance"

5 runs + 1 warm-up, 394 s, mean 1-minute load 8.9 (the baseline's: 8.1; so the ratios are roughly like for like, not an
A/B). 34 metrics: **12 better, 22 same, 0 worse**. Ratio = v2 / v1's baseline (median).

| Metric | v1 baseline | v2 | Ratio | Verdict |
|---|---:|---:|---:|---|
| server_start | 180.8 ms | 129.9 ms | 0.72 | same |
| api_scenes / library / layouts p50 | 0.65 / 0.32 / 0.41 ms | 0.41 / 0.15 / 0.19 ms | 0.64 / 0.46 / 0.46 | same / better / better |
| product_read p50 / p95 / max | 1.10 / 2.99 ms / 1.76 s | 0.80 / 3.31 ms / 549 ms | 0.73 / 1.11 / 0.31 | same / same / better |
| add_cli idol / sam3d / glb / rug | 852 / 413 / 176 / 191 ms | 455 / 263 / 145 / 149 ms | 0.53 / 0.64 / 0.82 / 0.78 | better / better / same / same |
| planner_load desktop / warm / phone | 1.80 / 1.79 / 1.76 s | 1.42 / 1.51 / 1.45 s | 0.79 / 0.84 / 0.83 | same / better / same |
| scene_open | 842.9 ms | 111.9 ms | **0.13** | better (7.5×) |
| render_capture (client / server) | 405.9 (398.6 / 7.5) ms | 406.8 (402.9 / 4.0) ms | 1.00 (1.01 / 0.53) | same (server better) |
| render_keep_room (client / server) | 745.7 (700.3 / 45.7) ms | 773.4 (732.8 / 40.9) ms | 1.04 (1.05 / 0.89) | same |
| add_item_splat / splat_first_frame | 156.7 / 302.9 ms | 81.7 / 320.5 ms | 0.52 / 1.06 | same |
| drag_splat / render_capture_splat | 3.04 / 11.47 s | 3.15 / 11.44 s | 1.04 / 1.00 | same |
| calib_first | 8.02 s | 2.89 s | 0.36 | better |
| **calib_second** | **7.84 s** | **944.6 ms** | **0.12** | better (8.3×: the warm worker) |

Planner load: 27 requests on the desktop (24 on the phone), 1,624 KB, none external. Against REFACTOR §4.1:
**met**: calibration from the second photo (≥ 30 % faster: 88 %), scene open (≥ 3×: 7.5×), API latency (no
regression), no product page over 1 s (549 ms). **Not met**: planner cold load ≥ 40 % (21 % desktop, 17 % phone:
SwiftShader's WebGL start-up dominates), keep-room mask ≥ 3× (`render_keep_room_client` 1.05: the mask render and
read-back on SwiftShader dominate; the kernel's mask and PNG take a few ms), `midstudy-add` ≥ 3× (Idol 1.87×, SAM 3D
1.57×: Node start-up and the gzip of 3 MB), product read p95 ≥ 2× (1.11, within noise: the p95 page is two HTTP
round trips). The same picture as int-backend's and int-planner's measurements.

## 6. Open issues

- **E13.24 was a real race, fixed in `f0f1fc6`** (§5): rounds 4 and 5 and the scratch repro pass after the fix. What
  stays is v1's settle heuristic itself ("a sort that starts within 300 ms of an update" in `settleSplats`), which
  can still give up early on a very slow machine; and the engine track's choice to compute bounds with the kernels
  means nothing refreshes three's world matrices between frames any more: `settleSplats` was the one place that read
  them from Spark without a render (raycasts call `scene.updateMatrixWorld()` themselves), but new code reading
  `matrixWorld` outside a render must do the same.
- **The Nix packages are v1's and no longer evaluate**: `nix eval .#packages.aarch64-darwin.midstudy-add` and
  `.#midstudy` (the default) fail with `lib.fileset.unions: … pipeline/pyproject.toml … does not exist`; `nix/module.nix`
  and `checks.x86_64-linux.service` depend on them. `midstudy-calib`, `moge-weights`, `tscert` and both dev shells
  evaluate. Phase 4's packaging redoes them for v2 (`node server/src/main.ts`, `node pipeline/src/cli.ts`, `build/wasm/`,
  `planner/dist/`, `node_modules`); docs/HANDOFF.md says so, and so does README.md. Not changed here (packaging's).
- **REFACTOR §4.1 targets not met** (E17 above): planner cold load ≥ 40 %, keep-room mask ≥ 3×, `midstudy-add` ≥ 3×,
  product read p95 ≥ 2×. Met: calibration from the second photo, scene open, API latency, no page over 1 s. E17 here is
  one non-exclusive run against the baseline file, not the interleaved A/B the plan asks of Phase 4's finish.
- **Differential tests against v1 are gone from the tree** (§3): the parity they showed (server 1,238 + side-by-side,
  scenes, library 133 records byte for byte, product 172k requests a seed, `midstudy-add` 77 cases, media 102k cases,
  imaging 680) is recorded in the tracks' notes and still reproducible on `v2-int-backend` (`d5af7a5`, which has v1).
  The product reader has no unit tests left of its own; E14 (409 checks) and E15 (135) are its regression checks.
- **v1's flock files are still made** (`<library>/.lock`, `costs.csv.lock`) although nothing flocks them since the
  cutover: E7 checks `costs.csv.lock` exists ("the evals don't change"). A later evals change could check the v2
  protocol instead (pipeline track's request) and the creation could go.
- **Kept on purpose:** `evals/perf.mjs`'s v1 commands and `evals/perf/profile_product.py` (an A/B or a profile of a v1
  checkout as a `--target`); the lifted v1 JS in `core/crates/wasm-web/tests/v1/` (frozen; `diff.mjs`'s reference);
  `fixtures/stub_calib.py` and the evals' Python helpers; `.claude/workflows/midstudy-v1.js`; `tscert/experiments/`
  (the TScert style guide's evidence); the `NOOK_*` mock variables the harness sets (a safety net CLAUDE.md asks for,
  though no v2 code reads them).
- **From the halves, still open:** TScert's retry under load is untested (int-backend: no tool errors at load 2–7,
  none here either); the midstudy-calib Nix fix is evaluated (it does) but not built; `eval:product-live` needs
  `fixtures/pages/` (not in worktrees, not run); the planner's maths needs the wasm kernels loaded (int-planner);
  malformed server answers read differently from v1 (int-planner Decisions 4); the horizon drag's row differs from v1
  in the last bit for some inputs; the ui track's two v1 quirks kept for a fixer (the desktop Drop to floor tooltip's
  "null" keycap, the Scenes page's 940 px width that never applies); a shared `common/logic/url.ts` for the two
  partial `urllib.parse` ports, and the two Python-`json` ports (int-backend, on purpose).
- **Not run here:** `eval:product-live` (no `fixtures/pages/`), a quiet-machine A/B of E17, any live fal call, Linux.
- **docs/notes/proofs.md vs proofs-final.md:** proofs-final asked integration to fold its theorem tables into
  proofs.md if one place is wanted; not done (proofs-final.md says its tables supersede proofs.md's).
