# fal fixtures

**Status: REAL**, captured 2026-10-25 with `fixtures/capture_fal.py` on `evals/golden/morris-chair.jpg` (prompt `armchair`; Trellis 2 at 512p). Total cost $0.27.

**Idol** (`speridlabs-idol/`), captured live 2026-11-05 by the v1.1 orchestrator on the same Morris chair photo (`input.jpg`, identical to SAM 3D's) with `image_type: "real"` and fal's default 262,144 Gaussians: 14.8 s, **$0.10** (not in `library/costs.csv`: the capture wasn't a library add). `request.json` and `response.json` are verbatim. The splat (`model_mesh`, `output.ply`, 17.8 MB) keeps all 262,144 splats; only its `nx ny nz`, which are all zero, are dropped (14.7 MB). Left out: `model_glb` (a point-cloud preview of the splat centers, 3.5 MB) and `preprocessed_image` (the background-removed 1024 × 1024 crop the model saw), which the pipeline never fetches.

Kept verbatim (SAM 3D, TRELLIS 2): `request.json`, `response.json`, `input.jpg` and the GLBs. Two changes to keep the repo light:
- The SAM 3D splat is decimated to every 8th splat (763,680 → 95,460). Same file name and format.
- `objects_bundle.zip` (41 MB) is left out. It duplicates the GLB and splat, and the pipeline never fetches it.

## Engine frames (measured)

| Engine | Asset | Frame | Notes |
|---|---|---|---|
| sam3d | `model_glb` | canonical object frame: +Y up, front +Z, about 1 unit in size | Bounds ±0.40 × ±0.50 × ±0.46. The backrest is toward −Z. |
| sam3d | `gaussian_splat` | **camera space** of the input photo | Posed by `metadata[0]`: `rotation` is a quaternion **[w, x, y, z]**, plus `translation` (z ≈ 2.56 m in front of the camera) and uniform `scale`. To reach the GLB frame: `p_glb = Rx(−90°) · R(q) · (p − t) / s`, which aligns with the GLB surface to a median of 1.6 cm. Implemented in `pipeline/src/logic/frames.ts` (`sam3dSplatToGlb`; v1 had it in `pipeline/src/midstudy_pipeline/frames.py`). |
| trellis2 | `model_glb` | +Y up, front +Z, about 1 unit in size | Bounds ±0.40 × ±0.48 × ±0.50. |
| idol | `model_mesh` (a splat PLY) | **up −Y, front +X**, about 0.6 units, centered at the origin | Measured by rendering the splat from each axis (`evals/out/idol-capture/views*.png`, git-ignored): up −Y (the legs point to +Y), the seat faces +X, the backrest is toward −X. Rotation to the item frame: new X = old Z, new Y = −old Y, new Z = old X (`frame_rotation("-Y", "+X")`). The response's `camera` (yaw 61°, pitch 22°, radius 1.78, fov 59.6°) is the photo's predicted view of that canonical object, so the frame doesn't depend on the view. One sample: if a piece comes out turned, the Edit sheet's Turn fixes it. DC colour only (no `f_rest_*`), opacity median 0.97, splat sizes about 1 mm (0.07–7 mm). |

**Splat extent (§1).** The 1st–99th percentile of SAM 3D's splat centers matches its GLB within 1 % on every axis (0.992 / 1.000 / 0.999 of the GLB on the fixture); its 0th–100th overshoots by 2–7 % (floaters). Idol's splat is dense and nearly floater-free: its 1st–99th percentile is 3–7 % short of the surface (476 / 586 / 558 mm against 513 / 604 / 577 mm at the 0.1th–99.9th, in Idol units), and only above the 99.95th does a floater show (685 mm in y). So Idol is measured on the 0.1th–99.9th, SAM 3D and the rest on the 1st–99th.

Units are arbitrary in every case (not metric), so `--dims` always sets the real size.

The splat has no `f_rest_*` (DC color only), about 764k splats for one armchair (52 MB). Large for a single piece of furniture, but Spark handles it.

## Mock layout

`<slug>/request.json` is the arguments sent, `<slug>/response.json` is the response verbatim, `<slug>/files/` holds the linked files (by URL basename) that the pipeline fetches, and `<slug>/input.*` is the image that was sent.
