import Mathlib.Data.List.Basic
import Mathlib.Tactic.Linarith
import Mathlib.Algebra.BigOperators.Group.List.Basic

/-!
# GLB layout arithmetic (k-media AENEAS.md target #1; `core/crates/media/src/glb.rs` `split_freed`, `pad4`)

When a GLB's embedded image shrinks (its metadata stripped), the compact layout removes whole 16-byte blocks of the
freed space and keeps the rest as zero padding, so every later bufferView keeps its offset mod 16 (glTF requires
4-byte alignment for accessors, and 16 keeps any matrix or SIMD-friendly alignment the file had). Chunks are padded
to 4 bytes.

* `split_freed_spec`: the compact split is `pad < 16`, `removed % 16 = 0`, `pad + removed = freed`.
* `pad4_spec`: `pad4 n < 4` and `(n + pad4 n) % 4 = 0`, for `pad4 n = (−n) & 3` on a 64-bit `usize`.
* `shift_mod16`: the shift of a later view (the sum of the removals before it) is a multiple of 16, so its offset
  keeps its value mod 16.
-/

namespace Midstudy.Glb

/-- glb.rs `ALIGN`. -/
def ALIGN : ℕ := 16

/-- glb.rs `split_freed(freed, Compact)`: `(freed & 15, freed − (freed & 15))`. -/
def splitFreed (freed : ℕ) : ℕ × ℕ := (freed &&& (ALIGN - 1), freed - (freed &&& (ALIGN - 1)))

theorem and15 (n : ℕ) : n &&& (ALIGN - 1) = n % 16 := by
  rw [show ALIGN - 1 = 2 ^ 4 - 1 by rfl, Nat.and_two_pow_sub_one_eq_mod]

/-- **The compact split**: less than 16 bytes of padding, whole 16-byte blocks removed, nothing lost. -/
theorem split_freed_spec (freed : ℕ) :
    (splitFreed freed).1 < 16 ∧ (splitFreed freed).2 % 16 = 0 ∧ (splitFreed freed).1 + (splitFreed freed).2 = freed := by
  simp only [splitFreed, and15]
  refine ⟨Nat.mod_lt _ (by norm_num), ?_, ?_⟩
  · have := Nat.mod_add_div freed 16
    omega
  · have := Nat.mod_le freed 16
    omega

/-- glb.rs `pad4(len)`: `len.wrapping_neg() & 3` on a 64-bit `usize`. -/
def pad4 (len : UInt64) : UInt64 := (0 - len) &&& 3

/-- **Padding to 4 bytes**: less than 4, and the padded length is a multiple of 4 (for every 64-bit length). -/
theorem pad4_spec (len : UInt64) : (pad4 len).toNat < 4 ∧ (len.toNat + (pad4 len).toNat) % 4 = 0 := by
  have h3 : (3 : UInt64).toNat = 2 ^ 2 - 1 := rfl
  have hsub : (0 - len).toNat = (2 ^ 64 - len.toNat) % 2 ^ 64 := by
    rw [UInt64.toNat_sub]
    simp
  have hlt := len.toNat_lt
  simp only [pad4, UInt64.toNat_and, h3, Nat.and_two_pow_sub_one_eq_mod, hsub]
  constructor
  · exact Nat.mod_lt _ (by norm_num)
  · omega

/-- **Later views keep their offset mod 16**: a view's shift is the sum of the blocks removed before it, each a
multiple of 16. -/
theorem shift_mod16 (freed : List ℕ) (offset : ℕ) (h : offset ≥ (freed.map fun f => (splitFreed f).2).sum) :
    (offset - (freed.map fun f => (splitFreed f).2).sum) % 16 = offset % 16 := by
  have hdvd : 16 ∣ (freed.map fun f => (splitFreed f).2).sum := by
    induction freed with
    | nil => simp
    | cons f l ih =>
      rw [List.map_cons, List.sum_cons]
      exact Nat.dvd_add (Nat.dvd_of_mod_eq_zero (split_freed_spec f).2.1) (ih (by
        rw [List.map_cons, List.sum_cons] at h
        omega))
  obtain ⟨k, hk⟩ := hdvd
  rw [hk] at h ⊢
  omega

end Midstudy.Glb
