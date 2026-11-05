import Mathlib.Data.List.Basic
import Mathlib.Tactic.Linarith
import Mathlib.Tactic.Ring

/-!
# A model of JPEG segments and of the metadata stripper (contract §2.6, §2.8, §4.3)

An executable model of `core/crates/media/src/jpeg.rs` (`step`, `scan_end`, `plain_jfif`, `strip`, `is_clean`), which
is itself v1's `clean_jpeg` (planner/serve.py) and `is_clean_jpeg` (calib ingest). It works on the bytes after SOI as
a list, one marker at a time, exactly as the Rust loop does with offsets:

* `dropFF`: the `FF` bytes at a marker (all but the last are fill bytes, dropped);
* `ecsSplit`: the entropy-coded data after a scan header, up to the next `FF` that is neither a stuffed `FF 00` nor a
  restart marker `FF D0`–`FF D7` (Rust `scan_end`);
* `step`: one marker (EOI, a length-less marker TEM/RST0–7, a segment, or a scan with its data);
* `walk`: the items up to EOI and the bytes after it;
* `strip`: SOI, then every item but APP1–APP15 and COM, APP0 kept only as a plain 16-byte JFIF header, then EOI;
* `isClean`: the pass-through predicate.

Errors are modelled by kind (the Rust adds byte offsets). `Midstudy.Jpeg.Proofs` proves the stripper's properties;
`JpegMain.lean` makes the model a program (`lake exe jpegstrip`) that is compared with the Rust on a corpus.
-/

namespace Midstudy.Jpeg

/-- Bytes. -/
abbrev Bytes := List UInt8

/-- Why a JPEG is refused (jpeg.rs `JpegError`, without the offsets). -/
inductive Err
  | notJpeg | expectedMarker | badMarker | badLength | truncated | noEndOfImage
  deriving DecidableEq, Repr

/-- RST0–RST7. -/
def isRst (m : UInt8) : Bool := decide (0xD0 ≤ m ∧ m ≤ 0xD7)

/-- Markers without a length: RST0–7 and TEM. -/
def standalone (m : UInt8) : Bool := isRst m || decide (m = 0x01)

/-- APP1–APP15 and COM: always metadata. -/
def isMetadata (m : UInt8) : Bool := decide (0xE1 ≤ m ∧ m ≤ 0xEF) || decide (m = 0xFE)

/-- One item of a JPEG after SOI. `body` and `hdr` are a segment's two length bytes and its payload (Rust
`data[start..end]`); `ecs` is a scan's entropy-coded data, stuffed bytes and restart markers included. -/
inductive Item
  | eoi
  | std (m : UInt8)
  | seg (m : UInt8) (body : Bytes)
  | scan (hdr : Bytes) (ecs : Bytes)
  deriving DecidableEq, Repr

/-- The number of `FF` bytes in front, and the rest. -/
def dropFF : Bytes → Nat × Bytes
  | [] => (0, [])
  | b :: t => if b = 0xFF then ((dropFF t).1 + 1, (dropFF t).2) else (0, b :: t)

/-- The entropy-coded data at the front, and the rest from the `FF` of the next marker (an `FF` followed by neither
`00` nor RST0–7); `none` when the data ends first (Rust `scan_end`: truncated). -/
def ecsSplit : Bytes → Option (Bytes × Bytes)
  | [] => none
  | b :: t =>
    if b = 0xFF then
      match t with
      | [] => none
      | c :: t' =>
        if c = 0x00 ∨ isRst c = true then (ecsSplit t').map (fun p => (b :: c :: p.1, p.2))
        else some ([], b :: c :: t')
    else (ecsSplit t).map (fun p => (b :: p.1, p.2))

/-- `ecsSplit` with an accumulator (reversed), so the program runs in constant stack: `ecsSplit_eq_fast` proves it
equal to `ecsSplit`, and `@[csimp]` makes compiled code use it. -/
def ecsSplitAux : Bytes → Bytes → Option (Bytes × Bytes)
  | _, [] => none
  | acc, b :: t =>
    if b = 0xFF then
      match t with
      | [] => none
      | c :: t' =>
        if c = 0x00 ∨ isRst c = true then ecsSplitAux (c :: b :: acc) t'
        else some (acc.reverse, b :: c :: t')
    else ecsSplitAux (b :: acc) t

theorem ecsSplitAux_eq : ∀ (acc l : Bytes), ecsSplitAux acc l = (ecsSplit l).map (fun p => (acc.reverse ++ p.1, p.2))
  | acc, [] => by simp [ecsSplitAux, ecsSplit]
  | acc, b :: t => by
    rw [ecsSplitAux.eq_def, ecsSplit.eq_def]
    simp only
    split_ifs with hb
    · match t with
      | [] => simp
      | c :: t' =>
        simp only
        split_ifs with hc
        · rw [ecsSplitAux_eq, Option.map_map]
          congr 1
          funext p
          simp [hb]
        · simp
    · rw [ecsSplitAux_eq, Option.map_map]
      congr 1
      funext p
      simp

/-- The constant-stack `ecsSplit`. -/
def ecsSplitFast (l : Bytes) : Option (Bytes × Bytes) := ecsSplitAux [] l

@[csimp] theorem ecsSplit_eq_fast : @ecsSplit = @ecsSplitFast := by
  funext l
  rw [ecsSplitFast, ecsSplitAux_eq]
  simp

/-- A segment's length field: the big-endian 16-bit number in its first two bytes. -/
def lenField : Bytes → Option Nat
  | hi :: lo :: _ => some (hi.toNat * 256 + lo.toNat)
  | _ => none

/-- What follows the marker byte `m` (jpeg.rs `step` after the marker): the item and the bytes after it. -/
def stepAfter (m : UInt8) (r : Bytes) : Except Err (Item × Bytes) :=
  if m = 0xD9 then .ok (.eoi, r)
  else if standalone m = true then .ok (.std m, r)
  else if m = 0x00 then .error .badMarker
  else
    match lenField r with
    | none => .error .truncated
    | some len =>
      if len < 2 then .error .badLength
      else if r.length < len then .error .truncated
      else if m = 0xDA then
        match ecsSplit (r.drop len) with
        | none => .error .truncated
        | some (ecs, rest') => .ok (.scan (r.take len) ecs, rest')
      else .ok (.seg m (r.take len), r.drop len)

/-- One marker at the front of `rest` (jpeg.rs `step`): the item, the number of fill bytes before it, and the bytes
after it. -/
def step (rest : Bytes) : Except Err (Item × Nat × Bytes) :=
  match rest with
  | [] => .error .noEndOfImage
  | b :: _ =>
    if b ≠ 0xFF then .error .expectedMarker
    else
      match dropFF rest with
      | (_, []) => .error .truncated
      | (ffs, m :: r) =>
        match stepAfter m r with
        | .error e => .error e
        | .ok (it, r') => .ok (it, ffs - 1, r')

theorem dropFF_length_le (l : Bytes) : (dropFF l).2.length ≤ l.length := by
  induction l with
  | nil => simp [dropFF]
  | cons b t ih =>
    unfold dropFF
    split_ifs
    · simp only [List.length_cons]
      omega
    · simp

theorem ecsSplit_length_le : ∀ (l : Bytes) {e r : Bytes}, ecsSplit l = some (e, r) → r.length ≤ l.length
  | [], _, _, h => by simp [ecsSplit] at h
  | b :: t, e, r, h => by
    unfold ecsSplit at h
    split_ifs at h with hb
    · match t, h with
      | [], h => simp at h
      | c :: t', h =>
        simp only at h
        split_ifs at h with hc
        · obtain ⟨p, hp, hpe⟩ := Option.map_eq_some_iff.1 h
          have := ecsSplit_length_le t' (e := p.1) (r := p.2) (by rw [hp])
          simp only [Prod.mk.injEq] at hpe
          rw [← hpe.2]
          simp only [List.length_cons]
          omega
        · simp only [Option.some.injEq, Prod.mk.injEq] at h
          rw [← h.2]
    · obtain ⟨p, hp, hpe⟩ := Option.map_eq_some_iff.1 h
      have := ecsSplit_length_le t (e := p.1) (r := p.2) (by rw [hp])
      simp only [Prod.mk.injEq] at hpe
      rw [← hpe.2]
      simp only [List.length_cons]
      omega

theorem stepAfter_length_le {m : UInt8} {r : Bytes} {it : Item} {r' : Bytes} (h : stepAfter m r = .ok (it, r')) :
    r'.length ≤ r.length := by
  unfold stepAfter at h
  split at h
  · simp only [Except.ok.injEq, Prod.mk.injEq] at h
    rw [← h.2]
  split at h
  · simp only [Except.ok.injEq, Prod.mk.injEq] at h
    rw [← h.2]
  split at h
  · simp at h
  split at h
  · simp at h
  rename_i len _
  split at h
  · simp at h
  split at h
  · simp at h
  split at h
  · split at h
    · simp at h
    · rename_i ecs rest' he
      simp only [Except.ok.injEq, Prod.mk.injEq] at h
      have := ecsSplit_length_le _ he
      rw [List.length_drop] at this
      rw [← h.2]
      omega
  · simp only [Except.ok.injEq, Prod.mk.injEq] at h
    rw [← h.2, List.length_drop]
    omega

/-- Every step consumes at least one byte (so `walk` ends). -/
theorem step_length_lt {rest : Bytes} {it : Item} {fill : Nat} {r : Bytes} (h : step rest = .ok (it, fill, r)) :
    r.length < rest.length := by
  unfold step at h
  split at h
  · simp at h
  rename_i b t
  split at h
  · simp at h
  have hd := dropFF_length_le (b :: t)
  split at h
  · simp at h
  rename_i ffs m r0 hdr
  rw [hdr] at hd
  simp only [List.length_cons] at hd
  split at h
  · simp at h
  rename_i it' r' hs
  simp only [Except.ok.injEq, Prod.mk.injEq] at h
  have := stepAfter_length_le hs
  rw [← h.2.2]
  simp only [List.length_cons]
  omega

/-- The items up to and including EOI, and the bytes after EOI (jpeg.rs's loop over `step`). -/
def walk (rest : Bytes) : Except Err (List Item × Bytes) :=
  match h : step rest with
  | .error e => .error e
  | .ok (.eoi, _, r) => .ok ([.eoi], r)
  | .ok (it, _, r) =>
    have := step_length_lt h
    match walk r with
    | .error e => .error e
    | .ok (items, tr) => .ok (it :: items, tr)
termination_by rest.length

/-- The 16-byte plain JFIF header an APP0 segment is kept as (jpeg.rs `plain_jfif`, v1's `plain_jfif`): only a JFIF
header of at least 16 bytes is kept, with a 0 × 0 thumbnail. -/
def plainJfif (body : Bytes) : Option Bytes :=
  if 16 ≤ body.length ∧ (body.drop 2).take 5 = [0x4A, 0x46, 0x49, 0x46, 0x00] then
    some ([0x00, 0x10] ++ (body.drop 2).take 12 ++ [0x00, 0x00])
  else none

/-- What the stripper keeps of an item: APP1–APP15 and COM go, APP0 stays only as a plain JFIF header. -/
def keepItem : Item → Option Item
  | .seg m body =>
    if m = 0xE0 then (plainJfif body).map (.seg 0xE0)
    else if isMetadata m = true then none
    else some (.seg m body)
  | it => some it

/-- An item's bytes. -/
def ser : Item → Bytes
  | .eoi => [0xFF, 0xD9]
  | .std m => [0xFF, m]
  | .seg m body => 0xFF :: m :: body
  | .scan hdr ecs => 0xFF :: 0xDA :: (hdr ++ ecs)

/-- Items' bytes, in order. -/
def serialize (items : List Item) : Bytes := items.flatMap ser

/-- SOI. -/
def soi : Bytes := [0xFF, 0xD8]

/-- **The stripper** (jpeg.rs `strip`, v1's `clean_jpeg`): SOI, the kept items in their order, EOI; fill bytes and
everything after EOI dropped; the image data copied byte for byte. -/
def strip (data : Bytes) : Except Err Bytes :=
  if 4 ≤ data.length ∧ data.take 2 = soi then
    match walk (data.drop 2) with
    | .error e => .error e
    | .ok (items, _) => .ok (soi ++ serialize (items.filterMap keepItem))
  else .error .notJpeg

/-- jpeg.rs `is_plain_jfif`: exactly a plain 16-byte JFIF header. -/
def isPlainJfif (body : Bytes) : Bool :=
  decide (body.length = 16 ∧ body.take 2 = [0x00, 0x10] ∧ (body.drop 2).take 5 = [0x4A, 0x46, 0x49, 0x46, 0x00] ∧
    body.drop 14 = [0x00, 0x00])

/-- The structural part of ingest's pass-through test (jpeg.rs `is_clean`, v1's `is_clean_jpeg`): well formed, APP0
only as plain JFIF headers, no APP1–APP15 or COM anywhere, and not one byte after EOI. -/
def isClean (data : Bytes) : Bool :=
  if 4 ≤ data.length ∧ data.take 2 = soi then
    match walk (data.drop 2) with
    | .error _ => false
    | .ok (items, tr) =>
      tr.isEmpty && items.all fun
        | .seg m body => !(isMetadata m) && (m != 0xE0 || isPlainJfif body)
        | _ => true
  else false

end Midstudy.Jpeg
