//! JavaScript-compatible arithmetic for the places where v1's results depend on how JS rounds or compares:
//! `Math.round`, `Math.min`/`Math.max` (NaN and signed zeros), V8's `Math.hypot`, and v1's angle wrapping.
//! Everything else is plain IEEE 754 f64, which Rust and JS share (no fused multiply-adds on either side).
#![allow(clippy::float_cmp)] // exact comparisons are the point here: these replicate JS's exact semantics

/// π / 180, as v1's `DEG` (`Math.PI / 180`). Degrees become radians by `* DEG` and radians degrees by `/ DEG`
/// (v1's order; `f64::to_degrees` multiplies by 180/π instead, which can differ in the last bit).
pub const DEG: f64 = core::f64::consts::PI / 180.0;

/// Powers of ten that `10 ** n` gives exactly in JS for `n` in 0..=15.
const POW10: [f64; 16] = [
    1.0, 1e1, 1e2, 1e3, 1e4, 1e5, 1e6, 1e7, 1e8, 1e9, 1e10, 1e11, 1e12, 1e13, 1e14, 1e15,
];

/// `Math.round(x)`: the integer nearest `x`, ties toward +∞ (`Math.round(-2.5)` is −2 where Rust's `round` gives
/// −3), −0 for −0.5 ≤ x < 0, and NaN and ±∞ unchanged.
#[must_use]
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    // x − floor(x) is exact for every finite x (it is the fractional part, on x's own grid).
    let r = if x - f >= 0.5 { f + 1.0 } else { f };
    if r == 0.0 && x.is_sign_negative() {
        -0.0
    } else {
        r
    }
}

/// v1's `round(v, n)`: `Math.round(v * 10 ** n) / 10 ** n`, for `n` in 0..=15 (larger `n` is treated as 15).
#[must_use]
pub fn round_to(v: f64, n: usize) -> f64 {
    let p = POW10[n.min(15)];
    js_round(v * p) / p
}

/// `Math.max(a, b)`: NaN if either is NaN, and +0 over −0.
#[must_use]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() && b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else if a > b {
        a
    } else {
        b
    }
}

/// `Math.min(a, b)`: NaN if either is NaN, and −0 under +0.
#[must_use]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a == 0.0 && b == 0.0 {
        if a.is_sign_negative() || b.is_sign_negative() {
            -0.0
        } else {
            0.0
        }
    } else if a < b {
        a
    } else {
        b
    }
}

/// `Math.min(hi, Math.max(lo, v))`, v1's clamp, with JS's NaN behaviour (a NaN `v` stays NaN).
#[must_use]
pub fn js_clamp(v: f64, lo: f64, hi: f64) -> f64 {
    js_min(hi, js_max(lo, v))
}

/// V8's `Math.hypot` (its Torque builtin): ∞ if any argument is ±∞, else NaN if any is NaN, else the arguments
/// normalised by the largest magnitude, squared and summed with Kahan compensation, `sqrt(sum) · max`. Bit-identical
/// to V8, so a distance compared with a threshold (the landing rule's 1–6 m) takes the same branch as v1.
#[must_use]
pub fn js_hypot(values: &[f64]) -> f64 {
    let mut max = 0.0_f64;
    let mut any_nan = false;
    for &v in values {
        if v.is_nan() {
            any_nan = true;
        } else if v.abs() > max {
            max = v.abs();
        }
    }
    if max == f64::INFINITY {
        return f64::INFINITY;
    }
    if any_nan {
        return f64::NAN;
    }
    if max == 0.0 {
        return 0.0;
    }
    let mut sum = 0.0_f64;
    let mut compensation = 0.0_f64;
    for &v in values {
        let n = v.abs() / max;
        let summand = n * n - compensation;
        let preliminary = sum + summand;
        compensation = (preliminary - sum) - summand;
        sum = preliminary;
    }
    sum.sqrt() * max
}

/// `Math.hypot(a, b)`, as [`js_hypot`].
#[must_use]
pub fn js_hypot2(a: f64, b: f64) -> f64 {
    js_hypot(&[a, b])
}

/// v1's `wrapDeg` (planner/engine.js): an angle in degrees wrapped to (−180, 180], with 180 for −180.
/// `%` is the same truncated remainder in JS and Rust (C's `fmod`), so this is bit-identical to v1.
#[must_use]
pub fn wrap_deg(d: f64) -> f64 {
    let x = ((d + 180.0) % 360.0 + 360.0) % 360.0 - 180.0;
    if x == -180.0 { 180.0 } else { x }
}

/// v1's `wrapAz` (the Look's light azimuth, planner/engine.js): wrapped to [−180, 180), except that an angle above 0
/// that lands on −180 becomes 180 (so 180 stays 180 and −180 stays −180).
#[must_use]
pub fn wrap_az(a: f64) -> f64 {
    let w = ((((a + 180.0) % 360.0) + 360.0) % 360.0) - 180.0;
    if w == -180.0 && a > 0.0 { 180.0 } else { w }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn js_round_matches_ecmascript() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0);
        assert_eq!(js_round(-2.6), -3.0);
        assert_eq!(js_round(0.499_999_999_999_999_94), 0.0);
        assert!(js_round(-0.5).is_sign_negative() && js_round(-0.5) == 0.0);
        assert!(js_round(-0.0).is_sign_negative());
        assert!(js_round(0.2).is_sign_positive());
        assert!(js_round(f64::NAN).is_nan());
        assert_eq!(js_round(f64::INFINITY), f64::INFINITY);
        assert_eq!(js_round(4_503_599_627_370_495.5), 4_503_599_627_370_496.0);
        assert_eq!(round_to(1.234_567_5, 6), 1.234_568);
    }

    #[test]
    fn js_min_max_follow_ecmascript() {
        assert!(js_max(f64::NAN, 1.0).is_nan());
        assert!(js_min(1.0, f64::NAN).is_nan());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert_eq!(js_clamp(5.0, 0.0, 4.0), 4.0);
        assert_eq!(js_clamp(-1.0, 0.0, 4.0), 0.0);
    }

    #[test]
    fn hypot_is_v8s() {
        assert_eq!(js_hypot(&[3.0, 4.0]), 5.0);
        assert_eq!(js_hypot(&[]), 0.0);
        assert_eq!(js_hypot(&[f64::NAN, f64::INFINITY]), f64::INFINITY);
        assert!(js_hypot(&[f64::NAN, 1.0]).is_nan());
        assert_eq!(js_hypot(&[1e300, 1e300]), 1e300 * core::f64::consts::SQRT_2);
    }

    #[test]
    fn wraps_match_v1() {
        assert_eq!(wrap_deg(-180.0), 180.0);
        assert_eq!(wrap_deg(180.0), 180.0);
        assert_eq!(wrap_deg(270.0), -90.0);
        assert_eq!(wrap_deg(-540.0), 180.0);
        assert_eq!(wrap_az(180.0), 180.0);
        assert_eq!(wrap_az(-180.0), -180.0);
        assert_eq!(wrap_az(540.0), 180.0);
        assert_eq!(wrap_az(-540.0), -180.0);
        assert_eq!(wrap_az(190.0), -170.0);
    }
}
