//! A minimal PNG encoder (8-bit grayscale or RGBA, filter type 0, zlib by `miniz_oxide`), for the keep-room mask
//! (contract §4.7: a PNG data URI at the photo's size) without a canvas, and for tests of the decoder.
#![deny(
    clippy::indexing_slicing,
    clippy::arithmetic_side_effects,
    clippy::cast_possible_truncation
)]

use crate::png::{SIGNATURE, crc32};
use miniz_oxide::deflate::compress_to_vec_zlib;

/// The pixel format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Color {
    /// One byte per pixel (PNG colour type 0).
    Gray8,
    /// Four bytes per pixel, R G B A (PNG colour type 6).
    Rgba8,
    /// One 16-bit big-endian sample per pixel, given as two bytes per pixel (PNG colour type 0, depth 16).
    Gray16,
}

impl Color {
    fn bytes_per_pixel(self) -> usize {
        match self {
            Self::Gray8 => 1,
            Self::Gray16 => 2,
            Self::Rgba8 => 4,
        }
    }
}

/// Why the encoder refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EncodeError {
    /// Zero width or height, or a size that overflows.
    BadSize,
    /// `pixels` isn't `width · height · bytes per pixel` long.
    WrongLength,
}

impl core::fmt::Display for EncodeError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::BadSize => "bad image size",
            Self::WrongLength => "the pixels don't match the image size",
        })
    }
}

impl std::error::Error for EncodeError {}

fn chunk(out: &mut Vec<u8>, ty: [u8; 4], data: &[u8]) -> Result<(), EncodeError> {
    let len = u32::try_from(data.len()).map_err(|_| EncodeError::BadSize)?;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(&ty);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[&ty, data]).to_be_bytes());
    Ok(())
}

/// Encodes `pixels` (rows top to bottom) as a PNG; `level` is the zlib level (0–10, 6 the usual default).
///
/// # Errors
/// [`EncodeError`] for a zero or overflowing size, or pixels of the wrong length.
pub fn encode(
    width: u32,
    height: u32,
    color: Color,
    pixels: &[u8],
    level: u8,
) -> Result<Vec<u8>, EncodeError> {
    if width == 0 || height == 0 {
        return Err(EncodeError::BadSize);
    }
    let w = usize::try_from(width).map_err(|_| EncodeError::BadSize)?;
    let h = usize::try_from(height).map_err(|_| EncodeError::BadSize)?;
    let stride = w
        .checked_mul(color.bytes_per_pixel())
        .ok_or(EncodeError::BadSize)?;
    if stride.checked_mul(h) != Some(pixels.len()) {
        return Err(EncodeError::WrongLength);
    }
    let mut raw = Vec::with_capacity(
        stride
            .checked_add(1)
            .and_then(|r| r.checked_mul(h))
            .ok_or(EncodeError::BadSize)?,
    );
    for row in pixels.chunks_exact(stride) {
        raw.push(0); // filter type 0
        raw.extend_from_slice(row);
    }
    let (color_type, depth) = match color {
        Color::Gray8 => (0, 8),
        Color::Gray16 => (0, 16),
        Color::Rgba8 => (6, 8),
    };
    let mut ihdr = [0_u8; 13];
    for (dst, src) in ihdr
        .iter_mut()
        .zip(width.to_be_bytes().into_iter().chain(height.to_be_bytes()))
    {
        *dst = src;
    }
    for (dst, src) in ihdr.iter_mut().skip(8).zip([depth, color_type, 0, 0, 0]) {
        *dst = src;
    }
    let mut out = Vec::new();
    out.extend_from_slice(&SIGNATURE);
    chunk(&mut out, *b"IHDR", &ihdr)?;
    chunk(&mut out, *b"IDAT", &compress_to_vec_zlib(&raw, level))?;
    chunk(&mut out, *b"IEND", &[])?;
    Ok(out)
}
