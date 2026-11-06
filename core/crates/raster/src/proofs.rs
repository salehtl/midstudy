//! Kani harnesses for the depth.png decoder (`cargo kani`, in the nightly shell; check:rust runs every one): no panic,
//! no arithmetic overflow and no out-of-bounds access for every input up to the bound in each name, plus the
//! properties stated with each. The inflater is `miniz_oxide`'s (fuzzed upstream and by `fuzz/decode_png`); the
//! stages around it are proved here: the chunk reader with its CRC, the header, and the pixel stage (unfiltering) with
//! its filters proved to invert the PNG spec's. The decoder as a whole timed out in CBMC at 33 bytes (the CRC over a
//! symbolic IHDR, then the chunk loop's `Vec`), and so did the pixel stage's row loop on 2 × 2 images (its sample
//! `Vec`): `png::tests::every_small_image` runs that loop on every small image instead, and the decoder is fuzzed
//! (`fuzz/decode_png`) and property-tested.

use crate::png::{self, PngError};

/// A string of `N` symbolic bytes cut to a symbolic length: every byte string of 0 to `N` bytes.
fn any_bytes<const N: usize>() -> ([u8; N], usize) {
    (kani::any(), kani::any_where(|&len: &usize| len <= N))
}

/// The PNG spec's Paeth predictor (§9.4), in wide arithmetic.
fn paeth_spec(a: u8, b: u8, c: u8) -> u8 {
    let p = i32::from(a) + i32::from(b) - i32::from(c);
    let (pa, pb, pc) = (
        (p - i32::from(a)).abs(),
        (p - i32::from(b)).abs(),
        (p - i32::from(c)).abs(),
    );
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// The decoder's Paeth is the spec's, for all 2²⁴ inputs.
#[kani::proof]
fn paeth_is_the_spec() {
    let (a, b, c) = (kani::any(), kani::any(), kani::any());
    assert_eq!(png::paeth(a, b, c), paeth_spec(a, b, c));
}

/// The PNG spec's filter of byte `i` of a row (`raw` the row's bytes, `prior` the previous row's, `bpp` bytes a pixel).
fn filter_byte(kind: u8, raw: &[u8], prior: &[u8], i: usize, bpp: usize) -> u8 {
    let a = if i >= bpp { raw[i - bpp] } else { 0 };
    let b = prior[i];
    let c = if i >= bpp { prior[i - bpp] } else { 0 };
    let pred = match kind {
        0 => 0,
        1 => a,
        2 => b,
        3 => ((u16::from(a) + u16::from(b)) / 2) as u8,
        _ => paeth_spec(a, b, c),
    };
    raw[i].wrapping_sub(pred)
}

/// Unfiltering inverts every filter of the spec, for every row of 0 to 4 bytes (1 byte a sample) and every previous
/// row; an unknown filter type is refused and leaves the row alone.
#[kani::proof]
#[kani::unwind(6)]
fn unfilter_inverts_filter_8bit() {
    let raw: [u8; 4] = kani::any();
    let prior: [u8; 4] = kani::any();
    let len: usize = kani::any_where(|&n: &usize| n <= 4);
    let kind: u8 = kani::any();
    let mut row = [0u8; 4];
    for (i, r) in row.iter_mut().enumerate() {
        *r = filter_byte(kind.min(4), &raw, &prior, i, 1);
    }
    let filtered = row;
    let ok = png::unfilter::<1>(kind, &mut row[..len], &prior[..len]);
    assert_eq!(ok, kind <= 4);
    if ok {
        assert_eq!(&row[..len], &raw[..len]);
    } else {
        assert_eq!(row, filtered);
    }
}

/// The same for 16-bit samples (2 bytes a pixel), rows of 0 to 2 pixels.
#[kani::proof]
#[kani::unwind(6)]
fn unfilter_inverts_filter_16bit() {
    let raw: [u8; 4] = kani::any();
    let prior: [u8; 4] = kani::any();
    let px: usize = kani::any_where(|&n: &usize| n <= 2);
    let kind: u8 = kani::any_where(|&k: &u8| k <= 4);
    let mut row = [0u8; 4];
    for (i, r) in row.iter_mut().enumerate() {
        *r = filter_byte(kind, &raw, &prior, i, 2);
    }
    assert!(png::unfilter::<2>(
        kind,
        &mut row[..2 * px],
        &prior[..2 * px]
    ));
    assert_eq!(&row[..2 * px], &raw[..2 * px]);
}

/// The IHDR fields, for all 2¹⁰⁴ headers: no panic; an accepted header is grayscale 8 or 16 bits, non-interlaced,
/// methods 0, with a size from 1 × 1 to [`png::MAX_PIXELS`] pixels.
#[kani::proof]
fn header_is_checked() {
    let data: [u8; 13] = kani::any();
    if let Ok(h) = png::parse_header(&data) {
        assert!(h.bit_depth == 8 || h.bit_depth == 16);
        assert!(h.width > 0 && h.height > 0);
        assert!(u64::from(h.width) * u64::from(h.height) <= png::MAX_PIXELS);
        assert!(data[9] == 0 && data[10] == 0 && data[11] == 0 && data[12] == 0);
    }
    let short: [u8; 12] = kani::any();
    assert_eq!(png::parse_header(&short), Err(PngError::BadHeader));
}

/// The chunk reader, for every input of 0 to 20 bytes: no panic; a chunk it returns has its length, its CRC
/// matched, and the rest is exactly what follows it.
#[kani::proof]
#[kani::unwind(10)]
fn next_chunk_short() {
    let (buf, len) = any_bytes::<20>();
    let rest = &buf[..len];
    if let Ok((ty, data, after)) = png::next_chunk(rest) {
        assert_eq!(12 + data.len() + after.len(), rest.len());
        assert_eq!(&rest[4..8], &ty);
        let crc = u32::from_be_bytes([
            rest[8 + data.len()],
            rest[9 + data.len()],
            rest[10 + data.len()],
            rest[11 + data.len()],
        ]);
        assert_eq!(crc, png::crc32(&[&ty, data]));
    }
}
