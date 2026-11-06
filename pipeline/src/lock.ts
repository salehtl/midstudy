// The v2 library lock (contract §2.8 "One writer", v2; Node has no flock): every library write takes
// `<library>/.lock.d` and every costs.csv append `<costs file>.lock.d`. `mkdir` takes it (atomic), `owner.json`
// {pid, host, cmd, started} says who holds it; waiters poll every 50 ms; a lock whose owner pid is dead on this host,
// or that is older than the tool timeout (3600 s), is reclaimed by renaming it aside atomically (only one reclaimer
// wins the rename) and removing it; release removes it. The server takes the same locks the same way.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { isStale, ownerFrom, POLL_MS, sameOwner } from './logic/lock.ts'
import type { Owner } from './logic/lock.ts'

/** The locks this process holds (released if it is interrupted). */
const held = new Map<string, Owner>()

function errCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function readOwner(dir: string): Owner | null {
  try {
    const v: unknown = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))
    return isRecord(v) ? ownerFrom(v) : null
  } catch {
    return null
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return errCode(e) === 'EPERM'
  }
}

/** Renames a stale lock aside and removes it; when the lock changed hands after it was judged, it is put back. */
function reclaim(dir: string, judged: Owner | null): void {
  const aside = `${dir}.stale-${String(process.pid)}-${randomBytes(4).toString('hex')}`
  try {
    fs.renameSync(dir, aside)
  } catch {
    return // another reclaimer won, or the owner released it
  }
  if (!sameOwner(readOwner(aside), judged)) {
    try {
      fs.renameSync(aside, dir)
      return
    } catch {
      // a newer lock took its place; the one moved aside is gone either way
    }
  }
  fs.rmSync(aside, { recursive: true, force: true })
}

export interface LockOptions {
  /** Called once, the first time the lock is found held. */
  readonly onWait?: () => void
  /** Give up (throw) after this time (epoch ms); by default wait as long as it takes, as v1's flock did. */
  readonly deadline?: number
}

/** Takes the lock `dir` (its parent must exist). */
export async function acquire(dir: string, opts: LockOptions = {}): Promise<Owner> {
  const me: Owner = {
    pid: process.pid,
    host: os.hostname(),
    cmd: ['midstudy-add', ...process.argv.slice(2)].join(' ').slice(0, 300),
    started: new Date().toISOString(),
  }
  let waited = false
  for (;;) {
    try {
      fs.mkdirSync(dir)
      try {
        fs.writeFileSync(path.join(dir, 'owner.json'), `${JSON.stringify(me)}\n`)
      } catch (e) {
        fs.rmSync(dir, { recursive: true, force: true })
        throw e
      }
      held.set(dir, me)
      return me
    } catch (e) {
      if (errCode(e) !== 'EEXIST') throw e
    }
    const owner = readOwner(dir)
    let mtime: number
    try {
      mtime = fs.statSync(dir).mtimeMs
    } catch {
      continue // released meanwhile
    }
    const started = owner === null ? Number.NaN : Date.parse(owner.started)
    const now = Date.now()
    const seen = {
      owner,
      alive: owner !== null && owner.host === me.host ? alive(owner.pid) : null,
      ageMs: Number.isFinite(started) ? now - started : now - mtime,
    }
    if (isStale(seen)) {
      reclaim(dir, owner)
      continue
    }
    if (!waited) {
      waited = true
      opts.onWait?.()
    }
    if (opts.deadline !== undefined && now > opts.deadline) throw new Error(`${dir} is held by pid ${String(owner?.pid ?? '?')}`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
}

/** Releases a lock this process holds (a lock that changed hands is left alone). */
export function release(dir: string, owner: Owner): void {
  held.delete(dir)
  if (sameOwner(readOwner(dir), owner)) fs.rmSync(dir, { recursive: true, force: true })
}

/** Runs `fn` holding the lock `dir`. */
export async function withLock<T>(dir: string, opts: LockOptions, fn: () => Promise<T>): Promise<T> {
  const owner = await acquire(dir, opts)
  try {
    return await fn()
  } finally {
    release(dir, owner)
  }
}

/** Releases every lock this process holds (on an interrupt). */
export function releaseAll(): void {
  for (const [dir, owner] of [...held]) release(dir, owner)
}
