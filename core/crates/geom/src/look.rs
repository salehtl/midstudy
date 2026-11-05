//! The Look's numeric clamps (contract §4.8; v1 planner/engine.js `LOOK_NUM`, `lookFrom`, `setLighting`) and the key
//! light's direction maths (v1 planner/lighting.js `azElOf`, `dirOf`, `turnBetween`, `V1_KEY_DIR`).

use crate::jsmath::{DEG, js_clamp, wrap_az};
use crate::mat::{M3, V3, normalize};

/// The Look's numeric keys.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LookNumber {
    /// Furniture exposure, 0.25–4, default 1.
    Exposure,
    /// Warm/cool tint, −1–1, default 0.
    Warmth,
    /// Key light azimuth (world, from above; 0 straight ahead, 90 from the right), −180–180, default: inferred.
    LightAzimuthDeg,
    /// Key light elevation above the floor's horizon, 5–90, default: inferred.
    LightElevationDeg,
    /// Shadow softness, 0–1, default: inferred.
    LightSoftness,
    /// Directional light multiplier, 0–3, default 1.
    LightStrength,
    /// Ambient multiplier, 0–3, default 1.
    Ambient,
}

impl LookNumber {
    /// Every key, in v1's `LOOK_NUM` order.
    pub const ALL: [LookNumber; 7] = [
        Self::Exposure,
        Self::Warmth,
        Self::LightAzimuthDeg,
        Self::LightElevationDeg,
        Self::LightSoftness,
        Self::LightStrength,
        Self::Ambient,
    ];

    /// The key as it appears in `scene.json`'s `look`.
    #[must_use]
    pub fn key(self) -> &'static str {
        match self {
            Self::Exposure => "exposure",
            Self::Warmth => "warmth",
            Self::LightAzimuthDeg => "light_azimuth_deg",
            Self::LightElevationDeg => "light_elevation_deg",
            Self::LightSoftness => "light_softness",
            Self::LightStrength => "light_strength",
            Self::Ambient => "ambient",
        }
    }

    /// `(lo, hi, default)`; `None` as the default means "the scene's inferred value" (v1's `null`).
    #[must_use]
    pub fn range(self) -> (f64, f64, Option<f64>) {
        match self {
            Self::Exposure => (0.25, 4.0, Some(1.0)),
            Self::Warmth => (-1.0, 1.0, Some(0.0)),
            Self::LightAzimuthDeg => (-180.0, 180.0, None),
            Self::LightElevationDeg => (5.0, 90.0, None),
            Self::LightSoftness => (0.0, 1.0, None),
            Self::LightStrength | Self::Ambient => (0.0, 3.0, Some(1.0)),
        }
    }

    /// v1's clamp of one Look value: a finite number is clamped to the range (the azimuth wrapped first, `wrapAz`);
    /// anything else takes the default (`None`: inferred).
    #[must_use]
    pub fn clamp(self, v: f64) -> Option<f64> {
        let (lo, hi, default) = self.range();
        if !v.is_finite() {
            return default;
        }
        Some(js_clamp(
            if self == Self::LightAzimuthDeg {
                wrap_az(v)
            } else {
                v
            },
            lo,
            hi,
        ))
    }
}

/// The v1 key light's direction (planner/lighting.js `V1_KEY_DIR`): (−1.5, 4, 2.5) normalised.
#[must_use]
pub fn v1_key_dir() -> V3 {
    normalize([-1.5, 4.0, 2.5])
}

/// v1's `azElOf`: a world direction to (azimuth, elevation) in degrees; azimuth 0 is straight ahead (−Z), 90 the
/// right (+X); elevation above the floor's horizon (y clamped to −1..1 before the arcsine).
#[must_use]
pub fn az_el_of(d: V3) -> (f64, f64) {
    (
        d[0].atan2(-d[2]) / DEG,
        js_clamp(d[1], -1.0, 1.0).asin() / DEG,
    )
}

/// v1's `dirOf`: (azimuth, elevation) in degrees to a unit world direction.
#[must_use]
pub fn dir_of(az_deg: f64, el_deg: f64) -> V3 {
    let (el, az) = (el_deg * DEG, az_deg * DEG);
    [el.cos() * az.sin(), el.sin(), -el.cos() * az.cos()]
}

/// three.js `Quaternion.setFromUnitVectors(a, b)` (0.180: opposite vectors below 1e-8 turn about an axis
/// perpendicular to `a`), then `normalize()`, as `(x, y, z, w)`.
#[must_use]
#[allow(clippy::float_cmp)] // three.js tests the length for exactly 0
pub fn quat_from_unit_vectors(a: V3, b: V3) -> [f64; 4] {
    let mut r = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + 1.0;
    let q = if r < 1e-8 {
        r = 0.0;
        if a[0].abs() > a[2].abs() {
            [-a[1], a[0], 0.0, r]
        } else {
            [0.0, -a[2], a[1], r]
        }
    } else {
        [
            a[1] * b[2] - a[2] * b[1],
            a[2] * b[0] - a[0] * b[2],
            a[0] * b[1] - a[1] * b[0],
            r,
        ]
    };
    let l = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    if l == 0.0 {
        [0.0, 0.0, 0.0, 1.0]
    } else {
        let l = 1.0 / l;
        [q[0] * l, q[1] * l, q[2] * l, q[3] * l]
    }
}

/// three.js `Matrix4.makeRotationFromQuaternion` (its `compose` with no translation and unit scale), as a 3 × 3.
#[must_use]
pub fn mat_from_quat(q: [f64; 4]) -> M3 {
    let [x, y, z, w] = q;
    let (x2, y2, z2) = (x + x, y + y, z + z);
    let (xx, xy, xz) = (x * x2, x * y2, x * z2);
    let (yy, yz, zz) = (y * y2, y * z2, z * z2);
    let (wx, wy, wz) = (w * x2, w * y2, w * z2);
    [
        [1.0 - (yy + zz), xy - wz, xz + wy],
        [xy + wz, 1.0 - (xx + zz), yz - wx],
        [xz - wy, yz + wx, 1.0 - (xx + yy)],
    ]
}

/// v1's `turnBetween(a, b)`: the shortest rotation taking direction `a` to direction `b` (both normalised first).
#[must_use]
pub fn turn_between(a: V3, b: V3) -> M3 {
    mat_from_quat(quat_from_unit_vectors(normalize(a), normalize(b)))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::float_cmp)]
    use super::*;
    use crate::mat::{length, mul};

    #[test]
    fn look_clamps_like_v1() {
        assert_eq!(LookNumber::Exposure.clamp(9.0), Some(4.0));
        assert_eq!(LookNumber::Exposure.clamp(f64::NAN), Some(1.0));
        assert_eq!(LookNumber::LightAzimuthDeg.clamp(190.0), Some(-170.0));
        assert_eq!(LookNumber::LightAzimuthDeg.clamp(-180.0), Some(-180.0));
        assert_eq!(LookNumber::LightAzimuthDeg.clamp(f64::INFINITY), None);
        assert_eq!(LookNumber::LightElevationDeg.clamp(1.0), Some(5.0));
    }

    #[test]
    fn directions_round_trip() {
        let d = dir_of(30.0, 40.0);
        assert!((length(d) - 1.0).abs() < 1e-15);
        let (az, el) = az_el_of(d);
        assert!((az - 30.0).abs() < 1e-12 && (el - 40.0).abs() < 1e-12);
        assert_eq!(az_el_of([0.0, 0.0, -1.0]), (0.0, 0.0));
        assert!((az_el_of([1.0, 0.0, 0.0]).0 - 90.0).abs() < 1e-12);
    }

    #[test]
    fn turn_between_takes_a_to_b() {
        let (a, b) = (normalize([1.0, 2.0, 3.0]), normalize([-2.0, 0.5, 1.0]));
        let m = turn_between(a, b);
        let c = mul(&m, a);
        assert!((0..3).all(|k| (c[k] - b[k]).abs() < 1e-14));
        let m = turn_between([0.0, 0.0, 1.0], [0.0, 0.0, -1.0]);
        let c = mul(&m, [0.0, 0.0, 1.0]);
        assert!((c[2] + 1.0).abs() < 1e-14);
    }
}
