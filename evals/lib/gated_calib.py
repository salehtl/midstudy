#!/usr/bin/env python3
"""A `--calib` command for evals: logs each call, optionally waits on a gate file, then runs the real target.

    node server/src/main.ts --calib "python3 evals/lib/gated_calib.py"

Environment (the server passes its environment to calibration jobs, contract §4.4):
- MIDSTUDY_EVAL_CALIB_TARGET  the command to run (default "python3 fixtures/stub_calib.py")
- MIDSTUDY_EVAL_ALIGN_TARGET  the command for `align` only (e.g. "uv run --project calib midstudy-calib"), so a fast
                              stub can calibrate scenes while keep-room uses the real registration
- MIDSTUDY_EVAL_CALIB_GATE    a file path: wait until it exists before running, so an eval can hold a job in "running"
                              and see the next one "pending"
- MIDSTUDY_EVAL_CALIB_GATE_S  how long to wait for the gate, in seconds (default 120)
- MIDSTUDY_EVAL_CALIB_LOG     a file path: one JSON line per call ({argv, cwd, t})
Giving up on the gate (the deadline, or the parent gone so no poller outlives its server) fails the way the CLI does
(contract §4.3); `serve` exits 2 instead, like the stub's missing serve, so the server falls back to one-shot.
Stdlib only.
"""
import json
import os
import shlex
import sys
import time
from typing import NoReturn


def give_up(args: list[str], sentence: str) -> NoReturn:
    print(f"midstudy-calib: {sentence}", file=sys.stderr, flush=True)
    if args[:1] == ["serve"]:
        sys.exit(2)
    print(json.dumps({"ok": False, "error": sentence}), flush=True)
    sys.exit(1)


def wait_for_gate(gate: str, args: list[str]) -> None:
    try:
        limit = float(os.environ.get("MIDSTUDY_EVAL_CALIB_GATE_S", "120"))
    except ValueError:
        limit = 120.0
    end = time.time() + limit
    parent = os.getppid()  # the server spawns the command directly, with no shell between
    while not os.path.exists(gate):
        if os.getppid() != parent:
            give_up(args, "gated_calib: the server went away while the gate was closed")
        if time.time() >= end:
            give_up(args, f"gated_calib: the gate was not opened within {limit:g} s")
        time.sleep(0.05)


def main() -> None:
    args = sys.argv[1:]
    log = os.environ.get("MIDSTUDY_EVAL_CALIB_LOG")
    if log:
        with open(log, "a") as f:
            f.write(json.dumps({"argv": args, "cwd": os.getcwd(), "t": time.time()}) + "\n")
    gate = os.environ.get("MIDSTUDY_EVAL_CALIB_GATE")
    if gate and args[:1] != ["align"]:
        wait_for_gate(gate, args)
    target = os.environ.get("MIDSTUDY_EVAL_CALIB_TARGET", "python3 fixtures/stub_calib.py")
    if args[:1] == ["align"] and os.environ.get("MIDSTUDY_EVAL_ALIGN_TARGET"):
        target = os.environ["MIDSTUDY_EVAL_ALIGN_TARGET"]
    argv = shlex.split(target) + args
    sys.stdout.flush()
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    main()
