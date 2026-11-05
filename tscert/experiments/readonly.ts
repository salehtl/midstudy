// Readonly arrays and tuples (dims, corners).
export function doubled(xs: readonly number[]): number[] {
  return xs.map((x) => x * 2)
}

export function positives(xs: ReadonlyArray<number>): number[] {
  return xs.filter((x) => x > 0)
}

export function lastTwo(xs: readonly number[]): number[] {
  return xs.slice(-2)
}

export function sortedCopy(xs: readonly number[]): number[] {
  return [...xs].sort((a, b) => a - b)
}

export function lastOf(xs: readonly string[]): string | undefined {
  return xs[xs.length - 1]
}

export function tupleSum(t: readonly [number, number, number]): number {
  return t[0] + t[1] + t[2]
}

export function corners(w: number, d: number): readonly (readonly [number, number])[] {
  return [
    [-w / 2, -d / 2],
    [w / 2, -d / 2],
    [w / 2, d / 2],
    [-w / 2, d / 2],
  ]
}
