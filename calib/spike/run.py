"""Rooms solver spike (docs/ROOMS.md §5 Phase A2): poses of N photos of one room, from one candidate solver.

    uv run --project calib/spike python calib/spike/run.py SCENE_DIR [SCENE_DIR ...] --solver solv3r|vggt|mast3r|manhattan
        [--device auto|mps|cpu] [--truth] [--repeat 2] [--out evals/out/rooms-spike/<name>.json]

Each SCENE_DIR holds photo.jpg, calib.json and depth.png (contract §4.2). The first one is the room's origin. The
answer (stdout, one JSON object; also --out) follows ROOMS.md §3.1: per member a pose {x_m, z_m, yaw_deg} mapping its
scene frame into the room frame (p_room = Ry(yaw)·(scale·p_scene) + (x, 0, z)), its scale relative to the first
member, a confidence (0–1) and the residual it measured (cm); plus loop_residual_cm, unplaced, timing and memory.

How a solver's answer becomes a §3.1 pose (the same for every ML solver):
  1. The solver gives each view a camera-to-world pose (OpenCV camera axes) in its own frame and scale, and a depth map.
  2. Each scene's calib gives the same camera's rotation in its own floor-up frame (pitch, roll; yaw 0) and its height.
     solver→scene rotation per view: Q_i = Rc_i · Rs_iᵀ. Each view's "up" in the solver frame is Q_iᵀ·ŷ; their mean
     is the room's up (the spread, tilt_deg, says how much the solver and the calibs disagree about the floor).
  3. A rotation taking that up to +Y re-expresses the solver floor-up; each view's yaw is the Y-turn left in
     A·Rs_i·Rc_iᵀ; the room yaw is set so the first member's is 0.
  4. Scale: per view, the median ratio of depth.png (metric, the scene's own scale) to the solver's depth at the same
     photo points. Room metres per solver unit = the first member's ratio; a member's scale = first ratio / its ratio.
  5. Positions: room = σ₀·A·(c_i − c₀), its x and z are the pose (the scene origin sits under the camera on the floor).
  That is a 2D similarity on the floor (turn, shift, scale), fixed by the first member.

Residual (every solver): each member's depth.png lifted into the room through its pose and projected into every other
member's camera; the median |depth difference| (cm) over points seen by both (difference under 50 cm). Confidence comes
from that residual, the overlap, the tilt and the constraint (a bare wall scores 0). A member under MIN_CONFIDENCE is `unplaced` (no pose).

--truth compares with truth.json's pose_in_room (re-expressed relative to the first member; missing = the origin, as
the original golden scenes all share living-wide's camera position) and prints the error row.

Weights and solver repos live outside the repo (setup.sh); this script writes nothing but --out.
"""
from __future__ import annotations

import argparse
import contextlib
import json
import math
import os
import resource
import sys
import tempfile
import threading
import time
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import numpy as np
from numpy.typing import NDArray
from PIL import Image

F64 = NDArray[np.float64]
REPOS = Path(os.environ.get("MIDSTUDY_SPIKE_REPOS", str(Path.home() / ".cache/midstudy-spike/repos")))
MIN_CONFIDENCE = 0.15
# confidence = min(1, overlap / CONF_OVERLAP) · exp(−residual / CONF_RESIDUAL_CM) · exp(−tilt / CONF_TILT_DEG) · solver's own;
# the residual includes MoGe's own disagreement between photos (13–15 cm on the real lounge photos with a right pose)
CONF_OVERLAP, CONF_RESIDUAL_CM, CONF_TILT_DEG = 0.3, 20.0, 5.0
OVERLAP_CUT_M = 0.5
# stage 2: a member whose own depth faces one direction only (a bare wall) has its shift along that wall unconstrained
# by geometry; its confidence is multiplied by min(1, constraint / CONF_CONSTRAINT), constraint = λmin/λmax of its
# horizontal normals (golden room: 0.36–0.92 for ordinary photos, 0.000 for room-6, the blank wall)
CONF_CONSTRAINT = 0.1
FLIP = np.diag([1.0, -1.0, -1.0])  # OpenCV camera axes (x right, y down, z forward) ↔ three.js (y up, looking −z)
# Phase A targets (ROOMS.md §5): a placement off by more than twice one of them is "wrong".
TARGET_POS_CM, TARGET_YAW_DEG, TARGET_SCALE_PCT = 5.0, 1.5, 2.0


def log(msg: str) -> None:
    print(f"spike: {msg}", file=sys.stderr, flush=True)


# ---------------------------------------------------------------------------------------------------- geometry (§4.1)


def rx(a: float) -> F64:
    c, s = math.cos(a), math.sin(a)
    return np.array([[1, 0, 0], [0, c, -s], [0, s, c]], dtype=np.float64)


def ry(a: float) -> F64:
    """ROOMS.md §3.1: positive is counterclockwise seen from above (+X turns toward −Z)."""
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]], dtype=np.float64)


def rz(a: float) -> F64:
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]], dtype=np.float64)


def yaw_of(m: F64) -> float:
    """The Y-turn (radians) of the rotation nearest to m among pure Ry turns."""
    return math.atan2(m[0, 2] - m[2, 0], m[0, 0] + m[2, 2])


def wrap_deg(a: float) -> float:
    return (a + 180.0) % 360.0 - 180.0


def rotation_to_up(u: F64) -> F64:
    """The smallest rotation taking unit vector u to +Y (Rodrigues)."""
    y = np.array([0.0, 1.0, 0.0])
    v = np.cross(u, y)
    s, c = float(np.linalg.norm(v)), float(np.dot(u, y))
    if s < 1e-12:
        return np.eye(3) if c > 0 else rx(math.pi)
    k = v / s
    kx = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + s * kx + (1 - c) * (kx @ kx)


@dataclass
class Scene:
    """One member: its calib camera and its depth (metres along the view axis, 0 = no occluder)."""

    path: Path
    name: str
    w: int
    h: int
    fov_y: float
    height: float
    pitch: float
    roll: float
    depth: F64
    truth: dict[str, float] | None

    @property
    def r_gl(self) -> F64:
        """Camera-to-scene rotation, three.js camera axes (contract §4.1: Ry(0)·Rx(pitch)·Rz(roll))."""
        return rx(self.pitch) @ rz(self.roll)

    @property
    def r_cv(self) -> F64:
        """Camera-to-scene rotation, OpenCV camera axes (what the solvers use)."""
        return self.r_gl @ FLIP

    def depth_at_uv(self, u: F64, v: F64) -> F64:
        """depth.png (nearest) at normalized photo coordinates; 0 outside or unknown."""
        dh, dw = self.depth.shape
        fin = np.isfinite(u) & np.isfinite(v)
        i = np.floor(np.where(fin, u, -1.0) * dw).astype(np.int64)
        j = np.floor(np.where(fin, v, -1.0) * dh).astype(np.int64)
        ok = (i >= 0) & (i < dw) & (j >= 0) & (j < dh) & fin
        out = np.zeros(u.shape, dtype=np.float64)
        out[ok] = self.depth[j[ok], i[ok]]
        return out

    def floor_at_uv(self, u: F64, v: F64) -> NDArray[np.bool_]:
        """Photo points that show the floor: depth.png 0 (floor-masked, contract §4.3) and clearly below the horizon."""
        f = 0.5 / math.tan(self.fov_y / 2)  # in units of the photo height
        dc = np.stack([(u - 0.5) * (self.w / self.h) / f, -(v - 0.5) / f, -np.ones_like(u)], axis=-1)
        dy = (dc @ self.r_gl.T)[..., 1] / np.linalg.norm(dc, axis=-1)
        return np.isfinite(u) & np.isfinite(v) & (self.depth_at_uv(u, v) == 0) & (dy < -0.1)

    def lift(self, step: int = 4) -> F64:
        """depth.png's points (every step-th pixel, depth > 0) in the scene frame, (n, 3)."""
        d = self.depth[step // 2 :: step, step // 2 :: step]
        dh, dw = self.depth.shape
        f = (dh / 2) / math.tan(self.fov_y / 2)
        jj, ii = np.mgrid[step // 2 : dh : step, step // 2 : dw : step]
        ok = d > 0
        z = d[ok]
        xc = (ii[ok] + 0.5 - dw / 2) / f * z
        yc = -(jj[ok] + 0.5 - dh / 2) / f * z
        pc = np.stack([xc, yc, -z], axis=1)
        return pc @ self.r_gl.T + np.array([0.0, self.height, 0.0])

    def project(self, p_scene: F64) -> tuple[F64, F64, F64]:
        """Scene-frame points → depth-image pixel coordinates and view-axis depth."""
        dh, dw = self.depth.shape
        f = (dh / 2) / math.tan(self.fov_y / 2)
        pc = (p_scene - np.array([0.0, self.height, 0.0])) @ self.r_gl
        d = -pc[:, 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            px = dw / 2 + f * pc[:, 0] / d
            py = dh / 2 - f * pc[:, 1] / d
        return px, py, d


def load_scene(d: Path) -> Scene:
    calib = json.loads((d / "calib.json").read_text())
    cam = calib["camera"]
    with Image.open(d / "photo.jpg") as im:
        w, h = im.size
    depth = np.zeros((1, 1))
    if (d / "depth.png").exists():
        with Image.open(d / "depth.png") as im:
            depth = np.asarray(im, dtype=np.float64) / 1000.0
    truth = None
    if (d / "truth.json").exists():
        t = json.loads((d / "truth.json").read_text())
        truth = t.get("pose_in_room") or {"x_m": 0.0, "z_m": 0.0, "yaw_deg": 0.0, "assumed": 1.0}
    return Scene(d, d.name, w, h, math.radians(cam["fov_y_deg"]), float(cam["height_m"]), math.radians(cam["pitch_deg"]),
                 math.radians(cam["roll_deg"]), depth, truth)


@dataclass
class Pose:
    x: float
    z: float
    yaw: float  # radians
    scale: float

    def scene_to_room(self, p: F64) -> F64:
        return (self.scale * p) @ ry(self.yaw).T + np.array([self.x, 0.0, self.z])

    def room_to_scene(self, p: F64) -> F64:
        return ((p - np.array([self.x, 0.0, self.z])) @ ry(self.yaw)) / self.scale


# ---------------------------------------------------------------------------------------------------- solver output


@dataclass
class View:
    """One view as a solver answers it: camera-to-world (OpenCV axes) in the solver's frame and units, depth along the
    view axis on the solver's pixel grid, its confidence, and where each grid pixel's center lies on the photo
    (normalized u, v; NaN for padding)."""

    c2w: F64
    k: F64  # intrinsics (3, 3) in the solver's grid pixels
    depth: F64
    conf: F64
    u: F64
    v: F64

    def points(self) -> F64:
        """World points (h, w, 3) in the solver frame from depth and intrinsics."""
        hh, ww = self.depth.shape
        jj, ii = np.mgrid[0:hh, 0:ww]
        x = (ii + 0.5 - self.k[0, 2]) / self.k[0, 0] * self.depth
        y = (jj + 0.5 - self.k[1, 2]) / self.k[1, 1] * self.depth
        pc = np.stack([x, y, self.depth], axis=-1)
        return pc @ self.c2w[:3, :3].T + self.c2w[:3, 3]


@dataclass
class Member:
    scene: str
    pose: Pose | None
    confidence: float
    residual_cm: float | None
    extra: dict[str, Any] = field(default_factory=dict)


def from_views(scenes: list[Scene], views: list[View]) -> list[Member]:
    """Steps 2–5 of the module doc: a solver's cameras → §3.1 poses and scales, plus diagnostics."""
    rs = [v.c2w[:3, :3] for v in views]
    ups = [r @ s.r_cv.T @ np.array([0.0, 1.0, 0.0]) for r, s in zip(rs, scenes, strict=True)]
    u = np.sum(ups, axis=0)
    u /= np.linalg.norm(u)
    tilts = [math.degrees(math.acos(float(np.clip(np.dot(up, u), -1, 1)))) for up in ups]
    a0 = rotation_to_up(u)
    yaws = [yaw_of(a0 @ r @ s.r_cv.T) for r, s in zip(rs, scenes, strict=True)]
    a = ry(-yaws[0]) @ a0
    ratios, floor_y = [], []
    for s, v in zip(scenes, views, strict=True):
        good = (v.depth > 1e-6) & np.isfinite(v.depth)
        if v.conf.size == v.depth.size and good.any():
            good &= v.conf >= np.quantile(v.conf[good], 0.3)
        dp = s.depth_at_uv(v.u, v.v)
        ok = good & (dp > 0)
        ratios.append(float(np.median(dp[ok] / v.depth[ok])) if ok.sum() > 50 else float("nan"))
        fl = good & s.floor_at_uv(v.u, v.v)
        if fl.sum() > 50:
            floor_y.append((v.points()[fl] @ a.T)[:, 1])
    # Scale (module doc, step 4): the floor. The solver's floor is the median height (along the room's up) of the
    # points every view's calib calls floor; room metres per solver unit make the first member's camera height its
    # calib height; a member's scale makes its effective camera height (height_m × scale) the solver's. Fallback when
    # no view shows enough floor: depth.png against the solver's depth.
    c0 = views[0].c2w[:3, 3]
    cy = [float((a @ v.c2w[:3, 3])[1]) for v in views]
    mode = "floor"
    if floor_y:
        b = float(np.median(np.concatenate(floor_y)))
        hs = [y - b for y in cy]
        sigma = scenes[0].height / hs[0] if hs[0] > 1e-6 else float("nan")
        scales = [sigma * hs[i] / s.height for i, s in enumerate(scenes)]
    else:
        mode = "depth"
        sigma = ratios[0]
        scales = [sigma / r if math.isfinite(r) and r > 0 else 1.0 for r in ratios]
    out: list[Member] = []
    for i, (s, v) in enumerate(zip(scenes, views, strict=True)):
        p = sigma * (a @ (v.c2w[:3, 3] - c0))
        yaw = 0.0 if i == 0 else yaws[i] - yaws[0]
        # the same member's scale from depth.png against the solver's depth: how far MoGe's depth and floor disagree
        depth_scale = sigma / ratios[i] if math.isfinite(sigma) and math.isfinite(ratios[i]) and ratios[i] > 0 else None
        out.append(Member(s.name, Pose(float(p[0]), float(p[2]), yaw, float(scales[i])), 1.0, None,
                          {"tilt_deg": round(tilts[i], 3), "scale_source": mode,
                           "scale_by_depth": round(depth_scale, 5) if depth_scale is not None else None}))
    if not math.isfinite(sigma):
        for m in out:
            m.extra["warning"] = "no floor or depth overlap on the first member: scale unknown"
    return out


# ---------------------------------------------------------------------------------------------------- residuals


def pair_residual(a: Scene, pa: Pose, b: Scene, pb: Pose, pts_a: F64) -> tuple[float | None, float]:
    """Median |depth difference| (m, room scale) of a's points seen by b, and the share of them b sees within the cut."""
    q = pb.room_to_scene(pa.scene_to_room(pts_a))
    px, py, d = b.project(q)
    dh, dw = b.depth.shape
    inside = (d > 0.05) & np.isfinite(px) & (px >= 0) & (px < dw) & (py >= 0) & (py < dh)
    if not inside.any():
        return None, 0.0
    db = b.depth[py[inside].astype(np.int64), px[inside].astype(np.int64)]
    diff = np.abs(d[inside] - db) * pb.scale
    seen = (db > 0) & (diff < OVERLAP_CUT_M)
    share = float(seen.sum()) / len(pts_a)
    if seen.sum() < 30:
        return None, share
    return float(np.median(diff[seen])), share


def constraint(s: Scene, step: int = 3) -> float:
    """λmin/λmax of the 2×2 second moment of the horizontal parts of depth.png's surface normals (scene frame):
    near 0 when everything the photo sees faces one way (a bare wall), so a shift along it changes nothing."""
    dh, dw = s.depth.shape
    d = s.depth[step // 2 :: step, step // 2 :: step]
    f = (dh / 2) / math.tan(s.fov_y / 2)
    jj, ii = np.mgrid[step // 2 : dh : step, step // 2 : dw : step]
    p = np.stack([(ii + 0.5 - dw / 2) / f * d, -(jj + 0.5 - dh / 2) / f * d, -d], axis=-1) @ s.r_gl.T
    n = np.cross(p[1:-1, 2:] - p[1:-1, :-2], p[2:, 1:-1] - p[:-2, 1:-1])
    nn = np.linalg.norm(n, axis=-1, keepdims=True)
    ok = (d[1:-1, 1:-1] > 0) & (d[1:-1, 2:] > 0) & (d[1:-1, :-2] > 0) & (d[2:, 1:-1] > 0) & (d[:-2, 1:-1] > 0)
    ok &= nn[..., 0] > 1e-9
    h = (n[ok] / nn[ok])[:, [0, 2]]
    if len(h) < 50:
        return 0.0
    ev = np.linalg.eigvalsh(h.T @ h / len(h))
    return float(ev[0] / ev[1]) if ev[1] > 1e-12 else 0.0


def score(scenes: list[Scene], members: list[Member]) -> float | None:
    """Fill each member's residual_cm and confidence; return the room's loop residual (median over pairs, cm)."""
    pts = [s.lift(step=6) for s in scenes]
    pairs: list[float] = []
    for i, (s, m) in enumerate(zip(scenes, members, strict=True)):
        if m.pose is None:
            continue
        res, shares = [], []
        for j, (t, n) in enumerate(zip(scenes, members, strict=True)):
            if i == j or n.pose is None:
                continue
            r, share = pair_residual(s, m.pose, t, n.pose, pts[i])
            shares.append(share)
            if r is not None:
                res.append(r)
                if i < j:
                    pairs.append(r)
        m.residual_cm = round(100 * float(np.median(res)), 2) if res else None
        overlap = max(shares) if shares else 0.0
        m.extra["overlap"] = round(overlap, 3)
        tilt = float(m.extra.get("tilt_deg", 0.0))
        base = float(m.extra.get("solver_confidence", 1.0))
        cons = constraint(s)
        m.extra["constraint"] = round(cons, 3)
        conf = 0.0 if m.residual_cm is None else (
            min(1.0, overlap / CONF_OVERLAP) * math.exp(-m.residual_cm / CONF_RESIDUAL_CM) * math.exp(-tilt / CONF_TILT_DEG) * base
            * min(1.0, cons / CONF_CONSTRAINT))
        m.confidence = 1.0 if i == 0 else round(conf, 3)
    return round(100 * float(np.median(pairs)), 2) if pairs else None


# ---------------------------------------------------------------------------------------------------- image prep


def prep_images(scenes: list[Scene], long_side: int, patch: int = 14) -> tuple[Any, list[tuple[F64, F64]]]:
    """(S, 3, H, W) float tensor in [0, 1] and each view's (u, v) maps. Same aspect: resize to long_side (sides rounded
    to the patch). Mixed aspects: each photo resized into a long_side square and centered on white (VGGT's "pad")."""
    import torch

    aspects = {round(s.w / s.h, 3) for s in scenes}
    if len(aspects) == 1:
        s0 = scenes[0]
        k = long_side / max(s0.w, s0.h)
        hh, ww = max(patch, round(s0.h * k / patch) * patch), max(patch, round(s0.w * k / patch) * patch)
    else:
        hh = ww = long_side
    ims, uvs = [], []
    for s in scenes:
        with Image.open(s.path / "photo.jpg") as im:
            rgb = im.convert("RGB")
        if len(aspects) == 1:
            arr = np.asarray(rgb.resize((ww, hh), Image.Resampling.LANCZOS), dtype=np.float32) / 255
            u = (np.arange(ww) + 0.5) / ww
            v = (np.arange(hh) + 0.5) / hh
        else:
            k = long_side / max(s.w, s.h)
            cw, ch = round(s.w * k), round(s.h * k)
            canvas = np.ones((hh, ww, 3), dtype=np.float32)
            x0, y0 = (ww - cw) // 2, (hh - ch) // 2
            canvas[y0 : y0 + ch, x0 : x0 + cw] = np.asarray(rgb.resize((cw, ch), Image.Resampling.LANCZOS), dtype=np.float32) / 255
            arr = canvas
            u = (np.arange(ww) + 0.5 - x0) / cw
            v = (np.arange(hh) + 0.5 - y0) / ch
            u[(u < 0) | (u > 1)] = np.nan
            v[(v < 0) | (v > 1)] = np.nan
        ims.append(torch.from_numpy(arr).permute(2, 0, 1))
        uu, vv = np.meshgrid(u, v)
        uvs.append((uu.astype(np.float64), vv.astype(np.float64)))
    return torch.stack(ims), uvs


def to_np(t: Any) -> F64:
    return np.asarray(t.detach().float().cpu().numpy(), dtype=np.float64)


# ---------------------------------------------------------------------------------------------------- the solvers


class Solver:
    name = ""
    needs_torch = True

    def load(self, device: str) -> None: ...

    def solve(self, scenes: list[Scene]) -> list[Member]:
        raise NotImplementedError


class Solv3RSolver(Solver):
    name = "solv3r"

    def load(self, device: str) -> None:
        sys.path.insert(0, str(REPOS / "solv3r"))
        from solv3r import Solv3R  # type: ignore[import-not-found]

        self.device = device
        self.model = Solv3R.from_pretrained(device=device)

    def solve(self, scenes: list[Scene]) -> list[Member]:
        import torch
        from solv3r import cameras_from_pose_enc  # type: ignore[import-not-found]

        calls = int(os.environ.get("SPIKE_SOLV3R_CALLS", "16"))
        imgs, uvs = prep_images(scenes, 504)
        with torch.no_grad():
            ctx = self.model.encode(imgs)
            z = self.model.solve(ctx, calls=calls)
            pred = self.model.decode(z, ctx)
        c2w, kk = cameras_from_pose_enc(pred["pose_enc"], (ctx.H, ctx.W))
        c2w, kk = to_np(c2w), to_np(kk)
        depth = to_np(pred["depth"])[..., 0]
        conf = to_np(pred["depth_conf"])
        views = [View(c2w[i], kk[i], depth[i], conf[i], *uvs[i]) for i in range(len(scenes))]
        return from_views(scenes, views)


class VGGTSolver(Solver):
    name = "vggt"

    def load(self, device: str) -> None:
        import torch
        from huggingface_hub import hf_hub_download

        sys.path.insert(0, str(REPOS / "vggt"))
        from vggt.models.vggt import VGGT  # type: ignore[import-not-found]

        self.device = device
        model = VGGT()
        state = torch.load(hf_hub_download("facebook/VGGT-1B", "model.pt"), map_location="cpu")
        model.load_state_dict(state)
        self.model = model.eval().to(device)

    def solve(self, scenes: list[Scene]) -> list[Member]:
        import torch
        from vggt.utils.pose_enc import pose_encoding_to_extri_intri  # type: ignore[import-not-found]

        imgs, uvs = prep_images(scenes, 518)
        with torch.no_grad():
            pred = self.model(imgs.to(self.device))
        extr, intr = pose_encoding_to_extri_intri(pred["pose_enc"], imgs.shape[-2:])
        w2c, kk = to_np(extr)[0], to_np(intr)[0]
        depth = to_np(pred["depth"])[0, ..., 0]
        conf = to_np(pred["depth_conf"])[0]
        views = []
        for i in range(len(scenes)):
            m = np.eye(4)
            m[:3, :4] = w2c[i]
            views.append(View(np.linalg.inv(m), kk[i], depth[i], conf[i], *uvs[i]))
        return from_views(scenes, views)


class MASt3RSolver(Solver):
    name = "mast3r"

    def load(self, device: str) -> None:
        for p in (REPOS / "mast3r", REPOS / "mast3r" / "dust3r", REPOS / "mast3r" / "dust3r" / "croco"):
            sys.path.insert(0, str(p))
        import scipy.cluster.hierarchy as sch
        import scipy.spatial.distance as ssd
        from mast3r.model import AsymmetricMASt3R  # type: ignore[import-not-found]

        # sparse_ga.py calls scipy.cluster.hierarchy.distance.squareform, an alias newer scipy no longer exports
        if not hasattr(sch, "distance"):
            sch.distance = ssd  # type: ignore[attr-defined]

        self.device = device
        self.model = AsymmetricMASt3R.from_pretrained("naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric").to(device)

    def solve(self, scenes: list[Scene]) -> list[Member]:
        from dust3r.image_pairs import make_pairs  # type: ignore[import-not-found]
        from dust3r.utils.image import load_images  # type: ignore[import-not-found]
        from mast3r.cloud_opt.sparse_ga import sparse_global_alignment  # type: ignore[import-not-found]

        with tempfile.TemporaryDirectory(prefix="midstudy-spike-mast3r-") as tmp:
            paths = []
            for i, s in enumerate(scenes):  # distinct names: MASt3R's cache keys on them (symlinks, no copies)
                p = Path(tmp) / f"m{i:02d}.jpg"
                p.symlink_to((s.path / "photo.jpg").resolve())
                paths.append(str(p))
            imgs = load_images(paths, size=512, verbose=False)
            pairs = make_pairs(imgs, scene_graph="complete", prefilter=None, symmetrize=True)
            scene = sparse_global_alignment(paths, pairs, str(Path(tmp) / "cache"), self.model, lr1=0.07, niter1=300, lr2=0.01,
                                            niter2=300, device=self.device, opt_depth=True, shared_intrinsics=False,
                                            matching_conf_thr=0.0)
            c2w = [to_np(m) for m in scene.get_im_poses()]
            kk = [to_np(m) for m in scene.intrinsics]
            _, depths, confs = scene.get_dense_pts3d(clean_depth=True)
            views = []
            for i, s in enumerate(scenes):
                hh, ww = (int(x) for x in imgs[i]["true_shape"][0])
                # dust3r's load_images: long side resized to 512, then the center cropped to multiples of 16
                k = 512 / max(s.w, s.h)
                rw, rh = round(s.w * k), round(s.h * k)
                x0, y0 = rw // 2 - ww / 2, rh // 2 - hh / 2
                uu, vv = np.meshgrid((np.arange(ww) + 0.5 + x0) / rw, (np.arange(hh) + 0.5 + y0) / rh)
                d = to_np(depths[i]).reshape(hh, ww)
                cf = to_np(confs[i]).reshape(hh, ww)
                views.append(View(c2w[i], kk[i], d, cf, uu, vv))
        return from_views(scenes, views)


class ManhattanSolver(Solver):
    """No ML: each member's depth.png lifted floor-up (its calib), its walls' direction snapped to two square
    directions, then placed against the room built so far by 2D cross-correlation of top-down density maps over the
    four 90° turns and a few scales, refined by 2D ICP. Members are added greedily, best match first."""

    name = "manhattan"
    needs_torch = False
    CELL = 0.05
    SCALES = (0.94, 0.96, 0.98, 1.0, 1.02, 1.04, 1.06)

    def solve(self, scenes: list[Scene]) -> list[Member]:
        from scipy import ndimage

        clouds = [self.cloud(s) for s in scenes]
        dirs = [self.wall_direction(s) for s in scenes]
        placed: dict[int, Pose] = {0: Pose(0.0, 0.0, 0.0, 1.0)}
        extras: dict[int, dict[str, Any]] = {0: {"wall_dir_deg": round(math.degrees(dirs[0]), 2)}}
        todo = set(range(1, len(scenes)))
        while todo:
            room = np.concatenate([placed[k].scene_to_room(clouds[k])[:, [0, 2]] for k in placed])
            best: tuple[float, int, Pose, dict[str, Any]] | None = None
            for i in todo:
                r = self.match(room, clouds[i], dirs[i] - dirs[0], ndimage)
                if r is not None and (best is None or r[0] > best[0]):
                    best = (r[0], i, r[1], r[2])
            if best is None:
                break
            _, i, pose, ex = best
            ex["wall_dir_deg"] = round(math.degrees(dirs[i]), 2)
            placed[i], extras[i] = pose, ex
            todo.discard(i)
        out = []
        for i, s in enumerate(scenes):
            ex = extras.get(i, {})
            out.append(Member(s.name, placed.get(i), 1.0, None, ex))
        return out

    @staticmethod
    def cloud(s: Scene) -> F64:
        p = s.lift(step=3)
        keep = (p[:, 1] > 0.1) & (p[:, 1] < 2.0)
        return p[keep]

    @staticmethod
    def wall_direction(s: Scene) -> float:
        """The walls' direction mod 90° (radians, in (−45°, 45°]) from depth.png normals, in the scene frame."""
        step = 3
        dh, dw = s.depth.shape
        d = s.depth[step // 2 :: step, step // 2 :: step]
        f = (dh / 2) / math.tan(s.fov_y / 2)
        jj, ii = np.mgrid[step // 2 : dh : step, step // 2 : dw : step]
        pc = np.stack([(ii + 0.5 - dw / 2) / f * d, -(jj + 0.5 - dh / 2) / f * d, -d], axis=-1)
        p = pc @ s.r_gl.T
        dx = p[1:-1, 2:] - p[1:-1, :-2]
        dy = p[2:, 1:-1] - p[:-2, 1:-1]
        n = np.cross(dx, dy)
        nn = np.linalg.norm(n, axis=-1, keepdims=True)
        ok = (d[1:-1, 1:-1] > 0) & (d[1:-1, 2:] > 0) & (d[1:-1, :-2] > 0) & (d[2:, 1:-1] > 0) & (d[:-2, 1:-1] > 0)
        ok &= nn[..., 0] > 1e-9
        n = n[ok] / nn[ok]
        n = n[np.abs(n[:, 1]) < 0.25]
        if len(n) < 50:
            return 0.0
        theta = np.arctan2(-n[:, 2], n[:, 0])  # Ry(a) adds a to this angle
        w = np.hypot(n[:, 0], n[:, 2])
        z = np.sum(w * np.exp(4j * theta))
        return float(np.angle(z) / 4)

    def raster(self, pts: F64, origin: F64, shape: tuple[int, int], ndimage: Any) -> F64:
        g = np.zeros(shape)
        ij = np.floor((pts - origin) / self.CELL).astype(np.int64)
        ok = (ij[:, 0] >= 0) & (ij[:, 0] < shape[0]) & (ij[:, 1] >= 0) & (ij[:, 1] < shape[1])
        np.add.at(g, (ij[ok, 0], ij[ok, 1]), 1.0)
        g = np.log1p(g)
        return np.asarray(ndimage.gaussian_filter(g, 1.0), dtype=np.float64)

    def match(self, room: F64, cloud: F64, dir_delta: float, ndimage: Any) -> tuple[float, Pose, dict[str, Any]] | None:
        """Best (score, pose) of one member against the room's top-down points (x, z), or None."""
        lo = room.min(axis=0) - 6.0
        size = room.max(axis=0) + 6.0 - lo
        shape = (int(size[0] / self.CELL) + 1, int(size[1] / self.CELL) + 1)
        ref = self.raster(room, lo, shape, ndimage)
        fr = np.fft.rfft2(ref)
        cands: list[tuple[float, float, float, float, float]] = []
        for k in range(4):
            yaw = -dir_delta + k * math.pi / 2
            for sc in self.SCALES:
                pts = (sc * cloud @ ry(yaw).T)[:, [0, 2]]
                g = self.raster(pts, lo, shape, ndimage)
                corr = np.fft.irfft2(fr * np.conj(np.fft.rfft2(g)), s=shape)
                idx = np.unravel_index(int(np.argmax(corr)), shape)
                norm = math.sqrt(float((ref * ref).sum()) * float((g * g).sum())) or 1.0
                sh = [float(idx[0]), float(idx[1])]
                for ax in range(2):  # sub-cell peak (parabola)
                    a = list(idx)
                    a[ax] = (idx[ax] - 1) % shape[ax]
                    b = list(idx)
                    b[ax] = (idx[ax] + 1) % shape[ax]
                    cm, c0, cp = corr[tuple(a)], corr[idx], corr[tuple(b)]
                    den = cm - 2 * c0 + cp
                    if den < 0:
                        sh[ax] += 0.5 * (cm - cp) / den
                sx = (sh[0] if sh[0] < shape[0] / 2 else sh[0] - shape[0]) * self.CELL
                sz = (sh[1] if sh[1] < shape[1] / 2 else sh[1] - shape[1]) * self.CELL
                cands.append((float(corr[idx]) / norm, yaw, sc, sx, sz))
        cands.sort(reverse=True)
        s_best, yaw, sc, sx, sz = cands[0]
        other = next((c for c in cands[1:] if abs(wrap_deg(math.degrees(c[1] - yaw))) > 45), None)
        ratio = s_best / other[0] if other and other[0] > 0 else 2.0
        pose = self.icp(room, cloud, Pose(sx, sz, yaw, sc))
        ex = {"score": round(s_best, 4), "peak_ratio": round(ratio, 3),
              "solver_confidence": round(min(1.0, max(0.0, (ratio - 1.0) / 0.3)), 3)}
        return s_best, pose, ex

    @staticmethod
    def icp(room: F64, cloud: F64, pose: Pose, iters: int = 30) -> Pose:
        """2D point-to-point ICP (turn and shift; scale kept) with a shrinking trim radius."""
        from scipy.spatial import cKDTree

        tree = cKDTree(room)
        src = pose.scale * cloud[:, [0, 2]]
        yaw, t = pose.yaw, np.array([pose.x, pose.z])
        rng = np.random.default_rng(0)
        if len(src) > 20000:
            src = src[rng.choice(len(src), 20000, replace=False)]
        radius = 0.3
        for _ in range(iters):
            c, s = math.cos(yaw), math.sin(yaw)
            m = np.array([[c, s], [-s, c]])  # Ry on (x, z)
            cur = src @ m.T + t
            dist, idx = tree.query(cur, distance_upper_bound=radius)
            ok = np.isfinite(dist)
            if ok.sum() < 50:
                break
            a, b = src[ok], room[idx[ok]]
            ma, mb = a.mean(0), b.mean(0)
            h = (a - ma).T @ (b - mb)
            u, _, vt = np.linalg.svd(h)
            r = vt.T @ u.T
            if np.linalg.det(r) < 0:
                vt[-1] *= -1
                r = vt.T @ u.T
            yaw = math.atan2(r[0, 1], r[0, 0])
            t = mb - ma @ r.T
            radius = max(0.06, radius * 0.85)
        return Pose(float(t[0]), float(t[1]), yaw, pose.scale)


SOLVERS: dict[str, Callable[[], Solver]] = {"solv3r": Solv3RSolver, "vggt": VGGTSolver, "mast3r": MASt3RSolver,
                                            "manhattan": ManhattanSolver}


# ---------------------------------------------------------------------------------------------------- refine


def refine(scenes: list[Scene], members: list[Member], passes: int = 3, iters: int = 25) -> None:
    """--refine icp (stage 2): every placed member but the first re-fitted against the others' depth.png points by
    trimmed 3D point-to-point ICP restricted to the §3.1 unknowns (a turn about Y and a shift on the floor; scale
    kept). Correspondences are 3D (walls and furniture; depth.png masks the floor), the update is the 2D Procrustes
    of their (x, z). A member with too few matches keeps the solver's pose. Moves are recorded in extra."""
    from scipy.spatial import cKDTree

    rng = np.random.default_rng(0)
    clouds = []
    for s in scenes:
        c = s.lift(step=3)
        if len(c) > 30000:
            c = c[rng.choice(len(c), 30000, replace=False)]
        clouds.append(c)
    start = {i: (m.pose.x, m.pose.z, m.pose.yaw) for i, m in enumerate(members) if m.pose is not None}
    for _ in range(passes):
        for i, m in enumerate(members):
            if i == 0 or m.pose is None:
                continue
            others = [n.pose.scene_to_room(clouds[j]) for j, n in enumerate(members) if j != i and n.pose is not None]
            if not others:
                continue
            ref = np.concatenate(others)
            tree = cKDTree(ref)
            src = m.pose.scale * clouds[i]  # scene frame at member scale; pose turn + shift applied below
            yaw, t = m.pose.yaw, np.array([m.pose.x, m.pose.z])
            radius = 0.4
            n_ok = 0
            for _k in range(iters):
                cur = src @ ry(yaw).T + np.array([t[0], 0.0, t[1]])
                dist, idx = tree.query(cur, distance_upper_bound=radius)
                ok = np.isfinite(dist)
                n_ok = int(ok.sum())
                if n_ok < 200:
                    break
                a2, b2 = src[ok][:, [0, 2]], ref[idx[ok]][:, [0, 2]]
                # (x, z) of Ry(yaw)·p is [[c, s], [-s, c]]·(x, z): fit that rotation by Procrustes
                ma, mb = a2.mean(0), b2.mean(0)
                h = (a2 - ma).T @ (b2 - mb)
                u_, _, vt = np.linalg.svd(h)
                r2 = vt.T @ u_.T
                if np.linalg.det(r2) < 0:
                    vt[-1] *= -1
                    r2 = vt.T @ u_.T
                yaw = math.atan2(r2[0, 1], r2[0, 0])
                t = mb - ma @ r2.T
                radius = max(0.05, radius * 0.85)
            if n_ok >= 200:
                m.pose = Pose(float(t[0]), float(t[1]), yaw, m.pose.scale)
    for i, m in enumerate(members):
        if i in start and m.pose is not None:
            x0, z0, y0 = start[i]
            m.extra["refine_moved_cm"] = round(100 * math.hypot(m.pose.x - x0, m.pose.z - z0), 2)
            m.extra["refine_turned_deg"] = round(abs(wrap_deg(math.degrees(m.pose.yaw - y0))), 3)


# ---------------------------------------------------------------------------------------------------- truth


def truth_row(scenes: list[Scene], members: list[Member]) -> dict[str, Any]:
    """Errors against truth.json pose_in_room, both re-expressed relative to the first member."""
    t0 = scenes[0].truth or {"x_m": 0.0, "z_m": 0.0, "yaw_deg": 0.0}
    y0 = math.radians(t0["yaw_deg"])
    pos, yaw, scl, rows = [], [], [], []
    unplaced = confident_wrong = 0
    for s, m in zip(scenes, members, strict=True):
        t = s.truth or {"x_m": 0.0, "z_m": 0.0, "yaw_deg": 0.0}
        rel = ry(-y0) @ np.array([t["x_m"] - t0["x_m"], 0.0, t["z_m"] - t0["z_m"]])
        tyaw = t["yaw_deg"] - t0["yaw_deg"]
        tscale = float(t.get("scale", 1.0)) / float(t0.get("scale", 1.0))
        if m.pose is None:
            unplaced += 1
            rows.append({"scene": s.name, "unplaced": True})
            continue
        e_pos = 100 * math.hypot(m.pose.x - rel[0], m.pose.z - rel[2])
        e_yaw = abs(wrap_deg(math.degrees(m.pose.yaw) - tyaw))
        e_scl = 100 * abs(m.pose.scale / tscale - 1)
        pos.append(e_pos)
        yaw.append(e_yaw)
        scl.append(e_scl)
        wrong = e_pos > 2 * TARGET_POS_CM or e_yaw > 2 * TARGET_YAW_DEG or e_scl > 2 * TARGET_SCALE_PCT
        if wrong and m.confidence >= 0.5:
            confident_wrong += 1
        rows.append({"scene": s.name, "pos_err_cm": round(e_pos, 2), "yaw_err_deg": round(e_yaw, 3),
                     "scale_err_pct": round(e_scl, 3), "confidence": m.confidence, "truth_assumed_origin": "assumed" in t})
    def stat(xs: list[float], f: Callable[[list[float]], float]) -> float | None:
        return round(float(f(xs)), 3) if xs else None
    return {"pos_err_cm_median": stat(pos, np.median), "pos_err_cm_max": stat(pos, max), "yaw_err_deg_median": stat(yaw, np.median),
            "yaw_err_deg_max": stat(yaw, max), "scale_err_pct_max": stat(scl, max), "unplaced": unplaced,
            "confident_wrong": confident_wrong, "members": rows}


# ---------------------------------------------------------------------------------------------------- timing, memory


def pick_device(want: str) -> str:
    if want != "auto":
        return want
    import torch

    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


class MemWatch:
    """Peak process RSS (ru_maxrss) and peak MPS driver memory (sampled every 0.1 s), in GB."""

    def __init__(self) -> None:
        self.mps_peak = 0
        self._stop = threading.Event()
        self._t: threading.Thread | None = None

    def _sample(self) -> None:
        try:
            import torch

            if not torch.backends.mps.is_available():
                return
            while not self._stop.wait(0.1):
                self.mps_peak = max(self.mps_peak, int(torch.mps.driver_allocated_memory()))
        except Exception:
            return

    @contextlib.contextmanager
    def watching(self, torch_loaded: bool) -> Iterator[None]:
        if torch_loaded:
            self._t = threading.Thread(target=self._sample, daemon=True)
            self._t.start()
        try:
            yield
        finally:
            self._stop.set()
            if self._t:
                self._t.join()

    def report(self) -> dict[str, float]:
        rss = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        rss_b = rss if sys.platform == "darwin" else rss * 1024
        return {"rss_peak_gb": round(rss_b / 1e9, 3), "mps_driver_peak_gb": round(self.mps_peak / 1e9, 3),
                "peak_mem_gb": round((rss_b + self.mps_peak) / 1e9, 3)}


def member_json(m: Member) -> dict[str, Any]:
    out: dict[str, Any] = {"scene": m.scene}
    if m.pose is None:
        out["pose"] = None
    else:
        out["pose"] = {"x_m": round(m.pose.x, 4), "z_m": round(m.pose.z, 4), "yaw_deg": round(wrap_deg(math.degrees(m.pose.yaw)), 3)}
        out["scale"] = round(m.pose.scale, 5)
    out["confidence"] = m.confidence
    out["residual_cm"] = m.residual_cm
    out.update(m.extra)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("scenes", nargs="+", type=Path)
    ap.add_argument("--solver", required=True, choices=sorted(SOLVERS))
    ap.add_argument("--device", default="auto", choices=["auto", "mps", "cpu", "cuda"])
    ap.add_argument("--truth", action="store_true", help="compare with truth.json pose_in_room")
    ap.add_argument("--repeat", type=int, default=2, help="solves in this process (first = cold incl. model load)")
    ap.add_argument("--refine", default="none", choices=["none", "icp"],
                    help="icp: re-fit each member against the others' depth points (turn + shift) after the solver")
    ap.add_argument("--out", type=Path, help="also write the answer here (keep it under evals/out/)")
    a = ap.parse_args(argv)
    if len(a.scenes) < 2:
        ap.error("give at least two scene folders")

    t_start = time.perf_counter()
    scenes = [load_scene(d) for d in a.scenes]
    solver = SOLVERS[a.solver]()
    device = "cpu"
    if solver.needs_torch:
        os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
        import torch  # noqa: F401  (timed: part of the cold start)

        device = pick_device(a.device)
    t_import = time.perf_counter() - t_start
    mem = MemWatch()
    solves: list[float] = []
    members: list[Member] = []
    loop: float | None = None
    with mem.watching(solver.needs_torch):
        t0 = time.perf_counter()
        log(f"{a.solver}: loading on {device}")
        solver.load(device)
        t_load = time.perf_counter() - t0
        for k in range(max(1, a.repeat)):
            t1 = time.perf_counter()
            members = solver.solve(scenes)
            if a.refine == "icp":
                refine(scenes, members)
            loop = score(scenes, members)
            solves.append(time.perf_counter() - t1)
            log(f"{a.solver}: solve {k + 1} took {solves[-1]:.2f} s")
    for m in members:
        if m.pose is not None and m.confidence < MIN_CONFIDENCE:
            m.extra["rejected_pose"] = member_json(m)["pose"]
            m.pose = None
    result: dict[str, Any] = {
        "solver": a.solver, "refine": a.refine, "device": device, "members": [member_json(m) for m in members],
        "unplaced": [m.scene for m in members if m.pose is None], "loop_residual_cm": loop,
        "timing": {"import_s": round(t_import, 2), "load_s": round(t_load, 2), "solve_s": [round(x, 2) for x in solves],
                   "cold_s": round(t_import + t_load + solves[0], 2), "warm_s": round(solves[1], 2) if len(solves) > 1 else None},
        "memory": mem.report(),
    }
    if a.truth:
        result["truth"] = truth_row(scenes, members)
    text = json.dumps(result, indent=1)
    if a.out:
        a.out.parent.mkdir(parents=True, exist_ok=True)
        a.out.write_text(text + "\n")
    print(text)
    return 0


if __name__ == "__main__":
    sys.exit(main())
