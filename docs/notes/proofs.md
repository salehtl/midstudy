# Proofs track notes (v2, branch `v2-proofs`)

`proofs/` is a Lean 4 + Mathlib project that proves the mathematics midstudy relies on: the camera model of contract
§4.1 over ℝ, the horizon and depth, drags and Set scale, item rotations, the clamps and angle wrapping, the product
page's units over ℚ, the lighting rules of §4.8 (SH rotation, the turn of the whole light, the splat level), and the
JPEG and PNG metadata strippers (byte-level models of `core/crates/media`, proved, then compared with the Rust on
60,000 generated files). Floats are tested, not proved: the TS/Rust float code is checked against these statements by
property tests and the golden scenes.

## Toolchain

- **Lean 4.29.1, the official release** (`nix/lean.nix`, a fixed-output fetch of
  `lean-4.29.1-darwin_aarch64.tar.zst`, sha256 `c7zLOSyn2Ks9YqHjKLt9BXgV8Ijb2/tldPGUrlBXl68=`, used as published).
  Why not nixpkgs' `lean4` 4.29.1: nixpkgs builds it with `GIT_SHA1 "v4.29.1"` (its `lean --githash` is the tag
  name), and Mathlib's cached `.olean` files only load in the release's own githash (`f72c35b3…`), so Lake would
  rebuild all of Mathlib. The version is the same as nixpkgs'; only the build differs.
- **Mathlib v4.29.1** (its `lean-toolchain` is `leanprover/lean4:v4.29.1`), pinned in `proofs/lake-manifest.json`.
  Its compiled files come from Mathlib's cache (`lake exe cache get`, 8,232 files, about 2.5 min); nothing of Mathlib
  is built here. Everything lands in `proofs/.lake/` (git-ignored, about 7.4 GB), including Mathlib's download cache
  (`MATHLIB_CACHE_DIR`): nothing is written to `~` (no elan, no `~/.cache/mathlib`).
- `proofs/run.sh <cmd>` runs a command in `proofs/` with that Lean first on `PATH` and the cache dir set.

## Commands

```sh
cd proofs
./run.sh lake exe cache get # once after a fresh clone: clones Mathlib's packages at the manifest's revisions and
                            # fetches its compiled files into proofs/.lake (no Mathlib build; ~2 min)
./run.sh lake build         # every proof (about 1 min from a warm cache)
./check.sh                  # check:proofs: lake build, no sorry/admit/native_decide/axiom in the sources, and
                            # CheckAxioms.lean: every declaration under Midstudy uses only propext,
                            # Classical.choice and Quot.sound. Prints one summary line.
./run.sh lake build mediastrip   # the proved JPEG/PNG stripper models as a program (.lake/build/bin/mediastrip)
nix develop -c proofs/diff/run.sh [N]   # (from the repo root) the differential test against core/crates/media:
                            # N synthetic files per format (default 3000) plus the repo's fixtures and mutations
```

`nix build -f nix/lean.nix` (or `nix shell -f nix/lean.nix -c lean --version`) gives the Lean alone. From a flake:
`import ./nix/lean.nix { inherit pkgs; }` (what f-toolchain's flake does) or `pkgs.callPackage ./nix/lean.nix { }`.

Checked from a clean export of the committed `proofs/` and `nix/lean.nix` (2026-11-05): `./run.sh lake exe cache get`
1 min 54 s (Mathlib cloned, 8,232 files fetched), then `./check.sh` 1 min 33 s, ok; nothing written under `~/.cache`.
Don't run `lake update` for this: it re-resolves the dependencies.

## What is proved

No `sorry`, `admit` or new axioms: `CheckAxioms.lean` collects the axioms of every declaration under `Midstudy`
(970 at the last run; 329 theorems in 17 files) and allows only Lean's three standard ones, which Mathlib uses
throughout. The table lists the main results by group; the next section maps k-geom's LEAN.md to them one by one.

| Theorem | File | What it guarantees for the app | Mirrored by (floats are tested, not proved) |
|---|---|---|---|
| `camR_mem_SO3`, `camR_transpose_mul`, `camR_det`, `camR_eq` | Camera | R = Ry(0)·Rx(pitch)·Rz(roll) is a rotation (orthogonal, det 1) for every pitch and roll; its entries | geom props `rotation_is_rx_rz` |
| `photoToFloor_floorToPhoto` | Camera | every floor point in front of the camera comes back from its own pixel | geom props `floor_photo_floor_round_trip`, golden `floor_points` |
| `floorToPhoto_photoToFloor` | Camera | every pixel strictly below the horizon has a floor point, in front of the camera, whose pixel is that pixel | geom props `photo_floor_photo_round_trip`, E5 floor eval |
| `photoToFloor_eq_none_iff`, `no_floor_point_of_horizon_le` | Camera | at or above the horizon there is no floor point (`null`), and no floor point in front projects there | geom props `nothing_above_the_horizon` |
| `InRange.roundTrips`, `InRange.focalPx_pos`, `cos_pitch_pos`, `cos_roll_pos` | Camera | both round trips hold for every camera block within §4.1's ranges | clamps keep blocks in range |
| `floorHit_smul` | Camera | normalizing the ray (engine.js `photoRay`) changes no floor point | — |
| `photoRay_one_eq`, `photoRay_one_neg_iff`, `photoRay_one_eq_zero_iff` | Horizon | "below the horizon" (ray points down) is exactly "below the `horizonAt` line" in the image | geom `horizon_at` |
| `horizonAt_of_roll_zero`, `horizonAt_lt_half` | Horizon | roll 0: horizon row `H/2 − f·tan(−pitch)`; negative pitch puts it above the centre | golden scenes pin the signs (`check_scenes.py`) |
| `horizonAt_eq_line`, `horizonAt_strictMono`, `horizonAt_strictAnti`, `camR_right_up` | Horizon | the horizon is a line of slope tan(roll); positive roll lowers its right end; positive roll is counterclockwise seen from behind | steep-roll golden scene (roll 2) |
| `horizonAt_withPitch_pitchFromHorizon`, `pitchFromHorizon_horizonAt` | Horizon | dragging the horizon line sets the pitch exactly (the line lands where it is dropped; reading it back gives the pitch) | geom props `horizon_pitch_inverse` |
| `forward_eq`, `forward_dot_self`, `depth_eq_dot_forward` | Depth | depth is the distance along the view axis `(p − C)·forward`, forward a unit vector independent of roll | golden `depth.png` (not Euclidean) |
| `photoToFloor_withHeight`, `depth_withHeight_smul`, `floorToPhoto_withHeight_smul`, `occlusion_rescale`, `depth_withHeight_smul_lt_iff` | Depth | changing only `height_m` scales every floor point and depth by k and keeps every pixel, so §4.5's `depth × height_m / calib height_m` is exact (for a height change only) | geom `depth_scale`, E4 occlusion eval |
| `Ry_mulVec_x`, `Ry_x_toward_neg_z`, `Ry_quarter_x`, `Ry_ccw_from_above`, `Ry_mulVec_y` | Item | positive `rotation_y_deg` turns +X towards −Z, counterclockwise from above, never moves y (`--yaw 90` gives −Z) | geom `item.rs` (`Pose::apply`) |
| `Ry_add`, `Ry_pow`, `Ry_quarter_pow_four`, `Ry_rad_90_pow_four`, `Ry_rad_add_360_mul` | Item | angles add; four quarter turns are the identity; whole turns change nothing | geom props `four_quarter_turns` (points) |
| `rotateBy_four_quarters`, `wrapDeg_wrapDeg_add`, `wrapDeg_add_int_mul` | Clamp | `R` (or +90°) four times gives back the stored angle exactly, for angles on v1's 10⁻⁶ grid in (−180, 180] | geom props `four_quarter_turns` (stored angle) |
| `Ry_quarter_image_box`, `Ry_neg_quarter_image_box`, `worldBounds_x(_least)`, `worldBounds_z(_least)`, `worldBounds_quarter` | Item | a ±90° turn swaps a box's X and Z extents (§2.5); for any θ the world bounds are `w|cos θ| + d|sin θ|` × `w|sin θ| + d|cos θ|`, attained | geom props `quarter_turn_swaps_extents`, E3 planner eval |
| `clamp_mem`, `clamp_idem`, `clamp_mono`, `GridRound.*` | Clamp | `min(hi, max(lo, v))` lands in range, is idempotent and monotone, also after rounding to 6 decimals | geom `jsmath` |
| `round6_gridRound`, `round6Py_gridRound`, `roundHalfEven_mono` | Clamp | the planner's `Math.round(v·1e6)/1e6` and Python's `round(v, 6)` (ties to even) both keep the ranges' ends and order | — |
| `clampCamera_inRange`, `clampCamera_idem`, `clampCamera_mono`, `clampCameraPy_*`, `DEFAULT_CAMERA_inRange` | Clamp | a clamped camera block (planner or server) lands in §4.1's ranges, clamping twice changes nothing, clamping is monotone per field | geom props `camera_clamp_idempotent_in_range` |
| `lookNum_mem`, `lookNum_idem`, `lookNum_mono`, `lookNum_azimuth(_congr)`, `lookNumPy_*` | Clamp | every Look number lands in its §4.8 range; `lookFrom` is idempotent; monotone except the azimuth, which is wrapped first (same direction mod 360) | geom props `look_clamp_idempotent_in_range` |
| `wrapAz_not_monotone` | Clamp | the azimuth wrap is not monotone (179 → 179, 181 → −179) | — |
| `azimuth_planner_server_differ` | Clamp | an azimuth of 270 is kept as −90 by the planner (wrap) and stored as 180 by the server (clamp only): see Observations | — |
| `wrapDeg_eq_toIocMod`, `wrapDeg_mem`, `wrapDeg_modEq`, `wrapDeg_idem`, `Ry_rad_wrapDeg` | Clamp | `wrapDeg` is exactly the representative in (−180, 180] mod 360; wrapping never turns an item | geom props `wraps_in_range` |
| `jsRem_jsRem_add`, `wrapAz_mem`, `wrapAz_modEq`, `wrapAz_idem` | Clamp | JS `%` is modelled exactly (truncated quotient); `((a % 360) + 360) % 360` is `toIcoMod`; `wrapAz` lands in [−180, 180] | — |
| `cmPer_inch`, `cmPer_ft`, `ft_eq_twelve_inches`, `toCm_add`, `toCm_mono` | Units | 1 in = 2.54 cm and 1 ft = 30.48 cm exactly; a foot is 12 inches | product reader tests |
| `feetInches_toCm`, `feetInches_7_6`, `fracChar`, `fracChar_mem`, `mixed_31_half`, `mixed_41_threeQuarters` | Units | `7' 6"` is 228.6 cm; `31 1/2` and `41 ¾` mean 31.5 and 41.75; every fraction character is exact | E-product eval |
| `contract_example` | Units | §2.11's example `31 1/2x11x41 3/4"` is exactly `80.0 × 27.9 × 106.0` cm after rounding to 0.1 | E-product eval |
| `near05_symm`, `nearV1_symm`, `same_symm`, `same_refl`, `near05_not_transitive`, `nearV1_not_transitive` | Units | the "within 0.5 cm" relation (and v1's "or 1 %") is reflexive and symmetric but not transitive (10, 10.5, 11) | — |
| `merge_order_matters(_v1)`, `merge_pairwise`, `merge_covers` | Units | so the reader's greedy merge depends on the readings' order (one candidate vs two); in every order no two candidates are near and every reading is near a candidate | — |
| `irradianceAt_rotateBand1`, `irradiance01_rotateBand1`, `irradianceAt_rotateBand1_world` | Lighting | §4.8's "L00 stays, band 1 turns with R" is the same as evaluating the probe at rotated directions | raster `sh.rs` (`rotate_sh`) |
| `irradianceAt_rotateSHExact`, `rotateSHExact_band2_zero` | Lighting | with band 2 an exact turned probe exists in closed form (the 9 basis functions span every quadratic on the sphere), so v1's evaluate-turn-refit has an exact answer; without band 2 it is the band-1 rule | raster `refit` |
| `splatLevel_defaults`, `splatGain_defaults`, `splatLevel_v1`, `splatGain_v1_eq`, `splatLevel_mem`, `splatLevel_mono` | Lighting | the splat level is 1 at the defaults for every lighting.json (gain = `white_balance`), and with the v1 lights; it always lies between `ambient` and `strength` | raster `splat_gain` |
| `dirOf_zero`, `dirOf_ninety`, `dirOf_unit`, `azElOf_dirOf` | Lighting | azimuth 0 is −Z, 90 is +X; azimuth/elevation name every direction once (az ∈ (−180, 180], el ∈ (−90, 90)) | geom `dir_of`, `az_el_of` |
| `quatMat_mem_SO3`, `turnBetween_mem_SO3` | Turn | three.js's matrix of a unit quaternion, and so lighting.js `turnBetween`, is a rotation | geom `turn_between`, `mat_from_quat` |
| `turnBetween_apply`, `turnBetween_axis`, `turnBetween_self` | Turn | the turn takes the inferred key direction exactly to the new one, about the axis a × b; at the inferred direction it is the identity (the light is exactly lighting.json's) | geom `turn_between` |
| `turned_light` | Turn | the whole light turns together: the key lands on the new direction and the ambient probe, turned with it, is seen from turned directions as before | E-lighting evals |
| `photoToPlane_zero` | Plane | on the floor plane the drag's plane hit is exactly `photoToFloor` | geom props `floor_plane_hit_is_photo_to_floor` |
| `photoToPlane_floorToPhoto`, `floorToPhoto_photoToPlane`, `drag_keeps_point_under_pointer` | Plane | on any horizontal plane the camera isn't in, both round trips hold, so a drag keeps the grabbed point exactly under the pointer (§4.5) | geom `intersect_plane`, `plane_point_at_photo` |
| `rulerLength_smul`, `setScale_reads_true` | Plane | after Set scale (height × true/measured) the ruler between the same two pixels reads the true length exactly (before the height clamp) | geom `ruler_rescale` |
| `walk_serialize`, `walk_itemsOk` | Jpeg | the JPEG walk reads back any well-formed item list (restart markers after a scan as part of its data), and everything it reads is well formed | k-media props, fuzz |
| `strip_idem` | Jpeg | stripping a JPEG twice changes nothing | k-media props |
| `strip_no_metadata`, `strip_walk`, `strip_isClean` | Jpeg | the output has no APP1–APP15, no COM, APP0 only as a plain 16-byte JFIF header, nothing after EOI; ingest's pass-through test accepts it | E-render, ingest tests |
| `strip_imageData` | Jpeg | everything a decoder reads (tables, frame/scan headers, every scan's entropy-coded data with stuffed bytes and restart markers) is byte for byte the input's | golden photos pass through |
| `strip_eq_self_iff` | Jpeg | strip leaves a file unchanged exactly when `isClean` accepts it and it has no fill bytes (§4.3 pass-through ⟺ §2.6 stripping is the identity) | — |
| `ecsSplit_eq_fast` (`@[csimp]`) | Jpeg.Model | the program's constant-stack scan splitter is proved equal to the specification's | — |
| `Png.walk_serialize`, `Png.walk_chunksOk`, `Png.walk_spec` | Png | the PNG chunk walk reads back well-formed chunks; it consumes exactly the chunks' bytes then what follows IEND | k-media props |
| `megabytes_eq_roundHalfEven`, `megabytes_lt` | Arith | zip.rs `megabytes` is exactly `total/10⁶` rounded half to even (Python's), for every u64; no overflow (AENEAS.md #2) | k-media test `megabytes_round_half_even` |
| `foldDigits_eq`, `foldDigits_lt`, `foldDigits_prefix_lt` | Arith | Content-Length's digit fold over ≤ 15 digits stays below 10¹⁵ at every step (no overflow) and is the digits' number (AENEAS.md #7) | k-media http tests |
| `Png.strip_idem`, `Png.strip_no_metadata`, `Png.strip_chunks`, `Png.strip_eq_self_iff` | Png | idempotent; no eXIf/tEXt/iTXt/zTXt/tIME and nothing after IEND; the other chunks byte for byte in order; unchanged exactly when there is nothing to drop (§2.8) | GLB texture stripping |
| `projectPhoto_ray`, `photoRay_floorToPhoto_y`, `depth_pos_iff`, `photoRay_one_strictAnti` | Camera, Depth, Horizon | the point at parameter t on a pixel's ray projects to that pixel at depth t; in front ⟺ d > 0; the ray turns down monotonically down the photo | geom props (LEAN.md 2, 3, 5, 6) |
| `floorToPhoto_raise`, `floorToPhoto_up` | Depth | raising a point by δ moves its pixel by `f·δ·z/(d·d')` rows: up in the world is up in the photo for points ahead of the camera's foot | golden signs (LEAN.md 7) |
| `pitchFromHorizon_lipschitz`, `horizon_drag_cap` | Horizon | a horizon drag tilts the camera by at most `min(degPerCssPx, 0.12)` degrees per CSS pixel (§4.5) | geom props `horizon_drag_is_capped` |
| `rotateBy_four_quarters_stored`, `rotateBy_four_quarters_exception` | Clamp | `R` four times returns the stored angle, except a stored −180 (from angles within 5·10⁻⁷ of −180), which comes back as 180: see Requests | geom props `four_quarter_turns` |
| `corners_bound_x/y/z`, `footprint_centre` | Item | every point of a turned box lies within its 8 corners' bounds; the footprint's centre is the box's floor centre | geom `world_bounds`, `footprint` |
| `scaled01_ge`, `exactCap`, `defaults_unchanged_iff` | Lighting | with the exact cap no direction drops below 5 % of band 0; at the defaults the probe is exactly lighting.json's only when the cap is ≥ 1 (see Observations) | raster `max_band_scale` |
| `dirOf_azElOf` | Lighting | `dirOf(azEl(d)) = d` for every unit direction not straight up or down | geom `az_el_of` |
| `landing_spec`, `landing_free`, `ringPoint_dist` | Landing | a new piece lands on the base or on the first free ring point (in front, 0.45 m clear), within 5·10⁻⁷ after rounding | geom `landing_spot` |
| `fwd_iff`, `bwd_iff`, `rowPass_iff`, `dilate_iff` | Dilate | the keep-room mask's two-pass scan is exactly the box dilation `[x − right, x + left] × [y − down, y + up]` (§4.7) | raster props `dilation_is_a_box` |
| `unfilter_filter`, `paeth_eq_spec` | PngFilter | decoding a filtered PNG row gives it back, for every filter; raster's Paeth is the spec's | raster props `decoder_round_trips_every_filter` |

## k-geom's LEAN.md, property by property

`core/crates/geom/LEAN.md` (v2-k-geom 6c9b21e) lists 28 properties of the geom and raster crates. Names here follow it
and engine.js (`photoToFloor`, `horizonAt`, `pitchFromHorizon`, `wrapDeg`, `rotateBy`, `dirOf`, `turnBetween`, …).

| # | Property | Lean |
|---|---|---|
| 1 | R is a rotation, written out | `camR_mem_SO3`, `camR_eq` |
| 2 | d > 0 iff in the front half-space | `depth_pos_iff`, `depth_eq_dot_forward`, `forward_dot_self` |
| 3 | project(C + t·dir) = (px, py, t) | `projectPhoto_ray` |
| 4 | photo → floor → photo | `floorToPhoto_photoToFloor` |
| 5 | floor → photo → floor; the ray's y there is −h/d < 0 | `photoToFloor_floorToPhoto`, `photoRay_floorToPhoto_y` |
| 6 | dir.y formula, strictly decreasing in py, zero exactly on the horizon | `photoRay_one`, `photoRay_one_strictAnti`, `photoRay_one_eq_zero_iff`, `photoRay_one_neg_iff` |
| 7 | signs: roll-0 row, above centre, slope tan(roll), up is up | `horizonAt_of_roll_zero`, `horizonAt_lt_half`, `horizonAt_eq_line`, `horizonAt_strictMono`, `floorToPhoto_raise`, `floorToPhoto_up` (exactly: `Δpy = f·δ·z/(d·d')`, so up is up for points ahead of the camera's foot, z < 0; LEAN.md's "for points in front" is too broad when looking steeply down) |
| 8 | pitchFromHorizon ∘ horizonAt = id | `pitchFromHorizon_horizonAt`, `horizonAt_withPitch_pitchFromHorizon` |
| 9 | scale: floor points, depths, depth.png, the ruler | `photoToFloor_withHeight`, `depth_withHeight_smul`, `occlusion_rescale`, `setScale_reads_true` |
| 10 | the horizon drag cap | `pitchFromHorizon_lipschitz`, `horizon_drag_cap` (`|Δpitch| ≤ min(degPerCssPx, 0.12)·|Δy|`) |
| 11 | clamps in range, idempotent; round6 monotone | `clamp_*`, `round6_gridRound`, `clampCamera_*`, `lookNum_*` |
| 12 | wraps in range, congruent, idempotent | `wrapDeg_*`, `wrapAz_*` |
| 13 | four quarter turns return the stored angle | **false as stated**: `rotateBy_four_quarters_exception` (a stored −180, from any angle within 5·10⁻⁷ of −180, comes back as 180; the Rust does the same, checked on −179.9999999 and −179.9999996); true otherwise: `rotateBy_four_quarters_stored`, `rotateBy_four_quarters` |
| 14 | Ry(90°)·x = −z; Ry(90°)⁴ = I | `Ry_quarter_x`, `Ry_quarter_pow_four` |
| 15 | bounds extents `|cos|w + |sin|d`, quarter turn swaps | `worldBounds_x(_least)`, `worldBounds_z(_least)`, `worldBounds_quarter` |
| 16 | every point within the corners' bounds; footprint centre | `corners_bound_x/y/z`, `footprint_centre` |
| 17 | hull vertices are inputs, turn left, contain the points | not proved (left: Andrew's monotone chain needs a convexity development; geom's proptest and differential test cover it) |
| 18 | floor-plane hit = photoToFloor | `photoToPlane_zero` |
| 19 | a move drag keeps the grabbed point under the pointer | `drag_keeps_point_under_pointer`, `photoToPlane_floorToPhoto`, `floorToPhoto_photoToPlane` |
| 20 | landing: the base or a free point | `landing_spec`, `landing_free`, `ringPoint_dist` (free up to the 6-decimal rounding: within 5·10⁻⁷) |
| 21 | dirOf ∘ azEl = id, azEl ∘ dirOf = id | `dirOf_azElOf`, `azElOf_dirOf` |
| 22 | turnBetween·a = b, a rotation | `turnBetween_apply`, `turnBetween_mem_SO3`, `turnBetween_axis`, `turnBetween_self` |
| 23 | SH rotation exact for the irradiance | bands 0–1: `irradianceAt_rotateBand1`; band 2: `irradianceAt_rotateSHExact` (the exact turned probe exists in closed form); the 96 × 9 design's rank 9 is numeric, not proved |
| 24 | splat level 1 at defaults, monotone | `splatLevel_defaults`, `splatGain_defaults`, `splatLevel_mono`, `splatLevel_mem` |
| 25 | PNG unfilter ∘ filter = id; Paeth = spec | `unfilter_filter`, `unfilter_filter_types`, `paeth_eq_spec` |
| 26 | the PNG decoder is total | a Rust property (no panics); fuzz and props cover it |
| 27 | the two-pass dilation is the box dilation | `fwd_iff`, `bwd_iff`, `rowPass_iff`, `dilate_iff` |
| 28 | half floats round to nearest even, round-trip | not proved (IEEE half/single formats; the Rust test checks all 65,536 values) |

## Decisions

- **Model the code, not an idealisation, where it matters**: JS's `%` (truncated), `Math.round` (= Mathlib `round`),
  Python's ties-to-even `round`, the 6-decimal rounding inside the clamps, v1's "0.5 cm or 1 %" merge relation, the
  exact decimal constants of three.js's SH basis. Where the code uses a float tolerance (`dir.y >= −1e-9`), the model
  uses the exact test.
- **Degrees in the block, radians in the maths**: the block keeps `fov_y_deg`, `pitch_deg`, `roll_deg` (names as in
  the files and k-geom's `CameraBlock`); `rad x = x · (π/180)`.
- **Rotation exactness with band 2** is stated as the existence of the exact turned probe (closed form); that the
  96-direction least squares finds it needs the 96 × 9 design to have full rank, a numeric fact the Rust tests check.

## Observations (for other tracks)

- **Azimuth outside ±180°** (`azimuth_planner_server_differ`): the planner's `lookFrom` wraps then clamps (270 → −90),
  serve.py's look merge only clamps (270 → 180). The planner only writes in-range values, so normal use agrees; an
  API client sending 270 gets another direction. server-core/server-routes: consider wrapping like the planner (or
  keep v1 and say so).
- **The merge order matters** (`merge_order_matters`): readings 10.5, 10, 11 cm give one candidate, 10, 11, 10.5 give
  two. The reader's order is fixed (variants first, then layers), so results are deterministic, but a port must keep
  the same order and the same first-match rule to agree with v1.
- **§4.8's strength cap vs "exactly lighting.json"** (`scaled01_ge`, `defaults_unchanged_iff`): the planner scales
  the ambient's directional part by `min(light_strength, cap)`, the cap keeping every direction ≥ 5 % of band 0. At the
  defaults the light is exactly lighting.json's only when the cap is ≥ 1, i.e. when lighting.json's own darkest
  direction is already ≥ 5 % of band 0; a fit with a darker side is dimmed a little at strength 1. Also, v1's cap is
  taken over 96 sample directions (`maxBandScale`), which is at least the exact cap (`exactCap`, attained at
  −L1/|L1|), so between samples a direction can come slightly under 5 %. Both are v1 behaviour; the contract's two
  sentences agree only for such fits.
- **§4.5's depth rescale is exact for height changes only** (`occlusion_rescale`); a changed fov, pitch or roll moves
  pixels, so the rescaled depth.png is then an approximation (v1 behaviour, as the contract describes).

## The media strippers: what is proved, and how it covers the Rust

`Midstudy/Jpeg/Model.lean` and `Midstudy/Png.lean` are executable Lean transcriptions of `core/crates/media/src/
jpeg.rs` (`step`, `scan_end`, `plain_jfif`, `strip`, `is_clean`) and `png.rs` (`strip`), byte for byte in behaviour,
errors by kind. The theorems above are about these models. **Aeneas was not used**: f-toolchain's Aeneas + Charon build was a
no-go (docs/notes/f-toolchain.md: 62 minutes, no binary, so no `.#proofs` shell; prebuilt paths would need the
`hacl.cachix.org` substituter, a machine-wide setting only the user can change), Aeneas's Lean library pins Lean
4.35.0 with its own Mathlib (this project is on 4.29.1), and AENEAS.md's JPEG target needs k-media rewrites first
(`position` as loops, `array::from_fn`). So the proofs cover the
Rust **by differential testing**: `lake exe mediastrip jpeg|png` (the models as a program; `@[csimp]` swaps in a
constant-stack scan splitter proved equal to the specification) and a 50-line Rust harness (`proofs/diff/`) run on the
same generated corpus, and every file's outcome (ok or the error kind), JPEG `is_clean`, and the stripped bytes must
be identical.

Measured (2026-11-05, k-media's crate at `v2-k-media` cb444c5, its latest, with the 64-byte-block `find_ff` scan;
extracted to scratch because the crate is not on `v2` yet): JPEG 30,076 files (the 8 JPEG fixtures, each with
metadata injected 5 ways and mutated, 20,000 synthetic JPEGs with APP0 JFIF/JFXX, APP1–15, COM, fill bytes, TEM/RST,
scans of 0–700 bytes with stuffed bytes and restarts, trailing bytes, and 10,000 mutations): **all identical** (22,043
stripped, 8,033 refused, every error kind hit). PNG 30,079 files (15 PNG fixtures with metadata chunks injected,
20,000 synthetic chunk streams, 10,000 mutations): **all identical** (21,495 stripped; NoEnd, NotPng, Truncated
hit). Earlier runs against a30feda (before `find_ff`): 45,076 and 30,076 JPEG, 30,079 PNG, all identical. Lean model
speed: about 4,000 files a second.

## Requests to other tracks

- **f-toolchain (`scripts/check.mjs` proofs gate)**: a fresh clone has no `proofs/.lake`, and a plain `lake build`
  would then build Mathlib from source (hours). Run `proofs/check.sh` instead (it builds, and also checks every
  declaration's axioms), or at least run `lake exe cache get` first with `MATHLIB_CACHE_DIR=proofs/.lake/mathlib-cache`
  (Mathlib's cache tool otherwise writes to `~/.cache/mathlib`). `proofs/run.sh` sets both. `nix/lean.nix` now pins
  aarch64-darwin and x86_64-linux (the Linux build is untested).
- **k-media**: the differential harness reads `midstudy_media::jpeg::{strip, is_clean}` and `png::strip` by these
  names; keep them, or tell proofs. `proofs/diff/run.sh` needs the crate on the branch it runs on.
- **server-core / server-routes**: the azimuth observation above.
- **k-geom**: LEAN.md property 13 and the proptest `four_quarter_turns` claim that four `rotate_by(·, 90)` return
  `round_to(wrap_deg(r), 6)`; for the 4 angles `k/1e7`, `k ∈ [−1,799,999,999, −1,799,999,996]`, the stored angle is
  −180 and comes back as 180 (proved over ℝ, `rotateBy_four_quarters_exception`, and seen in the Rust:
  `evals/out/proofs-geom/`). The test passes only because proptest rarely draws those k. Either restate it (compare
  `wrap_deg` of both, or skip r₀ = −180) or, if v1's −180 isn't wanted, normalise after rounding (a v1 behaviour
  change: say so). Also LEAN.md 7's "up is up for points in front" holds exactly for points ahead of the camera's
  foot (z < 0): `floorToPhoto_raise`.

## Status and what's left

All eight groups are proved: camera, horizon, depth, item rotation, clamps, units, lighting, and the JPEG stripper;
also the PNG stripper, the light's turn, drags and Set scale, two integer kernels, and 25 of k-geom's 28 LEAN.md
properties (13 corrected). Left:
- re-run `nix develop -c proofs/diff/run.sh` in place once `core/crates/media` is on `v2` (merge `v2` first): the
  measurements above are against `v2-k-media` a30feda, extracted to `evals/out/` because it isn't on `v2` yet
  (`v2` had only the phase 0 commit and the eval-lock fix when this ran);
- Aeneas + Charon on AENEAS.md's targets: blocked (no binary from f-toolchain, and Aeneas's library pins Lean 4.35.0);
- LEAN.md 17 (the hull contains its points: needs a convexity development), 23's rank-9 claim (numeric) and 28 (half
  floats: IEEE formats): not proved; they stay with geom's tests.
