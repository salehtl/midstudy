# midstudy rooms: one layout, several photos

Status: **Phase A** (written 2026-11-06 on `main` at `7536e25`). A1 (contract + fixtures) is on `rooms-foundation`:
[CONTRACT.md §4.9](../contract/CONTRACT.md) is the interface from now on, and where it differs from §3 below it wins
(the differences are listed in [docs/notes/rooms-foundation.md](notes/rooms-foundation.md)). The work runs as dynamic workflows, one per
phase, shaped like [REFACTOR.md](REFACTOR.md) §5–§9 and Anthropic's "Building agents: when to fold subagents into your
main agent loop" (§10 here). Read this file, then CONTRACT.md §4, before starting anything.

A demo of the goal (a modeled room standing in for real photos) was shown to the user: four fixed photo views, a floor
plan, and a plain 3D overview. It's an Artifact, not code in this repo; nothing in it is meant to be ported.

---

## 1. What we are building

Today a scene is **one photo**. Its camera stands at x = z = 0 facing −Z (contract §4.1), and its layouts live in that
frame. The user can't see the same furniture from another corner of the room.

A **room** groups several scenes (photos of the same room, taken from different spots) into **one shared frame**:

- Each photo stays a scene, unchanged: its own `photo.jpg`, camera block, `depth.png`, `lighting.json`, occlusion,
  Look, renders and keep-room. Nothing about the single-photo path changes.
- A room knows where each photo was taken: a **pose** per member scene (position on the floor and direction).
- A **room layout** places furniture once, in the room's frame. Each photo shows it from where that photo was taken,
  photoreal, hidden behind the real room exactly as today.
- The user **switches between photos**. There is no free roaming: between photos there is nothing real to show.
- A **floor plan** shows the room from above: the photos' positions and view wedges, the furniture, and the room's
  shape as seen by the photos' depth. Furniture can be dragged there too.

**Out of scope** (decide after Phase D, §6): a fitted wall/ceiling shell, a 3D overview, generative world models,
RoomPlan import, an agent that models the room. Free roaming is not a goal.

### Success, in the user's terms

1. Take 6–12 photos of a room with any phone, plus one tape measurement.
2. Upload them as a room. Within a minute or two the photos are aligned, or the user fixes the alignment by hand on the
   floor plan in under two minutes.
3. A sofa placed from one photo stands in the right spot in every other photo: on the floor, at the right size, behind
   the real table where it should be.
4. A spot the user measures with a tape (e.g. "sofa 40 cm from the window wall") reads within **5 cm** in every photo.

---

## 2. Decisions already made (with the user, 2026-11-06)

- **Switch between viewpoints, no free roaming.** Splat scenes and projected-texture rooms aren't reliable enough;
  the photo view is the only view that has to look real.
- **Alignment is code, not an agent.** A pose solver plus MoGe plus the floor does the geometry. An agent reasoning
  over depth numbers would be worse than RANSAC.
- **Photos only.** Any phone, the normal Camera app. RoomPlan (LiDAR) isn't required; at most it's a one-off way to
  measure the truth for the real-path check (§6).
- **Manual alignment is the floor of the feature.** Whatever the solver does, the user can drag and turn each photo's
  wedge on the floor plan until the photos' depth lines up. So the feature works even when no solver runs.
- **The pose solver is swappable.** Candidates: Solv3R (`github.com/ubc-vision/solv3r`, released 2026-11-05, Apache-2.0
  code, **NVIDIA non-commercial weights**: fine for this personal tool, a blocker if it ever becomes a product), VGGT,
  MASt3R, and a no-ML fallback that snaps walls to two square directions (Manhattan) from MoGe's normals. Phase A
  picks one on numbers (§5).

---

## 3. The model

### 3.1 Frames and poses

Every scene keeps its own frame (contract §4.1: camera at x = z = 0, yaw 0, floor y = 0). Because every scene's floor
is the same floor (y = 0) and pitch and roll come from each scene's own floor fit, the only unknowns between two photos
are a **position on the floor, a turn about Y, and a scale**.

A member's **pose** `{x_m, z_m, yaw_deg}` maps its scene frame into the room frame:

```
p_room  = Ry(yaw) · p_scene + (x_m, 0, z_m)
p_scene = Ry(−yaw) · (p_room − (x_m, 0, z_m))
Ry(a)   = [[cos a, 0, sin a], [0, 1, 0], [−sin a, 0, cos a]]     (positive = counterclockwise seen from above,
                                                                  +X turns toward −Z: the same sign as rotation_y_deg)
item rotation_y_deg: scene = room − yaw;   elevation (position[1]) is unchanged
```

The room frame is the first member's frame (pose `{0, 0, 0}`) unless the user moves it.

**Scale:** each member also has `scale` (default 1). The member's **effective camera** is its scene camera with
`height_m × scale` (clamped as usual). Contract §4.5 already scales `depth.png` by `height_m / calib height_m`, so
occlusion follows the effective camera with no new rule. Joining a room **never rewrites `scene.json`**: the scene
opened on its own looks as before.

The room's absolute scale comes from **one tape measurement**: the room's Set scale (the existing ruler, used in any
member photo) multiplies every member's `scale` by the same factor.

### 3.2 Files

```
rooms/<room>/room.json             room.schema.json: title, members [{scene, pose, scale, pose_source}], align
rooms/<room>/align.json            the solver's last answer (align.schema.json): poses, scales, confidence, residuals
layouts/@<room>/<layout>.json      room layouts: layout.schema.json with room_name instead of scene_name
```

- `pose_source` per member: `solver`, `manual` (the user moved it; a later solve never overwrites it unless the user
  asks), `origin` (the first member).
- A scene belongs to **at most one room**. Deleting a scene removes it from its room (its pose goes to the room's
  trash entry, so Restore puts it back). Deleting a room never deletes its scenes.
- `rooms/` is user data: git-ignored like `scenes/`.
- The `@` keeps room layout folders from colliding with scene names (slugs never start with `@`). Phase A may choose
  another spelling; it must be impossible for a scene name.

### 3.3 Server (contract §4.9, new)

| Route | What |
|---|---|
| `GET /api/rooms` | rooms, newest first, each with its members' scene objects (§4.4) and poses; `trash` |
| `POST /api/rooms` | `{title, scenes: [name, ...]}` → `201` the room; `409` if a scene is in another room |
| `GET /api/rooms/<room>` | room.json + member scene objects + `align` (align.json or null) + `align_status` |
| `PUT /api/rooms/<room>` | any of `title`, `members` (add, remove, reorder), poses, scales; clamped; `pose_source` set to `manual` for a pose that changed |
| `POST /api/rooms/<room>/align` | `202 {job}` on the **calibration queue** (kind `align`, id `a-…`); waits for members still calibrating; `409` while one runs |
| `DELETE /api/rooms/<room>` / `POST …/restore` | trash, as scenes |
| `GET/PUT/DELETE /api/layouts…?room=<room>` | room layouts; exactly one of `scene` and `room` (`400` otherwise) |
| `POST /api/render` | gains optional `room`; the capture is per member photo as today, `scene` names the photo |

Every mutating route follows §2.9. Strict mode validates every answer and file. Uploading a set of photos as a room is
the planner calling `POST /api/scenes` per photo, then `POST /api/rooms`; there's no multi-file upload route.

### 3.4 Calibration (contract §4.3, new command)

```
midstudy-calib align-room <scene-dir> <scene-dir> ... --out <room-dir> [--solver auto|<name>|manhattan] [--device ...]
```

- Reads each member's `photo.jpg`, `calib.json` and `depth.png`; writes `align.json` only (atomic). Never touches the
  scenes.
- Output per member: pose, scale relative to the first member, `confidence` (0–1), and the residual it measured (the
  median distance between overlapping depth points after alignment, in cm). Room-level: `solver`, `loop_residual_cm`,
  and `unplaced: [scene, ...]` for photos it couldn't place (they keep no pose; the planner asks the user to place them).
- Also a worker command (`{"cmd": "align-room", ...}`, contract §4.3 Worker), so models load once.
- **Mock:** with `MIDSTUDY_CALIB_MOCK`, look up `<dir>/rooms/<sha256 of the members' photo sha256s, sorted, joined
  with "\n">/align.json`; no match writes every member as `unplaced`.
- Heavy dependencies (the chosen solver) go in an optional uv extra so `midstudy-calib` without them still runs and
  answers `manhattan` or `unplaced`. Weights are cached outside the repo, like MoGe's.

### 3.5 Planner (contract §4.5, additions)

- **Scenes page:** rooms show as one card with their photos inside; **New room** takes several photos at once
  (`<input type=file multiple accept="image/*">`). A scene can be added to or removed from a room.
- **Room view:** the current photo fills the view exactly as a scene does today. A **photo strip** (numbered
  thumbnails) switches photos; keys `1`–`9`. Switching is a cut, not an animation through space.
- **Floor plan** panel (desktop: beside the view; phone: a sheet): top-down, room frame, 50 cm grid; each member's
  position, number and view wedge; furniture footprints (selectable, draggable, turnable); and the room's shape: each
  member's `depth.png` lifted into the room frame, points between 0.1 m and 2.0 m high, drawn as a faint density map
  (walls show as dark lines where the photos agree). Drawn in 2D on a canvas.
- **Manual alignment** (**Align photos** mode on the floor plan): drag a wedge to move a photo, drag its handle to turn
  it; the density map updates live, so walls from two photos visibly snap together when right. **Reset** goes back to
  the solver's answer.
- **Layouts:** a room view loads and saves room layouts; each photo shows them through its pose (§3.1). Every
  per-scene feature (occlusion, Look, lighting, render, keep-room, elevation, missing items, Export) works per photo
  with no change in meaning.
- **Hook additions** (`window.midstudy`): `listRooms`, `createRoom(files, meta)`, `waitForRoom`, `openRoom(name,
  photo?)`, `setRoomPhoto(scene)`, `getRoom()` (members, poses, effective cameras), `setPose(scene, partial)`,
  `roomToScene(p)`, `sceneToRoom(p)`, and `getState().room`. Test handles: `room-new`, `room-files`, `room-card`,
  `room-photo` (with `data-scene`), `floor-plan`, `align-photos`, `align-reset`, `room-scale`.

### 3.6 Out of the planner's way

- No change to the camera model, the render pipeline, keep-room, lighting inference or the library.
- A scene opened outside its room behaves exactly as before; its own layouts stay usable.

---

## 4. Ownership for this work

Post-refactor tracks (CLAUDE.md, `scripts/ownership.json`), plus these additions made in Phase A:

| Track | Owns in this work |
|---|---|
| foundation | `contract/**` (room/align/layout schemas, routes, CONTRACT §4.9 and the §4.3/§4.5/§4.6 additions), `fixtures/scenes/room-*/**`, `fixtures/calib/rooms/**`, **`fixtures/make_scene.mjs` (added to foundation for this work)**, `.gitignore` entry for `rooms/` (via toolchain, see below), this file |
| calib | `calib/**`, the solver spike under `calib/spike/` |
| server | `server/**`, `common/**` |
| app | `planner/**` |
| proofs | `proofs/**` |
| evals | `evals/**` (new evals E18–E20), `fixtures/**` but the golden scenes |
| toolchain | `.gitignore`, `tscert/**`, `scripts/**` but foundation's (any new `npm run` scripts go through `package.json`, shared-append) |
| integration | everything (Phase C) |

Shared-append as always: `package.json`, `package-lock.json`, `core/Cargo.lock`, `tscert/baseline.json`, `knip.json`.

---

## 5. Phases and workflows

One workflow per phase. The main session reads each phase's real results (re-running the gates itself) before starting
the next. Parallel agents each work in **their own worktree and branch** (`rooms-<track>`, under
`.claude/worktrees/rooms-<track>/`), only on their own paths. Only Phase C's integration agent writes `main`. Nothing
is pushed. The rules of REFACTOR.md §7 apply to every agent, word for word.

### Phase A: interfaces and the solver choice (`rooms-foundation`, 2 agents in parallel)

**A1 contract + fixtures** (track foundation; also adds the §4 ownership entries and the `rooms/` git-ignore line with
toolchain's consent, i.e. it may touch `.gitignore` for that one line):
- CONTRACT.md §4.9 Rooms, written from §3 above (resolve anything this plan leaves open and say so in the notes):
  `room.schema.json`, `align.schema.json`, `layout.schema.json` (`room_name`, exactly one of the two), the API schemas
  and `routes.json` entries, the worker command, the hook. `node scripts/gen-contract.mjs`; `check:gen` clean.
- **Golden room fixtures**: extend `fixtures/make_scene.mjs` to render the existing golden room from **6 new cameras**
  around it (different positions, yaws, heights 1.2–1.6 m, pitch −5…−20°, small rolls), as scenes
  `fixtures/scenes/room-<n>/` with the usual files, and `truth.json` gaining `pose_in_room {x_m, z_m, yaw_deg}`
  (room frame = `living-wide`'s). Include one pair with little overlap and one photo facing a blank wall (the hard
  cases). `fixtures/calib/` copies for the mock, and `fixtures/calib/rooms/<key>/align.json` with the **true** poses
  (the mock answer). `check:scenes` extended: every truth pose projects the sofa's corners onto its ids mask.
- Returns: the schemas' URIs, the mock key rule, anything it changed from this plan.

**A2 solver spike** (track calib, **new files only** under `calib/spike/`, nothing wired in):
- Run each candidate (Solv3R, VGGT, MASt3R, Manhattan) through one script that takes N scene folders and prints poses
  and scales in the §3.1 convention (re-expressed: floor-up from each scene's own calib, then a 2D similarity on the
  floor).
- On the golden room fixtures as soon as A1 lands them (until then, on the user's real photos only), and on the
  user's real photos in `fixtures/photos/` (read its `notes.md`; **never** `fixtures/photos/private/`; never commit a
  photo or anything derived from one).
- Measure per candidate: pose error against truth (cm, degrees), scale error, unplaced photos, run time on this Mac
  (MPS or CPU), peak memory, install size, licence. On real photos (no truth): loop residual and the median wall
  residual between photos.
- Returns a table and a recommendation. **Gate A (main session + user):** the user picks the solver (licence and run
  time are theirs to judge); the main session re-runs the spike on the golden fixtures before agreeing.

**Target** (golden fixtures): yaw within 1.5°, position within 5 cm, scale within 2 %; no more than one unplaced photo,
and never a wrong placement presented with high confidence.

### Phase B: build (`rooms-build`, 5 agents in parallel, each from the contract alone)

- **calib:** `align-room` (one-shot and worker) with the chosen solver behind a `Solver` protocol, Manhattan as the
  no-dependency fallback, the mock, validation of `align.json` before writing (`MIDSTUDY_STRICT`), pyright strict,
  ruff, pytest (including the golden room fixtures against truth, at the Phase A targets). Notes measure run time
  cold and warm.
- **server:** the §3.3 routes, rooms on disk (atomic writes, trash/restore), the align job on the calibration queue
  (waits for calibrating members, one per room), room layouts, render's `room`; scene deletion updates its room.
  `server/src/rooms/logic/` pure and TScert'd (membership rules, pose clamping, the effective camera).
  `npm run test:server` gains rooms tests; strict mode on.
- **app:** `planner/logic/room.ts` (pure, TScert: §3.1 transforms both ways, effective camera, density-map binning
  of depth points, wedge geometry, hit tests), the room view and photo strip, the floor plan and Align photos mode,
  room layouts, New room (multi-file), the hook additions, both renderers (WebGPU and `?webgpu=0`). `test:engine`
  and `test:ui` gain room cases. The single-scene path must stay byte-for-byte the same in its evals.
- **proofs:** Lean, over ℝ: the §3.1 pose maps are inverse to each other; composition (a point placed from photo A
  projects in photo B exactly where §4.1 says, via the poses); rotation sign agrees with `rotation_y_deg`; the
  effective-camera scaling keeps floor points on the floor. Diff the Lean model of `roomToScene` against the TS on
  random inputs, as `proofs/diff/` does for the kernels.
- **evals:** E18 rooms API (every route, every error, trash/restore, scene deletion inside a room, strict mode),
  E19 room planner (open a golden room with the **true** poses via the mock; place the sofa in one photo; in every
  other photo `getScreenRect` matches truth's projection within 3 px, its ids mask overlap holds, occlusion hides it
  behind the table where truth says; switch photos with keys; drag on the floor plan; Align photos moves a wedge and
  saves `pose_source: manual`; a phone pass at 375 px), E20 alignment (`--mock` checks the plumbing; the real run
  checks the chosen solver on the golden room fixtures at the Phase A targets). E18 and E19 and `E20 --mock` join
  `eval:all`; the real E20 joins `eval:calib`.

Each agent returns the REFACTOR §5 structured result (status, branch, commit, the checks and evals it actually ran,
interfaces it provides, decisions, open issues) and writes `docs/notes/rooms-<track>.md`.

### Phase C: integrate (`rooms-integrate`, **one** agent)

Merges the five branches into `main`, reconciles the seams (hook ↔ evals, routes ↔ planner, worker ↔ server), runs
`npm run check` and `eval:all` **twice** on WebGPU and once on `?webgpu=0`, `eval:calib` with real MoGe and the real
solver, and commits. Updates CLAUDE.md's layout and evals sections and `docs/STATUS.md`. Notes in
`docs/notes/rooms-integrate.md`.

### Phase D: the real room (main session, with the user)

- The user takes 8–12 photos of one room (§7) and one tape measurement, plus 3–4 spots measured from two walls (e.g.
  "the table's left front leg: 1.20 m from the window wall, 0.85 m from the door wall").
- `eval:real-room` (new in Phase B's evals track, not in `eval:all`): real MoGe, the real solver, the user's photos;
  checks the measured spots in every photo (within 5 cm after Set scale), loop residual, time from upload to aligned.
- If the solver fails on real photos, time the manual alignment instead: the feature ships if a person can align the
  room by hand in under two minutes.
- The user decides what's next (§6). Optional: if the user has a LiDAR iPhone, one RoomPlan scan of the same room
  gives true wall positions to compare against; that's a measuring stick, not a feature.

---

## 6. After this plan (not part of it)

Decided by the user after Phase D, each its own plan: a fitted room shell (walls and ceiling from MoGe planes in the
room frame) and a plain 3D overview built on it; renders that use two photos of the room as references; RoomPlan
import as an optional input.

---

## 7. Taking the photos (for the user, and for the planner's New room help text)

- Walk the edge of the room and take a photo every metre or so, **8–12 photos**, each pointing across the room. Neighbouring
  photos should share about half their view. Corners alone (4 photos) usually overlap too little.
- Hold the phone at chest height, level, landscape. Use the normal 1× lens, not ultra-wide or zoom, and don't crop.
- Lights the same in every photo; no people or pets moving between shots.
- Measure one long, straight distance on the floor (a wall's length, a rug's edge) for Set scale.

---

## 8. Risks and fallbacks

| Risk | Fallback |
|---|---|
| No solver handles a few wide-baseline photos | more photos with more overlap (§7); manual alignment on the floor plan is always there |
| The chosen solver needs CUDA and won't run on MPS | CPU if fast enough (measured in Phase A); otherwise Manhattan + manual; never a cloud call without the user's OK (it would send photos out) |
| Solver weights' licence (Solv3R: non-commercial) | recorded in `calib/` notes and §2; fine for personal use; revisit only if midstudy is ever shared |
| Per-photo MoGe scale disagrees by a few % | per-member `scale` from the solver, then one tape measurement for the room (§3.1) |
| Floor fits disagree (a member's pitch/roll off) | that photo's Adjust floor, as today; the room re-aligns that member only |
| Two photos place the sofa slightly differently | expected within the §1 target; E19 pins the math on truth, Phase D measures the real error |
| Users mix photos of two rooms | the solver reports `unplaced`; the planner says so in one line and offers to remove them |
| `main` moves during Phase B | the integration agent ports new `main` commits before merging, as REFACTOR's finish agent did |

---

## 9. Rules for every agent (in addition to REFACTOR.md §7 and CLAUDE.md)

- The interfaces are the contract (Phase A). Phase B agents read CONTRACT.md §4.9 directly; nobody passes summaries of
  it along. If the contract is wrong or unclear, say so in your notes and return `partial`; don't invent an interface
  another track depends on.
- Never commit the user's photos, anything derived from them (depth, poses, thumbnails), or solver weights. Spike and
  eval output goes to `evals/out/` (git-ignored).
- The single-photo path is not to change: its evals must pass unchanged at every step.
- Report only checks you ran; "partial" with precise open issues beats a false "done".

---

## 10. How this follows the article

The article's default is **one agent loop**. Subagents are worth it when a single loop would degrade from context
bloat, when independent work can run in parallel with fresh, discardable context, or when one agent would struggle to
pick tools. Here:

1. **Divide by context, not by problem type.** Each Phase B agent owns one component end to end (calib, server,
   planner, proofs, evals) and its own tests. They share only the contract. There are no "test writer" or "reviewer"
   agents working on someone else's files: that's the telephone game the article warns about.
2. **Keep chained work in one loop.** The contract and the golden fixtures that pin it are one agent (A1), because the
   truth poses and the schemas must agree. Merging is one agent (C), because it needs context across everything.
   Phase D stays in the main session, because it needs the user.
3. **Parallelize only what is independent.** The solver spike (A2) needs nothing from A1 to start and its result
   doesn't change the contract (the solver hides behind `align-room`). So it runs alongside A1. Phase B's five agents
   build against interfaces that already exist.
4. **Evals first, owned centrally.** The golden room fixtures and their truth come before any feature code. E18–E20
   are written against the contract in Phase B, in parallel with the code, by the evals track rather than by the code's
   authors. The main session re-runs the gates itself between phases instead of trusting reports.
5. **Hard preconditions live in tools.** Ownership, the eval lock, strict mode, the calib mock and the money guard are
   scripts that refuse. They aren't instructions to remember.
6. **One change at a time, measured.** The solver is chosen on numbers before it's built in. Each phase is read before
   the next fan-out. Evals run twice, because one failure in two runs is still a failure.
7. **The main loop keeps the conversation.** The user decides at Gate A (solver, licence) and after Phase D (what's
   next). No agent talks to the user directly.
