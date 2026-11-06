//! The keep-room mask (contract §4.7; v1 planner/engine.js `captureMask`, `dilate`): the pieces' silhouette at the
//! photo's size (white where a piece or its cast shadow was drawn, from the mask render's RGBA readback), dilated by
//! 3 % of the photo's width, and twice that below each piece for its shadow; plus its coverage.
//!
//! The dilation is v1's two-pass box dilation (along rows, then along columns) with the same reach, written so the
//! column pass runs row by row with a counter per column (cache-friendly, and LLVM vectorises it with SIMD128).

use crate::pngenc::{Color, EncodeError, encode};
use midstudy_geom::jsmath::js_round;

/// The dilation, as a share of the photo's width.
pub const KEEP_ROOM_DILATION: f64 = 0.03;

/// Why a mask kernel refused its input.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaskError {
    /// Zero width or height, or a size that overflows.
    BadSize,
    /// A buffer isn't the length the size needs.
    WrongLength,
}

impl core::fmt::Display for MaskError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::BadSize => "bad mask size",
            Self::WrongLength => "a mask buffer doesn't match the mask size",
        })
    }
}

impl std::error::Error for MaskError {}

fn pixel_count(width: usize, height: usize) -> Result<usize, MaskError> {
    if width == 0 || height == 0 {
        return Err(MaskError::BadSize);
    }
    width.checked_mul(height).ok_or(MaskError::BadSize)
}

/// The silhouette from an RGBA readback: 1 where the red channel is above 127, else 0, rows top to bottom.
/// `bottom_up` says the readback's rows run bottom to top (WebGL's `readPixels`), as v1's do.
///
/// # Errors
/// [`MaskError`] for a bad size or buffers of the wrong length (`rgba`: 4 bytes per pixel, `out`: 1).
pub fn silhouette_into(
    rgba: &[u8],
    width: usize,
    height: usize,
    bottom_up: bool,
    out: &mut [u8],
) -> Result<(), MaskError> {
    let n = pixel_count(width, height)?;
    if rgba.len() != n.checked_mul(4).ok_or(MaskError::BadSize)? || out.len() != n {
        return Err(MaskError::WrongLength);
    }
    let rows = rgba.chunks_exact(width * 4);
    let write = |orow: &mut [u8], srow: &[u8]| {
        for (o, px) in orow.iter_mut().zip(srow.chunks_exact(4)) {
            // r > 127 ⟺ bit 7 of r.
            *o = px.first().map_or(0, |r| r >> 7);
        }
    };
    if bottom_up {
        for (orow, srow) in out.chunks_exact_mut(width).zip(rows.rev()) {
            write(orow, srow);
        }
    } else {
        for (orow, srow) in out.chunks_exact_mut(width).zip(rows) {
            write(orow, srow);
        }
    }
    Ok(())
}

/// v1's `dilate(src, w, h, left, right, up, down)`: a pixel turns on when a set pixel (any non-zero byte) is within
/// `left` pixels to its right or `right` pixels to its left on its row (so set pixels reach `right` to the right and
/// `left` to the left), then, on that result, within `down` pixels above it or `up` pixels below it in its column (so
/// the mask reaches `down` below a piece and `up` above it). Output is 0 or 1. `row_pass` is scratch of the image's
/// size and `counters` scratch of its width.
///
/// # Errors
/// [`MaskError`] for a bad size or buffers of the wrong length.
pub fn dilate_into(
    src: &[u8],
    width: usize,
    height: usize,
    reach: Reach,
    row_pass: &mut [u8],
    counters: &mut [u32],
    out: &mut [u8],
) -> Result<(), MaskError> {
    let n = pixel_count(width, height)?;
    if src.len() != n || row_pass.len() != n || out.len() != n || counters.len() != width {
        return Err(MaskError::WrongLength);
    }
    let sat = |r: usize| u32::try_from(r).unwrap_or(u32::MAX);
    let (up, down) = (sat(reach.up), sat(reach.down));
    for (srow, arow) in src
        .chunks_exact(width)
        .zip(row_pass.chunks_exact_mut(width))
    {
        row_step(srow, arow, reach.left, reach.right);
    }
    counters.fill(u32::MAX);
    for (arow, orow) in row_pass
        .chunks_exact(width)
        .zip(out.chunks_exact_mut(width))
    {
        column_step(arow, counters, orow, down, false);
    }
    counters.fill(u32::MAX);
    for (arow, orow) in row_pass
        .chunks_exact(width)
        .zip(out.chunks_exact_mut(width))
        .rev()
    {
        column_step(arow, counters, orow, up, true);
    }
    Ok(())
}

/// One row of the row pass: every run of set pixels `[s, e)` turns on `[s − left, e − 1 + right]` (clipped), which is
/// what v1's two scans (rightward with reach `right`, leftward with `left`) give: the union of `[x − left, x + right]`
/// over a run is that interval. Finding runs and filling them is several times faster than v1's per-pixel scans.
fn row_step(srow: &[u8], arow: &mut [u8], left: usize, right: usize) {
    arow.fill(0);
    let w = srow.len();
    let mut x = 0;
    while let Some(off) = srow.get(x..).and_then(|r| r.iter().position(|&v| v != 0)) {
        let s = x + off;
        let run = srow
            .get(s..)
            .map_or(0, |r| r.iter().position(|&v| v == 0).unwrap_or(r.len()));
        let e = s + run; // run ≥ 1: srow[s] is set
        let lo = s.saturating_sub(left);
        let hi = (e - 1).saturating_add(right).min(w - 1);
        if let Some(seg) = arow.get_mut(lo..=hi) {
            seg.fill(1);
        }
        x = e;
    }
}

/// One row of the column pass: each column's distance since its last set pixel, and the output bit.
#[inline]
fn column_step(arow: &[u8], counters: &mut [u32], orow: &mut [u8], reach: u32, or: bool) {
    if or {
        for ((&a, c), o) in arow.iter().zip(counters.iter_mut()).zip(orow.iter_mut()) {
            *c = if a != 0 { 0 } else { c.saturating_add(1) };
            *o |= u8::from(*c <= reach);
        }
    } else {
        for ((&a, c), o) in arow.iter().zip(counters.iter_mut()).zip(orow.iter_mut()) {
            *c = if a != 0 { 0 } else { c.saturating_add(1) };
            *o = u8::from(*c <= reach);
        }
    }
}

/// How far [`dilate_into`] reaches in each direction, in pixels.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reach {
    /// To the left of a set pixel.
    pub left: usize,
    /// To the right.
    pub right: usize,
    /// Above it.
    pub up: usize,
    /// Below it.
    pub down: usize,
}

/// [`dilate_into`] with buffers of its own.
///
/// # Errors
/// [`MaskError`] for a bad size or a source of the wrong length.
pub fn dilate(src: &[u8], width: usize, height: usize, reach: Reach) -> Result<Vec<u8>, MaskError> {
    let n = pixel_count(width, height)?;
    let mut row_pass = vec![0; n];
    let mut counters = vec![0; width];
    let mut out = vec![0; n];
    dilate_into(
        src,
        width,
        height,
        reach,
        &mut row_pass,
        &mut counters,
        &mut out,
    )?;
    Ok(out)
}

/// v1's reach for a photo `width` pixels wide: `r = max(1, Math.round(0.03 · width))` to the sides and up, `2r`
/// down.
#[must_use]
pub fn keep_room_reach(width: usize) -> Reach {
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    // widths are far below 2^52, and the rounded value is a small non-negative integer
    let r = (js_round(KEEP_ROOM_DILATION * width as f64) as usize).max(1);
    Reach {
        left: r,
        right: r,
        up: r,
        down: r.saturating_mul(2),
    }
}

/// The keep-room mask and its coverage.
#[derive(Clone, Debug, PartialEq)]
pub struct KeepRoom {
    /// 0 or 1 per pixel, rows top to bottom.
    pub mask: Vec<u8>,
    /// Width in pixels.
    pub width: usize,
    /// Height in pixels.
    pub height: usize,
    /// The share of pixels that are 1 (`count / (w · h)`).
    pub coverage: f64,
}

/// v1's `captureMask` after the render: the silhouette of the RGBA readback, dilated by [`keep_room_reach`].
///
/// # Errors
/// [`MaskError`] for a bad size or a readback of the wrong length.
pub fn keep_room_mask(
    rgba: &[u8],
    width: usize,
    height: usize,
    bottom_up: bool,
) -> Result<KeepRoom, MaskError> {
    let n = pixel_count(width, height)?;
    let mut sil = vec![0; n];
    silhouette_into(rgba, width, height, bottom_up, &mut sil)?;
    let mut row_pass = vec![0; n];
    let mut counters = vec![0; width];
    let mut mask = vec![0; n];
    dilate_into(
        &sil,
        width,
        height,
        keep_room_reach(width),
        &mut row_pass,
        &mut counters,
        &mut mask,
    )?;
    let count: usize = mask.iter().map(|&v| usize::from(v)).sum();
    #[allow(clippy::cast_precision_loss)] // pixel counts are far below 2^52
    let coverage = count as f64 / n as f64;
    Ok(KeepRoom {
        mask,
        width,
        height,
        coverage,
    })
}

/// The mask as a PNG, white (255) on black, 8-bit grayscale (v1 drew it on a canvas and took the canvas's PNG, RGBA
/// with the same values).
///
/// # Errors
/// [`EncodeError`] for a bad size or a mask of the wrong length.
pub fn encode_mask_png(
    mask: &[u8],
    width: u32,
    height: u32,
    level: u8,
) -> Result<Vec<u8>, EncodeError> {
    let gray: Vec<u8> = mask.iter().map(|&v| if v != 0 { 255 } else { 0 }).collect();
    encode(width, height, Color::Gray8, &gray, level)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp, clippy::cast_possible_wrap)]
    use super::*;

    /// v1's dilate, transcribed (the reference for the tests).
    fn v1_dilate(
        src: &[u8],
        w: usize,
        h: usize,
        left: i64,
        right: i64,
        up: i64,
        down: i64,
    ) -> Vec<u8> {
        let mut a = vec![0; w * h];
        for y in 0..h {
            let row = y * w;
            let mut last = -1_000_000_000_i64;
            for x in 0..w {
                if src[row + x] != 0 {
                    last = x as i64;
                }
                if x as i64 - last <= right {
                    a[row + x] = 1;
                }
            }
            last = 1_000_000_000;
            for x in (0..w).rev() {
                if src[row + x] != 0 {
                    last = x as i64;
                }
                if last - x as i64 <= left {
                    a[row + x] = 1;
                }
            }
        }
        let mut b = vec![0; w * h];
        for x in 0..w {
            let mut last = -1_000_000_000_i64;
            for y in 0..h {
                if a[y * w + x] != 0 {
                    last = y as i64;
                }
                if y as i64 - last <= down {
                    b[y * w + x] = 1;
                }
            }
            last = 1_000_000_000;
            for y in (0..h).rev() {
                if a[y * w + x] != 0 {
                    last = y as i64;
                }
                if last - y as i64 <= up {
                    b[y * w + x] = 1;
                }
            }
        }
        b
    }

    #[test]
    fn dilation_equals_v1s() {
        let (w, h) = (37, 23);
        let mut seed = 0x1234_5678_u32;
        for trial in 0..if cfg!(miri) { 8 } else { 200_usize } {
            let mut src = vec![0; w * h];
            let density = u32::try_from(5 + trial % 40).unwrap();
            for v in &mut src {
                seed ^= seed << 13;
                seed ^= seed >> 17;
                seed ^= seed << 5;
                *v = u8::from(seed.is_multiple_of(density));
            }
            let reach = Reach {
                left: trial % 4,
                right: trial % 5,
                up: trial % 3,
                down: trial % 7,
            };
            let mine = dilate(&src, w, h, reach).unwrap();
            let theirs = v1_dilate(
                &src,
                w,
                h,
                reach.left as i64,
                reach.right as i64,
                reach.up as i64,
                reach.down as i64,
            );
            assert_eq!(mine, theirs, "trial {trial}");
        }
    }

    #[test]
    fn mask_of_one_pixel() {
        let (w, h) = (100, 80);
        let mut rgba = vec![0; w * h * 4];
        // GL rows are bottom-up: readback row 79 is the top row.
        let top = (h - 1 - 10) * w * 4 + 50 * 4;
        rgba[top] = 200;
        let k = keep_room_mask(&rgba, w, h, true).unwrap();
        assert_eq!(
            keep_room_reach(w),
            Reach {
                left: 3,
                right: 3,
                up: 3,
                down: 6
            }
        );
        assert_eq!(k.mask[10 * w + 50], 1);
        assert_eq!(k.mask[7 * w + 50], 1);
        assert_eq!(k.mask[6 * w + 50], 0);
        assert_eq!(k.mask[16 * w + 53], 1);
        assert_eq!(k.mask[17 * w + 50], 0);
        assert_eq!(k.coverage, (7.0 * 10.0) / (100.0 * 80.0));
        assert_eq!(keep_room_reach(10).left, 1);
        assert!(keep_room_mask(&rgba[1..], w, h, true).is_err());
    }
}
