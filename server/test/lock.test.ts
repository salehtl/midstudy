// The v2 library lock (contract §2.8 One writer, v2; common/lock.ts) across processes: mutual exclusion (no lost
// update over many takes by several processes), a waiter giving up after its time (Busy), a dead holder's lock
// reclaimed at once, an old one reclaimed after the tool timeout (a live owner on this host only past the margin, and
// never by the process that holds it), a lock folder without owner.json reclaimed after the
// grace, a release that never removes someone else's lock, and v1's lock file kept beside it.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireLock, Busy, costsLockDir, libraryLockDir, withLibraryLock } from '../../common/lock.ts'
import { appendCost } from '../../common/costs.ts'
import { lockVerdict } from '../../common/logic/lock.ts'
import { REPO, SCRATCH } from './helpers.ts'

const DIR = path.join(SCRATCH, 'lock-' + String(process.pid))
const CHILD = path.join(REPO, 'server/test/lock-child.ts')

before(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
})
after(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
})

function child(args: readonly string[]): { readonly done: Promise<number>; readonly held: Promise<void>; kill(): void } {
  const c = spawn(process.execPath, [CHILD, ...args], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] })
  const held = new Promise<void>((resolve) => {
    c.stdout.on('data', (d: Buffer) => {
      if (d.toString('utf8').includes('held')) resolve()
    })
  })
  const done = new Promise<number>((resolve) => {
    c.on('exit', (code) => {
      resolve(code ?? -1)
    })
  })
  return { done, held, kill: () => c.kill('SIGKILL') }
}

void test('four processes taking the lock 25 times each never lose an update', async () => {
  const lock = path.join(DIR, 'count.lock.d')
  const counter = path.join(DIR, 'counter')
  fs.writeFileSync(counter, '0')
  const kids = Array.from({ length: 4 }, () => child(['count', lock, counter, '25']))
  const codes = await Promise.all(kids.map((k) => k.done))
  assert.deepEqual(codes, [0, 0, 0, 0])
  assert.equal(fs.readFileSync(counter, 'utf8'), '100')
  assert.equal(fs.existsSync(lock), false, 'released')
})

void test('a waiter gives up after its time with Busy while a live process holds the lock; the lock is free once it is gone', async () => {
  const lock = path.join(DIR, 'held.lock.d')
  const holder = child(['hold', lock])
  await holder.held
  const owner: unknown = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))
  assert.ok(typeof owner === 'object' && owner !== null && 'pid' in owner && 'host' in owner && 'cmd' in owner && 'started' in owner)
  const t0 = Date.now()
  await assert.rejects(acquireLock(lock, { waitMs: 300, cmd: 'test' }), Busy)
  assert.ok(Date.now() - t0 >= 290)
  holder.kill()
  await holder.done
  // its pid is dead on this host now: reclaimed at once
  const mine = await acquireLock(lock, { waitMs: 2000, cmd: 'test' })
  assert.equal(mine.owner.pid, process.pid)
  await mine.release()
  assert.equal(fs.existsSync(lock), false)
})

void test('a holder that exited without releasing is reclaimed by the next taker', async () => {
  const lock = path.join(DIR, 'crash.lock.d')
  const c = child(['crash', lock])
  assert.equal(await c.done, 0)
  assert.ok(fs.existsSync(path.join(lock, 'owner.json')))
  const mine = await acquireLock(lock, { waitMs: 1000, cmd: 'test' })
  await mine.release()
})

void test('a lock on another host is reclaimed past the tool timeout; a young one is not', async () => {
  const lock = path.join(DIR, 'old.lock.d')
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: process.pid, host: 'elsewhere', cmd: 'x', started: new Date(Date.now() - 2 * 3600 * 1000).toISOString() }))
  const mine = await acquireLock(lock, { waitMs: 1000, cmd: 'test' })
  await mine.release()
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 999999, host: 'elsewhere', cmd: 'x', started: new Date().toISOString() }))
  await assert.rejects(acquireLock(lock, { waitMs: 200, cmd: 'test' }), Busy)
  fs.rmSync(lock, { recursive: true })
})

/** Rewrites a held lock's owner.json with `started` moved `ageMs` into the past; the new file's text. */
function backdate(lock: string, ageMs: number): string {
  const file = path.join(lock, 'owner.json')
  const owner: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.ok(typeof owner === 'object' && owner !== null)
  const text = JSON.stringify({ ...owner, started: new Date(Date.now() - ageMs).toISOString() }) + '\n'
  fs.writeFileSync(file, text)
  return text
}

void test('a live holder on this host just past the tool timeout keeps its lock (inside the 10 min margin)', async () => {
  const lock = path.join(DIR, 'live-margin.lock.d')
  const holder = child(['hold', lock])
  await holder.held
  const text = backdate(lock, 3605 * 1000)
  await assert.rejects(acquireLock(lock, { waitMs: 300, cmd: 'test' }), Busy)
  assert.equal(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'), text, 'owner.json untouched')
  holder.kill()
  await holder.done
  fs.rmSync(lock, { recursive: true, force: true })
})

void test('a live holder on this host past the margin is reclaimed (a crashed holder whose pid was reused)', async () => {
  const lock = path.join(DIR, 'live-old.lock.d')
  const holder = child(['hold', lock])
  await holder.held
  backdate(lock, 2 * 3600 * 1000)
  const mine = await acquireLock(lock, { waitMs: 1000, cmd: 'test' })
  assert.equal(mine.owner.pid, process.pid)
  await mine.release()
  holder.kill()
  await holder.done
})

void test('a back-dated lock whose pid is dead is reclaimed at once', async () => {
  const lock = path.join(DIR, 'dead-old.lock.d')
  const c = child(['crash', lock])
  assert.equal(await c.done, 0)
  backdate(lock, 3605 * 1000)
  const mine = await acquireLock(lock, { waitMs: 0, cmd: 'test' })
  await mine.release()
})

void test('a process never reclaims a lock it holds itself, however old', async (t) => {
  const lock = path.join(DIR, 'self.lock.d')
  const first = await acquireLock(lock, { waitMs: 1000, cmd: 'test' })
  t.mock.method(Date, 'now', () => new Date().getTime() + 2 * 3600 * 1000)
  await assert.rejects(acquireLock(lock, { waitMs: 200, cmd: 'test' }), Busy)
  t.mock.restoreAll()
  const owner: unknown = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))
  assert.deepEqual(owner, first.owner)
  await first.release()
  assert.equal(fs.existsSync(lock), false, 'still its own to release')
})

void test('a lock folder with no owner.json is held for the grace period, then reclaimed', async () => {
  const lock = path.join(DIR, 'bare.lock.d')
  fs.mkdirSync(lock)
  await assert.rejects(acquireLock(lock, { waitMs: 150, cmd: 'test', graceMs: 2000 }), Busy)
  const t = await acquireLock(lock, { waitMs: 3000, cmd: 'test', graceMs: 300 })
  await t.release()
})

void test('a release never removes a lock that isn\'t its own any more', async () => {
  const lock = path.join(DIR, 'mine.lock.d')
  const a = await acquireLock(lock, { waitMs: 1000, cmd: 'test' })
  fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify({ pid: 1, host: os.hostname(), cmd: 'someone else', started: new Date().toISOString() }))
  await a.release()
  assert.ok(fs.existsSync(path.join(lock, 'owner.json')))
  fs.rmSync(lock, { recursive: true })
})

void test('the library and costs locks: their folders, v1\'s lock files beside them, and a costs row appended under the lock', async () => {
  const lib = path.join(DIR, 'library')
  assert.equal(libraryLockDir(lib), path.join(lib, '.lock.d'))
  assert.equal(costsLockDir(path.join(lib, 'costs.csv')), path.join(lib, 'costs.csv.lock.d'))
  await withLibraryLock(lib, { waitMs: 1000, cmd: 'test' }, async () => {
    assert.ok(fs.existsSync(path.join(lib, '.lock.d', 'owner.json')))
    await Promise.resolve()
  })
  assert.ok(fs.existsSync(path.join(lib, '.lock')), 'v1\'s flock file')
  assert.equal(fs.existsSync(path.join(lib, '.lock.d')), false)
  const costs = path.join(lib, 'costs.csv')
  await Promise.all([1, 2, 3, 4, 5].map((n) => appendCost(costs, { date: '2026-11-05T21:36:0' + String(n) + 'Z', id: 'r' + String(n), engine: 'render:qwen', costUsd: 0.03 * n, mock: true, input: 's' })))
  const rows = fs.readFileSync(costs, 'utf8').trim().split('\n')
  assert.equal(rows[0], 'date,id,engine,cost_usd,mock,input')
  assert.equal(rows.length, 6)
  assert.ok(fs.existsSync(path.join(lib, 'costs.csv.lock')), 'v1\'s costs.csv.lock (evals/library_api.sh checks it)')
  assert.equal(fs.existsSync(path.join(lib, 'costs.csv.lock.d')), false)
})

void test('the protocol\'s verdicts', () => {
  const owner = { pid: 5, host: 'h', cmd: 'c', started: 'x' }
  assert.equal(lockVerdict({ owner, ageMs: 10, host: 'h', ownerAlive: true }, 1000, 100, 500), 'held')
  assert.equal(lockVerdict({ owner, ageMs: 10, host: 'h', ownerAlive: false }, 1000, 100, 500), 'dead-owner')
  assert.equal(lockVerdict({ owner, ageMs: 10, host: 'other', ownerAlive: null }, 1000, 100, 500), 'held')
  assert.equal(lockVerdict({ owner, ageMs: 2000, host: 'other', ownerAlive: null }, 1000, 100, 500), 'too-old')
  assert.equal(lockVerdict({ owner: null, ageMs: 50, host: 'h', ownerAlive: null }, 1000, 100, 500), 'held')
  assert.equal(lockVerdict({ owner: null, ageMs: 150, host: 'h', ownerAlive: null }, 1000, 100, 500), 'no-owner')
  // a live owner on this host: past staleMs it keeps the lock until the margin is over too
  assert.equal(lockVerdict({ owner, ageMs: 1200, host: 'h', ownerAlive: true }, 1000, 100, 500), 'held')
  assert.equal(lockVerdict({ owner, ageMs: 1500, host: 'h', ownerAlive: true }, 1000, 100, 500), 'held')
  assert.equal(lockVerdict({ owner, ageMs: 1501, host: 'h', ownerAlive: true }, 1000, 100, 500), 'too-old')
  // unknown liveness has no margin; a dead owner is reclaimed whatever its age
  assert.equal(lockVerdict({ owner, ageMs: 1200, host: 'h', ownerAlive: null }, 1000, 100, 500), 'too-old')
  assert.equal(lockVerdict({ owner, ageMs: 1200, host: 'h', ownerAlive: false }, 1000, 100, 500), 'dead-owner')
})
