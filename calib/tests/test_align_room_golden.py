"""The real MASt3R on the golden room (contract §5.1, docs/ROOMS.md §5 Phase A targets): yaw within 1.5°, position
within 5 cm, scale within 2 %, at most one photo unplaced, and never a wrong placement presented with confidence.

Marked `mast3r`: skipped unless the `rooms` extra is installed (`uv sync --project calib --extra rooms`); the first
run fetches MASt3R's pinned code and weights (rooms/mast3r.py), later runs are offline. About 2 minutes on MPS (M3 Max);
`pytest -m "not mast3r"` leaves it out."""
from __future__ import annotations

import math
from pathlib import Path

import pytest
from synthetic import REPO
from test_align_room import truth_pose

from midstudy_calib import validate
from midstudy_calib.contract_types import AlignMember
from midstudy_calib.records import AlignRoomArgs
from midstudy_calib.rooms import mast3r
from midstudy_calib.rooms.command import AlignRoomResult, align_room
from midstudy_calib.rooms.geometry import relative_to, wrap_deg

pytestmark = [pytest.mark.mast3r, pytest.mark.skipif(not mast3r.installed(), reason="the rooms extra (MASt3R) isn't installed"),
              pytest.mark.usefixtures("no_mock")]

SCENES = REPO / "fixtures/scenes"
POS_CM, YAW_DEG, SCALE_PCT = 5.0, 1.5, 2.0


def errors(sid: str, first: str, m: AlignMember) -> tuple[float, float, float] | None:
    """(position cm, yaw °, scale %) against truth re-expressed relative to `first`, or None when unplaced."""
    pose, scale = m["pose"], m["scale"]
    if pose is None or scale is None:
        return None
    want = relative_to(truth_pose(sid), truth_pose(first))
    return (100 * math.hypot(pose["x_m"] - want.x, pose["z_m"] - want.z), abs(wrap_deg(pose["yaw_deg"] - math.degrees(want.yaw))),
            100 * abs(scale - 1))


@pytest.fixture
def no_mock(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)


def run(ids: list[str], out: Path) -> AlignRoomResult:
    res = align_room(AlignRoomArgs([SCENES / s for s in ids], out, "mast3r", "auto"))
    assert validate.problems("align_room", res) == []
    assert res["solver"] == "mast3r"
    return res


def report(ids: list[str], res: AlignRoomResult) -> str:
    rows = [f"{s}: {errors(s, ids[0], m)} conf {m['confidence']} res {m['residual_cm']}" for s, m in zip(ids, res["members"], strict=True)]
    return "; ".join(rows)


def test_the_golden_room_meets_the_phase_a_targets(tmp_path: Path) -> None:
    ids = ["living-wide", "room-1", "room-2", "room-3", "room-4", "room-5", "room-6"]
    res = run(ids, tmp_path / "room")
    why = report(ids, res)
    assert len(res["unplaced"]) <= 1, why
    for sid, m in zip(ids, res["members"], strict=True):
        e = errors(sid, ids[0], m)
        if e is None:
            continue
        # every placed photo has confidence >= 0.5 (score.MIN_CONFIDENCE), so off target would be confidently wrong
        assert e[0] <= POS_CM and e[1] <= YAW_DEG and e[2] <= SCALE_PCT and m["confidence"] >= 0.5, (sid, why)
    assert res["unplaced"] in ([], ["room-6"]), why  # only the bare wall may stay unplaced
    assert res["loop_residual_cm"] is not None and res["loop_residual_cm"] < 5, why


@pytest.mark.parametrize("ids", [["room-1", "room-4"], ["living-wide", "room-4"], ["room-3", "room-6"], ["living-wide", "room-6"]],
                         ids=["low-overlap", "low-overlap-lw", "blank-wall", "blank-wall-lw"])
def test_the_hard_pairs_are_never_confidently_wrong(tmp_path: Path, ids: list[str]) -> None:
    """Phase A's hard subsets: a photo the pair can't place well must come back unplaced, not placed off target."""
    res = run(ids, tmp_path / "pair")
    e = errors(ids[1], ids[0], res["members"][1])
    assert e is None or (e[0] <= POS_CM and e[1] <= YAW_DEG and e[2] <= SCALE_PCT), report(ids, res)
