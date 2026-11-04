"""Measure midstudy-calib on the golden scenes and on real photos, and draw floor-grid overlays.

    uv run --project calib python calib/scripts/calib_report.py [--out evals/out/calib/report] [--model vitl]
                                                                 [--device auto] [--photos <img> ...] [--skip-golden]

For each golden scene (fixtures/scenes/*/) it runs `midstudy-calib run` on photo.jpg into <out>/golden/<id>/ and compares
the fitted camera with truth.json (fov, height, pitch, roll) and depth.png with the true depth (median relative error
on pixels that are non-zero in both, and how many true non-floor pixels we zeroed). For each real photo it runs the CLI
into <out>/real/<name>/ and records the camera, floor inlier ratio, device and runtime. Every photo gets
<out>/overlays/<name>-grid.jpg: the 50 cm floor grid from the fitted camera (cyan; the true camera in magenta for golden
scenes), and <name>-depth.jpg: the depth map with the masked floor in green; both in evals/out/calib/overlays/.
Real photos' scene folders lose source.* at the end (the camera original keeps its EXIF there).

Prints a JSON summary on the last stdout line and a markdown table before it. Real photos never leave <out>
(evals/out/ is git-ignored).
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
OVERLAYS = REPO / "evals/out/calib/overlays"


# --- contract §4.1 -------------------------------------------------------------------------------------------------
def rotation(cam: dict) -> np.ndarray:
    p, r = math.radians(cam["pitch_deg"]), math.radians(cam["roll_deg"])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return rx @ rz


def project(cam: dict, w: int, h: int, pts: np.ndarray):
    c = (np.asarray(pts, float) - np.array([0.0, cam["height_m"], 0.0])) @ rotation(cam)
    d = -c[:, 2]
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.stack([w / 2 + f * c[:, 0] / d, h / 2 - f * c[:, 1] / d], 1), d


def draw_grid(img: Image.Image, cam: dict, color: tuple, step: float = 0.5, reach: float = 8.0, width: int = 2) -> None:
    """The 50 cm grid on y = 0 out to `reach` m, fading with distance (like the planner's floor check)."""
    w, h = img.size
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(over)
    ticks = np.arange(-reach, reach + 1e-6, step)
    lines = [np.stack([np.full(400, x), np.zeros(400), np.linspace(0, -reach, 400)], 1) for x in ticks]
    lines += [np.stack([np.linspace(-reach, reach, 400), np.zeros(400), np.full(400, z)], 1) for z in ticks if z < 0]
    for pts in lines:
        px, d = project(cam, w, h, pts)
        dist = np.hypot(pts[:, 0], pts[:, 2])
        ok = (d > 0.05) & (dist <= reach)
        for i in range(len(pts) - 1):
            if ok[i] and ok[i + 1]:
                a = int(255 * max(0.15, 1 - dist[i] / reach))
                dr.line([tuple(px[i]), tuple(px[i + 1])], fill=color + (a,), width=width)
    img.alpha_composite(over)


def depth_view(photo: Image.Image, depth_path: Path) -> Image.Image:
    dimg = np.asarray(Image.open(depth_path)).astype(np.float32)
    nz = dimg[dimg > 0]
    lo, hi = (np.percentile(nz, 2), np.percentile(nz, 98)) if nz.size else (0, 1)
    v = np.clip((dimg - lo) / max(1, hi - lo), 0, 1)
    rgb = np.stack([255 * (1 - v), 255 * (1 - v), 255 * (1 - v)], -1)
    rgb[dimg == 0] = (40, 200, 90)
    small = Image.fromarray(rgb.astype(np.uint8)).resize(photo.size, Image.Resampling.NEAREST)
    return Image.blend(photo.convert("RGB"), small, 0.65)


def tag(args) -> str:
    """Overlay file suffix: none for the default model, -vitb / -vits otherwise."""
    return "" if args.model == "vitl" else f"-{args.model}"


# --- running the CLI -----------------------------------------------------------------------------------------------
def run_cli(photo: Path, out: Path, model: str, device: str) -> tuple[dict, float, str]:
    out.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "midstudy_calib.cli", "run", str(photo), "--out", str(out), "--model", model, "--device", device]
    env = {k: v for k, v in __import__("os").environ.items() if k not in ("MIDSTUDY_CALIB_MOCK",)}
    t = time.monotonic()
    p = subprocess.run(cmd, capture_output=True, text=True, env=env)
    dt = time.monotonic() - t
    (out.parent / f"{out.name}.stderr.txt").write_text(p.stderr)
    last = p.stdout.strip().splitlines()[-1] if p.stdout.strip() else "{}"
    res = json.loads(last)
    if p.returncode != 0 or not res.get("ok"):
        raise SystemExit(f"midstudy-calib failed on {photo}: {res.get('error') or p.stderr[-500:]}")
    return res, dt, p.stderr


def golden(sid: str, out: Path, args) -> dict:
    d = REPO / "fixtures/scenes" / sid
    truth = json.loads((d / "truth.json").read_text())
    res, dt, _ = run_cli(d / "photo.jpg", out / "golden" / sid, args.model, args.device)
    cam, tc = res["camera"], truth["camera"]
    row = {"id": sid, "camera": cam, "truth": tc, "runtime_s": round(dt, 1), "device": res["device"],
           "source": res["source"], "floor": res["floor"],
           "err": {"fov_deg": round(cam["fov_y_deg"] - tc["fov_y_deg"], 2),
                   "height_pct": round(100 * (cam["height_m"] - tc["height_m"]) / tc["height_m"], 1),
                   "pitch_deg": round(cam["pitch_deg"] - tc["pitch_deg"], 2),
                   "roll_deg": round(cam["roll_deg"] - tc["roll_deg"], 2)}}
    # depth vs truth (both mm along the view axis, same size)
    ours_p = out / "golden" / sid / "depth.png"
    if res.get("depth") and ours_p.is_file():
        ours = np.asarray(Image.open(ours_p)).astype(np.float64)
        tru = np.asarray(Image.open(d / "depth.png")).astype(np.float64)
        if ours.shape != tru.shape:
            ours = np.asarray(Image.open(ours_p).resize(tru.shape[::-1], Image.Resampling.NEAREST)).astype(np.float64)
        both = (ours > 0) & (tru > 0)
        rel = np.abs(ours[both] - tru[both]) / tru[both]
        # scale-free: after the best single scale (median ratio), how good is the shape?
        k = np.median(tru[both] / ours[both])
        rel_s = np.abs(k * ours[both] - tru[both]) / tru[both]
        fp = [tuple(map(int, np.floor(np.array(p["px"]) * np.array(tru.shape[::-1]) / np.array([truth["image"]["w"], truth["image"]["h"]]))))
              for p in truth.get("floor_points", [])]
        row["depth"] = {"median_rel_err_pct": round(100 * float(np.median(rel)), 1),
                        "median_rel_err_after_scale_pct": round(100 * float(np.median(rel_s)), 1), "scale_to_truth": round(float(k), 3),
                        "true_nonfloor_zeroed_pct": round(100 * float(((ours == 0) & (tru > 0)).sum() / max(1, (tru > 0).sum())), 1),
                        "true_floor_nonzero_pct": round(100 * float(((ours > 0) & (tru == 0)).sum() / max(1, (tru == 0).sum())), 1),
                        "open_floor_points_zero": all(ours[y, x] == 0 for x, y in fp) if fp else None}
    img = Image.open(d / "photo.jpg").convert("RGBA")
    draw_grid(img, tc, (255, 0, 200), width=3)
    draw_grid(img, cam, (0, 230, 255), width=2)
    OVERLAYS.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(OVERLAYS / f"golden-{sid}{tag(args)}-grid.jpg", quality=88)
    if ours_p.is_file():
        depth_view(Image.open(d / "photo.jpg"), ours_p).save(OVERLAYS / f"golden-{sid}{tag(args)}-depth.jpg", quality=85)
    return row


def real(photo: Path, out: Path, args) -> dict:
    name = photo.stem
    res, dt, err = run_cli(photo, out / "real" / name, args.model, args.device)
    scene = out / "real" / name
    row = {"photo": str(photo.relative_to(REPO)) if photo.is_relative_to(REPO) else str(photo), "camera": res["camera"],
           "source": res["source"], "floor": res["floor"], "device": res["device"], "runtime_s": round(dt, 1),
           "elapsed_s": res["elapsed_s"], "exif": res["exif"], "moge": res.get("moge"),
           "fov_disagreement": res.get("fov_disagreement"), "image": res["image"]}
    img = Image.open(scene / "photo.jpg").convert("RGBA")
    draw_grid(img, res["camera"], (0, 230, 255), width=max(2, img.size[0] // 800))
    OVERLAYS.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(OVERLAYS / f"real-{name}{tag(args)}-grid.jpg", quality=88)
    if (scene / "depth.png").is_file():
        depth_view(Image.open(scene / "photo.jpg"), scene / "depth.png").save(OVERLAYS / f"real-{name}{tag(args)}-depth.jpg", quality=85)
    for src in scene.glob("source.*"):
        src.unlink()  # the camera original (EXIF) isn't kept around
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path, default=REPO / "evals/out/calib/report")
    ap.add_argument("--model", default="vitl")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--photos", type=Path, nargs="*", default=None)
    ap.add_argument("--skip-golden", action="store_true")
    args = ap.parse_args()
    summary = {"golden": [], "real": []}
    if not args.skip_golden:
        for sid in sorted(p.name for p in (REPO / "fixtures/scenes").iterdir() if (p / "truth.json").is_file()):
            r = golden(sid, args.out, args)
            summary["golden"].append(r)
            e, c = r["err"], r["camera"]
            print(f"| {sid} | {c['fov_y_deg']} ({e['fov_deg']:+}) | {c['height_m']} ({e['height_pct']:+}%) | {c['pitch_deg']} ({e['pitch_deg']:+}) "
                  f"| {c['roll_deg']} ({e['roll_deg']:+}) | {r.get('depth', {}).get('median_rel_err_pct')}% "
                  f"| {r.get('depth', {}).get('median_rel_err_after_scale_pct')}% | {r['floor']['inlier_ratio']} | {r['runtime_s']} s |", flush=True)
    photos = args.photos
    if photos is None:
        photos = sorted(p for p in (REPO / "fixtures/photos").glob("*") if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg", ".png", ".heic", ".webp"))
        photos += sorted(p for p in (REPO / "fixtures/photos-public").glob("*") if p.is_file() and p.suffix.lower() in (".jpg", ".jpeg", ".png", ".heic", ".webp"))
    for ph in photos:
        if "private" in ph.parts:
            continue  # never opened
        r = real(ph.resolve(), args.out, args)
        summary["real"].append(r)
        c = r["camera"]
        print(f"| {ph.name} | {r['image']['w']} x {r['image']['h']} | {c['fov_y_deg']} | {c['height_m']} | {c['pitch_deg']} | {c['roll_deg']} "
              f"| {r['floor']['found']} {r['floor']['inlier_ratio']} | {(r['exif'] or {}).get('fov_y_deg')} | {r['device']} | {r['runtime_s']} s |", flush=True)
    (args.out / "report.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
