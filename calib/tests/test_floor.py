"""Camera conventions without MoGe: point maps built from the golden scenes' exact cameras must give those cameras back.

The point maps are made the way MoGe reports them (OpenCV frame: x right, y down, z forward, z = depth along the view
axis) from fixtures/scenes/<id>/depth.png (exact, floor masked) with the masked floor filled in by the true ray-plane
depth. The fitted camera is then checked against truth.json and against the contract §4.1 projection of truth.json's
open-floor points, so a sign slip in pitch or roll fails here.
"""
from __future__ import annotations

import json
import math
from pathlib import Path

import numpy as np
import pytest
from PIL import Image

from midstudy_calib import floor as fl

REPO = Path(__file__).resolve().parents[2]
SCENES = ["living-wide", "steep-roll", "portrait"]


def rotation(cam):
    p, r = math.radians(cam["pitch_deg"]), math.radians(cam["roll_deg"])
    rx = np.array([[1, 0, 0], [0, math.cos(p), -math.sin(p)], [0, math.sin(p), math.cos(p)]])
    rz = np.array([[math.cos(r), -math.sin(r), 0], [math.sin(r), math.cos(r), 0], [0, 0, 1]])
    return rx @ rz


def project(cam, w, h, pts):
    c = (np.asarray(pts, float) - np.array([0.0, cam["height_m"], 0.0])) @ rotation(cam)
    d = -c[:, 2]
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    return np.stack([w / 2 + f * c[:, 0] / d, h / 2 - f * c[:, 1] / d], 1)


def point_map(cam, depth_m):
    """OpenCV-frame point map from a view-axis depth map, with the floor filled from the contract camera."""
    h, w = depth_m.shape
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    ray_c = np.stack([(u - w / 2) / f, -(v - h / 2) / f, -np.ones_like(u)], -1)  # three.js camera frame, depth 1
    ray_w = ray_c @ rotation(cam).T
    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(ray_w[..., 1] < -1e-6, cam["height_m"] / -ray_w[..., 1], np.inf)
    d = np.where(depth_m > 0, depth_m, t_floor)
    valid = np.isfinite(d)
    d = np.where(valid, d, 1.0)
    pts = np.stack([(u - w / 2) / f * d, (v - h / 2) / f * d, d], -1)
    return pts, valid


@pytest.mark.parametrize("sid", SCENES)
def test_golden_truth_round_trip(sid):
    truth = json.loads((REPO / f"fixtures/scenes/{sid}/truth.json").read_text())
    cam = truth["camera"]
    depth = np.asarray(Image.open(REPO / f"fixtures/scenes/{sid}/depth.png")).astype(np.float64) / 1000.0
    pts, valid = point_map(cam, depth)
    got = fl.fit_floor(pts, None, valid)
    assert got is not None
    height, pitch, roll = fl.camera_from_plane(got["n"], got["d"])
    assert abs(height - cam["height_m"]) < 0.005, height
    assert abs(pitch - cam["pitch_deg"]) < 0.1, pitch  # mm-quantized depth, baseboards within 4 cm
    assert abs(roll - cam["roll_deg"]) < 0.1, roll
    # the fitted camera projects truth.json's open-floor points where the photo has them
    fitted = {"fov_y_deg": cam["fov_y_deg"], "height_m": height, "pitch_deg": pitch, "roll_deg": roll}
    W, H = truth["image"]["w"], truth["image"]["h"]
    world = np.array([p["world"] for p in truth["floor_points"]])
    px = np.array([p["px"] for p in truth["floor_points"]])
    assert np.abs(project(fitted, W, H, world) - px).max() < 1.0
    # and the depth.png masking keeps those points at 0
    mm, masked = fl.depth_mm(pts, valid, got)
    assert masked
    dh, dw = mm.shape
    for x, y in px:
        assert mm[int(y * dh / H), int(x * dw / W)] == 0
    # the sofa's front face is not floor
    sofa = truth["objects"]["sofa"]["corners"]
    front = np.mean([sofa[2], sofa[3], sofa[6], sofa[7]], axis=0)
    fx, fy = project(cam, W, H, front[None])[0]
    assert mm[int(fy * dh / H), int(fx * dw / W)] > 0


@pytest.mark.parametrize("pitch,roll", [(-10, 0), (-25, 2), (-8, -1), (-60, 12), (5, -15), (-79, 19)])
def test_plane_camera_inverse(pitch, roll):
    n, d = fl.plane_from_camera(1.5, pitch, roll)
    h, p, r = fl.camera_from_plane(n, d)
    assert (round(h, 6), round(p, 6), round(r, 6)) == (1.5, pitch, roll)


def test_signs_against_the_contract():
    """Positive roll: the horizon falls to the right. Negative pitch: the horizon is above the center."""
    for pitch, roll in [(-12.0, 4.0), (-12.0, -4.0)]:
        n, d = fl.plane_from_camera(1.4, pitch, roll)
        # far floor points left and right of the view axis, 50 m out
        cam = {"fov_y_deg": 60.0, "height_m": 1.4, "pitch_deg": pitch, "roll_deg": roll}
        left, right = project(cam, 1600, 1200, np.array([[-20.0, 0, -50.0], [20.0, 0, -50.0]]))
        assert (right[1] > left[1]) == (roll > 0)  # y grows downwards: a larger y is lower
        assert left[1] < 600 and right[1] < 600 + 200
        h, p, r = fl.camera_from_plane(n, d)
        assert math.copysign(1, r) == math.copysign(1, roll) and p < 0


def test_lower_floor_through_glass_loses():
    """Two parallel floors: the room's (1.4 m below, filling the bottom of the image) and a lower one (4.5 m below,
    seen in the upper right through a 'void'). The room's floor must win even though the void covers more pixels."""
    cam = {"fov_y_deg": 70.0, "height_m": 1.4, "pitch_deg": -15.0, "roll_deg": 0.0}
    h, w = 300, 400
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    ray_w = np.stack([(u - w / 2) / f, -(v - h / 2) / f, -np.ones_like(u)], -1) @ rotation(cam).T
    down = ray_w[..., 1] < -1e-6
    t_room = np.where(down, 1.4 / np.where(down, -ray_w[..., 1], 1), np.inf)
    t_void = np.where(down, 4.5 / np.where(down, -ray_w[..., 1], 1), np.inf)
    void = (u > w * 0.45) & (v < h * 0.8) & down
    d = np.where(void, t_void, t_room)
    valid = np.isfinite(d) & (d < 60)
    d = np.where(valid, d, 1.0)
    pts = np.stack([(u - w / 2) / f * d, (v - h / 2) / f * d, d], -1)
    got = fl.fit_floor(pts, None, valid)
    height, pitch, roll = fl.camera_from_plane(got["n"], got["d"])
    assert abs(height - 1.4) < 0.01 and abs(pitch + 15) < 0.1
    mm, _ = fl.depth_mm(pts, valid, got)
    assert (mm[void] == 0).all()  # below the floor plane: never an occluder


def test_fov_from_intrinsics():
    # fy (normalized by the height) of a 55 degree vertical FOV
    fy = 0.5 / math.tan(math.radians(55) / 2)
    assert abs(fl.fov_y_from_intrinsics(fy) - 55) < 1e-9


def test_steep_look_down_with_a_wall():
    """Pitch -70, roll 8: the floor faces the camera almost head-on, and a wall 1.2 m ahead fills the top of the frame."""
    cam = {"fov_y_deg": 75.0, "height_m": 1.3, "pitch_deg": -70.0, "roll_deg": 8.0}
    h, w = 400, 300
    f = (h / 2) / math.tan(math.radians(cam["fov_y_deg"]) / 2)
    u, v = np.meshgrid(np.arange(w) + 0.5, np.arange(h) + 0.5)
    ray_c = np.stack([(u - w / 2) / f, -(v - h / 2) / f, -np.ones_like(u)], -1)
    ray_w = ray_c @ rotation(cam).T
    with np.errstate(divide="ignore", invalid="ignore"):
        t_floor = np.where(ray_w[..., 1] < 0, 1.3 / -ray_w[..., 1], np.inf)
        t_wall = np.where(ray_w[..., 2] < 0, 1.2 / -ray_w[..., 2], np.inf)  # the wall z = -1.2
    d = np.minimum(t_floor, t_wall)
    valid = np.isfinite(d)
    d = np.where(valid, d, 1.0)
    pts = np.stack([(u - w / 2) / f * d, (v - h / 2) / f * d, d], -1)
    got = fl.fit_floor(pts, None, valid)
    height, pitch, roll = fl.camera_from_plane(got["n"], got["d"])
    assert abs(height - 1.3) < 0.01 and abs(pitch + 70) < 0.1 and abs(roll - 8) < 0.1
