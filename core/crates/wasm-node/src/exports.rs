//! The `#[wasm_bindgen]` layer: one export per [`crate::api`] function, same name, plain JS types. wasm-bindgen's
//! generated glue is unsafe code, which is why this module (and only this module) allows it; nothing here is written
//! by hand beyond forwarding. Owned `Vec<String>` and `Option<String>` parameters are what wasm-bindgen's ABI takes.
#![allow(clippy::needless_pass_by_value)]

use wasm_bindgen::prelude::wasm_bindgen;

use crate::api;

/// See [`api::sniff`].
#[wasm_bindgen]
#[must_use]
pub fn sniff(bytes: &[u8]) -> String {
    api::sniff(bytes)
}

/// See [`api::jpeg_strip`].
#[wasm_bindgen]
#[must_use]
pub fn jpeg_strip(bytes: &[u8]) -> Vec<u8> {
    api::jpeg_strip(bytes)
}

/// See [`api::jpeg_frame`].
#[wasm_bindgen]
#[must_use]
pub fn jpeg_frame(bytes: &[u8]) -> Vec<u8> {
    api::jpeg_frame(bytes)
}

/// See [`api::jpeg_is_clean`].
#[wasm_bindgen]
#[must_use]
pub fn jpeg_is_clean(bytes: &[u8]) -> bool {
    api::jpeg_is_clean(bytes)
}

/// See [`api::jpeg_passthrough`].
#[wasm_bindgen]
#[must_use]
pub fn jpeg_passthrough(bytes: &[u8]) -> Vec<u8> {
    api::jpeg_passthrough(bytes)
}

/// See [`api::png_strip`].
#[wasm_bindgen]
#[must_use]
pub fn png_strip(bytes: &[u8]) -> Vec<u8> {
    api::png_strip(bytes)
}

/// See [`api::png_size`].
#[wasm_bindgen]
#[must_use]
pub fn png_size(bytes: &[u8]) -> Vec<u8> {
    api::png_size(bytes)
}

/// See [`api::glb_strip`].
#[wasm_bindgen]
#[must_use]
pub fn glb_strip(bytes: &[u8], in_place: bool) -> Vec<u8> {
    api::glb_strip(bytes, in_place)
}

/// See [`api::data_uri_image`].
#[wasm_bindgen]
#[must_use]
pub fn data_uri_image(value: &str, png: bool) -> Vec<u8> {
    api::data_uri_image(value, png)
}

/// See [`api::meta_decode`].
#[wasm_bindgen]
#[must_use]
pub fn meta_decode(header: &str, max_len: u32) -> Vec<u8> {
    api::meta_decode(header, max_len)
}

/// See [`api::path_normalize`].
#[wasm_bindgen]
#[must_use]
pub fn path_normalize(target: &str) -> Option<String> {
    api::path_normalize(target)
}

/// See [`api::reduce_leading_slashes`].
#[wasm_bindgen]
#[must_use]
pub fn reduce_leading_slashes(target: &str) -> String {
    api::reduce_leading_slashes(target)
}

/// See [`api::static_route`].
#[wasm_bindgen]
#[must_use]
pub fn static_route(target: &str) -> Vec<u8> {
    api::static_route(target)
}

/// See [`api::is_slug`].
#[wasm_bindgen]
#[must_use]
pub fn is_slug(s: &str) -> bool {
    api::is_slug(s)
}

/// See [`api::is_scene_name`].
#[wasm_bindgen]
#[must_use]
pub fn is_scene_name(s: &str) -> bool {
    api::is_scene_name(s)
}

/// See [`api::is_render_name`].
#[wasm_bindgen]
#[must_use]
pub fn is_render_name(s: &str) -> bool {
    api::is_render_name(s)
}

/// See [`api::cmp_names`].
#[wasm_bindgen]
#[must_use]
pub fn cmp_names(a: &str, b: &str) -> i32 {
    api::cmp_names(a, b)
}

/// See [`api::content_length`].
#[wasm_bindgen]
#[must_use]
pub fn content_length(values: Vec<String>) -> Vec<u8> {
    api::content_length(&values)
}

/// See [`api::host_name`].
#[wasm_bindgen]
#[must_use]
pub fn host_name(value: &str) -> Option<String> {
    api::host_name(value)
}

/// See [`api::check_host`].
#[wasm_bindgen]
#[must_use]
pub fn check_host(values: Vec<String>, allowed: Vec<String>) -> String {
    api::check_host(&values, &allowed)
}

/// See [`api::origin_ok`].
#[wasm_bindgen]
#[must_use]
pub fn origin_ok(x_midstudy: Option<String>, origin: Option<String>, host: Option<String>) -> bool {
    api::origin_ok(x_midstudy.as_deref(), origin.as_deref(), host.as_deref())
}

/// See [`api::zip_plan`].
#[wasm_bindgen]
#[must_use]
pub fn zip_plan(packed: &[u8]) -> Vec<u8> {
    api::zip_plan(packed)
}
