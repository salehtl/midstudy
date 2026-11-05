//! Three-vectors and 3 × 3 matrices as plain arrays (f64, row-major: `m[row][col]`), with the few operations the
//! camera, the items and the light need. Matrices act on column vectors: `mul(m, v) = m · v`.

/// A point or direction (x, y, z).
pub type V3 = [f64; 3];
/// A 3 × 3 matrix, row-major.
pub type M3 = [[f64; 3]; 3];

/// The identity.
pub const IDENTITY: M3 = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];

/// a · b, summed x, y, z in that order (three.js's `Vector3.dot`).
#[must_use]
pub fn dot(a: V3, b: V3) -> f64 {
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

/// a − b.
#[must_use]
pub fn sub(a: V3, b: V3) -> V3 {
    [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

/// a + b.
#[must_use]
pub fn add(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

/// v · k.
#[must_use]
pub fn scale(v: V3, k: f64) -> V3 {
    [v[0] * k, v[1] * k, v[2] * k]
}

/// |v| as three.js computes it: `sqrt(x² + y² + z²)`.
#[must_use]
pub fn length(v: V3) -> f64 {
    (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]).sqrt()
}

/// v / |v| as three.js's `Vector3.normalize` (multiplies by `1 / (|v| || 1)`, so the zero vector stays zero).
#[must_use]
pub fn normalize(v: V3) -> V3 {
    let l = length(v);
    scale(v, 1.0 / if l == 0.0 || l.is_nan() { 1.0 } else { l })
}

/// m · v.
#[must_use]
pub fn mul(m: &M3, v: V3) -> V3 {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

/// mᵀ · v (for a rotation, its inverse applied to v).
#[must_use]
pub fn mul_t(m: &M3, v: V3) -> V3 {
    [
        m[0][0] * v[0] + m[1][0] * v[1] + m[2][0] * v[2],
        m[0][1] * v[0] + m[1][1] * v[1] + m[2][1] * v[2],
        m[0][2] * v[0] + m[1][2] * v[1] + m[2][2] * v[2],
    ]
}

/// a · b.
#[must_use]
pub fn mat_mul(a: &M3, b: &M3) -> M3 {
    let mut out = [[0.0; 3]; 3];
    for (row, a_row) in out.iter_mut().zip(a.iter()) {
        for (j, cell) in row.iter_mut().enumerate() {
            *cell = a_row[0] * b[0][j] + a_row[1] * b[1][j] + a_row[2] * b[2][j];
        }
    }
    out
}

/// mᵀ.
#[must_use]
pub fn transpose(m: &M3) -> M3 {
    [
        [m[0][0], m[1][0], m[2][0]],
        [m[0][1], m[1][1], m[2][1]],
        [m[0][2], m[1][2], m[2][2]],
    ]
}

/// The matrix as three.js stores a `Matrix3` (`elements`, column-major).
#[must_use]
pub fn to_column_major(m: &M3) -> [f64; 9] {
    [
        m[0][0], m[1][0], m[2][0], m[0][1], m[1][1], m[2][1], m[0][2], m[1][2], m[2][2],
    ]
}

/// A matrix from three.js's column-major `elements`.
#[must_use]
pub fn from_column_major(e: &[f64; 9]) -> M3 {
    [[e[0], e[3], e[6]], [e[1], e[4], e[7]], [e[2], e[5], e[8]]]
}

/// Rx(a) (contract §4.1): `[[1,0,0],[0,cos a,−sin a],[0,sin a,cos a]]`.
#[must_use]
pub fn rot_x(a: f64) -> M3 {
    let (s, c) = a.sin_cos();
    [[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]]
}

/// Ry(a): `[[cos a,0,sin a],[0,1,0],[−sin a,0,cos a]]` (positive a turns +X toward −Z: counterclockwise from above).
#[must_use]
pub fn rot_y(a: f64) -> M3 {
    let (s, c) = a.sin_cos();
    [[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]]
}

/// Rz(b) (contract §4.1): `[[cos b,−sin b,0],[sin b,cos b,0],[0,0,1]]`.
#[must_use]
pub fn rot_z(b: f64) -> M3 {
    let (s, c) = b.sin_cos();
    [[c, -s, 0.0], [s, c, 0.0], [0.0, 0.0, 1.0]]
}
