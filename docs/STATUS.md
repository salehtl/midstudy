# midstudy status

As of 2026-11-05, branch `main` (`v1` fast-forwarded into it and pushed to GitHub). Every eval below was run on
2026-11-05 on this Mac (M3 Max, MPS), with fal mocked. The only paid calls are the live checks (below: v1 $0.10, the
Idol check $0.1398, plus $0.10 to record Idol's mock) and the product page reader's (in its notes).

**In short:** v1 is built and works end to end on the Mac: photo in, floor found, furniture placed, layouts saved,
renders and Compare, now also checked against live fal. What's left is hosting on homeserver, which is packaged but has
never been built on Linux.

## What works now

- **Scenes.** Upload a JPEG, HEIC, PNG or WebP photo. It's stripped of all metadata, then calibrated by MoGe-2 in
  about 10 s. You can rename and delete scenes, and undo a delete (Recently deleted).
- **Calibration.** The floor is found on your lounge photo despite the ultrawide lens, the reflective marble and the
  glass balustrade. A photo with an EXIF focal length uses it, which fixes most of MoGe's size bias. Adjust floor
  (sliders, horizon drag, ruler, **Set scale** from a known length) fixes the rest by hand.
- **Furniture.** Add from a photo or an image link (**Idol**, the default since v1.1, SAM 3D or TRELLIS 2 on fal), or
  from a GLB or zipped OBJ (free).
  **Flat rug** (free, added 2026-11-05) lays a shop's top-down rug picture flat at W × D. When SAM 3D finds nothing in
  a photo it tries again by itself (less strict, then with a mask of the piece).
  Pieces are placed, dragged, turned, lifted, removed and restored with undo. Real furniture in the photo hides them
  (occlusion from MoGe's depth).
- **Splat furniture** (v1.1, 2026-11-05): Idol ($0.10) turns one photo of a piece into a Gaussian splat that looks
  like the photo. The planner draws splats with Spark 2.4.0 at true size, hidden by the photo's furniture, in renders
  and on the phone, with the Look's exposure and warmth (no tone mapping, so they keep the photo's colours). An Idol
  piece has no mesh: an invisible box at its size does the picking, dragging and contact shadow. SAM 3D pieces show
  their splat too, with **Shows as** (Splat / Mesh) in the Edit sheet. Each splat is served as `splat.spz` (about
  3 MB). PLAN.md §12, contract §1 and §4.5, notes in `docs/notes/idol.md`.
- **Lighting from the photo** (added 2026-11-05): calibration also infers the room's light (`lighting.json`: an ambient
  light plus one key light with its direction, colour, strength and softness, about a second on MoGe's output), and
  the furniture is lit by it: meshes by a light probe and a key light, splats colour-matched to the room's light, and
  every piece casts a soft shadow on the photo's floor, as dark as the photo's own shadows and hidden behind real
  furniture. **Scene › Light & look**: Auto lighting and Reset, a dial to drag the light's direction (mouse, touch,
  keys), strength, softness, ambient, exposure, warmth, floor and contact shadows; it saves itself per scene. Scenes
  calibrated before this get their light the first time they open (the lighting step alone, about 12 s on the lounge;
  nothing else changes). Contract §4.8, notes in `docs/notes/lighting.md`.
- **Layouts** per scene. A scene reopens with its layout on any device.
- **Render** (nano-banana with your photo as a reference), **Keep room exact** (on by default since the live check),
  the Renders panel and **Compare** (side by side or split, Swap). Tested in mock mode, plus the live check below.
- **Product page** (added 2026-11-05): paste a shop's product link in Add
  furniture and **Read** fills in the name, W × D × H (a size picker for rugs sold in several sizes), the category,
  Flat rug for a rug, and a strip of the page's pictures. Nothing is added before **Make**, which goes through the
  image-link add. Structured data, the Shopify and WooCommerce feeds and the page text come first, all free; only
  when none holds a size does Claude Haiku 5.5 on fal (`openrouter/router`, $0.0001–0.0003 a page measured live)
  read the page's words, and its sizes count only when they quote the page. Shops that refuse automatic reading get a clear message and a button
  to Image link. Contract §2.11, notes in `docs/notes/product*.md`.
- **Phone** layout at 390 × 844, touch only. Every target is at least 44 px and there's no sideways scroll.
- **Privacy and money.** Photos and furniture images lose their EXIF/GPS before they're served or sent to fal. The
  server serves an allowlist only, and there's a daily spend cap ($2 by default).
- **Packaging** (`flake.nix`, `nix/`): packages and a NixOS module for homeserver. Every output evaluates. They were built
  and run on the Mac before verify round 2.

## Evals (run 2026-11-05)

| Eval | Result | Measured |
|---|---|---|
| E1 scenes API (`eval:scenes-api`) | **pass** 219/219 | uploads, jobs, trash/restore, allowlist (30 spellings), metadata stripping, Host/Origin rules, spend cap; the Look keys, `lighting` and the old-scene light job (`POST …/light`) |
| E2 calibration, real MoGe-2 (`eval:calib`) | **pass** 132/132 | golden + EXIF: FOV from EXIF, height within 0.6–3.3 %, depth ≤ 10 %; golden without EXIF: pitch/roll ≤ 0.7°, depth shape 0.7–1.1 %, MoGe's own FOV/scale bias (+3.6…+7.5°, −7.8…−15.4 %) inside the regression bands (known gaps, item 1). Lounge: FOV 69.63° (EXIF), height 1.432 m, floor found. Lighting: the key within 1.7–15° of the true light on the five golden scenes (living-warm the widest), brightness ×0.90–1.15, the cool/warm shift the right way; the lounge plausible (5300 K, soft, 52° up) |
| E2 self-test (`calib_eval.py --self-test`) | **pass** 42/42 | |
| E2 ingest (`eval:calib -- --mock`) | **pass** 58/58 | HEIC, P3, PNG, WebP, rotation, 25 MB limit, metadata stripped; `light` with the mock |
| E3 planner (`eval:planner`) | **pass** 55/55 | `floorToPhoto` max 0.00 px off; 2 m → 4 m shrink ratio 0.495 (projected 0.495) |
| E4 occlusion (`eval:occlusion`) | **pass** 20/20 | hidden pixels 100 % photo; off: 100 % box; manual height ×1.25 still 100 % |
| E5 floor (`eval:floor`) | **pass** 34/34 | horizon drag pitch −5.75° (expected −5.74°); manual/auto save and reset |
| E6 render (`eval:render`) | **pass** 36/36 | align 0.01 px on the synthetic pair; an unrelated image refused; the dialog opens with Keep room exact on |
| E7 library (`eval:library`) | **pass** 78/78 | carried nook library API; v1.1: Idol the default at $0.10, `splat.spz` served as stored, Shows as rules, a model with an image engine refused |
| E8 pipeline (`eval:pipeline`) | **pass** 72/72 | `midstudy-add` against the fal mock; Flat rug (crop, turn, 160 × 230 × 1 cm slab) and SAM 3D's no-mask retries (added 2026-11-05); v1.1: Idol against the mock (stand-in box, per-axis splat fit, upright, `splat.spz`), splat thinning by coverage, inputs recorded by name |
| E9 phone (`eval:phone`) | **pass** 48/48 | all targets ≥ 44 px, scroll width 390 at every stage |
| E11 UX round 1 (`eval:ux`) | **pass** 28/28 | drag keeps the grabbed point under the pointer, Set scale, undo (E11.18 now waits for the Undo to finish in the UI) |
| E12 UX round 2 (`eval:ux2`) | **pass** 26/26 | layouts across devices, ruler, thumbnails, Swap (E12.12 now waits for the photo to settle after Ruler on) |
| E13 splats (`eval:splat`) | **pass** 50/50 | Idol default add, entries validate, `splat.spz` served; GLB composites unchanged next to splats; a splat probe within 3 % of its projected box; the Idol chair within 3 px of where its own points project; a render right after placing keeps the near splat in front; occlusion behind the sofa; keep-room mask; Shows as; the Add form (order, $0.10, 44 px on the phone); the phone loads `splat.spz` |
| E14 product page reader (`eval:product`) | **pass** 395/395 | 57 made-up shop pages (JSON-LD, microdata, OpenGraph, Shopify and WooCommerce feeds, tables, script JSON, prose for the model, a planted injection, order keys, foreign labels), blocked and broken pages, private links and redirects, 20 s and 10 MB limits, gzip bombs, a CPU-heavy page that once froze the server, the prompt, cost rows and the cap |
| E15 product page form (`eval:product-ui`) | **pass** 117/117 | desktop and phone: Read, sizes, pictures, notes, Make through to a done job, a blocked shop, re-reads |
| E16 lighting (`eval:lighting`) | **pass** 55/55 | a grey probe box's faces 2–4 % from what each golden scene's light predicts, its shadow 1.5–14° from straight away from the light and hidden behind the real table; the controls, saved per scene and saving themselves; unlit pieces unchanged; no `lighting.json` = the v1 look; an old scene gets its light on first open; splats warmer in the warm room, their stand-in casting the shadow; desktop and phone |
| Golden shop pages (`eval:product-live`) | **pass** 82/82 saved copies; live with the model 73/73 | ten real pages (IKEA AE and US, the Zennova carpet, Albany Park, Annie Selke, Boutique Rugs, Floyd, Industry West, Target, West Elm). Live with Haiku on 2026-11-05 (after landing): every shop answered, the model ran only on Industry West (no size on the page; it found none, $0.000253) |
| Real path (`eval:real`) | **pass** 31/31 | your lounge photo, real MoGe, GLB chair, two renders, Compare, phone |
| Harness self-test (`eval:selftest`) | **pass** 22/22 | |
| `calib/` unit tests (pytest) | **pass** 62/62 | |
| `nix flake check --no-build --all-systems` | **pass** | evaluation only, nothing built |

`eval:all` (E1, E3–E9, E11–E16) takes about 12 min; with lighting merged in it passed 14 of 14 twice on 2026-11-05 (one earlier run failed E13.26 because the Idol chair's new cast shadow counted as part of its outline; E13 now turns it off for that check, as it already did contact shadows). With Idol (v1.1) it passed 11 of 11 twice before the product page reader was merged in and 13 of 13 after, all on 2026-11-05. One earlier run failed four timing checks (E3.32, E11.14, E12.13, E13.36) while three verifiers ran beside it, and none of those came back on a quieter machine. The product page reader alone passed 12 of 12 at 14:30 (an earlier run that day failed E3, E4, E5 and E11 on page-load timeouts while other sessions held the Mac's load average above 180). Logs are in `evals/out/main/` (git-ignored). The main session
found E11.18 and E12.12 flaky (fixed timing in the evals, not the app; each then passed 3 runs out of 3).

## Live check of Idol (v1.1, 2026-11-05, $0.1398)

On your lounge photo, from a fresh checkout of the Idol work with its own data folders (`evals/out/live-idol/`,
git-ignored; `side-by-side.jpg` shows the view's composite above the final render):

- **Idol add** of the Morris chair photo through the library API, with no engine named (Idol is the default): live,
  19 s, **$0.10**. The library entry has the stand-in box, `splat.ply` and a 3.0 MB `splat.spz` (262,144 splats),
  fitted to 75 × 85 × 95 cm with 0 % error, and it passes `validate_library.py`.
- **Two copies placed** where the v1 check put its SAM 3D chairs: both draw as splats within 0.5 s, on the rug next to
  the sofa and the round table, at a believable size, with contact shadows.
- **Render, Keep room exact on:** live nano-banana, 53 s, **$0.0398**, aligned with 597 inliers at 0.67 px. The result
  is your photo at 2048 × 1152 with the two chairs pasted in and no visible seam.
- Total **$0.1398** (`costs.csv` and `/api/spend` agree), under the check's $0.20 cap. No console or page errors.
- What it shows: the chairs keep the light of their own product photo, so they look a little brighter and flatter
  than the room's warm evening light. The lighting work is for that. Phase 0 made one more live Idol call ($0.10,
  the same chair) to record the mock; it isn't in a `costs.csv`.

## Live check (PLAN.md §8, main session, 2026-11-05, $0.10)

On your lounge photo (`evals/out/live/`, git-ignored; `live-check.jpg` puts the three side by side):

- **SAM 3D add** of the Morris chair photo (`fixtures/fal/sam-3-3d-objects/input.jpg`) through the planner's library
  API: live, 62 s, $0.02, GLB + splat + thumbnail. Two of them placed on the rug read at a believable size.
- **Render, Keep room exact off:** live nano-banana, 16 s, $0.04, 1344 × 768. Chairs kept their position, size and
  colour; the room is redrawn by the model and slightly softer.
- **Render, Keep room exact on:** live, 17 s, $0.04. Aligned with 679 inliers, 0.6 px residual; the result is the
  photo at 2048 × 1152 with only the chairs from the model, and no visible seam. So **Keep room exact is now on by
  default** in the Render dialog (the hook's `renderView()` still defaults it to off).
- **One failure:** the first keep-room attempt got fal HTTP 422 "did not generate the expected output" (no charge,
  nothing in costs.csv); the retry worked. serve.py now words it as "returned no image this time. Try the render
  again." instead of fal's raw JSON.
- Neither render adds much contact shadow under the chairs.

## Verified by looking at screenshots

- **v1.1 splats** (`docs/notes/idol.md`): the Idol chair on golden living-wide is photoreal at its size, with the
  coffee table hiding its lower front, on the desktop and the phone. A splat probe behind the sofa is cut cleanly with
  no halo. The live SAM 3D chair from the v1 check, refit by v1.1, looks solid as a splat next to its own mesh. Three
  black-box verifiers (UX, contract and privacy, visuals) found 2 medium and 6 low issues, all fixed; GLB-only
  composites match v1's within JPEG noise.

- **Today (finish agent), from `eval:real` on your lounge photo** (`evals/out/integrate/`): the grid lies on the
  floor, with lines parallel to the rug's edges. A chair placed in front of the coffee table stands at a believable
  size. A second chair behind the table has its legs hidden by the table top. Compare split and the phone layout
  look right.
- **Earlier agents:** integration looked at every real-path screenshot (the stair-stepped depth edge on the table rim
  is the accepted halo). Verify rounds 1 and 2 had a UX verifier and a calibration-visuals verifier looking at desktop
  and phone screenshots; their findings are fixed (`docs/notes/verify-fix-1.md`, `verify-fix-2.md`).

## Not verified

- **Linux packaging.** Nothing x86_64-linux was built: CUDA torch, the module on a real system, the VM test and the
  weights download were never run. The Mac's Nix build of `midstudy-calib` predates verify round 2's calibration
  change and was not rebuilt after it.
- **A real phone.** Only Helium emulating 390 × 844 touch. iOS Safari was never tried.
- **Not automated:** pinch zoom and two-finger pan, swiping between renders on the phone, the grid fading with
  distance, contact shadows, Look on furniture only.
- **True sizes in your room.** Nothing has been checked against a tape measure.
- **Splats on a real GPU or phone.** Only SwiftShader (software rendering), where a 262,144-splat frame takes 1–4 s
  and the view shows the previous sort for a few seconds after a change. A real GPU should take milliseconds; not
  measured. Idol on pieces other than the Morris chair has not been tried.
- **Shopify shops under load.** Shopify rate-limits bursts from one IP (429, Cloudflare `local_rate_limited`): after a
  day of probing on 2026-11-05 Albany Park, Annie Selke, Boutique Rugs and Floyd answered 429 for a few hours, then
  read fine again. The reader says what it is (`midstudy/1.0 (product page reader)`) and doesn't try to get around a
  shop's refusal.
- **SAM 3D's no-mask retries against live fal.** Only mocked: whether the lower threshold or the mask gets the
  bookshelf and the carpet through on the real service (and that refused calls stay free) is untested.

## Known gaps and open findings

1. **[medium] Scale on photos without an EXIF focal length.** MoGe-2 reads the field of view 3.6–7.5° too wide and
   the room 8–15 % too small on the golden CG renders, so furniture is drawn up to 10 % too big there. Those renders
   carry no EXIF, which is why E2 keeps its 7 misses (living-wide FOV, height and depth; portrait FOV, height and
   depth; steep-roll depth 10.3 % against 10 %). With the true focal length in EXIF the same photos read within
   1–4 %. Photos without EXIF (screenshots, chat copies, edited exports) need Adjust floor › Ruler › Set scale.
2. **[medium, partial] Lounge seat height.** The seat reads about 39 cm (39.4 / 38.8) against a typical 45 cm (a
   guess in `fixtures/photos/notes.md`, not a measurement). The coffee table (35.0 cm) and the doorway (2.131 m) look
   plausible. A tape measure would settle it, and Set scale corrects the rest.
3. **Plan change, confirmed by the main session.** PLAN.md §4.3 used to say "MoGe's FOV wins". Verify round 2
   changed it: the EXIF FOV is used when it is within 8° of MoGe's, and MoGe's scale is corrected by the focal ratio.
   Kept: on the golden scenes with EXIF it brings height within 0.6–3.3 % (from up to 15 % off). E2 now judges the
   no-EXIF golden runs on pitch, roll and depth shape, with FOV, height and absolute depth as regression bands
   (PLAN.md §6.2).
4. Smaller, accepted for v1: depth edges are stair-stepped (occlusion can halo around thin parts; the toggle is the
   answer); a new piece can land inside real furniture (the §4.5 landing rule); MoGe reloads for every photo (about
   4 s of the 10); nano-banana occasionally returns no image (retry); a scene deleted again within a fraction of a
   second of its Undo is not deleted (only a script can hit it).
5. Packaging asks for small code changes, none blocking (`docs/HANDOFF.md` §13, R1–R5). The main one is R3: calib's
   `requires-python` says <3.13, but the Nix package runs it on 3.13.

Your photo `AD9729E1-…_1_201_a` (location data) is no longer at the repo root and was never opened. Extensionless
files and image files at the root are git-ignored, and nothing from `fixtures/photos/` is tracked.

## Next steps (PLAN.md §8)

1. **Your own photos:** put a few rooms through Adjust floor to see how often the automatic fit needs fixing. Measure
   the lounge seat height and compare it with the ~39 cm the app reads.
2. **Hosting on homeserver:** hand the repo and [docs/HANDOFF.md](HANDOFF.md) to a Claude agent there. It builds the CUDA
   calib (nook's torch-bin should be reused), runs the VM test, picks the host name with you, and deploys
   `services.midstudy` behind the same access control as nook.
3. After hosting: try it on your phone in Safari.
4. Rotate the fal key (it was shared in chat).

To run it now: `nix develop -c npm run serve` and open http://127.0.0.1:8765/ (see [README.md](../README.md)).
