"""`midstudy-calib fit` (contract §4.3): calib.json (+ depth.png, + lighting.json) from a scene folder's photo.jpg, and
`midstudy-calib light` (§4.8): lighting.json alone.

Everything a fit writes is computed and validated first (calib.json and lighting.json against their schemas), then
written: calib.json is removed, then depth.png, lighting.json and calib.json are written, each atomically, so calib.json
is the folder's commit marker (contract §4.3 Order). A result that doesn't match its schema is a bug and fails the
command before any file changes, and so does a re-fit that can't run MoGe over an earlier MoGe calibration.
"""
from __future__ import annotations

import hashlib
import io
import json
import math
import os
import time
from dataclasses import dataclass
from pathlib import Path
from typing import cast

import numpy as np
from numpy.typing import NDArray

from . import floor as fl
from . import validate
from .contract_types import CalibExif, Camera, LightDone, Lighting, LightNone
from .ingest import exif_block
from .lighting import LightFit
from .moge_runner import MogeOutput
from .records import CalibOut, Device, FittedFloor, Model, MogeInfo, RealDevice
from .util import SCENE_FILES, Fail, camera_block, default_camera, invalidate, log, read_json, source_file, sweep_tmp, write_atomic

type U8 = NDArray[np.uint8]

DEPTH_LONG_SIDE = 1024
FOV_DISAGREE_DEG = 8.0
MIN_INLIER_RATIO = 0.02  # a "floor" covering less than 2 % of the photo isn't trusted
NO_LIGHT = "too little of the photo is usable (over-exposed, too dark or without depth) to infer its light"


@dataclass(frozen=True)
class FitOutput:
    """What a fit writes: calib.json's content, depth.png's bytes (None: no depth.png, a stale one is removed) and
    lighting.json's bytes (None: no lighting.json, a stale one is removed)."""

    calib: CalibOut
    depth_png: bytes | None
    lighting: bytes | None


def _photo_size(photo: Path) -> tuple[int, int]:
    from PIL import Image

    try:
        with Image.open(photo) as im:
            return im.size
    except Exception:
        raise Fail(f"{photo.name} isn't a readable JPEG: run ingest again") from None


def depth_size(w: int, h: int) -> tuple[int, int]:
    """depth.png's size: photo.jpg's aspect, long side at most 1024."""
    s = min(1.0, DEPTH_LONG_SIDE / max(w, h))
    return max(1, round(w * s)), max(1, round(h * s))


def _base(w: int, h: int, exif: CalibExif | None) -> CalibOut:
    return CalibOut(version=1, source="default", model=None, image={"w": w, "h": h}, camera=default_camera(), principal=[0.5, 0.5],
                    floor={"found": False, "inlier_ratio": None, "rmse_m": None}, depth=None, exif=exif, device=None, elapsed_s=0)


def fallback(w: int, h: int, exif: CalibExif | None, why: str) -> CalibOut:
    """MoGe unavailable or failed: FOV from EXIF (source "exif") or 55 (source "default"), height 1.40, pitch -10."""
    calib = _base(w, h, exif)
    fov = exif.get("fov_y_deg") if exif else None
    if fov:
        calib["source"] = "exif"
        calib["camera"] = camera_block(fov, 1.40, -10.0, 0.0)
    calib["fallback_reason"] = why
    log(f"fallback ({calib['source']}): {why}")
    return calib


def lighting_bytes(light: Lighting) -> bytes:
    """lighting.json's bytes, after checking them against lighting.schema.json."""
    validate.require("lighting", light, "lighting.json")
    return (json.dumps(light, indent=2) + "\n").encode()


def _mock_keys(scene: Path) -> list[str]:
    """MIDSTUDY_CALIB_MOCK's lookup keys: the SHA-256 of photo.jpg, then of source.<ext>."""
    keys = [hashlib.sha256((scene / "photo.jpg").read_bytes()).hexdigest()]
    src = source_file(scene)
    if src:
        keys.append(hashlib.sha256(src.read_bytes()).hexdigest())
    return keys


def _valid_lighting_file(path: Path) -> bytes:
    """A mock's lighting.json, checked against lighting.schema.json before it is copied byte for byte."""
    data = path.read_bytes()
    validate.require("lighting", json.loads(data), f"the mock's lighting.json ({path.parent.name})")
    return data


def _mock(scene: Path, mock_dir: Path, w: int, h: int, exif: CalibExif | None, no_depth: bool) -> FitOutput:
    """MIDSTUDY_CALIB_MOCK: copy <dir>/<sha256 of photo.jpg or source.<ext>>/{calib.json, depth.png, lighting.json};
    never loads MoGe."""
    for key in _mock_keys(scene):
        d = mock_dir / key
        if (d / "calib.json").is_file():
            data = read_json(d / "calib.json")
            validate.require("calib", data, f"the mock's calib.json ({key})")
            calib = cast(CalibOut, data)
            log(f"MIDSTUDY_CALIB_MOCK hit {d}")
            if calib["image"] != {"w": w, "h": h}:
                log(f"warning: the mock's image size {calib['image']} isn't photo.jpg's {w} x {h}")
            depth = None
            if calib["depth"] and (d / "depth.png").is_file() and not no_depth:
                depth = (d / "depth.png").read_bytes()
            else:
                calib["depth"] = None
            light = _valid_lighting_file(d / "lighting.json") if (d / "lighting.json").is_file() else None
            return FitOutput(calib, depth, light)
    log(f"no mock for photo.jpg in {mock_dir}: writing the fallback")
    return FitOutput(fallback(w, h, exif, "MIDSTUDY_CALIB_MOCK has no calibration for this photo"), None, None)


def _png16(mm: NDArray[np.uint16]) -> bytes:
    from PIL import Image

    buf = io.BytesIO()
    Image.fromarray(np.ascontiguousarray(mm, dtype=np.uint16)).save(buf, "PNG", optimize=False)
    return buf.getvalue()


def _infer(scene: Path, w: int, h: int, model: Model, device: Device) -> tuple[U8, MogeOutput, RealDevice]:
    """photo.jpg at depth size through MoGe-2 (shared by fit and light): (rgb uint8 (dh, dw, 3), MoGe's output, the
    device it ran on). A failure to load the model (no weights, offline) raises."""
    from PIL import Image

    from . import moge_runner

    dw, dh = depth_size(w, h)
    with Image.open(scene / "photo.jpg") as im:
        rgb = np.asarray(im.convert("RGB").resize((dw, dh), Image.Resampling.LANCZOS) if (dw, dh) != (w, h)
                         else im.convert("RGB"), np.uint8)
    dev = moge_runner.pick_device(device)
    loaded, load_s = moge_runner.load(model)
    try:
        out = moge_runner.infer(loaded, rgb, dev, load_s)
    except Exception as e:
        if device == "auto" and dev != "cpu":
            log(f"MoGe failed on {dev} ({type(e).__name__}: {e}); retrying on cpu")
            dev = "cpu"
            out = moge_runner.infer(loaded, rgb, dev, load_s)
        else:
            raise
    return rgb, out, dev


def _fov_choice(fov_y: float, exif: CalibExif | None) -> tuple[bool, float, float]:
    """(use the EXIF FOV, the camera's FOV, k = tan(fov_moge / 2) / tan(fov_camera / 2)): contract §4.3 Fit."""
    exif_fov = exif.get("fov_y_deg") if exif else None
    use_exif, fov_cam = (True, float(exif_fov)) if exif_fov and abs(fov_y - exif_fov) <= FOV_DISAGREE_DEG else (False, fov_y)
    return use_exif, fov_cam, math.tan(math.radians(fov_y) / 2) / math.tan(math.radians(fov_cam) / 2)


def _fit_light(rgb: U8, out: MogeOutput, camera: Camera, floor: fl.FloorFit | None, w: int, h: int) -> LightFit | None:
    """lighting.json's content from MoGe's output (contract §4.8), or None when the photo gives too little."""
    from . import lighting as lt

    pts, nrm, valid = out.points, out.normal, out.mask
    return lt.fit(rgb, pts, nrm if nrm is not None else np.full_like(pts, np.nan), valid, camera,
                  floor.inliers if floor is not None else None, {"w": w, "h": h})


def _log_light(light: LightFit) -> None:
    k, wb = light.lighting["key"], light.lighting["white_balance"]
    log(f"light: key from azimuth {light.azimuth_deg:.0f}, elevation {light.elevation_deg:.0f} "
        f"(confidence {k['confidence']:.2f}, {light.pairs} creases), {wb['cct_k']} K, in {light.elapsed_s:.2f} s")


def _moge(scene: Path, w: int, h: int, exif: CalibExif | None, model: Model, device: Device, no_depth: bool) -> FitOutput:
    dw, dh = depth_size(w, h)
    rgb, out, dev = _infer(scene, w, h, model, device)  # a failure here (no weights, offline) means the fallback
    K = out.intrinsics
    fov_y = fl.fov_y_from_intrinsics(float(K[1, 1]))
    fov_x = math.degrees(2 * math.atan(0.5 / float(K[0, 0])))
    pts, nrm, valid = out.points, out.normal, out.mask
    t_fit = time.monotonic()
    floor = fl.fit_floor(pts, nrm, valid)
    fit_s = time.monotonic() - t_fit

    calib = _base(w, h, exif)
    calib["source"] = "moge-2"
    calib["model"] = out.repo
    calib["device"] = dev
    calib["principal"] = [round(float(K[0, 2]), 4), round(float(K[1, 2]), 4)]
    # A known FOV (the photo's EXIF focal length, when it agrees with MoGe's within FOV_DISAGREE_DEG) replaces MoGe's,
    # and MoGe's metric scale is corrected with it. MoGe's FOV runs wide (3.6-7.5 deg on the golden renders, 3.1 deg
    # over EXIF on the real lounge photo) and its scale is short by the same focal ratio, while its pitch and roll are
    # right (contract §4.3 Fit). So: FOV from EXIF, pitch and roll from MoGe's floor, height times
    # k = f_exif / f_moge, and depth.png scaled to agree with the floor that camera draws. Measured on the golden scenes
    # with their true FOV given: height within 2 %, depth within 5 %, the floor grid within 2-13 px (was 32-73 px).
    use_exif, fov_cam, k = _fov_choice(fov_y, exif)
    depth_scale = 1.0
    if floor is not None and floor.inlier_ratio >= MIN_INLIER_RATIO:
        height, pitch, roll = fl.camera_from_plane(floor.n, floor.d)
        calib["camera"] = camera_block(fov_cam, height * k, pitch, roll)
        if use_exif:
            # depth.png must agree with the floor the planner draws (furniture stands on it, and occlusion compares
            # the two): the median ratio between that floor's depth and MoGe's own over MoGe's floor pixels.
            zf = fl.floor_depth(calib["camera"], dw, dh)
            z = pts[..., 2]
            on = floor.inliers & np.isfinite(zf) & np.isfinite(z) & (z > 0)
            depth_scale = float(np.median(zf[on] / z[on])) if on.sum() >= 100 else k
            log(f"FOV {fov_cam:.2f} from EXIF (MoGe's {fov_y:.2f}): height x {k:.3f}, depth x {depth_scale:.3f}")
        n3 = floor.n * fl.CV_TO_THREE
        calib["floor"] = FittedFloor(found=True, inlier_ratio=round(floor.inlier_ratio, 4), rmse_m=round(floor.rmse_m, 4),
                                     normal_camera=[round(float(v), 5) for v in n3])
        log(f"floor: height {height:.3f} m, pitch {pitch:.2f}, roll {roll:.2f}, inliers {floor.inlier_ratio:.1%}, "
            f"rmse {floor.rmse_m * 100:.1f} cm")
    else:
        calib["camera"] = camera_block(fov_cam, 1.40, -10.0, 0.0)
        calib["floor"] = {"found": False, "inlier_ratio": round(floor.inlier_ratio, 4) if floor else None,
                          "rmse_m": round(floor.rmse_m, 4) if floor else None}
        log(f"no floor plane found: {'the EXIF' if use_exif else 'MoGe'}'s FOV with height 1.40, pitch -10, roll 0")
        floor = None
        depth_scale = k if use_exif else 1.0
    calib["fov_source"] = "exif" if use_exif else "moge"
    moge = MogeInfo(fov_x_deg=round(fov_x, 2), fov_y_deg=round(fov_y, 2), input=[dw, dh], load_s=round(out.load_s, 2),
                    infer_s=round(out.infer_s, 2), floor_fit_s=round(fit_s, 2), revision=out.revision)
    calib["moge"] = moge
    if use_exif:
        moge["height_m"] = round(float(calib["camera"]["height_m"]) / k, 4) if calib["floor"]["found"] else None
        moge["scale"] = round(k, 4)
        moge["depth_scale"] = round(depth_scale, 4)
    exif_fov = exif.get("fov_y_deg") if exif else None
    if exif_fov and abs(fov_y - exif_fov) > FOV_DISAGREE_DEG:
        calib["fov_disagreement"] = {"moge_deg": round(fov_y, 2), "exif_deg": exif_fov}
        log(f"MoGe's FOV {fov_y:.1f} and the EXIF FOV {exif_fov:.1f} differ by more than {FOV_DISAGREE_DEG:g} degrees: MoGe's is used")
    depth_png = None
    if not no_depth:
        mm, masked = fl.depth_mm(pts, valid, floor, depth_scale)
        depth_png = _png16(mm)
        calib["depth"] = {"file": "depth.png", "w": dw, "h": dh, "floor_masked": masked}
    # the room's light (contract §4.8): ~0.3 s on MoGe's output, nothing else to load
    try:
        light = _fit_light(rgb, out, calib["camera"], floor, w, h)
    except Exception as e:
        log(f"lighting fit failed ({type(e).__name__}: {e}); the planner keeps its default lights")
        light = None
    if light is not None:
        _log_light(light)
    else:
        log("light: too little to go on; no lighting.json")
    return FitOutput(calib, depth_png, lighting_bytes(light.lighting) if light is not None else None)


def _write(scene: Path, out: FitOutput) -> None:
    """calib.json removed, depth.png and lighting.json (each written, or a stale one removed), then calib.json (already
    checked against its schema): a crash in between reads as "not fitted", never as the old calib.json beside new files."""
    calib_bytes = (json.dumps(out.calib, indent=2) + "\n").encode()
    sweep_tmp(scene, SCENE_FILES)
    invalidate(scene, ("calib.json",))
    if out.depth_png is not None:
        write_atomic(scene / "depth.png", out.depth_png)
    else:
        (scene / "depth.png").unlink(missing_ok=True)
    if out.lighting is not None:
        write_atomic(scene / "lighting.json", out.lighting)
    else:
        (scene / "lighting.json").unlink(missing_ok=True)
    write_atomic(scene / "calib.json", calib_bytes)


def _has_moge_calibration(scene: Path) -> bool:
    """Whether the folder's calib.json is a real MoGe calibration (a fallback one is nothing to protect)."""
    try:
        calib = read_json(scene / "calib.json")
    except (OSError, ValueError):
        return False
    return isinstance(calib, dict) and cast(dict[str, object], calib).get("source") == "moge-2"


def fit(scene: Path, model: Model = "vitl", device: Device = "auto", no_depth: bool = False) -> CalibOut:
    t0 = time.monotonic()
    photo = scene / "photo.jpg"
    if not photo.is_file():
        raise Fail(f"{photo} doesn't exist: run ingest first")
    w, h = _photo_size(photo)
    exif = exif_block(scene, w, h)
    if exif and exif.get("fov_y_deg"):
        log(f"EXIF: {exif.get('make')} {exif.get('model')}, {exif.get('focal_35mm') or 0:g} mm equivalent -> FOV {exif.get('fov_y_deg') or 0:.1f} vertical")

    mock = os.environ.get("MIDSTUDY_CALIB_MOCK")
    if mock:
        out = _mock(scene, Path(mock), w, h, exif, no_depth)
    else:
        try:
            out = _moge(scene, w, h, exif, model, device, no_depth)
        except validate.ContractViolation:
            raise
        except Exception as e:
            first = str(e).splitlines()[0][:200] if str(e) else ""
            if _has_moge_calibration(scene):  # it pairs with this photo: ingest removes it when the photo changes
                raise Fail(f"MoGe-2 couldn't run ({type(e).__name__}: {first}); the earlier calibration was kept") from None
            out = FitOutput(fallback(w, h, exif, f"MoGe unavailable or failed ({type(e).__name__}: {first})"), None, None)
    out.calib["elapsed_s"] = round(time.monotonic() - t0, 2)
    validate.require("calib", out.calib, "calib.json")
    _write(scene, out)
    return out.calib


# --- `midstudy-calib light` (contract §4.8): lighting.json alone, for scenes calibrated before it existed --------------
def _scene_camera(scene: Path) -> tuple[Camera | None, bool]:
    """calib.json's camera block (None without a readable one) and whether it was fitted to a floor."""
    try:
        calib = read_json(scene / "calib.json")
    except (OSError, ValueError):
        return None, False
    if not isinstance(calib, dict):
        return None, False
    c = cast(dict[str, object], calib)
    cam, flo = c.get("camera"), c.get("floor")
    if not isinstance(cam, dict):
        return None, False
    cam_d = cast(dict[str, object], cam)
    vals = [cam_d.get(k) for k in ("fov_y_deg", "height_m", "pitch_deg", "roll_deg")]
    nums = [float(v) for v in vals if isinstance(v, int | float) and not isinstance(v, bool)]
    if len(nums) != 4:
        return None, False
    found = isinstance(flo, dict) and cast(dict[str, object], flo).get("found") is True
    return camera_block(*nums), found


def _light_mock(scene: Path, mock_dir: Path) -> bytes | None:
    """MIDSTUDY_CALIB_MOCK: <dir>/<sha256 of photo.jpg, then of source.<ext>>/lighting.json (checked), or None."""
    for key in _mock_keys(scene):
        f = mock_dir / key / "lighting.json"
        if f.is_file():
            log(f"MIDSTUDY_CALIB_MOCK hit {f.parent}")
            return _valid_lighting_file(f)
    log(f"no mock lighting for photo.jpg in {mock_dir}")
    return None


def light(scene: Path, model: Model = "vitl", device: Device = "auto") -> LightDone | LightNone:
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
            return LightNone(ok=True, lighting=False, reason="MIDSTUDY_CALIB_MOCK has no lighting for this photo")
        lj = cast(Lighting, json.loads(data))  # checked against lighting.schema.json by _light_mock
        write_atomic(scene / "lighting.json", data)
    else:
        try:
            rgb, out, _ = _infer(scene, w, h, model, device)
        except Exception as e:
            first = str(e).splitlines()[0][:200] if str(e) else ""
            raise Fail(f"MoGe-2 couldn't run ({type(e).__name__}: {first}), so the light can't be inferred") from None
        floor = fl.fit_floor(out.points, out.normal, out.mask)
        if floor is not None and floor.inlier_ratio < MIN_INLIER_RATIO:
            floor = None
        camera, fitted = _scene_camera(scene)
        if camera is not None and (fitted or floor is None):
            log(f"camera from calib.json: pitch {camera['pitch_deg']}, roll {camera['roll_deg']}")
        elif floor is not None:
            fov_y = fl.fov_y_from_intrinsics(float(out.intrinsics[1, 1]))
            _, fov_cam, k = _fov_choice(fov_y, exif_block(scene, w, h))
            height, pitch, roll = fl.camera_from_plane(floor.n, floor.d)
            camera = camera_block(fov_cam, height * k, pitch, roll)
            log(f"camera from the floor fit: pitch {camera['pitch_deg']}, roll {camera['roll_deg']}")
        else:
            camera = default_camera()
            log("no calib.json camera and no floor: the default camera")
        try:
            fitted_light = _fit_light(rgb, out, camera, floor, w, h)
        except Exception as e:
            raise Fail(f"the lighting fit failed ({type(e).__name__}: {' '.join(str(e).split())[:200]})") from None
        if fitted_light is None:
            log(f"light: {NO_LIGHT}; lighting.json left as it was")
            return LightNone(ok=True, lighting=False, reason=NO_LIGHT)
        lj = fitted_light.lighting
        write_atomic(scene / "lighting.json", lighting_bytes(lj))
        _log_light(fitted_light)
    return LightDone(ok=True, lighting=True, cct_k=lj["white_balance"]["cct_k"], confidence=lj["key"]["confidence"],
                     elapsed_s=round(time.monotonic() - t0, 2))

