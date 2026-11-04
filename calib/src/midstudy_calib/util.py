"""Small shared pieces: the one failure type, stderr progress, atomic writes, the camera block."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

DEFAULT_CAMERA = {"fov_y_deg": 55.0, "height_m": 1.40, "pitch_deg": -10.0, "roll_deg": 0.0}
RANGES = {"fov_y_deg": (20.0, 110.0), "height_m": (0.2, 3.0), "pitch_deg": (-80.0, 30.0), "roll_deg": (-20.0, 20.0)}
DECIMALS = {"fov_y_deg": 2, "height_m": 3, "pitch_deg": 2, "roll_deg": 2}


class Fail(Exception):
    """A user-facing failure: the message is one sentence, shown by the server (contract §4.3)."""


def log(msg: str) -> None:
    print(f"calib: {msg}", file=sys.stderr, flush=True)


def camera_block(fov_y_deg: float, height_m: float, pitch_deg: float, roll_deg: float) -> dict:
    """The contract §4.1 camera block, clamped to its ranges and rounded."""
    raw = {"fov_y_deg": fov_y_deg, "height_m": height_m, "pitch_deg": pitch_deg, "roll_deg": roll_deg}
    out = {}
    for k, v in raw.items():
        lo, hi = RANGES[k]
        clamped = min(hi, max(lo, float(v)))
        if clamped != float(v):
            log(f"{k} {float(v):.2f} is outside {lo}..{hi}: clamped to {clamped}")
        out[k] = round(clamped, DECIMALS[k])
    return out


def write_atomic(path: Path, data: bytes) -> None:
    """Write via a temp file in the same folder and rename, so readers never see a partial file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
        os.chmod(tmp, 0o644)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def source_file(scene: Path) -> Path | None:
    found = sorted(p for p in scene.glob("source.*") if p.is_file())
    return found[0] if found else None
