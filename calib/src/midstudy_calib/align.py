"""`midstudy-calib align` (contract §4.3, §4.7): register the render model's output to the scene photo, then keep
the room exactly: final = photo x (1 - mask) + warped x mask, with the mask feathered.

nano-banana returns about 1 MP at a fixed aspect (2000 x 1125 in -> 1344 x 768 out) and its framing drifts by 1-2 %
of the width, so the output is resized to the photo's size and then registered with a homography estimated from
features outside the mask (where the room should be unchanged): SIFT + ratio test + RANSAC, then an ECC refinement.
"""
from __future__ import annotations

import time
from pathlib import Path

from .util import Fail, log, write_atomic

MIN_INLIERS = 40
MAX_RESIDUAL_PX = 3.0
WORK_LONG_SIDE = 1600   # features are found at this size (the homography is rescaled to the photo's size)
RANSAC_PX = 2.5         # at the photo's size
MAX_CORNER_SHIFT = 0.10  # a registration that moves a corner by more than 10 % of the width is not "the same framing"


def _read(path: Path, flags):
    import cv2
    import numpy as np

    data = np.fromfile(str(path), dtype=np.uint8)
    im = cv2.imdecode(data, flags) if data.size else None
    if im is None:
        raise Fail(f"{path.name} isn't a readable image")
    return im


def _scale_h(H, s: float):
    import numpy as np

    S = np.diag([s, s, 1.0])
    return np.linalg.inv(S) @ H @ S


def register(photo, raw, mask) -> dict:
    """Homography mapping photo pixels to raw-resized pixels, estimated outside the mask.
    photo, raw: BGR uint8 of the same size; mask: uint8 (255 = new furniture). Returns {H, inliers, residual_px, reason}."""
    import cv2
    import numpy as np

    h, w = photo.shape[:2]
    s = min(1.0, WORK_LONG_SIDE / max(w, h))
    size = (max(1, round(w * s)), max(1, round(h * s)))
    g1 = cv2.cvtColor(cv2.resize(photo, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    g2 = cv2.cvtColor(cv2.resize(raw, size, interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY)
    # features only where the room should be untouched: outside the (already dilated) mask, plus a margin
    keep = cv2.resize(mask, size, interpolation=cv2.INTER_NEAREST) < 128
    keep = cv2.erode(keep.astype(np.uint8) * 255, np.ones((9, 9), np.uint8)) > 0
    keep_u8 = keep.astype(np.uint8) * 255
    if keep.mean() < 0.05:
        return {"H": None, "inliers": 0, "residual_px": None, "reason": "the mask covers almost the whole photo"}

    sift = cv2.SIFT_create(nfeatures=6000)
    k1, d1 = sift.detectAndCompute(g1, keep_u8)
    k2, d2 = sift.detectAndCompute(g2, keep_u8)
    if d1 is None or d2 is None or len(k1) < 8 or len(k2) < 8:
        return {"H": None, "inliers": 0, "residual_px": None, "reason": "too few features outside the furniture"}
    matcher = cv2.BFMatcher(cv2.NORM_L2)
    pairs = matcher.knnMatch(d1, d2, k=2)
    good = [m for m, *rest in pairs if rest and m.distance < 0.75 * rest[0].distance]
    if len(good) < 8:
        return {"H": None, "inliers": len(good), "residual_px": None, "reason": f"only {len(good)} feature matches outside the furniture"}
    p1 = np.float32([k1[m.queryIdx].pt for m in good])
    p2 = np.float32([k2[m.trainIdx].pt for m in good])
    Hs, inl = cv2.findHomography(p1, p2, cv2.USAC_MAGSAC, RANSAC_PX * s, maxIters=5000, confidence=0.999)
    if Hs is None:
        return {"H": None, "inliers": 0, "residual_px": None, "reason": "no consistent registration between the render and the photo"}
    inl = inl.ravel().astype(bool)
    n_inl = int(inl.sum())
    # ECC refinement at the working size, started from the feature homography (sub-pixel; skipped if it fails)
    try:
        crit = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 60, 1e-6)
        # ECC finds W with raw(W x) ~ photo(x): the same direction as Hs (photo -> raw)
        _, He = cv2.findTransformECC(g1, g2, Hs.astype(np.float32), cv2.MOTION_HOMOGRAPHY, crit, keep_u8, 5)
        He = He.astype(np.float64)
        # keep ECC only if it agrees with the features (it can wander on low-texture photos)
        pe = cv2.perspectiveTransform(p1[inl][None], He)[0]
        pf = cv2.perspectiveTransform(p1[inl][None], Hs)[0]
        if np.median(np.linalg.norm(pe - p2[inl], axis=1)) <= np.median(np.linalg.norm(pf - p2[inl], axis=1)) + 0.3:
            Hs = He
    except cv2.error as e:
        log(f"ECC refinement skipped ({str(e).strip().splitlines()[-1][:80]})")
    proj = cv2.perspectiveTransform(p1[inl][None], Hs)[0]
    residual = float(np.median(np.linalg.norm(proj - p2[inl], axis=1))) / s if n_inl else None
    return {"H": _scale_h(Hs, s), "inliers": n_inl, "residual_px": residual, "reason": None}


def align(photo_path: Path, raw_path: Path, mask_path: Path, out_path: Path) -> dict:
    import cv2
    import numpy as np

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
        mask = cv2.resize(mask, (w, h), interpolation=cv2.INTER_LINEAR)
    rh, rw = raw.shape[:2]
    if (rw / rh) / (w / h) > 1.15 or (rw / rh) / (w / h) < 1 / 1.15:
        log(f"the render's aspect {rw / rh:.3f} is far from the photo's {w / h:.3f}")
    raw_r = raw if (rw, rh) == (w, h) else cv2.resize(raw, (w, h), interpolation=cv2.INTER_CUBIC if rw < w else cv2.INTER_AREA)

    reg = register(photo, raw_r, mask)
    H = reg["H"]
    result = {"ok": True, "applied": False, "inliers": int(reg["inliers"]),
              "residual_px": None if reg["residual_px"] is None else round(reg["residual_px"], 3)}
    reason = reg["reason"]
    if reason is None and reg["inliers"] < MIN_INLIERS:
        reason = f"only {reg['inliers']} feature matches agree (at least {MIN_INLIERS} are needed)"
    if reason is None and reg["residual_px"] > MAX_RESIDUAL_PX:
        reason = f"the median residual is {reg['residual_px']:.1f} px (at most {MAX_RESIDUAL_PX:g} px)"
    if reason is None:
        corners = np.float32([[0, 0], [w, 0], [w, h], [0, h]])[None]
        moved = np.linalg.norm(cv2.perspectiveTransform(corners, H)[0] - corners[0], axis=1).max()
        if moved > MAX_CORNER_SHIFT * w:
            reason = f"the render's framing differs from the photo's by {moved:.0f} px at a corner"
    if reason is not None:
        result["reason"] = reason
        log(f"align not applied: {reason}")
        return result

    # H maps photo -> raw_r, so sampling raw_r at H(x) puts it on the photo's pixel grid
    warped = cv2.warpPerspective(raw_r, H, (w, h), flags=cv2.INTER_LINEAR | cv2.WARP_INVERSE_MAP,
                                 borderMode=cv2.BORDER_CONSTANT)
    covered = cv2.warpPerspective(np.full((h, w), 255, np.uint8), H, (w, h),
                                  flags=cv2.INTER_NEAREST | cv2.WARP_INVERSE_MAP, borderMode=cv2.BORDER_CONSTANT)
    sigma = max(1.0, 0.004 * w)
    alpha = cv2.GaussianBlur(mask.astype(np.float32) / 255.0, (0, 0), sigma)
    alpha = np.clip(alpha, 0, 1) * (covered > 0)
    final = photo.astype(np.float32) * (1 - alpha[..., None]) + warped.astype(np.float32) * alpha[..., None]
    final = np.clip(np.rint(final), 0, 255).astype(np.uint8)
    ok, buf = cv2.imencode(".jpg", final, [cv2.IMWRITE_JPEG_QUALITY, 92])
    if not ok:
        raise Fail("couldn't encode the aligned render")
    write_atomic(out_path, buf.tobytes())
    result["applied"] = True
    log(f"aligned: {reg['inliers']} inliers, median residual {reg['residual_px']:.2f} px, {time.monotonic() - t0:.1f} s -> {out_path}")
    return result
