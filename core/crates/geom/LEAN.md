# What the proofs track should prove (midstudy-geom, midstudy-raster)

The Rust is f64 and is checked by tests (golden scenes, differential tests against v1, proptest). The Lean side proves
the same formulas over ℝ (Mathlib), so a property here is the exact-arithmetic statement of a test there. Everything
below is what the code computes; the Rust function is named after each item. Float-only guards (thresholds such as
`1e-9`, `1e-6`, `1e-4`, `1e-3`) are listed separately: over ℝ they become strict inequalities or disappear.

Notation: `deg = π / 180`. Points `p = (x, y, z)`, world Y-up, the floor `y = 0`. Matrices act on column vectors.

## 1. The camera model (contract §4.1; `camera.rs`)

Camera block `b = (fov, h, pitch, roll)` with ranges `fov ∈ [20, 110]`, `h ∈ [0.2, 3]`, `pitch ∈ [−80, 30]`,
`roll ∈ [−20, 20]` (degrees, meters). Photo size `W, H > 0`.

```
Rx(a) = [[1, 0, 0], [0, cos a, −sin a], [0, sin a, cos a]]
Rz(a) = [[cos a, −sin a, 0], [sin a, cos a, 0], [0, 0, 1]]
R     = Rx(pitch·deg) · Rz(roll·deg)                       -- Camera::rotation
      = [[cr, −sr, 0], [cp·sr, cp·cr, −sp], [sp·sr, sp·cr, cp]]   (cp = cos pitch, sr = sin roll, …)
C     = (0, h, 0)                                            -- Camera::eye
f     = (H / 2) / tan(fov·deg / 2)                           -- Camera::focal
c(p)  = Rᵀ · (p − C)                                         -- Camera::to_camera
d(p)  = −c(p).z
project(p) = (W/2 + f·c.x / d, H/2 − f·c.y / d, d)           -- Camera::project  (d ≠ 0)
dirc(px, py) = ((px − W/2) / f, −(py − H/2) / f, −1)         -- camera-frame ray
dir(px, py)  = R · dirc(px, py)                              -- Camera::ray_dir (Camera::ray normalises it)
photoToFloor(px, py) = C + t · dir,  t = −h / dir.y,  defined iff dir.y < 0     -- Camera::photo_to_floor
horizonAt(px) = H/2 − f · yc,  yc = (−tan(pitch·deg) − sin(roll·deg) · (px − W/2)/f) / cos(roll·deg)
                                                             -- Camera::horizon_at
pitchFromHorizon(py) = −atan(cos(roll·deg) · (−(py − H/2)/f)) / deg                 -- Camera::pitch_from_horizon
```

Properties (each is a theorem to prove; the matching Rust test is in brackets):

1. **R is a rotation**: `Rᵀ R = I`, `det R = 1`, and `R = Rx · Rz` as written out above. [props `rotation_is_rx_rz`]
2. **Depth**: `d(p) > 0` iff `p` is in front of the camera (the half-space `(p − C) · R·(0,0,−1) > 0`).
3. **Projection inverts the ray**: for any `(px, py)` and `t > 0`, `project(C + t·dir(px, py)) = (px, py, t)`.
   (The depth of the point at parameter `t` along the unnormalised `dir` is exactly `t`, because `dirc.z = −1`.)
4. **Round trip, photo → floor → photo**: if `dir(px, py).y < 0` then `photoToFloor(px, py).y = 0`, its depth is
   `t > 0`, and `project(photoToFloor(px, py)) = (px, py)`. [props `photo_floor_photo_round_trip`, golden
   `photo_to_floor_inverts_the_floor_points`]
5. **Round trip, floor → photo → floor**: for `q` with `q.y = 0`, `d(q) > 0` and `dir(project(q)).y < 0`:
   `photoToFloor(project(q)) = q`. Note `dir(project(q)).y < 0` holds for every floor point in front of the camera
   (it is `−h / d(q) < 0`); prove that too. [props `floor_photo_floor_round_trip`]
6. **The horizon**: with `cos(roll) > 0` (true on the roll range) and `cos(pitch) > 0` (true on the pitch range),
   `dir(px, py).y = cos(pitch) · (sin(roll)·xc + cos(roll)·yc) + sin(pitch)` with `xc = (px − W/2)/f`,
   `yc = −(py − H/2)/f`; it is strictly decreasing in `py`, zero exactly at `py = horizonAt(px)`, so
   `photoToFloor(px, py)` is defined ⟺ `py > horizonAt(px)` (below the horizon line in the image).
   [props `nothing_above_the_horizon`, golden `horizon_and_signs_are_pinned`]
7. **Signs (contract §4.1)**: with roll 0, `horizonAt(px) = H/2 − f · tan(−pitch·deg)` for every `px`, which is
   `< H/2` when `pitch < 0` (looking down puts the horizon above the centre). `d horizonAt / d px = tan(roll·deg)`, so
   positive roll makes the horizon fall to the right (`horizonAt(W) > horizonAt(0)`). Up in the world is up in the
   photo at roll 0: `∂py/∂y < 0` for points in front. [golden `horizon_and_signs_are_pinned`, camera unit tests]
8. **Horizon and pitch invert**: for `|pitch| < 90`, `pitchFromHorizon(horizonAt(W/2)) = pitch`. [props
   `horizon_pitch_inverse`]
9. **Scale (contract §4.5, depth scaling, the ruler)**: for the same angles and `h' = s·h` (`s > 0`),
   `photoToFloor_{h'}(px, py) = s · photoToFloor_h(px, py)`, and the depth of the scaled scene point under a pixel is
   `s` times the original's. So scaling depth.png by `h / h_calib` (`depth_scale`) keeps the photo's depth consistent
   with a height changed in Adjust floor, and the ruler's rescale `h' = h · true / measured` makes the measured floor
   distance equal `true` (`ruler_rescale` when the clamp doesn't bind).
10. **The horizon drag cap (§4.5)**: `|∂ pitchFromHorizon / ∂ py| ≤ (1 / f) / deg` degrees per photo pixel. With
    `s` CSS px per photo px, the row asked for is `py0 + (Δy / s) · g` with
    `g = min(1, 0.12 / ((360/π) · tan(fov·deg/2) / rect_h))` and `rect_h = s · H`, hence
    `|Δpitch| ≤ 0.12 · |Δy|` whenever `g < 1`, and `≤ (1/(s·f))/deg · |Δy|` otherwise. [props
    `horizon_drag_is_capped`]

## 2. Clamps, rounding, wrapping (`camera.rs`, `look.rs`, `jsmath.rs`)

```
clamp(v, lo, hi)  = min(hi, max(lo, v))
round6(v)         = ⌊v · 10⁶ + ½⌋ / 10⁶                      -- JS Math.round: ties toward +∞ (jsmath::round_to)
clampCamera(c, b) = per field: round6(clamp(c_k, lo_k, hi_k)) if c_k is a number, else round6(b_k)
wrapDeg(x)        = ((x + 180) mod 360) − 180, with −180 ↦ 180    (mod with the sign of the dividend, then +360)
wrapAz(a)         = ((a + 180) mod 360) − 180, with −180 ↦ 180 only when a > 0
look clamps       = clamp(v, lo, hi) per key (exposure [0.25, 4], warmth [−1, 1], azimuth [−180, 180] after wrapAz,
                    elevation [5, 90], softness [0, 1], strength [0, 3], ambient [0, 3])
clampElevation(y) = clamp(y, 0, 4)
```

11. `clamp(v) ∈ [lo, hi]`; `clamp ∘ clamp = clamp`; `round6` is monotone and idempotent; the range ends are multiples
    of 10⁻⁶ so `round6(clamp(v)) ∈ [lo, hi]`; hence `clampCamera` lands in range and is idempotent. [props
    `camera_clamp_idempotent_in_range`, `look_clamp_idempotent_in_range`]
12. `wrapDeg(x) ∈ (−180, 180]`, `wrapDeg(x) ≡ x (mod 360)`, `wrapDeg ∘ wrapDeg = wrapDeg`; `wrapAz(a) ∈ [−180, 180]`,
    `≡ a (mod 360)`. (Over f64, v1's `wrapAz` is idempotent only to an ulp of 360: the extra `+ 360` rounds. Kept for
    bit-compatibility with v1; the tests allow 2 ulps.) [props `wraps_in_range`]
13. `rotateBy(r, 90)` four times from `round6(wrapDeg(r))` returns it. [props `four_quarter_turns`]

## 3. Items (`item.rs`)

```
Ry(θ) = [[cos θ, 0, sin θ], [0, 1, 0], [−sin θ, 0, cos θ]],  θ = rotation_y_deg · deg
world(p_local) = Ry(θ) · p_local + position                   -- Transform::apply
corners(min, max) = world of (x, y, z) for y ∈ {min.y, max.y}, then (x, z) ∈
                    [(min.x, min.z), (max.x, min.z), (max.x, max.z), (min.x, max.z)]   -- box_corners
bounds = (componentwise min, max) of the 8 corners (min > max on an axis: returned as is)   -- world_bounds
footprint = world of (x, 0, z) for (x, z) ∈ [(min.x, max.z), (max.x, max.z), (max.x, min.z), (min.x, min.z)],
            centre = their mean                                -- footprint
screenRect = bounding rect of project(corner) over corners with d > 0                        -- screen_rect
```

14. `Ry(90°) · (1, 0, 0) = (0, 0, −1)` (positive turns are counterclockwise from above); `Ry(θ)⁴ = I` at 90°.
15. For a box centred on its footprint, the X extent of `bounds` at θ is `|cos θ|·w + |sin θ|·d` and the Z extent
    `|sin θ|·w + |cos θ|·d`, so a quarter turn swaps them. [props `quarter_turn_swaps_extents`]
16. Every point of the turned box lies within `bounds` (the box is the convex hull of its corners, and bounds are
    convex). The footprint centre is `world((min.x + max.x)/2, 0, (min.z + max.z)/2)`.

## 4. Hulls and hit tests (`hull.rs`)

Andrew's monotone chain over points sorted by (x, then y), popping while `cross(o, a, b) ≤ 0`,
`cross(o, a, b) = (a.x − o.x)(b.y − o.y) − (a.y − o.y)(b.x − o.x)`; output `lower[0..−1] ++ upper[0..−1]`; fewer than 3
points are returned sorted. `pointInHull(h, q)` = `|h| ≥ 3 ∧ ∀ edges (a, b): cross(a, b, q) ≥ 0`.
`distToHull(h, q)` = min over edges of the distance from `q` to the segment.

17. The output's vertices are input points; consecutive triples turn strictly left (`cross > 0`) when there are ≥ 3
    non-collinear points; every input point satisfies `pointInHull` (over ℝ exactly; in f64 up to rounding, which
    `distToHull ≤ ε` covers). [props `hull_contains_its_points`, and the differential test: v1's output exactly]

## 5. Planes and drags (`drag.rs`, `floor.rs`)

```
intersect(ray o + t·u, plane n·p + c = 0) = o + t·u with t = −(o·n + c) / (n·u) when n·u ≠ 0 and t ≥ 0
                                            (the origin when n·u = 0 and o is on the plane)
lift plane through position P: normal normalise(−P.x, 0, −P.z), constant −P·normal
drag move:   new (x, z) = round6(hit + (P − hit₀))      drag lift: round6(clamp(hit.y + (P.y − hit₀.y), 0, 4))
rotate:      θ' = round6(wrapDeg(θ₀ + (atan2(h.x − P.x, h.z − P.z) − atan2(h₀.x − P.x, h₀.z − P.z)) / deg))
landing:     the first floor hit, of the rays through the visible photo's centre and lower-third centre, whose
             distance √(x² + h² + z²) ∈ [1, 6]; else (0, 0, −2.5); then the first point of rings
             r = 0..5 (8r points, angle 2πk/8r, radius 0.6 r) with z < −0.6 and every taken (x, z) farther than 0.45
```

18. On the floor plane, `intersect(ray(px, py), y = 0) = photoToFloor(px, py)` when `dir.y < 0`. [props
    `floor_plane_hit_is_photo_to_floor`]
19. A move drag keeps the grabbed point under the pointer: if `hit₀` is the plane point under the pointer at the
    start, then after moving the piece by `hit − hit₀` the piece's grabbed point (at height `y_plane`) projects to
    the current pointer. (`drag_height` keeps `y_plane` within the piece and 0.15 m from the eye height, where the
    plane is not seen edge-on.)
20. The landing result is either the base or a point with `z < −0.6` farther than 0.45 from every taken point.

## 6. Light (`look.rs`, `raster/sh.rs`)

```
azEl(d) = (atan2(d.x, −d.z) / deg, asin(clamp(d.y, −1, 1)) / deg)    dirOf(az, el) = (cos el sin az, sin el, −cos el cos az)
turnBetween(a, b) = the rotation of the unit quaternion normalise(a × b, 1 + a·b) (three.js setFromUnitVectors)
irradiance basis (three.js shGetIrradianceAt), at unit (x, y, z):
  [0.886227, 1.023328 y, 1.023328 z, 1.023328 x, 0.858086 xy, 0.858086 yz, 0.743125 z² − 0.247708, 0.858086 xz,
   0.429043 (x² − y²)]
E_sh(d) = Σᵢ basisᵢ(d) · shᵢ
rotate(sh, R): L00 kept; (L11, L1−1, L10) ↦ R · (L11, L1−1, L10); band 2 by least squares over the 96 Fibonacci
               directions dₖ (y = 1 − 2(k + ½)/96, angle k·π(3 − √5)) of E_band2(Rᵀ dₖ)
splat level = (A · ambient + K · strength) / (A + K), A = lum(E_world(0, 1, 0)), K = ½ · lum(key colour) · intensity
```

21. `dirOf(azEl(d)) = d` for unit `d` with `d.y ∈ (−1, 1)`; `azEl(dirOf(az, el)) = (az, el)` on `az ∈ (−180, 180]`,
    `el ∈ [−90, 90]`.
22. `turnBetween(a, b) · a = b` for unit `a ≠ −b`, and it is a rotation.
23. **SH rotation is exact for the irradiance**: `E_{rotate(sh, R)}(R·d) = E_sh(d)` for all unit `d` and rotations
    `R`. Bands 0–1: the band-1 terms are `1.023328 · (L11, L1−1, L10) · d`, invariant under turning both by `R`. Band 2:
    the 96 × 9 design matrix of the basis at the Fibonacci directions has rank 9, so least squares recovers any
    function in the basis' span exactly, and `E_band2(Rᵀ ·)` is in that span (a quadratic form plus a constant).
    Note the constant: `0.743125 z² − 0.247708` has mean `0.743125/3 − 0.247708 ≈ 3.3·10⁻⁷` on the sphere, so turning
    band 2 moves `3.3·10⁻⁷ × L20`-sized amounts into band 0, as the refit computes. [raster props
    `sh_rotation_keeps_irradiance`, `sh_rotations_compose`]
24. The splat level is 1 at `ambient = strength = 1`, monotone in both.

## 7. Integer kernels (`raster/png.rs`, `raster/mask.rs`): candidates for Aeneas

25. **PNG filters**: for each filter type t ∈ {0..4} and bytes mod 256, `unfilter_t(filter_t(row, prev), prev) = row`
    (Sub, Up, Average with `⌊(a + b)/2⌋`, Paeth with ties `a`, then `b`). Paeth picks the neighbour nearest
    `a + b − c`. [raster props `decoder_round_trips_every_filter`]
26. **The decoder is total**: for every byte string it returns an error or an image whose sample count is
    `width · height` (no panic, no out-of-bounds; the module denies indexing and unchecked arithmetic). [fuzz target
    `decode_png`, props `decoder_never_panics_*`]
27. **Dilation**: v1's two-pass scan (`since` counters left→right with reach `right`, right→left with `left`, then per
    column top→bottom with `down` and bottom→top with `up`) equals the box dilation
    `out(x, y) = ∃ x' ∈ [x − right, x + left], y' ∈ [y − down, y + up]: src(x', y') ≠ 0` (clipped to the image).
    The kernel's row pass fills `[s − left, e − 1 + right]` for each run `[s, e)` of set pixels instead; prove that
    this is the same set (the union of `[x − left, x + right]` over a run of consecutive `x` is that interval).
    [raster props `dilation_is_a_box`, unit test against v1's scan transcribed]
28. **Half floats**: `f32_to_f16` rounds to nearest, ties to even, and `f16_to_f32 ∘ f32_to_f16` is the identity on
    every half value. [raster `half` tests: all 65 536 values]

## 8. Float-only guards (not part of the ℝ statements)

| Rust | guard | over ℝ |
|---|---|---|
| `Camera::photo_to_floor` | unit `dir.y ≥ −1e-9` → none (v1) | `dir.y ≥ 0` → none (the contract) |
| `item::screen_rect`, `hitBox` | corners with `d ≤ 1e-4` ignored / "behind" | `d ≤ 0` |
| `Camera::horizon_at` | `|cos roll| < 1e-6` → none | never on the roll range |
| `drag::MAX_PICK_DISTANCE` | hits ≥ 60 m ignored | a UI rule, not geometry |
| `CameraBlock::same_as` | fields within 1e-6 | equality |
| `envmap` | `z ← −max(|z|, 1e-3)` (mirror), NDC clamped to [−1, 1] | the mirror is `z ← −|z|` |
| `sh::max_band_scale` | `e < −1e-9` counts as darker | `e < 0` |
