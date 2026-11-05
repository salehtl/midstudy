# f-toolchain (v2 Phase 1)

This track adds the toolchain and the build and check machinery that the other v2 tracks build on (docs/REFACTOR.md
§1–§3). It runs on branch `v2-f-toolchain`, forked from `v2` at `0d40ff5`. Everything here was measured on rabbit on
2026-11-05. The Mac was shared with other agents throughout, so every time below was taken under load.

## What exists now

| Piece | Files | Check it |
|---|---|---|
| Dev shells | `flake.nix`, `flake.lock` (adds `rust-overlay`), `nix/toolchain.nix` | `nix develop -c true`; `nix develop .#nightly -c cargo miri --version` |
| TScert | `nix/tscert.nix`, `scripts/tscert.mjs`, `scripts/tscert-ratchet.mjs`, `tscert/` (config, baseline, experiments, **README.md: the guide**) | `nix develop -c npm run check:tscert` |
| Kani | `nix/kani.nix` (nightly shell, aarch64-darwin) | `nix develop .#nightly -c cargo kani --version` |
| npm | `package.json` (devDependencies, dependencies, scripts), `.npmrc` (`save-exact=true`) | `nix develop -c npm install` |
| TypeScript | `tsconfig.base.json` (strict) and per area: `tsconfig.{planner,server,pipeline,core-web,core-node,contract}.json`, solution `tsconfig.json` | `nix develop -c npm run check:types` |
| Lint, dead code | `eslint.config.js`, `knip.json` | `check:lint`, `check:dead` |
| Build | `scripts/build.mjs`, `core/.cargo/config.toml` (SIMD128), `core/Cargo.toml` (wasm-bindgen pin, cfg lints), `planner/index.html` (bundle, no importmap) | `nix develop -c npm run build` |
| Checks | `scripts/check.mjs`, `scripts/pyright/pyrightconfig.json` | `nix develop -c npm run check` |

### Versions pinned

| Tool | Version | From |
|---|---|---|
| nixpkgs | `1f607aa7` (nixos-26.05) | unchanged |
| rust-overlay | `19e0e6c9` (2026-11-05) | flake input, follows nixpkgs |
| Rust (default shell) | 1.95.0: rustfmt 1.9.0, clippy 0.1.95, rust-src, llvm-tools, wasm32-unknown-unknown | rust-overlay `stable."1.95.0".minimal` |
| Rust (`.#nightly`) | nightly-2026-08-21 (rustc 1.100.0-nightly 8925ea358): miri, rust-src, llvm-tools, rustc-dev, rustfmt, clippy | rust-overlay; the nightly Kani 0.68.0 pins |
| wasm-bindgen-cli | 0.2.121 (`wasm-bindgen-cli_0_2_121`) | nixpkgs |
| binaryen (wasm-opt) | 129 | nixpkgs |
| cargo-fuzz | 0.13.1 | nixpkgs (both shells) |
| Kani | 0.68.0 (CBMC 6.11.0) | release bundle, fixed-output fetch (`nix/kani.nix`) |
| Lean (default shell) | 4.29.1 (`nix/lean.nix` replaces it when the proofs track adds one) | nixpkgs `lean4` |
| pyright, ruff | 1.1.411, 0.15.14 | nixpkgs |
| TScert | `1c8abcf2` with Node 26.13.0, Lean 4.33.1, OCaml 5.4.1, dune 3.21.1, TypeScript 7.0.2 | `nix/tscert.nix` (tscert/README.md) |
| npm devDependencies | typescript 5.9.3, esbuild 0.28.2, @types/node 22.20.5, @types/three 0.180.0, eslint 10.14.0, typescript-eslint 8.72.1, knip 6.44.1, @sparkjsdev/spark 2.4.0 | exact |
| npm dependencies (Phase 2) | @gltf-transform/{core,extensions,functions} 4.5.1, obj2gltf 3.2.0, fflate 0.8.3, libheif-js 1.23.5, parse5 8.1.0 | exact |

The default shell keeps python312, uv, nodejs_22, git and the `UV_` settings. Nothing is installed into `~`: there is
no rustup, elan or nvm. Cargo still keeps its registry cache in `~/.cargo` as usual. The Miri sysroot goes to
`build/miri/`, fuzz corpora and crashes go to `build/fuzz/`, and TScert's build is a store path linked from
`build/tscert/result`.

## Commands

```sh
nix develop -c npm install                 # once
nix develop -c npm run build               # wasm (when core/crates/wasm-{web,node} exist) + planner/dist; a no-op in ms
nix develop -c npm run check               # every gate, one line each; exit 1 on any failure
nix develop -c npm run check:types         # and check:lint, check:dead, check:gen, check:tscert, check:rust,
                                           #     check:fuzz, check:proofs, check:py, check:ownership
nix develop -c node scripts/tscert-ratchet.mjs --files planner/logic/x.ts   # try a module with TScert
nix develop .#nightly -c cargo miri test -p <crate>     # by hand; check:rust does it for core/miri.txt's crates
nix develop .#nightly -c cargo kani -p <crate>          # by hand; check:rust runs every #[kani::proof]
MIDSTUDY_FUZZ_SECONDS=60 nix develop -c npm run check:fuzz
```

`npm run serve` now runs the build first, through a new `preserve` script. `planner/index.html` loads `./dist/app.js`,
so a server whose planner was never built serves a page with no script.

## The build (`scripts/build.mjs`)

- **Planner.** esbuild bundles `planner/main.ts`, or `planner/main.js` until main.ts exists. three 0.180.0 and Spark
  2.4.0 come from `node_modules`, and there is no importmap. Output in `planner/dist/`: `app.js`, content-hashed
  chunks, `assets/`, linked sourcemaps and `*.LEGAL.txt`. Minified, targets `es2022` and `safari16`. `.js` import
  specifiers resolve to `.ts` files. Files named `*.worker.ts` under `planner/` or `core/js/` become their own entries
  (`planner/dist/<name>.worker.js`; create one with `new Worker(new URL('./<name>.worker.js', import.meta.url),
  { type: 'module' })`). The `.wasm` files in `build/wasm/web/` are copied next to the chunks, so wasm-bindgen's own
  `new URL('<lib>_bg.wasm', import.meta.url)` resolves. three's Draco and Basis decoders are copied to
  `planner/dist/libs/{draco/gltf,basis}/`.
- **Spark** inlines its worker and its wasm (a blob worker and a data URL), so no extra files are needed. The lazy
  `import('@sparkjsdev/spark')` becomes a chunk of its own.
- **Today's bundle:** `app.js` 349 kB, a three.js chunk of 535 kB, the Spark chunk 2.8 MB, 34 inputs. A cold build
  takes 161 ms and a no-op 4–9 ms (38 ms for the whole `node` process). The build prints a warning for the one CDN URL
  left in the bundle: `planner/engine.js` THREE_LIBS (see requests).
- **wasm.** When `core/crates/wasm-web` or `core/crates/wasm-node` exists, the build runs `cargo build --release
  --target wasm32-unknown-unknown`, with `+simd128` coming from `core/.cargo/config.toml` (`rustc --print cfg` confirms
  `target_feature="simd128"` next to bulk-memory, multivalue, mutable-globals, nontrapping-fptoint, reference-types and
  sign-ext). Then wasm-bindgen runs with `--target web` into `build/wasm/web/` and with `--target
  experimental-nodejs-module` (Node ESM) into `build/wasm/node/`, and finally `wasm-opt -O3` with exactly those
  features. File names are wasm-bindgen's: `<lib>.js`, `<lib>.d.ts`, `<lib>_bg.wasm` and `<lib>_bg.wasm.d.ts`. Tested
  on probe crates in a scratch copy (none committed): the cold build took 18 s including cargo, a no-op took 6 ms,
  `import('./build/wasm/node/wasm_node.js')` ran `add(2,3) = 5` under Node 22, and the bundle imported the web build.
- **Incremental and safe to run concurrently.** Each step keeps a stamp of its inputs in `build/stamps/`: the
  metafile inputs of the bundle, the Rust sources, and the real paths of the tools. A lock directory per step makes a
  second concurrent run wait and then find the stamp current. Every output file is written to a temporary name and
  renamed into place, chunks and `.wasm` files before the entry or JS glue that names them, and the stamp last. Files
  from an older build are deleted only once they are 10 minutes old. Options: `--force`, `--planner-only`,
  `--wasm-only`, `--quiet`.

## The checks (`scripts/check.mjs`)

Each check prints one line, `check:<name>: ok|FAIL — <what> (<s>)`, with the tool's output above it only on failure or
with `--verbose`. An area that does not exist yet passes as "nothing to check". The order is ownership, gen, types,
lint, dead, tscert, py, rust, fuzz, proofs.

| Check | What it runs | Today, on this branch |
|---|---|---|
| types | `tsc -b` over each `tsconfig.<area>.json` that has `.ts` files; builds the wasm first when `core/js` has TS | ok, nothing to check (probe .ts files in the planner and server areas passed: `.js` specifiers resolved to `.ts` in the planner, `.ts` specifiers in the server, and `node server/src/probe.ts` ran directly) |
| lint | `eslint . --max-warnings 0`: strict-type-checked + stylistic-type-checked; `no-explicit-any`, `no-non-null-assertion`, `consistent-type-assertions: never` (`as const` allowed), `ban-ts-comment` on ts-ignore/ts-expect-error/ts-nocheck | ok, nothing to check (probe file: all 5 planted violations reported, `as const` not) |
| dead | `knip --no-config-hints` | ok |
| gen | `scripts/gen-contract.mjs`, then `git diff` and untracked files in `contract/gen/` | ok, nothing to check (no script yet) |
| tscert | `scripts/tscert-ratchet.mjs` | ok, nothing to check (scratch copy with logic modules: pass, `--update`, then a planted regression → exit 1) |
| py | pyright in strict mode (calib's own `[tool.pyright]` when it has one, else `scripts/pyright/pyrightconfig.json`) and `ruff check` on `calib/`; `uv sync --project calib --frozen` first when there is no venv | **FAIL: 1297 pyright-strict errors, 7 ruff errors on v1 calib** (the calib track is typing it) |
| rust | `cargo fmt --check`, `clippy --workspace --all-targets -- -D warnings`, `cargo test`; Miri through `.#nightly` on the crates in `core/miri.txt` (sysroot in `build/miri/`); `cargo kani` when a `#[kani::proof]` exists | ok, nothing to check (probe workspace: fmt caught an unformatted file; then fmt, clippy, 1 test, Miri on `media` and Kani all passed in 50 s) |
| fuzz | for each `fuzz/Cargo.toml` under `core/`: every `cargo fuzz list` target for `MIDSTUDY_FUZZ_SECONDS` (default 60), new corpus and crashes in `build/fuzz/`, the tracked corpus read as seeds | ok, nothing to check (probe target: 10 s, no crash) |
| proofs | `lake build` in `proofs/`; no `sorry`/`admit` (comments and strings stripped), no `axiom` missing from `proofs/axioms.txt`, no "declaration uses 'sorry'" | ok, nothing to check (probe Lean project with Lean 4.29.1: ok in 1.8 s; a planted `sorry` and `axiom` → FAIL, exit 1) |
| ownership | `scripts/check-ownership.mjs` for `MIDSTUDY_TRACK`, else the track of a `v2-<track>` branch | ok (f-toolchain) |

## Go / no-go

| Tool | Verdict | Evidence |
|---|---|---|
| TScert | **go** | Built in the Nix sandbox at `1c8abcf2` in 5 min 21 s (8 min after the patch). 103 of 126 experiment functions certify (14 s). The ratchet passes, rewrites the baseline, and fails on a planted regression. One documented patch makes the sandboxed runs work (tscert/README.md). Running it directly as the user was refused by this session's permission classifier, so `check:tscert` always uses the sandbox. |
| Miri | **go** | `nix develop .#nightly -c cargo miri --version` → `miri 0.1.0 (8925ea358a 2026-08-20)`. A probe crate's tests ran under Miri: 1 passed. |
| cargo-fuzz | **go** | 0.13.1 on nightly-2026-08-21 with ASan on aarch64-darwin: a probe `be16` target ran 10 s without a crash. |
| Kani | **go** (aarch64-darwin) | Release bundle 0.68.0 (109 MB, fixed-output) with its `toolchain` link pointed at rust-overlay's nightly-2026-08-21. kani-compiler loads `librustc_driver` through `@loader_path/../toolchain/lib`. `cargo kani --version` → "Kani Rust Verifier 0.68.0 (cargo plugin)". A probe harness gave `VERIFICATION:- SUCCESSFUL`, 1 of 1 verified. Packaging took about 30 minutes, most of it downloading the nightly. cbmc-viewer (`--visualize`) is not included, and Linux is not packaged. |
| Aeneas + Charon | **no-go within the time box** | `nix build github:AeneasVerif/aeneas/4acbb6d7#aeneas …#charon` ran 62 min (21:42–22:44), fetched 436 store paths and was still building Charon's vendored crates (crane, nightly-2026-09-17 with rustc-dev) when it stopped ("interrupted"). No binary was produced, so there is no `.#proofs` shell. A later run resumes from the cached paths. Aeneas's CI pulls prebuilt paths from `hacl.cachix.org`, but trusting that substituter is a machine-wide Nix setting (`determinateNix.customSettings` in the rabbit flake), which only the user can change. Aeneas's Lean library pins **Lean v4.35.0** (`backends/lean/lean-toolchain`) with Mathlib `56a00585` (tag v4.35.0); Charon pins `6cc2b5f8` and nightly-2026-09-17. |

## Decisions

- **Rust through rust-overlay's `mkRustBin`** (no overlay re-import of nixpkgs). Both toolchains use the `minimal`
  profile plus the requested components, so rust-docs is not downloaded.
- **One nightly for Miri, cargo-fuzz and Kani**: the one Kani 0.68.0 pins (nightly-2026-08-21), so Kani works without
  rustup. It has miri for aarch64-apple-darwin.
- **TScert as Nix derivations**, not a script that builds into `build/tscert/`. The classifier refused the script
  route and allowed the sandbox. The sandbox is also hermetic and caches unchanged results.
- **TScert's Node and Lean are its pins (26.13.0, 4.33.1)**, fetched from the official archives, not nixpkgs' 26.12.1
  and 4.29.1. Its "trusted inputs" suite rejects any other Node.
- **Per-function units** for the ratchet. Whole-file checks blamed refusals on the wrong function (tscert/README.md).
- **`docs/notes/tscert.md` lives at `tscert/README.md`**: `scripts/ownership.json` gives that docs path to no track.
- **check:types builds only areas that have `.ts` files**: `tsc -b` refuses an empty project (TS18003). The planner
  area has `allowJs` with `checkJs` off, so TS can import the legacy JS without type-checking it. `core/js` is two
  areas, `core-web` (DOM, bundler) and `core-node` (Node, nodenext), because one tsconfig cannot hold both.
  `composite` with `noEmit` builds fine with TS 5.9.3.
- **knip** ignores `planner/**/*.js` (37 unused exports in v1 code that is deleted at cutover) and lists the seven
  Phase 2 dependencies in `ignoreDependencies` until they are imported. Once they are, knip hints that the entries
  can go.
- **check:py fails today on purpose.** It is strict on all of `calib/` (src, tests, scripts) unless calib sets its own
  `[tool.pyright]`.
- **Lean 4.29.1 in the default shell is large**: a 608 MiB download and 2.4 GiB unpacked. The first
  `nix develop -c true` on this Mac took 41 minutes because of it. It is cached now (0.7 s).

## Measurements

| What | Value |
|---|---|
| First `nix develop -c true` (cold, shared network) | 41 min, mostly lean4 4.29.1; afterwards 0.7 s |
| `nix develop .#nightly` (cold) | 14 s once Kani's build had fetched the nightly |
| Planner bundle: cold build / no-op | 161 ms / 4–9 ms |
| Probe wasm build: cold / no-op | 18 s / 6 ms |
| TScert build (sandboxed) | 5 min 21 s (first), 8 min 7 s (after the patch) |
| TScert experiments (126 functions, 20 files) / an unchanged re-run | 12–20 s / under 1 s (store hit) |
| check:rust on the probe workspace (fmt, clippy, test, Miri setup + test, Kani) | 50 s |
| Planner load to `midstudy.ready`, v1 vs bundle (golden living-wide, fresh context per run, 5 runs each, interleaved, `--exclusive` lock, load average 14–20) | v1 median **1631 ms** (4366 for the first, cold CDN; then 1623, 1631, 1614, 1640), 52 requests, 12 to jsdelivr. Bundle median **1584 ms** (1598, 1584, 1600, 1563, 1578), 21 requests, none to a CDN. Bytes: 1384 kB vs 1402 kB, because jsdelivr compresses and serve.py does not. |

On page load alone the bundle is about 3 % faster once the CDN is warm, and 2.7× faster than the first, cold-CDN load
of v1. Most of the remaining time is in the page itself (SwiftShader WebGL setup, the scene and its depth), so the
§4.1 "≥ 40 % faster cold load" target needs more than bundling. f-perf's E17 measures it properly. How this one was
measured (a one-off script, not committed): one `startServer` from the harness, then playwright either loaded
`/planner/` as built or answered `/planner/` with v1's `index.html` (`git show 0d40ff5:planner/index.html`, so the
legacy `main.js` and jsdelivr loaded), alternating the two.

## Evals

With the bundled planner (`planner/index.html` → `dist/app.js`, built by `node scripts/build.mjs`), each run through
`node scripts/eval-lock.mjs -- npm run eval:…` in the dev shell, 2026-11-05 23:33–23:50. These evals have no build
step in their harness yet (f-contract adds it), so the bundle was built first. Every eval passed on its first run:

| Eval | Result | Time |
|---|---|---|
| eval:selftest (H0) | 22/22 | 7.8 s |
| eval:planner (E3) | 55/55 | 40.0 s |
| eval:occlusion (E4) | 20/20 | 11.9 s |
| eval:floor (E5) | 34/34 | 26.1 s |
| eval:render (E6) | 36/36 | 59.1 s |
| eval:phone (E9) | 48/48 | 36.7 s |
| eval:ux (E11) | 28/28 | 54.6 s |
| eval:ux2 (E12) | 26/26 | 46.6 s |
| eval:splat (E13) | 50/50 | 90.0 s (Spark from the bundle's lazy chunk) |
| eval:product-ui (E15) | 134/134 | 33.9 s |
| eval:lighting (E16) | 56/56 | 90.9 s |

## Requests to other tracks

- **engine (Phase 2)**, `planner/engine.js` line 617: replace
  `const THREE_LIBS = 'https://cdn.jsdelivr.net/npm/three@0.180.0/examples/jsm/libs/'` with
  `const THREE_LIBS = new URL('libs/', import.meta.url).href`. The decoders are already in `planner/dist/libs/`, and
  chunks sit at the root of `planner/dist/`, so the relative URL resolves from any chunk. After that, the build's
  CDN warning disappears.
- **f-contract**: as planned, the harness runs `node scripts/build.mjs` before it starts a server. The entry point and
  its exit code (0 ok, 1 failed) are stable, and concurrent runs are safe.
- **main session (Phase 0 scripts)**: `scripts/eval-lock.mjs --exclusive` keeps the slots it already has while it waits
  for the rest, so two exclusive waiters deadlock. Observed from 22:49 to 23:14: f-perf held slots 0 and 2, k-media
  held slot 1, both were `--exclusive` and waiting, and every non-exclusive eval queued behind them until k-media's
  `--wait-min 20` ran out. After that, f-perf kept slots 0 and 2 while still waiting, so every other eval in the
  repository shared the single remaining slot for as long as f-perf waited. This branch's first eval queued from
  22:48 and got a slot at about 23:40. An exclusive waiter should release whatever it holds after each failed round, or take
  all slots or none.
- **main session / ownership**: `core/miri.txt` (the crates Miri checks, one per line) and `proofs/axioms.txt` (allowed
  axioms) are owned by no Phase 1 track. They could go to kernels-hardening or k-media, and to proofs.
  `docs/notes/tscert.md` could become a pointer to `tscert/README.md`.
- **k-media, k-geom (kernels)**: the wasm crates need `[lib] crate-type = ["cdylib", "rlib"]` and `wasm-bindgen =
  "=0.2.121"` (or `{ workspace = true }`). The workspace lints, `unsafe_code = "forbid"` included, accept
  `#[wasm_bindgen]`: a probe glue crate passed clippy -D warnings natively and for wasm32. Mark Kani harnesses
  `#[cfg(kani)]`; the workspace already declares `cfg(kani)` and `cfg(fuzzing)`. A cargo-fuzz directory (`core/fuzz/` or `core/crates/<c>/fuzz/`) needs an empty
  `[workspace]` table in its `Cargo.toml`.
- **calib**: put `[tool.pyright]` (`typeCheckingMode = "strict"` and its includes) and any `[tool.ruff]` rules in
  `calib/pyproject.toml`. check:py uses them in place of `scripts/pyright/pyrightconfig.json`.
- **proofs**: if Mathlib needs another Lean (Aeneas pins 4.35.0), add `nix/lean.nix` returning that Lean. The default
  shell picks it up through `builtins.pathExists`.
- **webgpu-spike**: `planner/gpu/**` belongs to the planner TS area. WebGPU types need `@webgpu/types`; add it to
  `package.json` (shared-append) and to `tsconfig.planner.json` `types` through a request.
- **packaging (Phase 4)**: `nix/midstudy.nix` has to run the build and ship `planner/dist/`.
- **integration (Phase 3)**: remove `planner/**/*.js` from knip's `ignore` at cutover, and drop each
  `ignoreDependencies` entry once it is imported.

## What's left

- Aeneas and Charon (no-go above); the `.#proofs` shell.
- Linux: the hash of TScert's Linux `node_modules` is a placeholder; Kani is aarch64-darwin only.
- check:py stays red until calib's typing lands.
