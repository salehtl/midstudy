import Midstudy.Rotation

/-!
# The camera model of contract §4.1, over ℝ

The scene camera stands at `C = (0, height_m, 0)`, looks along −Z (yaw 0) and is turned by the camera-to-world
rotation `R = Ry(0) · Rx(pitch) · Rz(roll)` (three.js Euler order 'YXZ'). A world point `p` has camera coordinates
`p_c = Rᵀ · (p − C)`, depth `d = −p_c.z`, and photo pixel `(W/2 + f · p_c.x / d, H/2 − f · p_c.y / d)` with the
focal length `f = (H/2) / tan(fov_y / 2)` in pixels. The inverse sends the ray through a pixel, camera direction
`((px − W/2)/f, −(py − H/2)/f, −1)`, world direction `R · that`, to the floor `y = 0`.

Names follow planner/engine.js: `focalPx`, `projectPhoto`, `photoRay`, `photoToFloor`, `floorToPhoto`.

Main results:
* `camR_mem_SO3`: `R` is a rotation (orthogonal, determinant 1), for every pitch and roll.
* `photoToFloor_floorToPhoto`: every floor point in front of the camera comes back from its own pixel.
* `floorToPhoto_photoToFloor`: every pixel strictly below the horizon has a floor point, in front of the camera,
  and that point's pixel is the pixel.
* `photoToFloor_eq_none_iff`, `no_floor_point_of_horizon_le`: pixels at or above the horizon have no floor point:
  `photoToFloor` answers `none`, and no floor point in front of the camera projects to them.
-/

noncomputable section

open Real Matrix

namespace Midstudy

/-- The camera-to-world rotation of contract §4.1, `R = Ry(0) · Rx(pitch) · Rz(roll)`, angles in radians. -/
def camR (pitch roll : ℝ) : Mat3 := Ry 0 * Rx pitch * Rz roll

/-- `R` is a rotation: in the special orthogonal group (orthogonal, determinant 1). -/
theorem camR_mem_SO3 (pitch roll : ℝ) : camR pitch roll ∈ specialOrthogonalGroup (Fin 3) ℝ :=
  Submonoid.mul_mem _ (Submonoid.mul_mem _ (Ry_mem_SO3 0) (Rx_mem_SO3 pitch)) (Rz_mem_SO3 roll)

theorem camR_transpose_mul (pitch roll : ℝ) : (camR pitch roll)ᵀ * camR pitch roll = 1 :=
  transpose_mul_of_mem_SO3 (camR_mem_SO3 pitch roll)

theorem camR_mul_transpose (pitch roll : ℝ) : camR pitch roll * (camR pitch roll)ᵀ = 1 :=
  mul_transpose_of_mem_SO3 (camR_mem_SO3 pitch roll)

theorem camR_det (pitch roll : ℝ) : (camR pitch roll).det = 1 :=
  det_of_mem_SO3 (camR_mem_SO3 pitch roll)

/-- `R`'s entries (`a` the pitch, `b` the roll): what an implementation multiplies out. -/
theorem camR_eq (a b : ℝ) : camR a b =
    !![cos b, -sin b, 0; cos a * sin b, cos a * cos b, -sin a; sin a * sin b, sin a * cos b, cos a] := by
  ext i j
  fin_cases i <;> fin_cases j <;> simp [camR, Rx, Rz, Matrix.mul_apply, Fin.sum_univ_three]

/-- The camera block of contract §4.1, the same object in every file and API (degrees and meters). -/
structure CameraBlock where
  fov_y_deg : ℝ
  height_m : ℝ
  pitch_deg : ℝ
  roll_deg : ℝ

/-- A photo's size in pixels, `W × H` (`photo.w`, `photo.h` in the planner). -/
structure Photo where
  w : ℝ
  h : ℝ

namespace CameraBlock

variable (c : CameraBlock) (ph : Photo)

/-- The camera-to-world rotation of the block. -/
def R : Mat3 := camR (rad c.pitch_deg) (rad c.roll_deg)

/-- The camera's position `C = (0, height_m, 0)`. -/
def center : Vec3 := ![0, c.height_m, 0]

/-- Camera coordinates `p_c = Rᵀ · (p − C)`: x right, y up, looking along −z. -/
def toCamera (p : Vec3) : Vec3 := c.Rᵀ *ᵥ (p - c.center)

/-- Depth along the view axis, `d = −p_c.z` (what depth.png stores). -/
def depth (p : Vec3) : ℝ := -c.toCamera p 2

/-- The focal length in pixels, `f = (H / 2) / tan(fov_y / 2)` (engine.js `focalPx`). -/
def focalPx : ℝ := ph.h / 2 / tan (rad c.fov_y_deg / 2)

/-- `[px, py, d]`: a world point's photo pixel and depth (engine.js `projectPhoto`). -/
def projectPhoto (p : Vec3) : ℝ × ℝ × ℝ :=
  (ph.w / 2 + c.focalPx ph * c.toCamera p 0 / c.depth p,
   ph.h / 2 - c.focalPx ph * c.toCamera p 1 / c.depth p,
   c.depth p)

/-- A world point's photo pixel (engine.js `floorToPhoto`: "any point, despite the name"). -/
def floorToPhoto (p : Vec3) : ℝ × ℝ := ((c.projectPhoto ph p).1, (c.projectPhoto ph p).2.1)

/-- The camera direction of the ray through photo pixel `(px, py)`. -/
def camDir (px py : ℝ) : Vec3 :=
  ![(px - ph.w / 2) / c.focalPx ph, -(py - ph.h / 2) / c.focalPx ph, -1]

/-- The world direction of the ray through photo pixel `(px, py)`, `R · camDir` (engine.js `photoRay`'s `dir`,
before it is normalized: `floorHit_smul` shows the normalization changes nothing). -/
def photoRay (px py : ℝ) : Vec3 := c.R *ᵥ c.camDir ph px py

end CameraBlock

/-- Where the ray from `origin` along `dir` meets the floor `y = 0` (engine.js `photoToFloor` after `photoRay`):
`none` when `dir` doesn't point down, else `origin + t · dir` with `t = −origin.y / dir.y`, written with its
y as exactly 0 as the planner writes it. -/
def floorHit (origin dir : Vec3) : Option Vec3 :=
  if 0 ≤ dir 1 then none
  else some ![origin 0 + -origin 1 / dir 1 * dir 0, 0, origin 2 + -origin 1 / dir 1 * dir 2]

/-- Scaling the direction by any positive factor (normalizing it, say) gives the same floor point. -/
theorem floorHit_smul (origin dir : Vec3) {k : ℝ} (hk : 0 < k) : floorHit origin (k • dir) = floorHit origin dir := by
  unfold floorHit
  simp only [Pi.smul_apply, smul_eq_mul]
  by_cases h : 0 ≤ dir 1
  · rw [if_pos h, if_pos (mul_nonneg hk.le h)]
  · have hk' : k ≠ 0 := hk.ne'
    have hd : dir 1 ≠ 0 := fun h0 => h (by rw [h0])
    rw [if_neg h, if_neg (by intro h1; exact h (nonneg_of_mul_nonneg_right h1 hk))]
    congr 1
    ext i
    fin_cases i <;> simp <;> field_simp

namespace CameraBlock

variable (c : CameraBlock) (ph : Photo)

/-- The floor point under photo pixel `(px, py)`, or `none` at or above the horizon (contract §4.1 Inverse;
engine.js `photoToFloor`). -/
def photoToFloor (px py : ℝ) : Option Vec3 := floorHit c.center (c.photoRay ph px py)

theorem R_mem_SO3 : c.R ∈ specialOrthogonalGroup (Fin 3) ℝ := camR_mem_SO3 _ _

theorem R_mulVec_toCamera (p : Vec3) : c.R *ᵥ c.toCamera p = p - c.center := by
  rw [toCamera, Matrix.mulVec_mulVec, R, camR_mul_transpose, Matrix.one_mulVec]

theorem toCamera_R_mulVec (v : Vec3) : c.Rᵀ *ᵥ (c.R *ᵥ v) = v := by
  rw [Matrix.mulVec_mulVec, R, camR_transpose_mul, Matrix.one_mulVec]

@[simp] theorem center_zero : c.center 0 = 0 := rfl
@[simp] theorem center_one : c.center 1 = c.height_m := rfl
@[simp] theorem center_two : c.center 2 = 0 := rfl

variable {c ph}

/-- The ray through a point's pixel passes through the point: its world direction is `(p − C) / d`. -/
theorem photoRay_floorToPhoto (hf : c.focalPx ph ≠ 0) {p : Vec3} (hd : c.depth p ≠ 0) :
    c.photoRay ph (c.floorToPhoto ph p).1 (c.floorToPhoto ph p).2 = (c.depth p)⁻¹ • (p - c.center) := by
  have hz : c.toCamera p 2 = -c.depth p := by simp [depth]
  have hcam : c.camDir ph (c.floorToPhoto ph p).1 (c.floorToPhoto ph p).2 = (c.depth p)⁻¹ • c.toCamera p := by
    ext i
    fin_cases i
    · simp only [camDir, floorToPhoto, projectPhoto]
      simp
      field_simp
    · simp only [camDir, floorToPhoto, projectPhoto]
      simp
      field_simp
    · simp only [camDir]
      simp [hz]
      field_simp
  rw [photoRay, hcam, Matrix.mulVec_smul, R_mulVec_toCamera]

/-- **Floor point → pixel → floor point.** Every floor point in front of the camera comes back from its own pixel
(for a camera above the floor and a non-degenerate focal length). -/
theorem photoToFloor_floorToPhoto (hh : 0 < c.height_m) (hf : c.focalPx ph ≠ 0) {p : Vec3} (hp : p 1 = 0)
    (hd : 0 < c.depth p) :
    c.photoToFloor ph (c.floorToPhoto ph p).1 (c.floorToPhoto ph p).2 = some p := by
  have hd0 : c.depth p ≠ 0 := hd.ne'
  have hy : ((c.depth p)⁻¹ • (p - c.center)) 1 = -c.height_m / c.depth p := by
    simp [hp]
    ring
  rw [photoToFloor, photoRay_floorToPhoto hf hd0, floorHit, if_neg]
  · congr 1
    ext i
    fin_cases i
    · simp only [hy]
      simp
      field_simp
    · simp [hp]
    · simp only [hy]
      simp
      field_simp
  · rw [hy, not_le]
    exact div_neg_of_neg_of_pos (neg_lt_zero.2 hh) hd

/-- **Pixel → floor point → pixel.** Every pixel strictly below the horizon (its ray points down) has a floor
point; that point is on the floor, in front of the camera, and its pixel is the pixel. -/
theorem floorToPhoto_photoToFloor (hh : 0 < c.height_m) (hf : c.focalPx ph ≠ 0) {px py : ℝ}
    (hbelow : c.photoRay ph px py 1 < 0) :
    ∃ q, c.photoToFloor ph px py = some q ∧ q 1 = 0 ∧ 0 < c.depth q ∧ c.floorToPhoto ph q = (px, py) := by
  set dir := c.photoRay ph px py with hdir
  set t := -c.height_m / dir 1 with ht
  have hdy : dir 1 ≠ 0 := hbelow.ne
  have htpos : 0 < t := div_pos_of_neg_of_neg (neg_lt_zero.2 hh) hbelow
  have htd : t * dir 1 = -c.height_m := by rw [ht]; field_simp
  set q : Vec3 := ![t * dir 0, 0, t * dir 2] with hq
  refine ⟨q, ?_, by simp [hq], ?_⟩
  · rw [photoToFloor, floorHit, if_neg (not_le.2 hbelow)]
    simp [hq, ht, hdir]
  · -- `q − C = t · dir`, so `q`'s camera coordinates are `t · camDir`
    have hqc : q - c.center = t • dir := by
      ext i
      fin_cases i
      · simp [hq]
      · simp [hq, htd]
      · simp [hq]
    have hcam : c.toCamera q = t • c.camDir ph px py := by
      rw [toCamera, hqc, hdir, photoRay, Matrix.mulVec_smul, toCamera_R_mulVec]
    have hdepth : c.depth q = t := by
      rw [depth, hcam]
      simp [camDir]
    refine ⟨by rw [hdepth]; exact htpos, ?_⟩
    have ht0 : t ≠ 0 := htpos.ne'
    simp only [floorToPhoto, projectPhoto, hdepth, hcam]
    simp [camDir]
    constructor <;> field_simp <;> ring

/-- At or above the horizon (the ray doesn't point down) `photoToFloor` answers `none`, and only there. -/
theorem photoToFloor_eq_none_iff {px py : ℝ} :
    c.photoToFloor ph px py = none ↔ 0 ≤ c.photoRay ph px py 1 := by
  unfold photoToFloor floorHit
  by_cases h : 0 ≤ c.photoRay ph px py 1 <;> simp [h]

/-- **Nothing on the floor at or above the horizon.** No floor point in front of the camera projects to a pixel
whose ray doesn't point down. -/
theorem no_floor_point_of_horizon_le (hh : 0 < c.height_m) (hf : c.focalPx ph ≠ 0) {px py : ℝ}
    (hup : 0 ≤ c.photoRay ph px py 1) :
    ¬ ∃ p : Vec3, p 1 = 0 ∧ 0 < c.depth p ∧ c.floorToPhoto ph p = (px, py) := by
  rintro ⟨p, hp, hd, hpix⟩
  have hray := photoRay_floorToPhoto (c := c) (ph := ph) hf hd.ne'
  rw [hpix] at hray
  have : c.photoRay ph px py 1 = -c.height_m / c.depth p := by
    rw [hray]
    simp [hp]
    ring
  rw [this] at hup
  exact absurd hup (not_le.2 (div_neg_of_neg_of_pos (neg_lt_zero.2 hh) hd))

/-! ### The ranges of §4.1 make the model non-degenerate -/

/-- The ranges every writer clamps the camera block to (contract §4.1). -/
structure InRange (c : CameraBlock) : Prop where
  fov : 20 ≤ c.fov_y_deg ∧ c.fov_y_deg ≤ 110
  height : 0.2 ≤ c.height_m ∧ c.height_m ≤ 3
  pitch : -80 ≤ c.pitch_deg ∧ c.pitch_deg ≤ 30
  roll : -20 ≤ c.roll_deg ∧ c.roll_deg ≤ 20

theorem InRange.height_pos {c : CameraBlock} (h : c.InRange) : 0 < c.height_m := by
  have := h.height.1
  norm_num at this ⊢
  linarith

theorem rad_lt_pi_div_two {x : ℝ} (hx : x < 90) : rad x < π / 2 := by
  unfold rad
  have := Real.pi_pos
  nlinarith

theorem neg_pi_div_two_lt_rad {x : ℝ} (hx : -90 < x) : -(π / 2) < rad x := by
  unfold rad
  have := Real.pi_pos
  nlinarith

/-- The focal length is positive for every field of view strictly between 0° and 180° and a photo with height. -/
theorem focalPx_pos {c : CameraBlock} {ph : Photo} (hH : 0 < ph.h) (h0 : 0 < c.fov_y_deg)
    (h1 : c.fov_y_deg < 180) : 0 < c.focalPx ph := by
  unfold focalPx
  apply div_pos (by linarith)
  apply Real.tan_pos_of_pos_of_lt_pi_div_two
  · unfold rad
    have := Real.pi_pos
    positivity
  · have : rad c.fov_y_deg < π := by
      unfold rad
      have := Real.pi_pos
      nlinarith
    linarith

theorem InRange.focalPx_pos {c : CameraBlock} (h : c.InRange) {ph : Photo} (hH : 0 < ph.h) :
    0 < c.focalPx ph :=
  Midstudy.CameraBlock.focalPx_pos hH (by linarith [h.fov.1]) (by linarith [h.fov.2])

theorem InRange.cos_pitch_pos {c : CameraBlock} (h : c.InRange) : 0 < cos (rad c.pitch_deg) :=
  Real.cos_pos_of_mem_Ioo ⟨neg_pi_div_two_lt_rad (by linarith [h.pitch.1]),
    rad_lt_pi_div_two (by linarith [h.pitch.2])⟩

theorem InRange.cos_roll_pos {c : CameraBlock} (h : c.InRange) : 0 < cos (rad c.roll_deg) :=
  Real.cos_pos_of_mem_Ioo ⟨neg_pi_div_two_lt_rad (by linarith [h.roll.1]),
    rad_lt_pi_div_two (by linarith [h.roll.2])⟩

/-- **The round trips for every camera in range.** For a camera block within §4.1's ranges and any photo with a
height, floor point → pixel → floor point is the identity in front of the camera, and pixel → floor point → pixel
is the identity strictly below the horizon. -/
theorem InRange.roundTrips {c : CameraBlock} (h : c.InRange) {ph : Photo} (hH : 0 < ph.h) :
    (∀ p : Vec3, p 1 = 0 → 0 < c.depth p →
      c.photoToFloor ph (c.floorToPhoto ph p).1 (c.floorToPhoto ph p).2 = some p) ∧
    (∀ px py : ℝ, c.photoRay ph px py 1 < 0 →
      ∃ q, c.photoToFloor ph px py = some q ∧ q 1 = 0 ∧ 0 < c.depth q ∧ c.floorToPhoto ph q = (px, py)) :=
  ⟨fun _ hp hd => photoToFloor_floorToPhoto h.height_pos (h.focalPx_pos hH).ne' hp hd,
   fun _ _ hb => floorToPhoto_photoToFloor h.height_pos (h.focalPx_pos hH).ne' hb⟩

end CameraBlock

end Midstudy
