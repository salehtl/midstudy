"""`midstudy-calib serve` (contract §4.3 Worker): JSON lines in and out, exactly the one-shot results (plus the id),
failures answered without stopping the worker, end of input exits 0. Runs with MIDSTUDY_CALIB_MOCK, so no MoGe weights
are needed; the warm MoGe path is measured by calib/scripts/bench.py (docs/notes/calib.md)."""
from __future__ import annotations

import io
import json
import os
import queue
import shutil
import signal
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Iterator
from pathlib import Path
from types import SimpleNamespace, TracebackType
from typing import IO, Self, cast

import numpy as np
import pytest
from cli_run import clean_env, run_cli
from PIL import Image
from synthetic import REPO, jget

from midstudy_calib import validate, worker
from midstudy_calib.cli import ArgsError, FitArgs, LightArgs, ServeArgs, parse_request
from midstudy_calib.records import Result
from midstudy_calib.worker import MAX_LINE, Interrupted, handle, serve

MOCK = {"MIDSTUDY_CALIB_MOCK": str(REPO / "fixtures/calib")}
GOLDEN = REPO / "fixtures/scenes"
TIMEOUT_S = 60


class Worker:
    """A `midstudy-calib serve` subprocess: send() writes request lines, answer() reads one response line."""

    def __init__(self, env: dict[str, str] | None = None, *extra: str) -> None:
        self.proc = subprocess.Popen([sys.executable, "-m", "midstudy_calib.cli", "serve", *extra], stdin=subprocess.PIPE,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=clean_env(env), text=True, bufsize=1)
        assert self.proc.stdin is not None and self.proc.stdout is not None and self.proc.stderr is not None
        self.stdin: IO[str] = self.proc.stdin
        self.lines: queue.Queue[str | None] = queue.Queue()
        self.err: list[str] = []
        out, err = self.proc.stdout, self.proc.stderr
        threading.Thread(target=self._pump, args=(out, self.lines), daemon=True).start()
        self.err_thread = threading.Thread(target=self._collect, args=(err,), daemon=True)
        self.err_thread.start()

    @staticmethod
    def _pump(stream: IO[str], q: queue.Queue[str | None]) -> None:
        for line in stream:
            q.put(line)
        q.put(None)

    def _collect(self, stream: IO[str]) -> None:
        self.err.extend(stream)

    def send(self, *lines: str) -> None:
        for line in lines:
            self.stdin.write(line + "\n")
        self.stdin.flush()

    def request(self, rid: str, cmd: str, *args: str | Path) -> None:
        self.send(json.dumps({"id": rid, "cmd": cmd, "args": [str(a) for a in args]}))

    def answer(self) -> dict[str, object]:
        line = self.lines.get(timeout=TIMEOUT_S)
        assert line is not None, f"the worker exited: {''.join(self.err)[-2000:]}"
        res: object = json.loads(line)
        assert isinstance(res, dict)
        return cast(dict[str, object], res)

    def close(self) -> int:
        self.stdin.close()
        code = self.proc.wait(timeout=TIMEOUT_S)
        assert self.lines.get(timeout=TIMEOUT_S) is None, "more output after the last answer"
        self.err_thread.join(timeout=TIMEOUT_S)
        return code

    def __enter__(self) -> Self:
        return self

    def __exit__(self, t: type[BaseException] | None, e: BaseException | None, tb: TracebackType | None) -> None:
        if self.proc.poll() is None:
            self.proc.kill()
            self.proc.wait()


def _without_timing(res: dict[str, object]) -> dict[str, object]:
    return {k: v for k, v in res.items() if k not in ("id", "elapsed_s")}


def _files(scene: Path) -> dict[str, bytes]:
    """The scene's files, calib.json without its elapsed_s."""
    out: dict[str, bytes] = {}
    for p in sorted(scene.iterdir()):
        data = p.read_bytes()
        if p.name == "calib.json":
            c = json.loads(data)
            c.pop("elapsed_s")
            data = json.dumps(c).encode()
        out[p.name] = data
    return out


def test_answers_exactly_as_the_one_shot_commands(tmp_path: Path) -> None:
    """run, fit (with and without depth), light, ingest and align through the worker: the same result lines (plus the
    id) and the same files as the one-shot CLI, with MIDSTUDY_CALIB_MOCK read per request as the one-shot reads it."""
    with Worker(MOCK) as w:
        for sid in ("living-wide", "portrait"):
            photo = GOLDEN / sid / "photo.jpg"
            code, one, _ = run_cli("midstudy-calib", "run", photo, "--out", tmp_path / "one" / sid, env=MOCK)
            assert code == 0
            w.request(f"run-{sid}", "run", photo, "--out", tmp_path / "srv" / sid)
            got = w.answer()
            assert got["id"] == f"run-{sid}" and next(iter(got)) == "id"
            assert _without_timing(got) == _without_timing(one)
            assert _files(tmp_path / "srv" / sid) == _files(tmp_path / "one" / sid)
            assert validate.problems("run", got) == []
        scene = tmp_path / "srv/living-wide"
        w.request("fit-nodepth", "fit", scene, "--no-depth")
        got = w.answer()
        assert got["ok"] is True and got["depth"] is None and not (scene / "depth.png").exists()
        (scene / "lighting.json").unlink()
        w.request("light", "light", scene)
        got = w.answer()
        assert got["ok"] is True and got["lighting"] is True and (scene / "lighting.json").is_file()
        assert validate.problems("light", got) == []
        w.request("ingest", "ingest", GOLDEN / "steep-roll/photo.jpg", "--out", tmp_path / "srv/ingested")
        got = w.answer()
        assert _without_timing(got) == {"ok": True, "photo": "photo.jpg", "source": "source.jpg", "image": {"w": 1600, "h": 1200}}
        m = np.zeros((1200, 1600), np.uint8)
        m[600:900, 600:1000] = 255
        Image.fromarray(m).save(tmp_path / "mask.png")
        photo = GOLDEN / "living-wide/photo.jpg"
        w.request("align", "align", photo, photo, tmp_path / "mask.png", "--out", tmp_path / "final.jpg")
        got = w.answer()
        assert got["ok"] is True and got["applied"] is True and (tmp_path / "final.jpg").is_file()
        assert validate.problems("align", got) == []
        assert w.close() == 0
    assert any("stdin closed after 6 request(s)" in line for line in w.err)


def test_a_failing_request_is_answered_and_the_worker_goes_on(tmp_path: Path) -> None:
    good: dict[str, object] = {"id": "good", "cmd": "fit", "args": []}
    scene = tmp_path / "s"
    scene.mkdir()
    shutil.copyfile(GOLDEN / "living-wide/photo.jpg", scene / "photo.jpg")
    good["args"] = [str(scene)]
    with Worker(MOCK) as w:
        w.send("not json", "", "   ", "[1, 2]", '{"cmd": "fit", "args": []}', '{"id": "x", "cmd": "serve", "args": []}',
               '{"id": "y", "cmd": "fit", "args": [], "extra": 1}', '{"id": "a", "cmd": "fit", "args": ["--bogus"]}',
               '{"id": "h", "cmd": "fit", "args": ["-h"]}', json.dumps({"id": "n", "cmd": "fit", "args": [str(tmp_path / "nope")]}),
               '{"id": "big", "cmd": "fit", "args": ["' + "x" * (MAX_LINE + 10) + '"]}', json.dumps(good))
        answers = [w.answer() for _ in range(10)]  # blank lines get no answer
        assert w.close() == 0
    assert [a["id"] for a in answers] == [None, None, None, "x", "y", "a", "h", "n", None, "good"]
    by_id = {a["id"]: a for a in answers if isinstance(a["id"], str)}
    for a in answers[:-1]:
        assert a["ok"] is False and isinstance(a["error"], str) and a["error"], a
        assert validate.problems("error", a) == []
    assert "isn't a line of UTF-8 JSON" in str(answers[0]["error"])
    assert "cmd: 'serve' is not one of" in str(by_id["x"]["error"])
    assert "the following arguments are required: scene" in str(by_id["a"]["error"])
    assert by_id["h"]["error"] == "--help isn't a request"
    assert str(by_id["n"]["error"]).endswith("isn't a scene folder")
    assert f"longer than {MAX_LINE} bytes" in str(answers[8]["error"])
    assert answers[-1]["id"] == "good" and answers[-1]["ok"] is True and answers[-1]["source"] == "truth"
    # each failure also leaves "midstudy-calib: <sentence>" on stderr, as the one-shot commands do
    errs = [line.strip() for line in w.err if line.startswith("midstudy-calib: ")]
    assert len(errs) == 9 and errs[3] == f"midstudy-calib: {by_id['x']['error']}"


def test_end_of_input_exits_0_without_output() -> None:
    with Worker(MOCK) as w:
        assert w.close() == 0


def test_a_mock_worker_never_imports_torch(tmp_path: Path) -> None:
    """MIDSTUDY_CALIB_MOCK in the worker is the one-shot mock: no MoGe, no torch."""
    req = json.dumps({"id": "m", "cmd": "run", "args": [str(GOLDEN / "living-wide/photo.jpg"), "--out", str(tmp_path / "s")]})
    code = (
        "import json, sys\n"
        "from midstudy_calib.cli import ServeArgs\n"
        "from midstudy_calib.worker import handle\n"
        f"rid, cmd, res = handle({req!r}.encode(), ServeArgs('vitl', 'auto'))\n"
        "print(json.dumps([res.get('source'), 'torch' in sys.modules, 'moge' in sys.modules]))\n")
    p = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, env=clean_env(MOCK), check=False)
    assert p.returncode == 0, p.stderr
    assert json.loads(p.stdout.strip().splitlines()[-1]) == ["truth", False, False]


def test_serve_defaults_apply_to_requests_that_name_none() -> None:
    d = ServeArgs("vits", "cpu")
    a = parse_request("fit", ["/x"], d)
    assert isinstance(a, FitArgs) and (a.model, a.device, a.no_depth) == ("vits", "cpu", False)
    b = parse_request("light", ["/x", "--model", "vitb", "--device", "mps"], d)
    assert isinstance(b, LightArgs) and (b.model, b.device) == ("vitb", "mps")
    for bad in (["--model", "huge", "/x"], [], ["/x", "--frobnicate"]):
        try:
            parse_request("fit", bad, d)
        except ArgsError:
            continue
        raise AssertionError(f"accepted {bad}")


def test_serve_flags_reach_the_requests(tmp_path: Path) -> None:
    """serve --model/--device: the defaults of every request that names none (the Nix module's calibDevice)."""
    scene = tmp_path / "s"
    scene.mkdir()
    shutil.copyfile(GOLDEN / "living-wide/photo.jpg", scene / "photo.jpg")
    with Worker(MOCK, "--device", "cpu", "--model", "vitb") as w:
        w.request("f", "fit", scene)
        assert w.answer()["ok"] is True
        assert w.close() == 0
    assert any("defaults --model vitb --device cpu" in line for line in w.err)
    assert jget(json.loads((scene / "calib.json").read_text()), "source") == "truth"


DEFAULTS = ServeArgs("vitl", "cpu")
FIT_LINE = b'{"id":"r1","cmd":"fit","args":[]}\n'


def _interrupt(*_: object) -> list[str]:
    raise KeyboardInterrupt


def test_sigint_while_a_line_is_parsed_answers_its_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(validate, "problems", _interrupt)
    with pytest.raises(Interrupted) as caught:
        handle(FIT_LINE, DEFAULTS)
    assert caught.value.rid == "r1"


def test_sigint_before_the_id_is_known_is_answered_with_a_null_id(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(json, "loads", _interrupt)
    with pytest.raises(Interrupted) as caught:
        handle(FIT_LINE, DEFAULTS)
    assert caught.value.rid is None


class _SignalledOut(io.StringIO):
    """An output that gets SIGINT in the middle of write, as a Ctrl-C between write and flush would."""

    def __init__(self, send: Callable[[], None]) -> None:
        super().__init__()
        self.send = send
        self.flushed = ""

    def write(self, s: str) -> int:
        self.send()
        time.sleep(0.01)  # a signal that isn't held has been delivered by now
        return super().write(s)

    def flush(self) -> None:
        self.flushed = self.getvalue()


def _to_main() -> None:
    os.kill(os.getpid(), signal.SIGINT)


def _to_another_thread() -> Callable[[], None]:
    """A signal that lands on another thread, as it can in a worker with torch's threads running. The thread exists
    before the response starts, so a signal mask set then wouldn't cover it."""
    go = threading.Event()

    def wait_then_signal() -> None:
        go.wait(TIMEOUT_S)
        signal.pthread_kill(threading.get_ident(), signal.SIGINT)

    thread = threading.Thread(target=wait_then_signal, daemon=True)
    thread.start()

    def send() -> None:
        go.set()
        thread.join(TIMEOUT_S)

    return send


@pytest.mark.parametrize("target", ["main", "another thread"])
def test_a_signal_during_the_response_comes_after_the_whole_line(target: str) -> None:
    before = signal.getsignal(signal.SIGINT)
    out = _SignalledOut(_to_main if target == "main" else _to_another_thread())
    with pytest.raises(KeyboardInterrupt):
        worker._respond(out, "r1", "", {"ok": False, "error": "no"})  # pyright: ignore[reportPrivateUsage]
    answer: object = json.loads(out.flushed)
    assert answer == {"id": "r1", "ok": False, "error": "no"}
    assert signal.getsignal(signal.SIGINT) is before, "the handler is restored"


@pytest.fixture
def sigterm_restored() -> Iterator[None]:
    """serve() installs its SIGTERM handler for the process: here that process is pytest's."""
    previous = signal.getsignal(signal.SIGTERM)
    yield
    signal.signal(signal.SIGTERM, previous)


@pytest.mark.usefixtures("sigterm_restored")
@pytest.mark.parametrize("failure", [BrokenPipeError(), KeyboardInterrupt(), OSError("closed")])
def test_a_failing_interrupted_answer_still_exits_1(monkeypatch: pytest.MonkeyPatch, failure: BaseException) -> None:
    class Out(io.StringIO):
        def write(self, s: str) -> int:
            raise failure

    def dispatch_interrupted(_: object) -> Result:
        raise KeyboardInterrupt

    line = json.dumps({"id": "r1", "cmd": "fit", "args": ["/x"]}).encode() + b"\n"
    monkeypatch.setattr(worker, "dispatch", dispatch_interrupted)
    monkeypatch.setattr(sys, "stdin", SimpleNamespace(buffer=io.BytesIO(line)))
    def fdopen(*_: object, **__: object) -> Out:
        return Out()

    def dup(fd: int) -> int:
        return fd

    def dup2(*_: object) -> None:
        return None

    fds = SimpleNamespace(fdopen=fdopen, dup=dup, dup2=dup2, getpid=os.getpid)  # only worker's view of os
    monkeypatch.setattr(worker, "os", fds)
    assert serve(DEFAULTS) == 1


def test_sigterm_while_idle_exits_1() -> None:
    with Worker(MOCK) as w:
        deadline = time.monotonic() + TIMEOUT_S
        while not any("worker ready" in line for line in w.err):
            assert w.proc.poll() is None and time.monotonic() < deadline, f"no 'worker ready': {w.err}"
            time.sleep(0.02)
        w.proc.send_signal(signal.SIGTERM)
        assert w.proc.wait(timeout=TIMEOUT_S) == 1
