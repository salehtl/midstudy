import Midstudy.Camera
import Mathlib.Analysis.SpecialFunctions.Trigonometric.Arctan
import Mathlib.Analysis.SpecialFunctions.Trigonometric.ArctanDeriv
import Mathlib.Analysis.Calculus.MeanValue

/-!
# The horizon (contract §4.1 "Signs")

The horizon is where the floor plane vanishes: the pixels whose ray is horizontal. engine.js `horizonAt(px)` gives
its row at photo column `px`, from `sin(roll)·x_c + cos(roll)·y_c = −tan(pitch)`.

Main results:
* `photoRay_one_eq`: the ray's world y component is `cos(pitch)·cos(roll)/f · (horizonAt px − py)`, so for a camera
  in range a pixel's ray points down exactly when the pixel is below `horizonAt` (`photoRay_one_neg_iff`), and is
  horizontal exactly on it (`photoRay_one_eq_zero_iff`): "strictly below the horizon" in `Camera.lean` is the
  image-space statement.
* `horizonAt_of_roll_zero`: with roll 0 the horizon is the row `py = H/2 − f·tan(−pitch)`.
* `horizonAt_lt_half`: negative pitch (looking down) puts it above the centre.
* `horizonAt_strictMono`: positive roll makes its right end lower (rows grow downwards); `camR_right_up`: positive
  roll turns the camera counterclockwise as seen from behind it.
-/

noncomputable section

open Real Matrix

namespace Midstudy

/-- Positive roll turns the camera counterclockwise as seen from behind it: its right and up axes are the x and y
axes turned by `b` in the x-y plane (seen from +Z, x to the right and y up). -/
theorem camR_right_up (b : ℝ) :
    camR 0 b *ᵥ ![1, 0, 0] = ![cos b, sin b, 0] ∧ camR 0 b *ᵥ ![0, 1, 0] = ![-sin b, cos b, 0] := by
  constructor <;> ext i <;> fin_cases i <;> simp [camR_eq, Matrix.mulVec, dotProduct, Fin.sum_univ_three]

namespace CameraBlock

variable (c : CameraBlock) (ph : Photo)

/-- The horizon's row at photo column `px` (engine.js `horizonAt`). -/
def horizonAt (px : ℝ) : ℝ :=
  ph.h / 2 - (-tan (rad c.pitch_deg) - sin (rad c.roll_deg) * ((px - ph.w / 2) / c.focalPx ph))
    / cos (rad c.roll_deg) * c.focalPx ph

/-- The ray's world y component, multiplied out. -/
theorem photoRay_one (px py : ℝ) :
    c.photoRay ph px py 1 =
      cos (rad c.pitch_deg) * (sin (rad c.roll_deg) * ((px - ph.w / 2) / c.focalPx ph)
        + cos (rad c.roll_deg) * (-(py - ph.h / 2) / c.focalPx ph)) + sin (rad c.pitch_deg) := by
  simp [photoRay, R, camR_eq, camDir, Matrix.mulVec, dotProduct, Fin.sum_univ_three]
  ring

/-- The ray's world y component is a positive multiple of the pixel's height above the horizon line. -/
theorem photoRay_one_eq (hf : c.focalPx ph ≠ 0) (hp : cos (rad c.pitch_deg) ≠ 0) (hr : cos (rad c.roll_deg) ≠ 0)
    (px py : ℝ) :
    c.photoRay ph px py 1 =
      cos (rad c.pitch_deg) * cos (rad c.roll_deg) / c.focalPx ph * (c.horizonAt ph px - py) := by
  rw [photoRay_one, horizonAt, Real.tan_eq_sin_div_cos]
  field_simp
  ring

variable {c ph}

/-- For a camera in range, a pixel's ray points down exactly when the pixel is strictly below the horizon line. -/
theorem photoRay_one_neg_iff (hc : c.InRange) (hH : 0 < ph.h) (px py : ℝ) :
    c.photoRay ph px py 1 < 0 ↔ c.horizonAt ph px < py := by
  have hf := hc.focalPx_pos hH
  have hk : 0 < cos (rad c.pitch_deg) * cos (rad c.roll_deg) / c.focalPx ph :=
    div_pos (mul_pos hc.cos_pitch_pos hc.cos_roll_pos) hf
  rw [photoRay_one_eq c ph hf.ne' hc.cos_pitch_pos.ne' hc.cos_roll_pos.ne', mul_neg_iff]
  constructor
  · rintro (⟨-, h⟩ | ⟨h, -⟩)
    · linarith
    · linarith
  · intro h
    exact Or.inl ⟨hk, by linarith⟩

/-- The ray's world y component strictly decreases down the photo (geom LEAN.md property 6). -/
theorem photoRay_one_strictAnti (hc : c.InRange) (hH : 0 < ph.h) (px : ℝ) :
    StrictAnti (fun py => c.photoRay ph px py 1) := by
  have hf := hc.focalPx_pos hH
  have hk : 0 < cos (rad c.pitch_deg) * cos (rad c.roll_deg) / c.focalPx ph :=
    div_pos (mul_pos hc.cos_pitch_pos hc.cos_roll_pos) hf
  intro a b hab
  simp only [photoRay_one_eq c ph hf.ne' hc.cos_pitch_pos.ne' hc.cos_roll_pos.ne']
  nlinarith

/-- For a camera in range, a pixel's ray is horizontal exactly on the horizon line. -/
theorem photoRay_one_eq_zero_iff (hc : c.InRange) (hH : 0 < ph.h) (px py : ℝ) :
    c.photoRay ph px py 1 = 0 ↔ py = c.horizonAt ph px := by
  have hf := hc.focalPx_pos hH
  have hk : cos (rad c.pitch_deg) * cos (rad c.roll_deg) / c.focalPx ph ≠ 0 :=
    (div_pos (mul_pos hc.cos_pitch_pos hc.cos_roll_pos) hf).ne'
  rw [photoRay_one_eq c ph hf.ne' hc.cos_pitch_pos.ne' hc.cos_roll_pos.ne', mul_eq_zero, sub_eq_zero]
  constructor
  · rintro (h | h)
    · exact absurd h hk
    · exact h.symm
  · intro h
    exact Or.inr h.symm

/-- **With roll 0 the horizon is the row `py = H/2 − f·tan(−pitch)`**, at every column. -/
theorem horizonAt_of_roll_zero (hroll : c.roll_deg = 0) (px : ℝ) :
    c.horizonAt ph px = ph.h / 2 - c.focalPx ph * tan (-rad c.pitch_deg) := by
  simp [horizonAt, hroll, rad, Real.tan_neg]
  ring

/-- **Negative pitch (looking down) puts the horizon above the centre**, with roll 0 (rows grow downwards). -/
theorem horizonAt_lt_half (hroll : c.roll_deg = 0) (hf : 0 < c.focalPx ph) (h1 : -90 < c.pitch_deg)
    (h2 : c.pitch_deg < 0) (px : ℝ) : c.horizonAt ph px < ph.h / 2 := by
  rw [horizonAt_of_roll_zero hroll, Real.tan_neg]
  have ht : tan (rad c.pitch_deg) < 0 := by
    apply Real.tan_neg_of_neg_of_pi_div_two_lt
    · unfold rad
      have := Real.pi_pos
      nlinarith
    · exact neg_pi_div_two_lt_rad h1
  nlinarith

/-- The horizon is a straight line with slope `tan(roll)` in photo pixels. -/
theorem horizonAt_eq_line (hf : c.focalPx ph ≠ 0) (hr : cos (rad c.roll_deg) ≠ 0) (px : ℝ) :
    c.horizonAt ph px = ph.h / 2 + c.focalPx ph * tan (rad c.pitch_deg) / cos (rad c.roll_deg)
      + tan (rad c.roll_deg) * (px - ph.w / 2) := by
  rw [horizonAt, Real.tan_eq_sin_div_cos (rad c.roll_deg)]
  field_simp
  ring

/-- **Positive roll makes the horizon's right end lower**: its row grows from left to right (rows grow downwards). -/
theorem horizonAt_strictMono (hf : 0 < c.focalPx ph) (h0 : 0 < c.roll_deg) (h1 : c.roll_deg < 90) :
    StrictMono (c.horizonAt ph) := by
  have hb0 : 0 < rad c.roll_deg := by
    unfold rad
    have := Real.pi_pos
    positivity
  have hcos : 0 < cos (rad c.roll_deg) :=
    Real.cos_pos_of_mem_Ioo ⟨by linarith [Real.pi_pos], rad_lt_pi_div_two h1⟩
  have htan : 0 < tan (rad c.roll_deg) := Real.tan_pos_of_pos_of_lt_pi_div_two hb0 (rad_lt_pi_div_two h1)
  intro x y hxy
  rw [horizonAt_eq_line hf.ne' hcos.ne', horizonAt_eq_line hf.ne' hcos.ne']
  nlinarith

/-- Negative roll makes the horizon's right end higher. -/
theorem horizonAt_strictAnti (hf : 0 < c.focalPx ph) (h0 : c.roll_deg < 0) (h1 : -90 < c.roll_deg) :
    StrictAnti (c.horizonAt ph) := by
  have hb0 : rad c.roll_deg < 0 := by
    unfold rad
    have := Real.pi_pos
    nlinarith
  have hcos : 0 < cos (rad c.roll_deg) :=
    Real.cos_pos_of_mem_Ioo ⟨neg_pi_div_two_lt_rad h1, by linarith [Real.pi_pos]⟩
  have htan : tan (rad c.roll_deg) < 0 :=
    Real.tan_neg_of_neg_of_pi_div_two_lt hb0 (neg_pi_div_two_lt_rad h1)
  intro x y hxy
  rw [horizonAt_eq_line hf.ne' hcos.ne', horizonAt_eq_line hf.ne' hcos.ne']
  nlinarith

/-! ### Dragging the horizon sets the pitch (engine.js `setPitchFromHorizon`) -/

variable (c ph) in
/-- The pitch (degrees) that puts the horizon's middle (the photo's centre column) at row `py`:
`−atan(cos(roll) · y_c) / DEG` with `y_c = −(py − H/2)/f` (engine.js `setPitchFromHorizon`, before `setCamera`
clamps it; geom `pitch_from_horizon`). -/
def pitchFromHorizon (py : ℝ) : ℝ :=
  -Real.arctan (cos (rad c.roll_deg) * (-(py - ph.h / 2) / c.focalPx ph)) / (π / 180)

/-- The camera block with another pitch. -/
def withPitch (c : CameraBlock) (p : ℝ) : CameraBlock := { c with pitch_deg := p }

@[simp] theorem withPitch_focalPx (c : CameraBlock) (p : ℝ) : (c.withPitch p).focalPx ph = c.focalPx ph := rfl
@[simp] theorem withPitch_pitch (c : CameraBlock) (p : ℝ) : (c.withPitch p).pitch_deg = p := rfl
@[simp] theorem withPitch_roll (c : CameraBlock) (p : ℝ) : (c.withPitch p).roll_deg = c.roll_deg := rfl

theorem rad_div (x : ℝ) : rad (x / (π / 180)) = x := by
  unfold rad
  have := Real.pi_pos
  field_simp

/-- **The dragged horizon lands where it is dropped**: after setting the pitch from row `py`, the horizon's middle is
at row `py`. -/
theorem horizonAt_withPitch_pitchFromHorizon (hf : c.focalPx ph ≠ 0) (hr : cos (rad c.roll_deg) ≠ 0) (py : ℝ) :
    (c.withPitch (c.pitchFromHorizon ph py)).horizonAt ph (ph.w / 2) = py := by
  rw [horizonAt, withPitch_focalPx, withPitch_pitch, withPitch_roll, pitchFromHorizon, rad_div, Real.tan_neg,
    Real.tan_arctan]
  field_simp
  ring

/-- And reading the pitch back from the horizon's middle gives the pitch, for any pitch strictly between ±90°. -/
theorem pitchFromHorizon_horizonAt (hf : c.focalPx ph ≠ 0) (hr : cos (rad c.roll_deg) ≠ 0)
    (h1 : -90 < c.pitch_deg) (h2 : c.pitch_deg < 90) :
    c.pitchFromHorizon ph (c.horizonAt ph (ph.w / 2)) = c.pitch_deg := by
  have hy : cos (rad c.roll_deg) * (-(c.horizonAt ph (ph.w / 2) - ph.h / 2) / c.focalPx ph) =
      -tan (rad c.pitch_deg) := by
    simp only [horizonAt]
    field_simp
    ring
  unfold pitchFromHorizon
  rw [hy, Real.arctan_neg, neg_neg, Real.arctan_tan (neg_pi_div_two_lt_rad h1) (rad_lt_pi_div_two h2)]
  unfold rad
  have := Real.pi_pos
  field_simp

/-! ### The horizon drag is capped (contract §4.5, geom LEAN.md property 10) -/

theorem arctan_lipschitz : LipschitzWith 1 Real.arctan := by
  apply lipschitzWith_of_nnnorm_deriv_le Real.differentiable_arctan
  intro x
  rw [Real.deriv_arctan, ← NNReal.coe_le_coe, coe_nnnorm, Real.norm_eq_abs, NNReal.coe_one]
  have h : 0 < 1 + x ^ 2 := by positivity
  rw [abs_of_pos (by positivity), div_le_one h]
  nlinarith [sq_nonneg x]

theorem abs_arctan_sub_le (x y : ℝ) : |Real.arctan x - Real.arctan y| ≤ |x - y| := by
  have := arctan_lipschitz.dist_le_mul x y
  simpa [Real.dist_eq] using this

/-- The pitch the horizon sets moves by at most one focal length's worth of degrees per photo pixel. -/
theorem pitchFromHorizon_lipschitz (hf : 0 < c.focalPx ph) (hr : 0 < cos (rad c.roll_deg)) (a b : ℝ) :
    |c.pitchFromHorizon ph a - c.pitchFromHorizon ph b| ≤ |a - b| / (c.focalPx ph * (π / 180)) := by
  have hpi := Real.pi_pos
  have hcr : cos (rad c.roll_deg) ≤ 1 := Real.cos_le_one _
  unfold pitchFromHorizon
  rw [show -Real.arctan (cos (rad c.roll_deg) * (-(a - ph.h / 2) / c.focalPx ph)) / (π / 180) -
      -Real.arctan (cos (rad c.roll_deg) * (-(b - ph.h / 2) / c.focalPx ph)) / (π / 180) =
      (Real.arctan (cos (rad c.roll_deg) * (-(b - ph.h / 2) / c.focalPx ph)) -
        Real.arctan (cos (rad c.roll_deg) * (-(a - ph.h / 2) / c.focalPx ph))) / (π / 180) by ring,
    abs_div, abs_of_pos (by positivity : (0 : ℝ) < π / 180)]
  have h1 := abs_arctan_sub_le (cos (rad c.roll_deg) * (-(b - ph.h / 2) / c.focalPx ph))
    (cos (rad c.roll_deg) * (-(a - ph.h / 2) / c.focalPx ph))
  have h2 : |cos (rad c.roll_deg) * (-(b - ph.h / 2) / c.focalPx ph) -
      cos (rad c.roll_deg) * (-(a - ph.h / 2) / c.focalPx ph)| ≤ |a - b| / c.focalPx ph := by
    rw [show cos (rad c.roll_deg) * (-(b - ph.h / 2) / c.focalPx ph) -
        cos (rad c.roll_deg) * (-(a - ph.h / 2) / c.focalPx ph) = cos (rad c.roll_deg) * ((a - b) / c.focalPx ph) by
        field_simp; ring, abs_mul, abs_of_pos hr, abs_div, abs_of_pos hf]
    calc cos (rad c.roll_deg) * (|a - b| / c.focalPx ph) ≤ 1 * (|a - b| / c.focalPx ph) :=
          mul_le_mul_of_nonneg_right hcr (by positivity)
      _ = |a - b| / c.focalPx ph := one_mul _
  rw [div_le_div_iff₀ (by positivity) (by positivity)]
  calc |Real.arctan (cos (rad c.roll_deg) * (-(b - ph.h / 2) / c.focalPx ph)) -
        Real.arctan (cos (rad c.roll_deg) * (-(a - ph.h / 2) / c.focalPx ph))| * (c.focalPx ph * (π / 180))
      ≤ |a - b| / c.focalPx ph * (c.focalPx ph * (π / 180)) :=
        mul_le_mul_of_nonneg_right (h1.trans h2) (by positivity)
    _ = |a - b| * (π / 180) := by field_simp

/-- workspace.js's horizon drag: degrees per CSS pixel, `(360/π) · tan(fov/2) / rect_h`. -/
def degPerCssPx (c : CameraBlock) (rectH : ℝ) : ℝ := (360 / π) * tan (rad c.fov_y_deg / 2) / rectH

/-- **The horizon drag tilts at most `min(degPerCssPx, 0.12)` degrees per CSS pixel** (§4.5: "at most 0.12° of tilt
per CSS pixel on a small photo"): the drag asks for row `py₀ + (Δy / s) · gain` with
`gain = min(1, 0.12 / degPerCssPx)`, the photo shown `s` CSS px per photo px (`rect_h = s · H`). -/
theorem horizon_drag_cap (hH : 0 < ph.h) (hfov : 0 < c.fov_y_deg) (hfov' : c.fov_y_deg < 180)
    (hr : 0 < cos (rad c.roll_deg)) {s : ℝ} (hs : 0 < s) (py0 dy : ℝ) :
    |c.pitchFromHorizon ph (py0 + dy / s * min 1 (0.12 / c.degPerCssPx (s * ph.h))) - c.pitchFromHorizon ph py0| ≤
      min (c.degPerCssPx (s * ph.h)) 0.12 * |dy| := by
  have hpi := Real.pi_pos
  have hf := focalPx_pos (c := c) hH hfov hfov'
  have ht : 0 < tan (rad c.fov_y_deg / 2) := by
    have : 0 < c.focalPx ph := hf
    unfold focalPx at this
    have h2 : 0 < ph.h / 2 := by linarith
    exact (div_pos_iff_of_pos_left h2).1 this
  have hk : 0 < c.degPerCssPx (s * ph.h) := by unfold degPerCssPx; positivity
  have hkey : 1 / (s * c.focalPx ph * (π / 180)) = c.degPerCssPx (s * ph.h) := by
    unfold degPerCssPx focalPx
    field_simp
    ring
  have hg : 0 ≤ min 1 (0.12 / c.degPerCssPx (s * ph.h)) := le_min (by norm_num) (by positivity)
  have hgk : min 1 (0.12 / c.degPerCssPx (s * ph.h)) * c.degPerCssPx (s * ph.h) =
      min (c.degPerCssPx (s * ph.h)) 0.12 := by
    rw [min_mul_of_nonneg _ _ hk.le, one_mul, div_mul_cancel₀ _ hk.ne']
  calc _ ≤ |py0 + dy / s * min 1 (0.12 / c.degPerCssPx (s * ph.h)) - py0| / (c.focalPx ph * (π / 180)) :=
        pitchFromHorizon_lipschitz hf hr _ _
    _ = |dy| * min 1 (0.12 / c.degPerCssPx (s * ph.h)) * (1 / (s * c.focalPx ph * (π / 180))) := by
        rw [add_sub_cancel_left, abs_mul, abs_div, abs_of_pos hs, abs_of_nonneg hg]
        field_simp
    _ = min (c.degPerCssPx (s * ph.h)) 0.12 * |dy| := by
        rw [hkey, mul_assoc, hgk, mul_comm]

end CameraBlock

end Midstudy
