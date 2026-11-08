# server track notes

## State machines W1: server-infra-tools (tool children, the server's stop)

- `common/tools.ts`: every tool runTool spawns is tracked until its 'close'. The timeout now sends SIGTERM to the
  group, SIGKILL after 5 s (`killGraceMs` option, for tests), and resolves 'timeout' only once the tool has closed (a
  hard cap 5 s after the SIGKILL, for a grandchild that left the group). An 'error' after a successful spawn ends the
  group before settling. New `signal?: AbortSignal`: abort runs the same kill sequence and the run resolves as the real
  'exited' (-15, or -9 after SIGKILL); an already aborted signal spawns nothing ('spawn-error'). No new ToolRun variant.
  `killAllTools(graceMs = 5000)` latches (every later runTool is `{kind:'spawn-error', message:'the server is
  stopping'}`, so the library queue can't start the next job's tool) and ends every live group; `liveToolPids()` for
  the stop's log line; a `process.on('exit')` handler SIGKILLs any group still live.
- `server/src/main.ts` stop(): `server.close()` + `closeIdleConnections()` (requests in flight finish), `killAllTools()`,
  the hooks, all raced against a 7 s unref'd limit; at the limit one stderr line names the open requests, live tool
  pids and unsettled hooks, then `closeAllConnections()` and exit(0). A second SIGINT/SIGTERM exits at once. While
  stopping, every response's 'close' calls `closeIdleConnections()` on the next turn: without it a keep-alive
  connection whose request finished after the stop held `server.close()` for its keep-alive timeout (~5 s; the
  shutdown test's layout case checks the exit stays under 3 s).
- Tests: `server/test/tools.test.ts` (TERM first, KILL after the grace, abort -15, pre-aborted, killAllTools + latch in
  a subprocess), `server/test/shutdown.test.ts` with `server/test/fixtures/sleepy-add.mjs` (the running add and its
  grandchild are gone, the queued add never starts; a layout PUT whose body arrives after SIGTERM gets its 200).
- Deviation: the stop limit is 7 s, not the fix entry's 10 s. The plan's seam settlement ("server child processes vs
  server lifetime") and its risk line set TERM, KILL at 5 s, a 7 s cap, under tooling-harness's 8 s srv.stop. Until
  that harness lands (W5) the evals' srv.stop SIGKILLs the server after 2.5 s; a SIGKILL skips the exit handler, so a
  tool still running then can be left behind in an eval (none is, in today's evals).
- Residual, accepted: a render still waiting on fal at 7 s is cut. The warm calibration worker is spawned by
  scenes/calib.ts, not runTool, so it is not in the live set; its close is server-domain's.

## State machines W1: server-infra-jobs (JobStore terminal-state guard)

- `server/src/logic/jobs.ts` (TScert, in the baseline): `JobStatus` and `jobStep(from, to)`. The first terminal status
  wins: a queued or running job takes any status, a done or failed one only its own again (message-only patches still apply).
  Non-terminal moves such as queued -> done are allowed on purpose, because rooms `#end` ends a job from either state.
- `JobStore<J extends { id; status: JobStatus }>`: `update()` refuses a status patch that `jobStep` forbids. It returns
  null, leaves the job unchanged and writes one stderr line (`job <id>: <from> -> <to> refused`). This covers the
  library, scenes and rooms stores, so their late `#failed`/`#ended`/`#end` writes need no guards of their own. Every
  terminal write today comes from queued or running, so nothing legitimate is refused (checked every `#jobs.update` call).
- Proof: `server/test/infra.test.ts` 'job queues'. done refuses failed/running. queued -> failed (the drop-on-delete race)
  refuses a late running/done. queued -> done and running -> running with a new message still apply. There is also a
  table test for jobStep. The first two were red before the change.
- Wont-fix, as the plan says: the bounded `#after`, evicting old jobs, `position()` O(n), `drained()` single-cycle.
  v1's in-memory jobs are kept (a restart forgets them). The library `#run` status guard ships in server-infra-library.
- Deviation: none in the design. `tscert-ratchet --files … --update` writes no baseline (`--files` mode never does), so
  the `jobStep` line was added to `tscert/baseline.json` by hand (append only), and check:tscert confirms it certifies.

## State machines W2: server-infra-lock (live same-host holders, no self-reclaim)

- `common/logic/lock.ts` `lockVerdict(seen, staleMs, graceMs, liveMarginMs)` (TScert, still certifies): a live owner on this
  host is 'too-old' only past `staleMs + liveMarginMs`. Unknown liveness (another host) keeps `ageMs > staleMs`; a dead
  owner on this host is reclaimed at once. `common/lock.ts` passes 10 min, so a live holder is safe to 4200 s while the
  server ends every tool by 3605 s. The margin, not "never reclaim a live pid", so a reused pid recovers after 70 min.
- `acquireLock` never reclaims a lock its own process holds (`heldHere` has the folder and the owner matches): it waits.
- Proof: `server/test/lock.test.ts`: live child back-dated 3605 s keeps the lock and owner.json; 2 h is reclaimed; dead pid
  reclaimed at once with waitMs 0; own lock with the clock moved 2 h gives Busy; pure verdict cases. Contract §2.8 already says this.
- Deviation: `server/test/lock-child.ts` is unchanged; the test back-dates owner.json after the child's `hold`.
- Open, for the pipeline track or integration: `pipeline/test/lock.test.ts:88` still pins the old rule (a live same-host
  owner reclaimed at 3601 s), so test:pipeline and check:tests fail on that one test. It is outside this package's files
  and the server track. Changing `3601` to `4201` there makes it pass (checked on a throwaway copy).
## State machines W2: server-domain-calib-runner (worker lifecycle, runner shutdown)

- `scenes/calib.ts`, Worker: the idle close now goes through close() (stdin end, SIGKILL after the grace). kill() and
  close() share one cached stop, capped 5 s after the SIGKILL. stderr is always kept and reset after each answer, and a
  worker that dies by itself while idle logs it. A stop's late "interrupted" line is ignored instead of read as a broken
  worker. Every drop now tells the runner (once).
- CalibRunner: run() returns 'stopped' after shutdown. Workers being stopped apart from a job (`#retiring`) are awaited
  before the next job, so one model is resident. One-shots run with an AbortSignal and shutdown aborts and awaits them;
  abort maps to 'stopped'. "interrupted" while stopping is 'stopped' too.
- `logic/worker.ts`: `{id: null, ok: false, …}` is the sent request's failure, with the worker's sentence (contract §4.3).
- Deviations: the fix entry says id-null answers stay garbled; the seam settlement and contract §4.3 say the opposite, and
  those were followed. The seam's "re-run only before a 'done' line" is not done: the protocol has no such line, so a
  broken answer still re-runs one-shot (costs time only, contract §4.3 Crash). `#retiring` also holds a worker that broke
  while idle, not only idle ones. `server/test/rooms-calib.ts` logs its pid (needed by the proof).

Closed at the W2 merge: `pipeline/test/lock.test.ts` now pins the new rule (a live same-host owner still waits at 3601 s, reclaimed at 4201 s).

## W3 server-domain-room-align

- align-room's `--out` is now `rooms/.align/<job>/` (`alignStagingName`). Only an ok, non-dropped answer with the room still there has its align.json renamed into `rooms/<room>/`, then applied. The scratch is removed before the job is published as ended, and `rooms/.align/` is swept at startup. `#removeLeftover` is gone. An `align.json` in a room is now always an applied answer, so Reset only re-applies those.
- `delete()` also forgets a dropped queued job's `#requests` entry. `align()` redraws a colliding job id.
- Crash order: `delete()` writes trash.json in the live folder first; `restore()` removes it last.
- Deviation: an ok answer whose `--out` holds no align.json now fails the job with ALIGN_NO_RESULT (before, it was applied with no file).
- Known limit, as designed: if moving the layouts fails after the folder moved, the room is listed in the trash but restore answers 409 until `layouts/@<room>/` is cleared.
