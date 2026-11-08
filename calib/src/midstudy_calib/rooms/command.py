"""`midstudy-calib align-room <scene-dir> <scene-dir> ... --out <room-dir> [--solver auto|mast3r|manhattan]
[--device auto|cuda|mps|cpu]` (contract §4.3, §4.9 Align).

Reads each folder's photo.jpg, calib.json and depth.png and writes only <room-dir>/align.json (atomically, after
checking it against align.schema.json; <room-dir> is created when missing). Never touches the scenes. The first folder
is the frame (members[0]: pose {0, 0, 0}, scale 1, confidence 1); every other pose and scale is relative to it.

- Fewer than two folders, a folder without photo.jpg, or two folders with the same name: a failure (one sentence).
- A photo without calib.json or depth.png (or with no depth at all) is unplaced: the solvers need its floor fit to
  stand it on the floor and its depth to score it. Being unable to place a photo is not a failure.
- --solver auto: MASt3R when the `rooms` extra is installed, else manhattan; when MASt3R is installed but can't load
  (its code or weights can't be fetched the first time, or the network doesn't fit on the device), manhattan answers
  and `diagnostics.fallback` says why. So does a MASt3R run with no scale for the first photo (only it placed).
  --solver mast3r with the extra missing, or failing to load, is a failure; its run with no scale stands, with
  `diagnostics.degenerate` saying so. A room with too few usable photos answers solver "none" whatever was asked.
- MIDSTUDY_CALIB_MOCK=<dir>: the recorded answer (mock.py), no solver.

Top-level `diagnostics` (align.schema.json allows other keys) carries, per member, what the scoring saw (overlap,
constraint, tilt, the solver's own confidence, a rejected pose) and the run's timing.
"""
from __future__ import annotations

import math
import os
import time
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from ..contract_types import Align, AlignMember, Pose
from ..records import AlignRoomArgs, Device, RealDevice
from ..util import Fail, log, write_json
from . import mock, solver
from .geometry import clamp_scale
from .photos import RoomPhoto, load
from .score import Candidate, Diag, score


class AlignRoomResult(Align):
    """align-room's last stdout line: align.json's contents plus "ok": true (calib-cli.schema.json align_room)."""

    ok: bool


def now_iso() -> str:
    return datetime.now(UTC).strftime("%Y-%m-%dT%H:%M:%SZ")


def _device(name: solver.SolverName, want: Device) -> RealDevice:
    if name == "manhattan":
        return "cpu"
    from ..moge_runner import pick_device

    return pick_device(want)


def _choice(s: str) -> solver.SolverChoice:
    for c in solver.SOLVER_CHOICES:
        if c == s:
            return c
    raise Fail(f"there is no solver called {s!r} (auto, {', '.join(c for c in solver.SOLVER_CHOICES if c != 'auto')})")


def _run(name: solver.SolverName, usable: list[RoomPhoto], want: Device) -> tuple[list[Candidate | None], RealDevice]:
    device = _device(name, want)
    return solver.make(name).solve(usable, device), device


def _no_scale(found: list[Candidate | None]) -> bool:
    """Whether a learned solver had no scale for the first photo, so placed only it (solver.from_views, step 4)."""
    first = found[0]
    return first is not None and first.diag.get("scale_source") == "none" and all(c is None for c in found[1:])


def solve(photos: list[RoomPhoto], choice: solver.SolverChoice, want: Device, created: str, t0: float) -> Align:
    """A solver's answer for these photos (module doc)."""
    name: solver.SolverName | None = None
    usable_idx = [i for i, p in enumerate(photos) if p.usable]
    skipped = [p.name for p in photos if not p.usable]
    if skipped:
        log(f"align-room: no calib.json or depth.png for {', '.join(skipped)}: unplaced")
    diag: dict[str, object] = {}
    timing: dict[str, float] = {}
    device: RealDevice | None = None
    cands: list[Candidate | None] = [None] * len(photos)
    if 0 in usable_idx and len(usable_idx) >= 2:
        name = solver.resolve(choice)
        usable = [photos[i] for i in usable_idx]
        t1 = time.monotonic()
        try:
            found, device = _run(name, usable, want)
        except solver.SolverUnavailable as e:
            if choice != "auto" or name == "manhattan":
                raise
            log(f"align-room: {e}: manhattan answers instead")
            diag["fallback"] = f"{name}: {e}"
            name = "manhattan"
            found, device = _run(name, usable, want)
        if name != "manhattan" and _no_scale(found):
            why = f"{name}: no floor or depth overlap on the first photo"
            if choice == "auto":
                log(f"align-room: {why}: manhattan answers instead")
                diag["fallback"] = why
                name = "manhattan"
                found, device = _run(name, usable, want)
            else:
                diag["degenerate"] = why
        timing["solve_s"] = round(time.monotonic() - t1, 2)
        for i, c in zip(usable_idx, found, strict=True):
            cands[i] = c
    else:
        why = "the first photo has no calib.json or depth.png" if 0 not in usable_idx else "fewer than two photos have calib.json and depth.png"
        log(f"align-room: {why}: nothing can be placed")
        diag["nothing_placed"] = why
    t2 = time.monotonic()
    scored, loop = score(photos, cands) if cands[0] is not None else ([], None)
    timing["score_s"] = round(time.monotonic() - t2, 2)
    members: list[AlignMember] = []
    per: list[Diag] = []
    for i, p in enumerate(photos):
        s = scored[i] if scored else None
        if i == 0:
            members.append(AlignMember(scene=p.name, photo_sha256=p.sha256, pose=Pose(x_m=0.0, z_m=0.0, yaw_deg=0.0), scale=1.0,
                                       confidence=1.0, residual_cm=None))
        elif s is None or s.placement is None:
            members.append(AlignMember(scene=p.name, photo_sha256=p.sha256, pose=None, scale=None, confidence=0.0, residual_cm=None))
        else:
            members.append(AlignMember(scene=p.name, photo_sha256=p.sha256, pose=mock.pose_json(s.placement),
                                       scale=round(clamp_scale(s.placement.scale), 6), confidence=s.confidence, residual_cm=s.residual_cm))
        per.append({"scene": p.name, "usable": p.usable, **(s.diag if s is not None else {})})
    diag["members"] = per
    timing["total_s"] = round(time.monotonic() - t0, 2)
    diag["timing"] = timing
    out = Align(version=1, solver=name or "none", created=created, elapsed_s=round(time.monotonic() - t0, 2),
                device=device, loop_residual_cm=loop, members=members,
                unplaced=[m["scene"] for m in members if m["pose"] is None])
    full = cast(dict[str, object], out)
    full["diagnostics"] = diag
    return out


def align_room(args: AlignRoomArgs) -> AlignRoomResult:
    """The command (module doc): align.json written, and the result line."""
    t0 = time.monotonic()
    choice = _choice(args.solver)
    if len(args.scenes) < 2:
        raise Fail("align-room needs at least two scene folders")
    photos = [load(s) for s in args.scenes]
    names = [p.name for p in photos]
    dup = next((n for n in names if names.count(n) > 1), None)
    if dup is not None:
        raise Fail(f"two scene folders are called {dup}")
    created = now_iso()
    mock_dir = os.environ.get("MIDSTUDY_CALIB_MOCK")
    if mock_dir:
        path = mock.answer_path(Path(mock_dir), photos)
        if path.is_file():
            log(f"align-room: calib mock: {path}")
            ans = mock.recorded(path, photos, created)
        else:
            log(f"align-room: calib mock: no answer for these photos ({path.parent.name}): only the first is placed")
            ans = mock.no_match(photos, created)
    else:
        ans = solve(photos, choice, args.device, created, t0)
    write_json(args.out / "align.json", cast(dict[str, object], ans), "align_json")
    placed = sum(1 for m in ans["members"] if m["pose"] is not None)
    loop = ans["loop_residual_cm"]
    log(f"align-room: {ans['solver']}: {placed} of {len(photos)} placed, loop residual "
        f"{'none' if loop is None or not math.isfinite(loop) else f'{loop:.1f} cm'}, {time.monotonic() - t0:.1f} s")
    result = cast(AlignRoomResult, dict(cast(dict[str, object], ans)))
    result["ok"] = True
    return result
