//! Items on the floor: the item frame (origin at the centre of the footprint, on the floor; width along X, height
//! along Y, depth along Z; the front faces +Z), its pose in the world (position, the elevation as y, and
//! `rotation_y_deg` counterclockwise seen from above: +X turns toward −Z), the box corners, world bounds, footprint
//! and projected screen rect (v1 planner/engine.js `boxCorners`, `worldBounds`, `getFootprint`, `getScreenRect`).

use crate::camera::Camera;
use crate::jsmath::{DEG, js_clamp, js_max, js_min, round_to, wrap_deg};
use crate::mat::V3;

/// The highest elevation an item may have (contract §2.10), meters.
pub const MAX_ELEVATION: f64 = 4.0;

/// v1's `clampElev`: the elevation within 0..=4 m (NaN stays NaN, as `Math.min`/`Math.max` keep it).
#[must_use]
pub fn clamp_elevation(y: f64) -> f64 {
    js_clamp(y, 0.0, MAX_ELEVATION)
}

/// v1's `rotateSelected(deg)`: the new `rotation_y_deg`, `round(wrapDeg(rot + deg), 6)`.
#[must_use]
pub fn rotate_by(rotation_y_deg: f64, deg: f64) -> f64 {
    round_to(wrap_deg(rotation_y_deg + deg), 6)
}

/// An item's pose: its position (x, elevation, z) and its turn about +Y.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Pose {
    /// World position of the item frame's origin; `position[1]` is the elevation.
    pub position: V3,
    /// Degrees, counterclockwise seen from above.
    pub rotation_y_deg: f64,
}

/// A pose as a rigid transform, `world = Ry(θ) · local + position`, with its sine and cosine computed once.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Transform {
    sin: f64,
    cos: f64,
    t: V3,
}

impl Pose {
    /// The pose's transform.
    #[must_use]
    pub fn transform(&self) -> Transform {
        let (sin, cos) = (self.rotation_y_deg * DEG).sin_cos();
        Transform {
            sin,
            cos,
            t: self.position,
        }
    }
}

impl Transform {
    /// A local point in the world: `(cos θ · x + sin θ · z, y, −sin θ · x + cos θ · z) + position`.
    #[must_use]
    pub fn apply(&self, p: V3) -> V3 {
        [
            self.cos * p[0] + self.sin * p[2] + self.t[0],
            p[1] + self.t[1],
            -self.sin * p[0] + self.cos * p[2] + self.t[2],
        ]
    }

    /// A local direction in the world (rotation only).
    #[must_use]
    pub fn rotate(&self, v: V3) -> V3 {
        [
            self.cos * v[0] + self.sin * v[2],
            v[1],
            -self.sin * v[0] + self.cos * v[2],
        ]
    }
}

/// An axis-aligned box in the item frame (`min`, `max`): the item's local bounds (from its model; for a library item
/// at its true size, `[−w/2, 0, −d/2]` to `[w/2, h, d/2]`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LocalBox {
    /// Smallest corner.
    pub min: V3,
    /// Largest corner.
    pub max: V3,
}

impl LocalBox {
    /// The box of an item of `dims` (w, h, d) meters, centred on its footprint and standing on its own floor.
    #[must_use]
    pub fn from_dims(w: f64, h: f64, d: f64) -> Self {
        Self {
            min: [-w / 2.0, 0.0, -d / 2.0],
            max: [w / 2.0, h, d / 2.0],
        }
    }
}

/// The 8 corners of the item's box in the world, v1's order (and truth.json's): bottom ring then top ring, each
/// back-left, back-right, front-right, front-left (back = local −Z, front = local +Z).
#[must_use]
pub fn box_corners(t: &Transform, b: &LocalBox) -> [V3; 8] {
    let (lo, hi) = (b.min, b.max);
    let ring = [
        [lo[0], lo[2]],
        [hi[0], lo[2]],
        [hi[0], hi[2]],
        [lo[0], hi[2]],
    ];
    let mut out = [[0.0; 3]; 8];
    for (k, o) in out.iter_mut().enumerate() {
        let y = if k < 4 { lo[1] } else { hi[1] };
        let [x, z] = ring[k % 4];
        *o = t.apply([x, y, z]);
    }
    out
}

/// v1's `worldBounds`: the world axis-aligned bounds `(min, max)` of the item's turned box (three.js
/// `Box3.applyMatrix4`: the 8 corners transformed, then their bounds; an empty box, min > max on some axis, comes back
/// untransformed, as three.js returns it).
#[must_use]
pub fn world_bounds(t: &Transform, b: &LocalBox) -> (V3, V3) {
    // three.js: "transform of empty box is an empty box" (a box with min > max on an axis is returned as is).
    if (0..3).any(|k| b.min[k] > b.max[k]) {
        return (b.min, b.max);
    }
    let corners = box_corners(t, b);
    let mut min = [f64::INFINITY; 3];
    let mut max = [f64::NEG_INFINITY; 3];
    for c in &corners {
        for k in 0..3 {
            min[k] = js_min(min[k], c[k]);
            max[k] = js_max(max[k], c[k]);
        }
    }
    (min, max)
}

/// An item's footprint (v1's `getFootprint`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Footprint {
    /// Front-left, front-right, back-right, back-left, at the item's own floor (y = its elevation).
    pub corners: [V3; 4],
    /// The mean of the four corners.
    pub center: V3,
    /// The box's top in the item frame (`max.y`).
    pub height: f64,
}

/// v1's `getFootprint` (without the box, which is [`box_corners`]).
#[must_use]
pub fn footprint(t: &Transform, b: &LocalBox) -> Footprint {
    let (lo, hi) = (b.min, b.max);
    let corners = [
        [lo[0], hi[2]],
        [hi[0], hi[2]],
        [hi[0], lo[2]],
        [lo[0], lo[2]],
    ]
    .map(|[x, z]| t.apply([x, 0.0, z]));
    // ((((0 + c0) + c1) + c2) + c3) · 0.25, as three.js's reduce and multiplyScalar.
    let mut center = [0.0; 3];
    for c in &corners {
        for k in 0..3 {
            center[k] += c[k];
        }
    }
    Footprint {
        corners,
        center: center.map(|v| v * 0.25),
        height: hi[1],
    }
}

/// A rectangle `{x, y, w, h}` (photo or client pixels).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    /// Left.
    pub x: f64,
    /// Top.
    pub y: f64,
    /// Width.
    pub w: f64,
    /// Height.
    pub h: f64,
}

/// The depth below which v1 treats a projected point as behind the camera (`d > 1e-4` is in front).
pub const IN_FRONT_D: f64 = 1e-4;

/// v1's `getScreenRect` (contract §4.6): the projected bounds of world points in photo pixels, ignoring points at
/// d ≤ 1e-4 (behind the camera); `None` when none is in front.
#[must_use]
pub fn screen_rect(camera: &Camera, points: &[V3]) -> Option<Rect> {
    let mut min = [f64::INFINITY; 2];
    let mut max = [f64::NEG_INFINITY; 2];
    let mut any = false;
    for &p in points {
        let q = camera.project(p);
        if q[2] > IN_FRONT_D {
            any = true;
            min = [js_min(min[0], q[0]), js_min(min[1], q[1])];
            max = [js_max(max[0], q[0]), js_max(max[1], q[1])];
        }
    }
    any.then(|| Rect {
        x: min[0],
        y: min[1],
        w: max[0] - min[0],
        h: max[1] - min[1],
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::float_cmp)]
    use super::*;
    use crate::camera::{CameraBlock, DEFAULT_CAMERA};

    #[test]
    fn a_quarter_turn_takes_x_to_minus_z() {
        let t = Pose {
            position: [0.0, 0.0, 0.0],
            rotation_y_deg: 90.0,
        }
        .transform();
        let p = t.apply([1.0, 0.0, 0.0]);
        assert!(p[0].abs() < 1e-15 && (p[2] + 1.0).abs() < 1e-15);
    }

    #[test]
    fn corners_follow_truth_order() {
        let t = Pose {
            position: [1.0, 0.5, -3.0],
            rotation_y_deg: 0.0,
        }
        .transform();
        let c = box_corners(&t, &LocalBox::from_dims(2.0, 0.8, 1.0));
        assert_eq!(c[0], [0.0, 0.5, -3.5]); // bottom back-left
        assert_eq!(c[2], [2.0, 0.5, -2.5]); // bottom front-right
        assert_eq!(c[7], [0.0, 1.3, -2.5]); // top front-left
        let (lo, hi) = world_bounds(&t, &LocalBox::from_dims(2.0, 0.8, 1.0));
        assert_eq!((lo, hi), ([0.0, 0.5, -3.5], [2.0, 1.3, -2.5]));
        let f = footprint(&t, &LocalBox::from_dims(2.0, 0.8, 1.0));
        assert_eq!(f.corners[0], [0.0, 0.5, -2.5]); // front-left
        assert_eq!(f.center, [1.0, 0.5, -3.0]);
    }

    #[test]
    fn screen_rect_skips_points_behind() {
        let cam = Camera::new(DEFAULT_CAMERA, 1600.0, 1200.0);
        assert!(screen_rect(&cam, &[[0.0, 1.0, 3.0]]).is_none());
        let r = screen_rect(&cam, &[[0.0, 1.0, 3.0], [0.0, 0.0, -3.0]]);
        assert!(r.is_some_and(|r| r.w == 0.0 && r.h == 0.0 && (r.x - 800.0).abs() < 1e-9));
        let c2 = Camera::new(
            CameraBlock {
                roll_deg: 3.0,
                ..DEFAULT_CAMERA
            },
            1600.0,
            1200.0,
        );
        assert!(screen_rect(&c2, &[]).is_none());
    }

    #[test]
    fn rotate_by_wraps_and_rounds() {
        assert_eq!(rotate_by(170.0, 15.0), -175.0);
        assert_eq!(rotate_by(-90.0, 270.0), 180.0);
        assert_eq!(clamp_elevation(5.0), 4.0);
        assert_eq!(clamp_elevation(-1.0), 0.0);
    }
}
