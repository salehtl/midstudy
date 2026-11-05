// Camera clamps (contract §4.1; v1: planner/engine.js clampCamera, CAMERA_RANGE).
export interface Camera {
  readonly fov_y_deg: number
  readonly height_m: number
  readonly pitch_deg: number
  readonly roll_deg: number
}
export interface Range {
  readonly lo: number
  readonly hi: number
}
// What a client may send: anything per field (a PUT body after JSON.parse).
export interface CameraInput {
  readonly fov_y_deg?: unknown
  readonly height_m?: unknown
  readonly pitch_deg?: unknown
  readonly roll_deg?: unknown
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

export function clampIf(v: number, lo: number, hi: number): number {
  if (v < lo) return lo
  if (v > hi) return hi
  return v
}

export function clampOr(v: unknown, range: Range, fallback: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback
  return clamp(v, range.lo, range.hi)
}

export function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6
}

export function roundTo(v: number, digits: number): number {
  const k = 10 ** digits
  return Math.round(v * k) / k
}

export function clampCamera(c: CameraInput, base: Camera): Camera {
  return {
    fov_y_deg: round6(clampOr(c.fov_y_deg, { lo: 20, hi: 110 }, base.fov_y_deg)),
    height_m: round6(clampOr(c.height_m, { lo: 0.2, hi: 3 }, base.height_m)),
    pitch_deg: round6(clampOr(c.pitch_deg, { lo: -80, hi: 30 }, base.pitch_deg)),
    roll_deg: round6(clampOr(c.roll_deg, { lo: -20, hi: 20 }, base.roll_deg)),
  }
}

export function clampCameraPartial(c: Partial<Camera>, base: Camera): Camera {
  return {
    fov_y_deg: c.fov_y_deg === undefined ? base.fov_y_deg : clamp(c.fov_y_deg, 20, 110),
    height_m: c.height_m === undefined ? base.height_m : clamp(c.height_m, 0.2, 3),
    pitch_deg: c.pitch_deg === undefined ? base.pitch_deg : clamp(c.pitch_deg, -80, 30),
    roll_deg: c.roll_deg === undefined ? base.roll_deg : clamp(c.roll_deg, -20, 20),
  }
}

export function sameCamera(a: Camera, b: Camera): boolean {
  return (
    Math.abs(a.fov_y_deg - b.fov_y_deg) < 1e-6 &&
    Math.abs(a.height_m - b.height_m) < 1e-6 &&
    Math.abs(a.pitch_deg - b.pitch_deg) < 1e-6 &&
    Math.abs(a.roll_deg - b.roll_deg) < 1e-6
  )
}
