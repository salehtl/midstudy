"""How sure align-room is of each placement, the same for every solver (docs/notes/rooms-calib.md, Phase A).

- residual_cm: each placed member's depth.png points, carried into the room through its pose and into every other
  placed member's camera; the median |view-axis depth difference| (cm, room scale) over the points that member sees
  within OVERLAP_CUT_M; a member's residual is the median over the members it overlaps.
- confidence = min(1, overlap / CONF_OVERLAP) · exp(−residual / CONF_RESIDUAL_CM) · exp(−tilt / CONF_TILT_DEG)
  · the solver's own · min(1, constraint / CONF_CONSTRAINT), where overlap is the largest share of its points another
  member sees, tilt how far the solver's floor is from the photo's own floor fit, and constraint λmin/λmax of the
  horizontal parts of its own surface normals (a bare wall: 0, its shift along the wall is unconstrained).
- A member below MIN_CONFIDENCE is unplaced (Phase A: 0.5 turns every low-overlap pair placement into unplaced and
  costs MASt3R nothing on the golden room), the least sure first and one at a time: the rest are scored again without
  it (a wrong member spoils the residuals of the members it overlaps), until none is below.
- loop_residual_cm: the median pair residual when the overlapping placed members close a loop (contract §4.9: null
  without one: fewer than three placed photos, or a chain).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from typing import Final

import numpy as np

from .geometry import F64, Placement
from .photos import RoomPhoto

MIN_CONFIDENCE: Final = 0.5
CONF_OVERLAP: Final = 0.3
CONF_RESIDUAL_CM: Final = 20.0
CONF_TILT_DEG: Final = 5.0
CONF_CONSTRAINT: Final = 0.1
OVERLAP_CUT_M: Final = 0.5
MIN_SEEN: Final = 30  # points two members must share for a residual


type Diag = dict[str, float | str | bool | None]


@dataclass
class Candidate:
    """A solver's answer for one member: where it put it, how sure the solver itself is (1 when it doesn't say), how
    far its floor is from the photo's own (degrees), and the solver's diagnostics."""

    placement: Placement
    solver_confidence: float = 1.0
    tilt_deg: float = 0.0
    diag: Diag = field(default_factory=dict[str, float | str | bool | None])


@dataclass
class Scored:
    """A member after scoring: its placement or None (unplaced), confidence, residual_cm and diagnostics."""

    placement: Placement | None
    confidence: float
    residual_cm: float | None
    diag: Diag


def pair_residual(a: RoomPhoto, pa: Placement, b: RoomPhoto, pb: Placement, pts_a: F64) -> tuple[float | None, float]:
    """(median |depth difference| in metres at room scale, or None with too few shared points; the share of a's
    points b sees within OVERLAP_CUT_M)."""
    if len(pts_a) == 0:
        return None, 0.0
    q = pb.room_to_scene(pa.scene_to_room(pts_a))
    px, py, d = b.project(q)
    db_map = b.dep()
    dh, dw = db_map.shape
    inside = (d > 0.05) & np.isfinite(px) & np.isfinite(py) & (px >= 0) & (px < dw) & (py >= 0) & (py < dh)
    if not inside.any():
        return None, 0.0
    db = db_map[py[inside].astype(np.int64), px[inside].astype(np.int64)]
    diff = np.abs(d[inside] - db) * pb.scale
    seen = (db > 0) & (diff < OVERLAP_CUT_M)
    share = float(seen.sum()) / len(pts_a)
    if int(seen.sum()) < MIN_SEEN:
        return None, share
    return float(np.median(diff[seen])), share


def constraint(s: RoomPhoto, step: int = 3) -> float:
    """λmin/λmax of the 2×2 second moment of the horizontal parts of depth.png's surface normals (scene frame): near 0
    when everything the photo sees faces one way (a bare wall), so a shift along it changes nothing."""
    p, okp = s.camera_points(step)
    if p.shape[0] < 3 or p.shape[1] < 3:
        return 0.0
    n = np.cross(p[1:-1, 2:] - p[1:-1, :-2], p[2:, 1:-1] - p[:-2, 1:-1])
    nn = np.linalg.norm(n, axis=-1)
    ok = okp[1:-1, 1:-1] & okp[1:-1, 2:] & okp[1:-1, :-2] & okp[2:, 1:-1] & okp[:-2, 1:-1] & (nn > 1e-9)
    h = (n[ok] / nn[ok][:, None])[:, [0, 2]]
    if len(h) < 50:
        return 0.0
    ev = np.linalg.eigvalsh(h.T @ h / len(h))
    return float(ev[0] / ev[1]) if ev[1] > 1e-12 else 0.0


def _has_loop(n: int, edges: list[tuple[int, int]]) -> bool:
    """Whether the undirected graph on n nodes with these edges has a cycle (union-find)."""
    parent = list(range(n))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for a, b in edges:
        ra, rb = find(a), find(b)
        if ra == rb:
            return True
        parent[ra] = rb
    return False


def _round(v: float, k: int) -> float:
    return round(v, k) + 0.0  # no -0.0


def score_once(photos: list[RoomPhoto], placed: list[Candidate | None], pts: list[F64]) -> tuple[list[Scored], float | None]:
    """One scoring pass (module doc). Member 0 is the frame: confidence 1, residual None."""
    out: list[Scored] = []
    pairs: dict[tuple[int, int], float] = {}
    for i, (s, c) in enumerate(zip(photos, placed, strict=True)):
        if c is None:
            out.append(Scored(None, 0.0, None, {}))
            continue
        res: list[float] = []
        shares: list[float] = []
        for j, (t, o) in enumerate(zip(photos, placed, strict=True)):
            if i == j or o is None:
                continue
            r, share = pair_residual(s, c.placement, t, o.placement, pts[i])
            shares.append(share)
            if r is not None:
                res.append(r)
                key = (min(i, j), max(i, j))
                pairs[key] = max(pairs.get(key, 0.0), r)
        residual = _round(100 * float(np.median(res)), 2) if res else None
        overlap = max(shares) if shares else 0.0
        cons = constraint(s)
        diag: Diag = {**c.diag, "overlap": _round(overlap, 3), "constraint": _round(cons, 3), "tilt_deg": _round(c.tilt_deg, 3),
                      "solver_confidence": _round(c.solver_confidence, 3)}
        if i == 0:
            out.append(Scored(c.placement, 1.0, None, diag))
            continue
        conf = 0.0 if residual is None else (
            min(1.0, overlap / CONF_OVERLAP) * math.exp(-residual / CONF_RESIDUAL_CM) * math.exp(-c.tilt_deg / CONF_TILT_DEG)
            * max(0.0, min(1.0, c.solver_confidence)) * min(1.0, cons / CONF_CONSTRAINT))
        out.append(Scored(c.placement, _round(min(1.0, max(0.0, conf)), 3), residual, diag))
    loop = _round(100 * float(np.median(list(pairs.values()))), 2) if pairs and _has_loop(len(photos), list(pairs)) else None
    return out, loop


def score(photos: list[RoomPhoto], cands: list[Candidate | None], min_confidence: float = MIN_CONFIDENCE) -> tuple[list[Scored], float | None]:
    """Score; unplace the least sure member below min_confidence (its pose kept as `rejected_*` in its diagnostics) and
    score the rest again, until none is below. Member 0 always stays (the frame)."""
    pts = [p.lift(step=6) if p.usable else np.zeros((0, 3)) for p in photos]
    placed = list(cands)
    rejected: dict[int, Scored] = {}
    while True:
        scored, loop = score_once(photos, placed, pts)
        low = [(s.confidence, i) for i, s in enumerate(scored) if i > 0 and s.placement is not None and s.confidence < min_confidence]
        if not low:
            break
        # one at a time, the least sure first: a wrong member also spoils the residuals of the members it overlaps
        _, i = min(low)
        rejected[i] = scored[i]
        placed[i] = None
    for i, r in rejected.items():
        p = r.placement
        rp: Diag = {} if p is None else {"rejected_x_m": _round(p.x, 4), "rejected_z_m": _round(p.z, 4),
                                          "rejected_yaw_deg": _round(math.degrees(p.yaw), 3), "rejected_confidence": r.confidence,
                                          "rejected_residual_cm": r.residual_cm}
        scored[i] = Scored(None, 0.0, None, {**r.diag, **rp})
    return scored, loop
