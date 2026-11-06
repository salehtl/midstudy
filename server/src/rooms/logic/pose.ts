// A member photo's pose, its scale and its effective camera (contract §4.9 Frames, poses and the effective camera):
// the clamps every writer applies, the composition an align answer goes through on its way into the room frame
// (§4.9 Align), Set scale. Pure (TScert).
//
//   p_room = Ry(yaw) · p_scene + (x_m, 0, z_m)        Ry(a) = [[cos a, 0, sin a], [0, 1, 0], [−sin a, 0, cos a]]
//
// Numbers are kept to 6 decimals (as the camera block: micrometres, microdegrees), so a pose sent back unchanged
// compares equal to the stored one.
import { pyRound } from '../../../../common/logic/pyfmt.ts'
import type { Camera } from '../../../../contract/gen/types.ts'

/** A pose in the room frame (room.schema.json $defs/pose). */
export interface Pose {
  readonly x_m: number
  readonly z_m: number
  readonly yaw_deg: number
}

/** The room frame's own pose: the origin member's. */
export const ORIGIN_POSE: Pose = { x_m: 0, z_m: 0, yaw_deg: 0 }

/** x_m and z_m range (m). */
const MAX_POSITION = 50
/** scale range. */
const MIN_SCALE = 0.25
const MAX_SCALE = 4
/** The camera's height range (contract §4.1), for the effective camera. */
const MIN_HEIGHT = 0.2
const MAX_HEIGHT = 3

/** `x` rounded to 6 decimals; 0 for a value that isn't finite (a writer never stores one). */
function six(x: number): number {
  if (!Number.isFinite(x)) return 0
  const r = pyRound(x, 6)
  return r === 0 ? 0 : r // no -0 in a file
}

function clampTo(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x))
}

/** A yaw brought into (−180, 180]: `((yaw + 180) mod 360) − 180`, then −180 becomes 180 (contract §4.9 Ranges). */
export function wrapYaw(yaw: number): number {
  const y = six(yaw)
  const m = (((y + 180) % 360) + 360) % 360
  const w = six(m - 180)
  return w <= -180 ? 180 : w
}

/** A pose as every writer stores it: x_m and z_m clamped to −50…50, yaw_deg into (−180, 180]. */
export function clampPose(x: number, z: number, yaw: number): Pose {
  return { x_m: six(clampTo(six(x), -MAX_POSITION, MAX_POSITION)), z_m: six(clampTo(six(z), -MAX_POSITION, MAX_POSITION)), yaw_deg: wrapYaw(yaw) }
}

/** A member's scale as every writer stores it: 0.25–4 (1 for a value that isn't a finite number). */
export function clampScale(s: number): number {
  if (!Number.isFinite(s)) return 1
  return six(clampTo(s, MIN_SCALE, MAX_SCALE))
}

/** Two poses are the same (after clamping both, to the stored precision). */
export function samePose(a: Pose | null, b: Pose | null): boolean {
  if (a === null || b === null) return a === b
  return a.x_m === b.x_m && a.z_m === b.z_m && a.yaw_deg === b.yaw_deg
}

/** The member's effective camera: its scene's camera with `height_m × scale`, clamped to 0.2–3.0 as every camera;
 *  the other three numbers are the scene's (contract §4.9 Scale). */
export function effectiveCamera(camera: Camera, scale: number): Camera {
  return {
    fov_y_deg: camera.fov_y_deg,
    height_m: six(clampTo(camera.height_m * scale, MIN_HEIGHT, MAX_HEIGHT)),
    pitch_deg: camera.pitch_deg,
    roll_deg: camera.roll_deg,
  }
}

/** A pose and scale in the room frame. */
export interface Placed {
  readonly pose: Pose
  readonly scale: number
}

/** cos and sin of a yaw (the shell computes them: TScert's library overlay has no Math.cos or Math.sin). */
export interface Turn {
  readonly cos: number
  readonly sin: number
}

/** An align answer's pose `P_k` and scale `s_k` (relative to the anchor) in the room frame, given the anchor's room
 *  pose `A` and scale `s_a` and `turn` = cos and sin of `yaw_a` (contract §4.9 Align):
 *  `yaw = yaw_a + yaw_k`, `(x, z) = (x_a, z_a) + s_a · Ry(yaw_a) · (x_k, z_k)`, `scale = s_a · s_k`, then clamped. */
export function composePose(anchor: Pose, anchorScale: number, turn: Turn, rel: Pose, relScale: number): Placed {
  // Ry(a) · (x, 0, z) = (cos a · x + sin a · z, 0, −sin a · x + cos a · z)
  const dx = turn.cos * rel.x_m + turn.sin * rel.z_m
  const dz = -turn.sin * rel.x_m + turn.cos * rel.z_m
  return {
    pose: clampPose(anchor.x_m + anchorScale * dx, anchor.z_m + anchorScale * dz, anchor.yaw_deg + rel.yaw_deg),
    scale: clampScale(anchorScale * relScale),
  }
}

/** Set scale on one member (contract §4.9 Set scale): its scale and its pose's x_m and z_m times `k`, then clamped;
 *  the yaw and an unplaced member's null pose stay. */
export function rescaled(pose: Pose | null, scale: number, k: number): { readonly pose: Pose | null; readonly scale: number } {
  return {
    pose: pose === null ? null : clampPose(pose.x_m * k, pose.z_m * k, pose.yaw_deg),
    scale: clampScale(scale * k),
  }
}
