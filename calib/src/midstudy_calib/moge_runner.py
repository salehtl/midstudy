"""Loading and running MoGe-2 (git+https://github.com/microsoft/MoGe, pinned in pyproject.toml).

Weights come from Hugging Face on first use and live in the Hugging Face cache (~/.cache/huggingface, or HF_HOME),
never in the repo.
"""
from __future__ import annotations

import os
import time

from .util import log

MODELS = {
    "vitl": "Ruicheng/moge-2-vitl-normal",
    "vitb": "Ruicheng/moge-2-vitb-normal",
    "vits": "Ruicheng/moge-2-vits-normal",
}


def _torch():
    # Must be set before torch initializes MPS: ops MPS lacks run on the CPU instead of failing.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    import torch

    return torch


def pick_device(want: str) -> str:
    """auto: cuda, then mps, then cpu (contract §4.3). An explicit choice that isn't available falls back to cpu."""
    torch = _torch()
    has = {"cuda": torch.cuda.is_available(),
           "mps": bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available()),
           "cpu": True}
    if want == "auto":
        return next(d for d in ("cuda", "mps", "cpu") if has[d])
    if not has[want]:
        log(f"device {want} isn't available here: using cpu")
        return "cpu"
    return want


def load(model: str):
    """The MoGe-2 network on the CPU (weights from the Hugging Face cache, downloaded on first use)."""
    _torch()
    from moge.model.v2 import MoGeModel

    repo = MODELS[model]
    t0 = time.monotonic()
    net = MoGeModel.from_pretrained(repo).eval()
    net.repo, net.load_s = repo, time.monotonic() - t0
    log(f"loaded {repo} in {net.load_s:.1f} s")
    return net


def infer(net, rgb, device: str) -> dict:
    """Run MoGe-2 on an RGB uint8 array (h, w, 3). Returns numpy arrays in the OpenCV camera frame:
    points (h, w, 3) metric, normal (h, w, 3), mask (h, w) bool, intrinsics (3, 3) normalized, plus timings."""
    import numpy as np

    torch = _torch()
    t0 = time.monotonic()
    net = net.to(device)
    x = torch.tensor(np.ascontiguousarray(rgb), dtype=torch.float32, device=device).permute(2, 0, 1) / 255.0
    with torch.inference_mode():
        out = net.infer(x, use_fp16=device != "cpu")
    if device == "mps":
        torch.mps.synchronize()
    elif device == "cuda":
        torch.cuda.synchronize()
    infer_s = time.monotonic() - t0
    log(f"MoGe inference on {device}, {rgb.shape[1]} x {rgb.shape[0]}, in {infer_s:.1f} s")
    res = {k: v.detach().float().cpu().numpy() if v.dtype != torch.bool else v.cpu().numpy() for k, v in out.items()}
    res["load_s"], res["infer_s"], res["repo"] = net.load_s, infer_s, net.repo
    return res
