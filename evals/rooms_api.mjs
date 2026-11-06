// E18 eval:rooms-api — the rooms API of the server (contract §4.9, §2.7 with ?room=, §4.4 scene delete/restore in a
// room, §4.7 render with room, §2.9), no browser. Written from the contract and its schemas only (docs/ROOMS.md Phase B).
// Every route and its refusals (W1 forged requests, 400/404/409), the room object and detail, room.json on disk, PUT's
// changes in order (title, members, reset, rescale) with every clamp, the align job on the calibration queue (it waits
// for a member that is still calibrating, 409 while queued, not in /api/scenes/jobs), the calib mock's true poses
// applied through the anchor (manual and origin kept, overwrite_manual, scales), a mock miss (solver none), a failing
// align-room and a strict-mode contract violation (crafted mock answers), trash and restore of rooms (layouts move with
// them, members that are gone or now in another room are dropped, 404/409), a scene deleted from a room and restored
// into it (trash.json room record), room layouts (exactly one of scene and room), and a render in a room. Every answer
// is checked against contract/api/routes.json; the server runs in strict mode (MIDSTUDY_STRICT=1).
// Calibration and align-room go through evals/lib/gated_calib.py → fixtures/stub_calib.py with a copy of fixtures/calib
// plus crafted answers as MIDSTUDY_CALIB_MOCK (evals/out/rooms-api/calib-mock/).
// Usage: node evals/rooms_api.mjs   (or npm run eval:rooms-api). Output: evals/out/rooms-api/.
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, createEval, startServer, api, raw, uploadScene, waitFor, waitScene, golden, fmt, clip, dataUri, sleep, seedScene, unknownPhoto,
} from './lib/harness.mjs'
import {
  ROOM_NAME_RE, ALIGN_JOB_RE, ISO_RE, contractClient, fileViolation, guardRooms, sha256File, sha256, mockKey, applyAnchor, poseEq, normYaw,
  effectiveCamera, memberOf, waitJob, fmtPose,
} from './lib/rooms.mjs'

const ev = createEval('E18', 'rooms-api', { timeoutS: 480 })
guardRooms(ev)
const GATE = path.join(ev.out, 'calib-gate')
const CALLOG = path.join(ev.out, 'calib-calls.jsonl')
const openGate = () => fs.writeFileSync(GATE, 'open')
const closeGate = () => fs.rmSync(GATE, { force: true })
const calls = () => (fs.existsSync(CALLOG) ? fs.readFileSync(CALLOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const st = (r) => `${r.status || r.error}${r.json ? ` ${clip(fmt(r.json), 240)}` : r.text ? ` ${clip(r.text, 120)}` : ''}`
const DATA = path.join(ev.out, 'data')
const ROOMS = path.join(DATA, 'rooms')
fs.mkdirSync(DATA, { recursive: true })
const NO_SCENE = 'scene-20000101-000000', NO_ROOM = 'room-20000101-000000'
const EVIL = { Origin: 'http://evil.example' }

// --- the calib mock: fixtures/calib plus crafted answers ---------------------------------------------------------------------
const MOCK = path.join(ev.out, 'calib-mock')
fs.cpSync(path.join(REPO, 'fixtures/calib'), MOCK, { recursive: true })
const SHA = Object.fromEntries(['living-wide', 'room-1', 'room-2', 'room-3', 'room-5', 'room-6', 'living-cool', 'living-warm'].map((id) => [id, sha256File(golden(id).photo)]))
const crafted = (shas, members, extra = {}) => {
  const dir = path.join(MOCK, 'rooms', mockKey(shas))
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'align.json'), JSON.stringify({ version: 1, solver: 'truth', created: '2026-11-06T00:00:00Z', elapsed_s: 0, device: null, loop_residual_cm: null,
    members, unplaced: members.filter((m) => m.pose === null).map((m) => m.scene), ...extra }, null, 2))
}
// (room-2, living-cool): the anchor (room-2, the room's first member) is unplaced in the answer → align-room fails.
crafted([SHA['room-2'], SHA['living-cool']], [
  { scene: 'living-cool', photo_sha256: SHA['living-cool'], pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1, confidence: 1, residual_cm: null },
  { scene: 'room-2', photo_sha256: SHA['room-2'], pose: null, scale: null, confidence: 0, residual_cm: null }])
// (room-2, living-warm): an answer that breaks align.schema.json (confidence 2) → strict mode fails the job.
crafted([SHA['room-2'], SHA['living-warm']], [
  { scene: 'room-2', photo_sha256: SHA['room-2'], pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1, confidence: 1, residual_cm: null },
  { scene: 'living-warm', photo_sha256: SHA['living-warm'], pose: { x_m: 0.5, z_m: -0.5, yaw_deg: 10 }, scale: 1, confidence: 2, residual_cm: 1 }])
const PAIR_TRUE = golden('room-1').truth.pose_in_room // the golden-pair answer: room-1 relative to living-wide

// --- server ----------------------------------------------------------------------------------------------------------------------
openGate()
const STUB = `env MIDSTUDY_CALIB_MOCK=${MOCK} python3 ${path.join(REPO, 'fixtures/stub_calib.py')}`
const srvOpts = { calib: `python3 ${path.join(REPO, 'evals/lib/gated_calib.py')}`, env: { MIDSTUDY_EVAL_CALIB_GATE: GATE, MIDSTUDY_EVAL_CALIB_LOG: CALLOG, MIDSTUDY_EVAL_CALIB_TARGET: STUB } }
let srv = await startServer(ev, { ...srvOpts, args: ['--rooms-dir', ROOMS] })
ev.check('the server starts with --rooms-dir (contract §2.1) and scratch dirs', srv.up, srv.up ? `${srv.base}, rooms in ${path.relative(REPO, ROOMS)}` : srv.why)
if (!srv.up) {
  ev.note('retrying without --rooms-dir, so the checks below show what is missing')
  srv = await startServer(ev, srvOpts)
  if (!srv.up) { ev.check('the server starts without --rooms-dir', false, srv.why); await ev.finish() }
}
const B = srv.base
const C = contractClient(B)
const roomFolders = () => (fs.existsSync(ROOMS) ? fs.readdirSync(ROOMS).filter((n) => !n.startsWith('.')).sort() : [])
const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return null } }
const roomJson = (room) => readJson(path.join(ROOMS, room, 'room.json'))
const sceneRoom = async (name) => (await C.get(`/api/scenes/${name}`)).json?.room
const get = async (room) => (await C.get(`/api/rooms/${room}`)).json
const put = (room, body, o) => C.send('PUT', `/api/rooms/${room}`, body, o)
const pose = (x_m, z_m, yaw_deg) => ({ x_m, z_m, yaw_deg })
const ZERO = pose(0, 0, 0)

ev.section('empty (§4.9)')
let r = await C.get('/api/rooms')
ev.check('GET /api/rooms on an empty rooms dir is 200 {"rooms": [], "trash": []}', r.status === 200 && Array.isArray(r.json?.rooms) && r.json.rooms.length === 0 && Array.isArray(r.json?.trash) && r.json.trash.length === 0, st(r))
const UP = r.status === 200 // a 404 only counts as the right answer when the rooms routes exist
const is404 = (x) => UP && x.status === 404
if (!UP) ev.note('the rooms API is not there yet: the remaining checks will fail for that reason')

// --- scenes ----------------------------------------------------------------------------------------------------------------------
const seeds = {}
for (const id of ['living-wide', 'room-1', 'room-2', 'room-3', 'room-5', 'living-cool', 'living-warm']) seeds[id] = await seedScene(srv, id, id)
const upU = await uploadScene(B, unknownPhoto(), { filename: 'unknown.jpg', title: 'unknown' })
const U = upU.json?.scene
const sU = U ? await waitScene(B, U) : null
const S = Object.fromEntries(Object.entries(seeds).map(([k, v]) => [k, v.name]))
const LW = S['living-wide'], R1 = S['room-1'], R2 = S['room-2'], R3 = S['room-3'], R5 = S['room-5'], LC = S['living-cool'], LWm = S['living-warm']
ev.check('seven golden photos and one unknown photo calibrate (stub + mock)', Object.values(seeds).every((s) => s.name && !s.why) && sU?.calib_status === 'done',
  fmt(Object.fromEntries(Object.entries(seeds).map(([k, v]) => [k, v.why || 'ok']))) + ` unknown: ${sU?.calib_status}`)
r = await C.get('/api/scenes')
ev.check('the scene object carries room: null for scenes in no room (a server with rooms always sends it, §4.4)', r.status === 200 && r.json?.scenes?.length >= 8 && r.json.scenes.every((s) => s.room === null), fmt(r.json?.scenes?.map((s) => s.room)))
const camOf = async (name) => (await C.get(`/api/scenes/${name}`)).json?.camera

// --- POST /api/rooms -------------------------------------------------------------------------------------------------------------
ev.section('POST /api/rooms: refusals')
const refusals = [
  ['no X-Midstudy (W1) → 403', () => C.send('POST', '/api/rooms', { scenes: [LW] }, { forged: true }), 403],
  ['a foreign Origin (W1) → 403', () => C.send('POST', '/api/rooms', { scenes: [LW] }, { headers: EVIL }), 403],
  ['a foreign Host (W2) → 403', () => raw(B, 'POST', '/api/rooms', { headers: { Host: 'evil.example', 'X-Midstudy': '1', 'Content-Type': 'application/json' }, body: { scenes: [LW] } }), 403],
  ['a body that is not JSON → 400', () => raw(B, 'POST', '/api/rooms', { headers: { 'X-Midstudy': '1', 'Content-Type': 'application/json' }, body: '{scenes' }), 400],
  ['no scenes → 400', () => C.send('POST', '/api/rooms', { title: 'x' }), 400],
  ['scenes: [] → 400', () => C.send('POST', '/api/rooms', { scenes: [] }), 400],
  ['a scene listed twice → 400', () => C.send('POST', '/api/rooms', { scenes: [LW, R1, LW] }), 400],
  ['an unknown key → 400', () => C.send('POST', '/api/rooms', { scenes: [LW], colour: 'red' }), 400],
  ['a scene name that is not a slug → 400', () => C.send('POST', '/api/rooms', { scenes: ['Bad Name'] }), 400],
  ['a title over 200 characters → 400', () => C.send('POST', '/api/rooms', { scenes: [LW], title: 'x'.repeat(201) }), 400],
  ['a title that is not text → 400', () => C.send('POST', '/api/rooms', { scenes: [LW], title: 5 }), 400],
  ['33 scenes (at most 32) → 400', () => C.send('POST', '/api/rooms', { scenes: Array.from({ length: 33 }, (_, i) => `scene-20000101-0000${String(i).padStart(2, '0')}`) }), 400],
  ['a scene that does not exist → 404', () => C.send('POST', '/api/rooms', { scenes: [LW, NO_SCENE] }), 404],
]
for (const [what, fn, want] of refusals) { r = await fn(); ev.check(`POST /api/rooms: ${what}`, (want !== 404 || UP) && r.status === want && (want === 403 || typeof r.json?.error === 'string'), st(r)) }
ev.check('…and none of them created a room or put a scene in one', roomFolders().length === 0 && (await sceneRoom(LW)) === null, fmt({ folders: roomFolders(), lw: await sceneRoom(LW) }))

ev.section('POST /api/rooms: a room')
const t0 = new Date()
r = await C.send('POST', '/api/rooms', { title: '  Lounge  ', scenes: [LW, R1] })
const A = r.json?.name || 'room-missing-a'
let d = r.json
ev.check('POST {title, scenes: [living-wide, room-1]} → 201 the room detail', r.status === 201 && typeof A === 'string', st(r))
ev.check('the room name is room-YYYYMMDD-HHMMSS (UTC of the POST)', ROOM_NAME_RE.test(A || '') && A?.slice(5, 13) === t0.toISOString().slice(0, 10).replace(/-/g, ''), A)
ev.check('title trimmed, version 1, created ISO, saved null, aligned null, align null, align_status none, align_error null, layouts 0',
  d?.title === 'Lounge' && d?.version === 1 && ISO_RE.test(d?.created || '') && d?.saved === null && d?.aligned === null && d?.align === null && d?.align_status === 'none' && d?.align_error === null && d?.layouts === 0,
  fmt({ title: d?.title, version: d?.version, created: d?.created, saved: d?.saved, aligned: d?.aligned, align: d?.align, align_status: d?.align_status, align_error: d?.align_error, layouts: d?.layouts }))
ev.check('first member: pose {0, 0, 0}, origin, scale 1; the other unplaced (pose null), scale 1; in the order given',
  d?.members?.length === 2 && d.members[0].scene === LW && poseEq(d.members[0].pose, ZERO) && d.members[0].pose_source === 'origin' && d.members[0].scale === 1
  && d.members[1].scene === R1 && d.members[1].pose === null && d.members[1].pose_source === 'unplaced' && d.members[1].scale === 1,
  fmt(d?.members?.map(({ scene, pose, scale, pose_source }) => ({ scene, pose, scale, pose_source }))))
const camLW = await camOf(LW), camR1 = await camOf(R1)
ev.check('each member: scene_object (§4.4, room set), camera = its scene.json camera, effective_camera = that camera (scale 1)',
  d?.members?.every((m) => m.scene_object?.name === m.scene && m.scene_object?.room === A) && fmt(memberOf(d, LW)?.camera) === fmt(camLW) && fmt(memberOf(d, R1)?.effective_camera) === fmt(camR1),
  fmt(d?.members?.map((m) => ({ so: m.scene_object?.name, room: m.scene_object?.room, cam: m.camera, eff: m.effective_camera }))))
let rj = roomJson(A)
ev.check('rooms/<room>/room.json is written: room.schema.json, the same name, title, created, members as the answer',
  rj && !fileViolation('midstudy/room.schema.json', rj) && rj.name === A && rj.title === 'Lounge' && rj.created === d?.created && fmt(rj.members) === fmt(d?.members?.map(({ scene, pose, scale, pose_source }) => ({ scene, pose, scale, pose_source }))),
  rj ? (fileViolation('midstudy/room.schema.json', rj) || fmt(rj)) : `no ${path.relative(REPO, path.join(ROOMS, A || '?', 'room.json'))}`)
ev.check('GET /api/scenes/<member> and the scenes list say room = the room; others null', (await sceneRoom(LW)) === A && (await sceneRoom(R1)) === A && (await sceneRoom(R2)) === null,
  fmt({ lw: await sceneRoom(LW), r1: await sceneRoom(R1), r2: await sceneRoom(R2) }))
r = await C.send('POST', '/api/rooms', { scenes: [R2, R1] })
ev.check('a scene already in a room → 409, and nothing is created (room-2 stays in no room)', UP && r.status === 409 && roomFolders().length === 1 && (await sceneRoom(R2)) === null, st(r))
r = await C.send('POST', '/api/rooms', { title: '   ', scenes: [R2] })
const Bm = r.json?.name || 'room-missing-b'
ev.check('a blank title → 201 with title null; a room of one photo is fine', r.status === 201 && r.json?.title === null && r.json?.members?.length === 1, st(r))
r = await C.get(`/api/rooms/${A}`)
d = r.json
ev.check('GET /api/rooms/<room> → 200 the detail (as POST answered)', r.status === 200 && d?.name === A && d?.members?.length === 2 && 'align' in (d || {}), st(r))
for (const [what, p] of [['an unknown room', `/api/rooms/${NO_ROOM}`], ['a name that is not a slug', '/api/rooms/Bad%20Name'], ['a path escape', '/api/rooms/..%2Fscenes']]) {
  r = await raw(B, 'GET', p)
  ev.check(`GET /api/rooms/<${what}> is a 4xx (404 for an unknown room), never a 200`, what === 'an unknown room' ? is404(r) : r.status >= 400 && r.status < 500, st(r))
}
for (const p of [`/rooms/${A}/room.json`, `/./rooms/${A}/room.json`, `/planner/../rooms/${A}/room.json`, `/Rooms/${A}/room.json`]) {
  r = await raw(B, 'GET', p)
  ev.check(`rooms/ is never served: GET ${p.replace(A, '<room>')} → 404`, r.status === 404, `${r.status}`)
}

ev.section('same-second names and the list order')
await waitFor(() => new Date().getMilliseconds() < 300, { timeoutMs: 2000, intervalMs: 5 })
const [c1, c2] = await Promise.all([C.send('POST', '/api/rooms', { title: 'C one', scenes: [LC] }), C.send('POST', '/api/rooms', { title: 'C two', scenes: [LWm] })])
const pairNames = [c1.json?.name, c2.json?.name].filter(Boolean).sort()
ev.check('two rooms created in the same second: the second is <name>-2', c1.status === 201 && c2.status === 201 && pairNames.length === 2 && pairNames[1] === `${pairNames[0]}-2`, fmt(pairNames))
const C1 = c1.json?.name || 'room-missing-c1', C2 = c2.json?.name || 'room-missing-c2'
r = await C.get('/api/rooms')
const order = r.json?.rooms?.map((x) => x.name) || []
const want = [...order].sort((p, q) => {
  const a = r.json.rooms.find((x) => x.name === p), b = r.json.rooms.find((x) => x.name === q)
  if (a.created !== b.created) return a.created < b.created ? 1 : -1
  const n = (s) => Number(/-(\d+)$/.exec(s.replace(/^room-\d{8}-\d{6}/, ''))?.[1] || 1)
  return n(q) - n(p)
})
ev.check('GET /api/rooms lists every room, newest first (ties by the collision suffix as a number)', r.status === 200 && order.length === 4 && fmt(order) === fmt(want), fmt(order))
ev.check('each room object has members with scene_object, layouts, align_status, align_error (room-object)', r.json?.rooms?.every((x) => Array.isArray(x.members) && x.members.every((m) => m.scene_object) && typeof x.layouts === 'number' && x.align_status === 'none'), fmt(r.json?.rooms?.[0]))

// --- PUT ---------------------------------------------------------------------------------------------------------------------------
ev.section('PUT /api/rooms/<room>: refusals')
const before = fmt(roomJson(A))
const putRefusals = [
  ['no X-Midstudy (W1) → 403', [{ title: 'x' }, { forged: true }], 403],
  ['a foreign Origin (W1) → 403', [{ title: 'x' }, { headers: EVIL }], 403],
  ['{} → 400', [{}], 400],
  ['an unknown key → 400', [{ colour: 'red' }], 400],
  ['a title over 200 characters → 400', [{ title: 'y'.repeat(201) }], 400],
  ['members that are not a list → 400', [{ members: 'x' }], 400],
  ['a pose with a non-number → 400', [{ members: [{ scene: LW, pose: { x_m: 'a', z_m: 0, yaw_deg: 0 } }, { scene: R1 }] }], 400],
  ['a pose missing yaw_deg → 400', [{ members: [{ scene: LW, pose: { x_m: 0, z_m: 0 } }, { scene: R1 }] }], 400],
  ['a member listed twice → 400', [{ members: [{ scene: LW }, { scene: LW }] }], 400],
  ['a scale of 0 → 400', [{ members: [{ scene: LW, scale: 0 }, { scene: R1 }] }], 400],
  ['rescale 0 → 400', [{ rescale: 0 }], 400],
  ['rescale −1 → 400', [{ rescale: -1 }], 400],
  ['reset: [] → 400', [{ reset: [] }], 400],
  ['reset of a scene that is not a member → 400', [{ reset: [R2] }], 400],
  ['33 members → 400', [{ members: Array.from({ length: 33 }, (_, i) => ({ scene: `scene-20000101-0000${String(i).padStart(2, '0')}` })) }], 400],
  ['a member that does not exist → 404', [{ members: [{ scene: LW }, { scene: R1 }, { scene: NO_SCENE }] }], 404],
  ['a member that is in another room → 409', [{ members: [{ scene: LW }, { scene: R1 }, { scene: R2 }] }], 409],
  ['reset before any align.json → 409', [{ reset: [R1] }], 409],
]
for (const [what, args, want] of putRefusals) { r = await put(A, ...args); ev.check(`PUT: ${what}`, (want !== 404 || UP) && r.status === want, st(r)) }
r = await put(NO_ROOM, { title: 'x' })
ev.check('PUT an unknown room → 404', is404(r), st(r))
ev.check('…and room.json is unchanged by every refusal', roomJson(A) !== null && fmt(roomJson(A)) === before, 'compared')

ev.section('PUT: title, members, clamps')
const savedBefore = get(A).then((x) => x?.saved)
r = await put(A, { title: '  Lounge two ' })
ev.check('a title alone → 200, trimmed, and saved is not stamped', r.status === 200 && r.json?.title === 'Lounge two' && r.json?.saved === (await savedBefore), st(r))
r = await put(A, { title: null })
ev.check('title null removes it', r.status === 200 && r.json?.title === null, st(r))
await put(A, { title: 'Lounge' })
r = await put(A, { members: [{ scene: R1, scale: 10 }, { scene: LW }] })
d = r.json
ev.check('members reordered; scale 10 is clamped to 4 and doesn\'t change pose_source; an absent pose keeps the stored one',
  r.status === 200 && d?.members?.[0]?.scene === R1 && d.members[0].scale === 4 && d.members[0].pose_source === 'unplaced' && d.members[0].pose === null
  && d.members[1].scene === LW && d.members[1].pose_source === 'origin' && poseEq(d.members[1].pose, ZERO) && d.members[1].scale === 1, fmt(d?.members?.map(({ scene, pose, scale, pose_source }) => ({ scene, pose, scale, pose_source }))))
ev.check('a members change stamps saved (ISO, not before created)', ISO_RE.test(d?.saved || '') && d.saved >= d.created, fmt({ saved: d?.saved, created: d?.created }))
ev.check('effective_camera: height_m × 4 clamped to 3.0, the rest the scene\'s; camera is scene.json\'s', fmt(memberOf(d, R1)?.effective_camera) === fmt(effectiveCamera(camR1, 4)) && memberOf(d, R1)?.effective_camera?.height_m === 3 && fmt(memberOf(d, R1)?.camera) === fmt(camR1),
  fmt({ eff: memberOf(d, R1)?.effective_camera, cam: memberOf(d, R1)?.camera }))
r = await put(A, { members: [{ scene: LW }, { scene: R1, scale: 0.1 }] })
ev.check('scale 0.1 is clamped to 0.25; effective height_m = 0.25 × the scene\'s', r.status === 200 && memberOf(r.json, R1)?.scale === 0.25 && Math.abs(memberOf(r.json, R1)?.effective_camera?.height_m - 0.25 * camR1.height_m) < 1e-9,
  fmt(memberOf(r.json, R1)))
const poseCase = async (p, expect, what) => {
  const q = await put(A, { members: [{ scene: LW }, { scene: R1, pose: p, scale: 1 }] })
  const m = memberOf(q.json, R1)
  ev.check(`a pose ${what} → stored as ${fmtPose(expect)}, pose_source manual`, q.status === 200 && poseEq(m?.pose, expect, 1e-9, 1e-9) && m?.pose_source === 'manual', `${q.status} ${fmt(m)}`)
}
await poseCase(pose(100, -70, 190), pose(50, -50, -170), '(100, −70, 190°) (clamps)')
await poseCase(pose(1, 2, -180), pose(1, 2, 180), 'with yaw −180°')
await poseCase(pose(1, 2, 540), pose(1, 2, 180), 'with yaw 540°')
await poseCase(pose(1, 2, -190.5), pose(1, 2, 169.5), 'with yaw −190.5°')
r = await put(A, { members: [{ scene: LW, pose: pose(0, 0, 0) }, { scene: R1 }] })
ev.check('a pose equal to the stored one keeps its pose_source (origin stays origin)', r.status === 200 && memberOf(r.json, LW)?.pose_source === 'origin', fmt(memberOf(r.json, LW)))
r = await put(A, { members: [{ scene: LW }, { scene: R1, pose: null }] })
ev.check('pose null → unplaced, pose null', r.status === 200 && memberOf(r.json, R1)?.pose === null && memberOf(r.json, R1)?.pose_source === 'unplaced', fmt(memberOf(r.json, R1)))
r = await put(A, { members: [{ scene: LW }, { scene: R1 }, { scene: U, pose: pose(1, 1, 10) }] })
ev.check('a new member with a pose joins as manual (scale 1); its scene says room = the room', r.status === 200 && memberOf(r.json, U)?.pose_source === 'manual' && memberOf(r.json, U)?.scale === 1 && (await sceneRoom(U)) === A, fmt(memberOf(r.json, U)))
r = await put(A, { members: [{ scene: LW }, { scene: R1 }] })
ev.check('a scene left out leaves the room (not deleted: it still exists, room null)', r.status === 200 && r.json?.members?.length === 2 && (await sceneRoom(U)) === null && (await C.get(`/api/scenes/${U}`)).status === 200, fmt(r.json?.members?.map((m) => m.scene)))
r = await put(A, { members: [{ scene: LW }, { scene: R1 }, { scene: U }] })
ev.check('a new member without a pose joins unplaced, scale 1 (and its old pose was forgotten)', r.status === 200 && memberOf(r.json, U)?.pose_source === 'unplaced' && memberOf(r.json, U)?.pose === null && memberOf(r.json, U)?.scale === 1, fmt(memberOf(r.json, U)))
await put(A, { members: [{ scene: LW }, { scene: R1 }] })
rj = roomJson(A)
ev.check('room.json still validates and matches GET', rj && !fileViolation('midstudy/room.schema.json', rj) && fmt(rj.members) === fmt((await get(A))?.members?.map(({ scene, pose, scale, pose_source }) => ({ scene, pose, scale, pose_source }))), rj ? fileViolation('midstudy/room.schema.json', rj) || 'ok' : 'missing')

// --- layouts ----------------------------------------------------------------------------------------------------------------------
ev.section('room layouts (§2.7 with ?room=, §4.9 Layouts)')
const ITEM = { uid: 'probe-1', id: 'probe-box', render: 'glb', position: [0.4, 0, -2.6], rotation_y_deg: 15, dims_cm: { w: 80, d: 50, h: 120 } }
const LDIR = srv.dirs.layouts
r = await C.send('PUT', `/api/layouts/front?room=${A}`, { version: 1, name: 'front', title: 'Front', scene_name: LW, items: [ITEM] })
ev.check('PUT /api/layouts/front?room=<room> → 200: room_name set, a scene_name in the body dropped, updated stamped', r.status === 200 && r.json?.room_name === A && !('scene_name' in (r.json || {})) && r.json?.name === 'front' && ISO_RE.test(r.json?.updated || ''), st(r))
const lfile = path.join(LDIR, `@${A}`, 'front.json')
const lj = readJson(lfile)
ev.check('the file is layouts/@<room>/front.json: layout.schema.json, room_name, no scene_name, positions as sent', lj && !fileViolation('midstudy/layout.schema.json', lj) && lj.room_name === A && !('scene_name' in lj) && fmt(lj.items?.[0]?.position) === fmt(ITEM.position),
  lj ? fileViolation('midstudy/layout.schema.json', lj) || fmt(lj.items) : `no ${path.relative(REPO, lfile)}`)
r = await C.get(`/api/layouts?room=${A}`)
ev.check('GET /api/layouts?room= lists it (details: name, items)', r.status === 200 && fmt(r.json?.layouts) === '["front"]' && r.json?.details?.[0]?.items === 1, st(r))
r = await C.get(`/api/layouts/front?room=${A}`)
ev.check('GET /api/layouts/front?room= → 200 the layout', r.status === 200 && r.json?.room_name === A && r.json?.items?.length === 1, st(r))
await C.send('PUT', `/api/layouts/own?scene=${LW}`, { items: [ITEM] })
r = await C.get(`/api/layouts?scene=${LW}`)
const r2 = await C.get(`/api/layouts/front?scene=${LW}`)
ev.check('a room layout is never listed in a member scene, and the scene keeps its own layouts', r.status === 200 && fmt(r.json?.layouts) === '["own"]' && is404(r2), `${st(r)} | front?scene= ${r2.status}`)
r = await C.get(`/api/layouts?room=${A}`)
ev.check('…and the scene\'s own layout is not listed in the room', fmt(r.json?.layouts) === '["front"]', fmt(r.json?.layouts))
for (const [what, m, p, body, want] of [
  ['GET with both scene and room → 400', 'GET', `/api/layouts?scene=${LW}&room=${A}`, null, 400],
  ['GET with neither → 400', 'GET', '/api/layouts', null, 400],
  ['PUT with both → 400', 'PUT', `/api/layouts/x?scene=${LW}&room=${A}`, { items: [] }, 400],
  ['PUT with neither → 400', 'PUT', '/api/layouts/x', { items: [] }, 400],
  ['GET for an unknown room → 404', 'GET', `/api/layouts?room=${NO_ROOM}`, null, 404],
  ['PUT for an unknown room → 404', 'PUT', `/api/layouts/x?room=${NO_ROOM}`, { items: [] }, 404],
  ['GET one layout for an unknown room → 404', 'GET', `/api/layouts/front?room=${NO_ROOM}`, null, 404],
  ['PUT a layout name that is not a slug → 400', 'PUT', `/api/layouts/Bad?room=${A}`, { items: [] }, 400],
  ['GET an absent room layout → 404', 'GET', `/api/layouts/nope?room=${A}`, null, 404],
  ['DELETE an absent room layout → 404', 'DELETE', `/api/layouts/nope?room=${A}`, null, 404],
  ['a forged PUT (W1) → 403', 'PUT', `/api/layouts/x?room=${A}`, { items: [] }, 403],
  ['a forged DELETE (W1) → 403', 'DELETE', `/api/layouts/front?room=${A}`, null, 403],
]) {
  r = m === 'GET' ? await C.get(p) : await C.send(m, p, body, what.includes('forged') ? { forged: true } : {})
  ev.check(`layouts: ${what}`, (want !== 404 || UP) && r.status === want, st(r))
}
r = await C.get(`/api/rooms/${A}`)
ev.check('the room detail counts its layouts (1), and the list says the same', r.json?.layouts === 1 && (await C.get('/api/rooms')).json?.rooms?.find((x) => x.name === A)?.layouts === 1, fmt(r.json?.layouts))
r = await C.send('DELETE', `/api/layouts/front?room=${A}`)
const trashRe = new RegExp(`^${path.basename(LDIR)}/@${A}/\\.trash/front-\\d{8}-\\d{6}(-\\d+)?\\.json$`)
ev.check('DELETE /api/layouts/front?room= → 200 {ok, name, room, trash: layouts/@<room>/.trash/front-<stamp>.json}', r.status === 200 && r.json?.ok === true && r.json?.room === A && r.json?.name === 'front' && !('scene' in (r.json || {})) && trashRe.test(r.json?.trash || ''), st(r))
ev.check('…the file moved there; the room has no layouts', fs.existsSync(path.join(path.dirname(LDIR), r.json?.trash || '-')) && !fs.existsSync(lfile) && (await C.get(`/api/layouts?room=${A}`)).json?.layouts?.length === 0, r.json?.trash)
r = await C.send('PUT', `/api/layouts/front?room=${A}`, lj || { items: [ITEM] })
ev.check('Undo: PUT the layout back as read → 200', r.status === 200 && fs.existsSync(lfile), st(r))
const layoutBytes = fs.existsSync(lfile) ? fs.readFileSync(lfile) : null

ev.section('PUT: rescale (Set scale)')
await put(A, { members: [{ scene: LW }, { scene: R1, pose: pose(1, 2, 30), scale: 1.1 }] })
r = await put(A, { rescale: 2 })
ev.check('rescale 2: every scale and pose position × 2, yaw and pose_source unchanged (origin stays {0,0,0})',
  r.status === 200 && poseEq(memberOf(r.json, R1)?.pose, pose(2, 4, 30), 1e-9) && Math.abs(memberOf(r.json, R1)?.scale - 2.2) < 1e-9 && memberOf(r.json, R1)?.pose_source === 'manual'
  && poseEq(memberOf(r.json, LW)?.pose, ZERO) && memberOf(r.json, LW)?.scale === 2 && memberOf(r.json, LW)?.pose_source === 'origin', fmt(r.json?.members?.map(({ scene, pose, scale, pose_source }) => ({ scene, pose, scale, pose_source }))))
ev.check('…and no layout is rewritten', layoutBytes && fs.readFileSync(lfile).equals(layoutBytes), 'compared bytes')
r = await put(A, { rescale: 100 })
ev.check('rescale 100 clamps: x_m, z_m to 50, scale to 4', r.status === 200 && poseEq(memberOf(r.json, R1)?.pose, pose(50, 50, 30), 1e-9) && memberOf(r.json, R1)?.scale === 4 && memberOf(r.json, LW)?.scale === 4, fmt(memberOf(r.json, R1)))
await put(A, { members: [{ scene: LW, scale: 1 }, { scene: R1, pose: null, scale: 1 }] })

// --- align ----------------------------------------------------------------------------------------------------------------------------
ev.section('align (§4.9 Align): refusals')
r = await C.send('POST', `/api/rooms/${Bm}/align`)
ev.check('a room with fewer than two members that have a photo → 409', r.status === 409, st(r))
for (const [what, args, want] of [
  ['no X-Midstudy (W1) → 403', [null, { forged: true }], 403],
  ['a foreign Origin (W1) → 403', [null, { headers: EVIL }], 403],
  ['an unknown key → 400', [{ colour: 'red' }], 400],
  ['a solver that is not a slug → 400', [{ solver: 'Bad Solver' }], 400],
  ['overwrite_manual not a boolean → 400', [{ overwrite_manual: 'yes' }], 400],
]) { r = await C.send('POST', `/api/rooms/${A}/align`, ...args); ev.check(`POST …/align: ${what}`, (want !== 404 || UP) && r.status === want, st(r)) }
r = await C.send('POST', `/api/rooms/${NO_ROOM}/align`)
ev.check('POST …/align for an unknown room → 404', is404(r), st(r))
r = await C.get('/api/rooms/jobs')
ev.check('…none of them queued a job (GET /api/rooms/jobs → 200 {jobs: []})', r.status === 200 && r.json?.jobs?.length === 0, st(r))

ev.section('align: the golden pair through the mock')
const argvOf = (room) => calls().filter((c) => c.argv[0] === 'align-room' && c.argv.some((a) => path.resolve(REPO, a) === path.join(ROOMS, room))).map((c) => c.argv)
const dirOf = (scene) => path.join(srv.dirs.scenes, scene)
const abs = (p) => (p ? path.resolve(REPO, p) : p)
const align = async (room, body) => {
  const a = await C.send('POST', `/api/rooms/${room}/align`, body)
  const job = a.json?.job
  const done = job?.id ? await waitJob(B, job.id) : null
  return { a, job, done, detail: await get(room) }
}
let al = await align(A)
ev.check('POST /api/rooms/<room>/align → 202 {job}: id a-…, kind align, the room, waiting_for a list, align null', al.a.status === 202 && ALIGN_JOB_RE.test(al.job?.id || '') && al.job?.kind === 'align' && al.job?.room === A && Array.isArray(al.job?.waiting_for) && al.job?.align === null, st(al.a))
ev.check('the job ends done; its align is the answer (align.schema.json)', al.done?.status === 'done' && al.done?.align && !fileViolation('midstudy/align.schema.json', al.done.align), fmt({ status: al.done?.status, message: al.done?.message }))
d = al.detail
ev.check('the solver\'s true pose is applied: room-1 at (−1.15, 0.45, −22°), pose_source solver, scale 1', poseEq(memberOf(d, R1)?.pose, PAIR_TRUE, 1e-6, 1e-6) && memberOf(d, R1)?.pose_source === 'solver' && memberOf(d, R1)?.scale === 1, fmt(memberOf(d, R1)))
ev.check('the origin keeps {0, 0, 0}, origin', poseEq(memberOf(d, LW)?.pose, ZERO) && memberOf(d, LW)?.pose_source === 'origin', fmt(memberOf(d, LW)))
ev.check('aligned = {solver: truth, finished}; align_status done; align_error null; saved stamped', d?.aligned?.solver === 'truth' && ISO_RE.test(d?.aligned?.finished || '') && d?.align_status === 'done' && d?.align_error === null && ISO_RE.test(d?.saved || ''), fmt({ aligned: d?.aligned, status: d?.align_status, saved: d?.saved }))
const aj = readJson(path.join(ROOMS, A, 'align.json'))
ev.check('rooms/<room>/align.json (written by align-room) validates, names the scenes as the server calls them, with their photo SHA-256s; the detail\'s align is that file',
  aj && !fileViolation('midstudy/align.schema.json', aj) && fmt(aj.members?.map((m) => m.scene)) === fmt([LW, R1]) && aj.members?.[0]?.photo_sha256 === SHA['living-wide'] && aj.members?.[1]?.photo_sha256 === SHA['room-1'] && fmt(d?.align) === fmt(aj) && !('ok' in aj),
  aj ? fileViolation('midstudy/align.schema.json', aj) || fmt(aj.members?.map((m) => [m.scene, m.photo_sha256?.slice(0, 8)])) : 'no align.json')
let argv = argvOf(A).at(-1) || []
ev.check('align-room ran on the calibration command: align-room <scenes>/<anchor> <scenes>/<other> --out <rooms>/<room>', argv[0] === 'align-room' && abs(argv[1]) === dirOf(LW) && abs(argv[2]) === dirOf(R1) && abs(argv[argv.indexOf('--out') + 1]) === path.join(ROOMS, A), fmt(argv))
r = await C.get('/api/rooms/jobs')
const r3 = await C.get('/api/scenes/jobs')
ev.check('GET /api/rooms/jobs lists it (newest first); /api/scenes/jobs does not', r.status === 200 && r.json?.jobs?.[0]?.id === al.job?.id && !(r3.json?.jobs || []).some((j) => j.id === al.job?.id), `${r.json?.jobs?.map((j) => j.id)} | scenes: ${(r3.json?.jobs || []).filter((j) => j.id?.startsWith('a-')).length} a- jobs`)
r = await C.get(`/api/rooms/jobs/${al.job?.id}`)
ev.check('GET /api/rooms/jobs/<id> → 200 the job; an unknown id → 404', r.status === 200 && r.json?.id === al.job?.id && is404(await C.get('/api/rooms/jobs/a-00000000-000000-zzzz')), st(r))

ev.section('align: the anchor, manual poses, scales')
const A0 = pose(1, 2, 30)
await put(A, { members: [{ scene: LW, pose: A0 }, { scene: R1 }] })
al = await align(A)
let exp = applyAnchor(A0, 1, PAIR_TRUE, 1)
ev.check('a manual first member is the anchor: room-1 = anchor ∘ answer (yaw_a + yaw_k, (x_a, z_a) + s_a·Ry(yaw_a)·(x_k, z_k))', al.done?.status === 'done' && poseEq(memberOf(al.detail, R1)?.pose, exp.pose, 1e-6, 1e-6) && memberOf(al.detail, R1)?.pose_source === 'solver',
  `got ${fmtPose(memberOf(al.detail, R1)?.pose)} want ${fmtPose(exp.pose)}`)
ev.check('…and the manual anchor keeps its pose and pose_source', poseEq(memberOf(al.detail, LW)?.pose, A0, 1e-9) && memberOf(al.detail, LW)?.pose_source === 'manual', fmt(memberOf(al.detail, LW)))
await put(A, { members: [{ scene: LW, scale: 1.5 }, { scene: R1 }] })
al = await align(A)
exp = applyAnchor(A0, 1.5, PAIR_TRUE, 1)
ev.check('the anchor\'s scale 1.5 scales the answer: room-1\'s position offset × 1.5 and its scale 1.5', poseEq(memberOf(al.detail, R1)?.pose, exp.pose, 1e-6, 1e-6) && Math.abs(memberOf(al.detail, R1)?.scale - 1.5) < 1e-9,
  `got ${fmtPose(memberOf(al.detail, R1)?.pose)} × ${memberOf(al.detail, R1)?.scale} want ${fmtPose(exp.pose)} × ${exp.scale}`)
await put(A, { members: [{ scene: R1, pose: null, scale: 1 }, { scene: LW, pose: pose(0, 0, 0), scale: 1 }] })
al = await align(A)
argv = argvOf(A).at(-1) || []
ev.check('the anchor goes first even when it isn\'t first in the room: align-room <living-wide> <room-1>', abs(argv[1]) === dirOf(LW) && abs(argv[2]) === dirOf(R1), fmt(argv.slice(1, 3).map((p) => path.basename(p))))
ev.check('…and room-1 lands at its true pose (anchor at {0, 0, 0}, manual)', poseEq(memberOf(al.detail, R1)?.pose, PAIR_TRUE, 1e-6, 1e-6) && memberOf(al.detail, R1)?.pose_source === 'solver' && memberOf(al.detail, LW)?.pose_source === 'manual', fmt(al.detail?.members))
await put(A, { members: [{ scene: LW }, { scene: R1, pose: pose(3, 3, 3) }] })
al = await align(A)
ev.check('a manual member is not overwritten by an align', poseEq(memberOf(al.detail, R1)?.pose, pose(3, 3, 3), 1e-9) && memberOf(al.detail, R1)?.pose_source === 'manual', fmt(memberOf(al.detail, R1)))
al = await align(A, { overwrite_manual: true, solver: 'manhattan' })
ev.check('…unless overwrite_manual: room-1 takes the answer (solver)', poseEq(memberOf(al.detail, R1)?.pose, PAIR_TRUE, 1e-6, 1e-6) && memberOf(al.detail, R1)?.pose_source === 'solver', fmt(memberOf(al.detail, R1)))
argv = argvOf(A).at(-1) || []
ev.check('the request\'s solver reaches align-room as --solver <name>', argv[argv.indexOf('--solver') + 1] === 'manhattan', fmt(argv))

ev.section('PUT reset (Align photos\' Reset)')
await put(A, { members: [{ scene: LW }, { scene: R1, pose: pose(3, 3, 3) }] })
r = await put(A, { reset: [R1] })
ev.check('reset: [room-1] puts the manual photo back to align.json\'s answer, pose_source solver', r.status === 200 && poseEq(memberOf(r.json, R1)?.pose, PAIR_TRUE, 1e-6, 1e-6) && memberOf(r.json, R1)?.pose_source === 'solver', fmt(memberOf(r.json, R1)))
const ajPath = path.join(ROOMS, A, 'align.json'), ajKeep = fs.existsSync(ajPath) ? fs.readFileSync(ajPath) : null
if (ajKeep) {
  const stale = JSON.parse(ajKeep)
  stale.members[1].photo_sha256 = '0'.repeat(64)
  fs.writeFileSync(ajPath, JSON.stringify(stale, null, 2))
  r = await put(A, { reset: [R1] })
  ev.check('reset of a member whose photo_sha256 in align.json is another photo\'s → unplaced', r.status === 200 && memberOf(r.json, R1)?.pose === null && memberOf(r.json, R1)?.pose_source === 'unplaced', fmt(memberOf(r.json, R1)))
  fs.writeFileSync(ajPath, ajKeep)
  await put(A, { reset: [R1] })
} else ev.check('reset of a stale answer', false, 'no align.json to make stale')

ev.section('align: waiting for a member that is still calibrating; a mock miss')
closeGate()
const up6 = await uploadScene(B, fs.readFileSync(golden('room-6').photo), { filename: 'room-6.jpg', title: 'room-6' })
const R6 = up6.json?.scene
await waitFor(async () => (await C.get(`/api/scenes/${R6}`)).json?.calib_status === 'running', { timeoutMs: 15000 })
r = await C.send('POST', '/api/rooms', { title: 'Gated', scenes: [R5, R3, R6] })
const G = r.json?.name || 'room-missing-g'
ev.check('a room may hold a scene that is still calibrating → 201', r.status === 201 && memberOf(r.json, R6)?.scene_object?.calib_status !== 'done', st(r))
const ga = await C.send('POST', `/api/rooms/${G}/align`)
const gj = ga.json?.job
await sleep(600)
let gjNow = (await C.get(`/api/rooms/jobs/${gj?.id}`)).json
ev.check('POST …/align → 202; the job stays queued and lists the calibrating member in waiting_for', ga.status === 202 && gjNow?.status === 'queued' && fmt(gjNow?.waiting_for) === fmt([R6]), fmt({ status: gjNow?.status, waiting_for: gjNow?.waiting_for, http: ga.status }))
ev.check('the room says align_status pending meanwhile', (await get(G))?.align_status === 'pending', (await get(G))?.align_status)
r = await C.send('POST', `/api/rooms/${G}/align`)
ev.check('a second POST …/align while one is queued → 409', r.status === 409, st(r))
openGate()
const gdone = gj?.id ? await waitJob(B, gj.id, 60000) : null
d = await get(G)
argv = argvOf(G).at(-1) || []
ev.check('once room-6 is calibrated the job runs, on all three members (anchor first), and ends done', gdone?.status === 'done' && abs(argv[1]) === dirOf(R5) && argv.slice(1, 4).map((p) => path.basename(p)).sort().join() === [R5, R3, R6].sort().join(), fmt({ status: gdone?.status, message: gdone?.message, argv: argv.map((p) => path.basename(p)) }))
ev.check('a mock miss: aligned.solver none, the anchor stays origin, the others unplaced, align_status done', d?.aligned?.solver === 'none' && d?.align?.solver === 'none' && memberOf(d, R5)?.pose_source === 'origin' && memberOf(d, R3)?.pose_source === 'unplaced' && memberOf(d, R6)?.pose_source === 'unplaced' && d?.align_status === 'done',
  fmt({ aligned: d?.aligned, members: d?.members?.map((m) => [m.scene, m.pose_source]) }))
r = await put(G, { reset: [R5, R3] })
ev.check('reset leaves an origin member as it is, and makes a member align.json doesn\'t place unplaced', r.status === 200 && memberOf(r.json, R5)?.pose_source === 'origin' && poseEq(memberOf(r.json, R5)?.pose, ZERO) && memberOf(r.json, R3)?.pose_source === 'unplaced', fmt(r.json?.members?.map((m) => [m.scene, m.pose_source])))

// --- delete and restore rooms ---------------------------------------------------------------------------------------------------
ev.section('DELETE and restore a room (§4.9)')
await C.send('PUT', `/api/layouts/c1?room=${C1}`, { items: [ITEM] })
for (const [what, o, want] of [['no X-Midstudy (W1) → 403', { forged: true }, 403], ['a foreign Origin (W1) → 403', { headers: EVIL }, 403]]) {
  r = await C.send('DELETE', `/api/rooms/${C1}`, null, o); ev.check(`DELETE: ${what}`, (want !== 404 || UP) && r.status === want, st(r))
}
r = await C.send('DELETE', `/api/rooms/${NO_ROOM}`)
ev.check('DELETE an unknown room → 404', is404(r), st(r))
r = await C.send('DELETE', `/api/rooms/${C1}`)
const tr = r.json?.trash || ''
ev.check('DELETE → 200 {ok, trash: "rooms/.trash/<room>-<stamp>"} (the rooms folder as it is called)', r.status === 200 && r.json?.ok === true && new RegExp(`^${path.basename(ROOMS)}/\\.trash/${C1}-\\d{8}-\\d{6}(-\\d+)?$`).test(tr), st(r))
const trDir = path.join(DATA, tr)
const tj = readJson(path.join(trDir, 'trash.json'))
ev.check('the trash holds room.json, trash.json (trash.schema.json RoomTrash) and layouts/c1.json; rooms/<room> and layouts/@<room> are gone',
  fs.existsSync(path.join(trDir, 'room.json')) && tj && !fileViolation('midstudy/trash.schema.json#/$defs/room', tj) && tj.name === C1 && fs.existsSync(path.join(trDir, 'layouts', 'c1.json'))
  && !fs.existsSync(path.join(ROOMS, C1)) && !fs.existsSync(path.join(LDIR, `@${C1}`)), tj ? fileViolation('midstudy/trash.schema.json#/$defs/room', tj) || fmt(tj) : `no trash.json in ${tr}`)
r = await C.get('/api/rooms')
ev.check('GET /api/rooms lists it under trash {name, title, created, deleted}; not in rooms; GET it → 404', r.json?.trash?.some((t) => t.name === C1 && t.title === 'C one' && ISO_RE.test(t.deleted || '')) && !r.json?.rooms?.some((x) => x.name === C1) && is404(await C.get(`/api/rooms/${C1}`)), fmt(r.json?.trash))
ev.check('its scene is not deleted and is in no room', (await C.get(`/api/scenes/${LC}`)).status === 200 && (await sceneRoom(LC)) === null, fmt(await sceneRoom(LC)))
for (const [what, o, want] of [['no X-Midstudy (W1) → 403', { forged: true }, 403], ['a foreign Origin (W1) → 403', { headers: EVIL }, 403]]) {
  r = await C.send('POST', `/api/rooms/${C1}/restore`, null, o); ev.check(`restore: ${what}`, (want !== 404 || UP) && r.status === want, st(r))
}
r = await C.send('POST', `/api/rooms/${C1}/restore`)
ev.check('POST …/restore → 200 the room object: its member back, its layouts back', r.status === 200 && r.json?.name === C1 && fmt(r.json?.members?.map((m) => m.scene)) === fmt([LC]) && fs.existsSync(path.join(LDIR, `@${C1}`, 'c1.json')) && r.json?.layouts === 1, st(r))
ev.check('…its scene says room = the room again; the trash no longer lists it', (await sceneRoom(LC)) === C1 && !(await C.get('/api/rooms')).json?.trash?.some((t) => t.name === C1), fmt(await sceneRoom(LC)))
r = await C.send('POST', `/api/rooms/${C1}/restore`)
ev.check('restore with nothing in the trash → 404', is404(r), st(r))
r = await C.send('DELETE', `/api/rooms/${C1}`)
const tr2 = path.join(DATA, r.json?.trash || '-')
fs.mkdirSync(path.join(ROOMS, C1), { recursive: true })
if (fs.existsSync(path.join(tr2, 'room.json'))) fs.copyFileSync(path.join(tr2, 'room.json'), path.join(ROOMS, C1, 'room.json'))
r = await C.send('POST', `/api/rooms/${C1}/restore`)
ev.check('restore while a room by that name exists → 409', r.status === 409, st(r))
fs.rmSync(path.join(ROOMS, C1), { recursive: true, force: true })
r = await C.send('DELETE', `/api/scenes/${LC}`)
r = await C.send('POST', `/api/rooms/${C1}/restore`)
ev.check('restore drops a member whose scene was deleted meanwhile (the room comes back empty)', r.status === 200 && r.json?.members?.length === 0, st(r))
r = await C.send('POST', `/api/scenes/${LC}/restore`)
ev.check('…and that scene, restored, comes back in no room', r.status === 200 && r.json?.room === null, st(r))
await C.send('DELETE', `/api/rooms/${C2}`)
r = await C.send('POST', '/api/rooms', { title: 'D', scenes: [LWm] })
const D = r.json?.name || 'room-missing-d'
r = await C.send('POST', `/api/rooms/${C2}/restore`)
ev.check('restore drops a member that is now in another room', r.status === 200 && r.json?.members?.length === 0 && (await sceneRoom(LWm)) === D, st(r))
await C.send('DELETE', `/api/rooms/${D}`)

ev.section('a failing align-room, and strict mode')
await put(Bm, { members: [{ scene: R2 }, { scene: LC }] })
const bBefore = fmt(roomJson(Bm)?.members)
al = await align(Bm)
d = al.detail
ev.check('align-room failing (the answer leaves the anchor unplaced) → job failed with its sentence, align_status failed, align_error set', al.done?.status === 'failed' && d?.align_status === 'failed' && typeof d?.align_error === 'string' && d.align_error.length > 5,
  fmt({ status: al.done?.status, message: al.done?.message, align_status: d?.align_status, align_error: d?.align_error }))
ev.check('…and room.json\'s members are unchanged, aligned still null', fmt(roomJson(Bm)?.members) === bBefore && roomJson(Bm)?.aligned === null, fmt(roomJson(Bm)?.members))
await put(Bm, { members: [{ scene: R2 }, { scene: LWm }] })
const b2 = fmt(roomJson(Bm)?.members)
const sa = await C.send('POST', `/api/rooms/${Bm}/align`)
const sdone = sa.json?.job?.id ? await waitJob(B, sa.json.job.id) : null
ev.check('an answer that breaks align.schema.json (confidence 2) fails the job in strict mode ("contract violation"), nothing applied',
  sdone?.status === 'failed' && /contract violation/i.test(sdone?.message || '') && fmt(roomJson(Bm)?.members) === b2 && roomJson(Bm)?.aligned === null, fmt({ http: sa.status, status: sdone?.status, message: sdone?.message }))
// The stub writes what the mock holds (only the real CLI validates before writing): drop the invalid file, so the
// room's detail stays readable for the rest of the eval.
fs.rmSync(path.join(ROOMS, Bm || '-', 'align.json'), { force: true })

// --- a scene deleted inside a room ---------------------------------------------------------------------------------------------
ev.section('DELETE /api/scenes/<member> and restore (§4.4, §4.9 Membership)')
d = await get(A)
const memberR1 = d ? (({ scene, pose, scale, pose_source }) => ({ scene, pose, scale, pose_source }))(memberOf(d, R1) || {}) : null
r = await C.send('DELETE', `/api/scenes/${R1}`)
const sTrash = path.join(path.dirname(srv.dirs.scenes), r.json?.trash || '-')
const stj = readJson(path.join(sTrash, 'trash.json'))
ev.check('deleting a member scene → 200; the room loses it', r.status === 200 && fmt((await get(A))?.members?.map((m) => m.scene)) === fmt([LW]), st(r))
ev.check('the scene trash\'s trash.json records room {name, index 1, member} (trash.schema.json SceneTrash)', stj && !fileViolation('midstudy/trash.schema.json#/$defs/scene', stj) && stj.room?.name === A && stj.room?.index === 1 && fmt(stj.room?.member) === fmt(memberR1),
  stj ? fileViolation('midstudy/trash.schema.json#/$defs/scene', stj) || fmt(stj.room) : `no trash.json in ${r.json?.trash}`)
r = await C.send('POST', `/api/scenes/${R1}/restore`)
d = await get(A)
ev.check('restoring it puts it back at its index with the same pose and pose_source; its scene object says room', r.status === 200 && r.json?.room === A && d?.members?.[1]?.scene === R1 && poseEq(d.members[1].pose, memberR1?.pose) && d.members[1].pose_source === memberR1?.pose_source, fmt({ http: r.status, room: r.json?.room, members: d?.members?.map((m) => [m.scene, m.pose_source]) }))
await C.send('DELETE', `/api/scenes/${R1}`)
await C.send('DELETE', `/api/rooms/${A}`)
r = await C.send('POST', `/api/scenes/${R1}/restore`)
ev.check('restoring a member whose room is in the trash brings the scene back alone (room null)', r.status === 200 && r.json?.room === null, st(r))
r = await C.send('POST', `/api/rooms/${A}/restore`)
ev.check('restoring that room keeps its other members and its layouts', r.status === 200 && fmt(r.json?.members?.map((m) => m.scene)) === fmt([LW]) && r.json?.layouts === 1, st(r))
for (const s of [R5, R3, R6]) await C.send('DELETE', `/api/scenes/${s}`)
r = await C.get(`/api/rooms/${G}`)
ev.check('a room whose every member was deleted stays, with no members', r.status === 200 && r.json?.members?.length === 0, st(r))

// --- render in a room --------------------------------------------------------------------------------------------------------------
ev.section('POST /api/render with room (§4.7 Room)')
const img = dataUri('image/jpeg', fs.readFileSync(golden('living-wide').photo))
r = await C.send('POST', '/api/render', { image: img, model: 'nano-banana', room: A, scene: LW, layout: 'front' })
ev.check('a render in a room → 200: meta room = the room, scene = the photo, layout, reference true, $0 mock', r.status === 200 && r.json?.room === A && r.json?.scene === LW && r.json?.layout === 'front' && r.json?.reference === true && r.json?.mock === true && r.json?.cost_usd === 0, st(r))
const rname = r.json?.name
for (const [what, body, want] of [
  ['room without scene → 400', { image: img, room: A }, 400],
  ['a scene that is not a member → 400', { image: img, room: A, scene: R2 }, 400],
  ['an unknown room → 404', { image: img, room: NO_ROOM, scene: LW }, 404],
]) { r = await C.send('POST', '/api/render', body); ev.check(`render: ${what}`, (want !== 404 || UP) && r.status === want, st(r)) }
r = await C.send('POST', '/api/render', { image: img, room: A, scene: LW }, { forged: true })
ev.check('render with room, forged (W1) → 403', r.status === 403, st(r))
r = await C.get(`/api/renders?room=${A}`)
const rs = await C.get(`/api/renders?scene=${LW}`)
ev.check('GET /api/renders?room= lists it; ?scene=<the photo> lists it too', r.status === 200 && r.json?.renders?.some((x) => x.name === rname) && r.json.renders.every((x) => x.room === A) && rs.json?.renders?.some((x) => x.name === rname), `${r.json?.renders?.map((x) => x.name)} | scene: ${rs.json?.renders?.map((x) => x.name)}`)
r = await C.send('POST', '/api/render', { image: img, model: 'nano-banana', scene: LW })
ev.check('a render without room has no room in its meta (present exactly when the request named one)', r.status === 200 && !('room' in (r.json || {})), st(r))

// --- the contract ------------------------------------------------------------------------------------------------------------------
ev.section('strict mode and the contract')
ev.check('every answer matched contract/api/routes.json (the generated validators)', C.violations.length === 0, C.violations.slice(0, 6).join(' | ') || 'all conform')
ev.check('the server never answered 5xx (strict mode turns its own contract violations into 500s)', C.fiveXX.length === 0, C.fiveXX.slice(0, 4).join(' | ') || 'none')
for (const f of roomFolders()) {
  const j = roomJson(f)
  if (!ev.check(`rooms/${f}/room.json validates`, j && !fileViolation('midstudy/room.schema.json', j), j ? fileViolation('midstudy/room.schema.json', j) || 'ok' : 'missing')) break
}
await ev.finish()
