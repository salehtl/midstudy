"""Wall time of midstudy-calib: one-shot CLI calls against the warm worker (`midstudy-calib serve`), and their outputs.

    uv run --project calib python calib/scripts/bench.py [--mode oneshot|worker|both] [--label NAME] [--repeat N]
                                                         [--cli "uv run --project calib midstudy-calib"] [--photos P ...]
    uv run --project calib python calib/scripts/bench.py --compare evals/out/calib-bench/A/oneshot evals/out/calib-bench/B/worker

Photos (default): the five golden scenes' photo.jpg, then fixtures/photos/upper-lounge-camera.jpeg when it is there
(never anything under fixtures/photos/private/). Every calibration is `run <photo> --out <dir>`, real MoGe-2 (no
MIDSTUDY_CALIB_MOCK), $0. One-shot: one process per photo, timed from spawn to exit. Worker: one `serve` process per
repeat, the photos sent one after another; the first calibration is timed from spawn to its response (what a server
that starts the worker on the first calibration waits), the others from request to response. Outputs land in
evals/out/calib-bench/<label>/<mode>[-<repeat>]/<name>/ (git-ignored); source.* is deleted after each run (the camera
original keeps its EXIF there). Prints a table and writes <label>/bench.json.

--compare A B: the calib.json, lighting.json and depth.png of every scene in both folders, side by side.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import IO, TypedDict

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
OUT = REPO / "evals/out/calib-bench"
GOLDEN = ["living-wide", "steep-roll", "portrait", "living-cool", "living-warm"]
LOUNGE = REPO / "fixtures/photos/upper-lounge-camera.jpeg"
DEFAULT_CLI = "uv run --project calib midstudy-calib"


class Row(TypedDict):
    mode: str
    repeat: int
    index: int
    name: str
    wall_s: float
    ok: bool
    elapsed_s: float | None
    load_s: float | None
    infer_s: float | None
    floor_fit_s: float | None
    light_s: float | None
    error: str | None


def default_photos() -> list[tuple[str, Path]]:
    out = [(sid, REPO / "fixtures/scenes" / sid / "photo.jpg") for sid in GOLDEN]
    if LOUNGE.is_file():
        out.append(("lounge", LOUNGE))
    return out


def env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k not in ("MIDSTUDY_CALIB_MOCK", "VIRTUAL_ENV", "PYTHONHOME", "PYTHONPATH")}


def _num(d: object, *path: str) -> float | None:
    for k in path:
        if not isinstance(d, dict):
            return None
        d = d.get(k)  # type: ignore[union-attr]  # narrowed to dict above
    return float(d) if isinstance(d, int | float) and not isinstance(d, bool) else None


def row(mode: str, repeat: int, index: int, name: str, wall: float, res: object, scene: Path) -> Row:
    light: object = None
    if (scene / "lighting.json").is_file():
        light = json.loads((scene / "lighting.json").read_text())
    ok = isinstance(res, dict) and res.get("ok") is True  # type: ignore[union-attr]
    err = res.get("error") if isinstance(res, dict) else "no JSON result"  # type: ignore[union-attr]
    return Row(mode=mode, repeat=repeat, index=index, name=name, wall_s=round(wall, 3), ok=ok,
               elapsed_s=_num(res, "elapsed_s"), load_s=_num(res, "moge", "load_s"), infer_s=_num(res, "moge", "infer_s"),
               floor_fit_s=_num(res, "moge", "floor_fit_s"), light_s=_num(light, "fit", "elapsed_s"),
               error=None if ok else str(err))


def clean(scene: Path) -> None:
    for s in scene.glob("source.*"):
        s.unlink()


def oneshot(cli: list[str], photos: list[tuple[str, Path]], out: Path, repeat: int) -> list[Row]:
    rows: list[Row] = []
    for i, (name, photo) in enumerate(photos):
        scene = out / name
        scene.mkdir(parents=True, exist_ok=True)
        t0 = time.monotonic()
        p = subprocess.run([*cli, "run", str(photo), "--out", str(scene)], cwd=REPO, env=env(), capture_output=True, text=True, check=False)
        wall = time.monotonic() - t0
        (out / f"{name}.stderr.txt").write_text(p.stderr)
        lines = p.stdout.strip().splitlines()
        res: object = json.loads(lines[-1]) if lines else None
        clean(scene)
        rows.append(row("oneshot", repeat, i, name, wall, res, scene))
        print(f"  oneshot {name}: {wall:.2f} s", file=sys.stderr, flush=True)
    return rows


def worker(cli: list[str], photos: list[tuple[str, Path]], out: Path, repeat: int) -> list[Row]:
    rows: list[Row] = []
    out.mkdir(parents=True, exist_ok=True)
    with (out / "worker.stderr.txt").open("w") as log:
        t_spawn = time.monotonic()
        proc = subprocess.Popen([*cli, "serve"], cwd=REPO, env=env(), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=log,
                                text=True, bufsize=1)
        stdin: IO[str] | None = proc.stdin
        stdout: IO[str] | None = proc.stdout
        assert stdin is not None and stdout is not None
        try:
            for i, (name, photo) in enumerate(photos):
                scene = out / name
                scene.mkdir(parents=True, exist_ok=True)
                t0 = t_spawn if i == 0 else time.monotonic()
                stdin.write(json.dumps({"id": name, "cmd": "run", "args": [str(photo), "--out", str(scene)]}) + "\n")
                stdin.flush()
                line = stdout.readline()
                wall = time.monotonic() - t0
                res: object = json.loads(line) if line.strip() else None
                if not isinstance(res, dict) or res.get("id") != name:  # type: ignore[union-attr]
                    raise SystemExit(f"bench: the worker answered {line!r} to request {name}")
                clean(scene)
                rows.append(row("worker", repeat, i, name, wall, res, scene))
                print(f"  worker {name}: {wall:.2f} s", file=sys.stderr, flush=True)
        finally:
            stdin.close()
            code = proc.wait(timeout=60)
            if code != 0:
                print(f"bench: the worker exited with {code}", file=sys.stderr)
    return rows


def median(xs: list[float]) -> float | None:
    return float(np.median(xs)) if xs else None


def table(rows: list[Row]) -> str:
    """Median wall time per mode: the first calibration and the rest, per photo and overall."""
    lines = ["| mode | first (s) | subsequent, median (s) | subsequent, per photo (s) | failures |", "|---|---|---|---|---|"]
    for mode in ("oneshot", "worker"):
        mine = [r for r in rows if r["mode"] == mode]
        if not mine:
            continue
        first = [r["wall_s"] for r in mine if r["index"] == 0]
        rest = [r for r in mine if r["index"] > 0]
        per = {n: median([r["wall_s"] for r in rest if r["name"] == n]) for n in dict.fromkeys(r["name"] for r in rest)}
        fails = sum(not r["ok"] for r in mine)
        m = median([r["wall_s"] for r in rest])
        lines.append(f"| {mode} | {median(first) or 0:.2f} | {m or 0:.2f} | "
                     + ", ".join(f"{n} {v:.2f}" for n, v in per.items() if v is not None) + f" | {fails} |")
    return "\n".join(lines)


# --- comparing two runs ----------------------------------------------------------------------------------------------
def _load(p: Path) -> object:
    return json.loads(p.read_text()) if p.is_file() else None


def _angle(a: list[float], b: list[float]) -> float:
    va, vb = np.asarray(a, float), np.asarray(b, float)
    c = float(va @ vb / (np.linalg.norm(va) * np.linalg.norm(vb)))
    return math.degrees(math.acos(max(-1.0, min(1.0, c))))


def compare(a: Path, b: Path) -> int:
    names = sorted(p.name for p in a.iterdir() if (p / "calib.json").is_file() and (b / p.name / "calib.json").is_file())
    worst = 0.0
    for n in names:
        ca, cb = _load(a / n / "calib.json"), _load(b / n / "calib.json")
        assert isinstance(ca, dict) and isinstance(cb, dict)
        cam_a, cam_b = ca["camera"], cb["camera"]  # type: ignore[index]
        dcam = {k: round(float(cam_b[k]) - float(cam_a[k]), 4) for k in cam_a}  # type: ignore[union-attr]
        da = np.asarray(Image.open(a / n / "depth.png")).astype(np.int64) if (a / n / "depth.png").is_file() else None
        db = np.asarray(Image.open(b / n / "depth.png")).astype(np.int64) if (b / n / "depth.png").is_file() else None
        if da is not None and db is not None and da.shape == db.shape:
            diff = np.abs(da - db)
            dep = f"depth max |d| {int(diff.max())} mm, {100 * float((diff > 0).mean()):.3f} % px differ, zero-mask flips {int(((da == 0) != (db == 0)).sum())}"
            worst = max(worst, float(diff.max()))
        else:
            dep = "depth: missing or different sizes"
        la, lb = _load(a / n / "lighting.json"), _load(b / n / "lighting.json")
        if isinstance(la, dict) and isinstance(lb, dict):
            ka, kb = la["key"], lb["key"]  # type: ignore[index]
            ang = _angle(ka["direction"], kb["direction"])  # type: ignore[index]
            sha, shb = np.asarray(la["ambient"]["sh"], float), np.asarray(lb["ambient"]["sh"], float)  # type: ignore[index]
            lit = (f"key {ang:.3f} deg apart, intensity {ka['intensity']} vs {kb['intensity']}, cct {la['white_balance']['cct_k']} vs "  # type: ignore[index]
                   f"{lb['white_balance']['cct_k']}, sh max |d| {float(np.abs(sha - shb).max()):.2e}")  # type: ignore[index]
        else:
            lit = "lighting: missing in one"
        same = ca.get("floor") == cb.get("floor")  # type: ignore[union-attr]
        print(f"{n}: camera d {dcam}; floor {'same' if same else 'differs'}; {dep}; {lit}")
    print(f"compared {len(names)} scenes; worst depth difference {worst:.0f} mm")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=["oneshot", "worker", "both"], default="both")
    ap.add_argument("--label", default=time.strftime("%Y%m%d-%H%M%S"))
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--cli", default=DEFAULT_CLI)
    ap.add_argument("--photos", type=Path, nargs="*")
    ap.add_argument("--compare", type=Path, nargs=2)
    args = ap.parse_args()
    if args.compare:
        return compare(args.compare[0], args.compare[1])
    photos = [(p.stem, p.resolve()) for p in args.photos] if args.photos else default_photos()
    if any("private" in p.parts for _, p in photos):
        raise SystemExit("bench: never fixtures/photos/private/")
    cli = shlex.split(args.cli)
    base = OUT / args.label
    rows: list[Row] = []
    load = os.getloadavg()
    for rep in range(args.repeat):
        if args.mode in ("oneshot", "both"):
            rows += oneshot(cli, photos, base / f"oneshot-{rep}" if args.repeat > 1 else base / "oneshot", rep)
        if args.mode in ("worker", "both"):
            rows += worker(cli, photos, base / f"worker-{rep}" if args.repeat > 1 else base / "worker", rep)
    summary = {"label": args.label, "cli": args.cli, "photos": [n for n, _ in photos], "repeat": args.repeat,
               "load_before": [round(x, 2) for x in load], "load_after": [round(x, 2) for x in os.getloadavg()], "rows": rows}
    base.mkdir(parents=True, exist_ok=True)
    (base / "bench.json").write_text(json.dumps(summary, indent=2) + "\n")
    print(table(rows))
    print(f"load average before {summary['load_before']}, after {summary['load_after']}; rows in {base / 'bench.json'}")
    return 0 if all(r["ok"] for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
