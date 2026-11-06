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

The golden room (contract §4.9, §5.1): room-1 … room-6 are more photos of the same room. Their truth.json is in their
own frame, with `pose_in_room` in living-wide's (the room frame). For each, the same checks (only the corners in the
photo; the sofa face it sees best; its `wall_check` wall), and the pose itself: living-wide's sofa and table carried
through the pose (p_scene = Ry(−yaw) · (p_room − t)) give the scene's own corners, and the sofa's corners land on its id
mask; the true pose beats the pose with yaw negated, yaw off by 1 degree, or x and z swapped. room-6 faces a bare wall:
no sofa or table in view. fixtures/calib/rooms/<key>/align.json (the calib mock's align-room answers) validate
(contract/align.schema.json), sit under the key of contract §4.9 Mock, and hold the true poses.

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
ALIGN_SCHEMA = json.loads((REPO / "contract/align.schema.json").read_text())
ROOM_SCHEMA = json.loads((REPO / "contract/room.schema.json").read_text())
ORIGINAL = {"living-wide", "steep-roll", "portrait", "living-cool", "living-warm"}
ROOM_PHOTOS = {f"room-{i}" for i in range(1, 7)}
ROOM_SETS = {"golden-room": ["living-wide", *sorted(ROOM_PHOTOS)], "golden-pair": ["living-wide", "room-1"]}
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


# --- contract §4.9: room frame -> a scene's frame ------------------------------------------------------------------
def ry(deg: float) -> np.ndarray:
    """Ry(a) = [[cos a, 0, sin a], [0, 1, 0], [-sin a, 0, cos a]] (positive: counterclockwise seen from above)."""
    a = math.radians(deg)
    return np.array([[math.cos(a), 0, math.sin(a)], [0, 1, 0], [-math.sin(a), 0, math.cos(a)]])


def room_to_scene(pose: dict, pts) -> np.ndarray:
    """p_scene = Ry(-yaw) · (p_room - (x_m, 0, z_m)), for rows of points."""
    p = np.asarray(pts, float) - np.array([pose["x_m"], 0.0, pose["z_m"]])
    return p @ ry(-pose["yaw_deg"]).T


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
    in_room = "pose_in_room" in truth
    for name, mask in masks.items():
        o = truth["objects"][name]
        corners = np.array(o["corners"])
        px, depth = project(cam, W, H, corners)
        check(f"{sid}: truth.json corner_px for the {name} match the §4.1 projection",
              np.abs(px - np.array(o["corner_px"])).max() < 0.01)
        if in_room and not ((depth > 0) & (px[:, 0] >= 0) & (px[:, 0] <= W) & (px[:, 1] >= 0) & (px[:, 1] <= H)).any():
            # a room photo that doesn't show it (room-6, the bare wall): nothing of it is drawn either
            check(f"{sid}: the {name} is out of view and its id mask is empty", mask.sum() == 0 and truth["room"]["hard_case"] == "blank-wall",
                  f"{int(mask.sum())} px")
            continue
        pred = silhouette(cam, W, H, o["parts"])
        score = iou(pred, mask)
        check(f"{sid}: the {name}'s projected silhouette matches the render (IoU >= 0.985)", score >= 0.985, f"IoU {score:.4f}")
        bp, bm = bbox(pred), bbox(mask)
        err = max(abs(a - b) for a, b in zip(bp, bm)) if bp and bm else 99
        check(f"{sid}: the {name}'s bounding box matches the render within 1 px", err <= 1, f"projected {bp}, rendered {bm}")
        if name == "sofa":
            ys, xs = np.nonzero(mask)
            cen = np.stack([xs + 0.5, ys + 0.5], axis=1)
            shown = (px[:, 0] >= 1) & (px[:, 0] <= W - 1) & (px[:, 1] >= 1) & (px[:, 1] <= H - 1)  # all of them in the five
            dist = [np.hypot(*(cen - p).T).min() for p in px[shown]]
            check(f"{sid}: every sofa corner {'in the photo ' if in_room else ''}lands on the sofa in the render (<= 1.5 px)",
                  len(dist) >= 4 and max(dist) <= 1.5, f"{len(dist)} corners, max {max(dist):.2f} px" if dist else "none in the photo")
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
    c = np.array(sofa["center"])
    # The sofa's faces (corner indices, local outward axis). The five check the front; a room photo the face it sees best.
    faces = {"front": ([2, 3, 7, 6], (0, 1)), "back": ([0, 1, 5, 4], (0, -1)), "left": ([0, 3, 7, 4], (-1, 0)), "right": ([1, 2, 6, 5], (1, 0))}
    sofa_d = project(cam, W, H, sofa["corners"])[1]
    best = None
    for face, (idx, (lx, lz)) in faces.items():
        if (not in_room and face != "front") or (in_room and not (sofa_d > 0).all()):
            continue
        normal = [math.cos(a) * lx + math.sin(a) * lz, 0.0, -math.sin(a) * lx + math.cos(a) * lz]  # local axis turned by yaw
        half = sofa["size_m"]["d"] / 2 if lz else sofa["size_m"]["w"] / 2
        face_pt = c + np.array(normal) * half
        if in_room and (np.array([0.0, cam["height_m"], 0.0]) - face_pt) @ np.array(normal) <= 0:
            continue  # faces away from the camera
        fpx, _ = project(cam, DW, DH, np.array(sofa["corners"])[idx])
        t_depth, hits = plane_depth(cam, DW, DH, face_pt, normal)
        table_px = dilate(silhouette(cam, DW, DH, truth["objects"]["table"]["parts"]), 2) if (project(cam, W, H, truth["objects"]["table"]["corners"])[1] > 0).all() else np.zeros((DH, DW), bool)
        sel = inside(hull(fpx), DW, DH, margin=2.0) & ~table_px & (hits[..., 1] > 0.06)
        if best is None or sel.sum() > best[1].sum():
            best = (face, sel, t_depth)
    if best is None:
        check(f"{sid}: no sofa face in view (the bare-wall photo)", in_room and truth["room"]["hard_case"] == "blank-wall")
    else:
        face, sel, t_depth = best
        err = np.abs(dep[sel] - t_depth[sel] * 1000)
        check(f"{sid}: depth on the sofa's {face} face is the view-axis depth in mm (median <= 2, p99 <= 6)",
              sel.sum() > 500 and np.median(err) <= 2 and np.percentile(err, 99) <= 6,
              f"{sel.sum()} px, median {np.median(err):.2f} mm, p99 {np.percentile(err, 99):.2f} mm")
        ray_len = np.linalg.norm(pixel_rays(cam, DW, DH), axis=-1)
        euclid = np.abs(dep[sel] - t_depth[sel] * ray_len[sel] * 1000)
        check(f"{sid}: depth.png is not the Euclidean distance", np.median(euclid) > np.median(err) + 5,
              f"median error as Euclidean {np.median(euclid):.1f} mm")
    wc = truth.get("wall_check") or {"wall": "back", "point": [2.2, 0.6, -5.0], "normal": [0, 0, 1]}
    wall_px, _ = project(cam, DW, DH, [wc["point"]])
    u, v = int(wall_px[0, 0]), int(wall_px[0, 1])
    w_depth, _ = plane_depth(cam, DW, DH, wc["point"], wc["normal"])
    check(f"{sid}: depth on the {wc['wall']} wall is the view-axis depth", abs(dep[v, u] - w_depth[v, u] * 1000) <= 3,
          f"{dep[v, u]} mm vs {w_depth[v, u] * 1000:.1f}")
    zeros = []
    for fp in truth["floor_points"]:
        p, _ = project(cam, DW, DH, [fp["world"]])
        zeros.append(int(dep[int(p[0, 1]), int(p[0, 0])]))
    check(f"{sid}: open floor is 0 in depth.png", len(zeros) >= 3 and all(z == 0 for z in zeros), f"{zeros}")
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
        px, d = project(cam, W, H, truth["objects"][name]["corners"])
        if not (d > 0).all():
            continue
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


# --- the golden room (contract §4.9) -----------------------------------------------------------------------------------
def check_room_pose(d: Path, frame: dict) -> None:
    """The truth pose carries living-wide's objects (the room frame) into this scene's own frame and onto its masks."""
    sid = d.name
    truth = json.loads((d / "truth.json").read_text())
    cam, W, H, pose = truth["camera"], truth["image"]["w"], truth["image"]["h"], truth["pose_in_room"]
    check(f"{sid}: pose_in_room is {{x_m, z_m, yaw_deg}} in range (room.schema.json Pose)",
          set(pose) == {"x_m", "z_m", "yaw_deg"} and -180 < pose["yaw_deg"] <= 180 and abs(pose["x_m"]) <= 50 and abs(pose["z_m"]) <= 50, f"{pose}")
    mask = np.asarray(Image.open(d / "ids.png").convert("RGB"))[..., 0] >= 128
    for name in ("sofa", "table"):
        mine, room = truth["objects"][name], frame["objects"][name]
        moved = room_to_scene(pose, room["corners"])
        dy = (room["rotation_y_deg"] - pose["yaw_deg"] - mine["rotation_y_deg"] + 180) % 360 - 180
        check(f"{sid}: the room's {name} through the pose is this scene's {name} (corners within 1e-5 m, rotation_y_deg = room - yaw)",
              np.abs(moved - np.array(mine["corners"])).max() < 1e-5 and abs(dy) < 1e-6, f"{np.abs(moved - np.array(mine['corners'])).max():.2e} m, {dy:.2e} deg")
    room_sofa = np.array(frame["objects"]["sofa"]["corners"])
    px, dep = project(cam, W, H, room_to_scene(pose, room_sofa))
    shown = (dep > 0) & (px[:, 0] >= 1) & (px[:, 0] <= W - 1) & (px[:, 1] >= 1) & (px[:, 1] <= H - 1)
    if truth["room"]["hard_case"] == "blank-wall":
        check(f"{sid}: the bare-wall photo shows no sofa corner and no sofa", not shown.any() and mask.sum() == 0, f"{int(shown.sum())} corners, {int(mask.sum())} px")
        return
    ys, xs = np.nonzero(mask)
    cen = np.stack([xs + 0.5, ys + 0.5], axis=1)
    dist = [np.hypot(*(cen - p).T).min() for p in px[shown]]
    check(f"{sid}: the truth pose projects the room's sofa corners onto its id mask (>= 4 in the photo, <= 1.5 px)",
          len(dist) >= 4 and max(dist) <= 1.5, f"{len(dist)} corners, max {max(dist):.2f} px" if dist else "none")
    # the pose's signs and units are pinned: nearby wrong poses fit the mask worse
    parts = frame["objects"]["sofa"]["parts"]

    def score(p: dict) -> float:
        moved = [{"corners": room_to_scene(p, q["corners"])} for q in parts]
        try:
            return iou(silhouette(cam, W, H, moved), mask)
        except AssertionError:
            return 0.0
    true_s = score(pose)
    wrong = [("yaw negated", {**pose, "yaw_deg": -pose["yaw_deg"]}), ("yaw + 1 degree", {**pose, "yaw_deg": pose["yaw_deg"] + 1}),
             ("x and z swapped", {**pose, "x_m": pose["z_m"], "z_m": pose["x_m"]}), ("x + 3 cm", {**pose, "x_m": pose["x_m"] + 0.03})]
    for label, alt in wrong:
        s_alt = score(alt)
        check(f"{sid}: the true pose beats the pose with {label}", s_alt < true_s - 0.005, f"IoU {true_s:.4f} vs {s_alt:.4f}")


def mock_key(shas: list[str]) -> str:
    """Contract §4.9 Mock: sha256 of the photos' sha256s (lowercase hex), sorted, joined with "\n", no trailing newline."""
    return hashlib.sha256("\n".join(sorted(shas)).encode()).hexdigest()


def check_room_answers() -> None:
    from referencing import Registry, Resource
    import jsonschema.validators
    reg = Registry().with_resources([(s["$id"], Resource.from_contents(s)) for s in (ALIGN_SCHEMA, ROOM_SCHEMA)])
    validator = jsonschema.validators.Draft202012Validator(ALIGN_SCHEMA, registry=reg, format_checker=jsonschema.FormatChecker())
    root = REPO / "fixtures/calib/rooms"
    found = sorted(p.name for p in root.iterdir() if p.is_dir()) if root.is_dir() else []
    want = {}
    for name, ids in ROOM_SETS.items():
        shas = [hashlib.sha256((REPO / "fixtures/scenes" / i / "photo.jpg").read_bytes()).hexdigest() for i in ids]
        want[mock_key(shas)] = (name, ids, shas)
    check("fixtures/calib/rooms/ holds exactly the golden-room and golden-pair answers, under the §4.9 mock key",
          set(found) == set(want), f"found {[f[:12] for f in found]}, want {[k[:12] for k in want]}")
    for key, (name, ids, shas) in want.items():
        f = root / key / "align.json"
        if not f.is_file():
            check(f"{name}: align.json exists", False, str(f.relative_to(REPO)))
            continue
        a = json.loads(f.read_text())
        errs = [e.message for e in validator.iter_errors(a)]
        check(f"{name}: align.json validates (contract/align.schema.json)", not errs, "; ".join(errs[:3]))
        m = a.get("members", [])
        poses_ok = all(
            mm["scene"] == i and mm["photo_sha256"] == sh and mm["scale"] == 1 and
            mm["pose"] == (json.loads((REPO / "fixtures/scenes" / i / "truth.json").read_text()).get("pose_in_room") or {"x_m": 0, "z_m": 0, "yaw_deg": 0})
            for mm, i, sh in zip(m, ids, shas)) and len(m) == len(ids)
        check(f"{name}: members are {', '.join(ids)} in order, with their photos' sha256 and the true poses (living-wide first, the frame)",
              poses_ok and a["unplaced"] == [] and a["solver"] == "truth")


def main() -> int:
    scenes = sorted(p for p in (REPO / "fixtures/scenes").iterdir() if (p / "truth.json").is_file())
    check("the golden scenes exist: the five (three cameras, living-wide's under two more lights) and the room's six photos",
          {p.name for p in scenes} == ORIGINAL | ROOM_PHOTOS, ", ".join(p.name for p in scenes))
    for d in scenes:
        check_scene(d)
    frame = json.loads((REPO / "fixtures/scenes/living-wide/truth.json").read_text())
    for d in scenes:
        if d.name in ROOM_PHOTOS:
            check_room_pose(d, frame)
    hard = {json.loads((d / "truth.json").read_text())["room"]["hard_case"] for d in scenes if d.name in ROOM_PHOTOS}
    check("the room's hard cases are there: a bare-wall photo and a photo that shares little with the others", {"blank-wall", "little-overlap"} <= hard, f"{hard}")
    check_room_answers()
    failed = sum(1 for _, ok in results if not ok)
    print(f"\n{len(results) - failed}/{len(results)} checks passed; marker images in {OUT.relative_to(REPO)}/")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
