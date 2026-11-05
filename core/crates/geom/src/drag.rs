//! Picking and dragging on planes (v1 planner/engine.js `planePointAt`, `dragHeight`, `beginItemDrag`,
//! `beginRotateDrag`, `dragTo`), with three.js's `Ray.intersectPlane` semantics.
//!
//! A move drag keeps the grabbed point under the pointer: the piece slides on the horizontal plane through that point
//! ([`drag_height`]), offset by `position − hit` ([`drag_offset`]). A lift drag (Shift) moves it on the vertical plane
//! through it that faces the camera ([`lift_plane`]). A rotate drag turns it by the change of the pointer's angle
//! around it on the horizontal plane at its elevation ([`grip_angle`], [`drag_rotate`]).

use crate::camera::{Camera, Ray, ray_at};
use crate::item::clamp_elevation;
use crate::jsmath::{DEG, js_max, js_min, js_round, round_to, wrap_deg};
use crate::mat::{V3, dot, normalize, sub};
use crate::view::View;

/// v1 ignores plane hits this far from the camera or farther (meters).
pub const MAX_PICK_DISTANCE: f64 = 60.0;

/// A plane `normal · p + constant = 0` (three.js `Plane`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Plane {
    /// Unit normal.
    pub normal: V3,
    /// Signed offset: −(normal · any point on the plane).
    pub constant: f64,
}

impl Plane {
    /// The horizontal plane y = `y` (`new Plane(new Vector3(0, 1, 0), −y)`).
    #[must_use]
    pub fn horizontal(y: f64) -> Self {
        Self {
            normal: [0.0, 1.0, 0.0],
            constant: -y,
        }
    }

    /// `Plane.setFromNormalAndCoplanarPoint(normal, point)`.
    #[must_use]
    pub fn from_normal_and_point(normal: V3, point: V3) -> Self {
        Self {
            normal,
            constant: -dot(point, normal),
        }
    }

    /// `Plane.distanceToPoint`: signed distance (for a unit normal).
    #[must_use]
    pub fn distance_to_point(&self, p: V3) -> f64 {
        dot(self.normal, p) + self.constant
    }
}

/// three.js `Ray.intersectPlane`: the hit at `t ≥ 0`, the origin itself for a ray lying in the plane, else `None`
/// (parallel, behind, or NaN).
#[must_use]
#[allow(clippy::float_cmp)] // three.js tests these for exactly 0
pub fn intersect_plane(ray: &Ray, plane: &Plane) -> Option<V3> {
    let denominator = dot(plane.normal, ray.dir);
    let t = if denominator == 0.0 {
        if plane.distance_to_point(ray.origin) == 0.0 {
            0.0
        } else {
            return None;
        }
    } else {
        -(dot(ray.origin, plane.normal) + plane.constant) / denominator
    };
    if t >= 0.0 { Some(ray_at(ray, t)) } else { None }
}

/// v1's `planePointAt`: where the ray through photo pixel (px, py) meets `plane`, when that is closer than
/// [`MAX_PICK_DISTANCE`] to the camera.
#[must_use]
pub fn plane_point_at_photo(camera: &Camera, px: f64, py: f64, plane: &Plane) -> Option<V3> {
    let ray = camera.ray(px, py);
    let p = intersect_plane(&ray, plane)?;
    let d = sub(p, ray.origin);
    ((d[0] * d[0] + d[1] * d[1] + d[2] * d[2]).sqrt() < MAX_PICK_DISTANCE).then_some(p)
}

/// [`plane_point_at_photo`] for a client (CSS) point on a view.
#[must_use]
pub fn plane_point_at(camera: &Camera, view: &View, x: f64, y: f64, plane: &Plane) -> Option<V3> {
    let [px, py] = view.client_to_photo(x, y);
    plane_point_at_photo(camera, px, py, plane)
}

/// v1's `dragHeight`: the height of the horizontal plane a move drag slides on. The grabbed point's own height
/// (`grab_y`; the middle of the piece when it was grabbed beside it), within the piece's world bounds
/// (`min_y..=max_y`), and at least 15 cm from the eye height `eye` (where that plane is seen edge-on).
#[must_use]
#[allow(clippy::manual_midpoint)] // v1's arithmetic, `(min + max) / 2`
pub fn drag_height(grab_y: Option<f64>, min_y: f64, max_y: f64, eye: f64) -> f64 {
    let mut y = grab_y.unwrap_or((min_y + max_y) / 2.0);
    y = js_max(min_y, js_min(max_y, y));
    if (y - eye).abs() < 0.15 {
        y = if eye - 0.15 >= min_y {
            eye - 0.15
        } else {
            js_min(max_y, eye + 0.15)
        };
    }
    y
}

/// v1's lift plane: vertical, through the item's position, facing the camera (normal `(−x, 0, −z)` normalised, or
/// +Z when the item stands at the camera's foot).
#[must_use]
pub fn lift_plane(position: V3) -> Plane {
    let n = [-position[0], 0.0, -position[2]];
    let n = if n[0] * n[0] + n[1] * n[1] + n[2] * n[2] < 1e-6 {
        [0.0, 0.0, 1.0]
    } else {
        n
    };
    Plane::from_normal_and_point(normalize(n), position)
}

/// The offset a drag keeps: `position − hit` (three.js `position.clone().sub(p)`).
#[must_use]
pub fn drag_offset(position: V3, hit: V3) -> V3 {
    sub(position, hit)
}

/// A move drag's new (x, z): `round(hit + offset, 6)` (the elevation doesn't change).
#[must_use]
pub fn drag_move(hit: V3, offset: V3) -> [f64; 2] {
    [
        round_to(hit[0] + offset[0], 6),
        round_to(hit[2] + offset[2], 6),
    ]
}

/// A lift drag's new elevation: `hit.y + offset.y` within 0..=4 m, on whole centimeters with `snap`, rounded to 6
/// decimals.
#[must_use]
pub fn drag_lift(hit_y: f64, offset_y: f64, snap: bool) -> f64 {
    let mut y = clamp_elevation(hit_y + offset_y);
    if snap {
        y = js_round(y / 0.01) * 0.01;
    }
    round_to(y, 6)
}

/// The pointer's angle around a piece on its horizontal plane: `atan2(p.x − c.x, p.z − c.z)` (radians).
#[must_use]
pub fn grip_angle(hit: V3, center: V3) -> f64 {
    (hit[0] - center[0]).atan2(hit[2] - center[2])
}

/// A rotate drag's new `rotation_y_deg`: the start rotation plus the pointer's turn since the drag began, on 15°
/// steps with `snap`, wrapped to (−180, 180] and rounded to 6 decimals.
#[must_use]
pub fn drag_rotate(rot0_deg: f64, angle: f64, angle0: f64, snap: bool) -> f64 {
    let mut deg = rot0_deg + (angle - angle0) / DEG;
    if snap {
        deg = js_round(deg / 15.0) * 15.0;
    }
    round_to(wrap_deg(deg), 6)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp)]
    use super::*;
    use crate::camera::DEFAULT_CAMERA;

    #[test]
    fn floor_hits_and_caps() {
        let cam = Camera::new(DEFAULT_CAMERA, 1600.0, 1200.0);
        let p = plane_point_at_photo(&cam, 800.0, 1000.0, &Plane::horizontal(0.0)).unwrap();
        let q = cam.photo_to_floor(800.0, 1000.0).unwrap();
        assert!((p[0] - q[0]).abs() < 1e-12 && p[1].abs() < 1e-12 && (p[2] - q[2]).abs() < 1e-9);
        // Just below the horizon the floor is beyond 60 m: no hit.
        let hz = cam.horizon_at(800.0).unwrap();
        assert!(plane_point_at_photo(&cam, 800.0, hz + 0.5, &Plane::horizontal(0.0)).is_none());
        // Above the horizon the floor is behind the ray.
        assert!(plane_point_at_photo(&cam, 800.0, hz - 10.0, &Plane::horizontal(0.0)).is_none());
    }

    #[test]
    fn drag_height_avoids_the_eye() {
        assert_eq!(drag_height(Some(0.4), 0.0, 0.8, 1.4), 0.4);
        assert_eq!(drag_height(None, 0.0, 0.8, 1.4), 0.4);
        assert_eq!(drag_height(Some(2.0), 0.0, 0.8, 1.4), 0.8);
        assert!((drag_height(Some(1.35), 0.0, 2.0, 1.4) - 1.25).abs() < 1e-15);
        assert!((drag_height(Some(1.35), 1.3, 2.0, 1.4) - 1.55).abs() < 1e-15);
    }

    #[test]
    fn rotate_and_lift_steps() {
        assert_eq!(
            drag_rotate(10.0, 0.5, 0.0, false),
            round_to(10.0 + 0.5 / DEG, 6)
        );
        assert_eq!(drag_rotate(170.0, 20.0 * DEG, 0.0, false), -170.0);
        assert_eq!(drag_rotate(0.0, 8.0 * DEG, 0.0, true), 15.0);
        assert_eq!(drag_lift(0.123_456, 0.0, true), 0.12);
        assert_eq!(drag_lift(9.0, 0.0, false), 4.0);
        let pl = lift_plane([0.0, 0.0, 0.0]);
        assert_eq!(pl.normal, [0.0, 0.0, 1.0]);
        let pl = lift_plane([3.0, 0.5, -4.0]);
        assert!((pl.distance_to_point([3.0, 2.0, -4.0])).abs() < 1e-12);
    }
}
