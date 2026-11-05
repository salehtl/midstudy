#!/usr/bin/env bash
# Runs a command in proofs/ with the pinned Lean (nix/lean.nix: the official 4.29.1 release, the one Mathlib v4.29.1
# needs) first on PATH, and Mathlib's download cache kept inside proofs/.lake (never in ~).
#   proofs/run.sh lake exe cache get     # Mathlib's compiled files (once, after a fresh clone)
#   proofs/run.sh lake build             # check every proof
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
lean="$(nix build -f "$here/../nix/lean.nix" --no-link --print-out-paths)"
export PATH="$lean/bin:$PATH"
export MATHLIB_CACHE_DIR="$here/.lake/mathlib-cache"
cd "$here"
exec "$@"
