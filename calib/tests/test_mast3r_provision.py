"""MASt3R's provisioning (rooms/mast3r.py), without git or the network: one process at a time works on the checkout, a
half-finished one is finished, local edits can't wedge it, and any failure to load is SolverUnavailable."""
from __future__ import annotations

import importlib
import multiprocessing as mp
import os
import time
from multiprocessing.synchronize import Barrier
from pathlib import Path
from types import ModuleType
from typing import Any, cast

import pytest
from test_align_room import copy_scenes

from midstudy_calib.rooms import command, mast3r, solver
from midstudy_calib.rooms.photos import RoomPhoto, load

STAMP = ".midstudy-ready"


def _tree(root: Path) -> None:
    (root / ".git").mkdir(parents=True, exist_ok=True)
    (root / "mast3r").mkdir(exist_ok=True)
    (root / "mast3r/model.py").touch()
    (root / "dust3r/croco/models").mkdir(parents=True, exist_ok=True)


class Recorder:
    """Stands in for mast3r._git: `rev-parse` answers the pinned commit, `clone` and `submodule` make the files."""

    def __init__(self, root: Path) -> None:
        self.root = root
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, *args: str, cwd: Path | None = None) -> str:
        assert cwd in (None, self.root)
        self.calls.append(args)
        if args[0] == "rev-parse":
            return mast3r.COMMIT
        if args[0] == "clone":
            (self.root / ".git").mkdir(parents=True)
        if args[0] == "submodule":
            assert not (self.root / STAMP).exists()
            _tree(self.root)
        return ""

    def named(self, name: str) -> list[tuple[str, ...]]:
        return [c for c in self.calls if c[0] == name]


@pytest.fixture
def root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    r = tmp_path / "cache" / "mast3r"
    monkeypatch.setenv("MIDSTUDY_MAST3R_DIR", str(r))
    return r


def test_a_checkout_without_the_stamp_is_finished(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _tree(root)
    git = Recorder(root)
    monkeypatch.setattr(mast3r, "_git", git)
    assert mast3r.ensure_code() == root
    assert git.named("submodule")
    assert not git.named("clone")
    assert (root / STAMP).read_text() == mast3r.COMMIT


def test_the_stamp_makes_it_ready_without_touching_the_tree(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _tree(root)
    (root / STAMP).write_text(mast3r.COMMIT)
    git = Recorder(root)
    monkeypatch.setattr(mast3r, "_git", git)
    assert mast3r.ensure_code() == root
    assert [c[0] for c in git.calls] == ["rev-parse"]


def test_a_stamp_for_another_commit_is_removed_before_the_tree_changes(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _tree(root)
    (root / STAMP).write_text("another commit")

    class Failing(Recorder):
        def __call__(self, *args: str, cwd: Path | None = None) -> str:
            if args[0] == "checkout":
                assert not (root / STAMP).exists()
                raise solver.SolverUnavailable("offline")
            return super().__call__(*args, cwd=cwd)

    monkeypatch.setattr(mast3r, "_git", Failing(root))
    with pytest.raises(solver.SolverUnavailable, match="offline"):
        mast3r.ensure_code()
    assert not (root / STAMP).exists()


def _store_copy(root: Path, commit: str) -> None:
    """The Nix package's copy (nix/mast3r.nix): the files and a .midstudy-commit stamp, no .git, in a read-only folder."""
    _tree(root)
    (root / ".git").rmdir()
    (root / ".midstudy-commit").write_text(commit)
    root.parent.chmod(0o555)


def test_a_read_only_store_copy_is_used_without_git_or_the_lock(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _store_copy(root, mast3r.COMMIT)
    git = Recorder(root)
    monkeypatch.setattr(mast3r, "_git", git)
    try:
        assert mast3r.ensure_code() == root
    finally:
        root.parent.chmod(0o755)
    assert git.calls == []
    assert not (root.parent / ".mast3r.lock").exists()


def test_a_store_copy_of_another_commit_is_refused(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _store_copy(root, "another commit")
    monkeypatch.setattr(mast3r, "_git", Recorder(root))
    try:
        with pytest.raises(solver.SolverUnavailable, match="not the pinned commit"):
            mast3r.ensure_code()
    finally:
        root.parent.chmod(0o755)


def test_checkout_and_submodule_update_are_forced(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    git = Recorder(root)
    monkeypatch.setattr(mast3r, "_git", git)
    mast3r.ensure_code()
    assert len(git.named("clone")) == 1
    assert git.named("checkout")
    assert all("--force" in c for c in git.named("checkout"))
    assert git.named("submodule")
    assert all("--force" in c for c in git.named("submodule"))
    assert (root / STAMP).read_text() == mast3r.COMMIT


class _SlowClone(Recorder):
    """A `clone` that takes a while and writes when it starts and ends."""

    def __init__(self, root: Path, marks: Path) -> None:
        super().__init__(root)
        self.marks = marks

    def _mark(self, s: str) -> None:
        with self.marks.open("a") as f:
            f.write(f"{s} {os.getpid()}\n")

    def __call__(self, *args: str, cwd: Path | None = None) -> str:
        if args[0] != "clone":
            return super().__call__(*args, cwd=cwd)
        self._mark("start")
        time.sleep(0.5)
        self._mark("end")
        _tree(self.root)
        return ""


def _provision(root: str, marks: str, barrier: Barrier) -> None:
    os.environ["MIDSTUDY_MAST3R_DIR"] = root
    setattr(mast3r, "_git", _SlowClone(Path(root), Path(marks)))  # noqa: B010
    barrier.wait(60)
    mast3r.ensure_code()


def test_two_processes_never_interleave(root: Path, tmp_path: Path) -> None:
    marks = tmp_path / "marks.txt"
    marks.touch()
    ctx = mp.get_context("spawn")
    barrier = ctx.Barrier(2)
    procs = [ctx.Process(target=_provision, args=(str(root), str(marks), barrier)) for _ in range(2)]
    for p in procs:
        p.start()
    for p in procs:
        p.join(120)
    assert [p.exitcode for p in procs] == [0, 0]
    lines = marks.read_text().splitlines()
    assert len(lines) == 2  # the second found the first's finished checkout
    who = lines[0].split()[1]
    assert lines == [f"start {who}", f"end {who}"]


def test_the_lock_is_beside_the_checkout(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(mast3r, "_git", Recorder(root))
    mast3r.ensure_code()
    assert (root.parent / ".mast3r.lock").exists()


# ------------------------------------------------------------------------------------------------- load, solve


def _ignore(_: object) -> None:
    return None


def _clear_loaded() -> None:
    cast(dict[str, Any], getattr(mast3r, "_LOADED")).clear()  # noqa: B009


def _failing_model(monkeypatch: pytest.MonkeyPatch, exc: Exception) -> None:
    class Model:
        @staticmethod
        def from_pretrained(_: str) -> Any:
            raise exc

    module = ModuleType("mast3r.model")
    setattr(module, "AsymmetricMASt3R", Model)  # noqa: B010
    real = importlib.import_module

    def fake(name: str, package: str | None = None) -> ModuleType:
        return module if name == "mast3r.model" else real(name, package)

    _clear_loaded()
    monkeypatch.setattr(mast3r, "ensure_code", lambda: Path("/nonexistent"))
    monkeypatch.setattr(mast3r, "ensure_weights", lambda: Path("/nonexistent"))
    monkeypatch.setattr(mast3r, "_import", _ignore)
    monkeypatch.setattr(importlib, "import_module", fake)


@pytest.mark.parametrize("exc", [RuntimeError("MPS backend out of memory"), OSError("no such file"), ImportError("no roma")])
def test_load_turns_any_failure_into_unavailable(monkeypatch: pytest.MonkeyPatch, exc: Exception) -> None:
    _failing_model(monkeypatch, exc)
    with pytest.raises(solver.SolverUnavailable, match="couldn't load"):
        mast3r.load("cpu")


def test_provisioning_failures_keep_their_own_sentence(monkeypatch: pytest.MonkeyPatch) -> None:
    def offline() -> Path:
        raise solver.SolverUnavailable("couldn't fetch MASt3R's code (git clone: offline)")

    _clear_loaded()
    monkeypatch.setattr(mast3r, "ensure_code", offline)
    with pytest.raises(solver.SolverUnavailable, match="couldn't fetch"):
        mast3r.load("cpu")


def test_git_missing_is_unavailable_too(root: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def no_git(*_: str, cwd: Path | None = None) -> str:
        raise FileNotFoundError("git", cwd)

    _clear_loaded()
    monkeypatch.setattr(mast3r, "_git", no_git)
    with pytest.raises(solver.SolverUnavailable, match="couldn't load"):
        mast3r.load("cpu")
    assert not (root / STAMP).exists()


def test_auto_answers_manhattan_when_loading_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _failing_model(monkeypatch, RuntimeError("MPS backend out of memory"))
    monkeypatch.setattr(mast3r, "installed", lambda: True)
    photos: list[RoomPhoto] = [load(d) for d in copy_scenes(tmp_path, ["living-wide", "room-1"])]
    ans = command.solve(photos, "auto", "cpu", "2026-01-01T00:00:00Z", 0.0)
    assert ans["solver"] == "manhattan"
    assert "couldn't load" in str(cast(dict[str, dict[str, object]], ans)["diagnostics"]["fallback"])


@pytest.mark.parametrize("missing", ["dust3r.image_pairs", "dust3r.utils.image", "mast3r.cloud_opt.sparse_ga"])
def test_solve_turns_a_missing_module_into_unavailable(monkeypatch: pytest.MonkeyPatch, missing: str) -> None:
    real = importlib.import_module

    class Stub(ModuleType):
        def __getattr__(self, _: str) -> object:
            return None

    def fake(name: str, package: str | None = None) -> ModuleType:
        if name == missing:
            raise ModuleNotFoundError(name)
        if name.startswith(("dust3r", "mast3r")):
            return Stub(name)
        return real(name, package)

    monkeypatch.setattr(mast3r, "load", _ignore)
    monkeypatch.setattr(importlib, "import_module", fake)
    with pytest.raises(solver.SolverUnavailable, match="couldn't load"):
        mast3r.Mast3r().solve([], "cpu")
