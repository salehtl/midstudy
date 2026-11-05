// TScert-friendly rewrites of what the first round refused, and a few more forms.
export interface Look {
  readonly exposure: number
  readonly warmth: number
  readonly ambient?: number
}

// Trigonometry the overlay does not review, taken as a parameter: the caller (a shell module) passes Math.tan.
export function horizonWith(pitchRad: number, fovRad: number, tan: (x: number) => number): number {
  return 0.5 - tan(pitchRad) / (2 * tan(fovRad / 2))
}

// An object built field by field instead of a spread of a record with readonly or optional fields.
export function withExposureExplicit(l: Look, e: number): Look {
  return l.ambient === undefined ? { exposure: e, warmth: l.warmth } : { exposure: e, warmth: l.warmth, ambient: l.ambient }
}

export function costTable(engines: readonly string[], costs: readonly number[]): Map<string, number> {
  const m = new Map<string, number>()
  for (let i = 0; i < engines.length; i++) {
    const e = engines[i]
    const c = costs[i]
    if (e !== undefined && c !== undefined) m.set(e, (m.get(e) ?? 0) + c)
  }
  return m
}

export function asRecord(m: ReadonlyMap<string, number>): Record<string, number> {
  return Object.fromEntries(m)
}

export function zeros(n: number): number[] {
  return new Array<number>(n).fill(0)
}

export function firstOf<T>(xs: readonly T[]): T | undefined {
  return xs[0]
}

export function depth(n: number): number {
  return n <= 0 ? 0 : 1 + depth(n - 1)
}

export function counter(): () => number {
  let n = 0
  return () => {
    n += 1
    return n
  }
}

export function parseCm(s: string): number | null {
  const v = Number.parseFloat(s)
  return Number.isFinite(v) ? v : null
}

export function ambientOf(l: Look | undefined): number {
  return l?.ambient ?? 1
}

export async function both2(a: Promise<number>, b: Promise<number>): Promise<number> {
  const x = await a
  const y = await b
  return x + y
}

export function sumAll(rec: Readonly<Record<string, number>>): number {
  let t = 0
  for (const v of Object.values(rec)) t += v
  return t
}
