"""GLB normalization by editing the node graph only.

The scene roots are wrapped in two new nodes (orientation, then item-frame scale + translation), so meshes,
materials, textures and extensions pass through byte for byte. Bounds are measured with trimesh, the same
way evals/validate_library.py measures them.
"""
import base64
import copy
import json
import logging
import mimetypes
import re
import struct
import urllib.parse
from pathlib import Path

import numpy as np
import trimesh

from . import MidstudyError
from .frames import quat_xyzw

logging.getLogger("trimesh").setLevel(logging.ERROR)

# §1 self-check tolerances (same as evals/validate_library.py)
DIM_TOL = 0.02     # fraction, per axis
CENTER_TOL = 0.01  # m, footprint center
FLOOR_TOL = 0.005  # m, min y

_JSON, _BIN = 0x4E4F534A, 0x004E4942
_UNSUPPORTED = {"KHR_draco_mesh_compression", "EXT_meshopt_compression"}


def read_glb(path: Path) -> tuple[dict, bytes | None]:
    data = path.read_bytes()
    if len(data) < 20 or data[:4] != b"glTF":
        raise MidstudyError(f"{path} is not a GLB file (bad header)")
    version, length = struct.unpack_from("<II", data, 4)
    if version != 2:
        raise MidstudyError(f"{path} is glTF {version}; only glTF 2.0 is supported")
    doc, blob, off = None, None, 12
    end = min(length, len(data))
    while off + 8 <= end:
        size, kind = struct.unpack_from("<II", data, off)
        chunk = data[off + 8 : off + 8 + size]
        off += 8 + size
        if kind == _JSON and doc is None:
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == _BIN and blob is None:
            blob = bytes(chunk)
    if doc is None:
        raise MidstudyError(f"{path} has no JSON chunk")
    return doc, blob


def write_glb(path: Path, doc: dict, blob: bytes | None) -> None:
    j = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    j += b" " * (-len(j) % 4)
    body = struct.pack("<II", len(j), _JSON) + j
    if blob is not None:
        b = blob + b"\0" * (-len(blob) % 4)
        body += struct.pack("<II", len(b), _BIN) + b
    path.write_bytes(b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body)


def _uri_bytes(uri: str, base: Path) -> bytes:
    if uri.startswith("data:"):
        head, _, payload = uri.partition(",")
        return base64.b64decode(payload) if head.endswith(";base64") else urllib.parse.unquote_to_bytes(payload)
    if re.match(r"^[a-z][a-z0-9+.-]*:", uri, re.I):
        raise MidstudyError(f"the glTF links a remote file ({uri}); download it next to the .gltf first")
    p = base / urllib.parse.unquote(uri)
    if not p.is_file():
        raise MidstudyError(f"the glTF links {uri}, which isn't next to it: put the .gltf and its files in one local "
                        f"folder and pass that path, or use a .glb")
    return p.read_bytes()


def load_model(path: Path) -> tuple[dict, bytes | None]:
    """Read a .glb or .gltf into (json, binary chunk), embedding any external buffers and image files."""
    try:
        if path.suffix.lower() == ".gltf":
            doc, blob = json.loads(path.read_text(encoding="utf-8")), None
        else:
            doc, blob = read_glb(path)
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise MidstudyError(f"{path} is not valid glTF JSON ({e})") from None
    if not str(doc.get("asset", {}).get("version", "")).startswith("2"):
        raise MidstudyError(f"{path} is not glTF 2.0")
    bad = _UNSUPPORTED & set(doc.get("extensionsUsed", []))
    if bad:
        raise MidstudyError(f"the model uses {', '.join(sorted(bad))}; re-export it without mesh compression")

    buffers = doc.get("buffers", [])
    externals = [im for im in doc.get("images", []) if im.get("uri") and not im["uri"].startswith("data:")]
    glb_only = len(buffers) == 1 and "uri" not in buffers[0] and blob is not None
    if glb_only and len(blob) < buffers[0].get("byteLength", 0):
        raise MidstudyError(f"{path} is truncated (binary chunk is {len(blob)} of {buffers[0]['byteLength']} bytes)")
    if not externals and (not buffers or glb_only):
        return doc, blob  # already self-contained (the usual GLB)

    # Pack every buffer (and external image) into one binary chunk.
    out, starts = bytearray(), []
    for i, buf in enumerate(buffers):
        out += b"\0" * (-len(out) % 8)
        starts.append(len(out))
        if "uri" in buf:
            out += _uri_bytes(buf["uri"], path.parent)
        elif i == 0 and blob is not None:
            out += blob[: buf.get("byteLength", len(blob))]
        else:
            raise MidstudyError(f"{path}: buffer {i} has no data")
    for view in doc.get("bufferViews", []):
        view["byteOffset"] = view.get("byteOffset", 0) + starts[view.get("buffer", 0)]
        view["buffer"] = 0
    for im in externals:
        data = _uri_bytes(im["uri"], path.parent)
        out += b"\0" * (-len(out) % 8)
        doc.setdefault("bufferViews", []).append({"buffer": 0, "byteOffset": len(out), "byteLength": len(data)})
        out += data
        im["mimeType"] = im.get("mimeType") or mimetypes.guess_type(im["uri"])[0] or "image/png"
        im["bufferView"] = len(doc["bufferViews"]) - 1
        del im["uri"]
    doc["buffers"] = [{"byteLength": len(out)}]
    return doc, bytes(out)


# --- textures without camera metadata (contract §2.8 Privacy) ---------------------------------------------------------
# A model.glb is served (/library/<id>/model.glb). A GLB the user exported can embed photos as textures, with their EXIF
# and GPS. The image data is kept as it is (no re-encode); only the metadata segments and chunks go.
_PNG_SIG = b"\x89PNG\r\n\x1a\n"
_PNG_DROP = {b"eXIf", b"tEXt", b"iTXt", b"zTXt", b"tIME"}


def clean_jpeg(data: bytes) -> bytes | None:
    """The JPEG without APP1-APP15 (EXIF, GPS, XMP, ICC, ...), comments, JFIF thumbnails or JFXX extensions, and
    nothing after EOI; the coded image is copied as it is. None when it isn't a well-formed JPEG."""
    n = len(data)
    if n < 4 or data[:2] != b"\xff\xd8":
        return None
    out, i = bytearray(b"\xff\xd8"), 2
    while i < n:
        if data[i] != 0xFF:
            return None
        while i < n and data[i] == 0xFF:
            i += 1
        if i >= n:
            return None
        m = data[i]
        i += 1
        if m == 0xD9:
            return bytes(out + b"\xff\xd9")
        if 0xD0 <= m <= 0xD7 or m == 0x01:
            out += bytes((0xFF, m))
            continue
        if m == 0x00 or i + 2 > n:
            return None
        length = (data[i] << 8) | data[i + 1]
        if length < 2 or i + length > n:
            return None
        seg = data[i:i + length]
        if m == 0xE0:
            if seg[2:7] == b"JFIF\x00" and length >= 16:
                out += b"\xff\xe0\x00\x10" + seg[2:14] + b"\x00\x00"
        elif not (0xE1 <= m <= 0xEF or m == 0xFE):
            out += bytes((0xFF, m)) + seg
        i += length
        if m == 0xDA:
            j = i
            while True:
                j = data.find(b"\xff", j)
                if j < 0 or j + 1 >= n:
                    return None
                if data[j + 1] == 0x00 or 0xD0 <= data[j + 1] <= 0xD7:
                    j += 2
                    continue
                break
            out += data[i:j]
            i = j
    return None


def clean_png(data: bytes) -> bytes | None:
    """The PNG without eXIf, text or time chunks and nothing after IEND. None when it isn't a well-formed PNG."""
    if data[:8] != _PNG_SIG:
        return None
    out, i = bytearray(_PNG_SIG), 8
    while i + 12 <= len(data):
        size = struct.unpack(">I", data[i:i + 4])[0]
        kind = data[i + 4:i + 8]
        end = i + 12 + size
        if end > len(data):
            return None
        if kind not in _PNG_DROP:
            out += data[i:end]
        i = end
        if kind == b"IEND":
            return bytes(out)
    return None


def _clean_image(data: bytes) -> bytes | None:
    return clean_jpeg(data) if data[:2] == b"\xff\xd8" else clean_png(data) if data[:8] == _PNG_SIG else None


def scrub_images(doc: dict, blob: bytes | None) -> tuple[bytes | None, int]:
    """Strip camera metadata from every embedded texture (bufferView or data: URI). A cleaned image is written at its
    bufferView's start, the view's byteLength shrinks and the bytes it no longer covers are zeroed, so no other view
    moves. Returns the new binary chunk and how many images changed."""
    buf = bytearray(blob) if blob is not None else None
    views = doc.get("bufferViews", [])
    changed = 0
    for im in doc.get("images", []):
        if isinstance(im.get("bufferView"), int) and buf is not None and 0 <= im["bufferView"] < len(views):
            view = views[im["bufferView"]]
            off, ln = view.get("byteOffset", 0), view.get("byteLength", 0)
            data = bytes(buf[off:off + ln])
            clean = _clean_image(data)
            if clean is not None and clean != data:
                buf[off:off + len(clean)] = clean
                buf[off + len(clean):off + ln] = b"\0" * (ln - len(clean))
                view["byteLength"] = len(clean)
                changed += 1
        elif isinstance(im.get("uri"), str) and im["uri"].startswith("data:") and ";base64," in im["uri"]:
            head, _, payload = im["uri"].partition(",")
            data = base64.b64decode(payload)
            clean = _clean_image(data)
            if clean is not None and clean != data:
                im["uri"] = f"{head},{base64.b64encode(clean).decode('ascii')}"
                changed += 1
    return (bytes(buf) if buf is not None else None), changed


def measure(path: Path) -> np.ndarray:
    """Axis-aligned bounds [[x0,y0,z0],[x1,y1,z1]] in meters, as evals/validate_library.py computes them."""
    try:
        scene = trimesh.load(str(path), force="scene")
    except Exception as e:  # noqa: BLE001 - any loader failure becomes one actionable line
        detail = f"{type(e).__name__}: {e}" if str(e) else type(e).__name__
        raise MidstudyError(f"couldn't read the model's geometry ({detail}); the file may be corrupt") from None
    if scene.is_empty or scene.bounds is None:
        raise MidstudyError("the model has no mesh geometry")
    return np.asarray(scene.bounds, float)


def errors_pct(bounds: np.ndarray, dims_m: np.ndarray) -> dict:
    """Per-axis size error in percent; dims_m is (w, h, d) i.e. (X, Y, Z)."""
    size = bounds[1] - bounds[0]
    e = np.abs(size - dims_m) / dims_m * 100
    return {"w": round(float(e[0]), 3), "d": round(float(e[2]), 3), "h": round(float(e[1]), 3)}


def self_check(bounds: np.ndarray, dims_m: np.ndarray) -> None:
    if not np.all(np.isfinite(bounds)):
        raise MidstudyError("self-check failed: GLB has non-finite (NaN/inf) coordinates; the model is corrupt")
    (x0, y0, z0), (x1, y1, z1) = bounds
    size = bounds[1] - bounds[0]
    for axis, s, t in zip("whd", size, dims_m):
        if abs(s - t) / t > DIM_TOL:
            raise MidstudyError(f"self-check failed: GLB {axis} is {s * 100:.1f} cm, expected {t * 100:.1f} cm "
                            f"({abs(s - t) / t:.1%} off, max {DIM_TOL:.0%})")
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    if abs(cx) > CENTER_TOL or abs(cz) > CENTER_TOL:
        raise MidstudyError(f"self-check failed: GLB footprint center is ({cx:.3f}, {cz:.3f}) m, "
                        f"max {CENTER_TOL * 100:.0f} cm from the origin")
    if abs(y0) > FLOOR_TOL:
        raise MidstudyError(f"self-check failed: GLB min y is {y0:.3f} m, max {FLOOR_TOL * 100:.1f} cm from 0")


def normalize(src: Path, rotation: np.ndarray, dims_m: np.ndarray, out: Path) -> dict:
    """Write `out` in the item frame: rotated, footprint centered, on the floor, scaled per axis to dims_m (w, h, d).

    Returns the per-axis fit error in percent. Raises MidstudyError if the written file fails the §1 checks.
    """
    doc, blob = load_model(src)
    doc = copy.deepcopy(doc)
    blob, scrubbed = scrub_images(doc, blob)  # model.glb is served: no camera metadata in its textures
    if scrubbed:
        logging.getLogger("midstudy").info("removed camera metadata from %d texture(s)", scrubbed)
    nodes = doc.setdefault("nodes", [])
    scenes = doc.setdefault("scenes", [])
    if not scenes:
        children = {c for n in nodes for c in n.get("children", [])}
        scenes.append({"nodes": [i for i in range(len(nodes)) if i not in children]})
    scene = scenes[doc.setdefault("scene", 0)]
    for node in nodes:
        # trimesh 4.x (nixpkgs) calls its graph root "world" and drops the transforms above a node with that
        # name when it reads the GLB back, so the wrappers below would be ignored. trimesh's own exports use it.
        if node.get("name") == "world":
            node["name"] = "world_root"

    nodes.append({"name": "midstudy_orientation", "rotation": quat_xyzw(rotation), "children": list(scene.get("nodes", []))})
    frame = {"name": "midstudy_item_frame", "children": [len(nodes) - 1]}
    nodes.append(frame)
    scene["nodes"] = [len(nodes) - 1]

    write_glb(out, doc, blob)
    lo, hi = measure(out)
    size = hi - lo
    for axis, s in zip("XYZ", size):
        if s < 1e-6:
            raise MidstudyError(f"the model is flat along {axis} (size 0), so it can't be scaled to --dims")
    k = dims_m / size
    center = np.array([(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2])
    frame["scale"] = [float(v) for v in k]
    frame["translation"] = [float(v) for v in -k * center]
    write_glb(out, doc, blob)

    bounds = measure(out)
    self_check(bounds, dims_m)
    return errors_pct(bounds, dims_m)
