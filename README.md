# midstudy

See furniture in your own room before you buy it. Take one photo of the room, add furniture at its real size, place
it on the floor in the photo, and render a realistic picture of the result.

A fork of [nook](https://github.com/salehtl/nook) without the room scan, for personal use.

## How it works

1. **Upload a room photo.** midstudy finds the floor and the camera in a few seconds and draws a grid on the floor.
   If the grid looks off, **Adjust floor** lets you fix it, and **Set scale** fixes sizes from a length you know.
2. **Add furniture** from a shop's product page, a photo, an image link, a 3D file (`.glb` or zipped OBJ), or a
   top-down rug picture. You give its real size in cm.
3. **Place it.** Drag to move, turn and lift pieces. Real furniture in the photo hides pieces behind it, and the
   furniture is lit by the light in your photo.
4. **Save layouts**, then **render** a realistic image and **compare** renders side by side.

It works on desktop and phone. The photo is the only viewpoint; zoom is a 2D zoom into it.

## Run it

Tools come from the Nix dev shell; nothing is installed globally.

```sh
nix develop -c npm ci                       # once
nix develop -c uv sync --project calib      # once: the floor-finding model (~1 GB)
nix develop -c npm run serve                # then open http://127.0.0.1:8765/
```

- **Paid features** (furniture from photos, renders) need a fal key: put `FAL_KEY=...` in a `.env` file at the repo
  root. Everything else works without it.
- **Spending** is capped at $2 a day by default; change it in **Settings** (⌘,). Every paid call is logged in
  `library/costs.csv`.
- **Your data** (scenes, layouts, renders, furniture) stays in the repo folder and isn't committed.
- There's no login: don't expose the server beyond your machine without access control in front of it.

## Costs

| Add furniture from | Cost |
|---|---|
| A photo or image link (Idol, the default) | $0.10 |
| A photo with SAM 3D / TRELLIS 2 | $0.02 / $0.25–0.35 |
| A product page | free to read (rarely under $0.001 more) |
| A 3D file or a flat rug | free |
| A render | about $0.04 |

## What's inside

- **Planner** (in the browser), **server** and the **`midstudy-add`** furniture tool: TypeScript.
- **Image, geometry and splat code:** Rust, compiled to WebAssembly.
- **Floor finding and lighting** (`calib/`): Python with the MoGe-2 model, kept loaded between photos.
- **Rendering:** WebGPU, with WebGL2 as a fallback (add `?webgpu=0` to the URL to force it).
- **Proofs** (`proofs/`): Lean proofs of the camera maths and the file-cleaning code.

## Check it

```sh
nix develop -c npm run check       # types, lint, tests, Rust, fuzzing, proofs
nix develop -c npm run eval:all    # the end-to-end tests (free: paid services are mocked)
```

## Docs

- [PLAN.md](PLAN.md) and [contract/CONTRACT.md](contract/CONTRACT.md): what midstudy does, exactly.
- [docs/STATUS.md](docs/STATUS.md): where things stand. [docs/REFACTOR.md](docs/REFACTOR.md): how v2 was built.
- [evals/README.md](evals/README.md): every test. [docs/HANDOFF.md](docs/HANDOFF.md): hosting on homeserver.
- [CLAUDE.md](CLAUDE.md): rules for agents working in this repo.
