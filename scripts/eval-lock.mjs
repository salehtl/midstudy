#!/usr/bin/env node
// A machine-wide semaphore for evals, shared by every worktree of this repo (docs/REFACTOR.md §7): browser evals on
// SwiftShader are CPU-heavy, and the Mac runs several agents at once. Three slots by default; --exclusive takes them
// all (performance measurements).
//
// Fairness: an exclusive request first posts a marker (exclusive-wanted/); while it stands, no new shared request takes
// a slot, so the exclusive one gets every slot as the current holders finish (no starvation), and nobody hoards slots
// that others could use for long. Only one exclusive request queues at a time; the next waits for the marker.
// Stale slots and markers (dead pid on this host, or older than --stale-min) are reclaimed.
//
// Usage: node scripts/eval-lock.mjs [--exclusive] [--slots N] [--wait-min M] [--stale-min S] -- <command> [args...]
// Exits with the command's exit code; 75 when nothing came free within --wait-min.
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const argv = process.argv.slice(2)
const dash = argv.indexOf('--')
if (dash < 0 || dash === argv.length - 1) {
  console.error('eval-lock: usage: node scripts/eval-lock.mjs [--exclusive] [--slots N] -- <command> [args...]')
  process.exit(2)
}
const opts = argv.slice(0, dash)
const cmd = argv.slice(dash + 1)
const num = (k, d) => (opts.includes(k) ? Number(opts[opts.indexOf(k) + 1]) : d)
const SLOTS = num('--slots', 3)
const EXCLUSIVE = opts.includes('--exclusive')
const WAIT_MS = num('--wait-min', 240) * 60_000
const STALE_MS = num('--stale-min', 180) * 60_000

const common = path.resolve(execFileSync('git', ['rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim())
const dir = path.join(common, 'midstudy-eval-locks')
fs.mkdirSync(dir, { recursive: true })
const MARKER = path.join(dir, 'exclusive-wanted')
const me = { pid: process.pid, host: os.hostname(), cwd: process.cwd(), cmd: cmd.join(' '), started: new Date().toISOString() }

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
function stale(d) {
  try {
    const info = JSON.parse(fs.readFileSync(path.join(d, 'owner.json'), 'utf8'))
    if (info.host === me.host && !alive(info.pid)) return true
    return Date.now() - Date.parse(info.started) > STALE_MS
  } catch { // no owner file yet: give its writer a moment
    try { return Date.now() - fs.statSync(d).mtimeMs > 10_000 } catch { return false }
  }
}
// mkdir-based claim of a lock directory; a stale one is moved aside atomically first (only one reclaimer wins).
function claim(d) {
  try { fs.mkdirSync(d) } catch {
    if (!stale(d)) return false
    const aside = `${d}.stale-${process.pid}-${Date.now()}`
    try { fs.renameSync(d, aside) } catch { return false }
    fs.rmSync(aside, { recursive: true, force: true })
    try { fs.mkdirSync(d) } catch { return false }
  }
  fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify(me))
  return true
}
const markerStands = () => fs.existsSync(MARKER) && !stale(MARKER)

const held = []
let ownMarker = false
const release = () => {
  for (const s of held.splice(0)) fs.rmSync(s, { recursive: true, force: true })
  if (ownMarker) { fs.rmSync(MARKER, { recursive: true, force: true }); ownMarker = false }
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { release(); process.exit(130) })

const t0 = Date.now()
let lastNote = 0
for (;;) {
  if (EXCLUSIVE) {
    if (!ownMarker) ownMarker = claim(MARKER)
    if (ownMarker) {
      for (let i = 0; i < SLOTS; i++) {
        const s = path.join(dir, `slot-${i}`)
        if (!held.includes(s) && claim(s)) held.push(s)
      }
      if (held.length === SLOTS) { fs.rmSync(MARKER, { recursive: true, force: true }); ownMarker = false; break }
    }
  } else if (!markerStands()) {
    for (let i = 0; i < SLOTS && !held.length; i++) { const s = path.join(dir, `slot-${i}`); if (claim(s)) held.push(s) }
    if (held.length) break
  }
  if (Date.now() - t0 > WAIT_MS) { release(); console.error(`eval-lock: nothing came free in ${WAIT_MS / 60_000} min`); process.exit(75) }
  if (Date.now() - lastNote > 60_000) {
    lastNote = Date.now()
    const owners = fs.readdirSync(dir).filter((d) => d.startsWith('slot-')).map((d) => { try { return JSON.parse(fs.readFileSync(path.join(dir, d, 'owner.json'), 'utf8')).cmd } catch { return '?' } })
    console.error(`eval-lock: waiting (${EXCLUSIVE ? (ownMarker ? 'exclusive, queued first' : 'exclusive, behind another') : markerStands() ? 'shared, an exclusive run is queued' : 'one slot'}); held by: ${owners.join(' | ')}`)
  }
  await new Promise((r) => setTimeout(r, 1000))
}

const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit' })
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) { process.removeAllListeners(sig); process.on(sig, () => { child.kill(sig) }) }
child.on('exit', (code, signal) => { release(); process.exit(code ?? (signal ? 1 : 0)) })
child.on('error', (e) => { release(); console.error(`eval-lock: ${e.message}`); process.exit(127) })
