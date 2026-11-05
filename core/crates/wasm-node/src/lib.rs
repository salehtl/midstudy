//! The media kernels for Node (docs/REFACTOR.md, track k-media), built with wasm-bindgen `--target nodejs` into
//! `build/wasm/node/`; `core/js/node.ts` is the typed face the server and the CLI import.
//!
//! The boundary carries plain types only: `Uint8Array` in and out, strings, booleans and numbers. Every fallible
//! function returns an **envelope**, a `Uint8Array` (all integers little-endian `u32`):
//!
//! ```text
//! ok:    00, then the function's payload (see each function in `api`)
//! error: 01, offset (u32; 0xFFFFFFFF when none), code length (u8), code (ASCII, kebab-case), message (UTF-8, the rest)
//! ```
//!
//! Nothing here can panic: the media crate denies indexing, unchecked arithmetic and truncating casts, and this crate
//! only encodes its results (the release profile aborts on a panic, which would surface in Node as a
//! `RuntimeError: unreachable`). [`api`] is plain Rust, tested natively; `exports` is the `#[wasm_bindgen]` layer.
//! The workspace's `#![forbid(unsafe_code)]` holds here too: wasm-bindgen's generated glue doesn't trip it.
#![deny(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]
#![deny(
    clippy::panic,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::unreachable
)]

pub mod api;
mod exports;
mod wire;
