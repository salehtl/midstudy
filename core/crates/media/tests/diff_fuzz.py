#!/usr/bin/env python3
"""Differential fuzzing: v1's Python kernels against midstudy-media on random mutations of a corpus, for a set time
(docs/notes/kernels-hardening.md). Where tests/diff_v1.py runs a fixed seeded corpus, this one mutates: each case is a
seed with 1 to 6 stacked havoc mutations (bit flips, interesting bytes, inserted, deleted, duplicated and spliced
ranges, JPEG segments and PNG chunks put in, length fields changed, truncation, trailing junk). Every case runs through
v1 and through examples/difftool, and both the decisions (accepted or refused, the size read, clean or not, the route)
and the bytes written must agree, or be one of diff_v1.EXPECTED's named differences; anything else is saved to
evals/out/kh/diff-fuzz/failures/ and fails the run.

    (cd core && cargo build --release --example difftool -p midstudy-media)
    evals/py core/crates/media/tests/diff_fuzz.py [--seconds 1200] [--seed 1] [--difftool PATH] [--corpus DIR ...]

Seeds: diff_v1's corpus without its mutations (Pillow JPEGs and PNGs, metadata.py's GPS canaries, hand-made edge
structures, synthetic GLBs, the tracked fixtures) and, for each area, any `--corpus` directories given (the cargo-fuzz
corpora: evals/out/kh/fuzz/<target>/corpus, the minimised fuzz/corpus/<target>/), which are coverage-diverse.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import random
import struct
import sys
import time
import zlib
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parent))
import diff_v1 as D  # noqa: E402  (sets up v1's import paths and the mock environment)

OUT = D.REPO / "evals" / "out" / "kh" / "diff-fuzz"
INTERESTING = [0x00, 0x01, 0x02, 0x10, 0x7F, 0x80, 0xC0, 0xC2, 0xC4, 0xD0, 0xD7, 0xD8, 0xD9, 0xDA, 0xDB, 0xE0, 0xE1, 0xEE,
               0xEF, 0xFE, 0xFF]


def mutate(seed: bytes, others: list[bytes], rng: random.Random, kind: str) -> bytes:
    d = bytearray(seed)
    for _ in range(rng.randrange(1, 7)):
        n = len(d)
        r = rng.random()
        pos = rng.randrange(n + 1) if rng.random() < 0.5 else rng.randrange(min(n, 400) + 1)
        if r < 0.12 and n:
            p = min(pos, n - 1)
            d[p] ^= 1 << rng.randrange(8)
        elif r < 0.24 and n:
            d[min(pos, n - 1)] = rng.choice(INTERESTING) if rng.random() < 0.7 else rng.randrange(256)
        elif r < 0.34:
            d[pos:pos] = os.urandom(rng.randrange(1, 9))
        elif r < 0.44 and n:
            del d[pos:pos + rng.randrange(1, 33)]
        elif r < 0.50 and n:
            a = rng.randrange(n)
            d[pos:pos] = d[a:a + rng.randrange(1, 65)]
        elif r < 0.60 and others:
            o = rng.choice(others)
            if o:
                a = rng.randrange(len(o))
                d[pos:pos] = o[a:a + rng.randrange(1, 257)]
        elif r < 0.72:
            if kind == "jpeg":
                payload = rng.choice([b"Exif\0\0" + os.urandom(rng.randrange(12)), b"JFIF\0\x01\x02\0\0\x01\0\x01\0\0",
                                      b"JFXX\0\x10ab", b"", os.urandom(rng.randrange(1, 24))])
                marker = rng.choice([0xE0, 0xE1, 0xE2, 0xED, 0xEE, 0xEF, 0xFE, 0xDD, 0xDB, 0xC4, 0xC0, 0xDA, 0xF0, 0xD8])
                d[pos:pos] = D.seg(marker, payload) if rng.random() < 0.8 else bytes((0xFF, rng.choice(INTERESTING)))
            elif kind == "png":
                body = os.urandom(rng.randrange(0, 16))
                ck = rng.choice([b"tEXt", b"iTXt", b"zTXt", b"eXIf", b"tIME", b"gAMA", b"IEND", b"IDAT", b"EXIF", b"tExt"])
                c = D.png_chunk(ck, body)
                if rng.random() < 0.3:
                    c = c[:-4] + os.urandom(4)
                d[pos:pos] = c
            else:
                d[pos:pos] = rng.choice([b'"', b"{", b"}", b"[", b"]", b",", b":", b"0", b"-1", b"1e9", b"\\u0000", b'"uri":"',
                                         b'"bufferView":0', b'"byteLength":4', b"null"])
        elif r < 0.84 and n >= 2:
            # a length field: JPEG (big-endian u16 after a marker), PNG (big-endian u32), GLB (little-endian u32)
            if kind == "jpeg":
                ms = [i for i in range(min(n - 3, 2000)) if d[i] == 0xFF and d[i + 1] not in (0x00, 0xFF)]
                if ms:
                    m = rng.choice(ms)
                    d[m + 2:m + 4] = struct.pack(">H", rng.choice([0, 1, 2, 3, 0xFFFF, rng.randrange(65536)]))
            elif n >= 4:
                p = min(pos, n - 4)
                fmt = ">I" if kind == "png" else "<I"
                d[p:p + 4] = struct.pack(fmt, rng.choice([0, 1, 4, 0x7FFFFFFF, 0xFFFFFFFF, rng.randrange(1 << 16), n]))
        elif r < 0.92 and n:
            del d[rng.randrange(n):]
        else:
            d += rng.choice([b"\0", b"\xff", b"junk", b"\xff\xd9", bytes(seed[:64]), os.urandom(rng.randrange(1, 33))])
    return bytes(d)


def files(dirs: list[Path], cap: int = 4000) -> list[bytes]:
    out = []
    for d in dirs:
        if d.is_dir():
            for f in sorted(d.iterdir())[:cap]:
                if f.is_file() and f.stat().st_size <= 256 * 1024:
                    out.append(f.read_bytes())
    return out


def v1_call(fn, *args):
    """v1's function, with an exception recorded as v1 failing (a 500, or a traceback in midstudy-add)."""
    try:
        return fn(*args)
    except Exception as e:  # noqa: BLE001
        return ("crash", type(e).__name__)


def save(area: str, data: bytes) -> None:
    d = OUT / "failures"
    d.mkdir(parents=True, exist_ok=True)
    (d / f"{area}-{hashlib.sha1(data).hexdigest()[:16]}.bin").write_bytes(data)


def jpeg_round(t: D.Tally, cases: list[bytes], rust: D.Rust) -> None:
    r_strip = rust.run([("jpeg-strip", [x]) for x in cases])
    r_size = rust.run([("jpeg-size", [x]) for x in cases])
    r_clean = rust.run([("jpeg-clean", [x]) for x in cases])
    r_pass = rust.run([("jpeg-pass", [x]) for x in cases])
    r_sniff = rust.run([("sniff", [x[:200]]) for x in cases])
    to_calib = {"jpeg": "jpg", "png": "png", "webp": "webp", "heic": "heic", "heif": "heic"}
    for data, a, b, c, p, s in zip(cases, r_strip, r_size, r_clean, r_pass, r_sniff):
        before = sum(len(x["failures"]) for x in t.areas.values())
        v1 = v1_call(D.serve.clean_jpeg, data)
        v1 = None if isinstance(v1, tuple) else v1
        t.check("jpeg-strip", data[:24].hex(), v1, rust.data(a) if a["ok"] else None)
        v1s = v1_call(D.serve.jpeg_size, data)
        t.check("jpeg-size", data[:24].hex(), None if isinstance(v1s, tuple) and v1s[:1] == ("crash",) else v1s,
                (b["w"], b["h"]) if b["ok"] else None)
        t.check("jpeg-clean", data[:24].hex(), bool(v1_call(D.ingest.is_clean_jpeg, data) is True), c["clean"])
        v1p = D.v1_passthrough(data)
        if v1p == "fail":
            t.check("jpeg-passthrough", data[:24].hex(), False, p["ok"], "pass-decode" if p["ok"] else None)
        else:
            t.check("jpeg-passthrough", data[:24].hex(), v1p, p["ok"])
        t.check("sniff-calib", data[:24].hex(), D.ingest.sniff(data[:64]), to_calib.get(s["kind"]))
        if sum(len(x["failures"]) for x in t.areas.values()) > before:
            save("jpeg", data)


def png_round(t: D.Tally, cases: list[bytes], rust: D.Rust) -> None:
    r_strip = rust.run([("png-strip", [x]) for x in cases])
    r_size = rust.run([("png-size", [x]) for x in cases])
    for data, a, b in zip(cases, r_strip, r_size):
        before = sum(len(x["failures"]) for x in t.areas.values())
        v1 = v1_call(D.pglb.clean_png, data)
        t.check("png-strip", data[:24].hex(), None if isinstance(v1, tuple) else v1, rust.data(a) if a["ok"] else None)
        v1s = v1_call(D.serve.png_size, data)
        v1s = None if isinstance(v1s, tuple) and v1s[:1] == ("crash",) else v1s
        t.check("png-size", data[:24].hex(), tuple(v1s) if v1s else None, (b["w"], b["h"]) if b["ok"] else None)
        if sum(len(x["failures"]) for x in t.areas.values()) > before:
            save("png", data)


def glb_round(t: D.Tally, cases: list[bytes], rust: D.Rust) -> None:
    before = {k: len(v["failures"]) for k, v in t.areas.items()}
    D.compare_glb(t, [(f"g{k}", c) for k, c in enumerate(cases)], rust)
    new = len(t.areas.get("glb", {}).get("failures", [])) - before.get("glb", 0)
    if new:
        for desc, _, _ in t.areas["glb"]["failures"][-new:]:
            k = int(desc.split(":")[0][1:]) if desc[:1] == "g" and desc.split(":")[0][1:].isdigit() else None
            if k is not None:
                save("glb", cases[k])


def string_round(t: D.Tally, paths: list[str], hosts: list[str], rust: D.Rust) -> None:
    rn = rust.run([("normalize", [p]) for p in paths])
    rr = rust.run([("route", [p]) for p in paths])
    for p, a, b in zip(paths, rn, rr):
        before = sum(len(x["failures"]) for x in t.areas.values())
        t.check("path-normalize", repr(p), D.serve.clean_path(p), bytes.fromhex(a["path"]).decode() if a["ok"] else None)
        r2 = bytes.fromhex(b["route"]).decode()
        try:
            r1 = D.v1_route(p)
        except ValueError:
            t.expected("path-route", "path-v1-crash")
            continue
        if r1 == "api":
            t.check("path-route", repr(p), "not-found", r2.split(":")[0])
        else:
            t.check("path-route", repr(p), r1, r2.rsplit(":", 1)[0] if r2.startswith("planner:") else r2)
        if sum(len(x["failures"]) for x in t.areas.values()) > before:
            save("path", p.encode("utf-8", "surrogatepass"))
    rh = rust.run([("host", [h]) for h in hosts])
    for h, r in zip(hosts, rh):
        before = sum(len(x["failures"]) for x in t.areas.values())
        t.check("host", repr(h), D.serve.host_name(h), bytes.fromhex(r["name"]).decode() if r["name"] is not None else "")
        if sum(len(x["failures"]) for x in t.areas.values()) > before:
            save("host", h.encode("utf-8", "surrogatepass"))


def mutate_text(seed: str, others: list[str], rng: random.Random) -> str:
    s = list(seed)
    for _ in range(rng.randrange(1, 5)):
        r = rng.random()
        pos = rng.randrange(len(s) + 1)
        if r < 0.4:
            s[pos:pos] = list(rng.choice(D.PATH_PIECES + ["%", "%2", "\x00", "é", "．", ":", "@", "[", "]", " "]))
        elif r < 0.6 and s:
            del s[pos:pos + rng.randrange(1, 4)]
        elif r < 0.8 and others:
            o = rng.choice(others)
            a = rng.randrange(len(o) + 1)
            s[pos:pos] = list(o[a:a + rng.randrange(1, 9)])
        elif s:
            s[min(pos, len(s) - 1)] = chr(rng.choice([0x2E, 0x2F, 0x25, 0x5C, 0x3F, 0x23, 0x41, 0x61, 0xFF, 0xA0, 0x85]))
    return "".join(s)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--difftool", type=Path, default=D.REPO / "core" / "target" / "release" / "examples" / "difftool")
    ap.add_argument("--seconds", type=float, default=1200)
    ap.add_argument("--seed", type=int, default=1)
    ap.add_argument("--corpus", type=Path, action="append", default=[], help="area=DIR (area jpeg, png, glb, path, host)")
    a = ap.parse_args()
    if not a.difftool.exists():
        print("diff_fuzz: build the Rust side first: (cd core && cargo build --release --example difftool -p midstudy-media)")
        return 2
    rng = random.Random(a.seed)
    D.OUT.mkdir(parents=True, exist_ok=True)
    (D.OUT / "bin").mkdir(parents=True, exist_ok=True)
    rust = D.Rust(a.difftool.resolve(), OUT / "bin")
    extra: dict[str, list[Path]] = {}
    for c in a.corpus:
        area, _, d = str(c).partition("=")
        extra.setdefault(area, []).append(Path(d))
    small, _big = D.jpeg_corpus(rng, 0.0)
    jpeg_seeds = [b for _, b in small] + files(extra.get("jpeg", []))
    png_seeds = [b for _, b in D.png_corpus(rng, 0.0)] + files(extra.get("png", []))
    jt = [b for n, b in small if n in ("gps-jpeg", "pillow0", "pillow0-exif", "jfxx-gps", "trailing-gps", "pillow1-com")]
    pt = png_seeds[:5]
    glb_seeds = [b for _, b in D.glb_corpus(rng, 0.0, jt, pt)] + files(extra.get("glb", []))
    path_seeds = [b.decode("utf-8", "replace") for b in files(extra.get("path", []))] + [D.rand_path(rng) for _ in range(200)]
    host_seeds = [b.decode("latin-1") for b in files(extra.get("host", []))] + ["127.0.0.1:8765", "localhost", "[::1]:80", "homeserver"]
    print(f"diff_fuzz: seeds jpeg {len(jpeg_seeds)}, png {len(png_seeds)}, glb {len(glb_seeds)}, path {len(path_seeds)}, "
          f"host {len(host_seeds)}; {a.seconds:.0f} s, seed {a.seed}", flush=True)
    t = D.Tally()
    end = time.monotonic() + a.seconds
    rounds = 0
    while time.monotonic() < end:
        rounds += 1
        jpeg_round(t, [mutate(rng.choice(jpeg_seeds), jpeg_seeds, rng, "jpeg") for _ in range(400)], rust)
        png_round(t, [mutate(rng.choice(png_seeds), png_seeds, rng, "png") for _ in range(400)], rust)
        glb_round(t, [mutate(rng.choice(glb_seeds), glb_seeds, rng, "glb") for _ in range(150)], rust)
        string_round(t, [mutate_text(rng.choice(path_seeds), path_seeds, rng) for _ in range(800)],
                     [mutate_text(rng.choice(host_seeds), host_seeds, rng) for _ in range(800)], rust)
        if rounds % 5 == 0:
            total = sum(x["cases"] for x in t.areas.values())
            bad = sum(len(x["failures"]) for x in t.areas.values())
            print(f"  round {rounds}: {total} cases, {bad} unexpected, {end - time.monotonic():.0f} s left", flush=True)
    total = sum(x["cases"] for x in t.areas.values())
    print(f"diff_fuzz (seed {a.seed}, {a.seconds:.0f} s, {rounds} rounds): {total} cases")
    ok = t.report()
    print("diff_fuzz: " + ("ok, every difference is an expected one" if ok else f"FAIL, unexpected differences (inputs in {OUT / 'failures'})"))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
