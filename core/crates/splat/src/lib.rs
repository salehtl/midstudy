//! midstudy's splat kernels (docs/REFACTOR.md, track pipeline; contract §1): the 3DGS PLY reader and writer
//! ([`ply`]), the per-axis fit with its covariances ([`fit`], over the eigensolver in [`eigen`]) and SPZ v2
//! ([`spz`]). They replace v1's `pipeline/src/midstudy_pipeline/splat.py` (numpy), called from Node through
//! `crates/wasm-pipeline`. Errors carry what the TypeScript side needs to word them as v1 did.

pub mod eigen;
pub mod fit;
pub mod ply;
pub mod spz;
