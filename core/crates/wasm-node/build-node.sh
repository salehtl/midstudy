#!/usr/bin/env bash
# Builds the media kernels for Node into build/wasm/node/ (midstudy_wasm_node.js, .wasm, .d.ts), the files
# core/js/node.ts loads. A stopgap until f-toolchain's build (rust-overlay's wasm toolchain) takes over; it uses the
# pinned nixpkgs' rustc (which ships the wasm32-unknown-unknown std), lld's wasm-ld as the linker (nixpkgs' rustc has
# no rust-lld), wasm-bindgen-cli 0.2.121 (the crate pins wasm-bindgen = "=0.2.121") and binaryen's wasm-opt.
#
#   core/crates/wasm-node/build-node.sh            (from anywhere in the repo)
set -euo pipefail
root="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
np="github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c"
out="$root/build/wasm/node"
cd "$root/core"
nix shell "$np#cargo" "$np#rustc" "$np#lld" "$np#wasm-bindgen-cli" "$np#binaryen" -c bash -euo pipefail -c '
  out="$1"
  # SIMD128 (Node 22 has it): the JPEG scan and the GLB comparison vectorize, ~3x on a 12 MP JPEG.
  CARGO_TARGET_WASM32_UNKNOWN_UNKNOWN_LINKER=wasm-ld RUSTFLAGS="-C target-feature=+simd128" \
    cargo build --release --target wasm32-unknown-unknown -p midstudy-wasm-node
  rm -rf "$out" && mkdir -p "$out"
  wasm-bindgen --target nodejs --out-dir "$out" target/wasm32-unknown-unknown/release/midstudy_wasm_node.wasm
  # The nodejs target writes CommonJS (exports.x = ...); the repo is "type": "module", so mark this folder CommonJS.
  printf "{\"type\": \"commonjs\"}\n" > "$out/package.json"
  wasm-opt -O3 --enable-simd --enable-bulk-memory --enable-nontrapping-float-to-int --enable-sign-ext \
    --enable-mutable-globals --enable-reference-types --enable-multivalue \
    "$out/midstudy_wasm_node_bg.wasm" -o "$out/midstudy_wasm_node_bg.wasm"
  ls -l "$out"
' _ "$out"
