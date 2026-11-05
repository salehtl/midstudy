//! Floor-point rules (v1 planner/engine.js): where a new piece lands (`landingSpot`, contract §4.5) and the two-tap
//! ruler that rescales the camera height (`getRuler`, `setRulerTrueLength`).

use crate::camera::{Camera, HEIGHT_RANGE};
use crate::item::Rect;
use crate::jsmath::{js_clamp, js_hypot, js_hypot2, round_to};
use crate::mat::V3;
use crate::view::View;

/// Where a piece lands when the rule finds no floor 1–6 m away: 2.5 m straight ahead.
pub const LANDING_FALLBACK: V3 = [0.0, 0.0, -2.5];

/// v1's `landingSpot` (contract §4.5). The ray through the middle of the visible photo (`visible`, client px, on
/// `view`), else through the middle of its lower third, gives the base point when it hits the floor 1–6 m from the
/// camera (straight-line distance, V8's `Math.hypot(x, height, z)`); else [`LANDING_FALLBACK`]. Then the nearest free
/// spot: rings of 0.6 m around the base (ring r has max(1, 8r) points, r = 0..5), the first point more than 0.6 m in
/// front of the camera (z < −0.6) and more than 0.45 m from every taken (x, z); else the base. Rounded to 6 decimals.
#[must_use]
pub fn landing_spot(camera: &Camera, view: &View, visible: &Rect, taken: &[[f64; 2]]) -> V3 {
    let mut base = None;
    for fy in [0.5, 5.0 / 6.0] {
        let [px, py] =
            view.client_to_photo(visible.x + visible.w / 2.0, visible.y + visible.h * fy);
        let Some(p) = camera.photo_to_floor(px, py) else {
            continue;
        };
        let dist = js_hypot(&[p[0], camera.block().height_m, p[2]]);
        if (1.0..=6.0).contains(&dist) {
            base = Some(p);
            break;
        }
    }
    let base = base.unwrap_or(LANDING_FALLBACK);
    let step = 0.6;
    for ring in 0..6_u32 {
        let m = (ring * 8).max(1);
        for k in 0..m {
            let a = (f64::from(k) / f64::from(m)) * core::f64::consts::PI * 2.0;
            let p = [
                base[0] + a.cos() * f64::from(ring) * step,
                base[2] + a.sin() * f64::from(ring) * step,
            ];
            let free = taken.iter().all(|q| {
                let (dx, dy) = (q[0] - p[0], q[1] - p[1]);
                (dx * dx + dy * dy).sqrt() > 0.45
            });
            if p[1] < -0.6 && free {
                return [round_to(p[0], 6), 0.0, round_to(p[1], 6)];
            }
        }
    }
    [round_to(base[0], 6), 0.0, round_to(base[2], 6)]
}

/// The ruler's length between two floor points: `Math.hypot(Δx, Δz)`.
#[must_use]
pub fn ruler_length(a: V3, b: V3) -> f64 {
    js_hypot2(a[0] - b[0], a[2] - b[2])
}

/// The result of [`ruler_rescale`].
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct RulerScale {
    /// The new camera height (clamped to its range).
    pub height_m: f64,
    /// The factor every floor point (and the ruler's points) scales by: new height / old height.
    pub k: f64,
    /// Whether the clamp left the scale exact (the ruler now reads the true length).
    pub exact: bool,
}

/// v1's `setRulerTrueLength`: the ruler measured `measured_m` and the user says it is `true_m`, so the camera height
/// scales by `true_m / measured_m` (floor points scale with the height; the angles don't change), clamped to the
/// height range. `None` when the input can't be used (not a positive length, or a ruler shorter than 1 mm).
#[must_use]
pub fn ruler_rescale(height_m: f64, measured_m: f64, true_m: f64) -> Option<RulerScale> {
    // v1: `!isNum(meters) || meters <= 0 || !r.meters || r.meters < 1e-3` refuses.
    if !true_m.is_finite()
        || true_m <= 0.0
        || measured_m.is_nan()
        || measured_m == 0.0
        || measured_m < 1e-3
    {
        return None;
    }
    let k = true_m / measured_m;
    let h = js_clamp(height_m * k, HEIGHT_RANGE.0, HEIGHT_RANGE.1);
    let kk = h / height_m;
    Some(RulerScale {
        height_m: h,
        k: kk,
        exact: (kk - k).abs() < 1e-9,
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp)]
    use super::*;
    use crate::camera::{CameraBlock, DEFAULT_CAMERA};

    fn full_view() -> (View, Rect) {
        (
            View {
                s: 0.5,
                ox: 0.0,
                oy: 0.0,
            },
            Rect {
                x: 0.0,
                y: 0.0,
                w: 800.0,
                h: 600.0,
            },
        )
    }

    #[test]
    fn lands_on_the_floor_ahead() {
        let cam = Camera::new(DEFAULT_CAMERA, 1600.0, 1200.0);
        let (view, vis) = full_view();
        let p = landing_spot(&cam, &view, &vis, &[]);
        // The centre ray meets the floor 7.9 m away (beyond 6 m), so the lower third's centre is used.
        assert!(cam.photo_to_floor(800.0, 600.0).unwrap()[2] < -6.0);
        let q = cam.photo_to_floor(800.0, 1000.0).unwrap();
        assert_eq!(p, [round_to(q[0], 6), 0.0, round_to(q[2], 6)]);
        // A piece already there: the next lands on the first ring.
        let p2 = landing_spot(&cam, &view, &vis, &[[p[0], p[2]]]);
        assert!(((p2[0] - p[0]).powi(2) + (p2[2] - p[2]).powi(2)).sqrt() > 0.45);
    }

    #[test]
    fn falls_back_ahead_when_looking_up() {
        let cam = Camera::new(
            CameraBlock {
                pitch_deg: 20.0,
                ..DEFAULT_CAMERA
            },
            1600.0,
            1200.0,
        );
        let (view, vis) = full_view();
        assert_eq!(landing_spot(&cam, &view, &vis, &[]), [0.0, 0.0, -2.5]);
    }

    #[test]
    fn ruler_scales_the_height() {
        let r = ruler_rescale(1.4, 2.0, 2.2).unwrap();
        assert!((r.height_m - 1.54).abs() < 1e-12 && r.exact);
        let r = ruler_rescale(2.9, 1.0, 2.0).unwrap();
        assert_eq!(r.height_m, 3.0);
        assert!(!r.exact);
        assert!(ruler_rescale(1.4, 0.0005, 1.0).is_none());
        assert!(ruler_rescale(1.4, 1.0, -1.0).is_none());
        assert_eq!(ruler_length([0.0, 0.0, 0.0], [3.0, 0.0, 4.0]), 5.0);
    }
}
