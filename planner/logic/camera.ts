// The camera block (contract §4.1): ranges, the default, v1's clamp, merge and sameness tests, where the floor check
// note comes from, and the occlusion depth's scale (§4.5). Pure, for TScert (tscert/README.md). The projection itself
// is the kernels' (core/js/web.ts SceneCamera).
import { clampNum, round } from './num.js'

export interface Camera {
  readonly fov_y_deg: number
  readonly height_m: number
  readonly pitch_deg: number
  readonly roll_deg: number
}

/** A camera block as it may come in (a scene's JSON, the hook): anything per field. */
export interface CameraInput {
  readonly fov_y_deg?: unknown
  readonly height_m?: unknown
  readonly pitch_deg?: unknown
  readonly roll_deg?: unknown
}

/** Every writer clamps to these (contract §4.1), [lo, hi]. */
export const CAMERA_RANGE = {
  fov_y_deg: [20, 110],
  height_m: [0.2, 3.0],
  pitch_deg: [-80, 30],
  roll_deg: [-20, 20],
} as const

/** The camera without a calibration (contract §4.1). */
export const DEFAULT_CAMERA: Camera = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }

/** v1's clampCamera(c, base): each field clamped and rounded to 6 decimals; a missing or non-finite one takes base's. */
export function clampCamera(c: CameraInput | null, base: Camera): Camera {
  return {
    fov_y_deg: round(clampNum(c?.fov_y_deg, 20, 110, base.fov_y_deg), 6),
    height_m: round(clampNum(c?.height_m, 0.2, 3.0, base.height_m), 6),
    pitch_deg: round(clampNum(c?.pitch_deg, -80, 30, base.pitch_deg), 6),
    roll_deg: round(clampNum(c?.roll_deg, -20, 20, base.roll_deg), 6),
  }
}

/** v1's setCamera merge: the finite numbers of `p` over `cam`, then clamped with `cam` as the base. */
export function mergeCamera(cam: Camera, p: CameraInput): Camera {
  const pick = (v: unknown, d: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : d)
  return clampCamera(
    {
      fov_y_deg: pick(p.fov_y_deg, cam.fov_y_deg),
      height_m: pick(p.height_m, cam.height_m),
      pitch_deg: pick(p.pitch_deg, cam.pitch_deg),
      roll_deg: pick(p.roll_deg, cam.roll_deg),
    },
    cam,
  )
}

/** v1's sameCamera: every field within 1e-6. */
export function sameCamera(a: Camera, b: Camera): boolean {
  return (
    Math.abs(a.fov_y_deg - b.fov_y_deg) < 1e-6 &&
    Math.abs(a.height_m - b.height_m) < 1e-6 &&
    Math.abs(a.pitch_deg - b.pitch_deg) < 1e-6 &&
    Math.abs(a.roll_deg - b.roll_deg) < 1e-6
  )
}

/** A copy of a camera block, fields in contract order. */
export function cameraCopy(c: Camera): Camera {
  return { fov_y_deg: c.fov_y_deg, height_m: c.height_m, pitch_deg: c.pitch_deg, roll_deg: c.roll_deg }
}

/** What a scene's camera must match to stay unsaved (v1's sceneSig: the Look saves itself, so the camera alone). */
export function sceneSig(c: Camera): string {
  return JSON.stringify([c.fov_y_deg, c.height_m, c.pitch_deg, c.roll_deg])
}

/** v1's camera_source after a live change: the saved one while the camera equals the saved camera, else manual. */
export function sourceAfterChange(cam: Camera, saved: Camera | null, savedSource: string): string {
  return saved !== null && sameCamera(cam, saved) ? savedSource : 'manual'
}

/** What calib.json says about the floor, as the floor note needs it (v1's floorNoteFor reads these). */
export interface CalibFacts {
  /** calib.json is there (the scene's `calib` is truthy). */
  readonly has: boolean
  /** its floor.found is exactly false */
  readonly floorNotFound: boolean
  /** its source */
  readonly source: unknown
  /** the scene's calib_status */
  readonly status: unknown
  /** the scene's calib_error as text, '' when it has none */
  readonly error: string
}

/** v1's floorNoteFor: the "Check the floor" line Adjust floor opens with, or null when the calibration is trusted. */
export function floorNote(c: CalibFacts): string | null {
  if (!c.has) {
    if (c.status === 'failed') return `Calibration failed${c.error ? ` (${c.error})` : ''}: set the floor by hand.`
    return 'No calibration yet: set the floor by hand.'
  }
  if (c.floorNotFound) return "Check the floor: the photo's floor wasn't found."
  if (c.source !== 'moge-2' && c.source !== 'truth') return `Check the floor: the camera is a guess (${c.source === 'exif' ? 'from the lens' : 'a default'}).`
  return null
}

/** v1's depthScale (contract §4.5): height / calib height when the floor was measured (moge-2 or truth), else 1.
 * `calibHeight` is Number(calib.camera.height_m), NaN when unmeasured. */
export function depthScaleOf(heightM: number, measured: boolean, calibHeight: number): number {
  return measured && calibHeight > 0 ? heightM / calibHeight : 1
}
