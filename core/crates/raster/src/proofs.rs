//! Kani harnesses for the depth.png decoder (`cargo kani`, in the nightly shell; check:rust runs every one): no panic,
//! no arithmetic overflow and no out-of-bounds access for every input up to the bound in each name, plus the
//! properties stated with each. The inflater is `miniz_oxide`'s (fuzzed upstream and by `fuzz/decode_png`); the
//! stages around it are proved here: the chunk reader, the header, and the pixel stage (unfiltering) with its filters
//! proved to invert the PNG spec's.

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

/// The PNG spec's filter of one row (`raw` the row's bytes, `prior` the previous row's, `bpp` bytes a pixel).
fn filter_spec(kind: u8, raw: &[u8], prior: &[u8], bpp: usize) -> Vec<u8> {
    raw.iter()
        .enumerate()
        .map(|(i, &x)| {
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
            x.wrapping_sub(pred)
        })
        .collect()
}

/// Unfiltering inverts every filter of the spec, for every row of 0 to 4 bytes (1 byte a sample) and every previous
/// row; an unknown filter type is refused and leaves the row alone.
#[kani::proof]
#[kani::unwind(6)]
fn unfilter_inverts_filter_8bit() {
    let (raw, len) = any_bytes::<4>();
    let prior: [u8; 4] = kani::any();
    let (raw, prior) = (&raw[..len], &prior[..len]);
    let kind: u8 = kani::any();
    let mut row = filter_spec(kind.min(4), raw, prior, 1);
    let filtered = row.clone();
    let ok = png::unfilter::<1>(kind, &mut row, prior);
    assert_eq!(ok, kind <= 4);
    if ok {
        assert_eq!(row.as_slice(), raw);
    } else {
        assert_eq!(row, filtered);
    }
}

/// The same for 16-bit samples (2 bytes a pixel), rows of 0 to 3 pixels.
#[kani::proof]
#[kani::unwind(8)]
fn unfilter_inverts_filter_16bit() {
    let raw: [u8; 6] = kani::any();
    let prior: [u8; 6] = kani::any();
    let px: usize = kani::any_where(|&n: &usize| n <= 3);
    let (raw, prior) = (&raw[..2 * px], &prior[..2 * px]);
    let kind: u8 = kani::any_where(|&k: &u8| k <= 4);
    let mut row = filter_spec(kind, raw, prior, 2);
    assert!(png::unfilter::<2>(kind, &mut row, prior));
    assert_eq!(row.as_slice(), raw);
}

/// The pixel stage on whole images up to 3 × 2 samples of either depth: no panic for any inflated data of the right
/// length; it returns one sample per pixel, or the first bad filter byte.
#[kani::proof]
#[kani::unwind(16)]
fn unfilter_rows_short() {
    let sixteen: bool = kani::any();
    let bpp = if sixteen { 2 } else { 1 };
    let width: usize = kani::any_where(|&w: &usize| (1..=3).contains(&w));
    let height: usize = kani::any_where(|&h: &usize| (1..=2).contains(&h));
    let mut raw: [u8; 14] = kani::any();
    let len = (width * bpp + 1) * height;
    let result = png::unfilter_rows(&mut raw[..len], width * bpp, bpp, width * height);
    match result {
        Ok(samples) => {
            assert_eq!(samples.len(), width * height);
            if !sixteen {
                assert!(samples.iter().all(|&s| s < 256));
            }
        }
        Err(PngError::BadFilter { row, filter }) => {
            assert!(filter > 4 && (row as usize) < height);
        }
        Err(_) => panic!("only a bad filter byte can fail the pixel stage"),
    }
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

/// The whole decoder, for every input of 0 to 40 bytes (the signature, an IHDR chunk and the start of the next):
/// no panic.
#[kani::proof]
#[kani::unwind(42)]
fn decode_gray_short() {
    let (buf, len) = any_bytes::<40>();
    let _ = png::decode_gray(&buf[..len]);
}
