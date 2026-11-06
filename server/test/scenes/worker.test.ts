// The calibration queue's worker client (contract §4.3 Worker, the server's side), in-process on SceneService with a
// fake midstudy-calib (fake-calib.ts) that misbehaves on demand, and once with the real `midstudy-calib serve` under
// MIDSTUDY_CALIB_MOCK. Each scenario counts process starts and requests in the fake's log.
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CalibRunner } from '../../src/scenes/calib.ts'
import { SceneService, publicCalib, type JobView } from '../../src/scenes/service.ts'
import { MAX_WORKER_FAILURES } from '../../src/scenes/logic/worker.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')
const SCRATCH = path.join(REPO, 'evals/out/server-scenes-tests/worker')
const FAKE = ['node', path.join(REPO, 'server/test/scenes/fake-calib.ts')]
const PHOTO = path.join(REPO, 'fixtures/scenes/living-wide/photo.jpg')

interface Rig {
  readonly scenes: SceneService
  readonly dir: string
  readonly log: string
  readonly lines: string[]
}

let count = 0

/** A SceneService on scratch folders with `n` scenes that have photo.jpg, calibrating with `calib`. */
function rig(n: number, mode: string, options: { readonly calib?: readonly string[]; readonly timeoutMs?: number; readonly idleMs?: number } = {}): Rig {
  count += 1
  const dir = path.join(SCRATCH, String(process.pid) + '-' + String(count))
  fs.rmSync(dir, { recursive: true, force: true })
  const scenesDir = path.join(dir, 'scenes')
  for (let i = 1; i <= n; i++) {
    const d = path.join(scenesDir, 'scene-20261105-12000' + String(i))
    fs.mkdirSync(d, { recursive: true })
    fs.copyFileSync(PHOTO, path.join(d, 'photo.jpg'))
    fs.writeFileSync(path.join(d, 'scene.json'), JSON.stringify({
      version: 1, title: null, created: '2026-11-05T12:00:0' + String(i) + 'Z', saved: null,
      camera: { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }, camera_source: 'default',
    }))
  }
  const log = path.join(dir, 'calls.jsonl')
  process.env['FAKE_CALIB_LOG'] = log
  process.env['FAKE_CALIB_SERVE'] = mode
  const lines: string[] = []
  const scenes = new SceneService({
    scenesDir, layoutsDir: path.join(dir, 'layouts'), calib: options.calib ?? FAKE, repo: REPO,
    log: (line) => { lines.push(line) }, timeoutMs: options.timeoutMs ?? 20_000, workerIdleMs: options.idleMs ?? 60_000, killGraceMs: 500,
  })
  return { scenes, dir, log, lines }
}

/** The fake's log: process starts (`argv`) and worker requests. */
function calls(r: Rig): { readonly starts: string[][]; readonly requests: unknown[]; readonly eofs: number; readonly mock: boolean[] } {
  const text = fs.existsSync(r.log) ? fs.readFileSync(r.log, 'utf8') : ''
  const entries: unknown[] = text.split('\n').filter((l) => l !== '').map((l): unknown => JSON.parse(l))
  const starts: string[][] = []
  const requests: unknown[] = []
  const mock: boolean[] = []
  let eofs = 0
  for (const e of entries) {
    if (typeof e !== 'object' || e === null) continue
    if ('argv' in e && Array.isArray(e.argv)) {
      starts.push(e.argv.map(String))
      mock.push('mock' in e && e.mock === true)
    }
    if ('request' in e) requests.push(e.request)
    if ('eof' in e) eofs += 1
  }
  return { starts, requests, eofs, mock }
}

const sceneName = (i: number): string => 'scene-20261105-12000' + String(i)

/** Calibrates scenes 1..n one after the other (each job waits for the previous: the queue is serial anyway). */
async function calibrateAll(r: Rig, n: number): Promise<JobView[]> {
  const jobs: JobView[] = []
  for (let i = 1; i <= n; i++) {
    const res = r.scenes.calibrate(sceneName(i))
    assert.ok('job' in res, 'calibrate ' + String(i) + ': ' + JSON.stringify(res))
    await r.scenes.drained()
    const job = r.scenes.getJob(res.job.id)
    assert.ok(job !== null)
    jobs.push(job)
  }
  return jobs
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

void test('a working worker: started on the first job, kept for the next ones, never at startup', async () => {
  const r = rig(3, 'ok')
  await sleep(200)
  assert.equal(calls(r).starts.length, 0, 'nothing runs before the first calibration')
  const jobs = await calibrateAll(r, 3)
  for (const j of jobs) {
    assert.equal(j.status, 'done', JSON.stringify(j))
    assert.equal(j.message, 'calibrated (moge-2)')
    assert.deepEqual(j.calib, publicCalib(r.scenes.calibJson(j.scene)))
  }
  const c = calls(r)
  assert.deepEqual(c.starts, [['serve']], 'one worker, no one-shot run')
  assert.equal(c.requests.length, 3)
  const first = c.requests[0]
  assert.ok(typeof first === 'object' && first !== null && 'id' in first && 'cmd' in first && 'args' in first)
  assert.equal(first.id, jobs[0]?.id, 'the job id is the request id')
  assert.equal(first.cmd, 'fit')
  assert.ok(Array.isArray(first.args) && first.args.length === 1 && path.isAbsolute(String(first.args[0])), 'fit <absolute scene dir>')
  // the camera of a `default` scene becomes the calibration's (§4.4)
  assert.deepEqual(r.scenes.read(sceneName(1))?.['camera'], { fov_y_deg: 61.5, height_m: 1.52, pitch_deg: -12.5, roll_deg: 1.25 })
  assert.equal(r.scenes.read(sceneName(1))?.['camera_source'], 'auto')
  await r.scenes.shutdown()
  await sleep(300)
  assert.equal(calls(r).eofs, 1, 'shutdown closes its stdin and it exits')
})

void test('the environment reaches the worker (MIDSTUDY_CALIB_MOCK) and the one-shot runs', async () => {
  process.env['MIDSTUDY_CALIB_MOCK'] = path.join(REPO, 'fixtures/calib')
  try {
    const r = rig(1, 'ok')
    await calibrateAll(r, 1)
    assert.deepEqual(calls(r).mock, [true])
    await r.scenes.shutdown()
  } finally {
    delete process.env['MIDSTUDY_CALIB_MOCK']
  }
})

void test('no `serve` (the stub exits 2 at once): each job runs one-shot; after 3 failures in a row no worker is started again', async () => {
  const r = rig(5, 'exit2')
  const jobs = await calibrateAll(r, 5)
  for (const j of jobs) assert.equal(j.status, 'done', JSON.stringify(j))
  const starts = calls(r).starts.map((a) => a[0])
  assert.deepEqual(starts, ['serve', 'fit', 'serve', 'fit', 'serve', 'fit', 'fit', 'fit'])
  assert.equal(MAX_WORKER_FAILURES, 3)
  assert.equal(r.lines.length, 3, r.lines.join('\n'))
  assert.match(r.lines[2] ?? '', /3 failures in a row: one-shot from now on/)
  assert.match(r.lines[0] ?? '', /it exited \(code 2\)/)
})

for (const [mode, why] of [['garbled', "isn't JSON"], ['wrong-id', "doesn't carry the request's id"], ['crash', 'exited (code 1)']] as const) {
  void test('a worker that ' + mode + 's is killed, that job runs one-shot, the next job starts a new worker', async () => {
    const r = rig(2, mode)
    const jobs = await calibrateAll(r, 2)
    for (const j of jobs) assert.equal(j.status, 'done', JSON.stringify(j))
    assert.deepEqual(calls(r).starts.map((a) => a[0]), ['serve', 'fit', 'serve', 'fit'])
    assert.ok(r.lines.every((l) => l.includes(why)), r.lines.join('\n'))
  })
}

void test('an `ok: false` answer is the job\'s failure (its sentence), not the worker\'s: the worker stays', async () => {
  const r = rig(4, 'fail')
  const jobs = await calibrateAll(r, 4)
  for (const j of jobs) {
    assert.equal(j.status, 'failed')
    assert.equal(j.message, 'the photo is unreadable')
  }
  assert.deepEqual(calls(r).starts, [['serve']])
  assert.equal(r.lines.length, 0)
  await r.scenes.shutdown()
})

void test('failures must be in a row: an answer starts the count again', async () => {
  const r = rig(6, 'second-crash')
  const jobs = await calibrateAll(r, 6)
  for (const j of jobs) assert.equal(j.status, 'done', JSON.stringify(j))
  // each worker answers once, then crashes on its next request (that job runs one-shot): never 3 failures in a row
  assert.deepEqual(calls(r).starts.map((a) => a[0]), ['serve', 'fit', 'serve', 'fit', 'serve', 'fit'])
  assert.equal(r.lines.length, 3)
  assert.ok(r.lines.every((l) => !l.includes('from now on')), r.lines.join('\n'))
  await r.scenes.shutdown()
})

void test('a request still running at the timeout fails the job with the timeout sentence; the worker is killed', async () => {
  const r = rig(2, 'hang', { timeoutMs: 1500 })
  const t0 = Date.now()
  const jobs = await calibrateAll(r, 2)
  const took = Date.now() - t0
  for (const j of jobs) {
    assert.equal(j.status, 'failed')
    assert.equal(j.message, 'the calibration ran for more than 0 minutes and was stopped')
  }
  assert.ok(took < 8000, 'two timeouts of 1.5 s and the kills took ' + String(took) + ' ms')
  assert.deepEqual(calls(r).starts, [['serve'], ['serve']], 'a new worker for the next job, no one-shot')
})

void test('shutdown while a request runs: the worker is closed, then killed; the job ends without a one-shot run', async () => {
  const r = rig(1, 'hang')
  const res = r.scenes.calibrate(sceneName(1))
  assert.ok('job' in res)
  for (let i = 0; i < 50 && calls(r).requests.length === 0; i++) await sleep(50)
  assert.equal(calls(r).requests.length, 1)
  const t0 = Date.now()
  await r.scenes.shutdown()
  await r.scenes.drained()
  assert.ok(Date.now() - t0 < 3000, 'closed, then killed after the grace period')
  const job = r.scenes.getJob(res.job.id)
  assert.equal(job?.status, 'failed')
  assert.equal(job.message, 'the server stopped')
  assert.deepEqual(calls(r).starts, [['serve']], 'no one-shot run that would outlive the server')
})

void test('an idle worker gets its stdin closed; the next calibration starts another', async () => {
  const r = rig(2, 'ok', { idleMs: 300 })
  await calibrateAll(r, 1)
  await sleep(1000)
  assert.equal(calls(r).eofs, 1, 'it exited after the idle time')
  await calibrateAll(r, 2)
  assert.deepEqual(calls(r).starts, [['serve'], ['serve']])
  await r.scenes.shutdown()
})

void test('a calibration tool that is not there: the worker cannot start, the one-shot says so as v1 did', async () => {
  const r = rig(1, 'ok', { calib: ['/nonexistent/midstudy-calib'] })
  const [job] = await calibrateAll(r, 1)
  assert.equal(job?.status, 'failed')
  assert.equal(job.message, "the calibration tool isn't installed here (/nonexistent/midstudy-calib not found): set --calib")
})

void test('light jobs go to the worker too and never touch scene.json', async () => {
  const r = rig(1, 'ok')
  const before = fs.readFileSync(path.join(r.dir, 'scenes', sceneName(1), 'scene.json'), 'utf8')
  const res = r.scenes.light(sceneName(1))
  assert.equal(res.status, 202)
  await r.scenes.drained()
  assert.ok('body' in res && 'job' in res.body)
  const job = r.scenes.getJob(res.body.job.id)
  assert.equal(job?.status, 'done')
  assert.equal(job.lighting, true)
  assert.equal(job.message, 'lighting inferred (4500 K)', 'Python rounds 4500.5 to even')
  assert.equal(fs.readFileSync(path.join(r.dir, 'scenes', sceneName(1), 'scene.json'), 'utf8'), before)
  assert.deepEqual(calls(r).starts, [['serve']])
  await r.scenes.shutdown()
})

const REAL = ['uv', 'run', '--project', path.join(REPO, 'calib'), 'midstudy-calib']
const realSkip = !fs.existsSync(path.join(REPO, 'calib/pyproject.toml')) && 'calib/ is missing'

void test('the real `midstudy-calib serve` (MIDSTUDY_CALIB_MOCK): the same calib.json and job as the one-shot command', { skip: realSkip, timeout: 300_000 }, async () => {
  process.env['MIDSTUDY_CALIB_MOCK'] = path.join(REPO, 'fixtures/calib')
  try {
    const viaWorker = rig(2, 'ok', { calib: REAL, timeoutMs: 240_000 })
    const viaOneShot = rig(2, 'ok', { calib: REAL, timeoutMs: 240_000 })
    const jobs = await calibrateAll(viaWorker, 2)
    assert.deepEqual(viaWorker.lines, [], 'the worker never failed')
    const oneShot = new CalibRunner({ calib: REAL, cwd: REPO, timeoutMs: 240_000, idleMs: 60_000, killGraceMs: 500, log: () => undefined })
    for (let i = 1; i <= 2; i++) {
      const job = jobs[i - 1]
      assert.equal(job?.status, 'done', JSON.stringify(job))
      assert.equal(job.message, 'calibrated (truth)')
      const out = await oneShot.oneShot({ id: 'c-test-' + String(i), cmd: 'fit', args: [path.join(viaOneShot.dir, 'scenes', sceneName(i))] })
      assert.equal(out.kind, 'result')
      const a = viaWorker.scenes.calibJson(sceneName(i))
      const b = viaOneShot.scenes.calibJson(sceneName(i))
      assert.ok(a !== null && b !== null)
      assert.deepEqual({ ...a, elapsed_s: 0 }, { ...b, elapsed_s: 0 }, 'calib.json')
      assert.deepEqual(job.calib, publicCalib(a))
    }
    await viaWorker.scenes.shutdown()
  } finally {
    delete process.env['MIDSTUDY_CALIB_MOCK']
  }
})
