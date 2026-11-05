//! What midstudy-add does to pictures (v1: `cli.py` `engine_input`, `make_thumb`; `rug.py` `crop_margin`,
//! `prepare`, `edge_colour`, `foreground_mask`), step for step with Pillow and numpy's arithmetic.
// Pillow's and numpy's arithmetic, operation for operation: exact float comparisons where Pillow makes them,
// (a + b) / 2 where numpy's median does.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::many_single_char_names,
    clippy::float_cmp,
    clippy::manual_midpoint
)]

use crate::exif::orientation;
use crate::formats::write_png;
use crate::image::{Image, Mode, Transpose};
use crate::jpeg::encode::encode_rgb;

/// fal rejects bigger pictures (seen live on speridlabs/idol): the engine input's long side is at most this.
pub const ENGINE_INPUT_MAX_SIDE: usize = 4096;
/// The rug texture's long side.
pub const MAX_TEXTURE: usize = 2048;
/// A pixel this far (0–255) from the margin colour is rug.
pub const MARGIN_DIFF: f64 = 28.0;
/// The border must be about this even to count as a plain margin.
pub const MARGIN_STD: f64 = 12.0;
/// A row or column is rug when this share of it is.
pub const ROW_FRACTION: f64 = 0.02;

/// The picture the engines get: upright, at most 4,096 px, JPEG q92 (a PNG when it has transparency), no metadata but
/// the ICC profile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EngineInput {
    pub png: bool,
    pub width: usize,
    pub height: usize,
    pub bytes: Vec<u8>,
}

fn upright(im: Image) -> Image {
    let o = orientation(im.exif.as_deref(), im.xmp.as_deref());
    im.exif_transpose(o)
}

/// `Image.thumbnail((bw, bh), LANCZOS)`'s size: the aspect kept, each side rounded the way that keeps it best.
#[must_use]
pub fn thumbnail_size(w: usize, h: usize, bw: usize, bh: usize) -> Option<(usize, usize)> {
    if bw >= w && bh >= h {
        return None;
    }
    let aspect = w as f64 / h as f64;
    let (x, y) = (bw as f64, bh as f64);
    let round_aspect = |number: f64, key: &dyn Fn(f64) -> f64| -> usize {
        let (lo, hi) = (number.floor(), number.ceil());
        let pick = if key(lo) <= key(hi) { lo } else { hi };
        (pick as usize).max(1)
    };
    if x / y >= aspect {
        Some((round_aspect(y * aspect, &|c| (aspect - c / y).abs()), bh))
    } else {
        Some((
            bw,
            round_aspect(x / aspect, &|c| {
                if c == 0.0 {
                    0.0
                } else {
                    (aspect - x / c).abs()
                }
            }),
        ))
    }
}

/// v1's `engine_input` of a decoded picture (`upright` false for one already turned, as libheif does for HEIC).
#[must_use]
pub fn engine_input(im: Image, apply_orientation: bool) -> EngineInput {
    let icc = im.icc.clone();
    let im = if apply_orientation { upright(im) } else { im };
    let alpha = im.has_alpha();
    let mut im = if alpha { im.to_rgba() } else { im.to_rgb() };
    if let Some((tw, th)) = thumbnail_size(
        im.width,
        im.height,
        ENGINE_INPUT_MAX_SIDE,
        ENGINE_INPUT_MAX_SIDE,
    ) && (tw, th) != (im.width, im.height)
    {
        im = im.resize_lanczos(tw, th, [0.0, 0.0, im.width as f32, im.height as f32]);
    }
    let bytes = if alpha {
        write_png(&im, icc.as_deref())
    } else {
        encode_rgb(im.width, im.height, &im.data, 92, icc.as_deref())
    };
    EngineInput {
        png: alpha,
        width: im.width,
        height: im.height,
        bytes,
    }
}

/// `ImageOps.fit(im, (ow, oh), LANCZOS)` of an RGB image (no bleed, centered).
#[must_use]
pub fn fit(im: &Image, ow: usize, oh: usize) -> Image {
    let (w, h) = (im.width as f64, im.height as f64);
    let bleed = (0.0 * w, 0.0 * h);
    let live = (w - bleed.0 * 2.0, h - bleed.1 * 2.0);
    let live_ratio = live.0 / live.1;
    let out_ratio = ow as f64 / oh as f64;
    let (cw, ch) = if live_ratio == out_ratio {
        live
    } else if live_ratio >= out_ratio {
        (out_ratio * live.1, live.1)
    } else {
        (live.0, live.0 / out_ratio)
    };
    let left = bleed.0 + (live.0 - cw) * 0.5;
    let top = bleed.1 + (live.1 - ch) * 0.5;
    let bx = [
        left as f32,
        top as f32,
        (left + cw) as f32,
        (top + ch) as f32,
    ];
    im.resize_lanczos(ow, oh, bx)
}

/// v1's `make_thumb`: 256 × 256, center-cropped, JPEG q88.
#[must_use]
pub fn thumb(im: Image) -> Vec<u8> {
    let im = upright(im).to_rgb();
    let t = fit(&im, 256, 256);
    encode_rgb(256, 256, &t.data, 88, None)
}

/// The border pixels of an RGB image in numpy's concatenation order (top rows, bottom rows, left columns, right
/// columns), `b` deep.
fn border(im: &Image, b: usize) -> Vec<[u8; 3]> {
    let (w, h) = (im.width, im.height);
    let px = |x: usize, y: usize| {
        let i = 3 * (y * w + x);
        [im.data[i], im.data[i + 1], im.data[i + 2]]
    };
    let mut out = Vec::with_capacity(2 * b * (w + h));
    for y in 0..b.min(h) {
        for x in 0..w {
            out.push(px(x, y));
        }
    }
    for y in h.saturating_sub(b)..h {
        for x in 0..w {
            out.push(px(x, y));
        }
    }
    for y in 0..h {
        for x in 0..b.min(w) {
            out.push(px(x, y));
        }
    }
    for y in 0..h {
        for x in w.saturating_sub(b)..w {
            out.push(px(x, y));
        }
    }
    out
}

/// numpy's `border.std(axis=0).max()` (population std, float64, rows summed in order).
fn border_std_max(bd: &[[u8; 3]]) -> f64 {
    let n = bd.len() as f64;
    let mut best: f64 = 0.0;
    for c in 0..3 {
        let mut s = 0.0;
        for p in bd {
            s += f64::from(p[c]);
        }
        let mean = s / n;
        let mut v = 0.0;
        for p in bd {
            let d = f64::from(p[c]) - mean;
            v += d * d;
        }
        best = best.max((v / n).sqrt());
    }
    best
}

/// numpy's `np.median(border, axis=0)`.
fn border_median(bd: &[[u8; 3]]) -> [f64; 3] {
    let mut out = [0.0; 3];
    for (c, o) in out.iter_mut().enumerate() {
        let mut v: Vec<u8> = bd.iter().map(|p| p[c]).collect();
        v.sort_unstable();
        let n = v.len();
        *o = if n % 2 == 1 {
            f64::from(v[n / 2])
        } else {
            (f64::from(v[n / 2 - 1]) + f64::from(v[n / 2])) / 2.0
        };
    }
    out
}

/// `np.abs(rgb - bg).max(axis=2) > MARGIN_DIFF` per pixel.
fn foreground(im: &Image, bg: [f64; 3]) -> Vec<bool> {
    im.data
        .chunks_exact(3)
        .map(|p| {
            let d = (f64::from(p[0]) - bg[0])
                .abs()
                .max((f64::from(p[1]) - bg[1]).abs())
                .max((f64::from(p[2]) - bg[2]).abs());
            d > MARGIN_DIFF
        })
        .collect()
}

/// v1's `crop_margin`: the picture without its plain margin, and the box, or the picture as is.
///
/// # Errors
/// [`RugError::PlainColour`] when nothing stands out from the margin.
pub fn crop_margin(im: Image) -> Result<(Image, Option<[usize; 4]>), RugError> {
    let (w, h) = (im.width, im.height);
    let b = (w.min(h) / 100).max(2);
    let bd = border(&im, b);
    if border_std_max(&bd) > MARGIN_STD {
        return Ok((im, None));
    }
    let fg = foreground(&im, border_median(&bd));
    let rows: Vec<usize> = (0..h)
        .filter(|&y| {
            fg[y * w..y * w + w].iter().filter(|&&f| f).count() as f64 / w as f64 > ROW_FRACTION
        })
        .collect();
    let cols: Vec<usize> = (0..w)
        .filter(|&x| (0..h).filter(|&y| fg[y * w + x]).count() as f64 / h as f64 > ROW_FRACTION)
        .collect();
    let (Some(&r0), Some(&r1), Some(&c0), Some(&c1)) =
        (rows.first(), rows.last(), cols.first(), cols.last())
    else {
        return Err(RugError::PlainColour);
    };
    let bx = [c0, r0, c1 + 1, r1 + 1];
    if (((bx[2] - bx[0]) * (bx[3] - bx[1])) as f64) < 0.15 * w as f64 * h as f64 {
        return Ok((im, None));
    }
    let cropped = im.crop(bx[0], bx[1], bx[2], bx[3]);
    Ok((cropped, Some(bx)))
}

/// Why a rug picture can't be used.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RugError {
    /// "the picture looks like one plain colour: use a picture of the rug itself"
    PlainColour,
}

/// The rug's top-face texture and what the notes need (v1's `prepare` and `edge_colour`).
#[derive(Clone, Debug, PartialEq)]
pub struct RugTexture {
    pub crop: Option<[usize; 4]>,
    pub turned: bool,
    /// The texture's aspect after the turn, and W ÷ D.
    pub have: f64,
    pub want: f64,
    pub width: usize,
    pub height: usize,
    /// JPEG q90 (raw/rug-texture.jpg and the GLB's image).
    pub jpeg: Vec<u8>,
    /// The rim's mean colour, linear (v1 rounds it to 4 places).
    pub edge: [f64; 3],
}

/// v1's `prepare` (margin crop, quarter turn, at most 2,048 px) and the texture's JPEG and edge colour.
///
/// # Errors
/// [`RugError`] from [`crop_margin`].
pub fn rug_texture(im: Image, w_cm: f64, d_cm: f64) -> Result<RugTexture, RugError> {
    let im = upright(im).to_rgb();
    let (mut im, crop) = crop_margin(im)?;
    let want = w_cm / d_cm;
    let mut have = im.width as f64 / im.height as f64;
    let turned = (1.0 / have / want).ln().abs() < (have / want).ln().abs();
    if turned {
        im = im.transpose(Transpose::Rotate270);
        have = 1.0 / have;
    }
    let scale = MAX_TEXTURE as f64 / im.width.max(im.height) as f64;
    if scale < 1.0 {
        let nw = ((im.width as f64 * scale).round_ties_even() as usize).max(1);
        let nh = ((im.height as f64 * scale).round_ties_even() as usize).max(1);
        im = im.resize_lanczos(nw, nh, [0.0, 0.0, im.width as f32, im.height as f32]);
    }
    let jpeg = encode_rgb(im.width, im.height, &im.data, 90, None);
    let edge = edge_colour(&im);
    Ok(RugTexture {
        crop,
        turned,
        have,
        want,
        width: im.width,
        height: im.height,
        jpeg,
        edge,
    })
}

/// v1's `edge_colour` before its rounding: the mean of the rim (min(h, w) // 50 deep, at least 1) in sRGB, made
/// linear.
#[must_use]
pub fn edge_colour(im: &Image) -> [f64; 3] {
    let b = (im.width.min(im.height) / 50).max(1);
    let rim = border(im, b);
    let n = rim.len() as f64;
    let mut out = [0.0; 3];
    for (c, o) in out.iter_mut().enumerate() {
        let mut s = 0.0;
        for p in &rim {
            s += f64::from(p[c]) / 255.0;
        }
        let v = s / n;
        *o = if v <= 0.040_45 {
            v / 12.92
        } else {
            ((v + 0.055) / 1.055).powf(2.4)
        };
    }
    out
}

/// What SAM 3D's mask covers (v1's `foreground_mask` log line).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MaskKind {
    /// "the whole picture (it has no plain margin)"
    NoMargin,
    /// "the whole picture (no piece stood out from the margin)"
    NoPiece,
    /// "the piece ({share:.0%} of the picture, the plain margin left out)"
    Piece,
}

/// v1's `foreground_mask`: white where the piece is (everything but the plain margin and the margin colour that
/// touches it, grown by a 5 × 5 max filter), or all white; as a PNG, with the share of the picture it covers.
#[must_use]
pub fn foreground_mask(im: Image) -> (MaskKind, f64, Vec<u8>) {
    let im = upright(im).to_rgb();
    let (w, h) = (im.width, im.height);
    let whole = || write_png(&Image::new(w, h, Mode::L, vec![255; w * h]), None);
    let b = (w.min(h) / 100).max(2);
    let bd = border(&im, b);
    if border_std_max(&bd) > MARGIN_STD {
        return (MaskKind::NoMargin, 1.0, whole());
    }
    let fg = foreground(&im, border_median(&bd));
    // 4-connected flood fill of the background from the padded corner (ImageDraw.floodfill)
    let (pw, ph) = (w + 2, h + 2);
    let mut reached = vec![false; pw * ph];
    let is_bg = |x: usize, y: usize| {
        x == 0 || y == 0 || x == pw - 1 || y == ph - 1 || !fg[(y - 1) * w + (x - 1)]
    };
    let mut stack = vec![(0usize, 0usize)];
    reached[0] = true;
    while let Some((x, y)) = stack.pop() {
        let mut visit = |nx: usize, ny: usize| {
            if !reached[ny * pw + nx] && is_bg(nx, ny) {
                reached[ny * pw + nx] = true;
                stack.push((nx, ny));
            }
        };
        if x + 1 < pw {
            visit(x + 1, y);
        }
        if x > 0 {
            visit(x - 1, y);
        }
        if y + 1 < ph {
            visit(x, y + 1);
        }
        if y > 0 {
            visit(x, y - 1);
        }
    }
    let mask: Vec<bool> = (0..h)
        .flat_map(|y| (0..w).map(move |x| (x, y)))
        .map(|(x, y)| !reached[(y + 1) * pw + x + 1])
        .collect();
    let share = mask.iter().filter(|&&m| m).count() as f64 / (w * h) as f64;
    if share < 0.01 {
        return (MaskKind::NoPiece, share, whole());
    }
    // MaxFilter(5) over the edge-replicated image
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut on = false;
            'win: for dy in 0..5usize {
                let sy = (y + dy).saturating_sub(2).min(h - 1);
                for dx in 0..5usize {
                    let sx = (x + dx).saturating_sub(2).min(w - 1);
                    if mask[sy * w + sx] {
                        on = true;
                        break 'win;
                    }
                }
            }
            out[y * w + x] = if on { 255 } else { 0 };
        }
    }
    (
        MaskKind::Piece,
        share,
        write_png(&Image::new(w, h, Mode::L, out), None),
    )
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn rug_picture() -> Image {
        // 800 × 800 white, a 300 × 500 brown rug with light stripes (E8's picture)
        let (w, h) = (800usize, 800usize);
        let mut d = vec![255u8; w * h * 3];
        for y in 150..650 {
            for x in 250..550 {
                let stripe = (170..640).step_by(40).any(|s| y >= s && y <= s + 15)
                    && (270..=529).contains(&x);
                let c = if stripe {
                    [230, 220, 200]
                } else {
                    [150, 90, 40]
                };
                d[3 * (y * w + x)..3 * (y * w + x) + 3].copy_from_slice(&c);
            }
        }
        Image::new(w, h, Mode::Rgb, d)
    }

    #[test]
    fn crops_the_margin_and_turns() {
        let t = rug_texture(rug_picture(), 160.0, 230.0).unwrap();
        assert_eq!(t.crop, Some([250, 150, 550, 650]));
        assert!(!t.turned);
        let t = rug_texture(rug_picture(), 230.0, 160.0).unwrap();
        assert!(t.turned && t.width == 500 && t.height == 300);
        let plain = Image::new(50, 50, Mode::Rgb, vec![200; 50 * 50 * 3]);
        assert_eq!(rug_texture(plain, 100.0, 100.0), Err(RugError::PlainColour));
    }

    #[test]
    fn mask_of_the_piece() {
        let (kind, share, png) = foreground_mask(rug_picture());
        assert_eq!(kind, MaskKind::Piece);
        assert!((share - 300.0 * 500.0 / 640_000.0).abs() < 1e-12);
        let m = crate::formats::read(&png).unwrap();
        assert_eq!(m.data[150 * 800 + 250], 255);
        assert_eq!(m.data[148 * 800 + 250], 255); // grown by the max filter
        assert_eq!(m.data[147 * 800 + 250], 0);
    }

    #[test]
    fn thumbnail_sizes() {
        assert_eq!(thumbnail_size(100, 50, 4096, 4096), None);
        assert_eq!(thumbnail_size(5000, 3000, 4096, 4096), Some((4096, 2458)));
        assert_eq!(thumbnail_size(3000, 5000, 4096, 4096), Some((2458, 4096)));
    }
}
