"""The pose solvers behind align-room (contract §4.9 Solvers): a Solver protocol, the step every learned solver shares
(its cameras -> §4.9 poses and scales, `from_views`), and choosing one.

How a learned solver's answer becomes a §4.9 pose (docs/notes/rooms-calib.md, Phase A):
  1. The solver gives each view a camera-to-world pose (OpenCV camera axes) in its own frame and units, intrinsics and
     a depth map on its own pixel grid.
  2. Each photo's calib.json gives the same camera's rotation in its own floor-up frame (pitch, roll; yaw 0). Each
     view's up in the solver frame is Rs·Rcᵀ·ŷ; their mean is the room's up (tilt_deg: how far a view's is from it).
  3. A rotation takes that up to +Y; each view's yaw is the Y-turn left in A·Rs·Rcᵀ; the first member's is 0.
  4. Scale from the floor: the photos' floor pixels (depth.png 0, clearly below the horizon) give the solver's floor
     height (median); metres per solver unit make the first member's camera height its calib height_m; each member's
     scale makes its effective camera height (height_m × scale) the solver's. With no floor seen: depth.png against
     the solver's depth (`scale_source: depth`).
  5. Positions: σ·A·(c_i − c_0); x and z are the pose (the floor point under the camera).
"""
from __future__ import annotations

import math
from collections.abc import Callable
from dataclasses import dataclass
from typing import Literal, Protocol

import numpy as np

from ..records import RealDevice
from ..util import Fail, log
from .geometry import F64, Placement, rotation_to_up, ry, yaw_of
from .photos import RoomPhoto
from .score import Candidate, Diag

type SolverName = Literal["mast3r", "manhattan"]
type SolverChoice = Literal["auto", "mast3r", "manhattan"]
SOLVER_CHOICES: tuple[SolverChoice, ...] = ("auto", "mast3r", "manhattan")
LEARNED: SolverName = "mast3r"  # Gate A (docs/ROOMS.md §2)


class Solver(Protocol):
    """A pose solver: given the usable photos (at least two, calib.json and depth.png each), a candidate per photo
    relative to the first (its placement is the frame), or None for one it couldn't place."""

    @property
    def name(self) -> SolverName: ...

    @property
    def uses_torch(self) -> bool: ...

    def solve(self, photos: list[RoomPhoto], device: RealDevice) -> list[Candidate | None]: ...


class SolverUnavailable(Fail):
    """A solver whose optional dependencies aren't installed (contract §4.9: asking for it by name is a failure)."""


@dataclass
class View:
    """One view as a learned solver answers it: camera-to-world (4×4, OpenCV axes) in the solver's frame and units,
    intrinsics (3×3) and depth along the view axis on the solver's grid, the depth's confidence, and where each grid
    pixel's center lies on the photo (normalized u, v; NaN for padding)."""

    c2w: F64
    k: F64
    depth: F64
    conf: F64
    u: F64
    v: F64

    def points(self) -> F64:
        """World points (h, w, 3) in the solver's frame."""
        hh, ww = self.depth.shape
        jj, ii = np.mgrid[0:hh, 0:ww]
        x = (ii + 0.5 - self.k[0, 2]) / self.k[0, 0] * self.depth
        y = (jj + 0.5 - self.k[1, 2]) / self.k[1, 1] * self.depth
        pc = np.stack([x, y, self.depth], axis=-1)
        return pc @ self.c2w[:3, :3].T + self.c2w[:3, 3]


def from_views(photos: list[RoomPhoto], views: list[View]) -> list[Candidate | None]:
    """Steps 2–5 of the module doc."""
    rs = [v.c2w[:3, :3] for v in views]
    ups = [r @ s.r_cv.T @ np.array([0.0, 1.0, 0.0]) for r, s in zip(rs, photos, strict=True)]
    u = np.sum(ups, axis=0)
    u /= np.linalg.norm(u)
    tilts = [math.degrees(math.acos(float(np.clip(np.dot(up, u), -1.0, 1.0)))) for up in ups]
    a0 = rotation_to_up(u)
    yaws = [yaw_of(a0 @ r @ s.r_cv.T) for r, s in zip(rs, photos, strict=True)]
    a = ry(-yaws[0]) @ a0
    ratios: list[float] = []
    floor_y: list[F64] = []
    for s, v in zip(photos, views, strict=True):
        good = (v.depth > 1e-6) & np.isfinite(v.depth)
        if v.conf.size == v.depth.size and good.any():
            good &= v.conf >= np.quantile(v.conf[good], 0.3)
        dp = s.depth_at_uv(v.u, v.v)
        ok = good & (dp > 0)
        ratios.append(float(np.median(dp[ok] / v.depth[ok])) if int(ok.sum()) > 50 else math.nan)
        fl = good & s.floor_at_uv(v.u, v.v)
        if int(fl.sum()) > 50:
            floor_y.append((v.points()[fl] @ a.T)[:, 1])
    c0 = views[0].c2w[:3, 3]
    cy = [float((a @ v.c2w[:3, 3])[1]) for v in views]
    mode = "floor"
    if floor_y:
        b = float(np.median(np.concatenate(floor_y)))
        hs = [y - b for y in cy]
        sigma = photos[0].cam().height / hs[0] if hs[0] > 1e-6 else math.nan
        scales = [sigma * hs[i] / s.cam().height for i, s in enumerate(photos)]
    else:
        mode = "depth"
        sigma = ratios[0]
        scales = [sigma / r if math.isfinite(r) and r > 0 else 1.0 for r in ratios]
    if not math.isfinite(sigma) or sigma <= 0:
        log("align-room: no floor or depth overlap on the first photo: its scale is unknown, nothing placed")
        return [Candidate(Placement(0.0, 0.0, 0.0, 1.0)), *([None] * (len(photos) - 1))]
    out: list[Candidate | None] = []
    for i, (s, v) in enumerate(zip(photos, views, strict=True)):
        p = sigma * (a @ (v.c2w[:3, 3] - c0))
        depth_scale = sigma / ratios[i] if math.isfinite(ratios[i]) and ratios[i] > 0 else None
        sc = scales[i]
        if i > 0 and (not math.isfinite(sc) or sc <= 0 or not np.isfinite(p).all()):
            log(f"align-room: {s.name}: the solver's camera is degenerate (scale {sc}): unplaced")
            out.append(None)
            continue
        diag: Diag = {"scale_source": mode, "scale_by_depth": round(depth_scale, 5) if depth_scale is not None else None}
        yaw = 0.0 if i == 0 else yaws[i] - yaws[0]
        out.append(Candidate(Placement(float(p[0]), float(p[2]), yaw, 1.0 if i == 0 else float(sc)), 1.0, tilts[i], diag))
    return out


def installed(name: SolverName) -> bool:
    """Whether a solver's dependencies are importable (manhattan: always)."""
    if name == "manhattan":
        return True
    from . import mast3r

    return mast3r.installed()


def make(name: SolverName) -> Solver:
    if name == "manhattan":
        from .manhattan import Manhattan

        return Manhattan()
    from .mast3r import Mast3r

    if not installed(name):
        raise SolverUnavailable("the mast3r solver isn't installed (uv sync --project calib --extra rooms)")
    return Mast3r()


def resolve(choice: SolverChoice) -> SolverName:
    """auto: the learned solver when its optional dependencies are installed, else manhattan (contract §4.9)."""
    if choice == "auto":
        return LEARNED if installed(LEARNED) else "manhattan"
    if not installed(choice):
        raise SolverUnavailable(f"the {choice} solver isn't installed (uv sync --project calib --extra rooms)")
    return choice


type Factory = Callable[[SolverName], Solver]
