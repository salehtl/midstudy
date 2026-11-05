# Proofs track notes (v2, branch `v2-proofs`)

`proofs/` is a Lean 4 + Mathlib project that proves the mathematics midstudy relies on: the camera model of contract
§4.1 over ℝ, the horizon and depth, item rotations, the clamps and angle wrapping, the product page's units over ℚ,
and the lighting rules of §4.8. Floats are tested, not proved: the TS/Rust code is checked against these statements
by property tests and the golden scenes.

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
./run.sh lake update        # once after a fresh clone: clones Mathlib's packages and fetches its cache (no build)
./run.sh lake exe cache get # the same cache fetch alone (if .lake/ was deleted but the manifest is there)
./run.sh lake build         # every proof (about 1 min from a warm cache)
./check.sh                  # check:proofs: lake build, no sorry/admit/native_decide/axiom in the sources, and
                            # CheckAxioms.lean: every declaration under Midstudy uses only propext,
                            # Classical.choice and Quot.sound. Prints one summary line.
```

`nix build -f nix/lean.nix` (or `nix shell -f nix/lean.nix -c lean --version`) gives the Lean alone. From a flake:
`pkgs.callPackage ./nix/lean.nix { }`.

## What is proved

No `sorry`, `admit` or new axioms: `CheckAxioms.lean` collects the axioms of every declaration under `Midstudy`
(536 at the last run) and allows only Lean's three standard ones, which Mathlib uses throughout.

| Theorem | File | What it guarantees for the app | Mirrored by (floats are tested, not proved) |
|---|---|---|---|
| `camR_mem_SO3`, `camR_transpose_mul`, `camR_det`, `camR_eq` | Camera | R = Ry(0)·Rx(pitch)·Rz(roll) is a rotation (orthogonal, det 1) for every pitch and roll; its entries | geom `camera.rs` (`rotation`), props tests |
| `photoToFloor_floorToPhoto` | Camera | every floor point in front of the camera comes back from its own pixel | geom props `photo_to_floor ∘ floor_to_photo`, golden `floor_points` |
| `floorToPhoto_photoToFloor` | Camera | every pixel strictly below the horizon has a floor point, in front of the camera, whose pixel is that pixel | geom props, E5 floor eval |
| `photoToFloor_eq_none_iff`, `no_floor_point_of_horizon_le` | Camera | at or above the horizon there is no floor point (`null`), and no floor point in front projects there | geom `photo_to_floor` returns `None` |
| `InRange.roundTrips`, `InRange.focalPx_pos`, `cos_pitch_pos`, `cos_roll_pos` | Camera | both round trips hold for every camera block within §4.1's ranges | clamps keep blocks in range |
| `floorHit_smul` | Camera | normalizing the ray (engine.js `photoRay`) changes no floor point | — |
| `photoRay_one_eq`, `photoRay_one_neg_iff`, `photoRay_one_eq_zero_iff` | Horizon | "below the horizon" (ray points down) is exactly "below the `horizonAt` line" in the image | geom `horizon_at` |
| `horizonAt_of_roll_zero`, `horizonAt_lt_half` | Horizon | roll 0: horizon row `H/2 − f·tan(−pitch)`; negative pitch puts it above the centre | golden scenes pin the signs (`check_scenes.py`) |
| `horizonAt_eq_line`, `horizonAt_strictMono`, `horizonAt_strictAnti`, `camR_right_up` | Horizon | the horizon is a line of slope tan(roll); positive roll lowers its right end; positive roll is counterclockwise seen from behind | steep-roll golden scene (roll 2) |
| `horizonAt_withPitch_pitchFromHorizon`, `pitchFromHorizon_horizonAt` | Horizon | dragging the horizon line sets the pitch exactly (the line lands where it is dropped; reading it back gives the pitch) | geom `pitch_from_horizon` |
| `forward_eq`, `forward_dot_self`, `depth_eq_dot_forward` | Depth | depth is the distance along the view axis `(p − C)·forward`, forward a unit vector independent of roll | golden `depth.png` (not Euclidean) |
| `photoToFloor_withHeight`, `depth_withHeight_smul`, `floorToPhoto_withHeight_smul`, `occlusion_rescale`, `depth_withHeight_smul_lt_iff` | Depth | changing only `height_m` scales every floor point and depth by k and keeps every pixel, so §4.5's `depth × height_m / calib height_m` is exact (for a height change only) | geom `depth_scale`, E4 occlusion eval |
| `Ry_mulVec_x`, `Ry_x_toward_neg_z`, `Ry_quarter_x`, `Ry_ccw_from_above`, `Ry_mulVec_y` | Item | positive `rotation_y_deg` turns +X towards −Z, counterclockwise from above, never moves y (`--yaw 90` gives −Z) | geom `item.rs` (`Pose::apply`) |
| `Ry_add`, `Ry_pow`, `Ry_quarter_pow_four`, `Ry_rad_90_pow_four`, `Ry_rad_add_360_mul` | Item | angles add; four quarter turns are the identity; whole turns change nothing | — |
| `Ry_quarter_image_box`, `Ry_neg_quarter_image_box`, `worldBounds_x(_least)`, `worldBounds_z(_least)`, `worldBounds_quarter` | Item | a ±90° turn swaps a box's X and Z extents (§2.5); for any θ the world bounds are `w|cos θ| + d|sin θ|` × `w|sin θ| + d|cos θ|`, attained | geom `world_bounds`, E3 planner eval |
| `clamp_mem`, `clamp_idem`, `clamp_mono`, `GridRound.*` | Clamp | `min(hi, max(lo, v))` lands in range, is idempotent and monotone, also after rounding to 6 decimals | geom `jsmath` |
| `round6_gridRound`, `round6Py_gridRound`, `roundHalfEven_mono` | Clamp | the planner's `Math.round(v·1e6)/1e6` and Python's `round(v, 6)` (ties to even) both keep the ranges' ends and order | — |
| `clampCamera_inRange`, `clampCamera_idem`, `clampCamera_mono`, `clampCameraPy_*`, `DEFAULT_CAMERA_inRange` | Clamp | a clamped camera block (planner or server) lands in §4.1's ranges, clamping twice changes nothing, clamping is monotone per field | geom `CameraBlock::clamped` (its doc states idempotence) |
| `lookNum_mem`, `lookNum_idem`, `lookNum_mono`, `lookNum_azimuth(_congr)`, `lookNumPy_*` | Clamp | every Look number lands in its §4.8 range; `lookFrom` is idempotent; monotone except the azimuth, which is wrapped first (same direction mod 360) | geom `look.rs` (`LookNumber::clamp`) |
| `wrapAz_not_monotone` | Clamp | the azimuth wrap is not monotone (179 → 179, 181 → −179) | — |
| `azimuth_planner_server_differ` | Clamp | an azimuth of 270 is kept as −90 by the planner (wrap) and stored as 180 by the server (clamp only): see Observations | — |
| `wrapDeg_eq_toIocMod`, `wrapDeg_mem`, `wrapDeg_modEq`, `wrapDeg_idem`, `Ry_rad_wrapDeg` | Clamp | `wrapDeg` is exactly the representative in (−180, 180] mod 360; wrapping never turns an item | geom `rotate_by` |
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
- **§4.5's depth rescale is exact for height changes only** (`occlusion_rescale`); a changed fov, pitch or roll moves
  pixels, so the rescaled depth.png is then an approximation (v1 behaviour, as the contract describes).

## Status and what's left

Groups 1–7 of the task are proved (camera, horizon, depth, item rotation, clamps, units, lighting). Group 8 (the JPEG
stripper) waits for the media kernels to reach `v2`; see below once it is done.
