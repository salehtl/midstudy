import Midstudy.Camera
import Mathlib.Analysis.SpecialFunctions.Complex.Arg
import Mathlib.Analysis.SpecialFunctions.Trigonometric.Inverse

/-!
# The light inferred from the photo (contract §4.8)

`lighting.json`'s `ambient.sh` holds 9 coefficients per colour channel in three.js `SphericalHarmonics3` order,
`[L00, L1−1 (y), L10 (z), L11 (x), L2−2 (xy), L2−1 (yz), L20, L21 (xz), L22 (x² − y²)]`, in the camera frame; three.js
turns them into irradiance with `shGetIrradianceAt`'s basis (planner/lighting.js `irrBasis`, geom
`irradiance_basis`), modelled here with its exact decimal constants. One channel is enough: the channels never mix.

Main results:
* `irradianceAt_rotateBand1`: §4.8's rule "L00 stays; band 1 is the vector (L11, L1−1, L10) and turns with R"
  gives, at every direction `n`, the irradiance the camera-frame probe has at `Rᵀ · n`: rotating the probe is the
  same as evaluating at rotated directions (no band 2, as in v1's fits). `irradianceAt_rotateBand1_world`: with the
  camera's `R`, the world probe at `R · m` is the camera probe at `m`.
* `irradianceAt_rotateSHExact`: with band 2, an exact turned probe still exists, given in closed form: three.js's 9
  basis functions span every quadratic on the unit sphere, so "evaluate at turned directions and refit" (v1's
  `rotateSH`, geom `refit`) has an exact answer; `rotateSHExact_band2_zero`: without band 2 it is the band-1 rule.
* `splatLevel_defaults`, `splatGain_defaults`: the splat colour level `(A·ambient + K·strength)/(A + K)` is 1 at the
  defaults for every lighting.json (A ≥ 10⁻⁴, K ≥ 0), so the gain is exactly `white_balance`; `splatLevel_v1`: the
  same with the v1 lights; `splatLevel_mem`: the level always lies between `ambient` and `strength`.
* `dirOf_zero`, `dirOf_ninety`, `dirOf_unit`, `azElOf_dirOf`: the Look's azimuth and elevation (0° straight ahead
  towards −Z, 90° from the right) name every direction once.
-/

noncomputable section

open Real Matrix

namespace Midstudy.Lighting

/-! ### The irradiance basis (three.js 0.180 `shGetIrradianceAt`) -/

/-- planner/lighting.js `irrBasis(x, y, z)`, in `SphericalHarmonics3` order. -/
def irrBasis (n : Vec3) : Fin 9 → ℝ :=
  ![0.886227, 1.023328 * n 1, 1.023328 * n 2, 1.023328 * n 0, 0.858086 * n 0 * n 1, 0.858086 * n 1 * n 2,
    0.743125 * n 2 * n 2 - 0.247708, 0.858086 * n 0 * n 2, 0.429043 * (n 0 * n 0 - n 1 * n 1)]

/-- planner/lighting.js `irradianceAt(sh, d)`, one colour channel: `Σᵢ basisᵢ(d) · shᵢ`. -/
def irradianceAt (sh : Fin 9 → ℝ) (n : Vec3) : ℝ := ∑ i, irrBasis n i * sh i

/-- Band 1 as a vector: (x: L11, y: L1−1, z: L10). -/
def band1 (sh : Fin 9 → ℝ) : Vec3 := ![sh 3, sh 1, sh 2]

/-- No band 2 (v1's fits). -/
def NoBand2 (sh : Fin 9 → ℝ) : Prop := sh 4 = 0 ∧ sh 5 = 0 ∧ sh 6 = 0 ∧ sh 7 = 0 ∧ sh 8 = 0

/-- §4.8's rotation of the probe: L00 kept, band 1 turned by `R`, band 2 kept. -/
def rotateBand1 (R : Mat3) (sh : Fin 9 → ℝ) : Fin 9 → ℝ :=
  ![sh 0, (R *ᵥ band1 sh) 1, (R *ᵥ band1 sh) 2, (R *ᵥ band1 sh) 0, sh 4, sh 5, sh 6, sh 7, sh 8]

theorem irradianceAt_eq (sh : Fin 9 → ℝ) (n : Vec3) :
    irradianceAt sh n =
      0.886227 * sh 0 + 1.023328 * (n 1 * sh 1 + n 2 * sh 2 + n 0 * sh 3) + 0.858086 * n 0 * n 1 * sh 4
        + 0.858086 * n 1 * n 2 * sh 5 + (0.743125 * n 2 * n 2 - 0.247708) * sh 6 + 0.858086 * n 0 * n 2 * sh 7
        + 0.429043 * (n 0 * n 0 - n 1 * n 1) * sh 8 := by
  simp [irradianceAt, irrBasis, Fin.sum_univ_succ]
  ring

/-- **Rotating the probe = evaluating at rotated directions** (bands 0 and 1; no band 2): the probe turned by §4.8's
rule has, at every direction `n`, the irradiance the original has at `Rᵀ · n`. Any matrix `R`. -/
theorem irradianceAt_rotateBand1 (R : Mat3) {sh : Fin 9 → ℝ} (h : NoBand2 sh) (n : Vec3) :
    irradianceAt (rotateBand1 R sh) n = irradianceAt sh (Rᵀ *ᵥ n) := by
  obtain ⟨h4, h5, h6, h7, h8⟩ := h
  rw [irradianceAt_eq, irradianceAt_eq]
  simp only [rotateBand1, band1, h4, h5, h6, h7, h8, Matrix.mulVec, dotProduct, Fin.sum_univ_three,
    Matrix.transpose_apply, Matrix.cons_val]
  ring

/-- The same with band 2 present, for the part of the irradiance bands 0 and 1 carry. -/
def irradiance01 (sh : Fin 9 → ℝ) (n : Vec3) : ℝ :=
  0.886227 * sh 0 + 1.023328 * (band1 sh ⬝ᵥ n)

theorem irradiance01_rotateBand1 (R : Mat3) (sh : Fin 9 → ℝ) (n : Vec3) :
    irradiance01 (rotateBand1 R sh) n = irradiance01 sh (Rᵀ *ᵥ n) := by
  simp only [irradiance01, rotateBand1, band1, Matrix.mulVec, dotProduct, Fin.sum_univ_three,
    Matrix.transpose_apply, Matrix.cons_val]
  ring

/-- **In the planner's words**: with the camera's `R` (camera to world), the world probe seen from world direction
`R · m` is the camera probe seen from camera direction `m`. -/
theorem irradianceAt_rotateBand1_world (c : CameraBlock) {sh : Fin 9 → ℝ} (h : NoBand2 sh) (m : Vec3) :
    irradianceAt (rotateBand1 c.R sh) (c.R *ᵥ m) = irradianceAt sh m := by
  rw [irradianceAt_rotateBand1 _ h, CameraBlock.toCamera_R_mulVec]

/-! ### With band 2: an exact turned probe exists -/

/-- `f(m) = C + bᵀm + mᵀPm`: the probe's irradiance as a quadratic. `P` (symmetric). -/
def quadP (sh : Fin 9 → ℝ) : Mat3 :=
  !![0.429043 * sh 8, 0.858086 * sh 4 / 2, 0.858086 * sh 7 / 2;
     0.858086 * sh 4 / 2, -(0.429043 * sh 8), 0.858086 * sh 5 / 2;
     0.858086 * sh 7 / 2, 0.858086 * sh 5 / 2, 0.743125 * sh 6]

/-- The probe turned by `R`, in closed form: band 1 turned, band 2's quadratic `P` turned to `Q = R P Rᵀ` and written
back in three.js's basis on the unit sphere (`x² + y² = 1 − z²`), the constants it leaves going to L00. -/
def rotateSHExact (R : Mat3) (sh : Fin 9 → ℝ) : Fin 9 → ℝ :=
  let Q := R * quadP sh * Rᵀ
  let s6 := (Q 2 2 - (Q 0 0 + Q 1 1) / 2) / 0.743125
  ![(0.886227 * sh 0 - 0.247708 * sh 6 + (Q 0 0 + Q 1 1) / 2 + 0.247708 * s6) / 0.886227,
    (R *ᵥ band1 sh) 1, (R *ᵥ band1 sh) 2, (R *ᵥ band1 sh) 0,
    2 * Q 0 1 / 0.858086, 2 * Q 1 2 / 0.858086, s6, 2 * Q 0 2 / 0.858086, (Q 0 0 - Q 1 1) / 2 / 0.429043]

/-- **The exact turned probe** (bands 0–2, any `R`): at every unit direction `n` its irradiance is the original's at
`Rᵀ · n`. So the 9 coefficients v1's `rotateSH` refits from 96 turned directions have an exact solution (which the
least-squares refit finds when its 96 × 9 system has full rank). -/
theorem irradianceAt_rotateSHExact (R : Mat3) (sh : Fin 9 → ℝ) {n : Vec3}
    (hn : n 0 * n 0 + n 1 * n 1 + n 2 * n 2 = 1) :
    irradianceAt (rotateSHExact R sh) n = irradianceAt sh (Rᵀ *ᵥ n) := by
  rw [irradianceAt_eq, irradianceAt_eq]
  simp only [rotateSHExact, quadP, band1, Matrix.mul_apply, Fin.sum_univ_three, Matrix.transpose_apply,
    Matrix.mulVec, dotProduct, Matrix.of_apply, Matrix.cons_val]
  linear_combination
    (-((R 0 0 * (0.429043 * sh 8) + R 0 1 * (0.858086 * sh 4 / 2) + R 0 2 * (0.858086 * sh 7 / 2)) * R 0 0 +
      (R 0 0 * (0.858086 * sh 4 / 2) + R 0 1 * -(0.429043 * sh 8) + R 0 2 * (0.858086 * sh 5 / 2)) * R 0 1 +
      (R 0 0 * (0.858086 * sh 7 / 2) + R 0 1 * (0.858086 * sh 5 / 2) + R 0 2 * (0.743125 * sh 6)) * R 0 2 +
      ((R 1 0 * (0.429043 * sh 8) + R 1 1 * (0.858086 * sh 4 / 2) + R 1 2 * (0.858086 * sh 7 / 2)) * R 1 0 +
      (R 1 0 * (0.858086 * sh 4 / 2) + R 1 1 * -(0.429043 * sh 8) + R 1 2 * (0.858086 * sh 5 / 2)) * R 1 1 +
      (R 1 0 * (0.858086 * sh 7 / 2) + R 1 1 * (0.858086 * sh 5 / 2) + R 1 2 * (0.743125 * sh 6)) * R 1 2)) / 2)
      * hn

/-- Without band 2 the exact turned probe is §4.8's band-1 rule: nothing leaks into band 0. -/
theorem rotateSHExact_band2_zero (R : Mat3) {sh : Fin 9 → ℝ} (h : NoBand2 sh) :
    rotateSHExact R sh = rotateBand1 R sh := by
  obtain ⟨h4, h5, h6, h7, h8⟩ := h
  ext i
  fin_cases i <;> simp [rotateSHExact, rotateBand1, quadP, h4, h5, h6, h7, h8, Matrix.mul_apply,
    Fin.sum_univ_three]
  field_simp

/-! ### The splat colour level (§4.8 Splats; lighting.js `splatGain`, raster `splat_gain`) -/

/-- Relative luminance of a linear RGB colour (lighting.js `lum`). -/
def lum (c : Fin 3 → ℝ) : ℝ := 0.2126 * c 0 + 0.7152 * c 1 + 0.0722 * c 2

/-- `level = (A · ambient + K · light_strength) / (A + K)`. -/
def splatLevel (A K ambient strength : ℝ) : ℝ := (A * ambient + K * strength) / (A + K)

/-- **The level is 1 at the defaults** (ambient 1, strength 1) whenever `A + K ≠ 0`. -/
theorem splatLevel_defaults {A K : ℝ} (h : A + K ≠ 0) : splatLevel A K 1 1 = 1 := by
  unfold splatLevel
  rw [mul_one, mul_one, div_self h]

/-- The level is a weighted mean of `ambient` and `strength`: it always lies between them. -/
theorem splatLevel_mem {A K : ℝ} (hA : 0 ≤ A) (hK : 0 ≤ K) (hAK : 0 < A + K) (a s : ℝ) :
    min a s ≤ splatLevel A K a s ∧ splatLevel A K a s ≤ max a s := by
  unfold splatLevel
  constructor
  · rw [le_div_iff₀ hAK]
    nlinarith [min_le_left a s, min_le_right a s]
  · rw [div_le_iff₀ hAK]
    nlinarith [le_max_left a s, le_max_right a s]

theorem splatLevel_mono {A K : ℝ} (hA : 0 ≤ A) (hK : 0 ≤ K) (hAK : 0 < A + K) {a a' s s' : ℝ}
    (ha : a ≤ a') (hs : s ≤ s') : splatLevel A K a s ≤ splatLevel A K a' s' := by
  unfold splatLevel
  apply div_le_div_of_nonneg_right _ hAK.le
  nlinarith

/-- lighting.js `splatGain()` with lighting.json: `white_balance × level`, `A = max(10⁻⁴, lum(irradiance of the
world probe facing up))`, `K = ½ · lum(key colour) · key intensity`. -/
def splatGain (worldSH : Fin 3 → Fin 9 → ℝ) (keyColor wb : Fin 3 → ℝ) (keyIntensity ambient strength : ℝ) :
    Fin 3 → ℝ :=
  let A := max 1e-4 (lum (fun ch => irradianceAt (worldSH ch) ![0, 1, 0]))
  let K := 0.5 * lum keyColor * keyIntensity
  fun ch => wb ch * splatLevel A K ambient strength

/-- **At the defaults the splats get exactly the room light's colour**, for every lighting.json whose key colour and
intensity aren't negative. -/
theorem splatGain_defaults (worldSH : Fin 3 → Fin 9 → ℝ) {keyColor : Fin 3 → ℝ} (wb : Fin 3 → ℝ)
    {keyIntensity : ℝ} (hc : ∀ i, 0 ≤ keyColor i) (hi : 0 ≤ keyIntensity) :
    splatGain worldSH keyColor wb keyIntensity 1 1 = wb := by
  funext ch
  simp only [splatGain]
  have hA : (0 : ℝ) < max 1e-4 (lum (fun ch => irradianceAt (worldSH ch) ![0, 1, 0])) :=
    lt_max_of_lt_left (by norm_num)
  have hK : 0 ≤ 0.5 * lum keyColor * keyIntensity := by
    unfold lum
    have := hc 0
    have := hc 1
    have := hc 2
    positivity
  rw [splatLevel_defaults (by positivity), mul_one]

/-- Without lighting.json: the same level from the v1 lights (hemisphere 0.35 and environment 0.8 as the ambient,
half the key's 1.1 as `K`), also 1 at the defaults. -/
theorem splatLevel_v1 : splatLevel (0.35 + 0.8) (0.5 * 1.1) 1 1 = 1 := splatLevel_defaults (by norm_num)

/-- lighting.js `splatGain` without lighting.json, as written there, is that level. -/
theorem splatGain_v1_eq (a s : ℝ) :
    (0.35 + 0.8) * a / (0.35 + 0.8 + 0.5 * 1.1) + 0.5 * 1.1 * s / (0.35 + 0.8 + 0.5 * 1.1) =
      splatLevel (0.35 + 0.8) (0.5 * 1.1) a s := by
  unfold splatLevel
  ring

/-! ### Azimuth and elevation (lighting.js `dirOf`, `azElOf`) -/

/-- lighting.js `dirOf(az, el)` (degrees): `(cos el · sin az, sin el, −cos el · cos az)`. -/
def dirOf (az el : ℝ) : Vec3 :=
  ![cos (rad el) * sin (rad az), sin (rad el), -(cos (rad el) * cos (rad az))]

/-- Azimuth 0 is straight ahead: the light comes from the far side of the photo (−Z). -/
theorem dirOf_zero (el : ℝ) : dirOf 0 el = ![0, sin (rad el), -cos (rad el)] := by
  ext i
  fin_cases i <;> simp [dirOf, rad]

/-- Azimuth 90 is from the right (+X). -/
theorem dirOf_ninety (el : ℝ) : dirOf 90 el = ![cos (rad el), sin (rad el), 0] := by
  have : rad 90 = π / 2 := by unfold rad; ring
  ext i
  fin_cases i <;> simp [dirOf, this]

theorem dirOf_unit (az el : ℝ) : dirOf az el ⬝ᵥ dirOf az el = 1 := by
  simp [dirOf, dotProduct, Fin.sum_univ_three]
  linear_combination (cos (rad el)) ^ 2 * sin_sq_add_cos_sq (rad az) + sin_sq_add_cos_sq (rad el)

/-- The azimuth as lighting.js `azElOf` computes it, `atan2(d.x, −d.z)`, i.e. the argument of `−d.z + i·d.x`. -/
def azimuthOf (d : Vec3) : ℝ := Complex.arg ⟨-d 2, d 0⟩ / (π / 180)

/-- The elevation, `asin(d.y)`. -/
def elevationOf (d : Vec3) : ℝ := Real.arcsin (d 1) / (π / 180)

/-- **Azimuth and elevation name every direction once**: for an azimuth in (−180°, 180°] and an elevation strictly
between ±90°, `azElOf(dirOf(az, el)) = (az, el)`. -/
theorem azElOf_dirOf {az el : ℝ} (haz : az ∈ Set.Ioc (-180) 180) (hel : el ∈ Set.Ioo (-90) 90) :
    azimuthOf (dirOf az el) = az ∧ elevationOf (dirOf az el) = el := by
  have hpi := Real.pi_pos
  have hc : 0 < cos (rad el) :=
    Real.cos_pos_of_mem_Ioo ⟨CameraBlock.neg_pi_div_two_lt_rad hel.1, CameraBlock.rad_lt_pi_div_two hel.2⟩
  constructor
  · unfold azimuthOf
    have hz : (⟨-dirOf az el 2, dirOf az el 0⟩ : ℂ) =
        (cos (rad el) : ℂ) * (Complex.cos (rad az) + Complex.sin (rad az) * Complex.I) := by
      apply Complex.ext <;> simp [dirOf, Complex.cos_ofReal_re, Complex.sin_ofReal_re]
    rw [hz, Complex.arg_real_mul _ hc, Complex.arg_cos_add_sin_mul_I]
    · unfold rad
      field_simp
    · constructor
      · unfold rad
        nlinarith [haz.1]
      · unfold rad
        nlinarith [haz.2]
  · unfold elevationOf
    simp only [dirOf, Matrix.cons_val]
    rw [Real.arcsin_sin (CameraBlock.neg_pi_div_two_lt_rad hel.1).le (CameraBlock.rad_lt_pi_div_two hel.2).le]
    unfold rad
    field_simp

/-- **And every direction is named**: for a unit direction that isn't straight up or down, `dirOf(azEl(d)) = d`
(geom LEAN.md property 21). -/
theorem dirOf_azElOf {d : Vec3} (hd : d 0 * d 0 + d 1 * d 1 + d 2 * d 2 = 1) (hy : d 1 * d 1 < 1) :
    dirOf (azimuthOf d) (elevationOf d) = d := by
  have hpi := Real.pi_pos
  have hrad : ∀ x : ℝ, rad (x / (π / 180)) = x := fun x => by unfold rad; field_simp
  set z : ℂ := ⟨-d 2, d 0⟩ with hz
  have hρ2 : Complex.normSq z = d 0 * d 0 + d 2 * d 2 := by rw [hz, Complex.normSq_mk]; ring
  have hpos : 0 < d 0 * d 0 + d 2 * d 2 := by linarith
  have hz0 : z ≠ 0 := by
    intro h0
    rw [h0, Complex.normSq_zero] at hρ2
    linarith
  have hnorm : ‖z‖ = Real.sqrt (d 0 * d 0 + d 2 * d 2) := by rw [Complex.norm_def, hρ2]
  have hsq : Real.sqrt (d 0 * d 0 + d 2 * d 2) ≠ 0 := (Real.sqrt_pos.2 hpos).ne'
  have hcos_el : cos (Real.arcsin (d 1)) = Real.sqrt (d 0 * d 0 + d 2 * d 2) := by
    rw [Real.cos_arcsin]
    congr 1
    linarith
  have hy1 : -1 ≤ d 1 ∧ d 1 ≤ 1 := by constructor <;> nlinarith
  have hsq2 : Real.sqrt (d 0 ^ 2 + d 2 ^ 2) ≠ 0 := by rw [sq, sq]; exact hsq
  have e0 : dirOf (azimuthOf d) (elevationOf d) 0 = d 0 := by
    simp only [dirOf, azimuthOf, elevationOf, hrad, Matrix.cons_val_zero]
    rw [hcos_el, ← hz, Complex.sin_arg, hnorm]
    simp only [hz]
    field_simp
  have e1 : dirOf (azimuthOf d) (elevationOf d) 1 = d 1 := by
    simp only [dirOf, azimuthOf, elevationOf, hrad, Matrix.cons_val_one]
    exact Real.sin_arcsin hy1.1 hy1.2
  have e2 : dirOf (azimuthOf d) (elevationOf d) 2 = d 2 := by
    simp only [dirOf, azimuthOf, elevationOf, hrad, Matrix.cons_val_two, Matrix.tail_cons, Matrix.head_cons]
    rw [hcos_el, ← hz, Complex.cos_arg hz0, hnorm]
    simp only [hz]
    field_simp
  ext i
  fin_cases i
  · exact e0
  · exact e1
  · exact e2

end Midstudy.Lighting
