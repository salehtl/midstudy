"""midstudy-calib (contract §4.3).

    midstudy-calib run <upload> --out <scene-dir> [--model vitl|vitb|vits] [--device auto|cuda|mps|cpu] [--no-depth]
    midstudy-calib ingest <upload> --out <scene-dir>
    midstudy-calib fit <scene-dir> [--model ...] [--device ...] [--no-depth]
    midstudy-calib light <scene-dir> [--model ...] [--device ...]
    midstudy-calib align <photo.jpg> <raw.jpg> <mask.png> --out <final.jpg>
    midstudy-calib serve [--model ...] [--device ...]

Progress goes to stderr. The last stdout line is one JSON object: run/fit the calib.json contents plus "ok": true;
ingest {ok, photo, source, image}; align {ok, applied, inliers, residual_px, reason?}; light {ok, lighting: true,
cct_k, confidence, elapsed_s} or {ok, lighting: false, reason}. A failure exits 1 with {"ok": false, "error": "<one
sentence>"} on stdout and "midstudy-calib: <the same sentence>" as the last stderr line. Every result (and calib.json
and lighting.json) is checked against its schema before it is written; one that doesn't match is a bug and is reported
as a failure instead (validate.py).

light (contract §4.8) is the lighting step of fit alone, for scenes calibrated before lighting.json existed: MoGe-2 on
photo.jpg at depth size, the floor fit, the camera from calib.json (when it was fitted to a floor; else this floor
fit's), and writes lighting.json only. It never touches calib.json, depth.png, source.*, photo.jpg or scene.json. When
the photo gives too little it writes nothing (an existing lighting.json stays) and answers lighting: false.

serve (the warm worker, contract §4.3 Worker, worker.py) answers the commands above as JSON lines on stdin and stdout
and keeps MoGe-2 loaded between them; its --model and --device are the defaults of the requests that name none.

MIDSTUDY_CALIB_MOCK=<dir> makes fit copy <dir>/<sha256>/calib.json, depth.png and lighting.json, and light copy
<dir>/<sha256>/lighting.json (lighting: false without one), instead of running MoGe (<sha256>: of photo.jpg, then of
source.<ext>). The worker reads it for every request, as the one-shot commands do.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn, TypeGuard

from . import validate
from .contract_types import ErrorResult
from .records import DEVICES, MODELS, Command, Device, Model, Result, is_error
from .util import Fail


@dataclass(frozen=True)
class RunArgs:
    upload: Path
    out: Path
    model: Model
    device: Device
    no_depth: bool


@dataclass(frozen=True)
class IngestArgs:
    upload: Path
    out: Path


@dataclass(frozen=True)
class FitArgs:
    scene: Path
    model: Model
    device: Device
    no_depth: bool


@dataclass(frozen=True)
class LightArgs:
    scene: Path
    model: Model
    device: Device


@dataclass(frozen=True)
class AlignArgs:
    photo: Path
    raw: Path
    mask: Path
    out: Path


@dataclass(frozen=True)
class ServeArgs:
    model: Model
    device: Device


type CommandArgs = RunArgs | IngestArgs | FitArgs | LightArgs | AlignArgs
type Args = CommandArgs | ServeArgs


class ArgsError(Exception):
    """A worker request's arguments that argparse refuses (the one-shot CLI exits 2 with its usage instead)."""


class _RequestParser(argparse.ArgumentParser):
    """argparse for worker requests: complaints raise ArgsError instead of exiting, and nothing prints help."""

    def error(self, message: str) -> NoReturn:
        raise ArgsError(f"{self.prog}: {message}")

    def exit(self, status: int = 0, message: str | None = None) -> NoReturn:
        raise ArgsError(" ".join((message or f"{self.prog} exited").split()))

    def print_help(self, file: object = None) -> None:
        raise ArgsError("--help isn't a request")

    def print_usage(self, file: object = None) -> None:
        raise ArgsError("--usage isn't a request")


def parser(model: Model = "vitl", device: Device = "auto", *, worker: bool = False) -> argparse.ArgumentParser:
    """The CLI's parser; `worker`: the commands a worker request may name, with serve's defaults, raising ArgsError."""
    cls = _RequestParser if worker else argparse.ArgumentParser
    ap = cls(prog="midstudy-calib", description="midstudy photo ingest, calibration and keep-room alignment")
    sub = ap.add_subparsers(dest="cmd", required=True)

    def model_device(p: argparse.ArgumentParser) -> None:
        p.add_argument("--model", choices=list(MODELS), default=model, help=f"MoGe-2 size (default {model})")
        p.add_argument("--device", choices=list(DEVICES), default=device, help="auto: cuda, then mps, then cpu")

    p = sub.add_parser("run", help="ingest + fit")
    p.add_argument("upload", type=Path)
    p.add_argument("--out", type=Path, required=True)
    model_device(p)
    p.add_argument("--no-depth", action="store_true")
    p = sub.add_parser("ingest", help="photo.jpg + source.<ext> only")
    p.add_argument("upload", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("fit", help="calib.json + depth.png from <scene-dir>/photo.jpg")
    p.add_argument("scene", type=Path)
    model_device(p)
    p.add_argument("--no-depth", action="store_true")
    p = sub.add_parser("light", help="lighting.json alone from <scene-dir>/photo.jpg (contract §4.8)")
    p.add_argument("scene", type=Path)
    model_device(p)
    p = sub.add_parser("align", help="keep-room composite (contract §4.7)")
    p.add_argument("photo", type=Path)
    p.add_argument("raw", type=Path)
    p.add_argument("mask", type=Path)
    p.add_argument("--out", type=Path, required=True)
    if not worker:
        p = sub.add_parser("serve", help="the warm worker: JSON requests on stdin, one per line (contract §4.3 Worker)")
        model_device(p)
    return ap


def _is_model(v: object) -> TypeGuard[Model]:
    return v in MODELS


def _is_device(v: object) -> TypeGuard[Device]:
    return v in DEVICES


def _from_namespace(ns: argparse.Namespace) -> Args:
    """argparse's Namespace (untyped) as the typed arguments of its command."""
    a: dict[str, object] = dict(vars(ns))

    def path(k: str) -> Path:
        v = a[k]
        if not isinstance(v, Path):
            raise ArgsError(f"{k} isn't a path")
        return v

    def model() -> Model:
        v = a["model"]
        if not _is_model(v):
            raise ArgsError(f"unknown model {v!r}")
        return v

    def device() -> Device:
        v = a["device"]
        if not _is_device(v):
            raise ArgsError(f"unknown device {v!r}")
        return v

    cmd = a["cmd"]
    if cmd == "run":
        return RunArgs(path("upload"), path("out"), model(), device(), a["no_depth"] is True)
    if cmd == "ingest":
        return IngestArgs(path("upload"), path("out"))
    if cmd == "fit":
        return FitArgs(path("scene"), model(), device(), a["no_depth"] is True)
    if cmd == "light":
        return LightArgs(path("scene"), model(), device())
    if cmd == "align":
        return AlignArgs(path("photo"), path("raw"), path("mask"), path("out"))
    if cmd == "serve":
        return ServeArgs(model(), device())
    raise ArgsError(f"unknown command {cmd!r}")


def parse(argv: list[str] | None) -> Args:
    """The one-shot command line (argparse exits 2 with its usage on a bad one, as before)."""
    return _from_namespace(parser().parse_args(argv))


def parse_request(cmd: Command, args: list[str], defaults: ServeArgs) -> CommandArgs:
    """A worker request's command and arguments, with serve's model and device as their defaults."""
    parsed = _from_namespace(parser(defaults.model, defaults.device, worker=True).parse_args([cmd, *args]))
    if isinstance(parsed, ServeArgs):
        raise ArgsError("serve isn't a request")
    return parsed


def command_name(args: CommandArgs) -> Command:
    match args:
        case RunArgs():
            return "run"
        case IngestArgs():
            return "ingest"
        case FitArgs():
            return "fit"
        case LightArgs():
            return "light"
        case AlignArgs():
            return "align"


def sentence(e: BaseException, cmd: Command) -> str:
    """The one sentence a failure reports: a Fail's own message, else what failed unexpectedly (a bug)."""
    msg = " ".join(str(e).split()) or type(e).__name__
    what = "inferring the light" if cmd == "light" else "calibration"
    return msg if isinstance(e, Fail) else f"{what} failed unexpectedly ({type(e).__name__}: {msg[:200]})"


def dispatch(args: CommandArgs) -> Result:
    """Run one command and return its result, checked against its schema (a mismatch raises ContractViolation)."""
    result: Result
    match args:
        case IngestArgs():
            from .ingest import ingest

            result = ingest(args.upload, args.out)
        case RunArgs():
            from .fit import fit
            from .ingest import ingest

            ingest(args.upload, args.out)
            result = fit(args.out, args.model, args.device, args.no_depth)
            result["ok"] = True
        case FitArgs():
            from .fit import fit

            if not args.scene.is_dir():
                raise Fail(f"{args.scene} isn't a scene folder")
            result = fit(args.scene, args.model, args.device, args.no_depth)
            result["ok"] = True
        case LightArgs():
            from .fit import light

            if not args.scene.is_dir():
                raise Fail(f"{args.scene} isn't a scene folder")
            result = light(args.scene, args.model, args.device)
        case AlignArgs():
            from .align import align

            result = align(args.photo, args.raw, args.mask, args.out)
    cmd = command_name(args)
    validate.require("run" if cmd == "fit" else cmd, result, f"the {cmd} result")
    return result


def error_result(message: str) -> ErrorResult:
    """{"ok": false, "error": message}, the message made one non-empty line."""
    return ErrorResult(ok=False, error=" ".join(message.split()) or "midstudy-calib failed")


def main(argv: list[str] | None = None) -> int:
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    args = parse(argv)
    if isinstance(args, ServeArgs):
        from .worker import serve

        return serve(args)
    # Everything but the final JSON line goes to stderr, including what torch, MoGe or a C library print to fd 1.
    sys.stdout.flush()
    real_stdout = os.dup(1)
    os.dup2(2, 1)
    result: Result
    try:
        result = dispatch(args)
    except KeyboardInterrupt:
        result = error_result("interrupted")
    except Exception as e:  # every failure becomes the one-sentence contract
        result = error_result(sentence(e, command_name(args)))
    finally:
        sys.stdout.flush()
        os.dup2(real_stdout, 1)
        os.close(real_stdout)
    if is_error(result):
        print(f"midstudy-calib: {result['error']}", file=sys.stderr, flush=True)
    sys.stdout.write(json.dumps(result) + "\n")
    sys.stdout.flush()
    return 1 if is_error(result) else 0


if __name__ == "__main__":
    sys.exit(main())
