// The splat layer's decisions (planner/gpu/splat-layer.ts performs them): the sort key (what an order was sorted for)
// and the CPU sort's state machine on the WebGL2 fallback, where a worker sorts camera and transform changes and the
// main thread sorts set changes, captures and everything once the worker is down. Pure and import-free: TScert checks
// it, and node loads it with type stripping (planner/gpu/test/splats.test.mjs).

/** A sort the layer posted to the worker: its id, the key it sorts for, the set version, and whether a main-thread
 * sort landed after it was posted (then its answer is older than the drawn order). */
interface CpuPending {
  readonly id: number
  readonly key: string
  readonly version: number
  readonly superseded: boolean
}

/** The CPU sort's state. worker: 'none' before the first post, 'up' once made, 'down' for good after a failure. */
export interface CpuSort {
  readonly worker: 'none' | 'up' | 'down'
  readonly pending: CpuPending | null
  /** what the drawn order was sorted for ('' = nothing yet, or the set changed) */
  readonly sortedKey: string
  /** the set changed since the last sort: sort it here, so the first frame of a new set is never blank */
  readonly setChanged: boolean
}

export type CpuAction = 'none' | 'here' | 'post' | 'wait'
export type CpuVerdict = 'ignore' | 'drop' | 'apply'

export function cpuSortStart(): CpuSort {
  return { worker: 'none', pending: null, sortedKey: '', setChanged: false }
}

/** What to do for the order wanted now: nothing (it is drawn), sort here on the main thread (the worker is down, the
 * set changed, or a capture is settling), wait for the request in flight, or post a new one. */
export function cpuSortAction(s: CpuSort, wantKey: string, settling: boolean): CpuAction {
  if (wantKey === s.sortedKey) return 'none'
  if (s.worker === 'down' || s.setChanged || settling) return 'here'
  if (s.pending !== null) return 'wait'
  return 'post'
}

/** A worker reply: not the request in flight (ignore); for an older set, overtaken by a main-thread sort, or no longer
 * needed (drop); else apply it. The layer clears pending on drop and apply, then decides again. */
export function cpuReplyVerdict(s: CpuSort, reply: { readonly id: number, readonly version: number }, version: number, wantKey: string): CpuVerdict {
  const p = s.pending
  if (reply.id !== p?.id) return 'ignore'
  if (reply.version !== version || p.superseded || s.sortedKey === wantKey) return 'drop'
  return 'apply'
}

/** The sort key: the set version, the camera's view matrix, its near plane (both sorts cull at it), and every item's
 * world matrix, to 6 decimals. far is left out: neither sort uses it. */
export function sortKey(version: number, view: readonly number[], near: number, items: readonly (readonly number[])[]): string {
  const parts: string[] = [String(version), near.toFixed(6)]
  for (const v of view) parts.push(v.toFixed(6))
  for (const m of items) for (const v of m) parts.push(v.toFixed(6))
  return parts.join(',')
}
