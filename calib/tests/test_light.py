"""`midstudy-calib light` (contract §4.8): lighting.json alone, for scenes calibrated before it existed. The mock, the
stub (fixtures/stub_calib.py), the failure contract, and the real path on a synthetic room (MoGe replaced by a render
with known geometry), which must give the same lighting.json as fit."""
from __future__ import annotations

import json
import math
import os
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from midstudy_calib import fit as fitmod

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_lighting import _render  # noqa: E402

REPO = Path(__file__).resolve().parents[2]
GOLDEN = REPO / "fixtures/scenes/living-wide"
MOCK = str(REPO / "fixtures/calib")
UNTOUCHED = ("photo.jpg", "calib.json", "depth.png", "scene.json")
CLIS = {"midstudy-calib": [sys.executable, "-m", "midstudy_calib.cli"], "stub": [sys.executable, str(REPO / "fixtures/stub_calib.py")]}


def run(which: str, *args, env=None):
    e = {k: v for k, v in os.environ.items() if k != "MIDSTUDY_CALIB_MOCK"}
    e.update(env or {})
    p = subprocess.run([*CLIS[which], *map(str, args)], capture_output=True, text=True, env=e)
    lines = p.stdout.strip().splitlines()
    assert len(lines) == 1, p.stdout  # nothing else reaches stdout
    return p.returncode, json.loads(lines[-1]), p.stderr


def golden_scene(tmp_path: Path) -> Path:
    """A calibrated scene folder as the server keeps it, without lighting.json (calibrated before it existed)."""
    s = tmp_path / "scene"
    s.mkdir()
    for f in ("photo.jpg", "calib.json", "depth.png"):
        shutil.copyfile(GOLDEN / f, s / f)
    (s / "scene.json").write_text('{"version": 1, "keep": "me"}\n')
    return s


def snapshot(s: Path) -> dict:
    return {f: (s / f).read_bytes() for f in UNTOUCHED if (s / f).exists()}


@pytest.mark.parametrize("which", list(CLIS))
def test_mock_copies_lighting_and_nothing_else(tmp_path, which):
    s = golden_scene(tmp_path)
    before = snapshot(s)
    code, res, _ = run(which, "light", s, env={"MIDSTUDY_CALIB_MOCK": MOCK})
    want = json.loads((GOLDEN / "lighting.json").read_text())
    assert code == 0 and res["ok"] is True and res["lighting"] is True, res
    assert set(res) == {"ok", "lighting", "cct_k", "confidence", "elapsed_s"}
    assert res["cct_k"] == want["white_balance"]["cct_k"] and res["confidence"] == want["key"]["confidence"]
    assert (s / "lighting.json").read_bytes() == (GOLDEN / "lighting.json").read_bytes()
    assert snapshot(s) == before  # calib.json, depth.png, photo.jpg, scene.json byte-identical
    assert sorted(p.name for p in s.iterdir()) == sorted([*UNTOUCHED, "lighting.json"])  # no temp files left


@pytest.mark.parametrize("which", list(CLIS))
def test_mock_miss_writes_nothing(tmp_path, which):
    s = tmp_path / "scene"
    s.mkdir()
    Image.new("RGB", (64, 48), (120, 100, 90)).save(s / "photo.jpg")
    (s / "scene.json").write_text("{}")
    code, res, _ = run(which, "light", s, env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 0 and res["ok"] is True and res["lighting"] is False and isinstance(res["reason"], str) and res["reason"], res
    assert set(res) == {"ok", "lighting", "reason"}
    assert sorted(p.name for p in s.iterdir()) == ["photo.jpg", "scene.json"]
    # an existing lighting.json is left alone
    (s / "lighting.json").write_text('{"stale": true}')
    code, res, _ = run(which, "light", s, env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 0 and res["lighting"] is False and (s / "lighting.json").read_text() == '{"stale": true}'


@pytest.mark.parametrize("which", list(CLIS))
def test_mock_falls_back_to_the_source_hash(tmp_path, which):
    """photo.jpg re-encoded (its hash unknown) but source.jpg the golden upload: the source's entry is used."""
    s = tmp_path / "scene"
    s.mkdir()
    Image.open(GOLDEN / "photo.jpg").save(s / "photo.jpg", quality=80)
    shutil.copyfile(GOLDEN / "photo.jpg", s / "source.jpg")
    code, res, _ = run(which, "light", s, env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 0 and res["lighting"] is True
    assert (s / "lighting.json").read_bytes() == (GOLDEN / "lighting.json").read_bytes()


@pytest.mark.parametrize("which", list(CLIS))
def test_failure_contract(tmp_path, which):
    code, res, err = run(which, "light", tmp_path / "nope", env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 1 and res["ok"] is False and err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    (tmp_path / "empty").mkdir()
    code, res, err = run(which, "light", tmp_path / "empty", env={"MIDSTUDY_CALIB_MOCK": MOCK})
    assert code == 1 and "photo.jpg" in res["error"] and err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    assert list((tmp_path / "empty").iterdir()) == []


def test_moge_unavailable_is_a_failure_that_changes_nothing(tmp_path):
    s = golden_scene(tmp_path)
    (s / "lighting.json").write_text('{"old": true}')
    before = snapshot(s)
    code, res, err = run("midstudy-calib", "light", s, env={"HF_HOME": str(tmp_path / "hf"), "HF_HUB_OFFLINE": "1"})
    assert code == 1 and res["ok"] is False and "MoGe-2 couldn't run" in res["error"], res
    assert err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    assert snapshot(s) == before and (s / "lighting.json").read_text() == '{"old": true}'


# --- the real path, MoGe replaced by a synthetic room ---------------------------------------------------------------
def _fake_moge(monkeypatch, light_dir, cam):
    rgb, pts, nrm, valid, cam, _, _ = _render(light_dir, cam=cam)
    h, w = rgb.shape[:2]
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    K = np.array([[f / w, 0, 0.5], [0, f / h, 0.5], [0, 0, 1]])
    out = {"points": pts.astype(np.float32), "normal": nrm.astype(np.float32), "mask": valid, "intrinsics": K,
           "load_s": 0.0, "infer_s": 0.0, "repo": "synthetic"}
    calls = []

    def fake(scene, w_, h_, model, device):
        calls.append(scene)
        assert (w_, h_) == (w, h)
        return rgb, out, "cpu"

    monkeypatch.setattr(fitmod, "_infer", fake)
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)
    return rgb, calls


def _same_light(a: dict, b: dict) -> None:
    a, b = json.loads(json.dumps(a)), json.loads(json.dumps(b))
    a["fit"].pop("elapsed_s"), b["fit"].pop("elapsed_s")
    assert a == b


def test_light_matches_fit_on_a_synthetic_room(tmp_path, monkeypatch):
    cam = {"fov_y_deg": 60.0, "height_m": 1.4, "pitch_deg": -15.0, "roll_deg": 0.0}
    rgb, calls = _fake_moge(monkeypatch, (0.6, 0.7, 0.4), cam)
    for d in ("fitted", "light", "nocalib"):
        (tmp_path / d).mkdir()
        Image.fromarray(rgb).save(tmp_path / d / "photo.jpg", quality=95)
    calib = fitmod.fit(tmp_path / "fitted")
    assert calib["floor"]["found"] is True
    want = json.loads((tmp_path / "fitted/lighting.json").read_text())
    # light on a copy of that calibration: the same lighting.json; calib.json and depth.png untouched
    for f in ("calib.json", "depth.png"):
        shutil.copyfile(tmp_path / "fitted" / f, tmp_path / "light" / f)
    before = snapshot(tmp_path / "light")
    res = fitmod.light(tmp_path / "light")
    assert res["ok"] is True and res["lighting"] is True and res["cct_k"] == want["white_balance"]["cct_k"]
    assert res["confidence"] == want["key"]["confidence"]
    _same_light(json.loads((tmp_path / "light/lighting.json").read_text()), want)
    assert snapshot(tmp_path / "light") == before
    # without calib.json the camera comes from the same floor fit: the same light again, and nothing else written
    fitmod.light(tmp_path / "nocalib")
    _same_light(json.loads((tmp_path / "nocalib/lighting.json").read_text()), want)
    assert sorted(p.name for p in (tmp_path / "nocalib").iterdir()) == ["lighting.json", "photo.jpg"]
    assert len(calls) == 3


def test_light_uses_a_fitted_calib_camera(tmp_path, monkeypatch):
    """A manual-looking calib.json camera that was fitted to a floor is the one the light is fitted (and stored) with."""
    cam = {"fov_y_deg": 60.0, "height_m": 1.4, "pitch_deg": -15.0, "roll_deg": 0.0}
    rgb, _ = _fake_moge(monkeypatch, (0.6, 0.7, 0.4), cam)
    s = tmp_path / "s"
    s.mkdir()
    Image.fromarray(rgb).save(s / "photo.jpg", quality=95)
    mine = {"fov_y_deg": 58.0, "height_m": 1.45, "pitch_deg": -14.0, "roll_deg": 0.5}
    (s / "calib.json").write_text(json.dumps({"version": 1, "camera": mine, "floor": {"found": True}}))
    fitmod.light(s)
    assert json.loads((s / "lighting.json").read_text())["camera"] == mine
    # a fallback calibration (no floor) loses to this floor fit
    (s / "calib.json").write_text(json.dumps({"version": 1, "camera": mine, "floor": {"found": False}}))
    fitmod.light(s)
    got = json.loads((s / "lighting.json").read_text())["camera"]
    assert abs(got["pitch_deg"] - cam["pitch_deg"]) < 1 and abs(got["roll_deg"]) < 1


def test_too_little_to_go_on_writes_nothing(tmp_path, monkeypatch):
    h, w = 60, 80
    nan = np.full((h, w, 3), np.nan, np.float32)
    out = {"points": nan, "normal": nan, "mask": np.zeros((h, w), bool), "intrinsics": np.array([[1, 0, .5], [0, 1.3, .5], [0, 0, 1]]),
           "load_s": 0.0, "infer_s": 0.0, "repo": "synthetic"}
    monkeypatch.setattr(fitmod, "_infer", lambda *a: (np.zeros((h, w, 3), np.uint8), out, "cpu"))
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)
    s = tmp_path / "s"
    s.mkdir()
    Image.new("RGB", (w, h)).save(s / "photo.jpg")
    (s / "lighting.json").write_text('{"old": true}')
    res = fitmod.light(s)
    assert res == {"ok": True, "lighting": False, "reason": fitmod.NO_LIGHT}
    assert (s / "lighting.json").read_text() == '{"old": true}'
    assert sorted(p.name for p in s.iterdir()) == ["lighting.json", "photo.jpg"]
