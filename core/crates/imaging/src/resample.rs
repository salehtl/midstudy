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

/// `ImagingResample(…, LANCZOS, box)` of `channels`-sample pixels (`src` is `w × h`), into `ow × oh`.
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
    let (ksize_h, bounds_h, kh) = coeffs(w, bx[0], bx[2], ow);
    let (ksize_v, mut bounds_v, kv) = coeffs(h, bx[1], bx[3], oh);
    let first = bounds_v.first().map_or(0, |b| b.0);
    let last = bounds_v.last().map_or(h, |b| b.0 + b.1);
    let (mut cur, mut cw, mut ch) = (src.to_vec(), w, h);
    if need_h {
        for b in &mut bounds_v {
            b.0 -= first;
        }
        let rows = last - first;
        let mut tmp = vec![0u8; ow * rows * channels];
        for yy in 0..rows {
            let row = &src[(yy + first) * w * channels..(yy + first + 1) * w * channels];
            for (xx, &(xmin, n)) in bounds_h.iter().enumerate() {
                let k = &kh[xx * ksize_h..xx * ksize_h + n];
                for c in 0..channels {
                    let mut ss: i32 = 1 << (PRECISION_BITS - 1);
                    for (x, &kx) in k.iter().enumerate() {
                        ss = ss.wrapping_add(
                            i32::from(row[(x + xmin) * channels + c]).wrapping_mul(kx),
                        );
                    }
                    tmp[(yy * ow + xx) * channels + c] = clip8(ss);
                }
            }
        }
        cur = tmp;
        cw = ow;
        ch = rows;
    }
    if need_v {
        let mut out = vec![0u8; cw * oh * channels];
        for (yy, &(ymin, n)) in bounds_v.iter().enumerate() {
            let k = &kv[yy * ksize_v..yy * ksize_v + n];
            for xx in 0..cw {
                for c in 0..channels {
                    let mut ss: i32 = 1 << (PRECISION_BITS - 1);
                    for (y, &ky) in k.iter().enumerate() {
                        ss = ss.wrapping_add(
                            i32::from(cur[((y + ymin) * cw + xx) * channels + c]).wrapping_mul(ky),
                        );
                    }
                    out[(yy * cw + xx) * channels + c] = clip8(ss);
                }
            }
        }
        cur = out;
        ch = oh;
    }
    debug_assert_eq!(cur.len(), cw * ch * channels);
    cur
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::indexing_slicing)]
mod tests {
    use super::*;

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
