"""`midstudy-calib fit` (contract §4.3): calib.json (+ depth.png) from a scene folder's photo.jpg."""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import time
from pathlib import Path

from .ingest import exif_block
from .util import DEFAULT_CAMERA, Fail, camera_block, log, source_file, write_atomic

DEPTH_LONG_SIDE = 1024
FOV_DISAGREE_DEG = 8.0
MIN_INLIER_RATIO = 0.02  # a "floor" covering less than 2 % of the photo isn't trusted


def _photo_size(photo: Path) -> tuple[int, int]:
    from PIL import Image

    try:
        with Image.open(photo) as im:
            return im.size
    except Exception:
        raise Fail(f"{photo.name} isn't a readable JPEG: run ingest again")


def depth_size(w: int, h: int) -> tuple[int, int]:
    """depth.png's size: photo.jpg's aspect, long side at most 1024."""
    s = min(1.0, DEPTH_LONG_SIDE / max(w, h))
    return max(1, round(w * s)), max(1, round(h * s))


def _base(w: int, h: int, exif: dict | None) -> dict:
    return {"version": 1, "source": "default", "model": None, "image": {"w": w, "h": h},
            "camera": dict(DEFAULT_CAMERA), "principal": [0.5, 0.5],
            "floor": {"found": False, "inlier_ratio": None, "rmse_m": None},
            "depth": None, "exif": exif, "device": None, "elapsed_s": 0}


def fallback(w: int, h: int, exif: dict | None, why: str) -> dict:
    """MoGe unavailable or failed: FOV from EXIF (source "exif") or 55 (source "default"), height 1.40, pitch -10."""
    calib = _base(w, h, exif)
    if exif and exif.get("fov_y_deg"):
        calib["source"] = "exif"
        calib["camera"] = camera_block(exif["fov_y_deg"], 1.40, -10.0, 0.0)
    calib["fallback_reason"] = why
    log(f"fallback ({calib['source']}): {why}")
    return calib


def _mock(scene: Path, mock_dir: Path, w: int, h: int, exif: dict | None, no_depth: bool) -> dict:
    """MIDSTUDY_CALIB_MOCK: copy <dir>/<sha256 of photo.jpg or source.<ext>>/{calib.json, depth.png}; never loads MoGe."""
    keys = [hashlib.sha256((scene / "photo.jpg").read_bytes()).hexdigest()]
    src = source_file(scene)
    if src:
        keys.append(hashlib.sha256(src.read_bytes()).hexdigest())
    for key in keys:
        d = mock_dir / key
        if (d / "calib.json").is_file():
            calib = json.loads((d / "calib.json").read_text())
            log(f"MIDSTUDY_CALIB_MOCK hit {d}")
            if (calib.get("image") or {}) != {"w": w, "h": h}:
                log(f"warning: the mock's image size {calib.get('image')} isn't photo.jpg's {w} x {h}")
            if calib.get("depth") and (d / "depth.png").is_file() and not no_depth:
                write_atomic(scene / "depth.png", (d / "depth.png").read_bytes())
            else:
                calib["depth"] = None
            return calib
    log(f"no mock for photo.jpg in {mock_dir}: writing the default fallback")
    calib = _base(w, h, exif)
    calib["fallback_reason"] = "MIDSTUDY_CALIB_MOCK has no calibration for this photo"
    return calib


def _png16(mm) -> bytes:
    import numpy as np
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(mm, dtype=np.uint16)).save(buf, "PNG", optimize=False)
    return buf.getvalue()


def _moge(scene: Path, w: int, h: int, exif: dict | None, model: str, device: str, no_depth: bool) -> dict:
    import numpy as np
    from PIL import Image

    from . import floor as fl
    from . import moge_runner

    dw, dh = depth_size(w, h)
    with Image.open(scene / "photo.jpg") as im:
        rgb = np.asarray(im.convert("RGB").resize((dw, dh), Image.Resampling.LANCZOS) if (dw, dh) != (w, h)
                         else im.convert("RGB"))
    dev = moge_runner.pick_device(device)
    net = moge_runner.load(model)  # a failure here (no weights, offline) means the fallback
    try:
        out = moge_runner.infer(net, rgb, dev)
    except Exception as e:
        if device == "auto" and dev != "cpu":
            log(f"MoGe failed on {dev} ({type(e).__name__}: {e}); retrying on cpu")
            dev = "cpu"
            out = moge_runner.infer(net, rgb, dev)
        else:
            raise
    K = out["intrinsics"]
    fov_y = fl.fov_y_from_intrinsics(float(K[1, 1]))
    fov_x = math.degrees(2 * math.atan(0.5 / float(K[0, 0])))
    pts, nrm, valid = out["points"], out.get("normal"), out["mask"].astype(bool)
    t_fit = time.monotonic()
    floor = fl.fit_floor(pts, nrm, valid)
    fit_s = time.monotonic() - t_fit

    calib = _base(w, h, exif)
    calib.update({"source": "moge-2", "model": out["repo"], "device": dev,
                  "principal": [round(float(K[0, 2]), 4), round(float(K[1, 2]), 4)]})
    # A known FOV (the photo's EXIF focal length, when it agrees with MoGe's within FOV_DISAGREE_DEG) replaces MoGe's,
    # and MoGe's metric scale is corrected with it. MoGe's FOV runs wide (3.6-7.5 deg on the golden renders, 3.1 deg
    # over EXIF on the real lounge photo) and its scale is short by the same focal ratio, while its pitch and roll are
    # right (contract §4.3 Fit). So: FOV from EXIF, pitch and roll from MoGe's floor, height times
    # k = f_exif / f_moge, and depth.png scaled to agree with the floor that camera draws. Measured on the golden scenes
    # with their true FOV given: height within 2 %, depth within 5 %, the floor grid within 2-13 px (was 32-73 px).
    exif_fov = exif.get("fov_y_deg") if exif else None
    use_exif = bool(exif_fov) and abs(fov_y - exif_fov) <= FOV_DISAGREE_DEG
    fov_cam = float(exif_fov) if use_exif else fov_y
    k = math.tan(math.radians(fov_y) / 2) / math.tan(math.radians(fov_cam) / 2)
    depth_scale = 1.0
    if floor is not None and floor["inlier_ratio"] >= MIN_INLIER_RATIO:
        height, pitch, roll = fl.camera_from_plane(floor["n"], floor["d"])
        calib["camera"] = camera_block(fov_cam, height * k, pitch, roll)
        if use_exif:
            # depth.png must agree with the floor the planner draws (furniture stands on it, and occlusion compares
            # the two): the median ratio between that floor's depth and MoGe's own over MoGe's floor pixels.
            zf = fl.floor_depth(calib["camera"], dw, dh)
            z = pts[..., 2]
            on = floor["inliers"] & np.isfinite(zf) & np.isfinite(z) & (z > 0)
            depth_scale = float(np.median(zf[on] / z[on])) if on.sum() >= 100 else k
            log(f"FOV {fov_cam:.2f} from EXIF (MoGe's {fov_y:.2f}): height x {k:.3f}, depth x {depth_scale:.3f}")
        n3 = floor["n"] * fl.CV_TO_THREE
        calib["floor"] = {"found": True, "inlier_ratio": round(floor["inlier_ratio"], 4), "rmse_m": round(floor["rmse_m"], 4),
                          "normal_camera": [round(float(v), 5) for v in n3]}
        log(f"floor: height {height:.3f} m, pitch {pitch:.2f}, roll {roll:.2f}, inliers {floor['inlier_ratio']:.1%}, "
            f"rmse {floor['rmse_m'] * 100:.1f} cm")
    else:
        calib["camera"] = camera_block(fov_cam, 1.40, -10.0, 0.0)
        calib["floor"] = {"found": False, "inlier_ratio": round(floor["inlier_ratio"], 4) if floor else None,
                          "rmse_m": round(floor["rmse_m"], 4) if floor else None}
        log(f"no floor plane found: {'the EXIF' if use_exif else 'MoGe'}'s FOV with height 1.40, pitch -10, roll 0")
        floor = None
        depth_scale = k if use_exif else 1.0
    calib["fov_source"] = "exif" if use_exif else "moge"
    calib["moge"] = {"fov_x_deg": round(fov_x, 2), "fov_y_deg": round(fov_y, 2), "input": [dw, dh],
                     "load_s": round(out["load_s"], 2), "infer_s": round(out["infer_s"], 2), "floor_fit_s": round(fit_s, 2)}
    if use_exif:
        calib["moge"].update({"height_m": round(float(calib["camera"]["height_m"]) / k, 4) if calib["floor"]["found"] else None,
                              "scale": round(k, 4), "depth_scale": round(depth_scale, 4)})
    if exif and exif.get("fov_y_deg") and abs(fov_y - exif["fov_y_deg"]) > FOV_DISAGREE_DEG:
        calib["fov_disagreement"] = {"moge_deg": round(fov_y, 2), "exif_deg": exif["fov_y_deg"]}
        log(f"MoGe's FOV {fov_y:.1f} and the EXIF FOV {exif['fov_y_deg']:.1f} differ by more than {FOV_DISAGREE_DEG:g} degrees: MoGe's is used")
    if not no_depth:
        mm, masked = fl.depth_mm(pts, valid, floor, depth_scale)
        write_atomic(scene / "depth.png", _png16(mm))
        calib["depth"] = {"file": "depth.png", "w": dw, "h": dh, "floor_masked": masked}
    return calib


def fit(scene: Path, model: str = "vitl", device: str = "auto", no_depth: bool = False) -> dict:
    t0 = time.monotonic()
    photo = scene / "photo.jpg"
    if not photo.is_file():
        raise Fail(f"{photo} doesn't exist: run ingest first")
    w, h = _photo_size(photo)
    exif = exif_block(scene, w, h)
    if exif and exif.get("fov_y_deg"):
        log(f"EXIF: {exif.get('make')} {exif.get('model')}, {exif['focal_35mm']:g} mm equivalent -> FOV {exif['fov_y_deg']:.1f} vertical")

    mock = os.environ.get("MIDSTUDY_CALIB_MOCK")
    if mock:
        calib = _mock(scene, Path(mock), w, h, exif, no_depth)
    else:
        try:
            calib = _moge(scene, w, h, exif, model, device, no_depth)
        except Exception as e:
            calib = fallback(w, h, exif, f"MoGe unavailable or failed ({type(e).__name__}: {str(e).splitlines()[0][:200] if str(e) else ''})")
    if calib.get("depth") is None:
        (scene / "depth.png").unlink(missing_ok=True)
    calib["elapsed_s"] = round(time.monotonic() - t0, 2)
    write_atomic(scene / "calib.json", (json.dumps(calib, indent=2) + "\n").encode())
    return calib
