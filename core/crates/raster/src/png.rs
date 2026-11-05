//! The depth.png decoder (contract §4.2: a 16-bit grayscale PNG of millimetres along the view axis): grayscale PNGs
//! of 8 or 16 bits, non-interlaced (what v1's decoder accepts), all five filters, zlib by `miniz_oxide`. Malformed
//! input is an error, never a panic: this module denies indexing, unchecked arithmetic and truncating casts.
//!
//! Stricter than v1 (planner/engine.js `loadDepth`), which never sees such files from midstudy-calib (Pillow writes
//! valid PNGs): chunk CRCs are checked, a truncated chunk, a missing IEND, a filter type above 4, compression or filter
//! methods other than 0, or image data of the wrong length are errors (v1 decodes some of these as zeros or Paeth).
#![deny(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]

use core::fmt;
use miniz_oxide::inflate::decompress_to_vec_zlib_with_limit;

/// The 8-byte PNG signature.
pub const SIGNATURE: [u8; 8] = [137, 80, 78, 71, 13, 10, 26, 10];

/// The most pixels a decoded image may have: 16 Mpx (depth.png is at most 1024 px on its long side, 1 Mpx). It bounds
/// the decoder's memory (inflated rows, samples, then f32 metres: about 8 bytes a pixel), so a hostile header can't
/// make a wasm32 allocation fail (an allocation failure would trap instead of returning an error).
pub const MAX_PIXELS: u64 = 1 << 24;

/// Why a PNG was refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PngError {
    /// The bytes don't start with the PNG signature.
    NotPng,
    /// A chunk runs past the end of the data (or there's a partial chunk header).
    Truncated,
    /// A chunk longer than PNG allows (2³¹ − 1 bytes).
    ChunkTooLong,
    /// A chunk's CRC doesn't match its type and data.
    BadCrc([u8; 4]),
    /// The first chunk isn't a 13-byte IHDR, or there's a second IHDR.
    BadHeader,
    /// Not a grayscale, 8- or 16-bit, non-interlaced PNG with compression and filter method 0.
    Unsupported {
        /// IHDR colour type.
        color_type: u8,
        /// IHDR bit depth.
        bit_depth: u8,
        /// IHDR interlace method.
        interlace: u8,
    },
    /// Zero width or height, or more than [`MAX_PIXELS`].
    BadSize {
        /// IHDR width.
        width: u32,
        /// IHDR height.
        height: u32,
    },
    /// No IDAT chunk.
    NoData,
    /// No IEND chunk.
    NoEnd,
    /// The zlib stream is corrupt, or holds more than the image needs.
    Inflate,
    /// The image data inflated to the wrong number of bytes.
    WrongLength {
        /// Bytes the image needs (rows of 1 filter byte + samples).
        expected: usize,
        /// Bytes the stream held.
        got: usize,
    },
    /// A row's filter type isn't 0–4.
    BadFilter {
        /// The row.
        row: u32,
        /// Its filter byte.
        filter: u8,
    },
}

impl fmt::Display for PngError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotPng => write!(f, "not a PNG"),
            Self::Truncated => write!(f, "the PNG is truncated"),
            Self::ChunkTooLong => write!(f, "a PNG chunk is too long"),
            Self::BadCrc(t) => write!(f, "bad CRC in the {} chunk", String::from_utf8_lossy(t)),
            Self::BadHeader => write!(f, "the PNG doesn't start with one valid IHDR chunk"),
            Self::Unsupported {
                color_type,
                bit_depth,
                interlace,
            } => write!(
                f,
                "depth.png must be a non-interlaced 8- or 16-bit grayscale PNG (got colour type {color_type}, \
                 {bit_depth} bits, interlace {interlace})"
            ),
            Self::BadSize { width, height } => write!(f, "unusable PNG size {width} x {height}"),
            Self::NoData => write!(f, "the PNG has no image data"),
            Self::NoEnd => write!(f, "the PNG has no IEND chunk"),
            Self::Inflate => write!(f, "the PNG's image data is corrupt"),
            Self::WrongLength { expected, got } => {
                write!(
                    f,
                    "the PNG's image data is {got} bytes, {expected} expected"
                )
            }
            Self::BadFilter { row, filter } => write!(f, "row {row} has filter type {filter}"),
        }
    }
}

impl std::error::Error for PngError {}

/// A decoded grayscale image: one sample per pixel, rows top to bottom.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Gray {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// 8 or 16.
    pub bit_depth: u8,
    /// `width · height` samples (0–255 for 8-bit images).
    pub samples: Vec<u16>,
}

/// The IHDR fields this decoder uses.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Header {
    pub(crate) width: u32,
    pub(crate) height: u32,
    pub(crate) bit_depth: u8,
}

const CRC_TABLE: [u32; 256] = crc_table();

#[allow(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]
const fn crc_table() -> [u32; 256] {
    // Evaluated at compile time: an out-of-range index would fail the build, not the decoder.
    let mut t = [0_u32; 256];
    let mut n = 0;
    while n < 256 {
        let mut c = n as u32;
        let mut k = 0;
        while k < 8 {
            c = if c & 1 == 1 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
            k += 1;
        }
        t[n] = c;
        n += 1;
    }
    t
}

/// CRC-32 (ISO 3309, as PNG) of the concatenation of `parts`.
#[must_use]
pub fn crc32(parts: &[&[u8]]) -> u32 {
    let mut c = 0xFFFF_FFFF_u32;
    for part in parts {
        for &b in *part {
            let i = usize::from(c.to_le_bytes()[0] ^ b);
            c = CRC_TABLE.get(i).copied().unwrap_or(0) ^ (c >> 8);
        }
    }
    c ^ 0xFFFF_FFFF
}

fn be_u32(b: &[u8]) -> Option<u32> {
    Some(u32::from_be_bytes(<[u8; 4]>::try_from(b.get(..4)?).ok()?))
}

pub(crate) fn parse_header(data: &[u8]) -> Result<Header, PngError> {
    let fields: [u8; 13] = data.try_into().map_err(|_| PngError::BadHeader)?;
    let [
        w0,
        w1,
        w2,
        w3,
        h0,
        h1,
        h2,
        h3,
        bit_depth,
        color_type,
        compression,
        filter,
        interlace,
    ] = fields;
    let width = u32::from_be_bytes([w0, w1, w2, w3]);
    let height = u32::from_be_bytes([h0, h1, h2, h3]);
    if color_type != 0
        || interlace != 0
        || compression != 0
        || filter != 0
        || !(bit_depth == 8 || bit_depth == 16)
    {
        return Err(PngError::Unsupported {
            color_type,
            bit_depth,
            interlace,
        });
    }
    let pixels = u64::from(width).checked_mul(u64::from(height));
    if width == 0 || height == 0 || pixels.is_none_or(|p| p > MAX_PIXELS) {
        return Err(PngError::BadSize { width, height });
    }
    Ok(Header {
        width,
        height,
        bit_depth,
    })
}

/// A chunk's type and data, and the bytes after it.
pub(crate) type Chunk<'a> = ([u8; 4], &'a [u8], &'a [u8]);

/// Splits the next chunk off `rest`: `(type, data, remaining)`, the CRC checked.
pub(crate) fn next_chunk(rest: &[u8]) -> Result<Chunk<'_>, PngError> {
    let (len, rest) = rest.split_at_checked(4).ok_or(PngError::Truncated)?;
    let len = be_u32(len).ok_or(PngError::Truncated)?;
    if len > 0x7FFF_FFFF {
        return Err(PngError::ChunkTooLong);
    }
    let len = usize::try_from(len).map_err(|_| PngError::ChunkTooLong)?;
    let (ty, rest) = rest.split_at_checked(4).ok_or(PngError::Truncated)?;
    let (data, rest) = rest.split_at_checked(len).ok_or(PngError::Truncated)?;
    let (crc, rest) = rest.split_at_checked(4).ok_or(PngError::Truncated)?;
    let ty: [u8; 4] = ty.try_into().map_err(|_| PngError::Truncated)?;
    if !cfg!(feature = "fuzzing") && be_u32(crc) != Some(crc32(&[&ty, data])) {
        return Err(PngError::BadCrc(ty));
    }
    Ok((ty, data, rest))
}

/// Decodes a grayscale PNG (8- or 16-bit, non-interlaced) to its samples.
///
/// # Errors
/// Any [`PngError`]: not a PNG, a malformed or truncated chunk, a bad CRC, an unsupported format, a corrupt zlib
/// stream or image data of the wrong length, or an unknown filter type.
pub fn decode_gray(bytes: &[u8]) -> Result<Gray, PngError> {
    let mut rest = bytes.strip_prefix(&SIGNATURE).ok_or(PngError::NotPng)?;
    let mut header: Option<Header> = None;
    let mut idat: Vec<u8> = Vec::new();
    let mut ended = false;
    while !rest.is_empty() {
        let (ty, data, next) = next_chunk(rest)?;
        rest = next;
        match &ty {
            b"IHDR" if header.is_none() => header = Some(parse_header(data)?),
            b"IHDR" => return Err(PngError::BadHeader),
            _ if header.is_none() => return Err(PngError::BadHeader),
            b"IDAT" => idat.extend_from_slice(data),
            b"IEND" => {
                ended = true;
                break;
            }
            _ => {} // ancillary chunks (and anything else) are skipped, as v1 does
        }
    }
    let header = header.ok_or(PngError::BadHeader)?;
    if idat.is_empty() {
        return Err(PngError::NoData);
    }
    if !ended {
        return Err(PngError::NoEnd);
    }
    let bpp: usize = if header.bit_depth == 16 { 2 } else { 1 };
    let width = usize::try_from(header.width).map_err(|_| PngError::BadSize {
        width: header.width,
        height: header.height,
    })?;
    let height = usize::try_from(header.height).map_err(|_| PngError::BadSize {
        width: header.width,
        height: header.height,
    })?;
    let size_err = PngError::BadSize {
        width: header.width,
        height: header.height,
    };
    let stride = width.checked_mul(bpp).ok_or_else(|| size_err.clone())?;
    let row_len = stride.checked_add(1).ok_or_else(|| size_err.clone())?;
    let expected = row_len
        .checked_mul(height)
        .ok_or_else(|| size_err.clone())?;
    let pixels = width.checked_mul(height).ok_or(size_err)?;
    let mut raw =
        decompress_to_vec_zlib_with_limit(&idat, expected).map_err(|_| PngError::Inflate)?;
    drop(idat);
    if raw.len() != expected {
        return Err(PngError::WrongLength {
            expected,
            got: raw.len(),
        });
    }
    let samples = unfilter_rows(&mut raw, stride, bpp, pixels)?;
    Ok(Gray {
        width: header.width,
        height: header.height,
        bit_depth: header.bit_depth,
        samples,
    })
}

/// The pixel stage of [`decode_gray`]: `raw` is the inflated image data, rows of one filter byte and `stride` bytes
/// (`bpp` 1 or 2 bytes a sample); every row is unfiltered in place against the one before it, and its samples
/// (big-endian for 16 bits) appended. `pixels` only sizes the output.
pub(crate) fn unfilter_rows(
    raw: &mut [u8],
    stride: usize,
    bpp: usize,
    pixels: usize,
) -> Result<Vec<u16>, PngError> {
    let row_len = stride.checked_add(1).ok_or(PngError::Truncated)?;
    let zeros = vec![0_u8; stride];
    let mut samples: Vec<u16> = Vec::with_capacity(pixels);
    let mut prev: &[u8] = &zeros;
    for (y, row) in (0_u32..).zip(raw.chunks_exact_mut(row_len)) {
        let (filter, cur) = row.split_first_mut().ok_or(PngError::Truncated)?;
        let ok = if bpp == 2 {
            unfilter::<2>(*filter, cur, prev)
        } else {
            unfilter::<1>(*filter, cur, prev)
        };
        if !ok {
            return Err(PngError::BadFilter {
                row: y,
                filter: *filter,
            });
        }
        if bpp == 2 {
            samples.extend(
                cur.chunks_exact(2)
                    .map(|p| <[u8; 2]>::try_from(p).map_or(0, u16::from_be_bytes)),
            );
        } else {
            samples.extend(cur.iter().map(|&b| u16::from(b)));
        }
        prev = cur;
    }
    Ok(samples)
}

/// The Paeth predictor (PNG spec §9.4): of left `a`, up `b` and up-left `c`, the one nearest `a + b − c`, ties to
/// `a`, then `b`.
#[must_use]
pub fn paeth(a: u8, b: u8, c: u8) -> u8 {
    let pa = u16::from(b.abs_diff(c)); // |p − a|
    let pb = u16::from(a.abs_diff(c)); // |p − b|
    let pc = i16::from(a)
        .wrapping_add(i16::from(b))
        .wrapping_sub(i16::from(c))
        .wrapping_sub(i16::from(c))
        .unsigned_abs();
    if pa <= pb && pa <= pc {
        a
    } else if pb <= pc {
        b
    } else {
        c
    }
}

/// Reverses one row's filter in place, `prev` being the previous row as decoded (zeros for the first). `false` for
/// an unknown filter type.
pub(crate) fn unfilter<const BPP: usize>(filter: u8, cur: &mut [u8], prev: &[u8]) -> bool {
    // Sub, Average and Paeth read the pixel to the left: per pixel, BPP independent byte chains.
    match filter {
        0 => {}
        1 => {
            let mut left = [0_u8; BPP];
            for px in cur.chunks_exact_mut(BPP) {
                for (x, l) in px.iter_mut().zip(left.iter_mut()) {
                    *x = x.wrapping_add(*l);
                    *l = *x;
                }
            }
        }
        2 => {
            for (x, &b) in cur.iter_mut().zip(prev) {
                *x = x.wrapping_add(b);
            }
        }
        3 => {
            let mut left = [0_u8; BPP];
            for (px, up) in cur.chunks_exact_mut(BPP).zip(prev.chunks_exact(BPP)) {
                for ((x, l), &b) in px.iter_mut().zip(left.iter_mut()).zip(up) {
                    *x = x.wrapping_add(l.midpoint(b));
                    *l = *x;
                }
            }
        }
        4 => {
            let mut left = [0_u8; BPP];
            let mut up_left = [0_u8; BPP];
            for (px, up) in cur.chunks_exact_mut(BPP).zip(prev.chunks_exact(BPP)) {
                for (((x, l), ul), &b) in px
                    .iter_mut()
                    .zip(left.iter_mut())
                    .zip(up_left.iter_mut())
                    .zip(up)
                {
                    *x = x.wrapping_add(paeth(*l, b, *ul));
                    *l = *x;
                    *ul = b;
                }
            }
        }
        _ => return false,
    }
    true
}

#[cfg(test)]
mod tests {
    #![allow(
        clippy::unwrap_used,
        clippy::indexing_slicing,
        clippy::arithmetic_side_effects
    )]
    use super::*;
    use crate::pngenc::{Color, encode};

    #[test]
    fn paeth_matches_the_spec() {
        for (a, b, c) in [
            (0, 0, 0),
            (10, 20, 15),
            (200, 3, 100),
            (255, 255, 0),
            (0, 255, 255),
            (7, 9, 8),
        ] {
            let p = i32::from(a) + i32::from(b) - i32::from(c);
            let (pa, pb, pc) = (
                (p - i32::from(a)).abs(),
                (p - i32::from(b)).abs(),
                (p - i32::from(c)).abs(),
            );
            let want = if pa <= pb && pa <= pc {
                a
            } else if pb <= pc {
                b
            } else {
                c
            };
            assert_eq!(paeth(a, b, c), want);
        }
    }

    #[test]
    fn crc_of_iend() {
        assert_eq!(crc32(&[b"IEND"]), 0xAE42_6082);
    }

    #[test]
    fn round_trips_through_the_encoder() {
        let px: Vec<u8> = (0..12_u8).map(|v| v * 20).collect();
        let png = encode(4, 3, Color::Gray8, &px, 6).unwrap();
        let g = decode_gray(&png).unwrap();
        assert_eq!((g.width, g.height, g.bit_depth), (4, 3, 8));
        assert_eq!(
            g.samples,
            px.iter().map(|&v| u16::from(v)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn refuses_what_it_must() {
        assert_eq!(decode_gray(b"not a png"), Err(PngError::NotPng));
        assert_eq!(decode_gray(&SIGNATURE), Err(PngError::BadHeader));
        let png = encode(2, 2, Color::Gray8, &[1, 2, 3, 4], 6).unwrap();
        for cut in [9, 20, 33, png.len() - 1] {
            assert!(decode_gray(&png[..cut]).is_err(), "cut at {cut}");
        }
        let mut bad = png.clone();
        bad[20] ^= 1; // inside IHDR
        assert!(matches!(decode_gray(&bad), Err(PngError::BadCrc(_))));
        let rgba = encode(2, 2, Color::Rgba8, &[0; 16], 6).unwrap();
        assert!(matches!(
            decode_gray(&rgba),
            Err(PngError::Unsupported { color_type: 6, .. })
        ));
    }
}
