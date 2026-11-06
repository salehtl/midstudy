"""The corpora for proofs/diff/run.sh: JPEG- and PNG-shaped inputs that exercise every branch of the strippers.

Deterministic (seeded). Writes OUTDIR/*.jpg and OUTDIR/list.txt. Inputs: the repo's JPEG fixtures (golden scene
photos and fal mock inputs; never fixtures/photos/), each with metadata injected in several ways, many small synthetic
JPEGs (segments, APP0 JFIF/JFXX variants, APP1-APP15, COM, fill bytes, length-less markers, scans whose data holds
stuffed bytes and restart markers, trailing bytes), and mutations of all of them (truncations, byte flips, inserted
FF bytes, bad lengths).
PNG: the repo's PNG fixtures (depth maps, id masks) with metadata chunks injected, synthetic chunk streams (every
dropped type, IEND early or missing, bytes after IEND, huge lengths) and mutations.
Slugs: valid ones of every length 1-64, and near misses (65 long, upper case, leading '-', '_', '.', '/', '..', spaces,
a trailing newline, non-ASCII letters, empty), as UTF-8 text files.
frame (jpeg.rs frame_info) uses the JPEG corpus.
b64: base64 of random bytes, mutated (padding added, dropped or moved, whitespace, characters outside the alphabet, data
after padding, cuts), random strings over the alphabet and '=', raw bytes, and lengths around the 16 KiB header cap.
meta: headers of UTF-8 text (ASCII and not), of byte strings that are and aren't UTF-8 (overlong forms, surrogates,
above U+10FFFF, cut sequences, every boundary of Table 3-7), mutations, non-ASCII headers and lengths around both caps.
sniff: ftyp boxes (every brand list, box sizes below 16, inside a brand and past 64 bytes, cut around 12, 16 and 64),
magic bytes with junk, two rules at once, random bytes, and the heads of the repo's fixtures.
wire: the TypeScript face's packings of zip entries (names, flags, sizes split in two words, attributes), cut short,
with trailing bytes, with corrupted length prefixes, random bytes, and 1,001 entries.
usage: python3 gen_corpus.py jpeg|png|slug|frame|b64|meta|sniff|wire REPO_ROOT OUTDIR [N_SYNTH]
"""
import base64
import random
import struct
import zlib
import sys
from pathlib import Path


def seg(m, payload):
    n = len(payload) + 2
    return bytes([0xFF, m, n >> 8, n & 0xFF]) + payload


def jfif(thumb=b"", w=0, h=0, extra=b""):
    return seg(0xE0, b"JFIF\0" + bytes([1, 2, 0, 0, 72, 0, 72, w, h]) + thumb + extra)


def ecs(rng, n):
    out = bytearray()
    for _ in range(n):
        r = rng.random()
        if r < 0.06:
            out += b"\xff\x00"
        elif r < 0.09:
            out += bytes([0xFF, 0xD0 + rng.randrange(8)])
        else:
            out.append(rng.randrange(0xFF))  # never FF on its own
    return bytes(out)


def synth(rng):
    parts = [b"\xff\xd8"]
    def fill():
        return b"\xff" * rng.choice([0, 0, 0, 1, 2, 5])
    for _ in range(rng.randrange(1, 12)):
        kind = rng.random()
        f = fill()
        if kind < 0.15:
            parts.append(f + jfif(thumb=bytes(rng.randrange(256) for _ in range(rng.choice([0, 0, 3, 12]))),
                                  extra=bytes(rng.randrange(256) for _ in range(rng.choice([0, 0, 2])))))
        elif kind < 0.2:
            parts.append(f + seg(0xE0, b"JFXX\0\x10" + bytes(rng.randrange(256) for _ in range(rng.randrange(20)))))
        elif kind < 0.24:
            parts.append(f + seg(0xE0, b"JFIF\0" + bytes(rng.randrange(256) for _ in range(rng.randrange(12)))))
        elif kind < 0.45:
            m = rng.randrange(0xE1, 0xF0)
            parts.append(f + seg(m, bytes(rng.randrange(256) for _ in range(rng.randrange(40)))))
        elif kind < 0.55:
            parts.append(f + seg(0xFE, bytes(rng.randrange(256) for _ in range(rng.randrange(30)))))
        elif kind < 0.65:
            m = rng.choice([0xDB, 0xC4, 0xC0, 0xC2, 0xDD, 0xF0, 0xF7, 0xC8, 0xCC])
            parts.append(f + seg(m, bytes(rng.randrange(256) for _ in range(rng.randrange(30)))))
        elif kind < 0.7:
            parts.append(f + bytes([0xFF, rng.choice([0x01] + list(range(0xD0, 0xD8)))]))
        else:
            # entropy-coded data from empty to several 64-byte blocks (the Rust scans for FF a block at a time)
            n = rng.randrange(0, 80) if rng.random() < 0.7 else rng.randrange(60, 700)
            parts.append(f + seg(0xDA, bytes(rng.randrange(256) for _ in range(rng.randrange(1, 12)))) +
                         ecs(rng, n))
    parts.append(fill() + b"\xff\xd9")
    if rng.random() < 0.3:
        parts.append(bytes(rng.randrange(256) for _ in range(rng.randrange(1, 40))))
    return b"".join(parts)


def inject(rng, data):
    """The fixture with metadata put in: after SOI, between segments, and/or after EOI."""
    exif = seg(0xE1, b"Exif\0\0" + bytes(rng.randrange(256) for _ in range(rng.randrange(10, 200))))
    icc = seg(0xE2, b"ICC_PROFILE\0" + bytes(rng.randrange(256) for _ in range(64)))
    com = seg(0xFE, b"a comment")
    choice = rng.randrange(5)
    if choice == 0:
        return data[:2] + jfif(thumb=bytes(48), w=4, h=4) + exif + icc + com + data[2:]
    if choice == 1:
        return data[:2] + b"\xff\xff" + exif + data[2:] + b"trailing"
    if choice == 2:
        return data + data  # a second image appended
    if choice == 3:
        i = data.find(b"\xff\xda")
        return data[:i] + com + b"\xff\xff\xff" + data[i:] if i > 0 else data
    return data[:2] + seg(0xE0, b"JFXX\0\x10" + bytes(32)) + data[2:]


def mutate(rng, data):
    b = bytearray(data)
    for _ in range(rng.randrange(1, 4)):
        r = rng.random()
        if r < 0.3 and len(b) > 4:
            del b[rng.randrange(2, len(b)):]
        elif r < 0.6 and b:
            b[rng.randrange(len(b))] = rng.randrange(256)
        elif r < 0.8:
            i = rng.randrange(len(b) + 1)
            b[i:i] = b"\xff" * rng.randrange(1, 3)
        else:
            i = b.find(b"\xff", rng.randrange(len(b)) if b else 0)
            if 0 <= i < len(b) - 3:
                b[i + 2] = rng.choice([0, 0, 0xFF])
                b[i + 3] = rng.choice([0, 1, 0xFF])
    return bytes(b)


PNG_SIG = b"\x89PNG\r\n\x1a\n"
DROPPED = [b"eXIf", b"tEXt", b"iTXt", b"zTXt", b"tIME"]
KEPT = [b"IHDR", b"PLTE", b"IDAT", b"iCCP", b"gAMA", b"pHYs", b"sRGB", b"cHRM", b"bKGD", b"tRNS", b"sBIT", b"hIST",
        b"sPLT", b"acTL", b"fcTL", b"fdAT", b"oFFs", b"EXIF", b"text", b"IEnd"]


def chunk(kind, data):
    return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))


def png_synth(rng):
    parts = [PNG_SIG, chunk(b"IHDR", struct.pack(">IIBBBBB", rng.randrange(1, 4000), rng.randrange(1, 4000), 8, 2, 0, 0, 0))]
    for _ in range(rng.randrange(0, 10)):
        kind = rng.choice(DROPPED + KEPT)
        parts.append(chunk(kind, bytes(rng.randrange(256) for _ in range(rng.randrange(0, 60)))))
    if rng.random() < 0.9:
        parts.append(chunk(b"IEND", b""))
    if rng.random() < 0.3:
        parts.append(rng.choice([chunk(b"tEXt", b"after\0IEND"), bytes(rng.randrange(256) for _ in range(rng.randrange(1, 30))),
                                 chunk(b"IEND", b"")]))
    return b"".join(parts)


def png_inject(rng, data):
    i = 8 + 25  # after IHDR
    extra = b"".join(chunk(k, bytes(rng.randrange(256) for _ in range(rng.randrange(0, 40))))
                     for k in rng.sample(DROPPED, rng.randrange(1, len(DROPPED) + 1)))
    return data[:i] + extra + data[i:] + (b"trailer" if rng.random() < 0.5 else b"")


def png_mutate(rng, data):
    b = bytearray(data)
    for _ in range(rng.randrange(1, 3)):
        r = rng.random()
        if r < 0.4 and len(b) > 9:
            del b[rng.randrange(8, len(b)):]
        elif r < 0.7 and len(b) > 12:
            j = rng.randrange(8, len(b) - 4)
            b[j:j + 4] = struct.pack(">I", rng.choice([0, 1, 0xFFFFFFFF, rng.randrange(1 << 32)]))
        elif b:
            b[rng.randrange(len(b))] = rng.randrange(256)
    return bytes(b)


def main_png(root, out, n, rng):
    files = []
    fixtures = sorted(p for p in root.joinpath("fixtures").rglob("*.png") if "photos" not in p.parts)
    for k, p in enumerate(fixtures):
        data = p.read_bytes()
        files.append((f"fx{k:02d}.png", data))
        for j in range(3):
            files.append((f"fx{k:02d}-inj{j}.png", png_inject(rng, data)))
        files.append((f"fx{k:02d}-mut.png", png_mutate(rng, png_inject(rng, data))))
    for k in range(n):
        data = png_synth(rng)
        files.append((f"syn{k:05d}.png", data))
        if k % 2 == 0:
            files.append((f"syn{k:05d}-mut.png", png_mutate(rng, data)))
    files += [("empty.png", b""), ("sig.png", PNG_SIG), ("sig-iend.png", PNG_SIG + chunk(b"IEND", b"")),
              ("jpeg.png", b"\xff\xd8\xff\xd9")]
    return files


SLUG_HEAD = "abcdefghijklmnopqrstuvwxyz0123456789"
SLUG_TAIL = SLUG_HEAD + "-"
SLUG_BAD = ["A", "Z", "_", ".", "/", "\\", " ", "\n", "\r", "\t", "\x00", "é", "ß", "ǅ", "٣", "²", "😀", "-", "..", "%2e"]


def main_slug(n, rng):
    files = []
    for k in range(n):
        r = rng.random()
        length = rng.randrange(1, 66)
        s = rng.choice(SLUG_HEAD) + "".join(rng.choice(SLUG_TAIL) for _ in range(length - 1))
        if r < 0.5:
            pass  # valid when 1-64 long
        elif r < 0.8:
            i = rng.randrange(len(s) + 1)
            s = s[:i] + rng.choice(SLUG_BAD) + s[i:]
        elif r < 0.9:
            s = s + "\n"
        else:
            s = rng.choice(["", "-a", "a" * 64, "a" * 65, ".", "..", "a/b", "../a", "scene-20261105-120000", "Ä"])
        files.append((f"slug{k:05d}.txt", s.encode("utf-8")))
    return files


B64_ALPHA = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
B64_JUNK = [b"=", b"==", b"===", b" ", b"\n", b"\r\n", b"\t", b"-", b"_", b"*", b"\x00", b"\xff", "é".encode(), b".",
            b"%", b"\x7f"]


def b64_mutate(rng, s):
    b = bytearray(s)
    for _ in range(rng.choice([1, 1, 2, 3])):
        r = rng.random()
        i = rng.randrange(len(b) + 1)
        if r < 0.3:
            b[i:i] = rng.choice(B64_JUNK)
        elif r < 0.5 and b:
            del b[rng.randrange(len(b))]
        elif r < 0.65:
            b[i:i] = bytes([rng.choice(B64_ALPHA)])
        elif r < 0.8 and b:
            b[rng.randrange(len(b))] = rng.randrange(256)
        else:
            del b[i:]
    return bytes(b)


def main_b64(n, rng):
    files = []
    for k in range(n):
        size = rng.choice([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 20, 33, 60, 61, 62, 63, rng.randrange(0, 200)])
        data = bytes(rng.randrange(256) for _ in range(size))
        enc = base64.b64encode(data)
        r = rng.random()
        if r < 0.3:
            s = enc
        elif r < 0.75:
            s = b64_mutate(rng, enc)
        elif r < 0.85:
            s = bytes(rng.choice(B64_ALPHA + b"====") for _ in range(rng.randrange(0, 30)))
        elif r < 0.95:
            s = data
        else:
            s = enc + rng.choice([b"=", b"==", b"\n", b"A", b"QQ==", b"QQ"])
        files.append((f"b64{k:05d}.txt", s))
    for k, size in enumerate([3000, 12285, 12286, 12287, 12288, 12289]):
        files.append((f"b64long{k}.txt", base64.b64encode(bytes(rng.randrange(256) for _ in range(size)))))
    return files


META_TEXTS = ['{"title": "Lounge"}', "{}", "", '{"title": "Café ☕"}', '{"t": "日本語"}', '{"e": "😀"}', '{"a": 1}', " ",
              "not json"]
UTF8_EDGES = [b"\xc0\x80", b"\xc1\xbf", b"\xc2\x80", b"\xdf\xbf", b"\xe0\x80\x80", b"\xe0\x9f\xbf", b"\xe0\xa0\x80",
              b"\xed\x9f\xbf", b"\xed\xa0\x80", b"\xee\x80\x80", b"\xef\xbf\xbf", b"\xf0\x8f\xbf\xbf",
              b"\xf0\x90\x80\x80", b"\xf4\x8f\xbf\xbf", b"\xf4\x90\x80\x80", b"\xf5\x80\x80\x80", b"\xc3", b"\xe2\x82",
              b"\xf0\x9f\x98", b"\xff", b"\x80", b"\xbf", b"\xe1\x80\xc0", b"\x7f"]


def main_meta(n, rng):
    files = []
    for k in range(n):
        r = rng.random()
        if r < 0.35:
            text = rng.choice(META_TEXTS) + "".join(rng.choice('abc é☕😀日\n"{}') for _ in range(rng.randrange(0, 40)))
            s = base64.b64encode(text.encode())
        elif r < 0.6:
            raw = b"".join(rng.choice(UTF8_EDGES + [b"a", b"{", b'"', "é".encode(), "😀".encode()])
                           for _ in range(rng.randrange(1, 8)))
            s = base64.b64encode(raw)
        elif r < 0.8:
            s = b64_mutate(rng, base64.b64encode(rng.choice(META_TEXTS).encode()))
        elif r < 0.9:
            s = base64.b64encode(rng.choice(META_TEXTS).encode()) + rng.choice(["é".encode(), b"\xff", "😀".encode()])
        else:
            s = base64.b64encode(("x" * rng.choice([40, 47, 48, 49, 12287, 12288, 12289])).encode())
        files.append((f"meta{k:05d}.txt", s))
    return files


HEVC_BRANDS = [b"heic", b"heix", b"hevc", b"hevx", b"heim", b"heis", b"hevm", b"hevs"]
GENERIC_BRANDS = [b"mif1", b"msf1", b"mif2", b"miaf"]
AVIF_BRANDS = [b"avif", b"avis"]
OTHER_BRANDS = [b"isom", b"mp41", b"crx ", b"MiHE", b"jxl ", b"HEIC", b"\0\0\0\0"]


def ftyp_box(rng):
    major = rng.choice(HEVC_BRANDS + GENERIC_BRANDS * 3 + AVIF_BRANDS + OTHER_BRANDS)
    compat = [rng.choice(HEVC_BRANDS + GENERIC_BRANDS + AVIF_BRANDS * 2 + OTHER_BRANDS) for _ in range(rng.randrange(0, 16))]
    true_size = 16 + 4 * len(compat)
    size = rng.choice([true_size, true_size, rng.randrange(0, 80), 0, 8, 16, 17, 18, 19, 20, 63, 64, 65, 0xFFFFFFFF])
    data = (struct.pack(">I", size) + b"ftyp" + major + bytes(rng.randrange(256) for _ in range(4)) + b"".join(compat)
            + bytes(rng.randrange(256) for _ in range(rng.randrange(0, 40))))
    cut = rng.choice([None, None, None, rng.randrange(0, len(data) + 1), 11, 12, 15, 16, 63, 64, 65])
    return data if cut is None else data[:cut]


def main_sniff(root, n, rng):
    files = []
    fixtures = sorted(p for p in root.joinpath("fixtures").rglob("*") if p.is_file() and "photos" not in p.parts)
    for k, p in enumerate(fixtures[:400]):
        with open(p, "rb") as f:
            files.append((f"fx{k:03d}", f.read(200)))
    magics = [b"\xff\xd8\xff", b"\xff\xd8", b"\x89PNG\r\n\x1a\n", b"\x89PNG", b"RIFF\0\0\0\0WEBP", b"RIFF\0\0\0\0WEBQ",
              b"RIFF", b"glTF", b"PK\x03\x04", b"PK\x05\x06", b"PK\x01\x02", b""]
    for k in range(n):
        r = rng.random()
        if r < 0.45:
            data = ftyp_box(rng)
        elif r < 0.75:
            data = rng.choice(magics) + bytes(rng.randrange(256) for _ in range(rng.randrange(0, 70)))
        elif r < 0.85:
            data = rng.choice([b"\xff\xd8\xff\xe0", b"glTF", b"PK\x03\x04", b"RIFF", b"\x89PNG"]) + ftyp_box(rng)[4:]
        else:
            data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 80)))
        files.append((f"sniff{k:05d}", data))
    return files


WIRE_NAMES = [b"model.obj", b"model.mtl", b"tex/a.png", b"d/", b"../x.obj", b"/abs.obj", b"__MACOSX/._a", b".DS_Store",
              b"a\\b.png", "é.png".encode(), b"\xff\xfe.obj", b"", b"C:/x.obj"]


def pack_entry(name, flags, size, attr):
    return struct.pack("<I", len(name)) + name + struct.pack("<IIII", flags, size & 0xFFFFFFFF, size >> 32, attr)


def main_wire(n, rng):
    files = []
    for k in range(n):
        entries = []
        for _ in range(rng.choice([0, 1, 1, 2, 2, 3, 5, 8])):
            name = (rng.choice(WIRE_NAMES) if rng.random() < 0.7
                    else bytes(rng.randrange(256) for _ in range(rng.randrange(0, 40))))
            entries.append(pack_entry(name, rng.choice([0, 0x800, rng.randrange(2 ** 32)]),
                                      rng.choice([0, 5, 2 ** 32 - 1, 2 ** 32, 500 * 1024 * 1024, rng.randrange(2 ** 64)]),
                                      rng.choice([0, 0o100644 << 16, 0o120777 << 16, rng.randrange(2 ** 32)])))
        data = b"".join(entries)
        r = rng.random()
        if r < 0.45:
            pass  # exactly a packing
        elif r < 0.6 and data:
            data = data[:rng.randrange(len(data))]
        elif r < 0.7:
            data = data + bytes(rng.randrange(256) for _ in range(rng.randrange(1, 24)))
        elif r < 0.8 and len(data) >= 4:
            i = rng.randrange(len(data) - 3)
            data = (data[:i] + struct.pack("<I", rng.choice([0, 1, 0xFFFFFFFF, 0x7FFFFFFF, rng.randrange(64)]))
                    + data[i + 4:])
        elif r < 0.85:
            data = bytes(rng.randrange(256) for _ in range(rng.randrange(0, 60)))
        else:
            data = data + pack_entry(b"x" * rng.randrange(0, 5), 0, 0, 0)[:rng.randrange(1, 24)]
        files.append((f"wire{k:05d}", data))
    files.append(("wire-many", b"".join(pack_entry(b"a.png", 0x800, 1, 0) for _ in range(1001))))
    return files


def main():
    mode, root, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 3000
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261105)
    gens = {"png": lambda: main_png(root, out, n, rng), "slug": lambda: main_slug(n, rng), "b64": lambda: main_b64(n, rng),
            "meta": lambda: main_meta(n, rng), "sniff": lambda: main_sniff(root, n, rng), "wire": lambda: main_wire(n, rng)}
    files = gens.get(mode, lambda: main_jpeg(root, n, rng))()
    with open(out / "list.txt", "w") as lst:
        for name, data in files:
            (out / name).write_bytes(data)
            lst.write(str(out / name) + "\n")
    print(f"{len(files)} {mode} files in {out}")


def main_jpeg(root, n, rng):
    files = []
    fixtures = sorted(p for p in root.joinpath("fixtures").rglob("*")
                      if p.suffix.lower() in (".jpg", ".jpeg") and "photos" not in p.parts)
    for k, p in enumerate(fixtures):
        data = p.read_bytes()
        files.append((f"fx{k:02d}.jpg", data))
        for j in range(5):
            files.append((f"fx{k:02d}-inj{j}.jpg", inject(rng, data)))
        for j in range(3):
            files.append((f"fx{k:02d}-mut{j}.jpg", mutate(rng, inject(rng, data))))
    for k in range(n):
        data = synth(rng)
        files.append((f"syn{k:05d}.jpg", data))
        if k % 2 == 0:
            files.append((f"syn{k:05d}-mut.jpg", mutate(rng, data)))
    # frame headers: a size of 0, short or long SOF segments, stepped-over markers and fill before them
    for k in range(400):
        pre = b"".join(rng.choice([b"\xff\x01", b"\xff\xd8", bytes([0xFF, 0xD0 + rng.randrange(8)]), b"\xff",
                                   seg(0xDB, bytes(rng.randrange(256) for _ in range(rng.randrange(0, 10)))), b""])
                       for _ in range(rng.randrange(0, 4)))
        w = rng.choice([0, 1, 4000, rng.randrange(65536)])
        h = rng.choice([0, 1, 3000, rng.randrange(65536)])
        body = bytes([8]) + struct.pack(">HH", h, w) + bytes([rng.choice([1, 3, 4])])
        sof = seg(rng.choice([0xC0, 0xC1, 0xC2, 0xCF, 0xC4, 0xC8, 0xCC]), body[:rng.choice([0, 3, 6, len(body)])])
        files.append((f"frame{k:04d}.jpg", b"\xff\xd8" + pre + sof + bytes(rng.randrange(0, 12)) + b"\xff\xd9"))
    files.append(("empty.jpg", b""))
    files.append(("soi.jpg", b"\xff\xd8"))
    files.append(("soi-eoi.jpg", b"\xff\xd8\xff\xd9"))
    files.append(("png.jpg", b"\x89PNG\r\n\x1a\n" + bytes(20)))
    return files


if __name__ == "__main__":
    main()
