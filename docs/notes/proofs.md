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
./run.sh lake update        # once after a fresh clone: clones Mathlib's packages and fetches its cache (no build)
./run.sh lake exe cache get # the same cache fetch alone (if .lake/ was deleted but the manifest is there)
./run.sh lake build         # every proof (about 1 min from a warm cache)
./check.sh                  # check:proofs: lake build, no sorry/admit/native_decide/axiom in the sources, and
                            # CheckAxioms.lean: every declaration under Midstudy uses only propext,
                            # Classical.choice and Quot.sound. Prints one summary line.
./run.sh lake build mediastrip   # the proved JPEG/PNG stripper models as a program (.lake/build/bin/mediastrip)
nix develop -c proofs/diff/run.sh [N]   # (from the repo root) the differential test against core/crates/media:
                            # N synthetic files per format (default 3000) plus the repo's fixtures and mutations
```

`nix build -f nix/lean.nix` (or `nix shell -f nix/lean.nix -c lean --version`) gives the Lean alone. From a flake:
`pkgs.callPackage ./nix/lean.nix { }`.

## What is proved

No `sorry`, `admit` or new axioms: `CheckAxioms.lean` collects the axioms of every declaration under `Midstudy`
(891 at the last run, 283 theorems in 13 files) and allows only Lean's three standard ones, which Mathlib uses
throughout.

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
| `quatMat_mem_SO3`, `turnBetween_mem_SO3` | Turn | three.js's matrix of a unit quaternion, and so lighting.js `turnBetween`, is a rotation | geom `turn_between`, `mat_from_quat` |
| `turnBetween_apply`, `turnBetween_axis`, `turnBetween_self` | Turn | the turn takes the inferred key direction exactly to the new one, about the axis a × b; at the inferred direction it is the identity (the light is exactly lighting.json's) | geom `turn_between` |
| `turned_light` | Turn | the whole light turns together: the key lands on the new direction and the ambient probe, turned with it, is seen from turned directions as before | E-lighting evals |
| `photoToPlane_floorToPhoto`, `floorToPhoto_photoToPlane`, `drag_keeps_point_under_pointer` | Plane | on any horizontal plane the camera isn't in, both round trips hold, so a drag keeps the grabbed point exactly under the pointer (§4.5) | geom `intersect_plane`, `plane_point_at_photo` |
| `rulerLength_smul`, `setScale_reads_true` | Plane | after Set scale (height × true/measured) the ruler between the same two pixels reads the true length exactly (before the height clamp) | geom `ruler_rescale` |
| `walk_serialize`, `walk_itemsOk` | Jpeg | the JPEG walk reads back any well-formed item list (restart markers after a scan as part of its data), and everything it reads is well formed | k-media props, fuzz |
| `strip_idem` | Jpeg | stripping a JPEG twice changes nothing | k-media props |
| `strip_no_metadata`, `strip_walk`, `strip_isClean` | Jpeg | the output has no APP1–APP15, no COM, APP0 only as a plain 16-byte JFIF header, nothing after EOI; ingest's pass-through test accepts it | E-render, ingest tests |
| `strip_imageData` | Jpeg | everything a decoder reads (tables, frame/scan headers, every scan's entropy-coded data with stuffed bytes and restart markers) is byte for byte the input's | golden photos pass through |
| `strip_eq_self_iff` | Jpeg | strip leaves a file unchanged exactly when `isClean` accepts it and it has no fill bytes (§4.3 pass-through ⟺ §2.6 stripping is the identity) | — |
| `ecsSplit_eq_fast` (`@[csimp]`) | Jpeg.Model | the program's constant-stack scan splitter is proved equal to the specification's | — |
| `Png.walk_serialize`, `Png.walk_chunksOk`, `Png.walk_spec` | Png | the PNG chunk walk reads back well-formed chunks; it consumes exactly the chunks' bytes then what follows IEND | k-media props |
| `Png.strip_idem`, `Png.strip_no_metadata`, `Png.strip_chunks`, `Png.strip_eq_self_iff` | Png | idempotent; no eXIf/tEXt/iTXt/zTXt/tIME and nothing after IEND; the other chunks byte for byte in order; unchanged exactly when there is nothing to drop (§2.8) | GLB texture stripping |

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

## The media strippers: what is proved, and how it covers the Rust

`Midstudy/Jpeg/Model.lean` and `Midstudy/Png.lean` are executable Lean transcriptions of `core/crates/media/src/
jpeg.rs` (`step`, `scan_end`, `plain_jfif`, `strip`, `is_clean`) and `png.rs` (`strip`), byte for byte in behaviour,
errors by kind. The theorems above are about these models. **Aeneas was not used**: `nix/` had no Aeneas/Charon
build when this ran (f-toolchain's `nightly` shell has Miri and Kani; Aeneas/Charon were still building), and
AENEAS.md's JPEG target needs k-media rewrites first (`position` as loops, `array::from_fn`). So the proofs cover the
Rust **by differential testing**: `lake exe mediastrip jpeg|png` (the models as a program; `@[csimp]` swaps in a
constant-stack scan splitter proved equal to the specification) and a 50-line Rust harness (`proofs/diff/`) run on the
same generated corpus, and every file's outcome (ok or the error kind), JPEG `is_clean`, and the stripped bytes must
be identical.

Measured (2026-11-05, k-media's crate at `v2-k-media` a30feda, extracted to scratch because the crate is not on `v2`
yet): JPEG 30,076 files (the 8 JPEG fixtures, each with metadata injected 5 ways and mutated, 20,000 synthetic JPEGs
with APP0 JFIF/JFXX, APP1–15, COM, fill bytes, TEM/RST, scans with stuffed bytes and restarts, trailing bytes, and
10,000 mutations): **all identical** (21,929 stripped, 8,147 refused, every error kind hit). Also 45,076 files in an
earlier run: identical. PNG 30,079 files (15 PNG fixtures with metadata chunks injected, 20,000 synthetic chunk
streams, 10,000 mutations): **all identical** (21,495 stripped; NoEnd, NotPng, Truncated hit). Lean model speed:
about 4,000 files a second.

## Requests to other tracks

- **f-toolchain (`scripts/check.mjs` proofs gate)**: a fresh clone has no `proofs/.lake`, and a plain `lake build`
  would then build Mathlib from source (hours). Run `proofs/check.sh` instead (it builds, and also checks every
  declaration's axioms), or at least run `lake exe cache get` first with `MATHLIB_CACHE_DIR=proofs/.lake/mathlib-cache`
  (Mathlib's cache tool otherwise writes to `~/.cache/mathlib`). `proofs/run.sh` sets both. `nix/lean.nix` now pins
  aarch64-darwin and x86_64-linux (the Linux build is untested).
- **k-media**: the differential harness reads `midstudy_media::jpeg::{strip, is_clean}` and `png::strip` by these
  names; keep them, or tell proofs. `proofs/diff/run.sh` needs the crate on the branch it runs on.
- **server-core / server-routes**: the azimuth observation above.

## Status and what's left

All eight groups are proved: camera, horizon, depth, item rotation, clamps, units, lighting, and the JPEG stripper
(plus the PNG stripper, the light's turn, drags and Set scale). Left:
- re-run `nix develop -c proofs/diff/run.sh` in place once `core/crates/media` is on `v2` (merge `v2` first): the
  measurements above are against `v2-k-media` a30feda, extracted to `evals/out/` because it isn't on `v2` yet;
- Aeneas + Charon on AENEAS.md's targets, once f-toolchain's shell has them and k-media has made the rewrites it lists;
- align names with k-geom's `core/crates/geom/LEAN.md` once it exists (not on `v2-k-geom` yet; the names here follow
  engine.js and k-geom's Rust: `photoToFloor`/`photo_to_floor`, `horizonAt`/`horizon_at`, `wrapDeg`/`wrap_deg`, …).
