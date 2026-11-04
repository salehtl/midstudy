"""Floor plane from a metric point map, and the contract §4.1 camera block from that plane. numpy only.

Frames
------
MoGe works in the OpenCV camera frame: x right, y down, z forward (z is the depth along the view axis).
The contract's camera frame is three.js's: x right, y up, looking along -z. So p_three = F @ p_cv with F = diag(1, -1, -1).

The contract camera is R = Rx(pitch) @ Rz(roll) (camera-to-world, three.js Euler 'YXZ', yaw 0). World up (0, 1, 0)
seen from the camera is R^T @ e_y, the second row of R:

    n_three = (cos p * sin r,  cos p * cos r,  -sin p)

so with the floor's unit normal n (pointing up, towards the camera) expressed in the three.js camera frame:

    pitch = asin(-n_three.z),   roll = atan2(n_three.x, n_three.y),   height = distance from the camera to the plane.
"""
from __future__ import annotations

import math

import numpy as np

CV_TO_THREE = np.array([1.0, -1.0, -1.0])
MIN_UP = 0.15          # n . (camera up) of an acceptable floor: pitch -80 with roll 20 still passes (cos80 * cos20 = 0.163)
HEIGHT_RANGE = (0.15, 3.5)
NORMAL_AGREE_DEG = 30  # a pixel's own normal must be this close to the plane's to count as floor
MASK_M = 0.04          # floor pixels within 4 cm of the plane are masked in depth.png (contract §4.3)


def camera_from_plane(n_cv: np.ndarray, d: float) -> tuple[float, float, float]:
    """(height_m, pitch_deg, roll_deg) from the floor plane n . p + d = 0 in the OpenCV camera frame, n pointing up
    (towards the camera, so d > 0 is the camera's height above the floor)."""
    n = np.asarray(n_cv, float) / np.linalg.norm(n_cv)
    t = n * CV_TO_THREE
    pitch = math.degrees(math.asin(max(-1.0, min(1.0, -t[2]))))
    roll = math.degrees(math.atan2(t[0], t[1]))
    return float(d), pitch, roll


def plane_from_camera(height_m: float, pitch_deg: float, roll_deg: float) -> tuple[np.ndarray, float]:
    """The inverse of camera_from_plane: the floor plane (n_cv, d) seen from a contract camera."""
    p, r = math.radians(pitch_deg), math.radians(roll_deg)
    t = np.array([math.cos(p) * math.sin(r), math.cos(p) * math.cos(r), -math.sin(p)])
    return t * CV_TO_THREE, float(height_m)


def fov_y_from_intrinsics(fy_norm: float) -> float:
    """MoGe's normalized intrinsics (fy in units of the image height) -> vertical FOV in degrees."""
    return math.degrees(2 * math.atan(0.5 / fy_norm))


def _plane_lsq(pts: np.ndarray, w: np.ndarray | None = None) -> tuple[np.ndarray, float]:
    """Least-squares plane through points: (unit normal, d) with n . p + d = 0 and d >= 0 (normal towards the origin)."""
    if w is None:
        c = pts.mean(0)
        q = pts - c
    else:
        c = (pts * w[:, None]).sum(0) / w.sum()
        q = (pts - c) * np.sqrt(w)[:, None]
    _, _, vt = np.linalg.svd(q, full_matrices=False)
    n = vt[2]
    d = -float(n @ c)
    if d < 0:
        n, d = -n, -d
    return n, d


def fit_floor(points: np.ndarray, normals: np.ndarray | None, valid: np.ndarray, *, rng_seed: int = 0,
              iterations: int = 600, sample_step: int = 3) -> dict | None:
    """RANSAC for the floor: the plane below the camera, facing up, with the most support weighted towards the bottom
    of the image (so the room's own floor wins over a lower floor seen through glass or a reflection).

    points: (h, w, 3) metric points in the OpenCV camera frame; normals: (h, w, 3) unit normals in the same frame (or
    None); valid: (h, w) bool. Returns {n, d, inliers (h, w) bool, inlier_ratio, rmse_m, below (h, w) bool} or None."""
    h, w = valid.shape
    finite = valid & np.isfinite(points).all(-1) & (points[..., 2] > 0)
    up_cv = np.array([0.0, -1.0, 0.0])
    cand = finite.copy()
    if normals is not None:
        nn = np.nan_to_num(normals)
        # Floors face the camera's up side for any pitch the contract allows. Walls facing a downward-looking camera
        # and ceilings fail this; side walls only pass with a large roll.
        cand &= (nn @ up_cv) > MIN_UP
    rows = np.broadcast_to(np.arange(h)[:, None], (h, w))
    # subsample for the hypothesis search
    sub = np.zeros_like(cand)
    sub[::sample_step, ::sample_step] = True
    idx = np.flatnonzero(cand & sub)
    if idx.size < 200:
        return None
    P = points.reshape(-1, 3)[idx]
    Nrm = None if normals is None else np.nan_to_num(normals).reshape(-1, 3)[idx]
    weight = 0.2 + (rows.reshape(-1)[idx] / h) ** 2  # the bottom rows count about 6x the top ones
    z = P[:, 2]
    thr = np.maximum(MASK_M, 0.012 * z)  # MoGe's error grows with distance

    rng = np.random.default_rng(rng_seed)
    best = None
    batch = 100
    for _ in range(iterations // batch):
        tri = rng.integers(0, idx.size, size=(batch, 3))
        a, b, c = P[tri[:, 0]], P[tri[:, 1]], P[tri[:, 2]]
        n = np.cross(b - a, c - a)
        norm = np.linalg.norm(n, axis=1)
        ok = norm > 1e-9
        n = n[ok] / norm[ok, None]
        a = a[ok]
        d = -(n * a).sum(1)
        flip = d < 0
        n[flip] *= -1
        d[flip] *= -1
        # facing up relative to the camera, camera above it by a plausible height
        good = ((n @ up_cv) > MIN_UP) & (d > HEIGHT_RANGE[0]) & (d < HEIGHT_RANGE[1])
        n, d = n[good], d[good]
        if not len(n):
            continue
        dist = np.abs(P @ n.T + d[None, :])  # (N, K)
        inl = dist < thr[:, None]
        if Nrm is not None:
            inl &= (Nrm @ n.T) > math.cos(math.radians(NORMAL_AGREE_DEG))
        score = (inl * weight[:, None]).sum(0)
        k = int(np.argmax(score))
        if best is None or score[k] > best[0]:
            best = (float(score[k]), n[k], float(d[k]))
    if best is None:
        return None
    _, n, d = best

    # refine on the full grid: least squares on the inliers, twice
    Pall = points.reshape(-1, 3)
    Nall = None if normals is None else np.nan_to_num(normals).reshape(-1, 3)
    fin = finite.reshape(-1)
    zall = np.where(fin, Pall[:, 2], np.inf)
    thr_all = np.maximum(MASK_M, 0.012 * zall)
    for _ in range(3):
        dist = np.where(fin, Pall @ n + d, np.inf)
        inl = fin & (np.abs(dist) < thr_all)
        if Nall is not None:
            inl &= (Nall @ n) > math.cos(math.radians(NORMAL_AGREE_DEG))
        if inl.sum() < 100:
            return None
        n, d = _plane_lsq(Pall[inl])
        if (n @ up_cv) <= MIN_UP or not (HEIGHT_RANGE[0] < d < HEIGHT_RANGE[1]):
            return None
    signed = np.where(fin, Pall @ n + d, np.nan)
    inl = fin & (np.abs(signed) < thr_all)
    if Nall is not None:
        inl &= (Nall @ n) > math.cos(math.radians(NORMAL_AGREE_DEG))
    rmse = float(np.sqrt(np.mean(signed[inl] ** 2)))
    return {
        "n": n, "d": float(d),
        "inliers": inl.reshape(h, w),
        "inlier_ratio": float(inl.sum() / (h * w)),
        "rmse_m": rmse,
        "signed": signed.reshape(h, w),  # signed distance to the plane, + above (camera side); nan where invalid
    }


def depth_mm(points: np.ndarray, valid: np.ndarray, floor: dict | None) -> tuple[np.ndarray, bool]:
    """depth.png's content: uint16 mm along the view axis (OpenCV z), 0 where unknown, on the floor (within 4 cm of the
    plane, a little more far away where MoGe is noisier) or below it (reflections, a lower floor seen through glass:
    the floor plane is always nearer along those rays, so they can never hide anything standing on it)."""
    z = points[..., 2]
    ok = valid & np.isfinite(z) & (z > 0)
    mm = np.where(ok, np.rint(z * 1000.0), 0)
    mm[mm > 65535] = 0
    masked = False
    if floor is not None:
        s = floor["signed"]
        tol = np.maximum(MASK_M, 0.012 * np.where(ok, z, 0))
        on_or_below = np.isfinite(s) & (s < tol)
        mm[on_or_below] = 0
        masked = True
    return mm.astype(np.uint16), masked
