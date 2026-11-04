"""Ingest: formats, guards, orientation, colour, metadata and the byte-for-byte pass-through (contract §4.3)."""
from __future__ import annotations

import hashlib
import io
import struct
import zlib
from pathlib import Path

import numpy as np
import pytest
from PIL import Image, ImageCms

from midstudy_calib.ingest import exif_block, fov_from_35mm, ingest, is_clean_jpeg, jpeg_markers, sniff
from midstudy_calib.util import Fail

REPO = Path(__file__).resolve().parents[2]
P3 = Path("/System/Library/ColorSync/Profiles/Display P3.icc")


def no_metadata(path: Path) -> bool:
    data = path.read_bytes()
    markers = jpeg_markers(data)
    return markers is not None and not any(0xE1 <= m <= 0xEF or m == 0xFE for m in markers)


def gradient(w, h):
    x = np.linspace(0, 255, w)[None, :, None]
    y = np.linspace(0, 255, h)[:, None, None]
    return Image.fromarray(np.concatenate([np.broadcast_to(x, (h, w, 1)), np.broadcast_to(y, (h, w, 1)),
                                           np.full((h, w, 1), 90.0)], -1).astype(np.uint8))


def exif_with(orientation=None, f35=None, make=None, model=None):
    ex = Image.Exif()
    if orientation:
        ex[0x0112] = orientation
    if make:
        ex[0x010F] = make
    if model:
        ex[0x0110] = model
    if f35:
        ex.get_ifd(0x8769)[0xA405] = f35
    return ex


def test_golden_jpeg_passes_through_byte_for_byte(tmp_path):
    src = REPO / "fixtures/scenes/living-wide/photo.jpg"
    res = ingest(src, tmp_path)
    assert res == {"ok": True, "photo": "photo.jpg", "source": "source.jpg", "image": {"w": 1600, "h": 1200}}
    assert (tmp_path / "photo.jpg").read_bytes() == src.read_bytes()
    assert (tmp_path / "source.jpg").read_bytes() == src.read_bytes()


def gps_jpeg(w=64, h=48, **kw) -> bytes:
    ex = exif_with(make="TestCam", model="TestCam GPS")
    ex[0x8825] = {1: "N", 2: (0.0, 30.0, 0.0), 3: "E", 4: (0.0, 30.0, 0.0)}  # GPSInfo
    buf = io.BytesIO()
    gradient(w, h).save(buf, "JPEG", exif=ex.tobytes(), quality=90, **kw)
    return buf.getvalue()


def plain_jpeg(w=64, h=48, **kw) -> bytes:
    buf = io.BytesIO()
    gradient(w, h).save(buf, "JPEG", quality=90, **kw)
    return buf.getvalue()


def app1_after_first_scan(prog: bytes, payload: bytes) -> bytes:
    """A progressive JPEG with an APP1 segment inserted right after its first scan (before the second SOS)."""
    first = prog.index(b"\xff\xda")
    second = prog.index(b"\xff\xda", first + 2)
    seg = b"\xff\xe1" + (len(payload) + 2).to_bytes(2, "big") + payload
    return prog[:second] + seg + prog[second:]


def with_app0(clean: bytes, payload: bytes) -> bytes:
    """`clean` with an extra APP0 segment (payload after the length) right after its JFIF header."""
    i = 2 + 2 + int.from_bytes(clean[4:6], "big")  # past SOI and the JFIF APP0
    return clean[:i] + b"\xff\xe0" + struct.pack(">H", len(payload) + 2) + payload + clean[i:]


@pytest.mark.parametrize("case", ["jfxx_gps_thumbnail", "jfif_thumbnail"])
def test_no_pass_through_with_an_app0_thumbnail(tmp_path, case):
    """Verify round 2: an APP0 that isn't a plain 16-byte JFIF header (a JFXX extension holding a whole JPEG with EXIF
    and GPS, or a JFIF thumbnail) is an embedded image: no pass-through, and photo.jpg has none of it."""
    clean = plain_jpeg()
    if case == "jfxx_gps_thumbnail":
        data = with_app0(clean, b"JFXX\x00\x10" + gps_jpeg(32, 24))
    else:  # a JFIF APP0 with a 2 x 1 RGB thumbnail
        i = 4
        n = int.from_bytes(clean[i:i + 2], "big")
        thumb = b"\x02\x01" + b"\x10\x20\x30\x40\x50\x60"
        data = clean[:i] + struct.pack(">H", n - 2 + len(thumb)) + clean[i + 2:i + n - 2] + thumb + clean[i + n:]
        assert data[6:11] == b"JFIF\x00"
    assert jpeg_markers(data) is not None and not is_clean_jpeg(data)
    up = tmp_path / "up.jpg"
    up.write_bytes(data)
    ingest(up, tmp_path / "s")
    photo = (tmp_path / "s/photo.jpg").read_bytes()
    assert photo != data and is_clean_jpeg(photo)
    assert b"TestCam" not in photo and b"JFXX" not in photo and b"Exif" not in photo


@pytest.mark.parametrize("case", ["trailing_jpeg", "zero_padding", "html_trailer", "app1_between_scans", "com_between_scans"])
def test_no_pass_through_with_hidden_metadata(tmp_path, case):
    """Contract §4.3: pass-through only when nothing follows EOI and no APP1-APP15 or COM appears anywhere."""
    clean = plain_jpeg()
    assert is_clean_jpeg(clean)
    if case == "trailing_jpeg":  # an MPF-style second image after EOI, with its own EXIF and GPS
        data = clean + gps_jpeg()
    elif case == "zero_padding":
        data = clean + b"\0" * 4096
    elif case == "html_trailer":
        data = clean + b"<html>hi</html>\xff\xd9"
    else:
        prog = plain_jpeg(progressive=True)
        assert prog.count(b"\xff\xda") >= 2 and is_clean_jpeg(prog)
        exif = Image.open(io.BytesIO(gps_jpeg())).info["exif"]
        data = app1_after_first_scan(prog, exif) if case == "app1_between_scans" else \
            prog[:prog.index(b"\xff\xda", prog.index(b"\xff\xda") + 2)] + b"\xff\xfe\x00\x0bTestCam GPS" + prog[prog.index(b"\xff\xda", prog.index(b"\xff\xda") + 2):]
    assert not is_clean_jpeg(data)
    up = tmp_path / "up.jpg"
    up.write_bytes(data)
    ingest(up, tmp_path / "s")
    photo = (tmp_path / "s/photo.jpg").read_bytes()
    assert photo != data and is_clean_jpeg(photo)
    assert b"TestCam" not in photo and b"Exif" not in photo


def test_exif_rotated_portrait(tmp_path):
    up = tmp_path / "up.jpg"
    gradient(400, 300).save(up, exif=exif_with(orientation=6, f35=26, make="Apple", model="iPhone"), quality=95)
    res = ingest(up, tmp_path / "s")
    assert res["image"] == {"w": 300, "h": 400}  # orientation 6: rotated 90 degrees, so portrait
    out = tmp_path / "s/photo.jpg"
    assert no_metadata(out)
    assert Image.open(out).getexif().get(0x0112) is None
    assert (tmp_path / "s/source.jpg").read_bytes() == up.read_bytes()
    ex = exif_block(tmp_path / "s", 300, 400)
    assert ex["focal_35mm"] == 26 and ex["make"] == "Apple" and ex["model"] == "iPhone"
    assert abs(ex["fov_y_deg"] - fov_from_35mm(26, 300, 400)) < 0.01


def test_display_p3_is_converted(tmp_path):
    if not P3.is_file():
        pytest.skip("no Display P3 profile on this machine")
    up = tmp_path / "p3.jpg"
    im = Image.new("RGB", (64, 48), (200, 60, 40))
    im.save(up, icc_profile=P3.read_bytes(), quality=100)
    ingest(up, tmp_path / "s")
    got = np.asarray(Image.open(tmp_path / "s/photo.jpg")).reshape(-1, 3).mean(0)
    want = np.asarray(ImageCms.profileToProfile(Image.open(up), ImageCms.ImageCmsProfile(str(P3)),
                                                ImageCms.createProfile("sRGB"), outputMode="RGB")).reshape(-1, 3).mean(0)
    assert np.abs(got - want).max() < 3
    assert got[0] > 210  # P3 red 200 is a more saturated red in sRGB
    assert no_metadata(tmp_path / "s/photo.jpg")


def test_large_photo_is_downsized(tmp_path):
    up = tmp_path / "big.jpg"
    gradient(4032, 3024).save(up, quality=90)
    res = ingest(up, tmp_path / "s")
    assert res["image"] == {"w": 2048, "h": 1536}


def test_png_with_alpha_webp_and_heic(tmp_path):
    rgba = gradient(320, 200).convert("RGBA")
    a = np.asarray(rgba).copy()
    a[:, :100, 3] = 0
    Image.fromarray(a).save(tmp_path / "a.png")
    assert ingest(tmp_path / "a.png", tmp_path / "png")["source"] == "source.png"
    assert tuple(np.asarray(Image.open(tmp_path / "png/photo.jpg"))[100, 20]) >= (250, 250, 250)  # transparent -> white
    gradient(320, 200).save(tmp_path / "w.webp", quality=90)
    assert ingest(tmp_path / "w.webp", tmp_path / "webp")["image"] == {"w": 320, "h": 200}
    import pillow_heif

    pillow_heif.register_heif_opener()
    gradient(320, 200).save(tmp_path / "h.heic", quality=90, exif=exif_with(f35=24, make="Apple", model="iPhone"))
    res = ingest(tmp_path / "h.heic", tmp_path / "heic")
    assert res["source"] == "source.heic" and res["image"] == {"w": 320, "h": 200}
    assert exif_block(tmp_path / "heic", 320, 200)["focal_35mm"] == 24
    for d in ("png", "webp", "heic"):
        assert no_metadata(tmp_path / d / "photo.jpg")


def test_16bit_grey_png(tmp_path):
    a = np.tile(np.linspace(0, 65535, 200), (100, 1)).astype(np.uint16)
    Image.fromarray(a).save(tmp_path / "g.png")
    ingest(tmp_path / "g.png", tmp_path / "s")
    out = np.asarray(Image.open(tmp_path / "s/photo.jpg").convert("L")).astype(int)
    assert out[50, 0] < 10 and out[50, -1] > 245


def test_jpeg_with_exif_or_comment_is_reencoded_clean(tmp_path):
    up = tmp_path / "c.jpg"
    gradient(200, 100).save(up, comment=b"hello", exif=exif_with(make="Apple"), quality=95)
    ingest(up, tmp_path / "s")
    assert (tmp_path / "s/photo.jpg").read_bytes() != up.read_bytes()
    assert no_metadata(tmp_path / "s/photo.jpg")
    assert b"hello" not in (tmp_path / "s/photo.jpg").read_bytes()


def test_guards(tmp_path):
    (tmp_path / "t.txt").write_text("not an image at all")
    with pytest.raises(Fail, match="isn't a JPEG, PNG, HEIC or WebP image"):
        ingest(tmp_path / "t.txt", tmp_path / "s")
    # AVIF is an ISO-BMFF file like HEIC, but not accepted
    (tmp_path / "x.avif").write_bytes(struct.pack(">I", 28) + b"ftypavif" + b"\0\0\0\0" + b"avifmif1miaf" + b"\0" * 64)
    with pytest.raises(Fail, match="isn't a JPEG"):
        ingest(tmp_path / "x.avif", tmp_path / "s")
    # over 25 MB
    big = tmp_path / "big.jpg"
    big.write_bytes(b"\xff\xd8\xff\xe0" + b"\0" * (25 * 1024 * 1024 + 1))
    with pytest.raises(Fail, match=r"25\.1 MB, over the 25 MB limit"):
        ingest(big, tmp_path / "s")
    # decompression bomb: a tiny PNG that claims 30000 x 30000 pixels
    def chunk(t, d):
        return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    bomb = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 30000, 30000, 8, 2, 0, 0, 0)) + \
        chunk(b"IDAT", zlib.compress(b"\0" * 1000)) + chunk(b"IEND", b"")
    (tmp_path / "bomb.png").write_bytes(bomb)
    with pytest.raises(Fail, match="megapixels"):
        ingest(tmp_path / "bomb.png", tmp_path / "s")
    # truncated JPEG
    data = io.BytesIO()
    gradient(300, 200).save(data, "JPEG")
    (tmp_path / "trunc.jpg").write_bytes(data.getvalue()[:600])
    with pytest.raises(Fail):
        ingest(tmp_path / "trunc.jpg", tmp_path / "s")
    # nothing was written by the refused uploads
    assert not (tmp_path / "s").exists() or not any((tmp_path / "s").iterdir())


def test_sniff():
    assert sniff(b"\xff\xd8\xff\xe0") == "jpg"
    assert sniff(b"\x89PNG\r\n\x1a\n") == "png"
    assert sniff(b"RIFF\0\0\0\0WEBPVP8 ") == "webp"
    assert sniff(struct.pack(">I", 24) + b"ftypheic\0\0\0\0mif1heic") == "heic"
    assert sniff(struct.pack(">I", 24) + b"ftypmif1\0\0\0\0mif1heic") == "heic"
    assert sniff(struct.pack(">I", 24) + b"ftypmif1\0\0\0\0mif1avif") is None
    assert sniff(b"GIF89a") is None


def test_exif_fov_matches_the_contract():
    # contract §4.3: 14 mm on 16:9 landscape -> 102.1 horizontal, 69.6 vertical
    assert round(fov_from_35mm(14, 5712, 3213), 1) == 69.6
    assert round(fov_from_35mm(14, 3213, 5712), 1) == 102.1  # the same photo held upright
    assert abs(fov_from_35mm(26, 4032, 3024) - 2 * np.degrees(np.arctan(25.96 / 2 / 26))) < 0.05


def test_real_camera_original_if_present(tmp_path):
    """fixtures/photos/upper-lounge-camera.jpeg (git-ignored; skipped elsewhere): P3 -> sRGB, 2048 x 1152, no metadata,
    EXIF FOV about 69.6 vertical."""
    src = REPO / "fixtures/photos/upper-lounge-camera.jpeg"
    if not src.is_file():
        pytest.skip("the user's photo isn't here")
    res = ingest(src, tmp_path)
    assert res["image"] == {"w": 2048, "h": 1152}
    assert no_metadata(tmp_path / "photo.jpg")
    ex = exif_block(tmp_path, 2048, 1152)
    assert ex["focal_35mm"] == 14 and abs(ex["fov_y_deg"] - 69.6) < 0.1
    assert hashlib.sha256((tmp_path / "source.jpg").read_bytes()).digest() == hashlib.sha256(src.read_bytes()).digest()
