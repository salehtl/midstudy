# midstudy: hosting handoff (for the agent on homeserver)

You are taking over hosting midstudy on homeserver, next to nook. Nobody from the session that wrote this is around, so
everything you need should be here or linked from here. Read this whole file before you build anything.

This is the handoff for **v2** (docs/REFACTOR.md): the server and the furniture CLI are TypeScript on Node 22 with
Rust kernels compiled to WebAssembly, the planner is one bundle, calibration is still Python. The packaging was redone
for v2 on 2026-11-06 (docs/notes/packaging.md); §5 says exactly what was built, what was only evaluated, and what nobody
has tried (everything on Linux).

## 1. What midstudy is

midstudy lets you see furniture in your own room before you buy it: the room is **one phone photo** (MoGe-2 fits the
camera and the floor), furniture comes from photos at real-world size (Idol or SAM 3D on fal) or GLB files, you place it
on the photo's floor in the browser, save layouts, and render a photoreal image (an image model on fal, a few cents a
render). It is a fork of nook without the room scan, for the user's personal use.

## 2. Ground rules (they bind you too)

- **Money.** fal calls are paid. Never make a live fal call unless the user asks for it in chat. For anything you
  test, run with `MIDSTUDY_FAL_MOCK=<repo>/fixtures/fal`, `MIDSTUDY_NO_DOTENV=1` and `--daily-spend-usd 0`. The evals
  set these themselves. The deployed service has a real key (falKeyFile) and a daily cap (dailySpendUsd).
- **Secrets.** The FAL key goes in a root-only file outside the Nix store (§7). Never print it, never commit it.
  If homeserver's config uses sops, follow that repo's `.sops.yaml`.
- **Privacy.** The user's room photos are not in the repo (`fixtures/photos/` and image files at the repo root are
  git-ignored; one original carries location data). Never commit photos, and never copy uploaded scenes
  (`<dataDir>/scenes/*/source.*` keeps each upload as given, EXIF included) anywhere else.
- **Git.** Do not push or change remotes unless the user asks. Repo conventions are in `CLAUDE.md`; `PLAN.md` is the
  plan, `contract/CONTRACT.md` the spec, `docs/REFACTOR.md` how v2 was built.
- **Browsers.** Browser evals drive a headless Chrome only (on the Mac the flake's `$PUPPETEER_EXECUTABLE_PATH`; on
  homeserver nixpkgs' `chromium`, §11), never a browser someone browses with.

## 3. Repo layout

The code is at `git@github.com:salehtl/midstudy.git`. v2 is `main` since `84dd8ad` (2026-11-06); v1 (the Python
server) is `fc82c5c`, the commit before it, if you ever need to roll back.

| Path | What |
|---|---|
| `planner/` | the browser app, strict TypeScript, bundled by esbuild (`scripts/build.mjs`) into `planner/dist/` with three.js from npm (no CDN) and its own WebGPU splat renderer |
| `server/` | the HTTP server, `node server/src/main.ts` (Node 22 runs the `.ts` files directly, with its type stripping) |
| `common/` | what the server and midstudy-add share (the library lock, costs.csv, fal, files) |
| `pipeline/` | `midstudy-add`, `node pipeline/src/cli.ts`: a furniture photo or model to a normalized library item (contract §3) |
| `core/` | the Rust kernels (`crates/*`), compiled to wasm by the `crates/wasm-*` crates; `core/js/` are their typed faces |
| `calib/` | `midstudy-calib` (uv project, Python): photo ingest, MoGe-2 floor fit, lighting, keep-room alignment, and the warm worker `serve` (contract §4.3) |
| `contract/` | the spec (`CONTRACT.md`), JSON schemas for files and HTTP payloads, and what is generated from them (`contract/gen/`) |
| `evals/` | the task evals (`evals/README.md`), run through `npm run eval:*` and `scripts/eval-lock.mjs` |
| `fixtures/` | golden scenes (`scenes/`, `calib/`), fal mock responses (`fal/`), test models |
| `nix/`, `flake.nix` | the packaging (below) and the dev shells |
| `docs/notes/*.md` | what each track did and measured; `docs/notes/packaging.md` is this packaging's notes |
| `library/library.json`, `library/costs.csv` | the (empty) dev library; user data dirs (`scenes/`, `rooms/`, `layouts/`, `renders/`) are git-ignored |

## 4. What the flake gives you

| Output | File | What |
|---|---|---|
| `packages.x86_64-linux.midstudy` (= `default`) | `nix/midstudy.nix` | `bin/midstudy-web`: Node 22 running `server/src/main.ts` from the built tree, with `--calib` and `--midstudy-add` pointing at the two packages below |
| `packages.x86_64-linux.midstudy-add` | `nix/midstudy-add.nix` | `bin/midstudy-add`: Node 22 running `pipeline/src/cli.ts` from the built tree |
| `….midstudy.app` (also `midstudy-add.app`) | `nix/midstudy-app.nix` | the built tree, `share/midstudy/`: the planner (`index.html`, styles, icons, **`dist/`**), `server/src`, `common`, `core/js`, `pipeline/src`, `contract/gen`, `build/wasm/{node,pipeline,product}`, `node_modules` (a link to the runtime npm packages) |
| `….midstudy.wasm` | `nix/wasm.nix` | every `core/crates/wasm-*` crate as wasm: `wasm/{web,node,pipeline,product}/` |
| `….midstudy.nodeModules.{build,runtime}` | `nix/node-modules.nix` | the npm packages: `build` (everything, for the bundle), `runtime` (the `dependencies` only) |
| `packages.x86_64-linux.midstudy-calib` | `nix/midstudy-calib.nix` | `bin/midstudy-calib` on torch-bin (CUDA 12.8 wheels), MoGe-2 (`nix/moge.nix`), utils3d (`nix/utils3d.nix`), OpenCV, pillow-heif, jsonschema |
| `….midstudy-calib.mast3r.{code,weights}` | `nix/mast3r.nix` | align-room's MASt3R (the `rooms` extra): naver/mast3r at the pinned commit with its submodules and a `.midstudy-commit` stamp (`MIDSTUDY_MAST3R_DIR`), and the ViT-L weights (2.75 GB) in the Hugging Face cache the wrapper sets next to MoGe-2's. On the RTX 2060 (2026-11-07): the golden room's 6 photos in 44 s, 5 placed, 1.6 cm loop residual; 4.3 GB of VRAM alone, 5.6 GB with MoGe-2 in the same worker |
| `packages.x86_64-linux.moge-weights` | `nix/moge-weights.nix` | MoGe-2 ViT-L weights (1.32 GB, fixed-output from Hugging Face) laid out as a read-only Hugging Face cache |
| `nixosModules.default` | `nix/module.nix` | `services.midstudy` (§6) |
| `checks.x86_64-linux.service` | `nix/test.nix` | NixOS VM test of the module (KVM, no GPU; fal and MoGe mocked) |
| `packages.aarch64-darwin.*` | same files | the same packages for the Mac (MPS), used to check this packaging there |
| `devShells.*.{default,nightly}` | `nix/toolchain.nix` | the dev tools (Node, Python, Rust, Lean, …); only needed on homeserver to run the evals (§11) |

How it runs: the host's proxy → `midstudy-web` on `127.0.0.1:<webPort>` (one Node process) → on the first calibration
it starts **`midstudy-calib serve`, the warm worker** (contract §4.3 Worker): one Python child that keeps MoGe-2 loaded
on the GPU and answers every later calibration and lighting job (E17 measured a second photo's calibration at 0.94 s,
against 7.84 s for v1's one-shot command, on the Mac). It closes after 10 idle minutes and starts again with the next job; a
worker that fails is killed and that job runs one-shot (`midstudy-calib run|fit|light`), and after 3 failures in a row
the server stays one-shot. Keep-room renders run `midstudy-calib align` one-shot (a render never waits behind a
calibration). Each library add runs one `midstudy-add` (Node; fal for photos, local for GLB/OBJ). Calibration jobs
run one at a time. Everything lives in `dataDir`. There is one systemd service, `midstudy.service`; the worker is its
child, so stopping the service stops the worker.

How it is built (all in Nix; by design nothing reaches the network but the fixed-output fetches, which is untested in a
Linux sandbox, §5):

- **wasm** (`nix/wasm.nix`): `node scripts/build.mjs --wasm-only`, so cargo (`--release --locked`,
  wasm32-unknown-unknown with SIMD128), wasm-bindgen 0.2.121 and wasm-opt -O3 run with exactly the flags a checkout's
  `npm run build` uses. Rust 1.95.0 comes from rust-overlay as the official binaries (`rustWasm` in
  `nix/toolchain.nix`, pinned by `flake.lock`), the crates from `core/Cargo.lock` through `importCargoLock` (96 crates
  from crates.io by their lockfile checksums). A new `core/crates/wasm-*` crate is picked up with no change in `nix/`.
  The build folder is written as `/build` in the panic locations, so the same sources give the same bytes (checked on
  the Mac with `nix build --rebuild`).
- **npm** (`nix/node-modules.nix`): `importNpmLock` from `package-lock.json`: every package by the integrity hash the
  lockfile records, so **there is no npm or cargo hash in `nix/` to keep up to date** when the lockfiles change.
  Packages built for another platform (esbuild's and oxc's binaries) are not downloaded; npm skips them as it always
  does.
- **the planner bundle** (`nix/midstudy-app.nix`): `node scripts/build.mjs --planner-only` with a copy of the build
  packages and the wasm above. On the Mac its `planner/dist/` was byte for byte the one `npm run build` makes in a
  checkout, except the web `.wasm` (rustc records its source paths).
- **the tree** keeps the repository's layout because every module finds the others relative to itself
  (`core/js/node.ts` loads `../../build/wasm/node/`, the server serves `../../planner/`). Only what runs ships: no
  tests, no Rust, no planner TypeScript (the server's static allowlist would serve those files if they were there).

Design points worth knowing:

- **torch-bin is shared with nook.** `nix/midstudy-calib.nix` imports its own nixpkgs instance configured exactly as
  nook's `nix/nook-gsplat.nix` (allowUnfree, `cudaCapabilities = [ "7.5" ]`, the NVSHMEM overlay), and `flake.lock`
  pins the same nixpkgs revision as nook's (`1f607aa`). On the Mac (2026-11-04) midstudy's x86_64-linux torch-bin
  derivation was identical to nook's: `/nix/store/mlhz62jxki58b0k3jik6h6q13kypfgsw-python3.13-torch-2.11.0.drv`. If
  homeserver's nook was built from that revision, torch-bin and its CUDA libraries (NCCL and NVSHMEM are built from source,
  which took hours for nook) are already in homeserver's store and nothing CUDA is rebuilt. If nook's lock has moved on
  since, either update midstudy's lock to nook's revision (`nix flake lock --override-input nixpkgs
  github:nixos/nixpkgs/<rev>`; that also moves Node, wasm-bindgen and binaryen, see §14) or accept the long first build.
- **Python 3.13.** The calib package uses nixpkgs' `python3` (3.13), the one nook's torch-bin is built for. `calib/`
  is developed on 3.12 under uv; the Nix build runs it on 3.13 with nixpkgs' versions (torch 2.11, numpy 2.4, Pillow
  12.3, pillow-heif 1.4, huggingface-hub 1.16, opencv 4.13, jsonschema 4.26).
- **Weights offline.** The `midstudy-calib` wrapper sets `HF_HUB_CACHE=<MoGe-2's and MASt3R's weights>`, `MIDSTUDY_MAST3R_DIR=<mast3r.code>` and `HF_HUB_OFFLINE=1` as
  defaults (`--set-default`), so the service never talks to Hugging Face. §8 has the alternative.
- **Nothing from a CDN.** three.js is bundled from npm into `planner/dist/`, with the planner's own splat renderer; the browser loads
  everything from midstudy itself. `/library/<id>/splat.spz` is served from `dataDir` like the other library files, as
  `application/octet-stream` with no `Content-Encoding` (it is gzip inside); the proxy may compress it again or not.
  Check that the proxy's response size limit allows 6 MB.
- **Device.** `calibDevice = "auto"` passes the plain binary (the CLI defaults to auto). Other values make the module
  pass a small shim as `--calib` that appends `--device <x>` to `run`, `fit`, `light` and **`serve`** (the worker's
  `--device` is the default of every request it answers); `align` and `ingest` take no `--device`.
- **Node 22 runs TypeScript directly.** The server and midstudy-add are `.ts` files that Node strips the types from
  (unflagged since Node 22.18; nixpkgs' `nodejs_22` at the pinned revision is 22.23.4). `require()` of the wasm-bindgen
  ES modules needs Node ≥ 22.12. Both hold at this lock.
- **Closure sizes** (the Mac): `midstudy-add` 383 MiB (Node 22 with ICU is about 223 MiB, the runtime npm packages
  156 MB, of which cesium, pulled in by obj2gltf for OBJ zips, is 116 MB); `midstudy` 4.4 GiB on darwin (torch, the
  1.3 GB weights, and Python's reference to clang on darwin). Linux will differ (CUDA libraries instead).

## 5. What was checked, and what was not

Everything below was done on the Mac (aarch64-darwin, M3 Max) on 2026-11-06 for v2, with fal mocked and $0 spent.
**Nothing x86_64-linux was built, and nothing ran on homeserver, on a CUDA GPU, or in a NixOS VM.** The Mac's Nix daemon
runs builds without a sandbox (`sandbox = false`), so a build step that silently needed the network would have worked
there and fail on Linux: see "never tried" below.

Built on aarch64-darwin (`nix build`):

- `midstudy-wasm` (`.#midstudy.wasm`): all four wasm crates, about 55 s; rebuilt with `--rebuild`: identical output.
- `midstudy-node-modules-build` (196 packages, only darwin-arm64's esbuild and oxc binaries fetched; 61 foreign ones not
  downloaded) and `midstudy-node-modules-runtime` (65 packages, the lock's non-dev set).
- `midstudy-app`: the bundle (byte for byte a checkout's `planner/dist/` but the web `.wasm`, above); its install check
  loads the media, pipeline and product kernels in Node and imports glTF-Transform from the tree.
- `midstudy-add`: install check `--help`; by hand, in strict mode with fal mocked: an Idol add from a golden photo
  (262,144 splats, splat.spz written), a GLB (`--engine glb`) and an OBJ zip (obj2gltf, cesium) into a scratch library.
- `midstudy-calib` (now with jsonschema): install checks `--help`, `serve --help`, every lazily imported module
  (lighting, worker, validate, contract_types, records and util included) and the three schemas loading through
  `importlib.resources`. The weights' fixed-output path was produced from the Mac's own Hugging Face cache of the same
  revision (`nix-store --add-fixed`) and matched the derivation's path, so the hash is right; Nix never downloaded that
  URL.
- `midstudy`: install check `--help`.

Run on the Mac, the built packages only (no checkout code), through the eval lock:

- **The packaged server against the fixtures** (a scratch smoke script, `evals/out/packaging/smoke.mjs`, git-ignored;
  `midstudy-web` started like the service: absolute data dirs, `--allowed-host`, `--daily-spend-usd 0`, fal mocked,
  strict mode so every answer and file was checked against its schema). With `MIDSTUDY_CALIB_MOCK`: **23/23**. The
  page, `dist/app.js` and the web wasm (as `application/wasm`) and styles are served, the planner's `.ts` is not (404);
  Host 403/200; a golden photo upload calibrates **through the worker** (`midstudy-calib serve` running as the server's
  child, no fallback line); `photo.jpg` and `depth.png` served, `source.jpg` not; a GLB through the packaged
  `midstudy-add`; the planner in headless Chrome loads from the package and `window.midstudy.ready` resolves, places
  an item, renders (mock, $0) and renders with keep-room (aligned by the packaged `align`, 1,059 inliers); no page or
  console errors; $0 spent; no contract violation; SIGTERM stops the server and the worker with it (0.5 s).
- **The same with real MoGe-2** (no calib mock, MPS): **25/25**. The first photo calibrated in 4.3 s (the worker
  started and loaded the model), the second in 2.5 s through the same worker process; `source: moge-2`, `device:
  mps`; living-wide fov 62.48°, height 1.185 m, pitch −9.32°, roll −0.05° (v1's Mac numbers, §9 step 6).
- **§9 step 6 as written** (with `--device mps`): `run` one-shot 4.9 s with the same camera; `serve` with two `fit`
  requests answered `"id": "a"` in 3.88 s and `"id": "b"` in 1.76 s.

Evaluated for x86_64-linux (nothing built):

- `nix flake check --no-build --all-systems`: every output evaluates (packages for both systems, the module, the VM
  test, the dev shells).
- A minimal x86_64-linux `nixosSystem` importing the module with the §6 values: the toplevel derivation evaluates with
  no warnings; `ExecStart` is `…-midstudy-2.0.0/bin/midstudy-web --host 127.0.0.1 --port 8780 --scenes-dir
  /var/lib/midstudy/scenes --library-dir /var/lib/midstudy/library --layouts-dir /var/lib/midstudy/layouts
  --renders-dir /var/lib/midstudy/renders --calib …/bin/midstudy-calib --midstudy-add …-midstudy-add-2.0.0/bin/midstudy-add
  --daily-spend-usd 2 --allowed-host midstudy.salehtl.com` (with `calibDevice = "cuda"`, `--calib` is the shim
  `…-midstudy-calib-cuda`).
- midstudy's x86_64-linux torch-bin derivation is still nook's (`mlhz62jx…-python3.13-torch-2.11.0.drv`, §4).
- The Linux npm sets fetch only the linux-x64 binaries of esbuild and oxc (oxc's glibc and musl builds both: the lock
  records no libc to tell them apart; oxc is knip's, which the build never runs).

Never built or run (all yours, in the order of §9):

- every `x86_64-linux` package: the wasm build with rust-overlay's Linux toolchain in the sandbox, the npm installs and
  esbuild's install script in the sandbox (no network), the bundle, `midstudy-add`, `midstudy`; `midstudy-calib` with
  CUDA torch-bin (and whether the CUDA wheel sees the RTX 2060 from inside the hardened service); `moge`/`utils3d`
  against torch-bin's Linux wheel; the `moge-weights` download from Hugging Face;
- the NixOS module on a real system: users, tmpfiles, hardening, EnvironmentFile, the device shim, the worker under
  the service;
- the VM test `checks.x86_64-linux.service` (evaluated only);
- the proxy, the host name, TLS, and the live fal path from homeserver.

## 6. Service options and suggested values

The options are unchanged from v1.

| Option | Default | Suggested on homeserver | Notes |
|---|---|---|---|
| `enable` | false | true | |
| `webPort` | 8780 | 8780 | nook's module defaults are `webPort` 8096 and `apiPort` 8095; the server's own default (and nook-web's when run by hand) is 8765, and nook's web app may sit in that 8765 range. 8780 clashes with none of those, but **check** with `ss -ltnp` that nothing on homeserver uses it. |
| `dataDir` | `/var/lib/midstudy` | `/var/lib/midstudy` | scenes, library, layouts, renders; also the service's HOME (torch and HF write small caches under `.cache/`) |
| `falKeyFile` | null | `/run/secrets/midstudy-fal` (or whatever path homeserver's secrets use; see how nook's `services.nook.falKeyFile` is set and mirror it) | `FAL_KEY=...` in an EnvironmentFile, root-only is fine (systemd reads it). The same fal account as nook is fine; the caps are per service. |
| `dailySpendUsd` | 2 | 2 | per UTC day, covers library adds from photos and renders; `0` blocks all paid calls |
| `allowedHosts` | `[ ]` | `[ "midstudy.salehtl.com" ]` | the name the proxy serves it under (nook serves `https://nook.salehtl.com/planner/`). Pick the name with the user. |
| `calibDevice` | `"auto"` | `"auto"` | auto retries a failed CUDA inference (e.g. out of memory while nook-scan trains) on the CPU; `"cuda"` doesn't retry (the scene then gets an EXIF/default camera); `"cpu"` never touches the GPU. The worker gets the same device. |
| `package` | this flake's `midstudy` | default | |

ExecStart is `midstudy-web --host 127.0.0.1 --port <webPort> --scenes-dir <dataDir>/scenes --library-dir
<dataDir>/library --layouts-dir <dataDir>/layouts --renders-dir <dataDir>/renders --calib <midstudy-calib or the shim>
--midstudy-add <midstudy-add> --daily-spend-usd <cap> [--allowed-host <name>]…`: both tools are named, so the service
never falls back to the server's own defaults (`uv run --project calib midstudy-calib`, `node pipeline/src/cli.ts`),
which only work in a checkout.

`dailySpendUsd` may be null: the budget is then set in the app's Settings (`GET/PUT /api/settings`, saved as
`<dataDir>/library/settings.json`). A number locks the budget (the Settings PUT answers 409), 0–10000.

Example, in homeserver's system flake (add this repo as an input, say `midstudy`):

```nix
{
  imports = [ inputs.midstudy.nixosModules.default ];
  services.midstudy = {
    enable = true;
    webPort = 8780;
    falKeyFile = "/run/secrets/midstudy-fal";
    dailySpendUsd = 2;
    allowedHosts = [ "midstudy.salehtl.com" ];
    calibDevice = "auto";
  };
}
```

## 7. FAL key and data dir

- **Key:** a file containing one line `FAL_KEY=<key>`, mode 0400, owned by root, outside the store, e.g.
  `/run/secrets/midstudy-fal` from sops-nix (`sops.secrets.midstudy-fal = { };` with the value in homeserver's encrypted
  secrets file) or the same mechanism nook's key uses. Ask the user for the key (or to reuse nook's secret); never
  read it from anywhere else. Without it the service runs, but library adds from photos and Render answer
  "FAL_KEY not set". The service sets `MIDSTUDY_NO_DOTENV=1`, so the key can only come from that file.
- **Data dir** (created by tmpfiles, `midstudy:midstudy`, 0750): `scenes/<scene>/` (photo.jpg, depth.png, calib.json,
  lighting.json, scene.json, thumb.jpg and `source.<ext>`, the upload as given, never served), `scenes/.trash/`,
  `layouts/<scene>/`, `renders/`, `library/` (library.json, costs.csv, one folder per item, `.trash/`, and the lock
  folders `.lock.d` and `costs.csv.lock.d`). Back up the whole folder; `library/costs.csv` is the spend record the cap
  reads.

## 8. MoGe weights

Default: nothing to do. `nix build .#moge-weights` downloads `model.pt` (1.32 GB) from
`https://huggingface.co/Ruicheng/moge-2-vitl-normal/resolve/cb0e8bbd6b1e243589717c78e750b1ba4c093acf/model.pt`
(fixed-output, SHA-256 `280741fd…1a01`; no Hugging Face login needed) and the calib wrapper reads it offline from the
store. It's part of the service's closure, so a `nixos-rebuild` fetches it.

Alternative (only if the store copy is a problem, or the user wants `--model vitb|vits`): a writable cache the
service seeds itself on first use. Set `systemd.services.midstudy.environment = { HF_HUB_CACHE =
"/var/lib/midstudy/.cache/huggingface/hub"; HF_HUB_OFFLINE = "0"; };` (the wrapper's values are only defaults; the
worker inherits the service's environment). The first calibration then downloads the weights (about 20 s on a fast
line, inside the 600 s job timeout). To pre-seed instead: `sudo -u midstudy env HOME=/var/lib/midstudy
HF_HUB_CACHE=/var/lib/midstudy/.cache/huggingface/hub HF_HUB_OFFLINE=0 $(nix build --print-out-paths
.#midstudy-calib)/bin/midstudy-calib run <repo>/fixtures/scenes/living-wide/photo.jpg --out /tmp/seed` and delete
`/tmp/seed`.

If the weights are missing or unreadable, calibration does not fail: it falls back to the EXIF or default camera
(`calib.json` `source: "exif"|"default"`, `fallback_reason`), and the planner asks the user to check the floor. So
after deploying, check that a real calibration says `"source": "moge-2"` and `"device": "cuda"` (§9 step 9).

## 9. Verify, in this order

Run everything from the repo root, on `main`. `nix develop -c <cmd>` gives Node 22,
Python 3.12, uv, Rust and the rest of the dev tools.

1. **Evaluate.** `nix flake check --no-build` and `nix flake show`. Cheap; catches a bad merge.
2. **Small builds.** `nix build .#midstudy-add -L`. This is the whole Node side: the wasm kernels (Rust 1.95.0 for
   wasm32 from rust-overlay, about a minute of cargo), both npm sets (about 200 tarballs from registry.npmjs.org), the
   planner bundle and the tree, then the install checks (the kernels load in Node; `midstudy-add --help`). Nothing here
   was ever built on Linux: if it fails, the likely places are the sandbox (no network: npm runs offline from the
   fetched tarballs, cargo from the vendored crates), esbuild's install script (it runs its linux-x64 binary once), and
   rust-overlay's toolchain. `nix log` of the failing derivation says which.
3. **torch-bin is nook's.** `nix eval --raw .#midstudy-calib.torch.drvPath`, then
   `nix path-info $(nix eval --raw .#midstudy-calib.torch)`: if it's already valid, nook built it and step 5 builds
   nothing CUDA. If not, see §4 (lock to nook's revision first; the from-source CUDA build takes hours).
4. **Weights.** `nix build .#moge-weights -L` (1.32 GB download, hash-checked). MASt3R's (2.75 GB) come with step 5.
5. **Calib.** `nix build .#midstudy-calib -L`. Builds utils3d and MoGe (their import checks load torch, which needs
   no GPU) and runs an install check that imports every module the CLI loads lazily and loads its schemas.
6. **Calib on the GPU, by hand.**
   `out=$(nix build --print-out-paths .#midstudy-calib); $out/bin/midstudy-calib run fixtures/scenes/living-wide/photo.jpg --out /tmp/ms-cal --device cuda`.
   The last stdout line is JSON: expect `"source": "moge-2"`, `"device": "cuda"`, `"floor": {"found": true…}` and
   roughly the Mac's numbers for this CG scene (fov 62.5, height 1.185, pitch −9.3, roll −0.05; MoGe misreads the
   CG room's scale, so don't compare with the truth 55 / 1.40). If `device` says `cpu`, torch can't see the GPU:
   check `nvidia-smi`, `/run/opengl-driver/lib`, and that you're in the `video`/`render` groups. Then the worker, the
   way the server drives it (one JSON request per line on stdin, one answer per line on stdout, progress on stderr):
   `printf '%s\n' '{"id":"a","cmd":"fit","args":["/tmp/ms-cal"]}' '{"id":"b","cmd":"fit","args":["/tmp/ms-cal"]}' | $out/bin/midstudy-calib serve --device cuda`
   prints two lines with `"id": "a"` and `"id": "b"`; the second should be the quicker (the model stays loaded;
   stderr says `request b: done in … s`; on the Mac's MPS 3.9 s, then 1.8 s). Delete `/tmp/ms-cal`.
7. **E2 with the packaged CLI.**
   `nix develop -c npm ci` once, then
   `nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib -- --cli "$out/bin/midstudy-calib" --no-real-photos`.
   The golden photos without EXIF check pitch, roll and the depth shape strictly; MoGe's FOV and scale on them only
   within regression bands (10°, 20 %, 25 %), since it reads these CG renders 3.6–7.5° wide and 8–15 % small (PLAN.md
   §6.2, docs/notes/integrate.md). The "+ EXIF" runs hold the strict limits (height within 5 %). Expect what the uv
   build gives on the Mac, within a few tenths of a degree on CUDA. The user's real photos are not on homeserver, so
   `--no-real-photos` is required; `--mock`'s HEIC case needs macOS `sips` and is skipped on Linux with a reason.
8. **The VM test.** `nix build .#checks.x86_64-linux.service -L` (needs `/dev/kvm`). Boots a VM with the module,
   checks the planner, its bundle and the web kernels (`application/wasm`), that the planner's TypeScript isn't served,
   the Host rule (403 for a foreign Host), a photo upload calibrating through the worker (calib mocked; the test finds
   the `serve --device cpu` process and no fallback in the journal), a GLB added through `midstudy-add`, all under the
   service's hardening, and that stopping the service stops the worker.
9. **Deploy** (§6, §10): add the input, enable the module, add the secret and the proxy route, rebuild. Then:
   `systemctl status midstudy`, `journalctl -u midstudy -e`, `curl -s localhost:8780/api/scenes`,
   `curl -s localhost:8780/api/spend`. Upload a photo through the site and check
   `/var/lib/midstudy/scenes/<scene>/calib.json` says `"source": "moge-2"` and `"device": "cuda"`, that the grid
   sits on the floor, and that `pgrep -u midstudy -af 'midstudy_calib.* serve'` shows the worker (for 10 minutes after
   the last job). A line `the calibration worker (…) failed` in the journal means a job fell back to one-shot; it
   still calibrates, but say what it says. Delete that scene in the UI if it was only a test (it moves to
   `scenes/.trash/`).
10. **The browser evals** (optional on homeserver; they test the repo's server, not the package): §11.
11. **Live checks** (PLAN.md §8): only with the user (§12).

## 10. Proxy and host name

- Give midstudy **its own host name** (e.g. `midstudy.salehtl.com`), next to `nook.salehtl.com`. It can't live under a
  sub-path of nook's: the app uses absolute paths (`/planner/`, `/api/…`, `/scenes/…`, `/library/…`, `/renders/…`).
- Find how homeserver serves `nook.salehtl.com` (grep homeserver's config for it) and add the same route for the new name
  to `127.0.0.1:8780`, with DNS and TLS the same way. Put it behind **the same access control as nook**: the app
  has no login, and anyone who reaches it can spend up to `dailySpendUsd` a day.
- The proxy must pass the original `Host` header (it must equal one of `allowedHosts`, else 403), and the browser's
  `Origin` must be `https://<that host>` (mutations from another origin get 403).
- Request bodies: allow up to 200 MB. Furniture model uploads go up to 200 MB, photo uploads to 25 MB, and JSON
  bodies (a render sends its images as data URIs) to 32 MB. Uploads need a `Content-Length` (411 without), so the
  proxy must not re-send them chunked.
- Timeouts: `POST /api/render` waits for fal (up to 300 s) plus keep-room alignment (up to 180 s). Calibration and
  library adds are background jobs the browser polls, so they need no long timeout.
- The planner's files are served with `Last-Modified` and no caching, and `.wasm` as `application/wasm` (browsers
  refuse to stream-compile wasm under another type: keep the proxy from rewriting it).

## 11. Running the evals on homeserver

They're $0: every eval starts its own server (`node server/src/main.ts` from the repo, strict mode) with fal mocked,
`MIDSTUDY_NO_DOTENV=1` and a $0 cap, on a free port, with scratch data under `evals/out/` (git-ignored), and never
touches `dataDir`. They test the repository's code, not the installed package (request R5).

```sh
nix develop -c npm ci                                            # once
nix develop -c npm run build                                     # the wasm and the bundle (the evals also run it)
nix develop -c node scripts/eval-lock.mjs -- npm run eval:selftest
chromium=$(nix build --inputs-from . --no-link --print-out-paths nixpkgs#chromium)/bin/chromium
out=$(nix build --print-out-paths .#midstudy-calib)
MIDSTUDY_BROWSER=$chromium MIDSTUDY_EVAL_ALIGN_CMD="$out/bin/midstudy-calib" \
  nix develop -c node scripts/eval-lock.mjs -- npm run eval:all
nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib -- --cli "$out/bin/midstudy-calib" --no-real-photos
```

- `eval:all` is E1, E3–E9 and E11–E16 (scenes API, planner, occlusion, floor, render, library, pipeline, phone, the UX
  rounds, splats, the product page and its form, lighting); on the Mac all pass (docs/notes/cutover.md). They have only
  ever run on the Mac's headless Chrome; Linux Chromium with SwiftShader should work (`--use-angle=swiftshader
  --enable-unsafe-swiftshader --ignore-gpu-blocklist`, which the harness passes) but is untried.
  `MIDSTUDY_EVAL_ALIGN_CMD` makes E6 use the packaged `align` instead of `uv run --project calib` (the other evals
  calibrate with the stub, `fixtures/stub_calib.py`).
- Every eval goes through `scripts/eval-lock.mjs` (a machine-wide semaphore; `--exclusive` for E17's timings).
- `eval:real` needs the user's photos (`fixtures/photos/`, not in the repo): skip it.
- `uv sync --project calib` on Linux would pull PyPI's CUDA torch into `calib/.venv` (several GB); you only need it
  without `MIDSTUDY_EVAL_ALIGN_CMD`, or to run `calib/`'s own tests (`nix develop -c bash -c 'cd calib && uv run pytest
  -q'`).
- `evals/py` (used by E2 and the self-test) runs `uv run --no-project --python 3.12 --with …`: it needs the network
  the first time.
- Evals that write to the same `evals/out/<eval>/` must not run at the same time.

## 12. The live checks (PLAN.md §8): with the user only

These spend real money and need the user's go-ahead in chat each time:

1. **Done on the Mac with v1, 2026-11-05 ($0.10):** a live SAM 3D add (the Morris chair photo, 62 s, $0.02) and two
   renders of a two-chair layout on the user's lounge photo ($0.04 each, 16–17 s). Keep room exact applied (679
   inliers, 0.6 px residual) and kept the room sharp at the photo's 2048 × 1152, so it is **on by default** in the
   Render dialog. One render attempt got fal HTTP 422 ("did not generate the expected output"), was not charged, and
   worked on retry; the server words that error as "returned no image this time". v2 has made **no live call yet**:
   its mock request log matched v1's (midstudy-add: 71 of 77 cases identical, the other 6 differ in PNG/HEIC upload
   bytes; docs/notes/int-backend.md), which is as far as $0 goes. After deploying, one render on the site is a fair
   smoke test, with the user's go-ahead; check `GET /api/spend` before and after.
2. The user's own photos through Adjust floor, to see how often the automatic fit needs fixing.
3. Hosting (this file).

## 13. Requests for code changes (collected by the packaging agent)

None of these block hosting; the packaging works around each one.

- **R1 (calib):** let `midstudy-calib` take the device from the environment (e.g. `MIDSTUDY_CALIB_DEVICE`, used when
  `--device` isn't given). Then the module can set an environment variable instead of passing the shim in
  `nix/module.nix` as `--calib`. Still open in v2 (the shim now covers `serve` and `light` too).
- **R2 (calib):** a weights override (e.g. `MIDSTUDY_MOGE_WEIGHTS=<model.pt>`, passed straight to the model loader).
  The package could then point at the store file instead of building a Hugging Face cache layout that relies on
  huggingface_hub's offline behaviour. Still open.
- **R3 (calib):** `calib/pyproject.toml` says `requires-python = ">=3.12,<3.13"`, while the Nix package runs it on 3.13.
  Widen it to `<3.14` once the calib tests have run on 3.13. Still open.
- **R4 (server, `server/src/main.ts`):** relative `--scenes-dir`/`--library-dir`/`--layouts-dir`/`--renders-dir`
  resolve against the repository (v1's rule, kept), which is the read-only store tree in the package; resolve them
  against the working directory when the server isn't running from a checkout (or say so in `--help`). The module
  passes absolute paths, so this only affects people running `midstudy-web` by hand. Likewise `midstudy-add` without
  `--library` writes to the tree's `library/`, read-only in the package (the server always passes `--library`).
- **R5 (evals):** a way to run `eval:all` against the packaged server (e.g. `MIDSTUDY_EVAL_SERVE="<cmd>"` in
  `evals/lib/harness.mjs` instead of `node server/src/main.ts`, and the same for `evals/library_api.sh` and the CLI
  in `evals/pipeline_offline.sh`), so homeserver can test what it deploys. (E2 `--mock`'s HEIC case now skips with a reason
  where `sips` is missing: that half of R5 is done.)
- **R6 (foundation):** `README.md` still says the Nix packages are v1's; point it at this file once v2's packaging is
  merged.
- **R7 (finish, when porting `main`):** `fc82c5c` changes `nix/module.nix` (`dailySpendUsd` nullable, `--daily-spend-usd`
  only when set). v2's ExecStart now also passes `--midstudy-add`, so apply that hunk by hand, together with the server's
  settings route it depends on.

## 14. Risks to watch

- **GPU contention with nook-scan.** Both use the RTX 2060 (6 GB). MoGe-2 ViT-L in fp16 at 1024 px needs about
  2–3 GB; while nook trains it may run out of memory. With `calibDevice = "auto"` that is retried on the CPU (slower,
  same result). **New with v2:** the warm worker keeps MoGe-2 on the GPU for up to 10 minutes after the last
  calibration (about 2–3 GB held while idle). If nook-scan needs that memory in those minutes, it is midstudy's worker
  that holds it; stopping `midstudy.service` (or waiting the 10 minutes) frees it. No shared lock: nook's
  `/run/nook/gpu.lock` is held for whole training runs, longer than the 600 s calibration timeout.
- **CUDA 12.8 wheels on sm_75.** nook's gsplat runs on this torch-bin on homeserver, so the RTX 2060 is supported.
- **Hardening.** Copied from nook's module (no `PrivateDevices`, no `MemoryDenyWriteExecute`, which CUDA and Node's
  JIT both need). If torch can't open `/dev/nvidia*`, check the device permissions before loosening anything else.
- **Python 3.13 and nixpkgs' library versions** differ from the uv lock calib was developed with (§4).
- **The first Linux build.** Every Node-side derivation was only built on the Mac, without a sandbox (§5). The
  likely failures are listed in §9 step 2.
- **Moving the nixpkgs lock** (e.g. to match nook's) also moves Node 22, wasm-bindgen-cli and binaryen. Node must stay
  ≥ 22.18 (type stripping); `wasm-bindgen-cli_0_2_121` must stay in nixpkgs (every crate pins wasm-bindgen
  `=0.2.121`), or the lock update needs a matching crate bump.
