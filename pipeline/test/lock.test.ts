// The v2 library lock as midstudy-add uses it (common/lock.ts, contract §2.8 One writer; the server's own tests are
// server/test/lock.test.ts): one holder at a time across processes, stale locks reclaimed (a dead owner on this host,
// or older than the tool timeout), a live or foreign owner waited for (said once), and the CLI letting go of it (and of
// its staging folder) when interrupted.
//
//   nix develop -c node --test pipeline/test/lock.test.ts
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { acquireLock, Busy, releaseAllSync, withLock } from '../../common/lock.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const LOCK_TS = path.join(REPO, 'common/lock.ts')
const SCRATCH = path.join(REPO, 'evals/out/pipeline-lock-test')
const CMD = 'midstudy-add test'

function fresh(name: string): string {
  const dir = path.join(SCRATCH, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function writeOwner(lock: string, owner: { pid: number; host: string; cmd: string; started: string }): void {
  fs.mkdirSync(lock)
  fs.writeFileSync(path.join(lock, 'owner.json'), `${JSON.stringify(owner)}\n`)
}

function deadPid(): number {
  const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  return Number(r.stdout)
}

void test('one holder at a time across six processes', async () => {
  const dir = fresh('mutex')
  const lock = path.join(dir, '.lock.d')
  const log = path.join(dir, 'log.txt')
  const child = `
    const { withLock } = await import(${JSON.stringify(LOCK_TS)})
    const fs = await import('node:fs')
    await withLock(${JSON.stringify(lock)}, { waitMs: null, cmd: 'midstudy-add child' }, async () => {
      fs.appendFileSync(${JSON.stringify(log)}, 'S' + process.argv[1] + '\\n')
      await new Promise((r) => setTimeout(r, 40))
      fs.appendFileSync(${JSON.stringify(log)}, 'E' + process.argv[1] + '\\n')
    })`
  const runs = Array.from({ length: 6 }, (_, i) => new Promise<number>((resolve) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child, String(i)], { stdio: 'ignore' })
    p.on('exit', (code) => { resolve(code ?? -1) })
  }))
  assert.deepEqual(await Promise.all(runs), [0, 0, 0, 0, 0, 0])
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(lines.length, 12)
  for (let i = 0; i < lines.length; i += 2) {
    assert.equal(lines[i]?.[0], 'S')
    assert.equal(lines[i + 1], `E${lines[i]?.slice(1) ?? ''}`, `interleaved: ${lines.join(' ')}`)
  }
  assert.equal(fs.existsSync(lock), false)
})

void test('a lock whose owner died on this host is reclaimed at once (v1\'s flock file kept beside it)', async () => {
  const lock = path.join(fresh('dead'), '.lock.d')
  writeOwner(lock, { pid: deadPid(), host: os.hostname(), cmd: 'midstudy-add old', started: new Date().toISOString() })
  let waited = false
  const t = Date.now()
  const me = await acquireLock(lock, { waitMs: 2000, cmd: CMD, onWait: () => { waited = true } })
  assert.equal(waited, false)
  assert.ok(Date.now() - t < 1000)
  const written: unknown = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'))
  assert.ok(typeof written === 'object' && written !== null && 'pid' in written && written.pid === process.pid && 'cmd' in written && written.cmd === CMD)
  await me.release()
  assert.equal(fs.existsSync(lock), false)
  assert.deepEqual(fs.readdirSync(path.dirname(lock)), ['.lock'])
})

void test('a live owner is waited for (said once), an hour-old lock is reclaimed whoever holds it', async () => {
  const dir = fresh('live')
  const lock = path.join(dir, '.lock.d')
  writeOwner(lock, { pid: process.pid, host: os.hostname(), cmd: 'midstudy-add other', started: new Date().toISOString() })
  let waits = 0
  await assert.rejects(acquireLock(lock, { waitMs: 300, cmd: CMD, onWait: () => { waits++ } }), Busy)
  assert.equal(waits, 1)
  fs.rmSync(lock, { recursive: true })
  writeOwner(lock, { pid: process.pid, host: os.hostname(), cmd: 'midstudy-add other', started: new Date(Date.now() - 3601 * 1000).toISOString() })
  const me = await acquireLock(lock, { waitMs: 2000, cmd: CMD })
  await me.release()
  // another host's owner can't be checked: only its age makes it stale
  writeOwner(lock, { pid: deadPid(), host: 'elsewhere.invalid', cmd: 'midstudy-add far', started: new Date().toISOString() })
  await assert.rejects(acquireLock(lock, { waitMs: 200, cmd: CMD }), Busy)
  fs.rmSync(lock, { recursive: true })
  // a lock being created (no owner.json yet) is held for its grace period
  fs.mkdirSync(lock)
  await assert.rejects(acquireLock(lock, { waitMs: 200, cmd: CMD }), Busy)
  fs.rmSync(lock, { recursive: true })
})

void test('withLock lets go on a throw; releaseAllSync lets go of everything; a lock that changed hands is left alone', async () => {
  const dir = fresh('release')
  const a = path.join(dir, 'a.lock.d')
  await assert.rejects(withLock(a, { waitMs: null, cmd: CMD }, () => Promise.reject(new Error('boom'))), /boom/)
  assert.equal(fs.existsSync(a), false)
  const b = path.join(dir, 'b.lock.d')
  const c = path.join(dir, 'c.lock.d')
  await acquireLock(b, { waitMs: null, cmd: CMD })
  await acquireLock(c, { waitMs: null, cmd: CMD })
  releaseAllSync()
  assert.equal(fs.existsSync(b) || fs.existsSync(c), false)
  const me = await acquireLock(a, { waitMs: null, cmd: CMD })
  fs.writeFileSync(path.join(a, 'owner.json'), JSON.stringify({ pid: 1, host: 'h', cmd: 'x', started: 'y' }))
  await me.release()
  assert.equal(fs.existsSync(a), true)
  releaseAllSync()
  assert.equal(fs.existsSync(a), true)
  fs.rmSync(a, { recursive: true })
})

/** Runs the CLI on the Idol fixture and sends it `signal` once it has taken the library lock. */
async function interrupt(signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null; stderr: string; lib: string; tmp: string }> {
  const dir = fresh(`signal-${signal}`)
  const lib = path.join(dir, 'lib')
  const tmp = path.join(dir, 'tmp')
  fs.mkdirSync(tmp)
  const env: NodeJS.ProcessEnv = { ...process.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'), TMPDIR: tmp }
  delete env['FAL_KEY']
  const p = spawn(process.execPath, [path.join(REPO, 'pipeline/src/cli.ts'), path.join(REPO, 'fixtures/fal/speridlabs-idol/input.jpg'), '--name', 'Chair', '--dims', '80x90x95', '--library', lib], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  let sent = false
  p.stdout.on('data', (d: Buffer) => {
    // the engine line comes after the lock is taken and the staging folder made
    if (!sent && d.toString().includes('calling speridlabs/idol')) {
      sent = true
      p.kill(signal)
    }
  })
  const [code, sig] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => { p.on('exit', (c, s) => { resolve([c, s]) }) })
  assert.ok(sent, 'the CLI finished before it could be interrupted')
  return { code, signal: sig, stderr, lib, tmp }
}

void test('Ctrl-C: "midstudy-add: interrupted", exit 130, the lock and the staging folder gone', async () => {
  const r = await interrupt('SIGINT')
  assert.equal(r.code, 130)
  assert.equal(r.stderr, 'midstudy-add: interrupted\n')
  assert.equal(fs.existsSync(path.join(r.lib, '.lock.d')), false)
  assert.deepEqual(fs.readdirSync(r.tmp), [])
  assert.equal(fs.existsSync(path.join(r.lib, 'library.json')), false)
})

void test('SIGTERM: the process dies of the signal (as v1 did), the lock and the staging folder gone', async () => {
  const r = await interrupt('SIGTERM')
  assert.equal(r.signal, 'SIGTERM')
  assert.equal(fs.existsSync(path.join(r.lib, '.lock.d')), false)
  assert.deepEqual(fs.readdirSync(r.tmp), [])
})
