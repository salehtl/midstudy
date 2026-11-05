#!/usr/bin/env bash
# One cargo-fuzz campaign (docs/notes/kernels-hardening.md): `core/fuzz/campaign.sh <target> <seconds> [libFuzzer args]`,
# from the repository root, inside `nix develop .#nightly` (ASan, the default sanitizer). New inputs go to
# evals/out/kh/fuzz/<target>/corpus/ (git-ignored), crashes to .../artifacts/; the campaign reads the tracked corpus
# (fuzz/corpus/<target>/) and the generated seeds (evals/out/kh/fuzz-seeds/<target>/, core/crates/media/fuzz/seeds.py)
# as seeds. Afterwards `core/fuzz/minimize.sh <target>` merges what it found into the tracked corpus.
set -euo pipefail
target=${1:?target}; secs=${2:?seconds}; shift 2
root=$(pwd)
case $target in
  decode_png|mask_and_env) crate=core/crates/raster ;;
  *) crate=core/crates/media ;;
esac
case $target in
  jpeg_strip) dict=core/crates/media/fuzz/dicts/jpeg.dict; maxlen=65536 ;;
  png_strip) dict=core/crates/media/fuzz/dicts/png.dict; maxlen=65536 ;;
  glb_strip) dict=core/crates/media/fuzz/dicts/glb.dict; maxlen=65536 ;;
  path_normalize) dict=core/crates/media/fuzz/dicts/path.dict; maxlen=4096 ;;
  host_check) dict=core/crates/media/fuzz/dicts/host.dict; maxlen=1024 ;;
  media_misc) dict=core/crates/media/fuzz/dicts/glb.dict; maxlen=8192 ;;
  decode_png) dict=core/crates/raster/fuzz/png.dict; maxlen=65536 ;;
  mask_and_env) dict=; maxlen=16384 ;;
  *) echo "campaign: unknown target $target" >&2; exit 2 ;;
esac
out=$root/evals/out/kh/fuzz/$target
mkdir -p "$out/corpus" "$out/artifacts"
seeds=()
for d in "$root/$crate/fuzz/corpus/$target" "$root/evals/out/kh/fuzz-seeds/$target"; do [ -d "$d" ] && seeds+=("$d"); done
cd "$root/$crate"
exec cargo fuzz run "$target" "$out/corpus" "${seeds[@]}" -- -max_total_time="$secs" -max_len="$maxlen" \
  -artifact_prefix="$out/artifacts/" ${dict:+-dict=$root/$dict} -print_final_stats=1 "$@"
