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

## Planner side (`planner/lighting.js`, engine "look and lighting")

Built on main `b766898` (before Idol), mesh furniture and Flat rug only; splat colour-matching is a follow-up once Idol's
splat drawing is on main (`lights.splatGrade()` is the hook for it: a per-channel gain from `white_balance` and the
ambient setting).

- **With `lighting.json`:** a `LightProbe` with the SH turned to the world frame (refit over 96 directions, exact for
  bands 0–2), one `DirectionalLight` (colour × intensity × `light_strength`), and an environment map made from the same
  SH for reflections only. Lit materials get the `MIDSTUDY_PROBE_DIFFUSE` define, which drops three.js's image-based
  diffuse term (a one-line `ShaderChunk` patch), so the probe alone gives the diffuse ambient and nothing counts twice.
  Materials without the define compile exactly as before, so a scene without `lighting.json` is the v1 look.
- **Floor shadow:** the key's shadow map (PCF, 2048², an orthographic camera fitted to the pieces every frame) read by
  an invisible floor at y = 0 with a PCSS shader (blocker search, then a 32-tap filter whose width grows with the
  distance to the blocker, so it's sharp where a leg meets the floor and softer away from it). It is black with an
  alpha, drawn in the furniture pass, so the occlusion pre-pass hides it behind real things and the photo is only ever
  darkened. Its darkness is the key's share of the floor's light, `key·l_y / (ambient(up) + key·l_y)`, a little lighter
  for soft light; the alpha is converted for the composite's sRGB blending (blending a linear alpha over sRGB bytes
  made shadows ~2× too dark). The keep-room mask takes the visible shadow in, so a render doesn't cut it off.
- Measured with `evals/lib/images.py lighting` (E16) on the three living-* golden scenes, the grey probe box's faces
  come out 2–4 % brighter than lighting.json predicts (the reflections' share), and its shadow's direction is within
  1.5–14° of straight away from the light.
- E16 fixes found on the way: the probe's left face in living-cool was half hidden behind the real coffee table (the
  measurement now leaves out pixels the scene's depth.png puts in front of the box); living-wide's light comes from
  behind the camera, so the probe's shadow fell under the real table: living-wide uses its own probe spot right of
  the sofa; single-pixel JPEG noise on the rug no longer counts as shadow (a 1 px opening).
