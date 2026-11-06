//! `splat.spz` (contract §1; v1's `spz_bytes`, `read_spz`, `write_spz`): SPZ version 2, Niantic's layout, before
//! gzip (the caller compresses with zlib, as v1's `gzip.compress(…, mtime=0)`). A 16-byte header (magic "NGSP",
//! version 2, the count, SH degree 0, 12 fractional bits, flags 0, reserved 0), then the positions (24-bit fixed
//! point), alphas, colours, scales and rotations (x y z of the quaternion with w ≥ 0). Above 262,144 splats, the ones
//! that cover the most are kept: opacity × the area of their two largest axes.

use crate::ply::{Ply, PlyError, read};

/// "NGSP".
pub const MAGIC: u32 = 0x5053_474E;
pub const VERSION: u32 = 2;
pub const FRACTIONAL_BITS: u8 = 12;
pub const MAX_SPLATS: usize = 262_144;
pub const COLOR_SCALE: f64 = 0.15;
/// Bytes per splat with SH degree 0: 9 position, 1 alpha, 3 colour, 3 scale, 3 rotation.
pub const BYTES_PER_SPLAT: usize = 19;

/// An encoded splat.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Spz {
    /// The uncompressed file.
    pub payload: Vec<u8>,
    pub count: usize,
    pub dropped: usize,
}

/// Why a splat couldn't be encoded.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SpzError {
    Ply(PlyError),
    /// A position beyond ±2²³ / 4096 m (2 km).
    TooLarge,
}

impl From<PlyError> for SpzError {
    fn from(e: PlyError) -> Self {
        SpzError::Ply(e)
    }
}

fn column<'a>(ply: &'a Ply, name: &str) -> Result<&'a [f64], SpzError> {
    ply.column(name)
        .ok_or_else(|| SpzError::Ply(PlyError::Missing(vec![name.to_string()])))
}

fn sigmoid(v: f64) -> f64 {
    1.0 / (1.0 + (-v.clamp(-60.0, 60.0)).exp())
}

/// numpy's `clip(round(v), 0, 255).astype(uint8)` (round half to even).
#[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
fn u8_of(v: f64) -> u8 {
    v.round_ties_even().clamp(0.0, 255.0) as u8
}

/// The splats `encode` keeps, ascending: all of them up to [`MAX_SPLATS`], else the ones that cover the most
/// (ties at the cut: the lower indices).
///
/// # Errors
/// When the PLY lacks the properties the ranking reads.
pub fn keep(ply: &Ply) -> Result<Vec<usize>, SpzError> {
    let n = ply.count;
    if n <= MAX_SPLATS {
        return Ok((0..n).collect());
    }
    let op = column(ply, "opacity")?;
    let s = [
        column(ply, "scale_0")?,
        column(ply, "scale_1")?,
        column(ply, "scale_2")?,
    ];
    let cover: Vec<f64> = (0..n)
        .map(|i| {
            let mut ls = [s[0][i], s[1][i], s[2][i]];
            ls.sort_by(f64::total_cmp);
            sigmoid(op[i]) * (ls[1] + ls[2]).exp()
        })
        .collect();
    let mut sorted = cover.clone();
    // the MAX_SPLATS-th largest
    let (_, cut, _) = sorted.select_nth_unstable_by(n - MAX_SPLATS, f64::total_cmp);
    let cut = *cut;
    let above = cover.iter().filter(|&&c| c.total_cmp(&cut).is_gt()).count();
    let mut ties = MAX_SPLATS - above;
    let mut out = Vec::with_capacity(MAX_SPLATS);
    for (i, &c) in cover.iter().enumerate() {
        match c.total_cmp(&cut) {
            std::cmp::Ordering::Greater => out.push(i),
            std::cmp::Ordering::Equal if ties > 0 => {
                ties -= 1;
                out.push(i);
            }
            _ => {}
        }
    }
    Ok(out)
}

/// The SPZ v2 file (uncompressed) for a splat PLY.
///
/// # Errors
/// [`SpzError`] for a PLY v1 wouldn't read, or positions too far out for 24-bit fixed point.
pub fn encode(bytes: &[u8]) -> Result<Spz, SpzError> {
    let ply = read(bytes)?;
    let kept = keep(&ply)?;
    let n = kept.len();
    let xyz = [column(&ply, "x")?, column(&ply, "y")?, column(&ply, "z")?];
    let op = column(&ply, "opacity")?;
    let dc = [
        column(&ply, "f_dc_0")?,
        column(&ply, "f_dc_1")?,
        column(&ply, "f_dc_2")?,
    ];
    let sc = [
        column(&ply, "scale_0")?,
        column(&ply, "scale_1")?,
        column(&ply, "scale_2")?,
    ];
    let rot = [
        column(&ply, "rot_0")?,
        column(&ply, "rot_1")?,
        column(&ply, "rot_2")?,
        column(&ply, "rot_3")?,
    ];

    let mut out = Vec::with_capacity(16 + n * BYTES_PER_SPLAT);
    out.extend_from_slice(&MAGIC.to_le_bytes());
    out.extend_from_slice(&VERSION.to_le_bytes());
    out.extend_from_slice(&u32::try_from(n).unwrap_or(u32::MAX).to_le_bytes());
    out.extend_from_slice(&[0, FRACTIONAL_BITS, 0, 0]);

    let lim = f64::from((1u32 << 23) - 1);
    let unit = f64::from(1u32 << FRACTIONAL_BITS);
    for &i in &kept {
        for axis in &xyz {
            let f = (axis[i] * unit).round_ties_even();
            if f.abs() > lim || f.is_nan() {
                return Err(SpzError::TooLarge);
            }
            #[allow(clippy::cast_possible_truncation)]
            let v = (f as i32) & 0x00FF_FFFF;
            out.extend_from_slice(&v.to_le_bytes()[..3]);
        }
    }
    for &i in &kept {
        out.push(u8_of(255.0 / (1.0 + (-op[i].clamp(-60.0, 60.0)).exp())));
    }
    let k = COLOR_SCALE * 255.0;
    for &i in &kept {
        for c in &dc {
            out.push(u8_of(c[i] * k + 127.5));
        }
    }
    for &i in &kept {
        for s in &sc {
            out.push(u8_of((s[i] + 10.0) * 16.0));
        }
    }
    for &i in &kept {
        let q = [rot[0][i], rot[1][i], rot[2][i], rot[3][i]];
        let norm = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
            .sqrt()
            .max(1e-30);
        let sign = if q[0] / norm < 0.0 { -1.0 } else { 1.0 };
        for c in &q[1..] {
            out.push(u8_of(sign * (c / norm) * 127.5 + 127.5));
        }
    }
    Ok(Spz {
        payload: out,
        count: n,
        dropped: ply.count - n,
    })
}

/// What reading a `splat.spz` back finds (v1's `read_spz` and `write_spz`'s checks).
#[derive(Clone, Debug, PartialEq)]
pub struct SpzCheck {
    pub magic: u32,
    pub version: u32,
    pub count: u32,
    pub sh_degree: u8,
    pub fractional_bits: u8,
    pub flags: u8,
    /// The uncompressed length.
    pub len: usize,
    /// Whether it is the file `encode` writes (magic, version, SH 0, length = 16 + 19 × count).
    pub valid: bool,
    /// How many splats the PLY's kept set has.
    pub expected: usize,
    /// The largest distance, per coordinate, between a decoded position and its splat in the PLY (m); NaN unless
    /// `valid` and the counts agree.
    pub max_offset: f64,
}

/// Decodes a `splat.spz` (uncompressed) and compares its positions with the splats of the PLY it was made from.
///
/// # Errors
/// When the payload is shorter than its header, or the PLY can't be read.
#[allow(clippy::cast_precision_loss)]
pub fn check(payload: &[u8], ply_bytes: &[u8]) -> Result<SpzCheck, SpzError> {
    let head = payload
        .first_chunk::<16>()
        .ok_or(SpzError::Ply(PlyError::Truncated))?;
    let word = |i: usize| u32::from_le_bytes([head[i], head[i + 1], head[i + 2], head[i + 3]]);
    let (magic, version, count) = (word(0), word(4), word(8));
    let (sh_degree, fractional_bits, flags) = (head[12], head[13], head[14]);
    let len = payload.len();
    let valid = magic == MAGIC
        && version == VERSION
        && sh_degree == 0
        && usize::try_from(count)
            .ok()
            .and_then(|c| c.checked_mul(BYTES_PER_SPLAT))
            .and_then(|b| b.checked_add(16))
            == Some(len);
    let ply = read(ply_bytes)?;
    let kept = keep(&ply)?;
    let mut max_offset = f64::NAN;
    if valid && usize::try_from(count).ok() == Some(kept.len()) {
        let xyz = [column(&ply, "x")?, column(&ply, "y")?, column(&ply, "z")?];
        let unit = f64::from(1u32 << u32::from(fractional_bits.min(31)));
        let mut off: f64 = 0.0;
        for (j, &i) in kept.iter().enumerate() {
            for (axis, values) in xyz.iter().enumerate() {
                let at = 16 + j * 9 + axis * 3;
                let mut v = i32::from(payload[at])
                    | i32::from(payload[at + 1]) << 8
                    | i32::from(payload[at + 2]) << 16;
                if v & 0x80_0000 != 0 {
                    v -= 1 << 24;
                }
                #[allow(clippy::cast_possible_truncation)]
                let want = f64::from(values[i] as f32);
                off = off.max((f64::from(v) / unit - want).abs());
            }
        }
        max_offset = off;
    }
    Ok(SpzCheck {
        magic,
        version,
        count,
        sh_degree,
        fractional_bits,
        flags,
        len,
        valid,
        expected: kept.len(),
        max_offset,
    })
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::cast_precision_loss,
    clippy::float_cmp,
    clippy::format_push_string
)]
mod tests {
    use super::*;
    use crate::ply::REQUIRED;

    fn ply(n: usize, f: impl Fn(usize) -> [f32; 14]) -> Vec<u8> {
        let mut h = format!("ply\nformat binary_little_endian 1.0\nelement vertex {n}\n");
        for name in REQUIRED {
            h.push_str(&format!("property float {name}\n"));
        }
        h.push_str("end_header\n");
        let mut out = h.into_bytes();
        for i in 0..n {
            for v in f(i) {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    #[test]
    fn encodes_header_and_fields() {
        let b = ply(2, |i| {
            let x = i as f32 * 0.5 - 0.25;
            [
                x, 1.0, -1.0, 0.0, 1.0, -1.0, 0.0, -10.0, -9.0, -8.0, -1.0, 0.0, 0.0, 0.0,
            ]
        });
        let spz = encode(&b).unwrap();
        assert_eq!(spz.count, 2);
        assert_eq!(spz.payload.len(), 16 + 2 * 19);
        assert_eq!(&spz.payload[..4], b"NGSP");
        assert_eq!(&spz.payload[12..16], &[0, 12, 0, 0]);
        // x = -0.25 m → -1024 → 0xFFFC00
        assert_eq!(&spz.payload[16..19], &[0x00, 0xFC, 0xFF]);
        // alpha of opacity 0 is 127.5 → 128 (half to even)
        assert_eq!(spz.payload[16 + 18], 128);
        // colours: 0 → 127.5 → 128; 1 → 165.75 → 166; -1 → 89.25 → 89
        assert_eq!(&spz.payload[16 + 18 + 2..16 + 18 + 2 + 3], &[128, 166, 89]);
        // scales: (-10 + 10) × 16 = 0, 16, 32
        assert_eq!(
            &spz.payload[16 + 18 + 2 + 6..16 + 18 + 2 + 6 + 3],
            &[0, 16, 32]
        );
        // rotation (-1, 0, 0, 0) → w ≥ 0 → (1, 0, 0, 0): x y z = 127.5 → 128
        assert_eq!(
            &spz.payload[16 + 18 + 2 + 6 + 6..16 + 18 + 2 + 6 + 6 + 3],
            &[128, 128, 128]
        );
        let c = check(&spz.payload, &b).unwrap();
        assert!(c.valid && c.expected == 2 && c.max_offset < 0.000_25);
    }

    #[test]
    // 263,144 splats: hours under Miri; the native run covers it
    #[cfg_attr(miri, ignore)]
    fn keeps_the_ones_that_cover_the_most() {
        let n = MAX_SPLATS + 1000;
        let b = ply(n, |i| {
            let big = i % 2 == 0 && i < 4000;
            let s = if big { -2.0 } else { -6.0 };
            [
                i as f32 * 1e-4,
                0.0,
                0.0,
                0.0,
                0.0,
                0.0,
                5.0,
                s,
                s,
                s,
                1.0,
                0.0,
                0.0,
                0.0,
            ]
        });
        let spz = encode(&b).unwrap();
        assert_eq!((spz.count, spz.dropped), (MAX_SPLATS, 1000));
        let ply = read(&b).unwrap();
        let kept = keep(&ply).unwrap();
        assert!((0..4000).step_by(2).all(|i| kept.binary_search(&i).is_ok()));
        assert!(check(&spz.payload, &b).unwrap().max_offset < 0.000_25);
    }

    #[test]
    fn refuses_far_positions() {
        let b = ply(1, |_| {
            [
                3000.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0,
            ]
        });
        assert_eq!(encode(&b), Err(SpzError::TooLarge));
    }
}
