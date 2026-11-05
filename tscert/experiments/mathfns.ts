// Math functions the geometry uses.
export function floorTo(v: number, step: number): number {
  return Math.floor(v / step) * step
}

export function truncated(v: number): number {
  return Math.trunc(v)
}

export function signOf(v: number): number {
  return Math.sign(v)
}

export function sqrtOf(v: number): number {
  return Math.sqrt(v)
}

export function powHalf(v: number): number {
  return v ** 0.5
}

export function sinDeg(d: number): number {
  return Math.sin(d * 0.017453292519943295)
}

export function piValue(): number {
  return Math.PI
}

export function min3(a: number, b: number, c: number): number {
  return Math.min(a, b, c)
}

export function maxOf(xs: readonly number[]): number {
  return Math.max(...xs)
}

export function hypotOf(x: number, y: number): number {
  return Math.hypot(x, y)
}

export function byte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)))
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}
