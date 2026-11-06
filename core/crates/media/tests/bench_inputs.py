#!/usr/bin/env python3
"""Writes the files the media benchmarks time (docs/notes/k-media.md, docs/notes/kernels-hardening.md) into
evals/out/kh/bench-inputs/ (git-ignored), deterministically (seeded), so before/after runs time the same bytes.

    evals/py core/crates/media/tests/bench_inputs.py

Files: big12mp.jpg (evals/lib/metadata.py's smooth 12 MP JPEG), photo12mp-gps.jpg (a photo-like 12 MP JPEG, q92, with
EXIF/GPS), photo12mp-trailer.jpg (the same with 200 KB appended after EOI), prog12mp-gps.jpg (a smooth progressive
12 MP JPEG with EXIF/GPS), png3mp-exif.png (a noisy 3 MP RGB PNG with eXIf), glb-photo.glb (a GLB textured with
photo12mp-gps.jpg), gps.glb (metadata.py's small GPS GLB) and SheenChair.glb (fixtures/models, nothing to strip).
"""
from __future__ import annotations

import io
import shutil
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[4]
sys.path[:0] = [str(REPO / "evals" / "lib")]
import metadata  # noqa: E402  evals/lib/metadata.py

OUT = REPO / "evals" / "out" / "kh" / "bench-inputs"


def photo_like(w: int, h: int, seed: int) -> Image.Image:
    """Smooth gradients plus seeded noise: entropy-coded data about the size of a real photo's at q92."""
    rng = np.random.default_rng(seed)
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    base = np.stack([x / w * 200, y / h * 200, (x + y) / (w + h) * 255], axis=-1)
    noise = rng.normal(0, 18, size=(h, w, 3)).astype(np.float32)
    return Image.fromarray(np.clip(base + noise, 0, 255).astype(np.uint8), "RGB")


def jpeg(im: Image.Image, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "JPEG", **kw)
    return buf.getvalue()


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    metadata.make("big12mp", OUT / "big12mp.jpg", None, None)
    metadata.make("gps-glb", OUT / "gps.glb", None, None)
    photo = jpeg(photo_like(4000, 3000, 1), quality=92, exif=metadata.gps_exif(6))
    (OUT / "photo12mp-gps.jpg").write_bytes(photo)
    (OUT / "photo12mp-trailer.jpg").write_bytes(photo + bytes(np.random.default_rng(2).integers(0, 256, 200_000, dtype=np.uint8)))
    g = Image.linear_gradient("L").resize((4000, 3000))
    smooth = Image.merge("RGB", (g, g.transpose(Image.Transpose.FLIP_LEFT_RIGHT), g))
    (OUT / "prog12mp-gps.jpg").write_bytes(jpeg(smooth, quality=90, progressive=True, exif=metadata.gps_exif()))
    buf = io.BytesIO()
    photo_like(2000, 1500, 3).save(buf, "PNG", exif=metadata.gps_exif(), compress_level=6)
    (OUT / "png3mp-exif.png").write_bytes(buf.getvalue())
    (OUT / "glb-photo.glb").write_bytes(metadata.gps_glb(photo))
    shutil.copyfile(REPO / "fixtures" / "models" / "SheenChair.glb", OUT / "SheenChair.glb")
    for f in sorted(OUT.iterdir()):
        print(f"{f.name:24} {f.stat().st_size:>10} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
