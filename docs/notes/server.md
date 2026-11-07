# server track notes

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
