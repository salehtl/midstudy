"""3DGS splat normalization (contract §1): rotate, center the footprint, put it on the floor and fit it PER AXIS to
--dims, covariances included; then splat.spz, the same splats compressed for drawing (SPZ v2, gzipped).

The extent of a splat is a percentile range of its centers, by engine (§1, measured on the fixtures): the 0.1th-99.9th
for idol (dense, nearly floater-free), the 1st-99th for everything else (sam3d has floaters). evals/validate_library.py
measures the same way.
"""
import gzip
import struct
from pathlib import Path

import numpy as np

from . import MidstudyError

# §1 self-check tolerances (same as evals/validate_library.py)
DIM_TOL = 0.02      # fraction, per axis, on the percentile extent
FLOOR_TOL = 0.01    # m, the extent's min y
CENTER_TOL = 0.01   # m, the extent's footprint center

SPLAT_PCT = {"idol": (0.1, 99.9)}
SPLAT_PCT_DEFAULT = (1.0, 99.0)

# SPZ (nianticlabs/spz, version 2), §1
SPZ_MAGIC = 0x5053474E  # "NGSP"
SPZ_VERSION = 2
SPZ_FRACTIONAL_BITS = 12
SPZ_MAX_SPLATS = 262_144
SPZ_COLOR_SCALE = 0.15
SPZ_POS_CHECK = 0.00025  # m: decoded positions must agree with splat.ply this well (1/4096 m steps)

_TYPES = {"float": "f4", "float32": "f4", "double": "f8", "float64": "f8",
          "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
          "ushort": "u2", "uint16": "u2", "short": "i2", "int16": "i2",
          "uint": "u4", "uint32": "u4", "int": "i4", "int32": "i4"}
_REQUIRED = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
             "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def percentiles(engine: str | None) -> tuple[float, float]:
    return SPLAT_PCT.get(engine or "", SPLAT_PCT_DEFAULT)


def read_ply(path: Path) -> np.ndarray:
    """The vertex element of a binary 3DGS PLY as a structured array."""
    raw = path.read_bytes()
    marker = raw.find(b"end_header")
    if not raw.startswith(b"ply") or marker < 0:
        raise MidstudyError(f"{path} is not a PLY file")
    end = raw.index(b"\n", marker) + 1
    lines = raw[:end].decode("ascii", "replace").splitlines()
    fmt = next((ln.split()[1] for ln in lines if ln.startswith("format ")), "")
    if fmt not in ("binary_little_endian", "binary_big_endian"):
        raise MidstudyError(f"{path} is a {fmt or 'unknown'} PLY; only binary PLY splats are supported")
    order = "<" if fmt == "binary_little_endian" else ">"
    count, props, in_vertex = 0, [], False
    for ln in lines:
        parts = ln.split()
        if parts[:1] == ["element"]:
            if in_vertex:
                break  # the vertex element is all we need
            if parts[1] != "vertex":
                raise MidstudyError(f"{path}: the vertex element must come first")
            in_vertex, count = True, int(parts[2])
        elif in_vertex and parts[:1] == ["property"]:
            if parts[1] == "list" or parts[1] not in _TYPES:
                raise MidstudyError(f"{path}: unsupported PLY property '{ln.strip()}'")
            props.append((parts[2], order + _TYPES[parts[1]]))
    missing = [p for p in _REQUIRED if p not in [n for n, _ in props]]
    if missing:
        raise MidstudyError(f"{path} isn't a 3DGS splat (missing {', '.join(missing)})")
    if count == 0:
        raise MidstudyError(f"{path} has no splats")
    dtype = np.dtype(props)
    if len(raw) - end < count * dtype.itemsize:
        raise MidstudyError(f"{path} is truncated")
    return np.frombuffer(raw, dtype=dtype, count=count, offset=end).copy()


def write_ply(path: Path, data: np.ndarray) -> None:
    """Write a binary little-endian PLY with one vertex element, every property as float32."""
    names = list(data.dtype.names)
    out = np.empty(len(data), dtype=[(n, "<f4") for n in names])
    for n in names:
        out[n] = data[n]
    header = f"ply\nformat binary_little_endian 1.0\nelement vertex {len(out)}\n"
    header += "".join(f"property float {n}\n" for n in names) + "end_header\n"
    path.write_bytes(header.encode("ascii") + out.tobytes())


def _xyz(data: np.ndarray) -> np.ndarray:
    return np.stack([data["x"], data["y"], data["z"]], axis=1).astype(np.float64)


def extent(xyz: np.ndarray, engine: str | None) -> tuple[np.ndarray, np.ndarray]:
    lo_p, hi_p = percentiles(engine)
    return np.percentile(xyz, lo_p, axis=0), np.percentile(xyz, hi_p, axis=0)


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    """(n, 4) quaternions (w, x, y, z), any length, to (n, 3, 3) rotation matrices."""
    q = q / np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-30)
    w, x, y, z = q.T
    return np.stack([
        np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], axis=1),
        np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], axis=1),
        np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], axis=1),
    ], axis=1)


def matrix_to_quat(m: np.ndarray) -> np.ndarray:
    """(n, 3, 3) rotation matrices to unit quaternions (w, x, y, z) with w >= 0 (Shepperd's method, batched)."""
    m00, m11, m22 = m[:, 0, 0], m[:, 1, 1], m[:, 2, 2]
    tr = m00 + m11 + m22
    cand = np.stack([tr, m00, m11, m22], axis=1)
    pick = np.argmax(cand, axis=1)
    q = np.empty((len(m), 4))
    s = np.sqrt(np.maximum(1.0 + 2.0 * cand[np.arange(len(m)), pick] - tr, 1e-30)) * 2  # 4 * the largest component
    k = pick == 0
    q[k] = np.stack([0.25 * s[k], (m[k, 2, 1] - m[k, 1, 2]) / s[k], (m[k, 0, 2] - m[k, 2, 0]) / s[k],
                     (m[k, 1, 0] - m[k, 0, 1]) / s[k]], axis=1)
    k = pick == 1
    q[k] = np.stack([(m[k, 2, 1] - m[k, 1, 2]) / s[k], 0.25 * s[k], (m[k, 0, 1] + m[k, 1, 0]) / s[k],
                     (m[k, 0, 2] + m[k, 2, 0]) / s[k]], axis=1)
    k = pick == 2
    q[k] = np.stack([(m[k, 0, 2] - m[k, 2, 0]) / s[k], (m[k, 0, 1] + m[k, 1, 0]) / s[k], 0.25 * s[k],
                     (m[k, 1, 2] + m[k, 2, 1]) / s[k]], axis=1)
    k = pick == 3
    q[k] = np.stack([(m[k, 1, 0] - m[k, 0, 1]) / s[k], (m[k, 0, 2] + m[k, 2, 0]) / s[k],
                     (m[k, 1, 2] + m[k, 2, 1]) / s[k], 0.25 * s[k]], axis=1)
    q /= np.linalg.norm(q, axis=1, keepdims=True)
    q[q[:, 0] < 0] *= -1
    return q


def transform_covariances(data: np.ndarray, linear: np.ndarray) -> None:
    """Apply a linear map A (3x3) to every Gaussian's covariance in place: Σ' = A Σ Aᵀ with Σ = R diag(σ²) Rᵀ, then
    eigh → σ' = sqrt(eigenvalues) (stored as log in scale_*), R' = the eigenvectors (det +1) as rot_0..3 (w, x, y, z).
    For A = S · R0 (a per-axis scale after a rotation) this is §1's Σ' = S Σ S on the rotated splat."""
    q = np.stack([data[f"rot_{i}"] for i in range(4)], axis=1).astype(np.float64)
    sigma = np.exp(np.stack([data[f"scale_{i}"] for i in range(3)], axis=1).astype(np.float64))
    m = linear[None] @ quat_to_matrix(q)                      # A · R
    cov = (m * (sigma ** 2)[:, None, :]) @ np.transpose(m, (0, 2, 1))  # A R diag(σ²) Rᵀ Aᵀ
    cov = (cov + np.transpose(cov, (0, 2, 1))) / 2
    w, v = np.linalg.eigh(cov)
    flip = np.linalg.det(v) < 0
    v[flip, :, 2] *= -1                                       # a rotation, not a reflection
    floor = np.maximum(w.max(axis=1, keepdims=True), 1e-30) * 1e-14
    s_new = np.sqrt(np.maximum(w, np.maximum(floor, 1e-36)))  # eigh's rounding can leave a tiny negative
    qn = matrix_to_quat(v)
    for i in range(3):
        data[f"scale_{i}"] = np.log(s_new[:, i])
    for i in range(4):
        data[f"rot_{i}"] = qn[:, i]


def _drop(data: np.ndarray, names: list[str]) -> np.ndarray:
    keep = [n for n in data.dtype.names if n not in names]
    packed = np.empty(len(data), dtype=[(n, data.dtype[n]) for n in keep])
    for n in keep:
        packed[n] = data[n]
    return packed


def errors_pct(xyz: np.ndarray, dims_m: np.ndarray, engine: str | None) -> dict:
    lo, hi = extent(xyz, engine)
    e = np.abs((hi - lo) - dims_m) / dims_m * 100
    return {"w": round(float(e[0]), 3), "d": round(float(e[2]), 3), "h": round(float(e[1]), 3)}


def self_check(xyz: np.ndarray, dims_m: np.ndarray, engine: str | None) -> None:
    if not np.all(np.isfinite(xyz)):
        raise MidstudyError("self-check failed: splat has non-finite (NaN/inf) positions; the splat is corrupt")
    lo_p, hi_p = percentiles(engine)
    lo, hi = extent(xyz, engine)
    size = hi - lo
    for axis, s, t in zip("whd", size, dims_m):
        if abs(s - t) / t > DIM_TOL:
            raise MidstudyError(f"self-check failed: splat {axis} (p{lo_p:g}-p{hi_p:g}) is {s * 100:.1f} cm, expected "
                                f"{t * 100:.1f} cm ({abs(s - t) / t:.1%} off, max {DIM_TOL:.0%})")
    if abs(lo[1]) > FLOOR_TOL:
        raise MidstudyError(f"self-check failed: splat floor (p{lo_p:g} y) is {lo[1]:.3f} m, max "
                            f"{FLOOR_TOL * 100:.0f} cm from 0")
    cx, cz = (lo[0] + hi[0]) / 2, (lo[2] + hi[2]) / 2
    if abs(cx) > CENTER_TOL or abs(cz) > CENTER_TOL:
        raise MidstudyError(f"self-check failed: splat footprint center is ({cx:.3f}, {cz:.3f}) m, "
                            f"max {CENTER_TOL * 100:.0f} cm from the origin")


def normalize(src: Path, rotation: np.ndarray, dims_m: np.ndarray, out: Path, engine: str | None) -> tuple[dict, list[str]]:
    """Write `out` in the item frame, fitted per axis so the engine's percentile extent of the centers is dims_m
    (w, h, d), with every Gaussian's covariance stretched by the same scale.

    Returns (per-axis fit error in percent, notes). Raises MidstudyError if the written file fails the §1 checks.
    """
    data = read_ply(src)
    notes = []
    normals = [n for n in ("nx", "ny", "nz") if n in data.dtype.names]
    if normals:
        data = _drop(data, normals)  # not part of a 3DGS splat's look (often all zero); §1 drops them
    xyz = _xyz(data) @ rotation.T
    if not np.all(np.isfinite(xyz)):
        raise MidstudyError("the splat has non-finite (NaN/inf) positions; the file is corrupt")
    lo, hi = extent(xyz, engine)
    size = hi - lo
    for axis, s in zip("XYZ", size):
        if s < 1e-6:
            raise MidstudyError(f"the splat is flat along {axis} (its extent is 0), so it can't be fitted to --dims")
    scale = dims_m / size
    center = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    xyz = (xyz - center) * scale
    data["x"], data["y"], data["z"] = xyz.T

    rotated = not np.allclose(rotation, np.eye(3))
    stretched = bool(scale.max() / scale.min() - 1 > 1e-6)
    transform_covariances(data, np.diag(scale) @ rotation)
    rest = [n for n in data.dtype.names if n.startswith("f_rest_")]
    if rest and (rotated or stretched):
        # Rotating or stretching higher-order SH bands isn't implemented: drop them (contract §1 allows it).
        data = _drop(data, rest)
        why = " and ".join(w for w, on in (("rotating", rotated), ("stretching it per axis", stretched)) if on)
        notes.append(f"dropped {len(rest)} f_rest_* SH coefficients (view-dependent colour) after {why}")
    write_ply(out, data)

    written = _xyz(read_ply(out))
    self_check(written, dims_m, engine)
    return errors_pct(written, dims_m, engine), notes


# --- splat.spz (§1): SPZ v2, the layout of nianticlabs/spz, gzipped -------------------------------------------------------
def _u8(v: np.ndarray) -> np.ndarray:
    return np.clip(np.round(v), 0, 255).astype(np.uint8)


def spz_bytes(data: np.ndarray) -> tuple[bytes, np.ndarray]:
    """The gzipped SPZ v2 file for the splats in `data` (positions as they are: the item frame is three.js's, which is
    SPZ's RUB), and the indices it kept (at most SPZ_MAX_SPLATS: the ones that cover the most, opacity times the area of
    their two largest axes. Keeping the most opaque instead kept a live SAM 3D splat's small inner splats: 77-94 % of its
    extent and a see-through surface; this keeps 99-102 %)."""
    n_all = len(data)
    keep = np.arange(n_all)
    if n_all > SPZ_MAX_SPLATS:
        alpha = 1.0 / (1.0 + np.exp(-np.clip(data["opacity"].astype(np.float64), -60, 60)))
        ls = np.sort(np.stack([data[f"scale_{i}"] for i in range(3)], axis=1).astype(np.float64), axis=1)
        cover = alpha * np.exp(ls[:, 1] + ls[:, 2])
        keep = np.sort(np.argpartition(-cover, SPZ_MAX_SPLATS - 1)[:SPZ_MAX_SPLATS])
    d = data[keep]
    n = len(d)
    head = struct.pack("<IIIBBBB", SPZ_MAGIC, SPZ_VERSION, n, 0, SPZ_FRACTIONAL_BITS, 0, 0)
    xyz = _xyz(d)
    fixed = np.round(xyz * (1 << SPZ_FRACTIONAL_BITS)).astype(np.int64)
    lim = (1 << 23) - 1
    if np.abs(fixed).max(initial=0) > lim:
        raise MidstudyError("the splat is over 2 km across: it can't be written as splat.spz")
    fixed &= 0xFFFFFF
    pos = np.stack([fixed & 0xFF, (fixed >> 8) & 0xFF, (fixed >> 16) & 0xFF], axis=-1).astype(np.uint8)  # (n, 3, 3)
    alpha = _u8(255.0 / (1.0 + np.exp(-np.clip(d["opacity"].astype(np.float64), -60, 60))))
    dc = np.stack([d[f"f_dc_{i}"] for i in range(3)], axis=1).astype(np.float64)
    colour = _u8(dc * (SPZ_COLOR_SCALE * 255.0) + 127.5)
    scales = _u8((np.stack([d[f"scale_{i}"] for i in range(3)], axis=1).astype(np.float64) + 10.0) * 16.0)
    q = np.stack([d[f"rot_{i}"] for i in range(4)], axis=1).astype(np.float64)
    q /= np.maximum(np.linalg.norm(q, axis=1, keepdims=True), 1e-30)
    q[q[:, 0] < 0] *= -1
    rot = _u8(q[:, 1:] * 127.5 + 127.5)
    body = b"".join(a.tobytes() for a in (pos, alpha, colour, scales, rot))
    return gzip.compress(head + body, compresslevel=9, mtime=0), keep


def read_spz(path: Path) -> tuple[dict, np.ndarray]:
    """Header and positions of a gzipped SPZ v2 file with SH degree 0 (what write_spz writes)."""
    raw = gzip.decompress(path.read_bytes())
    magic, version, count, sh, frac, flags, _ = struct.unpack_from("<IIIBBBB", raw, 0)
    head = {"magic": magic, "version": version, "count": count, "sh_degree": sh, "fractional_bits": frac, "flags": flags}
    if magic != SPZ_MAGIC or version != SPZ_VERSION or sh != 0 or len(raw) != 16 + count * 19:
        raise MidstudyError(f"{path} isn't the SPZ v2 file midstudy-add writes ({head}, {len(raw)} bytes)")
    b = np.frombuffer(raw, dtype=np.uint8, count=count * 9, offset=16).reshape(count, 3, 3).astype(np.int64)
    v = b[..., 0] | (b[..., 1] << 8) | (b[..., 2] << 16)
    v = np.where(v & 0x800000, v - (1 << 24), v)
    return head, v.astype(np.float64) / (1 << frac)


def write_spz(ply: Path, out: Path) -> dict:
    """Write `out` (splat.spz) from the normalized `ply` (splat.ply), then decode it and check that every kept splat's
    position agrees with the PLY within SPZ_POS_CHECK. Returns {count, dropped, bytes}."""
    data = read_ply(ply)
    packed, keep = spz_bytes(data)
    out.write_bytes(packed)
    head, xyz = read_spz(out)
    want = _xyz(data[keep])
    if head["count"] != len(keep):
        raise MidstudyError(f"self-check failed: splat.spz holds {head['count']} splats, expected {len(keep)}")
    off = float(np.abs(xyz - want).max(initial=0))
    if off > SPZ_POS_CHECK:
        raise MidstudyError(f"self-check failed: splat.spz positions are up to {off * 1000:.2f} mm from splat.ply's "
                            f"(max {SPZ_POS_CHECK * 1000:.2f} mm)")
    return {"count": len(keep), "dropped": len(data) - len(keep), "bytes": len(packed)}
