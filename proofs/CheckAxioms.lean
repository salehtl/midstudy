import Midstudy

/-!
Run by `proofs/check.sh` (not part of the library): every declaration under `Midstudy` may use Lean's three
standard axioms only (`propext`, `Classical.choice`, `Quot.sound`, which Mathlib uses throughout). A proof left
open (`sorryAx`), `native_decide` (`Lean.ofReduceBool`) or a new `axiom` fails this check.
-/

open Lean Elab Command

elab "#check_midstudy_axioms" : command => do
  let env ← getEnv
  let allowed := [``propext, ``Classical.choice, ``Quot.sound]
  let names := env.constants.fold (init := (#[] : Array Name)) fun acc name _ =>
    if (`Midstudy).isPrefixOf name && !name.isInternal then acc.push name else acc
  let mut bad : Array (Name × Name) := #[]
  for name in names do
    let axs ← liftCoreM <| collectAxioms name
    for a in axs do
      if !allowed.contains a then bad := bad.push (name, a)
  if bad.isEmpty then
    logInfo m!"axioms ok: {names.size} declarations under Midstudy use only propext, Classical.choice, Quot.sound"
  else
    throwError m!"non-standard axioms: {bad.toList}"

#check_midstudy_axioms
