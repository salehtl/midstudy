import Midstudy.Depth

/-!
# Drags on horizontal planes, and Set scale (contract §4.5)

"A drag keeps the grabbed point of the piece under the pointer (it slides on the horizontal plane through that
point)": the planner intersects the ray through the pointer's pixel with the plane `y = y₀` (three.js
`Ray.intersectPlane`, geom `intersect_plane`, engine.js `planePointAt`). "Set scale scales the camera height so [the
ruler] reads that length" (geom `ruler_rescale`).

Main results:
* `photoToPlane_floorToPhoto`, `floorToPhoto_photoToPlane`: the round trips of `Camera.lean` for every horizontal
  plane the camera isn't in: so a point grabbed on its plane comes back from its own pixel, and wherever the pointer
  moves, the point the plane gives is drawn exactly under it (`drag_keeps_point_under_pointer`).
* `setScale_reads_true`: after Set scale (height × true / measured), the ruler between the same two pixels reads the
  true length exactly (before the height clamp).
-/

noncomputable section

open Real Matrix

namespace Midstudy

/-- three.js `Ray.intersectPlane` for the horizontal plane `y = y₀`: the hit at `t ≥ 0` (the origin itself when the
ray lies in the plane), else `none`. -/
def planeHit (origin dir : Vec3) (y0 : ℝ) : Option Vec3 :=
  if dir 1 = 0 then (if origin 1 = y0 then some origin else none)
  else if 0 ≤ -(origin 1 - y0) / dir 1 then some (origin + (-(origin 1 - y0) / dir 1) • dir)
  else none

namespace CameraBlock

variable {c : CameraBlock} {ph : Photo}

variable (c ph) in
/-- engine.js `planePointAt` (without its 60 m pick limit): where the ray through photo pixel `(px, py)` meets the
plane `y = y₀`. -/
def photoToPlane (y0 px py : ℝ) : Option Vec3 := planeHit c.center (c.photoRay ph px py) y0

/-- On the floor plane (`y₀ = 0`) the drag's plane hit is `photoToFloor` exactly (geom props
`floor_plane_hit_is_photo_to_floor`). -/
theorem photoToPlane_zero (hh : 0 < c.height_m) (px py : ℝ) :
    c.photoToPlane ph 0 px py = c.photoToFloor ph px py := by
  unfold photoToPlane photoToFloor planeHit floorHit
  set d := c.photoRay ph px py
  rw [center_one]
  by_cases h0 : d 1 = 0
  · rw [if_pos h0, if_neg hh.ne', if_pos (le_of_eq h0.symm)]
  · rw [if_neg h0]
    by_cases hneg : d 1 < 0
    · have ht : 0 ≤ -(c.height_m - 0) / d 1 := div_nonneg_of_nonpos (by linarith) hneg.le
      rw [if_pos ht, if_neg (not_le.2 hneg)]
      congr 1
      ext i
      fin_cases i <;> simp
      field_simp
      ring
    · have hpos : 0 < d 1 := lt_of_le_of_ne (not_lt.1 hneg) (Ne.symm h0)
      have ht : ¬ 0 ≤ -(c.height_m - 0) / d 1 := by
        rw [not_le]
        exact div_neg_of_neg_of_pos (by linarith) hpos
      rw [if_neg ht, if_pos hpos.le]

/-- **A point grabbed on its plane comes back from its own pixel** (any horizontal plane the camera isn't in). -/
theorem photoToPlane_floorToPhoto (hf : c.focalPx ph ≠ 0) {p : Vec3} {y0 : ℝ} (hp : p 1 = y0)
    (hy0 : y0 ≠ c.height_m) (hd : 0 < c.depth p) :
    c.photoToPlane ph y0 (c.floorToPhoto ph p).1 (c.floorToPhoto ph p).2 = some p := by
  have hd0 : c.depth p ≠ 0 := hd.ne'
  rw [photoToPlane, photoRay_floorToPhoto hf hd0, planeHit]
  have hy : ((c.depth p)⁻¹ • (p - c.center)) 1 = (y0 - c.height_m) / c.depth p := by
    simp [hp]
    ring
  have hy0' : y0 - c.height_m ≠ 0 := sub_ne_zero.2 hy0
  have hne : ((c.depth p)⁻¹ • (p - c.center)) 1 ≠ 0 := by
    rw [hy]
    exact div_ne_zero hy0' hd0
  have ht : -(c.center 1 - y0) / ((c.depth p)⁻¹ • (p - c.center)) 1 = c.depth p := by
    rw [hy, center_one]
    field_simp
    ring
  rw [if_neg hne, ht, if_pos hd.le]
  congr 1
  ext i
  simp only [Pi.add_apply, Pi.smul_apply, Pi.sub_apply, smul_eq_mul]
  field_simp
  ring

/-- **Wherever the pointer is, the plane's point is drawn exactly under it** (when the ray meets the plane away from
the camera). -/
theorem floorToPhoto_photoToPlane (hf : c.focalPx ph ≠ 0) {y0 px py : ℝ} {q : Vec3} (hy0 : y0 ≠ c.height_m)
    (h : c.photoToPlane ph y0 px py = some q) : q 1 = y0 ∧ 0 < c.depth q ∧ c.floorToPhoto ph q = (px, py) := by
  rw [photoToPlane, planeHit] at h
  set dir := c.photoRay ph px py with hdir
  split_ifs at h with h0 h1 h2
  · simp only [Option.some.injEq] at h
    rw [center_one] at h1
    exact absurd h1.symm hy0
  · set t := -(c.center 1 - y0) / dir 1 with ht
    simp only [Option.some.injEq] at h
    subst h
    have htpos : 0 < t := by
      rcases lt_or_eq_of_le h2 with h' | h'
      · exact h'
      · exfalso
        have : -(c.center 1 - y0) = 0 := by
          rw [ht] at h'
          rcases div_eq_zero_iff.1 h'.symm with h'' | h''
          · exact h''
          · exact absurd h'' h0
        rw [center_one] at this
        exact hy0 (by linarith)
    have hcam : c.toCamera (c.center + t • dir) = t • c.camDir ph px py := by
      rw [toCamera, add_sub_cancel_left, hdir, photoRay, Matrix.mulVec_smul, toCamera_R_mulVec]
    have hdepth : c.depth (c.center + t • dir) = t := by
      rw [depth, hcam]
      simp [camDir]
    refine ⟨?_, by rw [hdepth]; exact htpos, ?_⟩
    · simp only [Pi.add_apply, Pi.smul_apply, smul_eq_mul, center_one, ht]
      field_simp
      ring
    · have ht0 : t ≠ 0 := htpos.ne'
      simp only [floorToPhoto, projectPhoto, hdepth, hcam]
      simp [camDir]
      constructor <;> field_simp <;> ring

/-- **A drag keeps the grabbed point under the pointer** (§4.5). The piece was grabbed at `g` (on the plane
`y = g.y`, in front of the camera, the camera not in that plane); the pointer moves to `(px, py)` and the plane gives
`q`; the piece moves by `q − g`, so the grabbed point is now at `q`, drawn at `(px, py)`. -/
theorem drag_keeps_point_under_pointer (hf : c.focalPx ph ≠ 0) {g q : Vec3} {px py : ℝ}
    (hg : g 1 ≠ c.height_m) (h : c.photoToPlane ph (g 1) px py = some q) :
    g + (q - g) = q ∧ q 1 = g 1 ∧ c.floorToPhoto ph (g + (q - g)) = (px, py) := by
  obtain ⟨hq1, -, hpix⟩ := floorToPhoto_photoToPlane hf hg h
  exact ⟨add_sub_cancel _ _, hq1, by rw [add_sub_cancel]; exact hpix⟩

/-! ### The ruler and Set scale -/

/-- The ruler's length between two floor points (geom `ruler_length`, `Math.hypot(Δx, Δz)`). -/
def rulerLength (p q : Vec3) : ℝ := Real.sqrt ((p 0 - q 0) ^ 2 + (p 2 - q 2) ^ 2)

theorem rulerLength_smul {k : ℝ} (hk : 0 ≤ k) (p q : Vec3) : rulerLength (k • p) (k • q) = k * rulerLength p q := by
  unfold rulerLength
  simp only [Pi.smul_apply, smul_eq_mul]
  rw [show (k * p 0 - k * q 0) ^ 2 + (k * p 2 - k * q 2) ^ 2 = k ^ 2 * ((p 0 - q 0) ^ 2 + (p 2 - q 2) ^ 2) by ring,
    Real.sqrt_mul (by positivity), Real.sqrt_sq hk]

/-- **Set scale makes the ruler read the true length** (§4.5, before the height clamp): the ruler measured
`measured` between the floor points of two pixels; with the camera height times `true / measured`, the floor points
of the same two pixels are exactly `true` apart. -/
theorem setScale_reads_true {px₁ py₁ px₂ py₂ : ℝ} {p₁ p₂ : Vec3} (h₁ : c.photoToFloor ph px₁ py₁ = some p₁)
    (h₂ : c.photoToFloor ph px₂ py₂ = some p₂) {measured true_m : ℝ} (hm : rulerLength p₁ p₂ = measured)
    (hmeas : 0 < measured) (htrue : 0 ≤ true_m) :
    ∃ q₁ q₂, (c.withHeight (true_m / measured * c.height_m)).photoToFloor ph px₁ py₁ = some q₁ ∧
      (c.withHeight (true_m / measured * c.height_m)).photoToFloor ph px₂ py₂ = some q₂ ∧
      rulerLength q₁ q₂ = true_m := by
  refine ⟨(true_m / measured) • p₁, (true_m / measured) • p₂, ?_, ?_, ?_⟩
  · rw [photoToFloor_withHeight, h₁]
    rfl
  · rw [photoToFloor_withHeight, h₂]
    rfl
  · rw [rulerLength_smul (div_nonneg htrue hmeas.le), hm]
    field_simp

end CameraBlock

end Midstudy
