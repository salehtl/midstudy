"""One scene folder as align-room reads it (contract §4.2, §4.9): photo.jpg (its SHA-256 and size), calib.json's camera
and depth.png, plus §4.1's projection on depth.png's grid. align-room only reads scene folders.
"""
from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import numpy as np
from numpy.typing import NDArray
from PIL import Image

from ..util import Fail, read_json
from .geometry import F64, rx, rz

SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
FLIP = np.diag([1.0, -1.0, -1.0])  # OpenCV camera axes (x right, y down, z forward) <-> three.js (y up, looking −z)


@dataclass(frozen=True)
class Camera:
    """calib.json's camera block, angles in radians."""

    fov_y: float
    height: float
    pitch: float
    roll: float


@dataclass(frozen=True)
class RoomPhoto:
    """A member: its folder, name, photo.jpg's SHA-256 and size, and (when present) its calibration and depth
    (metres along the view axis, 0 = no occluder: the floor, contract §4.3 Fit)."""

    path: Path
    name: str
    sha256: str
    w: int
    h: int
    camera: Camera | None
    depth: F64 | None

    @property
    def usable(self) -> bool:
        """A solver can place it and score it: it has calib.json's camera and a depth.png with some depth."""
        return self.camera is not None and self.depth is not None and bool((self.depth > 0).any())

    def cam(self) -> Camera:
        if self.camera is None:
            raise ValueError(f"{self.name} has no calibration")
        return self.camera

    def dep(self) -> F64:
        if self.depth is None:
            raise ValueError(f"{self.name} has no depth.png")
        return self.depth

    @property
    def r_gl(self) -> F64:
        """Camera-to-scene rotation in three.js camera axes (contract §4.1: Ry(0)·Rx(pitch)·Rz(roll))."""
        c = self.cam()
        return rx(c.pitch) @ rz(c.roll)

    @property
    def r_cv(self) -> F64:
        """Camera-to-scene rotation in OpenCV camera axes (what the learned solvers use)."""
        return self.r_gl @ FLIP

    def _focal(self) -> float:
        """depth.png's focal length in its pixels (contract §4.2: the same projection at a smaller size)."""
        return (self.dep().shape[0] / 2) / math.tan(self.cam().fov_y / 2)

    def depth_at_uv(self, u: F64, v: F64) -> F64:
        """depth.png (nearest) at normalized photo coordinates (0..1 across the photo); 0 outside, NaN or unknown."""
        d = self.dep()
        dh, dw = d.shape
        fin = np.isfinite(u) & np.isfinite(v)
        i = np.floor(np.where(fin, u, -1.0) * dw).astype(np.int64)
        j = np.floor(np.where(fin, v, -1.0) * dh).astype(np.int64)
        ok = (i >= 0) & (i < dw) & (j >= 0) & (j < dh) & fin
        out = np.zeros(u.shape, dtype=np.float64)
        out[ok] = d[j[ok], i[ok]]
        return out

    def floor_at_uv(self, u: F64, v: F64) -> NDArray[np.bool_]:
        """Photo points that show the floor: depth.png 0 (floor-masked) and clearly below the horizon."""
        f = 0.5 / math.tan(self.cam().fov_y / 2)  # in photo heights
        dc = np.stack([(u - 0.5) * (self.w / self.h) / f, -(v - 0.5) / f, -np.ones_like(u)], axis=-1)
        dy = (dc @ self.r_gl.T)[..., 1] / np.linalg.norm(dc, axis=-1)
        return np.isfinite(u) & np.isfinite(v) & (self.depth_at_uv(u, v) == 0) & (dy < -0.1)

    def camera_points(self, step: int) -> tuple[F64, NDArray[np.bool_]]:
        """depth.png every step-th pixel as scene-frame directions times depth, without the camera's height:
        (gh, gw, 3) points relative to the camera, and where depth > 0."""
        d = self.dep()
        dh, dw = d.shape
        f = self._focal()
        sub = d[step // 2 :: step, step // 2 :: step]
        jj, ii = np.mgrid[step // 2 : dh : step, step // 2 : dw : step]
        pc = np.stack([(ii + 0.5 - dw / 2) / f * sub, -(jj + 0.5 - dh / 2) / f * sub, -sub], axis=-1)
        return pc @ self.r_gl.T, sub > 0

    def lift_rel(self, step: int = 4) -> F64:
        """depth.png's points with depth (every step-th pixel) relative to the camera, scene axes, (n, 3)."""
        p, ok = self.camera_points(step)
        return p[ok]

    def lift(self, step: int = 4) -> F64:
        """depth.png's points with depth (every step-th pixel) in the scene frame, (n, 3)."""
        return self.lift_rel(step) + np.array([0.0, self.cam().height, 0.0])

    def project(self, p_scene: F64) -> tuple[F64, F64, F64]:
        """Scene-frame points -> depth.png pixel coordinates (continuous, contract §4.1) and view-axis depth."""
        d = self.dep()
        dh, dw = d.shape
        f = self._focal()
        pc = (p_scene - np.array([0.0, self.cam().height, 0.0])) @ self.r_gl
        z = -pc[:, 2]
        with np.errstate(divide="ignore", invalid="ignore"):
            px = dw / 2 + f * pc[:, 0] / z
            py = dh / 2 - f * pc[:, 1] / z
        return px, py, z


def _camera(scene: Path) -> Camera | None:
    """calib.json's camera, or None when it is missing or unreadable (that photo can't be placed)."""
    try:
        data = read_json(scene / "calib.json")
    except (OSError, ValueError):
        return None
    cam = cast(dict[str, object], data).get("camera") if isinstance(data, dict) else None
    if not isinstance(cam, dict):
        return None
    c = cast(dict[str, object], cam)
    vals: list[float] = []
    for k in ("fov_y_deg", "height_m", "pitch_deg", "roll_deg"):
        v = c.get(k)
        if not isinstance(v, int | float) or isinstance(v, bool) or not math.isfinite(v):
            return None
        vals.append(float(v))
    fov, height, pitch, roll = vals
    if not (1.0 < fov < 179.0 and height > 0):
        return None
    return Camera(math.radians(fov), height, math.radians(pitch), math.radians(roll))


def _depth(scene: Path) -> F64 | None:
    """depth.png in metres (16-bit mm, contract §4.2), or None when it is missing or unreadable."""
    p = scene / "depth.png"
    if not p.is_file():
        return None
    try:
        with Image.open(p) as im:
            arr = np.asarray(im, dtype=np.float64)
    except (OSError, ValueError):
        return None
    if arr.ndim != 2 or min(arr.shape) < 8:
        return None
    return arr / 1000.0


def sha256_of(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load(scene: Path) -> RoomPhoto:
    """A scene folder (contract §4.9: a missing folder or photo.jpg is the command's failure, one sentence)."""
    name = scene.resolve().name if scene.name in ("", ".", "..") else scene.name
    if not scene.is_dir():
        raise Fail(f"{scene} isn't a scene folder")
    if not SLUG.fullmatch(name):
        raise Fail(f"{scene} isn't a scene folder: its name {name!r} isn't a scene name")
    photo = scene / "photo.jpg"
    if not photo.is_file():
        raise Fail(f"{scene} has no photo.jpg")
    try:
        with Image.open(photo) as im:
            w, h = im.size
    except (OSError, ValueError):
        raise Fail(f"{photo} isn't a readable image") from None
    return RoomPhoto(scene, name, sha256_of(photo), w, h, _camera(scene), _depth(scene))
