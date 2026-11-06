# rooms-server (docs/ROOMS.md Phase B, track server)

Branch `rooms-server`, cut from `rooms` (main + Phase A). Built from CONTRACT.md §4.9 (and the §2.1, §2.6/§4.7, §2.7,
§4.4 additions) and the schemas in `contract/`.

## What exists now

| File | What |
|---|---|
| `server/src/rooms/logic/pose.ts` | pure (TScert): pose/scale clamps (`x_m`, `z_m` −50…50, yaw into (−180, 180], scale 0.25–4, 6 decimals), `effectiveCamera` (height × scale, clamped 0.2–3.0), `composePose` (§4.9 Align formula; cos/sin passed in: TScert's overlay has no `Math.cos`/`Math.PI`), `rescaled` (Set scale) |
| `server/src/rooms/logic/members.ts` | pure (TScert): `firstMembers`, `putMembers` (PUT's whole list), `removeMember`/`reinsertMember` (scene delete/restore), `rescaleMembers`, `anchorIndex`/`alignOrder` (the align job's anchor and argument order), `answerFrame` + `applyAnswer` (an align result or `reset`: origin and manual kept, stale `photo_sha256` ignored, `overwrite_manual`), `waitingFor` |
| `server/src/rooms/logic/room.ts` | pure (TScert): names (`room-YYYYMMDD-HHMMSS`), the body checks of POST /api/rooms, PUT /api/rooms/<room>, POST …/align, every sentence, the align job's messages, `alignStatus`, `readRoom`/`readMember`/`readAnswer` (tolerant readers of room.json and align answers) |
| `server/src/rooms/service.ts` | `RoomService`: rooms on disk (`--rooms-dir`, room.json written atomically and checked against room.schema.json in strict mode), the room object and detail, create/update/delete/restore, the trash (`rooms/.trash/<room>-<stamp>/` with `trash.json` and `layouts/`), membership hooks for scene delete/restore, align jobs on the calibration queue |
| `server/src/routes/rooms.ts` | `GET/POST /api/rooms`, `GET /api/rooms/jobs[/<id>]`, `GET/PUT/DELETE /api/rooms/<room>`, `POST /api/rooms/<room>/align`, `POST /api/rooms/<room>/restore` |
| `server/src/routes/layouts.ts` | `?room=` (layouts/@<room>/, `room_name`), exactly one of `scene`/`room` |
| `server/src/routes/render.ts`, `scenes/render.ts` | render's `room` (404 unknown room, 400 without `scene` or with a scene that isn't a member), meta `room` exactly when given, `GET /api/renders?room=` |
| `server/src/scenes/service.ts` | scene objects carry `room` (always, now that the server has rooms); delete writes the member record into `trash.json` (`room: {name, index, member}`); restore rejoins; `queueTask`/`runCalib`/`queued`/`timeoutSeconds` for align jobs on the same queue |
| `server/src/scenes/logic/{jobs,worker,scene,layout,render}.ts`, `server/src/logic/{jobs,cli}.ts`, `server/src/jobs.ts`, `deps.ts`, `main.ts`, `strict.ts` | `align-room` as a calib command (result schema `calib-cli.schema.json#/$defs/align_room`), `a-` job ids, `--rooms-dir`, `checkRoomLayout`/`layoutOwner`, `conforms()` (a silent strict check) |
| `server/src/rooms/tsconfig.tscert.json` | the tsconfig TScert reads the rooms logic with until toolchain adds the area (below) |
| `server/test/rooms.test.ts` | the rooms API on the real server in strict mode: every route and refusal, align jobs (anchor composition, manual kept, `overwrite_manual`, reset, stale photo, waiting for calibrations, one per room, failures, a contract-breaking answer, the warm worker, a room deleted under a running and a queued job), room layouts, render `room`, scene delete/restore inside a room, room trash/restore |
| `server/test/rooms-logic.test.ts` | the pure rules |
| `server/test/rooms-calib.ts` | the calib stand-in: `align-room` answers exactly per §4.9 Mock from `fixtures/calib/rooms/` (key, rename, re-express, no-match answer); the other commands are `fixtures/stub_calib.py`'s; switches for delays, failure, an off-contract answer and a worker (`serve`) |
| `server/test/helpers.ts` | `startServer` passes `--rooms-dir <scratch>/rooms` (else tests would write the repo's `rooms/`) |

## How to run and test

```
nix develop -c node server/src/main.ts --port 8850 --daily-spend-usd 0 --rooms-dir evals/out/rooms \
  --calib "node server/test/rooms-calib.ts"        # with MIDSTUDY_FAL_MOCK=fixtures/fal MIDSTUDY_NO_DOTENV=1
                                                   # NOOK_NO_DOTENV=1 MIDSTUDY_CALIB_MOCK=fixtures/calib [MIDSTUDY_STRICT=1]
nix develop -c npm run test:server                 # includes rooms.test.ts and rooms-logic.test.ts
nix develop -c node --test --test-concurrency=1 server/test/rooms.test.ts
nix develop -c node scripts/tscert-ratchet.mjs --project server/src/rooms/tsconfig.tscert.json \
  --files server/src/rooms/logic/pose.ts,server/src/rooms/logic/members.ts,server/src/rooms/logic/room.ts,common/logic/pyfmt.ts,server/src/scenes/logic/values.ts
```

(The extra `common/logic/pyfmt.ts` and `scenes/logic/values.ts` make the sandbox copy those folders; the rooms logic
imports them.) Upload a room by hand: `POST /api/scenes` per golden photo (`fixtures/scenes/living-wide/photo.jpg`,
`room-1`, …), `POST /api/rooms {"scenes": [...]}`, `POST /api/rooms/<room>/align`: with `MIDSTUDY_CALIB_MOCK` the
stand-in answers with the golden truth.

## Decisions (where the contract left room, or I read it one way)

1. **Align 409 "fewer than two members have a photo.jpg" counts members still calibrating.** The planner's New room
   (and `createRoom`) asks for the alignment right after the uploads, while the later photos' `run` jobs are still
   queued and have no `photo.jpg` yet; counting only existing photos would refuse every New room. When the job's turn
   comes it counts real photos; fewer than two fails the job ("fewer than two photos of the room are left to align").
   **Contract clarification for foundation/integration** (§4.9 table, `align-request.schema.json`).
2. **Waiting on the queue:** an align job whose members are calibrating goes to the back of the calibration queue when
   its turn comes (so their calibrations, queued behind it, pass it); with nothing else queued it runs (a member can't be
   calibrating then). `waiting_for` and the message (`waiting for N photo(s) to calibrate`) are computed when the job is
   read, from the members' calibration jobs. Light jobs don't count as calibrating.
3. **The answer's frame is its `members[0]`** (the anchor the job passed first), looked up in the room *as it is when the
   answer is applied*: its pose (`{0,0,0}` when unplaced) and scale (1 when it is no longer a member). `reset` uses the
   same rule on align.json.
4. **Unplaced in the answer, manual in the room:** stays manual even with `overwrite_manual` (§4.9 says "unless it is
   manual or origin", without the exception); placed members do follow `overwrite_manual`.
5. **align.json is served only when it reads as an answer** (and, in strict mode, passes align.schema.json); otherwise
   the detail's `align` is null and `align_status` treats it as absent. Without this, a tool writing a bad align.json
   would make `GET /api/rooms/<room>` a strict-mode 500 forever. `align_status`: a dropped job (room deleted under it)
   doesn't count after a restore.
6. **`saved`** is stamped when members, poses, scales or the alignment actually change (also by scene delete/restore
   and by a restore that drops members); a title alone never stamps it; a PUT that changes nothing writes nothing.
7. **Room detail and object list only members whose scene exists** (a scene folder removed by hand); `room.json` is
   left as it is.
8. **A new room's name skips names in the rooms' trash** (so a restore can't collide with it).
9. **Poses are kept to 6 decimals** (micrometres, microdegrees) so a pose sent back unchanged is "no change" (no
   `manual`); yaw −180 is stored as 180.
10. **Render with a room:** an unknown or non-string `room` is 404 (as an unknown scene), checked after `scene`;
    `room: null` is no room. `GET /api/renders?scene=&room=` keeps renders that match both.
11. **Layouts:** neither `scene` nor `room` keeps the scene routes' v1 sentence (`add ?scene=<name>…`); both is 400;
    a blank value counts as absent (as the query parser already does).
12. **Sentences** follow the hand-written examples where they show one (`there's no room 'x'`, `'x' is already in room
    'y'`, `'x' is listed twice`, `room 'x' is already being aligned`, `this room has no alignment to reset to yet`,
    `a room 'x' exists already`, `aligning N photos`, `aligned P of N photos (solver); U left to place by hand`).
    Unknown scenes keep the scenes' own v1 sentence (`no scene named 'x': GET /api/scenes lists them`).
13. `renderMeta` and `checkRoomLayout` build their objects without spreads (TScert can't type a spread of a typed
    object); the render meta's `room` is added in the shell.

## Checks run (this worktree)

- `nix develop -c npm run check:types`, `check:lint`, `check:dead`, `check:tests` (5 suites, 175 passed; rooms:
  18 tests in test:server), `node scripts/check-ownership.mjs server --base rooms` (ok).
- TScert: `--files` over the rooms logic with `server/src/rooms/tsconfig.tscert.json`: every rooms function certifies
  (54); `check:tscert` / `--update` over the configured areas: my new scenes functions (`checkRoomLayout`, `layoutOwner`,
  `noRoomLayout`, `unreadableRoomLayout`) certify and were **appended** to `tscert/baseline.json` (nothing removed).
- Evals: see the end of this file.

## Open issues for integration

1. **TScert area for the rooms logic** (toolchain's files): add `{"glob": "server/src/rooms/logic/**/*.ts", "project":
   "tscert/tsconfig.server.json"}` to `tscert/config.json` and `"../server/src/rooms/logic/**/*.ts"` to
   `tscert/tsconfig.server.json`'s `include`, then `node scripts/tscert-ratchet.mjs --update` (54 functions join:
   `server/src/rooms/logic/{pose,members,room}.ts#…`); `server/src/rooms/tsconfig.tscert.json` can then go.
2. **`check:tscert` fails on `rooms` already**, not because of this branch: `planner/logic/input.ts#keyCommand` and
   `planner/ui/logic/workspace.ts#workspaceKey` are in the baseline but gone from the code (app's). `--update` would
   also add ~22 planner/spend functions that certify on `rooms` but aren't in the baseline; I appended only mine.
3. **The evals' server needs `--rooms-dir`**: `evals/lib/harness.mjs` (foundation) starts the server without it, so E18/E19
   would create rooms in the worktree's `rooms/` (git-ignored, but user data). Add `--rooms-dir <scratch>/rooms` there.
4. **Contract text** (foundation): §4.9 should say that members still calibrating count toward the align 409's "two
   photos" (decision 1), and that the answer's frame is looked up in the room when the result is applied (decision 3).
5. **The hand-written room examples** (`contract/examples/*rooms*.json`, foundation's) are consistent with this server's
   shapes; re-record them with `contract/tools/record-examples.mjs` once it gains room cases (foundation/integration;
   not my track). Differences that remain: a 404 for an unknown scene (`POST /api/rooms`, `PUT` members) uses the
   scenes' own v1 sentence, not the example's `there's no scene '…'`; the examples' failed-job text is the calib
   track's sentence.
6. **`fixtures/stub_calib.py` has no `align-room`** (evals track adds it); my stand-in `server/test/rooms-calib.ts`
   implements the §4.9 mock in TypeScript for the server tests, and could be compared with the stub's.
7. **Worker:** align-room goes to the warm worker like `run`/`fit`/`light` (tested with the stand-in's `serve`); the
   real calib worker's `align-room` (calib track) is untested here.
