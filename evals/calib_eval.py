"""E2 eval:calib — midstudy-calib against the golden scenes and the real photos (PLAN.md §6.2, contract §4.3).

Written from the spec only (it never reads calib/ source). Run through evals/py (numpy, Pillow, jsonschema):

    evals/py evals/calib_eval.py                 real MoGe on this Mac: golden scenes vs truth.json, the real photos
    evals/py evals/calib_eval.py --mock          ingest only (no MoGe): HEIC, EXIF-rotated portrait, PNG, WebP,
                                                 Display P3, the 25 MB limit, a non-image, EXIF FOV, metadata, the
                                                 MIDSTUDY_CALIB_MOCK lookup and the file rules
    evals/py evals/calib_eval.py --self-test     the comparator and checks themselves, against fixtures (no CLI)
    options: --cli "CMD" (default "uv run --project calib midstudy-calib"; e.g. "python3 fixtures/stub_calib.py"),
             --calib-mock DIR (real mode: set MIDSTUDY_CALIB_MOCK, to exercise the harness without MoGe),
             --only living-wide,portrait (golden subset), --no-real-photos

Tolerances (§6.2): fov within 5°, height within 10 %, pitch within 3°, roll within 2°; depth.png median relative error
≤ 10 % on non-floor pixels (truth depth > 0); upper-lounge-camera.jpeg's FOV within 8° of its EXIF estimate.
Real photos come only from the three files named in fixtures/photos/notes.md; fixtures/photos/private/ is never opened.
Their scene folders under evals/out/calib/ lose source.* at the end (the camera original keeps EXIF).
Prints one PASS/FAIL line per check with the measured value; exits 1 on any FAIL.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shlex
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms

REPO = Path(__file__).resolve().parents[1]
OUT = REPO / "evals/out/calib"
GOLDEN = ["living-wide", "steep-roll", "portrait"]
REAL_PHOTOS = ["upper-lounge-camera.jpeg", "upper-lounge.jpg", "upper-lounge-empty-ai.png"]  # fixtures/photos/notes.md
DEFAULT_CLI = "uv run --project calib midstudy-calib"
DEFAULT_CAMERA = {"fov_y_deg": 55.0, "height_m": 1.40, "pitch_deg": -10.0, "roll_deg": 0.0}
TOL = {"fov_y_deg": 5.0, "height_rel": 0.10, "pitch_deg": 3.0, "roll_deg": 2.0, "depth_rel": 0.10, "exif_fov": 8.0, "depth_shape_rel": 0.03}
P3_ICC = Path("/System/Library/ColorSync/Profiles/Display P3.icc")
ALLOWED_FILES = {"source.jpg", "source.png", "source.heic", "source.webp", "photo.jpg", "calib.json", "depth.png"}

results: list[dict] = []
t_start = time.monotonic()


def check(name: str, ok, measured="") -> bool:
    n = f"E2.{len(results) + 1:02d}"
    m = measured if isinstance(measured, str) else json.dumps(measured, default=str)
    m = m if len(m) <= 600 else m[:600] + "…"
    results.append({"n": n, "name": name, "ok": bool(ok), "measured": m})
    print(f"{'PASS' if ok else 'FAIL'} {n} {name} — {m or '(no value)'}", flush=True)
    return bool(ok)


def skip(name: str, why: str) -> None:
    print(f"SKIP E2.-- {name} — {why}", flush=True)


def info(msg: str) -> None:
    print(f"     {msg}", flush=True)


# --- the CLI ---------------------------------------------------------------------------------------------------------
class Cli:
    def __init__(self, cmd: str, env_extra: dict | None = None):
        self.argv = shlex.split(cmd)
        self.cmd = cmd
        self.env = {k: v for k, v in os.environ.items() if k not in ("VIRTUAL_ENV", "MIDSTUDY_CALIB_MOCK", "PYTHONHOME", "PYTHONPATH")}
        self.env.update(env_extra or {})
        self.missing = None
        if cmd == DEFAULT_CLI and not (REPO / "calib/pyproject.toml").is_file():
            self.missing = "calib/ missing: midstudy-calib isn't built yet (no calib/pyproject.toml)"

    def __call__(self, args: list[str], mock: str | None = None, timeout: int = 900) -> dict:
        if self.missing:
            return {"code": None, "json": None, "stdout": "", "stderr": self.missing, "elapsed": 0.0, "error": self.missing}
        env = dict(self.env)
        if mock:
            env["MIDSTUDY_CALIB_MOCK"] = mock
        t0 = time.monotonic()
        try:
            p = subprocess.run(self.argv + [str(a) for a in args], cwd=REPO, env=env, capture_output=True, text=True, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"code": None, "json": None, "stdout": "", "stderr": f"timed out after {timeout} s", "elapsed": timeout, "error": f"timed out after {timeout} s"}
        except OSError as e:
            return {"code": None, "json": None, "stdout": "", "stderr": str(e), "elapsed": 0.0, "error": str(e)}
        lines = [ln for ln in p.stdout.strip().splitlines() if ln.strip()]
        js = None
        if lines:
            try:
                js = json.loads(lines[-1])
            except json.JSONDecodeError:
                js = None
        err_lines = [ln for ln in p.stderr.strip().splitlines() if ln.strip()]
        return {"code": p.returncode, "json": js, "stdout": p.stdout, "stderr": p.stderr, "stderr_last": err_lines[-1] if err_lines else "",
                "elapsed": time.monotonic() - t0, "error": None if p.returncode == 0 else (js or {}).get("error") or (err_lines[-1] if err_lines else f"exit {p.returncode}")}


def brief(r: dict) -> str:
    if r.get("code") is None:
        return r.get("error") or "not run"
    return f"exit {r['code']} in {r['elapsed']:.1f} s" + (f": {r['error']}" if r["code"] != 0 else "")


# --- measurements ----------------------------------------------------------------------------------------------------
def jpeg_markers(data: bytes) -> list[str]:
    """Names of the segments before the image data (SOS)."""
    if data[:2] != b"\xff\xd8":
        return ["not a JPEG"]
    out, i = [], 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            return out + ["corrupt"]
        m = data[i + 1]
        if m == 0xFF:
            i += 1
            continue
        if m == 0xDA:
            return out
        n = struct.unpack(">H", data[i + 2:i + 4])[0]
        p = data[i + 4:i + 2 + n]
        if m == 0xE0:
            out.append("APP0:" + ("JFIF" if p.startswith(b"JFIF") else "JFXX" if p.startswith(b"JFXX") else "other"))
        elif 0xE1 <= m <= 0xEF:
            tag = "Exif" if p.startswith(b"Exif") else "XMP" if p.startswith(b"http://ns.adobe.com") else "ICC" if p.startswith(b"ICC_PROFILE") else ""
            out.append(f"APP{m - 0xE0}{':' + tag if tag else ''}")
        elif m == 0xFE:
            out.append("COM")
        else:
            out.append(f"{m:02X}")
        i += 2 + n
    return out + ["truncated"]


def metadata_in(path: Path) -> list[str]:
    """Every kind of metadata a photo.jpg must not carry (contract §4.3): EXIF, GPS, XMP, ICC, IPTC, comments."""
    data = path.read_bytes()
    found = [m for m in jpeg_markers(data) if m.startswith("APP") and m != "APP0:JFIF" or m == "COM"]
    with Image.open(path) as im:
        for k in ("exif", "icc_profile", "xmp", "XML:com.adobe.xmp", "comment", "photoshop"):
            if im.info.get(k):
                found.append(f"info:{k}")
        if len(im.getexif()):
            found.append("getexif")
    return sorted(set(found))


def fov_from_35mm(f35: float, w: int, h: int) -> float:
    """Contract §4.3: the 35 mm equivalent refers to the native 4:3 frame's diagonal (43.27 mm → 34.61 × 25.96 mm);
    the photo is the largest crop of that frame with its own aspect (wider than 4:3 keeps the long side, squarer keeps
    the short side); vertical FOV from the crop's extent along the photo's vertical axis."""
    diag = math.hypot(36, 24)
    long43, short43 = diag * 4 / 5, diag * 3 / 5
    lp, sp = max(w, h), min(w, h)
    if lp / sp >= 4 / 3:
        long_mm, short_mm = long43, long43 * sp / lp
    else:
        short_mm, long_mm = short43, short43 * lp / sp
    v_mm = short_mm if h <= w else long_mm
    return math.degrees(2 * math.atan(v_mm / (2 * f35)))


def hfov_from_vfov(vfov: float, w: int, h: int) -> float:
    return math.degrees(2 * math.atan(math.tan(math.radians(vfov) / 2) * w / h))


def compare_camera(cam: dict, truth: dict) -> dict:
    return {"fov": abs(cam["fov_y_deg"] - truth["fov_y_deg"]), "height_rel": abs(cam["height_m"] - truth["height_m"]) / truth["height_m"],
            "pitch": abs(cam["pitch_deg"] - truth["pitch_deg"]), "roll": abs(cam["roll_deg"] - truth["roll_deg"])}


def depth_error(pred_png: Path, truth_png: Path) -> dict:
    """Median relative error of the predicted depth on the truth's non-floor pixels (truth > 0). The prediction is
    looked up at the truth pixel centers (nearest; §4.2: depth pixels sample the same projection at a smaller size).
    A 0 in the prediction where the truth has an occluder counts as a 100 % error."""
    T = np.asarray(Image.open(truth_png)).astype(np.float64)
    with Image.open(pred_png) as im:
        mode, size = im.mode, im.size
        P = np.asarray(im).astype(np.float64)
    th, tw = T.shape
    ph, pw = P.shape[:2]
    if P.ndim == 3:
        P = P[..., 0]
    iy = np.minimum(((np.arange(th) + 0.5) * ph / th).astype(int), ph - 1)
    ix = np.minimum(((np.arange(tw) + 0.5) * pw / tw).astype(int), pw - 1)
    Pt = P[np.ix_(iy, ix)]
    sel = T > 0
    rel = np.abs(Pt[sel] - T[sel]) / T[sel]
    rel[Pt[sel] == 0] = 1.0
    floor_sel = T == 0
    # The same after one global scale (the median of predicted / true over occluders the prediction kept): the depth
    # map's shape with the metric scale factored out. Beyond PLAN.md §6.2, as a regression guard on the shape.
    both = sel & (Pt > 0)
    scale = float(np.median(Pt[both] / T[both])) if both.any() else None
    rel_s = np.abs(Pt[sel] / scale - T[sel]) / T[sel] if scale else None
    if rel_s is not None:
        rel_s[Pt[sel] == 0] = 1.0
    return {"median_rel": float(np.median(rel)) if rel.size else None, "p90_rel": float(np.percentile(rel, 90)) if rel.size else None,
            "scale": scale, "median_rel_scaled": float(np.median(rel_s)) if rel_s is not None and rel_s.size else None,
            "zero_on_occluders": float((Pt[sel] == 0).mean()) if rel.size else None, "zero_on_truth_floor": float((Pt[floor_sel] == 0).mean()) if floor_sel.any() else None,
            "mode": mode, "size": list(size)}


def validate(obj, schema_name: str) -> list[str]:
    try:
        import jsonschema
    except ImportError:
        return ["jsonschema not available"]
    schema = json.loads((REPO / "contract" / schema_name).read_text())
    v = jsonschema.Draft202012Validator(schema)
    return [f"{'/'.join(map(str, e.path)) or '(root)'}: {e.message}" for e in v.iter_errors(obj)][:5]


def mean_abs(a: np.ndarray, b: np.ndarray) -> float:
    return float(np.abs(a.astype(np.float64) - b.astype(np.float64)).mean())


# --- real mode -------------------------------------------------------------------------------------------------------
def check_calib_files(tag: str, scene_dir: Path, r: dict, photo_size_expected: tuple[int, int] | None = None) -> dict | None:
    js = r.get("json") or {}
    check(f"{tag}: exits 0 with ok: true as the last stdout line", r.get("code") == 0 and js.get("ok") is True, brief(r))
    cpath = scene_dir / "calib.json"
    if not cpath.is_file():
        check(f"{tag}: calib.json written and valid (calib.schema.json)", False, "no calib.json")
        return None
    calib = json.loads(cpath.read_text())
    errs = validate(calib, "calib.schema.json")
    check(f"{tag}: calib.json written and valid (calib.schema.json)", not errs and "ok" not in calib, errs or ("has an ok key" if "ok" in calib else "valid"))
    stdout_calib = {k: v for k, v in js.items() if k != "ok"}
    check(f"{tag}: the stdout line is calib.json plus ok", stdout_calib.get("camera") == calib.get("camera") and stdout_calib.get("source") == calib.get("source"),
          f"stdout camera {stdout_calib.get('camera')} file {calib.get('camera')}")
    photo = scene_dir / "photo.jpg"
    if photo.is_file():
        with Image.open(photo) as im:
            size = im.size
        check(f"{tag}: calib.json image is photo.jpg's size", calib.get("image") == {"w": size[0], "h": size[1]}, f"image {calib.get('image')} photo {size}")
    return calib


def run_real(cli: Cli, args) -> None:
    mock = args.calib_mock
    ids = [s for s in (args.only.split(",") if args.only else GOLDEN)]
    for sid in ids:
        sdir = REPO / "fixtures/scenes" / sid
        truth = json.loads((sdir / "truth.json").read_text())
        out = OUT / "golden" / sid
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        r = cli(["run", sdir / "photo.jpg", "--out", out], mock=mock)
        info(f"{sid}: midstudy-calib run took {r['elapsed']:.1f} s ({brief(r)})")
        calib = check_calib_files(f"{sid}", out, r)
        if not calib:
            for name in ("fov within 5°", "height within 10 %", "pitch within 3°", "roll within 2°", "depth.png median error ≤ 10 % on non-floor pixels"):
                check(f"{sid}: {name}", False, r.get("error") or "no calib.json")
            continue
        if not mock:
            check(f"{sid}: MoGe-2 fitted it (source moge-2, floor found)", calib.get("source") == "moge-2" and calib.get("floor", {}).get("found") is True,
                  f"source {calib.get('source')} floor {calib.get('floor')} device {calib.get('device')} elapsed_s {calib.get('elapsed_s')}")
        d = compare_camera(calib["camera"], truth["camera"])
        cam_s = f"got {calib['camera']} truth {truth['camera']}"
        check(f"{sid}: fov within 5°", d["fov"] <= TOL["fov_y_deg"], f"|Δfov| {d['fov']:.2f}° ({cam_s})")
        check(f"{sid}: height within 10 %", d["height_rel"] <= TOL["height_rel"], f"|Δh| {100 * d['height_rel']:.1f} %")
        check(f"{sid}: pitch within 3°", d["pitch"] <= TOL["pitch_deg"], f"|Δpitch| {d['pitch']:.2f}°")
        check(f"{sid}: roll within 2°", d["roll"] <= TOL["roll_deg"], f"|Δroll| {d['roll']:.2f}°")
        dp = out / "depth.png"
        if not dp.is_file():
            check(f"{sid}: depth.png written (16-bit, long side ≤ 1024, photo's aspect)", False, f"no depth.png; calib.depth {calib.get('depth')}")
            check(f"{sid}: depth.png median error ≤ 10 % on non-floor pixels", False, "no depth.png")
            continue
        with Image.open(dp) as im:
            mode, (w, h) = im.mode, im.size
        aspect_ok = abs(w / h - truth["image"]["w"] / truth["image"]["h"]) <= 1.5 / min(w, h)
        check(f"{sid}: depth.png written (16-bit, long side ≤ 1024, photo's aspect)", mode in ("I;16", "I;16B", "I") and max(w, h) <= 1024 and aspect_ok
              and calib.get("depth", {}) and calib["depth"].get("w") == w and calib["depth"].get("h") == h, f"mode {mode} {w}×{h} calib.depth {calib.get('depth')}")
        e = depth_error(dp, sdir / "depth.png")
        check(f"{sid}: depth.png median error ≤ 10 % on non-floor pixels", e["median_rel"] is not None and e["median_rel"] <= TOL["depth_rel"],
              f"median {100 * (e['median_rel'] or 0):.1f} % (p90 {100 * (e['p90_rel'] or 0):.1f} %, zero on occluders {100 * (e['zero_on_occluders'] or 0):.1f} %, zero on the truth's floor {100 * (e['zero_on_truth_floor'] or 0):.1f} %)")
        # Not in PLAN.md §6.2: MoGe-2's metric scale on these CG renders is off by 8–19 % (docs/notes/integrate.md), so
        # this separates a scale bias from a broken depth map. It doesn't replace the 10 % check above.
        check(f"{sid}: depth.png shape: median error ≤ 3 % after one global scale (extra, not a PLAN tolerance)",
              e["median_rel_scaled"] is not None and e["median_rel_scaled"] <= TOL["depth_shape_rel"],
              f"median {100 * (e['median_rel_scaled'] or 0):.1f} % after scaling by 1/{e['scale'] or 0:.3f}")

    if args.no_real_photos:
        skip("real photos", "--no-real-photos")
        return
    cams = {}
    for name in REAL_PHOTOS:
        src = REPO / "fixtures/photos" / name
        if not src.is_file():
            skip(f"real photo {name}", "not present (fixtures/photos/ is local only)")
            continue
        out = OUT / "real" / Path(name).stem
        shutil.rmtree(out, ignore_errors=True)
        out.mkdir(parents=True)
        r = cli(["run", src, "--out", out], mock=mock)
        info(f"{name}: midstudy-calib run took {r['elapsed']:.1f} s ({brief(r)})")
        calib = check_calib_files(name, out, r)
        if calib:
            fl = calib.get("floor", {})
            check(f"{name}: floor.found reported, runtime logged", isinstance(fl.get("found"), bool) and isinstance(calib.get("elapsed_s"), (int, float)),
                  f"floor {fl}, elapsed_s {calib.get('elapsed_s')}, wall {r['elapsed']:.1f} s, source {calib.get('source')}, device {calib.get('device')}, camera {calib.get('camera')}")
            cams[name] = calib
        photo = out / "photo.jpg"
        if photo.is_file():
            meta = metadata_in(photo)
            with Image.open(photo) as im:
                pw, ph = im.size
            check(f"{name}: photo.jpg carries no metadata", not meta, meta or "JFIF only")
            with Image.open(src) as im:
                sw, sh = im.size
            exp_long = min(2048, max(sw, sh))
            check(f"{name}: photo.jpg long side ≤ 2048 (downsized to 2048 when larger)", max(pw, ph) == exp_long, f"{pw}×{ph} from {sw}×{sh}")
        else:
            check(f"{name}: photo.jpg carries no metadata", False, "no photo.jpg")
        if name == "upper-lounge-camera.jpeg" and calib:
            with Image.open(src) as im:
                ex = im.getexif().get_ifd(0x8769)
                f35 = ex.get(0xA405)
            if photo.is_file() and f35:
                with Image.open(photo) as im:
                    pw, ph = im.size
                exif_fov = fov_from_35mm(float(f35), pw, ph)
                got = calib["camera"]["fov_y_deg"]
                check(f"{name}: FOV within 8° of its EXIF estimate", abs(got - exif_fov) <= TOL["exif_fov"],
                      f"fov_y {got:.1f}° vs EXIF {exif_fov:.1f}° ({f35} mm equiv.; horizontal {hfov_from_vfov(got, pw, ph):.1f}° vs {hfov_from_vfov(exif_fov, pw, ph):.1f}°)")
                ce = calib.get("exif") or {}
                check(f"{name}: calib.json records the EXIF facts (focal_35mm, its fov_y_deg)", ce.get("focal_35mm") == f35 and abs((ce.get("fov_y_deg") or 0) - exif_fov) <= 0.5,
                      f"exif {ce}, expected focal {f35} fov {exif_fov:.2f}")
                disagree = abs(got - exif_fov) > 8
                if calib.get("source") == "moge-2":
                    check(f"{name}: fov_disagreement present only when MoGe and EXIF differ by more than 8°", ("fov_disagreement" in calib) == disagree,
                          f"diff {abs(got - exif_fov):.1f}°, fov_disagreement {calib.get('fov_disagreement')}")
            else:
                check(f"{name}: FOV within 8° of its EXIF estimate", False, f"focal_35mm {f35}, photo.jpg {'present' if photo.is_file() else 'missing'}")
    if len(cams) >= 2:
        info("real photos, camera found: " + "; ".join(f"{k}: {v.get('camera')} floor {v.get('floor', {}).get('found')}" for k, v in cams.items()))
    # the camera original keeps its EXIF in source.<ext>: don't leave copies of the user's photos lying around
    for d in (OUT / "real").glob("*"):
        for s in d.glob("source.*"):
            s.unlink()


# --- mock mode (ingest, mocked fit) ----------------------------------------------------------------------------------
def make_inputs(d: Path) -> dict:
    d.mkdir(parents=True, exist_ok=True)
    rng = np.random.default_rng(7)
    paths = {}

    def pattern(w, h):
        """Four coloured quadrants and a gradient, so orientation and colour mistakes are visible."""
        a = np.zeros((h, w, 3), np.uint8)
        a[: h // 2, : w // 2] = (220, 40, 40)
        a[: h // 2, w // 2:] = (40, 200, 40)
        a[h // 2:, : w // 2] = (40, 60, 220)
        a[h // 2:, w // 2:] = (230, 220, 60)
        a[..., :] = (a * 0.8 + np.linspace(0, 50, w)[None, :, None]).clip(0, 255).astype(np.uint8)
        return Image.fromarray(a)

    def exif(orientation=None, f35=None, gps=False, make="EvalCam", model="Eval Phone 1"):
        e = Image.Exif()
        if orientation:
            e[0x0112] = orientation
        e[0x010F], e[0x0110] = make, model
        if f35:
            e.get_ifd(0x8769)[0xA405] = f35
        if gps:  # synthetic coordinates, not anyone's location
            g = e.get_ifd(0x8825)
            g[1], g[2], g[3], g[4] = "N", (0.0, 0.0, 1.0), "E", (0.0, 0.0, 1.0)
        return e

    # stored 1200 × 900 landscape, EXIF orientation 6: shown as a 900 × 1200 portrait
    pattern(1200, 900).save(d / "rotated.jpg", quality=95, exif=exif(orientation=6))
    paths["rotated"] = d / "rotated.jpg"
    # large 4:3 with EXIF (f35 26), GPS, XMP and a comment
    pattern(4032, 3024).save(d / "large.jpg", quality=90, exif=exif(f35=26, gps=True), xmp=b'<x:xmpmeta xmlns:x="adobe:ns:meta/"/>', comment=b"eval comment")
    paths["large"] = d / "large.jpg"
    pattern(1920, 1080).save(d / "wide.jpg", quality=90, exif=exif(f35=14))
    paths["wide"] = d / "wide.jpg"
    pattern(1500, 2000).save(d / "tall.jpg", quality=90, exif=exif(f35=26))
    paths["tall"] = d / "tall.jpg"
    rgba = pattern(1000, 750).convert("RGBA")
    rgba.putalpha(200)
    rgba.save(d / "photo.png")
    paths["png"] = d / "photo.png"
    pattern(1200, 800).save(d / "photo.webp", quality=90)
    paths["webp"] = d / "photo.webp"
    pattern(1600, 1200).save(d / "for-heic.jpg", quality=92)
    heic = d / "photo.heic"
    try:
        subprocess.run(["sips", "-s", "format", "heic", str(d / "for-heic.jpg"), "--out", str(heic)], check=True, capture_output=True, timeout=60)
        paths["heic"] = heic
    except (OSError, subprocess.SubprocessError):
        paths["heic"] = None
    if P3_ICC.is_file():
        p3 = np.zeros((600, 800, 3), np.uint8)
        for k, c in enumerate([(230, 40, 30), (30, 200, 60), (40, 70, 230), (240, 180, 20), (180, 60, 200), (128, 128, 128)]):
            p3[(k // 3) * 300:(k // 3 + 1) * 300, (k % 3) * 267:(k % 3 + 1) * 267] = c
        Image.fromarray(p3).save(d / "p3.jpg", quality=95, icc_profile=P3_ICC.read_bytes())
        paths["p3"] = d / "p3.jpg"
    else:
        paths["p3"] = None
    noise = rng.integers(0, 256, (3000, 3200, 3), dtype=np.uint8)
    Image.fromarray(noise).save(d / "oversize.png", compress_level=1)
    paths["oversize"] = d / "oversize.png"
    (d / "not-an-image.jpg").write_text("this is a text file, not a photo\n" * 20)
    paths["text"] = d / "not-an-image.jpg"
    b = bytearray((REPO / "fixtures/scenes/living-wide/photo.jpg").read_bytes())
    struct.pack_into(">HH", b, 14, 72, 72)  # JFIF density: same pixels, a SHA the mock doesn't know
    (d / "unknown.jpg").write_bytes(bytes(b))
    paths["unknown"] = d / "unknown.jpg"
    return paths


def scene_dir(name: str) -> Path:
    p = OUT / "mock" / name
    shutil.rmtree(p, ignore_errors=True)
    return p


def check_ingest(cli: Cli, tag: str, src: Path, ext: str, expect_size: tuple[int, int], expected_pixels=None, pix_tol=6.0, extra=None):
    out = scene_dir(tag)
    r = cli(["ingest", src, "--out", out])
    js = r.get("json") or {}
    ok_json = r.get("code") == 0 and js.get("ok") is True and js.get("photo") == "photo.jpg" and js.get("source") == f"source.{ext}" and js.get("image") == {"w": expect_size[0], "h": expect_size[1]}
    check(f"ingest {tag}: exit 0 with {{ok, photo, source: source.{ext}, image}}", ok_json, f"{brief(r)} {json.dumps(js)[:200]}")
    photo = out / "photo.jpg"
    if not photo.is_file():
        check(f"ingest {tag}: photo.jpg is a {expect_size[0]}×{expect_size[1]} JPEG without metadata", False, "no photo.jpg")
        return out, None
    with Image.open(photo) as im:
        fmt_, size, mode = im.format, im.size, im.mode
    meta = metadata_in(photo)
    check(f"ingest {tag}: photo.jpg is a {expect_size[0]}×{expect_size[1]} JPEG without metadata", fmt_ == "JPEG" and size == expect_size and not meta and mode == "RGB",
          f"{fmt_} {size[0]}×{size[1]} {mode}, metadata {meta or 'none'}")
    srcf = out / f"source.{ext}"
    check(f"ingest {tag}: source.{ext} keeps the upload byte for byte", srcf.is_file() and srcf.read_bytes() == src.read_bytes(),
          f"{'same bytes' if srcf.is_file() and srcf.read_bytes() == src.read_bytes() else 'missing or different'}; files {sorted(p.name for p in out.iterdir())}")
    got = None
    if expected_pixels is not None:
        got = np.asarray(Image.open(photo).convert("RGB"))
        exp = np.asarray(expected_pixels.convert("RGB").resize(size, Image.BILINEAR)) if expected_pixels.size != size else np.asarray(expected_pixels.convert("RGB"))
        diff = mean_abs(got, exp)
        check(f"ingest {tag}: photo.jpg shows the upload as displayed{extra or ''}", diff <= pix_tol, f"mean |Δ| {diff:.2f} levels vs the expected image")
    return out, got


def run_mock(cli: Cli, args) -> None:
    inputs = make_inputs(OUT / "inputs")
    living = REPO / "fixtures/scenes/living-wide"

    # pass-through (contract §4.3): a clean JFIF JPEG ≤ 2048 is copied byte for byte
    out = scene_dir("golden-pass-through")
    r = cli(["ingest", living / "photo.jpg", "--out", out])
    same = (out / "photo.jpg").is_file() and (out / "photo.jpg").read_bytes() == (living / "photo.jpg").read_bytes()
    check("ingest golden: a clean JPEG passes through byte for byte (photo.jpg SHA = upload SHA)", r.get("code") == 0 and same,
          f"{brief(r)}; {'identical' if same else 'differs or missing'}")
    check("ingest golden: writes only source.jpg and photo.jpg", out.is_dir() and sorted(p.name for p in out.iterdir()) == ["photo.jpg", "source.jpg"],
          sorted(p.name for p in out.iterdir()) if out.is_dir() else "no folder")

    # EXIF orientation 6: stored landscape, shown portrait
    with Image.open(inputs["rotated"]) as im:
        from PIL import ImageOps
        shown = ImageOps.exif_transpose(im).copy()
    check_ingest(cli, "rotated", inputs["rotated"], "jpg", (900, 1200), shown, extra=" (EXIF orientation applied)")
    # downsizing, and every metadata kind stripped (EXIF, GPS, XMP, comment)
    with Image.open(inputs["large"]) as im:
        large_exp = im.convert("RGB").resize((2048, 1536), Image.LANCZOS)
    out_large, _ = check_ingest(cli, "large", inputs["large"], "jpg", (2048, 1536), large_exp, extra=" (downsized to a 2048 px long side)")
    check_ingest(cli, "png", inputs["png"], "png", (1000, 750), None)
    with Image.open(inputs["webp"]) as im:
        webp_exp = im.convert("RGB")
    check_ingest(cli, "webp", inputs["webp"], "webp", (1200, 800), webp_exp, pix_tol=8)
    if inputs["heic"]:
        with Image.open(OUT / "inputs/for-heic.jpg") as im:
            heic_exp = im.convert("RGB")
        check_ingest(cli, "heic", inputs["heic"], "heic", (1600, 1200), heic_exp, pix_tol=10)
    else:
        skip("ingest heic", "sips couldn't make a HEIC file on this machine")
    if inputs["p3"]:
        with Image.open(inputs["p3"]) as im:
            p3img = im.convert("RGB")
            srgb = ImageCms.profileToProfile(p3img, ImageCms.ImageCmsProfile(str(P3_ICC)), ImageCms.createProfile("sRGB"), outputMode="RGB")
        out_p3, got = check_ingest(cli, "p3", inputs["p3"], "jpg", (800, 600), srgb, pix_tol=4, extra=" (Display P3 converted to sRGB)")
        if got is not None:
            check("ingest p3: the colours were converted, not just the profile dropped", mean_abs(got, np.asarray(srgb)) < mean_abs(got, np.asarray(p3img)),
                  f"mean |Δ| to the sRGB conversion {mean_abs(got, np.asarray(srgb)):.2f}, to the unconverted pixels {mean_abs(got, np.asarray(p3img)):.2f}")
    else:
        skip("ingest p3", f"{P3_ICC} not found")

    # refusals: over 25 MB, not an image (exit 1, the error contract, nothing written)
    for tag, src, want in (("oversize", inputs["oversize"], "25 MB"), ("text", inputs["text"], "isn't a JPEG, PNG, HEIC or WebP")):
        out = scene_dir(tag)
        r = cli(["ingest", src, "--out", out])
        js = r.get("json") or {}
        err = js.get("error") or ""
        info(f"{tag}: {src.stat().st_size / 2**20:.1f} MB")
        check(f"ingest {tag}: exit 1 with {{ok: false, error}} and 'midstudy-calib: <same sentence>' on stderr", r.get("code") == 1 and js.get("ok") is False and bool(err)
              and r.get("stderr_last", "") == f"midstudy-calib: {err}", f"{brief(r)}; stdout {json.dumps(js)[:160]}; stderr {r.get('stderr_last', '')[:160]}")
        check(f"ingest {tag}: the sentence says why ({want})", want.lower() in err.lower() or (tag == "oversize" and "25" in err), err[:200] or "(none)")
        check(f"ingest {tag}: nothing written", not (out / "photo.jpg").exists(), sorted(p.name for p in out.iterdir()) if out.is_dir() else "no folder")

    # EXIF FOV (contract §4.3) through run with the mock (no MoGe: the default fallback records the EXIF facts)
    mock = str(REPO / "fixtures/calib")
    for tag, src, f35, size in (("large", inputs["large"], 26, (2048, 1536)), ("wide", inputs["wide"], 14, (1920, 1080)), ("tall", inputs["tall"], 26, (1500, 2000))):
        out = scene_dir(f"fov-{tag}")
        r = cli(["run", src, "--out", out], mock=mock)
        c = r.get("json") or {}
        e = c.get("exif") or {}
        exp = fov_from_35mm(f35, *size)
        check(f"run {tag} ({size[0]}×{size[1]}, {f35} mm equiv.): exif.fov_y_deg = {exp:.2f}° (native 4:3 frame, then the crop)",
              e.get("focal_35mm") == f35 and abs((e.get("fov_y_deg") or -99) - exp) <= 0.3 and e.get("make") == "EvalCam" and e.get("model") == "Eval Phone 1",
              f"{brief(r)}; exif {e}")
    # fallback without a mock entry: default camera, no depth (contract §4.3)
    out = scene_dir("unknown")
    r = cli(["run", inputs["unknown"], "--out", out], mock=mock)
    c = r.get("json") or {}
    check("run with MIDSTUDY_CALIB_MOCK, unknown photo: the default fallback (exit 0, source default, camera 55/1.40/−10/0, depth null, no depth.png)",
          r.get("code") == 0 and c.get("source") == "default" and c.get("camera") == DEFAULT_CAMERA and c.get("depth") is None and not (out / "depth.png").exists()
          and c.get("floor", {}).get("found") is False, f"{brief(r)}; source {c.get('source')} camera {c.get('camera')} depth {c.get('depth')} floor {c.get('floor')}")
    errs = validate(json.loads((out / "calib.json").read_text()), "calib.schema.json") if (out / "calib.json").is_file() else ["no calib.json"]
    check("run unknown: calib.json valid", not errs, errs or "valid")
    # mock hit: the golden calibration and depth are copied (contract §4.3 Mock)
    for sid in GOLDEN:
        sdir = REPO / "fixtures/scenes" / sid
        out = scene_dir(f"mock-{sid}")
        out.mkdir(parents=True)
        (out / "scene.json").write_text('{"keep": "me"}')
        (out / "thumb.jpg").write_bytes(b"thumb")
        r = cli(["run", sdir / "photo.jpg", "--out", out], mock=mock)
        c = r.get("json") or {}
        truth = json.loads((sdir / "truth.json").read_text())
        depth_same = (out / "depth.png").is_file() and (out / "depth.png").read_bytes() == (sdir / "depth.png").read_bytes()
        check(f"run {sid} with MIDSTUDY_CALIB_MOCK: the golden calib.json and depth.png", r.get("code") == 0 and c.get("camera") == truth["camera"] and c.get("source") == "truth" and depth_same,
              f"{brief(r)}; camera {c.get('camera')} source {c.get('source')} depth {'identical' if depth_same else 'missing or different'}")
        names = sorted(p.name for p in out.iterdir())
        check(f"run {sid}: writes only source/photo/calib/depth, leaves scene.json and thumb.jpg alone, no temp files",
              set(names) - {"scene.json", "thumb.jpg"} <= ALLOWED_FILES and (out / "scene.json").read_text() == '{"keep": "me"}' and (out / "thumb.jpg").read_bytes() == b"thumb", names)
    # fit --no-depth removes a stale depth.png (contract §4.3 Files)
    out = OUT / "mock" / "mock-living-wide"
    r = cli(["fit", out, "--no-depth"], mock=mock)
    c = r.get("json") or {}
    check("fit --no-depth: depth null and the stale depth.png removed", r.get("code") == 0 and c.get("depth") is None and not (out / "depth.png").exists(),
          f"{brief(r)}; depth {c.get('depth')}; depth.png {'still there' if (out / 'depth.png').exists() else 'gone'}")

    # the real camera original (EXIF, Display P3, 5712 × 3213) with the mock: no MoGe, ingest for real
    src = REPO / "fixtures/photos/upper-lounge-camera.jpeg"
    if src.is_file() and not args.no_real_photos:
        out = scene_dir("upper-lounge-camera")
        r = cli(["run", src, "--out", out], mock=mock)
        c = r.get("json") or {}
        photo = out / "photo.jpg"
        size = Image.open(photo).size if photo.is_file() else None
        meta = metadata_in(photo) if photo.is_file() else ["no photo.jpg"]
        check("upper-lounge-camera.jpeg: photo.jpg 2048 px long side and free of any metadata", size is not None and max(size) == 2048 and not meta, f"{brief(r)}; size {size}; metadata {meta or 'none'}")
        e = c.get("exif") or {}
        exp = fov_from_35mm(14, *(size or (2048, 1152)))
        check(f"upper-lounge-camera.jpeg: EXIF FOV {exp:.1f}° vertical ({hfov_from_vfov(exp, 16, 9):.1f}° horizontal) from 14 mm equiv.",
              e.get("focal_35mm") == 14 and abs((e.get("fov_y_deg") or -99) - exp) <= 0.5, f"exif {e}")
        if photo.is_file() and P3_ICC.is_file():
            with Image.open(src) as im:
                icc = im.info.get("icc_profile")
                im.draft("RGB", (im.width // 4, im.height // 4))
                small = im.convert("RGB")
                conv = ImageCms.profileToProfile(small, ImageCms.ImageCmsProfile(__import__("io").BytesIO(icc)), ImageCms.createProfile("sRGB"), outputMode="RGB") if icc else small
            got = np.asarray(Image.open(photo).convert("RGB").resize((512, 288), Image.BILINEAR)).astype(float)
            exp_s = np.asarray(conv.resize((512, 288), Image.BILINEAR)).astype(float)
            raw = np.asarray(small.resize((512, 288), Image.BILINEAR)).astype(float)
            check("upper-lounge-camera.jpeg: photo.jpg is the sRGB conversion of its Display P3 pixels", icc is not None and np.abs(got - exp_s).mean() < np.abs(got - raw).mean() and np.abs(got - exp_s).mean() <= 4,
                  f"embedded ICC {'yes' if icc else 'no'}; mean |Δ| to sRGB {np.abs(got - exp_s).mean():.2f}, to unconverted {np.abs(got - raw).mean():.2f}")
        for s in out.glob("source.*"):
            s.unlink()  # keep no copy of the camera original
    else:
        skip("upper-lounge-camera.jpeg ingest", "not present or --no-real-photos")


# --- self-test -------------------------------------------------------------------------------------------------------
def run_self_test() -> None:
    for sid in GOLDEN:
        sdir = REPO / "fixtures/scenes" / sid
        truth = json.loads((sdir / "truth.json").read_text())
        calib = json.loads((sdir / "calib.json").read_text())
        d = compare_camera(calib["camera"], truth["camera"])
        check(f"self-test {sid}: the comparator accepts the truth camera", max(d["fov"], d["pitch"], d["roll"], d["height_rel"]) == 0, d)
        bad = dict(calib["camera"], fov_y_deg=calib["camera"]["fov_y_deg"] + 6)
        check(f"self-test {sid}: the comparator rejects fov + 6°", compare_camera(bad, truth["camera"])["fov"] > TOL["fov_y_deg"], compare_camera(bad, truth["camera"]))
        e = depth_error(sdir / "depth.png", sdir / "depth.png")
        check(f"self-test {sid}: depth error of the truth against itself is 0", e["median_rel"] == 0, e)
        scaled = OUT / "selftest" / f"{sid}-depth-x1.2.png"
        scaled.parent.mkdir(parents=True, exist_ok=True)
        T = np.asarray(Image.open(sdir / "depth.png")).astype(np.float64)
        Image.fromarray(np.clip(T * 1.2, 0, 65535).astype(np.uint16)).save(scaled)
        e2 = depth_error(scaled, sdir / "depth.png")
        check(f"self-test {sid}: a depth map 20 % too far fails the 10 % rule", e2["median_rel"] > TOL["depth_rel"], e2)
        check(f"self-test {sid}: …but passes the shape check after one global scale (scale 1.2)",
              e2["median_rel_scaled"] < 0.005 and abs(e2["scale"] - 1.2) < 0.01, {k: e2[k] for k in ("scale", "median_rel_scaled")})
        half = OUT / "selftest" / f"{sid}-depth-half.png"
        Image.fromarray(T.astype(np.uint16)).resize((T.shape[1] // 2, T.shape[0] // 2), Image.NEAREST).save(half)
        e3 = depth_error(half, sdir / "depth.png")
        check(f"self-test {sid}: a half-size depth map of the truth stays under 2 % (resampling)", e3["median_rel"] < 0.02, e3)
        errs = validate(calib, "calib.schema.json")
        check(f"self-test {sid}: the fixture calib.json validates", not errs, errs or "valid")
        meta = metadata_in(sdir / "photo.jpg")
        check(f"self-test {sid}: the metadata detector passes the clean golden photo", not meta, meta or "JFIF only")
    inputs = make_inputs(OUT / "selftest-inputs")
    meta = metadata_in(inputs["large"])
    check("self-test: the metadata detector finds EXIF, XMP and the comment in a tagged JPEG", {"APP1:Exif", "APP1:XMP", "COM"} <= set(meta), meta)
    if inputs["p3"]:
        check("self-test: the detector finds an ICC profile", any("ICC" in m for m in metadata_in(inputs["p3"])), metadata_in(inputs["p3"]))
    v = fov_from_35mm(14, 2048, 1152)
    check("self-test: 14 mm equiv. on 16:9 gives 69.6° vertical, 102.1° horizontal (contract §4.3)", abs(v - 69.6) < 0.05 and abs(hfov_from_vfov(v, 2048, 1152) - 102.1) < 0.1,
          f"{v:.2f}° / {hfov_from_vfov(v, 2048, 1152):.2f}°")
    check("self-test: 26 mm equiv. on 4:3 gives the full frame's 53.1° vertical", abs(fov_from_35mm(26, 4032, 3024) - 53.06) < 0.05, f"{fov_from_35mm(26, 4032, 3024):.2f}°")
    with Image.open(inputs["rotated"]) as im:
        check("self-test: the rotated input is stored landscape with orientation 6", im.size == (1200, 900) and im.getexif().get(0x0112) == 6, f"{im.size} orientation {im.getexif().get(0x0112)}")
    check("self-test: the oversize input is over 25 MB", inputs["oversize"].stat().st_size > 25 * 2**20, f"{inputs['oversize'].stat().st_size / 2**20:.1f} MiB")


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--mock", action="store_true", help="ingest only, no MoGe")
    ap.add_argument("--self-test", action="store_true", help="check the comparator against fixtures; no CLI")
    ap.add_argument("--cli", default=DEFAULT_CLI)
    ap.add_argument("--calib-mock", default=None, help="real mode: set MIDSTUDY_CALIB_MOCK to this dir (harness check)")
    ap.add_argument("--only", default=None)
    ap.add_argument("--no-real-photos", action="store_true")
    args = ap.parse_args(argv)
    if args.calib_mock:
        args.calib_mock = str((REPO / args.calib_mock).resolve())
    OUT.mkdir(parents=True, exist_ok=True)
    for sub in ("golden", "real", "mock", "inputs", "selftest", "selftest-inputs"):
        shutil.rmtree(OUT / sub, ignore_errors=True)
    mode = "self-test" if args.self_test else "mock (ingest, no MoGe)" if args.mock else "real MoGe" + (f" with MIDSTUDY_CALIB_MOCK={args.calib_mock}" if args.calib_mock else "")
    print(f"E2 eval:calib — {mode}; CLI: {args.cli if not args.self_test else '(none)'}", flush=True)
    if args.self_test:
        run_self_test()
    else:
        cli = Cli(args.cli)
        if cli.missing:
            check("midstudy-calib is available", False, cli.missing)
        if args.mock:
            run_mock(cli, args)
        else:
            run_real(cli, args)
    failed = [r for r in results if not r["ok"]]
    print(f"\nE2: {len(results) - len(failed)}/{len(results)} checks passed in {time.monotonic() - t_start:.1f} s" + (f" (failed: {' '.join(r['n'] for r in failed)})" if failed else ""))
    (OUT / "results.json").write_text(json.dumps({"mode": mode, "results": results}, indent=2))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
