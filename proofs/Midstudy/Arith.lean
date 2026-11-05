import Midstudy.Clamp
import Mathlib.Data.Nat.Digits.Defs

/-!
# Two integer kernels of the media crate (core/crates/media AENEAS.md targets #2 and #7)

* `zip::megabytes` (the "at most 500 MB unpacked" message, §2.8): `megabytes_eq_roundHalfEven`: the three lines of
  integer arithmetic are exactly `total / 10⁶` rounded half to even (what Python's `f"{total / 1e6:.0f}"` prints),
  for every `u64`, and `megabytes_lt`: the `+ 1` never overflows.
* `http::content_length`'s digit fold (§2.9 framing): `foldDigits_lt`, `foldDigits_eq`: over at most 15 ASCII digits
  every intermediate value stays below 10¹⁵, so the checked multiply-add never fails on a `u64`, and the value is the
  digits' number.
-/

noncomputable section

namespace Midstudy.Arith

/-- zip.rs `megabytes`: `q = total / 10⁶`, `r = total % 10⁶`, then `q + 1` when `r > 500000`, or `r = 500000` and `q`
is odd, else `q`. -/
def megabytes (total : ℕ) : ℕ :=
  if total % 1000000 > 500000 ∨ (total % 1000000 = 500000 ∧ total / 1000000 % 2 = 1) then total / 1000000 + 1
  else total / 1000000

/-- **`megabytes` is `total / 10⁶` rounded half to even**, exactly (Python's rounding), for every total. -/
theorem megabytes_eq_roundHalfEven (total : ℕ) :
    (megabytes total : ℤ) = roundHalfEven ((total : ℝ) / 1000000) := by
  obtain ⟨q, r, hr', rfl⟩ : ∃ q r, r < 1000000 ∧ total = 1000000 * q + r :=
    ⟨total / 1000000, total % 1000000, Nat.mod_lt _ (by norm_num), (Nat.div_add_mod total 1000000).symm⟩
  have hq : (1000000 * q + r) / 1000000 = q := by omega
  have hr : (1000000 * q + r) % 1000000 = r := by omega
  have hdiv : ((1000000 * q + r : ℕ) : ℝ) / 1000000 = q + r / 1000000 := by
    push_cast
    ring
  have hr0 : (0 : ℝ) ≤ r / 1000000 := by positivity
  have hr1 : (r : ℝ) / 1000000 < 1 := by
    rw [div_lt_one (by norm_num)]
    exact_mod_cast hr'
  have hfloor : ⌊((1000000 * q + r : ℕ) : ℝ) / 1000000⌋ = q := by
    rw [hdiv, Int.floor_eq_iff]
    push_cast
    constructor <;> linarith
  have hfract : Int.fract (((1000000 * q + r : ℕ) : ℝ) / 1000000) = r / 1000000 := by
    rw [← Int.self_sub_floor, hfloor, hdiv]
    push_cast
    ring
  have hlt : (r : ℝ) / 1000000 < 1 / 2 ↔ r < 500000 := by
    rw [div_lt_iff₀ (by norm_num)]
    constructor
    · intro h
      have : (r : ℝ) < 500000 := by linarith
      exact_mod_cast this
    · intro h
      have : (r : ℝ) < 500000 := by exact_mod_cast h
      linarith
  have hgt : 1 / 2 < (r : ℝ) / 1000000 ↔ 500000 < r := by
    rw [lt_div_iff₀ (by norm_num)]
    constructor
    · intro h
      have : (500000 : ℝ) < r := by linarith
      exact_mod_cast this
    · intro h
      have : (500000 : ℝ) < r := by exact_mod_cast h
      linarith
  have hev : Even (q : ℤ) ↔ q % 2 = 0 := by rw [Int.even_coe_nat, Nat.even_iff]
  unfold megabytes roundHalfEven
  rw [hq, hr, hfract, hfloor]
  split_ifs <;> (try simp only [hlt, hgt, hev] at *) <;> first
    | (push_cast; ring1)
    | omega

/-- The `+ 1` (Rust's `saturating_add`) never overflows: for a `u64` total the result is far below 2⁶⁴. -/
theorem megabytes_lt {total : ℕ} (h : total < 2 ^ 64) : megabytes total < 2 ^ 64 := by
  unfold megabytes
  split_ifs <;> omega

/-! ### Content-Length -/

/-- http.rs `content_length`'s fold over the digits' values: `n ↦ n · 10 + d`. -/
def foldDigits (ds : List ℕ) : ℕ := ds.foldl (fun n d => n * 10 + d) 0

theorem foldDigits_aux (ds : List ℕ) (hd : ∀ d ∈ ds, d < 10) (a : ℕ) :
    ds.foldl (fun n d => n * 10 + d) a = a * 10 ^ ds.length + Nat.ofDigits 10 ds.reverse := by
  induction ds generalizing a with
  | nil => simp
  | cons d ds ih =>
    rw [List.foldl_cons, ih (fun x hx => hd x (List.mem_cons_of_mem _ hx)), List.reverse_cons,
      Nat.ofDigits_append, List.length_cons, pow_succ, List.length_reverse]
    simp [Nat.ofDigits]
    ring

/-- **The value is the number the digits write.** -/
theorem foldDigits_eq (ds : List ℕ) (hd : ∀ d ∈ ds, d < 10) : foldDigits ds = Nat.ofDigits 10 ds.reverse := by
  rw [foldDigits, foldDigits_aux ds hd 0]
  simp

/-- **At most 15 digits stay below 10¹⁵**: so the fold's checked multiply-add (`u64`, up to about 1.8·10¹⁹) never
fails. -/
theorem foldDigits_lt (ds : List ℕ) (hd : ∀ d ∈ ds, d < 10) (hl : ds.length ≤ 15) : foldDigits ds < 10 ^ 15 := by
  rw [foldDigits_eq ds hd]
  calc Nat.ofDigits 10 ds.reverse < 10 ^ ds.reverse.length :=
        Nat.ofDigits_lt_base_pow_length (by norm_num) (fun x hx => hd x (List.mem_reverse.1 hx))
    _ = 10 ^ ds.length := by rw [List.length_reverse]
    _ ≤ 10 ^ 15 := Nat.pow_le_pow_right (by norm_num) hl

/-- Every intermediate value of the fold is below 10¹⁵ too (each is the fold of a prefix). -/
theorem foldDigits_prefix_lt (ds : List ℕ) (hd : ∀ d ∈ ds, d < 10) (hl : ds.length ≤ 15) (k : ℕ) :
    foldDigits (ds.take k) < 10 ^ 15 :=
  foldDigits_lt _ (fun d h => hd d (List.mem_of_mem_take h)) (by rw [List.length_take]; omega)

theorem pow15_lt_u64 : (10 : ℕ) ^ 15 * 10 + 9 < 2 ^ 64 := by norm_num

end Midstudy.Arith
