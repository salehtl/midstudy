// The scene camera block (contract §4.1, §4.4): v1's default, ranges and `clamp_camera` (planner/serve.py). Every
// writer clamps; a value that isn't a finite number takes the default. Pure (TScert).
import { pyRound } from '../../../../common/logic/pyfmt.ts'
import type { Camera } from '../../../../contract/gen/types.ts'
import { isNum } from './values.ts'

/** v1 DEFAULT_CAMERA: no calibration yet, or it failed. */
export const DEFAULT_CAMERA: Camera = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }

/** The camera's keys in v1's order (CAMERA_RANGE). */
export const CAMERA_KEYS: readonly string[] = ['fov_y_deg', 'height_m', 'pitch_deg', 'roll_deg']

/** One value clamped to [lo, hi] and rounded to 6 places, as floats; the default when it isn't a finite number. */
function clampValue(v: unknown, lo: number, hi: number, fallback: number): number {
  return isNum(v) ? pyRound(Math.min(hi, Math.max(lo, v)), 6) : fallback
}

/** v1 `clamp_camera`: every value clamped to its range (fov 20–110, height 0.2–3.0, pitch −80…30, roll −20…20), a
 *  missing or non-numeric one the default. `cam` is the camera object, or null when it isn't one. */
export function clampCamera(cam: Readonly<Record<string, unknown>> | null): Camera {
  if (cam === null) return DEFAULT_CAMERA
  return {
    fov_y_deg: clampValue(cam['fov_y_deg'] ?? DEFAULT_CAMERA.fov_y_deg, 20, 110, DEFAULT_CAMERA.fov_y_deg),
    height_m: clampValue(cam['height_m'] ?? DEFAULT_CAMERA.height_m, 0.2, 3, DEFAULT_CAMERA.height_m),
    pitch_deg: clampValue(cam['pitch_deg'] ?? DEFAULT_CAMERA.pitch_deg, -80, 30, DEFAULT_CAMERA.pitch_deg),
    roll_deg: clampValue(cam['roll_deg'] ?? DEFAULT_CAMERA.roll_deg, -20, 20, DEFAULT_CAMERA.roll_deg),
  }
}

/** A camera patch merged into the camera in use, then clamped (v1 `update`: `clamp_camera({**clamp_camera(old),
 *  **patch})`). The patch's values were checked to be numbers; a key it doesn't carry keeps the current value. */
export function mergeCamera(current: Camera, patch: Readonly<Record<string, unknown>>): Camera {
  return clampCamera({
    fov_y_deg: patch['fov_y_deg'] ?? current.fov_y_deg,
    height_m: patch['height_m'] ?? current.height_m,
    pitch_deg: patch['pitch_deg'] ?? current.pitch_deg,
    roll_deg: patch['roll_deg'] ?? current.roll_deg,
  })
}
