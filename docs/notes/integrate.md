# Integration notes

The integration agent took the three build tracks (calib, app, evals) on branch `v1`, ran every eval, ran the real
path on this Mac with real MoGe-2, fixed what was wrong, and committed. Everything below was run in this session
(2026-11-04, M3 Max, MPS). Logs and screenshots are in `evals/out/integrate/` and `evals/out/integrate-logs/`
(git-ignored).

## Results

| eval | result | notes |
|---|---|---|
| `npm run eval:all` (E1, E3–E9) | all pass | E1 129/129, E3 55/55, E4 **20/20** (one check added, below), E5 34/34, E6 36/36, E7 65/65, E8 39/39, E9 42/42 |
| `npm run eval:selftest` | 22/22 | |
| `npm run eval:calib -- --mock` | 47/47 | real `midstudy-calib`, no MoGe |
| `npm run eval:calib` (real MoGe-2) | **53/60, fails** | the same 7 golden-scene accuracy misses as the calib track reported (below); 3 checks added, all pass |
| `npm run eval:real` (new, `evals/real_path.mjs`) | 30/30 | the real path, end to end (below) |

## What changed in this phase

**Bugs fixed (code):**

- **Occlusion after Adjust floor** (`planner/engine.js`). `depth.png` is metric in the calibration's frame, but the
  depth pre-pass used it as is whatever the camera height. After the user changed the height in Adjust floor, the
  furniture lived in a rescaled world while the photo's depth didn't, so a piece behind the sofa could vanish behind
  the back wall, or one just in front of the sofa hide behind it. The pre-pass now scales the depth by
  `height_m / calib height_m` when calib.json has a measured floor (`moge-2` or `truth`, `floor.found`), else 1.
  New check **E4.15**: with the height ×1.25 and the probe box at 1.25 × its spot, hidden pixels match the photo
  (100 %) and the rest shows (100 %). With the fix removed it fails: 0 % of the box shows.
- **Empty library console error** (`planner/serve.py`). A library folder nothing had been added to (any fresh
  `--library-dir`, e.g. a new install's data dir) answered `/library/library.json` with 404, which the browser logs as
  a console error on every page load. It now answers an empty library (`{"version": 1, "items": []}`), as contract
  §2.2 already treated it. Found by the real path run.
- **Selection footprint over the letterbox** (`planner/ui/workspace.js`). When a piece came close to the camera its
  footprint polygon was drawn over the black bar below the photo. The overlay SVG (footprint, guide line, horizon,
  ruler) is now clipped to the visible photo rectangle. Seen in the real-path screenshots and fixed.

**Evals:**

- `evals/real_path.mjs` and `npm run eval:real` (not part of `eval:all`: it needs `fixtures/photos/` and the real
  model, about 80 s).
- `evals/scenes_api.mjs` E1.07 was flaky (an eval bug, failed once in three `eval:all` runs here): it waited for
  "early in a second" but not for a *new* second, so when the previous upload had taken the same second the pair got
  `-2` and `-3` and the check (`X2 === X1 + "-2"`) failed. It now starts its pair in a fresh second. The server was
  right (contract §4.2: `-2`, `-3`… on collision).
- `evals/occlusion.mjs`: E4.15 (above).
- `evals/calib_eval.py`: an extra check per golden scene, "depth.png shape: median error ≤ 3 % after one global
  scale", plus a self-test for it. It separates MoGe's scale bias from a broken depth map. It is **in addition to**
  PLAN.md's 10 % check, not a replacement, so nothing was loosened.
- Confirmed the evals track's two edits to carried files: `evals/library_api.sh` passes `--scenes-dir` instead of the
  removed `--room-dir` (contract §2.1 removed it), and `package.json`'s `check:scenes` runs
  `evals/py fixtures/check_scenes.py` (contract §5.1).
- Confirmed E6 sends `align` to the real `midstudy-calib` while scenes calibrate with the stub. Contract §4.3 says
  align "always runs for real" and §4.7 says the mock must apply, which the stub's align (always `applied: false`)
  cannot do.

**Contract** (`contract/CONTRACT.md`): §4.2/§4.3 now describe depth masking as built (at least 4 cm, in practice
`max(4 cm, 1.2 % of depth)`, plus everything below the floor plane; unmasked with `floor_masked: false` when no floor
is found). §4.5 gives the depth scale for a manual height. §2.8 notes the empty `library.json`. §2's "state" note and
§5.2 (`eval:real`) were updated. **CLAUDE.md**'s Evals section lists the task evals.

## E2 on the golden scenes: kept failing, on purpose

MoGe-2 (vitl) on the three CG renders, against `truth.json` (same numbers as the calib track, reproduced twice here):

| scene | fov (limit 5°) | height (limit 10 %) | depth median (limit 10 %) | depth after one global scale |
|---|---|---|---|---|
| living-wide | +7.46° **fail** | −15.4 % **fail** | 19.2 % **fail** | 0.7 % |
| steep-roll | +3.60° | −7.8 % | 10.3 % **fail** | 0.7 % |
| portrait | +5.85° **fail** | −10.9 % **fail** | 16.5 % **fail** | 1.1 % |

Pitch and roll are within 0.7° everywhere, signs included. **I did not loosen the eval:** PLAN.md §6.2 states these
tolerances outright, so it is not on the side of loosening them. I also did **not** change the golden scenes for
MoGe's sake. They pin the camera convention, projection and occlusion exactly (E3, E4, check_scenes), and their bias
is a CG look (flat lighting, a box "sofa", few size cues) that MoGe reads as a smaller room seen through a wider lens.
Restyling them until MoGe passed would make E2 measure the render's look, not the code. The code follows the contract
(MoGe's FOV wins; the golden photos have no EXIF to help). On the real photos MoGe's numbers are plausible: FOV 3.1°
from EXIF, coffee table 37–39 cm, sofa seat 45 cm, door 2.16–2.25 m (calib track), and the grid sits on the floor.

**For the plan owner** (PLAN.md §8 or §6.2): either accept these 7 as known misses on synthetic renders, or change
§6.2's golden tolerances (for example: pitch, roll and the scale-free depth shape on golden scenes; FOV and height
judged on real photos against EXIF and known sizes). `eval:all` does not include E2 (PLAN.md §6.2 E10), so it passes.

## The real path (`npm run eval:real`)

`evals/real_path.mjs` starts `serve.py` with the **default `--calib`** (`uv run --project calib midstudy-calib`, real
MoGe-2, no `MIDSTUDY_CALIB_MOCK`), the real `midstudy-add`, fal mocked, `--daily-spend-usd 0`, scratch data dirs, and
drives the planner in headless Helium at 1280 × 800. Screenshots `evals/out/integrate/NN-*.png`; I looked at each.

1. **New scene through the UI** (`scene-new` → file chooser → `fixtures/photos/upper-lounge-camera.jpeg`, 5712 × 3213
   P3 with EXIF): `POST /api/scenes` 202, the planner shows the calibrating card, MoGe-2 (vitl, MPS) calibrates in
   about 10 s (upload to done 10.9 s), the scene opens by itself. Camera `{fov 72.75, height 1.352, pitch −7.84,
   roll 0.26}`, EXIF 14 mm → 69.63°, no `fov_disagreement`, floor inliers 25 %, rmse 0.86 cm, depth on, occlusion on.
   The photo on screen matches `photo.jpg` at the planner's photo rect. (This check reads the rect from
   `window.midstudyCtx`: the evals' generic screen registration, `findPhotoOnScreen`, locked onto a slightly wrong
   scale on this photo's repeating curtains, 12 px off and median 11 once. It is fine on the golden scenes.)
2. **Adjust floor** opens with the horizon line and sliders (135 cm, 73.0°, 0.3°); Looks right without a change keeps
   `auto`.
3. **`upper-lounge.jpg`** (the same shot, no EXIF, 2000 × 1125) through `POST /api/scenes`: floor found, camera within
   0.31° and 4 mm of the camera original's. **A HEIC** made from it with `sips` (`IMG_0001.HEIC`): `source.heic` kept,
   `photo.jpg` 2000 × 1125, floor found, camera within 0.43° and 1 mm. (The HEIC is deleted after upload.)
4. **SheenChair.glb through the library API** (`addItemFromFile` → `POST /api/library/items`, kind model, engine glb):
   job done, estimate and cost $0, the planner's library shows it at 60 × 65 × 85 cm.
5. **Place:** a click on its Library row lands it at (0.00, 0, −2.00), on the rug in front of the coffee table, inside
   the frame. **Drag:** a mouse drag moves it to (−0.49, 0, −1.49), still on the floor, and it grows on screen
   (412 → 588 photo px tall). A second chair at (0.15, 0, −4.6), behind the coffee table: the table's top hides its
   lower half and legs, as it should.
6. **Save a layout** through the Layouts panel (Save layout… → name → Save as new): `two-chairs`, 2 items, `scene_name`
   set, not dirty.
7. **Render** (fal mock, $0) through the Render dialog: nano-banana with the scene photo as reference, layout named,
   capture 2048 × 1152. **Keep room exact on:** `-raw.jpg` kept, the real `midstudy-calib align` applied (about 2,940
   inliers, 0.05 px residual: the identity in mock mode).
8. **Compare** from the Renders panel (Compare → pick both): full-screen, side by side; Split shows the slider.
9. **Phone** (390 × 844): the same scene and layout load, no horizontal scroll, no errors.
10. No page errors, no console errors, no refused requests; the repo's own `scenes/`, `layouts/`, `renders/`,
    `library/` untouched. The scenes' `source.*` copies (the camera original with EXIF) are deleted at the end.

**Did the floor fit pick the real floor?** Yes, despite all three hard cases:

- **Ultrawide (0.5×, 14 mm):** MoGe's own intrinsics give 72.75° vertical against EXIF's 69.63°, so the pinhole fit
  holds; the metadata-free copy (no EXIF to lean on) lands within 0.3°. The grid's transverse lines run parallel to
  the rug's near edge and its receding lines along the rug's sides, the stone curb and the corridor.
- **Reflective marble:** the reflections of the ceiling spots are points *below* the floor plane; the fit ignores them
  (inliers need an up-facing normal and the plane within 4 cm), and depth.png zeroes everything below the plane. The
  calib track's depth overlay masks the rug and the whole marble floor out to the corridor, and leaves the curb, the
  glass, the sofa, the table, the stool and the bag unmasked.
- **The void behind the glass balustrade:** a lower floor seen through the glass would put the camera 4 m or more
  above "the floor"; the fit only accepts planes 0.15–3.5 m below the camera and weights the bottom of the image
  most, so it picks this floor (1.35 m, a hand-held phone at chest height). The grid continues past the curb over the
  void, as the y = 0 plane should.

Placed chairs read at a plausible size against the sofa and the coffee table, and the coffee table occludes the far
chair correctly. The depth edge is visibly stair-stepped along the table's rim (depth.png is 1024 px, sampled
nearest), PLAN.md §11's accepted halo.

## Open issues: resolved or left, with the reason

From the calib track:

- *E2 golden misses:* left failing, decided above.
- *depth.png masking beyond 4 cm, below-floor zeroing, unmasked depth without a floor:* **accepted** and written into
  the contract. Below-floor pixels can never hide a piece standing on the floor (the ray meets the floor first), and
  far floor is noisier than 4 cm. Without a floor the depth is unmasked, so the floor itself might hide a piece's feet
  until the user fixes the floor or turns Occlusion off. Such a scene opens in Adjust floor with "Check the floor".
- *MoGe reloads per fit (about 4 s of 10 s), 1.3 GB first download:* left. One calibration per photo, so 10 s is
  fine; a persistent worker would change the server's one-process-per-job model (contract §4.4).
- *Depth edge halos:* left (PLAN.md §11 accepts them; the toggle is the answer). An edge-aware upsample is a later
  improvement.
- *One real room only; no `fixtures/photos-public/`:* left. PLAN.md §5 asks for public photos only when
  `fixtures/photos/` is empty. More rooms are PLAN.md §8 step 2 (the user's own photos).
- *Extra Hugging Face checkpoints:* left for the user. `~/.cache/huggingface/hub` holds 3.0 GB; only
  `models--Ruicheng--moge-2-vitl-normal` is used. `models--Ruicheng--moge-2-vitl` (1.2 GB) and the vitb/vits ones
  can be deleted by hand. Not deleted here: it is outside the repo.
- *CUDA packaging for homeserver:* left for the packaging phase (PLAN.md §9).

From the app track:

- *Not tried on a real phone or iOS Safari:* left (needs the user's phone; PLAN.md §8). E9 and the real path cover
  390 × 844 touch in Helium. HEIC through the real calib now works end to end (real path step 3).
- *The §4.5 landing rule can put a piece inside real furniture:* left. The rule is the spec and E3 checks it; a
  depth-aware landing spot is a spec change for the plan owner.
- *Plain-photo thumbnails; "Render again" without keep-room; Compare only between renders; no undo for scene
  delete:* left as UX gaps for the verify phase. The server keeps deleted scenes in `scenes/.trash/`.
- *Evals sharing an `evals/out/<eval>/` folder must not run at once:* left; `eval:all` runs them one after another.

From the evals track:

- *E2 tolerances:* decided above. *`library_api.sh` and `package.json` edits:* confirmed. *E6's real align:*
  confirmed (above).
- *Suggested extra handles (`rotate`, `layout-save`, `renders`, `library`, `sheet-close`, `compare-split`):* not
  added. The desktop rail and the phone dock both render the panel tabs, so a handle per tab would exist twice
  (one hidden), against §4.6's one-handle-one-element convention, and the accessible names E9 uses have been stable
  through both tracks. Worth doing with a rule for per-mode duplicates if E9 starts breaking on labels.
- *Not automated (pinch, swipe, the ruler, the look):* left for the UX verifier.

## How to run

```sh
nix develop -c npm run eval:all                    # E1, E3–E9 (~4 min); -- --with-calib adds E2 (~1.5 min more)
nix develop -c npm run eval:real                   # the real path above (~80 s; needs fixtures/photos/ and calib/ synced)
nix develop -c npm run eval:calib                  # E2 with real MoGe (53/60: the 7 golden misses)
```

Everything mocks fal with a $0 cap; the evals set `MIDSTUDY_NO_DOTENV=1` and the mock themselves.
