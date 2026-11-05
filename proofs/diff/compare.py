"""Compares the Lean model's and the Rust's results on one corpus (proofs/diff/run.sh): result, clean, bytes."""
import collections
import sys
from pathlib import Path

mode, out = sys.argv[1], Path(sys.argv[2])
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
print(f"{mode}: {len(lean)} files, {oks} stripped, {len(lean) - oks} refused; outcomes:")
for k, v in sorted(kinds.items()):
    print(f"  {v:6d}  {k[0]} {k[1]} clean={k[2]}")
for l, r in bad[:20]:
    print("DIFF lean:", l, "| rust:", r)
print(f"proofs/diff {mode}: {'OK' if not bad else 'FAIL'} ({len(lean) - len(bad)}/{len(lean)} files identical: "
      "result, is_clean and stripped bytes)")
sys.exit(1 if bad else 0)
