#!/usr/bin/env python3
"""Differential test: v1's Python kernels against midstudy-media (docs/REFACTOR.md, track k-media).

Each v1 function and its Rust counterpart (through examples/difftool.rs) run on the same inputs; the run requires the
same decisions and the same bytes. Every intended difference is named in EXPECTED with its reason; any other
difference fails the run (exit 1).

    (cd core && cargo build --release --example difftool -p midstudy-media)
    evals/py core/crates/media/tests/diff_v1.py [--difftool core/target/release/examples/difftool] [--seed 1]
                                                [--scale 1.0]

Inputs: evals/lib/metadata.py's GPS-canary files (EXIF, after EOI, between progressive scans, zero padding, JFXX,
eXIf/tEXt, a GPS GLB, 12 MP, RST0), the tracked fixtures' images and models (never fixtures/photos/), Pillow-made
JPEGs and PNGs, synthetic GLBs and zips, and seeded random mutations and strings. Scratch goes to evals/out/media-diff/.

v1 functions driven (file:function): planner/serve.py clean_jpeg, jpeg_size, png_size, image_kind, clean_path,
translate_path/hidden/do_GET's redirect, host_name, forged, CONTENT_LENGTH, SLUG, name_order, decode_data_uri,
zip_problem; calib/src/midstudy_calib/ingest.py sniff, is_clean_jpeg and ingest's pass-through decision;
pipeline/src/midstudy_pipeline/glb.py clean_jpeg, clean_png, load_model, scrub_images; objzip.py check;
CPython's base64.b64decode (strict and lenient), as v1 called it.
"""
from __future__ import annotations

import argparse
import base64
import binascii
import copy
import io
import json
import os
import random
import shutil
import struct
import subprocess
import sys
import types
import zlib
from pathlib import Path
from urllib.parse import urlsplit

HERE = Path(__file__).resolve()
REPO = HERE.parents[4]
sys.path[:0] = [str(REPO / "planner"), str(REPO / "calib" / "src"), str(REPO / "pipeline" / "src"), str(REPO / "evals" / "lib")]
os.environ["MIDSTUDY_NO_DOTENV"] = "1"
os.environ["NOOK_NO_DOTENV"] = "1"
os.environ.pop("FAL_KEY", None)

import metadata  # noqa: E402  evals/lib/metadata.py
import serve  # noqa: E402  planner/serve.py
from midstudy_calib import ingest  # noqa: E402
from midstudy_pipeline import MidstudyError  # noqa: E402
from midstudy_pipeline import glb as pglb  # noqa: E402
from midstudy_pipeline import objzip  # noqa: E402
from PIL import Image, PngImagePlugin  # noqa: E402

OUT = REPO / "evals" / "out" / "media-diff"

# Every intended difference, by name: what v2 does, and why. A mismatch outside these fails the run.
EXPECTED = {
    "sniff-avif": "serve.py's image_kind took a generic HEIF major brand (mif1, msf1) even when the compatible brands "
                  "say AVIF-only; v2 refuses it at upload, as calib's ingest refused it after the upload",
    "sniff-brands": "serve.py's brand list lacked hevm, hevs, mif2 and miaf, which calib's ingest accepts; v2 uses "
                    "calib's rule in both places",
    "pass-decode": "v1's pass-through also decoded the whole JPEG with Pillow and failed the ingest when it couldn't; "
                   "that needs a decoder and stays with the caller (calib)",
    "glb-bad-texture": "a texture v1 couldn't parse was served with its metadata; v2 refuses the model",
    "glb-container": "v1 read a cut-off or misordered container leniently (Python slicing clamps); v2 refuses it",
    "glb-json-strict": "v2 refuses duplicate JSON keys (JSON.parse keeps the last; a reader keeping the first could "
                       "draw another image than the one cleaned) and a non-string asset.version",
    "glb-fields": "v2 refuses bufferViews outside their buffer and non-integer indices, which v1 ignored or crashed on",
    "glb-mesh-compression": "v1's pipeline refused Draco and meshopt models (trimesh can't read them) before scrubbing; "
                            "stripping metadata has no reason to",
    "zip-bad-name": "v1 cut a name at its first NUL (or crashed on a name flagged UTF-8 that isn't); v2 refuses it",
    "glb-external-image": "v1's pipeline embedded an image file named by a uri before scrubbing, and refused the "
                          "model when the file wasn't there; the strip can only report an external image (it isn't in "
                          "the file, so it can't leak from it)",
    "glb-packing": "v1's pipeline packed every buffer into one before scrubbing; the strip takes a GLB whose images "
                   "are in its own binary chunk (the v2 pipeline packs with gltf-transform first)",
    "zip-bad-name": "v1 cut a name at its first NUL (or crashed on a name flagged UTF-8 that isn't); v2 refuses it",
    "zip-v1-copies": "v1's two zip checks disagreed on an entry like a.obj/. (serve.py counted it as an .obj by its "
                     "path suffix, objzip.py didn't, by the name's ending); v2 follows serve.py, which decides first",
}


class Tally:
    def __init__(self) -> None:
        self.areas: dict[str, dict] = {}

    def area(self, name: str) -> dict:
        return self.areas.setdefault(name, {"cases": 0, "same": 0, "expected": {}, "failures": []})

    def same(self, name: str) -> None:
        a = self.area(name)
        a["cases"] += 1
        a["same"] += 1

    def expected(self, name: str, reason: str) -> None:
        assert reason in EXPECTED, reason
        a = self.area(name)
        a["cases"] += 1
        a["expected"][reason] = a["expected"].get(reason, 0) + 1

    def fail(self, name: str, desc: str, v1, v2) -> None:
        a = self.area(name)
        a["cases"] += 1
        a["failures"].append((desc, repr(v1)[:300], repr(v2)[:300]))

    def check(self, name: str, desc: str, v1, v2, reason: str | None = None) -> None:
        if v1 == v2:
            self.same(name)
        elif reason:
            self.expected(name, reason)
        else:
            self.fail(name, desc, v1, v2)

    def report(self) -> bool:
        ok = True
        for name, a in sorted(self.areas.items()):
            exp = ", ".join(f"{k} {v}" for k, v in sorted(a["expected"].items()))
            print(f"  {name:<16} {a['cases']:>6} cases, {a['same']:>6} identical" + (f", expected differences: {exp}" if exp else "")
                  + (f", {len(a['failures'])} UNEXPECTED" if a["failures"] else ""))
            for desc, v1, v2 in a["failures"][:8]:
                ok = False
                print(f"      {desc}\n        v1: {v1}\n        v2: {v2}")
            if a["failures"]:
                ok = False
        return ok


class Rust:
    """Runs examples/difftool on a batch of cases."""

    def __init__(self, tool: Path, out: Path) -> None:
        self.tool, self.out, self.batches = tool, out, 0

    def run(self, cases: list[tuple[str, list]]) -> list[dict]:
        self.batches += 1
        out_dir = self.out / str(self.batches)  # large outputs land in <batch>/<case>.bin: one folder per batch
        out_dir.mkdir(parents=True, exist_ok=True)
        lines = []
        for op, args in cases:
            enc = []
            for a in args:
                if isinstance(a, Path):
                    enc.append("@" + str(a))
                elif a is None:
                    enc.append("ff")
                elif isinstance(a, str):
                    enc.append(a.encode("utf-8", "surrogatepass").hex())
                else:
                    enc.append(bytes(a).hex())
            lines.append(op + "\t" + "\t".join(enc))
        p = subprocess.run([str(self.tool), str(out_dir)], input="\n".join(lines) + "\n", capture_output=True, text=True)
        if p.returncode:
            raise SystemExit(f"difftool failed: {p.stderr[-2000:]}")
        out = [json.loads(line) for line in p.stdout.splitlines()]
        if len(out) != len(cases):
            raise SystemExit(f"difftool answered {len(out)} of {len(cases)} cases")
        return out

    @staticmethod
    def data(r: dict) -> bytes:
        return bytes.fromhex(r["hex"]) if "hex" in r else Path(r["file"]).read_bytes()


# --- corpus ------------------------------------------------------------------------------------------------------
def jpeg_bytes(im: Image.Image, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", **kw)
    return buf.getvalue()


def png_bytes(im: Image.Image, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "PNG", **kw)
    return buf.getvalue()


def seg(marker: int, payload: bytes) -> bytes:
    return bytes((0xFF, marker)) + struct.pack(">H", len(payload) + 2) + payload


def base_images(rng: random.Random) -> list[Image.Image]:
    ims = []
    for w, h in ((64, 48), (17, 33), (160, 120)):
        g = Image.linear_gradient("L").resize((w, h))
        rgb = Image.merge("RGB", (g, g.rotate(90).resize((w, h)), Image.new("L", (w, h), rng.randrange(256))))
        ims.append(rgb)
    return ims


def jpeg_corpus(rng: random.Random, scale: float) -> tuple[list[tuple[str, bytes]], list[tuple[str, Path]]]:
    """(small JPEGs in memory, big JPEG files)."""
    small: list[tuple[str, bytes]] = []
    ims = base_images(rng)
    exif = metadata.gps_exif(6)
    icc = b"\0" * 128 + b"acsp" + b"\0" * 400
    for k, im in enumerate(ims):
        small.append((f"pillow{k}", jpeg_bytes(im, quality=85)))
        small.append((f"pillow{k}-prog", jpeg_bytes(im, quality=80, progressive=True)))
        small.append((f"pillow{k}-opt", jpeg_bytes(im, quality=90, optimize=True)))
        small.append((f"pillow{k}-grey", jpeg_bytes(im.convert("L"))))
        small.append((f"pillow{k}-cmyk", jpeg_bytes(im.convert("CMYK"))))
        small.append((f"pillow{k}-exif", jpeg_bytes(im, exif=exif)))
        small.append((f"pillow{k}-icc", jpeg_bytes(im, icc_profile=icc)))
        small.append((f"pillow{k}-com", jpeg_bytes(im, comment=b"TestCam GPS comment")))
        small.append((f"pillow{k}-444", jpeg_bytes(im, subsampling=0)))
    # metadata.py's GPS-canary kinds (the small ones; the 12 MP ones are files below).
    tmp = OUT / "corpus"
    tmp.mkdir(parents=True, exist_ok=True)
    for kind in ("gps-jpeg", "trailing-gps", "prog-midscan-gps", "zero-pad", "jfxx-gps"):
        f = tmp / f"{kind}.jpg"
        metadata.make(kind, f, None, 6 if kind == "gps-jpeg" else None)
        small.append((kind, f.read_bytes()))
    clean = small[0][1]
    jfif_end = 4 + int.from_bytes(clean[4:6], "big")
    # Hand-made structures v1 handles specially.
    thumb = bytes(clean[:4] + b"\x00\x13" + b"JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x01\x01" + b"\x10\x20\x30") + clean[jfif_end:]
    small.append(("jfif-thumbnail", thumb))
    small.append(("jfif-short", clean[:4] + b"\x00\x0eJFIF\x00\x01\x02\x00\x00\x01\x00\x01" + clean[jfif_end:]))
    small.append(("jfif-dims-no-data", clean[:4] + b"\x00\x10JFIF\x00\x01\x02\x00\x00\x01\x00\x01\x02\x02" + clean[jfif_end:]))
    small.append(("app0-avi1", clean[:jfif_end] + seg(0xE0, b"AVI1\0" + b"\0" * 9) + clean[jfif_end:]))
    small.append(("rst-and-tem", clean[:2] + b"\xff\xd0\xff\x01" + clean[2:]))
    small.append(("fill-bytes", clean[:jfif_end] + b"\xff\xff\xff" + clean[jfif_end:]))
    small.append(("stray-soi", clean[:jfif_end] + b"\xff\xd8" + clean[jfif_end:]))
    small.append(("no-eoi", clean[:-2]))
    small.append(("eoi-only", b"\xff\xd8\xff\xd9"))
    small.append(("app14-adobe", clean[:jfif_end] + seg(0xEE, b"Adobe\0\x64\0\0\0\0\x01") + clean[jfif_end:]))
    small.append(("xmp", clean[:jfif_end] + seg(0xE1, b"http://ns.adobe.com/xap/1.0/\0<x:xmpmeta GPS/>") + clean[jfif_end:]))
    small.append(("dri", clean[:jfif_end] + seg(0xDD, b"\x00\x04") + clean[jfif_end:]))
    for name in ("living-cool", "portrait", "steep-roll"):
        small.append((f"fixture-{name}", (REPO / "fixtures" / "scenes" / name / "photo.jpg").read_bytes()))
    for p in sorted((REPO / "fixtures" / "fal").glob("*/input.jpg")):
        small.append((f"fixture-{p.parent.name}", p.read_bytes()))

    # Seeded mutations of the small hand-made and Pillow JPEGs (not the fixtures: they are big).
    bases = [b for n, b in small if not n.startswith("fixture") and len(b) < 40000]
    n_mut = int(4000 * scale)
    for i in range(n_mut):
        small.append((f"mut{i}", mutate_jpeg(rng.choice(bases), rng)))

    big: list[tuple[str, Path]] = []
    for kind in ("big12mp", "big12mp-rst"):
        f = tmp / f"{kind}.jpg"
        if not f.exists():
            metadata.make(kind, f, None, None)
        big.append((kind, f))
    gps12 = tmp / "big12mp-gps.jpg"
    if not gps12.exists():
        g = Image.linear_gradient("L").resize((4000, 3000))
        gps12.write_bytes(jpeg_bytes(Image.merge("RGB", (g, g.transpose(Image.Transpose.FLIP_LEFT_RIGHT), g)), quality=90,
                                     exif=metadata.gps_exif(), progressive=True))
    big.append(("big12mp-gps-prog", gps12))
    return small, big


def markers(data: bytes) -> list[int]:
    return [i for i in range(len(data) - 1) if data[i] == 0xFF and data[i + 1] not in (0x00, 0xFF)]


def mutate_jpeg(base: bytes, rng: random.Random) -> bytes:
    d = bytearray(base)
    n = len(d)
    # Half the time aim at the header region, where the structure is.
    pos = rng.randrange(min(n, 700)) if rng.random() < 0.5 else rng.randrange(n)
    r = rng.random()
    if r < 0.15:
        return bytes(d[:rng.randrange(n)])
    if r < 0.30:
        d[pos] = rng.randrange(256)
    elif r < 0.40:
        d[pos:pos] = b"\xff" * rng.randrange(1, 4)
    elif r < 0.50:
        d[pos:pos] = rng.choice([b"\xff\x00", b"\xff\xd0", b"\xff\x01", b"\xff\xd8", b"\xff\xd9", b"\xff\xda\x00\x02", b"\xff\xfe\x00\x02"])
    elif r < 0.60:
        d += rng.choice([b"\x00", b"\xff", b"junk", base[:200], b"\xff\xd9"])
    elif r < 0.75:
        ms = markers(base)
        if ms:
            m = rng.choice(ms)
            if m + 3 < n:
                d[m + 2:m + 4] = struct.pack(">H", rng.choice([0, 1, 2, 3, 0xFFFF, rng.randrange(65536)]))
    elif r < 0.90:
        ms = [m for m in markers(base) if m > 1] or [2]
        m = rng.choice(ms)
        payload = rng.choice([b"Exif\0\0" + os.urandom(rng.randrange(20)), b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0", b"JFXX\0\x10abc",
                              b"", os.urandom(rng.randrange(1, 40))])
        d[m:m] = seg(rng.choice([0xE0, 0xE1, 0xE2, 0xED, 0xEE, 0xEF, 0xFE, 0xDD, 0xF0]), payload)
    else:
        a = rng.randrange(n)
        del d[a:a + rng.randrange(1, 64)]
    return bytes(d)


def png_chunk(kind: bytes, body: bytes) -> bytes:
    return struct.pack(">I", len(body)) + kind + body + struct.pack(">I", zlib.crc32(kind + body) & 0xFFFFFFFF)


def png_corpus(rng: random.Random, scale: float) -> list[tuple[str, bytes]]:
    out = []
    ims = base_images(rng)
    info = PngImagePlugin.PngInfo()
    info.add_text("Comment", "TestCam GPS")
    info.add_itxt("XML:com.adobe.xmp", "<x:xmpmeta GPS/>")
    info.add_text("Software", "x" * 300, zip=True)
    for k, im in enumerate(ims):
        out.append((f"png{k}", png_bytes(im)))
        out.append((f"png{k}-text", png_bytes(im, pnginfo=info)))
        out.append((f"png{k}-exif", png_bytes(im, exif=metadata.gps_exif())))
        out.append((f"png{k}-rgba", png_bytes(im.convert("RGBA"))))
        out.append((f"png{k}-p", png_bytes(im.convert("P"))))
        out.append((f"png{k}-16", png_bytes(im.convert("I;16"))))
    tmp = OUT / "corpus"
    f = tmp / "gps-png.png"
    metadata.make("gps-png", f, None, None)
    out.append(("gps-png", f.read_bytes()))
    base = out[0][1]
    iend = base.rindex(b"IEND") - 4
    out.append(("time", base[:iend] + png_chunk(b"tIME", b"\x07\xea\x0b\x05\x0c\x00\x00") + base[iend:]))
    out.append(("after-iend", base + b"trailing GPS"))
    out.append(("no-iend", base[:iend]))
    out.append(("exif-case", base[:iend] + png_chunk(b"EXIF", b"MM\0*") + base[iend:]))
    for p in sorted((REPO / "fixtures").glob("scenes/*/*.png"))[:6] + sorted((REPO / "fixtures" / "calib").glob("*/depth.png"))[:2]:
        out.append((f"fixture-{p.parent.name}-{p.name}", p.read_bytes()))
    bases = [b for n, b in out if len(b) < 60000]
    for i in range(int(1500 * scale)):
        d = bytearray(rng.choice(bases))
        n = len(d)
        r = rng.random()
        pos = rng.randrange(8, min(n, 200)) if rng.random() < 0.6 else rng.randrange(n)
        if r < 0.3:
            d = d[:rng.randrange(n)]
        elif r < 0.6:
            d[pos] = rng.randrange(256)
        elif r < 0.8:
            d[pos:pos + 4] = struct.pack(">I", rng.choice([0, 1, 0x7FFFFFFF, 0xFFFFFFFF, rng.randrange(1 << 16)]))
        else:
            d[pos:pos] = png_chunk(rng.choice([b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"tIME", b"gAMA", b"IEND"]), os.urandom(rng.randrange(12)))
        out.append((f"pmut{i}", bytes(d)))
    return out


# --- GLB ---------------------------------------------------------------------------------------------------------
JSON_CHUNK, BIN_CHUNK = 0x4E4F534A, 0x004E4942


def make_glb(json_text: str | bytes, bin_data: bytes | None, extra: tuple = (), trailing: bytes = b"",
             json_first: bool = True, declared_delta: int = 0) -> bytes:
    j = json_text.encode() if isinstance(json_text, str) else json_text
    j += b" " * (-len(j) % 4)
    chunks = [struct.pack("<II", len(j), JSON_CHUNK) + j]
    if bin_data is not None:
        b = bin_data + b"\0" * (-len(bin_data) % 4)
        chunks.append(struct.pack("<II", len(b), BIN_CHUNK) + b)
    if not json_first:
        chunks.reverse()
    for kind, data in extra:
        chunks.append(struct.pack("<II", len(data), kind) + data)
    body = b"".join(chunks)
    return b"glTF" + struct.pack("<II", 2, 12 + len(body) + declared_delta) + body + trailing


def synth_glb(rng: random.Random, images: list[tuple[str, bytes, str]], extensions: bool = False) -> bytes:
    blob = bytearray(os.urandom(36))
    views: list[dict] = [{"buffer": 0, "byteOffset": 0, "byteLength": 36}]
    imgs: list[dict] = []
    for how, data, mime in images:
        if how == "view":
            blob += b"\0" * (-len(blob) % 4)
            views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": len(data)})
            blob += data
            imgs.append({"bufferView": len(views) - 1, "mimeType": mime})
        elif how == "shared" and imgs and "bufferView" in imgs[-1]:
            imgs.append({"bufferView": imgs[-1]["bufferView"], "mimeType": mime})
        elif how == "datauri":
            imgs.append({"uri": f"data:{mime};base64,{base64.b64encode(data).decode()}"})
        if rng.random() < 0.5:
            blob += b"\0" * (-len(blob) % 4)
            views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": 12, "byteStride": 12})
            blob += os.urandom(12)
    blob += b"\0" * (-len(blob) % 4)
    views.append({"buffer": 0, "byteOffset": len(blob), "byteLength": 24})
    blob += os.urandom(24)
    if extensions:
        views[0]["extensions"] = {"EXT_meshopt_compression": {"buffer": 0, "byteOffset": 0, "byteLength": 36}}
    doc = {"asset": {"version": "2.0", "generator": "diff_v1"}, "scene": 0, "scenes": [{"nodes": []}],
           "images": imgs, "bufferViews": views, "buffers": [{"byteLength": len(blob)}]}
    if not imgs:
        del doc["images"]
    return make_glb(json.dumps(doc, separators=(",", ":") if rng.random() < 0.5 else (", ", ": ")), bytes(blob))


def glb_corpus(rng: random.Random, scale: float, jpegs: list[bytes], pngs: list[bytes]) -> list[tuple[str, bytes]]:
    out: list[tuple[str, bytes]] = []
    tmp = OUT / "corpus"
    f = tmp / "gps-glb.glb"
    metadata.make("gps-glb", f, None, None)
    gps = f.read_bytes()
    out.append(("gps-glb", gps))
    for p in sorted(REPO.glob("fixtures/**/*.glb")):
        out.append((f"fixture-{p.relative_to(REPO)}", p.read_bytes()))
    webp = b"RIFF\x1a\0\0\0WEBPVP8 " + os.urandom(18)
    kinds = [("view", j, "image/jpeg") for j in jpegs] + [("view", p, "image/png") for p in pngs]
    for i in range(int(80 * scale)):
        images = [rng.choice(kinds) for _ in range(rng.randrange(0, 4))]
        if rng.random() < 0.3:
            images.append(("shared", b"", "image/jpeg"))
        if rng.random() < 0.3:
            how, data, mime = rng.choice(kinds)
            images.append(("datauri", data, mime))
        if rng.random() < 0.2:
            images.append(("view", webp, "image/webp"))
        out.append((f"synth{i}", synth_glb(rng, images)))
    out.append(("meshopt-in-place", synth_glb(rng, [kinds[0]], extensions=True)))
    # Container and document variants of gps-glb.
    j_len = struct.unpack_from("<I", gps, 12)[0]
    j_text = gps[20:20 + j_len]
    b_off = 20 + j_len
    bin_data = gps[b_off + 8:]
    doc = json.loads(j_text)
    out.append(("trailing", gps + b"\0\0\0\0GPS"))
    out.append(("unknown-chunk", make_glb(j_text, bin_data, extra=((0x12345678, b"GPS!"),))))
    out.append(("bin-first", make_glb(j_text, bin_data, json_first=False)))
    out.append(("declared-short", make_glb(j_text, bin_data, declared_delta=-8)))
    out.append(("declared-long", make_glb(j_text, bin_data, declared_delta=8)))
    out.append(("truncated", gps[:-100]))
    out.append(("version1", gps[:4] + struct.pack("<I", 1) + gps[8:]))
    out.append(("nul-padded-json", make_glb(j_text.rstrip() + b"\0\0\0\0", bin_data)))
    out.append(("bom", make_glb(b"\xef\xbb\xbf" + j_text, bin_data)))
    dup = json.dumps(doc).replace('"bufferView": 3', '"bufferView": 3, "bufferView": 0')
    out.append(("duplicate-key", make_glb(dup, bin_data)))
    out.append(("numeric-version", make_glb(json.dumps({**doc, "asset": {"version": 2.0}}), bin_data)))
    out.append(("meshopt-used", make_glb(json.dumps({**doc, "extensionsUsed": ["EXT_meshopt_compression"]}), bin_data)))
    both = copy.deepcopy(doc)
    both["images"][0]["uri"] = "x.jpg"
    out.append(("bufferview-and-uri", make_glb(json.dumps(both), bin_data)))
    far = copy.deepcopy(doc)
    far["bufferViews"][0]["byteLength"] += 10_000
    out.append(("view-out-of-range", make_glb(json.dumps(far), bin_data)))
    ext = copy.deepcopy(doc)
    ext["images"].append({"uri": "textures/wood.jpg"})
    out.append(("external-image", make_glb(json.dumps(ext), bin_data)))
    two = copy.deepcopy(doc)
    two["buffers"].append({"byteLength": 4, "uri": "data:application/octet-stream;base64,AAAAAA=="})
    out.append(("second-buffer", make_glb(json.dumps(two), bin_data)))
    # Seeded mutations of the GPS GLB and some synthetic ones.
    bases = [gps] + [b for n, b in out if n.startswith("synth")][:10]
    for i in range(int(400 * scale)):
        d = bytearray(rng.choice(bases))
        jl = struct.unpack_from("<I", d, 12)[0]
        r = rng.random()
        if r < 0.25:
            d = d[:rng.randrange(len(d))]
        elif r < 0.6:
            pos = rng.randrange(20, 20 + jl)
            d[pos] = ord(rng.choice('0123456789{}[]",:-x '))
        else:
            pos = rng.randrange(20 + jl + 8, len(d)) if len(d) > 28 + jl else rng.randrange(len(d))
            d[pos] = rng.randrange(256)
        out.append((f"gmut{i}", bytes(d)))
    return out


def glb_parts(data: bytes) -> tuple[dict, bytes | None]:
    """The JSON (parsed) and binary chunk of a GLB the Rust side wrote (well formed by construction)."""
    jl = struct.unpack_from("<I", data, 12)[0]
    doc = json.loads(data[20:20 + jl])
    off = 20 + jl
    blob = data[off + 8:off + 8 + struct.unpack_from("<I", data, off)[0]] if off < len(data) else None
    return doc, blob


def v1_glb(path: Path) -> tuple[str, object]:
    """v1's pipeline on a GLB up to the texture scrub: ("ok", (doc, blob, changed)) or ("error", message)."""
    try:
        doc, blob = pglb.load_model(path)
        doc = copy.deepcopy(doc)
        blob, changed = pglb.scrub_images(doc, blob)
        return "ok", (doc, blob, changed)
    except MidstudyError as e:
        return "error", str(e)
    except Exception as e:  # noqa: BLE001  v1 crashed (a 500 or a traceback in midstudy-add)
        return "error", f"{type(e).__name__}: {e}"


GLB_ERROR_REASON = {
    "BadImage": "glb-bad-texture",
    "Length": "glb-container", "ChunkTruncated": "glb-container", "FirstChunkNotJson": "glb-container",
    "DuplicateChunk": "glb-container", "BinShort": "glb-container", "BinMissing": "glb-container",
    "Json": "glb-json-strict", "NotGltf2": "glb-json-strict",
    "Field": "glb-fields", "ImageSource": "glb-fields", "Overlap": "glb-fields",
    "ImageOutsideBin": "glb-packing",
}


def compare_glb(t: Tally, cases: list[tuple[str, bytes]], rust: Rust) -> None:
    paths = []
    for k, (name, data) in enumerate(cases):
        p = OUT / "glb" / f"{k}.glb"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
        paths.append(p)
    in_place = rust.run([("glb-inplace", [p]) for p in paths])
    compact = rust.run([("glb-compact", [p]) for p in paths])
    for (name, data), p, ri, rc in zip(cases, paths, in_place, compact):
        status, v1 = v1_glb(p)
        if status == "error" or not ri["ok"]:
            if status == "error" and not ri["ok"]:
                t.same("glb")
                continue
            if not ri["ok"]:
                t.check("glb", f"{name}: v2 refused ({ri['error']}) what v1 took", status, "error", GLB_ERROR_REASON.get(ri["error"]))
                continue
            # v1 refused, v2 accepted: explained only for v1's pipeline-only refusals.
            msg = str(v1)
            if "mesh compression" in msg:
                t.expected("glb", "glb-mesh-compression")
            elif "isn't next to it" in msg:
                t.expected("glb", "glb-external-image")
            else:
                t.fail("glb", name, msg, ri)
            continue
        doc1, blob1, changed1 = v1
        try:
            doc0 = json.loads(data[20:20 + struct.unpack_from("<I", data, 12)[0]])
            packed = len(doc0.get("buffers", [])) > 1 or any(
                isinstance(im.get("uri"), str) and not im["uri"].startswith("data:") for im in doc0.get("images", []))
        except (ValueError, struct.error, AttributeError, TypeError):
            packed = False
        out = rust.data(ri)
        doc2, blob2 = glb_parts(out)
        if doc2 != doc1:
            t.check("glb", f"{name}: JSON differs (in place)", doc1, doc2, "glb-packing" if packed else None)
            continue
        n = doc1["buffers"][0].get("byteLength", 0) if doc1.get("buffers") else 0
        if blob1 is not None and blob2 is not None and blob1[:n] != blob2[:n]:
            t.fail("glb", f"{name}: binary chunk differs (in place)", len(blob1), len(blob2))
            continue
        views_changed = {i[5] for i in ri["images"] if i[4] and i[5] >= 0}
        uris_changed = sum(1 for i in ri["images"] if i[4] and i[5] == -1)
        if changed1 != len(views_changed) + uris_changed:
            t.fail("glb", f"{name}: changed images", changed1, ri["images"])
            continue
        if not rc["ok"]:
            t.fail("glb", f"{name}: compact refused what in-place took", None, rc)
            continue
        if name == "gps-glb":
            privacy_check(t, "gps-glb-in-place", out, ".glb")
            privacy_check(t, "gps-glb-compact", rust.data(rc), ".glb")
        problem = check_compact(doc1, blob1, rust.data(rc), rc["layout"])
        if problem:
            t.fail("glb", f"{name}: compact {problem}", None, None)
            continue
        t.same("glb")


def check_compact(doc1: dict, blob1: bytes | None, out: bytes, layout: str) -> str | None:
    """The compact output against v1's in-place result: same JSON except view offsets/lengths and buffer 0's length,
    each view's bytes the same (an image's up to its new length), every offset congruent mod 16, never larger."""
    doc2, blob2 = glb_parts(out)
    strip = lambda d: {**d, "bufferViews": [{k: v for k, v in bv.items() if k not in ("byteOffset", "byteLength")} for bv in d.get("bufferViews", [])],  # noqa: E731
                       "buffers": [{k: v for k, v in b.items() if k != "byteLength"} for b in d.get("buffers", [])]}
    if strip(doc1) != strip(doc2):
        return "JSON differs beyond offsets and lengths"
    image_views = {im["bufferView"] for im in doc1.get("images", []) if "bufferView" in im}
    for k, (v1, v2) in enumerate(zip(doc1.get("bufferViews", []), doc2.get("bufferViews", []))):
        if v1.get("buffer", 0) != 0 or blob1 is None:
            continue
        o1, l1 = v1.get("byteOffset", 0), v1["byteLength"]
        o2, l2 = v2.get("byteOffset", 0), v2["byteLength"]
        if (o1 - o2) % 16:
            return f"moved view {k} by {o1 - o2}, not a multiple of 16"
        if l1 != l2 or blob1[o1:o1 + l1] != blob2[o2:o2 + l2]:
            return f"view {k} bytes differ" + (" (an image)" if k in image_views else "")
    if layout == "Compact" and blob1 is not None and blob2 is not None and len(blob2) > len(blob1) + 3:
        return "grew"
    return None


# --- zips --------------------------------------------------------------------------------------------------------
def build_zip(entries: list[tuple[bytes, int, int, int]]) -> bytes:
    """A stored zip whose central directory says exactly what is asked: (raw name, flags, declared size, attrs)."""
    out, cd = bytearray(), bytearray()
    for name, flags, size, attr in entries:
        off = len(out)
        out += struct.pack("<IHHHHHIIIHH", 0x04034B50, 20, flags, 0, 0, 0, 0, 0, size & 0xFFFFFFFF, len(name), 0) + name
        cd += struct.pack("<IHHHHHHIIIHHHHHII", 0x02014B50, (3 << 8) | 20, 20, flags, 0, 0, 0, 0, 0, size & 0xFFFFFFFF,
                          len(name), 0, 0, 0, 0, attr, off) + name
    return bytes(out + cd + struct.pack("<IHHHHIIH", 0x06054B50, 0, 0, len(entries), len(entries), len(cd), len(out), 0))


ZIP_NAMES = ["chair.obj", "chair.mtl", "wood.png", "Wood.JPG", "a.jpeg", "x.exe", "notes.txt", "dir/", "dir/b.png", "../evil.obj",
             "a/../b.png", "/abs.obj", "\\win.obj", "a\\b.png", "C:x.obj", "__MACOSX/._chair.obj", "a/.DS_Store", ".obj", "a.obj/.",
             "a./", "a.", "", "é.png", "é:x.png", "dir/./c.mtl", "Ä.OBJ"]


def zip_corpus(rng: random.Random, scale: float) -> list[list[tuple[bytes, int, int, int]]]:
    file_attr, link_attr, dir_attr = 0o100644 << 16, 0o120777 << 16, 0o40755 << 16
    cases = [[(b"cube.obj", 0, 100, file_attr), (b"cube.mtl", 0, 50, file_attr), (b"tex/", 0, 0, dir_attr), (b"tex/w.png", 0, 9, file_attr)]]
    for _ in range(int(1500 * scale)):
        entries = []
        for _ in range(rng.randrange(0, 6)):
            name = rng.choice(ZIP_NAMES)
            r = rng.random()
            if r < 0.15:
                raw, flags = name.encode("utf-8"), 0x800
            elif r < 0.25:
                raw, flags = name.encode("utf-8") + bytes([rng.randrange(0x80, 0x100)]) + b".png", 0  # cp437 high byte
            elif r < 0.30:
                raw, flags = b"\xff\xfe" + name.encode(), 0x800  # flagged UTF-8, but isn't
            elif r < 0.35:
                raw, flags = name.encode() + b"\0.exe", 0
            else:
                raw, flags = name.encode("utf-8"), 0x800 if not name.isascii() else 0
            attr = rng.choice([file_attr, file_attr, dir_attr, link_attr, 0, rng.randrange(1 << 32)])
            size = rng.choice([0, 10, 300 * 1024 * 1024, 0xFFFFFFF0])
            entries.append((raw, flags, size, attr))
        cases.append(entries)
    cases.append([(b"m.obj", 0, 1, file_attr)] + [(f"t{i}.png".encode(), 0, 1, file_attr) for i in range(1000)])
    cases.append([(b"m.obj", 0, 1, file_attr)] + [(f"t{i}.png".encode(), 0, 1, file_attr) for i in range(999)])
    return cases


def compare_zip(t: Tally, cases: list, rust: Rust) -> None:
    rust_cases = []
    for entries in cases:
        names = ",".join("n" + n.hex() for n, *_ in entries)  # "n" keeps an empty name from vanishing
        fields = ",".join(f"{f}:{s}:{a}" for _, f, s, a in entries)
        rust_cases.append(("zip", [names.encode(), fields.encode()]))
    results = rust.run(rust_cases)
    for k, (entries, r) in enumerate(zip(cases, results)):
        p = OUT / "zip" / f"{k}.zip"
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(build_zip(entries))
        try:
            v1 = serve.zip_problem(p)
        except Exception as e:  # noqa: BLE001  v1 crashed
            v1 = f"crash: {type(e).__name__}"
        try:
            objzip.check(p)
            v1_pipeline = None
        except MidstudyError as e:
            v1_pipeline = str(e)
        except Exception as e:  # noqa: BLE001
            v1_pipeline = f"crash: {type(e).__name__}"
        v2 = None if r["ok"] else bytes.fromhex(r["message"]).decode()
        bad_name = (v2 or "").startswith("the zip holds a file name that can't be read") or str(v1).startswith("crash")
        reason = "zip-bad-name" if bad_name else None
        t.check("zip", f"zip {k} {entries[:4]}", v1, v2, reason)
        if not reason and (v1 is None) == (v2 is None) != (v1_pipeline is None):
            reason = "zip-v1-copies"  # serve.py and objzip.py disagreed; v2 sides with serve.py
        t.check("zip-pipeline", f"zip {k} {entries[:4]}", v1_pipeline is None, v2 is None, reason)




# --- strings -----------------------------------------------------------------------------------------------------
PATH_PIECES = ["/", "/", "/", "/", ".", "..", "%2e", "%2E", "%2f", "%2F", "%5c", "%5C", "%00", "planner", "library", "scenes",
               "renders", "Library", "PLANNER", "costs.csv", "library.json", "model.glb", "MODEL.GLB", "splat.ply", "splat.spz",
               "thumb.jpg", "photo.jpg", "depth.png", "source.jpg", "calib.json", "chair", "scene-20261104-201500", "x", "-",
               "?", "#", "%", "%%", "%4", "%C3%A9", "%C3", "%FF", "%e2%82", "é", "ÿ", "~", " ", ".env", ".git", "a-b",
               "api", "index.html", "%3F", "%23", "\\", "//", "...", ".trash", "raw", "Ab", "%41"]


def rand_path(rng: random.Random) -> str:
    s = "".join(rng.choice(PATH_PIECES) for _ in range(rng.randrange(1, 9)))
    return s if rng.random() < 0.1 else "/" + s.lstrip("/") if rng.random() < 0.5 else "/" + s


H = serve.Handler.__new__(serve.Handler)
H.scenes = types.SimpleNamespace(dir=Path("/S"))
H.library_dir = Path("/L")
H.renders_dir = Path("/R")
PLANNER = str(serve.REPO / "planner")


def v1_route(raw: str) -> str:
    """v1's decision for a GET of `raw`: http.server's // reduction, the / redirect, /api, hidden(), translate_path."""
    path = "/" + raw.lstrip("/") if raw.startswith("//") else raw
    if urlsplit(path).path == "/":
        return "redirect"
    H.path = path
    if H.api_path() is not None:
        return "api"
    if H.hidden():
        return "not-found"
    t = H.translate_path(path)
    if t.endswith("/.missing"):
        return "not-found"
    if t.startswith("/R/"):
        return "render:" + t[3:]
    if t.startswith("/S/"):
        return "scene:" + t[3:]
    if t == "/L/library.json":
        return "library-json"
    if t.startswith("/L/"):
        return "library:" + t[3:]
    if t == PLANNER or t.startswith(PLANNER + "/"):
        return "planner:" + t[len(PLANNER) + 1:]
    return "unexpected:" + t


def compare_strings(t: Tally, rng: random.Random, scale: float, rust: Rust) -> None:
    n = int(6000 * scale)
    # Paths: normalisation and the static route.
    paths = [rand_path(rng) for _ in range(n)] + ["/", "//", "///planner/", "/?x", "/#y", "//?x", "/planner", "/planner/",
                                                  "/./library/costs.csv", "/library/costs.csv", "/LIBRARY/library.json", ""]
    rn = rust.run([("normalize", [p]) for p in paths])
    rr = rust.run([("route", [p]) for p in paths])
    for p, a, b in zip(paths, rn, rr):
        v1 = serve.clean_path(p)
        v2 = bytes.fromhex(a["path"]).decode() if a["ok"] else None
        t.check("path-normalize", repr(p), v1, v2)
        r1 = v1_route(p)
        if r1 == "api":
            t.check("path-route", repr(p), "not-found", bytes.fromhex(b["route"]).decode().split(":")[0])
            continue
        r2 = bytes.fromhex(b["route"]).decode()
        if r2.startswith("planner:"):
            r2 = r2.rsplit(":", 1)[0]  # v1's translate_path has no trailing-slash notion: compare the path part
        t.check("path-route", repr(p), r1, r2)

    # Hosts (Latin-1, as HTTP headers are).
    pieces = ["127.0.0.1", "localhost", "LocalHost", "[::1]", "[", "]", ":", "8765", "80", "123456", "@", "evil.example", " ",
              "\t", "\xa0", "\x85", "\x1c", "homeserver", "HOMESERVER", "..", "-", "_", "/", "é", "[0:0:0:0:0:0:0:1]", "a", "1", "::",
              "f", "g", "x.y", "\n", "\x0b", "ÿ"]
    hosts = ["".join(rng.choice(pieces) for _ in range(rng.randrange(0, 5))) for _ in range(n)]
    rh = rust.run([("host", [h]) for h in hosts])
    for h, r in zip(hosts, rh):
        v2 = bytes.fromhex(r["name"]).decode() if r["name"] is not None else ""
        t.check("host", repr(h), serve.host_name(h), v2)

    # Content-Length values.
    pieces = ["0", "1", "9", "12", "999999999999999", "1000000000000000", " ", "\t", "\xa0", "\x85", "+", "-", "²", "١", "0x",
              "e", ".", "_", "\x1f", "\x0b"]
    clens = ["".join(rng.choice(pieces) for _ in range(rng.randrange(0, 4))) for _ in range(n)]
    rc = rust.run([("clen", [c]) for c in clens])
    for c, r in zip(clens, rc):
        s = c.strip()
        v1 = int(s) if serve.CONTENT_LENGTH.fullmatch(s) else None
        t.check("content-length", repr(c), v1, r["n"] if r["ok"] else None)

    # The Origin rule (§2.9 Forged requests), through v1's own forged().
    H.error_json = lambda *a, **k: None
    combos = []
    for x in (None, "1", "1 ", "true", "", " 1"):
        for origin in (None, "http://127.0.0.1:8765", "https://127.0.0.1:8765", "http://evil", "null", "http://LOCALHOST:8765", ""):
            for host in (None, "", "127.0.0.1:8765", "localhost:8765", "LOCALHOST:8765"):
                combos.append((x, origin, host))
    ro = rust.run([("origin", [x, o, h]) for x, o, h in combos])
    for (x, o, h), r in zip(combos, ro):
        H.headers = {k: v for k, v in (("X-Midstudy", x), ("Origin", o), ("Host", h)) if v is not None}
        t.check("origin", repr((x, o, h)), not H.forged(), r["ok"])

    # Slugs and v1's name order.
    alphabet = "abz09-_A\n. é"
    slugs = ["".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 70))) for _ in range(n)]
    slugs += ["a" * 64, "a" * 65, "evil\n", "-a", "a-", "0"]
    rs = rust.run([("slug", [s]) for s in slugs])
    for s, r in zip(slugs, rs):
        t.check("slug", repr(s), bool(serve.SLUG.match(s)), r["slug"])
    names = []
    for _ in range(n // 3):
        stamp = f"{rng.randrange(10**8):08d}-{rng.randrange(10**6):06d}"
        name = rng.choice(["scene-", "render-", "x-", ""]) + stamp + rng.choice(["", "", f"-{rng.randrange(30)}", "-0" * 3, "-", "x",
                                                                                   "-" + stamp, f"-{rng.randrange(10**30)}"])
        names.append(name[:64] if rng.random() < 0.8 else name)
    names += ["lounge", "a", "12345678-123456", "x-12345678-123456-12345678-123456"]
    ro = rust.run([("order", [s]) for s in names])
    for s, r in zip(names, ro):
        base, num = serve.name_order(s)
        t.check("name-order", repr(s), (base, num), (bytes.fromhex(r["base"]).decode(), int(r["number"])))

    # Base64 (CPython strict and lenient), X-Midstudy-Meta, and v1's image data URIs.
    alphabet = "QUJDRA+/=\n é\x00-_w=="
    b64s = ["".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 24))) for _ in range(n)]
    b64s += [base64.b64encode(os.urandom(k)).decode() for k in range(40)]
    rs_strict = rust.run([("b64-strict", [s.encode("utf-8")]) for s in b64s])
    rs_lenient = rust.run([("b64-lenient", [s.encode("utf-8")]) for s in b64s])
    for s, a, b in zip(b64s, rs_strict, rs_lenient):
        raw = s.encode("utf-8")
        for strict, r in ((True, a), (False, b)):
            try:
                v1 = base64.b64decode(raw, validate=strict)
            except (binascii.Error, ValueError):
                v1 = None
            t.check("base64-strict" if strict else "base64-lenient", repr(s), v1, bytes.fromhex(r["hex"]) if r["ok"] else None)
    metas = b64s + [base64.b64encode(json.dumps({"title": "Lounge é"}).encode()).decode(), base64.b64encode(b"\xff\xfe").decode(),
                    "eyJ0aXRsZSI6ICJMb3VuZ2UifQ==", "eyJ0aXRsZSI6ICJMb3VuZ2UifQ", "é"]
    rm = rust.run([("meta", [m]) for m in metas])
    for m, r in zip(metas, rm):
        try:
            v1 = base64.b64decode(m, validate=True).decode("utf-8")
        except (binascii.Error, ValueError, UnicodeDecodeError):
            v1 = None
        t.check("meta", repr(m), v1, bytes.fromhex(r["hex"]).decode() if r["ok"] else None)
    prefixes = ["data:image/jpeg;base64,", "data:image/jpg;base64,", "data:image/png;base64,", "DATA:image/jpeg;base64,",
                "data:image/jpe;base64,", "data:image/jpeg;base64", "data:image/jpeg,"]
    alphabet = "QUJD/9j+=\n 　  ᠎​\x0b\x1cé\x85 "
    uris = [rng.choice(prefixes) + "".join(rng.choice(alphabet) for _ in range(rng.randrange(0, 16))) for _ in range(n)]
    for kind in ("jpeg", "png"):
        ru = rust.run([(f"datauri-{kind}", [u]) for u in uris])
        for u, r in zip(uris, ru):
            v1 = serve.decode_data_uri(u, (kind,))
            t.check("data-uri", repr(u), v1, bytes.fromhex(r["hex"]) if r["ok"] else None)

    # Code page 437 (zip names without the UTF-8 flag).
    r = rust.run([("cp437", [bytes(range(256))])])[0]
    t.check("cp437", "all bytes", bytes(range(256)).decode("cp437"), bytes.fromhex(r["text"]).decode())


# --- bytes: sniff, JPEG, PNG -------------------------------------------------------------------------------------
def v1_passthrough(data: bytes):
    """ingest()'s decision: True (copied byte for byte), False (re-encoded) or "fail" (the ingest fails)."""
    if ingest.sniff(data[:64]) != "jpg" or not ingest.is_clean_jpeg(data):
        return False
    Image_ = ingest._pil()
    try:
        with Image_.open(io.BytesIO(data)) as im:
            w, h, mode = im.size[0], im.size[1], im.mode
            if w * h > ingest.MAX_PIXELS:
                return "fail"
            if max(w, h) <= ingest.LONG_SIDE and mode in ("RGB", "L"):
                im.load()
                return mode == "RGB"
            return False
    except Exception:  # noqa: BLE001
        return "fail"


def ftyp_corpus(rng: random.Random, n: int) -> list[bytes]:
    brands = [b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs", b"mif1", b"msf1", b"mif2", b"miaf", b"avif",
              b"avis", b"isom", b"mp41", b"jpeg", b"crx "]
    out = []
    for _ in range(n):
        major = rng.choice(brands) if rng.random() < 0.9 else os.urandom(4)
        compat = b"".join(rng.choice(brands) for _ in range(rng.randrange(0, 14)))
        size = rng.choice([16 + len(compat), rng.randrange(0, 80), 0xFFFFFFFF])
        box = struct.pack(">I", size) + b"ftyp" + major + b"\0\0\0\0" + compat
        out.append(box[: rng.randrange(8, len(box) + 1)] if rng.random() < 0.2 else box + os.urandom(rng.randrange(0, 40)))
    return out


def compare_bytes(t: Tally, rng: random.Random, scale: float, rust: Rust) -> tuple[list[bytes], list[bytes]]:
    small, big = jpeg_corpus(rng, scale)
    pngs = png_corpus(rng, scale)
    # Sniff: every file, plus ftyp boxes, RIFF and short heads.
    heads = [b for _, b in small] + [b for _, b in pngs] + ftyp_corpus(rng, int(3000 * scale))
    heads += [b"RIFF\0\0\0\0WEBP", b"RIFF\0\0\0\0WEBQ", b"\xff\xd8", b"\xff\xd8\xff", b"", b"glTF", b"PK\x03\x04", b"\x89PNG\r\n\x1a"]
    rs = rust.run([("sniff", [h[:200]]) for h in heads])
    to_calib = {"jpeg": "jpg", "png": "png", "webp": "webp", "heic": "heic", "heif": "heic"}
    to_serve = {"jpg": "jpeg", "png": "png", "webp": "webp", "heic": "heic", None: None}
    for h, r in zip(heads, rs):
        v1_calib = ingest.sniff(h[:64])
        v2 = to_calib.get(r["kind"])
        t.check("sniff-calib", h[:24].hex(), v1_calib, v2)
        v1_serve = serve.image_kind(h[:16])
        reason = None
        if v1_serve != to_serve[v2]:
            major = h[8:12]
            reason = "sniff-avif" if v1_serve == "heic" and v2 is None and major in (b"mif1", b"msf1") else \
                "sniff-brands" if v1_serve is None and v2 == "heic" and major in (b"hevm", b"hevs", b"mif2", b"miaf") else None
        t.check("sniff-serve", h[:24].hex(), v1_serve, to_serve[v2], reason)

    # JPEG: strip (both v1 copies), frame size, clean predicate, pass-through.
    cases = [(n, b) for n, b in small] + [(n, p) for n, p in big]
    data_of = lambda x: x.read_bytes() if isinstance(x, Path) else x  # noqa: E731
    r_strip = rust.run([("jpeg-strip", [x]) for _, x in cases])
    r_size = rust.run([("jpeg-size", [x]) for _, x in cases])
    r_clean = rust.run([("jpeg-clean", [x]) for _, x in cases])
    r_pass = rust.run([("jpeg-pass", [x]) for _, x in cases])
    for (name, x), a, b, c, d in zip(cases, r_strip, r_size, r_clean, r_pass):
        data = data_of(x)
        v1 = serve.clean_jpeg(data)
        if pglb.clean_jpeg(data) != v1:
            t.fail("jpeg-v1-copies", name, "serve.clean_jpeg", "pipeline clean_jpeg differs")
        t.check("jpeg-strip", name, v1, rust.data(a) if a["ok"] else None)
        t.check("jpeg-size", name, serve.jpeg_size(data), (b["w"], b["h"]) if b["ok"] else None)
        t.check("jpeg-clean", name, ingest.is_clean_jpeg(data), c["clean"])
        v1p = v1_passthrough(data)
        v2p = d["ok"]
        if v1p == "fail":
            t.check("jpeg-passthrough", name, False, v2p, "pass-decode" if v2p else None)
        else:
            t.check("jpeg-passthrough", name, v1p, v2p)

    # PNG: strip and IHDR size.
    r_strip = rust.run([("png-strip", [b]) for _, b in pngs])
    r_size = rust.run([("png-size", [b]) for _, b in pngs])
    for (name, data), a, b in zip(pngs, r_strip, r_size):
        t.check("png-strip", name, pglb.clean_png(data), rust.data(a) if a["ok"] else None)
        v1 = serve.png_size(data)
        t.check("png-size", name, tuple(v1) if v1 else None, (b["w"], b["h"]) if b["ok"] else None)

    # Privacy, independently of v1: what v2 writes for the GPS-canary files carries no metadata at all.
    canaries = [(n, x) for n, x in cases if n in ("gps-jpeg", "trailing-gps", "prog-midscan-gps", "zero-pad", "jfxx-gps",
                                                    "big12mp-gps-prog", "pillow0-exif", "xmp", "pillow0-com", "pillow0-icc")]
    for (name, x), r in zip(canaries, rust.run([("jpeg-strip", [x]) for _, x in canaries])):
        privacy_check(t, name, rust.data(r), ".jpg")
    canaries = [(n, b) for n, b in pngs if n in ("gps-png", "png0-text", "png0-exif", "time", "after-iend")]
    for (name, b), r in zip(canaries, rust.run([("png-strip", [b]) for _, b in canaries])):
        privacy_check(t, name, rust.data(r), ".png")

    jpeg_textures = [b for n, b in small if n in ("gps-jpeg", "pillow0", "pillow0-exif", "jfxx-gps", "trailing-gps", "pillow1-com")]
    png_textures = [b for n, b in pngs if n in ("gps-png", "png0", "png0-text", "time", "after-iend")]
    return jpeg_textures, png_textures


def privacy_check(t: Tally, name: str, data: bytes, ext: str) -> None:
    """evals/lib/metadata.py's inspect (the privacy evals' own check) on what v2 wrote: no canary, EXIF, GPS, APPn, COM,
    JFXX or thumbnail, nothing after EOI, no eXIf/tEXt/iTXt/zTXt."""
    f = OUT / "privacy" / f"{name}{ext}"
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_bytes(data)
    report = metadata.inspect(f)
    t.check("privacy", name, True, bool(report.get("clean")) and (ext != ".png" or "tIME" not in report.get("png_chunks", [])))


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--difftool", type=Path, default=REPO / "core" / "target" / "release" / "examples" / "difftool")
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--scale", type=float, default=1.0, help="multiplies the number of random cases")
    a = ap.parse_args()
    if not a.difftool.exists():
        print(f"diff_v1: build the Rust side first: (cd core && cargo build --release --example difftool -p midstudy-media)")
        return 2
    shutil.rmtree(OUT / "glb", ignore_errors=True)
    shutil.rmtree(OUT / "zip", ignore_errors=True)
    shutil.rmtree(OUT / "bin", ignore_errors=True)
    (OUT / "bin").mkdir(parents=True, exist_ok=True)
    rng = random.Random(a.seed)
    rust = Rust(a.difftool.resolve(), OUT / "bin")
    t = Tally()
    jpegs, pngs = compare_bytes(t, rng, a.scale, rust)
    compare_glb(t, glb_corpus(rng, a.scale, jpegs, pngs), rust)
    compare_zip(t, zip_corpus(rng, a.scale), rust)
    compare_strings(t, rng, a.scale, rust)
    total = sum(x["cases"] for x in t.areas.values())
    print(f"diff_v1 (seed {a.seed}, scale {a.scale}): {total} cases")
    ok = t.report()
    print("diff_v1: " + ("ok, every difference is an expected one" if ok else "FAIL, unexpected differences above"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
