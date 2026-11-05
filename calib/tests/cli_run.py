"""Running midstudy-calib (and the stub, fixtures/stub_calib.py) as the server does: a subprocess whose last stdout line
is the result. Shared by the CLI tests."""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path
from typing import cast

from synthetic import REPO

CLIS = {"midstudy-calib": [sys.executable, "-m", "midstudy_calib.cli"], "stub": [sys.executable, str(REPO / "fixtures/stub_calib.py")]}


def clean_env(env: dict[str, str] | None = None) -> dict[str, str]:
    """This process's environment without MIDSTUDY_CALIB_MOCK, plus `env`."""
    e = {k: v for k, v in os.environ.items() if k != "MIDSTUDY_CALIB_MOCK"}
    e.update(env or {})
    return e


def run_cli(which: str, *args: str | Path, env: dict[str, str] | None = None) -> tuple[int, dict[str, object], str]:
    """(exit code, the result line as JSON, stderr); nothing but that one line may reach stdout."""
    p = subprocess.run([*CLIS[which], *map(str, args)], capture_output=True, text=True, env=clean_env(env), check=False)
    lines = p.stdout.strip().splitlines()
    assert len(lines) == 1, p.stdout  # nothing else reaches stdout
    res: object = json.loads(lines[-1])
    assert isinstance(res, dict)
    return p.returncode, cast(dict[str, object], res), p.stderr
