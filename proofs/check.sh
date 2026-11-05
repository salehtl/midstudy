#!/usr/bin/env bash
# check:proofs (docs/REFACTOR.md §3): `lake build` in proofs/, no open proofs or new axioms in the sources, and every
# declaration under Midstudy using Lean's three standard axioms only (CheckAxioms.lean). One summary line at the end.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$here/run.sh" lake build
if grep -rnwE 'sorry|admit|native_decide' "$here/Midstudy" "$here/Midstudy.lean" ||
   grep -rnE '^[[:space:]]*(private[[:space:]]+)?axiom[[:space:]]' "$here/Midstudy" "$here/Midstudy.lean"; then
  echo "check:proofs: FAIL (an open proof, native_decide or an axiom in the sources)"
  exit 1
fi
out="$("$here/run.sh" lake env lean CheckAxioms.lean 2>&1)" || { echo "$out"; echo "check:proofs: FAIL (axioms)"; exit 1; }
echo "$out"
files=$(ls "$here"/Midstudy/*.lean | wc -l | tr -d ' ')
thms=$(cat "$here"/Midstudy/*.lean | grep -cE '^(theorem|lemma) ')
echo "check:proofs: ok ($files files, $thms theorems, Lean $("$here/run.sh" lean --short-version 2>/dev/null || echo 4.29.1), Mathlib v4.29.1)"
