// The rooms API (contract §4.9) on the real server in strict mode (every answer and every file it writes checked
// against the schemas), with the calibration stand-in server/test/rooms-calib.ts (the §4.9 mock for align-room, the
// stub for the rest) and the golden room's photos (fixtures/scenes/living-wide, room-1, room-2; their mock answers in
// fixtures/calib/rooms/). Every route and every refusal, the align job (waiting, anchor, manual poses, stale photos,
// failures, the worker), trash and restore, scene deletion inside a room, room layouts and renders.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { RoomService } from '../src/rooms/service.ts'
import { SceneService } from '../src/scenes/service.ts'
import { REPO, api, errorOf, request, startServer, type Answer, type Running } from './helpers.ts'

const CALIB = 'node server/test/rooms-calib.ts'
const PHOTO = (scene: string): Buffer => fs.readFileSync(path.join(REPO, 'fixtures/scenes', scene, 'photo.jpg'))
/** room-1's true pose in living-wide's frame (fixtures/scenes/room-1/truth.json pose_in_room). */
const ROOM1 = { x_m: -1.15, z_m: 0.45, yaw_deg: -22 }

type Rec = Record<string, unknown>
function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}
function rec(v: unknown): Rec {
  assert.ok(isRec(v), 'not an object: ' + JSON.stringify(v))
  return v
}
function list(v: unknown): unknown[] {
  assert.ok(Array.isArray(v), 'not a list: ' + JSON.stringify(v))
  return v
}
function str(v: unknown): string {
  assert.equal(typeof v, 'string')
  return String(v)
}
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function server(name: string, env: Readonly<Record<string, string>> = {}): Promise<Running> {
  return startServer({ name: 'rooms-' + name, args: ['--calib', CALIB], env: { MIDSTUDY_STRICT: '1', MIDSTUDY_CALIB_MOCK: 'fixtures/calib', ...env } })
}

/** POST /api/scenes with a golden photo; the new scene's name. */
async function upload(s: Running, golden: string): Promise<string> {
  const a = await request(s.base, 'POST', '/api/scenes', { headers: { 'X-Midstudy': '1', 'X-Midstudy-Filename': golden + '.jpg' }, body: PHOTO(golden) })
  assert.equal(a.status, 202, a.text)
  return str(rec(a.json)['scene'])
}

async function until<T>(what: string, get: () => Promise<T | null>, ms = 30000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await get()
    if (v !== null) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await sleep(50)
  }
}

async function calibrated(s: Running, scene: string): Promise<void> {
  await until('scene ' + scene, async () => {
    const st = rec((await api(s.base, 'GET', '/api/scenes/' + scene)).json)['calib_status']
    return st === 'done' || st === 'failed' ? true : null
  })
}

async function scenesOf(s: Running, goldens: readonly string[]): Promise<string[]> {
  const names: string[] = []
  for (const g of goldens) names.push(await upload(s, g))
  for (const n of names) await calibrated(s, n)
  return names
}

async function job(s: Running, id: string): Promise<Rec> {
  return until('align job ' + id, async () => {
    const j = rec((await api(s.base, 'GET', '/api/rooms/jobs/' + id)).json)
    return j['status'] === 'done' || j['status'] === 'failed' ? j : null
  })
}

async function room(s: Running, name: string): Promise<Rec> {
  const a = await api(s.base, 'GET', '/api/rooms/' + name)
  assert.equal(a.status, 200, a.text)
  return rec(a.json)
}

function members(r: Rec): Rec[] {
  return list(r['members']).map(rec)
}

function nearPose(p: unknown, want: { x_m: number; z_m: number; yaw_deg: number }, eps = 1e-4): void {
  const q = rec(p)
  assert.ok(Math.abs(Number(q['x_m']) - want.x_m) < eps && Math.abs(Number(q['z_m']) - want.z_m) < eps && Math.abs(Number(q['yaw_deg']) - want.yaw_deg) < eps,
    JSON.stringify(q) + ' ≠ ' + JSON.stringify(want))
}

function refused(a: Answer, status: number): void {
  assert.equal(a.status, status, a.text)
  assert.ok(errorOf(a) !== '', a.text)
}

async function create(s: Running, body: unknown): Promise<Rec> {
  const a = await api(s.base, 'POST', '/api/rooms', body)
  assert.equal(a.status, 201, a.text)
  return rec(a.json)
}

/** The server's log has no contract violation (strict mode reports each one there). */
function noViolations(s: Running): void {
  assert.ok(!s.log().includes('contract violation'), s.log())
}

void describe('rooms API', () => {
  let s: Running
  let A: string
  let B: string
  let C: string
  before(async () => {
    s = await server('api')
    ;[A = '', B = '', C = ''] = await scenesOf(s, ['living-wide', 'room-1', 'room-2'])
  })
  after(async () => {
    await s.stop()
  })

  void test('POST /api/rooms: refusals, then a room with the first photo as the origin', async () => {
    assert.deepEqual((await api(s.base, 'GET', '/api/rooms')).json, { rooms: [], trash: [] })
    assert.equal(rec((await api(s.base, 'GET', '/api/scenes/' + A)).json)['room'], null)
    for (const bad of [[], 'x', {}, { scenes: [] }, { scenes: [A, A] }, { scenes: ['NOT A SLUG'] }, { scenes: [A], extra: 1 }, { scenes: [A], title: 'x'.repeat(201) },
      { scenes: Array.from({ length: 33 }, (_, i) => 'scene-' + String(i)) }]) {
      refused(await api(s.base, 'POST', '/api/rooms', bad), 400)
    }
    refused(await api(s.base, 'POST', '/api/rooms', { scenes: [A, 'scene-20000101-000000'] }), 404)
    refused(await request(s.base, 'POST', '/api/rooms', { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scenes: [A] }) }), 403)
    const r = await create(s, { title: '  Lounge  ', scenes: [A, B] })
    assert.equal(r['title'], 'Lounge')
    assert.equal(r['version'], 1)
    assert.equal(r['saved'], null)
    assert.equal(r['aligned'], null)
    assert.equal(r['align'], null)
    assert.equal(r['align_status'], 'none')
    assert.equal(r['align_error'], null)
    assert.equal(r['layouts'], 0)
    assert.match(str(r['name']), /^room-\d{8}-\d{6}(-\d+)?$/)
    const [m0, m1] = members(r)
    assert.ok(m0 !== undefined && m1 !== undefined)
    assert.deepEqual({ ...m0, scene_object: undefined, camera: undefined, effective_camera: undefined }, { scene: A, pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1, pose_source: 'origin', scene_object: undefined, camera: undefined, effective_camera: undefined })
    assert.equal(m1['pose'], null)
    assert.equal(m1['pose_source'], 'unplaced')
    assert.deepEqual(m0['camera'], m0['effective_camera'])
    assert.equal(rec(m0['scene_object'])['room'], r['name'])
    refused(await api(s.base, 'POST', '/api/rooms', { scenes: [C, B] }), 409)
    const listed = rec((await api(s.base, 'GET', '/api/rooms')).json)
    assert.deepEqual(list(listed['rooms']).map((x) => rec(x)['name']), [r['name']])
    const scenes = list(rec((await api(s.base, 'GET', '/api/scenes')).json)['scenes']).map(rec)
    assert.deepEqual(Object.fromEntries(scenes.map((x) => [x['name'], x['room']])), { [A]: r['name'], [B]: r['name'], [C]: null })
    // A room never shows up as a static file.
    assert.equal((await request(s.base, 'GET', '/rooms/' + str(r['name']) + '/room.json')).status, 404)
    noViolations(s)
  })

  void test('GET, PUT: title, members (join, leave, reorder, poses, scales, clamps), rescale, reset, and every refusal', async () => {
    const r = await create(s, { scenes: [C] })
    const name = str(r['name'])
    const other = str(rec(list(rec((await api(s.base, 'GET', '/api/rooms')).json)['rooms']).map(rec).find((x) => x['name'] !== name))['name'])
    refused(await api(s.base, 'GET', '/api/rooms/room-20000101-000000'), 404)
    refused(await api(s.base, 'GET', '/api/rooms/NOT%20A%20SLUG'), 404)
    assert.deepEqual(rec((await api(s.base, 'GET', '/api/rooms/jobs')).json), { jobs: [] })
    for (const bad of [{}, { other: 1 }, { title: 5 }, { rescale: 0 }, { reset: [] }, { members: [{ scene: C }, { scene: C }] }, { members: [{ scene: C, pose: { x_m: 1 } }] }, [], 'x']) {
      refused(await api(s.base, 'PUT', '/api/rooms/' + name, bad), 400)
    }
    refused(await api(s.base, 'PUT', '/api/rooms/room-20000101-000000', { title: 'x' }), 404)
    refused(await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: C }, { scene: 'scene-20000101-000000' }] }), 404)
    refused(await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: C }, { scene: A }] }), 409)
    refused(await api(s.base, 'PUT', '/api/rooms/' + name, { reset: [C] }), 409) // never aligned
    refused(await api(s.base, 'PUT', '/api/rooms/' + name, { reset: [A] }), 400) // not a member
    // A title alone doesn't stamp saved.
    let d = rec((await api(s.base, 'PUT', '/api/rooms/' + name, { title: ' Den ' })).json)
    assert.equal(d['title'], 'Den')
    assert.equal(d['saved'], null)
    // Take B from the other room, then add it here with a pose (manual), clamped; scale clamped.
    const o = await room(s, other)
    d = rec((await api(s.base, 'PUT', '/api/rooms/' + other, { members: members(o).filter((x) => x['scene'] !== B).map((x) => ({ scene: x['scene'] })) })).json)
    assert.deepEqual(members(d).map((x) => x['scene']), [A])
    assert.equal(rec((await api(s.base, 'GET', '/api/scenes/' + B)).json)['room'], null)
    d = rec((await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: B, pose: { x_m: 99, z_m: -1, yaw_deg: 190 }, scale: 10 }, { scene: C }] })).json)
    assert.notEqual(d['saved'], null)
    const [b, c] = members(d)
    assert.deepEqual({ scene: b?.['scene'], pose: b?.['pose'], scale: b?.['scale'], source: b?.['pose_source'] }, { scene: B, pose: { x_m: 50, z_m: -1, yaw_deg: -170 }, scale: 4, source: 'manual' })
    assert.equal(c?.['pose_source'], 'origin') // reordering never moves the frame
    assert.equal(rec(b?.['effective_camera'])['height_m'], Math.min(3, Number(rec(b?.['camera'])['height_m']) * 4))
    // The same pose sent back is no change; a scale alone leaves pose_source.
    d = rec((await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: B, pose: { x_m: 50, z_m: -1, yaw_deg: -170 }, scale: 0.5 }, { scene: C, scale: 2 }] })).json)
    assert.deepEqual(members(d).map((x) => [x['pose_source'], x['scale']]), [['manual', 0.5], ['origin', 2]])
    // Set scale: every scale and position times k, pose_source unchanged.
    d = rec((await api(s.base, 'PUT', '/api/rooms/' + name, { rescale: 2 })).json)
    assert.deepEqual(members(d).map((x) => [x['pose'], x['scale'], x['pose_source']]), [[{ x_m: 50, z_m: -2, yaw_deg: -170 }, 1, 'manual'], [{ x_m: 0, z_m: 0, yaw_deg: 0 }, 4, 'origin']])
    // pose null: unplaced.
    d = rec((await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: B, pose: null }, { scene: C }] })).json)
    assert.deepEqual(members(d).map((x) => x['pose_source']), ['unplaced', 'origin'])
    // Leaving every member: the room stays, empty.
    d = rec((await api(s.base, 'PUT', '/api/rooms/' + name, { members: [] })).json)
    assert.deepEqual(d['members'], [])
    assert.equal((await api(s.base, 'GET', '/api/rooms/' + name)).status, 200)
    // Put things back for the next tests: `other` holds A and B again, `name` holds C.
    await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: C }] })
    d = rec((await api(s.base, 'PUT', '/api/rooms/' + other, { members: [{ scene: A }, { scene: B }] })).json)
    assert.deepEqual(members(d).map((x) => x['pose_source']), ['origin', 'unplaced'])
    noViolations(s)
  })

  void test('align: a job on the calibration queue places room-1 where truth says; manual kept; reset; stale photos', async () => {
    const listed = list(rec((await api(s.base, 'GET', '/api/rooms')).json)['rooms']).map(rec)
    const name = str(listed.find((x) => members(x).some((m) => m['scene'] === A))?.['name'])
    refused(await api(s.base, 'POST', '/api/rooms/room-20000101-000000/align'), 404)
    refused(await api(s.base, 'POST', '/api/rooms/' + name + '/align', { solver: 'Not A Slug' }), 400)
    refused(await api(s.base, 'POST', '/api/rooms/' + name + '/align', { other: 1 }), 400)
    const solo = str(listed.find((x) => x['name'] !== name)?.['name'])
    refused(await api(s.base, 'POST', '/api/rooms/' + solo + '/align'), 409) // one photo
    const a = await api(s.base, 'POST', '/api/rooms/' + name + '/align')
    assert.equal(a.status, 202, a.text)
    const j0 = rec(rec(a.json)['job'])
    assert.match(str(j0['id']), /^a-\d{8}-\d{6}-[0-9a-f]{4}$/)
    assert.equal(j0['kind'], 'align')
    assert.equal(j0['room'], name)
    const j = await job(s, str(j0['id']))
    assert.equal(j['status'], 'done', JSON.stringify(j))
    assert.equal(rec(j['align'])['solver'], 'truth')
    assert.deepEqual(j['waiting_for'], [])
    // Not a calibration job.
    assert.ok(!list(rec((await api(s.base, 'GET', '/api/scenes/jobs')).json)['jobs']).some((x) => rec(x)['id'] === j0['id']))
    assert.deepEqual(list(rec((await api(s.base, 'GET', '/api/rooms/jobs')).json)['jobs']).map((x) => rec(x)['id']), [j0['id']])
    refused(await api(s.base, 'GET', '/api/rooms/jobs/a-nope'), 404)
    let d = await room(s, name)
    assert.equal(d['align_status'], 'done')
    assert.equal(rec(d['aligned'])['solver'], 'truth')
    assert.notEqual(d['saved'], null)
    assert.deepEqual(d['align'], JSON.parse(fs.readFileSync(path.join(s.rooms, name, 'align.json'), 'utf8')))
    const [ma, mb] = members(d)
    assert.ok(ma !== undefined && mb !== undefined)
    assert.equal(ma['pose_source'], 'origin')
    assert.equal(mb['pose_source'], 'solver')
    nearPose(mb['pose'], ROOM1)
    // A manual pose survives a new alignment, unless overwrite_manual.
    await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: A }, { scene: B, pose: { x_m: 1, z_m: 1, yaw_deg: 1 } }] })
    await job(s, str(rec(rec((await api(s.base, 'POST', '/api/rooms/' + name + '/align')).json)['job'])['id']))
    d = await room(s, name)
    assert.deepEqual(members(d)[1]?.['pose'], { x_m: 1, z_m: 1, yaw_deg: 1 })
    assert.equal(members(d)[1]?.['pose_source'], 'manual')
    // Reset puts it back to the answer.
    d = rec((await api(s.base, 'PUT', '/api/rooms/' + name, { reset: [B] })).json)
    assert.equal(members(d)[1]?.['pose_source'], 'solver')
    nearPose(members(d)[1]?.['pose'], ROOM1)
    await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: A }, { scene: B, pose: { x_m: 1, z_m: 1, yaw_deg: 1 } }] })
    await job(s, str(rec(rec((await api(s.base, 'POST', '/api/rooms/' + name + '/align', { overwrite_manual: true })).json)['job'])['id']))
    d = await room(s, name)
    assert.equal(members(d)[1]?.['pose_source'], 'solver')
    nearPose(members(d)[1]?.['pose'], ROOM1)
    // An answer for a photo since replaced is ignored: Reset makes it unplaced.
    const photo = path.join(s.scenes, B, 'photo.jpg')
    const bytes = fs.readFileSync(photo)
    fs.writeFileSync(photo, Buffer.concat([bytes, Buffer.from([0])]))
    try {
      d = rec((await api(s.base, 'PUT', '/api/rooms/' + name, { reset: [B, A] })).json)
      assert.deepEqual(members(d).map((x) => x['pose_source']), ['origin', 'unplaced'])
    } finally {
      fs.writeFileSync(photo, bytes)
    }
    noViolations(s)
  })

  void test('the anchor: the answer is composed with the origin member’s pose when it isn’t the first photo given', async () => {
    const name = str(list(rec((await api(s.base, 'GET', '/api/rooms')).json)['rooms']).map(rec).find((x) => members(x).some((m) => m['scene'] === C))?.['name'])
    // The golden pair's mock answer is for living-wide and room-1 (A and B): free them from their room first.
    const listed = list(rec((await api(s.base, 'GET', '/api/rooms')).json)['rooms']).map(rec)
    const pair = str(listed.find((x) => members(x).some((m) => m['scene'] === A))?.['name'])
    await api(s.base, 'PUT', '/api/rooms/' + pair, { members: [] })
    // room-1 is the origin, placed at its own frame; living-wide must land at room-1's inverse pose.
    await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: B }, { scene: A }] })
    const d0 = await room(s, name)
    assert.deepEqual(members(d0).map((x) => x['pose_source']), ['unplaced', 'unplaced']) // C left; B and A joined
    await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: B, pose: { x_m: 0, z_m: 0, yaw_deg: 0 } }, { scene: A }] })
    const j = await job(s, str(rec(rec((await api(s.base, 'POST', '/api/rooms/' + name + '/align')).json)['job'])['id']))
    assert.equal(j['status'], 'done', JSON.stringify(j))
    const al = rec(j['align'])
    assert.equal(rec(list(al['members'])[0])['scene'], B) // the anchor goes first
    const t = (-ROOM1.yaw_deg * Math.PI) / 180 // Ry(−yaw) · (0 − p)
    const want = { x_m: Math.cos(t) * -ROOM1.x_m + Math.sin(t) * -ROOM1.z_m, z_m: -Math.sin(t) * -ROOM1.x_m + Math.cos(t) * -ROOM1.z_m, yaw_deg: -ROOM1.yaw_deg }
    const d = await room(s, name)
    nearPose(members(d)[1]?.['pose'], want)
    assert.equal(members(d)[0]?.['pose_source'], 'manual')
    // Restore the earlier arrangement.
    await api(s.base, 'PUT', '/api/rooms/' + name, { members: [{ scene: C }] })
    await api(s.base, 'PUT', '/api/rooms/' + pair, { members: [{ scene: A }, { scene: B }] })
    noViolations(s)
  })

  void test('room layouts: ?room=, exactly one of scene and room, their own folder and trash', async () => {
    const listed = list(rec((await api(s.base, 'GET', '/api/rooms')).json)['rooms']).map(rec)
    const name = str(listed.find((x) => members(x).some((m) => m['scene'] === A))?.['name'])
    const layout = { items: [{ uid: 'sofa-1', id: 'sofa', render: 'glb', position: [1, 0, -2], rotation_y_deg: 30 }], scene_name: A, title: 'Plan A' }
    refused(await api(s.base, 'PUT', '/api/layouts/plan?room=' + name + '&scene=' + A, layout), 400)
    refused(await api(s.base, 'GET', '/api/layouts'), 400)
    refused(await api(s.base, 'GET', '/api/layouts?room=NOT%20A%20SLUG'), 400)
    refused(await api(s.base, 'GET', '/api/layouts?room=room-20000101-000000'), 404)
    refused(await api(s.base, 'PUT', '/api/layouts/Bad%20Name?room=' + name, layout), 400)
    const put = await api(s.base, 'PUT', '/api/layouts/plan?room=' + name, layout)
    assert.equal(put.status, 200, put.text)
    const stored = rec(put.json)
    assert.equal(stored['room_name'], name)
    assert.ok(!('scene_name' in stored))
    assert.ok(fs.existsSync(path.join(s.layouts, '@' + name, 'plan.json')))
    assert.deepEqual(rec((await api(s.base, 'GET', '/api/layouts/plan?room=' + name)).json), stored)
    assert.deepEqual(rec((await api(s.base, 'GET', '/api/layouts?room=' + name)).json)['layouts'], ['plan'])
    assert.deepEqual(rec((await api(s.base, 'GET', '/api/layouts?scene=' + A)).json)['layouts'], []) // a scene's own layouts stay its own
    assert.equal((await room(s, name))['layouts'], 1)
    refused(await api(s.base, 'GET', '/api/layouts/nope?room=' + name), 404)
    const del = await api(s.base, 'DELETE', '/api/layouts/plan?room=' + name)
    assert.equal(del.status, 200, del.text)
    assert.equal(rec(del.json)['room'], name)
    assert.match(str(rec(del.json)['trash']), new RegExp('^layouts/@' + name + '/\\.trash/plan-\\d{8}-\\d{6}\\.json$'))
    refused(await api(s.base, 'DELETE', '/api/layouts/plan?room=' + name), 404)
    // The planner's Undo: PUT it back.
    assert.equal((await api(s.base, 'PUT', '/api/layouts/plan?room=' + name, layout)).status, 200)
    noViolations(s)
  })

  void test('render: `room` needs a member scene; GET /api/renders?room=', async () => {
    const listed = list(rec((await api(s.base, 'GET', '/api/rooms')).json)['rooms']).map(rec)
    const name = str(listed.find((x) => members(x).some((m) => m['scene'] === A))?.['name'])
    const image = 'data:image/jpeg;base64,' + PHOTO('living-wide').toString('base64')
    refused(await api(s.base, 'POST', '/api/render', { image, model: 'kontext', room: 'room-20000101-000000', scene: A }), 404)
    refused(await api(s.base, 'POST', '/api/render', { image, model: 'kontext', room: name }), 400)
    refused(await api(s.base, 'POST', '/api/render', { image, model: 'kontext', room: name, scene: C }), 400)
    const a = await api(s.base, 'POST', '/api/render', { image, model: 'kontext', room: name, scene: A, layout: 'plan' })
    assert.equal(a.status, 200, a.text)
    assert.equal(rec(a.json)['room'], name)
    assert.equal(rec(a.json)['scene'], A)
    const plain = await api(s.base, 'POST', '/api/render', { image, model: 'kontext', scene: A })
    assert.equal(plain.status, 200, plain.text)
    assert.ok(!('room' in rec(plain.json)))
    const inRoom = list(rec((await api(s.base, 'GET', '/api/renders?room=' + name)).json)['renders']).map((x) => rec(x)['name'])
    assert.deepEqual(inRoom, [rec(a.json)['name']])
    assert.equal(list(rec((await api(s.base, 'GET', '/api/renders?scene=' + A)).json)['renders']).length, 2)
    assert.equal(list(rec((await api(s.base, 'GET', '/api/renders?room=room-20000101-000000')).json)['renders']).length, 0)
    noViolations(s)
  })

  void test('deleting a scene takes it out of its room; restoring it puts it back', async () => {
    const listed = list(rec((await api(s.base, 'GET', '/api/rooms')).json)['rooms']).map(rec)
    const name = str(listed.find((x) => members(x).some((m) => m['scene'] === A))?.['name'])
    const before = members(await room(s, name)).map((x) => ({ scene: x['scene'], pose: x['pose'], scale: x['scale'], pose_source: x['pose_source'] }))
    const del = await api(s.base, 'DELETE', '/api/scenes/' + B)
    assert.equal(del.status, 200, del.text)
    assert.deepEqual(members(await room(s, name)).map((x) => x['scene']), [A])
    const trash = rec(JSON.parse(fs.readFileSync(path.join(s.dir, str(rec(del.json)['trash']), 'trash.json'), 'utf8')))
    assert.deepEqual(trash['room'], { name, index: 1, member: before[1] })
    const back = await api(s.base, 'POST', '/api/scenes/' + B + '/restore')
    assert.equal(back.status, 200, back.text)
    assert.equal(rec(back.json)['room'], name)
    assert.deepEqual(members(await room(s, name)).map((x) => ({ scene: x['scene'], pose: x['pose'], scale: x['scale'], pose_source: x['pose_source'] })), before)
    noViolations(s)
  })

  void test('DELETE and restore a room: its layouts go with it, its scenes stay; members taken since are dropped', async () => {
    const listed = list(rec((await api(s.base, 'GET', '/api/rooms')).json)['rooms']).map(rec)
    const name = str(listed.find((x) => members(x).some((m) => m['scene'] === A))?.['name'])
    const solo = str(listed.find((x) => x['name'] !== name)?.['name'])
    refused(await api(s.base, 'DELETE', '/api/rooms/room-20000101-000000'), 404)
    refused(await api(s.base, 'POST', '/api/rooms/' + name + '/restore'), 404) // not in the trash
    const del = await api(s.base, 'DELETE', '/api/rooms/' + name)
    assert.equal(del.status, 200, del.text)
    assert.match(str(rec(del.json)['trash']), new RegExp('^rooms/\\.trash/' + name + '-\\d{8}-\\d{6}$'))
    const dir = path.join(s.dir, str(rec(del.json)['trash']))
    assert.ok(fs.existsSync(path.join(dir, 'room.json')) && fs.existsSync(path.join(dir, 'align.json')) && fs.existsSync(path.join(dir, 'layouts', 'plan.json')))
    assert.ok(!fs.existsSync(path.join(s.layouts, '@' + name)))
    refused(await api(s.base, 'GET', '/api/rooms/' + name), 404)
    refused(await api(s.base, 'GET', '/api/layouts?room=' + name), 404)
    const list1 = rec((await api(s.base, 'GET', '/api/rooms')).json)
    assert.deepEqual(list(list1['trash']).map((x) => rec(x)['name']), [name])
    assert.equal(rec((await api(s.base, 'GET', '/api/scenes/' + A)).json)['room'], null)
    assert.equal((await api(s.base, 'GET', '/api/scenes/' + A)).status, 200)
    // B joins the other room meanwhile: the restored room comes back without it.
    await api(s.base, 'PUT', '/api/rooms/' + solo, { members: [{ scene: C }, { scene: B }] })
    // A name that exists again: 409.
    fs.mkdirSync(path.join(s.rooms, name))
    refused(await api(s.base, 'POST', '/api/rooms/' + name + '/restore'), 409)
    fs.rmdirSync(path.join(s.rooms, name))
    const back = await api(s.base, 'POST', '/api/rooms/' + name + '/restore')
    assert.equal(back.status, 200, back.text)
    assert.deepEqual(members(rec(back.json)).map((x) => x['scene']), [A])
    assert.equal(rec(back.json)['layouts'], 1)
    assert.equal(rec(back.json)['align_status'], 'done')
    assert.deepEqual(list(rec((await api(s.base, 'GET', '/api/rooms')).json)['trash']), [])
    // Deleting a scene whose room was deleted since: it comes back on its own.
    const delA = await api(s.base, 'DELETE', '/api/scenes/' + A)
    assert.equal(delA.status, 200)
    await api(s.base, 'DELETE', '/api/rooms/' + name)
    const backA = await api(s.base, 'POST', '/api/scenes/' + A + '/restore')
    assert.equal(rec(backA.json)['room'], null)
    noViolations(s)
  })
})

void describe('align jobs: waiting for calibrations, failures, the worker, a deleted room', () => {
  void test('a job waits for its members to calibrate, letting their calibrations pass', async () => {
    const s = await server('wait', { ROOMS_CALIB_DELAY_MS: '1500' })
    try {
      const a = await upload(s, 'living-wide')
      const b = await upload(s, 'room-1')
      const r = await create(s, { scenes: [a, b] })
      const post = await api(s.base, 'POST', '/api/rooms/' + str(r['name']) + '/align')
      assert.equal(post.status, 202, post.text)
      const j0 = rec(rec(post.json)['job'])
      assert.equal(j0['status'], 'queued')
      assert.ok(list(j0['waiting_for']).length >= 1, JSON.stringify(j0))
      assert.match(str(j0['message']), /^waiting for \d photos? to calibrate$/)
      assert.equal((await room(s, str(r['name'])))['align_status'], 'pending')
      refused(await api(s.base, 'POST', '/api/rooms/' + str(r['name']) + '/align'), 409) // one per room
      const j = await job(s, str(j0['id']))
      assert.equal(j['status'], 'done', JSON.stringify(j))
      for (const n of [a, b]) assert.equal(rec((await api(s.base, 'GET', '/api/scenes/' + n)).json)['calib_status'], 'done')
      nearPose(members(await room(s, str(r['name'])))[1]?.['pose'], ROOM1)
      noViolations(s)
    } finally {
      await s.stop()
    }
  })

  void test('a failed alignment changes nothing and says why; an answer that breaks the contract fails its job', async () => {
    for (const [env, pattern] of [[{ ROOMS_CALIB_ALIGN_FAIL: '1' }, /^the photos don't overlap$/], [{ ROOMS_CALIB_ALIGN_OFF_CONTRACT: '1' }, /^contract violation: /]] as const) {
      const s = await server('fail', env)
      try {
        const [a = '', b = ''] = await scenesOf(s, ['living-wide', 'room-1'])
        const r = await create(s, { scenes: [a, b] })
        const file = path.join(s.rooms, str(r['name']), 'room.json')
        const before = fs.readFileSync(file, 'utf8')
        const j = await job(s, str(rec(rec((await api(s.base, 'POST', '/api/rooms/' + str(r['name']) + '/align')).json)['job'])['id']))
        assert.equal(j['status'], 'failed')
        assert.match(str(j['message']), pattern)
        assert.equal(j['align'], null)
        const d = await room(s, str(r['name']))
        assert.equal(d['align_status'], 'failed')
        assert.match(str(d['align_error']), pattern)
        assert.equal(fs.readFileSync(file, 'utf8'), before)
      } finally {
        await s.stop()
      }
    }
  })

  void test('through the warm worker; a room deleted while its job waits drops the job', async () => {
    const log = path.join(REPO, 'evals/out/server-core-tests', 'rooms-calib-' + String(process.pid) + '.log')
    fs.rmSync(log, { force: true })
    const s = await server('worker', { ROOMS_CALIB_SERVE: '1', ROOMS_CALIB_LOG: log, ROOMS_CALIB_ALIGN_DELAY_MS: '800', ROOMS_CALIB_DELAY_MS: '800' })
    try {
      const [a = '', b = '', c = ''] = await scenesOf(s, ['living-wide', 'room-1', 'room-2'])
      const r = await create(s, { scenes: [a, b] })
      const j = await job(s, str(rec(rec((await api(s.base, 'POST', '/api/rooms/' + str(r['name']) + '/align')).json)['job'])['id']))
      assert.equal(j['status'], 'done', JSON.stringify(j))
      const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => rec(JSON.parse(l)))
      assert.ok(lines.some((l) => isAlignRequest(l['request'])), 'no align-room request reached the worker')
      // A running job's room deleted: its result is ignored and the tool's leftover folder removed.
      const r2 = await create(s, { scenes: [c] })
      await api(s.base, 'PUT', '/api/rooms/' + str(r['name']), { members: [] })
      await api(s.base, 'PUT', '/api/rooms/' + str(r2['name']), { members: [{ scene: a }, { scene: b }] })
      const id = str(rec(rec((await api(s.base, 'POST', '/api/rooms/' + str(r2['name']) + '/align')).json)['job'])['id'])
      await until('running', async () => (rec((await api(s.base, 'GET', '/api/rooms/jobs/' + id)).json)['status'] === 'running' ? true : null))
      assert.equal((await api(s.base, 'DELETE', '/api/rooms/' + str(r2['name']))).status, 200)
      const done = await job(s, id)
      assert.equal(done['status'], 'failed')
      assert.equal(done['message'], 'the room was deleted')
      assert.ok(!fs.existsSync(path.join(s.rooms, str(r2['name']))))
      // Queued then deleted: dropped at once.
      const r3 = await create(s, { scenes: [c, a, b] })
      const calib = await api(s.base, 'POST', '/api/scenes/' + c + '/calibrate')
      assert.equal(calib.status, 202)
      const busy = str(rec(rec((await api(s.base, 'POST', '/api/rooms/' + str(r3['name']) + '/align')).json)['job'])['id'])
      assert.deepEqual(rec((await api(s.base, 'GET', '/api/rooms/jobs/' + busy)).json)['waiting_for'], [c])
      await api(s.base, 'DELETE', '/api/rooms/' + str(r3['name']))
      const gone = await job(s, busy)
      assert.equal(gone['status'], 'failed')
      assert.equal(gone['message'], 'the room was deleted')
      noViolations(s)
    } finally {
      await s.stop()
    }
  })
})

function isAlignRequest(v: unknown): boolean {
  return typeof v === 'object' && v !== null && 'cmd' in v && v.cmd === 'align-room'
}

void describe('align staging (rooms/.align/<job>/, §4.9 Align) and crash-ordered trash moves', () => {
  const alignOf = async (s: Running, name: string): Promise<string> =>
    str(rec(rec((await api(s.base, 'POST', '/api/rooms/' + name + '/align')).json)['job'])['id'])
  const running = async (s: Running, id: string): Promise<void> => {
    await until('running', async () => (rec((await api(s.base, 'GET', '/api/rooms/jobs/' + id)).json)['status'] === 'running' ? true : null))
  }
  const scratch = (s: Running): string[] => {
    const d = path.join(s.rooms, '.align')
    return fs.existsSync(d) ? fs.readdirSync(d) : []
  }

  void test('--out is the job\'s scratch; align.json lands in the room, the scratch is gone when the job is done', async () => {
    const log = path.join(REPO, 'evals/out/server-core-tests', 'rooms-staging-' + String(process.pid) + '.log')
    fs.mkdirSync(path.dirname(log), { recursive: true })
    fs.rmSync(log, { force: true })
    const s = await server('staging', { ROOMS_CALIB_LOG: log })
    try {
      const [a = '', b = ''] = await scenesOf(s, ['living-wide', 'room-1'])
      const name = str((await create(s, { scenes: [a, b] }))['name'])
      const id = await alignOf(s, name)
      assert.equal((await job(s, id))['status'], 'done')
      const runs = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => rec(JSON.parse(l))).map((l) => list(l['argv'] ?? []).map(str)).filter((v) => v[0] === 'align-room')
      const argv = runs[runs.length - 1] ?? []
      assert.equal(argv[argv.indexOf('--out') + 1], path.resolve(s.rooms, '.align', id))
      assert.ok(fs.existsSync(path.join(s.rooms, name, 'align.json')))
      assert.deepEqual(scratch(s), [])
      assert.equal((await room(s, name))['align_status'], 'done')
      noViolations(s)
    } finally {
      await s.stop()
    }
  })

  void test('a room deleted and restored while its job runs: the answer is not applied and leaves no file', async () => {
    const s = await server('restored', { ROOMS_CALIB_ALIGN_DELAY_MS: '1200' })
    try {
      const [a = '', b = ''] = await scenesOf(s, ['living-wide', 'room-1'])
      const name = str((await create(s, { scenes: [a, b] }))['name'])
      const before = fs.readFileSync(path.join(s.rooms, name, 'room.json'), 'utf8')
      const id = await alignOf(s, name)
      await running(s, id)
      assert.equal((await api(s.base, 'DELETE', '/api/rooms/' + name)).status, 200)
      assert.equal((await api(s.base, 'POST', '/api/rooms/' + name + '/restore')).status, 200)
      const done = await job(s, id)
      assert.equal(done['status'], 'failed')
      assert.equal(done['message'], 'the room was deleted')
      assert.ok(!fs.existsSync(path.join(s.rooms, name, 'align.json')), 'the dropped run wrote align.json into the restored room')
      assert.equal(fs.readFileSync(path.join(s.rooms, name, 'room.json'), 'utf8'), before)
      assert.notEqual((await room(s, name))['align_status'], 'done')
      assert.deepEqual(scratch(s), [])
    } finally {
      await s.stop()
    }
  })

  void test('a room deleted while its job runs stays gone, in rooms/ and in the scratch', async () => {
    const s = await server('dropped', { ROOMS_CALIB_ALIGN_DELAY_MS: '800' })
    try {
      const [a = '', b = ''] = await scenesOf(s, ['living-wide', 'room-1'])
      const name = str((await create(s, { scenes: [a, b] }))['name'])
      const id = await alignOf(s, name)
      await running(s, id)
      assert.equal((await api(s.base, 'DELETE', '/api/rooms/' + name)).status, 200)
      assert.equal((await job(s, id))['message'], 'the room was deleted')
      assert.ok(!fs.existsSync(path.join(s.rooms, name)))
      assert.deepEqual(scratch(s), [])
    } finally {
      await s.stop()
    }
  })

  void test('an answer that breaks the contract never reaches the room: no align.json, Reset is refused', async () => {
    const s = await server('off-contract', { ROOMS_CALIB_ALIGN_OFF_CONTRACT: '1' })
    try {
      const [a = '', b = ''] = await scenesOf(s, ['living-wide', 'room-1'])
      const name = str((await create(s, { scenes: [a, b] }))['name'])
      assert.equal((await job(s, await alignOf(s, name)))['status'], 'failed')
      assert.ok(!fs.existsSync(path.join(s.rooms, name, 'align.json')))
      assert.deepEqual(scratch(s), [])
      refused(await api(s.base, 'PUT', '/api/rooms/' + name, { reset: [b] }), 409)
    } finally {
      await s.stop()
    }
  })

  void test('a failed job leaves the previous align.json as it was', async () => {
    const s = await server('keeps', { ROOMS_CALIB_ALIGN_OFF_CONTRACT: '1' })
    try {
      const [a = '', b = ''] = await scenesOf(s, ['living-wide', 'room-1'])
      const name = str((await create(s, { scenes: [a, b] }))['name'])
      const file = path.join(s.rooms, name, 'align.json')
      fs.writeFileSync(file, 'the previous answer\n')
      assert.equal((await job(s, await alignOf(s, name)))['status'], 'failed')
      assert.equal(fs.readFileSync(file, 'utf8'), 'the previous answer\n')
    } finally {
      await s.stop()
    }
  })

  void test('RoomService sweeps rooms/.align/ when it starts (a crash mid-run leaves a folder)', () => {
    const dir = path.join(REPO, 'evals/out/server-core-tests', 'rooms-sweep-' + String(process.pid))
    const rooms = path.join(dir, 'rooms')
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(path.join(rooms, '.align', 'a-crashed'), { recursive: true })
    fs.writeFileSync(path.join(rooms, '.align', 'a-crashed', 'align.json'), '{}')
    const scenes = new SceneService({ scenesDir: path.join(dir, 'scenes'), layoutsDir: path.join(dir, 'layouts'), calib: ['python3', 'fixtures/stub_calib.py'], repo: REPO, log: () => undefined })
    assert.ok(new RoomService({ roomsDir: rooms, layoutsDir: path.join(dir, 'layouts'), scenes }).names().length === 0)
    assert.ok(!fs.existsSync(path.join(rooms, '.align', 'a-crashed')))
    fs.rmSync(dir, { recursive: true, force: true })
  })

  void test('DELETE: trash.json goes in first, so a move that fails leaves a room the trash can list', async () => {
    const s = await server('trash-order')
    const [a = ''] = await scenesOf(s, ['living-wide'])
    const name = str((await create(s, { scenes: [a] }))['name'])
    fs.mkdirSync(path.join(s.layouts, '@' + name))
    fs.writeFileSync(path.join(s.layouts, '@' + name, 'plan.json'), '{}')
    fs.chmodSync(s.layouts, 0o500)
    try {
      const del = await api(s.base, 'DELETE', '/api/rooms/' + name)
      assert.ok(del.status >= 500, del.text)
      const trashed = fs.readdirSync(path.join(s.rooms, '.trash'))
      assert.equal(trashed.length, 1)
      assert.ok(fs.existsSync(path.join(s.rooms, '.trash', trashed[0] ?? '', 'trash.json')))
      assert.deepEqual(list(rec((await api(s.base, 'GET', '/api/rooms')).json)['trash']).map((x) => rec(x)['name']), [name])
    } finally {
      fs.chmodSync(s.layouts, 0o700)
      await s.stop()
    }
  })
})
