"""`midstudy-calib align-room` (contract §4.3, §4.9 Align): the pose convention, the mock (key, renaming,
re-expression, no match), the output contract and its failures, scoring, Manhattan, the worker, and from_views (a
learned solver's cameras -> §4.9 poses) on cameras made from the golden room's truth. No MASt3R needed here:
test_align_room_golden.py runs the real solver."""
from __future__ import annotations

import dataclasses
import hashlib
import json
import math
import shutil
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from cli_run import run_cli
from synthetic import REPO, jget, jlist, jnum, load_json
from test_worker import Worker

from midstudy_calib import validate
from midstudy_calib.cli import ServeArgs, parse_request
from midstudy_calib.records import AlignRoomArgs
from midstudy_calib.rooms import mast3r, mock, solver
from midstudy_calib.rooms.command import align_room
from midstudy_calib.rooms.geometry import F64, Placement, relative_to, ry, wrap_deg
from midstudy_calib.rooms.photos import FLIP, RoomPhoto, load
from midstudy_calib.rooms.score import Candidate, constraint, score
from midstudy_calib.util import write_json
from midstudy_calib.validate import ContractViolation

SCENES = REPO / "fixtures/scenes"
CALIB_MOCK = REPO / "fixtures/calib"
MOCK = {"MIDSTUDY_CALIB_MOCK": str(CALIB_MOCK)}
ROOM = ["living-wide", "room-1", "room-2", "room-3", "room-4", "room-5", "room-6"]
GOLDEN_ROOM_KEY = "7a1df71b328ae1ddd1f86d143455f646d1b5a8fbf2ea7cfc3d5dd1d293e7f9cc"  # docs/notes/rooms-foundation.md
GOLDEN_PAIR_KEY = "d1ebc6e011116bf13e32891aee3b5d49ed13909fef1b6fbb1433d58aa0483dba"


def truth_pose(sid: str) -> Placement:
    """The fixture's pose_in_room (the five original scenes stand at living-wide's camera: the frame)."""
    t = cast(dict[str, object], load_json(SCENES / sid / "truth.json"))
    if "pose_in_room" not in t:
        return Placement(0.0, 0.0, 0.0, 1.0)
    return Placement(jnum(t, "pose_in_room", "x_m"), jnum(t, "pose_in_room", "z_m"), math.radians(jnum(t, "pose_in_room", "yaw_deg")), 1.0)


def copy_scenes(tmp: Path, ids: list[str], names: list[str] | None = None) -> list[Path]:
    """The golden scenes under other names (the mock must rename by photo SHA-256, not by folder name)."""
    out: list[Path] = []
    for i, sid in enumerate(ids):
        d = tmp / (names[i] if names else f"scene-{i:02d}")
        shutil.copytree(SCENES / sid, d)
        out.append(d)
    return out


def tree_digest(dirs: list[Path]) -> str:
    h = hashlib.sha256()
    for d in dirs:
        for p in sorted(d.rglob("*")):
            h.update(str(p.relative_to(d.parent)).encode())
            if p.is_file():
                h.update(p.read_bytes())
    return h.hexdigest()


# ---------------------------------------------------------------------------------------------------- the convention


def test_yaw_wraps_into_the_contract_range() -> None:
    for a, want in [(0, 0), (180, 180), (-180, 180), (190, -170), (-190, 170), (540, 180), (-540, 180), (359.5, -0.5), (179.999, 179.999)]:
        assert wrap_deg(a) == pytest.approx(want, abs=1e-9), a


def test_ry_turns_plus_x_toward_minus_z() -> None:
    """Contract §4.9: positive yaw is counterclockwise seen from above, the sign of rotation_y_deg."""
    assert np.allclose(ry(math.pi / 2) @ np.array([1.0, 0.0, 0.0]), [0.0, 0.0, -1.0])


def test_pose_maps_are_inverse_and_relative_to_composes() -> None:
    rng = np.random.default_rng(1)
    for _ in range(50):
        a, b = (Placement(float(rng.uniform(-5, 5)), float(rng.uniform(-5, 5)), float(rng.uniform(-math.pi, math.pi)), float(rng.uniform(0.5, 2.0)))
                for _ in range(2))
        q = rng.uniform(-3, 3, (20, 3))
        assert np.allclose(a.room_to_scene(a.scene_to_room(q)), q)
        rel = relative_to(b, a)  # b's frame in a's: a point of b's scene, through the room, into a's scene
        assert np.allclose(rel.scene_to_room(q), a.room_to_scene(b.scene_to_room(q)))
        f = relative_to(a, a)
        assert (f.x, f.z, f.yaw, f.scale) == pytest.approx((0, 0, 0, 1))


def test_the_truth_poses_carry_the_sofa_between_photos() -> None:
    """The fixtures' truth (in each photo's own frame) agrees with the convention: the room's sofa corners, through
    living-wide's and room-k's poses, land on room-k's own truth corners."""
    lw = cast(dict[str, object], load_json(SCENES / "living-wide/truth.json"))
    corners_lw = np.asarray(jget(lw, "objects", "sofa", "corners"), np.float64)
    for sid in ROOM[1:6]:
        own = np.asarray(jget(load_json(SCENES / sid / "truth.json"), "objects", "sofa", "corners"), np.float64)
        got = truth_pose(sid).room_to_scene(truth_pose("living-wide").scene_to_room(corners_lw))
        assert np.allclose(got, own, atol=1e-4), sid


# ---------------------------------------------------------------------------------------------------- the mock


def test_mock_key_is_the_contract_rule() -> None:
    shas = [load(SCENES / s).sha256 for s in ROOM]
    assert mock.key(shas) == GOLDEN_ROOM_KEY
    assert mock.key(list(reversed(shas))) == GOLDEN_ROOM_KEY
    assert mock.key(shas[:2]) == GOLDEN_PAIR_KEY
    text = "\n".join(sorted(shas))
    assert not text.endswith("\n") and mock.key(shas) == hashlib.sha256(text.encode()).hexdigest()
    assert (CALIB_MOCK / "rooms" / GOLDEN_ROOM_KEY / "align.json").is_file()


def test_mock_renames_reorders_and_re_expresses(tmp_path: Path) -> None:
    """Any member first, folders under other names: members follow the arguments, each named after its folder, poses
    relative to the first argument; align.json is the result line without "ok"; the scenes are untouched."""
    order = ["room-3", "room-6", "living-wide", "room-5", "room-1", "room-4", "room-2"]
    dirs = copy_scenes(tmp_path, order)
    before = tree_digest(dirs)
    out = tmp_path / "rooms/room-x"
    code, res, err = run_cli("midstudy-calib", "align-room", *dirs, "--out", out, env=MOCK)
    assert code == 0, err
    assert validate.problems("align_room", res) == []
    assert res["ok"] is True and res["solver"] == "truth" and res["unplaced"] == []
    written = load_json(out / "align.json")
    assert written == {k: v for k, v in res.items() if k != "ok"}
    assert validate.problems("align_json", written) == []
    assert tree_digest(dirs) == before
    assert sorted(p.name for p in out.iterdir()) == ["align.json"]
    members = jlist(res, "members")
    assert [jget(m, "scene") for m in members] == [d.name for d in dirs]
    a = truth_pose(order[0])
    for sid, m in zip(order, members, strict=True):
        want = relative_to(truth_pose(sid), a)
        assert jget(m, "photo_sha256") == load(SCENES / sid).sha256
        assert jnum(m, "pose", "x_m") == pytest.approx(want.x, abs=1e-4)
        assert jnum(m, "pose", "z_m") == pytest.approx(want.z, abs=1e-4)
        assert jnum(m, "pose", "yaw_deg") == pytest.approx(wrap_deg(math.degrees(want.yaw)), abs=1e-3)
        assert jnum(m, "scale") == 1
    assert jget(members[0], "pose") == {"x_m": 0, "z_m": 0, "yaw_deg": 0}
    assert jget(members[0], "confidence") == 1 and jget(members[0], "residual_cm") is None  # recorded for room-3: 0


def test_mock_without_a_match_places_only_the_first(tmp_path: Path) -> None:
    dirs = copy_scenes(tmp_path, ["room-1", "room-2", "room-5"])
    code, res, _ = run_cli("midstudy-calib", "align-room", *dirs, "--out", tmp_path / "r", env=MOCK)
    assert code == 0 and validate.problems("align_room", res) == []
    assert res["solver"] == "none" and res["loop_residual_cm"] is None and res["unplaced"] == ["scene-01", "scene-02"]
    m = jlist(res, "members")
    assert jget(m[0], "pose") == {"x_m": 0, "z_m": 0, "yaw_deg": 0} and jget(m[0], "confidence") == 1
    assert all(jget(x, "pose") is None and jget(x, "scale") is None and jget(x, "confidence") == 0 for x in m[1:])


def test_mock_fixture_that_leaves_the_first_unplaced_is_a_failure(tmp_path: Path) -> None:
    dirs = copy_scenes(tmp_path, ["living-wide", "room-1"])
    ans = cast(dict[str, object], load_json(CALIB_MOCK / "rooms" / GOLDEN_PAIR_KEY / "align.json"))
    members = cast(list[dict[str, object]], ans["members"])
    members[0].update({"pose": None, "scale": None, "confidence": 0})
    ans["unplaced"] = [members[0]["scene"]]
    fake = tmp_path / "mock/rooms" / GOLDEN_PAIR_KEY
    fake.mkdir(parents=True)
    (fake / "align.json").write_text(json.dumps(ans))
    code, res, err = run_cli("midstudy-calib", "align-room", *dirs, "--out", tmp_path / "r", env={"MIDSTUDY_CALIB_MOCK": str(tmp_path / "mock")})
    assert code == 1 and "leaves the first photo" in str(res["error"]) and err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    assert not (tmp_path / "r").exists()


# ---------------------------------------------------------------------------------------------------- the output contract


@pytest.mark.parametrize(("case", "needle"), [
    ("one", "at least two scene folders"),
    ("no-photo", "has no photo.jpg"),
    ("missing", "isn't a scene folder"),
    ("dup", "two scene folders are called"),
    ("solver", "there is no solver called 'vggt'"),
    ("bad-name", "isn't a scene name"),
])
def test_failures_are_one_sentence(tmp_path: Path, case: str, needle: str) -> None:
    a, b = copy_scenes(tmp_path, ["living-wide", "room-1"])
    args: list[str | Path] = [a, b]
    if case == "one":
        args = [a]
    elif case == "no-photo":
        (b / "photo.jpg").unlink()
    elif case == "missing":
        args = [a, tmp_path / "nope"]
    elif case == "dup":
        (tmp_path / "x").mkdir()
        args = [a, shutil.copytree(a, tmp_path / "x" / a.name)]
    elif case == "solver":
        args = [a, b, "--solver", "vggt"]
    else:
        args = [a, shutil.copytree(b, tmp_path / "Not_A_Slug")]
    code, res, err = run_cli("midstudy-calib", "align-room", *args, "--out", tmp_path / "r", env=MOCK)
    assert code == 1 and res["ok"] is False and needle in str(res["error"]), res
    assert validate.problems("error", res) == []
    assert err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    assert not (tmp_path / "r").exists()


def test_align_json_is_checked_before_it_is_written(tmp_path: Path) -> None:
    """A bug that would write a pose outside the contract's ranges raises ContractViolation and writes nothing."""
    ans = cast(dict[str, object], load_json(CALIB_MOCK / "rooms" / GOLDEN_PAIR_KEY / "align.json"))
    cast(dict[str, object], cast(list[dict[str, object]], ans["members"])[1]["pose"])["yaw_deg"] = 200
    with pytest.raises(ContractViolation):
        write_json(tmp_path / "align.json", ans, "align_json")
    assert not (tmp_path / "align.json").exists()


def test_the_worker_answers_align_room(tmp_path: Path) -> None:
    dirs = copy_scenes(tmp_path, ["living-wide", "room-1"])
    code, one, _ = run_cli("midstudy-calib", "align-room", *dirs, "--out", tmp_path / "one", env=MOCK)
    assert code == 0
    with Worker(MOCK) as w:
        w.request("a-1", "align-room", *dirs, "--out", tmp_path / "srv")
        got = w.answer()
        w.request("a-2", "align-room", dirs[0], "--out", tmp_path / "srv2")
        bad = w.answer()
        assert w.close() == 0
    assert got["id"] == "a-1" and validate.problems("align_room", got) == []
    assert {k: v for k, v in got.items() if k not in ("id", "created")} == {k: v for k, v in one.items() if k != "created"}
    assert load_json(tmp_path / "srv/align.json") == {k: v for k, v in got.items() if k not in ("id", "ok")}
    assert bad["id"] == "a-2" and bad["ok"] is False and "at least two" in str(bad["error"])
    parsed = parse_request("align-room", ["/a", "/b", "--out", "/r", "--solver", "manhattan"], ServeArgs("vitl", "cpu"))
    assert parsed == AlignRoomArgs([Path("/a"), Path("/b")], Path("/r"), "manhattan", "cpu")


# ---------------------------------------------------------------------------------------------------- solvers


def test_mast3r_matches_every_pair_up_to_12_photos_then_a_window() -> None:
    assert [mast3r.scene_graph(n) for n in (2, 7, 12, 13, 22, 26, 32)] == ["complete"] * 3 + ["swin-5", "swin-5", "swin-5", "swin-4"]


def test_auto_picks_mast3r_only_when_installed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mast3r, "installed", lambda: False)
    assert solver.resolve("auto") == "manhattan"
    assert solver.resolve("manhattan") == "manhattan"
    with pytest.raises(solver.SolverUnavailable, match="isn't installed"):
        solver.resolve("mast3r")
    monkeypatch.setattr(mast3r, "installed", lambda: True)
    assert solver.resolve("auto") == "mast3r"


def test_auto_falls_back_to_manhattan_when_mast3r_cannot_load(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """MASt3R installed but unable to fetch its code or weights the first time: auto answers with manhattan and says
    why; --solver mast3r is a failure."""
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)
    monkeypatch.setattr(mast3r, "installed", lambda: True)

    def no_network(device: str) -> object:
        raise solver.SolverUnavailable("couldn't fetch MASt3R's code (git clone: offline)")

    monkeypatch.setattr(mast3r, "load", no_network)
    dirs = copy_scenes(tmp_path, ["living-wide", "room-2", "room-3"])
    res = align_room(AlignRoomArgs(dirs, tmp_path / "r", "auto", "cpu"))
    assert res["solver"] == "manhattan" and "offline" in str(jget(res, "diagnostics", "fallback"))
    with pytest.raises(solver.SolverUnavailable):
        align_room(AlignRoomArgs(dirs, tmp_path / "r2", "mast3r", "cpu"))


def test_manhattan_places_the_overlapping_photos(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The no-ML fallback on three photos that share walls: valid, device cpu, every photo placed with the right turn.
    Its position is only as good as its 2 % scale grid (Phase A: up to ~14 cm on these fixtures, at high confidence;
    the documented weakness of the fallback, docs/notes/rooms-calib.md), so this pins 20 cm, not the 5 cm target."""
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)
    ids = ["living-wide", "room-2", "room-3"]
    res = align_room(AlignRoomArgs([SCENES / s for s in ids], tmp_path / "r", "manhattan", "auto"))
    assert validate.problems("align_room", res) == []
    assert res["solver"] == "manhattan" and res["device"] == "cpu"
    for sid, m in zip(ids, res["members"], strict=True):
        pose, scale = m["pose"], m["scale"]
        assert pose is not None and scale is not None, sid
        want = truth_pose(sid)
        assert 100 * math.hypot(pose["x_m"] - want.x, pose["z_m"] - want.z) <= 20.0, (sid, pose)
        assert abs(wrap_deg(pose["yaw_deg"] - math.degrees(want.yaw))) <= 1.5, (sid, pose)
        assert abs(scale - 1) <= 0.0201 and m["confidence"] >= 0.5


def test_a_photo_without_calibration_is_unplaced(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)
    dirs = copy_scenes(tmp_path, ["living-wide", "room-2", "room-3"])
    (dirs[1] / "calib.json").unlink()
    res = align_room(AlignRoomArgs(dirs, tmp_path / "r", "manhattan", "cpu"))
    assert res["unplaced"] == [dirs[1].name] and res["members"][2]["pose"] is not None
    (dirs[0] / "depth.png").unlink()  # the frame itself can't be scored: nothing is placed
    res = align_room(AlignRoomArgs(dirs, tmp_path / "r", "manhattan", "cpu"))
    assert res["solver"] == "none" and res["device"] is None and res["unplaced"] == [d.name for d in dirs[1:]]
    assert validate.problems("align_room", res) == []


# ---------------------------------------------------------------------------------------------------- scoring


def test_the_constraint_factor_finds_the_bare_wall() -> None:
    """Phase A: λmin/λmax of the horizontal normals is ~0 for room-6 (a bare wall) and ≥ 0.3 for the others."""
    for sid in ROOM:
        c = constraint(load(SCENES / sid))
        assert (c < 0.02) if sid == "room-6" else (c > 0.3), (sid, c)


def test_truth_scores_confident_and_the_bare_wall_unplaced() -> None:
    photos = [load(SCENES / s) for s in ROOM]
    a = truth_pose(ROOM[0])
    cands: list[Candidate | None] = [Candidate(relative_to(truth_pose(s), a)) for s in ROOM]
    scored, loop = score(photos, cands)
    assert loop is not None and loop < 0.5
    for sid, s in zip(ROOM, scored, strict=True):
        if sid == "room-6":
            assert s.placement is None and s.confidence == 0 and "rejected_x_m" in s.diag
        else:
            assert s.placement is not None and s.confidence >= 0.5, (sid, s)
            assert sid == "living-wide" or (s.residual_cm is not None and s.residual_cm < 1.5)


def test_a_wrong_placement_is_not_confident() -> None:
    """room-1 moved 40 cm along its view: the depth no longer agrees and it is unplaced."""
    photos = [load(SCENES / s) for s in ("living-wide", "room-1", "room-2")]
    t = [truth_pose(s) for s in ("living-wide", "room-1", "room-2")]
    off = Placement(t[1].x + 0.4 * -math.sin(t[1].yaw), t[1].z + 0.4 * -math.cos(t[1].yaw), t[1].yaw, 1.0)
    scored, _ = score(photos, [Candidate(t[0]), Candidate(off), Candidate(t[2])])
    assert scored[1].placement is None and scored[2].placement is not None


def test_depth_png_is_scored_at_its_own_scale() -> None:
    """MoGe-2's depth.png can disagree with its own height_m by several per cent (docs/notes/rooms-calib-real.md):
    room-2's depth 7 % deeper than its camera height says leaves its true pose far apart from the others at the
    height's scale, and in agreement again when the candidate carries depth.png's own scale (Candidate.depth_scale)."""
    photos = [load(SCENES / s) for s in ("living-wide", "room-1", "room-2")]
    photos[2] = dataclasses.replace(photos[2], depth=photos[2].dep() * 1.07)
    t = [truth_pose(s) for s in ("living-wide", "room-1", "room-2")]
    floor, _ = score(photos, [Candidate(p) for p in t], min_confidence=0.0)
    own, _ = score(photos, [Candidate(t[0]), Candidate(t[1]), Candidate(t[2], depth_scale=1 / 1.07)], min_confidence=0.0)
    r_floor, r_own = floor[2].residual_cm, own[2].residual_cm
    assert r_floor is not None and r_own is not None and r_floor > 10 and r_own < 1.5, (r_floor, r_own)
    assert own[2].confidence > floor[2].confidence


def test_robust_up_leaves_out_a_tilted_view() -> None:
    """A view whose up is 5° off (a photo whose calibrated pitch is off) doesn't move the room's up."""
    ups = [np.array([math.sin(math.radians(a)), math.cos(math.radians(a)), 0.0]) for a in (0.2, -0.3, 0.1, 0.0, 5.0)]
    u, keep = solver.robust_up(ups)
    assert keep == [True, True, True, True, False]
    assert math.degrees(math.acos(float(np.clip(u[1], -1.0, 1.0)))) < 0.1
    u2, keep2 = solver.robust_up([*ups[:2], ups[4]])
    assert sum(keep2) == 2 and keep2[2] is False and float(u2[1]) > 0.9999


# ---------------------------------------------------------------------------------------------------- from_views


def _views_from_truth(photos: list[RoomPhoto], sigma: float, seed: int) -> list[solver.View]:
    """What an exact learned solver would answer: each camera's pose and depth (floor included) from the fixtures'
    truth, in an arbitrary solver frame (a random rotation, shift and scale 1/sigma), OpenCV axes."""
    rng = np.random.default_rng(seed)
    q, _ = np.linalg.qr(rng.normal(size=(3, 3)))
    q = q * np.sign(np.linalg.det(q))
    tau = rng.normal(size=3)
    views: list[solver.View] = []
    for p in photos:
        cam = p.cam()
        pose = truth_pose(p.name)
        d = p.dep()
        dh, dw = d.shape
        f = (dh / 2) / math.tan(cam.fov_y / 2)
        jj, ii = np.mgrid[0:dh, 0:dw]
        dirs = np.stack([(ii + 0.5 - dw / 2) / f, -(jj + 0.5 - dh / 2) / f, -np.ones_like(d)], axis=-1) @ p.r_gl.T
        with np.errstate(divide="ignore"):
            floor = np.where(dirs[..., 1] < -1e-6, cam.height / -dirs[..., 1], 0.0)
        full: F64 = np.where(d > 0, d, floor)
        r_room = ry(pose.yaw) @ p.r_cv
        c2w = np.eye(4)
        c2w[:3, :3] = q @ r_room
        c2w[:3, 3] = q @ np.array([pose.x, cam.height, pose.z]) / sigma + tau
        k = np.array([[f, 0, dw / 2], [0, f, dh / 2], [0, 0, 1]])
        cols: F64 = (np.arange(dw, dtype=np.float64) + 0.5) / dw
        rows: F64 = (np.arange(dh, dtype=np.float64) + 0.5) / dh
        views.append(solver.View(c2w, k, full / sigma, np.ones_like(full), np.tile(cols, (dh, 1)), np.tile(rows[:, None], (1, dw))))
    return views


@pytest.mark.parametrize("first", ["living-wide", "room-4"])
def test_from_views_recovers_the_truth(first: str) -> None:
    ids = [first, *[s for s in ROOM if s != first]]
    photos = [load(SCENES / s) for s in ids]
    cands = solver.from_views(photos, _views_from_truth(photos, sigma=2.7, seed=len(first)))
    a = truth_pose(first)
    for sid, c in zip(ids, cands, strict=True):
        assert c is not None
        want = relative_to(truth_pose(sid), a)
        got = c.placement
        assert math.hypot(got.x - want.x, got.z - want.z) < 1e-3, (sid, got, want)
        assert abs(wrap_deg(math.degrees(got.yaw - want.yaw))) < 0.01, sid
        assert got.scale == pytest.approx(1.0, abs=1e-3), sid
        assert c.tilt_deg < 0.01 and c.diag["scale_source"] == "floor"


def test_from_views_gives_each_photo_its_own_scale() -> None:
    """A member whose calibration says it is 10 % lower than it is: the solver's floor makes its scale 1/0.9."""
    photos = [load(SCENES / s) for s in ("living-wide", "room-1", "room-2")]
    views = _views_from_truth(photos, sigma=1.0, seed=3)
    cam = photos[1].cam()
    low = RoomPhoto(photos[1].path, photos[1].name, photos[1].sha256, photos[1].w, photos[1].h,
                    type(cam)(cam.fov_y, cam.height * 0.9, cam.pitch, cam.roll), photos[1].depth)
    cands = solver.from_views([photos[0], low, photos[2]], views)
    assert cands[1] is not None and cands[1].placement.scale == pytest.approx(1 / 0.9, rel=1e-3)
    assert cands[2] is not None and cands[2].placement.scale == pytest.approx(1.0, rel=1e-3)


def test_flip_is_the_opencv_axes() -> None:
    assert np.array_equal(FLIP, np.diag([1.0, -1.0, -1.0]))
