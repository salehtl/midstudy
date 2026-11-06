"""align-room's mock (contract §4.9 Mock, MIDSTUDY_CALIB_MOCK=<dir>): no solver runs.

The key of a set of photos is the lowercase hex SHA-256 of the UTF-8 text made of the members' photo.jpg SHA-256s
(lowercase hex), sorted ascending as strings, joined with "\\n", no trailing newline. With <dir>/rooms/<key>/align.json
present, its answer is written for these folders: each member is matched to the folder whose photo.jpg has its
photo_sha256 and takes that folder's name; members go in argument order; every pose and scale is re-expressed relative
to the first argument (geometry.relative_to); `created` is now; everything else is copied, except that the first
argument, the frame, gets confidence 1 and residual_cm null as align.json's members[0] always does (the recorded answer
may give it a residual when it wasn't the recording's first member). No match: `solver: "none"`, the first argument
the frame, every other member unplaced.
"""
from __future__ import annotations

import hashlib
import math
from collections.abc import Sequence
from pathlib import Path
from typing import cast

from .. import validate
from ..contract_types import Align, AlignMember, Pose
from ..util import Fail, read_json
from .geometry import Placement, clamp_pos, clamp_scale, relative_to, wrap_deg
from .photos import RoomPhoto


def key(shas: Sequence[str]) -> str:
    return hashlib.sha256("\n".join(sorted(shas)).encode("utf-8")).hexdigest()


def answer_path(mock: Path, photos: Sequence[RoomPhoto]) -> Path:
    return mock / "rooms" / key([p.sha256 for p in photos]) / "align.json"


def pose_json(p: Placement) -> Pose:
    """A §4.9 pose (yaw from radians), clamped and rounded as every writer does."""
    return Pose(x_m=round(clamp_pos(p.x), 4) + 0.0, z_m=round(clamp_pos(p.z), 4) + 0.0, yaw_deg=round(wrap_deg(math.degrees(p.yaw)), 3) + 0.0)


def _placement(m: AlignMember) -> Placement | None:
    pose, scale = m["pose"], m["scale"]
    if pose is None or scale is None:
        return None
    return Placement(float(pose["x_m"]), float(pose["z_m"]), math.radians(float(pose["yaw_deg"])), float(scale))


def recorded(path: Path, photos: Sequence[RoomPhoto], created: str) -> Align:
    """The recorded answer at `path` for these photos (module doc). A fixture that doesn't fit them is a Fail."""
    try:
        data = read_json(path)
    except (OSError, ValueError):
        raise Fail(f"the calib mock's {path} isn't readable JSON") from None
    found = validate.problems("align_json", data)
    if found:
        raise Fail(f"the calib mock's {path} doesn't match align.schema.json: {found[0][:200]}")
    ans = cast(Align, data)
    by_sha = {m["photo_sha256"]: m for m in ans["members"]}
    if len(by_sha) != len(ans["members"]) or sorted(by_sha) != sorted(p.sha256 for p in photos):
        raise Fail(f"the calib mock's {path} doesn't list exactly these photos")
    first = _placement(by_sha[photos[0].sha256])
    if first is None:
        raise Fail(f"the calib mock's {path} leaves the first photo ({photos[0].name}) unplaced")
    members: list[AlignMember] = []
    for i, p in enumerate(photos):
        m = by_sha[p.sha256]
        pl = _placement(m)
        if pl is None:
            members.append(AlignMember(scene=p.name, photo_sha256=p.sha256, pose=None, scale=None, confidence=0.0, residual_cm=None))
            continue
        if i == 0:  # members[0] is the frame (§4.9 align.json): confidence 1 and no residual, whatever was recorded for it
            members.append(AlignMember(scene=p.name, photo_sha256=p.sha256, pose=Pose(x_m=0.0, z_m=0.0, yaw_deg=0.0), scale=1.0,
                                       confidence=1.0, residual_cm=None))
            continue
        rel = relative_to(pl, first)
        members.append(AlignMember(scene=p.name, photo_sha256=p.sha256, pose=pose_json(rel), scale=round(clamp_scale(rel.scale), 6),
                                   confidence=m["confidence"], residual_cm=m["residual_cm"]))
    out = dict(cast(dict[str, object], data))  # other top-level keys (diagnostics) are copied too
    out.update({"created": created, "members": members, "unplaced": [m["scene"] for m in members if m["pose"] is None]})
    return cast(Align, out)


def no_match(photos: Sequence[RoomPhoto], created: str) -> Align:
    """No recorded answer: the first photo is the frame, every other one unplaced (contract §4.9 Mock)."""
    members = [AlignMember(scene=p.name, photo_sha256=p.sha256, pose=None, scale=None, confidence=0.0, residual_cm=None) for p in photos]
    members[0] = AlignMember(scene=photos[0].name, photo_sha256=photos[0].sha256, pose=Pose(x_m=0.0, z_m=0.0, yaw_deg=0.0), scale=1.0,
                             confidence=1.0, residual_cm=None)
    return Align(version=1, solver="none", created=created, elapsed_s=0.0, device=None, loop_residual_cm=None, members=members,
                 unplaced=[p.name for p in photos[1:]])
