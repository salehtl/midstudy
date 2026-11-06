// The library lock (contract §2.8 "One writer"): Node has no flock (v1 flocked <library>/.lock), so every library
// write and every costs.csv append takes a lock directory. The server and midstudy-add implement this same protocol:
//
//   take     mkdir <lock>.d (its parent made first); the maker then writes owner.json {pid, host, cmd, started}
//            into it (atomically: a temp file and a rename). mkdir either makes the folder or fails: one taker wins.
//   wait     on EEXIST, read owner.json and poll every 50 ms until the folder is gone, or until the wait is over
//            (Busy). A lock is stale when its owner is a dead pid on this host, when it is older than the tool
//            timeout (3600 s), or when it has had no readable owner.json for 10 s (its maker died in between).
//   reclaim  rename the stale folder aside (<lock>.d.stale-<pid>-<random>): one reclaimer wins the rename, the others
//            get ENOENT and try again. The winner checks that what it moved is the owner it judged stale (else it
//            moves it back) and removes it.
//   release  the holder checks owner.json is still its own, renames the folder aside and removes it. A process keeps
//            a list of the locks it holds, so an interrupt (midstudy-add's Ctrl-C or SIGTERM) gives them all back at
//            once (releaseAllSync).
//
// v1's lock files (`<library>/.lock`, `<costs file>.lock`) are still created when missing and never removed (E7
// checks that cost rows have their own lock file beside costs.csv). Nothing flocks them since the v2 cutover: never run
// a v1 checkout's tools on a v2 library.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { atomicWriteSync } from './files.ts'
import { lockOwner, lockVerdict, sameOwner, type LockOwner, type LockVerdict } from './logic/lock.ts'

/** A library write waited its whole time for the lock (the server answers 503, contract §2.8). */
export class Busy extends Error {
  constructor(lock: string) {
    super('the lock ' + lock + ' is held by another writer')
    this.name = 'Busy'
  }
}

/** The protocol's numbers. */
const LOCK_POLL_MS = 50
/** The tool timeout: no holder may hold longer (midstudy-add's 3600 s). */
const LOCK_STALE_MS = 3600 * 1000
/** How long a lock folder may have no owner.json before it counts as abandoned. */
const LOCK_GRACE_MS = 10 * 1000

/** How to take a lock. */
export interface LockOptions {
  /** Milliseconds to wait for it; null waits as long as it takes (a billed call's cost row must not be lost). */
  readonly waitMs: number | null
  /** What holds it, for owner.json. */
  readonly cmd: string
  /** Called once, the first time the lock is found held by someone else (midstudy-add says it is waiting). */
  readonly onWait?: () => void
  readonly staleMs?: number
  readonly graceMs?: number
  readonly pollMs?: number
}

/** A held lock. */
export interface HeldLock {
  /** The lock folder. */
  readonly dir: string
  readonly owner: LockOwner
  /** Gives it back (only if owner.json is still this holder's). Safe to call twice. */
  release(): Promise<void>
}

/** The locks this process holds, by folder (given back by releaseAllSync on an interrupt). */
const heldHere = new Map<string, LockOwner>()

/** The lock folder of a library (`<library>/.lock.d`). */
export function libraryLockDir(libraryDir: string): string {
  return path.join(libraryDir, '.lock.d')
}

/** The lock folder of a costs file (`<costs file>.lock.d`). */
export function costsLockDir(costsFile: string): string {
  return costsFile + '.lock.d'
}

/** v1's flock file next to a v2 lock folder (`.lock.d` → `.lock`). */
function legacyLockFile(dir: string): string {
  return dir.endsWith('.d') ? dir.slice(0, -2) : dir + '.legacy'
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e instanceof Error && 'code' in e && e.code === 'EPERM'
  }
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readOwner(dir: string): LockOwner | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))
    return isRecord(value) ? lockOwner(value) : null
  } catch {
    return null
  }
}

function errorCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

function asideName(dir: string, why: string): string {
  return dir + '.' + why + '-' + String(process.pid) + '-' + randomBytes(4).toString('hex')
}

/** What a waiter sees of the lock folder, and its verdict. */
function judge(dir: string, staleMs: number, graceMs: number): { readonly verdict: LockVerdict; readonly owner: LockOwner | null } | null {
  let dirMtime: number
  try {
    dirMtime = fs.statSync(dir).mtimeMs
  } catch {
    return null // gone: try again at once
  }
  const owner = readOwner(dir)
  const host = os.hostname()
  const started = owner === null ? NaN : Date.parse(owner.started)
  const ageMs = Date.now() - (Number.isFinite(started) ? started : dirMtime)
  const ownerAlive = owner !== null && owner.host === host ? alive(owner.pid) : null
  return { verdict: lockVerdict({ owner, ageMs, host, ownerAlive }, staleMs, graceMs), owner }
}

/** Moves a stale lock folder aside and removes it; false when another reclaimer (or the holder) got there first. */
async function reclaim(dir: string, judged: LockOwner | null): Promise<boolean> {
  const aside = asideName(dir, 'stale')
  try {
    await fsp.rename(dir, aside)
  } catch {
    return false
  }
  const moved = readOwner(aside)
  const same = judged === null ? moved === null : moved !== null && sameOwner(moved, judged)
  if (!same) {
    // Not the folder we judged: a fresh holder took the lock in between. Put it back.
    try {
      await fsp.rename(aside, dir)
      return false
    } catch {
      // Someone took the name meanwhile: two holders now. Their release checks owner.json, so neither removes the
      // other's folder; the one we moved aside is left for its holder's release to find gone.
      return false
    }
  }
  await fsp.rm(aside, { recursive: true, force: true })
  return true
}

/** Takes the lock folder `dir` (§2.8 One writer, v2). Throws Busy after `waitMs`. */
export async function acquireLock(dir: string, options: LockOptions): Promise<HeldLock> {
  const staleMs = options.staleMs ?? LOCK_STALE_MS
  const graceMs = options.graceMs ?? LOCK_GRACE_MS
  const pollMs = options.pollMs ?? LOCK_POLL_MS
  const deadline = options.waitMs === null ? Infinity : Date.now() + options.waitMs
  await fsp.mkdir(path.dirname(dir), { recursive: true })
  const legacy = legacyLockFile(dir)
  try {
    fs.closeSync(fs.openSync(legacy, 'a'))
  } catch {
    // v1's file is only a courtesy
  }
  let waited = false
  for (;;) {
    try {
      await fsp.mkdir(dir)
      const owner: LockOwner = { pid: process.pid, host: os.hostname(), cmd: options.cmd, started: new Date().toISOString() }
      try {
        atomicWriteSync(path.join(dir, 'owner.json'), JSON.stringify(owner) + '\n')
      } catch (e) {
        await fsp.rm(dir, { recursive: true, force: true })
        throw e
      }
      heldHere.set(dir, owner)
      return held(dir, owner)
    } catch (e) {
      if (errorCode(e) !== 'EEXIST') throw e
    }
    const seen = judge(dir, staleMs, graceMs)
    if (seen === null) continue
    if (seen.verdict !== 'held') {
      if (await reclaim(dir, seen.owner)) continue
    }
    if (!waited) {
      waited = true
      options.onWait?.()
    }
    if (Date.now() >= deadline) throw new Busy(dir)
    await sleep(Math.max(1, Math.min(pollMs, deadline - Date.now())))
  }
}

/** Gives back `dir` if owner.json is still `owner`'s (a lock that changed hands is left alone), synchronously: also
 *  safe in a signal handler. */
function releaseSync(dir: string, owner: LockOwner): void {
  const mine = heldHere.get(dir)
  if (mine !== undefined && sameOwner(mine, owner)) heldHere.delete(dir)
  const now = readOwner(dir)
  if (now === null || !sameOwner(now, owner)) return
  const aside = asideName(dir, 'released')
  try {
    fs.renameSync(dir, aside)
  } catch {
    return
  }
  fs.rmSync(aside, { recursive: true, force: true })
}

function held(dir: string, owner: LockOwner): HeldLock {
  let released = false
  return {
    dir,
    owner,
    release(): Promise<void> {
      if (!released) {
        released = true
        releaseSync(dir, owner)
      }
      return Promise.resolve()
    },
  }
}

/** Gives back every lock this process holds (midstudy-add on Ctrl-C or SIGTERM, before it exits). */
export function releaseAllSync(): void {
  for (const [dir, owner] of [...heldHere]) releaseSync(dir, owner)
}

/** Runs `fn` holding the lock folder `dir`, and gives it back whatever happens. */
export async function withLock<T>(dir: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  const lock = await acquireLock(dir, options)
  try {
    return await fn()
  } finally {
    await lock.release()
  }
}

/** `<library>/.lock.d`: every library write (library.json, item folders, the trash). The server waits 60 s for a
 *  running midstudy-add (then Busy → 503); `waitMs: null` waits as long as it takes. */
export function withLibraryLock<T>(libraryDir: string, options: LockOptions, fn: () => Promise<T>): Promise<T> {
  return withLock(libraryLockDir(libraryDir), options, fn)
}
