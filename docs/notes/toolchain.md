# toolchain notes

## State machines W3: tooling-dirlock

`scripts/lib/dirlock.mjs` is the synchronous mirror of `common/lock.ts`'s protocol for the scripts: `tryClaim(dir, {cmd, staleMs})` (null while held; async callers poll it), an owner-checked `release()`, `releaseAllSync()`, `readOwner(dir)` (for "held by ..." messages). Staleness is `lockVerdict` from `common/logic/lock.ts`, with `staleMs = Infinity` and no margin for same-host owners, so a live pid never goes stale. `staleMs` only applies to an owner on another host (default 180 min, eval-lock's old `--stale-min`).

Nothing uses it yet: tooling-build, tooling-gates, tooling-eval-lock, tooling-harness and tooling-perf move to it in later waves. `npm run test:scripts` (in check:tests) runs `scripts/test/*.test.mjs`, knip has that glob as an entry.

Test hook: `MIDSTUDY_DIRLOCK_TEST_PAUSE=<file>` stops a reclaimer between its judgment and the aside rename. It creates `<file>.paused.<pid>`, then waits up to 30 s for `<file>`, so a test needs no timing. A test's claimer must stay alive while others race: a holder that exits is a dead owner, which may be reclaimed at once.

Beyond common/lock.ts, deliberately: a claimer that loses its owner.json write to a reclaimer's aside rename (ENOENT, or EINVAL on macOS when the open lands mid-rename; a stress run found it, and common/lock.ts would throw there) retries instead of throwing, and a reclaimer that can't put back a folder with no owner.json removes it, so neither the error nor a stray `.stale-` folder escapes. In that interleaving nobody may hold the lock for up to the 10 s grace; it is never held twice.

## State machines W4: tooling-gates

`scripts/check.mjs`: `check:py` always runs `uv sync --project calib --frozen --inexact --quiet` (a partial venv from an interrupted sync gets repaired; `--inexact` keeps the `rooms` extra). `check:proofs` fetches Mathlib's cache unless `build/check/mathlib-cache.json {rev}` matches `proofs/lake-manifest.json` and the build folder is there; the marker is written only after `lake exe cache get` exits 0. Requiring the folder too goes a little past the plan: a wiped `proofs/.lake` with a surviving marker would otherwise build Mathlib from source. `check:gen` runs `gen-contract.mjs --check`, which also compares `core/crates/contract/schema.json`, so the gate writes nothing.

`scripts/tscert-ratchet.mjs`: the dirlock `build/locks/tscert.lock` (wait up to 60 min) is held from before `build/tscert/jobs.json` is written to the end of the run, the `--update` baseline rewrite included. A full run whose result lacks a job's file exits 1 with "the jobs file changed under this run", and never rewrites the baseline. The waiting line goes to stdout because `check:tscert` reports the last line of stdout+stderr. `scripts/tscert.mjs` is unchanged: it is an input of the sandboxed run.

Tests (`npm run test:scripts`): `check-gen.test.mjs`, `tscert-lock.test.mjs`. They run copies of the scripts in temp trees with PATH shims; the two check:gen tests use a detached `git worktree add` under the temp dir and remove it afterwards.
