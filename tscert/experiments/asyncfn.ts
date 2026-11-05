// Async functions (a job poller, a fetch wrapper's logic part).
export async function addLater(a: Promise<number>, b: number): Promise<number> {
  const x = await a
  return x + b
}

export async function both(a: Promise<number>, b: Promise<number>): Promise<number> {
  const [x, y] = await Promise.all([a, b])
  return x + y
}

export async function firstSettled(xs: readonly Promise<number>[]): Promise<number | null> {
  for (const p of xs) {
    try {
      return await p
    } catch {
      continue
    }
  }
  return null
}

export async function retry(times: number, attempt: () => Promise<boolean>): Promise<boolean> {
  for (let i = 0; i < times; i++) if (await attempt()) return true
  return false
}
