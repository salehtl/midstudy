"""The CLI's output contract, the MIDSTUDY_CALIB_MOCK mode and the fallbacks (contract §4.3). No MoGe weights needed:
the 'MoGe unavailable' case runs with an empty, offline Hugging Face cache."""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import numpy as np
from cli_run import run_cli
from PIL import Image
from synthetic import REPO, jget, jnum, load_json

from midstudy_calib import validate

GOLDEN = REPO / "fixtures/scenes/living-wide"
MOCK = {"MIDSTUDY_CALIB_MOCK": str(REPO / "fixtures/calib")}


def valid_calib(scene: Path) -> object:
    calib = load_json(scene / "calib.json")
    assert validate.problems("calib", calib) == []
    return calib


def test_mock_run_copies_the_golden_calibration(tmp_path: Path) -> None:
    code, res, _ = run_cli("midstudy-calib", "run", GOLDEN / "photo.jpg", "--out", tmp_path / "s", env=MOCK)
    assert code == 0 and res["ok"] is True and res["source"] == "truth"
    want = load_json(GOLDEN / "calib.json")
    got = load_json(tmp_path / "s/calib.json")
    assert jget(got, "camera") == jget(want, "camera") and isinstance(got, dict) and "ok" not in got
    assert (tmp_path / "s/depth.png").read_bytes() == (GOLDEN / "depth.png").read_bytes()
    assert sorted(p.name for p in (tmp_path / "s").iterdir()) == ["calib.json", "depth.png", "lighting.json", "photo.jpg", "source.jpg"]
    assert (tmp_path / "s/lighting.json").read_bytes() == (GOLDEN / "lighting.json").read_bytes()  # contract §4.8
    assert validate.problems("run", res) == []
    # --no-depth removes the stale depth.png and keeps the light
    code, res, _ = run_cli("midstudy-calib", "fit", tmp_path / "s", "--no-depth", env=MOCK)
    assert code == 0 and res["depth"] is None and not (tmp_path / "s/depth.png").exists()
    assert (tmp_path / "s/lighting.json").is_file()


def test_mock_miss_writes_the_default_fallback(tmp_path: Path) -> None:
    Image.new("RGB", (64, 48), (120, 100, 90)).save(tmp_path / "x.jpg")
    code, res, _ = run_cli("midstudy-calib", "run", tmp_path / "x.jpg", "--out", tmp_path / "s", env=MOCK)
    assert code == 0 and res["source"] == "default" and jget(res, "floor", "found") is False and res["depth"] is None
    assert res["camera"] == {"fov_y_deg": 55.0, "height_m": 1.4, "pitch_deg": -10.0, "roll_deg": 0.0}
    assert jget(valid_calib(tmp_path / "s"), "source") == "default"
    assert not (tmp_path / "s/lighting.json").exists()  # no light without MoGe (contract §4.8)


def test_failure_contract(tmp_path: Path) -> None:
    (tmp_path / "t.txt").write_text("hello")
    code, res, err = run_cli("midstudy-calib", "run", tmp_path / "t.txt", "--out", tmp_path / "s")
    assert code == 1 and res == {"ok": False, "error": "that file isn't a JPEG, PNG, HEIC or WebP image"}
    assert err.strip().splitlines()[-1] == "midstudy-calib: that file isn't a JPEG, PNG, HEIC or WebP image"
    code, res, err = run_cli("midstudy-calib", "fit", tmp_path / "nope")
    assert code == 1 and res["ok"] is False and err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"
    assert validate.problems("error", res) == []


def test_an_invalid_result_is_a_failure_and_writes_nothing(tmp_path: Path) -> None:
    """A lighting.json that doesn't match its schema (here a broken mock) is a bug: exit 1 with the contract's error
    output, and the scene folder keeps what it had (no new calib.json, depth.png or lighting.json)."""
    mock = tmp_path / "mock"
    key = hashlib.sha256((GOLDEN / "photo.jpg").read_bytes()).hexdigest()
    shutil.copytree(REPO / "fixtures/calib" / key, mock / key)
    light = load_json(mock / key / "lighting.json")
    assert isinstance(light, dict)
    light["key"] = {"direction": [0, 1, 0], "color": [1, 1, 1], "intensity": 1, "softness": 0.5, "confidence": 1.5}
    (mock / key / "lighting.json").write_text(json.dumps(light))
    s = tmp_path / "s"
    s.mkdir()
    shutil.copyfile(GOLDEN / "photo.jpg", s / "photo.jpg")
    code, res, err = run_cli("midstudy-calib", "fit", s, env={"MIDSTUDY_CALIB_MOCK": str(mock)})
    assert code == 1 and res["ok"] is False, res
    msg = str(res["error"])
    assert "ContractViolation" in msg and "lighting.schema.json" in msg and "key/confidence" in msg, msg
    assert err.strip().splitlines()[-1] == f"midstudy-calib: {msg}"
    assert sorted(p.name for p in s.iterdir()) == ["photo.jpg"]


def test_moge_unavailable_falls_back_to_exif(tmp_path: Path) -> None:
    ex = Image.Exif()
    ex[0x010F], ex[0x0110] = "Apple", "iPhone"
    ex.get_ifd(0x8769)[0xA405] = 26
    Image.new("RGB", (400, 300), (120, 100, 90)).save(tmp_path / "e.jpg", exif=ex)
    offline = {"HF_HOME": str(tmp_path / "hf"), "HF_HUB_OFFLINE": "1"}
    code, res, _ = run_cli("midstudy-calib", "run", tmp_path / "e.jpg", "--out", tmp_path / "s", env=offline)
    assert code == 0 and res["source"] == "exif" and res["depth"] is None and res["model"] is None
    assert abs(jnum(res, "camera", "fov_y_deg") - jnum(res, "exif", "fov_y_deg")) < 0.01
    assert jget(res, "camera", "height_m") == 1.4 and jget(res, "camera", "pitch_deg") == -10.0
    assert jget(valid_calib(tmp_path / "s"), "source") == "exif"
    assert "fallback_reason" in res
    # without EXIF: the default camera
    Image.new("RGB", (400, 300), (120, 100, 90)).save(tmp_path / "n.jpg")
    code, res, _ = run_cli("midstudy-calib", "run", tmp_path / "n.jpg", "--out", tmp_path / "s2", env=offline)
    assert code == 0 and res["source"] == "default" and jget(res, "camera", "fov_y_deg") == 55.0 and res["exif"] is None


def test_align_cli_identity(tmp_path: Path) -> None:
    m = np.zeros((1200, 1600), np.uint8)
    m[600:900, 600:1000] = 255
    Image.fromarray(m).save(tmp_path / "mask.png")
    code, res, _ = run_cli("midstudy-calib", "align", GOLDEN / "photo.jpg", GOLDEN / "photo.jpg", tmp_path / "mask.png", "--out", tmp_path / "f.jpg")
    assert code == 0 and res["ok"] and res["applied"] and set(res) == {"ok", "applied", "inliers", "residual_px"}
    assert (tmp_path / "f.jpg").is_file()
    assert validate.problems("align", res) == []


def test_ingest_result_matches_its_schema(tmp_path: Path) -> None:
    code, res, _ = run_cli("midstudy-calib", "ingest", GOLDEN / "photo.jpg", "--out", tmp_path / "s")
    assert code == 0 and res == {"ok": True, "photo": "photo.jpg", "source": "source.jpg", "image": {"w": 1600, "h": 1200}}
    assert validate.problems("ingest", res) == []


def test_bad_arguments_exit_2_with_usage(tmp_path: Path) -> None:
    """argparse's own behaviour, unchanged: exit 2, usage on stderr, nothing on stdout."""
    p = subprocess.run([sys.executable, "-m", "midstudy_calib.cli", "fit"], capture_output=True, text=True, check=False)
    assert p.returncode == 2 and p.stdout == "" and "usage:" in p.stderr
