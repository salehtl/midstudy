"""Virtual room members for the spike's own convention check (not a measurement): re-renders a golden scene (photo,
depth.png and the floor plane from its truth camera) from other camera poses by forward splatting, so the spike can be
checked against known ROOMS.md §3.1 poses before A1's golden room fixtures exist. Disocclusions stay as holes (grey in
the photo, 0 in depth.png), so the ML solvers see worse images than real renders; the numbers are a sanity check only.

    uv run --project calib/spike python calib/spike/make_virtual.py fixtures/scenes/living-wide --out evals/out/rooms-spike/virtual

Writes <out>/v0 (the source, pose {0, 0, 0}) and <out>/v1… (each with photo.jpg, calib.json, depth.png and truth.json
holding pose_in_room). Only golden (synthetic) scenes go in; output goes under evals/out/ (git-ignored).
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
from pathlib import Path

import numpy as np
from PIL import Image
from run import F64, load_scene, ry

# (x_m, z_m, yaw_deg, height_m, pitch_deg, roll_deg): small moves, as neighbouring photos of a room would be.
POSES = [
    (0.35, -0.10, 12.0, 1.50, -12.0, 1.0),
    (-0.40, -0.25, -15.0, 1.30, -8.0, -1.5),
    (0.10, -0.60, 25.0, 1.45, -15.0, 0.5),
    (-0.20, 0.20, -30.0, 1.60, -18.0, 0.0),
]


def cam_rot(pitch: float, roll: float) -> F64:
    cp, sp, cr, sr = math.cos(pitch), math.sin(pitch), math.cos(roll), math.sin(roll)
    rxm = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    rzm = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return rxm @ rzm


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("scene", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    a = ap.parse_args()
    s = load_scene(a.scene)
    photo = np.asarray(Image.open(a.scene / "photo.jpg").convert("RGB"), dtype=np.uint8)
    hh, ww = photo.shape[:2]
    # every photo pixel's world point: depth.png (nearest) or the floor (y = 0) below the horizon
    f = (hh / 2) / math.tan(s.fov_y / 2)
    jj, ii = np.mgrid[0:hh, 0:ww]
    dirc = np.stack([(ii + 0.5 - ww / 2) / f, -(jj + 0.5 - hh / 2) / f, -np.ones_like(ii, dtype=np.float64)], axis=-1)
    dirw = dirc @ s.r_gl.T
    dh, dw = s.depth.shape
    d = s.depth[np.minimum((jj * dh) // hh, dh - 1), np.minimum((ii * dw) // ww, dw - 1)]
    cam = np.array([0.0, s.height, 0.0])
    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(dirw[..., 1] < 0, -s.height / dirw[..., 1], np.nan)
    pts = np.where((d > 0)[..., None], cam + dirw * d[..., None], cam + dirw * t_floor[..., None])
    ok = np.isfinite(pts).all(-1)
    p, col = pts[ok], photo[ok]
    a.out.mkdir(parents=True, exist_ok=True)
    v0 = a.out / "v0"
    v0.mkdir(exist_ok=True)
    for name in ("photo.jpg", "calib.json", "depth.png"):
        shutil.copy(a.scene / name, v0 / name)
    (v0 / "truth.json").write_text(json.dumps({"source": str(a.scene), "pose_in_room": {"x_m": 0, "z_m": 0, "yaw_deg": 0}}) + "\n")
    calib0 = json.loads((a.scene / "calib.json").read_text())
    for n, (x, z, yaw, h, pitch, roll) in enumerate(POSES, start=1):
        q = (p - np.array([x, 0.0, z])) @ ry(math.radians(yaw))  # room → this member's scene frame (§3.1)
        pc = (q - np.array([0.0, h, 0.0])) @ cam_rot(math.radians(pitch), math.radians(roll))
        dd = -pc[:, 2]
        px = ww / 2 + f * pc[:, 0] / dd
        py = hh / 2 - f * pc[:, 1] / dd
        vis = (dd > 0.05) & (px >= 0) & (px < ww) & (py >= 0) & (py < hh)
        order = np.argsort(-dd[vis])  # far first, near overwrite
        xi, yi = px[vis][order].astype(np.int64), py[vis][order].astype(np.int64)
        img = np.full((hh, ww, 3), 128, dtype=np.uint8)
        zb = np.zeros((hh, ww))
        floor = np.zeros((hh, ww), dtype=bool)
        for oy, ox in ((0, 0), (0, 1), (1, 0), (1, 1)):  # 2×2 splats: no cracks where the view comes closer
            ys, xs = np.minimum(yi + oy, hh - 1), np.minimum(xi + ox, ww - 1)
            img[ys, xs] = col[vis][order]
            zb[ys, xs] = dd[vis][order]
            floor[ys, xs] = q[vis][order][:, 1] < 0.04
        out = a.out / f"v{n}"
        out.mkdir(exist_ok=True)
        Image.fromarray(img).save(out / "photo.jpg", quality=92)
        small = zb.reshape(dh, hh // dh, dw, ww // dw).max(axis=(1, 3)) if hh % dh == 0 and ww % dw == 0 else \
            np.asarray(Image.fromarray(np.where(floor, 0, zb).astype(np.float32)).resize((dw, dh), Image.Resampling.NEAREST))
        fl = np.asarray(Image.fromarray(floor).resize((dw, dh), Image.Resampling.NEAREST))
        small = np.where(fl, 0, small)
        Image.fromarray(np.clip(small * 1000, 0, 65535).astype(np.uint16)).save(out / "depth.png")
        calib = dict(calib0)
        calib["camera"] = {"fov_y_deg": calib0["camera"]["fov_y_deg"], "height_m": h, "pitch_deg": pitch, "roll_deg": roll}
        (out / "calib.json").write_text(json.dumps(calib, indent=1) + "\n")
        (out / "truth.json").write_text(json.dumps({"source": str(a.scene), "pose_in_room": {"x_m": x, "z_m": z, "yaw_deg": yaw}}) + "\n")
        print(f"v{n}: pose ({x}, {z}, {yaw}°), camera h {h} pitch {pitch} roll {roll}, {vis.mean():.0%} of points in view")


if __name__ == "__main__":
    main()
