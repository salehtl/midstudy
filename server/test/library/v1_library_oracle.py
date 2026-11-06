"""v1's answers for server/test/library/logic.test.ts and zip.test.ts: reads [{"fn": name, "args": [...]}, ...] (JSON)
on stdin and prints one JSON list of answers, each {"ok": value} or {"error": "<ExceptionClass>: <message>"}. Every
case runs v1's own code (planner/serve.py), so the TypeScript port is compared with the real thing. `make_zips` writes
the zip corpus (crafted with zipfile and byte surgery) into a scratch folder and lists it. Run with the dev shell's
Python 3.12 (`python3 -I server/test/library/v1_library_oracle.py`). Nothing here touches the network, .env or
fixtures/photos."""
import importlib.util
import io
import json
import os
import stat
import struct
import sys
import zipfile
import zlib
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent.parent.parent
os.environ["MIDSTUDY_NO_DOTENV"] = "1"
os.environ.pop("FAL_KEY", None)
os.environ.pop("MIDSTUDY_FAL_MOCK", None)
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("v1_serve", REPO / "planner" / "serve.py")
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


def check_meta(text, kind):
    """v1 check_meta on the JSON text (json.loads, as v1 read X-Midstudy-Meta), in a comparable shape."""
    out = serve.check_meta(json.loads(text), kind)
    dims = out["dims_cm"]
    return {"name": out["name"], "dims": "x".join(serve.num_text(dims[k]) for k in "wdh"),
            "cm": [float(dims[k]) for k in "wdh"], "id": out["id"], "category": out["category"],
            "prompt": out["prompt"], "mount": out["mount"], "yaw": out["yaw"], "engine": out["engine"],
            "resolution": out["resolution"], "estimate": out["estimate"]}


class _Lib:
    def __init__(self, base):
        self.midstudy_add = base


class _Self:
    """What Handler.add_command reads from self."""
    def __init__(self, base, library):
        self.library = _Lib(base)
        self.library_dir = Path(library)


def add_command(base, src, library, label, meta_text, kind):
    meta = serve.check_meta(json.loads(meta_text), kind)
    return serve.Handler.add_command(_Self(base, library), Path(src), meta, label)


def zip_problem(path):
    return serve.zip_problem(Path(path))


# --- the zip corpus ------------------------------------------------------------------------------------------------
def zbytes(entries, comment=b""):
    """A zip with (name, data[, external_attr]) entries, written by zipfile."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.comment = comment
        for e in entries:
            info = zipfile.ZipInfo(e[0])
            if len(e) > 2:
                info.external_attr = e[2]
            z.writestr(info, e[1])
    return buf.getvalue()


def eocd_at(data):
    return data.rfind(b"PK\x05\x06")


def cd_start(data):
    e = eocd_at(data)
    return struct.unpack_from("<L", data, e + 16)[0]


def patch_central(data, index, fmt, offset, value):
    """Overwrites a field of the index-th central-directory header."""
    out = bytearray(data)
    pos = cd_start(data)
    for _ in range(index):
        n, x, c = struct.unpack_from("<HHH", out, pos + 28)
        pos += 46 + n + x + c
    struct.pack_into(fmt, out, pos + offset, value)
    return bytes(out)


def with_extra(name, data, extra, flags=0, raw_name=None):
    """A one-entry zip whose central entry carries `extra` (and optionally other name bytes and flags)."""
    nm = raw_name if raw_name is not None else name.encode("cp437")
    crc = zlib.crc32(data)
    local = struct.pack("<4s5H3L2H", b"PK\x03\x04", 20, flags, 0, 0, 0, crc, len(data), len(data), len(nm), 0) + nm + data
    central = struct.pack("<4s4B4HL2L5H2L", b"PK\x01\x02", 20, 3, 20, 0, flags, 0, 0, 0, crc, len(data), len(data), len(nm),
                          len(extra), 0, 0, 0, 0o100644 << 16, 0) + nm + extra
    eocd = struct.pack("<4s4H2LH", b"PK\x05\x06", 0, 0, 1, 1, len(central), len(local), 0)
    return local + central + eocd


def unicode_path(name_bytes, unicode, version=1, crc=None):
    payload = struct.pack("<BL", version, zlib.crc32(name_bytes) if crc is None else crc) + unicode
    return struct.pack("<HH", 0x7075, len(payload)) + payload


def zip64_records(data):
    """`data` with a zip64 end record and locator inserted before the end record (consistent values)."""
    e = eocd_at(data)
    count, size_cd, off_cd = struct.unpack_from("<H", data, e + 10)[0], *struct.unpack_from("<LL", data, e + 12)
    rec64 = struct.pack("<4sQ2H2L4Q", b"PK\x06\x06", 44, 45, 45, 0, 0, count, count, size_cd, off_cd)
    loc = struct.pack("<4sLQL", b"PK\x06\x07", 0, e, 1)
    return data[:e] + rec64 + loc + data[e:]


def make_zips(folder):
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    obj, mtl, png = b"v 0 0 0\n", b"newmtl a\n", b"\x89PNG\r\n\x1a\n"
    cube = (REPO / "fixtures/models/cube-obj.zip").read_bytes()
    good = zbytes([("cube/cube.obj", obj), ("cube/cube.mtl", mtl), ("cube/tex.png", png)])
    link = (stat.S_IFLNK | 0o777) << 16
    corpus = {
        "fixture-cube": cube,
        "good": good,
        "good-comment": zbytes([("a.obj", obj)], comment=b"hello comment"),
        "slip": zbytes([("a.obj", obj), ("../../escaped.txt", b"x")]),
        "slip-obj": zbytes([("a/../../b.obj", obj)]),
        "abs": zbytes([("a.obj", obj), ("/tmp/midstudy-escaped.txt", b"x")]),
        "backslash": zbytes([("a.obj", obj), ("dir\\b.png", png)]),
        "drive": zbytes([("a.obj", obj), ("C:x.png", png)]),
        "link": zbytes([("a.obj", obj), ("link.png", b"/etc/passwd", link)]),
        "exe": zbytes([("a.obj", obj), ("run.exe", b"x")]),
        "upper-ext": zbytes([("A.OBJ", obj), ("A.MTL", mtl), ("T.JPEG", b"\xff\xd8\xff")]),
        "no-obj": zbytes([("a.mtl", mtl)]),
        "two-obj": zbytes([("a.obj", obj), ("b.obj", obj)]),
        "macosx": zbytes([("a.obj", obj), ("__MACOSX/._a.obj", b"junk"), ("dir/.DS_Store", b"junk"), ("dir/", b"")]),
        "dir-only": zbytes([("dir/", b"")]),
        "dot-segments": zbytes([("./a.obj", obj), ("x/./b.png", png)]),
        "too-many": zbytes([("a.obj", obj)] + [(f"t{i}.png", b"") for i in range(1000)]),
        "exactly-1000": zbytes([("a.obj", obj)] + [(f"t{i}.png", b"") for i in range(999)]),
        "empty-file": b"",
        "tiny": b"PK\x05\x06",
        "not-zip": b"this is not a zip file at all, just some text that is longer than twenty-two bytes",
        "empty-zip": zbytes([]),
        "eocd-zeros": b"\x00" * 100 + struct.pack("<4s4H2LH", b"PK\x05\x06", 0, 0, 0, 0, 0, 0, 0),
        "truncated-cd": (lambda g, e: g[:e] + b"\x00" * 30 + g[e:e + 12] + struct.pack("<L", struct.unpack_from("<L", g, e + 12)[0] + 30) + g[e + 16:])(good, eocd_at(good)),
        "junk-after-cd": (lambda g, e: g[:e] + b"\x00" * 60 + g[e:e + 12] + struct.pack("<L", struct.unpack_from("<L", g, e + 12)[0] + 60) + g[e + 16:])(good, eocd_at(good)),
        "cut-in-cd": good[:cd_start(good) + 20] + good[eocd_at(good):],
        "bad-cd-magic": patch_central(good, 0, "<4s", 0, b"XK\x01\x02"),
        "bad-offset": (lambda g: g[:eocd_at(g) + 12] + struct.pack("<LL", len(g) * 4, 0) + g[eocd_at(g) + 20:])(good),
        "prepended": b"#!/bin/sh\necho prepended\n" + good,
        "version-64": patch_central(good, 1, "<B", 6, 64),
        "version-63": patch_central(good, 1, "<B", 6, 63),
        "huge-size": patch_central(zbytes([("a.obj", obj)]), 0, "<L", 24, 600 * 1000 * 1000),
        "sum-500": patch_central(patch_central(zbytes([("a.obj", obj), ("b.png", png)]), 0, "<L", 24, 300 * 1024 * 1024), 1, "<L", 24, 200 * 1024 * 1024),
        "sum-500-1": patch_central(patch_central(zbytes([("a.obj", obj), ("b.png", png)]), 0, "<L", 24, 300 * 1024 * 1024), 1, "<L", 24, 200 * 1024 * 1024 + 1),
        "big-skipped": patch_central(zbytes([("a.obj", obj), ("__MACOSX/x", b"x")]), 1, "<L", 24, 900 * 1000 * 1000),
        "extra-corrupt": with_extra("a.obj", obj, struct.pack("<HH", 0x5455, 40) + b"\x00" * 4),
        "extra-short-header": with_extra("a.obj", obj, b"\x01\x02\x03"),
        "zip64-extra": patch_central(with_extra("a.obj", obj, struct.pack("<HHQ", 1, 8, len(obj))), 0, "<L", 24, 0xFFFFFFFF),
        "zip64-extra-big": patch_central(with_extra("a.obj", obj, struct.pack("<HHQ", 1, 8, 700 * 1000 * 1000)), 0, "<L", 24, 0xFFFFFFFF),
        "zip64-extra-short": patch_central(with_extra("a.obj", obj, struct.pack("<HH", 1, 4) + b"\x00" * 4), 0, "<L", 24, 0xFFFFFFFF),
        "zip64-compress-short": patch_central(patch_central(with_extra("a.obj", obj, struct.pack("<HHQ", 1, 8, len(obj))), 0, "<L", 24, 0xFFFFFFFF), 0, "<L", 20, 0xFFFFFFFF),
        "zip64-offset-short": patch_central(with_extra("a.obj", obj, struct.pack("<HH", 1, 0)), 0, "<L", 42, 0xFFFFFFFF),
        "unicode-path": with_extra("a.txt", obj, unicode_path(b"a.txt", "a.obj".encode())),
        "unicode-path-bad-crc": with_extra("a.txt", obj, unicode_path(b"a.txt", "a.obj".encode(), crc=1)),
        "unicode-path-v2": with_extra("a.txt", obj, unicode_path(b"a.txt", "a.obj".encode(), version=2)),
        "unicode-path-short": with_extra("a.obj", obj, struct.pack("<HH", 0x7075, 3) + b"\x01\x00\x00"),
        "unicode-path-bad-utf8": with_extra("a.obj", obj, unicode_path(b"a.obj", b"\xff\xfe.obj")),
        "unicode-path-empty": with_extra("a.obj", obj, unicode_path(b"a.obj", b"")),
        "unicode-path-climbs": with_extra("a.obj", obj, unicode_path(b"a.obj", "../é.obj".encode())),
        "cp437-name": with_extra("x", obj, b"", raw_name=b"caf\x82.obj"),
        "utf8-name": with_extra("x", obj, b"", flags=0x800, raw_name="café.obj".encode()),
        "zip64-eocd": zip64_records(good),
        "zip64-eocd-bad-disks": (lambda z: z[:z.rfind(b"PK\x06\x07") + 4] + struct.pack("<L", 1) + z[z.rfind(b"PK\x06\x07") + 8:])(zip64_records(good)),
        "zip64-eocd-corrupt": (lambda z: z[:z.rfind(b"PK\x06\x06") + 4] + struct.pack("<Q", 99) + z[z.rfind(b"PK\x06\x06") + 12:])(zip64_records(good)),
        "zip64-eocd-missing": (lambda z: z[:z.rfind(b"PK\x06\x06")] + b"XX" + z[z.rfind(b"PK\x06\x06") + 2:])(zip64_records(good)),
        "zip64-locator-past": (lambda z: z[:z.rfind(b"PK\x06\x07") + 8] + struct.pack("<Q", 10 ** 9) + z[z.rfind(b"PK\x06\x07") + 16:])(zip64_records(good)),
        "locator-at-start": struct.pack("<4sLQL", b"PK\x06\x07", 0, 0, 1) + struct.pack("<4s4H2LH", b"PK\x05\x06", 0, 0, 0, 0, 0, 0, 0),
        "comment-len-wrong": good[:-2] + struct.pack("<H", 5),
        "trailing-junk": good + b"junk",
    }
    names = []
    for name, data in corpus.items():
        (folder / f"{name}.zip").write_bytes(data)
        names.append(name)
    return names


FNS = {"check_meta": check_meta, "add_command": add_command, "zip_problem": zip_problem, "make_zips": make_zips,
       "num_text": serve.num_text}


def main():
    cases = json.load(sys.stdin)
    out = []
    for c in cases:
        try:
            out.append({"ok": FNS[c["fn"]](*c["args"])})
        except Exception as e:  # noqa: BLE001 - the answer is the exception
            out.append({"error": f"{type(e).__name__}: {e}"})
    json.dump(out, sys.stdout)


main()
