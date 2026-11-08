"""The room solver's scale source (contract §4.9, `from_views`): floor, else depth, else nothing placed. A member with
no depth overlap has no scale, rather than a made-up 1.0."""
from __future__ import annotations

import math
from pathlib import Path

import numpy as np
import pytest

from midstudy_calib.rooms import solver
from midstudy_calib.rooms.geometry import F64
from midstudy_calib.rooms.photos import Camera, RoomPhoto
from midstudy_calib.rooms.solver import _scale_mode  # pyright: ignore[reportPrivateUsage]

NAN = math.nan


def test_floor_mode_scales_each_member_by_its_camera_height() -> None:
    mode, sigma, scales = _scale_mode([1.5, 1.2], [1.0, 1.0], 0.0, [NAN, NAN])
    assert mode == "floor"
    assert sigma == pytest.approx(1.5)
    assert scales == pytest.approx([1.0, 1.25])


def test_depth_mode_gives_a_member_without_a_ratio_no_scale() -> None:
    mode, sigma, scales = _scale_mode([1.5, 1.5, 1.5], [1.0, 1.0, 1.0], None, [0.9, NAN, 1.1])
    assert mode == "depth"
    assert sigma == pytest.approx(0.9)
    assert scales[0] == pytest.approx(1.0)
    assert math.isnan(scales[1])
    assert scales[2] == pytest.approx(0.9 / 1.1)


@pytest.mark.parametrize("ratio", [0.0, -1.0, math.inf])
def test_depth_mode_refuses_a_ratio_that_is_not_finite_and_positive(ratio: float) -> None:
    mode, _, scales = _scale_mode([1.5, 1.5], [1.0, 1.0], None, [0.9, ratio])
    assert mode == "depth"
    assert math.isnan(scales[1])


@pytest.mark.parametrize(("height", "cy0", "b"), [(1.5, 1.0, 1.0), (1.5, 0.5, 1.0), (0.0, 1.0, 0.0), (1.5, NAN, 0.0)])
def test_a_degenerate_floor_falls_back_to_depth(height: float, cy0: float, b: float) -> None:
    mode, sigma, scales = _scale_mode([height, 1.5], [cy0, 1.0], b, [2.0, 4.0])
    assert mode == "depth"
    assert sigma == pytest.approx(2.0)
    assert scales == pytest.approx([1.0, 0.5])


@pytest.mark.parametrize("floor_b", [None, 1.0])
def test_neither_floor_nor_depth_is_none(floor_b: float | None) -> None:
    mode, sigma, scales = _scale_mode([1.5, 1.5], [1.0, 1.0], floor_b, [NAN, 2.0])
    assert mode == "none"
    assert math.isnan(sigma)
    assert all(math.isnan(s) for s in scales)


# ---------------------------------------------------------------------------------------------------- from_views

SIZE = 16


def _photo(name: str) -> RoomPhoto:
    """Level, 1.5 m up, and a wall 3 m away everywhere: no floor pixel (depth.png 0) anywhere."""
    depth: F64 = np.full((SIZE, SIZE), 3.0)
    return RoomPhoto(Path(name), name, "0" * 64, SIZE, SIZE, Camera(math.radians(60.0), 1.5, 0.0, 0.0), depth)


def _view(photo: RoomPhoto, x: float, overlaps: bool) -> solver.View:
    """The solver's view of a photo, 2 solver units from the wall; `overlaps=False`: every grid pixel is padding."""
    c2w: F64 = np.eye(4)
    c2w[:3, :3] = photo.r_cv
    c2w[:3, 3] = [x, 0.0, 0.0]
    k: F64 = np.array([[SIZE, 0.0, SIZE / 2], [0.0, SIZE, SIZE / 2], [0.0, 0.0, 1.0]])
    cols: F64 = (np.arange(SIZE, dtype=np.float64) + 0.5) / SIZE
    u: F64 = np.tile(cols, (SIZE, 1))
    v: F64 = np.tile(cols[:, None], (1, SIZE))
    depth: F64 = np.full((SIZE, SIZE), 2.0)
    conf: F64 = np.ones((SIZE, SIZE))
    return solver.View(c2w, k, depth, conf, u, v) if overlaps else solver.View(c2w, k, depth, conf, u * NAN, v * NAN)


def test_a_member_without_depth_overlap_is_unplaced_not_scale_one() -> None:
    photos = [_photo(n) for n in ("a", "b", "c")]
    views = [_view(photos[0], 0.0, True), _view(photos[1], 1.0, False), _view(photos[2], 2.0, True)]
    first, second, third = solver.from_views(photos, views)
    assert first is not None and third is not None
    assert second is None
    assert first.diag["scale_source"] == "depth" and third.diag["scale_source"] == "depth"
    assert third.placement.scale == pytest.approx(1.0)
    assert math.hypot(third.placement.x, third.placement.z) == pytest.approx(3.0)  # 1.5 m per solver unit, 2 units away


def test_nothing_to_scale_by_places_only_the_frame_and_says_so() -> None:
    photos = [_photo(n) for n in ("a", "b")]
    first, second = solver.from_views(photos, [_view(p, float(i), False) for i, p in enumerate(photos)])
    assert first is not None and second is None
    assert first.diag == {"scale_source": "none"}
    assert (first.placement.x, first.placement.z, first.placement.yaw, first.placement.scale) == (0.0, 0.0, 0.0, 1.0)
