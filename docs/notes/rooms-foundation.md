# rooms-foundation (docs/ROOMS.md Phase A, A1: contract + fixtures)

Branch `rooms-foundation`, cut from `main` at `452a601`. Track: foundation.

## What exists now

- **Contract.** [CONTRACT.md §4.9 Rooms](../../contract/CONTRACT.md) (frames, poses, effective camera, files, membership,
  server routes, changes, align, `align-room`, the mock, planner, hook), plus the additions in §1 (files), §2.1
  (`--rooms-dir`, `/api/rooms*` is back with another meaning), §2.2 (`?room=&photo=`), §2.7 (`?room=` layouts), §4.3
  (`align-room`, worker `cmd`), §4.4 (scene object `room`, scene delete/restore and rooms), §4.5, §4.6, §4.7 (render
  `room`) and §5.1 (the golden room).
- **Schemas** (`$id` = `midstudy/<path>`):
  - files: `midstudy/room.schema.json` (Room; `$defs` pose → `Pose`, scale → `MemberScale`, poseSource → `PoseSource`,
    member → `RoomMember`), `midstudy/align.schema.json` (Align, `AlignMember`); changed: `midstudy/layout.schema.json`
    (`room_name`, exactly one of `scene_name`/`room_name`), `midstudy/trash.schema.json` (`SceneTrashRoom`, `RoomTrash`),
    `midstudy/calib-cli.schema.json` (`$defs/align_room` → `CalibCliAlignRoom`; `request.cmd` gains `align-room`).
  - API: `midstudy/api/room-list.schema.json`, `room-object` (+ `AlignStatus`), `room-detail`, `room-create`,
    `room-put` (+ `PosePut`, `RoomMemberPut`), `room-deleted`, `room-job` (`AlignJob`), `room-jobs`, `align-request`,
    `align-accepted`; changed: `layout-put` (`room_name`), `layout-deleted` (`room`, exactly one of `scene`/`room`),
    `render-request` (`room`), `render-meta` (`room`, optional), `render-list` (description), `scene-object` and
    `scene-detail` (`room`, optional).
  - `contract/api/routes.json`: `GET/POST /api/rooms`, `GET /api/rooms/jobs`, `GET /api/rooms/jobs/{id}`,
    `GET/PUT/DELETE /api/rooms/{room}`, `POST /api/rooms/{room}/align`, `POST /api/rooms/{room}/restore`; the layout
    routes and `GET /api/renders` take `room` as well as `scene`.
  - `contract/gen/` and `core/crates/contract/schema.json` regenerated (114 types from 58 schemas).
  - Examples: `contract/examples/*-api-rooms*.json` (9 files) are **hand-written** from §4.9 (their `recorded` says so)
    and validated; re-record them once the server implements the routes. `get-api-settings.json` and
    `put-api-settings.json` were added too: the settings routes had no examples, so `test:contract`'s "examples of every
    route" failed on `main` already.
  - `contract/test/contract.test.mjs`: a rooms test (routes, every refusal the schemas make: pose null ⇔ unplaced,
    pose/scale null together in align.json, yaw range, clamps, exactly one of scene_name/room_name, …), and the golden
    fixtures test covers room-1 … room-6 and the two mock answers.
- **Fixtures.**
  - `fixtures/make_scene.mjs`: `ROOM_SCENES` (room-1 … room-6), posed cameras, furnishings that the five original
    cameras never see (bookshelf, console + poster, second door, armchair, striped rug, sideboard + print, plant,
    pendant), room truth in the scene's own frame, per-scene floor points and wall check, overlap measure, the mock's
    `align.json` answers. New flags: `--only a,b`, `--rooms`, `--out <dir>`.
  - `fixtures/scenes/room-{1..6}/` (photo.jpg, truth.json with `pose_in_room`, `room`, `wall_check`, depth.png,
    ids.png, calib.json, lighting.json), `fixtures/calib/<sha>/` copies, `fixtures/calib/rooms/<key>/align.json`:
    - `golden-room` (living-wide, room-1 … room-6): key `7a1df71b328ae1ddd1f86d143455f646d1b5a8fbf2ea7cfc3d5dd1d293e7f9cc`
    - `golden-pair` (living-wide, room-1): key `d1ebc6e011116bf13e32891aee3b5d49ed13909fef1b6fbb1433d58aa0483dba`
  - `fixtures/check_scenes.py` (`npm run check:scenes`): 261 checks, all passing.

| id | camera (fov, h, pitch, roll) | pose_in_room (x, z, yaw) | notes |
|---|---|---|---|
| room-1 | 58, 1.52, −12, 1.2 | −1.15, 0.45, −22 | front left |
| room-2 | 60, 1.36, −14, −1.4 | 1.9, 0.3, 35 | front right |
| room-3 | 52, 1.58, −9, 0.6 | −1.95, −0.35, −55 | left, toward the window corner; 4 sofa corners in view |
| room-4 | 65, 1.45, −16, −0.8 | 1.35, −4.55, 152 | **hard: little overlap** (behind the sofa, facing the front wall) |
| room-5 | 66, 1.22, −6, −0.5 (portrait) | 1.9, −1.3, 62 | right, toward the left wall |
| room-6 | 55, 1.45, −19, 1.5 | 0.55, −0.7, −90 | **hard: bare wall** (plaster and floor only; no sofa or table) |

Overlap (share of the row photo's points, floor included, that the column photo sees; truth.json `room.overlap`):

| | living-wide | room-1 | room-2 | room-3 | room-4 | room-5 | room-6 |
|---|---|---|---|---|---|---|---|
| room-1 | 56 % | | 65 % | 57 % | **12 %** | 37 % | 4 % |
| room-2 | 44 % | 58 % | | 42 % | 41 % | 36 % | 2 % |
| room-3 | 45 % | 72 % | 42 % | | 16 % | 17 % | 16 % |
| room-4 | **18 %** | **22 %** | 43 % | 20 % | | 19 % | 3 % |
| room-5 | 48 % | 52 % | 88 % | 27 % | 25 % | | 0 % |
| room-6 | 0 % | 14 % | 2 % | 58 % | 18 % | 0 % | |

The little-overlap pair is **room-1 / room-4** (12 % and 22 %); room-4 also shares only 18 % with living-wide.

## How to run

```
nix develop -c node fixtures/make_scene.mjs --rooms          # re-render room-1 … room-6 and the mock answers only
nix develop -c npm run check:scenes                          # the self-check (writes evals/out/check-scenes/)
nix develop -c node scripts/gen-contract.mjs                 # after a schema change; then check:gen, test:contract
```

`node fixtures/make_scene.mjs --only living-wide,steep-roll,portrait,living-cool,living-warm --out evals/out/x`
re-renders the five somewhere harmless. Done here: with the furnishings in, that output is **byte-identical** (photo,
depth, ids, truth, calib, lighting) to `main`'s generator run in the same session. (Both differ slightly from the
committed photos, max 19/255, because SwiftShader changed since they were made; depth.png is identical. That is why the
five were not regenerated: they are byte-identical to `main`.) The furnishings cast no sun shadow: with shadows on,
DAYLIGHT's sun put their shadows into living-wide, steep-roll and portrait.

## Checks run (this worktree)

- `nix develop -c npm run check:gen`, `check:types`, `check:lint`, `check:tests` (157 passed), `check:scenes`
  (261/261), `MIDSTUDY_TRACK=foundation npm run check:ownership`, `node scripts/check-ownership.mjs foundation --base main`
- `npm run test:contract` (12 tests), `cargo test -p midstudy-contract` (the Rust types round-trip every example,
  the new ones included)
- through the eval lock: `eval:scenes-api` (E1 235/235), `eval:planner` (E3 56/56)

## Decisions (where ROOMS.md left something open, or I changed it)

1. **Pose clamps:** `x_m`, `z_m` −50…50 m; `yaw_deg` into (−180, 180] (−180 becomes 180); `scale` 0.25–4; the effective
   camera's `height_m × scale` clamped to 0.2–3.0 like every camera.
2. **pose_source gains `unplaced`** (ROOMS had solver/manual/origin): `pose` is null exactly when `pose_source` is
   `unplaced` (schema-enforced).
3. **room.json's last-alignment record is `aligned: {solver, finished} | null`**, not `align` (ROOMS §3.2 said
   `align`): the room detail's `align` is `align.json` itself (ROOMS §3.3), and one name can't be both. room.json also
   has `version`, `name`, `created`, `saved`.
4. **Titles:** trimmed, at most 200 characters (400 above), blank → null, as scenes. **Names:** `room-YYYYMMDD-HHMMSS`
   with `-2`… on collision. **At most 32 members**; a room may lose every member and stays until deleted.
5. **Room layout folder:** `layouts/@<room>/` as ROOMS proposed (a slug can't start with `@`); trash in
   `layouts/@<room>/.trash/`; a delete answers `{ok, name, room, trash}`.
6. **How trash records a removed member:** the deleted scene's own `trash.json` gains `room: {name, index, member}`
   (`SceneTrashRoom`); restoring the scene puts it back at `min(index, members)` when the room exists and the scene is
   in no other room, else it comes back alone. A deleted room goes to `rooms/.trash/<room>-<stamp>/` with
   `trash.json` (`RoomTrash`) and its layouts in `layouts/`; restoring drops members whose scene is gone or now in
   another room.
7. **Mock key rule, exactly:** lowercase hex SHA-256 of the UTF-8 text of the members' `photo.jpg` SHA-256s (lowercase
   hex), sorted ascending as strings, joined with `"\n"`, no trailing newline; file `<dir>/rooms/<key>/align.json`.
   Because scene names differ per run, the mock **renames** each member to the folder whose `photo.jpg` has its
   `photo_sha256`, puts them in argument order and **re-expresses** poses and scales relative to the first argument
   (formulas in §4.9 Mock).
8. **Changed from ROOMS:** with no mock match, the first argument is still placed (it is the frame: `members[0]` is
   always `{0,0,0}`, scale 1) and every *other* member is unplaced, `solver: "none"`. ROOMS said every member unplaced.
9. **align.json** carries `photo_sha256` per member (stale answers and the mock), `version`, `created`, `elapsed_s`,
   `device`; `unplaced` is kept as ROOMS listed it (it must equal the null-pose members); the top level is open for
   diagnostics like calib.json; `align-room`'s stdout is the contents plus `ok: true` (never in the file).
10. **Align jobs** have ids `a-…`, carry `waiting_for` (members still calibrating) and are listed at the new routes
    `GET /api/rooms/jobs` and `/api/rooms/jobs/<id>`, not in `/api/scenes/jobs` (adding a third kind to `SceneJob`
    would have changed a type the planner and server switch on).
11. **POST /api/rooms starts no alignment**; the planner (and the hook's `createRoom`) asks with
    `POST /api/rooms/<room>/align` right after. `409` for an align with fewer than two members that have a photo.
12. **Applying an align result:** the server passes an **anchor** first (the first member whose pose the result can't
    change: `origin`/`manual`, else the first placed member, else the first) and composes the answer with the anchor's
    room pose and scale (formula in §4.9 Align); manual and origin members keep theirs unless `overwrite_manual`;
    answers for a member whose photo changed since (`photo_sha256`) are ignored.
13. **PUT /api/rooms/<room>** takes `members` as the whole new list (add, remove, reorder, poses, scales) plus two keys
    ROOMS didn't list: `reset: [scene]` (Align photos' Reset back to `align.json`, `pose_source: solver`) and
    `rescale: k` (Set scale: every scale and pose position × k, `pose_source` unchanged, so one tape measurement doesn't
    turn every pose `manual`).
14. **Additions to existing payloads are optional keys** so the current server stays valid in strict mode: scene object
    `room` (a rooms server always sends it), render request and meta `room` (present exactly when given), layout
    `room_name`, layout-deleted `room`, scene trash `room`. `GET /api/renders?room=` lists a room's renders.
15. **Server:** `--rooms-dir` (default `rooms/`); `rooms/` is never served statically.
16. **Hook:** in a room view every position is in the room frame (`addItem`, `moveItem`, `getState().items`, layouts,
    `floorToPhoto`, `photoToFloor`); `getCamera`/`setCamera` stay the photo's `scene.json` camera. Added beyond ROOMS:
    `floorPlanPoint([x, z])` (so E19 can drag on the canvas), `getRoom().members[].index`/`confidence`, and handles
    `floor-plan-toggle`, `room-delete`, `room-restore`, `room-add`, `room-remove`.
17. **Floor plan geometry** pinned for E19: +X right, −Z up, wedge 1.5 m long at the effective camera's horizontal FOV,
    turn handle 0.75 m along the view direction.
18. **Ownership:** foundation now also owns `docs/ROOMS.md`, `fixtures/make_scene.mjs`, `fixtures/check_scenes.py` (the
    task said to extend check:scenes; evals no longer owns those two) and `.gitignore` (for the `/rooms/` line, with
    toolchain's consent per ROOMS §5; that one line is the only change). `scripts/check-ownership.mjs` accepts
    `docs/notes/rooms-<track>.md` as a track's notes. `fixtures/scenes/room-*/**` and `fixtures/calib/rooms/**` were
    already foundation's through `fixtures/scenes/**` and `fixtures/calib/**`; calib's `calib/spike/**` is under
    `calib/**`.
19. **Fixtures:** the room photos' truth.json is entirely in the scene's own frame (objects, floor points, lights:
    sun and lamp positions moved through the pose), so every tool that reads a golden scene in its own frame keeps
    working; `pose_in_room`, `room` and `wall_check` are the only additions. lighting.json's key direction is in the
    photo's camera frame as for the five. The mock's `align.json` `created` is fixed (`2026-11-06T00:00:00Z`) so a
    re-render changes only what the photos change.
20. `docs/ROOMS.md` status line now points at CONTRACT §4.9 as the interface.

## Open issues

1. **`core/crates/geom/tests/golden.rs` (kernels) fails with the room fixtures:** it asserts exactly five scenes in
   `fixtures/scenes/` and every corner in front of the camera (room-6 has corners behind it). Fix, verified here and
   reverted (not my file): in `scenes()`, after parsing `truth`, `if truth.get("pose_in_room").is_some() { continue; }`.
   With it, `cargo test -p midstudy-geom --test golden` passes (5 tests). Until someone with kernels' or integration's
   ownership applies it, `check:rust` fails on this branch.
2. **calib's schema copy is stale:** `calib/scripts/gen_contract_types.py --check` says
   `name the $defs ['align_room'] of calib-cli.schema.json in SOURCES`, so calib's `test_generated_files_are_current`
   will fail until the calib track (Phase B) names `align_room` (e.g. `AlignRoomResult`) and regenerates its copies.
   Not run: calib's pytest (needs its uv environment).
3. **`fixtures/stub_calib.py` (evals track) needs `align-room`** with the §4.9 mock (key, rename, re-express, no-match
   answer) for fast evals; the contract says the stub implements it.
4. The room examples are hand-written; re-record them with `contract/tools/record-examples.mjs` once the server
   implements §4.9 (and add room cases to the recorder).
5. Not run: `check:rust` as a whole, `check:dead`, `check:tscert`, `check:planner`, `check:py`, `check:proofs`, any eval
   but E1 and E3. The five original scenes were not regenerated (see How to run).
