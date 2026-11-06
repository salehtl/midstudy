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

/** v1's `_tick`, per read: past the deadline (set once the page is downloaded), the read ends with 422 TOO_LONG.
 *  Each call also lets the event loop answer other requests (v1 ran each request in its own thread). */
export class Deadline {
  #at: number | null = null
  #yielded = performance.now()

  /** Starts the 10 s for the work after the download. */
  start(ms: number): void {
    this.#at = performance.now() + ms
  }

  /** What is left of the 10 s, in ms (before they start: all of them). */
  remaining(): number {
    return this.#at === null ? 10_000 : Math.max(0, this.#at - performance.now())
  }

  /** In a long loop: a turn of the event loop when 20 ms have passed since the last one, then check(). */
  async pause(): Promise<void> {
    if (performance.now() - this.#yielded > 20) {
      await new Promise<void>((resolve) => setImmediate(resolve))
      this.#yielded = performance.now()
    }
    this.check()
  }

  /** Throws TOO_LONG past the deadline. */
  check(): void {
    if (this.#at !== null && performance.now() > this.#at) throw new ProductError(422, TOO_LONG)
  }

  /** check(), after a turn of the event loop. */
  async tick(): Promise<void> {
    await new Promise<void>((resolve) => setImmediate(resolve))
    this.#yielded = performance.now()
    this.check()
  }
}
