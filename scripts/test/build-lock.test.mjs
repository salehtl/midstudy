// scripts/build.mjs's step locks, on a copy of the script in a temp tree (ROOT follows the script), so the real build/
// is not touched. --lock-selftest makes the wasm step a sleep of MIDSTUDY_BUILD_STEP_SLEEP_MS.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO = path.resolve(import.meta.dirname, '../..')
const SOURCES = ['scripts/build.mjs', 'scripts/lib/dirlock.mjs', 'scripts/lib/stamps.mjs', 'common/logic/lock.ts']
const ENTERED = 'lock-selftest: entered'

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'build-lock-'))
  for (const f of SOURCES) fs.cpSync(path.join(REPO, f), path.join(root, f))
  const children = []
  t.after(async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) c.kill('SIGKILL')
    await sleep(50)
    fs.rmSync(root, { recursive: true, force: true })
  })
  return { root, lock: path.join(root, 'build/locks/wasm.lock'), children }
}

/** Starts the step; `entered` resolves with the ms it took to get the lock. */
function step(env, ms) {
  const started = Date.now()
  const child = spawn(process.execPath, [path.join(env.root, 'scripts/build.mjs'), '--wasm-only', '--lock-selftest'], {
    env: { ...process.env, MIDSTUDY_BUILD_STEP_SLEEP_MS: String(ms) }, stdio: ['ignore', 'pipe', 'inherit'],
  })
  env.children.push(child)
  let out = ''
  let isIn = false
  const done = new Promise((resolve) => child.on('exit', resolve))
  const entered = new Promise((resolve) => {
    child.stdout.on('data', (d) => {
      out += d
      if (!isIn && out.includes(ENTERED)) { isIn = true; resolve(Date.now() - started) }
    })
  })
  return { child, done, entered, hasEntered: () => isIn }
}

const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid

function backdate(p, ageMs) {
  const then = new Date(Date.now() - ageMs)
  fs.utimesSync(p, then, then)
}

async function waiterAfter(env, ms) {
  const waiter = step(env, 60_000)
  await sleep(ms)
  return waiter
}

test('a live holder aged 20 minutes keeps its lock', async (t) => {
  const env = tree(t)
  const holder = step(env, 120_000)
  await holder.entered
  const owner = path.join(env.lock, 'owner.json')
  if (fs.existsSync(owner)) {
    const o = JSON.parse(fs.readFileSync(owner, 'utf8'))
    fs.writeFileSync(owner, JSON.stringify({ ...o, started: new Date(Date.now() - 20 * 60_000).toISOString() }))
  }
  backdate(env.lock, 20 * 60_000)
  const waiter = await waiterAfter(env, 1500)
  assert.equal(waiter.hasEntered(), false, 'the second build took over a live lock')
})

test('a SIGTERMed holder frees the lock at once, and its temp folders are swept', async (t) => {
  const env = tree(t)
  const holder = step(env, 120_000)
  await holder.entered
  holder.child.kill('SIGTERM')
  await holder.done
  assert.equal(fs.existsSync(env.lock), true, 'default SIGTERM death leaves the folder')

  const dead = path.join(env.root, `build/wasm/.tmp-wasm-web-${deadPid()}`)
  const live = path.join(env.root, `build/wasm/.tmp-wasm-web-${process.pid}`)
  fs.mkdirSync(dead, { recursive: true })
  fs.mkdirSync(live, { recursive: true })
  const next = step(env, 0)
  assert.ok((await next.entered) < 5000, 'entered through the dead-pid path, not a timeout')
  await next.done
  assert.equal(fs.existsSync(dead), false, "a dead build's temp folder is removed")
  assert.equal(fs.existsSync(live), true, "a live build's temp folder is left alone")
  assert.equal(fs.existsSync(env.lock), false, 'released')
})

function plantEmpty(env, ageMs) {
  fs.mkdirSync(env.lock, { recursive: true })
  // Also the old format's pid file: an empty one read as pid 0, which is "alive".
  fs.writeFileSync(path.join(env.lock, 'owner.json'), '')
  fs.writeFileSync(path.join(env.lock, 'pid'), '')
  backdate(env.lock, ageMs)
}

test('an empty owner file older than 10 s is reclaimed', async (t) => {
  const env = tree(t)
  plantEmpty(env, 11_000)
  const next = step(env, 0)
  const took = await Promise.race([next.entered, sleep(5000).then(() => Infinity)])
  assert.ok(took < 5000, 'not reclaimed')
  await next.done
})

test('an empty owner file younger than 10 s is held', async (t) => {
  const env = tree(t)
  plantEmpty(env, 0)
  const waiter = await waiterAfter(env, 1500)
  assert.equal(waiter.hasEntered(), false, 'entered a lock still in its grace')
})
