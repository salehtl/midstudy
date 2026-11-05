import Mathlib.Analysis.SpecialFunctions.Trigonometric.Basic
import Mathlib.LinearAlgebra.UnitaryGroup
import Mathlib.LinearAlgebra.Matrix.Notation

/-!
# The three elementary rotations of contract §4.1

`Rx`, `Ry`, `Rz` exactly as contract §4.1 writes them (three.js `makeRotationX/Y/Z`), each a rotation:
orthogonal with determinant 1, i.e. in `Matrix.specialOrthogonalGroup (Fin 3) ℝ`. The camera (`Camera.lean`)
and the items (`Item.lean`) build on these.
-/

noncomputable section

open Real Matrix

namespace Midstudy

/-- Points and directions: `![x, y, z]`, meters, right-handed, Y-up (CLAUDE.md). -/
abbrev Vec3 := Fin 3 → ℝ
/-- 3 × 3 real matrices. -/
abbrev Mat3 := Matrix (Fin 3) (Fin 3) ℝ

/-- Degrees to radians, as the planner's `DEG = Math.PI / 180`. -/
def rad (deg : ℝ) : ℝ := deg * (π / 180)

/-- `Rx(a)` of contract §4.1. -/
def Rx (a : ℝ) : Mat3 := !![1, 0, 0; 0, cos a, -sin a; 0, sin a, cos a]

/-- `Rz(b)` of contract §4.1. -/
def Rz (b : ℝ) : Mat3 := !![cos b, -sin b, 0; sin b, cos b, 0; 0, 0, 1]

/-- `Ry(t)`, three.js `makeRotationY`: the item rotation (`rotation_y_deg`) and the camera's yaw (always 0). -/
def Ry (t : ℝ) : Mat3 := !![cos t, 0, sin t; 0, 1, 0; -sin t, 0, cos t]

theorem Rx_mul_transpose (a : ℝ) : Rx a * (Rx a)ᵀ = 1 := by
  ext i j
  fin_cases i <;> fin_cases j <;> simp [Rx, Matrix.mul_apply, Fin.sum_univ_three] <;>
    first | ring1 | linear_combination sin_sq_add_cos_sq a

theorem Ry_mul_transpose (t : ℝ) : Ry t * (Ry t)ᵀ = 1 := by
  ext i j
  fin_cases i <;> fin_cases j <;> simp [Ry, Matrix.mul_apply, Fin.sum_univ_three] <;>
    first | ring1 | linear_combination sin_sq_add_cos_sq t

theorem Rz_mul_transpose (b : ℝ) : Rz b * (Rz b)ᵀ = 1 := by
  ext i j
  fin_cases i <;> fin_cases j <;> simp [Rz, Matrix.mul_apply, Fin.sum_univ_three] <;>
    first | ring1 | linear_combination sin_sq_add_cos_sq b

theorem Rx_det (a : ℝ) : (Rx a).det = 1 := by
  simp [Rx, Matrix.det_fin_three]
  linear_combination sin_sq_add_cos_sq a

theorem Ry_det (t : ℝ) : (Ry t).det = 1 := by
  simp [Ry, Matrix.det_fin_three]
  linear_combination sin_sq_add_cos_sq t

theorem Rz_det (b : ℝ) : (Rz b).det = 1 := by
  simp [Rz, Matrix.det_fin_three]
  linear_combination sin_sq_add_cos_sq b

theorem Rx_mem_SO3 (a : ℝ) : Rx a ∈ specialOrthogonalGroup (Fin 3) ℝ :=
  mem_specialOrthogonalGroup_iff.2 ⟨(mem_orthogonalGroup_iff _ _).2 (Rx_mul_transpose a), Rx_det a⟩

theorem Ry_mem_SO3 (t : ℝ) : Ry t ∈ specialOrthogonalGroup (Fin 3) ℝ :=
  mem_specialOrthogonalGroup_iff.2 ⟨(mem_orthogonalGroup_iff _ _).2 (Ry_mul_transpose t), Ry_det t⟩

theorem Rz_mem_SO3 (b : ℝ) : Rz b ∈ specialOrthogonalGroup (Fin 3) ℝ :=
  mem_specialOrthogonalGroup_iff.2 ⟨(mem_orthogonalGroup_iff _ _).2 (Rz_mul_transpose b), Rz_det b⟩

/-- A rotation's transpose is its inverse on both sides. -/
theorem transpose_mul_of_mem_SO3 {A : Mat3} (h : A ∈ specialOrthogonalGroup (Fin 3) ℝ) : Aᵀ * A = 1 := by
  have h1 : A * Aᵀ = 1 := (mem_orthogonalGroup_iff _ _).1 (mem_specialOrthogonalGroup_iff.1 h).1
  exact mul_eq_one_comm.1 h1

theorem mul_transpose_of_mem_SO3 {A : Mat3} (h : A ∈ specialOrthogonalGroup (Fin 3) ℝ) : A * Aᵀ = 1 :=
  (mem_orthogonalGroup_iff _ _).1 (mem_specialOrthogonalGroup_iff.1 h).1

theorem det_of_mem_SO3 {A : Mat3} (h : A ∈ specialOrthogonalGroup (Fin 3) ℝ) : A.det = 1 :=
  (mem_specialOrthogonalGroup_iff.1 h).2

@[simp] theorem Ry_zero : Ry 0 = 1 := by
  ext i j
  fin_cases i <;> fin_cases j <;> simp [Ry]

end Midstudy
