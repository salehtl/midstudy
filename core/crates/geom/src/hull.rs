//! 2D convex hulls for hit tests (v1 planner/engine.js `convexHull`, `pointInHull`, `distToHull`): Andrew's monotone
//! chain over points sorted by x then y, collinear points dropped, counterclockwise in (x right, y up) terms, which is
//! clockwise on screen (y down). Everything here works in caller-provided buffers: no allocation.

use crate::jsmath::{js_hypot2, js_max, js_min};
use core::cmp::Ordering;

/// A 2D point (x, y).
pub type P2 = [f64; 2];

/// The capacity of a [`SmallHull`]: hulls of up to this many points (a box's 8 projected corners and more).
pub const SMALL_HULL_POINTS: usize = 16;

fn cross(o: P2, a: P2, b: P2) -> f64 {
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
}

/// v1's sort order: by x, then y, comparing values (so −0 equals +0, as `a[0] − b[0]` does); NaN compares equal.
fn by_x_then_y(a: &P2, b: &P2) -> Ordering {
    match a[0].partial_cmp(&b[0]) {
        Some(Ordering::Equal) | None => a[1].partial_cmp(&b[1]).unwrap_or(Ordering::Equal),
        Some(o) => o,
    }
}

/// v1's `convexHull`, in place: sorts `points` (stable, by x then y) and writes the hull into `out`, returning its
/// length; `None` if `out` holds fewer than `2 · points.len()` entries. Fewer than 3 points come back sorted, as in v1
/// (so a hull may have 0, 1 or 2 points). Points are assumed finite.
pub fn convex_hull(points: &mut [P2], out: &mut [P2]) -> Option<usize> {
    let n = points.len();
    if out.len() < 2 * n {
        return None;
    }
    points.sort_by(by_x_then_y);
    if n < 3 {
        out.get_mut(..n)?.copy_from_slice(points);
        return Some(n);
    }
    // The lower chain, then the upper chain in the same buffer (it never pops below the lower chain's last point):
    // the same sequence as v1's `lo.slice(0, -1).concat(hi.slice(0, -1))`.
    let mut k = 0usize;
    for &p in points.iter() {
        while k >= 2 && cross(out[k - 2], out[k - 1], p) <= 0.0 {
            k -= 1;
        }
        out[k] = p;
        k += 1;
    }
    let t = k + 1;
    for &p in points[..n - 1].iter().rev() {
        while k >= t && cross(out[k - 2], out[k - 1], p) <= 0.0 {
            k -= 1;
        }
        out[k] = p;
        k += 1;
    }
    Some(k - 1)
}

/// v1's `pointInHull`: (x, y) inside or on the hull; never for a hull of fewer than 3 points.
#[must_use]
pub fn point_in_hull(h: &[P2], x: f64, y: f64) -> bool {
    if h.len() < 3 {
        return false;
    }
    let mut prev = h[h.len() - 1];
    // v1 walks edges i → i+1 starting at 0; the order doesn't change an all-edges test.
    for &b in h {
        let a = prev;
        if (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0]) < 0.0 {
            return false;
        }
        prev = b;
    }
    true
}

/// v1's `distToHull`: the distance from (x, y) to the hull's boundary (its closed polyline), `+∞` for an empty hull.
#[must_use]
pub fn dist_to_hull(h: &[P2], x: f64, y: f64) -> f64 {
    let mut best = f64::INFINITY;
    for (i, &a) in h.iter().enumerate() {
        let b = h[(i + 1) % h.len()];
        let (dx, dy) = (b[0] - a[0], b[1] - a[1]);
        let l2 = dx * dx + dy * dy;
        // `l2 ? … : 0` in v1: zero or NaN gives t = 0.
        let t = if l2 == 0.0 || l2.is_nan() {
            0.0
        } else {
            js_max(0.0, js_min(1.0, ((x - a[0]) * dx + (y - a[1]) * dy) / l2))
        };
        best = js_min(best, js_hypot2(x - a[0] - t * dx, y - a[1] - t * dy));
    }
    best
}

/// v1's `hitItemAt` test on screen: inside the hull, or within `pad` of it.
#[must_use]
pub fn hull_hit(h: &[P2], x: f64, y: f64, pad: f64) -> bool {
    point_in_hull(h, x, y) || dist_to_hull(h, x, y) <= pad
}

/// The hull of up to [`SMALL_HULL_POINTS`] points, on the stack.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SmallHull {
    pts: [P2; 2 * SMALL_HULL_POINTS],
    n: usize,
}

impl SmallHull {
    /// The hull of `points` (at most [`SMALL_HULL_POINTS`]; `None` beyond).
    #[must_use]
    pub fn new(points: &[P2]) -> Option<Self> {
        let mut buf = [[0.0; 2]; SMALL_HULL_POINTS];
        let src = buf.get_mut(..points.len())?;
        src.copy_from_slice(points);
        let mut pts = [[0.0; 2]; 2 * SMALL_HULL_POINTS];
        let n = convex_hull(src, &mut pts)?;
        Some(Self { pts, n })
    }

    /// The hull's points.
    #[must_use]
    pub fn points(&self) -> &[P2] {
        self.pts.get(..self.n).unwrap_or(&[])
    }

    /// [`hull_hit`] on this hull.
    #[must_use]
    pub fn hit(&self, x: f64, y: f64, pad: f64) -> bool {
        hull_hit(self.points(), x, y, pad)
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used, clippy::float_cmp)]
    use super::*;

    #[test]
    fn square_with_inner_and_collinear_points() {
        let pts = [
            [0.0, 0.0],
            [2.0, 0.0],
            [2.0, 2.0],
            [0.0, 2.0],
            [1.0, 1.0],
            [1.0, 0.0],
            [2.0, 1.0],
        ];
        let h = SmallHull::new(&pts).unwrap();
        assert_eq!(
            h.points(),
            &[[0.0, 0.0], [2.0, 0.0], [2.0, 2.0], [0.0, 2.0]]
        );
        assert!(h.hit(1.0, 1.0, 0.0));
        assert!(point_in_hull(h.points(), 2.0, 1.0)); // on an edge
        assert!(!point_in_hull(h.points(), 2.5, 1.0));
        assert_eq!(dist_to_hull(h.points(), 2.5, 1.0), 0.5);
        assert!(h.hit(2.5, 1.0, 0.5));
        assert!(!h.hit(2.5, 1.0, 0.49));
    }

    #[test]
    fn degenerate_inputs_follow_v1() {
        let h = SmallHull::new(&[[1.0, 1.0]; 8]).unwrap();
        assert_eq!(h.points(), &[[1.0, 1.0], [1.0, 1.0]]);
        let h = SmallHull::new(&[[3.0, 0.0], [1.0, 0.0]]).unwrap();
        assert_eq!(h.points(), &[[1.0, 0.0], [3.0, 0.0]]);
        assert!(!point_in_hull(h.points(), 2.0, 0.0));
        assert_eq!(dist_to_hull(h.points(), 2.0, 1.0), 1.0);
        assert!(SmallHull::new(&[[0.0, 0.0]; 17]).is_none());
        assert_eq!(dist_to_hull(&[], 0.0, 0.0), f64::INFINITY);
        let mut few = [[0.0, 0.0]; 3];
        assert!(convex_hull(&mut few, &mut [[0.0; 2]; 5]).is_none());
    }
}
