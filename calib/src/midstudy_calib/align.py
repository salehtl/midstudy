"""`midstudy-calib align` (contract §4.3, §4.7): register the render model's output to the scene photo, then keep
the room exactly: final = photo x (1 - mask) + warped x mask, with the mask feathered.

nano-banana returns about 1 MP at a fixed aspect (2000 x 1125 in -> 1344 x 768 out) and its framing drifts by 1-2 %
of the width, so the output is resized to the photo's size and then registered with a homography estimated from
features outside the mask (where the room should be unchanged): SIFT + ratio test + RANSAC, then an ECC refinement.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from numpy.typing import NDArray

from .contract_types import AlignResult
from .util import Fail, log, write_atomic

type U8 = NDArray[np.uint8]
type F64 = NDArray[np.float64]

MIN_INLIERS = 40
MAX_RESIDUAL_PX = 3.0
WORK_LONG_SIDE = 1600   # features are found at this size (the homography is rescaled to the photo's size)
RANSAC_PX = 2.5         # at the photo's size
MAX_CORNER_SHIFT = 0.10  # a registration that moves a corner by more than 10 % of the width is not "the same framing"


def _read(path: Path, flags: int) -> U8:
    import cv2

    data = np.fromfile(str(path), dtype=np.uint8)
    im = cv2.imdecode(data, flags) if data.size else None
    if im is None:
        raise Fail(f"{path.name} isn't a readable image")
    return np.asarray(im, dtype=np.uint8)


def _missing(x: object) -> bool:
    return x is None


def _scale_h(H: F64, s: float) -> F64:
    S = np.diag([s, s, 1.0])
    return np.linalg.inv(S) @ H @ S


@dataclass(frozen=True)
class Registration:
    """The homography mapping photo pixels to the resized render's (None when there is none), its feature inliers,
    their median residual in photo pixels, and why it failed."""

    H: F64 | None
    inliers: int
    residual_px: float | None
    reason: str | None


def register(photo: U8, raw: U8, mask: U8) -> Registration:
    """Homography mapping photo pixels to raw-resized pixels, estimated outside the mask.
    photo, raw: BGR uint8 of the same size; mask: uint8 (255 = new furniture)."""
    import cv2

    h, w = photo.shape[:2]
    s = min(1.0, WORK_LONG_SIDE / max(w, h))
    size = (max(1, round(w * s)), max(1, round(h * s)))
    g1 = cv2.cvtColor(cv2.resize(photo, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(cv2.resize(raw, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    # features only where the room should be untouched: outside the (already dilated) mask, plus a margin
    keep = np.asarray(cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST)) < 128
    keep = np.asarray(cv2.erode(keep.astype(np.uint8) * 255, np.ones((9, 9), np.uint8))) > 0
    keep_u8 = keep.astype(np.uint8) * 255
    if keep.mean() < 0.05:
        return Registration(None, 0, None, "the mask covers almost the whole photo")

    sift = cv2.SIFT.create(nfeatures=6000)
    k1, d1 = sift.detectAndCompute(g1, keep_u8)
    k2, d2 = sift.detectAndCompute(g2, keep_u8)
    if len(k1) < 8 or len(k2) < 8:
        return Registration(None, 0, None, "too few features outside the furniture")
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    pairs = matcher.knnMatch(d1, d2, k=2)
    good = [p[0] for p in pairs if len(p) > 1 and p[0].distance < 0.75 * p[1].distance]
    if len(good) < 8:
        return Registration(None, len(good), None, f"only {len(good)} feature matches outside the furniture")
    p1 = np.array([k1[m.queryIdx].pt for m in good], np.float32)
    p2 = np.array([k2[m.trainIdx].pt for m in good], np.float32)
    found, inl_m = cv2.findHomography(p1, p2, cv2.USAC_MAGSAC, RANSAC_PX * s, maxIters=5000, confidence=0.999)
    if _missing(found):  # OpenCV answers None when it finds no homography (its stub doesn't say so)
        return Registration(None, 0, None, "no consistent registration between the render and the photo")
    Hs = np.asarray(found, np.float64)
    inl = np.asarray(inl_m).ravel().astype(bool)
    n_inl = int(inl.sum())
    # ECC refinement at the working size, started from the feature homography (sub-pixel; skipped if it fails)
    try:
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-6)
        # ECC finds W with raw(W x) ~ photo(x): the same direction as Hs (photo -> raw)
        _, He_m = cv2.findTransformECC(g1, g2, Hs.astype(np.float32), cv2.MOTION_HOMOGRAPHY, crit, keep_u8, 5)
        He = np.asarray(He_m, np.float64)
        # keep ECC only if it agrees with the features (it can wander on low-texture photos)
        pe = np.asarray(cv2.perspectiveTransform(p1[inl][None], He), np.float32).reshape(-1, 2)
        pf = np.asarray(cv2.perspectiveTransform(p1[inl][None], Hs), np.float32).reshape(-1, 2)
        if np.median(np.linalg.norm(pe - p2[inl], axis=1)) <= np.median(np.linalg.norm(pf - p2[inl], axis=1)) + 0.3:
            Hs = He
    except cv2.error as e:
        log(f"ECC refinement skipped ({str(e).strip().splitlines()[-1][:80]})")
    proj = np.asarray(cv2.perspectiveTransform(p1[inl][None], Hs), np.float32).reshape(-1, 2)
    residual = float(np.median(np.linalg.norm(proj - p2[inl], axis=1))) / s if n_inl else None
    return Registration(_scale_h(Hs, s), n_inl, residual, None)


def align(photo_path: Path, raw_path: Path, mask_path: Path, out_path: Path) -> AlignResult:
    import cv2

    t0 = time.monotonic()
    for f in (photo_path, raw_path, mask_path):
        if not f.is_file():
            raise Fail(f"{f} doesn't exist")
    photo = _read(photo_path, cv2.IMREAD_COLOR)
    raw = _read(raw_path, cv2.IMREAD_COLOR)
    mask = _read(mask_path, cv2.IMREAD_GRAYSCALE)
    h, w = photo.shape[:2]
    if mask.shape[:2] != (h, w):
        log(f"mask is {mask.shape[1]} x {mask.shape[0]}, photo {w} x {h}: resizing the mask")
        mask = np.asarray(cv2.resize(mask, (w, h), interpolation=cv2.INTER_LINEAR), np.uint8)
    rh, rw = raw.shape[:2]
    if (rw / rh) / (w / h) > 1.15 or (rw / rh) / (w / h) < 1 / 1.15:
        log(f"the render's aspect {rw / rh:.3f} is far from the photo's {w / h:.3f}")
    raw_r = raw if (rw, rh) == (w, h) else np.asarray(
        cv2.resize(raw, (w, h), interpolation=cv2.INTER_CUBIC if rw < w else cv2.INTER_AREA), np.uint8)

    reg = register(photo, raw_r, mask)
    result = AlignResult(ok=True, applied=False, inliers=reg.inliers,
                         residual_px=None if reg.residual_px is None else round(reg.residual_px, 3))
    reason = reg.reason
    if reason is None and reg.inliers < MIN_INLIERS:
        reason = f"only {reg.inliers} feature matches agree (at least {MIN_INLIERS} are needed)"
    if reason is None and reg.residual_px is not None and reg.residual_px > MAX_RESIDUAL_PX:
        reason = f"the median residual is {reg.residual_px:.1f} px (at most {MAX_RESIDUAL_PX:g} px)"
    H = reg.H
    if reason is None and H is not None:
        corners = np.array([[0, 0], [w, 0], [w, h], [0, h]], np.float32)[None]
        moved_to = np.asarray(cv2.perspectiveTransform(corners, H), np.float32).reshape(-1, 2)
        moved = float(np.linalg.norm(moved_to - corners.reshape(-1, 2), axis=1).max())
        if moved > MAX_CORNER_SHIFT * w:
            reason = f"the render's framing differs from the photo's by {moved:.0f} px at a corner"
    if reason is not None or H is None:
        result["reason"] = reason or "no registration"
        log(f"align not applied: {result['reason']}")
        return result

    # H maps photo -> raw_r, so sampling raw_r at H(x) puts it on the photo's pixel grid
    warped = np.asarray(cv2.warpPerspective(raw_r, H, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                                            borderMode=cv2.BORDER_CONSTANT))
    covered = np.asarray(cv2.warpPerspective(np.full((h, w), 255, np.uint8), H, (w, h),
                                             flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_CONSTANT))
    sigma = max(1.0, 0.004 * w)
    alpha = np.asarray(cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), sigma), np.float32)
    alpha = np.clip(alpha, 0, 1) * (covered > 0)
    final = photo.astype(np.float32) * (1 - alpha[..., None]) + warped.astype(np.float32) * alpha[..., None]
    final_u8 = np.clip(np.rint(final), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", final_u8, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise Fail("couldn't encode the aligned render")
    write_atomic(out_path, np.asarray(buf).tobytes())
    result["applied"] = True
    log(f"aligned: {reg.inliers} inliers, median residual {reg.residual_px or 0:.2f} px, {time.monotonic() - t0:.1f} s -> {out_path}")
    return result
