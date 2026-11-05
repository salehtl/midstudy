//! Colour transforms of the furniture pipeline (contract §4.8): sRGB decoding and three.js 0.180's ACES Filmic tone
//! curve with v1's inverse (planner/lighting.js `toLinear`, `aces`, `acesInv`, `ACES_IN`, `ACES_OUT`), in f64.

use midstudy_geom::mat::{M3, mul};

/// three.js's ACES input matrix (planner/lighting.js `ACES_IN`, built from columns), row-major.
pub const ACES_IN: M3 = [
    [0.59719, 0.35458, 0.04823],
    [0.07600, 0.90834, 0.01566],
    [0.02840, 0.13383, 0.83777],
];
/// three.js's ACES output matrix (`ACES_OUT`), row-major.
pub const ACES_OUT: M3 = [
    [1.60475, -0.53108, -0.07367],
    [-0.10208, 1.10813, -0.00605],
    [-0.00327, -0.07276, 1.07602],
];

/// three.js `Matrix3.invert` (its exact formula, on the column-major elements; all zeros for a singular matrix).
#[must_use]
#[allow(clippy::float_cmp, clippy::similar_names)] // three.js tests det for exactly 0; n11…n33 are its names
pub fn invert_three(m: &M3) -> M3 {
    // elements: te[0..9] column-major; n_rc = row r, column c.
    let (n11, n21, n31) = (m[0][0], m[1][0], m[2][0]);
    let (n12, n22, n32) = (m[0][1], m[1][1], m[2][1]);
    let (n13, n23, n33) = (m[0][2], m[1][2], m[2][2]);
    let t11 = n33 * n22 - n32 * n23;
    let t12 = n32 * n13 - n33 * n12;
    let t13 = n23 * n12 - n22 * n13;
    let det = n11 * t11 + n21 * t12 + n31 * t13;
    if det == 0.0 {
        return [[0.0; 3]; 3];
    }
    let d = 1.0 / det;
    let te = [
        t11 * d,
        (n31 * n23 - n33 * n21) * d,
        (n32 * n21 - n31 * n22) * d,
        t12 * d,
        (n33 * n11 - n31 * n13) * d,
        (n31 * n12 - n32 * n11) * d,
        t13 * d,
        (n21 * n13 - n23 * n11) * d,
        (n22 * n11 - n21 * n12) * d,
    ];
    [
        [te[0], te[3], te[6]],
        [te[1], te[4], te[7]],
        [te[2], te[5], te[8]],
    ]
}

/// The inverses v1 uploads as `uInInv` and `uOutInv`.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AcesInverse {
    in_inv: M3,
    out_inv: M3,
}

impl Default for AcesInverse {
    fn default() -> Self {
        Self::new()
    }
}

impl AcesInverse {
    /// The two inverse matrices, computed as three.js does.
    #[must_use]
    pub fn new() -> Self {
        Self {
            in_inv: invert_three(&ACES_IN),
            out_inv: invert_three(&ACES_OUT),
        }
    }

    /// v1's `acesInv`: display-referred `d` (0–1, clamped to 0.985 first) back to scene radiance, the inverse of
    /// three.js's ACES Filmic (`x / 0.6` in, the RRT/ODT fit solved per channel), clamped at 0.
    #[must_use]
    pub fn apply(&self, d: [f64; 3]) -> [f64; 3] {
        let y = mul(&self.out_inv, d.map(|c| c.clamp(0.0, 0.985)));
        let v = y.map(|y| {
            let qa = 1.0 - 0.983_729 * y;
            let qb = 0.024_578_6 - 0.432_951 * y;
            let qc = -(0.000_090_537 + 0.238_081 * y);
            (-qb + (qb * qb - 4.0 * qa * qc).max(0.0).sqrt()) / (2.0 * qa)
        });
        mul(&self.in_inv, v).map(|c| (c * 0.6).max(0.0))
    }
}

/// three.js's ACES Filmic tone curve as v1's shaders write it: `clamp(OUT · rrt(IN · (x / 0.6)), 0, 1)`.
#[must_use]
pub fn aces(x: [f64; 3]) -> [f64; 3] {
    let v = mul(&ACES_IN, x.map(|c| c / 0.6));
    let r = v.map(|v| {
        (v * (v + 0.024_578_6) - 0.000_090_537) / (v * (0.983_729 * v + 0.432_951) + 0.238_081)
    });
    mul(&ACES_OUT, r).map(|c| c.clamp(0.0, 1.0))
}

/// v1's `toLinear` (GLSL): `c / 12.92` below 0.04045, else `((c + 0.055) / 1.055)^2.4`.
#[must_use]
pub fn srgb_to_linear(c: f64) -> f64 {
    if c < 0.040_45 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// v1's `toSrgb` (GLSL): `c · 12.92` below 0.0031308, else `1.055 · c^(1/2.4) − 0.055`.
#[must_use]
pub fn linear_to_srgb(c: f64) -> f64 {
    if c < 0.003_130_8 {
        c * 12.92
    } else {
        c.powf(1.0 / 2.4) * 1.055 - 0.055
    }
}

/// Rec. 709 luminance, v1's `lum`: `0.2126 r + 0.7152 g + 0.0722 b`.
#[must_use]
pub fn luminance(c: [f64; 3]) -> f64 {
    0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

#[cfg(test)]
mod tests {
    use super::*;
    use midstudy_geom::mat::mat_mul;

    #[test]
    fn inverses_invert() {
        let k = AcesInverse::new();
        for (m, inv) in [(ACES_IN, k.in_inv), (ACES_OUT, k.out_inv)] {
            let p = mat_mul(&m, &inv);
            for (i, row) in p.iter().enumerate() {
                for (j, v) in row.iter().enumerate() {
                    assert!((v - if i == j { 1.0 } else { 0.0 }).abs() < 1e-12);
                }
            }
        }
    }

    #[test]
    fn aces_inverse_undoes_aces() {
        let k = AcesInverse::new();
        for x in [[0.05, 0.1, 0.2], [0.3, 0.3, 0.3], [0.9, 0.5, 0.1]] {
            let back = k.apply(aces(x));
            assert!(
                (0..3).all(|i| (back[i] - x[i]).abs() < 1e-4 * x[i].max(0.01)),
                "{x:?} -> {back:?}"
            );
        }
    }

    #[test]
    fn srgb_round_trip() {
        for i in 0..=255_u8 {
            let c = f64::from(i) / 255.0;
            assert!((linear_to_srgb(srgb_to_linear(c)) - c).abs() < 1e-12);
        }
    }
}
