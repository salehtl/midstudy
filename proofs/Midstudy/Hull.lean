import Mathlib.Data.Real.Basic
import Mathlib.Tactic

/-!
# Convex hulls (k-geom LEAN.md property 17; hull.rs `convex_hull`, `point_in_hull`)

v1's `convexHull` (planner/engine.js), which `core/crates/geom/src/hull.rs` reimplements in a buffer: Andrew's
monotone chain over the points sorted by x then y, popping while `cross(o, a, b) ≤ 0`, the output the lower chain and
the upper chain (the same rule over the points in reverse) each without its last point; fewer than 3 points come back
sorted. `pointInHull(h, q)`: at least 3 points and `q` on or left of every edge. A press on a piece selects it (§4.5)
when it falls in the hull of the piece's projected corners or within a few pixels of it (v1's `hitItemAt`, hull.rs
`hull_hit`). Over ℝ, exactly:

* `hull_vertices`: **every vertex of the hull is an input point**;
* `hull_contains`: **every input point is in the hull**: on or left of every edge (`pointInHull` whenever the hull has
  at least 3 vertices);
* `hull_turns_left`: **every turn of the hull is strictly left** unless the points are all on one line: inside each
  chain (`chain_convex`) and where the chains meet, at the rightmost and the leftmost point (`junction_right`,
  `junction_left`).

The proof works on one chain at a time (the stack, top first): every processed point stays on or left of every edge
of the stack (`Inv.left`), by a monotonicity of turns over vectors in the right half plane (`cr_trans`). The upper
chain is the lower chain of the points turned by 180° (`upper_eq`). In f64 the Rust is checked by geom's property
test `hull_contains_its_points` (up to rounding) and the differential test against v1.
-/

noncomputable section

namespace Midstudy.Hull

/-- A point (x, y). -/
abbrev P2 := ℝ × ℝ

/-- hull.rs `cross(o, a, b)`: positive when `o → a → b` turns left (counterclockwise, x right, y up). -/
def cross (o a b : P2) : ℝ := (a.1 - o.1) * (b.2 - o.2) - (a.2 - o.2) * (b.1 - o.1)

/-- v1's sort order over ℝ (`by_x_then_y`): by x, then y. -/
def LexLe (a b : P2) : Prop := a.1 < b.1 ∨ (a.1 = b.1 ∧ a.2 ≤ b.2)

/-- One point onto the stack (top first): pop while the two on top and `p` don't turn left, then push `p`. -/
def push (p : P2) : List P2 → List P2
  | b :: a :: rest => if cross a b p ≤ 0 then push p (a :: rest) else p :: b :: a :: rest
  | s => p :: s

/-- The stack (top first) after pushing the points in order. -/
def chain (l : List P2) : List P2 := l.foldl (fun s p => push p s) []

/-- **v1's `convexHull`** on sorted points (`lo.slice(0, -1).concat(hi.slice(0, -1))`). -/
def hullOfSorted (s : List P2) : List P2 :=
  if s.length < 3 then s else (chain s).reverse.dropLast ++ (chain s.reverse).reverse.dropLast

open Classical in
/-- The sort as a comparison. -/
def lexB (a b : P2) : Bool := decide (LexLe a b)

/-- **hull.rs `convex_hull`** over ℝ: sort by x then y, then the chains. (Equal points under the order are equal, so
every sort that orders them gives the same list.) -/
def convexHull (pts : List P2) : List P2 := hullOfSorted (pts.mergeSort lexB)

/-- hull.rs `point_in_hull`: at least 3 points, and `q` on or left of every edge `prev → b`, `prev` starting at the
last point. -/
def pointInHull (h : List P2) (q : P2) : Prop :=
  3 ≤ h.length ∧ List.IsChain (fun a b => 0 ≤ cross a b q) (h.getLastD (0, 0) :: h)

/-! ## Turns -/

/-- The 2D cross product of two vectors. -/
def cr (u v : P2) : ℝ := u.1 * v.2 - u.2 * v.1

theorem cross_eq (o a b : P2) : cross o a b = cr (a - o) (b - o) := by
  simp [cross, cr]

/-- **Turns are monotone in the right half plane**: for vectors `u`, `v`, `w` lexicographically ≥ 0 with `v ≠ 0`,
`u → v` and `v → w` turning left (or straight) make `u → w` turn left (or straight). -/
theorem cr_trans (u1 u2 v1 v2 w1 w2 : ℝ) (hu : 0 < u1 ∨ (u1 = 0 ∧ 0 ≤ u2)) (hv : 0 < v1 ∨ (v1 = 0 ∧ 0 < v2))
    (hw : 0 < w1 ∨ (w1 = 0 ∧ 0 ≤ w2)) (h1 : 0 ≤ u1 * v2 - u2 * v1) (h2 : 0 ≤ v1 * w2 - v2 * w1) :
    0 ≤ u1 * w2 - u2 * w1 := by
  have hu1 : 0 ≤ u1 := by rcases hu with h | ⟨h, -⟩ <;> linarith
  have hw1 : 0 ≤ w1 := by rcases hw with h | ⟨h, -⟩ <;> linarith
  rcases hv with hv | ⟨hv1, hv2⟩
  · have key : v1 * (u1 * w2 - u2 * w1) = (u1 * v2 - u2 * v1) * w1 + (v1 * w2 - v2 * w1) * u1 := by ring
    have : 0 ≤ v1 * (u1 * w2 - u2 * w1) := by rw [key]; positivity
    by_contra hneg
    have := mul_neg_of_pos_of_neg hv (not_le.1 hneg)
    linarith
  · subst hv1
    have hw0 : w1 = 0 := by nlinarith
    subst hw0
    have hw2 : 0 ≤ w2 := by rcases hw with h | ⟨-, h⟩ <;> [exact absurd h (lt_irrefl 0); exact h]
    nlinarith

theorem lexLe_refl (a : P2) : LexLe a a := Or.inr ⟨rfl, le_rfl⟩

theorem lexLe_trans {a b c : P2} (h1 : LexLe a b) (h2 : LexLe b c) : LexLe a c := by
  unfold LexLe at *
  rcases h1 with h1 | ⟨h1, h1'⟩ <;> rcases h2 with h2 | ⟨h2, h2'⟩
  · exact Or.inl (h1.trans h2)
  · exact Or.inl (h2 ▸ h1)
  · exact Or.inl (h1 ▸ h2)
  · exact Or.inr ⟨h1.trans h2, h1'.trans h2'⟩

theorem lexLe_total (a b : P2) : LexLe a b ∨ LexLe b a := by
  unfold LexLe
  rcases lt_trichotomy a.1 b.1 with h | h | h
  · exact Or.inl (Or.inl h)
  · rcases le_total a.2 b.2 with h' | h'
    · exact Or.inl (Or.inr ⟨h, h'⟩)
    · exact Or.inr (Or.inr ⟨h.symm, h'⟩)
  · exact Or.inr (Or.inl h)

theorem lexLe_antisymm {a b : P2} (h1 : LexLe a b) (h2 : LexLe b a) : a = b := by
  unfold LexLe at *
  rcases h1 with h1 | ⟨h1, h1'⟩ <;> rcases h2 with h2 | ⟨h2, h2'⟩
  · exact absurd (h1.trans h2) (lt_irrefl _)
  · exact absurd (h2 ▸ h1) (lt_irrefl _)
  · exact absurd (h1 ▸ h2) (lt_irrefl _)
  · exact Prod.ext h1 (le_antisymm h1' h2')

/-- `b - a` is lexicographically ≥ 0. -/
theorem sub_nonneg_of_lexLe {a b : P2} (h : LexLe a b) : 0 < b.1 - a.1 ∨ (b.1 - a.1 = 0 ∧ 0 ≤ b.2 - a.2) := by
  rcases h with h | ⟨h, h'⟩
  · exact Or.inl (by linarith)
  · exact Or.inr ⟨by linarith, by linarith⟩

/-- … and > 0 when `a ≠ b`. -/
theorem sub_pos_of_lexLe {a b : P2} (h : LexLe a b) (hne : a ≠ b) :
    0 < b.1 - a.1 ∨ (b.1 - a.1 = 0 ∧ 0 < b.2 - a.2) := by
  rcases h with h | ⟨h, h'⟩
  · exact Or.inl (by linarith)
  · refine Or.inr ⟨by linarith, ?_⟩
    rcases h'.lt_or_eq with h' | h'
    · linarith
    · exact absurd (Prod.ext h h') hne

/-- (T1) A pop keeps the points above: `q` left of `s → p` and `s` left of `s' → p` put `q` left of `s' → p`
(vectors from `p`). -/
theorem turn_pop_above {s' s p q : P2} (h1 : LexLe s' p) (h2 : LexLe s p) (h3 : LexLe q p) (hne : s ≠ p)
    (hq : 0 ≤ cross s p q) (hs : 0 ≤ cross s' p s) : 0 ≤ cross s' p q := by
  have hu := sub_nonneg_of_lexLe h3
  have hv := sub_pos_of_lexLe h2 hne
  have hw := sub_nonneg_of_lexLe h1
  have := cr_trans (p.1 - q.1) (p.2 - q.2) (p.1 - s.1) (p.2 - s.2) (p.1 - s'.1) (p.2 - s'.2) hu hv hw
    (by unfold cross at hq; nlinarith) (by unfold cross at hs; nlinarith)
  unfold cross
  nlinarith

/-- (T2) A pop keeps the points between: `q` left of `s' → s` and `s` left of `s' → p` put `q` left of `s' → p`
(vectors from `s'`). -/
theorem turn_pop_between {s' s p q : P2} (h1 : LexLe s' s) (h2 : LexLe s' p) (h3 : LexLe s' q) (hne : s' ≠ s)
    (hq : 0 ≤ cross s' s q) (hs : 0 ≤ cross s' p s) : 0 ≤ cross s' p q := by
  have hu := sub_nonneg_of_lexLe h2
  have hv := sub_pos_of_lexLe h1 hne
  have hw := sub_nonneg_of_lexLe h3
  have := cr_trans (p.1 - s'.1) (p.2 - s'.2) (s.1 - s'.1) (s.2 - s'.2) (q.1 - s'.1) (q.2 - s'.2) hu hv hw
    (by unfold cross at hs; nlinarith) (by unfold cross at hq; nlinarith)
  unfold cross
  nlinarith

/-- (T3) The new edge keeps the points below the top: `q ≤ t` left of `a → t`, and `p` strictly left of it, put `q`
left of `t → p` (vectors from `t`). -/
theorem turn_below {a t p q : P2} (h1 : LexLe a t) (h2 : LexLe t p) (h3 : LexLe q t)
    (hq : 0 ≤ cross a t q) (hp : 0 < cross a t p) : 0 ≤ cross t p q := by
  have hne : a ≠ t := by
    rintro rfl
    simp [cross] at hp
  have hu := sub_nonneg_of_lexLe h3
  have hv := sub_pos_of_lexLe h1 hne
  have hw := sub_nonneg_of_lexLe h2
  have := cr_trans (t.1 - q.1) (t.2 - q.2) (t.1 - a.1) (t.2 - a.2) (p.1 - t.1) (p.2 - t.2) hu hv hw
    (by unfold cross at hq; nlinarith) (by unfold cross at hp; nlinarith)
  unfold cross
  nlinarith

/-- (T4) Down a convex chain: `p` strictly left of `y → z` and `x → y → z` turning left put `p` strictly left of
`x → y`. -/
theorem turn_down {x y z p : P2} (h1 : LexLe x y) (h2 : LexLe y z) (h3 : LexLe z p)
    (hc : 0 < cross x y z) (hp : 0 ≤ cross y z p) : 0 < cross x y p := by
  have hne : y ≠ z := by
    rintro rfl
    simp only [cross] at hc
    linarith [mul_comm (y.1 - x.1) (y.2 - x.2)]
  have hu := sub_nonneg_of_lexLe h1
  have hv := sub_pos_of_lexLe h2 hne
  have hw := sub_nonneg_of_lexLe h3
  have := cr_trans (y.1 - x.1) (y.2 - x.2) (z.1 - y.1) (z.2 - y.2) (p.1 - z.1) (p.2 - z.2) hu hv hw
    (by unfold cross at hc; nlinarith) (by unfold cross at hp; nlinarith)
  unfold cross at hc ⊢
  nlinarith

/-! ## One chain -/

/-- Every edge of the stack (top first: `x` above `y` is the chain's edge `y → x`) has `q` on or left of it. -/
def LeftAll (q : P2) (S : List P2) : Prop := List.IsChain (fun x y => 0 ≤ cross y x q) S

/-- Consecutive triples of the stack turn strictly left (`z` above `y` above `x`: `x → y → z`). -/
def Convex : List P2 → Prop
  | z :: y :: x :: rest => 0 < cross x y z ∧ Convex (y :: x :: rest)
  | _ => True

/-- The stack's invariant over the points `P` processed so far. -/
structure Inv (P S : List P2) : Prop where
  sub : ∀ v ∈ S, v ∈ P
  sorted : S.Pairwise (fun x y => LexLe y x)
  convex : Convex S
  left : ∀ q ∈ P, LeftAll q S
  bottom : ∀ b ∈ S.getLast?, ∀ q ∈ P, LexLe b q

theorem cross_self (o a : P2) : cross o a o = 0 := by simp [cross]

theorem cross_self' (o a : P2) : cross o a a = 0 := by
  simp only [cross]
  ring

theorem cross_rot (o a b : P2) : cross o a b = cross a b o := by
  simp only [cross]
  ring

theorem cross_swap (o a b : P2) : cross o b a = - cross o a b := by
  simp only [cross]
  ring

/-- Under the top of a convex stack whose top edge has `p` strictly on its left, every edge has `p` on its left. -/
theorem leftAll_of_top (p : P2) : ∀ (rest : List P2) (b a : P2), Convex (b :: a :: rest) →
    (b :: a :: rest).Pairwise (fun x y => LexLe y x) → 0 < cross a b p → LexLe b p → LeftAll p (b :: a :: rest)
  | [], b, a, _, _, hp, _ => by
    simp only [LeftAll, List.isChain_cons_cons, List.isChain_singleton, and_true]
    exact hp.le
  | c :: rest, b, a, hc, hs, hp, hb => by
    simp only [LeftAll, List.isChain_cons_cons] at *
    refine ⟨hp.le, ?_⟩
    have hab : LexLe a b := List.rel_of_pairwise_cons hs (by simp)
    have hs' := List.Pairwise.of_cons hs
    have hca : LexLe c a := List.rel_of_pairwise_cons hs' (by simp)
    have hc' : 0 < cross c a b := hc.1
    have := leftAll_of_top p rest a c hc.2 hs' (turn_down hca hab hb hc' hp.le) (lexLe_trans hab hb)
    simpa only [LeftAll, List.isChain_cons_cons] using this

theorem inv_tail {P : List P2} {b : P2} {S : List P2} (h : Inv P (b :: S)) (hS : S ≠ []) : Inv P S where
  sub := fun v hv => h.sub v (List.mem_cons_of_mem _ hv)
  sorted := List.Pairwise.of_cons h.sorted
  convex := by
    have := h.convex
    match S, hS with
    | [_], _ => trivial
    | y :: x :: rest, _ => exact this.2
  left := fun q hq => (h.left q hq).tail
  bottom := by
    intro t ht q hq
    apply h.bottom t _ q hq
    cases S with
    | nil => exact absurd rfl hS
    | cons y S =>
      rw [List.getLast?_cons_cons]
      exact ht

theorem push_head (p : P2) : ∀ S : List P2, (push p S).head? = some p
  | [] => rfl
  | [_] => rfl
  | b :: a :: rest => by
    unfold push
    split_ifs
    · exact push_head p (a :: rest)
    · rfl

/-- **Pushing a point keeps the invariant**, given that the points at or after the top are on or left of
`top → p` (`hC`; at the first call only the top itself is, see `foldl_inv`). -/
theorem push_inv (p : P2) : ∀ (S P : List P2), Inv P S → (∀ q ∈ P, LexLe q p) → (S = [] → P = []) →
    (∀ t ∈ S.head?, ∀ q ∈ P, LexLe t q → 0 ≤ cross t p q) → Inv (p :: P) (push p S)
  | [], P, _, _, hP, _ => by
    obtain rfl := hP rfl
    have hpush : push p [] = [p] := rfl
    rw [hpush]
    refine ⟨by simp, by simp, trivial, by simp [LeftAll], ?_⟩
    intro t ht q hq
    simp only [List.getLast?_singleton, Option.mem_def, Option.some.injEq] at ht
    simp only [List.mem_singleton] at hq
    subst ht
    subst hq
    exact lexLe_refl _
  | [b], P, hI, hp, _, hC => by
    have hbP : b ∈ P := hI.sub b (by simp)
    have hpush : push p [b] = [p, b] := rfl
    rw [hpush]
    refine ⟨?_, ?_, trivial, ?_, ?_⟩
    · intro v hv
      simp only [List.mem_cons, List.not_mem_nil, or_false] at hv
      rcases hv with rfl | rfl
      · simp
      · exact List.mem_cons_of_mem _ hbP
    · simpa using hp b hbP
    · intro q hq
      simp only [LeftAll, List.isChain_cons_cons, List.isChain_singleton, and_true]
      rcases List.mem_cons.1 hq with rfl | hq
      · exact (cross_self' b q).ge
      · exact hC b (by simp) q hq (hI.bottom b (by simp) q hq)
    · intro t ht q hq
      simp only [List.getLast?_cons_cons, List.getLast?_singleton, Option.mem_def, Option.some.injEq] at ht
      subst ht
      rcases List.mem_cons.1 hq with rfl | hq
      · exact hp _ hbP
      · exact hI.bottom _ (by simp) q hq
  | b :: a :: rest, P, hI, hp, hP, hC => by
    have hab : LexLe a b := List.rel_of_pairwise_cons hI.sorted (by simp)
    have haP : a ∈ P := hI.sub a (by simp)
    have hbP : b ∈ P := hI.sub b (by simp)
    by_cases hpop : cross a b p ≤ 0
    · have heq : push p (b :: a :: rest) = push p (a :: rest) := by
        conv_lhs => unfold push
        rw [if_pos hpop]
      rw [heq]
      apply push_inv p (a :: rest) P (inv_tail hI (by simp)) hp (by simp)
      intro t ht q hq htq
      simp only [List.head?_cons, Option.mem_def, Option.some.injEq] at ht
      subst ht
      have hs : 0 ≤ cross a p b := by rw [cross_swap]; linarith
      by_cases hbq : LexLe b q
      · by_cases hbp : b = p
        · subst hbp
          obtain rfl := lexLe_antisymm (hp q hq) hbq
          exact (cross_self' a q).ge
        · exact turn_pop_above (hp a haP) (hp b hbP) (hp q hq) hbp (hC b (by simp) q hq hbq) hs
      · have hne : a ≠ b := by
          rintro rfl
          exact hbq htq
        have hl := hI.left q hq
        simp only [LeftAll, List.isChain_cons_cons] at hl
        exact turn_pop_between hab (hp a haP) htq hne hl.1 hs
    · have heq : push p (b :: a :: rest) = p :: b :: a :: rest := by
        conv_lhs => unfold push
        rw [if_neg hpop]
      rw [heq]
      have hp' : 0 < cross a b p := lt_of_not_ge hpop
      refine ⟨?_, ?_, ⟨hp', hI.convex⟩, ?_, ?_⟩
      · intro v hv
        rcases List.mem_cons.1 hv with rfl | hv
        · simp
        · exact List.mem_cons_of_mem _ (hI.sub v hv)
      · exact List.Pairwise.cons (fun x hx => hp x (hI.sub x hx)) hI.sorted
      · intro q hq
        simp only [LeftAll, List.isChain_cons_cons]
        rcases List.mem_cons.1 hq with rfl | hq
        · refine ⟨(cross_self' b q).ge, ?_⟩
          have := leftAll_of_top q rest b a hI.convex hI.sorted hp' (hp b hbP)
          simpa only [LeftAll, List.isChain_cons_cons] using this
        · refine ⟨?_, ?_⟩
          · by_cases hbq : LexLe b q
            · exact hC b (by simp) q hq hbq
            · have hl := hI.left q hq
              simp only [LeftAll, List.isChain_cons_cons] at hl
              exact turn_below hab (hp b hbP) ((lexLe_total b q).resolve_left hbq) hl.1 hp'
          · have := hI.left q hq
            simpa only [LeftAll, List.isChain_cons_cons] using this
      · intro t ht q hq
        have ht' : t ∈ (b :: a :: rest).getLast? := by
          rw [List.getLast?_cons_cons] at ht
          rwa [List.getLast?_cons_cons]
        rcases List.mem_cons.1 hq with rfl | hq
        · exact hp t (hI.sub t (List.mem_of_getLast? ht'))
        · exact hI.bottom t ht' q hq

theorem push_ne_nil (p : P2) (S : List P2) : push p S ≠ [] := by
  intro h
  have := push_head p S
  rw [h] at this
  cases this

theorem push_sub (p : P2) : ∀ S : List P2, ∀ v ∈ push p S, v = p ∨ v ∈ S
  | [], v, hv => by simpa [push] using hv
  | [b], v, hv => by simpa [push] using hv
  | b :: a :: rest, v, hv => by
    unfold push at hv
    split_ifs at hv
    · rcases push_sub p (a :: rest) v hv with h | h
      · exact Or.inl h
      · exact Or.inr (List.mem_cons_of_mem _ h)
    · simpa using hv

theorem push_getLast (p : P2) : ∀ S : List P2, S ≠ [] → (push p S).getLast? = S.getLast?
  | [], h => absurd rfl h
  | [_], _ => rfl
  | b :: a :: rest, _ => by
    unfold push
    split_ifs
    · rw [push_getLast p (a :: rest) (by simp), List.getLast?_cons_cons]
    · simp only [List.getLast?_cons_cons]

theorem push_length (p : P2) : ∀ S : List P2, S ≠ [] → 2 ≤ (push p S).length
  | [], h => absurd rfl h
  | [_], _ => le_rfl
  | b :: a :: rest, _ => by
    unfold push
    split_ifs
    · exact push_length p (a :: rest) (by simp)
    · simp

/-- **The fold keeps the invariant**: the top is always the last point pushed, so it is the greatest so far. -/
theorem foldl_inv : ∀ (l S P : List P2), Inv P S → (S = [] → P = []) → (∀ t ∈ S.head?, ∀ q ∈ P, LexLe q t) →
    (∀ q ∈ P, ∀ p ∈ l, LexLe q p) → l.Pairwise LexLe →
    Inv (l.reverse ++ P) (l.foldl (fun s p => push p s) S)
  | [], S, P, hI, _, _, _, _ => by simpa using hI
  | p :: l, S, P, hI, hP, hT, hle, hs => by
    simp only [List.foldl_cons]
    have hI' := push_inv p S P hI (fun q hq => hle q hq p (by simp)) hP (by
      intro t ht q hq htq
      obtain rfl := lexLe_antisymm htq (hT t ht q hq)
      exact (cross_self t p).ge)
    have := foldl_inv l (push p S) (p :: P) hI' (fun h => absurd h (push_ne_nil p S))
      (by
        intro t ht q hq
        rw [push_head] at ht
        simp only [Option.mem_def, Option.some.injEq] at ht
        subst ht
        rcases List.mem_cons.1 hq with rfl | hq
        · exact lexLe_refl _
        · exact hle q hq _ (by simp))
      (by
        intro q hq x hx
        rcases List.mem_cons.1 hq with rfl | hq
        · exact List.rel_of_pairwise_cons hs hx
        · exact hle q hq x (List.mem_cons_of_mem _ hx))
      (List.Pairwise.of_cons hs)
    simpa [List.reverse_cons, List.append_assoc] using this

theorem chain_inv (l : List P2) (hl : l.Pairwise LexLe) : Inv l.reverse (chain l) := by
  have := foldl_inv l [] [] ⟨by simp, by simp, trivial, by simp [LeftAll], by simp⟩ (fun _ => rfl) (by simp)
    (by simp) hl
  simpa [chain] using this

/-- Every point of a sorted list is on or left of every edge of its chain. -/
theorem chain_left (l : List P2) (hl : l.Pairwise LexLe) : ∀ q ∈ l, LeftAll q (chain l) :=
  fun q hq => (chain_inv l hl).left q (List.mem_reverse.2 hq)

theorem foldl_sub : ∀ (l S : List P2), ∀ v ∈ l.foldl (fun s p => push p s) S, v ∈ l ∨ v ∈ S
  | [], S, v, hv => Or.inr hv
  | p :: l, S, v, hv => by
    simp only [List.foldl_cons] at hv
    rcases foldl_sub l (push p S) v hv with h | h
    · exact Or.inl (List.mem_cons_of_mem _ h)
    · rcases push_sub p S v h with rfl | h
      · exact Or.inl (by simp)
      · exact Or.inr h

/-- A chain's points are input points. -/
theorem chain_sub (l : List P2) : ∀ v ∈ chain l, v ∈ l := fun v hv =>
  (foldl_sub l [] v hv).resolve_right (by simp)

theorem foldl_getLast : ∀ (l S : List P2), S ≠ [] →
    (l.foldl (fun s p => push p s) S).getLast? = S.getLast?
  | [], _, _ => rfl
  | p :: l, S, hS => by
    simp only [List.foldl_cons]
    rw [foldl_getLast l (push p S) (push_ne_nil p S), push_getLast p S hS]

theorem foldl_length : ∀ (l S : List P2), 2 ≤ S.length → 2 ≤ (l.foldl (fun s p => push p s) S).length
  | [], _, h => h
  | p :: l, S, h => by
    simp only [List.foldl_cons]
    exact foldl_length l (push p S) (push_length p S (by rintro rfl; simp at h))

/-- The chain's bottom is the first point, its top the last, and two points or more make two or more. -/
theorem chain_getLast (a : P2) (l : List P2) : (chain (a :: l)).getLast? = some a := by
  simp only [chain, List.foldl_cons]
  rw [foldl_getLast l _ (push_ne_nil a [])]
  rfl

theorem chain_head (l : List P2) (c : P2) : (chain (l ++ [c])).head? = some c := by
  simp only [chain, List.foldl_append, List.foldl_cons, List.foldl_nil]
  exact push_head c _

theorem chain_length (a b : P2) (l : List P2) : 2 ≤ (chain (a :: b :: l)).length := by
  simp only [chain, List.foldl_cons]
  exact foldl_length l _ (push_length b _ (push_ne_nil a []))

/-! ## The upper chain: the lower chain turned by 180° -/

/-- The point turned by 180°. -/
def neg (a : P2) : P2 := (-a.1, -a.2)

theorem neg_neg' (a : P2) : neg (neg a) = a := by simp [neg]

theorem cross_neg (o a b : P2) : cross (neg o) (neg a) (neg b) = cross o a b := by
  simp only [cross, neg]
  ring

theorem lexLe_neg {a b : P2} : LexLe (neg a) (neg b) ↔ LexLe b a := by
  simp only [LexLe, neg, neg_lt_neg_iff, neg_inj, neg_le_neg_iff]
  constructor
  · rintro (h | ⟨h, h'⟩)
    · exact Or.inl h
    · exact Or.inr ⟨h.symm, h'⟩
  · rintro (h | ⟨h, h'⟩)
    · exact Or.inl h
    · exact Or.inr ⟨h.symm, h'⟩

theorem push_map_neg (p : P2) : ∀ S : List P2, push (neg p) (S.map neg) = (push p S).map neg
  | [] => rfl
  | [_] => rfl
  | b :: a :: rest => by
    simp only [List.map_cons]
    unfold push
    rw [cross_neg]
    split_ifs
    · simpa using push_map_neg p (a :: rest)
    · rfl

theorem chain_map_neg (l : List P2) : chain (l.map neg) = (chain l).map neg := by
  suffices h : ∀ S : List P2, (l.map neg).foldl (fun s p => push p s) (S.map neg) =
      (l.foldl (fun s p => push p s) S).map neg by
    simpa using h []
  induction l with
  | nil => intro S; rfl
  | cons p l ih =>
    intro S
    simp only [List.map_cons, List.foldl_cons]
    rw [push_map_neg, ih]

theorem leftAll_map_neg (q : P2) (S : List P2) : LeftAll q (S.map neg) ↔ LeftAll (neg q) S := by
  unfold LeftAll
  rw [List.isChain_map]
  have : ∀ x y : P2, cross (neg y) (neg x) q = cross y x (neg q) := by
    intro x y
    rw [← cross_neg y x (neg q), neg_neg']
  simp only [this]

theorem convex_map_neg : ∀ S : List P2, Convex (S.map neg) ↔ Convex S
  | [] => Iff.rfl
  | [_] => Iff.rfl
  | [_, _] => Iff.rfl
  | z :: y :: x :: rest => by
    simp only [List.map_cons, Convex, cross_neg]
    have := convex_map_neg (y :: x :: rest)
    simp only [List.map_cons] at this
    rw [this]

theorem sorted_reverse_neg (l : List P2) (hl : l.Pairwise LexLe) : (l.reverse.map neg).Pairwise LexLe := by
  rw [List.pairwise_map, List.pairwise_reverse]
  exact hl.imp fun h => lexLe_neg.2 h

/-- The upper chain is the lower chain of the points turned by 180°, turned back. -/
theorem upper_eq (l : List P2) : chain l.reverse = (chain (l.reverse.map neg)).map neg := by
  rw [← chain_map_neg, List.map_map]
  simp [Function.comp_def, neg_neg']

theorem upper_left (l : List P2) (hl : l.Pairwise LexLe) : ∀ q ∈ l, LeftAll q (chain l.reverse) := by
  intro q hq
  rw [upper_eq, leftAll_map_neg]
  exact chain_left _ (sorted_reverse_neg l hl) _ (List.mem_map.2 ⟨q, List.mem_reverse.2 hq, rfl⟩)

/-- **Both chains turn strictly left at every vertex.** -/
theorem chain_convex (l : List P2) (hl : l.Pairwise LexLe) : Convex (chain l) ∧ Convex (chain l.reverse) := by
  refine ⟨(chain_inv l hl).convex, ?_⟩
  rw [upper_eq, convex_map_neg]
  exact (chain_inv _ (sorted_reverse_neg l hl)).convex

/-! ## The hull -/

/-- The cyclic edges of `A ++ B` (closing from its last point back to its first) are those of the chains `A ++ [x]`
and `B ++ [y]` when `A` starts at `y` and `B` at `x`: the lower chain then the upper one, each without its last
point. -/
theorem isChain_cyclic {R : P2 → P2 → Prop} {A B : List P2} {x y : P2} (hA : List.IsChain R (A ++ [x]))
    (hB : List.IsChain R (B ++ [y])) (hAy : A.head? = some y) (hBx : B.head? = some x) (d : P2) :
    List.IsChain R ((A ++ B).getLastD d :: (A ++ B)) := by
  obtain ⟨b, B', rfl⟩ := List.exists_cons_of_ne_nil (show B ≠ [] by rintro rfl; simp at hBx)
  obtain ⟨a, A', rfl⟩ := List.exists_cons_of_ne_nil (show A ≠ [] by rintro rfl; simp at hAy)
  simp only [List.head?_cons, Option.some.injEq] at hAy hBx
  subst hAy hBx
  rw [List.isChain_append] at hA hB
  obtain ⟨z, hz⟩ : ∃ z, (b :: B').getLast? = some z := Option.isSome_iff_exists.1 (by simp)
  have hlast : ((a :: A') ++ (b :: B')).getLastD d = z := by
    rw [List.getLastD_eq_getLast?, List.getLast?_append, hz]
    rfl
  rw [hlast, List.isChain_cons]
  refine ⟨?_, ?_⟩
  · intro w hw
    simp only [List.cons_append, List.head?_cons, Option.mem_def, Option.some.injEq] at hw
    subst hw
    exact hB.2.2 z hz a (by simp)
  · rw [List.isChain_append]
    exact ⟨hA.1, hB.1, fun u hu v hv => hA.2.2 u hu v (by simp at hv ⊢; exact hv)⟩

/-- On sorted points: every point is on or left of every edge of the hull, closing edge included. -/
theorem hullOfSorted_left (s : List P2) (hs : s.Pairwise LexLe) (h3 : 3 ≤ s.length) (q : P2) (hq : q ∈ s) :
    List.IsChain (fun a b => 0 ≤ cross a b q) ((hullOfSorted s).getLastD (0, 0) :: hullOfSorted s) := by
  unfold hullOfSorted
  rw [if_neg (by omega)]
  obtain ⟨a, b, rest, rfl⟩ : ∃ a b rest, s = a :: b :: rest := by
    match s, h3 with
    | a :: b :: rest, _ => exact ⟨a, b, rest, rfl⟩
  obtain ⟨init, c, hsc⟩ : ∃ init c, a :: b :: rest = init ++ [c] := by
    rcases List.eq_nil_or_concat (a :: b :: rest) with h | ⟨init, c, h⟩
    · simp at h
    · exact ⟨init, c, by simpa using h⟩
  -- the lower chain, top first: `c` on top, `a` at the bottom
  have hLh : (chain (a :: b :: rest)).head? = some c := by rw [hsc]; exact chain_head init c
  have hLl : (chain (a :: b :: rest)).getLast? = some a := chain_getLast a (b :: rest)
  have hLn : 2 ≤ (chain (a :: b :: rest)).length := chain_length a b rest
  -- the upper chain, top first: `a` on top, `c` at the bottom
  have hrev : (a :: b :: rest).reverse = (b :: rest).reverse ++ [a] := List.reverse_cons
  have hrev' : (a :: b :: rest).reverse = c :: init.reverse := by rw [hsc]; simp
  have hUh : (chain (a :: b :: rest).reverse).head? = some a := by rw [hrev]; exact chain_head _ a
  have hUl : (chain (a :: b :: rest).reverse).getLast? = some c := by rw [hrev']; exact chain_getLast c _
  have hUn : 2 ≤ (chain (a :: b :: rest).reverse).length := by
    obtain ⟨u, v, w, huv⟩ : ∃ u v w, (a :: b :: rest).reverse = u :: v :: w := by
      have : 2 ≤ (a :: b :: rest).reverse.length := by simp
      match h : (a :: b :: rest).reverse, this with
      | u :: v :: w, _ => exact ⟨u, v, w, rfl⟩
    rw [huv]
    exact chain_length u v w
  have hL := chain_left _ hs q hq
  have hU := upper_left _ hs q hq
  -- name the chains' tops and the rest
  obtain ⟨x, L, hLeq⟩ := List.exists_cons_of_ne_nil (show chain (a :: b :: rest) ≠ [] by
    intro h; rw [h] at hLn; simp at hLn)
  obtain ⟨y, U, hUeq⟩ := List.exists_cons_of_ne_nil (show chain (a :: b :: rest).reverse ≠ [] by
    intro h; rw [h] at hUn; simp at hUn)
  rw [hLeq] at hLh hLl hLn hL
  rw [hUeq] at hUh hUl hUn hU
  simp only [List.head?_cons, Option.some.injEq] at hLh hUh
  subst hLh hUh
  have hL0 : L ≠ [] := by rintro rfl; simp at hLn
  have hU0 : U ≠ [] := by rintro rfl; simp at hUn
  rw [hLeq, hUeq, List.reverse_cons, List.reverse_cons, List.dropLast_concat, List.dropLast_concat]
  unfold LeftAll at hL hU
  rw [← List.isChain_reverse, List.reverse_cons] at hL hU
  refine isChain_cyclic hL hU ?_ ?_ (0, 0)
  · rw [List.head?_reverse]
    obtain ⟨l1, L', rfl⟩ := List.exists_cons_of_ne_nil hL0
    rwa [List.getLast?_cons_cons] at hLl
  · rw [List.head?_reverse]
    obtain ⟨u1, U', rfl⟩ := List.exists_cons_of_ne_nil hU0
    rwa [List.getLast?_cons_cons] at hUl

theorem hullOfSorted_sub (s : List P2) : ∀ v ∈ hullOfSorted s, v ∈ s := by
  intro v hv
  unfold hullOfSorted at hv
  split_ifs at hv
  · exact hv
  · rcases List.mem_append.1 hv with h | h
    · exact chain_sub s v (List.mem_reverse.1 (List.dropLast_subset _ h))
    · exact List.mem_reverse.1 (chain_sub _ v (List.mem_reverse.1 (List.dropLast_subset _ h)))

open Classical in
theorem lexB_iff (a b : P2) : lexB a b = true ↔ LexLe a b := by
  unfold lexB
  exact decide_eq_true_iff

theorem sorted_mergeSort (pts : List P2) : (pts.mergeSort lexB).Pairwise LexLe := by
  have := List.pairwise_mergeSort (le := lexB)
    (fun a b c h1 h2 => (lexB_iff a c).2 (lexLe_trans ((lexB_iff a b).1 h1) ((lexB_iff b c).1 h2)))
    (fun a b => by
      rcases lexLe_total a b with h | h
      · simp [(lexB_iff a b).2 h]
      · simp [(lexB_iff b a).2 h]) pts
  exact this.imp fun h => (lexB_iff _ _).1 h

/-- **Every vertex of the hull is an input point.** -/
theorem hull_vertices (pts : List P2) : ∀ v ∈ convexHull pts, v ∈ pts := fun v hv =>
  List.mem_mergeSort.1 (hullOfSorted_sub _ v hv)

/-- **Every input point is in the hull**: on or left of every edge, the closing one included; with at least three
vertices that is `pointInHull` (hull.rs `point_in_hull`). -/
theorem hull_contains (pts : List P2) (q : P2) (hq : q ∈ pts) (h3 : 3 ≤ (convexHull pts).length) :
    pointInHull (convexHull pts) q := by
  refine ⟨h3, ?_⟩
  have hlen : 3 ≤ (pts.mergeSort lexB).length := by
    by_contra h
    have : convexHull pts = pts.mergeSort lexB := by
      unfold convexHull hullOfSorted
      rw [if_pos (by omega)]
    rw [this] at h3
    exact h h3
  exact hullOfSorted_left _ (sorted_mergeSort pts) hlen q (List.mem_mergeSort.2 hq)

/-- The lower and the upper chain of the sorted points turn strictly left at every vertex. -/
theorem hull_chains_convex (pts : List P2) :
    Convex (chain (pts.mergeSort lexB)) ∧ Convex (chain (pts.mergeSort lexB).reverse) :=
  chain_convex _ (sorted_mergeSort pts)

/-! ## The turns where the chains meet -/

/-- The points are not all on one line. -/
def NotCollinear (pts : List P2) : Prop := ∃ a ∈ pts, ∃ b ∈ pts, ∃ c ∈ pts, cross a b c ≠ 0

/-- On the line through `o` along `e ≠ 0`, every turn is straight. -/
theorem line_cross_zero {o e : P2} (he : e ≠ 0) {a b c : P2}
    (ha : e.1 * (a.2 - o.2) - e.2 * (a.1 - o.1) = 0) (hb : e.1 * (b.2 - o.2) - e.2 * (b.1 - o.1) = 0)
    (hc : e.1 * (c.2 - o.2) - e.2 * (c.1 - o.1) = 0) : cross a b c = 0 := by
  have h1 : e.1 * cross a b c = 0 := by
    unfold cross
    linear_combination (b.1 - a.1) * hc - (b.1 - a.1) * ha - (c.1 - a.1) * hb + (c.1 - a.1) * ha
  have h2 : e.2 * cross a b c = 0 := by
    unfold cross
    linear_combination (-(c.2 - a.2)) * hb + (c.2 - a.2) * ha + (b.2 - a.2) * hc - (b.2 - a.2) * ha
  by_contra h
  apply he
  exact Prod.ext ((mul_eq_zero.1 h1).resolve_right h) ((mul_eq_zero.1 h2).resolve_right h)

/-- **A straight turn where the direction reverses puts everything on the line**: at `x`, lexicographically after
both `l` and `u`, if `l → x → u` is straight and every point is on or left of `l → x` and of `x → u`, every point is on
the line `l x`. -/
theorem reversal_line {l x u q : P2} (h1 : LexLe l x) (hlx : l ≠ x) (h2 : LexLe u x) (hux : u ≠ x)
    (h0 : cross l x u = 0) (hq1 : 0 ≤ cross l x q) (hq2 : 0 ≤ cross x u q) : cross l x q = 0 := by
  have he := sub_pos_of_lexLe h1 hlx
  have hf := sub_pos_of_lexLe h2 hux
  unfold cross at *
  rcases he with he | ⟨he1, he2⟩
  · rcases hf with hf | ⟨hf1, hf2⟩
    · -- f₁ < 0 with e₁ > 0: (x₁ - l₁)·cross(x, u, q) = (u₁ - x₁)·cross(l, x, q)
      have key : (x.1 - l.1) * ((u.1 - x.1) * (q.2 - x.2) - (u.2 - x.2) * (q.1 - x.1)) =
          (u.1 - x.1) * ((x.1 - l.1) * (q.2 - l.2) - (x.2 - l.2) * (q.1 - l.1)) := by
        linear_combination (-(q.1 - x.1)) * h0
      nlinarith
    · -- f₁ = 0 forces f₂ = 0: u = x
      have : x.2 - u.2 = 0 := by
        have : (x.1 - l.1) * (u.2 - l.2) - (x.2 - l.2) * (u.1 - l.1) = (x.1 - l.1) * (u.2 - x.2) := by
          rw [show u.1 = x.1 by linarith]
          ring
        nlinarith
      linarith
  · rcases hf with hf | ⟨hf1, hf2⟩
    · have hx1 : x.1 = l.1 := by linarith
      have : (x.1 - l.1) * (u.2 - l.2) - (x.2 - l.2) * (u.1 - l.1) = - (x.2 - l.2) * (u.1 - l.1) := by
        rw [hx1]
        ring
      nlinarith
    · have hx1 : x.1 = l.1 := by linarith
      have hu1 : u.1 = x.1 := by linarith
      rw [hx1] at hq1 hq2 ⊢
      rw [hu1, hx1] at hq2
      nlinarith

/-- The last point of a sorted list is the greatest, the first the least. -/
theorem le_last {init : List P2} {c : P2} (hs : (init ++ [c]).Pairwise LexLe) : ∀ q ∈ init ++ [c], LexLe q c := by
  intro q hq
  rcases List.mem_append.1 hq with hq | hq
  · exact (List.pairwise_append.1 hs).2.2 q hq c (by simp)
  · simp only [List.mem_singleton] at hq
    subst hq
    exact lexLe_refl _

theorem first_le {a : P2} {rest : List P2} (hs : (a :: rest).Pairwise LexLe) : ∀ q ∈ a :: rest, LexLe a q := by
  intro q hq
  rcases List.mem_cons.1 hq with rfl | hq
  · exact lexLe_refl _
  · exact List.rel_of_pairwise_cons hs hq

/-- Points that are all equal are collinear. -/
theorem not_all_equal {s : List P2} {x : P2} (hnc : NotCollinear s) (h : ∀ q ∈ s, q = x) : False := by
  obtain ⟨a, ha, b, hb, c, hc, habc⟩ := hnc
  rw [h a ha, h b hb, h c hc, cross_self'] at habc
  exact habc rfl

theorem convex_tail {h : P2} {S : List P2} (hc : Convex (h :: S)) : Convex S := by
  match S, hc with
  | [], _ => trivial
  | [_], _ => trivial
  | [_, _], _ => trivial
  | y :: x :: w :: rest, hc => exact hc.2

/-- The bottom triple of a convex stack turns strictly left. -/
theorem convex_bottom : ∀ (l : List P2) (z y w : P2), Convex (l ++ [z, y, w]) → 0 < cross w y z
  | [], _, _, _, hc => hc.1
  | _ :: t, z, y, w, hc => convex_bottom t z y w (convex_tail hc)

theorem cross_self'' (o b : P2) : cross o o b = 0 := by simp [cross]

/-- **The turn at the rightmost point is strictly left** (`l → x` the lower chain's last edge, `x → u` the upper
chain's first), unless the points are all on one line. -/
theorem junction_right (s : List P2) (hs : s.Pairwise LexLe) (hnc : NotCollinear s) {x l : P2} {L₂ : List P2}
    (hL : chain s = x :: l :: L₂) {u : P2} {U₂ : List P2} (hU : (chain s.reverse).reverse = x :: u :: U₂) :
    0 < cross l x u := by
  -- s's last point is x, the greatest
  obtain ⟨init, c, rfl⟩ : ∃ init c, s = init ++ [c] := by
    rcases List.eq_nil_or_concat s with h | ⟨init, c, h⟩
    · subst h
      obtain ⟨a, ha, -⟩ := hnc
      simp at ha
    · exact ⟨init, c, by simpa using h⟩
  have hxc : x = c := by
    have := chain_head init c
    rw [hL] at this
    simpa using this
  subst hxc
  have hmax := le_last hs
  -- every point is on or left of `l → x` and of `x → u`
  have hLx : ∀ q ∈ init ++ [x], 0 ≤ cross l x q := by
    intro q hq
    have := chain_left _ hs q hq
    rw [hL] at this
    unfold LeftAll at this
    exact (List.isChain_cons_cons.1 this).1
  have hUx : ∀ q ∈ init ++ [x], 0 ≤ cross x u q := by
    intro q hq
    have := upper_left _ hs q hq
    unfold LeftAll at this
    rw [← List.isChain_reverse, hU] at this
    exact (List.isChain_cons_cons.1 this).1
  have hl_s : l ∈ init ++ [x] := chain_sub _ l (by rw [hL]; simp)
  have hu_s : u ∈ init ++ [x] := by
    have : u ∈ chain (init ++ [x]).reverse := by
      rw [← List.mem_reverse, hU]
      simp
    exact List.mem_reverse.1 (chain_sub _ u this)
  -- the first point is the least
  obtain ⟨a, rest, hs_eq⟩ : ∃ a rest, init ++ [x] = a :: rest := by
    match h : init ++ [x] with
    | [] => simp at h
    | a :: rest => exact ⟨a, rest, rfl⟩
  have hmin : ∀ q ∈ init ++ [x], LexLe a q := by
    rw [hs_eq] at hs ⊢
    exact first_le hs
  have all_eq : (a = x) → False := by
    intro hax
    apply not_all_equal hnc (x := x)
    intro q hq
    exact lexLe_antisymm (hmax q hq) (hax ▸ hmin q hq)
  by_contra hle
  have h0 : cross l x u = 0 := le_antisymm (not_lt.1 hle) (hLx u hu_s)
  -- the two degenerate stacks: a repeated top or bottom only happens when every point is the same
  have hlx : l ≠ x := by
    rintro rfl
    have hconv := (chain_convex _ hs).1
    rw [hL] at hconv
    cases L₂ with
    | nil =>
      have := chain_getLast a rest
      rw [← hs_eq, hL] at this
      simp at this
      exact all_eq this.symm
    | cons w L₃ =>
      have := hconv.1
      rw [cross_self'] at this
      exact lt_irrefl _ this
  have hux : u ≠ x := by
    rintro rfl
    have hU' : chain (init ++ [u]).reverse = U₂.reverse ++ [u, u] := by
      have := congrArg List.reverse hU
      simpa using this
    cases U₂ with
    | nil =>
      have htop : (chain (init ++ [u]).reverse).head? = some a := by
        rw [hs_eq, List.reverse_cons]
        exact chain_head _ a
      rw [hU'] at htop
      simp at htop
      exact all_eq htop.symm
    | cons w W =>
      have hconv := (chain_convex _ hs).2
      rw [hU', show (w :: W).reverse ++ [u, u] = W.reverse ++ [w, u, u] by simp] at hconv
      have := convex_bottom W.reverse w u u hconv
      rw [cross_self''] at this
      exact lt_irrefl _ this
  -- otherwise every point is on the line `l x`, so all turns are straight
  have hline : ∀ q ∈ init ++ [x], cross l x q = 0 := fun q hq =>
    reversal_line (hmax l hl_s) hlx (hmax u hu_s) hux h0 (hLx q hq) (hUx q hq)
  obtain ⟨p1, hp1, p2, hp2, p3, hp3, hne⟩ := hnc
  apply hne
  have he : x - l ≠ 0 := sub_ne_zero.2 (Ne.symm hlx)
  have hl' : ∀ q ∈ init ++ [x], (x - l).1 * (q.2 - l.2) - (x - l).2 * (q.1 - l.1) = 0 := by
    intro q hq
    have := hline q hq
    unfold cross at this
    simpa using this
  exact line_cross_zero he (hl' p1 hp1) (hl' p2 hp2) (hl' p3 hp3)

theorem notCollinear_neg {s : List P2} (h : NotCollinear s) : NotCollinear (s.reverse.map neg) := by
  obtain ⟨a, ha, b, hb, c, hc, habc⟩ := h
  refine ⟨neg a, List.mem_map.2 ⟨a, List.mem_reverse.2 ha, rfl⟩, neg b, List.mem_map.2 ⟨b, List.mem_reverse.2 hb, rfl⟩,
    neg c, List.mem_map.2 ⟨c, List.mem_reverse.2 hc, rfl⟩, ?_⟩
  rwa [cross_neg]

/-- **The turn at the leftmost point is strictly left** (`u → y` the upper chain's last edge, `y → l` the lower
chain's first), unless the points are all on one line: the rightmost turn of the points turned by 180°. -/
theorem junction_left (s : List P2) (hs : s.Pairwise LexLe) (hnc : NotCollinear s) {y l : P2} {L₂ : List P2}
    (hL : (chain s).reverse = y :: l :: L₂) {u : P2} {U₂ : List P2} (hU : chain s.reverse = y :: u :: U₂) :
    0 < cross u y l := by
  have hs' := sorted_reverse_neg s hs
  have hL' : chain (s.reverse.map neg) = neg y :: neg u :: U₂.map neg := by
    have := congrArg (List.map neg) (upper_eq s)
    rw [List.map_map] at this
    simp only [Function.comp_def, neg_neg', List.map_id'] at this
    rw [← this, hU]
    rfl
  have hU' : (chain (s.reverse.map neg).reverse).reverse = neg y :: neg l :: L₂.map neg := by
    rw [← List.map_reverse, List.reverse_reverse, chain_map_neg, ← List.map_reverse, hL]
    rfl
  have := junction_right _ hs' (notCollinear_neg hnc) hL' hU'
  rwa [cross_neg] at this

/-- Points not all on one line are at least two (three, in fact). -/
theorem two_le_of_notCollinear {s : List P2} (h : NotCollinear s) : 2 ≤ s.length := by
  obtain ⟨a, ha, b, hb, c, hc, habc⟩ := h
  match s, ha, hb, hc with
  | [x], ha, hb, hc =>
    simp only [List.mem_singleton] at ha hb hc
    subst ha hb hc
    exact absurd (cross_self' _ _) habc
  | _ :: _ :: _, _, _, _ => simp

/-- **Every turn of the hull is strictly left** when the points are not all on one line: inside the lower and the
upper chain (`chain_convex`), and where they meet at the rightmost (`x`) and the leftmost (`y`) point; both chains
have at least two points, so those meeting turns exist. With the hull being `lower.dropLast ++ upper.dropLast`, these
are all its consecutive triples, cyclically. -/
theorem hull_turns_left (pts : List P2) (hnc : NotCollinear pts) :
    let s := pts.mergeSort lexB
    2 ≤ (chain s).length ∧ 2 ≤ (chain s.reverse).length ∧ Convex (chain s) ∧ Convex (chain s.reverse) ∧
      (∀ x l L₂ u U₂, chain s = x :: l :: L₂ → (chain s.reverse).reverse = x :: u :: U₂ → 0 < cross l x u) ∧
      (∀ y l L₂ u U₂, (chain s).reverse = y :: l :: L₂ → chain s.reverse = y :: u :: U₂ → 0 < cross u y l) := by
  intro s
  have hs := sorted_mergeSort pts
  have hnc' : NotCollinear s := by
    obtain ⟨a, ha, b, hb, c, hc, h⟩ := hnc
    exact ⟨a, List.mem_mergeSort.2 ha, b, List.mem_mergeSort.2 hb, c, List.mem_mergeSort.2 hc, h⟩
  have h2 := two_le_of_notCollinear hnc'
  have hlen : ∀ l : List P2, 2 ≤ l.length → 2 ≤ (chain l).length := by
    intro l hl
    match l, hl with
    | a :: b :: rest, _ => exact chain_length a b rest
  exact ⟨hlen s h2, hlen s.reverse (by simpa using h2), (chain_convex s hs).1, (chain_convex s hs).2,
    fun _ _ _ _ _ hL hU => junction_right s hs hnc' hL hU,
    fun _ _ _ _ _ hL hU => junction_left s hs hnc' hL hU⟩

end Midstudy.Hull
