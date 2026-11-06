#!/usr/bin/env bash
# Merges a campaign's corpus (evals/out/kh/fuzz/<target>/corpus, core/fuzz/campaign.sh) with the tracked one
# (<crate>/fuzz/corpus/<target>/) into the smallest set with the same coverage (libFuzzer -merge=1), keeps the inputs of
# at most 8 KiB (the tracked corpus stays small; campaigns regenerate big seeds with fuzz/seeds.py), and writes them back
# as the tracked corpus. From the repository root, inside `nix develop .#nightly`.
set -euo pipefail
target=${1:?target}
root=$(pwd)
case $target in
  decode_png|mask_and_env) crate=core/crates/raster ;;
  *) crate=core/crates/media ;;
esac
scratch=$root/evals/out/kh/fuzz/$target
tracked=$root/$crate/fuzz/corpus/$target
mkdir -p "$scratch/corpus" "$tracked"
(cd "$root/$crate" && cargo fuzz build "$target") > "$scratch/minimize.log" 2>&1
bin=$root/$crate/fuzz/target/$(rustc -vV | sed -n 's/^host: //p')/release/$target
rm -rf "$scratch/min"
mkdir -p "$scratch/min"
before=$(cat <(ls "$scratch/corpus") <(ls "$tracked") | sort -u | wc -l)
"$bin" -merge=1 -rss_limit_mb=4096 "$scratch/min" "$tracked" "$scratch/corpus" >> "$scratch/minimize.log" 2>&1
rm -rf "$tracked"
mkdir -p "$tracked"
find "$scratch/min" -type f -size -8193c -exec cp {} "$tracked/" \;
echo "$target: $before -> $(ls "$scratch/min" | wc -l) files after the merge, $(ls "$tracked" | wc -l) kept ($(cat "$tracked"/* 2>/dev/null | wc -c | tr -d ' ') bytes) in ${tracked#$root/}"
