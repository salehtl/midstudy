#!/usr/bin/env bash
# The differential test of the proved Lean models (`lake exe mediastrip`) against the Rust they model, on the same
# generated corpora: core/crates/media (the JPEG and PNG strippers, the JPEG frame size, is_slug, base64 and the
# X-Midstudy-Meta header, sniff) and core/crates/wasm-node (the wire reader behind zip_plan). Every input's result
# (ok or the error kind, JPEG `is_clean`, the stripped or decoded bytes) must be identical.
# Scratch output in evals/out/proofs-diff/.
#   nix develop -c proofs/diff/run.sh [N_SYNTH] [MODE...]   (default 3000 synthetic inputs per mode, plus the repo's
#                                                           fixtures; every mode unless some are named)
#   MIDSTUDY_DIFF_REV=<git rev> …   the crates as committed at that revision (git archive, so no checkout is touched)
#                                   instead of this checkout's core/; the Lean models are always this checkout's.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="${MIDSTUDY_DIFF_OUT:-$repo/evals/out/proofs-diff}"
NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c
n="${1:-3000}"
shift || true
modes=("$@")
[ ${#modes[@]} -gt 0 ] || modes=(jpeg png slug frame b64 meta sniff wire)
rm -rf "$out" && mkdir -p "$out"
harness="$here"
if [ -n "${MIDSTUDY_DIFF_REV:-}" ]; then
  # the harness next to the crates of that revision, in the same relative layout (../../core/crates/…)
  mkdir -p "$out/tree/proofs"
  git -C "$repo" archive "$MIDSTUDY_DIFF_REV" core/Cargo.toml core/crates/media core/crates/wasm-node | tar -x -C "$out/tree"
  mkdir -p "$out/tree/proofs/diff"
  cp -R "$here/Cargo.toml" "$here/Cargo.lock" "$here/src" "$out/tree/proofs/diff/"
  harness="$out/tree/proofs/diff"
  echo "crates from $(git -C "$repo" rev-parse --short "$MIDSTUDY_DIFF_REV") (media last changed at $(git -C "$repo" log -1 --format=%h "$MIDSTUDY_DIFF_REV" -- core/crates/media))"
else
  echo "crates from this checkout (media last changed at $(git -C "$repo" log -1 --format=%h -- core/crates/media)$(git -C "$repo" diff --quiet HEAD -- core/crates/media core/crates/wasm-node || echo ', with uncommitted changes'))"
fi
"$here/../run.sh" lake build mediastrip >/dev/null
(cd "$harness" && nix shell "$NP#cargo" "$NP#rustc" -c cargo build --release --quiet --target-dir "$out/target")
status=0
for mode in "${modes[@]}"; do
  python3 "$here/gen_corpus.py" "$mode" "$repo" "$out/$mode/corpus" "$n"
  "$here/../.lake/build/bin/mediastrip" "$mode" "$out/$mode/corpus/list.txt" "$out/$mode/lean" > "$out/$mode/lean.tsv"
  "$out/target/release/midstudy-proofs-diff" "$mode" "$out/$mode/corpus/list.txt" "$out/$mode/rust" > "$out/$mode/rust.tsv"
  python3 "$here/compare.py" "$mode" "$out/$mode" || status=1
done
exit $status
