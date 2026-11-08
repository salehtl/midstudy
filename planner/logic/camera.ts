// The camera block (contract §4.1): v1's sameness test, the scene's dirty signature, the camera source after a change
// and where the floor check note comes from. Pure, for TScert (tscert/README.md). The ranges, the default camera, the
// clamp, the occlusion depth's scale and the projection itself are the kernels' (core/js/web.ts CAMERA_RANGE,
// DEFAULT_CAMERA, clampCamera, depthScale, SceneCamera).

export interface Camera {
  readonly fov_y_deg: number
  readonly height_m: number
  readonly pitch_deg: number
  readonly roll_deg: number
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

/** The camera_source after Reset: the saved one when the reset lands on the saved camera, else the calibration's (auto), or
 * default when it has no camera. */
export function sourceAfterReset(cam: Camera, hasCalibCamera: boolean, saved: Camera | null, savedSource: string): string {
  if (saved !== null && sameCamera(cam, saved)) return savedSource
  return hasCalibCamera ? 'auto' : 'default'
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

