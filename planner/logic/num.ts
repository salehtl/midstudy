// Numbers: v1's isNum and nudgeElevation step, the highest a piece may hang, and the kernels' small maths as the logic
// takes them. v1's round(v, n), the angle wraps and the Look's clamps are the kernels' (core/js/web.ts roundTo, wrapDeg,
// wrapAz, clampLook): they exist once, in Rust, and the shells pass them to the logic that needs them (Kernels). Pure
// and self-contained, written for TScert (tscert/README.md).

/** A JSON object as it came from the server or the hook: read at literal keys only. */
export type JsonObject = Readonly<Record<string, unknown>>

/** v1's isNum: a finite number. */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** The highest an item's bottom may sit above the floor, m (contract §2.10; the kernels' clampElevation keeps it). */
export const MAX_ELEVATION = 4

/** v1's nudgeElevation: the elevation asked for, to the millimetre (setElevation clamps it). */
export function nudged(y: number, dy: number): number {
  return Math.round((y + dy) * 1000) / 1000
}

/** The Look's numbers (contract §4.8), in the kernels' order (core/js/web.ts LOOK_KEYS). */
export type LookKey = 'exposure' | 'warmth' | 'light_azimuth_deg' | 'light_elevation_deg' | 'light_softness' | 'light_strength' | 'ambient'

/** The kernels' small maths (core/js/web.ts), passed in by the shell. */
export interface Kernels {
  /** v1's round(v, n): Math.round(v · 10ⁿ) / 10ⁿ. */
  roundTo(v: number, n: number): number
  /** Degrees into (−180, 180]. */
  wrapDeg(d: number): number
  /** v1's wrapAz: into [−180, 180), except that a positive input landing on −180 gives 180. */
  wrapAz(a: number): number
  /** One Look value clamped as v1 does (the azimuth wrapped first); null for a value that isn't finite. */
  clampLook(key: LookKey, v: number): number | null
}

/** Each number of a list rounded with roundTo(v, n) (v1's r3 in getLighting). */
export function roundAll(v: readonly number[], n: number, k: Kernels): number[] {
  const out: number[] = []
  for (const x of v) out.push(k.roundTo(x, n))
  return out
}
