# midstudy: hosting handoff (for the agent on homeserver)

You are taking over hosting midstudy on homeserver, next to nook. Nobody from the session that wrote this is around, so
everything you need should be here or linked from here. Read this whole file before you build anything.

## 1. What midstudy is

midstudy lets you see furniture in your own room before you buy it: the room is **one phone photo** (MoGe-2 fits the
camera and the floor), furniture comes from photos at real-world size (SAM 3D on fal) or GLB files, you place it on
the photo's floor in the browser, save layouts, and render a photoreal image (nano-banana on fal, about $0.04).
It is a fork of nook without the room scan, for the user's personal use.

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
  plan, `contract/CONTRACT.md` the spec.

## 3. Repo layout

| Path | What |
|---|---|
| `planner/` | the browser app (no build step; three.js from jsDelivr) and `planner/serve.py`, its stdlib-only server |
| `calib/` | `midstudy-calib` (uv project): photo ingest, MoGe-2 floor fit, keep-room alignment (contract §4.3) |
| `pipeline/` | `midstudy-add` (uv project): a furniture photo or model to a normalized library item (contract §3) |
| `contract/` | the spec (`CONTRACT.md`) and JSON schemas |
| `evals/` | the task evals (`evals/README.md`), run through `npm run eval:*` |
| `fixtures/` | golden scenes (`scenes/`, `calib/`), fal mock responses (`fal/`), test models |
| `nix/` | the packaging (below) |
| `flake.nix` | dev shells, `packages`, `nixosModules.default`, `checks.x86_64-linux.service` |
| `docs/notes/*.md` | what each build track did and measured; `docs/notes/packaging.md` is this packaging's notes |
| `library/library.json`, `library/costs.csv` | the (empty) dev library; user data dirs (`scenes/`, `layouts/`, `renders/`) are git-ignored |

## 4. What the flake gives you

| Output | File | What |
|---|---|---|
| `packages.x86_64-linux.midstudy` (= `default`) | `nix/midstudy.nix` | `bin/midstudy-web`: `planner/serve.py` with `--calib` and `--midstudy-add` pointing at the two packages below |
| `packages.x86_64-linux.midstudy-calib` | `nix/midstudy-calib.nix` | `bin/midstudy-calib` on torch-bin (CUDA 12.8 wheels), MoGe-2 (`nix/moge.nix`), utils3d (`nix/utils3d.nix`), OpenCV, pillow-heif |
| `packages.x86_64-linux.moge-weights` | `nix/moge-weights.nix` | MoGe-2 ViT-L weights (1.32 GB, fixed-output from Hugging Face) laid out as a read-only Hugging Face cache |
| `packages.x86_64-linux.midstudy-add`, `fal-client` | `nix/midstudy-add.nix`, `nix/fal-client.nix` | the furniture pipeline (as nook-add) |
| `nixosModules.default` | `nix/module.nix` | `services.midstudy` (§6) |
| `checks.x86_64-linux.service` | `nix/test.nix` | NixOS VM test of the module (KVM, no GPU; fal and MoGe mocked) |
| `packages.aarch64-darwin.*` | same files | the same packages for the Mac (MPS), used to check this packaging there |

How it runs: the host's proxy → `midstudy-web` on `127.0.0.1:<webPort>` → per uploaded photo one
`midstudy-calib run` (MoGe-2 on the GPU, about 10 s, one at a time) and per library add one `midstudy-add` (fal, or
local for GLB/OBJ). Everything lives in `dataDir`. There is one systemd service, `midstudy.service`.

Design points worth knowing:

- **torch-bin is shared with nook.** `nix/midstudy-calib.nix` imports its own nixpkgs instance configured exactly as
  nook's `nix/nook-gsplat.nix` (allowUnfree, `cudaCapabilities = [ "7.5" ]`, the NVSHMEM overlay), and `flake.lock`
  pins the same nixpkgs revision as nook's (`1f607aa`). On the Mac I checked that midstudy's torch-bin derivation is
  identical to nook's: `/nix/store/mlhz62jxki58b0k3jik6h6q13kypfgsw-python3.13-torch-2.11.0.drv`. If homeserver's nook was
  built from that revision, torch-bin and its CUDA libraries (NCCL and NVSHMEM are built from source, which took hours
  for nook) are already in homeserver's store and nothing CUDA is rebuilt. If nook's lock has moved on since, either
  update midstudy's lock to nook's revision (`nix flake lock --override-input nixpkgs github:nixos/nixpkgs/<rev>`)
  or accept the long first build.
- **Python 3.13.** The package uses nixpkgs' `python3` (3.13), the one nook's torch-bin is built for. `calib/` was
  developed on 3.12 under uv; the Nix build runs it on 3.13 with nixpkgs' versions (torch 2.11, numpy 2.4, Pillow
  12.3, pillow-heif 1.4, huggingface-hub 1.16, opencv 4.13).
- **Weights offline.** The `midstudy-calib` wrapper sets `HF_HUB_CACHE=<moge-weights>` and `HF_HUB_OFFLINE=1` as
  defaults (`--set-default`), so the service never talks to Hugging Face. §8 has the alternative.
- **Device.** `calibDevice = "auto"` passes the plain binary (the CLI defaults to auto). Other values make the module
  pass a small shim as `--calib` that appends `--device <x>` to `run`/`fit` (serve.py appends the subcommand and its
  arguments to `--calib`, and `align`/`ingest` take no `--device`).

## 5. What was checked, and what was not

Everything below was done on the Mac (aarch64-darwin, M3 Max) on 2026-11-04. **Nothing x86_64-linux was built, and
nothing ran on homeserver, on a CUDA GPU, or in a NixOS VM.**

Evaluated for x86_64-linux (nothing built):

- `nix flake check --no-build --all-systems`: every output evaluates (packages for both systems, the module, the VM
  test, the dev shells).
- A minimal x86_64-linux `nixosSystem` importing the module with the §6 values: the system's toplevel derivation
  evaluates with no warnings and no failed assertions; the `video` and `render` groups exist; `ExecStart` is
  `…-midstudy-0.1.0/bin/midstudy-web --host 127.0.0.1 --port 8780 --scenes-dir /var/lib/midstudy/scenes
  --library-dir /var/lib/midstudy/library --layouts-dir /var/lib/midstudy/layouts --renders-dir
  /var/lib/midstudy/renders --calib …/bin/midstudy-calib --daily-spend-usd 2 --allowed-host midstudy.salehtl.com`
  (with `calibDevice = "cuda"`, `--calib` is the shim `…-midstudy-calib-cuda`).
- midstudy's x86_64-linux torch-bin derivation is the same `.drv` as nook's (§4).
- The VM test's Python script, extracted from the evaluated check, passes pyflakes.

Built and run on the Mac (aarch64-darwin: the same Nix files, with torch-bin's macOS wheel, 2.11.0, MPS):

- `nix build` of `midstudy-add`, `midstudy-calib`, `moge-weights` and `midstudy` succeeds. That includes building
  utils3d and MoGe from source with nixpkgs' runtime-dependency and import checks, and the calib install check that
  imports every module the CLI loads lazily. The weights' fixed-output path was produced from the Mac's own Hugging
  Face cache of the same revision (`nix-store --add-fixed`) and matched the derivation's store path, so the hash is
  right. Nix itself never downloaded that URL.
- **The Nix-built `midstudy-calib`** (Python 3.13, nixpkgs' library versions, weights read offline from the store):
  E2 real **53/60**, the same 7 golden-scene misses as the uv build (known MoGe bias on CG renders,
  `docs/notes/integrate.md`). The real photos pass (lounge: fov 72.77° against EXIF 69.6°, floor found, about 6 s
  each). Golden only (`--no-real-photos`): **29/36**. E2 `--mock` (ingest: HEIC, Display P3, PNG, WebP, EXIF
  rotation, downsizing, metadata stripping, the 25 MB limit): **47/47**. Cameras agree with the uv build's within
  0.02°. **These Nix runs predate verify round 2**, which changed `calib/` (the EXIF FOV and scale correction,
  contract §4.3) and added checks. The uv build after it gives E2 real 84/91 (golden only 59/66, the same 7 misses)
  and `--mock` 51/51; the Nix build was not rebuilt or re-run after that change, and the Mac's store copy has since
  been garbage-collected.
- E6 `eval:render` with `MIDSTUDY_EVAL_ALIGN_CMD` set to the Nix-built `midstudy-calib`: **36/36** (keep-room align on
  nixpkgs' OpenCV).
- **The Nix-built `midstudy-web`**, started like the service (absolute scratch dirs, `--allowed-host`, $0 cap,
  fal mocked, no calib mock): **10/10** smoke checks. The planner is served; a foreign Host gets 403; a golden photo
  upload calibrates with real MoGe-2 through the packaged calib (6.6 s, `source: moge-2`); `depth.png` is served and
  `source.jpg` isn't; a GLB goes in through the packaged `midstudy-add`; a keep-room render (mock) is aligned by the
  packaged `align` (1634 inliers); $0 spent.

Never built or run (all yours, in the order of §9):

- every `x86_64-linux` package: `midstudy-calib` with CUDA torch-bin (and whether the CUDA wheel sees the RTX 2060
  from inside the hardened service), `moge`/`utils3d` against torch-bin's Linux wheel, `midstudy-add`, `midstudy`,
  the `moge-weights` download from Hugging Face (its hash was checked against the Mac's cached copy of the same
  revision, not by downloading);
- the NixOS module on a real system: users, tmpfiles, hardening, EnvironmentFile, the device shim;
- the VM test `checks.x86_64-linux.service` (evaluated only);
- the proxy, the host name, TLS, and the live fal path from homeserver.

## 6. Service options and suggested values

| Option | Default | Suggested on homeserver | Notes |
|---|---|---|---|
| `enable` | false | true | |
| `webPort` | 8780 | 8780 | nook's module defaults are `webPort` 8096 and `apiPort` 8095; serve.py's own default (and nook-web's when run by hand) is 8765, and nook's web app may sit in that 8765 range. 8780 clashes with none of those, but **check** with `ss -ltnp` that nothing on homeserver uses it. |
| `dataDir` | `/var/lib/midstudy` | `/var/lib/midstudy` | scenes, library, layouts, renders; also the service's HOME (torch and HF write small caches under `.cache/`) |
| `falKeyFile` | null | `/run/secrets/midstudy-fal` (or whatever path homeserver's secrets use; see how nook's `services.nook.falKeyFile` is set and mirror it) | `FAL_KEY=...` in an EnvironmentFile, root-only is fine (systemd reads it). The same fal account as nook is fine; the caps are per service. |
| `dailySpendUsd` | 2 | 2 | per UTC day, covers library adds from photos and renders; `0` blocks all paid calls |
| `allowedHosts` | `[ ]` | `[ "midstudy.salehtl.com" ]` | the name the proxy serves it under (nook serves `https://nook.salehtl.com/planner/`). Pick the name with the user. |
| `calibDevice` | `"auto"` | `"auto"` | auto retries a failed CUDA inference (e.g. out of memory while nook-scan trains) on the CPU; `"cuda"` doesn't retry (the scene then gets an EXIF/default camera); `"cpu"` never touches the GPU |
| `package` | this flake's `midstudy` | default | |

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
  "FAL_KEY not set".
- **Data dir** (created by tmpfiles, `midstudy:midstudy`, 0750): `scenes/<scene>/` (photo.jpg, depth.png, calib.json,
  scene.json, thumb.jpg and `source.<ext>`, the upload as given, never served), `scenes/.trash/`, `layouts/<scene>/`,
  `renders/`, `library/` (library.json, costs.csv, one folder per item, `.trash/`). Back up the whole folder;
  `library/costs.csv` is the spend record the cap reads.

## 8. MoGe weights

Default: nothing to do. `nix build .#moge-weights` downloads `model.pt` (1.32 GB) from
`https://huggingface.co/Ruicheng/moge-2-vitl-normal/resolve/cb0e8bbd6b1e243589717c78e750b1ba4c093acf/model.pt`
(fixed-output, SHA-256 `280741fd…1a01`; no Hugging Face login needed) and the calib wrapper reads it offline from the
store. It's part of the service's closure, so a `nixos-rebuild` fetches it.

Alternative (only if the store copy is a problem, or the user wants `--model vitb|vits`): a writable cache the
service seeds itself on first use. Set `systemd.services.midstudy.environment = { HF_HUB_CACHE =
"/var/lib/midstudy/.cache/huggingface/hub"; HF_HUB_OFFLINE = "0"; };` (the wrapper's values are only defaults). The
first calibration then downloads the weights (about 20 s on a fast line, inside the 600 s job timeout). To pre-seed
instead: `sudo -u midstudy env HOME=/var/lib/midstudy HF_HUB_CACHE=/var/lib/midstudy/.cache/huggingface/hub
HF_HUB_OFFLINE=0 $(nix build --print-out-paths .#midstudy-calib)/bin/midstudy-calib run
<repo>/fixtures/scenes/living-wide/photo.jpg --out /tmp/seed` and delete `/tmp/seed`.

If the weights are missing or unreadable, calibration does not fail: it falls back to the EXIF or default camera
(`calib.json` `source: "exif"|"default"`, `fallback_reason`), and the planner asks the user to check the floor. So
after deploying, check that a real calibration says `"source": "moge-2"` and `"device": "cuda"` (§9 step 9).

## 9. Verify, in this order

Run everything from the repo root. `nix develop -c <cmd>` gives python 3.12, uv, node 22 and git.

1. **Evaluate.** `nix flake check --no-build` and `nix flake show`. Cheap; catches a bad merge.
2. **Small builds.** `nix build .#midstudy-add .#fal-client -L`. The install check runs `midstudy-add --help`.
3. **torch-bin is nook's.** `nix eval --raw .#midstudy-calib.torch.drvPath`, then
   `nix path-info $(nix eval --raw .#midstudy-calib.torch)`: if it's already valid, nook built it and step 5 builds
   nothing CUDA. If not, see §4 (lock to nook's revision first; the from-source CUDA build takes hours).
4. **Weights.** `nix build .#moge-weights -L` (1.32 GB download, hash-checked).
5. **Calib.** `nix build .#midstudy-calib -L`. Builds utils3d and MoGe (their import checks load torch, which needs
   no GPU) and runs an install check that imports every module the CLI loads lazily.
6. **Calib on the GPU, by hand.**
   `out=$(nix build --print-out-paths .#midstudy-calib); $out/bin/midstudy-calib run fixtures/scenes/living-wide/photo.jpg --out /tmp/ms-cal --device cuda`.
   The last stdout line is JSON: expect `"source": "moge-2"`, `"device": "cuda"`, `"floor": {"found": true…}` and
   roughly the Mac's numbers for this CG scene (fov 62.5, height 1.185, pitch −9.3, roll −0.05; MoGe misreads the
   CG room's scale, so don't compare with the truth 55 / 1.40). If `device` says `cpu`, torch can't see the GPU:
   check `nvidia-smi`, `/run/opengl-driver/lib`, and that you're in the `video`/`render` groups. Delete `/tmp/ms-cal`.
7. **E2 with the packaged CLI.**
   `nix develop -c npm install` once, then
   `nix develop -c npm run eval:calib -- --cli "$out/bin/midstudy-calib" --no-real-photos`.
   On the Mac (uv build, after verify round 2, 2026-11-05) this gives **59/66**, failing E2.06, E2.07, E2.11, E2.33,
   E2.50, E2.51 and E2.55: MoGe's known FOV and scale bias on the CG golden scenes, which carry no EXIF
   (docs/notes/integrate.md, verify-fix-2.md); pitch, roll, the depth shape and every "+ EXIF" variant pass. Expect
   the same set on CUDA, within a few tenths of a degree. (The 29/36 in §5 is from before verify round 2 added the
   "+ EXIF" checks.) The user's real photos are not on homeserver, so `--no-real-photos` is required; `--mock` makes a HEIC
   with macOS `sips` and fails that case on Linux (request R5).
8. **The VM test.** `nix build .#checks.x86_64-linux.service -L` (needs `/dev/kvm`). Boots a VM with the module,
   checks the planner, the Host rule (403 for a foreign Host), a photo upload calibrating (calib mocked), and a GLB
   added through `midstudy-add`, all under the service's hardening.
9. **Deploy** (§6, §10): add the input, enable the module, add the secret and the proxy route, rebuild. Then:
   `systemctl status midstudy`, `journalctl -u midstudy -e`, `curl -s localhost:8780/api/scenes`,
   `curl -s localhost:8780/api/spend`. Upload a photo through the site and check
   `/var/lib/midstudy/scenes/<scene>/calib.json` says `"source": "moge-2"` and `"device": "cuda"`, and that the
   grid sits on the floor. Delete that scene in the UI if it was only a test (it moves to `scenes/.trash/`).
10. **The browser evals** (optional on homeserver; they test the repo's `serve.py`, not the package): §11.
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

## 11. Running the evals on homeserver

They're $0: every eval starts its own `planner/serve.py` from the repo with fal mocked, `MIDSTUDY_NO_DOTENV=1` and a
$0 cap, on a free port, with scratch data under `evals/out/` (git-ignored), and never touches `dataDir`.

```sh
nix develop -c npm install                                   # once
nix develop -c uv sync --project pipeline                    # once: E7/E8 run midstudy-add through uv (E8 with --offline)
nix develop -c npm run eval:selftest                         # the eval machinery
chromium=$(nix build --inputs-from . --no-link --print-out-paths nixpkgs#chromium)/bin/chromium
out=$(nix build --print-out-paths .#midstudy-calib)
MIDSTUDY_BROWSER=$chromium MIDSTUDY_EVAL_ALIGN_CMD="$out/bin/midstudy-calib" nix develop -c npm run eval:all
nix develop -c npm run eval:calib -- --cli "$out/bin/midstudy-calib" --no-real-photos   # E2, §9 step 7
```

- `eval:all` is E1, E3–E9, E11 and E12 (scenes API, planner, occlusion, floor, render, library, pipeline, phone, and
  the two verify rounds' UX regressions); on the Mac all pass. The browser evals were only ever run in Helium on macOS; Linux Chromium with swiftshader should work
  (`--use-angle=swiftshader --enable-unsafe-swiftshader --ignore-gpu-blocklist`) but is untried.
  `MIDSTUDY_EVAL_ALIGN_CMD` makes E6 use the packaged `align` instead of `uv run --project calib` (the other evals
  calibrate with the stub, `fixtures/stub_calib.py`). On the Mac, E6 with the Nix-built align passed 36/36.
- `eval:real` needs the user's photos (`fixtures/photos/`, not in the repo): skip it.
- `uv sync --project calib` on Linux would pull PyPI's CUDA 13 torch (2.15) into `calib/.venv` (several GB); you only
  need it without `MIDSTUDY_EVAL_ALIGN_CMD`, or to run `calib/`'s own tests
  (`nix develop -c bash -c 'cd calib && uv run pytest -q'`).
- `evals/py` (used by E2 and the self-test) runs `uv run --no-project --python 3.12 --with …`: it needs the network
  the first time.
- Evals that write to the same `evals/out/<eval>/` must not run at the same time.

## 12. The live checks (PLAN.md §8): with the user only

These spend real money and need the user's go-ahead in chat each time:

1. About $0.20: two renders of a furnished layout on a real photo, keep-room on and off, to decide keep-room's
   default; then one SAM 3D add (a furniture photo) to confirm the pipeline against live fal. On the Mac these were
   planned for the main session; if the user asks you to run them on the deployed site instead, check
   `GET /api/spend` before and after.
2. The user's own photos through Adjust floor, to see how often the automatic fit needs fixing.
3. Hosting (this file).

## 13. Requests for code changes (collected by the packaging agent)

None of these block hosting; the packaging works around each one.

- **R1 (calib):** let `midstudy-calib` take the device from the environment (e.g. `MIDSTUDY_CALIB_DEVICE`, used when
  `--device` isn't given). Then the module can set an environment variable instead of passing the shim in
  `nix/module.nix` as `--calib`.
- **R2 (calib):** a weights override (e.g. `MIDSTUDY_MOGE_WEIGHTS=<model.pt>`, passed straight to
  `MoGeModel.from_pretrained`, which accepts a file path). The package could then point at the store file instead of
  building a Hugging Face cache layout that relies on huggingface_hub's offline behaviour.
- **R3 (calib):** `calib/pyproject.toml` says `requires-python = ">=3.12,<3.13"`, while the Nix package runs it on 3.13.
  Widen it to `<3.14` once the calib tests have run on 3.13 (the Nix build ran the CLI on 3.13 on the Mac, §5).
- **R4 (planner/serve.py):** relative `--scenes-dir`/`--library-dir`/`--layouts-dir`/`--renders-dir` resolve against
  the repo, which is read-only in the package; resolve them against the working directory when the server isn't
  running from a checkout (or say so in `--help`). The module passes absolute paths, so this only affects people
  running `midstudy-web` by hand.
- **R5 (evals):** E2 `--mock` makes its HEIC with macOS `sips`; on Linux use pillow-heif to write it, or skip that
  case with a reason. And a way to run `eval:all` against the packaged server (e.g. `MIDSTUDY_EVAL_SERVE="<cmd>"` in
  `evals/lib/harness.mjs` instead of `python3 planner/serve.py`), so homeserver can test what it deploys.

## 14. Risks to watch

- **GPU contention with nook-scan.** Both use the RTX 2060 (6 GB). MoGe-2 ViT-L in fp16 at 1024 px needs about
  2–3 GB; while nook trains it may run out of memory. With `calibDevice = "auto"` that is retried on the CPU (slower,
  same result). No shared lock: nook's `/run/nook/gpu.lock` is held for whole training runs, longer than the 600 s
  calibration timeout.
- **CUDA 12.8 wheels on sm_75.** nook's gsplat runs on this torch-bin on homeserver, so the RTX 2060 is supported.
- **Hardening.** Copied from nook's module (no `PrivateDevices`, no `MemoryDenyWriteExecute`, which CUDA needs).
  If torch can't open `/dev/nvidia*`, check the device permissions before loosening anything else.
- **Python 3.13 and nixpkgs' library versions** differ from the uv lock calib was developed with (§4). The Mac run
  with exactly these versions is in §5.
