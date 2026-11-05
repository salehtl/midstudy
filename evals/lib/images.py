"""Image measurements for the midstudy task evals (numpy + Pillow; run through evals/py). Spec only: contract §4.1
(projection), §4.2 (depth.png), §4.3 (align), §4.7 (keep-room); never reads planner/ or calib/.

    images.py occlusion --composite C.jpg --photo P.jpg --depth D.png --camera '{...}' --box '[[min],[max]]' [--debug out.png]
    images.py synth-composite --photo P --depth D --camera J --box J --mode on|off --out C.jpg      (self-test input)
    images.py align-synth --scene-dir fixtures/scenes/living-wide --out DIR [--shift-frac 0.02]
    images.py align-measure --photo P --final F --rect x0,y0,x1,y1
    images.py align-selftest --out DIR
    images.py lighting --composite C.jpg --photo P.jpg --camera J --box '[[min],[max]]' [--depth D.png] [--lighting L.json --albedo 0.5
                       --strength 1 --ambient 1] [--light '[x,y,z]'] [--exclude '[[[min],[max]], ...]'] [--debug out.png]
                       a lit box's faces (measured vs what lighting.json predicts) and its shadow on the floor (§4.8)
    images.py drawn --composite C.jpg --photo P.jpg --window x0,y0,x1,y1 [--thresh 30] [--debug out.png]   (v1.1 splats)
    images.py splat-proj --spz S.spz --camera '{...}' --position '[x,y,z]' [--rotation-y-deg R] --width W --height H
    images.py region-diff --a A.jpg --b B.jpg --rects '[[x0,y0,x1,y1], ...]'
    images.py mask-cover --mask M.png --rect x0,y0,x1,y1

Each prints one JSON object as its last stdout line.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
MAGENTA = (220, 30, 220)


# --- §4.8 lighting ---------------------------------------------------------------------------------------------------
ACES_IN = np.array([[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]])
ACES_OUT = np.array([[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]])
FACES = {"right": (0, 1), "left": (0, -1), "top": (1, 1), "bottom": (1, -1), "front": (2, 1), "back": (2, -1)}


def aces(x: np.ndarray) -> np.ndarray:
    """three.js ACESFilmicToneMapping at exposure 1 (linear radiance -> display-linear)."""
    v = (np.asarray(x, float) / 0.6) @ ACES_IN.T
    v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081)
    return np.clip(v @ ACES_OUT.T, 0, 1)


def aces_inverse(y: np.ndarray) -> np.ndarray:
    """aces()'s inverse below the shoulder (display-linear -> linear radiance)."""
    y = np.clip(np.asarray(y, float) @ np.linalg.inv(ACES_OUT).T, 0, 0.995)
    qa, qb, qc = 1 - y * 0.983729, 0.0245786 - y * 0.4329510, -(0.000090537 + y * 0.238081)
    v = (-qb + np.sqrt(np.maximum(qb * qb - 4 * qa * qc, 0))) / (2 * qa)
    return np.maximum(v @ np.linalg.inv(ACES_IN).T, 0) * 0.6


def to_srgb8(x: np.ndarray) -> np.ndarray:
    x = np.clip(x, 0, 1)
    return 255 * np.where(x <= 0.0031308, 12.92 * x, 1.055 * np.power(x, 1 / 2.4) - 0.055)


def from_srgb8(u: np.ndarray) -> np.ndarray:
    c = np.asarray(u, float) / 255
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def cam_R(cam: dict) -> np.ndarray:
    p, r = math.radians(cam["pitch_deg"]), math.radians(cam["roll_deg"])
    return np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]]) @ \
        np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])


def lighting_E(lj: dict, cam: dict, n: np.ndarray, strength=1.0, ambient=1.0) -> tuple[np.ndarray, np.ndarray]:
    """(ambient, key) irradiance (RGB, three.js units) at world normal n from a lighting.json (§4.8), turned to the world
    with `cam`."""
    R = cam_R(cam)
    x, y, z = R.T @ n
    sh = np.array(lj["ambient"]["sh"], float)
    amb = sh[0] * 0.886227 + 2 * 0.511664 * (sh[1] * y + sh[2] * z + sh[3] * x) + sh[4] * 2 * 0.429043 * x * y + \
        sh[5] * 2 * 0.429043 * y * z + sh[6] * (0.743125 * z * z - 0.247708) + sh[7] * 2 * 0.429043 * x * z + sh[8] * 0.429043 * (x * x - y * y)
    l = R @ np.array(lj["key"]["direction"], float)
    key = lj["key"]["intensity"] * np.array(lj["key"]["color"], float) * max(0.0, float(n @ l))
    return amb * ambient, key * strength


def box_faces(cam: dict, W: int, H: int, bmin, bmax):
    """Per pixel: the view-axis depth where the ray enters the axis-aligned box (inf where it misses) and which face
    it enters through (index into FACES' order, -1 where it misses)."""
    d = world_rays(cam, W, H)
    C = np.array([0.0, cam["height_m"], 0.0])
    with np.errstate(divide="ignore", invalid="ignore"):
        t1 = (np.array(bmin) - C) / d
        t2 = (np.array(bmax) - C) / d
    tn = np.minimum(t1, t2)
    tmin, tmax = np.nanmax(tn, axis=-1), np.nanmin(np.maximum(t1, t2), axis=-1)
    hit = (tmax >= np.maximum(tmin, 0)) & np.isfinite(tmin) & (tmin > 0)
    axis = np.nanargmax(np.where(np.isfinite(tn), tn, -np.inf), axis=-1)
    sign = -np.sign(np.take_along_axis(d, axis[..., None], -1)[..., 0])
    names = list(FACES)
    face = np.full((H, W), -1)
    for i, (ax, sg) in enumerate(FACES.values()):
        face[hit & (axis == ax) & (sign == sg)] = i
    return np.where(hit, tmin, np.inf), face, names


def erode(m: np.ndarray, r: int) -> np.ndarray:
    out = m.copy()
    for dy in range(-r, r + 1):
        for dx in (-r, 0, r):
            out &= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def dilate(m: np.ndarray, r: int) -> np.ndarray:
    out = m.copy()
    for dy in range(-r, r + 1, max(1, r // 2)):
        for dx in range(-r, r + 1, max(1, r // 2)):
            out |= np.roll(np.roll(m, dy, 0), dx, 1)
    return out


def cmd_lighting(a):
    cam, (bmin, bmax) = json.loads(a.camera), json.loads(a.box)
    photo, (W, H) = load_rgb(Path(a.photo))
    comp, csize = load_rgb(Path(a.composite), (W, H))
    depth, face, names = box_faces(cam, W, H, bmin, bmax)
    others = np.zeros((H, W), bool)
    for omin, omax in json.loads(a.exclude or "[]"):
        others |= np.isfinite(box_faces(cam, W, H, omin, omax)[0])
    out = {"composite_size": list(csize), "photo_size": [W, H], "faces": {}}
    # with --depth (the scene's depth.png): leave out face pixels that a real thing in the photo may hide (anything in
    # the pixel's 3 × 3 depth neighbourhood nearer than the box + 2 cm), so a table in front isn't measured as the box
    hidden = np.zeros((H, W), bool)
    dmin = None
    if a.depth:
        _, dmin, _ = depth_at_pixels(Path(a.depth), W, H)
        hidden = np.isfinite(depth) & (dmin > 0) & (dmin < depth + 0.02)
        out["hidden_px"] = int(hidden.sum())
    lj = json.loads(Path(a.lighting).read_text()) if a.lighting else None
    for i, name in enumerate(names):
        m = erode(face == i, 3) & ~others & ~dilate(hidden, 3)
        if m.sum() < 80:
            continue
        rgb = comp[m].mean(0)
        f = {"n_px": int(m.sum()), "rgb": [round(float(v), 1) for v in rgb]}
        if lj:
            ax, sg = FACES[name]
            n = np.zeros(3)
            n[ax] = sg
            amb, key = lighting_E(lj, cam, n, a.strength, a.ambient)
            exp = to_srgb8(aces(a.albedo / math.pi * (amb + key)))
            f["expected_rgb"] = [round(float(v), 1) for v in exp]
            f["expected_ambient_only_rgb"] = [round(float(v), 1) for v in to_srgb8(aces(a.albedo / math.pi * amb))]
            Y = np.array([0.2126, 0.7152, 0.0722])
            # in radiance (ACES undone), measured / expected: the face's albedo over --albedo when the light is right
            f["ratio"] = round(float((aces_inverse(from_srgb8(rgb)) @ Y) / max(float(aces_inverse(from_srgb8(exp)) @ Y), 1e-9)), 4)
            f["max_abs_diff"] = round(float(np.abs(rgb - exp).max()), 1)
        out["faces"][name] = f
    # the floor around the box: where the composite is darker than the photo (its shadow), and where the shadow should be
    silhouette = dilate(np.isfinite(depth) | others, 6)
    d = world_rays(cam, W, H)
    C = np.array([0.0, cam["height_m"], 0.0])
    with np.errstate(divide="ignore", invalid="ignore"):
        t = -C[1] / d[..., 1]
    floor = (d[..., 1] < 0) & ~silhouette
    if dmin is not None:  # floor a real thing in the photo stands in front of (the shadow is hidden there, rightly)
        floor &= ~((dmin > 0) & (dmin < np.where(np.isfinite(t), t, np.inf) - 0.05))
    P = C + t[..., None] * d
    centre = (np.array(bmin) + np.array(bmax)) / 2
    near = floor & (np.hypot(P[..., 0] - centre[0], P[..., 2] - centre[2]) < 3.0)
    Y = np.array([0.2126, 0.7152, 0.0722])
    lp, lc = from_srgb8(photo) @ Y, from_srgb8(comp) @ Y
    ratio = np.where(lp > 0.01, lc / np.maximum(lp, 1e-6), 1.0)
    dark = near & (ratio < a.dark)
    dark &= dilate(erode(dark, 1), 1)  # an opening: drops single-pixel JPEG noise on textured floors, keeps shadows
    wts = np.clip(1 - ratio, 0, 1) * dark
    d2 = near & (ratio < 0.98)
    d2 &= dilate(erode(d2, 1), 1)  # same opening: a soft shadow's wide edge counts, scattered JPEG noise doesn't
    sh = {"n_near": int(near.sum()), "n_dark": int(dark.sum()), "n_dark_2pct": int(d2.sum()),
          "mean_ratio_dark": round(float(ratio[dark].mean()), 4) if dark.any() else None}
    if dark.any():
        cx, cz = (P[..., 0] * wts).sum() / wts.sum(), (P[..., 2] * wts).sum() / wts.sum()
        sh["centroid_floor"] = [round(float(cx), 4), round(float(cz), 4)]
        sh["offset"] = [round(float(cx - centre[0]), 4), round(float(cz - centre[2]), 4)]
    if a.light:
        l = np.array(json.loads(a.light), float)
        l /= np.linalg.norm(l)
        # the hard shadow: floor points whose ray to the light passes through the box
        Pt = np.where(floor[..., None], P, np.nan)
        with np.errstate(divide="ignore", invalid="ignore"):
            s1 = (np.array(bmin) - Pt) / l
            s2 = (np.array(bmax) - Pt) / l
        smin, smax = np.nanmax(np.minimum(s1, s2), -1), np.nanmin(np.maximum(s1, s2), -1)
        exp = floor & (smax >= np.maximum(smin, 0)) & (smax > 0)
        sh["expected_px"] = int(exp.sum())
        ex_d = dilate(exp, 10)
        sh["dark_inside_expected"] = round(float(dark[ex_d].sum() / max(int(dark.sum()), 1)), 4)
        sh["expected_darkened"] = round(float((dark & exp).sum() / max(int(exp.sum()), 1)), 4)
        lh = np.array([l[0], l[2]])
        if "offset" in sh and np.linalg.norm(lh) > 1e-6:
            off = np.array(sh["offset"])
            sh["offset_vs_light_deg"] = round(math.degrees(math.acos(max(-1, min(1, float(off @ -lh) / max(np.linalg.norm(off) * np.linalg.norm(lh), 1e-9))))), 1)
    out["shadow"] = sh
    if a.debug:
        dbg = comp.copy().astype(np.uint8)
        dbg[dark] = (dbg[dark] * 0.4 + np.array([255, 40, 40]) * 0.6).astype(np.uint8)
        if a.light:
            edge = exp & ~erode(exp, 1)
            dbg[edge] = (0, 255, 255)
        for i in range(len(names)):
            e = (face == i) & ~erode(face == i, 1)
            dbg[e] = (255, 255, 0)
        Image.fromarray(dbg).save(a.debug)
        out["debug"] = a.debug
    return out


# --- §4.1 ------------------------------------------------------------------------------------------------------------
def world_rays(cam: dict, W: int, H: int):
    """World directions of the rays through every pixel center (H × W × 3), with camera-space z = -1, so the ray
    parameter s of a hit equals its depth along the view axis (§4.1's d)."""
    f = (H / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    xs = (np.arange(W) + 0.5 - W / 2) / f
    ys = -((np.arange(H) + 0.5) - H / 2) / f
    X, Y = np.meshgrid(xs, ys)
    Z = -np.ones_like(X)
    b, a = math.radians(cam["roll_deg"]), math.radians(cam["pitch_deg"])
    x1, y1, z1 = math.cos(b) * X - math.sin(b) * Y, math.sin(b) * X + math.cos(b) * Y, Z  # Rz(roll)
    x2, y2, z2 = x1, math.cos(a) * y1 - math.sin(a) * z1, math.sin(a) * y1 + math.cos(a) * z1  # Rx(pitch)
    return np.stack([x2, y2, z2], axis=-1)


def box_entry_depth(cam: dict, W: int, H: int, bmin, bmax) -> np.ndarray:
    """View-axis depth where each pixel's ray enters the axis-aligned box (inf where it misses)."""
    d = world_rays(cam, W, H)
    C = np.array([0.0, cam["height_m"], 0.0])
    with np.errstate(divide="ignore", invalid="ignore"):
        t1 = (np.array(bmin) - C) / d
        t2 = (np.array(bmax) - C) / d
    tmin = np.nanmax(np.minimum(t1, t2), axis=-1)
    tmax = np.nanmin(np.maximum(t1, t2), axis=-1)
    hit = (tmax >= np.maximum(tmin, 0)) & np.isfinite(tmin)
    return np.where(hit, np.maximum(tmin, 0), np.inf)


def depth_at_pixels(depth_png: Path, W: int, H: int):
    """The depth map (m) looked up at every photo pixel center (nearest), plus the min and max over each lookup's
    3 × 3 neighbourhood in the depth map (to stay away from depth edges)."""
    D = np.asarray(Image.open(depth_png)).astype(np.float64) / 1000.0
    dh, dw = D.shape
    pad = np.pad(D, 1, mode="edge")
    stack = np.stack([pad[1 + dy:1 + dy + dh, 1 + dx:1 + dx + dw] for dy in (-1, 0, 1) for dx in (-1, 0, 1)])
    dmin, dmax = stack.min(axis=0), stack.max(axis=0)
    iy = np.minimum(((np.arange(H) + 0.5) * dh / H).astype(int), dh - 1)
    ix = np.minimum(((np.arange(W) + 0.5) * dw / W).astype(int), dw - 1)
    return D[np.ix_(iy, ix)], dmin[np.ix_(iy, ix)], dmax[np.ix_(iy, ix)]


def classify(cam, W, H, depth_png, bmin, bmax, margin_px=3, sep_m=0.10):
    """Pixels of the box's silhouette (eroded by margin_px) where the photo's depth clearly hides the box (hidden) or
    clearly doesn't (visible: depth 0, or farther than the box). sep_m keeps clear of the 3 cm tolerance."""
    s = box_entry_depth(cam, W, H, bmin, bmax)
    inside = np.isfinite(s)
    er = inside.copy()
    for dy, dx in ((margin_px, 0), (-margin_px, 0), (0, margin_px), (0, -margin_px)):
        er &= np.roll(np.roll(inside, dy, axis=0), dx, axis=1)
    if depth_png:
        dp, dmin, dmax = depth_at_pixels(depth_png, W, H)
        hidden = er & (dmin > 0) & (dmax < s - sep_m)
        visible = er & (((dmax == 0) & (dmin == 0)) | (dmin > s + sep_m))
    else:
        hidden = np.zeros_like(er)
        visible = er
    return s, inside, er, hidden, visible


def magenta(img: np.ndarray) -> np.ndarray:
    r, g, b = (img[..., i].astype(int) for i in range(3))
    return (np.minimum(r, b) - g > 60) & (r > 80) & (b > 80)


def load_rgb(p: Path, size=None):
    im = Image.open(p).convert("RGB")
    orig = im.size
    if size and im.size != size:
        im = im.resize(size, Image.BILINEAR)
    return np.asarray(im).astype(np.int16), orig


def cmd_occlusion(a):
    cam, (bmin, bmax) = json.loads(a.camera), json.loads(a.box)
    photo, (W, H) = load_rgb(Path(a.photo))
    comp, csize = load_rgb(Path(a.composite), (W, H))
    _, inside, er, hidden, visible = classify(cam, W, H, Path(a.depth) if a.depth else None, bmin, bmax)
    is_mag = magenta(comp)
    match = (np.abs(comp - photo).max(axis=-1) <= 40) & ~is_mag
    frac = lambda m, sel: float(m[sel].mean()) if sel.any() else None
    out = {
        "composite_size": list(csize), "photo_size": [W, H],
        "n_inside": int(inside.sum()), "n_hidden": int(hidden.sum()), "n_visible": int(visible.sum()),
        "hidden_match": frac(match, hidden), "hidden_magenta": frac(is_mag, hidden), "visible_magenta": frac(is_mag, visible),
        "photo_magenta": frac(magenta(photo), er), "outside_magenta": float(is_mag[~inside].mean()),
    }
    if a.debug:
        dbg = comp.copy().astype(np.uint8)
        dbg[hidden] = (dbg[hidden] * 0.5 + np.array([0, 160, 255]) * 0.5).astype(np.uint8)
        dbg[visible] = (dbg[visible] * 0.5 + np.array([255, 255, 0]) * 0.5).astype(np.uint8)
        Image.fromarray(dbg).save(a.debug)
        out["debug"] = a.debug
    return out


def cmd_synth_composite(a):
    """A composite drawn by this eval's own reading of §4.5 occlusion (for the harness self-test)."""
    cam, (bmin, bmax) = json.loads(a.camera), json.loads(a.box)
    photo, (W, H) = load_rgb(Path(a.photo))
    s = box_entry_depth(cam, W, H, bmin, bmax)
    inside = np.isfinite(s)
    draw = inside.copy()
    if a.mode == "on" and a.depth:
        dp, _, _ = depth_at_pixels(Path(a.depth), W, H)
        draw &= (dp == 0) | (dp >= s - 0.03)
    out = photo.astype(np.uint8).copy()
    out[draw] = MAGENTA
    Image.fromarray(out).save(a.out, quality=90)
    return {"out": a.out, "drawn": int(draw.sum()), "inside": int(inside.sum())}


# --- align (§4.3, §4.7) ------------------------------------------------------------------------------------------------
def cmd_align_synth(a):
    """The E6 pair: a 16:9 'photo' (the golden photo's middle 1600 × 900), the 'model output' (that photo resized to
    1344 × 768, like nano-banana, and shifted right by shift_frac of its width), a keep-room mask around the sofa and
    table (dilated by 3 % of the width), an unrelated image at the output size, and an identical copy."""
    out = Path(a.out)
    out.mkdir(parents=True, exist_ok=True)
    src = Image.open(Path(a.scene_dir) / "photo.jpg").convert("RGB")
    W0, H0 = src.size
    top = (H0 - 900) // 2
    photo = src.crop((0, top, 1600, top + 900))
    photo.save(out / "photo.jpg", quality=95)
    ids = np.asarray(Image.open(Path(a.scene_dir) / "ids.png").convert("RGB"))[top:top + 900, :1600]
    obj = (ids[..., 0] > 128) | (ids[..., 1] > 128)
    ys, xs = np.nonzero(obj)
    pad = round(0.03 * 1600)
    rect = [int(max(0, xs.min() - pad)), int(max(0, ys.min() - pad)), int(min(1600, xs.max() + 1 + pad)), int(min(900, ys.max() + 1 + pad))]
    mask = np.zeros((900, 1600), np.uint8)
    mask[rect[1]:rect[3], rect[0]:rect[2]] = 255
    Image.fromarray(mask).save(out / "mask.png")
    small = np.asarray(photo.resize((1344, 768), Image.LANCZOS))
    dx = round(a.shift_frac * 1344)
    shifted = np.empty_like(small)
    shifted[:, dx:] = small[:, :1344 - dx]
    shifted[:, :dx] = small[:, :1]
    Image.fromarray(shifted).save(out / "raw.jpg", quality=92)
    other = Image.open(REPO / "fixtures/fal/sam-3-3d-objects/input.jpg").convert("RGB").resize((1344, 768), Image.LANCZOS)
    other.save(out / "unrelated.jpg", quality=92)
    photo.save(out / "identical.jpg", quality=95)
    return {"photo": str(out / "photo.jpg"), "raw": str(out / "raw.jpg"), "mask": str(out / "mask.png"),
            "unrelated": str(out / "unrelated.jpg"), "identical": str(out / "identical.jpg"), "rect": rect, "shift_px": dx,
            "mask_frac": float((mask > 0).mean())}


def box_blur(g: np.ndarray, r: int = 1) -> np.ndarray:
    pad = np.pad(g, r, mode="edge")
    acc = np.zeros_like(g, dtype=np.float64)
    for dy in range(-r, r + 1):
        for dx in range(-r, r + 1):
            acc += pad[r + dy:r + dy + g.shape[0], r + dx:r + dx + g.shape[1]]
    return acc / (2 * r + 1) ** 2


def measure(photo: np.ndarray, final: np.ndarray, rect, search=8, feather=40):
    """Residual misregistration inside the mask: the shift (dx, dy) minimizing the mean absolute difference between
    final(x + dx, y + dy) and photo(x, y) over the mask shrunk by `feather`, refined to sub-pixel with a parabola.
    Also the mean difference outside the mask grown by `feather` (the composite must keep the photo there)."""
    gp = box_blur(photo.mean(axis=-1))
    gf = box_blur(final.mean(axis=-1))
    H, W = gp.shape
    x0, y0, x1, y1 = rect[0] + feather, rect[1] + feather, rect[2] - feather, rect[3] - feather
    x0, y0, x1, y1 = max(x0, search), max(y0, search), min(x1, W - search), min(y1, H - search)
    ref = gp[y0:y1, x0:x1]
    cost = np.full((2 * search + 1, 2 * search + 1), np.inf)
    for dy in range(-search, search + 1):
        for dx in range(-search, search + 1):
            cost[dy + search, dx + search] = np.abs(gf[y0 + dy:y1 + dy, x0 + dx:x1 + dx] - ref).mean()
    iy, ix = np.unravel_index(np.argmin(cost), cost.shape)

    def refine(cm, c0, cp):
        den = cm - 2 * c0 + cp
        return 0.0 if den <= 0 else 0.5 * (cm - cp) / den
    sx = ix - search + (refine(cost[iy, ix - 1], cost[iy, ix], cost[iy, ix + 1]) if 0 < ix < 2 * search else 0)
    sy = iy - search + (refine(cost[iy - 1, ix], cost[iy, ix], cost[iy + 1, ix]) if 0 < iy < 2 * search else 0)
    outside = np.ones((H, W), bool)
    outside[max(0, rect[1] - feather):rect[3] + feather, max(0, rect[0] - feather):rect[2] + feather] = False
    return {"shift_px": float(math.hypot(sx, sy)), "dx": float(sx), "dy": float(sy), "inside_diff_at_0": float(cost[search, search]),
            "inside_diff_best": float(cost[iy, ix]), "outside_diff": float(np.abs(final.astype(float) - photo.astype(float))[outside].mean()),
            "at_search_edge": bool(ix in (0, 2 * search) or iy in (0, 2 * search))}


def cmd_align_measure(a):
    photo, (W, H) = load_rgb(Path(a.photo))
    final, fsize = load_rgb(Path(a.final), (W, H))
    r = measure(photo, final, [int(v) for v in a.rect.split(",")])
    r["final_size"] = list(fsize)
    return r


def cmd_align_selftest(a):
    """The measurement itself: a perfect composite measures 0 px; one whose masked part is shifted by 3 px measures
    3 px; one that pastes the unaligned resized output measures a large error."""
    syn = cmd_align_synth(argparse.Namespace(scene_dir=str(REPO / "fixtures/scenes/living-wide"), out=a.out, shift_frac=0.02))
    photo, _ = load_rgb(Path(syn["photo"]))
    rect = syn["rect"]
    x0, y0, x1, y1 = rect
    perfect = measure(photo, photo.copy(), rect)
    shifted = photo.copy()
    shifted[y0:y1, x0:x1] = np.roll(photo, 3, axis=1)[y0:y1, x0:x1]
    three = measure(photo, shifted, rect)
    raw, _ = load_rgb(Path(syn["raw"]), (1600, 900))
    naive = photo.copy()
    naive[y0:y1, x0:x1] = raw[y0:y1, x0:x1]
    unaligned = measure(photo, naive, rect, search=40)
    return {"perfect": perfect, "three": three, "unaligned": unaligned}


# --- v1.1 splats (contract §4.5 Splats) -----------------------------------------------------------------------------
def _rect(text):
    return [int(round(float(v))) for v in str(text).strip("[]").split(",")]


def cmd_drawn(a):
    """Where the planner drew something: the bounding box of the pixels inside `window` that differ from the photo by
    more than `thresh` (max over channels). Uses the 0.2th–99.8th percentile of their coordinates, so a few stray
    pixels can't stretch it. Contact shadows must be off: they darken the floor around the footprint."""
    photo, (W, H) = load_rgb(Path(a.photo))
    comp, csize = load_rgb(Path(a.composite), (W, H))
    x0, y0, x1, y1 = _rect(a.window)
    x0, y0, x1, y1 = max(0, x0), max(0, y0), min(W, x1), min(H, y1)
    diff = np.abs(comp - photo).max(axis=-1) > a.thresh
    win = np.zeros((H, W), bool)
    win[y0:y1, x0:x1] = True
    d = diff & win
    out = {"composite_size": list(csize), "n": int(d.sum()), "window": [x0, y0, x1, y1]}
    ys, xs = np.nonzero(d)
    if len(xs) >= 50:
        bx0, bx1 = np.percentile(xs, [0.2, 99.8])
        by0, by1 = np.percentile(ys, [0.2, 99.8])
        out["bbox"] = [float(bx0), float(by0), float(bx1 + 1), float(by1 + 1)]
    if a.debug:
        dbg = comp.copy().astype(np.uint8)
        dbg[d] = (dbg[d] * 0.4 + np.array([0, 255, 120]) * 0.6).astype(np.uint8)
        Image.fromarray(dbg).save(a.debug)
        out["debug"] = a.debug
    return out


def cmd_splat_proj(a):
    """Where a placed splat's own points land in the photo (§4.1): the centers of the opaque splats (alpha ≥ 0.5) of a
    gzipped SPZ v2 file (§1), turned by rotation_y_deg (counterclockwise seen from above) and moved to `position`.
    Returns the 0.2th–99.8th percentile bbox of their pixel coordinates (as `drawn` does)."""
    import gzip
    import struct
    raw = gzip.decompress(Path(a.spz).read_bytes())
    _magic, _ver, n, _sh, frac, _flags, _r = struct.unpack_from("<IIIBBBB", raw, 0)
    b = np.frombuffer(raw, dtype=np.uint8, count=n * 9, offset=16).reshape(n, 3, 3).astype(np.int32)
    v = b[..., 0] | (b[..., 1] << 8) | (b[..., 2] << 16)
    xyz = np.where(v & 0x800000, v - (1 << 24), v).astype(np.float64) / (1 << frac)
    alpha = np.frombuffer(raw, dtype=np.uint8, count=n, offset=16 + n * 9)
    p = xyz[alpha >= 128]
    t = math.radians(a.rotation_y_deg)
    x = p[:, 0] * math.cos(t) + p[:, 2] * math.sin(t)
    z = -p[:, 0] * math.sin(t) + p[:, 2] * math.cos(t)
    pos = json.loads(a.position)
    cam = json.loads(a.camera)
    W, H = a.width, a.height
    rel = np.stack([x + pos[0], p[:, 1] + pos[1] - cam["height_m"], z + pos[2]], axis=-1)
    pa, ro = math.radians(cam["pitch_deg"]), math.radians(cam["roll_deg"])
    # world = Rx(pitch) Rz(roll) cam (world_rays), so cam = Rz(-roll) Rx(-pitch) world
    y1 = math.cos(pa) * rel[:, 1] + math.sin(pa) * rel[:, 2]
    z1 = -math.sin(pa) * rel[:, 1] + math.cos(pa) * rel[:, 2]
    x1 = rel[:, 0]
    xc = math.cos(ro) * x1 + math.sin(ro) * y1
    yc = -math.sin(ro) * x1 + math.cos(ro) * y1
    d = -z1
    f = (H / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    keep = d > 1e-3
    px = W / 2 + f * xc[keep] / d[keep]
    py = H / 2 - f * yc[keep] / d[keep]
    bx0, bx1 = np.percentile(px, [0.2, 99.8])
    by0, by1 = np.percentile(py, [0.2, 99.8])
    return {"n": int(keep.sum()), "count": int(n), "bbox": [float(bx0), float(by0), float(bx1), float(by1)]}


def cmd_region_diff(a):
    """How much two composites differ inside the given rects: mean and 99th percentile of the per-pixel max channel
    difference (JPEG noise alone stays around 1 and under 10)."""
    A, sa = load_rgb(Path(a.a))
    B, sb = load_rgb(Path(a.b), sa)
    H, W = A.shape[:2]
    sel = np.zeros((H, W), bool)
    for r in json.loads(a.rects):
        x0, y0, x1, y1 = (int(round(v)) for v in r)
        sel[max(0, y0):min(H, y1), max(0, x0):min(W, x1)] = True
    d = np.abs(A - B).max(axis=-1)[sel]
    return {"n": int(sel.sum()), "mean": float(d.mean()) if d.size else None, "p99": float(np.percentile(d, 99)) if d.size else None}


def cmd_mask_cover(a):
    """The share of white (≥ 128) mask pixels inside a rect (a keep-room mask, §4.7)."""
    m = np.asarray(Image.open(a.mask).convert("L"))
    H, W = m.shape
    x0, y0, x1, y1 = _rect(a.rect)
    reg = m[max(0, y0):min(H, y1), max(0, x0):min(W, x1)]
    return {"size": [W, H], "n": int(reg.size), "white": float((reg >= 128).mean()) if reg.size else None}


def main(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("occlusion")
    for k in ("--composite", "--photo", "--camera", "--box"):
        p.add_argument(k, required=True)
    p.add_argument("--depth")
    p.add_argument("--debug")
    p = sub.add_parser("synth-composite")
    for k in ("--photo", "--camera", "--box", "--out"):
        p.add_argument(k, required=True)
    p.add_argument("--depth")
    p.add_argument("--mode", choices=["on", "off"], required=True)
    p = sub.add_parser("align-synth")
    p.add_argument("--scene-dir", required=True)
    p.add_argument("--out", required=True)
    p.add_argument("--shift-frac", type=float, default=0.02)
    p = sub.add_parser("align-measure")
    for k in ("--photo", "--final", "--rect"):
        p.add_argument(k, required=True)
    p = sub.add_parser("lighting")
    p.add_argument("--composite", required=True)
    p.add_argument("--photo", required=True)
    p.add_argument("--camera", required=True)
    p.add_argument("--box", required=True)
    p.add_argument("--lighting")
    p.add_argument("--albedo", type=float, default=0.5)
    p.add_argument("--strength", type=float, default=1.0)
    p.add_argument("--ambient", type=float, default=1.0)
    p.add_argument("--light")
    p.add_argument("--exclude")
    p.add_argument("--depth")
    p.add_argument("--dark", type=float, default=0.93)
    p.add_argument("--debug")
    p = sub.add_parser("align-selftest")
    p.add_argument("--out", required=True)
    p = sub.add_parser("drawn")
    for k in ("--composite", "--photo", "--window"):
        p.add_argument(k, required=True)
    p.add_argument("--thresh", type=float, default=30)
    p.add_argument("--debug")
    p = sub.add_parser("splat-proj")
    for k in ("--spz", "--camera", "--position"):
        p.add_argument(k, required=True)
    p.add_argument("--rotation-y-deg", type=float, default=0.0)
    p.add_argument("--width", type=int, required=True)
    p.add_argument("--height", type=int, required=True)
    p = sub.add_parser("region-diff")
    for k in ("--a", "--b", "--rects"):
        p.add_argument(k, required=True)
    p = sub.add_parser("mask-cover")
    for k in ("--mask", "--rect"):
        p.add_argument(k, required=True)
    a = ap.parse_args(argv)
    fn = {"occlusion": cmd_occlusion, "synth-composite": cmd_synth_composite, "align-synth": cmd_align_synth,
          "align-measure": cmd_align_measure, "align-selftest": cmd_align_selftest, "drawn": cmd_drawn,
          "splat-proj": cmd_splat_proj, "region-diff": cmd_region_diff, "mask-cover": cmd_mask_cover, "lighting": cmd_lighting}[a.cmd]
    print(json.dumps(fn(a)))


if __name__ == "__main__":
    main(sys.argv[1:])
