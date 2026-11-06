//! The pipeline kernels for Node (docs/REFACTOR.md, track pipeline), built with wasm-bindgen into
//! `build/wasm/pipeline/` (Node ESM); `core/js/pipeline.ts` is the typed face `pipeline/src/` imports.
//!
//! Every function returns an **envelope**, a `Uint8Array` (integers little-endian `u32`, reals little-endian `f64`):
//!
//! ```text
//! ok:    00, then the function's payload (see each function in `api`)
//! error: 01, offset (u32; 0xFFFFFFFF when none), code length (u8), code (ASCII, kebab-case), detail (UTF-8, the rest)
//! ```
//!
//! [`api`] is plain Rust, tested natively; `exports` is the `#[wasm_bindgen]` layer (forwarding only).
#![deny(
    clippy::panic,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::unreachable
)]

pub mod api;
mod exports;
mod wire;
