//! midstudy's raster kernels for the planner: the depth.png decoder and depth in metres ([`png`], [`depth`]), the
//! keep-room mask ([`mask`], with a PNG encoder in [`pngenc`]), the environment map made from the photo ([`envmap`],
//! with the colour transforms in [`color`] and half floats in [`half`]), and the light probe's spherical harmonics
//! with the splat colour level ([`sh`]). Each replaces a JS loop or shader of v1 (planner/engine.js,
//! planner/lighting.js) and is checked against it differentially.
//!
//! Byte parsers deny indexing, unchecked arithmetic and truncating casts (`png`, `pngenc`); nothing here panics on
//! any input (buffers are checked, errors are values).
#![forbid(unsafe_code)]
#![allow(clippy::many_single_char_names)]

pub mod color;
pub mod depth;
pub mod envmap;
pub mod half;
pub mod mask;
pub mod png;
pub mod pngenc;
#[cfg(kani)]
mod proofs;
pub mod sh;
