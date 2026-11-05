import Midstudy.Camera

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

end CameraBlock

end Midstudy
