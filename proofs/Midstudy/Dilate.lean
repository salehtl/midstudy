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
* `run_interval_iff`, `rowRuns_iff`, `dilateRuns_iff` (LEAN.md 27 as of k-geom 66d7f7e): the kernel's faster row pass,
  which turns on `[s − left, e − 1 + right]` (clipped) for each maximal run `[s, e)` of set pixels, marks the same
  pixels as v1's two scans (`rowRuns_iff_rowPass`), so the kernel's dilation is the box dilation too.
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

/-! ### The kernel's run-based row pass -/

/-- **The union of `[x' − left, x' + right]` over a run `[s, e)` is `[s − left, e − 1 + right]`** (LEAN.md 27). -/
theorem run_interval_iff {s e : ℕ} (hse : s < e) (left right x : ℕ) :
    (∃ x', s ≤ x' ∧ x' < e ∧ x' ≤ x + left ∧ x ≤ x' + right) ↔ (s ≤ x + left ∧ x ≤ e - 1 + right) := by
  constructor
  · rintro ⟨x', h1, h2, h3, h4⟩
    exact ⟨by omega, by omega⟩
  · rintro ⟨h1, h2⟩
    by_cases hlo : x < s
    · exact ⟨s, le_rfl, hse, h1, by omega⟩
    · by_cases hhi : e - 1 < x
      · exact ⟨e - 1, by omega, by omega, by omega, h2⟩
      · exact ⟨x, by omega, by omega, by omega, by omega⟩

/-- A maximal run `[s, e)` of set pixels in a row of width `w`. -/
def IsRun (src : ℕ → Bool) (w s e : ℕ) : Prop :=
  s < e ∧ e ≤ w ∧ (∀ k, s ≤ k → k < e → src k = true) ∧ (s = 0 ∨ src (s - 1) = false) ∧ (e = w ∨ src e = false)

/-- raster `row_step`: pixel `x` is on when some maximal run `[s, e)` covers it with `[s − left, e − 1 + right]`. -/
def rowRuns (src : ℕ → Bool) (w left right x : ℕ) : Prop :=
  ∃ s e, IsRun src w s e ∧ s ≤ x + left ∧ x ≤ e - 1 + right

/-- Every set pixel lies in a maximal run. -/
theorem exists_run (src : ℕ → Bool) {w x' : ℕ} (hx' : x' < w) (hs : src x' = true) :
    ∃ s e, IsRun src w s e ∧ s ≤ x' ∧ x' < e := by
  classical
  -- the run's start: the least s with every pixel of [s, x'] set
  have hP : ∃ k, k ≤ x' ∧ ∀ j, k ≤ j → j ≤ x' → src j = true :=
    ⟨x', le_rfl, fun j h1 h2 => by rw [show j = x' by omega]; exact hs⟩
  -- the run's end: the least e > x' that is w or unset
  have hQ : ∃ k, x' < k ∧ (k = w ∨ src k = false) := ⟨w, hx', Or.inl rfl⟩
  set s0 := Nat.find hP with hs0
  set e0 := Nat.find hQ with he0
  obtain ⟨hs0x, hs0all⟩ := Nat.find_spec hP
  obtain ⟨he0x, he0end⟩ := Nat.find_spec hQ
  have he0w : e0 ≤ w := Nat.find_min' hQ ⟨hx', Or.inl rfl⟩
  have hmid : ∀ k, x' < k → k < e0 → src k = true := by
    intro k hk1 hk2
    have := Nat.find_min hQ hk2
    simp only [not_and, not_or] at this
    have h := (this hk1).2
    simpa using h
  refine ⟨s0, e0, ⟨by omega, he0w, ?_, ?_, he0end⟩, hs0x, he0x⟩
  · intro k hk1 hk2
    rcases le_or_gt k x' with h | h
    · exact hs0all k hk1 h
    · exact hmid k h hk2
  · rcases Nat.eq_zero_or_pos s0 with h0 | h0
    · exact Or.inl h0
    · right
      by_contra hc
      have hc' : src (s0 - 1) = true := by simpa using hc
      have : s0 ≤ s0 - 1 := Nat.find_min' hP ⟨by omega, fun j h1 h2 => by
        rcases eq_or_lt_of_le h1 with h | h
        · rw [← h]; exact hc'
        · exact hs0all j (by omega) h2⟩
      omega

/-- **The run-based row pass marks exactly the pixels with a set pixel within reach.** -/
theorem rowRuns_iff (src : ℕ → Bool) (w x left right : ℕ) :
    rowRuns src w left right x ↔ ∃ x', x' < w ∧ x' ≤ x + left ∧ x ≤ x' + right ∧ src x' = true := by
  constructor
  · rintro ⟨s, e, ⟨hse, hew, hall, -, -⟩, h1, h2⟩
    obtain ⟨x', h3, h4, h5, h6⟩ := (run_interval_iff hse left right x).2 ⟨h1, h2⟩
    exact ⟨x', by omega, h5, h6, hall x' h3 h4⟩
  · rintro ⟨x', hx', h1, h2, hs⟩
    obtain ⟨s, e, hrun, hsx, hxe⟩ := exists_run src hx' hs
    exact ⟨s, e, hrun, by omega, by omega⟩

/-- **The kernel's row pass and v1's two scans mark the same pixels.** -/
theorem rowRuns_iff_rowPass (src : ℕ → ℕ → Bool) {w x : ℕ} (hx : x < w) (left right y : ℕ) :
    rowRuns (fun x' => src x' y) w left right x ↔ rowPass src w right left x y := by
  rw [rowRuns_iff, rowPass_iff src hx]
  constructor
  · rintro ⟨x', h1, h2, h3, h4⟩
    exact ⟨x', h1, h3, h2, h4⟩
  · rintro ⟨x', h1, h2, h3, h4⟩
    exact ⟨x', h1, h3, h2, h4⟩

open Classical in
/-- raster `dilate_into` (k-geom 66d7f7e): the run-based row pass, then the column scans. -/
def dilateRuns (src : ℕ → ℕ → Bool) (w h right left down up x y : ℕ) : Prop :=
  let a : ℕ → ℕ → Bool := fun x' y' => decide (rowRuns (fun x'' => src x'' y') w left right x')
  (∃ d, fwd (fun y' => a x y') y = some d ∧ d ≤ down) ∨ (∃ d, bwd (fun y' => a x y') h y = some d ∧ d ≤ up)

open Classical in
/-- The kernel's dilation marks the same pixels as v1's. -/
theorem dilateRuns_iff (src : ℕ → ℕ → Bool) {w h x y : ℕ} (hx : x < w) (right left down up : ℕ) :
    dilateRuns src w h right left down up x y ↔ dilate src w h right left down up x y := by
  unfold dilateRuns dilate
  dsimp only
  have e : ∀ y', decide (rowRuns (fun x'' => src x'' y') w left right x) =
      decide (rowPass src w right left x y') := fun y' => by
    rw [decide_eq_decide]
    exact rowRuns_iff_rowPass src hx left right y'
  simp only [e]

/-- **The kernel's dilation is the box dilation** (raster `dilate_into`, k-geom 66d7f7e). -/
theorem dilateRuns_box (src : ℕ → ℕ → Bool) {w h x y : ℕ} (hx : x < w) (hy : y < h) (right left down up : ℕ) :
    dilateRuns src w h right left down up x y ↔
      ∃ x' y', x' < w ∧ y' < h ∧ x ≤ x' + right ∧ x' ≤ x + left ∧ y ≤ y' + down ∧ y' ≤ y + up ∧
        src x' y' = true := by
  rw [dilateRuns_iff src hx, dilate_iff src hx hy]

end Midstudy.Dilate
