"""Camera conventions without MoGe: point maps built from the golden scenes' exact cameras must give those cameras back.

The point maps are made the way MoGe reports them (OpenCV frame: x right, y down, z forward, z = depth along the view
axis) from fixtures/scenes/<id>/depth.png (exact, floor masked) with the masked floor filled in by the true ray-plane
depth. The fitted camera is then checked against truth.json and against the contract §4.1 projection of truth.json's
open-floor points, so a sign slip in pitch or roll fails here.
"""
from __future__ import annotations

import math

import numpy as np
import pytest
from numpy.typing import NDArray
from PIL import Image
from synthetic import REPO, camera, jarray, jlist, jnum, point_map, points_from_depth, project, rays, rotation, truth, truth_camera

from midstudy_calib import floor as fl

SCENES = ["living-wide", "steep-roll", "portrait"]


def _floor_points(sid: str) -> tuple[NDArray[np.float64], NDArray[np.float64]]:
    """truth.json's open-floor points: world (n, 3) and photo pixels (n, 2)."""
    pts = jlist(truth(sid), "floor_points")
    return np.array([jarray(p, "world") for p in pts]), np.array([jarray(p, "px") for p in pts])


def _image(sid: str) -> tuple[int, int]:
    t = truth(sid)
    return int(jnum(t, "image", "w")), int(jnum(t, "image", "h"))


@pytest.mark.parametrize("sid", SCENES)
def test_golden_truth_round_trip(sid: str) -> None:
    cam = truth_camera(sid)
    depth = np.asarray(Image.open(REPO / f"fixtures/scenes/{sid}/depth.png")).astype(np.float64) / 1000.0
    pts, valid = point_map(cam, depth)
    got = fl.fit_floor(pts, None, valid)
    assert got is not None
    height, pitch, roll = fl.camera_from_plane(got.n, got.d)
    assert abs(height - cam["height_m"]) < 0.005, height
    assert abs(pitch - cam["pitch_deg"]) < 0.1, pitch  # mm-quantized depth, baseboards within 4 cm
    assert abs(roll - cam["roll_deg"]) < 0.1, roll
    # the fitted camera projects truth.json's open-floor points where the photo has them
    fitted = camera(cam["fov_y_deg"], height, pitch, roll)
    W, H = _image(sid)
    world, px = _floor_points(sid)
    assert np.abs(project(fitted, W, H, world) - px).max() < 1.0
    # and the depth.png masking keeps those points at 0
    mm, masked = fl.depth_mm(pts, valid, got)
    assert masked
    dh, dw = mm.shape
    for x, y in px:
        assert mm[int(y * dh / H), int(x * dw / W)] == 0
    # the sofa's front face is not floor
    sofa = jarray(truth(sid), "objects", "sofa", "corners")
    front = np.mean(sofa[[2, 3, 6, 7]], axis=0)
    fx, fy = project(cam, W, H, front[None])[0]
    assert mm[int(fy * dh / H), int(fx * dw / W)] > 0


@pytest.mark.parametrize("sid", SCENES)
def test_floor_depth_is_the_contract_projection(sid: str) -> None:
    """floor_depth (used to make depth.png agree with the floor a corrected camera draws) is §4.1's ray-plane depth:
    on truth.json's open-floor points it equals their view-axis depth from the true camera."""
    cam = truth_camera(sid)
    W, H = _image(sid)
    zf = fl.floor_depth(cam, W, H)
    world, _ = _floor_points(sid)
    pc = (world - np.array([0.0, cam["height_m"], 0.0])) @ rotation(cam)
    want = -pc[:, 2]
    px = project(cam, W, H, world)
    got = np.array([zf[int(y), int(x)] for x, y in px])
    # the pixel centre is up to 0.7 px from the point: allow the depth change across one pixel there
    assert np.all(np.abs(got - want) / want < 0.01), (got, want)
    assert np.isnan(zf[0, 0]) or zf[0, 0] > 0


@pytest.mark.parametrize(("pitch", "roll"), [(-10, 0), (-25, 2), (-8, -1), (-60, 12), (5, -15), (-79, 19)])
def test_plane_camera_inverse(pitch: float, roll: float) -> None:
    n, d = fl.plane_from_camera(1.5, pitch, roll)
    h, p, r = fl.camera_from_plane(n, d)
    assert (round(h, 6), round(p, 6), round(r, 6)) == (1.5, pitch, roll)


def test_signs_against_the_contract() -> None:
    """Positive roll: the horizon falls to the right. Negative pitch: the horizon is above the center."""
    for pitch, roll in [(-12.0, 4.0), (-12.0, -4.0)]:
        n, d = fl.plane_from_camera(1.4, pitch, roll)
        # far floor points left and right of the view axis, 50 m out
        cam = camera(60.0, 1.4, pitch, roll)
        left, right = project(cam, 1600, 1200, np.array([[-20.0, 0, -50.0], [20.0, 0, -50.0]]))
        assert (right[1] > left[1]) == (roll > 0)  # y grows downwards: a larger y is lower
        assert left[1] < 600 and right[1] < 600 + 200
        _, p, r = fl.camera_from_plane(n, d)
        assert math.copysign(1, r) == math.copysign(1, roll) and p < 0


def test_lower_floor_through_glass_loses() -> None:
    """Two parallel floors: the room's (1.4 m below, filling the bottom of the image) and a lower one (4.5 m below,
    seen in the upper right through a 'void'). The room's floor must win even though the void covers more pixels."""
    cam = camera(70.0, 1.4, -15.0, 0.0)
    h, w = 300, 400
    u, v, ray_w, f = rays(cam, w, h)
    down = ray_w[..., 1] < -1e-6
    t_room = np.where(down, 1.4 / np.where(down, -ray_w[..., 1], 1), np.inf)
    t_void = np.where(down, 4.5 / np.where(down, -ray_w[..., 1], 1), np.inf)
    void = (u > w * 0.45) & (v < h * 0.8) & down
    d = np.where(void, t_void, t_room)
    valid = np.isfinite(d) & (d < 60)
    pts = points_from_depth(u, v, np.where(valid, d, 1.0), w, h, f)
    got = fl.fit_floor(pts, None, valid)
    assert got is not None
    height, pitch, _ = fl.camera_from_plane(got.n, got.d)
    assert abs(height - 1.4) < 0.01 and abs(pitch + 15) < 0.1
    mm, _ = fl.depth_mm(pts, valid, got)
    assert (mm[void] == 0).all()  # below the floor plane: never an occluder


def test_fov_from_intrinsics() -> None:
    # fy (normalized by the height) of a 55 degree vertical FOV
    fy = 0.5 / math.tan(math.radians(55) / 2)
    assert abs(fl.fov_y_from_intrinsics(fy) - 55) < 1e-9


def test_steep_look_down_with_a_wall() -> None:
    """Pitch -70, roll 8: the floor faces the camera almost head-on, and a wall 1.2 m ahead fills the top of the frame."""
    cam = camera(75.0, 1.3, -70.0, 8.0)
    h, w = 400, 300
    u, v, ray_w, f = rays(cam, w, h)
    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(ray_w[..., 1] < 0, 1.3 / -ray_w[..., 1], np.inf)
        t_wall = np.where(ray_w[..., 2] < 0, 1.2 / -ray_w[..., 2], np.inf)  # the wall z = -1.2
    d = np.minimum(t_floor, t_wall)
    valid = np.isfinite(d)
    pts = points_from_depth(u, v, np.where(valid, d, 1.0), w, h, f)
    got = fl.fit_floor(pts, None, valid)
    assert got is not None
    height, pitch, roll = fl.camera_from_plane(got.n, got.d)
    assert abs(height - 1.3) < 0.01 and abs(pitch + 70) < 0.1 and abs(roll - 8) < 0.1
