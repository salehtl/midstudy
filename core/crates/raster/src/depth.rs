//! depth.png to metres (contract §4.2, §4.5): samples are millimetres along the view axis (§4.1's d), 0 = no
//! occluder. v1 (planner/engine.js `loadDepth`) stores `sample / 1000` in a `Float32Array`; with `scale` 1 this is
//! bit-identical. The occlusion pass multiplies by the depth scale (`midstudy_geom::camera::depth_scale`) each frame;
//! passing it here bakes it in instead.

use crate::png::{PngError, decode_gray};

/// A depth map in metres, rows top to bottom.
#[derive(Clone, Debug, PartialEq)]
pub struct DepthMap {
    /// Width in pixels.
    pub width: u32,
    /// Height in pixels.
    pub height: u32,
    /// `width · height` depths in metres; 0 where depth.png is 0.
    pub data: Vec<f32>,
}

/// One sample (mm) to metres: `f32(sample / 1000 · scale)`, computed in f64 and rounded once.
#[must_use]
#[allow(clippy::cast_possible_truncation)] // the f32 depth texture: rounding to f32 is the point
pub fn mm_to_m(sample: u16, scale: f64) -> f32 {
    ((f64::from(sample) / 1000.0) * scale) as f32
}

/// Every sample to metres into `out` (pairs up to the shorter of the two; extra entries of `out` are left alone).
/// With `scale` 1 the multiplication is exact, so this is v1's conversion.
///
/// With `scale` 1 (the planner's case) it multiplies by 0.001 instead of dividing by 1000: for every one of the 65,536
/// samples the f32 is the same bits (`tests::mm_to_m_into_is_mm_to_m` checks them all), and a multiplication is several
/// times cheaper than a division, in the SIMD loop too.
#[allow(clippy::cast_possible_truncation)] // the f32 depth texture: rounding to f32 is the point
#[allow(clippy::float_cmp)] // exactly 1: the case whose result is checked bit for bit
pub fn mm_to_m_into(samples: &[u16], scale: f64, out: &mut [f32]) {
    if scale == 1.0 {
        for (o, &s) in out.iter_mut().zip(samples) {
            *o = (f64::from(s) * 0.001) as f32;
        }
        return;
    }
    for (o, &s) in out.iter_mut().zip(samples) {
        *o = mm_to_m(s, scale);
    }
}

/// Decodes depth.png straight to metres.
///
/// # Errors
/// The decoder's [`PngError`].
pub fn decode_depth_m(png: &[u8], scale: f64) -> Result<DepthMap, PngError> {
    let g = decode_gray(png)?;
    let mut data = vec![0.0_f32; g.samples.len()];
    mm_to_m_into(&g.samples, scale, &mut data);
    Ok(DepthMap {
        width: g.width,
        height: g.height,
        data,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_v1s_float32_of_mm_over_1000() {
        // v1: Float32Array element = Number(sample) / 1000, rounded to f32 on store; every 16-bit value.
        for s in (0..=u16::MAX).step_by(if cfg!(miri) { 251 } else { 1 }) {
            #[allow(clippy::cast_possible_truncation)]
            let v1 = (f64::from(s) / 1000.0) as f32;
            assert_eq!(mm_to_m(s, 1.0).to_bits(), v1.to_bits());
        }
    }

    #[test]
    fn mm_to_m_into_is_mm_to_m() {
        // Every sample, both paths (scale 1 multiplies by 0.001; any other scale divides by 1000, then scales).
        let samples: Vec<u16> = (0..=u16::MAX)
            .step_by(if cfg!(miri) { 251 } else { 1 })
            .collect();
        for scale in [1.0, 0.5, 1.37, 2.0] {
            let mut out = vec![0.0_f32; samples.len()];
            mm_to_m_into(&samples, scale, &mut out);
            for (&s, &o) in samples.iter().zip(&out) {
                assert_eq!(
                    o.to_bits(),
                    mm_to_m(s, scale).to_bits(),
                    "{s} at scale {scale}"
                );
            }
        }
    }
}
