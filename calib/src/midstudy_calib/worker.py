"""`midstudy-calib serve`: the warm worker (contract §4.3 Worker).

A one-shot calibration spends most of its time getting ready: importing torch and MoGe, building and loading the
network, and the first inference on a device (Metal and CUDA compile their kernels then). The worker is one process
that answers the one-shot commands as JSON lines and keeps MoGe-2 loaded between them (moge_runner holds it), so from
the second calibration on only the inference and the fit remain. align-room's MASt3R stays loaded the same way
(rooms/mast3r.py), next to MoGe-2.

Protocol, on stdin and stdout, UTF-8, one JSON object per line:

- request: {"id": "<1-200 characters>", "cmd": "run" | "fit" | "light" | "align" | "ingest" | "align-room", "args": [<the one-shot
  command's arguments after its name>]}, e.g. {"id": "c-1", "cmd": "fit", "args": ["/abs/scenes/x", "--no-depth"]};
- response: {"id": <the request's id>, ...the one-shot command's last stdout line} (the same object, checked against
  the same schema; calib-cli.schema.json), in request order, one at a time;
- progress on stderr as the one-shot commands write it, and for a failed request "midstudy-calib: <sentence>" too;
- a request that fails (not JSON, not a valid request, bad arguments, a failing command) is answered
  {"id", "ok": false, "error": "<one sentence>"} (id null when the request had no usable one), and the worker goes on;
- SIGINT or SIGTERM answers the request in flight (or the line being parsed) "interrupted" and exits 1; a response
  line is never left half-written;
- end of input exits 0. MIDSTUDY_CALIB_MOCK and the rest of the environment are read for every request as the one-shot
  commands read them; relative paths are relative to the worker's working directory.
"""
from __future__ import annotations

import json
import os
import shlex
import signal
import sys
import time
from collections.abc import Generator
from contextlib import contextmanager
from types import FrameType
from typing import IO, cast

from . import validate
from .cli import ArgsError, ServeArgs, dispatch, error_result, parse_request, sentence
from .contract_types import WorkerRequest
from .records import Result, is_error
from .util import log

MAX_LINE = 64 * 1024  # bytes in one request line


TARGETS: dict[str, validate.Target] = {"run": "run", "fit": "run", "light": "light", "align": "align", "ingest": "ingest", "align-room": "align_room"}


class Interrupted(Exception):
    """SIGINT or SIGTERM once a line was read: it is answered "interrupted", then the worker exits."""

    def __init__(self, rid: str | None) -> None:
        super().__init__(rid)
        self.rid = rid


def _request_id(req: object) -> str | None:
    """The request's id when it has a usable one (answered even when the rest of the request is wrong)."""
    v = cast(dict[str, object], req).get("id") if isinstance(req, dict) else None
    return v if isinstance(v, str) else None


def handle(raw: bytes, defaults: ServeArgs) -> tuple[str | None, str, Result]:
    """One request line -> (its id, its command, the result). SIGINT or SIGTERM (rid None until parsed) raises Interrupted."""
    rid: str | None = None
    try:
        try:
            req: object = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return None, "", error_result("the request isn't a line of UTF-8 JSON")
        rid = _request_id(req)
        found = validate.problems("request", req)
        if found:
            return rid, "", error_result(f"the request doesn't match calib-cli.schema.json's request: {found[0][:200]}")
        request = cast(WorkerRequest, req)
        cmd, args = request["cmd"], request["args"]
        log(f"request {rid}: {cmd} {shlex.join(args)}")
        try:
            result = dispatch(parse_request(cmd, args, defaults))
        except ArgsError as e:
            result = error_result(str(e))
        except Exception as e:  # every failure becomes the one-sentence contract, as in the one-shot CLI
            result = error_result(sentence(e, cmd))
        return rid, cmd, result
    except KeyboardInterrupt:
        raise Interrupted(rid) from None


@contextmanager
def _signals_held() -> Generator[None]:
    """A SIGINT or SIGTERM during the block is noted, and raises KeyboardInterrupt once the block is over. By swapping the
    handlers: a signal mask covers one thread, and a signal to the process can land on any of torch's."""
    caught: list[int] = []

    def note(signum: int, _frame: FrameType | None) -> None:
        caught.append(signum)

    previous = {s: signal.signal(s, note) for s in (signal.SIGINT, signal.SIGTERM)}
    try:
        yield
    finally:
        for s, handler in previous.items():
            signal.signal(s, handler)
    if caught:
        raise KeyboardInterrupt


def _respond(out: IO[str], rid: str | None, cmd: str, result: Result) -> None:
    with _signals_held():  # once dispatch has returned, its answer goes out whole
        target: validate.Target = "error" if is_error(result) else TARGETS[cmd]
        response: dict[str, object] = {"id": rid, **result}
        found = validate.problems(target, response)
        if found:  # a bug (dispatch checked the result without its id): answer that instead
            result = error_result(f"calibration failed unexpectedly (ContractViolation: the response doesn't match its schema: {found[0][:200]})")
            response = {"id": rid, **result}
        if is_error(result):
            print(f"midstudy-calib: {result['error']}", file=sys.stderr, flush=True)
        out.write(json.dumps(response) + "\n")
        out.flush()


def _drain_line(stdin: IO[bytes]) -> None:
    """Skip the rest of an over-long line."""
    while True:
        more = stdin.readline(MAX_LINE)
        if not more or more.endswith(b"\n"):
            return


def serve(defaults: ServeArgs) -> int:
    """Answer requests until stdin closes (exit 0). SIGINT or SIGTERM answers the request in flight with "interrupted" and exits 1."""
    signal.signal(signal.SIGTERM, signal.default_int_handler)  # unwind, so write_atomic removes its temp file
    sys.stdout.flush()
    out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)  # whatever torch, MoGe or a C library prints goes to stderr, never into the protocol
    stdin = sys.stdin.buffer
    log(f"worker ready (pid {os.getpid()}): one JSON request per line on stdin; defaults --model {defaults.model} --device {defaults.device}")
    served = 0
    try:
        while True:
            raw = stdin.readline(MAX_LINE + 1)
            if not raw:
                break
            if len(raw) > MAX_LINE and not raw.endswith(b"\n"):
                _drain_line(stdin)
                _respond(out, None, "", error_result(f"the request is longer than {MAX_LINE} bytes"))
                continue
            if not raw.strip():
                continue
            t0 = time.monotonic()
            rid, cmd, result = handle(raw, defaults)
            _respond(out, rid, cmd, result)
            served += 1
            log(f"request {rid}: {'failed' if is_error(result) else 'done'} in {time.monotonic() - t0:.2f} s")
    except Interrupted as e:
        try:
            _respond(out, e.rid, "", error_result("interrupted"))
        except (KeyboardInterrupt, OSError):
            log("the interrupted answer couldn't be written")
        log("interrupted: worker exiting")
        return 1
    except KeyboardInterrupt:
        log("interrupted: worker exiting")
        return 1
    except BrokenPipeError:
        log("stdout closed: worker exiting")
        return 1
    log(f"stdin closed after {served} request(s): worker exiting")
    return 0
