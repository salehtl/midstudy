//! The camera model of contract §4.1: the camera block, its clamps, and the maps between the world (meters, Y-up,
//! the floor is y = 0, the camera at (0, `height_m`, 0) looking along −Z) and photo pixels (continuous, (0, 0) at the
//! top-left corner of the top-left pixel, x right, y down).
//!
//! ```text
//! R    = Ry(0) · Rx(pitch) · Rz(roll)        camera-to-world (three.js Euler order 'YXZ')
//! p_c  = Rᵀ · (p − (0, height_m, 0))         x right, y up, looking along −z
//! d    = −p_c.z                              depth along the view axis, > 0 in front
//! f    = (H / 2) / tan(fov_y / 2)
//! px   = W / 2 + f · p_c.x / d               py = H / 2 − f · p_c.y / d
//! ```

use crate::jsmath::{DEG, js_clamp, round_to};
use crate::mat::{M3, V3, mul, mul_t, normalize, scale};

/// The camera block (contract §4.1), the same object in every file and API.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CameraBlock {
    /// Vertical field of view, degrees.
    pub fov_y_deg: f64,
    /// Camera height above the floor, meters.
    pub height_m: f64,
    /// Pitch, degrees; negative looks down.
    pub pitch_deg: f64,
    /// Roll, degrees; positive turns the camera counterclockwise as seen from behind it.
    pub roll_deg: f64,
}

/// `fov_y_deg` range (every writer clamps).
pub const FOV_RANGE: (f64, f64) = (20.0, 110.0);
/// `height_m` range.
pub const HEIGHT_RANGE: (f64, f64) = (0.2, 3.0);
/// `pitch_deg` range.
pub const PITCH_RANGE: (f64, f64) = (-80.0, 30.0);
/// `roll_deg` range.
pub const ROLL_RANGE: (f64, f64) = (-20.0, 20.0);

/// The default camera (no calibration): `{55, 1.40, −10, 0}`.
pub const DEFAULT_CAMERA: CameraBlock = CameraBlock {
    fov_y_deg: 55.0,
    height_m: 1.4,
    pitch_deg: -10.0,
    roll_deg: 0.0,
};

impl CameraBlock {
    /// The fields in the block's order (`fov_y_deg`, `height_m`, `pitch_deg`, `roll_deg`).
    #[must_use]
    pub fn to_array(&self) -> [f64; 4] {
        [self.fov_y_deg, self.height_m, self.pitch_deg, self.roll_deg]
    }

    /// A block from its fields in order.
    #[must_use]
    pub fn from_array(a: [f64; 4]) -> Self {
        Self {
            fov_y_deg: a[0],
            height_m: a[1],
            pitch_deg: a[2],
            roll_deg: a[3],
        }
    }

    /// v1's `clampCamera(c, base)`: every field clamped to its range and rounded to 6 decimals
    /// (`Math.round(v · 1e6) / 1e6`). A field that isn't a finite number (JS's `isNum`) takes `base`'s value,
    /// which is rounded but not clamped, exactly as v1 does. Idempotent: `c.clamped(b).clamped(x) == c.clamped(b)`.
    #[must_use]
    pub fn clamped(&self, base: &CameraBlock) -> CameraBlock {
        let ranges = [FOV_RANGE, HEIGHT_RANGE, PITCH_RANGE, ROLL_RANGE];
        let c = self.to_array();
        let b = base.to_array();
        let mut out = [0.0; 4];
        for (((o, &v), &d), &(lo, hi)) in out
            .iter_mut()
            .zip(c.iter())
            .zip(b.iter())
            .zip(ranges.iter())
        {
            *o = round_to(
                if v.is_finite() {
                    js_clamp(v, lo, hi)
                } else {
                    d
                },
                6,
            );
        }
        CameraBlock::from_array(out)
    }

    /// v1's `sameCamera`: every field within 1e-6.
    #[must_use]
    pub fn same_as(&self, other: &CameraBlock) -> bool {
        self.to_array()
            .iter()
            .zip(other.to_array().iter())
            .all(|(a, b)| (a - b).abs() < 1e-6)
    }
}

/// A ray: `origin + t · dir`, `dir` a unit vector.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Ray {
    /// The camera position (0, `height_m`, 0).
    pub origin: V3,
    /// Unit direction, world frame.
    pub dir: V3,
}

/// The scene camera on a W × H photo: the camera block with its focal length and rotation precomputed.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Camera {
    block: CameraBlock,
    w: f64,
    h: f64,
    f: f64,
    r: M3,
    sin_roll: f64,
    cos_roll: f64,
    tan_pitch: f64,
}

impl Camera {
    /// The camera of `block` on a `w` × `h` photo (photo pixels). The block is used as given (clamp it first with
    /// [`CameraBlock::clamped`] where v1 does).
    #[must_use]
    pub fn new(block: CameraBlock, w: f64, h: f64) -> Self {
        let pitch = block.pitch_deg * DEG;
        let roll = block.roll_deg * DEG;
        let (sp, cp) = (pitch.sin(), pitch.cos());
        let (sr, cr) = (roll.sin(), roll.cos());
        // Rx(pitch) · Rz(roll), multiplied out.
        let r = [
            [cr, -sr, 0.0],
            [cp * sr, cp * cr, -sp],
            [sp * sr, sp * cr, cp],
        ];
        let f = (h / 2.0) / ((block.fov_y_deg * DEG) / 2.0).tan();
        Self {
            block,
            w,
            h,
            f,
            r,
            sin_roll: sr,
            cos_roll: cr,
            tan_pitch: pitch.tan(),
        }
    }

    /// The camera block.
    #[must_use]
    pub fn block(&self) -> CameraBlock {
        self.block
    }

    /// The photo size (W, H) in pixels.
    #[must_use]
    pub fn size(&self) -> (f64, f64) {
        (self.w, self.h)
    }

    /// The focal length in photo pixels, `(H / 2) / tan(fov_y / 2)`.
    #[must_use]
    pub fn focal(&self) -> f64 {
        self.f
    }

    /// The camera-to-world rotation R = Rx(pitch) · Rz(roll).
    #[must_use]
    pub fn rotation(&self) -> M3 {
        self.r
    }

    /// The camera position (0, `height_m`, 0).
    #[must_use]
    pub fn eye(&self) -> V3 {
        [0.0, self.block.height_m, 0.0]
    }

    /// A world point in camera coordinates, `Rᵀ · (p − C)`.
    #[must_use]
    pub fn to_camera(&self, p: V3) -> V3 {
        mul_t(&self.r, [p[0], p[1] - self.block.height_m, p[2]])
    }

    /// v1's `projectPhoto`: a world point to `[px, py, d]`, d the depth along the view axis (> 0 in front). Points
    /// at d = 0 give infinities or NaN, as in v1.
    #[must_use]
    pub fn project(&self, p: V3) -> [f64; 3] {
        let c = self.to_camera(p);
        let d = -c[2];
        [
            self.w / 2.0 + (self.f * c[0]) / d,
            self.h / 2.0 - (self.f * c[1]) / d,
            d,
        ]
    }

    /// v1's `floorToPhoto` (any point, despite the name): the first two of [`Camera::project`].
    #[must_use]
    pub fn floor_to_photo(&self, p: V3) -> [f64; 2] {
        let q = self.project(p);
        [q[0], q[1]]
    }

    /// The world direction of the ray through photo pixel (px, py), not normalised: `R · ((px − W/2)/f,
    /// −(py − H/2)/f, −1)`.
    #[must_use]
    pub fn ray_dir(&self, px: f64, py: f64) -> V3 {
        mul(
            &self.r,
            [
                (px - self.w / 2.0) / self.f,
                -(py - self.h / 2.0) / self.f,
                -1.0,
            ],
        )
    }

    /// v1's `photoRay`: the ray from the camera through photo pixel (px, py), its direction normalised.
    #[must_use]
    pub fn ray(&self, px: f64, py: f64) -> Ray {
        Ray {
            origin: self.eye(),
            dir: normalize(self.ray_dir(px, py)),
        }
    }

    /// v1's `photoToFloor` (contract §4.1 inverse): the floor point `[x, 0, z]` under photo pixel (px, py), or
    /// `None` at or above the horizon. v1 (kept) treats a ray whose unit direction has y ≥ −1e-9 as not reaching the
    /// floor (the contract says y ≥ 0; the band between is floor points more than 1e9 · `height_m` away), and
    /// non-finite pixels as `None`.
    #[must_use]
    pub fn photo_to_floor(&self, px: f64, py: f64) -> Option<V3> {
        if !px.is_finite() || !py.is_finite() {
            return None;
        }
        let ray = self.ray(px, py);
        if ray.dir[1] >= -1e-9 {
            return None;
        }
        let t = -ray.origin[1] / ray.dir[1];
        Some([t * ray.dir[0], 0.0, t * ray.dir[2]])
    }

    /// v1's `horizonAt`: the photo row of the horizon (where the floor plane vanishes) at column px, or `None` when
    /// the horizon is vertical (|cos roll| < 1e-6; never within the roll range). Solves
    /// `sin(roll) · x_c + cos(roll) · y_c = −tan(pitch)` with `x_c = (px − W/2)/f`, `y_c = −(py − H/2)/f`.
    #[must_use]
    pub fn horizon_at(&self, px: f64) -> Option<f64> {
        if self.cos_roll.abs() < 1e-6 {
            return None;
        }
        let yc = (-self.tan_pitch - self.sin_roll * ((px - self.w / 2.0) / self.f)) / self.cos_roll;
        Some(self.h / 2.0 - yc * self.f)
    }

    /// v1's `setPitchFromHorizon` without the camera update: the pitch (degrees, not clamped) that puts the horizon at
    /// row py of the photo's centre column, `−atan(cos(roll) · y_c)` with `y_c = −(py − H/2)/f`. `None` for a
    /// non-finite py. Inverse of [`Camera::horizon_at`] at `W / 2` for |pitch| < 90°.
    #[must_use]
    pub fn pitch_from_horizon(&self, py: f64) -> Option<f64> {
        if !py.is_finite() {
            return None;
        }
        let yc = -(py - self.h / 2.0) / self.f;
        Some(-(self.cos_roll * yc).atan() / DEG)
    }
}

/// The finest tilt a horizon drag gives per CSS pixel (contract §4.5): on a small photo (the phone at Fit, about
/// 0.4° a pixel) the pitch moves at most this many degrees per CSS pixel of pointer motion.
pub const HORIZON_FINE_DEG_PER_PX: f64 = 0.12;

/// The horizon drag's gain (v1 planner/ui/workspace.js): 1 when the photo is shown large enough that the line can
/// follow the pointer, else the factor that caps the tilt at [`HORIZON_FINE_DEG_PER_PX`] per CSS pixel.
/// `rect_h_css` is the photo's on-screen height in CSS pixels.
#[must_use]
pub fn horizon_drag_gain(fov_y_deg: f64, rect_h_css: f64) -> f64 {
    use core::f64::consts::PI;
    // 1 / focal in degrees per CSS px, v1's expression and order.
    let deg_per_px =
        (360.0 / PI) * ((fov_y_deg * PI) / 360.0).tan() / crate::jsmath::js_max(1.0, rect_h_css);
    crate::jsmath::js_min(1.0, HORIZON_FINE_DEG_PER_PX / deg_per_px)
}

/// The photo row a horizon drag asks for (v1 workspace.js): the drag started with the horizon at row `py0`, the
/// pointer has moved `dy_css` CSS pixels, the photo is shown at `css_per_px` CSS pixels per photo pixel.
/// Feed the result to [`Camera::pitch_from_horizon`] (then clamp, as v1's `setCamera` does).
#[must_use]
pub fn horizon_drag_row(py0: f64, dy_css: f64, css_per_px: f64, gain: f64) -> f64 {
    py0 + (dy_css / css_per_px) * gain
}

/// v1's `depthScale` (contract §4.5): depth.png is metric in the calibration's frame, so with a measured floor
/// (`floor.found` and a `moge-2` or `truth` source: `measured`) it scales by `height_m / calib height_m`; otherwise,
/// or when the calibration's height isn't a positive number, by 1.
#[must_use]
pub fn depth_scale(height_m: f64, calib_height_m: f64, measured: bool) -> f64 {
    if measured && calib_height_m > 0.0 {
        height_m / calib_height_m
    } else {
        1.0
    }
}

/// The unit vector `R · d` normalised (v1: `new Vector3(...d).applyMatrix3(R).normalize()`), e.g. lighting.json's key
/// direction from the camera frame to the world frame.
#[must_use]
pub fn turn_to_world(r: &M3, d: V3) -> V3 {
    normalize(mul(r, d))
}

/// A world point at distance `t` along a ray.
#[must_use]
pub fn ray_at(ray: &Ray, t: f64) -> V3 {
    let s = scale(ray.dir, t);
    [
        ray.origin[0] + s[0],
        ray.origin[1] + s[1],
        ray.origin[2] + s[2],
    ]
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp)]
    use super::*;

    fn cam(fov: f64, h: f64, pitch: f64, roll: f64) -> Camera {
        Camera::new(
            CameraBlock {
                fov_y_deg: fov,
                height_m: h,
                pitch_deg: pitch,
                roll_deg: roll,
            },
            1600.0,
            1200.0,
        )
    }

    #[test]
    fn signs_are_the_contracts() {
        // Negative pitch looks down: the horizon is above the centre, at H/2 − f · tan(−pitch).
        let c = cam(55.0, 1.4, -10.0, 0.0);
        let hz = c.horizon_at(800.0).unwrap();
        assert!(hz < 600.0);
        assert!((hz - (600.0 - c.focal() * (10.0 * DEG).tan())).abs() < 1e-9);
        // Positive roll: the horizon falls to the right (its right end is lower, larger py).
        let c = cam(55.0, 1.4, -10.0, 5.0);
        assert!(c.horizon_at(1600.0).unwrap() > c.horizon_at(0.0).unwrap());
        // A point straight ahead on the view axis projects to the centre, in front (d > 0).
        let c = cam(55.0, 1.4, 0.0, 0.0);
        let p = c.project([0.0, 1.4, -3.0]);
        assert_eq!(p, [800.0, 600.0, 3.0]);
        // Up in the world is up in the photo (smaller py) with no roll, for points ahead of the camera's foot (z < 0).
        assert!(c.project([0.0, 2.0, -3.0])[1] < 600.0);
        // Looking steeply down, a point in front but behind the foot (z > 0) moves *down* the photo when raised
        // (LEAN.md 7 as corrected by the proofs track: Δpy = f·δ·z / (d·d')).
        let steep = cam(55.0, 1.4, -80.0, 0.0);
        let (low, high) = (
            steep.project([0.0, 0.0, 0.2]),
            steep.project([0.0, 0.5, 0.2]),
        );
        assert!(low[2] > 0.0 && high[2] > 0.0 && high[1] > low[1]);
        // +X is to the right.
        assert!(c.project([1.0, 1.4, -3.0])[0] > 800.0);
    }

    #[test]
    fn floor_round_trip() {
        let c = cam(65.0, 1.6, -25.0, 2.0);
        let p = c.photo_to_floor(700.0, 900.0).unwrap();
        assert_eq!(p[1], 0.0);
        let q = c.floor_to_photo(p);
        assert!((q[0] - 700.0).abs() < 1e-9 && (q[1] - 900.0).abs() < 1e-9);
        assert!(c.photo_to_floor(800.0, 0.0).is_none());
        assert!(c.photo_to_floor(f64::NAN, 900.0).is_none());
    }

    #[test]
    fn horizon_and_pitch_invert() {
        let c = cam(70.0, 1.25, -8.0, -1.0);
        let row = c.horizon_at(800.0).unwrap();
        assert!((c.pitch_from_horizon(row).unwrap() + 8.0).abs() < 1e-12);
    }

    #[test]
    fn clamps_like_v1() {
        let base = DEFAULT_CAMERA;
        let c = CameraBlock {
            fov_y_deg: 200.0,
            height_m: f64::NAN,
            pitch_deg: -10.123_456_78,
            roll_deg: -25.0,
        };
        let k = c.clamped(&base);
        assert_eq!(
            k,
            CameraBlock {
                fov_y_deg: 110.0,
                height_m: 1.4,
                pitch_deg: -10.123_457,
                roll_deg: -20.0
            }
        );
        assert_eq!(k.clamped(&base), k);
        assert!(k.same_as(&CameraBlock {
            pitch_deg: -10.123_457_5,
            ..k
        }));
    }

    #[test]
    fn horizon_drag_gain_caps_small_photos() {
        // About 0.4° per CSS px on a phone-sized photo: the gain brings it to 0.12°.
        let g = horizon_drag_gain(55.0, 160.0);
        assert!(g < 1.0);
        let deg_per_px = (360.0 / core::f64::consts::PI) * (55.0_f64 / 2.0 * DEG).tan() / 160.0;
        assert!((g * deg_per_px - HORIZON_FINE_DEG_PER_PX).abs() < 1e-12);
        assert_eq!(horizon_drag_gain(55.0, 2000.0), 1.0);
    }

    #[test]
    fn depth_scale_needs_a_measured_floor() {
        assert_eq!(depth_scale(1.5, 1.2, true), 1.25);
        assert_eq!(depth_scale(1.5, 1.2, false), 1.0);
        assert_eq!(depth_scale(1.5, f64::NAN, true), 1.0);
        assert_eq!(depth_scale(1.5, 0.0, true), 1.0);
    }
}
