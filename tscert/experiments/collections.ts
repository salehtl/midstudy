// Map and Set (library ids, counts).
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)]
}

export function hasAll(have: ReadonlySet<string>, want: readonly string[]): boolean {
  for (const w of want) if (!have.has(w)) return false
  return true
}

export function countBy(xs: readonly string[]): Map<string, number> {
  const m = new Map<string, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  return m
}

export function topKey(m: ReadonlyMap<string, number>): string | null {
  let best: string | null = null
  let n = -1
  for (const [k, v] of m.entries()) {
    if (v > n) {
      best = k
      n = v
    }
  }
  return best
}

export function setOf(xs: readonly string[]): Set<string> {
  const s = new Set<string>()
  for (const x of xs) s.add(x)
  return s
}
