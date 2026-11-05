import Mathlib.Data.List.Basic
import Mathlib.Tactic.Linarith

/-!
# A model of PNG chunks and of the metadata stripper (contract §2.8 Privacy)

`core/crates/media/src/png.rs` `strip` (v1's `clean_png`): a GLB's embedded PNG textures lose their camera metadata,
"PNG: `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`", and everything after IEND; every other chunk (IHDR, PLTE, IDAT, iCCP,
gAMA, …) is copied byte for byte. CRCs aren't checked: a chunk is kept or dropped whole. Modelled on the bytes after
the signature, chunk by chunk, exactly as the Rust loop reads them; errors by kind.

Main results (for every input the stripper accepts, `strip data = .ok out`):
* `strip_idem`: stripping is idempotent;
* `strip_walk`, `strip_no_metadata`: the output reads back to its very end (nothing after IEND), and none of its
  chunks is `eXIf`, `tEXt`, `iTXt`, `zTXt` or `tIME`;
* `strip_chunks`: its chunks are exactly the input's other chunks, in order, byte for byte;
* `strip_eq_self_iff`: it leaves a PNG unchanged exactly when the PNG has none of those chunks and nothing after IEND.
-/

namespace Midstudy.Png

/-- Bytes. -/
abbrev Bytes := List UInt8

/-- Why a PNG is refused (png.rs `PngError`, without the offsets). -/
inductive Err
  | notPng | truncated | noEnd
  deriving DecidableEq, Repr

/-- The 8-byte PNG signature. -/
def signature : Bytes := [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]

/-- A big-endian 32-bit number from the first four bytes. -/
def be32 : Bytes → Nat
  | a :: b :: c :: d :: _ => ((a.toNat * 256 + b.toNat) * 256 + c.toNat) * 256 + d.toNat
  | _ => 0

def IEND : Bytes := [0x49, 0x45, 0x4E, 0x44]

/-- The chunk types the stripper drops: `eXIf`, `tEXt`, `iTXt`, `zTXt`, `tIME`. -/
def dropped (kind : Bytes) : Bool :=
  kind = [0x65, 0x58, 0x49, 0x66] || kind = [0x74, 0x45, 0x58, 0x74] || kind = [0x69, 0x54, 0x58, 0x74] ||
    kind = [0x7A, 0x54, 0x58, 0x74] || kind = [0x74, 0x49, 0x4D, 0x45]

/-- A chunk: its type, and all its bytes (length, type, data and CRC). -/
structure Chunk where
  kind : Bytes
  bytes : Bytes
  deriving DecidableEq, Repr

theorem walk_dec {l : Bytes} (h : ¬ l.length < 12) : (l.drop (12 + be32 l)).length < l.length := by
  rw [List.length_drop]
  omega

/-- The chunks up to and including IEND, and the bytes after it (png.rs `strip`'s loop). -/
def walk (l : Bytes) : Except Err (List Chunk × Bytes) :=
  if _h : l.length < 12 then .error .noEnd
  else if l.length < 12 + be32 l then .error .truncated
  else if (l.drop 4).take 4 = IEND then .ok ([⟨(l.drop 4).take 4, l.take (12 + be32 l)⟩], l.drop (12 + be32 l))
  else
    match walk (l.drop (12 + be32 l)) with
    | .error e => .error e
    | .ok (cs, tr) => .ok (⟨(l.drop 4).take 4, l.take (12 + be32 l)⟩ :: cs, tr)
termination_by l.length
decreasing_by exact walk_dec _h

/-- Chunks' bytes, in order. -/
def serialize (cs : List Chunk) : Bytes := cs.flatMap Chunk.bytes

/-- **The stripper** (png.rs `strip`, v1's `clean_png`). -/
def strip (data : Bytes) : Except Err Bytes :=
  if data.take 8 = signature then
    match walk (data.drop 8) with
    | .error e => .error e
    | .ok (cs, _) => .ok (signature ++ serialize (cs.filter fun c => !dropped c.kind))
  else .error .notPng

/-! ### Well-formed chunks read back -/

/-- A chunk `walk` reads back: its length field gives its size, its type is bytes 4–7. -/
def ChunkOk (c : Chunk) : Prop :=
  12 ≤ c.bytes.length ∧ c.bytes.length = 12 + be32 c.bytes ∧ c.kind = (c.bytes.drop 4).take 4

/-- Chunks as `walk` returns them: well-formed, IEND last and only there. -/
def ChunksOk (cs : List Chunk) : Prop :=
  ∃ body last, cs = body ++ [last] ∧ (∀ c ∈ body, ChunkOk c ∧ c.kind ≠ IEND) ∧ ChunkOk last ∧ last.kind = IEND

theorem be32_append {l : Bytes} (h : 4 ≤ l.length) (r : Bytes) : be32 (l ++ r) = be32 l := by
  match l, h with
  | _ :: _ :: _ :: _ :: _, _ => rfl

theorem be32_take {n : Nat} (h : 4 ≤ n) (l : Bytes) : be32 (l.take n) = be32 l := by
  obtain ⟨k, rfl⟩ : ∃ k, n = k + 4 := ⟨n - 4, by omega⟩
  match l with
  | a :: b :: c :: d :: t => simp [be32, List.take_succ_cons]
  | [] => rfl
  | [_] => rfl
  | [_, _] => rfl
  | [_, _, _] => rfl

theorem walk_cons {c : Chunk} (hc : ChunkOk c) (rest : Bytes) :
    walk (c.bytes ++ rest) =
      if c.kind = IEND then .ok ([c], rest)
      else match walk rest with
        | .error e => .error e
        | .ok (cs, tr) => .ok (c :: cs, tr) := by
  obtain ⟨h12, hlen, hkind⟩ := hc
  have hb : be32 (c.bytes ++ rest) = be32 c.bytes := be32_append (by omega) rest
  have hk : ((c.bytes ++ rest).drop 4).take 4 = c.kind := by
    rw [hkind, List.drop_append_of_le_length (by omega), List.take_append_of_le_length (by simp; omega)]
  have ht : (c.bytes ++ rest).take (12 + be32 c.bytes) = c.bytes := by
    rw [← hlen, List.take_left' rfl]
  have hd : (c.bytes ++ rest).drop (12 + be32 c.bytes) = rest := by
    rw [← hlen, List.drop_left' rfl]
  rw [walk, dif_neg (by simp; omega), if_neg (by rw [hb]; simp; omega)]
  simp only [hb, hk, ht, hd]

/-- **`walk` reads back well-formed chunks**, and the bytes after IEND. -/
theorem walk_serialize : ∀ (body : List Chunk) (last : Chunk), (∀ c ∈ body, ChunkOk c ∧ c.kind ≠ IEND) →
    ChunkOk last → last.kind = IEND → ∀ tr, walk (serialize (body ++ [last]) ++ tr) = .ok (body ++ [last], tr)
  | [], last, _, hl, hI, tr => by
    simp only [List.nil_append, serialize, List.flatMap_cons, List.flatMap_nil, List.append_nil]
    rw [walk_cons hl, if_pos hI]
  | c :: body, last, hb, hl, hI, tr => by
    have hc := hb c (List.mem_cons_self ..)
    have ih := walk_serialize body last (fun c' h' => hb c' (List.mem_cons_of_mem _ h')) hl hI tr
    have e : serialize ((c :: body) ++ [last]) ++ tr = c.bytes ++ (serialize (body ++ [last]) ++ tr) := by
      simp [serialize]
    rw [e, walk_cons hc.1, if_neg hc.2, ih]
    rfl

/-- **What `walk` reads is well formed.** -/
theorem walk_chunksOk (l : Bytes) {cs : List Chunk} {tr : Bytes} (h : walk l = .ok (cs, tr)) : ChunksOk cs := by
  rw [walk] at h
  split_ifs at h with h1 h2 h3
  · -- IEND
    simp only [Except.ok.injEq, Prod.mk.injEq] at h
    rw [← h.1]
    have hlen : (l.take (12 + be32 l)).length = 12 + be32 l := by rw [List.length_take]; omega
    refine ⟨[], _, rfl, by simp, ⟨?_, ?_, ?_⟩, h3⟩
    · show 12 ≤ (l.take (12 + be32 l)).length
      omega
    · show (l.take (12 + be32 l)).length = 12 + be32 (l.take (12 + be32 l))
      rw [hlen, be32_take (by omega) l]
    · show (l.drop 4).take 4 = ((l.take (12 + be32 l)).drop 4).take 4
      rw [List.drop_take, List.take_take]
      congr 1
      omega
  · match hw : walk (l.drop (12 + be32 l)), h with
    | .error e, h => simp at h
    | .ok (cs', tr'), h =>
      simp only [Except.ok.injEq, Prod.mk.injEq] at h
      rw [← h.1]
      obtain ⟨body, last, hcs, hbody, hlast, hI⟩ := walk_chunksOk _ hw
      have hlen : (l.take (12 + be32 l)).length = 12 + be32 l := by rw [List.length_take]; omega
      refine ⟨⟨(l.drop 4).take 4, l.take (12 + be32 l)⟩ :: body, last, by rw [hcs]; rfl, ?_, hlast, hI⟩
      intro c hc
      rcases List.mem_cons.1 hc with rfl | hc
      · refine ⟨⟨?_, ?_, ?_⟩, h3⟩
        · show 12 ≤ (l.take (12 + be32 l)).length
          omega
        · show (l.take (12 + be32 l)).length = 12 + be32 (l.take (12 + be32 l))
          rw [hlen, be32_take (by omega) l]
        · show (l.drop 4).take 4 = ((l.take (12 + be32 l)).drop 4).take 4
          rw [List.drop_take, List.take_take]
          congr 1
          omega
      · exact hbody c hc
termination_by l.length
decreasing_by exact walk_dec h1

/-- `walk` consumes exactly the chunks' bytes, then the bytes after IEND. -/
theorem walk_spec (l : Bytes) {cs : List Chunk} {tr : Bytes} (h : walk l = .ok (cs, tr)) :
    l = serialize cs ++ tr := by
  rw [walk] at h
  split_ifs at h with h1 h2 h3
  · simp only [Except.ok.injEq, Prod.mk.injEq] at h
    rw [← h.1, ← h.2]
    simp [serialize]
  · match hw : walk (l.drop (12 + be32 l)), h with
    | .error e, h => simp at h
    | .ok (cs', tr'), h =>
      simp only [Except.ok.injEq, Prod.mk.injEq] at h
      rw [← h.1, ← h.2]
      have ih := walk_spec _ hw
      conv_lhs => rw [← List.take_append_drop (12 + be32 l) l, ih]
      simp [serialize]
termination_by l.length
decreasing_by exact walk_dec h1

/-! ### The stripper's guarantees -/

/-- What the stripper keeps. -/
def keep (c : Chunk) : Bool := !dropped c.kind

theorem dropped_IEND : dropped IEND = false := by decide

theorem chunksOk_filter {cs : List Chunk} (h : ChunksOk cs) : ChunksOk (cs.filter keep) := by
  obtain ⟨body, last, rfl, hbody, hlast, hI⟩ := h
  refine ⟨body.filter keep, last, ?_, ?_, hlast, hI⟩
  · rw [List.filter_append]
    simp [keep, hI, dropped_IEND]
  · intro c hc
    exact hbody c (List.mem_of_mem_filter hc)

theorem strip_eq {data out : Bytes} (h : strip data = .ok out) :
    ∃ cs tr, walk (data.drop 8) = .ok (cs, tr) ∧ out = signature ++ serialize (cs.filter keep) := by
  unfold strip at h
  split_ifs at h
  split at h
  · simp at h
  · rename_i cs tr hw
    simp only [Except.ok.injEq] at h
    exact ⟨cs, tr, hw, h.symm⟩

theorem drop_signature (x : Bytes) : (signature ++ x).drop 8 = x := rfl
theorem take_signature (x : Bytes) : (signature ++ x).take 8 = signature := rfl

theorem walk_kept {l : Bytes} {cs : List Chunk} {tr : Bytes} (hw : walk l = .ok (cs, tr)) :
    walk (serialize (cs.filter keep)) = .ok (cs.filter keep, []) := by
  obtain ⟨body, last, hcs, hbody, hlast, hI⟩ := chunksOk_filter (walk_chunksOk _ hw)
  rw [hcs, ← List.append_nil (serialize (body ++ [last])), walk_serialize body last hbody hlast hI []]

/-- **Nothing after IEND, and the output's chunks are exactly the input's kept chunks, byte for byte.** -/
theorem strip_chunks {data out : Bytes} (h : strip data = .ok out) :
    ∃ cs tr, walk (data.drop 8) = .ok (cs, tr) ∧ walk (out.drop 8) = .ok (cs.filter keep, []) := by
  obtain ⟨cs, tr, hw, rfl⟩ := strip_eq h
  exact ⟨cs, tr, hw, by rw [drop_signature]; exact walk_kept hw⟩

/-- **No `eXIf`, `tEXt`, `iTXt`, `zTXt` or `tIME` chunk in the output, and nothing after IEND.** -/
theorem strip_no_metadata {data out : Bytes} (h : strip data = .ok out) :
    ∃ cs, walk (out.drop 8) = .ok (cs, []) ∧ ∀ c ∈ cs, dropped c.kind = false := by
  obtain ⟨cs, tr, -, hw'⟩ := strip_chunks h
  refine ⟨_, hw', fun c hc => ?_⟩
  have := (List.mem_filter.1 hc).2
  simpa [keep] using this

/-- **Stripping is idempotent.** -/
theorem strip_idem {data out : Bytes} (h : strip data = .ok out) : strip out = .ok out := by
  obtain ⟨cs, tr, hw, rfl⟩ := strip_eq h
  unfold strip
  rw [if_pos (take_signature _), drop_signature, walk_kept hw]
  simp only [Except.ok.injEq]
  rw [List.filter_filter]
  simp [keep]
  rfl

/-- **The stripper leaves a PNG unchanged exactly when it has none of those chunks and nothing after IEND.** -/
theorem strip_eq_self_iff (x : Bytes) :
    strip x = .ok x ↔
      x.take 8 = signature ∧ ∃ cs, walk (x.drop 8) = .ok (cs, []) ∧ ∀ c ∈ cs, dropped c.kind = false := by
  constructor
  · intro h
    refine ⟨?_, strip_no_metadata h⟩
    obtain ⟨cs, tr, -, hout⟩ := strip_eq h
    rw [hout]
    rfl
  · rintro ⟨hsig, cs, hw, hnone⟩
    have hx : x = signature ++ serialize cs := by
      rw [← List.take_append_drop 8 x, hsig, walk_spec _ hw, List.append_nil]
    unfold strip
    rw [if_pos hsig, hw]
    simp only [Except.ok.injEq]
    rw [List.filter_eq_self.2 (fun c hc => by simp [hnone c hc]), hx]

end Midstudy.Png
