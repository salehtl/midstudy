"""Synthetic inputs shared by the tests: the contract §4.1 camera in numpy, point maps made the way MoGe reports them,
and a box room rendered like three.js with a known light (MoGe-like outputs, no weights needed)."""
from __future__ import annotations

import json
import math
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import numpy as np
from numpy.typing import NDArray

from midstudy_calib import lighting as lt
from midstudy_calib.contract_types import Camera
from midstudy_calib.moge_runner import MogeOutput

type F64 = NDArray[np.float64]
type Bools = NDArray[np.bool_]
type U8 = NDArray[np.uint8]

REPO = Path(__file__).resolve().parents[2]
CV = np.array([1.0, -1.0, -1.0])


def camera(fov: float, height: float, pitch: float, roll: float) -> Camera:
    return Camera(fov_y_deg=fov, height_m=height, pitch_deg=pitch, roll_deg=roll)


def load_json(path: Path) -> object:
    data: object = json.loads(path.read_text())
    return data


def jget(obj: object, *path: str | int) -> object:
    """obj[path[0]][path[1]]..., checking at each step that it is a JSON object (str key) or array (int index)."""
    for k in path:
        if isinstance(k, str):
            assert isinstance(obj, dict), (k, obj)
            obj = cast(dict[str, object], obj)[k]
        else:
            assert isinstance(obj, list), (k, obj)
            obj = cast(list[object], obj)[k]
    return obj


def jlist(obj: object, *path: str | int) -> list[object]:
    v = jget(obj, *path)
    assert isinstance(v, list)
    return cast(list[object], v)


def jnum(obj: object, *path: str | int) -> float:
    v = jget(obj, *path)
    assert isinstance(v, int | float) and not isinstance(v, bool), v
    return float(v)


def jarray(obj: object, *path: str | int) -> F64:
    return np.asarray(jget(obj, *path), np.float64)


def truth(sid: str) -> object:
    return load_json(REPO / f"fixtures/scenes/{sid}/truth.json")


def truth_camera(sid: str) -> Camera:
    t = truth(sid)
    return camera(jnum(t, "camera", "fov_y_deg"), jnum(t, "camera", "height_m"), jnum(t, "camera", "pitch_deg"), jnum(t, "camera", "roll_deg"))


def rotation(cam: Camera) -> F64:
    p, r = math.radians(cam["pitch_deg"]), math.radians(cam["roll_deg"])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return rx @ rz


def project(cam: Camera, w: int, h: int, pts: F64) -> F64:
    """Contract §4.1: world points (n, 3) -> photo pixels (n, 2)."""
    c = (np.asarray(pts, np.float64) - np.array([0.0, cam["height_m"], 0.0])) @ rotation(cam)
    d = -c[:, 2]
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    return np.stack([w / 2 + f * c[:, 0] / d, h / 2 - f * c[:, 1] / d], 1)


def rays(cam: Camera, w: int, h: int) -> tuple[F64, F64, F64, float]:
    """Pixel centres (u, v) of a w x h image, each pixel's world ray direction (h, w, 3) and the focal length."""
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    mu, mv = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    u, v = np.asarray(mu, np.float64), np.asarray(mv, np.float64)
    ray_c = np.stack([(u - w / 2) / f, -(v - h / 2) / f, -np.ones_like(u)], -1)  # three.js camera frame, depth 1
    return u, v, ray_c @ rotation(cam).T, f


def points_from_depth(u: F64, v: F64, d: F64, w: int, h: int, f: float) -> F64:
    """An OpenCV-frame point map (x right, y down, z = view-axis depth) from view-axis depths."""
    return np.stack([(u - w / 2) / f * d, (v - h / 2) / f * d, d], -1)


def point_map(cam: Camera, depth_m: F64) -> tuple[F64, Bools]:
    """OpenCV-frame point map from a view-axis depth map, with the floor (depth 0) filled from the contract camera."""
    h, w = int(depth_m.shape[0]), int(depth_m.shape[1])
    u, v, ray_w, f = rays(cam, w, h)
    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(ray_w[..., 1] < -1e-6, cam["height_m"] / -ray_w[..., 1], np.inf)
    d = np.where(depth_m > 0, depth_m, t_floor)
    valid = np.isfinite(d)
    d = np.where(valid, d, 1.0)
    return points_from_depth(u, v, d, w, h, f), valid


@dataclass(frozen=True)
class Room:
    """A rendered synthetic room: the photo at depth size, MoGe-like outputs (OpenCV frame) and the truth."""

    rgb: U8
    points: F64
    normals: F64
    valid: Bools
    camera: Camera
    R: F64
    floor: Bools

    def moge(self) -> MogeOutput:
        """The room as MoGe-2's output (float32, as MoGe gives it)."""
        h, w = int(self.rgb.shape[0]), int(self.rgb.shape[1])
        f = (h / 2) / math.tan(math.radians(self.camera["fov_y_deg"]) / 2)
        K = np.array([[f / w, 0, 0.5], [0, f / h, 0.5], [0, 0, 1]], np.float32)
        return MogeOutput(points=self.points.astype(np.float32), normal=self.normals.astype(np.float32), mask=self.valid,
                          intrinsics=K, load_s=0.0, infer_s=0.0, repo="synthetic")


def render_room(light_dir: tuple[float, float, float], key_rgb: tuple[float, float, float] = (1.0, 0.9, 0.75),
                amb: tuple[float, float, float] = (0.9, 0.85, 0.8), w: int = 360, h: int = 270, cam: Camera | None = None) -> Room:
    """A box room ray-cast in numpy: floor, three walls, ceiling and four boxes, lit by E = a + b n_y + I max(0, n.l)
    (no shadows), rendered like three.js (albedo / pi * E, ACES Filmic, sRGB)."""
    cam = cam or camera(60.0, 1.4, -15.0, 0.0)
    R = lt.cam_rotation(cam["pitch_deg"], cam["roll_deg"])
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    dc = np.stack([(u - w / 2) / f, -(v - h / 2) / f, -np.ones_like(u)], -1)
    d = dc @ R.T
    o = np.array([0.0, cam["height_m"], 0.0])
    best = np.full((h, w), np.inf)
    nrm = np.zeros((h, w, 3))
    alb = np.zeros((h, w, 3))
    planes: list[tuple[tuple[float, float, float], float, tuple[float, float, float]]] = [
        ((0, 1, 0), 0.0, (0.35, 0.25, 0.16)), ((0, -1, 0), 2.7, (0.8, 0.8, 0.78)), ((0, 0, 1), 5.0, (0.72, 0.7, 0.66)),
        ((1, 0, 0), 2.6, (0.7, 0.7, 0.68)), ((-1, 0, 0), 2.6, (0.7, 0.7, 0.68))]
    for n_t, off, a in planes:  # n . p + off = 0, n facing the room
        n = np.array(n_t, np.float64)
        with np.errstate(divide="ignore", invalid="ignore"):
            t = -(n @ o + off) / (d @ n)
        hit = (t > 0) & (t < best)
        best[hit] = t[hit]
        nrm[hit] = n
        alb[hit] = a
    # boxes (centre, size, yaw in degrees, albedo): turned ones, so the faces show many directions as a real room does
    boxes: list[tuple[tuple[float, float, float], tuple[float, float, float], float, tuple[float, float, float]]] = [
        ((-0.7, 0.4, -3.2), (1.4, 0.8, 0.8), 25, (0.35, 0.5, 0.45)), ((0.9, 0.25, -2.3), (0.6, 0.5, 0.6), -35, (0.6, 0.38, 0.28)),
        ((1.6, 0.6, -4.2), (0.5, 1.2, 0.5), 50, (0.55, 0.55, 0.6)), ((-1.6, 0.3, -2.0), (0.5, 0.6, 0.5), 10, (0.5, 0.45, 0.4))]
    for c, s, yaw, a in boxes:
        cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
        Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])          # local -> world
        ol, dl = (o - np.array(c)) @ Ry, d @ Ry                          # the ray in the box's frame
        half = np.array(s) / 2
        with np.errstate(divide="ignore", invalid="ignore"):
            t1, t2 = (-half - ol) / dl, (half - ol) / dl
        tn, tf = np.minimum(t1, t2).max(-1), np.maximum(t1, t2).min(-1)
        hit = (tn < tf) & (tn > 0) & (tn < best)
        best[hit] = tn[hit]
        axis = np.argmax(np.minimum(t1, t2), -1)
        nb = np.zeros((h, w, 3))
        np.put_along_axis(nb, axis[..., None], 1.0, -1)
        nb *= -np.sign(np.take_along_axis(dl, axis[..., None], -1))
        nrm[hit] = (nb @ Ry.T)[hit]
        alb[hit] = a
    p = o + best[..., None] * d
    ld = np.asarray(light_dir, np.float64) / np.linalg.norm(light_dir)
    E = np.array(amb)[None, None] * (1 + 0.35 * nrm[..., 1:2]) + 2.4 * np.array(key_rgb)[None, None] * np.maximum(nrm @ ld, 0)[..., None]
    disp = lt.aces(alb / math.pi * E)
    srgb = np.where(disp <= 0.0031308, 12.92 * disp, 1.055 * np.power(disp, 1 / 2.4) - 0.055)
    rgb = np.clip(np.rint(srgb * 255), 0, 255).astype(np.uint8)
    pc = (p - o) @ R            # world -> three.js camera frame, then OpenCV
    nc = nrm @ R
    floor = (np.abs(p[..., 1]) < 0.01) & (nrm[..., 1] > 0.99)
    return Room(rgb=rgb, points=pc * CV, normals=nc * CV, valid=np.isfinite(best), camera=cam, R=R, floor=floor)
