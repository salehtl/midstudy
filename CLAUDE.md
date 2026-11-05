# midstudy

See furniture in your own room before you buy it: the room is **one phone photo**, furniture is made from photos at real-world size (SAM 3D on fal), you place it on the photo's floor, save layouts, and render a photoreal image. A fork of [nook](https://github.com/salehtl/nook) without the room scan. Personal use; prefer the simplest thing that works.

[PLAN.md](PLAN.md) is the plan; [contract/CONTRACT.md](contract/CONTRACT.md) is the spec (files, routes, the camera model, the hook). Read the contract before changing `planner/`, `calib/` or `pipeline/`. Agents leave notes in `docs/notes/<track>.md`.

## Conventions

- Units are **meters** in 3D, **centimeters** only in `dims_cm` and CLI `--dims`.
- Right-handed, **Y-up** (glTF / three.js). The floor is **y = 0**. The scene camera stands at x = z = 0, looks along −Z, and is described by the camera block `{fov_y_deg, height_m, pitch_deg, roll_deg}` (contract §4.1 has the exact projection and its signs).
- Item frame: origin at the **center of the footprint, on the floor**; width along X, height along Y, depth along Z; the **front faces +Z**. Positive `rotation_y_deg` is counterclockwise seen from above.
- Ids, layout and scene names are slugs: `^[a-z0-9][a-z0-9-]{0,63}$`. Asset paths in `library.json` are relative to it.

## v2 refactor (branch `v2`, in progress)

[docs/REFACTOR.md](docs/REFACTOR.md) is the plan: TypeScript (strict, TScert) for the planner, server and `midstudy-add`; Rust → WebAssembly kernels in `core/`; Lean proofs in `proofs/`; calib stays Python, typed. It runs as workflows of parallel tracks, each in its own worktree (`.claude/worktrees/rf-<track>/`, branch `v2-<track>`).

- **Ownership** is `scripts/ownership.json`; `node scripts/check-ownership.mjs <track>` must pass before a track finishes. Only gate and integration agents write `v2`. Nothing is pushed.
- **Evals go through the lock**: `node scripts/eval-lock.mjs -- npm run eval:…` (`--exclusive` for performance runs).
- The evals don't change except where the harness starts things (browser, `MIDSTUDY_SERVER=legacy|next`, `MIDSTUDY_ADD=legacy|next`, strict mode, the planner build). They are the independent check that v2 behaves as v1.

User data (`scenes/`, `library/`, `layouts/`, `renders/`) is written by the tools and git-ignored, except `library/library.json` and `library/costs.csv`.

## Secrets, privacy and cost

- `.env` at the repo root holds a **real** `FAL_KEY` (git-ignored). Never read, print, copy or edit it, and never set `FAL_KEY`.
- fal is always mocked during development: `MIDSTUDY_FAL_MOCK=fixtures/fal` and `MIDSTUDY_NO_DOTENV=1` (plus `NOOK_NO_DOTENV=1`) on every `serve.py` and `midstudy-add` you start, and `serve.py --daily-spend-usd 0`. Only the main session makes live calls (PLAN.md §8).
- `fixtures/photos/` holds the user's own room photos (git-ignored; read its `notes.md`). Never commit them or copy them anywhere tracked. **Never open `fixtures/photos/private/`** (location data). Photo files dropped at the repo root are git-ignored too.
- `photo.jpg` in a scene must carry no metadata: it is served and sent to fal (contract §4.3).

## Tooling

- Tools come from the flake's dev shell: run `nix develop -c <cmd>` from the repo root (python 3.12, uv, node 22, git). Never install anything globally (`brew`, `npm -g`, `pipx`, `nix profile`). Nix only sees files git tracks: `git add` a new file before relying on it through nix.
- Python: uv projects in `pipeline/` (and `calib/`). `evals/py <script>` runs eval helpers with pinned deps (numpy, pillow, jsonschema, trimesh, pygltflib).
- Node is for evals and fixtures only (`playwright-core`, `ajv`, `three`); the planner has no build step. `nix develop -c npm install` once.
- Browser: **headless Chrome** from the user's flake, `$PUPPETEER_EXECUTABLE_PATH` (or `MIDSTUDY_BROWSER`), with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, plus `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader` for WebGPU (a secure-context page: the evals' `http://127.0.0.1`). **Never launch Helium** or any browser the user browses with.
- Calibration while `calib/` is being built, and in fast evals: `serve.py --calib "python3 fixtures/stub_calib.py"`, or the real CLI with `MIDSTUDY_CALIB_MOCK=fixtures/calib`.
- Servers you start pick a free port and are stopped when you're done. Scratch output goes to `evals/out/` (git-ignored).
- No ssh, nothing on homeserver, no `git push`, no changes to git config or remotes.

## Evals

`evals/README.md` describes each one; `docs/notes/*.md` say where things stand. All are $0 (fal mocked) and set the mock variables themselves.

- `nix develop -c npm run eval:all`: E1 and E3–E9 (scenes API, planner, occlusion, floor, render, library, pipeline, phone) and E11 (`eval:ux`, the verify round 1 UX regressions), one after another; `-- --with-calib` adds E2.
- `nix develop -c npm run eval:calib`: E2, real MoGe-2 on the golden scenes and `fixtures/photos/` (`-- --mock` checks ingest only).
- `nix develop -c npm run eval:real`: the real path on this Mac (real MoGe-2, a photo from `fixtures/photos/`, GLB add, renders, Compare); not in `eval:all`.
- `nix develop -c npm run eval:selftest`: the eval machinery itself.
- `nix develop -c node fixtures/make_scene.mjs` regenerates the golden scenes; `nix develop -c npm run check:scenes` checks them (and pins the camera convention).
- `evals/validate_library.py <library.json>` checks a library against the contract.
