"""lighting.json (contract §4.8): the room's light, inferred from the photo and MoGe-2's normals. numpy + OpenCV only.

Model. A diffuse surface of albedo rho (linear RGB) with world normal n shows the radiance

    L(n) = rho / pi * E(n),   E(n) = a + b * n_y + I * max(0, n . l)          (three.js units, per colour channel)

a hemisphere-like ambient (a, b: brighter from above than from below when b > 0) plus one key light from the unit
direction l. That is how three.js lights a diffuse surface with a LightProbe (bands 0 and 1) and a DirectionalLight,
so the planner can use the result as it is.

Steps (all on MoGe's output at depth size, about 1024 px):
1. Radiance: the photo's sRGB pixels are linearised and taken back through three.js's ACES Filmic curve (exposure 1),
   the tone mapping the planner draws furniture with. Over-exposed pixels (lamps, windows, highlights; dilated) and
   near-black ones are dropped.
2. Direction: inverse rendering can't tell a surface's own colour from its light, except where the colour is known to
   be the same. Pairs of pixels a few pixels apart on the two sides of a crease in MoGe's geometry (a box's top and
   front, two walls at a corner, a wall and the ceiling: normals at least 20 degrees apart, the two 3D points close,
   so no occlusion edge, similar chromaticity, and neither on the floor: what stands on a floor is rarely made of
   it) are taken to be the same material, so their brightness ratio is
   E(n1) / E(n2), which depends on the light alone. For every direction on a grid, a weighted least-squares fit of
   (b / a, I / a) to those ratios (linear in them), with Tukey weights on the log residuals; the best direction is
   refined on a finer grid. Shading barely tells a key light high above from an ambient brighter from above, so b / a
   is pulled weakly towards BETA and the key's elevation towards EL0.
3. Confidence: how sharply the ratios prefer that direction over the rest, how many creases there are and how strong
   the key is against the ambient. A low confidence lifts the key towards overhead and softens its shadow.
4. Level and colour: per colour channel, the same fit with the direction fixed gives the shape of E; every pixel then
   gives an albedo pi * radiance / E. Two assumptions about rooms set the level and colour: the brighter surfaces
   (walls, ceilings) have an albedo near WALL_ALBEDO, and the room's materials average out to grey (shades of grey).

The fit is done in the world frame of the calibration's camera and stored in the camera frame, so the planner turns it
with the scene's current camera (Adjust floor keeps it right without a refit).
"""
from __future__ import annotations

import math
import time

import numpy as np

from .floor import CV_TO_THREE

# three.js ACES Filmic (tonemapping_pars_fragment.glsl.js, 0.180.0): out = OUT · RRTODT(IN · c · exposure / 0.6)
ACES_IN = np.array([[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]])
ACES_OUT = np.array([[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]])
ACES_IN_INV = np.linalg.inv(ACES_IN)
ACES_OUT_INV = np.linalg.inv(ACES_OUT)
SH_C0, SH_C1 = 0.886227, 2 * 0.511664  # three.js shGetIrradianceAt: E = SH_C0 L00 + SH_C1 (L1-1 y + L10 z + L11 x) + ...
LUMA = np.array([0.2126, 0.7152, 0.0722])

CLIP_U8 = 244           # a channel at or above this is (nearly) clipped: no radiance can be read from it
DARK_U8 = 10            # every channel below this: noise
MAX_DEPTH_M = 12.0
PAIR_OFFSET = 7         # pixels between the two samples of a pair (at depth size)
CREASE_DEG = 20.0       # the two normals at least this far apart
FLAT_DEG = 6.0          # each sample's normal within this of its neighbours 2 px away (not on the crease itself)
SAME_CHROMA = 0.30      # log-chromaticity distance below which the two sides count as the same material
BETA, LAM_B = 0.35, 0.3   # prior: b / a towards BETA, weight LAM_B (relative to the data's total weight)
EL0, EL_SIG, MU = 40.0, 25.0, 0.05  # prior: key elevation towards EL0 degrees
MIN_KEY_Y = 0.1         # the key comes from at least ~6 degrees above the horizon
TUKEY_C = 0.25          # log-ratio scale for the robust weights
WALL_ALBEDO = 0.8       # the albedo luminance assumed at the BRIGHT_Q quantile of the pixels' albedos
BRIGHT_Q = 0.85
GREY_P = 4.0            # shades-of-grey exponent
MIN_PAIRS = 25          # fewer creases than this: no direction from the photo (a soft overhead key)
CHANNEL_KEEP = 0.25     # how much of each colour channel's own crease fit is kept (the rest: the luminance fit)
EMITTER = 1.0           # albedo above this (after the level is set) is a light source or a highlight, not a surface
DEBUG: dict = {}        # intermediate values, for tests and measurements only


def srgb_to_linear(u8: np.ndarray) -> np.ndarray:
    c = u8.astype(np.float64) / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def aces(radiance: np.ndarray, exposure: float = 1.0) -> np.ndarray:
    """three.js ACESFilmicToneMapping: linear radiance (..., 3) -> display-linear [0, 1]."""
    v = (radiance * (exposure / 0.6)) @ ACES_IN.T
    v = (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081)
    return np.clip(v @ ACES_OUT.T, 0, 1)


def aces_inverse(display: np.ndarray, exposure: float = 1.0) -> np.ndarray:
    """The inverse of aces() for display-linear values (..., 3); values near saturation come back large, not exact."""
    y = np.clip(display @ ACES_OUT_INV.T, 0, 0.995)
    A, B, C, D, E = 0.0245786, 0.000090537, 0.983729, 0.4329510, 0.238081
    qa, qb, qc = 1 - y * C, A - y * D, -(B + y * E)
    v = (-qb + np.sqrt(np.maximum(qb * qb - 4 * qa * qc, 0))) / (2 * qa)
    return np.maximum(v @ ACES_IN_INV.T, 0) * (0.6 / exposure)


def cam_rotation(camera: dict) -> np.ndarray:
    """Contract §4.1 camera-to-world rotation R = Rx(pitch) · Rz(roll) (three.js Euler 'YXZ', yaw 0)."""
    p, r = math.radians(camera["pitch_deg"]), math.radians(camera["roll_deg"])
    cp, sp, cr, sr = math.cos(p), math.sin(p), math.cos(r), math.sin(r)
    return np.array([[cr, -sr, 0], [cp * sr, cp * cr, -sp], [sp * sr, sp * cr, cp]])


def fibonacci_dirs(n: int, min_y: float = -1.0) -> np.ndarray:
    """About n unit vectors spread evenly over the sphere, keeping those with y >= min_y."""
    i = np.arange(n) + 0.5
    y = 1 - 2 * i / n
    r = np.sqrt(1 - y * y)
    phi = math.pi * (3 - math.sqrt(5)) * i
    d = np.stack([r * np.cos(phi), y, r * np.sin(phi)], 1)
    return d[d[:, 1] >= min_y]


def cct(rgb_linear: np.ndarray) -> float:
    """Correlated colour temperature (K) of a linear sRGB colour: CIE xy, then McCamy's approximation."""
    M = np.array([[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]])
    X, Y, Z = M @ np.maximum(np.asarray(rgb_linear, float), 1e-9)
    s = X + Y + Z
    x, y = X / s, Y / s
    n = (x - 0.3320) / (0.1858 - y)
    return float(np.clip(449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33, 1000, 40000))


def ref_normals() -> np.ndarray:
    """World normals a placed piece shows the camera: up, the two sides, the front and the front corners."""
    v = np.array([[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [1, 0, 1], [-1, 0, 1]], float)
    return v / np.linalg.norm(v, axis=1, keepdims=True)


def _crease_pairs(n: np.ndarray, p: np.ndarray, chroma: np.ndarray, ok: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Flat indices (into h * w) of the two samples of every crease pair."""
    h, w = ok.shape
    K = PAIR_OFFSET
    cos_crease = math.cos(math.radians(CREASE_DEG))
    A, B = [], []
    flat_idx = np.arange(h * w).reshape(h, w)
    for dy, dx in ((0, K), (K, 0), (K, K), (K, -K)):
        y0, y1 = 0, h - dy
        x0, x1 = max(0, -dx), w - max(0, dx)
        sa = (slice(y0, y1), slice(x0, x1))
        sb = (slice(y0 + dy, y1 + dy), slice(x0 + dx, x1 + dx))
        m = ok[sa] & ok[sb]
        m &= (n[sa] * n[sb]).sum(-1) < cos_crease
        dist = np.linalg.norm(p[sa] - p[sb], axis=-1)
        zmin = np.minimum(-p[sa][..., 2], -p[sb][..., 2])
        m &= dist < 0.035 * zmin + 0.02
        m &= np.linalg.norm(chroma[sa] - chroma[sb], axis=-1) < SAME_CHROMA
        A.append(flat_idx[sa][m])
        B.append(flat_idx[sb][m])
    return np.concatenate(A), np.concatenate(B)


def _fit_dirs(n1: np.ndarray, n2: np.ndarray, ratio: np.ndarray, dirs: np.ndarray, w: np.ndarray, beta: float = BETA):
    """For every direction: (b, I) with a = 1 from E(n1) - ratio E(n2) = 0, i.e.
    (n1y - ratio n2y) b + (m1 - ratio m2) I = ratio - 1, weighted, with the prior LAM_B (b - beta)^2. Returns b (J,),
    I (J,), the residual (J,) and the clamped cosines of both samples (N, J)."""
    M1, M2 = np.maximum(n1 @ dirs.T, 0), np.maximum(n2 @ dirs.T, 0)
    xb = n1[:, 1] - ratio * n2[:, 1]
    xi = M1 - ratio[:, None] * M2
    y = ratio - 1
    lam = LAM_B * w.sum()
    g11 = (w * xb * xb).sum() + lam
    g12 = (w[:, None] * xb[:, None] * xi).sum(0)
    g22 = (w[:, None] * xi * xi).sum(0) + 1e-9
    r1 = (w * xb * y).sum() + lam * beta
    r2 = (w[:, None] * xi * y[:, None]).sum(0)
    det = g11 * g22 - g12 * g12
    b = (r1 * g22 - g12 * r2) / det
    I = (g11 * r2 - g12 * r1) / det
    neg = I < 0                                     # no negative key: refit b alone there
    b = np.where(neg, r1 / g11, b)
    I = np.maximum(I, 0)
    res = (w[:, None] * (xb[:, None] * b[None] + xi * I[None] - y[:, None]) ** 2).sum(0) + lam * (b - beta) ** 2
    return b, I, res, M1, M2


def _el_penalty(dirs: np.ndarray) -> np.ndarray:
    el = np.degrees(np.arcsin(np.clip(dirs[:, 1], -1, 1)))
    return 1 + MU * ((el - EL0) / EL_SIG) ** 2


def _direction(n1: np.ndarray, n2: np.ndarray, ratio: np.ndarray) -> dict:
    """The key direction (world) from the crease pairs' luminance ratios, with b / a, I / a and how sharp the choice is."""
    dirs = fibonacci_dirs(1200, MIN_KEY_Y)
    pen = _el_penalty(dirs)
    w = np.ones(len(ratio))
    for _ in range(6):
        b, I, res, M1, M2 = _fit_dirs(n1, n2, ratio, dirs, w)
        res = res * pen
        j = int(np.argmin(res))
        E1 = 1 + b[j] * n1[:, 1] + I[j] * M1[:, j]
        E2 = 1 + b[j] * n2[:, 1] + I[j] * M2[:, j]
        r = np.log(np.maximum(ratio, 1e-6)) - np.log(np.maximum(E1, 1e-6) / np.maximum(E2, 1e-6))
        u = np.clip(np.abs(r) / TUKEY_C, 0, 1)
        w = (1 - u * u) ** 2 / np.maximum(E2, 1e-3) ** 2    # relative error, robust
    sharp = float((np.percentile(res, 10) - res.min()) / max(float(res.min()), 1e-12))
    near = fibonacci_dirs(30000, MIN_KEY_Y)
    near = near[near @ dirs[j] > math.cos(math.radians(6))]
    bn, In, rn, _, _ = _fit_dirs(n1, n2, ratio, near, w)
    rn = rn * _el_penalty(near)
    k = int(np.argmin(rn))
    return {"l": near[k], "b": float(bn[k]), "I": float(In[k]), "sharp": sharp, "w": w}


def fit(rgb: np.ndarray, points_cv: np.ndarray, normals_cv: np.ndarray, valid: np.ndarray, camera: dict,
        floor_inliers: np.ndarray | None = None, image: dict | None = None) -> dict | None:
    """lighting.json's content (contract §4.8) from MoGe-2's output at depth size: rgb (h, w, 3) uint8, points and
    normals (h, w, 3) in the OpenCV camera frame, valid (h, w), and the calibrated camera block. None when the photo
    gives too little to go on (the planner then keeps its v1 lights)."""
    import cv2

    t0 = time.monotonic()
    R = cam_rotation(camera)
    rad = aces_inverse(srgb_to_linear(rgb))
    n = np.nan_to_num(normals_cv) * CV_TO_THREE                         # three.js camera frame
    p = np.nan_to_num(points_cv) * CV_TO_THREE
    nlen = np.linalg.norm(n, axis=-1, keepdims=True)
    n = n / np.maximum(nlen, 1e-9)
    n = np.where(((n * p).sum(-1) > 0)[..., None], -n, n)                # facing the camera
    z = points_cv[..., 2]
    with np.errstate(invalid="ignore"):
        finite = valid & np.isfinite(points_cv).all(-1) & np.isfinite(normals_cv).all(-1) & (z > 0) & (z < MAX_DEPTH_M) & (nlen[..., 0] > 0.5)
    clipped = rgb.max(-1) >= CLIP_U8
    clipped_d = cv2.dilate(clipped.astype(np.uint8), np.ones((5, 5), np.uint8)) > 0
    ok = finite & ~clipped_d & (rgb.max(-1) >= DARK_U8)
    if ok.mean() < 0.05:
        return None
    flat = ok.copy()
    cos_flat = math.cos(math.radians(FLAT_DEG))
    for dy, dx in ((0, 2), (2, 0), (0, -2), (-2, 0)):
        flat &= (n * np.roll(n, (dy, dx), (0, 1))).sum(-1) > cos_flat
    lg = np.log(rad + 0.003)
    chroma = np.stack([lg[..., 0] - lg[..., 1], lg[..., 2] - lg[..., 1]], -1)

    # 1. direction from the crease pairs (world frame). A crease with the floor on one side is where something stands
    # on it (a sofa's base, a skirting board): two materials, so the floor's pixels don't pair.
    ia, ib = _crease_pairs(n, p, chroma, flat & ~floor_inliers if floor_inliers is not None else flat)
    nw = n.reshape(-1, 3) @ R.T
    lum = rad.reshape(-1, 3) @ LUMA
    n_pairs = int(len(ia))
    up = np.array([0.0, 1.0, 0.0])
    if n_pairs >= MIN_PAIRS:
        ratio = lum[ia] / np.maximum(lum[ib], 1e-6)
        dfit = _direction(nw[ia], nw[ib], ratio)
        l, b_l, i_l, sharp, pw = dfit["l"], dfit["b"], dfit["I"], dfit["sharp"], dfit["w"]
    else:
        l, b_l, i_l, sharp, pw = up.copy(), BETA, 0.0, 0.0, None
    directness = i_l / max(1 + b_l * max(float(l[1]), 0) + i_l, 1e-6)   # share of the light on a surface facing the key
    conf = float(np.clip(min(1.0, sharp / 0.5) * min(1.0, n_pairs / 150) * min(1.0, directness / 0.35), 0, 1))
    # an unclear direction: lift the key towards overhead, in proportion to the doubt
    el = math.degrees(math.asin(float(np.clip(l[1], -1, 1))))
    az = math.atan2(float(l[0]), float(-l[2]))
    el_used = el + (75.0 - el) * (1 - conf) ** 2
    ce = math.cos(math.radians(el_used))
    l_used = np.array([ce * math.sin(az), math.sin(math.radians(el_used)), -ce * math.cos(az)])

    # 2. per-channel shape with the direction fixed (each channel's ratios, pulled halfway to the luminance fit)
    shape = np.zeros((3, 3))                                             # rows a, b, I (a = 1); columns RGB
    shape[0] = 1.0
    shape[1] = b_l
    shape[2] = i_l
    if n_pairs >= MIN_PAIRS:
        radf = rad.reshape(-1, 3)
        for c in range(3):
            rc = radf[ia, c] / np.maximum(radf[ib, c], 1e-6)
            bc, ic, _, _, _ = _fit_dirs(nw[ia], nw[ib], rc, l_used[None], pw, beta=b_l)
            shape[1, c] = CHANNEL_KEEP * float(bc[0]) + (1 - CHANNEL_KEEP) * b_l
            shape[2, c] = CHANNEL_KEEP * float(ic[0]) + (1 - CHANNEL_KEEP) * i_l
    # 3. level and colour from every usable pixel's albedo
    use = ok.reshape(-1)
    nu = nw[use]
    E = shape[0][None] + nu[:, 1:2] * shape[1][None] + np.maximum(nu @ l_used, 0)[:, None] * shape[2][None]
    alb = math.pi * rad.reshape(-1, 3)[use] / np.maximum(E, 1e-6)
    alum = alb @ LUMA
    k_lvl = WALL_ALBEDO / max(float(np.quantile(alum, BRIGHT_Q)), 1e-6)
    # what no paint can be (albedo over EMITTER at that level: a window, a lamp, a highlight) doesn't count for colour
    surf = alum * k_lvl < EMITTER
    grey = np.power(np.mean(np.power(np.maximum(alb[surf], 1e-6), GREY_P), 0), 1 / GREY_P)
    k = k_lvl * (float(grey @ LUMA) / grey)                              # albedo *= k: the bright ones 0.7, on average grey
    coef = shape / k[None, :]
    a, b, I = coef

    up_cam = R.T @ up
    sh = np.zeros((9, 3))
    sh[0] = a / SH_C0
    k1 = b / SH_C1
    sh[1], sh[2], sh[3] = k1 * up_cam[1], k1 * up_cam[2], k1 * up_cam[0]
    l_cam = R.T @ l_used
    i_max = float(I.max())
    key_color = I / i_max if i_max > 1e-9 else np.ones(3)
    softness = float(np.clip(0.95 - 1.6 * directness, 0.1, 0.95))
    softness = max(softness, 0.85 * (1 - conf))
    rn = ref_normals()
    tot = (a[None] + rn[:, 1:2] * b[None] + np.maximum(rn @ l_used, 0)[:, None] * I[None]).mean(0)
    rnd = lambda v, d=6: [round(float(x), d) for x in v]  # noqa: E731
    out = {
        "version": 1, "source": "photo", "frame": "camera", "image": image, "camera": dict(camera),
        "ambient": {"sh": [rnd(row) for row in sh]},
        "key": {"direction": rnd(l_cam / np.linalg.norm(l_cam)), "color": rnd(key_color), "intensity": round(i_max, 6),
                "softness": round(softness, 3), "confidence": round(conf, 3)},
        "white_balance": {"rgb": rnd(tot / max(float(tot @ LUMA), 1e-9)), "cct_k": round(cct(tot))},
        "fit": {"method": "crease pairs", "pairs": n_pairs, "sharpness": round(sharp, 3), "directness": round(directness, 3),
                "world_key": {"azimuth_deg": round(math.degrees(az), 1), "elevation_deg": round(el_used, 1), "fitted_elevation_deg": round(el, 1)},
                "clipped": round(float(clipped[finite].mean()), 4) if finite.any() else None,
                "elapsed_s": round(time.monotonic() - t0, 3)},
    }
    if floor_inliers is not None:
        fm = floor_inliers & ok
        if fm.any():
            out["floor"] = {"radiance": rnd(np.median(rad[fm], 0))}
    DEBUG.update(ia=ia, ib=ib, l=l, l_used=l_used, coef=coef, k=k, sharp=sharp, conf=conf)
    return out
