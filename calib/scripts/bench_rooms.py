"""align-room's run time, one-shot and through the worker (docs/notes/rooms-calib.md):

    uv run --project calib --extra rooms python calib/scripts/bench_rooms.py [--solver mast3r] [--device auto]
        [--out evals/out/bench-rooms] SCENE_DIR SCENE_DIR ...

- one-shot: `midstudy-calib align-room` as a fresh process, twice (each loads MASt3R: the cold path the server takes
  when its worker isn't running);
- worker: one `midstudy-calib serve`, two align-room requests: the first pays for importing torch and loading the
  network, the second is warm.
Prints one JSON object: wall seconds per run, plus the answer's own elapsed_s and placed count. MIDSTUDY_CALIB_MOCK is
removed from the environment. Run it under the eval lock (`node scripts/eval-lock.mjs --exclusive -- …`) for numbers.
"""
from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
from pathlib import Path
from typing import cast

CLI = [sys.executable, "-m", "midstudy_calib.cli"]


def env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items() if k != "MIDSTUDY_CALIB_MOCK"}


def summary(res: dict[str, object], wall: float) -> dict[str, object]:
    members = cast(list[dict[str, object]], res.get("members") or [])
    return {"wall_s": round(wall, 2), "ok": res.get("ok"), "solver": res.get("solver"), "elapsed_s": res.get("elapsed_s"),
            "placed": sum(1 for m in members if m.get("pose") is not None), "error": res.get("error")}


def one_shot(scenes: list[str], out: Path, extra: list[str]) -> dict[str, object]:
    t0 = time.monotonic()
    p = subprocess.run([*CLI, "align-room", *scenes, "--out", str(out), *extra], capture_output=True, text=True, env=env(), check=False)
    res = cast(dict[str, object], json.loads(p.stdout.strip().splitlines()[-1]))
    return summary(res, time.monotonic() - t0)


def worker(scenes: list[str], out: Path, extra: list[str], n: int) -> list[dict[str, object]]:
    proc = subprocess.Popen([*CLI, "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, env=env())
    assert proc.stdin is not None and proc.stdout is not None
    rows: list[dict[str, object]] = []
    try:
        for i in range(n):
            t0 = time.monotonic()
            proc.stdin.write(json.dumps({"id": f"b-{i}", "cmd": "align-room", "args": [*scenes, "--out", str(out / f"w{i}"), *extra]}) + "\n")
            proc.stdin.flush()
            line = proc.stdout.readline()
            rows.append(summary(cast(dict[str, object], json.loads(line)), time.monotonic() - t0))
    finally:
        proc.stdin.close()
        proc.wait(timeout=60)
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="align-room's run time, one-shot and through the worker")
    ap.add_argument("scenes", nargs="+")
    ap.add_argument("--solver", default="mast3r")
    ap.add_argument("--device", default="auto")
    ap.add_argument("--out", type=Path, default=Path("evals/out/bench-rooms"))
    a = ap.parse_args()
    scenes = [str(Path(s).resolve()) for s in a.scenes]
    extra = ["--solver", a.solver, "--device", a.device]
    out = a.out.resolve()
    result = {"photos": len(scenes), "solver": a.solver,
              "one_shot": [one_shot(scenes, out / f"o{i}", extra) for i in range(2)],
              "worker": worker(scenes, out, extra, 2)}
    print(json.dumps(result, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
