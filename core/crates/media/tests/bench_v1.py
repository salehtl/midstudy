#!/usr/bin/env python3
"""Times v1's Python strip functions on the files the Rust benches use (docs/notes/k-media.md).

    evals/py core/crates/media/tests/bench_v1.py <op> <file> [runs]     op: jpeg | png | glb

jpeg: planner/serve.py clean_jpeg; png: pipeline glb.py clean_png; glb: what v1's pipeline did to a GLB's textures,
bytes in to bytes out (read_glb's parse on the bytes, scrub_images, write_glb's serialisation). Median and fastest of
`runs` (default 15) after one warm-up, in ms; the file is read once, outside the timing.
"""
from __future__ import annotations

import copy
import json
import struct
import sys
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(REPO / "planner"), str(REPO / "pipeline" / "src")]

import serve  # noqa: E402
from midstudy_pipeline import glb as pglb  # noqa: E402


def glb_v1(data: bytes) -> bytes:
    """read_glb on bytes (its loop, without the file read), scrub_images, write_glb's serialisation."""
    version, length = struct.unpack_from("<II", data, 4)
    doc, blob, off = None, None, 12
    end = min(length, len(data))
    while off + 8 <= end:
        size, kind = struct.unpack_from("<II", data, off)
        chunk = data[off + 8: off + 8 + size]
        off += 8 + size
        if kind == 0x4E4F534A and doc is None:
            doc = json.loads(chunk.decode("utf-8"))
        elif kind == 0x004E4942 and blob is None:
            blob = bytes(chunk)
    doc = copy.deepcopy(doc)
    blob, _ = pglb.scrub_images(doc, blob)
    j = json.dumps(doc, separators=(",", ":")).encode("utf-8")
    j += b" " * (-len(j) % 4)
    body = struct.pack("<II", len(j), 0x4E4F534A) + j
    if blob is not None:
        b = blob + b"\0" * (-len(blob) % 4)
        body += struct.pack("<II", len(b), 0x004E4942) + b
    return b"glTF" + struct.pack("<II", 2, 12 + len(body)) + body


def main() -> None:
    op, file = sys.argv[1], sys.argv[2]
    runs = int(sys.argv[3]) if len(sys.argv) > 3 else 15
    data = Path(file).read_bytes()
    fn = {"jpeg": serve.clean_jpeg, "png": pglb.clean_png, "glb": glb_v1}[op]
    out = fn(data)
    times = []
    for _ in range(max(1, runs)):
        t = time.perf_counter()
        fn(data)
        times.append((time.perf_counter() - t) * 1000)
    times.sort()
    print(json.dumps({"op": op, "file": file, "bytes": len(data), "out_bytes": len(out) if out else None, "runs": len(times),
                      "median_ms": round(times[len(times) // 2], 3), "best_ms": round(times[0], 3)}))


if __name__ == "__main__":
    main()
