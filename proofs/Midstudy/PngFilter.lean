import Mathlib.Data.Int.Basic
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.Ring

/-!
# PNG row filters (geom LEAN.md property 25; raster `png.rs` `unfilter`, `paeth`)

The depth.png decoder (raster crate) reverses PNG's per-row filters: each byte is stored as the raw byte minus a
prediction from its left neighbour `a` (one pixel back, `bpp` bytes), the byte above `b` and the one above-left `c`,
mod 256; decoding adds the prediction back, from bytes already decoded.

* `unfilter_filter`: for every filter type (None, Sub, Up, Average, Paeth, and any predictor of `a`, `b`, `c`),
  decoding a filtered row gives the row back exactly.
* `paeth_eq_spec`: raster's `paeth` (`pa = |b − c|`, `pb = |a − c|`, `pc = |a + b − 2c|`) is the PNG spec's predictor:
  the one of `a`, `b`, `c` nearest `p = a + b − c`, ties to `a`, then `b`.
-/

namespace Midstudy.PngFilter

/-- The byte `bpp` positions back (0 before the row starts). -/
def back (r : ℕ → UInt8) (bpp i : ℕ) : UInt8 := if bpp ≤ i then r (i - bpp) else 0

/-- raster `paeth(a, b, c)`. -/
def paeth (a b c : UInt8) : UInt8 :=
  let pa := ((b.toNat : ℤ) - c.toNat).natAbs
  let pb := ((a.toNat : ℤ) - c.toNat).natAbs
  let pc := ((a.toNat : ℤ) + b.toNat - c.toNat - c.toNat).natAbs
  if pa ≤ pb ∧ pa ≤ pc then a else if pb ≤ pc then b else c

/-- The PNG spec's Paeth predictor: of `a`, `b`, `c`, the one nearest `p = a + b − c`, ties to `a`, then `b`. -/
def paethSpec (a b c : UInt8) : UInt8 :=
  let p : ℤ := (a.toNat : ℤ) + b.toNat - c.toNat
  let pa := (p - a.toNat).natAbs
  let pb := (p - b.toNat).natAbs
  let pc := (p - c.toNat).natAbs
  if pa ≤ pb ∧ pa ≤ pc then a else if pb ≤ pc then b else c

theorem paeth_eq_spec (a b c : UInt8) : paeth a b c = paethSpec a b c := by
  unfold paeth paethSpec
  have e1 : ((a.toNat : ℤ) + b.toNat - c.toNat - a.toNat) = (b.toNat : ℤ) - c.toNat := by ring
  have e2 : ((a.toNat : ℤ) + b.toNat - c.toNat - b.toNat) = (a.toNat : ℤ) - c.toNat := by ring
  simp only [e1, e2]

/-- The five predictors (raster `unfilter`'s cases; Average is `⌊(a + b)/2⌋`, u8 `midpoint`). -/
def predict : ℕ → UInt8 → UInt8 → UInt8 → UInt8
  | 1, a, _, _ => a
  | 2, _, b, _ => b
  | 3, a, b, _ => ((a.toNat + b.toNat) / 2).toUInt8
  | 4, a, b, c => paeth a b c
  | _, _, _, _ => 0

/-- Filtering a row (the encoder): raw byte minus the prediction from raw bytes, mod 256. -/
def filter (pred : UInt8 → UInt8 → UInt8 → UInt8) (bpp : ℕ) (raw prev : ℕ → UInt8) (i : ℕ) : UInt8 :=
  raw i - pred (back raw bpp i) (prev i) (back prev bpp i)

/-- Unfiltering a row (the decoder, left to right): stored byte plus the prediction from bytes already decoded. -/
def unfilter (pred : UInt8 → UInt8 → UInt8 → UInt8) (bpp : ℕ) (stored prev : ℕ → UInt8) : ℕ → UInt8
  | i => stored i + pred (if _h : bpp ≤ i ∧ 0 < bpp then unfilter pred bpp stored prev (i - bpp) else 0)
      (prev i) (back prev bpp i)
termination_by i => i
decreasing_by omega

/-- **Decoding a filtered row gives it back**, for every predictor (so for all five filter types) and every pixel
width `bpp ≥ 1`. -/
theorem unfilter_filter (pred : UInt8 → UInt8 → UInt8 → UInt8) {bpp : ℕ} (hbpp : 0 < bpp) (raw prev : ℕ → UInt8) :
    ∀ i, unfilter pred bpp (filter pred bpp raw prev) prev i = raw i := by
  intro i
  induction i using Nat.strong_induction_on with
  | _ i ih =>
    rw [unfilter]
    have hb : (if _h : bpp ≤ i ∧ 0 < bpp then unfilter pred bpp (filter pred bpp raw prev) prev (i - bpp) else 0) =
        back raw bpp i := by
      unfold back
      by_cases h : bpp ≤ i
      · rw [dif_pos ⟨h, hbpp⟩, if_pos h, ih _ (by omega)]
      · rw [dif_neg (fun h' => h h'.1), if_neg h]
    rw [hb, filter, UInt8.sub_add_cancel]

theorem unfilter_filter_types (t : ℕ) {bpp : ℕ} (hbpp : 0 < bpp) (raw prev : ℕ → UInt8) (i : ℕ) :
    unfilter (predict t) bpp (filter (predict t) bpp raw prev) prev i = raw i :=
  unfilter_filter (predict t) hbpp raw prev i

end Midstudy.PngFilter
