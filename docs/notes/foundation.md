# Foundation notes

What the foundation agent built on branch `v1`, how to run it, and what it left for the next tracks.

## What's here

| Path | What | Source |
|---|---|---|
| `planner/` | nook's planner and `serve.py`, **renames only** (see below). Still has rooms, splats, Spark, shell, hanging, retrain and `--scan-api`: the app track replaces them per contract §4. | nook `bb2919d` |
| `pipeline/` | `midstudy-add`, package `midstudy_pipeline` (uv project, Python 3.12). `uv.lock` differs from nook's only in the project name. | nook |
| `evals/pipeline_offline.sh`, `evals/library_api.sh`, `evals/validate_library.py`, `evals/glb_info.py`, `evals/py` | the carried evals and their helpers | nook, renamed |
| `fixtures/fal`, `fixtures/models`, `fixtures/library`, `fixtures/library-broken` | fal mock responses, test models, fixture libraries | nook, unchanged except `fal/NOTES.md`'s package path |
| `library/library.json`, `library/costs.csv` | empty dev library (`{"version": 1, "items": []}`, header-only costs) | new |
| `contract/CONTRACT.md` | the spec: nook §1–3 trimmed and renamed, PLAN.md §4 folded in as §4 with the details pinned, §5 fixtures and eval rules | new |
| `contract/{scene,calib}.schema.json`, `contract/layout.schema.json` | scene.json, calib.json, layouts with `scene_name` (no room fields, no camera) | new / changed |
| `contract/library.schema.json` | unchanged apart from `$id` and title | nook |
| `fixtures/make_scene.mjs` | golden-scene renderer (three.js 0.180.0 from `node_modules`, headless Helium, swiftshader) | adapted from nook's `make_capture.mjs` |
| `fixtures/scenes/<id>/` | `photo.jpg`, `truth.json`, `depth.png`, `calib.json`, `ids.png` for `living-wide`, `steep-roll`, `portrait` | generated |
| `fixtures/calib/<sha256>/` | `calib.json` + `depth.png` per golden photo, for `MIDSTUDY_CALIB_MOCK=fixtures/calib` | generated |
| `fixtures/check_scenes.py` | self-check that pins the camera convention (60 checks) | new |
| `fixtures/stub_calib.py` | stdlib stand-in for `midstudy-calib` (`run`, `ingest`, `fit`, `align`) | new |
| `nix/` | `fal-client.nix`, `midstudy-add.nix` (renamed from `nook-add.nix`), `midstudy.nix` and `module.nix` (nook's, marked REFERENCE ONLY) | nook minus gsplat/poses |
| `flake.nix` | dev shells only (aarch64-darwin, x86_64-linux): python312, uv, nodejs_22, git; sets `UV_PYTHON` to the shell's 3.12 and `UV_PYTHON_DOWNLOADS=never` | new |
| `package.json` | scripts `serve`, `eval:pipeline`, `eval:library`, `fixtures:scenes`, `check:scenes`; devDeps `ajv`, `playwright-core`, `three@0.180.0` | adapted |

## Renames applied (mechanical)

`NOOK_*` → `MIDSTUDY_*` (env vars, and internal constants such as `MIDSTUDY_ADD_TIMEOUT`), `X-Nook*` → `X-Midstudy*`, `nook_pipeline`/`nook-pipeline` → `midstudy_pipeline`/`midstudy-pipeline`, `nook-add` → `midstudy-add` (also `serve.py --midstudy-add`, attribute `midstudy_add`), `NookError` → `MidstudyError`, `window.nook` → `window.midstudy` (`window.midstudyCtx`), `withNook` → `withMidstudy`, `data-nook`/`dataset.nook`/`{ nook: … }` → `data-midstudy`, localStorage keys `nook.*` → `midstudy.*`, `[nook]` log prefix, page title `midstudy planner`, manifest names, the `.env` hint, User-Agent strings, temp-dir prefixes, the GLB node names `midstudy_orientation` / `midstudy_item_frame`.

Left alone on purpose: user-visible strings about the dropped scan feature ("Nook Scan", "nook-scan", homeserver training) in `planner/ui/rooms*`, `retrain.js`, `data.js`, `engine.js` and `serve.py`'s scan proxy; the Paper file name in `kit.css`. They go away when the app track deletes those features. In `nix/module.nix` and `nix/midstudy.nix` only the env-var and `midstudy-add` renames were applied; they still describe nook's services.

## How to run

```sh
nix develop -c true                 # dev shell builds
nix develop -c npm install          # once
nix develop -c npm run eval:pipeline   # 39/39
nix develop -c npm run eval:library    # 65/65 (free ports unless MIDSTUDY_EVAL_LIBRARY_PORT is set)
nix develop -c node fixtures/make_scene.mjs        # regenerate the golden scenes (~20 s)
nix develop -c evals/py fixtures/check_scenes.py   # 60/60; marker images in evals/out/check-scenes/
```

The calib stub: `python3 fixtures/stub_calib.py run <photo.jpg> --out <scene-dir>` (add `MIDSTUDY_CALIB_MOCK=fixtures/calib` to get the golden calibrations). For the server: `--calib "python3 fixtures/stub_calib.py"` (the default `uv run --project calib midstudy-calib` needs `calib/`). It runs on the system Python 3.9 too, but use the dev shell.

## Decisions the next tracks should know

- **Camera convention is pinned** (contract §4.1): `R = Rx(pitch)·Rz(roll)` (three.js Euler `'YXZ'`, yaw 0), `f = (H/2)/tan(fov_y/2)`, `px = W/2 + f·x_c/d`, `py = H/2 − f·y_c/d`, `d = −z_c`, pixel origin at the top-left corner. Positive roll makes the horizon fall to the right. `check_scenes.py` shows three.js renders match this (silhouette IoU ≥ 0.998 for the sofa, ≥ 0.996 for the table) and that negating roll or pitch, or moving pitch by 0.5°, fits clearly worse.
- **depth.png is view-axis depth** (not Euclidean): on the golden sofa's front face the median error is 0.25 mm; reading it as Euclidean would be off by 60–80 mm. Depth pixel centers follow the same projection at the depth map's size.
- **Golden photos have no metadata** (JFIF only; the canvas's sRGB ICC segment is stripped) so an ingest that passes clean JPEGs through byte for byte keeps the SHA. The contract requires that pass-through, and the calib mock also falls back to the SHA of `source.<ext>`, so mocked calibration works through the real upload path.
- **Golden geometry:** room x −2.6…2.6, back wall z −5.0, ceiling 2.7 m. Sofa box 2.0 × 0.82 × 0.9 at (−0.3, 0, −3.3); table 1.0 × 0.42 × 0.55 at (0.25, 0, −2.25), turned 12°. Open floor at (1.2, 0, −3.0), (1.6, 0, −3.4), (1.4, 0, −4.4), (2.2, 0, −4.6). The floor behind the sofa is hidden in all three photos, so an item placed there (E4) is partly hidden by the sofa. The table overlaps the sofa's lower front in every photo.
- **`ids.png`** gives each object's silhouette rendered alone, no occlusion (R sofa, G table, threshold 128): use it for projection checks; use `depth.png` for occlusion checks.
- **The rendered JPEG bytes are not deterministic across runs** (swiftshader), so re-running `make_scene.mjs` changes the SHA-256 names under `fixtures/calib/` (it deletes the old folder first). Only regenerate when the scene must change, and commit both together.
- **Scene and calib contract details beyond PLAN.md** (all in contract §4): calib output contract (`{"ok": false, "error"}` + `midstudy-calib: …` on stderr, exit 1), `fit` reads EXIF from `source.<ext>`, EXIF FOV formula (14 mm on 16:9 → 69.6° vertical), `camera_source` becomes `auto` after any successful calibration (fallbacks included; the planner flags fallbacks via `calib.source`/`floor.found`), scene object gains `calib_error`, calibration jobs are `c-…`, 600 s timeout, `409` for a second calibrate, `scene.json` has `version` and `upload`, layouts have `updated` and require `scene_name`.
- The library eval's first server now runs with `--daily-spend-usd 0` (mock calls count for nothing, so adds still pass); its W2 part still uses a $0.03 cap with `MIDSTUDY_FAL_MOCK_COST=1`, which is mock-only with no key and no `.env`.

## Known gaps / left for others

- `planner/` is nook's UI under new names. A headless boot (`window.midstudy` ready, `addItem` works, 4 `data-midstudy` handles, no `data-nook` left) showed one 404 console error from nook's room/scan requests; the app track removes those. No planner eval is carried (nook's planner evals test rooms and splats).
- The app track owns: scenes API in `serve.py`, removing rooms/scan/Spark/shell/hang/retrain, the §4.5 planner and §4.6 hook.
- `nix/module.nix` and `nix/midstudy.nix` are nook's; `flake.nix` has no packages (packaging track).
- `evals/README.md` was not carried; CLAUDE.md lists the evals.
- `library_api.sh` prints harmless `cat: …: No such file` noise (nook quirk: some failure details are expanded before the request runs).
- The stub can't decode PNG/HEIC/WebP, rotate, resize or colour-convert; it warns (size, ICC) or refuses (orientation ≠ 1, non-JPEG). `align` always answers `applied: false`.
