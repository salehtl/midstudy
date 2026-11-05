#!/usr/bin/env bash
# The differential test of the JPEG stripper: the proved Lean model (`lake exe jpegstrip`) against the Rust
# (core/crates/media, needs the media crate on this branch) on the same corpus: every file's result (ok or the error
# kind), `is_clean`, and the stripped bytes must be identical. Scratch output in evals/out/proofs-diff/.
#   proofs/diff/run.sh [N_SYNTH]     (default 3000 synthetic JPEGs, plus the repo's JPEG fixtures and mutations)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"
out="${MIDSTUDY_DIFF_OUT:-$repo/evals/out/proofs-diff}"
NP=github:nixos/nixpkgs/1f607aa79b6356ed45d3cd3c8079c196e79efa2c
rm -rf "$out" && mkdir -p "$out"
python3 "$here/gen_corpus.py" "$repo" "$out/corpus" "${1:-3000}"
"$here/../run.sh" lake build jpegstrip >/dev/null
"$here/../.lake/build/bin/jpegstrip" "$out/corpus/list.txt" "$out/lean" > "$out/lean.tsv"
(cd "$here" && nix shell "$NP#cargo" "$NP#rustc" -c cargo build --release --quiet --target-dir "$out/target")
"$out/target/release/midstudy-proofs-diff" "$out/corpus/list.txt" "$out/rust" > "$out/rust.tsv"
python3 - "$out" <<'PY'
import sys, collections
from pathlib import Path
out = Path(sys.argv[1])
lean = (out / "lean.tsv").read_text().splitlines()
rust = (out / "rust.tsv").read_text().splitlines()
assert len(lean) == len(rust), (len(lean), len(rust))
bad, kinds = [], collections.Counter()
for l, r in zip(lean, rust):
    ln, rn = l.split("\t"), r.split("\t")
    kinds[(ln[1], ln[2] if ln[1] == "err" else "", ln[3])] += 1
    if ln != rn:
        bad.append((l, r))
    elif ln[1] == "ok" and (out / "lean" / ln[0]).read_bytes() != (out / "rust" / rn[0]).read_bytes():
        bad.append((l, r + "  (bytes differ)"))
oks = sum(v for k, v in kinds.items() if k[0] == "ok")
print(f"files {len(lean)}: ok {oks}, refused {len(lean) - oks}; outcome kinds:")
for k, v in sorted(kinds.items()):
    print(f"  {v:6d}  {k[0]} {k[1]} clean={k[2]}")
for l, r in bad[:20]:
    print("DIFF lean:", l, "| rust:", r)
print(f"proofs/diff: {'OK' if not bad else 'FAIL'} ({len(lean) - len(bad)}/{len(lean)} files identical: result, "
      f"is_clean and stripped bytes)")
sys.exit(1 if bad else 0)
PY
