// In-memory job queues (contract §2.8 Jobs, §4.4): one queue per kind of work (the library's midstudy-add runs, the
// scenes' calibrations), one job at a time in the order queued, listed newest first, forgotten by a restart. v1 had a
// thread per queue; here one async loop per queue does the same.
import { randomBytes } from 'node:crypto'
import { jobId } from './logic/jobs.ts'

/** A new job id, `<prefix>-YYYYMMDD-HHMMSS-<4 hex>` (UTC now). */
export function newJobId(prefix: 'c' | 'l', now: number = Date.now()): string {
  return jobId(prefix, now, randomBytes(2).toString('hex'))
}

/** The jobs of one queue: answers are copies, so a caller never changes a job by holding it. */
export class JobStore<J extends { readonly id: string }> {
  readonly #jobs = new Map<string, J>()
  readonly #order: string[] = []

  /** Records a job (at the end of the order) and returns a copy. */
  add(job: J): J {
    this.#jobs.set(job.id, job)
    this.#order.push(job.id)
    return { ...job }
  }

  /** A copy of the job, or null. */
  get(id: string): J | null {
    const job = this.#jobs.get(id)
    return job === undefined ? null : { ...job }
  }

  /** Copies of every job, newest first. */
  list(): J[] {
    const out: J[] = []
    for (let i = this.#order.length - 1; i >= 0; i--) {
      const job = this.#jobs.get(this.#order[i] ?? '')
      if (job !== undefined) out.push({ ...job })
    }
    return out
  }

  /** Replaces fields of a job (no-op for an unknown id); returns the new copy or null. */
  update(id: string, patch: Partial<J>): J | null {
    const job = this.#jobs.get(id)
    if (job === undefined) return null
    const next: J = { ...job, ...patch }
    this.#jobs.set(id, next)
    return { ...next }
  }

  /** Where a job stands in the order (oldest 0), or -1. */
  position(id: string): number {
    return this.#order.indexOf(id)
  }
}

/** Runs queued work one item at a time, in the order queued. A failure of one item never stops the queue. */
export class SerialQueue {
  readonly #waiting: string[] = []
  readonly #run: (id: string) => Promise<void>
  readonly #failed: (id: string, error: unknown) => void
  readonly #after: (id: string) => Promise<void>
  #busy = false
  #idle: Promise<void> = Promise.resolve()
  #settle: () => void = () => undefined

  /** `run` does one job; `failed` records a job whose `run` threw (v1: "the server failed to run …"); `after` always
   *  runs next (a reservation released, a temp folder removed). */
  constructor(run: (id: string) => Promise<void>, failed: (id: string, error: unknown) => void, after: (id: string) => Promise<void> = () => Promise.resolve()) {
    this.#run = run
    this.#failed = failed
    this.#after = after
  }

  /** Queues `id`. */
  push(id: string): void {
    this.#waiting.push(id)
    if (!this.#busy) {
      this.#busy = true
      this.#idle = new Promise((resolve) => {
        this.#settle = resolve
      })
      void this.#loop()
    }
  }

  /** How many are waiting (not counting the one running). */
  get waiting(): number {
    return this.#waiting.length
  }

  /** Resolves when the queue has nothing left to run. */
  drained(): Promise<void> {
    return this.#busy ? this.#idle : Promise.resolve()
  }

  async #loop(): Promise<void> {
    for (let id = this.#waiting.shift(); id !== undefined; id = this.#waiting.shift()) {
      try {
        await this.#run(id)
      } catch (e) {
        try {
          this.#failed(id, e)
        } catch (inner) {
          process.stderr.write('midstudy server: a job queue failed to record a failure: ' + String(inner) + '\n')
        }
      }
      try {
        await this.#after(id)
      } catch (e) {
        process.stderr.write('midstudy server: a job queue failed to clean up after ' + id + ': ' + String(e) + '\n')
      }
    }
    this.#busy = false
    this.#settle()
  }
}
