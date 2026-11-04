# Packaging notes

What the packaging agent built (PLAN.md §9), how to check it, and what's left. Not committed; new files are
`git add`ed so the flake sees them. The handoff for the homeserver agent is [docs/HANDOFF.md](../HANDOFF.md); this file
is the short version for the next agent on the Mac.

## What's here

| File | What |
|---|---|
| `flake.nix` | dev shells unchanged; new `packages.{x86_64-linux,aarch64-darwin}` (`midstudy`, `midstudy-calib`, `moge-weights`, `midstudy-add`, `fal-client`, `default`), `nixosModules.default`, `checks.x86_64-linux.service` |
| `nix/midstudy.nix` | rewritten: `bin/midstudy-web` = `python3 -I planner/serve.py --calib <midstudy-calib> --midstudy-add <midstudy-add>`; only `planner/` is in `share/midstudy` (serve.py serves its parent folder) |
| `nix/midstudy-calib.nix` | new: own nixpkgs instance (allowUnfree, cudaCapabilities 7.5, the NVSHMEM overlay: identical to nook's `nook-gsplat.nix`, so torch-bin is nook's very derivation); python3 (3.13) env with torch-bin, MoGe, utils3d, opencv-python-headless, pillow-heif, huggingface-hub, scipy; wrapper with `-P`, `HF_HUB_CACHE`/`HF_HUB_OFFLINE=1` defaults and the driver lib path on Linux; install check imports every lazily loaded module |
| `nix/moge.nix`, `nix/utils3d.nix` | new: MoGe at `07444410…` (v2.0.0) and utils3d at `3fab839f…` (the pins in `calib/uv.lock`), with the deps the inference path never imports dropped (`pythonRemoveDeps`) |
| `nix/moge-weights.nix` | new: `Ruicheng/moge-2-vitl-normal` `model.pt` at HF revision `cb0e8bbd…` as a fixed-output fetch, laid out as a read-only Hugging Face hub cache (refs/main without a newline, snapshots → blobs) |
| `nix/module.nix` | rewritten: `services.midstudy` (`enable`, `package`, `webPort` 8780, `dataDir`, `falKeyFile`, `dailySpendUsd`, `allowedHosts`, `calibDevice` auto/cuda/cpu); one service, nook's user/tmpfiles/hardening pattern; a shim as `--calib` appends `--device` to `run`/`fit` when the device isn't auto |
| `nix/test.nix` | new: NixOS VM test (planner, Host rule, upload → calibrated with `MIDSTUDY_CALIB_MOCK`, GLB via midstudy-add, file ownership) |
| `nix/midstudy-add.nix` | platforms now include darwin (comment added); otherwise the foundation's rename of nook-add |
| `nix/fal-client.nix` | unchanged |
| `docs/HANDOFF.md` | the homeserver handoff |

## How to check it on the Mac

```sh
nix flake check --no-build --all-systems                      # everything evaluates
nix build .#packages.aarch64-darwin.midstudy -L --no-link     # builds add, calib (torch-bin MPS wheel), weights, web
# the weights FOD: no need to download, if the HF cache has the snapshot:
#   cp -L ~/.cache/huggingface/hub/models--Ruicheng--moge-2-vitl-normal/snapshots/cb0e8bbd6b1e243589717c78e750b1ba4c093acf/model.pt \
#     <scratch>/moge-2-vitl-normal-model.pt && nix-store --add-fixed sha256 <scratch>/moge-2-vitl-normal-model.pt
calib=$(nix build --print-out-paths .#midstudy-calib)/bin/midstudy-calib
nix develop -c npm run eval:calib -- --cli "$calib"            # 53/60 (the 7 known golden misses)
nix develop -c npm run eval:calib -- --mock --cli "$calib"     # 47/47
MIDSTUDY_EVAL_ALIGN_CMD=$calib nix develop -c npm run eval:render   # 36/36
```

The darwin closure is 4.0 GiB (1.3 GB of it the weights); nothing roots it (`--no-link`), so `nix store gc` frees it.

## Results (2026-11-04, this session)

- `nix flake check --no-build --all-systems`: passes. A minimal x86_64-linux `nixosSystem` with the module and the
  suggested values evaluates (toplevel drv, no warnings or failed assertions, ExecStart as intended for `auto` and
  for the `cuda` shim). The VM test's script passes pyflakes. midstudy's x86_64-linux torch-bin `.drv` equals nook's
  (`mlhz62jx…-python3.13-torch-2.11.0.drv`).
- Built on aarch64-darwin: `midstudy-add`, `midstudy-calib` (utils3d and MoGe built with their runtime-deps and import
  checks), `moge-weights` (FOD path matched from the local HF cache, so the hash is right), `midstudy`.
- Nix-built `midstudy-calib` (Python 3.13, nixpkgs' torch 2.11 / numpy 2.4 / Pillow 12.3 / pillow-heif 1.4 /
  huggingface-hub 1.16 / OpenCV 4.13, weights offline from the store): E2 real 53/60 (same 7 misses as the uv build),
  golden-only 29/36, `--mock` 47/47; cameras within 0.02° of the uv build. E6 with its `align`: 36/36.
- Nix-built `midstudy-web` smoke test (scratch script, fal mocked, $0 cap, real MoGe): 10/10 (planner, Host 403,
  upload → `moge-2` calibration in 6.6 s, depth served, source not served, GLB via packaged `midstudy-add`, keep-room
  render aligned by packaged `align`, $0 spent). Logs in `evals/out/packaging/`.

The verify-phase fixer was editing `planner/`, `calib/` and `evals/` while I worked, so these builds packaged the
working tree as it was then. `serve.py` still takes every flag the module passes (checked at the end).

**Never built:** anything x86_64-linux (CUDA torch-bin, the Linux wheels of the Python deps, the module on a real
system, the VM test). That's the homeserver agent's job (HANDOFF §9).

## Decisions

- **One nixpkgs instance like nook's**, not a fresh unfree instance, so homeserver reuses nook's torch-bin and its
  from-source NCCL/NVSHMEM instead of building them again (hours).
- **Python 3.13** (nixpkgs' `python3`), because that's what nook's torch-bin is built for; calib's pyproject says
  <3.13 for uv only. The Mac run on 3.13 passes the same evals.
- **Weights as a fixed-output derivation** in a fake Hugging Face cache, with offline defaults the service can
  override (HANDOFF §8 has the writable-cache alternative). No code change needed.
- **The device as a shim**, since the CLI only takes `--device` after `run`/`fit`. `auto` (the default) passes the
  binary unchanged and keeps calib's CPU retry after a failed CUDA inference, which matters when nook-scan holds the
  GPU.
- **Port 8780**: clear of nook's module defaults (8096 web, 8095 api) and serve.py's 8765.
- **darwin outputs** exist so the packaging can be built and run on the Mac; homeserver only needs x86_64-linux.

## Seen while working (not mine to fix)

- **`.gitignore` no longer ignores `.env`.** Another agent's uncommitted edit (for photos without an extension, such
  as `AD9729E1-…_1_201_a`) added `/*`, `!/*.*`, `!/*/` after the existing rules. The two negations come later, so
  they win: `git status` now lists `?? .env` (the real FAL key), `?? .upstream/` and `?? node_modules/`
  (`git check-ignore -v .env` → `.gitignore:23:!/*.*`). Whoever commits must fix this first, e.g. by moving those
  three lines to the top of `.gitignore` so the specific rules below them (`.env`, `.upstream/`, `node_modules/`,
  the photo extensions) apply again, then check `git status` shows none of them. I didn't edit it: not my path, and
  its author was still working.

## Requests for other tracks (also in HANDOFF §13)

- calib: device from the environment (R1); a weights-path override (R2); widen `requires-python` to <3.14 (R3).
- app (`serve.py`): relative data-dir flags resolve into the read-only package; resolve against cwd (R4).
- evals: E2 `--mock` makes HEIC with macOS `sips` (fails on Linux); a way to run `eval:all` against the packaged
  server (R5).
