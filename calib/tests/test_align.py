"""align (contract §4.3, §4.7): register a render model's ~1 MP output to the photo and keep the room exact."""
from __future__ import annotations

from pathlib import Path

import cv2
import numpy as np

from midstudy_calib.align import align, register

REPO = Path(__file__).resolve().parents[2]
PHOTO = REPO / "fixtures/scenes/living-wide/photo.jpg"


def furniture_mask(w, h):
    m = np.zeros((h, w), np.uint8)
    cv2.rectangle(m, (int(w * 0.40), int(h * 0.55)), (int(w * 0.65), int(h * 0.85)), 255, -1)
    return m


def fake_render(photo, mask, dx_frac, dy_frac, out_size):
    """What nano-banana does: the room re-drawn with the furniture, framing shifted, snapped to ~1 MP."""
    h, w = photo.shape[:2]
    comp = photo.copy()
    comp[mask > 0] = (40, 90, 160)  # the "furniture"
    M = np.float32([[1, 0, dx_frac * w], [0, 1, dy_frac * h]])
    shifted = cv2.warpAffine(comp, M, (w, h), borderMode=cv2.BORDER_REFLECT)
    return cv2.resize(shifted, out_size, interpolation=cv2.INTER_AREA)


def test_registers_a_shifted_1mp_render(tmp_path):
    photo = cv2.imread(str(PHOTO))
    h, w = photo.shape[:2]
    mask = furniture_mask(w, h)
    raw = fake_render(photo, mask, 0.02, -0.01, (1344, 768))
    raw_r = cv2.resize(raw, (w, h), interpolation=cv2.INTER_CUBIC)
    reg = register(photo, raw_r, cv2.dilate(mask, np.ones((25, 25), np.uint8)))
    assert reg["reason"] is None and reg["inliers"] >= 40 and reg["residual_px"] < 1.5
    # photo pixel x maps to raw pixel x + shift
    pts = np.float32([[x, y] for x in np.linspace(50, w - 50, 7) for y in np.linspace(50, h - 50, 5)])[None]
    got = cv2.perspectiveTransform(pts, reg["H"])[0]
    want = pts[0] + np.float32([0.02 * w, -0.01 * h])
    assert np.abs(got - want).max() < 2.0

    cv2.imwrite(str(tmp_path / "photo.jpg"), photo, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(tmp_path / "raw.jpg"), raw, [cv2.IMWRITE_JPEG_QUALITY, 95])
    cv2.imwrite(str(tmp_path / "mask.png"), cv2.dilate(mask, np.ones((25, 25), np.uint8)))
    res = align(tmp_path / "photo.jpg", tmp_path / "raw.jpg", tmp_path / "mask.png", tmp_path / "final.jpg")
    assert res["ok"] and res["applied"], res
    final = cv2.imread(str(tmp_path / "final.jpg")).astype(int)
    ph = cv2.imread(str(tmp_path / "photo.jpg")).astype(int)
    far = cv2.dilate(mask, np.ones((101, 101), np.uint8)) == 0
    assert np.abs(final - ph)[far].mean() < 2.0  # the room outside the furniture is the photo
    core = cv2.erode(mask, np.ones((31, 31), np.uint8)) > 0
    assert np.abs(final[core] - np.array([40, 90, 160])).mean() < 12  # the furniture landed where it was drawn


def test_identity_applies(tmp_path):
    photo = cv2.imread(str(PHOTO))
    cv2.imwrite(str(tmp_path / "mask.png"), furniture_mask(photo.shape[1], photo.shape[0]))
    res = align(PHOTO, PHOTO, tmp_path / "mask.png", tmp_path / "final.jpg")
    assert res["applied"] and res["inliers"] >= 40 and res["residual_px"] < 0.5, res


def test_unrelated_image_is_refused(tmp_path):
    photo = cv2.imread(str(PHOTO))
    h, w = photo.shape[:2]
    rng = np.random.default_rng(1)
    other = np.full((768, 1344, 3), 200, np.uint8)
    for _ in range(300):
        x, y = rng.integers(0, 1344), rng.integers(0, 768)
        cv2.circle(other, (int(x), int(y)), int(rng.integers(5, 60)), tuple(int(c) for c in rng.integers(0, 255, 3)), -1)
    cv2.imwrite(str(tmp_path / "other.jpg"), other)
    cv2.imwrite(str(tmp_path / "mask.png"), furniture_mask(w, h))
    res = align(PHOTO, tmp_path / "other.jpg", tmp_path / "mask.png", tmp_path / "final.jpg")
    assert res["ok"] and not res["applied"] and res.get("reason"), res
    assert not (tmp_path / "final.jpg").exists()
