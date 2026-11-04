# midstudy status

As of 2026-11-05, branch `v1` (local commits, nothing pushed). Every eval below was run on 2026-11-05 on this Mac (M3
Max, MPS), with fal mocked: no paid call was made.

**In short:** v1 is built and works end to end on the Mac: photo in, floor found, furniture placed, layouts saved,
renders and Compare (mock). Three things are left: the live fal check (about $0.20), your confirmation of one plan
change (EXIF focal length, below), and hosting on homeserver, which is packaged but has never been built on Linux.

## What works now

- **Scenes.** Upload a JPEG, HEIC, PNG or WebP photo. It's stripped of all metadata, then calibrated by MoGe-2 in
  about 10 s. You can rename and delete scenes, and undo a delete (Recently deleted).
- **Calibration.** The floor is found on your lounge photo despite the ultrawide lens, the reflective marble and the
  glass balustrade. A photo with an EXIF focal length uses it, which fixes most of MoGe's size bias. Adjust floor
  (sliders, horizon drag, ruler, **Set scale** from a known length) fixes the rest by hand.
- **Furniture.** Add from a photo or an image link (SAM 3D or TRELLIS 2 on fal), or from a GLB or zipped OBJ (free).
  Pieces are placed, dragged, turned, lifted, removed and restored with undo. Real furniture in the photo hides them
  (occlusion from MoGe's depth).
- **Layouts** per scene. A scene reopens with its layout on any device.
- **Render** (nano-banana with your photo as a reference), the optional **Keep room exact** alignment, the Renders
  panel and **Compare** (side by side or split, Swap). All of this was tested in mock mode only.
- **Phone** layout at 390 × 844, touch only. Every target is at least 44 px and there's no sideways scroll.
- **Privacy and money.** Photos and furniture images lose their EXIF/GPS before they're served or sent to fal. The
  server serves an allowlist only, and there's a daily spend cap ($2 by default).
- **Packaging** (`flake.nix`, `nix/`): packages and a NixOS module for homeserver. Every output evaluates. They were built
  and run on the Mac before verify round 2.

## Evals (run 2026-11-05)

| Eval | Result | Measured |
|---|---|---|
| E1 scenes API (`eval:scenes-api`) | **pass** 172/172 | uploads, jobs, trash/restore, allowlist (30 spellings), metadata stripping, Host/Origin rules, spend cap |
| E2 calibration, real MoGe-2 (`eval:calib`) | **fail** 84/91 | the same 7 golden misses as before (below). Lounge: FOV 69.63° (EXIF 69.6°), height 1.432 m, floor found, 9.6 s |
| E2 golden scenes only (`--no-real-photos`) | **fail** 59/66 | same 7 misses; golden + EXIF: height within 0.6–3.3 %, furniture ×0.99–1.04, floor 5–16 px off |
| E2 ingest (`eval:calib -- --mock`) | **pass** 51/51 | HEIC, P3, PNG, WebP, rotation, 25 MB limit, metadata stripped |
| E3 planner (`eval:planner`) | **pass** 55/55 | `floorToPhoto` max 0.00 px off; 2 m → 4 m shrink ratio 0.495 (projected 0.495) |
| E4 occlusion (`eval:occlusion`) | **pass** 20/20 | hidden pixels 100 % photo; off: 100 % box; manual height ×1.25 still 100 % |
| E5 floor (`eval:floor`) | **pass** 34/34 | horizon drag pitch −5.75° (expected −5.74°); manual/auto save and reset |
| E6 render (`eval:render`) | **pass** 36/36 | align 0.01 px on the synthetic pair; an unrelated image refused (5 inliers) |
| E7 library (`eval:library`) | **pass** 69/69 | carried nook library API |
| E8 pipeline (`eval:pipeline`) | **pass** 43/43 | `midstudy-add` against the fal mock |
| E9 phone (`eval:phone`) | **pass** 48/48 | all targets ≥ 44 px, scroll width 390 at every stage |
| E11 UX round 1 (`eval:ux`) | **pass** 28/28 | drag keeps the grabbed point under the pointer, Set scale, undo |
| E12 UX round 2 (`eval:ux2`) | **pass** 26/26 | layouts across devices, ruler, thumbnails, Swap |
| Real path (`eval:real`) | **pass** 31/31 | your lounge photo, real MoGe, GLB chair, two renders, Compare, phone |
| Harness self-test (`eval:selftest`) | **pass** 22/22 | |
| `calib/` unit tests (pytest) | **pass** 42/42 | |
| `nix flake check --no-build --all-systems` | **pass** | evaluation only, nothing built |

`eval:all` (E1, E3–E9, E11, E12) took about 5 min. Logs are in `evals/out/finish/` (git-ignored).

## Verified by looking at screenshots

- **Today (finish agent), from `eval:real` on your lounge photo** (`evals/out/integrate/`): the grid lies on the
  floor, with lines parallel to the rug's edges. A chair placed in front of the coffee table stands at a believable
  size. A second chair behind the table has its legs hidden by the table top. Compare split and the phone layout
  look right.
- **Earlier agents:** integration looked at every real-path screenshot (the stair-stepped depth edge on the table rim
  is the accepted halo). Verify rounds 1 and 2 had a UX verifier and a calibration-visuals verifier looking at desktop
  and phone screenshots; their findings are fixed (`docs/notes/verify-fix-1.md`, `verify-fix-2.md`).

## Not verified

- **Live fal.** No build agent made a paid call. Not tried: a real nano-banana render through the app, keep-room
  alignment on a real (non-identical) model output, and a SAM 3D add under the new names. (The key and
  nano-banana's output size were checked once on 2026-11-04, PLAN.md §4.7.)
- **Linux packaging.** Nothing x86_64-linux was built: CUDA torch, the module on a real system, the VM test and the
  weights download were never run. The Mac's Nix build of `midstudy-calib` predates verify round 2's calibration
  change and was not rebuilt after it.
- **A real phone.** Only Helium emulating 390 × 844 touch. iOS Safari was never tried.
- **Not automated:** pinch zoom and two-finger pan, swiping between renders on the phone, the grid fading with
  distance, contact shadows, Look on furniture only.
- **True sizes in your room.** Nothing has been checked against a tape measure.

## Known gaps and open findings

1. **[medium] Scale on photos without an EXIF focal length.** MoGe-2 reads the field of view 3.6–7.5° too wide and
   the room 8–15 % too small on the golden CG renders, so furniture is drawn up to 10 % too big there. Those renders
   carry no EXIF, which is why E2 keeps its 7 misses (living-wide FOV, height and depth; portrait FOV, height and
   depth; steep-roll depth 10.3 % against 10 %). With the true focal length in EXIF the same photos read within
   1–4 %. Photos without EXIF (screenshots, chat copies, edited exports) need Adjust floor › Ruler › Set scale.
2. **[medium, partial] Lounge seat height.** The seat reads about 39 cm (39.4 / 38.8) against your estimate of about
   45. The coffee table (35.0 cm) and the doorway (2.131 m) fall inside your estimates. A tape measure would settle
   it, and Set scale corrects the rest.
3. **Plan change to confirm.** PLAN.md §4.3 used to say "MoGe's FOV wins". Verify round 2 changed it: the EXIF FOV
   is used when it is within 8° of MoGe's, and MoGe's scale is corrected by the focal ratio. The contract and
   calib.schema.json follow. Please confirm or revert.
4. Smaller, accepted for v1: depth edges are stair-stepped (occlusion can halo around thin parts; the toggle is the
   answer); a new piece can land inside real furniture (the §4.5 landing rule); MoGe reloads for every photo (about
   4 s of the 10); Keep room exact stays off by default until the live check.
5. Packaging asks for small code changes, none blocking (`docs/HANDOFF.md` §13, R1–R5). The main one is R3: calib's
   `requires-python` says <3.13, but the Nix package runs it on 3.13.
6. Housekeeping: `~/.cache/huggingface/hub` holds 3.0 GB of MoGe checkpoints and only
   `models--Ruicheng--moge-2-vitl-normal` is used. You can delete the other MoGe checkpoints by hand.

Your photo `AD9729E1-…_1_201_a` (location data) is no longer at the repo root and was never opened. Extensionless
files and image files at the root are git-ignored, and nothing from `fixtures/photos/` is tracked.

## Next steps (PLAN.md §8)

1. **Confirm the §4.3 change** above, or say to revert it.
2. **Live check, about $0.20, in the main session** (key in `.env`): on the lounge photo, with a furnished layout, do
   two renders, one with Keep room exact on and one with it off. Use them to decide keep-room's default. Then do one
   SAM 3D add from a furniture photo to confirm the renamed pipeline against live fal.
3. **Your own photos:** put a few rooms through Adjust floor to see how often the automatic fit needs fixing. Measure
   the lounge seat height and compare it with the ~39 cm the app reads.
4. **Hosting on homeserver:** hand the repo and [docs/HANDOFF.md](HANDOFF.md) to a Claude agent there. It builds the CUDA
   calib (nook's torch-bin should be reused), runs the VM test, picks the host name with you, and deploys
   `services.midstudy` behind the same access control as nook.
5. After hosting: try it on your phone in Safari.

To run it now: `nix develop -c npm run serve` and open http://127.0.0.1:8765/ (see [README.md](../README.md)).
