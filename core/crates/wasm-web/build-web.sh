#!/usr/bin/env bash
# `npm run build` (scripts/build.mjs) builds build/wasm/web/. This script stays for one thing: the build without SIMD128
# that tests/bench.mjs compares against (`--no-simd` writes build/wasm/web-nosimd/). Tools from the flake's pinned
# nixpkgs. Usage, from the repo root: core/crates/wasm-web/build-web.sh [--no-simd]
set -euo pipefail
cd "$(dirname "$0")/../../.."
NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c
FLAGS="-C target-feature=+simd128"
OUT=build/wasm/web
if [[ "${1:-}" == "--no-simd" ]]; then FLAGS=""; OUT=build/wasm/web-nosimd; fi
nix shell "$NP#cargo" "$NP#rustc" "$NP#lld" "$NP#wasm-bindgen-cli" "$NP#binaryen" -c bash -c "
  set -euo pipefail
  cd core
  RUSTFLAGS='$FLAGS' cargo build --release --target wasm32-unknown-unknown -p midstudy-wasm-web
  cd ..
  rm -rf '$OUT' && mkdir -p '$OUT'
  wasm-bindgen --target web --out-dir '$OUT' core/target/wasm32-unknown-unknown/release/midstudy_wasm_web.wasm
  wasm-opt -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-reference-types --enable-multivalue \
    '$OUT/midstudy_wasm_web_bg.wasm' -o '$OUT/midstudy_wasm_web_bg.wasm'
  ls -l '$OUT'
"
