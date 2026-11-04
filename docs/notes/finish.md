# Finish notes

The finish agent (PLAN.md §7, last phase) ran the evals, wrote `docs/STATUS.md` and `README.md`, corrected stale eval
numbers in `docs/HANDOFF.md`, and committed everything left uncommitted on `v1`. 2026-11-05, M3 Max, fal mocked, $0.

## Evals run here

Logs are in `evals/out/finish/` (git-ignored).

| Command | Result |
|---|---|
| `nix develop -c npm run eval:all` | all pass: E1 172, E3 55, E4 20, E5 34, E6 36, E7 69, E8 43, E9 48, E11 28, E12 26 (about 5 min) |
| `nix develop -c npm run eval:calib` | 84/91, failing E2.06 E2.07 E2.11 E2.33 E2.50 E2.51 E2.55 (the known golden misses, no EXIF) |
| `nix develop -c npm run eval:calib -- --no-real-photos` | 59/66, the same 7 |
| `nix develop -c npm run eval:calib -- --mock` | 51/51 |
| `nix develop -c npm run eval:real` | 31/31 |
| `nix develop -c npm run eval:selftest` | 22/22 |
| `nix develop -c bash -c 'cd calib && uv run pytest -q'` | 42 passed |
| `nix flake check --no-build --all-systems` | passes (evaluation only) |

Nothing was broken, so no code changed. I looked at `evals/out/integrate/03`, `08`, `16` and `17` from today's
`eval:real`. The grid sits on the lounge floor, the second chair's legs are hidden by the coffee table, and Compare
split and the phone layout render correctly.

## What changed

- `README.md`: rewritten for midstudy (what it is, run, add furniture, calibration, evals, hosting).
- `docs/STATUS.md`: new, for the user.
- `docs/HANDOFF.md`:
  - §5 now says the Nix-built calib runs predate verify round 2.
  - §9 step 7 expects 59/66 with the round-2 failing ids (it said 29/36 with old ids).
  - §11 lists E11 and E12 in `eval:all`.
- Committed the packaging phase's work: `flake.nix`, `nix/*` and `docs/notes/packaging.md`.

## Left

- **Nix calib not rebuilt after verify round 2.** The Mac's store no longer holds the packaging closure: torch-bin,
  the weights and calib were garbage-collected. To rebuild on the Mac:
  1. Re-add the weights from the HF cache with `nix-store --add-fixed sha256` (`docs/notes/packaging.md`).
  2. Run `nix build .#midstudy-calib`.
  3. Run `eval:calib -- --cli <out>/bin/midstudy-calib`. Expect 84/91.
- **`.gitignore` is fixed.** The `.gitignore` problem in `packaging.md` ("Seen while working") is already fixed: the
  `/*` rules are at the top, and `git check-ignore` confirms `.env`, `.upstream/`, `node_modules/` and an
  extensionless root photo are ignored.
- Everything else is in `docs/STATUS.md` ("Known gaps", "Next steps").
