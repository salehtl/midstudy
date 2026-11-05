#!/usr/bin/env bash
# The differential test of the JPEG and PNG strippers, is_slug and the JPEG frame size: the proved Lean models (`lake exe mediastrip`) against the Rust
# (core/crates/media: needs the media crate on this branch) on the same generated corpora: every file's result (ok or
# the error kind), JPEG `is_clean`, and the stripped bytes must be identical. Scratch output in evals/out/proofs-diff/.
#   nix develop -c proofs/diff/run.sh [N_SYNTH]   (default 3000 synthetic files per format, plus the repo's fixtures)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="${MIDSTUDY_DIFF_OUT:-$repo/evals/out/proofs-diff}"
NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c
rm -rf "$out" && mkdir -p "$out"
"$here/../run.sh" lake build mediastrip >/dev/null
(cd "$here" && nix shell "$NP#cargo" "$NP#rustc" -c cargo build --release --quiet --target-dir "$out/target")
status=0
for mode in jpeg png slug frame; do
  python3 "$here/gen_corpus.py" "$mode" "$repo" "$out/$mode/corpus" "${1:-3000}"
  "$here/../.lake/build/bin/mediastrip" "$mode" "$out/$mode/corpus/list.txt" "$out/$mode/lean" > "$out/$mode/lean.tsv"
  "$out/target/release/midstudy-proofs-diff" "$mode" "$out/$mode/corpus/list.txt" "$out/$mode/rust" > "$out/$mode/rust.tsv"
  python3 "$here/compare.py" "$mode" "$out/$mode" || status=1
done
exit $status
