"""Small shared pieces: the one failure type, stderr progress, atomic writes (validated ones for JSON), a scene
folder's commit order (invalidate, sweep_tmp), the camera block."""
from __future__ import annotations

import json
import os
import sys
import tempfile
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import Final, Literal

from . import validate
from .contract_types import Camera

# What calib writes in a scene folder (contract §4.3); everything else there is the server's.
SCENE_FILES: Final[tuple[str, ...]] = ("photo.jpg", "source.*", "calib.json", "depth.png", "lighting.json")
DERIVED_FILES: Final[tuple[str, ...]] = ("calib.json", "depth.png", "lighting.json")  # calib.json first: it commits the rest

type CameraKey = Literal["fov_y_deg", "height_m", "pitch_deg", "roll_deg"]
CAMERA_KEYS: Final[tuple[CameraKey, ...]] = ("fov_y_deg", "height_m", "pitch_deg", "roll_deg")
RANGES: Final[dict[CameraKey, tuple[float, float]]] = {
    "fov_y_deg": (20.0, 110.0), "height_m": (0.2, 3.0), "pitch_deg": (-80.0, 30.0), "roll_deg": (-20.0, 20.0)}
DECIMALS: Final[dict[CameraKey, int]] = {"fov_y_deg": 2, "height_m": 3, "pitch_deg": 2, "roll_deg": 2}


def default_camera() -> Camera:
    """The contract §4.1 default camera (no calibration): FOV 55, height 1.40, pitch -10, roll 0. A fresh dict."""
    return Camera(fov_y_deg=55.0, height_m=1.40, pitch_deg=-10.0, roll_deg=0.0)


class Fail(Exception):
    """A user-facing failure: the message is one sentence, shown by the server (contract §4.3)."""


def log(msg: str) -> None:
    print(f"calib: {msg}", file=sys.stderr, flush=True)


def _clamped(k: CameraKey, v: float) -> float:
    lo, hi = RANGES[k]
    c = min(hi, max(lo, float(v)))
    if c != float(v):
        log(f"{k} {float(v):.2f} is outside {lo}..{hi}: clamped to {c}")
    return round(c, DECIMALS[k])


def camera_block(fov_y_deg: float, height_m: float, pitch_deg: float, roll_deg: float) -> Camera:
    """The contract §4.1 camera block, clamped to its ranges and rounded."""
    return Camera(fov_y_deg=_clamped("fov_y_deg", fov_y_deg), height_m=_clamped("height_m", height_m),
                  pitch_deg=_clamped("pitch_deg", pitch_deg), roll_deg=_clamped("roll_deg", roll_deg))


def write_atomic(path: Path, data: bytes) -> None:
    """Write via a temp file in the same folder and rename, so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
            f.flush()
            os.fsync(f.fileno())
        os.chmod(tmp, 0o644)  # noqa: PTH101 - on the temp file's name, before the rename
        os.replace(tmp, path)  # noqa: PTH105
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def sweep_tmp(folder: Path, names: Iterable[str]) -> None:
    """Remove the `.<name>.<random>.tmp` a killed run of ours left behind, for these names only (globs allowed): the
    server writes scene.json and thumb.jpg in the same folder with the same pattern. Safe because the server runs one
    calibration job at a time and waits for a killed worker to exit before the next."""
    for name in names:
        for tmp in folder.glob(f".{name}.*.tmp"):
            tmp.unlink(missing_ok=True)


def invalidate(folder: Path, names: Iterable[str]) -> None:
    """Remove these files in order (contract §4.3 Order: calib.json, the commit marker, goes first)."""
    for name in names:
        (folder / name).unlink(missing_ok=True)


def write_json(path: Path, obj: Mapping[str, object], schema: validate.Target) -> None:
    """Validate `obj` against its schema (a mismatch raises validate.ContractViolation and writes nothing), then
    write it atomically, indented, with a final newline."""
    validate.require(schema, obj, path.name)
    write_atomic(path, (json.dumps(obj, indent=2) + "\n").encode())


def source_file(scene: Path) -> Path | None:
    found = sorted(p for p in scene.glob("source.*") if p.is_file())
    return found[0] if found else None


def read_json(path: Path) -> object:
    """A JSON file's content, as an object to narrow (OSError and ValueError propagate)."""
    data: object = json.loads(path.read_text())
    return data
