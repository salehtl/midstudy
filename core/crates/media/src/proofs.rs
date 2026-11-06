//! Kani harnesses (`cargo kani`, in the nightly shell; check:rust runs every one). For each byte parser: no panic, no
//! arithmetic overflow and no out-of-bounds access for **every** input up to the bound in its name, and the
//! properties stated with it. The bounds are what CBMC proves in seconds (README.md lists them and the timings); the
//! fuzz targets, property tests and the differential test against v1 cover larger inputs.
//!
//! Two kinds of harness: whole functions (`png::strip`, `frame_info`, `sniff`, …) on short inputs, and their building
//! blocks (`jpeg::step`, `jpeg::scan_end`, the GLB container, the layout arithmetic, the Content-Length digit fold) on
//! longer ones, which together carry the whole function to longer inputs: the walks are loops of these steps, each
//! proved to stay in bounds and to move forward.
//!
//! The string-heavy parsers (paths, hosts, `X-Midstudy-Meta`, CPython's base64, data URIs, zip names, the glTF JSON
//! reader) are not here, nor `jpeg::strip` whole: CBMC's models of `String` and `Vec` growth didn't finish them in 5
//! minutes even at 3 or 4 bytes. `tests/exhaustive.rs` runs them instead on every input up to a bound (every byte
//! string up to 2 bytes, every string up to 4 or 5 characters over the characters each one treats specially, every
//! JPEG and PNG of up to 5 or 4 structural tokens).
//!
//! Under Kani, `jpeg::find_ff` is the plain `position` scan (CBMC needs minutes for the 64-byte block scan inside the
//! walk's loops); [`find_ff_blocks_is_position`] and [`find_ff_blocks_is_position_one_block`] prove the block scan
//! the production build uses equal to it.

use crate::{base64, glb, http, jpeg, png, slug, sniff};

/// A string of `N` symbolic bytes, cut to a symbolic length `len ≤ N`: every byte string of 0 to `N` bytes.
fn any_bytes<const N: usize>() -> ([u8; N], usize) {
    (kani::any(), kani::any_where(|&len: &usize| len <= N))
}

// --- JPEG -------------------------------------------------------------------------------------------------------

/// The block scan is `position`, for every haystack of 0 to 8 bytes (the remainder path).
#[kani::proof]
#[kani::unwind(10)]
fn find_ff_blocks_is_position() {
    let (buf, len) = any_bytes::<8>();
    let hay = buf.get(..len).unwrap_or_default();
    assert_eq!(
        jpeg::find_ff_blocks(hay),
        hay.iter().position(|&b| b == 0xFF)
    );
}

/// The block scan is `position`, for every haystack of exactly 65 bytes (one 64-byte block, then the remainder).
#[kani::proof]
#[kani::unwind(66)]
fn find_ff_blocks_is_position_one_block() {
    let hay: [u8; 65] = kani::any();
    assert_eq!(
        jpeg::find_ff_blocks(&hay),
        hay.iter().position(|&b| b == 0xFF)
    );
}

/// One step of the walk, for every input of 0 to 10 bytes and every offset: it stays in bounds and moves forward
/// (`at < next ≤ len`), so the walk over any input ends; the items it returns lie inside the input.
#[kani::proof]
#[kani::unwind(12)]
fn step_moves_forward_in_bounds() {
    let (buf, len) = any_bytes::<10>();
    let data = buf.get(..len).unwrap_or_default();
    let at: usize = kani::any_where(|&a: &usize| a <= len);
    if let Ok(s) = jpeg::step(data, at) {
        assert!(at < s.next && s.next <= len);
        assert!(s.fill < s.next.saturating_sub(at));
        match s.item {
            jpeg::Item::Eoi { end } => {
                assert!(end == s.next);
            }
            jpeg::Item::Standalone(m) => {
                assert!(matches!(m, 0x01 | 0xD0..=0xD7));
            }
            jpeg::Item::Segment { start, end, .. } => {
                assert!(at < start && start.saturating_add(2) <= end && end == s.next);
            }
            jpeg::Item::Scan { start, scan_end } => {
                assert!(at < start && start < scan_end && scan_end == s.next && scan_end < len);
            }
        }
    }
}

/// The end of the entropy-coded data, for every input of 0 to 10 bytes and every start: an `FF` that is followed by a
/// byte that is neither a stuffed `00` nor a restart marker.
#[kani::proof]
#[kani::unwind(12)]
fn scan_end_finds_a_marker() {
    let (buf, len) = any_bytes::<10>();
    let data = buf.get(..len).unwrap_or_default();
    let from: usize = kani::any_where(|&a: &usize| a <= len);
    if let Ok(e) = jpeg::scan_end(data, from) {
        assert!(from <= e && e.saturating_add(1) < len);
        assert_eq!(data.get(e), Some(&0xFF));
        let next = data.get(e.saturating_add(1)).copied().unwrap_or(0);
        assert!(next != 0x00 && !matches!(next, 0xD0..=0xD7));
    }
}

/// `frame_info`, for every input of 0 to 16 bytes: no panic, and a size it reads is never zero.
#[kani::proof]
#[kani::unwind(18)]
fn frame_info_short() {
    let (buf, len) = any_bytes::<16>();
    let data = buf.get(..len).unwrap_or_default();
    if let Ok(f) = jpeg::frame_info(data) {
        assert!(f.width > 0 && f.height > 0);
        assert!(matches!(f.marker, 0xC0..=0xCF) && !matches!(f.marker, 0xC4 | 0xC8 | 0xCC));
    }
}

// --- PNG --------------------------------------------------------------------------------------------------------

/// The PNG walk behind `strip` and `strip_plan`, for every input of 0 to 32 bytes (the signature and up to two chunk
/// headers): no panic; it keeps the signature first, then whole chunks of the input in order, and keeps all of the
/// input exactly when nothing was removed. (`strip_plan` only collects these ranges and `strip` applies them; with the
/// plan's `Vec` CBMC ran out of memory even at 24 bytes, so the walk is proved without it.)
#[kani::proof]
#[kani::unwind(10)]
fn png_walk_short() {
    let (buf, len) = any_bytes::<32>();
    let data = buf.get(..len).unwrap_or_default();
    let mut last = 0usize;
    let mut kept = 0usize;
    let mut first = true;
    let walked = png::walk(data, |start, end| {
        assert!(start < end && end <= len);
        assert!(if first {
            start == 0 && end == png::SIGNATURE.len()
        } else {
            last <= start
        });
        first = false;
        last = end;
        kept += end - start;
    });
    if let Ok(removed) = walked {
        assert!(kept <= len);
        assert_eq!(kept == len, !removed.any());
    }
}

/// `png::size`, for every input of 0 to 26 bytes: no panic, and an answer only with the signature and an IHDR.
#[kani::proof]
#[kani::unwind(28)]
fn png_size_short() {
    let (buf, len) = any_bytes::<26>();
    let data = buf.get(..len).unwrap_or_default();
    if png::size(data).is_some() {
        assert!(data.starts_with(&png::SIGNATURE) && data.get(12..16) == Some(b"IHDR".as_slice()));
    }
}

// --- GLB --------------------------------------------------------------------------------------------------------

/// The container reader, for every input of 0 to 40 bytes: no panic; the JSON and binary chunks it returns lie
/// inside the header's length.
#[kani::proof]
#[kani::unwind(6)]
fn glb_container_short() {
    let (buf, len) = any_bytes::<40>();
    let data = buf.get(..len).unwrap_or_default();
    if let Ok(c) = glb::read_container(data) {
        assert!(c.json.len().saturating_add(20) <= data.len());
        assert!(
            c.bin
                .map_or(0, <[u8]>::len)
                .saturating_add(c.json.len())
                .saturating_add(28)
                <= data.len()
                || c.bin.is_none()
        );
        assert!(c.trailing_bytes <= data.len());
    }
}

/// The compact layout's arithmetic, for every `usize`: the freed bytes split into padding below 16 and a removed
/// multiple of 16, nothing lost; in place removes nothing; `pad4` pads every length to a multiple of 4 without
/// overflow.
#[kani::proof]
fn glb_layout_arithmetic() {
    let freed: usize = kani::any();
    let (pad, removed) = glb::split_freed(freed, glb::Layout::Compact);
    assert!(
        pad < glb::ALIGN && removed % glb::ALIGN == 0 && pad.checked_add(removed) == Some(freed)
    );
    assert_eq!(glb::split_freed(freed, glb::Layout::InPlace), (freed, 0));
    let len: usize = kani::any();
    let p = glb::pad4(len);
    assert!(p < 4 && (len % 4 + p) % 4 == 0);
}

/// The vectorizable comparison is `==`, for every pair of slices of 0 to 6 bytes and for every pair of 65-byte ones.
#[kani::proof]
#[kani::unwind(8)]
fn same_bytes_is_eq() {
    let (a, la) = any_bytes::<6>();
    let (b, lb) = any_bytes::<6>();
    let (a, b) = (
        a.get(..la).unwrap_or_default(),
        b.get(..lb).unwrap_or_default(),
    );
    assert_eq!(glb::same_bytes(a, b), a == b);
}

#[kani::proof]
#[kani::unwind(66)]
fn same_bytes_is_eq_one_block() {
    let a: [u8; 65] = kani::any();
    let b: [u8; 65] = kani::any();
    assert_eq!(glb::same_bytes(&a, &b), a == b);
}

// --- sniff, slugs, HTTP, paths ------------------------------------------------------------------------------------

/// `sniff`, for every head of 0 to 16 bytes: total; JPEG exactly for `FF D8 FF`, PNG exactly for the signature.
#[kani::proof]
#[kani::unwind(10)]
fn sniff_short() {
    let (buf, len) = any_bytes::<16>();
    let data = buf.get(..len).unwrap_or_default();
    let kind = sniff::sniff(data);
    assert_eq!(
        kind == sniff::Kind::Jpeg,
        data.starts_with(&[0xFF, 0xD8, 0xFF])
    );
    assert_eq!(kind == sniff::Kind::Png, data.starts_with(&png::SIGNATURE));
}

/// `is_slug` is the regex `^[a-z0-9][a-z0-9-]{0,63}$`, for every string of 0 to 8 bytes (any UTF-8).
#[kani::proof]
#[kani::unwind(10)]
fn is_slug_is_the_regex() {
    let (buf, len) = any_bytes::<8>();
    let Ok(s) = core::str::from_utf8(buf.get(..len).unwrap_or_default()) else {
        return;
    };
    let b = s.as_bytes();
    let spec = !b.is_empty()
        && b.len() <= 64
        && b.first()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
    assert_eq!(slug::is_slug(s), spec);
}

/// The `Content-Length` digit fold, for every input of 0 to 16 bytes: never overflows; a value exactly when the input
/// is 1 to 15 ASCII digits, and then it is their number, below 10¹⁵.
#[kani::proof]
#[kani::unwind(18)]
fn digits_value_is_exact() {
    let (buf, len) = any_bytes::<16>();
    let digits = buf.get(..len).unwrap_or_default();
    let ok = (1..=15).contains(&len) && digits.iter().all(u8::is_ascii_digit);
    match http::digits_value(digits) {
        Some(n) => {
            assert!(ok && n < 1_000_000_000_000_000);
            let want = digits
                .iter()
                .fold(0u128, |n, d| n * 10 + u128::from(d - b'0'));
            assert_eq!(u128::from(n), want);
        }
        None => {
            assert!(!ok);
        }
    }
}

/// `content_length` whole, for every single value of 0 to 4 bytes and for two values: no panic; several values are
/// refused, one value is its digits' number.
#[kani::proof]
#[kani::unwind(6)]
fn content_length_short() {
    let (buf, len) = any_bytes::<4>();
    let Ok(text) = core::str::from_utf8(buf.get(..len).unwrap_or_default()) else {
        return;
    };
    if let Ok(Some(n)) = http::content_length(&[text]) {
        assert!(n < 10_000);
    }
    assert_eq!(
        http::content_length(&[text, text]),
        Err(http::ContentLengthError::Multiple)
    );
}

// --- base64, meta, data URIs, zip ---------------------------------------------------------------------------------

/// The WHATWG forgiving base64, for every input of 0 to 8 bytes: no panic, at most three bytes per four characters.
#[kani::proof]
#[kani::unwind(10)]
fn base64_forgiving_short() {
    let (buf, len) = any_bytes::<8>();
    let input = buf.get(..len).unwrap_or_default();
    if let Some(out) = base64::decode_forgiving(input) {
        assert!(out.len() <= input.len() / 4 * 3 + 2);
    }
}
