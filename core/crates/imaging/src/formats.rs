//! Reading a picture into Pillow's modes (JPEG through [`crate::jpeg::decode`], PNG with the `png` crate, WebP with
//! `image-webp`), and writing the PNGs midstudy-add writes (the engine input with transparency, SAM 3D's mask).
#![allow(clippy::cast_possible_truncation)]

use std::io::Cursor;

use crate::image::{Image, Mode};
use crate::jpeg::decode::{self as jpeg, JpegError};

/// Pillow's format name for what the bytes are.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Format {
    Jpeg,
    Png,
    Webp,
}

impl Format {
    /// Pillow's `im.format`.
    #[must_use]
    pub fn name(self) -> &'static str {
        match self {
            Format::Jpeg => "JPEG",
            Format::Png => "PNG",
            Format::Webp => "WEBP",
        }
    }
}

/// Why a picture couldn't be read.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReadError {
    /// Not a format this reader knows (Pillow: `UnidentifiedImageError`).
    Unidentified,
    /// A known format that doesn't decode: the format and why.
    Broken(Format, String),
    /// Pillow's decompression-bomb limit (twice 89,478,485 pixels).
    TooLarge,
}

/// The most pixels read (Pillow refuses more than twice its warning limit).
pub const MAX_PIXELS: usize = 178_956_970;

/// The format of `bytes`, by its signature.
#[must_use]
pub fn sniff(bytes: &[u8]) -> Option<Format> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some(Format::Jpeg)
    } else if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some(Format::Png)
    } else if bytes.len() >= 12 && bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some(Format::Webp)
    } else {
        None
    }
}

fn jpeg_error(e: JpegError) -> ReadError {
    match e {
        JpegError::NotJpeg => ReadError::Unidentified,
        JpegError::TooLarge => ReadError::TooLarge,
        JpegError::NoFrame => ReadError::Broken(Format::Jpeg, "no frame header".into()),
        JpegError::Truncated => ReadError::Broken(Format::Jpeg, "image file is truncated".into()),
        JpegError::Unsupported(what) => {
            ReadError::Broken(Format::Jpeg, format!("{what} isn't supported"))
        }
        JpegError::Corrupt(what) => ReadError::Broken(Format::Jpeg, what.into()),
    }
}

/// What Pillow's `Image.open(…)` (and `verify()` for a PNG) learns: the format and size, without the pixels for a
/// JPEG.
///
/// # Errors
/// [`ReadError`] as `check_image` would fail.
pub fn probe(bytes: &[u8]) -> Result<(Format, usize, usize), ReadError> {
    match sniff(bytes).ok_or(ReadError::Unidentified)? {
        Format::Jpeg => {
            let h = jpeg::header(bytes).map_err(jpeg_error)?;
            Ok((Format::Jpeg, h.width, h.height))
        }
        f => {
            let im = read(bytes)?;
            Ok((f, im.width, im.height))
        }
    }
}

/// Decodes a JPEG, PNG or WebP into Pillow's mode and pixels, with its ICC profile, EXIF and XMP.
///
/// # Errors
/// [`ReadError`] when it isn't one of those, or doesn't decode.
pub fn read(bytes: &[u8]) -> Result<Image, ReadError> {
    match sniff(bytes).ok_or(ReadError::Unidentified)? {
        Format::Jpeg => {
            let d = jpeg::decode(bytes).map_err(jpeg_error)?;
            let mode = match d.mode {
                jpeg::Mode::L => Mode::L,
                jpeg::Mode::Rgb => Mode::Rgb,
                jpeg::Mode::Cmyk => Mode::Cmyk,
            };
            let mut im = Image::new(d.width, d.height, mode, d.pixels);
            im.icc = d.icc;
            im.exif = d.exif;
            im.xmp = d.xmp;
            Ok(im)
        }
        Format::Png => read_png(bytes),
        Format::Webp => read_webp(bytes),
    }
}

fn png_error(e: &png::DecodingError) -> ReadError {
    ReadError::Broken(Format::Png, e.to_string())
}

#[allow(clippy::too_many_lines)]
/// A PNG as Pillow opens it: 1-bit grey → "1", 2/4-bit grey scaled to "L", 16-bit samples cut to their high byte
/// (grey 16 → "I;16"), palette → "P" with its tRNS alphas.
fn read_png(bytes: &[u8]) -> Result<Image, ReadError> {
    let mut decoder = png::Decoder::new(Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::IDENTITY);
    let mut reader = decoder.read_info().map_err(|e| png_error(&e))?;
    let (w, h) = (reader.info().width as usize, reader.info().height as usize);
    if w.saturating_mul(h) > MAX_PIXELS {
        return Err(ReadError::TooLarge);
    }
    let size = reader.output_buffer_size().ok_or(ReadError::TooLarge)?;
    let mut buf = vec![0u8; size];
    let frame = reader.next_frame(&mut buf).map_err(|e| png_error(&e))?;
    let line = frame.line_size;
    // the rest of the file is read too (Pillow's verify checks every chunk up to IEND)
    let _ = reader.finish();
    let info = reader.info();
    let depth = info.bit_depth as u8;
    let ct = info.color_type;
    let sample = |row: &[u8], i: usize| -> u8 {
        match depth {
            1 => (row[i / 8] >> (7 - (i % 8))) & 1,
            2 => (row[i / 4] >> (6 - 2 * (i % 4))) & 3,
            4 => (row[i / 2] >> (4 - 4 * (i % 2))) & 15,
            16 => row[2 * i],
            _ => row[i],
        }
    };
    let rows = buf.chunks(line).take(h);
    let mut im = match ct {
        png::ColorType::Grayscale if depth == 16 => {
            let mut d = Vec::with_capacity(w * h * 2);
            for row in rows {
                for x in 0..w {
                    d.extend_from_slice(&[row[2 * x + 1], row[2 * x]]);
                }
            }
            Image::new(w, h, Mode::I16, d)
        }
        png::ColorType::Grayscale => {
            let (mode, scale) = match depth {
                1 => (Mode::One, 255u8),
                2 => (Mode::L, 0x55),
                4 => (Mode::L, 0x11),
                _ => (Mode::L, 1),
            };
            let mut d = Vec::with_capacity(w * h);
            for row in rows {
                for x in 0..w {
                    d.push(sample(row, x).wrapping_mul(scale));
                }
            }
            Image::new(w, h, mode, d)
        }
        png::ColorType::GrayscaleAlpha => {
            let mut d = Vec::with_capacity(w * h * 2);
            for row in rows {
                for x in 0..w * 2 {
                    d.push(sample(row, x));
                }
            }
            Image::new(w, h, Mode::La, d)
        }
        png::ColorType::Rgb => {
            let mut d = Vec::with_capacity(w * h * 3);
            for row in rows {
                for x in 0..w * 3 {
                    d.push(sample(row, x));
                }
            }
            Image::new(w, h, Mode::Rgb, d)
        }
        png::ColorType::Rgba => {
            let mut d = Vec::with_capacity(w * h * 4);
            for row in rows {
                for x in 0..w * 4 {
                    d.push(sample(row, x));
                }
            }
            Image::new(w, h, Mode::Rgba, d)
        }
        png::ColorType::Indexed => {
            let mut d = Vec::with_capacity(w * h);
            for row in rows {
                for x in 0..w {
                    d.push(sample(row, x));
                }
            }
            let mut im = Image::new(w, h, Mode::P, d);
            let pal = info.palette.as_deref().unwrap_or(&[]);
            let trns = info.trns.as_deref().unwrap_or(&[]);
            im.palette = pal
                .chunks_exact(3)
                .enumerate()
                .map(|(i, c)| [c[0], c[1], c[2], trns.get(i).copied().unwrap_or(255)])
                .collect();
            im
        }
    };
    im.transparency = info.trns.is_some();
    im.icc = info.icc_profile.as_ref().map(|c| c.to_vec());
    im.exif = info.exif_metadata.as_ref().map(|c| c.to_vec());
    im.xmp = info
        .utf8_text
        .iter()
        .find(|t| t.keyword == "XML:com.adobe.xmp")
        .and_then(|t| t.get_text().ok())
        .map(String::into_bytes);
    Ok(im)
}

fn read_webp(bytes: &[u8]) -> Result<Image, ReadError> {
    let err = |e: &image_webp::DecodingError| ReadError::Broken(Format::Webp, e.to_string());
    let mut d = image_webp::WebPDecoder::new(Cursor::new(bytes)).map_err(|e| err(&e))?;
    let (w, h) = d.dimensions();
    let (w, h) = (w as usize, h as usize);
    if w.saturating_mul(h) > MAX_PIXELS {
        return Err(ReadError::TooLarge);
    }
    let alpha = d.has_alpha();
    let size = d.output_buffer_size().ok_or(ReadError::TooLarge)?;
    let mut buf = vec![0u8; size];
    d.read_image(&mut buf).map_err(|e| err(&e))?;
    let mut im = Image::new(w, h, if alpha { Mode::Rgba } else { Mode::Rgb }, buf);
    im.icc = d.icc_profile().ok().flatten();
    im.exif = d.exif_metadata().ok().flatten();
    im.xmp = d.xmp_metadata().ok().flatten();
    Ok(im)
}

/// A PNG of an L or RGBA image (an RGB one too), with an `iCCP` chunk named as Pillow names it.
///
/// # Panics
/// Never for an image whose data matches its size.
#[must_use]
pub fn write_png(im: &Image, icc: Option<&[u8]>) -> Vec<u8> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, im.width as u32, im.height as u32);
        enc.set_color(match im.mode {
            Mode::Rgba => png::ColorType::Rgba,
            Mode::Rgb => png::ColorType::Rgb,
            Mode::La => png::ColorType::GrayscaleAlpha,
            _ => png::ColorType::Grayscale,
        });
        enc.set_depth(png::BitDepth::Eight);
        enc.set_compression(png::Compression::Balanced);
        if let Ok(mut w) = enc.write_header() {
            if let Some(icc) = icc.filter(|i| !i.is_empty()) {
                let mut body = b"ICC Profile\0\0".to_vec();
                body.extend_from_slice(&miniz_oxide::deflate::compress_to_vec_zlib(icc, 6));
                let _ = w.write_chunk(png::chunk::iCCP, &body);
            }
            let _ = w.write_image_data(&im.data);
            let _ = w.finish();
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing, clippy::cast_sign_loss)]
mod tests {
    use super::*;

    #[test]
    fn png_round_trip() {
        let mut im = Image::new(3, 2, Mode::Rgba, (0..24).map(|i| (i * 10) as u8).collect());
        let png = write_png(&im, Some(b"icc!"));
        let back = read(&png).unwrap();
        assert_eq!(back.mode, Mode::Rgba);
        assert_eq!(back.data, im.data);
        assert_eq!(back.icc.as_deref(), Some(&b"icc!"[..]));
        im = Image::new(2, 2, Mode::L, vec![0, 255, 7, 9]);
        assert_eq!(read(&write_png(&im, None)).unwrap().data, im.data);
        assert_eq!(probe(&write_png(&im, None)).unwrap(), (Format::Png, 2, 2));
        assert_eq!(read(b"GIF89a"), Err(ReadError::Unidentified));
    }
}
