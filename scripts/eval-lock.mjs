#!/usr/bin/env node
// A machine-wide semaphore for evals, shared by every worktree of this repo (docs/REFACTOR.md §7): browser evals on
// SwiftShader are CPU-heavy, and the Mac runs several agents at once. Three slots by default; --exclusive takes them
// all (performance measurements).
//
// Fairness: an exclusive request first posts a marker (exclusive-wanted/); while it stands, no new shared request takes
// a slot, so the exclusive one gets every slot as the current holders finish (no starvation), and nobody hoards slots
// that others could use for long. Only one exclusive request queues at a time; the next waits for the marker. The
// marker stays up until the exclusive run ends, and that run also waits for any live slot past its own --slots count,
// so nothing shares the machine with it whatever --slots the others ask for.
//
// Slots and the marker are scripts/lib/dirlock.mjs lock folders: a live pid on this host keeps one however old, a dead
// pid loses it at once, and --stale-min applies only to an owner on another host, whose pid can't be checked.
//
// The command runs in its own process group. SIGINT, SIGTERM and SIGHUP go to the whole group; a group still alive
// GROUP_GRACE_S after the first signal is SIGKILLed, and a second signal SIGKILLs it at once (signals within BURST_MS
// of the first are one burst and count once). The grace must exceed createEval's 40 s finish and all.mjs's 50 s step
// wait. After the command exits, the rest of its group gets the same bounded wait. The slots are given back only then.
//
// MIDSTUDY_EVAL_LOCK_DIR replaces the lock root and MIDSTUDY_EVAL_LOCK_GRACE_S the grace, for tests only.
//
// Usage: node scripts/eval-lock.mjs [--exclusive] [--slots N] [--wait-min M] [--stale-min S] -- <command> [args...]
// Exits with the command's exit code; 75 when nothing came free within --wait-min; 2 on bad usage.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { lockVerdict } from '../common/logic/lock.ts'
import { readOwner, tryClaim } from './lib/dirlock.mjs'

const GROUP_GRACE_S = 60
const BURST_MS = 2000
/** How long a SIGKILLed group gets to disappear before the slots go back regardless. */
const AFTER_KILL_MS = 900
const NO_OWNER_GRACE_MS = 10_000
const VALUE_FLAGS = ['--slots', '--wait-min', '--stale-min']

function usage() {
  console.error('eval-lock: usage: node scripts/eval-lock.mjs [--exclusive] [--slots N] [--wait-min M] [--stale-min S] -- <command> [args...]')
  process.exit(2)
}

/** The positive number in `text`; anything else is bad usage. */
function positive(text, integer = false) {
  if (text === undefined || !/^\d+(\.\d+)?$/.test(text)) usage()
  const n = Number(text)
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) usage()
  return n
}

const argv = process.argv.slice(2)
const dash = argv.indexOf('--')
if (dash < 0 || dash === argv.length - 1) usage()
const opts = argv.slice(0, dash)
const cmd = argv.slice(dash + 1)
const given = new Map()
let EXCLUSIVE = false
for (let i = 0; i < opts.length; i++) {
  if (opts[i] === '--exclusive') EXCLUSIVE = true
  else if (VALUE_FLAGS.includes(opts[i])) { given.set(opts[i], opts[i + 1]); i++ } else usage()
}
const option = (k, d, integer) => (given.has(k) ? positive(given.get(k), integer) : d)
const SLOTS = option('--slots', 3, true)
const WAIT_MS = option('--wait-min', 240) * 60_000
const STALE_MS = option('--stale-min', 180) * 60_000
const GRACE_MS = (process.env.MIDSTUDY_EVAL_LOCK_GRACE_S ? positive(process.env.MIDSTUDY_EVAL_LOCK_GRACE_S) : GROUP_GRACE_S) * 1000

const dir = process.env.MIDSTUDY_EVAL_LOCK_DIR ?? path.join(path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()), 'midstudy-eval-locks')
fs.mkdirSync(dir, { recursive: true })
const MARKER = path.join(dir, 'exclusive-wanted')
const slotPath = (i) => path.join(dir, `slot-${i}`)
const slotNames = () => fs.readdirSync(dir).filter((d) => /^slot-\d+$/.test(d))
const claim = (d) => tryClaim(d, { cmd: cmd.join(' '), staleMs: STALE_MS })

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
/** Whether a lock folder is held, by the rule a claimer would apply to it. */
function standing(d) {
  let dirMtime
  try { dirMtime = fs.statSync(d).mtimeMs } catch { return false }
  const owner = readOwner(d)
  const host = os.hostname()
  const started = owner === null ? NaN : Date.parse(owner.started)
  const sameHost = owner !== null && owner.host === host
  const seen = { owner, host, ageMs: Date.now() - (Number.isFinite(started) ? started : dirMtime), ownerAlive: sameHost ? alive(owner.pid) : null }
  return lockVerdict(seen, sameHost ? Infinity : STALE_MS, NO_OWNER_GRACE_MS, 0) === 'held'
}
const markerStands = () => standing(MARKER)
const liveBeyondOwn = () => slotNames().filter((d) => Number(d.slice('slot-'.length)) >= SLOTS && standing(path.join(dir, d)))

const held = []
let marker = null
const release = () => {
  for (const s of held.splice(0)) s.release()
  if (marker) { marker.release(); marker = null }
}
const WAITING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP']
for (const sig of WAITING_SIGNALS) process.on(sig, () => { release(); process.exit(130) })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const t0 = Date.now()
let lastNote = 0
for (;;) {
  if (EXCLUSIVE) {
    marker ??= claim(MARKER)
    if (marker) {
      for (let i = 0; i < SLOTS; i++) {
        const s = slotPath(i)
        if (held.some((h) => h.dir === s)) continue
        const h = claim(s)
        if (h) held.push(h)
      }
      if (held.length === SLOTS && liveBeyondOwn().length === 0) break
    }
  } else if (!markerStands()) {
    for (let i = 0; i < SLOTS && !held.length; i++) { const h = claim(slotPath(i)); if (h) held.push(h) }
    // After the claim, look again: an exclusive request posts its marker and then scans the slots, so one of the two
    // always sees the other.
    if (held.length) { if (!markerStands()) break; release() }
  }
  if (Date.now() - t0 > WAIT_MS) { release(); console.error(`eval-lock: nothing came free in ${WAIT_MS / 60_000} min`); process.exit(75) }
  if (Date.now() - lastNote > 60_000) {
    lastNote = Date.now()
    const owners = slotNames().map((d) => readOwner(path.join(dir, d))?.cmd ?? '?')
    console.error(`eval-lock: waiting (${EXCLUSIVE ? (marker ? 'exclusive, queued first' : 'exclusive, behind another') : markerStands() ? 'shared, an exclusive run is queued' : 'one slot'}); held by: ${owners.join(' | ')}`)
  }
  await sleep(1000)
}

// stdin is ignored: a background process group that reads the terminal gets SIGTTIN and stops.
const child = spawn(cmd[0], cmd.slice(1), { detached: true, stdio: ['ignore', 'inherit', 'inherit'] })
const killGroup = (sig) => { if (child.pid !== undefined) try { process.kill(-child.pid, sig) } catch { /* the group is gone */ } }
const groupAlive = () => child.pid !== undefined && alive(-child.pid)

let firstSignalAt = null
let groupDeadline = Infinity
for (const sig of WAITING_SIGNALS) {
  process.removeAllListeners(sig)
  process.on(sig, () => {
    if (firstSignalAt === null) {
      firstSignalAt = Date.now()
      groupDeadline = firstSignalAt + GRACE_MS
      killGroup(sig)
      setTimeout(() => { killGroup('SIGKILL') }, GRACE_MS).unref()
    } else if (Date.now() - firstSignalAt > BURST_MS) {
      groupDeadline = 0
      killGroup('SIGKILL')
    }
  })
}

const ended = await new Promise((resolve) => {
  child.on('exit', (code, signal) => { resolve({ code, signal }) })
  child.on('error', (e) => { resolve({ error: e }) })
})
if (ended.error) { release(); console.error(`eval-lock: ${ended.error.message}`); process.exit(127) }

groupDeadline = Math.min(groupDeadline, Date.now() + GRACE_MS)
while (groupAlive() && Date.now() < groupDeadline) await sleep(25)
if (groupAlive()) {
  killGroup('SIGKILL')
  const giveUp = Date.now() + AFTER_KILL_MS
  while (groupAlive() && Date.now() < giveUp) await sleep(25)
}
release()
process.exit(ended.code ?? (ended.signal ? 1 : 0))
