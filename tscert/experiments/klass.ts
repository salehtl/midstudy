// Classes (a running mean of frame times; a bounded history for undo).
export class Stats {
  count = 0
  total = 0

  add(v: number): void {
    this.count += 1
    this.total += v
  }

  mean(): number {
    return this.count === 0 ? 0 : this.total / this.count
  }
}

export class History {
  readonly limit: number
  private items: string[]

  constructor(limit: number) {
    this.limit = limit
    this.items = []
  }

  push(v: string): void {
    this.items.push(v)
    if (this.items.length > this.limit) this.items.shift()
  }

  last(): string | undefined {
    return this.items[this.items.length - 1]
  }
}

export class Ring {
  readonly size: number
  #items: number[]

  constructor(size: number) {
    this.size = size
    this.#items = []
  }

  push(v: number): void {
    this.#items.push(v)
  }
}

export function meanOf(xs: readonly number[]): number {
  const s = new Stats()
  for (const x of xs) s.add(x)
  return s.mean()
}
