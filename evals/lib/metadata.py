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
    metadata.py inspect F       → {format, size, canary, exif, gps, app_markers, com, after_eoi, png_chunks}

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
    else:
        raise SystemExit(f"unknown kind {kind}")
    out.write_bytes(data)
    return {"ok": True, "out": str(out), "bytes": len(data), **inspect(out)}


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


def inspect(path: Path) -> dict:
    data = path.read_bytes()
    out = {"size": len(data), "canary": CANARY in data, "exif": False, "gps": False}
    if data[:2] == b"\xff\xd8":
        out["format"] = "jpeg"
        walk = jpeg_walk(data)
        if walk is None:
            out["broken"] = True
        else:
            markers, end = walk
            out["app_markers"] = sorted({f"APP{m - 0xE0}" for m in markers if 0xE0 <= m <= 0xEF})
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
    out["clean"] = (not out["canary"] and not out["exif"] and not out["gps"]
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
