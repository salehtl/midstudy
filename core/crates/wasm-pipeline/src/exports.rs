//! The `#[wasm_bindgen]` layer: one export per [`crate::api`] function, same name, plain JS types; nothing here but
//! forwarding.

use wasm_bindgen::prelude::wasm_bindgen;

use crate::api;

/// See [`api::splat_normalize`].
#[wasm_bindgen]
#[must_use]
pub fn splat_normalize(ply: &[u8], params: &[f64]) -> Vec<u8> {
    api::splat_normalize(ply, params)
}

/// See [`api::spz_encode`].
#[wasm_bindgen]
#[must_use]
pub fn spz_encode(ply: &[u8]) -> Vec<u8> {
    api::spz_encode(ply)
}

/// See [`api::spz_check`].
#[wasm_bindgen]
#[must_use]
pub fn spz_check(payload: &[u8], ply: &[u8]) -> Vec<u8> {
    api::spz_check(payload, ply)
}

/// See [`api::image_probe`].
#[wasm_bindgen]
#[must_use]
pub fn image_probe(bytes: &[u8]) -> Vec<u8> {
    api::image_probe(bytes)
}

/// See [`api::image_engine_input`].
#[wasm_bindgen]
#[must_use]
pub fn image_engine_input(bytes: &[u8]) -> Vec<u8> {
    api::image_engine_input(bytes)
}

/// See [`api::pixels_engine_input`].
#[wasm_bindgen]
#[must_use]
pub fn pixels_engine_input(
    rgba: &[u8],
    width: u32,
    height: u32,
    alpha: bool,
    icc: &[u8],
) -> Vec<u8> {
    api::pixels_engine_input(rgba, width, height, alpha, icc)
}

/// See [`api::image_thumb`].
#[wasm_bindgen]
#[must_use]
pub fn image_thumb(bytes: &[u8]) -> Vec<u8> {
    api::image_thumb(bytes)
}

/// See [`api::image_rug`].
#[wasm_bindgen]
#[must_use]
pub fn image_rug(bytes: &[u8], w_cm: f64, d_cm: f64) -> Vec<u8> {
    api::image_rug(bytes, w_cm, d_cm)
}

/// See [`api::image_mask`].
#[wasm_bindgen]
#[must_use]
pub fn image_mask(bytes: &[u8]) -> Vec<u8> {
    api::image_mask(bytes)
}
