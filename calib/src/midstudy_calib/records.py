"""Types midstudy-calib passes around that aren't the contract's own (contract_types.py, generated, has those): the
CLI's choices, the diagnostic keys it adds to calib.json (calib.schema.json allows them), EXIF facts and the result
of any command."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Literal, NotRequired, TypedDict, TypeGuard

from .contract_types import Align, AlignResult, Calib, CalibFloor, ErrorResult, IngestResult, LightDone, LightNone

type Model = Literal["vitl", "vitb", "vits"]
type Device = Literal["auto", "cuda", "mps", "cpu"]
type RealDevice = Literal["cuda", "mps", "cpu"]
type Command = Literal["run", "fit", "light", "align", "ingest", "align-room"]
MODELS: tuple[Model, ...] = ("vitl", "vitb", "vits")
DEVICES: tuple[Device, ...] = ("auto", "cuda", "mps", "cpu")


@dataclass(frozen=True)
class AlignRoomArgs:
    """align-room's arguments (contract §4.9; rooms/command.py runs it). `solver` as given: an unknown name is the
    command's failure, not a usage error."""

    scenes: list[Path]
    out: Path
    solver: str
    device: Device


class MogeInfo(TypedDict):
    """calib.json `moge`: MoGe-2's own estimates and timings; with `fov_source: "exif"` also the correction (MoGe's own
    height, the focal ratio k and the depth scale)."""

    fov_x_deg: float
    fov_y_deg: float
    input: list[int]
    load_s: float
    infer_s: float
    floor_fit_s: float
    height_m: NotRequired[float | None]
    scale: NotRequired[float]
    depth_scale: NotRequired[float]


class FittedFloor(CalibFloor):
    """calib.json `floor` from a floor fit: plus the floor's unit normal in three.js camera axes."""

    normal_camera: NotRequired[list[float]]


class CalibOut(Calib):
    """calib.json as midstudy-calib writes it: plus `fallback_reason` on a fallback calibration."""

    fallback_reason: NotRequired[str]


class ExifFacts(TypedDict):
    """What an upload's EXIF says, as far as the calibration cares."""

    orientation: int
    make: str | None
    model: str | None
    focal_35mm: float | None
    focal_mm: float | None


# The last stdout line of a command (one-shot), or a worker response without its id (align-room: align.json plus "ok").
type Result = CalibOut | IngestResult | LightDone | LightNone | AlignResult | Align | ErrorResult


def is_error(result: Result) -> TypeGuard[ErrorResult]:
    return result.get("ok") is False
