//! midstudy's product page size reader (contract §2.11 Mapping, Units, Rugs; v1 `planner/product_page.py`).
//!
//! v1 read sizes with Python regular expressions, lookarounds included, and a backtracking engine that a crafted page
//! could hold for seconds. This crate gives the same answers in linear time: the patterns with lookarounds (`NUM`,
//! `UNITS`, `_ITEM`, `_ORDER_KEY`, `_THICK`, `_HAS_SIZE`) are matched by hand, trying v1's alternatives in v1's order
//! with a bounded number of steps per position, and the plain ones (`_DISTRACT`, `_INTRO`, the categories, …) run on
//! the regex crate's automata with Python's character classes (`words`). Text is handled as code points, as Python
//! indexed it, so quotes, labels and windows are cut where v1 cut them.
//!
//! The caller (the server, through crates/wasm-product) unescapes HTML and squashes whitespace as v1 did before
//! handing text over; `api` is the JSON face it calls.
#![forbid(unsafe_code)]
#![deny(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]

mod chars;
mod item;
mod merge;
mod num;
mod pyfmt;
mod reading;
mod tables;
mod text;
mod units;
mod words;

pub mod api;

pub use reading::{Ctx, Part, Reading};
pub use units::Unit;

/// An exception v1 raised while reading sizes (v1's `read()` turned any into its generic 422).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PyError {
    /// `_KEY_AXIS[tok.lower()]` on an order-key token whose lowercase isn't one of v1's spellings (a dotless ı in
    /// `wıdth`, which `re.I` matched).
    KeyError,
}
