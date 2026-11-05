import Mathlib.Data.List.Basic
import Mathlib.Tactic

/-!
# What a file is, from its first bytes (k-media AENEAS.md target #8; contract §4.3 Ingest, §4.4 Upload, §2.8 Bodies)

An executable model of `core/crates/media/src/sniff.rs` (`sniff`, `heif`, `Kind::photo_ext`), which the v2 server
and CLI use for "recognized by their bytes, not the name", and a transcription of the v1 rule it replaces everywhere:
calib's `sniff` (`calib/src/midstudy_calib/ingest.py`, called as `sniff(data[:64])`), with Python's slicing, `range`
and set tests.

* `photoExt_sniff`: **v2's sniff is v1's ingest decision table**, for every input: the photo type that `photo_ext` of
  `sniff` accepts is exactly what calib's `sniff(data[:64])` returns: `jpg` (`FF D8 FF`), `png` (the signature),
  `webp` (`RIFF` … `WEBP`), `heic` (an `ftyp` box with an HEVC major brand, or a generic HEIF one whose compatible
  brands, within the box and the 64 bytes, aren't AVIF-only), or nothing (AVIF, GLB, zip, anything else).
* `sniff_take`: only the first 64 bytes count.
* `sniff_jpeg_iff`, `sniff_png_iff`, `sniff_heic_iff`, `sniff_glb`, `sniff_zip`: the rows of the table, including
  the server's two other kinds.

`proofs/diff/` runs this model (`mediastrip sniff`) against the Rust and against calib's own Python function.
-/

namespace Midstudy.Sniff

/-- Bytes. -/
abbrev Bytes := List UInt8

/-- What `sniff` recognises (sniff.rs `Kind`). -/
inductive Kind
  | jpeg | png | heic | heif | webp | glb | zip | unknown
  deriving DecidableEq, Repr

/-- sniff.rs `HEAD_LEN`: the bytes looked at. -/
def HEAD_LEN : ℕ := 64

/-- `89 P N G \r \n 1A \n`. -/
def PNG_SIGNATURE : Bytes := [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
/-- `RIFF`, `WEBP`, `ftyp`, `glTF`, `PK 03 04`, `PK 05 06`. -/
def RIFF : Bytes := [0x52, 0x49, 0x46, 0x46]
def WEBP : Bytes := [0x57, 0x45, 0x42, 0x50]
def FTYP : Bytes := [0x66, 0x74, 0x79, 0x70]
def GLTF : Bytes := [0x67, 0x6C, 0x54, 0x46]
def PK34 : Bytes := [0x50, 0x4B, 0x03, 0x04]
def PK56 : Bytes := [0x50, 0x4B, 0x05, 0x06]

/-- `heic heix hevc hevx heim heis hevm hevs` (calib's `HEIF_BRANDS`). -/
def HEVC_BRANDS : List Bytes :=
  [[0x68, 0x65, 0x69, 0x63], [0x68, 0x65, 0x69, 0x78], [0x68, 0x65, 0x76, 0x63], [0x68, 0x65, 0x76, 0x78],
    [0x68, 0x65, 0x69, 0x6D], [0x68, 0x65, 0x69, 0x73], [0x68, 0x65, 0x76, 0x6D], [0x68, 0x65, 0x76, 0x73]]
/-- `mif1 msf1 mif2 miaf` (calib's `GENERIC_HEIF_BRANDS`). -/
def GENERIC_BRANDS : List Bytes :=
  [[0x6D, 0x69, 0x66, 0x31], [0x6D, 0x73, 0x66, 0x31], [0x6D, 0x69, 0x66, 0x32], [0x6D, 0x69, 0x61, 0x66]]
/-- `avif avis`. -/
def AVIF_BRANDS : List Bytes := [[0x61, 0x76, 0x69, 0x66], [0x61, 0x76, 0x69, 0x73]]

/-- `l.starts_with(p)`. -/
def startsWith (l p : Bytes) : Prop := l.take p.length = p

instance (l p : Bytes) : Decidable (startsWith l p) := inferInstanceAs (Decidable (_ = _))

/-- sniff.rs `tag_at`: `head.get(at..)` has a first chunk of 4 bytes, equal to `tag`. -/
def tagAt (head : Bytes) (pos : ℕ) (tag : Bytes) : Prop := (head.drop pos).take 4 = tag

instance (head : Bytes) (pos : ℕ) (tag : Bytes) : Decidable (tagAt head pos tag) :=
  inferInstanceAs (Decidable (_ = _))

/-- bytes.rs `be32` at 0. -/
def be32 : Bytes → Option ℕ
  | a :: b :: c :: d :: _ => some (((a.toNat * 256 + b.toNat) * 256 + c.toNat) * 256 + d.toNat)
  | _ => none

/-- `chunks_exact(4)` (each chunk's `first_chunk::<4>` is itself). -/
def chunks4 : Bytes → List Bytes
  | a :: b :: c :: d :: rest => [a, b, c, d] :: chunks4 rest
  | _ => []

/-- **sniff.rs `heif`**: the major brand, then for a generic one the compatible brands in
`head.get(16..min(size, len)).unwrap_or_default()`. -/
def heif (head : Bytes) : Option Kind :=
  let major := (head.drop 8).take 4
  if major.length < 4 then none
  else if major ∈ HEVC_BRANDS then some .heic
  else if major ∉ GENERIC_BRANDS then none
  else
    match be32 head with
    | none => none
    | some size =>
      let limit := min size head.length
      let brands := chunks4 (if 16 ≤ limit then (head.take limit).drop 16 else [])
      if brands.any (· ∈ AVIF_BRANDS) ∧ ¬ brands.any (· ∈ HEVC_BRANDS) then none else some .heif

/-- sniff.rs `sniff` after `let head = data.get(..HEAD_LEN).unwrap_or(data)`: the first rule that matches. -/
def sniffHead (head : Bytes) : Kind :=
  if startsWith head [0xFF, 0xD8, 0xFF] then .jpeg
  else if startsWith head PNG_SIGNATURE then .png
  else if startsWith head RIFF ∧ tagAt head 8 WEBP then .webp
  else if tagAt head 4 FTYP ∧ 12 ≤ head.length ∧ (heif head).isSome then (heif head).getD .unknown
  else if startsWith head GLTF then .glb
  else if startsWith head PK34 ∨ startsWith head PK56 then .zip
  else .unknown

/-- **sniff.rs `sniff`**: the file type from its first `HEAD_LEN` bytes. -/
def sniff (data : Bytes) : Kind := sniffHead (data.take HEAD_LEN)

/-- sniff.rs `Kind::photo_ext`: the extension v1 records for an accepted photo. -/
def photoExt : Kind → Option String
  | .jpeg => some "jpg"
  | .png => some "png"
  | .heic | .heif => some "heic"
  | .webp => some "webp"
  | .glb | .zip | .unknown => none

/-- sniff.rs `Kind::name`. -/
def Kind.name : Kind → String
  | .jpeg => "jpeg" | .png => "png" | .heic => "heic" | .heif => "heif" | .webp => "webp" | .glb => "glb"
  | .zip => "zip" | .unknown => "unknown"

/-! ## v1: calib's `sniff` -/

/-- Python's `range(start, stop, step)` for a positive step (a negative `stop` is an empty range either way, as
`start ≥ 0`, so truncated subtraction in `stop` changes nothing). -/
def pyRange (start stop step : ℕ) : List ℕ :=
  if start < stop ∧ 0 < step then start :: pyRange (start + step) stop step else []
termination_by stop - start
decreasing_by omega

/-- Python's `int.from_bytes(b, "big")`. -/
def fromBytesBig (b : Bytes) : ℕ := b.foldl (fun n x => n * 256 + x.toNat) 0

/-- **calib's `sniff(head)`** (ingest.py), with `head = data[:64]`:

```python
if head[:3] == b"\xff\xd8\xff": return "jpg"
if head[:8] == b"\x89PNG\r\n\x1a\n": return "png"
if head[:4] == b"RIFF" and head[8:12] == b"WEBP": return "webp"
if head[4:8] == b"ftyp" and len(head) >= 12:
    size = int.from_bytes(head[:4], "big")
    major = head[8:12]
    compat = {head[i:i + 4] for i in range(16, min(size, len(head)) - 3, 4)}
    if major in HEIF_BRANDS: return "heic"
    if major in GENERIC_HEIF_BRANDS and not (compat & AVIF_BRANDS and not compat & HEIF_BRANDS): return "heic"
return None
``` -/
def calibSniff (head : Bytes) : Option String :=
  if head.take 3 = [0xFF, 0xD8, 0xFF] then some "jpg"
  else if head.take 8 = PNG_SIGNATURE then some "png"
  else if head.take 4 = RIFF ∧ (head.drop 8).take 4 = WEBP then some "webp"
  else if (head.drop 4).take 4 = FTYP ∧ 12 ≤ head.length then
    let size := fromBytesBig (head.take 4)
    let major := (head.drop 8).take 4
    let compat := (pyRange 16 (min size head.length - 3) 4).map (fun i => (head.drop i).take 4)
    if major ∈ HEVC_BRANDS then some "heic"
    else if major ∈ GENERIC_BRANDS ∧ ¬ (compat.any (· ∈ AVIF_BRANDS) ∧ ¬ compat.any (· ∈ HEVC_BRANDS)) then
      some "heic"
    else none
  else none

/-! ## Proofs -/

theorem pyRange_eq (start stop step : ℕ) :
    pyRange start stop step =
      if start < stop ∧ 0 < step then start :: pyRange (start + step) stop step else [] := by
  rw [pyRange]

/-- The compatible brands: Rust's `chunks_exact(4)` of `head[16..limit]` are Python's `head[i:i+4]` for
`i in range(16, limit - 3, 4)`. -/
theorem chunks4_eq (l : Bytes) (n : ℕ) (hn : n ≤ l.length) :
    ∀ i, chunks4 ((l.take n).drop i) = (pyRange i (n - 3) 4).map (fun j => (l.drop j).take 4) := by
  intro i
  induction h : n - i using Nat.strong_induction_on generalizing i with
  | _ k ih =>
    rw [pyRange_eq]
    by_cases hi : i + 4 ≤ n
    · have hlt : i < n - 3 ∧ 0 < 4 := ⟨by omega, by norm_num⟩
      rw [if_pos hlt, List.map_cons]
      have hlen : ((l.take n).drop i).length = n - i := by
        simp only [List.length_drop, List.length_take]
        omega
      obtain ⟨a, b, c, d, rest, hx⟩ : ∃ a b c d rest, (l.take n).drop i = a :: b :: c :: d :: rest := by
        match hx : (l.take n).drop i with
        | a :: b :: c :: d :: rest => exact ⟨a, b, c, d, rest, rfl⟩
        | [] | [_] | [_, _] | [_, _, _] => rw [hx] at hlen; simp at hlen; omega
      rw [hx, chunks4]
      have h4 : [a, b, c, d] = (l.drop i).take 4 := by
        have : ((l.take n).drop i).take 4 = (l.drop i).take 4 := by
          rw [List.drop_take, List.take_take]
          congr 1
          omega
        rw [← this, hx]
        rfl
      have hrest : rest = (l.take n).drop (i + 4) := by
        rw [← List.drop_drop, hx]
        rfl
      rw [h4, hrest, ih (n - (i + 4)) (by omega) (i + 4) rfl]
    · have hlt : ¬ (i < n - 3 ∧ 0 < 4) := by omega
      rw [if_neg hlt, List.map_nil]
      have hlen : ((l.take n).drop i).length < 4 := by
        simp only [List.length_drop, List.length_take]
        omega
      match hx : (l.take n).drop i with
      | a :: b :: c :: d :: rest => rw [hx] at hlen; simp at hlen; omega
      | [] => rfl
      | [_] => rfl
      | [_, _] => rfl
      | [_, _, _] => rfl

theorem be32_eq {head : Bytes} (h : 4 ≤ head.length) : be32 head = some (fromBytesBig (head.take 4)) := by
  match head, h with
  | a :: b :: c :: d :: _, _ => simp [be32, fromBytesBig]

/-- Under `12 ≤ len`, `heif` decides on the brands as calib does. -/
theorem heif_spec {head : Bytes} (h12 : 12 ≤ head.length) :
    heif head =
      let size := fromBytesBig (head.take 4)
      let major := (head.drop 8).take 4
      let compat := (pyRange 16 (min size head.length - 3) 4).map (fun i => (head.drop i).take 4)
      if major ∈ HEVC_BRANDS then some .heic
      else if major ∈ GENERIC_BRANDS ∧ ¬ (compat.any (· ∈ AVIF_BRANDS) ∧ ¬ compat.any (· ∈ HEVC_BRANDS)) then
        some .heif
      else none := by
  have hmaj : ((head.drop 8).take 4).length = 4 := by
    simp only [List.length_take, List.length_drop]
    omega
  have hcompat : chunks4 (if 16 ≤ min (fromBytesBig (head.take 4)) head.length then
        (head.take (min (fromBytesBig (head.take 4)) head.length)).drop 16 else []) =
      (pyRange 16 (min (fromBytesBig (head.take 4)) head.length - 3) 4).map (fun i => (head.drop i).take 4) := by
    split_ifs with h16
    · exact chunks4_eq head _ (min_le_right _ _) 16
    · rw [pyRange_eq, if_neg (by omega)]
      rfl
  simp only [heif, hmaj, lt_irrefl, if_false, be32_eq (show 4 ≤ head.length by omega), hcompat]
  by_cases hh : (head.drop 8).take 4 ∈ HEVC_BRANDS
  · simp [hh]
  · by_cases hg : (head.drop 8).take 4 ∈ GENERIC_BRANDS
    · simp only [hh, hg, if_false, not_true_eq_false, true_and, ite_not]
    · simp [hh, hg]

/-- The rules after the photo types give no photo type. -/
theorem photoExt_tail (head : Bytes) :
    photoExt (if startsWith head GLTF then Kind.glb else if startsWith head PK34 ∨ startsWith head PK56 then .zip
      else .unknown) = none := by
  split_ifs <;> rfl

/-- On any head: `photo_ext` of Rust's rules is calib's table. -/
theorem photoExt_sniffHead (head : Bytes) : photoExt (sniffHead head) = calibSniff head := by
  unfold sniffHead calibSniff
  by_cases hj : head.take 3 = [0xFF, 0xD8, 0xFF]
  · rw [if_pos (show startsWith head [0xFF, 0xD8, 0xFF] from hj), if_pos hj]
    rfl
  rw [if_neg (show ¬ startsWith head [0xFF, 0xD8, 0xFF] from hj), if_neg hj]
  by_cases hp : head.take 8 = PNG_SIGNATURE
  · rw [if_pos (show startsWith head PNG_SIGNATURE from hp), if_pos hp]
    rfl
  rw [if_neg (show ¬ startsWith head PNG_SIGNATURE from hp), if_neg hp]
  by_cases hw : head.take 4 = RIFF ∧ (head.drop 8).take 4 = WEBP
  · rw [if_pos (show startsWith head RIFF ∧ tagAt head 8 WEBP from hw), if_pos hw]
    rfl
  rw [if_neg (show ¬ (startsWith head RIFF ∧ tagAt head 8 WEBP) from hw), if_neg hw]
  by_cases hF : (head.drop 4).take 4 = FTYP ∧ 12 ≤ head.length
  · rw [if_pos hF]
    have hh := heif_spec hF.2
    simp only at hh ⊢
    by_cases hv : (head.drop 8).take 4 ∈ HEVC_BRANDS
    · rw [if_pos hv] at hh ⊢
      rw [hh, if_pos ⟨hF.1, hF.2, rfl⟩]
      rfl
    · rw [if_neg hv] at hh ⊢
      by_cases hg : (head.drop 8).take 4 ∈ GENERIC_BRANDS ∧
          ¬ (((pyRange 16 (min (fromBytesBig (head.take 4)) head.length - 3) 4).map
              (fun i => (head.drop i).take 4)).any (· ∈ AVIF_BRANDS) ∧
            ¬ ((pyRange 16 (min (fromBytesBig (head.take 4)) head.length - 3) 4).map
              (fun i => (head.drop i).take 4)).any (· ∈ HEVC_BRANDS))
      · rw [if_pos hg] at hh ⊢
        rw [hh, if_pos ⟨hF.1, hF.2, rfl⟩]
        rfl
      · rw [if_neg hg] at hh ⊢
        rw [hh, if_neg (by simp)]
        exact photoExt_tail head
  · rw [if_neg hF, if_neg (show ¬ (tagAt head 4 FTYP ∧ 12 ≤ head.length ∧ _) from fun h => hF ⟨h.1, h.2.1⟩)]
    exact photoExt_tail head

/-- **v2's sniff is v1's ingest decision table**: `photo_ext (sniff data)` is calib's `sniff(data[:64])`, for
every input. -/
theorem photoExt_sniff (data : Bytes) : photoExt (sniff data) = calibSniff (data.take 64) :=
  photoExt_sniffHead _

/-- Only the first 64 bytes count. -/
theorem sniff_take (data : Bytes) : sniff data = sniff (data.take 64) := by
  simp only [sniff, HEAD_LEN, List.take_take, min_self]

theorem heif_ne {head : Bytes} {k : Kind} (h : heif head = some k) : k = .heic ∨ k = .heif := by
  dsimp only [heif] at h
  repeat' (first | split_ifs at h | split at h)
  all_goals simp only [Option.some.injEq, reduceCtorEq] at h
  all_goals (subst h; simp)

/-- The `ftyp` rule gives HEIC or HEIF only. -/
theorem getD_heif {head : Bytes} (h : (heif head).isSome) : (heif head).getD .unknown = .heic ∨
    (heif head).getD .unknown = .heif := by
  obtain ⟨k, hk⟩ := Option.isSome_iff_exists.1 h
  rw [hk]
  exact heif_ne hk

/-- **JPEG** is exactly `FF D8 FF` first. -/
theorem sniff_jpeg_iff (data : Bytes) : sniff data = .jpeg ↔ data.take 3 = [0xFF, 0xD8, 0xFF] := by
  have h3 : (data.take 64).take 3 = data.take 3 := by rw [List.take_take]; rfl
  unfold sniff sniffHead HEAD_LEN
  by_cases hj : data.take 3 = [0xFF, 0xD8, 0xFF]
  · rw [if_pos (show startsWith (data.take 64) [0xFF, 0xD8, 0xFF] by
      show (data.take 64).take 3 = _; rw [h3]; exact hj)]
    simp [hj]
  · rw [if_neg (show ¬ startsWith (data.take 64) [0xFF, 0xD8, 0xFF] by
      show ¬ (data.take 64).take 3 = _; rw [h3]; exact hj)]
    simp only [hj, iff_false]
    split_ifs with h1 h2 h3 h4 h5 <;> try simp
    rcases getD_heif h3.2.2 with h | h <;> rw [h] <;> simp

/-- **PNG** is exactly the 8-byte signature first. -/
theorem sniff_png_iff (data : Bytes) : sniff data = .png ↔ data.take 8 = PNG_SIGNATURE := by
  have h8 : (data.take 64).take 8 = data.take 8 := by rw [List.take_take]; rfl
  unfold sniff sniffHead HEAD_LEN
  have hnj : data.take 8 = PNG_SIGNATURE → ¬ startsWith (data.take 64) [0xFF, 0xD8, 0xFF] := by
    intro hp hj
    have : (data.take 8).take 3 = (data.take 64).take 3 := by rw [List.take_take, List.take_take]; rfl
    unfold startsWith at hj
    rw [hp] at this
    rw [show ([0xFF, 0xD8, 0xFF] : Bytes).length = 3 from rfl, ← this] at hj
    simp [PNG_SIGNATURE] at hj
  by_cases hp : data.take 8 = PNG_SIGNATURE
  · rw [if_neg (hnj hp), if_pos (show startsWith (data.take 64) PNG_SIGNATURE by
      unfold startsWith; rw [show PNG_SIGNATURE.length = 8 from rfl, h8, hp])]
    simp [hp]
  · rw [if_neg (show ¬ startsWith (data.take 64) PNG_SIGNATURE by
      unfold startsWith; rw [show PNG_SIGNATURE.length = 8 from rfl, h8]; exact hp)]
    simp only [hp, iff_false]
    split_ifs with h1 h2 h3 h4 h5 <;> try simp
    rcases getD_heif h3.2.2 with h | h <;> rw [h] <;> simp

/-- **HEIC or HEIF** only from an `ftyp` box at 4 whose major brand is an HEVC or a generic HEIF brand. -/
theorem sniff_heif {data : Bytes} (h : sniff data = .heic ∨ sniff data = .heif) :
    tagAt (data.take 64) 4 FTYP ∧ 12 ≤ (data.take 64).length ∧
      ((data.take 64).drop 8).take 4 ∈ HEVC_BRANDS ++ GENERIC_BRANDS := by
  unfold sniff sniffHead HEAD_LEN at h
  split_ifs at h with h1 h2 h3 h4 h5 <;> simp_all
  obtain ⟨k, hk⟩ := Option.isSome_iff_exists.1 h4.2.2
  dsimp only [heif] at hk
  split_ifs at hk with g1 g2 g3 <;> simp_all

/-- **GLB** and **zip** by their magic bytes. -/
theorem sniff_glb {data : Bytes} (h : sniff data = .glb) : startsWith (data.take 64) GLTF := by
  unfold sniff sniffHead HEAD_LEN at h
  split_ifs at h with h1 h2 h3 h4 h5 <;> simp_all
  rcases getD_heif h4.2.2 with g | g <;> simp_all

theorem sniff_zip {data : Bytes} (h : sniff data = .zip) :
    startsWith (data.take 64) PK34 ∨ startsWith (data.take 64) PK56 := by
  unfold sniff sniffHead HEAD_LEN at h
  split_ifs at h with h1 h2 h3 h4 h5 h6 <;> simp_all
  rcases getD_heif h4.2.2 with g | g <;> simp_all

end Midstudy.Sniff
