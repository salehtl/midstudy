// Reducers over arrays and records (library costs, layout items).
export interface Cost {
  readonly id: string
  readonly engine: string
  readonly cost_usd: number
}

export function sum(xs: readonly number[]): number {
  return xs.reduce((a, b) => a + b, 0)
}

export function sumLoop(xs: readonly number[]): number {
  let s = 0
  for (const x of xs) s += x
  return s
}

export function sumIndexed(xs: readonly number[]): number {
  let s = 0
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    if (x !== undefined) s += x
  }
  return s
}

export function costByEngine(items: readonly Cost[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const it of items) out[it.engine] = (out[it.engine] ?? 0) + it.cost_usd
  return out
}

export function costByEngineMap(items: readonly Cost[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const it of items) out.set(it.engine, (out.get(it.engine) ?? 0) + it.cost_usd)
  return out
}

export function totalOfKeys(rec: Readonly<Record<string, number>>): number {
  let t = 0
  for (const k of Object.keys(rec)) {
    const v = rec[k]
    if (v !== undefined) t += v
  }
  return t
}

export function totalOfValues(rec: Readonly<Record<string, number>>): number {
  return Object.values(rec).reduce((a, b) => a + b, 0)
}

export function totalOfEntries(rec: Record<string, number>): number {
  let t = 0
  for (const [, v] of Object.entries(rec)) t += v
  return t
}
