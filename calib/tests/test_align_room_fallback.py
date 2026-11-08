"""align-room's solver selection (contract §4.9): an unusable room never asks for a solver, and a learned solver that
could only place the first photo escalates to manhattan under auto, and says so under an explicit --solver."""
from __future__ import annotations

from pathlib import Path
from typing import cast

import pytest
from test_align_room import copy_scenes

from midstudy_calib.contract_types import Align
from midstudy_calib.records import RealDevice
from midstudy_calib.rooms import command, mast3r, solver
from midstudy_calib.rooms.geometry import Placement
from midstudy_calib.rooms.photos import RoomPhoto, load
from midstudy_calib.rooms.score import Candidate
from midstudy_calib.rooms.solver import SolverName

IDS = ["living-wide", "room-1", "room-2"]
FIRST_ONLY = "mast3r: no floor or depth overlap on the first photo"
CREATED = "2026-01-01T00:00:00Z"


def _photos(tmp: Path) -> list[RoomPhoto]:
    return [load(d) for d in copy_scenes(tmp, IDS)]


def _diagnostics(ans: Align) -> dict[str, object]:
    return cast(dict[str, dict[str, object]], ans)["diagnostics"]


class _Fake:
    def __init__(self, name: SolverName, answer: list[Candidate | None], calls: list[SolverName]) -> None:
        self._name: SolverName = name
        self._answer = answer
        self._calls = calls

    @property
    def name(self) -> SolverName:
        return self._name

    @property
    def uses_torch(self) -> bool:
        return False

    def solve(self, photos: list[RoomPhoto], device: RealDevice) -> list[Candidate | None]:
        assert len(photos) == len(self._answer), device
        self._calls.append(self._name)
        return self._answer


def _fake_solvers(monkeypatch: pytest.MonkeyPatch, learned: list[Candidate | None]) -> list[SolverName]:
    calls: list[SolverName] = []
    monkeypatch.setattr(mast3r, "installed", lambda: True)

    def make(name: SolverName) -> solver.Solver:
        return _Fake(name, learned if name == "mast3r" else [Candidate(Placement(0.0, 0.0, 0.0, 1.0)), None, None], calls)

    monkeypatch.setattr(solver, "make", make)
    return calls


def _first_only(source: str) -> list[Candidate | None]:
    return [Candidate(Placement(0.0, 0.0, 0.0, 1.0), diag={"scale_source": source}), None, None]


def test_an_unusable_room_never_resolves_a_solver(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mast3r, "installed", lambda: False)
    dirs = copy_scenes(tmp_path, IDS)
    for d in dirs:
        (d / "calib.json").unlink()
    ans = command.solve([load(d) for d in dirs], "mast3r", "cpu", CREATED, 0.0)
    assert ans["solver"] == "none"
    assert ans["device"] is None
    assert "nothing_placed" in _diagnostics(ans)


def test_a_usable_room_still_refuses_a_missing_solver(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mast3r, "installed", lambda: False)
    with pytest.raises(solver.SolverUnavailable, match="isn't installed"):
        command.solve(_photos(tmp_path), "mast3r", "cpu", CREATED, 0.0)


def test_auto_escalates_when_the_learned_solver_has_no_scale(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_solvers(monkeypatch, _first_only("none"))
    ans = command.solve(_photos(tmp_path), "auto", "cpu", CREATED, 0.0)
    assert calls == ["mast3r", "manhattan"]
    assert ans["solver"] == "manhattan"
    assert _diagnostics(ans)["fallback"] == FIRST_ONLY


def test_an_explicit_solver_keeps_its_answer_and_says_it_is_degenerate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_solvers(monkeypatch, _first_only("none"))
    ans = command.solve(_photos(tmp_path), "mast3r", "cpu", CREATED, 0.0)
    assert calls == ["mast3r"]
    assert ans["solver"] == "mast3r"
    diag = _diagnostics(ans)
    assert diag["degenerate"] == FIRST_ONLY
    assert "fallback" not in diag


def test_unplaced_members_with_a_known_scale_do_not_escalate(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls = _fake_solvers(monkeypatch, _first_only("floor"))
    ans = command.solve(_photos(tmp_path), "auto", "cpu", CREATED, 0.0)
    assert calls == ["mast3r"]
    assert ans["solver"] == "mast3r"
    assert "fallback" not in _diagnostics(ans)
