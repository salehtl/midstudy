// A stand-in for live fal (tests only): the key and the transport LiveFal uses in a run that isn't mocked, so a test
// can drive midstudy-add's paid branch (its signal handling, the unwind, the cost row) with no network and no key.
// Only code in the process can set it: a module preloaded with `node --import`, before cli.ts runs
// (pipeline/test/paid-standin.ts). Nothing in the environment reaches it.
import type { FetchFn } from './fal.ts'

export interface FalStandIn {
  readonly key: string
  readonly fetch: FetchFn
}

let current: FalStandIn | null = null

/** Installs the stand-in for this process (a test's preload). */
export function installFalStandIn(standIn: FalStandIn): void {
  current = standIn
}

/** The installed stand-in, or null (every real run). */
export function falStandIn(): FalStandIn | null {
  return current
}
