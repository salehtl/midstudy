// The product reader's answers that aren't a 200 (contract §2.11 Errors), with v1's sentences, and the deadline for
// the work after the download (v1's `_tick`: 10 s, then 422).

/** v1's BLOCKED. */
export const BLOCKED = 'This shop blocks automatic reading: paste the image link and size instead.'
/** v1's TIMEOUT (the 20 s for the page and its feeds ran out). */
export const TIMEOUT = 'the page took more than 20 s to read: try again, or paste the image link and size instead'
/** v1's TOO_LONG (the 10 s for the work after the download ran out). */
export const TOO_LONG = 'the page took too long to read: paste the image link and size instead'
/** v1's answer to anything else it couldn't handle (its `except Exception`). */
export const COULD_NOT_READ = "couldn't read that page: paste the image link and size instead"

/** v1's ProductError: a status and its body (`{error}`, plus `blocked: true` for a shop that refuses). */
export class ProductError extends Error {
  readonly status: number
  readonly blocked: boolean
  constructor(status: number, message: string, blocked = false) {
    super(message)
    this.name = 'ProductError'
    this.status = status
    this.blocked = blocked
  }

  /** The answer's body. */
  body(): { readonly error: string; readonly blocked?: true } {
    return this.blocked ? { error: this.message, blocked: true } : { error: this.message }
  }
}

/** The 20 s budget ran out (v1's TimeoutError, answered with TIMEOUT). */
export class PageTimeout extends Error {
  constructor() {
    super('the page budget ran out')
    this.name = 'PageTimeout'
  }
}

/** v1's EXTRACT_S: the work after the download. */
export const EXTRACT_MS = 10 * 1000

/** v1's `_tick`, per read: past the deadline (set once the page is downloaded), the read ends with 422 TOO_LONG.
 *  Each call also lets the event loop answer other requests (v1 ran each request in its own thread). Two changes from
 *  v1: the clock stops while the feeds load (the 20 s Budget bounds them), and it no longer applies once a paid
 *  model answer has come back (docs/notes/server.md). */
export class Deadline {
  readonly #now: () => number
  #at: number | null = null
  #settled = false
  #yielded: number

  constructor(now: () => number = () => performance.now()) {
    this.#now = now
    this.#yielded = now()
  }

  /** Starts the 10 s for the work after the download. */
  start(ms: number): void {
    this.#at = this.#now() + ms
  }

  /** What is left of the 10 s, in ms (before they start, and once settled: all of them, still a bound for a worker). */
  remaining(): number {
    if (this.#at === null || this.#settled) return EXTRACT_MS
    return Math.max(0, this.#at - this.#now())
  }

  /** Runs `work` with the clock stopped: the deadline moves later by the time it took. */
  async suspend<T>(work: () => Promise<T>): Promise<T> {
    const from = this.#now()
    try {
      return await work()
    } finally {
      if (this.#at !== null) this.#at += this.#now() - from
    }
  }

  /** The read has a paid answer to give: from now on check() never throws. */
  settle(): void {
    this.#settled = true
  }

  /** In a long loop: a turn of the event loop when 20 ms have passed since the last one, then check(). */
  async pause(): Promise<void> {
    if (this.#now() - this.#yielded > 20) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      this.#yielded = this.#now()
    }
    this.check()
  }

  /** Throws TOO_LONG past the deadline. */
  check(): void {
    if (!this.#settled && this.#at !== null && this.#now() > this.#at) throw new ProductError(422, TOO_LONG)
  }

  /** check(), after a turn of the event loop. */
  async tick(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.#yielded = this.#now()
    this.check()
  }
}
