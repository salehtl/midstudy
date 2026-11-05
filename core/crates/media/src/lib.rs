//! midstudy's byte-level kernels (docs/REFACTOR.md, track k-media).
//!
//! These are the functions that decide what the server stores, serves and sends to fal: what an upload is
//! ([`sniff`]), which bytes of a JPEG, PNG or GLB are camera metadata ([`jpeg`], [`png`], [`glb`]), how big a
//! JPEG is ([`jpeg::frame_info`]), which request paths name a served file ([`path`]), which names are slugs
//! ([`slug`]), how a request is framed and whose it is ([`http`]), which zip entries may be extracted ([`zip`]) and
//! how the `X-Midstudy-Meta` header and image data URIs decode ([`meta`], [`datauri`]).
//!
//! Every function is pure (no I/O, no globals) and cites the section of `contract/CONTRACT.md` it implements. The
//! v1 Python each one replaces is cited in `docs/notes/k-media.md`, and `tests/diff_v1.py` checks that both make
//! the same decisions and write the same bytes. Malformed input can never panic, read out of bounds or wrap: the
//! crate denies indexing, unchecked arithmetic and truncating casts.
#![deny(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]
#![deny(
    clippy::panic,
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::unreachable,
    clippy::todo,
    clippy::unimplemented
)]

pub mod base64;
mod bytes;
pub mod datauri;
pub mod glb;
pub mod http;
pub mod jpeg;
mod json;
pub mod meta;
pub mod path;
pub mod plan;
pub mod png;
#[cfg(kani)]
mod proofs;
pub mod slug;
pub mod sniff;
pub mod zip;
