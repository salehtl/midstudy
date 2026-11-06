"""Manhattan, the no-dependency fallback solver (contract §4.9 Solvers; Phase A's spike, docs/notes/rooms-calib.md).

No ML and no weights: numpy and scipy, which calib already has. Each photo's depth.png is lifted floor-up through its
own calibration (points 0.1–2.0 m high); the walls' direction mod 90° comes from its surface normals; then each photo is
placed against the room built so far by FFT cross-correlation of 5 cm top-down density maps over the four 90° turns
and scales 0.94–1.06, refined by 2D ICP (turn and shift). Greedy: the best-matching remaining photo next. The ratio of
the best turn's peak to the best other turn's is its own confidence (an ambiguous 90° turn scores low).

Known weaknesses (Phase A): its scale is a 2 % grid, and a low-overlap pair can take the wrong 90° turn. It is the
fallback when the learned solver isn't installed; the user checks its answer on the floor plan.
"""
from __future__ import annotations

import importlib
import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final, Protocol

import numpy as np
from numpy.typing import NDArray

from ..records import RealDevice
from .geometry import F64, Placement, ry, wrap_deg
from .photos import RoomPhoto
from .score import Candidate, Diag
from .solver import SolverName

CELL: Final = 0.05
SCALES: Final = (0.94, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06)
MARGIN_M: Final = 6.0
MAX_ICP_POINTS: Final = 20000


class _KDTree(Protocol):
    def query(self, x: F64, *, distance_upper_bound: float) -> tuple[object, object]: ...


def _kdtree(points: F64) -> _KDTree:
    """scipy.spatial.cKDTree (scipy has no complete type information: this is its typed face here)."""
    make: Callable[[F64], _KDTree] = getattr(importlib.import_module("scipy.spatial"), "cKDTree")  # noqa: B009
    return make(points)


def _nearest(tree: _KDTree, q: F64, radius: float) -> tuple[F64, NDArray[np.int64]]:
    d, i = tree.query(q, distance_upper_bound=radius)
    return np.asarray(d, dtype=np.float64), np.asarray(i, dtype=np.int64)


def _blur(g: F64) -> F64:
    """Gaussian blur, σ = 1 cell (the maps have a wide empty margin, so wrapping at the edges changes nothing)."""
    xs = np.arange(-4, 5)
    k = np.exp(-0.5 * xs.astype(np.float64) ** 2)
    k /= k.sum()
    for axis in (0, 1):
        g = sum((float(w) * np.roll(g, int(s), axis=axis) for s, w in zip(xs, k, strict=True)), np.zeros_like(g))
    return g


def cloud(s: RoomPhoto) -> F64:
    """The photo's depth points 0.1–2.0 m above the floor (walls and furniture), scene frame."""
    p = s.lift(step=3)
    return p[(p[:, 1] > 0.1) & (p[:, 1] < 2.0)]


def wall_direction(s: RoomPhoto) -> float:
    """The walls' direction mod 90° (radians, in (−45°, 45°]) from depth.png's normals, scene frame."""
    p, okp = s.camera_points(3)
    if p.shape[0] < 3 or p.shape[1] < 3:
        return 0.0
    n = np.cross(p[1:-1, 2:] - p[1:-1, :-2], p[2:, 1:-1] - p[:-2, 1:-1])
    nn = np.linalg.norm(n, axis=-1)
    ok = okp[1:-1, 1:-1] & okp[1:-1, 2:] & okp[1:-1, :-2] & okp[2:, 1:-1] & okp[:-2, 1:-1] & (nn > 1e-9)
    n = n[ok] / nn[ok][:, None]
    n = n[np.abs(n[:, 1]) < 0.25]
    if len(n) < 50:
        return 0.0
    theta = np.arctan2(-n[:, 2], n[:, 0])  # Ry(a) adds a to this angle
    w = np.hypot(n[:, 0], n[:, 2])
    z = complex(np.sum(w * np.exp(4j * theta)))
    return math.atan2(z.imag, z.real) / 4


def _raster(pts: F64, origin: F64, shape: tuple[int, int]) -> F64:
    g = np.zeros(shape, dtype=np.float64)
    ij = np.floor((pts - origin) / CELL).astype(np.int64)
    ok = (ij[:, 0] >= 0) & (ij[:, 0] < shape[0]) & (ij[:, 1] >= 0) & (ij[:, 1] < shape[1])
    np.add.at(g, (ij[ok, 0], ij[ok, 1]), 1.0)
    return _blur(np.log1p(g))


@dataclass(frozen=True)
class _Match:
    score: float
    placement: Placement
    peak_ratio: float


def _icp(room: F64, src3: F64, start: Placement, iters: int = 30) -> Placement:
    """2D point-to-point ICP (turn and shift; scale kept) with a shrinking trim radius."""
    tree = _kdtree(room)
    src = start.scale * src3[:, [0, 2]]
    if len(src) > MAX_ICP_POINTS:
        src = src[np.random.default_rng(0).choice(len(src), MAX_ICP_POINTS, replace=False)]
    yaw, t = start.yaw, np.array([start.x, start.z])
    radius = 0.3
    for _ in range(iters):
        c, s = math.cos(yaw), math.sin(yaw)
        m = np.array([[c, s], [-s, c]])  # Ry on (x, z)
        dist, idx = _nearest(tree, src @ m.T + t, radius)
        ok = np.isfinite(dist)
        if int(ok.sum()) < 50:
            break
        a, b = src[ok], room[idx[ok]]
        ma, mb = a.mean(0), b.mean(0)
        u, _, vt = np.linalg.svd((a - ma).T @ (b - mb))
        r = vt.T @ u.T
        if np.linalg.det(r) < 0:
            vt[-1] *= -1
            r = vt.T @ u.T
        yaw = math.atan2(float(r[0, 1]), float(r[0, 0]))
        t = mb - ma @ r.T
        radius = max(0.06, radius * 0.85)
    return Placement(float(t[0]), float(t[1]), yaw, start.scale)


def _match(room: F64, cl: F64, dir_delta: float) -> _Match | None:
    """The best placement of one photo's points against the room's top-down points (x, z)."""
    if len(cl) < 50 or len(room) < 50:
        return None
    lo = room.min(axis=0) - MARGIN_M
    size = room.max(axis=0) + MARGIN_M - lo
    shape = (int(size[0] / CELL) + 1, int(size[1] / CELL) + 1)
    ref = _raster(room, lo, shape)
    fr = np.fft.rfft2(ref)
    ref_norm = float((ref * ref).sum())
    cands: list[tuple[float, float, float, float, float]] = []
    for k in range(4):
        yaw = -dir_delta + k * math.pi / 2
        for sc in SCALES:
            g = _raster((sc * cl @ ry(yaw).T)[:, [0, 2]], lo, shape)
            corr = np.fft.irfft2(fr * np.conj(np.fft.rfft2(g)), s=shape)
            flat = int(np.argmax(corr))
            i0, i1 = flat // shape[1], flat % shape[1]
            norm = math.sqrt(ref_norm * float((g * g).sum())) or 1.0
            sh = [float(i0), float(i1)]
            c0 = float(corr[i0, i1])
            # sub-cell peak (a parabola through the neighbours on each axis)
            for ax in range(2):
                lo_i = ((i0 - 1) % shape[0], i1) if ax == 0 else (i0, (i1 - 1) % shape[1])
                hi_i = ((i0 + 1) % shape[0], i1) if ax == 0 else (i0, (i1 + 1) % shape[1])
                cm, cp = float(corr[lo_i]), float(corr[hi_i])
                den = cm - 2 * c0 + cp
                if den < 0:
                    sh[ax] += 0.5 * (cm - cp) / den
            sx = (sh[0] if sh[0] < shape[0] / 2 else sh[0] - shape[0]) * CELL
            sz = (sh[1] if sh[1] < shape[1] / 2 else sh[1] - shape[1]) * CELL
            cands.append((c0 / norm, yaw, sc, sx, sz))
    cands.sort(reverse=True)
    s_best, yaw, sc, sx, sz = cands[0]
    other = next((c for c in cands[1:] if abs(wrap_deg(math.degrees(c[1] - yaw))) > 45), None)
    ratio = s_best / other[0] if other is not None and other[0] > 0 else 2.0
    return _Match(s_best, _icp(room, cl, Placement(sx, sz, yaw, sc)), ratio)


class Manhattan:
    """The Solver protocol's no-ML implementation (module doc)."""

    @property
    def name(self) -> SolverName:
        return "manhattan"

    @property
    def uses_torch(self) -> bool:
        return False

    def solve(self, photos: list[RoomPhoto], device: RealDevice) -> list[Candidate | None]:
        del device  # numpy on the CPU
        clouds = [cloud(s) for s in photos]
        dirs = [wall_direction(s) for s in photos]
        placed: dict[int, Placement] = {0: Placement(0.0, 0.0, 0.0, 1.0)}
        conf: dict[int, float] = {0: 1.0}
        diags: dict[int, Diag] = {0: {"wall_dir_deg": round(math.degrees(dirs[0]), 2)}}
        todo = set(range(1, len(photos)))
        while todo:
            room = np.concatenate([placed[k].scene_to_room(clouds[k])[:, [0, 2]] for k in placed])
            best: tuple[_Match, int] | None = None
            for i in sorted(todo):
                m = _match(room, clouds[i], dirs[i] - dirs[0])
                if m is not None and (best is None or m.score > best[0].score):
                    best = (m, i)
            if best is None:
                break
            m, i = best
            placed[i] = m.placement
            conf[i] = min(1.0, max(0.0, (m.peak_ratio - 1.0) / 0.3))
            diags[i] = {"wall_dir_deg": round(math.degrees(dirs[i]), 2), "match_score": round(m.score, 4), "peak_ratio": round(m.peak_ratio, 3)}
            todo.discard(i)
        return [Candidate(placed[i], conf[i], 0.0, diags[i]) if i in placed else None for i in range(len(photos))]
