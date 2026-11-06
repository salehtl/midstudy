//! The `#[wasm_bindgen]` layer over `midstudy_product::api` (contract §2.11): the size reader for the server.
//! `call(op, json)` carries everything structured (core/js/product.ts types each op); the hot string predicates have
//! their own exports so a page's thousands of script strings don't each go through JSON. Nothing here can panic: the
//! product crate denies indexing, unchecked arithmetic and truncating casts, and this layer only forwards.
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

use midstudy_product::api;
use wasm_bindgen::prelude::wasm_bindgen;

/// One of the reader's operations, JSON in and out (`midstudy_product::api::call`).
#[wasm_bindgen]
#[must_use]
pub fn call(op: &str, input: &str) -> String {
    api::call(op, input)
}

/// v1's `_HAS_SIZE.search(text)`.
#[wasm_bindgen]
#[must_use]
pub fn has_size(text: &str) -> bool {
    api::has_size(text)
}

/// One of v1's word patterns (`distract`, `intro`, `sample`, `size_opt`, `size_words`, `robot`) on `text`.
#[wasm_bindgen]
#[must_use]
pub fn matches(kind: &str, text: &str) -> bool {
    api::matches(kind, text)
}

/// v1's `_category_of(text)`.
#[wasm_bindgen]
#[must_use]
pub fn category_of(text: &str) -> Option<String> {
    api::category_of(text).map(str::to_owned)
}
