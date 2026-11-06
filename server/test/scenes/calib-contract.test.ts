// Strict mode on the calibration queue (MIDSTUDY_STRICT=1, as the harness runs the v2 server): every midstudy-calib
// result line and worker answer is checked against contract/calib-cli.schema.json. A result that breaks it fails its
// job with `contract violation: …`, through the worker (which stays: it answered) and one-shot alike; a conforming
// one goes through untouched. The fake midstudy-calib is server/test/scenes/fake-calib.ts.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { before, test } from 'node:test'
import { SceneService } from '../../src/scenes/service.ts'
import { enableStrict } from '../../src/strict.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')
const SCRATCH = path.join(REPO, 'evals/out/server-scenes-tests/calib-contract')
const FAKE = ['node', path.join(REPO, 'server/test/scenes/fake-calib.ts')]
const PHOTO = path.join(REPO, 'fixtures/scenes/living-wide/photo.jpg')
const SCENE = 'scene-20261105-120001'

before(async () => {
  await enableStrict()
})

let count = 0

/** A SceneService with one scene that has photo.jpg; the fake's worker behaves as `serve`, its results as `offContract`. */
async function calibrateOnce(serve: string, offContract: boolean): Promise<{ readonly status: string; readonly message: string; readonly log: string[] }> {
  count += 1
  const dir = path.join(SCRATCH, String(process.pid) + '-' + String(count))
  fs.rmSync(dir, { recursive: true, force: true })
  const d = path.join(dir, 'scenes', SCENE)
  fs.mkdirSync(d, { recursive: true })
  fs.copyFileSync(PHOTO, path.join(d, 'photo.jpg'))
  fs.writeFileSync(path.join(d, 'scene.json'), JSON.stringify({
    version: 1, title: null, created: '2026-11-05T12:00:01Z', saved: null,
    camera: { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }, camera_source: 'default',
  }))
  process.env['FAKE_CALIB_LOG'] = path.join(dir, 'calls.jsonl')
  process.env['FAKE_CALIB_SERVE'] = serve
  if (offContract) process.env['FAKE_CALIB_OFF_CONTRACT'] = '1'
  else delete process.env['FAKE_CALIB_OFF_CONTRACT']
  const log: string[] = []
  const scenes = new SceneService({
    scenesDir: path.join(dir, 'scenes'), layoutsDir: path.join(dir, 'layouts'), calib: FAKE, repo: REPO,
    log: (line) => { log.push(line) }, timeoutMs: 20_000, workerIdleMs: 60_000, killGraceMs: 500,
  })
  try {
    const res = scenes.calibrate(SCENE)
    assert.ok('job' in res, JSON.stringify(res))
    await scenes.drained()
    const job = scenes.getJob(res.job.id)
    assert.ok(job !== null)
    return { status: job.status, message: job.message, log }
  } finally {
    await scenes.shutdown()
  }
}

void test('a conforming result passes, through the worker and one-shot', async () => {
  for (const serve of ['ok', 'exit2']) {
    const r = await calibrateOnce(serve, false)
    assert.equal(r.status, 'done', serve + ': ' + r.message)
  }
})

void test('a worker answer that breaks calib-cli.schema.json fails its job with the violation; the worker is not blamed', async () => {
  const r = await calibrateOnce('ok', true)
  assert.equal(r.status, 'failed')
  assert.match(r.message, /^contract violation: midstudy\/calib-cli\.schema\.json#\/\$defs\/run \/ \(must have required property 'camera'\)$/)
  assert.deepEqual(r.log, [], 'no worker failure was logged')
})

void test('a one-shot result line that breaks it fails the same way', async () => {
  const r = await calibrateOnce('exit2', true)
  assert.equal(r.status, 'failed')
  assert.match(r.message, /^contract violation: midstudy\/calib-cli\.schema\.json#\/\$defs\/run /)
})
