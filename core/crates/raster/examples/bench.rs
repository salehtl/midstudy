//! Native timings of the kernels on the sizes the planner uses (median of 9 runs, after a warm-up): depth.png
//! 1024 × 768 (the golden file, filter 0, and the same samples Paeth-filtered), the environment map at v1's 512 × 256
//! from a 2048 × 1536 photo, the keep-room mask at 2048 × 1152, and 10⁶ projections.
//! `cargo run --release -p midstudy-raster --example bench` (from core/).
#![allow(
    clippy::unwrap_used,
    clippy::cast_lossless,
    clippy::too_many_lines,
    clippy::cast_possible_truncation,
    clippy::cast_precision_loss,
    clippy::cast_sign_loss
)]

use midstudy_geom::{Camera, CameraBlock};
use midstudy_raster::envmap::{EnvFilter, EnvSpec, Rgba8, env_map, env_map_f16};
use midstudy_raster::mask::keep_room_mask;
use midstudy_raster::png::{SIGNATURE, crc32, decode_gray, paeth};
use std::hint::black_box;
use std::time::Instant;

fn median_ms(mut f: impl FnMut()) -> f64 {
    f();
    let mut t: Vec<f64> = (0..9)
        .map(|_| {
            let s = Instant::now();
            f();
            s.elapsed().as_secs_f64() * 1e3
        })
        .collect();
    t.sort_by(f64::total_cmp);
    t[4]
}

/// The same 16-bit samples with every row Paeth-filtered (what an adaptive encoder often picks).
fn paeth_png(w: u32, h: u32, samples: &[u16]) -> Vec<u8> {
    let stride = w as usize * 2;
    let rows: Vec<Vec<u8>> = samples
        .chunks(w as usize)
        .map(|r| r.iter().flat_map(|v| v.to_be_bytes()).collect())
        .collect();
    let mut raw = Vec::new();
    let zero = vec![0; stride];
    for (y, row) in rows.iter().enumerate() {
        let prev = if y == 0 { &zero } else { &rows[y - 1] };
        raw.push(4);
        for i in 0..stride {
            let (a, c) = if i >= 2 {
                (row[i - 2], prev[i - 2])
            } else {
                (0, 0)
            };
            raw.push(row[i].wrapping_sub(paeth(a, prev[i], c)));
        }
    }
    let mut out = SIGNATURE.to_vec();
    let mut chunk = |ty: &[u8; 4], data: &[u8]| {
        out.extend_from_slice(&(data.len() as u32).to_be_bytes());
        out.extend_from_slice(ty);
        out.extend_from_slice(data);
        out.extend_from_slice(&crc32(&[ty, data]).to_be_bytes());
    };
    let mut ihdr = w.to_be_bytes().to_vec();
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[16, 0, 0, 0, 0]);
    chunk(b"IHDR", &ihdr);
    chunk(
        b"IDAT",
        &miniz_oxide::deflate::compress_to_vec_zlib(&raw, 6),
    );
    chunk(b"IEND", &[]);
    out
}

fn main() {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../..");
    let golden = std::fs::read(root.join("fixtures/scenes/living-wide/depth.png")).unwrap();
    let g = decode_gray(&golden).unwrap();
    let paeth = paeth_png(g.width, g.height, &g.samples);
    println!(
        "depth.png 1024x768, filter 0 (golden, {} KB): {:.2} ms",
        golden.len() / 1024,
        median_ms(|| {
            black_box(midstudy_raster::depth::decode_depth_m(black_box(&golden), 1.0).unwrap());
        })
    );
    println!(
        "depth.png 1024x768, Paeth ({} KB): {:.2} ms",
        paeth.len() / 1024,
        median_ms(|| {
            black_box(midstudy_raster::depth::decode_depth_m(black_box(&paeth), 1.0).unwrap());
        })
    );

    let (pw, ph) = (2048_usize, 1536_usize);
    let photo: Vec<u8> = (0..pw * ph)
        .flat_map(|i| {
            let (x, y) = (i % pw, i / pw);
            [
                (x * 255 / pw) as u8,
                (y * 255 / ph) as u8,
                ((x ^ y) & 255) as u8,
                255,
            ]
        })
        .collect();
    let cam = Camera::new(
        CameraBlock {
            fov_y_deg: 55.0,
            height_m: 1.4,
            pitch_deg: -10.0,
            roll_deg: 2.0,
        },
        pw as f64,
        ph as f64,
    );
    let rgba = Rgba8 {
        width: pw,
        height: ph,
        pixels: &photo,
    };
    let spec = EnvSpec::v1(&cam.rotation(), 55.0, pw as f64, ph as f64);
    let mut out = vec![0.0_f32; 512 * 256 * 4];
    let mut half = vec![0_u16; 512 * 256 * 4];
    println!(
        "env map 512x256 from 2048x1536, mipmapped, anisotropy 4, half floats: {:.2} ms",
        median_ms(|| {
            env_map_f16(&rgba, &spec, &mut half).unwrap();
        })
    );
    let bil = EnvSpec {
        filter: EnvFilter::Bilinear,
        ..spec
    };
    println!(
        "env map 512x256 from 2048x1536, bilinear, f32: {:.2} ms",
        median_ms(|| {
            env_map(&rgba, &bil, &mut out).unwrap();
        })
    );

    let (mw, mh) = (2048_usize, 1152_usize);
    let mut readback = vec![0_u8; mw * mh * 4];
    for y in 300..800 {
        for x in 600..1300 {
            readback[(y * mw + x) * 4] = 255;
        }
    }
    println!(
        "keep-room mask 2048x1152: {:.2} ms",
        median_ms(|| {
            black_box(keep_room_mask(black_box(&readback), mw, mh, true).unwrap());
        })
    );
    let k = keep_room_mask(&readback, mw, mh, true).unwrap();
    println!(
        "keep-room mask PNG encode 2048x1152 (level 6): {:.2} ms",
        median_ms(|| {
            black_box(
                midstudy_raster::mask::encode_mask_png(&k.mask, mw as u32, mh as u32, 6).unwrap(),
            );
        })
    );

    let pts: Vec<[f64; 3]> = (0..1_000_000)
        .map(|i| {
            [
                (i % 1000) as f64 * 0.01 - 5.0,
                (i % 7) as f64 * 0.3,
                -1.0 - (i % 997) as f64 * 0.02,
            ]
        })
        .collect();
    let cam = Camera::new(
        CameraBlock {
            fov_y_deg: 65.0,
            height_m: 1.6,
            pitch_deg: -25.0,
            roll_deg: 2.0,
        },
        1600.0,
        1200.0,
    );
    println!(
        "10^6 projections: {:.2} ms",
        median_ms(|| {
            let mut acc = 0.0;
            for p in &pts {
                acc += cam.project(*p)[0];
            }
            black_box(acc);
        })
    );
}
