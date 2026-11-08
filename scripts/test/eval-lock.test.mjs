// scripts/eval-lock.mjs, the machine-wide eval semaphore. Each case has its own lock root (MIDSTUDY_EVAL_LOCK_DIR);
// MIDSTUDY_DIRLOCK_TEST_PAUSE forces a reclaim race, and MIDSTUDY_EVAL_LOCK_GRACE_S shortens the 60 s group grace.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'

const SCRIPT = new URL('../eval-lock.mjs', import.meta.url).pathname

function tempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-lock-'))
  const pids = []
  t.after(() => {
    for (const pid of pids) try { process.kill(pid, 'SIGKILL') } catch { /* gone */ }
    fs.rmSync(root, { recursive: true, force: true })
  })
  const locks = path.join(root, 'locks')
  return { root, locks, pids, slot: (i) => path.join(locks, `slot-${i}`), marker: path.join(locks, 'exclusive-wanted'), file: (n) => path.join(root, n) }
}

function run(c, args, env = {}) {
  const child = spawn(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, MIDSTUDY_EVAL_LOCK_DIR: c.locks, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', (b) => { stderr += String(b) })
  const done = new Promise((resolve) => child.on('close', (code, signal) => resolve({ code, signal, stderr, at: Date.now() })))
  return { child, done }
}

const runSync = (c, args, timeout = 6000) =>
  spawnSync(process.execPath, [SCRIPT, ...args], { env: { ...process.env, MIDSTUDY_EVAL_LOCK_DIR: c.locks }, encoding: 'utf8', timeout })

async function until(what, f, ms = 20_000) {
  const deadline = Date.now() + ms
  while (!f()) {
    assert.ok(Date.now() < deadline, 'timed out waiting for ' + what)
    await sleep(5)
  }
}

const alive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' } }
const deadPid = () => spawnSync(process.execPath, ['-e', '']).pid
const ownerJson = (d) => JSON.parse(fs.readFileSync(path.join(d, 'owner.json'), 'utf8'))
function plant(d, pid, started = new Date().toISOString()) {
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'owner.json'), JSON.stringify({ pid, host: os.hostname(), cmd: 'planted', started }))
}

/** A command that writes `started`, then runs until `release` exists. */
function holdUntil(started, release) {
  const body = `const fs=require('fs');fs.writeFileSync(${JSON.stringify(started)},'');setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))process.exit(0)},10)`
  return [process.execPath, '-e', body]
}

/** A command with a grandchild in its process group, whose pid lands in `pidFile` once it is ready. `ignoreTerm`: the
 *  command survives SIGTERM. `leave`: it exits at once (code 7), leaving the grandchild behind. */
function withGrandchild(pidFile, { ignoreTerm = false, grandIgnoresTerm = false, leave = false } = {}) {
  const grand = `${grandIgnoresTerm ? "process.on('SIGTERM',()=>{});" : ''}require('fs').writeFileSync(process.argv[1],String(process.pid));setInterval(()=>{},1000)`
  const ready = leave ? 'process.exit(7)' : `fs.writeFileSync(${JSON.stringify(pidFile + '.up')},'')`
  const body = `const{spawn}=require('child_process'),fs=require('fs');
${ignoreTerm ? "process.on('SIGTERM',()=>{});" : ''}
const g=spawn(process.execPath,['-e',${JSON.stringify(grand)},${JSON.stringify(pidFile)}],{stdio:'ignore'});
g.unref();
const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(pidFile)})&&fs.statSync(${JSON.stringify(pidFile)}).size>0){clearInterval(t);${ready}}},5);
setInterval(()=>{},1000)`
  return [process.execPath, '-e', body]
}

const readPid = (f) => Number(fs.readFileSync(f, 'utf8'))
const hasPid = (f) => fs.existsSync(f) && fs.statSync(f).size > 0

test('a shared run takes slot-0 and leaves an owner.json older worktrees can read', async (t) => {
  const c = tempRoot(t)
  const r = run(c, ['--', ...holdUntil(c.file('up'), c.file('go'))])
  await until('the command', () => fs.existsSync(c.file('up')))
  const o = ownerJson(c.slot(0))
  assert.equal(o.pid, r.child.pid)
  assert.equal(o.host, os.hostname())
  assert.equal(typeof o.cmd, 'string')
  assert.ok(Number.isFinite(Date.parse(o.started)))
  fs.writeFileSync(c.file('go'), '')
  assert.equal((await r.done).code, 0)
  assert.equal(fs.existsSync(c.slot(0)), false)
})

test('the exit code is the command\'s; 127 when it cannot start', async (t) => {
  const c = tempRoot(t)
  assert.equal((await run(c, ['--', process.execPath, '-e', 'process.exit(9)']).done).code, 9)
  assert.equal((await run(c, ['--', path.join(c.root, 'no-such-program')]).done).code, 127)
  assert.deepEqual(fs.readdirSync(c.locks), [])
})

test('(a) two reclaimers of one dead slot: never two holders', async (t) => {
  const c = tempRoot(t)
  plant(c.slot(0), deadPid())
  const gate = c.file('gate')
  const inside = c.file('inside')
  const overlap = c.file('overlap')
  const body = `const fs=require('fs');try{fs.mkdirSync(${JSON.stringify(inside)})}catch{fs.writeFileSync(${JSON.stringify(overlap)},'')}
setTimeout(()=>{fs.rmSync(${JSON.stringify(inside)},{recursive:true,force:true})},1500)`
  const args = ['--slots', '1', '--', process.execPath, '-e', body]
  const env = { MIDSTUDY_DIRLOCK_TEST_PAUSE: gate }
  const a = run(c, args, env)
  const b = run(c, args, env)
  await until('both reclaimers at the pause', () => fs.readdirSync(c.root).filter((f) => f.startsWith('gate.paused')).length === 2)
  fs.writeFileSync(gate, '')
  const [ra, rb] = await Promise.all([a.done, b.done])
  assert.deepEqual([ra.code, rb.code], [0, 0])
  assert.equal(fs.existsSync(overlap), false, 'both ran at once')
})

test('(b) a live pid on this host keeps its slot whatever its age', (t) => {
  const c = tempRoot(t)
  plant(c.slot(0), process.pid, '1970-01-01T00:00:00.000Z')
  const r = runSync(c, ['--slots', '1', '--wait-min', '0.02', '--', 'touch', c.file('ran')])
  assert.equal(r.status, 75)
  assert.equal(fs.existsSync(c.file('ran')), false)
  assert.equal(ownerJson(c.slot(0)).pid, process.pid)
})

test('(c) no shared request of any --slots count starts during an exclusive run', async (t) => {
  const c = tempRoot(t)
  const ex = run(c, ['--exclusive', '--', ...holdUntil(c.file('up'), c.file('go'))])
  await until('the exclusive command', () => fs.existsSync(c.file('up')))
  assert.equal(ownerJson(c.marker).pid, ex.child.pid, 'the marker stands for the whole run')
  const shared = await run(c, ['--slots', '5', '--wait-min', '0.03', '--', 'touch', c.file('ran')]).done
  assert.equal(shared.code, 75, shared.stderr)
  assert.equal(fs.existsSync(c.file('ran')), false)
  fs.writeFileSync(c.file('go'), '')
  assert.equal((await ex.done).code, 0)
  assert.deepEqual(fs.readdirSync(c.locks), [])
})

test('(c) an exclusive run waits for a live slot beyond its own, and gives everything back when it times out', async (t) => {
  const c = tempRoot(t)
  plant(c.slot(4), process.pid)
  const r = await run(c, ['--exclusive', '--wait-min', '0.03', '--', 'touch', c.file('ran')]).done
  assert.equal(r.code, 75, r.stderr)
  assert.equal(fs.existsSync(c.file('ran')), false)
  assert.deepEqual(fs.readdirSync(c.locks), ['slot-4'])
})

test('(c) a dead slot beyond its own does not hold an exclusive run back', async (t) => {
  const c = tempRoot(t)
  plant(c.slot(4), deadPid())
  assert.equal((await run(c, ['--exclusive', '--wait-min', '0.1', '--', 'touch', c.file('ran')]).done).code, 0)
  assert.ok(fs.existsSync(c.file('ran')))
})

test('a marker with a live waiter is not reclaimed and holds shared requests back, whatever its age', async (t) => {
  const c = tempRoot(t)
  plant(c.marker, process.pid, '1970-01-01T00:00:00.000Z')
  const r = await run(c, ['--wait-min', '0.03', '--', 'touch', c.file('ran')]).done
  assert.equal(r.code, 75, r.stderr)
  assert.equal(fs.existsSync(c.file('ran')), false)
  assert.equal(ownerJson(c.marker).pid, process.pid)
})

test('a stale marker (dead pid) is ignored and reclaimed', async (t) => {
  const c = tempRoot(t)
  plant(c.marker, deadPid())
  assert.equal((await run(c, ['--wait-min', '0.1', '--', 'touch', c.file('a')]).done).code, 0)
  assert.equal((await run(c, ['--exclusive', '--wait-min', '0.1', '--', 'touch', c.file('b')]).done).code, 0)
  assert.deepEqual(fs.readdirSync(c.locks), [])
})

for (const args of [['--wait-min'], ['--wait-min', 'soon'], ['--wait-min', '0'], ['--wait-min', '-1'], ['--slots', 'abc'], ['--slots', '0'], ['--slots', '1.5'], ['--slots', ''], ['--stale-min', 'NaN'], ['--stale-min', 'Infinity'], ['--bogus']]) {
  test(`(d) ${JSON.stringify(args)} prints the usage and exits 2`, (t) => {
    const c = tempRoot(t)
    const r = runSync(c, [...args, '--', 'touch', c.file('ran')])
    assert.equal(r.status, 2, r.stderr)
    assert.match(r.stderr, /usage/)
    assert.equal(fs.existsSync(c.file('ran')), false)
  })
}

test('(e) SIGTERM reaches the grandchildren, and they are dead before the slot is given back', async (t) => {
  const c = tempRoot(t)
  const pidFile = c.file('grand')
  const r = run(c, ['--', ...withGrandchild(pidFile)])
  await until('the grandchild', () => fs.existsSync(pidFile + '.up'))
  const grand = readPid(pidFile)
  c.pids.push(grand)
  r.child.kill('SIGTERM')
  await until('the slot to go', () => {
    if (fs.existsSync(c.slot(0))) return false
    assert.equal(alive(grand), false, 'the slot was given back while the grandchild ran')
    return true
  })
  await r.done
})

test('(f) a holder whose slot was taken over leaves the new owner\'s folder', async (t) => {
  const c = tempRoot(t)
  const r = run(c, ['--', ...holdUntil(c.file('up'), c.file('go'))])
  await until('the command', () => fs.existsSync(c.file('up')))
  fs.rmSync(c.slot(0), { recursive: true })
  plant(c.slot(0), process.pid)
  fs.writeFileSync(c.file('go'), '')
  assert.equal((await r.done).code, 0)
  assert.equal(ownerJson(c.slot(0)).pid, process.pid)
})

test('(g) a grandchild that ignores SIGTERM: SIGKILLed at the grace, and eval-lock exits within grace + 1 s', async (t) => {
  const c = tempRoot(t)
  const pidFile = c.file('grand')
  const r = run(c, ['--', ...withGrandchild(pidFile, { grandIgnoresTerm: true })], { MIDSTUDY_EVAL_LOCK_GRACE_S: '2' })
  await until('the grandchild', () => fs.existsSync(pidFile + '.up'))
  const grand = readPid(pidFile)
  c.pids.push(grand)
  const t0 = Date.now()
  r.child.kill('SIGTERM')
  const end = await r.done
  assert.ok(end.at - t0 >= 1900, 'waited out the grace: ' + String(end.at - t0))
  assert.ok(end.at - t0 < 3000, 'within grace + 1 s: ' + String(end.at - t0))
  assert.equal(alive(grand), false)
  assert.equal(fs.existsSync(c.slot(0)), false)
})

test('(g) after a normal exit a lingering group member gets the bounded wait, then SIGKILL, and the exit code stands', async (t) => {
  const c = tempRoot(t)
  const pidFile = c.file('grand')
  const r = run(c, ['--', ...withGrandchild(pidFile, { grandIgnoresTerm: true, leave: true })], { MIDSTUDY_EVAL_LOCK_GRACE_S: '1' })
  await until('the grandchild', () => hasPid(pidFile))
  const grand = readPid(pidFile)
  c.pids.push(grand)
  const end = await r.done
  assert.equal(end.code, 7)
  assert.equal(alive(grand), false)
  assert.equal(fs.existsSync(c.slot(0)), false)
})

test('a second signal after the burst window SIGKILLs the group at once', async (t) => {
  const c = tempRoot(t)
  const pidFile = c.file('grand')
  const r = run(c, ['--', ...withGrandchild(pidFile, { ignoreTerm: true, grandIgnoresTerm: true })], { MIDSTUDY_EVAL_LOCK_GRACE_S: '30' })
  await until('the grandchild', () => fs.existsSync(pidFile + '.up'))
  c.pids.push(readPid(pidFile))
  r.child.kill('SIGTERM')
  await sleep(2300)
  const t0 = Date.now()
  r.child.kill('SIGTERM')
  const end = await r.done
  assert.ok(end.at - t0 < 2000, 'took ' + String(end.at - t0))
  assert.equal(alive(readPid(pidFile)), false)
})

test('signals of one burst count once: the command keeps its time to clean up', async (t) => {
  const c = tempRoot(t)
  const cleaned = c.file('cleaned')
  const body = `process.on('SIGTERM',()=>setTimeout(()=>{require('fs').writeFileSync(${JSON.stringify(cleaned)},'');process.exit(0)},600));require('fs').writeFileSync(${JSON.stringify(c.file('up'))},'');setInterval(()=>{},1000)`
  const r = run(c, ['--', process.execPath, '-e', body], { MIDSTUDY_EVAL_LOCK_GRACE_S: '30' })
  await until('the command', () => fs.existsSync(c.file('up')))
  r.child.kill('SIGTERM')
  await sleep(100)
  r.child.kill('SIGTERM')
  await r.done
  assert.ok(fs.existsSync(cleaned), 'the second signal of the burst killed the cleanup')
})

test('a signal while waiting gives back the marker and exits 130', async (t) => {
  const c = tempRoot(t)
  plant(c.slot(0), process.pid)
  const r = run(c, ['--exclusive', '--', 'touch', c.file('ran')])
  await until('the marker', () => fs.existsSync(path.join(c.marker, 'owner.json')))
  r.child.kill('SIGTERM')
  assert.equal((await r.done).code, 130)
  assert.deepEqual(fs.readdirSync(c.locks), ['slot-0'])
})

test('the grace ladder: the group grace stays 60 s, above createEval\'s 40 s and all.mjs\'s 50 s', () => {
  assert.match(fs.readFileSync(SCRIPT, 'utf8'), /const GROUP_GRACE_S = 60\b/)
})
