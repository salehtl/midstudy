//! midstudy's imaging kernels (docs/REFACTOR.md, track pipeline): the pictures `midstudy-add` writes, made the way
//! v1's Pillow 13 (with libjpeg-turbo 3) made them, so the same input gives the same bytes:
//!
//! - [`jpeg`]: a JPEG decoder and encoder that follow libjpeg-turbo's integer arithmetic;
//! - [`formats`]: reading JPEG, PNG and WebP into Pillow's modes, writing PNG;
//! - [`exif`]: the EXIF orientation;
//! - [`image`] and [`resample`]: Pillow's conversions, transposes, crops and Lanczos resampling;
//! - [`ops`]: the engine input (contract §2.8 Privacy: upright, no metadata but the ICC profile), the thumbnail, the
//!   rug's texture (§3.2 `rug`) and SAM 3D's foreground mask (§3.2 `sam3d`).
//!
//! It replaces v1's Pillow and numpy code in `pipeline/src/midstudy_pipeline/{cli,rug}.py`; Node calls it through
//! `crates/wasm-pipeline`. HEIC is decoded in Node (libheif-js) and handed over as pixels.

pub mod exif;
pub mod formats;
pub mod image;
pub mod jpeg;
pub mod ops;
pub mod resample;
