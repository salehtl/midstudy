# midstudy

See furniture in your own room before you buy it. The room is **one phone photo**. Furniture is made from photos at
real-world size (Idol or Meta's SAM 3D, on fal) or comes from a 3D file. You place the pieces on the photo's floor in the
browser, save layouts, and render a photoreal image of the result.

midstudy is a fork of [nook](https://github.com/salehtl/nook) without the room scan, for personal use. Where things
stand is in [docs/STATUS.md](docs/STATUS.md).

## How it works

1. **New scene.** You upload a room photo (JPEG, HEIC, PNG or WebP, up to 25 MB). MoGe-2 estimates the camera and the
   floor in about 10 s, and the scene opens with a 50 cm grid drawn on the floor.
2. **Adjust floor**, if the grid is off: sliders for camera height, field of view and roll, a draggable horizon line
   for the pitch, and a two-tap ruler. If you know a real length on the floor (a rug, a tile), type it in and
   **Set scale** fixes the size of everything.
3. **Add furniture** from the Library panel (below).
4. **Place it.** Tap a library item and it lands on the floor in front of the camera. Drag it to move it. The grip
   turns it, and Up / Down lifts it onto a table or shelf. Pieces behind real furniture in the photo are hidden by it
   (the **Occlusion** toggle, on when the scene has depth).
5. **Layouts.** Save several per scene and switch between them.
6. **Render.** One button sends the photo with the pieces to nano-banana on fal (about $0.04), with the original photo
   as a reference. **Keep room exact** (on by default) pastes only the furniture back into your untouched photo.
7. **Compare** two renders side by side or with a split slider.

The camera never moves: the photo is the only viewpoint. Pinch or wheel zoom is a 2D zoom into the photo (up to 4×),
and **Fit** resets it. It works on the desktop and on a phone (touch, 390 px wide).

## Run it locally

Everything comes from the flake's dev shell (Python 3.12, uv, Node 22, git). Nothing is installed globally.

```sh
nix develop -c uv sync --project calib      # once: MoGe-2 and torch, about 2.5 min, ~1 GB in calib/.venv
nix develop -c uv sync --project pipeline   # once: midstudy-add
nix develop -c npm run serve                # http://127.0.0.1:8765/
```

- **fal key.** Paid calls (furniture from a photo or link, renders) read `FAL_KEY` from the environment or from a
  `.env` file at the repo root (`FAL_KEY=...`, git-ignored). Without it, everything else still works, including GLB
  and OBJ furniture.
- **Spend cap.** The server refuses paid calls past **$2 per UTC day** by default (`--daily-spend-usd`, `0` blocks
  them all). Every paid call is logged in `library/costs.csv`.
- **First calibration.** The first photo you upload downloads the MoGe-2 ViT-L weights (1.32 GB, about 20 s on a fast
  line) into `~/.cache/huggingface/hub`, outside the repo. After that, each photo takes about 10 s on an M-series Mac
  (MPS), of which about 4 s is loading the model.
- **Your data** stays in the repo folder and is git-ignored: `scenes/` (one folder per photo), `layouts/`,
  `renders/`, and the furniture in `library/<id>/`. Only `library/library.json` and `library/costs.csv` are tracked.
- **Other flags:** `--port`, `--host`, `--scenes-dir`, `--library-dir`, `--layouts-dir`, `--renders-dir`,
  `--allowed-host NAME` (the server answers only loopback names unless you add one), `--calib`, `--midstudy-add`.
  Run `nix develop -c python3 planner/serve.py --help`. The app has no login, so don't expose it beyond your machine
  without access control in front of it.

## Add furniture

In the planner: **Library › Add furniture**, then one of:

| Source | Engine | Cost |
|---|---|---|
| A photo of the piece | **Idol** (default), SAM 3D or TRELLIS 2 | $0.10 (Idol), $0.02 (SAM 3D), $0.25–0.35 (TRELLIS 2) |
| An image link (the image's own URL, not the shop page) | same | same |
| A 3D file: `.glb` or a zipped OBJ (the CLI also takes `.gltf`) | none | free |
| A rug pictured from straight above (a shop's rug picture) | **Flat rug**: laid flat at W × D, H is its thickness (~1 cm) | free |

Every add needs the real size, **W × D × H in cm**, and the piece is scaled to it. The price and today's remaining
budget show before you confirm. Adds run as jobs in the Library panel. Furniture photos are stripped of their
metadata before they go to fal. When SAM 3D finds nothing in a photo (it can miss the word it's given), it tries again
by itself, first less strictly, then with a mask of the piece; the refused calls aren't charged.

The engines make different things:

- **Idol** ([speridlabs/idol](https://github.com/speridlabs/idol)) makes a Gaussian splat: a cloud of soft,
  coloured points that looks like the photo of the piece, at about 3 MB. It has no mesh. A box at the piece's size
  stands in for it: it's what you tap and drag, and it casts the contact shadow, but it is never drawn.
- **SAM 3D** makes a mesh and a splat. The splat is shown by default; the piece's **Edit** sheet has **Shows as**
  (Splat or Mesh), and pieces already placed switch at once.
- **TRELLIS 2** makes a textured mesh with finer detail.

The planner draws splats with [Spark](https://sparkjs.dev) 2.4.0. Their colours are the photo's own, so the
**Look** sliders only brighten or warm them; meshes are lit and tone-mapped. The real furniture in the room photo
hides both. Renders include splats like any other piece.

The same from the command line (the planner picks it up on reload):

```sh
nix develop -c uv run --project pipeline midstudy-add chair.jpg --name "Strandmon wing chair" --dims 82x96x101
nix develop -c uv run --project pipeline midstudy-add chair.jpg --engine sam3d --name "Morris chair" --dims 70x80x95
nix develop -c uv run --project pipeline midstudy-add chair.glb --engine glb --name "Sheen chair" --dims 60x65x85
nix develop -c uv run --project pipeline midstudy-add rug.jpg --engine rug --name "Zen rug" --dims 160x230x1
nix develop -c uv run --project pipeline midstudy-add --help
```

Item conventions: meters in 3D, centimeters in `dims_cm` and `--dims`; Y-up; the origin is the center of the
footprint on the floor, and the front faces +Z. `--yaw 90|180|270` turns a model whose front faces the wrong way.

## How calibration works

`midstudy-calib` (in `calib/`, contract §4.3) runs once per uploaded photo:

1. **Ingest.** Applies the EXIF orientation, converts to sRGB (iPhones write Display P3), downsizes to a 2048 px long
   side and writes `photo.jpg` with **no metadata at all**, since that file is served and sent to fal. The upload is
   kept as `source.<ext>` (EXIF and location included), which is never served and goes to the trash with the scene.
2. **Fit.** MoGe-2 (ViT-L) turns the photo into a metric 3D point map with normals. A RANSAC fit finds the floor
   plane, preferring up-facing points low in the image, so a shiny floor's reflections or a lower floor seen through
   glass don't win. The plane gives the camera's height, pitch and roll; MoGe's intrinsics give the field of view.
3. **EXIF focal length.** MoGe reads the field of view a few degrees too wide and the room correspondingly too small.
   When the photo's EXIF focal length (35 mm equivalent) gives a field of view within 8° of MoGe's, that one is used
   and the camera height and depth are scaled by the focal ratio. Photos without EXIF (screenshots, chat copies,
   edited exports) keep MoGe's estimate; check those with the ruler and **Set scale**.
4. **Depth.** `depth.png` (metric, 1024 px) drives occlusion. The floor and everything below it are zeroed, so the
   floor never hides a piece standing on it.

If no floor is found, or MoGe can't run, the scene still opens with a fallback camera (EXIF field of view, else 55°,
height 1.40 m, pitch −10°) and asks you to check the floor. `--device auto|cuda|mps|cpu` picks the hardware (auto:
CUDA, then MPS, then CPU).

## Evals

All evals are free: fal is mocked, and they set the mock variables, a $0 cap and scratch data folders under
`evals/out/` themselves. Browser evals run headless Helium (`/Applications/Helium.app`, or `MIDSTUDY_BROWSER`).
[evals/README.md](evals/README.md) describes every check.

```sh
nix develop -c npm install                  # once
nix develop -c npm run eval:all             # E1, E3–E9, E11–E13 (about 10 min)
nix develop -c npm run eval:calib           # E2: real MoGe-2 on the golden scenes and fixtures/photos/
nix develop -c npm run eval:calib -- --mock # E2 ingest only, no model (seconds)
nix develop -c npm run eval:real            # the real path end to end on a photo from fixtures/photos/
nix develop -c npm run eval:selftest        # the eval machinery itself
nix develop -c bash -c 'cd calib && uv run pytest -q'
```

The golden scenes (`fixtures/scenes/`) are CG rooms rendered from known cameras; `nix develop -c npm run check:scenes`
checks them. `fixtures/photos/` holds real room photos and is git-ignored.

## Hosting

The flake has packages (`midstudy`, `midstudy-calib`, `moge-weights`, `midstudy-add`) and a NixOS module
(`services.midstudy`) for hosting on homeserver next to nook. They were built and run on the Mac but never on Linux.
[docs/HANDOFF.md](docs/HANDOFF.md) has the build, verify and deploy steps for the agent that does it.

## Docs

- [PLAN.md](PLAN.md): the plan and the spec.
- [contract/CONTRACT.md](contract/CONTRACT.md): files, routes, the camera model, the `window.midstudy` hook.
- [docs/STATUS.md](docs/STATUS.md): what works, what was checked, what's left.
- [docs/notes/](docs/notes/): what each build agent did and measured.
- [CLAUDE.md](CLAUDE.md): rules for agents working in this repo.
