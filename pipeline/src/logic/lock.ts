// The v2 library lock's decisions (contract §2.8 "One writer", v2): who holds `<library>/.lock.d` (or
// `<costs file>.lock.d`) and whether a waiter may reclaim it. The protocol: `mkdir` takes the lock and `owner.json`
// {pid, host, cmd, started} says who holds it; waiters poll every 50 ms; a lock whose owner is dead on this host, or
// that is older than the tool timeout, is renamed aside atomically (one reclaimer wins) and removed. Pure.

/** Waiters poll this often. */
export const POLL_MS = 50
/** The tool timeout (the server's midstudy-add timeout): a lock older than this is stale whoever holds it. */
export const STALE_MS = 3600 * 1000

export interface Owner {
  readonly pid: number
  readonly host: string
  readonly cmd: string
  readonly started: string
}

/** owner.json's fields, or null when the text isn't one. */
export function ownerFrom(r: Readonly<Record<string, unknown>>): Owner | null {
  const pid = r['pid']
  const host = r['host']
  const cmd = r['cmd']
  const started = r['started']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof host !== 'string' || typeof cmd !== 'string' || typeof started !== 'string') return null
  return { pid, host, cmd, started }
}

/** What a waiter knows about a held lock. */
export interface Seen {
  /** owner.json, when it could be read. */
  readonly owner: Owner | null
  /** Whether the owner's pid is alive, when the owner is on this host (null: another host, or no owner). */
  readonly alive: boolean | null
  /** How old the lock is: from owner.json's `started`, else the directory's mtime (null: unknown). */
  readonly ageMs: number | null
}

/** Whether the lock may be reclaimed: its owner is dead on this host, or it is older than the tool timeout. A lock
 *  without a readable owner (being created) is waited for until it is that old. */
export function isStale(s: Seen): boolean {
  if (s.owner !== null && s.alive === false) return true
  return s.ageMs !== null && s.ageMs > STALE_MS
}

/** Whether the reclaimer renamed aside the lock it judged stale (the same owner), rather than a new one. */
export function sameOwner(a: Owner | null, b: Owner | null): boolean {
  if (a === null || b === null) return a === b
  return a.pid === b.pid && a.host === b.host && a.cmd === b.cmd && a.started === b.started
}
