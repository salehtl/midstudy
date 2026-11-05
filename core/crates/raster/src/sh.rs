//! The ambient light probe's spherical harmonics (contract §4.8; v1 planner/lighting.js `irrBasis`, `FIB`, `solve`,
//! `rotateSH`, `irradianceAt`, `scaleBands`, `maxBandScale`, `splatGain`).
//!
//! `ambient.sh` holds 9 RGB coefficients in three.js `SphericalHarmonics3` order, [L00, L1−1 (y), L10 (z), L11 (x),
//! L2−2 (xy), L2−1 (yz), L20 (3z² − 1), L21 (xz), L22 (x² − y²)], which three.js turns into irradiance with
//! `shGetIrradianceAt`'s basis ([`irradiance_basis`]).
//!
//! Rotation: band 0 is unchanged and band 1 turns exactly as the vector (L11, L1−1, L10). Band 2 is turned by
//! evaluating its irradiance at v1's 96 Fibonacci directions turned back, then refitting all 9 coefficients by least
//! squares, as v1 does: three.js's L20 basis (`0.743125 z² − 0.247708`) is not exactly zero-mean, so a turned band 2
//! leaks about 3·10⁻⁷ of itself into band 0, which the refit keeps, so that the turned probe's irradiance (as three.js
//! evaluates it) is exactly the original's in the turned directions.

use crate::color::luminance;
use midstudy_geom::mat::{M3, V3, mul, mul_t};

/// 9 RGB coefficients, three.js order.
pub type Sh9 = [[f64; 3]; 9];

/// The number of directions v1 refits over.
pub const FIB_COUNT: usize = 96;

/// `shGetIrradianceAt`'s basis (three.js 0.180), in `SphericalHarmonics3` order, at unit direction (x, y, z).
#[must_use]
pub fn irradiance_basis(d: V3) -> [f64; 9] {
    let [x, y, z] = d;
    [
        0.886_227,
        1.023_328 * y,
        1.023_328 * z,
        1.023_328 * x,
        0.858_086 * x * y,
        0.858_086 * y * z,
        0.743_125 * z * z - 0.247_708,
        0.858_086 * x * z,
        0.429_043 * (x * x - y * y),
    ]
}

/// v1's `FIB`: 96 directions on a Fibonacci sphere, `y = 1 − 2(i + ½)/96`, angle `i · π · (3 − √5)`.
#[must_use]
pub fn fibonacci_directions() -> [V3; FIB_COUNT] {
    let mut out = [[0.0; 3]; FIB_COUNT];
    for (i, d) in (0_u32..).zip(out.iter_mut()) {
        let fi = f64::from(i);
        #[allow(clippy::cast_precision_loss)]
        let y = 1.0 - (2.0 * (fi + 0.5)) / FIB_COUNT as f64;
        let r = (1.0 - y * y).sqrt();
        let a = fi * core::f64::consts::PI * (3.0 - 5.0_f64.sqrt());
        *d = [a.cos() * r, y, a.sin() * r];
    }
    out
}

/// v1's `irradianceAt(sh, d)`: the irradiance per channel, `Σᵢ basisᵢ(d) · shᵢ` summed in coefficient order.
#[must_use]
pub fn irradiance_at(sh: &Sh9, d: V3) -> [f64; 3] {
    let b = irradiance_basis(d);
    let mut out = [0.0; 3];
    for (ch, o) in out.iter_mut().enumerate() {
        *o = b.iter().zip(sh.iter()).fold(0.0, |s, (v, c)| s + v * c[ch]);
    }
    out
}

/// v1's `scaleBands(sh, k)`: bands 1–2 (the directional part) times `k`, band 0 kept.
#[must_use]
pub fn scale_bands(sh: &Sh9, k: f64) -> Sh9 {
    let mut out = *sh;
    for c in out.iter_mut().skip(1) {
        *c = c.map(|v| v * k);
    }
    out
}

/// v1's `maxBandScale(sh)`: the largest `k` for [`scale_bands`] that keeps the irradiance's luminance in every one of
/// the 96 directions at ≥ 5 % of band 0's (+∞ when no direction is darker than band 0).
#[must_use]
pub fn max_band_scale(sh: &Sh9) -> f64 {
    let dc = luminance(irradiance_at(&scale_bands(sh, 0.0), [0.0, 1.0, 0.0]));
    let mut k = f64::INFINITY;
    for d in fibonacci_directions() {
        let e1 = luminance(irradiance_at(sh, d)) - dc;
        if e1 < -1e-9 {
            k = k.min((0.95 * dc) / -e1);
        }
    }
    k
}

/// v1's `solve(A, b)`: Gauss–Jordan elimination with partial pivoting (a zero pivot taken as 1e-12), in v1's order.
#[must_use]
#[allow(clippy::needless_range_loop, clippy::float_cmp)] // v1's indices; v1 tests pivots and factors for exactly 0
pub fn solve9(a: &[[f64; 9]; 9], b: &[f64; 9]) -> [f64; 9] {
    let mut m = [[0.0; 10]; 9];
    for (row, (ar, bv)) in m.iter_mut().zip(a.iter().zip(b)) {
        row[..9].copy_from_slice(ar);
        row[9] = *bv;
    }
    for c in 0..9 {
        let mut p = c;
        for r in c + 1..9 {
            if m[r][c].abs() > m[p][c].abs() {
                p = r;
            }
        }
        m.swap(c, p);
        // `M[c][c] || 1e-12`: zero or NaN becomes 1e-12.
        let d = if m[c][c] == 0.0 || m[c][c].is_nan() {
            1e-12
        } else {
            m[c][c]
        };
        for r in 0..9 {
            if r == c {
                continue;
            }
            let f = m[r][c] / d;
            // `if (f)`: skipped for zero and NaN.
            if f != 0.0 && !f.is_nan() {
                for k in c..=9 {
                    m[r][k] -= f * m[c][k];
                }
            }
        }
    }
    let mut out = [0.0; 9];
    for (i, o) in out.iter_mut().enumerate() {
        let d = if m[i][i] == 0.0 || m[i][i].is_nan() {
            1e-12
        } else {
            m[i][i]
        };
        *o = m[i][9] / d;
    }
    out
}

/// The refit of v1's `rotateSH`: the 9 coefficients whose irradiance best matches (least squares over the 96
/// directions) `sh`'s irradiance evaluated at each direction turned back to `sh`'s frame (`Rᵀ · d`).
#[must_use]
pub fn refit(sh: &Sh9, r: &M3) -> Sh9 {
    let dirs = fibonacci_directions();
    let rows: Vec<[f64; 9]> = dirs.iter().map(|&d| irradiance_basis(d)).collect();
    let mut ata = [[0.0; 9]; 9];
    for (i, row) in ata.iter_mut().enumerate() {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = rows.iter().fold(0.0, |s, r| s + r[i] * r[j]);
        }
    }
    let turned: Vec<[f64; 9]> = dirs
        .iter()
        .map(|&d| irradiance_basis(mul_t(r, d)))
        .collect();
    let mut out = [[0.0; 3]; 9];
    for ch in 0..3 {
        let t: Vec<f64> = turned
            .iter()
            .map(|b| b.iter().zip(sh.iter()).fold(0.0, |s, (v, c)| s + v * c[ch]))
            .collect();
        let mut atb = [0.0; 9];
        for (i, a) in atb.iter_mut().enumerate() {
            *a = rows.iter().zip(&t).fold(0.0, |s, (r, tk)| s + r[i] * tk);
        }
        for (o, v) in out.iter_mut().zip(solve9(&ata, &atb)) {
            o[ch] = v;
        }
    }
    out
}

/// v1's `rotateSH(sh, R)` exactly: [`refit`] of all 9 coefficients.
#[must_use]
pub fn rotate_sh_v1(sh: &Sh9, r: &M3) -> Sh9 {
    refit(sh, r)
}

/// The probe turned by `r` (camera-to-world, or any rotation): band 0 kept, band 1 turned exactly, band 2 by
/// evaluate-turn-refit (with its leak into bands 0–1, see the module docs). The irradiance of the result at `r · d`
/// is the irradiance of `sh` at `d`. Without band 2 (v1's fits) no refit runs.
#[must_use]
#[allow(clippy::float_cmp)] // band 2 exactly zero takes the exact path
pub fn rotate_sh(sh: &Sh9, r: &M3) -> Sh9 {
    let mut out = [[0.0; 3]; 9];
    out[0] = sh[0];
    for ch in 0..3 {
        let v = mul(r, [sh[3][ch], sh[1][ch], sh[2][ch]]);
        out[3][ch] = v[0];
        out[1][ch] = v[1];
        out[2][ch] = v[2];
    }
    if sh[4..].iter().all(|c| c.iter().all(|&v| v == 0.0)) {
        return out;
    }
    let mut band2 = [[0.0; 3]; 9];
    band2[4..].copy_from_slice(&sh[4..]);
    let turned = refit(&band2, r);
    for (o, t) in out.iter_mut().zip(turned) {
        for ch in 0..3 {
            o[ch] += t[ch];
        }
    }
    out
}

/// The v1 lights' constants (planner/lighting.js `V1`): key 1.1, hemisphere 0.35, environment 0.8.
pub const V1_LIGHTS: (f64, f64, f64) = (1.1, 0.35, 0.8);

/// The room light the splat level is computed from (lighting.json's ambient turned to the world, and its key).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RoomLight<'a> {
    /// The ambient SH in the world frame.
    pub world_sh: &'a Sh9,
    /// The key's colour (linear RGB, largest component 1).
    pub key_color: [f64; 3],
    /// The key's intensity.
    pub key_intensity: f64,
    /// `white_balance.rgb` (luminance 1), `[1, 1, 1]` when absent.
    pub white_balance: [f64; 3],
}

/// v1's `splatGain()` (contract §4.8): the colour splats are multiplied by. With lighting.json: the room light's
/// colour times the level `(A · ambient + K · strength) / (A + K)`, A the probe's irradiance luminance on an up-facing
/// surface (at least 1e-4) and K half the key's luminance times its intensity; 1 at the defaults. Without: the same
/// level from the v1 lights, white.
#[must_use]
pub fn splat_gain(room: Option<&RoomLight<'_>>, ambient: f64, strength: f64) -> [f64; 3] {
    let Some(room) = room else {
        let (key, hemi, env) = V1_LIGHTS;
        let g = (hemi + env) * ambient / (hemi + env + 0.5 * key)
            + 0.5 * key * strength / (hemi + env + 0.5 * key);
        return [g; 3];
    };
    let a = luminance(irradiance_at(room.world_sh, [0.0, 1.0, 0.0])).max(1e-4);
    let k = 0.5 * luminance(room.key_color) * room.key_intensity;
    let level = (a * ambient + k * strength) / (a + k);
    room.white_balance.map(|v| v * level)
}

/// v1's `warmthTint(w)`: `(1 + 0.14w, 1 + 0.015w, 1 − 0.14w)` scaled to luminance 1.
#[must_use]
pub fn warmth_tint(w: f64) -> [f64; 3] {
    let t = [1.0 + 0.14 * w, 1.0 + 0.015 * w, 1.0 - 0.14 * w];
    let k = 1.0 / luminance(t);
    t.map(|v| v * k)
}

/// The splat pass's multiplier (v1 `splatCompMat.uGain`): `warmthTint(warmth) · exposure · splatGain`.
#[must_use]
pub fn splat_multiplier(warmth: f64, exposure: f64, gain: [f64; 3]) -> [f64; 3] {
    let t = warmth_tint(warmth);
    [
        t[0] * exposure * gain[0],
        t[1] * exposure * gain[1],
        t[2] * exposure * gain[2],
    ]
}

#[cfg(test)]
mod tests {
    #![allow(clippy::float_cmp)]
    use super::*;
    use midstudy_geom::look::turn_between;
    use midstudy_geom::mat::{IDENTITY, mat_mul, rot_x, rot_z};

    fn sample() -> Sh9 {
        [
            [1.59, 1.38, 1.16],
            [0.43, 0.46, 0.47],
            [0.20, 0.21, 0.22],
            [0.015, 0.016, 0.016],
            [0.05, -0.02, 0.01],
            [-0.03, 0.04, 0.0],
            [0.07, 0.06, 0.05],
            [0.01, 0.0, -0.01],
            [-0.02, 0.03, 0.02],
        ]
    }

    #[test]
    fn rotation_keeps_the_irradiance() {
        let r = mat_mul(&rot_x(-0.4), &rot_z(0.1));
        let sh = sample();
        let turned = rotate_sh(&sh, &r);
        for d in fibonacci_directions() {
            let a = irradiance_at(&sh, d);
            let b = irradiance_at(&turned, mul(&r, d));
            assert!(
                (0..3).all(|c| (a[c] - b[c]).abs() < 1e-12),
                "{a:?} vs {b:?}"
            );
        }
        // v1's full refit agrees.
        let v1 = rotate_sh_v1(&sh, &r);
        for (x, y) in v1.iter().zip(&turned) {
            assert!((0..3).all(|c| (x[c] - y[c]).abs() < 1e-12));
        }
    }

    #[test]
    fn band1_turns_like_a_vector() {
        let mut sh = [[0.0; 3]; 9];
        sh[0] = [1.0; 3];
        sh[3] = [1.0, 0.0, 0.0]; // x
        let r = turn_between([1.0, 0.0, 0.0], [0.0, 1.0, 0.0]);
        let t = rotate_sh(&sh, &r);
        assert!((t[1][0] - 1.0).abs() < 1e-15 && t[3][0].abs() < 1e-15 && t[0] == [1.0; 3]);
        assert_eq!(rotate_sh(&sh, &IDENTITY), sh);
    }

    #[test]
    fn splat_gain_is_one_at_the_defaults() {
        let g = splat_gain(None, 1.0, 1.0);
        assert!(g.iter().all(|v| (v - 1.0).abs() < 1e-15));
        let sh = sample();
        let room = RoomLight {
            world_sh: &sh,
            key_color: [1.0, 0.9, 0.7],
            key_intensity: 2.2,
            white_balance: [1.1, 0.98, 0.83],
        };
        let g = splat_gain(Some(&room), 1.0, 1.0);
        assert!((0..3).all(|c| (g[c] - room.white_balance[c]).abs() < 1e-15));
        assert!((luminance(warmth_tint(0.7)) - 1.0).abs() < 1e-15);
    }

    #[test]
    fn max_band_scale_keeps_five_percent() {
        let sh = sample();
        let k = max_band_scale(&sh);
        assert!(k.is_finite() && k > 0.0);
        let dc = luminance(irradiance_at(&scale_bands(&sh, 0.0), [0.0, 1.0, 0.0]));
        for d in fibonacci_directions() {
            assert!(luminance(irradiance_at(&scale_bands(&sh, k), d)) >= 0.05 * dc - 1e-9);
        }
    }
}
