# midstudy

See furniture in your own room before you buy it: the room is **one phone photo**, furniture is made from photos at real-world size (SAM 3D on fal), you place it on the photo's floor, save layouts, and render a photoreal image. A fork of [nook](https://github.com/salehtl/nook) without the room scan. Personal use; prefer the simplest thing that works.

[PLAN.md](PLAN.md) is the plan; [contract/CONTRACT.md](contract/CONTRACT.md) is the spec (files, routes, the camera model, the hook, the schemas in `contract/`). Read the contract before changing `planner/`, `server/`, `pipeline/`, `calib/` or `core/`. [docs/REFACTOR.md](docs/REFACTOR.md) is how v2 was built; `docs/notes/cutover.md` is where it ended. [docs/STATUS.md](docs/STATUS.md) says where v2 stands; [docs/ROOMS.md](docs/ROOMS.md) is the rooms plan (one layout across several photos of a room, contract §4.9; built, Phase D with the user's own room pending). Agents leave notes in `docs/notes/<track>.md`.

How the pieces connect: a room photo goes through `calib/` (MoGe-2) and becomes a scene in `scenes/` with its camera block (contract §4.1–4.3). Furniture photos go through `midstudy-add` (`pipeline/`, fal) into entries in `library/library.json` (§3). The server serves both to the planner, which places items on the photo's floor, saves layouts and asks for renders (§2.6–2.8, §4.4–4.7). A room (§4.9) groups several scenes: `midstudy-calib align-room` (MASt3R, or Manhattan without the `rooms` extra) gives each photo a pose and scale in one room frame, and room layouts are placed once and drawn in every photo. The Rust kernels in `core/` are used as wasm by all three TypeScript programs.

## Conventions

- Units are **meters** in 3D, **centimeters** only in `dims_cm` and CLI `--dims`.
- Right-handed, **Y-up** (glTF / three.js). The floor is **y = 0**. The scene camera stands at x = z = 0, looks along −Z, and is described by the camera block `{fov_y_deg, height_m, pitch_deg, roll_deg}` (contract §4.1 has the exact projection and its signs).
- Item frame: origin at the **center of the footprint, on the floor**; width along X, height along Y, depth along Z; the **front faces +Z**. Positive `rotation_y_deg` is counterclockwise seen from above.
- Ids, layout and scene names are slugs: `^[a-z0-9][a-z0-9-]{0,63}$`. Asset paths in `library.json` are relative to it.
- v2 behaves as v1 did (contract §0): v1 (`planner/serve.py`, the Python `midstudy-add`) is gone since the cutover, but "as v1" in the contract and the code's comments still names the behaviour to keep. When v1 and the contract disagree, say so in your notes.

## Layout

```
contract/        CONTRACT.md, *.schema.json (files), api/*.schema.json + routes.json (HTTP), examples/ (recorded)
contract/gen/    generated from the schemas (node scripts/gen-contract.mjs): types.ts, validate.js, routes.js; never edit
planner/         the browser app, strict TypeScript: main.ts, engine*.ts, lighting.ts, input.ts, data.ts, wire.ts, bus.ts,
                 logic/ (pure, TScert; room.ts: §4.9 frames, the floor plan), ui/ (DOM; room.ts: photo strip, floor plan,
                 Align photos; ui/logic/ pure, TScert), gpu/ (WebGPU: TSL passes, the splat renderer
                 and its GPU and worker sorts; WebGL2 fallback built in, ?webgpu=0), styles/, index.html; bundled to planner/dist/
server/          the HTTP server (node server/src/main.ts): src/http, src/routes, src/scenes, src/library, src/product,
                 src/rooms (rooms on disk, align jobs on the calibration queue), src/logic (pure, TScert; also
                 src/*/logic/); test/ (npm run test:server, test:scenes, test:library)
common/          what the server and midstudy-add share: the library lock, costs.csv, fal, files, tools; logic/ (TScert)
pipeline/        midstudy-add (node pipeline/src/cli.ts): src/, src/logic/ (TScert), test/ (npm run test:pipeline)
core/            Rust workspace: crates/{media,geom,raster,splat,imaging,product,contract} and the wasm builds
                 crates/wasm-{web,node,pipeline,product}; js/{web,node,pipeline}.ts are their typed faces; fuzz/
calib/           midstudy-calib: Python (uv), pyright-strict, MoGe-2; `midstudy-calib serve` is the warm worker;
                 src/midstudy_calib/rooms/ is align-room (MASt3R in the optional `rooms` extra, Manhattan without it)
proofs/          Lean 4 + Mathlib: the camera model, rotations, clamps, units, lighting, room frames (Room.lean), models of
                 the byte kernels; diff/ (the Lean models against the Rust; diff/room/ against planner/logic/room.ts)
evals/           E1–E20 (evals/README.md), lib/harness.mjs, lib/rooms.mjs, perf.mjs and perf/baseline.json (E17)
fixtures/        golden scenes (scenes/, calib/; the golden room: living-wide, room-1…6, calib/rooms/), fal mock answers
                 (fal/), models, product pages
scripts/         build.mjs, check.mjs (npm run check), gen-contract, tscert-ratchet, eval-lock, ownership
tscert/          TScert's config and the ratchet (baseline.json: every function that must keep certifying)
nix/, flake.nix  dev shells (default, nightly) and the packaging
build/           wasm and other build outputs (git-ignored; so is planner/dist/)
.upstream/nook/  nook's source, git-ignored, for reference only: read it, never edit or import from it
```

User data (`scenes/`, `library/`, `layouts/`, `renders/`, `rooms/`) is written by the tools and git-ignored, except `library/library.json` and `library/costs.csv`.

## Ownership

`scripts/ownership.json` is the source; `node scripts/check-ownership.mjs <track> [--base <ref>]` refuses changes outside a track's paths (`MIDSTUDY_TRACK=<track> npm run check:ownership` in the gate). After the refactor:

| Path | Owner |
|---|---|
| `planner/` (the app, its logic, UI, styles, `index.html`), `tsconfig.planner.json` | app |
| `server/`, `common/`, `core/crates/{product,wasm-product}/`, `tsconfig.server.json` | server |
| `pipeline/`, `core/crates/{splat,imaging,wasm-pipeline}/`, `core/js/pipeline.ts`, `tsconfig.pipeline.json` | pipeline |
| `core/crates/{media,geom,raster,wasm-web,wasm-node}/`, `core/js/{web,node}.ts`, `core/fuzz/`, `core/miri.txt` | kernels |
| `calib/` (and contract §4.3 Worker) | calib |
| `proofs/`, `nix/lean.nix` | proofs |
| `evals/` (new evals), `fixtures/` but the golden scenes | evals |
| `contract/`, `core/crates/contract/`, `CLAUDE.md`, `PLAN.md`, `README.md`, `docs/REFACTOR.md`, `fixtures/scenes/`, `fixtures/calib/`, `evals/lib/harness.mjs`, the ownership and eval-lock scripts | foundation; read-only for the others except the integration agent |
| `scripts/` (the rest), `tscert/`, `tsconfig*.json` (the rest), `eslint.config.js`, `knip.json`, `.gitignore`, the Cargo workspace files | toolchain |
| `nix/`, `flake.nix`, `flake.lock`, `docs/HANDOFF.md` | packaging |
| everything (merges, cross-cutting fixes) | integration |
| `docs/notes/<track>.md` | each track its own |

**Shared-append** (any track adds entries, never edits or removes others'; whoever merges unions conflicts and regenerates the lockfile): `package.json`, `package-lock.json`, `core/Cargo.lock`, `tscert/baseline.json`, `knip.json`. Parallel tracks each work in their own worktree and branch; only integration commits to the main line. Push only when the user asks.

## Secrets, privacy and cost

- `.env` at the repo root holds a **real** `FAL_KEY` (git-ignored). Never read, print, copy or edit it, and never set `FAL_KEY`.
- fal is always mocked during development: `MIDSTUDY_FAL_MOCK=fixtures/fal` and `MIDSTUDY_NO_DOTENV=1` (plus `NOOK_NO_DOTENV=1`) on every server (`node server/src/main.ts`) and `midstudy-add` (`node pipeline/src/cli.ts`) you start, and the server with `--daily-spend-usd 0`. Only the main session makes live calls (PLAN.md §8).
- `fixtures/photos/` holds the user's own room photos (git-ignored; read its `notes.md`). Never commit them or copy them anywhere tracked. **Never open `fixtures/photos/private/`** (location data). Photo files dropped at the repo root are git-ignored too.
- `photo.jpg` in a scene must carry no metadata: it is served and sent to fal (contract §4.3).

## Tooling

Everything comes from the flake's dev shell: run `nix develop -c <cmd>` from the repo root (Node 22, Python 3.12, uv, git, Rust 1.95 with wasm32, wasm-bindgen, wasm-opt, Lean, pyright, ruff, `tscert`). `nix develop .#nightly -c …` is the dated nightly Rust with Miri, cargo-fuzz and Kani. One-offs: `nix shell nixpkgs#<pkg> -c <cmd>`. Never install anything globally (`brew`, `npm -g`, `pipx`, `nix profile`). Nix only sees files git tracks: `git add` a new file before relying on it through nix.

- **Install and build:** `nix develop -c npm ci` once, then `nix develop -c npm run build` (`node scripts/build.mjs`: the wasm crates through cargo, wasm-bindgen and wasm-opt into `build/wasm/`, and the planner bundle into `planner/dist/`; incremental, `--force`, `--wasm-only`, `--planner-only`). `npm run serve` builds, then starts the server.
- **Run:** `nix develop -c node server/src/main.ts --port 8765 --daily-spend-usd 0` (with the mock variables above), the planner at `http://127.0.0.1:8765/planner/`. Calibration in development and fast evals: `--calib "python3 fixtures/stub_calib.py"`, or the real CLI with `MIDSTUDY_CALIB_MOCK=fixtures/calib`. The furniture CLI: `node pipeline/src/cli.ts INPUT --name … --dims … --library <dir>`.
- **Gates:** `nix develop -c npm run check` runs every check, one summary line each; `npm run check:<name>` runs one:
  - `types`: `tsc -b` over the tsconfig areas (planner, server, pipeline, core-web, core-node, contract), strict plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` and friends; one area: `npx tsc -b tsconfig.planner.json`.
  - `lint`: eslint, typescript-eslint strict-type-checked: no `any`, no `!`, no `as` but `as const`, no ts-comments.
  - `dead`: knip, no unused files, exports or dependencies.
  - `gen`: `contract/gen/` and the Rust schema bundle equal what `node scripts/gen-contract.mjs` writes.
  - `tests`: every `npm run test:*` node:test suite (contract, server, scenes, library, pipeline), `FAL_KEY` unset.
  - `tscert`: TScert over the `logic/` modules (`tscert/config.json`); every function in `tscert/baseline.json` must still certify. One file: `node scripts/tscert-ratchet.mjs --files <a.ts,b.ts>`; after adding pure functions, `--update` (removing one from the baseline is a decision for your notes). Under heavy load TScert can end in "tool errors" (verifier timeouts): run it again before reading one as a failure.
  - `planner`: the planner's logic against v1's (`npm run test:engine`, `test:ui`) and the typed bus.
  - `py`: pyright strict and ruff on `calib/` (calib's own tests: `nix develop -c bash -c 'cd calib && uv run pytest -q'`).
  - `rust`: in `core/`, `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`, Miri on `core/miri.txt`'s crates and every Kani harness (nightly shell). By hand: `(cd core && nix develop ..#default -c cargo test -p <crate>)`.
  - `fuzz`: every cargo-fuzz target for `MIDSTUDY_FUZZ_SECONDS` (default 60), nightly shell; campaigns: `core/fuzz/campaign.sh`.
  - `proofs`: `lake build` in `proofs/` with the pinned Lean (`proofs/run.sh`, which keeps Mathlib's cache in `proofs/.lake`; `proofs/run.sh lake exe cache get` once per fresh clone), no `sorry`, `admit` or new `axiom`. The Lean models of the byte kernels against the Rust: `nix develop -c proofs/diff/run.sh [N]`.
  - `ownership`: `scripts/check-ownership.mjs` for `MIDSTUDY_TRACK` (default: the track of a `v2-<track>` branch).
- **Python:** `calib/` is the only Python package (uv). Its optional `rooms` extra (MASt3R's deps; `uv sync --project calib --extra rooms`; the code and 2.6 GB of weights are fetched once into caches outside the repo) is what `align-room` needs to answer with MASt3R; the server's default `--calib` is `uv run --project calib --extra rooms midstudy-calib`, so an exact `uv sync` doesn't silently drop it. With the extra: `cd calib && uv run --extra rooms pytest -q` (the `mast3r` tests run the real solver; run them under the eval lock). `evals/py <script>` runs eval helpers with pinned deps (numpy, pillow, jsonschema, trimesh, pygltflib).
- **Browser:** headless Chrome from the user's flake only: `$PUPPETEER_EXECUTABLE_PATH` (or `MIDSTUDY_BROWSER`), with `--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`, plus `--enable-unsafe-webgpu --use-webgpu-adapter=swiftshader` for WebGPU (a secure-context page: the evals' `http://127.0.0.1`). **Never launch Helium** (`/Applications/Helium.app`) or any browser the user browses with: automation takes it over.
- Servers you start pick a free port and are stopped when you're done. Scratch output goes to `evals/out/` (git-ignored).
- No ssh, nothing on homeserver, no `git push`, no changes to git config or remotes.

## Evals

`evals/README.md` describes each one; `docs/notes/*.md` say where things stand. All are $0 (fal mocked) and set the mock variables themselves. They run `node server/src/main.ts` and `node pipeline/src/cli.ts` in strict mode (`MIDSTUDY_STRICT=1`: every answer and written file is checked against its schema), after `node scripts/build.mjs`. **Every eval goes through the lock**, a machine-wide semaphore shared by every worktree: `nix develop -c node scripts/eval-lock.mjs -- npm run eval:…` (`--exclusive` for performance measurements). A timing check that fails once under load is re-run before it counts.

- `npm run eval:all`: E1, E3–E9, E11–E16, `eval:keys`, E18, E19 and E20 `--mock` (scenes API, planner, occlusion, floor, render, library, pipeline, phone, the UX rounds, splats, the product page and its form, lighting, keyboard shortcuts and Export, the rooms API, the room planner, the align-room mock; then `eval:engine-races` and `eval:ui-smoke`), one after another; `-- --with-calib` adds E2. Browser evals run on WebGPU; `MIDSTUDY_WEBGPU=0` runs them on the WebGL2 fallback.
- `npm run eval:calib`: E2, real MoGe-2 on the golden scenes and `fixtures/photos/`, then E20 real (the real MASt3R solver on the golden room; `--no-align` skips it) (`-- --mock` checks ingest only).
- `npm run eval:real-room -- --photos <dir> --measurements <file.json>`: Phase D of docs/ROOMS.md, real MoGe-2 and MASt3R on the user's photos of one room, spots against tape measurements; `-- --golden` checks the eval itself on the golden room. Not in `eval:all`.
- `npm run eval:real`: the real path on this Mac (real MoGe-2, a photo from `fixtures/photos/`, GLB add, renders, Compare); not in `eval:all`.
- `npm run eval:perf`: the performance eval (its reports say E17, as does `eval:keys`'s file: two evals share the number) (`-- --compare evals/perf/baseline.json`, v1's numbers; `--target a:<path> --target b:<path>` for an A/B).
- `npm run eval:selftest`: the eval machinery itself. `npm run eval:ui-smoke`: the UI flows no other eval drives.
- `nix develop -c node fixtures/make_scene.mjs` regenerates the golden scenes; `nix develop -c npm run check:scenes` checks them (and pins the camera convention).
- `evals/validate_library.py <library.json>` checks a library against the contract.
