import Mathlib.Data.List.Basic
import Mathlib.Tactic

/-!
# The wasm-node wire reader (k-media AENEAS.md target #10)

An executable model of `core/crates/wasm-node/src/wire.rs` `Reader` (`new`, `done`, `u32`, `bytes`) and of its one
user, `api.rs` `zip_plan`'s input loop (`while !r.done() { read_entry(&mut r) }`, `bad-input` when a read fails).
The TypeScript face packs a zip's entries for it (`core/js/node.ts` `zipPlan`): per entry `u32le(name.length)`, the
name, `u32le(flags)`, the uncompressed size as two `u32le` words (low first) and `u32le(externalAttributes)`.

* `u32_eq_some`, `bytes_eq_some`: **a read never leaves the buffer**: `u32` succeeds exactly when 4 bytes are left
  and reads them, `bytes` exactly when the length-prefixed slice is inside the buffer and returns exactly that slice;
  each moves the position past what it read and no further.
* `readAll_pack`: **every packing is read back exactly** (fields below 2³², which the face checks), and
  `readAll_eq_some_iff`: **only a packing is**: any other input is `bad-input`.
* `Raw.size_eq`: `low | high << 32` is the size the face split into words.

`proofs/diff/` runs this model (`mediastrip wire`) against wire.rs and api.rs's `zip_plan` on generated packings.
-/

namespace Midstudy.Wire

/-- Bytes. -/
abbrev Bytes := List UInt8

/-- wire.rs `Reader`: the buffer and the position (`at`). -/
structure Reader where
  data : Bytes
  pos : ℕ
  deriving DecidableEq, Repr

/-- wire.rs `Reader::new`. -/
def Reader.new (data : Bytes) : Reader := ⟨data, 0⟩

/-- wire.rs `done`: `at >= data.len()`. -/
def Reader.done (r : Reader) : Bool := decide (r.data.length ≤ r.pos)

/-- Four bytes, little-endian (`u32::from_le_bytes`). -/
def le32 (a b c d : UInt8) : ℕ := a.toNat + b.toNat * 2 ^ 8 + c.toNat * 2 ^ 16 + d.toNat * 2 ^ 24

/-- **wire.rs `u32`**: `data.get(at..)?.first_chunk::<4>()` read little-endian, then `at.checked_add(4)?` (which
can't overflow once four bytes are left in a slice). -/
def Reader.u32 (r : Reader) : Option (ℕ × Reader) :=
  match (r.data.drop r.pos).take 4 with
  | [a, b, c, d] => some (le32 a b c d, ⟨r.data, r.pos + 4⟩)
  | _ => none

/-- **wire.rs `bytes`**: a `u32` length (`usize::try_from` is exact on wasm32 and 64-bit), `end = at.checked_add(len)?`
and `data.get(at..end)?`. In naturals the two checks are the one `at + len ≤ data.len()`: an overflowing sum is past
the end of any slice. As in Rust, nothing is kept of a failed read (every caller gives up on `None`). -/
def Reader.bytes (r : Reader) : Option (Bytes × Reader) :=
  match r.u32 with
  | none => none
  | some (len, r1) =>
    if r1.pos + len ≤ r1.data.length then some ((r1.data.drop r1.pos).take len, ⟨r1.data, r1.pos + len⟩)
    else none

/-- One zip entry as `read_entry` reads it: the name, the general-purpose flags, the size's two words, the external
attributes. -/
structure Raw where
  name : Bytes
  flags : ℕ
  low : ℕ
  high : ℕ
  attr : ℕ
  deriving DecidableEq, Repr

/-- `zip::Entry::size`: `u64::from(low) | u64::from(high).wrapping_shl(32)` (no wrap: `high < 2³²`). -/
def Raw.size (e : Raw) : ℕ := e.low ||| e.high <<< 32

/-- `zip::Entry::utf8`: general-purpose flag bit 11. -/
def Raw.utf8 (e : Raw) : Bool := e.flags &&& 0x0800 != 0

/-- **api.rs `read_entry`**: `bytes`, then four `u32`s. -/
def readEntry (r : Reader) : Option (Raw × Reader) :=
  match r.bytes with
  | none => none
  | some (name, r) =>
    match r.u32 with
    | none => none
    | some (flags, r) =>
      match r.u32 with
      | none => none
      | some (low, r) =>
        match r.u32 with
        | none => none
        | some (high, r) =>
          match r.u32 with
          | none => none
          | some (attr, r) => some (⟨name, flags, low, high, attr⟩, r)

/-! ## Reads stay inside the buffer -/

/-- **`u32` succeeds exactly when four bytes are left**, reads them, and moves past them. -/
theorem u32_eq_some (r : Reader) (v : ℕ) (r' : Reader) :
    r.u32 = some (v, r') ↔
      ∃ a b c d, (r.data.drop r.pos).take 4 = [a, b, c, d] ∧ v = le32 a b c d ∧ r' = ⟨r.data, r.pos + 4⟩ := by
  unfold Reader.u32
  constructor
  · intro h
    split at h
    · rename_i a b c d heq
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      exact ⟨a, b, c, d, heq, h.1.symm, h.2.symm⟩
    · cases h
  · rintro ⟨a, b, c, d, h, rfl, rfl⟩
    rw [h]

theorem u32_pos {r r' : Reader} {v : ℕ} (h : r.u32 = some (v, r')) :
    r'.data = r.data ∧ r'.pos = r.pos + 4 ∧ r.pos + 4 ≤ r.data.length := by
  obtain ⟨a, b, c, d, h4, -, rfl⟩ := (u32_eq_some r v r').1 h
  refine ⟨rfl, rfl, ?_⟩
  have := congrArg List.length h4
  simp only [List.length_take, List.length_drop, List.length_cons, List.length_nil] at this
  omega

/-- **`bytes` returns exactly the length-prefixed slice**, inside the buffer, and moves just past it. -/
theorem bytes_eq_some (r : Reader) (s : Bytes) (r' : Reader) :
    r.bytes = some (s, r') ↔
      ∃ len, r.u32 = some (len, ⟨r.data, r.pos + 4⟩) ∧ r.pos + 4 + len ≤ r.data.length ∧
        s = (r.data.drop (r.pos + 4)).take len ∧ s.length = len ∧ r' = ⟨r.data, r.pos + 4 + len⟩ := by
  unfold Reader.bytes
  constructor
  · intro h
    split at h
    · cases h
    · rename_i len r1 hu
      obtain ⟨hd, hp, -⟩ := u32_pos hu
      split_ifs at h with hle
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨rfl, rfl⟩ := h
      have hr1 : r1 = ⟨r.data, r.pos + 4⟩ := by
        cases r1
        simp_all
      subst hr1
      simp only at hle
      refine ⟨len, hu, hle, rfl, ?_, rfl⟩
      simp only [List.length_take, List.length_drop]
      omega
  · rintro ⟨len, hu, hle, rfl, -, rfl⟩
    rw [hu]
    simp only
    rw [if_pos hle]

/-- A reader's position stays within its buffer across successful reads. -/
theorem readEntry_pos {r r' : Reader} {e : Raw} (h : readEntry r = some (e, r')) :
    r'.data = r.data ∧ r.pos + 20 ≤ r'.pos ∧ r'.pos ≤ r.data.length := by
  unfold readEntry at h
  split at h
  · cases h
  rename_i name r1 hb
  obtain ⟨len, -, hle, -, -, rfl⟩ := (bytes_eq_some r name r1).1 hb
  split at h
  · cases h
  rename_i flags r2 h2
  obtain ⟨d2, p2, -⟩ := u32_pos h2
  split at h
  · cases h
  rename_i low r3 h3
  obtain ⟨d3, p3, -⟩ := u32_pos h3
  split at h
  · cases h
  rename_i high r4 h4
  obtain ⟨d4, p4, -⟩ := u32_pos h4
  split at h
  · cases h
  rename_i attr r5 h5
  obtain ⟨d5, p5, l5⟩ := u32_pos h5
  simp only [Option.some.injEq, Prod.mk.injEq] at h
  obtain ⟨-, rfl⟩ := h
  simp only at d2 p2
  rw [d4, d3, d2] at l5
  exact ⟨by rw [d5, d4, d3, d2], by omega, by omega⟩

/-- **api.rs `zip_plan`'s input loop**: entries until the reader is done; `none` (`bad-input`) when a read fails. -/
def readAll (r : Reader) : Option (List Raw) :=
  if _hd : r.done then some []
  else
    match _h : readEntry r with
    | none => none
    | some (e, r') => (readAll r').map (e :: ·)
termination_by r.data.length - r.pos
decreasing_by
  obtain ⟨hdata, hpos, hle⟩ := readEntry_pos _h
  simp only [Reader.done, decide_eq_true_eq] at _hd
  rw [hdata]
  omega

/-! ## The TypeScript face's packing -/

/-- `u32le(n)`: `DataView.setUint32(0, n, true)`. -/
def le32Bytes (n : ℕ) : Bytes := [n.toUInt8, (n / 2 ^ 8).toUInt8, (n / 2 ^ 16).toUInt8, (n / 2 ^ 24).toUInt8]

/-- node.ts `zipPlan`'s parts for one entry. -/
def packEntry (e : Raw) : Bytes :=
  le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags ++ le32Bytes e.low ++ le32Bytes e.high ++ le32Bytes e.attr

/-- node.ts `zipPlan`'s `packed`: the entries' parts in order. -/
def pack : List Raw → Bytes
  | [] => []
  | e :: es => packEntry e ++ pack es

/-- The fields the face checks: each one a `u32`. -/
def Raw.Ok (e : Raw) : Prop :=
  e.name.length < 2 ^ 32 ∧ e.flags < 2 ^ 32 ∧ e.low < 2 ^ 32 ∧ e.high < 2 ^ 32 ∧ e.attr < 2 ^ 32

theorem toUInt8_toNat (n : ℕ) : n.toUInt8.toNat = n % 256 := by
  simp [Nat.toUInt8]

theorem le32_le32Bytes {n : ℕ} (h : n < 2 ^ 32) :
    le32 n.toUInt8 (n / 2 ^ 8).toUInt8 (n / 2 ^ 16).toUInt8 (n / 2 ^ 24).toUInt8 = n := by
  simp only [le32, toUInt8_toNat]
  omega

theorem le32_lt (a b c d : UInt8) : le32 a b c d < 2 ^ 32 := by
  have := a.toNat_lt
  have := b.toNat_lt
  have := c.toNat_lt
  have := d.toNat_lt
  simp only [le32]
  omega

theorem le32Bytes_le32 (a b c d : UInt8) : le32Bytes (le32 a b c d) = [a, b, c, d] := by
  have ha := a.toNat_lt
  have hb := b.toNat_lt
  have hc := c.toNat_lt
  have hd := d.toNat_lt
  simp only [le32Bytes, List.cons.injEq, and_true]
  refine ⟨?_, ?_, ?_, ?_⟩ <;> apply UInt8.toNat_inj.1 <;> rw [toUInt8_toNat] <;> simp only [le32] <;> omega

/-- Reading a `u32le` where one was written. -/
theorem u32_at {pre post : Bytes} {n : ℕ} (h : n < 2 ^ 32) :
    (Reader.u32 ⟨pre ++ le32Bytes n ++ post, pre.length⟩) =
      some (n, ⟨pre ++ le32Bytes n ++ post, pre.length + 4⟩) := by
  unfold Reader.u32
  have : ((pre ++ le32Bytes n ++ post).drop pre.length).take 4 = le32Bytes n := by
    rw [List.append_assoc, List.drop_left, List.take_left' (by rfl)]
  rw [this]
  simp only [le32Bytes]
  rw [le32_le32Bytes h]

/-- Reading a name where one was written. -/
theorem bytes_at {pre name post : Bytes} (h : name.length < 2 ^ 32) :
    (Reader.bytes ⟨pre ++ le32Bytes name.length ++ name ++ post, pre.length⟩) =
      some (name, ⟨pre ++ le32Bytes name.length ++ name ++ post, pre.length + 4 + name.length⟩) := by
  unfold Reader.bytes
  rw [show pre ++ le32Bytes name.length ++ name ++ post = pre ++ le32Bytes name.length ++ (name ++ post) by
    simp only [List.append_assoc], u32_at h]
  simp only
  have hlen : (le32Bytes name.length).length = 4 := rfl
  rw [if_pos (by simp only [List.length_append, hlen]; omega)]
  have : ((pre ++ le32Bytes name.length ++ (name ++ post)).drop (pre.length + 4)).take name.length = name := by
    rw [show pre.length + 4 = (pre ++ le32Bytes name.length).length by simp [hlen], List.drop_left,
      List.take_left' rfl]
  rw [this]

theorem readEntry_at {pre post : Bytes} {e : Raw} (he : e.Ok) :
    readEntry ⟨pre ++ packEntry e ++ post, pre.length⟩ =
      some (e, ⟨pre ++ packEntry e ++ post, pre.length + (packEntry e).length⟩) := by
  obtain ⟨hn, hf, hl, hh, ha⟩ := he
  have h4 : ∀ n, (le32Bytes n).length = 4 := fun _ => rfl
  unfold readEntry
  have e1 : pre ++ packEntry e ++ post =
      pre ++ le32Bytes e.name.length ++ e.name ++
        (le32Bytes e.flags ++ le32Bytes e.low ++ le32Bytes e.high ++ le32Bytes e.attr ++ post) := by
    simp [packEntry]
  rw [e1, bytes_at hn]
  simp only
  have e2 : pre ++ le32Bytes e.name.length ++ e.name ++
      (le32Bytes e.flags ++ le32Bytes e.low ++ le32Bytes e.high ++ le32Bytes e.attr ++ post) =
      (pre ++ le32Bytes e.name.length ++ e.name) ++ le32Bytes e.flags ++
        (le32Bytes e.low ++ le32Bytes e.high ++ le32Bytes e.attr ++ post) := by simp
  have l2 : pre.length + 4 + e.name.length = (pre ++ le32Bytes e.name.length ++ e.name).length := by
    simp only [List.length_append, h4]
  rw [e2, l2, u32_at hf]
  simp only
  have e3 : (pre ++ le32Bytes e.name.length ++ e.name) ++ le32Bytes e.flags ++
      (le32Bytes e.low ++ le32Bytes e.high ++ le32Bytes e.attr ++ post) =
      (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags) ++ le32Bytes e.low ++
        (le32Bytes e.high ++ le32Bytes e.attr ++ post) := by simp
  have l3 : (pre ++ le32Bytes e.name.length ++ e.name).length + 4 =
      (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags).length := by simp only [List.length_append, h4]
  rw [e3, l3, u32_at hl]
  simp only
  have e4 : (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags) ++ le32Bytes e.low ++
      (le32Bytes e.high ++ le32Bytes e.attr ++ post) =
      (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags ++ le32Bytes e.low) ++ le32Bytes e.high ++
        (le32Bytes e.attr ++ post) := by simp
  have l4 : (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags).length + 4 =
      (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags ++ le32Bytes e.low).length := by simp only [List.length_append, h4]
  rw [e4, l4, u32_at hh]
  simp only
  have e5 : (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags ++ le32Bytes e.low) ++
      le32Bytes e.high ++ (le32Bytes e.attr ++ post) =
      (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags ++ le32Bytes e.low ++ le32Bytes e.high) ++
        le32Bytes e.attr ++ post := by simp
  have l5 : (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags ++ le32Bytes e.low).length + 4 =
      (pre ++ le32Bytes e.name.length ++ e.name ++ le32Bytes e.flags ++ le32Bytes e.low ++
        le32Bytes e.high).length := by simp only [List.length_append, h4]
  rw [e5, l5, u32_at ha]
  simp only [Option.some.injEq, Prod.mk.injEq, Reader.mk.injEq]
  refine ⟨trivial, by simp, ?_⟩
  simp only [packEntry, List.length_append, h4]
  omega

theorem packEntry_length (e : Raw) : (packEntry e).length = 20 + e.name.length := by
  simp [packEntry, le32Bytes]
  omega

/-- **Every packing is read back exactly.** -/
theorem readAll_at : ∀ (es : List Raw) (pre : Bytes), (∀ e ∈ es, e.Ok) →
    readAll ⟨pre ++ pack es, pre.length⟩ = some es
  | [], pre, _ => by
    rw [readAll]
    simp [Reader.done, pack]
  | e :: es, pre, hok => by
    rw [readAll, dif_neg (by simp [Reader.done, pack, packEntry_length])]
    have hr := readEntry_at (pre := pre) (post := pack es) (hok e (by simp))
    rw [List.append_assoc] at hr
    simp only [pack]
    split
    · rename_i h
      rw [hr] at h
      cases h
    · rename_i e' r' h
      rw [hr] at h
      simp only [Option.some.injEq, Prod.mk.injEq] at h
      obtain ⟨he, hr'⟩ := h
      subst he
      subst hr'
      have := readAll_at es (pre ++ packEntry e) (fun x hx => hok x (by simp [hx]))
      rw [List.length_append, List.append_assoc] at this
      rw [this]
      rfl

theorem readAll_pack {es : List Raw} (hok : ∀ e ∈ es, e.Ok) : readAll (Reader.new (pack es)) = some es := by
  simpa using readAll_at es [] hok

/-! ## Only a packing is read -/

theorem u32_split {r r' : Reader} {v : ℕ} (h : r.u32 = some (v, r')) :
    r.data.drop r.pos = le32Bytes v ++ r.data.drop (r.pos + 4) ∧ v < 2 ^ 32 ∧ r' = ⟨r.data, r.pos + 4⟩ := by
  obtain ⟨a, b, c, d, h4, rfl, rfl⟩ := (u32_eq_some r v r').1 h
  refine ⟨?_, le32_lt a b c d, rfl⟩
  rw [le32Bytes_le32, ← h4, ← List.drop_drop, List.take_append_drop]

theorem bytes_split {r r' : Reader} {s : Bytes} (h : r.bytes = some (s, r')) :
    r.data.drop r.pos = le32Bytes s.length ++ s ++ r.data.drop (r.pos + 4 + s.length) ∧ s.length < 2 ^ 32 ∧
      r' = ⟨r.data, r.pos + 4 + s.length⟩ := by
  obtain ⟨len, hu, -, rfl, hlen, rfl⟩ := (bytes_eq_some r s r').1 h
  obtain ⟨hd, hlt, -⟩ := u32_split hu
  rw [hlen]
  refine ⟨?_, hlt, rfl⟩
  have e : List.drop len (List.drop (r.pos + 4) r.data) = List.drop (r.pos + 4 + len) r.data := List.drop_drop
  have hs : List.drop (r.pos + 4) r.data =
      List.take len (List.drop (r.pos + 4) r.data) ++ List.drop (r.pos + 4 + len) r.data := by
    rw [← e, List.take_append_drop]
  rw [hd, List.append_assoc, ← hs]

theorem readEntry_split {r r' : Reader} {e : Raw} (h : readEntry r = some (e, r')) :
    r.data.drop r.pos = packEntry e ++ r.data.drop r'.pos ∧ e.Ok ∧ r'.data = r.data := by
  unfold readEntry at h
  split at h
  · cases h
  rename_i name r1 hb
  obtain ⟨d1, n1, rfl⟩ := bytes_split hb
  split at h
  · cases h
  rename_i flags r2 h2
  obtain ⟨d2, f2, rfl⟩ := u32_split h2
  split at h
  · cases h
  rename_i low r3 h3
  obtain ⟨d3, f3, rfl⟩ := u32_split h3
  split at h
  · cases h
  rename_i high r4 h4
  obtain ⟨d4, f4, rfl⟩ := u32_split h4
  split at h
  · cases h
  rename_i attr r5 h5
  obtain ⟨d5, f5, rfl⟩ := u32_split h5
  simp only [Option.some.injEq, Prod.mk.injEq] at h
  obtain ⟨rfl, rfl⟩ := h
  simp only at d2 d3 d4 d5 ⊢
  refine ⟨?_, ⟨n1, f2, f3, f4, f5⟩, by simp⟩
  rw [d1, d2, d3, d4, d5]
  simp [packEntry]

theorem readAll_some : ∀ (n : ℕ) (r : Reader) (es : List Raw), r.data.length - r.pos = n → r.pos ≤ r.data.length →
    readAll r = some es → r.data.drop r.pos = pack es ∧ ∀ e ∈ es, e.Ok := by
  intro n
  induction n using Nat.strong_induction_on with
  | _ n ih =>
    intro r es hn hle h
    rw [readAll] at h
    split_ifs at h with hd
    · simp only [Option.some.injEq] at h
      subst h
      simp only [Reader.done, decide_eq_true_eq] at hd
      refine ⟨?_, by simp⟩
      rw [List.drop_eq_nil_of_le hd]
      rfl
    · split at h
      · cases h
      rename_i e r' he
      obtain ⟨es', hes, rfl⟩ : ∃ es', readAll r' = some es' ∧ es = e :: es' := by
        cases h' : readAll r' with
        | none => rw [h'] at h; cases h
        | some es' => rw [h'] at h; simp only [Option.map_some, Option.some.injEq] at h; exact ⟨es', rfl, h.symm⟩
      obtain ⟨hdata, hpos, hle'⟩ := readEntry_pos he
      obtain ⟨hsplit, hok, -⟩ := readEntry_split he
      obtain ⟨hrest, hoks⟩ := ih (r'.data.length - r'.pos) (by rw [hdata]; omega) r' es' rfl
        (by rw [hdata]; exact hle') hes
      refine ⟨?_, ?_⟩
      · rw [hsplit, ← hdata, hrest]
        rfl
      · intro x hx
        rcases List.mem_cons.1 hx with rfl | hx
        · exact hok
        · exact hoks x hx

/-- **Exactly the packings are read**: `zip_plan` reads entries from a buffer exactly when it is the face's packing
of them (each field a `u32`); anything else is `bad-input`. -/
theorem readAll_eq_some_iff (p : Bytes) (es : List Raw) :
    readAll (Reader.new p) = some es ↔ p = pack es ∧ ∀ e ∈ es, e.Ok := by
  constructor
  · intro h
    have := readAll_some _ (Reader.new p) es rfl (Nat.zero_le _) h
    simpa [Reader.new] using this
  · rintro ⟨rfl, hok⟩
    exact readAll_pack hok

/-- `low | high << 32` is the size the face split into `size % 2³²` and `⌊size / 2³²⌋`. -/
theorem Raw.size_eq (e : Raw) (h : e.low < 2 ^ 32) : e.size = e.low + e.high * 2 ^ 32 := by
  unfold Raw.size
  rw [Nat.or_comm, ← Nat.shiftLeft_add_eq_or_of_lt h, Nat.shiftLeft_eq]
  ring

theorem Raw.size_split (size : ℕ) (h : size < 2 ^ 64) :
    (Raw.mk [] 0 (size % 2 ^ 32) (size / 2 ^ 32) 0).size = size ∧ size / 2 ^ 32 < 2 ^ 32 := by
  refine ⟨?_, by omega⟩
  rw [Raw.size_eq _ (Nat.mod_lt _ (by norm_num))]
  simp only
  omega

end Midstudy.Wire
