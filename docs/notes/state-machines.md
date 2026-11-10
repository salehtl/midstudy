# Implicit state machines: a sweep of midstudy

Workflow `wf_d9c2ae5d-d03` swept the code in 11 groups by path, with no path in two groups. In each group one agent read every non-test file and a second agent checked every finding against the code, corrected or rejected some, and added any the first missed. A last agent looked for state machines that span areas. `proofs/` and tests were left out.

**170 machines** (25 high, 55 medium, 90 low), plus **13 that span areas**. Severity means how much an explicit machine would help: high = a concrete bug risk in the current code. Line numbers are as of commit 21c7efc.

## Summary

| Group | Machines | High | Medium | Low | Rejected |
|---|---|---|---|---|---|
| planner-engine | 22 | 5 | 8 | 9 | 0 |
| planner-core | 13 | 0 | 4 | 9 | 0 |
| planner-ui | 23 | 3 | 6 | 14 | 0 |
| planner-gpu | 9 | 1 | 2 | 6 | 1 |
| server-infra | 14 | 5 | 3 | 6 | 0 |
| server-domain | 16 | 3 | 7 | 6 | 1 |
| product | 15 | 2 | 2 | 11 | 1 |
| pipeline | 13 | 2 | 6 | 5 | 4 |
| kernels | 13 | 0 | 4 | 9 | 1 |
| calib | 15 | 1 | 6 | 8 | 0 |
| tooling | 17 | 3 | 7 | 7 | 0 |

## State machines that span areas

### [high] Scene calibration job: upload -> calibration queue -> calib worker/one-shot -> files on disk -> planner polling

**Parts:** planner/data.ts:105-165 (scenes store poll, upload XHR, seen map); planner/logic/scenes.ts:21-34 (sceneBusy/calibFinished/sceneFinished); planner/engine.ts:1549-1565 (waitForScene), 1660-1690 (openSceneAs waits), 1905-1936 (recalibrate); planner/ui/panels/scene.ts:104-116; server/src/routes/scenes.ts:41-89 (upload temp -> create); server/src/scenes/service.ts:336-392 (create/#queueJob/busy/calibrate), 441-466 (delete drops jobs), 507-522 (restore), 552-622 (#run/#ended/#finish/#removeLeftover), 638-659 (#after cleanup); server/src/scenes/logic/status.ts:28-34 (calibStatus, LOST_CALIBRATION); server/src/scenes/calib.ts (Worker/CalibRunner); calib/src/midstudy_calib/ingest.py:340-346, fit.py:262-300 (writes source.*, photo.jpg, depth.png, lighting.json, calib.json in that order); contract/api/scene-object.schema.json:22, common.schema.json:10

**States:** upload in flight (planner XHR; server writes upload.part -> upload.<ext> in a temp dir) → created: scene.json without photo, job queued (calib_status pending) → running (server marks running, then worker or one-shot runs `run`/`fit`) → ingested: source.<ext> + photo.jpg on disk, no calib.json yet → fitted: depth.png/lighting.json written, then calib.json → applied: server copies calib camera into scene.json when camera_source is default/auto, job done (calib_status done) → failed (job failed, or no job + no calib.json = LOST_CALIBRATION after restart) → dropped: scene deleted while queued/running (#dropped); leftover folder removed → planner mirror: seen[name] pending/running -> 'ready'|'failed' events; openScene waits; recalibrate waits

**Mismatches:**
- Lost re-calibration reads as success: job state lives only in memory (JobStore), so a server restart during a recalibration of a scene that already has calib.json makes calibStatus(null, true) answer 'done' (status.ts:31-33). The planner's sceneFinished sees running -> done and emits 'ready'; recalibrate() emits 'recalibrated' and the Scene panel toasts success (scene.ts:114), but nothing was recalibrated.
- A dead-end state with no way out: a restart between scenes.create and ingest's write of source.<ext> leaves scene.json with no source.* and no photo.jpg (the upload copy lived in the job-owned temp dir, which #after never cleans after a crash, so it is orphaned in os.tmpdir()). calib_status is 'failed' with LOST_CALIBRATION, whose text says 'calibrate it again', but calibrate() answers 409 NO_PHOTO_TO_CALIBRATE (service.ts:381). Delete is the only way out.
- Restore during a running job: delete() marks the running job dropped and moves the folder. If the user restores before the tool finishes, restore succeeds because the tool has not re-made the folder yet. The tool's fit then writes depth.png/lighting.json/calib.json into the restored scene, but #ended sees #dropped and records failed 'scene deleted' without applying the camera. #last still points at that job, so the live, restored scene shows calib_status 'failed' with a 'scene deleted' error while it holds a new calib.json whose camera is not in scene.json. If the tool re-made the folder first (`run` does out.mkdir), restore answers 'exists' (409) until the job ends.
- Torn write window across processes: fit._write writes depth.png, then lighting.json, then calib.json. A timeout SIGKILL (calib.ts kill on 'timeout') or a crash between them leaves a new depth.png with the old calib.json. The server serves both as one scene, and the planner uses the new depth for occlusion with the old camera.
- A recalibration whose MoGe fit falls back (fit.py:292-296: depth None, lighting None) deletes the scene's previously good depth.png and lighting.json. The job still ends 'done' (with a fallback source), and the planner's recalibrate() keeps occlusion on only if depth loads. The next open then auto-starts inferLighting because lighting_status is 'missing'.
- The planner's openSceneAs -> waitForScene loop doesn't check sceneToken, so opening another scene leaves the old poll running for up to 15 min. It is harmless but keeps polling a scene nobody is waiting for.
- Orphaned one-shot calibrations: once the worker is given up (3 failures), jobs run through runTool with detached:true. CalibRunner.shutdown only closes the warm worker, so a one-shot `run`/`fit` outlives a server stop and writes calib.json later. After the restart the scene shows 'done' (calib.json present) but its camera was never applied to scene.json (camera_source still 'default', camera DEFAULT_CAMERA).

### [high] Server child processes vs server lifetime (midstudy-add, one-shot calib, render align): orphaning on stop/restart

**Parts:** common/tools.ts:53-108 (runTool spawns detached:true, kills only on timeout); server/src/main.ts:112-171 (hooks: only scenes.shutdown; 5 s exit race); server/src/scenes/shared.ts:33; server/src/scenes/calib.ts:283-348 (shutdown closes only the warm worker); server/src/library/service.ts:260-307 (midstudy-add run, spend reservation released in #after); server/src/scenes/render.ts:206-237 (one-shot `calib align`); server/src/spend.ts:17-112 (in-memory reservations); pipeline/src/cli.ts:203-339 (commit), 484-503 (signal cleanup); common/lock.ts (library lock held for the whole add)

**States:** child spawned in its own process group (detached) → server running: child tracked by an in-memory job + spend reservation → server stopping: only the calib worker is closed; other children are left alone → server gone: child orphaned with a closed stdout pipe, still holding the library lock → restarted server: no job, no reservation, unaware of the child

**Mismatches:**
- midstudy-add is never killed when the server stops: SIGINT/SIGTERM to the server reaches neither the detached process group nor any shutdown hook. The orphan keeps running a paid fal job (live mode) and holds <library>/.lock.d, so the restarted server's deletes, patches and trash ops get 503 Busy after 60 s for up to the add's whole run.
- The orphan's stdout is a pipe whose reader died, so its next say() or the final printSummary raises EPIPE as an unhandled 'error' event. It can die after fal charged and before appendCost, or after move(staging, itemDir) and before upsert. The result is an untracked item folder or a missing costs.csv row, the staging dir left behind (scratch cleanup runs only on signals), and the lock left to dead-owner reclaim.
- The spend reservation for the in-flight add (spend.ts #reserved) exists only in memory, so after a restart the cap no longer counts it. The restarted server can admit renders or adds past the daily cap while the orphan is still billing.
- The planner's library store tracks the job id. After the restart, /api/library/jobs no longer lists it, so setJobs replaces state.jobs, busy() goes false and polling stops with no 'job-done' or 'job-failed' (data.ts:242-260). If the orphan commits, engine.reloadLibrary is never triggered and the item stays invisible until a page reload.
- The same applies to the render's one-shot `midstudy-calib align` and to one-shot calibrations: none is registered with onShutdown, although calib.ts:332 states the intent that 'no one-shot run would outlive the server'.

### [high] Library add/rescale job: planner upload -> server job + spend reservation -> midstudy-add under the library lock -> item folder / library.json / costs.csv -> planner job poll

**Parts:** planner/data.ts:236-314 (jobs mirror, poll, track, api tri-state); planner/logic/library.ts:84-94 (jobBusy, jobChange); planner/ui/panels/library.ts:60-149; server/src/routes/library.ts:78-157 (queueAdd, postUpload, postFromUrl); server/src/library/service.ts:231-307 (newJob, #run, #after); server/src/spend.ts:89-112 (reserve/release/holdForToday); pipeline/src/cli.ts:178-339 (locked add, commit order), 437-480 (rescale); pipeline/src/fal.ts:28-35, 377-400 (charged flag); pipeline/src/library.ts:36-100 (locked, load, upsert, appendCost); common/lock.ts, common/logic/lock.ts:49-54

**States:** queued (server JobStore, spend reserved under the job id) → running: midstudy-add spawned and waiting for or holding the lock; library.json snapshot loaded → fal charged (Fal.charged) → committed: staging moved to <library>/<id> → upserted into library.json → cost row appended → exited -> server reads the summary line -> done/failed; reservation released (or held for the day on timeout) → _failed/<id>-<stamp> kept after a paid failure → planner: tracked status -> 'job-done' (reload library) | 'job-failed'

**Mismatches:**
- A paid call that fails after commit records no cost: in cli.ts the catch rethrows when `committed` is true, so an upsert validation error, a write error or an appendCost failure after move(staging, itemDir) loses the costs.csv row. The server then sees a nonzero exit, fails the job and releases the reservation (#after). The daily cap, which reads costs.csv, understates spend, and an item folder exists that library.json doesn't list.
- Lost update after the too-old reclaim: midstudy-add loads library.json once at the start (cli.ts:197) and upserts that snapshot at the end (cli.ts:309). lockVerdict lets any waiter reclaim a live owner's lock after 3600 s. A long add, or a slow fal queue with waitMs null, can therefore have another writer (a server delete or patch, or another midstudy-add) change library.json in between, and that change is then overwritten by the stale snapshot.
- The server's ADD_TIMEOUT_S (3600 s) equals LOCK_STALE_MS. The SIGKILL at the timeout skips releaseAllSync, so the lock is left with a dead owner, and between them a waiter may already have reclaimed it as too-old.
- The planner's jobChange ignores a job that disappears (a server restart forgets the JobStore). The mirror stops polling with no terminal event (see the orphaning machine).
- The 'done' job's `item` is read from library.json after the child exits and the lock is released (service.ts:290), so a concurrent write can make the reported item differ from what this add wrote.

### [medium] Room align job: POST align -> calibration queue (waits for member calibrations) -> align-room (MASt3R/Manhattan) -> align.json + room.json -> planner followAlign

**Parts:** planner/engine.ts:2337-2371 (alignRoom, followAlign), 2391-2407 (waitForRoom), 2426-2446 (setPose/resetPose); planner/ui/room.ts:475-501 (Align photos UI reads align_status); server/src/rooms/service.ts:126-132, 212-220 (#lastJob/#status), 460-592 (align/#run/#ended/#end/#removeLeftover), 381-433 (delete/restore); server/src/rooms/logic/room.ts:267-274 (alignStatus); server/src/scenes/service.ts:130-175, 553-561, 638-654 (queueTask, requeue, runCalib); calib/src/midstudy_calib/rooms/command.py:55-155 (solver selection, writes align.json); contract/api/room-object.schema.json:37-42, room-job.schema.json

**States:** none (no align.json, no job) → pending/queued, maybe waiting_for member calibrations (requeued to the back while members are busy and anything else is queued) → running (align-room writes --out rooms/<room>/align.json) → done: room.json members re-posed (#applied), aligned stamped; or done from align.json presence alone after a restart → failed (tool error, too few photos, timeout, 'the server stopped', room deleted) → dropped: room deleted while queued/running → planner: phase 'aligning' -> 'aligned' | 'align-failed'

**Mismatches:**
- followAlign treats every non-pending, non-running status as success: `emit('room', { phase: st === 'failed' ? 'align-failed' : 'aligned' })` (engine.ts:2362). After a server restart mid-align the room answers 'none' (never aligned before) or 'done' (an older align.json is present), and the planner reports 'aligned' and applies the stale poses, although the job was lost.
- followAlign returns silently on a 404 (room deleted elsewhere) without emitting any room phase, so a UI that switched to 'aligning' never leaves it.
- Room restored while its align job is still running: delete() marks the job dropped. Restore succeeds if align-room has not yet re-made rooms/<room>/. The tool then writes its new align.json into the restored room, but #ended sees #dropped and fails the job 'room deleted' without applying poses to room.json. #lastJob hides dropped jobs, so align_status reads 'done' from align.json presence. The room now has a new align.json, old member poses, and an unchanged `aligned` stamp, and a later Reset applies the new answer.
- setPose PUTs the whole member list from the planner's cached room (roomLogic.membersWithPose(room.members.map(...))), and the contract says a scene not listed leaves the room. A member added in another tab, or rejoined by a scene restore, since this tab's last fetch is silently removed again: a lost update with no version check. A member deleted elsewhere makes the whole PUT 404.
- waitForRoom defaults a member's missing scene_object.calib_status to 'done' (engine.ts:2400), so a member whose scene object is absent counts as calibrated.

### [medium] Warm calibration worker protocol (server CalibRunner/Worker <-> `midstudy-calib serve`)

**Parts:** server/src/scenes/calib.ts:73-348; server/src/scenes/logic/worker.ts:1-80 (readWorkerLine, failuresAfter, MAX_WORKER_FAILURES); calib/src/midstudy_calib/worker.py:42-136; calib/src/midstudy_calib/moge_runner.py:78, 205-248 (model cache in the worker); contract/calib-cli.schema.json (request/response), CONTRACT §4.3 Worker

**States:** no worker → spawning → idle (idle timer armed) → request in flight (one at a time, matched by id) → answered → broken (garbled, wrong id, over-long line, exited) -> killed, the job re-runs one-shot, failures+1 → timeout -> killed, job failed, failure count unchanged → idle-closed (stdin end, exits) → given up after 3 failures in a row: one-shot forever → closing (server shutdown)

**Mismatches:**
- The worker answers an unparseable or over-long request with id null (worker.py:58, 108-110). The server's readWorkerLine requires the request's id, so it treats that as garbled: it kills the worker, counts a failure and re-runs the job one-shot instead of failing the job with the worker's sentence.
- A broken answer after the worker already did the work (an answer line over 64 MB, or a stray stdout line) makes the job run again one-shot. `run` re-ingests and re-fits, rewriting photo.jpg/depth.png/calib.json, and the work is paid twice in time.
- The idle close is asynchronous (stdin.end, then the old process unloads), and the next job spawns a fresh worker at once, so two MoGe or MASt3R models can be resident together for a while.
- On a timeout the server SIGTERMs the group. The worker has no SIGTERM handler, so it dies without answering, possibly halfway through fit._write (the torn depth/calib window in the scene calibration machine).
- Shutdown: close() gives the worker killGraceMs (5 s) and main's exit race is also 5 s. A MASt3R align in flight is SIGKILLed (its job ends 'the server stopped') and leaves no state, but an already-started one-shot run is not covered (see the orphaning machine).

### [medium] Render request: planner capture -> POST /api/render (synchronous, no job) -> spend reservation -> fal -> costs.csv -> files in renders/ -> planner list

**Parts:** planner/engine.ts:2904-2963 (postRender, renderViewInternal, listRendersInternal); planner/ui/workspace.ts:139-163, planner/ui/panels/renders.ts:24-57, 258-275 (pending chip and list); server/src/scenes/render.ts:99-237 (#reserveName, render, #make, #align); server/src/spend.ts; calib align (keep-room composite)

**States:** capturing (planner holds frames) → request in flight (the only handle is the open HTTP request) → name reserved + spend reserved → fal answered (billed, cost row appended) → files written: -input.jpg, -raw.jpg, .jpg, then .json (listed only once .json exists) → done -> planner 'render' done + list update | failed

**Mismatches:**
- The render has no job id or status route. If the planner's request dies (network blip, tab reload, laptop sleep), the server still finishes, bills fal and writes the render, while the planner emits 'render failed' and toasts an error. Retrying pays again, and the first render only appears after a listRenders refresh.
- A crash after the fal answer and before the .json is written leaves render-*.jpg files that the list never shows (it lists by .json), though the cost row is recorded. The name stays taken because #reserveName checks for any of the files.

### [medium] Library / costs lock directory protocol shared by the server and midstudy-add

**Parts:** common/lock.ts:66-231; common/logic/lock.ts:44-54; common/costs.ts:28-32; server/src/library/service.ts:175-177 (60 s wait -> 503); pipeline/src/library.ts:36-45 (waitMs null); pipeline/src/cli.ts:484-503 (releaseAllSync on signals)

**States:** free → held (owner.json: pid, host, cmd, started) → maker died before owner.json (no-owner, reclaimable after 10 s) → dead owner on this host (reclaimable) → too-old (> 3600 s, reclaimable even with a live owner) → reclaimed (moved aside, removed) → released (owner checked first)

**Mismatches:**
- The too-old verdict makes a live, legitimate holder lose its lock while it still believes it holds it. The holder's release is safe (it checks the owner), but its writes, the library.json snapshot upsert and the commit, then interleave with the new holder's. Two writers run at once, which is exactly the state the protocol exists to prevent.
- The server-side waiters give up after 60 s (503 Busy) while midstudy-add holds the lock for its whole run, fal included, so every library write in the planner (delete, restore, patch, thumbnail PUT) fails during an add. The planner's thumbnail queue marks the item thumbTried and doesn't retry (engine.ts:790-826).

### [medium] SplatLayer <-> sort.worker CPU sort protocol (WebGL2 fallback)

**Parts:** planner/gpu/splat-layer.ts:187-201, 251-287, 359-479, 527-533; planner/gpu/sort.worker.ts:10-31; planner/gpu/sort-messages.ts; planner/engine.ts:895, 928-931, 2770-2773 (onChange, settleSplats in capture); planner/engine.passes.ts:205-213

**States:** no worker → set v sent (centers transferred) → sort id pending (only one at a time) → sorted for key → error reply → worker dead

**Mismatches:**
- The worker's onerror only logs (splat-layer.ts:363). If the module fails to load or the worker throws, `pending` is never cleared, so requestCpuSort returns early forever. After a rebuild instanceCount is 0 in CPU mode, so splats stay invisible for good, and every capture's settle() rejects after 30 s with 'the splats were still sorting'.
- After an 'error' reply onWorker resolves the pending sort but doesn't re-request the wanted key (unlike the version-mismatch branch). Because the engine only calls layer.render when its own splat key changes (engine.passes.ts:205-213), the order stays stale until the camera or a transform moves.

### [low] Lighting backfill: planner inferLighting -> POST /light -> light job on the calibration queue -> lighting.json -> lighting_status

**Parts:** planner/engine.ts:1751 (autostart when 'missing' and calib done), 2702-2744 (inferLighting poll with lightingToken); planner/logic/look.ts:297-302 (lightingStatusOf); server/src/scenes/service.ts:287-295, 394-405, 625-635; server/src/scenes/logic/status.ts:45-57; calib light command (writes lighting.json); contract/api/scene-detail.schema.json:33

**States:** missing → pending → running → done (lighting.json) → none (light job ran and found no light; exists only in memory) → failed → overridden: a newer calibration's pending/running decides

**Mismatches:**
- 'none' has no on-disk representation: after a server restart it reverts to 'missing'. Each first open of such a scene then re-runs the light job through the planner's autostart (engine.ts:1751), and the result is the same 'none'.
- A light job lost to a restart reads as 'missing'. inferLighting treats that as terminal and stops with no toast and no failure, so the Look panel shows 'missing' as if it had never been asked.
- calibrate() doesn't check a queued light job (it only checks busy() on calibrations), so both can be queued. The status function hides the light job behind the newer calibration, which then rewrites or deletes lighting.json itself (fit._write).

### [low] Planner kernel worker RPC (KernelWorker <-> serveKernels in engine.worker)

**Parts:** planner/engine.ts:307-335 (worker(), workerDown, inWorker fallback), 1612-1620 (loadDepth); planner/engine.worker.ts:9-14; core/js/web.ts:68-97 (loadKernels latch), 552-615 (serveKernels ready latch, KernelWorker pending map)

**States:** not started → worker up, wasm loading → ready → request pending (id) → replied → worker down -> main-thread fallback forever

**Mismatches:**
- serveKernels' `ready ??= loadKernels(source)` latches a rejected promise. loadKernels itself resets on failure, but the server side never retries, so one failed wasm load inside the worker fails every later request. Each call then falls back to the main thread, which defeats the worker without marking it down.
- Only the worker's 'error' event rejects workerDown. A 'messageerror' or a reply that never comes leaves the depth decode awaiting forever, because nothing races it. KernelWorker#pending entries are never rejected when the worker dies, which leaks them.

### [low] Layout and scene documents edited from several tabs/devices (no versioning)

**Parts:** planner/engine.ts:2049-2156 (saveLayout / load / dirty baselines), 2657-2701 (look autosave); server/src/routes/layouts.ts:109-147 (PUT writes, DELETE to .trash); planner/ui/workspace.ts:237-246 (remove/Undo); server/src/scenes/service.ts:409-424 (scene PUT merge)

**States:** clean (baseline = server copy as last loaded by this tab) → dirty → saved (PUT, last writer wins) → deleted to .trash → undo: the old doc PUT back

**Mismatches:**
- Layout PUT carries no version or ETag, and each tab's baseline is its own. Two tabs or devices editing the same layout overwrite each other silently, and a tab's 'clean' state can hide that the server copy changed.
- Undo of a layout delete PUTs the remembered document back, which overwrites a layout of the same name saved in another tab since the delete.

### [low] Build step lock and eval semaphore (cross-process, cross-worktree)

**Parts:** scripts/build.mjs:71-90 (withLock); scripts/eval-lock.mjs:26-98; evals/lib/harness.mjs:234-251 (ensureBuilt); scripts/check.mjs

**States:** free → held (pid / owner.json) → stale by dead pid → stale by age (build: 15 min mtime; eval: 180 min started) even with a live owner → stolen → released

**Mismatches:**
- build.mjs treats a lock older than 15 minutes as stale even while its pid is alive. A cold cargo and wasm-opt build in a fresh worktree can exceed that, so a second build runs concurrently into the same build/ outputs. The first build's finally rmSync then deletes the second's lock, because release doesn't check the owner. The reclaim is also rmSync followed by mkdir with no aside rename, so two reclaimers can both win.
- eval-lock's release() removes its slot dirs without checking owner.json. A run longer than 180 min, such as eval:calib or eval:real-room with real MASt3R, is reclaimed as stale by a waiter, and on exit it deletes that waiter's slot. More than SLOTS evals then run at once, including during an --exclusive perf run.
- Both differ from common/lock.ts, which does the owner check and the aside rename correctly.

### [low] New room saga (planner multi-request: N scene uploads -> POST room -> POST align) [missed by the per-area lists as a cross-process machine]

**Parts:** planner/engine.ts:2375-2390 (createRoom); planner/ui/scenes.ts:141-185, 339-362; server/src/routes/scenes.ts, server/src/rooms/service.ts (create, align admission counting busy members)

**States:** uploading photo i of N → scenes created (calibrating) → room created → align queued, waiting for member calibrations → aligned / failed

**Mismatches:**
- There is no compensation step. If a later upload fails or the tab closes midway, the earlier scenes stay as loose scenes (calibrating, paid in time) with no room, and nothing records that they belonged to an unfinished room.
- align admission counts busy members as having photos (rooms/service.ts:485). If a member's calibration then fails without producing photo.jpg, the queued align ends 'too few photos'. The planner sees that only through followAlign's toast, after waiting behind every queued calibration.

## planner-engine

### [high] Scene open/close lifecycle (sceneToken + sceneLoad + sceneName)

*corrected* · `planner/engine.ts:1480-1514`, `planner/engine.ts:1660-1778`, `planner/engine.ts:1792-1823`, `planner/engine.ts:1549-1565`, `planner/engine.ts:1905-1936`, `planner/engine.ts:2420-2425`

**Encoding:** sceneToken generation counter, sceneLoad {loading, phase:'calibrating'|'photo'|null, name, scene}, nullable sceneName/sceneData/savedScene, a 'switching' local (room photo switch), and free-form 'scene' event phase strings (loading, calibrating, opened, failed, closed, saved, title, deleted, restored, recalibrating, recalibrated, recalibrate-failed)

**States:** closed (sceneName null, loading false) · loading-photo (loading true, phase photo) · calibrating (phase calibrating, waitForScene polling) · switching (room photo switch: loading false, old sceneName still shown) · opened · failed · recalibrating (sceneName set, waitForScene polling outside sceneLoad)

**Transitions:**
- closed/opened -> loading-photo on openSceneAs (not switching) [token++]
- loading-photo -> calibrating when calib_status is busy
- calibrating -> loading-photo when waitForScene resolves and the token still matches
- loading-photo/switching -> opened after the photo and depth load, items cleared, room set, layout loaded
- any loading -> failed on error (only if the token still matches)
- any -> closed on closeScene [token++]
- opened -> recalibrating on recalibrate() -> opened when waitForScene resolves (guarded by name only)

**Risks:**
- A room-photo switch never calls setLoad(true,...), so sceneLoad is (false,null,null,null); a busy calibration then runs setLoad(sceneLoad.loading, 'calibrating', sceneLoad.name, data) (1680), giving loading=false, phase='calibrating', name=null, and emits a 'calibrating' scene event while the old photo is still shown.
- setRoomPhoto's guard `scene === sceneName && !sceneLoad.loading` (2423) does nothing during a switch (loading stays false and sceneName is still the old photo), so repeated photo-strip presses each start a new openSceneAs (each bumps the token, superseding the previous).
- A superseded open never cancels waitForScene: only onTick checks the token (1682), and the loop (1553-1564) polls until calibration finishes. It has no overall timeout while the scene stays busy; the 15-minute limit applies only when a fetch fails.
- recalibrate checks only `name !== sceneName` (1911, 1915), not sceneToken. If the user closes A and reopens A, an old recalibrate applies its result to the new open: setPhoto(photo.image, depth), sceneData, lighting, and the camera.
- The token check after `await loadLayoutInternal(pick)` (1763) comes too late, because loadLayoutInternal itself is not token-aware (see current-layout).
- The 'scene' event phase strings are free-form and include phases beyond loading/opened (recalibrating, recalibrated, recalibrate-failed, restored, title, deleted).

**Crosses:** UI (planner/ui/) reads getSceneLoad() and the 'scene' events; the server's calib_status job is polled (calibration queue).

> Verifier: Mostly accurate. Corrected the waitForScene risk: the finder said polling lasts 'up to 15 min', but the 15-min cutoff (1557) applies only to failed fetches. While the scene stays busy, polling is unbounded. Also added that the switch case emits a spurious 'calibrating' event.

### [high] Current layout (layoutName/title, details, remembered per scope) and load/save across scene switches

*confirmed* · `planner/engine.ts:1976-2024`, `planner/engine.ts:2049-2110`, `planner/engine.ts:2114-2156`, `planner/engine.ts:1755-1765`

**Encoding:** layoutName ('' = none), layoutTitle, layoutDetails array, localStorage midstudy.layout.<scope> {name, at}, layoutScope() derived from room/sceneName at call time

**States:** no layout · layout current (clean/dirty, see dirty-tracking) · loading layout (clearItems + adds in flight) · saving · deleted (current cleared, remembered as null)

**Transitions:**
- none -> loading on loadLayoutInternal -> current
- current -> saving on saveLayoutInternal -> current (rememberLayout with the server's updated)
- current -> none on deleteLayoutInternal of the current one
- none -> current on restoreLayoutInternal when wasCurrent and no current layout
- any -> none on openSceneAs (not switching) / closeScene

**Risks:**
- loadLayoutInternal has no scene token. If scene A's layout GET lands after B's openSceneAs has cleared items and set sceneName=B (1698-1706), A's pieces are added into B. setLayoutName/rememberLayout(name) (2106-2107) then write A's layout name under B's scope, because layoutScope() is read after the await. B's own layoutToOpen can then pick from the corrupted record.
- saveLayoutInternal builds the doc before its await but runs setLayoutName/rememberLayout/markLayoutClean after it (2060-2062), against whatever scene or room is open by then.
- deleteLayoutInternal calls layoutQuery() separately for the GET and the DELETE across an await (2116-2117), so a scene switch in between deletes the same-named layout of another scope. rememberLayout(null) then also targets the new scope.
- listLayoutsInternal assigns layoutDetails from whichever response lands last (2149), with no token, so a late response for scene A can leave A's details while B is open.

**Crosses:** Server layouts API (/api/layouts?scene|room); the UI reads getLayoutName/getLayoutDetails and the 'layouts' events.

> Verifier: Every risk traced in code; no token or scope capture exists in loadLayoutInternal, saveLayoutInternal, deleteLayoutInternal or listLayoutsInternal.

### [high] Room view mode: placed vs unplaced photo, parked pieces, Align photos, floor plan

*corrected* · `planner/engine.ts:379-393`, `planner/engine.ts:2164-2247`, `planner/engine.ts:2264-2296`, `planner/engine.ts:2502-2511`, `planner/engine.ts:1697-1702`, `planner/engine.ts:1815-1818`, `planner/engine.ts:2474-2483`

**Encoding:** nullable room, parked: Parked[] | null, booleans alignPhotos and floorPlanShown, curPose() derived from room.members[sceneName].pose, ItemRec.roomAt nullable

**States:** no room · room + placed photo (items live, roomAt set) · room + unplaced photo (parked list, items empty) · unparking (parked=null, adds in flight) · alignPhotos on/off · floor plan shown/hidden

**Transitions:**
- no room -> room on openSceneAs(inRoom) (not switching)
- placed -> unplaced on placeRoomItems when the pose becomes null (parkItems)
- unplaced -> unparking -> placed on placeRoomItems when the pose appears (unparkItems)
- placed -> placed (re-projection) on setRoomInfo/previewPose pose or scale change
- alignPhotos on via setAlignPhotos (only with a room); off on floor plan hidden, a scene open (not switching), or closeScene
- room -> no room on closeScene / deleteRoom / deleteScene of the current photo

**Risks:**
- placeRoomItems is fired with quiet() and not awaited from previewPose and setRoomInfo (2274, 2293). During unparkItems, parked is already null (2215) while the addItemInternal builds are in flight. A previewPose that sets the pose back to null calls parkItems, which snapshots only the items that have landed and calls clearItemsInternal (itemsGen++). The in-flight adds are then cancelled by the gen check (1083), so those pieces are silently dropped from both items and parked: data loss for the room layout.
- unparkItems computes roomToSceneXf(p.at) before awaiting each add (2218). A live pose drag during the unpark runs placeRoomItems over only the items that have landed, so late pieces land at the stale pose's scene position (roomAt is right, the scene transform is not) until the next re-projection.
- A pose or scale change from setRoomInfo (followAlign, putRoom) during an item drag re-projects the items (2238), but drag.group keeps scene-frame starts from the old pose, so the next dragTo snaps pieces back to the stale positions. setAlignPhotos ends drags via select(null), but setRoomInfo doesn't.
- floorPlanShown is never reset by closeScene or a room change, so it carries over to the next room. setAlignPhotos doesn't check floorPlanShown, so alignPhotos=true with floorPlanShown=false is reachable.
- deleteScene of the current photo calls closeScene, ending the whole room view; deleteScene of another member refreshes the room only through a fire-and-forget getRoomInternal (1831). In removeSceneFromRoom of the current photo, putRoom's setRoomInfo runs first, so until openSceneAs finishes, curMember() is null: roomUnplaced() is true while items are still live, and addItemInternal refuses.

**Crosses:** planner/ui/room.ts (photo strip, floor plan, Align photos) drives previewPose/setPose/setAlignPhotos; the server's room detail (poses from the align-room job).

> Verifier: Risk 1 was wrong in its outcome: parkItems calls clearItemsInternal, which bumps itemsGen, so the in-flight adds are cancelled (1083) instead of landing next to a non-null parked list. The real effect is that those pieces are lost. Risk 5 was corrected: removeSceneFromRoom switches to members[0] and closes only when no members are left; deleteScene is the one that closes.

### [high] Placed item lifecycle (async build, itemsGen, per-item build token)

*confirmed* · `planner/engine.ts:699-703`, `planner/engine.ts:1048-1092`, `planner/engine.ts:750-782`, `planner/engine.ts:997-1025`, `planner/engine.ts:1166-1185`, `planner/engine.ts:1392-1402`

**Encoding:** items Map, itemsGen counter (dropped adds after a clear), ItemRec.build token (dropped rebuilds), child/splat/shadow/caster nullable fields, render 'glb'|'splat', missing/noGlb booleans

**States:** adding (built off-map) · placed (in the map and the scene) · rebuilding (build token in flight) · removed · cancelled add (gen mismatch)

**Transitions:**
- none -> adding on addItemInternal -> placed if gen === itemsGen, else cancelled (detachBuilt)
- placed -> rebuilding on syncPlaced/rebuildItem -> placed (child swapped) or dropped if the token is stale or the item was removed
- placed -> removed on removeItemInternal (build++) / clearItemsInternal (itemsGen++)

**Risks:**
- The uid-collision check `!items.has(uidIn)` (1067) runs before the await. Two concurrent adds with the same uid (restoreItems, a layout doc with duplicate uids, unpark racing a restore) both pass. attachBuilt calls splats().add(uid) for each before the gen check, and the second items.set overwrites the first, whose group stays in the scene orphaned (never removed or detached).
- An add started before a room photo switch lands after it: switching doesn't bump itemsGen, and syncRoomAt ran with the old pose before the await (1077). roomAt is right, but the scene position is from the old photo and is never re-projected, because placeRoomItems already ran.
- rebuildItem can swap a child (777-779) while captureMask is awaiting with materials swapped. The restore then writes the old materials onto the detached child, and the new child is drawn with its real materials in the mask. An add landing mid-mask is likewise unswapped.
- syncPlaced sets r.sig = sig (768) before rebuildItem. If the rebuild fails, the item keeps drawing the old child and won't retry until the library signature changes again.

**Crosses:** UI item lists, the hook (window.midstudy addItem); the splat layer (planner/gpu/splat-layer.ts) holds per-uid state.

> Verifier: All four risks hold in code. Location refined: syncPlaced is at 750-771 (where the sig is set before the rebuild).

### [high] Capture hold and full-frame swap (holdFrames counter, withFullFrame save/restore, mask material swap)

*confirmed* · `planner/engine.ts:2770-2773`, `planner/engine.ts:2778-2796`, `planner/engine.ts:2843-2879`, `planner/engine.passes.ts:225-242`, `planner/engine.passes.ts:265-273`, `planner/engine.ts:817-864`

**Encoding:** holdFrames counter, grid.visible and furnRT size saved in locals, camera view offset cleared and restored via updateView, swapped materials list, lights.maskMode(true/false), lazily made capture/mask targets

**States:** live view · holding (full frame, awaiting sort/read-back) · holding mask (materials swapped, maskMode)

**Transitions:**
- live -> holding on captureCanvas/captureMask (holdFrames++)
- holding -> live in the finally (restore grid, sizes, updateView, holdFrames--, wake)

**Risks:**
- withFullFrame is not reentrant, and nothing stops overlapping captures (exportImage with renderViewInternal, or two exports). The second saves gridWas=false and the furnRT size already set to the photo's. When the first finishes, it restores the view offset and screen size mid-capture of the second, which then reads a wrongly framed image. The second's finally restores the photo size and grid=false, so the grid stays hidden and furnRT stays at the photo size until the next resize.
- Overlapping captureMask runs swap materials twice: the second records P.maskMat as the 'original' (2854), so pieces stay white for good.
- modelThumbnail (makeMissingThumbs) renders synchronously through the same renderer and lights (withDiffuseIbl) and can run while a mask capture awaits with lights.maskMode(true) on.
- thumbTargets replaces thumbPass on a size change without disposing the old targets (818-825); this is dormant, because size is always 256.

**Crosses:** planner/lighting.ts (maskMode, fitShadow), planner/gpu/splat-layer.ts (settle); the UI render/export flows call these.

> Verifier: Verified in withFullFrame (no reentrancy guard) and captureMask. renderViewInternal itself runs the composite then the mask in sequence; the overlap needs two independent callers. Downgraded the thumb-dispose risk to dormant (size is constant).

### [medium] Selection and pointer drag (move/lift/rotate)

*confirmed* · `planner/engine.ts:1219-1249`, `planner/engine.ts:1293-1368`, `planner/engine.ts:1166-1174`, `planner/engine.ts:1454-1468`

**Encoding:** sel (Selection set) + mirrored `selected` primary; drag record {mode: DragMode|null, uid|null, off, a0, rot0, plane, group, centre}; global `snap` boolean

**States:** no selection · selected (single/multi) · dragging move · dragging lift · dragging rotate

**Transitions:**
- idle -> dragging on beginItemDrag/beginRotateDrag (selects if needed)
- dragging -> dragging on dragTo
- dragging -> idle on endItemDrag, on a selection change excluding drag.uid, or on removal of the drag uid
- selection change via select/selectMany/selectAll/tap/clearItems; select(null) when the ruler, Adjust floor or Align photos turns on

**Risks:**
- beginItemDrag and beginRotateDrag never end an active drag. If the new uid is already selected (no setSelection call), the second begin overwrites drag.* without a 'drag' end event, so the UI sees two starts and one end.
- beginRotateDrag never sets drag.off, and endItemDrag leaves plane/off/a0/rot0/centre stale; the fields are only valid per mode, but the record type allows any combination.
- Drags are not refused while ruler.active, adjustFloor or alignPhotos is on: those modes only clear the selection when they start, and the guard lives in the UI/input layer.
- `selected` duplicates sel.primary and is assigned separately in removeItemInternal (1171) and setSelection (1233); any new mutation path can desync them.
- The global `snap` sets the default lift mode at drag begin (1296) and is read again live for lift snapping (1346) and rotate snapping (1352), so a Shift change mid-drag changes snapping but not the mode.

**Crosses:** planner/input.ts and the UI drive the begin/dragTo/end calls and read getDrag() and the 'drag' events.

> Verifier: Accurate. Nuance on risk 1: if begin calls select(uid) on an unselected piece, setSelection ends the old drag first, so the double start happens only when the piece is already in the selection.

### [medium] Ruler (Adjust floor): active flag and 0/1/2 points

*confirmed* · `planner/engine.ts:1411-1445`, `planner/engine.ts:1454-1464`, `planner/engine.ts:1958-1964`, `planner/engine.ts:1703-1704`, `planner/engine.ts:1807-1808`, `planner/engine.ts:2447-2458`

**Encoding:** ruler {active: boolean, points: Vec3[] (length 0..2)} together with the adjustFloor boolean

**States:** inactive · active, 0 points · active, 1 point · active, 2 points (measured)

**Transitions:**
- setRulerActive(true) -> active (selection cleared); setRulerActive(false) -> inactive, points cleared
- tap while active: push a point; the third tap resets to 1 point
- setRulerPointAt moves a point; setRulerTrueLength rescales the points and the camera
- setAdjustFloor(false), openSceneAs and closeScene -> inactive

**Risks:**
- openSceneAs calls clearRuler(), which emits 'ruler' with active still true, then sets ruler.active = false without emitting (1703-1704). closeScene clears the ruler without any 'ruler' event (1807-1808). A UI that follows only 'ruler' keeps showing it as active.
- setRulerActive(true) doesn't check adjustFloor or sceneName, so ruler.active && !adjustFloor is reachable.
- setRoomScale captures ruler.points before awaiting putRoom, then overwrites them with the scaled copy (2452-2455). Taps or point drags during the request are lost, and if the scene changed meanwhile, the old points are written onto the new one.

**Crosses:** UI Adjust floor panel (listens to 'ruler'/'adjust').

> Verifier: Verified at the cited lines.

### [medium] Scene and layout dirty state with baselines and the quietItems suppression counter

*corrected* · `planner/engine.ts:1515-1536`, `planner/engine.ts:2208-2209`, `planner/engine.ts:2232-2245`, `planner/engine.ts:2078-2108`

**Encoding:** dirty {scene, layout} booleans, sceneBaseline/layoutBaseline signature strings, a quietItems counter that suppresses the 'items' listener, parked list included in layoutSig

**States:** clean · scene dirty · layout dirty · suppressed (quietItems > 0)

**Transitions:**
- 'items' event (quietItems == 0) -> layout dirty if sig != baseline
- setCamera/resetCamera -> touchScene
- markLayoutClean on save/load
- openSceneAs/closeScene -> clean

**Risks:**
- quietItems is one global counter shared by concurrent async operations (a loadLayout's quietly, an unpark's quietly, closeScene's quiet clear). While one is in flight, user moves emit 'items' but are ignored by the dirty listener, and loadLayoutInternal's following markLayoutClean takes the user's edits into the baseline, so they read as saved.
- saveLayoutInternal's markLayoutClean runs after its await, so edits made while the PUT is in flight, which aren't in the saved doc, become part of the clean baseline.

**Crosses:** UI save prompts read isSceneDirty/isLayoutDirty and the 'dirty' events; getState().dirty.

> Verifier: Dropped the risk that placeRoomItems/unpark don't recompute dirtiness: layoutSig compares in the room frame (parked included), so re-projection rightly leaves dirtiness unchanged. Dropped the Look/occlusion note, which the code shows is by design. Added the save-in-flight baseline race (2062).

### [medium] Look autosave debounce (lookTimer) and flush

*confirmed* · `planner/engine.ts:2657-2675`, `planner/engine.ts:2676-2701`, `planner/engine.ts:1670`, `planner/engine.ts:1793`

**Encoding:** lookTimer handle (null = nothing pending), sceneName read at flush time, keepalive PUT in flight untracked, savedScene.look updated on success

**States:** idle · pending (timer armed) · flushing (PUT in flight)

**Transitions:**
- idle/pending -> pending on setLighting/resetLighting (saveLookSoon)
- pending -> flushing on the timer, pagehide, visibility hidden, openSceneAs or closeScene
- flushing -> idle on the response

**Risks:**
- Flushes are not serialised: rapid changes plus pagehide/visibility flushes can have two keepalive PUTs in flight, which may land out of order and save the older Look last.
- saveScene's PUT also carries the look (1863) and races the autosave PUT.
- flushLook reads sceneName and look at fire time (2667-2670). openSceneAs flushes only at its start (1670). A setLighting made while B is loading (sceneName still A) arms a timer; if it fires after B opened (look replaced at 1710), it writes B's own freshly loaded look to B (a spurious write), and A's change is lost.

**Crosses:** Server PUT /api/scenes/<name> (look).

> Verifier: Verified. No in-flight tracking or sequence number on the autosave PUT.

### [medium] Lighting backfill: lightingStatus enum + lightingToken + polling loop

*confirmed* · `planner/engine.ts:1492-1494`, `planner/engine.ts:2702-2744`, `planner/engine.ts:1711-1712`, `planner/engine.ts:1751`, `planner/engine.ts:1918-1919`

**Encoding:** explicit status enum (done|missing|pending|running|none|failed) but with implicit transitions; lightingToken generation to drop stale polls; lightingData nullable

**States:** missing · pending · running · done · none · failed

**Transitions:**
- missing -> pending on inferLighting POST accepted (auto on open when calib is done)
- pending <-> running from polls
- pending/running -> done|none|failed when a poll sees the end
- any -> from the server's value on openSceneAs/recalibrate (setLightingData, token++)

**Risks:**
- If the 600-iteration loop runs out, inferLighting returns null and leaves the status 'pending' or 'running' forever, with no event (2743).
- recalibrate bumps lightingToken (killing an in-flight poll) and may set the status to pending/running from the server (1918-1919), but nothing polls afterwards, so the status sticks until a reopen.
- The POST-failure branch checks name === sceneName but not the token (2719), so it can overwrite a newer poll's status with 'failed'.
- Concurrent inferLighting calls: the second bumps the token, but the first's POST already ran, so the server gets two jobs.

**Crosses:** The server's lighting job (lighting_status on the scene, calib worker); the UI Look panel listens to 'lighting'.

> Verifier: All four risks verified.

### [medium] Kernel worker lifecycle with main-thread fallback

*corrected* · `planner/engine.ts:307-335`, `planner/engine.ts:1612-1620`, `planner/engine.worker.ts:9-14`

**Encoding:** kernelWorker nullable + workerDown promise nullable: (null,null)=not started, (set,set)=running, (null,rejected)=dead or unavailable; each request races call against down

**States:** not started · running · dead (error event) · unavailable (constructor threw)

**Transitions:**
- not started -> running on the first inWorker call
- running -> dead on the worker's 'error' event
- not started -> unavailable when new Worker throws
- dead/unavailable: permanent main-thread fallback

**Risks:**
- No timeout: a worker that hangs (loads but never answers, or posts something unreadable: there is no 'messageerror' listener) leaves inWorker awaiting forever, so loadDepth and openSceneAs hang with sceneLoad.loading stuck true.
- The worker is never terminate()d after its 'error' event; a Worker 'error' can also fire for an uncaught error inside a still-running worker, which is then abandoned and leaks.
- Once dead it never restarts, so one transient failure moves every later depth decode to the main thread for the session.

**Crosses:** core/js/web.ts KernelWorker/serveKernels (request ids, wasm load retry), owned by the kernels track.

> Verifier: Dropped the claim that pending requests aren't rejected on death: workerDown is created together with the worker (314), before any call, and every inWorker races it (331), so pending calls do fall back when the error fires. Dropped the engine.worker.ts retry note: that state lives in core/js/web.ts, outside this group.

### [medium] Library load and placed-copy sync (libraryLoading promise, library array)

*confirmed* · `planner/engine.ts:699-700`, `planner/engine.ts:720-771`, `planner/engine.ts:1757`

**Encoding:** libraryLoading promise (the read in flight), the library array replaced wholesale, per-item sig strings

**States:** unloaded (empty) · loading · loaded · failed (empty list, error reported)

**Transitions:**
- -> loading on loadLibrary (init, reloadLibrary)
- loading -> loaded/failed; syncPlaced rebuilds the changed copies; makeMissingThumbs is kicked off

**Risks:**
- No generation: two overlapping reloadLibrary calls can resolve out of order, and the older list then overwrites the newer one (and syncPlaced rebuilds back to the stale assets).
- A failed read sets library = [] (738), so a layout loaded next marks every piece missing (placeholder boxes), with no retry.
- openSceneAs awaits only the libraryLoading current at line 1757; a reload begun later isn't awaited.

**Crosses:** planner/data.ts triggers reloadLibrary after library changes; server library.json.

> Verifier: Verified. Placed copies survive an empty library (syncPlaced skips ids it can't find), but new layout loads compute `missing` against the empty list (2080).

### [medium] Room alignment follow/wait polling

*confirmed* · `planner/engine.ts:2338-2371`, `planner/engine.ts:2391-2407`

**Encoding:** the `following` Set of room names as an in-flight marker, the server's align_status string (none|pending|running|failed|done), bounded and unbounded poll loops

**States:** not following · following (pending/running) · aligned · align-failed · abandoned (404 / gave up)

**Transitions:**
- alignRoom -> emit aligning, followAlign starts if not already following
- following -> aligned/align-failed when the status leaves pending/running
- following -> abandoned on a 404 or after 2400 polls (no event)

**Risks:**
- On a 404 (2361) or when the loop runs out, followAlign returns without an 'aligned'/'align-failed' event, so a UI that showed 'aligning' stays there.
- waitForRoom has no overall timeout while the alignment stays running or a member stays calibrating; the 15-min limit applies only to failed fetches.
- Following continues after the room is closed (setRoomInfo then ignores the result), but the 'room' aligned/align-failed event and toast still fire for a room that isn't open.

**Crosses:** Server align job (calib queue, align-room MASt3R/Manhattan) via /api/rooms/<r>; the UI room panel listens to the 'room' phases.

> Verifier: Verified.

### [low] On-demand render loop (awakeUntil, framePending, holdFrames, renderErrorReported)

*corrected* · `planner/engine.ts:266-273`, `planner/engine.ts:2978-2994`

**Encoding:** timestamp awakeUntil, boolean framePending, counter holdFrames, one-shot boolean renderErrorReported

**States:** asleep · awake (tail) · pending single frame · held · errored (reported once)

**Transitions:**
- asleep -> awake on wake() (input, any emit, updateView, a splat sort landing)
- awake -> asleep when now > awakeUntil and no frame is pending
- any -> held while holdFrames > 0
- rendering -> errored on an exception (reported once)

**Risks:**
- renderErrorReported is never reset, so after one failure every later render failure (another scene, a WebGPU device loss) is silent for the session.
- There is no device-lost handling in the engine: after a device loss the loop keeps calling renderFrame and swallowing the errors.

**Crosses:** onFrame subscribers (UI overlays) run only on drawn frames.

> Verifier: Dropped the third 'risk' (wake while held), which the finder itself called correct; holding()'s finally always wakes. The device-loss claim holds: grep finds no device-lost handler in engine.ts.

### [low] Splat pass redraw cache (splatEpoch + key string + P.splat.drawn) and lazy splat layer

*corrected* · `planner/engine.ts:540-545`, `planner/engine.ts:892-899`, `planner/engine.ts:1014`, `planner/engine.ts:1017`, `planner/engine.passes.ts:198-214`, `planner/engine.passes.ts:156-158`

**Encoding:** splatEpoch counter, key = joined matrices/sizes/epoch, P.splat.drawn (null = invalid), splatLayer nullable (made on the first splat item, never disposed), P.splat.quad nullable

**States:** no layer · layer, nothing drawn · drawn (key valid) · stale (key changed)

**Transitions:**
- no layer -> layer on the first attachBuilt with a splat
- drawn -> stale on an epoch bump (worker sort landed, attach/detach) or a camera/size/depth change
- stale -> drawn in drawFrame; an exception -> drawn=null

**Risks:**
- The key uses the depth texture's id, not its contents; it is safe only because setPhoto always makes a new DataTexture.
- splatLayer, its target and P.splat.quad live forever after the first splat item (not released on closeScene).

**Crosses:** planner/gpu/splat-layer.ts owns the sort state; its onChange bumps the epoch here.

> Verifier: Dropped the risks the finder itself called correct: the drop to 0 and back is covered because attachBuilt bumps the epoch, and Look/lighting are applied at composite time. Kept the never-disposed layer and narrowed the depth-key risk.

### [low] Missing-thumbnail worker queue (thumbsRunning + thumbTried)

*confirmed* · `planner/engine.ts:790-826`

**Encoding:** thumbsRunning boolean as a mutex, thumbTried Set as done/attempted markers, a loop re-reading library

**States:** idle · running (one item at a time)

**Transitions:**
- idle -> running on makeMissingThumbs (after each library read)
- running -> idle when no entry needs a thumb

**Risks:**
- Failed items are added to thumbTried (802) before the attempt and never retried this page load.
- It renders with the shared renderer while captures may hold (see capture-hold).

**Crosses:** Server PUT /api/library/items/<id>/thumb.

> Verifier: Verified.

### [low] Photo/depth resources and the occlusion flag

*corrected* · `planner/engine.ts:430-439`, `planner/engine.ts:1622-1648`, `planner/engine.ts:1716-1717`, `planner/engine.ts:1930`, `planner/engine.ts:1965-1969`

**Encoding:** PhotoState {has, image, texture, depth, depthTexture} nullable fields + occlusion boolean + P.depth.mesh.visible derived

**States:** no photo · photo without depth · photo with depth, occlusion on · photo with depth, occlusion off

**Transitions:**
- setPhoto/clearPhoto (dispose the old textures)
- setOcclusion(on) by the user
- openSceneAs sets occlusion = !!depth; recalibrate turns it on if a depth appears

**Risks:**
- setOcclusion(true) without depth leaves occlusion=true while hasDepth=false; getState and the 'occlusion' event report on.
- recalibrate with a depth that is now null calls setPhoto(img, null) but leaves occlusion true (the same illegal combination).
- clearPhoto (closeScene) resets has/image/textures but not w/h, so the last photo's size keeps driving the view maths (viewParams, kcam, landing) while no photo is open.

**Crosses:** getState().scene (hook, evals) reads occlusion/hasDepth.

> Verifier: Risk 3 corrected: the finder said w/h are the 1600x1200 defaults while no photo is open, but that is true only before the first open. clearPhoto leaves the last photo's dimensions.

### [low] GLB and splat file promise caches with invalidation

*confirmed* · `planner/engine.ts:710`, `planner/engine.ts:866-884`, `planner/engine.ts:901-909`, `planner/engine.ts:757-767`

**Encoding:** Map<url, Promise> (in flight or resolved), deleted on rejection or on a library signature change

**States:** absent · in flight · resolved · rejected (removed)

**Transitions:**
- absent -> in flight on a load
- in flight -> resolved / rejected (deleted)
- resolved/in flight -> absent on syncPlaced invalidation

**Risks:**
- The rejection handler deletes by url, not by identity (`p.catch(() => glbCache.delete(url))`, 882, 907). If an invalidated older promise rejects after a newer one was cached for the same url, the newer entry is evicted.
- Invalidation doesn't cancel in-flight loads: a build that already holds the old promise still receives the old bytes.

> Verifier: Verified.

### [low] Render request (render event start/done/failed) and the renders list

*confirmed* · `planner/engine.ts:2904-2963`, `planner/engine.ts:1734`, `planner/engine.ts:1766`

**Encoding:** emitted phases only; renders array replaced by listRendersInternal or prepended by postRender; renderMock boolean

**States:** idle · posting · done · failed

**Transitions:**
- idle -> posting on postRender (emit start)
- posting -> done/failed

**Risks:**
- No in-flight guard: concurrent renders interleave 'render' events with no correlation id (only the model).
- A listRendersInternal for the previous scene landing after a scene switch overwrites renders with the old scene's list (no token; openSceneAs sets renders=[] then calls quiet(listRendersInternal())).

**Crosses:** Server /api/render (fal job, mocked in dev); the UI render panel.

> Verifier: Verified. postRender itself filters by the current scene/room (2933), but listRendersInternal does not.

### [low] Startup landing and persisted 'last opened' state (LAST_ROOM_KEY / LAST_SCENE_KEY / roomPhoto keys / URL params)

*found by verifier* · `planner/engine.ts:300`, `planner/engine.ts:2174-2175`, `planner/engine.ts:1735-1742`, `planner/engine.ts:1780-1790`, `planner/engine.ts:1828`, `planner/engine.ts:2487`, `planner/engine.ts:3093-3123`

**Encoding:** localStorage midstudy.lastRoom (set means 'last thing opened was a room', cleared when a lone scene opens), midstudy.lastScene, midstudy.roomPhoto.<room>, and the URL's ?room&photo vs ?scene, rewritten by syncUrl; startScene decides room vs scene vs none from their combination

**States:** fresh (nothing remembered) · last was a scene · last was a room (+ its photo) · URL names a room · URL names a scene · landing in progress (startScene running)

**Transitions:**
- openSceneAs in a room -> lastRoom=room, roomPhoto=name
- openSceneAs alone -> lastRoom=null, lastScene=name
- closeScene -> URL cleared, keys kept
- deleteScene/deleteRoom -> the matching key cleared
- startScene: ?room or lastRoom -> openRoom, else landing(?scene, lastScene)

**Risks:**
- init runs startScene concurrently with the UI being usable: if the user opens a scene from the Scenes page while startScene is still awaiting listRoomsInternal/listScenesInternal, startScene's later openRoom/openScene bumps sceneToken and replaces the user's choice.
- closeScene clears the URL but not lastRoom/lastScene, so a reload after closing reopens the closed scene or room; the URL and the stored state disagree.
- Opening a room never clears lastScene, and the two keys' precedence lives only in startScene (`!params.get('scene') && lastRoom`).

**Crosses:** UI Scenes page (what the page shows on landing); browser URL/history.

### [low] Scene camera provenance (cameraSource string + savedScene baseline + sceneBaseline)

*found by verifier* · `planner/engine.ts:1490`, `planner/engine.ts:1708-1715`, `planner/engine.ts:1861-1878`, `planner/engine.ts:1922-1928`, `planner/engine.ts:1939-1957`

**Encoding:** cameraSource free string ('default' | 'auto' | 'manual' | the server's value), mutated in openSceneAs, setCamera (sourceAfterChange vs savedScene), resetCamera (hard-coded auto/default), saveScene and recalibrate; scene dirtiness compares only the camera signature (sceneSig), not the source

**States:** default · auto (calibrated) · manual (hand-set) · saved vs unsaved

**Transitions:**
- openSceneAs -> from the scene's camera_source
- setCamera -> sourceAfterChange(cam, savedScene.camera, savedScene.camera_source)
- resetCamera -> 'auto' if calib has a camera else 'default'
- saveScene -> the server's camera_source
- recalibrate -> the server's source only when !dirty.scene && cameraSource !== 'manual'

**Risks:**
- resetCamera sets cameraSource without consulting savedScene, while sceneSig ignores the source. Resetting to a camera equal to the saved one leaves the scene clean although cameraSource now differs from savedScene.camera_source, so the source change is never prompted for saving.
- recalibrate's decision depends on two independent flags (dirty.scene, cameraSource), and the server applies its own 'not set by hand' rule; when they disagree, the local cam and the server's stored camera diverge until a reopen.

**Crosses:** Server PUT/POST /api/scenes/<name>(/calibrate) camera_source; getScene().camera_source (hook, UI).

### [low] Scene and room list caches (scenesList/scenesTrash, roomsList/roomsTrash)

*found by verifier* · `planner/engine.ts:1498-1499`, `planner/engine.ts:1537-1544`, `planner/engine.ts:1897-1899`, `planner/engine.ts:2172-2173`, `planner/engine.ts:2300-2310`

**Encoding:** arrays replaced wholesale by whichever list response lands last, mutated in place by saveThumbnail, and read by serverHasRooms() to decide whether the server has rooms

**States:** empty (never listed) · listed · stale (a later write not yet re-listed)

**Transitions:**
- listScenesInternal/listRoomsInternal -> replaced
- saveThumbnail -> entry.thumb_url mutated in place
- many writes fire quiet(list…()) afterwards

**Risks:**
- Many fire-and-forget list refreshes (deleteScene, renameScene, saveScene, createScene, putRoom, deleteRoom...) have no generation, so an older response landing last overwrites a newer list.
- serverHasRooms() returns false until a list has loaded, so code gated on it treats a rooms server as rooms-less during startup.

**Crosses:** UI Scenes page ('scenes'/'rooms' events); server /api/scenes and /api/rooms.

## planner-core

### [medium] Canvas pointer gesture (tap / item drag / shift-toggle-or-lift / pan / pinch)

*corrected* · `planner/input.ts:25-38 (Gesture)`, `planner/input.ts:55-57 (ptrs, g, pinch)`, `planner/input.ts:63-96 (pointerdown)`, `planner/input.ts:97-118 (pointermove)`, `planner/input.ts:119-131 (up/cancel)`, `planner/logic/input.ts:18-30 (GestureKind, isTap, pans)`, `planner/engine.ts:1293-1367 (beginItemDrag/beginRotateDrag/dragTo/endItemDrag, shared drag.mode/uid)`, `planner/ui/workspace.ts:600-606 (rotate grip drives the same drag)`

**Encoding:** g: Gesture | null with a string kind ('other'|'item'|'pan'|'pinch'|'shift') mutated in place, booleans moved/multi, nullable hit, a separate nullable pinch record, and the size of the ptrs Map. The 'item' kind mirrors engine.ts's own drag.mode/uid, a second machine also driven by the rotate grip.

**States:** idle (g null, ptrs empty) · pressed/other (one pointer, not moved) · shift-pending (Shift on a piece: click toggles, drag lifts; decided on first move) · item-drag (engine drag active) · pan (middle button, or drag while zoomed) · pinch (2 pointers, pinch set, g.multi) · pinch-residual (one finger lifted: pinch null, g.kind 'pinch', g.multi true) · 3+ pointers (extra pointers tracked in ptrs but otherwise ignored)

**Transitions:**
- idle -> pressed/other on pointerdown on canvas with a scene open
- idle -> pan on middle-button pointerdown
- idle -> shift-pending on Shift+pointerdown (not ruler, not Adjust floor)
- idle -> item-drag on pointerdown on the selected piece (or any piece with mouse/pen, not in ruler/Adjust floor) when engine.beginItemDrag succeeds
- shift-pending -> item-drag (lift) | other on first move past tap slop
- shift-pending -> idle on pointerup (toggle selection if hit)
- other -> pan on move when zoom > 1.001
- any -> pinch on second pointerdown (an item drag is ended first)
- pinch -> pinch-residual when one pointer lifts
- pinch-residual -> pinch when a finger is added again (ptrs.size back to 2)
- pinch-residual -> idle when the last pointer lifts (never a tap: multi)
- item-drag -> idle on pointerup/pointercancel (engine.endItemDrag)
- other -> idle on pointerup; tap when decide.isTap

**Risks:**
- No drag token between input and engine: pointermove calls engine.dragTo (input.ts:111) and pointerup calls engine.endItemDrag() (input.ts:125) for kind 'item' whatever drag the engine holds. beginRotateDrag (engine.ts:1312) overwrites drag.mode without checking for a drag in progress, and the grip's pointerdown is not seen by input.ts (target !== canvas, input.ts:64). With touch, a finger dragging a piece on the canvas plus a second finger on the rotate grip lets the canvas finger's moves drive the rotation, and its lift ends the grip's rotate drag.
- With 3+ pointers, lifting one of the two pinch pointers leaves ptrs.size at 2, so pinch is not reset (input.ts:121). mid() (input.ts:58-62) then pairs a different two pointers against the stale d0/mx/my, and zoom and pan jump.
- pinch-residual is a dead end: pans() needs !multi (logic/input.ts:29), so the remaining finger can neither pan nor drag. If the lifted finger was g.id, the remaining finger's moves are ignored (input.ts:108) until every finger lifts.
- getSceneName() is checked only at pointerdown/wheel (input.ts:64, 136). A gesture still in flight when openScene swaps the scene ends with a tap (input.ts:128) on the new scene. dragTo/endItemDrag are harmless there because removal ends the engine drag (engine.ts:1172, 1184).

**Crosses:** Drives engine.ts's drag machine (drag.mode/uid, engine.ts:1293-1367), which ui/workspace.ts's rotate grip (engine.getDrag) and engine-internal removal/selection paths (engine.ts:1172, 1234) also drive; reads the engine's ruler and Adjust floor modes.

> Verifier: Machine and most transitions confirmed. Added pinch-residual -> pinch. The rotate-grip conflict needs two touches (canvas plus grip) because beginRotateDrag never checks drag.mode; reworded it. Dropped the enabled.pointer part: nothing ever sets enabled.pointer false (grep finds only ui/shell.ts:731 setKeyFilter). Dropped the dispose() risk: dispose is never called. Dropped the stale-hit risk: beginItemDrag returns false for a missing uid (engine.ts:1295), so the gesture falls back to 'other', and a deselected but existing hit is reselected by design (engine.ts:1302).

### [medium] Page startup and the test hook's ready lifecycle

*corrected* · `planner/ready.ts:6-10`, `planner/ready.ts:22`, `planner/main.ts:31-37`, `planner/main.ts:49-54`, `planner/main.ts:163`, `planner/main.ts:166-171`, `planner/engine.ts:347 (top-level await renderer.init())`, `planner/engine.ts:3120-3123 (init: Promise.allSettled)`

**Encoding:** An unresolved Promise plus a mutable settle closure. Which object window.midstudy holds (placeholder or full hook) shows how far startup got. Success and failure are not distinguished (settleReady in finally).

**States:** module loaded (placeholder hook: ready pending, errors []) · engine module awaiting renderer.init (top-level await) · main running (full hook installed, areas mounted, some possibly failed) · init pending · settled: scene opened · settled: Scenes page shown (also when startScene failed) · never settles (engine top-level await rejected)

**Transitions:**
- ready.ts runs -> placeholder hook
- engine.ts top-level await resolves -> main.ts executes -> full hook
- engine.init resolves a name -> next frame -> ready
- engine.init resolves null (no scene, or startScene threw) -> Scenes page -> ready

**Risks:**
- If renderer.init() rejects (engine.ts:347, top-level await, uncaught), main.ts never runs. ready never settles, and window.midstudy.errors stays the placeholder [] from ready.ts:22, a different array from engine.errors, so the failure is invisible to anything waiting on the hook.
- ready resolves the same way when startup failed: init swallows startScene failures (Promise.allSettled, engine.ts:3121) and returns null, so the page lands on Scenes. A caller cannot tell a failed start from 'no scene' without reading errors.
- A caller that captured window.midstudy.errors from the placeholder holds a dead array after main.ts:163 swaps the hook.
- scenes.start() and lib.start() (main.ts:170-171) run concurrently with init's own listScenesInternal (engine.ts:3110), so the first 'scenes' events arrive in nondeterministic order (feeds the scenes-poll race).

**Crosses:** window.midstudy.ready/errors are read by every browser eval (E12 reads ready right after load); engine.ts owns init, errors and reportError.

> Verifier: Confirmed the top-level await at engine.ts:347 and the placeholder errors array. engine.init cannot reject: it uses Promise.allSettled (engine.ts:3121), so the 'Startup failed' catch at main.ts:168 only fires if shell.openPage throws. The real failure path is init returning null. Dropped the vague area-mount risk: the hook does null-check ctx.floorPlan (main.ts:152).

### [medium] Scenes store: load, poll while calibrating, offline backoff

*corrected* · `planner/data.ts:105-108`, `planner/data.ts:110-122`, `planner/data.ts:123-126`, `planner/data.ts:127-135`, `planner/data.ts:159-160`, `planner/logic/scenes.ts:21-34`, `planner/engine.ts:1537-1544 (listScenesInternal emits 'scenes' on each answer)`

**Encoding:** Two booleans (loaded, offline) and one setTimeout handle reused for two cadences (1.5 s poll, 10 s retry). There is no request id: every engine 'scenes' event, from any caller, is applied in arrival order.

**States:** unloaded · unloaded-offline (first refresh failed) · idle (loaded, nothing busy, no timer) · polling (a scene pending/running, 1.5 s timer) · offline-backoff (offline true, 10 s timer) · loaded-but-offline (stale list shown)

**Transitions:**
- start/refresh success -> idle | polling (schedule)
- refresh failure -> offline-backoff (10 s), emits store 'scenes' with the old list
- offline-backoff timer -> refresh
- polling timer -> refresh
- any engine 'scenes' event (other callers too) -> offline cleared, timer cleared and rescheduled

**Risks:**
- Stale-response race: overlapping listScenesInternal calls (this timer, the upload's refresh, engine init, waitForScene, the hook's listScenes) each emit 'scenes' when they answer (engine.ts:1542), with no sequence. An older answer landing after a newer one rewinds list and seen (done -> running), and the next answer emits 'ready'/'failed' a second time (data.ts:116-117).
- A refresh that fails after a newer success sets offline=true and replaces the 1.5 s calibration poll with a 10 s retry (data.ts:129-132), although the list is fresh.
- Every failure also goes through engine.reportError (engine.ts:1539): engine.errors grows by one line every 10 s while the server is down, and a sticky error toast is replaced each time (shell dedupes by text, ui/shell.ts:569-571).
- There is no stop/dispose: the timer runs for the page's life.

**Crosses:** Fed by engine.ts's 'scenes' event (listScenesInternal is also called by engine init, waitForScene and the hook); consumed by ui/scenes.ts and others via scenes.events; statuses come from server/src/scenes and the calibration queue.

> Verifier: Race and backoff confirmed in code. Added the reportError-per-failure effect. Dropped the 'ambiguous loaded && offline' point as a design note rather than a defect, and merged the 'cadence depends on caller' point, which the finder itself called correct.

### [medium] Library jobs: per-job status mirror and the jobs poll loop

*corrected* · `planner/data.ts:238-239`, `planner/data.ts:242-252`, `planner/data.ts:253-260`, `planner/data.ts:261-265`, `planner/data.ts:267-272`, `planner/logic/library.ts:84-94`, `planner/wire.ts:87-106`

**Encoding:** A Map from job id to last status, the jobs list replaced wholesale on every answer, and one setTimeout handle. done/failed are edge-detected from consecutive snapshots; there is no request sequence and no backoff.

**States:** per job: unseen, queued, running, done, failed · store loop: idle (no busy job), polling (1.5 s), failing-retry (1.5 s, error reported each time)

**Transitions:**
- addFromFile/addFromUrl/edit -> track(job): status seeded, list prepended, schedule
- poll answer -> setJobs: changed to done -> 'job-done' + reloadLibrary + spend; changed to failed -> 'job-failed' + spend
- jobs() failure -> schedule() again (same 1.5 s) and reject with a reported error
- no busy job -> idle

**Risks:**
- Overlapping jobs() calls (the timer, the hook's libraryJobs, UI calls) apply in arrival order. An older 'running' answer after a newer 'done' rewinds status (jobChange returns null), so the next answer emits 'job-done' again, with a duplicate reloadLibrary() and spend fetch (data.ts:245).
- A jobs() answer that was in flight before an add's POST replaces state.jobs wholesale (data.ts:249) and drops the job track() just prepended. If no other job is busy, schedule() then stops polling (data.ts:263-264), so the new job never shows and no 'job-done' fires until something else calls jobs().
- While the server is unreachable and a job is busy, jobs() fails and reschedules every 1.5 s with no backoff. Each failure calls report() -> engine.reportError: engine.errors grows by a line every 1.5 s and the sticky error toast is replaced each time (ui/shell.ts:569-571 dedupes by text, so it does not stack).
- A job the server drops from its list while busy disappears through setJobs with no terminal event, so spend is not refreshed.
- jobChange (logic/library.ts:89-94) does not require a busy 'before': done -> failed or failed -> done between snapshots also emits. status entries are never pruned.

**Crosses:** Server-owned job records (server/src/library jobs, pipeline/ midstudy-add); engine.reloadLibrary; consumers of lib.events (ui/panels/library.ts); the hook's libraryJobs (main.ts:109).

> Verifier: Confirmed. Corrected the toast claim: the shell dedupes by kind:text, so toasts do not stack but errors[] grows. Added the in-flight answer erasing the optimistically tracked job (and stopping the poll). Dropped the vocabulary-difference point: queued vs pending comes from the contract (common.schema.json jobStatus vs scene calib_status) and is handled per kind.

### [low] Keyboard dispatch and modal key routing (filter, typing, Esc priority chain, snap)

*corrected* · `planner/input.ts:42-43`, `planner/input.ts:146-156`, `planner/input.ts:166-197`, `planner/keymap.ts:63-68`, `planner/keymap.ts:73-80`, `planner/keymap.ts:87-104`, `planner/ui/workspace.ts:593 (adjust.leave, priority 10, when excludes ruler)`, `planner/ui/shell.ts:731 (keyFilter)`

**Encoding:** No explicit mode. The planner's modes (modal/page open, ruler, Adjust floor, selection, scene loading, typing) are re-derived at each keydown from a keyFilter closure installed by ui/shell.ts, from each command's when() reading engine getters, and from numeric priorities spread across modules (ruler 20, Adjust floor 10 in ui/workspace.ts, deselect 0). Snap is an engine boolean toggled by Shift keydown/keyup/blur.

**States:** filtered (shell modal/page open: keyFilter swallows) · typing (focus in input/textarea/select/contenteditable: only inInputs commands; Esc blurs) · ruler mode (Esc leaves ruler) · adjust-floor mode (Esc leaves it, priority 10) · selection (Esc deselects; arrows/R/PageUp/⌘D act) · no scene / scene loading (view and item keys off) · snap on/off (Shift held)

**Transitions:**
- keydown Shift -> snap on (before keyFilter, so even while a modal swallows keys)
- keyup Shift or window blur -> snap off
- Esc in a field -> blur field
- Esc -> highest-priority command whose when() holds: ruler off, else Adjust floor off, else deselect
- shell modal/page opens/closes -> keyFilter starts/stops swallowing

**Risks:**
- Mode precedence is encoded twice: in priority numbers spread across modules (input.ts:175 ruler 20, workspace.ts:593 adjust 10, input.ts:176 deselect 0) and in when() guards (adjust.leave also checks !ruler.active). A new binding on the same combo with a clashing priority silently changes which mode wins; ties go to registration seq (keymap.ts:94).

**Crosses:** keyFilter installed by ui/shell.ts:731; UI modules register commands with priorities into the same keymap; when() guards read engine.ts state (ruler, Adjust floor, sceneLoad, selection).

> Verifier: Dropped the 'disabled' state: enabled.keyboard is never set false anywhere. Dropped the arrows-in-ruler/Adjust floor risk: setRulerActive(true) and setAdjustFloor(true) both clear the selection (engine.ts:1417, 1960). In Adjust floor a tap-selected piece can also be dragged (input.ts:88 has no adjust guard), so nudging there matches the drag behaviour. Dropped the stuck-snap risk: focus moving into an iframe or devtools fires window blur, which input.ts:156 handles. The snap asymmetry is harmless, as the finder said.

### [low] Client-side shadow of each scene's calibration status (pending -> running -> done | failed)

*corrected* · `planner/data.ts:108`, `planner/data.ts:114-119`, `planner/data.ts:159`, `planner/logic/scenes.ts:21-34`, `planner/wire.ts:150-165 (calib_status: string | null)`, `contract/api/scene-object.schema.json:22 (enum pending|running|done|failed)`

**Encoding:** A Map of the last seen status per scene name. 'ready'/'failed' are derived by comparing consecutive polled snapshots, not by observing transitions.

**States:** unseen · pending · running · done · failed · absent/malformed (null after wire.ts drops a wrong-typed field)

**Transitions:**
- unseen -> X on first listing (no event)
- upload 202 -> pending (seeded locally)
- pending|running -> done: emit 'ready'
- pending|running -> anything not busy (including null): emit 'failed'
- done|failed -> pending (recalibrate) -> busy again

**Risks:**
- A recalibration that goes done -> pending -> done between two polls is never seen as busy, so no 'ready' fires and the poll does not start.
- Upload onload seeds 'pending' (data.ts:159) after the fact. If a concurrent poll already recorded 'done', seen regresses and the next listing emits 'ready' for a finish that was already observed or never pending here.
- A malformed status (wire.ts read() drops a wrong-typed field, so null) after busy is reported as 'failed' (logic/scenes.ts:33).
- seen is never pruned on delete.

**Crosses:** The machine is server-owned (server/src/scenes, calibration queue, calib/ worker); this is its client mirror, consumed by UI listeners of scenes.events 'ready'/'failed'.

> Verifier: The contract closes calib_status to pending\|running\|done\|failed (scene-object.schema.json:22), so the 'unknown status like cancelled/queued' risk is theoretical. Restated it as malformed/absent. The upload-seed race can give a spurious extra 'ready', not reliably 'twice'.

### [low] Library API availability (tri-state api: null | true | false)

*confirmed* · `planner/data.ts:236-237`, `planner/data.ts:298-309`, `planner/data.ts:310-314`, `planner/data.ts:386, 394`

**Encoding:** A nullable boolean: null = unknown (also 'probe failed for another reason'), true = present, false = absent or disabled.

**States:** unknown (null) · present (true) · absent (false) · disabled by ?library (false, never probed)

**Transitions:**
- start -> refreshTrash: success -> true; 404/405/501 -> false; network error / other status -> unchanged
- remove/restore -> refreshTrash can move it in any direction

**Risks:**
- A transient error at start leaves api null: start() skips jobs() and spend() (data.ts:313) and nothing retries, so the jobs list and spend stay empty until a remove/restore re-probes (or a user add calls track/spend directly).
- 'unknown' and 'probe failed' share the null value.
- A 404/405/501 from refreshTrash after a remove/restore flips a present API to false mid-session.

**Crosses:** UI reads lib.getState().api (library panel, settings).

> Verifier: All three points are visible at data.ts:298-314. Added that a remove/restore re-probes and an add bypasses api.

### [low] Scene photo upload request lifecycle

*confirmed* · `planner/data.ts:136-165`

**Encoding:** An XHR whose callbacks settle a Promise. No handle is kept, there is no onabort/ontimeout, and there is no cancel API.

**States:** opened · uploading (progress events) · accepted (202 with scene) · refused (non-202 or no scene) · network error · aborted/timed out (unhandled)

**Transitions:**
- send -> uploading
- load 202 -> seed seen 'pending', refresh, resolve
- load other -> reject with a reported error
- error -> reject

**Risks:**
- No onabort/ontimeout: an aborted XHR (for example by the browser) never settles the promise, so the caller's progress state hangs. No timeout is set, so a stalled upload waits indefinitely.
- The user cannot cancel an upload (no handle is returned).
- The 202 path seeds seen 'pending' after a concurrent poll may already have seen the scene (see scene-calib-tracking).

**Crosses:** Callers in ui/scenes.ts show progress; the server queues calibration (server/src/scenes).

> Verifier: Confirmed at data.ts:140-164: only onprogress, onerror and onload are set.

### [low] Lighting mode (default vs photo) and environment-map source with derived SH caches

*corrected* · `planner/lighting.ts:222-224`, `planner/lighting.ts:262-268`, `planner/lighting.ts:277-319`, `planner/lighting.ts:322`, `planner/lighting.ts:359-398`, `planner/lighting.ts:484-500`, `planner/lighting.ts:505-508`, `planner/engine.ts:2754-2758 (drawTo: fitShadow -> syncEnv before every furniture frame)`

**Encoding:** The mode is implied by data !== null. The environment source is whichever of photoEnv/shEnv/roomEnv was last written into scene.environment, written from apply (default) and syncEnv (photo). Cache validity comes from nulling worldSH/turned and clearing photoEnvKey by hand, plus a string key (texture uuid|camVersion|size).

**States:** default (roomEnv, hemi on, probe off, iblDiffuse 1) · photo, env pending (photo not decoded: SH-made env) · photo, photo env baked (photoEnv valid for key) · photo, env stale (key changed, rebake on next syncEnv) · photo, directional SH turned (look.dir away from inferred)

**Transitions:**
- setData(json) -> photo (caches dropped, apply)
- setData(null) -> default (apply sets roomEnv)
- setCamera -> camVersion++, caches dropped, apply
- fitShadow -> syncEnv -> bake photoEnv or fall back to shEnv
- setLook -> apply (turned recomputed when the direction changes)

**Risks:**
- shEnv made while the photo was missing lingers after photoEnv takes over (dropped only in setData/setCamera, lighting.ts:487/496). photoEnv is never disposed when going back to default mode (it is reused as the next bake's target).
- Cache validity depends on every setter remembering to invalidate: worldSH, turned and photoEnvKey are reset by hand in setData and setCamera (setCamera relies on camVersion in the key instead of clearing photoEnvKey). A future setter that changes R, fovY or data without the same block serves stale SH or reflections.
- scene.environment is right in photo mode only because every furniture render goes through fitShadow -> syncEnv first (engine.ts:2756, 2863). apply's photo branch (lighting.ts:366-387) leaves RoomEnvironment in place, so a new render path that skips fitShadow would draw photo-mode furniture with RoomEnvironment reflections.

**Crosses:** Driven by engine.ts (setData from setLightingData engine.ts:2705; setCamera engine.ts:414; setLook engine.ts:415, 2642; fitShadow per frame in drawTo) and by the photo texture swap.

> Verifier: Rejected the 'thumbnails/captures render without fitShadow' risk: every main-scene furniture render goes through drawTo -> fitShadow -> syncEnv (engine.ts:2754-2758), the mask render calls fitShadow too (engine.ts:2863), and thumbnails use their own THREE.Scene with environment = roomEnvironment (engine.ts:832-833). Restated it as a coupling. Dropped 'syncEnv no-ops while worldSH null': apply() fills worldSH immediately in both setters.

### [low] Floor shadow switch, catcher visibility and the mask / diffuse-IBL overrides

*corrected* · `planner/lighting.ts:231-234`, `planner/lighting.ts:258`, `planner/lighting.ts:399-404`, `planner/lighting.ts:427-467`, `planner/lighting.ts:73`, `planner/lighting.ts:477-483`, `planner/engine.ts:845, 2860-2869`

**Encoding:** A shadowsOn boolean that the light's shadow.intensity and autoUpdate must agree with. castShadow is kept true as a three 0.180 workaround, so 'off' means intensity 0 plus autoUpdate false. catcherMesh.visible is decided per frame in fitShadow, plus two uniforms (catcher.mask, the module-global iblDiffuse) that callers flip temporarily.

**States:** shadows off (intensity 0, autoUpdate false, catcher hidden) · shadows on, no pieces (catcher hidden) · shadows on, fitted (catcher visible, map rendered this frame) · mask mode (catcher.mask 1, keep-room render) · thumbnail mode (iblDiffuse forced 1)

**Transitions:**
- setLook/setData/setCamera -> apply -> shadows on|off
- fitShadow(box) -> catcher visible iff shadowsOn && box non-empty; refit cameras, render the catcher map
- maskMode(true/false) around the keep-room mask render (try/finally)
- withDiffuseIbl(fn): iblDiffuse 1 during fn, then restored

**Risks:**
- Correct catcher state depends on the invariant that every main-scene frame with furniture calls fitShadow first (engine.ts:2756, 2863). catcherMesh.visible otherwise keeps the previous fit's value, with stale shadow cameras and shadowRT.
- iblDiffuse is module-global (lighting.ts:73) while everything else is per createLighting instance. Only one instance exists today (engine.ts:355); a second one would share it.

**Crosses:** engine.ts calls fitShadow per frame (drawTo), maskMode in the keep-room render and withDiffuseIbl for thumbnails.

> Verifier: The machine is real but most risks are imaginary today. The ghost-shadow risk needs a frame without fitShadow, and drawTo always calls it for furniture (engine.ts:2756). The withDiffuseIbl restore-overwrite risk is not real: its only caller (engine.ts:845) passes a synchronous render of a separate thumbnail scene that never calls apply(). maskMode has one caller, with try/finally (engine.ts:2860-2869). Kept only the invariant and the module-global uniform as fragilities.

### [low] Look: Auto lighting vs Manual (frozen) lighting, with tri-state cast_shadows

*corrected* · `planner/logic/look.ts:12-23`, `planner/logic/look.ts:63-72`, `planner/logic/look.ts:83-112`, `planner/logic/look.ts:134-141`, `planner/logic/look.ts:164-178`, `planner/engine.ts:2676-2688 (setLighting computes inUse exactly when needsFreeze)`

**Encoding:** The boolean auto_light combined with three nullable numbers whose meaning depends on it (ignored while Auto; a per-field fallback to the scene's value while Manual), plus cast_shadows null meaning 'follow whether lighting.json exists'. Freezing needs inUse passed when needsFreeze holds, a call-order contract.

**States:** Auto (auto_light true; stored direction ignored) · Manual with frozen values · Manual with nulls (per-field fallback to the scene's key) · Auto with stale manual values kept in memory · cast_shadows: explicit on, explicit off, follow lighting (null)

**Transitions:**
- Auto -> Manual on a patch with a direction/softness (no auto_light) or auto_light false: freeze in-use values, then apply the patch
- Manual -> Auto only on auto_light true (stored values kept in memory, dropped on save)
- resetLighting -> defaultLook
- lighting.json arriving (backfill) -> cast_shadows null now resolves to true

**Risks:**
- Turning Auto back on keeps the old manual numbers in memory while lookToSave nulls them (look.ts:134-141), so the in-memory and saved Look differ. A patch that changes only ignored fields while Auto is on makes lookChanged true and triggers a PUT that saves an unchanged Look (benign).
- cast_shadows null turns the floor shadow on by itself when the lighting backfill lands mid-session (resolveLook: ?? hasLighting, look.ts:177), with no user action.

**Crosses:** State held and mutated in engine.ts (look, setLighting/resetLighting/saveLookSoon); the Look panel and the hook's getLighting/setLighting read and write it; lighting.ts consumes the resolved look.

> Verifier: Rejected the 'patchLook called with inUse null while needsFreeze' risk: the only caller, engine.ts:2680-2685, computes inUse exactly when needsFreeze holds. The stale manual values also never resurface: going Manual again re-freezes from the in-use (auto) values. Kept the spurious-save and the backfill-flips-shadow points.

### [low] Selection set with primary piece

*corrected* · `planner/logic/selection.ts:5-37`, `planner/engine.ts:1170-1171 (removal: sel/selected set directly)`, `planner/engine.ts:1231-1245 (setSelection, select)`

**Encoding:** An ordered uid array plus a separately stored primary that must equal the last uid, held in engine.ts alongside a third copy, `selected`, that must equal sel.primary.

**States:** empty (primary null) · single · multi (primary = last picked)

**Transitions:**
- set uid -> single, or empty for an unknown uid
- toggle in/out (Shift+click) -> multi/single/empty
- add -> moves uid to the end as primary
- without(uid) on removal
- selectMany -> exactly the known uids

**Risks:**
- The primary is stored three times (sel.uids' last, sel.primary, engine's `selected`). Two engine paths keep `selected` in step by hand (engine.ts:1171, 1233), and the removal path at engine.ts:1170 bypasses setSelection. The drag-end check in setSelection (engine.ts:1234) then runs separately (engine.ts:1172).
- 'set' clears the selection for an unknown uid while toggle/add ignore it (selection.ts:18-19): the hook's selectItem with a stale uid deselects everything.

**Crosses:** State held in engine.ts (sel, selected); interacts with its drag machine (engine.ts:1234) and input.ts gestures.

> Verifier: No Selection is built outside selection.ts's functions (grep: engine.ts:1170, 1232, 1246 only), so the 'built outside these functions' risk is hypothetical. Restated it as the real duplication with engine's `selected` and the removal path that bypasses setSelection.

### [low] Server status vocabularies read as opaque strings

*corrected* · `planner/wire.ts:91`, `planner/wire.ts:158`, `planner/wire.ts:337`, `planner/wire.ts:374`, `planner/logic/scenes.ts:21-34`, `planner/logic/library.ts:84-94`, `planner/logic/look.ts:297-302`, `contract/api/common.schema.json:10 (jobStatus queued|running|done|failed)`, `contract/api/scene-object.schema.json:22 (calib_status pending|running|done|failed)`

**Encoding:** Each status is `string | null` in the planner's tolerant wire types. The legal values exist only as string literals compared in different pure helpers, while the contract defines closed enums.

**States:** scene calib: pending, running, done, failed · library/align job: queued, running, done, failed · room align_status: pending, running, done, failed, none · lighting: done, missing, pending, running, none, failed

**Transitions:**
- server-owned; the client infers transitions from polled snapshots (see scenes-poll, lib-jobs-poll)

**Risks:**
- wire.ts's tolerant reader drops a wrong-typed status (read(), wire.ts:32-37), so a malformed status becomes absent (null): it reads as not busy, polling stops, and for a scene that was busy, sceneFinished reports 'failed'.
- lightingStatusOf invents 'done'/'missing' when the server gives no status (look.ts:297-302), so a client-made status can disagree with the server.

**Crosses:** Defined by contract/ schemas and server/src (scenes, library jobs, rooms align jobs, lighting backfill); polled by data.ts and by engine.ts / ui/room.ts outside this group.

> Verifier: The contract defines closed enums (common.schema.json jobStatus; scene-object calib_status; room-object alignStatus), so the pending/queued difference is by contract, not a client inconsistency, and 'unknown status' can only come from a malformed answer. Kept the malformed-to-null path and the client-invented lighting status.

## planner-ui

### [high] Workspace remove / Undo (⌘Z) slot

*corrected* · `planner/ui/workspace.ts:78`, `planner/ui/workspace.ts:237-246`, `planner/ui/workspace.ts:592`, `planner/ui/panels/inroom.ts:29-33`, `planner/ui/shell.ts:568-596`, `planner/engine.ts:1392-1402`

**Encoding:** nullable `lastRemoved` {snaps, toast, undo} plus a separate shell toast with its own timer. In the scene's Remove (inroom.ts) keeps its own toast-only Undo and never touches lastRemoved.

**States:** idle (lastRemoved=null) · undoable (lastRemoved set, toast visible) · undoable-stale (lastRemoved set, toast expired/evicted/replaced)

**Transitions:**
- idle -> undoable on removeSelected() (Del key, Remove button)
- undoable -> idle on toast Undo click (undo() nulls it only if snaps match) or ⌘Z (edit.undo)
- undoable -> undoable-stale when the toast's 6 s timer fires, or the toast is evicted (>3, phone one-at-a-time) or replaced; nothing clears lastRemoved
- undoable(A) -> undoable(B) on another removeSelected (A's toast Undo still restores A)

**Risks:**
- lastRemoved is never cleared on toast expiry, scene open/close or room photo switch (grep: only lines 78/241/245/592 touch it). `when: () => !!lastRemoved` stays true, so ⌘Z minutes later in a different scene calls engine.restoreItem(s), which re-adds the old pieces (addItemInternal with the old uid/id) into whatever scene is open now
- Two Undo channels: a piece removed from the In the scene panel (inroom.ts:29-33) is not recorded in lastRemoved, so ⌘Z right after it restores an older workspace removal instead
- Double restore: ⌘Z calls l.toast.close() (non-instant: the element stays 200 ms with .is-leaving, which kit.css:384 does not make pointer-events:none) and then l.undo(); a click on that toast's Undo within those 200 ms runs undo() again and restores the same snapshots twice

**Crosses:** restores into the engine's current scene (engine.restoreItem/restoreItems); toast lifetime is the shell's

> Verifier: States/transitions and risks 1-2 confirmed. Risk 3 as written was wrong: an old toast's Undo and ⌘Z restore different removals (the old toast does not null lastRemoved when snaps differ), so no double restore there. The real double-restore path is the 200 ms leaving window of the toast ⌘Z just closed.

### [high] Height +/− hold-to-repeat timer

*corrected* · `planner/ui/workspace.ts:259-278`, `planner/ui/workspace.ts:303-321`, `planner/ui/workspace.ts:557-560`, `planner/ui/workspace.ts:394`

**Encoding:** per-button closure: timer handle `t`, repeat counter `n`, boolean `pressed`; the nudge target is read at each tick from engine.getSelected() via selUid()

**States:** idle · pressed (first nudge done, waiting 450 ms) · repeating (setTimeout chain, repeatDelayMs/repeatCm)

**Transitions:**
- idle -> pressed on pointerdown (button 0)
- pressed -> repeating after 450 ms
- pressed|repeating -> idle on pointerup / pointerleave / pointercancel on that same element
- click with pressed=false -> one nudge (keyboard); click resets pressed

**Risks:**
- The button can be detached while held: sync() rebuilds selBar when selSig changes (selection, count, missing/noGlb, mode) and on the phone calls lift.replaceChildren() when the bar hides (line 559) or a group bar is built (line 394). A detached button never gets pointerup/leave/cancel, so the setTimeout chain never stops and keeps nudging (growing steps) whichever piece is selected later, because nudge() reads selUid() at each tick
- `pressed` stays true after a pointerdown that ends in pointerleave without a click, so the next keyboard activation is swallowed once

**Crosses:** drives engine.nudgeElevation on the engine's current selection

> Verifier: Dropped the 'no pointer capture' risk: moving off the button fires pointerleave (and touch has implicit capture so pointerup arrives), both of which call stop(). The detached-button runaway timer and the swallowed keyboard click are real.

### [high] Shell panel / phone sheet open-detent-collapsed machine

*confirmed* · `planner/ui/shell.ts:276-350`, `planner/ui/shell.ts:410-416`, `planner/ui/shell.ts:418-452`, `planner/ui/shell.ts:454-471`, `planner/ui/shell.ts:738-743`, `planner/ui/panels/library.ts:60-74`, `planner/ui/panels/library.ts:203-204`, `planner/ui/panels/inroom.ts:38`, `planner/ui/panels/layouts.ts:102`

**Encoding:** `openId` (kept after close), `detent` (phone: null = closed), `collapsed` (desktop, persisted in localStorage), `mode`, the `is-open` class and inline height on #sheet, and an in-flight `drag` record; 'open' is derived as openId && (phone ? detent : !collapsed)

**States:** desktop-open(id) · desktop-collapsed(id|null) · phone-closed (detent=null, openId may still be set) · phone-open(id, peek|half|full) · phone-dragging(id, h)

**Transitions:**
- closed -> open(id) on openPanel/togglePanel/dock/rail (onClose of the previous, onOpen of the new)
- phone-open -> phone-open(other detent) on setDetent / tap / settle
- phone-open -> phone-closed on closePanel or a fling settleDetent()=null
- phone-open -> phone-dragging on pointerdown on grab/head; -> open/closed on pointerup
- phone <-> desktop on resize/coarse change via applyMode+rehost

**Risks:**
- setDetent() (line 411) only checks `openId`, which closePanel never clears: library add() (after its await, line 71) and the job-done toast's Place (line 204 -> add) call shell.setDetent('peek') with the sheet closed, so detent becomes 'peek', root data-sheet/chrome metrics say a peek sheet is up, but #sheet has no `is-open` class, onOpen is not called and the 'panel' event reports open for a hidden sheet
- An in-flight `drag` survives closePanel (Esc, scrim, another module): its pointerup then calls setDetent(tapDetent(null)) or settle, giving the same half-open state
- rehost() on mode change shows/hides the open panel (phone->desktop showInSide; desktop->phone detent=null) without calling onOpen/onClose or emitting 'panel', so modules that react to those (scene panel render on open, library lastAdded, room plan visibility) are not told
- library add() awaits addItemInternal and then setDetent('peek'): if the user opened another panel meanwhile, that panel drops to peek

**Crosses:** workspace.ts (syncStage, adjust closes sheet), room.ts (plan hides while a phone panel is open), every panel's onOpen/isOpen; 'panel' events consumed by workspace, room, library, scene

> Verifier: Checked setDetent's guard (openId only), closePanel not clearing openId, onUp calling setDetent after a close, and rehost skipping hooks/events.

### [medium] Overlay layers and key routing (shell modals, page, sheet.ts singleton, renders modal)

*corrected* · `planner/ui/shell.ts:492-564`, `planner/ui/shell.ts:599-679`, `planner/ui/shell.ts:716-731`, `planner/ui/sheet.ts:29-41`, `planner/ui/sheet.ts:64-85`, `planner/ui/panels/renders.ts:58`, `planner/ui/panels/renders.ts:141-172`, `planner/ui/shortcuts.ts:37-43`, `planner/input.ts:146-153`, `planner/input.ts:175-176`, `planner/ui/workspace.ts:593`

**Encoding:** four independent stores: shell `modals[]` (confirm/menu), shell `pageOpen`+`pageEls`, module-global `current` sheet in sheet.ts, renders.ts's own `modal`. Esc is handled twice: a window capture listener in shell.ts (cancel top modal, else close page) that never stops propagation, then input.ts's bubble listener, which consults `modals.length>0 || pageOpen!==null || keyFilters.some(f)` (filters with side effects: closing on Esc) and otherwise runs the keymap (Esc = deselect / leave Adjust floor / leave ruler)

**States:** nothing open · page open · sheet open (± page) · renders modal open (± sheet, ± page) · shell confirm/menu open over any of the above

**Transitions:**
- openPage / closePage (Esc, scrim, desktop pointerdown on view, swipe > 120 px)
- openSheet (closes the previous sheet) / sheet.close (Esc via key filter, scrim, mode change)
- renders openModal (closes previous renders modal) / close (Esc via key filter, scrim)
- shell.confirm / menu push onto modals; Esc cancels the top one only

**Risks:**
- Esc falls through layers: the shell's capture handler closes the page (or cancels a confirm/menu, which splices it from modals) and does not stop propagation, so by the time input.ts's handler runs pageOpen is null / modals is empty, and the same Esc goes on to the key filters and the keymap. One Esc on the Scenes page closes the page and also deselects the selection or leaves Adjust floor/ruler (input.ts:175-176, workspace.ts:593); one Esc on a confirm or menu over a sheet or the renders modal cancels it and also closes the sheet/modal underneath
- With a sheet (Settings, Rename, New room) open over the Scenes page, Esc (focus not in an input) closes both at once (page in capture, sheet via its filter) rather than only the top one
- keyFilters.some() stops at the first true: if the renders modal and a sheet are both open, Esc closes only the one whose filter registered first (renders registers at mount, sheet.ts on first openSheet)
- Mode change closes sheets (sheet.ts onMode) and rerenders the renders modal, but leaves shell menus and confirm dialogs in their old-mode layout
- The addKeyFilter remover does keyFilters.splice(indexOf(fn),1); called twice it splices index -1 and drops the last filter (no caller removes a filter today: latent)

**Crosses:** engine input (planner/input.ts setKeyFilter + keymap) consults the shell's state for every keydown

> Verifier: The finder's main risk was inverted: with a page and a sheet open the sheet is not orphaned. The shell's capture listener closes the page first, then input.ts's later bubble listener sees pageOpen===null and the sheet filter closes the sheet too. The finder's 'confirm over a sheet is fine' is also wrong for the same reason, since cancel() empties modals before input.ts runs. The general problem is that Esc reaches the keymap after closing a layer.

### [medium] Render in-flight tracking: workspace chip and the Renders panel's pending list

*confirmed* · `planner/ui/workspace.ts:77`, `planner/ui/workspace.ts:139-163`, `planner/ui/panels/renders.ts:24-36`, `planner/ui/panels/renders.ts:55-57`, `planner/ui/panels/renders.ts:133-138`, `planner/ui/panels/renders.ts:258-275`, `planner/ui/panels/renders.ts:404`

**Encoding:** workspace: a single nullable `rendering {t0}` and one setInterval `renderTimer`, driven by engine 'render' events (phase start/done/failed). Renders panel: a `pending[]` of records with a mutable `state: 'rendering'|'failed'`, a `seq` counter for ids and a `tick` interval running while any record is rendering

**States:** idle · rendering (1..n) · failed rows (Not charged · Retry) · done

**Transitions:**
- idle -> rendering on run() (pending.unshift) and on the engine's 'render' start
- rendering -> done: pending filtered out; workspace rendering=null on any non-start phase
- rendering -> failed: p.state='failed', at/error/reason set
- failed -> dismissed (filter) or Retry (openConfirm({retry}))
- any -> cleared on scene opened/closed (pending=[])

**Risks:**
- The workspace chip has a single slot: with two renders running (Render again while one runs, or Retry), the first non-start phase sets rendering=null and clears the timer while the second is still going, so the chip disappears; a second 'start' also resets t0
- Two independent views of the same lifecycle (engine events and the pending list) with no shared id
- Scene change clears pending, but run() still awaits: its success branch filters a list it is no longer in and can still show a not-aligned toast for the old scene; its failure mutates a record no longer in the list, so the failure is never shown

**Crosses:** engine 'render' events and engine.renderViewInternal/postRender (planner/engine.ts)

> Verifier: workspace.ts:145-157 has one slot; renders.ts:258-275 and 404 confirm the scene-change behaviour.

### [medium] Renders modal (confirm / viewer / compare) and Compare picking

*confirmed* · `planner/ui/panels/renders.ts:37-44`, `planner/ui/panels/renders.ts:58-59`, `planner/ui/panels/renders.ts:84-97`, `planner/ui/panels/renders.ts:141-163`, `planner/ui/panels/renders.ts:175-255`, `planner/ui/panels/renders.ts:278-327`, `planner/ui/panels/renders.ts:330-401`, `planner/ui/panels/renders.ts:403-407`

**Encoding:** nullable `modal {kind, els, close, rerender, step}`; `picking: string[]|null`; viewer closure `idx`/`side`; compare closure `mode`/`split`/`shown`/`dragging`; `modal === m` used as a stale check after the async imageShot

**States:** none · confirm (capturing / loading past picture / ready) · viewer(idx, side) · compare(side|split|swipe, A/B) · picking(0|1 names)

**Transitions:**
- none -> confirm on render-request / Render… / Retry / Render again (after an async capture)
- confirm -> none on submit/close
- none -> viewer on row click / open-render
- viewer -> viewer on step (arrows, swipe)
- picking -> compare when two names are picked; viewer -> picking on Compare…
- any -> none on Esc/scrim, or on scene opened/closed

**Risks:**
- The viewer keeps a numeric `idx` into getRenders() (newest first). A 'renders' event while it is open (line 403, e.g. another render finishing) rerenders with the same idx, which now points at the previous neighbour, so the viewer jumps to a different render
- openConfirm awaits captureComposite before openModal with no check that the scene is the same afterwards: the scene event's modal?.close() (line 404) runs before the modal exists, so switching scene during the capture still opens a confirm with the old scene's picture, and submit (current=true -> shot null) renders the new scene
- picking holds names across 'renders' events; a deleted render leaves a stale name and openCompare then reports an error

**Crosses:** engine 'renders', 'scene' and 'compare' events (the hook opens Compare); shell 'render-request' and 'open-render'

> Verifier: Checked renders.ts:185-192, 240, 281-287, 403-404.

### [medium] Floor plan pointer gestures (pan / pinch / photo / handle / item / turn)

*corrected* · `planner/ui/room.ts:35-40`, `planner/ui/room.ts:84-86`, `planner/ui/room.ts:362-472`

**Encoding:** discriminated union `drag` (kind + moved flag) plus a `pointers` Map and a nullable `pinch`; photo/handle commit at pointerup (engine.setPose) after previews (engine.previewPose)

**States:** idle · pan · pinch · photo-drag (previewing pose) · handle-drag (previewing yaw) · item-drag · turn-drag · tap (moved=false) -> place/deselect

**Transitions:**
- idle -> turn|handle|photo|item|pan on pointerdown by hit-test
- any one-finger drag -> pinch when a second pointer lands (drag=null)
- photo|handle (moved) -> idle on pointerup: engine.setPose commits the previewed pose
- pan (not moved) -> placement of an unplaced photo (Align photos) or deselect

**Risks:**
- A second finger during a photo/handle drag sets drag=null (line 377) without committing or reverting: the pose stays previewed via engine.previewPose but setPose is never called, so the shown pose and the saved pose disagree
- A third pointer: pointers.size is 3, so pointerdown starts a new drag from it while `pinch` stays set; pointermove skips the pinch branch (size !== 2) and drives the new drag: a mixed pinch+drag
- Align photos turned off mid photo/handle drag still commits the pose on pointerup (no alignPhotos check in end())

**Crosses:** engine room state (previewPose / setPose / moveItemHook / select); engine.getRoomState().alignPhotos flag

> Verifier: Dropped 'room closed / photo switched: setPose for a scene no longer in this room': end() looks the scene up in the current room's members (line 457) and skips setPose when it is missing. Dropped the item-drag history note, since no defect is visible in this file. Narrowed the Align-off risk to the commit that still happens.

### [medium] Floor plan shown/visible, Align photos selection and photo switching

*confirmed* · `planner/ui/room.ts:79-83`, `planner/ui/room.ts:97-103`, `planner/ui/room.ts:475-501`, `planner/ui/room.ts:530-548`, `planner/ui/room.ts:557-575`, `planner/ui/room.ts:592-606`

**Encoding:** `shown` boolean persisted per mode in localStorage, derived `visible()` (room && shown && no page && not phone-with-panel), mirrored into the engine with setFloorPlanShown. Plus nullable `alignSel`, `fitted`/`viewSize` view cache and a `drawQueued` rAF flag

**States:** no room · room, plan hidden · room, plan visible · Align photos on (alignSel = grabbed | current) · switching photo (confirm pending)

**Transitions:**
- toggle/close/show() flips shown; mode change re-reads the stored value
- page/panel events recompute visible() and push it to the engine
- room 'opened'/'photo' reset alignSel; photo pointerdown sets alignSel
- switchTo(scene): confirm if the scene is dirty, then engine.setRoomPhoto

**Risks:**
- alignSel is reset only on room 'opened'/'photo' or no room, not when Align photos turns off or a member is removed. A stale alignSel naming a removed scene empties the label, disables Reset, and makes a tap on an unplaced current photo place nothing (target = alignSel ?? current)
- switchTo awaits a confirm with no recheck afterwards: if the room or photo changed meanwhile it still calls setRoomPhoto with a scene of the old room
- Align again: againBtn is disabled only from align_status, which arrives later, and alignAgain has no in-flight guard, so a double click sends two engine.alignRoom calls
- sync() writes the engine's floorPlan flag from UI-derived visibility: two sources of truth (local `shown` versus roomState.floorPlan)

**Crosses:** engine roomState.floorPlan / alignPhotos / align_status (server align job polled via the engine); workspace.syncStage

> Verifier: Checked room.ts:465-467, 480-501, 530-537, 563, 594-595.

### [medium] Scenes page uploads, New room pipeline and room-list polling

*corrected* · `planner/ui/scenes.ts:31`, `planner/ui/scenes.ts:35-40`, `planner/ui/scenes.ts:55-58`, `planner/ui/scenes.ts:62-77`, `planner/ui/scenes.ts:141-185`, `planner/ui/scenes.ts:285-291`, `planner/ui/scenes.ts:339-362`

**Encoding:** single nullable `uploading {name, loaded, total}`; nullable `roomMaking {text,n}` holding the step text (upload i/n -> room -> align); `roomSheet`; `roomTitle` draft; ever-growing `roomUploads` Set; `roomsAsked` latch; `pollTimer` setTimeout chain

**States:** idle · confirming (layout dirty) · uploading(progress) · opening the new scene · room: uploading i/n · room: creating · room: aligning · room done (polling while busy) · failed

**Transitions:**
- idle -> uploading on picker/drop -> opening -> idle (page closed, openScene)
- makeRoom: upload each -> createRoomFromScenes -> alignRoom (>=2 photos) -> toast -> listRooms -> schedulePoll
- poll: every 1.5 s while some room is calibrating or aligning and the page is open

**Risks:**
- One `uploading` slot: two uploads at once (a drop during a picker upload) overwrite each other's progress; the first to finish sets it to null while the second still runs (the card vanishes, then the next progress event brings it back named '' from the `?? {name:''}` fallback), and both then call engine.openScene, so the last to finish wins
- makeRoom failing part-way leaves the uploaded scenes outside any room, and the catch shows nothing from this module; roomTitle is kept, so the next room gets it. Two makeRoom runs at once share the single roomMaking slot
- The poll chain stops on its first failed listRoomsInternal (catch -> undefined, no reschedule), so a room still aligning stops updating until the page is reopened or another event re-renders
- upload/open/openRoom await a confirm, then act on state that may have changed meanwhile (another scene opened)

**Crosses:** server calibration queue / align jobs (calib_status, align_status observed via scenes store and engine.getRooms); scenes 'ready'/'failed' events

> Verifier: Dropped the roomsAsked risk: the page's onOpen (line 33) calls refreshRooms() every time it opens, so a server that gains rooms support is asked again. The latch only stops the 'scenes' event path. The other risks are confirmed.

### [low] Export sheet open/run lifecycle

*confirmed* · `planner/ui/export.ts:29`, `planner/ui/export.ts:93-171`

**Encoding:** module-level nullable `sheet`, per-open local `busy` boolean, async capture before opening

**States:** closed · capturing preview (async, no sheet yet) · open-idle · open-busy (export/share running) · closed-while-busy

**Transitions:**
- closed -> capturing on open() (⌘E, Export tool)
- capturing -> open-idle if no sheet appeared meanwhile
- open-idle -> open-busy on Save/Share; -> open-idle on finish
- open-busy -> closed on success (sheet?.close())
- any open -> closed on Esc/scrim/mode change (onClose sets sheet=null)

**Risks:**
- The in-flight run ends with `sheet?.close()` on the module-level variable: start Save, press Esc, open Export again, and when the first export finishes it closes the second sheet
- Closing during busy and reopening gives a new sheet with busy=false while the first export is still encoding: two exports at once
- While capturing, another sheet (e.g. Settings) can open; export's openSheet then closes it silently (sheet.ts current?.close())

**Crosses:** sheet.ts singleton `current`

> Verifier: All three follow from export.ts:105-106,147,152-157 and sheet.ts:33.

### [low] Settings sheet load/save

*confirmed* · `planner/ui/settings.ts:13-62`

**Encoding:** module-level nullable `sheet`; go.disabled as the in-flight guard; settings object `s` replaced after save

**States:** closed · loading settings+spend · open · saving

**Transitions:**
- closed -> loading on open() (⌘, or button)
- loading -> open (if no sheet opened meanwhile)
- open -> saving on Save/Enter; saving -> closed on success, -> open on error

**Risks:**
- Enter in the input calls save() directly (line 28), and save() checks only s.locked and the parse error, not go.disabled, so a double Enter sends two setBudget calls
- A save in flight across Esc and a reopen closes the reopened sheet (`sheet?.close()` on the shared variable, line 50)

**Crosses:** lib.settings/setBudget (server); sheet.ts singleton

> Verifier: Confirmed in settings.ts:28,44-51.

### [low] Floor plan depth lifting cache and async loads

*corrected* · `planner/ui/room.ts:88-95`, `planner/ui/room.ts:163-250`, `planner/ui/room.ts:572`, `planner/ui/room.ts:592-598`

**Encoding:** Maps `lifted` (scene -> {sig, points}), `sceneInfo`, `counts`; Set `loading` keyed `scene|sig`; nullable `grid`, `density` canvas and `densityKey` string; no generation counter

**States:** unloaded · loading(scene,sig) · lifted(scene,sig) · binned(counts key) · failed (no record)

**Transitions:**
- unloaded -> loading in ensureLifted during paint
- loading -> lifted on success (then draw)
- loading -> unloaded on error (finally removes the loading key)
- room 'opened' -> clears lifted/sceneInfo/counts/grid/density (but not `loading`)

**Risks:**
- A failed scene fetch or depth decode records nothing (catch only logs, line 196), so every later paint (items, selection, camera events, resize) fetches /api/scenes/<name> and the depth map again: a retry with no backoff while the plan is visible
- sceneInfo is cached for the whole room session (cleared only on 'opened'), so a scene recalibrated meanwhile keeps its old calib/depth_url
- Stale async results: a lift started before a room 'opened' finishes afterwards and writes into the cleared caches (no generation check; `loading` is not cleared). Keys are scene+sig, so this only leaks entries or repopulates the same scene's data: low impact

**Crosses:** engine.loadDepthMap / depthScaleFor; server GET /api/scenes/:name

> Verifier: Lowered the severity. The stale-result write is real, but lifted is keyed by scene and checked by sig, so it cannot show another room's points as this room's. The retry-without-backoff and the stale sceneInfo are the real issues.

### [low] Layouts card: save / Save as new form / failure-retry

*confirmed* · `planner/ui/panels/layouts.ts:21-24`, `planner/ui/panels/layouts.ts:38-77`, `planner/ui/panels/layouts.ts:98-154`, `planner/ui/panels/layouts.ts:200`

**Encoding:** booleans `asking`, `busy`; string `draft`; nullable `failure {message, offline, retry}`; view precedence failure > asking > buttons

**States:** idle · asking (form open, draft) · saving (busy) · failed (Retry/Cancel) · failed+asking (form hidden under failure)

**Transitions:**
- idle -> asking on Save layout… / Save as new… / load() 'save' without a current layout
- asking|idle -> saving on save()
- saving -> idle on success (asking=false, draft='')
- saving -> failed on error (asking unchanged)
- failed -> saving on Retry; failed -> asking|idle on Cancel
- any -> idle on scene opened/closed/title (busy not reset)

**Risks:**
- A save in flight across a scene change: the scene event resets failure/asking, then the old save finishes and toasts 'Layout saved as X' (or sets failure with a Retry bound to the old name) in the new scene
- load() 'Save, then load' calls save(), which returns false when busy, so the load is silently dropped
- load() choosing 'save' with no current layout opens the form and returns: the requested layout is never loaded
- failure and asking can both be true; Cancel on the failure brings back the old form with its old draft

**Crosses:** engine.saveLayoutInternal / loadLayoutInternal / 'layouts','dirty' events

> Verifier: Checked layouts.ts:38-56, 70-73, 117-125, 200.

### [low] Scene panel saving/calibrating flags

*corrected* · `planner/ui/panels/scene.ts:60-61`, `planner/ui/panels/scene.ts:104-116`, `planner/ui/panels/scene.ts:134-135`, `planner/ui/panels/scene.ts:183-186`

**Encoding:** module booleans `saving` and `calibrating`, not tied to a scene name

**States:** idle · saving · calibrating · saving+calibrating

**Transitions:**
- idle -> saving on Save scene; -> idle in finally
- idle -> calibrating on Calibrate again; -> idle in finally

**Risks:**
- calibrating is not scoped to the scene: open another scene while a recalibration runs and the new scene shows 'Calibrating…' with the button disabled, and the old scene's 'done' toast then shows over the new one

**Crosses:** engine.recalibrate (server calibration job) and engine.saveScene

> Verifier: Dropped the save() re-entry risk: save() itself calls renderLook() (line 106), which sets saveB.disabled=saving whether or not the panel is open (renderLook returns early only with no scene).

### [low] Workspace overlay drags: horizon handle, ruler handles, phone lift grip, rotate grip

*corrected* · `planner/ui/workspace.ts:303-311`, `planner/ui/workspace.ts:598-609`, `planner/ui/workspace.ts:612-633`, `planner/ui/workspace.ts:636-648`

**Encoding:** nullable records `hz {id,y0,py0}`, `rDrag {i,touch}`, lift `d {id,y0,cm0}`; the rotate grip relies on the engine's own getDrag().mode

**States:** idle · horizon-drag · ruler-point-drag · lift-drag · rotate-drag (engine)

**Transitions:**
- idle -> horizon-drag on pointerdown when Adjust floor is on; -> idle on up/cancel
- idle -> ruler-point-drag when the ruler is active; -> idle on up/cancel
- idle -> lift-drag on the phone grip; -> idle on up/cancel
- rotate: engine.beginRotateDrag / dragTo / endItemDrag

**Risks:**
- The horizon drag checks Adjust floor only on pointerdown: if Adjust floor is left mid-drag (Esc runs adjust.leave while the mouse is held), the still-captured handle's pointermove keeps calling engine.setPitchFromHorizon, so the pitch changes outside Adjust floor
- Ruler point drag likewise checks ruler.active only on pointerdown; switching the ruler off (Esc ruler.leave) mid-drag keeps calling setRulerPointAt

**Crosses:** engine camera/ruler/drag state (engine.getDrag, setPitchFromHorizon, setRulerPointAt)

> Verifier: Dropped the lift-grip risk: buildLift/buildGroupBar/sync replace the lift's children, which detaches the old grip; a detached element gets no more pointermove, so a stale `d` cannot drive the newly selected piece. The horizon and ruler risks depend on the handle staying connected while hidden, which it does, so they are plausible.

### [low] Sun dial pointer gesture and rAF-coalesced emit

*corrected* · `planner/ui/sun-dial.ts:68-74`, `planner/ui/sun-dial.ts:94-159`, `planner/ui/sun-dial.ts:162-169`, `planner/ui/panels/scene.ts:22-48`

**Encoding:** `dragId` (number|null), `touch` (pending touch intent), `pending` value and `raf` handle; set() ignores engine values while dragId or pending is set. touchSlide in scene.ts: `t {on}` with wait/drag/scroll intent

**States:** idle · touch-undecided (wait) · dragging · emit-pending (rAF queued) · scroll (abandoned)

**Transitions:**
- idle -> dragging on mouse/pen pointerdown or a touch on the sun grip
- idle -> touch-undecided on a touch elsewhere; -> dragging (sideways) | idle (vertical scroll) | tap-move on pointerup
- dragging -> idle on up/cancel/lostpointercapture (flush)
- keyboard -> emit-pending

**Risks:**
- A second pointer starting a drag overwrites dragId without ending the first; the first pointer's moves and up are then ignored
- While `pending` is set, set() from a 'look' event is dropped; a reset arriving in the same frame as a key press is overwritten by the pending value at flush

**Crosses:** engine.setLighting via the scene panel; 'look' events feed set()

> Verifier: Dropped 'dial removed from the DOM mid-drag': the scene panel builds the dial once and never removes it (scene.ts:71-99, renderLook only sets values).

### [low] Product page read (Add furniture › Product page)

*confirmed* · `planner/ui/panels/productsrc.ts:107-127`, `planner/ui/panels/productsrc.ts:155-192`, `planner/ui/panels/productsrc.ts:244-289`, `planner/ui/panels/productsrc.ts:314-364`, `planner/ui/logic/product.ts:205-213`

**Encoding:** ReadState {busy, data, readUrl, size, picture, failed Set, error, seq, active} plus the `last` prefill map, `lastRug`/`engineBefore`, the `drawn` render cache; productProblem() derives the gating state

**States:** empty · invalid link (local error) · reading · read ok · read failed (blocked -> paste open) · all pictures failed · url edited since the read

**Transitions:**
- empty|ok|failed -> reading on Read/Enter/paste
- reading -> ok (prefill) | failed (clearPrefill)
- ok -> all-pictures-failed as image errors arrive
- ok -> url edited (problem: 'Read this link first')

**Risks:**
- A paste while a read runs: takePasted clears the box and sets the placeholder to 'reading it…', but read() returns at `if (st.busy) return` (line 245) before the try/finally that resets the placeholder, so the pasted page is lost and the placeholder stays 'reading it…'
- `seq` is incremented only in read() and reads are serialized by busy, so the `seq !== st.seq` checks never fire: a stale-result guard that guards nothing
- copyBookmarklet's 2.5 s reset timer is not cancelled on a second click (the label flips back early)

**Crosses:** lib.readProduct -> POST /api/library/product

> Verifier: grep shows st.seq is changed only at line 257. The busy early-return precedes the finally.

### [low] Library Add/Edit sheet submit lifecycle

*confirmed* · `planner/ui/panels/libsheets.ts:42-56`, `planner/ui/panels/libsheets.ts:110`, `planner/ui/panels/libsheets.ts:175-198`, `planner/ui/panels/libsheets.ts:228`, `planner/ui/panels/libsheets.ts:242-257`

**Encoding:** AddState {source, file, model, engine, resolution, busy, error} / edit {turn, render, busy, error}; object URL `preview`; a lib 'spend' listener added per Add sheet

**States:** editing · submitting (busy) · error · closed

**Transitions:**
- editing -> submitting on Make/Save
- submitting -> closed (onAdded / toast) | error
- any -> closed on Esc/scrim/mode change

**Risks:**
- Closing the sheet while it submits: on failure st.error is set on a removed sheet, so the error is never seen there; on success onAdded still fires
- Closing during submit and reopening allows a second paid add for the same piece (busy is per sheet)
- The lib.events 'spend' listener (onSpend) is never removed: the Add sheet's onClose only revokes the preview URL (line 110), so one listener leaks per Add sheet opened

**Crosses:** lib.addFromUrl/addFromFile/edit start server library jobs (watched in the Library panel)

> Verifier: No removeEventListener in libsheets.ts. The onClose at line 110 handles only the preview.

### [low] Library panel job list (dismissed/ready sets) and lastAdded

*corrected* · `planner/ui/panels/library.ts:27-30`, `planner/ui/panels/library.ts:60-78`, `planner/ui/panels/library.ts:129-149`, `planner/ui/panels/library.ts:193-215`, `planner/ui/logic/library.ts:78-85`

**Encoding:** Sets `dismissed` and `ready` of job ids (never pruned), nullable `lastAdded`, `slow` placing-toast timer; jobKind maps open-ended status strings, defaulting to 'queued'

**States:** queued · running · ready (finished on this page) · failed · dismissed

**Transitions:**
- job-done -> ready.add
- Place -> ready.delete + add()
- Dismiss -> dismissed.add
- selection cleared -> lastAdded=null

**Risks:**
- dismissed/ready grow for the page's lifetime
- add()'s Undo toast calls removeItemInternal(uid) even after a scene change (a no-op at best)

**Crosses:** server library job queue status, observed via lib 'jobs'/'job-done'/'job-failed' events

> Verifier: Dropped the jobKind risk: shownJobs (logic/library.ts:78-80) only lists jobs whose status is queued/running/failed or that are in `ready`, so a job with an unknown status such as 'cancelled' is not shown, let alone shown as waiting forever.

### [low] Toast queue lifecycle

*confirmed* · `planner/ui/shell.ts:198-204`, `planner/ui/shell.ts:567-596`

**Encoding:** array `toasts` with key replacement, per-toast timer, a 200 ms 'is-leaving' removal timeout, max 3, phone one-at-a-time rule

**States:** shown · leaving (200 ms, still clickable) · removed · evicted/replaced

**Transitions:**
- shown -> leaving on timer/Dismiss/action
- shown -> removed instantly on same-key replacement, overflow (>3), or the phone's newer-toast rule

**Risks:**
- Handles stay usable after eviction (close/update act on a detached element), and modules that key behaviour off a toast (workspace Undo) are not told it went
- A same-key toast replaces one whose action closure belongs to different data (e.g. 'removed:<uid>' from the workspace and from In the scene) without telling its owner
- A leaving toast's action button stays clickable for 200 ms, so its action can run after close()

> Verifier: Added the clickable leaving window (kit.css:384 sets no pointer-events).

### [low] Desktop tooltip hover machine

*corrected* · `planner/ui/shell.ts:682-713`

**Encoding:** nullable `tipEl`, `tipTimer`, `tipFor` and a global `dragging` boolean set by capture-phase pointerdown/up

**States:** none · armed (450 ms timer) · shown · suppressed (button down)

**Transitions:**
- none -> armed on pointerover a [data-tip]
- armed -> shown if still hovered and not dragging
- shown -> none on pointerdown, element move or detach

**Risks:**
- The timer callback does not recheck mode, so switching to phone within 450 ms of hovering can still show a desktop tip

> Verifier: Dropped the stuck `dragging` risk: a mouse press that starts in the page keeps delivering pointerup to the document (implicit capture) even if released outside the window. The code also does not depend on it in a way that shows.

### [low] Adjust floor card: Looks right / Set scale async actions and the ruler row

*found by verifier* · `planner/ui/workspace.ts:400-496`, `planner/ui/workspace.ts:562-567`, `planner/ui/workspace.ts:593`

**Encoding:** engine flags getAdjustFloor()/getRuler() {active, points, meters} read into a card rebuilt when `adjustCard.dataset.mode` (mode|room) changes; derived rows (rulerHint vs trueBox by points/meters); un-guarded async looksRight()/roomScale(); `inRoom` captured at build time

**States:** adjust off · adjust on (ruler off) · ruler on, 0-1 points (hint) · ruler measured (Set scale box) · saving (Looks right in flight) · room scaling (Set scale in a room in flight)

**Transitions:**
- off -> on via tool/Scene panel/setAdjust(true)
- on -> off via close, Esc (adjust.leave, priority under ruler.leave), or Looks right after saveScene resolves
- ruler off -> on -> measured as points are tapped; Esc leaves the ruler first
- measured -> scaling on Set scale/Enter (room: engine.setRoomScale; scene: setRulerTrueLength)

**Risks:**
- looksRight() has no in-flight guard and no recheck: a double click sends two saveScene calls, and when the save resolves it calls engine.setAdjustFloor(false) and toasts 'floor saved' even if the user has meanwhile left Adjust floor or opened another scene
- roomScale() (Set scale in a room) has no busy guard, so Enter plus a click, or a double click, sends setRoomScale twice; each scales the whole room by the measured ratio

**Crosses:** engine.saveScene / setAdjustFloor / setRoomScale (server scene and room writes)

### [low] Scenes page card actions: open / rename / add photo / delete with confirms and sheets

*found by verifier* · `planner/ui/scenes.ts:79-113`, `planner/ui/scenes.ts:191-246`

**Encoding:** no state value: each action is an async closure that awaits a shell.confirm or a sheet and then acts; rename sheets use the sheet.ts singleton with no busy flag

**States:** idle · confirming (dirty layout / delete) · rename sheet open · saving rename · acting (openScene/openRoom/deleteRoom/addSceneToRoom)

**Transitions:**
- idle -> confirming on Open/Delete when the layout is dirty or for delete; -> acting on OK
- idle -> rename sheet open; -> saving on Save/Enter; -> closed on success
- Add a photo: sheet -> close -> addSceneToRoom

**Risks:**
- Rename scene/room: save() has no busy guard, so Enter plus Save, or a double Enter, sends two renames
- open()/openRoom() check `s.name === engine.getSceneName()` before awaiting the confirm and act after it with no recheck, so a scene opened meanwhile (e.g. from a 'ready' toast) is replaced

**Crosses:** scenes.rename / engine.renameRoom / openScene / openRoom (server)

## planner-gpu

### [high] SplatLayer CPU (worker) sort request lifecycle

*corrected* · `planner/gpu/splat-layer.ts:187 (version)`, `planner/gpu/splat-layer.ts:197-200 (sortId, pending, sortedKey, wantKey)`, `planner/gpu/splat-layer.ts:281-287 (rebuild: instanceCount 0 in cpu mode, sortedKey '', post 'set')`, `planner/gpu/splat-layer.ts:359-367 (ensureWorker; onerror only logs)`, `planner/gpu/splat-layer.ts:369-391 (onWorker)`, `planner/gpu/splat-layer.ts:396-402 (requestCpuSort: 'if (this.pending) return')`, `planner/gpu/splat-layer.ts:452-469 (update)`, `planner/gpu/splat-layer.ts:527-533 (dispose)`, `planner/engine.passes.ts:205-213 (layer.render only when the engine's splat key changed)`, `planner/engine.ts:895 (onChange bumps splatEpoch and wakes the loop)`

**Encoding:** Nullable `pending` {id,key,resolve[]} = a sort in flight; monotonically increasing `sortId` matches replies; `version` (bumped per rebuild) tags the set; string keys `sortedKey` vs `wantKey` encode fresh/stale; geometry.instanceCount 0 = nothing drawable for this set yet; `worker` nullable for not-started/started.

**States:** no-worker (worker null) · idle-fresh (pending null, sortedKey === wantKey) · idle-stale (pending null, sortedKey !== wantKey; waits for the next update()) · in-flight (pending set) · in-flight-and-superseded (pending set, wantKey moved on or version bumped) · set-changed/blank (after rebuild: sortedKey '', instanceCount 0 until a sort for the new version lands) · stuck (pending set forever: worker threw or failed to load) · disposed (worker terminated, pending untouched)

**Transitions:**
- no-worker -> idle-stale on first rebuild in cpu mode with textures allocated (ensureWorker + 'set')
- idle-stale -> in-flight on update() when key !== sortedKey (requestCpuSort)
- in-flight -> idle-fresh on 'sorted' reply with matching id and version (order copied, sortedKey = p.key, flushWaiters, onChange)
- in-flight -> in-flight on 'sorted' reply when wantKey moved meanwhile (re-request with lastRows/lastRange)
- in-flight -> in-flight on a reply whose version !== this.version (dropped; re-requested if wantKey !== sortedKey)
- in-flight -> idle-stale on 'error' reply (pending cleared, no retry, no onChange)
- any -> set-changed/blank on add()/remove() (rebuild)
- in-flight -> stuck when the worker throws in its handler or fails to load (onerror only warns)
- any -> disposed on dispose()

**Risks:**
- Deadlock: worker.onerror (splat-layer.ts:364) only logs and never clears `pending`; sort.worker.ts:16-31 has no try/catch, so an exception in sortSplats/the Uint32Array allocation or a failed module load leaves `pending` non-null forever, and requestCpuSort's guard (397) blocks every later sort: splats freeze on the last order (or stay invisible after a set change, since rebuild zeroed instanceCount) and every settle() rejects after 30 s.
- After an 'error' reply (373) nothing calls onChange or re-requests; the engine only calls layer.render/update when its own splatKey changes (engine.passes.ts:205, engine.ts:541), so the layer stays stale until the camera or a piece moves. (The 'error' reply is near-unreachable today, see sort-worker-set.)
- Set change blanks every splat item on the WebGL2 path: rebuild sets geometry.instanceCount = 0 in cpu mode (281), so each add/remove makes all splat items vanish until the worker answers; contradicts the header comment (line 26) 'the previous order draws until the new one lands', which holds only for camera/transform changes.
- add() of an existing uid calls remove() then rebuilds twice (234 -> 246, then 238): two version bumps and two full 'set' posts per replace; the first is dead work and its in-flight sort is dropped.
- The version-mismatch branch (374-377) re-requests with the old wantKey, whose prefix is the old version; that sort runs on the new set but lands with sortedKey = a stale key, so a second sort always follows once update() runs with the fresh key.
- `pending.resolve` is always [] (399) and nothing pushes to it: a dead half-mechanism; the real waiters are settleWaiters.
- dispose() terminates the worker but leaves `pending` set (latent: the engine never disposes the layer).

**Crosses:** Driven by planner/engine.ts and planner/engine.passes.ts (drawFrame calls layer.render only when the engine's splat key changes; onChange bumps splatEpoch and wakes the loop); protocol shared with planner/gpu/sort.worker.ts via sort-messages.ts.

> Verifier: All core claims verified in code. Sharpened the error-branch risk: it matters because the engine redraws on demand via a splat key (engine.passes.ts:205), not every frame. Added the stale-key relabel on version-mismatch re-requests. Dispose risk is latent: grep finds no splatLayer.dispose() in engine.ts.

### [medium] SplatLayer settle() waiters (capture waits for the order)

*corrected* · `planner/gpu/splat-layer.ts:201 (settleWaiters)`, `planner/gpu/splat-layer.ts:404-408 (flushWaiters: exact key match)`, `planner/gpu/splat-layer.ts:463-465 (GPU path flush)`, `planner/gpu/splat-layer.ts:387 (CPU path flush)`, `planner/gpu/splat-layer.ts:472-479 (settle)`, `planner/engine.ts:928-931, 2770-2773, 2985 (settleSplats inside holding(); the loop draws nothing while holdFrames > 0)`

**Encoding:** Array of {key, resolve} waiters plus a setTimeout per waiter; satisfied only when sortedKey === waiter.key exactly.

**States:** no waiters · waiting (key queued, timer armed) · resolved (key sorted, timer cleared, removed) · timed out (promise rejected, entry still in the array)

**Transitions:**
- none -> waiting on settle() when count > 0 and sortedKey !== wantKey after update()
- waiting -> resolved when a sort lands whose key equals the waiter's key
- waiting -> timed out after timeoutMs (30 s default)
- waiting -> unreachable if another update() changes wantKey before that exact key is sorted

**Risks:**
- Stale-key starvation is possible but mitigated in the planner: only update() (from render()/settle()) moves wantKey, and the engine's captures run inside holding() so the view loop draws nothing meanwhile (engine.ts:2770, 2985). A caller that renders with another camera or moves a piece and renders while awaiting settle() would starve the waiter (requestCpuSort re-requests only the latest wantKey) and get 'the splats were still sorting' after 30 s.
- Timed-out waiters are never removed from settleWaiters (476-477): dead entries accumulate; flushWaiters may later call their resolve (harmless no-op on a settled promise).
- Combined with the cpu-sort-request deadlock, every settle() times out at 30 s instead of failing fast.
- dispose() neither rejects nor clears waiters (latent; layer never disposed by the engine).

**Crosses:** Awaited by the capture path in planner/engine.ts (settleSplats in captureCanvas via withFullFrame) and by demo.ts capture/addItem/timeSplatDraw.

> Verifier: Mechanics confirmed, but the headline starvation risk is guarded in the engine by holdFrames (engine.ts:2985 'if (holdFrames) return'), so downgraded high -> medium. Dropped the GPU 'resolves at submit' point as a risk: it is correct because the queue orders the draw after the compute.

### [medium] sort.worker.ts set/version state

*corrected* · `planner/gpu/sort.worker.ts:10-11 (set, scratch)`, `planner/gpu/sort.worker.ts:16-31 (message handler)`, `planner/gpu/sort-messages.ts:2-7`

**Encoding:** Module-level nullable `set` tagged with a version; scratch buffer that only grows; message type string discriminates.

**States:** no set (null) · have set v · sorting (synchronous inside the handler)

**Transitions:**
- any -> have set v on 'set'
- have set v -> reply 'sorted' on 'sort' with version v
- no set / other version -> reply 'error' on 'sort'

**Risks:**
- No try/catch around the allocation and sortSplats: an exception produces no reply with the request id, which leaves SplatLayer.pending stuck forever (see cpu-sort-request).
- The scratch buffer never shrinks after a large set (memory only).

**Crosses:** The other half of SplatLayer's CPU sort protocol (planner/gpu/splat-layer.ts).

> Verifier: Dropped 'version mismatch answered with error, layer does not retry' as a live risk: the layer posts 'set' for version v (rebuild, 286) before any 'sort' tagged v on the same ordered channel, and a sort tagged v-1 is processed before set v arrives, so the worker's version check essentially never fails; the 'error' path is near-dead code.

### [low] Sort key cache (when to re-sort) across GPU and CPU modes

*corrected* · `planner/gpu/splat-layer.ts:412-449 (prepare builds the key, writes item rows, uniforms and depth range)`, `planner/gpu/splat-layer.ts:452-469 (update)`, `planner/gpu/splat-layer.ts:282 (rebuild invalidates sortedKey)`, `planner/gpu/splat-layer.ts:393-394 (lastRows, lastRange)`

**Encoding:** Cache validity is a joined string of version + 16 view floats + 16 floats per item at toFixed(6); side effects (uniforms, item texture, lastRows, lastRange) happen in prepare() even when the key is unchanged.

**States:** invalid (sortedKey '') · valid for key K · stale (wantKey !== sortedKey)

**Transitions:**
- invalid -> valid on GPU submit or CPU reply
- valid -> stale on view/item transform change or set change
- stale -> valid on the next update() (GPU) or reply (CPU)

**Risks:**
- camera.near is not in the key, though both sorts cull by it (key kernel 'd > uNear', sort-cpu 'd > near'): a near change alone updates uNear but does not re-sort, so the cull set lags until something else moves. The engine's splatKey includes the projection matrix, so render() is called, but the layer's own key ignores it.
- The key string is rebuilt every update (O(16 x items) toFixed allocations) even when nothing moved.

**Crosses:** engine.ts splatKey/engine.passes.ts p.splat.drawn is a second, independent cache in front of this one (demo passes key: () => String(++tick)).

> Verifier: Dropped: 'large translation loses relative precision' (toFixed(6) is absolute 1e-6, not relative); 'reused slot shows stale rows' (prepare writes every live item's row before any sort). Depth range dmin/dmax derive from view+transforms already in the key, so only near is truly missing. Severity medium -> low.

### [low] SplatLayer GPU resource lifecycle (capacity / allocate / disposeGpu / dispose)

*corrected* · `planner/gpu/splat-layer.ts:185-193 (capacity, tex, mesh, geometry, order, sorter, keyKernel)`, `planner/gpu/splat-layer.ts:213, 225, 235, 245 (slotFree stack)`, `planner/gpu/splat-layer.ts:251-258 (rebuild grows capacity, returns early when tex null)`, `planner/gpu/splat-layer.ts:291-318 (allocate)`, `planner/gpu/splat-layer.ts:518-525 (disposeGpu)`, `planner/gpu/splat-layer.ts:527-533 (dispose)`, `planner/gpu/radix-sort.ts:149-151 (GpuRadixSort.dispose)`

**Encoding:** Six nullable fields set and cleared together plus a `capacity` number; slots on a free-list; no disposed flag.

**States:** empty (capacity 0, all null) · allocated (capacity >= count) · reallocating (disposeGpu then allocate inside rebuild) · disposed (all null, capacity unchanged, target disposed)

**Transitions:**
- empty -> allocated on first add() with splats
- allocated -> allocated(larger) when count > capacity (never shrinks)
- allocated -> disposed on dispose()
- disposed -> silently dead on add() when n <= old capacity (no allocate; tex null makes rebuild/update/prepare return early)

**Risks:**
- Use after dispose: dispose() clears resources but not `capacity`, and items.clear() does not return slots to slotFree; a later add() leaves tex null so nothing is drawn or sorted, with no error (latent: the engine never disposes the layer).
- render() after dispose() uses the disposed target with no guard (latent, same reason).
- Capacity only grows: removing every item keeps the large textures and sorter alive.
- GpuRadixSort.dispose disposes only the compute nodes; the keys/vals/hist StorageBufferAttributes are not part of any disposed geometry, so each capacity growth may leave the old GPU buffers to three's GC (plausible; depends on three's attribute tracking).

**Crosses:** Created by planner/engine.ts (splats(), never disposed); target texture consumed by planner/engine.passes.ts setSplatSource.

> Verifier: Rejected the MAX_ITEMS replace risk: add() of an existing uid calls remove() first, which pushes its slot back (245), so the following pop (235) cannot fail on a replace. Dispose risks are real in code but latent (no dispose call in engine.ts), so medium -> low.

### [low] Renderer pre-init / post-init phase and backend assumptions

*corrected* · `planner/gpu/passes.ts:41 (isWebGPU via Reflect on backend.isWebGPUBackend)`, `planner/gpu/passes.ts:43-46 (render: Promise only before init, dropped)`, `planner/gpu/passes.ts:381-393 (clearTarget pokes backend.state setColorMask / bindFramebuffer)`, `planner/gpu/splat-layer.ts:217-219 (backend picked at construction)`, `planner/gpu/splat-layer.ts:461 (compute Promise dropped)`, `planner/engine.ts:347 (await renderer.init())`, `planner/gpu/demo/demo.ts:47`

**Encoding:** three.js's own initialized flag and backend type, read through Reflect on private fields; callers are assumed to have awaited init(), and returned Promises are discarded with void.

**States:** constructed (not init) · initialized WebGPU · initialized WebGL2 fallback

**Transitions:**
- constructed -> initialized on await renderer.init() (the backend is chosen here)

**Risks:**
- clearTarget mutates three's private WebGL2 state (colour mask, default framebuffer binding) through Reflect with silent typeof guards; a three.js upgrade that renames those fields silently disables the workaround and brings back the stale-furniture and black-view bugs described at 372-380.
- isWebGPU reads a private field; if renamed, it returns false on WebGPU and SplatLayer silently picks the CPU worker sort.

**Crosses:** The renderer is created and init()'d by planner/engine.ts (and demo.ts); the WebGPU/WebGL2 choice (?webgpu=0) is made there.

> Verifier: Dropped 'SplatLayer constructed before init()': both callers await init first (engine.ts:347 top-level await before splats() can run; demo.ts:47 before ensureSplats). Kept the private-field fragility, which is real.

### [low] GpuRadixSort pass ping-pong and in-place histogram phase

*confirmed* · `planner/gpu/radix-sort.ts:55-58 (kIn/kOut by p % 2)`, `planner/gpu/radix-sort.ts:75-98 (scan rewrites hist counts into offsets in place)`, `planner/gpu/radix-sort.ts:143-147 (output = vals[passes % 2])`, `planner/gpu/splat-layer.ts:302, 461, 508-516`

**Encoding:** Which buffer holds the data is implied by pass parity; `hist` holds counts after the hist dispatch and offsets after scan.

**States:** keys[0]/vals[0] filled by the key kernel · after pass p (data in buffer (p+1)%2) · hist = counts · hist = offsets

**Transitions:**
- key kernel -> (hist -> scan -> scatter) x passes, in one compute submission

**Risks:**
- Ordering invariant only: correct as long as the key kernel always runs right before the full kernel list (true at 461 and 513). After a sort with even pass counts keys[0] holds sorted keys, not per-index keys, so any reader of keys[0] must rerun the key kernel first (debugReadSort does, 511). No current bug.

> Verifier: Accurate as an implicit phase machine; the risk is an invariant that current callers respect, not a live bug.

### [low] WebGPU demo page: ready promise, lazy splat layer, async item add/remove

*corrected* · `planner/gpu/demo/demo.ts:42-47 (api.ready with started/failed handles)`, `planner/gpu/demo/demo.ts:55-64 (splats, items, cam, occlusion, hasDepth, hasLighting, look, tick)`, `planner/gpu/demo/demo.ts:113-137 (openScene)`, `planner/gpu/demo/demo.ts:139-146 (ensureSplats)`, `planner/gpu/demo/demo.ts:156-205 (addItem / removeItem)`, `planner/gpu/demo/demo.ts:333 (started)`

**Encoding:** Deferred-promise handles assigned in a closure; module-level booleans and nullable layer; items Map filled after several awaits.

**States:** booting · ready · failed · scene loading · item loading (between awaits and items.set) · item placed

**Transitions:**
- booting -> ready at module end (started, 333)
- booting -> failed only if renderer.init or loadKernels reject (47)
- item loading -> item placed after the awaits (188-189)

**Risks:**
- An exception after line 47 (createPasses, createLighting, scene setup at 49-52) rejects the module but never calls failed(), so api.ready never settles and check.mjs waits to its timeout.
- Concurrent addItem calls with the same uid: items.set (188) overwrites without removing the first group from the scene (orphaned, still drawn); removeItem during an addItem's awaits is a no-op and the add then completes.
- Concurrent openScene calls interleave photo, depth and camera from two scenes (no generation check).

**Crosses:** Driven by planner/gpu/demo/check.mjs and gltrace.mjs through window.gpuDemo; reuses engine.passes.ts and lighting.ts.

> Verifier: Confirmed the first two risks. Dropped 'never clears the previous depth texture' as a visible bug: hasDepth=false hides the depth mesh in draw() (216), so the stale texture is not used.

### [low] PLY header parser element/property state

*found by verifier* · `planner/gpu/splat-data.ts:121-134 (count, offsets, stride, inVertex)`, `planner/gpu/splat-data.ts:140-141 (DataView at headEnd)`

**Encoding:** A boolean `inVertex` toggled by 'element' lines decides whether 'property' lines add to the vertex stride; the body offset is assumed to be headEnd.

**States:** before any element · in vertex element · in another element

**Transitions:**
- any -> in vertex on 'element vertex N'
- any -> in other on 'element <other>'
- property line: adds to stride only while in vertex

**Risks:**
- Properties and data of an element declared before 'vertex' are skipped in the stride but the DataView still starts at headEnd (140), so a PLY with any element before vertex is decoded from the wrong bytes without an error.
- count = Number(p[2]) is not validated: a malformed count gives NaN, the length check (139) is false for NaN, and the decode yields count NaN into SplatData.

**Crosses:** Decoded SplatData feeds SplatLayer.add via planner/engine.ts loadSplatFile and demo.ts addItem.

**Rejected by the verifier:**
- `photo-depth-pass-inputs`: Each pair is written atomically by one setter (156, 186), so no illegal combination is reachable; disposal is done by the caller (engine.ts:1623-1624, 1637-1638). That is a trivial value holder, not a state machine with a real risk.

## server-infra

### [high] In-memory job queue and job records (SerialQueue + JobStore)

*corrected* · `server/src/jobs.ts:13-53 (JobStore #jobs/#order, update, position)`, `server/src/jobs.ts:56-115 (SerialQueue #waiting, #busy, #idle, #settle, #loop)`, `server/src/jobs.ts:74-83 (push starts loop)`, `server/src/jobs.ts:95-114 (run -> failed -> after)`, `server/src/library/service.ts:255-306 (#fail, #run, #after)`, `server/src/scenes/service.ts:441-447, 562-565 (delete marks queued jobs failed; #run skips non-queued)`, `server/src/rooms/service.ts:384-388 (delete marks queued align jobs failed)`

**Encoding:** SerialQueue: #busy boolean + #idle promise + #settle resolver + #waiting array; the running job is held only on #loop's stack. JobStore: Map of job objects whose status string ('queued'|'running'|'done'|'failed') is patched by callers through an unguarded update(id, Partial<J>); #order array gives creation order. Scenes/rooms add a #dropped Set and #requeued Set beside it.

**States:** queue idle (#busy=false, #idle resolved) · queue busy, job running · queue busy with waiters · job queued · job running · job done · job failed · job dropped (scene/room deleted: queued -> failed while still in #waiting) · after-hook running (reservation release, temp cleanup)

**Transitions:**
- idle -> busy on push() (new #idle promise, starts #loop)
- busy -> busy on push() (append to #waiting)
- queued -> running when #loop shifts it and the service's run patches status
- queued -> failed on scene/room delete (job still in #waiting; scenes #run returns early because status !== 'queued')
- running -> done|failed via JobStore.update inside run
- running -> failed via #failed when run throws
- any -> after-hook always
- busy -> idle when #waiting empty (#busy=false, #settle())

**Risks:**
- JobStore.update accepts any Partial patch with no transition guard; correctness relies on each service's #run checking status itself (scenes does at service.ts:564; library #run does not check status, it only checks the job exists).
- No way to cancel a running job: deleting a scene/room only marks it in #dropped and ignores its result, the child process keeps running.
- Shutdown is not a queue state: main.ts stop() never awaits drained(); running/queued jobs vanish with the in-memory store while detached child processes keep running (see tool-run-lifecycle).
- JobStore grows forever (#jobs/#order never evicted); position() is an O(n) indexOf over every job ever created.
- drained() returns the #idle promise of the current cycle only; a push after it resolves starts a new cycle the caller doesn't see.
- If #after never resolves the queue stays busy forever with no timeout or visibility.

**Crosses:** Driven by server/src/library/service.ts, server/src/scenes/service.ts and server/src/rooms/service.ts; job status polled by the planner via GET /api/{library,scenes,rooms}/jobs[/id].

> Verifier: Dropped the 'run sets done then throws, overwritten to failed' risk: library #run's done update is its last statement and scenes/rooms runs end similarly, so it is not reachable today. Corrected 'no cancel state at all': scenes/rooms delete() flips queued jobs to failed (a de facto cancel) and scenes #run guards on status !== 'queued' (scenes/service.ts:564); running jobs still cannot be cancelled. Other risks verified in jobs.ts and main.ts.

### [high] Daily spend cap reservations (reserve / release / hold-for-today / expire)

*corrected* · `server/src/spend.ts:17-31 (#cap, locked, #reserved Map)`, `server/src/spend.ts:43-50 (setCap)`, `server/src/spend.ts:58-66 (spent: 0 on read error)`, `server/src/spend.ts:68-72 (#expireHeld)`, `server/src/spend.ts:89-112 (reserve, release, holdForToday)`, `server/src/logic/spend.ts:15-39 (refusal, heldKey, heldExpired)`, `server/src/routes/library.ts:78-90, 133-157 (fetch-* reservation hand-off)`, `server/src/library/service.ts:234, 271, 302`, `server/src/scenes/render.ts:135-143`, `server/src/product/llm.ts:164, 215`

**Encoding:** Map<string, number> whose key string encodes each reservation's state: plain key = active; 'held:<YYYY-MM-DD>:<key>' = held until the UTC day changes; absent = released. Cap is a mutable number plus a locked boolean and a nullable settings file.

**States:** none (key absent) · reserved (active key) · held for today · expired held (dropped lazily on next view/reserve) · cap locked by flag vs app-settable

**Transitions:**
- none -> reserved on reserve(key, amount>0) when refusal() is null
- none -> none on reserve with amount <= 0
- reserved -> none on release(key)
- reserved -> held on holdForToday(key) (library job timed out); the later #after release(id) no longer matches the held key
- held -> removed by #expireHeld when today() differs
- cap -> new cap on setCap (only when !locked)
- fetch-<hex> reserved -> released -> job-id reserved in queueAdd/newJob

**Risks:**
- Leaked reservation: postFromUrl reserves 'fetch-<hex>' (library.ts:143) then awaits makeTempDir at :145 outside the try; a mkdtemp failure leaves the key reserved, and non-held keys never expire, so the cap stays reduced until restart. The same holds if queueAdd throws before line 81 (readPlain/findItem).
- spent() returns 0 when costs.csv can't be read (spend.ts:59-64): the cap fails open.
- The fetch-to-job hand-off is release-then-reserve (library.ts:81 then service.ts:234), not one atomic transfer: it can answer 402 after the image was already downloaded.
- Held reservations expire at UTC midnight regardless of when they were held.
- setCap below spent+reserved leaves running reservations in place; there is no explicit 'over cap' state.

**Crosses:** Reservations from server/src/library/service.ts, server/src/scenes/render.ts, server/src/product/llm.ts; spent read from costs.csv written by common/costs.ts by the server and midstudy-add (pipeline/). Planner reads GET /api/spend and GET/PUT /api/settings.

> Verifier: Dropped the key-collision risk: keys come from unique generators (newJobId random hex, 'fetch-'+random, render.ts #reserveName with its own #reserved set, product holdKey), so Map.set replacement is not reachable in practice. Other risks verified in code.

### [high] Library / costs lock directory protocol (take, wait, reclaim, release)

*corrected* · `common/lock.ts:66 (heldHere map)`, `common/lock.ts:114-127 (judge)`, `common/lock.ts:130-152 (reclaim)`, `common/lock.ts:155-195 (acquireLock loop)`, `common/lock.ts:199-226 (releaseSync, held released flag)`, `common/lock.ts:229-231 (releaseAllSync)`, `common/logic/lock.ts:44-54 (LockVerdict)`, `common/costs.ts:28-32 (appendCost waitMs null)`, `server/src/library/service.ts:175-177 (locked, 60 s)`

**Encoding:** File-system presence: <lock>.d absent / present without owner.json / with owner.json; aside folders '<lock>.d.stale-<pid>-<hex>' and '.released-…' mark a reclaim or release in progress. In-process: heldHere Map, per-handle released boolean, waited boolean and a deadline in the acquire loop.

**States:** free · taken, no owner yet · held · stale: dead-owner | too-old | no-owner · being reclaimed (aside .stale-*) · being released (aside .released-*) · waiter polling · waiter Busy (deadline passed)

**Transitions:**
- free -> taken on mkdir
- taken -> held on owner.json write; taken -> free on write failure
- held -> releasing -> free on release() when owner.json still matches
- held -> stale when pid dies / age > 3600 s / no owner > 10 s
- stale -> reclaiming -> free when moved owner matches; reclaiming -> moved back when not
- waiter -> Busy at deadline, or keeps polling (waitMs null)

**Risks:**
- 'too-old' reclaims a live holder that runs past 3600 s, and age uses the owner's own clock (Date.parse(owner.started)) so cross-host skew can mark a fresh lock too-old; there is no fencing, the reclaimed holder keeps writing.
- reclaim's move-back can fail when a new taker created the folder meanwhile (lock.ts:141-148): two holders at once, relying on release() checking owner.json.
- In-process exclusion is the same file lock: concurrent server requests poll their own live pid every 50 ms with no FIFO/fairness, and any nested library.locked() call in the same process would wait until Busy (503). No nested call exists today.
- appendCost waits with waitMs null (costs.ts:29): a cost row (and its HTTP request) waits behind a hung but live holder until the 3600 s too-old reclaim.
- heldHere is keyed only by dir: if this process reclaims its own too-old lock and takes it again, the old HeldLock's release clears nothing of the new one but releaseAllSync only knows the latest owner.
- An orphaned midstudy-add left after a server restart is a live pid, so its lock is 'held' and library writes answer 503 until it finishes.

**Crosses:** Shared on disk with pipeline/ (midstudy-add withLibraryLock, releaseAllSync on signals) and server/src/library/service.ts; Busy maps to 503 in server/src/http/server.ts:94-95.

> Verifier: Re-entrancy risk softened: no nested acquisition exists in the server; the real effect is polling-based, unfair in-process serialization. appendCost waits up to the 3600 s too-old reclaim, not literally forever. heldHere risk restated precisely.

### [high] Server process lifecycle (startup -> listening -> stopping -> exit) and shutdown hooks

*corrected* · `server/src/main.ts:72-110 (startup checks, enableStrict)`, `server/src/main.ts:112-135 (hooks array, onShutdown)`, `server/src/main.ts:145-154 (listen)`, `server/src/main.ts:160-171 (stopping flag, close, closeAllConnections, 5 s race, exit)`, `server/src/main.ts:175-180 (uncaughtException/unhandledRejection keep serving)`, `server/src/scenes/shared.ts:33 (the only hook)`

**Encoding:** A local stopping boolean, a mutable hooks array, process signal handlers and a 5 s unref'd timer; 'listening' is implied by the resolved listen promise.

**States:** parsing/validating flags · strict loading · listening · stopping (hooks running, connections cut) · exited

**Transitions:**
- start -> exit(1|2) on a startup refusal
- start -> listening on listen callback
- listening -> stopping on first SIGINT/SIGTERM (later ignored)
- stopping -> exited when all hooks settle or after 5 s

**Risks:**
- stop() cuts every connection first and exits as soon as the hooks settle: a paid render whose fal call already returned can be killed before appendCost writes its costs.csv row, so a billed call is missing from the ledger.
- Job queues are not drained or recorded, and child tools started with detached:true (common/tools.ts:78) are in their own process group, so midstudy-add/calib one-shots survive the exit, still paying fal and holding the library lock.
- After uncaughtException/unhandledRejection the server keeps serving with whatever partial state the failed code left; there is no degraded state.
- All hooks share one 5 s budget; a hanging hook makes exit wait the full 5 s silently.

**Crosses:** Hook registered by server/src/scenes/shared.ts:33; job queues in scenes/library/rooms services and children from common/tools.ts are affected.

> Verifier: Dropped 'onShutdown can register after stopping': every hook is registered while routes are constructed (allRoutes before listen), so no late registration happens. Other risks verified.

### [high] Library item delete/restore lifecycle on disk (live -> .trash -> restored)

*corrected* · `server/src/routes/library.ts:216-238 (deleteItem)`, `server/src/routes/library.ts:242-262 (restoreItem)`, `server/src/routes/library.ts:161-188 (patchItem then rescale queued after lock)`, `server/src/library/service.ts:205-227 (trash(): skips copies without entry.json)`, `common/files.ts:140-150 (move)`

**Encoding:** Item state is implied by three on-disk facts: an entry in library.json, a folder <library>/<id>, and .trash/<id>-<stamp>/ holding entry.json and/or <id>/. No status field.

**States:** live · trashed · half-deleted (folder in trash without entry.json, library.json still lists the item) · half-restored (folder back, library.json lacks the item, trash copy still has entry.json)

**Transitions:**
- live -> trashed on DELETE (mkdir, move folder, write entry.json, write library.json)
- trashed -> live on POST restore (move folder back, write library.json, remove trash copy)
- live -> live (fields changed) on PATCH, then a rescale job queued after the lock is released

**Risks:**
- Half-restored is stuck: if library.write throws in restoreItem after move() at :255, the folder is back but library.json lacks the item; every retry answers 409 (the folder exists, :247) and DELETE answers 404.
- Half-deleted: if writeFile(entry.json) throws (strict assert, disk) after the folder moved at :231, library.json still lists an item with no assets; a later DELETE succeeds into a new trash folder, and the first trash folder (assets, no entry.json) is skipped by trash() and orphaned for good.
- move() across file systems is copy-then-remove: a crash in between leaves both copies.
- patchItem decides the refit inside the lock but queues the rescale after releasing it, with plan.dims from this request; a concurrent PATCH in between can be overwritten by the rescale's dims.

**Crosses:** library.json and item folders are also written by midstudy-add (pipeline/) under the same lock; GET /api/library lists trash via LibraryService.trash().

> Verifier: The half-deleted consequence was wrong: restore answers 409 (the item is still in library.json), not a PyError; the real damage is an orphaned trash folder invisible to trash() (service.ts:218-220). The rest is verified.

### [medium] Upload / from-URL add hand-off (temp folder and reservation ownership)

*confirmed* · `server/src/routes/library.ts:78-90 (queueAdd)`, `server/src/routes/library.ts:93-129 (postUpload)`, `server/src/routes/library.ts:133-157 (postFromUrl)`, `server/src/routes/scenes.ts:41-89 (postScene: upload.part -> upload.<ext> -> scenes.create)`

**Encoding:** Ownership of a temp folder and spend reservation is implicit in control flow: the request owns them until newJob/scenes.create succeeds, then the job (#runs cleanup, removed in #after); removeTree/release calls are scattered over catch blocks. 'upload.part' vs 'upload.<ext>' marks whether the photo was checked.

**States:** validating headers · reserved (from-URL only) · temp folder created · body/download written · validated · handed to job · refused (tmp removed, reservation released)

**Transitions:**
- headers ok -> reserved -> tmp -> downloaded -> validated -> queued (202) | refused (402) | failed (400)
- upload: tmp -> written -> validated -> queued | refused

**Risks:**
- postFromUrl: makeTempDir at :145 is outside the try, so a failure leaks the 'fetch-*' reservation.
- postUpload/postFromUrl: if queueAdd throws (readPlain, addArgv, newJob) the temp folder is never removed; only the 402 path cleans it (:84-86).
- postScene: if scenes.create throws after the upload was renamed, the temp folder leaks (no try around scenes.ts:87).
- A client that disconnects after the job was queued still has its job run; there is no 'abandoned' state.

**Crosses:** Hands off to server/src/library/service.ts newJob and server/src/scenes/service.ts create; reservations go to server/src/spend.ts.

> Verifier: All cited lines match.

### [medium] Child tool run (spawn, capture, timeout kill, settle)

*confirmed* · `common/tools.ts:53-108 (runTool)`, `common/tools.ts:83-92 (timeout: SIGKILL group then resolve)`, `common/logic/tool.ts:21-24 (pyReturnCode)`

**Encoding:** A settled boolean, a timer handle, and the first of 'error' / 'close' / timeout to call done(); output buffers trimmed from the front past maxOutput.

**States:** spawn failed · running · exited · not-found · timed out (kill sent) · settled

**Transitions:**
- start -> spawn-error on throw
- running -> not-found|spawn-error on 'error'
- running -> exited on 'close'
- running -> timeout on timer (SIGKILL to -pid) -> settled before the child exits

**Risks:**
- detached:true puts the tool in its own process group, so a terminal Ctrl-C or the server's exit does not reach it and no shutdown hook kills it: orphans keep paying fal and holding the library lock.
- On timeout the promise settles before 'close'; library #after then removes the upload folder while the killed process may still be tearing down.
- An 'error' event after a successful spawn settles as spawn-error and clears the timer, and the process is never killed.

**Crosses:** Used by server/src/library/service.ts (midstudy-add, 3600 s) and the server's calib/align one-shots (server/src/tools.ts, scenes/calib.ts).

> Verifier: Verified in common/tools.ts.

### [medium] Layout soft-delete and client-side Undo (live file -> .trash copy -> PUT back)

*found by verifier* · `server/src/routes/layouts.ts:109-121 (PUT: owner checked, then await readJson, then writeJsonSync)`, `server/src/routes/layouts.ts:124-147 (DELETE: replace into layouts/<owner>/.trash/<name>-<stamp>[-n].json)`, `server/src/scenes/service.ts:461-462 (scene delete moves layouts/<name>/ into the scene trash)`, `server/src/scenes/service.ts:511 (scene restore refuses 'exists' when layouts/<name> exists)`

**Encoding:** File presence: layouts/<owner>/<name>.json (live) vs layouts/<owner>/.trash/<name>-<stamp>.json (deleted); Undo has no server state, the planner PUTs back the copy it read. Owner existence is checked before the body is read, with no lock or version.

**States:** absent · live · trashed (copy in .trash) · restored by PUT (new live file; trash copy remains) · orphan layout folder (written for a scene deleted mid-request)

**Transitions:**
- absent|live -> live on PUT (last write wins)
- live -> trashed on DELETE
- trashed -> live on the planner's Undo PUT
- scene deleted -> its layouts folder moves into the scene's trash

**Risks:**
- PUT checks the scene/room exists (layoutOwnerOf) and only then awaits the body; a scene deleted meanwhile gets layouts/<scene>/ recreated by writeJsonSync, and that orphan folder makes a later scene restore answer 'exists' (scenes/service.ts:511).
- No version or precondition on PUT: an Undo PUT (or a second tab) silently overwrites a newer layout of the same name.
- Trashed layout copies are never purged, and restoring one leaves its .trash copy behind.

**Crosses:** Planner Undo of a layout delete; scene delete/restore in server/src/scenes/service.ts moves the same folders.

### [low] HTTP request/answer lifecycle (body read state, early answer, drain, close)

*corrected* · `server/src/http/context.ts:75-81 (status, #continueSent, #bodyDone, #closeAfter, #answered)`, `server/src/http/context.ts:131-136 (#sendContinue)`, `server/src/http/context.ts:140-193 (#consume)`, `server/src/http/context.ts:218-270 (readBody, readBodyTo)`, `server/src/http/context.ts:274-296 (#discardBody)`, `server/src/http/context.ts:301-319 (send)`, `server/src/http/context.ts:328-337 (stalled)`, `server/src/http/context.ts:340-381 (sendHtmlError, sendEmpty, beginFile, #write)`, `server/src/http/context.ts:385-414 (#sendEarly)`, `server/src/logic/http.ts:33-35 (isEarly)`, `server/src/http/server.ts:87-104 (failed)`

**Encoding:** Four private booleans (#continueSent, #bodyDone, #closeAfter, #answered) plus numeric status (0 = not answered); per-call ReadEnd string; #consume's own finished flag and two timers.

**States:** fresh · continue sent, reading body · body done · draining before answer · answered normally · answered early (raw 411/413, drain, close) · file answer streaming · stalled (408 or socket destroyed) · close-after flagged

**Transitions:**
- fresh -> reading on readBody/readBodyTo
- reading -> bodyDone on end/stopped; -> stalled (closeAfter, BodyStalled) on timeout/gone
- fresh -> early-answered on send(411|413) while !bodyDone or while the client waits for 100-continue
- fresh -> draining -> answered on other send()
- answered -> later sends are no-ops
- stalled(timeout) -> send(408); stalled(gone) -> answered + socket.destroy

**Risks:**
- #sendEarly sets #answered and status before checking socket.writable (context.ts:386-399): an early answer on a dead socket is still logged with that status.
- beginFile sets #answered but not #bodyDone, so answered && !bodyDone is representable (harmless for GET/HEAD only).
- #answered is set only after #discardBody's drain (up to DRAIN_MS); a second send() started during that window would pass the #answered check. No handler sends without awaiting today, so this is latent.
- The legal combinations of the four booleans are kept only by every path setting them in order (e.g. server.ts:126-127 markBodyDone + closeConnection before a 400).

**Crosses:** Every route handler drives it via readJson/readBodyTo/send/error; static.ts uses beginFile/sendEmpty/sendHtmlError.

> Verifier: The 'failed() double-answer during drain' risk is not reachable: handlers await send() before throwing, so it is restated as latent. Dropped the 'second readJson returns empty body' risk: no handler reads the body twice. Severity lowered to low.

### [low] Safe URL fetch redirect/hop loop with budget and per-hop abort

*confirmed* · `server/src/fetch.ts:22-35 (Budget)`, `server/src/fetch.ts:145-160 (lookup raced with timeout)`, `server/src/fetch.ts:213-288 (readBody)`, `server/src/fetch.ts:291-344 (safeFetch)`

**Encoding:** Loop counter hopNumber plus mutable current URL; per-hop AbortController + watchdog timer; readBody keeps lazy inflater, over flag, counters.

**States:** resolve DNS · address check · awaiting headers · redirect -> next hop · non-200 returned · reading body · over limit · failed: timeout | dns | private | tls | network | too-many-redirects | cross-origin | bad-url

**Transitions:**
- hop n -> n+1 on 30x with Location
- -> too-many-redirects when the loop ends
- headers -> body on 200 and check() ok
- body -> over on size limits
- any -> timeout when the watchdog aborts or the budget is over

**Risks:**
- Any non-FetchFailed error after the budget ran out is reported as 'timeout' (fetch.ts:336), masking a coincident TLS/network failure.
- The DNS lookup is raced, not cancelled: a timed-out lookup keeps running in the thread pool.

**Crosses:** Used by routes/library.ts postFromUrl and server/src/product/ (outside this group).

> Verifier: Verified.

### [low] Per-socket in-flight request counter and idle timeout

*confirmed* · `server/src/http/server.ts:68 (inFlight WeakMap)`, `server/src/http/server.ts:162-172 (increment, decrement on res close)`, `server/src/http/server.ts:220-224 (timeout)`, `server/src/http/server.ts:182-216 (clientError raw answers)`

**Encoding:** WeakMap<socket, number>; idle vs busy inferred from counter===0 and socket.writableLength.

**States:** idle connection · request in flight · answer stalled (client not reading) · destroyed

**Transitions:**
- idle -> in flight on request/checkContinue
- in flight -> idle on res 'close'
- idle -> destroyed on socket timeout
- in flight -> destroyed on timeout only when writableLength > 0

**Risks:**
- A handler that never answers keeps its socket forever (the counter never drops and the timeout ignores busy sockets).

> Verifier: Verified; the second risk (early answers relying on res close) is not a defect and was dropped.

### [low] Atomic write / replace protocol with .tmp files

*confirmed* · `common/files.ts:11-40 (tempName, atomicWrite, atomicWriteSync)`, `common/files.ts:154-169 (replace)`, `server/src/strict.ts:115-118 (writeJsonFile)`, `common/costs.ts:28-32`

**Encoding:** A '.<name>.<hex>.tmp' beside a file means a write in progress or a crashed one; the rename commits.

**States:** no temp · temp written · committed · temp left behind (crash)

**Transitions:**
- no temp -> temp -> committed
- temp -> removed on error
- crash -> orphan temp (never swept)

**Risks:**
- Orphan .tmp files after a crash are never swept.
- replace() across file systems removes the source only after the rename; a crash between leaves both (layout trash).

**Crosses:** Same helpers used by pipeline/ and the scenes/rooms services.

> Verifier: Verified.

### [low] Strict mode module-global (contract loaded or not)

*confirmed* · `server/src/strict.ts:32`, `server/src/strict.ts:40-45`, `server/src/strict.ts:57-61`, `server/src/main.ts:110`

**Encoding:** Nullable module variable: null = off, set = on; never reset.

**States:** off · loading · on

**Transitions:**
- off -> on after both imports resolve

**Risks:**
- Anything validated before main.ts:110 resolves goes unchecked; main awaits it before listening, so low.

**Crosses:** Read by every writer via writeJsonFile/assertConforms and by RequestContext.send.

> Verifier: Verified; enableStrict also early-returns when already on (strict.ts:41).

### [low] Character/byte parser state machines (shlex, CSV, UTF-8 decoders, Host header folding, JSON depth)

*corrected* · `common/logic/shlex.ts:21-89`, `common/logic/csv.ts:56-115`, `common/utf8.ts:16-56`, `server/src/logic/url.ts:201-253, 276-289`, `server/src/logic/http.ts:104-124`, `server/src/http/context.ts:432-450`

**Encoding:** Loop-with-mode-variables: one-char state string in shlex; quoted/afterQuote/started booleans in the CSV reader; need/bounds in UTF-8 decoders; lastWasHost flag.

**States:** shlex: whitespace, word, quote, escape · csv: field start, quoted, after quote, unquoted field, record end · utf8: lead byte, continuation k of need, error · rawHeadHosts: after Host line, other line, continuation

**Transitions:**
- per character/byte, after CPython's shlex and csv and the UTF-8 'replace' algorithm

**Risks:**
- jsonTooDeep is only a pre-parse guard; malformed input can drive its depth negative, harmless since JSON.parse then rejects it.

**Crosses:** shlex splits --calib/--midstudy-add at startup; spentOn feeds the spend cap; unquote feeds routing and queryValue.

> Verifier: Dropped the CSV 'quoted && afterQuote' risk: the code sets quoted=false whenever it sets afterQuote=true (csv.ts:73-74) and only enters quoted when !afterQuote, so that combination never occurs. Pure TScert-covered code.

## server-domain

### [high] Scene calibration job lifecycle (calibrate/run/fit) with drop-on-delete

*corrected* · `server/src/scenes/service.ts:120-133`, `server/src/scenes/service.ts:336-365`, `server/src/scenes/service.ts:368-371`, `server/src/scenes/service.ts:375-392`, `server/src/scenes/service.ts:441-448`, `server/src/scenes/service.ts:541-550`, `server/src/scenes/service.ts:552-568`, `server/src/scenes/service.ts:570-622`, `server/src/scenes/service.ts:638-659`, `server/src/scenes/logic/status.ts:28-34`

**Encoding:** JobView.status string ('queued'|'running'|'done'|'failed') mutated via JobStore.update from 6 places, plus an orthogonal #dropped Set (kept forever), #last map (newest calibration job per scene), #work map (argv + tmp cleanup, removed in #after), and calib.json/photo.jpg presence on disk; calib_status is computed from these, never stored

**States:** queued · queued+dropped (immediately failed SCENE_DELETED) · running · running+dropped · done · failed · failed(SCENE_DELETED) · no job this server run + calib.json (done) · no job + no calib.json (failed LOST_CALIBRATION after restart)

**Transitions:**
- (none) -> queued on create()/calibrate() (#queueJob)
- queued -> running in #run (synchronously before the await)
- queued -> failed(SCENE_DELETED) on delete() (plus #dropped add)
- running -> running+dropped on delete()
- running -> done on ok result (#ended; camera written if camera_source auto/default/missing)
- running -> failed on not-found/timeout/violation/stopped/non-ok (#finish rewrites message to SCENE_DELETED and removes leftover if dropped)
- running -> failed on spawn-error (direct JobStore.update, bypasses #finish)
- run throws -> failed (#failed catch-all)
- any -> forgotten on server restart (status then derived from calib.json only)

**Risks:**
- spawn-error branch (service.ts:578-580) updates the job directly instead of via #finish, so a dropped job reports 'the server failed to run … (OSError …)' instead of SCENE_DELETED and #removeLeftover is skipped (the leftover itself is unlikely on a spawn error, but in the worker->one-shot fallback path a broken worker may have already written into the moved-away path)
- Delete then restore while the job runs (restore succeeds if the tool hasn't re-made scenes/<name>/ yet): #dropped stays set, the tool keeps writing into --out scenes/<name> (the restored folder), #ended reports SCENE_DELETED and skips the camera; #removeLeftover keeps the folder because scene.json exists; calibStatus then reports failed('the scene was deleted') because a failed job wins over hasCalib (status.ts:31)
- Delete while a re-fit is queued on a scene with a good calib.json, then restore: #last still points at the failed(SCENE_DELETED) job, so calib_status stays failed for the rest of the server's life until recalibrated
- While a dropped job runs the tool may re-create scenes/<name>/ without scene.json; restore() answers 'exists' (service.ts:511) until the job ends and #removeLeftover runs
- Restart forgets queued/running jobs: a freshly created scene (scene.json, no photo.jpg, upload in os.tmpdir) shows LOST_CALIBRATION; calibrate() then needs a source.<ext> in the scene folder (service.ts:380-382) or answers NO_PHOTO_TO_CALIBRATE
- Mode of the next calibrate() is file-presence encoded: a failed 'run' that already wrote photo.jpg flips it to 'fit' (service.ts:379)
- #jobs (JobStore never removes) and #dropped are never evicted

**Crosses:** Polled by the planner via GET /api/scenes/jobs and the scene object's calib_status/calib_error; busy() read by rooms/service.ts (#view waiting_for, align() admission, #run requeue)

> Verifier: All states/transitions verified. Spawn-error risk narrowed: bypassing #finish is real (wrong message for dropped jobs, no leftover cleanup) but a pure spawn failure rarely leaves a re-made folder. Restore-while-running scenario sharpened: restore only succeeds before the tool re-creates the folder (exists check at 511). Other risks confirmed in code.

### [high] Warm calibration worker process (one <calib> serve child) request/idle/exit lifecycle

*corrected* · `server/src/scenes/calib.ts:73-123`, `server/src/scenes/calib.ts:130-143`, `server/src/scenes/calib.ts:145-181`, `server/src/scenes/calib.ts:184-205`, `server/src/scenes/calib.ts:208-224`, `server/src/scenes/calib.ts:247-270`

**Encoding:** nullable #pending {id, resolve, timer}, nullable #gone reason string (null = usable), nullable #idle timer handle, #exited promise, child.exitCode/signalCode, partial-line buffer #out/#outLength, #stderr accumulated only while pending

**States:** spawn-failed (gone set in ctor) · fresh (no request yet, no idle timer) · in-flight (pending set, timeout timer armed) · idle-ready (pending null, idle timer armed) · broken (gone set, kill() in progress) · idle-closed (gone='it was idle', stdin ended, detached from runner) · exited (close/error event) · closing on shutdown

**Transitions:**
- ctor -> spawn-failed on sync spawn throw
- ctor -> fresh
- fresh|idle-ready -> in-flight on ask()
- in-flight -> idle-ready on matching answer line (#settle + #armIdle)
- in-flight -> broken on garbled line / overlong line (#broke -> kill)
- in-flight -> exited-broken on stdin closed / 'error' / 'close' (#lost -> onGone)
- in-flight -> timeout answer on timer; runner then kill()s
- idle-ready -> broken on stray stdout line with no request
- idle-ready -> idle-closed on idle timer
- any -> exited on 'close'
- any -> closing on close() at shutdown

**Risks:**
- Idle close (calib.ts:197-203) only ends stdin and calls onGone (runner drops the reference); no SIGKILL grace timer is armed and shutdown() no longer sees it (#worker null), so a detached worker that ignores EOF (e.g. mid MoGe load) is a leaked process group
- stderr is accumulated only while #pending !== null (calib.ts:119) and reset in ask(); a crash trace written while idle (then 'close') is never surfaced anywhere
- After a timeout settles, a late answer line arrives with #pending null and triggers #broke -> a second kill(); likewise #broke during a request plus CalibRunner.run's own kill() call kill() twice, sending SIGTERM twice and arming two SIGKILL timers (both cleared on exit; harmless today)
- #broke does not call #onGone; the runner relies on its own `if (this.#worker === worker) this.#worker = null` (calib.ts:327) or the gone check (calib.ts:316) — correct now but an implicit handshake

**Crosses:** Driven by SceneService (calibrations, light jobs) and RoomService align jobs through SceneService.runCalib; protocol defined by calib/ (midstudy-calib serve, contract §4.3 Worker)

> Verifier: Idle-close leak confirmed (no grace timer, runner forgets it). Added the 'fresh' state (no idle timer until first answer). The #broke/onGone item is not a bug: run() handles it at 316/327; recast as an implicit handshake. stderr risk reframed: ask() resets #stderr anyway, so the actual loss is crash output while idle.

### [high] Room align job lifecycle (queued/waiting/running/done/failed) with drop-on-delete

*corrected* · `server/src/rooms/service.ts:126-132`, `server/src/rooms/service.ts:212-220`, `server/src/rooms/service.ts:385-389`, `server/src/rooms/service.ts:460-466`, `server/src/rooms/service.ts:478-499`, `server/src/rooms/service.ts:502-512`, `server/src/rooms/service.ts:521-545`, `server/src/rooms/service.ts:547-592`, `server/src/rooms/logic/room.ts:267-274`

**Encoding:** AlignJobView.status string + #dropped Set + #requests map + #last map; 'waiting' is not a status but derived at read time from members' busy(); align_status derived from last non-dropped job and align.json presence

**States:** queued · queued-waiting (members calibrating) · running · running+dropped · done · failed · failed(ROOM_DELETED) · no job + align.json (done) · no job + no align.json (none)

**Transitions:**
- (none) -> queued on align()
- queued -> queued (requeued) while a member is busy and the queue is non-empty
- queued -> failed(ALIGN_TOO_FEW) when <2 members have photos
- queued -> running
- queued -> failed(ROOM_DELETED) on room delete
- running -> done (room.json members/aligned written) on ok answer
- running -> failed on tool errors/timeout/violation/stopped
- running -> running+dropped on delete; then failed(ROOM_DELETED)

**Risks:**
- Delete then restore while a job runs (restore succeeds if the tool hasn't re-made rooms/<name>/ yet): #lastJob hides the dropped job so align() accepts a new one, and the old run still writes align.json into the restored folder (its --out); #end keeps the folder (room.json exists), so align_status reads 'done' from an align.json never applied to room.json
- A queued job dropped by delete (388) never has #requests[id] deleted: #run's early return (524) skips #end, so #requests leaks
- Members can change (PUT members, scene delete via leave()) while the job runs; #ended applies the answer to the new list (photo sha check guards replaced photos), and a member deleted mid-run had its folder moved under the running tool
- The tool may write align.json and the job still fail (e.g. strict violation of the result line); align_status shows failed now but 'done' after a restart from align.json while room.json.aligned is null — two sources of truth

**Crosses:** Runs on SceneService's calibration queue/worker; polled by the planner's Align photos UI via GET /api/rooms/jobs; align.json written by calib/ align-room

> Verifier: Dropped the 'see queue-task-requeue' risk (the requeue cannot spin). Confirmed the #requests leak: delete marks queued jobs failed without #requests.delete and #run returns early at 524. Restore scenario sharpened with the exists() guard at 441.

### [medium] CalibRunner worker-vs-one-shot degradation and shutdown mode

*confirmed* · `server/src/scenes/calib.ts:283-291`, `server/src/scenes/calib.ts:294-296`, `server/src/scenes/calib.ts:313-340`, `server/src/scenes/calib.ts:343-348`, `server/src/scenes/logic/worker.ts:43-52`

**Encoding:** integer #failures counter (consecutive), boolean #closing, nullable #worker reference; mode derived as workerUsable(failures) && !closing

**States:** worker mode (failures 0..2) · degraded one-shot forever (failures >= 3) · closing (shutdown requested)

**Transitions:**
- worker -> worker (failures reset to 0) on an answer
- worker -> worker (failures+1) on broken, job re-run one-shot
- worker -> one-shot-forever when failures reaches 3
- timeout: failures unchanged, worker killed, job times out
- any -> closing on shutdown()

**Risks:**
- After shutdown() sets #closing, the SceneService SerialQueue keeps draining: the next job sees usesWorker false (calib.ts:314) and runs oneShot, exactly the 'one-shot run that would outlive the server' line 329 avoids
- A one-shot run already in flight at shutdown (runTool) is never stopped
- Degradation is permanent for the process lifetime: three consecutive worker failures disable the warm worker until restart, no recovery transition

**Crosses:** shutdown triggered from deps.onShutdown in scenes/shared.ts:33

> Verifier: Verified: usesWorker check precedes the #closing early-return path; the queue has no stop; failuresAfter/workerUsable never reset except on an answer.

### [medium] Scene camera_source (default/auto/manual) governing who may overwrite the camera

*confirmed* · `server/src/scenes/service.ts:347`, `server/src/scenes/service.ts:409-424`, `server/src/scenes/service.ts:611-618`, `server/src/scenes/logic/scene.ts:105-118`, `server/src/scenes/logic/sceneput.ts:98-117`

**Encoding:** string field camera_source in scene.json alongside an independent camera object

**States:** default · auto · manual

**Transitions:**
- (create) -> default
- default|auto|missing -> auto on successful calibration
- any -> any on PUT camera_source
- camera edited by PUT without camera_source -> source unchanged

**Risks:**
- PUT with a camera but no camera_source keeps 'auto'/'default' (service.ts:414-415 independent), so the next recalibration overwrites the hand-tuned camera; the 'manual' transition depends on the client sending it
- PUT camera_source:'auto' without a camera leaves the old (manual) camera labelled auto
- A manual PUT landing during a calibration is respected only because #ended reads and writes scene.json in one synchronous turn (service.ts:612-617); an await between would reintroduce a lost update

**Crosses:** Planner sends PUT /api/scenes/<name>; calib/ writes calib.json camera

> Verifier: Verified in update() and #ended/takesCalibratedCamera.

### [medium] Scene folder lifecycle on disk (live / trashed / restored) and room hand-off

*confirmed* · `server/src/scenes/service.ts:199-201`, `server/src/scenes/service.ts:441-466`, `server/src/scenes/service.ts:469-504`, `server/src/scenes/service.ts:507-522`, `server/src/scenes/service.ts:535-538`, `server/src/scenes/logic/names.ts:29-35`

**Encoding:** file/folder presence: scenes/<name>/scene.json, scenes/.trash/<dir>/{scene.json,trash.json,layouts/}, layouts/<name>/; room membership record serialized into trash.json

**States:** live · trashed (with trash.json) · trashed-legacy (no trash.json, name from dir) · leftover (folder without scene.json re-made by a tool) · restored

**Transitions:**
- live -> trashed on delete (leave room, move folder, move layouts, write trash.json)
- trashed -> live on restore (newest copy; move, rm trash.json, move layouts, rejoin)
- leftover -> removed when a dropped job ends

**Risks:**
- delete is multi-step (room.json rewritten by leave() at 459, folder move at 460, layouts move, trash.json at 464); a crash after leave() but before trash.json loses the room record (the scene is still listed via the legacy dir-name path but cannot rejoin)
- restore removes trash.json (514) before moving layouts and calling rejoin; a crash in between leaves a live scene with a layouts/ subfolder and its room membership lost
- restore while the old scene's dropped job runs can collide with the tool-recreated leftover folder ('exists')

**Crosses:** rooms/service.ts leave()/rejoin() mutate room.json during scene delete/restore; layouts/ shared with routes/layouts.ts

> Verifier: Steps are synchronous (atomic for the process) but not crash-atomic; verified ordering in code.

### [medium] Room member placement state (pose_source origin/solver/manual/unplaced)

*corrected* · `server/src/rooms/logic/members.ts:7-16`, `server/src/rooms/logic/members.ts:22-24`, `server/src/rooms/logic/members.ts:39-51`, `server/src/rooms/logic/members.ts:61-74`, `server/src/rooms/logic/members.ts:77-82`, `server/src/rooms/logic/members.ts:86-104`, `server/src/rooms/logic/members.ts:163-189`, `server/src/rooms/logic/room.ts:325-336`, `server/src/rooms/service.ts:315-337`, `server/src/rooms/service.ts:350-375`

**Encoding:** pose_source string paired with a nullable pose; the invariant (pose null iff unplaced) is restored on read (readMember) rather than enforced by a type

**States:** origin · solver · manual · unplaced

**Transitions:**
- new room: first -> origin, others -> unplaced
- PUT pose differing -> manual; PUT pose null -> unplaced; PUT new member -> unplaced or manual
- align answer for current photo sha -> solver (unless origin, or manual without overwrite_manual); answer says unplaced -> unplaced (unless manual/origin)
- reset -> solver or unplaced (origin untouched)
- scene delete -> removed (record to trash.json); restore -> reinserted with old source
- rescale -> poses scaled, source unchanged

**Risks:**
- Only firstMembers creates 'origin': deleting the origin scene or PUTting a list without it leaves a room with no origin (anchorIndex falls back to manual/placed/first); restoring the origin scene later reinserts it as 'origin' beside whatever manual anchors were set meanwhile, possibly in an inconsistent frame
- PUT sending the origin member a changed pose turns it into 'manual' (members.ts:49), silently dropping the origin role
- readMember turns a hand-edited 'unplaced' with a pose, or an unknown source, into 'manual' (room.ts:334), which makes it fixed for align
- reinsertMember silently drops a restored member when the room is full (32) or already lists it (members.ts:69)

**Crosses:** Planner floor plan / room UI reads and PUTs members; proofs/ Room.lean models the frames

> Verifier: Restated the origin risk: a 'second origin' cannot coexist since nothing else creates one; the real issue is a restored origin re-entering a frame re-anchored by manual members meanwhile. Other risks confirmed.

### [medium] Library midstudy-add job lifecycle with spend reservation

*corrected* · `server/src/library/service.ts:157-159`, `server/src/library/service.ts:175-177`, `server/src/library/service.ts:231-243`, `server/src/library/service.ts:260-298`, `server/src/library/service.ts:301-307`, `server/src/library/logic/messages.ts:59-63`

**Encoding:** LibraryJob.status string updated in place; #runs map (argv + cleanup) presence; spend reservation keyed by job id (reserve / holdForToday moves it to a day-held key / release)

**States:** queued · running · done · failed · failed-timeout (estimate held for UTC day)

**Transitions:**
- (none) -> queued on newJob (after spend reserve)
- queued -> running in #run
- running -> done on exit 0 with summary
- running -> failed on not-found/timeout/non-zero/no summary/throw
- any end -> reservation released + upload removed in #after

**Risks:**
- No drop/cancel state: DELETE /api/library/items/<id> (routes/library.ts:216) does not check queued/running jobs, so an add/rescale job queued for that item still runs midstudy-add and may resurrect it; the job then reports done with whatever library.json holds
- The done path reads library.json via readPlain() without the library lock (service.ts:289); a concurrent PATCH can make `item` reflect a mid-update state
- Restart forgets queued jobs and their reservations; their upload folders in tmp are orphaned

**Crosses:** Library lock (<library>/.lock.d) shared with the midstudy-add CLI (pipeline/); planner polls GET /api/library/jobs; SpendCap shared with renders

> Verifier: Dropped the holdForToday/release risk: spend.ts:106-110 moves the amount to heldKey(day, key) and release(key) (spend.ts:100) deletes only the job key, so the hold survives #after. Confirmed the delete route has no job guard.

### [medium] Room alignment freshness (never aligned / aligned / stale) across room.json.aligned, align.json and photo hashes

*found by verifier* · `server/src/rooms/service.ts:315-337 (update: members/reset/rescale never touch aligned)`, `server/src/rooms/service.ts:350-375 (leave/rejoin never touch aligned)`, `server/src/rooms/service.ts:586-588 (#ended: the only writer of aligned)`, `server/src/rooms/service.ts:193-196 (alignJson read by status and reset)`, `server/src/rooms/logic/members.ts:136-147 (answerFor/current: photo_sha256 match decides whether an answer still applies)`, `server/src/rooms/logic/room.ts:267-274 (alignStatus from align.json presence)`

**Encoding:** room.json `aligned` {solver, finished}|null, align.json presence (written by the tool), and each member's photo.jpg SHA-256 compared at apply time; no field says whether the alignment still matches the members

**States:** never aligned (aligned null, no align.json) · aligned (aligned set, align.json matches members and photos) · stale (members added/removed/rescaled or photos replaced since) · align.json present but never applied (aligned null)

**Transitions:**
- never aligned -> aligned on a done align job
- aligned -> stale on PUT members/rescale, scene leave/rejoin, or a member recalibrated with a new photo
- stale -> aligned on a new align job
- any -> 'align.json but not applied' when a failed or dropped job still wrote align.json

**Risks:**
- `aligned` is never cleared (only #ended writes it), so a room whose members changed still reports aligned with the old solver/time and align_status 'done'
- PUT reset (service.ts:323-330) re-applies the latest align.json even when it came from a failed/dropped run that was never applied, as long as photo hashes match

**Crosses:** Planner room UI reads aligned/align_status; align.json written by calib/ align-room

### [medium] Scene folder progress encoded by files (source.<ext> / photo.jpg / calib.json / lighting.json)

*found by verifier* · `server/src/scenes/service.ts:336-352 (create: scene.json without photo)`, `server/src/scenes/service.ts:375-392 (calibrate picks fit vs run by photo.jpg, falls back to source.*)`, `server/src/scenes/service.ts:394-405 (light requires photo.jpg, short-circuits on lighting.json)`, `server/src/rooms/service.ts:485 and 533 (align admission counts photo.jpg or busy; run counts photo.jpg)`, `server/src/scenes/service.ts:257-284 (sceneObject derives urls, size, floor_found from file presence)`

**Encoding:** presence of files in scenes/<name>/ written by the calib tool; no stored phase

**States:** created (scene.json only, upload in tmp) · photo (photo.jpg, no calib.json) · calibrated (calib.json) · lit (lighting.json) · source-only (source.<ext>, no photo.jpg)

**Transitions:**
- created -> photo/calibrated when the 'run' job writes into --out
- photo -> calibrated on fit
- calibrated -> lit on light job
- created -> stuck after a restart or failed run with no source.<ext> (NO_PHOTO_TO_CALIBRATE)

**Risks:**
- align() admits a room when a member is merely busy (485); if that calibration then fails without writing photo.jpg the align job ends ALIGN_TOO_FEW only at its turn
- Partial outputs of a failed run (photo.jpg without calib.json) change later behaviour (fit instead of run, light allowed, align counts it) with no record that the run failed after a restart

**Crosses:** Files written by calib/ (run/fit/light); read by rooms/service.ts and the planner via the scene object

### [low] Align tasks on the calibration SerialQueue (run / requeue-behind-calibrations / done)

*corrected* · `server/src/scenes/service.ts:130-133`, `server/src/scenes/service.ts:161-164`, `server/src/scenes/service.ts:553-561`, `server/src/scenes/service.ts:638-654`, `server/src/rooms/service.ts:530-532`

**Encoding:** #tasks Map presence + #requeued Set membership toggled between #run and #after; queue position implicit in SerialQueue.#waiting

**States:** queued · running turn · requeued (waiting again behind calibrations) · finished (removed from #tasks)

**Transitions:**
- (none) -> queued on queueTask
- queued -> running turn when shifted
- running turn -> requeued when run() resolves false (#requeued.add, push)
- requeued -> queued on #after (#requeued.delete, task kept)
- running turn -> finished on #after when not requeued (#tasks.delete)
- run throws -> task.failed then finished

**Risks:**
- The requeued flag is a cross-callback handshake between #run and #after with no explicit state; correctness depends on SerialQueue always calling #after once per #run turn (jobs.ts loop)
- Job ids are only assumed unique across calibration and align jobs; queueTask (service.ts:161) does not check, and two align jobs in the same UTC second collide with probability 1/65536 on the 4-hex suffix, overwriting #tasks and duplicating JobStore order

**Crosses:** Owned by rooms/service.ts align jobs; SerialQueue in server/src/jobs.ts (other group)

> Verifier: Rejected 'spin forever': a calibration with status queued is always in SerialQueue.#waiting (pushed in #queueJob, set running synchronously in #run), so queued>0 holds while a member is busy and calibrations drain; ping-pong of two align tasks is bounded. Rejected 'push then throw': #run pushes only after task.run() resolves false, nothing can throw after the push. Severity lowered to low.

### [low] Scene lighting backfill (light job, lighting.json, calibration-newer override)

*corrected* · `server/src/scenes/service.ts:127`, `server/src/scenes/service.ts:287-295`, `server/src/scenes/service.ts:395-405`, `server/src/scenes/service.ts:625-635`, `server/src/scenes/logic/status.ts:45-57`

**Encoding:** lighting.json presence + newest light job status + lighting boolean|null on the job + #dropped + relative JobStore order of newest calib vs light job

**States:** done (lighting.json) · pending · running · failed · none (job found no light) · missing

**Transitions:**
- missing -> pending on POST light (light())
- pending -> running -> done (lighting.json) | none (lighting:false) | failed
- any light state -> shadowed by a newer calibration job (pending/running while it runs, else missing)
- dropped light job -> ignored (missing)

**Risks:**
- After a light job finishes with lighting:false ('none'), any later calibration job hides it via calibrationIsNewer even after that calibration is done (status.ts:51,56), so status flips from 'none' to 'missing' and the planner may offer the backfill again
- Status depends on JobStore insertion order (JobStore.position) as an implicit clock; the light-vs-calibration override is derived, never recorded

**Crosses:** Read by the planner (lighting_status / lighting_error in GET /api/scenes/<name>); lighting.json written by calib/

> Verifier: Dropped the 'light job before a run calibration uses the old photo' risk: light() requires photo.jpg (service.ts:399) and calibrate() only uses 'run' when photo.jpg is missing (service.ts:379), so a calibration queued behind a light job is a 'fit' on the same photo. Severity lowered.

### [low] Room folder lifecycle (live / trashed / restored) with member pruning

*confirmed* · `server/src/rooms/service.ts:293-312`, `server/src/rooms/service.ts:381-404`, `server/src/rooms/service.ts:407-433`, `server/src/rooms/service.ts:437-455`

**Encoding:** folder/file presence: rooms/<name>/room.json, rooms/.trash/<dir>/{room.json,trash.json,layouts/}, layouts/@<name>/

**States:** live · trashed · restored (members pruned) · orphaned trash dir (no trash.json)

**Transitions:**
- live -> trashed on delete (move folder, move layouts, write trash.json)
- trashed -> live on restore (move, rm trash.json, move layouts, prune members)

**Risks:**
- A crash between the folder move (399) and the trash.json write (402) leaves a trash dir that trash() skips (416 requires trash.json): the room is invisible and unrestorable, and #inTrash no longer protects its name
- restore removes trash.json (444) before moving layouts; a crash in between leaves layouts/ inside the live room folder
- Members that joined another room or were deleted since are dropped on restore without notice (451)

**Crosses:** layouts/@<room>/ shared with routes/layouts.ts

> Verifier: Verified ordering and the trash.json requirement.

### [low] Render pipeline: name reservation, spend reservation, staged files on disk

*confirmed* · `server/src/scenes/render.ts:99`, `server/src/scenes/render.ts:115-125`, `server/src/scenes/render.ts:129-145`, `server/src/scenes/render.ts:147-202`, `server/src/scenes/render.ts:206-237`

**Encoding:** in-memory #reserved Set of names; spend reservation keyed by name; progress encoded by which of <name>-input.jpg, -raw.jpg, .<name>.aligned.jpg, <name>.jpg, <name>.json exist (.json is the completion sentinel)

**States:** reserved · spend-reserved · fal-called/billed · files staged (input/raw) · aligning · complete (.json written) · failed (name stays reserved)

**Transitions:**
- reserve name -> spend reserve (refused -> name released)
- -> fal call (502 on FalError) -> cost row appended -> download
- -> write input/raw -> align (applied: replace .jpg) -> write .jpg
- -> write .json -> name released from #reserved -> spend released (finally)

**Risks:**
- A failure after files are written (align spawn-error throws at render.ts:217) leaves <name>-input.jpg/-raw.jpg without .json; list() ignores them and the name stays in #reserved for the process lifetime, orphan files accumulate
- A process crash during #align leaves .<name>.aligned.jpg dotfiles (the finally removes them otherwise)
- Live path records cost before download; a download failure is billed with no render on disk (intended, visible only in costs.csv)

**Crosses:** SpendCap (server/src/spend.ts) shared with library jobs; planner polls GET /api/renders

> Verifier: Verified in render()/#make/#align.

### [low] nestedTooDeep JSON byte scanner (inString mode + depth counter)

*confirmed* · `server/src/library/json.ts:136-153`

**Encoding:** boolean inString, integer depth, index skip on backslash

**States:** outside-string · in-string · escape (skip next char)

**Transitions:**
- outside -> in-string on '"'
- in-string -> outside on unescaped '"'
- in-string -> skip next on '\\'
- depth++ on [ or {, depth-- on ] or }

**Risks:**
- Unbalanced closers drive depth negative so a later deeper nesting passes the 990 limit by the deficit; JSON.parse rejects such text right after (pyValueFromText), so no observable impact

> Verifier: A real (tiny) lexer state machine; risk has no practical impact.

### [low] SceneService rooms hook late binding

*confirmed* · `server/src/scenes/service.ts:134`, `server/src/scenes/service.ts:156-158`, `server/src/rooms/service.ts:139-145`, `server/src/scenes/shared.ts:20-37`

**Encoding:** nullable #rooms reference; scene objects carry `room` only once set

**States:** unbound (no room key, delete doesn't leave rooms) · bound

**Transitions:**
- unbound -> bound when RoomService is constructed

**Risks:**
- A SceneService built without a RoomService (tests, a future construction path) deletes scenes without updating room.json, leaving dangling members; scenesFor binds both synchronously today

**Crosses:** routes/* via scenesFor(deps)

> Verifier: Accurate; borderline trivial but it changes delete/restore and the scene object shape.

**Rejected by the verifier:**
- `zip-end-record`: Sequential parsing with fallback branches (tail EOCD, comment search, zip64) and a read cursor; no persistent mode variable or lifecycle. The Number() precision note is a parsing detail, not state.

## product

### [high] SizeWorker: shared off-thread size-reader worker and its job queue

*confirmed* · `server/src/product/sizes.ts:96-104`, `server/src/product/sizes.ts:195-199`, `server/src/product/sizes.ts:209-274`, `server/src/product/sizes.ts:276-282`, `server/src/product/size-worker.ts:6-19`, `server/src/product/read.ts:117`

**Encoding:** Nullable #worker handle, #jobs array doubling as in-flight + queued set (no running marker), monotonically increasing #next id, one setTimeout per job closed over in run(); restart semantics chosen by whether `failed` is passed to #restart; 200k-char threshold picks main thread vs worker.

**States:** no-worker (#worker null, #jobs empty) · idle (worker alive, #jobs empty) · busy (worker alive, head job running, others queued) · restarting-after-timeout (old worker terminating, fresh worker spawned, survivors re-posted) · failed (error event: worker null, all jobs rejected)

**Transitions:**
- no-worker -> busy on run() (lazy #start, postMessage)
- idle -> busy on run()
- busy -> busy on 'message' for a job id (resolved, spliced out)
- busy -> idle when last job resolved
- busy -> restarting-after-timeout when any job's timer fires: that job rejected, worker terminated, every other job re-posted to a fresh worker
- busy -> failed on worker 'error' (#restart(e) without failed): all jobs rejected, #worker = null
- failed -> busy on next run()

**Risks:**
- Timer starts at enqueue (sizes.ts:267), not at dequeue; the single module-level worker (sizes.ts:276) is shared by all concurrent product reads, so read B's job can time out while merely queued behind read A's large job; the timeout handler terminates the worker running A's job and re-posts A from scratch, and B gets 422 TOO_LONG it did not cause.
- #restart(e, failed) terminates whatever job is actually executing, which need not be `failed`; there is no running-job state to compare.
- Old worker's 'message'/'error' listeners are never removed after terminate() (sizes.ts:218-229, 238): a late 'error' from the terminated worker calls this.#restart(e), which reads this.#worker (now the NEW worker), terminates it and rejects every job of every request.
- No 'exit' handler: a worker that exits without an 'error' event leaves jobs pending until each one's own timer fires, then cascading restarts.
- Re-posted jobs keep their original timers (sizes.ts:249-250), so after a restart they get only the remainder of their budget for the redo.
- `loaded` is cached only on success; a missing build re-requires and throws on every call (no failed-to-load state).

**Crosses:** Driven by every concurrent POST /api/library/product request (dispatcher in server/src/http, outside this group); timeouts come from each request's Deadline.remaining().

> Verifier: All cited code matches. The listener-leak risk is real: the 'error' closure calls this.#restart, which acts on the current this.#worker, not on the worker that emitted the event.

### [high] Page/Driver SAX parser: tag stack with closers, skip/out counters, capture buffers, namespace stack

*corrected* · `server/src/product/html.ts:86-114`, `server/src/product/html.ts:133-170`, `server/src/product/html.ts:172-188`, `server/src/product/html.ts:190-223`, `server/src/product/html.ts:225-239`, `server/src/product/html.ts:241-279`, `server/src/product/html.ts:299-419`, `server/src/product/html.ts:424-438`

**Encoding:** Counters #skip/#out, nullable buffers #script/#title/#h1 meaning 'capturing', per-element closer lists undone on pop, a capture list, an open-microdata-item stack, a mutable base; in Driver a namespace stack, #foreign boolean, #skipNewLine, and direct writes to parse5 tokenizer.state/inForeignNode.

**States:** normal text · in script · in skipped element (#skip > 0) · in out-of-content block (#out > 0) · capturing title / h1 · capturing microdata property text · inside microdata item(s) · foreign content (svg/math) vs HTML (Driver) · raw-text tokenizer modes · stopped (ParseStopped: partial page, no close())

**Transitions:**
- start(tag) pushes [tag, closers] and enters script/skip/out/title/h1/capture/item as applicable
- end(tag) pops to the nearest matching tag among the last 64 entries, running closers
- stack > 4000 -> #pop(1, bottom=true) evicts the OLDEST entry and runs its closers
- Driver: <svg>/<math> start -> enter foreign ns; integration point -> enter HTML; </svg>, </math> or a breakout tag -> leave
- Driver: raw-text start tags switch tokenizer.state (HTML ns only)
- urljoin refusal (<base>, microdata src) -> stopped, page returned without close()

**Risks:**
- Self-closing <svg/> or <math/>: Driver.#enter runs (html.ts:350-351) but nothing leaves, because onEndTag is not called for a self-closing tag; Page meanwhile gets start+end('svg') (html.ts:374). Until the next breakout tag that foreignContent.causesExit recognises (div, p, span, b, img, table, ...; html.ts:353), <script>, <style> and <title> do not switch the tokenizer to raw text and CDATA is honoured, so inline JSON/script text containing '<' is tokenized as markup.
- Bottom eviction at depth 4000 runs the oldest entry's closers, but the 'item' closer does #openItems.pop() (html.ts:211), removing the innermost open item, not the evicted outer one.
- Bottom eviction of an outer header/nav/footer/aside decrements #out while its content is still open, so later block text goes to lines instead of outLines; evicted title/h1/capture closers finalize early.
- end() searches only the last 64 entries (html.ts:180): a </noscript>/</template>/</svg> whose open tag is deeper is ignored, leaving #skip > 0 and dropping all later visible text.
- #in('svg'/'template') inspects only the last 64 entries (html.ts:124), so an <img> deep inside a large svg/template is collected.
- Every <base href> rewrites base mid-parse (html.ts:137-138); microdata src values are joined against the base at that moment while <img> URLs are resolved later against the final base (extract.ts:240).
- On ParseStopped the page is returned without close() (html.ts:434-436): #cur not flushed, an open title/h1 never committed, open captures never filled.

> Verifier: Self-closing svg risk overstated: the Driver does not stay foreign for 'the rest of the page'; any later breakout tag (causesExit at html.ts:353) leaves the namespace. The mismatch window is bounded to the run up to the next such tag. Other risks verified.

### [medium] Product read pipeline with two overlapping clocks (Budget 20 s, Deadline 10 s) and exception-typed outcomes

*confirmed* · `server/src/product/route.ts:16-45`, `server/src/product/read.ts:28-53`, `server/src/product/read.ts:80-105`, `server/src/product/read.ts:109-123`, `server/src/product/errors.ts:40-74`, `server/src/product/extract.ts:74-113`, `server/src/product/extract.ts:126-148`, `server/src/product/extract.ts:163-399`, `server/src/product/pagefetch.ts:18-71`

**Encoding:** No phase variable: phase is the position in an async call chain. Deadline encodes not-started/running/expired as #at null vs timestamp; remaining() returns a magic 10_000 before start. Outcome encoded by which Error subclass escapes (ProductError, PageTimeout, WorkerTimeout, PyRaised, other). Warnings array mutated by every phase.

**States:** validating body · fetching page (Budget running, Deadline not started) · classifying response · parsing (Deadline running, tick per 64K chunk) · robot-check · reading feeds (Budget and Deadline both running) · extracting name/category/images · reading sizes · asking LLM (optional) · finishing (thickness, merge) · answered 200 · answered 4xx/422 by exception class

**Transitions:**
- validating -> answered 400 on bad shape
- validating -> fetching (url) or -> parsing (pasted html)
- fetching -> 422 TIMEOUT on PageTimeout; -> 400/422 ProductError on fetch failure kinds
- classifying -> 422 (blocked / 404 / not html / image)
- classifying -> parsing: deadline.start(10 s)
- parsing -> 422 TOO_LONG when tick() finds deadline passed
- robot-check -> 422 blocked
- reading feeds -> extracting (feed failures become warnings)
- extracting -> 422 'holds no product'
- reading sizes -> asking LLM only when no variant/candidate and llm flag
- any -> 422 COULD_NOT_READ on unexpected Error

**Risks:**
- deadline.start (read.ts:48) precedes readFeeds (read.ts:51): feed fetches bounded only by the 20 s Budget consume the 10 s extraction deadline, so slow-but-in-budget feeds make the next deadline.pause()/tick() in extract answer TOO_LONG.
- The LLM call is bounded by its own 60 s timeout (llm.ts:183), not by the Deadline; after it returns, extract.ts:380 deadline.tick() throws TOO_LONG, discarding a paid answer whose cost row was already appended (llm.ts:204).
- No cancellation: nothing in this group takes an AbortSignal, so a disconnected client does not stop the fetch, parse, worker jobs or the paid LLM call.
- Deadline.remaining() before start() returns 10_000 (errors.ts:51); no current caller precedes start(), but the order is not enforced.
- Outcome mapping relies on exception class identity; any other Error (e.g. a non-FalError from fal, the urlsplit/urljoin Errors at extract.ts:305 and images.ts:119) collapses into generic COULD_NOT_READ.

**Crosses:** Budget/safeFetch in server/src/fetch.ts; spend reservation in deps.spend; costs in common/costs.ts; the planner's product form reads the 4xx/422 bodies (blocked flag).

> Verifier: Verified start-before-feeds ordering and the post-LLM tick. Cancellation risk verified only within this group (route passes no signal).

### [medium] LLM layer: spend hold / call / cost row / release

*confirmed* · `server/src/product/llm.ts:156-217`, `server/src/product/llm.ts:139-142`, `server/src/product/extract.ts:357-378`

**Encoding:** Random hold key reserved in deps.spend, released in finally; asked/mock/cost fields of LlmResult encode which branch ran; the cost row is written between the call and the release.

**States:** skipped (no FAL_KEY) · refused (cap reservation refused) · reserved · preparing prompt (worker llm_text) · calling fal / reading mock fixture · recording cost · parsing answer · released

**Transitions:**
- start -> skipped when !mock && key null
- start -> refused when spend.reserve returns an error
- start -> reserved
- reserved -> preparing -> calling
- calling -> released with asked=true, cost 0 on FalError (no cost row)
- calling -> recording cost -> parsing -> released (finally)
- preparing -> released on WorkerTimeout (exception propagates)

**Risks:**
- If appendCost throws (llm.ts:204; it takes a lock and atomic-writes), the finally still releases the hold, so a real charge is neither held nor recorded and the daily cap under-counts.
- falCall's AbortSignal.timeout (common/fal.ts:128-131) surfaces as FalError 'could not reach fal', recorded as cost 0 with no row, though fal may have run and billed the call.
- The reservation is held across llmTextAsync's worker queue wait (llm.ts:170), which can be blocked behind other requests' jobs.
- A paid answer can be discarded by extract's post-LLM deadline.tick() (extract.ts:380) after its cost row is written.

**Crosses:** deps.spend (server/src/spend.ts daily cap), common/costs.ts and common/fal.ts; costs.csv read by other areas.

> Verifier: Confirmed; the timeout-billed risk is plausible rather than certain (depends on fal billing on client abort), grounded in fal.ts mapping AbortSignal.timeout to FalError.

### [low] Doc enrichment: parsed page, then feeds attached later (shopify/woo nullable fields)

*confirmed* · `server/src/product/doc.ts:96-137`, `server/src/product/extract.ts:126-148`, `server/src/product/extract.ts:151-155`, `server/src/product/read.ts:50-52`, `server/src/product/read.ts:100-104`

**Encoding:** Two nullable mutable fields on an otherwise readonly Doc; null means not applicable, feed failed, not read yet, or pasted (never read).

**States:** parsed (feeds not read) · feeds read: none found · feeds read: shopify and/or woo attached · pasted (feeds deliberately skipped)

**Transitions:**
- new Doc -> parsed
- parsed -> feeds read via readFeeds (fetched path only)
- parsed -> pasted (readPasted goes straight to extract)

**Risks:**
- null conflates not-read, failed and not-applicable; extract cannot tell a pasted Shopify page from a non-Shopify page (by v1 design, but invisible to extract).
- Order dependency is unenforced: anything reading doc.shopify/woo before readFeeds sees an unenriched doc (isRobotCheck does not read them today).

> Verifier: Accurate; low-impact, the second risk is latent.

### [low] Sizes accumulator: first-writer-wins shop variants and candidate layers

*corrected* · `server/src/product/layers.ts:15-38`, `server/src/product/layers.ts:122-129`, `server/src/product/layers.ts:293-310`, `server/src/product/layers.ts:316-352`, `server/src/product/layers.ts:145-243`, `server/src/product/layers.ts:365-427`, `server/src/product/extract.ts:333-354`

**Encoding:** sz.variants.length === 0 is the 'no shop options yet' state; precedence implied by call order in extract (shopify, woo, jsonld, microdata); Readings mutated in place (notes).

**States:** no variants · variants from shopify · variants from woocommerce · variants from jsonld · variants reordered by link · candidates only / text / llm

**Transitions:**
- no variants -> shopify (unconditional assignment)
- no variants -> woo / jsonld (guarded by length === 0)
- variants -> reordered by linkVariant when >= 2
- no readable variant and no cands -> text readings -> llm

**Risks:**
- shopifySizes assigns sz.variants without the length===0 guard (layers.ts:304); correct only because extract calls it first (extract.ts:335). Reordering would let Shopify clobber Woo/JSON-LD options.

> Verifier: Dropped two risks: (1) variant Readings come from their own parseSize calls and are never pushed to sz.cands, and finish() receives copies via wasm JSON, so linkVariant's note cannot leak into a candidate; (2) the throwaway Ctx in jsonldSizes (layers.ts:178) is called with warnUnitless=false as deliberate suppression, no concrete double-warning path shown.

### [low] Images: deduplicating picture registry with in-place upgrades and a cap

*confirmed* · `server/src/product/images.ts:93-158`, `server/src/product/extract.ts:240-309`

**Encoding:** List plus Map from host+path key to the same mutable ImageOut; MAX_IMAGES checked on entry; used set mutated only on first insert.

**States:** accepting (< 12) · full (12) · per key: absent / present (upgradable url,w,h)

**Transitions:**
- absent -> present on add (layer recorded in used)
- present -> present with larger/https copy
- accepting -> full at 12 (later adds return false before dedupe)

**Risks:**
- Once full, add returns at images.ts:131 before the dedupe/upgrade step, so a larger or https copy of an already-listed picture is not upgraded.
- An upgrade replaces url but w/h only when the new copy has them (images.ts:144-148), so w/h can describe the old copy.

> Verifier: Both risks visible in code.

### [low] pyLoads: iterative pushdown JSON parser (frame stack, wantValue, pending key)

*confirmed* · `server/src/product/logic/pyjson.ts:22-26`, `server/src/product/logic/pyjson.ts:140-216`, `server/src/product/logic/pyjson.ts:220-235`

**Encoding:** Frame stack with list/map as two nullable fields, key null/non-null for expecting key vs value, wantValue and done flags; two-try retry in loadsLenient.

**States:** expect value · expect key (object, key null) · expect comma or close · done

**Transitions:**
- expect value + '[' / '{' -> push frame
- expect value + scalar -> attach -> expect comma or close
- comma -> expect value (or key)
- close -> pop, attach to parent or done
- loadsLenient: first try fails -> retry without trailing commas -> null

**Risks:**
- attach() silently drops a value for a map frame with key === null (pyjson.ts attach); unreachable today since the key is always read first, but representable and would lose data rather than throw.
- Frame type permits list===null && map===null; never constructed.

> Verifier: Accurate as latent/representability issues; no live bug.

### [low] scriptStrings / literals: string-literal lexer and bounded walk

*corrected* · `server/src/product/scripts.ts:15-53`, `server/src/product/scripts.ts:78-129`

**Encoding:** Cursor i plus two cached indexOf results refreshed lazily; inline escape mode; walk stops via out.length > 400 and depth > 40 checked at entry.

**States:** seeking next quote · inside literal · after escape · literal closed / unterminated · walking parsed JSON · capped (out > 400)

**Transitions:**
- seek -> inside on nearest quote
- inside -> after escape on backslash -> inside
- inside -> closed on matching quote; -> unterminated on newline/end
- walk -> capped when out.length > 400 (entry only)

**Risks:**
- The 400 cap is checked only at walk entry (scripts.ts:92); take() can push many lines from one string past 400.
- literals(text) scans the whole script synchronously before the first deadline.pause() (scripts.ts:122), and loadsLenient on a large JSON script/string is synchronous (scripts.ts:97, 116), so these spans cannot be interrupted by the deadline.

> Verifier: Second risk restated precisely: the non-yielding spans are the full literals() scan and loadsLenient calls, not 'a literal list before the next pause'.

### [low] text_readings: line scanner with prev_line/prev_end context, lazy RestIndex, and singles grouping

*corrected* · `core/crates/product/src/text.rs:248-331`, `core/crates/product/src/text.rs:215-244`, `core/crates/product/src/text.rs:39-62`

**Encoding:** Loop-carried prev_line (Option), prev_end (advanced for chains of 2-3 and labelled singles), per-line Option<RestIndex>, running order counter, singles group flushed by a closure.

**States:** between lines · scanning a line · chain accepted / skipped · accumulating singles group · group flushed

**Transitions:**
- line without digits -> prev_line updated (if non-blank)
- chain >= 2 -> context computed, prev_end = end -> accepted or skipped
- labelled single -> singles.push
- single with repeated axis or line gap > 2 -> flush, start new
- end -> final flush, sort by (intro?, order)

**Risks:**
- prev_end is set before the distract/unitless checks (text.rs ~271, ~313), so a rejected chain still moves the context window for later chains on the line (v1 parity).
- group_singles measures the gap in raw line indices (s.0 - last.0 > 2), including digit-free lines; two or more non-size lines between table rows split one table into separate groups.

**Crosses:** Run through api::call from the server's SizeWorker / main thread (server/src/product/sizes.ts).

> Verifier: A single heading line between rows gives a gap of 2, which does not break the group; it takes at least two intervening lines.

### [low] Item finditer and chain accumulation (cur chain up to 3, unit spread, order-key axes)

*corrected* · `core/crates/product/src/item.rs:313-326`, `core/crates/product/src/item.rs:462-494`, `core/crates/product/src/item.rs:498-551`, `core/crates/product/src/item.rs:268-310`, `core/crates/product/src/item.rs:147-157`, `core/crates/product/src/item.rs:353-374`

**Encoding:** cur Vec as the open chain (empty = none), joined while len < 3 and JOIN matches the gap; ItemMatch with independent Option spans (ft/ftin vs num/to/unit).

**States:** no open chain · open chain (1-3 items) · chain closed · post-pass: unit applied / axes from order key

**Transitions:**
- item with joining gap and len < 3 -> append
- otherwise -> close current, open new
- end -> close
- post-pass: all-unitless chain >= 2 followed by a unit -> unit on every item, last.end extended
- post-pass: unlabelled chain within 16 chars of an equal-length key -> axes assigned

**Risks:**
- ItemMatch can represent ft/ftin and num set together; body() never does, but make_item (item.rs:359) silently prefers feet if both were set.

> Verifier: Dropped the 'unit word may also have started an item' risk: items start only at a digit/fraction or a label, and no concrete overlap with a unit word was shown.

### [low] thickness: first-found slots for 'thickness' vs 'pile'

*confirmed* · `core/crates/product/src/text.rs:475-531`

**Encoding:** Two Option slots filled first-wins; answer prefers thick over pile.

**States:** none · pile found · thickness found · both found

**Transitions:**
- key starting 'pile' -> fill pile if empty
- other -> fill thick if empty
- end -> thick or pile

**Risks:**
- A bare 'height' match (<= 5 cm, with a unit) fills the thick slot and outranks a later explicit 'pile height', since thick.or(pile) prefers thick.

> Verifier: Code matches; trivial two-slot machine.

### [low] finish: merged-candidate accumulator with in-place replacement and variant index lookup

*corrected* · `core/crates/product/src/merge.rs:55-120`

**Encoding:** merged Vec where a later reading can replace an earlier twin in place; variant_index computed afterwards with the tolerance predicate after truncation to MAX_CANDIDATES.

**States:** rug heights filled · merging · truncated · indexed

**Transitions:**
- no twin -> push
- twin, same source, metric over in/ft -> replace
- twin, same source, intro quote -> replace quote/label
- -> truncate -> variant_index by same()

**Risks:**
- same() is a tolerance: if option A's twin c was first merged from a different reading B, and c is later replaced by metric reading R (same(B,R) true), A may not be within tolerance of R, so A's dims_index becomes null or points at another candidate (position takes the first match).
- Truncation precedes the variant lookup, so an option whose twin was cut gets dims_index null (> MAX_CANDIDATES readings only).

**Crosses:** dims_index consumed by the planner's product form.

> Verifier: An option that is itself the replaced twin still matches the replacement (the same comparison), so the failure needs a third reading via non-transitive tolerance; risk narrowed accordingly.

### [low] py_ci regex translator (in_class mode) and LazyLock pattern statics

*confirmed* · `core/crates/product/src/words.rs:20-55`, `core/crates/product/src/words.rs:91-132`

**Encoding:** Boolean in_class toggled on '[' / ']' while rewriting; compile failure falls back to a never-matching regex.

**States:** outside class · inside class · after backslash

**Transitions:**
- '[' outside -> inside
- ']' inside -> outside
- '\\' -> consume next (\s expanded per mode)
- 'i'/'I' -> [iıİ] outside, iıİ inside

**Risks:**
- A class starting with a literal ']' closes the mode early, and an inline flag group like (?i: or a named group containing 'i' would be rewritten invalidly; Regex::new failure is swallowed into a never-matching regex (words.rs ~53), so a future pattern edit silently disables a word list (only unit tests guard it).

> Verifier: Latent; no current pattern triggers it.

### [low] OpenGraph image accumulator: 'current og:image' open until the next og:image

*found by verifier* · `server/src/product/extract.ts:266-274`

**Encoding:** The last element of the og array (og.at(-1)) is the implicit 'open' image; og:image:secure_url / width / height meta tags mutate whichever entry is last, with no explicit open/closed state.

**States:** no image open · image open (accepting secure_url/width/height)

**Transitions:**
- og:image or og:image:url -> push new entry (opens it)
- og:image:secure_url (https) / og:image:width / og:image:height -> mutate last entry
- end of metas -> all entries added to Images

**Risks:**
- width/height/secure_url tags are attached to whatever og:image came last in document order, even when they come from a later unrelated block (e.g. a second og:image set from a related-product widget, since metas are collected regardless of #out), so a picture can get another picture's dimensions or URL.
- A later og:image:width overwrites an earlier one on the same entry (no 'already set' guard), so duplicated meta blocks leave the last values.

**Rejected by the verifier:**
- `rust-make-reading-unit-fallback`: A bounded fallback list, not a stateful machine. The only risk named is hypothetical fragility: every hinted try overwrites unit_note before map_axes, and the None try only happens when tries=[None], so no current path yields a wrong note.

## pipeline

### [high] midstudy-add item build/commit lifecycle (staging -> item folder -> library.json -> costs.csv, or _failed/)

*corrected* · `pipeline/src/cli.ts:203-212`, `pipeline/src/cli.ts:214-239`, `pipeline/src/cli.ts:288`, `pipeline/src/cli.ts:293-303`, `pipeline/src/cli.ts:305-311`, `pipeline/src/cli.ts:312-323`, `pipeline/src/cli.ts:324-327`, `pipeline/src/cli.ts:329-339`, `pipeline/src/library.ts:81-100`, `common/files.ts:140-150 (move: rename, else cpSync+rm on EXDEV)`

**Encoding:** No phase value: progress is implied by the `committed` boolean, `fal` (null | Fal) plus `fal.charged`, membership of `staging` in the module-level `scratch` Set, presence/absence of the staging dir, of <lib>/<id>/ and of the id in library.json/costs.csv on disk, and the mutable `local`/`ext` locals that change meaning per step.

**States:** validated (pre-lock) · locked/staging-created · inputs-materialized · engine-done · normalized · old-raw-moved-into-staging (re-run on own raw) · old-item-removed · item-dir-committed (committed=true) · library-upserted · cost-recorded · failed-unpaid (staging deleted) · failed-paid (cost row + staging moved to _failed) · summary-printed

**Transitions:**
- validated -> locked/staging-created on locked(libDir) + mkdtemp
- staging -> inputs-materialized on download/objzip.toGlb/engineInput
- inputs -> engine-done on rug.build | runEngine | glb passthrough
- engine-done -> normalized on normalizeGlb/standInBox, splat.normalize, writeSpz, makeThumb
- normalized -> old-raw-moved-into-staging when itemDir/raw exists, staging/raw doesn't and the input lies inside itemDir
- -> old-item-removed on rmtreeChecked(itemDir)
- old-item-removed -> item-dir-committed on move(staging,itemDir); committed=true
- item-dir-committed -> library-upserted on upsert()
- library-upserted -> cost-recorded on appendCost()
- pre-commit error with fal live && charged -> failed-paid
- any other error -> failed-unpaid (finally rmtree)
- cost-recorded -> summary-printed (printSummary, strict validation)

**Risks:**
- Non-atomic replace: rmtreeChecked(itemDir) (cli.ts:299) precedes move(staging,itemDir) (cli.ts:301). move() falls back to cpSync+rm on EXDEV (common/files.ts:145-147), so if staging (os.tmpdir()) and the library are on different volumes a copy failure leaves the old item gone, a partial itemDir, and library.json still listing the item; the finally then deletes staging.
- The old raw/ outputs moved into staging (cli.ts:296-297) are lost by the finally (cli.ts:325) if the later move fails: the previous run's (possibly paid) engine outputs vanish.
- Once committed=true, an error in upsert (strict validate, atomic write) or appendCost is rethrown as-is (cli.ts:313): item folder with no library.json entry, or entry with no costs.csv row even for a live paid call.
- If appendCost throws inside the paid branch (cli.ts:317) the finally deletes staging, so the outputs the message promises to keep in _failed/ are lost and no cost row exists.
- printSummary runs after the try (cli.ts:329); in strict mode a schema violation exits 1 after the item and cost row are committed, so a successful add is reported as failure.

**Crosses:** The server's add job spawns midstudy-add and reads its stdout/exit code; library.json and costs.csv are shared with the server under common/lock.ts (library lock, costs lock).

> Verifier: States/transitions confirmed in cli.ts. Added the old-raw retention step and its loss risk (cli.ts:294-298 + finally). Made the EXDEV condition explicit via common/files.ts move(). Dropped the `local`/`ext`/sourceName risk: sourceName = source<pre-zip ext> is intentional (source.zip keeps the original) and nothing reads it out of phase.

### [high] Paid-call accounting (Fal.charged)

*confirmed* · `pipeline/src/fal.ts:28-35`, `pipeline/src/fal.ts:72, 155`, `pipeline/src/fal.ts:377-400`, `pipeline/src/cli.ts:313`

**Encoding:** A public mutable boolean on the client object, flipped by the free function run() after the retry ladder, not by the client when a billable job completes.

**States:** not-called · call-in-flight (submitted) · completed on fal (billed) · charged=true (known locally)

**Transitions:**
- not-called -> call-in-flight on fal.call submit
- call-in-flight -> completed when status is COMPLETED
- completed -> charged=true only when call() returns its JSON and run() reaches fal.ts:400

**Risks:**
- Job completes on fal (billed) but the result GET (fal.ts:316) fails (non-retryable HTTP error, transport errors exhausted, or JSON parse): call() throws MidstudyError, charged stays false, cli.ts:313 treats it as unpaid: no cost row, staging deleted, nothing kept for a free --engine glb retry.
- SIGINT/SIGTERM while awaiting the queue poll: cleanUp() (cli.ts:485-489) removes staging and exits; the live job is billed with no costs.csv row.

**Crosses:** costs.csv (common/costs.ts) feeds the server's daily-spend guard; a missing row understates spend.

> Verifier: Both risks traced in code. Dropped the 'anyone can set charged / MockFal carries it' remark: cli.ts:313 checks fal.mock first, so it has no effect.

### [medium] Live fal queue job (submit -> poll with logs -> poll -> result)

*corrected* · `pipeline/src/fal.ts:287-324`, `pipeline/src/fal.ts:299-315`, `pipeline/src/library.ts:36-45`, `common/lock.ts:39 (LOCK_STALE_MS 3600 s)`, `common/logic/lock.ts:49-54 (too-old verdict even for a live owner)`

**Encoding:** Remote status string re-read each poll inside nested loops; the phase is the loop variable `withLogs`.

**States:** submitting · IN_QUEUE · IN_PROGRESS · COMPLETED (logs phase) · final-poll · fetching-result · done · error

**Transitions:**
- submitting -> IN_QUEUE/IN_PROGRESS on POST (with retries)
- IN_QUEUE -> IN_PROGRESS -> COMPLETED on polls (100 ms sleep)
- COMPLETED -> final-poll (withLogs=false) -> fetching-result -> done
- unknown status -> error (wrapped as MidstudyError 'fal call to <ep> failed (ValueError: Unknown status: X)')

**Risks:**
- No deadline: a job stuck IN_QUEUE/IN_PROGRESS polls forever while holding the library lock. The server waits 60 s then answers 503 (common/lock.ts:243-244); another midstudy-add (waitMs null) waits until the lock is 3600 s old, then reclaims it as 'too-old' although this process is alive (common/logic/lock.ts:52), giving two concurrent library writers.
- The submit POST goes through #request, which retries transport errors (including the 120 s AbortSignal timeout) and 408/409/429: a submit fal accepted but answered slowly can be enqueued twice; both are billed, one is recorded.

**Crosses:** Holds the library lock shared with the server (common/lock.ts).

> Verifier: 'Other writers wait forever' was wrong: the server's lock wait is 60 s (503), and a waiting midstudy-add reclaims after 3600 s as too-old, which is the worse outcome. The 'unexpected ValueError' claim was wrong: call()'s catch (fal.ts:317-322) wraps it as a MidstudyError. Duplicate-submit risk restated: transport/timeout retries are the main path.

### [medium] HTTP retry/backoff with backup-domain fallback

*confirmed* · `pipeline/src/fal.ts:169-190`, `pipeline/src/fal.ts:192-203`

**Encoding:** Loop counter `attempt` plus nullable `res`/`error` whose combination encodes success / retryable status / transport error; backup host chosen inside a catch.

**States:** attempt-n primary · attempt-n backup host · retry-wait · ok · failed (http) · failed (transport)

**Transitions:**
- primary -> ok on 2xx
- primary throws -> backup host (fal.run / queue.fal.run only)
- retryable non-2xx or transport error && attempt<10 -> retry-wait -> attempt n+1
- non-retryable or attempt>=10 -> failed

**Risks:**
- One AbortSignal.timeout (fal.ts:193) is reused for the backup request (fal.ts:201): when the primary failed by timing out the signal is already aborted, so the backup fails at once.
- Non-idempotent POSTs (queue submit, storage initiate) are retried (see fal-queue-job).
- Up to 20 requests per #request (primary+backup per attempt).

> Verifier: Code matches exactly.

### [medium] --rescale refit: multi-file in-place replace then library upsert

*confirmed* · `pipeline/src/cli.ts:437-464`, `pipeline/src/cli.ts:466-480`

**Encoding:** Statement order only; files replaced one by one with no record of which were swapped.

**States:** staging · model.glb replaced · splat.ply replaced · splat.spz replaced · library.json updated

**Transitions:**
- staging -> model.glb replaced -> splat.ply replaced -> splat.spz replaced (replace())
- -> library.json updated via upsert()

**Risks:**
- If replace() of splat.ply/splat.spz fails after model.glb was replaced, or upsert fails (strict validation), the files are refit while library.json keeps the old dims_cm/fit.
- A SIGINT during upsert's await (strict-mode dynamic import of validate.js) after the replaces leaves the same mismatch; cleanUp has nothing to roll back.
- A later --rescale --yaw then applies yaw relative to partly rotated files (model rotated, splat not).

**Crosses:** library.json and item assets are served to the planner.

> Verifier: Confirmed; added the signal-after-replace window.

### [medium] Interrupt/cleanup lifecycle (scratch set, tick() interrupt points, SIGINT/SIGTERM)

*confirmed* · `pipeline/src/cli.ts:38-48`, `pipeline/src/cli.ts:484-489`, `pipeline/src/cli.ts:492-503`, `common/lock.ts:229`

**Encoding:** Module-level Set of staging paths whose membership means 'delete on interrupt'; interrupt points exist only at awaits.

**States:** running (no scratch) · running (scratch registered) · committed (scratch removed) · interrupted -> cleaned -> exit 130 / re-killed by SIGTERM

**Transitions:**
- mkdtemp -> scratch.add
- move to itemDir/_failed -> scratch.delete
- signal at an await -> cleanUp() -> exit

**Risks:**
- A signal at the awaits after commit (upsert's strict validate import, appendCost's costs lock wait, printSummary's validate) leaves an item folder without library entry or cost row.
- A signal while awaiting a live fal call deletes staging and exits with no cost row although the job is billed.
- process.exit(130) bypasses finally blocks; correctness relies on scratch matching the finally logic.

**Crosses:** Releases locks via common/lock.ts that the server also takes; the server's add job sees exit 130.

> Verifier: Confirmed by cli.ts. Signals are only observed between event-loop turns, so the synchronous rmtree/move window cannot be interrupted.

### [medium] PLY header parse and column-index cache during splat fit

*corrected* · `core/crates/splat/src/ply.rs:288-401`, `core/crates/splat/src/ply.rs:403-405`, `core/crates/splat/src/ply.rs:420-437`, `core/crates/splat/src/fit.rs:133-134`, `core/crates/splat/src/fit.rs:226-249`

**Encoding:** Header: `in_vertex` bool + count with break on the next element. Fit: column indices cached as usizes while props/columns are mutated by drop_props.

**States:** before-vertex · in-vertex · after-vertex (stop) · read · normals dropped · ix cached · f_rest dropped · written

**Transitions:**
- element vertex -> in-vertex
- next element -> stop
- read -> drop nx/ny/nz -> cache ix -> transform -> drop f_rest_* (if rotated||stretched) -> to_bytes -> self-check via ix

**Risks:**
- Stale indices: ix (fit.rs:134) is computed before drop_props(f_rest_*) (fit.rs:231) and used after it (fit.rs:244-245). With any f_rest_* before x/y/z, columns[ix[k]] names another property or is out of range (panic -> wasm trap), so the self-check extent/finite flags describe wrong data. Standard 3DGS PLYs list x,y,z first, so this is latent.
- find() takes the first 'end_header' bytes anywhere (ply.rs:289), including inside a comment line.

**Crosses:** Driven from pipeline/src/splat.ts via core/js/pipeline.ts splatNormalize; lo/hi/finite feed the TS self-check.

> Verifier: Stale-index bug confirmed. Noted it only bites non-standard property orders. Dropped the columns/props length 'invariant' remark (no defect).

### [medium] Library snapshot held across a long locked run (lock ownership vs too-old reclaim)

*found by verifier* · `pipeline/src/cli.ts:178 (locked(libDir, add))`, `pipeline/src/cli.ts:197 (data = load(libDir) at start)`, `pipeline/src/cli.ts:309 (upsert(libDir, data, item) after the engine run)`, `pipeline/src/cli.ts:374, 401, 479 (rescale: same pattern)`, `pipeline/src/library.ts:36-45 (waitMs null)`, `common/logic/lock.ts:49-54 (too-old after 3600 s regardless of owner liveness)`, `common/lock.ts:198-212 (release skips a lock whose owner changed)`

**Encoding:** An implicit 'I own the library' state: the lock folder's owner.json plus an in-memory library.json snapshot loaded at the start of the critical section, with no check that ownership still holds when writing.

**States:** waiting · held (snapshot fresh) · held but too-old (reclaimable by others) · reclaimed by another writer (snapshot stale, this process still writing) · released / release skipped

**Transitions:**
- waiting -> held on mkdir .lock.d; load() snapshot
- held -> held-too-old after 3600 s (e.g. a stuck live fal poll)
- held-too-old -> reclaimed when the server or another midstudy-add judges it 'too-old'
- held/reclaimed -> upsert writes the stale snapshot
- -> release (skipped silently when owner.json is no longer ours)

**Risks:**
- A live run longer than 3600 s loses the lock to another writer while it keeps going; its upsert then writes library.json from the snapshot loaded at cli.ts:197, losing items the server added or deleted in between. Release sees a different owner and returns silently, so nothing reports the conflict.

**Crosses:** common/lock.ts protocol shared with the server's library writes (uploads, deletes, trash).

### [low] CDN upload token cache and CDN -> storage fallback chain

*corrected* · `pipeline/src/fal.ts:159`, `pipeline/src/fal.ts:224-246`, `pipeline/src/fal.ts:249-284`

**Encoding:** Nullable cached token with expiry timestamp; fallback selected by a bare `catch {}`.

**States:** no-token · token-valid · token-expired · uploading-cdn · uploading-storage-fallback · uploaded · failed

**Transitions:**
- no-token/expired -> token-valid on POST /storage/auth/token (failure here fails the upload, no fallback)
- token-valid -> uploading-cdn
- uploading-cdn any error -> uploading-storage-fallback
- fallback -> uploaded | failed

**Risks:**
- A token rejected while still locally unexpired (clock skew, revocation) is never invalidated, so the next upload in the run (the SAM 3D mask) repeats the failing CDN attempt before falling back; an expired token is refetched since #cdnToken checks Date.now() < expires.
- The bare catch (fal.ts:265) also hides programming/protocol errors (missing access_url) behind the fallback.

> Verifier: The 'every later upload repeats the failure' claim only holds for a token rejected before its local expiry; a truly expired token is refetched. At most two uploads per run (image, mask).

### [low] SAM 3D 'no masks' retry ladder and mock no-mask countdown

*corrected* · `pipeline/src/fal.ts:371-399`, `pipeline/src/fal.ts:75-100`, `pipeline/src/fal.ts:74, 95, 111-113`

**Encoding:** Loop index `attempt` plus progressively rewritten `args`; nullable `resp`; MockFal keeps an implicit last-called slug and a countdown integer.

**States:** try-plain · try-threshold · try-mask (mask.png written, uploaded) · answered · gave-up

**Transitions:**
- try-plain NoMasks -> try-threshold
- try-threshold NoMasks -> try-mask
- try-mask NoMasks -> gave-up (MidstudyError)
- any try returns -> answered (charged=true)
- non-NoMasks error -> propagated; NoMasks from a non-sam3d engine -> MidstudyError

**Risks:**
- MockFal.fetch resolves files from #slug, the endpoint of the latest call(): correctness depends on fetch always following its own call (true in run() today; mock-only).

> Verifier: Ladder confirmed. Dropped the null-resp risk: every loop exit either sets resp or throws, so the NoneType branch is unreachable by construction. The slug risk is mock-only with no current misuse.

### [low] JPEG marker/segment walker (pre-frame -> frame -> scans -> EOI)

*confirmed* · `core/crates/imaging/src/jpeg/decode.rs:331-363`, `core/crates/imaging/src/jpeg/decode.rs:374-465`, `core/crates/imaging/src/jpeg/decode.rs:467-545`, `core/crates/imaging/src/jpeg/decode.rs:279-293`, `core/crates/imaging/src/jpeg/decode.rs:629-636`

**Encoding:** Option<Frame> + scans counter + header_only flag + Option fields with first-wins (exif) or last-wins (xmp, adobe) semantics + a Vec of ICC chunks consumed at SOF.

**States:** SOI · pre-frame · frame-seen · in-scans · EOI · EOF

**Transitions:**
- SOI -> pre-frame on segments
- pre-frame -> frame-seen on SOF0-2 (icc_chunks -> icc)
- frame-seen -> in-scans on SOS (or Ok if header_only)
- in-scans -> in-scans on DHT/DQT/DRI/SOS
- any -> EOI on FFD9 (Ok only if scans>0)
- EOF -> Ok if scans>0 && !header_only, Truncated if frame, else NoFrame

**Risks:**
- checkImage uses the header-only probe (stops at first SOS), so broken scan data is only found in engineInput, inside the lock and staging, reported as 'unexpected error' rather than the not-an-image sentence (still before any paid call).
- ICC chunks after SOF are ignored (guard frame.is_none(), decode.rs:440) and a chunk-count mismatch drops the whole profile (decode.rs:285).
- EXIF keeps the first APP1 (decode.rs:428) while XMP and Adobe keep the last.

**Crosses:** Decides what pipeline/src/images.ts checkImage/engineInput report.

> Verifier: All cited in code. Likely mirrors Pillow/libjpeg (lazy Image.open), so these are low.

### [low] Entropy-coded bit reader with marker/EOF zero-fill and restart resync

*corrected* · `core/crates/imaging/src/jpeg/decode.rs:114-256`, `core/crates/imaging/src/jpeg/decode.rs:667-675`, `core/crates/imaging/src/jpeg/decode.rs:722-735`

**Encoding:** Byte-level mode spread over `marker: Option<u8>`, `eof: bool` and `pad: u32`.

**States:** streaming · marker-seen (zeros fed) · eof (zeros fed, pad counted) · restart-resync

**Transitions:**
- streaming -> marker-seen on FF xx (xx != 0)
- streaming -> eof when data ends
- any -> restart-resync at an interval boundary (acc/n/pad cleared)
- restart-resync -> streaming on RSTn; -> marker-seen on another marker; -> eof on none (then overran -> Truncated)

**Risks:**
- RST sequence numbers are never checked (decode.rs:670 only filters D0-D7): a missing or extra RSTn misaligns following MCUs silently.
- A non-RST marker at a restart boundary (or an EOI mid-scan) turns the rest of the scan into zero coefficients with no error, since marker-fed zeros are not counted in pad.

> Verifier: Dropped the pad/overran risk: pad and n are reset together at restart and eof-at-restart correctly yields Truncated via overran(). Added the mid-scan EOI case to risk 2.

### [low] Progressive JPEG spectral-selection / successive-approximation state

*corrected* · `core/crates/imaging/src/jpeg/decode.rs:637-666`, `core/crates/imaging/src/jpeg/decode.rs:701-718`, `core/crates/imaging/src/jpeg/decode.rs:845-956`

**Encoding:** Coefficient arrays accumulated across scans; per-scan locals (ss, se, ah, al, eobrun, pred); no per-coefficient record of decoded bits.

**States:** no DC · DC first done · DC refined · AC band first done · AC band refined

**Transitions:**
- DC first scan sets block[0]
- DC refine ORs a bit
- AC first/refine per band with eobrun across blocks
- eobrun reset at restart

**Risks:**
- No coef_bits tracking (grep finds none): a refinement scan before its first scan, or a repeated first scan, is accepted and yields wrong coefficients instead of an error/warning.

> Verifier: Dropped the speculative eobrun-reset risk (no defect cited).

**Rejected by the verifier:**
- `image-orientation-metadata`: A data record, not a lifecycle. upright() is called once per op (ops.rs:78,132,280,347) and the engine input is written without EXIF, so makeThumb on it cannot rotate twice. has_alpha's 'P with transparency' matches the documented v1 test (image.rs:70). Palette loss in resize has no caller. Risks are hypothetical.
- `png-encoder-lifecycle`: A straight-line call sequence with no held state; the swallowed write_image_data error needs data that doesn't match the size, which the callers never build (documented in the # Panics note). reader.finish() is ignored on purpose (comment at formats.rs:132). It's error handling, not a state machine.
- `wasm-envelope-cursor`: A positional serialization format with a read cursor, not a state machine; the lazy `loaded` singleton (pipeline.ts:37-47) is a trivial init-once cache. The field-order drift concern is a schema/contract issue, not state.
- `argparse-cursor`: Pure two-pass parser certified by TScert. kinds[] and the second pass index the same argv, so they cannot desync; the `--name -- x` error is intended argparse behaviour. No real risk.

## kernels

### [medium] Planner wasm kernel load lifecycle (loadKernels / loadKernelsSync)

*confirmed* · `core/js/web.ts:68-69 (module-level `exports`, `loading`)`, `core/js/web.ts:73-79 (loadKernels: `loading ??=`, reset to null on failure)`, `core/js/web.ts:82-88 (loadKernelsSync: early return, throws while async load in flight, sets loading = Promise.resolve())`, `core/js/web.ts:90-97 (kernelsLoaded / memory() guard)`

**Encoding:** Two nullable module globals: `exports: InitOutput | null` and `loading: Promise<void> | null`. The pair gives the mode: unloaded (null, null), loading (null, pending), loaded (set, resolved), and failed, which goes back to (null, null) through the rejection handler.

**States:** unloaded · loading-async · loaded · failed (indistinguishable from unloaded)

**Transitions:**
- unloaded -> loading-async on loadKernels(source)
- loading-async -> loaded when init() resolves (exports = e)
- loading-async -> unloaded/failed when init() rejects (loading = null, rethrow)
- unloaded -> loaded on loadKernelsSync(source) (initSync, loading = Promise.resolve())
- loading-async -> throw on loadKernelsSync (refused, no transition)
- loaded -> loaded on any further loadKernels/loadKernelsSync (no-op)

**Risks:**
- A second concurrent loadKernels(source2) gets the first call's promise and ignores source2 (web.ts:74 `loading ??=`). For example, the worker entry's early loadKernels() (planner/engine.worker.ts:13) fixes the source before serveKernels(port, source) can supply one.
- Failure is not a state of its own. After a rejection the module looks exactly like 'never loaded'; kernelsLoaded() and memory() cannot report the last error.
- loadKernelsSync throws while an async load is in flight (web.ts:85) instead of waiting, so a realm that mixes the two paths gets an exception that depends on timing.
- The SceneCamera constructor calls memory() (web.ts:134) to throw a clear error before load, but the module-level wrappers (clampCamera, boxCorners, rotateSh, dragMove, etc., web.ts:275-374) call wasm.* directly. Before load they fail inside the glue on an undefined `wasm` with a TypeError instead of 'call loadKernels() first'.

**Crosses:** Driven by planner/engine.ts:304 (kernelsReady = loadKernels()), planner/engine.worker.ts:13, planner/gpu/demo, and by Node tests and scripts/wasm-smoke.mjs through loadKernelsSync. The planner reads kernelsLoaded() (engine.ts:484).

> Verifier: Every risk is in the code as cited. The glue's own init is idempotent (`if (wasm !== undefined) return wasm`, build/wasm/web glue:1169/1189), so a double instance is not possible. The source-ignoring risk is concrete: engine.worker.ts starts a default-source load before serveKernels runs.

### [medium] Kernel worker server's lazy-load latch (serveKernels `ready`)

*corrected* · `core/js/web.ts:552-568 (serveKernels: `let ready: Promise<void> | null = null`, `ready ??= loadKernels(source)`)`, `core/js/web.ts:528-548 (run: per-op dispatch)`, `planner/engine.worker.ts:13-14 (early loadKernels().catch(), then serveKernels(port))`

**Encoding:** A closure-local nullable promise latch, `ready`. It keeps the first loadKernels() promise for good, a rejected one included. It sits on top of the module-level `loading` latch, which resets itself on failure.

**States:** not-started (ready null) · loading (ready pending; may be the worker's early load) · ready (resolved) · poisoned (ready rejected)

**Transitions:**
- not-started -> loading on the first well-formed request
- loading -> ready when the wasm loads
- loading -> poisoned when the wasm load rejects
- poisoned -> poisoned on every later request (each answered {ok:false})
- malformed request -> error reply, no state change

**Risks:**
- Stuck failure. engine.worker.ts:13 notes that 'a failed early load is retried by the first request', but that retry happens only when the early load has already failed before the first request. If the first request arrives while the early load is in flight and that load then fails, or the first request's own retry fails, `ready` keeps the rejected promise. Every later decodeDepth/keepRoomMask/envMap then replies ok:false until the Worker is recreated. The planner's caller (engine.ts:327-335 inWorker) catches this and decodes on the main thread each time, so the effect is a silent permanent fallback rather than broken output.
- Requests run concurrently once ready, and envMapFromImage awaits createImageBitmap, so replies can arrive out of order. This is correct only because KernelWorker matches replies by id.

**Crosses:** planner/engine.worker.ts calls serveKernels(port). KernelWorker on the main thread consumes the replies; in the planner today only depth decoding goes through it (engine.ts:1617).

> Verifier: The latch and the poisoning are real (web.ts:561). I corrected how it fails: the worker entry's early load (engine.worker.ts:13) is the retry path the comment counts on, and the poisoning happens when a request overlaps a failing load. I lowered severity to medium because engine.ts inWorker falls back to the main thread on any ok:false. I dropped the 'nothing bounds concurrency' wording because there is no queue to bound.

### [medium] KernelWorker request/reply correlation (pending map + id counter)

*corrected* · `core/js/web.ts:590-607 (#port, #next counter, #pending Map, message listener)`, `core/js/web.ts:609-615 (#call: id allocation, pending.set, postMessage inside the Promise executor)`, `core/js/web.ts:617-648 (op wrappers that check r.op)`, `core/js/web.ts:570-587 (parseReply)`, `planner/engine.ts:307-335 (worker()/inWorker: workerDown race and main-thread fallback)`

**Encoding:** A monotonically increasing `#next` id plus a Map<id, {resolve, reject}> of in-flight requests. A request is pending while its id is in the map and settled once the entry is deleted.

**States:** idle (map empty) · in-flight (id in #pending) · settled-ok · settled-error (worker sent ok:false) · settled-malformed · orphaned (never settles)

**Transitions:**
- idle/in-flight -> in-flight on #call (id = #next++, pending.set, postMessage)
- in-flight -> settled-ok on a well-formed reply with the matching id
- in-flight -> settled-error on {ok:false} with the id
- in-flight -> settled-malformed on an unparsable reply that still carries the id
- in-flight -> orphaned when the worker dies, posts a reply without an id, or messageerror fires

**Risks:**
- KernelWorker has no error, messageerror, timeout or dispose path (KernelPort only types 'message'). The planner races each call against a Worker 'error' promise (engine.ts:313-316, 331), so a crash falls back to the main thread, but the orphaned entries stay in #pending for good. A 'messageerror' (an undeserializable reply) is handled by neither side, so loadDepth's await never settles.
- postMessage runs inside the Promise executor after pending.set (web.ts:612-613). If it throws (DataCloneError, or an already-detached ArrayBuffer), the promise rejects but its id stays in #pending.
- A malformed reply without a numeric id is looked up under -1 (web.ts:599-601) and dropped, so the request it answered never settles.

**Crosses:** The main-thread planner awaits these promises (engine.ts loadDepth through inWorker). The state is shared with the worker side, serveKernels.

> Verifier: The correlation map and the leaks are real. I dropped the 'two KernelWorker instances on one port' risk because engine.ts worker() creates exactly one and reuses it. I dropped the 'retry cannot resend the detached buffer' risk because the only caller keeps a copy for its fallback (engine.ts:1616 `const copy = bytes.slice()`). I lowered severity to medium because the planner's workerDown race covers worker crashes.

### [medium] Media envelope wire protocol (positional Writer/Reader/Payload cursor)

*corrected* · `core/crates/wasm-node/src/wire.rs:8-50 (Writer: tag byte, then positional u32/u64/rest)`, `core/crates/wasm-node/src/wire.rs:53-63 (error envelope: tag 1, offset, code length, code, message)`, `core/crates/wasm-node/src/wire.rs:67-98 (Reader cursor for packed zip entries)`, `core/crates/wasm-node/src/api.rs:48-61 (pieces: NO_OFFSET sentinel marks own bytes)`, `core/crates/wasm-node/src/api.rs:222-260 (glb_strip field order)`, `core/crates/wasm-node/src/api.rs:461-470 (zip_plan reader loop until done())`, `core/js/node.ts:97-149 (Payload cursor #at, pieces() with NO_OFFSET)`, `core/js/node.ts:168-176 (decode: tag 0 means ok, anything else is read as an error)`, `core/js/node.ts:376-394 (stripGlb reads fields, then p.rest() as the GLB)`, `core/js/node.ts:582-604 (zipPlan packing and decode)`, `core/js/node.ts:60-72 (lazy module load latch `loaded`)`

**Encoding:** A mutable cursor (#at in Payload, `at` in Reader) walks an untyped byte envelope whose field order is fixed only by matching code on the two sides. The tag byte selects ok or error. 0xFFFFFFFF is an in-band sentinel for both 'no offset' and 'own bytes follow'. The module load is a nullable `loaded` latch.

**States:** envelope: tag-read · envelope: reading fixed fields (cursor advancing) · envelope: rest (tail bytes) · error envelope · loader: unloaded / loaded

**Transitions:**
- tag 0 -> fixed fields -> pieces/rest
- tag != 0 -> error parse (offset, code, message)
- Reader: not done -> read_entry -> not done/done, or bad-input on a short read
- loader: unloaded -> loaded on the first raw() call (a failed require or isRaw check stays unloaded and retries)

**Risks:**
- Positional drift. If api.rs adds, removes or reorders a field (in glb_strip's per-image record, say) without node.ts changing too, Payload reads the wrong values. stripGlb then returns p.rest() as the GLB bytes with a corrupt prefix, and the pipeline writes that as model.glb. Neither side carries a version or length check.
- decode() treats any tag other than 0 as an error envelope (node.ts:169). A garbled tag parses as an error with an arbitrary code and throws 'unknown code' instead of reporting a protocol fault.
- Payload has no bounds checks. A short envelope throws a DataView RangeError from u32(), and bytes() silently returns a short subarray, so the caller gets an exception or truncated data instead of a Result.
- zipPlan's local bad-input error reports `offset: parts.length` (node.ts:588), which is 6× the entry index, not the entry index the codes document.

**Crosses:** Written by core/crates/wasm-node (Rust) and read by core/js/node.ts. Used by server/ (render.ts: decodeImageDataUri, jpegFrame, pngSize, stripJpeg; static routes, Host checks) and pipeline/src/glb.ts (stripGlb).

> Verifier: I dropped the native NO_OFFSET collision risk because node.ts only ever loads the wasm32 build (WASM_MODULE, node.ts:58), where Writer.size is exact. I added that Payload.bytes() truncates silently. The other risks are in the code as cited.

### [low] SceneCamera wasm handle lifecycle and scratch-view cache

*corrected* · `core/js/web.ts:123 (cameraRegistry FinalizationRegistry)`, `core/js/web.ts:130-131 (#cam: wasm.Camera | null, #view: Float64Array | null)`, `core/js/web.ts:133-140 (constructor registers)`, `core/js/web.ts:143-149 (dispose: unregister, free, null both)`, `core/js/web.ts:151-163 (#c guard; #s re-creates the view when its length is not 32, after memory growth detaches it)`, `core/crates/wasm-web/src/lib.rs:112-149 (Camera with inline `out: [f64; SCRATCH]`, outPtr)`

**Encoding:** A nullable #cam handle (live or disposed) and a nullable cached #view whose validity is inferred from `length === 32`; a detached buffer reads as length 0. The GC also frees the handle through the FinalizationRegistry.

**States:** live (view not built) · live (view valid) · live (view stale after memory.grow) · disposed

**Transitions:**
- new -> live on the constructor
- live -> live(view valid) on the first #s()
- live(view valid) -> live(view stale) when a wasm allocation grows memory (F64Buf, the &[f64] argument copies in landingSpot, decodeDepth, envMap)
- live(view stale) -> live(view valid) on the next #s() (re-created)
- live -> disposed on dispose() or by the GC through cameraRegistry
- disposed -> throw on any method (#c guard)

**Risks:**
- The view's validity is inferred from a length check, so it is only valid if no wasm allocation happens between #s() and its use. Today every method reads #s() after its wasm call. landingSpot depends on this: its f64s(...) arguments are malloc'd into wasm memory and can grow it before the vec3(this.#s()) read. #putItem writes through `s` and then makes a non-allocating call. Reordering any of these would read or write a detached buffer.

**Crosses:** The planner creates a SceneCamera per camera change and disposes it (planner/engine*.ts). It observes the disposed state as thrown errors.

> Verifier: The lifecycle and the cache are real. I dropped the FinalizationRegistry/double-free risk: web.ts's registry holds the wasm.Camera strongly, so wasm-bindgen's own CameraFinalization cannot fire first, and wasm.Camera.free() unregisters it (glue lines 7-15). I lowered severity to low because the only remaining risk is latent ordering.

### [low] Camera scratch slot protocol (inputs vs outputs share one 32-f64 buffer)

*confirmed* · `core/crates/wasm-web/src/lib.rs:114-117 (Camera.out scratch)`, `core/crates/wasm-web/src/lib.rs:157-166 (rotation/put write outputs into scratch[0..n])`, `core/crates/wasm-web/src/lib.rs:238-253 (screenRect reads the item from scratch[0..10], then overwrites scratch[0..4] with the rect)`, `core/crates/wasm-web/src/lib.rs:258-271 (hitBox reads the item from scratch[0..10] and the view from [10..13])`, `core/js/web.ts:226-257 (#putItem / hitBox fill the scratch before each call)`

**Encoding:** Each scratch region has an implicit phase. After #putItem, slots 0..10 hold item inputs (and 10..13 the view, for hitBox). After any call they hold that call's outputs, which partly overwrite the inputs. Nothing marks which phase the buffer is in.

**States:** empty/stale · item-inputs-loaded (0..10, optionally view at 10..13) · outputs-of-last-call (prefix overwritten; tail stale from earlier calls)

**Transitions:**
- any -> item-inputs-loaded on TS #putItem (+ view slots for hitBox)
- item-inputs-loaded -> outputs on screenRect (slots 0..3 become the rect; 4..9 keep the old item)
- item-inputs-loaded -> item-inputs-loaded on hitBox (reads only; returns an i32)
- any -> outputs on rotation/project/ray/photoToFloor/landingSpot/planePointAt (writes 9, 3, 6 or 3 slots)

**Risks:**
- Calling screenRect or hitBox after any other output-writing call, without re-running #putItem, reads the previous outputs as pose and box and gives a silently wrong rect or hit. The TS face always re-puts, so this is latent for any other caller of the raw wasm Camera.
- put() writes only as many slots as the result has (lib.rs:160-164), so reading past that length returns stale values from an earlier call instead of an error.
- photoToFloor/planePointAt return false and leave the scratch unchanged; the TS face relies on checking the boolean first (web.ts:190, 268).

**Crosses:** The protocol is split between the Rust Camera (wasm-web) and core/js/web.ts SceneCamera. The planner sees only the typed methods.

> Verifier: Accurate as described. All three risks are latent because SceneCamera, the only caller, always re-puts and checks the booleans, so I lowered severity from medium to low.

### [low] JPEG marker/scan walker (strip_plan, is_clean, frame_info)

*corrected* · `core/crates/media/src/jpeg.rs:150-210 (step: fill bytes, standalone, EOI, segment, SOS + entropy scan)`, `core/crates/media/src/jpeg.rs:214-230 (scan_end: entropy-coded mode until a non-stuffed, non-RST FF)`, `core/crates/media/src/jpeg.rs:307-359 (strip_plan loop: `at` cursor, plan, removed counters)`, `core/crates/media/src/jpeg.rs:372-393 (is_clean loop)`, `core/crates/media/src/jpeg.rs:473-530 (frame_info: a separate walker with its own rules)`

**Encoding:** A byte cursor `at`/`i` in a loop. The parser mode (between markers or inside entropy-coded data) is folded into step(), which returns the next offset. 'Seen SOF' and 'in progressive scans' are not tracked, and two independent walkers encode the grammar differently.

**States:** after-SOI · between-markers (fill bytes allowed) · in-segment · in-entropy-coded-scan · at-EOI (trailing bytes) · error

**Transitions:**
- after-SOI -> between-markers
- between-markers -> in-segment on a marker with a length (APPn/COM dropped or kept)
- between-markers -> in-entropy-coded-scan on SOS
- in-entropy-coded-scan -> between-markers at the first FF not followed by 00 or D0-D7
- between-markers -> at-EOI on FF D9 (strip records trailing bytes; is_clean needs end == len)
- any -> error on a truncated segment or scan, a bad length, FF 00 as a marker, or no EOI

**Risks:**
- There is no 'frame seen' state. strip_plan and is_clean accept SOS before any SOF, several SOFs, or SOI followed directly by EOI. is_clean(FF D8 FF D9) is true (starts_jpeg needs only 4 bytes); passthrough (jpeg.rs:576-580) catches that only through frame_info's NoFrame.
- The two walkers disagree. step() reads a stray SOI (FF D8) as a segment with a length, because standalone() is only RST and 0x01 (jpeg.rs:108-110), while frame_info steps over D8 (jpeg.rs:489). frame_info also reads frame fields past a too-short SOF. The frame a JPEG reports can therefore differ between the original and its stripped bytes.

**Crosses:** stripJpeg and jpegFrame are used by server/src/routes/render.ts and by the GLB texture strip (pipeline/). jpegIsClean and jpegPassthrough are exported by node.ts but have no callers in server/, pipeline/ or common/.

> Verifier: The walkers and both risks are confirmed in the code. I corrected the boundary: is_clean and passthrough have no TS callers today, so the 'caller using is_clean alone' scenario is latent. I dropped the fill-byte risk, which describes agreement between step and scan_end rather than a defect.

### [low] depth.png chunk-order state (decode_gray)

*confirmed* · `core/crates/raster/src/png.rs:244-270 (header: Option<Header>, idat: Vec<u8>, ended: bool, loop over chunks)`, `core/crates/raster/src/png.rs:222-237 (next_chunk; CRC skipped under the fuzzing feature)`

**Encoding:** Three variables together encode the chunk-order phase: `header` (None means before IHDR), `idat` (empty or not) and `ended` (IEND seen). Match guards enforce the legal orderings; there is no explicit state.

**States:** before-IHDR · after-IHDR (no IDAT yet) · in/after IDAT · ended (IEND) · error

**Transitions:**
- before-IHDR -> after-IHDR on the first IHDR
- before-IHDR -> error on any other chunk
- after-IHDR -> error on a second IHDR
- after-IHDR -> in-IDAT on IDAT (appended)
- any post-IHDR -> ended on IEND (break)
- input exhausted without IEND -> NoEnd; IEND without IDAT -> NoData

**Risks:**
- IDAT chunks need not be consecutive: ancillary chunks between IDATs are accepted and the data concatenated. The PNG spec forbids this, and it is laxer than the module's 'stricter than v1' claim.
- Bytes after IEND are ignored (break at png.rs:262), so trailing data is accepted silently.
- With the `fuzzing` feature the CRC check is compiled out (png.rs:233). A build that enabled it by accident would accept corrupt chunks.

**Crosses:** Reached through wasm-web decodeDepth, which core/js/web.ts and the kernel worker call; the planner loads depth.png through it for occlusion.

> Verifier: The loop, the guards and all three risks are in the code as cited.

### [low] PNG metadata strip chunk walk (media::png::walk)

*corrected* · `core/crates/media/src/png.rs:99-132 (walk: cursor i, keep callback, removed counters, IEND terminates)`

**Encoding:** A cursor loop with an implicit 'not yet IEND' phase. No IHDR-first or ordering state is kept.

**States:** after-signature · walking chunks · ended (IEND) · error (Truncated / NoEnd)

**Transitions:**
- after-signature -> walking
- walking -> walking per chunk (kept or counted as removed)
- walking -> ended on IEND (trailing bytes recorded)
- walking -> NoEnd when fewer than 12 bytes remain

**Risks:**
- The walk keeps no IHDR or ordering state, so a 'PNG' whose first chunk is IEND, or one with no IHDR, strips successfully to signature + IEND. A successful strip does not prove the file is a valid PNG.

**Crosses:** Used inside the GLB texture strip (pipeline/src/glb.ts through stripGlb). node.ts exports stripPng/stripPngPieces, but server/ only uses pngSize (render.ts:97).

> Verifier: The walk is confirmed. I dropped the second risk (text after IEND is cut as trailing bytes, which is correct behaviour, not a defect). I corrected the boundary, since server/ does not call stripPng.

### [low] CPython-compatible base64 decoder state (decode_python)

*confirmed* · `core/crates/media/src/base64.rs:73-136 (quad, left, pads, padding_started across the byte loop)`

**Encoding:** Four mutable locals (quad position 0-3, leftover bits, pad count, padding_started flag) together form the decoder state. The strict and lenient modes branch inline on the `strict` bool.

**States:** quad0 · quad1 · quad2 · quad3 · padding (pads > 0) · done (complete padding) · error

**Transitions:**
- quadN -> quad(N+1 mod 4) on an alphabet character (pads reset to 0)
- quad>=2 -> padding on '='; padding -> done when quad + pads >= 4
- strict: '=' at quad0 -> ExcessPadding; data after '=' -> DiscontinuousPadding; anything after done -> DataAfterPadding
- lenient: a non-alphabet character is skipped; '=' at quad < 2 is ignored
- end of input: quad0 -> ok; quad1 -> OneExtraCharacter; quad2/3 -> IncorrectPadding

**Risks:**
- In lenient mode `padding_started` is set but never read, and a data character after '=' resets pads to 0, so input with interleaved padding decodes across it. This is deliberate CPython parity, but it is a reachable state that strict mode rejects.
- Neither mode checks that the unused low bits are zero. node.ts decodeImageDataUri (node.ts:406-415) first tries a Buffer fast path that accepts only canonical base64 and falls back to this decoder, so two decoders decide the same input.

**Crosses:** Used by server/ through node.ts decodeImageDataUri (render.ts) and decodeMeta (X-Midstudy-Meta).

> Verifier: Accurate. The behaviour is intentional CPython parity, so severity stays low.

### [low] glTF JSON reader context machine (Ctx) and GLB chunk walker

*corrected* · `core/crates/media/src/json.rs:102-135 (Ctx enum, child_ctx transitions)`, `core/crates/media/src/json.rs:228-320 (object/array push placeholder Items for List ctx, then record)`, `core/crates/media/src/json.rs:322-363 (record writes Index slots before the duplicate-key check)`, `core/crates/media/src/glb.rs:335-366 (read_container: at == HEADER_LEN as 'first chunk' state, json/bin Options)`, `core/crates/media/src/glb.rs:586-610 (view_image `seen` per-view report memo)`, `core/crates/media/src/glb.rs:938-942 (implicit Compact -> InPlace layout fallback)`

**Encoding:** Partly explicit: the Ctx enum (Root/Asset/List/Entry/Skip) is passed down the recursion, and the index is filled through Option slots and placeholder Items patched afterwards. The GLB container uses `at == HEADER_LEN` plus json/bin Options as its chunk-phase state. The layout falls back silently from Compact to InPlace.

**States:** Ctx: Root · Ctx: Asset · Ctx: List(images|bufferViews|buffers) · Ctx: Entry(list) · Ctx: Skip · container: first-chunk · container: after-json · container: bin-seen

**Transitions:**
- Root -> Asset/List/Skip by key
- List -> Entry per array element (placeholder Item pushed, value patched after parse)
- Entry/Asset/Skip -> Skip for nested values
- container: first-chunk -> after-json (must be JSON)
- after-json -> bin-seen on BIN
- bin-seen -> error on a second BIN or JSON
- layout: Compact -> InPlace when any bufferView has extensions

**Risks:**
- The layout fallback is implicit: a caller asking for Compact gets InPlace when any bufferView has extensions (glb.rs:938-942). Only Report.layout says so, and the caller has to read it back.

**Crosses:** Reached through node.ts stripGlb from pipeline/src/glb.ts:225; the effective layout is reported back.

> Verifier: The structures are real. I dropped the two Index-inconsistency risks because neither is observable: the duplicate-key error (json.rs object()) and a mid-parse failure both discard the whole Index. The finder itself called them harmless.

### [low] Keep-room mask column-pass counters (two-pass dilation)

*corrected* · `core/crates/raster/src/mask.rs:84-121 (dilate_into: counters.fill(u32::MAX) before each column pass; forward pass assigns, reverse pass ORs)`, `core/crates/raster/src/mask.rs:146-160 (column_step: per-column distance-since-last-set counter, `or` mode flag)`

**Encoding:** A per-column u32 counter vector carries state across rows, with u32::MAX as the 'no set pixel seen yet' sentinel. A bool `or` switches a pass between assign and accumulate.

**States:** per column: unseen (u32::MAX) · within reach (counter <= reach) · beyond reach

**Transitions:**
- unseen/beyond -> 0 on a set pixel
- counter -> counter + 1 (saturating) on an unset pixel
- reset to unseen before each pass (two fill(u32::MAX) calls)

**Risks:**
- The sentinel collides with the largest reach. sat() maps reach.up/down to u32, and on wasm32 a usize of 4294967295 is passed through unchanged (wasm-web dilate), so `c <= reach` holds for the 'unseen' sentinel and a column with no set pixel turns entirely on. v1 would leave such a column empty.

**Crosses:** Reached through wasm-web keepRoomMask/dilate, called from core/js/web.ts and the kernel worker. The planner's render path (contract §4.7) sends the mask to the server.

> Verifier: I dropped the 'caller reusing counters leaks stale distances' risk: dilate_into refills `counters` itself before each column pass, so a caller cannot leak state across calls. The sentinel/reach collision is real but needs an absurd reach.

### [low] EnvResult f32/half variant encoded by which of two vectors is empty

*found by verifier* · `core/crates/wasm-web/src/lib.rs:772-806 (EnvResult { f32s, f16s } with f32Ptr/f32Len/f16Ptr/f16Len)`, `core/crates/wasm-web/src/lib.rs:845-868 (env_map fills one vector and leaves the other empty depending on `half`)`, `core/js/web.ts:445-458 (envMap picks which pointer to view from its own `half`, not from the result)`

**Encoding:** An implicit two-variant sum type: one of two Vecs is empty, and the TS face recalls which variant it asked for through its local `half` instead of asking the result.

**States:** f32 result (f16s empty) · half result (f32s empty) · freed

**Transitions:**
- none -> f32 on envMap(half=false)
- none -> half on envMap(half=true)
- either -> freed on r.free() in the finally block

**Risks:**
- Nothing ties the variant to the reader. If the face's `half` and the value passed to wasm ever diverged (for example a default changed on one side), the face would view a zero-length vector and return an empty map (dangling pointer, length 0) without an error.

**Crosses:** core/js/web.ts envMap and the kernel worker's envMap/envMapFromImage replies (lighting/env map in planner/).

**Rejected by the verifier:**
- `geom-drag-step-kernels`: Not a state machine in this group. drag.rs and the wasm/TS wrappers are pure functions that hold no state between calls. Both risks (angle0 from a different plane; Shift toggled mid-drag) concern the planner's drag state, which is outside these paths and must be assessed there.

## calib

### [high] Scene folder calibration stage, encoded by which files exist (photo.jpg, source.*, depth.png, lighting.json, calib.json)

*corrected* · `calib/src/midstudy_calib/ingest.py:340-346`, `calib/src/midstudy_calib/fit.py:262-273`, `calib/src/midstudy_calib/fit.py:276-300`, `calib/src/midstudy_calib/fit.py:105-127`, `calib/src/midstudy_calib/fit.py:336-385`, `calib/src/midstudy_calib/util.py:50-61`, `calib/src/midstudy_calib/util.py:71-73`, `calib/src/midstudy_calib/cli.py:256-262`, `calib/src/midstudy_calib/rooms/photos.py:129-163`

**Encoding:** Which files are on disk. photo.jpg and source.* mean ingested; calib.json means fitted, and it is written last as an informal commit marker. A missing depth.png means no_depth or a fallback; a missing lighting.json means no light. Hidden .NAME.XXXX.tmp files mean a write is in progress (or was killed). calib.json's source, fallback_reason and depth fields restate the other files' state. `run` is ingest followed by fit in one dispatch (cli.py:256-262), with nothing marking the gap between them.

**States:** empty · ingested (photo.jpg + source.*, no calib.json) · fitted with depth and light · fitted without depth (no_depth) · fitted with fallback (calib.source default or exif, depth.png and lighting.json removed) · re-ingested over an old fit (new photo.jpg, stale calib.json, depth.png and lighting.json) · torn write (depth.png or lighting.json new, calib.json old) · light-only update (lighting.json newer than calib.json)

**Transitions:**
- empty -> ingested on ingest (writes source.NEW, deletes other source.*, then writes photo.jpg)
- ingested -> fitted on fit (writes or unlinks depth.png, then lighting.json, then writes calib.json)
- fitted -> re-ingested on a lone ingest, or on run when fit raises after ingest succeeded (calib.json, depth.png and lighting.json are left in place)
- fitted -> fallback on fit when anything in _moge raises (an earlier good depth.png and lighting.json are unlinked)
- fitted -> light-updated on light (only lighting.json changes; a result that is too thin leaves the existing file)
- any -> torn on a crash or SIGKILL between the three write_atomic calls in _write

**Risks:**
- fit turns every Exception except ContractViolation from _moge into a fallback (fit.py:290-296). That includes Fail, MPS OOM, and the HF hub being offline when the pinned revision isn't cached. Then _write unlinks depth.png and lighting.json (fit.py:267-272) and overwrites calib.json with the default or EXIF camera, so a transient fault during a re-fit destroys a good calibration.
- ingest never clears calib.json, depth.png or lighting.json (ingest.py:340-346). After a lone `ingest`, or a `run` whose fit raises (for example a ContractViolation, or _photo_size failing), the new photo.jpg sits next to a calib.json and depth.png from the previous photo. rooms/photos.load and the server read that pairing as valid.
- _write is three separate atomic renames (fit.py:262-273). A crash after depth.png or lighting.json but before calib.json leaves the new depth with the old calib.json. rooms/photos.py reads _camera and _depth independently (photos.py:129-163) and cannot detect the mismatch.
- ingest writes source.NEW before it deletes source.OLD (ingest.py:342-345). In that window, or after a crash there, the folder holds two source files. source_file() takes the first in sorted order (util.py:71-73), and exif_block (ingest.py:198-205) and the mock's second key (fit.py:89-95) can then come from the wrong upload. A crash after source.* but before photo.jpg leaves source.NEW next to the old photo.jpg.
- light() with a too-thin result keeps the existing lighting.json (fit.py:378-380), even when photo.jpg was re-ingested since, so the lighting is stale for the current photo.
- write_atomic removes its .tmp only on a Python BaseException (util.py:59-61). A SIGKILL, such as a server timeout kill, leaves hidden .NAME.XXXX.tmp files in scene folders. There is no fsync either, so after a power loss a renamed file can be empty.

**Crosses:** The server (server/src/scenes) reads and serves these files and decides from them whether a scene is calibrated. The planner draws depth and occlusion from them, and rooms/photos.py (align-room) reads them while the calibration queue may fit the same scene.

> Verifier: The core claims check out against fit.py:262-300, ingest.py:340-346 and util.py:50-73. Added `run` (cli.py:256-262) as a second way into the stale-pairing state, and noted that write_atomic has no fsync. Dropped the mock-depth-unlink risk: removing a stale depth.png when the answer has none is the documented FitOutput behaviour (fit.py:42-43), not an illegal state.

### [medium] Warm worker request lifecycle (midstudy-calib serve)

*corrected* · `calib/src/midstudy_calib/worker.py:101-136`, `calib/src/midstudy_calib/worker.py:56-77`, `calib/src/midstudy_calib/worker.py:80-90`, `calib/src/midstudy_calib/worker.py:93-98`, `calib/src/midstudy_calib/worker.py:42-47`

**Encoding:** Implicit, through control flow. A while loop over stdin.readline handles each request. An over-long line goes through _drain_line. The Interrupted exception carries the in-flight request id, but only when SIGINT lands inside dispatch. fd 1 is dup2'd to stderr for good, and the protocol writes to a private dup. The `served` counter only feeds the log.

**States:** starting (fd redirect) · idle / reading a line · draining an over-long line · parsing and validating a request · dispatch running · responding · interrupted (answering the in-flight id, then exit 1) · stdout broken (exit 1) · stdin EOF (exit 0)

**Transitions:**
- starting -> idle after the dup and dup2 calls
- idle -> draining when a line is longer than MAX_LINE without a newline -> responding with an error
- idle -> parsing on a non-blank line -> dispatch running
- dispatch running -> responding when dispatch returns or raises ArgsError or Exception
- dispatch running -> interrupted on KeyboardInterrupt (raises Interrupted(rid))
- idle, parsing or responding -> exit 1 on a bare KeyboardInterrupt (nothing is answered)
- responding -> stdout broken on BrokenPipeError
- idle -> EOF exit 0

**Risks:**
- SIGINT while json.loads or validate.problems runs in handle (worker.py:58-67), which is outside the try around dispatch, raises a bare KeyboardInterrupt. The outer handler at worker.py:129-131 exits without answering a request whose id is already known.
- A SIGINT during _respond, between out.write and flush (worker.py:89-90), exits through worker.py:129 without finishing the line. A large align-room response (diagnostics) can exceed the text buffer and be partly flushed, so the server sees a torn JSON line.
- In the Interrupted handler (worker.py:125-128), _respond can itself raise BrokenPipeError or a second KeyboardInterrupt, and neither is caught. The worker then dies with a traceback (exit 1 for BrokenPipeError, a signal death for KeyboardInterrupt) instead of logging and returning 1.
- The protocol cannot cancel a single request. The only way to abort a long align-room run is SIGINT or a kill, which ends the worker and drops the warm MoGe and MASt3R models.
- Process-global state builds up across requests and is never reset: TQDM_DISABLE set by mast3r.load, the sys.path inserts and the scipy.cluster.hierarchy.distance alias (mast3r.py:115-121), and both model caches. A request after an align-room does not run under the same conditions as a one-shot run.

**Crosses:** Driven by the server's calibration queue (server/src, "align jobs on the calibration queue"), which spawns the worker, writes requests and matches responses by order and id. calib/scripts/bench.py and bench_rooms.py also drive it.

> Verifier: Dropped the SystemExit risk: worker requests use _RequestParser (cli.py:100-113), which turns argparse exits into ArgsError, and no library SystemExit path is visible. Corrected the Interrupted-handler risk: an uncaught BrokenPipeError also exits 1, so the difference is the traceback and a signal death on KeyboardInterrupt. Added the unanswered-id case for SIGINT outside dispatch. Dropped the PYTORCH_ENABLE_MPS_FALLBACK point: cli.main sets it before serve anyway (cli.py:296).

### [medium] MoGe-2 network cache and device placement (_LOADED plus Loaded.device)

*corrected* · `calib/src/midstudy_calib/moge_runner.py:78`, `calib/src/midstudy_calib/moge_runner.py:205-234`, `calib/src/midstudy_calib/moge_runner.py:241-248`, `calib/src/midstudy_calib/fit.py:138-160`

**Encoding:** A module-global dict keyed by model that holds at most one entry, which unload() enforces. Loaded.device is a mutable string, set only after net.to(device) returns. fit._infer keeps a local `dev` and retries on cpu.

**States:** empty · loaded(model) on cpu · loaded(model) on mps or cuda · partially moved (net.to raised midway; device field says the old device) · loading (between unload() and the _LOADED insert)

**Transitions:**
- empty -> loading -> loaded on cpu on load(model)
- loaded(A) -> empty -> loading on load(B) (unload, then build)
- loaded on cpu -> on device on infer(dev) (net.to, then the device field is set)
- on mps -> on cpu when inference on mps raises and device is auto (fit.py:153-157 retries on cpu)
- loading -> empty when _checkpoint or _build raises

**Risks:**
- loaded.net.to(device) runs before loaded.device = device (moge_runner.py:246-248). If .to raises partway (MPS OOM), some parameters are on mps while the field still says cpu. The cpu retry in fit._infer then sees loaded.device == 'cpu' and skips the move, so it runs on a split model and fails again. _moge raises, and fit writes a fallback that destroys the scene's calibration (see scene-folder-files). Only the next request moves the net in full.
- After an auto-mode inference failure on MPS, the cpu retry leaves the net on cpu. The next request picks mps again (pick_device does not remember failures), so a persistent MPS fault makes every request pay a move, a failure and a cpu retry.
- The MoGe cache and mast3r._LOADED are independent and never evict each other. After one align-room, the worker keeps MoGe and MASt3R resident together, and unload() runs only when the MoGe model changes.
- unload() runs before the new build (moge_runner.py:213-216), so a failing build of model B throws away a working model A.

**Crosses:** Only the warm worker keeps it across requests. The server's choice of --model and --device per request drives transitions.

> Verifier: The finder said the cpu retry 'moves it back'. It does not: when .to raised, loaded.device is still 'cpu', so infer(dev='cpu') skips the move (moge_runner.py:246) and runs on a split model. The consequence is worse than reported: a fallback overwrites calib.json. Dropped model-switch thrashing as a separate risk, since it is plain cost with no illegal state.

### [medium] MASt3R provisioning: code checkout on disk, weight snapshot, and the in-process network cache

*corrected* · `calib/src/midstudy_calib/rooms/mast3r.py:58`, `calib/src/midstudy_calib/rooms/mast3r.py:77-98`, `calib/src/midstudy_calib/rooms/mast3r.py:101-112`, `calib/src/midstudy_calib/rooms/mast3r.py:115-121`, `calib/src/midstudy_calib/rooms/mast3r.py:124-142`, `calib/src/midstudy_calib/rooms/mast3r.py:165-171`

**Encoding:** On disk: whether root/.git, dust3r/croco/models and mast3r/model.py exist, plus whether git HEAD equals COMMIT. Weights live in the HF cache (local_files_only first, then a download). In process, _LOADED is keyed by device and holds one entry, and the sys.path entries and the scipy patch are applied once.

**States:** not installed (extra missing) · code absent · code partially cloned (.git without checkout or submodules) · code at the wrong commit or dirty · code ready at COMMIT · weights absent · weights downloading · weights cached · network loaded on device D · unavailable (SolverUnavailable)

**Transitions:**
- code absent -> cloned on ensure_code (git clone, checkout COMMIT, submodule update)
- wrong commit -> ready on checkout, falling back to fetch then checkout
- any git failure -> unavailable (SolverUnavailable)
- weights absent -> downloading -> cached in ensure_weights
- not loaded -> loaded(D) on load(D)
- loaded(D1) -> loaded(D2) on load(D2) (builds the new net, then clears the old)

**Risks:**
- Nothing locks code_dir(). Two processes provisioning at once, such as a worker and a one-shot run or two worktrees sharing ~/.cache/midstudy-calib/mast3r, can run git clone, checkout or submodule update in the same directory at the same time.
- The ready check (mast3r.py:80-87) tests two paths and HEAD only. If `submodule update` is interrupted after dust3r/croco/models exists, the check passes with other files missing, and the run never re-provisions. An ImportError inside load becomes SolverUnavailable, and auto falls back to manhattan on every run. An ImportError from the dust3r or mast3r imports in solve (mast3r.py:169-171) is not converted at all and fails as a bug.
- A modified checkout at another commit makes `git checkout COMMIT` fail, then fetch and checkout fail too. Every run raises SolverUnavailable, and auto silently falls back to manhattan (command.py:83-89).
- Only ImportError becomes SolverUnavailable (mast3r.py:136-137). An OSError or RuntimeError from from_pretrained or .to(device), such as MPS OOM, escapes as a bug-type failure rather than as the fallback the command doc promises when MASt3R 'can't load'.
- load() builds the new net before _LOADED.clear() (mast3r.py:135-140), so a device switch briefly holds two networks.

**Crosses:** The server's default --calib command uses the rooms extra. align jobs from server/src/rooms trigger the first-use clone and the 2.6 GB download inside a job with a 600 s timeout.

> Verifier: Dropped the temp-dir cache risk: the finder itself concluded it is safe, and TemporaryDirectory is per solve (mast3r.py:175). Added the unconverted ImportError path in Mast3r.solve. The other risks check out in the cited lines.

### [medium] align-room solver selection and fallback (mock / mast3r / manhattan / none)

*corrected* · `calib/src/midstudy_calib/rooms/command.py:55-59`, `calib/src/midstudy_calib/rooms/command.py:67-122`, `calib/src/midstudy_calib/rooms/command.py:125-155`, `calib/src/midstudy_calib/rooms/solver.py:142-144`, `calib/src/midstudy_calib/rooms/solver.py:160-187`

**Encoding:** The local `name` is reassigned on a fallback. diag keys mark the outcome: 'fallback' on a fallback, 'nothing_placed' when nothing could be placed. device is None or a real device. The MIDSTUDY_CALIB_MOCK env var selects the mock branch, and solver 'none' marks a run with nothing placed.

**States:** mock hit · mock miss (no_match) · resolving the choice · running the learned solver · fell back to manhattan · running manhattan · nothing placeable (first photo unusable or fewer than 2 usable) · scored · written

**Transitions:**
- start -> mock hit or miss when MIDSTUDY_CALIB_MOCK is set
- start -> resolving -> running learned (auto with the extra installed, or an explicit mast3r)
- running learned -> fell back to manhattan on SolverUnavailable when the choice is auto
- running learned -> failure on SolverUnavailable when the choice is explicit, or on any other exception
- resolving -> nothing placeable when photo 0 is unusable or fewer than 2 photos are usable
- -> scored -> written (align.json)

**Risks:**
- The fallback catches only SolverUnavailable (command.py:83). A load-time RuntimeError or OSError (MPS OOM in .to) fails the whole command under --solver auto, although the module doc says manhattan answers when MASt3R can't load. A runtime failure in sparse_ga, which becomes Fail at mast3r.py:188-189, also fails the command, and that case is consistent with the doc.
- solver.resolve(choice) runs before the usability check (command.py:69 vs 78), so --solver mast3r with the extra missing fails even when no photo is usable and no solver would run.
- The mock branch validates the name with _choice but never calls resolve (command.py:128, 138-145), so an explicit --solver mast3r succeeds under the mock without the extra. Mock and real behaviour diverge.
- When MASt3R's scale for the first photo is not finite, from_views places only member 0 (solver.py:142-144). Nothing escalates to manhattan, and the run reports solver 'mast3r' with every other member unplaced and no diagnostics.fallback.

**Crosses:** align.json is read by server/src/rooms and the planner's room logic, which show solver, unplaced and diagnostics.fallback to the user.

> Verifier: The first risk was narrowed: failing on sparse_ga is what the module doc describes. The real gap is load-time errors that are not ImportError, since the doc promises a fallback when MASt3R can't load. The other three risks check out in the cited code.

### [medium] Room align.json validity, stamped by photo_sha256 only

*confirmed* · `calib/src/midstudy_calib/rooms/command.py:102-119`, `calib/src/midstudy_calib/rooms/command.py:147-148`, `calib/src/midstudy_calib/rooms/photos.py:129-189`, `calib/src/midstudy_calib/rooms/mock.py:27-32`

**Encoding:** Each member's photo_sha256 is the only fingerprint of the inputs. align.json's presence in the room directory implies the room is aligned. The mock key is the sha256 of the sorted photo SHAs.

**States:** no align.json · current · stale (calib.json or depth.png re-fitted under the same photo.jpg) · stale (photo re-ingested, sha differs)

**Transitions:**
- none -> current on an align-room write
- current -> stale on fit, run or ingest of a member scene
- stale -> current on a re-run of align-room

**Risks:**
- Poses and scales depend on calib.json's camera and on depth.png (photos.py:129-163; solver.from_views). Re-fitting a scene with another model, or a fallback after a transient failure, leaves photo.jpg's sha and so the stamp unchanged. A consumer that checks staleness by sha keeps poses computed for an older camera and depth.
- align-room reads each scene's photo.jpg, calib.json and depth.png in separate steps (photos.load). A fit running at the same time on the same scene can produce a sha, camera and depth from different generations. Whether this can happen depends on the server serializing fits and align jobs on its calibration queue, which is outside this group.

**Crosses:** server/src/rooms (rooms on disk) and planner/logic/room.ts consume align.json and match members to scenes by photo_sha256.

> Verifier: align.json records only photo_sha256 per member (command.py:105-111), with no fingerprint of calib.json or depth.png. The concurrency risk depends on server-side queue serialization, which I could not verify within this group.

### [medium] Room solver scale-source mode (floor vs depth vs nothing placed) in from_views

*found by verifier* · `calib/src/midstudy_calib/rooms/solver.py:118-157`

**Encoding:** A local string `mode` ('floor' or 'depth'), chosen by whether floor_y is empty. sigma comes from photo 0's floor height (floor mode) or its depth ratio (depth mode). A non-finite sigma means nothing is placed. Per member, a ratio of NaN, a scale of 1.0 and depth_scale None stand for 'unknown'.

**States:** floor mode (some inlier view has more than 50 floor points) · depth mode (no floor points anywhere) · degenerate (sigma not finite or not positive: only member 0 placed) · member placed · member unplaced (degenerate camera)

**Transitions:**
- start -> floor mode when floor_y is non-empty
- start -> depth mode when floor_y is empty
- either -> degenerate when sigma is not finite or not positive
- per member: placed, or unplaced when its scale is not finite or not positive or its position is not finite

**Risks:**
- In depth mode a member whose depth ratio is NaN (50 or fewer overlapping pixels) gets scale 1.0 (solver.py:141). That passes the degenerate check at solver.py:150, so the member is placed with a made-up scale of 1.0 instead of being unplaced. Only diagnostics.scale_by_depth = None hints at it.
- In floor mode, b is taken only from inlier views' floor points, but every member's scale uses its camera height above b (solver.py:134-137). A member whose camera height above b is not positive is unplaced, while member 0 with hs[0] <= 1e-6 sends the whole run to the degenerate state without escalating to depth mode.

**Crosses:** The member scales go into align.json, which the server and planner/logic/room.ts use to draw room layouts across photos.

### [low] Calibration result mode, implied by calib.json field combinations

*confirmed* · `calib/src/midstudy_calib/fit.py:66-80`, `calib/src/midstudy_calib/fit.py:105-127`, `calib/src/midstudy_calib/fit.py:185-259`, `calib/src/midstudy_calib/fit.py:304-322`, `calib/src/midstudy_calib/fit.py:362-373`

**Encoding:** There is no single mode field. The mode is spread across source (moge-2, exif or default), the presence of fallback_reason, floor.found, fov_source, depth (null or present), moge.height_m, scale and depth_scale (present only when EXIF is used), and fov_disagreement. light() picks its camera from (calib.json readable, floor.found, a fresh floor fit) in an order that is never written down as one rule.

**States:** moge-2 with floor · moge-2 without floor (default height and pitch) · moge-2 with EXIF FOV · fallback exif · fallback default · mock hit (copied verbatim) · mock miss (default plus fallback_reason)

**Transitions:**
- fit -> moge-2 (with or without floor) when MoGe succeeds
- fit -> fallback exif or default on any MoGe exception
- fit -> mock hit or miss when MIDSTUDY_CALIB_MOCK is set
- light: calib.json's camera if it was fitted to a floor or there is no new floor, else the fresh floor camera, else the default

**Risks:**
- The mock-miss path builds from _base and sets fallback_reason, but leaves source 'default' even when EXIF has a FOV (fit.py:124-127). The real fallback uses 'exif' with the EXIF camera (fit.py:74-77), so the same photo calibrates to a different mode and camera under the mock.
- For a fallback calib.json (floor.found false) and a fresh floor, light() uses the floor-fit camera (fit.py:363-370), not the camera in calib.json that the planner draws with. Lighting and the scene camera then disagree.
- A mock hit copies calib.json verbatim after a schema check and only nulls depth (fit.py:110-123). A fixture can carry field combinations the real path never writes, and consumers that branch on these fields see untested modes.

**Crosses:** The server and planner read source, fallback_reason, floor.found and depth to decide UI (for example a 'calibration fell back' notice, and whether occlusion is enabled).

> Verifier: Checked fit.py:66-80 against fit.py:124-127 (the mock miss skips fallback()'s EXIF branch) and the camera precedence at fit.py:363-373, which follows light()'s docstring. Kept the fixture risk but ranked it last, since the schema check bounds it.

### [low] Keep-room align (render composite) outcome chain and its out file

*corrected* · `calib/src/midstudy_calib/align.py:60-110`, `calib/src/midstudy_calib/align.py:113-169`

**Encoding:** Registration has a nullable H and a nullable reason. align() builds up `reason` through a chain of checks (inliers, residual, corner shift), then sets result.applied. The presence of the out file is the visible product.

**States:** registration failed (reason set, H None) · too few inliers · residual too high · framing moved · applied (out file written)

**Transitions:**
- register -> failed or ok
- ok -> rejected by MIN_INLIERS, MAX_RESIDUAL_PX or MAX_CORNER_SHIFT
- ok -> applied, writing out_path atomically

**Risks:**
- When the composite is not applied, align() returns without touching out_path (align.py:148-151). A file from an earlier successful align at the same path stays on disk, so the file exists while the result says applied false. A consumer that trusts file presence shows a stale composite.

**Crosses:** The server's render route (contract §4.7) calls align and serves the out file. It must use 'applied', not file presence.

> Verifier: Kept the stale-out-file risk (align.py:148-151). Dropped the (H, reason) risk: it describes the encoding, the guard at line 148 covers the impossible case, and nothing goes wrong.

### [low] JPEG marker walker (byte-state parser used for the metadata-free guarantee)

*corrected* · `calib/src/midstudy_calib/ingest.py:72-114`, `calib/src/midstudy_calib/ingest.py:128-142`, `calib/src/midstudy_calib/ingest.py:297-316`, `calib/src/midstudy_calib/ingest.py:334-338`

**Encoding:** The index i and nested loops, with no explicit state variable: expect 0xFF, skip fill bytes, read the marker byte. That byte is either a standalone marker (RST, TEM), a length segment, or, after SOS, the start of an entropy-coded scan that runs to the next marker that is neither stuffed nor RST. EOI returns.

**States:** expect marker · fill bytes · standalone marker · length segment · entropy-coded data (after SOS) · EOI · broken

**Transitions:**
- expect -> fill on 0xFF
- fill -> standalone on D0-D7 or 01
- fill -> segment on another marker with a length
- segment(SOS) -> entropy scan -> expect at the next real marker
- fill -> EOI on D9 (returns the end offset)
- any -> broken on a bounds error or a non-0xFF byte

**Risks:**
- A stray SOI (0xD8) after the first is read as a length segment (ingest.py:93-103 has no case for it). The two bytes after it are taken as a length, so a crafted file can make the walker jump over an APP1 or EXIF segment it never records. is_clean_jpeg would then pass the file through byte for byte with its metadata (ingest.py:334-336), unless the jump misses EOI or Pillow rejects the file. The input is the user's own photos, which limits the impact.

**Crosses:** photo.jpg is served by the server and sent to fal (contract §4.3), and fixtures/calib mock keys rely on byte identity.

> Verifier: Dropped the 'no SOS before EOI' risk: _passes_through calls im.load() and turns a decode failure into Fail (ingest.py:307-315), and a larger image goes to normalize, which decodes too, so such a file is never passed through. Merged the generic pass-through risk into the SOI risk, which is the one concrete gap: there is no 0xD8 case in jpeg_walk.

### [low] Process-global import and initialisation patches (scipy.signal stand-in, torch init no-op window, sys.path, scipy hierarchy alias)

*corrected* · `calib/src/midstudy_calib/moge_runner.py:86-124`, `calib/src/midstudy_calib/moge_runner.py:155-179`, `calib/src/midstudy_calib/moge_runner.py:182-202`, `calib/src/midstudy_calib/rooms/mast3r.py:115-121`

**Encoding:** sys.modules['scipy.signal'] is the stand-in, the real module, or absent. The torch.nn.init functions are swapped for a no-op inside a context manager. sys.path gets MASt3R's entries and scipy.cluster.hierarchy gets a 'distance' attribute, both set once and never undone.

**States:** clean · stand-in registered (during the MoGe import) · real scipy.signal loaded · init patched (inside _no_weight_init) · MASt3R paths and alias applied

**Transitions:**
- clean -> stand-in -> clean or real on import_moge
- any -> init patched -> restored on _build
- clean -> MASt3R applied on the first mast3r.load

**Risks:**
- import_moge returns early when scipy.signal is already in sys.modules (moge_runner.py:116). In a worker that ran align-room first (MASt3R pulls scipy in), the MoGe import pays the full scipy cost, so the import order changes its cost. The effect is on speed only.
- mast3r._import inserts the MASt3R, dust3r and croco roots at sys.path[0] (mast3r.py:116-118) and never removes them. In the worker, any later top-level import of a name those trees define, such as croco's `models` or `utils`, resolves to them for every later request, MoGe's included.

> Verifier: Dropped the _no_weight_init threading risk: there is no threaded construction anywhere in calib. The strict=False path runs outside the patch on purpose, so that it gets initialized weights (moge_runner.py:198-201), and that is the correct behaviour. The other two are real but low: one costs time only, the other is a plausible shadowing hazard.

### [low] align-room scoring rejection loop (iterative unplacing of low-confidence members)

*confirmed* · `calib/src/midstudy_calib/rooms/score.py:185-206`, `calib/src/midstudy_calib/rooms/score.py:150-182`, `calib/src/midstudy_calib/rooms/score.py:128-143`

**Encoding:** A while True loop. Entries of the `placed` list are set to None as members are rejected, and a `rejected` dict keeps each member's Scored from the pass that rejected it. The loop residual is reported only when the residual pairs form a cycle, which union-find checks.

**States:** scoring pass k · rejecting the least-confident member · converged · rejected diagnostics merged

**Transitions:**
- pass -> reject when some member other than 0 is below min_confidence
- reject -> pass (re-score without it)
- pass -> converged when nothing is below
- converged -> merge the rejected_* diagnostics

**Risks:**
- Removal is greedy and one-way: a rejected member is never reconsidered. If member A is rejected while a bad member B drags its residual down, and B is rejected later, A stays unplaced even though it would now pass.
- A rejected member's diag comes from the pass that rejected it (score.py:198, 205), so its overlap and residual describe a set of placements that no longer exists.

**Crosses:** Its results (unplaced, diagnostics.members rejected_*) are shown by the planner's room UI.

> Verifier: Checked score.py:191-205. The loop ends because each pass sets one more entry of placed to None. Both risks are visible in the code.

### [low] Manhattan solver greedy frontier (todo set / placed dict), and robust_up's worst-first exclusion

*confirmed* · `calib/src/midstudy_calib/rooms/manhattan.py:177-199`, `calib/src/midstudy_calib/rooms/solver.py:83-106`

**Encoding:** A todo set plus placed, conf and diags dicts that grow by one member per iteration, with a break when no candidate matches. robust_up uses a similar keep mask and drops the worst view first.

**States:** seeded with member 0 · matching the remaining members · placing the best · stuck (break) · done

**Transitions:**
- seed -> match -> place the best -> match ...
- match -> stuck when every _match is None
- todo empty -> done

**Risks:**
- A placement is never revised. An early wrong placement goes into the room raster that every later member is matched against (manhattan.py:186), so errors compound with no backtracking.
- When the loop is stuck, every remaining member is unplaced (manhattan.py:192-193, 199).

> Verifier: Matches manhattan.py:181-199. Reworded the second risk: once stuck, nothing can change, because the room only grows from placed members.

### [low] Bench scripts as worker protocol clients (request, then readline)

*confirmed* · `calib/scripts/bench.py:118-148`, `calib/scripts/bench_rooms.py:44-58`

**Encoding:** A synchronous write-then-readline loop over the subprocess handle. The id check, in bench.py only, is the only correlation, and closing stdin plus wait(timeout=60) does the shutdown.

**States:** spawned · awaiting response · got response · worker died · closing

**Transitions:**
- spawned -> awaiting on a request write
- awaiting -> got on a line
- awaiting -> died on an empty readline
- -> closing on stdin close and wait

**Risks:**
- bench_rooms.py:53-54 calls json.loads on the empty line a dead worker gives, which raises JSONDecodeError. bench.py checks for this (bench.py:137-139).
- In both scripts, proc.wait(timeout=60) in finally (bench.py:145, bench_rooms.py:57) raises TimeoutExpired when the worker is still in a long request, and the worker is never killed.
- readline has no timeout (bench.py:135, bench_rooms.py:53), so a hung worker blocks the script forever.

**Crosses:** They exercise the same protocol the server's calibration queue uses.

> Verifier: Checked both scripts. bench.py handles an empty line, bench_rooms.py does not. Neither script kills the worker after TimeoutExpired.

### [low] MoGe checkpoint resolution fallback (pinned revision -> Hub main)

*found by verifier* · `calib/src/midstudy_calib/moge_runner.py:141-152`, `calib/src/midstudy_calib/fit.py:198`

**Encoding:** A try/except chain: the pinned REVISIONS entry first, then the Hub's main on any exception. Which revision was loaded is recorded only in a stderr log line. calib.json's `model` holds the repo name (out.repo), not the revision.

**States:** pinned revision cached · pinned unavailable, main loaded · neither available (raises, so fit falls back)

**Transitions:**
- load -> pinned on success
- pinned fails -> main (logged)
- main fails -> exception -> fit fallback (scene-folder-files)

**Risks:**
- Any exception from the pinned download, such as a transient network error or a cache holding only another revision, silently switches to the Hub's main. calib.json records only the repo (fit.py:198), so two scenes can be fitted with different weights and nothing on disk says so.
- If the pinned revision isn't cached and the Hub is unreachable, both attempts fail and fit writes a fallback that overwrites a good calibration (see scene-folder-files).

**Crosses:** calib.json's model field is read by the server and planner. Because it names no revision, it can't tell scenes fitted with different weights apart.

## tooling

### [high] Machine-wide eval semaphore (slots + exclusive-wanted marker)

*corrected* · `scripts/eval-lock.mjs:26-30`, `scripts/eval-lock.mjs:35-36`, `scripts/eval-lock.mjs:39-47`, `scripts/eval-lock.mjs:49-59`, `scripts/eval-lock.mjs:60`, `scripts/eval-lock.mjs:62-68`, `scripts/eval-lock.mjs:72-93`, `scripts/eval-lock.mjs:95-98`

**Encoding:** On disk under <git-common-dir>/midstudy-eval-locks/: slot-<i>/ dirs and exclusive-wanted/ dir, each with owner.json = `me` {pid,host,cwd,cmd,started}; mkdir is the claim. In process: held[] slot paths, ownMarker boolean, EXCLUSIVE flag, t0/lastNote; SIG handlers swapped after spawn.

**States:** shared-waiting (marker stands or no free slot) · shared-holding-one-slot · exclusive-behind-another (no marker owned) · exclusive-queued (marker owned, 0..SLOTS-1 slots held) · exclusive-holding-all (marker removed) · child-running · exited (child code, 75 wait timeout, 127 spawn error, 130 signal while waiting) · on-disk slot: free | owned-live | owner-less (<10 s mtime) | stale (dead pid same host, or owner.started older than --stale-min)

**Transitions:**
- shared-waiting -> shared-holding on claim(slot-i) while !markerStands()
- exclusive-behind -> exclusive-queued on claim(MARKER)
- exclusive-queued -> exclusive-holding-all when held.length===SLOTS (rmSync MARKER, ownMarker=false)
- waiting -> exited(75) when Date.now()-t0 > WAIT_MS (release())
- waiting -> exited(130) on SIGINT/SIGTERM/SIGHUP (release())
- holding -> child-running on spawn; handlers replaced to forward the signal to the direct child only
- child-running -> released on child exit/error (release())
- stale slot/marker -> free via rename aside + rm + mkdir in claim()

**Risks:**
- Reclaim TOCTOU: two waiters both see stale(d) true; A renames d aside, rms, mkdirs and writes owner.json; B's later renameSync(d, asideB) succeeds on A's FRESH dir (renameSync does not check it is the same dir B judged stale), B rms it and mkdirs: both hold slot-i. The 'only one reclaimer wins' comment (:48) is false.
- Age staleness ignores liveness (:42-43): a live same-host owner is stale once started > STALE_MS (180 min). perf.mjs's watchdog is 4 h and eval:all --with-calib can run long, so a running holder's slot (or an --exclusive perf run's slots) is reclaimed mid-run.
- owner.json `started` is the PROCESS start (me, :36), not the claim time: a request that waited e.g. 170 min (WAIT_MS default 240) claims a slot that becomes 'stale' 10 min later while its eval runs.
- Same cause for the marker: an exclusive waiter older than 180 min has its marker reclaimed by a second --exclusive; the first keeps ownMarker=true and keeps claiming slots, the two split the slots so neither reaches SLOTS (until the 240 min timeout), and when one does it rmSyncs MARKER (:80) unconditionally, deleting the OTHER's marker; release() (:66) likewise removes a marker it no longer owns.
- --slots is per process and not on disk: a --slots 5 run can take slot-3/4 while an --exclusive (default 3) believes it holds everything.
- num() yields NaN for a flag with no numeric value (e.g. `--wait-min --exclusive` or `--wait-min --`): WAIT_MS=NaN so `Date.now()-t0 > NaN` never fires and the waiter loops forever.
- Signal forwarding goes to the direct child only (:96, child.kill): when the child does not exit on it (an eval stuck in cleanup, see harness-eval-lifecycle) eval-lock never exits and the slot stays held.
- Parent SIGKILL leaves slots on disk; reclaimed via the dead-pid check on the same host, or after 180 min for another host.

**Crosses:** Shared across every worktree via git --git-common-dir; driven by package.json eval scripts and every agent per CLAUDE.md; evals/perf.mjs and evals/all.mjs run inside it.

> Verifier: States/transitions accurate. Rejected the partial-owner.json risk: a reader that catches a half-written owner.json falls to the 10 s mtime branch, and the dir was just created (mtime fresh), so it is not stolen; a writer crash between mkdir and write is reclaimed after 10 s, which is correct. Added: `started` is process start not claim time (makes the 180 min age far shorter for long waiters), unconditional rmSync of a marker no longer owned (:66, :80), and the forward-only-to-direct-child hang.

### [high] startServer process lifecycle (spawned/up/exited/stopped) and free-port handoff

*corrected* · `evals/lib/harness.mjs:137-141`, `evals/lib/harness.mjs:231`, `evals/lib/harness.mjs:255-306`, `evals/lib/harness.mjs:282-293`, `evals/lib/harness.mjs:295-304`, `server/src/main.ts:160-173`, `server/src/scenes/calib.ts:96`

**Encoding:** srv object: up boolean, why string, exited null|{code,sig}, proc handle, log string; serverCount counter; freePort() binds and closes an ephemeral port before the server binds it.

**States:** port reserved-then-released · spawned (not answering) · up · exited before up · up then crashed (up=true, exited!=null) · stopping (SIGTERM sent) · killed (SIGKILL after 2.5 s) · stopped (log written)

**Transitions:**
- spawned -> up on any HTTP status from GET /planner/ within 100 polls
- spawned -> exited-before-up on child exit
- spawned -> not-answering after 100 polls (left running until cleanup)
- up -> crashed on child exit (only exited is set)
- any -> stopping -> killed/stopped via srv.stop() in cleanup

**Risks:**
- freePort TOCTOU: the port is closed before the child binds it; with three eval-lock slots running evals concurrently another eval's server can take it; this server dies with EADDRINUSE, but if a readiness poll lands before its exit is observed the OTHER server answers and up=true: the eval tests a foreign server with different data dirs.
- up is never cleared when the server dies later; up=true && exited!=null is unchecked, so later calls fail with status 0 and misleading reasons.
- stop() SIGKILLs after 2.5 s (:289-290) but the server's own stop() allows up to 5 s for hooks (main.ts:167) and its calib worker is spawned detached in its own process group (calib.ts:96): a SIGKILL mid-shutdown orphans the warm calib worker (MoGe-2/MASt3R) after the eval and its slot are gone.

**Crosses:** Drives server/src/main.ts (server-owned process and its calibration queue/worker); evals/perf.mjs reuses it via t.H.startServer.

> Verifier: Refined the orphan risk: the server does kill its worker on SIGTERM (calib.ts kill to -pid), but the harness's 2.5 s SIGKILL can cut that 5 s shutdown short, and the worker is detached so it survives. Dropped 'not-answering server not stopped until cleanup' as trivial (it is stopped in cleanup).

### [high] perf.mjs run orchestration: RUN cursor, per-target lazy shared resources, setupError, shutdown

*corrected* · `evals/perf.mjs:146-150`, `evals/perf.mjs:159-176`, `evals/perf.mjs:211-220`, `evals/perf.mjs:229-271`, `evals/perf.mjs:473-485`, `evals/perf.mjs:627`, `evals/perf.mjs:1011-1021`, `evals/perf.mjs:1030-1058`

**Encoding:** Module-level mutable RUN {i, warmup, load}; per-target t.shared {srv, browser, rect-<device>, cliReady, calibReady} filled lazily, never invalidated; t.setupError string; finished boolean in shutdown(); unref'd 4 h watchdog; withEnv swapping process.env around awaited calls.

**States:** targets loaded · suite setup (mainServer per target) · setup failed (setupError set) · run i (warmup when i<0) per target in ABBA order · suite done · shutting down (finished=true) · results written / exited

**Transitions:**
- suite start -> setup -> setupError on mainServer throw
- setup ok -> runs -warmup..runs-1, RUN reassigned per target/run
- any -> shutting down on SIGINT/SIGTERM/SIGHUP, unhandledRejection, the 4 h watchdog, or normal end

**Risks:**
- t.setupError is set on a failed mainServer (:1034) and never cleared: when a later suite's mainServer retry succeeds (t.shared.srv was not set), :1044 still fails every metric of every later suite with the stale error.
- t.shared.srv is cached forever (:230): if the main server crashes mid-suite, later suites reuse the dead server and every metric fails with status 0 instead of restarting it.
- shutdown() from a signal/watchdog/unhandledRejection (:1012-1021) runs cleanups (browser close, server stop) while the main loop is still awaiting inside a suite; the loop keeps recording errors against closed resources until process.exit, and results.json (:1071) is never written on that path.
- The 4 h watchdog exceeds eval-lock's 180 min age staleness, so an --exclusive perf run's slots can be reclaimed mid-measurement (see eval-lock-semaphore).
- withEnv mutates the global process.env across awaits (:146-150); anything that reads env meanwhile (a server stop during signal shutdown, spawned children) sees the target's swapped env. Calls are sequential so this is latent.

**Crosses:** Runs each target's own evals/lib/harness.mjs (module per target via ?perf=), the server and the CLI; holds the eval lock in --exclusive mode.

> Verifier: Rejected the photoRect risk: the rect is cached only after findPhotoOnScreen matches with median <= 12 (:371), so a mid-layout registration throws rather than caching a wrong rect. Rejected the nested-withEnv LIFO break: the outer withEnv awaits the inner one, so finallys always run inner-first. Added: results.json not written on signal/watchdog shutdown.

### [medium] build.mjs per-step lock directory (wasm, planner)

*confirmed* · `scripts/build.mjs:71-90`, `scripts/build.mjs:145`, `scripts/build.mjs:162-176`, `scripts/build.mjs:220`

**Encoding:** build/locks/<step>.lock/ with a pid file; mkdir = acquire, rmSync in finally = release; stale = dead pid or dir mtime > 15 min (or > 10 s when the pid file is unreadable).

**States:** free · held-live · held-without-pid-file · stale (dead pid or > 15 min) · waiter polling (150 ms) until 30 min deadline

**Transitions:**
- free -> held on mkdirSync + write pid
- held -> free on fn() settle (finally rmSync)
- stale -> free by rmSync then retry mkdir
- waiting -> throw after 30 min deadline

**Risks:**
- Reclaim race (worse than eval-lock: no rename at all): two waiters both decide stale; A rmSync+mkdir+writes pid; B's rmSync(dir) (:84) then deletes A's live lock and B also enters; two builds of the same step run concurrently.
- No heartbeat: age is the dir mtime from acquisition (:82), so a live build longer than 15 min (cold cargo release of every wasm crate plus wasm-opt -O3) is taken over by a second build.
- SIGTERM (e.g. harness ensureBuilt's 900 s execFileSync timeout, default killSignal SIGTERM) runs no finally: the lock dir remains (reclaimed via dead pid), build/wasm/.tmp-<crate>-<pid> dirs leak (prune runs on build/wasm/<name>, never on build/wasm), and .<name>.<pid>.<rand>.tmp files are skipped by prune (:95).
- A pid file emptied by a crash mid-write reads as Number('')=0 and alive(0) (signals the process group) is true, so that lock is treated as live until the 15 min age.

**Crosses:** Taken by every caller of scripts/build.mjs in a worktree: check.mjs (types, planner), evals/lib/harness.mjs ensureBuilt, npm run serve/build.

> Verifier: All four risks traced in code; the last one needs a crash inside writeFileSync (narrow), kept as low-likelihood.

### [medium] Incremental build stamps (validity cache of inputs/outputs)

*corrected* · `scripts/build.mjs:35-36`, `scripts/build.mjs:50-64`, `scripts/build.mjs:92-98`, `scripts/build.mjs:137-182`, `scripts/build.mjs:215-270`

**Encoding:** build/stamps/<step>.json {key, inputs: {path: 'size:mtime'|'missing'}, outputs[]}; FORCE flag; key = script hash + tool realpaths + crate/entry/wasm lists; outputs via tmp+rename, chunks before entry, stamp last; older files pruned after 10 min grace.

**States:** no stamp · stamp current · stamp stale (key changed / recorded input changed / recorded output missing) · building (outputs partially renamed) · built (stamp written)

**Transitions:**
- no stamp | stale -> building when stampCurrent() is false (or --force)
- building -> built on writeStamp
- building -> (old stamp kept) on throw
- built -> stale on any recorded input's size/mtime change or output deletion

**Risks:**
- Inputs are fingerprinted at writeStamp time, after the build (fingerprint() stats in writeStamp :63; wasm list taken :139 but stat'd :179; planner inputs from the metafile :260). A source saved while cargo/esbuild runs gets its new mtime recorded although the outputs came from the old content: the stamp says current and stale wasm/bundle is served until the file is touched again.
- stampCurrent only iterates recorded inputs (:57): a file absent at stamp time never invalidates (e.g. core/Cargo.lock appearing flips --locked without a rebuild). The wasm inputs are only *.rs/*.toml/*.lock (:140), so non-Rust files pulled in by include_str!/include_bytes! or build.rs are never inputs.
- prune() deletes files of older builds after 10 min (:96); a planner page open across two builds > 10 min apart 404s on lazily loaded chunks whose hash changed.

**Crosses:** Observed by check:types/check:planner (build --wasm-only), harness.ensureBuilt for every eval, and the server serving planner/dist.

> Verifier: Dropped the --planner-only risk: it is the requested behaviour and self-heals (the planner stamp records the web .wasm mtimes, so the next wasm rebuild invalidates it). Reworded the 'new file' risk around the actual walk filter (:140).

### [medium] createEval lifecycle (running -> finishing -> exit), watchdog and cleanup stack

*corrected* · `evals/lib/harness.mjs:69-112`, `evals/lib/harness.mjs:94-105`, `evals/lib/harness.mjs:107-110`, `evals/lib/harness.mjs:176-183`, `evals/lib/rooms.mjs:157-160`

**Encoding:** Closure state: results[], cleanups[], finishing boolean, watchdog timer; process-level unhandledRejection/uncaughtException/SIGINT/SIGTERM handlers funnelling into ev.finish(1); module-level recordTag/recordFile.

**States:** running · finishing (cleanups in reverse) · guard check and summary · exited(0|1)

**Transitions:**
- running -> finishing on finish() from the eval, the watchdog, an unhandled error or SIGINT/SIGTERM
- finishing -> finishing (no-op) on re-entrant finish()
- finishing -> exited after cleanups, the repo guard check and results.json

**Risks:**
- The watchdog is cleared at the start of finish() (:97) and cleanups are awaited with no timeout (:98): a hung cleanup (browser.close() on a wedged SwiftShader GPU process, a context that never closes) hangs the eval forever, holding its eval-lock slot.
- SIGINT/SIGTERM handlers (:110) suppress Node's default exit and call finish(), which returns at once once finishing is true: a second Ctrl-C or eval-lock's forwarded SIGTERM cannot stop an eval stuck in cleanup (only SIGKILL).
- recordFile is fixed on the first record (:180-183) while recordTag changes per createEval: if a process ever creates two evals, later /api records land in the first eval's file name (no current caller does; latent).

**Crosses:** Every eval script under evals/ uses it; the eval-lock slot is released only when the eval process exits.

> Verifier: Rejected 'checks pushed after the failed list is computed are lost': lines 99-104 are synchronous, so no handler can run between computing `failed` and process.exit; checks pushed during awaited cleanups land before line 101. Downgraded the multi-createEval risk to latent: grep shows each eval calls createEval once.

### [medium] perf drag/dragMoves pointer-press and rAF frame-recording sequence

*confirmed* · `evals/perf.mjs:666-704`, `evals/perf.mjs:708-740`

**Encoding:** Playwright mouse button state plus page globals window.__perf.framesOn and window.__perf.frames driving a self-rescheduling rAF tick; the item restored by moveItem afterwards.

**States:** idle · recording frames (framesOn=true) · button down · moving · recording stopped · button up · item restored

**Transitions:**
- idle -> recording on evaluate(framesOn=true)
- recording -> button down on mouse.down()
- button down -> moving per mouse.move
- drag: moving -> recording stopped -> button up -> item restored; dragMoves: moving -> button up -> recording stopped -> item restored

**Risks:**
- A throw between mouse.down() and mouse.up() (e.g. getState().items.find(...) undefined so .position throws at :696/:731, or a page.evaluate timeout) is caught and returned as {error}, leaving the button pressed (and in dragMoves framesOn=true, so the rAF loop runs on): later steps in the same page (renderView, addItem, the splat drag) run with a held button.
- The two functions order 'stop recording' and 'mouse.up' differently (:694-697 vs :732-733), so their frame windows differ in whether the release frame is included.
- The item is restored via moveItem only on the success path; after an error later metrics on the page see it moved.

**Crosses:** Drives the planner's pointer/drag machine (app-owned) through real mouse events and window.midstudy.moveItem.

> Verifier: Verified; note in drag() framesOn is already false by :694 when :696 throws, so the leaked rAF loop applies to dragMoves (and to any throw before :694 in drag).

### [medium] check.mjs gates: on-disk presence as 'already set up' flags and tree-mutating checks

*confirmed* · `scripts/check.mjs:70-80`, `scripts/check.mjs:96-100`, `scripts/check.mjs:147-150`, `scripts/check.mjs:160-168`, `scripts/check.mjs:194-204`, `scripts/check.mjs:229-236`, `scripts/check.mjs:243-257`, `scripts/check.mjs:293-304`, `scripts/gen-contract.mjs:427-428`

**Encoding:** Existence checks as state: calib/.venv present = synced; proofs/.lake/packages/mathlib/.lake/build present = cache fetched; build/miri/sysroot via cargo miri setup; build/fuzz/<target>/corpus accumulates; check:gen regenerates into the working tree then diffs with git; per-check {ok,line,out} and a failed counter.

**States:** venv missing -> syncing -> synced · mathlib cache missing -> fetching -> fetched · gen: tree clean -> regenerated (possibly dirty) · each check: pending -> ok | FAIL | crashed

**Transitions:**
- missing calib/.venv -> uv sync --frozen
- missing mathlib build dir -> lake exe cache get
- gen -> writes contract/gen and core/crates/contract/schema.json, then git diff

**Risks:**
- An interrupted `uv sync` leaves calib/.venv present but partial; check:py never re-syncs (presence is the flag, :164) and pyright reports import errors until the venv is removed by hand.
- An interrupted `lake exe cache get` can leave proofs/.lake/packages/mathlib/.lake/build present but incomplete; the next check:proofs skips the fetch (:250) and lake builds Mathlib from source.
- check:gen mutates the working tree with plain writeFileSync (gen-contract.mjs:428) and on FAIL leaves the regenerated files; a concurrently running eval importing contract/gen/validate.js can read a half-written file.
- check:types and check:planner each run build.mjs --wasm-only and contend on the build lock with any eval's ensureBuilt in the same worktree (see build-step-lock).

**Crosses:** Mutates contract/gen (foundation outputs), calib/.venv (calib), proofs/.lake (proofs); runs check-ownership for MIDSTUDY_TRACK/branch.

> Verifier: All verified, gen-contract's non-atomic write confirmed at :427-428.

### [medium] TScert ratchet: jobs file, nix-cached run, per-unit status with one retry, baseline ratchet

*corrected* · `scripts/tscert-ratchet.mjs:100-102`, `scripts/tscert-ratchet.mjs:105-131`, `scripts/tscert-ratchet.mjs:132-146`, `scripts/tscert-ratchet.mjs:149-180`, `scripts/tscert.mjs:27`, `scripts/tscert.mjs:55-73`, `scripts/tscert.mjs:134-152`

**Encoding:** build/tscert/jobs.json (fixed path) handed to a nix build whose store path caches verdicts; per-unit status strings (verified | error | other) with error units retried once under TSCERT_RETRY_TIMEOUTS; exit 3 + TSCERT-UNITS-ERRORS marker for no verdict; baseline.json functions[] vs certified (lost/fresh); build/tscert/stamp.json and result/.tscert-rev for the TScert build.

**States:** jobs written · nix build running · verdicts (cached store path) · tool errors (no verdict, nothing cached) · baseline check: ok | lost | fresh · --update: baseline rewritten · --files/--no-baseline: report only

**Transitions:**
- unit error -> retried once -> verified|other|error
- any remaining error -> exit 3 -> ratchet exit 1 'tool errors'
- results -> lost (exit 1) | ok (+fresh note) | baseline rewritten on --update

**Risks:**
- build/tscert/jobs.json is one fixed path per worktree: a `--files a.ts` run that overwrites it while a full run is between writing it (:102) and nix copying src (builtins.path, :122) makes the full run verify only a.ts; `for (const j of jobs) byFile[j.file] = ...` (:146) then finds nothing for the other files, every baselined function reports 'gone', and a concurrent full `--update` would shrink the baseline to that subset.
- build/tscert/stamp.json is written (tscert.mjs:71) but never read: validity is the out-link's .tscert-rev, so the stamp is write-only state that can disagree with what runs.

**Crosses:** Reads tscert/baseline.json (shared-append), the logic/ modules of planner/server/pipeline, nix/tscert.nix (packaging).

> Verifier: Rejected '--update has no guard on tool errors': remaining 'error' units make tscert units exit 3 (tscert.mjs:148-151), the nix build fails and the ratchet exits 1 at :132-142 before reaching UPDATE (:166); `--files` exits at :162 before --update too.

### [medium] evals/all.mjs sequential eval runner and signal propagation

*found by verifier* · `evals/all.mjs:35-47`, `evals/all.mjs:49-58`, `scripts/eval-lock.mjs:96-97`

**Encoding:** A for-await loop over steps[] (the cursor is implicit), one spawned child at a time with no handle kept outside run(); summary[] accumulates {code,secs,line}; no signal handlers.

**States:** running step k (child alive) · step k exited (code recorded) · all done (summary printed) · killed (all.mjs gone, child possibly alive)

**Transitions:**
- step k -> step k+1 on child exit/error
- last step -> summary and exit(0|1)
- any -> killed on SIGTERM/SIGINT to all.mjs (default action)

**Risks:**
- eval-lock forwards SIGTERM only to its direct child (npm -> all.mjs); all.mjs has no handler, dies at once and never signals the running eval (spawned non-detached but not killed): the eval keeps running with its server, calib worker and Chrome while eval-lock sees its child exit and releases the slot, so a 4th CPU-heavy eval can start.
- The summary line is scraped from the last 4000 chars by regex; an eval that crashes before its summary reports an empty line and only the exit code.

**Crosses:** Runs inside eval-lock (scripts/) and spawns every eval process (evals/*.mjs, evals/py, bash evals).

### [low] ensureBuilt once-per-process build memo

*confirmed* · `evals/lib/harness.mjs:234-251`, `evals/lib/harness.mjs:256`

**Encoding:** Module-level built: null | {ok:true,secs} | {ok:false,why}.

**States:** not built · built ok · build failed (cached)

**Transitions:**
- not built -> ok|failed on first startServer/ensureBuilt
- ok|failed -> sticky for the life of the process

**Risks:**
- A transient failure (build lock 30 min timeout, a concurrent build) is cached; startServer ignores built.ok (:256) and starts every later server against a missing or stale planner/dist.
- The 900 s timeout SIGTERMs build.mjs, which has no handler: its step lock and tmp files are left (see build-step-lock).

**Crosses:** Calls scripts/build.mjs and so its lock and stamps.

> Verifier: Both risks visible in code.

### [low] Polling of server job state machines (calib_status, align_status, job.status)

*corrected* · `evals/lib/harness.mjs:213-228`, `evals/lib/rooms.mjs:187-198`, `evals/perf.mjs:248`, `evals/perf.mjs:636`, `server/src/rooms/logic/room.ts:263-274`, `server/src/rooms/service.ts:478-488`

**Encoding:** waitFor loop with deadline; terminal sets hard-coded per caller: scene calib_status {done,failed}; room align_status {done,failed,none}; job status {done,failed}; null on timeout, exceptions swallowed into `last`.

**States:** polling · terminal done · terminal failed · terminal none (rooms only) · timed out (null)

**Transitions:**
- polling -> terminal when the server's field reaches a listed value
- polling -> timed out at deadline

**Risks:**
- The terminal sets are duplicated client-side; a new server status makes the poll run to its timeout and report a timeout instead of the real state.
- waitFor discards `last` (including caught errors) on timeout (:220), so a 500/connection-refused loop reads the same as slow progress.
- waitAlignDone also returns on align_status 'done' derived from an existing align.json when the room has no job since the server started (room.ts:273): called without a fresh job it reports the previous align as finished. (The helper currently has no caller in evals/.)

**Crosses:** Observes server-owned job state machines (/api/scenes/:name, /api/scenes/jobs/:id, /api/rooms/:room, /api/rooms/jobs/:id, /api/library/jobs/:id).

> Verifier: Rejected 'none returned right after POST align': RoomService.align() creates the job synchronously with status 'queued' (service.ts:488), which maps to 'pending' (room.ts:268) before the response is sent. waitAlignDone is unused (only its definition matches in evals/). Severity lowered to low.

### [low] Planner page open/readiness phases (load -> hook -> ready -> hookOk)

*confirmed* · `evals/lib/harness.mjs:477-499`, `evals/lib/rooms.mjs:212-240`, `evals/lib/rooms.mjs:242-248`

**Encoding:** Local why string, ok boolean, ready string (''|reason) raced against a 60/90 s in-page setTimeout; result {hookOk, why}.

**States:** navigating · load failed · hook missing · hook present, ready pending · ready resolved · ready rejected · ready timed out

**Transitions:**
- navigating -> load failed on goto error
- navigating -> hook present when window.midstudy appears (30 s)
- hook present -> ready resolved|rejected|timed out

**Risks:**
- openRoomPage duplicates openPlanner's phase sequence with different timeouts (90 s vs 60 s) and options; fixes drift.
- On any failure the context is returned but not closed; it lives until the browser closes in cleanup.
- waitPhoto requires room.photo === scene && scene.name === scene, then sleeps 400 ms to paper over the in-between of a photo switch.

**Crosses:** Observes the planner's window.midstudy hook, its ready promise and getState() (app-owned).

> Verifier: Accurate; added the unclosed context on failure.

### [low] perf pageInit readiness marks (hooked, hook/ready/shown/error)

*confirmed* · `evals/perf.mjs:276-296`, `evals/perf.mjs:336-341`

**Encoding:** window.__perf {lt, marks, hooked}; an accessor property on window.midstudy plus a 5 ms setInterval fallback; marks set by promise callbacks and a double rAF.

**States:** waiting for window.midstudy with .ready · hooked (marks.hook) · ready (marks.ready) · shown (marks.shown, two frames later) · error (marks.error)

**Transitions:**
- waiting -> hooked when the setter or poll sees m.ready
- hooked -> ready on resolve, -> error on reject
- ready -> shown after 2 rAFs

**Risks:**
- If .ready never appears the 5 ms interval runs for the page's life and loadPlanner waits its full 120 s.
- Only the first hook object is observed (P.hooked): a re-assigned window.midstudy with a new ready is not measured.
- Redefining window.midstudy as an accessor changes semantics for the app (delete/defineProperty/freeze behave differently), so the measured page differs slightly from the shipped one.

**Crosses:** Observes the planner's window.midstudy hook (app-owned).

> Verifier: Accurate; added the first-hook-only behaviour.

### [low] gated_calib.py gate file: hold a calibration job in 'running'

*corrected* · `evals/lib/gated_calib.py:28-38`, `evals/scenes_api.mjs:28-31`, `evals/rooms_api.mjs:26-29`

**Encoding:** Presence of the file at MIDSTUDY_EVAL_CALIB_GATE (created/removed by the eval via openGate/closeGate) = released; absent = held; 120 s deadline; align bypasses the gate.

**States:** held (gate absent, polling every 50 ms) · released (gate present) · timed out (proceeds as if released) · exec'd into the target

**Transitions:**
- held -> released when the eval writes the gate file
- held -> timed out after 120 s -> exec target
- released -> exec target

**Risks:**
- Timeout is indistinguishable from release: under load an eval expecting job 1 'running' and job 2 'pending' can see both done after 120 s and report a queue bug instead of a gate timeout.
- When an eval ends (or its server is SIGKILLed) with the gate closed, held gated_calib processes keep polling for up to 120 s and then exec the stub, outliving the eval.

**Crosses:** Spawned by the server's calibration queue (server-owned pending/running); gate controlled by the evals.

> Verifier: Rejected 'a gate file left from a previous run releases every job': the gate lives in ev.out, which createEval rmSyncs at start (harness.mjs:73). Added the orphaned-poller case.

### [low] pages_server streaming response generators (slow, trickle, huge, gzip-bomb) and timers

*corrected* · `evals/lib/pages_server.mjs:74-76`, `evals/lib/pages_server.mjs:108-128`, `evals/lib/pages_server.mjs:134-148`, `evals/lib/pages_server.mjs:157`

**Encoding:** Per-response closure counters (i for trickle, left for huge/gzip-bomb), backpressure via write()/'drain' re-entry, a Set of timer handles cleared in stop().

**States:** headers sent · streaming (counter > 0) · paused on backpressure (awaiting drain) · ended · client closed (left=0 / gz destroyed)

**Transitions:**
- streaming -> paused when write() returns false
- paused -> streaming on drain
- streaming -> ended when counter reaches 0
- any -> client closed on socket close

**Risks:**
- slow/trickle timers are cleared only by stop(); an eval that forgets stop keeps the process alive up to 25-60 s after its checks.

**Crosses:** Fetched by the server's product page reader (server-owned) under MIDSTUDY_FETCH_ALLOW.

> Verifier: Dropped the 'huge' lingering-response risk: when the socket closes the response is destroyed with it, so a pump left waiting on 'drain' holds nothing beyond a GC-able closure; trickle checks res.destroyed itself.

### [low] evals/out/<slug> scratch directory ownership (wipe at start, shared by concurrent runs)

*found by verifier* · `evals/lib/harness.mjs:72-74`, `evals/lib/harness.mjs:257-263`, `evals/perf.mjs:163-165`

**Encoding:** Directory presence/content: createEval rmSyncs and recreates evals/out/<slug>; serverCount names server-<n>/ data dirs inside it; perf rmSyncs evals/out/perf/targets/<label>.

**States:** absent · fresh (wiped by this run) · populated by this run's servers · overwritten/wiped by another run of the same slug

**Transitions:**
- any -> fresh on createEval / loadTarget
- fresh -> populated as servers start (server-<n>)
- populated -> wiped when another process starts the same eval in the same worktree

**Risks:**
- Nothing records which process owns the dir: two runs of the same eval in one worktree (eval-lock allows three concurrent) wipe each other's server data dirs, gate files and results.json mid-run, producing failures that look like app bugs.

**Crosses:** The server instances started by the harness write their scenes/layouts/renders/rooms under these dirs.
