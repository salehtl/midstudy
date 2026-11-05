import Mathlib.Algebra.Order.ToIntervalMod
import Mathlib.Algebra.Order.Round
import Midstudy.Camera
import Midstudy.Item

/-!
# Clamps and angle wrapping (contract §4.1 ranges, §4.8 Look, §2.3 rotation)

Every writer clamps the camera block to §4.1's ranges and the Look numbers to §4.8's (engine.js `clampCamera`,
`lookFrom`; serve.py `clamp_camera`, the `look` merge). Rotations are kept in (−180°, 180°] (engine.js `wrapDeg`)
and the light's azimuth in [−180°, 180°] (`wrapAz`). Rounding to 6 decimals is modelled exactly over ℝ: the planner's
`Math.round(v · 10⁶) / 10⁶` (`round6`, `Math.round(x) = ⌊x + 1/2⌋`) and Python's `round(v, 6)` (`round6Py`, ties to
even). JavaScript's `%` is modelled as the remainder of the quotient truncated toward zero (`jsRem`).

Main results:
* `clamp_mem`, `clamp_idem`, `clamp_mono`: `min(hi, max(lo, v))` lands in `[lo, hi]`, is idempotent and monotone;
  `GridRound.mem`, `.idem`, `.mono`: the same after a rounding that is monotone, idempotent and keeps the ends
  (`round6_gridRound`, `round6Py_gridRound` for every range of §4.1 and §4.8).
* `clampCamera_inRange`, `clampCamera_idem`, `clampCamera_mono` (planner) and `clampCameraPy_*` (server).
* `lookNum_mem`, `lookNum_idem`, `lookNum_mono` (every Look number but the azimuth),
  `lookNum_azimuth_congr` (the azimuth is wrapped, then clamped: same direction mod 360°), and
  `wrapAz_not_monotone`: wrapping is not monotone, so the azimuth is the one Look number that isn't.
* `wrapDeg_eq_toIocMod`: `wrapDeg` is exactly the representative in (−180, 180] mod 360; so it lands there
  (`wrapDeg_mem`), is congruent to its input (`wrapDeg_modEq`), is idempotent, and never changes an item's
  rotation (`Ry_rad_wrapDeg`). `wrapAz_mem`, `wrapAz_modEq`, `wrapAz_idem` for the azimuth.
-/

noncomputable section

open Real Set

namespace Midstudy

/-! ### `min(hi, max(lo, v))` -/

/-- `Math.min(hi, Math.max(lo, v))` (planner) and `min(hi, max(lo, v))` (server). -/
def clamp (lo hi v : ℝ) : ℝ := min hi (max lo v)

theorem clamp_mem {lo hi : ℝ} (h : lo ≤ hi) (v : ℝ) : clamp lo hi v ∈ Icc lo hi :=
  ⟨le_min h (le_max_left _ _), min_le_left _ _⟩

theorem clamp_of_mem {lo hi v : ℝ} (hv : v ∈ Icc lo hi) : clamp lo hi v = v := by
  simp [clamp, max_eq_right hv.1, min_eq_right hv.2]

theorem clamp_idem {lo hi : ℝ} (h : lo ≤ hi) (v : ℝ) : clamp lo hi (clamp lo hi v) = clamp lo hi v :=
  clamp_of_mem (clamp_mem h v)

theorem clamp_mono (lo hi : ℝ) : Monotone (clamp lo hi) :=
  fun _ _ hab => min_le_min le_rfl (max_le_max le_rfl hab)

/-! ### Rounding to 6 decimals -/

/-- A rounding that keeps order (monotone), is idempotent, and keeps the two ends of a range `[lo, hi]`. -/
structure GridRound (r : ℝ → ℝ) (lo hi : ℝ) : Prop where
  mono : Monotone r
  idem : ∀ x, r (r x) = r x
  fix_lo : r lo = lo
  fix_hi : r hi = hi

namespace GridRound

variable {r : ℝ → ℝ} {lo hi : ℝ}

/-- Rounded after clamping, a value still lands in the range. -/
theorem clamp_mem (hr : GridRound r lo hi) (h : lo ≤ hi) (v : ℝ) : r (clamp lo hi v) ∈ Icc lo hi := by
  constructor
  · calc lo = r lo := hr.fix_lo.symm
      _ ≤ r (clamp lo hi v) := hr.mono (Midstudy.clamp_mem h v).1
  · calc r (clamp lo hi v) ≤ r hi := hr.mono (Midstudy.clamp_mem h v).2
      _ = hi := hr.fix_hi

theorem clamp_idem (hr : GridRound r lo hi) (h : lo ≤ hi) (v : ℝ) :
    r (clamp lo hi (r (clamp lo hi v))) = r (clamp lo hi v) := by
  rw [clamp_of_mem (hr.clamp_mem h v), hr.idem]

theorem clamp_mono (hr : GridRound r lo hi) : Monotone (fun v => r (clamp lo hi v)) :=
  hr.mono.comp (Midstudy.clamp_mono lo hi)

end GridRound

theorem round_monotone : Monotone (round : ℝ → ℤ) := fun a b h => by
  rw [round_eq, round_eq]
  exact Int.floor_mono (by linarith)

/-- The planner's `round(v, 6)`: `Math.round(v * 10 ** 6) / 10 ** 6` (engine.js `round`), where
`Math.round(x) = ⌊x + 1/2⌋` is Mathlib's `round` (`round_eq`). -/
def round6 (v : ℝ) : ℝ := (round (v * 10 ^ 6) : ℝ) / 10 ^ 6

theorem round6_mono : Monotone round6 := fun a b h => by
  unfold round6
  apply div_le_div_of_nonneg_right _ (by positivity)
  exact_mod_cast round_monotone (mul_le_mul_of_nonneg_right h (by positivity))

theorem round6_idem (x : ℝ) : round6 (round6 x) = round6 x := by
  unfold round6
  rw [div_mul_cancel₀ _ (by positivity), round_intCast]

theorem round6_of_mul_eq_int {x : ℝ} {k : ℤ} (h : x * 10 ^ 6 = k) : round6 x = x := by
  unfold round6
  rw [h, round_intCast, ← h, mul_div_cancel_right₀ _ (by positivity)]

/-- `round6` is a `GridRound` for every range whose ends have at most 6 decimals. -/
theorem round6_gridRound {lo hi : ℝ} {a b : ℤ} (ha : lo * 10 ^ 6 = a) (hb : hi * 10 ^ 6 = b) :
    GridRound round6 lo hi :=
  ⟨round6_mono, round6_idem, round6_of_mul_eq_int ha, round6_of_mul_eq_int hb⟩

/-- Python's `round(x)` on a real number: the nearest integer, ties to the even one. -/
def roundHalfEven (x : ℝ) : ℤ :=
  if Int.fract x < 1 / 2 then ⌊x⌋
  else if 1 / 2 < Int.fract x then ⌊x⌋ + 1
  else if Even ⌊x⌋ then ⌊x⌋ else ⌊x⌋ + 1

theorem roundHalfEven_bounds (x : ℝ) : ⌈x - 1 / 2⌉ ≤ roundHalfEven x ∧ roundHalfEven x ≤ ⌊x + 1 / 2⌋ := by
  have hf := Int.self_sub_floor x
  have h0 := Int.fract_nonneg x
  have h1 := Int.fract_lt_one x
  unfold roundHalfEven
  split_ifs with ha hb hc
  · constructor
    · exact Int.ceil_le.2 (by linarith)
    · exact Int.le_floor.2 (by linarith)
  · constructor
    · exact Int.ceil_le.2 (by push_cast; linarith)
    · exact Int.le_floor.2 (by push_cast; linarith)
  · constructor
    · exact Int.ceil_le.2 (by linarith)
    · exact Int.le_floor.2 (by linarith)
  · constructor
    · exact Int.ceil_le.2 (by push_cast; linarith)
    · exact Int.le_floor.2 (by push_cast; linarith)

theorem roundHalfEven_mono : Monotone roundHalfEven := by
  intro x y hxy
  rcases eq_or_lt_of_le hxy with rfl | hlt
  · exact le_rfl
  · have hx := (roundHalfEven_bounds x).2
    have hy := (roundHalfEven_bounds y).1
    have key : ⌊x + 1 / 2⌋ ≤ ⌈y - 1 / 2⌉ := by
      by_contra hcon
      have h1 : (⌈y - 1 / 2⌉ : ℝ) + 1 ≤ ⌊x + 1 / 2⌋ := by exact_mod_cast (not_le.1 hcon)
      have h2 := Int.le_ceil (y - 1 / 2)
      have h3 := Int.floor_le (x + 1 / 2)
      linarith
    omega

theorem roundHalfEven_intCast (n : ℤ) : roundHalfEven n = n := by
  simp [roundHalfEven]

/-- serve.py's `round(v, 6)` over ℝ: Python rounds half to even. -/
def round6Py (v : ℝ) : ℝ := (roundHalfEven (v * 10 ^ 6) : ℝ) / 10 ^ 6

theorem round6Py_gridRound {lo hi : ℝ} {a b : ℤ} (ha : lo * 10 ^ 6 = a) (hb : hi * 10 ^ 6 = b) :
    GridRound round6Py lo hi := by
  refine ⟨fun x y h => ?_, fun x => ?_, ?_, ?_⟩
  · unfold round6Py
    apply div_le_div_of_nonneg_right _ (by positivity)
    exact_mod_cast roundHalfEven_mono (mul_le_mul_of_nonneg_right h (by positivity))
  · unfold round6Py
    rw [div_mul_cancel₀ _ (by positivity), roundHalfEven_intCast]
  · unfold round6Py
    rw [ha, roundHalfEven_intCast, ← ha, mul_div_cancel_right₀ _ (by positivity)]
  · unfold round6Py
    rw [hb, roundHalfEven_intCast, ← hb, mul_div_cancel_right₀ _ (by positivity)]

/-! ### The camera block (§4.1) -/

/-- A camera block as it arrives (a file, a PUT, `setCamera`): each field a finite number, or `none` when it is
missing or not a finite number (engine.js `isNum`, serve.py `is_num`). -/
structure CameraInput where
  fov_y_deg : Option ℝ
  height_m : Option ℝ
  pitch_deg : Option ℝ
  roll_deg : Option ℝ

/-- A camera block, every field present. -/
def CameraBlock.toInput (c : CameraBlock) : CameraInput :=
  ⟨some c.fov_y_deg, some c.height_m, some c.pitch_deg, some c.roll_deg⟩

/-- `DEFAULT_CAMERA` (the default camera without calibration, §4.1): `{55, 1.40, −10, 0}`. -/
def DEFAULT_CAMERA : CameraBlock := ⟨55, 1.4, -10, 0⟩

theorem DEFAULT_CAMERA_inRange : DEFAULT_CAMERA.InRange := by
  refine ⟨?_, ?_, ?_, ?_⟩ <;> norm_num [DEFAULT_CAMERA]

/-- engine.js `clampNum(v, lo, hi, dflt)`: a number is clamped, anything else takes the default. -/
def clampNum (v : Option ℝ) (lo hi dflt : ℝ) : ℝ :=
  match v with
  | some x => clamp lo hi x
  | none => dflt

/-- One field of `clampCamera`: clamp (or the default), then `r`. -/
def clampField (r : ℝ → ℝ) (lo hi dflt : ℝ) (v : Option ℝ) : ℝ := r (clampNum v lo hi dflt)

@[simp] theorem clampField_some (r : ℝ → ℝ) (lo hi dflt x : ℝ) :
    clampField r lo hi dflt (some x) = r (clamp lo hi x) := rfl

@[simp] theorem clampField_none (r : ℝ → ℝ) (lo hi dflt : ℝ) : clampField r lo hi dflt none = r dflt := rfl

theorem clampField_mem {r : ℝ → ℝ} {lo hi dflt : ℝ} (hr : GridRound r lo hi) (h : lo ≤ hi)
    (hd : dflt ∈ Icc lo hi) (v : Option ℝ) : clampField r lo hi dflt v ∈ Icc lo hi := by
  cases v with
  | some x => exact hr.clamp_mem h x
  | none =>
    rw [clampField_none, ← clamp_of_mem hd]
    exact hr.clamp_mem h dflt

theorem clampField_idem {r : ℝ → ℝ} {lo hi dflt : ℝ} (hr : GridRound r lo hi) (h : lo ≤ hi)
    (hd : dflt ∈ Icc lo hi) (v : Option ℝ) (dflt' : ℝ) :
    clampField r lo hi dflt' (some (clampField r lo hi dflt v)) = clampField r lo hi dflt v := by
  rw [clampField_some, clamp_of_mem (clampField_mem hr h hd v)]
  simp only [clampField]
  exact hr.idem _

theorem clampField_mono {r : ℝ → ℝ} {lo hi : ℝ} (hr : GridRound r lo hi) (dflt : ℝ) :
    Monotone (fun x : ℝ => clampField r lo hi dflt (some x)) :=
  fun _ _ h => hr.clamp_mono h

/-- The four `CAMERA_RANGE`s with the rounding `r`: the hypotheses every theorem below needs. -/
structure CameraRound (r : ℝ → ℝ) : Prop where
  fov : GridRound r 20 110
  height : GridRound r 0.2 3
  pitch : GridRound r (-80) 30
  roll : GridRound r (-20) 20

theorem round6_cameraRound : CameraRound round6 :=
  ⟨round6_gridRound (a := 20000000) (b := 110000000) (by norm_num) (by norm_num),
   round6_gridRound (a := 200000) (b := 3000000) (by norm_num) (by norm_num),
   round6_gridRound (a := -80000000) (b := 30000000) (by norm_num) (by norm_num),
   round6_gridRound (a := -20000000) (b := 20000000) (by norm_num) (by norm_num)⟩

theorem round6Py_cameraRound : CameraRound round6Py :=
  ⟨round6Py_gridRound (a := 20000000) (b := 110000000) (by norm_num) (by norm_num),
   round6Py_gridRound (a := 200000) (b := 3000000) (by norm_num) (by norm_num),
   round6Py_gridRound (a := -80000000) (b := 30000000) (by norm_num) (by norm_num),
   round6Py_gridRound (a := -20000000) (b := 20000000) (by norm_num) (by norm_num)⟩

/-- `clampCamera` with a given rounding: each field clamped to its `CAMERA_RANGE` (a missing one takes `base`'s), then
rounded. -/
def clampCameraWith (r : ℝ → ℝ) (c : CameraInput) (base : CameraBlock) : CameraBlock where
  fov_y_deg := clampField r 20 110 base.fov_y_deg c.fov_y_deg
  height_m := clampField r 0.2 3 base.height_m c.height_m
  pitch_deg := clampField r (-80) 30 base.pitch_deg c.pitch_deg
  roll_deg := clampField r (-20) 20 base.roll_deg c.roll_deg

/-- engine.js `clampCamera(c, base = DEFAULT_CAMERA)`: `round(clampNum(c[k], lo, hi, base[k]), 6)` per field. -/
def clampCamera (c : CameraInput) (base : CameraBlock := DEFAULT_CAMERA) : CameraBlock :=
  clampCameraWith round6 c base

/-- serve.py `clamp_camera(cam)`: `round(min(hi, max(lo, v)), 6)` for a number, else `DEFAULT_CAMERA`'s value
(not rounded: the defaults already have at most 6 decimals). -/
def clampCameraPy (c : CameraInput) : CameraBlock where
  fov_y_deg := match c.fov_y_deg with | some x => round6Py (clamp 20 110 x) | none => DEFAULT_CAMERA.fov_y_deg
  height_m := match c.height_m with | some x => round6Py (clamp 0.2 3 x) | none => DEFAULT_CAMERA.height_m
  pitch_deg := match c.pitch_deg with | some x => round6Py (clamp (-80) 30 x) | none => DEFAULT_CAMERA.pitch_deg
  roll_deg := match c.roll_deg with | some x => round6Py (clamp (-20) 20 x) | none => DEFAULT_CAMERA.roll_deg

theorem clampCameraPy_eq (c : CameraInput) : clampCameraPy c = clampCameraWith round6Py c DEFAULT_CAMERA := by
  have e1 : round6Py DEFAULT_CAMERA.fov_y_deg = DEFAULT_CAMERA.fov_y_deg := by
    unfold round6Py DEFAULT_CAMERA
    rw [show (55 : ℝ) * 10 ^ 6 = ((55000000 : ℤ) : ℝ) by norm_num, roundHalfEven_intCast]
    norm_num
  have e2 : round6Py DEFAULT_CAMERA.height_m = DEFAULT_CAMERA.height_m := by
    unfold round6Py DEFAULT_CAMERA
    rw [show (1.4 : ℝ) * 10 ^ 6 = ((1400000 : ℤ) : ℝ) by norm_num, roundHalfEven_intCast]
    norm_num
  have e3 : round6Py DEFAULT_CAMERA.pitch_deg = DEFAULT_CAMERA.pitch_deg := by
    unfold round6Py DEFAULT_CAMERA
    rw [show (-10 : ℝ) * 10 ^ 6 = ((-10000000 : ℤ) : ℝ) by norm_num, roundHalfEven_intCast]
    norm_num
  have e4 : round6Py DEFAULT_CAMERA.roll_deg = DEFAULT_CAMERA.roll_deg := by
    unfold round6Py DEFAULT_CAMERA
    simp [roundHalfEven]
  have d := DEFAULT_CAMERA_inRange
  cases c with
  | mk f h p r =>
    simp only [clampCameraPy, clampCameraWith, clampField, clampNum]
    congr 1
    · cases f <;> simp [e1]
    · cases h <;> simp [e2]
    · cases p <;> simp [e3]
    · cases r <;> simp [e4]

section
variable {r : ℝ → ℝ} (hr : CameraRound r)
include hr

/-- **A clamped camera block lands in range** (given a base in range: `DEFAULT_CAMERA`, or the current camera). -/
theorem clampCameraWith_inRange {base : CameraBlock} (hb : base.InRange) (c : CameraInput) :
    (clampCameraWith r c base).InRange :=
  ⟨clampField_mem hr.fov (by norm_num) hb.fov c.fov_y_deg,
   clampField_mem hr.height (by norm_num) hb.height c.height_m,
   clampField_mem hr.pitch (by norm_num) hb.pitch c.pitch_deg,
   clampField_mem hr.roll (by norm_num) hb.roll c.roll_deg⟩

/-- **Clamping is idempotent**: clamping a clamped block again (with any base) changes nothing. -/
theorem clampCameraWith_idem {base : CameraBlock} (hb : base.InRange) (c : CameraInput) (base' : CameraBlock) :
    clampCameraWith r (clampCameraWith r c base).toInput base' = clampCameraWith r c base := by
  simp only [clampCameraWith, CameraBlock.toInput]
  rw [clampField_idem hr.fov (by norm_num) hb.fov, clampField_idem hr.height (by norm_num) hb.height,
    clampField_idem hr.pitch (by norm_num) hb.pitch, clampField_idem hr.roll (by norm_num) hb.roll]

/-- Fieldwise order between two camera blocks. -/
def _root_.Midstudy.CameraBlock.Le (a b : CameraBlock) : Prop :=
  a.fov_y_deg ≤ b.fov_y_deg ∧ a.height_m ≤ b.height_m ∧ a.pitch_deg ≤ b.pitch_deg ∧ a.roll_deg ≤ b.roll_deg

/-- **Clamping is monotone**, field by field. -/
theorem clampCameraWith_mono {a b : CameraBlock} (h : a.Le b) (base base' : CameraBlock) :
    (clampCameraWith r a.toInput base).Le (clampCameraWith r b.toInput base') :=
  ⟨hr.fov.clamp_mono h.1, hr.height.clamp_mono h.2.1, hr.pitch.clamp_mono h.2.2.1, hr.roll.clamp_mono h.2.2.2⟩

end

theorem clampCamera_inRange {base : CameraBlock} (hb : base.InRange) (c : CameraInput) :
    (clampCamera c base).InRange :=
  clampCameraWith_inRange round6_cameraRound hb c

theorem clampCamera_idem {base : CameraBlock} (hb : base.InRange) (c : CameraInput) (base' : CameraBlock) :
    clampCamera (clampCamera c base).toInput base' = clampCamera c base :=
  clampCameraWith_idem round6_cameraRound hb c base'

theorem clampCamera_mono {a b : CameraBlock} (h : a.Le b) (base base' : CameraBlock) :
    (clampCamera a.toInput base).Le (clampCamera b.toInput base') :=
  clampCameraWith_mono round6_cameraRound h base base'

theorem clampCameraPy_inRange (c : CameraInput) : (clampCameraPy c).InRange := by
  rw [clampCameraPy_eq]
  exact clampCameraWith_inRange round6Py_cameraRound DEFAULT_CAMERA_inRange c

theorem clampCameraPy_idem (c : CameraInput) : clampCameraPy (clampCameraPy c).toInput = clampCameraPy c := by
  rw [clampCameraPy_eq, clampCameraPy_eq]
  exact clampCameraWith_idem round6Py_cameraRound DEFAULT_CAMERA_inRange c DEFAULT_CAMERA

theorem clampCameraPy_mono {a b : CameraBlock} (h : a.Le b) :
    (clampCameraPy a.toInput).Le (clampCameraPy b.toInput) := by
  rw [clampCameraPy_eq, clampCameraPy_eq]
  exact clampCameraWith_mono round6Py_cameraRound h DEFAULT_CAMERA DEFAULT_CAMERA

/-! ### JavaScript's `%`, `wrapDeg` and `wrapAz` -/

/-- 360 > 0, named so that every `toIcoMod`/`toIocMod` below carries the same proof term. -/
theorem h360 : (0 : ℝ) < 360 := by norm_num

/-- JavaScript's integer part of a quotient: truncated toward zero. -/
def jsTrunc (x : ℝ) : ℤ := if 0 ≤ x then ⌊x⌋ else ⌈x⌉

/-- JavaScript's `a % n` on numbers (ECMAScript Number::remainder): `a − n · trunc(a / n)`. -/
def jsRem (a n : ℝ) : ℝ := a - n * jsTrunc (a / n)

theorem jsRem_of_nonneg {a n : ℝ} (ha : 0 ≤ a) (hn : 0 < n) : jsRem a n = a - n * ⌊a / n⌋ := by
  simp [jsRem, jsTrunc, div_nonneg ha hn.le]

theorem jsRem_nonneg_lt {a n : ℝ} (ha : 0 ≤ a) (hn : 0 < n) : 0 ≤ jsRem a n ∧ jsRem a n < n := by
  rw [jsRem_of_nonneg ha hn]
  have h1 := Int.floor_le (a / n)
  have h2 := Int.lt_floor_add_one (a / n)
  have e : a = n * (a / n) := by field_simp
  constructor <;> nlinarith

theorem neg_lt_jsRem {a n : ℝ} (hn : 0 < n) : -n < jsRem a n := by
  by_cases ha : 0 ≤ a
  · linarith [(jsRem_nonneg_lt ha hn).1]
  · have hq : ¬ 0 ≤ a / n := fun h => ha (by
      have := mul_nonneg h hn.le
      rwa [div_mul_cancel₀ _ hn.ne'] at this)
    simp only [jsRem, jsTrunc, if_neg hq]
    have h1 := Int.ceil_lt_add_one (a / n)
    have e : a = n * (a / n) := by field_simp
    nlinarith

theorem jsRem_modEq (a n : ℝ) : ∃ z : ℤ, a = jsRem a n + z • n :=
  ⟨jsTrunc (a / n), by simp [jsRem, zsmul_eq_mul]; ring⟩

/-- `((a % 360) + 360) % 360` is the representative of `a` in `[0, 360)` (Mathlib's `toIcoMod`). -/
theorem jsRem_jsRem_add (a : ℝ) :
    jsRem (jsRem a 360 + 360) 360 = toIcoMod h360 0 a := by
  symm
  rw [toIcoMod_eq_iff]
  have h0 : 0 ≤ jsRem a 360 + 360 := by linarith [neg_lt_jsRem (a := a) h360]
  obtain ⟨hlo, hhi⟩ := jsRem_nonneg_lt h0 h360
  refine ⟨⟨hlo, by simpa using hhi⟩, ?_⟩
  obtain ⟨z1, hz1⟩ := jsRem_modEq a 360
  obtain ⟨z2, hz2⟩ := jsRem_modEq (jsRem a 360 + 360) 360
  refine ⟨z1 + z2 - 1, ?_⟩
  simp only [zsmul_eq_mul] at hz1 hz2 ⊢
  push_cast
  linarith

/-- engine.js `wrapDeg`: `((d + 180) % 360 + 360) % 360 − 180`, with −180 written as 180. -/
def wrapDeg (d : ℝ) : ℝ :=
  if jsRem (jsRem (d + 180) 360 + 360) 360 - 180 = -180 then 180
  else jsRem (jsRem (d + 180) 360 + 360) 360 - 180

/-- **`wrapDeg` is the representative in (−180, 180] mod 360**, Mathlib's `toIocMod`. -/
theorem wrapDeg_eq_toIocMod (d : ℝ) : wrapDeg d = toIocMod h360 (-180) d := by
  symm
  rw [toIocMod_eq_iff]
  have hm := toIcoMod_mem_Ico h360 0 (d + 180)
  obtain ⟨z, hz⟩ := (toIcoMod_eq_iff h360).1
    (rfl : toIcoMod h360 0 (d + 180) = _) |>.2
  unfold wrapDeg
  rw [jsRem_jsRem_add]
  split_ifs with h
  · refine ⟨⟨by norm_num, by norm_num⟩, z - 1, ?_⟩
    simp only [zsmul_eq_mul] at hz ⊢
    push_cast
    linarith
  · refine ⟨⟨?_, by linarith [hm.2]⟩, z, ?_⟩
    · rcases eq_or_lt_of_le hm.1 with h' | h'
      · exact absurd (by linarith) h
      · linarith
    · simp only [zsmul_eq_mul] at hz ⊢
      linarith

/-- `wrapDeg` lands in (−180, 180]. -/
theorem wrapDeg_mem (d : ℝ) : wrapDeg d ∈ Ioc (-180) 180 := by
  rw [wrapDeg_eq_toIocMod]
  have := toIocMod_mem_Ioc h360 (-180) d
  norm_num at this ⊢
  exact this

/-- `wrapDeg` is congruent to its input mod 360. -/
theorem wrapDeg_modEq (d : ℝ) : ∃ k : ℤ, wrapDeg d = d + 360 * k := by
  rw [wrapDeg_eq_toIocMod]
  obtain ⟨-, z, hz⟩ := (toIocMod_eq_iff h360).1
    (rfl : toIocMod h360 (-180) d = _)
  refine ⟨-z, ?_⟩
  simp only [zsmul_eq_mul] at hz
  push_cast
  linarith

/-- `wrapDeg` changes nothing in (−180, 180]. -/
theorem wrapDeg_of_mem {d : ℝ} (h : d ∈ Ioc (-180) 180) : wrapDeg d = d := by
  rw [wrapDeg_eq_toIocMod, toIocMod_eq_iff]
  exact ⟨by norm_num; exact h, 0, by simp⟩

theorem wrapDeg_idem (d : ℝ) : wrapDeg (wrapDeg d) = wrapDeg d := wrapDeg_of_mem (wrapDeg_mem d)

/-- **Wrapping never turns an item**: `Ry(wrapDeg d) = Ry(d)`. -/
theorem Ry_rad_wrapDeg (d : ℝ) : Ry (rad (wrapDeg d)) = Ry (rad d) := by
  obtain ⟨k, hk⟩ := wrapDeg_modEq d
  rw [hk, Ry_rad_add_360_mul]

/-- Whole turns don't change the wrapped angle. -/
theorem wrapDeg_add_int_mul (x : ℝ) (k : ℤ) : wrapDeg (x + 360 * k) = wrapDeg x := by
  rw [wrapDeg_eq_toIocMod, wrapDeg_eq_toIocMod, show x + 360 * (k : ℝ) = x + k • (360 : ℝ) by
    rw [zsmul_eq_mul]; ring, toIocMod_add_zsmul]

theorem wrapDeg_wrapDeg_add (a b : ℝ) : wrapDeg (wrapDeg a + b) = wrapDeg (a + b) := by
  obtain ⟨k, hk⟩ := wrapDeg_modEq a
  rw [hk, show a + 360 * (k : ℝ) + b = a + b + 360 * k by ring, wrapDeg_add_int_mul]

/-- engine.js `rotateSelected(deg)` (geom `rotate_by`): the stored angle, `round(wrapDeg(rot + deg), 6)`. -/
def rotateBy (rot deg : ℝ) : ℝ := round6 (wrapDeg (rot + deg))

/-- A whole number of millionths of a degree (the grid `round6` keeps). -/
def OnGrid (x : ℝ) : Prop := ∃ k : ℤ, x * 10 ^ 6 = k

theorem OnGrid.add {x y : ℝ} (hx : OnGrid x) (hy : OnGrid y) : OnGrid (x + y) := by
  obtain ⟨a, ha⟩ := hx
  obtain ⟨b, hb⟩ := hy
  exact ⟨a + b, by push_cast; linarith⟩

theorem wrapDeg_onGrid {x : ℝ} (hx : OnGrid x) : OnGrid (wrapDeg x) := by
  obtain ⟨k, hk⟩ := wrapDeg_modEq x
  obtain ⟨a, ha⟩ := hx
  exact ⟨a + 360000000 * k, by rw [hk]; push_cast; linarith⟩

theorem rotateBy_onGrid {x d : ℝ} (hx : OnGrid x) (hd : OnGrid d) : rotateBy x d = wrapDeg (x + d) := by
  obtain ⟨k, hk⟩ := wrapDeg_onGrid (hx.add hd)
  exact round6_of_mul_eq_int hk

/-- **Four quarter turns give back the stored angle exactly** (geom props `four_quarter_turns`): for an angle on
v1's 10⁻⁶ grid in (−180, 180], `R` four times (or the +90° rotation four times) returns it, bit for bit over ℝ. -/
theorem rotateBy_four_quarters {x : ℝ} (hx : OnGrid x) (hr : x ∈ Ioc (-180) 180) :
    rotateBy (rotateBy (rotateBy (rotateBy x 90) 90) 90) 90 = x := by
  have h90 : OnGrid 90 := ⟨90000000, by norm_num⟩
  have e1 : wrapDeg (wrapDeg (x + 90) + 90) = wrapDeg (x + 180) := by
    rw [wrapDeg_wrapDeg_add]
    congr 1
    ring
  have e2 : wrapDeg (wrapDeg (x + 180) + 90) = wrapDeg (x + 270) := by
    rw [wrapDeg_wrapDeg_add]
    congr 1
    ring
  have e3 : wrapDeg (wrapDeg (x + 270) + 90) = x := by
    rw [wrapDeg_wrapDeg_add, show x + 270 + 90 = x + 360 * ((1 : ℤ) : ℝ) by push_cast; ring,
      wrapDeg_add_int_mul, wrapDeg_of_mem hr]
  have g1 := wrapDeg_onGrid (hx.add h90)
  have g2 : OnGrid (wrapDeg (x + 180)) := by rw [← e1]; exact wrapDeg_onGrid (g1.add h90)
  have g3 : OnGrid (wrapDeg (x + 270)) := by rw [← e2]; exact wrapDeg_onGrid (g2.add h90)
  rw [rotateBy_onGrid hx h90, rotateBy_onGrid g1 h90, e1, rotateBy_onGrid g2 h90, e2, rotateBy_onGrid g3 h90, e3]

/-- engine.js `wrapAz` (in `lookFrom`): `((a + 180) % 360 + 360) % 360 − 180`, with −180 written as 180 only when
the input was positive. -/
def wrapAz (a : ℝ) : ℝ :=
  if jsRem (jsRem (a + 180) 360 + 360) 360 - 180 = -180 ∧ 0 < a then 180
  else jsRem (jsRem (a + 180) 360 + 360) 360 - 180

theorem wrapAz_eq (a : ℝ) :
    wrapAz a = if toIcoMod h360 0 (a + 180) - 180 = -180 ∧ 0 < a then 180
      else toIcoMod h360 0 (a + 180) - 180 := by
  simp only [wrapAz, jsRem_jsRem_add]

theorem wrapAz_mem (a : ℝ) : wrapAz a ∈ Icc (-180) 180 := by
  rw [wrapAz_eq]
  have hm := toIcoMod_mem_Ico h360 0 (a + 180)
  split_ifs
  · norm_num
  · constructor <;> linarith [hm.1, hm.2]

theorem wrapAz_modEq (a : ℝ) : ∃ k : ℤ, wrapAz a = a + 360 * k := by
  rw [wrapAz_eq]
  obtain ⟨z, hz⟩ := ((toIcoMod_eq_iff h360).1
    (rfl : toIcoMod h360 0 (a + 180) = _)).2
  simp only [zsmul_eq_mul] at hz
  split_ifs with h
  · refine ⟨1 - z, ?_⟩
    push_cast
    linarith [h.1]
  · refine ⟨-z, ?_⟩
    push_cast
    linarith

theorem wrapAz_of_mem {a : ℝ} (h : a ∈ Icc (-180) 180) : wrapAz a = a := by
  rw [wrapAz_eq]
  rcases eq_or_lt_of_le h.2 with h180 | hlt
  · -- 180 itself: the remainder is 0, and 180 > 0
    have e : toIcoMod h360 0 (a + 180) = 0 := by
      rw [toIcoMod_eq_iff]
      exact ⟨⟨le_rfl, by norm_num⟩, 1, by rw [h180]; norm_num⟩
    rw [e, if_pos ⟨by norm_num, by rw [h180]; norm_num⟩, h180]
  · have e : toIcoMod h360 0 (a + 180) = a + 180 := by
      rw [toIcoMod_eq_iff]
      exact ⟨⟨by linarith [h.1], by linarith⟩, 0, by simp⟩
    rw [e]
    split_ifs with h'
    · exact absurd h'.2 (by linarith [h'.1])
    · ring

theorem wrapAz_idem (a : ℝ) : wrapAz (wrapAz a) = wrapAz a := wrapAz_of_mem (wrapAz_mem a)

/-- Wrapping is not monotone: 179° stays, 181° becomes −179°. -/
theorem wrapAz_not_monotone : ¬ Monotone wrapAz := by
  intro h
  have h1 : wrapAz 179 = 179 := wrapAz_of_mem ⟨by norm_num, by norm_num⟩
  have h2 : wrapAz 181 = -179 := by
    rw [wrapAz_eq]
    have e : toIcoMod h360 0 (181 + 180) = 1 := by
      rw [toIcoMod_eq_iff]
      exact ⟨⟨by norm_num, by norm_num⟩, 1, by norm_num⟩
    rw [e]
    norm_num
  have := h (show (179 : ℝ) ≤ 181 by norm_num)
  rw [h1, h2] at this
  norm_num at this

/-! ### Look numbers (§4.8) -/

/-- The Look's numbers (`LOOK_NUM` in engine.js, `LOOK_RANGE` in serve.py). -/
inductive LookNum
  | exposure | warmth | light_azimuth_deg | light_elevation_deg | light_softness | light_strength | ambient
  deriving DecidableEq

namespace LookNum

/-- The ranges of §4.8's table. -/
def lo : LookNum → ℝ
  | exposure => 0.25 | warmth => -1 | light_azimuth_deg => -180 | light_elevation_deg => 5
  | light_softness => 0 | light_strength => 0 | ambient => 0

def hi : LookNum → ℝ
  | exposure => 4 | warmth => 1 | light_azimuth_deg => 180 | light_elevation_deg => 90
  | light_softness => 1 | light_strength => 3 | ambient => 3

/-- The defaults (`none`: the inferred value, from lighting.json or the v1 key light). -/
def dflt : LookNum → Option ℝ
  | exposure => some 1 | warmth => some 0 | light_azimuth_deg => none | light_elevation_deg => none
  | light_softness => none | light_strength => some 1 | ambient => some 1

theorem lo_le_hi (k : LookNum) : k.lo ≤ k.hi := by cases k <;> norm_num [lo, hi]

theorem dflt_mem (k : LookNum) {x : ℝ} (h : k.dflt = some x) : x ∈ Icc k.lo k.hi := by
  cases k <;> simp [dflt] at h <;> subst h <;> norm_num [lo, hi]

end LookNum

/-- engine.js `lookFrom`, one number: a number is clamped to its range (the azimuth wrapped first), anything else
takes the default. -/
def lookNum (k : LookNum) : Option ℝ → Option ℝ
  | some x => some (clamp k.lo k.hi (if k = .light_azimuth_deg then wrapAz x else x))
  | none => k.dflt

/-- **Every Look number lands in its range.** -/
theorem lookNum_mem (k : LookNum) (v : Option ℝ) {x : ℝ} (h : lookNum k v = some x) : x ∈ Icc k.lo k.hi := by
  cases v with
  | some y =>
    simp only [lookNum, Option.some.injEq] at h
    rw [← h]
    exact clamp_mem k.lo_le_hi _
  | none => exact k.dflt_mem h

/-- **`lookFrom` is idempotent**: reading a Look it wrote gives the same Look. -/
theorem lookNum_idem (k : LookNum) (v : Option ℝ) : (lookNum k v).bind (fun x => lookNum k (some x)) = lookNum k v := by
  cases h : lookNum k v with
  | none => rfl
  | some x =>
    have hx := lookNum_mem k v h
    simp only [Option.bind_some, lookNum]
    congr 1
    split_ifs with hk
    · subst hk
      rw [wrapAz_of_mem hx, clamp_of_mem hx]
    · exact clamp_of_mem hx

/-- **Every Look number but the azimuth is clamped monotonically.** -/
theorem lookNum_mono (k : LookNum) (hk : k ≠ .light_azimuth_deg) {x y : ℝ} (hxy : x ≤ y) :
    ∃ a b, lookNum k (some x) = some a ∧ lookNum k (some y) = some b ∧ a ≤ b :=
  ⟨_, _, rfl, rfl, by simp only [if_neg hk]; exact clamp_mono _ _ hxy⟩

/-- The azimuth is wrapped, and then the clamp changes nothing: the stored azimuth is the same direction as the given
one (congruent mod 360°). -/
theorem lookNum_azimuth (x : ℝ) : lookNum .light_azimuth_deg (some x) = some (wrapAz x) := by
  rw [lookNum, if_pos rfl, clamp_of_mem (by simpa [LookNum.lo, LookNum.hi] using wrapAz_mem x)]

theorem lookNum_azimuth_congr (x : ℝ) : ∃ k : ℤ, lookNum .light_azimuth_deg (some x) = some (x + 360 * k) := by
  obtain ⟨k, hk⟩ := wrapAz_modEq x
  exact ⟨k, by rw [lookNum_azimuth, hk]⟩

theorem LookNum.round6Py_gridRound (k : LookNum) : GridRound round6Py k.lo k.hi := by
  cases k
  · exact Midstudy.round6Py_gridRound (a := 250000) (b := 4000000) (by norm_num [LookNum.lo]) (by norm_num [LookNum.hi])
  · exact Midstudy.round6Py_gridRound (a := -1000000) (b := 1000000) (by norm_num [LookNum.lo]) (by norm_num [LookNum.hi])
  · exact Midstudy.round6Py_gridRound (a := -180000000) (b := 180000000) (by norm_num [LookNum.lo])
      (by norm_num [LookNum.hi])
  · exact Midstudy.round6Py_gridRound (a := 5000000) (b := 90000000) (by norm_num [LookNum.lo]) (by norm_num [LookNum.hi])
  · exact Midstudy.round6Py_gridRound (a := 0) (b := 1000000) (by norm_num [LookNum.lo]) (by norm_num [LookNum.hi])
  · exact Midstudy.round6Py_gridRound (a := 0) (b := 3000000) (by norm_num [LookNum.lo]) (by norm_num [LookNum.hi])
  · exact Midstudy.round6Py_gridRound (a := 0) (b := 3000000) (by norm_num [LookNum.lo]) (by norm_num [LookNum.hi])

/-- serve.py's `look` merge, one number: `round(min(hi, max(lo, v)), 6)`; the azimuth is clamped, not wrapped. -/
def lookNumPy (k : LookNum) (x : ℝ) : ℝ := round6Py (clamp k.lo k.hi x)

/-- The server's Look numbers land in range, are idempotent and monotone (all seven: it doesn't wrap). -/
theorem lookNumPy_mem (k : LookNum) (x : ℝ) : lookNumPy k x ∈ Icc k.lo k.hi :=
  k.round6Py_gridRound.clamp_mem k.lo_le_hi x

theorem lookNumPy_idem (k : LookNum) (x : ℝ) : lookNumPy k (lookNumPy k x) = lookNumPy k x :=
  k.round6Py_gridRound.clamp_idem k.lo_le_hi x

theorem lookNumPy_mono (k : LookNum) : Monotone (lookNumPy k) := k.round6Py_gridRound.clamp_mono

/-- **The planner and the server read an azimuth outside ±180° differently**: given 270°, the planner (wrap, then
clamp) keeps −90° (the same direction), the server (clamp only) stores 180° (another direction). Values the planner
itself writes are already in range, where both agree (`wrapAz_of_mem`, `clamp_of_mem`). -/
theorem azimuth_planner_server_differ :
    lookNum .light_azimuth_deg (some 270) = some (-90) ∧ lookNumPy .light_azimuth_deg 270 = 180 := by
  constructor
  · rw [lookNum_azimuth, wrapAz_eq]
    have e : toIcoMod h360 0 (270 + 180) = 90 := by
      rw [toIcoMod_eq_iff]
      exact ⟨⟨by norm_num, by norm_num⟩, 1, by norm_num⟩
    rw [e]
    norm_num
  · unfold lookNumPy round6Py clamp
    norm_num [LookNum.lo, LookNum.hi]
    rw [show (180000000 : ℝ) = ((180000000 : ℤ) : ℝ) by norm_num, roundHalfEven_intCast]
    norm_num

end Midstudy
