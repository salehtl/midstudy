import Midstudy.Jpeg.Model

/-!
# The JPEG frame size (contract §2.6: "the image's size must be readable from its frame header … never guessed")

`core/crates/media/src/jpeg.rs` `frame_info` (v1's `jpeg_size`; qwen renders are priced by it): walk the markers after
SOI, stepping over fill bytes and the length-less markers TEM, RST0–7 and a stray SOI, until the first start-of-frame
segment, and read its precision, height, width and components; a scan or EOI first, a cut-off segment, a length
below 2 or a zero size is an error. Modelled on the bytes after SOI exactly as the Rust loop reads them (errors by
kind); `proofs/diff/` compares it with the Rust.

* `frameInfo_ok`: **never guessed**: an answer is the fields of a start-of-frame segment that is in the data, right
  where the walk reached it, with a non-zero width and height.
-/

namespace Midstudy.Jpeg

/-- Why no size can be read (jpeg.rs `SizeError`, without offsets). -/
inductive SizeErr
  | notJpeg | expectedMarker | scanBeforeFrame | endBeforeFrame | truncated | badLength | zeroSize | noFrame
  deriving DecidableEq, Repr

/-- A frame header's fields (jpeg.rs `FrameInfo`). -/
structure Frame where
  width : Nat
  height : Nat
  components : UInt8
  precision : UInt8
  marker : UInt8
  deriving DecidableEq, Repr

/-- A start-of-frame marker: C0–CF except DHT (C4), JPG (C8) and DAC (CC). -/
def isSof (m : UInt8) : Bool := decide (0xC0 ≤ m ∧ m ≤ 0xCF) && !decide (m = 0xC4 ∨ m = 0xC8 ∨ m = 0xCC)

/-- A big-endian 16-bit number (0 when fewer than two bytes). -/
def be16 : Bytes → Nat
  | hi :: lo :: _ => hi.toNat * 256 + lo.toNat
  | _ => 0

theorem frameWalk_dec₁ {b m : UInt8} {r : Bytes} : (m :: r).length < (b :: m :: r).length := by simp
theorem frameWalk_dec₂ {b m : UInt8} {r : Bytes} : r.length < (b :: m :: r).length := by
  simp only [List.length_cons]
  omega
theorem frameWalk_dec₃ {l : Bytes} (h : ¬ l.length < 2) (n : Nat) : (l.drop (2 + n)).length < l.length := by
  rw [List.length_drop]
  omega

/-- jpeg.rs `frame_info`'s loop, on the bytes from the current marker on. -/
def frameWalk (l : Bytes) : Except SizeErr Frame :=
  if h : l.length < 2 then .error .noFrame
  else
    match l, h with
    | b :: m :: r, _ =>
      if b ≠ 0xFF then .error .expectedMarker
      else if m = 0xFF then frameWalk (m :: r)
      else if m = 0x01 ∨ m = 0xD8 ∨ isRst m = true then frameWalk r
      else if m = 0xD9 then .error .endBeforeFrame
      else if m = 0xDA then .error .scanBeforeFrame
      else if (b :: m :: r).length ≤ 9 then .error .truncated
      else if be16 r < 2 then .error .badLength
      else if isSof m = true then
        -- precision at i+4, height at i+5, width at i+7, components at i+9 (r starts at i+2)
        if be16 (r.drop 5) = 0 ∨ be16 (r.drop 3) = 0 then .error .zeroSize
        else .ok ⟨be16 (r.drop 5), be16 (r.drop 3), r.getD 7 0, r.getD 2 0, m⟩
      else frameWalk ((b :: m :: r).drop (2 + be16 r))
    | [], h => absurd h (by simp)
    | [_], h => absurd h (by simp)
termination_by l.length
decreasing_by
  · exact frameWalk_dec₁
  · exact frameWalk_dec₂
  · exact frameWalk_dec₃ (by simp) _

/-- **jpeg.rs `frame_info`** (v1's `jpeg_size`). -/
def frameInfo (data : Bytes) : Except SizeErr Frame :=
  if 4 ≤ data.length ∧ data.take 2 = soi then frameWalk (data.drop 2) else .error .notJpeg

/-- **Never guessed**: a size comes from a start-of-frame segment in the data, at a marker the walk reached:
`FF m L L p H H W W c` with `m` a start-of-frame marker, a length of at least 2, and a non-zero width and height. -/
theorem frameWalk_ok : ∀ (l : Bytes) {f : Frame}, frameWalk l = .ok f →
    ∃ k r, l.drop k = 0xFF :: f.marker :: r ∧ isSof f.marker = true ∧ 2 ≤ be16 r ∧
      f.precision = r.getD 2 0 ∧ f.height = be16 (r.drop 3) ∧ f.width = be16 (r.drop 5) ∧
      f.components = r.getD 7 0 ∧ f.width ≠ 0 ∧ f.height ≠ 0
  | [], f, h => by
    rw [frameWalk, dif_pos (by simp)] at h
    cases h
  | [_], f, h => by
    rw [frameWalk, dif_pos (by simp)] at h
    cases h
  | b :: m :: r, f, h => by
    rw [frameWalk, dif_neg (by simp)] at h
    simp only at h
    split_ifs at h with hb hm hstd hd9 hda hlen hbad hsof hz
    · -- a fill byte: the walk goes on from the next byte
      obtain ⟨k, r', hk, rest⟩ := frameWalk_ok (m :: r) h
      exact ⟨k + 1, r', by simpa using hk, rest⟩
    · -- TEM, RST or SOI: stepped over
      obtain ⟨k, r', hk, rest⟩ := frameWalk_ok r h
      exact ⟨k + 2, r', by simpa using hk, rest⟩
    · simp only [Except.ok.injEq] at h
      subst h
      simp only [not_or] at hz
      exact ⟨0, r, by simp [not_not.1 hb], hsof, by omega, rfl, rfl, rfl, rfl, hz.1, hz.2⟩
    · -- another segment: stepped over by its length
      obtain ⟨k, r', hk, rest⟩ := frameWalk_ok _ h
      exact ⟨2 + be16 r + k, r', by rw [← List.drop_drop]; exact hk, rest⟩
termination_by l => l.length
decreasing_by
  · exact frameWalk_dec₁
  · exact frameWalk_dec₂
  · exact frameWalk_dec₃ (by simp) _

theorem frameInfo_ok {data : Bytes} {f : Frame} (h : frameInfo data = .ok f) :
    ∃ k r, data.drop k = 0xFF :: f.marker :: r ∧ isSof f.marker = true ∧ 2 ≤ be16 r ∧
      f.precision = r.getD 2 0 ∧ f.height = be16 (r.drop 3) ∧ f.width = be16 (r.drop 5) ∧
      f.components = r.getD 7 0 ∧ f.width ≠ 0 ∧ f.height ≠ 0 := by
  unfold frameInfo at h
  split_ifs at h
  obtain ⟨k, r, hk, rest⟩ := frameWalk_ok _ h
  exact ⟨2 + k, r, by rw [← List.drop_drop]; exact hk, rest⟩

end Midstudy.Jpeg
