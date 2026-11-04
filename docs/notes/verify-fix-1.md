# Verify round 1: fixes

The fixer for verify round 1 took the 30 findings of the three verifiers (UX, calibration visuals, contract and
security), fixed every high and medium one and most low ones, and added an eval for each fix. Everything below was run
in this session (2026-11-04, M3 Max). `nix/`, `flake.nix` and `docs/HANDOFF.md` were not touched (the packaging agent
owns them).

## Results

| eval | result | notes |
|---|---|---|
| `npm run eval:all` (E1, E3–E9, E11) | **all pass** | E1 156/156, E3 55/55, E4 20/20, E5 34/34, E6 36/36, E7 68/68, E8 41/41, E9 48/48, E11 28/28 (new) |
| `npm run eval:calib -- --mock` | 50/50 | 3 new ingest checks |
| `npm run eval:calib` (real MoGe-2) | 53/60 | the same 7 golden misses as integration (below); nothing else changed |
| `npm run eval:real` | 30/30 | the real path with real MoGe on the lounge photos |
| `npm run eval:selftest` | 22/22 | |
| `cd calib && uv run pytest -q` | 37/37 | 5 new ingest cases |

## High

- **Static paths served by case-insensitive spellings** (`/Scenes/<n>/source.jpg`, `/Library/costs.csv`,
  `/Fixtures/photos/…`) **and the whole repo as a static root** (scratch scenes under `evals/out/`, extensionless photos
  at the root). `planner/serve.py` `translate_path` is now an allowlist: `/planner/…`, `/library/…` (model.glb,
  splat.ply, thumb.jpg, library.json), `/scenes/…` (photo.jpg, depth.png, thumb.jpg) and `/renders/…`; everything
  else is 404 in any spelling. Every response gets `nosniff`. E1 checks 30 spellings.
- **Furniture photos kept EXIF/GPS, were served as `/library/<id>/source.jpg` and uploaded to fal as is.**
  `/library/<id>/source.*` is no longer served (contract §2.8). `midstudy-add` (`pipeline/…/cli.py` `engine_input`)
  gives the engines a metadata-free, upright copy, `raw/engine-input.jpg` (`.png` when the photo has transparency;
  ICC kept), for every image, not only HEIC; that is what `fal_client.upload_file` gets. E7 (server path) and E8 (CLI)
  check it with a GPS JPEG with orientation 6 and a PNG with eXIf/tEXt.

## Medium

- **Drag overshoot** (`planner/engine.js`): a move-drag now slides on the horizontal plane through the grabbed point
  (mesh hit, else the box, else the box's middle; kept 15 cm off eye height), so that point stays under the pointer.
  E11: a 30 px desktop drag on the upper front moves that point 30 px (±2; measured 0.0); a 3× zoomed phone drag lands
  within 6 px of the finger (measured 0.0).
- **Broken CSS** (`planner/styles/workspace.css`): the orphan `.ws-dimtag` line and the stray `}` are gone; E11 checks
  every sheet's braces and the parsed `.ws-loadcard` (20 px padding, 16 px gap, flex) and `.ws-mline`.
- **Reload showed an empty room**: the layout open in a scene is remembered per device (`midstudy.layout.<scene>` in
  localStorage, set on save and load, cleared when that layout is deleted) and `openScene` loads it (after the library,
  so pieces don't show as missing). E11 reloads and gets Phone A with its piece, not dirty.
- **Phone touch targets in Compare and the viewer**: the segmented controls are 44 px tall on the phone, the split's
  range input 44 px, the render prompt field 46 px. The harness's 44 px audit had skipped everything inside a
  `pointer-events: none` container (`#layer`, so every dialog, Compare and the viewer) and invisible range inputs; it
  now looks at the element's own `pointer-events`. E9 audits the viewer too.
- **Scene delete had no restore**: `GET /api/scenes` lists `trash` ({name, title, created, deleted}), `POST
  /api/scenes/<name>/restore` puts the newest copy and its layouts back (404 none, 409 exists, W1). The Scenes page has
  an Undo toast (`scene-undo`) and a Recently deleted section (`scene-restore`). The renders show again once restored.
- **Layout delete was permanent**: the server moves the file to `layouts/<scene>/.trash/`; the panel's toast has Undo
  (`layout-undo`), which PUTs back the layout it read before deleting.
- **Spend cap missed library adds with `--costs-file` alone**: any `--costs-file` that isn't `<library-dir>/costs.csv`
  is refused at startup, with or without `--library-dir`. E1 starts one and expects exit 1.
- **Clean-JPEG pass-through** (`calib/…/ingest.py`, `fixtures/stub_calib.py`): the whole file is walked (between
  progressive scans too) and a JPEG passes through only with no APP1–15/COM anywhere and nothing at all after EOI. The
  stub now drops trailing data and mid-scan segments when it strips. E2 `--mock`, E1 (stub) and pytest cover an appended
  GPS JPEG, EXIF between scans, a COM between scans, zero padding and an HTML trailer.
- **Furniture reads 3–12 % too large (golden), 5–25 % (lounge)**: see "Calibration scale" below.

## Low

Fixed: the rotate grip is clamped onto the visible photo, above the selection bar and left of the phone's lift column;
a mouse or pen press-drag on an unselected piece selects and drags it; Remove + Undo isn't "unsaved" (dirty compares
the pieces with the layout as saved or loaded); the phone Compare captions lead with the layout and stack, the split box
takes the render's own aspect (the line stays on the image), the viewer header names the layout; layout titles keep
the user's capitals (`title` in the layout file, contract §2.7, layout.schema.json); one toast at a time on the phone
(errors kept), the "Making …" toast is replaced by the done one; no stale tooltip after a grip drag (no tooltip during a
press, and a shown one hides when its element moves); the phone's horizon drag moves at most 0.12° per CSS px (the
handle lags the finger on a small photo; desktop at Fit is unchanged); "Search 1 item", "In the scene · n" counts
pieces, the layouts and renders lists wrap instead of cutting times and names (renders show the layout as their
title); SLUG and the asset regexes end in `\Z` (no trailing newline); thumbnails and render composites are stored,
served and sent without APPn/COM/trailer (`clean_jpeg`, no re-encode); two `Content-Length` headers are 400, the Host
must be exactly `name[:port]`, a 411/413 is sent before the body (then a 5 s drain), sockets time out after 30 s; size
messages round up ("25.1 MB"), a render over the whole cap says so; same-second scenes sort by suffix as a number.
`.gitignore` ignores extensionless files at the repo root (Apple Photos exports such as `AD9729E1-…_1_201_a`) and more
image extensions.

Left: **the scene API serves calib.json's camera make and model** (`calib.exif.make/model`, and `upload.filename`).
That is contract §4.2 as written; it carries no location. For the plan owner to decide. **Golden grid splay**
(0.6–3.3°): same cause as the scale finding; nothing to fix in the planner.

## Calibration scale (findings 16, 17, 18)

The size error is MoGe-2's: on the golden renders its FOV is 3.6–7.5° too wide and its height 8–15 % too low; on the
lounge the planner's floor reads the sofa seat 38.5 cm (user: about 45), the coffee table 29–32 cm (35–40). Projected
size goes roughly with 1 / camera height, so a 10 % low height draws furniture about 10 % too big. Nothing in the fit is
wrong in a way I could find: pitch and roll are right, and the depth shape is right after one scale (0.7–1.1 %).
What changed:

- **Set scale from a known length** (Adjust floor → Ruler → two taps → "Know its real length? [ ] cm · Set scale"):
  `engine.setRulerTrueLength` scales `height_m` by true / measured (every floor point under a pixel scales with the
  height), the ruler then reads the true length, Looks right saves it as a manual camera. E11 sets the golden camera
  15 % low, measures 1.887 m of floor as 1.604 m, types 188.7 cm, and gets the true 1.40 m back (±1 %).
- Not done, for the plan owner: using the EXIF FOV when the photo has one (PLAN.md §4.3 says MoGe's FOV wins; the calib
  track measured EXIF FOV on the lounge as height 1.394 / door 2.02 m vs 1.352 / 2.16 m), or changing E2's golden
  tolerances. E2 real keeps failing the same 7 checks on purpose (integrate.md).

## How to run

```sh
nix develop -c npm run eval:all            # E1, E3–E9, E11
nix develop -c npm run eval:ux             # E11 alone (~45 s)
nix develop -c npm run eval:calib -- --mock
nix develop -c bash -c 'cd calib && uv run pytest -q'
```

## Eval runs

Logs (git-ignored): `evals/out/fix1-all.log`, `evals/out/fix1-calib.log`, `evals/out/fix1-real.log`. Running two evals
that share `evals/out/calib/` at once (e.g. `eval:selftest` while `eval:calib` runs) corrupts the first one's output
(one real E2 run here lost a check that way and was rerun alone).
