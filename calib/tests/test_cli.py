"""The CLI's output contract, the MIDSTUDY_CALIB_MOCK mode and the fallbacks (contract §4.3). No MoGe weights needed:
the 'MoGe unavailable' case runs with an empty, offline Hugging Face cache."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import jsonschema
import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[2]
GOLDEN = REPO / "fixtures/scenes/living-wide"
SCHEMA = json.loads((REPO / "contract/calib.schema.json").read_text())


def valid_calib(scene: Path) -> dict:
    calib = json.loads((scene / "calib.json").read_text())
    jsonschema.validate(calib, SCHEMA)
    return calib


def cli(*args, env=None):
    e = {k: v for k, v in os.environ.items() if k != "MIDSTUDY_CALIB_MOCK"}
    e.update(env or {})
    p = subprocess.run([sys.executable, "-m", "midstudy_calib.cli", *map(str, args)], capture_output=True, text=True, env=e)
    lines = p.stdout.strip().splitlines()
    assert len(lines) == 1, p.stdout  # nothing else reaches stdout
    return p.returncode, json.loads(lines[-1]), p.stderr


def test_mock_run_copies_the_golden_calibration(tmp_path):
    code, res, _ = cli("run", GOLDEN / "photo.jpg", "--out", tmp_path / "s", env={"MIDSTUDY_CALIB_MOCK": str(REPO / "fixtures/calib")})
    assert code == 0 and res["ok"] is True and res["source"] == "truth"
    want = json.loads((GOLDEN / "calib.json").read_text())
    got = json.loads((tmp_path / "s/calib.json").read_text())
    assert got["camera"] == want["camera"] and "ok" not in got
    assert (tmp_path / "s/depth.png").read_bytes() == (GOLDEN / "depth.png").read_bytes()
    assert sorted(p.name for p in (tmp_path / "s").iterdir()) == ["calib.json", "depth.png", "photo.jpg", "source.jpg"]
    # --no-depth removes the stale depth.png
    code, res, _ = cli("fit", tmp_path / "s", "--no-depth", env={"MIDSTUDY_CALIB_MOCK": str(REPO / "fixtures/calib")})
    assert code == 0 and res["depth"] is None and not (tmp_path / "s/depth.png").exists()


def test_mock_miss_writes_the_default_fallback(tmp_path):
    Image.new("RGB", (64, 48), (120, 100, 90)).save(tmp_path / "x.jpg")
    code, res, _ = cli("run", tmp_path / "x.jpg", "--out", tmp_path / "s", env={"MIDSTUDY_CALIB_MOCK": str(REPO / "fixtures/calib")})
    assert code == 0 and res["source"] == "default" and res["floor"]["found"] is False and res["depth"] is None
    assert res["camera"] == {"fov_y_deg": 55.0, "height_m": 1.4, "pitch_deg": -10.0, "roll_deg": 0.0}
    assert valid_calib(tmp_path / "s")["source"] == "default"


def test_failure_contract(tmp_path):
    (tmp_path / "t.txt").write_text("hello")
    code, res, err = cli("run", tmp_path / "t.txt", "--out", tmp_path / "s")
    assert code == 1 and res == {"ok": False, "error": "that file isn't a JPEG, PNG, HEIC or WebP image"}
    assert err.strip().splitlines()[-1] == "midstudy-calib: that file isn't a JPEG, PNG, HEIC or WebP image"
    code, res, err = cli("fit", tmp_path / "nope")
    assert code == 1 and res["ok"] is False and err.strip().splitlines()[-1] == f"midstudy-calib: {res['error']}"


def test_moge_unavailable_falls_back_to_exif(tmp_path):
    ex = Image.Exif()
    ex[0x010F], ex[0x0110] = "Apple", "iPhone"
    ex.get_ifd(0x8769)[0xA405] = 26
    Image.new("RGB", (400, 300), (120, 100, 90)).save(tmp_path / "e.jpg", exif=ex)
    offline = {"HF_HOME": str(tmp_path / "hf"), "HF_HUB_OFFLINE": "1"}
    code, res, err = cli("run", tmp_path / "e.jpg", "--out", tmp_path / "s", env=offline)
    assert code == 0 and res["source"] == "exif" and res["depth"] is None and res["model"] is None
    assert abs(res["camera"]["fov_y_deg"] - res["exif"]["fov_y_deg"]) < 0.01
    assert res["camera"]["height_m"] == 1.4 and res["camera"]["pitch_deg"] == -10.0
    assert valid_calib(tmp_path / "s")["source"] == "exif"
    # without EXIF: the default camera
    Image.new("RGB", (400, 300), (120, 100, 90)).save(tmp_path / "n.jpg")
    code, res, _ = cli("run", tmp_path / "n.jpg", "--out", tmp_path / "s2", env=offline)
    assert code == 0 and res["source"] == "default" and res["camera"]["fov_y_deg"] == 55.0 and res["exif"] is None


def test_align_cli_identity(tmp_path):
    m = np.zeros((1200, 1600), np.uint8)
    m[600:900, 600:1000] = 255
    Image.fromarray(m).save(tmp_path / "mask.png")
    code, res, _ = cli("align", GOLDEN / "photo.jpg", GOLDEN / "photo.jpg", tmp_path / "mask.png", "--out", tmp_path / "f.jpg")
    assert code == 0 and res["ok"] and res["applied"] and set(res) == {"ok", "applied", "inliers", "residual_px"}
    assert (tmp_path / "f.jpg").is_file()
