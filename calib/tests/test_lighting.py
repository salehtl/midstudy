"""lighting.py (contract §4.8): conventions, and the fit on a synthetic room with a known light (no MoGe)."""
from __future__ import annotations

import json
import math

import numpy as np
import pytest
from numpy.typing import NDArray
from synthetic import camera, render_room

from midstudy_calib import lighting as lt
from midstudy_calib import validate
from midstudy_calib.floor import plane_from_camera


def test_aces_inverse_round_trips() -> None:
    g = np.linspace(0.01, 2.5, 12)
    x = np.stack(np.meshgrid(g, g, g), -1).reshape(-1, 3)
    x = x[x.min(1) > 0.3 * x.max(1)]  # room colours: ACES clips very saturated ones to 0 in a channel, which no inverse undoes
    y = lt.aces(x)
    ok = y.max(1) < 0.97  # below the shoulder, where the curve is invertible to the precision a JPEG has
    back = lt.aces_inverse(y[ok])
    assert np.allclose(lt.aces(back), y[ok], atol=2e-4)
    assert np.allclose(back, x[ok], rtol=0.03, atol=2e-3)


def test_srgb_lookup_is_the_formula() -> None:
    """srgb_to_linear (a lookup table) gives every 8-bit value exactly what the sRGB formula gives."""
    c = np.arange(256, dtype=np.float64) / 255.0
    want = np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)
    got = lt.srgb_to_linear(np.arange(256, dtype=np.uint8).reshape(16, 16)).reshape(-1)
    assert np.array_equal(got, want)


def test_cam_rotation_matches_the_floor_convention() -> None:
    for pitch, roll in ((-10, 0), (-25, 2), (-8, -1)):
        R = lt.cam_rotation(pitch, roll)
        n_cv, _ = plane_from_camera(1.4, pitch, roll)
        assert np.allclose(R.T @ np.array([0, 1, 0]), n_cv * np.array([1, -1, -1]), atol=1e-9)


def _angle(a: NDArray[np.float64], b: NDArray[np.float64]) -> float:
    return math.degrees(math.acos(max(-1.0, min(1.0, float(a @ b / np.linalg.norm(a) / np.linalg.norm(b))))))


@pytest.mark.parametrize("light", [(0.6, 0.7, 0.4), (-0.7, 0.5, -0.5), (0.2, 0.8, -0.55)])
def test_fit_finds_the_key_light(light: tuple[float, float, float]) -> None:
    room = render_room(light)
    out = lt.fit(room.rgb, room.points, room.normals, room.valid, room.camera, room.floor, {"w": room.rgb.shape[1], "h": room.rgb.shape[0]})
    assert out is not None and out.lighting["source"] == "photo" and out.lighting["frame"] == "camera"
    l_world = room.R @ np.array(out.lighting["key"]["direction"])
    assert _angle(l_world, np.array(light)) < 12, (out.lighting.get("fit"), light)
    assert out.lighting["key"]["confidence"] > 0.5
    assert out.elapsed_s < 3 and out.pairs >= lt.MIN_PAIRS


def test_fit_reads_the_light_colour() -> None:
    def cct(key_rgb: tuple[float, float, float], amb: tuple[float, float, float]) -> float:
        room = render_room((0.6, 0.7, 0.4), key_rgb=key_rgb, amb=amb)
        out = lt.fit(room.rgb, room.points, room.normals, room.valid, room.camera, room.floor)
        assert out is not None
        k = out.lighting["white_balance"]["cct_k"]
        assert k is not None
        return k

    assert cct((1.0, 0.7, 0.45), (1.0, 0.8, 0.6)) + 1500 < cct((0.8, 0.9, 1.0), (0.75, 0.85, 1.0))


def test_output_validates_and_survives_json() -> None:
    room = render_room((0.6, 0.7, 0.4))
    fitted = lt.fit(room.rgb, room.points, room.normals, room.valid, room.camera, room.floor, {"w": 360, "h": 270})
    assert fitted is not None
    out: object = json.loads(json.dumps(fitted.lighting))
    assert out == fitted.lighting
    assert validate.problems("lighting", out) == []
    floor = fitted.lighting.get("floor")
    assert floor is not None and floor.get("radiance", [0.0])[0] > 0
    assert len(fitted.lighting["ambient"]["sh"]) == 9 and abs(np.linalg.norm(fitted.lighting["key"]["direction"]) - 1) < 1e-4


def test_float32_input_as_moge_gives_it() -> None:
    """MoGe's arrays are float32: the fit takes them as they are (and agrees with the float64 ones closely)."""
    room = render_room((0.6, 0.7, 0.4))
    a = lt.fit(room.rgb, room.points, room.normals, room.valid, room.camera, room.floor)
    m = room.moge()
    assert m.normal is not None
    b = lt.fit(room.rgb, m.points, m.normal, m.mask, room.camera, room.floor)
    assert a is not None and b is not None
    assert _angle(np.array(a.lighting["key"]["direction"]), np.array(b.lighting["key"]["direction"])) < 1


def test_nothing_to_go_on_returns_none() -> None:
    h, w = 60, 80
    nan = np.full((h, w, 3), np.nan)
    assert lt.fit(np.zeros((h, w, 3), np.uint8), nan, nan, np.zeros((h, w), np.bool_), camera(55, 1.4, -10, 0)) is None
