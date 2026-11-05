#!/usr/bin/env bash
# Bundles page.ts and worker.ts with esbuild (from the flake's pinned nixpkgs) into evals/out/k-geom/browser/, then runs
# them in headless Chrome. Needs build/wasm/web/ (../../build-web.sh). Usage, from the repo root:
#   core/crates/wasm-web/tests/browser/run.sh
set -euo pipefail
cd "$(dirname "$0")/../../../../.."
NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c
OUT=evals/out/k-geom/browser
mkdir -p "$OUT"
nix shell "$NP#esbuild" -c esbuild core/crates/wasm-web/tests/browser/page.ts core/crates/wasm-web/tests/browser/worker.ts \
  --bundle --format=esm --target=es2022 --outdir="$OUT" --log-level=warning
nix develop -c node core/crates/wasm-web/tests/browser/run.mjs
