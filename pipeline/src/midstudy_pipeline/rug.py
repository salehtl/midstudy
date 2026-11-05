"""--engine rug: a flat rug from a top-down picture, with no model call ($0).

A shop's rug picture is the rug seen from straight above, usually on a plain margin. SAM 3D can't use that: it finds
no object in a picture that is all rug, and a flat top view has no shape to rebuild. A rug is a picture on a thin
slab anyway, so this builds one directly, in the item frame: the picture (margin cropped) on the top face, the sides
and bottom in the rug's edge colour, W x D x H as given (H is the thickness, ~1 cm). The picture's top edge is the
rug's back (-Z), its left edge is -X. When the picture is the other way round from W x D (portrait picture, wide
rug), the picture is turned a quarter so its long side runs along the rug's long side.
"""
import io
from pathlib import Path

import numpy as np

from . import MidstudyError
from .glb import write_glb

MAX_TEXTURE = 2048    # px, long side of the texture in the GLB
MARGIN_DIFF = 28      # 0-255: a pixel this far from the margin colour is rug
MARGIN_STD = 12       # the border must be about this even to count as a plain margin
ROW_FRACTION = 0.02   # a row or column is rug when this share of it is
ASPECT_NOTE = 0.08    # mention it when the picture's aspect is this far from W:D


def crop_margin(im):
    """The picture without its plain margin (white, grey, any one colour), or as is when there's none.
    Returns (image, box or None)."""
    rgb = np.asarray(im.convert("RGB"), dtype=np.int16)
    h, w, _ = rgb.shape
    b = max(2, min(h, w) // 100)
    border = np.concatenate([rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3),
                             rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3)])
    if border.std(axis=0).max() > MARGIN_STD:
        return im, None  # the picture runs to its edges (a photo of the rug, not a cut-out)
    bg = np.median(border, axis=0)
    rug = np.abs(rgb - bg).max(axis=2) > MARGIN_DIFF
    rows = np.flatnonzero(rug.mean(axis=1) > ROW_FRACTION)
    cols = np.flatnonzero(rug.mean(axis=0) > ROW_FRACTION)
    if rows.size == 0 or cols.size == 0:
        raise MidstudyError("the picture looks like one plain colour: use a picture of the rug itself")
    box = (int(cols[0]), int(rows[0]), int(cols[-1]) + 1, int(rows[-1]) + 1)
    if (box[2] - box[0]) * (box[3] - box[1]) < 0.15 * w * h:
        return im, None  # too small to be the rug: more likely a pattern on a plain rug, keep it all
    return im.crop(box), box


def prepare(image: Path, w_cm: float, d_cm: float):
    """The texture for the top face: margin cropped, turned to match W x D, at most MAX_TEXTURE px.
    Returns (PIL image, notes)."""
    from PIL import Image, ImageOps

    notes = []
    with Image.open(image) as src:
        im = ImageOps.exif_transpose(src).convert("RGB")
    im, box = crop_margin(im)
    if box:
        notes.append(f"cropped the picture's plain margin to {box[2] - box[0]} x {box[3] - box[1]} px")
    want = w_cm / d_cm
    have = im.width / im.height
    if abs(np.log(1 / have / want)) < abs(np.log(have / want)):
        im = im.transpose(Image.Transpose.ROTATE_270)  # a quarter turn clockwise: the picture's top goes to +X
        have = 1 / have
        notes.append("turned the picture a quarter so its long side runs along the rug's long side")
    if abs(have / want - 1) > ASPECT_NOTE:
        notes.append(f"the picture is {have:.2f}:1 but {w_cm:g} x {d_cm:g} cm is {want:.2f}:1, so the pattern is "
                     "stretched to fit: check the size")
    scale = MAX_TEXTURE / max(im.size)
    if scale < 1:
        im = im.resize((max(1, round(im.width * scale)), max(1, round(im.height * scale))), Image.Resampling.LANCZOS)
    return im, notes


def edge_colour(im) -> list[float]:
    """Linear RGBA for the sides: the average colour of the rug's outer rim."""
    a = np.asarray(im.convert("RGB"), dtype=np.float64) / 255
    b = max(1, min(a.shape[:2]) // 50)
    rim = np.concatenate([a[:b].reshape(-1, 3), a[-b:].reshape(-1, 3), a[:, :b].reshape(-1, 3), a[:, -b:].reshape(-1, 3)])
    srgb = rim.mean(axis=0)
    lin = np.where(srgb <= 0.04045, srgb / 12.92, ((srgb + 0.055) / 1.055) ** 2.4)
    return [round(float(v), 4) for v in lin] + [1.0]


def _quad(corners, normal, uvs=None):
    """Two triangles for 4 corners in order around the quad, wound counterclockwise seen from `normal`."""
    p = np.asarray(corners, np.float32)
    tri = [0, 1, 2, 0, 2, 3]
    if np.dot(np.cross(p[1] - p[0], p[2] - p[0]), normal) < 0:
        tri = [0, 2, 1, 0, 3, 2]
    return p, np.tile(np.asarray(normal, np.float32), (4, 1)), (None if uvs is None else np.asarray(uvs, np.float32)), tri


def build(image: Path, dims_cm: tuple[float, float, float], out: Path, texture_out: Path | None = None) -> list[str]:
    """Write the rug GLB (item frame, meters) to `out`; optionally the cropped texture as a JPEG. Returns notes."""
    w_cm, d_cm, h_cm = dims_cm
    tex, notes = prepare(image, w_cm, d_cm)
    if h_cm > 10:
        notes.append(f"a rug {h_cm:g} cm thick: H is the thickness (about 1 cm for most rugs)")
    if texture_out is not None:
        tex.save(texture_out, "JPEG", quality=90)
    buf = io.BytesIO()
    tex.save(buf, "JPEG", quality=90)
    jpeg = buf.getvalue()

    x, y, z = w_cm / 200, h_cm / 100, d_cm / 200
    top = _quad([(-x, y, -z), (x, y, -z), (x, y, z), (-x, y, z)], (0, 1, 0), [(0, 0), (1, 0), (1, 1), (0, 1)])
    sides = [
        _quad([(-x, 0, z), (x, 0, z), (x, y, z), (-x, y, z)], (0, 0, 1)),
        _quad([(x, 0, -z), (-x, 0, -z), (-x, y, -z), (x, y, -z)], (0, 0, -1)),
        _quad([(x, 0, z), (x, 0, -z), (x, y, -z), (x, y, z)], (1, 0, 0)),
        _quad([(-x, 0, -z), (-x, 0, z), (-x, y, z), (-x, y, -z)], (-1, 0, 0)),
        _quad([(-x, 0, -z), (x, 0, -z), (x, 0, z), (-x, 0, z)], (0, -1, 0)),
    ]

    blob = bytearray()
    views, accessors = [], []

    def add(data: bytes, target=None) -> int:
        while len(blob) % 4:
            blob.append(0)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data), **({"target": target} if target else {})})
        blob.extend(data)
        return len(views) - 1

    def accessor(arr: np.ndarray, kind: str, target: int, minmax=False) -> int:
        a = np.ascontiguousarray(arr)
        comp = 5125 if a.dtype == np.uint32 else 5126
        acc = {"bufferView": add(a.tobytes(), target), "componentType": comp, "count": int(a.shape[0]), "type": kind}
        if minmax:
            acc["min"] = [float(v) for v in a.min(axis=0)]
            acc["max"] = [float(v) for v in a.max(axis=0)]
        accessors.append(acc)
        return len(accessors) - 1

    def primitive(quads, material: int, textured: bool) -> dict:
        pos = np.concatenate([q[0] for q in quads])
        nor = np.concatenate([q[1] for q in quads])
        idx = np.concatenate([np.asarray(q[3], np.uint32) + 4 * i for i, q in enumerate(quads)])
        attrs = {"POSITION": accessor(pos, "VEC3", 34962, True), "NORMAL": accessor(nor, "VEC3", 34962)}
        if textured:
            attrs["TEXCOORD_0"] = accessor(np.concatenate([q[2] for q in quads]), "VEC2", 34962)
        return {"attributes": attrs, "indices": accessor(idx, "SCALAR", 34963), "material": material}

    prims = [primitive([top], 0, True), primitive(sides, 1, False)]
    image_view = add(jpeg)
    doc = {
        "asset": {"version": "2.0", "generator": "midstudy-add rug"},
        "extensionsUsed": ["KHR_materials_unlit"],
        "scene": 0,
        "scenes": [{"nodes": [0]}],
        "nodes": [{"name": "rug", "mesh": 0}],
        "meshes": [{"name": "rug", "primitives": prims}],
        "materials": [
            # Unlit: the picture is already lit (a shop's photo); the planner's lights would wash it out from above.
            {"name": "rug-top", "pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0.0,
                                                         "roughnessFactor": 1.0},
             "extensions": {"KHR_materials_unlit": {}}},
            {"name": "rug-edge", "pbrMetallicRoughness": {"baseColorFactor": edge_colour(tex), "metallicFactor": 0.0,
                                                          "roughnessFactor": 1.0}},
        ],
        "textures": [{"source": 0, "sampler": 0}],
        "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 33071, "wrapT": 33071}],
        "images": [{"bufferView": image_view, "mimeType": "image/jpeg"}],
        "accessors": accessors,
        "bufferViews": views,
        "buffers": [{"byteLength": len(blob)}],
    }
    while len(blob) % 4:
        blob.append(0)
    doc["buffers"][0]["byteLength"] = len(blob)
    write_glb(out, doc, bytes(blob))
    return notes


def foreground_mask(image: Path, out: Path) -> str:
    """A mask of the piece for SAM 3D (white = the piece, same size as the picture), for when its text detector finds
    nothing: everything except the picture's plain margin (and the margin colour that connects to it), or the whole
    picture when it has no plain margin. Returns what the mask covers, for the log."""
    from PIL import Image, ImageDraw, ImageFilter, ImageOps

    with Image.open(image) as src:
        im = ImageOps.exif_transpose(src).convert("RGB")
    rgb = np.asarray(im, dtype=np.int16)
    h, w, _ = rgb.shape
    b = max(2, min(h, w) // 100)
    border = np.concatenate([rgb[:b].reshape(-1, 3), rgb[-b:].reshape(-1, 3),
                             rgb[:, :b].reshape(-1, 3), rgb[:, -b:].reshape(-1, 3)])
    whole = Image.new("L", (w, h), 255)
    if border.std(axis=0).max() > MARGIN_STD:
        whole.save(out)
        return "the whole picture (it has no plain margin)"
    fg = np.abs(rgb - np.median(border, axis=0)).max(axis=2) > MARGIN_DIFF
    # Margin-coloured pixels count as background only when they connect to the margin: a white drawer front stays.
    pad = Image.fromarray(np.pad(np.where(fg, 255, 0).astype(np.uint8), 1)).copy()  # copy: fromarray may share (read-only) memory
    ImageDraw.floodfill(pad, (0, 0), 128)
    mask = (np.asarray(pad)[1:-1, 1:-1] != 128)
    share = mask.mean()
    if share < 0.01:
        whole.save(out)
        return "the whole picture (no piece stood out from the margin)"
    Image.fromarray(np.where(mask, 255, 0).astype(np.uint8), "L").filter(ImageFilter.MaxFilter(5)).save(out)
    return f"the piece ({share:.0%} of the picture, the plain margin left out)"
