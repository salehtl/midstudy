"""The corpus for proofs/diff/run.sh: JPEG-shaped inputs that exercise every branch of the stripper.

Deterministic (seeded). Writes OUTDIR/*.jpg and OUTDIR/list.txt. Inputs: the repo's JPEG fixtures (golden scene
photos and fal mock inputs; never fixtures/photos/), each with metadata injected in several ways, many small synthetic
JPEGs (segments, APP0 JFIF/JFXX variants, APP1-APP15, COM, fill bytes, length-less markers, scans whose data holds
stuffed bytes and restart markers, trailing bytes), and mutations of all of them (truncations, byte flips, inserted
FF bytes, bad lengths).
usage: python3 gen_corpus.py REPO_ROOT OUTDIR [N_SYNTH]
"""
import random
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
            parts.append(f + seg(0xDA, bytes(rng.randrange(256) for _ in range(rng.randrange(1, 12)))) +
                         ecs(rng, rng.randrange(0, 80)))
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


def main():
    root, out = Path(sys.argv[1]), Path(sys.argv[2])
    n = int(sys.argv[3]) if len(sys.argv) > 3 else 3000
    out.mkdir(parents=True, exist_ok=True)
    rng = random.Random(20261105)
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
    with open(out / "list.txt", "w") as lst:
        for name, data in files:
            (out / name).write_bytes(data)
            lst.write(str(out / name) + "\n")
    print(f"{len(files)} files in {out}")


if __name__ == "__main__":
    main()
