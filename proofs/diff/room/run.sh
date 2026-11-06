#!/usr/bin/env bash
# The differential test of the room maps (contract §4.9; docs/notes/rooms-proofs.md): the Lean model of sceneToRoom,
# roomToScene, rotationToScene and rotationToRoom (`lake exe roommodel`, the expressions Midstudy/Room.lean proves,
# over Float) against the TypeScript, on seeded random inputs. The module under test is harness.mjs's ROOM_MODULE (the
# reference room_ref.mjs until integration switches it to planner/logic/room.ts). Scratch output in
# evals/out/proofs-diff-room/.
#   nix develop -c proofs/diff/room/run.sh [N]     (default 20000 cases per map; SEED=<n>, MIDSTUDY_ROOM_MODULE=<path>)
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../../.." && pwd)"
out="${MIDSTUDY_DIFF_OUT:-$repo/evals/out/proofs-diff-room}"
rm -rf "$out" && mkdir -p "$out"
"$here/../../run.sh" lake build roommodel >/dev/null
cd "$repo"
exec node "$here/harness.mjs" --lean "$here/../../.lake/build/bin/roommodel" --out "$out" --n "${1:-20000}"
