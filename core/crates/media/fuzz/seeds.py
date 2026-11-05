#!/usr/bin/env python3
"""Writes the starting corpora of the kernels' cargo-fuzz targets into evals/out/kh/fuzz-seeds/<target>/ (git-ignored):
evals/lib/metadata.py's GPS-canary files (the privacy evals' own inputs), the tracked fixtures' small images and models
(never fixtures/photos/), Pillow-made JPEGs and PNGs with every kind of metadata, hand-made edge structures, and the
strings v1's differential test draws paths and hosts from. A campaign starts from these and the tracked corpus
(fuzz/corpus/<target>/, the minimised result of earlier campaigns; docs/notes/kernels-hardening.md).

    evals/py core/crates/media/fuzz/seeds.py
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import struct
import sys
import zlib
from pathlib import Path

from PIL import Image, PngImagePlugin

REPO = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(REPO / "evals" / "lib")]
import metadata  # noqa: E402  evals/lib/metadata.py

OUT = REPO / "evals" / "out" / "kh" / "fuzz-seeds"
MAX_SEED = 64 * 1024


def put(target: str, data: bytes) -> None:
    if len(data) > MAX_SEED:
        return
    d = OUT / target
    d.mkdir(parents=True, exist_ok=True)
    (d / hashlib.sha1(data).hexdigest()).write_bytes(data)


def jpeg(im: Image.Image, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", **kw)
    return buf.getvalue()


def png(im: Image.Image, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG", **kw)
    return buf.getvalue()


def seg(marker: int, payload: bytes) -> bytes:
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def glb(doc: dict | str, blob: bytes | None) -> bytes:
    j = (doc if isinstance(doc, str) else json.dumps(doc, separators=(",", ":"))).encode()
    j += b" " * (-len(j) % 4)
    body = struct.pack("<II", len(j), 0x4E4F534A) + j
    if blob is not None:
        b = blob + b"\0" * (-len(blob) % 4)
        body += struct.pack("<II", len(b), 0x004E4942) + b
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


def textured_glb(images: list[tuple[str, bytes]], uri_images: list[str] = (), extensions: bool = False) -> bytes:
    blob = bytearray(b"\1" * 12)
    views = [{"buffer": 0, "byteLength": 12}]
    imgs: list[dict] = []
    for mime, data in images:
        blob += b"\0" * (-len(blob) % 4)
        views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
        blob += data
        imgs.append({"bufferView": len(views) - 1, "mimeType": mime})
    blob += b"\0" * (-len(blob) % 4)
    views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": 8})
    blob += b"\2" * 8
    imgs += [{"uri": u} for u in uri_images]
    if extensions:
        views[0]["extensions"] = {"EXT_meshopt_compression": {"buffer": 0, "byteLength": 12}}
    doc = {"asset": {"version": "2.0"}, "images": imgs, "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
    return glb(doc, bytes(blob))


def main() -> int:
    tmp = OUT / "_metadata"
    tmp.mkdir(parents=True, exist_ok=True)
    canary: dict[str, bytes] = {}
    for kind, ext in (("gps-jpeg", "jpg"), ("trailing-gps", "jpg"), ("prog-midscan-gps", "jpg"), ("zero-pad", "jpg"),
                      ("jfxx-gps", "jpg"), ("gps-png", "png"), ("gps-glb", "glb")):
        f = tmp / f"{kind}.{ext}"
        metadata.make(kind, f, None, 6 if kind == "gps-jpeg" else None)
        canary[kind] = f.read_bytes()

    # --- JPEG ---------------------------------------------------------------------------------------------------
    small = Image.linear_gradient("L").resize((16, 12))
    rgb = Image.merge("RGB", (small, small.rotate(90).resize((16, 12)), Image.new("L", (16, 12), 77)))
    exif = metadata.gps_exif(6)
    jpegs = [
        jpeg(rgb), jpeg(rgb, progressive=True), jpeg(rgb, optimize=True), jpeg(rgb.convert("L")), jpeg(rgb.convert("CMYK")),
        jpeg(rgb, exif=exif), jpeg(rgb, icc_profile=b"\0" * 128 + b"acsp" + b"\0" * 64), jpeg(rgb, comment=b"GPS comment"),
        jpeg(rgb, subsampling=0), jpeg(rgb, quality=10), jpeg(rgb, progressive=True, exif=exif),
    ] + [v for k, v in canary.items() if k.endswith(("jpeg", "gps")) and not k.startswith("gps-png") and k != "gps-glb"]
    clean = jpegs[0]
    jfif_end = 4 + int.from_bytes(clean[4:6], "big")
    jpegs += [
        clean[:4] + b"\x00\x13JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x01\x01\x10\x20\x30" + clean[jfif_end:],  # JFIF thumbnail
        clean[:4] + b"\x00\x0eJFIF\x00\x01\x02\x00\x00\x01\x00\x01" + clean[jfif_end:],  # short JFIF
        clean[:jfif_end] + seg(0xE0, b"AVI1\0" + b"\0" * 9) + clean[jfif_end:],
        clean[:2] + b"\xff\xd0\xff\x01" + clean[2:],  # RST and TEM before the frame
        clean[:jfif_end] + b"\xff\xff\xff" + clean[jfif_end:],  # fill bytes
        clean[:jfif_end] + b"\xff\xd8" + clean[jfif_end:],  # a stray SOI
        clean[:jfif_end] + seg(0xDD, b"\x00\x04") + clean[jfif_end:],  # DRI
        clean[:jfif_end] + seg(0xE1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta/>") + clean[jfif_end:],
        clean[:jfif_end] + seg(0xEE, b"Adobe\0\x64\0\0\0\0\x01") + clean[jfif_end:],
        clean + b"trailing GPS", clean[:-2], b"\xff\xd8\xff\xd9",
        b"\xff\xd8" + seg(0xC0, b"\x08\x00\x10\x00\x10\x03\x01\x11\x00\x02\x11\x00\x03\x11\x00")
        + seg(0xDA, b"\x01\x01\x00\x00\x3f\x00") + b"\x12\xff\x00\x34\xff\xd0\x56\xff\xd9",
    ]
    for j in jpegs:
        put("jpeg_strip", j)

    # --- PNG ----------------------------------------------------------------------------------------------------
    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", "GPS")
    info.add_itxt("XML:com.adobe.xmp", "<x:xmpmeta GPS/>")
    info.add_text("Software", "x" * 40, zip=True)
    pngs = [png(rgb), png(rgb, pnginfo=info), png(rgb, exif=exif), png(rgb.convert("RGBA")), png(rgb.convert("P")),
            png(rgb.convert("I;16")), png(rgb.convert("L")), canary["gps-png"]]
    base = pngs[0]
    iend = base.rindex(b"IEND") - 4
    pngs += [base[:iend] + chunk(b"tIME", b"\x07\xea\x0b\x05\x0c\x00\x00") + base[iend:], base + b"after IEND", base[:iend],
             base[:iend] + chunk(b"eXIf", b"MM\0*GPS") + base[iend:], base[:iend] + chunk(b"EXIF", b"MM\0*") + base[iend:]]
    for p in pngs:
        put("png_strip", p)

    # --- GLB ----------------------------------------------------------------------------------------------------
    gj, gp = jpegs[5], pngs[1]
    glbs = [canary["gps-glb"], (REPO / "fixtures/models/arrow.glb").read_bytes(), (REPO / "fixtures/library/test-cube/model.glb").read_bytes(),
            textured_glb([("image/jpeg", gj)]), textured_glb([("image/png", gp)]), textured_glb([("image/jpeg", gj), ("image/png", gp)]),
            textured_glb([("image/jpeg", gj)], extensions=True),
            textured_glb([], uri_images=[f"data:image/jpeg;base64,{base64.b64encode(gj).decode()}", "tex.png"]),
            textured_glb([("image/webp", b"RIFF\x1a\0\0\0WEBPVP8 " + b"\0" * 18)]),
            glb({"asset": {"version": "2.0"}}, None), glb('{"asset":{"version":"2.0"},"buffers":[{"byteLength":0}]}', b"")]
    for g in glbs:
        put("glb_strip", g)

    # --- strings ------------------------------------------------------------------------------------------------
    paths = ["/", "//", "///planner/", "/?x", "/#y", "/planner", "/planner/", "/planner/index.html", "/planner/js/../main.js",
             "/./library/costs.csv", "/library/library.json", "/LIBRARY/library.json", "/library/chair/model.glb",
             "/library/chair/splat.spz", "/library/.trash/x/model.glb", "/scenes/scene-20261104-201500/photo.jpg",
             "/scenes/s/calib.json", "/renders/render-20261104-201500-2.jpg", "/renders/.hidden", "/%2e%2e/%2E/x",
             "/%2e%65nv", "/a%00b", "/a%5Cb", "/a\\b", "/%C3%A9", "/%C3", "/x%3Fy?q#f", "/%zz%4", "/%%41", "/...", "/api/scenes",
             "/planner%00/x", "/é%41", "/%252e%252e/x"]
    for p in paths:
        put("path_normalize", p.encode())
    hosts = ["127.0.0.1", "127.0.0.1:8765", "localhost", " LocalHost ", "[::1]", "[::1]:80", "homeserver", "homeserver:443",
             "127.0.0.1:80@evil.example", "[::1]evil.example", "http://x", "a:123456", "[]", "[::1", "\xa0127.0.0.1\x85",
             "[0:0:0:0:0:0:0:1]", "12", " 12 ", "999999999999999", "1000000000000000", "+1", "²"]
    for h in hosts:
        put("host_check", h.encode())

    # --- the other parsers (media_misc: see its target for the layout) ------------------------------------------
    misc = [b"\x00" + h.encode() for h in ("eyJ0aXRsZSI6ICJMb3VuZ2UifQ==", "QUJD", "QQ==", "=QUJD", "QUJD\n", "QU=JD")]
    misc += [b"\x01" + v.encode() for v in (f"data:image/jpeg;base64,{base64.b64encode(clean[:40]).decode()}",
                                            "data:image/png;base64,iVBORw0KGgo=", "data:image/jpeg;base64, QUJD\n", "data:,x",
                                            "DATA:image/svg+xml;BASE64,PHN2Zz4=#frag", "data:text/plain;charset=utf-8,%41%zz")]
    misc += [b"\x02" + n for n in (b"scene-20261104-201500", b"scene-20261104-201500-12", b"render-20261104-201500-2",
                                   b"lounge", b"a" * 64, b"a" * 65, b"evil\n", b"x-12345678-123456-12345678-123456")]
    misc += [b"\x03" + b"\x00" + n for n in (b"chair.obj", b"../evil.obj", b"__MACOSX/._x", b"a/.DS_Store", b"C:x.obj", b"dir/")]
    misc += [b"\x04" + h[:64] for h in (clean, pngs[0], canary["gps-glb"], b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic",
                                        b"\x00\x00\x00\x18ftypmif1\x00\x00\x00\x00avifmif1", b"RIFF\0\0\0\0WEBPVP8 ", b"PK\x03\x04")]
    for m in misc:
        put("media_misc", m)

    # --- depth.png (raster decode_png) ----------------------------------------------------------------------------
    for p in sorted((REPO / "fixtures").glob("scenes/*/depth.png")):
        put("decode_png", p.read_bytes())
    grad = Image.linear_gradient("L").resize((24, 16))
    put("decode_png", png(grad))
    put("decode_png", png(grad.convert("I;16")))
    put("decode_png", png(grad, optimize=True))
    for d in sorted(OUT.iterdir()):
        if d.name != "_metadata":
            print(f"{d.name:16} {len(list(d.iterdir())):>4} seeds")
    return 0


if __name__ == "__main__":
    sys.exit(main())
