// List helpers the panels share: the first entry of each key (trash lists shown once per name or id) and counts per
// key (pieces placed per library item). Pure, TScert-checked.

/** The first entry of each key, in order. */
export function uniqueBy<T>(xs: readonly T[], key: (t: T) => string): T[] {
  const seen = new Set<string>()
  const out: T[] = []
  for (const x of xs) {
    const k = key(x)
    if (seen.has(k)) continue
    seen.add(k)
    out.push(x)
  }
  return out
}

/** How many entries have each key. */
export function countBy<T>(xs: readonly T[], key: (t: T) => string): Map<string, number> {
  const n = new Map<string, number>()
  for (const x of xs) {
    const k = key(x)
    n.set(k, (n.get(k) ?? 0) + 1)
  }
  return n
}
