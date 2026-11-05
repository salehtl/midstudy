import Midstudy.Clamp
import Mathlib.Analysis.SpecialFunctions.Trigonometric.Basic

/-!
# Where a new piece lands (contract §4.5; geom LEAN.md property 20)

geom `landing_spot` (v1 `landingSpot`): from a base floor point, rings of 0.6 m around it (ring `r` has `max(1, 8r)`
points, `r = 0..5`), the first point more than 0.6 m in front of the camera (`z < −0.6`) and more than 0.45 m from every
taken spot; else the base; rounded to 6 decimals.

* `landing_spec`: the result is the base, or the first ring point that is free, rounded; every ring point lies exactly
  `0.6 · r` from the base (`ringPoint_dist`).
* `landing_free`: so a landed piece is in front and clear of every other piece, up to the rounding: its coordinates are
  within 5·10⁻⁷ of a point that is (`round6_err`). (LEAN.md's statement leaves out the rounding: a point at
  z = −0.6000004 lands at z = −0.6.)
-/

noncomputable section

open Real

namespace Midstudy.Landing

/-- Ring `r`'s `k`-th point around `base` (x, z). -/
def ringPoint (base : ℝ × ℝ) (r k : ℕ) : ℝ × ℝ :=
  let m := max 1 (8 * r)
  let a := (k : ℝ) / m * π * 2
  (base.1 + cos a * r * 0.6, base.2 + sin a * r * 0.6)

/-- The candidates in the order the code tries them. -/
def candidates (base : ℝ × ℝ) : List (ℝ × ℝ) :=
  (List.range 6).flatMap fun r => (List.range (max 1 (8 * r))).map fun k => ringPoint base r k

/-- In front (more than 0.6 m) and more than 0.45 m from every taken spot. -/
def Free (taken : List (ℝ × ℝ)) (p : ℝ × ℝ) : Prop :=
  p.2 < -0.6 ∧ ∀ q ∈ taken, 0.45 < Real.sqrt ((q.1 - p.1) ^ 2 + (q.2 - p.2) ^ 2)

open Classical in
/-- geom `landing_spot` after the base: the first free candidate, else the base, rounded to 6 decimals. -/
def landing (base : ℝ × ℝ) (taken : List (ℝ × ℝ)) : ℝ × ℝ :=
  let p := ((candidates base).find? fun q => decide (Free taken q)).getD base
  (round6 p.1, round6 p.2)

/-- Every ring point is exactly `0.6 · r` from the base. -/
theorem ringPoint_dist (base : ℝ × ℝ) (r k : ℕ) :
    Real.sqrt (((ringPoint base r k).1 - base.1) ^ 2 + ((ringPoint base r k).2 - base.2) ^ 2) = 0.6 * r := by
  simp only [ringPoint]
  rw [show (base.1 + cos ((k : ℝ) / (max 1 (8 * r) : ℕ) * π * 2) * r * 0.6 - base.1) ^ 2 +
      (base.2 + sin ((k : ℝ) / (max 1 (8 * r) : ℕ) * π * 2) * r * 0.6 - base.2) ^ 2 = (0.6 * r) ^ 2 by
      linear_combination ((r : ℝ) * 0.6) ^ 2 * cos_sq_add_sin_sq ((k : ℝ) / (max 1 (8 * r) : ℕ) * π * 2)]
  exact Real.sqrt_sq (by positivity)

/-- `round6` moves a number by at most half a millionth. -/
theorem round6_err (x : ℝ) : |round6 x - x| ≤ 1 / 2 / 10 ^ 6 := by
  unfold round6
  have h := abs_sub_round (x * 10 ^ 6)
  rw [show (round (x * 10 ^ 6) : ℝ) / 10 ^ 6 - x = -((x * 10 ^ 6 - round (x * 10 ^ 6)) / 10 ^ 6) by
    field_simp; ring, abs_neg, abs_div, abs_of_pos (by positivity : (0 : ℝ) < 10 ^ 6)]
  exact div_le_div_of_nonneg_right h (by positivity)

open Classical in
/-- **The result is the base or the first free ring point, rounded.** -/
theorem landing_spec (base : ℝ × ℝ) (taken : List (ℝ × ℝ)) :
    ∃ p, landing base taken = (round6 p.1, round6 p.2) ∧
      ((p = base ∧ ∀ q ∈ candidates base, ¬ Free taken q) ∨ (p ∈ candidates base ∧ Free taken p)) := by
  unfold landing
  cases h : (candidates base).find? (fun q => decide (Free taken q)) with
  | none =>
    refine ⟨base, rfl, Or.inl ⟨rfl, fun q hq => ?_⟩⟩
    have := List.find?_eq_none.1 h q hq
    simpa using this
  | some p =>
    refine ⟨p, rfl, Or.inr ⟨List.mem_of_find?_eq_some h, ?_⟩⟩
    have := List.find?_some h
    simpa using this

/-- **A landed piece is in front and clear of every other piece**, up to the 6-decimal rounding: unless no ring point
is free (then it lands on the base), its coordinates are within 5·10⁻⁷ of a free point. -/
theorem landing_free (base : ℝ × ℝ) (taken : List (ℝ × ℝ)) :
    (landing base taken = (round6 base.1, round6 base.2) ∧ ∀ q ∈ candidates base, ¬ Free taken q) ∨
      ∃ p, Free taken p ∧ |(landing base taken).1 - p.1| ≤ 1 / 2 / 10 ^ 6 ∧
        |(landing base taken).2 - p.2| ≤ 1 / 2 / 10 ^ 6 := by
  obtain ⟨p, hl, h⟩ := landing_spec base taken
  rcases h with ⟨rfl, hall⟩ | ⟨-, hfree⟩
  · exact Or.inl ⟨hl, hall⟩
  · exact Or.inr ⟨p, hfree, by rw [hl]; exact round6_err _, by rw [hl]; exact round6_err _⟩

end Midstudy.Landing
