# toolchain notes

## State machines W3: tooling-dirlock

`scripts/lib/dirlock.mjs` is the synchronous mirror of `common/lock.ts`'s protocol for the scripts: `tryClaim(dir, {cmd, staleMs})` (null while held; async callers poll it), an owner-checked `release()`, `releaseAllSync()`, `readOwner(dir)` (for "held by ..." messages). Staleness is `lockVerdict` from `common/logic/lock.ts`, with `staleMs = Infinity` and no margin for same-host owners, so a live pid never goes stale. `staleMs` only applies to an owner on another host (default 180 min, eval-lock's old `--stale-min`).

Nothing uses it yet: tooling-build, tooling-gates, tooling-eval-lock, tooling-harness and tooling-perf move to it in later waves. `npm run test:scripts` (in check:tests) runs `scripts/test/*.test.mjs`, knip has that glob as an entry.

Test hook: `MIDSTUDY_DIRLOCK_TEST_PAUSE=<file>` stops a reclaimer between its judgment and the aside rename. It creates `<file>.paused.<pid>`, then waits up to 30 s for `<file>`, so a test needs no timing. A test's claimer must stay alive while others race: a holder that exits is a dead owner, which may be reclaimed at once.

Beyond common/lock.ts, deliberately: a claimer that loses its owner.json write to a reclaimer's aside rename (ENOENT, or EINVAL on macOS when the open lands mid-rename; a stress run found it, and common/lock.ts would throw there) retries instead of throwing, and a reclaimer that can't put back a folder with no owner.json removes it, so neither the error nor a stray `.stale-` folder escapes. In that interleaving nobody may hold the lock for up to the 10 s grace; it is never held twice.

## State machines W4: tooling-build

`scripts/build.mjs`'s step locks now go through `scripts/lib/dirlock.mjs` (polled every 150 ms, 30 min limit). A live holder keeps its lock however old; a dead pid is reclaimed at once, a folder with no readable owner.json after 10 s. No signal handlers, on purpose: the tools run through spawnSync, so a handler would make the build unkillable. `buildWasm` starts by removing `build/wasm/.tmp-*-<pid>` folders whose pid is dead.

`scripts/lib/stamps.mjs` holds the stamp decisions. `buildStart` is taken after the lock and the stamp check, before cargo or esbuild; `writeStamp` stats the inputs once and, if one was saved during the build or has gone, removes the old stamp, writes none and logs it. Wasm inputs are every file under `core/crates/**` (no target/, node_modules/, dot-dirs), `core/.cargo/**`, `core/Cargo.toml`, and `core/Cargo.lock` by name. The prune grace is 24 h.

Beyond the design: the wasm stamp check also sees files it never recorded (a new file under `core/crates` is stale), the input walk moved inside the lock, and `scriptKey` hashes stamps.mjs too.

Tests: `scripts/test/build-lock.test.mjs` runs a copy of build.mjs in a temp tree (`--lock-selftest` plus `MIDSTUDY_BUILD_STEP_SLEEP_MS` makes the wasm step a sleep under its lock). Open for packaging: `nix/wasm.nix` and `nix/midstudy-app.nix` list `scripts/build.mjs` by file, and now also need `scripts/lib/` (wasm.nix also `common/logic/lock.ts`), outside this track's paths.
## State machines W4: tooling-gates

`scripts/check.mjs`: `check:py` always runs `uv sync --project calib --frozen --inexact --quiet` (a partial venv from an interrupted sync gets repaired; `--inexact` keeps the `rooms` extra). `check:proofs` fetches Mathlib's cache unless `build/check/mathlib-cache.json {rev}` matches `proofs/lake-manifest.json` and the build folder is there; the marker is written only after `lake exe cache get` exits 0. Requiring the folder too goes a little past the plan: a wiped `proofs/.lake` with a surviving marker would otherwise build Mathlib from source. `check:gen` runs `gen-contract.mjs --check`, which also compares `core/crates/contract/schema.json`, so the gate writes nothing.

`scripts/tscert-ratchet.mjs`: the dirlock `build/locks/tscert.lock` (wait up to 60 min) is held from before `build/tscert/jobs.json` is written to the end of the run, the `--update` baseline rewrite included. A full run whose result lacks a job's file exits 1 with "the jobs file changed under this run", and never rewrites the baseline. The waiting line goes to stdout because `check:tscert` reports the last line of stdout+stderr. `scripts/tscert.mjs` is unchanged: it is an input of the sandboxed run.

Tests (`npm run test:scripts`): `check-gen.test.mjs`, `tscert-lock.test.mjs`. They run copies of the scripts in temp trees with PATH shims; the two check:gen tests use a detached `git worktree add` under the temp dir and remove it afterwards.

## State machines W5: tooling-harness (integration track: harness.mjs is a foundation file)

`evals/lib/harness.mjs`. startServer passes `--port 0` and reads the port from the server's stdout line (60 s, gives up when the process exits), so another eval's server can't answer for this one; `srv.up` goes false on an unexpected exit, `srv.alive()` reads live state also on a copy; `stop()` waits 8 s before SIGKILL. createEval: each cleanup is limited to 15 s (a failing `cleanup <i> finished`, `i` the registration order), finish to 40 s; a signal more than 2 s after the first ends a stuck finish with 130, a burst counts once. ensureBuilt memoizes success and tries a failure twice per process; startServer returns `up:false, why:'the build failed: …'` and spawns nothing (`MIDSTUDY_EVAL_BUILD_CMD` replaces the build in tests). waitScene ends on a string status outside pending/queued/running; waitFor logs its last value on timeout. openPlanner takes `query` and `readyMs` and applies `viewport` on phones too. createEval holds `evals/out/<slug>.lock` (dirlock); a second run in the worktree exits 75.

Deviations from the design: the debounce measures from the first signal, not from the start of finish (with `firstSignalAt` unset the design's test would exit 130 on the first signal during a normal finish). The out-folder lock is released in a `process.on('exit')`, which also covers the watchdog, 130 and evals that call process.exit themselves. Added: at process exit the harness SIGTERMs any server still running, because the new 130 and 40 s exits skip the remaining cleanups. waitScene throws on a non-200 so waitFor's `last` names the status. The `--port 0` proof asserts the flag and the port from stdout; a real port collision can't be staged now that no port is picked beforehand.
