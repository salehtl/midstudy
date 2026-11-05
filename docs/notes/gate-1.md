# gate-1 (v2 Phase 1 merge gate)

The five Phase 1 tracks merged into `v2` (worktree `.claude/worktrees/rf-main`), made to work together, and checked:
every `check:*`, `eval:all` four times (twice before the last fix, twice on the tree as committed), the self-test,
the calibration ingest, the golden scenes and E17. Everything below was run by gate-1 on rabbit on 2026-11-06
(00:05–01:30), fal mocked, headless Chrome from `$PUPPETEER_EXECUTABLE_PATH` (147.0.7727.15, chrome-headless-shell),
never Helium. Nothing was pushed.

## What merged

`git merge --no-ff`, in this order, onto `v2` at `c81375a`:

| # | Branch | Tip | Merge | Conflicts |
|---|---|---|---|---|
| 1 | `v2-f-toolchain` | `e73eb15` | `0fc6c35` | none |
| 2 | `v2-f-contract` | `fb8053c` | `d4929a0` | `package.json` (shared-append): f-contract's three scripts (`gen:contract`, `test:contract`, `contract:examples`) added to f-toolchain's |
| 3 | `v2-k-media` | `cb444c5` | `14be339` | `core/Cargo.lock` (shared-append, add/add): union, below |
| 4 | `v2-k-geom` | `845832c` | `ee1193e` | `core/Cargo.lock` again: union; `proptest`'s dependency list is the union of both (k-media builds it without default features, k-geom with) |
| 5 | `v2-f-perf` | `fc8841f` | `6e35455` | none (`package.json` merged by itself: `eval:perf`) |

Every branch had commits beyond `v2`; none was skipped. Before merging, each branch's changes (`v2...v2-<track>`) were
checked against `scripts/ownership.json` with check-ownership's own rules: 0 paths outside the track for all five
(56, 99, 40, 92 and 5 changed paths). No conflict outside the shared-append files, so no ownership breach to resolve.

**Lockfiles.** `core/Cargo.lock` is the union of f-contract's (28 packages), k-media's (33) and k-geom's (73): every
`[[package]]` with its dependency references resolved to exact versions inside its own lock, written back
(`syn` 2.0.119 + 3.0.9 and `cpufeatures` 0.2.17 + 0.3.1 appear twice, so their references carry the version).
`cargo metadata` accepted it unchanged, and `cargo generate-lockfile` (the regeneration the gate asks for) produced a
byte-identical file: 92 packages (86 + the 6 workspace crates), no version moved. `package-lock.json` came only from
f-toolchain; `npm ci` accepted it and `npm install` left it unchanged.

## What gate-1 changed, and why

| File | Change | Why |
|---|---|---|
| `scripts/build.mjs` | Find each wasm crate's package by its manifest path (`core/crates/<dir>/Cargo.toml`) and pass that name to `cargo build -p` and the cdylib lookup | `npm run build` failed on the merged tree: it passed the directory names (`-p wasm-web -p wasm-node`), but the packages are `midstudy-wasm-web` and `midstudy-wasm-node` ("package ID specification `wasm-node` did not match any packages"). f-toolchain had tested on probe crates named after their directories. |
| `core/js/web.ts` | `v === undefined ? Number.NaN : v` → `v ?? Number.NaN` (line 103); `v && v.length === 32` → `v?.length === 32` (line 159) | check:lint failed on these two (`prefer-nullish-coalescing`, `prefer-optional-chain`): k-geom had no eslint config on its branch. Same behaviour (`v` is `number \| undefined` and `Float64Array \| null`); k-geom's tests re-run after the change: worker 8/8, v1-sync 28/28, diff 49/49, browser 10/10. |
| `eslint.config.js` | Ignore `core/crates/` | check:lint failed with 5 "not found by the project service" errors: the kernels' TS test harnesses (`core/crates/wasm-node/js-test/*.ts`, `core/crates/wasm-web/tests/**/*.ts`) belong to no tsconfig area. Adding them to the core areas instead gave 62 strict-type-checked errors (they import v1's untyped `.mjs`), so they stay test code judged by their own runs; the faces they test (`core/js/*.ts`) are linted. |
| `knip.json` | Ignore `contract/gen/**` | check:dead failed: `contract/gen/{types.ts,validate.d.ts,routes.d.ts}` are "unused files" until Phase 2 imports them. f-contract asked for this (generated code; `validate.js` is Ajv output). |
| `scripts/check.mjs` | check:gen also diffs `core/crates/contract/schema.json` | The generator writes two places, the check diffed one: a stale Rust bundle passed. Negative control: a stale `schema.json` in the index → FAIL; restored → ok. (f-contract's request was `gen-contract.mjs --check`; this keeps check:gen's "equal to what is committed" meaning.) |
| `evals/lib/harness.mjs` | `ensureBuilt(ev)` reports the build as a check only when `ev.check` is a function; otherwise a failed build goes to stderr | E17 failed on the merged tree: every metric that starts a server died with "ev?.check is not a function" (`eval:perf` exit 1 after 14 s). E17 passes the harness a plain `{out, onCleanup}`, which is all v1's `startServer` used; f-contract's new `ensureBuilt` called `ev?.check(…)`, which guards a missing `ev` but not a missing `check`. Real evals get exactly the same check as before. |
| `scripts/wasm-smoke.mjs` (new) | Smoke test of both faces on the official build, in Node and in headless Chrome | The gate's "must load them" check, kept so later gates can re-run it (below). |

Not changed, on purpose: **wasm-node is ESM, and that works.** f-toolchain's build runs wasm-bindgen
`--target experimental-nodejs-module` (ES module, `readFileSync` of the `.wasm`, no top-level await), while k-media
asked for `--target nodejs` (CommonJS) because `core/js/node.ts` loads the module with `createRequire()`. Node 22.23
(the dev shell's) loads a synchronous ES module through `require()` without a flag or a warning, so node.ts works on the
official build unchanged: k-media's face tests 11/11 on it (the GPS-canary byte-equality test included, once the
differential corpus existed), and the smoke test. Its error message still names the stopgap `build-node.sh`; the
stopgaps `core/crates/wasm-node/build-node.sh` and `core/crates/wasm-web/build-web.sh` (nixpkgs rustc) are redundant
now: `npm run build` is the build.

## Shells, install, build

| Step | Result |
|---|---|
| `nix develop -c true` | ok, 0.6 s: rustc 1.95.0, cargo 1.95.0, wasm-bindgen 0.2.121, wasm-opt 129, cargo-fuzz 0.13.1, Lean 4.29.1, pyright 1.1.411, ruff 0.15.14, node 22.23.4, Python 3.12.14, uv 0.11.21, `tscert` |
| `nix develop .#nightly -c true` | ok, 0.4 s: rustc 1.100.0-nightly (8925ea358 2026-08-20), miri 0.1.0, Kani 0.68.0 (CBMC 6.11.0), cargo-fuzz 0.13.1 |
| `.#proofs` shell | does not exist (Aeneas/Charon no-go, below); the proofs track's `nix/lean.nix` is not merged |
| `nix flake check --no-build --all-systems` | ok, all 20 outputs evaluate (nothing built) |
| `npm ci` | ok, 213 packages (9 moderate `npm audit` advisories, not triaged) |
| `npm run build` (after the fix) | ok, 16 s cold: `cargo build --release --target wasm32-unknown-unknown --locked -p midstudy-wasm-web -p midstudy-wasm-node` (14.7 s), wasm-bindgen, wasm-opt; `build/wasm/web/midstudy_wasm_web{.js,.d.ts,_bg.wasm}` (wasm 176 KB) and `build/wasm/node/midstudy_wasm_node{.js,.d.ts,_bg.wasm}` (wasm 114 KB, ESM); `planner/dist/app.js` 349 kB + 2 chunks, `midstudy_wasm_web_bg.wasm` copied beside them, the decoders in `dist/libs/`. One warning: the CDN URL in `planner/engine.js` THREE_LIBS (engine's, Phase 2) |
| `node scripts/wasm-smoke.mjs` | ok, 12/12 (below) |
| `node scripts/gen-contract.mjs`, then `--check` | 76 types from 43 schemas, no diff; `--check` up to date |

**Smoke test** (`nix develop -c node scripts/wasm-smoke.mjs`, after `npm run build`):
node.ts on `build/wasm/node`: `sniff`, `jpegIsClean`, `stripJpeg` (a planted APP1 removed, the golden photo back
byte for byte), `jpegFrame` 1600×1200, slugs and `normalizePath`. web.ts on `build/wasm/web` in Node
(`loadKernelsSync`): `SceneCamera.floorToPhoto` of living-wide's 16 truth corners within 5.62e-4 px of `corner_px`
(the file rounds to 1e-3), `photoToFloor`, `decodeDepth` 1024×768. The same page bundled by esbuild in headless Chrome
147 (`loadKernels` over fetch): no page error, and every number equal to Node's (projections, floor point, depth sum,
a clamp). The page also asked for a WebGPU adapter with the harness's flags (`--enable-unsafe-webgpu
--use-webgpu-adapter=swiftshader`) on `http://127.0.0.1`: it got one (adapter vendor "google"; the flag selects
Dawn's SwiftShader adapter, software, no real GPU). So WebGPU is a browser setting away in headless Chrome; what keeps
the planner on WebGL is its own code (Spark 2.4 is WebGL2-only, the occlusion, photo and shadow passes are GLSL), which
is the webgpu-spike track's work (REFACTOR §1).

Also re-run on the official build: k-media's face tests 11/11 and its differential test against v1 (seed 7, 102,349
cases, every difference an expected one); k-geom's worker 8/8, v1-sync 28/28, differential 49/49 groups, and its
headless-Chrome test 10/10.

## Checks

`MIDSTUDY_TRACK=gate-1 nix develop -c npm run check` on the tree as committed (7 min 42 s; each check was also run on
its own while fixing):

| Check | Result |
|---|---|
| check:ownership | ok (gate-1 owns `**`) |
| check:gen | ok: contract/gen and core/crates/contract/schema.json are what the schemas generate |
| check:types | ok: no errors in core-web, core-node, contract (no .ts yet in planner, server, pipeline) |
| check:lint | ok: 2 .ts files (core/js), no problems (after the fixes) |
| check:dead | ok: knip, no unused files, exports or dependencies (after the fix) |
| check:tscert | ok, nothing to check (no `logic/` module yet) |
| check:py | **FAIL** (expected, calib's): pyright strict 1297 errors, ruff 7 (E741) on v1 calib |
| check:rust | ok: fmt, clippy `-D warnings`, 134 tests (38 s the first time, 14 s at the end); Miri not run by the check (no `core/miri.txt`), no Kani harness yet |
| check:fuzz | ok, twice (455 s, then 441 s): 7 targets × 60 s on the nightly with ASan (cargo-fuzz's default), no crash: glb_strip, host_check, jpeg_strip, path_normalize, png_strip, decode_png, mask_and_env |
| check:proofs | ok, nothing to check (no `proofs/` Lean project on v2 yet) |
| `npm run test:contract` (not in `npm run check`) | ok: node tests 11/11; typecheck: contract/gen and 97 examples |

So `npm run check` exits 1 on v2 today, for check:py alone.

## Evals

Every eval through `nix develop -c node scripts/eval-lock.mjs -- …` (no run had to wait for a slot), with the
defaults: legacy server (`python3 planner/serve.py`) and CLI (`uv run --project pipeline midstudy-add`), the bundled
planner, headless Chrome 147 on SwiftShader. Runs 1 and 2 were on the merged tree before the harness fix, runs 3 and 4
on the tree as committed.

| Eval | v1 at the fork | Run 1 | Run 2 | Run 3 | Run 4 |
|---|---|---|---|---|---|
| E1 scenes-api | 219 | 220/220 | 220/220 | 220/220 | 220/220 |
| E3 planner | 55 | 56/56 | 56/56 | 56/56 | 56/56 |
| E4 occlusion | 20 | 21/21 | 21/21 | 21/21 | 21/21 |
| E5 floor | 34 | 35/35 | 35/35 | 35/35 | 35/35 |
| E6 render | 36 | 37/37 | 37/37 | 37/37 | 37/37 |
| E7 library | 78 | 79/79 | 79/79 | 79/79 | 79/79 |
| E8 pipeline | 72 | 72/72 | 72/72 | 72/72 | 72/72 |
| E9 phone | 48 | 49/49 | 49/49 | 49/49 | 49/49 |
| E11 ux | 28 | 29/29 | 29/29 | 29/29 | 29/29 |
| E12 ux2 | 26 | 27/27 | 27/27 | 27/27 | 27/27 |
| E13 splat | 50 | 51/51 | 51/51 | 51/51 | 51/51 |
| E14 product | 408 (STATUS: 395) | 409/409 | 409/409 | 409/409 | 409/409 |
| E15 product-ui | 134 (STATUS: 117) | 135/135 | 135/135 | 135/135 | 135/135 |
| E16 lighting | 56 (STATUS: 55) | 57/57 | 57/57 | 57/57 | 57/57 |
| `eval:all` | 14 of 14 | **14/14**, 9 min 34 s | **14/14**, 8 min 52 s | **14/14**, 8 min 17 s | **14/14**, 8 min 19 s |

No regression: every check passed in all four runs. Each run has 1,277 checks: v1's 1,264 plus one per eval (all but
E8) that is the harness's new "node scripts/build.mjs builds the planner (once per eval)". "v1 at the fork" is the count
the tracks measured on v1's code at `0d40ff5` (f-contract: E1, E7, E8, E14; f-toolchain: the browser evals);
docs/STATUS.md's E14–E16 counts predate `881249b` (product page paste) and `e1b717f` (lighting controls), which added
checks.

| Other | Result |
|---|---|
| `eval:selftest` (H0) | 22/22 (v1 22/22), before and after the harness fix |
| `eval:calib -- --mock` (E2 ingest) | 55/55, 1 SKIP: the three `upper-lounge-camera.jpeg` checks need `fixtures/photos/`, which is git-ignored and exists only in the main checkout (v1's 58/58 was measured there) |
| `check:scenes` | 98/98 |
| `contract/tools/record-examples.mjs --check` (X1) | 83/83: v1's answers on the merged tree, every one matching its schema (f-contract's 82 + the build check) |
| `eval:perf` (E17), once, not exclusive | First try: exit 1 after 14 s (the `ev.check` mismatch above). After the fix: **exit 0**, 391 s, all 32 metrics (no `--with-calib`) with 5 valid samples each (load 6.3 → 15.3 during the edit suite). `--results … --compare evals/perf/baseline.json`: "no regression beyond the allowance". server_start 106 ms (v1 181 ms), API p50 0.34–0.71 ms, product read max 1.80 s (v1 1.76 s), Idol CLI 896 ms (852), planner cold load 1.83 s desktop / 1.79 s phone with 23 / 20 requests and none external (v1 1.80 / 1.76 s, 53 requests, 12 to jsdelivr), scene_open 908 ms (843), render 415 ms, keep-room 767 ms, drag with a splat 3.02 s per move, render with the splat 11.46 s. Not an A/B: the baseline ran at mean load 8.1, this at 9.1. Results kept in `evals/out/gate-1/perf-results.json` (git-ignored). |

## Go / no-go (each confirmed by gate-1 once)

| Tool | Verdict | What gate-1 ran |
|---|---|---|
| TScert | **go** | `tscert-ratchet.mjs --config tscert/experiments/config.json --no-baseline`: 103/126 certified (13 s, as f-toolchain reported). A fresh probe module written for this gate (two functions, a scratch config in `evals/out/gate-1/tscert/`): 2/2 certified in 3 s in the Nix sandbox, and a negative control (`x as number`) refused ("evidence search failed"). check:tscert has nothing to check until `logic/` modules exist. |
| Aeneas | **no-go** (unchanged) | `nix build --dry-run github:AeneasVerif/aeneas/4acbb6d7#aeneas …#charon`: 381 derivations still to build and 123 paths (1.0 GiB) to fetch, i.e. no binary cache for either; f-toolchain's 62-minute build produced no binary. Not rebuilt here: a 1 h+ CPU-bound build would have run beside the gate's evals. |
| Charon | **no-go** (unchanged) | The same dry run: Charon needs nightly-2026-09-17 with rustc-dev and its vendored crates built through crane, none cached. The hacl.cachix.org substituter would need a machine Nix setting only the user can change. |
| Kani | **go** (aarch64-darwin) | A scratch crate depending on `midstudy-media`: `#[kani::proof]` "sniff on any 8-byte head never panics, says JPEG exactly for FF D8 FF and PNG for the signature" verified (264 checks, 0.38 s), and a planted wrong claim (`#[kani::should_panic]`) failed as it must; 4.8 s with compilation. The same harness on 16 bytes reaches sniff's HEIF brand loops and ran > 4 min with CBMC's memory growing, so it was stopped: harnesses over the parsers need small inputs or `#[kani::unwind]` bounds (kernels-hardening). |
| Miri | **go**, with a setting | `cargo miri test --lib` on the nightly (`MIRI_SYSROOT=build/miri/sysroot`, `MIRIFLAGS=-Zmiri-disable-isolation`, `PROPTEST_CASES=4`), no undefined behaviour reported: midstudy-media 43/43 (105 s); midstudy-geom 25/25 (1.4 s); midstudy-raster 16/16 without its three env-map tests (183 s), plus `a_flat_photo_gives_a_flat_map` in an earlier run, while `refuses_bad_buffers` (it renders a full 512×256 half-float map) was still running after 36 min and was stopped. Without `-Zmiri-disable-isolation`, the media crate's first proptest test aborts with "unsupported operation: `getcwd` not available when isolation is enabled" (proptest looks for its regressions file), so check:rust's Miri step (which sets no MIRIFLAGS) would fail as soon as `core/miri.txt` names a crate with proptest unit tests. Fix when adding `core/miri.txt`: `MIRIFLAGS=-Zmiri-disable-isolation` and a small `PROPTEST_CASES`, or `#[cfg_attr(miri, ignore)]` on the proptest blocks. |
| cargo-fuzz | **go** | check:fuzz: 7 targets × 60 s on nightly-2026-08-21 with ASan (the default sanitizer; the kernel tracks had used `-s none` on stable), no crash. |

## Interfaces Phase 2 builds on

**`core/js/web.ts`** (the planner's face of `build/wasm/web/`; esbuild bundles it, `.js` specifiers resolve to `.ts`;
Node runs it directly with type stripping). The build copies `midstudy_wasm_web_bg.wasm` next to the chunks in
`planner/dist/`, so `loadKernels()` with no argument finds it.

- Loading: `loadKernels(source?: InitInput): Promise<void>`, `loadKernelsSync(source: SyncInitInput): void`, `kernelsLoaded(): boolean`.
- Camera (§4.1): `class SceneCamera(block: CameraBlock, width, height)`: `focal()`, `rotation()`, `project(p)`,
  `floorToPhoto(p)`, `photoToFloor(px, py)`, `ray(px, py)`, `horizonAt(px)`, `pitchFromHorizon(py)`,
  `projectMany(points: Float64Array)`, `screenRect(item)`, `hitBox(item, view, x, y, pad?)` → `'hit' | 'miss' | 'behind'`,
  `landingSpot(view, visible, taken)`, `planePointAt(px, py, plane)`, `dispose()`.
- Values and types: `CAMERA_RANGE`, `DEFAULT_CAMERA`, `LOOK_KEYS`; `Vec3`, `Vec2`, `Mat3Elements`, `Sh9`, `CameraBlock`,
  `ItemBox`, `ViewXform`, `Rect`, `Plane`, `LookNumberKey`, `DepthMap`, `KeepRoomMask`, `EnvMap`, `EnvMapOptions`,
  `RgbaImage`, `KernelPort`.
- Functions: `clampCamera`, `clampLook`, `wrapDeg`, `wrapAz`, `roundTo`, `clampElevation`, `rotateBy`, `depthScale`,
  `horizonDragGain`, `horizonDragRow`, `boxCorners`, `worldBounds`, `footprint`, `convexHull`, `pointInHull`,
  `distToHull`, `dragHeight`, `liftPlane`, `dragMove`, `dragLift`, `gripAngle`, `dragRotate`, `rulerRescale`, `azElOf`,
  `dirOf`, `turnBetween`, `rotateSh`, `irradianceAt`, `scaleBands`, `maxBandScale`, `splatGain`, `splatMultiplier`,
  `decodeDepth`, `keepRoomMask`, `dilate`, `envMap`.
- Worker: `serveKernels(port: KernelPort, source?)` in the worker; `class KernelWorker(port)` on the main thread:
  `decodeDepth(png, scale?)`, `keepRoomMask(rgba, w, h, opts?)`, `envMap(photo, w, h, cam, opts?)`,
  `envMapFromImage(blob, cam, opts?)`. No worker entry exists yet: the build bundles any `planner/**/*.worker.ts` (or
  `core/js/**/*.worker.ts`) to `planner/dist/<name>.worker.js`; `planner/engine.worker.ts` would fall under engine's
  `planner/engine.*`.

**`core/js/node.ts`** (Node's face of `build/wasm/node/`, ESM loaded through `require()`): `WASM_MODULE`, `sniff`,
`photoExt`, `FILE_KINDS`; `stripJpeg`, `jpegFrame`, `jpegIsClean`, `jpegPassthrough`; `stripPng`, `pngSize`;
`stripGlb(bytes, { layout?: 'compact' | 'in-place' })`; `decodeImageDataUri(value, 'jpeg' | 'png')`;
`decodeMeta(header, maxLength?)`, `MAX_META_HEADER`; `normalizePath`, `reduceLeadingSlashes`, `staticRoute`; `isSlug`,
`isSceneName`, `isRenderName`, `compareNames`; `contentLength`, `hostName`, `checkHost`, `HOST_DECISIONS`,
`originOk({ xMidstudy, origin, host })`; `zipPlan(entries)`; the error-code tuples `JPEG_ERRORS`, `FRAME_ERRORS`,
`PASSTHROUGH_ERRORS`, `PNG_ERRORS`, `GLB_ERRORS`, `DATA_URI_ERRORS`, `META_ERRORS`, `CONTENT_LENGTH_ERRORS`,
`ZIP_ERRORS`; types `Result<T, E>`, `MediaError<Code>`, `FileKind`, `JpegRemoved`, `Stripped<R>`, `JpegFrame`,
`PngRemoved`, `GlbLayout`, `GlbImage`, `GlbReport`, `StaticRoute`, `HostDecision`, `ZipEntry`, `ZipPlan`.

**`contract/gen/`** (generated by `node scripts/gen-contract.mjs`; never edited by hand):

- `contract/gen/types.ts`: 76 `export type`s, e.g. `SceneDetail`, `SceneObject`, `Scene`, `Camera`, `Look`, `Layout`,
  `LayoutItem`, `Library`, `LibraryItem`, `LibraryJob`, `RenderMeta`, `RenderRequest`, `ProductResult`,
  `ProductRequest`, `PublicCalib`, `Calib`, `Lighting`, `ApiError`, `AddSummary`, `SceneTrash`, `LibraryTrash`, `Spend`.
- `contract/gen/validate.js` + `validate.d.ts`: 65 guards `is<Type>(data): data is <Type>` (one per validated type),
  `validators` by schema URI, `violation(uri: SchemaUri, data) → { schema, path, message } | null`; types `Validator<V>`,
  `ValidationError`, `SchemaUri`. 558 KB: the planner should import only the guards it needs.
- `contract/gen/routes.js` + `routes.d.ts`: `routes`, `matchRoute(method, pathWithQuery) → { route, params } | null`,
  `responseSchema(route, status) → SchemaUri | null`; type `Route`. Strict mode =
  `violation(responseSchema(matchRoute(m, p).route, status), body)` → 500 `contract violation: <schema> <path>`.
- Rust: `midstudy_contract::<Type>` (crate `core/crates/contract`, typify 0.8 on `core/crates/contract/schema.json`).

**Harness** (`evals/lib/harness.mjs`): `MIDSTUDY_SERVER=legacy|next` (`python3 planner/serve.py` | `node
server/src/main.ts`), `MIDSTUDY_ADD=legacy|next` (`uv run --project pipeline midstudy-add` | `node
pipeline/src/cli.ts`), `MIDSTUDY_STRICT=1` whenever either is `next`, `MIDSTUDY_RECORD_API=<dir>`,
`MIDSTUDY_WEBGPU=0` (drops the WebGPU flags), `MIDSTUDY_BROWSER` / `PUPPETEER_EXECUTABLE_PATH`. Exports `SERVER`,
`SERVER_CMD`, `ADD`, `ADD_CMD`, `STRICT`, `SERVER_NAME`, `serverCommand(flags) → { cmd, args }`, `ensureBuilt(ev)`
(runs `scripts/build.mjs` once per eval and counts it as a check), `RECORD_DIR`, `BROWSER`, `BROWSER_ARGS`,
`startServer`, `launchBrowser`, `openPlanner`, … as before. E17 calls `serverCommand()`/`addCommand()` expecting an
argv array; the harness's `serverCommand(flags)` returns `{ cmd, args }` (and throws without flags), so E17 falls back
to its built-in commands, which are the same today.

**Build and checks**: `nix develop -c npm run build` (= `node scripts/build.mjs [--force|--planner-only|--wasm-only|--quiet]`,
exit 0/1, incremental, safe concurrently); `nix develop -c npm run check` and `check:{ownership,gen,types,lint,dead,tscert,py,rust,fuzz,proofs}`
(`MIDSTUDY_TRACK=<track>` for ownership, `MIDSTUDY_FUZZ_SECONDS`, `--verbose`); `npm run test:contract`;
`node scripts/gen-contract.mjs [--check]`; `node scripts/tscert-ratchet.mjs [--update] [--files a.ts --project P]`;
`nix develop -c node scripts/wasm-smoke.mjs [--no-browser]`; every eval through `node scripts/eval-lock.mjs -- npm run eval:…`.

**TScert style guide**: `tscert/README.md` (there is no `docs/notes/tscert.md`).

## Open, for Phase 2 and the main session

- **check:py is red** until the calib track's typing lands (calib owns `calib/**`, including the `[tool.pyright]` and
  `[tool.ruff]` settings f-toolchain asked for). `npm run check` exits 1 for that alone.
- **Ownership gaps** (main session, `scripts/ownership.json`): `core/miri.txt` (no owner; kernels-hardening is the
  natural one) and `proofs/axioms.txt` (proofs). Whoever adds `core/miri.txt` must also make check:rust's Miri step
  run with `MIRIFLAGS=-Zmiri-disable-isolation` and a small `PROPTEST_CASES`, or mark proptest blocks
  `#[cfg_attr(miri, ignore)]` (Go/no-go above); raster's env-map tests need the same or a much longer budget.
- **Kani harness sizes** (kernels-hardening): the parsers' loops need bounded inputs or `#[kani::unwind]`; a 16-byte
  `sniff` harness had not finished after 4 minutes (10 without unwind bounds), an 8-byte one takes 0.4 s.
- **Requests still open from the Phase 1 tracks** (not integration breakage, so not done here):
  - engine: `planner/engine.js` THREE_LIBS still points at jsdelivr (the build's one warning); use
    `new URL('libs/', import.meta.url).href`. A kernels worker entry (`planner/engine.worker.ts`, under engine's
    `planner/engine.*`) with `serveKernels(self)`; keep v1's GPU env-map bake on WebGL (k-geom: 20× faster than the CPU
    kernel even on SwiftShader).
  - server-core / server-routes: strict mode with `contract/gen/routes.js` + `validate.js`, and k-media's order of
    the HTTP rules (contract/api/README.md, docs/notes/k-media.md).
  - pipeline: strict mode for `node pipeline/src/cli.ts`, `--source-input`, the 14-property SAM 3D PLY, `stripGlb` on
    the packed model.
  - integration (Phase 3): E1's two direct `planner/serve.py` spawns and `evals/product_live.mjs` line 47 →
    `serverCommand()`; record v2 with `MIDSTUDY_SERVER=next node contract/tools/record-examples.mjs --check`; drop
    `planner/**/*.js` from knip's ignore and each `ignoreDependencies` entry once used; put `npm run test:contract`
    into `npm run check` (f-contract asked; I ran it by hand: 11/11 and the typecheck).
  - harness owner (f-contract's file; integration in Phase 3), for E17: E17 calls `serverCommand()` /
    `addCommand()` expecting an argv array, but the harness's `serverCommand(flags)` returns `{cmd, args}` and there is
    no `addCommand`, so E17 uses its built-in commands (correct today, but they will not follow the harness); and
    `startServer(ev, {env: {MIDSTUDY_STRICT: '0'}})` is overridden by the harness's own `MIDSTUDY_STRICT=1`, so E17
    cannot measure the next server without validation.
  - packaging (Phase 4): `nix/midstudy.nix` must run the build and ship `planner/dist/` (the page has no script
    without it), and build the wasm in Nix.
  - webgpu-spike: `@webgpu/types` (package.json, shared-append) and `tsconfig.planner.json` types.
- **Kernel test harness TS is not type-checked or linted by the gates** (`eslint.config.js` now ignores
  `core/crates/`); kernels-hardening could give `core/crates/*/js-test` and `tests/` a tsconfig with declarations for
  the lifted v1 modules. `core/js/node.ts`'s load error still names the stopgap `build-node.sh`.
- **eval:calib -- --mock** skips the three `upper-lounge-camera.jpeg` ingest checks in every worktree:
  `fixtures/photos/` is git-ignored and exists only in the main checkout, which gate-1 does not touch.
- `npm ci` reports 9 moderate `npm audit` advisories; not triaged.
- Linux is untested (TScert's x86_64-linux `node_modules` hash is a placeholder; Kani is packaged for aarch64-darwin
  only).
- The eval-lock deadlock several tracks reported (exclusive waiters holding partial slots) was fixed on `v2` before
  this gate by `c81375a` (one exclusive request queues a marker; shared requests wait behind it). No waits were seen
  during this gate.
