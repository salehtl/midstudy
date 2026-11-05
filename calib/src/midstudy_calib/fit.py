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
            if (d / "lighting.json").is_file():
                write_atomic(scene / "lighting.json", (d / "lighting.json").read_bytes())
            else:
                (scene / "lighting.json").unlink(missing_ok=True)
            return calib
    log(f"no mock for photo.jpg in {mock_dir}: writing the default fallback")
    (scene / "lighting.json").unlink(missing_ok=True)
    calib = _base(w, h, exif)
    calib["fallback_reason"] = "MIDSTUDY_CALIB_MOCK has no calibration for this photo"
    return calib


def _png16(mm) -> bytes:
    import numpy as np
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(mm, dtype=np.uint16)).save(buf, "PNG", optimize=False)
    return buf.getvalue()


def _infer(scene: Path, w: int, h: int, model: str, device: str):
    """photo.jpg at depth size through MoGe-2 (shared by fit and light): (rgb uint8 (dh, dw, 3), MoGe's output, the
    device it ran on). A failure to load the model (no weights, offline) raises."""
    import numpy as np
    from PIL import Image

    from . import moge_runner

    dw, dh = depth_size(w, h)
    with Image.open(scene / "photo.jpg") as im:
        rgb = np.asarray(im.convert("RGB").resize((dw, dh), Image.Resampling.LANCZOS) if (dw, dh) != (w, h)
                         else im.convert("RGB"))
    dev = moge_runner.pick_device(device)
    net = moge_runner.load(model)
    try:
        out = moge_runner.infer(net, rgb, dev)
    except Exception as e:
        if device == "auto" and dev != "cpu":
            log(f"MoGe failed on {dev} ({type(e).__name__}: {e}); retrying on cpu")
            dev = "cpu"
            out = moge_runner.infer(net, rgb, dev)
        else:
            raise
    return rgb, out, dev


def _fov_choice(fov_y: float, exif: dict | None) -> tuple[bool, float, float]:
    """(use the EXIF FOV, the camera's FOV, k = tan(fov_moge / 2) / tan(fov_camera / 2)): contract §4.3 Fit."""
    exif_fov = exif.get("fov_y_deg") if exif else None
    use_exif = bool(exif_fov) and abs(fov_y - exif_fov) <= FOV_DISAGREE_DEG
    fov_cam = float(exif_fov) if use_exif else fov_y
    return use_exif, fov_cam, math.tan(math.radians(fov_y) / 2) / math.tan(math.radians(fov_cam) / 2)


def _fit_light(rgb, out: dict, camera: dict, floor: dict | None, w: int, h: int) -> dict | None:
    """lighting.json's content from MoGe's output (contract §4.8), or None when the photo gives too little."""
    import numpy as np

    from . import lighting as lt

    pts, nrm, valid = out["points"], out.get("normal"), out["mask"].astype(bool)
    return lt.fit(rgb, pts, nrm if nrm is not None else np.full_like(pts, np.nan), valid, camera,
                  floor["inliers"] if floor is not None else None, {"w": w, "h": h})


def _log_light(light: dict) -> None:
    f, k = light["fit"], light["key"]
    log(f"light: key from azimuth {f['world_key']['azimuth_deg']:.0f}, elevation {f['world_key']['elevation_deg']:.0f} "
        f"(confidence {k['confidence']:.2f}, {f['pairs']} creases), {light['white_balance']['cct_k']} K, in {f['elapsed_s']:.2f} s")


def _moge(scene: Path, w: int, h: int, exif: dict | None, model: str, device: str, no_depth: bool) -> dict:
    import numpy as np

    from . import floor as fl

    dw, dh = depth_size(w, h)
    rgb, out, dev = _infer(scene, w, h, model, device)  # a failure here (no weights, offline) means the fallback
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
    use_exif, fov_cam, k = _fov_choice(fov_y, exif)
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
    # the room's light (contract §4.8): ~1 s on MoGe's output, nothing else to load
    try:
        light = _fit_light(rgb, out, calib["camera"], floor, w, h)
    except Exception as e:  # noqa: BLE001 - the light is a bonus: a failure here never fails the calibration
        log(f"lighting fit failed ({type(e).__name__}: {e}); the planner keeps its default lights")
        light = None
    if light is not None:
        write_atomic(scene / "lighting.json", (json.dumps(light, indent=2) + "\n").encode())
        _log_light(light)
    else:
        (scene / "lighting.json").unlink(missing_ok=True)
        log("light: too little to go on; no lighting.json")
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
            (scene / "lighting.json").unlink(missing_ok=True)
    if calib.get("depth") is None:
        (scene / "depth.png").unlink(missing_ok=True)
    calib["elapsed_s"] = round(time.monotonic() - t0, 2)
    write_atomic(scene / "calib.json", (json.dumps(calib, indent=2) + "\n").encode())
    return calib


# --- `midstudy-calib light` (contract §4.8): lighting.json alone, for scenes calibrated before it existed --------------
NO_LIGHT = "too little of the photo is usable (over-exposed, too dark or without depth) to infer its light"


def _scene_camera(scene: Path) -> tuple[dict | None, bool]:
    """calib.json's camera block (None without a readable one) and whether it was fitted to a floor."""
    try:
        calib = json.loads((scene / "calib.json").read_text())
    except (OSError, ValueError):
        return None, False
    cam = calib.get("camera") if isinstance(calib, dict) else None
    keys = ("fov_y_deg", "height_m", "pitch_deg", "roll_deg")
    if not isinstance(cam, dict) or not all(isinstance(cam.get(k), (int, float)) and not isinstance(cam.get(k), bool) for k in keys):
        return None, False
    floor = calib.get("floor") if isinstance(calib.get("floor"), dict) else {}
    return camera_block(*(cam[k] for k in keys)), floor.get("found") is True


def _light_mock(scene: Path, mock_dir: Path) -> bytes | None:
    """MIDSTUDY_CALIB_MOCK: <dir>/<sha256 of photo.jpg, then of source.<ext>>/lighting.json, or None."""
    keys = [hashlib.sha256((scene / "photo.jpg").read_bytes()).hexdigest()]
    src = source_file(scene)
    if src:
        keys.append(hashlib.sha256(src.read_bytes()).hexdigest())
    for key in keys:
        f = mock_dir / key / "lighting.json"
        if f.is_file():
            log(f"MIDSTUDY_CALIB_MOCK hit {f.parent}")
            return f.read_bytes()
    log(f"no mock lighting for photo.jpg in {mock_dir}")
    return None


def light(scene: Path, model: str = "vitl", device: str = "auto") -> dict:
    """Run MoGe-2 on photo.jpg exactly as fit does and write lighting.json only (calib.json, depth.png, source.*,
    photo.jpg and scene.json are never touched). The camera is calib.json's when it was fitted to a floor, else the one
    this floor fit gives, else calib.json's (a fallback), else the default. When the photo gives too little, nothing is
    written (an existing lighting.json stays) and the result says why. MoGe failing to run is a failure."""
    t0 = time.monotonic()
    photo = scene / "photo.jpg"
    if not photo.is_file():
        raise Fail(f"{photo} doesn't exist: calibrate the scene first")
    w, h = _photo_size(photo)
    mock = os.environ.get("MIDSTUDY_CALIB_MOCK")
    if mock:
        data = _light_mock(scene, Path(mock))
        if data is None:
            return {"ok": True, "lighting": False, "reason": "MIDSTUDY_CALIB_MOCK has no lighting for this photo"}
        write_atomic(scene / "lighting.json", data)
        try:
            lj = json.loads(data)
        except ValueError:
            lj = {}
    else:
        from . import floor as fl

        try:
            rgb, out, dev = _infer(scene, w, h, model, device)
        except Exception as e:
            first = str(e).splitlines()[0][:200] if str(e) else ""
            raise Fail(f"MoGe-2 couldn't run ({type(e).__name__}: {first}), so the light can't be inferred")
        pts, nrm, valid = out["points"], out.get("normal"), out["mask"].astype(bool)
        floor = fl.fit_floor(pts, nrm, valid)
        if floor is not None and floor["inlier_ratio"] < MIN_INLIER_RATIO:
            floor = None
        camera, fitted = _scene_camera(scene)
        if camera is not None and (fitted or floor is None):
            log(f"camera from calib.json: pitch {camera['pitch_deg']}, roll {camera['roll_deg']}")
        elif floor is not None:
            fov_y = fl.fov_y_from_intrinsics(float(out["intrinsics"][1, 1]))
            _, fov_cam, k = _fov_choice(fov_y, exif_block(scene, w, h))
            height, pitch, roll = fl.camera_from_plane(floor["n"], floor["d"])
            camera = camera_block(fov_cam, height * k, pitch, roll)
            log(f"camera from the floor fit: pitch {camera['pitch_deg']}, roll {camera['roll_deg']}")
        else:
            camera = dict(DEFAULT_CAMERA)
            log("no calib.json camera and no floor: the default camera")
        try:
            lj = _fit_light(rgb, out, camera, floor, w, h)
        except Exception as e:
            raise Fail(f"the lighting fit failed ({type(e).__name__}: {' '.join(str(e).split())[:200]})")
        if lj is None:
            log(f"light: {NO_LIGHT}; lighting.json left as it was")
            return {"ok": True, "lighting": False, "reason": NO_LIGHT}
        write_atomic(scene / "lighting.json", (json.dumps(lj, indent=2) + "\n").encode())
        _log_light(lj)
    wb = lj.get("white_balance") if isinstance(lj, dict) and isinstance(lj.get("white_balance"), dict) else {}
    key = lj.get("key") if isinstance(lj, dict) and isinstance(lj.get("key"), dict) else {}
    return {"ok": True, "lighting": True, "cct_k": wb.get("cct_k"), "confidence": key.get("confidence"),
            "elapsed_s": round(time.monotonic() - t0, 2)}
