# Packaging notes (v2)

The packaging agent of v2 Phase 4 (docs/REFACTOR.md §5), on branch `v2-packaging` from `v2` at `9fb9291`, worktree
`.claude/worktrees/rf-packaging`. The handoff for the homeserver agent is [docs/HANDOFF.md](../HANDOFF.md); this file is
the short version for the next agent on the Mac. v1's packaging notes are in git (`git show 9fb9291:docs/notes/packaging.md`).
Everything below ran on rabbit (M3 Max) on 2026-11-06, fal mocked, $0, `.env` never read, `FAL_KEY` never set,
headless Chrome from `$PUPPETEER_EXECUTABLE_PATH` only.

## What changed

| File | What |
|---|---|
| `nix/wasm.nix` (new) | `midstudy-wasm`: `node scripts/build.mjs --wasm-only` with Rust 1.95.0 (rust-overlay, `rustWasm`), `makeRustPlatform` + `importCargoLock` on `core/Cargo.lock`, `cargoRoot = "core"`, wasm-bindgen-cli 0.2.121, binaryen; source is `core/` without the fuzz targets (their corpora) plus `scripts/build.mjs`; `--remap-path-prefix=$NIX_BUILD_TOP=/build` for the wasm32 target (joins `core/.cargo/config.toml`'s SIMD flag) |
| `nix/node-modules.nix` (new) | `importNpmLock.buildNodeModules` twice from `package.json` + `package-lock.json`: `build` (all) and `runtime` (no devDependencies: the lock's non-dev entries); optional packages for another os/cpu lose `resolved` (not fetched, npm skips them); npm's hidden `node_modules/.package-lock.json` removed (it named every tarball's store path, which kept them all in the closure) |
| `nix/midstudy-app.nix` (new) | the built tree `share/midstudy/` (layout in its header): copies the build packages (a copy, not a link: see Decisions), the wasm into `build/wasm/`, `node scripts/build.mjs --planner-only`, then ships `package.json`, `server/src`, `common`, `core/js`, `pipeline/src`, `contract/gen`, the planner minus `*.ts`/`*.mjs` (so `dist/`, `index.html`, styles, icons, manifest), `build/wasm/{node,pipeline,product}` and `node_modules` → the runtime set. Install check: the bundle and web wasm are there, `index.html` loads `./dist/app.js`, and the media, pipeline and product kernels load in Node (one call each), glTF-Transform imports |
| `nix/midstudy-add.nix` | rewritten: `bin/midstudy-add` = Node 22 + the tree's `pipeline/src/cli.ts`; install check `--help`; passthru `app`, `wasm`, `nodeModules` |
| `nix/midstudy.nix` | rewritten: `bin/midstudy-web` = Node 22 + the tree's `server/src/main.ts --calib <midstudy-calib> --midstudy-add <midstudy-add>`; install check `--help` |
| `nix/midstudy-calib.nix` | int-backend had added `ps.jsonschema` and the worker/validate/contract_types/jsonschema imports; now also lighting, records and util, `serve --help`, and a check that the three schemas in `src/midstudy_calib/schemas/` load through `importlib.resources` (`problems("calib", {})` non-empty, a valid worker request accepted); comments name the v2 server |
| `nix/module.nix` | options unchanged; ExecStart passes `--midstudy-add` explicitly (the server's default is `node pipeline/src/cli.ts`, a checkout path); the shim already covered `run | fit | light | serve` (int-backend); comments for the Node server and the worker |
| `nix/test.nix` | the VM test also fetches `dist/app.js`, the web wasm as `application/wasm` and a stylesheet, checks `/planner/main.ts` is 404, finds the worker (`pgrep -u midstudy -f 'midstudy_calib.cli.* serve --device cpu'`; the python process's command line has `midstudy_calib.cli`, not `midstudy-calib`) and no fallback line in the journal, and that stopping the service stops the worker |
| `nix/toolchain.nix` | `rustWasm` (1.95.0 minimal + wasm32 std) beside `rustStable`, for the package; the dev shells are unchanged |
| `nix/fal-client.nix` | deleted: the Python fal client of v1's midstudy-add; nothing uses it (v2's CLI speaks fal's HTTP API itself) |
| `flake.nix` | packages `midstudy`, `midstudy-add`, `midstudy-calib`, `moge-weights`, `tscert`, `default`; `fal-client` gone; `midstudy-app` is built once per system and reached through `.app`/`.wasm`/`.nodeModules` |
| `docs/HANDOFF.md` | rewritten for v2 (§3–§5, §9, §11, §13, §14 new; §6–§8, §10, §12 updated) |

`flake.lock` is unchanged: nixpkgs `1f607aa` (nook's, so torch-bin is still nook's derivation:
`nix eval --raw .#packages.x86_64-linux.midstudy-calib.torch.drvPath` is `/nix/store/mlhz62jx…-python3.13-torch-2.11.0.drv`),
rust-overlay `19e0e6c`.

## How to check it on the Mac

```sh
nix flake check --no-build --all-systems
nix build .#midstudy-add -L --no-link     # wasm (~1 min of cargo), both npm sets, the bundle, the tree, --help
nix build .#midstudy -L --no-link         # + midstudy-calib (torch-bin's MPS wheel), the weights, midstudy-web
nix build --rebuild .#midstudy.wasm       # the wasm build is deterministic (no "output differs")
# the weights FOD without downloading, from the HF cache of the same revision:
#   cp -c -L ~/.cache/huggingface/hub/models--Ruicheng--moge-2-vitl-normal/snapshots/cb0e8bbd6b1e243589717c78e750b1ba4c093acf/model.pt \
#     <scratch>/moge-2-vitl-normal-model.pt && nix-store --add-fixed sha256 <scratch>/moge-2-vitl-normal-model.pt
```

The packaged-server smoke test is a scratch script (`evals/out/packaging/smoke.mjs`, git-ignored; not an eval): it
starts `midstudy-web` like the service (absolute dirs, `--allowed-host`, $0, fal mocked, strict mode) and drives it
over HTTP and in headless Chrome. `--real` drops `MIDSTUDY_CALIB_MOCK` so MoGe-2 runs through the packaged worker.
Run it through the lock: `nix develop -c node scripts/eval-lock.mjs -- node evals/out/packaging/smoke.mjs <midstudy-web> [--real]`.

## Results

Built on aarch64-darwin (the Mac's daemon has `sandbox = false`, so these builds had network access they didn't ask
for; see Not done):

| Derivation | Result |
|---|---|
| `midstudy-wasm` | built, 55 s of cargo (96 vendored crates, 4 wasm crates, 19 files); `nix build --rebuild`: identical output |
| `midstudy-node-modules-build` | 196 packages (as `npm ci` in a checkout); fetched 201 tarballs, the 61 foreign-platform ones not; no `[esbuild]` download message in the log |
| `midstudy-node-modules-runtime` | 65 packages (the lock's non-dev set), 156 MB; closure 369 MiB (Node 22 is most of the rest) after dropping npm's hidden lockfile (411 MiB before: the tarballs) |
| `midstudy-app` | built in 8 s; `planner/dist/` against the checkout's `npm run build`: 18 of 19 files byte-identical, the web `.wasm` differs (rustc's source paths); install check passes |
| `midstudy-add` | built; `--help`; by hand in strict mode, fal mocked, a scratch library: an Idol add from `fixtures/scenes/living-wide/photo.jpg` (262,144 splats, 3.1 MB spz), `SheenChair.glb` and `cube-obj.zip` with `--engine glb` (obj2gltf + cesium) |
| `midstudy-calib` | built (3 min 45 s, torch-bin's macOS wheel downloaded); install checks pass (help, `serve --help`, 19 imports, the schemas) |
| `moge-weights` | built from the FOD path added from the HF cache; the path matched (hash right); no download |
| `midstudy` | built; `--help`; closure 4.4 GiB on darwin (torch, weights, clang through Python on darwin) |

Run (both through `scripts/eval-lock.mjs`; the first waited 16 min behind an exclusive E17 A/B):

- `smoke.mjs <midstudy-web>` (calib mocked): **23/23**. `smoke.mjs <midstudy-web> --real` (MoGe-2 on MPS through the
  packaged worker): **25/25**, first photo 4.3 s, second 2.5 s, one worker pid for both. Details in HANDOFF §5.
- HANDOFF §9 step 6 as written (`--device mps`): `run` 4.9 s (fov 62.48, height 1.185, pitch −9.32, roll −0.05);
  `serve` with two `fit` requests: 3.88 s, then 1.76 s.

Evaluated only:

- `nix flake check --no-build --all-systems`: ok (all packages, both shells for both systems, the module, the VM test).
- An x86_64-linux `nixosSystem` with the module (§6 values, `calibDevice` cuda and auto): toplevel `.drv` evaluates,
  no warnings, ExecStart as in HANDOFF §5. torch-bin's Linux `.drv` is still nook's (`mlhz62jx…`).
- The Linux npm sets: esbuild's and oxc's linux-x64 binaries are the only platform packages fetched (oxc's musl builds
  among them: the lock has no libc field to tell them apart).
- `nix develop -c true` and `nix develop .#nightly -c true`: both shells still work.

## Decisions

- **Two derivations for the build, not one**: the wasm (Rust) and the tree (Node) build separately, so a TypeScript
  change doesn't recompile the kernels (55 s) and the runtime npm set (156 MB) only changes with the lockfile.
- **`scripts/build.mjs` runs in Nix** (`--wasm-only`, then `--planner-only`) instead of re-stating its cargo,
  wasm-bindgen, wasm-opt and esbuild options in Nix: one place for the flags, a new `wasm-*` crate needs no Nix change.
- **importNpmLock, not fetchNpmDeps**: no `npmDepsHash` to update whenever `package-lock.json` (shared-append) moves.
  `importCargoLock` likewise for `core/Cargo.lock` (no git dependencies, so no `outputHashes`).
- **A copy of the build packages, not a symlink**: esbuild follows a `node_modules` link to its real path; the source
  maps then named `../../../../../../../store/…` and the chunks' hashed names changed. From a copy the bundle is the
  checkout's byte for byte (all 18 JS, map and decoder files; the web `.wasm` differs only in rustc's recorded source
  paths). The copy costs a few seconds.
- **The repository layout in the store**: every module finds its neighbours relative to itself (`core/js/*.ts`,
  `server/src/product/sizes.ts`, `server/src/main.ts`'s `REPO`), so the tree keeps it rather than patching paths.
- **Node 22 from nixpkgs (`nodejs_22`, 22.23.4)**, not `nodejs-slim_22`: the runtime npm packages' patched shebangs
  name `nodejs_22` anyway, and slim saves 25 MiB.
- **The module passes `--midstudy-add` itself**, as it already passed `--calib`.
- **Options unchanged** (the task); `main`'s nullable `dailySpendUsd` (`fc82c5c`) is left for the port of `main` with
  the server feature it needs (HANDOFF R7).
- **fal-client.nix deleted** rather than kept unused.

## Seen while working (not mine to fix)

- stdenv's `audit-tmpdir` hook on darwin twice printed a crash of its classifier loop (`Segmentation fault: 11` in
  `midstudy-wasm`'s first build, `Broken pipe: 13` in `midstudy-node-modules-runtime`'s); that loop runs in the
  background and its exit isn't checked, so the builds went on, and on darwin it has no ELF files to audit anyway.
  nixpkgs' stdenv, not this packaging.
- An exclusive E17 A/B (`rf-verify-rigor`) held all three eval-lock slots for a while; the smoke runs waited for it.

## Requests (also HANDOFF §13)

- R1–R3 (calib), R4 (server), R5 (evals): unchanged from v1 in substance, renamed for v2; R5's HEIC half is done (the
  HEIC case skips without `sips`).
- R6 (foundation): README.md still says the Nix packages are v1's.
- R7 (finish): port `fc82c5c`'s `nix/module.nix` hunk by hand with the server's settings route.

## Not done here

- Anything on Linux: no x86_64-linux builder on this Mac (`/etc/nix/machines` is empty), and the Mac's daemon builds
  without a sandbox, so "builds on the Mac" says nothing about network access in a Linux sandbox. The code is written
  for it (npm offline from fetched tarballs, `CARGO_NET_OFFLINE`, vendored crates), but untried.
- The VM test (evaluated only), CUDA, homeserver, any live fal call.
