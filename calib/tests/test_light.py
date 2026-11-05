"""`midstudy-calib light` (contract §4.8): lighting.json alone, for scenes calibrated before it existed. The mock, the
stub (fixtures/stub_calib.py), the failure contract, and the real path on a synthetic room (MoGe replaced by a render
with known geometry), which must give the same lighting.json as fit."""
from __future__ import annotations

import json
import shutil
from pathlib import Path
from typing import cast

import numpy as np
import pytest
from cli_run import CLIS, run_cli
from PIL import Image
from synthetic import REPO, U8, camera, jget, jnum, load_json, render_room

from midstudy_calib import fit as fitmod
from midstudy_calib.contract_types import Camera
from midstudy_calib.moge_runner import MogeOutput
from midstudy_calib.records import Device, Model, RealDevice

GOLDEN = REPO / "fixtures/scenes/living-wide"
MOCK = str(REPO / "fixtures/calib")
UNTOUCHED = ("photo.jpg", "calib.json", "depth.png", "scene.json")


def golden_scene(tmp_path: Path) -> Path:
    """A calibrated scene folder as the server keeps it, without lighting.json (calibrated before it existed)."""
    s = tmp_path / "scene"
    s.mkdir()
    for f in ("photo.jpg", "calib.json", "depth.png"):
        shutil.copyfile(GOLDEN / f, s / f)
    (s / "scene.json").write_text('{"version": 1, "keep": "me"}\n')
    return s


def snapshot(s: Path) -> dict[str, bytes]:
    return {f: (s / f).read_bytes() for f in UNTOUCHED if (s / f).exists()}


@pytest.mark.parametrize("which", list(CLIS))
def test_mock_copies_lighting_and_nothing_else(tmp_path: Path, which: str) -> None:
    s = golden_scene(tmp_path)
    before = snapshot(s)
    code, res, _ = run_cli(which, "light", s, env={"MIDSTUDY_CALIB_MOCK": MOCK})
    want = load_json(GOLDEN / "lighting.json")
    assert code == 0 and res["ok"] is True and res["lighting"] is True, res
    assert set(res) == {"ok", "lighting", "cct_k", "confidence", "elapsed_s"}
    assert res["cct_k"] == jget(want, "white_balance", "cct_k") and res["confidence"] == jget(want, "key", "confidence")
    assert (s / "lighting.json").read_bytes() == (GOLDEN / "lighting.json").read_bytes()
    assert snapshot(s) == before  # calib.json, depth.png, photo.jpg, scene.json byte-identical
    assert sorted(p.name for p in s.iterdir()) == sorted([*UNTOUCHED, "lighting.json"])  # no temp files left


@pytest.mark.parametrize("which", list(CLIS))
def test_mock_miss_writes_nothing(tmp_path: Path, which: str) -> None:
    s = tmp_path / "scene"
    s.mkdir()
    Image.new("RGB", (64, 48), (120, 100, 90)).save(s / "photo.jpg")
    (s / "scene.json").write_text("{}")
    code, res, _ = run_cli(which, "light", s, env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 0 and res["ok"] is True and res["lighting"] is False and isinstance(res["reason"], str) and res["reason"], res
    assert set(res) == {"ok", "lighting", "reason"}
    assert sorted(p.name for p in s.iterdir()) == ["photo.jpg", "scene.json"]
    # an existing lighting.json is left alone
    (s / "lighting.json").write_text('{"stale": true}')
    code, res, _ = run_cli(which, "light", s, env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 0 and res["lighting"] is False and (s / "lighting.json").read_text() == '{"stale": true}'


@pytest.mark.parametrize("which", list(CLIS))
def test_mock_falls_back_to_the_source_hash(tmp_path: Path, which: str) -> None:
    """photo.jpg re-encoded (its hash unknown) but source.jpg the golden upload: the source's entry is used."""
    s = tmp_path / "scene"
    s.mkdir()
    Image.open(GOLDEN / "photo.jpg").save(s / "photo.jpg", quality=80)
    shutil.copyfile(GOLDEN / "photo.jpg", s / "source.jpg")
    code, res, _ = run_cli(which, "light", s, env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 0 and res["lighting"] is True
    assert (s / "lighting.json").read_bytes() == (GOLDEN / "lighting.json").read_bytes()


@pytest.mark.parametrize("which", list(CLIS))
def test_failure_contract(tmp_path: Path, which: str) -> None:
    code, res, err = run_cli(which, "light", tmp_path / "nope", env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 1 and res["ok"] is False and err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    (tmp_path / "empty").mkdir()
    code, res, err = run_cli(which, "light", tmp_path / "empty", env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 1 and "photo.jpg" in str(res["error"]) and err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    assert list((tmp_path / "empty").iterdir()) == []


def test_moge_unavailable_is_a_failure_that_changes_nothing(tmp_path: Path) -> None:
    s = golden_scene(tmp_path)
    (s / "lighting.json").write_text('{"old": true}')
    before = snapshot(s)
    code, res, err = run_cli("midstudy-calib", "light", s, env={"HF_HOME": str(tmp_path / "hf"), "HF_HUB_OFFLINE": "1"})
    assert code == 1 and res["ok"] is False and "MoGe-2 couldn't run" in str(res["error"]), res
    assert err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    assert snapshot(s) == before and (s / "lighting.json").read_text() == '{"old": true}'


# --- the real path, MoGe replaced by a synthetic room ---------------------------------------------------------------
def _fake_moge(monkeypatch: pytest.MonkeyPatch, light_dir: tuple[float, float, float], cam: Camera) -> tuple[U8, list[Path]]:
    room = render_room(light_dir, cam=cam)
    out = room.moge()
    h, w = room.rgb.shape[:2]
    calls: list[Path] = []

    def fake(scene: Path, w_: int, h_: int, model: Model, device: Device) -> tuple[U8, MogeOutput, RealDevice]:
        calls.append(scene)
        assert (w_, h_) == (w, h)
        return room.rgb, out, "cpu"

    monkeypatch.setattr(fitmod, "_infer", fake)
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)
    return room.rgb, calls


def _same_light(a: object, b: object) -> None:
    """Equal lighting.json files apart from the fit's own timing."""
    for x in (a, b):
        fit = jget(x, "fit")
        assert isinstance(fit, dict)
        cast(dict[str, object], fit).pop("elapsed_s")
    assert a == b


def test_light_matches_fit_on_a_synthetic_room(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    cam = camera(60.0, 1.4, -15.0, 0.0)
    rgb, calls = _fake_moge(monkeypatch, (0.6, 0.7, 0.4), cam)
    for d in ("fitted", "light", "nocalib"):
        (tmp_path / d).mkdir()
        Image.fromarray(rgb).save(tmp_path / d / "photo.jpg", quality=95)
    calib = fitmod.fit(tmp_path / "fitted")
    assert calib["floor"]["found"] is True
    want = load_json(tmp_path / "fitted/lighting.json")
    # light on a copy of that calibration: the same lighting.json; calib.json and depth.png untouched
    for f in ("calib.json", "depth.png"):
        shutil.copyfile(tmp_path / "fitted" / f, tmp_path / "light" / f)
    before = snapshot(tmp_path / "light")
    res = fitmod.light(tmp_path / "light")
    assert res["ok"] is True and res["lighting"] is True
    assert res["cct_k"] == jget(want, "white_balance", "cct_k") and res["confidence"] == jget(want, "key", "confidence")
    _same_light(load_json(tmp_path / "light/lighting.json"), want)
    assert snapshot(tmp_path / "light") == before
    # without calib.json the camera comes from the same floor fit: the same light again, and nothing else written
    fitmod.light(tmp_path / "nocalib")
    _same_light(load_json(tmp_path / "nocalib/lighting.json"), load_json(tmp_path / "fitted/lighting.json"))
    assert sorted(p.name for p in (tmp_path / "nocalib").iterdir()) == ["lighting.json", "photo.jpg"]
    assert len(calls) == 3


def test_light_uses_a_fitted_calib_camera(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A manual-looking calib.json camera that was fitted to a floor is the one the light is fitted (and stored) with."""
    cam = camera(60.0, 1.4, -15.0, 0.0)
    rgb, _ = _fake_moge(monkeypatch, (0.6, 0.7, 0.4), cam)
    s = tmp_path / "s"
    s.mkdir()
    Image.fromarray(rgb).save(s / "photo.jpg", quality=95)
    mine = {"fov_y_deg": 58.0, "height_m": 1.45, "pitch_deg": -14.0, "roll_deg": 0.5}
    (s / "calib.json").write_text(json.dumps({"version": 1, "camera": mine, "floor": {"found": True}}))
    fitmod.light(s)
    assert jget(load_json(s / "lighting.json"), "camera") == mine
    # a fallback calibration (no floor) loses to this floor fit
    (s / "calib.json").write_text(json.dumps({"version": 1, "camera": mine, "floor": {"found": False}}))
    fitmod.light(s)
    got = load_json(s / "lighting.json")
    assert abs(jnum(got, "camera", "pitch_deg") - cam["pitch_deg"]) < 1 and abs(jnum(got, "camera", "roll_deg")) < 1


def test_too_little_to_go_on_writes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    h, w = 60, 80
    nan = np.full((h, w, 3), np.nan, np.float32)
    out = MogeOutput(points=nan, normal=nan, mask=np.zeros((h, w), np.bool_), intrinsics=np.array([[1, 0, .5], [0, 1.3, .5], [0, 0, 1]], np.float32),
                     load_s=0.0, infer_s=0.0, repo="synthetic")

    def fake(scene: Path, w_: int, h_: int, model: Model, device: Device) -> tuple[U8, MogeOutput, RealDevice]:
        return np.zeros((h, w, 3), np.uint8), out, "cpu"

    monkeypatch.setattr(fitmod, "_infer", fake)
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)
    s = tmp_path / "s"
    s.mkdir()
    Image.new("RGB", (w, h)).save(s / "photo.jpg")
    (s / "lighting.json").write_text('{"old": true}')
    res = fitmod.light(s)
    assert res == {"ok": True, "lighting": False, "reason": fitmod.NO_LIGHT}
    assert (s / "lighting.json").read_text() == '{"old": true}'
    assert sorted(p.name for p in s.iterdir()) == ["lighting.json", "photo.jpg"]
