"""`midstudy-calib ingest` (contract §4.3): the upload becomes source.<ext> (as given) and photo.jpg (normalized).

photo.jpg: EXIF orientation applied, converted to sRGB with the embedded ICC profile, long side <= 2048 px, JPEG q92,
no metadata at all (no EXIF, GPS, XMP, ICC or comment), because it is served and sent to fal. A JPEG that needs none
of that is passed through byte for byte, so its SHA-256 stays the upload's (the golden scenes' mock relies on it).
"""
from __future__ import annotations

import io
import math
import warnings
from pathlib import Path

from .util import Fail, log, write_atomic

MAX_BYTES = 25 * 1024 * 1024
MAX_PIXELS = 100_000_000  # decoded size cap: a 25 MB PNG/WebP can claim a huge canvas (decompression bomb)
LONG_SIDE = 2048
QUALITY = 92
NOT_AN_IMAGE = "that file isn't a JPEG, PNG, HEIC or WebP image"

HEIF_BRANDS = {b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs"}
GENERIC_HEIF_BRANDS = {b"mif1", b"msf1", b"mif2", b"miaf"}
AVIF_BRANDS = {b"avif", b"avis"}


def _pil():
    """Pillow, set up with the HEIF opener and the decompression-bomb guard (imported lazily: `fit` mock and
    `align` don't need it)."""
    from PIL import Image

    try:
        import pillow_heif

        pillow_heif.register_heif_opener()
    except ImportError:  # pragma: no cover - a declared dependency
        log("pillow-heif is missing: HEIC uploads can't be decoded")
    Image.MAX_IMAGE_PIXELS = MAX_PIXELS
    warnings.simplefilter("error", Image.DecompressionBombWarning)
    return Image


def sniff(head: bytes) -> str | None:
    """The image type from its first bytes: jpg, png, webp, heic, or None (anything else, AVIF included)."""
    if head[:3] == b"\xff\xd8\xff":
        return "jpg"
    if head[:8] == b"\x89PNG\r\n\x1a\n":
        return "png"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return "webp"
    if head[4:8] == b"ftyp" and len(head) >= 12:
        size = int.from_bytes(head[:4], "big")
        major = head[8:12]
        compat = {head[i:i + 4] for i in range(16, min(size, len(head)) - 3, 4)}
        if major in HEIF_BRANDS:
            return "heic"
        if major in GENERIC_HEIF_BRANDS and not (compat & AVIF_BRANDS and not compat & HEIF_BRANDS):
            return "heic"  # HEIF with a generic major brand (some Android phones); AVIF-only files are refused
    return None


def jpeg_walk(data: bytes) -> tuple[list[int], int] | None:
    """Every segment marker in the whole JPEG (before the first scan, between progressive scans, after the last one)
    and the offset just past its end-of-image marker; None when the structure is broken or there is no EOI. The
    entropy-coded data after each SOS runs to the next marker (FF 00 is a stuffed byte, FF D0-D7 a restart)."""
    n = len(data)
    if n < 4 or data[:2] != b"\xff\xd8":
        return None
    i, markers = 2, []
    while i < n:
        if data[i] != 0xFF:
            return None
        while i < n and data[i] == 0xFF:  # fill bytes
            i += 1
        if i >= n:
            return None
        m = data[i]
        i += 1
        if m == 0xD9:
            return markers, i
        if 0xD0 <= m <= 0xD7 or m == 0x01:
            continue
        if m == 0x00 or i + 2 > n:
            return None
        length = int.from_bytes(data[i:i + 2], "big")
        if length < 2 or i + length > n:
            return None
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


def jpeg_markers(data: bytes) -> list[int] | None:
    """All segment markers of the JPEG (see jpeg_walk), or None when its structure is broken."""
    walk = jpeg_walk(data)
    return walk[0] if walk else None


def is_clean_jpeg(data: bytes) -> bool:
    """Only JFIF/APP0 and coding segments anywhere in the file (no APP1-APP15: EXIF, XMP, ICC, MPF, Adobe, IPTC; no
    comment), even between progressive scans, and not a single byte after the end-of-image marker (an appended second
    JPEG, as MPF writes one, carries its own EXIF and GPS; zero padding is refused too)."""
    walk = jpeg_walk(data)
    if walk is None:
        return False
    markers, end = walk
    if any(0xE1 <= m <= 0xEF or m == 0xFE for m in markers):
        return False
    return end == len(data)


def exif_facts(path: Path) -> dict | None:
    """Orientation, make, model and focal lengths from an image file's EXIF, or None without EXIF."""
    Image = _pil()
    try:
        with Image.open(path) as im:
            exif = im.getexif()
            if not exif:
                return None
            sub = exif.get_ifd(0x8769)
    except Exception as e:  # unreadable EXIF is not fatal
        log(f"couldn't read EXIF from {path.name}: {e}")
        return None

    def num(v):
        try:
            v = float(v)
        except (TypeError, ValueError):
            return None
        return v if math.isfinite(v) and v > 0 else None

    def text(v):
        if isinstance(v, bytes):
            v = v.decode("ascii", "replace")
        return v.strip("\x00 ").strip() or None if isinstance(v, str) else None

    return {"orientation": exif.get(0x0112, 1), "make": text(exif.get(0x010F)), "model": text(exif.get(0x0110)),
            "focal_35mm": num(sub.get(0xA405)), "focal_mm": num(sub.get(0x920A))}


def fov_from_35mm(f35: float, w: int, h: int) -> float:
    """Vertical FOV in degrees from a 35 mm equivalent focal length (contract §4.3).

    The equivalent refers to the diagonal of the sensor's native 4:3 frame (the full-frame diagonal, 43.27 mm, so a
    34.61 x 25.96 mm frame). The photo is the largest crop of that frame with the photo's aspect: wider than 4:3
    (16:9) keeps the long side, squarer keeps the short side."""
    diag = math.hypot(36, 24)
    long43, short43 = diag * 4 / 5, diag * 3 / 5
    long_px, short_px = max(w, h), min(w, h)
    if long_px / short_px >= 4 / 3:
        long_mm, short_mm = long43, long43 * short_px / long_px
    else:
        short_mm, long_mm = short43, short43 * long_px / short_px
    v_mm = short_mm if h <= w else long_mm
    return math.degrees(2 * math.atan(v_mm / (2 * f35)))


def exif_block(scene: Path, w: int, h: int) -> dict | None:
    """calib.json's `exif` from source.<ext> (photo.jpg has none), with the FOV for photo.jpg's w x h."""
    from .util import source_file

    src = source_file(scene)
    facts = exif_facts(src) if src else None
    if not facts or not (facts["focal_35mm"] or facts["make"] or facts["model"]):
        return None
    f35 = facts["focal_35mm"]
    return {"focal_35mm": f35, "fov_y_deg": round(fov_from_35mm(f35, w, h), 2) if f35 else None,
            "make": facts["make"], "model": facts["model"]}


def _to_srgb_rgb(im):
    """Any decoded mode -> 8-bit sRGB RGB: alpha flattened on white, ICC profile converted, high bit depths scaled."""
    from PIL import Image, ImageCms

    icc = im.info.get("icc_profile")
    if im.mode in ("I;16", "I;16B", "I;16L", "I", "F"):  # 16-bit (or float) greyscale PNG
        import numpy as np

        a = np.asarray(im, dtype=np.float64)
        a = a / 257.0 if a.max() > 255 else a
        im = Image.fromarray(np.clip(np.rint(a), 0, 255).astype(np.uint8), "L")
    if im.mode == "P":
        im = im.convert("RGBA" if "transparency" in im.info else "RGB")
    if im.mode in ("RGBA", "LA", "PA", "RGBa", "La"):
        rgba = im.convert("RGBA")
        bg = Image.new("RGBA", rgba.size, (255, 255, 255, 255))
        im = Image.alpha_composite(bg, rgba).convert("RGB")
    if icc:
        try:
            src = ImageCms.ImageCmsProfile(io.BytesIO(icc))
            dst = ImageCms.createProfile("sRGB")
            desc = (ImageCms.getProfileDescription(src) or "").strip()
            if im.mode not in ("RGB", "L", "CMYK"):
                im = im.convert("RGB")
            im = ImageCms.profileToProfile(im, src, dst, renderingIntent=ImageCms.Intent.PERCEPTUAL, outputMode="RGB")
            log(f"converted colours from '{desc or 'embedded profile'}' to sRGB")
        except Exception as e:
            log(f"couldn't apply the embedded colour profile ({e}); treating the photo as sRGB")
    if im.mode != "RGB":
        im = im.convert("RGB")
    return im


def normalize(data: bytes, kind: str) -> tuple[bytes, int, int, list[str]]:
    """Decode, orient, convert to sRGB, downsize and re-encode without metadata. Returns (jpeg, w, h, notes)."""
    Image = _pil()
    from PIL import ImageOps

    notes: list[str] = []
    try:
        im = Image.open(io.BytesIO(data))
    except Image.DecompressionBombError:
        raise Fail(f"the photo is larger than {MAX_PIXELS // 1_000_000} megapixels, which is more than midstudy handles")
    except Image.DecompressionBombWarning:
        raise Fail(f"the photo is larger than {MAX_PIXELS // 1_000_000} megapixels, which is more than midstudy handles")
    except Exception:
        raise Fail(NOT_AN_IMAGE if kind != "heic" else "the HEIC photo couldn't be decoded")
    w0, h0 = im.size
    if w0 * h0 > MAX_PIXELS:
        raise Fail(f"the photo is larger than {MAX_PIXELS // 1_000_000} megapixels, which is more than midstudy handles")
    if not w0 or not h0:
        raise Fail("the photo has no pixels")
    icc = im.info.get("icc_profile")
    # Big JPEGs: let the decoder scale down by a power of two first (fast, still above the target size).
    if kind == "jpg" and im.mode in ("RGB", "L") and max(w0, h0) > 2 * LONG_SIDE:
        s = LONG_SIDE / max(w0, h0)
        im.draft(im.mode, (math.ceil(w0 * s), math.ceil(h0 * s)))
    try:
        im.load()
    except Exception as e:
        raise Fail(f"the photo is damaged or truncated and couldn't be decoded ({type(e).__name__})")
    if icc and "icc_profile" not in im.info:
        im.info["icc_profile"] = icc
    orientation = im.getexif().get(0x0112, 1) if hasattr(im, "getexif") else 1
    if orientation not in (None, 1):
        notes.append(f"applied EXIF orientation {orientation}")
    info = dict(im.info)
    im = ImageOps.exif_transpose(im) or im
    im.info.update({k: v for k, v in info.items() if k == "icc_profile"})
    im = _to_srgb_rgb(im)
    w, h = im.size
    if max(w, h) > LONG_SIDE:
        s = LONG_SIDE / max(w, h)
        size = (LONG_SIDE, max(1, round(h * s))) if w >= h else (max(1, round(w * s)), LONG_SIDE)
        im = im.resize(size, Image.Resampling.LANCZOS, reducing_gap=3.0)
        notes.append(f"downsized {w} x {h} -> {size[0]} x {size[1]}")
    im.info = {}  # Pillow would otherwise carry a JPEG comment over
    buf = io.BytesIO()
    im.save(buf, "JPEG", quality=QUALITY, optimize=True)
    out = buf.getvalue()
    if not is_clean_jpeg(out):  # belt and braces
        raise Fail("photo.jpg would carry metadata; refusing to write it")
    return out, im.size[0], im.size[1], notes


def mb_over(n: int) -> str:
    """A size in MB rounded up, so a file just over the limit never reads as the limit itself ("25.1 MB")."""
    return f"{math.ceil(n / 2**20 * 10) / 10:.1f} MB"


def ingest(upload: Path, out: Path) -> dict:
    if not upload.is_file():
        raise Fail(f"{upload} doesn't exist")
    size = upload.stat().st_size
    if size > MAX_BYTES:
        raise Fail(f"the photo is {mb_over(size)}, over the 25 MB limit")
    if size == 0:
        raise Fail("the photo is empty")
    data = upload.read_bytes()
    if len(data) > MAX_BYTES:
        raise Fail(f"the photo is {mb_over(len(data))}, over the 25 MB limit")
    kind = sniff(data[:64])
    if kind is None:
        raise Fail(NOT_AN_IMAGE)

    passthrough = False
    if kind == "jpg" and is_clean_jpeg(data):
        Image = _pil()
        try:
            with Image.open(io.BytesIO(data)) as im:
                w, h, mode = im.size[0], im.size[1], im.mode
                if w * h > MAX_PIXELS:
                    raise Fail(f"the photo is larger than {MAX_PIXELS // 1_000_000} megapixels, which is more than midstudy handles")
                if max(w, h) <= LONG_SIDE and mode in ("RGB", "L"):
                    im.load()
                    passthrough = mode == "RGB"
        except Fail:
            raise
        except (Image.DecompressionBombError, Image.DecompressionBombWarning):
            raise Fail(f"the photo is larger than {MAX_PIXELS // 1_000_000} megapixels, which is more than midstudy handles")
        except Exception as e:
            raise Fail(f"the photo is damaged or truncated and couldn't be decoded ({type(e).__name__})")
    if passthrough:
        photo, notes = data, ["clean JPEG: photo.jpg is the upload byte for byte"]
    else:
        photo, w, h, notes = normalize(data, kind)

    out.mkdir(parents=True, exist_ok=True)
    src_name = f"source.{kind}"
    write_atomic(out / src_name, data)
    for old in out.glob("source.*"):
        if old.name != src_name and old.is_file():
            old.unlink()
    write_atomic(out / "photo.jpg", photo)
    log(f"ingest: {upload.name} ({kind}, {size / 2**20:.1f} MB) -> photo.jpg {w} x {h}" + (f"; {'; '.join(notes)}" if notes else ""))
    return {"ok": True, "photo": "photo.jpg", "source": src_name, "image": {"w": w, "h": h}}
