import Mathlib.Algebra.Order.Round
import Mathlib.Data.Rat.Floor
import Mathlib.Tactic.NormNum
import Mathlib.Tactic.Linarith
import Mathlib.Data.List.Pairwise

/-!
# Units and size readings of the product page (contract §2.11), over ℚ

Sizes are read in cm, mm, m, inches and feet, with feet and inches together (`7' 6"`) and fractions (`31 1/2`,
`41 ¾`), and reported in cm rounded to 0.1 (product_page.py `_CM`, `_num`, `_FR`, `_Item`, `Reading.out`).
Everything here is exact rational arithmetic: the reader's floats are tested against it, not proved.

Main results:
* `cmPer_inch`, `cmPer_ft`, `ft_eq_twelve_inches`: 1 in = 2.54 cm and 1 ft = 30.48 cm exactly, and a foot is
  12 inches; `toCm_add`, `toCm_mono`: conversion is linear and keeps order.
* `feetInches_toCm`: `F' I"` (read as `(12·F + I)/12` ft) is F feet plus I inches; `feetInches_7_6`: `7' 6"` is
  228.6 cm.
* `fracChar`: every fraction character `_FR` reads, as an exact rational; `mixed_31_half`, `mixed_41_threeQuarters`.
* `contract_example`: §2.11's worked example, `31 1/2x11x41 3/4"`, is `w 80.0, d 27.9, h 106.0` cm.
* The merge relation ("within 0.5 cm on every axis are one candidate"; product_page.py adds "or 1 %"):
  reflexive and symmetric (`near05_symm`, `nearV1_symm`, `same_symm`), not transitive (`near05_not_transitive`,
  `nearV1_not_transitive`, both with 10, 10.5, 11 cm). So the greedy merge depends on the order of the readings:
  `merge_order_matters` (three readings give one candidate in one order and two in another). Whatever the order,
  `merge_pairwise` (no two candidates are near) and `merge_covers` (every reading is near a candidate) hold.
-/

namespace Midstudy.Units

/-- The units the product page reader knows (§2.11). -/
inductive Unit
  | cm | mm | m | inch | ft
  deriving DecidableEq

/-- Centimetres per unit: product_page.py `_CM`. -/
def cmPer : Unit → ℚ
  | .cm => 1
  | .mm => 1 / 10
  | .m => 100
  | .inch => 254 / 100
  | .ft => 3048 / 100

/-- A value in a unit, in cm. -/
def toCm (u : Unit) (v : ℚ) : ℚ := v * cmPer u

/-- **1 in = 2.54 cm exactly.** -/
theorem cmPer_inch : cmPer .inch = 2.54 := by norm_num [cmPer]

/-- **1 ft = 30.48 cm exactly.** -/
theorem cmPer_ft : cmPer .ft = 30.48 := by norm_num [cmPer]

/-- A foot is exactly twelve inches. -/
theorem ft_eq_twelve_inches (x : ℚ) : toCm .ft x = toCm .inch (12 * x) := by
  simp [toCm, cmPer]
  ring

theorem cmPer_pos (u : Unit) : 0 < cmPer u := by cases u <;> norm_num [cmPer]

theorem toCm_add (u : Unit) (a b : ℚ) : toCm u (a + b) = toCm u a + toCm u b := by
  simp [toCm, add_mul]

theorem toCm_mono (u : Unit) {a b : ℚ} (h : a ≤ b) : toCm u a ≤ toCm u b :=
  mul_le_mul_of_nonneg_right h (cmPer_pos u).le

/-- `F' I"`: feet and inches together, read as `(12·F + I) / 12` feet (product_page.py `_Item`). -/
def feetInches (ft inch : ℚ) : ℚ := (12 * ft + inch) / 12

/-- **`F' I"` is F feet plus I inches.** -/
theorem feetInches_toCm (ft inch : ℚ) : toCm .ft (feetInches ft inch) = toCm .ft ft + toCm .inch inch := by
  simp [toCm, cmPer, feetInches]
  ring

theorem feetInches_7_6 : toCm .ft (feetInches 7 6) = 228.6 := by
  norm_num [toCm, cmPer, feetInches]

/-- `W N/D` (also `W-N/D`, or a fraction character after the whole number): product_page.py `_num`. -/
def mixed (whole num den : ℚ) : ℚ := whole + num / den

/-- The fraction characters product_page.py `_FR` reads, as exact rationals (the reader uses their float values). -/
def fracChar : Char → Option ℚ
  | '½' => some (1 / 2) | '¼' => some (1 / 4) | '¾' => some (3 / 4)
  | '⅓' => some (1 / 3) | '⅔' => some (2 / 3)
  | '⅛' => some (1 / 8) | '⅜' => some (3 / 8) | '⅝' => some (5 / 8) | '⅞' => some (7 / 8)
  | '⅕' => some (1 / 5) | '⅖' => some (2 / 5) | '⅗' => some (3 / 5) | '⅘' => some (4 / 5)
  | '⅙' => some (1 / 6) | '⅚' => some (5 / 6)
  | _ => none

/-- Every fraction character is a proper fraction. -/
theorem fracChar_mem {c : Char} {q : ℚ} (h : fracChar c = some q) : 0 < q ∧ q < 1 := by
  unfold fracChar at h
  split at h <;> simp only [Option.some.injEq, reduceCtorEq] at h <;> subst h <;> norm_num

theorem mixed_31_half : mixed 31 1 2 = 63 / 2 := by norm_num [mixed]

/-- `41 ¾` is `41 + ¾`, the same as `41 3/4`. -/
theorem mixed_41_threeQuarters : fracChar '¾' = some (3 / 4) ∧ 41 + 3 / 4 = mixed 41 3 4 := by
  norm_num [fracChar, mixed]

/-- Reported sizes are rounded to 0.1 cm (product_page.py `round(v + 1e-9, 1)`, i.e. halves up). -/
def round1 (x : ℚ) : ℚ := (round (x * 10) : ℚ) / 10

/-- **§2.11's worked example**: `31 1/2x11x41 3/4"` (inches) is `w 80.0, d 27.9, h 106.0` cm, as the contract's
response example says. -/
theorem contract_example :
    round1 (toCm .inch (mixed 31 1 2)) = 80 ∧ round1 (toCm .inch 11) = 27.9 ∧
      round1 (toCm .inch (mixed 41 3 4)) = 106 := by
  refine ⟨?_, ?_, ?_⟩ <;> norm_num [round1, toCm, cmPer, mixed, round_eq, Int.floor_eq_iff]

/-! ### The merge relation -/

/-- §2.11: "readings within 0.5 cm on every axis are one candidate", one axis. -/
def near05 (a b : ℚ) : Prop := |a - b| ≤ 1 / 2

/-- product_page.py `Reading.same`, one axis: within 0.5 cm, or 1 % of the larger (one size written in two units
rounds differently). -/
def nearV1 (a b : ℚ) : Prop := |a - b| ≤ max (1 / 2) (max a b / 100)

instance : DecidableRel near05 := fun a b => by unfold near05; infer_instance
instance : DecidableRel nearV1 := fun a b => by unfold nearV1; infer_instance

theorem near05_refl (a : ℚ) : near05 a a := by norm_num [near05]
theorem nearV1_refl (a : ℚ) : nearV1 a a := by simp [nearV1]

theorem near05_symm {a b : ℚ} (h : near05 a b) : near05 b a := by
  unfold near05 at *
  rwa [abs_sub_comm]

theorem nearV1_symm {a b : ℚ} (h : nearV1 a b) : nearV1 b a := by
  unfold nearV1 at *
  rwa [abs_sub_comm, max_comm b a]

/-- **Not transitive**: 10 is near 10.5 and 10.5 near 11, but 10 isn't near 11. -/
theorem near05_not_transitive : near05 10 10.5 ∧ near05 10.5 11 ∧ ¬ near05 10 11 := by
  norm_num [near05, abs_le]

/-- The reader's own relation (0.5 cm or 1 %) is not transitive either, with the same three readings. -/
theorem nearV1_not_transitive : nearV1 10 10.5 ∧ nearV1 10.5 11 ∧ ¬ nearV1 10 11 := by
  norm_num [nearV1, abs_le]

/-- An axis that may be missing (`h` is null when the page has no height): both missing, or both present and
near. -/
def nearOpt (near : ℚ → ℚ → Prop) : Option ℚ → Option ℚ → Prop
  | none, none => True
  | some a, some b => near a b
  | _, _ => False

instance {near : ℚ → ℚ → Prop} [DecidableRel near] : DecidableRel (nearOpt near)
  | none, none => isTrue trivial
  | some a, some b => (inferInstance : Decidable (near a b))
  | none, some _ => isFalse id
  | some _, none => isFalse id

/-- A size reading in cm (`Reading`: w, d, and h or null). -/
structure Reading where
  w : ℚ
  d : ℚ
  h : Option ℚ

/-- Two readings are one candidate: near on every axis. -/
def same (near : ℚ → ℚ → Prop) (r s : Reading) : Prop := near r.w s.w ∧ near r.d s.d ∧ nearOpt near r.h s.h

instance {near : ℚ → ℚ → Prop} [DecidableRel near] : DecidableRel (same near) :=
  fun r s => by unfold same; infer_instance

theorem nearOpt_symm {near : ℚ → ℚ → Prop} (hs : ∀ {a b}, near a b → near b a) {x y : Option ℚ}
    (h : nearOpt near x y) : nearOpt near y x := by
  cases x <;> cases y <;> simp_all [nearOpt]

theorem same_symm {near : ℚ → ℚ → Prop} (hs : ∀ {a b}, near a b → near b a) {r s : Reading}
    (h : same near r s) : same near s r :=
  ⟨hs h.1, hs h.2.1, nearOpt_symm hs h.2.2⟩

theorem same_refl {near : ℚ → ℚ → Prop} (hr : ∀ a, near a a) (r : Reading) : same near r r := by
  refine ⟨hr _, hr _, ?_⟩
  cases r.h <;> simp [nearOpt, hr]

/-- One step of the reader's merge (product_page.py, the `cands` loop): a reading near an earlier candidate joins
it, any other becomes a new candidate. -/
def mergeStep (near : ℚ → ℚ → Prop) [DecidableRel near] (cands : List Reading) (r : Reading) : List Reading :=
  if cands.any (fun c => decide (same near c r)) then cands else cands ++ [r]

/-- The candidates the readings give, in the order they are met. -/
def merge (near : ℚ → ℚ → Prop) [DecidableRel near] (l : List Reading) : List Reading :=
  l.foldl (mergeStep near) []

/-- Three readings 10, 10.5 and 11 cm wide (the rest equal). -/
def r10 : Reading := ⟨10, 50, some 80⟩
def r10h : Reading := ⟨10.5, 50, some 80⟩
def r11 : Reading := ⟨11, 50, some 80⟩

/-- **The merge order matters**: 10.5, 10, 11 give one candidate; 10, 11, 10.5 (the same readings) give two. -/
theorem merge_order_matters :
    merge near05 [r10h, r10, r11] = [r10h] ∧ merge near05 [r10, r11, r10h] = [r10, r11] := by
  constructor <;>
  simp [merge, mergeStep, same, nearOpt, near05, r10, r10h, r11, abs_le] <;> norm_num

/-- The same with the reader's own relation. -/
theorem merge_order_matters_v1 :
    merge nearV1 [r10h, r10, r11] = [r10h] ∧ merge nearV1 [r10, r11, r10h] = [r10, r11] := by
  constructor <;>
  simp [merge, mergeStep, same, nearOpt, nearV1, r10, r10h, r11, abs_le] <;> norm_num

section Invariants

variable {near : ℚ → ℚ → Prop} [DecidableRel near]

theorem mergeStep_pairwise {cands : List Reading}
    (hc : cands.Pairwise (fun a b => ¬ same near a b)) (r : Reading) :
    (mergeStep near cands r).Pairwise (fun a b => ¬ same near a b) := by
  unfold mergeStep
  split_ifs with h
  · exact hc
  · rw [List.pairwise_append]
    refine ⟨hc, List.pairwise_singleton _ _, ?_⟩
    intro a ha b hb
    rw [List.mem_singleton] at hb
    subst hb
    intro hab
    apply h
    rw [List.any_eq_true]
    exact ⟨a, ha, by simpa using hab⟩

theorem merge_pairwise_aux (l : List Reading) :
    ∀ cands : List Reading, cands.Pairwise (fun a b => ¬ same near a b) →
      (l.foldl (mergeStep near) cands).Pairwise (fun a b => ¬ same near a b) := by
  induction l with
  | nil => intro cands hc; exact hc
  | cons r l ih => intro cands hc; exact ih _ (mergeStep_pairwise hc r)

/-- **Whatever the order, no two candidates are near each other** (no candidate is near a later one; with a
symmetric relation, `same_symm`, nor an earlier one). -/
theorem merge_pairwise (l : List Reading) :
    (merge near l).Pairwise (fun a b => ¬ same near a b) :=
  merge_pairwise_aux l [] List.Pairwise.nil

theorem merge_covers_aux (hr : ∀ a, near a a) (l : List Reading) :
    ∀ cands : List Reading, (∀ r ∈ cands, ∃ c ∈ cands, same near c r) →
      (∀ r ∈ l ++ cands, ∃ c ∈ l.foldl (mergeStep near) cands, same near c r) ∧
      (∀ c ∈ cands, c ∈ l.foldl (mergeStep near) cands) := by
  induction l with
  | nil =>
    intro cands hc
    exact ⟨by simpa using hc, fun c hc' => hc'⟩
  | cons r l ih =>
    intro cands hc
    have hstep : ∀ x ∈ r :: cands, ∃ c ∈ mergeStep near cands r, same near c x := by
      intro x hx
      unfold mergeStep
      split_ifs with h
      · rcases List.mem_cons.1 hx with rfl | hx
        · rw [List.any_eq_true] at h
          obtain ⟨c, hc', hcr⟩ := h
          exact ⟨c, hc', by simpa using hcr⟩
        · exact hc x hx
      · rcases List.mem_cons.1 hx with rfl | hx
        · exact ⟨x, by simp, same_refl hr x⟩
        · obtain ⟨c, hc', hcx⟩ := hc x hx
          exact ⟨c, by simp [hc'], hcx⟩
    have hsub : ∀ c ∈ cands, c ∈ mergeStep near cands r := by
      intro c hc'
      unfold mergeStep
      split_ifs <;> simp [hc']
    obtain ⟨h1, h2⟩ := ih (mergeStep near cands r) (fun x hx => by
      unfold mergeStep at hx
      split_ifs at hx with h
      · obtain ⟨c, hc', hcx⟩ := hc x hx
        exact ⟨c, by unfold mergeStep; rw [if_pos h]; exact hc', hcx⟩
      · rcases List.mem_append.1 hx with hx | hx
        · obtain ⟨c, hc', hcx⟩ := hc x hx
          exact ⟨c, by unfold mergeStep; rw [if_neg h]; simp [hc'], hcx⟩
        · rw [List.mem_singleton] at hx
          subst hx
          exact ⟨x, by unfold mergeStep; rw [if_neg h]; simp, same_refl hr x⟩)
    refine ⟨fun x hx => ?_, fun c hc' => h2 c (hsub c hc')⟩
    rw [List.foldl_cons]
    rcases List.mem_append.1 hx with hx | hx
    · rcases List.mem_cons.1 hx with rfl | hx
      · obtain ⟨c, hc', hcx⟩ := hstep x (List.mem_cons_self ..)
        exact ⟨c, h2 c hc', hcx⟩
      · exact h1 x (List.mem_append_left _ hx)
    · obtain ⟨c, hc', hcx⟩ := hstep x (List.mem_cons_of_mem _ hx)
      exact ⟨c, h2 c hc', hcx⟩

/-- **Whatever the order, every reading is near one of the candidates.** -/
theorem merge_covers (hr : ∀ a, near a a) (l : List Reading) :
    ∀ r ∈ l, ∃ c ∈ merge near l, same near c r := by
  intro r hr'
  have := (merge_covers_aux hr l [] (by simp)).1 r (by simpa using hr')
  exact this

end Invariants

end Midstudy.Units
