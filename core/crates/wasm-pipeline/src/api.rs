//! The functions `exports` exposes, as plain Rust: each takes bytes and numbers and returns an envelope.
//!
//! Error codes: a PLY that v1 wouldn't read is `not-ply`, `no-header-end`, `format` (detail: the format),
//! `vertex-not-first`, `malformed` (detail: the line), `unsupported` (detail: the line), `missing` (detail: the
//! names, comma-separated), `empty`, `truncated` or `duplicate` (detail: the name); a fit is also `non-finite` or
//! `flat` (offset: the axis); an SPZ `too-large` or `short`; a picture `unidentified`, `broken` (offset: 0 JPEG, 1
//! PNG, 2 WebP; detail: why) or `too-large`; a rug picture `plain-colour`.

use midstudy_imaging::formats::{Format, ReadError, probe, read};
use midstudy_imaging::image::{Image, Mode};
use midstudy_imaging::ops::{self, MaskKind, RugError};
use midstudy_splat::fit::{FitError, FitParams, normalize};
use midstudy_splat::ply::PlyError;
use midstudy_splat::spz::{self, SpzError};

use crate::wire::{Writer, error};

fn ply_error(e: &PlyError) -> Vec<u8> {
    match e {
        PlyError::NotPly => error("not-ply", None, ""),
        PlyError::NoHeaderEnd => error("no-header-end", None, ""),
        PlyError::Format(f) => error("format", None, f),
        PlyError::VertexNotFirst => error("vertex-not-first", None, ""),
        PlyError::Malformed(l) => error("malformed", None, l),
        PlyError::Unsupported(l) => error("unsupported", None, l),
        PlyError::Missing(m) => error("missing", None, &m.join(", ")),
        PlyError::Empty => error("empty", None, ""),
        PlyError::Truncated => error("truncated", None, ""),
        PlyError::Duplicate(n) => error("duplicate", None, n),
    }
}

/// Fits a splat PLY (contract §1). `params`: the rotation (9, row major), the dims in metres (w, h, d), the
/// percentiles (lo, hi). Ok: dropped `f_rest_*` count, rotated, stretched, finite (u32 each), the written centers'
/// extent lo x y z, hi x y z (f64), then the PLY.
#[must_use]
pub fn splat_normalize(ply: &[u8], params: &[f64]) -> Vec<u8> {
    let Some(p) = params.first_chunk::<14>() else {
        return error("params", None, "14 numbers expected");
    };
    let fp = FitParams {
        rotation: [[p[0], p[1], p[2]], [p[3], p[4], p[5]], [p[6], p[7], p[8]]],
        dims: [p[9], p[10], p[11]],
        lo_pct: p[12],
        hi_pct: p[13],
    };
    match normalize(ply, &fp) {
        Ok(f) => {
            let mut w = Writer::ok();
            w.size(f.dropped_rest)
                .flag(f.rotated)
                .flag(f.stretched)
                .flag(f.finite);
            for v in f.lo.iter().chain(&f.hi) {
                w.f64(*v);
            }
            w.rest(&f.ply).finish()
        }
        Err(FitError::Ply(e)) => ply_error(&e),
        Err(FitError::NonFinite) => error("non-finite", None, ""),
        Err(FitError::Flat(axis)) => error("flat", Some(axis), ""),
    }
}

/// `splat.spz` (uncompressed) for a splat PLY. Ok: count, dropped (u32), then the SPZ bytes.
#[must_use]
pub fn spz_encode(ply: &[u8]) -> Vec<u8> {
    match spz::encode(ply) {
        Ok(s) => Writer::ok()
            .size(s.count)
            .size(s.dropped)
            .rest(&s.payload)
            .finish(),
        Err(SpzError::Ply(e)) => ply_error(&e),
        Err(SpzError::TooLarge) => error("too-large", None, ""),
    }
}

/// Reads an SPZ back (uncompressed) against the PLY it came from. Ok: magic, version, count, SH degree, fractional
/// bits, flags, length, valid, the PLY's kept count (u32 each), the largest position offset (f64, NaN when the
/// header or count disagree).
#[must_use]
pub fn spz_check(payload: &[u8], ply: &[u8]) -> Vec<u8> {
    if payload.len() < 16 {
        return error("short", Some(payload.len()), "");
    }
    match spz::check(payload, ply) {
        Ok(c) => Writer::ok()
            .u32(c.magic)
            .u32(c.version)
            .u32(c.count)
            .u32(u32::from(c.sh_degree))
            .u32(u32::from(c.fractional_bits))
            .u32(u32::from(c.flags))
            .size(c.len)
            .flag(c.valid)
            .size(c.expected)
            .f64(c.max_offset)
            .finish(),
        Err(SpzError::Ply(e)) => ply_error(&e),
        Err(SpzError::TooLarge) => error("too-large", None, ""),
    }
}

fn format_code(f: Format) -> u32 {
    match f {
        Format::Jpeg => 0,
        Format::Png => 1,
        Format::Webp => 2,
    }
}

fn read_error(e: &ReadError) -> Vec<u8> {
    match e {
        ReadError::Unidentified => error("unidentified", None, ""),
        ReadError::TooLarge => error("too-large", None, ""),
        ReadError::Broken(f, why) => error("broken", usize::try_from(format_code(*f)).ok(), why),
    }
}

/// What a picture is (Pillow's `Image.open`). Ok: format (0 JPEG, 1 PNG, 2 WebP), width, height.
#[must_use]
pub fn image_probe(bytes: &[u8]) -> Vec<u8> {
    match probe(bytes) {
        Ok((f, w, h)) => Writer::ok().u32(format_code(f)).size(w).size(h).finish(),
        Err(e) => read_error(&e),
    }
}

fn engine(e: &ops::EngineInput) -> Vec<u8> {
    Writer::ok()
        .flag(e.png)
        .size(e.width)
        .size(e.height)
        .rest(&e.bytes)
        .finish()
}

/// The engine input of a JPEG, PNG or WebP (contract §2.8). Ok: PNG (else JPEG), width, height, then the file.
#[must_use]
pub fn image_engine_input(bytes: &[u8]) -> Vec<u8> {
    match read(bytes) {
        Ok(im) => engine(&ops::engine_input(im, true)),
        Err(e) => read_error(&e),
    }
}

/// The engine input of decoded RGBA pixels already upright (libheif's HEIC): RGB unless `alpha`.
#[must_use]
pub fn pixels_engine_input(
    rgba: &[u8],
    width: u32,
    height: u32,
    alpha: bool,
    icc: &[u8],
) -> Vec<u8> {
    let (Ok(w), Ok(h)) = (usize::try_from(width), usize::try_from(height)) else {
        return error("too-large", None, "");
    };
    if w == 0 || h == 0 || w.checked_mul(h).and_then(|n| n.checked_mul(4)) != Some(rgba.len()) {
        return error("broken", None, "the pixels don't match the size");
    }
    let data = if alpha {
        rgba.to_vec()
    } else {
        rgba.chunks_exact(4)
            .flat_map(|p| p.iter().take(3).copied())
            .collect()
    };
    let mut im = Image::new(w, h, if alpha { Mode::Rgba } else { Mode::Rgb }, data);
    im.icc = (!icc.is_empty()).then(|| icc.to_vec());
    engine(&ops::engine_input(im, false))
}

/// The 256 px thumbnail of an engine input. Ok: the JPEG.
#[must_use]
pub fn image_thumb(bytes: &[u8]) -> Vec<u8> {
    match read(bytes) {
        Ok(im) => Writer::ok().rest(&ops::thumb(im)).finish(),
        Err(e) => read_error(&e),
    }
}

/// The rug texture (contract §3.2 `rug`). Ok: cropped, x0, y0, x1, y1, turned (u32), have, want, edge r g b (f64),
/// width, height (u32), then the JPEG.
#[must_use]
pub fn image_rug(bytes: &[u8], w_cm: f64, d_cm: f64) -> Vec<u8> {
    let im = match read(bytes) {
        Ok(im) => im,
        Err(e) => return read_error(&e),
    };
    match ops::rug_texture(im, w_cm, d_cm) {
        Ok(t) => {
            let b = t.crop.unwrap_or([0; 4]);
            let mut w = Writer::ok();
            w.flag(t.crop.is_some());
            for v in b {
                w.size(v);
            }
            w.flag(t.turned).f64(t.have).f64(t.want);
            for v in t.edge {
                w.f64(v);
            }
            w.size(t.width).size(t.height).rest(&t.jpeg).finish()
        }
        Err(RugError::PlainColour) => error("plain-colour", None, ""),
    }
}

/// SAM 3D's foreground mask (contract §3.2 `sam3d`). Ok: kind (0 no margin, 1 no piece, 2 the piece), share (f64),
/// then the PNG.
#[must_use]
pub fn image_mask(bytes: &[u8]) -> Vec<u8> {
    match read(bytes) {
        Ok(im) => {
            let (kind, share, png) = ops::foreground_mask(im);
            let k = match kind {
                MaskKind::NoMargin => 0,
                MaskKind::NoPiece => 1,
                MaskKind::Piece => 2,
            };
            Writer::ok().u32(k).f64(share).rest(&png).finish()
        }
        Err(e) => read_error(&e),
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    fn envelopes() {
        let e = image_probe(b"GIF89a");
        assert_eq!(e[0], 1);
        assert_eq!(&e[6..6 + usize::from(e[5])], b"unidentified");
        let e = splat_normalize(b"ply\nformat ascii 1.0\nend_header\n", &[0.0; 14]);
        assert_eq!(&e[6..6 + usize::from(e[5])], b"format");
        assert_eq!(&e[6 + usize::from(e[5])..], b"ascii");
        let px = vec![10u8; 4 * 4 * 4];
        let ok = pixels_engine_input(&px, 4, 4, false, &[]);
        assert_eq!(ok[0], 0);
        assert_eq!(u32::from_le_bytes([ok[1], ok[2], ok[3], ok[4]]), 0);
    }
}
