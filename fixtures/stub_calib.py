#!/usr/bin/env python3
"""Stand-in for `midstudy-calib` (contract §4.3), Python stdlib only. Same CLI and stdout contract; no MoGe, no Pillow.

    stub_calib.py run <upload> --out <scene-dir> [--model vitl|vitb|vits] [--device auto|cuda|mps|cpu] [--no-depth]
    stub_calib.py ingest <upload> --out <scene-dir>
    stub_calib.py fit <scene-dir> [--model ...] [--device ...] [--no-depth]
    stub_calib.py align <photo.jpg> <raw.jpg> <mask.png> --out <final.jpg>

- ingest: JPEG only (PNG, HEIC and WebP are refused with a clear message: the stub can't decode them). Copies the
  upload to source.jpg and writes photo.jpg with every metadata segment removed (APP1-APP15, COM: EXIF, GPS, XMP, ICC),
  so a clean JPEG (JFIF only, like the golden scenes) is copied byte for byte. It can't rotate, resize or convert
  colour: a photo with an EXIF orientation other than 1 is refused; a larger photo or an ICC profile only warns.
- fit: with MIDSTUDY_CALIB_MOCK=<dir> (e.g. fixtures/calib), copies <dir>/<sha256 of photo.jpg>/calib.json and
  depth.png (falling back to the SHA-256 of source.<ext>); otherwise writes the "default" fallback (FOV 55,
  height 1.40, pitch -10, no depth, floor not found). EXIF facts are read from source.<ext>.
- align: the stub can't register images: it writes nothing and answers applied: false (exit 0).

stdout: one JSON line (run/fit: calib.json plus "ok": true; ingest: {ok, photo, source, image}; align: {ok, applied,
inliers, residual_px, reason}). Progress goes to stderr. A failure exits 1 with `{"ok": false, "error": ...}` on stdout
and `midstudy-calib: <one sentence>` as the last stderr line.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import shutil
import struct
import sys
import tempfile
import time
from pathlib import Path

MAX_BYTES = 25 * 1024 * 1024
DEFAULT_CAMERA = {"fov_y_deg": 55.0, "height_m": 1.40, "pitch_deg": -10.0, "roll_deg": 0.0}
SOF = {0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF}


class Fail(Exception):
    pass


def log(msg: str) -> None:
    print(f"stub-calib: {msg}", file=sys.stderr, flush=True)


def sniff(data: bytes) -> str | None:
    if data[:3] == b"\xff\xd8\xff":
        return "jpg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return "webp"
    if data[4:8] == b"ftyp" and data[8:12] in (b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1", b"heim", b"heis", b"avif"):
        return "heic"
    return None


def segments(data: bytes):
    """(marker, payload) for each JPEG segment up to SOS; payload excludes the length bytes."""
    i = 2
    while i + 4 <= len(data):
        if data[i] != 0xFF:
            raise Fail("the JPEG is corrupt (bad segment marker)")
        m = data[i + 1]
        if m == 0xFF:  # fill byte
            i += 1
            continue
        if m == 0xDA:
            return
        n = struct.unpack(">H", data[i + 2:i + 4])[0]
        yield m, i, data[i + 4:i + 2 + n]
        i += 2 + n
    raise Fail("the JPEG is truncated (no image data)")


def jpeg_size(data: bytes) -> tuple[int, int]:
    for m, _, p in segments(data):
        if m in SOF:
            h, w = struct.unpack(">HH", p[1:5])
            if w and h:
                return w, h
    raise Fail("the JPEG has no frame header, so its size is unknown")


def strip_metadata(data: bytes) -> tuple[bytes, list[str]]:
    """Drop APP1-APP15 and COM segments; keep SOI, APP0 (JFIF) and everything from the image data on."""
    out, dropped, end = [data[:2]], [], 2
    for m, start, p in segments(data):
        end = start + 4 + len(p)
        if 0xE1 <= m <= 0xEF or m == 0xFE:
            dropped.append({0xE1: "EXIF/XMP", 0xE2: "ICC", 0xED: "IPTC", 0xFE: "comment"}.get(m, f"APP{m - 0xE0}"))
        else:
            out.append(data[start:end])
    out.append(data[end:])
    return b"".join(out), dropped


def exif_facts(data: bytes) -> dict | None:
    """Orientation, make, model and focal lengths from a JPEG's EXIF (APP1 'Exif\\0\\0' + TIFF), or None."""
    for m, _, p in segments(data):
        if m != 0xE1 or not p.startswith(b"Exif\x00\x00"):
            continue
        t = p[6:]
        if len(t) < 8:
            return None
        e = "<" if t[:2] == b"II" else ">"
        u16 = lambda o: struct.unpack(e + "H", t[o:o + 2])[0]
        u32 = lambda o: struct.unpack(e + "I", t[o:o + 4])[0]
        sizes = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8}

        def ifd(off: int) -> dict:
            tags = {}
            if off + 2 > len(t):
                return tags
            for k in range(u16(off)):
                o = off + 2 + 12 * k
                if o + 12 > len(t):
                    break
                tag, typ, cnt = u16(o), u16(o + 2), u32(o + 4)
                size = sizes.get(typ, 1) * cnt
                vo = o + 8 if size <= 4 else u32(o + 8)
                if vo + size > len(t):
                    continue
                if typ == 2:
                    tags[tag] = t[vo:vo + cnt].split(b"\x00")[0].decode("ascii", "replace").strip()
                elif typ == 3:
                    tags[tag] = u16(vo)
                elif typ == 4:
                    tags[tag] = u32(vo)
                elif typ == 5:
                    num, den = u32(vo), u32(vo + 4)
                    tags[tag] = num / den if den else None
            return tags

        try:
            ifd0 = ifd(u32(4))
            sub = ifd(ifd0[0x8769]) if 0x8769 in ifd0 else {}
        except struct.error:
            return None
        return {"orientation": ifd0.get(0x0112, 1), "make": ifd0.get(0x010F), "model": ifd0.get(0x0110),
                "focal_35mm": sub.get(0xA405) or None, "focal_mm": sub.get(0x920A)}
    return None


def fov_from_35mm(f35: float, w: int, h: int) -> float:
    """Vertical FOV (degrees) from a 35 mm equivalent focal length (contract §4.3): the equivalent refers to the
    diagonal of the sensor's native 4:3 frame (43.27 mm, like 36 x 24); the photo is the largest crop of that frame
    with its own aspect."""
    diag = math.hypot(36, 24)
    long43, short43 = diag * 4 / 5, diag * 3 / 5
    long_px, short_px = max(w, h), min(w, h)
    if long_px / short_px >= 4 / 3:  # wider than 4:3 (16:9): the crop keeps the long side
        long_mm, short_mm = long43, long43 * short_px / long_px
    else:  # squarer than 4:3: the crop keeps the short side
        short_mm, long_mm = short43, short43 * long_px / short_px
    v_mm = short_mm if h <= w else long_mm
    return math.degrees(2 * math.atan(v_mm / (2 * f35)))


def write_atomic(path: Path, data: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def source_file(scene: Path) -> Path | None:
    found = sorted(scene.glob("source.*"))
    return found[0] if found else None


# --- commands ------------------------------------------------------------------------------------------------------
def ingest(upload: Path, out: Path) -> dict:
    if not upload.is_file():
        raise Fail(f"{upload} doesn't exist")
    if upload.stat().st_size > MAX_BYTES:
        raise Fail(f"the photo is {upload.stat().st_size / 2**20:.1f} MB; the limit is 25 MB")
    data = upload.read_bytes()
    kind = sniff(data)
    if kind is None:
        raise Fail("that file isn't a JPEG, PNG, HEIC or WebP image")
    if kind != "jpg":
        raise Fail(f"the stub (fixtures/stub_calib.py) only takes JPEG photos; {kind.upper()} needs the real midstudy-calib (calib/)")
    exif = exif_facts(data)
    if exif and exif["orientation"] not in (None, 1):
        raise Fail(f"the photo has EXIF orientation {exif['orientation']} (rotated), which the stub can't apply; use the real midstudy-calib (calib/)")
    w, h = jpeg_size(data)
    photo, dropped = strip_metadata(data)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("source.*"):
        old.unlink()
    write_atomic(out / "source.jpg", data)
    write_atomic(out / "photo.jpg", photo)
    if dropped:
        log(f"removed from photo.jpg: {', '.join(dropped)}" + (" (colours not converted to sRGB: stub)" if "ICC" in dropped else ""))
    if max(w, h) > 2048:
        log(f"photo.jpg keeps the upload's {w} x {h}: the stub can't downsize to 2048 px")
    log(f"ingest: {upload.name} -> {out}/photo.jpg ({w} x {h})")
    return {"ok": True, "photo": "photo.jpg", "source": "source.jpg", "image": {"w": w, "h": h}}


def fit(scene: Path, no_depth: bool) -> dict:
    t0 = time.monotonic()
    photo = scene / "photo.jpg"
    if not photo.is_file():
        raise Fail(f"{photo} doesn't exist: run ingest first")
    data = photo.read_bytes()
    w, h = jpeg_size(data)
    src = source_file(scene)
    facts = exif_facts(src.read_bytes()) if src and src.suffix == ".jpg" else None
    exif = None
    if facts and (facts["focal_35mm"] or facts["make"] or facts["model"]):
        f35 = facts["focal_35mm"]
        exif = {"focal_35mm": f35, "fov_y_deg": round(fov_from_35mm(f35, w, h), 2) if f35 else None,
                "make": facts["make"], "model": facts["model"]}

    mock = os.environ.get("MIDSTUDY_CALIB_MOCK")
    calib = None
    if mock:
        keys = [hashlib.sha256(data).hexdigest()] + ([hashlib.sha256(src.read_bytes()).hexdigest()] if src else [])
        for key in keys:
            d = Path(mock) / key
            if (d / "calib.json").is_file():
                calib = json.loads((d / "calib.json").read_text())
                log(f"fit: MIDSTUDY_CALIB_MOCK hit {d}")
                if (calib.get("image") or {}) != {"w": w, "h": h}:
                    log(f"warning: the mock's image size {calib.get('image')} isn't photo.jpg's {w} x {h}")
                has_depth = (d / "depth.png").is_file() and calib.get("depth") and not no_depth
                if has_depth:
                    shutil.copyfile(d / "depth.png", scene / ".depth.png.tmp")
                    os.replace(scene / ".depth.png.tmp", scene / "depth.png")
                else:
                    calib["depth"] = None
                break
        else:
            log(f"fit: no mock for photo.jpg in {mock}: writing the default fallback")
    if calib is None:
        calib = {"version": 1, "source": "default", "model": None, "image": {"w": w, "h": h}, "camera": dict(DEFAULT_CAMERA),
                 "principal": [0.5, 0.5], "floor": {"found": False, "inlier_ratio": None, "rmse_m": None},
                 "depth": None, "exif": exif, "device": None, "elapsed_s": 0}
    if calib.get("depth") is None and (scene / "depth.png").exists():
        (scene / "depth.png").unlink()
    calib["elapsed_s"] = round(time.monotonic() - t0, 3)
    write_atomic(scene / "calib.json", (json.dumps(calib, indent=2) + "\n").encode())
    return {**calib, "ok": True}


def main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(prog="midstudy-calib", description="stand-in for midstudy-calib (fixtures/stub_calib.py)")
    sub = ap.add_subparsers(dest="cmd", required=True)
    model = dict(choices=["vitl", "vitb", "vits"], default="vitl")
    device = dict(choices=["auto", "cuda", "mps", "cpu"], default="auto")
    p = sub.add_parser("run"); p.add_argument("upload", type=Path); p.add_argument("--out", type=Path, required=True)
    p.add_argument("--model", **model); p.add_argument("--device", **device); p.add_argument("--no-depth", action="store_true")
    p = sub.add_parser("ingest"); p.add_argument("upload", type=Path); p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("fit"); p.add_argument("scene", type=Path)
    p.add_argument("--model", **model); p.add_argument("--device", **device); p.add_argument("--no-depth", action="store_true")
    p = sub.add_parser("align"); p.add_argument("photo", type=Path); p.add_argument("raw", type=Path); p.add_argument("mask", type=Path)
    p.add_argument("--out", type=Path, required=True)
    args = ap.parse_args(argv)
    try:
        if args.cmd == "run":
            ingest(args.upload, args.out)
            result = fit(args.out, args.no_depth)
        elif args.cmd == "ingest":
            result = ingest(args.upload, args.out)
        elif args.cmd == "fit":
            result = fit(args.scene, args.no_depth)
        else:
            for f in (args.photo, args.raw, args.mask):
                if not f.is_file():
                    raise Fail(f"{f} doesn't exist")
            result = {"ok": True, "applied": False, "inliers": 0, "residual_px": None,
                      "reason": "the stub can't register images; use the real midstudy-calib (calib/) for keep-room"}
    except Fail as e:
        print(json.dumps({"ok": False, "error": str(e)}), flush=True)
        print(f"midstudy-calib: {e}", file=sys.stderr, flush=True)
        return 1
    print(json.dumps(result), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
