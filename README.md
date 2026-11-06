# midstudy

See furniture in your own room before you buy it. The room is **one phone photo**. Furniture is made from photos at
real-world size (Idol or Meta's SAM 3D, on fal) or comes from a 3D file. You place the pieces on the photo's floor in the
browser, save layouts, and render a photoreal image of the result.

midstudy is a fork of [nook](https://github.com/salehtl/nook) without the room scan, for personal use. This is v2: the
same app rebuilt in strict TypeScript (the planner, the server and `midstudy-add`), with the hot paths in Rust compiled
to WebAssembly, Lean proofs of the camera model, and calibration still in Python with a warm worker
([docs/REFACTOR.md](docs/REFACTOR.md); where it ended: [docs/notes/cutover.md](docs/notes/cutover.md)). Where v1 stood
is in [docs/STATUS.md](docs/STATUS.md).

## How it works

1. **New scene.** You upload a room photo (JPEG, HEIC, PNG or WebP, up to 25 MB). MoGe-2 estimates the camera and the
   floor in a few seconds (about 1 s from the second photo on, while the server keeps the model loaded), and the scene
   opens with a 50 cm grid drawn on the floor.
2. **Adjust floor**, if the grid is off: sliders for camera height, field of view and roll, a draggable horizon line
   for the pitch, and a two-tap ruler. If you know a real length on the floor (a rug, a tile), type it in and
   **Set scale** fixes the size of everything.
3. **Add furniture** from the Library panel (below).
4. **Place it.** Tap a library item and it lands on the floor in front of the camera. Drag it to move it. The grip
   turns it, and Up / Down lifts it onto a table or shelf. Pieces behind real furniture in the photo are hidden by it
   (the **Occlusion** toggle, on when the scene has depth).
5. **Light.** The furniture is lit by the room's light, inferred from the photo: its direction, colour and
   brightness, with a soft shadow on the floor that real furniture in the photo hides. **Scene › Light & look** has
   Auto lighting (on) and Reset, a dial to drag the light's direction, strength, softness, ambient, exposure, warmth
   and the shadow toggles, saved per scene. Scenes made before this get their light the first time they open.
6. **Layouts.** Save several per scene and switch between them.
7. **Render.** One button sends the photo with the pieces to nano-banana on fal (about $0.04), with the original photo
   as a reference. **Keep room exact** (on by default) pastes only the furniture back into your untouched photo.
8. **Compare** two renders side by side or with a split slider.

The camera never moves: the photo is the only viewpoint. Pinch or wheel zoom is a 2D zoom into the photo (up to 4×),
and **Fit** resets it. It works on the desktop and on a phone (touch, 390 px wide).

## Run it locally

Everything comes from the flake's dev shell (Node 22, Python 3.12, uv, Rust with wasm32, git). Nothing is installed
globally.

```sh
nix develop -c npm ci                       # once: the Node packages (three.js, Spark, glTF-Transform, …)
nix develop -c uv sync --project calib      # once: MoGe-2 and torch, about 2.5 min, ~1 GB in calib/.venv
nix develop -c npm run serve                # builds (wasm kernels, planner bundle), then http://127.0.0.1:8765/
```

`npm run serve` is `node scripts/build.mjs` (incremental) then `node server/src/main.ts`: the server is TypeScript that
Node 22 runs directly, and it serves the bundled planner from `planner/dist/`.

- **fal key.** Paid calls (furniture from a photo or link, renders) read `FAL_KEY` from the environment or from a
  `.env` file at the repo root (`FAL_KEY=...`, git-ignored). Without it, everything else still works, including GLB
  and OBJ furniture.
- **Spend cap.** The server refuses paid calls past **$2 per UTC day** by default (`--daily-spend-usd`, `0` blocks
  them all). Every paid call is logged in `library/costs.csv`.
- **First calibration.** The first photo you upload downloads the MoGe-2 ViT-L weights (1.32 GB, about 20 s on a fast
  line) into `~/.cache/huggingface/hub`, outside the repo. The server runs calibration in a worker
  (`midstudy-calib serve`) that keeps the model loaded: the first photo after a start takes a few seconds, each later
  one about 1 s on an M-series Mac (MPS). The worker lets go of its memory after 10 idle minutes.
- **Your data** stays in the repo folder and is git-ignored: `scenes/` (one folder per photo), `layouts/`,
  `renders/`, and the furniture in `library/<id>/`. Only `library/library.json` and `library/costs.csv` are tracked.
- **Other flags:** `--port`, `--host`, `--scenes-dir`, `--library-dir`, `--layouts-dir`, `--renders-dir`,
  `--allowed-host NAME` (the server answers only loopback names unless you add one), `--calib`, `--midstudy-add`.
  Run `nix develop -c node server/src/main.ts --help`. The app has no login, so don't expose it beyond your machine
  without access control in front of it.

## Add furniture

In the planner: **Library › Add furniture**, then one of:

| Source | Engine | Cost |
|---|---|---|
| **A product page** (paste the shop's link, then **Read**) | the picture you pick goes to the engine below | free to read; under $0.001 more when only a language model can find the size |
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

### From a product page

Paste the shop's product link and press **Read**. The server reads the page and fills in the form: the name, W × D × H
in cm (a size picker when the shop sells several sizes, as rug shops do), the category, **Flat rug** when it's a rug,
and a strip of the page's pictures to pick from. Notes under the size say how it was read ("from inches", "length read
as width", "thickness not on the page: 1 cm assumed"). Check it, change anything, and **Make** sends the picture you
picked through the image-link add. Nothing is added before that.

It reads, cheapest and most exact first: the page's structured data (schema.org JSON-LD and microdata, OpenGraph), the
shop's own product data (Shopify's `.js` feed, the WooCommerce Store API), then the page's text, sizes in tables and
in the shop's embedded JSON. Only when none of that holds a size does a small language model on fal (Claude Haiku 5.5
through `openrouter/router`, $0.0001–0.0003 a page measured live, within the daily cap and logged in `costs.csv`) look for it in the
page's words. Every size it gives must quote text that's really on the page, or it's ignored, and the server converts
the units itself. Shops that refuse automatic reading (on 2026-11-05: West Elm, Wayfair, Crate & Barrel, Pottery Barn, Amazon) get "This shop blocks
automatic reading: paste the image link and size instead." with a button to switch to **Image link**. The reader
introduces itself as `midstudy/1.0 (product page reader)` and never downloads the pictures itself.

The same from the command line, from the repo root after `npm run build` (the planner picks it up on reload):

```sh
nix develop -c node pipeline/src/cli.ts chair.jpg --name "Strandmon wing chair" --dims 82x96x101
nix develop -c node pipeline/src/cli.ts chair.jpg --engine sam3d --name "Morris chair" --dims 70x80x95
nix develop -c node pipeline/src/cli.ts chair.glb --engine glb --name "Sheen chair" --dims 60x65x85
nix develop -c node pipeline/src/cli.ts rug.jpg --engine rug --name "Zen rug" --dims 160x230x1
nix develop -c node pipeline/src/cli.ts --help
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
5. **Light.** `lighting.json`: an ambient light (spherical harmonics) and one key light with its direction, colour,
   strength and softness, fitted from MoGe's normals and the photo's pixels in about a second (pairs of pixels across
   a crease of the same material compare the light on two sides). `midstudy-calib light <scene>` runs this step alone,
   which the server does for scenes calibrated before it existed. Details: [docs/notes/lighting.md](docs/notes/lighting.md).

If no floor is found, or MoGe can't run, the scene still opens with a fallback camera (EXIF field of view, else 55°,
height 1.40 m, pitch −10°) and asks you to check the floor. `--device auto|cuda|mps|cpu` picks the hardware (auto:
CUDA, then MPS, then CPU).

## Build and check

```sh
nix develop -c npm run build                # wasm kernels into build/wasm/, the planner into planner/dist/
nix develop -c npm run check                # every gate, one line each (about 45 min with Rust, fuzzing and proofs)
nix develop -c npm run check:types          # or one of them: types lint dead gen tests tscert planner py rust fuzz proofs
```

`check:types` is `tsc` in strict mode over the planner, server, CLI and kernel faces; `check:lint` is typescript-eslint
(no `any`, no casts, no `!`); `check:dead` is knip; `check:gen` keeps `contract/gen/` equal to what the schemas
generate; `check:tests` runs the node:test suites; `check:tscert` certifies the pure `logic/` modules with TScert
against `tscert/baseline.json`; `check:rust` is fmt, clippy, tests, Miri and Kani on `core/`; `check:fuzz` a minute per
fuzz target; `check:proofs` builds the Lean proofs in `proofs/`; `check:py` is pyright and ruff on `calib/`.
[CLAUDE.md](CLAUDE.md) has the commands behind each.

## Evals

All evals are free: fal is mocked, and they set the mock variables, a $0 cap and scratch data folders under
`evals/out/` themselves. They run the server and `midstudy-add` in strict mode, so every answer and file is also checked
against the contract's schemas. Browser evals run the flake's headless Chrome (`$PUPPETEER_EXECUTABLE_PATH`, or
`MIDSTUDY_BROWSER`), never a browser you browse with. Several agents share this Mac, so run each eval through the lock:
`nix develop -c node scripts/eval-lock.mjs -- npm run eval:…`. [evals/README.md](evals/README.md) describes every check.

```sh
nix develop -c npm ci                       # once
nix develop -c npm run eval:all             # E1, E3–E9, E11–E16 (about 10 min)
nix develop -c npm run eval:product         # E14: the product page reader on made-up shop pages (seconds)
nix develop -c npm run eval:product-ui      # E15: the Product page form, desktop and phone
nix develop -c npm run eval:product-live    # the golden set of real shop pages, from saved copies (-- --live: the web)
nix develop -c npm run eval:lighting        # E16: lighting from the photo, desktop and phone (about 2 min)
nix develop -c npm run eval:calib           # E2: real MoGe-2 on the golden scenes and fixtures/photos/
nix develop -c npm run eval:calib -- --mock # E2 ingest only, no model (seconds)
nix develop -c npm run eval:real            # the real path end to end on a photo from fixtures/photos/
nix develop -c npm run eval:selftest        # the eval machinery itself
nix develop -c npm run eval:perf -- --compare evals/perf/baseline.json   # E17: performance against v1's numbers
nix develop -c bash -c 'cd calib && uv run pytest -q'
```

The golden scenes (`fixtures/scenes/`) are CG rooms rendered from known cameras; `nix develop -c npm run check:scenes`
checks them. `fixtures/photos/` holds real room photos and is git-ignored.

## Hosting

The flake has packages (`midstudy`, `midstudy-calib`, `moge-weights`, `midstudy-add`) and a NixOS module
(`services.midstudy`) for hosting on homeserver next to nook. They were built and run on the Mac but never on Linux.
[docs/HANDOFF.md](docs/HANDOFF.md) has the build, verify and deploy steps for the agent that does it. **They still
package v1** (`planner/serve.py` and the Python `midstudy-add`), which the v2 cutover deleted: until the packaging is
redone for v2 (the Node server and CLI, `build/wasm/`, `planner/dist/`, `node_modules`), `midstudy` and
`midstudy-add` don't build from this tree; `midstudy-calib` and `moge-weights` are unchanged.

## Docs

- [PLAN.md](PLAN.md): the plan and the spec. [docs/REFACTOR.md](docs/REFACTOR.md): the v2 refactor.
- [contract/CONTRACT.md](contract/CONTRACT.md): files, routes, the camera model, the `window.midstudy` hook.
- [docs/STATUS.md](docs/STATUS.md): v1's status; [docs/notes/cutover.md](docs/notes/cutover.md): v2's, at the cutover.
- [docs/notes/](docs/notes/): what each build agent did and measured.
- [CLAUDE.md](CLAUDE.md): rules for agents working in this repo.
