"""Self-check for the golden scenes (PLAN.md §6.1): pins the camera convention of contract §4.1, signs included.

For every fixtures/scenes/<id>/ it projects truth.json's boxes with the camera block using its own implementation of
§4.1 (numpy, not three.js) and checks that they land where three.js drew them:

- the sofa: the convex hull of its 8 projected corners matches the sofa's id mask (ids.png, R) by IoU, its bounding
  box, and every corner lies on the mask; the table: the union of its parts' hulls matches its mask (G);
- the convention is pinned: the true camera beats the same camera with roll negated or pitch off by 0.5 degree;
- depth.png holds depth along the view axis in mm: on the sofa's front face and on the back wall it equals the
  ray-plane depth at each pixel center (not the Euclidean distance), and open floor is 0;
- calib.json is valid (contract/calib.schema.json) with source "truth" and the truth camera, photo.jpg has no
  metadata segments, and fixtures/calib/<sha256 of photo.jpg>/ holds identical calib.json and depth.png.

Writes evals/out/check-scenes/<id>.png: the photo with the projected corners and edges drawn on it.
Usage: evals/py fixtures/check_scenes.py      (exit 0 when every check passes)
"""
import hashlib
import json
import math
import sys
from pathlib import Path

import jsonschema
import numpy as np
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parent.parent
OUT = REPO / "evals/out/check-scenes"
CALIB_SCHEMA = json.loads((REPO / "contract/calib.schema.json").read_text())
results: list[tuple[str, bool]] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append((name, bool(ok)))
    print(f"{'ok  ' if ok else 'FAIL'} {name}{f' ({detail})' if detail else ''}")
    return bool(ok)


# --- contract §4.1 ----------------------------------------------------------------------------------------------
def rotation(cam: dict) -> np.ndarray:
    """Camera-to-world rotation: three.js Euler (pitch, 0, roll) in order 'YXZ', i.e. R = Ry(0) @ Rx(pitch) @ Rz(roll)."""
    p, r = math.radians(cam["pitch_deg"]), math.radians(cam["roll_deg"])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return rx @ rz


def focal(cam: dict, h: int) -> float:
    return (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)


def project(cam: dict, w: int, h: int, pts) -> tuple[np.ndarray, np.ndarray]:
    """World points (N, 3) -> pixel coordinates (N, 2) (origin at the top-left corner of the top-left pixel, y down)
    and depth along the view axis (N,)."""
    pts = np.asarray(pts, float)
    c = (pts - np.array([0.0, cam["height_m"], 0.0])) @ rotation(cam)  # rows of R^T (p - C)
    d = -c[:, 2]
    f = focal(cam, h)
    return np.stack([w / 2 + f * c[:, 0] / d, h / 2 - f * c[:, 1] / d], axis=1), d


def pixel_rays(cam: dict, w: int, h: int) -> np.ndarray:
    """World direction (h, w, 3) of the ray through each pixel center, scaled so its view-axis depth is 1."""
    f = focal(cam, h)
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    cam_dirs = np.stack([(u - w / 2) / f, -(v - h / 2) / f, -np.ones_like(u)], axis=-1)
    return cam_dirs @ rotation(cam).T


def plane_depth(cam: dict, w: int, h: int, point, normal) -> tuple[np.ndarray, np.ndarray]:
    """Depth along the view axis where each pixel's ray meets a plane, and the world hit points."""
    rays = pixel_rays(cam, w, h)
    origin = np.array([0.0, cam["height_m"], 0.0])
    n = np.asarray(normal, float)
    t = ((np.asarray(point, float) - origin) @ n) / (rays @ n)
    return t, origin + rays * t[..., None]


# --- rasterizing convex hulls -------------------------------------------------------------------------------------
def hull(points: np.ndarray) -> np.ndarray:
    pts = sorted(map(tuple, points))
    cross = lambda o, a, b: (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return np.array(lower[:-1] + upper[:-1])  # counterclockwise in (x, y-down) coordinates


def inside(poly: np.ndarray, w: int, h: int, margin: float = 0.0) -> np.ndarray:
    """Pixels whose centers lie inside the convex polygon, at least `margin` px from every edge."""
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    m = np.ones((h, w), bool)
    for a, b in zip(poly, np.roll(poly, -1, axis=0)):
        e = b - a
        m &= (e[0] * (v - a[1]) - e[1] * (u - a[0])) / np.hypot(*e) >= margin
    return m


def silhouette(cam: dict, w: int, h: int, parts: list[dict]) -> np.ndarray:
    m = np.zeros((h, w), bool)
    for p in parts:
        px, d = project(cam, w, h, p["corners"])
        assert (d > 0).all(), "a part is behind the camera"
        m |= inside(hull(px), w, h)
    return m


def bbox(m: np.ndarray):
    ys, xs = np.nonzero(m)
    return (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())) if len(xs) else None


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return (a & b).sum() / max(1, (a | b).sum())


def dilate(m: np.ndarray, r: int) -> np.ndarray:
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            out |= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def jpeg_segments(data: bytes) -> list[int]:
    i, markers = 2, []
    while i < len(data) and data[i] == 0xFF and data[i + 1] != 0xDA:
        markers.append(data[i + 1])
        i += 2 + int.from_bytes(data[i + 2:i + 4], "big")
    return markers


# --- per scene ------------------------------------------------------------------------------------------------------
def check_scene(d: Path) -> None:
    sid = d.name
    truth = json.loads((d / "truth.json").read_text())
    cam, W, H = truth["camera"], truth["image"]["w"], truth["image"]["h"]
    photo_bytes = (d / "photo.jpg").read_bytes()
    photo = Image.open(d / "photo.jpg")
    check(f"{sid}: photo.jpg is {W} x {H}", photo.size == (W, H), f"{photo.size}")
    markers = jpeg_segments(photo_bytes)
    check(f"{sid}: photo.jpg has no metadata (no APP1-APP15 or COM segment)",
          not any(0xE1 <= m <= 0xEF or m == 0xFE for m in markers), " ".join(f"{m:02X}" for m in markers))

    ids = np.asarray(Image.open(d / "ids.png").convert("RGB"))
    masks = {"sofa": ids[..., 0] >= 128, "table": ids[..., 1] >= 128}

    # Projection against the id masks
    for name, mask in masks.items():
        o = truth["objects"][name]
        corners = np.array(o["corners"])
        px, depth = project(cam, W, H, corners)
        check(f"{sid}: truth.json corner_px for the {name} match the §4.1 projection",
              np.abs(px - np.array(o["corner_px"])).max() < 0.01)
        pred = silhouette(cam, W, H, o["parts"])
        score = iou(pred, mask)
        check(f"{sid}: the {name}'s projected silhouette matches the render (IoU >= 0.985)", score >= 0.985, f"IoU {score:.4f}")
        bp, bm = bbox(pred), bbox(mask)
        err = max(abs(a - b) for a, b in zip(bp, bm)) if bp and bm else 99
        check(f"{sid}: the {name}'s bounding box matches the render within 1 px", err <= 1, f"projected {bp}, rendered {bm}")
        if name == "sofa":
            ys, xs = np.nonzero(mask)
            cen = np.stack([xs + 0.5, ys + 0.5], axis=1)
            dist = [np.hypot(*(cen - p).T).min() for p in px]
            check(f"{sid}: every sofa corner lands on the sofa in the render (<= 1.5 px)", max(dist) <= 1.5,
                  "max " + f"{max(dist):.2f} px")
            # The convention, signs included: nearby wrong cameras fit worse.
            wrong = []
            if abs(cam["roll_deg"]) > 0.1:
                wrong.append(("roll negated", {**cam, "roll_deg": -cam["roll_deg"]}))
            wrong += [("pitch +0.5", {**cam, "pitch_deg": cam["pitch_deg"] + 0.5}), ("pitch negated", {**cam, "pitch_deg": -cam["pitch_deg"]})]
            for label, alt in wrong:
                try:
                    s_alt = iou(silhouette(alt, W, H, o["parts"]), mask)
                except AssertionError:
                    s_alt = 0.0
                check(f"{sid}: the true camera beats the camera with {label}", s_alt < score - 0.01, f"IoU {score:.4f} vs {s_alt:.4f}")

    # Depth
    calib = json.loads((d / "calib.json").read_text())
    try:
        jsonschema.validate(calib, CALIB_SCHEMA)
        valid = True
    except jsonschema.ValidationError as e:
        valid = False
        print("   ", e.message)
    check(f"{sid}: calib.json is valid, source truth, truth camera", valid and calib["source"] == "truth" and calib["camera"] == cam)
    dimg = Image.open(d / "depth.png")
    dep = np.asarray(dimg).astype(np.int64)
    DW, DH = calib["depth"]["w"], calib["depth"]["h"]
    check(f"{sid}: depth.png is 16-bit, {DW} x {DH}, long side <= 1024, photo's aspect",
          dimg.mode in ("I;16", "I;16B", "I") and dep.shape == (DH, DW) and max(DW, DH) <= 1024 and abs(DW / DH - W / H) < 0.01,
          f"mode {dimg.mode}, {dep.shape}")
    sofa = truth["objects"]["sofa"]
    a = math.radians(sofa["rotation_y_deg"])
    normal = [math.sin(a), 0.0, math.cos(a)]  # the sofa's local +Z
    c = np.array(sofa["center"])
    front_pt = c + np.array(normal) * sofa["size_m"]["d"] / 2
    front = np.array(sofa["corners"])[[2, 3, 7, 6]]  # bottom-front-right, bottom-front-left, top-front-left, top-front-right
    fpx, _ = project(cam, DW, DH, front)
    t_depth, hits = plane_depth(cam, DW, DH, front_pt, normal)
    table_px = dilate(silhouette(cam, DW, DH, truth["objects"]["table"]["parts"]), 2)
    sel = inside(hull(fpx), DW, DH, margin=2.0) & ~table_px & (hits[..., 1] > 0.06)
    err = np.abs(dep[sel] - t_depth[sel] * 1000)
    check(f"{sid}: depth on the sofa's front face is the view-axis depth in mm (median <= 2, p99 <= 6)",
          sel.sum() > 500 and np.median(err) <= 2 and np.percentile(err, 99) <= 6,
          f"{sel.sum()} px, median {np.median(err):.2f} mm, p99 {np.percentile(err, 99):.2f} mm")
    ray_len = np.linalg.norm(pixel_rays(cam, DW, DH), axis=-1)
    euclid = np.abs(dep[sel] - t_depth[sel] * ray_len[sel] * 1000)
    check(f"{sid}: depth.png is not the Euclidean distance", np.median(euclid) > np.median(err) + 5,
          f"median error as Euclidean {np.median(euclid):.1f} mm")
    wall_px, _ = project(cam, DW, DH, [[2.2, 0.6, -5.0]])
    u, v = int(wall_px[0, 0]), int(wall_px[0, 1])
    w_depth, _ = plane_depth(cam, DW, DH, [0, 0, -5.0], [0, 0, 1])
    check(f"{sid}: depth on the back wall is the view-axis depth", abs(dep[v, u] - w_depth[v, u] * 1000) <= 3,
          f"{dep[v, u]} mm vs {w_depth[v, u] * 1000:.1f}")
    zeros = []
    for fp in truth["floor_points"]:
        p, _ = project(cam, DW, DH, [fp["world"]])
        zeros.append(int(dep[int(p[0, 1]), int(p[0, 0])]))
    check(f"{sid}: open floor is 0 in depth.png", all(z == 0 for z in zeros), f"{zeros}")
    ratio = (dep == 0).mean()
    check(f"{sid}: calib floor.inlier_ratio is the masked share of depth.png", abs(ratio - calib["floor"]["inlier_ratio"]) < 0.002,
          f"{ratio:.4f} vs {calib['floor']['inlier_ratio']}")

    # The calib mock's copy
    mock = REPO / "fixtures/calib" / hashlib.sha256(photo_bytes).hexdigest()
    check(f"{sid}: fixtures/calib/<sha256 of photo.jpg>/ holds the same calib.json and depth.png",
          (mock / "calib.json").is_file() and (mock / "calib.json").read_bytes() == (d / "calib.json").read_bytes()
          and (mock / "depth.png").read_bytes() == (d / "depth.png").read_bytes(), str(mock.relative_to(REPO)))

    # Marker image: projected edges and corners on the photo
    img = photo.convert("RGB")
    g = ImageDraw.Draw(img)
    edges = [(0, 1), (1, 2), (2, 3), (3, 0), (4, 5), (5, 6), (6, 7), (7, 4), (0, 4), (1, 5), (2, 6), (3, 7)]
    for name, col in (("sofa", (255, 230, 0)), ("table", (0, 255, 255))):
        px, _ = project(cam, W, H, truth["objects"][name]["corners"])
        for i, j in edges:
            g.line([tuple(px[i]), tuple(px[j])], fill=col, width=2)
        for k, (x, y) in enumerate(px):
            g.line([(x - 9, y), (x + 9, y)], fill=(255, 0, 0), width=3)
            g.line([(x, y - 9), (x, y + 9)], fill=(255, 0, 0), width=3)
            g.text((x + 6, y + 4), str(k), fill=(255, 255, 255))
    for fp in truth["floor_points"]:
        p, _ = project(cam, W, H, [fp["world"]])
        x, y = p[0]
        g.ellipse([x - 7, y - 7, x + 7, y + 7], outline=(0, 120, 255), width=3)
    OUT.mkdir(parents=True, exist_ok=True)
    img.save(OUT / f"{sid}.png")


def main() -> int:
    scenes = sorted(p for p in (REPO / "fixtures/scenes").iterdir() if (p / "truth.json").is_file())
    check("three golden scenes exist", {p.name for p in scenes} == {"living-wide", "steep-roll", "portrait"}, ", ".join(p.name for p in scenes))
    for d in scenes:
        check_scene(d)
    failed = sum(1 for _, ok in results if not ok)
    print(f"\n{len(results) - failed}/{len(results)} checks passed; marker images in {OUT.relative_to(REPO)}/")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
