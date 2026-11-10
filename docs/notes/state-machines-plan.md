# Fixing the implicit state machines: plan

This plan comes from workflow `wf_9b9993f9-53d`. It covers every machine in [state-machines.md](state-machines.md). For each sweep group, one agent designed a fix or a reasoned skip for every machine, a second checked that design against the code and the contract, and a last agent fitted the groups together into waves. Line numbers are as of commit 21c7efc.

**179 decisions:** 104 guard-only, 36 wont-fix, 26 fix, 11 defer, 2 make-explicit. **52 work packages in 7 waves.** Each package is one worktree and branch inside its owner track. No two packages in a wave touch the same file. Integration merges each wave and runs the gates before the next wave starts.

## Before anything runs: your decisions

- [ ] Commit (or stash) the in-progress upscale work before any worktree is cut, and say which. It touches contract/, the planner render UI and server render.
- [ ] Approve the contract changes in foundation-contract, several of which depart from v1: the .calibrating marker and 'failed/LOST_CALIBRATION even with calib.json present'; the LOST_UPLOAD sentence; a recalibration that can't run MoGe failing and keeping the earlier calibration instead of falling back and deleting depth/lighting; ingest clearing derived files before a new photo; the mock fallback becoming exif-or-default; align output staged in rooms/.align/<job>; and the lock stale rule (a live same-host holder reclaimable only after 3600 s + 10 min).
- [ ] Killing paid children on server stop: approve that stopping the server SIGTERMs an in-flight midstudy-add (the fal job is abandoned, the cost row recorded, outputs kept in _failed/) rather than letting it run to completion detached.
- [ ] Render retries can pay twice: accept the guard-only fix (lost-render text plus a list refresh), or add a render job/idempotency route to the contract (a new foundation package, not planned).
- [ ] Multi-tab layout edits and the room setPose lost update stay last-writer-wins (deferred). Confirm, or ask for a version/precondition on PUT /api/layouts and PUT /api/rooms (contract).
- [ ] Lighting 'none' is not persisted: accept the planner-only guard (autostart once per scene per session, a lost job toasts), or schedule the deferred server lighting-backfill work.
- [ ] Review the wont-fix/defer list (unscheduled), especially Splat pass redraw cache, GpuRadixSort, the Atomic write/.tmp protocol and the Process-global calib patches, and confirm none should be promoted.
- [ ] Whether eval:engine-races and eval:selftest-runner should join eval:all (an evals-track change to evals/all.mjs), or stay by-hand gates run in integration-close.
- [ ] Whether to run the optional evals-stub-calib-mirror package (fixtures/stub_calib.py following the new ingest/mock rules); no eval depends on it.

## Waves

### Wave 1: Contract text and the base guards; the high money/hang fixes: orphaned paid children, fal billing, invisible splats

| Package | Track | Machines | Depends on | Gates |
|---|---|---|---|---|
| **foundation-contract**: contract changes (see Contract package) | foundation | 0 | none | check:gen, check:tests |
| **server-infra-tools**: Tool children: tracked, SIGTERM-then-SIGKILL, settle on close, abort signal, stopping latch, killed on server stop; graceful stop() | server | 2 | none | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run check:ownership, npm run eval:all, npm run eval:all -- --with-calib |
| **server-infra-jobs**: JobStore terminal-state guard (jobStep in logic/jobs.ts) | server | 1 | none | npm run check:types, npm run check:lint, npm run check:tests, npm run check:tscert, npm run check:dead, npm run check:ownership, npm run eval:all |
| **pipeline-fal-client**: LiveFal: charged after submit (except job refusals), stop signal and Interrupted, 45-min deadline, no resend of submits, fresh backup timeout, token reset | pipeline | 4 | none | npm run check:tests, npm run check:types, npm run check:lint, npm run check:dead, MIDSTUDY_TRACK=pipeline npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:pipeline |
| **planner-engine-base**: Shared guards and the proof harness: scope guard, latest-wins counters, capture mutex, logic/jobs.ts + followAlign by job, render-loop reset, states.test.mjs, engine-races.mjs scaffold | app | 5 | none | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tscert, npm run check:tests, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, eval:render, eval:keys, eval:splat, eval:room-planner, eval:align -- --mock, eval:perf (exclusive), eval:engine-races (new npm script: node planner/ui/test/engine-races.mjs, through scripts/eval-lock.mjs) |
| **planner-ui-shell**: Shell: layer stack and Esc routing, sheet detents and rehost events, toast onGone, tooltip mode guard, sheet.ts isSheetOpen, the shared epoch helper, the UI machines test runner | app | 4 | none | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run check:tscert, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:ui-smoke, node scripts/eval-lock.mjs -- npm run eval:keys, node scripts/eval-lock.mjs -- npm run eval:phone, node scripts/eval-lock.mjs -- npm run eval:ux, node scripts/eval-lock.mjs -- npm run eval:ux2 |
| **planner-gpu-splat-sort**: SplatLayer: explicit CPU sort state, main-thread fallback, fatal worker errors, no settle waiters, near in the key, dispose guard, demo ready guard | app | 6 | none | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run check:tscert, npm run check:ownership (MIDSTUDY_TRACK=app), node scripts/eval-lock.mjs -- npm run eval:splat (default and MIDSTUDY_WEBGPU=0), node scripts/eval-lock.mjs -- npm run eval:render, node scripts/eval-lock.mjs -- node planner/gpu/demo/check.mjs, node scripts/eval-lock.mjs --exclusive -- npm run eval:perf -- --compare evals/perf/baseline.json (MIDSTUDY_WEBGPU=0, informational) |
| **calib-moge-device**: MoGe runner: device-move guard, checkpoint revision carried on Loaded/MogeOutput | calib | 2 | none | nix develop -c npm run check:py, nix develop -c bash -c 'cd calib && uv run pytest -q', nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib |

### Wave 2: Data-loss and lock fixes on the base: lock stale rule, pipeline commit/rollback, calib write order and worker signals, runner shutdown, engine scene scope, kernel face

| Package | Track | Machines | Depends on | Gates |
|---|---|---|---|---|
| **server-infra-lock**: Lock protocol: a live same-host holder is reclaimed only past the tool timeout plus a margin; no self-reclaim | server | 1 | foundation-contract-lock-stale, server-infra-tools | npm run check:tests, npm run check:tscert, npm run check:types, npm run check:lint, npm run check:ownership, npm run test:pipeline, npm run eval:all |
| **server-domain-calib-runner**: Calibration worker and runner: idle retire with grace, one model at a time, idempotent kill, no work after shutdown, abort one-shots | server | 2 | server-infra-child-tool | npm run check:tests, npm run check:types, npm run check:lint, npm run check:dead, MIDSTUDY_TRACK=server npm run check:ownership, eval:align (E20 --mock), eval:scenes-api (E1) |
| **pipeline-commit**: midstudy-add: prepare before commit, swap-in with rollback, paid-branch order, rescale rollback, fresh library load, signal deferral and paid-run unwind, notes | pipeline | 5 | pipeline-fal-client | npm run check:tests, npm run check:types, npm run check:lint, npm run check:dead, MIDSTUDY_TRACK=pipeline npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:pipeline, node scripts/eval-lock.mjs -- npm run eval:library |
| **planner-engine-scene**: Scene-scoped async ops: open/close tokens, layouts by scope, explicit dirty baselines, Look autosave, ruler, startup, lists, renders list and lost-render text, camera source, recalibrate job | app | 12 | planner-engine-base | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tscert, npm run check:tests, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, eval:planner, eval:floor, eval:ux, eval:ux2, eval:lighting, eval:render, eval:phone, eval:room-planner, node planner/ui/test/rooms-ui.mjs, eval:engine-races |
| **evals-rooms-api-align-out**: E18 accepts the staged align --out (<rooms>/.align/<job>) as well as <rooms>/<room>, and checks align.json lands in rooms/<room>/ | integration | 1 | foundation-contract | node scripts/eval-lock.mjs -- npm run eval:rooms-api, MIDSTUDY_TRACK=evals npm run check:ownership |
| **calib-scene-files**: Scene folder writes: calib.json as commit marker, ingest invalidation, keep a good fit, mock-miss fallback, stray SOI, moge.revision in calib.json | calib | 4 | foundation-contract-calib, calib-moge-device | nix develop -c npm run check:py, nix develop -c bash -c 'cd calib && uv run pytest -q', nix develop -c node scripts/eval-lock.mjs -- npm run eval:all, nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib |
| **calib-worker-protocol**: Worker interrupts: parse-time SIGINT, signal-held responses, safe Interrupted answer, SIGTERM; bench client cleanup | calib | 2 | foundation-contract-calib | nix develop -c npm run check:py, nix develop -c bash -c 'cd calib && uv run pytest -q', nix develop -c node scripts/eval-lock.mjs -- npm run eval:all |
| **kernels-web-face**: core/js/web.ts: load lifecycle guards, serveKernels retry, KernelWorker cleanup both directions, envMap variant check, scratch-view rule | kernels | 5 | none | MIDSTUDY_TRACK=kernels npm run check:ownership, npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run check:planner, node core/crates/wasm-web/tests/worker.mjs, core/crates/wasm-web/tests/browser/run.sh, node scripts/wasm-smoke.mjs, node scripts/eval-lock.mjs -- npm run eval:planner / eval:occlusion / eval:lighting (E3, E4, E15) |

### Wave 3: Server job lifecycles on the new contract; planner pieces, stores and render-id consumers; dirlock

| Package | Track | Machines | Depends on | Gates |
|---|---|---|---|---|
| **server-domain-scene-jobs**: Scene jobs and folders: spawn-error via #finish, restore guard and #last reset, .calibrating marker (kept on stop) and LOST_UPLOAD, crash-ordered delete/restore, unique ids and queueTask check | server | 5 | foundation-contract-scene-marker, server-domain-calib-runner | npm run check:tests, npm run check:tscert, npm run check:types, npm run check:lint, npm run check:dead, MIDSTUDY_TRACK=server npm run check:ownership, eval:scenes-api (E1), eval:rooms-api (E18) |
| **server-domain-room-align**: Room align staging (--out rooms/.align/<job>, startup sweep), #requests leak, unique align ids, crash-ordered room delete/restore | server | 4 | foundation-contract-align-staging, evals-rooms-api-align-out | npm run check:tests, npm run check:tscert, npm run check:types, npm run check:lint, npm run check:dead, MIDSTUDY_TRACK=server npm run check:ownership, eval:rooms-api (E18), eval:room-planner (E19), eval:align (E20 --mock) |
| **server-domain-children-shutdown**: Library and render children stopped on shutdown; keep-room align spawn-error reads as not applied | server | 2 | server-infra-child-tool, pipeline-interrupt-cost-row | npm run check:tests, npm run check:types, npm run check:lint, npm run check:dead, MIDSTUDY_TRACK=server npm run check:ownership, eval:library (E7), eval:pipeline (E8), eval:render (E5) |
| **planner-engine-items**: Pieces and the room view: placement chain (incl. room layout loads), uid reservation, re-projection after awaits, capture-safe attach, library generation, drag guards, GLB cache identity, thumbnail retry | app | 8 | planner-engine-base, planner-engine-scene | npm run check:types, npm run check:lint, npm run check:dead, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, eval:library, eval:splat, eval:ux, eval:keys, eval:phone, eval:room-planner, node planner/ui/test/rooms-ui.mjs, eval:engine-races |
| **planner-core-stores**: Scenes and library stores: answer sequencing, tracked-job merge, lost jobs, backoff, calibration shadow, upload abort, API probe retry | app | 5 | planner-engine-list-caches | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run check:tscert, npm run check:planner, eval:library, eval:ux, eval:ux2, eval:product-ui, eval:planner, eval:room-planner, eval:ui-smoke |
| **planner-ui-workspace**: Workspace: one Undo channel scoped to the items epoch with a one-shot restore, hold-to-repeat stop, render chip counter, overlay drag guards, Adjust floor busy guards | app | 5 | planner-ui-shell | npm run check:types, npm run check:lint, npm run check:tests, npm run check:tscert, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:ui-smoke, node scripts/eval-lock.mjs -- npm run eval:floor, node scripts/eval-lock.mjs -- npm run eval:keys, node scripts/eval-lock.mjs -- npm run eval:phone, node scripts/eval-lock.mjs -- npm run eval:room-planner |
| **planner-ui-renders**: Renders panel: scene-scoped run(), network-failure refresh, viewer by name, confirm recheck, prune picks, modal as a shell layer | app | 2 | planner-ui-shell | npm run check:types, npm run check:lint, npm run check:tests, npm run check:tscert, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:render, node scripts/eval-lock.mjs -- npm run eval:ui-smoke |
| **tooling-dirlock**: scripts/lib/dirlock.mjs: one sync lock-directory helper (common/lock.ts protocol, lockOwner/sameOwner/lockVerdict from common/logic/lock.ts) plus the test:scripts node:test suite | toolchain | 1 | none | npm run check:tests, npm run check:dead, npm run check:ownership (MIDSTUDY_TRACK=toolchain) |

### Wave 4: Library route hand-off and spend; engine resources; the remaining planner UI; build and gate tooling

| Package | Track | Machines | Depends on | Gates |
|---|---|---|---|---|
| **server-infra-library**: Library routes: reservation transfer, fail-closed spend, temp/reservation ownership, delete/restore rollback, rescale queued under the lock, #run status guard | server | 3 | server-domain-library-job | npm run check:types, npm run check:lint, npm run check:tests, npm run check:ownership, npm run eval:all |
| **planner-engine-resources**: Lighting backfill step, kernel worker timeout/terminate, effective occlusion | app | 5 | planner-engine-items | npm run check:types, npm run check:lint, npm run check:tscert, npm run check:tests, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, eval:lighting, eval:occlusion, eval:perf -- --compare evals/perf/baseline.json (exclusive), eval:engine-races |
| **planner-ui-room**: Floor plan: gesture decisions (revert on pinch / Align off), valid align target, switchTo recheck, Align again latch, depth-load backoff and generation | app | 3 | planner-ui-shell | npm run check:types, npm run check:lint, npm run check:tests, npm run check:tscert, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:room-planner, node scripts/eval-lock.mjs -- node planner/ui/test/rooms-ui.mjs |
| **planner-ui-scenes**: Scenes page: multi-upload slots, New room resume by failed step, poll backoff, epoch recheck after confirms, rename latches | app | 2 | planner-ui-shell | npm run check:types, npm run check:lint, npm run check:tests, npm run check:tscert, MIDSTUDY_TRACK=app npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:planner, node scripts/eval-lock.mjs -- npm run eval:room-planner, node scripts/eval-lock.mjs -- npm run eval:ui-smoke |
| **planner-ui-sheets**: Form sheets and Library: Export/Settings own-handle close and in-flight guards, product paste while busy, Add sheet failure toast, same-source paid-add guard and listener cleanup, Library add scoped to the items epoch | app | 5 | planner-ui-shell | npm run check:types, npm run check:lint, npm run check:dead, MIDSTUDY_TRACK=app npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:keys, node scripts/eval-lock.mjs -- npm run eval:library, node scripts/eval-lock.mjs -- npm run eval:product-ui, node scripts/eval-lock.mjs -- npm run eval:ui-smoke |
| **planner-ui-panels**: Layouts save scoped to the scene with a pending load, Scene panel calibrating per scene, Sun dial single pointer | app | 3 | planner-ui-shell | npm run check:types, npm run check:lint, npm run check:planner, MIDSTUDY_TRACK=app npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:lighting, node scripts/eval-lock.mjs -- npm run eval:ui-smoke |
| **tooling-build**: build.mjs: dirlock step locks (no age rule), dead-pid tmp sweep, stamps that can't record mid-build edits, full wasm inputs, 24 h prune grace | toolchain | 2 | tooling-dirlock | npm run check:tests, npm run check:types, npm run check:planner, npm run check:ownership (MIDSTUDY_TRACK=toolchain), npm run eval:selftest (through eval-lock) |
| **tooling-gates**: check.mjs and the TScert ratchet: re-sync venv (--inexact), rev-checked Mathlib marker, non-mutating check:gen, tscert run lock held through --update | toolchain | 2 | tooling-dirlock | npm run check:gen, npm run check:py, npm run check:proofs, npm run check:tscert, npm run check:tests, npm run check:ownership (MIDSTUDY_TRACK=toolchain) |

### Wave 5: Product clocks and size worker, startup hook, the eval lock and harness (integration track), the remaining low guards

| Package | Track | Machines | Depends on | Gates |
|---|---|---|---|---|
| **product-read-clocks**: Deadline suspend/settle around feeds and the paid LLM answer; LLM spend hold kept on unrecorded or possibly-billed calls | server | 2 | server-infra-spend-cap | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run eval:product (via scripts/eval-lock.mjs), npm run eval:ui-smoke (via scripts/eval-lock.mjs) |
| **product-size-worker**: SizeWorker guards: one running job posted lazily, queued timeouts drop, stale-worker events ignored, exit handled | server | 1 | none | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run eval:product (via scripts/eval-lock.mjs) |
| **planner-core-startup**: Startup hook: one shared errors array, ready settles on a failed engine start | app | 1 | planner-core-stores | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, eval:ui-smoke, eval:all |
| **tooling-eval-lock**: eval-lock.mjs on dirlock: no age staleness for live owners, marker held for the whole exclusive run, strict flags, process-group signal forwarding with bounded grace (foundation file: integration track) | toolchain | 1 | tooling-dirlock | npm run check:tests, npm run eval:selftest (through eval-lock), npm run eval:all (through eval-lock) |
| **tooling-harness**: harness.mjs: --port 0 identity, up cleared on unexpected exit + srv.alive(), 8 s stop grace, bounded cleanups and debounced second-signal exit, success memo with one retry, inverted waitScene, waitFor log, openPlanner query/readyMs, out-dir lock (foundation file: integration track) | toolchain | 6 | tooling-dirlock, server-infra-child-processes | npm run eval:selftest (through eval-lock), npm run eval:all (through eval-lock) |
| **kernels-node-envelope**: core/js/node.ts: bounded Payload, strict tags, trailing-bytes and GLB checks, zipPlan offset | kernels | 1 | none | MIDSTUDY_TRACK=kernels npm run check:ownership, npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, node --test core/crates/wasm-node/js-test/face.test.ts, node scripts/eval-lock.mjs -- npm run eval:scenes-api / eval:library / eval:pipeline (E1, E6, E7) |
| **server-infra-layouts**: Layout PUT re-checks its scene/room before writing | server | 1 | none | npm run check:types, npm run check:lint, npm run check:tests, npm run check:ownership, npm run eval:all |
| **planner-gpu-backend-guards**: passes.ts: checked backend detection and loud clear-workaround guards | app | 1 | none | npm run check:types, npm run check:lint, npm run check:ownership (MIDSTUDY_TRACK=app), node scripts/eval-lock.mjs -- node planner/gpu/demo/check.mjs, node scripts/eval-lock.mjs -- npm run eval:splat (default and MIDSTUDY_WEBGPU=0), node scripts/eval-lock.mjs -- npm run eval:occlusion (default and MIDSTUDY_WEBGPU=0) |

### Wave 6: Eval runners on the new harness, canvas gestures, parsers and the Rust/calib low fixes

| Package | Track | Machines | Depends on | Gates |
|---|---|---|---|---|
| **tooling-evals-lib**: all.mjs signal forwarding and partial summary, rooms.mjs openRoomPage wrapper / inverted waitJob / waitAlignDone removed, gated_calib contract-shaped timeout and parent-death exits, evals/runner_selftest.mjs | toolchain | 5 | tooling-harness | npm run eval:selftest-runner (through eval-lock), npm run eval:selftest (through eval-lock), npm run eval:all (through eval-lock), npm run check:dead, npm run check:ownership (MIDSTUDY_TRACK=evals) |
| **tooling-perf**: perf.mjs: setupError reset, shared server revalidated through its live object, abortable loop writing partial results on shutdown, drag finally-cleanup, bounded pageInit poll, inverted inline polls, perf out-dir lock | toolchain | 5 | tooling-harness, tooling-dirlock | npm run eval:perf -- --runs 1 (through eval-lock --exclusive), npm run check:ownership (MIDSTUDY_TRACK=evals) |
| **planner-core-gesture**: Canvas gesture guards (drag token, pinch pair, residual pan, scene token) and the selection removal path check | app | 2 | planner-core-startup, planner-engine-selection-drag | npm run check:types, npm run check:lint, npm run check:tests, npm run check:tscert, npm run check:planner, eval:phone, eval:planner, eval:keys, eval:ui-smoke |
| **planner-gpu-ply**: PLY header rejects elements before vertex and bad counts | app | 2 | planner-gpu-splat-sort | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run check:ownership (MIDSTUDY_TRACK=app), node scripts/eval-lock.mjs -- npm run eval:splat |
| **product-parser-guards**: Self-closing svg/math leaves foreign content; Shopify variants first-wins guard | server | 2 | none | npm run check:types, npm run check:lint, npm run check:dead, npm run check:tests, npm run eval:product (via scripts/eval-lock.mjs) |
| **pipeline-splat-fit**: splat fit: recompute column indices after dropping f_rest_* | pipeline | 1 | none | npm run check:rust, npm run check:fuzz, MIDSTUDY_TRACK=pipeline npm run check:ownership, node scripts/eval-lock.mjs -- npm run eval:splat, node scripts/eval-lock.mjs -- npm run eval:pipeline |
| **kernels-raster**: raster crate: CRC skip only under cfg(fuzzing), dilation sentinel clamp, doc of the v1-parity chunk rules | kernels | 2 | none | MIDSTUDY_TRACK=kernels npm run check:ownership, npm run check:rust, npm run check:fuzz, node core/crates/wasm-web/tests/diff.mjs, node scripts/eval-lock.mjs -- npm run eval:occlusion / eval:render (E4, E5) |
| **calib-rooms-scale**: Room solver scale-source mode (pure _scale_mode, NaN not 1.0, floor->depth->none) | calib | 1 | none | nix develop -c npm run check:py, nix develop -c bash -c 'cd calib && uv run pytest -q', nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib, nix develop -c node scripts/eval-lock.mjs -- npm run eval:real-room -- --golden |

### Wave 7: Last dependents, notes and integration

| Package | Track | Machines | Depends on | Gates |
|---|---|---|---|---|
| **calib-rooms-solver-select**: MASt3R provisioning lock/stamp/force and load errors; solver selection order and degenerate escalation | calib | 2 | calib-rooms-scale | nix develop -c npm run check:py, nix develop -c bash -c 'cd calib && uv run pytest -q', nix develop -c node scripts/eval-lock.mjs -- npm run eval:all, nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib |
| **kernels-notes**: docs/notes/kernels.md: the wont-fix/defer decisions (v1-parity walkers, camera scratch, base64, GLB layout) and the outcomes of the other three packages | kernels | 5 | kernels-web-face, kernels-node-envelope, kernels-raster | MIDSTUDY_TRACK=kernels npm run check:ownership |
| **evals-stub-calib-mirror**: Optional: fixtures/stub_calib.py mirrors the ingest clearing order and the exif-or-default mock fallback | integration | 2 | foundation-contract, calib-scene-files | node scripts/eval-lock.mjs -- npm run eval:all, MIDSTUDY_TRACK=evals npm run check:ownership |
| **integration-close**: Integration: merge every wave (union shared-append files, regenerate package-lock and the tscert baseline), full gate run, STATUS and state-machines notes closed out | integration | 1 | calib-rooms-solver-select, kernels-notes, evals-stub-calib-mirror, tooling-evals-lib, tooling-perf, planner-core-gesture, planner-gpu-ply, product-parser-guards, pipeline-splat-fit, kernels-raster, calib-rooms-scale | nix develop -c npm run check, node scripts/eval-lock.mjs -- npm run eval:all -- --with-calib, node scripts/eval-lock.mjs -- npm run eval:calib, node scripts/eval-lock.mjs -- npm run eval:engine-races, node scripts/eval-lock.mjs -- npm run eval:selftest, node scripts/eval-lock.mjs -- npm run eval:selftest-runner, node scripts/eval-lock.mjs -- npm run eval:ui-smoke, node scripts/eval-lock.mjs --exclusive -- npm run eval:perf -- --compare evals/perf/baseline.json |

## Shared helpers (one owner each)

- **runTool `signal` option + killGroup / killAllTools (TERM group, KILL after 5 s, settle on close, stopping latch)**: `common/tools.ts`, owned by server-infra-tools; used by server-domain-calib-runner, server-domain-children-shutdown, server-infra-library, tooling-harness
- **jobStep(from, to): first terminal state wins, enforced in JobStore.update**: `server/src/logic/jobs.ts + server/src/jobs.ts`, owned by server-infra-jobs; used by server-domain-scene-jobs, server-domain-room-align, server-domain-children-shutdown
- **SpendCap.transfer(from, to) + newJob `adopt` + holdForToday for possibly-billed calls**: `server/src/spend.ts`, owned by server-infra-library; used by product-read-clocks, server-infra-library (routes/library.ts, routes/scenes.ts)
- **lockVerdict / sameOwner / lockOwner (live same-host holder stale only past timeout + margin; staleMs parameter)**: `common/logic/lock.ts (TScert) + common/lock.ts`, owned by server-infra-lock; used by pipeline-commit, tooling-dirlock
- **dirlock: tryClaim / owner-checked release / releaseAllSync with an aside-rename reclaim**: `scripts/lib/dirlock.mjs`, owned by tooling-dirlock; used by tooling-build, tooling-gates, tooling-eval-lock, tooling-harness, tooling-perf
- **Planner job follow by id: jobOutcome(httpStatus, status) -> running | done | failed | lost**: `planner/logic/jobs.ts (TScert)`, owned by planner-engine-base; used by planner-engine-scene (recalibrate), planner-engine-resources (lightingStep's lost rule), planner-core-stores (library job that disappeared)
- **Engine-internal guards: scopeGuard/stillIn, latest-wins list counters, exclusive() capture mutex, placed() placement chain**: `planner/engine.ts`, owned by planner-engine-base; used by planner-engine-scene, planner-engine-items, planner-engine-resources
- **freshAnswer(n, applied) answer sequencing and pollDelay/jobsPollMs report-once backoff**: `planner/logic/scenes.ts, planner/logic/library.ts`, owned by planner-core-stores; used by planner/data.ts polls only (engine.ts lists use the inline latest-wins counter from planner-engine-base; one idiom per file)
- **uiEpoch(engine): now() / items() / on()**: `planner/ui/epoch.ts`, owned by planner-ui-shell; used by planner-ui-workspace, planner-ui-renders, planner-ui-room, planner-ui-scenes, planner-ui-sheets, planner-ui-panels
- **shell.pushLayer / topLayer, escTarget(kinds, inField), handled-Esc WeakSet, sheet.ts isSheetOpen(), toast onGone**: `planner/ui/shell.ts, planner/ui/logic/layers.ts, planner/ui/sheet.ts`, owned by planner-ui-shell; used by planner-ui-renders, planner-ui-sheets, planner-ui-workspace, planner-ui-panels
- **Planner test homes: `test:planner` (node --test planner/test/*.test.mjs, esbuild-bundled logic), `test:ui-machines`, the smoke.mjs sections runner (planner/ui/test/sections/*.mjs, playwright-core page.route for holds/aborts/500s)**: `package.json, planner/test/, planner/ui/test/smoke.mjs`, owned by planner-engine-base (test:planner); planner-ui-shell (test:ui-machines, smoke runner); used by planner-engine-scene, planner-engine-resources, planner-core-stores, planner-core-startup, planner-core-gesture, planner-ui-workspace, planner-ui-renders, planner-ui-room, planner-ui-scenes, planner-ui-sheets, planner-ui-panels
- **Worker 'down for good' rule (onerror/messageerror/fatal reply -> main-thread fallback; a non-fatal reply re-decides) + KernelWorker.close()**: `core/js/web.ts (KernelWorker); pattern copied in planner/gpu/splat-layer.ts`, owned by kernels-web-face; used by planner-engine-resources, planner-gpu-splat-sort
- **Scene-folder commit ordering: invalidate(folder, names), sweep_tmp, write_atomic with fsync**: `calib/src/midstudy_calib/util.py`, owned by calib-scene-files; used by calib ingest/fit/light, evals-stub-calib-mirror (mirrors the order)
- **Held-job test stand-ins (ROOMS_CALIB_DELAY_MS / ROOMS_CALIB_ALIGN_DELAY_MS) and sleepy-add fixture**: `server/test/rooms-calib.ts, server/test/fixtures/sleepy-add.mjs`, owned by server-domain-calib-runner (rooms-calib modes); server-infra-tools (sleepy-add); used by server-domain-scene-jobs, server-domain-room-align, server-domain-children-shutdown, server-infra-library

## Contract package

`foundation-contract`: `contract/CONTRACT.md`, `contract/api/README.md`, `contract/gen/types.ts`, `contract/gen/validate.js`, `contract/gen/routes.js`, `core/crates/contract/schema.json`

- Precondition: the uncommitted upscale work (contract/CONTRACT.md, api/README.md, render-meta.schema.json, routes.json, upscale-request.schema.json, contract/gen/*, core/crates/contract/schema.json) is committed by integration first, and this package builds on it.
- §2.8 One writer, Stale bullet: a lock is stale when older than the tool timeout (3600 s since started), or, when its owner is a live process on this host, older than the tool timeout plus 10 minutes (the server ends every tool by then). (server-infra-lock)
- §4.2 scene folder files: add the server-private `.calibrating` marker. It holds the job id, is never served, and is removed when the job ends unless the server stopped under it. (server-domain-scene-jobs)
- §4.4 calib_status: 'failed' with LOST_CALIBRATION also when the marker is present and no job of this server run covers the scene, even when calib.json exists. New LOST_UPLOAD sentence, which wins, when the scene has neither photo.jpg nor source.* (delete it, or upload the photo again). Marked as a deliberate departure from v1. (server-domain-scene-jobs)
- §4.4/§4.9 job routes: GET /api/scenes/jobs/{id} and /api/rooms/jobs/{id} answer 404 only for an id this server run never made (jobs are not pruned), so a client may read a 404 for an id it was given as 'lost to a restart'. This documents what planner jobOutcome relies on. Text only.
- §4.9 Files and Align: the server runs align-room with `--out rooms/.align/<job>/` and moves its align.json into rooms/<room>/ only when the job succeeds and was not dropped. A failed or dropped job leaves rooms/<room>/ untouched. rooms/.align/ is server scratch, swept at startup. The calib side is unchanged. (server-domain-room-align)
- §4.3 Files/Ingest: when the new photo.jpg differs from the existing one (or there is none), ingest first removes calib.json, depth.png, lighting.json, the old photo.jpg and other source.* files, then writes source.<ext> and photo.jpg. Fit removes calib.json first and writes it last. (calib-scene-files)
- §4.3 Fallbacks: a fit of a scene whose calib.json has source moge-2 that can't run MoGe fails (exit 1, '... the earlier calibration was kept') and writes nothing. The fallback applies only when there is no earlier MoGe calibration. This departs from v1, which deleted depth/lighting. (calib-scene-files)
- §4.3 Worker: SIGINT or SIGTERM answers the request in flight (or the line being parsed) with 'interrupted' and exits 1; a response line is never left half-written. An unreadable request is answered with id null, which the server treats as a failure of that request. (calib-worker-protocol, server-domain-calib-runner)
- §4.3 Mock: with no match it writes the fallback (exif or default, as without the mock) instead of 'the default fallback'. (calib-scene-files)
- §4.3 calib.json moge: optional line 'revision: the weights' Hub revision used (the pinned sha, or main when it couldn't be had)'. No schema change. (calib-moge-device, calib-scene-files)
- §2.6 Render: one sentence saying a request that dies on the client may still complete and be billed; a client refreshes GET /api/renders before retrying. Text only, no route change.
- No schema changes, so `node scripts/gen-contract.mjs` must produce no diff; check:gen and test:contract are the gates. contract/examples are unchanged (the new sentences are error strings, not new enum values).

## Machines that span areas

- **[high] Scene calibration job: upload -> calibration queue -> calib worker/one-shot -> files on disk -> planner polling**: foundation-contract, calib-scene-files, calib-worker-protocol, server-infra-tools, server-infra-jobs, server-domain-calib-runner, server-domain-scene-jobs, planner-core-stores, planner-engine-scene, planner-ui-panels. Extra: No new package. The contract text (§4.2 .calibrating marker, §4.4 LOST_CALIBRATION also when calib.json is present, LOST_UPLOAD, §4.3 ingest/fit file order) is in foundation-contract. Each cause is closed by one package. Lost recalibration reads 'done': the marker (scene-jobs), and recalibrate follows GET /api/scenes/jobs/<id> with jobOutcome 404=lost (engine-scene). Dead end with no photo: LOST_UPLOAD wins and tells the user to delete or upload again (scene-jobs); the Scene panel shows the 409 sentence (ui-panels). Restore during a running job: restore guard plus #last reset (scene-jobs), and jobStep's first-terminal-wins rule (infra-jobs). Torn depth/calib write: calib.json is unlinked first and written last (calib-scene-files), and SIGTERM is answered rather than dying mid-write (calib-worker-protocol). A fallback fit deleting good depth: keep a good fit (calib-scene-files). The old poll left running in waitForScene: the sceneToken check (engine-scene). Orphaned one-shots: runTool signal plus killAllTools (infra-tools), and the runner aborts one-shots on shutdown (calib-runner). Settled: (1) Commit-marker ordering vs keep-a-good-fit: calib must decide fallback-or-MoGe BEFORE invalidate(). If it is a fallback over an earlier moge-2 calib.json, it fails and writes nothing. invalidate() + write happen only once the new result is in hand. Otherwise calib.json is gone and the failure reads as LOST. (2) Planner side: recalibrate follows the job by id (jobOutcome), and the scenes store's shadow sees running->failed. Both rely on the same server truth (marker => failed), so neither needs a new status; no new calib_status value is added to the contract. (3) The worker's new 'interrupted' answer after the server's own SIGTERM (timeout or stop) is read by server-domain-calib-runner as the job's timeout/'the server stopped' outcome, not as a garbled line. It is not counted as a worker failure. (4) The worker's id:null answer to an unreadable request fails that job with the worker's sentence instead of killing the worker. This was claimed by no group; it goes to server-domain-calib-runner (add server/src/scenes/logic/worker.ts readWorkerLine to its files).
- **[high] Server child processes vs server lifetime (midstudy-add, one-shot calib, render align): orphaning on stop/restart**: server-infra-tools, server-domain-calib-runner, server-domain-children-shutdown, pipeline-fal-client, pipeline-commit, planner-core-stores. Extra: None. infra-tools adds runTool's `signal`, killGroup (TERM the group, KILL after 5 s), killAllTools with a stopping latch, and the exit handler. calib-runner and children-shutdown register abortable runs with deps.onShutdown. pipeline-commit makes SIGTERM inside a paid run record the cost row and keep the outputs. pipeline-fal-client marks the call charged after submit. When a tracked job vanishes after a restart, planner-core-stores emits job-failed (lost) and reloads the library once. Settled: Timing: today main's 5 s exit race equals the 5 s kill grace, so a SIGKILL could land before pipeline's cost row. Settled: main's stop runs TERM -> wait <=5 s -> KILL -> settle, under a hard cap of 7 s. Pipeline's SIGTERM unwind (abort the fal stop signal, appendCost, move outputs to _failed) must finish in under 3 s. This fits under tooling's ladder (harness srv.stop 8 s > server stop 7 s). The spend reservation stays in memory; it is acceptable because no child outlives the server and a billed child writes its costs.csv row on TERM.
- **[high] Library add/rescale job: planner upload -> server job + spend reservation -> midstudy-add under the library lock -> item folder / library.json / costs.csv -> planner job poll**: foundation-contract, pipeline-fal-client, pipeline-commit, server-infra-tools, server-infra-lock, server-domain-children-shutdown, server-infra-library, planner-core-stores, planner-engine-items. Extra: None. Each problem has one owner. Cost lost after commit: prepare-then-commit and swap with rollback (pipeline-commit). Stale-snapshot lost update: a fresh library load inside the commit (pipeline-commit), plus no too-old reclaim of a live same-host holder before 3600 s + 10 min (server-infra-lock, contract §2.8). The 3600 s timeout equal to the stale age: the server ends every tool by 3600 s and the lock ages out at 4200 s. The 'done' item read after the lock is released: children-shutdown reads it from the child's summary line, not from library.json. Lost job in the planner: planner-core-stores. The 503 during an add making a thumbnail permanently tried: engine-items retries the thumbnail on 503 instead of setting thumbTried. Settled: Dependency names in the group plans pointed at ids that don't exist. server-domain-library-job is server-domain-children-shutdown. pipeline-interrupt-cost-row is pipeline-commit. server-infra-spend-cap is server-infra-library. The order is pipeline-commit -> children-shutdown -> infra-library, so the reservation hand-off (SpendCap.transfer, `adopt`) is written once, by infra-library, on top of children-shutdown's abortable add. A planner lost job is reported with the 'job-failed' event (no new event) and triggers one reloadLibrary, because the child may have committed before it was killed.
- **[medium] Room align job: POST align -> calibration queue -> align-room -> align.json + room.json -> planner followAlign**: foundation-contract, evals-rooms-api-align-out, server-infra-jobs, server-domain-room-align, planner-engine-base, planner-ui-room. Extra: evals-rooms-api-align-out (evals track): evals/rooms_api.mjs:346 accepts --out <rooms>/.align/<job id> as well as the old <rooms>/<room>, so it can merge before the server change. It also checks that align.json lands in rooms/<room>/ after the job. Settled: (1) A lost job is reported with the existing phase 'align-failed' plus a 'lost (the server restarted)' message. A 404 on the room also maps to 'align-failed'. No new room phase, so planner-ui-room's vocabulary is unchanged. (2) Staging: align.json is moved in only if the job wasn't dropped. A room restored during its align keeps its old align.json and poses, which closes the restore mismatch with no #dropped special case. (3) waitForRoom treats a missing scene_object as not yet calibrated and keeps polling (planner-engine-base). The server isn't asked to change its PUT/GET shape. (4) The setPose whole-list lost update and the 'too few photos after a member failed' admission are deferred. The first needs a contract version or a per-member op.
- **[medium] Warm calibration worker protocol (server CalibRunner/Worker <-> midstudy-calib serve)**: foundation-contract, calib-worker-protocol, server-domain-calib-runner, server-infra-tools. Extra: None. Contract §4.3 Worker gains the 'interrupted' sentence (foundation-contract). Settled: id:null answers become a job failure with the worker's sentence (calib-runner, logic/worker.ts). A broken answer after the work is done no longer re-runs a full `run`: calib-runner re-runs only when the answer was unreadable before any 'done' line. An over-long line still kills the worker; the double work there is accepted and noted. Two models resident at once: the idle retire waits for the old child's exit, so only one model is loaded at a time. SIGTERM: the worker answers and exits 1 (calib), and the server treats that as timeout/stop. Close uses infra-tools' TERM-then-KILL rule.
- **[medium] Render request: planner capture -> POST /api/render (synchronous) -> spend -> fal -> costs.csv -> renders/ -> planner list**: planner-engine-base, planner-engine-scene, planner-ui-workspace, planner-ui-renders, server-domain-children-shutdown. Extra: None. planner-engine-scene gives the bus 'render' event a request id (planner/bus.ts must be added to its files). On a network-level failure it emits phase 'failed' with lost:true and the text 'the render may still finish: check Renders before trying again' (planner/logic/messages.ts), then refreshes listRenders after a delay. The workspace chip and the Renders pending list key on that id. children-shutdown stops the keep-room align child on server stop. Settled: The planner-ui plans needed an id the engine didn't emit. Settled: the engine owns the id, so planner-ui-workspace and planner-ui-renders depend on planner-engine-scene. A render job route or idempotency key, which would stop a retry from paying twice, is a contract change. It is deferred to a user decision. Leftover .jpg files without a .json after a crash stay as they are (cost recorded, name reserved).
- **[medium] Library / costs lock directory protocol shared by the server and midstudy-add**: foundation-contract, server-infra-lock, server-infra-tools, pipeline-commit, planner-engine-items, tooling-dirlock. Extra: None. Settled: tooling-dirlock reuses common/logic/lock.ts's lockVerdict and sameOwner, so it is scheduled after server-infra-lock and builds on the final signature. Same-host live owners get staleMs = Infinity in dirlock, while the library lock uses timeout + 10 min; this difference is deliberate. The 60 s server wait -> 503 during an add stays (Busy is the contract's answer). The planner retries thumbnails on 503 (engine-items) instead of marking them tried.
- **[medium] SplatLayer <-> sort.worker CPU sort protocol (WebGL2 fallback)**: planner-gpu-splat-sort. Extra: None. Settled: engine.ts calls splatLayer.settle(camera) in settleSplats. splat-sort keeps settle(camera): Promise<void> as its public signature (resolving at once, with no waiter queue), so no engine.ts edit is needed and it can run beside planner-engine-base in wave 1. The 'worker down for good, main-thread fallback' shape matches the one kernels-web-face gives KernelWorker, fatal/non-fatal distinction included.
- **[low] Lighting backfill: inferLighting -> POST /light -> light job -> lighting.json -> lighting_status**: planner-engine-resources. Extra: None (the server side, 'Scene lighting backfill', is deferred by server-domain). Settled: With 'none' unpersisted on the server, the planner side has to cope. lightingStep (planner/logic/look.ts) treats 'missing' after a pending/running it saw as lost: it toasts and stops. The autostart runs at most once per scene per page session, so a 'none' that reverted to 'missing' isn't re-run on every open. calibrate() not checking a queued light job stays deferred.
- **[low] Planner kernel worker RPC (KernelWorker <-> serveKernels)**: kernels-web-face, planner-engine-resources. Extra: None. Settled: kernels-web-face makes serveKernels retry after a failed load, rejects pending entries on error or messageerror, and adds KernelWorker.close(). planner-engine-resources adds a timeout race and marks the worker down on a fatal error, calling close(). The kernels plan calls the engine half optional; settled as a dependency (engine-resources after kernels-web-face) so the engine uses the new close() and fatal semantics instead of inventing its own.
- **[low] Layout and scene documents edited from several tabs/devices (no versioning)**: server-infra-layouts. Extra: None scheduled. Versioning needs a precondition header or version field on PUT /api/layouts/{layout} (foundation); it is deferred and becomes a user decision. Settled: server-infra-layouts only re-checks the scene or room before writing. Undo of a delete overwriting a same-name layout saved in another tab stays last-writer-wins until versioning is decided.
- **[low] Build step lock and eval semaphore (cross-process, cross-worktree)**: tooling-dirlock, tooling-build, tooling-eval-lock, tooling-gates, tooling-harness, tooling-perf. Extra: None. tooling-eval-lock and tooling-harness edit foundation files (scripts/eval-lock.mjs, evals/lib/harness.mjs), so they run on the integration track. Settled: The new eval-lock must keep the same lock root (MIDSTUDY_EVAL_LOCK_DIR default), the slot names and an owner.json that the old code can read. Worktrees still on the old eval-lock.mjs then keep respecting the new holders during the wave it lands in.
- **[low] New room saga (N scene uploads -> POST room -> POST align)**: planner-ui-scenes. Extra: None. Settled: planner-engine defers this and planner-ui-scenes adds 'resume by failed step'. Settled: the UI owns the saga's resume and engine.createRoom is unchanged. The tab-closed-midway leftovers (loose calibrating scenes) and the align admission counting busy members stay deferred.

## Risks to the plan

- The working tree has uncommitted upscale work in contract/, planner/engine.ts, messages.ts, wire.ts, seam.ts, ui/panels/renders.ts, ui/logic/renders.ts and server/src/scenes/render.ts, plus server/test/scenes/render.test.ts. Worktrees are cut from a commit, so this work is invisible to them. Packages touching those files (foundation-contract, planner-engine-*, planner-ui-workspace, planner-ui-renders, server-domain-children-shutdown) would conflict on merge or silently drop it.
- planner/engine.ts is a 4-package serial chain (base W1 -> scene W2 -> items W3 -> resources W4, then planner-core-startup's one-liner in W5). The group plans also had planner-core-stores and planner-core-gesture editing engine.ts. Both were moved out: listScenesInternal sequencing goes to planner-engine-scene, the selection removal check to planner-engine-items. If a package agent ignores this, waves 3 and 6 collide on engine.ts.
- The group plans' depends_on named ids that don't exist (planner-engine-list-caches, planner-engine-selection-drag, server-infra-child-tool/-child-processes/-spend-cap, server-domain-library-job, pipeline-interrupt-cost-row, foundation-contract-*). They were remapped: engine-scene, engine-items, infra-tools, infra-library, children-shutdown, pipeline-commit, foundation-contract. The workflow script must use the remapped ids or it will deadlock or run out of order.
- Shared-append conflicts every wave: tscert/baseline.json (about 20 packages), package.json (test:planner, test:ui-machines, test:splats, test:kernels-web, test:kernels-node, test:scripts, eval:engine-races, eval:selftest-runner), knip.json, package-lock.json and core/Cargo.lock. Integration must union them and re-run `node scripts/tscert-ratchet.mjs --update` after each merge. TScert verifier timeouts under 8 parallel worktrees can look like regressions; re-run before reading one as a failure.
- Duplicate test scripts: planner-engine-base and planner-core-stores both planned a planner/test runner (test:planner-states vs test:planner). Settled on one `test:planner` glob owned by planner-engine-base; otherwise check:tests runs states.test.mjs twice.
- planner-ui-shell rewrites planner/ui/test/smoke.mjs into a sections runner in W1. planner-core-startup and planner-core-gesture planned to edit smoke.mjs directly; they must add sections/startup.mjs and sections/gesture.mjs instead. The rewrite must also port every existing smoke case unchanged, or eval:ui-smoke loses coverage. Waiting states use playwright-core page.route (what evals/lib/harness.mjs uses), not puppeteer's setRequestInterception as the UI plan said.
- The eval lock is machine-wide: 8 worktrees with long eval gates (eval:all, eval:calib with real MoGe-2/MASt3R, exclusive perf) serialize on it, so waves are bounded by eval time, not coding. tooling-eval-lock (W5) changes the lock itself and must stay format-compatible with worktrees still running the old script, or two generations ignore each other's slots.
- tooling-harness changes stop timing (8 s srv.stop, debounced signals). The server's new stop (TERM, then KILL at 5 s, 7 s cap) from server-infra-tools in W1 must stay under it; evals in W1-W4 run on the old harness with a 5 s assumption and may report slow stops as failures until W5.
- Behaviour changes that evals may pin: E1 (scenes-api) may expect calib_status 'done' when calib.json exists after a restart, or the current recalibration fallback. E18 pins the align --out argv (handled by evals-rooms-api-align-out, which must accept both forms). E2/E20 mock runs may see the exif-or-default mock fallback. Recorded examples should be unaffected (no schema change), but any eval asserting error sentences verbatim needs updating by the evals track.
- Killing midstudy-add on server stop now interrupts a live paid fal job. The cost row is recorded on SIGTERM, but if pipeline-commit's unwind exceeds the 5 s grace the SIGKILL loses the row. pipeline-commit must test the unwind time.
- The calib keep-a-good-fit rule must decide fallback before invalidate(); otherwise the commit-marker ordering deletes calib.json and a failed fallback reads as LOST_CALIBRATION.
- Ownership: tooling-eval-lock and tooling-harness edit foundation files and must run as the integration track. planner-engine-scene must add planner/bus.ts (render event id), and server-domain-calib-runner must add server/src/scenes/logic/worker.ts (id-null answers), to their file lists or check:ownership/review will flag them.
- Real-hardware gates (eval:calib with MASt3R weights and the rooms extra, eval:perf exclusive) are slow and need the 2.6 GB cache. WebGPU results under SwiftShader are not a judgement of Metal performance (judge splat/perf on Metal, per the user's memory).

## Not scheduled (deferred and won’t-fix)

- planner-engine: Splat pass redraw cache (splatEpoch + key + P.splat.drawn) - wont-fix
- planner-engine: Layout and scene documents edited from several tabs/devices - defer (needs a PUT precondition/version, contract)
- planner-engine: New room saga engine side - defer (the UI resume is in planner-ui-scenes; leftovers after a tab close stay)
- planner-engine: setPose whole-member-list lost update - defer (per-member PUT op or room version, contract)
- planner-core: Keyboard dispatch and modal key routing - defer
- planner-core: Lighting mode / env-map source with derived SH caches - defer
- planner-core: Floor shadow switch, catcher visibility, mask / diffuse-IBL overrides - wont-fix
- planner-core: Look Auto vs Manual lighting with tri-state cast_shadows - wont-fix
- planner-core: Server status vocabularies read as opaque strings - defer
- planner-gpu: GpuRadixSort pass ping-pong and in-place histogram phase - wont-fix
- server-infra: HTTP request/answer lifecycle - wont-fix
- server-infra: Safe URL fetch redirect/hop loop - wont-fix
- server-infra: Per-socket in-flight counter and idle timeout - wont-fix
- server-infra: Atomic write / replace protocol with .tmp files - defer
- server-infra: Strict mode module-global - wont-fix
- server-infra: Character/byte parsers (shlex, CSV, UTF-8, Host folding, JSON depth) - wont-fix
- server-domain: Scene camera_source governing camera overwrite - wont-fix
- server-domain: Room member placement state (pose_source) - defer
- server-domain: Scene folder progress encoded by files - wont-fix (covered by calib-scene-files ordering + the .calibrating marker)
- server-domain: Scene lighting backfill (light job, 'none' not persisted, calibrate() vs queued light job) - defer
- server-domain: nestedTooDeep JSON byte scanner - wont-fix
- server-domain: SceneService rooms hook late binding - wont-fix
- server-domain/planner: align admission counting busy members ('too few photos' after a failed member) - defer
- server-domain: render .jpg files left without .json after a crash - accepted (cost recorded, name reserved)
- server/contract: render job id / idempotency so a retried render isn't paid twice - defer to user decision
- product: Doc enrichment (nullable feed fields) - wont-fix
- product: Images dedup registry - wont-fix
- product: pyLoads pushdown JSON parser - wont-fix
- product: scriptStrings / literals lexer - wont-fix
- product: text_readings line scanner - wont-fix
- product: Item finditer chain accumulation - wont-fix
- product: thickness first-found slots - wont-fix
- product: finish merged-candidate accumulator - wont-fix
- product: py_ci regex translator and LazyLock statics - wont-fix
- product: OpenGraph image accumulator - wont-fix
- pipeline: SAM 3D 'no masks' retry ladder - wont-fix
- pipeline: JPEG marker/segment walker - wont-fix
- pipeline: Entropy-coded bit reader - wont-fix
- pipeline: Progressive JPEG spectral-selection state - wont-fix
- kernels: SceneCamera wasm handle lifecycle and scratch-view cache - defer (recorded by kernels-notes)
- kernels: Camera scratch slot protocol, JPEG walker, PNG strip walk, CPython base64, glTF Ctx/GLB walker - wont-fix (recorded by kernels-notes)
- calib: Room align.json validity stamped by photo_sha256 only - defer
- calib: Keep-room align (render composite) outcome chain - wont-fix
- calib: Process-global import/initialisation patches - defer
- calib: align-room scoring rejection loop - wont-fix
- calib: Manhattan greedy frontier and robust_up exclusion - wont-fix
- tooling: pages_server streaming generators and timers - wont-fix
- Adding eval:engine-races and eval:selftest-runner to eval:all (evals/all.mjs, evals-owned) - not planned; run by hand in integration-close

## Fix designs by group

### planner-engine (app)

Shared in this group:
- Scope guard in planner/engine.ts: scopeGuard() captures {scope: layoutScope(), query: layoutQuery(), gen: scopeGen} (scopeGen bumps on a non-switching open and on close, not on a room photo switch); stillIn(g) after every await. Used by load/save/delete/list/restore layouts, setRoomScale. sceneToken stays the per-photo guard (openSceneAs, recalibrate, saveScene, startScene).
- Latest-wins counters (`const n = ++xGen; ...; if (n !== xGen) return`) for listScenes, listRooms, listLayouts, listRenders and readLibrary: one idiom inline in engine.ts; each still returns its own answer to its caller.
- Capture mutex exclusive(fn) with a synchronous captureBusy counter in planner/engine.ts: holding() and modelThumbnail's render+readback go through it; attach paths wait with `while (captureBusy) await captureChain` and then attach in one synchronous block.
- Placement chain placed(fn) in planner/engine.ts: every clear-then-add of room pieces (placeRoomItems park/unpark/re-project, loadLayoutInternal's apply) runs one at a time, so a park never snapshots a half-landed set.
- Job follow by id: pure jobOutcome(httpStatus, status) in planner/logic/jobs.ts (TScert; 404 = lost, since JobStore never prunes and only a restart forgets) for followAlign (GET /api/rooms/jobs/<id>) and recalibrate (GET /api/scenes/jobs/<id>); the same 'lost' rule is lightingStep in planner/logic/look.ts for the light poll.
- Proof harness: planner/test/states.test.mjs (node:test, esbuild-bundled planner/logic as planner/engine.test.mjs does; npm script test:planner-states, picked up by check:tests since it isn't in PLANNER_SUITES) for the pure steps, and planner/ui/test/engine-races.mjs (evals/lib/harness.mjs + playwright-core page.route delays/404s/aborts, fal mocked by the harness, npm script eval:engine-races, run through scripts/eval-lock.mjs; not added to eval:all, whose evals/all.mjs is evals-owned). package.json and tscert/baseline.json are shared-append. Cross-group: kernels (serveKernels latch, KernelWorker pending in core/js/web.ts: complementary, not a prerequisite), planner-ui (the 'render' event id, ScenePhase consumers, whether a room switch onto a calibrating photo shows the load card), server-domain (room PUT shape for setPose, waitForRoom's scene_object default).

Packages: `planner-engine-base`, `planner-engine-scene`, `planner-engine-items`, `planner-engine-resources`

#### GLB and splat file promise caches with invalidation

**fix**, effort S · `planner/engine.ts`

Closes:
- rejection handler deletes by url and can evict a newer promise
- invalidation doesn't cancel in-flight loads (an add holding the old promise gets old bytes)

**Design:** `p.catch(() => { if (glbCache.get(url) === p) glbCache.delete(url) })` and the same for splatFiles. The in-flight-old-bytes case is covered by the placed-item fix (an add that lands with an older sig than the library's entry is rebuilt).

**Proof:** The placed-item race case (reload during a delayed GLB fetch ends with the new asset). Gates: check:types, check:lint; eval:splat, eval:library.

#### Scene open/close lifecycle (sceneToken + sceneLoad + sceneName)

**guard-only**, effort M · `planner/engine.ts`

Closes:
- room-photo switch writes sceneLoad {loading:false, phase:'calibrating', name:null} and emits a spurious 'calibrating'
- setRoomPhoto guard is a no-op during a switch, so repeated strip presses each start an open
- a superseded open's waitForScene keeps polling (unbounded while busy)
- recalibrate guarded by name only: close A, reopen A, the old recalibrate lands on the new open
- saveScene applies its answer after the await to whatever scene is open
- free-form 'scene' phase strings

**Design:** Keep v1's open flow; add the missing target and token. (1) openSceneAs always records the photo it is opening: when switching, `setLoad(sceneLoad.loading, null, name, null)` (loading stays false, so the old photo stays on screen with no load card, exactly as today); the busy branch becomes `setLoad(sceneLoad.loading, 'calibrating', name, data)` so name is never null with a phase set. Whether a room switch onto a calibrating photo should show the load card is a planner-ui decision (it can read getSceneLoad().phase/name); not changed here. (2) setRoomPhoto: `if (scene === (sceneLoad.name ?? sceneName)) return`, so a second press on the photo being opened (or open) is dropped. (3) waitForScene gets `opts.alive?: () => boolean`; before each sleep and fetch it throws a module-private `Superseded` error when alive() is false; openSceneAs passes `alive: () => token === sceneToken` and its catch returns silently on Superseded (no 'failed' event, no reportError). The hook's waitForScene keeps its current signature (alive optional). (4) recalibrate captures `const token = sceneToken` with the name; every post-await check becomes `token !== sceneToken || name !== sceneName`; it passes the same alive and treats Superseded as a silent return. (5) saveScene captures name+token before the PUT; if stale after it, only the scenes list is refreshed (no cam/cameraSource/savedScene/sceneBaseline writes). (6) `type ScenePhase = 'loading'|'calibrating'|'opened'|'failed'|'closed'|'saved'|'title'|'deleted'|'restored'|'recalibrating'|'recalibrated'|'recalibrate-failed'` and `scene: { phase: ScenePhase; name: string | null }` in EngineEvents (engine.ts:230), so tsc catches a typo in an emit and planner-ui comparisons against a non-member. All in planner/engine.ts.

**Proof:** planner/ui/test/engine-races.mjs (new, app-owned; evals/lib/harness.mjs + playwright-core page.route; run via scripts/eval-lock.mjs): (a) in the golden room, route GET /api/scenes/<B> to answer calib_status 'running' for 2 s, setRoomPhoto(B): every getSceneLoad() sample with a phase has name B, and getSceneLoad().loading stays false during the switch; (b) delay B's photo GET 1.5 s, setRoomPhoto(B) three times: exactly one 'room' {phase:'photo'} event and one GET of B's photo; (c) openScene(A) with A routed busy, then openScene(C): no GET /api/scenes/A after C's 'opened' (count over 3 s); (d) recalibrate(A) with the job held (delayed GET /api/scenes/A answering 'running'), closeScene, openScene(A), then release: getScene().camera equals the second open's GET answer and no 'recalibrated' event fires. Gates: check:types (ScenePhase), check:lint, check:planner; eval:planner (E3), eval:room-planner (E19), node planner/ui/test/rooms-ui.mjs.

#### Current layout (layoutName/title, details, remembered per scope) and load/save across scene switches

**guard-only**, effort M · `planner/engine.ts`

Closes:
- loadLayoutInternal adds A's pieces into B and remembers A's layout under B's scope
- saveLayoutInternal sets name/remember/clean after the await against the new scope
- deleteLayoutInternal computes layoutQuery twice across an await and can delete another scope's layout
- listLayoutsInternal's late response leaves A's details while B is open

**Design:** One shared scope guard in engine.ts: `interface ScopeGuard { readonly scope: string; readonly query: string; readonly gen: number }`, `let scopeGen = 0` bumped in openSceneAs when not switching (next to the items clear / room set) and in closeScene; `scopeGuard(): ScopeGuard | null` captures layoutScope(), layoutQuery(), scopeGen; `stillIn(g)` is `g.gen === scopeGen && layoutScope() === g.scope`. A room photo switch keeps the scope (the room layout stays valid), which sceneToken alone would not. loadLayoutInternal captures g before the GET, uses g.query, returns without clearing or adding when !stillIn(g) after the GET (itemsGen already cancels adds in flight when a later open clears). rememberLayout takes the scope: `rememberLayout(scope, name, at)`; every caller passes g.scope. saveLayoutInternal builds doc and g before the PUT; after it, rememberLayout(g.scope, name, updated) is always written (the server has it), but setLayoutName / markLayoutClean / emit / refreshLayouts only when stillIn(g). deleteLayoutInternal uses g.query for both GET and DELETE and touches layoutName / rememberLayout only via g.scope and only if stillIn(g) for the current-layout state. listLayoutsInternal: `const n = ++layoutsListGen`, assign layoutDetails only when stillIn(g) && n === layoutsListGen (still returning its own answer). restoreLayoutInternal likewise.

**Proof:** engine-races.mjs: route GET /api/layouts/<pick>?scene=A to wait 1.5 s; openScene(A) then openScene(B) at once; after both settle getState().items are B's layout (or none), localStorage midstudy.layout.B is unchanged and midstudy.layout.A still names A's pick (fails before: A's pieces in B). Second case: delay DELETE /api/layouts/<n>?scene=A's preceding GET, openScene(B) meanwhile: B's same-named layout still lists and A's is in the trash. Gates: check:types, check:lint, check:planner; eval:planner, eval:ux2 (layouts card), eval:room-planner (room layout round-trip), rooms-ui.mjs.

#### Room view mode: placed vs unplaced photo, parked pieces, Align photos, floor plan

**guard-only**, effort M · `planner/engine.ts`

Closes:
- park during an unpark drops in-flight pieces from both items and parked (data loss)
- unpark computes the scene transform before awaiting, so late pieces land at a stale pose
- pose/scale change from setRoomInfo during a drag snaps pieces back to stale starts
- floorPlanShown carries over to the next room; alignPhotos without floorPlanShown reachable
- (added) a park during a room layout load drops the load's in-flight pieces the same way

**Design:** (1) Serialise everything that clears-then-adds room pieces: `let placing: Promise<void> = Promise.resolve()` and `function placed<T>(fn: () => Promise<T>): Promise<T>` that chains fn after the previous (errors don't break the chain). placeRoomItems becomes `placed(placeRoomItemsNow)`, and loadLayoutInternal's quietly(clear + adds) block also runs inside placed(...) (a strip press onto an unplaced photo while a room layout loads otherwise parks only the landed pieces and cancels the rest, the same loss as the unpark race). No deadlock: nothing inside the chain awaits openSceneAs, a layout load or a capture. (2) Factor the per-item projection out of placeRoomItemsNow into `projectToPose(r)` (roomAt -> roomToSceneXf -> group position/rotation/updateMatrixWorld/syncShadow); unparkItems sets r.roomAt = p.at and calls projectToPose(r) after each add lands, so a pose changed meanwhile is honoured. (3) setRoomInfo and previewPose: when the current photo's pose or scale changed, `if (drag.mode) endItemDrag()` before re-projecting (as setAlignPhotos does via select(null)). (4) closeScene and a non-switching openSceneAs reset `floorPlanShown = false` (planner/ui/room.ts re-syncs it from visibility); setAlignPhotos becomes `alignPhotos = !!on && !!room && floorPlanShown`. deleteScene of another member awaits getRoomInternal instead of firing it. The removeSceneFromRoom transient (curMember null until the next photo opens, addItem refusing) lasts one open and is left.

**Proof:** engine-races.mjs room cases on the golden room (rooms-ui.mjs setup): delay GLB fetches 1.5 s (page.route /library/**/model.glb), load a 3-piece room layout on an unplaced photo, previewPose(photo, pose) then at once previewPose(photo, null): after settling getParked().length + items.size === 3 (before: < 3). Same with setRoomPhoto(unplaced) during a room layout load on a placed photo: 3 parked. previewPose with a moved pose during an unpark: each piece's getScreenRect matches the harness projection through the final pose within 3 px. beginItemDrag, setPose from the hook, dragTo: drag ended, no snap-back. Gates: check:types, check:lint, check:planner; eval:room-planner (E19), rooms-ui.mjs.

#### Placed item lifecycle (async build, itemsGen, per-item build token)

**guard-only**, effort S · `planner/engine.ts`

Closes:
- two concurrent adds with the same uid both pass; the first group is orphaned in the scene and the splat layer
- an add started before a photo switch lands with the old photo's scene position
- rebuildItem swaps a child while captureMask has materials swapped
- syncPlaced sets r.sig before the rebuild, so a failed rebuild never retries

**Design:** (1) `const pendingUids = new Set<string>()`: addItemInternal treats a uid as taken when `items.has(u) || pendingUids.has(u)`, adds it before the await and deletes it in a finally; a second add with that uid gets newUid. (2) After the build lands and passes the gen check, `if (room && r.roomAt) projectToPose(r)` (room-view helper). (3) Before attachBuilt in both paths (addItemInternal, rebuildItem), wait for captures with a loop on the synchronous flag: `while (captureBusy > 0) await captureChain` (captureBusy is the capture mutex's counter; a single await of the tail can let a capture queued in the same tick start before the attach), then re-check gen / build token; attachBuilt, scene.add and items.set then run in one synchronous block. (4) syncPlaced no longer writes r.sig; rebuildItem writes `r.sig = libSig(l)` only after a successful attach, so a failed rebuild keeps the old sig and the next library read retries. An add that lands after a library change (libSig(current entry) !== r.sig) schedules quiet(rebuildItem(r)) (covers the GLB-cache in-flight-old-bytes case).

**Proof:** engine-races.mjs: restoreItems([s, s]) with the same snapshot while the GLB is delayed: items size 2 with distinct uids and scene children named item:* === items size (via page.evaluate on midstudyCtx.engine's scene probe or getState). Rebuild retry: reloadLibrary with the new GLB routed to 404, then fixed and reloadLibrary again: the piece's asset is the new one. Reload during a delayed GLB fetch: the piece ends on the new asset. Gates: check:types, check:lint, check:planner; eval:splat (E13 rebuilds, splat layer), eval:library (E7), eval:room-planner.

#### Capture hold and full-frame swap (holdFrames counter, withFullFrame save/restore, mask material swap)

**guard-only**, effort S · `planner/engine.ts`, `planner/engine.passes.ts`

Closes:
- withFullFrame not reentrant: overlapping captures read wrongly framed images and leave the grid hidden / furnRT at photo size
- overlapping captureMask records the mask material as the original, pieces stay white
- modelThumbnail renders while a mask capture has maskMode on
- thumbTargets replace without dispose (dormant)

**Design:** One capture mutex in engine.ts: `let captureChain: Promise<unknown> = Promise.resolve()`, `let captureBusy = 0`, and `function exclusive<T>(fn: () => Promise<T>): Promise<T>` that chains fn after the previous capture (errors don't break the chain) and counts captureBusy from enqueue to settle. holding(fn) becomes `exclusive(() => holdingNow(fn))`, so captureCanvas and captureMask run one at a time (renderViewInternal already calls them in sequence, never nested, so no self-deadlock). withFullFrame (engine.passes.ts) is unchanged except a module-level `inFullFrame` tripwire that throws if entered twice. modelThumbnail keeps its GLB load outside the mutex (a slow download must not block exports) and wraps only the synchronous withDiffuseIbl render plus its readRgba in exclusive(...). thumbTargets disposes the old model/out targets when the size changes (two lines).

**Proof:** engine-races.mjs: Promise.all([exportImage(), exportImage({longEdge: 800})]) through midstudyCtx.engine: both equal the same exports taken one after the other (dimensions and a pixel hash of a downscale), getState().grid visible afterwards, and a following getScreenRect matches the harness projection (view offset restored). Two overlapping renderView({keep_room:true}) with fal mocked: the composite afterwards still shows the pieces' colours (a pixel probe under the probe box is not white). Gates: check:types, check:lint, check:planner; eval:render (E5 render and keep-room), eval:keys (Export), eval:splat (settle during capture), eval:perf for no regression.

#### Selection and pointer drag (move/lift/rotate)

**guard-only**, effort S · `planner/engine.ts`

Closes:
- a second begin on an already-selected piece overwrites the drag without an end event
- drag record fields stale per mode
- drags not refused while ruler or Align photos is on
- `selected` duplicates sel.primary

**Design:** (1) beginItemDrag and beginRotateDrag start with `if (drag.mode) endItemDrag()`. (2) endItemDrag calls one `resetDrag()` that restores off/a0/rot0/centre/plane/group to their initial values; the record keeps its shape (fields are read only under their mode). (3) Both begins return false when `ruler.active || alignPhotos` (the input layer's rule; Adjust floor without the ruler still allows dragging pieces, as v1). (4) Drop `selected`: `const primary = (): string | null => sel.primary` used by selectionDetail, beginItemDrag and the getters; removeItemInternal/setSelection no longer assign it. Live Shift snapping mid-drag is v1 behaviour and stays.

**Proof:** engine-races.mjs: select a piece, beginItemDrag twice, endItemDrag: 'drag' events are start,end,start,end; setAdjustFloor(true), setRulerActive(true), beginItemDrag returns false. Gates: check:types, check:lint (an unused `selected` is a lint error, not knip's), check:planner (test:ui selection logic unchanged); eval:ux, eval:ux2, eval:keys, eval:phone (drags).

#### Ruler (Adjust floor): active flag and 0/1/2 points

**guard-only**, effort S · `planner/engine.ts`

Closes:
- openSceneAs emits 'ruler' with active still true and closeScene emits none
- ruler.active without adjustFloor reachable
- setRoomScale overwrites points changed during its PUT, or onto another scene

**Design:** (1) One `resetRuler()` that sets active=false, points=[] and emits 'ruler' once; openSceneAs (replacing clearRuler + ruler.active=false) and closeScene call it. (2) setRulerActive: `ruler.active = !!on && adjustFloor && !!sceneName` (the Ruler button lives in the Adjust floor card; rooms-ui.mjs calls setAdjustFloor(true) first). (3) setRoomScale captures `const before = ruler.points` and the scope guard; after putRoom it writes the scaled points only if `ruler.points === before && stillIn(g)`.

**Proof:** engine-races.mjs: with Adjust floor and two ruler points, openScene(B): exactly one 'ruler' event, active:false; setRulerActive(true) without Adjust floor leaves getRuler().active false; setRoomScale with PUT /api/rooms/<r> delayed 1 s and a setRulerPointAt during it keeps the moved point. Gates: check:types, check:lint, check:planner; eval:ux, eval:ux2 (ruler), rooms-ui.mjs (room scale).

#### Scene and layout dirty state with baselines and the quietItems suppression counter

**guard-only**, effort S · `planner/engine.ts`

Closes:
- user edits during a quiet operation are ignored and then taken into the clean baseline by loadLayout
- saveLayout's markLayoutClean after the await takes edits made during the PUT into the baseline

**Design:** Keep the counter; make the baselines explicit. (1) `markLayoutCleanAs(sig: string)`: layoutBaseline = sig, then `setDirty({ ...dirty, layout: layoutSig() !== layoutBaseline })`. (2) saveLayoutInternal takes `const sentSig = layoutSig()` in the same synchronous step that builds the doc (identical input to the baseline function, no re-derivation from the rounded doc) and calls markLayoutCleanAs(sentSig) after the PUT (only when stillIn(g)). (3) loadLayoutInternal records each piece's pose right after its add lands (a `landed: PlacedPose[]` filled from layoutXf(r)), or the parked list for an unplaced photo, and calls markLayoutCleanAs(layoutLogic.layoutSig(landed, K)); failed pieces are absent from both sides, as today. (4) quietly()'s finally: when quietItems drops to 0, recompute once (`setDirty({ ...dirty, layout: layoutSig() !== layoutBaseline })`), so an edit swallowed while quiet is counted. Re-projection keeps comparing in the room frame.

**Proof:** engine-races.mjs: delay the layout PUT 1 s, saveLayout, moveItem during it: isLayoutDirty() true after the save resolves (false before); delay one GLB of a loading layout, move a landed piece during the load: dirty after the load. Gates: check:types, check:lint, check:planner (layoutSig vs v1 unchanged); eval:ux2 (layouts, dirty prompts), eval:room-planner (switching photos leaves the layout clean).

#### Look autosave debounce (lookTimer) and flush

**guard-only**, effort S · `planner/engine.ts`

Closes:
- two keepalive PUTs in flight may land out of order and save the older Look
- saveScene's PUT races the autosave PUT
- a change made while B loads is written to B (spurious) and lost for A

**Design:** (1) `let lookPending: { name: string; timer: ReturnType<typeof setTimeout> } | null`; saveLookSoon records sceneName at arm time; flushLook writes to lookPending.name the look of that moment. (2) openSceneAs calls flushLook() again right before it replaces `look` (after its awaits), so a change made while B loaded goes to A. (3) Timer and open/close flushes chain their PUT after the previous one (`lookChain = lookChain.then(put, put)`). pagehide/visibility-hidden flushes send immediately with keepalive regardless (a chained send would never run after unload; the rare out-of-order landing against an older in-flight PUT is accepted there). (4) saveScene calls flushLook() and awaits lookChain before its own PUT, so the newer is last.

**Proof:** engine-races.mjs: route PUT /api/scenes/<A> to delay the first request 1 s and record bodies in arrival order; setLighting x, wait 800 ms, setLighting y, openScene(B): A's last body has y; a setLighting made while B's GET is delayed ends in A's last PUT and B gets no PUT. Gates: check:types, check:lint, check:planner; eval:lighting (E16 Look), eval:ux2.

#### Lighting backfill: lightingStatus enum + lightingToken + polling loop

**guard-only**, effort S · `planner/engine.ts`, `planner/logic/look.ts`, `planner/test/states.test.mjs`, `tscert/baseline.json`

Closes:
- exhausted 600-poll loop leaves pending/running forever with no event
- recalibrate bumps the token and may set pending/running, but nothing polls afterwards
- POST-failure branch overwrites a newer status (no token check)
- concurrent inferLighting calls

**Design:** Split inferLighting into postLight(name) and `pollLighting(name, token)`; add a pure step in planner/logic/look.ts (TScert): `lightingStep(prev: string, polled: string, polls: number, maxPolls: number): { status: string; terminal: boolean; error: string | null }`: wait for pending/running; terminal for done/none/failed; terminal failed 'the lighting job was lost (the server restarted?)' when polled is 'missing' after a pending/running prev; terminal failed 'gave up waiting' at maxPolls. Every loop exit sets a status and emits 'lighting'. The POST-failure branch checks `token === lightingToken && name === sceneName`. recalibrate, after setLightingData, starts `quiet(pollLighting(name, ++lightingToken))` when the status is pending/running. `lightingRun: { name; token; p } | null`: inferLighting returns the in-flight promise for this scene and token instead of posting again.

**Proof:** node:test planner/test/states.test.mjs (new; bundles planner/logic with esbuild as planner/engine.test.mjs does; npm script test:planner-states, which check:tests picks up because it isn't in PLANNER_SUITES): lightingStep table incl. pending->missing = failed/lost and polls==max = failed. engine-races.mjs: route POST /light 202, then GET scene answering lighting_status 'missing': the 'lighting' event ends 'failed' (before: stuck 'pending'). Gates: check:tscert (lightingStep certified; tscert-ratchet --update), check:tests, check:types, check:lint; eval:lighting (E16 backfill).

#### Kernel worker lifecycle with main-thread fallback

**guard-only**, effort S · `planner/engine.ts`

Closes:
- no timeout: a hung worker or an unreadable message leaves loadDepth/openSceneAs awaiting forever
- worker never terminate()d after 'error'
- once dead it never restarts (deferred)

**Design:** In engine.ts worker(): a 'messageerror' listener that rejects workerDown like 'error'; on either, w.terminate() and clear kernelWorker. inWorker races the call against `down` and `sleep(DEPTH_WORKER_MS = 20000)`; on timeout it marks the worker down the same way (terminate, reject down, so other pending calls fall back too) and runs here(). No restart: one failure moves depth decodes to the main thread for the session (correct, only slower). KernelWorker#pending and serveKernels' latch are core/js/web.ts (kernels track) and complementary, not a prerequisite.

**Proof:** engine-races.mjs: page.route the planner's engine.worker bundle to a module that never posts; openScene of a golden scene with depth opens within 20 s + decode with getState().scene.hasDepth true. Gates: check:types, check:lint, check:planner; eval:occlusion (E4 depth), eval:perf (depth decode unchanged on the happy path).

**Why:** Restart is deferred: a session-long main-thread fallback costs milliseconds per depth decode.

#### Library load and placed-copy sync (libraryLoading promise, library array)

**guard-only**, effort S · `planner/engine.ts`

Closes:
- overlapping reloads resolve out of order; the older list overwrites the newer and syncPlaced rebuilds to stale assets
- a failed read empties the library and the next layout marks every piece missing
- openSceneAs awaits only the libraryLoading current at that moment

**Design:** (1) `let libraryGen = 0`; loadLibrary does `const g = ++libraryGen` and readLibrary assigns library / runs syncPlaced / emits only when g === libraryGen. (2) A failed re-read keeps the previous list (`library = ok ? list : library`); the first read failing still leaves [] with the error reported as now. This deviates from v1 (which emptied it); record it in docs/notes/app.md per contract §0. (3) `async function libraryReady(): Promise<void> { for (let p = libraryLoading; ; p = libraryLoading) { await p.catch(() => undefined); if (p === libraryLoading) return } }` replaces the single await in openSceneAs.

**Proof:** engine-races.mjs: route the first /library/library.json to answer an older list after 1.5 s and the second at once; reloadLibrary twice: getState library is the second list; a 500 on a re-read keeps the pieces non-missing on the next loadLayout. Gates: check:types, check:lint, check:planner; eval:library (E7), eval:splat (rebuild on reload), eval:planner.

#### Room alignment follow/wait polling

**guard-only**, effort S · `planner/engine.ts`, `planner/logic/jobs.ts`, `planner/test/states.test.mjs`, `tscert/baseline.json`

Closes:
- 404 or loop exhaustion returns without aligned/align-failed, the UI stays 'aligning'
- waitForRoom has no overall timeout while busy (documented, not changed)
- following continues after the room is closed and its event/toast fire for a room that isn't open

**Design:** alignRoom passes the job id from the 202 (align-accepted.job.id) to `followAlign(name, jobId)`, which polls GET /api/rooms/jobs/<id> (existing route, contract §4.9; the server's JobStore never prunes, so a 404 means a restart) and reads the room detail for the poses when it ends. A pure `jobOutcome(httpStatus: number | null, status: unknown): 'wait' | 'done' | 'failed' | 'lost'` in a new planner/logic/jobs.ts (TScert). Every exit emits a terminal phase: 'aligned'; 'align-failed' with the job's message; 'align-failed' with 'the alignment was lost (the server restarted?)' for lost, a 404 on the room, or the loop running out. The toast and setRoomInfo only when `room?.name === name` (the event still fires with the name, for the Scenes page). waitForRoom (hook only, the evals' waiter) keeps no overall limit; documented.

**Proof:** node:test states.test.mjs: jobOutcome table (404 -> lost, queued/running -> wait, done, failed, junk -> wait or failed as decided). engine-races.mjs: route GET /api/rooms/jobs/<id> to 404 after one 'running': a 'room' event with phase 'align-failed' arrives. Gates: check:tscert, check:tests, check:types, check:lint, check:dead (jobs.ts used); eval:room-planner (E19), eval:align -- --mock (E20), rooms-ui.mjs.

#### On-demand render loop (awakeUntil, framePending, holdFrames, renderErrorReported)

**guard-only**, effort S · `planner/engine.ts`

Closes:
- renderErrorReported never reset: later failures are silent for the session
- no device-lost handling (reported only)

**Design:** Reset `renderErrorReported = false` in openSceneAs when a scene opens (one report per scene). Device loss: when the backend is WebGPU, `device.lost.then(() => reportError('The GPU was lost; reload the page'))`, reached through a type guard on renderer.backend (no `as`, lint strict); re-creating the renderer is deferred.

**Proof:** engine-races.mjs: register a throwing callback with midstudyCtx.engine.onFrame (frameFns run inside the loop's try), wake, count 'Rendering failed' reports: 1; openScene(another); count 2; remove it. Gates: check:types, check:lint; eval:perf (no regression), eval:planner.

**Why:** Device re-creation is deferred: not seen on this Mac's Metal WebGPU, and a reload recovers.

#### Missing-thumbnail worker queue (thumbsRunning + thumbTried)

**guard-only**, effort S · `planner/engine.ts`

Closes:
- failed items are never retried this page load (incl. a 503 while midstudy-add holds the library lock)
- renders with the shared renderer while a capture holds

**Design:** Keep the queue. A modelThumbnail failure stays in thumbTried (deterministic: a bad GLB); a PUT failure that is transient (statusOf(e) === 503 or null) deletes the id from thumbTried and stops the loop, so the next library read (data.ts reloads after the add's job-done) retries. The render part goes through exclusive() (capture fix).

**Proof:** engine-races.mjs: route PUT /api/library/items/<id>/thumb to 503 once, then reloadLibrary: a second PUT is sent and the thumb appears in getState library. Gates: check:types, check:lint; eval:library (E7 GLB add thumbnail).

#### Photo/depth resources and the occlusion flag

**guard-only**, effort S · `planner/engine.ts`

Closes:
- setOcclusion(true) without depth reports occlusion on
- recalibrate with depth now null leaves occlusion true
- clearPhoto keeps the last photo's w/h (left)

**Design:** Keep `occlusion` as the user's choice (v1) but report and emit the effective value: getSceneState and the 'occlusion' event use `occlusion && !!photo.depthTexture`; recalibrate sets occlusion = false when the new depth is null. clearPhoto's w/h are left.

**Proof:** engine-races.mjs: openScene of a no-depth golden scene, setOcclusion(true): getState().scene.occlusion false and the 'occlusion' event says off. Gates: check:types; eval:occlusion (E4: depth scenes unchanged), eval:splat.

**Why:** w/h after close: no consumer reads them without a photo.

#### Render request (render event start/done/failed) and the renders list

**guard-only**, effort S · `planner/engine.ts`

Closes:
- concurrent renders interleave 'render' events with no correlation id
- a previous scene's listRenders landing after a switch overwrites renders

**Design:** (1) `id: number` (a counter) on every 'render' event detail (start/done/failed) in EngineEvents; two renders at once stay allowed, as v1. (2) listRendersInternal captures its query string and `const n = ++rendersListGen`; assigns renders and emits only when the query equals the current one and n is the latest (it still returns its own answer to its caller).

**Proof:** engine-races.mjs: delay GET /api/renders?scene=A, open B: getState renders are B's; two renderView calls (mocked fal) give start/done pairs with matching ids. Gates: check:types (event detail), check:lint; eval:render (E5), eval:ux2 (renders panel).

#### Startup landing and persisted 'last opened' state (LAST_ROOM_KEY / LAST_SCENE_KEY / roomPhoto keys / URL params)

**guard-only**, effort S · `planner/engine.ts`

Closes:
- startScene's late open replaces the user's own choice made during startup

**Design:** startScene captures `const t0 = sceneToken` at its start and skips openRoom/openScene when `sceneToken !== t0`. closeScene keeping lastRoom/lastScene is v1 behaviour and stays; the keys' precedence stays in startScene.

**Proof:** engine-races.mjs: with lastRoom set, delay GET /api/rooms 1.5 s at page load, openScene(X) through the hook meanwhile: X stays open. Gates: check:types; eval:planner (landing), eval:phone, rooms-ui.mjs (reload into a room).

**Why:** Clearing the keys on close would change v1's reload behaviour for no reported problem.

#### Scene camera provenance (cameraSource string + savedScene baseline + sceneBaseline)

**guard-only**, effort S · `planner/engine.ts`, `planner/logic/camera.ts`, `planner/test/states.test.mjs`, `tscert/baseline.json`

Closes:
- resetCamera sets the source without consulting savedScene, so a reset to the saved camera leaves a different source un-prompted

**Design:** Pure `sourceAfterReset(cam, hasCalibCamera, saved, savedSource)` in planner/logic/camera.ts (TScert), next to sourceAfterChange: the saved source when cam equals the saved camera, else 'auto' / 'default'; resetCamera uses it. The recalibrate divergence is left: the server's rule wins and a reopen re-syncs.

**Proof:** states.test.mjs cases for sourceAfterReset; check:tscert. eval:floor (Adjust floor reset), eval:planner.

#### Scene and room list caches (scenesList/scenesTrash, roomsList/roomsTrash)

**guard-only**, effort S · `planner/engine.ts`

Closes:
- fire-and-forget list refreshes with no generation: an older response landing last overwrites a newer list

**Design:** `let scenesListGen = 0, roomsListGen = 0`; listScenesInternal/listRoomsInternal take `const n = ++gen` and assign/emit only when n is still the latest (still returning their own answer). serverHasRooms() before the first list is left: the Scenes page re-renders on 'rooms'/'scenes'.

**Proof:** engine-races.mjs: delay the first GET /api/scenes 1 s, listScenes twice with a deleteScene in between: the list does not resurrect the deleted scene. Gates: check:types; eval:planner, eval:ux2 (Scenes page), eval:room-planner.

#### Scene calibration job: upload -> calibration queue -> calib worker/one-shot -> files on disk -> planner polling

**guard-only**, effort S · `planner/engine.ts`

Closes:
- planner part: lost re-calibration reads as success (recalibrated toast)
- planner part: superseded openSceneAs keeps polling

**Design:** Engine side only. recalibrate keeps the job id from the 202 (calibrate-accepted.job.id) and, after waitForScene, GETs /api/scenes/jobs/<id> through logic/jobs.ts jobOutcome: 'lost' (404; the JobStore never prunes, so only a restart forgets it) emits 'recalibrate-failed' with 'the calibration was lost (the server restarted?)' instead of 'recalibrated'; 'failed' emits recalibrate-failed with the job message. The superseded poll is closed by the scene-lifecycle alive option. Torn writes, the fallback deleting depth, and restore-during-job are server/calib.

**Proof:** engine-races.mjs: route GET /api/scenes/jobs/<id> to 404 after recalibrate: 'scene' phase 'recalibrate-failed'. Gates: check:types, check:tests (jobOutcome); eval:planner (recalibrate).

#### Room align job: POST align -> calibration queue (waits for member calibrations) -> align-room (MASt3R/Manhattan) -> align.json + room.json -> planner followAlign

**guard-only**, effort S · `planner/engine.ts`

Closes:
- planner part: followAlign treats 'none'/'done' after a restart as success
- planner part: 404 returns silently

**Design:** Covered by the job-id follow in 'Room alignment follow/wait polling' (status read from the job, not the room's align_status). setPose's whole-member PUT (lost update against another tab) and waitForRoom's default for a missing scene_object are deferred to server-domain (contract §4.9 PUT shape).

**Contract:** setPose lost update would need a per-member PUT op or a room version in contract/api (foundation); not proposed here.

**Proof:** As 'Room alignment follow/wait polling'.

**Why:** The multi-tab lost update is unlikely for one user; deferred to the server's room PUT design.

#### Planner kernel worker RPC (KernelWorker <-> serveKernels in engine.worker)

**guard-only**, effort S · `planner/engine.ts`

Closes:
- planner part: a reply that never comes / messageerror leaves the decode awaiting forever

**Design:** Engine side covered by the timeout + messageerror + terminate in 'Kernel worker lifecycle with main-thread fallback'. serveKernels' latched rejection and KernelWorker#pending are core/js/web.ts (kernels track).

**Proof:** As 'Kernel worker lifecycle with main-thread fallback'.

#### Lighting backfill: planner inferLighting -> POST /light -> light job on the calibration queue -> lighting.json -> lighting_status

**guard-only**, effort S · `planner/engine.ts`, `planner/logic/look.ts`

Closes:
- planner part: a light job lost to a restart reads as 'missing' and stops silently

**Design:** Covered by lightingStep's pending/running -> missing = failed (lost). 'none' not on disk and calibrate-vs-light queueing are server-domain.

**Proof:** As 'Lighting backfill: lightingStatus enum + lightingToken + polling loop'.

#### Render request: planner capture -> POST /api/render (synchronous, no job) -> spend reservation -> fal -> costs.csv -> files in renders/ -> planner list

**guard-only**, effort S · `planner/engine.ts`, `planner/logic/messages.ts`, `tscert/baseline.json`

Closes:
- planner part: a dropped request toasts failure though the server finishes and bills (and invites a paid retry)

**Design:** In postRender's catch, a failure with no HTTP status (fetch rejected: network drop, sleep) is told apart from the bad-answer case (which also calls renderFailText(null) today, engine.ts:2934): a new `renderLostText()` in planner/logic/messages.ts ('The connection dropped; the render may still finish and will appear in Renders. Check there before rendering again.'), leaving renderFailText and its v1 strings untouched. It then refreshes the list at 5 s, 30 s and 90 s (quiet(listRendersInternal()), stopping once a render newer than the request's start is listed). A render job id is a server/contract change, deferred.

**Proof:** engine-races.mjs: route POST /api/render with route.fetch() (mocked fal answers) then route.abort(): the toast is renderLostText's and within 6 s getState renders lists it. Gates: check:tscert (renderLostText), check:planner (messages vs v1 unchanged), eval:render.

#### Library / costs lock directory protocol shared by the server and midstudy-add

**guard-only**, effort S · `planner/engine.ts`

Closes:
- planner part: thumbnail PUT 503 during an add marks the item tried and never retries

**Design:** Covered by the transient-failure retry in 'Missing-thumbnail worker queue'. The lock protocol itself is server-infra / pipeline.

**Proof:** As 'Missing-thumbnail worker queue (thumbsRunning + thumbTried)'.

#### Layout and scene documents edited from several tabs/devices (no versioning)

**defer**, effort M

Closes:
- layout PUT last-writer-wins across tabs
- Undo of a delete overwrites a same-named layout saved since

**Design:** No engine change now. If wanted later: send If-Unmodified-Since/ETag on PUT and offer 'Save as new' on 412 (server + contract).

**Contract:** Would need a precondition header or version field on PUT /api/layouts/{layout} (foundation).

**Proof:** n/a

**Why:** One user, rarely two tabs on one layout; layoutToOpen's 'saved later elsewhere' rule already picks up the other device's save on open.

#### New room saga (planner multi-request: N scene uploads -> POST room -> POST align) [missed by the per-area lists as a cross-process machine]

**defer**, effort S · `planner/engine.ts`

Closes:
- no compensation when a later upload fails: earlier scenes stay loose

**Design:** Minimal option if it bites: createRoom's catch toasts which scenes were made ('Made 2 of 3 photos; they are on the Scenes page') and refreshes the list; no automatic delete.

**Proof:** n/a

**Why:** Loose scenes are visible and deletable on the Scenes page; deleting them automatically could lose a calibration the user wants. No money or hang: the scenes' calibrations are local (MoGe), not fal.

#### Splat pass redraw cache (splatEpoch + key string + P.splat.drawn) and lazy splat layer

**wont-fix**, effort S · `planner/engine.ts`

Closes:
- depth key uses the texture id (safe while setPhoto makes a new DataTexture)
- splat layer and targets live forever after the first splat item

**Design:** No change. A one-line comment at setPhoto that the splat key relies on a fresh depth DataTexture per photo.

**Proof:** eval:splat (E13) keeps covering the redraw key.

**Why:** Theoretical or a bounded memory hold: setPhoto always makes a new texture, and one splat layer for the life of a personal-use tab costs a few MB. Disposing and re-creating it would add a lifecycle with its own races.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 23 '### ' machines of ## planner-engine have exactly one entry. The 8 other entries (scene calibration job, room align job, kernel RPC, lighting backfill, render request, multi-tab documents, new room saga, library lock) come from '## State machines that span areas'; kept as the planner-side parts. Fixed the packages so 'Room align job', 'New room saga' and 'Layout and scene documents' are each in exactly one package (they were in none).
- Packages were not file-disjoint: all four edit planner/engine.ts (and three share engine-races.mjs, states.test.mjs, tscert/baseline.json). Made them a strict chain base -> scene -> items -> resources; resources previously ran in parallel with scene/items against the same file. Dropped resources' dependency on kernels-worker-rpc: the engine-side timeout/terminate does not need the core/js/web.ts fix. Added the ownership gate (MIDSTUDY_TRACK=app) to every package, not only base, and eval:perf to base for the capture mutex.
- Scene lifecycle: the original design changed the busy-switch branch to setLoad(true, 'calibrating', ...), which turns loading on in a room switch. planner/ui/workspace.ts:renderLoadCard then covers the photo with the load card, whose 'Back to scenes' calls closeScene (leaving the room). That is a silent UI change against v1's 'the last photo stays until the next one is ready'. Now loading keeps its value and only the name (the target) is fixed; whether to show the card is left to planner-ui. Also stated that recalibrate's catch treats Superseded as silent, like openSceneAs.
- Room view: added a risk the plan missed. loadLayoutInternal's clear+adds can be parked by a strip press onto an unplaced photo mid-load (parkItems snapshots only the landed pieces, and clearItemsInternal cancels the rest), the same data loss as the unpark race. The placement chain now covers loadLayoutInternal's apply block too.
- Placed item: 'await captureIdle()' could resolve while a capture queued in the same tick starts before the attach. Replaced it with a loop on a synchronous captureBusy counter, then one synchronous attach + scene.add + items.set block.
- Capture: wrapping all of modelThumbnail in exclusive() would hold every export or render behind a GLB download. The mutex now covers only its synchronous render plus readback. Checked that captureCanvas/captureMask never nest (renderViewInternal calls them in sequence), so holding() going through exclusive cannot self-deadlock.
- Dirty state: computing the save baseline from the doc's pieces risks differences from rounding in docItem. It now uses `layoutSig()` taken in the same synchronous step that builds the doc.
- Look autosave: chaining a pagehide flush behind an in-flight PUT loses it, because nothing runs after unload. pagehide/visibility-hidden now always send at once with keepalive, accepting the rare reorder there.
- Render cross-process: renderFailText(null) is also used for the server's 'answer isn't a render' case (engine.ts:2934), so changing its null branch would change that message too. Now a separate renderLostText() in planner/logic/messages.ts (TScert, baseline update) is used only for a rejected fetch. A single 5 s refresh can miss a real (non-mock) render, which takes longer, so it now refreshes at 5/30/90 s and stops once the render is listed. Kept guard-only: it is the money risk (paid retry), and the toast now says to check Renders before retrying.
- Render loop proof was 'Manual/hook: test-only hook'. Made it concrete: a throwing callback registered through midstudyCtx.engine.onFrame (frameFns run inside the loop's try), counted per scene open. Device-lost access needs a type guard on renderer.backend, because lint forbids `as`.
- Library: keeping the old list on a failed re-read deviates from v1 (contract §0). It must be recorded in docs/notes/app.md.
- Room alignment/recalibrate job follow: verified that GET /api/rooms/jobs/{id} and GET /api/scenes/jobs/{id} exist in contract/api/routes.json, that align-accepted and calibrate-accepted carry job (with its id), and that server/src/jobs.ts JobStore never prunes. So a 404 really means a restart; no contract change is needed.
- Ruler: confirmed that rooms-ui.mjs calls setAdjustFloor(true) before setRulerActive(true), so requiring adjustFloor breaks no eval; the UI's Ruler button is inside the Adjust floor card.
- Selection: an unused `selected` after the change is caught by check:lint, not check:dead (knip checks exports/files); gate note corrected.
- Test plumbing: check:tests runs every test:* script except test:engine/test:ui (scripts/check.mjs PLANNER_SUITES), so test:planner-states is picked up. knip's project globs do not include planner/**/*.mjs, so the new .mjs files need no knip.json entry. planner/test/ is a new directory under planner/ (app-owned). eval:engine-races is not added to eval:all, because evals/all.mjs is evals-owned (a follow-up for that track).
- No decisions upgraded: the deferred items (multi-tab versioning, the room saga) involve no fal spend, no hang and no silent data loss beyond what the Scenes page shows. The wont-fix (splat layer) is a bounded memory hold.

</details>

### planner-core (app)

Shared in this group:
- Answer sequencing: a request counter taken before the fetch and an 'applied' counter; an answer with n <= applied is dropped (no emit, no state write). Pure `freshAnswer(n, applied)` in planner/logic/scenes.ts, used by the engine's listScenesInternal (shared with planner-engine's list-caches fix, which should use the same helper for listRoomsInternal) and by the library jobs poll in planner/data.ts.
- Report-once-per-outage: polling loops report only the first failure of a run of failures and back off via a pure delay function (sceneLogic.pollDelay, libLogic.jobsPollMs), so engine.errors and the sticky toast do not churn.
- Store tests without a browser: planner/test/*.test.mjs (node:test) esbuild-bundle planner/data.ts, planner/logic/input.ts or planner/ready.ts (esbuild 0.28.2 is already a devDependency, as planner/engine.test.mjs uses it), with './engine.js' aliased by an esbuild plugin to a small stub and fetch/XMLHttpRequest/window faked; node:test mock.timers for the poll delays. One `test:planner` script appended to package.json by planner-core-stores; scripts/check.mjs runs every test:* not in PLANNER_SUITES under check:tests, so no toolchain-owned file changes.
- Drag ownership on the canvas: input.ts holds a token of the drag it began (uid + mode) and only drives or ends the engine's drag while engine.getDrag() still matches; it does not begin one while another is active. This is independent of how planner-engine resolves begin-while-dragging.

Packages: `planner-core-stores`, `planner-core-startup`, `planner-core-gesture`

#### Client-side shadow of each scene's calibration status (pending -> running -> done | failed)

**fix**, effort S · `planner/data.ts`, `planner/test/stores.test.mjs`

Closes:
- upload onload seeds 'pending' over a 'done' already seen, giving a spurious extra 'ready'
- seen never pruned on delete

**Design:** The earlier draft (seed only when !seen.has(name)) loses the only 'ready' when a poll's first sight of the new scene is already 'done' (fast calib, poll in flight before the XHR onload fires): sceneFinished(undefined, 'done') is null and the seed would then be skipped. Instead keep `announced: Set<string>` in createScenes: the 'scenes' handler emits a finish only when `fin && !announced.has(name)` and adds it, and deletes the name from announced whenever the listing shows it busy (a recalibration may announce again). Upload onload: if !seen.has(name) seed 'pending' as today; else if seen's value is not busy and !announced.has(name), emit sceneFinished('pending', seen value) now (it finished before the upload answered) and add it; else nothing. Prune: after a fresh list (the answer sequencing makes it authoritative), delete seen/announced entries for names not in the list whose value is not busy; a busy entry (an upload seed not yet listed, or a scene deleted mid-calibration) stays, which is a few strings at most. Not fixed: done -> pending -> done between two polls is invisible to a snapshot mirror (engine.recalibrate emits its own 'recalibrated'); a malformed null after busy reading as 'failed' is theoretical under the closed enum and the strict server.

**Proof:** planner/test/stores.test.mjs: (a) listing shows s 'pending' then 'done' ('ready' once), then the stubbed XHR upload for s completes 202, then another 'done' listing: before, a second 'ready'; after, none. (b) the first listing of s is already 'done', then onload: exactly one 'ready' (the draft's guard would give none). (c) a list without a done s drops it; a restored done s produces no event. Gates: check:types, check:lint, check:tests; eval:ux (upload flow) through the eval lock.

#### Selection set with primary piece

**fix**, effort S · `planner/engine.ts`

Closes:
- removal path sets sel/selected by hand, bypassing setSelection (primary stored three times)

**Design:** In engine.ts removeItemInternal replace the hand-written `sel = selLogic.without(...); selected = sel.primary; if (drag...) endItemDrag(); emit('selection', ...)` with `if (sel.uids.includes(r.uid)) setSelection(selLogic.without(sel, r.uid))`; setSelection already keeps `selected`, ends a drag whose uid leaves the selection and emits, so the behaviour is identical. This is the same line planner-engine's 'Selection and pointer drag' machine lists (its risk 4: `selected` assigned separately in removeItemInternal and setSelection); it is done once, inside that planner-engine package, and this entry only verifies it landed (no separate planner-core edit to engine.ts, so the two groups cannot conflict). 'set' with an unknown uid clearing the selection stays: v1's selectStep, pinned by engine.test.mjs.

**Proof:** check:planner (selectStep vs v1 unchanged); eval:ui-smoke Del + Ctrl+Z and eval:keys (delete with a multi-selection keeps the primary and emits the selection event). A pure refactor proven by the existing evals. Gates: check:types, check:lint.

#### Canvas pointer gesture (tap / item drag / shift-toggle-or-lift / pan / pinch)

**guard-only**, effort M · `planner/input.ts`, `planner/logic/input.ts`, `planner/test/gesture.test.mjs`, `planner/ui/test/smoke.mjs`, `tscert/baseline.json`, `docs/notes/app.md`

Closes:
- canvas finger drives/ends the rotate grip's drag (no drag token)
- 3+ pointers: lifting a pinch pointer re-pairs other pointers against stale d0/mx/my (zoom/pan jump)
- pinch-residual dead end: remaining finger cannot pan; ignored if the lifted finger was g.id
- gesture in flight across an openScene swap ends with a tap on the new scene

**Design:** Keep the Gesture shape in planner/input.ts and add four guards; engine.ts is NOT edited here (the begin*-overwrites-an-active-drag rule belongs to planner-engine's 'Selection and pointer drag' fix, which this package depends on). (1) Drag token: Gesture gets `drag: { uid: string; mode: 'move'|'lift' } | null`, set from engine.getDrag() right after a successful beginItemDrag (pointerdown and the shift->lift branch in pointermove). pointerdown does not call beginItemDrag at all while engine.getDrag() is non-null (the grip already holds a rotate: the canvas finger becomes 'other'), closing the grip-first order. pointermove calls engine.dragTo and up() calls engine.endItemDrag only while `decide.sameDrag(g.drag, engine.getDrag())` (same uid and mode); otherwise the gesture degrades to 'other' and never touches the engine's drag. This holds whichever rule planner-engine picks for begin* (refuse, or end-then-start): in both the canvas stops driving a drag it does not own. The ptrs.size===2 branch's endItemDrag goes through the same check. (2) Pinch pair: `pinch` stores the two pointer ids `{a, b, d0, z0, mx, my}`; mid() reads ptrs.get(a)/ptrs.get(b) instead of the first two Map values. In up(): if the lifted id is a or b and ptrs.size >= 2, re-seed pinch from `decide.nextPinchPair(ids, lifted)` with z0 = current zoom and d0/mx/my from their current positions; lifting a third, unpaired finger changes nothing. (3) Residual hand-off: when a pinch drops to exactly one pointer, rewrite g to `{ id: remaining id, kind: decide.residualKind(zoom) ('pan' if zoom > 1.001 else 'other'), lx/ly and x0/y0: its position, moved: true, multi: true, drag: null, residual: true }`. pointermove uses `decide.residualPans(g.moved, g.kind, zoom)` when g.residual and the v1-differential `pans()` otherwise (pans requires !multi, so it cannot serve the residual case and stays untouched). multi stays true, so isTap never taps. This is a narrowing of v1 (v1's remaining finger was dead): record it in docs/notes/app.md. (4) Scene token: Gesture records `scene: engine.getSceneName()` at pointerdown; up() skips engine.tap and the shift toggle (and the residual/drag paths no-op via the drag token, since the scene switch clears the drag) when engine.getSceneName() !== d.scene. Reopening the same scene name is not distinguished (accepted; a planner-engine scene token can replace the name later). New pure helpers sameDrag, residualKind, residualPans, nextPinchPair(ids, lifted) go in planner/logic/input.ts for TScert.

**Proof:** planner/test/gesture.test.mjs (node:test; esbuild-bundles planner/logic/input.ts as planner/engine.test.mjs does): nextPinchPair with 3 ids and a pinch id lifted returns the other two; sameDrag false for {uid, 'move'} vs an engine rotate drag and for null; residualKind/residualPans cases (zoom 1 -> 'other', no pan; zoom 2 -> pans). Browser repros added to planner/ui/test/smoke.mjs via CDP Input.dispatchTouchEvent (the pattern already used in evals/out/verify-ux/p6-phone.mjs), each run once on the unfixed tree to see it fail: (a) finger on a selected piece, then a second finger on the rotate grip, move the canvas finger: the piece's rotation_y_deg must follow only the grip, and getDrag() stays 'rotate' until the grip finger lifts; (a') grip first, then a canvas finger on the piece: no 'drag' start for 'move'; (b) three touches, lift one pinch finger, next move changes getView().zoom by < 1%; (c) pinch to zoom 2x, lift one finger, move the other: the view pans and no tap/selection change happens. Run through the lock: `nix develop -c node scripts/eval-lock.mjs -- npm run eval:ui-smoke`. Gates: check:types, check:lint, check:tscert (--update for the new functions), check:tests (test:planner), check:planner (isTap/pans unchanged vs v1); evals eval:phone, eval:planner, eval:keys, eval:ui-smoke.

#### Page startup and the test hook's ready lifecycle

**guard-only**, effort S · `planner/ready.ts`, `planner/main.ts`, `planner/engine.ts`, `planner/test/ready.test.mjs`, `planner/ui/test/smoke.mjs`

Closes:
- renderer.init() rejects: ready never settles and the failure is invisible (placeholder errors [])
- a caller holding the placeholder errors array holds a dead array after main.ts swaps the hook
- first 'scenes' events in nondeterministic order (closed by the scenes-store answer sequencing)

**Design:** ready.ts exports `startErrors: string[]` and puts that same array on the placeholder hook; engine.ts initialises `const errors = startErrors` (import from './ready.js', no deps, no await) so engine.errors, the placeholder and main.ts's hook (errors: engine.errors) are one array. This matters beyond the dead-array case: when renderer.init rejects, main.ts never runs, and the engine's own window 'error'/'unhandledrejection' listeners (engine.ts ~291, installed before the await) push into an array nobody can see today. ready.ts installs one window 'error' listener (not 'unhandledrejection': a stray async rejection during a normal startup must not settle ready before the first page state and make evals flaky). A module evaluation failure (the engine's top-level await rejecting, or a kernel/wasm import failing before the engine's body runs) reaches window as an ErrorEvent; on it ready.ts waits one macrotask (so the engine's listener can report first), pushes `Startup failed: <message>` only if startErrors is still empty (no duplicate line), and calls settle(). main.ts calls an exported `startupDone()` that detaches the listener right after it installs the full hook. ready resolves (does not reject), keeping §2.4's 'ready: first page state settled'; failure is read from errors (v1: init swallowed startScene failures). No new hook field (that would be a contract change).

**Proof:** planner/test/ready.test.mjs (node:test): esbuild-bundle planner/ready.ts with globalThis.window = an EventTarget; dispatch an 'error' Event with a message before settleReady: ready settles within two ticks, window.midstudy.errors is the exported startErrors (same object) and holds one 'Startup failed' line; with a line already pushed (the engine's listener) no second line is added; an 'unhandledrejection' alone does not settle. Browser proof in planner/ui/test/smoke.mjs: a page with Page.addScriptToEvaluateOnNewDocument removing navigator.gpu and making HTMLCanvasElement.prototype.getContext return null, so the renderer cannot init; assert window.midstudy.ready resolves within 10 s and errors.length > 0 (confirm on the unfixed tree first that ready hangs; if Chrome does not surface the TLA rejection as a window ErrorEvent, the design falls back to main.ts importing the engine via dynamic import inside try/catch, which is the same files). Through the eval lock. Gates: check:types, check:lint, check:dead (startErrors/startupDone used), check:tests; eval:all browser evals (all await ready), eval:ui-smoke.

#### Scenes store: load, poll while calibrating, offline backoff

**guard-only**, effort M · `planner/data.ts`, `planner/engine.ts`, `planner/logic/scenes.ts`, `planner/test/stores.test.mjs`, `tscert/baseline.json`, `package.json`

Closes:
- stale-response race: an older listScenes answer rewinds list/seen and re-emits 'ready'/'failed'
- a failure after a newer success sets offline and replaces the 1.5 s poll with a 10 s retry
- reportError on every failure: engine.errors grows every 10 s while the server is down
- no stop/dispose (left as is)

**Design:** Engine side (the same change planner-engine's 'Scene and room list caches' fix needs for every fire-and-forget list refresh, so it lands once, in whichever package gets there first, and the stores package depends on it): listScenesInternal takes `const n = ++scenesAsked` before the fetch; on answer it overwrites scenesList/scenesTrash and emits 'scenes' only when `sceneLogic.freshAnswer(n, scenesShown)` (n > scenesShown), then scenesShown = n; a stale answer returns the current scenesList without emitting. listScenesInternal takes `{ report?: boolean }` (default true; every engine-internal caller keeps reporting). Store side (data.ts): an `answers` counter bumped by each 'scenes' event; refresh() remembers `asked = answers` and on failure only goes offline and switches to the 10 s retry when `answers === asked` (no fresher answer arrived meanwhile); it passes `{ report: !state.offline }` so only the first failure of an outage reaches the toast and engine.errors. Delay choice is pure `sceneLogic.pollDelay(busy, offline)` -> 1500 | 10000 | null in planner/logic/scenes.ts. No dispose: the store lives for the page.

**Proof:** planner/test/stores.test.mjs (node:test; esbuild-bundles planner/data.ts with './engine.js' aliased by a plugin to a stub exporting RequestError/quiet/withMidstudy, and a fake engine whose listScenesInternal returns controllable deferreds and emits 'scenes'): a failure after a newer success leaves offline false and the 1.5 s timer in place (node:test mock.timers); five failures in a row call listScenesInternal with report:false after the first. freshAnswer/pollDelay pure cases (n <= shown -> false). The engine-side stale drop is proven by the scenes 'ready' case in planner-core's calibration-shadow test plus eval:planner. Gates: check:types, check:lint, check:tscert, check:tests; evals eval:planner, eval:ux (Scenes page uploads), eval:room-planner, all through the eval lock.

#### Library jobs: per-job status mirror and the jobs poll loop

**guard-only**, effort M · `planner/data.ts`, `planner/logic/library.ts`, `planner/logic/messages.ts`, `planner/test/stores.test.mjs`, `tscert/baseline.json`, `docs/notes/app.md`

Closes:
- overlapping jobs() answers apply out of order: rewind then duplicate 'job-done' + reloadLibrary
- an in-flight answer from before an add's POST erases the tracked job and stops polling
- no backoff and a reported error every 1.5 s while the server is unreachable
- a busy job dropped by the server (restart) disappears with no terminal event and no spend/library refresh
- jobChange emits done->failed / failed->done without a busy 'before'

**Design:** In createLibrary: counters `asked`/`applied`; jobs() takes `const n = ++asked`, and an answer with n <= applied is dropped (no setJobs, no emit), else applied = n. track(job) records `trackedAt.set(job.id, asked)`; the merge keeps a tracked job absent from `next` while n <= trackedAt (that request may have been served before the server added the job) and drops the trackedAt entry once an answer with n > trackedAt arrives. The server's JobStore keeps every job until a restart (server/src/jobs.ts: 'forgotten by a restart'), so a job busy in `status` and absent from an answer with n > trackedAt is lost: emit 'job-failed' with `{ ...job, status: 'failed', message: msg.jobLostText }` (the panel reads j.message, planner/ui/panels/library.ts:206; the earlier draft's `error` field would have shown nothing), quiet(reload()), quiet(spend()) (the reservation the server reconciles on its side shows up in spend), and delete its status entry. Backoff: a consecutive-failure counter; the delay is pure `libLogic.jobsPollMs(failures)` (1500, then 10000 after 3 failures), and the poll keeps running after a failure while the last known jobs are busy; only the first failure of a run is reported, later ones throw an unreported RequestError. jobChange requires a busy 'before' (`if (!jobBusy(before) || before === now) return null`); no v1-differential test covers jobChange (grep of engine.test.mjs and ui/test), note the narrowing in docs/notes/app.md. Pure merge in planner/logic/library.ts: `mergeJobs(next, n, tracked: {id, at}[], busyIds): { keep: ids, lost: ids }` for TScert.

**Proof:** planner/test/stores.test.mjs with a stubbed fetch returning deferreds: (1) start jobs() A, addFromUrl (track job X), resolve A without X: before the fix X vanishes and no timer is set; after, X stays and polling continues. (2) answers B(done) then late A(running) then C(done): exactly one 'job-done' and one reloadLibrary. (3) busy job missing from a fresh answer -> one 'job-failed' whose job.message is jobLostText, plus a GET /api/spend. (4) fetch rejecting 5 times -> one reported error, delay 10 s from the fourth (mock.timers). Pure mergeJobs/jobsPollMs/jobChange cases. Gates: check:types, check:lint, check:tscert, check:tests; evals eval:library, eval:ux2, eval:product-ui (Add flows), eval:ui-smoke, through the eval lock.

#### Library API availability (tri-state api: null | true | false)

**guard-only**, effort S · `planner/data.ts`, `planner/test/stores.test.mjs`

Closes:
- transient error at start leaves api null and nothing retries: jobs and spend stay empty
- 404/405/501 after a remove/restore flips a present API to false mid-session

**Design:** start(): when refreshTrash leaves api null (network error or another status), retry start() after 10 s, at most 5 times (the timer is not set once api is decided). refreshTrash sets api false only while api is null (the first decisive probe); once true it stays true and a later 404 is just reported by the calling action. 'unknown' and 'probe failed' sharing null is kept: the retry makes it transient.

**Proof:** planner/test/stores.test.mjs with mock.timers: the first GET /api/library rejects (offline), the second answers 200 -> after the fix jobs() and spend() are fetched; before, never. A 404 from refreshTrash after api true leaves getState().api true. Gates: check:types, check:lint, check:tests; eval:library, eval:ui-smoke (Recently removed), through the eval lock.

#### Scene photo upload request lifecycle

**guard-only**, effort S · `planner/data.ts`, `planner/test/stores.test.mjs`

Closes:
- no onabort/ontimeout: an aborted XHR never settles, caller progress hangs
- 202 seed after a concurrent poll (handled with the calibration shadow fix)

**Design:** Add one xhr.onabort handler that rejects with engine.reportError("Couldn't upload the photo: the upload stopped") (inline, as the neighbouring onerror text is). No ontimeout: no xhr.timeout is set (a large photo on a slow link must not be cut off), so 'timeout' cannot fire and a handler would be dead code. Today nothing calls xhr.abort(), so this is a one-line guard for a future cancel, not a live hang; a user-facing cancel handle stays deferred (no UI asks for it, and the server would still need to drop a half-made scene).

**Proof:** planner/test/stores.test.mjs: a fake XMLHttpRequest whose send() fires onabort -> before the fix the promise is still pending after a tick (Promise.race against a resolved sentinel); after, it rejects with the message and engine.errors gains it. Gates: check:types, check:lint, check:tests; eval:ux.

#### Keyboard dispatch and modal key routing (filter, typing, Esc priority chain, snap)

**defer**, effort S

Closes:
- mode precedence encoded twice (priorities across modules and when() guards); a clashing new binding silently changes the winner

**Design:** No change now. If it bites: keymap.register warns (console + engine.errors in dev) when two commands share a combo and priority, so ties stop resolving silently by registration order.

**Proof:** n/a (eval:keys already pins today's Esc chain)

**Why:** No live defect: the verifier dropped every concrete risk; the remaining one is a maintenance hazard for future bindings, covered by eval:keys for current behaviour.

#### Lighting mode (default vs photo) and environment-map source with derived SH caches

**defer**, effort S

Closes:
- shEnv lingers after photoEnv takes over; photoEnv not disposed going back to default
- cache validity relies on each setter invalidating by hand
- photo-mode environment correct only because every furniture render goes through fitShadow -> syncEnv

**Design:** No change now. When lighting.ts is next touched: one `invalidate()` used by setData/setCamera, and dispose shEnv after the first successful photoEnv bake.

**Proof:** n/a (eval:lighting E16 covers today's output)

**Why:** The verifier rejected the concrete render-path risks; what remains is coupling and a small GPU-memory leftover per scene, not a wrong image, in a personal-use app.

#### Server status vocabularies read as opaque strings

**defer**, effort S

Closes:
- malformed status dropped to null reads as not busy / 'failed'
- lightingStatusOf invents 'done'/'missing' when the server gives none

**Design:** No change now. Optional later: type the wire statuses as the contract/gen literal unions in planner/wire.ts so the helpers' comparisons are checked by tsc.

**Proof:** n/a (strict-mode evals check every server answer against the closed enums)

**Why:** The contract closes every enum and the server is schema-checked in strict mode, so a malformed status is theoretical; the invented lighting status is v1's behaviour.

#### Floor shadow switch, catcher visibility and the mask / diffuse-IBL overrides

**wont-fix**, effort S

Closes:
- catcher state depends on every furniture frame calling fitShadow first
- iblDiffuse is module-global while one lighting instance exists

**Design:** None.

**Proof:** n/a (eval:lighting, eval:render cover it)

**Why:** Both are invariants that hold today (drawTo always calls fitShadow; one createLighting instance); the verifier found no failing path.

#### Look: Auto lighting vs Manual (frozen) lighting, with tri-state cast_shadows

**wont-fix**, effort S

Closes:
- Auto keeps stale manual numbers in memory; an ignored-field patch PUTs an unchanged Look
- cast_shadows null turns the floor shadow on when the lighting backfill lands

**Design:** None.

**Proof:** n/a

**Why:** The spurious save is benign (same bytes), and the shadow following lighting.json is the contract's cast_shadows null semantics (v1 behaviour, §0).

<details><summary>Reviewer’s changes</summary>

- Coverage: all 13 '### ' machines in ## planner-core have exactly one entry; none missing.
- Gesture: removed the beginRotateDrag edit in engine.ts. planner-engine's 'Selection and pointer drag' machine owns 'begin* overwrites an active drag' (risk 1) and may fix it as end-then-start rather than refuse; two groups editing the same function with different rules would conflict. The drag token in input.ts closes the canvas side either way. Also added the missing grip-first order: a canvas press while the grip holds a rotate called beginItemDrag and silently replaced the rotate (no 'drag' end); input.ts now does not begin a drag while getDrag() is set.
- Gesture: the residual pan cannot reuse pans() (it requires !multi, and multi must stay true to block taps), so the design states the residualPans branch explicitly. Flagged it as a v1 narrowing to record in docs/notes/app.md. The scene token does not tell apart a reopen of the same scene name; accepted.
- Startup: the original design missed that the engine already has window 'error'/'unhandledrejection' listeners (engine.ts ~291) that push into the engine's private array. After the arrays are shared, a second push from ready.ts would duplicate the line, so ready.ts now pushes only when nothing was reported. Dropped 'unhandledrejection' as a settle trigger: a stray async rejection during a normal startup would resolve ready before the first page state and make every eval that awaits ready flaky. Added a browser repro (WebGPU and WebGL disabled through addScriptToEvaluateOnNewDocument), because the node test only shows ready.ts reacting to a synthetic event, not that Chrome raises one for a rejected top-level await. Also gave a fallback (dynamic import in main.ts) in case it does not.
- Calibration shadow: the proposed guard (seed 'pending' only when !seen.has) brings in a regression. When a poll's first sight of a new scene is already 'done', no 'ready' would ever fire. Replaced it with an `announced` set and an onload catch-up. Simplified the pruning: entries that are not busy are pruned, and the 'seeded' set is dropped.
- Library jobs: the lost-job event used `error:`, but the panel shows `j.message` (planner/ui/panels/library.ts:206); corrected to message. Confirmed that the server keeps jobs until a restart (server/src/jobs.ts), so a busy job missing from a fresh answer really is lost. The poll now keeps running after a failure while jobs are busy; without that, the backoff never ran.
- Upload: dropped ontimeout (xhr.timeout is never set, so it cannot fire) and the messages.ts move (the neighbouring onerror text is inline). The hang the report claims cannot happen today: nothing calls xhr.abort(). It stays a one-line guard, S.
- Selection: the same line is planner-engine's 'Selection and pointer drag' risk 4. It is done once in that package and only verified here, so planner-core never edits removeItemInternal.
- Scenes store: the engine-side sequencing of listScenesInternal is the same change planner-engine's 'Scene and room list caches' machine needs for its fire-and-forget refreshes. It should land once, using the shared freshAnswer helper. planner-core-stores depends on that package, and edits listScenesInternal itself only if that package left it alone.
- Packages: engine.ts appeared in all three planner-core packages, so the files were not disjoint. They are now serialized: stores, then startup, then gesture. Gesture no longer edits engine.ts at all. 'planner-engine-*' was not a valid id. 'planner-engine-list-caches' and 'planner-engine-selection-drag' are placeholders: the merger should map them to the real planner-engine package ids for the machines 'Scene and room list caches (scenesList/scenesTrash, roomsList/roomsTrash)' and 'Selection and pointer drag (move/lift/rotate)'.
- Ownership: every file is in the app track (planner/, docs/notes/app.md) or shared-append (package.json, tscert/baseline.json). No toolchain file (scripts/check.mjs) and no contract changes. knip's entry list does not include planner/test/*.mjs, so new exports must be used by planner code (they are), not only by tests.
- Proofs: all are $0 (no fal involved). Browser cases run through `nix develop -c node scripts/eval-lock.mjs -- npm run eval:ui-smoke`, and each repro must be seen failing on the unfixed tree first. The kept defer and wont-fix decisions (keyboard, lighting, shadow, Look, status vocabularies) involve no data loss, money or hang, so none is upgraded.

</details>

### planner-ui (app)

Shared in this group:
- planner/ui/epoch.ts (package planner-ui-shell): `uiEpoch(engine): { now(): number; items(): number; on(kind, fn) }`. now() bumps on engine 'scene' phases loading/opened/closed/failed, so every change of the shown photo counts, room photo switches included. Use it for photo-scoped actions: renders run/openConfirm, Looks right, layouts save, scene panel, scenes open/upload. items() bumps only on 'scene' loading/closed, so it does not move on a room photo switch, which emits no 'loading' (engine.ts openSceneAs) and keeps the pieces (§4.9). Use it for piece-scoped actions: the workspace Undo/⌘Z and the Library add Undo. Every async UI action captures one of them before its await and acts or toasts afterwards only if it is unchanged. planner/engine.ts is not touched: planner-engine's sceneToken stays private.
- A local in-flight latch against double submit: `let busy = false; if (busy) return; busy = true; try { await … } finally { busy = false }`, with the button disabled from it. Used by settings save, Rename scene/room, Align again, Looks right/Set scale (one shared floorBusy) and makeRoom. Kept inline (3 lines), not a helper module, so knip and TScert see nothing new.
- Close your own sheet handle, never the module-level variable: `const mine = openSheet(...)`, then `mine.close()` (Sheet.close is already a no-op for a stale handle). sheet.ts gains `isSheetOpen()` (added in planner-ui-shell), so an async open() never closes a sheet that appeared during its await (Export, Settings).
- shell.pushLayer(kind, cancel) / shell.topLayer() plus the pure escTarget(kinds, inField) in planner/ui/logic/layers.ts: the single overlay stack (confirm, menu, page, sheet, renders modal). A handled Esc is recorded in a WeakSet that the engine's key filter honours first. The other key filters run before the 'any layer open' check, so the renders arrows and the shortcuts toggle keep working, and a filter that acts on keys checks topLayer().
- Toast `onGone` in shell.ts and the closed-toast action guard: owners that key behaviour off a toast learn when it is gone, and an action runs at most once.
- Tests: node:test files planner/ui/test/machines-<pkg>.test.mjs bundle the planner/ui/logic modules with esbuild, as logic-vs-v1.mjs does (no wasm). planner-ui-shell adds the one package.json script `test:ui-machines` (`node --test planner/ui/test/machines-*.test.mjs`), which check:tests discovers because it is not in PLANNER_SUITES. Other packages only add files the glob matches. Browser checks: planner-ui-shell turns smoke.mjs into a runner that imports every planner/ui/test/sections/*.mjs (`export async function run(ctx)`, with ctx carrying the page, the harness's api, seedScene and a seeded golden room). Each package then owns one section file and the packages stay file-disjoint. Waiting states come from page.setRequestInterception (hold, abort or answer 500 on a route); fal stays mocked and nothing in evals/ (evals track) is edited. New pure functions are appended to tscert/baseline.json (shared-append) with `node scripts/tscert-ratchet.mjs --update`.

Packages: `planner-ui-shell`, `planner-ui-workspace`, `planner-ui-renders`, `planner-ui-room`, `planner-ui-scenes`, `planner-ui-sheets`, `planner-ui-panels`

#### Product page read (Add furniture › Product page)

**fix**, effort S · `planner/ui/panels/productsrc.ts`, `planner/ui/test/sections/sheets.mjs`

Closes:
- a paste while a read runs is lost and the placeholder stays 'reading it…'
- the seq stale guard never fires (dead code)
- copyBookmarklet's reset timer isn't cancelled on a second click

**Design:** productsrc.ts: takePasted(t) returns first thing when st.busy, without clearing the box or changing the placeholder. The pasted page stays in the box, and a status line says 'Still reading the last one; paste again in a moment'. read()'s own `if (st.busy) return` is then never reached from a paste, so the placeholder is always reset by read()'s existing finally. `seq` comes out of ReadState and its three checks, since reads are serialized by busy and close is handled by st.active. copyBookmarklet keeps its timer handle and clears it before setting a new one.

**Proof:** Browser section: start a read with POST /api/library/product held by interception, then paste a page into the box: the box still holds it and the busy note shows. After release, the placeholder reads 'Paste the copied page here'. Gates: check:types, check:lint, check:dead; eval:product-ui (E14 form) unchanged.

#### Desktop tooltip hover machine

**fix**, effort S · `planner/ui/shell.ts`, `planner/ui/test/sections/shell.mjs`

Closes:
- the timer callback doesn't recheck mode, so a desktop tip can show after switching to phone

**Design:** shell.ts: the tip timer callback also returns when mode !== 'desktop', and applyMode calls hideTip() on every mode change.

**Proof:** Browser section (app-owned; evals/phone.mjs belongs to the evals track and is not touched): hover a [data-tip] button, resize to 375 within 450 ms, wait 600 ms: no .tooltip in the layer. Gates: check:types, check:lint; eval:phone (E9) unchanged.

#### Overlay layers and key routing (shell modals, page, sheet.ts singleton, renders modal)

**make-explicit**, effort M · `planner/ui/shell.ts`, `planner/ui/sheet.ts`, `planner/ui/logic/layers.ts`, `planner/ui/test/machines-shell.test.mjs`, `planner/ui/test/sections/shell.mjs`

Closes:
- Esc falls through layers: closes the page or a confirm and then also deselects or leaves Adjust floor/ruler, or closes the sheet/modal underneath
- with a sheet over the Scenes page one Esc closes both
- keyFilters.some stops at the first true, so with the renders modal and a sheet open Esc closes the wrong one
- a mode change leaves shell menus/confirms in their old-mode layout
- addKeyFilter's remover splices index -1 when called twice

**Design:** One layer stack in shell.ts in place of four stores. A guard alone cannot tell whether the sheet or the renders modal is on top, so this is the one make-explicit in the group. `layers: Layer[]` with `Layer = { kind: 'confirm'|'menu'|'page'|'sheet'|'modal', cancel(): void }`, innermost last. Public `shell.pushLayer(kind, cancel)` returns an idempotent `{ remove() }`, and `shell.topLayer(): kind | null`. pushModal (confirm/menu) and openPage/closePage go through it. sheet.ts openSheet pushes a 'sheet' layer and removes it in close(). renders.ts openModal does the same with a 'modal' layer (package planner-ui-renders). The Esc capture listener asks the pure `escTarget(kinds, inField)` (new planner/ui/logic/layers.ts, TScert) for the index of the one layer to cancel, keeping today's rule: Esc in an input closes a sheet, modal, confirm or menu but not the page. It cancels only that layer and records the event in a WeakSet `escDone`. The engine's key filter becomes `(e) => escDone.has(e) || keyFilters.some((f) => f(e)) || layers.length > 0`. The filters run before the layer check so the renders arrows and the shortcuts toggle still work: with `layers.length > 0` first they would never run. A handled Esc never reaches the keymap (select.none, adjust.leave, ruler.leave) or a lower layer. sheet.ts and renders.ts drop their Esc branches. renders' filter steps on the arrows only when `shell.topLayer() === 'modal'`, so filter order no longer matters. On 'mode' the shell cancels 'menu' and 'confirm' layers before emitting; a confirm resolves to its cancel value, the safe answer. addKeyFilter's remover checks `i >= 0`. v1 note: v1 let Esc fall through the same way. That fall-through is the risk, so this deliberately changes v1 behaviour (docs/notes/app.md).

**Proof:** node:test: escTarget(['page'], false)=0; (['page'], true)=null; (['page','sheet'], true)=1; (['sheet','confirm'], false)=1; ([], false)=null. Browser section: select a piece, open the Scenes page, Esc: the page closes and getSelection() still has the piece. Open Rename over the page, Esc: only the sheet closes. Confirm over a sheet, Esc: the sheet stays. With Adjust floor on and a confirm, Esc: Adjust floor stays on. Renders viewer open: ArrowRight still steps. Gates: check:types, check:lint, check:dead, check:tscert, check:tests, check:planner (bus); eval:keys (E17 keys), eval:ux, eval:phone.

#### Workspace remove / Undo (⌘Z) slot

**guard-only**, effort S · `planner/ui/workspace.ts`, `planner/ui/panels/inroom.ts`, `planner/ui/seam.ts`, `planner/ui/logic/workspace.ts`, `planner/ui/test/machines-workspace.test.mjs`, `planner/ui/test/sections/workspace.mjs`

Closes:
- lastRemoved survives scene open/close, so ⌘Z restores old pieces into another scene
- two Undo channels: In the scene's Remove is not in lastRemoved, so ⌘Z restores an older removal
- double restore through the 200 ms leaving window of the toast ⌘Z just closed

**Design:** Keep the shape (one nullable slot). Add a scope and a one-shot latch. (1) lastRemoved gains `ep: number` from the shared epoch helper's `items()` counter (planner/ui/epoch.ts, package planner-ui-shell). That counter bumps on engine 'scene' phases 'loading' and 'closed' only. The engine emits 'loading' for every real open but not for a photo switch inside a room (engine.ts openSceneAs: `if (!switching)`). That is right here: a room keeps its pieces across photos (contract §4.9), so ⌘Z after a photo switch still restores into the same room layout. edit.undo's `when` becomes `() => undoUsable(lastRemoved, epoch.items())`. An items() listener also sets lastRemoved=null. Undo after the toast expired stays allowed in the same scene: v1 did this and it is harmless. (2) The undo closure gets `let done = false; if (done) return; done = true` before restoreItem(s), so the toast's Undo and ⌘Z can restore only once. The shell's toast also ignores action clicks once the toast is closed (see Toast queue). (3) One channel: WorkspaceApi (planner/ui/seam.ts) gains `removeWithUndo(uids: readonly string[])`, which is removeSelected generalised (removeSelected becomes removeWithUndo(engine.getSelection())). inroom.ts remove(uid) calls `ctx.workspace?.removeWithUndo([uid])` and keeps its current toast only as the fallback when ctx.workspace is unset. So ⌘Z after an In the scene removal restores that piece. Pure part in planner/ui/logic/workspace.ts: `undoUsable(slot: { readonly ep: number } | null, now: number): boolean` (TScert).

**Proof:** node:test machines-workspace.test.mjs: undoUsable(null, 1) is false, a slot from ep 1 at 2 is false, and the same ep is true. Browser section (sections/workspace.mjs, run by eval:ui-smoke through the eval lock): (a) Del a piece, open a second scene, ⌘Z: getItems() length is unchanged. (b) Remove from In the scene, then ⌘Z: that uid is back, not an older removal. (c) ⌘Z, then a click on the leaving toast's .toast-action within 200 ms: one copy (getItems length +1). (d) In the golden room: Del a piece, switch photo, ⌘Z: the piece is back. Gates: check:types, check:lint, check:tscert, check:tests, check:planner; eval:ux and eval:keys still pass (Del + Ctrl+Z).

#### Height +/− hold-to-repeat timer

**guard-only**, effort S · `planner/ui/workspace.ts`, `planner/ui/test/sections/workspace.mjs`

Closes:
- a button detached while held never gets pointerup, so the repeat chain never stops and nudges whatever is selected later
- pressed stays true after pointerdown+pointerleave without a click, so the next keyboard click is swallowed

**Design:** In holdBtn (workspace.ts): record `uid0 = selUid()` at pointerdown and keep a `down` flag. go() stops (clearTimeout, t=undefined) unless `btn.isConnected && selUid() === uid0`. The repeat calls engine.nudgeElevation(uid0, …) directly, never the live selection. onpointerup: `down = false; stop()`, and pressed is kept so the click that follows is still swallowed. onpointerleave and onpointercancel: `stop(); if (down) pressed = false; down = false`. pressed is cleared only when the pointer leaves while still down. On touch, pointerleave fires after pointerup and before click, so clearing pressed unconditionally there would nudge twice on every phone tap. buildSelBar, buildLift and sync's lift.replaceChildren() need no change: the tick's own isConnected check ends the chain within one repeat delay. No new pure function.

**Proof:** Browser section, desktop and phone (375 px, touch taps): (a) pointerdown on [data-midstudy=elev-up], no pointerup, engine.select of another piece (rebuilds the bar), wait 1.5 s: the second piece's elevation is unchanged and the first stopped growing. (b) Phone: one tap on '+' raises the elevation by exactly one step, not two. (c) Desktop: pointerdown, then pointerleave, then a keyboard Enter on '+' nudges once. Gates: check:types, check:lint; eval:phone (E9) and eval:ux2 still pass.

#### Shell panel / phone sheet open-detent-collapsed machine

**guard-only**, effort M · `planner/ui/shell.ts`, `planner/ui/logic/chrome.ts`, `planner/ui/test/machines-shell.test.mjs`, `planner/ui/test/sections/shell.mjs`

Closes:
- setDetent with the sheet closed sets detent=peek on a hidden sheet (library add / job-done Place)
- an in-flight sheet drag survives closePanel and reopens a half state on pointerup
- rehost on a mode change skips onOpen/onClose and the 'panel' event
- library add() after its await drops another panel the user opened to peek (closed by the Library panel fix, which owns library.ts)

**Design:** shell.ts: (1) Split setDetent. The public setDetent (ShellApi) acts only while the sheet is open: `if (!detentAllowed(mode, openId, detent) || !isDetent(d)) return`. openPanel, which runs while detent is still null, calls the internal `applyDetent(d, silent)` with today's body. (2) closePanel sets `drag = null` and removes .is-dragging, so a late pointerup finds no drag. onUp also returns when detent === null. (3) rehost(prev) records `wasOpen = getOpenPanel()` before the mode switch and `nowOpen` after it. If they differ it calls the spec's onClose/onOpen and emits 'panel' {id, open, detent}, so workspace, room, library and scene see the change. inroom.ts select() needs no change: it runs from a row in its own open panel. Pure: planner/ui/logic/chrome.ts `detentAllowed(mode, openId, detent)` (TScert).

**Proof:** node:test machines-shell.test.mjs: detentAllowed('phone','library',null) is false, ('phone','library','half') is true and ('desktop','library','half') is false. Browser section, phone 375 px: Place a piece from the Library while its GLB/splat GET is held (page.setRequestInterception), close the sheet, release: data-sheet stays '' and #sheet has no is-open. Resize from 1440 to 375 with the Scene panel open: a recorded 'panel' event with open:false arrives. Gates: check:types, check:lint, check:tscert, check:tests; eval:phone (E9), eval:ux, eval:ux2.

#### Render in-flight tracking: workspace chip and the Renders panel's pending list

**guard-only**, effort M · `planner/ui/workspace.ts`, `planner/ui/logic/workspace.ts`, `planner/ui/panels/renders.ts`, `planner/ui/logic/renders.ts`, `planner/ui/test/machines-workspace.test.mjs`, `planner/ui/test/machines-renders.test.mjs`, `planner/ui/test/sections/workspace.mjs`, `planner/ui/test/sections/renders.mjs`

Closes:
- the workspace chip has one slot: with two renders the first to end hides the chip and a second start resets t0
- two views of one lifecycle with no shared id
- a scene change clears pending but run() still finishes: a stale not-aligned toast, and a failure that is never shown
- (cross-area render request) a dropped request can still finish on the server and bill while the planner shows failed

**Design:** Two parts in two packages. (A) Workspace chip (planner-ui-workspace, workspace.ts): `rendering` becomes `{ n: number, t0: number } | null`, driven by pure transitions in planner/ui/logic/workspace.ts: `renderStarted(slot, now)` adds 1 and keeps the earliest t0, and `renderEnded(slot)` subtracts 1 and gives null at 0 (TScert). The engine emits exactly one 'done' or 'failed' per 'start' (engine.ts postRender), so the count stays balanced. The interval runs while the slot is non-null. (B) Renders panel (planner-ui-renders, renders.ts): run() captures `ep = epoch.now()`. When it settles after the epoch moved, it leaves `pending` and the modal alone. A failure then shows as one toast 'A render of <old scene title> failed'; a success shows nothing. Cross-area mitigation, without a server job and without guessing: a failed row whose failureReason is "the server isn't answering" triggers one engine.listRendersInternal() after 60 s, if the epoch is unchanged, so a render the server finished anyway appears in the list. Its Retry confirm says the first one may have finished (check the list above) before paying again. Rows are never auto-dropped: matching 'a newer render appeared' to this request is a guess. The real fix (a render job id and status route) belongs to server-domain. The shared id between the two views is not needed once both count correctly.

**Proof:** node:test machines-workspace.test.mjs: start, start, end gives n=1 with the first t0; another end gives null; end on null stays null. Browser sections (eval:ui-smoke through the lock; the POST /api/render answer is held with page.setRequestInterception, fal mocked): (a) two renders started back to back: .ws-chip stays until the second ends. (b) Start a render, open another scene, release: no 'align-' toast and no failed row in the new scene. (c) Abort the held render request (request.abort): the row reads failed, and 60 s later (fake timers, or a shortened constant in test mode) a GET renders is issued. Gates: check:types, check:lint, check:tscert, check:tests; eval:render (E6) unchanged.

#### Renders modal (confirm / viewer / compare) and Compare picking

**guard-only**, effort S · `planner/ui/panels/renders.ts`, `planner/ui/logic/renders.ts`, `planner/ui/test/machines-renders.test.mjs`, `planner/ui/test/sections/renders.mjs`

Closes:
- the viewer keeps a numeric idx, so a 'renders' event while open jumps to a different render
- openConfirm awaits the capture with no scene recheck: the old scene's picture opens over the new scene, and submit renders the new scene
- picking holds names across 'renders' events; a deleted render leaves a stale name and Compare errors

**Design:** renders.ts: (1) The viewer's state is `name`, the shown render's name. Each build computes `idx = viewerIndex(names, name, idx)`: the index of name, else the old index clamped, else 0. It is a new pure function in planner/ui/logic/renders.ts (TScert). step() sets name from stepIndex's result, and m.step does the same. (2) openConfirm captures `ep = epoch.now()` before captureComposite or imageShot and returns without opening if the epoch moved. The same check runs after the past-picture load, before m.rerender(). (3) On 'renders', `picking = prunePicks(picking, names)` (pure, keeps existing names only, TScert) before render(). (4) openModal pushes a 'modal' layer through shell.pushLayer and removes it in close(); this belongs to the overlay machine. The filter keeps only the arrow keys, gated on shell.topLayer() === 'modal'.

**Proof:** node:test: viewerIndex(['c','b','a'], 'b', 0)=1; with ['d','c','b','a'] it is 2; a removed name clamps the old index; an empty list gives 0. prunePicks(['x','b'], ['b'])=['b'] and prunePicks(null, x)=null. Browser section: open the viewer on the oldest render, finish another mock render: the viewer shows the same name (its img src). Render…, then switch scene while the capture runs (hold the photo GET): no .rn-modal.is-confirm opens. Gates: check:types, check:lint, check:tscert, check:tests; eval:render (E6).

#### Floor plan pointer gestures (pan / pinch / photo / handle / item / turn)

**guard-only**, effort S · `planner/ui/room.ts`, `planner/ui/logic/rooms.ts`, `planner/ui/test/machines-room.test.mjs`, `planner/ui/test/rooms-ui.mjs`

Closes:
- a second finger during a photo/handle drag leaves the previewed pose unsaved (shown and saved poses disagree)
- a third pointer starts a new drag while pinch is set: a mixed pinch+drag
- Align photos turned off mid-drag still commits the pose

**Design:** room.ts: the 'handle' Drag variant also stores pose0, the member's pose at pointerdown; a handle exists only on a placed photo. A pointerdown that makes pointers.size === 2 reverts first: a photo or handle drag calls engine.previewPose(d.scene, d.pose0), then pinch starts. A pointerdown with pointers.size > 2, or with pinch set, only records the pointer and starts no drag. end(): a moved photo or handle drag commits (setPose) only if engine.getRoomState()?.alignPhotos is still on; otherwise it reverts with previewPose(scene, pose0). Pure decisions in planner/ui/logic/rooms.ts: `planDown(pointers: number, pinching: boolean): 'pinch'|'ignore'|'start'` and `planEnd(kind, moved, alignOn): 'commit'|'revert'|'tap'|'none'` (TScert). room.ts switches on them. They stay out of planner/logic/room.ts, which proofs/diff/room/ pins against Lean.

**Proof:** node:test machines-room.test.mjs: planDown(1,false)='start', (2,false)='pinch', (3,true)='ignore', (1,true)='ignore'; planEnd('photo', true, false)='revert', ('photo', true, true)='commit', ('pan', false, x)='tap', ('item', true, x)='none'. rooms-ui.mjs, through the eval lock: drag a photo with Align photos on, turn Align photos off through the hook before mouseup: the member's saved pose (GET /api/rooms/<room>) is unchanged and getRoomState() shows pose0 again. The existing Align photos drag and Reset checks keep passing. Gates: check:types, check:lint, check:tscert, check:tests; eval:room-planner (E19).

#### Floor plan shown/visible, Align photos selection and photo switching

**guard-only**, effort S · `planner/ui/room.ts`, `planner/ui/logic/rooms.ts`, `planner/ui/test/machines-room.test.mjs`, `planner/ui/test/rooms-ui.mjs`

Closes:
- a stale alignSel (Align photos off, member removed) empties the label, disables Reset and makes a tap place nothing
- switchTo awaits a confirm and then switches with a scene of an old room
- Align again has no in-flight guard: a double click sends two alignRoom calls
- two sources of truth for floorPlan (local shown vs roomState.floorPlan)

**Design:** room.ts: (1) A pure `alignTarget(alignSel, memberScenes, photo)` in planner/ui/logic/rooms.ts works out the target (TScert). It returns alignSel only when that names a current member, else the current photo. Every `alignSel ?? currentScene()` / `alignSel ?? st.photo` use (wedges, onTop, isSel, the tap, syncAlign, reset) goes through it, and syncAlign sets alignSel=null when alignPhotos is off. (2) switchTo captures `room = st.name` before the confirm. Afterwards it switches only if `engine.getRoomState()?.name === room`, the scene is still a member, and it is not already the current photo. (3) alignAgain gets a local `aligning` latch, set before the await and cleared in finally; syncAlign sets `againBtn.disabled ||= aligning`. (4) wont-fix: the two floorPlan values are intended. The UI is the only writer and the engine's flag mirrors it for the hook. Noted in docs/notes/app.md.

**Proof:** node:test: alignTarget('gone', ['room-1','room-2'], 'room-1')='room-1'; alignTarget('room-2', ['room-1','room-2'], 'room-1')='room-2'; alignTarget(null, [...], null)=null. rooms-ui.mjs: grab photo 2 in Align photos, remove it from the room, turn Align photos on again: the label names the current photo and Reset follows its pose_source. Double-click Align again: one POST align (counted with page.on('request')). Gates: check:types, check:lint, check:tscert, check:tests; eval:room-planner.

**Why:** Point 4 (two floorPlan values) is wont-fix: it is a one-way mirror with a single writer.

#### Scenes page uploads, New room pipeline and room-list polling

**guard-only**, effort M · `planner/ui/scenes.ts`, `planner/ui/logic/scenes.ts`, `planner/ui/test/machines-scenes.test.mjs`, `planner/ui/test/sections/scenes.mjs`

Closes:
- one uploading slot: two uploads overwrite each other's progress, the card vanishes and comes back named '', and both open their scene
- makeRoom failing part-way leaves loose scenes and says nothing; two makeRoom runs share roomMaking
- the room poll chain stops on its first failed listRoomsInternal
- upload/open/openRoom act after a confirm on state that may have changed
- (cross-area New room saga) no compensation step after a partial failure

**Design:** scenes.ts: (1) `uploads: Map<number, Uploading>` keyed by a local counter, one card per entry (renderUpload maps them). An `openTicket` counter means only the upload started last opens its scene; earlier ones just finish, and their 'ready' toast offers Open as usual. (2) makeRoom refuses while roomMaking is set (toast 'A room is already being made'). On failure it toasts which step failed and branches on how far it got. If the upload or room create failed and names.length > 0, the toast action 'Make the room from N photos' runs createRoomFromScenes(names, title) and then align, with no re-upload. If the room was created and only align failed, the toast says the room was made and its action runs engine.alignRoom(info.name); it never creates a second room. Nothing is deleted (scenes are user data). roomTitle is kept on failure for that retry and cleared on success. (3) On error the poll reschedules with `nextPollMs(failures)` while the page is open: 1.5 s, doubling to 30 s, pure in planner/ui/logic/scenes.ts (this package's own logic file, not rooms.ts, which planner-ui-room edits; TScert). It resets after a success. (4) open/openRoom capture `ep = epoch.now()` before the confirm and return without acting if the epoch moved meanwhile; the user clicks again (no re-ask loop). upload proceeds after a moved epoch, since the user asked for the new scene, but does not auto-open it: its 'ready' toast offers Open.

**Proof:** node:test machines-scenes.test.mjs: nextPollMs(0)=1500, (1)=3000, (10)=30000. Browser section: two uploads at once (file input and a drop event, the first POST held by interception) give two .is-uploading cards, and the opened scene is the second. New room with the room create POST answered 500 by interception: an error toast with 'Make the room from 2 photos', which resumes to a room card. With only the align POST failing: the toast offers align, and GET /api/rooms lists one room, not two. Gates: check:types, check:lint, check:tscert, check:tests; eval:room-planner, eval:planner (E3).

#### Export sheet open/run lifecycle

**guard-only**, effort S · `planner/ui/export.ts`, `planner/ui/test/sections/sheets.mjs`

Closes:
- the in-flight run closes the module-level sheet, so a reopened second Export sheet closes when the first finishes
- close during busy and reopen: two exports at once
- while capturing, another sheet opens and Export's openSheet closes it silently

**Design:** export.ts: run() closes its own handle (`const mine = openSheet(...)`, then `mine.close()`). Sheet.close is already a no-op for a stale handle. A module-level `exporting: Promise<void> | null` replaces the per-open busy. open() shows the sheet with Save/Share disabled ('Saving…') while it is set and re-syncs when it settles, and run() returns at once while it is set. After the capture await, open() returns if `isSheetOpen()` is true, so it never closes another sheet. isSheetOpen is a new export from sheet.ts (`current !== null`), added in planner-ui-shell, which owns sheet.ts.

**Proof:** Browser section: ⌘E, Save, Esc, ⌘E again before the encode ends (hold it by stubbing the download in page.evaluate, or run on a large size): the second sheet is still open after the first export's 'Saved' toast, and its Save is disabled until then. Open Settings while the Export capture runs: Settings stays open and no Export sheet appears. Gates: check:types, check:lint, check:dead; eval:keys (E17 keys and Export) unchanged.

#### Settings sheet load/save

**guard-only**, effort S · `planner/ui/settings.ts`, `planner/ui/test/sections/sheets.mjs`

Closes:
- double Enter sends two setBudget calls
- a save in flight across Esc and reopen closes the reopened sheet

**Design:** settings.ts: save() gets a local `saving` latch: return if set, set it before the await, clear it in finally. Enter and the button share it, and go.disabled follows it. On success save() closes its own handle (`mine.close()`), not the module-level `sheet`. Same pattern as Export: after its awaits, open() also returns if isSheetOpen() is true, so it never closes another sheet.

**Proof:** Browser section: open Settings, type a budget, press Enter twice quickly: one write request to the settings route (page.on('request')). Save with the answer held by interception, Esc, reopen, release: the reopened sheet stays open. Gates: check:types, check:lint.

#### Floor plan depth lifting cache and async loads

**guard-only**, effort S · `planner/ui/room.ts`, `planner/ui/test/rooms-ui.mjs`

Closes:
- a failed scene fetch or depth decode is retried on every paint with no backoff
- sceneInfo is cached for the whole room session, so a recalibrated scene keeps its old calib/depth_url
- stale async lifts write into caches cleared by a room 'opened'

**Design:** room.ts: (1) `failedAt: Map<string, number>` keyed scene|sig. ensureLifted skips a key for 15 s after a failure, and the catch sets it. (2) sceneInfo, lifted and counts for a scene are dropped on the scenes store's 'ready' event for that scene (a recalibration finishing), which also redraws. (3) A `roomGen` counter bumps on room 'opened'. The async lift captures it and writes nothing if it changed. 'opened' also clears `loading` and failedAt.

**Proof:** rooms-ui.mjs: answer one member's depth URL with 404 through page.setRequestInterception, then drive 20 camera events over 15 s: at most 2 GETs for that URL (today one per paint). Gates: check:types, check:lint; eval:room-planner.

#### Layouts card: save / Save as new form / failure-retry

**guard-only**, effort S · `planner/ui/panels/layouts.ts`, `planner/ui/test/sections/panels.mjs`

Closes:
- a save in flight across a scene change toasts or sets a Retry failure in the new scene
- load() 'Save, then load' while busy silently drops the load
- load() choosing save with no current layout opens the form and never loads
- failure and asking both true; Cancel on the failure brings back the old form

**Design:** layouts.ts: (1) save() captures `ep = epoch.now()`. If the epoch has moved by the time it settles, it sets no toast and no failure, only busy=false. (2) `inFlight: Promise<boolean> | null`. load()'s save step awaits an in-flight save before starting its own, so the load is never dropped. (3) `pendingLoad: string | null`. load() with no current layout sets it and opens the form. A successful form save then runs loadLayoutInternal(pendingLoad) with the 'Loaded' toast. Cancel or a scene change clears it. v1 dropped this load, which is the risk, so the change is deliberate (note it in docs/notes/app.md). (4) wont-fix: failure plus asking is intended. Cancel on a failed Save as new returns to the form with its draft so the name can be fixed.

**Proof:** Browser section: with unsaved furniture and no current layout, Load X, choose 'Save as new first' and save the form: getLayoutName() is then 'x'. A layout PUT held by interception, open another scene, release: no 'Layout saved as' toast and no failure row in the new scene. Gates: check:types, check:lint; eval:ux unchanged.

**Why:** Point 4 is the intended form-retry behaviour.

#### Scene panel saving/calibrating flags

**guard-only**, effort S · `planner/ui/panels/scene.ts`, `planner/ui/test/sections/panels.mjs`

Closes:
- calibrating is not scoped to the scene: another scene shows 'Calibrating…' with the button disabled, and the old scene's done toast shows over it
- (cross-area) a lost re-calibration after a server restart reads as success

**Design:** scene.ts: `calibrating: string | null` holds the scene name instead of a boolean. camView shows 'Calibrating…' and disables the button only when it equals engine.getSceneName(). recalibrate() toasts only if the open scene still has that name. `saving` stays a boolean because save() is quick and re-renders. The cross-area false success is server-domain's fix (job state across restarts). No UI change can tell the two cases apart, so this package depends on nothing for it.

**Proof:** Browser section with the server started on evals/lib/gated_calib.py (MIDSTUDY_EVAL_CALIB_GATE, as evals/render.mjs does): Calibrate again, then open a second scene: its Scene panel button reads 'Calibrate again' and is enabled. Create the gate file: no recalibration toast appears in the second scene. Gates: check:types, check:lint.

#### Workspace overlay drags: horizon handle, ruler handles, phone lift grip, rotate grip

**guard-only**, effort S · `planner/ui/workspace.ts`, `planner/ui/test/sections/workspace.mjs`

Closes:
- the horizon drag keeps setting the pitch after Adjust floor is left mid-drag
- a ruler point drag keeps calling setRulerPointAt after the ruler is switched off mid-drag

**Design:** workspace.ts: the horizon pointermove ends the drag (hzUp() plus releasePointerCapture(hz.id)) when !engine.getAdjustFloor(). The ruler handle's pointermove does the same when !engine.getRuler().active. The existing 'adjust' and 'ruler' listeners also set hz/rDrag to null when their mode goes off. The lift and rotate grips need nothing (the verifier dropped those risks).

**Proof:** Browser section: mouse down on [data-midstudy=horizon] in Adjust floor, press Esc (adjust.leave), move the mouse 80 px: getCamera().pitch_deg is unchanged. The same for a ruler handle with Esc leaving the ruler: getRuler() points are unchanged. Gates: check:types, check:lint; eval:floor (E5) unchanged.

#### Sun dial pointer gesture and rAF-coalesced emit

**guard-only**, effort S · `planner/ui/sun-dial.ts`

Closes:
- a second pointer overwrites dragId without ending the first
- set() from a 'look' event is dropped while pending; a same-frame reset is overwritten

**Design:** sun-dial.ts: start() returns when dragId !== null, so the first pointer keeps the drag, and the pointerdown touch branch ignores a new touch while dragging. The pending/set() interplay is left as is (wont-fix for that half): the window is one animation frame, and the next 'look' event corrects it.

**Proof:** eval:lighting (E16) still passes. The second-pointer guard is a one-line check with no reachable state on a mouse-only harness; noted in docs/notes/app.md. Gates: check:types, check:lint, check:planner (logic-vs-v1 sundial unchanged).

**Why:** The pending-value half is a one-frame window corrected by the next look event, not worth more code in a personal-use app.

#### Library Add/Edit sheet submit lifecycle

**guard-only**, effort S · `planner/ui/panels/libsheets.ts`, `planner/ui/test/sections/sheets.mjs`

Closes:
- closing the sheet while it submits hides a failure (set on a removed sheet)
- close during submit and reopen allows a second paid add for the same piece
- the lib 'spend' listener leaks once per Add sheet

**Design:** libsheets.ts: (1) On failure, if !sheet.isOpen(), toast the error (kind 'error', id `lib-add-failed`) instead of only setting st.error. The same applies to the Edit sheet's failure. (2) A module-level `adding: Set<string>` holds the fingerprints of in-flight sources: the URL for link and product adds, and name|size|lastModified for files. submit refuses a source already in it (st.error 'This one is already being added; it shows in the Library'), adds before the await and removes in finally. A different piece is never blocked, but closing and reopening cannot pay twice for the same one. (3) The Add sheet's onClose also removes the 'spend' listener.

**Proof:** Browser section (fal mocked): open Add, submit with the POST answered 500 by interception, Esc before the answer: an error toast appears. Submit a link with the POST held, Esc, reopen, submit the same link: one POST and the 'already being added' note. EventTarget.prototype add/removeEventListener are wrapped in page.evaluateOnNewDocument to count 'spend' listeners; opening and closing the Add sheet 3 times leaves the count unchanged. Gates: check:types, check:lint; eval:library (E7) and eval:product-ui unchanged.

#### Library panel job list (dismissed/ready sets) and lastAdded

**guard-only**, effort S · `planner/ui/panels/library.ts`, `planner/ui/test/sections/sheets.mjs`

Closes:
- add()'s Undo toast calls removeItemInternal(uid) after a scene change
- dismissed/ready grow for the page's lifetime
- (shell machine) add() after its await drops another open panel to peek

**Design:** library.ts: add() captures `ep = epoch.items()`, the same items scope as the workspace Undo, so a photo switch inside a room keeps the Undo. The Undo toast's onClick removes only while the epoch is unchanged, and after its await add() returns without select or toast if the epoch moved. setDetent('peek') is called only when panel.isOpen(), i.e. the Library itself is still the open panel (the shell machine's fourth risk). The sets are left alone (wont-fix): a page session holds a handful of job-id strings.

**Proof:** Browser section: Place a piece, open another scene, click the stale 'added' toast's Undo: the new scene's item count is unchanged. Phone pass: Place from the Library with the GLB GET held, open Layouts, release: Layouts keeps its own detent. Gates: check:types, check:lint.

**Why:** The unpruned sets hold a few job ids per page lifetime; pruning is not worth it.

#### Toast queue lifecycle

**guard-only**, effort S · `planner/ui/shell.ts`, `planner/styles/kit.css`, `planner/ui/test/sections/shell.mjs`

Closes:
- handles stay usable after eviction, and owners (workspace Undo) are not told the toast went
- a same-key replacement drops another owner's action closure without telling it
- a leaving toast's action stays clickable for 200 ms

**Design:** shell.ts toast(): ToastOptions gains `onGone?: () => void`, called once from t.close on every exit (timer, Dismiss, action, same-key replace, overflow, the phone rule). The action onclick returns when `!toasts.includes(t)` (already closed), so a leaving toast's button does nothing. The handle's close() and update() are no-ops once it is gone. kit.css: `.toast.is-leaving { pointer-events: none }`. The workspace uses onGone only to drop its toast reference; ⌘Z stays allowed in the same scene (see the Undo fix).

**Proof:** Browser section: show a toast with an action, call its handle's close(), then dispatch a click on its .toast-action within 200 ms: the action ran 0 times. A same-key replacement calls the first toast's onGone exactly once. Gates: check:types, check:lint; eval:ux and eval:ux2 toasts unchanged.

#### Adjust floor card: Looks right / Set scale async actions and the ruler row

**guard-only**, effort S · `planner/ui/workspace.ts`, `planner/ui/test/sections/workspace.mjs`

Closes:
- looksRight has no in-flight guard or recheck: two saveScene calls, and it leaves Adjust floor and toasts after the user has left or switched scene
- roomScale has no busy guard: Enter plus click scales the whole room twice

**Design:** workspace.ts: one `floorBusy` latch shared by looksRight and roomScale: return if set, set it before the await, clear it in finally. adjustSync disables the Looks right and Set scale buttons while it is set. looksRight captures `ep = epoch.now()`; a photo switch counts, since saveScene is per photo. After the save it calls setAdjustFloor(false) and toasts only if the epoch is unchanged and engine.getAdjustFloor() is still on. The input is not cleared before the await, unlike the original plan: the latch already stops the second Enter, and clearing would lose the typed length on a failure.

**Proof:** Browser section, golden room: type 200, then press Enter and click Set scale in one evaluate: one write to the room (page.on('request')), and the room scale changed by a single ratio. Scene: double-click Looks right: one PUT /api/scenes/<name>. Looks right with the PUT held, Esc out of Adjust floor, release: no 'floor saved' toast. Gates: check:types, check:lint; eval:floor (E5), eval:room-planner.

#### Scenes page card actions: open / rename / add photo / delete with confirms and sheets

**guard-only**, effort S · `planner/ui/scenes.ts`, `planner/ui/test/sections/scenes.mjs`

Closes:
- Rename scene/room save() has no busy guard: Enter plus Save, or a double Enter, sends two renames
- open()/openRoom() check before the confirm and act after it with no recheck, so a scene opened meanwhile is replaced

**Design:** scenes.ts: rename() and renameRoom() save() get a local `saving` latch, and the Save button is disabled while it is set. open() and openRoom() capture `ep = epoch.now()` before the confirm. Afterwards they return without acting if the epoch moved; the same rule as the uploads machine, with no re-ask.

**Proof:** Browser section: two quick Enters in the Rename sheet give one title write (page.on('request')), and the same for Rename room. Open a dirty-layout confirm, open another scene through the hook while it is up, then OK: the scene opened through the hook stays open. Gates: check:types, check:lint; eval:planner (E3), eval:room-planner (room rename).

<details><summary>Reviewer’s changes</summary>

- Coverage: all 23 '### ' machines in ## planner-ui have exactly one fix entry. None were missing.
- Undo scope (Workspace Undo, Library add): the original epoch bumped on room 'photo', which would have killed a valid ⌘Z after a photo switch. A room keeps its pieces across photos (engine.ts openSceneAs; contract §4.9), so restoring into it is correct. Added an items() epoch that bumps only on scene 'loading'/'closed'; a photo switch emits no 'loading'. Dropped the 'photo switch counts' claim from the risk list.
- Shared epoch: now() also bumps on 'loading' (and 'failed'), not only 'opened'/'closed'. Otherwise an action that settles while the next scene is loading would still act on the old one. Engine 'scene' opened also fires on photo switches, so bumping on room 'photo' was redundant.
- Hold-to-repeat: the original 'pointerleave sets pressed=false' would double-nudge every phone tap. On touch, pointerleave fires after pointerup and before click. pressed is now cleared only when the pointer leaves while still down, and a phone single-tap check is in the proof.
- Overlay filter order: the planned `escDone || layers.length > 0 || keyFilters.some` would never run the renders arrows or the shortcuts toggle while their own layer is open. Moved keyFilters.some before the layer check and added shell.topLayer() so the renders arrows act only when the modal is on top. make-explicit is kept here only: no local guard can tell which of a sheet and the renders modal is on top.
- Render cross-area mitigation: dropped the 'drop the failed row if any newer render appeared' heuristic, which could hide a real failure behind an unrelated render. A network failure (failureReason "the server isn't answering"; there is no 'offline' reason in logic/renders.ts) now refreshes the list once after 60 s, and Retry's confirm warns that the first may have finished. The real fix stays with server-domain.
- Package disjointness: the render chip half (workspace.ts, logic/workspace.ts) moved into planner-ui-workspace, so planner-ui-renders touches only renders.ts and logic/renders.ts and depends only on planner-ui-shell. nextPollMs moved from logic/rooms.ts (planner-ui-room) to logic/scenes.ts, so planner-ui-scenes no longer shares a file with planner-ui-room or depends on it. sheet.ts isSheetOpen is assigned to planner-ui-shell, which owns sheet.ts. smoke.mjs, shared by all seven, becomes a runner with one sections/<pkg>.mjs per package. tscert/baseline.json stays shared-append per CLAUDE.md.
- Shell fix: removed the inroom.ts select() change (it runs from a row in its own open panel, so no guard is needed) and the library.ts change (owned by planner-ui-sheets, covered by the Library panel fix). The risk is marked as closed there.
- Library Add sheet: upgraded the deferred 'second paid add after close/reopen' (money) to a same-source in-flight set. It blocks resubmitting the same link or file while one is in flight, never a different piece, so the original 'would block a second piece' objection no longer applies.
- Scenes New room resume: the original 'Make the room from N photos' would create a second room when only align failed. The resume now branches on the failed step (align only, versus create plus align). The post-confirm 're-ask' loop for open/openRoom/upload became a plain epoch check (return; upload proceeds but does not auto-open): less code, the same safety.
- Adjust floor: dropped 'clear the true-length input before the await'. The shared floorBusy latch already stops the second Enter, and clearing would lose the typed value on a failure.
- Settings: added the isSheetOpen() check after open()'s awaits, the same latent issue as Export. Not a listed risk; it uses the shared pattern.
- Proofs: removed proofs that edited evals-track files (an assertion in evals/phone.mjs, a two-render check in E6); those checks now live in app-owned sections. The gated calibration stub is evals/lib/gated_calib.py (MIDSTUDY_EVAL_CALIB_GATE), not a fixture. There is no fal-mock delay or 'slow pages_server route', so waiting states use page.setRequestInterception. The listener-count proof wraps EventTarget.prototype in evaluateOnNewDocument, since lib.events is not reachable from page.evaluate. Every eval gate now goes through scripts/eval-lock.mjs.
- Ownership: every file is under planner/ (app), plus package.json and tscert/baseline.json (shared-append). No contract changes are needed. The cross-area items (render job status, recalibration across restarts) stay with server-domain.

</details>

### planner-gpu (app)

Shared in this group:
- A worker that fails (onerror, messageerror, or a reply flagged fatal) is marked down for good and its work runs on the main thread; a non-fatal error reply only drops and re-decides. SplatLayer adopts engine.ts's KernelWorker workerDown pattern; the planner-engine/kernels fix for the kernel worker RPC should keep the same shape, including the fatal/non-fatal distinction.
- One gated node:test home for planner/gpu's pure modules: planner/gpu/test/*.test.mjs (.mjs because tsconfig.planner.json has types: [] and no node types; the tests import the .ts modules directly, which works only for modules with no relative imports, as unit.mjs already does) behind a `test:splats` script (`node --test planner/gpu/test/*.test.mjs`) in package.json and a knip entry `planner/gpu/test/*.test.mjs` in knip.json (both shared-append), added by planner-gpu-splat-sort.
- Pure decisions for the splat layer live in planner/logic/splats.ts (cpuSortAction, cpuReplyVerdict, sortKey), import-free, so TScert certifies them and node loads them; splat-layer.ts only performs the effects.
- Browser repros of a broken worker use a Blob-URL module worker passed as workerUrl from demo.ts (?sortWorker=...), not a new bundled file.

Packages: `planner-gpu-splat-sort`, `planner-gpu-backend-guards`, `planner-gpu-ply`

#### SplatLayer settle() waiters (capture waits for the order)

**fix**, effort S · `planner/gpu/splat-layer.ts`, `planner/logic/splats.ts`, `planner/gpu/test/splats.test.mjs`, `planner/gpu/demo/check.mjs`

Closes:
- stale-key starvation when wantKey moves while a waiter is queued
- timed-out waiters never removed from settleWaiters
- with the worker deadlock every settle() waits the full 30 s
- dispose() neither rejects nor clears waiters

**Design:** Remove the waiter queue. settle(camera) calls update(camera, settling = true); cpuSortAction's 'here' for settling sorts synchronously on the main thread when the order is stale (the GPU path already sets sortedKey synchronously at submit), so settle resolves at once when sortedKey === wantKey and rejects at once otherwise (only reachable after dispose, which now throws anyway). Delete settleWaiters, flushWaiters and the timeoutMs parameter (no caller passes it: engine.ts:930, demo.ts:191/236/317). A worker reply in flight for an older key is dropped by cpuReplyVerdict (superseded). engine.ts's settleSplats and its error text stay. Note in the demo: demo.ts:191's settle after addItem (the 'first splat frame' timing, check.mjs:383) now measures the main-thread sort, not the worker's, and lastWorkerMs stays null until a camera move: update check.mjs's note text so it does not print 'worker sort undefined ms' as if it were a regression.

**Proof:** node:test: cpuSortAction(state with pending set, staleKey, settling=true) === 'here' (a capture never waits on the worker); cpuReplyVerdict after a settle sort === 'drop'. Browser: the ?sortWorker=throw-sort case asserts settle() resolves in < 1 s (was a 30 s rejection). Gates check:tests, check:tscert, check:types; evals eval:render (E5 captures), eval:splat with MIDSTUDY_WEBGPU=0.

#### Sort key cache (when to re-sort) across GPU and CPU modes

**fix**, effort S · `planner/logic/splats.ts`, `planner/gpu/splat-layer.ts`, `planner/gpu/test/splats.test.mjs`

Closes:
- camera.near (used by both sorts' culling) is not in the sort key, so a near-only change does not re-sort
- key string rebuilt every update with O(16 x items) toFixed

**Design:** Move the key into planner/logic/splats.ts as `sortKey(version, view: ArrayLike<number>, near: number, items: readonly ArrayLike<number>[]): string` with near included (far is not used by either sort, only by the material's per-frame uniform, so it stays out); prepare() builds its arrays and calls it. The per-update string cost is kept.

**Proof:** node:test: two keys for identical view/items differing only in near differ; identical inputs give identical keys; version is part of the key. Gates check:tests, check:tscert, check:types.

**Why:** The toFixed cost is wont-fix: negligible at the planner's item counts, and the engine's splatKey already skips unchanged frames.

#### SplatLayer CPU (worker) sort request lifecycle

**make-explicit**, effort M · `planner/logic/splats.ts`, `planner/gpu/splat-layer.ts`, `planner/gpu/sort-messages.ts`, `planner/gpu/test/splats.test.mjs`, `planner/gpu/demo/demo.ts`, `planner/gpu/demo/check.mjs`, `package.json`, `knip.json`, `tscert/baseline.json`

Closes:
- deadlock: worker.onerror/handler throw leaves pending set forever, no sort ever again, splats frozen or invisible
- 'error' reply leaves the order stale with no onChange or re-request
- set change blanks every splat item on WebGL2 until the worker answers (contradicts the header comment)
- add() of an existing uid rebuilds twice (two versions, two 'set' posts)
- version-mismatch re-request uses the old wantKey and relabels sortedKey with a stale key
- pending.resolve is a dead half-mechanism
- dispose() leaves pending set

**Design:** Keep the worker, add a main-thread fallback and one pure decision module. (1) New planner/logic/splats.ts (TScert area planner/logic/**; NO imports, so a node test can load it with Node's type stripping, as planner/gpu/demo/unit.mjs loads splat-data.ts): `type CpuSort = { worker: 'none' | 'up' | 'down', pending: { id: number, key: string, version: number, superseded: boolean } | null, sortedKey: string, setChanged: boolean }`. `cpuSortAction(s, wantKey, settling): 'none' | 'here' | 'post' | 'wait'` = 'none' when wantKey === sortedKey; 'here' when worker === 'down' or setChanged or settling; 'wait' when pending; else 'post'. `cpuReplyVerdict(s, reply: {id, version}, version, wantKey): 'ignore' | 'drop' | 'apply'` = 'ignore' when reply.id !== pending?.id; 'drop' when reply.version !== version, or pending.superseded (a main-thread sort landed after this request was posted: applying it would overwrite a newer order with an older one and relabel sortedKey backwards), or sortedKey === wantKey; else 'apply'. The effect code clears pending on both 'drop' and 'apply'. (2) splat-layer.ts: replace pending/sortedKey handling with a `cpu: CpuSort` field. rebuild() keeps the set on the main thread (`cpuSet = {version, centers, slots, count}` plus a SortScratch from sort-cpu.ts) and posts 'set' WITHOUT the transfer list (a structured-clone copy, ~4 MB at 262k splats), sets setChanged = true and no longer zeroes instanceCount in cpu mode. The next update() (render() calls it before drawing) takes 'here' and sorts synchronously with sortSplats (~7 ms at 262k in Node per docs/notes/webgpu-swap.md), so a set change never draws a blank frame; update the header comment (line 26) to say set changes sort on the main thread and camera/transform changes in the worker. sortHere(key) copies the order into `order`, sets instanceCount = visible, sortedKey = key, setChanged = false and marks any pending request superseded. onWorker: apply -> copy order, onChange; then, after BOTH apply and drop, re-run cpuSortAction for the current wantKey with lastRows/lastRange (which belong to the latest prepare, so to wantKey): without the re-run after a drop the layer sits idle-stale until the next camera move, the same 'stuck until something moves' the 'error' branch had. No more re-request with a stale key on a version mismatch. Worker failure: onerror, onmessageerror, and an 'error' reply with fatal: true set worker = 'down', pending = null, terminate the worker, warn once, and call onChange so the engine redraws (splatEpoch is in the engine's splatKey, engine.ts:542) and update() sorts on the main thread from then on (engine.ts KernelWorker's workerDown pattern). A non-fatal 'error' (the worker's version check) only drops and re-decides. sort-messages.ts: FromWorker 'error' gains `fatal: boolean` (true only from the worker's catch), so a benign version-mismatch reply never kills the worker for the session. Delete pending.resolve. (3) add(): if the uid exists, a private drop(uid) (map delete + slot push, no rebuild), then rebuild once. (4) dispose(): pending = null, worker 'down' (and the disposed flag of the GPU lifecycle fix). Demo hook for the repro: demo.ts reads `?sortWorker=throw-load|throw-sort` and passes a Blob URL module worker (`throw` at top level, or reply to 'set' and throw on 'sort') as workerUrl, so no new bundled file is needed.

**Proof:** node:test planner/gpu/test/splats.test.mjs (.mjs, not .ts: tsconfig.planner.json has "types": [] and the DOM lib, so a .ts test importing node:test fails check:types; the .mjs imports ../../logic/splats.ts directly, as unit.mjs does), behind a new `test:splats` script (`node --test planner/gpu/test/*.test.mjs`, picked up by check:tests) and a knip entry `planner/gpu/test/*.test.mjs` (else check:dead reports the files unused). Cases: {worker:'down', pending set} gives 'here', not 'wait' (the deadlock: the old rule was 'if pending return'); setChanged gives 'here'; a stale-version reply gives 'drop' and the next action for a fresh wantKey is 'post' or 'here'; a reply for key K1 after a main-thread sort of K2 and a move to K3 gives 'drop' (superseded), not 'apply'. Browser repro first, WebGL2 (`node planner/gpu/demo/check.mjs --only=webgl`): demo ?sortWorker=throw-load and ?sortWorker=throw-sort: before the fix splats never appear and settle() rejects after 30 s; after, the splat probe is drawn within 3 % of its box and settle resolves at once. A second case counts splat pixels in the first draw() right after addItem/removeItem with no onChange wait: blank before, drawn after. Gates: check:types, check:lint, check:dead, check:tests, check:tscert (--update for the new functions), check:ownership (MIDSTUDY_TRACK=app); evals through the lock: eval:splat (E13) default and MIDSTUDY_WEBGPU=0, node planner/gpu/demo/check.mjs. eval:perf only means anything here with MIDSTUDY_WEBGPU=0 (the default WebGPU path uses the GPU sort and is untouched); run it --exclusive with MIDSTUDY_WEBGPU=0 to see splat_first_frame's main-thread sort cost.

**Why:** Scattered pending/sortedKey/version/instanceCount produce the stuck and blank states listed; a small typed state plus a main-thread fallback removes them without rewriting the worker protocol. The WebGL2 path is the fallback (WebGPU is the default on the user's Mac), but the evals run it with MIDSTUDY_WEBGPU=0 and the deadlock is a hang, so it is worth closing.

#### sort.worker.ts set/version state

**guard-only**, effort S · `planner/gpu/sort.worker.ts`, `planner/gpu/sort-messages.ts`

Closes:
- no try/catch around the allocation and sortSplats: an exception sends no reply with the request id
- scratch buffer never shrinks

**Design:** Wrap both branches of the message handler in try/catch. 'sort' failure: reply { type: 'error', id: m.id, message, fatal: true }. 'set' failure: keep `broken = message` and set = null, and answer every later 'sort' with { type: 'error', id, message: broken, fatal: true } (a swallowed set failure would otherwise answer the next sorts with the non-fatal version-mismatch error and the layer would ping-pong post/drop forever). The version check keeps replying fatal: false. The layer marks the worker down on fatal and sorts on the main thread. The scratch never shrinking is left as is.

**Proof:** The ?sortWorker=throw-sort Blob worker in planner/gpu/demo/check.mjs exercises the layer's fatal-reply path, ?sortWorker=throw-load exercises onerror; the real worker's catch is checked by reading (a stub cannot exercise it) plus eval:splat with MIDSTUDY_WEBGPU=0 still passing. Gates check:types, check:lint.

**Why:** Scratch growth is wont-fix: bounded by the largest splat set the session placed.

#### SplatLayer GPU resource lifecycle (capacity / allocate / disposeGpu / dispose)

**guard-only**, effort S · `planner/gpu/splat-layer.ts`

Closes:
- use after dispose: add() silently draws nothing (capacity not reset, slots not returned)
- render() after dispose uses the disposed target

**Design:** dispose() sets `private disposed = true`; add(), remove(), render(), update() and settle() throw 'the splat layer was disposed' when disposed (fail loud instead of silently dead). No capacity reset or slot refill: nothing can use them after the throw. Capacity-only-grows is kept. The radix keys/vals/hist buffers are left to three: growth is by doubling, so at most a few superseded buffers per session, bounded by about twice the final capacity; renderer.info.memory does not count storage buffers, so the proposed measurement would not show them anyway.

**Proof:** Latent (engine.ts never disposes the layer): the guard is a few lines checked by reading and check:types/check:lint; no browser case is added for it.

**Why:** Latent: the engine never disposes the layer. Shrinking capacity and freeing the old radix buffers are wont-fix: bounded memory in a personal app.

#### Renderer pre-init / post-init phase and backend assumptions

**guard-only**, effort S · `planner/gpu/passes.ts`

Closes:
- clearTarget's Reflect pokes at three's private WebGL2 state fail silently after a three.js upgrade, bringing back the stale-furniture and black-view bugs
- isWebGPU reads a private field; a rename silently makes WebGPU pick the CPU worker sort

**Design:** passes.ts: isWebGPU becomes a checked read: true when backend.isWebGPUBackend === true, false when backend.isWebGLBackend === true, otherwise throw 'unknown three.js backend (three upgraded?)' (callers: engine.passes.ts:251, lighting.ts:253, splat-layer.ts, demo.ts; all after init()). clearTarget: when the backend is the WebGL one (by the same isWebGLBackend flag, not by `gl`, which could move too) and state, state.setColorMask or state.bindFramebuffer is missing, console.error once ('three.js WebGL2 internals moved: the clear workaround is off'); never on WebGPU, whose backend has no `state`. That console.error makes check.mjs's 'no page or console errors' check fail, which is the point. three stays pinned exactly (package.json 0.180.0); the note that check.mjs and gltrace.mjs must be rerun on a three upgrade goes in the comment above clearTarget (package.json cannot hold comments).

**Proof:** No node test (needs a real renderer). node planner/gpu/demo/check.mjs on both backends (webgpu reports sortMode 'gpu', webgl 'cpu'; the removed-piece capture and Fit view cases still pass, no console errors), eval:splat and eval:occlusion with MIDSTUDY_WEBGPU=0 and default. Gates check:types, check:lint.

**Why:** Pre-init misuse was rejected by the verifier (both callers await init()); only the upgrade fragility is guarded.

#### WebGPU demo page: ready promise, lazy splat layer, async item add/remove

**guard-only**, effort S · `planner/gpu/demo/demo.ts`

Closes:
- an exception after line 47 (createPasses, createLighting, scene setup) rejects the module but never calls failed(), so api.ready never settles and check.mjs waits to its timeout

**Design:** In demo.ts, right after api.ready is created, add `window.addEventListener('error', (e) => { failed(e.error) })` and an 'unhandledrejection' listener calling failed(e.reason): a module's evaluation error is reported to window, and failed() on an already-settled promise is a no-op. Smaller than wrapping the whole module body in try/catch, which would turn every top-level let/const/function into block scope. Concurrent same-uid addItem and concurrent openScene are left.

**Proof:** node planner/gpu/demo/check.mjs still passes; by hand, a deliberate throw in createLighting makes check.mjs report the error within seconds instead of at its timeout. Gates check:types, check:lint.

**Why:** The concurrency risks are wont-fix: the demo is a test page driven one call at a time by its own scripts.

#### PLY header parser element/property state

**guard-only**, effort S · `planner/gpu/splat-data.ts`, `planner/gpu/test/splat-data.test.mjs`

Closes:
- an element declared before 'vertex' is skipped in the stride but the DataView starts at headEnd, decoding the wrong bytes silently
- count = Number(p[2]) not validated: NaN slips past the length check

**Design:** decodePly: throw 'the splat PLY must declare its vertex element first' when an 'element' other than vertex appears before 'element vertex'; validate count with Number.isSafeInteger(count) && count >= 0, else throw 'the splat PLY's vertex count is not a number'. Elements after vertex stay fine (the DataView covers only count * stride from headEnd). E13/E16 probes and stored splat.ply have only a vertex element.

**Proof:** node:test planner/gpu/test/splat-data.test.mjs (.mjs importing ../splat-data.ts, which has no imports): a PLY with 'element face 0' before vertex and one with 'element vertex abc' both decode without error before the fix (reproduce), throw after; a valid vertex-only PLY still decodes. unit.mjs stays as it is (docs/notes of other tracks point at it). Gates check:tests, check:types, check:lint, check:dead.

#### GpuRadixSort pass ping-pong and in-place histogram phase

**wont-fix**, effort S

**Design:** No change. The invariant (the key kernel runs right before the full kernel list) holds at both call sites (splat-layer.ts update and debugReadSort).

**Proof:** Covered by the existing debugSort comparison against a CPU stable sort (node planner/gpu/demo/check.mjs --only=sort).

**Why:** An invariant current callers respect, not a live bug; the header comment already documents keys[0]/vals[0] as the input.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 9 machines of ## planner-gpu have exactly one fix entry; the verifier-rejected photo-depth-pass-inputs needs none.
- Test files .ts -> .mjs: tsconfig.planner.json includes planner/**/*.ts with "types": [] (no @types/node), so a .ts node:test file under planner/ fails check:types. Node imports the import-free .ts modules directly (planner/gpu/demo/unit.mjs already does this), so planner/logic/splats.ts must have no imports.
- Added knip.json to package 1: its entry globs do not cover planner/gpu/test/, so check:dead would report the new test files unused.
- cpuReplyVerdict gap: in the proposed rules a worker reply for K1 that lands after a main-thread sort of K2 and a move to K3 is 'apply' (same version, sortedKey !== wantKey), overwriting the newer order and relabelling sortedKey backwards. Added pending.superseded, set by sortHere, which makes it 'drop'.
- After a 'drop' the layer must re-run cpuSortAction too, not only after 'apply'. Otherwise a camera move that waited behind the dropped reply leaves the layer idle-stale until the next move, the same stuck state the 'error' branch had.
- Marking the worker down on ANY 'error' reply would kill it for the session on the worker's benign version-mismatch reply. Added `fatal: boolean` to the 'error' message (sort-messages.ts, app-owned, added to files): only the worker's catch sends fatal. The worker remembers a failed 'set' so later sorts answer fatal instead of looping on non-fatal mismatches.
- Removed the 'comment beside the pin in package.json' (JSON has no comments); the upgrade note goes above clearTarget in passes.ts. clearTarget's guard now keys on isWebGLBackend rather than `gl`, and never fires on WebGPU.
- sortKey: dropped far from the key, since neither sort uses it (only the material's per-frame uniform); near alone closes the risk.
- GPU lifecycle: dropped resetting capacity and refilling slotFree (pointless once add() throws after dispose) and the dispose-then-add browser case. The radix-buffer check via renderer.info.memory would not see storage buffers, so that part becomes wont-fix (bounded by doubling) and radix-sort.ts leaves the files.
- Demo ready: replaced the try/catch around the whole module body (it would make every top-level declaration block-scoped) with window 'error'/'unhandledrejection' listeners calling failed().
- Broken-worker repro: a Blob-URL module worker selected by ?sortWorker=throw-load|throw-sort in demo.ts, so no new bundled worker file or build change is needed.
- settle now sorts on the main thread for the CPU path, so demo.ts:191's 'first splat frame' timing and check.mjs:383's 'worker sort' note change meaning (lastWorkerMs stays null until a camera move); the fix updates that note. eval:perf matters only with MIDSTUDY_WEBGPU=0 (the default WebGPU path is untouched), so it is marked informational under --exclusive.
- Packages: demo.ts was listed in fix 1's files but owned by package 3. The demo machine moves into planner-gpu-splat-sort; package 3 is now PLY only (and carries the no-change radix entry), depending on package 1 for the test:splats script and the knip entry. The three packages' files are disjoint. Dropped check:planner from package 1 (no planner/logic module in engine.test.mjs's LIST changes). Eval gates written through scripts/eval-lock.mjs.
- Kept make-explicit for the CPU sort machine: a guard alone (clearing pending on onerror) fixes the deadlock but not the blank frame on a set change, and the fix needs the main-thread sort anyway. The pure state is small and certifiable. Everything stays within the app track; no contract change.

</details>

### server-infra (server)

Shared in this group:
- One kill sequence for every child the server starts through runTool: SIGTERM the process group, SIGKILL after 5 s, settle on 'close', with a hard cap. It lives in common/tools.ts (killGroup, killAllTools with its stopping latch, and an exit handler) and matches contract §4.3's worker crash rule. server-domain's scene/room delete cancel should use runTool's new `signal` option, which resolves as a real 'exited' (-15/-9) and adds no new ToolRun variant, instead of adding its own kill code. The warm worker (scenes/calib.ts's own spawn) should follow the same TERM-then-KILL rule in its close.
- Hand-off ownership with a local `handedOff` flag and try/finally: the request releases its temp folder and spend key unless a job took them. Use it in routes/library.ts and routes/scenes.ts, and in any server-domain route that hands a temp folder or reservation to a job (render.ts).
- SpendCap.transfer(from, to) is the only way a reservation changes owner. A job adopts a reservation through newJob's `adopt` key and never releases and reserves again.
- jobStep(from, to) in server/src/logic/jobs.ts is the single job-status rule, and it guards only terminal states (first terminal wins). JobStore.update enforces it for the library, scenes and rooms stores, so server-domain's #ended/#failed/#end paths need no guards of their own, and no non-terminal move is refused (a refused move would leave a job stuck).
- Re-check after await: a route that checks a resource exists and then awaits the body re-tests it right before its synchronous commit. Layouts get it first; server-domain's scene PUT and room PUT should use the same pattern.
- Rollback around one commit point: for multi-step disk changes (library delete/restore), the library.json write is the commit, and every step before it is undone in a catch when anything up to and including the commit throws.

Packages: `server-infra-tools`, `server-infra-lock`, `server-infra-jobs`, `server-infra-library`, `server-infra-layouts`

#### In-memory job queue and job records (SerialQueue + JobStore)

**guard-only**, effort S · `server/src/logic/jobs.ts`, `server/src/jobs.ts`, `server/test/infra.test.ts`, `tscert/baseline.json`

Closes:
- JobStore.update accepts any status patch with no transition guard; library #run doesn't check status
- No way to cancel a running job (mechanism only: runTool's AbortSignal from server-infra-tools; scenes/rooms delete wiring belongs to server-domain)
- Shutdown is not a queue state: queued/running jobs vanish while detached children keep running (closed together with server-infra-tools: killAllTools plus its stopping latch, so the queue can't start the next job's tool)

**Design:** Add to server/src/logic/jobs.ts (TScert): `type JobStatus = 'queued'|'running'|'done'|'failed'` and `jobStep(from: JobStatus, to: JobStatus): boolean`, where only terminal states are guarded. The result is true when `from` is 'queued' or 'running', whatever `to` is. When `from` is 'done' or 'failed', it is true only for `to === from`, so message-only patches on an ended job still apply. The rule closes the real race, a late #failed/#ended overwriting a terminal status, and first terminal wins. It deliberately does not forbid non-terminal moves such as queued->done. rooms #end(id, ok, …) can set done or failed from either queued or running, and a refused patch there would leave a job stuck in a non-terminal state forever, which is worse than the bug. JobStore becomes `JobStore<J extends { readonly id: string; readonly status: JobStatus }>`; LibraryJob, scenes JobView and rooms AlignJobView already use that union. update() returns null and writes one stderr line ('job <id>: <from> -> <to> refused') when `patch.status` is present and `!jobStep(job.status, patch.status)`. Every caller ignores the return value today. The scenes-style guard `if (job.status !== 'queued') return` in library #run ships in server-infra-library, because that package owns library/service.ts. Wont-fix parts: the bounded #after. Every #after today (library, scenes/rooms) is synchronous and returns Promise.resolve(), so a hang can't happen, and a timer race would add a constructor option for nothing. Also wont-fix: evicting old jobs, position() O(n) and drained() single-cycle semantics. v1 behaviour is kept: jobs live in memory and a restart forgets them (contract §2.8 Jobs).

**Proof:** node:test in server/test/infra.test.ts 'job queues': (1) a store whose job is 'done' refuses update({status:'failed'}) and update({status:'running'}): it returns null and the job is unchanged. This fails today because update merges any patch. (2) A job moved queued->failed (the drop-on-delete race) then refuses a late {status:'running'} and a late {status:'done'}. (3) queued->done and running->running with a new message still apply, so rooms #end and requeued align jobs keep working. TScert: `node scripts/tscert-ratchet.mjs --files server/src/logic/jobs.ts --update` adds jobStep to the baseline. Gates: check:types, check:lint, check:tests (test:server, test:scenes, test:library), check:tscert, check:dead. Evals under the lock: eval:all (E1 scenes API, E7 library, E18/E19/E20 --mock rooms and align jobs).

#### Daily spend cap reservations (reserve / release / hold-for-today / expire)

**guard-only**, effort S · `server/src/spend.ts`, `server/src/library/service.ts`, `server/src/routes/library.ts`, `server/test/spend.test.ts`

Closes:
- Leaked 'fetch-*' reservation when makeTempDir or queueAdd throws in postFromUrl
- Fetch-to-job hand-off is release-then-reserve, can answer 402 after the download
- spent() returns 0 when costs.csv can't be read: the cap fails open
- (cross-area) the in-flight add's reservation vanishes on restart while an orphan bills: mostly closed by server-infra-tools killing children at shutdown; a fal call already in flight when the add is killed may still bill without a cost row (residual, accepted)

**Design:** server/src/spend.ts gains `transfer(from: string, to: string): void`. It moves an active reservation's amount to a new key without re-checking the cap, and it is a no-op when `from` is absent (mock mode reserves nothing). LibraryService.newJob gains an `adopt: string | null` parameter. When set, newJob calls spend.transfer(adopt, id) instead of reserve(id, reserve) and so can never refuse. The from-URL hand-off therefore can't answer 402 after the download, and the money is never unreserved in between. The postFromUrl/queueAdd ownership fix (try/finally releasing the fetch key unless handed off) is in the Upload entry. spent(): only ENOENT (no costs.csv yet) counts as 0. Any other read error writes one stderr line ('costs.csv unreadable: <code>; refusing paid calls'), makes reserve() refuse with the usual 402 body (spent_usd = cap) and makes view() report spent_usd = cap, so an unreadable ledger fails closed. Mock calls (amount 0) return before reading, so dev and evals are unaffected. This deliberately changes v1's `spent`, which returned 0 on any read error; docs/notes/server.md must say so, since contract §2.12 doesn't specify the unreadable case. Wont-fix parts: held reservations expiring at UTC midnight (v1 hold_for_today; the cap is per UTC day) and setCap below spent+reserved (the next reserve is refused, which is the intended over-cap behaviour).

**Proof:** New server/test/spend.test.ts on a temp costs file with a fixed `now`: (1) reserve('fetch-x', 1) then transfer('fetch-x','l-1') leaves view().reserved_usd unchanged, and release('l-1') zeroes it. (2) With costs.csv rows such that a fresh reserve of the same amount would be refused, transfer still succeeds. This reproduces today's 402-after-download, where release+reserve after costs.csv grew is refused. (3) costs.csv replaced by a directory (EISDIR) makes reserve('k', 0.5) refuse and view().spent_usd == cap, a missing file still reads 0, and reserve('k', 0) still answers null. The route-level leak test is in the Upload entry. Gates: check:tests, check:types, check:lint. Evals under the lock: eval:all (E7 library, W2's MIDSTUDY_FAL_MOCK_COST=1 cap check, E15/E16 product form, which reserves via from-URL).

#### Library / costs lock directory protocol (take, wait, reclaim, release)

**guard-only**, effort S · `common/logic/lock.ts`, `common/lock.ts`, `server/test/lock.test.ts`, `server/test/lock-child.ts`

Closes:
- 'too-old' reclaims a live holder past 3600 s (no fencing), age from the owner's clock
- heldHere keyed by dir: a process reclaiming its own too-old lock
- An orphaned midstudy-add after restart holds the lock (closed by server-infra-tools killing children)
- (cross-area) lost library.json update after the too-old reclaim of a long midstudy-add; ADD_TIMEOUT_S == LOCK_STALE_MS and SIGKILL skips releaseAllSync
- (cross-area) two writers at once after a too-old verdict

**Design:** common/logic/lock.ts lockVerdict (TScert, already in the baseline) gets a new parameter `liveMarginMs`. A same-host owner that is alive (`ownerAlive === true`) is 'too-old' only when `ageMs > staleMs + liveMarginMs`. Owners whose liveness is unknown (another host, null) keep the plain `ageMs > staleMs` rule. Dead same-host owners are still reclaimed at once. common/lock.ts passes liveMarginMs = 10 min. The server's runTool now ends any tool by 3600 s + 5 s grace (SIGTERM, then SIGKILL; server-infra-tools). A live midstudy-add run by the server is therefore always gone, its lock released by its SIGTERM handler (pipeline/src/cli.ts:494) or left as a dead owner, before a waiter may reclaim it. This removes the two-writer state and the ADD_TIMEOUT tie. The plan's original rule, never reclaiming a live same-host pid, is rejected. alive() is kill(pid, 0), so a crashed holder whose pid is later reused, which is common after a reboot, would look alive forever and wedge every library edit with 503 until someone removes .lock.d by hand. The margin keeps that case recovering after 70 min. heldHere self-reclaim: a waiter whose own process already holds `dir` (heldHere has it and the owner matches) never judges it stale and waits as for any held lock. This is a three-line check in common/lock.ts. Not changed: the reclaim move-back failure path, in-process polling fairness and appendCost's waitMs null (holders hold it for one atomic write).

**Contract:** CONTRACT.md §2.8 One writer, the Stale bullet becomes: '…when it is older than the tool timeout (3600 s since started), or, when its owner is a live process on this host, older than the tool timeout plus 10 minutes (the server ends every tool by then)…'. This is foundation-owned: foundation or the integration agent applies the one-sentence edit before this package merges.

**Proof:** server/test/lock.test.ts: the test at :80 keeps its foreign-host half: 2 h old on another host is reclaimed, and a young one on another host is not. New cases: (a) a child (lock-child.ts) holds the lock with owner.started back-dated 3605 s (past 3600 s, inside the margin). A waiter with waitMs 300 gets Busy, and the child's owner.json is untouched. This fails today because the waiter reclaims it. (b) The same live child back-dated 2 h is reclaimed (the pid-reuse recovery). (c) A back-dated lock whose pid is dead is reclaimed at once. 'the protocol's verdicts' gets these cases as pure lockVerdict calls. check:tscert must still certify common/logic/lock.ts#lockVerdict (re-run once on 'tool errors'). Gates: check:tests, check:tscert, check:types, check:lint, plus test:pipeline because midstudy-add uses common/lock.ts. Evals under the lock: eval:all (E7 library and E8 pipeline, which run midstudy-add and the server against one library lock).

#### Server process lifecycle (startup -> listening -> stopping -> exit) and shutdown hooks

**guard-only**, effort M · `server/src/main.ts`, `server/test/shutdown.test.ts`, `server/test/fixtures/sleepy-add.mjs`

Closes:
- stop() cuts every connection first: a paid render whose fal call returned can die before appendCost
- Job queues not drained and detached children survive the exit (midstudy-add, one-shot calib, render align), still paying fal and holding the lock
- All hooks share one 5 s budget; a hanging hook makes exit wait silently
- (cross-area) orphaned one-shot calibrations write calib.json after restart without the camera applied; the restarted server's reservations miss the orphan; the planner's library job vanishes (the job loss itself stays: jobs are in memory by contract)

**Design:** server/src/main.ts stop() does four things. (1) server.close() and server.closeIdleConnections(), not closeAllConnections, so requests in flight can finish, including a render between its fal answer and its cost row. (2) killAllTools() from common/tools.ts (server-infra-tools). It first sets the module's stopping latch: every later runTool call resolves {kind:'spawn-error', message:'the server is stopping'} without spawning. Without the latch, killing the running midstudy-add makes the SerialQueue start the next queued job's tool at once, and a request still in flight could queue a new one. Then it sends SIGTERM to every live tool group and SIGKILL after 5 s. (3) It runs the hooks as today (scenes.shutdown closes the warm worker). (4) It races `Promise.allSettled([hooks, serverClosed, toolsGone])` against a 10 s unref'd limit. If the limit wins, it logs one line naming what is still pending (open request count, live tool pids, unsettled hooks), then calls closeAllConnections() and exit(0). common/tools.ts also registers `process.on('exit')`, which synchronously SIGKILLs any group still in its live set, so every exit path, the forced one included, leaves no tool behind. A second SIGINT or SIGTERM during stopping exits at once. uncaughtException/unhandledRejection stay as they are (wont-fix part). Residual, accepted: a render still waiting on fal after 10 s is cut, and fal may bill it with no cost row. The warm calibration worker is spawned by scenes/calib.ts, not runTool, so it is not in the live set. If its shutdown hook hangs, the exit leaves it to server-domain's worker close; this is noted for that group.

**Proof:** New server/test/shutdown.test.ts (picked up by test:server's server/test/*.test.ts) starts `node server/src/main.ts --port 0 --daily-spend-usd 0` with MIDSTUDY_FAL_MOCK=fixtures/fal, MIDSTUDY_NO_DOTENV=1, NOOK_NO_DOTENV=1, a temp library, and `--midstudy-add 'node server/test/fixtures/sleepy-add.mjs'`. The fixture writes its pid and a grandchild's pid to a file next to its --library and sleeps 60 s. The test POSTs two image uploads (a fixture JPEG with valid X-Midstudy-Meta), waits for the pid file, sends SIGTERM to the server, and asserts three things: the server exits within 12 s, both pids are gone, and no second sleepy-add pid file appears (the latch stops the second queued job). This fails today because the detached group survives. Second case: a layout PUT whose headers were sent before SIGTERM and whose body is sent after gets its 200 before exit. It uses `--calib 'python3 fixtures/stub_calib.py'` to make the scene. Gates: check:tests (test:server), check:types, check:lint. Evals under the lock: eval:all (every eval stops its server through startServer; E7 exercises children), plus `-- --with-calib` once for E2's one-shot calib.

#### Library item delete/restore lifecycle on disk (live -> .trash -> restored)

**guard-only**, effort M · `server/src/routes/library.ts`, `server/test/library/routes.test.ts`

Closes:
- Half-restored stuck state when library.write throws after the folder moved back
- Half-deleted: entry.json write fails after the folder moved, trash folder orphaned and invisible to trash()
- patchItem queues the rescale after releasing the lock: a concurrent PATCH's dims can be overwritten

**Design:** routes/library.ts keeps the library.json write as the single commit point and undoes the folder move when anything before or at that commit fails. deleteItem first writes `.trash/<name>/entry.json`, then moves the folder, then writes library.json. The whole sequence after mkdir sits in try/catch. On any throw it moves the folder back to <library>/<id> if it was moved, removes the trash folder (so no phantom copy appears in GET /api/library's trash list) and rethrows (500 as today). restoreItem moves the folder back, then tries library.write. On failure it moves the folder back into copy.dir and rethrows, leaving the trash copy restorable; removeTree(copy.dir) stays after the write. patchItem computes `refit` and calls library.newJob('rescale', …) inside the locked() callback right after the write. newJob is synchronous and only queues; the job takes the lock itself later. Rescales are therefore queued in the same order as the PATCHes that changed the fields. Wont-fix part: move() across file systems (the library and its .trash are one folder tree, never EXDEV).

**Proof:** New server/test/library/routes.test.ts builds the route module from a ServerDeps over a temp library (MIDSTUDY_STRICT=1 so library.write asserts) and drives it through a started test server. The fault is injected deterministically: a second item in library.json that breaks library.schema.json, so the library.json write throws in strict mode. Asserts: (a) after a failed DELETE the item is still in library.json with its folder, and .trash holds no folder. (b) After a failed restore (the fault added after the delete), the trash copy is still listed. Once the bad item is removed, a second restore answers 200; today it answers 409 forever because the folder already moved back. (c) Two PATCHes with different dims_cm, sent back to back, queue rescale jobs whose argv carry the dims in request order. --midstudy-add points at a fixture that records its argv, so no real tool runs. Gates: check:tests (test:library), check:types, check:lint. Evals under the lock: eval:all (E7 library delete/restore/patch flows, E11–E14 UX rounds).

#### Upload / from-URL add hand-off (temp folder and reservation ownership)

**guard-only**, effort S · `server/src/routes/library.ts`, `server/src/routes/scenes.ts`, `server/src/library/service.ts`, `server/test/library/routes.test.ts`

Closes:
- postFromUrl: makeTempDir outside the try leaks the 'fetch-*' reservation
- postUpload/postFromUrl: queueAdd throwing never removes the temp folder
- postScene: scenes.create throwing after the rename leaks the temp folder

**Design:** One ownership rule, written as a small local `handedOff` flag: the request owns tmp and the reservation until newJob/scenes.create returns, then the job does. postFromUrl moves `makeTempDir` inside the try and wraps the rest (download, check, queueAdd) in try/finally. When !handedOff, the finally calls deps.spend.release(key) and removeTree(tmp). queueAdd passes the fetch key to newJob as `adopt` (spend.transfer, see the spend entry) instead of release-then-reserve, and sets handedOff when newJob returned a job. The 402 path, now reachable only for uploads, keeps its removeTree. postUpload gets the same try/finally for tmp around queueAdd. In routes/scenes.ts, postScene wraps scenes.create in try/catch that removes tmp and rethrows. Wont-fix part: a client that disconnects after its job was queued still has its job run (v1 did the same, and the job list shows it).

**Proof:** In server/test/library/routes.test.ts, the deps carry a test SpendCap subclass, since ServerDeps.spend is injected, so no stub of LibraryService is needed. (1) A from-URL add against a local 127.0.0.1 pages server. MIDSTUDY_FAL_MOCK_COST=1 makes the reserve non-zero, and makeTempDir is made to fail through a TMPDIR that doesn't exist, set for that server process. The add answers 500, and GET /api/spend then shows reserved_usd 0. This fails today because the fetch key stays reserved. (2) An upload where the SpendCap subclass throws from reserve() for keys starting 'l-' (so newJob throws) answers 500 and leaves no midstudy-upload-* folder in the temp dir. (3) postScene with scenes.create throwing (the scenes dir made read-only after startup) leaves no midstudy-scene-* folder. Gates: check:tests (test:library, test:server), check:types, check:lint. Evals under the lock: eval:all (E7 library uploads, E15/E16 product page add from URL, E1 scenes API).

#### Child tool run (spawn, capture, timeout kill, settle)

**guard-only**, effort M · `common/tools.ts`, `server/test/tools.test.ts`

Closes:
- detached:true: Ctrl-C and the server's exit don't reach the tool, no hook kills it (orphans pay fal and hold the lock)
- On timeout the promise settles before 'close'; #after removes the upload folder while the killed process tears down
- An 'error' after a successful spawn settles as spawn-error and the process is never killed
- (cross-area) SIGKILL at the timeout skips midstudy-add's releaseAllSync
- (cross-area) calib.ts:332's intent that no one-shot outlives the server

**Design:** common/tools.ts keeps detached, so the timeout can kill the whole group as now, but tracks every live child in a module-level `live = new Set<ChildProcess>()`, removed on 'close'. A local `killGroup(child, graceMs)` sends SIGTERM to -pid, sends SIGKILL after graceMs if the child hasn't closed, and resolves on 'close' or at grace+1 s. killAllTools(graceMs = 5000) sets a module `stopping` latch, after which runTool resolves {kind:'spawn-error', message:'the server is stopping'} without spawning, then runs killGroup on every live child. `process.on('exit')`, registered once, SIGKILLs any group still live (synchronous, for forced exits). On the timeout path, killGroup runs and {kind:'timeout'} resolves only on 'close', with a hard cap of grace+5 s so the promise can't hang on a grandchild that escaped the group. Cleanup in #after therefore runs after the tool has exited, and midstudy-add's SIGTERM handler releases the lock. An 'error' after spawn (child.pid defined) kills the group before settling. ToolOptions gains `signal?: AbortSignal`. Abort runs killGroup, and the run resolves as the 'exited' it really is (returnCode -15, or -9 after SIGKILL, as Python reports a signal death). The caller that aborted knows it from signal.aborted. No new ToolRun variant is added: one would force edits to scenes/calib.ts and scenes/render.ts, which belong to the server-domain packages. No caller in this group passes `signal`; it exists for server-domain's scene/room delete, which depends on this package. This matches the worker's own SIGTERM-then-SIGKILL-after-5 s rule (contract §4.3 Crash) and v1's subprocess.run, which killed the child and then waited on it.

**Proof:** New server/test/tools.test.ts uses node child scripts written to a temp dir. (1) A child that traps SIGTERM and writes a marker, run with timeoutMs 200: the marker exists when runTool resolves 'timeout'. This fails today, which sends SIGKILL only. (2) A child that ignores SIGTERM, with the grace shortened through an exported test seam or killAllTools(300): it is SIGKILLed and its pid is dead when the promise resolves. This fails today, which resolves before close. (3) killAllTools() ends a running tool and its grandchild (sh -c 'sleep 60 & sleep 60'), both pids gone, and a runTool call after it resolves spawn-error without spawning. Because the latch is module state, this case runs in a subprocess (node -e importing common/tools.ts) so it can't poison the other tests. (4) Aborting the signal resolves 'exited' with returnCode -15, and the pid is dead. Gates: check:tests, check:types, check:lint, check:dead (killAllTools used by main.ts in the same package). Evals under the lock: eval:all (E7 library adds run midstudy-add through runTool) and eval:all -- --with-calib once (E2 one-shot calib).

#### Layout soft-delete and client-side Undo (live file -> .trash copy -> PUT back)

**guard-only**, effort S · `server/src/routes/layouts.ts`, `server/test/layouts.test.ts`

Closes:
- PUT checks the owner, then awaits the body; a scene deleted meanwhile gets layouts/<scene>/ recreated, blocking its restore

**Design:** In the server/src/routes/layouts.ts PUT, after `await ctx.readJson()` and the check, the owner is re-tested synchronously right before writeJsonSync (scenes.exists(owner.name) / rooms.exists(owner.name), both existing synchronous methods). When it is gone, the PUT answers the same 404 that layoutOwnerOf gives. writeJsonSync is synchronous, so nothing can interleave after the re-test. Deferred: versioning/ETag on layout PUT. It needs a contract change, a planner change and a conflict UI; last-writer-wins is v1 behaviour, and two-tab editing is rare for one person. It is tracked under the cross-area 'Layout and scene documents edited from several tabs' machine. Wont-fix: trash copies are never purged, and the trash copy stays behind after an Undo PUT (a few KB each; v1 did the same).

**Proof:** New server/test/layouts.test.ts starts a server (mock vars, `--calib 'python3 fixtures/stub_calib.py'`, --daily-spend-usd 0) and creates a scene. It opens a raw http PUT /api/layouts/x?scene=<name> with Content-Length, sends only the headers, DELETEs the scene, then sends the body. The PUT answers 404, no layouts/<scene>/ folder exists, and the scene restore then answers 200. Today the restore fails with 'exists'. Gates: check:tests (test:server), check:types, check:lint. Evals under the lock: eval:all (E3 planner layouts, E11–E14 UX rounds with layout Undo).

#### Atomic write / replace protocol with .tmp files

**defer**, effort S

**Design:** If it ever matters: at startup, remove `.*.<hex>.tmp` files older than an hour in the scenes, rooms, layouts and library folders.

**Proof:** n/a

**Why:** Orphan temp files appear only after a crash mid-write. They are hidden dotfiles, never served or listed, and the target file is intact (the rename never happened), so no data is lost. The replace() EXDEV window only touches the layout trash. A sweep is cheap but has no current user-visible benefit.

#### HTTP request/answer lifecycle (body read state, early answer, drain, close)

**wont-fix**, effort S

**Design:** No change. Optional, when someone next edits context.ts: #sendEarly could check socket.writable before setting the status, so a dead socket logs 0 rather than 411/413.

**Proof:** Covered as today by test:server (server.test.ts, plumbing.test.ts) and E1/E9.

**Why:** Low severity, and every listed risk is latent or log-only. No handler sends twice or sends without awaiting, answered && !bodyDone happens only for GET/HEAD file answers, and the misleading status is a log line. Folding four booleans into one state value would rewrite tested plumbing for no user-visible gain.

#### Safe URL fetch redirect/hop loop with budget and per-hop abort

**wont-fix**, effort S

**Design:** No change.

**Proof:** fetch.test.ts as today.

**Why:** Reporting a TLS or network error that coincides with the budget running out as 'timeout' is only a wording difference. A raced DNS lookup that keeps running in the thread pool ends by itself. Neither leaks nor corrupts state.

#### Per-socket in-flight request counter and idle timeout

**wont-fix**, effort S

**Design:** No change. The shutdown change (server-infra-tools) bounds even a never-answering handler at exit, through the 10 s limit and closeAllConnections.

**Proof:** server.test.ts as today; shutdown.test.ts covers exit with an open request.

**Why:** Every handler answers, and a throwing one answers through failed(). A socket held by a handler that never answers would be a bug in that handler, not in the counter, and no such handler exists.

#### Strict mode module-global (contract loaded or not)

**wont-fix**, effort S

**Design:** No change.

**Proof:** Evals run with MIDSTUDY_STRICT=1 as today.

**Why:** main.ts awaits enableStrict() before it builds the routes and listens, so nothing is validated before the contract has loaded. The off -> on latch is the intended one-way state.

#### Character/byte parser state machines (shlex, CSV, UTF-8 decoders, Host header folding, JSON depth)

**wont-fix**, effort S

**Design:** No change.

**Proof:** Already TScert-certified (tscert/baseline.json) and tested against CPython's behaviour.

**Why:** These are pure, TScert-covered parsers. The one remaining note, jsonTooDeep's depth going negative on malformed input, is harmless because JSON.parse then rejects that input.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 14 '### ' machines in '## server-infra' have exactly one entry; none added.
- Lock: rejected 'never reclaim a live same-host owner'. alive() is kill(pid, 0) (common/lock.ts:83). A crashed holder whose pid is reused, which is likely after a reboot, would look alive forever and wedge every library edit with 503 until someone removes .lock.d by hand. That is a hang, worse than the risk being fixed. Replaced with a live-owner margin, stale after 3600 s + 10 min: the server's tools are now ended by 3600 s + 5 s, so the two-writer race is closed and pid reuse still recovers. The contract change was reworded to match. Added an explicit heldHere self-reclaim check, because the old design's 'our own pid is always alive' argument no longer holds with a margin. Added test:pipeline as a gate (midstudy-add uses common/lock.ts) and tscert/baseline.json to the files, since lockVerdict's signature changes.
- Tools/shutdown: added a stopping latch to killAllTools. Without it, killing the running midstudy-add makes the library SerialQueue start the next queued job's tool immediately, and an in-flight request could queue one too, so 'no orphans after exit' would not hold. Added a process 'exit' handler that SIGKILLs any live group, so the forced 10 s exit path leaves nothing behind. The shutdown test now also asserts that a second queued add never spawns.
- Tools: dropped the new {kind:'cancelled'} ToolRun variant. tsc would force edits to server/src/scenes/calib.ts:300 and server/src/scenes/render.ts:282, files the server-domain packages own, and no caller in this group uses it. An abort now resolves as the genuine 'exited' with returnCode -15/-9, so the option exists for server-domain without a type change. That also removed library/service.ts from the tools entry, which collided with server-infra-library.
- Jobs: narrowed jobStep to guard terminal states only. The proposed table forbade queued->done, but rooms #end (server/src/rooms/service.ts:510) sets done or failed by `ok` from whichever state the job is in. With update() refusing that patch, the job would stay non-terminal forever, worse than the bug. First-terminal-wins is what the risks need.
- Jobs: downgraded the bounded #after (a 60 s race with a constructor option) to wont-fix. Every #after today (library service.ts, scenes/rooms service.ts:649) is synchronous and returns Promise.resolve(), so the hang is theoretical. Removed that risk from the entry and its test. Added eval:all to the jobs package gates because JobStore's constraint change touches the scenes and rooms stores (E1, E18–E20).
- Spend: fail-closed spent() kept as a deliberate v1 deviation, with a required stderr line and a note in docs/notes/server.md. It doesn't affect mock development, since reserve(…, 0) returns before reading. The cross-area restart risk is marked only mostly closed: a killed add whose fal call was already in flight may still bill without a cost row.
- Delete/restore: the rollback now also covers a failing move() or entry.json write. Writing entry.json first and then failing the move would otherwise leave a phantom trash copy listed by GET /api/library. The proof's fault injection is a strict-mode schema violation in library.json, which is deterministic, instead of chmod tricks.
- Upload proof (2): replaced 'an argv addArgv refuses' (addArgv doesn't throw) and 'a stubbed LibraryService' (routes build their own) with a SpendCap subclass injected through ServerDeps whose reserve() throws for 'l-' keys. It runs with this repo's tooling.
- Tools proof (3): the stopping latch is module state, so the killAllTools case runs in a subprocess and doesn't poison the other runTool tests in the same node:test file.
- Packages: server-infra-library no longer depends on server-infra-tools or server-infra-jobs. It uses neither package's code: the #run status guard is a standalone line, and the tools package no longer touches service.ts. It keeps server-domain-library-job for the service.ts overlap. docs/notes/server.md is added to its files. Files are now disjoint inside the group, except tscert/baseline.json (shared-append) in jobs and lock. server/src/routes/scenes.ts (postScene) may also be touched by server-domain packages, so whoever merges should sequence it after them.
- Layouts package: added eval:all as a gate (E3, E11–E14 exercise layout PUT and Undo).
- Residual noted for server-domain: the warm calibration worker isn't spawned through runTool, so a hanging scenes.shutdown hook at the 10 s limit can leave it running. server-domain's worker close should apply the same TERM-then-KILL rule.

</details>

### server-domain (server)

Shared in this group:
- Abortable child runs: every server-spawned tool (one-shot calib, render `calib align`, midstudy-add) passes an AbortSignal to common/tools.ts runTool (the `signal` option from server-infra-child-tool), keeps its AbortController in a per-service Set, and the service's shutdown() aborts and awaits them within main's 5 s race; abort maps to the existing 'stopped' / 'the server stopped' outcome. Each service registers it with deps.onShutdown (scenes/shared.ts for scenes+renders, routes/library.ts for the library). A child that may already have been billed (midstudy-add) is only killed once it records its cost row on SIGTERM (pipeline group).
- Write outside, move in on success: a tool's output that the server only accepts on a good answer goes to a dot-staging folder (rooms/.align/<job>/), is renamed into place by the server, is removed at every end and swept at startup, instead of drop-on-delete plus #removeLeftover bookkeeping.
- Crash-ordered trash moves: write trash.json inside the live folder before moving it, and remove trash.json last on restore (scenes/service.ts and rooms/service.ts use the same order).
- Unique job ids: redraw newJobId while the JobStore already has the id (scene #queueJob and room align()).
- Test stand-ins for held jobs: reuse server/test/rooms-calib.ts's ROOMS_CALIB_DELAY_MS / ROOMS_CALIB_ALIGN_DELAY_MS (no ROOMS_CALIB_SERVE, so jobs go one-shot) to keep a calibration or align running in scene, room and runner-shutdown tests; fake-calib.ts gains only the worker-specific modes (ignore-eof, idle-crash).

Packages: `server-domain-calib-runner`, `server-domain-scene-jobs`, `server-domain-room-align`, `server-domain-children-shutdown`

#### Scene calibration job lifecycle (calibrate/run/fit) with drop-on-delete

**guard-only**, effort M · `server/src/scenes/service.ts`, `server/src/scenes/logic/status.ts`, `server/test/scenes/jobs.test.ts`, `server/test/scenes/logic.test.ts`, `tscert/baseline.json`

Closes:
- spawn-error bypasses #finish (wrong message for a dropped job, no leftover cleanup)
- delete then restore while the job runs: restored scene shows failed 'scene deleted' with an unapplied new calib.json
- delete while a fit is queued, then restore: #last pins failed(SCENE_DELETED) for the server's life
- restore answers 'exists' while the dropped job's tool re-made the folder
- restart forgets jobs: created scene with no source.* says 'calibrate it again' but calibrate() answers NO_PHOTO_TO_CALIBRATE (cross-area dead end)
- cross-area: lost re-calibration after a restart reads as done; an orphaned one-shot writes calib.json after the restart and the scene reads done with the camera never applied

**Design:** server/src/scenes/service.ts plus one pure change in logic/status.ts. (1) #ended 'spawn-error' calls this.#finish(id, false, serverFailed('OSError', ...)) instead of #jobs.update. Also #queueJob redraws newJobId while #jobs.get(id) !== null (same rule as align ids). (2) restore(name): answer 'exists' (existing 409) while a dropped job of this scene has started and not yet reached #after (track the id #run is on in `#current: string | null`, set when it marks the job running, cleared in #after; a status check alone leaves a gap between #finish and #after, and #work.has would also block on queued dropped jobs that may wait up to 600 s behind another job). After a successful restore delete #last/#lightLast entries for `name` whose id is in #dropped, so status derives from the files again. (3) A server-private marker scenes/<name>/.calibrating holding the job id: written in #queueJob for kind 'calibrate'; removed in #after only when its content is this job's id AND the outcome was not 'stopped' (a job stopped by shutdown keeps its marker, so after the restart it reads LOST_CALIBRATION, which is exactly what the marker is for). delete(): for each queued (never started) dropped job, remove the marker before the folder moves (nothing touched the folder, so a restored scene must read from its files: test (b)); a running dropped job's marker travels to the trash and back, which is right (its tool may have half-written the folder before the move). (4) calibStatus(job, hasCalib, interrupted, hasInput) in logic/status.ts, rows in this order: queued/running/failed job as today; no job this run and !hasInput (neither photo.jpg nor source.*) -> failed LOST_UPLOAD ('the upload was lost when the server restarted: delete this scene and upload the photo again'), checked BEFORE the marker row so a lost create never says 'calibrate it again'; no job + marker -> failed LOST_CALIBRATION even with calib.json; else done with calib.json, LOST_CALIBRATION without. sceneObject passes the two booleans. The marker is not on the static allowlist (§4.4 Static), so it is never served. Not here: the torn depth/calib write window and the fallback fit deleting depth.png (calib group), the planner's waitForScene token (planner-engine group), #jobs/#dropped eviction (deferred: a few hundred bytes per job).

**Contract:** CONTRACT §4.2 (scene folder files): add the server-private `.calibrating` marker (holds the job id; never served; removed when the job ends unless the server stopped under it). §4.4 calib_status: 'failed' with LOST_CALIBRATION also when the marker is present and no job of this server run covers the scene (even with calib.json); the new LOST_UPLOAD sentence, which wins, when the scene has neither photo.jpg nor source.*. Note in docs/notes/server.md that this departs from v1 on purpose.

**Proof:** New server/test/scenes/jobs.test.ts on an in-process SceneService with `node server/test/rooms-calib.ts` as --calib (no ROOMS_CALIB_SERVE, so one-shot) and ROOMS_CALIB_DELAY_MS to hold a job running: (a) delete during a running run, restore at once -> 'exists' until the job ends, then restore succeeds and calib_status is not 'failed: the scene was deleted'; (b) queue a fit behind a held job on a scene with calib.json, delete, restore -> calib_status 'done' (no marker came back); (c) write a .calibrating marker into a calibrated scene and build a fresh SceneService (the restart) -> failed LOST_CALIBRATION; (d) scene.json + marker, no photo/source -> LOST_UPLOAD (not LOST_CALIBRATION); (e) --calib pointing at a non-executable file (spawn-error) on a dropped job -> message SCENE_DELETED; (f) shutdown() mid-run, then a fresh SceneService -> LOST_CALIBRATION (needs server-domain-calib-runner's 'stopped'). Each fails on main first. logic.test.ts rows for calibStatus incl. the LOST_UPLOAD-over-marker order. Gates: check:tests (test:scenes, test:server), check:tscert (--update for calibStatus), check:types, check:lint, check:dead. Evals under the eval lock: eval:scenes-api (E1 trash/restore), eval:rooms-api (E18).

#### Warm calibration worker process (one <calib> serve child) request/idle/exit lifecycle

**guard-only**, effort M · `server/src/scenes/calib.ts`, `server/test/scenes/worker.test.ts`, `server/test/scenes/fake-calib.ts`

Closes:
- idle close only ends stdin: no SIGKILL grace, runner forgets it, a worker ignoring EOF leaks its process group
- cross-area: idle close is async and the next job spawns a second worker, two models resident together
- stderr written while idle (a crash trace) is never surfaced
- double kill(): two SIGTERMs and two SIGKILL timers
- implicit #broke/onGone handshake

**Design:** server/src/scenes/calib.ts only. (1) Idle timer calls a retire path: gone='it was idle', onGone(this), then close()'s body (stdin.end + SIGKILL after killGraceMs, await #exited). CalibRunner keeps `#retiring: Set<Worker>` (added by the onGone callback when gone is 'it was idle', removed when its exit resolves). (2) CalibRunner.run awaits Promise.all of the retiring workers' exits (bounded by their grace timers) before constructing a new Worker, so at most one model is resident. shutdown() closes the live worker and every retiring one. (3) Worker.kill() and close() cache their promise in #stopping and return it on later calls (one SIGTERM, one SIGKILL timer). (4) stderr: always keep a STDERR_KEEP tail; ask() still resets it; in the 'close' handler, before #lost sets #gone, when #pending is null and #gone is null (not idle/stop/server-stopped), log the tail through options.log. (5) #broke calls #onGone(this) too, making the runner's drop explicit (the runner's own checks stay, harmless). Not changed: a broken answer after the work is done re-runs one-shot (contract §4.3; costs time only); id:null answers stay 'garbled' (contract §4.3 Crash); the worker's SIGTERM handler is the calib group's.

**Proof:** fake-calib.ts gains FAKE_CALIB_SERVE=ignore-eof (keeps running after stdin ends) and FAKE_CALIB_SERVE=idle-crash (writes a trace to stderr and exits 1 while idle). worker.test.ts: (a) ignore-eof with workerIdleMs 100, killGraceMs 200: after the idle close the logged pid is gone within ~1 s (process.kill(pid, 0) throws; fails today: it lives on); (b) a job right after the idle close starts its worker only after the old pid exited (FAKE_CALIB_LOG start order vs process.kill(pid,0)); (c) idle-crash: the log callback receives the trace; (d) a timeout then a late answer sends SIGTERM once (count 'SIGTERM' notes the fake logs from a handler). Gates: check:tests (test:scenes), check:types, check:lint. Evals under the eval lock: eval:align (E20 --mock through the worker), eval:scenes-api.

#### Room align job lifecycle (queued/waiting/running/done/failed) with drop-on-delete

**guard-only**, effort M · `server/src/rooms/service.ts`, `server/src/rooms/logic/room.ts`, `server/test/rooms.test.ts`, `server/test/rooms-logic.test.ts`, `tscert/baseline.json`

Closes:
- delete then restore while a job runs: the old run writes align.json into the restored room, align_status 'done' from an answer never applied
- a queued job dropped by delete leaks its #requests entry
- align.json written but the job failed: 'failed' now, 'done' after a restart while aligned is null
- the tool re-makes rooms/<name>/ after a delete (leftover handling)
- cross-area: room restored while its align job runs leaves new align.json + old poses, and a later Reset applies the unapplied answer

**Design:** server/src/rooms/service.ts. (1) Staging: #run passes `--out rooms/.align/<job id>/` (a dot folder: names() and trash() already skip non-slugs; align-room, the stub and rooms-calib.ts all create --out when missing, and the §4.9 mock key does not depend on --out) instead of the room folder. In #ended, only on an ok, non-dropped answer with the room still there: replace() staging/align.json onto rooms/<room>/align.json (atomic rename, same filesystem), then apply as today. Every end (#end, #ended's tail, the queue's failed callback) removes the staging folder; the constructor sweeps rooms/.align/ (a crash or SIGKILL mid-run leaves one). A failed, timed-out, violating or dropped run therefore never touches the room: align.json exists only when it was applied, so align_status 'done' after a restart and Reset both read an applied answer. #removeLeftover goes away. (2) delete(): for each queued job it fails, also #requests.delete(job.id). (3) align(): redraw newJobId('a', now) while #jobs.get(id) !== null (the id-collision part of the SerialQueue machine). (4) A tiny pure helper in rooms/logic/room.ts: `alignStagingName(id)` (TScert). Members changing mid-run stay as today (photo-sha check guards replaced photos).

**Contract:** CONTRACT §4.9 Files (line 'rooms/<room>/align.json ... written by midstudy-calib align-room (never by the server)') and §4.9 Align: the server runs align-room with `--out rooms/.align/<job>/` and moves its align.json into rooms/<room>/ only when the job succeeds and the room still exists; a failed or dropped job leaves rooms/<room>/ untouched; rooms/.align/ is server scratch. The calib side is unchanged. Also needs an evals-track change: evals/rooms_api.mjs:346 checks `--out <rooms>/<room>` in the recorded argv and must accept `<rooms>/.align/<job id>` (plus check align.json lands in rooms/<room>/ after the job).

**Proof:** rooms.test.ts, using the existing ROOMS_CALIB_ALIGN_DELAY_MS: (a) start an align, DELETE the room while running, restore at once, let the job end -> the restored room has no new align.json and align_status is not 'done' (fails today); (b) ROOMS_CALIB_ALIGN_OFF_CONTRACT=1 under MIDSTUDY_STRICT=1 -> job failed and rooms/<room>/align.json absent, then PUT reset -> 409 RESET_WITHOUT_ALIGN (today it applies); (c) rooms/.align/ is empty after every job and after constructing a RoomService over a planted rooms/.align/x/; (d) the #requests leak is checked in review (no test hook added for it). Update any existing rooms.test.ts assertion on the --out argv. The existing 'deleted while running' test keeps passing without #removeLeftover. Gates: check:tests (test:server), check:tscert, check:types, check:lint, check:dead. Evals under the eval lock, after the evals-track E18 update: eval:rooms-api (E18), eval:align (E20 --mock), eval:room-planner (E19).

#### CalibRunner worker-vs-one-shot degradation and shutdown mode

**guard-only**, effort S · `server/src/scenes/calib.ts`, `server/test/scenes/worker.test.ts`

Closes:
- after shutdown() the queue keeps draining and the next job runs one-shot (the run that outlives the server)
- a one-shot run in flight at shutdown is never stopped (cross-area orphaning: it writes calib.json after the restart)

**Design:** server/src/scenes/calib.ts. (1) run(): first line `if (this.#closing) return { kind: 'stopped' }`, so nothing starts after shutdown (the job ends 'the server stopped', as the worker path does; scene and align jobs both go through run()). (2) oneShot() passes an AbortSignal to runTool (runTool's new `signal` option from server-infra-child-tool) from a per-run AbortController kept in `#oneShots: Set<AbortController>`; shutdown() aborts them all (runTool sends SIGTERM to the group, SIGKILL after grace) and awaits their settle, within main's 5 s race (killGraceMs must stay under it). Abort maps to { kind: 'stopped' }. Permanent degradation after 3 failures is kept: contract §4.3 says 'for the rest of the server's life' (wont-fix part).

**Proof:** worker.test.ts with `node server/test/rooms-calib.ts` as --calib (no ROOMS_CALIB_SERVE: its serve fails, so jobs go one-shot) and ROOMS_CALIB_DELAY_MS=5000: (a) call runner.shutdown() mid-run -> the one-shot pid (ROOMS_CALIB_LOG) is gone and the outcome is 'stopped', no calib.json written (fails today); (b) shutdown(), then run() -> 'stopped' with no process start in the log. Gates: check:tests (test:scenes), check:types, check:lint. Evals under the eval lock: eval:scenes-api.

**Why:** Permanent one-shot after 3 failures stays: it is the contract's rule and a restart resets it.

#### Scene folder lifecycle on disk (live / trashed / restored) and room hand-off

**guard-only**, effort S · `server/src/scenes/service.ts`, `server/test/scenes/jobs.test.ts`

Closes:
- delete: a throw after leave() and before trash.json loses the room record
- restore removes trash.json before moving layouts and rejoining: a throw in between loses the room membership
- restore colliding with the tool-recreated leftover (covered by the calibration-job fix)

**Design:** server/src/scenes/service.ts delete(): after `room = leave(name)`, write trash.json into the live folder scenes/<name>/ first, then move the folder (trash.json travels with it), then the layouts. restore(): move layouts and rejoin first, rm trash.json last. A trash.json left in a live folder is ignored (trash() only scans .trash/) and is overwritten by a later delete; it keeps the room record on disk for a hand repair, which is all this promises (there is no automatic re-try). The steps are synchronous, so SIGINT/SIGTERM can't split them; this orders them for a thrown fs error (EACCES, EXDEV). The 'exists' collision is closed by the scene calibration fix.

**Proof:** jobs.test.ts: (a) a SceneService with RoomHooks whose rejoin() throws: restore throws, and the restored folder still holds trash.json with the room record (fails today: it was removed first); (b) delete with layouts/<name>/ made unmovable (chmod 0o500 on layouts/ in the test, restored in a finally) -> the trash copy holds trash.json with its room and trash() lists it. Gates: check:tests (test:scenes), check:types, check:lint. Evals under the eval lock: eval:scenes-api (E1 trash/restore), eval:rooms-api (E18 delete/restore a member).

#### Library midstudy-add job lifecycle with spend reservation

**guard-only**, effort M · `server/src/library/service.ts`, `server/src/routes/library.ts`, `server/test/library/jobs.test.ts`

Closes:
- cross-area: midstudy-add is never killed when the server stops; the orphan holds the library lock and keeps billing
- cross-area: the orphan's EPIPE on stdout can kill it between fal charge and the cost row
- DELETE of an item with a queued add/rescale job
- done path reads library.json without the lock
- restart orphans upload folders in tmp

**Design:** server/src/library/service.ts: #run passes an AbortSignal (server-infra's runTool `signal`) from a per-job AbortController; new LibraryService.shutdown(): abort the running job (SIGTERM to the group: pipeline/src/cli.ts releases the lock and cleans scratch on SIGTERM) and await its settle within main's 5 s race; queued jobs are not started (a #closing flag checked at the top of #run). routes/library.ts registers deps.onShutdown(() => library.shutdown()). No holdForToday/release at shutdown: SpendCap's reservations are in memory and die with the process, so that step does nothing; the in-flight reservation lost on restart is closed only by costs.csv holding the row. Money ordering: killing an add after fal charged must still leave its cost row, but cli.ts's SIGTERM handler today only runs cleanUp() (no appendCost for a charged, uncommitted run), so this package depends on the pipeline group's paid-call/interrupt fix writing the charged cost row on SIGTERM; without it, shutdown would turn the orphan (which does record its row when it finishes) into an unrecorded charge. Not changed: DELETE vs a queued job (an add re-creating the item is what the user asked; a rescale of a deleted item fails cleanly), the unlocked done-path read (library.json is replaced atomically), tmp upload orphans (server-infra's startup sweep of midstudy-* temp dirs). ADD_TIMEOUT_S == LOCK_STALE_MS is left to the server-infra lock fix.

**Proof:** New server/test/library/jobs.test.ts: a LibraryService on a scratch library whose argv is server/test/library/hold-lock.ts (takes the library lock and sleeps); call shutdown() -> the child pid is gone, <library>/.lock.d is free, and a job queued behind it never starts (fails today: the child lives on, lock held). The cost-row-on-SIGTERM half is proven by the pipeline group's test (mock fal with charged=true, SIGTERM mid-run -> a costs.csv row), not here: live mode is never exercised. Gates: check:tests (test:library, test:server), check:types, check:lint. Evals under the eval lock: eval:library (E7), eval:pipeline (E8).

#### Room alignment freshness (never aligned / aligned / stale) across room.json.aligned, align.json and photo hashes

**guard-only**, effort S · `server/src/rooms/service.ts`, `server/test/rooms.test.ts`

Closes:
- PUT reset re-applies an align.json from a failed/dropped run that was never applied

**Design:** Closed by the room align staging change (align.json reaches rooms/<room>/ only when a job applied it), so Reset only ever re-applies an applied answer. `aligned` staying set after members change is the contract's definition (§4.9: 'the last align result the server applied'); no stale flag is added.

**Contract:** Same §4.9 staging note as the room align job fix; nothing else.

**Proof:** The room align fix's test (b): an off-contract run leaves no align.json and PUT reset answers 409. Gates: check:tests (test:server). Evals under the eval lock: eval:rooms-api (E18).

**Why:** The staleness half (aligned never cleared) is contract-defined; the planner can show it later if it matters.

#### Align tasks on the calibration SerialQueue (run / requeue-behind-calibrations / done)

**guard-only**, effort S · `server/src/rooms/service.ts`, `server/src/scenes/service.ts`, `server/test/scenes/jobs.test.ts`

Closes:
- two align jobs in the same second can collide on the 4-hex id and overwrite #tasks

**Design:** rooms/service.ts align(): draw newJobId('a', now) again while #jobs.get(id) !== null (in the room-align package). scenes/service.ts queueTask(): throw if #tasks or #work already has the id (a programming error, surfaced) (in the scene-jobs package; #queueJob's own redraw is there too). The #run/#after requeue handshake stays: SerialQueue calls after exactly once per turn (jobs.ts), verified.

**Proof:** jobs.test.ts: SceneService.queueTask twice with one id throws on the second; the retry loops are three lines read in review. Gates: check:tests (test:server, test:scenes), check:types, check:lint.

#### Room folder lifecycle (live / trashed / restored) with member pruning

**guard-only**, effort S · `server/src/rooms/service.ts`, `server/test/rooms.test.ts`

Closes:
- a throw between the folder move and trash.json leaves an invisible, unrestorable room
- restore removes trash.json before moving layouts

**Design:** rooms/service.ts delete(): write trash.json into the live rooms/<name>/ first, then move the folder and layouts; restore(): move layouts and prune members first, rm trash.json last. A stray trash.json in a live folder is ignored. Silent member pruning on restore stays (contract §4.9).

**Proof:** rooms.test.ts: DELETE a room whose layouts/@<room> is made unmovable (chmod 0o500 on layouts/ in the test, restored in a finally) -> the trash copy holds trash.json and GET /api/rooms/trash lists it (fails today: trash() skips a copy without trash.json). Gates: check:tests (test:server), check:types, check:lint. Evals under the eval lock: eval:rooms-api (E18).

#### Render pipeline: name reservation, spend reservation, staged files on disk

**guard-only**, effort S · `server/src/scenes/render.ts`, `server/src/scenes/shared.ts`, `server/test/scenes/render.test.ts`

Closes:
- a failure after files are written (align spawn-error throw) leaves -input/-raw jpgs that list() never shows
- cross-area: the one-shot `calib align` outlives a server stop

**Design:** scenes/render.ts #align: a runTool 'spawn-error' returns alignFailed(serverFailed('OSError', message)) instead of throwing, as its own comment says ('Any failure is not applied'), so #make writes the raw result as <name>.jpg and the .json: the render completes not-applied. This keeps a paid live render (fal already charged and the cost row appended) instead of the 500-plus-delete the first draft proposed, which would have thrown away an image the user paid for; it departs from v1's 500 on purpose (note in docs/notes/server.md). No try/catch file cleanup for other throws (fs errors between writes are theoretical here). #align passes an AbortSignal to runTool (server-infra) from an AbortController in `#aligns`; new RenderService.shutdown() aborts them and awaits (abort reads as alignFailed('the server stopped'), so .jpg falls back to the raw result). shared.ts registers deps.onShutdown(() => renders.shutdown()). The missing render job id (the planner losing a finished render) is a planner+contract feature: deferred. Rebase on the uncommitted upscale work in render.ts / render.test.ts (working tree) before starting.

**Proof:** render.test.ts (fal mocked): keep-room render with --calib a non-executable file (spawn-error) -> 200, meta aligned.applied false with the OSError reason, renders/ holds <name>.jpg, -raw, -input and .json (fails today: 500 and stray -input/-raw); a keep-room render whose align sleeps (rooms-calib.ts style delay for `align`, or a tiny sleeping script), then renders.shutdown() -> the align pid is gone and the render completes not-applied. Gates: check:tests (test:scenes), check:types, check:lint. Evals under the eval lock: eval:render (E5).

#### Room member placement state (pose_source origin/solver/manual/unplaced)

**defer**, effort S

Closes:
- deleting the origin scene or a PUT without it leaves no origin
- PUT changing the origin's pose turns it manual
- readMember turns hand-edited unplaced-with-pose or unknown source into manual
- reinsertMember silently drops a restored member when the room is full or lists it

**Design:** No change now. All four are the contract's stated rules (§4.9 Changes, Membership: a changed pose is manual; a restored member returns when there's room; readMember's tolerant read). The real effect, a restored origin re-entering a frame re-anchored by manual members, is fixed by running Align photos.

**Proof:** Covered by rooms-logic.test.ts and proofs/ Room.lean as they stand.

**Why:** Contract-defined behaviour with no data loss; a personal app where the user re-aligns. Revisit if the floor plan shows a two-anchor frame in practice.

#### Scene lighting backfill (light job, lighting.json, calibration-newer override)

**defer**, effort S

Closes:
- 'none' flips to 'missing' after any later calibration
- cross-area: 'none' is lost on restart and the planner re-runs the light job on first open
- status depends on JobStore order as a clock

**Design:** No change now. A newer calibration re-infers light itself (fit rewrites or removes lighting.json), so 'missing' after it is accurate; persisting 'none' would need a new file in contract §4.8. The cost is one extra light job (seconds, $0) per scene per server run.

**Proof:** Existing scenes-api and lighting evals (eval:lighting, E16).

**Why:** Low impact for a personal app, no money or data at stake; needs a contract file for 'none' to fix properly.

#### Scene camera_source (default/auto/manual) governing who may overwrite the camera

**wont-fix**, effort S · `server/src/scenes/service.ts`

Closes:
- PUT camera without camera_source keeps auto/default
- PUT camera_source auto without a camera
- manual PUT during a calibration relies on #ended being one synchronous turn

**Design:** No code change. The planner always sends camera and camera_source together ('Looks right' sends manual, Reset sends auto, contract §4.4/§4.5), and PUT's merge is v1's (§0). Add one comment above #ended's scene.json read-modify-write saying it must stay in one synchronous turn.

**Proof:** None needed; the scenes API eval (eval:scenes-api, E1) pins PUT behaviour.

**Why:** v1 behaviour and the only client always sends both fields; inferring 'manual' server-side would change the contract for no observed failure.

#### Scene folder progress encoded by files (source.<ext> / photo.jpg / calib.json / lighting.json)

**wont-fix**, effort S

Closes:
- align admission counts a busy member that later fails without photo.jpg
- partial outputs of a failed run change later behaviour with no record after a restart

**Design:** No code change beyond the scene calibration fix: its .calibrating marker records 'a run didn't finish' across a restart (kept on a 'stopped' end), so a partial photo.jpg without calib.json, or a half-done fit over an old calib.json, reads failed LOST_CALIBRATION and the next calibrate() is a fit on that photo. Counting busy members at align admission is contract §4.9 (New room asks right after the uploads); the job then fails ALIGN_TOO_FEW with its sentence.

**Proof:** Covered by the scene calibration fix's tests (c) and (f) and the existing rooms.test.ts 'a job waits for its members to calibrate'.

**Why:** v1/contract behaviour; the one concrete gap (no record after restart) is closed by the marker.

#### nestedTooDeep JSON byte scanner (inString mode + depth counter)

**wont-fix**, effort S

Closes:
- unbalanced closers drive depth negative

**Design:** No change: JSON.parse rejects such text right after, so the result is the same refusal.

**Proof:** n/a

**Why:** No observable impact.

#### SceneService rooms hook late binding

**wont-fix**, effort S

Closes:
- a SceneService built without RoomService deletes scenes without updating room.json

**Design:** No change: scenesFor binds both synchronously; tests that build SceneService alone have no rooms on purpose.

**Proof:** n/a

**Why:** Only construction path binds both; a constructor-required hook would complicate the worker tests for no real risk.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 16 '###' machines of ## server-domain have exactly one fix entry; none added.
- Scene calibration: the first draft's marker contradicted its own proof (b): a queued fit's marker would travel to the trash and back and pin LOST_CALIBRATION over a good calib.json. delete() now removes the marker for queued (never started) dropped jobs; running ones keep it.
- Scene calibration: #after removed the marker on every end, 'stopped' included, so a calibration cut by shutdown read 'done' after the restart. That is the exact cross-restart case the marker exists for. The marker now stays when the outcome is 'stopped'. Added proof (f); the package now depends on server-domain-calib-runner.
- Scene calibration: LOST_UPLOAD now wins over the marker row. Otherwise a create lost to a restart (it has a marker but no photo or source) still said 'calibrate it again', and that is the dead end the fix was meant to close.
- Scene calibration: the restore guard now keys on the job #run is on (#current, cleared in #after), not on status 'running'. A status check leaves a gap between #finish and #after. #work.has would also block restore on queued dropped jobs that can wait up to 600 s.
- Scene calibration: #queueJob redraws colliding ids, matching align(). Noted that the static allowlist already keeps .calibrating from being served.
- Room align staging would break E18: evals/rooms_api.mjs:346 asserts `--out <rooms>/<room>` in the recorded argv, and evals/ belongs to the evals track. Added dependency evals-rooms-api-align-out and put it in contract_change. Checked that align-room, fixtures/stub_calib.py and server/test/rooms-calib.ts all create --out and that the §4.9 mock key ignores --out. Added a startup sweep of rooms/.align/, since a SIGKILL mid-run leaves a folder behind.
- Library shutdown: dropped holdForToday/release at shutdown. SpendCap reservations are in memory and die with the process, so those calls do nothing. Also dropped the 'SpendCap holds in live mode' proof, because tests never run live.
- Library shutdown, money: pipeline/src/cli.ts's SIGTERM handler only runs cleanUp(). It writes no cost row for a charged, uncommitted add, so SIGTERM at shutdown would turn an orphan that records its own row into an unrecorded fal charge. Added dependency pipeline-interrupt-cost-row (match the pipeline group's actual package id for its paid-call / interrupt cleanup fix). Queued jobs are simply not started after shutdown.
- Render: replaced 'try/catch that deletes -input/-raw/.jpg then rethrows' with 'spawn-error in #align returns alignFailed' (the function's own comment says any failure is not applied). Deleting the files would throw away a live render already billed and in costs.csv. The new rule departs from v1's 500 on purpose; record it in docs/notes/server.md. render.ts and render.test.ts have uncommitted upscale changes in the working tree: rebase onto them first.
- Proofs made concrete: the CalibRunner one-shot shutdown test now uses rooms-calib.ts without ROOMS_CALIB_SERVE plus ROOMS_CALIB_DELAY_MS (that mode already exists), not an unspecified 'hang-equivalent'. The chmod-based tests restore permissions in a finally. The scene-folder proof no longer claims a retry path that does not exist; it only checks that trash.json survives on disk.
- Align ids: the SerialQueue machine is split between packages. Room-side redraw goes to room-align, queueTask's duplicate check to scene-jobs (it checks #tasks or #work). Their files stay disjoint; tscert/baseline.json is shared-append. No make-explicit decisions to downgrade. The defers (placement, lighting) involve no money, data loss or hang, so they stay.

</details>

### product (server)

Shared in this group:
- Injectable clock and worker spawner for tests: Deadline(now = () => performance.now()) in server/src/product/errors.ts and SizeWorker(spawn = () => new Worker(WORKER_URL)) in server/src/product/sizes.ts, so the timing tests are driven, not slept, and the worker test needs no wasm
- Stale-handle guard for child workers: every listener bound in #start returns unless `w === this.#worker`, and removeAllListeners() runs before terminate(); the server-domain warm calib worker fix (server/src/scenes/calib.ts Worker) can reuse the same shape
- Hold-for-today on an unrecorded or possibly-billed paid call: deps.spend.holdForToday(key) instead of release (server/src/spend.ts:106), as the library add timeout already does; product-read-clocks uses it in llm.ts
- Tests that call the product reader directly (product-read, product-llm) need build/wasm/product: they fail fast with 'run npm run build' when it is missing (npm run check builds it in check:types); the local page server lives inside product-read.test.ts, not in the shared server/test/helpers.ts

Packages: `product-size-worker`, `product-read-clocks`, `product-parser-guards`

#### Page/Driver SAX parser: tag stack with closers, skip/out counters, capture buffers, namespace stack

**fix**, effort S · `server/src/product/html.ts`, `server/test/product-html.test.ts`

Closes:
- self-closing <svg/> or <math/> leaves the Driver in foreign content, so <script>/<style>/<title> are not raw text and inline JSON with '<' is tokenized as markup until the next breakout tag

**Design:** In Driver.onStartTag (server/src/product/html.ts:347-375) remember whether this token entered a namespace (`const entered = SVG or MATH`), keep the attribute adjustment as today, and after `this.#page.start(...)`/`this.#page.end(tag)` call `this.#leave()` when `entered && token.selfClosing` (the spec pops a self-closing foreign element at once), so the namespace stack matches the Page, which already gets start+end. Nested `<svg><svg/></svg>` then enters twice, leaves twice. The other listed risks (the 4000 bottom eviction popping the innermost item and finalizing out/title/h1/capture early, the 64-entry window in end() and #in(), <base> rewriting mid-parse, ParseStopped returning without close()) are v1's _Page, kept per contract §0; say so in a comment on Page in html.ts (this package's own file), not in a shared notes file. Note: svg/math as foreign content at all is v2's chosen HTML5 tokenizer behaviour (the file header lists it); v1's html.parser read <script> inside <svg> as CDATA too. That wider divergence is not changed here.

**Proof:** server/test/product-html.test.ts (node:test, no wasm, no server: parsePage directly with tick = async () => {}): parsePage('<html><body><svg/><script>var p={"size":"<b>200 x 90 cm</b>"}</script><p>after</p>', 'https://shop.test/p', tick) puts the whole script text in page.scripts and 'after' in page.lines; it fails before the fix (the script body is tokenized as tags). Parity cases unchanged: '<svg><path/></svg><script>a<b</script>' and '<svg><svg/><title>x</title></svg>'. Gates: check:types, check:lint, check:dead, check:tests. Eval: E14 eval:product (every manifest case still matches) through the eval lock.

#### SizeWorker: shared off-thread size-reader worker and its job queue

**guard-only**, effort M · `server/src/product/sizes.ts`, `server/test/product-size-worker.test.ts`

Closes:
- queued job B times out behind A and kills the worker running A (TOO_LONG it did not cause, A redone)
- #restart(e, failed) terminates whatever job is executing, not the failed one
- late 'error' from a terminated worker restarts/rejects the NEW worker's jobs (listener leak)
- no 'exit' handler: a worker that exits silently leaves jobs pending until their timers cascade
- re-posted jobs keep only the remainder of their budget (gone: nothing is re-posted any more; each job's timer is the request's own absolute deadline, by design)

**Design:** All in server/src/product/sizes.ts, no new module. SizeWorker keeps `#running: Job | null` and `#queue: Job[]` instead of the one #jobs array, and posts lazily: run() pushes the job and calls #pump(); #pump() posts the queue head only when #running is null, so the job the worker is executing is always exactly #running. Per-job timer (still Math.max(1, timeoutMs) at enqueue: the request's own 10 s deadline, so a fresh worker does not grant more; comment that): if job === #running -> reject WorkerTimeout, #replace(), #pump(); else remove it from #queue and reject WorkerTimeout, worker untouched. #start(spawn) binds 'message', 'error' and 'exit' on w; each listener first returns unless `w === this.#worker`. 'message': resolve only when id === #running.id, then #running = null, #pump(). 'error'(e) / 'exit'(code) while it is the current worker: reject #running (with e, or Error('the size reader stopped (exit <code>)')), #replace(), #pump(); the queued jobs are kept (they did not cause it). #replace(): w.removeAllListeners(); void w.terminate(); #worker = null (the next #pump spawns). The constructor takes `spawn: () => WorkerLike = () => new Worker(WORKER_URL)` with a minimal WorkerLike interface (on, postMessage, terminate, unref, removeAllListeners), and the class is exported for the test; the module-level `const worker = new SizeWorker()` stays. size-worker.ts unchanged. Left as is: `loaded` caching only on success (a missing build is an operator error with a clear message). The lazy post costs one message round trip per queued job, negligible next to the 200k-char jobs that use the worker.

**Proof:** server/test/product-size-worker.test.ts (node:test, in npm run test:server, needs no wasm: importing sizes.ts loads the wasm lazily). A fake WorkerLike (an EventEmitter recording postMessage/terminate) through the spawn argument. (1) run A (timeout 1000) then B (timeout 50): only A is posted; when B's timer fires B rejects WorkerTimeout, terminate() was not called, and A resolves when the fake answers A (before the fix: terminate() called, A re-posted to a second fake). (2) A times out while running: A rejects, the fake is terminated, B is posted to a new fake; then emit 'error' and 'exit' on the OLD fake: B is unaffected (before: B rejected). (3) emit 'exit' (no 'error') on the running fake: the running job rejects at once, the next job is posted to a fresh fake. (4) a 'message' with a stale id is ignored. Use node:test mock.timers for the timers. Gates: check:types, check:lint, check:dead, check:tests. Eval: E14 eval:product (its slow-page responsiveness case) through scripts/eval-lock.mjs; eval:perf product numbers unchanged.

**Why:** Downgraded from make-explicit: two fields (#running, #queue), lazy posting and a stale-worker identity check close every listed risk; a separate pure step() module plus a TScert baseline entry would duplicate the same five rules and the fake-worker test already exercises them.

#### Product read pipeline with two overlapping clocks (Budget 20 s, Deadline 10 s) and exception-typed outcomes

**guard-only**, effort M · `server/src/product/errors.ts`, `server/src/product/read.ts`, `server/src/product/extract.ts`, `server/test/product-read.test.ts`, `docs/notes/server.md`

Closes:
- feed fetches (bounded by the 20 s Budget) use up the 10 s extraction Deadline, so slow feeds end in TOO_LONG
- the post-LLM deadline.tick() (extract.ts:380) throws TOO_LONG and discards a paid answer whose cost row is written
- Deadline.remaining() before start() returns a magic 10_000

**Design:** In errors.ts Deadline takes an optional `now: () => number = () => performance.now()` used everywhere it reads the clock; remaining() before start() returns the EXTRACT_MS constant (moved to errors.ts and exported; read.ts imports it) instead of a literal. Add (a) `async suspend<T>(work: () => Promise<T>): Promise<T>`: runs work and moves #at later by the time it took, so the clock stops while the Budget-bounded feeds load; (b) `settle()`: afterwards check() never throws and remaining() returns EXTRACT_MS (still a bounded worker timeout, which matters for a large rug page whose thicknessAsync would otherwise get a 1 ms worker timeout and 422 after a 60 s LLM call). read.ts readFetched: `await deadline.suspend(() => readFeeds(doc, raw, budget, warnings))`. extract.ts: right after `const got = await runLlm(...)`, `if (got.asked) deadline.settle()`. readProduct takes an optional 5th arg `options: { readonly now?: () => number; readonly extractMs?: number } = {}` (test-only) passed to new Deadline and to the two start() calls. Both are deliberate changes from v1 (v1 set its deadline before _feeds, and ticked after the LLM only inside _thickness for rugs); the contract's wording ('the work after the download is bounded too (10 s)') reads feeds as download, so the change matches §2.11 better. Record both in docs/notes/server.md. Left as is: no cancellation (no AbortSignal in the HTTP ctx, v1 had none; needs a server-infra ctx.signal first), and the outcome mapped by exception class (any other Error -> logged COULD_NOT_READ is v1's `except Exception`).

**Proof:** server/test/product-read.test.ts (node:test; sets MIDSTUDY_FAL_MOCK=fixtures/fal, MIDSTUDY_NO_DOTENV=1, NOOK_NO_DOTENV=1 and MIDSTUDY_FETCH_ALLOW=127.0.0.1:<port> for a local page server it starts itself; needs build/wasm/product, so before() fails with 'run npm run build' when it is missing, and npm run check builds it in check:types first). Clocks are driven, not slept: (1) a Shopify-looking page whose /products/x.js feed handler advances the injected now() by 11 s before answering -> 200 with 'shopify' in source_layers_used; before the fix 422 TOO_LONG. (2) a pasted page with no size (the mocked LLM answers from fixtures/fal), a deps.spend wrapper whose reserve() advances now() by 11 s -> 200 with 'llm' in source_layers_used and a product:llm row in the test's costs.csv; before the fix 422 TOO_LONG with the row already written. (3) Deadline unit cases with a fake now: remaining() before start() is EXTRACT_MS, suspend() shifts the deadline by the work's time, settle() stops check() and pins remaining(). Gates: check:types, check:lint, check:dead, check:tests. Evals: E14 eval:product (TOO_LONG and slow-page cases) and eval:ui-smoke's product form, through the eval lock.

#### LLM layer: spend hold / call / cost row / release

**guard-only**, effort S · `server/src/product/llm.ts`, `server/test/product-llm.test.ts`

Closes:
- appendCost throwing after a real call releases the hold, so the charge is neither held nor recorded
- a fal timeout (FalError 'could not reach fal') is recorded as cost 0 and released though fal may have billed
- a paid answer discarded by the post-LLM tick (closed by the read-pipeline fix's deadline.settle())

**Design:** In llm.ts runLlm, keep v1's order (reserve, then llmTextAsync, then the call). Replace the unconditional finally release with `let keep = false` and `finally { if (keep) deps.spend.holdForToday(hold); else deps.spend.release(hold) }`. (1) In the live branch's `catch (e)` for FalError: set keep = true (any FalError from falCall: the timeout and transport cases cannot be told apart from the message without changing common/fal.ts, which the pipeline group's Fal.charged fix may also touch; over-holding LLM_RESERVE until the end of the UTC day is the conservative side of the cap, and only the cap view changes, never costs.csv). (2) Wrap appendCost in try/catch: on throw set keep = true, push the warning 'the cost of the language model could not be recorded: it is held against today's cap', log it to stderr, and go on to parse and return the answer. The mock path holds only under MIDSTUDY_FAL_MOCK_COST=1 (countsAgainstCap), as now. Dropped from the plan: reserving after llmTextAsync. When the cap refuses, that order would run llm_text for nothing and could turn v1's 200-with-'skipped' warning into a 422 TOO_LONG on a large page, and holding the reservation for the worker wait costs at most a few seconds of a few cents of cap.

**Proof:** server/test/product-llm.test.ts (node:test; MIDSTUDY_FAL_MOCK=fixtures/fal, MIDSTUDY_FAL_MOCK_COST=1, MIDSTUDY_NO_DOTENV=1; needs build/wasm/product as product-read.test.ts does): runLlm with ServerDeps built in the test, a real SpendCap over a valid scratch costs.csv in evals/out/, and deps.config.costsFile set to a directory so appendCost throws (the SpendCap must keep its own valid file, or reserve() fails reading it first). Afterwards spend.view() still shows LLM_RESERVE held for today and the result carries the warning and the parsed sizes (before: 0 reserved, no row). The FalError branch cannot be reached with fal mocked (falCall is not injectable): checked by review, and E14's spend-cap cases (0.0015 and 0.03) and GET /api/spend show the mock path unchanged. Gates: check:types, check:lint, check:dead, check:tests. Eval: E14 eval:product through the eval lock.

**Why:** The 'reservation held across the worker queue wait' risk is wont-fix: v1 order, at most seconds of hold, and the reorder that would close it changes a refused-cap answer from 200 to a possible 422.

#### Sizes accumulator: first-writer-wins shop variants and candidate layers

**guard-only**, effort S · `server/src/product/layers.ts`

Closes:
- shopifySizes assigns sz.variants without the length===0 guard, correct only because extract calls it first

**Design:** In layers.ts shopifySizes, add `if (sz.variants.length > 0) return` right after `if (f === null) return`, before any parseSize call (as wooSizes guards before parsing, so no parse warnings are added for options that would be dropped). With today's call order (Shopify first) sz.variants is always empty there, so the output is identical; it makes first-wins local instead of order-dependent. v1's _shopify_sizes was also unguarded.

**Proof:** Behaviour-preserving: E14 eval:product manifest cases (Shopify, Woo, JSON-LD variants) unchanged; check:types, check:lint. No new test, because no current input reaches the difference.

#### Doc enrichment: parsed page, then feeds attached later (shopify/woo nullable fields)

**wont-fix**, effort S

**Design:** None. null standing for not-read, failed or not-applicable is v1's _Doc design, and nothing reads doc.shopify/woo before readFeeds today.

**Proof:** E14 eval:product covers the pasted and fetched Shopify/Woo cases.

**Why:** Low, latent. v1 parity (contract §0). A typed enrichment state would only move the order dependency without fixing a live bug.

#### Images: deduplicating picture registry with in-place upgrades and a cap

**wont-fix**, effort S

**Design:** None. Both behaviours (the cap checked before the dedupe/upgrade, and w/h kept from the old copy when the new copy has none) are v1's _Images.add line for line.

**Proof:** E14 eval:product image expectations.

**Why:** Low. v1 parity (contract §0). It only matters past 12 pictures or for copies without sizes, and the planner re-measures pictures anyway.

#### pyLoads: iterative pushdown JSON parser (frame stack, wantValue, pending key)

**wont-fix**, effort S

**Design:** None. attach() with a map frame and key null is unreachable (the key is always read first), and a Frame with both fields null is never constructed.

**Proof:** Existing TScert certification of server/src/product/logic/pyjson.ts (check:tscert) and E14.

**Why:** Representability only. No live bug, and the module already certifies under TScert. Reshaping Frame into a union would churn the ratchet baseline for no behaviour change.

#### scriptStrings / literals: string-literal lexer and bounded walk

**wont-fix**, effort S

**Design:** None. The 400 cap checked at walk entry is v1's (`if depth > 40 or len(out) > 400: return`). literals() scans eagerly where v1's generator was lazy, but the scan is linear indexOf work, and loadsLenient is as synchronous as v1's json.loads.

**Proof:** E14 eval:product's slow-page responsiveness case, and eval:perf.

**Why:** Low. The non-yielding spans are linear and bounded by the 10 MB page cap. The cap overshoot is v1 behaviour.

#### text_readings: line scanner with prev_line/prev_end context, lazy RestIndex, and singles grouping

**wont-fix**, effort S

**Design:** None. prev_end advancing before the distract/unitless checks, and the raw-line-index gap in group_singles (`s[0] - group[-1][0] > 2`), are both v1's _text_readings.

**Proof:** cargo test -p midstudy-product (check:rust), and E14.

**Why:** Low, v1 parity (contract §0). Changing either would change which sizes are read on real pages.

#### Item finditer and chain accumulation (cur chain up to 3, unit spread, order-key axes)

**wont-fix**, effort S

**Design:** None. body() never sets ft/ftin and num together, and make_item's preference for feet is unreachable.

**Proof:** core/crates/product/tests/{properties,adversarial}.rs, and the fuzz target (check:rust, check:fuzz).

**Why:** Representability only, no live path. The crate is fuzzed already.

#### thickness: first-found slots for 'thickness' vs 'pile'

**wont-fix**, effort S

**Design:** None. v1's _thickness does the same: best.setdefault(kind, ...), then best.get('thick') or best.get('pile'), with a bare 'height' of 5 cm or less in the thick slot.

**Proof:** cargo test -p midstudy-product.

**Why:** Low, v1 parity (contract §0).

#### finish: merged-candidate accumulator with in-place replacement and variant index lookup

**wont-fix**, effort S

**Design:** None. The twin replacement by tolerance, and truncation to MAX_CANDIDATES before the variant lookup, are v1's merge loop (checked against v1's _extract: `cands = cands[:MAX_CANDIDATES]` after the twin loop).

**Proof:** cargo test -p midstudy-product, and E14 variant dims_index expectations.

**Why:** Low. It needs three readings in a non-transitive tolerance chain, or more readings than MAX_CANDIDATES. v1 parity.

#### py_ci regex translator (in_class mode) and LazyLock pattern statics

**wont-fix**, effort S

**Design:** None. words.rs notes that the tests compile every pattern, so a pattern edit that falls back to the never-matching regex fails cargo test.

**Proof:** cargo test -p midstudy-product (check:rust).

**Why:** Latent. No current pattern triggers it, and the existing compile-every-pattern tests are the guard.

#### OpenGraph image accumulator: 'current og:image' open until the next og:image

**wont-fix**, effort S

**Design:** None. Attaching og:image:secure_url/width/height to the last og:image, with a later value overwriting, is v1's _extract metas loop (product_page.py `elif og and k == "og:image:width"`).

**Proof:** E14 eval:product opengraph cases.

**Why:** Low, v1 parity (contract §0). Wrong dimensions only affect a picture's reported w/h, not its URL choice, except for secure_url, which needs a second unrelated og block.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 15 '### ' machines in '## product' have exactly one entry; none added.
- SizeWorker downgraded make-explicit -> guard-only: #running + #queue with lazy posting, an identity check on every listener, and an 'exit' handler close all five risks. The separate pure logic/size-queue.ts and its tscert/baseline.json entry (a shared-append file) are dropped as duplication. Traced: with eager posting the worker runs FIFO, so the old code could not tell the running job from a queued one; with lazy posting it can, and a queued timeout now only drops that job. 'exit' after terminate() or after an 'error' is ignored because the old worker's listeners are removed and fail the identity check. A crash now rejects only the running job, not every request's jobs.
- LLM: dropped the 'reserve after llmTextAsync' reorder. It is not harmless: when the cap refuses, v1's order skips llm_text, and the new order would run it anyway and could turn a 200 'skipped' answer into a 422 TOO_LONG on a large page. That risk is now wont-fix (seconds of hold, v1 order).
- LLM: the FalError hold no longer tries to tell timeout from 4xx by message text. FalError has no kind field, and adding one means editing common/fal.ts, which the pipeline group's Fal.charged fix may touch. Any live FalError now holds LLM_RESERVE for the day: conservative for money, it changes only the cap view, never costs.csv. This is a deliberate divergence from v1 (v1 released) and goes in docs/notes/server.md.
- LLM proof corrected: a SpendCap whose costs file is a directory makes reserve() throw (spent() reads the file) before appendCost is reached. The test must give SpendCap a valid file and point deps.config.costsFile at a directory. Moved to its own server/test/product-llm.test.ts, so the two tests don't both edit product-read.test.ts.
- Read clocks: confirmed against v1's product_page.py (git 95087a8^). v1 set the deadline before _feeds and ticked after the LLM only inside _thickness (rugs), so both changes are behaviour changes from v1. They are kept because contract §2.11's 'the work after the download is bounded too (10 s)' reads feeds as download, and a paid, recorded answer thrown away is money. They must be written up in docs/notes/server.md, which is now in this package's files. settle() also pins remaining(): without it, a large rug page after a 60 s LLM call would give thicknessAsync a 1 ms worker timeout and still answer 422.
- Read-clock proofs changed from real sleeps (a 400 ms feed against a 200 ms extractMs) to an injected now() that jumps 11 s, so they are deterministic under eval-lock load. They also need build/wasm/product, which check:tests alone does not build: fail fast with a message.
- Parser: the fix leaves after the Page start/end pair instead of skipping #enter, so the SVG/MathML attribute adjustment still runs; nested <svg><svg/></svg> stays balanced. The v1-parity list for the other parser risks moves from docs/notes/server.md to a comment on Page in html.ts, which keeps the packages' files disjoint. Noted, not changed: v2 treats <script> inside a non-self-closing <svg> as foreign (not CDATA), unlike v1's html.parser. That is v2's documented HTML5-tokenizer choice.
- Shopify guard placed right after `if (f === null) return`, before parseSize, matching wooSizes. The output is identical today.
- Shared helper in server/test/helpers.ts dropped: product-html.test.ts needs no page server, and helpers.ts is shared with the other server groups.
- Packages: files now disjoint within the group (docs/notes/server.md only in product-read-clocks). check:dead added to product-parser-guards (it adds a test entry). The dependency on server-infra-spend-cap is kept (it owns spend.ts holdForToday/reserve semantics) but its id was not verified against the server-infra plan. Across groups: docs/notes/server.md may also be written by the server-infra and server-domain packages, so whoever merges unions it.
- All files are within the server track (server/**, plus the track's own docs/notes/server.md); no contract change.

</details>

### pipeline (pipeline)

Shared in this group:
- Prepare-then-commit: library.ts prepareUpsert(libDir, item) loads library.json fresh, merges as v1 and strict-validates, returning the text; writeLibrary(libDir, text) is the sync atomic write. add() and refit() validate the library and the summary before touching any file.
- Swap with rollback, all within the library folder: pipeline/src/commit.ts swapIn() (cross-volume move into <lib>/.incoming-<id>-*, rename itemDir -> .replaced-<id>-*, carry raw/, rename incoming -> itemDir, undo in reverse on any throw; injectable fs ops for the test). refit uses hard-link backups beside the originals the same way. Staging stays in TMPDIR, so the existing interrupt tests hold.
- One signal policy in cli.ts: outside a paid run and outside the commit section, today's immediate cleanUp+exit; inside the commit section, defer to its end; inside a live paid run, abort LiveFal's stop signal and have tick() throw Interrupted so the paid branch records the cost and keeps the outputs. A second signal always exits at once.
- LiveFal owns its billing state: charged=true for any failure after a successful submit except a job refusal answered by the result GET; injectable stop, sleep and now make the interrupt and the deadline testable with a fake fetch and a dummy key string (never .env).

Packages: `pipeline-fal-client`, `pipeline-commit`, `pipeline-splat-fit`

#### Paid-call accounting (Fal.charged)

**fix**, effort M · `pipeline/src/fal.ts`, `pipeline/src/errors.ts`, `pipeline/test/fal.test.ts`, `pipeline/src/cli.ts`, `pipeline/test/lock.test.ts`

Closes:
- job completes on fal (billed) but the result GET fails: charged stays false, no cost row, staging deleted
- SIGINT/SIGTERM while awaiting the queue poll removes staging and exits with no cost row for a billed job
- (added) SIGINT/SIGTERM after runEngine returned (fetch of outputs, normalize, spz) of a paid run deletes staging with no cost row

**Design:** fal.ts LiveFal.call: once the submit POST succeeded, any later failure sets `this.charged = true` before rethrowing, EXCEPT an HTTP error status answered by the result GET (the job's own failure: NoMasks and other refusals, uncharged as v1 says 'a refused call isn't charged'). So poll transport failures, result-GET transport/JSON failures, the deadline and an interrupt all count as charged (overstating is the safe side for the daily cap). run()'s `fal.charged = true` stays (MockFal). LiveFal takes an optional `stop: AbortSignal` (constructor, after fetchFn/sleep/now); #sleep, #send and LiveFal.fetch's download race it; when it fires after submit, charged=true and it throws `Interrupted` (new MidstudyError subclass in errors.ts, message 'interrupted'). cli.ts (commit package): a module `paidRun` flag set from runEngine start until the commit ends for a live fal engine; while it is set, SIGINT/SIGTERM do not exit: they abort the controller and set `interruptRequested`, and tick() throws Interrupted when that flag is set, so the paid branch keeps outputs in _failed/ and appends the cost row, then rethrows Interrupted; main() maps Interrupted to 'midstudy-add: interrupted', exit 130 (SIGTERM: remove the listener and re-raise after unwinding). A second signal falls back to today's immediate cleanUp+exit. Mock runs keep today's handlers exactly. Departure from v1 (whose KeyboardInterrupt skipped the cost row): note it in docs/notes/pipeline.md.

**Proof:** fal.test.ts (fake fetch, injected sleep/now, no network, no key from .env: a literal dummy string passed to the constructor): submit ok, COMPLETED, then the result GET rejects with a TypeError or returns non-JSON -> before the fix charged is false; after, true and the MidstudyError sentence unchanged. Submit ok then a poll that fails all attempts -> charged true. Result GET answering 422 with 'produced no masks' -> NoMasks, charged false. stop aborted during polling -> Interrupted, charged true; aborted before submit -> charged false. The cli-level live path is not tested end to end (it would need a fal base-URL override and a key, both off-limits); lock.test.ts keeps proving the mock SIGINT/SIGTERM behaviour unchanged. Gates: check:tests, check:types, check:lint; eval:pipeline through the eval lock.

#### HTTP retry/backoff with backup-domain fallback

**fix**, effort S · `pipeline/src/fal.ts`, `pipeline/test/fal.test.ts`

Closes:
- one AbortSignal.timeout is reused for the backup request, so after a primary timeout the backup fails at once
- non-idempotent POSTs retried (closed by the queue-job fix)

**Design:** fal.ts #send: a fresh AbortSignal.timeout(timeoutMs) for the backup-host request instead of the primary's, combined with the stop signal via AbortSignal.any (Node 22). Skipped entirely for the submit (idempotent=false, queue-job fix). The up-to-MAX_ATTEMPTS bound stays (fal-client's policy).

**Proof:** fal.test.ts: a fake fetch that hangs on queue.fal.run until its signal aborts and answers the backup host at once, timeoutMs small (e.g. 20 ms) on a GET poll -> before the fix the backup sees an aborted signal and fails; after, it succeeds. Gates: check:tests, check:types, check:lint.

#### PLY header parse and column-index cache during splat fit

**fix**, effort S · `core/crates/splat/src/fit.rs`

Closes:
- stale ix computed before drop_props(f_rest_*) and used after it: wrong columns or an out-of-range panic (wasm trap) when f_rest_* precede x/y/z
- find() takes the first 'end_header' anywhere, including inside a comment

**Design:** core/crates/splat/src/fit.rs normalize(): after `ply.drop_props(&names)` in the f_rest branch (line ~235), recompute `let ix = [col(&ply, "x")?, col(&ply, "y")?, col(&ply, "z")?];` (shadowing) before the self-check read-back at line ~244, and recompute any other column index read after the drop. Leave ply.rs find() as v1's raw.find(b"end_header") (contract §0); the note goes into docs/notes/pipeline.md via the pipeline-commit package so this package touches only Rust.

**Proof:** cargo test -p splat (in fit.rs's test module): a binary PLY whose properties are f_rest_0..f_rest_2 then x,y,z,scale_0..2,rot_0..3,opacity, normalized with a 90-degree yaw (rotated=true so f_rest is dropped) -> before the fix it panics or reports a wrong extent; after, the self-check extent equals the target dims within tolerance. Run (cd core && nix develop ..#default -c cargo test -p splat). Gates: npm run check:rust, check:fuzz for the splat targets (MIDSTUDY_FUZZ_SECONDS), then eval:splat and eval:pipeline through the eval lock (the harness rebuilds the wasm).

#### CDN upload token cache and CDN -> storage fallback chain

**fix**, effort S · `pipeline/src/fal.ts`, `pipeline/test/fal.test.ts`

Closes:
- a token rejected while locally unexpired is never invalidated, so the mask upload repeats the failing CDN attempt

**Design:** fal.ts upload(): in the CDN catch set `this.#token = null` before falling back to the storage upload, so the next upload (the SAM 3D mask) fetches a new token. Keep the bare catch's fallback (fal-client, v1).

**Proof:** fal.test.ts: two uploads with a fake fetch whose CDN upload answers 401 for token A (storage fallback succeeding) -> before the fix one token request in total; after, two. Gates: check:tests, check:lint.

#### midstudy-add item build/commit lifecycle (staging -> item folder -> library.json -> costs.csv, or _failed/)

**guard-only**, effort M · `pipeline/src/cli.ts`, `pipeline/src/library.ts`, `pipeline/src/commit.ts`, `pipeline/test/commit.test.ts`, `docs/notes/pipeline.md`

Closes:
- non-atomic replace: rmtreeChecked(itemDir) before a move that can cpSync across volumes (EXDEV) leaves the old item gone and a partial itemDir
- old raw/ moved into staging is lost by the finally when the later move fails
- after committed=true an upsert/appendCost error leaves an item folder with no library entry, or an entry with no cost row for a paid call
- appendCost throwing inside the paid branch loses the _failed/ outputs (finally deletes staging) and the cost row
- strict printSummary violation after commit reports a successful add as a failure

**Design:** Keep v1's write order (item folder -> library.json -> costs.csv) and its messages; add guards instead of a phase machine. (1) Prepare, before anything in the library is touched: library.ts splits upsert into `prepareUpsert(libDir, item): Promise<{text, replaced}>` (loads library.json FRESH itself, merges as v1, strict-validates) and sync `writeLibrary(libDir, text)` (atomicWriteSync); upsert() stays as prepare+write for any other caller or is removed if knip says unused. cli.ts add() also builds the summary value (paths are known in advance: raw = staging/raw exists or the own-raw carry applies) and runs its strict validate here; printSummary becomes a sync print of a pre-validated value. (2) Commit via a new I/O helper pipeline/src/commit.ts (not logic/: it does fs work) `swapIn(staging, itemDir, libDir, carryRaw, ops = realFs)`: move(staging, incoming=`<lib>/.incoming-<id>-<rand>`) (the only step that may cpSync across volumes; a failure leaves the old item untouched); if itemDir exists rename(itemDir, aside=`<lib>/.replaced-<id>-<rand>`); if carryRaw rename(aside/raw, incoming/raw); rename(incoming, itemDir). Any throw undoes completed steps in reverse (raw back into aside, aside back to itemDir) and reports where the new outputs now are (staging or incoming) so the paid branch can keep them. `ops` (rename/move/exists) is injectable for the test. Then writeLibrary (sync, atomic; on throw: undo the swap), then `await appendCost(...)`, then rmtree(aside). Dot-prefixed names are never slugs, so they cannot collide with item ids. (3) Replace `committed` with two booleans: `swapped` and `costRecorded`. catch: paid (live && fal.charged) && !costRecorded -> FIRST move the outputs (staging, or incoming after a failed swap) to _failed/<id>-<stamp>, THEN appendCost inside its own try (a failure there is appended to the message, outputs stay kept); a paid failure after costRecorded rethrows as v1; Interrupted is rethrown as Interrupted after recording (see the paid-accounting fix). (4) A crash (SIGKILL) inside the microsecond rename window could leave .replaced-<id>-*; note it in docs/notes/pipeline.md rather than adding a sweep. Signals during the commit window are handled by the interrupt fix (deferral), so no await-free requirement is needed for correctness.

**Proof:** pipeline/test/commit.test.ts (node:test, run by test:pipeline's glob): (a) swapIn with an injected ops that throws at step k for every k in 1..4 over a temp library holding an existing item with raw/ -> after each, either the old item (bytes and raw/) is exactly in place and no .incoming/.replaced remains, or the new item is fully in place; the returned outputs path exists. Run against the current sequence (rmtree then move with a throwing move) first to show the old item is lost. (b) child-process add with MIDSTUDY_FAL_MOCK=fixtures/fal, MIDSTUDY_NO_DOTENV=1, NOOK_NO_DOTENV=1, MIDSTUDY_STRICT=1 over a library.json carrying a schema-violating extra item -> exit 1, no item folder, library.json byte-identical. (c) prepareUpsert reads library.json at call time: load(), then write a second item into the file, then prepareUpsert -> both items in the text. Gates: nix develop -c npm run check:tests, check:types, check:lint, check:dead, MIDSTUDY_TRACK=pipeline npm run check:ownership; nix develop -c node scripts/eval-lock.mjs -- npm run eval:pipeline and -- npm run eval:library; lock.test.ts interrupt tests unchanged.

**Why:** Downgraded from make-explicit: two booleans plus a swap helper with rollback close every listed risk; an AddPhase type with a TScert failurePlan adds a module and a baseline entry for a five-line decision.

#### Live fal queue job (submit -> poll with logs -> poll -> result)

**guard-only**, effort S · `pipeline/src/fal.ts`, `pipeline/test/fal.test.ts`

Closes:
- no deadline: a stuck IN_QUEUE/IN_PROGRESS job polls forever holding the library lock until another writer reclaims it as too-old
- submit POST retried on transport errors/timeouts can enqueue the job twice (both billed, one recorded)

**Design:** fal.ts LiveFal.call: a deadline for the submit+poll+result sequence, QUEUE_DEADLINE_MS = 45 min, measured with an injectable `now` (constructor arg); past it throw MidstudyError(`fal call to <ep> failed (still <status> after 45 min)`) with charged=true. 45 min (not 50) leaves room inside the server's ADD_TIMEOUT_S = 3600 s, which SIGKILLs the tool (common/tools.ts) so no handler could record the row, for the output downloads (300 s timeout each) and the fit; it also stays below LOCK_STALE_MS. #request and #send gain `idempotent: boolean`; false only for the queue submit: no retry on a transport error or timeout AND no backup-host fallback in #send (that fallback is a resend too); the 408/409/429/nginx-5xx status retries, which mean 'not accepted', stay. The CDN upload and storage initiate POSTs are free, so they keep fal-client's policy. Record the departure from fal-client in docs/notes/pipeline.md (written by the commit package).

**Proof:** fal.test.ts: a fake fetch answering IN_PROGRESS forever with an injected now advancing 1 min per sleep -> before the fix the test times out; after, the deadline sentence and charged=true. A submit whose fetch rejects with a TimeoutError/TypeError -> exactly one submit request seen across both hosts and the call fails; a 429 then 200 submit is still retried once. Gates: check:tests, check:types, check:lint.

#### --rescale refit: multi-file in-place replace then library upsert

**guard-only**, effort S · `pipeline/src/cli.ts`, `pipeline/src/library.ts`, `pipeline/test/commit.test.ts`

Closes:
- replace of splat.ply/splat.spz or upsert (strict validation) fails after model.glb was replaced: files refit, library.json keeps old dims/fit
- a SIGINT during upsert's await after the replaces leaves the same mismatch
- a later --rescale --yaw applies yaw to partly rotated files
- (added) strict summary validation in rescale() runs after the refit is committed

**Design:** cli.ts refit(): after the staging build, build the updated item and `await prepareUpsert(libDir, item)` and validate the rescale summary value BEFORE any replace; then commit synchronously with no await: back up each existing original by fs.linkSync to a sibling `.<name>.bak-<rand>` in the same item folder (same file system, so a hard link always works; skip a splat.spz that does not exist yet, pre-v1.1 items), replace model.glb, splat.ply, splat.spz, writeLibrary(libDir, text). Any throw restores the backups over the originals in reverse order (and removes a new spz that had no original) before rethrowing; on success unlink the backups. No await between the first replace and the library write, so a signal cannot land in between; the third risk follows. rescale() then prints the pre-validated summary.

**Proof:** commit.test.ts (child process, fal mocked): add a mock sam3d item (has a splat), then make its splat.spz path a directory so the third replace fails (EISDIR), run --rescale --yaw 90 -> before the fix model.glb and splat.ply changed and library.json did not; after, model.glb and splat.ply byte-identical, library.json unchanged, no .bak left. MIDSTUDY_STRICT=1 with a schema-violating library -> exit 1 and no asset file changes. Gates: check:tests, check:types, check:lint; eval:pipeline (rescale cases) through the eval lock.

#### Interrupt/cleanup lifecycle (scratch set, tick() interrupt points, SIGINT/SIGTERM)

**guard-only**, effort S · `pipeline/src/cli.ts`, `pipeline/test/lock.test.ts`

Closes:
- a signal at the awaits after commit (upsert validate import, appendCost lock wait, printSummary validate) leaves an item folder without library entry or cost row
- a signal while awaiting a live fal call deletes staging and exits with no cost row
- process.exit(130) bypasses finally blocks; correctness relies on scratch matching the finally logic

**Design:** Two small guards in cli.ts, no new registry: (1) a commit critical section: a module `inCommit` flag set from swapIn through appendCost (add) and over the refit commit; a signal arriving while it is set is remembered (`pendingSignal`) and acted on in the section's finally (cleanUp + exit 130, or re-raise SIGTERM), so library entry and cost row always follow the item folder; a second signal during the section exits at once as today (the escape hatch if the costs lock is held forever). Validation already moved before the commit (commit fix), so the only await left in the section is appendCost. (2) the paid-run unwind of the paid-accounting fix (tick() throws Interrupted while a live paid run is active). Outside both windows cleanUp's 'delete staging, release locks' is correct as today. scratch stays a Set: with the commit synchronous or deferred, no signal can observe .incoming/.replaced/.bak paths, so the plan's Map<'delete'|'restore-aside'> is dropped.

**Proof:** lock.test.ts: the existing SIGINT/SIGTERM tests keep passing (exit 130, lock and TMPDIR staging gone). New case: a mock add (MIDSTUDY_STRICT=1, fal mocked) interrupted after the Nth 'midstudy-add:' stdout line for N = 1..last, each in a fresh library -> after every run either no item folder and no library entry, or the folder, the entry and a cost row; never a folder without an entry. The check is on outcomes, so signal timing jitter cannot make it flaky. Gates: check:tests; eval:pipeline through the eval lock.

#### Library snapshot held across a long locked run (lock ownership vs too-old reclaim)

**guard-only**, effort S · `pipeline/src/cli.ts`, `pipeline/src/library.ts`, `pipeline/test/commit.test.ts`

Closes:
- a live run longer than 3600 s loses the lock to another writer and its upsert writes the stale snapshot loaded at cli.ts:197, losing the other writer's changes, silently

**Design:** (1) add() keeps `load(libDir)` at the start only for v1's early 'not a version 1 library' refusal; prepareUpsert(libDir, item) loads library.json itself at prepare time, right before the commit, and refit uses it too. (2) The 45-min queue deadline bounds a live run below LOCK_STALE_MS, so this process should not be reclaimed in practice. Optional follow-up for the server track (common/lock.ts): a stillHeld(lock) check before writing; not required here.

**Proof:** commit.test.ts unit test of prepareUpsert: load(), then another writer's item is written to library.json, then prepareUpsert(libDir, item) -> the text holds both items (the old upsert(data,...) would drop it). The child-process race in the original proof (write during a mock run) is dropped: the mock answers at once, so it cannot hit the window deterministically. Gates: check:tests, check:types; eval:library through the eval lock.

#### SAM 3D 'no masks' retry ladder and mock no-mask countdown

**wont-fix**, effort S

**Design:** No change.

**Proof:** Existing fal.test.ts MockFal run() retry tests and eval:pipeline cover the ladder.

**Why:** Mock-only coupling (fetch follows its own call in run() by construction); no live risk and no current misuse.

#### JPEG marker/segment walker (pre-frame -> frame -> scans -> EOI)

**wont-fix**, effort S

**Design:** No change.

**Proof:** Existing imaging tests and fuzz targets (check:rust, check:fuzz).

**Why:** Mirrors Pillow's lazy Image.open (v1, contract §0); broken scan data is still caught before any paid call, only with a less specific sentence.

#### Entropy-coded bit reader with marker/EOF zero-fill and restart resync

**wont-fix**, effort S

**Design:** No change.

**Proof:** Existing imaging tests and fuzz targets.

**Why:** Lenient resync matches libjpeg's (warn and continue); a corrupt photo gives a degraded engine input or thumbnail, never unsafe state.

#### Progressive JPEG spectral-selection / successive-approximation state

**wont-fix**, effort S

**Design:** No change.

**Proof:** Existing imaging tests and fuzz targets.

**Why:** libjpeg also only warns on out-of-order refinement scans; malformed progressive files are theoretical here and give wrong pixels, not illegal states.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 13 '### ' machines in '## pipeline' have exactly one entry; none added.
- Commit lifecycle downgraded from make-explicit to guard-only: an AddPhase type with a TScert failurePlan in logic/commit.ts is more than the risks need. Two booleans (swapped, costRecorded), a swap helper with rollback and the paid-branch reorder close every listed risk. logic/commit.ts, the tscert/baseline.json edit and the check:tscert gate are dropped.
- Kept v1's write order (item -> library.json -> costs.csv) instead of writing the cost row first. Writing it first would leave a $0 or mock row for a failed commit of a free or mock add, which v1 never did. A signal-deferral critical section (Interrupt fix) gives the same guarantee without the reorder.
- Interrupt fix: dropped the scratch Map<'delete'|'restore-aside'>. The commit is synchronous or deferred, so no signal handler can see .incoming/.replaced/.bak paths, and a SIGKILL would bypass cleanUp anyway. Replaced it with the commit critical section (deferred signal, second signal exits).
- Paid accounting widened: the original rule (charged only once COMPLETED is seen) missed poll failures after submit. The job keeps running and bills, so charged is now set for any failure after a successful submit, except an HTTP error from the result GET (the job's own refusal, as v1). Added a missed window: a signal after runEngine returned (output fetches, normalize, spz) of a paid run also deleted staging with no cost row, so the unwind covers the whole live paid run until the commit ends, and LiveFal.fetch's download honours stop as well.
- Paid accounting: Interrupted must survive the paid branch (that branch rewrites errors into a MidstudyError with the cost suffix). The design now rethrows Interrupted after recording, so main() can still exit 130.
- Dropped the cli-level 'LiveFal against a local fake fal server' proof. LiveFal's hosts are constants, so it would need a production base-URL override, plus a FAL key loaded through the .env path, which is off-limits. Its proof is fal.test.ts with fake fetch and a dummy key string; lock.test.ts proves the mock signal path is unchanged.
- Queue deadline lowered from 50 to 45 min. The server's ADD_TIMEOUT_S (3600 s) SIGKILLs midstudy-add (common/tools.ts), so no handler could record a cost row then. The deadline must fire with room for the output downloads (300 s timeout each) and the fit. Non-idempotent handling is narrowed to the queue submit only, and also covers #send's backup-host fallback, which resends the request too. The storage-initiate and CDN POSTs are free, so they keep fal-client's policy.
- Rescale: backups are hard links beside the originals in the item folder, not in TMPDIR staging (a different volume means linkSync fails with EXDEV). A missing pre-v1.1 splat.spz is skipped. The rescale summary's strict validation also moves before the commit; it had the same after-commit failure as add.
- Library snapshot proof replaced. The mock answers at once, so a child-process race cannot hit the window reliably. The deterministic proof is a unit test that prepareUpsert reads library.json at call time.
- Commit proof made concrete: chmod tricks on the library folder fail too early or depend on the platform. swapIn takes injectable fs ops, and the test fails each step k in turn.
- Packages: errors.ts (the Interrupted class) goes to pipeline-fal-client. docs/notes/pipeline.md is written only by pipeline-commit, which also records the fal-client departures and the splat ply find() decision, so the three packages' files are disjoint. pipeline-splat-fit has no dependencies and can run in parallel. check:ownership with MIDSTUDY_TRACK=pipeline is added to every package. All evals run through scripts/eval-lock.mjs. Every file is within the pipeline track's paths, and no contract change is needed.

</details>

### kernels (kernels)

Shared in this group:
- Two new node:test scripts appended to package.json (shared-append): `test:kernels-web` (node --test --test-concurrency=1 core/crates/wasm-web/tests/*.test.ts: load.test.ts, worker-rpc.test.ts) and `test:kernels-node` (core/crates/wasm-node/js-test/envelope.test.ts), so check:tests runs face tests that today are by-hand harnesses. Each package adds only its own key, so merging unions them. Both need build/wasm (check:planner already assumes it). The files sit under core/crates/, which eslint ignores and no tsconfig includes: write erasable TypeScript only (no enums or parameter properties), since Node strips the types.
- Each test file is its own process, so it starts unloaded; within a file the load-state cases run in a fixed order (unloaded, failed, concurrent sources, loaded), because a realm cannot be unloaded.
- A fake KernelPort (records listeners, can throw from postMessage and dispatch 'message'/'messageerror') in core/crates/wasm-web/tests/worker-rpc.test.ts, reused by the serveKernels and KernelWorker cases.
- Protocol faults vs refusals: in both faces a malformed answer from our own wasm (short envelope, unknown tag, trailing bytes, a GLB without its header, a wrong-length EnvResult) throws an Error naming the face ('core/js/node.ts: …' / 'midstudy kernels: …'), while a refused input stays a Result/MediaError. One rule for web.ts and node.ts.
- Cross-group note: the planner-engine group (app track) may call the new KernelWorker.close() from engine.ts worker()'s 'error' listener. It is optional and nothing here depends on it; the cross-area 'Planner kernel worker RPC' machine is closed by kernels-web-face alone.

Packages: `kernels-web-face`, `kernels-node-envelope`, `kernels-raster`, `kernels-notes`

#### depth.png chunk-order state (decode_gray)

**fix**, effort S · `core/crates/raster/src/png.rs`, `core/crates/raster/Cargo.toml`, `core/crates/raster/fuzz/Cargo.toml`, `core/crates/raster/README.md`

Closes:
- a build that enables the `fuzzing` feature by accident accepts chunks with bad CRCs
- the module doc claims 'stricter than v1' while interleaved IDAT and bytes after IEND are accepted

**Design:** core/crates/raster/src/png.rs next_chunk: replace `cfg!(feature = "fuzzing")` with `cfg!(fuzzing)` (the cfg cargo-fuzz passes itself in RUSTFLAGS; core/Cargo.toml's workspace lints already declare it in check-cfg and raster has `[lints] workspace = true`, so clippy -D warnings stays clean). Remove the `fuzzing = []` feature and its comment from core/crates/raster/Cargo.toml and `features = ["fuzzing"]` from core/crates/raster/fuzz/Cargo.toml, so no ordinary build (wasm-web included, through feature unification) can turn the CRC check off. No other fuzz workspace (media, splat, imaging, product) depends on raster, so the cfg change only affects raster's own targets. Update core/crates/raster/README.md if it names the feature. Keep the chunk walk as is (ancillary chunks between IDATs and trailing bytes after IEND are what v1's decoder accepts); state both in the module doc next to the 'stricter than v1' list. No lockfile changes (features are not in Cargo.lock).

**Proof:** The existing BadCrc unit test (png.rs:529) still passes under `(cd core && nix develop ..#default -c cargo test -p midstudy-raster)`; add a test pinning that a PNG with an ancillary chunk between two IDATs and bytes after IEND decodes (documents the v1 parity). Gates: check:rust (Miri included: raster is in core/miri.txt), check:fuzz (the raster targets still build and skip CRCs under cargo-fuzz), golden_depth.rs; eval:occlusion (E4) through the eval lock.

#### Keep-room mask column-pass counters (two-pass dilation)

**fix**, effort S · `core/crates/raster/src/mask.rs`, `core/crates/raster/tests/props.rs`

Closes:
- the u32::MAX 'unseen' sentinel collides with a saturated reach, so a column with no set pixel turns entirely on (v1 leaves it empty)

**Design:** core/crates/raster/src/mask.rs dilate_into: change `sat` to `|r: usize| u32::try_from(r).unwrap_or(u32::MAX).min(u32::MAX - 1)`, so a reach can never equal the sentinel. A counter grows from 0 by one per row and height is bounded by MAX_PIXELS, far below u32::MAX - 1, so no other result changes. One line plus a comment.

**Proof:** New unit test in mask.rs: a 3-wide, 4-tall mask with one set pixel in column 0 and none in columns 1 and 2, left = right = 0, up = down = usize::MAX and again with up = down = u32::MAX as usize (the wasm32 value) -> columns 1 and 2 stay all 0 and column 0 is all 1 (fails before the fix: they turn all 1, on 64-bit through unwrap_or(u32::MAX) as well); a proptest in raster/tests/props.rs that dilate with a vertical reach >= height equals dilate with reach = height. Gates: check:rust (Miri too: raster is in core/miri.txt), check:fuzz; diff.mjs keepRoomMask/dilate groups; eval:render (E5) through the eval lock.

#### Planner wasm kernel load lifecycle (loadKernels / loadKernelsSync)

**guard-only**, effort S · `core/js/web.ts`, `core/crates/wasm-web/tests/load.test.ts`, `package.json`

Closes:
- a second concurrent loadKernels(source2) silently gets the first call's load
- failure is indistinguishable from never-loaded; the last error is lost
- module-level wrappers before load fail as a TypeError inside the glue instead of 'call loadKernels() first'
- loadKernelsSync during an async load throws in a way that depends on timing (kept as an explicit refusal, now documented)

**Design:** core/js/web.ts only. Keep the two globals and add two: `loadingSource: InitInput | undefined` (the source of the load in flight) and `lastError: unknown` (set in the rejection handler next to `loading = null`; cleared when loadKernels or loadKernelsSync succeeds). loadKernels(source): if `exports` is set, return the resolved `loading` whatever the source (loaded is final; as today). If a load is in flight and `source` is defined and !== loadingSource (identity), return a rejected promise 'midstudy kernels: a load from another source is already in progress'. An undefined source joins the load in flight, so engine.worker.ts's early loadKernels() followed by serveKernels(port) behaves as today, and serveKernels(self, url) re-passes the same object per request so it joins too. memory(): when !exports, the message names the last failure when there is one ('midstudy kernels: the last load failed (<msg>); call loadKernels() again'), else 'call loadKernels() first'. Add one private accessor `const api = (): typeof wasm => { memory(); return wasm }` and route every module-level wrapper's call through it (clampCamera, clampLook, wrapDeg, wrapAz, roundTo, clampElevation, rotateBy, depthScale, horizonDrag*, boxCorners, worldBounds, footprint, convexHull, hull tests, drag*, liftPlane, rulerRescale, azElOf, dirOf, turnBetween, rotateSh, irradianceAt, scaleBands, maxBandScale, splatGain, splatMultiplier, decodeDepth, keepRoomMask, dilate, envMap); type positions like `wasm.Camera` and SceneCamera's own calls (its constructor already calls memory()) stay. loadKernelsSync keeps its throw while an async load is in flight (a second instance would orphan objects made from the first; waiting is impossible synchronously); document that on the function. No new state type: the four states stay derivable from (exports, loading, lastError).

**Proof:** New core/crates/wasm-web/tests/load.test.ts (node:test, run as its own process by a new `test:kernels-web` script, `node --test --test-concurrency=1 core/crates/wasm-web/tests/*.test.ts`, so check:tests runs it; erasable TS only, since core/crates/ is lint-ignored and in no tsconfig). Top-level tests run in this order in one file, since a realm cannot be unloaded: (1) before any load, clampCamera(...) and boxCorners(...) throw /call loadKernels\(\) first/ (today: a TypeError from the glue); (2) loadKernels(new Uint8Array([0,1,2])) rejects (CompileError), then new SceneCamera(...) and clampCamera throw an error naming the last failure; (3) const a = loadKernels(goodBytes); loadKernels(goodBytes.slice()) rejects with /another source/ (today it resolves with a's load); loadKernels() (undefined) during a joins it and resolves; (4) after a resolves, kernelsLoaded() is true (a retry after a failure works) and loadKernels(anything) resolves. Gates: check:types, check:lint, check:dead, check:tests, check:planner (loadKernelsSync); worker.mjs, scripts/wasm-smoke.mjs and tests/browser/run.sh unchanged; eval:planner (E3), eval:occlusion (E4) through the eval lock.

#### Kernel worker server's lazy-load latch (serveKernels `ready`)

**guard-only**, effort S · `core/js/web.ts`, `core/crates/wasm-web/tests/worker-rpc.test.ts`

Closes:
- stuck failure: a rejected load latched in `ready` makes every later request reply ok:false until the Worker is recreated (silent permanent main-thread fallback)

**Design:** core/js/web.ts serveKernels: delete the closure latch `let ready`. Per request: `const ready = exports ? Promise.resolve() : loadKernels(source)`. loadKernels already shares an in-flight load and resets itself on failure, so a failed load is retried by the next request, which is what planner/engine.worker.ts:13's comment claims. Out-of-order replies stay correct because KernelWorker matches by id; add a one-line comment saying so. No change to engine.worker.ts.

**Proof:** core/crates/wasm-web/tests/worker-rpc.test.ts (node:test under `test:kernels-web`; its own process, so it starts unloaded). First test: over a real MessageChannel (as worker.mjs does), serveKernels(port2) with no source; in Node the glue's default fetch of a file: URL rejects, so the first KernelWorker(port1).decodeDepth(png) rejects. Await that, then loadKernels(goodWasmBytes) in the same realm; the next decodeDepth over the port resolves and equals the direct call. Before the fix the second request still rejects (the latched promise). Gates: check:tests, check:types, check:lint, check:planner; worker.mjs 8/8 and tests/browser/run.sh (the real worker in headless Chrome) still pass; eval:planner, eval:occlusion through the eval lock.

#### KernelWorker request/reply correlation (pending map + id counter)

**guard-only**, effort S · `core/js/web.ts`, `core/crates/wasm-web/tests/worker-rpc.test.ts`

Closes:
- no error/messageerror/dispose path: orphaned entries stay in #pending and a messageerror leaves loadDepth awaiting forever
- postMessage throwing inside the executor leaves its id in #pending
- a malformed reply without a numeric id is dropped and its request never settles

**Design:** core/js/web.ts. KernelWorker: (a) #call: `this.#pending.set(id, ...)` then `try { postMessage } catch (e) { this.#pending.delete(id); reject(e) }`. (b) Add `#failAll(err: Error)` that rejects and clears every pending entry, and a public `close(reason = 'the kernel worker stopped')` that calls it and makes later #call reject at once (a `#closed: Error | null` field). (c) Widen KernelPort.addEventListener's type to `'message' | 'messageerror'` (both deliver MessageEvent on Worker, MessagePort, DedicatedWorkerGlobalScope and Window, so engine.worker.ts's adapter and port-types.ts still type-check) and listen to 'messageerror' in the constructor -> #failAll('midstudy kernels: a reply could not be read'). (d) A reply with no numeric id (today looked up under -1 and dropped) -> #failAll('midstudy kernels: malformed reply'). The Worker is dedicated to the kernels (engine.worker.ts serves nothing else), the lost answer belongs to an unknown request, and every caller (engine.ts inWorker) falls back to the main thread on rejection, so failing all in-flight is safe and simple. (e) serveKernels also listens to 'messageerror' (a request the worker could not deserialize, whose id is unknown) and posts `{ ok: false, error: 'midstudy kernels: a request could not be read' }` with no id, which (d) turns into rejections on the main side; this closes the hang in the request direction too. No timeout (decodes are bounded). Optional for the app track: engine.ts worker()'s 'error' listener calls kernelWorker.close(); not required, since inWorker already races workerDown.

**Proof:** In worker-rpc.test.ts (after the serveKernels test has loaded the kernels), with a fake KernelPort that records listeners and lets the test throw from postMessage or dispatch events: (1) over a real MessageChannel, decodeDepth(buf) where buf was already transferred (detached) -> postMessage throws DataCloneError, the promise rejects, and a later reply carrying that id is ignored (no double settle); (2) dispatch 'messageerror' on the fake port while two calls are pending -> both reject (today they hang: a 1 s race fails before the fix); (3) post {ok:true} without an id -> pending calls reject with 'malformed reply'; (4) close() rejects pending and later calls; (5) serveKernels on a fake port receiving 'messageerror' posts an id-less {ok:false}. Gates: check:types (KernelPort widening against planner/engine.worker.ts and core/crates/wasm-web/tests/port-types.ts), check:lint, check:dead, check:tests, check:planner; worker.mjs, tests/browser/run.sh; eval:planner, eval:occlusion through the eval lock.

#### Media envelope wire protocol (positional Writer/Reader/Payload cursor)

**guard-only**, effort S · `core/js/node.ts`, `core/crates/wasm-node/js-test/envelope.test.ts`, `package.json`

Closes:
- positional drift between api.rs and node.ts can hand stripGlb a corrupt GLB as p.rest()
- a garbled tag (not 0, not 1) is parsed as an error envelope with an arbitrary code
- Payload has no bounds checks: a short envelope throws a DataView RangeError and bytes() truncates silently
- zipPlan's local bad-input error reports parts.length (6x the entry index) as its offset

**Design:** core/js/node.ts only; no envelope layout change. Payload: `u32()` and `bytes(n)` check `#at + k <= length` and throw 'core/js/node.ts: the media kernel's answer is shorter than its fields (protocol fault)'; `rest()` moves the cursor to the end (so a rest-reader counts as fully read); add `done(): boolean`. decode(): tag 0 -> ok, tag 1 -> error envelope (bounds-check bytes 1..6 and the code length), any other tag or an empty envelope -> throw 'unknown envelope tag' (a protocol fault, not a MediaError). After `read(p)`, if !p.done(), throw 'trailing bytes in the answer' (catches drift on every fixed-field reader; I checked each api.rs writer against its node.ts reader: jpeg_strip_plan/png_strip_plan (fields + pieces), jpeg_frame/jpeg_passthrough (5 u32), png_size, glb_strip (+rest), data_uri_image/meta_decode (rest), static_route (2 u32 + rest), content_length (flag + u64), zip_plan all consume exactly what is written). stripGlb: before returning p.rest(), check it starts with 'glTF', version 2, and that its header length equals rest.length (glb::assemble writes total = header + chunks and drops input trailing bytes, so every valid answer passes); otherwise throw a protocol fault. zipPlan: keep an entry index `k` and report `offset: k` (the Rust side reports entry indices for its per-entry codes and None for bad-input; pipeline/src/objzip.ts only prints the message). Export `decodeEnvelope` (the existing decode) for the test; node.ts is a knip entry, so the export is not flagged.

**Proof:** New core/crates/wasm-node/js-test/envelope.test.ts (node:test, new `test:kernels-node` script so check:tests runs it; face.test.ts stays by hand because it spawns the native difftool): hand-made envelopes into decodeEnvelope: tag 7 -> throws 'unknown envelope tag' (today: 'unknown code'); [0] with a reader of one u32 -> 'shorter than its fields' (today: RangeError); [0] + two u32 with a one-u32 reader -> 'trailing bytes'; a rest-reader on [0, 1, 2] passes; zipPlan with the third entry's flags out of range -> error.offset === 2 (today 12); stripGlb on a fixture GLB under fixtures/ still round-trips, and a hand-made ok envelope whose rest lacks the magic is refused. face.test.ts 12/12 still passes by hand. Gates: check:types, check:lint, check:dead, check:tests (the server suites exercise decodeImageDataUri/stripJpeg/jpegFrame/pngSize/decodeMeta/staticRoute/contentLength, test:pipeline exercises stripGlb and zipPlan); eval:scenes-api (E1), eval:library (E6), eval:pipeline (E7) through the eval lock.

#### EnvResult f32/half variant encoded by which of two vectors is empty

**guard-only**, effort S · `core/js/web.ts`, `core/crates/wasm-web/tests/load.test.ts`

Closes:
- nothing ties the variant to the reader: a diverged `half` would view a zero-length vector and return an empty map without an error

**Design:** core/js/web.ts envMap: pick the variant from the result (`const half = r.f16Len() > 0`) instead of the local option, and throw 'midstudy kernels: envMap returned <n> values, expected <width*height*4>' when the chosen vector's length is not width*height*4. No Rust change.

**Proof:** In load.test.ts: envMap with half true, false and undefined returns data of length w*h*4, the right array type and the matching `half` flag, equal to diff.mjs's reference. The throw itself cannot be reached from JS without a diverged wasm build; it is a guard, pinned by review. Gates: check:tests, check:types, check:lint, check:planner; eval:lighting (E15) through the eval lock.

#### SceneCamera wasm handle lifecycle and scratch-view cache

**defer**, effort S · `core/js/web.ts`, `core/crates/wasm-web/tests/load.test.ts`

Closes:
- the scratch view is valid only if no wasm allocation happens between #s() and its use (latent ordering)

**Design:** No behaviour change. Add a comment on #s() stating the rule (call the wasm method first, then #s(); never hold `s` across an allocating call; #putItem writes then the method reads, with no allocation between). In load.test.ts a regression case: a SceneCamera made before growth, then projectMany on a large array (e.g. 4M floats, 32 MB in and out, which certainly grows memory past its initial size), then that camera's project(), landingSpot (with a taken list) and screenRect answer exactly as before the growth.

**Proof:** The memory-growth regression case in load.test.ts (test:kernels-web, check:tests), compared against answers taken before the growth; diff.mjs and v1-sync.mjs unchanged.

**Why:** Latent only: every method already reads #s() after its wasm call and the verifier found no live misorder. A comment and a growth test guard reorderings at near-zero cost; restructuring the cache is not worth it for a personal-use app. No data loss, money or hang is involved.

#### Camera scratch slot protocol (inputs vs outputs share one 32-f64 buffer)

**wont-fix**, effort S · `docs/notes/kernels.md`

**Design:** None. SceneCamera (the only caller of the raw wasm Camera) always re-puts the item before screenRect/hitBox and checks the booleans of photoToFloor/planePointAt. Record the decision in docs/notes/kernels.md.

**Proof:** Covered as today by diff.mjs (49/49 groups) and v1-sync.mjs against v1.

**Why:** All three risks need a second caller of the raw wasm Camera, which does not exist and is not planned; the TS face is the protocol's single owner.

#### JPEG marker/scan walker (strip_plan, is_clean, frame_info)

**wont-fix**, effort S · `docs/notes/kernels.md`

**Design:** None in behaviour: both walkers are v1's (contract §0). Note in docs/notes/kernels.md (the kernels track's own notes file; kernels-hardening.md belongs to the kernels-hardening build track and check:ownership refuses it for MIDSTUDY_TRACK=kernels) that is_clean(FF D8 FF D9) is true and that passthrough relies on frame_info's NoFrame.

**Proof:** Existing props/exhaustive tests in core/crates/media and the fuzz targets (check:rust, check:fuzz).

**Why:** Keeping v1 behaviour is the contract; is_clean and passthrough have no TS callers that matter, and stripJpeg/jpegFrame on real photos agree (wasm-smoke, E1/E6).

#### PNG metadata strip chunk walk (media::png::walk)

**wont-fix**, effort S · `docs/notes/kernels.md`

**Design:** None. The strip's job is removing metadata chunks, not validating PNGs (v1's behaviour); validity is the decoder's concern downstream. Record the decision in docs/notes/kernels.md.

**Proof:** Existing Kani harness png_walk_short, props and fuzz targets (check:rust, check:fuzz).

**Why:** A degenerate 'PNG' stripping to signature+IEND carries no metadata, which is all the strip promises.

#### CPython-compatible base64 decoder state (decode_python)

**wont-fix**, effort S · `docs/notes/kernels.md`

**Design:** None. Lenient-mode interleaved padding and unchecked low bits are deliberate CPython parity; node.ts's Buffer fast path accepts only input that round-trips canonically, on which decode_python agrees by construction. Record the decision in docs/notes/kernels.md.

**Proof:** Existing media props/exhaustive tests and face.test.ts (decodeImageDataUri, decodeMeta).

**Why:** Intentional v1 (CPython) parity per contract §0; no illegal output reachable.

#### glTF JSON reader context machine (Ctx) and GLB chunk walker

**wont-fix**, effort S · `docs/notes/kernels.md`

**Design:** None. The Compact -> InPlace fallback is reported in Report.layout; pipeline/src/glb.ts uses the default and either layout is a valid GLB. Record the decision in docs/notes/kernels.md.

**Proof:** Existing glb tests and fuzz corpus; test:pipeline.

**Why:** The only consumer does not care which layout it gets, and the result says which it got.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 13 '### ' machines in '## kernels' have exactly one entry; none were missing.
- Ownership: the kernels track may write only docs/notes/kernels.md (or rooms-kernels.md). scripts/check-ownership.mjs refuses docs/notes/kernels-hardening.md, which belongs to the kernels-hardening build track. So the JPEG wont-fix and the kernels-notes package now write docs/notes/kernels.md, and the other wont-fix entries record their decision there too.
- kernels-raster: I dropped core/Cargo.lock, because removing a Cargo feature does not change any lockfile, and raster/fuzz is its own workspace anyway. I added core/crates/raster/README.md in case it names the feature. I checked that raster has `[lints] workspace = true` and that core/Cargo.toml already declares cfg(fuzzing) in check-cfg, so clippy -D warnings holds. No other fuzz workspace (media, splat, imaging, product) depends on raster, so cfg(fuzzing) changes nothing outside raster's own targets.
- KernelWorker: the plan closed the messageerror hang only for replies. A request the worker cannot deserialize fires 'messageerror' on the worker side with no id, and its main-thread promise still hung. I added (e): serveKernels answers such a request with an id-less {ok:false}, and the new no-id rule (d) turns that into rejections. This is safe because the Worker is dedicated to the kernels (engine.worker.ts serves nothing else), and inWorker falls back to the main thread. Widening KernelPort to 'message' | 'messageerror' type-checks against Worker, MessagePort, DedicatedWorkerGlobalScope and Window (engine.worker.ts's adapter): all of them map messageerror to MessageEvent.
- Envelope: 'if the reader did not call rest()' needed state that Payload does not have, so rest() now moves the cursor to the end and one `done()` check covers every reader. I checked each api.rs writer against its node.ts reader, and all of them consume exactly what is written, so the trailing-bytes check does not reject any valid answer today. I also checked the GLB header-length check against glb::assemble, which writes total = header + chunks and drops input trailing bytes, so valid answers pass it. Rust's own bad-input answer has offset None, and the per-entry codes report entry indices, so `offset: k` is consistent. objzip.ts prints only the message.
- Load lifecycle proof: the plan's 'second fresh file section' cannot reset a realm. I reordered the cases inside one load.test.ts (unloaded throws, bad bytes reject, concurrent sources while the good load is in flight, then loaded) so it runs as written. The 'another source' check is by identity. I checked every caller: engine.ts and engine.worker.ts pass undefined, and tests/browser/worker.ts passes the same URL object on every request. So no current path hits the new rejection by accident.
- SceneCamera defer stays a defer: it is latent and involves no data loss, money or hang. The growth test now uses projectMany on 4M floats, which certainly grows wasm memory. A 200k-pair taken list might not, and nothing exported can show memory.byteLength.
- Dilate: the unit test now also uses up/down = u32::MAX as usize, the value wasm32 passes through, alongside usize::MAX (64-bit, unwrap_or(u32::MAX)). Both reproduce the bug before the fix.
- EnvResult: the mismatch throw cannot be reached from JS without a diverged wasm build. The proof now says so and pins the half true/false/undefined results instead of claiming to exercise the throw.
- Gates now use real script names (eval:planner E3, eval:occlusion E4, eval:render E5, eval:lighting E15, eval:scenes-api E1, eval:library E6, eval:pipeline E7) through scripts/eval-lock.mjs, and check:ownership runs with MIDSTUDY_TRACK=kernels. Everything is $0: no fal path is touched.
- Packages: kernels-web-face and kernels-node-envelope both touch package.json, which is shared-append, and each adds a different test:* key. That is fine under the CLAUDE.md union rule. Apart from that, files are disjoint. kernels-notes depends on the other three only so it can record their outcomes in the single notes file. No package needs another track's package and none needs a contract change.
- No decision needed upgrading or downgrading: no make-explicit entries, and the only defer is latent. The guard-only entries all close their risks as traced above. v1 behaviour is unchanged except error messages and the explicit 'another source' refusal, which replaces a silent wrong-source load.

</details>

### calib (calib)

Shared in this group:
- Commit-marker ordering for scene folders (calib/src/midstudy_calib/util.py: invalidate(folder, names), sweep_tmp(folder, names) limited to calib's own file names, write_atomic with fsync): derived files are removed before their inputs change, calib.json is unlinked first and written last, so every crash window reads as 'not calibrated' rather than a mixed pairing. Used by ingest and fit._write; light keeps using write_atomic.
- Signal-held writes in the worker (calib/src/midstudy_calib/worker.py: _signals_held() using signal.pthread_sigmask around the whole of _respond, SIGTERM mapped to signal.default_int_handler) so a protocol line is whole and any interrupt after a line is read answers its id.

Packages: `calib-moge-device`, `calib-scene-files`, `calib-worker-protocol`, `calib-rooms-scale`, `calib-rooms-solver-select`

#### Room solver scale-source mode (floor vs depth vs nothing placed) in from_views

**fix**, effort S · `calib/src/midstudy_calib/rooms/solver.py`, `calib/tests/test_room_scale.py`

Closes:
- depth mode gives a member with a NaN depth ratio a made-up scale 1.0 and places it
- floor mode with member 0's camera height above b <= 1e-6 goes degenerate without trying depth mode

**Design:** rooms/solver.py: extract a pure `_scale_mode(cam_heights: list[float], cy: list[float], floor_b: float | None, ratios: list[float]) -> tuple[Literal['floor','depth','none'], float, list[float]]`: floor mode when floor_b is not None and its sigma (cam_heights[0] / (cy[0] - b)) is finite and positive; otherwise depth mode with sigma = ratios[0] when finite and positive, where a member whose ratio isn't finite/positive gets math.nan (not 1.0), so from_views' existing degenerate check unplaces it; 'none' when neither gives a sigma. from_views uses it, writes scale_source = mode in each member's diag, and on 'none' returns [Candidate(Placement(0,0,0,1), diag={'scale_source': 'none'}), None, ...] (read by the solver-selection fix). Rooms are v2-only (§4.9), so no v1 behaviour to keep.

**Proof:** pytest calib/tests/test_room_scale.py: on _scale_mode: depth mode with ratios [0.9, nan, 1.1] -> scales[1] is nan; floor present with cy[0] == b and finite ratios[0] -> mode 'depth'; neither -> 'none'. Regression through from_views (fails on today's code): synthetic RoomPhoto/View pairs (as test_align_room.py builds them) with no floor points and member 1's depth not overlapping -> member 1 is None (placed with scale 1.0 before). test_align_room_golden.py unchanged (golden room is floor mode). Gates: nix develop -c npm run check:py; calib pytest; under the eval lock: npm run eval:calib (E20 real) and npm run eval:real-room -- --golden.

#### Calibration result mode, implied by calib.json field combinations

**fix**, effort S · `calib/src/midstudy_calib/fit.py`, `calib/tests/test_scene_files.py`

Closes:
- mock miss writes source 'default' even when EXIF has a FOV, unlike the real fallback

**Design:** fit.py _mock(): the no-match path returns FitOutput(fallback(w, h, exif, 'MIDSTUDY_CALIB_MOCK has no calibration for this photo'), None, None) instead of building from _base, so the mock and real fallbacks agree. Not changed: light()'s camera precedence for a fallback calib.json with a fresh floor (wont-fix: it is what light()'s docstring and contract §4.8 specify); mock-hit fixtures with unusual field combinations (wont-fix: the schema check bounds them and the fixtures are ours).

**Contract:** CONTRACT §4.3 Mock: 'with no match it writes the fallback (exif or default, as without the mock)' instead of 'the default fallback'. fixtures/stub_calib.py (evals) implements the same mock and may follow; no eval needs it.

**Proof:** pytest in calib/tests/test_scene_files.py: `run` a synthetic JPEG saved with EXIF FocalLengthIn35mmFilm 26 (as test_cli.py's offline test builds it) under MIDSTUDY_CALIB_MOCK=fixtures/calib (no entry) -> calib.json source 'exif' with the EXIF FOV and fallback_reason set (was 'default'). test_cli.py::test_mock_miss_writes_the_default_fallback (no EXIF) and evals/harness_selftest.mjs unknownPhoto (golden photo, no EXIF) keep 'default'. Gates: check:py, calib pytest, eval:all under the eval lock.

#### JPEG marker walker (byte-state parser used for the metadata-free guarantee)

**fix**, effort S · `calib/src/midstudy_calib/ingest.py`, `calib/tests/test_ingest.py`

Closes:
- a stray SOI (0xD8) is read as a length segment, letting a crafted file jump over an APP1/EXIF segment and pass through byte for byte

**Design:** ingest.py jpeg_walk(): after reading the marker byte, `if m == 0xD8: return None` (a second SOI in the marker stream is broken structure; embedded thumbnails sit inside segment payloads and MPO images after EOI, so neither reaches this), so is_clean_jpeg is false and the file goes through normalize, which re-encodes without metadata. The kernels track's Rust walker (core media) should be checked for the same gap: a note in docs/notes/calib.md for kernels, no change here.

**Proof:** pytest in calib/tests/test_ingest.py: build SOI + FF D8 + a 2-byte length that skips an APP1 'Exif' segment + the rest of a valid small JPEG (tests/synthetic.py) -> before the fix is_clean_jpeg is True and ingest copies it byte for byte; after, jpeg_walk returns None and photo.jpg has no APP1 (jpeg_markers). Gates: check:py, calib pytest, eval:all (E8 phone) under the eval lock.

#### Bench scripts as worker protocol clients (request, then readline)

**fix**, effort S · `calib/scripts/bench.py`, `calib/scripts/bench_rooms.py`

Closes:
- bench_rooms.py json.loads on the empty line of a dead worker
- proc.wait(timeout=60) raises TimeoutExpired and the worker is never killed

**Design:** calib/scripts/bench.py, bench_rooms.py: bench_rooms checks `if not line.strip(): raise SystemExit('bench_rooms: the worker died (no answer to request b-<i>)')` like bench.py; both finally blocks do `try: proc.wait(timeout=60) except subprocess.TimeoutExpired: proc.kill(); proc.wait()`. readline timeout: not added (a developer runs these by hand and can Ctrl-C; the kill in finally then cleans up).

**Proof:** Dev scripts with no test suite: pyright strict + ruff over calib (npm run check:py, which covers scripts/); manual: run bench_rooms against a worker killed mid-run and see the clean message and no orphan.

**Why:** readline without a timeout is left: interactive dev tool.

#### Scene folder calibration stage, encoded by which files exist (photo.jpg, source.*, depth.png, lighting.json, calib.json)

**guard-only**, effort M · `calib/src/midstudy_calib/util.py`, `calib/src/midstudy_calib/ingest.py`, `calib/src/midstudy_calib/fit.py`, `calib/tests/test_ingest.py`, `calib/tests/test_scene_files.py`

Closes:
- a transient MoGe fault during a re-fit turns into a fallback that deletes a good depth.png/lighting.json and overwrites calib.json
- ingest (or run whose fit raises) leaves the old photo's calib.json/depth.png/lighting.json next to a new photo.jpg
- torn _write: new depth.png or lighting.json with the old calib.json after a crash/SIGKILL
- source.NEW written before source.OLD is deleted (two source files, wrong EXIF / mock key); source.NEW next to the old photo.jpg after a crash
- light() too-thin result keeps a lighting.json from a previous photo
- write_atomic leaves .NAME.XXXX.tmp on SIGKILL and has no fsync

**Design:** Keep the file encoding (it is the contract) and make calib.json a real commit marker. (1) util.py: write_atomic does f.flush()+os.fsync(f.fileno()) before os.replace. New util.sweep_tmp(folder, names) unlinks hidden `.{name}.*.tmp` files for calib's own names only (photo.jpg, source.*, calib.json, depth.png, lighting.json; never scene.json/thumb.jpg, which the server writes with the same `.<name>.<hex>.tmp` pattern, common/files.ts:12), called at the start of ingest() and fit._write(). Safe because the server runs fit/run/light/align-room on one calibration queue and awaits a killed worker's exit before the next job (server/src/scenes/calib.ts kill()). New util.invalidate(folder, names) = unlink(missing_ok) each, calib.json first. (2) ingest.py ingest(): after computing `photo`, if out/photo.jpg is missing or its bytes differ from `photo`: invalidate calib.json, depth.png, lighting.json, then photo.jpg itself, then every source.* other than the new name; then write source.NEW; then photo.jpg. Every crash window now reads as 'no calib.json' (server: LOST_CALIBRATION or the job's failure; Calibrate re-runs `run` from source.* when photo.jpg is gone, service.ts calibrate) and never pairs a photo with another upload's source or fit. Identical bytes (the server's own re-`run` from source.*, or a repeat CLI ingest) change nothing and keep the fit. This also closes the stale-lighting risk of light(). (3) fit.py _write(): unlink calib.json first, then write or unlink depth.png, then lighting.json, then write calib.json last; a crash between reads as 'not fitted'. (4) fit.py fit(): on a non-ContractViolation exception from _moge, if the folder's existing calib.json (read before _write) has source 'moge-2' (it pairs with the current photo because of (2)), raise Fail("MoGe-2 couldn't run (<Type>: <first line>); the earlier calibration was kept") and write nothing; with no earlier moge-2 calibration keep the §4.3 fallback. Server side needs no change: the job ends failed with that sentence (calibStatus 'failed'), scene.json's camera is untouched, and the planner's recalibrate-failed path toasts the error while keeping the served depth (planner/engine.ts:1931-1934). Note for server-domain only.

**Contract:** CONTRACT §4.3 Files/Ingest: 'when the new photo.jpg differs from the one there (or there is none), ingest first removes calib.json, depth.png, lighting.json, the old photo.jpg and other source.* files, then writes source.<ext> and photo.jpg; fit removes calib.json first and writes it last'. §4.3 Fallbacks: 'a fit of a scene whose calib.json has source moge-2 that can't run MoGe fails (exit 1, "... the earlier calibration was kept") and writes nothing; the fallback applies only when there is no earlier MoGe calibration'. fixtures/stub_calib.py (evals-owned) may mirror the ingest clearing; no eval depends on it.

**Proof:** pytest calib/tests/test_scene_files.py, each case failing on today's code first: (a) `run` the golden living-wide photo under MIDSTUDY_CALIB_MOCK=fixtures/calib, then `ingest` a different synthetic JPEG into the same folder: calib.json/depth.png/lighting.json are gone and only the new source.jpg remains; re-ingesting identical bytes keeps them byte-identical; (b) a folder with a calib.json whose source is rewritten to 'moge-2' plus depth.png and lighting.json, MIDSTUDY_CALIB_MOCK unset, fit._moge monkeypatched to raise RuntimeError('MPS backend out of memory'): fit raises Fail mentioning 'kept' and all three files are byte-identical; same with no prior calib.json -> the fallback calib.json is written (unchanged behaviour, test_cli.py's offline test still passes); (c) monkeypatch util.write_atomic (as imported in fit) to raise KeyboardInterrupt on the lighting.json write during a re-fit: calib.json is absent, not the old one; (d) leave `.calib.json.abc123.tmp` and `.scene.json.abc123.tmp` in the folder and run fit under the mock: the first is swept, the second kept; (e) ingest a JPEG into a folder holding source.png: only source.jpg remains. Gates: nix develop -c npm run check:py; nix develop -c bash -c 'cd calib && uv run pytest -q'; nix develop -c node scripts/eval-lock.mjs -- npm run eval:all (E1 scenes API, E8 phone); nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib (E2 real MoGe).

#### Warm worker request lifecycle (midstudy-calib serve)

**guard-only**, effort S · `calib/src/midstudy_calib/worker.py`, `calib/tests/test_worker.py`

Closes:
- SIGINT during json.loads/validate exits without answering a known id
- SIGINT between out.write and flush (or during _respond's validation) tears or drops the response line
- BrokenPipeError or a second KeyboardInterrupt in the Interrupted handler dies with a traceback / signal death

**Design:** worker.py only. (1) handle(): put the json.loads/_request_id/validate.problems part under `except KeyboardInterrupt: raise Interrupted(rid)` (rid None until parsed), so every interrupt after a line is read answers it. (2) a `_signals_held()` context manager using signal.pthread_sigmask(SIG_BLOCK, {SIGINT, SIGTERM}) / SIG_SETMASK(previous) around the whole of _respond (validation, write and flush), so a response is never torn or dropped once dispatch returned; a pending signal is delivered right after and ends the loop via the bare KeyboardInterrupt path (already answered). (3) the Interrupted handler wraps its _respond in try/except (BrokenPipeError, KeyboardInterrupt, OSError): log and return 1. (4) serve(): signal.signal(SIGTERM, signal.default_int_handler). Note what this buys: the server sends SIGTERM only after it has already settled the request as timeout/broken (server/src/scenes/calib.ts run()/kill()), so the 'interrupted' answer is never read; the value is that Python unwinds (write_atomic removes its temp file) within the 5 s grace instead of dying mid-write. A torch op in C delays the KeyboardInterrupt, but the server's SIGKILL after 5 s still bounds it, so no hang. Single-request cancel: wont-fix (protocol change; killing the worker is acceptable). Process-global build-up: see that machine.

**Contract:** CONTRACT §4.3 Worker: 'SIGINT or SIGTERM answers the request in flight (or the line being parsed) with "interrupted" and exits 1; a response line is never left half-written'.

**Proof:** pytest in calib/tests/test_worker.py: (a) in-process: monkeypatch worker.validate.problems to raise KeyboardInterrupt and call handle(b'{"id":"r1","cmd":"fit","args":[]}\n', defaults) -> raises Interrupted with rid 'r1' (bare KeyboardInterrupt before the fix); (b) in-process: _respond with an `out` whose write() calls os.kill(os.getpid(), signal.SIGINT) and then writes: the line in `out` is whole JSON and KeyboardInterrupt is raised only after _respond returns (pytest runs in the main thread, so pthread_sigmask applies); (c) serve() with a fake stdin yielding one request, dispatch monkeypatched to raise KeyboardInterrupt, and an `out` whose write raises BrokenPipeError -> returns 1, no exception escapes; (d) subprocess: spawn `midstudy-calib serve` with MIDSTUDY_CALIB_MOCK=fixtures/calib, wait for 'worker ready' on stderr, send SIGTERM while idle: exit code 1 (was -15). Gates: nix develop -c npm run check:py; calib pytest; nix develop -c node scripts/eval-lock.mjs -- npm run eval:all (E1/E19/E20 --mock go through the worker).

#### MoGe-2 network cache and device placement (_LOADED plus Loaded.device)

**guard-only**, effort S · `calib/src/midstudy_calib/moge_runner.py`, `calib/tests/test_moge_runner.py`

Closes:
- net.to(device) raising midway leaves a split model whose device field says cpu, so the cpu retry runs on it and fails into a fallback

**Design:** moge_runner.py: Loaded.device becomes `str | None`; infer() sets loaded.device = None before loaded.net.to(device) and the real device after it returns, so a failed move forces a full move on the cpu retry in fit._infer. Not changed: a failed-device memory for pick_device (the plan's _FAILED set) is dropped: it would pin a warm worker to cpu (several times slower) for its whole life after one transient MPS OOM, and the risk it addresses is only time (one move + failure + retry per request); unload-before-build (keeps peak memory at one model; a failing build of B after A is rare and the next request reloads); MoGe+MASt3R both resident (fine on the M3 Max).

**Proof:** pytest in calib/tests/test_moge_runner.py: a fake net whose .to raises RuntimeError on 'mps' and records calls, and whose infer returns a mapping of small torch tensors; call infer(loaded, rgb, 'mps', 0) -> raises, assert loaded.device is None; then infer(loaded, rgb, 'cpu', 0) -> net.to('cpu') was called (fails before the fix: device stayed 'cpu' and the move was skipped). Gates: nix develop -c npm run check:py; calib pytest; nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib (E2).

**Why:** Second risk (persistent MPS fault re-paid every request) is cost only; remembering failures would turn a transient fault into permanent cpu for the worker's life.

#### MASt3R provisioning: code checkout on disk, weight snapshot, and the in-process network cache

**guard-only**, effort M · `calib/src/midstudy_calib/rooms/mast3r.py`, `calib/tests/test_mast3r_provision.py`

Closes:
- no lock: two processes clone/checkout/submodule-update the same directory
- an interrupted submodule update passes the ready check forever
- a dirty checkout at another commit makes every run SolverUnavailable
- only ImportError becomes SolverUnavailable; OSError/RuntimeError (MPS OOM) from from_pretrained/.to escape as bugs; ImportError in solve's dust3r/mast3r imports isn't converted

**Design:** rooms/mast3r.py. (1) ensure_code() runs under fcntl.flock on `code_dir().parent / '.mast3r.lock'` (opened 'a+', LOCK_EX, released in finally); re-check readiness after acquiring. (2) Readiness = HEAD == COMMIT and a stamp file `root/.midstudy-ready` containing COMMIT, written with util.write_atomic only after `submodule update` succeeds; the stamp is removed before any clone/checkout. An existing checkout without the stamp re-runs `submodule update --init --recursive` once, which needs no network when the submodules are already there. (3) code_dir() is calib's cache: `git checkout --quiet --force COMMIT` and `submodule update --init --recursive --force`, so local edits never wedge it (anyone pointing MIDSTUDY_MAST3R_DIR at a hand-edited checkout loses the edits; say so in the docstring). (4) load(): widen the except around import + from_pretrained + .to(device) to Exception -> SolverUnavailable("MASt3R couldn't load (...)"); in Mast3r.solve wrap the three importlib.import_module calls so ImportError -> SolverUnavailable. command.solve's existing SolverUnavailable fallback then covers load-time failures under --solver auto as its module doc promises. Two nets during a device switch: wont-fix (device switches don't happen in practice).

**Proof:** pytest calib/tests/test_mast3r_provision.py with MIDSTUDY_MAST3R_DIR=tmp_path/mast3r and mast3r._git monkeypatched to a recorder (no git, no network: 'rev-parse' answers COMMIT, 'clone'/'submodule' create the expected files): (a) a tree with .git, dust3r/croco/models and mast3r/model.py at COMMIT but no stamp -> ensure_code calls submodule update and writes the stamp (returns at once before the fix); (b) the recorded checkout and submodule calls carry --force; (c) load() with ensure_code/ensure_weights stubbed and importlib.import_module('mast3r.model') patched to a class whose from_pretrained raises RuntimeError -> SolverUnavailable; then command.solve on two usable synthetic RoomPhotos with --solver auto answers 'manhattan' with diagnostics.fallback; (d) lock: two multiprocessing processes calling ensure_code with a recorder that sleeps in 'clone' and appends start/end marks to a shared file never interleave. Gates: nix develop -c npm run check:py; calib pytest (non-mast3r marks); under the eval lock: nix develop -c node scripts/eval-lock.mjs -- npm run eval:calib (E20 real MASt3R).

#### align-room solver selection and fallback (mock / mast3r / manhattan / none)

**guard-only**, effort S · `calib/src/midstudy_calib/rooms/command.py`, `calib/tests/test_align_room_fallback.py`

Closes:
- fallback catches only SolverUnavailable, so load-time RuntimeError/OSError fails --solver auto (closed by the provisioning fix's load())
- solver.resolve runs before the usability check
- mast3r's non-finite first-photo scale places only member 0 with no escalation and no diagnostics

**Design:** rooms/command.py solve(): move `name = solver.resolve(choice)` inside the `0 in usable_idx and len(usable_idx) >= 2` branch (an unusable room answers solver 'none' whatever was asked). After a learned-solver run under choice 'auto' (name != 'manhattan'), if every found[1:] is None and found[0]'s diag has scale_source 'none' (set by the scale-source fix), re-run manhattan with diag['fallback'] = 'mast3r: no floor or depth overlap on the first photo'; under an explicit --solver mast3r keep the answer but add diag['degenerate'] with the same sentence. The load-time error gap is closed by the MASt3R provisioning fix (load converts Exception to SolverUnavailable), not here. The mock ignoring --solver is wont-fix: evals/align_eval.mjs checks that --solver doesn't matter under the mock (contract §4.9 Mock).

**Proof:** pytest calib/tests/test_align_room_fallback.py with solver.installed/solver.make monkeypatched: (a) --solver mast3r, extra reported missing, no usable photos (no calib.json) -> succeeds with solver 'none' (raises SolverUnavailable before the fix); (b) a fake learned solver returning [Candidate(Placement(0,0,0,1), diag={'scale_source':'none'}), None, None] under auto -> answer solver 'manhattan' with diagnostics.fallback; under explicit mast3r -> solver 'mast3r' with diagnostics.degenerate. Gates: nix develop -c npm run check:py; calib pytest; under the eval lock: npm run eval:all (E20 --mock) and npm run eval:calib (E20 real).

#### MoGe checkpoint resolution fallback (pinned revision -> Hub main)

**guard-only**, effort S · `calib/src/midstudy_calib/moge_runner.py`, `calib/src/midstudy_calib/fit.py`, `calib/src/midstudy_calib/records.py`, `calib/tests/test_moge_runner.py`

Closes:
- a silent switch to the Hub's main leaves no record of which weights fitted a scene
- pinned not cached + offline -> fallback overwrites a good calibration (closed by the scene-files fix)

**Design:** moge_runner._checkpoint returns (path, revision) where revision is the pinned sha or 'main'; Loaded and MogeOutput carry `revision: str` (MogeOutput with a default so fit compiles before the next step); records.MogeInfo gains `revision: NotRequired[str]`; fit._moge writes calib['moge']['revision']. calib.schema.json's `moge` is a free-form object (additionalProperties true), so no schema or generated-code change. The fallback-overwrite part is closed by the scene-files fix (a re-fit that can't load MoGe keeps the earlier calibration).

**Contract:** Optional one line in CONTRACT §4.3 (calib.json moge): 'revision: the weights' Hub revision used (the pinned sha, or main when it couldn't be had)'. No schema change, so no check:gen churn.

**Proof:** pytest in calib/tests/test_moge_runner.py: update test_pinned_revision_then_main to assert _checkpoint returns revision 'main' when hf_hub_download raises for the pinned revision, and the pinned sha otherwise; update test_one_model_at_a_time's _checkpoint stub to return (path, revision). In test_scene_files.py: fit with fit._infer monkeypatched to a fake MogeOutput(revision='abc') writes moge.revision 'abc'. Gates: check:py, calib pytest, eval:calib E2 under the eval lock.

#### Room align.json validity, stamped by photo_sha256 only

**defer**, effort S

Closes:
- re-fitting a member (another model, or a fallback) keeps photo_sha256, so stale poses look current
- align-room reads photo/calib/depth in separate steps and could mix generations

**Design:** No calib change now. The cheaper, complete fix is server-side and needs no contract field: the server already sees every calibration job of a member scene on the same queue as the align jobs, so it can mark a room's alignment stale when a member's fit/run job finishes after the align job that produced align.json (the same 'calibration is newer' ordering lightingStatus uses, server/src/scenes/service.ts:293). Route that to the server group. Only if a stamp on disk turns out to be needed (align.json read by something that never saw the jobs, e.g. after a restart) add the optional member `inputs_sha256` (SHA-256 over photo/calib.json/depth.png SHA-256s, computed in rooms/photos.load from the bytes it parses) with a foundation contract change and regenerated calib/src/midstudy_calib/{contract_types.py,schemas/}. The cross-generation read is theoretical: fits and align jobs run one at a time on the calibration queue, and with the scene-files fix a torn folder reads as unusable (no calib.json), never as new depth with an old camera.

**Proof:** n/a in calib; the server-side staleness rule gets its own node:test in the server group.

**Why:** Not data loss, money or a hang: stale poses after a re-fit look wrong and the user Aligns again. The plan's fingerprint needed a schema field, regenerated contract code, calib schema copies and a server consumer anyway; the server can detect the same staleness from job order alone.

#### Process-global import and initialisation patches (scipy.signal stand-in, torch init no-op window, sys.path, scipy hierarchy alias)

**defer**, effort S

Closes:
- MoGe import pays the scipy cost after an align-room
- MASt3R/dust3r/croco roots at sys.path[0] can shadow later top-level imports

**Design:** No change now. If it ever bites: append the MASt3R roots instead of inserting at 0 only after checking no `models`/`utils` top-level module exists in calib's env, or import MASt3R in the one-shot path only.

**Proof:** n/a

**Why:** The first is speed only; for the second, MoGe and calib import only package-qualified names (moge.*, midstudy_calib.*), so the shadowing is theoretical, and reordering sys.path risks breaking MASt3R's own `models` imports.

#### Keep-room align (render composite) outcome chain and its out file

**wont-fix**, effort S

Closes:
- a not-applied align leaves an earlier out file at the same path

**Design:** No change. server/src/scenes/render.ts #align passes a hidden per-render out path ('.' + name + '.aligned.jpg') and renames it only when `applied` is true and the file exists (render.ts:278-294), so no consumer trusts file presence; contract §4.3 Align says 'write nothing' on a reject.

**Proof:** Existing: calib tests/test_align.py and E5 (render) cover applied/not-applied; nothing to reproduce.

**Why:** The only consumer uses `applied` and its own path; deleting a caller's file on reject would contradict 'write nothing' for no real gain.

#### align-room scoring rejection loop (iterative unplacing of low-confidence members)

**wont-fix**, effort S

Closes:
- greedy one-way rejection never reconsiders a member
- a rejected member's diag describes a superseded placement set

**Design:** No change; the diag staleness is what `rejected_*` is meant to show (the pose at rejection time).

**Proof:** n/a

**Why:** A heuristic by design, measured on the golden room (E20); re-admission adds a second loop and oscillation risk for a personal app where the user can Align again or place by hand.

#### Manhattan solver greedy frontier (todo set / placed dict), and robust_up's worst-first exclusion

**wont-fix**, effort S

Closes:
- early wrong placements compound with no backtracking
- a stuck loop unplaces every remaining member

**Design:** No change.

**Proof:** n/a

**Why:** Manhattan is the no-ML fallback; its greedy behaviour is the algorithm, and the scoring pass's confidence threshold already unplaces poor matches. Unplaced members are honest output, shown in the UI.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 15 '### ' machines under '## calib' have exactly one fix entry; nothing was missing.
- Scene files: limited sweep_tmp to calib's own file names, because the server writes scene.json/thumb.jpg in the same folder with the same `.<name>.<hex>.tmp` pattern (common/files.ts:12). Ingest invalidation now also removes the old photo.jpg before the new source.* is written. Before, a crash after the old source was deleted left the old photo.jpg with no source (or next to source.NEW). Now the server's Calibrate falls back to `run` from source.* (service.ts calibrate). Checked against the server: calibStatus reports a failed job as 'failed' even when calib.json is kept, and the planner's recalibrate-failed path toasts and keeps the depth (engine.ts:1931). So the 'earlier calibration kept' Fail needs no server change.
- Worker: the signal mask now covers the whole of _respond, not just write+flush. A SIGINT during the response's validation used to drop an answer that dispatch had already computed. Reframed SIGTERM: the server sends it only after it has settled the request as timeout/broken (calib.ts run()/kill()), so the 'interrupted' answer is never read. The real gain is a clean unwind (temp files removed) within the 5 s grace. The server's SIGKILL rules out a hang. Dropped the 'server timeout kills without an answer' risk from risks_addressed. Replaced the vague 'env-selected test hook' proof with in-process tests (monkeypatched validate.problems, a self-signalling `out`, BrokenPipe `out`) plus a subprocess SIGTERM-while-idle exit-code check.
- MoGe device: dropped the _FAILED/mark_failed device memory. It would pin a warm worker to cpu for its whole life after one transient MPS OOM, and the risk it addresses is only time. Kept the device=None guard, which closes the real failure: a split model retried on cpu, falling into a fallback.
- Packages: calib-scene-files and calib-moge-device both listed fit.py, so they weren't disjoint. Now moge-device owns only moge_runner.py and its test (device guard, plus revision on Loaded/MogeOutput). The fit.py and records.py part of the revision fix (MogeInfo.revision, written to calib.json) moved into calib-scene-files, which depends on calib-moge-device. The revision fix's files gained records.py, which the original missed (MogeInfo is a TypedDict there). Its proof now names the two existing tests that must change: _checkpoint's return type, in test_one_model_at_a_time and test_pinned_revision_then_main.
- Room align.json validity: downgraded from guard-only to defer, and its calib files, contract change and the foundation-contract-align-inputs dependency were removed. The fingerprint needed an align.schema.json field, regenerated contract/gen and calib's contract_types.py/schemas copies (which the original file list left out), and a server consumer. Yet the server can already detect the same staleness from job order on its one calibration queue, as lightingStatus's 'calibration is newer' does. This is not data loss, money or a hang. Route the server-side rule to the server group (server-domain-room-freshness). calib-rooms-scale no longer depends on foundation, and calib-rooms-solver-select no longer touches mock.py.
- Scale mode: the proof can't fail first against a function that doesn't exist yet. Added a from_views-level regression on synthetic views that fails on today's code (a member with no depth overlap placed with scale 1.0), and gave _scale_mode a clearer signature.
- MASt3R provisioning: the proof said both 'a local bare repo' and 'a monkeypatched _git'. It now uses only a recorder (no git, no network), and the lock test uses two processes rather than threads, so flock's semantics are tested without doubt. Noted that --force discards edits in MIDSTUDY_MAST3R_DIR.
- Mock-miss fix: checked that test_cli.py's mock-miss test and evals/harness_selftest.mjs unknownPhoto both use photos without EXIF, so 'default' still holds there. The change is visible only with an EXIF-carrying photo, and contract §4.3 Mock (line 449, 'the default fallback') needs the text change.
- Checkpoint revision: no calib.schema.json edit, since `moge` is free-form (additionalProperties true). That avoids check:gen churn. The doc line is optional CONTRACT text.
- Gates: every eval gate is now wrapped in `nix develop -c node scripts/eval-lock.mjs -- …`, as CLAUDE.md requires, and the calib pytest is spelled the way the repo runs it.
- Keep-room align wont-fix confirmed: render.ts:278-294 uses a hidden per-render out path and renames it only when `applied` is true.

</details>

### tooling (toolchain (scripts/) and evals (evals/lib, except harness.mjs which is foundation))

Shared in this group:
- scripts/lib/dirlock.mjs: one synchronous lock-directory helper (tryClaim, owner-checked release, releaseAllSync; async callers poll tryClaim themselves). It writes owner.json {pid, host, cmd, started at claim} through tmp+rename and reclaims through an aside rename checked with common/logic/lock.ts sameOwner, putting the folder back when it is wrong (common/lock.ts's protocol; no separate token). Staleness is lockVerdict with staleMs = Infinity for same-host owners. Used by eval-lock.mjs (slots, exclusive marker), build.mjs (step locks), tscert-ratchet.mjs (whole run), and harness.mjs and perf.mjs (evals/out ownership).
- One shutdown-timing ladder, which every supervisor must respect: srv.stop 8 s < a createEval cleanup 15 s < createEval's finish watchdog 40 s < all.mjs's step wait 50 s < eval-lock's group grace 60 s. Signals from one burst (eval-lock's group signal plus all.mjs's forward) count once, through createEval's 2 s debounce.
- Process-group signal forwarding: spawn a supervised child detached, with stdin ignored to avoid SIGTTIN, forward signals to -pid, SIGKILL the group after the grace, and release only after the group is gone or the bounded wait ends (eval-lock.mjs). all.mjs forwards once to its current step and waits.
- Poll-until-not-in-progress: harness waitScene, rooms waitJob and perf's inline job polls end on a string status outside the contract's pending/queued/running. A missing status keeps polling, and waitFor logs its last value on timeout.
- Test-only hooks, so each race reproduces in node:test or a selftest: MIDSTUDY_EVAL_LOCK_DIR, MIDSTUDY_DIRLOCK_TEST_PAUSE, MIDSTUDY_BUILD_STEP_SLEEP_MS, MIDSTUDY_EVAL_BUILD_CMD, MIDSTUDY_ALL_STEPS, MIDSTUDY_EVAL_CALIB_GATE_S, MIDSTUDY_PERF_FAULT. A new `test:scripts` suite (`node --test --test-concurrency=1 scripts/test/*.test.mjs`, a package.json shared-append entry) puts scripts/test under check:tests, and `eval:selftest-runner` runs evals/runner_selftest.mjs.

Packages: `tooling-dirlock`, `tooling-build`, `tooling-gates`, `tooling-eval-lock`, `tooling-harness`, `tooling-evals-lib`, `tooling-perf`

#### startServer process lifecycle (spawned/up/exited/stopped) and free-port handoff

**fix**, effort S · `evals/lib/harness.mjs`, `evals/harness_selftest.mjs`

Closes:
- freePort TOCTOU: another eval's server takes the port and up=true is set against the foreign server
- up is never cleared when the server dies later
- stop() SIGKILLs after 2.5 s, inside the server's own 5 s shutdown, orphaning the detached calib worker

**Design:** evals/lib/harness.mjs startServer: (1) pass --port 0. server/src/logic/cli.ts pyInt accepts 0, and server/src/main.ts:157 prints the bound address port. Read base and port from the server's own stdout line `midstudy planner: http://127.0.0.1:<port>/planner/`. Wait for it up to 60 s, matching today's roughly 200 s readiness budget better than 15 s does under eval-lock load, and give up at once if the process exits first. Only then poll GET /planner/ on that base, so a foreign server can no longer answer for this one. srv.base and srv.port are set before startServer returns, so callers are unchanged. freePort stays exported for perf.mjs:404 and others. (2) A `stopping` flag is set by stop(). On a proc 'exit' after up && !stopping: srv.up = false, srv.why = `exited after start (code/sig)`, and one stderr note. Expected stops are not recorded as crashes. Add srv.alive() = () => srv.up && srv.exited == null, a function so that copies such as perf's `{...srv}` still read live state. (3) stop(): SIGTERM, wait up to 8 s (more than main.ts:167's 5 s hook limit), then SIGKILL. The server still owns killing its worker group on SIGTERM (v1 behaviour, contract §0).

**Proof:** evals/harness_selftest.mjs (eval:selftest): (a) monkey-patch or pre-bind: start a dummy listener answering 418 on the port freePort would hand out (or simply any port), start a server, and check srv.port equals the port in the server's own stdout line and GET /api/scenes from srv.base answers 200 with the server's JSON (not 418). (b) Start a server, SIGKILL srv.proc, wait for exit, and check srv.up === false, srv.alive() === false and srv.why names the exit. (c) srv.stop() on an idle server finishes under 8 s and srv.exited.sig is not SIGKILL. Also covered by every eval that starts a server (eval:all through the lock).

#### perf.mjs run orchestration: RUN cursor, per-target lazy shared resources, setupError, shutdown

**fix**, effort M · `evals/perf.mjs`

Closes:
- t.setupError never cleared after a later successful mainServer
- t.shared.srv cached forever after the main server crashes
- signal/watchdog shutdown runs cleanups under the live loop and never writes results.json
- 4 h watchdog exceeds eval-lock's 180 min staleness
- withEnv mutates global env across awaits (latent; not changed)

**Design:** evals/perf.mjs: (1) `delete t.setupError` before each suite's mainServer attempt (:1034). Setting it on failure stays as it is. (2) mainServer (:230): t.shared.srv is a spread copy `{...srv, ...}` (:261), so its `exited` is a snapshot that never updates. Keep the live object instead: t.shared.srv = {...srv, raw: srv, ...}. Reuse it only when `t.shared.srv.raw.exited == null && t.shared.srv.raw.up`, or raw.alive() where the target's harness has it, since an older A/B target tree's harness does not. Otherwise await raw.stop() and the old pages server's stop(), clear t.shared.srv, and set up again. Suites call mainServer inside each run (:433, :450, ...), so a crash between runs recovers on the next run. browserOf does the same with browser.isConnected(). (3) Move results assembly and writing (the res.targets push, finalize, results.json, the --out copy, :1060-1072) into writeResults(res). shutdown(code, why) sets `aborted = why` and res.error = `interrupted: <why>`, calls writeResults with what has been measured, then runs the cleanups and exits. The suite and run loops check `aborted` before each run and break, so no sample is recorded against a closed resource after shutdown starts. (4) The watchdog and eval-lock clash is closed by the eval-lock fix (no age staleness for a live same-host owner). No code dependency, and nothing changes here. (5) withEnv: wont-fix. Calls are sequential, and a comment at :146 states the invariant.

**Proof:** A test-only hook MIDSTUDY_PERF_FAULT=kill-server-after-run-0 SIGKILLs t.shared.srv.raw.proc after run 0 of the api suite. `nix develop -c node scripts/eval-lock.mjs --exclusive -- npm run eval:perf -- --suites api --runs 2 --warmup 0` with the hook: run 1 has samples for every api metric. Before the fix every later metric fails with status 0. SIGINT to perf mid-run leaves evals/out/perf/results.json with error 'interrupted: SIGINT' and the samples so far; before the fix no file is written. Gate: eval:perf -- --runs 1 through eval-lock --exclusive.

#### Incremental build stamps (validity cache of inputs/outputs)

**fix**, effort S · `scripts/build.mjs`, `scripts/lib/stamps.mjs`, `scripts/test/build-stamps.test.mjs`

Closes:
- inputs fingerprinted after the build: a file saved mid-build is recorded as current and stale output is served
- files absent at stamp time never invalidate (Cargo.lock appearing); non-.rs/.toml/.lock inputs (include_str!, build.rs data) are never inputs
- prune after 10 min 404s lazily loaded chunks of an open page

**Design:** scripts/build.mjs plus a small pure scripts/lib/stamps.mjs: (1) record buildStart = Date.now() before cargo or esbuild runs. writeStamp writes nothing when any input's mtime is later than buildStart or an input disappeared, and logs '<step>: an input changed during the build; it rebuilds next time'. It also removes the old stamp, so the next run rebuilds. (2) The wasm inputs become every file under core/crates/** (except target/, node_modules/ and dot-dirs), plus core/Cargo.toml, core/.cargo/** and an explicit core/Cargo.lock entry. statKey already records 'missing', so the lock file appearing flips the stamp. (3) GRACE_MS goes to 24 h. Old chunks are small, and an open planner tab keeps working across a day of rebuilds.

**Proof:** scripts/test/build-stamps.test.mjs on scripts/lib/stamps.mjs decide(stamp, nowStats, buildStart): an input with mtime > buildStart gives 'do not write'; a recorded 'missing' input that now exists gives stale; an unchanged tree gives current. The first two fail against today's logic. Manual: touch core/crates/geom/src/lib.rs during `node scripts/build.mjs --wasm-only --force`; the next build rebuilds. Gates: check:tests, check:types, check:planner.

#### evals/all.mjs sequential eval runner and signal propagation

**fix**, effort S · `evals/all.mjs`, `evals/runner_selftest.mjs`

Closes:
- all.mjs dies on SIGTERM without signalling the running eval, so eval-lock releases while the eval, its server and Chrome run on
- summary line empty for an eval that crashed before its summary

**Design:** evals/all.mjs: keep the current child handle. SIGINT/SIGTERM/SIGHUP handlers forward the signal once to it, wait for its exit (SIGKILL after 50 s, beyond createEval's 40 s bounded finish), print the summary so far with the interrupted step marked, and exit 130. Later steps don't start. A repeat signal within 2 s is ignored. The case where the step already got the same signal from eval-lock's group is handled by createEval's 2 s debounce. An empty scraped line becomes '(no summary line: exited <code> before its summary)'. A test-only MIDSTUDY_ALL_STEPS (JSON) replaces the step list.

**Proof:** evals/runner_selftest.mjs (new, `npm run eval:selftest-runner`, a package.json shared-append entry): spawn all.mjs with MIDSTUDY_ALL_STEPS=[["X1","sleep","node",["-e","setInterval(()=>{},1e3)"]]] and its own process group, then SIGTERM all.mjs alone (not the group). The step's pid is gone, and all.mjs exited 130 with a summary marking X1 interrupted. Before the fix the sleeper survives. Gates: eval:selftest-runner, eval:all.

#### ensureBuilt once-per-process build memo

**fix**, effort S · `evals/lib/harness.mjs`, `evals/harness_selftest.mjs`

Closes:
- a transient build failure is cached and startServer runs against missing or stale planner/dist
- the 900 s timeout SIGTERM leaves the build's lock and tmp files (closed by the build lock fix: dead-pid reclaim and the tmp sweep)

**Design:** evals/lib/harness.mjs ensureBuilt: memoize success. A failure is retried at most once more per process (attempt counter), so an eval that starts several servers doesn't pay up to 900 s for every one. Each attempt reports its own check. startServer: when ensureBuilt fails, return {up:false, why:'the build failed: <why>'} without spawning. This changes behaviour on purpose: before, it served a stale dist, and the failing build check already fails the eval. Test-only MIDSTUDY_EVAL_BUILD_CMD (a JSON argv) replaces `node scripts/build.mjs`, so the selftest needs no hook in build.mjs and this package does not depend on tooling-build. SIGTERM on timeout stays the default; build.mjs dies by default and the next build reclaims its lock.

**Proof:** evals/harness_selftest.mjs spawns a child with MIDSTUDY_EVAL_BUILD_CMD pointing at a node one-liner that fails while a marker file is missing and creates it. The first ensureBuilt fails and the second succeeds. A startServer in a child whose build always fails returns up:false with 'the build failed' and spawns no server. Gate: eval:selftest.

#### Polling of server job state machines (calib_status, align_status, job.status)

**fix**, effort S · `evals/lib/harness.mjs`, `evals/lib/rooms.mjs`, `evals/perf.mjs`

Closes:
- client-side terminal sets duplicate the server's: a new status runs the poll to its timeout
- waitFor discards last (errors) on timeout
- waitAlignDone returns on a 'done' derived from an old align.json (unused helper)

**Design:** Invert the sets: a poll ends on a 200 whose status field is a string outside the contract's in-progress values ('pending', 'queued', 'running'). An absent or non-string status keeps polling, so a body without the field never reads as finished. This applies to harness waitScene (:223), rooms.mjs waitJob (:193), and perf.mjs's inline polls (:248, :636). harness waitFor keeps returning null on timeout (no caller changes), but writes `harness: waitFor timed out after N ms; last: <clip(last)>` to stderr. Delete the unused waitAlignDone from evals/lib/rooms.mjs (:187; no caller). The edits are split by file: harness.mjs in tooling-harness, rooms.mjs in tooling-evals-lib, perf.mjs in tooling-perf.

**Proof:** evals/harness_selftest.mjs: a tiny http server answers calib_status 'weird', and waitScene returns at once where it used to time out. A body without calib_status keeps waitScene polling until its timeout. An always-500 server makes waitFor's stderr name the 500. Gates: eval:selftest, check:dead (no unused export left), eval:all (E18, E19).

#### Planner page open/readiness phases (load -> hook -> ready -> hookOk)

**fix**, effort S · `evals/lib/harness.mjs`, `evals/lib/rooms.mjs`

Closes:
- openRoomPage duplicates openPlanner with different timeouts and options; fixes drift
- the context is not closed on failure (kept: callers read page errors; the browser cleanup closes it)
- waitPhoto's 400 ms settle (kept)

**Design:** evals/lib/harness.mjs openPlanner gains `query` (extra URL params) and `readyMs` (default 60000) options, and the phone-viewport merge moves into it (tooling-harness). evals/lib/rooms.mjs openRoomPage becomes a wrapper that builds the room/photo/webgpu query and calls openPlanner({ ..., readyMs: 90000 }) (tooling-evals-lib, after tooling-harness). The unclosed context and the waitPhoto settle stay as they are: callers inspect the page after a failure, and the browser close in cleanup frees it.

**Proof:** No new race. E19 room-planner and E3 planner still pass (eval:all through the lock), and grep shows the init-script block only in harness.mjs. Gates: eval:all, check:dead.

#### gated_calib.py gate file: hold a calibration job in 'running'

**fix**, effort S · `evals/lib/gated_calib.py`, `evals/runner_selftest.mjs`

Closes:
- a timeout is indistinguishable from release
- held pollers outlive an ended or SIGKILLed eval and exec the stub later

**Design:** evals/lib/gated_calib.py: on deadline, fail the way the calibration CLI contract says a failure looks (contract §4.3: exit 1, `{"ok": false, "error": "<sentence>"}` as the last stdout line, `midstudy-calib: <sentence>` on stderr), not with a bespoke exit 3 that the server would show as an unexplained crash. The sentence is 'gated_calib: the gate was not opened within N s'. N comes from MIDSTUDY_EVAL_CALIB_GATE_S (default 120). For `serve` (the server's first try, calib.ts:96), a timeout exits 2 instead, like the stub's missing serve, so the server falls back to one-shot as it does today (§4.3 Worker crash rule). The wait loop also exits the same way when os.getppid() differs from its value at start: the server died and the poller was reparented, so no poller outlives its server. The server spawns the command directly with no shell, so the ppid is the server.

**Proof:** evals/runner_selftest.mjs: (a) MIDSTUDY_EVAL_CALIB_GATE_S=1 with the gate closed and args `run ...`: exit 1 within 2 s, the last stdout line parses as {ok:false} with the sentence. Before the fix it exits 0 after exec'ing the stub. (b) `sh -c 'python3 gated_calib.py run ... & echo $!; sleep 0.2'` with the gate closed: the echoed pid is gone within 1 s of sh exiting. Gates: eval:selftest-runner, eval:selftest (its existing gate case), E1 scenes-api and E6 render and E18 rooms-api (eval:all), which use the gate.

#### Machine-wide eval semaphore (slots + exclusive-wanted marker)

**guard-only**, effort M · `scripts/eval-lock.mjs`, `scripts/test/eval-lock.test.mjs`

Closes:
- reclaim TOCTOU: two reclaimers both win slot-i
- age staleness reclaims a live same-host owner after 180 min
- owner.started is process start, not claim time
- marker reclaimed from a live exclusive waiter; unconditional rmSync of a marker no longer owned (:66, :80)
- --slots is per process: a --slots 5 run takes slot-3/4 during an --exclusive run
- num() NaN makes WAIT_MS NaN, so the waiter loops forever
- SIGTERM forwarded to the direct child only: eval-lock hangs, or releases while grandchildren run
- parent SIGKILL leaves slots (already reclaimed by dead pid; kept)

**Design:** Keep the shape (slots + marker) and swap the file-system primitives for scripts/lib/dirlock.mjs (package tooling-dirlock). (1) claim(d) becomes dirlock.tryClaim(d, {cmd}): mkdir, then owner.json {pid, host, cmd, started: claim time with ms} through tmp+rename. Reclaim renames the folder aside, re-reads aside/owner.json, and puts it back unless common/logic/lock.ts sameOwner(moved, judged) holds. That is common/lock.ts's rule: identity is pid+host+started, and no extra token is needed. Release is owner-checked (sameOwner) and renames aside before rm. (2) Staleness is common/logic/lock.ts lockVerdict (TScert-certified), imported from the .ts under Node's type stripping, with staleMs = Infinity when owner.host is this host. A live pid on this host never goes stale; --stale-min applies only to an owner on another host. (3) The exclusive run keeps its marker until release() instead of removing it once it holds every slot (:80), so no shared request of any --slots count starts during an exclusive run. Before it spawns, it also waits until no live slot-* dir exists beyond its own SLOTS (readdir + lockVerdict). (4) num() parses strictly: a missing, non-finite or <= 0 value prints the usage and exits 2. (5) Spawn with detached:true (its own process group) and stdio ['ignore','inherit','inherit'], since a background group that reads the tty gets SIGTTIN and stops. Forward SIGINT/SIGTERM/SIGHUP to -child.pid. If the group is still alive GROUP_GRACE_S = 60 s after the first signal, SIGKILL the group; a second signal SIGKILLs it at once. The 60 s grace must exceed createEval's bounded finish (40 s) and all.mjs's 50 s wait, so a signalled eval can stop its server and Chrome before the group SIGKILL. (6) On the child's 'exit', poll kill(-pid, 0) for at most 60 s, then SIGKILL the group and release. Release never waits unbounded on a lingering group member. Note that the server's calibration worker is spawned detached (server/src/scenes/calib.ts:96) into its own group, which the group kill does not reach. The server owns it, and it also exits on stdin EOF (contract §4.3 Worker). (7) MIDSTUDY_EVAL_LOCK_DIR overrides the git-common-dir location, for tests only. scripts/eval-lock.mjs is foundation-owned, so this package goes through the integration track.

**Proof:** scripts/test/eval-lock.test.mjs (node:test, in the new test:scripts suite that check:tests runs), each case with MIDSTUDY_EVAL_LOCK_DIR set to a temp dir. (a) Two reclaimers on a stale slot (dead pid), with the judged-stale-then-fresh interleaving forced by a dirlock test hook: exactly one holds it afterwards. (b) A slot whose owner.json has a live same-host pid and started = 1970 is not reclaimed; fails before the fix. (c) An exclusive run holding every slot plus a shared `--slots 5` request: the shared one waits; fails before the fix. (d) `--wait-min --` and `--slots abc` exit 2; before the fix the waiter loops. (e) `eval-lock -- node -e <spawn a sleeping grandchild that ignores nothing>`, then SIGTERM to eval-lock: the grandchild is dead before the slot dir is gone; fails before the fix. (f) Release by a holder whose slot was taken over leaves the new owner's dir. (g) A child that leaves a grandchild ignoring SIGTERM: eval-lock exits within grace + 1 s. Gates: check:tests, then a real `npm run eval:selftest` through the lock.

#### build.mjs per-step lock directory (wasm, planner)

**guard-only**, effort S · `scripts/build.mjs`, `scripts/test/build-lock.test.mjs`

Closes:
- reclaim race with no rename: B deletes A's live lock
- no heartbeat: a live build over 15 min is taken over
- SIGTERM (ensureBuilt's 900 s timeout) leaves the lock and .tmp-<crate>-<pid> dirs
- an empty pid file reads as pid 0, alive, so the lock is held for 15 min

**Design:** scripts/build.mjs withLock(name, fn) keeps its async signature and polls dirlock.tryClaim every 150 ms for up to 30 min. Reclaim therefore goes through the aside rename with a sameOwner check, and release (in finally) is owner-checked. Staleness is lockVerdict: a dead pid on this host, or no readable owner.json for 10 s, which covers an empty or partial file (lockOwner rejects pid 0). There is no age rule, so a live 40 min cold build keeps its lock. No signal handlers: cargo, wasm-bindgen and wasm-opt run through spawnSync (:131), and a JS SIGTERM handler would be deferred until the child returns, making build.mjs unkillable for minutes. Default SIGTERM death leaves a lock with a dead pid, which the next build reclaims at once. At the start of buildWasm, remove build/wasm/.tmp-*-<pid> dirs whose pid is dead (alive() false).

**Proof:** scripts/test/build-lock.test.mjs (test:scripts), using the step behind a test hook (MIDSTUDY_BUILD_STEP_SLEEP_MS replaces the step body with a sleep, under `--lock-selftest`): (a) a build/locks/<name>.lock aged 20 min by utimes with a live owner: a second process waits instead of entering; fails before the fix. (b) SIGTERM a process holding the lock, then start another: it enters within a second (dead-pid reclaim), and a planted build/wasm/.tmp-x-<deadpid> dir is gone after buildWasm starts. (c) A lock dir with an empty owner file older than 10 s is reclaimed; one younger than 10 s is held. Gates: check:tests, check:types and check:planner (both run build --wasm-only), eval:selftest.

#### createEval lifecycle (running -> finishing -> exit), watchdog and cleanup stack

**guard-only**, effort S · `evals/lib/harness.mjs`, `evals/harness_selftest.mjs`

Closes:
- a hung cleanup (browser.close on wedged SwiftShader) hangs the eval forever and holds its slot
- a second SIGINT/SIGTERM cannot stop an eval stuck in cleanup
- recordFile fixed on the first record across createEval calls (latent)

**Design:** evals/lib/harness.mjs createEval.finish: run each cleanup as Promise.race([fn(), sleep(15 s) -> 'timed out']), and on a timeout record a failing check 'cleanup <i> finished'. 15 s covers srv.stop's 8 s. Arm an overall finish watchdog (40 s, unref'd) that prints the summary, writes results.json and calls process.exit(1). These numbers sit under all.mjs's 50 s and eval-lock's 60 s group grace. The signal handler gains `if (finishing && Date.now() - firstSignalAt > 2000) process.exit(130)`. A second signal ends a stuck cleanup, and a signal from the same burst is ignored: under eval-lock, the group SIGTERM and all.mjs's forwarded SIGTERM arrive together and must count as one, or every eval would skip its cleanups and orphan its server. recordFile is recomputed when recordTag changes (one line).

**Proof:** evals/harness_selftest.mjs spawns a tiny child eval (node -e importing createEval) with an onCleanup that never resolves and finish() called at once: it exits 1 within about 20 s with the 'cleanup 1 finished' FAIL. Before the fix it never exits; the test kills it at 60 s and fails. A second child in a hung cleanup gets SIGTERM, then another SIGTERM 3 s later, and exits 130 at once. A third gets two SIGTERMs 50 ms apart and still runs its (quick) cleanups. Gate: eval:selftest.

#### perf drag/dragMoves pointer-press and rAF frame-recording sequence

**guard-only**, effort S · `evals/perf.mjs`

Closes:
- a throw between mouse.down and mouse.up leaves the button pressed and (dragMoves) the rAF loop running
- the item is restored only on success
- the two functions order 'stop recording' and 'mouse.up' differently (kept: documented)

**Design:** evals/perf.mjs drag (:666) and dragMoves (:708): track `pressed` and `st0`. A finally block runs `if (pressed) await P.page.mouse.up().catch(()=>{})`, then `page.evaluate(() => { window.__perf.framesOn = false })`, then, when st0 is known, restores the item with moveItem, each step with .catch. The success path stays as it is. The differing stop/up order is kept on purpose: changing it moves the numbers that evals/perf/baseline.json (v1's) is compared against. A comment says which frame window each one measures.

**Proof:** A fault hook, MIDSTUDY_PERF_FAULT=drag-throw, throws right after mouse.down. After drag returns {error}, `await page.evaluate(() => window.__perf.framesOn)` === false, and a following mouse.move leaves the item's position unchanged; before the fix the item moves. Gate: eval:perf -- --suites drag --runs 1 through eval-lock --exclusive.

#### check.mjs gates: on-disk presence as 'already set up' flags and tree-mutating checks

**guard-only**, effort S · `scripts/check.mjs`, `scripts/test/check-gen.test.mjs`

Closes:
- an interrupted uv sync leaves a partial calib/.venv that is never re-synced
- an interrupted lake exe cache get leaves a partial Mathlib build dir that is never re-fetched
- check:gen writes into the working tree non-atomically and leaves the files on FAIL
- check:types/check:planner contend on the build lock (closed by the build lock fix)

**Design:** scripts/check.mjs: (1) py() always runs `uv sync --project calib --frozen --inexact --quiet`, a sub-second no-op when current. --inexact keeps the optional `rooms` extra, which an exact sync would remove (CLAUDE.md). (2) proofs(): the 'fetched' flag becomes build/check/mathlib-cache.json {rev}, where rev is mathlib's rev from proofs/lake-manifest.json. It is written only after `lake exe cache get` exits 0, and the fetch is skipped only when the recorded rev matches. (3) gen() runs `node scripts/gen-contract.mjs --check` (it already exists, :13 and :418, and compares in memory without writing). Then comes the existing git diff/status on contract/gen and core/crates/contract/schema.json for uncommitted output. First verify that --check also covers core/crates/contract/schema.json; if it doesn't, gen-contract's --check is foundation-owned and that becomes a request to foundation, not an edit here. The gate no longer mutates the tree. (4) Build lock contention: nothing here.

**Proof:** scripts/test/check-gen.test.mjs: in a temp `git worktree add` copy with a drifted schema, `node scripts/check.mjs gen` fails and `git status --porcelain contract/gen core/crates/contract` is empty afterwards; before the fix it shows modified files. Manual: remove calib/.venv/lib/python3.12/site-packages/numpy, and `npm run check:py` re-syncs and passes (before: pyright import errors). Delete build/check/mathlib-cache.json, and the next check:proofs fetches. Gates: check:gen, check:py, check:proofs, check:tests.

#### TScert ratchet: jobs file, nix-cached run, per-unit status with one retry, baseline ratchet

**guard-only**, effort S · `scripts/tscert-ratchet.mjs`, `scripts/test/tscert-lock.test.mjs`

Closes:
- the fixed build/tscert/jobs.json is overwritten by a concurrent --files run: the full run verifies a subset and a concurrent --update shrinks the baseline
- build/tscert/stamp.json is write-only state (kept: harmless)

**Design:** scripts/tscert-ratchet.mjs: take a dirlock on build/locks/tscert.lock (wait up to 60 min) from just before writing jobs.json (:102) to the end of the run, including the --update baseline rewrite (:167). Releasing before the comparison would let two --update runs read-modify-write tscert/baseline.json over each other. nix/tscert.nix keeps its fixed path, so no packaging change. A sanity guard: when a full run (no --files) finds byFile missing a file that was in jobs, it exits 1 with 'the jobs file changed under this run', never 'gone'. The stamp.json write in scripts/tscert.mjs is left alone. scripts/tscert.mjs is a declared input of the sandboxed run (:113), so editing it invalidates the nix cache and forces a full re-verification for no behavioural gain.

**Proof:** scripts/test/tscert-lock.test.mjs puts a PATH shim `nix` first on PATH. It sleeps 2 s and prints a store path holding a fixed result built from the jobs it read. Two ratchet runs (a full one and a --files one) are started together. The second waits, and the full run reports every baselined function, not 'gone'. A jobs file swapped under the shim triggers the guard's exit 1. Before the fix the full run reports 'gone'. Gates: check:tscert (re-run once on tool errors, per CLAUDE.md), check:tests.

#### perf pageInit readiness marks (hooked, hook/ready/shown/error)

**guard-only**, effort S · `evals/perf.mjs`

Closes:
- the 5 ms interval runs for the page's life when .ready never appears
- first hook object only (kept)
- the accessor property changes window.midstudy semantics slightly (kept)

**Design:** evals/perf.mjs pageInit: stop the 5 ms poll after 120 s (the loadPlanner timeout) and set P.marks.error = 'window.midstudy.ready never appeared', so loadPlanner fails with a reason. The first-hook-only behaviour and the accessor are kept: the planner assigns window.midstudy once, and the accessor is what measures the hook moment.

**Proof:** eval:perf's load suite still passes. Under MIDSTUDY_PERF_FAULT=no-hook (loadPlanner opens about:blank), marks.error is set and loadPlanner's error names it, instead of a bare waitForFunction timeout.

**Why:** The two kept risks have no concrete failure in the current planner.

#### evals/out/<slug> scratch directory ownership (wipe at start, shared by concurrent runs)

**guard-only**, effort S · `evals/lib/harness.mjs`, `evals/perf.mjs`

Closes:
- two runs of the same eval in one worktree wipe each other's server data dirs, gate files and results.json mid-run

**Design:** evals/lib/harness.mjs createEval takes a dirlock on evals/out/<slug>.lock, a sibling that the rmSync of evals/out/<slug> doesn't touch, before the rmSync (tryClaim, no wait). If a live process holds it, it prints 'another run of <slug> is in progress in this worktree (pid N, <cmd>)' and exits 75, leaving the dir alone. The lock is released in finish(), and dead-pid reclaim drops it after a crash (tooling-harness). perf.mjs does the same with evals/out/perf.lock before wiping targets/<label> (tooling-perf). It is cheap, though `--exclusive` already serializes perf runs that go through the lock.

**Proof:** evals/harness_selftest.mjs spawns two child evals with the same slug, the first holding with a sleep. The second exits 75, and the first's out dir and results.json are intact; before the fix the first's dir is wiped. Gate: eval:selftest.

#### Build step lock and eval semaphore (cross-process, cross-worktree)

**guard-only**, effort M · `scripts/lib/dirlock.mjs`, `scripts/test/dirlock.test.mjs`

Closes:
- build lock older than 15 min is stolen from a live build; release is not owner-checked; rmSync+mkdir reclaim lets two win
- eval-lock release removes slot dirs without an owner check; a >180 min run is reclaimed and deletes the waiter's slot
- both differ from common/lock.ts

**Design:** Closed by 'build.mjs per-step lock directory' and 'Machine-wide eval semaphore', which both move to scripts/lib/dirlock.mjs. It is a sync mirror of common/lock.ts's protocol: owner.json {pid, host, cmd, started}, written through tmp+rename; reclaim through an aside rename that is checked with common/logic/lock.ts sameOwner and put back when wrong; owner-checked release; releaseAllSync for exit paths. Staleness is lockVerdict (TScert-certified), called with staleMs = Infinity for same-host owners. It imports common/logic/lock.ts read-only (server-owned; no change to common/). It also exposes a test hook (MIDSTUDY_DIRLOCK_TEST_PAUSE) to force the judged-stale-then-fresh interleaving.

**Proof:** scripts/test/dirlock.test.mjs: (a) a forced judged-stale-then-fresh interleaving leaves one holder; (b) release by an ex-owner leaves the new owner's dir; (c) a live pid with started=1970 is held; (d) a dead pid is reclaimed; (e) no owner.json for >10 s is reclaimed, and <10 s is held. Plus the build-lock and eval-lock tests. Gates: check:tests, check:dead.

#### pages_server streaming response generators (slow, trickle, huge, gzip-bomb) and timers

**wont-fix**, effort S

Closes:
- slow/trickle timers keep a process alive 25-60 s when stop() is forgotten

**Design:** No change. Every caller ends through createEval.finish's process.exit or perf's shutdown, and both call stop() or exit anyway.

**Proof:** n/a

**Why:** Theoretical: no caller can leave the timers running, since each eval exits through process.exit. If a future caller needs it, `.unref()` in later() is a one-liner.

<details><summary>Reviewer’s changes</summary>

- Coverage: all 17 '### ' machines in the tooling section have exactly one fix entry. Nothing was missing.
- perf mainServer revalidation was broken as written. t.shared.srv is a spread copy `{...srv, pages, ...}` (perf.mjs:261), so `t.shared.srv.exited` is a snapshot that stays null forever. The fix now keeps `raw: srv` and checks raw.exited and raw.up (or raw.alive()), and the harness adds srv.alive() as a function so copies read live state. An older A/B target tree's harness has no alive(), hence the raw.exited fallback.
- build.mjs signal handlers were dropped. cargo, wasm-bindgen and wasm-opt run through spawnSync (build.mjs:131), and a JS SIGTERM handler is deferred until the sync child returns, which would make build.mjs unkillable for minutes, including by ensureBuilt's timeout. Default SIGTERM death plus dead-pid reclaim and a dead-pid .tmp sweep closes the same risks. ensureBuilt's line 'build.mjs now cleans up on it' was removed with them.
- dirlock follows common/lock.ts exactly: identity is sameOwner (pid+host+started), not a new random token. common/logic/lock.ts lockOwner/sameOwner ignore a token, so a token would have meant a second, uncertified comparison.
- Signal interplay: under eval-lock the group SIGTERM reaches all.mjs and the step together, and all.mjs then forwards a second SIGTERM. With the planned 'if (finishing) process.exit(130)', every eval would skip its cleanups and orphan its server. Added a 2 s debounce in createEval and one timing ladder (8 < 15 < 40 < 50 < 60 s). The plan's 30 s per cleanup and 90 s finish exceeded eval-lock's 15 s group SIGKILL, so the SIGKILL would have landed mid-cleanup.
- eval-lock: the wait for the group after a normal child exit is now bounded at 60 s, then SIGKILL and release, so a lingering group member can't hang the lock forever. Detached children get stdin 'ignore', since a background process group reading the tty stops on SIGTTIN. Noted that the server's calib worker is spawned detached (server/src/scenes/calib.ts:96), so group kills don't reach it; the server owns it, and it exits on stdin EOF per contract §4.3.
- gated_calib: exit 3 with a stderr sentence breaks the calibration CLI contract (§4.3: failure is exit 1 with {ok:false,error} as the last stdout line). Changed to that shape. A `serve` timeout exits 2 instead, which maps onto the server's existing one-shot fallback (§4.3 Worker crash rule), so E1, E6 and E18 behave as before.
- TScert: the lock is now held through the --update baseline rewrite, because releasing before the comparison leaves two --update runs racing on tscert/baseline.json. Dropped the stamp.json removal from scripts/tscert.mjs: that file is a declared input of the sandboxed nix run (tscert-ratchet.mjs:113), so editing it forces a full re-verification for no behavioural gain.
- Polling inversion now requires the status to be a string. A 200 without the field would otherwise read as terminal and end the poll early. waitAlignDone is confirmed unused (only its definition at rooms.mjs:187).
- startServer: the wait for the server's port line went from 15 s to 60 s. Today's readiness budget is about 200 s, and a 15 s cap would fail cold starts under eval-lock load. Added a `stopping` flag so an expected stop() isn't recorded as 'exited after start'. Confirmed that cli.ts accepts --port 0 and main.ts:157 prints the bound port.
- ensureBuilt's test hook moved from build.mjs (MIDSTUDY_BUILD_FAIL_ONCE, which would have needed cross-process state) to a harness-side MIDSTUDY_EVAL_BUILD_CMD. tooling-harness therefore no longer depends on tooling-build. A failed build is retried at most once per process, so an eval with several servers doesn't pay up to 900 s for each.
- Package disjointness: evals/harness_selftest.mjs was in both tooling-harness and tooling-evals-lib. The all.mjs and gated_calib cases moved to a new evals/runner_selftest.mjs (eval:selftest-runner, a package.json shared-append entry). The rooms.mjs edits for the Polling and Planner page machines were listed under tooling-harness's machines but sat in tooling-evals-lib's files, and the perf.mjs edits for Polling and out-dir were in no package's machines. Each machine is now listed in every package that touches its files, and each file is in exactly one package. package.json appears in two packages only as shared-append.
- Removed check:lint from the gates of .mjs-only packages: eslint.config.js ignores **/*.mjs, so it is a no-op there. tooling-perf no longer depends on tooling-eval-lock (the watchdog clash is closed independently, with no code dependency) and now depends on tooling-dirlock for its out-dir lock.
- Kept tooling-harness's dependency on the other group's package server-infra-child-processes without being able to verify it from this section. The port line it might need already exists, so the dependency may only order the server's SIGTERM worker-group cleanup; the integrator should confirm it.
- check:gen: scripts/gen-contract.mjs --check already exists. The implementer must confirm it also covers core/crates/contract/schema.json; if it doesn't, the fix is a request to foundation, since gen-contract is foundation-owned.
- pages_server is wont-fix with no files: it is listed under tooling-evals-lib's machines only for coverage.

</details>
