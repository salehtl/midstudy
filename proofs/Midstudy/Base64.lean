import Mathlib.Data.List.Basic
import Mathlib.Tactic

/-!
# Base64 and the `X-Midstudy-Meta` header (k-media AENEAS.md target #5; contract §2.6, §2.8 Library API, §4.4 Upload)

An executable model of `core/crates/media/src/base64.rs` (`value`, `decode_python`, `encode`) and of
`core/crates/media/src/meta.rs` (`decode`): the header that carries a scene's or an upload's JSON meta is "strict
base64 of UTF-8 JSON" with a 16 KiB cap. `decode_python` is CPython's `binascii.a2b_base64` check for check (v1 read
the header with `base64.b64decode(raw, validate=True)`); `strict = false` is its lenient mode.

* `decodePython_strict_iff`: **strict acceptance is exactly padded base64**: alphabet characters, then `==` after
  2 mod 4 of them, `=` after 3 mod 4, nothing after 0 mod 4 (so no leading or excess padding and nothing after it;
  1 mod 4 is never accepted), and the bytes are the characters' bits cut to whole bytes (`decodeSpec`).
* `decodePython_encode`: decoding what `encode` wrote gives the bytes back (`decode_python(encode(x), true) = x`).
* `decodePython_lenient_of_strict`: the lenient mode reads every strict input the same way.
* `metaDecode_encode`, `metaDecode_ok_iff`, `metaDecode_length`: a header made from UTF-8 text (within the cap) is
  read back as that text; a header is accepted exactly when it is within the cap, ASCII, strict base64 and decodes to
  UTF-8 (`utf8Valid`, Rust's `String::from_utf8`: the well-formed sequences of Unicode's Table 3-7); the text is at
  most three quarters of the header (12 KiB under the 16 KiB cap).

`proofs/diff/` runs this model (`mediastrip b64|meta`) against the Rust on generated inputs.
-/

namespace Midstudy.Base64

/-- Bytes. -/
abbrev Bytes := List UInt8

/-- base64.rs `ALPHABET`: `A–Z`, `a–z`, `0–9`, `+`, `/`. -/
def ALPHABET : Bytes :=
  (List.range 26).map (fun i => (0x41 + i).toUInt8) ++ (List.range 26).map (fun i => (0x61 + i).toUInt8) ++
    (List.range 10).map (fun i => (0x30 + i).toUInt8) ++ [0x2B, 0x2F]

/-- base64.rs `value`: the 6-bit value of an alphabet character (`wrapping_sub`/`wrapping_add` on `u8`). -/
def value (c : UInt8) : Option UInt8 :=
  if 0x41 ≤ c ∧ c ≤ 0x5A then some (c - 0x41)
  else if 0x61 ≤ c ∧ c ≤ 0x7A then some (c - 0x61 + 26)
  else if 0x30 ≤ c ∧ c ≤ 0x39 then some (c - 0x30 + 52)
  else if c = 0x2B then some 62
  else if c = 0x2F then some 63
  else none

/-- Why `decode_python` refused its input (base64.rs `Base64Error`, offsets included). -/
inductive Err
  | leadingPadding
  | excessPadding
  | notBase64 (pos : Nat)
  | discontinuousPadding (pos : Nat)
  | dataAfterPadding
  | oneExtraCharacter
  | incorrectPadding
  deriving DecidableEq, Repr

/-- `decode_python`'s loop over `input.iter().enumerate()`, from offset `i` on, with its state: `quad` (data characters
of the current group), `left` (the pending bits), `pads` (`=` counted as padding), `started` (`padding_started`) and
the bytes so far (`acc`, last first). Rust's `i + 1 < input.len()` is "`c` isn't the last character": `rest ≠ []`.
`pads` and `quad` stay below 4, so `saturating_add` never saturates. -/
def go (strict : Bool) : Nat → Bytes → Nat → UInt8 → Nat → Bool → Bytes → Except Err Bytes
  | _, [], quad, _, _, _, acc =>
    if quad = 0 then .ok acc.reverse else if quad = 1 then .error .oneExtraCharacter else .error .incorrectPadding
  | i, c :: rest, quad, left, pads, started, acc =>
    if c = 0x3D then
      if strict ∧ quad = 0 then .error .excessPadding
      else if 2 ≤ quad then
        if 4 ≤ quad + (pads + 1) then
          if strict ∧ rest ≠ [] then .error .dataAfterPadding else .ok acc.reverse
        else go strict (i + 1) rest quad left (pads + 1) true acc
      else go strict (i + 1) rest quad left pads true acc
    else
      match value c with
      | none => if strict then .error (.notBase64 i) else go strict (i + 1) rest quad left pads started acc
      | some v =>
        if strict ∧ started then .error (.discontinuousPadding i)
        else if quad = 0 then go strict (i + 1) rest 1 v 0 started acc
        else if quad = 1 then go strict (i + 1) rest 2 (v &&& 0x0F) 0 started ((left <<< 2 ||| v >>> 4) :: acc)
        else if quad = 2 then go strict (i + 1) rest 3 (v &&& 0x03) 0 started ((left <<< 4 ||| v >>> 2) :: acc)
        else go strict (i + 1) rest 0 0 0 started ((left <<< 6 ||| v) :: acc)

/-- **base64.rs `decode_python`** (`CPython`'s `binascii.a2b_base64(s, strict_mode=strict)`). -/
def decodePython (input : Bytes) (strict : Bool) : Except Err Bytes :=
  if strict ∧ input.head? = some 0x3D then .error .leadingPadding
  else go strict 0 input 0 0 0 false []

/-- One group of `data.chunks(3)` (one to three bytes): `n = u32::from_be_bytes([0, a, b, c])` with the missing bytes
0, the four indices `(n >> s) & 0x3F` for `s` = 18, 12, 6, 0 as alphabet characters, the first `len + 1` of them
kept and the rest `=`. (`n < 2²⁴`, so the `u32` operations are the natural numbers'.) -/
def encodeGroup (g : Bytes) : Bytes :=
  let n := (g.getD 0 0).toNat <<< 16 ||| (g.getD 1 0).toNat <<< 8 ||| (g.getD 2 0).toNat
  let chars := [18, 12, 6, 0].map (fun s => ALPHABET.getD ((n >>> s) &&& 0x3F) 0x41)
  (List.range 4).map (fun k => if k < g.length + 1 then chars.getD k 0x41 else 0x3D)

/-- **base64.rs `encode`**: standard base64 with `=` padding (the `String`'s bytes: all ASCII). -/
def encode : Bytes → Bytes
  | [] => []
  | a :: b :: c :: rest => encodeGroup [a, b, c] ++ encode rest
  | g => encodeGroup g

/-! ## The specification -/

/-- The bytes that 6-bit values stand for: each group of four is 24 bits, three bytes; a last group of two or three
gives the one or two whole bytes in its 12 or 18 bits (the left-over low bits are dropped, unchecked, as CPython
does); a last single value gives nothing. -/
def spec : List ℕ → List ℕ
  | a :: b :: c :: d :: rest =>
    (((a * 64 + b) * 64 + c) * 64 + d) / 65536 :: (((a * 64 + b) * 64 + c) * 64 + d) / 256 % 256 ::
      (((a * 64 + b) * 64 + c) * 64 + d) % 256 :: spec rest
  | [a, b, c] => [((a * 64 + b) * 64 + c) * 64 / 65536, ((a * 64 + b) * 64 + c) * 64 / 256 % 256]
  | [a, b] => [(a * 64 + b) * 64 * 64 / 65536]
  | _ => []

/-- The value of an alphabet character as a number. -/
def valueN (c : UInt8) : ℕ := ((value c).getD 0).toNat

/-- What padded base64 text `d ++ pad` means: the bytes of its data characters' values. -/
def decodeSpec (d : Bytes) : Bytes := (spec (d.map valueN)).map Nat.toUInt8

/-- Correct, final padding after `n` data characters: none after 0 mod 4, `==` after 2, `=` after 3. -/
def PadOk (n : ℕ) (pad : Bytes) : Prop :=
  (n % 4 = 0 ∧ pad = []) ∨ (n % 4 = 2 ∧ pad = [0x3D, 0x3D]) ∨ (n % 4 = 3 ∧ pad = [0x3D])

/-! ## Characters and bits -/

theorem alphabet_length : ALPHABET.length = 64 := by decide

theorem value_alphabet : ∀ i < 64, value (ALPHABET.getD i 0) = some i.toUInt8 := by decide

theorem alphabet_ascii : ∀ b ∈ ALPHABET, b.toNat < 128 := by decide

theorem value_pad : value 0x3D = none := by decide

theorem value_lt {c v : UInt8} (h : value c = some v) : v.toNat < 64 := by
  unfold value at h
  split_ifs at h <;> (try cases h) <;> simp_all [UInt8.le_iff_toNat_le, UInt8.toNat_add] <;> omega

theorem ne_pad_of_value {c v : UInt8} (h : value c = some v) : c ≠ 0x3D := by
  rintro rfl
  rw [value_pad] at h
  cases h

theorem shl_or (x y s : UInt8) (k : ℕ) (hs : s.toNat = k) (hk : k < 8) (hx : x.toNat * 2 ^ k < 256)
    (hy : y.toNat < 2 ^ k) : ((x <<< s) ||| y).toNat = x.toNat * 2 ^ k + y.toNat := by
  rw [UInt8.toNat_or, UInt8.toNat_shiftLeft, hs, Nat.mod_eq_of_lt hk, Nat.shiftLeft_eq, Nat.mod_eq_of_lt (by omega),
    ← Nat.shiftLeft_eq, ← Nat.shiftLeft_add_eq_or_of_lt hy, Nat.shiftLeft_eq]

theorem shr_toNat (x s : UInt8) (k : ℕ) (hs : s.toNat = k) (hk : k < 8) : (x >>> s).toNat = x.toNat / 2 ^ k := by
  rw [UInt8.toNat_shiftRight, Nat.shiftRight_eq_div_pow, hs, Nat.mod_eq_of_lt hk]

theorem and_toNat (x m : UInt8) (k : ℕ) (hm : m.toNat = 2 ^ k - 1) : (x &&& m).toNat = x.toNat % 2 ^ k := by
  rw [UInt8.toNat_and, hm, Nat.and_two_pow_sub_one_eq_mod]

/-- The three bytes `decode_python` pushes for the values `a b c d` of a group. -/
theorem byte1 (l v : UInt8) (hl : l.toNat < 64) (hv : v.toNat < 64) :
    (l <<< 2 ||| v >>> 4).toNat = l.toNat * 4 + v.toNat / 16 := by
  have h := shr_toNat v 4 4 rfl (by norm_num)
  rw [shl_or l (v >>> 4) 2 2 rfl (by norm_num) (by omega) (by rw [h]; omega), h]
  norm_num

theorem byte2 (l v : UInt8) (hv : v.toNat < 64) :
    ((l &&& 0x0F) <<< 4 ||| v >>> 2).toNat = l.toNat % 16 * 16 + v.toNat / 4 := by
  have h := shr_toNat v 2 2 rfl (by norm_num)
  have ha := and_toNat l 0x0F 4 rfl
  rw [shl_or (l &&& 0x0F) (v >>> 2) 4 4 rfl (by norm_num) (by rw [ha]; omega) (by rw [h]; omega), h, ha]
  norm_num

theorem byte3 (l v : UInt8) (hv : v.toNat < 64) :
    ((l &&& 0x03) <<< 6 ||| v).toNat = l.toNat % 4 * 64 + v.toNat := by
  have ha := and_toNat l 0x03 2 rfl
  rw [shl_or (l &&& 0x03) v 6 6 rfl (by norm_num) (by rw [ha]; omega) (by omega), ha]
  norm_num

theorem toUInt8_toNat (n : ℕ) : n.toUInt8.toNat = n % 256 := by
  simp [Nat.toUInt8]

theorem uint8_eq_toUInt8 {x : UInt8} {n : ℕ} (h : x.toNat = n % 256) : x = n.toUInt8 := by
  apply UInt8.toNat_inj.1
  rw [h, toUInt8_toNat]

theorem or_eq_add (x y k : ℕ) (hx : x % 2 ^ k = 0) (hy : y < 2 ^ k) : x ||| y = x + y := by
  have : x = (x / 2 ^ k) <<< k := by
    rw [Nat.shiftLeft_eq]
    exact (Nat.div_mul_cancel (Nat.dvd_of_mod_eq_zero hx)).symm
  rw [this, ← Nat.shiftLeft_add_eq_or_of_lt hy]

theorem getD_alphabet {i : ℕ} (hi : i < 64) (d : UInt8) : ALPHABET.getD i d = ALPHABET.getD i 0 := by
  simp only [List.getD_eq_getElem?_getD]
  rw [List.getElem?_eq_getElem (by rw [alphabet_length]; exact hi)]
  rfl

/-- An encoded character: the alphabet character of `i < 64`, whose value is `i`. -/
theorem value_char {i : ℕ} (hi : i < 64) (d : UInt8) : value (ALPHABET.getD i d) = some i.toUInt8 := by
  rw [getD_alphabet hi]
  exact value_alphabet i hi

theorem valueN_char {i : ℕ} (hi : i < 64) (d : UInt8) : valueN (ALPHABET.getD i d) = i := by
  simp only [valueN, value_char hi, Option.getD_some, toUInt8_toNat]
  omega

/-! ## The loop on data characters -/

/-- A group of four data characters: three bytes out, and the loop is back at a group's start. -/
theorem go_four (strict : Bool) (i : ℕ) {c1 c2 c3 c4 v1 v2 v3 v4 : UInt8} (rest : Bytes) (left : UInt8) (pads : ℕ)
    (started : Bool) (acc : Bytes) (hs : ¬ (strict = true ∧ started = true))
    (h1 : value c1 = some v1) (h2 : value c2 = some v2) (h3 : value c3 = some v3) (h4 : value c4 = some v4) :
    go strict i (c1 :: c2 :: c3 :: c4 :: rest) 0 left pads started acc =
      go strict (i + 4) rest 0 0 0 started
        (((v3 &&& 0x03) <<< 6 ||| v4) :: ((v2 &&& 0x0F) <<< 4 ||| v3 >>> 2) :: (v1 <<< 2 ||| v2 >>> 4) :: acc) := by
  simp only [go, ne_pad_of_value h1, ne_pad_of_value h2, ne_pad_of_value h3, ne_pad_of_value h4, h1, h2, h3, h4,
    if_false, if_neg hs, if_true]
  simp

theorem valueN_of {c v : UInt8} (h : value c = some v) : valueN c = v.toNat := by
  simp [valueN, h]

theorem isSome_iff {c : UInt8} : (value c).isSome ↔ ∃ v, value c = some v := Option.isSome_iff_exists

/-- The three bytes the loop pushes for a group are the specification's. -/
theorem spec_four {a b c d : UInt8} (ha : a.toNat < 64) (hb : b.toNat < 64) (hc : c.toNat < 64)
    (hd : d.toNat < 64) :
    (spec [a.toNat, b.toNat, c.toNat, d.toNat]).map Nat.toUInt8 =
      [(a <<< 2 ||| b >>> 4), ((b &&& 0x0F) <<< 4 ||| c >>> 2), ((c &&& 0x03) <<< 6 ||| d)] := by
  simp only [spec, List.map_cons, List.map_nil, List.cons.injEq, and_true]
  refine ⟨(uint8_eq_toUInt8 ?_).symm, (uint8_eq_toUInt8 ?_).symm, (uint8_eq_toUInt8 ?_).symm⟩
  · rw [byte1 a b ha hb]
    omega
  · rw [byte2 b c hc]
    omega
  · rw [byte3 c d hd]
    omega

theorem spec_append : ∀ (l₁ l₂ : List ℕ), l₁.length % 4 = 0 → spec (l₁ ++ l₂) = spec l₁ ++ spec l₂
  | [], l₂, _ => by simp [spec]
  | [_], _, h | [_, _], _, h | [_, _, _], _, h => by simp at h
  | a :: b :: c :: d :: l, l₂, h => by
    simp only [List.cons_append, spec, List.cons_append]
    rw [spec_append l l₂ (by simp at h; omega)]

theorem decodeSpec_append (d₁ d₂ : Bytes) (h : d₁.length % 4 = 0) :
    decodeSpec (d₁ ++ d₂) = decodeSpec d₁ ++ decodeSpec d₂ := by
  simp only [decodeSpec, List.map_append]
  rw [spec_append _ _ (by simpa using h), List.map_append]

/-- Whole groups of data characters: their bytes, and the loop is at a group's start again. -/
theorem go_groups (strict started : Bool) (hs : ¬ (strict = true ∧ started = true)) :
    ∀ (d rest : Bytes) (i : ℕ) (acc : Bytes), d.length % 4 = 0 → (∀ c ∈ d, (value c).isSome) →
      go strict i (d ++ rest) 0 0 0 started acc =
        go strict (i + d.length) rest 0 0 0 started ((decodeSpec d).reverse ++ acc)
  | [], rest, i, acc, _, _ => by simp [decodeSpec, spec]
  | [_], _, _, _, h, _ | [_, _], _, _, _, h, _ | [_, _, _], _, _, _, h, _ => by simp at h
  | c1 :: c2 :: c3 :: c4 :: d, rest, i, acc, h, hd => by
    obtain ⟨v1, h1⟩ := isSome_iff.1 (hd c1 (by simp))
    obtain ⟨v2, h2⟩ := isSome_iff.1 (hd c2 (by simp))
    obtain ⟨v3, h3⟩ := isSome_iff.1 (hd c3 (by simp))
    obtain ⟨v4, h4⟩ := isSome_iff.1 (hd c4 (by simp))
    simp only [List.cons_append]
    rw [go_four strict i _ 0 0 started acc hs h1 h2 h3 h4,
      go_groups strict started hs d rest (i + 4) _ (by simp at h; omega) (fun c hc => hd c (by simp [hc]))]
    have hspec : decodeSpec (c1 :: c2 :: c3 :: c4 :: d) =
        [(v1 <<< 2 ||| v2 >>> 4), ((v2 &&& 0x0F) <<< 4 ||| v3 >>> 2), ((v3 &&& 0x03) <<< 6 ||| v4)] ++
          decodeSpec d := by
      rw [← spec_four (value_lt h1) (value_lt h2) (value_lt h3) (value_lt h4)]
      simp only [decodeSpec, List.map_cons, valueN_of h1, valueN_of h2, valueN_of h3, valueN_of h4]
      rw [show (v1.toNat :: v2.toNat :: v3.toNat :: v4.toNat :: List.map valueN d) =
          [v1.toNat, v2.toNat, v3.toNat, v4.toNat] ++ List.map valueN d from rfl,
        spec_append _ _ (by simp), List.map_append]
    rw [hspec]
    simp only [List.length_cons, List.reverse_cons, List.nil_append, List.append_assoc, List.cons_append]
    congr 1
    omega

/-- A last group of no, two or three data characters with its correct padding: the loop ends there, with the
group's bytes. -/
theorem go_tail (strict : Bool) (i : ℕ) (acc t pad : Bytes) (ht : ∀ c ∈ t, (value c).isSome) (hlen : t.length < 4)
    (hp : PadOk t.length pad) : go strict i (t ++ pad) 0 0 0 false acc = .ok (acc.reverse ++ decodeSpec t) := by
  match t, hlen, hp with
  | [], _, hp =>
    rcases hp with ⟨-, rfl⟩ | ⟨h, -⟩ | ⟨h, -⟩
    · simp [go, decodeSpec, spec]
    all_goals simp at h
  | [_], _, hp => rcases hp with ⟨h, -⟩ | ⟨h, -⟩ | ⟨h, -⟩ <;> simp at h
  | [c1, c2], _, hp =>
    rcases hp with ⟨h, -⟩ | ⟨-, rfl⟩ | ⟨h, -⟩
    · simp at h
    swap
    · simp at h
    obtain ⟨v1, h1⟩ := isSome_iff.1 (ht c1 (by simp))
    obtain ⟨v2, h2⟩ := isSome_iff.1 (ht c2 (by simp))
    have hb := byte1 v1 v2 (value_lt h1) (value_lt h2)
    have := value_lt h1
    have := value_lt h2
    simp only [List.cons_append, List.nil_append, go, ne_pad_of_value h1, ne_pad_of_value h2, h1, h2, if_false,
      if_true]
    simp only [decodeSpec, List.map_cons, List.map_nil, valueN_of h1, valueN_of h2, spec]
    simp [uint8_eq_toUInt8 (x := v1 <<< 2 ||| v2 >>> 4) (n := (v1.toNat * 64 + v2.toNat) * 64 * 64 / 65536)
      (by rw [hb]; omega)]
  | [c1, c2, c3], _, hp =>
    rcases hp with ⟨h, -⟩ | ⟨h, -⟩ | ⟨-, rfl⟩
    · simp at h
    · simp at h
    obtain ⟨v1, h1⟩ := isSome_iff.1 (ht c1 (by simp))
    obtain ⟨v2, h2⟩ := isSome_iff.1 (ht c2 (by simp))
    obtain ⟨v3, h3⟩ := isSome_iff.1 (ht c3 (by simp))
    have hb1 := byte1 v1 v2 (value_lt h1) (value_lt h2)
    have hb2 := byte2 v2 v3 (value_lt h3)
    have := value_lt h1
    have := value_lt h2
    have := value_lt h3
    simp only [List.cons_append, List.nil_append, go, ne_pad_of_value h1, ne_pad_of_value h2, ne_pad_of_value h3,
      h1, h2, h3, if_false, if_true]
    simp only [decodeSpec, List.map_cons, List.map_nil, valueN_of h1, valueN_of h2, valueN_of h3, spec]
    simp [uint8_eq_toUInt8 (x := v1 <<< 2 ||| v2 >>> 4)
        (n := ((v1.toNat * 64 + v2.toNat) * 64 + v3.toNat) * 64 / 65536) (by rw [hb1]; omega),
      uint8_eq_toUInt8 (x := (v2 &&& 0x0F) <<< 4 ||| v3 >>> 2)
        (n := ((v1.toNat * 64 + v2.toNat) * 64 + v3.toNat) * 64 / 256 % 256) (by rw [hb2]; omega)]

theorem padOk_mod (n : ℕ) (pad : Bytes) : PadOk n pad ↔ PadOk (n % 4) pad := by
  simp [PadOk]

/-- Padded base64 is read as its specification says (strict or lenient). -/
theorem decodePython_of_shape (strict : Bool) {d pad : Bytes} (hd : ∀ c ∈ d, (value c).isSome)
    (hp : PadOk d.length pad) : decodePython (d ++ pad) strict = .ok (decodeSpec d) := by
  have hhead : ¬ (strict = true ∧ (d ++ pad).head? = some 0x3D) := by
    rintro ⟨-, h⟩
    cases d with
    | nil =>
      rcases hp with ⟨-, rfl⟩ | ⟨h', -⟩ | ⟨h', -⟩
      · simp at h
      all_goals simp at h'
    | cons c d =>
      obtain ⟨v, hv⟩ := isSome_iff.1 (hd c (by simp))
      simp only [List.cons_append, List.head?_cons, Option.some.injEq] at h
      exact ne_pad_of_value hv h
  unfold decodePython
  rw [if_neg hhead]
  have hsplit : d = d.take (d.length / 4 * 4) ++ d.drop (d.length / 4 * 4) := (List.take_append_drop _ d).symm
  have htl : (d.take (d.length / 4 * 4)).length = d.length / 4 * 4 := by
    rw [List.length_take]
    omega
  have hdl : (d.drop (d.length / 4 * 4)).length = d.length % 4 := by
    rw [List.length_drop]
    omega
  rw [hsplit, List.append_assoc,
    go_groups strict false (by simp) _ _ 0 [] (by rw [htl]; omega) (fun c hc => hd c (List.mem_of_mem_take hc)),
    go_tail strict _ _ _ _ (fun c hc => hd c (List.mem_of_mem_drop hc)) (by rw [hdl]; omega)
      (by rw [hdl]; exact (padOk_mod _ _).1 hp),
    List.append_nil, List.reverse_reverse, ← decodeSpec_append _ _ (by rw [htl]; omega), ← hsplit]

theorem go_started_one : ∀ (s : Bytes) (i : ℕ) (left : UInt8) (pads : ℕ) (acc out : Bytes),
    go true i s 1 left pads true acc ≠ .ok out
  | [], i, left, pads, acc, out => by simp [go]
  | c :: rest, i, left, pads, acc, out => by
    simp only [go]
    by_cases hc : c = 0x3D
    · simp only [hc, if_true]
      simpa using go_started_one rest (i + 1) left pads acc out
    · simp only [hc, if_false]
      cases value c <;> simp

theorem go_started_two : ∀ (s : Bytes) (i : ℕ) (left : UInt8) (acc out : Bytes),
    go true i s 2 left 1 true acc = .ok out → s = [0x3D]
  | [], i, left, acc, out, h => by simp [go] at h
  | c :: rest, i, left, acc, out, h => by
    simp only [go] at h
    by_cases hc : c = 0x3D
    · simp only [hc, if_true] at h
      cases rest with
      | nil => simp [hc]
      | cons _ _ => simp at h
    · simp only [hc, if_false] at h
      cases hv : value c <;> simp [hv] at h

/-- What a strict run that ends well has read from a group's position `q` on: data characters, then the padding that
completes them. -/
theorem go_strict_shape : ∀ (s : Bytes) (i q : ℕ) (left : UInt8) (acc out : Bytes), q < 4 →
    go true i s q left 0 false acc = .ok out →
    ∃ d pad, s = d ++ pad ∧ (∀ c ∈ d, (value c).isSome) ∧ PadOk (q + d.length) pad
  | [], i, q, left, acc, out, hq, h => by
    simp only [go] at h
    split_ifs at h with h0
    exact ⟨[], [], by simp, by simp, Or.inl ⟨by simp [h0], rfl⟩⟩
  | c :: rest, i, q, left, acc, out, hq, h => by
    simp only [go] at h
    by_cases hc : c = 0x3D
    · subst hc
      simp only [if_true, true_and, zero_add] at h
      split_ifs at h with h1 h2 h3 h4
      · -- q = 3 and nothing after the `=`
        refine ⟨[], [0x3D], by simp_all, by simp, Or.inr (Or.inr ⟨by simp only [List.length_nil]; omega, rfl⟩)⟩
      · -- q = 2: the next character must be the last `=`
        have := go_started_two rest (i + 1) left acc out (by rwa [show q = 2 by omega] at h)
        subst this
        exact ⟨[], [0x3D, 0x3D], rfl, by simp, Or.inr (Or.inl ⟨by simp only [List.length_nil]; omega, rfl⟩)⟩
      · exact absurd (show q = 1 by omega ▸ h) (go_started_one rest (i + 1) left 0 acc out)
    · simp only [hc, if_false] at h
      cases hv : value c with
      | none => simp [hv] at h
      | some v =>
        simp only [hv, Bool.false_eq_true, and_false, if_false] at h
        have hstep : ∃ q' left' acc', q' < 4 ∧ (q' + 4 - (q + 1)) % 4 = 0 ∧
            go true (i + 1) rest q' left' 0 false acc' = .ok out := by
          split_ifs at h with h0 h1 h2
          · exact ⟨1, _, _, by omega, by omega, h⟩
          · exact ⟨2, _, _, by omega, by omega, h⟩
          · exact ⟨3, _, _, by omega, by omega, h⟩
          · exact ⟨0, _, _, by omega, by omega, h⟩
        obtain ⟨q', left', acc', hq', hmod, h'⟩ := hstep
        obtain ⟨d, pad, rfl, hd, hp⟩ := go_strict_shape rest (i + 1) q' left' acc' out hq' h'
        refine ⟨c :: d, pad, rfl, ?_, ?_⟩
        · intro x hx
          rcases List.mem_cons.1 hx with rfl | hx
          · simp [hv]
          · exact hd x hx
        · rw [padOk_mod] at hp ⊢
          simp only [List.length_cons]
          have : (q + (d.length + 1)) % 4 = (q' + d.length) % 4 := by omega
          rwa [this]

/-- **Strict acceptance is exactly padded base64**, and the bytes are the specification's. -/
theorem decodePython_strict_iff (s out : Bytes) :
    decodePython s true = .ok out ↔
      ∃ d pad, s = d ++ pad ∧ (∀ c ∈ d, (value c).isSome) ∧ PadOk d.length pad ∧ out = decodeSpec d := by
  constructor
  · intro h
    have h' := h
    unfold decodePython at h
    split_ifs at h
    obtain ⟨d, pad, rfl, hd, hp⟩ := go_strict_shape s 0 0 0 [] out (by norm_num) h
    rw [zero_add] at hp
    refine ⟨d, pad, rfl, hd, hp, ?_⟩
    rw [decodePython_of_shape true hd hp] at h'
    exact (Except.ok.inj h').symm
  · rintro ⟨d, pad, rfl, hd, hp, rfl⟩
    exact decodePython_of_shape true hd hp

/-- The lenient mode reads every strict input the same way. -/
theorem decodePython_lenient_of_strict {s out : Bytes} (h : decodePython s true = .ok out) :
    decodePython s false = .ok out := by
  obtain ⟨d, pad, rfl, hd, hp, rfl⟩ := (decodePython_strict_iff s out).1 h
  exact decodePython_of_shape false hd hp

/-! ## Encoding -/

theorem n_eq (a b c : ℕ) (hb : b < 256) (hc : c < 256) :
    (a <<< 16 ||| b <<< 8 ||| c) = a * 65536 + b * 256 + c := by
  rw [or_eq_add (a <<< 16) (b <<< 8) 16 (by rw [Nat.shiftLeft_eq]; omega) (by rw [Nat.shiftLeft_eq]; omega),
    or_eq_add _ c 8 (by rw [Nat.shiftLeft_eq, Nat.shiftLeft_eq]; omega) (by omega), Nat.shiftLeft_eq, Nat.shiftLeft_eq]

theorem idx_eq (n s : ℕ) : (n >>> s) &&& 0x3F = n / 2 ^ s % 64 := by
  have h63 : (0x3F : ℕ) = 2 ^ 6 - 1 := by norm_num
  rw [Nat.shiftRight_eq_div_pow, h63, Nat.and_two_pow_sub_one_eq_mod]

/-- A group's characters: the alphabet characters of the four 6-bit fields of `n`, `=` past the group's length + 1. -/
theorem encodeGroup_eq (a b c : UInt8) (k : ℕ) (g : Bytes) (hg : g = [a, b, c].take k) (hk : 1 ≤ k) (hk3 : k ≤ 3) :
    encodeGroup g =
      [ALPHABET.getD ((a.toNat * 65536 + (if 2 ≤ k then b.toNat else 0) * 256 +
          (if 3 ≤ k then c.toNat else 0)) / 2 ^ 18 % 64) 0x41,
        ALPHABET.getD ((a.toNat * 65536 + (if 2 ≤ k then b.toNat else 0) * 256 +
          (if 3 ≤ k then c.toNat else 0)) / 2 ^ 12 % 64) 0x41,
        if 2 ≤ k then ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 +
          (if 3 ≤ k then c.toNat else 0)) / 2 ^ 6 % 64) 0x41 else 0x3D,
        if 3 ≤ k then ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 + c.toNat) / 2 ^ 0 % 64) 0x41
          else 0x3D] := by
  subst hg
  have h1 : k = 1 ∨ k = 2 ∨ k = 3 := by omega
  unfold encodeGroup
  rcases h1 with rfl | rfl | rfl <;>
  · simp only [List.take, List.getD_cons_zero, List.getD_cons_succ, List.getD_nil, List.length_cons,
      List.length_nil, n_eq _ _ _ (UInt8.toNat_lt _) (UInt8.toNat_lt _), n_eq _ _ 0 (UInt8.toNat_lt _) (by norm_num),
      n_eq _ 0 0 (by norm_num) (by norm_num), zero_mul, idx_eq, List.range_succ, List.range_zero,
      List.nil_append, List.cons_append, List.map_cons, List.map_nil, Nat.reduceAdd, Nat.reduceLT, Nat.reduceLeDiff,
      if_true, if_false, UInt8.toNat_zero, add_zero, Nat.lt_irrefl, Nat.not_succ_le_self]

theorem toUInt8_eq {x : UInt8} {n : ℕ} (h : x.toNat = n % 256) : n.toUInt8 = x := (uint8_eq_toUInt8 h).symm

theorem isSome_char {i : ℕ} (hi : i < 64) (d : UInt8) : (value (ALPHABET.getD i d)).isSome := by
  rw [value_char hi]
  rfl

/-- `encode` writes padded base64 whose bytes are its input. -/
theorem encode_shape : ∀ x : Bytes,
    ∃ d pad, encode x = d ++ pad ∧ (∀ c ∈ d, (value c).isSome) ∧ PadOk d.length pad ∧ decodeSpec d = x
  | [] => ⟨[], [], rfl, by simp, Or.inl ⟨rfl, rfl⟩, by simp [decodeSpec, spec]⟩
  | [a] => by
    have ha := a.toNat_lt
    refine ⟨[ALPHABET.getD ((a.toNat * 65536 + 0 * 256 + 0) / 2 ^ 18 % 64) 0x41,
      ALPHABET.getD ((a.toNat * 65536 + 0 * 256 + 0) / 2 ^ 12 % 64) 0x41], [0x3D, 0x3D], ?_, ?_, ?_, ?_⟩
    · simp only [encode]
      rw [encodeGroup_eq a 0 0 1 [a] rfl le_rfl (by norm_num)]
      simp
    · intro c hc
      simp only [List.mem_cons, List.not_mem_nil, or_false] at hc
      rcases hc with rfl | rfl <;> exact isSome_char (by omega) _
    · exact Or.inr (Or.inl ⟨rfl, rfl⟩)
    · simp only [decodeSpec, List.map_cons, List.map_nil, valueN_char (Nat.mod_lt _ (by norm_num)), spec]
      rw [toUInt8_eq (x := a) (by omega)]
  | [a, b] => by
    have ha := a.toNat_lt
    have hb := b.toNat_lt
    refine ⟨[ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 + 0) / 2 ^ 18 % 64) 0x41,
      ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 + 0) / 2 ^ 12 % 64) 0x41,
      ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 + 0) / 2 ^ 6 % 64) 0x41], [0x3D], ?_, ?_, ?_, ?_⟩
    · simp only [encode]
      rw [encodeGroup_eq a b 0 2 [a, b] rfl (by norm_num) (by norm_num)]
      simp
    · intro c hc
      simp only [List.mem_cons, List.not_mem_nil, or_false] at hc
      rcases hc with rfl | rfl | rfl <;> exact isSome_char (by omega) _
    · exact Or.inr (Or.inr ⟨rfl, rfl⟩)
    · simp only [decodeSpec, List.map_cons, List.map_nil, valueN_char (Nat.mod_lt _ (by norm_num)), spec]
      rw [toUInt8_eq (x := a) (by omega), toUInt8_eq (x := b) (by omega)]
  | a :: b :: c :: rest => by
    have ha := a.toNat_lt
    have hb := b.toNat_lt
    have hc := c.toNat_lt
    obtain ⟨d, pad, he, hd, hp, hs⟩ := encode_shape rest
    let g : Bytes := [ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 + c.toNat) / 2 ^ 18 % 64) 0x41,
      ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 + c.toNat) / 2 ^ 12 % 64) 0x41,
      ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 + c.toNat) / 2 ^ 6 % 64) 0x41,
      ALPHABET.getD ((a.toNat * 65536 + b.toNat * 256 + c.toNat) / 2 ^ 0 % 64) 0x41]
    have hg : encodeGroup [a, b, c] = g := by
      rw [encodeGroup_eq a b c 3 [a, b, c] rfl (by norm_num) le_rfl]
      simp [g]
    refine ⟨g ++ d, pad, ?_, ?_, ?_, ?_⟩
    · simp only [encode, hg, he, List.append_assoc]
    · intro x hx
      rcases List.mem_append.1 hx with hx | hx
      · simp only [g, List.mem_cons, List.not_mem_nil, or_false] at hx
        rcases hx with rfl | rfl | rfl | rfl <;> exact isSome_char (by omega) _
      · exact hd x hx
    · rw [padOk_mod] at hp ⊢
      simp only [g, List.length_append, List.length_cons, List.length_nil]
      rwa [show (0 + 1 + 1 + 1 + 1 + d.length) % 4 = d.length % 4 by omega]
    · rw [decodeSpec_append _ _ (by simp [g]), hs]
      simp only [g, decodeSpec, List.map_cons, List.map_nil, valueN_char (Nat.mod_lt _ (by norm_num)), spec]
      rw [toUInt8_eq (x := a) (by omega), toUInt8_eq (x := b) (by omega), toUInt8_eq (x := c) (by omega)]
      rfl

/-- **Decoding what `encode` wrote gives the bytes back** (strictly, so leniently too). -/
theorem decodePython_encode (x : Bytes) : decodePython (encode x) true = .ok x := by
  obtain ⟨d, pad, he, hd, hp, hs⟩ := encode_shape x
  rw [he, decodePython_of_shape true hd hp, hs]

/-- `encode`'s output is four characters per started group of three bytes. -/
theorem encode_length : ∀ x : Bytes, (encode x).length = 4 * ((x.length + 2) / 3)
  | [] => rfl
  | [_] => by simp [encode, encodeGroup]
  | [_, _] => by simp [encode, encodeGroup]
  | a :: b :: c :: rest => by
    simp only [encode, List.length_append, encode_length rest, List.length_cons]
    simp only [encodeGroup, List.length_map, List.length_range]
    omega

theorem value_ascii {c v : UInt8} (h : value c = some v) : c.toNat < 128 := by
  unfold value at h
  split_ifs at h with h1 h2 h3 h4 h5
  · have := UInt8.le_iff_toNat_le.1 h1.2
    have h90 : (0x5A : UInt8).toNat = 90 := rfl
    omega
  · have := UInt8.le_iff_toNat_le.1 h2.2
    have h122 : (0x7A : UInt8).toNat = 122 := rfl
    omega
  · have := UInt8.le_iff_toNat_le.1 h3.2
    have h57 : (0x39 : UInt8).toNat = 57 := rfl
    omega
  · subst h4
    decide
  · subst h5
    decide

/-- `encode`'s output is ASCII. -/
theorem encode_ascii (x : Bytes) : ∀ b ∈ encode x, b.toNat < 128 := by
  obtain ⟨d, pad, he, hd, hp, -⟩ := encode_shape x
  rw [he]
  intro b hb
  rcases List.mem_append.1 hb with hb | hb
  · obtain ⟨v, hv⟩ := isSome_iff.1 (hd b hb)
    exact value_ascii hv
  · rcases hp with ⟨-, rfl⟩ | ⟨-, rfl⟩ | ⟨-, rfl⟩ <;> simp at hb <;> subst hb <;> decide

theorem spec_length : ∀ l : List ℕ,
    (spec l).length = 3 * (l.length / 4) + (if l.length % 4 = 2 then 1 else if l.length % 4 = 3 then 2 else 0)
  | [] => rfl
  | [_] => by simp [spec]
  | [_, _] => by simp [spec]
  | [_, _, _] => by simp [spec]
  | a :: b :: c :: d :: l => by
    simp only [spec, List.length_cons, spec_length l]
    have h1 : (l.length + 1 + 1 + 1 + 1) / 4 = l.length / 4 + 1 := by omega
    have h2 : (l.length + 1 + 1 + 1 + 1) % 4 = l.length % 4 := by omega
    simp only [h1, h2]
    split_ifs <;> omega

/-! ## The `X-Midstudy-Meta` header (meta.rs) -/

/-- A continuation byte, `80–BF`. -/
def cont (b : UInt8) : Bool := decide (0x80 ≤ b ∧ b ≤ 0xBF)

/-- **Well-formed UTF-8** (Rust's `String::from_utf8`): the byte sequences of Unicode's Table 3-7. ASCII; `C2–DF`
and one continuation byte; `E0 A0–BF`, `E1–EC` or `EE–EF`, `ED 80–9F` (no surrogates), then one more; `F0 90–BF`,
`F1–F3`, `F4 80–8F` (nothing above U+10FFFF), then two more. -/
def utf8Valid : Bytes → Bool
  | [] => true
  | b :: rest =>
    if b < 0x80 then utf8Valid rest
    else if 0xC2 ≤ b ∧ b ≤ 0xDF then
      match rest with
      | c :: r => cont c && utf8Valid r
      | [] => false
    else if 0xE0 ≤ b ∧ b ≤ 0xEF then
      match rest with
      | c1 :: c2 :: r =>
        (if b = 0xE0 then decide (0xA0 ≤ c1 ∧ c1 ≤ 0xBF) else if b = 0xED then decide (0x80 ≤ c1 ∧ c1 ≤ 0x9F)
          else cont c1) && cont c2 && utf8Valid r
      | _ => false
    else if 0xF0 ≤ b ∧ b ≤ 0xF4 then
      match rest with
      | c1 :: c2 :: c3 :: r =>
        (if b = 0xF0 then decide (0x90 ≤ c1 ∧ c1 ≤ 0xBF) else if b = 0xF4 then decide (0x80 ≤ c1 ∧ c1 ≤ 0x8F)
          else cont c1) && cont c2 && cont c3 && utf8Valid r
      | _ => false
    else false

/-- meta.rs `MAX_HEADER_LEN`: 16 KiB of base64. -/
def MAX_HEADER_LEN : ℕ := 16 * 1024

/-- Why `meta::decode` refused a header value (meta.rs `MetaError`). -/
inductive MetaErr
  | tooLong (len max : ℕ)
  | notAscii
  | base64 (e : Err)
  | notUtf8
  deriving DecidableEq, Repr

/-- **meta.rs `decode`**: the JSON text in an `X-Midstudy-Meta` value (its UTF-8 bytes): at most `maxLen` bytes,
ASCII, strict base64, UTF-8. -/
def metaDecode (header : Bytes) (maxLen : ℕ) : Except MetaErr Bytes :=
  if header.length > maxLen then .error (.tooLong header.length maxLen)
  else if !header.all (fun b => decide (b < 0x80)) then .error .notAscii
  else
    match decodePython header true with
    | .error e => .error (.base64 e)
    | .ok bytes => if utf8Valid bytes then .ok bytes else .error .notUtf8

/-- **A header is accepted exactly when** it is within the cap, ASCII, strict base64, and its bytes are UTF-8. -/
theorem metaDecode_ok_iff (h : Bytes) (m : ℕ) (s : Bytes) :
    metaDecode h m = .ok s ↔
      h.length ≤ m ∧ (∀ b ∈ h, b.toNat < 128) ∧ decodePython h true = .ok s ∧ utf8Valid s = true := by
  unfold metaDecode
  have hascii : (h.all fun b => decide (b < 0x80)) = true ↔ ∀ b ∈ h, b.toNat < 128 := by
    simp only [List.all_eq_true, decide_eq_true_eq]
    exact forall₂_congr fun b _ => UInt8.lt_iff_toNat_lt
  by_cases hl : h.length > m
  · simp only [hl, if_true, reduceCtorEq, false_iff, not_and]
    intro h'
    omega
  · simp only [hl, if_false]
    by_cases ha : (h.all fun b => decide (b < 0x80)) = true
    · simp only [ha, Bool.not_true, Bool.false_eq_true, if_false]
      cases hd : decodePython h true with
      | error e => simp
      | ok bytes =>
        by_cases hu : utf8Valid bytes = true
        · simp only [hu, if_true, Except.ok.injEq]
          constructor
          · rintro rfl
            exact ⟨by omega, hascii.1 ha, rfl, hu⟩
          · rintro ⟨-, -, h1, -⟩
            exact h1
        · simp only [hu, Bool.false_eq_true, if_false, reduceCtorEq, false_iff, not_and, Except.ok.injEq]
          rintro - - rfl
          exact hu
    · simp only [Bool.not_eq_true] at ha
      simp only [ha, Bool.not_false, if_true, reduceCtorEq, false_iff, not_and]
      intro _ hb
      have := hascii.2 hb
      simp_all

/-- **A header made from UTF-8 text is read back as that text** (when the base64 fits under the cap). -/
theorem metaDecode_encode {x : Bytes} {m : ℕ} (hx : utf8Valid x = true) (hm : 4 * ((x.length + 2) / 3) ≤ m) :
    metaDecode (encode x) m = .ok x :=
  (metaDecode_ok_iff _ _ _).2 ⟨by rw [encode_length]; exact hm, encode_ascii x, decodePython_encode x, hx⟩

/-- **The text is at most three quarters of the header**, so at most 12 KiB under the 16 KiB cap. -/
theorem metaDecode_length {h s : Bytes} {m : ℕ} (hok : metaDecode h m = .ok s) :
    4 * s.length ≤ 3 * h.length ∧ s.length ≤ m * 3 / 4 := by
  obtain ⟨hm, -, hd, -⟩ := (metaDecode_ok_iff h m s).1 hok
  obtain ⟨d, pad, rfl, -, hp, rfl⟩ := (decodePython_strict_iff _ _).1 hd
  have hlen : (decodeSpec d).length =
      3 * (d.length / 4) + (if d.length % 4 = 2 then 1 else if d.length % 4 = 3 then 2 else 0) := by
    simp only [decodeSpec, List.length_map]
    rw [spec_length, List.length_map]
  rw [List.length_append] at hm ⊢
  rw [hlen]
  rcases hp with ⟨h0, rfl⟩ | ⟨h2, rfl⟩ | ⟨h3, rfl⟩ <;> simp only [List.length_nil, List.length_cons] at hm ⊢ <;>
    split_ifs <;> omega

theorem metaDecode_cap {h s : Bytes} (hok : metaDecode h MAX_HEADER_LEN = .ok s) : s.length ≤ 12288 :=
  (metaDecode_length hok).2

end Midstudy.Base64
