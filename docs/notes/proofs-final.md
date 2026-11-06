# proofs-final track notes (v2 Phase 4, branch `v2-proofs-final`)

The proofs track's last round (docs/REFACTOR.md §5, Phase 4). `docs/notes/proofs.md` (the proofs track's notes) has
the toolchain, the method and the earlier results; this file has what changed in this round and the **current theorem
tables** (they supersede the two tables in proofs.md, which this track does not own). Base: `v2` at `979677c`.

## What this round did

- **Re-ran `proofs/diff` in place on `v2`** (the media crate is on `v2` now: `core/crates/media` last changed at
  `d7600b9`, merged with k-media), and against **kernels-hardening's crates** (`v2-kernels-hardening` at `a7953e9`, its
  tip, not merged into `v2`; it changed `jpeg.rs`, `png.rs`, `glb.rs`, added `plan.rs` and Kani harnesses). Every
  mode, both revisions: **all identical** (counts below).
- **Modelled and proved what was left of AENEAS.md**: #5 base64 and the `X-Midstudy-Meta` header
  (`Midstudy/Base64.lean`), #8 sniff (`Midstudy/Sniff.lean`), #10 wasm-node's wire reader (`Midstudy/Wire.lean`).
  Each is an executable Lean model of the Rust, proved, and added to `proofs/diff` as a mode. Every AENEAS.md target
  (#1–#10) now has a Lean model with proofs.
- **LEAN.md 17, the convex hull** (`Midstudy/Hull.lean`), all three parts, over ℝ: every vertex of the hull is an
  input point; every input point is on or left of every edge (`pointInHull` whenever the hull has ≥ 3 vertices); and
  every turn of the hull is strictly left unless the points are all on one line (inside both chains and at the two
  points where they meet).
- **Method unchanged**: Aeneas and Charon stay a no-go (no binary from f-toolchain's build; Aeneas's library pins
  Lean 4.35), so the Rust is covered by executable Lean models, proved, then compared with the Rust on generated
  inputs (`proofs/diff`).

`check:proofs` (`nix develop -c npm run check:proofs`, i.e. `proofs/check.sh`): **ok, 24 files, 504 theorems**
(was 20 and 354), 1,568 declarations under `Midstudy` using only `propext`, `Classical.choice`, `Quot.sound`; no
`sorry`, `admit`, `native_decide` or `axiom` in the sources; no build warnings.

## proofs/diff, 2026-11-06 (`nix develop -c proofs/diff/run.sh 20000`)

| Mode | What is compared | v2 `979677c` in place | kernels-hardening `a7953e9` |
|---|---|---|---|
| jpeg | `jpeg::strip`, `is_clean`, stripped bytes | 30,476 identical (22,061 stripped, 8,415 refused, every error kind) | 30,476 identical (same counts) |
| png | `png::strip`, stripped bytes | 30,079 identical (21,495 stripped; NoEnd, NotPng, Truncated) | 30,079 identical |
| slug | `slug::is_slug` | 20,000 identical (10,549 slugs) | 20,000 identical |
| frame | `jpeg::frame_info` | 30,476 identical (1,675 sized; every error kind, ZeroSize included) | 30,476 identical |
| b64 (new) | `base64::decode_python` strict and lenient (offsets included), `base64::encode` | 20,006 identical (7,567 strict ok; all 7 error kinds) | 20,006 identical |
| meta (new) | `meta::decode` at the 16 KiB cap and at 64 bytes; whether the input is a Rust `&str` | 20,000 identical (9,899 ok; TooLong 286, NotAscii 1,359, Base64 2,800, NotUtf8 4,423; 1,233 inputs not UTF-8) | 20,000 identical |
| sniff (new) | `sniff::sniff`, `Kind::photo_ext`, wasm-node `api::sniff`; and calib's own Python `sniff(data[:64])` | 20,103 identical, every kind; calib's Python agrees on 20,103/20,103 | 20,103 identical, calib agrees |
| wire (new) | wire.rs `Reader` read as `zip_plan` reads (every entry's name, flags, words, attributes, size), and whether `api::zip_plan` answers `bad-input` | 20,001 identical (10,892 read, 9,109 bad-input) | 20,001 identical |

Re-run at this round's last proofs commit (`9def78e`, in place) and against kernels-hardening's newer tip `1a13d59`
(which changed `http.rs`, `path.rs` and the Kani harnesses, none of the modelled functions): all eight modes
identical again, with the same counts (`evals/out/proofs-diff-head-v2.log`, `evals/out/proofs-diff-kh-1a13d59.log`).

The JPEG corpus is 30,476 (not 30,076 as in proofs.md) since the 400 frame-header cases were added to it. Logs:
`evals/out/proofs-diff-final-v2.log`, `evals/out/proofs-diff-final-kh.log` (scratch, git-ignored). About a minute for
all eight modes once `mediastrip` and the harness are built.

How the new modes reach the Rust: `proofs/diff/src/main.rs` compiles wasm-node's `wire.rs` and `api.rs` from their
own source files (`#[path]`), so `api::zip_plan`, `api::sniff` and `wire::Reader` run natively, without wasm-bindgen,
and nothing is copied. `MIDSTUDY_DIFF_REV=<rev>` runs the harness against the crates committed at another revision
(`git archive` into the scratch directory: no checkout or worktree is touched); the Lean side is always this checkout's.

## Commands

```sh
cd proofs && ./run.sh lake exe cache get    # once per fresh worktree: Mathlib's compiled files (~2 min, into proofs/.lake)
nix develop -c npm run check:proofs          # the gate: proofs/check.sh (lake build, no sorry/admit/axiom, CheckAxioms.lean)
nix develop -c proofs/diff/run.sh [N] [MODE...]           # N synthetic inputs per mode (default 3000); modes: jpeg png
                                                          # slug frame b64 meta sniff wire (default all)
MIDSTUDY_DIFF_REV=a7953e9 nix develop -c proofs/diff/run.sh 20000   # the crates of another revision
cd proofs && ./run.sh lake build mediastrip  # the models as a program: .lake/build/bin/mediastrip MODE LIST OUTDIR
```

## The theorem table (all of `proofs/`, current)

The rows up to `unfilter_filter` are proofs.md's (pipes inside code escaped so the table renders); the last ten are
this round's.

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
| `Ry_quarter_image_box`, `Ry_neg_quarter_image_box`, `worldBounds_x(_least)`, `worldBounds_z(_least)`, `worldBounds_quarter` | Item | a ±90° turn swaps a box's X and Z extents (§2.5); for any θ the world bounds are `w\|cos θ\| + d\|sin θ\|` × `w\|sin θ\| + d\|cos θ\|`, attained | geom props `quarter_turn_swaps_extents`, E3 planner eval |
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
| `frameWalk_ok`, `frameInfo_ok` | Jpeg.Frame | the JPEG size qwen is priced by is never guessed: an answer is the fields of a start-of-frame segment in the data, where the walk reached it, with a non-zero width and height (AENEAS.md #3) | proofs/diff frame: 30,476 files identical |
| `isSlug_iff`, `isSlug_ascii`, `isSlug_safe`, `isSlug_length` | Slug | `is_slug` is exactly `^[a-z0-9][a-z0-9-]{0,63}$` (no trailing newline); a slug is ASCII, has no `/`, `\`, `.`, NUL, newline or space and isn't `.`/`..`: one path component inside the folder it is joined to (AENEAS.md #6) | k-media props (regex oracle); proofs/diff slug: 20,000 strings identical |
| `split_freed_spec`, `pad4_spec`, `shift_mod16` | Glb | the compact GLB layout removes whole 16-byte blocks (padding < 16, nothing lost), `pad4` pads to a multiple of 4 on a 64-bit `usize`, and every later bufferView keeps its offset mod 16 (AENEAS.md #1) | k-media GLB properties |
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
| `decodePython_strict_iff` | Base64 | strict `decode_python` (v1's `b64decode(…, validate=True)`) accepts exactly padded base64: alphabet characters, then `==` after 2 mod 4 of them, `=` after 3 mod 4, nothing after 0 mod 4 (no leading or excess padding, nothing after it, 1 mod 4 never), and the bytes are the characters' bits cut to whole bytes (AENEAS.md #5) | proofs/diff b64: 20,006 inputs identical |
| `decodePython_encode`, `encode_length`, `encode_ascii` | Base64 | `decode_python(encode(x), true) = x` for every byte string; `encode` writes 4 ASCII characters per started group of 3 bytes | k-media test `round_trip`; proofs/diff b64 |
| `decodePython_lenient_of_strict` | Base64 | the lenient mode (v1's GLB texture scrub) reads every strict input the same way | proofs/diff b64 (both modes) |
| `metaDecode_ok_iff`, `metaDecode_encode`, `metaDecode_length`, `metaDecode_cap` | Base64 | `X-Midstudy-Meta` (§2.8, §4.4): a header is accepted exactly when it is within the cap, ASCII, strict base64 and decodes to UTF-8 (Rust's `from_utf8`, Unicode Table 3-7, modelled as `utf8Valid`); a header made from UTF-8 text is read back as that text; the text is at most 3/4 of the header (12 KiB under the 16 KiB cap) | proofs/diff meta: 20,000 inputs identical (both caps) |
| `photoExt_sniff`, `photoExt_sniffHead`, `heif_spec`, `chunks4_eq` | Sniff | **v2's sniff is v1's ingest table** (§4.3, §4.4): `photo_ext(sniff(data))` equals calib's `sniff(data[:64])` (transcribed with Python's slicing and `range`) for every input; Rust's `chunks_exact(4)` of `head[16..min(size, len)]` are Python's compatible brands (AENEAS.md #8) | proofs/diff sniff: 20,103 inputs identical, and calib's own Python agrees on all |
| `sniff_take`, `sniff_jpeg_iff`, `sniff_png_iff`, `sniff_heif`, `sniff_glb`, `sniff_zip` | Sniff | only the first 64 bytes count; JPEG is exactly `FF D8 FF` first, PNG exactly the signature; HEIC/HEIF only from an `ftyp` box at 4 with an HEVC or generic HEIF major brand; GLB and zip by their magic | k-media sniff tests |
| `u32_eq_some`, `bytes_eq_some`, `readEntry_pos` | Wire | wasm-node's `wire::Reader` never reads past its buffer: `u32` succeeds exactly when 4 bytes are left, `bytes` exactly when the length-prefixed slice is inside, returning exactly that slice; positions only move forward, never past the end (AENEAS.md #10) | proofs/diff wire: 20,001 inputs identical |
| `readAll_pack`, `readAll_eq_some_iff`, `Raw.size_eq`, `Raw.size_split` | Wire | `zip_plan`'s input loop reads back every packing of the TypeScript face (`node.ts` `zipPlan`, fields below 2³²) exactly, and nothing else: any other buffer is `bad-input`; `low \| high << 32` is the size the face split in two words | proofs/diff wire (`api::zip_plan`'s `bad-input` too) |
| `hull_vertices`, `hull_contains`, `push_inv`, `cr_trans`, `upper_eq` | Hull | v1's `convexHull` (hull.rs computes it in a buffer) over ℝ: every vertex is an input point, and every input point is on or left of every edge, the closing one included, so `pointInHull` holds for it whenever the hull has ≥ 3 vertices (LEAN.md 17). The proof: each pop keeps every processed point on or left of every stack edge (turns are monotone over vectors in the right half plane); the upper chain is the lower chain of the points turned by 180° | geom props `hull_contains_its_points`, geom's differential test against v1 |
| `hull_turns_left`, `chain_convex`, `junction_right`, `junction_left` | Hull | unless the points are all on one line, every turn of the hull is strictly left: inside the lower and the upper chain, and at the rightmost and leftmost points where they meet (a straight turn there would put every point on that line: `reversal_line`) (LEAN.md 17) | geom props `hull_contains_its_points` (turns) |

## k-geom's LEAN.md, property by property (current)

Row 17 is this round's; the others are as in proofs.md.

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
| 10 | the horizon drag cap | `pitchFromHorizon_lipschitz`, `horizon_drag_cap` (`\|Δpitch\| ≤ min(degPerCssPx, 0.12)·\|Δy\|`) |
| 11 | clamps in range, idempotent; round6 monotone | `clamp_*`, `round6_gridRound`, `clampCamera_*`, `lookNum_*` |
| 12 | wraps in range, congruent, idempotent | `wrapDeg_*`, `wrapAz_*` |
| 13 | four quarter turns return the stored angle | **false as stated**: `rotateBy_four_quarters_exception` (a stored −180, from any angle within 5·10⁻⁷ of −180, comes back as 180; the Rust does the same, checked on −179.9999999 and −179.9999996); true otherwise: `rotateBy_four_quarters_stored`, `rotateBy_four_quarters` |
| 14 | Ry(90°)·x = −z; Ry(90°)⁴ = I | `Ry_quarter_x`, `Ry_quarter_pow_four` |
| 15 | bounds extents `\|cos\|w + \|sin\|d`, quarter turn swaps | `worldBounds_x(_least)`, `worldBounds_z(_least)`, `worldBounds_quarter` |
| 16 | every point within the corners' bounds; footprint centre | `corners_bound_x/y/z`, `footprint_centre` |
| 17 | hull vertices are inputs, turn left, contain the points | `hull_vertices` (inputs), `hull_contains` (every input point on or left of every edge; `pointInHull` with ≥ 3 vertices), `hull_turns_left` (every turn strictly left unless all points are on one line: `chain_convex` inside the chains, `junction_right`, `junction_left` where they meet). Over ℝ; f64 is geom's proptest |
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

## k-media's AENEAS.md, target by target (current)

| # | Target | Lean | Compared with the Rust |
|---|---|---|---|
| 1 | `glb::split_freed`, `glb::pad4` | `Glb.lean`: `split_freed_spec`, `pad4_spec`, `shift_mod16` | arithmetic only (k-media GLB properties) |
| 2 | `zip::megabytes` | `Arith.lean`: `megabytes_eq_roundHalfEven`, `megabytes_lt` | arithmetic only (k-media test) |
| 3 | `jpeg::frame_info` | `Jpeg/Frame.lean`: `frameWalk_ok`, `frameInfo_ok` | proofs/diff frame |
| 4 | `png::strip` | `Png.lean`: `strip_idem`, `strip_no_metadata`, `strip_chunks`, `strip_eq_self_iff` | proofs/diff png |
| 5 | `base64::decode_python`, `base64::encode` (and `meta::decode`) | `Base64.lean`: `decodePython_strict_iff`, `decodePython_encode`, `decodePython_lenient_of_strict`, `metaDecode_*` | proofs/diff b64, meta |
| 6 | `slug::is_slug` | `Slug.lean`: `isSlug_iff`, `isSlug_ascii`, `isSlug_safe` | proofs/diff slug |
| 7 | the digit fold in `http::content_length` | `Arith.lean`: `foldDigits_eq`, `foldDigits_lt` | arithmetic only (k-media http tests) |
| 8 | `sniff::sniff`, `sniff::heif` | `Sniff.lean`: `photoExt_sniff`, `heif_spec`, the rows | proofs/diff sniff (and calib's Python) |
| 9 | `jpeg::step`, `scan_end`, `is_clean`, `strip` | `Jpeg/Model.lean`, `Jpeg/Proofs.lean` | proofs/diff jpeg |
| 10 | wasm-node `wire::Reader` | `Wire.lean`: `u32_eq_some`, `bytes_eq_some`, `readAll_eq_some_iff` | proofs/diff wire (and `api::zip_plan`) |

## Decisions

- **Base64 is modelled check for check**, errors with their offsets (`NotBase64@i`), because the header's error text
  and v1's behaviour depend on them. Rust's `i + 1 < input.len()` (data after complete padding) is "`c` is not the last
  character", which the model writes as `rest ≠ []`; `quad` and `pads` stay below 4, so `saturating_add` is plain
  addition. The u8 bit operations (`wrapping_shl`, `wrapping_shr`, `&`, `|`) are Lean's `UInt8` operations (the same
  modulo-8 shifts), proved equal to the natural-number arithmetic of the specification (`byte1`–`byte3`).
- **UTF-8 is modelled, not borrowed**: `utf8Valid` is Unicode's Table 3-7 written out (what Rust's `from_utf8`
  accepts); the `meta` mode compares it with the Rust twice per input (the decoded text, and whether the header is a
  `&str` at all), at 20,000 inputs including every boundary of the table.
- **sniff is proved equal to v1's Python, not only described**: `calibSniff` transcribes calib's function line by line
  (Python's `range(16, min(size, len) - 3, 4)` as `pyRange`; a negative stop is an empty range either way), and
  `compare.py` also runs calib's own function (taken from `ingest.py` with `ast`) on every sniff input, so the
  transcription is checked too.
- **The wire reader is modelled with natural numbers**: `at.checked_add(len)` then `data.get(at..end)` is one check,
  `at + len ≤ len(data)`, because an overflowing sum is past the end of any slice. As in Rust, nothing of a failed
  read is kept (the Rust reader may have moved past a length prefix, but `read_entry` and `zip_plan` give up at once).
- **The hull is v1's algorithm** (`lo.slice(0, -1).concat(hi.slice(0, -1))` over the points sorted by x then y),
  which hull.rs computes in one buffer (the upper chain cannot pop below the lower chain's last point, so it is the
  lower chain of the reversed points); geom's differential test pins hull.rs to v1's output. The sort is
  `List.mergeSort` by x then y: over ℝ, points equal under the order are equal, so every sort gives the same list.
  Floats are not covered (in f64 the containment holds up to rounding; geom's property test checks it).

## Not proved, and open

- LEAN.md 17 is proved over ℝ for v1's list algorithm; that hull.rs's one-buffer version returns the same list is
  argued in its comment and pinned by geom's differential test against v1, not proved here.
- LEAN.md 23's rank-9 claim (numeric) and 28 (half floats): as in proofs.md, not proved.
- Aeneas and Charon: still blocked (proofs.md).
- **kernels-hardening is not on `v2`**: its crates were measured at `a7953e9` and `1a13d59` (its tips while this ran;
  that track was still committing). After the integration merges it, run `nix develop -c proofs/diff/run.sh 20000` in place
  once more.

## Requests to other tracks

- **integration**: fold this file's two tables (and the AENEAS.md one) into `docs/notes/proofs.md` if one place is
  wanted; this track owns `proofs/**` and `nix/lean.nix` only. Re-run `proofs/diff` in place after merging
  kernels-hardening (above).
- **kernels-hardening / k-media**: the harness calls `midstudy_media::base64::{decode_python, encode}`,
  `meta::{decode, MAX_HEADER_LEN, MetaError}`, `sniff::{sniff, Kind::name, Kind::photo_ext}` besides the earlier
  names, and compiles wasm-node's `wire.rs` and `api.rs` by path: keep those two files depending only on
  `midstudy_media` and `crate::wire` (true at `979677c` and `a7953e9`), or tell proofs.
- **k-geom**: LEAN.md 17 is proved (over ℝ, for v1's algorithm): its "[props …]" note can name `Midstudy/Hull.lean`.
