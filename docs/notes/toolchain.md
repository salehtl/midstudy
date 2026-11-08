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
