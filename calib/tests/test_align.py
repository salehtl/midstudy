"""align (contract §4.3, §4.7): register a render model's ~1 MP output to the photo and keep the room exact."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np
from numpy.typing import NDArray
from synthetic import REPO

from midstudy_calib.align import align, register

PHOTO = REPO / "fixtures/scenes/living-wide/photo.jpg"
type U8 = NDArray[np.uint8]


def imread(path: Path) -> U8:
    im = cv2.imread(str(path))
    assert im is not None
    return np.asarray(im, np.uint8)


def furniture_mask(w: int, h: int) -> U8:
    m = np.zeros((h, w), np.uint8)
    cv2.rectangle(m, (int(w * 0.40), int(h * 0.55)), (int(w * 0.65), int(h * 0.85)), 255, -1)
    return m


def dilate(mask: U8, k: int) -> U8:
    return np.asarray(cv2.dilate(mask, np.ones((k, k), np.uint8)), np.uint8)


def fake_render(photo: U8, mask: U8, dx_frac: float, dy_frac: float, out_size: tuple[int, int]) -> U8:
    """What nano-banana does: the room re-drawn with the furniture, framing shifted, snapped to ~1 MP."""
    h, w = photo.shape[:2]
    comp = photo.copy()
    comp[mask > 0] = (40, 90, 160)  # the "furniture"
    M = np.array([[1, 0, dx_frac * w], [0, 1, dy_frac * h]], np.float32)
    shifted = cv2.warpAffine(comp, M, (w, h), borderMode=cv2.BORDER_REFLECT)
    return np.asarray(cv2.resize(shifted, out_size, interpolation=cv2.INTER_AREA), np.uint8)


def test_registers_a_shifted_1mp_render(tmp_path: Path) -> None:
    photo = imread(PHOTO)
    h, w = photo.shape[:2]
    mask = furniture_mask(w, h)
    raw = fake_render(photo, mask, 0.02, -0.01, (1344, 768))
    raw_r = np.asarray(cv2.resize(raw, (w, h), interpolation=cv2.INTER_CUBIC), np.uint8)
    reg = register(photo, raw_r, dilate(mask, 25))
    assert reg.reason is None and reg.inliers >= 40 and reg.residual_px is not None and reg.residual_px < 1.5
    assert reg.H is not None
    # photo pixel x maps to raw pixel x + shift
    xs, ys = [50 + i * (w - 100) / 6 for i in range(7)], [50 + i * (h - 100) / 4 for i in range(5)]
    pts = np.array([[x, y] for x in xs for y in ys], np.float32)[None]
    got = np.asarray(cv2.perspectiveTransform(pts, reg.H), np.float32).reshape(-1, 2)
    want = pts.reshape(-1, 2) + np.array([0.02 * w, -0.01 * h], np.float32)
    assert np.abs(got - want).max() < 2.0

    cv2.imwrite(str(tmp_path / "photo.jpg"), photo, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(tmp_path / "raw.jpg"), raw, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(tmp_path / "mask.png"), dilate(mask, 25))
    res = align(tmp_path / "photo.jpg", tmp_path / "raw.jpg", tmp_path / "mask.png", tmp_path / "final.jpg")
    assert res["ok"] and res["applied"], res
    final = imread(tmp_path / "final.jpg").astype(int)
    ph = imread(tmp_path / "photo.jpg").astype(int)
    far = dilate(mask, 101) == 0
    assert np.abs(final - ph)[far].mean() < 2.0  # the room outside the furniture is the photo
    core = np.asarray(cv2.erode(mask, np.ones((31, 31), np.uint8))) > 0
    assert np.abs(final[core] - np.array([40, 90, 160])).mean() < 12  # the furniture landed where it was drawn


def test_identity_applies(tmp_path: Path) -> None:
    photo = imread(PHOTO)
    cv2.imwrite(str(tmp_path / "mask.png"), furniture_mask(photo.shape[1], photo.shape[0]))
    res = align(PHOTO, PHOTO, tmp_path / "mask.png", tmp_path / "final.jpg")
    residual = res["residual_px"]
    assert res["applied"] and res["inliers"] >= 40 and residual is not None and residual < 0.5, res


def test_unrelated_image_is_refused(tmp_path: Path) -> None:
    photo = imread(PHOTO)
    h, w = photo.shape[:2]
    rng = np.random.default_rng(1)
    other = np.full((768, 1344, 3), 200, np.uint8)
    for _ in range(300):
        x, y = int(rng.integers(0, 1344)), int(rng.integers(0, 768))
        r = int(rng.integers(5, 60))
        c = rng.integers(0, 255, 3)
        cv2.circle(other, (x, y), r, (int(c[0]), int(c[1]), int(c[2])), -1)
    cv2.imwrite(str(tmp_path / "other.jpg"), other)
    cv2.imwrite(str(tmp_path / "mask.png"), furniture_mask(w, h))
    res = align(PHOTO, tmp_path / "other.jpg", tmp_path / "mask.png", tmp_path / "final.jpg")
    assert res["ok"] and not res["applied"] and res.get("reason"), res
    assert not (tmp_path / "final.jpg").exists()
