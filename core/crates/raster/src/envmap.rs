//! The environment map made from the photo (contract §4.8, Reflections; v1 planner/lighting.js `makeEnvBakeMat`):
//! every direction around the room, turned into the camera's frame and looked up in the photo (directions behind the
//! camera see the front mirrored, directions past the frame its nearest edge), its pixel taken back to radiance the
//! way lighting.json's fit did (sRGB to linear, ACES undone). The result is an equirectangular RGBA image in three.js's
//! convention (u = atan2(z, x) / 2π + ½, v = asin(y) / π + ½), row 0 at v ≈ 0 (looking down), as a
//! `DataTexture` with `flipY` false reads it; the engine feeds it to `PMREMGenerator.fromEquirectangular`.
//!
//! v1 ran this as a shader into a 512 × 256 half-float target, sampling the photo texture with mipmaps
//! (`LinearMipmapLinearFilter`) and anisotropy 4. [`EnvFilter::Mipmapped`] does the same on the CPU (a box-filtered
//! 8-bit mip chain, the level of detail from each 2 × 2 quad's derivatives, anisotropic samples along the major axis
//! as the `EXT_texture_filter_anisotropic` reference describes); [`EnvFilter::Bilinear`] samples level 0 only (the
//! shader's geometry and colour maths exactly, for differential tests).

use crate::color::{AcesInverse, srgb_to_linear};
use crate::half::f32_to_f16;
use midstudy_geom::mat::{M3, mul, transpose};

/// v1's environment map size.
pub const ENV_WIDTH: usize = 512;
/// v1's environment map height.
pub const ENV_HEIGHT: usize = 256;
/// The photo texture's anisotropy in v1 (`t.anisotropy = 4`).
pub const PHOTO_ANISOTROPY: u8 = 4;

/// How the photo is sampled.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvFilter {
    /// Bilinear on the full-size photo (no mipmaps).
    Bilinear,
    /// Trilinear on a mip chain with up to `max_anisotropy` samples along the footprint's major axis (v1's GPU path).
    Mipmapped {
        /// 1 for isotropic trilinear; v1 used 4.
        max_anisotropy: u8,
    },
}

/// The map to make.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EnvSpec {
    /// Output width (v1: 512).
    pub width: usize,
    /// Output height (v1: 256).
    pub height: usize,
    /// World-to-camera rotation, Rᵀ of the scene camera's R (v1's `uWorldToCam`).
    pub world_to_cam: M3,
    /// `tan(fov_y / 2)` (v1's `uTanY`).
    pub tan_y: f64,
    /// The photo's width / height (v1's `uAspect`).
    pub aspect: f64,
    /// The sampling.
    pub filter: EnvFilter,
}

impl EnvSpec {
    /// v1's map for the scene camera with rotation `r` (camera-to-world) and vertical field of view `fov_y_deg`, on a
    /// `photo_w` × `photo_h` photo: 512 × 256, mipmapped with anisotropy 4.
    #[must_use]
    pub fn v1(r: &M3, fov_y_deg: f64, photo_w: f64, photo_h: f64) -> Self {
        Self {
            width: ENV_WIDTH,
            height: ENV_HEIGHT,
            world_to_cam: transpose(r),
            tan_y: ((fov_y_deg * midstudy_geom::jsmath::DEG) / 2.0).tan(),
            aspect: photo_w / photo_h,
            filter: EnvFilter::Mipmapped {
                max_anisotropy: PHOTO_ANISOTROPY,
            },
        }
    }
}

/// An RGBA8 photo, rows top to bottom (as `getImageData` gives it).
#[derive(Clone, Copy, Debug)]
pub struct Rgba8<'a> {
    /// Width in pixels.
    pub width: usize,
    /// Height in pixels.
    pub height: usize,
    /// `width · height · 4` bytes.
    pub pixels: &'a [u8],
}

/// Why the map wasn't made.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EnvError {
    /// The photo or the map has a zero or overflowing size.
    BadSize,
    /// The photo's pixels or the output buffer have the wrong length.
    WrongLength,
}

impl core::fmt::Display for EnvError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        f.write_str(match self {
            Self::BadSize => "bad environment map or photo size",
            Self::WrongLength => "an environment map buffer has the wrong length",
        })
    }
}

impl std::error::Error for EnvError {}

/// The photo texture coordinates (s, t) v1's shader looks up for environment pixel (i, j) (t = 0 at the photo's top
/// row): the pixel's direction `(cos θ cos φ, sin θ, cos θ sin φ)` with φ = (u − ½)·2π, θ = (v − ½)·π at its centre,
/// turned into the camera frame, mirrored to the front (`z = −max(|z|, 1e-3)`), projected, and clamped to the frame.
#[must_use]
pub fn photo_uv(spec: &EnvSpec, i: usize, j: usize) -> [f64; 2] {
    #[allow(clippy::cast_precision_loss)] // map sizes are tiny
    let (u, v) = (
        (i as f64 + 0.5) / spec.width as f64,
        (j as f64 + 0.5) / spec.height as f64,
    );
    let (phi, th) = (
        (u - 0.5) * core::f64::consts::TAU,
        (v - 0.5) * core::f64::consts::PI,
    );
    uv_of_dir(spec, [th.cos() * phi.cos(), th.sin(), th.cos() * phi.sin()])
}

fn uv_of_dir(spec: &EnvSpec, d: [f64; 3]) -> [f64; 2] {
    let mut c = mul(&spec.world_to_cam, d);
    c[2] = -c[2].abs().max(1e-3);
    let nx = (c[0] / (-c[2]) / (spec.tan_y * spec.aspect)).clamp(-1.0, 1.0);
    let ny = (c[1] / (-c[2]) / spec.tan_y).clamp(-1.0, 1.0);
    [nx * 0.5 + 0.5, 0.5 - ny * 0.5]
}

/// One mip level: RGBA8, rows top to bottom.
#[derive(Clone, Debug)]
struct Level<'a> {
    w: usize,
    h: usize,
    px: std::borrow::Cow<'a, [u8]>,
}

impl Level<'_> {
    /// `GL_LINEAR` with `CLAMP_TO_EDGE` at texture coordinates (s, t): texel centres at (i + ½) / w.
    #[allow(
        clippy::cast_precision_loss,
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss
    )]
    fn bilinear(&self, s: f64, t: f64) -> [f64; 3] {
        let (wf, hf) = (self.w as f64, self.h as f64);
        let (x, y) = (s * wf - 0.5, t * hf - 0.5);
        let (x0, y0) = (x.floor(), y.floor());
        let (fx, fy) = (x - x0, y - y0);
        let ix = |v: f64| v.clamp(0.0, wf - 1.0) as usize;
        let iy = |v: f64| v.clamp(0.0, hf - 1.0) as usize;
        let (i0, i1, j0, j1) = (ix(x0), ix(x0 + 1.0), iy(y0), iy(y0 + 1.0));
        let texel = |i: usize, j: usize| -> [f64; 3] {
            let k = (j * self.w + i) * 4;
            match self.px.get(k..k + 3) {
                Some(&[r, g, b]) => [f64::from(r), f64::from(g), f64::from(b)],
                _ => [0.0; 3],
            }
        };
        let (a, b, c, d) = (texel(i0, j0), texel(i1, j0), texel(i0, j1), texel(i1, j1));
        let mut out = [0.0; 3];
        for (k, o) in out.iter_mut().enumerate() {
            let top = a[k] + (b[k] - a[k]) * fx;
            let bottom = c[k] + (d[k] - c[k]) * fx;
            *o = (top + (bottom - top) * fy) / 255.0;
        }
        out
    }

    /// The next level down: half the size (at least 1), each texel the rounded mean of its 2 × 2 parents.
    fn half(&self) -> Level<'static> {
        let (w, h) = ((self.w / 2).max(1), (self.h / 2).max(1));
        let mut px = vec![0_u8; w * h * 4];
        let src = &self.px;
        let at = |i: usize, j: usize, c: usize| -> u32 {
            let (i, j) = (i.min(self.w - 1), j.min(self.h - 1));
            src.get((j * self.w + i) * 4 + c)
                .map_or(0, |&v| u32::from(v))
        };
        for (j, row) in px.chunks_exact_mut(w * 4).enumerate() {
            for (i, texel) in row.chunks_exact_mut(4).enumerate() {
                for (c, o) in texel.iter_mut().enumerate() {
                    let sum = at(2 * i, 2 * j, c)
                        + at(2 * i + 1, 2 * j, c)
                        + at(2 * i, 2 * j + 1, c)
                        + at(2 * i + 1, 2 * j + 1, c);
                    *o = u8::try_from((sum + 2) / 4).unwrap_or(u8::MAX);
                }
            }
        }
        Level {
            w,
            h,
            px: std::borrow::Cow::Owned(px),
        }
    }
}

/// The photo's mip chain, down to 1 × 1 (level 0 borrowed).
fn mip_chain<'a>(photo: &Rgba8<'a>) -> Vec<Level<'a>> {
    let mut levels = vec![Level {
        w: photo.width,
        h: photo.height,
        px: std::borrow::Cow::Borrowed(photo.pixels),
    }];
    while let Some(last) = levels.last() {
        if last.w == 1 && last.h == 1 {
            break;
        }
        let next = last.half();
        levels.push(next);
    }
    levels
}

/// Trilinear at level of detail `lod` (≤ 0: level 0 bilinear).
#[allow(
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss
)]
fn trilinear(levels: &[Level<'_>], s: f64, t: f64, lod: f64) -> [f64; 3] {
    let top = levels.len().saturating_sub(1);
    let Some(first) = levels.first() else {
        return [0.0; 3];
    };
    if lod.is_nan() || lod <= 0.0 {
        return first.bilinear(s, t);
    }
    let lod = lod.min(top as f64);
    let d1 = lod.floor() as usize;
    let f = lod - lod.floor();
    let a = levels.get(d1).map_or([0.0; 3], |l| l.bilinear(s, t));
    if f == 0.0 || d1 >= top {
        return a;
    }
    let b = levels.get(d1 + 1).map_or([0.0; 3], |l| l.bilinear(s, t));
    [
        a[0] + (b[0] - a[0]) * f,
        a[1] + (b[1] - a[1]) * f,
        a[2] + (b[2] - a[2]) * f,
    ]
}

/// The largest map made: 16 M texels (v1's is 512 × 256), so the output and scratch allocations stay bounded.
pub const MAX_ENV_TEXELS: usize = 1 << 24;

fn check(photo: &Rgba8<'_>, spec: &EnvSpec, out_len: usize) -> Result<usize, EnvError> {
    if photo.width == 0 || photo.height == 0 || spec.width == 0 || spec.height == 0 {
        return Err(EnvError::BadSize);
    }
    if spec
        .width
        .checked_mul(spec.height)
        .is_none_or(|n| n > MAX_ENV_TEXELS)
    {
        return Err(EnvError::BadSize);
    }
    let need = photo
        .width
        .checked_mul(photo.height)
        .and_then(|n| n.checked_mul(4))
        .ok_or(EnvError::BadSize)?;
    let n = spec
        .width
        .checked_mul(spec.height)
        .ok_or(EnvError::BadSize)?;
    if photo.pixels.len() != need || out_len != n.checked_mul(4).ok_or(EnvError::BadSize)? {
        return Err(EnvError::WrongLength);
    }
    Ok(n)
}

/// Makes the map as RGBA f32 into `out` (`width · height · 4`; alpha 1).
///
/// # Errors
/// [`EnvError`] for zero sizes or buffers of the wrong length.
pub fn env_map(photo: &Rgba8<'_>, spec: &EnvSpec, out: &mut [f32]) -> Result<(), EnvError> {
    env_map_with(photo, spec, out.len(), |k, rgb| {
        if let Some(px) = out.get_mut(k * 4..k * 4 + 4) {
            #[allow(clippy::cast_possible_truncation)] // the f32 texture
            px.copy_from_slice(&[rgb[0] as f32, rgb[1] as f32, rgb[2] as f32, 1.0]);
        }
    })
}

/// Makes the map as RGBA binary16 bits into `out` (`width · height · 4`; alpha 1), for a `HalfFloatType` texture.
///
/// # Errors
/// [`EnvError`] for zero sizes or buffers of the wrong length.
pub fn env_map_f16(photo: &Rgba8<'_>, spec: &EnvSpec, out: &mut [u16]) -> Result<(), EnvError> {
    env_map_with(photo, spec, out.len(), |k, rgb| {
        if let Some(px) = out.get_mut(k * 4..k * 4 + 4) {
            #[allow(clippy::cast_possible_truncation)] // to f32, then to binary16
            px.copy_from_slice(&[
                f32_to_f16(rgb[0] as f32),
                f32_to_f16(rgb[1] as f32),
                f32_to_f16(rgb[2] as f32),
                0x3c00,
            ]);
        }
    })
}

fn env_map_with(
    photo: &Rgba8<'_>,
    spec: &EnvSpec,
    out_len: usize,
    mut put: impl FnMut(usize, [f64; 3]),
) -> Result<(), EnvError> {
    let n = check(photo, spec, out_len)?;
    let inverse = AcesInverse::new();
    let finish = |rgb: [f64; 3]| inverse.apply(rgb.map(srgb_to_linear));
    let (w, h) = (spec.width, spec.height);
    let mut uv = Vec::with_capacity(n);
    for j in 0..h {
        for i in 0..w {
            uv.push(photo_uv(spec, i, j));
        }
    }
    let levels = match spec.filter {
        EnvFilter::Bilinear => vec![Level {
            w: photo.width,
            h: photo.height,
            px: std::borrow::Cow::Borrowed(photo.pixels),
        }],
        EnvFilter::Mipmapped { .. } => mip_chain(photo),
    };
    let max_aniso = match spec.filter {
        EnvFilter::Bilinear => 1,
        EnvFilter::Mipmapped { max_anisotropy } => max_anisotropy.max(1),
    };
    #[allow(clippy::cast_precision_loss)]
    let (tw, th) = (photo.width as f64, photo.height as f64);
    let at = |i: usize, j: usize| uv.get(j * w + i).copied().unwrap_or([0.0; 2]);
    for j in 0..h {
        for i in 0..w {
            let k = j * w + i;
            let [s, t] = at(i, j);
            let rgb = if spec.filter == EnvFilter::Bilinear {
                levels.first().map_or([0.0; 3], |l| l.bilinear(s, t))
            } else {
                // Derivatives within the pixel's 2 × 2 quad (along its own row and column), as a GPU computes them.
                let (i0, j0) = (i & !1, j & !1);
                let dx = if i0 + 1 < w {
                    sub2(at(i0 + 1, j), at(i0, j))
                } else {
                    sub2(at(i0, j), at(i0.saturating_sub(1), j))
                };
                let dy = if j0 + 1 < h {
                    sub2(at(i, j0 + 1), at(i, j0))
                } else {
                    sub2(at(i, j0), at(i, j0.saturating_sub(1)))
                };
                anisotropic(&levels, [s, t], dx, dy, tw, th, max_aniso)
            };
            put(k, finish(rgb));
        }
    }
    Ok(())
}

fn sub2(a: [f64; 2], b: [f64; 2]) -> [f64; 2] {
    [a[0] - b[0], a[1] - b[1]]
}

/// The anisotropic lookup of `EXT_texture_filter_anisotropic`'s reference: N = min(⌈Pmax / Pmin⌉, max) trilinear
/// samples along the major axis at the level of detail log2(Pmax / N).
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn anisotropic(
    levels: &[Level<'_>],
    st: [f64; 2],
    dx: [f64; 2],
    dy: [f64; 2],
    tw: f64,
    th: f64,
    max_aniso: u8,
) -> [f64; 3] {
    let px = (dx[0] * tw).hypot(dx[1] * th);
    let py = (dy[0] * tw).hypot(dy[1] * th);
    let (pmax, pmin, major) = if px >= py { (px, py, dx) } else { (py, px, dy) };
    if pmax.is_nan() || pmax <= 0.0 {
        return trilinear(levels, st[0], st[1], 0.0);
    }
    let ratio = if pmin > 0.0 {
        (pmax / pmin).ceil()
    } else {
        f64::INFINITY
    };
    let n = ratio.min(f64::from(max_aniso)).max(1.0);
    let lod = (pmax / n).log2();
    let count = n as usize;
    let mut sum = [0.0; 3];
    for k in 0..count {
        #[allow(clippy::cast_precision_loss)]
        let off = (k as f64 + 0.5) / n - 0.5;
        let c = trilinear(levels, st[0] + major[0] * off, st[1] + major[1] * off, lod);
        for (s, v) in sum.iter_mut().zip(c) {
            *s += v;
        }
    }
    sum.map(|v| v / n)
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp)]
    use super::*;
    use crate::color::ACES_IN;
    use midstudy_geom::{Camera, CameraBlock};

    fn flat_photo(w: usize, h: usize, rgb: [u8; 3]) -> Vec<u8> {
        (0..w * h)
            .flat_map(|_| [rgb[0], rgb[1], rgb[2], 255])
            .collect()
    }

    #[test]
    fn a_flat_photo_gives_a_flat_map() {
        let cam = Camera::new(
            CameraBlock {
                fov_y_deg: 55.0,
                height_m: 1.4,
                pitch_deg: -10.0,
                roll_deg: 2.0,
            },
            64.0,
            48.0,
        );
        let px = flat_photo(64, 48, [180, 120, 60]);
        let photo = Rgba8 {
            width: 64,
            height: 48,
            pixels: &px,
        };
        let want =
            AcesInverse::new().apply([180.0, 120.0, 60.0].map(|v| srgb_to_linear(v / 255.0)));
        for filter in [
            EnvFilter::Bilinear,
            EnvFilter::Mipmapped { max_anisotropy: 4 },
        ] {
            let spec = EnvSpec {
                width: 32,
                height: 16,
                filter,
                ..EnvSpec::v1(&cam.rotation(), 55.0, 64.0, 48.0)
            };
            let mut out = vec![0.0_f32; 32 * 16 * 4];
            env_map(&photo, &spec, &mut out).unwrap();
            for px in out.chunks_exact(4) {
                for c in 0..3 {
                    assert!(
                        (f64::from(px[c]) - want[c]).abs() < 1e-6,
                        "{px:?} vs {want:?}"
                    );
                }
                assert_eq!(px[3], 1.0);
            }
        }
        let _ = ACES_IN;
    }

    #[test]
    fn straight_ahead_sees_the_photo_centre_and_behind_is_mirrored() {
        let cam = Camera::new(
            CameraBlock {
                fov_y_deg: 60.0,
                height_m: 1.4,
                pitch_deg: 0.0,
                roll_deg: 0.0,
            },
            400.0,
            300.0,
        );
        let spec = EnvSpec::v1(&cam.rotation(), 60.0, 400.0, 300.0);
        // −Z is φ = −π/2 (u = 1/4), θ = 0 (v = 1/2): the centre of the photo.
        let d = uv_of_dir(&spec, [0.0, 0.0, -1.0]);
        assert!((d[0] - 0.5).abs() < 1e-12 && (d[1] - 0.5).abs() < 1e-12);
        // +Z (behind) mirrors to the centre too; up-and-behind mirrors to up.
        let b = uv_of_dir(&spec, [0.0, 0.0, 1.0]);
        assert!((b[0] - 0.5).abs() < 1e-12 && (b[1] - 0.5).abs() < 1e-12);
        let up = uv_of_dir(&spec, [0.0, 0.2, 1.0]);
        assert!(up[1] < 0.5);
        // Far right is clamped to the right edge.
        assert_eq!(uv_of_dir(&spec, [1.0, 0.0, -0.01])[0], 1.0);
        // Pixel (128, 128) of a 512 × 256 map: u = 128.5/512 ≈ ¼.
        let p = photo_uv(&spec, 127, 127);
        assert!((p[0] - 0.5).abs() < 0.02 && (p[1] - 0.5).abs() < 0.02);
    }

    #[test]
    fn refuses_bad_buffers() {
        let px = flat_photo(4, 4, [0, 0, 0]);
        let cam = Camera::new(
            CameraBlock {
                fov_y_deg: 60.0,
                height_m: 1.4,
                pitch_deg: 0.0,
                roll_deg: 0.0,
            },
            4.0,
            4.0,
        );
        let spec = EnvSpec::v1(&cam.rotation(), 60.0, 4.0, 4.0);
        let photo = Rgba8 {
            width: 4,
            height: 4,
            pixels: &px[1..],
        };
        assert_eq!(
            env_map(&photo, &spec, &mut vec![0.0; ENV_WIDTH * ENV_HEIGHT * 4]),
            Err(EnvError::WrongLength)
        );
        let photo = Rgba8 {
            width: 4,
            height: 4,
            pixels: &px,
        };
        assert_eq!(
            env_map(&photo, &spec, &mut [0.0; 3]),
            Err(EnvError::WrongLength)
        );
        let mut half = vec![0_u16; ENV_WIDTH * ENV_HEIGHT * 4];
        assert!(env_map_f16(&photo, &spec, &mut half).is_ok());
    }
}
