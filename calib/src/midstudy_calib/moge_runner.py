"""Loading and running MoGe-2 (git+https://github.com/microsoft/MoGe, pinned in pyproject.toml): calib's one untyped
boundary. MoGe and torch go in here; typed numpy arrays come out (MogeOutput).

Weights come from Hugging Face on first use and live in the Hugging Face cache (~/.cache/huggingface, or HF_HUB_CACHE),
never in the repo. The default model's revision is pinned (the one nix/moge-weights.nix fetches), so a cached
checkpoint loads without asking the Hub whether `main` moved (about 0.5 s, and a hang when the network is down).

Loaded networks are kept in this process (one model at a time), so `midstudy-calib serve` loads MoGe once; the
one-shot CLI loads it once per run as before.
"""
from __future__ import annotations

import contextlib
import gc
import importlib
import os
import sys
import time
import types
from collections.abc import Callable, Generator, Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Protocol, cast

import numpy as np
from numpy.typing import NDArray

from .records import Device, Model, RealDevice
from .util import log

if TYPE_CHECKING:
    import torch

MODELS: dict[Model, str] = {
    "vitl": "Ruicheng/moge-2-vitl-normal",
    "vitb": "Ruicheng/moge-2-vitb-normal",
    "vits": "Ruicheng/moge-2-vits-normal",
}
# The revisions calib measured with (docs/notes/calib.md). vitl's is the one nix/moge-weights.nix fetches; vitb and
# vits follow the Hub's main.
REVISIONS: dict[Model, str] = {"vitl": "cb0e8bbd6b1e243589717c78e750b1ba4c093acf"}


class MogeNet(Protocol):
    """What calib uses of a MoGe-2 network (moge.model.v2.MoGeModel)."""

    def infer(self, image: torch.Tensor, *, use_fp16: bool) -> Mapping[str, torch.Tensor]: ...
    def to(self, device: str) -> object: ...


@dataclass
class Loaded:
    """A MoGe-2 network in this process: its Hugging Face repo, the device it sits on, how long loading took."""

    net: MogeNet
    model: Model
    repo: str
    load_s: float
    device: str = "cpu"


@dataclass(frozen=True)
class MogeOutput:
    """MoGe-2's output, numpy, in the OpenCV camera frame (x right, y down, z forward): points (h, w, 3) metric,
    normal (h, w, 3) unit (None from a model without normals), mask (h, w) valid pixels, intrinsics (3, 3) normalized
    (fx in units of the width, fy of the height); plus the seconds this request spent loading (0 when the network
    was already loaded) and inferring, and the weights' repo."""

    points: NDArray[np.float32]
    normal: NDArray[np.float32] | None
    mask: NDArray[np.bool_]
    intrinsics: NDArray[np.float32]
    load_s: float
    infer_s: float
    repo: str


_LOADED: dict[Model, Loaded] = {}


def _torch() -> None:
    # Must be set before torch initializes MPS: ops MPS lacks run on the CPU instead of failing.
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")


def _real_signal() -> types.ModuleType:
    """scipy.signal itself (the stand-in, if it is still registered, steps aside first)."""
    if isinstance(sys.modules.get("scipy.signal"), _DeferredSignal):
        del sys.modules["scipy.signal"]
    return importlib.import_module("scipy.signal")


def _deferred_fftconvolve(*args: object, **kwargs: object) -> object:
    real: Callable[..., object] = getattr(_real_signal(), "fftconvolve")  # noqa: B009 - a module's attribute by name
    return real(*args, **kwargs)


class _DeferredSignal(types.ModuleType):
    """Stands in for scipy.signal while MoGe imports: `fftconvolve` imports the real module on its first call, any
    other attribute as soon as it is asked for."""

    fftconvolve = staticmethod(_deferred_fftconvolve)

    def __getattr__(self, name: str) -> object:
        if name.startswith("__"):  # the import system asks for __path__ and the like: not a reason to load scipy
            raise AttributeError(name)
        return getattr(_real_signal(), name)


def import_moge() -> None:
    """Import MoGe-2's network module without scipy.signal. moge/utils/geometry_numpy.py imports it at the top for a
    blur that inference never calls, and it costs 1.6-2.1 s (scipy.stats, interpolate and optimize behind it), a third
    of a one-shot run's start. While MoGe imports, _DeferredSignal answers `from scipy.signal import fftconvolve`; then
    it leaves sys.modules, so everything else gets the real module (MoGe's own solver imports scipy.optimize when it
    first runs, as before)."""
    if "moge.model.v2" in sys.modules or "scipy.signal" in sys.modules:
        return
    stand_in = _DeferredSignal("scipy.signal")
    sys.modules["scipy.signal"] = stand_in
    try:
        importlib.import_module("moge.model.v2")
    finally:
        if sys.modules.get("scipy.signal") is stand_in:
            del sys.modules["scipy.signal"]


def pick_device(want: Device) -> RealDevice:
    """auto: cuda, then mps, then cpu (contract §4.3). An explicit choice that isn't available falls back to cpu."""
    _torch()
    import torch

    has: dict[RealDevice, bool] = {"cuda": torch.cuda.is_available(), "mps": torch.backends.mps.is_available(), "cpu": True}
    if want == "auto":
        return next(d for d in ("cuda", "mps", "cpu") if has[d])
    if not has[want]:
        log(f"device {want} isn't available here: using cpu")
        return "cpu"
    return want


def _checkpoint(model: Model) -> Path:
    """model.pt in the Hugging Face cache (downloaded on first use): the pinned revision when there is one, else the
    Hub's main (also when the pinned one can't be had, e.g. a cache that only holds another revision, offline)."""
    from huggingface_hub import hf_hub_download  # pyright: ignore[reportUnknownVariableType] - its user_agent: dict is untyped

    repo, rev = MODELS[model], REVISIONS.get(model)
    if rev:
        try:
            return Path(hf_hub_download(repo_id=repo, filename="model.pt", revision=rev))
        except Exception as e:
            log(f"{repo}@{rev[:7]} isn't available ({type(e).__name__}); trying the Hub's main")
    return Path(hf_hub_download(repo_id=repo, filename="model.pt"))


@contextlib.contextmanager
def _no_weight_init() -> Generator[None]:
    """Skip random weight initialization while MoGe builds its network. DINOv2 ViT-L draws ~300M truncated-normal values
    in its constructor (3.4 s on the M3 Max); every one of them is then overwritten from the checkpoint, which
    load_state_dict(strict=True) checks, so the network is the same (measured: identical state and outputs)."""
    from moge.model.dinov2.models import vision_transformer as vt  # pyright: ignore[reportMissingTypeStubs]
    from torch.nn import init

    names = ("trunc_normal_", "normal_", "uniform_", "zeros_", "ones_", "constant_", "kaiming_uniform_", "kaiming_normal_",
             "xavier_uniform_", "xavier_normal_")
    saved: dict[str, object] = {n: getattr(init, n) for n in names}
    saved_vt: object = vt.trunc_normal_

    def skip(t: torch.Tensor, *_: object, **__: object) -> torch.Tensor:
        return t

    for n in names:
        setattr(init, n, skip)
    vt.trunc_normal_ = skip
    try:
        yield
    finally:
        for n, f in saved.items():
            setattr(init, n, f)
        vt.trunc_normal_ = saved_vt


def _build(checkpoint: Path) -> MogeNet:
    """MoGeModel.from_pretrained's work (moge/model/v2.py) with the initialization skipped; when the checkpoint doesn't
    cover every parameter, built and loaded exactly as MoGe does (strict=False)."""
    import torch

    import_moge()
    from moge.model.v2 import MoGeModel  # pyright: ignore[reportMissingTypeStubs]

    ck = cast(dict[str, object], torch.load(checkpoint, map_location="cpu", weights_only=True))
    config = cast(dict[str, object], ck["model_config"])
    state = cast(Mapping[str, torch.Tensor], ck["model"])
    make = cast(Callable[..., torch.nn.Module], MoGeModel)
    try:
        with _no_weight_init():
            net = make(**config)
        net.load_state_dict(state, strict=True)
    except RuntimeError as e:  # the checkpoint misses or adds keys: never leave uninitialized weights in use
        log(f"MoGe's checkpoint doesn't match its network exactly ({str(e).splitlines()[0][:120]}); building it the slow way")
        net = make(**config)
        net.load_state_dict(state, strict=False)
    return cast(MogeNet, net.eval())


def load(model: Model) -> tuple[Loaded, float]:
    """The MoGe-2 network, loaded once per process (on the CPU first; infer moves it), and the seconds this call spent
    loading it (0 when it was already loaded). A different model replaces the one held, so a worker never holds two."""
    _torch()
    held = _LOADED.get(model)
    if held is not None:
        log(f"{held.repo} is loaded already")
        return held, 0.0
    unload()
    repo = MODELS[model]
    t0 = time.monotonic()
    net = _build(_checkpoint(model))
    loaded = Loaded(net=net, model=model, repo=repo, load_s=time.monotonic() - t0)
    _LOADED[model] = loaded
    log(f"loaded {repo} in {loaded.load_s:.1f} s")
    return loaded, loaded.load_s


def unload() -> None:
    """Drop the network held (and the GPU memory it used)."""
    if not _LOADED:
        return
    _LOADED.clear()
    gc.collect()
    import torch

    if torch.backends.mps.is_available():
        torch.mps.empty_cache()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _f32(t: torch.Tensor) -> NDArray[np.float32]:
    return np.asarray(t.detach().float().cpu().numpy(), np.float32)


def infer(loaded: Loaded, rgb: NDArray[np.uint8], device: RealDevice, load_s: float) -> MogeOutput:
    """Run MoGe-2 on an RGB uint8 array (h, w, 3) on `device` (the network moves there and stays)."""
    import torch

    t0 = time.monotonic()
    if loaded.device != device:
        loaded.net.to(device)
        loaded.device = device
    x = torch.tensor(np.ascontiguousarray(rgb), dtype=torch.float32, device=device).permute(2, 0, 1) / 255.0
    with torch.inference_mode():
        out = loaded.net.infer(x, use_fp16=device != "cpu")
    if device == "mps":
        torch.mps.synchronize()
    elif device == "cuda":
        torch.cuda.synchronize()
    infer_s = time.monotonic() - t0
    log(f"MoGe inference on {device}, {rgb.shape[1]} x {rgb.shape[0]}, in {infer_s:.1f} s")
    normal = out.get("normal")
    return MogeOutput(points=_f32(out["points"]), normal=None if normal is None else _f32(normal),
                      mask=np.asarray(out["mask"].cpu().numpy(), np.bool_), intrinsics=_f32(out["intrinsics"]),
                      load_s=load_s, infer_s=infer_s, repo=loaded.repo)
