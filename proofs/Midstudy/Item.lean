import Midstudy.Rotation
import Mathlib.Order.Bounds.Basic

/-!
# Item rotation (CLAUDE.md conventions, contract §2.3, §2.5, §3.1)

An item turns about Y only, by `Ry(rotation_y_deg)` (three.js `rotation.y`). Positive angles are counterclockwise
seen from above, so `--yaw 90` turns +X into −Z (§3.1), and a quarter turn swaps the X and Z extents (§2.5).

Main results:
* `Ry_mulVec_x`, `Ry_x_toward_neg_z`, `Ry_quarter_x`: positive angles turn +X towards −Z.
* `Ry_ccw_from_above`: seen from above (map coordinates `(x, −z)`, x to the right and −Z up), `Ry θ` is the
  counterclockwise rotation by `θ`; it never moves y (`Ry_mulVec_y`).
* `Ry_add`, `Ry_pow`: angles add; `Ry_quarter_pow_four`, `Ry_rad_90_pow_four`: four quarter turns are the identity.
* `Ry_quarter_image_box`, `Ry_neg_quarter_image_box`: a quarter turn (either way) maps an axis-aligned box to an
  axis-aligned box with the X and Z extents swapped and Y kept.
* `worldBounds_x`, `worldBounds_z`: for any angle, the axis-aligned bounds of an item's box `w × h × d` (footprint
  centred on the origin) are `w·|cos θ| + d·|sin θ|` wide and `w·|sin θ| + d·|cos θ|` deep, both attained.
-/

noncomputable section

open Real Matrix Set

namespace Midstudy

@[simp] theorem Ry_mulVec (t : ℝ) (v : Vec3) :
    Ry t *ᵥ v = ![cos t * v 0 + sin t * v 2, v 1, -sin t * v 0 + cos t * v 2] := by
  ext i
  fin_cases i <;> simp [Ry, Matrix.mulVec, dotProduct, Fin.sum_univ_three]

/-- `Ry θ` takes +X to `(cos θ, 0, −sin θ)`. -/
theorem Ry_mulVec_x (t : ℝ) : Ry t *ᵥ ![1, 0, 0] = ![cos t, 0, -sin t] := by
  simp

/-- **Positive angles turn +X towards −Z** (for any angle strictly between 0 and π). -/
theorem Ry_x_toward_neg_z {t : ℝ} (h0 : 0 < t) (h1 : t < π) : (Ry t *ᵥ ![1, 0, 0]) 2 < 0 := by
  rw [Ry_mulVec_x]
  simpa using Real.sin_pos_of_pos_of_lt_pi h0 h1

/-- A quarter turn takes +X exactly to −Z (`midstudy-add --yaw 90`, §3.1). -/
theorem Ry_quarter_x : Ry (π / 2) *ᵥ ![1, 0, 0] = ![0, 0, -1] := by
  rw [Ry_mulVec_x]
  simp

/-- `Ry` never moves the height. -/
theorem Ry_mulVec_y (t : ℝ) (v : Vec3) : (Ry t *ᵥ v) 1 = v 1 := by
  simp

/-- The plan seen from above: x to the right, −Z (into the photo) up. -/
def mapXY (v : Vec3) : ℝ × ℝ := (v 0, -v 2)

/-- **Counterclockwise seen from above**: in map coordinates `Ry θ` is the standard counterclockwise rotation. -/
theorem Ry_ccw_from_above (t : ℝ) (v : Vec3) :
    mapXY (Ry t *ᵥ v) =
      (cos t * (mapXY v).1 - sin t * (mapXY v).2, sin t * (mapXY v).1 + cos t * (mapXY v).2) := by
  refine Prod.ext ?_ ?_
  · simp [mapXY]
  · simp [mapXY]
    ring

/-- **Angles add.** -/
theorem Ry_add (a b : ℝ) : Ry a * Ry b = Ry (a + b) := by
  ext i j
  fin_cases i <;> fin_cases j <;> simp [Ry, Matrix.mul_apply, Fin.sum_univ_three, Real.cos_add, Real.sin_add] <;>
    ring

theorem Ry_pow (t : ℝ) (n : ℕ) : Ry t ^ n = Ry (n * t) := by
  induction n with
  | zero => simp
  | succ n ih =>
    rw [pow_succ, ih, Ry_add]
    congr 1
    push_cast
    ring

/-- `Ry` of a negative angle undoes `Ry`. -/
theorem Ry_neg_mul (t : ℝ) : Ry (-t) * Ry t = 1 := by
  rw [Ry_add, neg_add_cancel, Ry_zero]

/-- **Four quarter turns are the identity.** -/
theorem Ry_quarter_pow_four : Ry (π / 2) ^ 4 = 1 := by
  rw [Ry_pow]
  have : ((4 : ℕ) : ℝ) * (π / 2) = 2 * π := by push_cast; ring
  rw [this]
  ext i j
  fin_cases i <;> fin_cases j <;> simp [Ry]

/-- The same in degrees: four turns of 90° (`R` four times, or the −15°/+15° buttons six times each way) are the
identity. -/
theorem Ry_rad_90_pow_four : Ry (rad 90) ^ 4 = 1 := by
  have : rad 90 = π / 2 := by unfold rad; ring
  rw [this, Ry_quarter_pow_four]

/-- Whole turns change nothing: `Ry` has period 360°. -/
theorem Ry_rad_add_360_mul (x : ℝ) (k : ℤ) : Ry (rad (x + 360 * k)) = Ry (rad x) := by
  have : rad (x + 360 * k) = rad x + (k : ℝ) * (2 * π) := by unfold rad; ring
  rw [this]
  ext i j
  fin_cases i <;> fin_cases j <;> simp [Ry, Real.cos_add_int_mul_two_pi, Real.sin_add_int_mul_two_pi]

/-! ### Boxes -/

/-- The axis-aligned box `[lo, hi]` (componentwise). -/
def box (lo hi : Vec3) : Set Vec3 := {v | ∀ i, lo i ≤ v i ∧ v i ≤ hi i}

theorem mem_box {lo hi v : Vec3} :
    v ∈ box lo hi ↔ (lo 0 ≤ v 0 ∧ v 0 ≤ hi 0) ∧ (lo 1 ≤ v 1 ∧ v 1 ≤ hi 1) ∧ (lo 2 ≤ v 2 ∧ v 2 ≤ hi 2) := by
  constructor
  · intro h
    exact ⟨h 0, h 1, h 2⟩
  · rintro ⟨h0, h1, h2⟩ i
    fin_cases i
    · exact h0
    · exact h1
    · exact h2

theorem Ry_quarter_mulVec (v : Vec3) : Ry (π / 2) *ᵥ v = ![v 2, v 1, -v 0] := by
  simp

theorem Ry_neg_quarter_mulVec (v : Vec3) : Ry (-(π / 2)) *ᵥ v = ![-v 2, v 1, v 0] := by
  simp

/-- **A quarter turn swaps the X and Z extents** (§2.5): the box `[x₀,x₁] × [y₀,y₁] × [z₀,z₁]` turned by +90°
is exactly the box `[z₀,z₁] × [y₀,y₁] × [−x₁,−x₀]`. -/
theorem Ry_quarter_image_box (lo hi : Vec3) :
    (Ry (π / 2) *ᵥ ·) '' box lo hi = box ![lo 2, lo 1, -hi 0] ![hi 2, hi 1, -lo 0] := by
  ext w
  simp only [mem_image, Ry_quarter_mulVec, mem_box]
  constructor
  · rintro ⟨v, ⟨h0, h1, h2⟩, rfl⟩
    simp
    refine ⟨h2, h1, ?_, ?_⟩ <;> linarith [h0.1, h0.2]
  · rintro ⟨h0, h1, h2⟩
    refine ⟨![-w 2, w 1, w 0], ?_, ?_⟩
    · simp at h0 h1 h2 ⊢
      refine ⟨⟨?_, ?_⟩, h1, h0⟩ <;> linarith [h2.1, h2.2]
    · ext i
      fin_cases i <;> simp

/-- The same for a turn of −90°: the box becomes `[−z₁,−z₀] × [y₀,y₁] × [x₀,x₁]`. -/
theorem Ry_neg_quarter_image_box (lo hi : Vec3) :
    (Ry (-(π / 2)) *ᵥ ·) '' box lo hi = box ![-hi 2, lo 1, lo 0] ![-lo 2, hi 1, hi 0] := by
  ext w
  simp only [mem_image, Ry_neg_quarter_mulVec, mem_box]
  constructor
  · rintro ⟨v, ⟨h0, h1, h2⟩, rfl⟩
    simp
    refine ⟨⟨?_, ?_⟩, h1, h0⟩ <;> linarith [h2.1, h2.2]
  · rintro ⟨h0, h1, h2⟩
    refine ⟨![w 2, w 1, -w 0], ?_, ?_⟩
    · simp at h0 h1 h2 ⊢
      refine ⟨h2, h1, ?_, ?_⟩ <;> linarith [h0.1, h0.2]
    · ext i
      fin_cases i <;> simp

/-- An item's box in its own frame: footprint centred on the origin, on the floor, `w` along X, `h` along Y and
`d` along Z (CLAUDE.md's item frame). -/
def itemBox (w h d : ℝ) : Set Vec3 := box ![-(w / 2), 0, -(d / 2)] ![w / 2, h, d / 2]

/-- A corner that reaches furthest along `cos θ · x + sin θ · z`. -/
private theorem reach (c s w d : ℝ) (hw : 0 ≤ w) (hd : 0 ≤ d) :
    (∀ x z : ℝ, |x| ≤ w / 2 → |z| ≤ d / 2 → c * x + s * z ≤ (w * |c| + d * |s|) / 2) ∧
    ∃ x z : ℝ, |x| ≤ w / 2 ∧ |z| ≤ d / 2 ∧ c * x + s * z = (w * |c| + d * |s|) / 2 := by
  constructor
  · intro x z hx hz
    have h1 : c * x ≤ |c| * (w / 2) :=
      (le_abs_self _).trans (by rw [abs_mul]; exact mul_le_mul_of_nonneg_left hx (abs_nonneg c))
    have h2 : s * z ≤ |s| * (d / 2) :=
      (le_abs_self _).trans (by rw [abs_mul]; exact mul_le_mul_of_nonneg_left hz (abs_nonneg s))
    linarith
  · refine ⟨if 0 ≤ c then w / 2 else -(w / 2), if 0 ≤ s then d / 2 else -(d / 2), ?_, ?_, ?_⟩
    · split_ifs <;> simp [abs_of_nonneg (by linarith : 0 ≤ w / 2)]
    · split_ifs <;> simp [abs_of_nonneg (by linarith : 0 ≤ d / 2)]
    · split_ifs with h1 h2 h2
      · rw [abs_of_nonneg h1, abs_of_nonneg h2]; ring
      · rw [abs_of_nonneg h1, abs_of_neg (not_le.1 h2)]; ring
      · rw [abs_of_neg (not_le.1 h1), abs_of_nonneg h2]; ring
      · rw [abs_of_neg (not_le.1 h1), abs_of_neg (not_le.1 h2)]; ring

private theorem abs_le_of_mem_Icc {x a : ℝ} (h : -a ≤ x ∧ x ≤ a) : |x| ≤ a := abs_le.2 h

/-- **World bounds, X.** Turned by `θ`, an item's box reaches `x = ±(w·|cos θ| + d·|sin θ|) / 2`: the greatest
x of the turned box is exactly that (and, by symmetry, the least is its negative). -/
theorem worldBounds_x {w h d : ℝ} (hw : 0 ≤ w) (hh : 0 ≤ h) (hd : 0 ≤ d) (t : ℝ) :
    IsGreatest ((fun v => (Ry t *ᵥ v) 0) '' itemBox w h d) ((w * |cos t| + d * |sin t|) / 2) := by
  obtain ⟨hle, x, z, hx, hz, heq⟩ := reach (cos t) (sin t) w d hw hd
  constructor
  · refine ⟨![x, 0, z], ?_, ?_⟩
    · rw [itemBox, mem_box]
      simp
      exact ⟨abs_le.1 hx, hh, abs_le.1 hz⟩
    · simpa using heq
  · rintro _ ⟨v, hv, rfl⟩
    rw [itemBox, mem_box] at hv
    simp at hv ⊢
    exact hle _ _ (abs_le_of_mem_Icc hv.1) (abs_le_of_mem_Icc hv.2.2)

/-- **World bounds, Z.** Turned by `θ`, the greatest z of an item's box is `(w·|sin θ| + d·|cos θ|) / 2`. -/
theorem worldBounds_z {w h d : ℝ} (hw : 0 ≤ w) (hh : 0 ≤ h) (hd : 0 ≤ d) (t : ℝ) :
    IsGreatest ((fun v => (Ry t *ᵥ v) 2) '' itemBox w h d) ((w * |sin t| + d * |cos t|) / 2) := by
  obtain ⟨hle, x, z, hx, hz, heq⟩ := reach (-sin t) (cos t) w d hw hd
  rw [abs_neg] at hle heq
  constructor
  · refine ⟨![x, 0, z], ?_, ?_⟩
    · rw [itemBox, mem_box]
      simp
      exact ⟨abs_le.1 hx, hh, abs_le.1 hz⟩
    · simpa using heq
  · rintro _ ⟨v, hv, rfl⟩
    rw [itemBox, mem_box] at hv
    simp at hv ⊢
    linarith [hle _ _ (abs_le_of_mem_Icc hv.1) (abs_le_of_mem_Icc hv.2.2)]

/-- The box is symmetric about the origin in x and z, so the least x and z are the negatives of the greatest:
the world bounds are `w·|cos θ| + d·|sin θ|` wide and `w·|sin θ| + d·|cos θ|` deep. At 0° that is `w × d`, at 90°
`d × w`. -/
theorem worldBounds_x_least {w h d : ℝ} (hw : 0 ≤ w) (hh : 0 ≤ h) (hd : 0 ≤ d) (t : ℝ) :
    IsLeast ((fun v => (Ry t *ᵥ v) 0) '' itemBox w h d) (-((w * |cos t| + d * |sin t|) / 2)) := by
  obtain ⟨⟨v, hv, hv0⟩, hub⟩ := worldBounds_x hw hh hd t
  rw [itemBox, mem_box] at hv
  simp at hv
  constructor
  · refine ⟨![-v 0, v 1, -v 2], ?_, ?_⟩
    · rw [itemBox, mem_box]
      simp
      refine ⟨⟨?_, ?_⟩, hv.2.1, ?_, ?_⟩ <;> linarith [hv.1.1, hv.1.2, hv.2.2.1, hv.2.2.2]
    · simp at hv0 ⊢
      linarith
  · rintro _ ⟨u, hu, rfl⟩
    have hu' : ![-u 0, u 1, -u 2] ∈ itemBox w h d := by
      rw [itemBox, mem_box] at hu ⊢
      simp at hu ⊢
      refine ⟨⟨?_, ?_⟩, hu.2.1, ?_, ?_⟩ <;> linarith [hu.1.1, hu.1.2, hu.2.2.1, hu.2.2.2]
    have := hub ⟨_, hu', rfl⟩
    simp at this ⊢
    linarith

theorem worldBounds_z_least {w h d : ℝ} (hw : 0 ≤ w) (hh : 0 ≤ h) (hd : 0 ≤ d) (t : ℝ) :
    IsLeast ((fun v => (Ry t *ᵥ v) 2) '' itemBox w h d) (-((w * |sin t| + d * |cos t|) / 2)) := by
  obtain ⟨⟨v, hv, hv0⟩, hub⟩ := worldBounds_z hw hh hd t
  rw [itemBox, mem_box] at hv
  simp at hv
  constructor
  · refine ⟨![-v 0, v 1, -v 2], ?_, ?_⟩
    · rw [itemBox, mem_box]
      simp
      refine ⟨⟨?_, ?_⟩, hv.2.1, ?_, ?_⟩ <;> linarith [hv.1.1, hv.1.2, hv.2.2.1, hv.2.2.2]
    · simp at hv0 ⊢
      linarith
  · rintro _ ⟨u, hu, rfl⟩
    have hu' : ![-u 0, u 1, -u 2] ∈ itemBox w h d := by
      rw [itemBox, mem_box] at hu ⊢
      simp at hu ⊢
      refine ⟨⟨?_, ?_⟩, hu.2.1, ?_, ?_⟩ <;> linarith [hu.1.1, hu.1.2, hu.2.2.1, hu.2.2.2]
    have := hub ⟨_, hu', rfl⟩
    simp at this ⊢
    linarith

/-! ### Any box: the corners' bounds contain the whole turned box (geom LEAN.md property 16) -/

/-- A pose's transform, `world(p) = Ry(θ) · p + position` (geom `Transform::apply`). -/
def world (t : ℝ) (pos p : Vec3) : Vec3 := Ry t *ᵥ p + pos

/-- The 8 corners of the local box `[lo, hi]` (geom `box_corners`, order aside). -/
def corners (lo hi : Vec3) : List Vec3 :=
  [![lo 0, lo 1, lo 2], ![hi 0, lo 1, lo 2], ![hi 0, lo 1, hi 2], ![lo 0, lo 1, hi 2],
   ![lo 0, hi 1, lo 2], ![hi 0, hi 1, lo 2], ![hi 0, hi 1, hi 2], ![lo 0, hi 1, hi 2]]

/-- A linear form `a·x + b·z` over a rectangle reaches its maximum and minimum at corners. -/
private theorem lin_corner (a b x z x0 x1 z0 z1 : ℝ) (hx : x0 ≤ x ∧ x ≤ x1) (hz : z0 ≤ z ∧ z ≤ z1) :
    (∃ x' z', (x' = x0 ∨ x' = x1) ∧ (z' = z0 ∨ z' = z1) ∧ a * x + b * z ≤ a * x' + b * z') ∧
      (∃ x' z', (x' = x0 ∨ x' = x1) ∧ (z' = z0 ∨ z' = z1) ∧ a * x' + b * z' ≤ a * x + b * z) := by
  constructor
  · rcases le_total 0 a with ha | ha <;> rcases le_total 0 b with hb | hb
    · exact ⟨x1, z1, Or.inr rfl, Or.inr rfl, by nlinarith⟩
    · exact ⟨x1, z0, Or.inr rfl, Or.inl rfl, by nlinarith⟩
    · exact ⟨x0, z1, Or.inl rfl, Or.inr rfl, by nlinarith⟩
    · exact ⟨x0, z0, Or.inl rfl, Or.inl rfl, by nlinarith⟩
  · rcases le_total 0 a with ha | ha <;> rcases le_total 0 b with hb | hb
    · exact ⟨x0, z0, Or.inl rfl, Or.inl rfl, by nlinarith⟩
    · exact ⟨x0, z1, Or.inl rfl, Or.inr rfl, by nlinarith⟩
    · exact ⟨x1, z0, Or.inr rfl, Or.inl rfl, by nlinarith⟩
    · exact ⟨x1, z1, Or.inr rfl, Or.inr rfl, by nlinarith⟩

private theorem corner_mem {lo hi : Vec3} {x' y' z' : ℝ} (hx : x' = lo 0 ∨ x' = hi 0) (hy : y' = lo 1 ∨ y' = hi 1)
    (hz : z' = lo 2 ∨ z' = hi 2) : ![x', y', z'] ∈ corners lo hi := by
  rcases hx with rfl | rfl <;> rcases hy with rfl | rfl <;> rcases hz with rfl | rfl <;> simp [corners]

/-- **Every point of the turned box is within its corners' bounds** (x): some corner reaches at least as far, some at
most as far. -/
theorem corners_bound_x {lo hi p : Vec3} (hp : p ∈ box lo hi) (t : ℝ) (pos : Vec3) :
    (∃ q ∈ corners lo hi, world t pos p 0 ≤ world t pos q 0) ∧
      (∃ q ∈ corners lo hi, world t pos q 0 ≤ world t pos p 0) := by
  rw [mem_box] at hp
  obtain ⟨hx, hy, hz⟩ := hp
  obtain ⟨⟨x', z', hx', hz', h⟩, ⟨x'', z'', hx'', hz'', h'⟩⟩ := lin_corner (cos t) (sin t) _ _ _ _ _ _ hx hz
  refine ⟨⟨![x', lo 1, z'], corner_mem hx' (Or.inl rfl) hz', ?_⟩, ⟨![x'', lo 1, z''], corner_mem hx'' (Or.inl rfl)
    hz'', ?_⟩⟩ <;> simp [world] <;> linarith

theorem corners_bound_z {lo hi p : Vec3} (hp : p ∈ box lo hi) (t : ℝ) (pos : Vec3) :
    (∃ q ∈ corners lo hi, world t pos p 2 ≤ world t pos q 2) ∧
      (∃ q ∈ corners lo hi, world t pos q 2 ≤ world t pos p 2) := by
  rw [mem_box] at hp
  obtain ⟨hx, hy, hz⟩ := hp
  obtain ⟨⟨x', z', hx', hz', h⟩, ⟨x'', z'', hx'', hz'', h'⟩⟩ := lin_corner (-sin t) (cos t) _ _ _ _ _ _ hx hz
  refine ⟨⟨![x', lo 1, z'], corner_mem hx' (Or.inl rfl) hz', ?_⟩, ⟨![x'', lo 1, z''], corner_mem hx'' (Or.inl rfl)
    hz'', ?_⟩⟩ <;> simp [world] <;> linarith

theorem corners_bound_y {lo hi p : Vec3} (hp : p ∈ box lo hi) (t : ℝ) (pos : Vec3) :
    (∃ q ∈ corners lo hi, world t pos p 1 ≤ world t pos q 1) ∧
      (∃ q ∈ corners lo hi, world t pos q 1 ≤ world t pos p 1) := by
  rw [mem_box] at hp
  obtain ⟨hx, hy, hz⟩ := hp
  refine ⟨⟨![lo 0, hi 1, lo 2], corner_mem (Or.inl rfl) (Or.inr rfl) (Or.inl rfl), ?_⟩,
    ⟨![lo 0, lo 1, lo 2], corner_mem (Or.inl rfl) (Or.inl rfl) (Or.inl rfl), ?_⟩⟩ <;> simp [world] <;> linarith

/-- The footprint's centre (the mean of its four corners) is the world point of the box's centre on its floor
(geom `footprint`). -/
theorem footprint_centre (t : ℝ) (pos lo hi : Vec3) :
    (1 / 4 : ℝ) • (world t pos ![lo 0, 0, hi 2] + world t pos ![hi 0, 0, hi 2] + world t pos ![hi 0, 0, lo 2] +
      world t pos ![lo 0, 0, lo 2]) = world t pos ![(lo 0 + hi 0) / 2, 0, (lo 2 + hi 2) / 2] := by
  ext i
  fin_cases i <;> simp [world, Matrix.vecHead, Matrix.vecTail] <;> ring

/-- At a quarter turn the world bounds are `d` wide and `w` deep: the X and Z extents swap (§2.5). -/
theorem worldBounds_quarter (w d : ℝ) :
    (w * |cos (π / 2)| + d * |sin (π / 2)| = d) ∧ (w * |sin (π / 2)| + d * |cos (π / 2)| = w) := by
  simp

end Midstudy
