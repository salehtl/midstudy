// Loops with early returns (finding a layout item, a hit).
export interface Item {
  readonly uid: string
  readonly id: string
  readonly y: number
}

export function firstIndexAbove(xs: readonly number[], limit: number): number {
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]
    if (x !== undefined && x > limit) return i
  }
  return -1
}

export function findByUid(items: readonly Item[], uid: string): Item | undefined {
  for (const it of items) if (it.uid === uid) return it
  return undefined
}

export function findByUidMethod(items: readonly Item[], uid: string): Item | undefined {
  return items.find((it) => it.uid === uid)
}

export function countLeadingNonNegative(xs: readonly number[]): number {
  let i = 0
  while (i < xs.length) {
    const x = xs[i]
    if (x === undefined || x < 0) break
    i++
  }
  return i
}

export function raised(items: readonly Item[]): Item[] {
  const out: Item[] = []
  for (const it of items) {
    if (it.y <= 0.02) continue
    out.push(it)
  }
  return out
}
