// One lock-directory helper for the scripts (the build steps, the eval semaphore, TScert, the evals' out folders). A
// synchronous mirror of common/lock.ts's protocol (contract §2.8), with its decisions from common/logic/lock.ts:
//
//   claim    mkdir the folder (its parent made first), then write owner.json {pid, host, cmd, started} through a temp
//            file and a rename. mkdir either makes the folder or fails: one claimer wins. tryClaim never waits; async
//            callers poll it.
//   stale    lockVerdict. A live pid on this host is never stale, however old (a cold build or an eval may run for
//            hours). A dead pid on this host is stale at once, a folder with no readable owner.json after 10 s, and an
//            owner on another host (whose pid can't be checked) past `staleMs`.
//   reclaim  rename the stale folder aside: one reclaimer wins, the others get ENOENT. The winner checks that what it
//            moved is the owner it judged stale, puts it back if not, and removes it if so.
//   release  owner-checked: a folder that has changed hands is left alone.
//
// Set MIDSTUDY_DIRLOCK_TEST_PAUSE=<file> to stop a reclaimer between its judgment and the rename, which is the window
// the aside check is for: it creates <file>.paused.<pid>, then waits (30 s at most) until <file> exists.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lockOwner, lockVerdict, sameOwner } from '../../common/logic/lock.ts'

const GRACE_MS = 10_000
/** How long an owner on another host keeps a lock by default (eval-lock's old --stale-min). */
const FOREIGN_STALE_MS = 180 * 60_000
const CLAIM_ATTEMPTS = 4

/** The locks this process holds, by folder. */
const heldHere = new Map()

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** The holder of the lock folder `dir`, or null when it is free or has no readable owner.json. */
export function readOwner(dir) {
  try {
    const value = JSON.parse(fs.readFileSync(path.join(dir, 'owner.json'), 'utf8'))
    return typeof value === 'object' && value !== null ? lockOwner(value) : null
  } catch {
    return null
  }
}

function asideName(dir, why) {
  return `${dir}.${why}-${process.pid}-${randomBytes(4).toString('hex')}`
}

/** What a claimer sees of a folder it could not create; null when it has gone meanwhile. */
function judge(dir, staleMs) {
  let dirMtime
  try {
    dirMtime = fs.statSync(dir).mtimeMs
  } catch {
    return null
  }
  const owner = readOwner(dir)
  const host = os.hostname()
  const started = owner === null ? NaN : Date.parse(owner.started)
  const ageMs = Date.now() - (Number.isFinite(started) ? started : dirMtime)
  const sameHost = owner !== null && owner.host === host
  const ownerAlive = sameHost ? alive(owner.pid) : null
  const verdict = lockVerdict({ owner, ageMs, host, ownerAlive }, sameHost ? Infinity : staleMs, GRACE_MS, 0)
  return { verdict, owner }
}

function testPause() {
  const gate = process.env.MIDSTUDY_DIRLOCK_TEST_PAUSE
  if (!gate) return
  fs.writeFileSync(`${gate}.paused.${process.pid}`, '')
  const cell = new Int32Array(new SharedArrayBuffer(4))
  const deadline = Date.now() + 30_000
  while (!fs.existsSync(gate) && Date.now() < deadline) Atomics.wait(cell, 0, 0, 5)
}

/** Moves a stale folder aside and removes it; false when another reclaimer or a fresh holder got there first. */
function reclaim(dir, judged) {
  testPause()
  const aside = asideName(dir, 'stale')
  try {
    fs.renameSync(dir, aside)
  } catch {
    return false
  }
  const moved = readOwner(aside)
  const same = judged === null ? moved === null : moved !== null && sameOwner(moved, judged)
  if (!same) {
    try {
      fs.renameSync(aside, dir)
    } catch {
      // Someone made the name meanwhile. A folder with no owner.json was a claimer's that lost its write and retries
      // (it writes by path, so nothing can reach the folder here): remove it. One with an owner.json stays aside, and
      // its holder's release finds it gone.
      if (moved === null) fs.rmSync(aside, { recursive: true, force: true })
    }
    return false
  }
  fs.rmSync(aside, { recursive: true, force: true })
  return true
}

function writeOwner(dir, owner) {
  const file = path.join(dir, 'owner.json')
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString('hex')}`
  fs.writeFileSync(tmp, JSON.stringify(owner) + '\n')
  fs.renameSync(tmp, file)
}

function releaseSync(dir, owner) {
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

/** Claims the lock folder `dir` if it is free or stale: `{dir, owner, release()}`, or null while it is held. `cmd` says
 *  what holds it; `staleMs` is how long an owner on another host keeps it. release() is safe to call twice. */
export function tryClaim(dir, { cmd = process.argv.slice(1).join(' '), staleMs = FOREIGN_STALE_MS } = {}) {
  fs.mkdirSync(path.dirname(dir), { recursive: true })
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt++) {
    let made = false
    try {
      fs.mkdirSync(dir)
      made = true
      const owner = { pid: process.pid, host: os.hostname(), cmd, started: new Date().toISOString() }
      writeOwner(dir, owner)
      heldHere.set(dir, owner)
      return { dir, owner, release: () => releaseSync(dir, owner) }
    } catch (e) {
      // A reclaimer moved our new folder aside before owner.json was in: ENOENT, or EINVAL from macOS mid-rename.
      if (made && (e.code === 'ENOENT' || e.code === 'EINVAL')) continue
      if (made) fs.rmSync(dir, { recursive: true, force: true })
      if (e.code !== 'EEXIST') throw e
    }
    const seen = judge(dir, staleMs)
    if (seen === null) continue
    if (seen.verdict === 'held' || !reclaim(dir, seen.owner)) return null
  }
  return null
}

/** Gives back every lock this process holds that is still its own, for exit paths. */
export function releaseAllSync() {
  for (const [dir, owner] of [...heldHere]) releaseSync(dir, owner)
}
