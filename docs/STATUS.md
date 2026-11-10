# midstudy status (v2)

As of 2026-11-06, branch `v2`. The plan is [REFACTOR.md](REFACTOR.md); each track's notes are in `docs/notes/`.

## State machines (2026-11-09, waves 1 to 6 merged on `sm-next`)

The fixes from the sweep of implicit state machines are merged through wave 6; each track's notes say what changed.
On `sm-next` at c7ba919: `npm run check` all ok (443 node tests, TScert 879/921 with every baselined function, Rust 210
tests with Miri and Kani, 14 fuzz targets, 574 Lean theorems); `eval:engine-races` 73/73, `eval:selftest` 50/50,
`eval:selftest-runner` 18/18, `eval:ui-smoke` 189/189. `eval:all` is the wave merge's to run, and is not counted here.
**`eval:perf --compare` fails** (exit 1, twice). Five of its regressions were already there at 3a25cc6, before the first
wave, at the same size: `planner_load_desktop_warm`, `drag_frames_p50`, `render_keep_room` and its client part, and
`splat_first_frame` (13 to 14 s against v1's 0.3 s). `api_scenes_p95` read 1.8 to 1.9 ms in those runs; an A/B on a quiet machine (2026-11-10)
shows no regression from the waves on any metric. Details: [notes/integration.md](notes/integration.md).

## Rooms (docs/ROOMS.md; integrated 2026-11-07 on `rooms-integrate`)

Built; Phase D (the user's own room) pending. A room groups several photos (scenes) into one room frame (contract
§4.9): `midstudy-calib align-room` gives each photo a pose and scale (MASt3R from the optional `rooms` extra, chosen
at Gate A; Manhattan without it; the calib mock gives the golden room's true poses), the server keeps rooms in
`rooms/` with align jobs on the calibration queue, and the planner shows room layouts in every photo, with a photo
strip, a floor plan with a density map of the photos' depth, and Align photos for moving photos by hand. Lean proves
the frame maps (Room.lean, 70 theorems) and a differential test checks `planner/logic/room.ts` against the Lean
model. E18 (rooms API), E19 (room planner) and E20 `--mock` are in `eval:all`; E20 real is in `eval:calib`;
`eval:real-room` is Phase D's. Every gate and its counts: [docs/notes/rooms-integrate.md](notes/rooms-integrate.md).
On the golden photos with real MoGe-2 depth, align-room places five of six (the bare wall unplaced) within 2.4 cm
after Set scale, with no confident-wrong placement ([rooms-calib-real.md](notes/rooms-calib-real.md); before that fix,
one of six). Raw distances before Set scale carry MoGe's height error (3–29 % on these photos).
Not yet: real photos of a real room (Phase D), a GPU other than SwiftShader, the Nix package's align-room (Manhattan only).
Gates at integration: `npm run check` all ok; `eval:all` 18/18 evals, 1,635 checks, twice on WebGPU and once on WebGL2;
`eval:calib` 106/106 (E20 real 34/34); calib pytest 142 passed; the room diff 9/9.

## What v2 is

- **Planner, server, `midstudy-add`:** strict TypeScript (no `any`, `!` or casts; eslint strict-type-checked, knip),
  run by Node 22 directly (`node server/src/main.ts`, `node pipeline/src/cli.ts`). Pure logic is certified by TScert
  (704 of 738 units).
- **Kernels:** Rust → WebAssembly (`core/`): media sanitisers, geometry and raster, splats, imaging, the product size
  reader (linear time). Kani (21 harnesses), Miri, 14 fuzz targets, differential tests against v1.
- **Proofs:** Lean 4 + Mathlib (`proofs/`), 504 theorems: the camera model, rotations, units, lighting, the hull, and
  executable models of the strippers, identical to the Rust on ~190,000 inputs.
- **Calibration:** Python, pyright strict, outputs validated against the schemas, and a warm MoGe worker.
- **Contract:** API schemas for every route; types and validators generated; the server validates its answers and
  files in strict mode.
- **Renderer:** WebGPU by default (three.js WebGPURenderer, TSL passes, the planner's own splat renderer with a GPU
  sort), WebGL2 fallback built in (`?webgpu=0`). Spark and every GLSL string are gone.
- v1 (`serve.py`, `product_page.py`, the Python pipeline, the planner's JS) is deleted.

## Evals (final tree)

`eval:all` 14/14 on WebGPU and 14/14 on the WebGL2 fallback (E1 220, E3 56, E4 21, E5 35, E6 37, E7 79, E8 72, E9 49,
E11 29, E12 27, E13 51, E14 409, E15 135, E16 57). `npm run check` all ok. Earlier on the same code: real-MoGe
`eval:calib` 132/132, `eval:real` 32/32, `eval:ui-smoke` 41/41.

## Ported from `main` (`e1b717f..fc82c5c`, merged 2026-11-06)

- a292ee2 keyboard shortcuts, Shift multi-select, arrow-key moves, Export: `planner/keymap.ts` (+ `logic/keymap.ts`),
  the selection set (`logic/selection.ts`), `ui/shortcuts.ts`, `ui/export.ts`; `eval:keys` (main's E17, not perf's
  E17 A/B below) in `eval:all`.
- c9e09c3 evals on the flake's headless Chrome: v2 already did; the uBlock wait (Helium only) not taken.
- a2a0762 docs: headless Chrome, never Helium: v2's docs already said so.
- 7a4f425 GPT Image 2 renders (`gpt-image`, `openai/gpt-image-2/edit`, est. $0.07): server, schemas, planner, E1/E6.
- 67275fd gpt-image's measured output size and framing: contract §4.7.
- ae46665 the photo-inferred light colour neutralized (`logic/look.ts` `neutralized`): contract §4.8.
- fc82c5c daily fal budget in Settings (`GET/PUT /api/settings`, `<library>/settings.json`, `--daily-spend-usd`
  locks it; `ui/settings.ts`, ⌘,) and gpt-image gets the composite alone: E1, E6.
- After the merge, on WebGPU: `eval:all` 15/15 (E1 235, E3 56, E4 21, E5 35, E6 38, E7 79, E8 72, E9 49, E11 29,
  E12 27, E13 51, E14 409, E15 135, E16 57, E17 52); `check gen types lint dead` ok. WebGL2 fallback not re-run.

## Speed (E17 A/B against v1, interleaved, exclusive; software GPU)

v2 is faster than v1 on every metric; none is worse. Calibration from the second photo −85 % (0.95 s), desktop load
−23 % (to `ready` −37 %), API calls 0.48–0.83×, requests 53 → 27 with no CDN, Idol add 1.88×, worst product page 592 ms,
scene open 1.26×. Missed targets: planner load −40 %, keep-room mask 3×, product p95 2×, CLI 3×.
WebGPU was measured only on SwiftShader (slower there on load, scene open and drags: shader compiles in software);
judge it in Safari or Helium on Metal, with and without `?webgpu=0`.

## Open

- Phase 4 stopped early (usage limit). Fixed: the product route no longer hangs on a page or feed body that doesn't
  decode as its Content-Encoding says (422 in ~10 ms, as v1; gzip with trailing junk is now 422 where v1 read it), and
  picture links to private or loopback IPv4 written in decimal, hex, octal, short or percent-encoded form are dropped
  (v1 kept them). The other findings (all low, plus three medium rigor ones: kernel differential tests in no gate,
  TS re-implementations of the proved slug and photo-extension rules, Python-compatibility helpers duplicated) are
  in `.claude/worktrees/rf-verify-*/evals/out/`, not fixed.
- `v2-webgpu`'s last commit (lazy environment maps, `25a9c3a`) is left out: it broke E16.33.
- Fuzz corpora trimmed to 40 seeds per target (332 files, ~1.3 MB); fuzz runs grow the rest locally.
- Not verified: live fal, a real GPU or phone, the Linux packaging (Nix is evaluated, not built on Linux).
