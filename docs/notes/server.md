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
