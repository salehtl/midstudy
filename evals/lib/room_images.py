"""Image measurements for the rooms evals (E19, eval:real-room), numpy + Pillow, run through evals/py. Spec only: contract
§4.1 (projection), §4.2 (depth.png), §4.5 (occlusion), §4.9 (a room item is drawn in each photo through its pose); never
reads planner/ or calib/. It reuses evals/lib/images.py's §4.1 rays, depth lookup and magenta test, and adds an
**oriented** box (a room item turned by rotation_y_deg in that photo's frame), which images.py's occlusion judge can't do.

    room_images.py obb-occlusion --composite C.jpg --photo P.jpg --camera J --obb J [--depth D.png] [--debug out.png]
        J obb: {"center": [x, 0, z], "size": [w, h, d], "rotation_y_deg": r} in the photo's scene frame
        the same answer as images.py occlusion: n_hidden / n_visible, hidden_match, hidden_magenta, visible_magenta, …
    room_images.py obb-classify --photo P.jpg --camera J --obb J --depth D.png
        no composite: how many silhouette pixels the depth hides or shows (to pick the photos worth a render)
    room_images.py ids-overlap --composite C.jpg --ids ids.png [--channel 0] [--debug out.png]
        the box drawn in a composite (magenta) against a golden id mask (R = sofa, threshold 128): IoU, precision, recall
    room_images.py obb-synth --photo P.jpg --camera J --obb J --mode on|off [--depth D.png] --out C.jpg   (self-test input)

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

sys.path.insert(0, str(Path(__file__).resolve().parent))
import images  # noqa: E402  (evals/lib/images.py: world_rays, depth_at_pixels, magenta, load_rgb)


def obb_entry_depth(cam: dict, W: int, H: int, obb: dict) -> np.ndarray:
    """View-axis depth where each pixel's ray enters the box (inf where it misses). The rays are taken into the box's own
    frame (p_local = Ry(-r) · (p - center)); a rotation keeps the ray parameter, which is the view-axis depth."""
    d = images.world_rays(cam, W, H)
    C = np.array([0.0, cam["height_m"], 0.0]) - np.array(obb["center"], float)
    a = math.radians(-obb["rotation_y_deg"])
    c, s = math.cos(a), math.sin(a)
    rot = np.array([[c, 0, s], [0, 1, 0], [-s, 0, c]])  # Ry(-r)
    dl = d @ rot.T
    Cl = rot @ C
    w, h, dd = obb["size"]
    bmin, bmax = np.array([-w / 2, 0.0, -dd / 2]), np.array([w / 2, h, dd / 2])
    with np.errstate(divide="ignore", invalid="ignore"):
        t1 = (bmin - Cl) / dl
        t2 = (bmax - Cl) / dl
    tmin = np.nanmax(np.minimum(t1, t2), axis=-1)
    tmax = np.nanmin(np.maximum(t1, t2), axis=-1)
    hit = (tmax >= np.maximum(tmin, 0)) & np.isfinite(tmin)
    return np.where(hit, np.maximum(tmin, 0), np.inf)


def classify(cam, W, H, depth_png, obb, margin_px=3, sep_m=0.10):
    """As images.classify, for an oriented box: silhouette pixels (eroded by margin_px) the photo's depth clearly hides
    (≥ sep_m nearer than the box, past the 3 cm tolerance) or clearly doesn't (depth 0, or ≥ sep_m farther)."""
    s = obb_entry_depth(cam, W, H, obb)
    inside = np.isfinite(s)
    er = inside.copy()
    for dy, dx in ((margin_px, 0), (-margin_px, 0), (0, margin_px), (0, -margin_px)):
        er &= np.roll(np.roll(inside, dy, axis=0), dx, axis=1)
    if depth_png:
        _, dmin, dmax = images.depth_at_pixels(depth_png, W, H)
        hidden = er & (dmin > 0) & (dmax < s - sep_m)
        visible = er & (((dmax == 0) & (dmin == 0)) | (dmin > s + sep_m))
    else:
        hidden = np.zeros_like(er)
        visible = er
    return s, inside, er, hidden, visible


def cmd_obb_occlusion(a):
    cam, obb = json.loads(a.camera), json.loads(a.obb)
    photo, (W, H) = images.load_rgb(Path(a.photo))
    comp, csize = images.load_rgb(Path(a.composite), (W, H))
    _, inside, er, hidden, visible = classify(cam, W, H, Path(a.depth) if a.depth else None, obb)
    is_mag = images.magenta(comp)
    match = (np.abs(comp - photo).max(axis=-1) <= 40) & ~is_mag
    frac = lambda m, sel: float(m[sel].mean()) if sel.any() else None
    out = {
        "composite_size": list(csize), "photo_size": [W, H],
        "n_inside": int(inside.sum()), "n_hidden": int(hidden.sum()), "n_visible": int(visible.sum()),
        "hidden_match": frac(match, hidden), "hidden_magenta": frac(is_mag, hidden), "visible_magenta": frac(is_mag, visible),
        "photo_magenta": frac(images.magenta(photo), er), "outside_magenta": float(is_mag[~inside].mean()) if (~inside).any() else 0.0,
    }
    if a.debug:
        dbg = comp.copy().astype(np.uint8)
        dbg[hidden] = (dbg[hidden] * 0.5 + np.array([0, 160, 255]) * 0.5).astype(np.uint8)
        dbg[visible] = (dbg[visible] * 0.5 + np.array([255, 255, 0]) * 0.5).astype(np.uint8)
        Image.fromarray(dbg).save(a.debug)
        out["debug"] = a.debug
    return out


def cmd_obb_classify(a):
    cam, obb = json.loads(a.camera), json.loads(a.obb)
    with Image.open(a.photo) as im:
        W, H = im.size
    _, inside, er, hidden, visible = classify(cam, W, H, Path(a.depth) if a.depth else None, obb)
    ys, xs = np.nonzero(inside)
    return {"photo_size": [W, H], "n_inside": int(inside.sum()), "n_hidden": int(hidden.sum()), "n_visible": int(visible.sum()),
            "bbox": [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None}


def cmd_ids_overlap(a):
    ids = np.asarray(Image.open(a.ids).convert("RGB"))
    H, W = ids.shape[:2]
    comp, csize = images.load_rgb(Path(a.composite), (W, H))
    truth = ids[..., a.channel] >= 128
    drawn = images.magenta(comp)
    inter, union = int((truth & drawn).sum()), int((truth | drawn).sum())
    bb = lambda m: (lambda ys, xs: [int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1] if len(xs) else None)(*np.nonzero(m))
    out = {"composite_size": list(csize), "n_truth": int(truth.sum()), "n_drawn": int(drawn.sum()),
           "iou": inter / union if union else None, "precision": inter / int(drawn.sum()) if drawn.any() else None,
           "recall": inter / int(truth.sum()) if truth.any() else None, "bbox_truth": bb(truth), "bbox_drawn": bb(drawn)}
    if out["bbox_truth"] and out["bbox_drawn"]:
        out["bbox_diff_px"] = max(abs(p - q) for p, q in zip(out["bbox_truth"], out["bbox_drawn"]))
    if a.debug:
        dbg = comp.copy().astype(np.uint8)
        dbg[truth & ~drawn] = (255, 160, 0)
        dbg[drawn & ~truth] = (0, 200, 255)
        Image.fromarray(dbg).save(a.debug)
        out["debug"] = a.debug
    return out


def cmd_obb_synth(a):
    cam, obb = json.loads(a.camera), json.loads(a.obb)
    photo, (W, H) = images.load_rgb(Path(a.photo))
    s = obb_entry_depth(cam, W, H, obb)
    draw = np.isfinite(s)
    if a.mode == "on" and a.depth:
        D, _, _ = images.depth_at_pixels(Path(a.depth), W, H)
        draw &= ~((D > 0) & (D < s - 0.03))
    out = photo.copy().astype(np.uint8)
    out[draw] = (255, 0, 255)
    Image.fromarray(out).save(a.out, quality=95)
    return {"out": a.out, "drawn": int(draw.sum())}


def main(argv):
    ap = argparse.ArgumentParser(prog="room_images.py")
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("obb-occlusion")
    for k in ("--composite", "--photo", "--camera", "--obb"):
        p.add_argument(k, required=True)
    p.add_argument("--depth"); p.add_argument("--debug")
    p = sub.add_parser("obb-classify")
    for k in ("--photo", "--camera", "--obb"):
        p.add_argument(k, required=True)
    p.add_argument("--depth")
    p = sub.add_parser("ids-overlap")
    p.add_argument("--composite", required=True); p.add_argument("--ids", required=True)
    p.add_argument("--channel", type=int, default=0); p.add_argument("--debug")
    p = sub.add_parser("obb-synth")
    for k in ("--photo", "--camera", "--obb", "--out"):
        p.add_argument(k, required=True)
    p.add_argument("--depth"); p.add_argument("--mode", choices=["on", "off"], default="on")
    a = ap.parse_args(argv)
    fn = {"obb-occlusion": cmd_obb_occlusion, "obb-classify": cmd_obb_classify, "ids-overlap": cmd_ids_overlap, "obb-synth": cmd_obb_synth}[a.cmd]
    print(json.dumps(fn(a)))


if __name__ == "__main__":
    main(sys.argv[1:])
