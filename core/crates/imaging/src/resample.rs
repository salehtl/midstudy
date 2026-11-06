//! Pillow's `Resample.c` for 8-bit images with the Lanczos filter: per-axis coefficients in double precision
//! (`precompute_coeffs`, the box given as C floats), turned into 22-bit fixed point (`normalize_coeffs_8bpc`), a
//! horizontal pass then a vertical one, each rounding to 8 bits.
#![allow(
    clippy::float_cmp,
    clippy::needless_range_loop,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_possible_wrap,
    clippy::cast_precision_loss,
    clippy::too_many_arguments
)]

const PRECISION_BITS: u32 = 32 - 8 - 2;

fn sinc(x: f64) -> f64 {
    if x == 0.0 {
        return 1.0;
    }
    let x = x * std::f64::consts::PI;
    x.sin() / x
}

fn lanczos(x: f64) -> f64 {
    if (-3.0..3.0).contains(&x) {
        sinc(x) * sinc(x / 3.0)
    } else {
        0.0
    }
}

/// (ksize, bounds as (xmin, count) per output pixel, fixed-point coefficients).
fn coeffs(
    in_size: usize,
    in0: f32,
    in1: f32,
    out_size: usize,
) -> (usize, Vec<(usize, usize)>, Vec<i32>) {
    let scale = f64::from(in1 - in0) / out_size as f64;
    let filterscale = scale.max(1.0);
    let support = 3.0 * filterscale;
    let ksize = support.ceil() as usize * 2 + 1;
    let mut kk = vec![0.0f64; out_size * ksize];
    let mut bounds = Vec::with_capacity(out_size);
    for xx in 0..out_size {
        let center = f64::from(in0) + (xx as f64 + 0.5) * scale;
        let ss = 1.0 / filterscale;
        let xmin = ((center - support + 0.5) as i64).max(0);
        let xmax = ((center + support + 0.5) as i64).min(in_size as i64) - xmin;
        let xmax = xmax.max(0) as usize;
        let xmin = xmin as usize;
        let k = &mut kk[xx * ksize..xx * ksize + ksize];
        let mut ww = 0.0;
        for x in 0..xmax.min(ksize) {
            let w = lanczos(((x + xmin) as f64 - center + 0.5) * ss);
            k[x] = w;
            ww += w;
        }
        for v in k.iter_mut().take(xmax.min(ksize)) {
            if ww != 0.0 {
                *v /= ww;
            }
        }
        bounds.push((xmin, xmax.min(ksize)));
    }
    let one = f64::from(1u32 << PRECISION_BITS);
    let fixed = kk
        .iter()
        .map(|&v| {
            if v < 0.0 {
                (-0.5 + v * one) as i32
            } else {
                (0.5 + v * one) as i32
            }
        })
        .collect();
    (ksize, bounds, fixed)
}

fn clip8(v: i32) -> u8 {
    (v >> PRECISION_BITS).clamp(0, 255) as u8
}

/// Pillow's `ResampleHorizontal_8bpc`: rows `offset..offset + rows` of `src` (`w` wide) into `ow` columns.
fn horizontal(
    src: &[u8],
    w: usize,
    channels: usize,
    offset: usize,
    rows: usize,
    ow: usize,
    bounds: &[(usize, usize)],
    ksize: usize,
    kk: &[i32],
) -> Vec<u8> {
    let mut out = vec![0u8; ow * rows * channels];
    for yy in 0..rows {
        let row = &src[(yy + offset) * w * channels..(yy + offset + 1) * w * channels];
        for (xx, &(xmin, n)) in bounds.iter().enumerate() {
            let k = &kk[xx * ksize..xx * ksize + n];
            for c in 0..channels {
                let mut ss: i32 = 1 << (PRECISION_BITS - 1);
                for (x, &kx) in k.iter().enumerate() {
                    ss =
                        ss.wrapping_add(i32::from(row[(x + xmin) * channels + c]).wrapping_mul(kx));
                }
                out[(yy * ow + xx) * channels + c] = clip8(ss);
            }
        }
    }
    out
}

/// Pillow's `ResampleVertical_8bpc`: `src` (`w` wide) into `bounds.len()` rows, each from its rows `ymin..ymin + n`.
fn vertical(
    src: &[u8],
    w: usize,
    channels: usize,
    bounds: &[(usize, usize)],
    ksize: usize,
    kk: &[i32],
) -> Vec<u8> {
    let mut out = vec![0u8; w * bounds.len() * channels];
    for (yy, &(ymin, n)) in bounds.iter().enumerate() {
        let k = &kk[yy * ksize..yy * ksize + n];
        for xx in 0..w {
            for c in 0..channels {
                let mut ss: i32 = 1 << (PRECISION_BITS - 1);
                for (y, &ky) in k.iter().enumerate() {
                    ss = ss.wrapping_add(
                        i32::from(src[((y + ymin) * w + xx) * channels + c]).wrapping_mul(ky),
                    );
                }
                out[(yy * w + xx) * channels + c] = clip8(ss);
            }
        }
    }
    out
}

/// `ImagingResample(…, LANCZOS, box)` of `channels`-sample pixels (`src` is `w × h`), into `ow × oh`: Pillow 13's
/// `ImagingResampleInner`, which runs the vertical pass first when the height shrinks by more than twice what the
/// width does (each pass rounds to 8 bits, so the order shows in the result).
#[must_use]
pub fn resample(
    src: &[u8],
    w: usize,
    h: usize,
    channels: usize,
    ow: usize,
    oh: usize,
    bx: [f32; 4],
) -> Vec<u8> {
    // _resize's shortcut: an integral box of exactly the output size is a crop
    if bx[0].fract() == 0.0
        && bx[2] - bx[0] == ow as f32
        && bx[1].fract() == 0.0
        && bx[3] - bx[1] == oh as f32
    {
        let (x0, y0) = (bx[0] as usize, bx[1] as usize);
        let mut out = Vec::with_capacity(ow * oh * channels);
        for y in y0..y0 + oh {
            out.extend_from_slice(&src[(y * w + x0) * channels..(y * w + x0 + ow) * channels]);
        }
        return out;
    }
    let need_h = ow != w || bx[0] != 0.0 || bx[2] != ow as f32;
    let need_v = oh != h || bx[1] != 0.0 || bx[3] != oh as f32;
    let (dy, dx) = (h as i64 - oh as i64, w as i64 - ow as i64);
    let horizontal_first = !(dy > 0 && dy > dx * 2);
    let (ksize_h, bounds_h, kh) = coeffs(w, bx[0], bx[2], ow);
    let (ksize_v, mut bounds_v, kv) = coeffs(h, bx[1], bx[3], oh);
    if horizontal_first {
        let mut cur = None;
        let mut cw = w;
        if need_h {
            // only the rows the vertical pass reads
            let first = bounds_v.first().map_or(0, |b| b.0);
            let last = bounds_v.last().map_or(h, |b| b.0 + b.1);
            for b in &mut bounds_v {
                b.0 -= first;
            }
            cur = Some(horizontal(
                src,
                w,
                channels,
                first,
                last - first,
                ow,
                &bounds_h,
                ksize_h,
                &kh,
            ));
            cw = ow;
        }
        if need_v {
            let input = cur.as_deref().unwrap_or(src);
            cur = Some(vertical(input, cw, channels, &bounds_v, ksize_v, &kv));
        }
        cur.unwrap_or_else(|| src.to_vec())
    } else {
        let mut cur = None;
        let mut rows = h;
        if need_v {
            cur = Some(vertical(src, w, channels, &bounds_v, ksize_v, &kv));
            rows = oh;
        }
        if need_h {
            let input = cur.as_deref().unwrap_or(src);
            cur = Some(horizontal(
                input, w, channels, 0, rows, ow, &bounds_h, ksize_h, &kh,
            ));
        }
        cur.unwrap_or_else(|| src.to_vec())
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

    #[test]
    #[cfg_attr(miri, ignore)] // thousands of splats or pixels: too slow under Miri; the native run covers it
    fn tall_shrinks_run_the_vertical_pass_first() {
        // a gradient whose 8-bit rounding differs between the pass orders: both orders stay within one level, and
        // the 360 x 480 -> 256 x 256 (rows 60..420) case is the one Pillow 13 runs vertical-first
        let src: Vec<u8> = (0..360 * 480)
            .map(|i| ((i * 37 + i / 360 * 11) % 251) as u8)
            .collect();
        let out = resample(&src, 360, 480, 1, 256, 256, [0.0, 60.0, 360.0, 420.0]);
        assert_eq!(out.len(), 256 * 256);
    }

    #[test]
    fn flat_stays_flat_and_crop_shortcut() {
        let src = vec![77u8; 50 * 40];
        let out = resample(&src, 50, 40, 1, 13, 9, [0.0, 0.0, 50.0, 40.0]);
        assert!(out.iter().all(|&v| v == 77));
        let g: Vec<u8> = (0..16).collect();
        assert_eq!(
            resample(&g, 4, 4, 1, 2, 2, [1.0, 1.0, 3.0, 3.0]),
            vec![5, 6, 9, 10]
        );
    }
}
