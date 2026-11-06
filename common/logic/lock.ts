// The v2 library lock's decisions (contract §2.8 "One writer"): who holds a lock directory, and when a waiter may
// reclaim it. Pure (TScert); common/lock.ts does the file system and the waiting.

/** owner.json inside a held lock directory. */
export interface LockOwner {
  readonly pid: number
  /** os.hostname() of the holder. */
  readonly host: string
  /** What holds it (`midstudy server`, `midstudy-add …`), for people reading the folder. */
  readonly cmd: string
  /** When it was taken, ISO 8601 UTC with milliseconds. */
  readonly started: string
}

/** The owner.json fields, or null when they aren't all there with the right types. */
export function lockOwner(r: Readonly<Record<string, unknown>>): LockOwner | null {
  const pid = r['pid']
  const host = r['host']
  const cmd = r['cmd']
  const started = r['started']
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null
  if (typeof host !== 'string' || typeof cmd !== 'string' || typeof started !== 'string') return null
  return { pid, host, cmd, started }
}

/** Two owners are the same holding (the same process took it at the same moment). */
export function sameOwner(a: LockOwner, b: LockOwner): boolean {
  return a.pid === b.pid && a.host === b.host && a.started === b.started
}

/** What a waiter sees of a lock directory it could not create. */
export interface LockSeen {
  /** owner.json, or null while it is missing or unreadable. */
  readonly owner: LockOwner | null
  /** Milliseconds since `owner.started` (or, without an owner, since the directory was made). */
  readonly ageMs: number
  /** This host's name. */
  readonly host: string
  /** Whether the owner's pid is a live process; null when the owner is on another host or unknown. */
  readonly ownerAlive: boolean | null
}

/** Why a lock may be reclaimed, or `held` while it may not. */
export type LockVerdict = 'held' | 'dead-owner' | 'too-old' | 'no-owner'

/** The protocol's rule: a lock is stale when its owner is a dead process on this host, when it is older than the
 *  longest a holder may run (`staleMs`, the tool timeout: 3600 s), or when it has had no readable owner.json for
 *  longer than `graceMs` (its maker died between the mkdir and the write). */
export function lockVerdict(seen: LockSeen, staleMs: number, graceMs: number): LockVerdict {
  if (seen.owner === null) return seen.ageMs > graceMs ? 'no-owner' : 'held'
  if (seen.owner.host === seen.host && seen.ownerAlive === false) return 'dead-owner'
  if (seen.ageMs > staleMs) return 'too-old'
  return 'held'
}
