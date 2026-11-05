//! The planner's WebAssembly build of `midstudy-geom` and `midstudy-raster` (wasm-bindgen 0.2.121, `--target web`;
//! the typed face is `core/js/web.ts`).
//!
//! Conventions across the boundary:
//! - Numbers are f64; points and vectors are flat `[x, y, z]`; matrices are three.js `Matrix3.elements` (column-major,
//!   9 numbers); SH are 27 numbers, coefficient by coefficient (`[L00 r, L00 g, L00 b, L1−1 r, …]`).
//! - The [`Camera`] reads the inputs of its item calls from, and writes its results into, its own scratch
//!   (`outPtr()`, 32 f64) that the TS face fills and reads through a `Float64Array` view: no allocation per call. Buffers ([`F64Buf`] and the result types) expose `ptr()`/`len()` so
//!   the face can view them in place (zero-copy) and copy only what it keeps or transfers.
//! - Nothing panics across the boundary: lengths are checked and bad input is a thrown `Error` (`JsError`) or `undefined`.
//!
//! The geometry is exactly the crates' (see their docs and `crates/geom/LEAN.md`); this file only adapts the shapes.

#![allow(clippy::many_single_char_names)]

use midstudy_geom::camera::{self, CameraBlock};
use midstudy_geom::drag::{self, Plane};
use midstudy_geom::floor;
use midstudy_geom::hull;
use midstudy_geom::item::{self, LocalBox, Pose, Rect};
use midstudy_geom::jsmath;
use midstudy_geom::look::{self, LookNumber};
use midstudy_geom::mat::{M3, V3, from_column_major, to_column_major};
use midstudy_geom::view::View;
use midstudy_raster::depth;
use midstudy_raster::envmap::{self, EnvFilter, EnvSpec, Rgba8};
use midstudy_raster::mask;
use midstudy_raster::sh::{self, Sh9};
use wasm_bindgen::prelude::*;

/// The scratch size of a [`Camera`], in f64.
pub const SCRATCH: usize = 32;

fn err(e: impl core::fmt::Display) -> JsError {
    JsError::new(&e.to_string())
}

fn v3(s: &[f64], at: usize) -> V3 {
    [
        s.get(at).copied().unwrap_or(f64::NAN),
        s.get(at + 1).copied().unwrap_or(f64::NAN),
        s.get(at + 2).copied().unwrap_or(f64::NAN),
    ]
}

fn m3(e: &[f64]) -> Result<M3, JsError> {
    let a: &[f64; 9] = e
        .try_into()
        .map_err(|_| JsError::new("a matrix is 9 numbers (Matrix3.elements)"))?;
    Ok(from_column_major(a))
}

fn sh9(s: &[f64]) -> Result<Sh9, JsError> {
    if s.len() != 27 {
        return Err(JsError::new("an SH is 27 numbers (9 coefficients × RGB)"));
    }
    let mut out = [[0.0; 3]; 9];
    for (o, c) in out.iter_mut().zip(s.chunks_exact(3)) {
        o.copy_from_slice(c);
    }
    Ok(out)
}

fn flat_sh(sh: &Sh9) -> Vec<f64> {
    sh.iter().flatten().copied().collect()
}

// --- buffers --------------------------------------------------------------------------------------------------------

/// An f64 buffer in wasm memory the face fills and reads in place (`ptr()` is a byte offset into `memory`).
#[wasm_bindgen]
#[derive(Debug)]
pub struct F64Buf {
    data: Vec<f64>,
}

#[wasm_bindgen]
impl F64Buf {
    /// A buffer of `len` zeros.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(len: usize) -> F64Buf {
        F64Buf {
            data: vec![0.0; len],
        }
    }
    /// Byte offset of the first element.
    #[must_use]
    pub fn ptr(&self) -> usize {
        self.data.as_ptr() as usize
    }
    /// Number of elements.
    #[must_use]
    pub fn len(&self) -> usize {
        self.data.len()
    }
    /// Whether it holds nothing.
    #[wasm_bindgen(js_name = isEmpty)]
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

// --- the camera -----------------------------------------------------------------------------------------------------

/// The scene camera on a W × H photo (contract §4.1). Results land in its scratch (`outPtr()`).
#[wasm_bindgen]
#[derive(Debug)]
pub struct Camera {
    cam: camera::Camera,
    out: [f64; SCRATCH],
}

#[wasm_bindgen]
impl Camera {
    /// The camera block as given (clamp it first with `clampCamera` where v1 does) on a `w` × `h` photo.
    #[wasm_bindgen(constructor)]
    #[must_use]
    pub fn new(
        fov_y_deg: f64,
        height_m: f64,
        pitch_deg: f64,
        roll_deg: f64,
        w: f64,
        h: f64,
    ) -> Camera {
        let block = CameraBlock {
            fov_y_deg,
            height_m,
            pitch_deg,
            roll_deg,
        };
        Camera {
            cam: camera::Camera::new(block, w, h),
            out: [0.0; SCRATCH],
        }
    }

    /// Byte offset of the scratch (32 f64).
    #[wasm_bindgen(js_name = outPtr)]
    #[must_use]
    pub fn out_ptr(&self) -> usize {
        self.out.as_ptr() as usize
    }

    /// The focal length in photo pixels.
    #[must_use]
    pub fn focal(&self) -> f64 {
        self.cam.focal()
    }

    /// Scratch[0..9] = R (camera-to-world) as `Matrix3.elements`.
    pub fn rotation(&mut self) {
        self.put(&to_column_major(&self.cam.rotation()));
    }

    fn put(&mut self, v: &[f64]) {
        for (o, x) in self.out.iter_mut().zip(v) {
            *o = *x;
        }
    }

    /// Scratch[0..3] = `[px, py, d]` of world point (x, y, z) (`projectPhoto`).
    pub fn project(&mut self, x: f64, y: f64, z: f64) {
        let p = self.cam.project([x, y, z]);
        self.put(&p);
    }

    /// Projects `points` (x, y, z triples) into `out` (px, py, d triples). Throws when the lengths don't match.
    ///
    /// # Errors
    /// When `points` isn't triples or `out` isn't as long.
    #[wasm_bindgen(js_name = projectMany)]
    pub fn project_many(&self, points: &F64Buf, out: &mut F64Buf) -> Result<(), JsError> {
        if !points.data.len().is_multiple_of(3) || out.data.len() != points.data.len() {
            return Err(JsError::new(
                "projectMany: points are xyz triples and out is as long",
            ));
        }
        for (p, o) in points
            .data
            .chunks_exact(3)
            .zip(out.data.chunks_exact_mut(3))
        {
            o.copy_from_slice(&self.cam.project([p[0], p[1], p[2]]));
        }
        Ok(())
    }

    /// Scratch[0..3] = the floor point under photo pixel (px, py); false at or above the horizon (`photoToFloor`).
    #[wasm_bindgen(js_name = photoToFloor)]
    pub fn photo_to_floor(&mut self, px: f64, py: f64) -> bool {
        match self.cam.photo_to_floor(px, py) {
            Some(p) => {
                self.put(&p);
                true
            }
            None => false,
        }
    }

    /// Scratch[0..6] = origin and unit direction of the ray through photo pixel (px, py) (`photoRay`).
    pub fn ray(&mut self, px: f64, py: f64) {
        let r = self.cam.ray(px, py);
        self.put(&[
            r.origin[0],
            r.origin[1],
            r.origin[2],
            r.dir[0],
            r.dir[1],
            r.dir[2],
        ]);
    }

    /// The horizon's row at photo column px, or `undefined` when it is vertical (`horizonAt`).
    #[wasm_bindgen(js_name = horizonAt)]
    #[must_use]
    pub fn horizon_at(&self, px: f64) -> Option<f64> {
        self.cam.horizon_at(px)
    }

    /// The pitch (degrees, unclamped) that puts the horizon at row py of the centre column, or `undefined` for a
    /// non-finite py (`setPitchFromHorizon` without the camera update).
    #[wasm_bindgen(js_name = pitchFromHorizon)]
    #[must_use]
    pub fn pitch_from_horizon(&self, py: f64) -> Option<f64> {
        self.cam.pitch_from_horizon(py)
    }

    /// The item's projected rect `{x, y, w, h}` in photo px into scratch[0..4]; false when no corner is in front
    /// (`getScreenRect`). The item is read from scratch[0..10]: position (3), `rotation_y_deg`, local box min (3),
    /// max (3).
    #[wasm_bindgen(js_name = screenRect)]
    pub fn screen_rect(&mut self) -> bool {
        let corners = self.item_corners();
        match item::screen_rect(&self.cam, &corners) {
            Some(r) => {
                self.put(&[r.x, r.y, r.w, r.h]);
                true
            }
            None => false,
        }
    }

    fn item_corners(&self) -> [V3; 8] {
        let s = &self.out;
        corners_of(&s[0..4], &s[4..7], &s[7..10])
    }

    /// v1's `hitItemAt` on screen: the item (scratch[0..10], as [`Camera::screen_rect`]) projected to client px on the
    /// view in scratch[10..13] (`s, ox, oy`), its corners' hull, and (x, y) inside it or within `pad`. 1 hit, 0 miss,
    /// −1 when a corner is behind the camera (v1 then raycasts the mesh instead).
    #[wasm_bindgen(js_name = hitBox)]
    #[must_use]
    pub fn hit_box(&self, x: f64, y: f64, pad: f64) -> i32 {
        let v = view_of(&self.out[10..13]);
        let mut pts = [[0.0; 2]; 8];
        for (p, c) in pts.iter_mut().zip(self.item_corners()) {
            let q = self.cam.project(c);
            if q[2] <= item::IN_FRONT_D {
                return -1;
            }
            *p = v.photo_to_client(q[0], q[1]);
        }
        hull::SmallHull::new(&pts).map_or(0, |h| i32::from(h.hit(x, y, pad)))
    }

    /// Scratch[0..3] = where a new piece lands (`landingSpot`): the visible photo rect `[x, y, w, h]` in client px on
    /// `view` (`[s, ox, oy]`), and the (x, z) of the pieces already placed.
    #[wasm_bindgen(js_name = landingSpot)]
    pub fn landing_spot(&mut self, view: &[f64], visible: &[f64], taken_xz: &[f64]) {
        let rect = Rect {
            x: visible.first().copied().unwrap_or(0.0),
            y: visible.get(1).copied().unwrap_or(0.0),
            w: visible.get(2).copied().unwrap_or(0.0),
            h: visible.get(3).copied().unwrap_or(0.0),
        };
        let taken: Vec<[f64; 2]> = taken_xz.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
        let p = floor::landing_spot(&self.cam, &view_of(view), &rect, &taken);
        self.put(&p);
    }

    /// Scratch[0..3] = where the ray through photo pixel (px, py) meets the plane `n · p + c = 0`, if closer than
    /// 60 m (`planePointAt`).
    #[wasm_bindgen(js_name = planePointAt)]
    pub fn plane_point_at(&mut self, px: f64, py: f64, nx: f64, ny: f64, nz: f64, c: f64) -> bool {
        let plane = Plane {
            normal: [nx, ny, nz],
            constant: c,
        };
        match drag::plane_point_at_photo(&self.cam, px, py, &plane) {
            Some(p) => {
                self.put(&p);
                true
            }
            None => false,
        }
    }
}

fn view_of(v: &[f64]) -> View {
    View {
        s: v.first().copied().unwrap_or(1.0),
        ox: v.get(1).copied().unwrap_or(0.0),
        oy: v.get(2).copied().unwrap_or(0.0),
    }
}

fn pose_of(pose: &[f64]) -> Pose {
    Pose {
        position: v3(pose, 0),
        rotation_y_deg: pose.get(3).copied().unwrap_or(f64::NAN),
    }
}

fn corners_of(pose: &[f64], min: &[f64], max: &[f64]) -> [V3; 8] {
    item::box_corners(
        &pose_of(pose).transform(),
        &LocalBox {
            min: v3(min, 0),
            max: v3(max, 0),
        },
    )
}

// --- clamps and small maths ----------------------------------------------------------------------------------------

/// v1's `clampCamera(c, base)`: `[fov, height, pitch, roll]`, non-finite fields taking `base`'s.
#[wasm_bindgen(js_name = clampCamera)]
#[must_use]
pub fn clamp_camera(c: &[f64], base: &[f64]) -> Vec<f64> {
    let block = |s: &[f64]| {
        CameraBlock::from_array([0, 1, 2, 3].map(|i| s.get(i).copied().unwrap_or(f64::NAN)))
    };
    block(c).clamped(&block(base)).to_array().to_vec()
}

/// v1's `wrapDeg`.
#[wasm_bindgen(js_name = wrapDeg)]
#[must_use]
pub fn wrap_deg(d: f64) -> f64 {
    jsmath::wrap_deg(d)
}

/// v1's `wrapAz`.
#[wasm_bindgen(js_name = wrapAz)]
#[must_use]
pub fn wrap_az(a: f64) -> f64 {
    jsmath::wrap_az(a)
}

/// v1's `round(v, n)`.
#[wasm_bindgen(js_name = roundTo)]
#[must_use]
pub fn round_to(v: f64, n: usize) -> f64 {
    jsmath::round_to(v, n)
}

/// One Look value clamped (`key` in v1's `LOOK_NUM` order: `exposure`, `warmth`, `light_azimuth_deg`,
/// `light_elevation_deg`, `light_softness`, `light_strength`, `ambient`); `undefined` means the inferred default.
#[wasm_bindgen(js_name = clampLook)]
#[must_use]
pub fn clamp_look(key: usize, v: f64) -> Option<f64> {
    LookNumber::ALL.get(key).and_then(|k| k.clamp(v))
}

/// v1's `clampElev`.
#[wasm_bindgen(js_name = clampElevation)]
#[must_use]
pub fn clamp_elevation(y: f64) -> f64 {
    item::clamp_elevation(y)
}

/// v1's `rotateSelected` step: `round(wrapDeg(rot + deg), 6)`.
#[wasm_bindgen(js_name = rotateBy)]
#[must_use]
pub fn rotate_by(rotation_y_deg: f64, deg: f64) -> f64 {
    item::rotate_by(rotation_y_deg, deg)
}

/// v1's `depthScale`.
#[wasm_bindgen(js_name = depthScale)]
#[must_use]
pub fn depth_scale(height_m: f64, calib_height_m: f64, measured: bool) -> f64 {
    camera::depth_scale(height_m, calib_height_m, measured)
}

/// The horizon drag's gain (the 0.12°/CSS px cap).
#[wasm_bindgen(js_name = horizonDragGain)]
#[must_use]
pub fn horizon_drag_gain(fov_y_deg: f64, rect_h_css: f64) -> f64 {
    camera::horizon_drag_gain(fov_y_deg, rect_h_css)
}

/// The photo row a horizon drag asks for.
#[wasm_bindgen(js_name = horizonDragRow)]
#[must_use]
pub fn horizon_drag_row(py0: f64, dy_css: f64, css_per_px: f64, gain: f64) -> f64 {
    camera::horizon_drag_row(py0, dy_css, css_per_px, gain)
}

// --- items, hulls, drags ---------------------------------------------------------------------------------------------

/// The 8 world corners (24 numbers, v1's order) of an item: `pose` `[x, y, z, rotation_y_deg]`, local box.
#[wasm_bindgen(js_name = boxCorners)]
#[must_use]
pub fn box_corners(pose: &[f64], min: &[f64], max: &[f64]) -> Vec<f64> {
    corners_of(pose, min, max)
        .iter()
        .flatten()
        .copied()
        .collect()
}

/// v1's `worldBounds`: `[min x, y, z, max x, y, z]`.
#[wasm_bindgen(js_name = worldBounds)]
#[must_use]
pub fn world_bounds(pose: &[f64], min: &[f64], max: &[f64]) -> Vec<f64> {
    let (lo, hi) = item::world_bounds(
        &pose_of(pose).transform(),
        &LocalBox {
            min: v3(min, 0),
            max: v3(max, 0),
        },
    );
    [lo, hi].iter().flatten().copied().collect()
}

/// v1's `getFootprint` without the box: 4 corners (front-left, front-right, back-right, back-left), the centre, the
/// height (16 numbers).
#[wasm_bindgen]
#[must_use]
pub fn footprint(pose: &[f64], min: &[f64], max: &[f64]) -> Vec<f64> {
    let f = item::footprint(
        &pose_of(pose).transform(),
        &LocalBox {
            min: v3(min, 0),
            max: v3(max, 0),
        },
    );
    let mut out: Vec<f64> = f.corners.iter().flatten().copied().collect();
    out.extend_from_slice(&f.center);
    out.push(f.height);
    out
}

/// v1's `convexHull` of (x, y) pairs, as pairs.
#[wasm_bindgen(js_name = convexHull)]
#[must_use]
pub fn convex_hull(xy: &[f64]) -> Vec<f64> {
    let mut pts: Vec<[f64; 2]> = xy.chunks_exact(2).map(|c| [c[0], c[1]]).collect();
    let mut out = vec![[0.0; 2]; 2 * pts.len()];
    let n = hull::convex_hull(&mut pts, &mut out).unwrap_or(0);
    out.iter().take(n).flatten().copied().collect()
}

fn pairs(xy: &[f64]) -> Vec<[f64; 2]> {
    xy.chunks_exact(2).map(|c| [c[0], c[1]]).collect()
}

/// v1's `pointInHull` (hull as pairs).
#[wasm_bindgen(js_name = pointInHull)]
#[must_use]
pub fn point_in_hull(hull_xy: &[f64], x: f64, y: f64) -> bool {
    hull::point_in_hull(&pairs(hull_xy), x, y)
}

/// v1's `distToHull` (hull as pairs).
#[wasm_bindgen(js_name = distToHull)]
#[must_use]
pub fn dist_to_hull(hull_xy: &[f64], x: f64, y: f64) -> f64 {
    hull::dist_to_hull(&pairs(hull_xy), x, y)
}

/// v1's `dragHeight` (`grab_y` undefined when grabbed beside the piece).
#[wasm_bindgen(js_name = dragHeight)]
#[must_use]
pub fn drag_height(grab_y: Option<f64>, min_y: f64, max_y: f64, eye: f64) -> f64 {
    drag::drag_height(grab_y, min_y, max_y, eye)
}

/// v1's lift plane through `position`: `[nx, ny, nz, constant]`.
#[wasm_bindgen(js_name = liftPlane)]
#[must_use]
pub fn lift_plane(position: &[f64]) -> Vec<f64> {
    let p = drag::lift_plane(v3(position, 0));
    vec![p.normal[0], p.normal[1], p.normal[2], p.constant]
}

/// A move drag's new `[x, z]`.
#[wasm_bindgen(js_name = dragMove)]
#[must_use]
pub fn drag_move(hit: &[f64], offset: &[f64]) -> Vec<f64> {
    drag::drag_move(v3(hit, 0), v3(offset, 0)).to_vec()
}

/// A lift drag's new elevation.
#[wasm_bindgen(js_name = dragLift)]
#[must_use]
pub fn drag_lift(hit_y: f64, offset_y: f64, snap: bool) -> f64 {
    drag::drag_lift(hit_y, offset_y, snap)
}

/// The pointer's angle around a piece (radians).
#[wasm_bindgen(js_name = gripAngle)]
#[must_use]
pub fn grip_angle(hit: &[f64], center: &[f64]) -> f64 {
    drag::grip_angle(v3(hit, 0), v3(center, 0))
}

/// A rotate drag's new `rotation_y_deg`.
#[wasm_bindgen(js_name = dragRotate)]
#[must_use]
pub fn drag_rotate(rot0_deg: f64, angle: f64, angle0: f64, snap: bool) -> f64 {
    drag::drag_rotate(rot0_deg, angle, angle0, snap)
}

/// v1's ruler rescale: `[height_m, k, exact (1 or 0)]`, or empty when the lengths can't be used.
#[wasm_bindgen(js_name = rulerRescale)]
#[must_use]
pub fn ruler_rescale(height_m: f64, measured_m: f64, true_m: f64) -> Vec<f64> {
    floor::ruler_rescale(height_m, measured_m, true_m).map_or_else(Vec::new, |r| {
        vec![r.height_m, r.k, if r.exact { 1.0 } else { 0.0 }]
    })
}

// --- the light -------------------------------------------------------------------------------------------------------

/// v1's `azElOf`: `[azimuth_deg, elevation_deg]`.
#[wasm_bindgen(js_name = azElOf)]
#[must_use]
pub fn az_el_of(x: f64, y: f64, z: f64) -> Vec<f64> {
    let (a, e) = look::az_el_of([x, y, z]);
    vec![a, e]
}

/// v1's `dirOf`: a unit direction `[x, y, z]`.
#[wasm_bindgen(js_name = dirOf)]
#[must_use]
pub fn dir_of(az_deg: f64, el_deg: f64) -> Vec<f64> {
    look::dir_of(az_deg, el_deg).to_vec()
}

/// v1's `turnBetween(a, b)` as `Matrix3.elements`.
#[wasm_bindgen(js_name = turnBetween)]
#[must_use]
pub fn turn_between(a: &[f64], b: &[f64]) -> Vec<f64> {
    to_column_major(&look::turn_between(v3(a, 0), v3(b, 0))).to_vec()
}

/// The probe turned by `r` (`Matrix3.elements`, e.g. camera-to-world): band 1 exactly, band 2 refitted.
///
/// # Errors
/// When `sh` isn't 27 numbers or `r` isn't 9.
#[wasm_bindgen(js_name = rotateSh)]
pub fn rotate_sh(sh: &[f64], r: &[f64]) -> Result<Vec<f64>, JsError> {
    Ok(flat_sh(&sh::rotate_sh(&sh9(sh)?, &m3(r)?)))
}

/// v1's `irradianceAt(sh, d)`: `[r, g, b]`.
///
/// # Errors
/// When `sh` isn't 27 numbers.
#[wasm_bindgen(js_name = irradianceAt)]
pub fn irradiance_at(sh: &[f64], x: f64, y: f64, z: f64) -> Result<Vec<f64>, JsError> {
    Ok(sh::irradiance_at(&sh9(sh)?, [x, y, z]).to_vec())
}

/// v1's `scaleBands(sh, k)`.
///
/// # Errors
/// When `sh` isn't 27 numbers.
#[wasm_bindgen(js_name = scaleBands)]
pub fn scale_bands(sh: &[f64], k: f64) -> Result<Vec<f64>, JsError> {
    Ok(flat_sh(&sh::scale_bands(&sh9(sh)?, k)))
}

/// v1's `maxBandScale(sh)` (`Infinity` when unbounded).
///
/// # Errors
/// When `sh` isn't 27 numbers.
#[wasm_bindgen(js_name = maxBandScale)]
pub fn max_band_scale(sh: &[f64]) -> Result<f64, JsError> {
    Ok(sh::max_band_scale(&sh9(sh)?))
}

/// v1's `splatGain()`: `world_sh` empty for "no lighting.json" (the v1 lights); else the world-frame SH (27), the
/// key's colour and intensity, `white_balance.rgb`.
///
/// # Errors
/// When `world_sh` is neither empty nor 27 numbers.
#[wasm_bindgen(js_name = splatGain)]
pub fn splat_gain(
    world_sh: &[f64],
    key_color: &[f64],
    key_intensity: f64,
    white_balance: &[f64],
    ambient: f64,
    strength: f64,
) -> Result<Vec<f64>, JsError> {
    if world_sh.is_empty() {
        return Ok(sh::splat_gain(None, ambient, strength).to_vec());
    }
    let s = sh9(world_sh)?;
    let room = sh::RoomLight {
        world_sh: &s,
        key_color: v3(key_color, 0),
        key_intensity,
        white_balance: if white_balance.len() == 3 {
            v3(white_balance, 0)
        } else {
            [1.0; 3]
        },
    };
    Ok(sh::splat_gain(Some(&room), ambient, strength).to_vec())
}

/// The splat pass multiplier: `warmthTint(warmth) · exposure · gain`.
#[wasm_bindgen(js_name = splatMultiplier)]
#[must_use]
pub fn splat_multiplier(warmth: f64, exposure: f64, gain: &[f64]) -> Vec<f64> {
    sh::splat_multiplier(warmth, exposure, v3(gain, 0)).to_vec()
}

// --- the heavy kernels (the face runs these in a worker) ---------------------------------------------------------

/// depth.png decoded to metres.
#[wasm_bindgen]
#[derive(Debug)]
pub struct DepthResult {
    width: u32,
    height: u32,
    data: Vec<f32>,
}

#[wasm_bindgen]
impl DepthResult {
    /// Width.
    #[must_use]
    pub fn width(&self) -> u32 {
        self.width
    }
    /// Height.
    #[must_use]
    pub fn height(&self) -> u32 {
        self.height
    }
    /// Byte offset of the f32 metres.
    #[must_use]
    pub fn ptr(&self) -> usize {
        self.data.as_ptr() as usize
    }
    /// Number of f32.
    #[must_use]
    pub fn len(&self) -> usize {
        self.data.len()
    }
    /// Whether it holds nothing.
    #[wasm_bindgen(js_name = isEmpty)]
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.data.is_empty()
    }
}

/// Decodes depth.png (8- or 16-bit grayscale) to metres times `scale` (1: v1's values exactly).
///
/// # Errors
/// The decoder's message for anything that isn't such a PNG.
#[wasm_bindgen(js_name = decodeDepth)]
pub fn decode_depth(png: &[u8], scale: f64) -> Result<DepthResult, JsError> {
    let d = depth::decode_depth_m(png, scale).map_err(err)?;
    Ok(DepthResult {
        width: d.width,
        height: d.height,
        data: d.data,
    })
}

/// A keep-room mask: 0/1 per pixel, rows top to bottom, and its coverage.
#[wasm_bindgen]
#[derive(Debug)]
pub struct MaskResult {
    mask: Vec<u8>,
    coverage: f64,
}

#[wasm_bindgen]
impl MaskResult {
    /// The share of pixels set.
    #[must_use]
    pub fn coverage(&self) -> f64 {
        self.coverage
    }
    /// Byte offset of the mask.
    #[must_use]
    pub fn ptr(&self) -> usize {
        self.mask.as_ptr() as usize
    }
    /// Number of bytes.
    #[must_use]
    pub fn len(&self) -> usize {
        self.mask.len()
    }
    /// Whether it holds nothing.
    #[wasm_bindgen(js_name = isEmpty)]
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.mask.is_empty()
    }
    /// The mask as an 8-bit grayscale PNG, white on black (zlib `level` 0–10).
    ///
    /// # Errors
    /// Never for a mask this module made; a size error otherwise.
    #[wasm_bindgen(js_name = toPng)]
    pub fn to_png(&self, width: u32, height: u32, level: u8) -> Result<Vec<u8>, JsError> {
        mask::encode_mask_png(&self.mask, width, height, level).map_err(err)
    }
}

/// v1's keep-room mask from the mask render's RGBA readback (`bottom_up` for WebGL's row order).
///
/// # Errors
/// When the readback isn't `width · height · 4` bytes.
#[wasm_bindgen(js_name = keepRoomMask)]
pub fn keep_room_mask(
    rgba: &[u8],
    width: usize,
    height: usize,
    bottom_up: bool,
) -> Result<MaskResult, JsError> {
    let k = mask::keep_room_mask(rgba, width, height, bottom_up).map_err(err)?;
    Ok(MaskResult {
        mask: k.mask,
        coverage: k.coverage,
    })
}

/// v1's `dilate(src, w, h, left, right, up, down)` (0/1 out).
///
/// # Errors
/// When `src` isn't `width · height` bytes.
#[wasm_bindgen]
#[allow(clippy::too_many_arguments)]
pub fn dilate(
    src: &[u8],
    width: usize,
    height: usize,
    left: usize,
    right: usize,
    up: usize,
    down: usize,
) -> Result<Vec<u8>, JsError> {
    mask::dilate(
        src,
        width,
        height,
        mask::Reach {
            left,
            right,
            up,
            down,
        },
    )
    .map_err(err)
}

/// An environment map: RGBA, f32 or binary16 bits.
#[wasm_bindgen]
#[derive(Debug)]
pub struct EnvResult {
    f32s: Vec<f32>,
    f16s: Vec<u16>,
}

#[wasm_bindgen]
impl EnvResult {
    /// Byte offset of the f32 data (empty when made as half floats).
    #[wasm_bindgen(js_name = f32Ptr)]
    #[must_use]
    pub fn f32_ptr(&self) -> usize {
        self.f32s.as_ptr() as usize
    }
    /// Number of f32.
    #[wasm_bindgen(js_name = f32Len)]
    #[must_use]
    pub fn f32_len(&self) -> usize {
        self.f32s.len()
    }
    /// Byte offset of the binary16 data (empty when made as f32).
    #[wasm_bindgen(js_name = f16Ptr)]
    #[must_use]
    pub fn f16_ptr(&self) -> usize {
        self.f16s.as_ptr() as usize
    }
    /// Number of binary16 values.
    #[wasm_bindgen(js_name = f16Len)]
    #[must_use]
    pub fn f16_len(&self) -> usize {
        self.f16s.len()
    }
}

/// The environment map from the photo (RGBA8, rows top to bottom): the scene camera's R (`Matrix3.elements`,
/// camera-to-world) and `fov_y_deg`, the map's size, `anisotropy` 0 for plain bilinear (no mipmaps) or 1–16 for v1's
/// mipmapped lookup (v1: 4), `half` for binary16 output.
///
/// # Errors
/// When a size is zero or the pixels aren't `photo_w · photo_h · 4` bytes, or `r` isn't 9 numbers.
#[wasm_bindgen(js_name = envMap)]
#[allow(clippy::too_many_arguments)]
pub fn env_map(
    rgba: &[u8],
    photo_w: usize,
    photo_h: usize,
    r: &[f64],
    fov_y_deg: f64,
    width: usize,
    height: usize,
    anisotropy: u8,
    half: bool,
) -> Result<EnvResult, JsError> {
    #[allow(clippy::cast_precision_loss)] // photo sizes are far below 2^52
    let base = EnvSpec::v1(&m3(r)?, fov_y_deg, photo_w as f64, photo_h as f64);
    let filter = if anisotropy == 0 {
        EnvFilter::Bilinear
    } else {
        EnvFilter::Mipmapped {
            max_anisotropy: anisotropy,
        }
    };
    let spec = EnvSpec {
        width,
        height,
        filter,
        ..base
    };
    let photo = Rgba8 {
        width: photo_w,
        height: photo_h,
        pixels: rgba,
    };
    let n = width
        .checked_mul(height)
        .filter(|&n| n <= envmap::MAX_ENV_TEXELS)
        .and_then(|n| n.checked_mul(4))
        .ok_or_else(|| JsError::new("envMap: the map is empty or too large"))?;
    if half {
        let mut f16s = vec![0_u16; n];
        envmap::env_map_f16(&photo, &spec, &mut f16s).map_err(err)?;
        Ok(EnvResult {
            f32s: Vec::new(),
            f16s,
        })
    } else {
        let mut f32s = vec![0.0_f32; n];
        envmap::env_map(&photo, &spec, &mut f32s).map_err(err)?;
        Ok(EnvResult {
            f32s,
            f16s: Vec::new(),
        })
    }
}
