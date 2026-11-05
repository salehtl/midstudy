import Midstudy.Jpeg.Model

/-!
# The JPEG stripper's guarantees

For every input the stripper accepts (`strip data = .ok out`):

* `strip_idem`: **stripping is idempotent**, `strip out = .ok out`;
* `strip_walk`, `strip_no_metadata`: the output reads back (`walk`) with **no APP1–APP15 and no COM segment**, APP0
  only as a plain 16-byte JFIF header, and **nothing after EOI**; `strip_isClean`: so ingest's pass-through test
  (`isClean`) accepts it;
* `strip_imageData`: **the image data is preserved**: every segment that isn't metadata (tables, frame and scan
  headers), every scan's entropy-coded data with its stuffed bytes and restart markers, and every length-less marker,
  in order, byte for byte (`imageData` of the output's items = `imageData` of the input's items).

The heart is `walk_serialize`: `walk` reads back the bytes of any well-formed item list (`ItemsOk`), up to restart
markers after a scan, which it reads as part of the scan's data (`normalize`), as the decoder does.
-/

namespace Midstudy.Jpeg

/-! ### Entropy-coded data -/

/-- Entropy-coded data as `ecsSplit` cuts it: every `FF` in it is followed by `00` or a restart marker. -/
inductive EcsOk : Bytes → Prop
  | nil : EcsOk []
  | byte {b : UInt8} {t : Bytes} : b ≠ 0xFF → EcsOk t → EcsOk (b :: t)
  | pair {c : UInt8} {t : Bytes} : (c = 0x00 ∨ isRst c = true) → EcsOk t → EcsOk (0xFF :: c :: t)

theorem ecsSplit_cons_of_ne {b : UInt8} (hb : b ≠ 0xFF) (t : Bytes) :
    ecsSplit (b :: t) = (ecsSplit t).map (fun p => (b :: p.1, p.2)) := by
  rw [ecsSplit.eq_def]
  simp [hb]

theorem ecsSplit_FF_cons (c : UInt8) (t : Bytes) :
    ecsSplit (0xFF :: c :: t) =
      if c = 0x00 ∨ isRst c = true then (ecsSplit t).map (fun p => (0xFF :: c :: p.1, p.2))
      else some ([], 0xFF :: c :: t) := by
  rw [ecsSplit.eq_def]
  simp

theorem ecsSplit_append {e : Bytes} (he : EcsOk e) (s : Bytes) :
    ecsSplit (e ++ s) = (ecsSplit s).map (fun p => (e ++ p.1, p.2)) := by
  induction he with
  | nil => simp
  | @byte b t hb _ ih =>
    rw [List.cons_append, ecsSplit_cons_of_ne hb, ih, Option.map_map]
    rfl
  | @pair c t hc _ ih =>
    rw [List.cons_append, List.cons_append, ecsSplit_FF_cons, if_pos hc, ih, Option.map_map]
    rfl

/-- Where a marker that isn't `00` or a restart marker follows an `FF`, the entropy-coded data ends. -/
theorem ecsSplit_marker {c : UInt8} (hc0 : c ≠ 0x00) (hcr : isRst c = false) (s : Bytes) :
    ecsSplit (0xFF :: c :: s) = some ([], 0xFF :: c :: s) := by
  rw [ecsSplit_FF_cons, if_neg]
  rintro (h | h)
  · exact hc0 h
  · rw [hcr] at h
    exact Bool.false_ne_true h

/-- What `ecsSplit` cuts off is entropy-coded data, and the rest starts at a real marker. -/
theorem ecsSplit_spec : ∀ (l : Bytes) {e r : Bytes}, ecsSplit l = some (e, r) →
    EcsOk e ∧ l = e ++ r ∧ ∃ c s, r = 0xFF :: c :: s ∧ c ≠ 0x00 ∧ isRst c = false
  | [], _, _, h => by simp [ecsSplit] at h
  | b :: t, e, r, h => by
    unfold ecsSplit at h
    split_ifs at h with hb
    · subst hb
      match t, h with
      | [], h => simp at h
      | c :: t', h =>
        simp only at h
        split_ifs at h with hc
        · obtain ⟨p, hp, hpe⟩ := Option.map_eq_some_iff.1 h
          obtain ⟨h1, h2, h3⟩ := ecsSplit_spec t' (e := p.1) (r := p.2) (by rw [hp])
          simp only [Prod.mk.injEq] at hpe
          rw [← hpe.1, ← hpe.2]
          exact ⟨EcsOk.pair hc h1, by rw [h2]; rfl, h3⟩
        · simp only [Option.some.injEq, Prod.mk.injEq] at h
          rw [← h.1, ← h.2]
          refine ⟨EcsOk.nil, rfl, c, t', rfl, ?_, ?_⟩
          · intro h0
            exact hc (Or.inl h0)
          · cases hr : isRst c
            · rfl
            · exact absurd (Or.inr hr) hc
    · obtain ⟨p, hp, hpe⟩ := Option.map_eq_some_iff.1 h
      obtain ⟨h1, h2, h3⟩ := ecsSplit_spec t (e := p.1) (r := p.2) (by rw [hp])
      simp only [Prod.mk.injEq] at hpe
      rw [← hpe.1, ← hpe.2]
      exact ⟨EcsOk.byte hb h1, by rw [h2]; rfl, h3⟩

theorem EcsOk.append_rst {e : Bytes} (he : EcsOk e) {m : UInt8} (hm : isRst m = true) :
    EcsOk (e ++ [0xFF, m]) := by
  induction he with
  | nil => exact EcsOk.pair (Or.inr hm) EcsOk.nil
  | byte hb _ ih => exact EcsOk.byte hb ih
  | pair hc _ ih => exact EcsOk.pair hc ih

/-! ### Well-formed items -/

/-- A segment's bytes start with their own length (at least 2). -/
def LenOk (body : Bytes) : Prop := lenField body = some body.length ∧ 2 ≤ body.length

/-- An item `walk` reads back from its bytes (EOI is only ever last). -/
def ItemOk : Item → Prop
  | .eoi => False
  | .std m => standalone m = true
  | .seg m body => m ≠ 0xFF ∧ m ≠ 0xD9 ∧ standalone m = false ∧ m ≠ 0x00 ∧ m ≠ 0xDA ∧ LenOk body
  | .scan hdr ecs => LenOk hdr ∧ EcsOk ecs

/-- Items as `walk` returns them: well-formed items, then EOI. -/
def ItemsOk (items : List Item) : Prop := ∃ its, items = its ++ [.eoi] ∧ ∀ it ∈ its, ItemOk it

theorem standalone_ne_FF {m : UInt8} (h : standalone m = true) : m ≠ 0xFF := by
  rintro rfl
  revert h
  decide

theorem isRst_standalone {m : UInt8} (h : isRst m = true) : standalone m = true := by
  simp [standalone, h]

theorem standalone_ne_D9 {m : UInt8} (h : standalone m = true) : m ≠ 0xD9 := by
  rintro rfl
  revert h
  decide

theorem standalone_ne_DA {m : UInt8} (h : standalone m = true) : m ≠ 0xDA := by
  rintro rfl
  revert h
  decide

theorem lenField_append {body : Bytes} (h : 2 ≤ body.length) (s : Bytes) :
    lenField (body ++ s) = lenField body := by
  match body, h with
  | _ :: _ :: _, _ => rfl

theorem dropFF_marker {m : UInt8} (hm : m ≠ 0xFF) (s : Bytes) : dropFF (0xFF :: m :: s) = (1, m :: s) := by
  simp [dropFF, hm]

theorem step_of_marker {m : UInt8} (hm : m ≠ 0xFF) (s : Bytes) :
    step (0xFF :: m :: s) = match stepAfter m s with
      | .error e => .error e
      | .ok (it, r') => .ok (it, 0, r') := by
  simp only [step, ne_eq, not_true_eq_false, if_false, dropFF_marker hm, Nat.sub_self]
  cases stepAfter m s <;> rfl

theorem step_eoi (s : Bytes) : step (0xFF :: 0xD9 :: s) = .ok (.eoi, 0, s) := by
  rw [step_of_marker (by decide)]
  simp [stepAfter]

theorem step_std {m : UInt8} (hm : standalone m = true) (s : Bytes) :
    step (0xFF :: m :: s) = .ok (.std m, 0, s) := by
  rw [step_of_marker (standalone_ne_FF hm)]
  simp [stepAfter, standalone_ne_D9 hm, hm]

theorem step_seg {m : UInt8} {body : Bytes} (h : ItemOk (.seg m body)) (s : Bytes) :
    step (0xFF :: m :: (body ++ s)) = .ok (.seg m body, 0, s) := by
  obtain ⟨hFF, hD9, hstd, h00, hDA, hlen, h2⟩ := h
  rw [step_of_marker hFF]
  have hl : lenField (body ++ s) = some body.length := by rw [lenField_append h2, hlen]
  simp only [stepAfter, if_neg hD9, hstd, Bool.false_eq_true, if_false, if_neg h00, hl, if_neg hDA]
  rw [if_neg (by omega), if_neg (by simp), List.take_left' rfl, List.drop_left' rfl]

theorem step_scan {hdr ecs s : Bytes} (hh : LenOk hdr) (he : ecsSplit (ecs ++ s) = some (ecs, s)) :
    step (0xFF :: 0xDA :: (hdr ++ (ecs ++ s))) = .ok (.scan hdr ecs, 0, s) := by
  obtain ⟨hlen, h2⟩ := hh
  rw [step_of_marker (by decide)]
  have hl : lenField (hdr ++ (ecs ++ s)) = some hdr.length := by rw [lenField_append h2, hlen]
  have hstd : standalone 0xDA = false := by decide
  have h3 : ¬ hdr.length < 2 := by omega
  have h4 : ¬ (hdr ++ (ecs ++ s)).length < hdr.length := by simp
  simp only [stepAfter, hstd, hl, h3, h4, List.drop_left' rfl, he, List.take_left' rfl]
  simp

/-! ### `walk`, one step at a time -/

theorem walk_of_step_eoi {l r : Bytes} {f : Nat} (h : step l = .ok (.eoi, f, r)) : walk l = .ok ([.eoi], r) := by
  rw [walk]
  split <;> simp_all

theorem walk_of_step {l r : Bytes} {it : Item} {f : Nat} (hit : it ≠ .eoi) (h : step l = .ok (it, f, r)) :
    walk l = match walk r with
      | .error e => .error e
      | .ok (items, tr) => .ok (it :: items, tr) := by
  rw [walk]
  split
  · simp_all
  · rename_i r' _ heq
    rw [h] at heq
    simp only [Except.ok.injEq, Prod.mk.injEq] at heq
    exact absurd heq.1 hit
  · rename_i it' f' r' hne heq
    rw [h] at heq
    simp only [Except.ok.injEq, Prod.mk.injEq] at heq
    obtain ⟨rfl, rfl, rfl⟩ := heq
    rfl

/-! ### Restart markers after a scan belong to it -/

/-- Restart markers right after a scan are part of its entropy-coded data (that is how `walk`, and a decoder, read
them): `normalize` moves them there. -/
def normalize : List Item → List Item
  | .scan h e :: .std m :: rest =>
    if isRst m = true then normalize (.scan h (e ++ [0xFF, m]) :: rest)
    else .scan h e :: normalize (.std m :: rest)
  | it :: rest => it :: normalize rest
  | [] => []
termination_by l => l.length

theorem normalize_merge {h e : Bytes} {m : UInt8} (hm : isRst m = true) (rest : List Item) :
    normalize (.scan h e :: .std m :: rest) = normalize (.scan h (e ++ [0xFF, m]) :: rest) := by
  rw [normalize.eq_1, if_pos hm]

/-- A scan followed by anything but a restart marker. -/
theorem normalize_scan_cons {h e : Bytes} {it : Item} (hit : ∀ m, it = .std m → isRst m = false)
    (rest : List Item) : normalize (.scan h e :: it :: rest) = .scan h e :: normalize (it :: rest) := by
  cases it with
  | std m =>
    rw [normalize.eq_1, if_neg]
    rw [hit m rfl]
    simp
  | _ =>
    rw [normalize.eq_2]
    intro _ _ _ _ h1 h2
    cases h2

theorem normalize_cons_of_not_scan {it : Item} (hit : ∀ h e, it ≠ .scan h e) (rest : List Item) :
    normalize (it :: rest) = it :: normalize rest := by
  rw [normalize.eq_2]
  intro h e _ _ h1 _
  exact hit h e h1

theorem serialize_cons (it : Item) (l : List Item) : serialize (it :: l) = ser it ++ serialize l := by
  simp [serialize]

theorem serialize_append (l l' : List Item) : serialize (l ++ l') = serialize l ++ serialize l' := by
  simp [serialize]

/-- Moving restart markers into the scan doesn't change a byte. -/
theorem serialize_normalize (l : List Item) : serialize (normalize l) = serialize l := by
  induction l using normalize.induct with
  | case1 h e m rest hm ih =>
    rw [normalize_merge hm, ih]
    simp [serialize, ser]
  | case2 h e m rest hm ih =>
    rw [normalize.eq_1, if_neg hm, serialize_cons, ih]
    simp [serialize_cons]
  | case3 it rest hit ih =>
    rw [normalize.eq_2 _ _ hit, serialize_cons, ih, serialize_cons]
  | case4 => rw [normalize.eq_3]

theorem mem_normalize {l : List Item} {it : Item} (h : it ∈ normalize l) :
    (∃ hd e, it = .scan hd e) ∨ it ∈ l := by
  induction l using normalize.induct with
  | case1 hd e m rest hm ih =>
    rw [normalize_merge hm] at h
    rcases ih h with h' | h'
    · exact Or.inl h'
    · rcases List.mem_cons.1 h' with rfl | h''
      · exact Or.inl ⟨_, _, rfl⟩
      · exact Or.inr (List.mem_cons_of_mem _ (List.mem_cons_of_mem _ h''))
  | case2 hd e m rest hm ih =>
    rw [normalize.eq_1, if_neg hm] at h
    rcases List.mem_cons.1 h with rfl | h'
    · exact Or.inl ⟨_, _, rfl⟩
    · rcases ih h' with h'' | h''
      · exact Or.inl h''
      · exact Or.inr (List.mem_cons_of_mem _ h'')
  | case3 it' rest hit ih =>
    rw [normalize.eq_2 _ _ hit] at h
    rcases List.mem_cons.1 h with rfl | h'
    · exact Or.inr (List.mem_cons_self ..)
    · rcases ih h' with h'' | h''
      · exact Or.inl h''
      · exact Or.inr (List.mem_cons_of_mem _ h'')
  | case4 =>
    rw [normalize.eq_3] at h
    simp at h

/-! ### `walk` reads back what `serialize` writes -/

/-- The bytes of an item `walk` can follow a scan with: it starts with `FF` and a byte that is neither `00` nor a
restart marker. -/
theorem ser_head {it : Item} (h : ItemOk it ∨ it = .eoi) (hrst : ∀ m, it = .std m → isRst m = false) :
    ∃ c s, ser it = 0xFF :: c :: s ∧ c ≠ 0x00 ∧ isRst c = false := by
  cases it with
  | eoi => exact ⟨0xD9, [], rfl, by decide, by decide⟩
  | std m =>
    refine ⟨m, [], rfl, ?_, hrst m rfl⟩
    rcases h with h | h
    · intro h0
      subst h0
      have h' : standalone 0 = true := h
      revert h'
      decide
    · cases h
  | seg m body =>
    rcases h with h | h
    · obtain ⟨-, -, hstd, h00, -, -⟩ := h
      refine ⟨m, body, rfl, h00, ?_⟩
      cases hr : isRst m
      · rfl
      · rw [isRst_standalone hr] at hstd
        cases hstd
    · cases h
  | scan hdr ecs => exact ⟨0xDA, hdr ++ ecs, rfl, by decide, by decide⟩

/-- The scan step of `walk_serialize` when no restart marker follows the scan: its data ends at the next item. -/
theorem walk_serialize_scan (hdr ecs : Bytes) (hs : ItemOk (.scan hdr ecs)) (rest : List Item)
    (hrest : ∀ it ∈ rest, ItemOk it) (hnext : ∀ m, (rest ++ [Item.eoi]).head? = some (.std m) → isRst m = false)
    (tr : Bytes) (ih : walk (serialize (rest ++ [.eoi]) ++ tr) = .ok (normalize (rest ++ [.eoi]), tr)) :
    walk (serialize ((Item.scan hdr ecs :: rest) ++ [.eoi]) ++ tr) =
      .ok (normalize ((Item.scan hdr ecs :: rest) ++ [.eoi]), tr) := by
  obtain ⟨it2, l2, hl⟩ : ∃ it2 l2, rest ++ [Item.eoi] = it2 :: l2 := by
    cases rest with
    | nil => exact ⟨_, _, rfl⟩
    | cons a l => exact ⟨a, l ++ [.eoi], rfl⟩
  have hit2 : ItemOk it2 ∨ it2 = .eoi := by
    have hmem : it2 ∈ rest ++ [Item.eoi] := by rw [hl]; exact List.mem_cons_self ..
    rcases List.mem_append.1 hmem with h | h
    · exact Or.inl (hrest it2 h)
    · exact Or.inr (List.mem_singleton.1 h)
  have hrst : ∀ m, it2 = .std m → isRst m = false := by
    intro m hm
    apply hnext m
    rw [hl, hm]
    rfl
  obtain ⟨c, s', hser, hc0, hcr⟩ := ser_head hit2 hrst
  have hX : serialize (rest ++ [Item.eoi]) ++ tr = 0xFF :: c :: (s' ++ serialize l2 ++ tr) := by
    rw [hl, serialize_cons, hser]
    simp
  have he : ecsSplit (ecs ++ (serialize (rest ++ [Item.eoi]) ++ tr)) =
      some (ecs, serialize (rest ++ [Item.eoi]) ++ tr) := by
    rw [ecsSplit_append hs.2, hX, ecsSplit_marker hc0 hcr]
    simp
  have e : serialize ((Item.scan hdr ecs :: rest) ++ [Item.eoi]) ++ tr =
      0xFF :: 0xDA :: (hdr ++ (ecs ++ (serialize (rest ++ [Item.eoi]) ++ tr))) := by
    simp [serialize, ser]
  rw [e, walk_of_step (by simp) (step_scan hs.1 he), ih, List.cons_append, hl, normalize_scan_cons hrst]

/-- **`walk` reads back a well-formed item list**: the items (restart markers after a scan read as part of its data)
and the bytes after EOI. -/
theorem walk_serialize (its : List Item) (hits : ∀ it ∈ its, ItemOk it) (tr : Bytes) :
    walk (serialize (its ++ [.eoi]) ++ tr) = .ok (normalize (its ++ [.eoi]), tr) := by
  match its, hits with
  | [], _ =>
    have : serialize ([] ++ [Item.eoi]) ++ tr = 0xFF :: 0xD9 :: tr := by simp [serialize, ser]
    rw [this, walk_of_step_eoi (step_eoi tr)]
    simp [normalize.eq_2, normalize.eq_3]
  | .eoi :: _, h => exact absurd (h .eoi (List.mem_cons_self ..)) id
  | .std m :: rest, h =>
    have hm : standalone m = true := h (.std m) (List.mem_cons_self ..)
    have hrest : ∀ it ∈ rest, ItemOk it := fun it hi => h it (List.mem_cons_of_mem _ hi)
    have e : serialize ((Item.std m :: rest) ++ [Item.eoi]) ++ tr =
        0xFF :: m :: (serialize (rest ++ [Item.eoi]) ++ tr) := by simp [serialize, ser]
    rw [e, walk_of_step (by simp) (step_std hm _), walk_serialize rest hrest tr, List.cons_append,
      normalize_cons_of_not_scan (by simp)]
  | .seg m body :: rest, h =>
    have hs : ItemOk (.seg m body) := h _ (List.mem_cons_self ..)
    have hrest : ∀ it ∈ rest, ItemOk it := fun it hi => h it (List.mem_cons_of_mem _ hi)
    have e : serialize ((Item.seg m body :: rest) ++ [Item.eoi]) ++ tr =
        0xFF :: m :: (body ++ (serialize (rest ++ [Item.eoi]) ++ tr)) := by simp [serialize, ser]
    rw [e, walk_of_step (by simp) (step_seg hs _), walk_serialize rest hrest tr, List.cons_append,
      normalize_cons_of_not_scan (by simp)]
  | .scan hdr ecs :: [], h =>
    exact walk_serialize_scan hdr ecs (h _ (List.mem_cons_self ..)) [] (by simp) (by simp) tr
      (walk_serialize [] (by simp) tr)
  | .scan hdr ecs :: .std m :: rest', h =>
    have hs : ItemOk (.scan hdr ecs) := h _ (List.mem_cons_self ..)
    have hrest : ∀ it ∈ Item.std m :: rest', ItemOk it := fun it hi => h it (List.mem_cons_of_mem _ hi)
    if hm : isRst m = true then
      -- the restart marker joins the scan's data: the same bytes as one longer scan
      have e : serialize ((Item.scan hdr ecs :: Item.std m :: rest') ++ [Item.eoi]) =
          serialize ((Item.scan hdr (ecs ++ [0xFF, m]) :: rest') ++ [Item.eoi]) := by
        simp [serialize, ser]
      have hs' : ∀ it ∈ Item.scan hdr (ecs ++ [0xFF, m]) :: rest', ItemOk it := by
        intro it hi
        rcases List.mem_cons.1 hi with rfl | hi
        · exact ⟨hs.1, hs.2.append_rst hm⟩
        · exact hrest it (List.mem_cons_of_mem _ hi)
      rw [e, walk_serialize _ hs' tr, List.cons_append, List.cons_append, List.cons_append,
        normalize_merge hm]
    else
      exact walk_serialize_scan hdr ecs hs (.std m :: rest') hrest
        (by
          intro m' hm'
          simp only [List.cons_append, List.head?_cons, Option.some.injEq, Item.std.injEq] at hm'
          subst hm'
          simpa using hm)
        tr (walk_serialize _ hrest tr)
  | .scan hdr ecs :: .eoi :: rest', h =>
    have hrest : ∀ it ∈ Item.eoi :: rest', ItemOk it := fun it hi => h it (List.mem_cons_of_mem _ hi)
    exact walk_serialize_scan hdr ecs (h _ (List.mem_cons_self ..)) _ hrest (by simp) tr
      (walk_serialize _ hrest tr)
  | .scan hdr ecs :: .seg m b :: rest', h =>
    have hrest : ∀ it ∈ Item.seg m b :: rest', ItemOk it := fun it hi => h it (List.mem_cons_of_mem _ hi)
    exact walk_serialize_scan hdr ecs (h _ (List.mem_cons_self ..)) _ hrest (by simp) tr
      (walk_serialize _ hrest tr)
  | .scan hdr ecs :: .scan h' e' :: rest', h =>
    have hrest : ∀ it ∈ Item.scan h' e' :: rest', ItemOk it := fun it hi => h it (List.mem_cons_of_mem _ hi)
    exact walk_serialize_scan hdr ecs (h _ (List.mem_cons_self ..)) _ hrest (by simp) tr
      (walk_serialize _ hrest tr)
termination_by its.length

/-! ### What `walk` reads is well formed -/

theorem dropFF_head_ne : ∀ (l : Bytes) {n : Nat} {m : UInt8} {r : Bytes}, dropFF l = (n, m :: r) → m ≠ 0xFF
  | [], _, _, _, h => by simp [dropFF] at h
  | b :: t, n, m, r, h => by
    unfold dropFF at h
    split_ifs at h with hb
    · simp only [Prod.mk.injEq] at h
      exact dropFF_head_ne t (n := (dropFF t).1) (Prod.ext rfl h.2)
    · simp only [Prod.mk.injEq, List.cons.injEq] at h
      obtain ⟨-, rfl, rfl⟩ := h
      exact hb

theorem lenOk_take {r : Bytes} {len : Nat} (h : lenField r = some len) (h2 : 2 ≤ len) (hl : len ≤ r.length) :
    LenOk (r.take len) := by
  obtain ⟨k, rfl⟩ : ∃ k, len = k + 2 := ⟨len - 2, by omega⟩
  match r, h, hl with
  | hi :: lo :: t, h, hl =>
    have hlen : (List.take (k + 2) (hi :: lo :: t)).length = k + 2 := by
      rw [List.length_take]
      simp only [List.length_cons] at hl ⊢
      omega
    refine ⟨?_, by rw [hlen]; omega⟩
    rw [hlen, List.take_succ_cons, List.take_succ_cons]
    exact h

theorem stepAfter_itemOk {m : UInt8} (hm : m ≠ 0xFF) {r : Bytes} {it : Item} {r' : Bytes}
    (h : stepAfter m r = .ok (it, r')) (hit : it ≠ .eoi) : ItemOk it := by
  unfold stepAfter at h
  split at h
  · simp only [Except.ok.injEq, Prod.mk.injEq] at h
    exact absurd h.1.symm hit
  rename_i hD9
  split at h
  · simp only [Except.ok.injEq, Prod.mk.injEq] at h
    rw [← h.1]
    assumption
  rename_i hstd
  split at h
  · simp at h
  rename_i h00
  split at h
  · simp at h
  rename_i len hlen
  split at h
  · simp at h
  rename_i h2
  split at h
  · simp at h
  rename_i hl
  split at h
  · rename_i hDA
    split at h
    · simp at h
    · rename_i ecs rest' he
      simp only [Except.ok.injEq, Prod.mk.injEq] at h
      rw [← h.1]
      exact ⟨lenOk_take hlen (by omega) (by omega), (ecsSplit_spec _ he).1⟩
  · rename_i hDA
    simp only [Except.ok.injEq, Prod.mk.injEq] at h
    rw [← h.1]
    refine ⟨hm, hD9, ?_, h00, hDA, lenOk_take hlen (by omega) (by omega)⟩
    simpa using hstd

theorem step_itemOk {l : Bytes} {it : Item} {f : Nat} {r : Bytes} (h : step l = .ok (it, f, r))
    (hit : it ≠ .eoi) : ItemOk it := by
  unfold step at h
  split at h
  · simp at h
  rename_i b t
  split at h
  · simp at h
  split at h
  · simp at h
  rename_i ffs m r0 hdr
  split at h
  · simp at h
  rename_i it' r' hs
  simp only [Except.ok.injEq, Prod.mk.injEq] at h
  rw [← h.1]
  exact stepAfter_itemOk (dropFF_head_ne _ hdr) hs (by rw [h.1]; exact hit)

theorem walk_of_step_error {l : Bytes} {e : Err} (h : step l = .error e) : walk l = .error e := by
  rw [walk]
  split <;> simp_all

/-- **What `walk` reads is well formed** (so `walk_serialize` applies to it). -/
theorem walk_itemsOk (l : Bytes) {items : List Item} {tr : Bytes} (h : walk l = .ok (items, tr)) :
    ItemsOk items := by
  match hs : step l with
  | .error e =>
    rw [walk_of_step_error hs] at h
    cases h
  | .ok (it, f, r) =>
    if hit : it = .eoi then
      subst hit
      rw [walk_of_step_eoi hs] at h
      simp only [Except.ok.injEq, Prod.mk.injEq] at h
      rw [← h.1]
      exact ⟨[], rfl, by simp⟩
    else
      rw [walk_of_step hit hs] at h
      match hw : walk r, h with
      | .error e, h => simp at h
      | .ok (items', tr'), h =>
        simp only [Except.ok.injEq, Prod.mk.injEq] at h
        rw [← h.1]
        obtain ⟨its, hits, hall⟩ := walk_itemsOk r hw
        refine ⟨it :: its, by rw [hits]; rfl, ?_⟩
        intro x hx
        rcases List.mem_cons.1 hx with rfl | hx
        · exact step_itemOk hs hit
        · exact hall x hx
termination_by l.length
decreasing_by exact step_length_lt hs

/-! ### What the stripper keeps -/

/-- The JFIF header the stripper writes: 16 bytes, its own length, a plain header, and kept as it is next time. -/
theorem plainJfif_spec {body h : Bytes} (hp : plainJfif body = some h) :
    h.length = 16 ∧ lenField h = some 16 ∧ isPlainJfif h = true ∧ plainJfif h = some h := by
  unfold plainJfif at hp
  split_ifs at hp with hc
  simp only [Option.some.injEq] at hp
  subst hp
  obtain ⟨h16, hj⟩ := hc
  set x := (body.drop 2).take 12 with hx
  have hxl : x.length = 12 := by rw [hx, List.length_take, List.length_drop]; omega
  have hd2 : ([0x00, 0x10] ++ x ++ [0x00, 0x00] : Bytes).drop 2 = x ++ [0x00, 0x00] := by
    rw [List.append_assoc]
    rfl
  have ht5 : (x ++ [0x00, 0x00]).take 5 = [0x4A, 0x46, 0x49, 0x46, 0x00] := by
    rw [List.take_append_of_le_length (by omega), hx, List.take_take]
    simpa using hj
  have hlen : ([0x00, 0x10] ++ x ++ [0x00, 0x00] : Bytes).length = 16 := by simp [hxl]
  refine ⟨hlen, by simp [lenField], ?_, ?_⟩
  · unfold isPlainJfif
    rw [decide_eq_true_iff]
    refine ⟨hlen, by simp, by rw [hd2, ht5], ?_⟩
    rw [List.drop_left' (by simp [hxl])]
  · unfold plainJfif
    rw [if_pos ⟨by omega, by rw [hd2, ht5]⟩, hd2, List.take_left' hxl]

theorem standalone_E0 : standalone 0xE0 = false := by decide
theorem isMetadata_E0 : isMetadata 0xE0 = false := by decide

theorem keepItem_itemOk {it it' : Item} (hk : keepItem it = some it') (hit : ItemOk it) : ItemOk it' := by
  cases it with
  | seg m body =>
    simp only [keepItem] at hk
    split_ifs at hk with hE0 hmeta
    · obtain ⟨h, hp, rfl⟩ := Option.map_eq_some_iff.1 hk
      obtain ⟨h16, hlf, -, -⟩ := plainJfif_spec hp
      exact ⟨by decide, by decide, standalone_E0, by decide, by decide, by rw [hlf, h16], by omega⟩
    · simp only [Option.some.injEq] at hk
      rw [← hk]
      exact hit
  | _ =>
    simp only [keepItem, Option.some.injEq] at hk
    rw [← hk]
    exact hit

/-- What the stripper keeps, it keeps as it is the next time. -/
theorem keepItem_of_kept {it it' : Item} (hk : keepItem it = some it') : keepItem it' = some it' := by
  cases it with
  | seg m body =>
    simp only [keepItem] at hk
    split_ifs at hk with hE0 hmeta
    · obtain ⟨h, hp, rfl⟩ := Option.map_eq_some_iff.1 hk
      simp [keepItem, (plainJfif_spec hp).2.2.2]
    · simp only [Option.some.injEq] at hk
      rw [← hk]
      simp [keepItem, hE0, hmeta]
  | _ =>
    simp only [keepItem, Option.some.injEq] at hk
    rw [← hk]
    rfl

theorem itemsOk_filterMap {items : List Item} (h : ItemsOk items) : ItemsOk (items.filterMap keepItem) := by
  obtain ⟨its, rfl, hits⟩ := h
  refine ⟨its.filterMap keepItem, by simp [List.filterMap_append, keepItem], ?_⟩
  intro it' hit'
  obtain ⟨it, hit, hk⟩ := List.mem_filterMap.1 hit'
  exact keepItem_itemOk hk (hits it hit)

theorem filterMap_eq_self {l : List Item} {f : Item → Option Item} (h : ∀ x ∈ l, f x = some x) :
    l.filterMap f = l := by
  induction l with
  | nil => rfl
  | cons a l ih =>
    rw [List.filterMap_cons, h a (List.mem_cons_self ..)]
    simp only
    rw [ih (fun x hx => h x (List.mem_cons_of_mem _ hx))]

theorem filterMap_keep_normalize {K : List Item} (hK : ∀ it ∈ K, keepItem it = some it) :
    (normalize K).filterMap keepItem = normalize K := by
  apply filterMap_eq_self
  intro x hx
  rcases mem_normalize hx with ⟨h, e, rfl⟩ | hx'
  · rfl
  · exact hK x hx'

/-! ### The stripper's guarantees -/

theorem strip_eq {data out : Bytes} (h : strip data = .ok out) :
    ∃ items tr, walk (data.drop 2) = .ok (items, tr) ∧ out = soi ++ serialize (items.filterMap keepItem) := by
  unfold strip at h
  split_ifs at h
  split at h
  · simp at h
  · rename_i items tr hw
    simp only [Except.ok.injEq] at h
    exact ⟨items, tr, hw, h.symm⟩

theorem drop_soi (x : Bytes) : (soi ++ x).drop 2 = x := rfl
theorem take_soi (x : Bytes) : (soi ++ x).take 2 = soi := rfl

/-- The output's bytes after SOI read back to the kept items (restart markers after a scan as part of its data). -/
theorem walk_kept {data : Bytes} {items : List Item} {tr : Bytes} (hw : walk (data.drop 2) = .ok (items, tr)) :
    walk ((soi ++ serialize (items.filterMap keepItem)).drop 2) = .ok (normalize (items.filterMap keepItem), []) := by
  obtain ⟨its, hits, hall⟩ := itemsOk_filterMap (walk_itemsOk _ hw)
  rw [drop_soi, hits, ← List.append_nil (serialize (its ++ [Item.eoi])), walk_serialize its hall []]

/-- **Nothing after EOI**: the output reads back to its very end; its items are the kept ones. -/
theorem strip_walk {data out : Bytes} (h : strip data = .ok out) :
    ∃ items tr, walk (data.drop 2) = .ok (items, tr) ∧
      walk (out.drop 2) = .ok (normalize (items.filterMap keepItem), []) := by
  obtain ⟨items, tr, hw, rfl⟩ := strip_eq h
  exact ⟨items, tr, hw, walk_kept hw⟩

/-- **Stripping is idempotent.** -/
theorem strip_idem {data out : Bytes} (h : strip data = .ok out) : strip out = .ok out := by
  obtain ⟨items, tr, hw, hout⟩ := strip_eq h
  obtain ⟨its, hits, -⟩ := itemsOk_filterMap (walk_itemsOk _ hw)
  have hK : ∀ it ∈ items.filterMap keepItem, keepItem it = some it := by
    intro it hit
    obtain ⟨it0, -, hk⟩ := List.mem_filterMap.1 hit
    exact keepItem_of_kept hk
  have hlen : 4 ≤ out.length := by
    rw [hout, hits, serialize_append]
    simp [soi, serialize, ser]
  subst hout
  unfold strip
  rw [if_pos ⟨hlen, take_soi _⟩, walk_kept hw]
  simp only
  rw [filterMap_keep_normalize hK, serialize_normalize]

/-- A segment the stripper keeps is not metadata, and an APP0 it keeps is a plain JFIF header. -/
theorem keepItem_seg {it : Item} {m : UInt8} {body : Bytes} (hk : keepItem it = some (.seg m body)) :
    isMetadata m = false ∧ (m = 0xE0 → isPlainJfif body = true) := by
  cases it with
  | seg m0 body0 =>
    simp only [keepItem] at hk
    split_ifs at hk with hE0 hmeta
    · obtain ⟨h, hp, he⟩ := Option.map_eq_some_iff.1 hk
      simp only [Item.seg.injEq] at he
      obtain ⟨rfl, rfl⟩ := he
      exact ⟨isMetadata_E0, fun _ => (plainJfif_spec hp).2.2.1⟩
    · simp only [Option.some.injEq, Item.seg.injEq] at hk
      obtain ⟨rfl, rfl⟩ := hk
      exact ⟨by simpa using hmeta, fun h => absurd h hE0⟩
  | _ => simp [keepItem] at hk

/-- **No APP1–APP15, no COM, APP0 only as a plain JFIF header, nothing after EOI**: the output reads back to its
end, and every segment in it is such. -/
theorem strip_no_metadata {data out : Bytes} (h : strip data = .ok out) :
    ∃ items, walk (out.drop 2) = .ok (items, []) ∧
      ∀ m body, Item.seg m body ∈ items → isMetadata m = false ∧ (m = 0xE0 → isPlainJfif body = true) := by
  obtain ⟨items, tr, hw, hw'⟩ := strip_walk h
  refine ⟨_, hw', fun m body hmem => ?_⟩
  rcases mem_normalize hmem with ⟨hd, e, he⟩ | hmem'
  · cases he
  · obtain ⟨it, -, hk⟩ := List.mem_filterMap.1 hmem'
    exact keepItem_seg hk

/-- **Ingest's pass-through test accepts what the stripper writes** (§4.3: a stripped JPEG is copied byte for
byte). -/
theorem strip_isClean {data out : Bytes} (h : strip data = .ok out) : isClean out = true := by
  obtain ⟨items, tr, hw, hout⟩ := strip_eq h
  obtain ⟨items', hw', hseg⟩ := strip_no_metadata h
  obtain ⟨its, hits, -⟩ := itemsOk_filterMap (walk_itemsOk _ hw)
  have hlen : 4 ≤ out.length := by
    rw [hout, hits, serialize_append]
    simp [soi, serialize, ser]
  have htake : out.take 2 = soi := by rw [hout]; rfl
  unfold isClean
  rw [if_pos ⟨hlen, htake⟩, hw']
  simp only [List.isEmpty_nil, Bool.true_and, List.all_eq_true]
  intro it hit
  cases it with
  | seg m body =>
    obtain ⟨hm, hE0⟩ := hseg m body hit
    simp only [hm, Bool.not_false, Bool.true_and, Bool.or_eq_true, bne_iff_ne, ne_eq]
    by_cases h0 : m = 0xE0
    · exact Or.inr (hE0 h0)
    · exact Or.inl h0
  | _ => rfl

/-! ### The image data is preserved -/

/-- What a decoder reads: every item but APP0–APP15 and COM. -/
def isImage : Item → Bool
  | .seg m _ => !(isMetadata m) && m != 0xE0
  | _ => true

/-- The image data of a JPEG's items: the bytes of everything a decoder reads (tables, frame and scan headers, each
scan's entropy-coded data with its stuffed bytes and restart markers, length-less markers, EOI), in order. -/
def imageData (items : List Item) : Bytes := serialize (items.filter isImage)

theorem imageData_cons (it : Item) (l : List Item) :
    imageData (it :: l) = (if isImage it then ser it else []) ++ imageData l := by
  unfold imageData
  rw [List.filter_cons]
  split <;> simp [serialize_cons]

theorem imageData_normalize (l : List Item) : imageData (normalize l) = imageData l := by
  induction l using normalize.induct with
  | case1 h e m rest hm ih =>
    rw [normalize_merge hm, ih, imageData_cons, imageData_cons, imageData_cons]
    simp [isImage, ser]
  | case2 h e m rest hm ih =>
    rw [normalize.eq_1, if_neg hm, imageData_cons, ih]
    simp only [imageData_cons]
  | case3 it rest hit ih =>
    rw [normalize.eq_2 _ _ hit, imageData_cons, ih, imageData_cons]
  | case4 => rw [normalize.eq_3]

theorem filterMap_cons_eq (f : Item → Option Item) (a : Item) (l : List Item) :
    (a :: l).filterMap f = (f a).toList ++ l.filterMap f := by
  cases h : f a <;> simp [h]

/-- Per item: the stripper never drops or changes anything a decoder reads. -/
theorem keepItem_filter_isImage (it : Item) : (keepItem it).toList.filter isImage = [it].filter isImage := by
  cases it with
  | seg m body =>
    by_cases hE0 : m = 0xE0
    · subst hE0
      cases hp : plainJfif body <;> simp [keepItem, hp, isImage, isMetadata_E0]
    · by_cases hmeta : isMetadata m = true
      · simp [keepItem, hE0, hmeta, isImage]
      · simp [keepItem, hE0, hmeta]
  | _ => simp [keepItem]

theorem filter_isImage_filterMap_keep (items : List Item) :
    (items.filterMap keepItem).filter isImage = items.filter isImage := by
  induction items with
  | nil => rfl
  | cons it l ih =>
    rw [filterMap_cons_eq, List.filter_append, keepItem_filter_isImage, ih, ← List.filter_append]
    rfl

/-- **The image data is preserved, byte for byte**: what a decoder reads from the output is exactly what it reads
from the input (the stripper only drops APP1–APP15, COM, fill bytes and what follows EOI, and trims APP0). -/
theorem strip_imageData {data out : Bytes} (h : strip data = .ok out) :
    ∃ items tr items', walk (data.drop 2) = .ok (items, tr) ∧ walk (out.drop 2) = .ok (items', []) ∧
      imageData items' = imageData items := by
  obtain ⟨items, tr, hw, hw'⟩ := strip_walk h
  refine ⟨items, tr, _, hw, hw', ?_⟩
  rw [imageData_normalize]
  unfold imageData
  rw [filter_isImage_filterMap_keep]

end Midstudy.Jpeg
