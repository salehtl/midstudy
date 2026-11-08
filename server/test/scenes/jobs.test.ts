// A scene's calibration job against delete, restore and restarts (contract §4.2 .calibrating, §4.4 calib_status), the
// crash order of delete and restore, and queueTask's id check: in-process on SceneService with rooms-calib.ts one-shot
// (no ROOMS_CALIB_SERVE) and ROOMS_CALIB_DELAY_MS holding a job running. A "restart" is a fresh SceneService on the folders.
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SceneService, type RoomHooks } from '../../src/scenes/service.ts'
import { SCENE_DELETED } from '../../src/scenes/logic/jobs.ts'
import { LOST_CALIBRATION, LOST_UPLOAD } from '../../src/scenes/logic/status.ts'
import { isRecord } from '../../src/scenes/logic/values.ts'
import type { SceneTrashRoom } from '../../../contract/gen/types.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')
const SCRATCH = path.join(REPO, 'evals/out/server-scenes-tests/jobs')
const TOOL = ['node', path.join(REPO, 'server/test/rooms-calib.ts')]
const PHOTO = path.join(REPO, 'fixtures/scenes/living-wide/photo.jpg')
const MARKER = '.calibrating'
const A = 'scene-20261105-120001'
const B = 'scene-20261105-120002'

let count = 0

function scratch(): string {
  count += 1
  const dir = path.join(SCRATCH, String(process.pid) + '-' + String(count))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'scenes'), { recursive: true })
  return dir
}

function service(dir: string, calib: readonly string[] = TOOL): SceneService {
  return new SceneService({
    scenesDir: path.join(dir, 'scenes'), layoutsDir: path.join(dir, 'layouts'), calib, repo: REPO,
    log: () => undefined, timeoutMs: 20_000, workerIdleMs: 60_000, killGraceMs: 500,
  })
}

/** A scene folder holding `files`: 'photo' is photo.jpg, 'source' source.jpg, 'calib' a calib.json. */
function scene(dir: string, name: string, files: readonly ('photo' | 'source' | 'calib')[]): string {
  const d = path.join(dir, 'scenes', name)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(path.join(d, 'scene.json'), JSON.stringify({
    version: 1, title: null, created: '2026-11-05T12:00:01Z', saved: null,
    camera: { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }, camera_source: 'default',
  }))
  if (files.includes('photo')) fs.copyFileSync(PHOTO, path.join(d, 'photo.jpg'))
  if (files.includes('source')) fs.copyFileSync(PHOTO, path.join(d, 'source.jpg'))
  if (files.includes('calib')) fs.writeFileSync(path.join(d, 'calib.json'), JSON.stringify({ version: 1, source: 'moge-2' }))
  return d
}

function hold(ms: number): void {
  process.env['ROOMS_CALIB_DELAY_MS'] = String(ms)
}

function jobIdOf(r: ReturnType<SceneService['calibrate']>): string {
  assert.ok('job' in r, 'the calibration was queued')
  return r.job.id
}

function statusOf(s: SceneService, name: string): { readonly status: unknown; readonly error: unknown } {
  const o = s.sceneObject(name)
  assert.ok(o !== null, name + ' exists')
  return { status: o.calib_status, error: o.calib_error }
}

function roomIn(file: string): unknown {
  const meta: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
  return isRecord(meta) ? meta['room'] : undefined
}

async function until(what: string, ok: () => boolean): Promise<void> {
  const end = Date.now() + 15_000
  while (!ok()) {
    assert.ok(Date.now() < end, 'timed out waiting for ' + what)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

void test('restore answers exists until a running dropped job has ended, then reads from the files', async () => {
  const dir = scratch()
  scene(dir, A, ['source'])
  hold(1200)
  const s = service(dir)
  const id = jobIdOf(s.calibrate(A))
  assert.ok(s.delete(A) !== null)
  assert.equal(s.restore(A), 'exists')
  await s.drained()
  assert.equal(s.getJob(id)?.message, SCENE_DELETED)
  const back = s.restore(A)
  assert.ok(typeof back === 'object', 'restored once the job ended')
  // its tool may have half-written the folder before the move, so its marker came back with it
  assert.deepEqual(statusOf(s, A), { status: 'failed', error: LOST_CALIBRATION })
  await s.shutdown()
})

void test('a queued fit dropped by delete: restore reads done from calib.json and no marker came back', async () => {
  const dir = scratch()
  scene(dir, A, ['photo'])
  scene(dir, B, ['photo', 'calib'])
  hold(800)
  const s = service(dir)
  jobIdOf(s.calibrate(A))
  jobIdOf(s.calibrate(B))
  assert.ok(fs.existsSync(path.join(dir, 'scenes', B, MARKER)), 'marker written when queued')
  assert.ok(s.delete(B) !== null)
  assert.ok(typeof s.restore(B) === 'object')
  assert.equal(fs.existsSync(path.join(dir, 'scenes', B, MARKER)), false)
  assert.deepEqual(statusOf(s, B), { status: 'done', error: null })
  await s.drained()
  assert.deepEqual(statusOf(s, B), { status: 'done', error: null })
  await s.shutdown()
})

void test('after a restart: a marker reads LOST_CALIBRATION even with calib.json', () => {
  const dir = scratch()
  const d = scene(dir, A, ['photo', 'calib'])
  assert.deepEqual(statusOf(service(dir), A), { status: 'done', error: null })
  fs.writeFileSync(path.join(d, MARKER), 'c-old')
  assert.deepEqual(statusOf(service(dir), A), { status: 'failed', error: LOST_CALIBRATION })
})

void test('after a restart: no photo and no source reads LOST_UPLOAD, marker or not; a source alone stays recoverable', () => {
  const dir = scratch()
  const d = scene(dir, A, [])
  assert.deepEqual(statusOf(service(dir), A), { status: 'failed', error: LOST_UPLOAD })
  fs.writeFileSync(path.join(d, MARKER), 'c-old')
  assert.deepEqual(statusOf(service(dir), A), { status: 'failed', error: LOST_UPLOAD })
  scene(dir, B, ['source'])
  assert.deepEqual(statusOf(service(dir), B), { status: 'failed', error: LOST_CALIBRATION })
})

void test('spawn-error on a dropped job says the scene was deleted', async () => {
  const dir = scratch()
  const tool = path.join(dir, 'not-executable')
  fs.writeFileSync(tool, 'not a program\n', { mode: 0o644 })
  scene(dir, A, ['photo'])
  const s = service(dir, [tool])
  const id = jobIdOf(s.calibrate(A))
  assert.equal(s.getJob(id)?.status, 'running')
  assert.ok(s.delete(A) !== null)
  await s.drained()
  assert.equal(s.getJob(id)?.message, SCENE_DELETED)
  await s.shutdown()
})

void test('a job stopped by shutdown keeps its marker: the next server run reads LOST_CALIBRATION', async () => {
  const dir = scratch()
  const d = scene(dir, A, ['photo', 'calib'])
  const log = path.join(dir, 'tool.jsonl')
  process.env['ROOMS_CALIB_LOG'] = log
  hold(15_000)
  const s = service(dir)
  const id = jobIdOf(s.calibrate(A))
  await until('the one-shot fit to start', () => fs.existsSync(log) && fs.readFileSync(log, 'utf8').includes('"fit"'))
  await s.shutdown()
  await s.drained()
  delete process.env['ROOMS_CALIB_LOG']
  assert.equal(s.getJob(id)?.message, 'the server stopped')
  assert.equal(fs.readFileSync(path.join(d, MARKER), 'utf8'), id)
  assert.deepEqual(statusOf(service(dir), A), { status: 'failed', error: LOST_CALIBRATION })
})

void test("the marker goes when its own job ends, and stays when it is another job's", async () => {
  const dir = scratch()
  const a = scene(dir, A, ['photo'])
  const b = scene(dir, B, ['photo'])
  hold(0)
  const s = service(dir)
  const id = jobIdOf(s.calibrate(A))
  assert.equal(fs.readFileSync(path.join(a, MARKER), 'utf8'), id)
  await s.drained()
  assert.equal(fs.existsSync(path.join(a, MARKER)), false)
  assert.equal(statusOf(s, A).status, 'done')
  jobIdOf(s.calibrate(B))
  fs.writeFileSync(path.join(b, MARKER), 'c-another')
  await s.drained()
  assert.equal(fs.readFileSync(path.join(b, MARKER), 'utf8'), 'c-another')
  await s.shutdown()
})

const ROOM: SceneTrashRoom = { name: 'room-1', index: 0, member: { scene: A, pose: null, scale: 1, pose_source: 'unplaced' } }

function rooms(rejoin: RoomHooks['rejoin']): RoomHooks {
  return { index: () => new Map(), leave: () => ROOM, rejoin }
}

void test('restore removes trash.json last: a failed rejoin leaves the room record on disk', () => {
  const dir = scratch()
  const d = scene(dir, A, ['photo', 'calib'])
  const s = service(dir)
  s.setRooms(rooms(() => {
    throw new Error('rejoin failed')
  }))
  assert.ok(s.delete(A) !== null)
  assert.throws(() => s.restore(A), /rejoin failed/)
  assert.deepEqual(roomIn(path.join(d, 'trash.json')), ROOM)
})

void test('delete writes trash.json before the moves: unmovable layouts leave the record in the trash copy', () => {
  const dir = scratch()
  scene(dir, A, ['photo', 'calib'])
  const layouts = path.join(dir, 'layouts')
  fs.mkdirSync(path.join(layouts, A), { recursive: true })
  const s = service(dir)
  s.setRooms(rooms(() => undefined))
  fs.chmodSync(layouts, 0o500)
  try {
    assert.throws(() => s.delete(A))
  } finally {
    fs.chmodSync(layouts, 0o700)
  }
  const listed = s.trash().find((t) => t.name === A)
  assert.ok(listed !== undefined, 'the trash lists it')
  assert.deepEqual(roomIn(path.join(dir, 'scenes/.trash', listed.dir, 'trash.json')), ROOM)
})

void test('queueTask refuses an id already queued', async () => {
  const dir = scratch()
  const s = service(dir)
  let release = (): void => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const task = {
    run: async (): Promise<boolean> => {
      await gate
      return true
    },
    failed: () => undefined,
  }
  s.queueTask('a-1', task)
  assert.throws(() => {
    s.queueTask('a-1', task)
  }, /a-1/)
  release()
  await s.drained()
  await s.shutdown()
})
