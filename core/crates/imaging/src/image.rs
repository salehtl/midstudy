//! An image as Pillow holds it after `Image.open(…)`: its mode, its pixels and the `info` the pipeline reads (ICC,
//! EXIF, XMP, palette transparency), with the conversions (`Convert.c`), transposes and crops v1 uses.
#![allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::many_single_char_names
)]

use crate::resample;

/// Pillow's modes, as far as midstudy-add meets them.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    /// Bilevel ("1"), stored 0 or 255 per pixel.
    One,
    L,
    La,
    /// Palette indices; `palette` holds RGBA entries (alpha from tRNS, else 255).
    P,
    Rgb,
    Rgba,
    Cmyk,
    /// 16-bit grey ("I;16"), little-endian samples.
    I16,
}

impl Mode {
    #[must_use]
    pub fn channels(self) -> usize {
        match self {
            Mode::One | Mode::L | Mode::P => 1,
            Mode::La | Mode::I16 => 2,
            Mode::Rgb => 3,
            Mode::Rgba | Mode::Cmyk => 4,
        }
    }
}

/// A decoded image.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Image {
    pub width: usize,
    pub height: usize,
    pub mode: Mode,
    pub data: Vec<u8>,
    pub palette: Vec<[u8; 4]>,
    /// `"transparency" in im.info`: a tRNS chunk (or the like) was present.
    pub transparency: bool,
    pub icc: Option<Vec<u8>>,
    pub exif: Option<Vec<u8>>,
    pub xmp: Option<Vec<u8>>,
}

impl Image {
    #[must_use]
    pub fn new(width: usize, height: usize, mode: Mode, data: Vec<u8>) -> Self {
        Image {
            width,
            height,
            mode,
            data,
            palette: Vec::new(),
            transparency: false,
            icc: None,
            exif: None,
            xmp: None,
        }
    }

    /// v1's test for an engine input that keeps its alpha: RGBA, LA, PA, or P with transparency.
    #[must_use]
    pub fn has_alpha(&self) -> bool {
        matches!(self.mode, Mode::Rgba | Mode::La) || (self.mode == Mode::P && self.transparency)
    }

    fn pixel_rgba(&self, i: usize) -> [u8; 4] {
        let d = &self.data;
        match self.mode {
            Mode::One | Mode::L => [d[i], d[i], d[i], 255],
            Mode::La => [d[2 * i], d[2 * i], d[2 * i], d[2 * i + 1]],
            Mode::P => self
                .palette
                .get(usize::from(d[i]))
                .copied()
                .unwrap_or([0, 0, 0, 255]),
            Mode::Rgb => [d[3 * i], d[3 * i + 1], d[3 * i + 2], 255],
            Mode::Rgba => [d[4 * i], d[4 * i + 1], d[4 * i + 2], d[4 * i + 3]],
            Mode::Cmyk => {
                // Convert.c cmyk2rgb
                let nk = 255 - i32::from(d[4 * i + 3]);
                let f = |c: u8| -> u8 {
                    let t = i32::from(c) * nk + 128;
                    (nk - (((t >> 8) + t) >> 8)).clamp(0, 255) as u8
                };
                [f(d[4 * i]), f(d[4 * i + 1]), f(d[4 * i + 2]), 255]
            }
            Mode::I16 => {
                // Convert.c I16_RGB: values above 255 clip
                let v = if d[2 * i + 1] == 0 { d[2 * i] } else { 255 };
                [v, v, v, 255]
            }
        }
    }

    /// `im.convert("RGB")`.
    #[must_use]
    pub fn to_rgb(&self) -> Image {
        if self.mode == Mode::Rgb {
            return self.with(Mode::Rgb, self.data.clone());
        }
        let n = self.width * self.height;
        let mut out = Vec::with_capacity(n * 3);
        for i in 0..n {
            let p = self.pixel_rgba(i);
            out.extend_from_slice(&p[..3]);
        }
        self.with(Mode::Rgb, out)
    }

    /// `im.convert("RGBA")` (a palette's tRNS alphas applied).
    #[must_use]
    pub fn to_rgba(&self) -> Image {
        if self.mode == Mode::Rgba {
            return self.with(Mode::Rgba, self.data.clone());
        }
        let n = self.width * self.height;
        let mut out = Vec::with_capacity(n * 4);
        for i in 0..n {
            out.extend_from_slice(&self.pixel_rgba(i));
        }
        self.with(Mode::Rgba, out)
    }

    fn with(&self, mode: Mode, data: Vec<u8>) -> Image {
        Image {
            width: self.width,
            height: self.height,
            mode,
            data,
            palette: Vec::new(),
            transparency: false,
            icc: self.icc.clone(),
            exif: self.exif.clone(),
            xmp: self.xmp.clone(),
        }
    }

    /// `ImageOps.exif_transpose` for an orientation (2–8; anything else is the image as is).
    #[must_use]
    pub fn exif_transpose(self, orientation: Option<u32>) -> Image {
        let method = match orientation {
            Some(2) => Transpose::FlipLeftRight,
            Some(3) => Transpose::Rotate180,
            Some(4) => Transpose::FlipTopBottom,
            Some(5) => Transpose::Transpose,
            Some(6) => Transpose::Rotate270,
            Some(7) => Transpose::Transverse,
            Some(8) => Transpose::Rotate90,
            _ => return self,
        };
        self.transpose(method)
    }

    /// `im.transpose(method)`.
    #[must_use]
    pub fn transpose(&self, method: Transpose) -> Image {
        let (w, h) = (self.width, self.height);
        let c = self.mode.channels();
        let swap = matches!(
            method,
            Transpose::Rotate90
                | Transpose::Rotate270
                | Transpose::Transpose
                | Transpose::Transverse
        );
        let (ow, oh) = if swap { (h, w) } else { (w, h) };
        let mut out = vec![0u8; ow * oh * c];
        for oy in 0..oh {
            for ox in 0..ow {
                let (ix, iy) = match method {
                    Transpose::FlipLeftRight => (w - 1 - ox, oy),
                    Transpose::FlipTopBottom => (ox, h - 1 - oy),
                    Transpose::Rotate90 => (w - 1 - oy, ox),
                    Transpose::Rotate180 => (w - 1 - ox, h - 1 - oy),
                    Transpose::Rotate270 => (oy, h - 1 - ox),
                    Transpose::Transpose => (oy, ox),
                    Transpose::Transverse => (w - 1 - oy, h - 1 - ox),
                };
                let src = (iy * w + ix) * c;
                let dst = (oy * ow + ox) * c;
                out[dst..dst + c].copy_from_slice(&self.data[src..src + c]);
            }
        }
        let mut im = self.with(self.mode, out);
        im.width = ow;
        im.height = oh;
        im.palette.clone_from(&self.palette);
        im.transparency = self.transparency;
        im
    }

    /// `im.crop((x0, y0, x1, y1))` inside the image.
    #[must_use]
    pub fn crop(&self, x0: usize, y0: usize, x1: usize, y1: usize) -> Image {
        let c = self.mode.channels();
        let (ow, oh) = (x1 - x0, y1 - y0);
        let mut out = Vec::with_capacity(ow * oh * c);
        for y in y0..y1 {
            out.extend_from_slice(&self.data[(y * self.width + x0) * c..(y * self.width + x1) * c]);
        }
        let mut im = self.with(self.mode, out);
        im.width = ow;
        im.height = oh;
        im.palette.clone_from(&self.palette);
        im.transparency = self.transparency;
        im
    }

    /// `im.resize((w, h), Image.Resampling.LANCZOS, box)` for L, RGB and RGBA (RGBA through premultiplied `RGBa`, as
    /// Pillow does).
    #[must_use]
    pub fn resize_lanczos(&self, w: usize, h: usize, bx: [f32; 4]) -> Image {
        let mut im = self.with(self.mode, Vec::new());
        im.width = w;
        im.height = h;
        if self.mode == Mode::Rgba {
            let pre = premultiply(&self.data);
            im.data = unpremultiply(&resample::resample(
                &pre,
                self.width,
                self.height,
                4,
                w,
                h,
                bx,
            ));
        } else {
            im.data = resample::resample(
                &self.data,
                self.width,
                self.height,
                self.mode.channels(),
                w,
                h,
                bx,
            );
        }
        im
    }
}

/// Pillow's `Image.Transpose`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Transpose {
    FlipLeftRight,
    FlipTopBottom,
    Rotate90,
    Rotate180,
    Rotate270,
    Transpose,
    Transverse,
}

fn muldiv255(a: u32, b: u32) -> u8 {
    let t = a * b + 128;
    (((t >> 8) + t) >> 8) as u8
}

/// RGBA → `RGBa` (Convert.c `rgbA2rgba`).
fn premultiply(d: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(d.len());
    for p in d.chunks_exact(4) {
        let a = u32::from(p[3]);
        out.extend_from_slice(&[
            muldiv255(u32::from(p[0]), a),
            muldiv255(u32::from(p[1]), a),
            muldiv255(u32::from(p[2]), a),
            p[3],
        ]);
    }
    out
}

/// `RGBa` → RGBA (Convert.c `rgba2rgbA`).
fn unpremultiply(d: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(d.len());
    for p in d.chunks_exact(4) {
        let a = u32::from(p[3]);
        if a == 255 || a == 0 {
            out.extend_from_slice(p);
        } else {
            let f = |c: u8| ((255 * u32::from(c)) / a).min(255) as u8;
            out.extend_from_slice(&[f(p[0]), f(p[1]), f(p[2]), p[3]]);
        }
    }
    out
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    fn grid(w: usize, h: usize) -> Image {
        Image::new(w, h, Mode::L, (0..w * h).map(|i| i as u8).collect())
    }

    #[test]
    fn transposes() {
        let im = grid(3, 2); // 0 1 2 / 3 4 5
        assert_eq!(
            im.transpose(Transpose::Rotate90).data,
            vec![2, 5, 1, 4, 0, 3]
        );
        assert_eq!(
            im.transpose(Transpose::Rotate270).data,
            vec![3, 0, 4, 1, 5, 2]
        );
        assert_eq!(
            im.transpose(Transpose::Transpose).data,
            vec![0, 3, 1, 4, 2, 5]
        );
        assert_eq!(
            im.transpose(Transpose::Transverse).data,
            vec![5, 2, 4, 1, 3, 0]
        );
        assert_eq!(
            im.transpose(Transpose::FlipLeftRight).data,
            vec![2, 1, 0, 5, 4, 3]
        );
        assert_eq!(
            im.transpose(Transpose::Rotate180).data,
            vec![5, 4, 3, 2, 1, 0]
        );
    }

    #[test]
    fn cmyk_and_palette() {
        let mut im = Image::new(1, 1, Mode::Cmyk, vec![0, 0, 0, 0]);
        assert_eq!(im.to_rgb().data, vec![255, 255, 255]);
        im.data = vec![255, 0, 0, 0];
        assert_eq!(im.to_rgb().data, vec![0, 255, 255]);
        let mut p = Image::new(2, 1, Mode::P, vec![1, 0]);
        p.palette = vec![[1, 2, 3, 255], [4, 5, 6, 0]];
        p.transparency = true;
        assert!(p.has_alpha());
        assert_eq!(p.to_rgba().data, vec![4, 5, 6, 0, 1, 2, 3, 255]);
    }
}
