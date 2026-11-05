// Numbers, angles and clamps: v1's small helpers (planner/engine.js round, isNum, clampNum, wrapDeg, clampElev;
// lighting.js clamp, lum; lighting's wrapAz). Pure and self-contained, written for TScert (tscert/README.md): no
// Math.PI or trigonometry here; the kernels (core/js/web.ts) and the shells have those.

/** A JSON object as it came from the server or the hook: read at literal keys only. */
export type JsonObject = Readonly<Record<string, unknown>>

/** v1's round(v, n): Math.round(v · 10ⁿ) / 10ⁿ, n = 4 by default. */
export function round(v: number, n = 4): number {
  const k = 10 ** n
  return Math.round(v * k) / k
}

/** v1's isNum: a finite number. */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** v1's clampNum: v clamped to [lo, hi] when it is a finite number, else dflt. */
export function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dflt
  return Math.min(hi, Math.max(lo, v))
}

/** Math.min(hi, Math.max(lo, v)), v1's clamp (NaN stays NaN). */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

/** v1's wrapDeg: degrees into (−180, 180]. */
export function wrapDeg(d: number): number {
  let x = ((((d + 180) % 360) + 360) % 360) - 180
  if (x === -180) x = 180
  return x
}

/** v1's wrapAz: an azimuth into [−180, 180), except that a positive input landing on −180 gives 180. */
export function wrapAz(a: number): number {
  const w = ((((a + 180) % 360) + 360) % 360) - 180
  return w === -180 && a > 0 ? 180 : w
}

/** The highest an item's bottom may sit above the floor, m (contract §2.10). */
export const MAX_ELEVATION = 4

/** v1's clampElev: an elevation into [0, 4] m. */
export function clampElev(y: number): number {
  return Math.min(MAX_ELEVATION, Math.max(0, y))
}

/** v1's rotateSelected step: the new rotation_y_deg, wrapped and rounded to 6 decimals. */
export function turnBy(rotationYDeg: number, deg: number): number {
  return round(wrapDeg(rotationYDeg + deg), 6)
}

/** v1's nudgeElevation: the elevation asked for, to the millimetre (setElevation clamps it). */
export function nudged(y: number, dy: number): number {
  return Math.round((y + dy) * 1000) / 1000
}

/** v1's setElevation: the stored elevation for a requested one. */
export function elevationOf(y: number): number {
  return round(clampElev(y), 6)
}

/** Rec. 709 luminance of a linear RGB triple (v1's lum). */
export function lum(c: readonly [number, number, number]): number {
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}

/** Each number of a list rounded with round(v, n) (v1's r3 in getLighting). */
export function roundAll(v: readonly number[], n: number): number[] {
  const out: number[] = []
  for (const x of v) out.push(round(x, n))
  return out
}
