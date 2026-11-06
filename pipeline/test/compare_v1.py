"""v1 against v2 midstudy-add on the same inputs, fal mocked ($0): the lines, exit codes, library entries, cost rows,
the fal requests (MIDSTUDY_FAL_MOCK_LOG: endpoint, arguments, the uploaded image's bytes) and every file each item
holds. A file is "identical" when its bytes are; model.glb, splat.ply and splat.spz, which v2 writes with other tools
(glTF-Transform's writer; its own eigensolver), are compared by what they hold, against the contract's tolerances.

    nix develop -c uv run --project pipeline python pipeline/test/compare_v1.py [--only CASE,...] [--keep]

Writes evals/out/pipeline-compare/ (report.json, report.txt, both libraries, the logs) and exits 1 when a difference
is not one of the expected kinds (listed in docs/notes/pipeline.md).
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image, ImageCms, ImageDraw
from PIL.PngImagePlugin import PngInfo

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "evals/out/pipeline-compare"
IN = OUT / "inputs"
SAM_PHOTO = ROOT / "fixtures/fal/sam-3-3d-objects/input.jpg"
IDOL_PHOTO = ROOT / "fixtures/fal/speridlabs-idol/input.jpg"
TRELLIS_PHOTO = ROOT / "fixtures/fal/trellis-2/input.jpg"


# --- inputs ------------------------------------------------------------------------------------------------------------

def make_inputs() -> None:
    IN.mkdir(parents=True, exist_ok=True)
    meta = ["evals/py", "evals/lib/metadata.py", "make"]
    for kind, extra in [("gps-jpeg", ["--from", str(SAM_PHOTO), "--orientation", "6"]), ("trailing-gps", []),
                        ("prog-midscan-gps", []), ("zero-pad", []), ("gps-png", []), ("jfxx-gps", []), ("gps-glb", []),
                        ("big12mp", [])]:
        ext = ".glb" if kind == "gps-glb" else ".png" if kind == "gps-png" else ".jpg"
        subprocess.run([*meta, "--kind", kind, "--out", str(IN / f"{kind}{ext}"), *extra], cwd=ROOT, check=True,
                       capture_output=True)
    photo = Image.open(SAM_PHOTO).convert("RGB")
    small = photo.resize((480, 360), Image.Resampling.BILINEAR)
    for o in range(2, 9):  # every EXIF orientation
        ex = Image.Exif()
        ex[0x0112] = o
        small.save(IN / f"orient-{o}.jpg", quality=90, exif=ex.tobytes())
    srgb = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
    small.save(IN / "icc-xmp-com.jpg", quality=85, icc_profile=srgb, comment=b"a comment",
               xmp=b"<x:xmpmeta xmlns:x='adobe:ns:meta/'>secret</x:xmpmeta>")
    small.convert("L").save(IN / "gray.jpg", quality=90)
    small.convert("CMYK").save(IN / "cmyk.jpg", quality=90)
    small.save(IN / "photo.webp", quality=90)
    small.save(IN / "subsample-444.jpg", quality=95, subsampling=0)
    rgba = small.convert("RGBA")
    a = Image.new("L", rgba.size, 0)
    ImageDraw.Draw(a).ellipse((40, 30, 440, 330), fill=255)
    rgba.putalpha(a)
    info = PngInfo()
    info.add_text("Comment", "TestCam GPS")
    rgba.save(IN / "alpha.png", pnginfo=info, icc_profile=srgb)
    pal = small.convert("P", palette=Image.Palette.ADAPTIVE, colors=64)
    pal.info["transparency"] = 0
    pal.save(IN / "palette.png", transparency=0)
    g16 = Image.fromarray((np.linspace(0, 65535, 480 * 360).reshape(360, 480)).astype(np.uint16))
    g16.save(IN / "gray16.png")
    wide = photo.resize((5200, 2600), Image.Resampling.BILINEAR)
    wide.save(IN / "wide-5200.jpg", quality=88)
    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
        small.save(IN / "photo.heic", quality=90)
    except Exception as e:  # noqa: BLE001
        print(f"note: no HEIC input ({type(e).__name__}: {e})")
    # a rug pictured from above on a plain margin (300 x 500 px of pattern on 800 x 800 white), and a plain picture
    rug = Image.new("RGB", (800, 800), (250, 250, 250))
    d = ImageDraw.Draw(rug)
    d.rectangle((250, 150, 549, 649), fill=(150, 40, 40))
    for k in range(0, 300, 20):
        d.line((250 + k, 150, 549 - k, 649), fill=(230, 200, 90), width=4)
    rug.save(IN / "rug.jpg", quality=92)
    Image.new("RGB", (400, 300), (90, 120, 200)).save(IN / "plain.jpg", quality=92)
    # a .gltf with its buffer beside it, from arrow.glb
    data = (ROOT / "fixtures/models/arrow.glb").read_bytes()
    n = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + n])
    m = struct.unpack_from("<I", data, 20 + n)[0]
    blob = data[28 + n:28 + n + m]
    doc["buffers"][0]["uri"] = "arrow%20data.bin"
    (IN / "arrow data.bin").write_bytes(blob[:doc["buffers"][0]["byteLength"]])
    (IN / "arrow.gltf").write_text(json.dumps(doc))
    shutil.copy2(ROOT / "fixtures/models/SheenChair.glb", IN / "SheenChair.glb")
    (IN / "bad.zip").write_bytes(b"not a zip at all")
    import zipfile

    with zipfile.ZipFile(IN / "noobj.zip", "w") as z:
        z.writestr("readme.txt", "no model here")


# --- cases -------------------------------------------------------------------------------------------------------------

def cases() -> list[tuple[str, list[str], dict]]:
    i = lambda name: str((IN / name).relative_to(ROOT))  # noqa: E731
    c: list[tuple[str, list[str], dict]] = [
        ("idol", [str(IDOL_PHOTO.relative_to(ROOT)), "--name", "Idol Chair", "--id", "idol-chair", "--dims", "80x90x95"], {}),
        ("idol-yaw", [str(IDOL_PHOTO.relative_to(ROOT)), "--name", "Idol Yaw", "--id", "idol-yaw", "--dims", "80 x 90 x 95.5", "--yaw", "90", "--category", "chair", "--notes", "ü note", "--mount", "floor"], {}),
        ("idol-replace", [str(IDOL_PHOTO.relative_to(ROOT)), "--name", "Idol Chair", "--id", "idol-chair", "--dims", "81x90x95"], {}),
        ("idol-paid-mock", [str(IDOL_PHOTO.relative_to(ROOT)), "--name", "Paid", "--id", "paid", "--dims", "60x60x80"], {"MIDSTUDY_FAL_MOCK_COST": "1"}),
        ("sam3d", [str(SAM_PHOTO.relative_to(ROOT)), "--engine", "sam3d", "--prompt", "chair", "--name", "Mock SAM Chair", "--id", "mock-sam", "--dims", "75x80x95"], {}),
        ("sam3d-retry-threshold", [str(SAM_PHOTO.relative_to(ROOT)), "--engine", "sam3d", "--name", "Retry One", "--category", "armchair", "--dims", "75x80x95"], {"MIDSTUDY_FAL_MOCK_NO_MASKS": "1"}),
        ("sam3d-retry-mask", [i("rug.jpg"), "--engine", "sam3d", "--name", "Retry Two", "--dims", "75x80x95"], {"MIDSTUDY_FAL_MOCK_NO_MASKS": "2"}),
        ("sam3d-retry-mask-whole", [i("photo.webp"), "--engine", "sam3d", "--name", "Retry Whole", "--dims", "75x80x95"], {"MIDSTUDY_FAL_MOCK_NO_MASKS": "2"}),
        ("sam3d-no-masks", [str(SAM_PHOTO.relative_to(ROOT)), "--engine", "sam3d", "--name", "Never", "--dims", "75x80x95"], {"MIDSTUDY_FAL_MOCK_NO_MASKS": "3"}),
        ("trellis2", [str(TRELLIS_PHOTO.relative_to(ROOT)), "--engine", "trellis2", "--resolution", "1024", "--name", "Trellis Thing", "--dims", "60x60x80", "--yaw", "180"], {}),
        ("glb-sheen", [i("SheenChair.glb"), "--engine", "glb", "--name", "Sheen Chair", "--dims", "60x65x85", "--category", "chair", "--source-input", "Sheen Chair.glb"], {}),
        ("glb-arrow-yaw", ["fixtures/models/arrow.glb", "--engine", "glb", "--name", "Arrow", "--dims", "40x40x10", "--yaw", "270", "--mount", "wall"], {}),
        ("gltf-side-file", [i("arrow.gltf"), "--engine", "glb", "--name", "Arrow Gltf", "--dims", "40x40x10"], {}),
        ("obj-zip", ["fixtures/models/cube-obj.zip", "--engine", "glb", "--name", "Cube", "--dims", "50x50x50"], {}),
        ("gps-glb", [i("gps-glb.glb"), "--engine", "glb", "--name", "GPS Texture", "--dims", "50x50x50"], {}),
        ("rug", [i("rug.jpg"), "--engine", "rug", "--name", "Flat Rug", "--dims", "160x230x1", "--category", "rug"], {}),
        ("rug-wide-thick", [i("rug.jpg"), "--engine", "rug", "--name", "Wide Rug", "--dims", "230x160x12"], {}),
        ("rug-stretched", [i("rug.jpg"), "--engine", "rug", "--name", "Square Rug", "--dims", "200x200x1"], {}),
        ("rug-plain", [i("plain.jpg"), "--engine", "rug", "--name", "Plain Rug", "--dims", "160x230x1"], {}),
    ]
    for name, f in [("gps-jpeg", "gps-jpeg.jpg"), ("trailing-gps", "trailing-gps.jpg"), ("prog-midscan-gps", "prog-midscan-gps.jpg"),
                    ("zero-pad", "zero-pad.jpg"), ("gps-png", "gps-png.png"), ("jfxx-gps", "jfxx-gps.jpg"),
                    ("big12mp", "big12mp.jpg"), ("wide-5200", "wide-5200.jpg"), ("icc-xmp-com", "icc-xmp-com.jpg"),
                    ("gray", "gray.jpg"), ("cmyk", "cmyk.jpg"), ("webp", "photo.webp"), ("subsample-444", "subsample-444.jpg"),
                    ("alpha-png", "alpha.png"), ("palette-png", "palette.png"), ("gray16-png", "gray16.png"),
                    ("heic", "photo.heic")] + [(f"orient-{o}", f"orient-{o}.jpg") for o in range(2, 9)]:
        if (IN / f).exists():
            c.append((f"photo-{name}", [i(f), "--engine", "trellis2", "--name", f"Photo {name}", "--dims", "50x60x70"], {}))
    c += [
        ("rescale-idol", ["--rescale", "idol-chair", "--dims", "70x85x100", "--yaw", "90"], {}),
        ("rescale-sam", ["--rescale", "mock-sam", "--yaw", "180"], {}),
        ("rescale-glb", ["--rescale", "sheen-chair", "--dims", "55x60x80"], {}),
        ("rescale-rug", ["--rescale", "flat-rug", "--yaw", "90"], {}),
    ]
    errors = [
        ("err-no-args", []),
        ("err-no-name", [str(SAM_PHOTO.relative_to(ROOT)), "--dims", "1x1x1"]),
        ("err-no-dims", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x"]),
        ("err-bad-dims", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "75x80"]),
        ("err-zero-dims", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "0x80x90"]),
        ("err-blank-name", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "  ", "--dims", "1x1x1"]),
        ("err-bad-id", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "1x1x1", "--id", "Bad_Id"]),
        ("err-no-slug", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "!!!", "--dims", "1x1x1"]),
        ("err-missing", ["nope/photo.jpg", "--name", "x", "--dims", "1x1x1"]),
        ("err-usdz", ["chair.USDZ", "--name", "x", "--dims", "1x1x1", "--engine", "glb"]),
        ("err-glb-photo", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "1x1x1", "--engine", "glb"]),
        ("err-photo-model", ["fixtures/models/arrow.glb", "--name", "x", "--dims", "1x1x1", "--engine", "sam3d"]),
        ("err-not-image", ["pipeline/pyproject.toml", "--name", "x", "--dims", "1x1x1"]),
        ("err-url-mock", ["https://example.com/chair.jpg", "--name", "x", "--dims", "1x1x1"]),
        ("err-yaw", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "1x1x1", "--yaw", "45"]),
        ("err-resolution", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "1x1x1", "--resolution", "2048"]),
        ("err-engine", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "1x1x1", "--engine", "meshy"]),
        ("err-unknown-flag", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "1x1x1", "--frobnicate"]),
        ("err-ambiguous", [str(SAM_PHOTO.relative_to(ROOT)), "--n", "x", "--dims", "1x1x1"]),
        ("err-two-inputs", [str(SAM_PHOTO.relative_to(ROOT)), "other.jpg", "--name", "x", "--dims", "1x1x1"]),
        ("err-rug-model", ["fixtures/models/arrow.glb", "--engine", "rug", "--name", "x", "--dims", "1x1x1"]),
        ("err-rug-plain", ["evals/out/pipeline-compare/inputs/plain.jpg", "--engine", "rug", "--name", "y", "--dims", "100x100x1"]),
        ("err-rescale-missing", ["--rescale", "nope"]),
        ("err-rescale-bad-id", ["--rescale", "Nope!"]),
        ("err-rescale-input", ["--rescale", "idol-chair", str(SAM_PHOTO.relative_to(ROOT))]),
        ("err-zip-bad", ["evals/out/pipeline-compare/inputs/bad.zip", "--engine", "glb", "--name", "x", "--dims", "1x1x1"]),
        ("err-zip-no-obj", ["evals/out/pipeline-compare/inputs/noobj.zip", "--engine", "glb", "--name", "x", "--dims", "1x1x1"]),
        ("err-library-file", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "1x1x1", "--library", "pipeline/pyproject.toml"]),
        ("err-mock-not-dir", [str(SAM_PHOTO.relative_to(ROOT)), "--name", "x", "--dims", "1x1x1"]),
    ]
    for name, args in errors:
        env = {"MIDSTUDY_FAL_MOCK": "no/such/dir"} if name == "err-mock-not-dir" else {}
        c.append((name, args, env))
    c.append(("help", ["--help"], {}))
    return c


# --- running -----------------------------------------------------------------------------------------------------------

def run(kind: str, case: str, args: list[str], extra: dict) -> dict:
    lib = OUT / f"lib-{kind}"
    log = OUT / "logs" / f"{case}-{kind}.jsonl"
    env = {k: v for k, v in os.environ.items() if k != "FAL_KEY"}
    env.update(MIDSTUDY_NO_DOTENV="1", NOOK_NO_DOTENV="1", MIDSTUDY_FAL_MOCK="fixtures/fal", MIDSTUDY_FAL_MOCK_LOG=str(log))
    env.update(extra)
    if kind == "v2":
        env["MIDSTUDY_STRICT"] = "1"
        cmd = ["node", "pipeline/src/cli.ts"]
    else:
        cmd = ["uv", "run", "-q", "--offline", "--project", "pipeline", "python", "pipeline/test/v1_mock_log.py"]
    full = cmd + list(args)
    if "--library" not in args:
        full += ["--library", str(lib.relative_to(ROOT))]
    t = time.perf_counter()
    p = subprocess.run(full, cwd=ROOT, env=env, capture_output=True, text=True)
    secs = time.perf_counter() - t
    norm = lambda s: re.sub(r"(/private)?/var/folders/\S*?/midstudy-(add|rescale)-[^/\s]*", "<staging>", s.replace(f"lib-{kind}", "lib-X"))  # noqa: E731
    return {"code": p.returncode, "stdout": norm(p.stdout), "stderr": norm(p.stderr), "secs": secs,
            "log": log.read_text() if log.exists() else ""}


# --- file comparisons ------------------------------------------------------------------------------------------------

def glb_parts(data: bytes) -> tuple[dict, bytes]:
    n = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + n])
    off = 20 + n
    blob = b""
    if off + 8 <= len(data):
        m = struct.unpack_from("<I", data, off)[0]
        blob = data[off + 8:off + 8 + m]
    return doc, blob


_CT = {5120: np.int8, 5121: np.uint8, 5122: np.int16, 5123: np.uint16, 5125: np.uint32, 5126: np.float32}
_NC = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4, "MAT2": 4, "MAT3": 9, "MAT4": 16}


def accessor(doc: dict, blob: bytes, i: int) -> np.ndarray:
    a = doc["accessors"][i]
    dt = np.dtype(_CT[a["componentType"]])
    nc = _NC[a["type"]]
    out = np.zeros((a["count"], nc), dt)
    if "bufferView" in a:
        v = doc["bufferViews"][a["bufferView"]]
        stride = v.get("byteStride") or dt.itemsize * nc
        base = v.get("byteOffset", 0) + a.get("byteOffset", 0)
        raw = np.frombuffer(blob, np.uint8, count=stride * (a["count"] - 1) + dt.itemsize * nc, offset=base) if a["count"] else np.zeros(0, np.uint8)
        for k in range(a["count"]):
            out[k] = np.frombuffer(raw[k * stride:k * stride + dt.itemsize * nc].tobytes(), dt)
    return out


def local_matrix(node: dict) -> np.ndarray:
    if "matrix" in node:
        return np.array(node["matrix"], float).reshape(4, 4).T
    t = np.array(node.get("translation", [0, 0, 0]), float)
    x, y, z, w = node.get("rotation", [0, 0, 0, 1])
    r = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
                  [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
                  [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)]])
    s = np.array(node.get("scale", [1, 1, 1]), float)
    m = np.eye(4)
    m[:3, :3] = r * s
    m[:3, 3] = t
    return m


def image_bytes(doc: dict, blob: bytes, i: int) -> bytes:
    im = doc["images"][i]
    if "bufferView" in im:
        v = doc["bufferViews"][im["bufferView"]]
        return blob[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]
    return im.get("uri", "").encode()


_MAT_DEFAULTS = {"alphaMode": "OPAQUE", "doubleSided": False, "emissiveFactor": [0.0, 0.0, 0.0]}
_PBR_DEFAULTS = {"baseColorFactor": [1.0, 1.0, 1.0, 1.0], "metallicFactor": 1.0, "roughnessFactor": 1.0}
_SAMPLER_DEFAULTS = {"wrapS": 10497, "wrapT": 10497}


def _num(o):
    """Numbers as floats (0 and 0.0 are one value in glTF)."""
    if isinstance(o, bool) or o is None or isinstance(o, str):
        return o
    if isinstance(o, (int, float)):
        return float(o)
    if isinstance(o, list):
        return [_num(v) for v in o]
    return {k: _num(v) for k, v in o.items()}


def _drop_defaults(o: dict, defaults: dict) -> dict:
    return {k: v for k, v in o.items() if not (k in defaults and _num(v) == _num(defaults[k]))}


def texture_source(tex: dict):
    if "source" in tex:
        return tex["source"]
    for ext in tex.get("extensions", {}).values():
        if isinstance(ext, dict) and "source" in ext:
            return ext["source"]
    return None


def material_sig(doc: dict, blob: bytes, i: int | None) -> str:
    """The material as glTF defines it: default values dropped (glTF-Transform writes only what differs from the
    spec's defaults; v1 kept the source's JSON), numbers as floats, each texture as its image's hash and sampler."""
    if i is None:
        return "none"
    m = json.loads(json.dumps(doc["materials"][i]))
    m = _drop_defaults(m, _MAT_DEFAULTS)
    if m.get("alphaMode") != "MASK":
        m.pop("alphaCutoff", None)
    elif _num(m.get("alphaCutoff", 0.5)) == 0.5:
        m.pop("alphaCutoff", None)
    if "pbrMetallicRoughness" in m:
        m["pbrMetallicRoughness"] = _drop_defaults(m["pbrMetallicRoughness"], _PBR_DEFAULTS)
        if not m["pbrMetallicRoughness"]:
            del m["pbrMetallicRoughness"]

    def fix(o, key=""):
        if isinstance(o, dict):
            if "index" in o and isinstance(o["index"], int):
                tex = doc["textures"][o["index"]]
                src = texture_source(tex)
                sampler = doc.get("samplers", [])[tex["sampler"]] if "sampler" in tex else {}
                o = dict(o, index=hashlib.sha256(image_bytes(doc, blob, src)).hexdigest()[:16] if src is not None else None,
                         sampler=_drop_defaults(sampler, _SAMPLER_DEFAULTS))
                o = _drop_defaults(o, {"texCoord": 0, "scale": 1.0 if key == "normalTexture" else None,
                                       "strength": 1.0 if key == "occlusionTexture" else None})
            return {k: fix(v, k) for k, v in sorted(o.items())}
        if isinstance(o, list):
            return [fix(v) for v in o]
        return _num(o)
    return json.dumps(fix(m), sort_keys=True)


def walk(doc: dict, blob: bytes) -> list[dict]:
    """Every drawn primitive: its node path, world matrix, mode, attribute and index arrays, material."""
    out = []
    scene = doc["scenes"][doc.get("scene", 0)]

    def visit(i: int, parent: np.ndarray, path: str):
        node = doc["nodes"][i]
        world = parent @ local_matrix(node)
        p = f"{path}/{node.get('name', '')}"
        if "mesh" in node:
            for k, prim in enumerate(doc["meshes"][node["mesh"]]["primitives"]):
                out.append({"path": f"{p}#{k}", "world": world, "mode": prim.get("mode", 4),
                            "attrs": {a: accessor(doc, blob, j) for a, j in sorted(prim["attributes"].items())},
                            "indices": accessor(doc, blob, prim["indices"]) if "indices" in prim else None,
                            "material": material_sig(doc, blob, prim.get("material"))})
        for c in node.get("children", []):
            visit(c, world, p)
    for r in scene.get("nodes", []):
        visit(r, np.eye(4), "")
    return out


def glb_diff(a: bytes, b: bytes) -> tuple[bool, str]:
    da, ba = glb_parts(a)
    db, bb = glb_parts(b)
    notes = []
    pa, pb = walk(da, ba), walk(db, bb)
    if [p["path"] for p in pa] != [p["path"] for p in pb]:
        return False, f"different node paths: {[p['path'] for p in pa][:5]} vs {[p['path'] for p in pb][:5]}"
    worst = 0.0
    for x, y in zip(pa, pb):
        worst = max(worst, float(np.max(np.abs(x["world"] - y["world"]))))
        if x["mode"] != y["mode"] or list(x["attrs"]) != list(y["attrs"]):
            return False, f"{x['path']}: mode/attributes differ ({x['mode']} {list(x['attrs'])} vs {y['mode']} {list(y['attrs'])})"
        for k in x["attrs"]:
            if x["attrs"][k].dtype != y["attrs"][k].dtype or not np.array_equal(x["attrs"][k], y["attrs"][k]):
                return False, f"{x['path']}: {k} differs"
        xi, yi = x["indices"], y["indices"]
        if (xi is None) != (yi is None) or (xi is not None and not np.array_equal(xi.astype(np.int64), yi.astype(np.int64))):
            return False, f"{x['path']}: indices differ"
        if xi is not None and xi.dtype != yi.dtype:
            notes.append(f"index type {xi.dtype} vs {yi.dtype}")
        if x["material"] != y["material"]:
            return False, f"{x['path']}: material differs: {x['material'][:300]} vs {y['material'][:300]}"
    ia = sorted(hashlib.sha256(image_bytes(da, ba, i)).hexdigest() for i in range(len(da.get("images", []))))
    ib = sorted(hashlib.sha256(image_bytes(db, bb, i)).hexdigest() for i in range(len(db.get("images", []))))
    if ia != ib:
        return False, f"images differ ({len(ia)} vs {len(ib)})"
    if set(da.get("extensionsUsed", [])) != set(db.get("extensionsUsed", [])):
        return False, f"extensionsUsed {da.get('extensionsUsed')} vs {db.get('extensionsUsed')}"
    if da.get("asset") != db.get("asset"):
        notes.append(f"asset {da.get('asset')} vs {db.get('asset')}")
    # v1 measured with trimesh, whose scene graph makes a world transform within 1e-5 of rigid exactly rigid
    # (fix_rigid): a rescale of a model.glb whose item frame is scaled by 1 ± 2e-8 (a rug) measured it without that
    # scale, and its new frame differs from v2's (exact) by as much: allow 1e-6 (a micrometre per metre)
    ok = worst <= 1e-6
    notes.insert(0, f"{len(pa)} primitives, vertex/index data, materials, {len(ia)} images identical; world matrices max |diff| {worst:.3g}")
    return ok, "; ".join(notes)


def ply_read(data: bytes) -> np.ndarray:
    end = data.index(b"end_header\n") + 11
    props = [l.split() for l in data[:end].decode().split("\n") if l.startswith("property")]
    return np.frombuffer(data, dtype=[(p[2], "<f4" if p[1] == "float" else "<f8") for p in props], offset=end), data[:end]


def quat_mat(q: np.ndarray) -> np.ndarray:
    q = q / np.linalg.norm(q, axis=1, keepdims=True)
    w, x, y, z = q.T
    return np.stack([np.stack([1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)], -1),
                     np.stack([2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)], -1),
                     np.stack([2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)], -1)], 1)


def covariance(rot: np.ndarray, scale: np.ndarray) -> np.ndarray:
    r = quat_mat(rot.astype(float))
    s2 = np.exp(2 * scale.astype(float))
    return np.einsum("nij,nj,nkj->nik", r, s2, r)


def ply_diff(a: bytes, b: bytes) -> tuple[bool, str]:
    da, ha = ply_read(a)
    db, hb = ply_read(b)
    if ha != hb or len(da) != len(db):
        return False, f"headers/counts differ ({len(da)} vs {len(db)})"
    notes, ok = [], True
    names = da.dtype.names
    same = [n for n in names if np.array_equal(da[n], db[n])]
    notes.append(f"{len(da):,} splats; bit-identical fields: {', '.join(same) or 'none'}")
    xyz = lambda d: np.stack([d["x"], d["y"], d["z"]], 1).astype(float)  # noqa: E731
    dp = float(np.max(np.abs(xyz(da) - xyz(db))))
    notes.append(f"positions max |diff| {dp:.3g} m")
    ok &= dp <= 1e-6
    for n in ("f_dc_0", "f_dc_1", "f_dc_2", "opacity"):
        if n in names and not np.array_equal(da[n], db[n]):
            ok = False
            notes.append(f"{n} differs")
    if "scale_0" in names and "rot_0" in names:
        sa = np.stack([da[f"scale_{k}"] for k in range(3)], 1)
        sb = np.stack([db[f"scale_{k}"] for k in range(3)], 1)
        ra = np.stack([da[f"rot_{k}"] for k in range(4)], 1)
        rb = np.stack([db[f"rot_{k}"] for k in range(4)], 1)
        ca, cb = covariance(ra, sa), covariance(rb, sb)
        rel = np.linalg.norm(ca - cb, axis=(1, 2)) / np.maximum(np.linalg.norm(ca, axis=(1, 2)), 1e-30)
        sorted_a, sorted_b = np.sort(sa, 1), np.sort(sb, 1)
        ds = float(np.max(np.abs(sorted_a - sorted_b)))
        notes.append(f"Gaussians (covariance) max relative diff {float(np.max(rel)):.3g} (p99 {float(np.percentile(rel, 99)):.3g}); "
                     f"log-scales as a set max |diff| {ds:.3g}; quaternions equal up to sign/axis order for "
                     f"{float(np.mean(np.min([np.abs(ra - rb).max(1), np.abs(ra + rb).max(1)], 0) < 1e-6)):.1%}")
        ok &= float(np.max(rel)) <= 1e-4
    return ok, "; ".join(notes)


def spz_read(data: bytes) -> dict:
    u = gzip.decompress(data)
    magic, version, n, sh, frac, flags, _ = struct.unpack_from("<IIIBBBB", u, 0)
    o = 16
    pos = np.frombuffer(u, np.uint8, n * 9, o).reshape(n, 3, 3).astype(np.int32)
    o += n * 9
    alpha = np.frombuffer(u, np.uint8, n, o)
    o += n
    col = np.frombuffer(u, np.uint8, n * 3, o).reshape(n, 3)
    o += n * 3
    sc = np.frombuffer(u, np.uint8, n * 3, o).reshape(n, 3)
    o += n * 3
    rot = np.frombuffer(u, np.uint8, n * 3, o).reshape(n, 3)
    q = pos[..., 0] | (pos[..., 1] << 8) | (pos[..., 2] << 16)
    q = np.where(q >= 1 << 23, q - (1 << 24), q)
    xyz_ = rot.astype(float) / 127.5 - 1
    w = np.sqrt(np.maximum(0, 1 - (xyz_ ** 2).sum(1)))
    return {"head": (magic, version, n, sh, frac, flags), "pos": q, "alpha": alpha, "col": col, "scale": sc,
            "quat": np.concatenate([w[:, None], xyz_], 1), "raw": u, "gz": data[:10]}


def spz_diff(a: bytes, b: bytes, ply_a: Path, ply_b: Path) -> tuple[bool, str]:
    """Header, positions, opacities, colours and scales must agree; the 8-bit quaternions encode each Gaussian's own
    rotation, which v1 and v2 pick differently among the equivalent ones (eigenvector signs), so each splat.spz is
    held against its own splat.ply instead: v2's quantization error must be no worse than v1's."""
    x, y = spz_read(a), spz_read(b)
    if x["head"] != y["head"]:
        return False, f"headers differ {x['head']} vs {y['head']}"
    n = x["head"][2]
    notes = [f"{n:,} splats, header identical, gzip header {'identical' if x['gz'] == y['gz'] else 'different'}"]
    ok = True
    for k in ("pos", "alpha", "col"):
        if np.array_equal(x[k], y[k]):
            notes.append(f"{k} identical")
        else:
            d = int(np.max(np.abs(x[k].astype(int) - y[k].astype(int))))
            share = float(np.mean(np.any((x[k] != y[k]).reshape(len(x[k]), -1), 1)))
            notes.append(f"{k} differs by ≤ {d} unit(s) in {share:.2%} of splats")
            ok &= d <= 1
    same_scale = np.array_equal(x["scale"], y["scale"])
    notes.append("scales identical" if same_scale else "scales differ")
    ok &= same_scale
    pa, _ = ply_read(ply_a.read_bytes())
    pb, _ = ply_read(ply_b.read_bytes())
    if len(pa) == n and len(pb) == n:
        errs = []
        for spz, ply in ((x, pa), (y, pb)):
            truth = covariance(np.stack([ply[f"rot_{k}"] for k in range(4)], 1), np.stack([ply[f"scale_{k}"] for k in range(3)], 1))
            sq = covariance(spz["quat"], spz["scale"].astype(float) / 16 - 10)
            sp = covariance(np.stack([ply[f"rot_{k}"] for k in range(4)], 1), spz["scale"].astype(float) / 16 - 10)
            # the rotation's share of the error: the quantized rotation against the exact one, at the stored scales
            errs.append(np.linalg.norm(sq - sp, axis=(1, 2)) / np.maximum(np.linalg.norm(sp, axis=(1, 2)), 1e-30))
            del truth
        e1, e2 = errs
        notes.append(f"8-bit rotation error vs its own splat.ply: v1 p50 {np.median(e1):.3g} p99 {np.percentile(e1, 99):.3g} "
                     f"max {e1.max():.3g}; v2 p50 {np.median(e2):.3g} p99 {np.percentile(e2, 99):.3g} max {e2.max():.3g}")
        ok &= float(np.percentile(e2, 99)) <= float(np.percentile(e1, 99)) * 1.25 + 1e-3
    else:
        notes.append("(cap applied: no index-aligned check against splat.ply)")
    notes.append(f"{len(a):,} vs {len(b):,} bytes")
    return ok, "; ".join(notes)


def png_diff(a: bytes, b: bytes) -> tuple[bool, str]:
    import io

    with Image.open(io.BytesIO(a)) as x, Image.open(io.BytesIO(b)) as y:
        same = x.size == y.size and x.mode == y.mode and x.tobytes() == y.tobytes()
        icc = x.info.get("icc_profile") == y.info.get("icc_profile")
        keys = sorted(x.info) == sorted(y.info)
    return same and icc and keys, (f"{x.size} {x.mode}: pixels {'identical' if same else 'DIFFER'}, ICC {'identical' if icc else 'DIFFERS'}, "
                                   f"info keys {'identical' if keys else 'DIFFER'}; the deflate stream differs ({len(a):,} vs {len(b):,} bytes)")


def pixel_diff(a: bytes, b: bytes) -> tuple[int, float, str]:
    import io

    with Image.open(io.BytesIO(a)) as x, Image.open(io.BytesIO(b)) as y:
        if x.size != y.size:
            return 999, 1.0, f"sizes {x.size} vs {y.size}"
        d = np.abs(np.asarray(x.convert("RGB")).astype(int) - np.asarray(y.convert("RGB")).astype(int))
    return int(d.max()), float(d.mean()), f"{x.size}: pixels max |diff| {int(d.max())}, mean {float(d.mean()):.4f}, {float((d.max(2) > 0).mean()):.2%} of pixels"


def obj_diff(a: Path, b: Path) -> tuple[bool, str]:
    import trimesh

    sa = trimesh.load(str(a), force="scene")
    sb = trimesh.load(str(b), force="scene")
    ba, bb = np.asarray(sa.bounds), np.asarray(sb.bounds)
    fa = sum(len(g.faces) for g in sa.geometry.values() if hasattr(g, "faces"))
    fb = sum(len(g.faces) for g in sb.geometry.values() if hasattr(g, "faces"))
    da, _ = glb_parts(a.read_bytes())
    db, _ = glb_parts(b.read_bytes())
    ok = bool(np.allclose(ba, bb, atol=1e-6)) and fa == fb and len(da.get("images", [])) == len(db.get("images", []))
    return ok, (f"bounds {'equal' if np.allclose(ba, bb, atol=1e-6) else 'DIFFER'} (max |diff| {np.abs(ba - bb).max():.2g}), "
                f"triangles {fa} vs {fb}, images {len(da.get('images', []))} vs {len(db.get('images', []))}, "
                f"vertices {sum(len(g.vertices) for g in sa.geometry.values())} vs {sum(len(g.vertices) for g in sb.geometry.values())}")


def compare_file(rel: str, a: Path, b: Path) -> dict:
    """identical, or equivalent with the kind of difference (each kind is in docs/notes/pipeline.md), or DIFFERENT."""
    da, db = a.read_bytes(), b.read_bytes()
    if da == db:
        return {"file": rel, "status": "identical", "bytes": len(da)}
    item = a.parents[1] if a.parent.name == "raw" else a.parent
    heic = (item / "source.heic").exists()
    kind, ok, why = "?", False, f"{len(da)} vs {len(db)} bytes"
    try:
        if a.name == "model.glb" and (item / "source.zip").exists():
            kind = "obj-converter"
            ok, why = obj_diff(a, b)
        elif a.suffix == ".glb":
            kind = "gltf-writer"
            ok, why = glb_diff(da, db)
        elif a.name == "splat.ply":
            kind = "eigenvector-signs"
            ok, why = ply_diff(da, db)
        elif a.name == "splat.spz":
            kind = "eigenvector-signs"
            ok, why = spz_diff(da, db, a.with_name("splat.ply"), b.with_name("splat.ply"))
        elif a.suffix == ".png":
            kind = "png-deflate"
            ok, why = png_diff(da, db)
        elif a.suffix in (".jpg", ".jpeg") and heic:
            kind = "heic-decoder"
            mx, _, why = pixel_diff(da, db)
            ok = mx <= 8
    except Exception as e:  # noqa: BLE001
        ok, why = False, f"comparison failed: {type(e).__name__}: {e}"
    return {"file": rel, "status": "equivalent" if ok else "DIFFERENT", "kind": kind, "detail": why}


def classify_case(case: str, k: str, v1: str, v2: str, lib1: Path, lib2: Path) -> str | None:
    """The expected kind of a stdout or log difference, or None."""
    a, b = v1.splitlines(), v2.splitlines()
    if len(a) != len(b):
        return None
    pairs = [(x, y) for x, y in zip(a, b) if x != y]
    if k == "stdout" and all(x.startswith("midstudy-add: splat.spz: ") and x.split(" splats")[0] == y.split(" splats")[0] for x, y in pairs):
        return "eigenvector-signs (splat.spz's size, to 0.1 MB)"
    if k == "log":
        kinds = set()
        for x, y in pairs:
            rx, ry = json.loads(x), json.loads(y)
            if rx.get("op") != "upload" or ry.get("op") != "upload" or rx["file"] != ry["file"] or rx["url"] != ry["url"]:
                return None
            if rx["file"].endswith(".png"):
                kinds.add("png-deflate (the uploaded PNG's bytes; its pixels are checked where raw/ keeps it)")
            elif case == "photo-heic":
                kinds.add("heic-decoder (the uploaded JPEG of a HEIC photo)")
            else:
                return None
        return ", ".join(sorted(kinds))
    return None


def library_items(lib: Path) -> dict:
    p = lib / "library.json"
    if not p.exists():
        return {}
    items = json.loads(p.read_text())["items"]
    for it in items:
        it.get("source", {}).pop("created", None)
    return {it["id"]: it for it in items}


def tree(d: Path) -> list[str]:
    return sorted(str(p.relative_to(d)) for p in d.rglob("*") if p.is_file())


# --- main --------------------------------------------------------------------------------------------------------------

def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", default="")
    a = ap.parse_args()
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "logs").mkdir(parents=True)
    make_inputs()
    only = set(filter(None, a.only.split(",")))
    report = []
    for case, args, extra in cases():
        if only and case not in only:
            continue
        r1 = run("v1", case, args, extra)
        r2 = run("v2", case, args, extra)
        entry = {"case": case, "args": args, "env": extra, "secs": [round(r1["secs"], 3), round(r2["secs"], 3)], "diffs": []}
        for k in ("code", "stdout", "stderr", "log"):
            if r1[k] != r2[k]:
                kind = None if k in ("code", "stderr") else classify_case(case, k, r1[k], r2[k], OUT / "lib-v1", OUT / "lib-v2")
                entry["diffs"].append({"what": k, "kind": kind or "UNEXPECTED",
                                       "v1": r1[k] if k == "code" else r1[k][-1500:], "v2": r2[k] if k == "code" else r2[k][-1500:]})
        entry["code"] = r1["code"]
        report.append(entry)
        print(f"{case}: exit {r1['code']}/{r2['code']} in {r1['secs']:.2f}/{r2['secs']:.2f} s"
              + "".join(f" — {d['what']}: {d['kind']}" for d in entry["diffs"]), flush=True)
    # the libraries, item by item
    l1, l2 = library_items(OUT / "lib-v1"), library_items(OUT / "lib-v2")
    files = []
    lib_diffs = []
    for item_id in sorted(set(l1) | set(l2)):
        if l1.get(item_id) != l2.get(item_id):
            lib_diffs.append({"id": item_id, "v1": l1.get(item_id), "v2": l2.get(item_id)})
        d1, d2 = OUT / "lib-v1" / item_id, OUT / "lib-v2" / item_id
        t1, t2 = tree(d1) if d1.exists() else [], tree(d2) if d2.exists() else []
        if t1 != t2:
            files.append({"file": item_id, "status": "DIFFERENT", "kind": "files", "detail": f"files {sorted(set(t1) ^ set(t2))}"})
        for rel in sorted(set(t1) & set(t2)):
            files.append(compare_file(f"{item_id}/{rel}", d1 / rel, d2 / rel))
    c1 = (OUT / "lib-v1/costs.csv").read_text().splitlines() if (OUT / "lib-v1/costs.csv").exists() else []
    c2 = (OUT / "lib-v2/costs.csv").read_text().splitlines() if (OUT / "lib-v2/costs.csv").exists() else []
    strip = lambda rows: [re.sub(r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ,", "", r) for r in rows]  # noqa: E731
    costs_same = strip(c1) == strip(c2)
    unexpected_cases = [f"{e['case']}:{d['what']}" for e in report for d in e["diffs"] if d["kind"] == "UNEXPECTED"]
    by_kind: dict = {}
    for f in files:
        if f["status"] == "equivalent":
            by_kind.setdefault(f["kind"], []).append(f["file"])
    for e in report:
        for d in e["diffs"]:
            if d["kind"] != "UNEXPECTED":
                by_kind.setdefault(d["kind"], []).append(f"{e['case']} ({d['what']})")
    summary = {
        "cases": len(report),
        "cases_identical": sum(1 for e in report if not e["diffs"]),
        "unexpected_case_differences": unexpected_cases,
        "library_entries_differ": [d["id"] for d in lib_diffs],
        "costs_rows_identical": costs_same,
        "files": {s: sum(1 for f in files if f["status"] == s) for s in ("identical", "equivalent", "DIFFERENT")},
        "expected_differences": {k: len(v) for k, v in sorted(by_kind.items())},
        "seconds_v1_v2": [round(sum(e["secs"][0] for e in report), 2), round(sum(e["secs"][1] for e in report), 2)],
    }
    (OUT / "report.json").write_text(json.dumps({"summary": summary, "cases": report, "library": lib_diffs, "files": files,
                                                 "by_kind": by_kind}, indent=2, default=str))
    lines = [json.dumps(summary)]
    lines += [f"{f['status']:10} {f['file']} [{f.get('kind')}] — {f.get('detail')}" for f in files if f["status"] == "DIFFERENT"]
    lines += [f"{f['status']:10} {f['file']} [{f.get('kind')}] — {f.get('detail')}" for f in files if f["status"] == "equivalent"]
    lines += [f"identical  {f['file']}" for f in files if f["status"] == "identical"]
    (OUT / "report.txt").write_text("\n".join(lines) + "\n")
    print("\n".join(lines[:60]))
    bad = unexpected_cases or lib_diffs or not costs_same or summary["files"]["DIFFERENT"]
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
