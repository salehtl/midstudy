// The reference for the room maps' differential test (proofs/diff/room/run.sh): contract §4.9 (docs/ROOMS.md §3.1)
// written out literally, with the names and signatures planner/logic/room.ts exports (the app track's file), so the
// harness can test either. JavaScript, not TypeScript, so it stays outside the tsconfig areas, lint and knip (proofs/
// is in none of them); the types are the contract's (contract/gen/types.ts Pose).
//
//   p_room  = Ry(yaw) · p_scene + (x_m, 0, z_m)
//   p_scene = Ry(−yaw) · (p_room − (x_m, 0, z_m))
//   Ry(a)   = [[cos a, 0, sin a], [0, 1, 0], [−sin a, 0, cos a]]
//   item rotation_y_deg: scene = room − yaw, then into (−180, 180]; room = scene + yaw, the same
//
// Lean: Midstudy/Room.lean proves these maps' properties over ℝ; Midstudy/RoomModel.lean is the same expressions over
// Float (`lake exe roommodel`), which the harness compares with this file (or room.ts) on random inputs.

/** @typedef {import('../../../contract/gen/types.ts').Pose} Pose */
/** @typedef {readonly [number, number, number]} Vec3 */

/** The planner's degrees-to-radians factor (`DEG = Math.PI / 180`). */
const DEG = Math.PI / 180

/**
 * engine.js `wrapDeg` (the kernels' wrapDeg, Midstudy.wrapDeg in proofs/Midstudy/Clamp.lean): the representative of
 * `d` in (−180, 180] mod 360.
 * @param {number} d
 * @returns {number}
 */
function wrapDeg(d) {
  const w = ((((d + 180) % 360) + 360) % 360) - 180
  return w === -180 ? 180 : w
}

/**
 * A point from a member photo's scene frame into the room frame.
 * @param {Vec3} p
 * @param {Pose} pose
 * @returns {[number, number, number]}
 */
export function sceneToRoom(p, pose) {
  const t = pose.yaw_deg * DEG
  const c = Math.cos(t)
  const s = Math.sin(t)
  return [c * p[0] + s * p[2] + pose.x_m, p[1], -s * p[0] + c * p[2] + pose.z_m]
}

/**
 * A point from the room frame into a member photo's scene frame.
 * @param {Vec3} p
 * @param {Pose} pose
 * @returns {[number, number, number]}
 */
export function roomToScene(p, pose) {
  const t = pose.yaw_deg * DEG
  const c = Math.cos(t)
  const s = Math.sin(t)
  const dx = p[0] - pose.x_m
  const dz = p[2] - pose.z_m
  return [c * dx - s * dz, p[1], s * dx + c * dz]
}

/**
 * An item's rotation_y_deg from the room frame into a member photo's scene frame: room − yaw, in (−180, 180].
 * @param {number} roomDeg
 * @param {Pose} pose
 * @returns {number}
 */
export function rotationToScene(roomDeg, pose) {
  return wrapDeg(roomDeg - pose.yaw_deg)
}

/**
 * An item's rotation_y_deg from a member photo's scene frame into the room frame: scene + yaw, in (−180, 180].
 * @param {number} sceneDeg
 * @param {Pose} pose
 * @returns {number}
 */
export function rotationToRoom(sceneDeg, pose) {
  return wrapDeg(sceneDeg + pose.yaw_deg)
}
