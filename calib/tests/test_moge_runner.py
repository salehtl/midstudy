"""moge_runner: the network is built with its random initialization skipped (then every weight comes from the
checkpoint), the default model's revision is pinned, and a process keeps one model loaded. The comparison with
MoGe's own from_pretrained needs the vitl weights in the Hugging Face cache and is skipped without them."""
from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path
from typing import cast

import numpy as np
import pytest
import torch
from synthetic import REPO

from midstudy_calib import moge_runner as mr
from midstudy_calib.records import Model


def test_no_weight_init_puts_torch_back() -> None:
    from moge.model.dinov2.models import vision_transformer as vt  # pyright: ignore[reportMissingTypeStubs]
    from torch.nn import init

    before = (init.trunc_normal_, init.normal_, init.kaiming_uniform_, init.zeros_, vt.trunc_normal_)
    with mr._no_weight_init():  # pyright: ignore[reportPrivateUsage]
        assert init.trunc_normal_ is not before[0] and vt.trunc_normal_ is not before[4]
        lin = torch.nn.Linear(4, 3)
    assert (init.trunc_normal_, init.normal_, init.kaiming_uniform_, init.zeros_, vt.trunc_normal_) == before
    # the skipped layer is then loaded like MoGe's network: every value from the state dict
    ref = torch.nn.Linear(4, 3)
    lin.load_state_dict(ref.state_dict(), strict=True)
    assert all(torch.equal(a, b) for a, b in zip(lin.state_dict().values(), ref.state_dict().values(), strict=True))
    with pytest.raises(RuntimeError), mr._no_weight_init():  # pyright: ignore[reportPrivateUsage]
        raise RuntimeError("restored on the way out too")
    assert init.trunc_normal_ is before[0]


def test_one_model_at_a_time(monkeypatch: pytest.MonkeyPatch) -> None:
    built: list[Path] = []

    class Net:
        def infer(self, image: torch.Tensor, *, use_fp16: bool) -> dict[str, torch.Tensor]:
            raise NotImplementedError

        def to(self, device: str) -> object:
            return self

    def build(ck: Path) -> Net:
        built.append(ck)
        time.sleep(0.01)
        return Net()

    def checkpoint(model: Model) -> Path:
        return Path(f"/{model}.pt")

    monkeypatch.setattr(mr, "_build", build)
    monkeypatch.setattr(mr, "_checkpoint", checkpoint)
    monkeypatch.setattr(mr, "_LOADED", {})
    a, ta = mr.load("vitl")
    b, tb = mr.load("vitl")
    assert a is b and ta > 0 and tb == 0.0 and built == [Path("/vitl.pt")]
    c, tc = mr.load("vits")
    assert c is not a and tc > 0 and list(mr._LOADED) == ["vits"]  # pyright: ignore[reportPrivateUsage]
    mr.load("vitl")
    assert built == [Path("/vitl.pt"), Path("/vits.pt"), Path("/vitl.pt")]


def test_pinned_revision_then_main(monkeypatch: pytest.MonkeyPatch) -> None:
    import huggingface_hub

    asked: list[str | None] = []

    def fake(repo_id: str, filename: str, *, revision: str | None = None) -> str:
        asked.append(revision)
        if revision is not None:
            raise OSError("not in this cache")
        return f"/cache/{repo_id}/{filename}"

    monkeypatch.setattr(huggingface_hub, "hf_hub_download", fake)
    assert mr._checkpoint("vitl") == Path("/cache/Ruicheng/moge-2-vitl-normal/model.pt")  # pyright: ignore[reportPrivateUsage]
    assert asked == [mr.REVISIONS["vitl"], None]
    asked.clear()
    mr._checkpoint("vitb")  # pyright: ignore[reportPrivateUsage]
    assert asked == [None]


def test_the_pin_is_the_nix_one() -> None:
    nix = (REPO / "nix/moge-weights.nix").read_text()
    assert f'rev = "{mr.REVISIONS["vitl"]}"' in nix and f'repo = "{mr.MODELS["vitl"]}"' in nix


def test_pick_device() -> None:
    assert mr.pick_device("cpu") == "cpu"
    assert mr.pick_device("auto") in ("cuda", "mps", "cpu")
    if not torch.cuda.is_available():
        assert mr.pick_device("cuda") == "cpu"


def _cached_vitl() -> Path | None:
    from huggingface_hub import try_to_load_from_cache

    p = try_to_load_from_cache(mr.MODELS["vitl"], "model.pt", revision=mr.REVISIONS["vitl"])
    return Path(p) if isinstance(p, str) else None


@pytest.mark.skipif(_cached_vitl() is None, reason="the MoGe-2 vitl weights aren't in the Hugging Face cache")
def test_build_is_moge_from_pretrained() -> None:
    """The fast build (no random init) is MoGe's own from_pretrained, weight for weight, and infers the same."""
    from moge.model.v2 import MoGeModel  # pyright: ignore[reportMissingTypeStubs]

    ck = _cached_vitl()
    assert ck is not None
    t0 = time.monotonic()
    fast = mr._build(ck)  # pyright: ignore[reportPrivateUsage]
    t_fast = time.monotonic() - t0
    assert isinstance(fast, torch.nn.Module)
    t0 = time.monotonic()
    ref = MoGeModel.from_pretrained(str(ck)).eval()  # pyright: ignore[reportUnknownMemberType] - MoGe is untyped
    t_ref = time.monotonic() - t0
    sf, sr = fast.state_dict(), ref.state_dict()
    assert list(sf) == list(sr)
    assert all(torch.equal(sf[k], sr[k]) for k in sf)
    rgb = np.random.default_rng(0).integers(0, 255, (96, 128, 3), dtype=np.uint8)
    loaded = mr.Loaded(net=fast, model="vitl", repo="x", load_s=0.0)
    a = mr.infer(loaded, rgb, "cpu", 0.0)
    b = mr.infer(mr.Loaded(net=cast(mr.MogeNet, ref), model="vitl", repo="x", load_s=0.0), rgb, "cpu", 0.0)
    assert np.array_equal(a.points, b.points, equal_nan=True) and np.array_equal(a.mask, b.mask)
    assert t_fast < t_ref, (t_fast, t_ref)


def test_moge_imports_without_scipy_signal() -> None:
    """import_moge leaves scipy.signal unloaded (1.6-2.1 s saved per one-shot run); MoGe's fftconvolve still works,
    through the real module, which is what everyone else gets."""
    code = (
        "import json, sys\n"
        "import numpy as np\n"
        "from midstudy_calib import moge_runner as mr\n"
        "mr.import_moge()\n"
        "before = 'scipy.signal' in sys.modules\n"
        "import moge.utils.geometry_numpy as g\n"
        "a, k = np.random.default_rng(0).random((16, 16)), np.ones((3, 3))\n"
        "got = g.fftconvolve(a, k, mode='same')\n"
        "import scipy.signal as ss\n"
        "print(json.dumps([before, type(sys.modules['scipy.signal']).__name__, bool(np.allclose(got, ss.fftconvolve(a, k, mode='same'))),\n"
        "                  hasattr(ss, 'welch')]))\n")
    p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, check=False)
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout.strip().splitlines()[-1]) == [False, "module", True, True]
