# v1.1: Idol and splat furniture (orchestrator notes, 2026-11-05)

What was asked: Idol (`speridlabs/idol` on fal) as an engine in `midstudy-add`, the default in the Add furniture form
(SAM 3D, TRELLIS 2 and Flat rug stay), and splats drawn in the planner: at true size, hidden by the photo's furniture,
included in renders. Plan: PLAN.md §12. Spec: contract/CONTRACT.md (§1, §2.1, §2.8, §3.2–3.4, §4.5 Splats, §4.6, §5.2).

## Phase 0 (inline)

- One live Idol call ($0.10, the user's OK) on the Morris chair: 14.8 s, 262,144 splats, 17.8 MB, DC colour only,
  normals all zero. Kept as the mock `fixtures/fal/speridlabs-idol/` (normals dropped, 14.7 MB).
- Idol's frame, measured from that output: up is −Y and the front is +X (`frames.py`, `fixtures/fal/NOTES.md`). Its
  extent needs the 0.1th–99.9th percentile; the 1st–99th is 3–7 % short. SAM 3D's splat matches its GLB at 1–99 %.
- Contract decisions: idol is the default engine; an Idol piece's `model.glb` is a stand-in box at its dims, never
  drawn; splats are fitted per axis, covariances included; every `splat.ply` gets a `splat.spz` (SPZ v2 gzip,
  ≤ 262,144 splats, ≤ 6 MB), which is what the planner draws; Spark 2.4.0 from jsDelivr; splat colours get exposure ×
  warmth only (no ACES); Shows as appears only for pieces with a splat and a real mesh.
- Evals first: E13 (`evals/splat.mjs`), an Idol section in E8, splat checks in `validate_library.py`. Both were red
  against v1 for the right reasons. A GLB-only baseline composite was captured from v1 for comparison.

## Phase 1 (two agents in parallel, disjoint files)

- **A (pipeline, serve.py, library sheets):** the idol engine, the stand-in box, the per-axis splat fit
  (Σ' = S Σ S, batched eigh), the SPZ writer with a decode self-check, `assets.spz`, idol pricing and serving, PATCH
  rules, the Add form's Model choice and Shows as in the Edit sheet, the refit `fixtures/library/test-cube`.
- **B (planner):** Spark loaded on the first splat piece only; the splat pass is a second half-float target sharing
  the furniture pass's depth texture (so the photo's depth and meshes hide splats, which write none), composited after
  the ACES furniture layer with exposure × warmth only. The stand-in or mesh stays invisible for picking, dragging,
  bounds, stacking, the keep-room mask and the contact shadow. Placed copies rebuild in place when their library entry
  changes. The splat pass is cached on a key (camera, sizes, transforms, Spark's state), since SwiftShader takes
  1–4 s per splat frame. Measured: `splat.spz` and `splat.ply` of one item draw identically (IoU 0.974).

## Phase 2–3: integration and black-box verification

- E13.25 was my eval's mistake: a chair doesn't fill its box's front corner. It now compares the drawn chair with where
  its own `splat.spz` points project (`images.py splat-proj`): within 3 px.
- E13's Edit-sheet helper flaked under load (5 s click, no wait for the menu); it now waits and says why it failed.
- Three verifiers (UX, contract/privacy/money, visual). Fixed:
  - **vis-1 (medium):** a render right after placing could draw a splat behind another on top of it. The capture now
    waits, with frames still drawing, for a finished Spark sort of the whole current set (`settleSplats` repeats
    `update()` until `display === current` with no sort pending), then holds frames for the capture only. Their repro
    went from 16 % to 98.9 % correct; E13 has a check for it.
  - **ux-1 (medium):** phone segmented buttons in the sheets were 40 px tall; now 44 px (the Model choice, Shows as and
    the older Add from / Turn the model rows). E13 audits the phone Add form.
  - **ux-2:** SAM 3D splats looked see-through. The fixture is decimated to 1/8, but the live SAM 3D chair from the v1
    live check (878,144 splats) showed a real cause: keeping the 262,144 most opaque kept only small inner splats
    (77–94 % of the extent, size/spacing 0.40). `splat.spz` now keeps the ones that cover the most (opacity × the area
    of their two largest axes): 99–102 % of the extent, size/spacing 1.35, and the live chair looks solid next to its
    mesh (`evals/out/orch/samlook/`). E8 pins it.
  - **ux-3:** a "Placing <name>…" toast when a piece takes over 0.4 s to show. **ux-4:** the Model hint explains
    splats in plain words.
  - **money-1:** Flat rug's 1 cm / "rug" prefill is taken back when switching to another model. **contract-1:** a 3D
    model upload naming an image engine is 400. **privacy-1:** `midstudy-add` records a local input by its file name,
    not its path (library.json and costs.csv are tracked).
- Checked and right (verifiers): sizes at six placements (IoU 0.95–0.96), orientation and no mirroring, occlusion with
  no halo, draw order mesh/splat both ways, no fringes, splat colours at the default Look, contact shadow never on the
  splat, keep-room mask coverage, zoomed renders, the phone, the static allowlist (77 spellings), metadata stripping,
  the spend cap reserving $0.10, PATCH rules, the CLI, Spark loaded only for splat pieces. GLB-only composites against
  v1: mean differences 0.21 / 2.90 / 1.27 (JPEG noise).

## Left as known

- Under SwiftShader a splat frame takes seconds, and the view shows the previous sort for a few seconds after a change.
  On a real GPU this is milliseconds; not measured here.
- The SAM 3D mock fixture is decimated, so its splat looks see-through in the evals; live SAM 3D splats don't.
- `costs.csv` rows from `midstudy-add` write the shortest decimal (0.1); serve.py's render rows write 0.04.
