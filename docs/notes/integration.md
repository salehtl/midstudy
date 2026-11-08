# integration notes

## State machines W5: tooling-eval-lock

`scripts/eval-lock.mjs` now uses `scripts/lib/dirlock.mjs` for its slots and the exclusive marker, keeping the lock root, the slot names and an owner.json the old script can read. A live pid on this host is never stale; `--stale-min` only applies to an owner on another host. The exclusive run keeps its marker until it ends and waits for live slots past its own `--slots`. Flags are strict (bad value or unknown flag: usage, exit 2). The command runs in its own process group with stdin ignored; signals go to the group, SIGKILL after 60 s or on a second signal, and the same bounded wait applies to group members left after a normal exit, before the slots go back. Tests: `scripts/test/eval-lock.test.mjs`.

Beyond the design: a shared request re-reads the marker after claiming its slot and backs off if one went up (marker-then-scan against claim-then-check, so a `--slots 5` request can't slip in behind the exclusive scan); signals within 2 s of the first count once, as in createEval, so a wrapper's duplicate forward doesn't SIGKILL an eval mid-cleanup; `MIDSTUDY_EVAL_LOCK_GRACE_S` shortens the grace for tests only.

During the wave a worktree still on the old script keeps respecting the new holders, but it can still reclaim a live holder past 180 min by age, until it merges this.
