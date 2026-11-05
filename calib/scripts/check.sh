#!/usr/bin/env bash
# check:py (docs/REFACTOR.md §3) for calib/: the generated contract types are current, ruff is clean over calib/ and
# pyright --strict over src, tests and the checked scripts (calib/pyproject.toml). Run inside `nix develop` (uv).
# pyright and ruff come from PATH when the dev shell has them, else as one-offs from the flake's pinned nixpkgs
# (pyright 1.1.411, ruff 0.15.14); nothing is installed.
set -euo pipefail
cd "$(dirname "$0")/.."
NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c
tool() { if command -v "$1" >/dev/null 2>&1; then "$@"; else nix shell "$NP#$1" -c "$@"; fi; }

uv sync --quiet
uv run --quiet python scripts/gen_contract_types.py --check
echo "gen_contract_types: current"
tool ruff check --quiet .
echo "ruff: clean"
if ! out=$(tool pyright 2>&1); then echo "$out"; exit 1; fi
echo "pyright: ${out##*$'\n'}"
echo "check:py: ok"
