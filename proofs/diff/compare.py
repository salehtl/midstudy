"""Compares the Lean model's and the Rust's results on one corpus (proofs/diff/run.sh): every line (result, clean, the
decoded or rendered values) and the stripped bytes must be identical. For `sniff` the model's photo type is also
compared with calib's own Python `sniff(data[:64])` (v1's table, which `Midstudy.Sniff.photoExt_sniff` proves equal)."""
import ast
import collections
import sys
from pathlib import Path

mode, out = sys.argv[1], Path(sys.argv[2])
repo = Path(__file__).resolve().parents[2]
lean = (out / "lean.tsv").read_text().splitlines()
rust = (out / "rust.tsv").read_text().splitlines()
assert len(lean) == len(rust), (len(lean), len(rust))


def outcome(f):
    """A short key for the outcome counts."""
    if mode == "b64":
        strict, lenient, _ = f[2].split("|")
        return ("strict", strict.split(":")[0] if strict.startswith("ok") else strict.split("@")[0], "")
    if mode == "meta":
        if f[2] == "not-utf8-input":
            return ("input", "not UTF-8", "")
        first = f[2].split("|")[0]
        return ("16K cap", "ok" if first.startswith("ok") else ":".join(first.split(":")[:2]).split("@")[0], "")
    if mode == "sniff":
        return ("kind", f[2], "")
    if mode == "wire":
        return ("read", "bad-input" if f[2] == "bad-input" else "entries", f"zip_plan {f[3]}")
    return (f[1], f[2] if f[1] in ("err", "res") else "", f[3])


bad, kinds = [], collections.Counter()
for l, r in zip(lean, rust):
    ln, rn = l.split("\t"), r.split("\t")
    kinds[outcome(ln)] += 1
    if ln != rn:
        bad.append((l, r))
    elif ln[1] == "ok" and (out / "lean" / ln[0]).read_bytes() != (out / "rust" / rn[0]).read_bytes():
        bad.append((l, r + "  (bytes differ)"))

calib_bad = []
if mode == "sniff":
    # calib's sniff and its brand sets, taken from its source (ingest.py) and run as they are
    tree = ast.parse((repo / "calib/src/midstudy_calib/ingest.py").read_text())
    names = {"HEIF_BRANDS", "GENERIC_HEIF_BRANDS", "AVIF_BRANDS"}
    keep = [n for n in tree.body if (isinstance(n, ast.Assign) and any(getattr(t, "id", "") in names for t in n.targets))
            or (isinstance(n, ast.FunctionDef) and n.name == "sniff")]
    ns = {"Kind": object}
    exec(compile(ast.Module(body=keep, type_ignores=[]), "ingest.py", "exec"), ns)
    paths = [p for p in (out / "corpus" / "list.txt").read_text().splitlines() if p]
    for path, l in zip(paths, lean):
        ext = l.split("\t")[2].split(",")[1]
        want = ns["sniff"](Path(path).read_bytes()[:64]) or "-"
        if ext != want:
            calib_bad.append((l, want))

oks = sum(v for k, v in kinds.items() if k[0] == "ok")
if mode == "slug":
    print(f"{mode}: {len(lean)} strings; outcomes:")
elif mode == "frame":
    print(f"{mode}: {len(lean)} files, {sum(v for k, v in kinds.items() if k[0] == 'res')} sized; outcomes (a few):")
    kinds = collections.Counter({("res", "(a size)", "-"): sum(v for k, v in kinds.items() if k[0] == "res"),
                                 **{k: v for k, v in kinds.items() if k[0] == "err"}})
elif mode in ("b64", "meta", "sniff", "wire"):
    print(f"{mode}: {len(lean)} inputs; outcomes:")
else:
    print(f"{mode}: {len(lean)} files, {oks} stripped, {len(lean) - oks} refused; outcomes:")
for k, v in sorted(kinds.items()):
    print(f"  {v:6d}  {k[0]} {k[1]}" + (f" clean={k[2]}" if mode in ("jpeg", "png", "slug", "frame") else f" {k[2]}"))
for l, r in bad[:20]:
    print("DIFF lean:", l, "| rust:", r)
for l, want in calib_bad[:20]:
    print("CALIB lean:", l, "| calib sniff:", want)
what = {"slug": "is_slug", "frame": "frame_info", "b64": "decode_python strict and lenient, encode",
        "meta": "meta::decode at both caps", "sniff": "sniff, photo_ext, api::sniff",
        "wire": "the Reader's entries and zip_plan's bad-input"}.get(mode, "result, is_clean and stripped bytes")
extra = f"; calib's sniff(data[:64]) agrees on {len(lean) - len(calib_bad)}/{len(lean)}" if mode == "sniff" else ""
ok = not bad and not calib_bad
print(f"proofs/diff {mode}: {'OK' if ok else 'FAIL'} ({len(lean) - len(bad)}/{len(lean)} identical: {what}{extra})")
sys.exit(0 if ok else 1)
