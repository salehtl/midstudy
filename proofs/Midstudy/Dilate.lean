import Mathlib.Tactic.Linarith
import Mathlib.Order.Basic

/-!
# The keep-room mask's dilation (contract §4.7; geom LEAN.md property 27; raster `mask.rs` `dilate_into`)

The mask around the pieces is dilated by v1's two-pass scan: per row, a "distance since the last set pixel" counter
left to right (reach `right`) and right to left (reach `left`); then per column the same top to bottom (reach `down`)
and bottom to top (reach `up`). Modelled with the counters as `Option ℕ` (`none`: no set pixel yet; the Rust's
saturating `u32::MAX`, which never matters for reaches below 2³² − 1).

* `fwd_iff`, `bwd_iff`: one pass marks exactly the pixels with a set pixel within its reach behind (ahead of) them.
* `dilate_iff`: **the scan is the box dilation**: an output pixel is set exactly when some source pixel lies within
  `[x − right, x + left] × [y − down, y + up]` (inside the image).
-/

namespace Midstudy.Dilate

/-- One forward pass: the distance back to the last set pixel (`none` before the first). -/
def fwd (s : ℕ → Bool) : ℕ → Option ℕ
  | 0 => if s 0 then some 0 else none
  | i + 1 => if s (i + 1) then some 0 else (fwd s i).map (· + 1)

/-- **A forward pass within reach `R`** marks exactly the pixels with a set pixel at most `R` behind them. -/
theorem fwd_iff (s : ℕ → Bool) (i R : ℕ) :
    (∃ d, fwd s i = some d ∧ d ≤ R) ↔ ∃ j ≤ i, i ≤ j + R ∧ s j = true := by
  induction i generalizing R with
  | zero =>
    simp only [fwd]
    constructor
    · rintro ⟨d, hd, -⟩
      split_ifs at hd with h
      exact ⟨0, le_rfl, by omega, h⟩
    · rintro ⟨j, hj, -, hs⟩
      obtain rfl : j = 0 := by omega
      exact ⟨0, by simp [hs], Nat.zero_le _⟩
  | succ i ih =>
    simp only [fwd]
    by_cases h : s (i + 1) = true
    · rw [if_pos h]
      exact ⟨fun _ => ⟨i + 1, le_rfl, by omega, h⟩, fun _ => ⟨0, rfl, Nat.zero_le _⟩⟩
    · rw [if_neg h]
      constructor
      · rintro ⟨d, hd, hdR⟩
        obtain ⟨e, he, rfl⟩ := Option.map_eq_some_iff.1 hd
        obtain ⟨j, hj, hjR, hs⟩ := (ih (R - 1)).1 ⟨e, he, by omega⟩
        exact ⟨j, by omega, by omega, hs⟩
      · rintro ⟨j, hj, hjR, hs⟩
        have hji : j ≤ i := by
          rcases Nat.lt_or_ge j (i + 1) with h' | h'
          · omega
          · obtain rfl : j = i + 1 := by omega
            exact absurd hs h
        obtain ⟨e, he, heR⟩ := (ih (R - 1)).2 ⟨j, hji, by omega, hs⟩
        exact ⟨e + 1, by rw [he]; rfl, by omega⟩

/-- One backward pass over a row of `n` pixels: the forward pass of the reversed row. -/
def bwd (s : ℕ → Bool) (n i : ℕ) : Option ℕ := fwd (fun k => s (n - 1 - k)) (n - 1 - i)

/-- **A backward pass within reach `L`** marks exactly the pixels with a set pixel at most `L` ahead of them. -/
theorem bwd_iff (s : ℕ → Bool) {n i : ℕ} (hi : i < n) (L : ℕ) :
    (∃ d, bwd s n i = some d ∧ d ≤ L) ↔ ∃ j, i ≤ j ∧ j < n ∧ j ≤ i + L ∧ s j = true := by
  unfold bwd
  rw [fwd_iff]
  constructor
  · rintro ⟨j, hj, hjL, hs⟩
    exact ⟨n - 1 - j, by omega, by omega, by omega, hs⟩
  · rintro ⟨j, hj, hjn, hjL, hs⟩
    refine ⟨n - 1 - j, by omega, by omega, ?_⟩
    rw [show n - 1 - (n - 1 - j) = j by omega]
    exact hs

/-- The row pass: forward with reach `right`, backward with reach `left`. -/
def rowPass (src : ℕ → ℕ → Bool) (w right left x y : ℕ) : Prop :=
  (∃ d, fwd (fun x' => src x' y) x = some d ∧ d ≤ right) ∨ (∃ d, bwd (fun x' => src x' y) w x = some d ∧ d ≤ left)

theorem rowPass_iff (src : ℕ → ℕ → Bool) {w x : ℕ} (hx : x < w) (right left y : ℕ) :
    rowPass src w right left x y ↔ ∃ x', x' < w ∧ x ≤ x' + right ∧ x' ≤ x + left ∧ src x' y = true := by
  unfold rowPass
  rw [fwd_iff, bwd_iff _ hx]
  constructor
  · rintro (⟨j, hj, hjR, hs⟩ | ⟨j, hj, hjn, hjL, hs⟩)
    · exact ⟨j, by omega, hjR, by omega, hs⟩
    · exact ⟨j, hjn, by omega, hjL, hs⟩
  · rintro ⟨x', hx', h1, h2, hs⟩
    rcases le_total x' x with h | h
    · exact Or.inl ⟨x', h, h1, hs⟩
    · exact Or.inr ⟨x', h, hx', h2, hs⟩

open Classical in
/-- raster `dilate_into`: the row pass, then the column pass on its result (top to bottom with reach `down`, bottom
to top with reach `up`). -/
def dilate (src : ℕ → ℕ → Bool) (w h right left down up x y : ℕ) : Prop :=
  let a : ℕ → ℕ → Bool := fun x' y' => decide (rowPass src w right left x' y')
  (∃ d, fwd (fun y' => a x y') y = some d ∧ d ≤ down) ∨ (∃ d, bwd (fun y' => a x y') h y = some d ∧ d ≤ up)

/-- **The two-pass scan is the box dilation**: inside the image, an output pixel is set exactly when a source pixel
lies within `right` to its left, `left` to its right, `down` above and `up` below it (rows grow downwards). -/
theorem dilate_iff (src : ℕ → ℕ → Bool) {w h x y : ℕ} (hx : x < w) (hy : y < h) (right left down up : ℕ) :
    dilate src w h right left down up x y ↔
      ∃ x' y', x' < w ∧ y' < h ∧ x ≤ x' + right ∧ x' ≤ x + left ∧ y ≤ y' + down ∧ y' ≤ y + up ∧
        src x' y' = true := by
  unfold dilate
  dsimp only
  rw [fwd_iff, bwd_iff _ hy]
  simp only [decide_eq_true_eq]
  constructor
  · rintro (⟨j, hj, hjR, hs⟩ | ⟨j, hj, hjn, hjL, hs⟩)
    · obtain ⟨x', hx', h1, h2, hs'⟩ := (rowPass_iff src hx right left j).1 hs
      exact ⟨x', j, hx', by omega, h1, h2, hjR, by omega, hs'⟩
    · obtain ⟨x', hx', h1, h2, hs'⟩ := (rowPass_iff src hx right left j).1 hs
      exact ⟨x', j, hx', hjn, h1, h2, by omega, hjL, hs'⟩
  · rintro ⟨x', y', hx', hy', h1, h2, h3, h4, hs⟩
    have hrow : rowPass src w right left x y' := (rowPass_iff src hx right left y').2 ⟨x', hx', h1, h2, hs⟩
    rcases le_total y' y with hle | hle
    · exact Or.inl ⟨y', hle, h3, hrow⟩
    · exact Or.inr ⟨y', hle, hy', h4, hrow⟩

end Midstudy.Dilate
