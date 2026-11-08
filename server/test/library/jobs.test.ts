// The library's job queue at the server's stop: LibraryService.shutdown() ends the running midstudy-add (here a stand-in
// that holds the library lock as it does), the lock is free afterwards, the job says why it ended, and a job queued
// behind it never starts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { acquireLock, libraryLockDir } from '../../../common/lock.ts'
import type { ServerDeps } from '../../src/deps.ts'
import { LibraryService } from '../../src/library/service.ts'
import { SpendCap } from '../../src/spend.ts'
import { REPO } from '../helpers.ts'

const SCRATCH = path.join(REPO, 'evals/out/server-library-tests/jobs')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function rig(name: string): { readonly library: LibraryService; readonly dir: string; readonly spend: SpendCap } {
  const dir = path.join(SCRATCH, String(process.pid) + '-' + name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const costsFile = path.join(dir, 'costs.csv')
  fs.writeFileSync(costsFile, 'date,id,engine,cost_usd,mock,input\n')
  const spend = new SpendCap(costsFile, 2)
  const deps: ServerDeps = {
    config: {
      repo: REPO, host: '127.0.0.1', port: 0, scenesDir: dir, roomsDir: dir, layoutsDir: dir, rendersDir: dir, libraryDir: dir, costsFile,
      calib: ['false'], midstudyAdd: ['false'], dailySpendUsd: 2, allowedHosts: [], socketTimeoutSeconds: 30,
    },
    spend,
    onShutdown: () => undefined,
  }
  return { library: new LibraryService(deps), dir, spend }
}

/** The pid in owner.json once a process holds the library's lock. */
async function holder(dir: string): Promise<number> {
  const file = path.join(libraryLockDir(dir), 'owner.json')
  for (let i = 0; i < 600; i += 1) {
    if (fs.existsSync(file)) {
      const owner: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
      const pid: unknown = owner !== null && typeof owner === 'object' ? Reflect.get(owner, 'pid') : null
      if (typeof pid === 'number') return pid
    }
    await sleep(25)
  }
  throw new Error('nothing took the lock')
}

function writesMarker(marker: string): string[] {
  return [process.execPath, '-e', 'require("fs").writeFileSync(' + JSON.stringify(marker) + ', "x")']
}

void test('shutdown ends the running add, frees the lock, and the job queued behind it never starts', { timeout: 30000 }, async () => {
  const r = rig('stop')
  const marker = path.join(r.dir, 'second-started')
  const upload = path.join(r.dir, 'upload-of-second')
  fs.mkdirSync(upload)
  const first = r.library.newJob('add', 'chair', 'glb', 0.4, [process.execPath, path.join(REPO, 'server/test/library/hold-lock.ts'), r.dir], null, 0.4, 'queued')
  const second = r.library.newJob('add', 'lamp', 'glb', 0.4, writesMarker(marker), upload, 0.4, 'queued')
  assert.ok('job' in first && 'job' in second)
  const pid = await holder(r.dir)
  assert.ok(exists(pid))

  await r.library.shutdown()

  assert.equal(exists(pid), false, 'the child is gone once shutdown settles')
  const lock = await acquireLock(libraryLockDir(r.dir), { waitMs: 0, cmd: 'test' })
  await lock.release()
  assert.equal(fs.existsSync(marker), false, 'the queued job never started')
  assert.equal(fs.existsSync(upload), false, 'the queued job\'s upload folder is removed')
  for (const id of [first.job.id, second.job.id]) {
    const job = r.library.getJob(id)
    assert.equal(job?.status, 'failed')
    assert.equal(job.message, 'the server stopped')
  }
  assert.equal(r.spend.view().reserved_usd, 0)
})

void test('after shutdown a new job is not started either', { timeout: 15000 }, async () => {
  const r = rig('after')
  await r.library.shutdown()
  const marker = path.join(r.dir, 'late-started')
  const late = r.library.newJob('add', 'chair', 'glb', 0, writesMarker(marker), null, 0, 'queued')
  assert.ok('job' in late)
  await r.library.shutdown()
  assert.equal(r.library.getJob(late.job.id)?.status, 'failed')
  assert.equal(fs.existsSync(marker), false)
})
