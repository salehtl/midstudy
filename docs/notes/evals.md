# Evals track notes

> **Since verify round 1 (see `verify-fix-1.md`):** new `evals/ux_fixes.mjs` (**E11**, `npm run eval:ux`, part of
> `eval:all`) and `evals/lib/metadata.py` (synthetic GPS photos and a whole-file inspector). E1, E2 `--mock`, E7, E8 and
> E9 gained checks for the security and privacy fixes. **The 44 px audit (`smallTargets`) was wrong:** it skipped every
> element inside a `pointer-events: none` container, i.e. all dialogs, Compare and the viewer; it now reads the
> element's own `pointer-events` and also counts invisible range inputs. E11 reads the photo rect from
> `window.midstudyCtx` (the app's console handle), as `real_path.mjs` does.

> **Since integration (see `integrate.md`):** the integration agent confirmed the `library_api.sh` and `package.json`
> edits and E6's real `align`, kept E2's golden tolerances (E2 real is now 53/60: the same 7 misses, plus 3 passing
> scale-free depth checks it added), added E4.15 (occlusion with a manual camera height; E4 is 20/20) and
> `evals/real_path.mjs` (`npm run eval:real`, the real path with real MoGe, not in `eval:all`). The suggested extra
> handles were not added (reason in `integrate.md`).
> E1.07 (two uploads in one second) was flaky and now starts its pair in a fresh second.

What the evals track built on branch `v1` (not committed; new files are `git add`ed), how to run it, where things stand, and what's left. The eval-by-eval reference is [evals/README.md](../../evals/README.md).

Written from the spec only: PLAN.md §4 and §6, contract/CONTRACT.md and its schemas, `fixtures/`, and nook's old evals for harness patterns. I never read `planner/` or `calib/` source. The planner was explored only black-box (screenshots and the DOM of the running page) to drive its phone UI.

## What's here

| File | What |
|---|---|
| `evals/scenes_api.mjs` | E1 `eval:scenes-api`, 129 checks, no browser |
| `evals/calib_eval.py` | E2 `eval:calib`: real MoGe (golden scenes vs truth, the real photos), `--mock` (ingest), `--self-test` (the comparator) |
| `evals/planner_scene.mjs` | E3 `eval:planner`, 55 checks |
| `evals/occlusion.mjs` | E4 `eval:occlusion`, 19 checks |
| `evals/floor.mjs` | E5 `eval:floor`, 34 checks |
| `evals/render.mjs` | E6 `eval:render`, 36 checks (part A: `midstudy-calib align` directly; part B: the planner) |
| `evals/phone.mjs` | E9 `eval:phone`, 42 checks |
| `evals/all.mjs` | E10 `eval:all` (`--with-calib`, `--only E3,E4`) |
| `evals/harness_selftest.mjs` | `eval:selftest`: the eval machinery against the fixtures, no app needed (22 checks) |
| `evals/lib/harness.mjs` | shared: results, free ports, `startServer` (scratch dirs, mock and cap enforced), raw HTTP, §4.1 maths, the probe GLB and library, PNG masks, Helium and hook helpers, photo-on-screen registration, touch drags, the 44 px audit, the Compare inspector, the repo guard |
| `evals/lib/images.py` | numpy and Pillow: the occlusion judge, the align pair and its measurement |
| `evals/lib/gated_calib.py` | `--calib` wrapper: gate file, call log, `align` routed to the real CLI |
| `evals/README.md` | rewritten for midstudy |
| `package.json` | `eval:scenes-api`, `eval:calib`, `eval:planner`, `eval:occlusion`, `eval:floor`, `eval:render`, `eval:phone`, `eval:all`, `eval:selftest`; `check:scenes` fixed (it pointed at a missing `fixtures/check_scenes.mjs`, now `evals/py fixtures/check_scenes.py`) |

**Carried eval touched:** `evals/library_api.sh` passed `--room-dir`, which contract §2.1 removed and the new `serve.py` rejects. It now passes `--scenes-dir "$OUT/scenes"` instead (one line), which also keeps that server off the repo's own `scenes/`. E7 is 65/65 again.

## How to run

```sh
nix develop -c npm install                 # once
nix develop -c npm run eval:selftest       # the harness itself (7 s); if this fails the evals are wrong
nix develop -c npm run eval:all            # E1, E3–E9 (~3 min)
nix develop -c npm run eval:all -- --with-calib   # + E2 real MoGe and --mock (~1 more min)
nix develop -c npm run eval:calib -- --mock       # ingest only, 4 s
nix develop -c npm run eval:calib -- --cli "python3 fixtures/stub_calib.py" --calib-mock fixtures/calib --no-real-photos   # comparator through the stub
```

Each eval prints `PASS|FAIL <id> <check> — <measured value>` and exits 1 on any FAIL. Output, screenshots and `results.json` go to `evals/out/<eval>/`.

## Where things stand (2026-11-04, every run in this session)

| eval | result | failures |
|---|---|---|
| H0 `eval:selftest` | 22/22 | none (fixtures vs truth, probe library, judges, comparator, stub through the wrapper) |
| E1 `eval:scenes-api` | 129/129 | none |
| E2 `eval:calib --mock` | 47/47 against the real CLI | none. Against the stub it's 26/40, with failures only for the stub's documented limits (rotation, downsizing, PNG/WebP/HEIC, P3 conversion) |
| E2 `eval:calib` (real MoGe, MPS, ~10 s/photo) | 50/57 | **7, all calibration accuracy on the golden scenes** (calib track, see below) |
| E2 comparator via stub + mock | 30/30 | none |
| E3 `eval:planner` | 55/55 | none |
| E4 `eval:occlusion` | 19/19 | none |
| E5 `eval:floor` | 34/34 | none |
| E6 `eval:render` | 36/36 | none (one earlier app bug, the desktop Compare modal half off-screen, was caught by E6.30 and has since been fixed by the app track) |
| E7 `eval:library` | 65/65 | none (after the one-line fix above) |
| E8 `eval:pipeline` | 39/39 | none |
| E9 `eval:phone` | 42/42 | none |

**E2's 7 failures:** MoGe-2 (vitl, MPS) on the three synthetic golden renders:

| scene | fov (truth → got) | height | depth median error |
|---|---|---|---|
| living-wide | 55 → 62.5° (**+7.5°**, limit 5°) | 1.40 → 1.185 m (**−15 %**) | **19.2 %** |
| steep-roll | 65 → 68.6° (ok) | 1.60 → 1.476 m (ok, −7.8 %) | **10.3 %** |
| portrait | 70 → 75.9° (**+5.9°**) | 1.25 → 1.114 m (**−10.9 %**) | **16.5 %** |

Pitch and roll are excellent (≤ 0.7°). I checked that the depth error isn't an eval bug or a Euclidean vs view-axis mix-up: predicted/true depth is flat across the image (living-wide 0.77–0.81 from center to edge, where a Euclidean mix-up would rise toward the edges) and matches the height ratio (0.85). So MoGe sees the CG room about 15–20 % small with too wide a FOV. This is for the calib track or the plan owner: either improve the fit (for example, trust EXIF or a FOV prior when there is one; the golden photos have none) or accept looser tolerances for synthetic renders. On the real photos it looks plausible: the camera original gets 72.8° vertical vs EXIF 69.6° (within 8°), height 1.35 m, floor found; the chat copy gets 73.1°, 1.36 m; the AI-empty image gets 66.3°, 1.33 m.

## Decisions worth knowing

- **Scene calibration in fast evals** is `fixtures/stub_calib.py` with `MIDSTUDY_CALIB_MOCK=fixtures/calib`. **E1 and E6 wrap it** in `evals/lib/gated_calib.py`. E1 holds the first job on a gate file, so "pending" and the one-at-a-time queue are observable rather than racy. **E6 routes `align` to the real `midstudy-calib`** (`uv run --project <repo>/calib midstudy-calib`, or `MIDSTUDY_EVAL_ALIGN_CMD`), because the stub's align always answers `applied: false` and §4.7 says the mock must apply. This deviates from "stub everywhere but E2"; without `calib/` those checks fail with a clear reason.
- **The probe box** (`probe-box`, 80 × 50 × 120 cm, unlit magenta GLB generated in `harness.mjs`, validated by `validate_library.py` in the self-test) lives in each server's scratch library. Its silhouette is exactly its bounding box when unrotated, and magenta never occurs in the golden room.
- **Occlusion is judged on the render composite** (`<render>-input.jpg`, mock mode, at the photo's resolution), not on a screenshot. Hidden and visible pixels come from this eval's own ray-box depth against truth `depth.png`, 10 cm clear of the 3 cm tolerance, eroded 3 px.
- **The photo on screen** is found by registering the screenshot against `photo.jpg` (coarse search, then sub-pixel coordinate descent). The planner draws the photo into a JS-computed view rect inside a full-window canvas, so no DOM box matches. This gives the CSS mapping used for the horizon handle (E5, within 0.1 px) and the phone touch drag (E9).
- **E9 drives the phone UI by accessible names** where the spec has no handle: the dock tabs `Library`, `Layouts`, `Renders`; `Render`; exactly `Close` / `Done` / `Got it` to close sheets; the `+15°` button; `Split` in Compare. If the app renames those, E9 needs updating. Suggested handles to add to the contract: `rotate`, `layout-save`, `renders`, `library`, `sheet-close`, `compare-split`.
- **E1's 413 check uses `curl`** (Node's client can lose an early 413 to EPIPE).
- Every eval checks that the repo's own `scenes/`, `layouts/`, `renders/` and `library/` were untouched. `startServer` refuses to start without the fal mock and a spend cap. Real-photo `source.*` copies are deleted at the end of E2.

## Left / not covered

- E2's accuracy failures above (calib track or plan owner).
- Not automated: pinch zoom and two-finger pan (wheel zoom and Fit are checked), swipe between renders on the phone (the split slider is checked), the two-tap ruler, the grid fading with distance, contact shadows, Look on furniture only, and the live keep-room check (PLAN.md §8, main session).
- The Compare slider check counts elements with `cursor: ew-resize` / `col-resize`, which children inherit, so the count is inflated (fine for "present").
- E3's zoom check proves that wheel zoom changed the view and that Fit restores it; it doesn't measure the zoom factor, so the 4× cap is untested.
