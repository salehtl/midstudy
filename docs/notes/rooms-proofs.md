# Rooms, proofs track (Phase B, branch `rooms-proofs`)

docs/ROOMS.md §5 Phase B "proofs": contract §4.9's room frames in Lean 4 + Mathlib over ℝ, on top of the existing
camera (`Camera.lean`, `Depth.lean`), rotation (`Rotation.lean`, `Item.lean`) and clamp (`Clamp.lean`, `wrapDeg`)
development, plus a differential test of the maps against the TypeScript. Built from CONTRACT.md §4.9 directly.

## What was built

| File | What |
|---|---|
| `proofs/Midstudy/Room.lean` | the proofs (70 theorems, below) |
| `proofs/Midstudy/RoomModel.lean` | `sceneToRoomG`, `roomToSceneG`, `rotationG`: §4.9's formulas by components for any number type; `RoomFloat`: the same over `Float` (core Lean only, no Mathlib) |
| `proofs/RoomMain.lean`, `lakefile.toml` `[[lean_exe]] roommodel` | `lake exe roommodel CORPUS`: the Float model as a program (inputs and outputs as the hex bits of each double) |
| `proofs/diff/room/room_ref.mjs` | the reference implementation: §4.9 literally, with the names and signatures `planner/logic/room.ts` will export |
| `proofs/diff/room/harness.mjs`, `run.sh` | the differential test: seeded random inputs, the Lean model against the module under test |

`proofs/Midstudy.lean` imports both new modules, so `check:proofs` covers them.

## What is proved (`Midstudy/Room.lean`, all over ℝ, no sorry/admit/axiom)

`Pose` is `{x_m, z_m, yaw_deg}`; `Pose.sceneToRoom p = Ry(rad yaw) · p + (x_m, 0, z_m)`,
`Pose.roomToScene p = Ry(rad(−yaw)) · (p − (x_m, 0, z_m))`, with `Ry` and `rad` the existing ones (the item
rotation's), so the pose's yaw and `rotation_y_deg` are literally the same rotation.

| Theorem | What it guarantees |
|---|---|
| `Pose.roomToScene_sceneToRoom`, `Pose.sceneToRoom_roomToScene`, `Pose.toEquiv`, `roomToScene_eq_iff`, `*_injective` | the two maps are inverse both ways (a bijection) |
| `sceneToRoom_y`, `roomToScene_y`, `*_on_floor_iff` | the height (an item's elevation, `position[1]`) is the same in both frames; floor points stay on the floor and nothing else lands on it |
| `sceneToRoom_sub`, `sceneToRoom_dot_sub`, `Ry_mulVec_dot` | a pose moves things rigidly (distances kept) |
| `origin_sceneToRoom`, `origin_roomToScene` | the first member's pose `{0,0,0}` makes the room frame its scene frame |
| `sceneToRoom_camera`, `Pose.Ry_neg_z` | the photo's camera stands at `(x_m, h, z_m)` and looks along `(−sin yaw, 0, −cos yaw)` (§4.9's sentence) |
| `roomToScene_sceneToRoom_other` | A's point in B's frame: `Ry(yaw_A − yaw_B) · q + Ry(−yaw_B) · (t_A − t_B)` (the relative pose) |
| `roomR_eq`, `roomR_mem_SO3`, `roomCenter_eq`, `roomToCamera_eq`, `roomProject_eq` | taking a room point into the photo's scene frame and projecting with §4.1 is exactly §4.9's three.js camera at `(x_m, height_m, z_m)` with `rotation.set(pitch, yaw, roll, 'YXZ')` |
| `placed_in_A_drawn_in_B` | a pixel of photo A below its horizon has a floor point `q`; placed in the room it is on the floor, comes back to that pixel in A (in front of A), lands on B's floor at the relative-pose point, and B draws it exactly where its room camera projects it |
| `placed_in_A_drawn_in_B_effective` | the same chain through both members' **effective cameras** (scales `sA`, `sB`) |
| `rotationToScene_mem`, `rotationToRoom_mem` | `rotationToScene = wrapDeg(room − yaw)`, `rotationToRoom = wrapDeg(scene + yaw)` land in (−180, 180] |
| `rotationToRoom_rotationToScene`, `rotationToScene_rotationToRoom` (+ `_of_mem`) | round trips give `wrapDeg d`, so a stored angle exactly |
| `roomToScene_item`, `sceneToRoom_item` | carrying every point of an item (room position `pos`, rotation θ) with the pose is the item at `roomToScene pos` turned by `rotationToScene θ`: `scene = room − yaw` is the rotation that agrees with the pose |
| `sceneToRoom_x_toward_neg_z`, `sceneToRoom_quarter` | positive yaw turns the scene's +X toward the room's −Z (yaw 90: exactly −Z), the sign of `rotation_y_deg` |
| `effectiveCamera_eq`, `effectiveScale_of_mem`, `effectiveScale_pos`, `effectiveCamera_inRange` | the effective camera (`height_m × scale` clamped to 0.2–3) is the scene camera with height scaled by `k = effective height / height`; `k = scale` when `height_m × scale` is in range; in §4.1's ranges whenever the scene's camera is |
| `photoToFloor_y`, `effective_photoToFloor`, `smul_on_floor_iff` | the effective camera finds `k` times the floor points, which stay on the floor (the scene frame scaled about the floor point under the camera) |
| `effective_floorToPhoto`, `effective_depth`, `effective_occlusion` | `k · p` is drawn at `p`'s pixel at `k` times the depth; §4.5's `depth × height_m / calib height_m` with the effective height is exact (no new occlusion rule) |
| `floorMod_eq_toIcoMod`, `wrapYaw_eq_wrapDeg`, `wrapYaw_mem`, `wrapYaw_of_mem`, `Ry_rad_wrapYaw` | §4.9's yaw clamp `((yaw + 180) mod 360) − 180`, −180 → 180 (floored mod) is engine.js `wrapDeg`: in (−180, 180], identity there, never turns anything |
| `wrapYawJs_neg_270` | read with JavaScript's `%` the same formula leaves −270 at −270 (should be 90): see Observations |
| `clampPose_inRange`, `clampPose_of_inRange`, `clampPose_idem`, `clampScale_mem`, `clampScale_idem` | the pose and scale clamps land in range and are idempotent |
| `sceneToRoom_clampPose`, `roomToScene_clampPose`, `rotationToScene_clampPose` | clamping a pose whose position is in range changes neither map nor any item rotation |
| `applyAnswer_sceneToRoom` | §4.9 Align's rule (`yaw = yaw_a + yaw_k`, `(x,z) = (x_a,z_a) + s_a · Ry(yaw_a) · (x_k,z_k)`, `scale = s_a · s_k`) is the composition of the anchor's map with the answer's |
| `applyAnswer_rebase`, `rebase_applyAnswer` | the align mock's re-expression relative to the first argument is the inverse of that rule (for `s_a ≠ 0`) |
| `sceneToRoomG_real`, `roomToSceneG_real`, `rotationG_real`, `rotationG_neg_real` | `RoomModel.lean`'s generic formulas over ℝ are these maps: the executable model and the proved maps are one text |

Floats are tested, not proved: the Float model shares the expressions with the ℝ maps (`*_real` theorems), and the
differential test checks the TypeScript against it.

## How to run

```sh
# the proofs (from the repo root)
nix develop -c npm run check:proofs        # lake build, no sorry/admit/native_decide/axiom, CheckAxioms
proofs/run.sh lake exe cache get           # once per fresh worktree (Mathlib's oleans into proofs/.lake)
# the differential test of the room maps
nix develop -c proofs/diff/room/run.sh [N] # default 20000 cases per map; SEED=<n>; MIDSTUDY_ROOM_MODULE=<path>;
                                           # MIDSTUDY_ROOM_TOL=<tol> (default 1e-9); output in evals/out/proofs-diff-room/
```

The harness bundles the module under test with esbuild (as `planner/engine.test.mjs` does, so a `.ts` file with the
planner's `./x.js` specifiers and `import type` from `contract/gen/types.js` loads), writes a corpus of seeded inputs
as the exact bits of each double (positions ±60 m and some ±1000 m, poses ±50 m, yaws uniform in (−180, 180], whole
degrees, ±5000 and special values: ±0, ±90, ±180, 179.999999, 360, 540, 1e6 + 0.25, …), runs `lake exe roommodel` on
it and compares:

- `sceneToRoom`, `roomToScene`: each component within `TOL · max(1, |value|)`;
- `rotationToScene`, `rotationToRoom`: the answer in (−180, 180] and within TOL of the model's, mod 360;
- on the module alone, the round trips the Lean proves exactly (scene → room → scene, room → scene → room, the angle
  round trips back to `wrapDeg`) and the height passed through unchanged.

## Checks run in this session (worktree `rooms-proofs`)

- `nix develop -c npm ci`, `nix develop -c npm run build`: ok.
- `proofs/run.sh lake exe cache get`: ok (8,232 files).
- `nix develop -c npm run check:proofs`: `ok (26 files, 574 theorems, Lean 4.29.1, Mathlib v4.29.1)`; CheckAxioms:
  1,722 declarations under Midstudy, only the three standard axioms.
- `nix develop -c proofs/diff/room/run.sh` (20,000 per map, seed 20261107) against `room_ref.mjs`: every check ok;
  95 % of the position results bit for bit (19,049 and 18,836 of 20,000), the rest within 7.1e-15 relative (the
  `cos`/`sin` of macOS libm, which Lean's Float calls, and of V8 differ in the last bit for some inputs); both
  rotations 20,000/20,000 bit for bit.
- The same harness on a TypeScript copy of the reference (`.ts`, `import type { Pose } from
  '…/contract/gen/types.js'`, in `evals/out/`): ok, so the switch to `planner/logic/room.ts` loads.
- Mutants (in `evals/out/room-mutants/`): yaw sign flipped in both maps (the round trips still pass: only the model
  catches it), `wrapDeg` dropped from `rotationToScene`, −180 not written as 180: each fails.
- `nix develop -c npm run check:lint`, `check:dead`: ok (the new files are `.mjs` and Lean, outside eslint's and
  knip's sets). `node scripts/check-ownership.mjs proofs --base rooms`: ok.

## Decisions

- **Reuse, not redefine**: `Ry`, `rad`, `wrapDeg`, `CameraBlock`, `projectPhoto`, `photoToFloor`, `withHeight` are the
  existing ones. The pose's rotation is the item rotation's `Ry`, so "rotation sign agrees with rotation_y_deg" is
  both definitional and proved as a statement (`sceneToRoom_x_toward_neg_z`, `roomToScene_item`).
- **One text for the model and the proofs**: the executable model is not a second transcription; `RoomModel.lean`'s
  generic definitions are instantiated at ℝ (proved equal to the maps) and at `Float` (run).
- `RoomFloat.jsRem` computes JavaScript's `%` exactly (reduction by `n · 2^k`, each step exact by Sterbenz), so
  `wrapDeg` agrees bit for bit with the JS formula.
- The harness and the reference are `.mjs` (JSDoc types from `contract/gen/types.ts`): a `.ts` file under `proofs/`
  would belong to no tsconfig area and fail typed linting, and `eslint.config.js`/`tsconfig*.json` are toolchain's.
- The room diff is a separate script (like `proofs/diff/run.sh`), not part of `check:proofs`: `check:proofs` stays
  Lean-only and doesn't need `node_modules`. It takes about 3 s.
- `placed_in_A_drawn_in_B` is stated for any camera blocks; `_effective` instantiates it with the effective cameras.
  The clamp of `x_m`, `z_m` to ±50 is not exact (it moves points); the theorems about clamping say "when in range".

## Open issues for integration

1. **The one-line switch**: in `proofs/diff/room/harness.mjs`, change
   `const ROOM_MODULE = 'proofs/diff/room/room_ref.mjs'` to `const ROOM_MODULE = 'planner/logic/room.ts'` once the app
   track's file is merged (or run it once with `MIDSTUDY_ROOM_MODULE=planner/logic/room.ts`). Then
   `nix develop -c proofs/diff/room/run.sh`.
2. If `room.ts`'s functions need the kernels (e.g. the wasm `wrapDeg` through `Kernels`), the fixed signatures
   `rotationToScene(roomDeg, pose)` / `rotationToRoom(sceneDeg, pose)` can't receive them; the harness bundles the
   module but doesn't call `loadKernelsSync`. If room.ts loads kernels at module level, add that call to the harness
   (as `planner/engine.test.mjs` does).
3. If `room.ts` rounds a rotation (v1's `rotateBy` rounds to 6 decimals; §4.9 says only "into (−180, 180]"), the
   rotation checks fail at the default 1e-9: either the contract gains the rounding or room.ts drops it; for a run
   `MIDSTUDY_ROOM_TOL=1e-6` shows whether that is the only difference.
4. **Observation on the contract (§4.9 Ranges)**: `y = ((yaw + 180) mod 360) − 180` needs a *floored* mod. Read with
   JavaScript's `%` (truncated) it is wrong below −180 (`wrapYawJs_neg_270`: −270 stays −270, outside the range).
   The server and planner should use `wrapDeg` (or `((x % 360) + 360) % 360`); `wrapYaw_eq_wrapDeg` proves the
   floored reading is exactly `wrapDeg`. Not a contract change, a trap for implementers; worth a word in §4.9.
5. Not proved: the density map, wedges and hit tests (floor-plan geometry in room.ts), and the server's TS clamps
   themselves (only the contract's formulas). A diff of the server's `server/src/rooms/logic/` pose clamp and apply
   rule against `clampPose`/`applyAnswer` could be added the same way once that code exists.
