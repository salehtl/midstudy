// midstudy-add's paid branch end to end: a live (not mocked) run, with fal stood in by paid-standin.ts (no network, no
// key), SIGTERMed while its accepted queue job runs. onSignal aborts LiveFal, the catch keeps the engine outputs and
// writes the cost row with the real appendCost under the real costs lock, and the process dies of the signal, all
// inside the server's 5 s kill grace (server/src/main.ts: SIGTERM, then SIGKILL after 5 s).
//
//   nix develop -c node --test pipeline/test/paid.test.ts
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { acquireLock, costsLockDir } from '../../common/lock.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SCRATCH = path.join(REPO, 'evals/out/pipeline-paid-test')
const CLI = path.join(REPO, 'pipeline/src/cli.ts')
const STANDIN = path.join(REPO, 'pipeline/test/paid-standin.ts')
/** The server's kill grace for a tool it stops. */
const KILL_GRACE_MS = 5000

function fresh(name: string): string {
  const dir = path.join(SCRATCH, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

interface PaidRun {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
  readonly stdout: string
  readonly stderr: string
  readonly lib: string
  readonly tmp: string
  /** From the SIGTERM to the process's exit. */
  readonly unwindMs: number
}

interface Hooks {
  /** Runs before the CLI starts, with the library folder (made already). */
  readonly before?: (lib: string) => Promise<void>
  /** Runs right after the SIGTERM is sent. */
  readonly whenSent?: () => void
}

/** A paid Idol add (fal stood in), SIGTERMed once the queue job reports progress. */
async function paidRun(name: string, hooks: Hooks = {}): Promise<PaidRun> {
  const dir = fresh(name)
  const lib = path.join(dir, 'lib')
  const tmp = path.join(dir, 'tmp')
  fs.mkdirSync(tmp)
  fs.mkdirSync(lib)
  await hooks.before?.(lib)
  // not mocked, so the run is paid; no key and no .env; any real request would meet a dead proxy (the stand-in
  // answers every one LiveFal makes)
  const env: NodeJS.ProcessEnv = {
    ...process.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_STRICT: '1', TMPDIR: tmp,
    NODE_USE_ENV_PROXY: '1', HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
  }
  delete env['FAL_KEY']
  delete env['MIDSTUDY_FAL_MOCK']
  delete env['MIDSTUDY_FAL_MOCK_COST']
  const input = path.join(REPO, 'fixtures/fal/speridlabs-idol/input.jpg')
  const p = spawn(process.execPath, ['--import', STANDIN, CLI, input, '--name', 'Chair', '--dims', '80x90x95', '--library', lib], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  // when the signal went out (an object: the stdout handler sets it)
  const sent: { at: number | null } = { at: null }
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString() })
  p.stdout.on('data', (d: Buffer) => {
    stdout += d.toString()
    // the job's log line: the submit was accepted, so the call is billed
    if (sent.at === null && stdout.includes('  fal: stand-in: running')) {
      sent.at = Date.now()
      p.kill('SIGTERM')
      hooks.whenSent?.()
    }
  })
  const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve) => { p.on('exit', (c, s) => { resolve([c, s]) }) })
  const exitedAt = Date.now()
  const sentAt = sent.at
  assert.ok(sentAt !== null, `the CLI ended before its paid call could be interrupted:\n${stdout}\n${stderr}`)
  return { code, signal, stdout, stderr, lib, tmp, unwindMs: exitedAt - sentAt }
}

/** costs.csv's rows (header first). */
function costRows(lib: string): string[][] {
  const file = path.join(lib, 'costs.csv')
  assert.ok(fs.existsSync(file), 'no costs.csv: the paid call was not recorded')
  return fs.readFileSync(file, 'utf8').split('\n').filter((l) => l !== '').map((l) => l.split(','))
}

function assertRecorded(r: PaidRun): void {
  assert.equal(r.signal, 'SIGTERM', `exit ${String(r.code)}\n${r.stdout}\n${r.stderr}`)
  const rows = costRows(r.lib)
  assert.deepEqual(rows[0], ['date', 'id', 'engine', 'cost_usd', 'mock', 'input'])
  assert.equal(rows.length, 2, JSON.stringify(rows))
  const [date, id, engine, cost, mock, input] = rows[1] ?? []
  assert.match(date ?? '', /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  assert.deepEqual([id, engine, cost, mock, input], ['chair', 'idol', '0.1', 'false', 'input.jpg'])
  assert.match(r.stdout, /midstudy-add: \$0\.10 recorded in costs\.csv; engine outputs kept in .*\/_failed\/chair-\d{4}-\d\d-\d\dT\d{6}Z\/raw\n/)
  // the outputs moved out of staging for a free retry; nothing committed, nothing left behind, every lock let go
  const failed = fs.readdirSync(path.join(r.lib, '_failed'))
  assert.equal(failed.length, 1)
  assert.ok(fs.existsSync(path.join(r.lib, '_failed', failed[0] ?? '', 'raw', 'engine-input.jpg')))
  assert.equal(fs.existsSync(path.join(r.lib, 'chair')), false)
  assert.equal(fs.existsSync(path.join(r.lib, 'library.json')), false)
  assert.equal(fs.existsSync(path.join(r.lib, '.lock.d')), false)
  assert.equal(fs.existsSync(costsLockDir(path.join(r.lib, 'costs.csv'))), false)
  assert.deepEqual(fs.readdirSync(r.tmp), [])
}

void test('a paid run SIGTERMed mid-call records its cost, keeps its outputs and dies of the signal, well inside the 5 s grace', async (t) => {
  const r = await paidRun('sigterm')
  assertRecorded(r)
  t.diagnostic(`unwind: ${String(r.unwindMs)} ms`)
  assert.ok(r.unwindMs < KILL_GRACE_MS / 2, `the unwind took ${String(r.unwindMs)} ms`)
})

void test('a paid run SIGTERMed while another writer holds the costs lock waits for it, then records the cost inside the grace', async (t) => {
  const HOLD_MS = 1500
  // another writer (the server recording a render's cost, say) holds the costs lock, and lets go 1.5 s after the signal
  let held: Awaited<ReturnType<typeof acquireLock>> | null = null
  let released: Promise<void> = Promise.resolve()
  const r = await paidRun('sigterm-costs-locked', {
    before: async (lib) => { held = await acquireLock(costsLockDir(path.join(lib, 'costs.csv')), { waitMs: 1000, cmd: 'paid.test holder' }) },
    whenSent: () => {
      const lock = held
      released = new Promise<void>((resolve) => { setTimeout(resolve, HOLD_MS) }).then(() => lock?.release())
    },
  })
  await released
  assertRecorded(r)
  t.diagnostic(`unwind with the costs lock held ${String(HOLD_MS)} ms: ${String(r.unwindMs)} ms`)
  assert.ok(r.unwindMs >= HOLD_MS, `the unwind took ${String(r.unwindMs)} ms: it did not wait for the costs lock`)
  assert.ok(r.unwindMs < KILL_GRACE_MS, `the unwind took ${String(r.unwindMs)} ms`)
})
