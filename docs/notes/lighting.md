# Lighting track notes (photo-lighting orchestrator, 2026-11-05)

Lighting inferred from the scene photo (contract §4.8): `midstudy-calib fit` writes `lighting.json` (ambient light as
L2 spherical harmonics plus one key light, in the camera frame, three.js units); the planner lights meshes with it,
colour-matches splats and draws a soft floor shadow; Scene › Look has the controls.

## Calibration side (`calib/src/midstudy_calib/lighting.py`)

How it works: the photo is linearised and taken back through three.js's ACES Filmic. Pairs of pixels on the two sides
of a crease in MoGe's geometry (normals ≥ 20° apart, the 3D points close, similar chromaticity, neither on the floor)
are taken as the same material, so their brightness ratio depends on the light alone. A hemisphere-like ambient plus
one key light is fitted to those ratios over a grid of directions (weak priors: ambient brighter from above, key around
40° up). Level and colour come from every pixel's albedo with two room assumptions: the brighter surfaces have albedo
0.8 (85th percentile) and the materials average to grey (shades of grey, p = 4, windows and lamps excluded).

What didn't work, for the record:
- **Per-region albedo from chromaticity clusters** (alternating fit of albedo per region and the light): the key's
  elevation drifted to the horizon and the colour flattened between scenes, because lit and shaded sides of one
  material get different chromaticity when key and fill differ in colour, so regions split exactly where the light
  information is. 30–48° direction errors.
- **Cast-shadow matching** (march from floor points towards candidate lights through MoGe's depth): 20–30 s per
  photo and the scores didn't single out the true direction (texture, rug edges, the 2.5D depth).
- Creases with the floor on one side (a box on the floor, skirting boards) are two materials: they biased the
  synthetic test by 13–20° until excluded.

Measured (E2 `eval:calib`, real MoGe-2 on the M3 Max, 2026-11-05):

| scene | key direction error | confidence | irradiance level | colour (inferred vs true) |
|---|---|---|---|---|
| living-wide | 3.6° | 1.0 | ×1.07 | 5174 K vs 5493 K (+11 mired) |
| steep-roll | 1.7° | 1.0 | ×1.00 | 5216 K vs 5493 K (+10 mired) |
| portrait | 3.0° | 1.0 | ×1.15 | 5065 K vs 5493 K (+15 mired) |
| living-cool | 5.7° | 1.0 | ×0.94 | 6722 K vs 7931 K (+23 mired) |
| living-warm | 15.1° | 1.0 | ×0.90 | 4214 K vs 4023 K (−11 mired) |
| lounge (real) | n/a | 0.35 | n/a | 5296 K; key lifted to 59° (soft, mostly overhead) |

The colour reads warmer than the true light on the golden room because its beige plaster, oak floor and red rug pull
the grey-world average warm; the shift between the three lights is right (cool +44.5 mired vs +56 true, warm +44.1 vs
+66.5). The fit takes 0.3 s alone and 0.9–1.3 s with the machine busy (MoGe itself ~3.6 s).

Limits: one key light (a lamp in a corner and daylight compete; living-warm's lamp was switched off so the eval has
one true key); elevation is the weakest part (prior-helped); rooms of one dark colour will read too bright (the
albedo-0.8 assumption); local lights and windows are not modelled as positions.

## Fixtures

`fixtures/make_scene.mjs` now takes lights per scene. `living-cool` and `living-warm` are the living-wide camera
under a cool key from the far left (in front of the camera) and a warm key from the right. Every golden scene has a
truth `lighting.json` (the hemisphere light as SH bands 0–1, the sun as the key, camera frame) and `truth.json`
`lights`; the three original photos are unchanged (re-rendering living-wide with the refactored lights differed from
the committed photo by 1.1 grey levels on average, JPEG noise).

## Evals

- E2 (`eval:calib`): lighting checks for the five golden scenes and the lounge, self-test of the truth files (their key
  turned by the true camera is the sun to 3e-5°, their irradiance matches the lights to 2e-6), mock copies. 132/132,
  self-test 53/53, mock 55/55.
- E16 (`eval:lighting`, `evals/lighting.mjs`): the planner side. Red against v1 (10/36) for the right reasons. A lit grey
  box's faces against lighting.json's prediction (radiance within 12 %), its floor shadow's direction and footprint,
  the controls (direction, strength, ambient, softness, shadows, save, reload, reset), unlit pieces unchanged, a scene
  without lighting.json identical to v1 (the v1 look recorded with `--baseline`: left 175, top 222, front 215), splats
  (once the library has a splat fixture), desktop and phone UI.
- `evals/lib/images.py lighting`: the measurement behind E16. Checked on the golden photos themselves: the sofa's top
  and front, one fabric, give the same albedo under all three lights (top/front 0.97–1.02), which pins the frame, the
  SH units and ACES.
