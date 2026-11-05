import Midstudy.Rotation
import Midstudy.Lighting
import Mathlib.Analysis.SpecialFunctions.Pow.Real

/-!
# Turning the whole light (contract §4.8)

"With lighting.json, a light direction away from the inferred one turns the whole light: the ambient SH is rotated with
the key, by the shortest rotation from the inferred key direction to the new one". The planner builds that rotation
with three.js (planner/lighting.js `turnBetween`; geom `turn_between`): `Quaternion.setFromUnitVectors(a, b)`, i.e. the
quaternion `(a × b, 1 + a·b)` normalised, then `Matrix4.makeRotationFromQuaternion`. Modelled here exactly (directions
that aren't opposite: `a·b > −1`).

Main results:
* `quatMat_mem_SO3`: three.js's matrix of a unit quaternion is a rotation (orthogonal, determinant 1);
* `turnBetween_mem_SO3`: so the turn is a rotation, and the SH results of `Lighting.lean` apply to it;
* `turnBetween_apply`: **it takes the inferred key direction exactly to the new one**;
* `turnBetween_axis`: it keeps the axis `a × b` (perpendicular to both): the turn is about that axis;
* `turnBetween_self`: at the inferred direction it is the identity, so the light is exactly lighting.json's;
* `turned_light`: **the whole light turns together**: the key goes from the inferred direction to the new one, and
  the turned probe seen from any turned direction is the original probe seen from the original direction.
-/

noncomputable section

open Real Matrix

namespace Midstudy

/-- three.js `Matrix4.makeRotationFromQuaternion` (its 3 × 3 part) of the quaternion `(x, y, z, w)`. -/
def quatMat (x y z w : ℝ) : Mat3 :=
  !![1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y);
     2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x);
     2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]

/-- **Three.js's matrix of a unit quaternion is a rotation.** -/
theorem quatMat_mem_SO3 {x y z w : ℝ} (hn : x * x + y * y + z * z + w * w = 1) :
    quatMat x y z w ∈ specialOrthogonalGroup (Fin 3) ℝ := by
  refine mem_specialOrthogonalGroup_iff.2 ⟨(mem_orthogonalGroup_iff _ _).2 ?_, ?_⟩
  · ext i j
    fin_cases i <;> fin_cases j <;> simp [quatMat, Matrix.mul_apply, Fin.sum_univ_three]
    · linear_combination (4 * (y * y + z * z)) * hn
    · linear_combination (-4 * x * y) * hn
    · linear_combination (-4 * x * z) * hn
    · linear_combination (-4 * x * y) * hn
    · linear_combination (4 * (x * x + z * z)) * hn
    · linear_combination (-4 * y * z) * hn
    · linear_combination (-4 * x * z) * hn
    · linear_combination (-4 * y * z) * hn
    · linear_combination (4 * (x * x + y * y)) * hn
  · simp [quatMat, Matrix.det_fin_three]
    linear_combination (4 * (x * x + y * y + z * z)) * hn

/-- `Quaternion.setFromUnitVectors(a, b)` (for `a·b > −1`) before `normalize()`: `(a × b, 1 + a·b)`. -/
def turnQuatRaw (a b : Vec3) : Fin 4 → ℝ :=
  ![a 1 * b 2 - a 2 * b 1, a 2 * b 0 - a 0 * b 2, a 0 * b 1 - a 1 * b 0, a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1]

/-- Its squared length. -/
def turnNorm2 (a b : Vec3) : ℝ :=
  turnQuatRaw a b 0 * turnQuatRaw a b 0 + turnQuatRaw a b 1 * turnQuatRaw a b 1 +
    turnQuatRaw a b 2 * turnQuatRaw a b 2 + turnQuatRaw a b 3 * turnQuatRaw a b 3

/-- planner/lighting.js `turnBetween(a, b)`: the matrix of the normalised quaternion. -/
def turnBetween (a b : Vec3) : Mat3 :=
  let l := Real.sqrt (turnNorm2 a b)
  quatMat (turnQuatRaw a b 0 / l) (turnQuatRaw a b 1 / l) (turnQuatRaw a b 2 / l) (turnQuatRaw a b 3 / l)

/-- Unit vectors (componentwise, as the planner's `normalize()` makes them). -/
def IsUnit3 (a : Vec3) : Prop := a 0 * a 0 + a 1 * a 1 + a 2 * a 2 = 1

theorem turnNorm2_pos {a b : Vec3} (hab : 0 < a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1) : 0 < turnNorm2 a b := by
  unfold turnNorm2
  have : turnQuatRaw a b 3 = a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1 := rfl
  rw [this]
  nlinarith [mul_self_nonneg (turnQuatRaw a b 0), mul_self_nonneg (turnQuatRaw a b 1),
    mul_self_nonneg (turnQuatRaw a b 2), mul_pos hab hab]

/-- The normalised quaternion is a unit quaternion. -/
theorem turnQuat_unit {a b : Vec3} (hab : 0 < a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1) :
    (turnQuatRaw a b 0 / Real.sqrt (turnNorm2 a b)) * (turnQuatRaw a b 0 / Real.sqrt (turnNorm2 a b)) +
      (turnQuatRaw a b 1 / Real.sqrt (turnNorm2 a b)) * (turnQuatRaw a b 1 / Real.sqrt (turnNorm2 a b)) +
      (turnQuatRaw a b 2 / Real.sqrt (turnNorm2 a b)) * (turnQuatRaw a b 2 / Real.sqrt (turnNorm2 a b)) +
      (turnQuatRaw a b 3 / Real.sqrt (turnNorm2 a b)) * (turnQuatRaw a b 3 / Real.sqrt (turnNorm2 a b)) = 1 := by
  have hs := turnNorm2_pos hab
  have hl : Real.sqrt (turnNorm2 a b) * Real.sqrt (turnNorm2 a b) = turnNorm2 a b := Real.mul_self_sqrt hs.le
  have hl0 : Real.sqrt (turnNorm2 a b) ≠ 0 := (Real.sqrt_pos.2 hs).ne'
  field_simp
  rw [Real.sq_sqrt hs.le]
  unfold turnNorm2
  ring

/-- **The turn is a rotation** (for directions that aren't opposite). -/
theorem turnBetween_mem_SO3 {a b : Vec3} (hab : 0 < a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1) :
    turnBetween a b ∈ specialOrthogonalGroup (Fin 3) ℝ :=
  quatMat_mem_SO3 (turnQuat_unit hab)

/-- The turn, multiplied out by `s = |q|²`: each row is a polynomial in `a`, `b` and `v`. -/
theorem turnBetween_mulVec_mul (a b v : Vec3) (hab : 0 < a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1) :
    let x := turnQuatRaw a b 0
    let y := turnQuatRaw a b 1
    let z := turnQuatRaw a b 2
    let w := turnQuatRaw a b 3
    let s := turnNorm2 a b
    s * (turnBetween a b *ᵥ v) 0 = (s - 2 * (y * y + z * z)) * v 0 + 2 * (x * y - w * z) * v 1 +
        2 * (x * z + w * y) * v 2 ∧
    s * (turnBetween a b *ᵥ v) 1 = 2 * (x * y + w * z) * v 0 + (s - 2 * (x * x + z * z)) * v 1 +
        2 * (y * z - w * x) * v 2 ∧
    s * (turnBetween a b *ᵥ v) 2 = 2 * (x * z - w * y) * v 0 + 2 * (y * z + w * x) * v 1 +
        (s - 2 * (x * x + y * y)) * v 2 := by
  intro x y z w s
  have hs := turnNorm2_pos hab
  have hl : Real.sqrt (turnNorm2 a b) ^ 2 = turnNorm2 a b := Real.sq_sqrt hs.le
  have hl0 : Real.sqrt (turnNorm2 a b) ≠ 0 := (Real.sqrt_pos.2 hs).ne'
  refine ⟨?_, ?_, ?_⟩ <;>
  · simp only [turnBetween, quatMat, Matrix.mulVec, dotProduct, Fin.sum_univ_three, Matrix.of_apply,
      Matrix.cons_val, x, y, z, w, s]
    field_simp
    rw [hl]
    ring

/-- **The turn takes the inferred key direction exactly to the new one.** -/
theorem turnBetween_apply {a b : Vec3} (ha : IsUnit3 a) (hb : IsUnit3 b)
    (hab : 0 < a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1) : turnBetween a b *ᵥ a = b := by
  have hs := turnNorm2_pos hab
  obtain ⟨h0, h1, h2⟩ := turnBetween_mulVec_mul a b a hab
  unfold IsUnit3 at ha hb
  ext i
  apply mul_left_cancel₀ hs.ne'
  fin_cases i
  · show turnNorm2 a b * (turnBetween a b *ᵥ a) 0 = turnNorm2 a b * b 0
    rw [h0]
    simp only [turnNorm2, turnQuatRaw, Matrix.cons_val]
    linear_combination
      (-(b 0 * b 0 + b 1 * b 1 + b 2 * b 2) * (a 0 + b 0) + 2 * (1 + (a 0 * b 0 + a 1 * b 1 + a 2 * b 2)) * b 0) * ha
        + (-(a 0 + b 0)) * hb
  · show turnNorm2 a b * (turnBetween a b *ᵥ a) 1 = turnNorm2 a b * b 1
    rw [h1]
    simp only [turnNorm2, turnQuatRaw, Matrix.cons_val]
    linear_combination
      (-(b 0 * b 0 + b 1 * b 1 + b 2 * b 2) * (a 1 + b 1) + 2 * (1 + (a 0 * b 0 + a 1 * b 1 + a 2 * b 2)) * b 1) * ha
        + (-(a 1 + b 1)) * hb
  · show turnNorm2 a b * (turnBetween a b *ᵥ a) 2 = turnNorm2 a b * b 2
    rw [h2]
    simp only [turnNorm2, turnQuatRaw, Matrix.cons_val]
    linear_combination
      (-(b 0 * b 0 + b 1 * b 1 + b 2 * b 2) * (a 2 + b 2) + 2 * (1 + (a 0 * b 0 + a 1 * b 1 + a 2 * b 2)) * b 2) * ha
        + (-(a 2 + b 2)) * hb

/-- The cross product `a × b`. -/
def cross (a b : Vec3) : Vec3 := ![a 1 * b 2 - a 2 * b 1, a 2 * b 0 - a 0 * b 2, a 0 * b 1 - a 1 * b 0]

/-- **The turn is about the axis `a × b`**: it keeps that axis (perpendicular to both directions) fixed. -/
theorem turnBetween_axis {a b : Vec3} (hab : 0 < a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1) :
    turnBetween a b *ᵥ cross a b = cross a b := by
  have hs := turnNorm2_pos hab
  obtain ⟨h0, h1, h2⟩ := turnBetween_mulVec_mul a b (cross a b) hab
  ext i
  apply mul_left_cancel₀ hs.ne'
  fin_cases i
  · show turnNorm2 a b * (turnBetween a b *ᵥ cross a b) 0 = turnNorm2 a b * cross a b 0
    rw [h0]
    simp only [turnNorm2, turnQuatRaw, cross, Matrix.cons_val]
    ring
  · show turnNorm2 a b * (turnBetween a b *ᵥ cross a b) 1 = turnNorm2 a b * cross a b 1
    rw [h1]
    simp only [turnNorm2, turnQuatRaw, cross, Matrix.cons_val]
    ring
  · show turnNorm2 a b * (turnBetween a b *ᵥ cross a b) 2 = turnNorm2 a b * cross a b 2
    rw [h2]
    simp only [turnNorm2, turnQuatRaw, cross, Matrix.cons_val]
    ring

/-- **At the inferred direction the turn is the identity**: the light is exactly lighting.json's. -/
theorem turnBetween_self {a : Vec3} (ha : IsUnit3 a) : turnBetween a a = 1 := by
  unfold IsUnit3 at ha
  have hq : turnQuatRaw a a = ![0, 0, 0, 2] := by
    ext i
    fin_cases i <;> simp [turnQuatRaw]
    · ring
    · ring
    · ring
    · linear_combination ha
  have hn : turnNorm2 a a = 4 := by
    simp only [turnNorm2, hq, Matrix.cons_val]
    norm_num
  have h4 : Real.sqrt 4 = 2 := by
    rw [show (4 : ℝ) = 2 ^ 2 by norm_num, Real.sqrt_sq (by norm_num)]
  unfold turnBetween
  simp only [hq, hn, h4, Matrix.cons_val]
  ext i j
  fin_cases i <;> fin_cases j <;> norm_num [quatMat]

/-- **The whole light turns together** (§4.8): with the turn from the inferred key direction `a` to the new one `b`,
the key lands on `b`, and the ambient probe turned with it (band 1, as v1's fits) has, seen from any turned direction,
exactly the irradiance the original has from the original direction. -/
theorem turned_light {a b : Vec3} (ha : IsUnit3 a) (hb : IsUnit3 b)
    (hab : 0 < a 0 * b 0 + a 1 * b 1 + a 2 * b 2 + 1) {sh : Fin 9 → ℝ} (h2 : Lighting.NoBand2 sh) (m : Vec3) :
    turnBetween a b *ᵥ a = b ∧
      Lighting.irradianceAt (Lighting.rotateBand1 (turnBetween a b) sh) (turnBetween a b *ᵥ m) =
        Lighting.irradianceAt sh m := by
  refine ⟨turnBetween_apply ha hb hab, ?_⟩
  rw [Lighting.irradianceAt_rotateBand1 _ h2, Matrix.mulVec_mulVec,
    transpose_mul_of_mem_SO3 (turnBetween_mem_SO3 hab), Matrix.one_mulVec]

end Midstudy
