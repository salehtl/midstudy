"""MASt3R (github.com/naver/mast3r), the learned pose solver chosen at Gate A (docs/ROOMS.md §2): this package's one
untyped boundary. MASt3R and torch go in here; View objects (typed numpy) come out, and solver.from_views turns them
into §4.9 poses.

Install: the optional `rooms` extra (`uv sync --project calib --extra rooms`) adds MASt3R's Python dependencies.
MASt3R itself isn't a Python package: its code (with the dust3r and croco submodules) is a git checkout at a pinned
commit, and its weights a Hugging Face snapshot at a pinned revision, both cached outside the repo on first use:

    code     $MIDSTUDY_MAST3R_DIR (default ~/.cache/midstudy-calib/mast3r), `git clone --recursive` once
    weights  the Hugging Face cache (~/.cache/huggingface, or HF_HUB_CACHE), naver/MASt3R_ViTLarge_BaseDecoder_512_
             catmlpdpt_metric at REVISION (2.6 GB), downloaded once

After that it runs offline: the checkout is used as it is when its HEAD is the pinned commit and its stamp
(.midstudy-ready, written once the submodules are in) says so, and the weights load from the local snapshot
(local_files_only) without asking the Hub. The photos never leave this machine.

The checkout is calib's cache, provisioned under a lock beside it: a checkout that isn't ready is forced to the pinned
commit, so hand edits in a MIDSTUDY_MAST3R_DIR that lacks the stamp are lost.

Licence: CC BY-NC-SA 4.0 (non-commercial), the checkpoint also bound by its training sets' terms (Gate A: accepted for
this personal tool). Phase A measured ~1 min for 7 photos and ~2.3 min for 11 on MPS (M3 Max), ~11.5 GB peak.

How it runs (Phase A's spike, calib/spike/run.py): the photos reach MASt3R as symlinks named m00.jpg, m01.jpg, … in a
temp folder (its forward cache keys on file names), at 512 px; every pair for up to COMPLETE_MAX photos (a sliding
window in room order with loop closure above that, so 32 photos stay inside the server's 600 s: the planner uploads a
room's photos in the order taken, docs/ROOMS.md §7, so neighbours overlap); sparse global alignment as its
demo runs it; the dense depth maps and per-view camera-to-world poses come back for from_views.
"""
from __future__ import annotations

import fcntl
import importlib
import importlib.util
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Final

import numpy as np

from ..records import RealDevice
from ..util import Fail, log, write_atomic
from .geometry import F64
from .photos import RoomPhoto
from .score import Candidate
from .solver import SolverName, SolverUnavailable, View, from_views

REPO_URL: Final = "https://github.com/naver/mast3r"
COMMIT: Final = "f5209afc300cec36239a7ac992263f36847bbba0"  # Phase A's (dust3r 3cc8c88, croco d7de070 as submodules)
WEIGHTS: Final = "naver/MASt3R_ViTLarge_BaseDecoder_512_catmlpdpt_metric"
REVISION: Final = "06e7259f34c3060f322df5cb0c7b9094f57e41fc"
SIZE: Final = 512
COMPLETE_MAX: Final = 12  # photos up to which every pair is matched (Phase A measured 7 and 11: 21 and 55 pairs)
# Above that, each photo with the next w in room order, cyclic, w = PAIR_BUDGET // n within 2..5: ~2.5 s a pair on MPS
# (22 photos, 110 pairs: 282 s), so 32 photos (w 4, 128 pairs) stay well inside the server's 600 s.
PAIR_BUDGET: Final = 130
# The extra's modules MASt3R imports beyond calib's own dependencies (pyproject.toml [project.optional-dependencies] rooms)
MODULES: Final = ("roma", "einops", "safetensors", "tqdm")

STAMP: Final = ".midstudy-ready"  # in the checkout: holds COMMIT once the submodules are in

_LOADED: dict[str, Any] = {}  # device -> the network, kept for the worker


def installed() -> bool:
    """Whether the `rooms` extra is installed (the code and weights are fetched on first use)."""
    return all(importlib.util.find_spec(m) is not None for m in MODULES)


def code_dir() -> Path:
    return Path(os.environ.get("MIDSTUDY_MAST3R_DIR") or Path.home() / ".cache/midstudy-calib/mast3r")


def _git(*args: str, cwd: Path | None = None) -> str:
    p = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True, check=False)
    if p.returncode != 0:
        raise SolverUnavailable(f"couldn't fetch MASt3R's code (git {args[0]}: {' '.join(p.stderr.split())[:200] or p.returncode})")
    return p.stdout.strip()


def _ready(root: Path) -> bool:
    """Whether the checkout is whole: the stamp written after its submodules, for the commit HEAD is at."""
    stamp = root / STAMP
    if not stamp.is_file() or stamp.read_text() != COMMIT:
        return False
    try:
        return _git("rev-parse", "HEAD", cwd=root) == COMMIT
    except SolverUnavailable:
        return False


def _provision(root: Path) -> None:
    """Bring the checkout to the pinned commit and stamp it. The stamp goes first, so a kill anywhere reads as not ready."""
    (root / STAMP).unlink(missing_ok=True)
    log(f"align-room: fetching MASt3R's code at {COMMIT[:7]} into {root} (once)")
    if not (root / ".git").exists():
        _git("clone", "--quiet", REPO_URL, str(root))
    try:
        _git("checkout", "--quiet", "--force", COMMIT, cwd=root)
    except SolverUnavailable:
        _git("fetch", "--quiet", "origin", COMMIT, cwd=root)
        _git("checkout", "--quiet", "--force", COMMIT, cwd=root)
    _git("submodule", "update", "--quiet", "--init", "--recursive", "--force", cwd=root)
    write_atomic(root / STAMP, COMMIT.encode())


def ensure_code() -> Path:
    """The pinned checkout of MASt3R (with its submodules), cloned on first use; no network once it is there. One
    process at a time: the others wait on the lock and find it ready."""
    root = code_dir()
    if (root / STAMP).is_file() and not (root / ".git").exists():
        # A read-only copy without .git (the Nix package's, nix/mast3r.nix): its stamp is all there is to check, and
        # neither the lock nor a provision can be written next to it.
        if (root / STAMP).read_text() == COMMIT:
            return root
        raise SolverUnavailable(f"MASt3R's code at {root} is not the pinned commit {COMMIT[:7]}")
    root.parent.mkdir(parents=True, exist_ok=True)
    with (root.parent / ".mast3r.lock").open("a+") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        try:
            if not _ready(root):
                _provision(root)
        finally:
            fcntl.flock(lock, fcntl.LOCK_UN)
    return root


def ensure_weights() -> Path:
    """The pinned weights' local snapshot folder, downloaded from Hugging Face on first use only."""
    # huggingface_hub's signature has a partly unknown type (tqdm's): called through Any
    snapshot_download: Any = getattr(importlib.import_module("huggingface_hub"), "snapshot_download")  # noqa: B009
    try:
        return Path(snapshot_download(WEIGHTS, revision=REVISION, local_files_only=True))
    except Exception:  # not cached yet (huggingface_hub's LocalEntryNotFoundError, or an incomplete snapshot)
        log(f"align-room: downloading MASt3R's weights ({WEIGHTS} at {REVISION[:7]}, 2.6 GB) into the Hugging Face cache (once)")
    try:
        return Path(snapshot_download(WEIGHTS, revision=REVISION))
    except Exception as e:
        raise SolverUnavailable(f"couldn't download MASt3R's weights ({type(e).__name__})") from None


def _import(root: Path) -> None:
    for p in (root, root / "dust3r", root / "dust3r/croco"):
        if str(p) not in sys.path:
            sys.path.insert(0, str(p))
    hierarchy = importlib.import_module("scipy.cluster.hierarchy")
    if not hasattr(hierarchy, "distance"):  # sparse_ga.py calls scipy.cluster.hierarchy.distance, an alias newer scipy dropped
        setattr(hierarchy, "distance", importlib.import_module("scipy.spatial.distance"))  # noqa: B010


def _cant_load(e: Exception) -> SolverUnavailable:
    return SolverUnavailable(f"MASt3R couldn't load ({type(e).__name__}: {' '.join(str(e).split())[:160]})")


def load(device: RealDevice) -> Any:
    """The network on `device`, loaded once per process (the worker keeps it). Any failure here is SolverUnavailable,
    so --solver auto falls back (a missing module, a bad snapshot, no git, out of memory on the device)."""
    if device in _LOADED:
        return _LOADED[device]
    t0 = time.monotonic()
    os.environ.setdefault("TQDM_DISABLE", "1")  # MASt3R's progress bars would flood stderr, the server's job progress
    try:
        root = ensure_code()
        weights = ensure_weights()
        _import(root)
        model_cls: Any = getattr(importlib.import_module("mast3r.model"), "AsymmetricMASt3R")  # noqa: B009
        net = model_cls.from_pretrained(str(weights)).to(device)
    except Fail:
        raise
    except Exception as e:
        raise _cant_load(e) from None
    net.eval()
    _LOADED.clear()  # one device at a time
    _LOADED[device] = net
    log(f"align-room: MASt3R loaded on {device} in {time.monotonic() - t0:.1f} s")
    return net


def _np(t: Any) -> F64:
    return np.asarray(t.detach().float().cpu().numpy(), dtype=np.float64)


def scene_graph(n: int) -> str:
    """MASt3R's pairs (dust3r make_pairs): every pair up to COMPLETE_MAX photos, else a cyclic sliding window."""
    return "complete" if n <= COMPLETE_MAX else f"swin-{max(2, min(5, PAIR_BUDGET // n))}"


class Mast3r:
    """The Solver protocol's MASt3R implementation (module doc)."""

    @property
    def name(self) -> SolverName:
        return "mast3r"

    @property
    def uses_torch(self) -> bool:
        return True

    def solve(self, photos: list[RoomPhoto], device: RealDevice) -> list[Candidate | None]:
        import torch

        net = load(device)
        try:
            make_pairs: Any = getattr(importlib.import_module("dust3r.image_pairs"), "make_pairs")  # noqa: B009
            load_images: Any = getattr(importlib.import_module("dust3r.utils.image"), "load_images")  # noqa: B009
            sparse_ga: Any = getattr(importlib.import_module("mast3r.cloud_opt.sparse_ga"), "sparse_global_alignment")  # noqa: B009
        except ImportError as e:
            raise _cant_load(e) from None
        seed: Any = getattr(torch, "manual_seed")  # noqa: B009 - torch's stub leaves the argument untyped
        seed(0)
        t0 = time.monotonic()
        with tempfile.TemporaryDirectory(prefix="midstudy-align-room-") as tmp:
            paths: list[str] = []
            for i, s in enumerate(photos):  # distinct names: MASt3R's cache keys on them (symlinks, no copies)
                p = Path(tmp) / f"m{i:02d}.jpg"
                p.symlink_to((s.path / "photo.jpg").resolve())
                paths.append(str(p))
            imgs: Any = load_images(paths, size=SIZE, verbose=False)
            graph = scene_graph(len(photos))
            pairs: Any = make_pairs(imgs, scene_graph=graph, prefilter=None, symmetrize=True)
            log(f"align-room: MASt3R on {len(photos)} photos, {len(pairs) // 2} pairs ({graph}), {device}")
            try:
                scene: Any = sparse_ga(paths, pairs, str(Path(tmp) / "cache"), net, lr1=0.07, niter1=300, lr2=0.01, niter2=300,
                                       device=device, opt_depth=True, shared_intrinsics=False, matching_conf_thr=0.0)
            except Exception as e:
                raise Fail(f"MASt3R failed ({type(e).__name__}: {' '.join(str(e).split())[:160]})") from None
            c2w = [_np(m) for m in scene.get_im_poses()]
            kk = [_np(m) for m in scene.intrinsics]
            _, depths, confs = scene.get_dense_pts3d(clean_depth=True)
            views: list[View] = []
            for i, s in enumerate(photos):
                hh, ww = (int(x) for x in imgs[i]["true_shape"][0])
                # dust3r's load_images: the long side resized to SIZE, then the center cropped to multiples of 16
                k = SIZE / max(s.w, s.h)
                rw, rh = round(s.w * k), round(s.h * k)
                x0, y0 = rw // 2 - ww / 2, rh // 2 - hh / 2
                uu, vv = np.meshgrid((np.arange(ww) + 0.5 + x0) / rw, (np.arange(hh) + 0.5 + y0) / rh)
                d = _np(depths[i]).reshape(hh, ww)
                cf = _np(confs[i]).reshape(hh, ww)
                views.append(View(c2w[i], kk[i], d, cf, uu.astype(np.float64), vv.astype(np.float64)))
        if device == "mps":
            torch.mps.empty_cache()
        log(f"align-room: MASt3R solved in {time.monotonic() - t0:.1f} s")
        return from_views(photos, views)
