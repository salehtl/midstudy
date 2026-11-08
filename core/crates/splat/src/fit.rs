//! The per-axis fit of a splat to `--dims` (contract §1; v1's `splat.normalize` and `transform_covariances`): rotate
//! the centers into the item frame, measure the engine's percentile extent, center the footprint, put it on the
//! floor, scale each axis so the extent equals the dims, and stretch every Gaussian by the same linear map
//! (Σ' = A Σ Aᵀ with A = S·R, written back as `scale_*` and `rot_*` through the eigendecomposition). Higher-order SH
//! (`f_rest_*`) is dropped when the splat was rotated or stretched; `nx ny nz` always.

// The arithmetic is numpy's, operation for operation ((lo + hi) / 2, not f64::midpoint), so v1's positions come out
// bit for bit; matrix code keeps its textbook single-letter names.
#![allow(clippy::manual_midpoint, clippy::many_single_char_names)]

use crate::eigen::{Mat3, det3, eigh3, matrix_to_quat, mul3, quat_to_matrix};
use crate::ply::{Ply, PlyError, read};

/// The fit's inputs: the rotation into the item frame, the dims in metres (x = w, y = h, z = d) and the engine's
/// percentiles (v1: 0.1–99.9 for idol, 1–99 otherwise).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FitParams {
    pub rotation: Mat3,
    pub dims: [f64; 3],
    pub lo_pct: f64,
    pub hi_pct: f64,
}

/// The fitted splat, and what the self-check needs.
#[derive(Clone, Debug, PartialEq)]
pub struct Fit {
    /// The `splat.ply` to write.
    pub ply: Vec<u8>,
    /// How many `f_rest_*` properties were dropped (0 when none were, or none existed).
    pub dropped_rest: usize,
    /// Whether the rotation wasn't the identity (`numpy.allclose`), and whether the scale wasn't uniform.
    pub rotated: bool,
    pub stretched: bool,
    /// The percentile extent of the written (float32) centers, and whether they are all finite.
    pub lo: [f64; 3],
    pub hi: [f64; 3],
    pub finite: bool,
}

/// Why a splat couldn't be fitted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FitError {
    Ply(PlyError),
    /// The rotated centers aren't all finite.
    NonFinite,
    /// The extent along this axis (0 = X, 1 = Y, 2 = Z) is below 1 µm.
    Flat(usize),
}

impl From<PlyError> for FitError {
    fn from(e: PlyError) -> Self {
        FitError::Ply(e)
    }
}

/// numpy's `percentile(values, pct)` with the default linear method, bit for bit: the order statistics around
/// `(n − 1) · pct / 100`, then numpy's `_lerp` (a + (b − a)·t, or b − (b − a)·(1 − t) when t ≥ 0.5). `values` is
/// reordered.
#[must_use]
#[allow(
    clippy::cast_precision_loss,
    clippy::cast_possible_truncation,
    clippy::cast_sign_loss
)]
pub fn percentile(values: &mut [f64], pct: f64) -> f64 {
    let n = values.len();
    if n == 0 {
        return f64::NAN;
    }
    let q = pct / 100.0;
    let vi = (n - 1) as f64 * q;
    let (prev, next, prev_f) = if vi >= (n - 1) as f64 {
        (n - 1, n - 1, -1.0)
    } else if vi < 0.0 {
        (0, 0, 0.0)
    } else {
        let f = vi.floor();
        let p = f as usize;
        (p, p + 1, f)
    };
    let gamma = vi - prev_f;
    let (_, a, right) = values.select_nth_unstable_by(prev, f64::total_cmp);
    let a = *a;
    let b = if next == prev {
        a
    } else {
        right.iter().copied().min_by(f64::total_cmp).unwrap_or(a)
    };
    let diff = b - a;
    if gamma >= 0.5 {
        b - diff * (1.0 - gamma)
    } else {
        a + diff * gamma
    }
}

/// The percentile extent (lo, hi) of 3-D points given as three coordinate arrays.
#[must_use]
pub fn extent(xyz: &[Vec<f64>; 3], lo_pct: f64, hi_pct: f64) -> ([f64; 3], [f64; 3]) {
    let mut lo = [0.0; 3];
    let mut hi = [0.0; 3];
    let mut work = Vec::new();
    for axis in 0..3 {
        work.clear();
        work.extend_from_slice(&xyz[axis]);
        lo[axis] = percentile(&mut work, lo_pct);
        hi[axis] = percentile(&mut work, hi_pct);
    }
    (lo, hi)
}

fn allclose_identity(r: &Mat3) -> bool {
    (0..3).all(|i| {
        (0..3).all(|j| {
            let want = if i == j { 1.0 } else { 0.0 };
            (r[i][j] - want).abs() <= 1e-8 + 1e-5 * f64::abs(want)
        })
    })
}

fn col(ply: &Ply, name: &str) -> Result<usize, FitError> {
    ply.index(name)
        .ok_or_else(|| FitError::Ply(PlyError::Missing(vec![name.to_string()])))
}

/// Fits the splat in `bytes` (contract §1, v1's `normalize`).
///
/// # Errors
/// [`FitError`] for a PLY v1 wouldn't read, non-finite centers or a flat extent.
#[allow(clippy::too_many_lines)]
pub fn normalize(bytes: &[u8], p: &FitParams) -> Result<Fit, FitError> {
    let mut ply = read(bytes)?;
    ply.drop_props(&["nx", "ny", "nz"]);
    let ix = [col(&ply, "x")?, col(&ply, "y")?, col(&ply, "z")?];
    let n = ply.count;
    let r = p.rotation;

    // xyz = _xyz(data) @ rotation.T
    let mut xyz: [Vec<f64>; 3] = [
        Vec::with_capacity(n),
        Vec::with_capacity(n),
        Vec::with_capacity(n),
    ];
    {
        let (cx, cy, cz) = (
            &ply.columns[ix[0]],
            &ply.columns[ix[1]],
            &ply.columns[ix[2]],
        );
        for k in 0..n {
            let (x, y, z) = (cx[k], cy[k], cz[k]);
            for (j, out) in xyz.iter_mut().enumerate() {
                out.push(x * r[j][0] + y * r[j][1] + z * r[j][2]);
            }
        }
    }
    if xyz.iter().any(|a| a.iter().any(|v| !v.is_finite())) {
        return Err(FitError::NonFinite);
    }
    let (lo, hi) = extent(&xyz, p.lo_pct, p.hi_pct);
    let size = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    for (axis, s) in size.iter().enumerate() {
        if *s < 1e-6 {
            return Err(FitError::Flat(axis));
        }
    }
    let scale = [
        p.dims[0] / size[0],
        p.dims[1] / size[1],
        p.dims[2] / size[2],
    ];
    let center = [(lo[0] + hi[0]) / 2.0, lo[1], (lo[2] + hi[2]) / 2.0];
    for axis in 0..3 {
        let ty = ply.props[ix[axis]].ty;
        let column = &mut ply.columns[ix[axis]];
        for (dst, &v) in column.iter_mut().zip(&xyz[axis]) {
            *dst = ty.cast((v - center[axis]) * scale[axis]);
        }
    }
    drop(xyz);

    let rotated = !allclose_identity(&r);
    let smax = scale[0].max(scale[1]).max(scale[2]);
    let smin = scale[0].min(scale[1]).min(scale[2]);
    let stretched = smax / smin - 1.0 > 1e-6;

    // transform_covariances(data, diag(scale) @ rotation)
    let a: Mat3 = [
        [scale[0] * r[0][0], scale[0] * r[0][1], scale[0] * r[0][2]],
        [scale[1] * r[1][0], scale[1] * r[1][1], scale[1] * r[1][2]],
        [scale[2] * r[2][0], scale[2] * r[2][1], scale[2] * r[2][2]],
    ];
    let is = [
        col(&ply, "scale_0")?,
        col(&ply, "scale_1")?,
        col(&ply, "scale_2")?,
    ];
    let ir = [
        col(&ply, "rot_0")?,
        col(&ply, "rot_1")?,
        col(&ply, "rot_2")?,
        col(&ply, "rot_3")?,
    ];
    let ts = is.map(|i| ply.props[i].ty);
    let tr = ir.map(|i| ply.props[i].ty);
    for k in 0..n {
        let q = [
            ply.columns[ir[0]][k],
            ply.columns[ir[1]][k],
            ply.columns[ir[2]][k],
            ply.columns[ir[3]][k],
        ];
        let sigma = [
            ply.columns[is[0]][k].exp(),
            ply.columns[is[1]][k].exp(),
            ply.columns[is[2]][k].exp(),
        ];
        let (scales, quat) = stretch_one(&a, q, sigma);
        for c in 0..3 {
            ply.columns[is[c]][k] = ts[c].cast(scales[c].ln());
        }
        for c in 0..4 {
            ply.columns[ir[c]][k] = tr[c].cast(quat[c]);
        }
    }

    let rest: Vec<String> = ply
        .props
        .iter()
        .filter(|p| p.name.starts_with("f_rest_"))
        .map(|p| p.name.clone())
        .collect();
    let dropped_rest = if !rest.is_empty() && (rotated || stretched) {
        let names: Vec<&str> = rest.iter().map(String::as_str).collect();
        ply.drop_props(&names);
        rest.len()
    } else {
        0
    };
    let out = ply.to_bytes();

    // The self-check reads the written file back: its centers are the float32 values. Dropping `f_rest_*` moved any
    // column after it, so the centers are looked up again.
    let ix = [col(&ply, "x")?, col(&ply, "y")?, col(&ply, "z")?];
    #[allow(clippy::cast_possible_truncation)]
    let written: [Vec<f64>; 3] = ix.map(|i| {
        ply.columns[i]
            .iter()
            .map(|&v| f64::from(v as f32))
            .collect::<Vec<f64>>()
    });
    let finite = written.iter().all(|a| a.iter().all(|v| v.is_finite()));
    let (wlo, whi) = if finite {
        extent(&written, p.lo_pct, p.hi_pct)
    } else {
        ([f64::NAN; 3], [f64::NAN; 3])
    };
    Ok(Fit {
        ply: out,
        dropped_rest,
        rotated,
        stretched,
        lo: wlo,
        hi: whi,
        finite,
    })
}

/// One Gaussian through the linear map `a`: Σ' = A R diag(σ²) Rᵀ Aᵀ (symmetrized), its eigendecomposition (a
/// rotation, det +1), and the new σ (floored at 1e-14 of the largest variance, as v1) and quaternion (w ≥ 0).
#[must_use]
pub fn stretch_one(a: &Mat3, q: [f64; 4], sigma: [f64; 3]) -> ([f64; 3], [f64; 4]) {
    let rot = quat_to_matrix(q);
    let m = mul3(a, &rot);
    let s2 = [
        sigma[0] * sigma[0],
        sigma[1] * sigma[1],
        sigma[2] * sigma[2],
    ];
    let mut cov = [[0.0; 3]; 3];
    for (i, row) in cov.iter_mut().enumerate() {
        for (j, c) in row.iter_mut().enumerate() {
            *c = m[i][0] * s2[0] * m[j][0] + m[i][1] * s2[1] * m[j][1] + m[i][2] * s2[2] * m[j][2];
        }
    }
    let sym = [
        [
            cov[0][0],
            (cov[0][1] + cov[1][0]) / 2.0,
            (cov[0][2] + cov[2][0]) / 2.0,
        ],
        [
            (cov[1][0] + cov[0][1]) / 2.0,
            cov[1][1],
            (cov[1][2] + cov[2][1]) / 2.0,
        ],
        [
            (cov[2][0] + cov[0][2]) / 2.0,
            (cov[2][1] + cov[1][2]) / 2.0,
            cov[2][2],
        ],
    ];
    let (w, mut v) = eigh3(&sym);
    if det3(&v) < 0.0 {
        for row in &mut v {
            row[2] = -row[2];
        }
    }
    let floor = w[2].max(1e-30) * 1e-14;
    let lim = floor.max(1e-36);
    let s_new = [
        w[0].max(lim).sqrt(),
        w[1].max(lim).sqrt(),
        w[2].max(lim).sqrt(),
    ];
    (s_new, matrix_to_quat(&v))
}

#[cfg(test)]
#[allow(
    clippy::unwrap_used,
    clippy::indexing_slicing,
    clippy::float_cmp,
    clippy::cast_precision_loss,
    clippy::format_push_string
)]
mod tests {
    use super::*;
    use crate::eigen::IDENTITY;
    use crate::ply::REQUIRED;

    #[test]
    fn percentile_matches_numpy() {
        // numpy.percentile([0..9], 1) = 0.09, 99 = 8.91, 0.1 = 0.009, 50 = 4.5
        let base: Vec<f64> = (0..10).map(f64::from).collect();
        for (pct, want) in [
            (1.0, 0.09),
            (99.0, 8.91),
            (0.1, 0.009),
            (50.0, 4.5),
            (100.0, 9.0),
            (0.0, 0.0),
        ] {
            let mut v = base.clone();
            v.reverse();
            let got = percentile(&mut v, pct);
            assert!((got - want).abs() < 1e-12, "{pct}: {got} vs {want}");
        }
    }

    fn splat(points: &[[f32; 3]], extra: &[(&str, f32)]) -> Vec<u8> {
        let mut h = format!(
            "ply\nformat binary_little_endian 1.0\nelement vertex {}\n",
            points.len()
        );
        for n in REQUIRED {
            h.push_str(&format!("property float {n}\n"));
        }
        for (n, _) in extra {
            h.push_str(&format!("property float {n}\n"));
        }
        h.push_str("end_header\n");
        let mut out = h.into_bytes();
        for p in points {
            let row = [
                p[0],
                p[1],
                p[2],
                0.1,
                0.2,
                0.3,
                2.0,
                (0.01f32).ln(),
                (0.02f32).ln(),
                (0.03f32).ln(),
                1.0,
                0.0,
                0.0,
                0.0,
            ];
            for v in row.iter().chain(extra.iter().map(|(_, v)| v)) {
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    fn grid() -> Vec<[f32; 3]> {
        let mut pts = Vec::new();
        for i in 0..21 {
            for j in 0..21 {
                for k in 0..21 {
                    pts.push([i as f32 * 0.1, j as f32 * 0.05, k as f32 * 0.2]);
                }
            }
        }
        pts
    }

    #[test]
    #[cfg_attr(miri, ignore)] // thousands of splats or pixels: too slow under Miri; the native run covers it
    fn fits_per_axis_and_stretches_covariances() {
        let bytes = splat(&grid(), &[("f_rest_0", 0.5)]);
        let p = FitParams {
            rotation: IDENTITY,
            dims: [0.8, 0.95, 0.9],
            lo_pct: 0.0,
            hi_pct: 100.0,
        };
        let fit = normalize(&bytes, &p).unwrap();
        let ply = read(&fit.ply).unwrap();
        assert!(
            ply.index("f_rest_0").is_none()
                && fit.dropped_rest == 1
                && fit.stretched
                && !fit.rotated
        );
        for axis in 0..3 {
            assert!((fit.hi[axis] - fit.lo[axis] - p.dims[axis]).abs() < 1e-6);
        }
        assert!(fit.lo[1].abs() < 1e-7);
        // scales: x 2 m → 0.8 (0.4×), y 1 m → 0.95, z 4 m → 0.9: σ' = σ × axis scale for an axis-aligned Gaussian
        let s0 = ply.column("scale_0").unwrap()[0].exp();
        let s2 = ply.column("scale_2").unwrap()[0].exp();
        let mut got = [s0, ply.column("scale_1").unwrap()[0].exp(), s2];
        got.sort_by(f64::total_cmp);
        let mut want = [0.01 * 0.4, 0.02 * 0.95, 0.03 * 0.225];
        want.sort_by(f64::total_cmp);
        for (g, w) in got.iter().zip(want) {
            assert!((g / w - 1.0).abs() < 1e-5, "{got:?} {want:?}");
        }
    }

    #[test]
    #[cfg_attr(miri, ignore)] // thousands of splats or pixels: too slow under Miri; the native run covers it
    fn idol_frame_rotation_and_flat_refusal() {
        // frame_rotation("-Y", "+X"): rows (up × front, up, front) = ((0,0,-1)... see frames.py
        let r = [[0.0, 0.0, 1.0], [0.0, -1.0, 0.0], [1.0, 0.0, 0.0]];
        let p = FitParams {
            rotation: r,
            dims: [1.0, 1.0, 1.0],
            lo_pct: 0.1,
            hi_pct: 99.9,
        };
        let fit = normalize(&splat(&grid(), &[]), &p).unwrap();
        assert!(fit.rotated && fit.dropped_rest == 0);
        let flat: Vec<[f32; 3]> = (0..50).map(|i| [i as f32, 0.0, (i * 2) as f32]).collect();
        assert_eq!(normalize(&splat(&flat, &[]), &p), Err(FitError::Flat(1)));
    }

    /// A splat whose properties come in this order: `f_rest_*` are 0.5, the rest as `splat` writes them.
    fn splat_in_order(points: &[[f32; 3]], order: &[&str]) -> Vec<u8> {
        let mut h = format!(
            "ply\nformat binary_little_endian 1.0\nelement vertex {}\n",
            points.len()
        );
        for n in order {
            h.push_str(&format!("property float {n}\n"));
        }
        h.push_str("end_header\n");
        let mut out = h.into_bytes();
        for p in points {
            for n in order {
                let v = match *n {
                    "x" => p[0],
                    "y" => p[1],
                    "z" => p[2],
                    "f_dc_0" => 0.1,
                    "f_dc_1" => 0.2,
                    "f_dc_2" => 0.3,
                    "opacity" => 2.0,
                    "scale_0" => (0.01f32).ln(),
                    "scale_1" => (0.02f32).ln(),
                    "scale_2" => (0.03f32).ln(),
                    "rot_0" => 1.0,
                    "rot_1" | "rot_2" | "rot_3" => 0.0,
                    _ => 0.5,
                };
                out.extend_from_slice(&v.to_le_bytes());
            }
        }
        out
    }

    fn assert_self_check_matches_file(order: &[&str]) {
        // A 90-degree yaw: rotated, so `f_rest_*` is dropped and the columns after it move.
        let p = FitParams {
            rotation: [[0.0, 0.0, 1.0], [0.0, 1.0, 0.0], [-1.0, 0.0, 0.0]],
            dims: [0.8, 0.95, 0.9],
            lo_pct: 0.0,
            hi_pct: 100.0,
        };
        let fit = normalize(&splat_in_order(&grid(), order), &p).unwrap();
        assert!(fit.rotated && fit.dropped_rest == 3 && fit.finite);
        for axis in 0..3 {
            let got = fit.hi[axis] - fit.lo[axis];
            assert!((got - p.dims[axis]).abs() < 1e-6, "axis {axis}: {got}");
        }
        assert!(fit.lo[1].abs() < 1e-7);
        // The self-check reported the centers the file holds.
        let ply = read(&fit.ply).unwrap();
        for (axis, name) in ["x", "y", "z"].iter().enumerate() {
            let c = ply.column(name).unwrap();
            let (lo, hi) = c
                .iter()
                .fold((f64::MAX, f64::MIN), |(l, h), &v| (l.min(v), h.max(v)));
            assert!((lo - fit.lo[axis]).abs() < 1e-9 && (hi - fit.hi[axis]).abs() < 1e-9);
        }
    }

    #[test]
    #[cfg_attr(miri, ignore)] // thousands of splats or pixels: too slow under Miri; the native run covers it
    fn self_check_reads_the_centers_when_f_rest_precedes_them() {
        assert_self_check_matches_file(&[
            "f_rest_0", "f_rest_1", "f_rest_2", "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2",
            "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "opacity",
        ]);
    }

    #[test]
    #[cfg_attr(miri, ignore)] // thousands of splats or pixels: too slow under Miri; the native run covers it
    fn self_check_does_not_index_past_the_columns_when_the_centers_come_last() {
        assert_self_check_matches_file(&[
            "f_rest_0", "f_rest_1", "f_rest_2", "f_dc_0", "f_dc_1", "f_dc_2", "scale_0", "scale_1",
            "scale_2", "rot_0", "rot_1", "rot_2", "rot_3", "opacity", "x", "y", "z",
        ]);
    }
}
