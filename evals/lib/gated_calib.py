#!/usr/bin/env python3
"""A `--calib` command for evals: logs each call, optionally waits on a gate file, then runs the real target.

    node server/src/main.ts --calib "python3 evals/lib/gated_calib.py"

Environment (the server passes its environment to calibration jobs, contract §4.4):
- MIDSTUDY_EVAL_CALIB_TARGET  the command to run (default "python3 fixtures/stub_calib.py")
- MIDSTUDY_EVAL_ALIGN_TARGET  the command for `align` only (e.g. "uv run --project calib midstudy-calib"), so a fast
                              stub can calibrate scenes while keep-room uses the real registration
- MIDSTUDY_EVAL_CALIB_GATE    a file path: wait (up to 120 s) until it exists before running, so an eval can hold a
                              job in "running" and see the next one "pending"
- MIDSTUDY_EVAL_CALIB_LOG     a file path: one JSON line per call ({argv, cwd, t})
Stdlib only.
"""
import json
import os
import shlex
import sys
import time


def main() -> None:
    args = sys.argv[1:]
    log = os.environ.get("MIDSTUDY_EVAL_CALIB_LOG")
    if log:
        with open(log, "a") as f:
            f.write(json.dumps({"argv": args, "cwd": os.getcwd(), "t": time.time()}) + "\n")
    gate = os.environ.get("MIDSTUDY_EVAL_CALIB_GATE")
    if gate and args[:1] != ["align"]:
        end = time.time() + 120
        while not os.path.exists(gate) and time.time() < end:
            time.sleep(0.05)
    target = os.environ.get("MIDSTUDY_EVAL_CALIB_TARGET", "python3 fixtures/stub_calib.py")
    if args[:1] == ["align"] and os.environ.get("MIDSTUDY_EVAL_ALIGN_TARGET"):
        target = os.environ["MIDSTUDY_EVAL_ALIGN_TARGET"]
    argv = shlex.split(target) + args
    sys.stdout.flush()
    os.execvp(argv[0], argv)


if __name__ == "__main__":
    main()
