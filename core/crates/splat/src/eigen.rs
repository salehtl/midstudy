//! The symmetric 3×3 eigendecomposition the covariance fit needs (v1: `numpy.linalg.eigh`), and the quaternion
//! conversions around it (v1's `quat_to_matrix` and the batched Shepperd `matrix_to_quat`).
//!
//! Cyclic Jacobi rotations: unconditionally stable, and for the positive semi-definite covariances here as accurate as
//! LAPACK's divide and conquer on the same formed matrix. Eigenvalues come back ascending (eigh's order) with their
//! unit eigenvectors as the columns of the matrix. The eigenvectors' signs are Jacobi's, not LAPACK's: a Gaussian is
//! the same either way, but the stored quaternion of a splat can differ from v1's by a half turn about an axis.
// Exact zero tests are the algorithm's (a rotation is skipped only for an exactly zero term); matrix code reads
// best with its textbook single-letter names.
#![allow(clippy::float_cmp, clippy::many_single_char_names)]

/// A 3×3 matrix, row major.
pub type Mat3 = [[f64; 3]; 3];

/// The identity.
pub const IDENTITY: Mat3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// Eigenvalues (ascending) and unit eigenvectors (the columns of the second matrix) of a symmetric matrix; only its
/// upper triangle is read.
#[must_use]
pub fn eigh3(a: &Mat3) -> ([f64; 3], Mat3) {
    let mut m = [
        [a[0][0], a[0][1], a[0][2]],
        [a[0][1], a[1][1], a[1][2]],
        [a[0][2], a[1][2], a[2][2]],
    ];
    let mut v = IDENTITY;
    for sweep in 0..64 {
        if m[0][1] == 0.0 && m[0][2] == 0.0 && m[1][2] == 0.0 {
            break;
        }
        for (p, q, r) in [(0usize, 1usize, 2usize), (0, 2, 1), (1, 2, 0)] {
            let apq = m[p][q];
            if apq == 0.0 {
                continue;
            }
            let app = m[p][p];
            let aqq = m[q][q];
            let g = 100.0 * apq.abs();
            // Numerical Recipes' test: an off-diagonal term below the diagonals' precision is zero.
            if sweep > 2 && app.abs() + g == app.abs() && aqq.abs() + g == aqq.abs() {
                m[p][q] = 0.0;
                m[q][p] = 0.0;
                continue;
            }
            let h = aqq - app;
            let t = if h.abs() + g == h.abs() {
                apq / h
            } else {
                let theta = 0.5 * h / apq;
                let t = 1.0 / (theta.abs() + (1.0 + theta * theta).sqrt());
                if theta < 0.0 { -t } else { t }
            };
            let c = 1.0 / (1.0 + t * t).sqrt();
            let s = t * c;
            let tau = s / (1.0 + c);
            let h = t * apq;
            m[p][p] = app - h;
            m[q][q] = aqq + h;
            m[p][q] = 0.0;
            m[q][p] = 0.0;
            let grp = m[r][p];
            let grq = m[r][q];
            let nrp = grp - s * (grq + grp * tau);
            let nrq = grq + s * (grp - grq * tau);
            m[r][p] = nrp;
            m[p][r] = nrp;
            m[r][q] = nrq;
            m[q][r] = nrq;
            for row in &mut v {
                let g = row[p];
                let h = row[q];
                row[p] = g - s * (h + g * tau);
                row[q] = h + s * (g - h * tau);
            }
        }
    }
    let w = [m[0][0], m[1][1], m[2][2]];
    let mut order = [0usize, 1, 2];
    order.sort_by(|&i, &j| w[i].total_cmp(&w[j]));
    let vals = [w[order[0]], w[order[1]], w[order[2]]];
    let mut vecs = [[0.0; 3]; 3];
    for (k, row) in vecs.iter_mut().enumerate() {
        for (c, &o) in order.iter().enumerate() {
            row[c] = v[k][o];
        }
    }
    (vals, vecs)
}

/// The determinant.
#[must_use]
pub fn det3(m: &Mat3) -> f64 {
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
}

/// A · B.
#[must_use]
pub fn mul3(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut o = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            o[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    o
}

/// The rotation of a quaternion (w, x, y, z) of any length (v1's `quat_to_matrix`: divided by max(‖q‖, 1e-30)).
#[must_use]
pub fn quat_to_matrix(q: [f64; 4]) -> Mat3 {
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
        .sqrt()
        .max(1e-30);
    let (w, x, y, z) = (q[0] / n, q[1] / n, q[2] / n, q[3] / n);
    [
        [
            1.0 - 2.0 * (y * y + z * z),
            2.0 * (x * y - w * z),
            2.0 * (x * z + w * y),
        ],
        [
            2.0 * (x * y + w * z),
            1.0 - 2.0 * (x * x + z * z),
            2.0 * (y * z - w * x),
        ],
        [
            2.0 * (x * z - w * y),
            2.0 * (y * z + w * x),
            1.0 - 2.0 * (x * x + y * y),
        ],
    ]
}

/// The unit quaternion (w, x, y, z), w ≥ 0, of a rotation matrix (v1's `matrix_to_quat`, Shepperd's method: the
/// largest of trace, m00, m11, m22 picks the formula).
#[must_use]
pub fn matrix_to_quat(m: &Mat3) -> [f64; 4] {
    let (m00, m11, m22) = (m[0][0], m[1][1], m[2][2]);
    let tr = m00 + m11 + m22;
    let cand = [tr, m00, m11, m22];
    let mut pick = 0usize;
    for (i, &c) in cand.iter().enumerate().skip(1) {
        if c > cand[pick] {
            pick = i;
        }
    }
    let s = (1.0 + 2.0 * cand[pick] - tr).max(1e-30).sqrt() * 2.0;
    let mut q = match pick {
        0 => [
            0.25 * s,
            (m[2][1] - m[1][2]) / s,
            (m[0][2] - m[2][0]) / s,
            (m[1][0] - m[0][1]) / s,
        ],
        1 => [
            (m[2][1] - m[1][2]) / s,
            0.25 * s,
            (m[0][1] + m[1][0]) / s,
            (m[0][2] + m[2][0]) / s,
        ],
        2 => [
            (m[0][2] - m[2][0]) / s,
            (m[0][1] + m[1][0]) / s,
            0.25 * s,
            (m[1][2] + m[2][1]) / s,
        ],
        _ => [
            (m[1][0] - m[0][1]) / s,
            (m[0][2] + m[2][0]) / s,
            (m[1][2] + m[2][1]) / s,
            0.25 * s,
        ],
    };
    let n = (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]).sqrt();
    for c in &mut q {
        *c /= n;
    }
    if q[0] < 0.0 {
        for c in &mut q {
            *c = -*c;
        }
    }
    q
}

#[cfg(test)]
#[allow(clippy::unwrap_used, clippy::float_cmp)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    fn transpose(m: &Mat3) -> Mat3 {
        let mut t = [[0.0; 3]; 3];
        for i in 0..3 {
            for j in 0..3 {
                t[i][j] = m[j][i];
            }
        }
        t
    }

    fn rebuild(w: &[f64; 3], v: &Mat3) -> Mat3 {
        let d = [[w[0], 0.0, 0.0], [0.0, w[1], 0.0], [0.0, 0.0, w[2]]];
        mul3(&mul3(v, &d), &transpose(v))
    }

    fn close(a: &Mat3, b: &Mat3, tol: f64) -> bool {
        (0..3).all(|i| (0..3).all(|j| (a[i][j] - b[i][j]).abs() <= tol))
    }

    #[test]
    fn diagonal_and_degenerate() {
        let (w, v) = eigh3(&[[3.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 2.0]]);
        assert_eq!(w, [1.0, 2.0, 3.0]);
        assert!(close(
            &rebuild(&w, &v),
            &[[3.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 2.0]],
            0.0
        ));
        let (w, v) = eigh3(&[[2.0, 1.0, 0.0], [1.0, 2.0, 0.0], [0.0, 0.0, 2.0]]);
        assert!((w[0] - 1.0).abs() < 1e-15 && (w[2] - 3.0).abs() < 1e-15);
        assert!((det3(&v).abs() - 1.0).abs() < 1e-14);
    }

    #[test]
    fn quaternions_round_trip() {
        let q = [0.3, -0.5, 0.2, 0.7];
        let r = quat_to_matrix(q);
        let back = matrix_to_quat(&r);
        let n = (q.iter().map(|c| c * c).sum::<f64>()).sqrt();
        for (a, b) in back.iter().zip(q) {
            assert!((a - b / n).abs() < 1e-14);
        }
    }

    proptest! {
        #[test]
        fn rebuilds_any_covariance(
            q in prop::array::uniform4(-1.0f64..1.0),
            ls in prop::array::uniform3(-9.0f64..1.0),
            a in prop::array::uniform3(0.05f64..20.0),
        ) {
            prop_assume!(q.iter().map(|c| c * c).sum::<f64>() > 1e-6);
            let r = quat_to_matrix(q);
            let s2 = [ls[0].exp().powi(2), ls[1].exp().powi(2), ls[2].exp().powi(2)];
            let d = [[s2[0], 0.0, 0.0], [0.0, s2[1], 0.0], [0.0, 0.0, s2[2]]];
            let sa = [[a[0], 0.0, 0.0], [0.0, a[1], 0.0], [0.0, 0.0, a[2]]];
            let m = mul3(&sa, &r);
            let cov = mul3(&mul3(&m, &d), &transpose(&m));
            let (w, v) = eigh3(&cov);
            prop_assert!(w[0] <= w[1] && w[1] <= w[2]);
            let scale = w[2].abs().max(1e-300);
            prop_assert!(close(&rebuild(&w, &v), &cov, scale * 1e-13));
            prop_assert!(close(&mul3(&transpose(&v), &v), &IDENTITY, 1e-13));
        }
    }
}
