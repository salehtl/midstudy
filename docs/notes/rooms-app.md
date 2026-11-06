# rooms-app (docs/ROOMS.md Phase B, track app)

Branch `rooms-app`, cut from `rooms` (main + Phase A). Built from CONTRACT.md §4.5, §4.6 and §4.9 and the schemas in
`contract/`. No server with rooms exists yet: the UI was driven against a small fake of the §4.9 routes
(`planner/ui/test/rooms-fake.mjs`) in front of the real server.

## What exists now

| File | What |
|---|---|
| `planner/logic/room.ts` | Pure, TScert (38 functions + init, all certify). §4.9 frames: `sceneToRoom(p, pose)`, `roomToScene(p, pose)`, `rotationToScene(roomDeg, pose)`, `rotationToRoom(sceneDeg, pose)` (the fixed names the proofs' differential test imports; `Pose` is the contract's generated type, re-declared as `type Pose = ContractPose`), `wrapYaw`, `sinCosDeg` (own sin/cos: exact at multiples of 90°, within 1e-15 of Math's elsewhere; TScert has no Math.sin/cos), `clampPose`, `clampScale`, `effectiveCamera`, the wedge (`wedgeOf`, `yawToward`), footprints, `planHit` (hit tests), the plan view (`planFit`, `planZoom`, `planPan`, `planToCanvas`, `canvasToPlan`, `gridLines`, `boxAround`), the density map (`liftDepth`, `gridOver`, `cellsOf`, `densityKnee`, `densityAlpha`), and the room view's decisions (`photoToOpen`, `photoForKey`, `membersWithPose`, `membersAdding`, `membersRemoving`, `rescaleFactor`, `movedPose`, `samePose`). |
| `planner/ui/logic/rooms.ts` | Pure, TScert (11, all certify): room titles, card meta/status/flag, the photo note, Align photos' hint, New room's help text (ROOMS.md §7) and steps, Set scale's toast, plan colours. |
| `planner/engine.ts` | The room view. Room state (`room`, members with pose/scale/pose_source/cameras/confidence), `drawCam()` = the effective camera (only differs from `cam` in a room with scale ≠ 1), every piece's room-frame place (`ItemRec.roomAt`), photo switching (`openSceneAs(name, roomInfo)`: a cut, pieces re-projected in place, parked on an unplaced photo), room layouts (`?room=`, `room_name`, per-device choice under `@<room>`), render `room`, `?room=&photo=` landing and the last room, and the room API calls (list, get, create, align + follow, waitForRoom, openRoom, setRoomPhoto, setPose / previewPose / resetPose, setRoomScale, rename, add/remove photo, delete/restore). Hook conversions: `addItemHook`, `moveItemHook`, `photoToFloorHook`, `floorToPhotoHook`, `roomToSceneHook`, `sceneToRoomHook`. |
| `planner/wire.ts` | Tolerant readers for rooms (`roomInfo(s)`, `trashedRooms`, `alignJob`), the scene object's `room`, render meta `room`. |
| `planner/main.ts` | Hook: `listRooms`, `createRoom`, `waitForRoom`, `openRoom`, `setRoomPhoto`, `getRoom`, `setPose`, `roomToScene`, `sceneToRoom`, `floorPlanPoint`; `addItem`/`moveItem`/`floorToPhoto`/`photoToFloor` in the room frame in a room view; `getState().room`. |
| `planner/ui/room.ts` | Photo strip (`room-photo`, keys 1–9), the one-line note, the floor plan (`floor-plan` canvas, `floor-plan-toggle`; desktop: a 360 px column on the right, phone: a sheet over the dock), Align photos (`align-photos`, `align-reset`, Align again), plan drags (pieces move/turn, photos move/turn, tap places an unplaced photo), `ctx.floorPlan` (insets, `pointOf`). |
| `planner/ui/scenes.ts` | Room cards (`room-card`, `data-room`), New room (`room-new`, `room-files` multiple), the card menu (Rename, `room-add`, `room-remove` + `data-scene`, `room-delete`), Recently deleted rooms (`room-restore`, `data-room`), polling while a room calibrates or aligns. Scenes in a room are not shown as their own cards. |
| `planner/ui/workspace.ts` | Stage insets for the strip and plan (only in a room view), Adjust floor's Set scale becomes `room-scale` in a room view, the switcher shows the room's title. |
| `planner/styles/rooms.css` | `.rm-*` styles (linked from `index.html`). |
| `planner/ui/test/rooms-fake.mjs` | The fake §4.9 routes (rooms in memory, align from the calib mock's `fixtures/calib/rooms/<key>/align.json`, room layouts, render `room`, scene object `room`), proxying everything else to the real server. |
| `planner/ui/test/rooms-ui.mjs` | The headless check (51 checks; desktop WebGPU, phone 375 px, WebGL2 `?webgpu=0`). |
| `planner/engine.test.mjs`, `planner/ui/test/logic-vs-v1.mjs` | Room groups (no v1: against this repo's reading of the contract with Math's trig). |
| `tsconfig.planner.json` | Lists `contract/gen/types.ts` (the planner now imports the contract's `Pose`). |
| `tscert/baseline.json` | +49 entries (append only). |

## How to run

```
nix develop -c npm run build                         # wasm + planner
nix develop -c npm run test:engine                   # 18 groups (5 room groups)
nix develop -c npm run test:ui                       # logic-vs-v1 (room words) + bus
nix develop -c node scripts/eval-lock.mjs -- node planner/ui/test/rooms-ui.mjs   # the room view in headless Chrome
MIDSTUDY_WEBGPU=0 nix develop -c node scripts/eval-lock.mjs -- node planner/ui/test/rooms-ui.mjs   # whole run on WebGL2
nix develop -c node scripts/tscert-ratchet.mjs --files planner/logic/room.ts,planner/ui/logic/rooms.ts
```

The fake listens on 8860 upward; the real server picks a free port; both stop when the check ends. Output and
screenshots: `evals/out/rooms-app-ui/`.

## Decisions

1. **The world the furniture is drawn in stays the current photo's scene frame** (through the effective camera). Pieces
   keep their room-frame place (`roomAt`) and are re-projected when the photo, its pose or its scale changes. All of
   the single-scene machinery (drags, grip, snapping, nudges, screen rects, keep-room mask, lighting, splats, Export)
   works unchanged in the photo's frame; only the hook boundary, layouts, the plan and Undo read the room frame. No
   drift: switching photos never round-trips a position through floating point (the room place is kept as given).
2. **The scene camera vs the effective camera:** `cam` stays `scene.json`'s camera (Adjust floor, `getCamera`, Save
   scene); drawing, projection, picking, the depth pre-pass's scale and the drag plane use `drawCam()` (height × scale,
   clamped). Outside a room `drawCam()` is `cam` itself (same object), so the single-scene path is unchanged.
3. **Unplaced photo:** the room layout's pieces are parked (kept in the room frame, not drawn); `getState().items` is
   empty there, `addItem` refuses with "Place this photo on the floor plan first", a layout load fills the parked list,
   and saving still saves the parked pieces. Back on a placed photo they come back with their uids.
4. **Switching photos is a cut:** no loading card; the old photo stays until the new one is ready. A photo with an
   unsaved Adjust floor asks before switching (the strip and keys).
5. **Room layouts' per-device choice** uses the key `midstudy.layout.@<room>`; last photo per room
   `midstudy.roomPhoto.<room>`; the last room `midstudy.lastRoom` (cleared when a scene is opened on its own, so the
   landing follows what was opened last).
6. **Floor plan:** desktop 360 px column on the right (not a shell panel: a sixth panel would have pushed Renders under
   More on the phone and changed the single-scene phone UI); phone: a sheet over the dock and tool row, hidden by default
   (it is shown by default on desktop; remembered per device and mode). Density map: every member's `depth.png`
   decoded through the engine's worker, lifted with that member's effective camera (every 3rd pixel), 5 cm cells, a
   saturating opacity (knee = mean non-empty count). The current photo's handle is drawn always and grabbable in Align
   photos only; a selected piece shows a turn grip on the plan.
7. **Align photos:** a drag previews the pose locally (the photo view and the density map follow live) and saves on
   release (`PUT` the whole member list, the moved photo with its pose); Reset is `PUT {reset: [scene]}` for the photo
   last grabbed (else the current one); Align again is `POST …/align` without `overwrite_manual`.
8. **New room:** uploads one photo at a time, `POST /api/rooms`, then waits until two members have a `photo_url`
   before `POST …/align` (see open issue 1). The card shows "Uploading photo i of n…", then the room with
   "Calibrating n photos…" / "Aligning…".
9. **Room card menu:** `room-add` is the menu item; it opens a picker of the scenes in no room whose rows are
   `room-add-scene` with `data-scene` (a name I added; the contract names only `room-add`). `room-remove` items carry
   `data-scene`; `room-delete`/`room-restore` carry `data-room` too. Undo of a room delete is a toast action
   `room-undo`.
10. **Hook:** `roomToScene`/`sceneToRoom` return null for an unplaced (or unknown) photo; `floorToPhoto` returns
    `[NaN, NaN]` and `photoToFloor` null on an unplaced photo. `setPose(scene, null)` makes a photo unplaced.
    `getState().items[].worldBounds` in a room view is the piece's box placed at its room place.
11. **Renders panel in a room view** lists the room's renders (`GET /api/renders?room=`), every photo's.
12. **A server without rooms is never asked for `/api/rooms`** by the Scenes page (`engine.serverHasRooms()`: the scene
    objects carry `room`, which a rooms server always sends, §4.4); otherwise its 404 was a console error in E9 and E11.
13. The single-scene path: outside a room nothing is added to the DOM but the hidden strip/plan elements and the
    `room-new`/`room-files` controls on the Scenes page; the stage insets, layouts, landing and render bodies are as
    before (`getState()` gains `room: null`).

## Open issues for integration

1. **Contract seam, New room → align:** §4.9 says `POST …/align` is `409` "when fewer than two members have a
   `photo.jpg`", and the hook's `createRoom` "resolves when all three are accepted (202, 201, 202)". Right after the
   uploads a photo has no `photo.jpg` until its calibration job starts (ingest), so an immediate align would be 409 on
   a server that follows the first sentence. The app waits until two members show `photo_url` (up to ~10 min) before
   asking; `createRoom` resolves after that. The server could instead count members whose photo is pending; either
   way, say which in the contract.
2. Everything was tested against `planner/ui/test/rooms-fake.mjs`, not the server track's routes. To check at
   integration: room detail `members[].camera`/`effective_camera`/`scene_object` (the plan reads `scene_object.w/h`,
   `thumb_url`, `photo_url`; the strip too), `align` (`members[].confidence`, `unplaced`), `align_status` while
   waiting (`pending`), layouts `?room=` answers, render meta `room`, `GET /api/renders?room=`, the scene object's
   `room`. Run `planner/ui/test/rooms-ui.mjs` against the real server by pointing it at it (drop the fake: the
   checks call only §4.9 routes).
3. `room-add-scene` (decision 9) is a handle the contract doesn't name: E18/E19 may want it in §4.9's handle list.
4. Pre-existing on `rooms`: `check:tscert` fails on two baselined functions that are gone on the base branch
   (`planner/logic/input.ts#keyCommand`, `planner/ui/logic/workspace.ts#workspaceKey`). Not mine; I didn't remove them
   (shared-append). `--update` would; that is toolchain's or integration's call. My 49 entries are appended.
5. `check:rust` fails on the base branch (rooms-foundation open issue 1, `core/crates/geom/tests/golden.rs`); not run here.
6. Not done: a shell (fitted walls), a plan legend, pinch-zoom on the plan was only checked by code, not in a test;
   the plan's density map for very large rooms grows its cell (max 400 × 400 cells).

## Checks run (this worktree, final code)

- `check:types`, `check:lint`, `check:dead`, `check:planner` (test:engine 18/18 groups, logic-vs-v1 232,021 checks, bus)
- TScert: `--files planner/logic/room.ts` 39/39, `planner/ui/logic/rooms.ts` 11/11; `check:tscert` 774/816 with the two
  pre-existing stale entries failing (open issue 4); baseline appended by hand (+49) instead of `--update`
- `node scripts/check-ownership.mjs app --base rooms`: ok
- Through the lock: `planner/ui/test/rooms-ui.mjs` 51/51 (WebGPU) and 51/51 (`MIDSTUDY_WEBGPU=0`); eval:planner 56/56,
  eval:occlusion 21/21, eval:keys 52/52, eval:ux 29/29, eval:phone 49/49 (final code); eval:ux2 27/27 and eval:render
  38/38 on the code before the last fix (decision 12, which only touches the Scenes page's rooms request)
