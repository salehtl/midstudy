// scripts/lib/dirlock.mjs: the lock-directory helper of the build steps, the eval semaphore and the out-dir locks.
// Children stand in for other processes; MIDSTUDY_DIRLOCK_TEST_PAUSE forces the judged-stale-then-fresh interleavings.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { sameOwner } from '../../common/logic/lock.ts'
import { readOwner, releaseAllSync, tryClaim } from '../lib/dirlock.mjs'

const MODULE = new URL('../lib/dirlock.mjs', import.meta.url).href
const CLAIM_CHILD = `import(${JSON.stringify(MODULE)}).then(({ tryClaim }) => {
  const h = tryClaim(process.argv[1], { cmd: 'child' })
  console.log(JSON.stringify({ claimed: h !== null, pid: process.pid }))
  process.stdin.resume() // stays alive until the test closes its stdin: a holder that exits is a dead owner, free to reclaim
})`

function tempLock(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dirlock-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  return { root, dir: path.join(root, 'step.lock') }
}

/** A pid that has just exited. */
function deadPid() {
  return spawnSync(process.execPath, ['-e', '']).pid
}

function plant(dir, owner) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'owner.json'), typeof owner === 'string' ? owner : JSON.stringify(owner))
}

const ownerOf = (pid, started = new Date().toISOString(), host = os.hostname()) => ({ pid, host, cmd: 'planted', started })

function backdate(dir, ageMs) {
  const then = new Date(Date.now() - ageMs)
  fs.utimesSync(dir, then, then)
}

/** Starts a claiming child, alive until the test ends: `done` is what it reports. */
function claimChild(t, dir, env = {}) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', CLAIM_CHILD, dir], {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'inherit'],
  })
  t.after(() => child.stdin.end())
  let out = ''
  const done = new Promise((resolve, reject) => {
    child.on('error', reject)
    child.stdout.on('data', (b) => {
      out += String(b)
      if (out.endsWith('\n')) resolve(JSON.parse(out))
    })
    child.on('close', (code) => reject(new Error('claim child closed early: ' + String(code))))
  })
  return { child, done }
}

/** Waits until `n` children have stopped at the pause hook named `gate`. */
async function paused(root, n) {
  const deadline = Date.now() + 20_000
  while (fs.readdirSync(root).filter((f) => f.startsWith('gate.paused')).length < n) {
    assert.ok(Date.now() < deadline, 'timed out waiting for the pause hook')
    await sleep(5)
  }
}

function asides(root) {
  return fs.readdirSync(root).filter((f) => /\.(stale|released)-/.test(f))
}

test('a free lock is claimed once, its parents made, and owner.json is complete', (t) => {
  const { root } = tempLock(t)
  const dir = path.join(root, 'a', 'b', 'x.lock')
  const held = tryClaim(dir, { cmd: 'first' })
  assert.ok(held)
  assert.deepEqual(Object.keys(readOwner(dir)).sort(), ['cmd', 'host', 'pid', 'started'])
  assert.equal(readOwner(dir).cmd, 'first')
  assert.equal(readOwner(dir).pid, process.pid)
  assert.equal(tryClaim(dir, { cmd: 'second' }), null)
  assert.deepEqual(fs.readdirSync(dir), ['owner.json'])
  held.release()
  assert.equal(fs.existsSync(dir), false)
  assert.deepEqual(asides(path.dirname(dir)), [])
  held.release()
})

test('(a) judged stale, then a fresh holder: the reclaimer puts it back and that holder stays the only one', async (t) => {
  const { root, dir } = tempLock(t)
  plant(dir, ownerOf(deadPid()))
  const gate = path.join(root, 'gate')
  const { done } = claimChild(t, dir, { MIDSTUDY_DIRLOCK_TEST_PAUSE: gate })
  await paused(root, 1)
  fs.rmSync(dir, { recursive: true })
  const fresh = tryClaim(dir, { cmd: 'fresh' })
  assert.ok(fresh)
  fs.writeFileSync(gate, '')
  const child = await done
  assert.equal(child.claimed, false)
  assert.ok(sameOwner(readOwner(dir), fresh.owner))
  assert.deepEqual(asides(root), [])
  fresh.release()
})

test('(a) two reclaimers past the judgment of one dead owner: never two holders', async (t) => {
  for (let round = 0; round < 8; round++) {
    const { root, dir } = tempLock(t)
    plant(dir, ownerOf(deadPid()))
    const gate = path.join(root, 'gate')
    const a = claimChild(t, dir, { MIDSTUDY_DIRLOCK_TEST_PAUSE: gate })
    const b = claimChild(t, dir, { MIDSTUDY_DIRLOCK_TEST_PAUSE: gate })
    await paused(root, 2)
    fs.writeFileSync(gate, '')
    const results = await Promise.all([a.done, b.done])
    const winners = results.filter((r) => r.claimed)
    assert.ok(winners.length <= 1, JSON.stringify(results))
    if (winners.length === 1) assert.equal(readOwner(dir).pid, winners[0].pid)
    assert.deepEqual(asides(root), [])
  }
})

test('many racers on a free lock: exactly one holds', async (t) => {
  const { dir } = tempLock(t)
  const results = await Promise.all(Array.from({ length: 8 }, () => claimChild(t, dir).done))
  assert.equal(results.filter((r) => r.claimed).length, 1, JSON.stringify(results))
})

test('(b) release by an ex-owner leaves the new owner\'s folder', (t) => {
  const { root, dir } = tempLock(t)
  const held = tryClaim(dir, { cmd: 'old' })
  assert.ok(held)
  const next = ownerOf(process.ppid)
  plant(dir, next)
  held.release()
  assert.deepEqual(readOwner(dir), next)
  assert.deepEqual(asides(root), [])
})

test('(c) a live pid on this host is held whatever its age', (t) => {
  const { dir } = tempLock(t)
  const owner = ownerOf(process.ppid, '1970-01-01T00:00:00.000Z')
  plant(dir, owner)
  assert.equal(tryClaim(dir, { cmd: 'thief', staleMs: 1 }), null)
  assert.deepEqual(readOwner(dir), owner)
})

test('(d) a dead pid on this host is reclaimed at once, however young', (t) => {
  const { dir } = tempLock(t)
  plant(dir, ownerOf(deadPid()))
  const held = tryClaim(dir, { cmd: 'next' })
  assert.ok(held)
  assert.equal(readOwner(dir).cmd, 'next')
  held.release()
})

test('(e) no readable owner.json: held for 10 s, reclaimed after', (t) => {
  for (const [name, content] of [['missing', null], ['empty', ''], ['partial', '{"pid":'], ['pid 0', JSON.stringify(ownerOf(0))]]) {
    const { dir } = tempLock(t)
    if (content === null) fs.mkdirSync(dir)
    else plant(dir, content)
    backdate(dir, 5_000)
    assert.equal(tryClaim(dir, { cmd: 'early' }), null, name + ' at 5 s')
    backdate(dir, 11_000)
    const held = tryClaim(dir, { cmd: 'late' })
    assert.ok(held, name + ' at 11 s')
    assert.equal(readOwner(dir).cmd, 'late')
    held.release()
  }
})

test('an owner on another host goes stale only past staleMs', (t) => {
  const { dir } = tempLock(t)
  const started = new Date(Date.now() - 60_000).toISOString()
  plant(dir, ownerOf(1, started, 'some-other-host'))
  assert.equal(tryClaim(dir, { cmd: 'early', staleMs: 120_000 }), null)
  const held = tryClaim(dir, { cmd: 'late', staleMs: 30_000 })
  assert.ok(held)
  held.release()
})

test('readOwner answers null for a free lock', (t) => {
  const { dir } = tempLock(t)
  assert.equal(readOwner(dir), null)
})

test('releaseAllSync gives back what this process holds, and leaves a folder that changed hands', (t) => {
  const { root } = tempLock(t)
  const mine = path.join(root, 'mine.lock')
  const lost = path.join(root, 'lost.lock')
  assert.ok(tryClaim(mine, { cmd: 'x' }))
  assert.ok(tryClaim(lost, { cmd: 'x' }))
  const next = ownerOf(process.ppid)
  plant(lost, next)
  releaseAllSync()
  assert.equal(fs.existsSync(mine), false)
  assert.deepEqual(readOwner(lost), next)
})
