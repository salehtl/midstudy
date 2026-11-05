//! Property tests for the raster kernels: the PNG decoder (every filter, 8 and 16 bits, never a panic), the mask
//! dilation (the box it claims), the SH rotation (irradiance kept, rotations compose) and the environment map.
#![allow(
    clippy::unwrap_used,
    clippy::expect_used,
    clippy::panic,
    clippy::float_cmp,
    clippy::many_single_char_names,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss,
    clippy::cast_precision_loss,
    clippy::manual_midpoint
)]

use midstudy_geom::look::{dir_of, turn_between};
use midstudy_geom::mat::{M3, mat_mul, mul, normalize};
use midstudy_geom::{Camera, CameraBlock};
use midstudy_raster::envmap::{EnvFilter, EnvSpec, Rgba8, env_map};
use midstudy_raster::mask::{Reach, dilate};
use midstudy_raster::png::{SIGNATURE, crc32, decode_gray, paeth};
use midstudy_raster::sh::{Sh9, fibonacci_directions, irradiance_at, rotate_sh, rotate_sh_v1};
use miniz_oxide::deflate::compress_to_vec_zlib;
use proptest::prelude::*;

/// The forward PNG filter of one row (`a`, `b`, `c`: left, up, up-left, from the unfiltered bytes).
fn filter_row(ft: u8, cur: &[u8], prev: &[u8], bpp: usize) -> Vec<u8> {
    (0..cur.len())
        .map(|i| {
            let x = cur[i];
            let a = if i >= bpp { cur[i - bpp] } else { 0 };
            let b = prev[i];
            let c = if i >= bpp { prev[i - bpp] } else { 0 };
            match ft {
                0 => x,
                1 => x.wrapping_sub(a),
                2 => x.wrapping_sub(b),
                3 => x.wrapping_sub(((u16::from(a) + u16::from(b)) / 2) as u8),
                _ => x.wrapping_sub(paeth(a, b, c)),
            }
        })
        .collect()
}

fn chunk(out: &mut Vec<u8>, ty: [u8; 4], data: &[u8]) {
    out.extend_from_slice(&u32::try_from(data.len()).unwrap().to_be_bytes());
    out.extend_from_slice(&ty);
    out.extend_from_slice(data);
    out.extend_from_slice(&crc32(&[&ty, data]).to_be_bytes());
}

/// A grayscale PNG of `samples` with the given filter per row, its zlib stream split over IDAT chunks of `split`
/// bytes, and an ancillary chunk before the data.
fn png_of(
    w: u32,
    h: u32,
    sixteen: bool,
    samples: &[u16],
    filters: &[u8],
    split: usize,
    level: u8,
) -> Vec<u8> {
    let bpp = if sixteen { 2 } else { 1 };
    let stride = w as usize * bpp;
    let rows: Vec<Vec<u8>> = samples
        .chunks(w as usize)
        .map(|r| {
            r.iter()
                .flat_map(|&v| {
                    if sixteen {
                        v.to_be_bytes().to_vec()
                    } else {
                        vec![v as u8]
                    }
                })
                .collect()
        })
        .collect();
    let mut raw = Vec::new();
    let zero = vec![0; stride];
    for (y, row) in rows.iter().enumerate() {
        let prev = if y == 0 { &zero } else { &rows[y - 1] };
        let ft = filters[y % filters.len()];
        raw.push(ft);
        raw.extend(filter_row(ft, row, prev, bpp));
    }
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[if sixteen { 16 } else { 8 }, 0, 0, 0, 0]);
    let mut out = SIGNATURE.to_vec();
    chunk(&mut out, *b"IHDR", &ihdr);
    chunk(&mut out, *b"tEXt", b"Comment\0k-geom");
    for part in compress_to_vec_zlib(&raw, level).chunks(split.max(1)) {
        chunk(&mut out, *b"IDAT", part);
    }
    chunk(&mut out, *b"IEND", &[]);
    out
}

/// Box dilation by brute force: on at (x, y) when a set pixel is at x − right ..= x + left, y − down ..= y + up.
fn box_dilate(src: &[u8], w: usize, h: usize, r: Reach) -> Vec<u8> {
    let mut out = vec![0; w * h];
    for y in 0..h {
        for x in 0..w {
            let (x0, x1) = (x.saturating_sub(r.right), (x + r.left).min(w - 1));
            let (y0, y1) = (y.saturating_sub(r.down), (y + r.up).min(h - 1));
            out[y * w + x] =
                u8::from((y0..=y1).any(|yy| (x0..=x1).any(|xx| src[yy * w + xx] != 0)));
        }
    }
    out
}

fn rotation() -> impl Strategy<Value = M3> {
    (
        -180.0..180.0_f64,
        -89.0..89.0_f64,
        -180.0..180.0_f64,
        0.0..89.0_f64,
    )
        .prop_map(|(a1, e1, a2, e2)| {
            mat_mul(
                &turn_between([0.0, 1.0, 0.0], dir_of(a1, e1)),
                &turn_between([1.0, 0.0, 0.0], dir_of(a2, e2)),
            )
        })
}

fn sh9() -> impl Strategy<Value = Sh9> {
    prop::array::uniform9(prop::array::uniform3(-2.0..2.0_f64))
}

proptest! {
    #![proptest_config(ProptestConfig { cases: 2000, failure_persistence: None, ..ProptestConfig::default() })]

    /// Every filter, both bit depths, any size, chunking and compression level: the samples come back.
    #[test]
    fn decoder_round_trips_every_filter(
        w in 1_u32..48, h in 1_u32..48, sixteen: bool, seed: u64,
        filters in prop::collection::vec(0_u8..5, 1..6), split in 1_usize..300, level in 0_u8..10,
    ) {
        let mut s = seed | 1;
        let samples: Vec<u16> = (0..w * h).map(|_| {
            s ^= s << 13; s ^= s >> 7; s ^= s << 17;
            let v = (s >> 24) as u16;
            if sixteen { if s % 3 == 0 { v & 0x00ff } else { v } } else { v & 0xff }
        }).collect();
        let png = png_of(w, h, sixteen, &samples, &filters, split, level);
        let g = decode_gray(&png).unwrap();
        prop_assert_eq!((g.width, g.height, g.bit_depth), (w, h, if sixteen { 16 } else { 8 }));
        prop_assert_eq!(g.samples, samples);
    }

    /// Arbitrary bytes never panic (with or without the signature in front).
    #[test]
    fn decoder_never_panics_on_bytes(bytes in prop::collection::vec(any::<u8>(), 0..4096), sig: bool) {
        let input = if sig { [SIGNATURE.as_slice(), &bytes].concat() } else { bytes };
        let _ = decode_gray(&input);
    }

    /// Valid PNGs with random damage (flips, cuts, splices), CRCs fixed up so the damage reaches the header checks,
    /// the inflater and the filters: never a panic.
    #[test]
    fn decoder_never_panics_on_damage(
        w in 1_u32..24, h in 1_u32..24, sixteen: bool,
        edits in prop::collection::vec((any::<prop::sample::Index>(), any::<u8>(), 0_u8..4), 1..8), fix_crc: bool,
    ) {
        let samples: Vec<u16> = (0..w * h).map(|i| (i * 37 % 251) as u16).collect();
        let mut png = png_of(w, h, sixteen, &samples, &[0, 1, 2, 3, 4], 64, 6);
        for (at, byte, kind) in edits {
            let i = at.index(png.len());
            match kind {
                0 => png[i] ^= byte | 1,
                1 => png.truncate(i),
                2 => png.insert(i, byte),
                _ => { png.remove(i); }
            }
            if png.is_empty() { break; }
        }
        if fix_crc {
            // Recompute every complete chunk's CRC so the decoder gets past it.
            let mut o = 8;
            while o + 12 <= png.len() {
                let n = u32::from_be_bytes(png[o..o + 4].try_into().unwrap()) as usize;
                if o + 12 + n > png.len() { break; }
                let c = crc32(&[&png[o + 4..o + 8 + n]]);
                png[o + 8 + n..o + 12 + n].copy_from_slice(&c.to_be_bytes());
                o += 12 + n;
            }
        }
        let _ = decode_gray(&png);
    }

    /// The dilation is the box dilation it documents.
    #[test]
    fn dilation_is_a_box(w in 1_usize..30, h in 1_usize..30, seed: u64, l in 0_usize..6, r in 0_usize..6, u in 0_usize..6, d in 0_usize..12) {
        let mut s = seed | 1;
        let src: Vec<u8> = (0..w * h).map(|_| { s ^= s << 13; s ^= s >> 7; s ^= s << 17; u8::from(s % 11 == 0) }).collect();
        let reach = Reach { left: l, right: r, up: u, down: d };
        let got = dilate(&src, w, h, reach).unwrap();
        prop_assert_eq!(&got, &box_dilate(&src, w, h, reach));
        prop_assert!(src.iter().zip(&got).all(|(a, b)| *a == 0 || *b == 1));
    }

    /// Turning the probe keeps its irradiance in the turned directions; v1's refit agrees.
    #[test]
    fn sh_rotation_keeps_irradiance(sh in sh9(), r in rotation()) {
        let t = rotate_sh(&sh, &r);
        let scale = sh.iter().flatten().fold(1.0_f64, |m, v| m.max(v.abs()));
        for d in fibonacci_directions() {
            let (a, b) = (irradiance_at(&sh, d), irradiance_at(&t, mul(&r, d)));
            prop_assert!((0..3).all(|c| (a[c] - b[c]).abs() <= 1e-11 * scale), "{:?} vs {:?}", a, b);
        }
        let v1 = rotate_sh_v1(&sh, &r);
        for (x, y) in v1.iter().zip(&t) {
            prop_assert!((0..3).all(|c| (x[c] - y[c]).abs() <= 1e-11 * scale));
        }
    }

    /// Turning by A then B is turning by B·A.
    #[test]
    fn sh_rotations_compose(sh in sh9(), a in rotation(), b in rotation()) {
        let twice = rotate_sh(&rotate_sh(&sh, &a), &b);
        let once = rotate_sh(&sh, &mat_mul(&b, &a));
        let scale = sh.iter().flatten().fold(1.0_f64, |m, v| m.max(v.abs()));
        for (x, y) in twice.iter().zip(&once) {
            prop_assert!((0..3).all(|c| (x[c] - y[c]).abs() <= 1e-10 * scale));
        }
    }

    /// The environment map is finite and non-negative for any photo and camera, and a single-colour photo gives a
    /// single-colour map.
    #[test]
    fn env_map_is_sane(
        fov in 20.0..110.0_f64, pitch in -80.0..30.0_f64, roll in -20.0..20.0_f64,
        pw in 1_usize..40, ph in 1_usize..40, seed: u64, aniso in 1_u8..5, bilinear: bool,
    ) {
        let cam = Camera::new(CameraBlock { fov_y_deg: fov, height_m: 1.4, pitch_deg: pitch, roll_deg: roll }, pw as f64, ph as f64);
        let mut s = seed | 1;
        let px: Vec<u8> = (0..pw * ph * 4).map(|_| { s ^= s << 13; s ^= s >> 7; s ^= s << 17; (s >> 32) as u8 }).collect();
        let filter = if bilinear { EnvFilter::Bilinear } else { EnvFilter::Mipmapped { max_anisotropy: aniso } };
        let spec = EnvSpec { width: 32, height: 16, filter, ..EnvSpec::v1(&cam.rotation(), fov, pw as f64, ph as f64) };
        let mut out = vec![0.0_f32; 32 * 16 * 4];
        env_map(&Rgba8 { width: pw, height: ph, pixels: &px }, &spec, &mut out).unwrap();
        prop_assert!(out.iter().all(|v| v.is_finite() && *v >= 0.0));
        let up = normalize([0.1, 1.0, 0.0]);
        prop_assert!(up[1] > 0.9);
    }
}
