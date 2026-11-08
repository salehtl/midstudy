"""A scene folder's files as a state (contract §4.3 Order, Fallbacks, Mock): calib.json is the commit marker, a new
photo clears what was derived from the old one, and a re-fit that can't run MoGe keeps the earlier calibration."""
from __future__ import annotations

import io
import json
import os
from pathlib import Path

import numpy as np
import pytest
from numpy.typing import NDArray
from PIL import Image
from synthetic import REPO, jget, jnum, load_json

from midstudy_calib import fit as fitmod
from midstudy_calib.ingest import ingest
from midstudy_calib.moge_runner import MogeOutput
from midstudy_calib.records import Device, Model, RealDevice
from midstudy_calib.util import Fail, write_atomic

GOLDEN = REPO / "fixtures/scenes/living-wide/photo.jpg"
MOCK = str(REPO / "fixtures/calib")

type U8 = NDArray[np.uint8]


def jpeg(colour: tuple[int, int, int] = (120, 100, 90), exif: Image.Exif | None = None) -> bytes:
    buf = io.BytesIO()
    im = Image.new("RGB", (64, 48), colour)
    if exif is None:
        im.save(buf, "JPEG")
    else:
        im.save(buf, "JPEG", exif=exif)
    return buf.getvalue()


def upload(tmp_path: Path, data: bytes, name: str = "up.jpg") -> Path:
    p = tmp_path / name
    p.write_bytes(data)
    return p


def names(scene: Path) -> list[str]:
    return sorted(p.name for p in scene.iterdir())


def snapshot(scene: Path) -> dict[str, bytes]:
    return {n: (scene / n).read_bytes() for n in names(scene)}


def fitted(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The golden photo, ingested and fitted under the mock."""
    monkeypatch.setenv("MIDSTUDY_CALIB_MOCK", MOCK)
    scene = tmp_path / "s"
    ingest(GOLDEN, scene)
    fitmod.fit(scene)
    assert (scene / "depth.png").is_file() and (scene / "lighting.json").is_file()
    return scene


def as_moge(scene: Path) -> None:
    calib = load_json(scene / "calib.json")
    assert isinstance(calib, dict)
    (scene / "calib.json").write_text(json.dumps({**calib, "source": "moge-2"}, indent=2) + "\n")


def oom(*_args: object) -> fitmod.FitOutput:
    raise RuntimeError("MPS backend out of memory\nmore detail")


def test_a_new_photo_clears_the_old_fit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scene = fitted(tmp_path, monkeypatch)
    ingest(upload(tmp_path, jpeg()), scene)
    assert names(scene) == ["photo.jpg", "source.jpg"]
    assert (scene / "photo.jpg").read_bytes() == jpeg()


def test_identical_bytes_keep_the_fit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scene = fitted(tmp_path, monkeypatch)
    before = snapshot(scene)
    ingest(GOLDEN, scene)
    assert snapshot(scene) == before


def test_nothing_is_cleared_when_the_new_upload_is_refused(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scene = fitted(tmp_path, monkeypatch)
    before = snapshot(scene)
    with pytest.raises(Fail):
        ingest(upload(tmp_path, b"not an image at all"), scene)
    assert snapshot(scene) == before


def test_a_new_upload_leaves_one_source(tmp_path: Path) -> None:
    scene = tmp_path / "s"
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (10, 200, 30)).save(buf, "PNG")
    ingest(upload(tmp_path, buf.getvalue(), "up.png"), scene)
    assert names(scene) == ["photo.jpg", "source.png"]
    ingest(upload(tmp_path, jpeg()), scene)
    assert names(scene) == ["photo.jpg", "source.jpg"]


def test_ingest_removes_before_it_writes(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A crash while writing the new source leaves neither the old fit nor the old photo beside it."""
    scene = fitted(tmp_path, monkeypatch)

    def die(path: Path, data: bytes) -> None:
        raise KeyboardInterrupt

    monkeypatch.setattr("midstudy_calib.ingest.write_atomic", die)
    with pytest.raises(KeyboardInterrupt):
        ingest(upload(tmp_path, jpeg()), scene)
    assert names(scene) == ["source.jpg"]  # the old upload, alone: Calibrate can rebuild a consistent scene from it


def test_a_crash_between_source_and_photo_leaves_the_new_source_alone(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """New source, no photo, no fit: Calibrate re-runs it, and the new upload is what it finds."""
    scene = fitted(tmp_path, monkeypatch)
    data = jpeg()

    def die_on_photo(path: Path, content: bytes) -> None:
        if path.name == "photo.jpg":
            raise KeyboardInterrupt
        write_atomic(path, content)

    monkeypatch.setattr("midstudy_calib.ingest.write_atomic", die_on_photo)
    with pytest.raises(KeyboardInterrupt):
        ingest(upload(tmp_path, data), scene)
    assert names(scene) == ["source.jpg"]
    assert (scene / "source.jpg").read_bytes() == data


def test_write_atomic_syncs_before_the_rename(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[str] = []
    real_fsync, real_replace = os.fsync, os.replace

    def fsync(fd: int) -> None:
        calls.append("fsync")
        real_fsync(fd)

    def replace(src: str, dst: Path) -> None:
        calls.append("replace")
        real_replace(src, dst)

    monkeypatch.setattr(os, "fsync", fsync)
    monkeypatch.setattr(os, "replace", replace)
    write_atomic(tmp_path / "f", b"x")
    assert calls == ["fsync", "replace"]


def test_refit_that_cant_run_moge_keeps_the_calibration(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scene = fitted(tmp_path, monkeypatch)
    as_moge(scene)
    before = snapshot(scene)
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK")
    monkeypatch.setattr(fitmod, "_moge", oom)
    with pytest.raises(Fail, match=r"^MoGe-2 couldn't run \(RuntimeError: MPS backend out of memory\); the earlier calibration was kept$"):
        fitmod.fit(scene)
    assert snapshot(scene) == before


def test_first_fit_or_earlier_fallback_still_falls_back(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scene = tmp_path / "s"
    ingest(upload(tmp_path, jpeg()), scene)
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)
    monkeypatch.setattr(fitmod, "_moge", oom)
    assert fitmod.fit(scene)["source"] == "default"  # no calib.json: the §4.3 fallback
    assert fitmod.fit(scene)["source"] == "default"  # an earlier fallback is nothing to keep
    assert "MPS" in str(jget(load_json(scene / "calib.json"), "fallback_reason"))


def test_a_torn_refit_leaves_no_calib_json(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scene = fitted(tmp_path, monkeypatch)
    real = write_atomic

    def tear(path: Path, data: bytes) -> None:
        if path.name == "lighting.json":
            raise KeyboardInterrupt
        real(path, data)

    monkeypatch.setattr(fitmod, "write_atomic", tear)
    with pytest.raises(KeyboardInterrupt):
        fitmod.fit(scene)
    assert not (scene / "calib.json").exists()


def test_only_our_temp_files_are_swept(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scene = fitted(tmp_path, monkeypatch)
    ours = [".calib.json.abc123.tmp", ".depth.png.abc123.tmp", ".lighting.json.abc123.tmp"]
    theirs = [".scene.json.abc123.tmp", ".thumb.jpg.abc123.tmp"]
    for n in (*ours, *theirs):
        (scene / n).write_bytes(b"x")
    fitmod.fit(scene)
    assert not [n for n in ours if (scene / n).exists()]
    assert all((scene / n).exists() for n in theirs)


def test_ingest_sweeps_its_temp_files(tmp_path: Path) -> None:
    scene = tmp_path / "s"
    scene.mkdir()
    for n in (".photo.jpg.abc.tmp", ".source.png.abc.tmp", ".scene.json.abc.tmp"):
        (scene / n).write_bytes(b"x")
    ingest(upload(tmp_path, jpeg()), scene)
    assert names(scene) == [".scene.json.abc.tmp", "photo.jpg", "source.jpg"]


def test_mock_miss_uses_the_exif_like_the_real_fallback(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ex = Image.Exif()
    ex[0x010F], ex[0x0110] = "Apple", "iPhone"
    ex.get_ifd(0x8769)[0xA405] = 26
    scene = tmp_path / "s"
    ingest(upload(tmp_path, jpeg(exif=ex)), scene)
    monkeypatch.setenv("MIDSTUDY_CALIB_MOCK", MOCK)
    calib = fitmod.fit(scene)
    assert calib["source"] == "exif" and "no calibration for this photo" in calib.get("fallback_reason", "")
    assert abs(jnum(calib, "camera", "fov_y_deg") - jnum(calib, "exif", "fov_y_deg")) < 0.01


def test_fit_records_the_weights_revision(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    scene = tmp_path / "s"
    ingest(upload(tmp_path, jpeg()), scene)
    monkeypatch.delenv("MIDSTUDY_CALIB_MOCK", raising=False)

    def fake(scene_: Path, w: int, h: int, model: Model, device: Device) -> tuple[U8, MogeOutput, RealDevice]:
        nan = np.full((h, w, 3), np.nan, np.float32)
        out = MogeOutput(points=nan, normal=nan, mask=np.zeros((h, w), np.bool_), intrinsics=np.array([[1, 0, .5], [0, 1.3, .5], [0, 0, 1]], np.float32),
                         load_s=0.0, infer_s=0.0, repo="x", revision="abc")
        return np.zeros((h, w, 3), np.uint8), out, "cpu"

    monkeypatch.setattr(fitmod, "_infer", fake)
    fitmod.fit(scene, no_depth=True)
    assert jget(load_json(scene / "calib.json"), "moge", "revision") == "abc"
