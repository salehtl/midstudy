import Midstudy.Camera

/-!
# Depth along the view axis, and changing the camera height (contract §4.1, §4.5)

`d = −p_c.z` is the distance along the view axis, not the Euclidean distance: `depth_eq_dot_forward` shows it is
`(p − C) · forward` with `forward = R · (0, 0, −1)` a unit vector (`forward_dot_self`), so `d > 0` exactly in the
open half-space in front of the camera.

Changing only `height_m` (Adjust floor's height slider, or Set scale) is a change of scale of the whole scene:
* `photoToFloor_withHeight`: scaling the height by `k > 0` scales every floor point by `k`;
* `depth_withHeight_smul`, `floorToPhoto_withHeight_smul`: the scaled point `k · p` has `k` times the depth and the
  same pixel;
* `occlusion_rescale`: so §4.5's rule (depth.png, metric in the calibration's frame, is multiplied by
  `height_m / calib height_m`) gives exactly the depth the current camera sees at every pixel, and
  `depth_withHeight_smul_lt_iff` keeps every comparison between depths.
The rule is exact for a height change only: a change of field of view, pitch or roll moves pixels.
-/

noncomputable section

open Real Matrix

namespace Midstudy

namespace CameraBlock

variable (c : CameraBlock) (ph : Photo)

/-- The camera's viewing direction in the world, `R · (0, 0, −1)`. -/
def forward : Vec3 := c.R *ᵥ ![0, 0, -1]

/-- The viewing direction depends on the pitch only (roll turns the camera about it). -/
theorem forward_eq : c.forward = ![0, sin (rad c.pitch_deg), -cos (rad c.pitch_deg)] := by
  ext i
  fin_cases i <;> simp [forward, R, camR_eq, Matrix.mulVec, dotProduct, Fin.sum_univ_three]

theorem forward_dot_self : c.forward ⬝ᵥ c.forward = 1 := by
  rw [forward_eq]
  simp [dotProduct, Fin.sum_univ_three]
  linear_combination sin_sq_add_cos_sq (rad c.pitch_deg)

/-- **Depth is the distance along the view axis**: `d = (p − C) · forward`. -/
theorem depth_eq_dot_forward (p : Vec3) : c.depth p = (p - c.center) ⬝ᵥ c.forward := by
  simp [depth, toCamera, forward, R, camR_eq, Matrix.mulVec, dotProduct, Fin.sum_univ_three, Matrix.transpose_apply]
  ring

/-- The camera block with another `height_m`, everything else kept. -/
def withHeight (h : ℝ) : CameraBlock := { c with height_m := h }

@[simp] theorem withHeight_R (h : ℝ) : (c.withHeight h).R = c.R := rfl
@[simp] theorem withHeight_focalPx (h : ℝ) : (c.withHeight h).focalPx ph = c.focalPx ph := rfl
@[simp] theorem withHeight_height (h : ℝ) : (c.withHeight h).height_m = h := rfl

/-- The rays through the pixels don't depend on the camera height. -/
@[simp] theorem withHeight_photoRay (h : ℝ) : (c.withHeight h).photoRay ph = c.photoRay ph := rfl

theorem withHeight_center_smul (k : ℝ) : (c.withHeight (k * c.height_m)).center = k • c.center := by
  ext i
  fin_cases i <;> simp [center, withHeight]

theorem toCamera_withHeight_smul (k : ℝ) (p : Vec3) :
    (c.withHeight (k * c.height_m)).toCamera (k • p) = k • c.toCamera p := by
  rw [toCamera, withHeight_center_smul, ← smul_sub, Matrix.mulVec_smul]
  rfl

/-- **Depth scales with the height**: the scaled point `k · p` seen from the camera at `k · height_m` has `k` times
the depth. -/
theorem depth_withHeight_smul (k : ℝ) (p : Vec3) :
    (c.withHeight (k * c.height_m)).depth (k • p) = k * c.depth p := by
  simp [depth, toCamera_withHeight_smul]

/-- The scaled point has the same pixel. -/
theorem floorToPhoto_withHeight_smul {k : ℝ} (hk : k ≠ 0) (p : Vec3) :
    (c.withHeight (k * c.height_m)).floorToPhoto ph (k • p) = c.floorToPhoto ph p := by
  simp only [floorToPhoto, projectPhoto, depth_withHeight_smul, toCamera_withHeight_smul, withHeight_focalPx]
  simp only [Pi.smul_apply, smul_eq_mul]
  congr 1
  · rw [mul_left_comm, mul_div_mul_left _ _ hk]
  · rw [mul_left_comm, mul_div_mul_left _ _ hk]

/-- **Floor points scale with the height**: at every pixel, the camera at `k · height_m` finds `k` times the floor
point (and no floor point exactly where the original camera finds none). -/
theorem photoToFloor_withHeight (k px py : ℝ) :
    (c.withHeight (k * c.height_m)).photoToFloor ph px py = (c.photoToFloor ph px py).map (k • ·) := by
  unfold photoToFloor floorHit
  rw [withHeight_photoRay]
  by_cases h : 0 ≤ c.photoRay ph px py 1
  · simp [h]
  · simp only [if_neg h, Option.map_some]
    congr 1
    ext i
    fin_cases i <;> simp [center, withHeight] <;> ring

/-- **§4.5's occlusion rescale is exact for a height change.** Let the calibration's camera `c` (height
`h₀ = c.height_m > 0`) see a real thing at `q`. After Adjust floor sets the height to `h₁` (nothing else changed),
the same photo shows the scene scaled by `h₁ / h₀`: the thing is at `(h₁/h₀) · q`, at the same pixel, and its depth
is depth.png's value times `h₁ / h₀`, the factor the planner applies. -/
theorem occlusion_rescale (hh : 0 < c.height_m) (h₁ : ℝ) (hh₁ : 0 < h₁) (q : Vec3) :
    (c.withHeight h₁).floorToPhoto ph ((h₁ / c.height_m) • q) = c.floorToPhoto ph q ∧
    (c.withHeight h₁).depth ((h₁ / c.height_m) • q) = (h₁ / c.height_m) * c.depth q := by
  have hk : h₁ / c.height_m * c.height_m = h₁ := div_mul_cancel₀ h₁ hh.ne'
  have e := c.floorToPhoto_withHeight_smul ph (div_pos hh₁ hh).ne' q
  have d := c.depth_withHeight_smul (h₁ / c.height_m) q
  rw [hk] at e d
  exact ⟨e, d⟩

/-- Rescaling keeps every comparison between depths (which of two things is nearer). -/
theorem depth_withHeight_smul_lt_iff {k : ℝ} (hk : 0 < k) (p q : Vec3) :
    (c.withHeight (k * c.height_m)).depth (k • p) < (c.withHeight (k * c.height_m)).depth (k • q) ↔
      c.depth p < c.depth q := by
  rw [depth_withHeight_smul, depth_withHeight_smul]
  exact mul_lt_mul_iff_right₀ hk

end CameraBlock

end Midstudy
