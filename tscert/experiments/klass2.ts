// Classes written the TScert way: every field annotated, initialized in the constructor.
export class Tally {
  count: number
  total: number

  constructor() {
    this.count = 0
    this.total = 0
  }

  add(v: number): void {
    this.count += 1
    this.total += v
  }

  mean(): number {
    return this.count === 0 ? 0 : this.total / this.count
  }
}

export class Limited {
  readonly limit: number
  #items: string[]

  constructor(limit: number) {
    this.limit = limit
    this.#items = []
  }

  push(v: string): void {
    this.#items.push(v)
    if (this.#items.length > this.limit) this.#items.shift()
  }

  size(): number {
    return this.#items.length
  }
}

export function meanOfTally(xs: readonly number[]): number {
  const t = new Tally()
  for (const x of xs) t.add(x)
  return t.mean()
}
