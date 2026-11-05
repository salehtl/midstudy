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
usage: python3 gen_corpus.py jpeg|png|slug REPO_ROOT OUTDIR [N_SYNTH]
"""
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


def main():
    mode, root, out = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 3000
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261105)
    files = (main_png(root, out, n, rng) if mode == "png" else main_slug(n, rng) if mode == "slug"
             else main_jpeg(root, n, rng))
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
    files.append(("empty.jpg", b""))
    files.append(("soi.jpg", b"\xff\xd8"))
    files.append(("soi-eoi.jpg", b"\xff\xd8\xff\xd9"))
    files.append(("png.jpg", b"\x89PNG\r\n\x1a\n" + bytes(20)))
    return files


if __name__ == "__main__":
    main()
