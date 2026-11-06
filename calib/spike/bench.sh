#!/usr/bin/env bash
# Stage 2 of the rooms spike: every solver on the golden room fixtures (docs/notes/rooms-calib.md).
#   calib/spike/bench.sh FIXTURES_DIR OUT_DIR [RUN_TAG] [SOLVERS...]
# FIXTURES_DIR holds living-wide and room-1..room-6 (A1's fixtures/scenes, or a copy under evals/out/).
# Writes OUT_DIR/<set>-<solver>-<tag>.json (+ .log). Run from the repo root inside `nix develop`.
# REFINE=icp passes --refine icp (the solver's poses re-fitted on the members' depth points).
set -euo pipefail
fx=$1; out=$2; tag=${3:-r1}; shift 3 || shift $#
solvers=("$@"); [ ${#solvers[@]} -gt 0 ] || solvers=(manhattan solv3r vggt mast3r)
mkdir -p "$out"
declare -A sets=(
  [all]="living-wide room-1 room-2 room-3 room-4 room-5 room-6"
  [low-overlap]="room-1 room-4"
  [low-overlap-lw]="living-wide room-4"
  [blank-wall]="room-3 room-6"
  [blank-wall-lw]="living-wide room-6"
)
for s in "${solvers[@]}"; do
  for set in all low-overlap low-overlap-lw blank-wall blank-wall-lw; do
    dirs=(); for n in ${sets[$set]}; do dirs+=("$fx/$n"); done
    echo "bench: $set $s $tag" >&2
    uv run --quiet --project calib/spike python calib/spike/run.py "${dirs[@]}" --solver "$s" --refine "${REFINE:-none}" --truth \
      --out "$out/$set-$s-$tag.json" > /dev/null 2> "$out/$set-$s-$tag.log" || echo "bench: FAILED $set $s $tag" >&2
  done
done
