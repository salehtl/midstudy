"""Decode every golden depth.png with Pillow (the reference the Rust decoder must equal) and print, per scene, its
size and the SHA-256 of its samples as little-endian u16, as the Rust test `golden_depth` records them.

Usage (from the repo root): evals/py core/crates/raster/tests/support/pil_depth.py
"""
import hashlib
import sys
from pathlib import Path

import numpy as np
from PIL import Image

REPO = Path(__file__).resolve().parents[5]
for d in sorted((REPO / "fixtures/scenes").iterdir()):
    f = d / "depth.png"
    if not f.is_file():
        continue
    img = Image.open(f)
    a = np.asarray(img).astype("<u2")
    h, w = a.shape
    digest = hashlib.sha256(a.tobytes()).hexdigest()
    print(f'("{d.name}", {w}, {h}, {int(a.sum())}, "{digest}"),')
sys.exit(0)
