# toolchain notes

## State machines W3: tooling-dirlock

`scripts/lib/dirlock.mjs` is the synchronous mirror of `common/lock.ts`'s protocol for the scripts: `tryClaim(dir, {cmd, staleMs})` (null while held; async callers poll it), an owner-checked `release()`, `releaseAllSync()`, `readOwner(dir)` (for "held by ..." messages). Staleness is `lockVerdict` from `common/logic/lock.ts`, with `staleMs = Infinity` and no margin for same-host owners, so a live pid never goes stale. `staleMs` only applies to an owner on another host (default 180 min, eval-lock's old `--stale-min`).

Nothing uses it yet: tooling-build, tooling-gates, tooling-eval-lock, tooling-harness and tooling-perf move to it in later waves. `npm run test:scripts` (in check:tests) runs `scripts/test/*.test.mjs`, knip has that glob as an entry.

Test hook: `MIDSTUDY_DIRLOCK_TEST_PAUSE=<file>` stops a reclaimer between its judgment and the aside rename. It creates `<file>.paused.<pid>`, then waits up to 30 s for `<file>`, so a test needs no timing. A test's claimer must stay alive while others race: a holder that exits is a dead owner, which may be reclaimed at once.

Beyond common/lock.ts, deliberately: a claimer that loses its owner.json write to a reclaimer's aside rename (ENOENT, or EINVAL on macOS when the open lands mid-rename; a stress run found it, and common/lock.ts would throw there) retries instead of throwing, and a reclaimer that can't put back a folder with no owner.json removes it, so neither the error nor a stray `.stale-` folder escapes. In that interleaving nobody may hold the lock for up to the 10 s grace; it is never held twice.
