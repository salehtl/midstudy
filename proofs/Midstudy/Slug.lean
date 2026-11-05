import Mathlib.Data.List.Basic
import Mathlib.Tactic.Linarith

/-!
# Slugs (CLAUDE.md: "Ids, layout and scene names are slugs: `^[a-z0-9][a-z0-9-]{0,63}$`"; contract §2.7; k-media
AENEAS.md target #6)

`midstudy_media::slug::is_slug`, v1's `SLUG` regex with `\Z` (no trailing newline), on the string's UTF-8 bytes. Every
id, layout and scene name passes through it, and the server joins them under its folders.

* `isSlug_iff`: the byte loop is exactly the regex `^[a-z0-9][a-z0-9-]{0,63}$` over the whole string.
* `isSlug_ascii`: a slug is pure ASCII (so its bytes are its characters).
* `isSlug_safe`: a slug has no `/`, `\`, `.`, NUL, newline or space, and isn't `.` or `..`: joined under a folder it is
  one path component inside that folder. No trailing newline (§2.7).

`proofs/diff/` also runs this model against the Rust on 20,000 generated strings.
-/

namespace Midstudy.Slug

/-- `[a-z0-9]`. -/
def headByte (b : UInt8) : Bool := decide (0x61 ≤ b ∧ b ≤ 0x7A) || decide (0x30 ≤ b ∧ b ≤ 0x39)

/-- `[a-z0-9-]`. -/
def tailByte (b : UInt8) : Bool := headByte b || decide (b = 0x2D)

/-- slug.rs `is_slug`, on the string's bytes. -/
def isSlug : List UInt8 → Bool
  | [] => false
  | f :: r => decide ((f :: r).length ≤ 64) && headByte f && r.all tailByte

/-- **The regex `^[a-z0-9][a-z0-9-]{0,63}$`**, whole string. -/
theorem isSlug_iff (s : List UInt8) :
    isSlug s = true ↔ ∃ f r, s = f :: r ∧ r.length ≤ 63 ∧ headByte f = true ∧ ∀ c ∈ r, tailByte c = true := by
  cases s with
  | nil => simp [isSlug]
  | cons f r =>
    simp only [isSlug, Bool.and_eq_true, decide_eq_true_eq, List.all_eq_true, List.length_cons, List.cons.injEq]
    constructor
    · rintro ⟨⟨hl, hf⟩, hr⟩
      exact ⟨f, r, ⟨rfl, rfl⟩, by omega, hf, hr⟩
    · rintro ⟨f', r', ⟨rfl, rfl⟩, hl, hf, hr⟩
      exact ⟨⟨by omega, hf⟩, hr⟩

theorem headByte_lt {b : UInt8} (h : headByte b = true) : b.toNat < 128 := by
  unfold headByte at h
  simp only [Bool.or_eq_true, decide_eq_true_eq, UInt8.le_iff_toNat_le] at h
  simp at h
  omega

theorem tailByte_lt {b : UInt8} (h : tailByte b = true) : b.toNat < 128 := by
  unfold tailByte at h
  simp only [Bool.or_eq_true, decide_eq_true_eq] at h
  rcases h with h | rfl
  · exact headByte_lt h
  · decide

/-- **A slug is pure ASCII.** -/
theorem isSlug_ascii {s : List UInt8} (h : isSlug s = true) : ∀ b ∈ s, b.toNat < 128 := by
  obtain ⟨f, r, rfl, -, hf, hr⟩ := (isSlug_iff s).1 h
  intro b hb
  rcases List.mem_cons.1 hb with rfl | hb
  · exact headByte_lt hf
  · exact tailByte_lt (hr b hb)

theorem tailByte_ne {b : UInt8} (h : tailByte b = true) :
    b ≠ 0x2F ∧ b ≠ 0x5C ∧ b ≠ 0x2E ∧ b ≠ 0x00 ∧ b ≠ 0x0A ∧ b ≠ 0x20 := by
  unfold tailByte headByte at h
  simp only [Bool.or_eq_true, decide_eq_true_eq] at h
  refine ⟨?_, ?_, ?_, ?_, ?_, ?_⟩ <;> rintro rfl <;> revert h <;> decide

/-- **A slug is one safe path component**: no `/`, `\`, `.`, NUL, newline (none trailing either) or space, so not
`.` or `..` either. -/
theorem isSlug_safe {s : List UInt8} (h : isSlug s = true) :
    (∀ b ∈ s, b ≠ 0x2F ∧ b ≠ 0x5C ∧ b ≠ 0x2E ∧ b ≠ 0x00 ∧ b ≠ 0x0A ∧ b ≠ 0x20) ∧ s ≠ [0x2E] ∧ s ≠ [0x2E, 0x2E] := by
  obtain ⟨f, r, rfl, -, hf, hr⟩ := (isSlug_iff s).1 h
  have hall : ∀ b ∈ f :: r, b ≠ 0x2F ∧ b ≠ 0x5C ∧ b ≠ 0x2E ∧ b ≠ 0x00 ∧ b ≠ 0x0A ∧ b ≠ 0x20 := by
    intro b hb
    rcases List.mem_cons.1 hb with rfl | hb
    · exact tailByte_ne (by simp [tailByte, hf])
    · exact tailByte_ne (hr b hb)
  refine ⟨hall, ?_, ?_⟩
  · intro h'
    exact (hall 0x2E (by rw [h']; simp)).2.2.1 rfl
  · intro h'
    exact (hall 0x2E (by rw [h']; simp)).2.2.1 rfl

/-- At most 64 bytes, at least one. -/
theorem isSlug_length {s : List UInt8} (h : isSlug s = true) : 1 ≤ s.length ∧ s.length ≤ 64 := by
  obtain ⟨f, r, rfl, hl, -, -⟩ := (isSlug_iff s).1 h
  simp
  omega

end Midstudy.Slug
