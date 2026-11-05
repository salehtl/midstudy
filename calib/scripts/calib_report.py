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
import os
import subprocess
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageDraw

REPO = Path(__file__).resolve().parents[2]
OVERLAYS = REPO / "evals/out/calib/overlays"
type F64 = NDArray[np.float64]
type Json = dict[str, object]


@dataclass(frozen=True)
class Cam:
    """The contract §4.1 camera block."""

    fov_y_deg: float
    height_m: float
    pitch_deg: float
    roll_deg: float

    @staticmethod
    def of(block: object) -> Cam:
        b = cast(Json, block) if isinstance(block, dict) else {}
        return Cam(*(_float(b.get(k)) for k in ("fov_y_deg", "height_m", "pitch_deg", "roll_deg")))


def _float(v: object) -> float:
    if not isinstance(v, int | float) or isinstance(v, bool):
        raise SystemExit(f"calib_report: expected a number, got {v!r}")
    return float(v)


def _get(d: object, *path: str) -> object:
    for k in path:
        if not isinstance(d, dict):
            return None
        d = cast(Json, d).get(k)
    return d


def _load(path: Path) -> Json:
    data: object = json.loads(path.read_text())
    if not isinstance(data, dict):
        raise SystemExit(f"calib_report: {path} isn't a JSON object")
    return cast(Json, data)


# --- contract §4.1 -------------------------------------------------------------------------------------------------
def rotation(cam: Cam) -> F64:
    p, r = math.radians(cam.pitch_deg), math.radians(cam.roll_deg)
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return rx @ rz


def project(cam: Cam, w: int, h: int, pts: F64) -> tuple[F64, F64]:
    c = (np.asarray(pts, np.float64) - np.array([0.0, cam.height_m, 0.0])) @ rotation(cam)
    d = -c[:, 2]
    f = (h / 2) / math.tan(math.radians(cam.fov_y_deg) / 2)
    with np.errstate(divide="ignore", invalid="ignore"):
        return np.stack([w / 2 + f * c[:, 0] / d, h / 2 - f * c[:, 1] / d], 1), d


def draw_grid(img: Image.Image, cam: Cam, color: tuple[int, int, int], step: float = 0.5, reach: float = 8.0, width: int = 2) -> None:
    """The 50 cm grid on y = 0 out to `reach` m, fading with distance (like the planner's floor check)."""
    w, h = img.size
    over = Image.new("RGBA", img.size, (0, 0, 0, 0))
    dr = ImageDraw.Draw(over)
    ticks = [float(t) for t in np.arange(-reach, reach + 1e-6, step)]
    lines = [np.stack([np.full(400, x), np.zeros(400), np.linspace(0, -reach, 400)], 1) for x in ticks]
    lines += [np.stack([np.linspace(-reach, reach, 400), np.zeros(400), np.full(400, z)], 1) for z in ticks if z < 0]
    for pts in lines:
        px, d = project(cam, w, h, pts)
        dist = np.hypot(pts[:, 0], pts[:, 2])
        ok = (d > 0.05) & (dist <= reach)
        for i in range(len(pts) - 1):
            if ok[i] and ok[i + 1]:
                a = int(255 * max(0.15, 1 - float(dist[i]) / reach))
                dr.line([(float(px[i, 0]), float(px[i, 1])), (float(px[i + 1, 0]), float(px[i + 1, 1]))], fill=(*color, a), width=width)
    img.alpha_composite(over)


def depth_view(photo: Image.Image, depth_path: Path) -> Image.Image:
    dimg = np.asarray(Image.open(depth_path)).astype(np.float32)
    nz = dimg[dimg > 0]
    lo, hi = (float(np.percentile(nz, 2)), float(np.percentile(nz, 98))) if nz.size else (0.0, 1.0)
    v = np.clip((dimg - lo) / max(1.0, hi - lo), 0, 1)
    rgb = np.stack([255 * (1 - v), 255 * (1 - v), 255 * (1 - v)], -1)
    rgb[dimg == 0] = (40, 200, 90)
    small = Image.fromarray(rgb.astype(np.uint8)).resize(photo.size, Image.Resampling.NEAREST)
    return Image.blend(photo.convert("RGB"), small, 0.65)


@dataclass(frozen=True)
class Opts:
    out: Path
    model: str
    device: str
    photos: list[Path] | None
    skip_golden: bool

    def tag(self) -> str:
        """Overlay file suffix: none for the default model, -vitb / -vits otherwise."""
        return "" if self.model == "vitl" else f"-{self.model}"


# --- running the CLI -----------------------------------------------------------------------------------------------
def run_cli(photo: Path, out: Path, opts: Opts) -> tuple[Json, float]:
    out.mkdir(parents=True, exist_ok=True)
    cmd = [sys.executable, "-m", "midstudy_calib.cli", "run", str(photo), "--out", str(out), "--model", opts.model, "--device", opts.device]
    env = {k: v for k, v in os.environ.items() if k != "MIDSTUDY_CALIB_MOCK"}
    t = time.monotonic()
    p = subprocess.run(cmd, capture_output=True, text=True, env=env, check=False)
    dt = time.monotonic() - t
    (out.parent / f"{out.name}.stderr.txt").write_text(p.stderr)
    last = p.stdout.strip().splitlines()[-1] if p.stdout.strip() else "{}"
    res: object = json.loads(last)
    if p.returncode != 0 or _get(res, "ok") is not True:
        raise SystemExit(f"midstudy-calib failed on {photo}: {_get(res, 'error') or p.stderr[-500:]}")
    return cast(Json, res), dt


def golden(sid: str, opts: Opts) -> Json:
    d = REPO / "fixtures/scenes" / sid
    truth = _load(d / "truth.json")
    res, dt = run_cli(d / "photo.jpg", opts.out / "golden" / sid, opts)
    cam, tc = Cam.of(res["camera"]), Cam.of(truth["camera"])
    row: Json = {"id": sid, "camera": res["camera"], "truth": truth["camera"], "runtime_s": round(dt, 1), "device": res["device"],
                 "source": res["source"], "floor": res["floor"],
                 "err": {"fov_deg": round(cam.fov_y_deg - tc.fov_y_deg, 2),
                         "height_pct": round(100 * (cam.height_m - tc.height_m) / tc.height_m, 1),
                         "pitch_deg": round(cam.pitch_deg - tc.pitch_deg, 2),
                         "roll_deg": round(cam.roll_deg - tc.roll_deg, 2)}}
    # depth vs truth (both mm along the view axis, same size)
    ours_p = opts.out / "golden" / sid / "depth.png"
    if res.get("depth") and ours_p.is_file():
        ours = np.asarray(Image.open(ours_p)).astype(np.float64)
        tru = np.asarray(Image.open(d / "depth.png")).astype(np.float64)
        if ours.shape != tru.shape:
            ours = np.asarray(Image.open(ours_p).resize((tru.shape[1], tru.shape[0]), Image.Resampling.NEAREST)).astype(np.float64)
        both = (ours > 0) & (tru > 0)
        rel = np.abs(ours[both] - tru[both]) / tru[both]
        # scale-free: after the best single scale (median ratio), how good is the shape?
        k = float(np.median(tru[both] / ours[both]))
        rel_s = np.abs(k * ours[both] - tru[both]) / tru[both]
        iw, ih = _float(_get(truth, "image", "w")), _float(_get(truth, "image", "h"))
        pts = _get(truth, "floor_points")
        fp = [(int(px[0] * tru.shape[1] / iw), int(px[1] * tru.shape[0] / ih))
              for px in (np.asarray(_get(p, "px"), np.float64) for p in (cast(list[object], pts) if isinstance(pts, list) else []))]
        row["depth"] = {"median_rel_err_pct": round(100 * float(np.median(rel)), 1),
                        "median_rel_err_after_scale_pct": round(100 * float(np.median(rel_s)), 1), "scale_to_truth": round(k, 3),
                        "true_nonfloor_zeroed_pct": round(100 * float(((ours == 0) & (tru > 0)).sum() / max(1, (tru > 0).sum())), 1),
                        "true_floor_nonzero_pct": round(100 * float(((ours > 0) & (tru == 0)).sum() / max(1, (tru == 0).sum())), 1),
                        "open_floor_points_zero": all(ours[y, x] == 0 for x, y in fp) if fp else None}
    img = Image.open(d / "photo.jpg").convert("RGBA")
    draw_grid(img, tc, (255, 0, 200), width=3)
    draw_grid(img, cam, (0, 230, 255), width=2)
    OVERLAYS.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(OVERLAYS / f"golden-{sid}{opts.tag()}-grid.jpg", quality=88)
    if ours_p.is_file():
        depth_view(Image.open(d / "photo.jpg"), ours_p).save(OVERLAYS / f"golden-{sid}{opts.tag()}-depth.jpg", quality=85)
    return row


def real(photo: Path, opts: Opts) -> Json:
    name = photo.stem
    scene = opts.out / "real" / name
    res, dt = run_cli(photo, scene, opts)
    row: Json = {"photo": str(photo.relative_to(REPO)) if photo.is_relative_to(REPO) else str(photo), "camera": res["camera"],
                 "source": res["source"], "floor": res["floor"], "device": res["device"], "runtime_s": round(dt, 1),
                 "elapsed_s": res["elapsed_s"], "exif": res["exif"], "moge": res.get("moge"),
                 "fov_disagreement": res.get("fov_disagreement"), "image": res["image"]}
    img = Image.open(scene / "photo.jpg").convert("RGBA")
    draw_grid(img, Cam.of(res["camera"]), (0, 230, 255), width=max(2, img.size[0] // 800))
    OVERLAYS.mkdir(parents=True, exist_ok=True)
    img.convert("RGB").save(OVERLAYS / f"real-{name}{opts.tag()}-grid.jpg", quality=88)
    if (scene / "depth.png").is_file():
        depth_view(Image.open(scene / "photo.jpg"), scene / "depth.png").save(OVERLAYS / f"real-{name}{opts.tag()}-depth.jpg", quality=85)
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
    ns = vars(ap.parse_args())
    photos_arg = ns["photos"]
    opts = Opts(out=Path(str(ns["out"])), model=str(ns["model"]), device=str(ns["device"]),
                photos=[Path(str(p)) for p in cast(list[object], photos_arg)] if isinstance(photos_arg, list) else None,
                skip_golden=ns["skip_golden"] is True)
    golden_rows: list[Json] = []
    real_rows: list[Json] = []
    if not opts.skip_golden:
        for sid in sorted(p.name for p in (REPO / "fixtures/scenes").iterdir() if (p / "truth.json").is_file()):
            r = golden(sid, opts)
            golden_rows.append(r)
            e, c = cast(Json, r["err"]), Cam.of(r["camera"])
            dep = cast(Json, r.get("depth") or {})
            print(f"| {sid} | {c.fov_y_deg} ({e['fov_deg']:+}) | {c.height_m} ({e['height_pct']:+}%) | {c.pitch_deg} ({e['pitch_deg']:+}) "
                  f"| {c.roll_deg} ({e['roll_deg']:+}) | {dep.get('median_rel_err_pct')}% "
                  f"| {dep.get('median_rel_err_after_scale_pct')}% | {_get(r, 'floor', 'inlier_ratio')} | {r['runtime_s']} s |", flush=True)
    photos = opts.photos
    if photos is None:
        kinds = (".jpg", ".jpeg", ".png", ".heic", ".webp")
        photos = sorted(p for p in (REPO / "fixtures/photos").glob("*") if p.is_file() and p.suffix.lower() in kinds)
        photos += sorted(p for p in (REPO / "fixtures/photos-public").glob("*") if p.is_file() and p.suffix.lower() in kinds)
    for ph in photos:
        if "private" in ph.parts:
            continue  # never opened
        r = real(ph.resolve(), opts)
        real_rows.append(r)
        c = Cam.of(r["camera"])
        print(f"| {ph.name} | {_get(r, 'image', 'w')} x {_get(r, 'image', 'h')} | {c.fov_y_deg} | {c.height_m} | {c.pitch_deg} | {c.roll_deg} "
              f"| {_get(r, 'floor', 'found')} {_get(r, 'floor', 'inlier_ratio')} | {_get(r, 'exif', 'fov_y_deg')} | {r['device']} | {r['runtime_s']} s |",
              flush=True)
    summary = {"golden": golden_rows, "real": real_rows}
    (opts.out / "report.json").write_text(json.dumps(summary, indent=2))
    print(json.dumps(summary))
    return 0


if __name__ == "__main__":
    sys.exit(main())
