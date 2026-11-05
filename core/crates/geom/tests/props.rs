//! Property tests for the camera model and the planner's geometry (LEAN.md lists the same properties for the proofs).
#![allow(
    clippy::unwrap_used,
    clippy::many_single_char_names,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp
)]

use midstudy_geom::camera::{
    FOV_RANGE, HEIGHT_RANGE, HORIZON_FINE_DEG_PER_PX, PITCH_RANGE, ROLL_RANGE, horizon_drag_gain,
    horizon_drag_row,
};
use midstudy_geom::drag::{Plane, plane_point_at_photo};
use midstudy_geom::hull::{convex_hull, dist_to_hull, point_in_hull};
use midstudy_geom::item::{LocalBox, Pose, rotate_by, world_bounds};
use midstudy_geom::jsmath::{DEG, round_to, wrap_az, wrap_deg};
use midstudy_geom::look::LookNumber;
use midstudy_geom::mat::{mat_mul, rot_x, rot_z};
use midstudy_geom::{Camera, CameraBlock, DEFAULT_CAMERA};
use proptest::prelude::*;

fn camera_block() -> impl Strategy<Value = CameraBlock> {
    (
        FOV_RANGE.0..=FOV_RANGE.1,
        HEIGHT_RANGE.0..=HEIGHT_RANGE.1,
        PITCH_RANGE.0..=PITCH_RANGE.1,
        ROLL_RANGE.0..=ROLL_RANGE.1,
    )
        .prop_map(|(fov_y_deg, height_m, pitch_deg, roll_deg)| CameraBlock {
            fov_y_deg,
            height_m,
            pitch_deg,
            roll_deg,
        })
}

fn photo_size() -> impl Strategy<Value = (f64, f64)> {
    (64_u32..=4096, 64_u32..=4096).prop_map(|(w, h)| (f64::from(w), f64::from(h)))
}

/// Any f64, including NaN, infinities, subnormals and signed zeros.
fn any_f64() -> impl Strategy<Value = f64> {
    prop_oneof![
        any::<f64>(),
        Just(f64::NAN),
        Just(f64::INFINITY),
        Just(f64::NEG_INFINITY),
        Just(-0.0),
        -1e3..1e3_f64
    ]
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 4000, failure_persistence: None, ..ProptestConfig::default() })]

    /// project ∘ photoToFloor is the identity on pixels at least 1 px below the horizon (and inside a generous frame).
    #[test]
    fn photo_floor_photo_round_trip(b in camera_block(), (w, h) in photo_size(), u in 0.0..1.0_f64, v in 0.0..1.0_f64) {
        let cam = Camera::new(b, w, h);
        let px = u * w;
        let hz = cam.horizon_at(px).unwrap();
        let py = (hz + 1.0).max(0.0) + v * (h * 3.0);
        let p = cam.photo_to_floor(px, py);
        prop_assert!(p.is_some(), "no floor below the horizon at ({px}, {py}), horizon {hz}");
        let p = p.unwrap();
        prop_assert_eq!(p[1], 0.0);
        let q = cam.project(p);
        prop_assert!(q[2] > 0.0);
        prop_assert!((q[0] - px).abs() <= 1e-6 && (q[1] - py).abs() <= 1e-6, "{:?} vs ({}, {})", q, px, py);
    }

    /// photoToFloor ∘ project is the identity on floor points in front of the camera that project below the horizon.
    #[test]
    fn floor_photo_floor_round_trip(b in camera_block(), (w, h) in photo_size(), x in -20.0..20.0_f64, z in -40.0..-0.3_f64) {
        let cam = Camera::new(b, w, h);
        let p = [x, 0.0, z];
        let q = cam.project(p);
        prop_assume!(q[2] > 1e-3);
        // At least 1 px below the horizon (closer to it the floor is ill-conditioned in pixels).
        prop_assume!(q[1] > cam.horizon_at(q[0]).unwrap() + 1.0);
        let back = cam.photo_to_floor(q[0], q[1]).unwrap();
        let scale = x.abs().max(z.abs());
        prop_assert!((back[0] - x).abs() <= 1e-9 * scale && (back[2] - z).abs() <= 1e-9 * scale, "{:?} vs {:?}", back, p);
    }

    /// Pixels at or above the horizon have no floor point.
    #[test]
    fn nothing_above_the_horizon(b in camera_block(), (w, h) in photo_size(), u in 0.0..1.0_f64, up in 0.0..1e4_f64) {
        let cam = Camera::new(b, w, h);
        let px = u * w;
        let py = cam.horizon_at(px).unwrap() - up;
        prop_assert!(cam.photo_to_floor(px, py).is_none());
    }

    /// R is Rx(pitch) · Rz(roll), and orthonormal.
    #[test]
    fn rotation_is_rx_rz(b in camera_block()) {
        let cam = Camera::new(b, 1600.0, 1200.0);
        let r = cam.rotation();
        let m = mat_mul(&rot_x(b.pitch_deg * DEG), &rot_z(b.roll_deg * DEG));
        for i in 0..3 {
            for j in 0..3 {
                prop_assert!((r[i][j] - m[i][j]).abs() < 1e-15);
                let d: f64 = (0..3).map(|k| r[k][i] * r[k][j]).sum();
                let unit = if i == j { 1.0 } else { 0.0 };
                prop_assert!((d - unit).abs() < 1e-15);
            }
        }
    }

    /// The horizon row and the pitch it sets are inverse (centre column).
    #[test]
    fn horizon_pitch_inverse(b in camera_block(), (w, h) in photo_size()) {
        let cam = Camera::new(b, w, h);
        let row = cam.horizon_at(w / 2.0).unwrap();
        prop_assert!((cam.pitch_from_horizon(row).unwrap() - b.pitch_deg).abs() < 1e-9);
    }

    /// The floor plane hit of a drag equals photoToFloor wherever both exist (within 60 m).
    #[test]
    fn floor_plane_hit_is_photo_to_floor(b in camera_block(), (w, h) in photo_size(), u in 0.0..1.0_f64, v in 0.0..1.0_f64) {
        let cam = Camera::new(b, w, h);
        let (px, py) = (u * w, v * h);
        if let Some(p) = plane_point_at_photo(&cam, px, py, &Plane::horizontal(0.0)) {
            let q = cam.photo_to_floor(px, py).unwrap();
            prop_assert!((0..3).all(|k| (p[k] - q[k]).abs() <= 1e-9 * (1.0 + q[k].abs())), "{:?} vs {:?}", p, q);
        }
    }

    /// The horizon drag tilts the camera by at most 0.12° per CSS pixel when the gain caps it, and by at most the
    /// angle a CSS pixel covers when the line follows the pointer.
    #[test]
    fn horizon_drag_is_capped(b in camera_block(), (w, h) in photo_size(), rect_h in 50.0..3000.0_f64, dy in -400.0..400.0_f64) {
        let cam = Camera::new(b, w, h);
        let s = rect_h / h; // CSS px per photo px
        let gain = horizon_drag_gain(b.fov_y_deg, rect_h);
        prop_assert!(gain > 0.0 && gain <= 1.0);
        let py0 = cam.horizon_at(w / 2.0).unwrap();
        let p1 = cam.pitch_from_horizon(horizon_drag_row(py0, dy, s, gain)).unwrap();
        let per_px = (360.0 / std::f64::consts::PI) * (b.fov_y_deg * DEG / 2.0).tan() / rect_h;
        let cap = if gain < 1.0 { HORIZON_FINE_DEG_PER_PX } else { per_px };
        prop_assert!((p1 - b.pitch_deg).abs() <= cap * dy.abs() * (1.0 + 1e-9) + 1e-9, "{} deg over {} px", p1 - b.pitch_deg, dy);
    }

    /// Clamping the camera is idempotent and lands in range, whatever the input (non-finite fields take the base).
    #[test]
    fn camera_clamp_idempotent_in_range(a in any_f64(), b in any_f64(), c in any_f64(), d in any_f64(), base in camera_block()) {
        let base = base.clamped(&DEFAULT_CAMERA);
        let k = CameraBlock { fov_y_deg: a, height_m: b, pitch_deg: c, roll_deg: d }.clamped(&base);
        prop_assert_eq!(k.clamped(&base), k);
        prop_assert_eq!(k.clamped(&DEFAULT_CAMERA), k);
        for (v, (lo, hi)) in k.to_array().into_iter().zip([FOV_RANGE, HEIGHT_RANGE, PITCH_RANGE, ROLL_RANGE]) {
            prop_assert!(v >= lo && v <= hi);
            prop_assert_eq!(round_to(v, 6), v);
        }
    }

    /// The Look's clamps are idempotent and in range.
    #[test]
    fn look_clamp_idempotent_in_range(v in any_f64()) {
        for key in LookNumber::ALL {
            let (lo, hi, default) = key.range();
            match key.clamp(v) {
                Some(c) => {
                    prop_assert!(c >= lo && c <= hi);
                    let again = key.clamp(c).unwrap();
                    if key == LookNumber::LightAzimuthDeg {
                        // v1's wrapAz adds 360 and takes the remainder again, which can move an in-range azimuth
                        // by an ulp of 360 (kept: the clamps are v1's, bit for bit).
                        prop_assert!((again - c).abs() <= 2.0 * 360.0 * f64::EPSILON, "{} -> {}", c, again);
                    } else {
                        prop_assert_eq!(again, c);
                    }
                }
                None => prop_assert!(default.is_none() && !v.is_finite()),
            }
        }
    }

    /// The angle wraps land in range and keep the angle (mod 360).
    #[test]
    fn wraps_in_range(a in -1e6..1e6_f64) {
        let w = wrap_deg(a);
        prop_assert!(w > -180.0 && w <= 180.0);
        prop_assert!(((w - a) / 360.0 - ((w - a) / 360.0).round()).abs() < 1e-9);
        let z = wrap_az(a);
        prop_assert!((-180.0..=180.0).contains(&z));
        prop_assert!(((z - a) / 360.0 - ((z - a) / 360.0).round()).abs() < 1e-9);
    }

    /// Four quarter turns are the identity: on the stored angle (exactly, for angles on v1's 1e-6 grid) and on points.
    #[test]
    fn four_quarter_turns(k in -1_800_000_000_i64..1_800_000_000, x in -5.0..5.0_f64, y in 0.0..2.0_f64, z in -5.0..5.0_f64) {
        #[allow(clippy::cast_precision_loss)]
        let r0 = round_to(wrap_deg(k as f64 / 1e7), 6);
        let r4 = (0..4).fold(r0, |r, _| rotate_by(r, 90.0));
        prop_assert_eq!(r4, r0);
        let p = [x, y, z];
        let q = (0..4).fold(p, |q, _| Pose { position: [0.0; 3], rotation_y_deg: 90.0 }.transform().apply(q));
        prop_assert!((0..3).all(|i| (q[i] - p[i]).abs() < 1e-14));
    }

    /// A quarter turn swaps the X and Z extents of an item's world bounds.
    #[test]
    fn quarter_turn_swaps_extents(r in -180.0..180.0_f64, w in 0.01..5.0_f64, h in 0.01..3.0_f64, d in 0.01..5.0_f64, x in -5.0..5.0_f64, z in -9.0..0.0_f64) {
        let b = LocalBox::from_dims(w, h, d);
        let ext = |rot: f64| {
            let (lo, hi) = world_bounds(&Pose { position: [x, 0.3, z], rotation_y_deg: rot }.transform(), &b);
            [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]]
        };
        let (e0, e1) = (ext(r), ext(r + 90.0));
        prop_assert!((e0[0] - e1[2]).abs() < 1e-12 && (e0[2] - e1[0]).abs() < 1e-12, "{:?} {:?}", e0, e1);
        prop_assert!((e0[1] - h).abs() < 1e-12 && (e1[1] - h).abs() < 1e-12);
    }

    /// The hull contains (or touches, to rounding) every point it was built from, its vertices are input points,
    /// and it turns one way.
    #[test]
    fn hull_contains_its_points(pts in prop::collection::vec((-1e4..1e4_f64, -1e4..1e4_f64), 0..40)) {
        let pts: Vec<[f64; 2]> = pts.into_iter().map(|(x, y)| [x, y]).collect();
        let mut work = pts.clone();
        let mut out = vec![[0.0; 2]; 2 * pts.len()];
        let n = convex_hull(&mut work, &mut out).unwrap();
        let h = &out[..n];
        for v in h {
            prop_assert!(pts.contains(v));
        }
        if n >= 3 {
            for p in &pts {
                prop_assert!(point_in_hull(h, p[0], p[1]) || dist_to_hull(h, p[0], p[1]) <= 1e-9 * 1e4, "{:?} outside", p);
            }
            for i in 0..n {
                let (o, a, b) = (h[i], h[(i + 1) % n], h[(i + 2) % n]);
                let cross = (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
                prop_assert!(cross > 0.0);
            }
        }
    }
}
