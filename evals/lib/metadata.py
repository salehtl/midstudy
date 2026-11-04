"""Camera metadata in images, for the privacy evals (run through evals/py: Pillow + numpy). Spec: contract §4.3
(photo.jpg has no metadata), §2.8 (furniture photos go to fal without it), §2.6/§4.7 (client JPEGs). Synthetic files
only: the GPS block points at 0°30' N 0°30' E and the camera model is the canary "TestCam GPS", so a leak is found by
looking for that string as well as by walking the file's structure.

    metadata.py make --kind KIND --out F [--from photo.jpg] [--orientation N]
        KIND: gps-jpeg            a JPEG whose EXIF has Make, Model and GPS (and the orientation, if given)
              trailing-gps        a clean JPEG with a GPS-bearing second JPEG after its EOI (as MPF appends one)
              prog-midscan-gps    a progressive JPEG with an APP1 EXIF/GPS segment between its first two scans
              zero-pad            a clean JPEG followed by 64 KB of zeros
              gps-png             a PNG with an eXIf chunk (GPS) and a tEXt comment
              jfxx-gps            a clean JPEG plus a JFXX APP0 extension whose thumbnail is a JPEG with EXIF/GPS
                                  (verify round 2: APP0 is metadata too, unless it is a plain 16-byte JFIF header)
              gps-glb             a GLB box whose base-colour texture is a JPEG with EXIF/GPS (a user's own model)
              big12mp             a 4000 x 3000 JPEG (no metadata)
              big12mp-rst         the same with a parameterless RST0 marker right after SOI (Pillow still reads
                                  it): its size must still be read from the frame header (qwen is priced by size)
    metadata.py inspect F       → {format, size, canary, exif, gps, app_markers, app0_extra, com, after_eoi,
                                   png_chunks, glb_images}

Each prints one JSON object as its last stdout line.
"""
from __future__ import annotations

import argparse
import io
import json
import struct
import sys
import zlib
from pathlib import Path

from PIL import Image

CANARY = b"TestCam GPS"


def gps_exif(orientation: int | None = None) -> bytes:
    ex = Image.Exif()
    ex[0x010F] = "TestCam"
    ex[0x0110] = CANARY.decode()
    if orientation:
        ex[0x0112] = orientation
    ex[0x8825] = {1: "N", 2: (0.0, 30.0, 0.0), 3: "E", 4: (0.0, 30.0, 0.0)}
    return ex.tobytes()


def base_image(src: Path | None, w=320, h=240) -> Image.Image:
    if src:
        return Image.open(src).convert("RGB")
    x = bytes((i * 255 // max(1, w - 1)) for i in range(w))
    return Image.frombytes("L", (w, h), x * h).convert("RGB")


def jpeg(im: Image.Image, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=90, **kw)
    return buf.getvalue()


def make(kind: str, out: Path, src: Path | None, orientation: int | None) -> dict:
    im = base_image(src)
    if kind == "gps-jpeg":
        data = jpeg(im, exif=gps_exif(orientation))
    elif kind == "trailing-gps":
        data = jpeg(im) + jpeg(im.resize((64, 48)), exif=gps_exif())
    elif kind == "prog-midscan-gps":
        prog = jpeg(im, progressive=True)
        first = prog.index(b"\xff\xda")
        second = prog.index(b"\xff\xda", first + 2)
        ex = gps_exif()
        payload = ex if ex.startswith(b"Exif\x00\x00") else b"Exif\x00\x00" + ex
        seg = b"\xff\xe1" + struct.pack(">H", len(payload) + 2) + payload
        data = prog[:second] + seg + prog[second:]
    elif kind == "zero-pad":
        data = jpeg(im) + b"\x00" * 65536
    elif kind == "gps-png":
        buf = io.BytesIO()
        im.save(buf, "PNG", exif=gps_exif())
        png = buf.getvalue()
        text = b"Comment\x00" + CANARY
        chunk = struct.pack(">I", len(text)) + b"tEXt" + text + struct.pack(">I", zlib.crc32(b"tEXt" + text) & 0xFFFFFFFF)
        iend = png.rindex(b"IEND") - 4
        data = png[:iend] + chunk + png[iend:]
    elif kind == "jfxx-gps":
        clean = jpeg(im)
        i = 4 + int.from_bytes(clean[4:6], "big")  # past SOI and the JFIF APP0
        thumb = jpeg(im.resize((64, 48)), exif=gps_exif())
        payload = b"JFXX\x00\x10" + thumb
        data = clean[:i] + b"\xff\xe0" + struct.pack(">H", len(payload) + 2) + payload + clean[i:]
    elif kind == "gps-glb":
        data = gps_glb(jpeg(im.resize((64, 64)), exif=gps_exif()))
    elif kind in ("big12mp", "big12mp-rst"):
        big = base_image(None, 4000, 3000)
        data = jpeg(big)
        if kind == "big12mp-rst":
            data = data[:2] + b"\xff\xd0" + data[2:]
    else:
        raise SystemExit(f"unknown kind {kind}")
    out.write_bytes(data)
    return {"ok": True, "out": str(out), "bytes": len(data), **inspect(out)}


def gps_glb(texture: bytes) -> bytes:
    """A 0.5 m textured box as a GLB (positions, UVs, indices, one material whose base colour is `texture`)."""
    pos, uv, idx = [], [], []
    for axis in range(3):
        for sign in (-1, 1):
            base = len(pos)
            a, b = [(axis + 1) % 3, (axis + 2) % 3]
            for (s, t) in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                v = [0.0, 0.0, 0.0]
                v[axis], v[a], v[b] = 0.25 * sign, 0.25 * s, 0.25 * t
                v[1] += 0.25
                pos.append(v)
                uv.append([(s + 1) / 2, (t + 1) / 2])
            idx += [base, base + 1, base + 2, base, base + 2, base + 3] if sign > 0 else [base, base + 2, base + 1, base, base + 3, base + 2]
    pb = b"".join(struct.pack("<3f", *v) for v in pos)
    ub = b"".join(struct.pack("<2f", *v) for v in uv)
    ib = b"".join(struct.pack("<H", i) for i in idx)
    ib += b"\0" * (-len(ib) % 4)
    tex = texture + b"\0" * (-len(texture) % 4)
    blob = pb + ub + ib + tex
    o_u, o_i, o_t = len(pb), len(pb) + len(ub), len(pb) + len(ub) + len(ib)
    doc = {
        "asset": {"version": "2.0", "generator": "midstudy evals/lib/metadata.py"},
        "scene": 0, "scenes": [{"nodes": [0]}], "nodes": [{"mesh": 0, "name": "box"}],
        "meshes": [{"primitives": [{"attributes": {"POSITION": 0, "TEXCOORD_0": 1}, "indices": 2, "material": 0}]}],
        "materials": [{"pbrMetallicRoughness": {"baseColorTexture": {"index": 0}, "metallicFactor": 0}}],
        "textures": [{"source": 0}], "images": [{"bufferView": 3, "mimeType": "image/jpeg"}],
        "accessors": [
            {"bufferView": 0, "componentType": 5126, "count": len(pos), "type": "VEC3",
             "min": [min(v[k] for v in pos) for k in range(3)], "max": [max(v[k] for v in pos) for k in range(3)]},
            {"bufferView": 1, "componentType": 5126, "count": len(uv), "type": "VEC2"},
            {"bufferView": 2, "componentType": 5123, "count": len(idx), "type": "SCALAR"}],
        "bufferViews": [{"buffer": 0, "byteOffset": 0, "byteLength": len(pb)}, {"buffer": 0, "byteOffset": o_u, "byteLength": len(ub)},
                        {"buffer": 0, "byteOffset": o_i, "byteLength": len(idx) * 2}, {"buffer": 0, "byteOffset": o_t, "byteLength": len(texture)}],
        "buffers": [{"byteLength": len(blob)}],
    }
    j = json.dumps(doc).encode()
    j += b" " * (-len(j) % 4)
    body = struct.pack("<II", len(j), 0x4E4F534A) + j + struct.pack("<II", len(blob), 0x004E4942) + blob
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


def glb_images(data: bytes) -> list[bytes]:
    """The images embedded in a GLB's binary chunk (by bufferView)."""
    if data[:4] != b"glTF":
        return []
    off, doc, blob = 12, None, b""
    while off + 8 <= len(data):
        n, kind = struct.unpack_from("<II", data, off)
        chunk = data[off + 8:off + 8 + n]
        if kind == 0x4E4F534A:
            doc = json.loads(chunk)
        elif kind == 0x004E4942:
            blob = chunk
        off += 8 + n
    out = []
    for im in (doc or {}).get("images", []):
        if "bufferView" in im:
            v = doc["bufferViews"][im["bufferView"]]
            out.append(bytes(blob[v.get("byteOffset", 0):v.get("byteOffset", 0) + v["byteLength"]]))
    return out


def jpeg_walk(data: bytes):
    """(markers, end) over the whole file, as contract §4.3 asks (between scans too); None when broken."""
    n, i, markers = len(data), 2, []
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
            return markers, i
        if 0xD0 <= m <= 0xD7 or m == 0x01:
            continue
        if i + 2 > n:
            return None
        length = int.from_bytes(data[i:i + 2], "big")
        markers.append(m)
        i += length
        if m == 0xDA:
            while True:
                j = data.find(b"\xff", i)
                if j < 0 or j + 1 >= n:
                    return None
                if data[j + 1] == 0x00 or 0xD0 <= data[j + 1] <= 0xD7:
                    i = j + 2
                    continue
                i = j
                break
    return None


def app0_extras(data: bytes) -> int:
    """APP0 segments before the first scan that aren't a plain 16-byte JFIF header (a JFXX extension, a thumbnail)."""
    n, i, extra = len(data), 2, 0
    while i + 4 <= n and data[i] == 0xFF:
        m = data[i + 1]
        if m == 0xFF:
            i += 1
            continue
        if m == 0xDA or m == 0xD9:
            break
        if 0xD0 <= m <= 0xD7 or m in (0x01, 0xD8):
            i += 2
            continue
        length = int.from_bytes(data[i + 2:i + 4], "big")
        seg = data[i + 2:i + 2 + length]
        if m == 0xE0 and not (length == 16 and seg[2:7] == b"JFIF\x00" and seg[14:16] == b"\x00\x00"):
            extra += 1
        i += 2 + length
    return extra


def inspect(path: Path) -> dict:
    data = path.read_bytes()
    out = {"size": len(data), "canary": CANARY in data, "exif": False, "gps": False}
    if data[:4] == b"glTF":
        out["format"] = "glb"
        out["glb_images"] = []
        for k, img in enumerate(glb_images(data)):
            f = path.with_name(f"{path.name}.image{k}")
            f.write_bytes(img)
            out["glb_images"].append(inspect(f))
            f.unlink()
        out["clean"] = not out["canary"] and all(x.get("clean") for x in out["glb_images"])
        return out
    if data[:2] == b"\xff\xd8":
        out["format"] = "jpeg"
        walk = jpeg_walk(data)
        if walk is None:
            out["broken"] = True
        else:
            markers, end = walk
            out["app_markers"] = sorted({f"APP{m - 0xE0}" for m in markers if 0xE0 <= m <= 0xEF})
            out["app0_extra"] = app0_extras(data)
            out["com"] = sum(1 for m in markers if m == 0xFE)
            out["after_eoi"] = len(data) - end
    elif data[:8] == b"\x89PNG\r\n\x1a\n":
        out["format"] = "png"
        chunks, i = [], 8
        while i + 8 <= len(data):
            n = struct.unpack(">I", data[i:i + 4])[0]
            chunks.append(data[i + 4:i + 8].decode("latin1"))
            i += 12 + n
        out["png_chunks"] = chunks
    else:
        out["format"] = "other"
    try:
        with Image.open(path) as im:
            ex = im.getexif()
            out["exif"] = len(ex) > 0
            out["gps"] = bool(ex.get_ifd(0x8825))
            out["w"], out["h"] = im.size
            out["orientation"] = ex.get(0x0112)
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}: {e}"
    out["clean"] = (not out["canary"] and not out["exif"] and not out["gps"] and not out.get("app0_extra")
                    and not [m for m in out.get("app_markers", []) if m != "APP0"] and not out.get("com")
                    and not out.get("after_eoi") and not set(out.get("png_chunks", [])) & {"eXIf", "tEXt", "iTXt", "zTXt"})
    return out


def main(argv):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("make")
    p.add_argument("--kind", required=True)
    p.add_argument("--out", required=True, type=Path)
    p.add_argument("--from", dest="src", type=Path)
    p.add_argument("--orientation", type=int)
    p = sub.add_parser("inspect")
    p.add_argument("file", type=Path)
    a = ap.parse_args(argv)
    res = make(a.kind, a.out, a.src, a.orientation) if a.cmd == "make" else inspect(a.file)
    print(json.dumps(res))


if __name__ == "__main__":
    main(sys.argv[1:])
