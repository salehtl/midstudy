//! midstudy's geometry kernels: the camera model of contract §4.1 and the planner's geometry (items, hulls, drags,
//! the landing rule, the Look's clamps and the key light's directions), in f64.
//!
//! Every function here is pure and total (no panics; non-finite input propagates as NaN or gives `None` the way v1
//! does), and none allocates. Where v1's result depends on JavaScript's arithmetic (`Math.round`, `Math.min`/`max`
//! with NaN and signed zeros, V8's `Math.hypot`), [`jsmath`] reproduces it, so thresholded decisions take the same
//! branch as v1. The maps are checked against the golden scenes (`fixtures/scenes/*/truth.json`), differentially
//! against v1's JavaScript, and by property tests; LEAN.md lists the formulas and properties for the Lean proofs.
#![forbid(unsafe_code)]
// Maths reads best with the names of the formulas (x, y, z, w, f, d).
#![allow(clippy::many_single_char_names)]

pub mod camera;
pub mod drag;
pub mod floor;
pub mod hull;
pub mod item;
pub mod jsmath;
pub mod look;
pub mod mat;
pub mod view;

pub use camera::{Camera, CameraBlock, DEFAULT_CAMERA, Ray};
pub use item::{LocalBox, Pose, Rect, Transform};
pub use mat::{M3, V3};
pub use view::View;
