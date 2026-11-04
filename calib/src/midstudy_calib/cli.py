"""midstudy-calib (contract §4.3).

    midstudy-calib run <upload> --out <scene-dir> [--model vitl|vitb|vits] [--device auto|cuda|mps|cpu] [--no-depth]
    midstudy-calib ingest <upload> --out <scene-dir>
    midstudy-calib fit <scene-dir> [--model ...] [--device ...] [--no-depth]
    midstudy-calib align <photo.jpg> <raw.jpg> <mask.png> --out <final.jpg>

Progress goes to stderr. The last stdout line is one JSON object: run/fit the calib.json contents plus "ok": true;
ingest {ok, photo, source, image}; align {ok, applied, inliers, residual_px, reason?}. A failure exits 1 with
{"ok": false, "error": "<one sentence>"} on stdout and "midstudy-calib: <the same sentence>" as the last stderr line.
MIDSTUDY_CALIB_MOCK=<dir> makes fit copy <dir>/<sha256>/calib.json and depth.png instead of running MoGe.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from .util import Fail


def _parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(prog="midstudy-calib", description="midstudy photo ingest, calibration and keep-room alignment")
    sub = ap.add_subparsers(dest="cmd", required=True)
    model = dict(choices=["vitl", "vitb", "vits"], default="vitl", help="MoGe-2 size (default vitl)")
    device = dict(choices=["auto", "cuda", "mps", "cpu"], default="auto", help="auto: cuda, then mps, then cpu")
    p = sub.add_parser("run", help="ingest + fit")
    p.add_argument("upload", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p.add_argument("--model", **model)
    p.add_argument("--device", **device)
    p.add_argument("--no-depth", action="store_true")
    p = sub.add_parser("ingest", help="photo.jpg + source.<ext> only")
    p.add_argument("upload", type=Path)
    p.add_argument("--out", type=Path, required=True)
    p = sub.add_parser("fit", help="calib.json + depth.png from <scene-dir>/photo.jpg")
    p.add_argument("scene", type=Path)
    p.add_argument("--model", **model)
    p.add_argument("--device", **device)
    p.add_argument("--no-depth", action="store_true")
    p = sub.add_parser("align", help="keep-room composite (contract §4.7)")
    p.add_argument("photo", type=Path)
    p.add_argument("raw", type=Path)
    p.add_argument("mask", type=Path)
    p.add_argument("--out", type=Path, required=True)
    return ap


def _sentence(e: BaseException) -> str:
    msg = " ".join(str(e).split()) or type(e).__name__
    return msg if isinstance(e, Fail) else f"calibration failed unexpectedly ({type(e).__name__}: {msg[:200]})"


def _dispatch(args) -> dict:
    if args.cmd == "ingest":
        from .ingest import ingest

        return ingest(args.upload, args.out)
    if args.cmd == "run":
        from .fit import fit
        from .ingest import ingest

        ingest(args.upload, args.out)
        return {**fit(args.out, args.model, args.device, args.no_depth), "ok": True}
    if args.cmd == "fit":
        from .fit import fit

        if not args.scene.is_dir():
            raise Fail(f"{args.scene} isn't a scene folder")
        return {**fit(args.scene, args.model, args.device, args.no_depth), "ok": True}
    from .align import align

    return align(args.photo, args.raw, args.mask, args.out)


def main(argv: list[str] | None = None) -> int:
    os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")
    args = _parser().parse_args(argv)
    # Everything but the final JSON line goes to stderr, including what torch, MoGe or a C library print to fd 1.
    sys.stdout.flush()
    real_stdout = os.dup(1)
    os.dup2(2, 1)
    code = 0
    try:
        result = _dispatch(args)
    except KeyboardInterrupt:
        result, code = {"ok": False, "error": "interrupted"}, 1
    except BaseException as e:  # noqa: BLE001 - every failure becomes the one-sentence contract
        if isinstance(e, SystemExit):
            raise
        result, code = {"ok": False, "error": _sentence(e)}, 1
    finally:
        sys.stdout.flush()
        os.dup2(real_stdout, 1)
        os.close(real_stdout)
    line = json.dumps(result)
    if code:
        print(f"midstudy-calib: {result['error']}", file=sys.stderr, flush=True)
    sys.stdout.write(line + "\n")
    sys.stdout.flush()
    return code


if __name__ == "__main__":
    sys.exit(main())
