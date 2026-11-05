//! Kani harnesses (`cargo kani`, in the nightly shell; check:rust runs every one). For each byte parser: no panic, no
//! arithmetic overflow and no out-of-bounds access for **every** input up to the bound in its name, and the
//! properties stated with it. The bounds are what CBMC proves in seconds (README.md lists them and the timings); the
//! fuzz targets, property tests and the differential test against v1 cover larger inputs.
//!
//! Two kinds of harness: whole functions (`strip`, `is_clean`, `frame_info`, …) on short inputs, and their building
//! blocks (`jpeg::step`, `jpeg::scan_end`, the GLB container, the layout arithmetic) on longer ones, which together
//! carry the whole function to longer inputs: the walks are loops of these steps, each proved to stay in bounds and
//! to move forward.
//!
//! Under Kani, `jpeg::find_ff` is the plain `position` scan (CBMC needs minutes for the 64-byte block scan inside the
//! walk's loops); [`find_ff_blocks_is_position`] and [`find_ff_blocks_is_position_one_block`] prove the block scan
//! the production build uses equal to it.

use crate::{base64, datauri, glb, http, jpeg, json, meta, path, png, slug, sniff, zip};

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

/// `strip`, `is_clean` and `passthrough` whole, for every input of 0 to 6 bytes: no panic; a stripped JPEG is clean
/// and no longer than the input; `is_clean` holds exactly when the strip removes nothing but fill bytes.
#[kani::proof]
#[kani::unwind(8)]
fn jpeg_whole_short() {
    let (buf, len) = any_bytes::<6>();
    let data = buf.get(..len).unwrap_or_default();
    let stripped = jpeg::strip(data);
    let clean = jpeg::is_clean(data);
    if let Ok(s) = &stripped {
        assert!(s.bytes.len() <= data.len());
        assert!(s.bytes.starts_with(&[0xFF, 0xD8]) && s.bytes.ends_with(&[0xFF, 0xD9]));
    }
    let nothing_removed = stripped.is_ok_and(|s| {
        jpeg::Removed {
            fill_bytes: 0,
            ..s.removed
        } == jpeg::Removed::default()
    });
    assert_eq!(clean, nothing_removed);
    if jpeg::passthrough(data).is_ok() {
        assert!(clean);
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

/// `png::strip` whole, for every input of 0 to 32 bytes (the signature and up to two chunk headers): no panic; the
/// output keeps the signature, is no longer than the input, and changes exactly when something was removed.
#[kani::proof]
#[kani::unwind(10)]
fn png_strip_short() {
    let (buf, len) = any_bytes::<32>();
    let data = buf.get(..len).unwrap_or_default();
    if let Ok(s) = png::strip(data) {
        assert!(s.bytes.starts_with(&png::SIGNATURE));
        assert!(s.bytes.len() <= data.len());
        assert_eq!(s.removed.any(), s.bytes.len() != data.len());
    }
}

/// `png::size`, for every input of 0 to 26 bytes: no panic, and an answer only with the signature and an IHDR.
#[kani::proof]
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

/// `glb::strip` whole, for every input of 0 to 28 bytes: no panic (the container and the JSON reader's refusals).
#[kani::proof]
#[kani::unwind(10)]
fn glb_strip_short() {
    let (buf, len) = any_bytes::<28>();
    let data = buf.get(..len).unwrap_or_default();
    let _ = glb::strip(data, glb::Layout::Compact);
}

/// The JSON reader, for every text of 0 to 6 bytes: no panic, depth bounded.
#[kani::proof]
#[kani::unwind(8)]
fn json_parse_short() {
    let (buf, len) = any_bytes::<6>();
    let text = buf.get(..len).unwrap_or_default();
    if let Ok(ix) = json::parse(text) {
        assert!(ix.root.is_some_and(|r| r.end <= text.len()));
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

/// `Content-Length`, for every value of 0 to 17 ASCII bytes: never overflows; a length is exactly its digits' number
/// and below 10¹⁵.
#[kani::proof]
#[kani::unwind(19)]
fn content_length_is_exact() {
    let (buf, len) = any_bytes::<17>();
    let bytes = buf.get(..len).unwrap_or_default();
    kani::assume(bytes.is_ascii());
    let Ok(text) = core::str::from_utf8(bytes) else {
        return;
    };
    if let Ok(Some(n)) = http::content_length(&[text]) {
        assert!(n < 1_000_000_000_000_000);
        let digits = text.trim_matches(datauri::is_python_space);
        let want = digits
            .bytes()
            .fold(0u128, |n, d| n * 10 + u128::from(d - b'0'));
        assert_eq!(u128::from(n), want);
    }
}

/// `host_name`, for every value of 0 to 8 bytes: no panic; a name is lowercase ASCII without a port.
#[kani::proof]
#[kani::unwind(10)]
fn host_name_short() {
    let (buf, len) = any_bytes::<8>();
    let Ok(text) = core::str::from_utf8(buf.get(..len).unwrap_or_default()) else {
        return;
    };
    if let Some(name) = http::host_name(text) {
        assert!(!name.is_empty() && name.is_ascii());
        assert!(!name.bytes().any(|b| b.is_ascii_uppercase()));
        assert!(name.starts_with('[') || !name.contains(':'));
    }
}

/// Path normalisation, for every target of 0 to 5 bytes: no panic; the result starts with `/` and has no `.` or `..`
/// segment, and no NUL or backslash.
#[kani::proof]
#[kani::unwind(8)]
fn normalize_short() {
    let (buf, len) = any_bytes::<5>();
    let Ok(text) = core::str::from_utf8(buf.get(..len).unwrap_or_default()) else {
        return;
    };
    if let Ok(clean) = path::normalize(text) {
        assert!(clean.starts_with('/'));
        assert!(!clean.split('/').any(|s| s == "." || s == ".."));
        assert!(!clean.contains(['\0', '\\']));
    }
    let _ = path::static_route(text);
}

// --- base64, meta, data URIs, zip ---------------------------------------------------------------------------------

/// `CPython`'s base64 (both modes), for every input of 0 to 8 bytes: no panic; strict-valid input decodes the same
/// leniently, to at most three bytes per four characters.
#[kani::proof]
#[kani::unwind(10)]
fn base64_python_short() {
    let (buf, len) = any_bytes::<8>();
    let input = buf.get(..len).unwrap_or_default();
    let strict = base64::decode_python(input, true);
    let lenient = base64::decode_python(input, false);
    if let Ok(s) = &strict {
        assert!(s.len() <= input.len() / 4 * 3 + 2);
        assert_eq!(lenient.as_ref(), Ok(s));
    }
}

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

/// `X-Midstudy-Meta`, for every header of 0 to 8 bytes: no panic; what it returns is the strict decode.
#[kani::proof]
#[kani::unwind(10)]
fn meta_decode_short() {
    let (buf, len) = any_bytes::<8>();
    let Ok(text) = core::str::from_utf8(buf.get(..len).unwrap_or_default()) else {
        return;
    };
    if let Ok(json) = meta::decode(text, meta::MAX_HEADER_LEN) {
        assert_eq!(
            base64::decode_python(text.as_bytes(), true).ok(),
            Some(json.into_bytes())
        );
    }
}

/// v1's image data URIs, for every payload of 0 to 4 bytes after `data:image/png;base64,`: no panic.
#[kani::proof]
#[kani::unwind(28)]
fn data_uri_image_short() {
    let (buf, len) = any_bytes::<4>();
    let Ok(tail) = core::str::from_utf8(buf.get(..len).unwrap_or_default()) else {
        return;
    };
    let mut value = String::from("data:image/png;base64,");
    value.push_str(tail);
    if let Ok(bytes) = datauri::decode_image(&value, datauri::ImageType::Png) {
        assert!(bytes.len() <= 3);
    }
    let _ = datauri::decode_image(&value, datauri::ImageType::Jpeg);
}

/// The WHATWG `data:` URL reader, for every URL of 0 to 7 bytes: no panic.
#[kani::proof]
#[kani::unwind(9)]
fn data_url_parse_short() {
    let (buf, len) = any_bytes::<7>();
    let Ok(text) = core::str::from_utf8(buf.get(..len).unwrap_or_default()) else {
        return;
    };
    let _ = datauri::parse(text);
}

/// The size in v1's "unpacks to N MB" message, for every `u64`: `total / 10⁶` rounded half to even (Python's
/// `f"{total / 1e6:.0f}"` on an exact quotient), without overflow.
#[kani::proof]
fn megabytes_rounds_half_to_even() {
    let total: u64 = kani::any();
    let m = u128::from(zip::megabytes(total));
    let t = u128::from(total);
    // |total − m·10⁶| ≤ ½·10⁶, and a tie goes to the even m.
    let twice = 2 * t;
    let lo = (2 * m).saturating_sub(1) * 1_000_000;
    let hi = (2 * m + 1) * 1_000_000;
    assert!(lo <= twice && twice <= hi);
    if twice == hi || (m > 0 && twice == lo) {
        assert!(m % 2 == 0);
    }
}

/// One zip entry, for every name of 0 to 5 bytes, both name encodings and every mode: no panic; an extracted entry is
/// relative, doesn't climb, and isn't a link.
#[kani::proof]
#[kani::unwind(8)]
fn zip_decide_short() {
    let (buf, len) = any_bytes::<5>();
    let name = buf.get(..len).unwrap_or_default();
    let entry = zip::Entry {
        name,
        utf8: kani::any(),
        size: kani::any(),
        external_attr: kani::any(),
    };
    if let Ok(zip::Action::Extract { .. }) = zip::decide(&entry) {
        assert!(!name.starts_with(b"/") && !name.contains(&b'\\') && !name.contains(&0));
        assert!(entry.external_attr >> 16 & 0o170_000 != 0o120_000);
    }
}
