"""lighting.py (contract §4.8): conventions, and the fit on a synthetic room with a known light (no MoGe)."""
import json
import math
from pathlib import Path

import numpy as np
import pytest

from midstudy_calib import lighting as lt
from midstudy_calib.floor import plane_from_camera

REPO = Path(__file__).resolve().parents[2]


def test_aces_inverse_round_trips():
    x = np.stack(np.meshgrid(np.linspace(0.01, 2.5, 12), np.linspace(0.01, 2.5, 12), np.linspace(0.01, 2.5, 12)), -1).reshape(-1, 3)
    x = x[x.min(1) > 0.3 * x.max(1)]  # room colours: ACES clips very saturated ones to 0 in a channel, which no inverse undoes
    y = lt.aces(x)
    ok = y.max(1) < 0.97  # below the shoulder, where the curve is invertible to the precision a JPEG has
    back = lt.aces_inverse(y[ok])
    assert np.allclose(lt.aces(back), y[ok], atol=2e-4)
    assert np.allclose(back, x[ok], rtol=0.03, atol=2e-3)


def test_cam_rotation_matches_the_floor_convention():
    for cam in ({"pitch_deg": -10, "roll_deg": 0}, {"pitch_deg": -25, "roll_deg": 2}, {"pitch_deg": -8, "roll_deg": -1}):
        R = lt.cam_rotation(cam)
        n_cv, _ = plane_from_camera(1.4, cam["pitch_deg"], cam["roll_deg"])
        assert np.allclose(R.T @ np.array([0, 1, 0]), n_cv * np.array([1, -1, -1]), atol=1e-9)


def _render(light_dir, key_rgb=(1.0, 0.9, 0.75), amb=(0.9, 0.85, 0.8), w=360, h=270, cam=None):
    """A box room ray-cast in numpy: floor, three walls, ceiling and two boxes, lit by E = a + b n_y + I max(0, n.l)
    (no shadows), rendered like three.js (albedo / pi * E, ACES Filmic, sRGB). Returns MoGe-like outputs."""
    cam = cam or {"fov_y_deg": 60.0, "height_m": 1.4, "pitch_deg": -15.0, "roll_deg": 0.0}
    R = lt.cam_rotation(cam)
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    dc = np.stack([(u - w / 2) / f, -(v - h / 2) / f, -np.ones_like(u)], -1)
    d = dc @ R.T
    o = np.array([0.0, cam["height_m"], 0.0])
    best = np.full((h, w), np.inf)
    nrm = np.zeros((h, w, 3))
    alb = np.zeros((h, w, 3))
    planes = [((0, 1, 0), 0.0, (0.35, 0.25, 0.16)), ((0, -1, 0), 2.7, (0.8, 0.8, 0.78)), ((0, 0, 1), 5.0, (0.72, 0.7, 0.66)),
              ((1, 0, 0), 2.6, (0.7, 0.7, 0.68)), ((-1, 0, 0), 2.6, (0.7, 0.7, 0.68))]
    for n, off, a in planes:  # n . p + off = 0, n facing the room
        n = np.array(n, float)
        with np.errstate(divide="ignore", invalid="ignore"):
            t = -(n @ o + off) / (d @ n)
        hit = (t > 0) & (t < best)
        best[hit] = t[hit]
        nrm[hit] = n
        alb[hit] = a
    # boxes (centre, size, yaw in degrees, albedo): turned ones, so the faces show many directions as a real room does
    for c, s, yaw, a in (((-0.7, 0.4, -3.2), (1.4, 0.8, 0.8), 25, (0.35, 0.5, 0.45)), ((0.9, 0.25, -2.3), (0.6, 0.5, 0.6), -35, (0.6, 0.38, 0.28)),
                         ((1.6, 0.6, -4.2), (0.5, 1.2, 0.5), 50, (0.55, 0.55, 0.6)), ((-1.6, 0.3, -2.0), (0.5, 0.6, 0.5), 10, (0.5, 0.45, 0.4))):
        cy, sy = math.cos(math.radians(yaw)), math.sin(math.radians(yaw))
        Ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])          # local -> world
        ol, dl = (o - np.array(c)) @ Ry, d @ Ry                          # the ray in the box's frame
        half = np.array(s) / 2
        with np.errstate(divide="ignore", invalid="ignore"):
            t1, t2 = (-half - ol) / dl, (half - ol) / dl
        tn, tf = np.minimum(t1, t2).max(-1), np.maximum(t1, t2).min(-1)
        hit = (tn < tf) & (tn > 0) & (tn < best)
        best[hit] = tn[hit]
        axis = np.argmax(np.minimum(t1, t2), -1)
        n = np.zeros((h, w, 3))
        np.put_along_axis(n, axis[..., None], 1.0, -1)
        n *= -np.sign(np.take_along_axis(dl, axis[..., None], -1))
        nrm[hit] = (n @ Ry.T)[hit]
        alb[hit] = a
    p = o + best[..., None] * d
    l = np.asarray(light_dir, float) / np.linalg.norm(light_dir)
    E = np.array(amb)[None, None] * (1 + 0.35 * nrm[..., 1:2]) + 2.4 * np.array(key_rgb)[None, None] * np.maximum(nrm @ l, 0)[..., None]
    disp = lt.aces(alb / math.pi * E)
    srgb = np.where(disp <= 0.0031308, 12.92 * disp, 1.055 * np.power(disp, 1 / 2.4) - 0.055)
    rgb = np.clip(np.rint(srgb * 255), 0, 255).astype(np.uint8)
    pc = (p - o) @ R            # world -> three.js camera frame, then OpenCV
    nc = nrm @ R
    cv = np.array([1.0, -1.0, -1.0])
    floor = (np.abs(p[..., 1]) < 0.01) & (nrm[..., 1] > 0.99)
    return rgb, pc * cv, nc * cv, np.isfinite(best), cam, R, floor


def _angle(a, b):
    return math.degrees(math.acos(max(-1.0, min(1.0, float(a @ b / np.linalg.norm(a) / np.linalg.norm(b))))))


@pytest.mark.parametrize("light", [(0.6, 0.7, 0.4), (-0.7, 0.5, -0.5), (0.2, 0.8, -0.55)])
def test_fit_finds_the_key_light(light):
    rgb, pts, nrm, valid, cam, R, floor = _render(light)
    out = lt.fit(rgb, pts, nrm, valid, cam, floor, {"w": rgb.shape[1], "h": rgb.shape[0]})
    assert out is not None and out["source"] == "photo" and out["frame"] == "camera"
    l_world = R @ np.array(out["key"]["direction"])
    assert _angle(l_world, np.array(light)) < 12, (out["fit"], light)
    assert out["key"]["confidence"] > 0.5
    assert out["fit"]["elapsed_s"] < 3


def test_fit_reads_the_light_colour():
    def run(**kw):
        rgb, pts, nrm, valid, cam, _, floor = _render((0.6, 0.7, 0.4), **kw)
        return lt.fit(rgb, pts, nrm, valid, cam, floor)
    warm = run(key_rgb=(1.0, 0.7, 0.45), amb=(1.0, 0.8, 0.6))
    cool = run(key_rgb=(0.8, 0.9, 1.0), amb=(0.75, 0.85, 1.0))
    assert warm["white_balance"]["cct_k"] + 1500 < cool["white_balance"]["cct_k"]


def test_output_validates_and_survives_json():
    jsonschema = pytest.importorskip("jsonschema")
    rgb, pts, nrm, valid, cam, _, floor = _render((0.6, 0.7, 0.4))
    out = json.loads(json.dumps(lt.fit(rgb, pts, nrm, valid, cam, floor, {"w": 360, "h": 270})))
    assert out["floor"]["radiance"][0] > 0
    jsonschema.validate(out, json.loads((REPO / "contract/lighting.schema.json").read_text()))
    assert len(out["ambient"]["sh"]) == 9 and abs(np.linalg.norm(out["key"]["direction"]) - 1) < 1e-4


def test_nothing_to_go_on_returns_none():
    h, w = 60, 80
    nan = np.full((h, w, 3), np.nan)
    assert lt.fit(np.zeros((h, w, 3), np.uint8), nan, nan, np.zeros((h, w), bool), {"pitch_deg": -10, "roll_deg": 0}) is None
