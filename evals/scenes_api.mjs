// E1 eval:scenes-api — the scenes API of the server (PLAN.md §6.2 E1; contract §4.4, §2.7, §2.9). No browser.
// Upload → 202, listed pending, calibrates (calib stub + MIDSTUDY_CALIB_MOCK), photo.jpg ≤ 2048, the scene has the
// camera; PUT camera round-trips; calibrate; delete moves to the trash; layouts per scene don't leak; static rules;
// W1 (forged), W2 (Host), W4 (paths) on every new route; the spend cap covers /api/render. fal mocked, $0.
// Lighting (§4.8): the look keys (clamps, booleans, null removes, merge, 400s), GET's lighting / lighting_status /
// lighting_error, and the backfill (POST …/light: a light job that writes lighting.json only, idempotent, never touching
// calib.json, depth.png, scene.json or calib_status; a mock miss gives "none", a failure "failed", 409 while calibrating).
// Calibration runs through evals/lib/gated_calib.py (→ fixtures/stub_calib.py), which holds a job in "running"
// while its gate file is missing, so "pending" and the one-at-a-time queue can be observed.
// Usage: node evals/scenes_api.mjs   (or npm run eval:scenes-api). Output: evals/out/scenes-api/.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  REPO, DEFAULT_CAMERA, SCENE_NAME_RE, createEval, startServer, api, raw, uploadScene, waitFor, waitScene, golden, fmt, clip,
  camEq, dataUri, sleep, serverCommand,
} from './lib/harness.mjs'

const ev = createEval('E1', 'scenes-api', { timeoutS: 300 })
const ajv = new Ajv2020({ allErrors: true, strict: false })
ajv.addFormat('date-time', /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/)
const schema = (n) => ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO, 'contract', n), 'utf8')))
const vScene = schema('scene.schema.json'), vCalib = schema('calib.schema.json'), vLayout = schema('layout.schema.json')
const errs = (v) => (v.errors || []).map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ')
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]00:?00)$/
const GATE = path.join(ev.out, 'calib-gate')
const CALLOG = path.join(ev.out, 'calib-calls.jsonl')
const openGate = () => fs.writeFileSync(GATE, 'open')
const closeGate = () => fs.rmSync(GATE, { force: true })
const calls = () => (fs.existsSync(CALLOG) ? fs.readFileSync(CALLOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
const LIVING = golden('living-wide'), PORTRAIT = golden('portrait')
const livingBytes = fs.readFileSync(LIVING.photo), portraitBytes = fs.readFileSync(PORTRAIT.photo)
const st = (r) => `${r.status || r.error}${r.json ? ` ${clip(fmt(r.json), 220)}` : r.text ? ` ${clip(r.text, 120)}` : ''}`
// deep equality that ignores key order
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])])) : v)
const same = (a, b) => a !== undefined && JSON.stringify(canon(a)) === JSON.stringify(canon(b))

// --- server ---------------------------------------------------------------------------------------------------------------
closeGate()
const srv = await startServer(ev, {
  calib: `python3 ${path.join(REPO, 'evals/lib/gated_calib.py')}`,
  env: { MIDSTUDY_EVAL_CALIB_GATE: GATE, MIDSTUDY_EVAL_CALIB_LOG: CALLOG, MIDSTUDY_EVAL_CALIB_TARGET: `python3 ${path.join(REPO, 'fixtures/stub_calib.py')}` },
})
ev.check('the server starts with --scenes-dir, --calib and scratch dirs', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const B = srv.base
const scenesDir = srv.dirs.scenes
const sceneFolders = () => fs.readdirSync(scenesDir).filter((n) => !n.startsWith('.')).sort()

ev.section('listing and upload (§4.4)')
let r = await api.get(B, '/api/scenes')
ev.check('GET /api/scenes on an empty dir is 200 {"scenes": []}', r.status === 200 && Array.isArray(r.json?.scenes) && r.json.scenes.length === 0, st(r))
if (r.status === 404) ev.note('the scenes API is not there yet: the remaining checks will fail for that reason')

const upA = await uploadScene(B, livingBytes, { filename: 'living-wide.jpg', title: 'Lounge A' })
const A = upA.json?.scene
ev.check('POST /api/scenes (JPEG, title in X-Midstudy-Meta) → 202 {job, scene}', upA.status === 202 && typeof A === 'string' && upA.json?.job?.id, st(upA))
ev.check('the scene name is scene-YYYYMMDD-HHMMSS', SCENE_NAME_RE.test(A || ''), A)
const jobA = upA.json?.job || {}
ev.check('the job is {id: c-…, kind: calibrate, scene}', /^c-/.test(jobA.id || '') && jobA.kind === 'calibrate' && jobA.scene === A && ['queued', 'running'].includes(jobA.status), fmt(jobA))
await sleep(1100) // a later created second, so "newest first" is unambiguous
const upB = await uploadScene(B, portraitBytes, { filename: 'portrait.jpg' })
const Bn = upB.json?.scene
ev.check('a second upload (no meta) → 202', upB.status === 202 && typeof Bn === 'string' && Bn !== A, st(upB))
// two uploads in the same second get -2 (contract §4.2)
// Start early in a fresh second: the upload above may have taken the current one, and then these would be -2 and -3.
await sleep(1000 - (Date.now() % 1000) + 10)
const upX1 = await uploadScene(B, livingBytes, { filename: 'x1.jpg' }), upX2 = await uploadScene(B, livingBytes, { filename: 'x2.jpg' })
const X1 = upX1.json?.scene, X2 = upX2.json?.scene
ev.check('two uploads in the same second: the second name gets -2', upX1.status === 202 && upX2.status === 202 && X1 && X2 === `${X1}-2`, `${X1} ${X2}`)

r = await api.get(B, '/api/scenes')
const list1 = r.json?.scenes || []
const byName = Object.fromEntries(list1.map((s) => [s.name, s]))
ev.check('all four are listed, newest first', list1.length === 4 && list1.at(-1)?.name === A && list1.findIndex((s) => s.name === Bn) < list1.findIndex((s) => s.name === A), list1.map((s) => s.name))
const sa = byName[A] || {}
ev.check('A is listed while its job waits: calib_status pending or running', ['pending', 'running'].includes(sa.calib_status), `calib_status ${sa.calib_status}`)
ev.check('B, queued behind A (one at a time), is pending', byName[Bn]?.calib_status === 'pending', `calib_status ${byName[Bn]?.calib_status}`)
ev.check("before calibration: title from the meta, photo_url/w/h/floor_found/depth_url/thumb_url null, default camera_source, 0 layouts",
  sa.title === 'Lounge A' && sa.photo_url === null && sa.w === null && sa.h === null && sa.floor_found === null && sa.depth_url === null && sa.thumb_url === null
  && sa.camera_source === 'default' && sa.layouts === 0 && ISO.test(sa.created || '') && sa.saved === null, fmt(sa))
ev.check('B without meta has title null', byName[Bn]?.title === null, fmt(byName[Bn]?.title))
const sjA = path.join(scenesDir, A || '_', 'scene.json')
const sjA0 = fs.existsSync(sjA) ? JSON.parse(fs.readFileSync(sjA, 'utf8')) : null
ev.check('scenes/<A>/scene.json exists at once and validates (version, default camera, upload {filename, ext, bytes})',
  sjA0 && vScene(sjA0) && camEq(sjA0.camera, DEFAULT_CAMERA) && sjA0.camera_source === 'default' && sjA0.upload?.filename === 'living-wide.jpg'
  && sjA0.upload?.ext === 'jpg' && sjA0.upload?.bytes === livingBytes.length, sjA0 ? `${fmt(sjA0)} ${errs(vScene)}` : 'missing')
r = await api.get(B, '/api/scenes/jobs')
const jobs1 = r.json?.jobs || []
ev.check('GET /api/scenes/jobs lists the jobs newest first; A running or queued, B queued', jobs1.length >= 2 && jobs1.at(-1)?.scene === A && jobs1.find((j) => j.scene === Bn)?.status === 'queued',
  jobs1.map((j) => `${j.scene}:${j.status}`))
r = await api.get(B, `/api/scenes/jobs/${jobA.id}`)
ev.check('GET /api/scenes/jobs/<id> is the job object', r.status === 200 && r.json?.id === jobA.id && r.json?.kind === 'calibrate', st(r))
ev.check('GET /api/scenes/jobs/<unknown> is 404', (r = await api.get(B, '/api/scenes/jobs/c-19990101-000000-zzzz')).status === 404, st(r))

// deleting a scene whose job is queued drops the job (contract §4.4)
const dX1 = await api.send(B, 'DELETE', `/api/scenes/${X1}`), dX2 = await api.send(B, 'DELETE', `/api/scenes/${X2}`)
ev.check('DELETE a scene whose calibration is queued → 200', dX1.status === 200 && dX2.status === 200 && dX1.json?.ok === true, `${st(dX1)} | ${st(dX2)}`)

ev.section('calibration finishes (stub + MIDSTUDY_CALIB_MOCK)')
openGate()
const doneA = await waitScene(B, A), doneB = await waitScene(B, Bn)
ev.check('A and B finish: calib_status done', doneA?.calib_status === 'done' && doneB?.calib_status === 'done', `${doneA?.calib_status} ${doneB?.calib_status} ${doneA?.calib_error || ''}`)
const runCalls = calls().filter((c) => c.argv[0] === 'run')
ev.check('the dropped jobs never ran', !runCalls.some((c) => [X1, X2].some((x) => x && c.argv.join(' ').includes(`${path.sep}${x}`))), runCalls.map((c) => path.basename(c.argv.at(-1))))
const cA = runCalls.find((c) => c.argv.join(' ').includes(`${A}`))
const tmp = cA ? path.resolve(cA.cwd, cA.argv[1]) : ''
const served = [scenesDir, srv.dirs.library, srv.dirs.renders, path.join(REPO, 'planner'), path.join(REPO, 'library'), path.join(REPO, 'fixtures')]
ev.check('the server runs `<calib> run <private temp file> --out scenes/<name>`', cA && cA.argv[2] === '--out' && path.resolve(cA.cwd, cA.argv[3]) === path.join(scenesDir, A)
  && !served.some((d) => tmp.startsWith(d + path.sep)), cA ? fmt(cA.argv) : fmt(calls()))
const gA = await api.get(B, `/api/scenes/${A}`)
const a = gA.json || {}
const truthA = LIVING.truth
ev.check('GET /api/scenes/<A>: photo_url, w 1600 × h 1200 (≤ 2048), camera = the calibration, camera_source auto, floor_found, depth_url',
  gA.status === 200 && /^\/scenes\/[^/]+\/photo\.jpg(\?v=[^&]+)?$/.test(a.photo_url || '') && a.w === 1600 && a.h === 1200 && camEq(a.camera, truthA.camera)
  && a.camera_source === 'auto' && a.floor_found === true && /depth\.png/.test(a.depth_url || ''), clip(fmt({ ...a, calib: a.calib ? '…' : a.calib }), 500))
ev.check('GET /api/scenes/<A> merges scene.json (version, created, saved, upload) and calib (calib.json)',
  a.version === 1 && a.created === sa.created && a.saved === null && a.upload?.ext === 'jpg' && a.calib?.source === 'truth' && camEq(a.calib?.camera, truthA.camera) && vCalib(a.calib || {}),
  `version ${a.version} upload ${fmt(a.upload)} calib.source ${a.calib?.source} ${errs(vCalib)}`)
const sjA1 = fs.existsSync(sjA) ? JSON.parse(fs.readFileSync(sjA, 'utf8')) : null
ev.check('scene.json now holds the calibrated camera (camera_source auto) and still validates', sjA1 && vScene(sjA1) && camEq(sjA1.camera, truthA.camera) && sjA1.camera_source === 'auto', fmt(sjA1))
r = await api.get(B, `/api/scenes/jobs/${jobA.id}`)
ev.check('the finished job: status done, started/finished set, a message, calib = calib.json', r.json?.status === 'done' && ISO.test(r.json?.started || '') && ISO.test(r.json?.finished || '')
  && typeof r.json?.message === 'string' && camEq(r.json?.calib?.camera, truthA.camera), clip(fmt(r.json), 300))
let ph = await raw(B, 'GET', a.photo_url || '/none')
ev.check('photo_url is served: image/jpeg, nosniff, the golden bytes (clean JPEG passed through)', ph.status === 200 && /image\/jpeg/.test(ph.headers['content-type'] || '')
  && /nosniff/i.test(ph.headers['x-content-type-options'] || '') && ph.buf.equals(livingBytes), `${ph.status} ${ph.headers['content-type']} ${ph.headers['x-content-type-options']} ${ph.buf.length} bytes`)
const dp = await raw(B, 'GET', a.depth_url || '/none')
ev.check('depth_url is served (image/png, nosniff)', dp.status === 200 && /image\/png/.test(dp.headers['content-type'] || '') && /nosniff/i.test(dp.headers['x-content-type-options'] || ''), `${dp.status} ${dp.headers['content-type']}`)
const gB = await api.get(B, `/api/scenes/${Bn}`)
ev.check('B (portrait) has w 1200 × h 1600 and its own camera', gB.json?.w === 1200 && gB.json?.h === 1600 && camEq(gB.json?.camera, PORTRAIT.truth.camera), fmt({ w: gB.json?.w, h: gB.json?.h, camera: gB.json?.camera }))
ev.check('GET /api/scenes/<unknown> is 404 with an error', (r = await api.get(B, '/api/scenes/scene-19990101-000000')).status === 404 && typeof r.json?.error === 'string', st(r))

ev.section('PUT /api/scenes/<name>')
const manual = { fov_y_deg: 61.5, height_m: 1.52, pitch_deg: -12.5, roll_deg: 1.25 }
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { camera: manual, camera_source: 'manual' })
ev.check('PUT camera + camera_source manual → 200 with the stored scene, saved stamped', r.status === 200 && camEq(r.json?.camera, manual) && r.json?.camera_source === 'manual' && ISO.test(r.json?.saved || ''), st(r))
const saved1 = r.json?.saved
r = await api.get(B, `/api/scenes/${A}`)
const disk = fs.existsSync(sjA) ? JSON.parse(fs.readFileSync(sjA, 'utf8')) : {}
ev.check('the camera round-trips (GET and scene.json)', camEq(r.json?.camera, manual, 1e-9) && camEq(disk.camera, manual, 1e-9) && disk.camera_source === 'manual' && vScene(disk), `${fmt(r.json?.camera)} ${fmt(disk.camera)}`)
await sleep(1100)
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { title: 'Upper lounge' })
ev.check('PUT only the title → 200; saved unchanged', r.status === 200 && r.json?.title === 'Upper lounge' && r.json?.saved === saved1, `${r.status} title ${r.json?.title} saved ${r.json?.saved} (was ${saved1})`)
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { look: { exposure: 1.3, warmth: -0.2 } })
ev.check('PUT look → 200, stored, saved stamped again', r.status === 200 && r.json?.look?.exposure === 1.3 && r.json?.look?.warmth === -0.2 && r.json?.saved !== saved1, `${r.status} ${fmt(r.json?.look)} saved ${r.json?.saved}`)
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { camera: { fov_y_deg: 200, height_m: 9, pitch_deg: -100, roll_deg: 45 } })
ev.check('camera values are clamped (fov 20–110, height 0.2–3.0, pitch −80…30, roll −20…20)', r.status === 200 && camEq(r.json?.camera, { fov_y_deg: 110, height_m: 3, pitch_deg: -80, roll_deg: 20 }), st(r))
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { camera: { fov_y_deg: 1, height_m: 0.01, pitch_deg: 80, roll_deg: -45 } })
ev.check('…and at the low ends', r.status === 200 && camEq(r.json?.camera, { fov_y_deg: 20, height_m: 0.2, pitch_deg: 30, roll_deg: -20 }), st(r))
await api.send(B, 'PUT', `/api/scenes/${A}`, { camera: manual, camera_source: 'manual' })
for (const [label, body] of [['an unknown key', { bogus: 1 }], ['a non-numeric camera value', { camera: { ...manual, fov_y_deg: 'wide' } }], ['an unknown camera_source', { camera_source: 'magic' }], ['a non-object body', [1, 2]]]) {
  r = await api.send(B, 'PUT', `/api/scenes/${A}`, body)
  ev.check(`PUT with ${label} → 400 with an error sentence`, r.status === 400 && typeof r.json?.error === 'string' && r.json.error.length > 5, st(r))
}
r = await api.get(B, `/api/scenes/${A}`)
ev.check('refused PUTs changed nothing', camEq(r.json?.camera, manual, 1e-9) && r.json?.camera_source === 'manual', fmt(r.json?.camera))
ev.check('PUT an unknown scene → 404', (r = await api.send(B, 'PUT', '/api/scenes/scene-19990101-000000', { title: 'x' })).status === 404, st(r))

ev.section('PUT look (§4.8): numbers clamped, booleans, null removes a key, a look merges')
const diskScene = () => { try { return JSON.parse(fs.readFileSync(sjA, 'utf8')) } catch { return {} } }
const fullLook = { exposure: 1.2, warmth: 0.3, contact_shadows: false, auto_light: false, light_azimuth_deg: 45, light_elevation_deg: 30,
  light_softness: 0.4, light_strength: 1.5, ambient: 0.8, cast_shadows: true }
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { look: fullLook })
let gotLook = (await api.get(B, `/api/scenes/${A}`)).json?.look
ev.check('PUT every look key → 200; the PUT answer, GET and scene.json have them as sent; scene.json validates',
  r.status === 200 && same(r.json?.look, fullLook) && same(gotLook, fullLook) && same(diskScene().look, fullLook) && vScene(diskScene()), `${st(r)} ${errs(vScene)}`)
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { look: { ambient: 2 } })
ev.check('a look with one key replaces only that key (merge)', r.status === 200 && same(r.json?.look, { ...fullLook, ambient: 2 }), fmt(r.json?.look))
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { look: { light_azimuth_deg: null, light_elevation_deg: null, light_softness: null, auto_light: true } })
const lookNoDir = { ...fullLook, ambient: 2, auto_light: true }
delete lookNoDir.light_azimuth_deg; delete lookNoDir.light_elevation_deg; delete lookNoDir.light_softness
gotLook = (await api.get(B, `/api/scenes/${A}`)).json?.look
ev.check('null removes a key (GET and scene.json); booleans round-trip as booleans', r.status === 200 && same(gotLook, lookNoDir) && same(diskScene().look, lookNoDir)
  && !('light_azimuth_deg' in (diskScene().look || {})) && diskScene().look?.auto_light === true && diskScene().look?.contact_shadows === false && vScene(diskScene()), fmt(gotLook))
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { look: { light_azimuth_deg: 400, light_elevation_deg: 0, light_softness: 2, light_strength: -1, ambient: 9, exposure: 10, warmth: -5 } })
const clamped = { light_azimuth_deg: 180, light_elevation_deg: 5, light_softness: 1, light_strength: 0, ambient: 3, exposure: 4, warmth: -1 }
ev.check('look numbers are clamped (azimuth −180…180, elevation 5…90, softness 0…1, strength 0…3, ambient 0…3, exposure 0.25…4, warmth −1…1); scene.json validates',
  r.status === 200 && Object.entries(clamped).every(([k, v]) => r.json?.look?.[k] === v) && vScene(diskScene()), `${fmt(r.json?.look)} ${errs(vScene)}`)
r = await api.send(B, 'PUT', `/api/scenes/${A}`, { look: { light_azimuth_deg: -400, light_elevation_deg: 95, light_softness: -1, light_strength: 7, ambient: -2, exposure: 0, warmth: 5 } })
ev.check('…and at the other ends', r.status === 200 && same(Object.fromEntries(Object.keys(clamped).map((k) => [k, r.json?.look?.[k]])),
  { light_azimuth_deg: -180, light_elevation_deg: 90, light_softness: 0, light_strength: 3, ambient: 0, exposure: 0.25, warmth: 1 }), fmt(r.json?.look))
const lookBefore = (await api.get(B, `/api/scenes/${A}`)).json?.look
const savedBefore = (await api.get(B, `/api/scenes/${A}`)).json?.saved
for (const [label, look] of [['an unknown key', { bogus: 1 }], ['a known key next to an unknown one', { exposure: 1, sparkle: true }],
  ['a boolean as a number (exposure: true)', { exposure: true }], ['a number as a boolean (auto_light: 1)', { auto_light: 1 }],
  ['0 as a boolean (cast_shadows: 0)', { cast_shadows: 0 }], ['a numeric string', { ambient: '1' }], ['a string boolean', { contact_shadows: 'true' }],
  ['an object value', { light_strength: {} }], ['a list for look', [1]], ['look null', null]]) {
  r = await api.send(B, 'PUT', `/api/scenes/${A}`, { look })
  ev.check(`PUT look with ${label} → 400 with one sentence naming the accepted keys`, r.status === 400 && /light_azimuth_deg/.test(r.json?.error || '') && /cast_shadows/.test(r.json?.error || '')
    && /ambient/.test(r.json?.error || ''), st(r))
}
r = await api.send(B, 'PUT', `/api/scenes/${A}`, '{"look": {"exposure": NaN}}')
ev.check('PUT look with NaN (Python\'s json reads it) → 400', r.status === 400, st(r))
gotLook = (await api.get(B, `/api/scenes/${A}`)).json
ev.check('refused looks changed nothing (look and saved)', same(gotLook?.look, lookBefore) && gotLook?.saved === savedBefore && same(diskScene().look, lookBefore), fmt(gotLook?.look))

ev.section('thumbnail')
r = await api.send(B, 'PUT', `/api/scenes/${A}/thumb`, { image: dataUri('image/jpeg', portraitBytes) })
ev.check('PUT /thumb with a JPEG data URI → 200 {ok, thumb_url}', r.status === 200 && r.json?.ok === true && /thumb\.jpg/.test(r.json?.thumb_url || ''), st(r))
const th = await raw(B, 'GET', r.json?.thumb_url || '/none')
ev.check('thumb_url is served (image/jpeg) and listed on the scene', th.status === 200 && /image\/jpeg/.test(th.headers['content-type'] || '') && /thumb\.jpg/.test((await api.get(B, `/api/scenes/${A}`)).json?.thumb_url || ''), `${th.status} ${th.headers['content-type']}`)
const bigThumb = Buffer.concat([livingBytes, Buffer.alloc(2_300_000 - livingBytes.length, 0)]) // a valid JPEG with trailing bytes, 2.3 MB
r = await api.send(B, 'PUT', `/api/scenes/${A}/thumb`, { image: dataUri('image/jpeg', bigThumb) })
ev.check('a thumbnail over 2 MB (an otherwise valid JPEG) is refused (4xx), the old one kept', r.status >= 400 && r.status < 500 && fs.readFileSync(path.join(scenesDir, A, 'thumb.jpg')).equals(portraitBytes), st(r))
r = await api.send(B, 'PUT', `/api/scenes/${A}/thumb`, { image: 'data:text/plain;base64,aGVsbG8=' })
ev.check('a thumbnail that is not a JPEG data URI → 400', r.status === 400, st(r))

ev.section('calibrate (re-run fit)')
closeGate()
const nCalls = calls().length
r = await api.send(B, 'POST', `/api/scenes/${A}/calibrate`)
const cjob = r.json?.job
ev.check('POST /calibrate → 202 {job}', r.status === 202 && /^c-/.test(cjob?.id || '') && cjob?.scene === A, st(r))
r = await api.send(B, 'POST', `/api/scenes/${A}/calibrate`)
ev.check('a second calibrate while one is queued or running → 409', r.status === 409, st(r))
ev.check('the scene shows calib_status pending or running meanwhile', ['pending', 'running'].includes((await api.get(B, `/api/scenes/${A}`)).json?.calib_status), (await api.get(B, `/api/scenes/${A}`)).json?.calib_status)
const auto2 = { fov_y_deg: 40, height_m: 2.0, pitch_deg: -20, roll_deg: 3 }
r = await api.send(B, 'PUT', `/api/scenes/${Bn}`, { camera: auto2, camera_source: 'auto' })
const rB = await api.send(B, 'POST', `/api/scenes/${Bn}/calibrate`)
openGate()
await waitFor(async () => (await api.get(B, `/api/scenes/jobs/${cjob?.id}`)).json?.status === 'done', { timeoutMs: 30000 })
const gA2 = await waitScene(B, A), gB2 = await waitScene(B, Bn)
const fitCall = calls().slice(nCalls).find((c) => c.argv.slice(1).some((x) => path.resolve(c.cwd, x) === path.join(scenesDir, A)))
ev.check('recalibration runs `fit <scene dir>` (photo.jpg exists)', !!fitCall && fitCall.argv[0] === 'fit', fitCall ? fmt(fitCall.argv) : fmt(calls().slice(-3).map((c) => c.argv)))
ev.check('a manual camera survives recalibration', gA2?.calib_status === 'done' && camEq(gA2?.camera, manual, 1e-9) && gA2?.camera_source === 'manual', fmt({ s: gA2?.calib_status, cam: gA2?.camera, src: gA2?.camera_source }))
ev.check('an auto camera is replaced by the calibration', rB.status === 202 && gB2?.calib_status === 'done' && camEq(gB2?.camera, PORTRAIT.truth.camera) && gB2?.camera_source === 'auto', fmt({ code: rB.status, cam: gB2?.camera, src: gB2?.camera_source }))
ev.check('POST /calibrate for an unknown scene → 404', (r = await api.send(B, 'POST', '/api/scenes/scene-19990101-000000/calibrate')).status === 404, st(r))

ev.section('a calibration that fails')
const broken = livingBytes.subarray(0, 100) // JPEG magic, then nothing: every ingest refuses it
r = await uploadScene(B, broken, { filename: 'broken.jpg' })
const F = r.json?.scene
ev.check('a truncated JPEG is accepted as an upload (202): the sniff only sees JPEG magic', r.status === 202 && !!F, st(r))
const gF = F ? await waitScene(B, F) : null
const jF = r.json?.job?.id ? (await api.get(B, `/api/scenes/jobs/${r.json.job.id}`)).json : null
ev.check('its job fails; the scene shows calib_status failed with the tool\'s sentence as calib_error and the job message', gF?.calib_status === 'failed' && typeof gF?.calib_error === 'string'
  && gF.calib_error.length > 5 && jF?.status === 'failed' && (jF?.message || '').includes(gF.calib_error), fmt({ status: gF?.calib_status, calib_error: gF?.calib_error, job: jF?.status, message: jF?.message }))
ev.check('a failed scene keeps the default camera (camera_source default)', camEq(gF?.camera, DEFAULT_CAMERA) && gF?.camera_source === 'default', fmt({ cam: gF?.camera, src: gF?.camera_source }))

ev.section('lighting.json in GET, and the backfill for scenes calibrated before it (POST …/light, §4.8)')
const COOL = golden('living-cool')
const lightOf = (g) => JSON.parse(fs.readFileSync(path.join(g.dir, 'lighting.json'), 'utf8'))
const coolLight = lightOf(COOL), portraitLight = lightOf(PORTRAIT)
const upL = await uploadScene(B, fs.readFileSync(COOL.photo), { filename: 'cool.jpg' })
const L = upL.json?.scene
let gL = L ? await waitScene(B, L) : null
ev.check('a calibrated scene: GET has lighting (lighting.json as it is), lighting_status done, lighting_error null',
  gL?.calib_status === 'done' && same(gL?.lighting, coolLight) && gL?.lighting_status === 'done' && gL?.lighting_error === null,
  fmt({ calib: gL?.calib_status, status: gL?.lighting_status, error: gL?.lighting_error, lighting: gL?.lighting ? 'object' : gL?.lighting }))
ev.check('/scenes/<L>/lighting.json is not served (404: the API carries it)', (r = await raw(B, 'GET', `/scenes/${L}/lighting.json`)).status === 404, `${r.status}`)
const Ldir = path.join(scenesDir, L || '_'), Bdir = path.join(scenesDir, Bn || '_')
const filesOf = (d) => Object.fromEntries(['calib.json', 'depth.png', 'scene.json', 'photo.jpg'].map((f) => [f, fs.existsSync(path.join(d, f)) ? fs.readFileSync(path.join(d, f)).toString('base64') : null]))
// a scene calibrated before lighting.json existed
for (const d of [Ldir, Bdir]) fs.rmSync(path.join(d, 'lighting.json'), { force: true })
const filesL0 = filesOf(Ldir), sceneL0 = JSON.parse(fs.readFileSync(path.join(Ldir, 'scene.json'), 'utf8'))
gL = (await api.get(B, `/api/scenes/${L}`)).json
ev.check('lighting.json deleted: GET has lighting null, lighting_status missing, lighting_error null; calib_status still done',
  gL?.lighting === null && gL?.lighting_status === 'missing' && gL?.lighting_error === null && gL?.calib_status === 'done', fmt({ l: gL?.lighting, s: gL?.lighting_status, e: gL?.lighting_error, c: gL?.calib_status }))
closeGate()
const nCallsL = calls().length
r = await api.send(B, 'POST', `/api/scenes/${L}/light`)
const ljob = r.json?.job
ev.check('POST /api/scenes/<L>/light → 202 {job: {id, kind light, scene, status queued}}', r.status === 202 && typeof ljob?.id === 'string' && ljob?.kind === 'light' && ljob?.scene === L
  && ['queued', 'running'].includes(ljob?.status), st(r))
gL = await waitFor(async () => { const g = (await api.get(B, `/api/scenes/${L}`)).json; return g?.lighting_status === 'running' ? g : null }, { timeoutMs: 5000 })
ev.check('while the light job runs: lighting_status running, and calib_status stays done (the planner never waits for "calibrating")', gL?.lighting_status === 'running' && gL?.calib_status === 'done',
  fmt({ s: gL?.lighting_status, c: gL?.calib_status }))
r = await api.send(B, 'POST', `/api/scenes/${L}/light`)
ev.check('a second POST …/light while it runs → 202 with the same job (two devices may open the scene)', r.status === 202 && r.json?.job?.id === ljob?.id, st(r))
r = await api.send(B, 'POST', `/api/scenes/${Bn}/light`)
const bjob = r.json?.job
const gBn = (await api.get(B, `/api/scenes/${Bn}`)).json
ev.check('a light job queued behind it: 202 status queued; the scene shows lighting_status pending, calib_status done', r.status === 202 && bjob?.status === 'queued' && bjob?.id !== ljob?.id
  && gBn?.lighting_status === 'pending' && gBn?.calib_status === 'done', `${st(r)} | ${gBn?.lighting_status} ${gBn?.calib_status}`)
r = await api.send(B, 'POST', `/api/scenes/${Bn}/light`)
ev.check('…and a second POST for it while queued → 202 with that same job', r.status === 202 && r.json?.job?.id === bjob?.id, st(r))
// a photo the mock doesn't know (its JFIF density changed): a default calibration without lighting.json
const missBytes = Buffer.from(livingBytes)
missBytes.writeUInt16BE(97, 14); missBytes.writeUInt16BE(97, 16)
const upM = await uploadScene(B, missBytes, { filename: 'miss.jpg' })
const M = upM.json?.scene, Mdir = path.join(scenesDir, M || '_')
let gM = (await api.get(B, `/api/scenes/${M}`)).json
ev.check('a scene whose calibration is queued: calib_status pending and lighting_status pending (the calibration brings the light)', gM?.calib_status === 'pending' && gM?.lighting_status === 'pending', fmt({ c: gM?.calib_status, s: gM?.lighting_status }))
r = await api.send(B, 'POST', `/api/scenes/${M}/light`)
ev.check('POST …/light while the scene calibrates → 409 with one sentence', r.status === 409 && /calibrating/.test(r.json?.error || ''), st(r))
r = await api.get(B, '/api/scenes/jobs')
ev.check('GET /api/scenes/jobs lists the light jobs (kind light) with the calibration', (r.json?.jobs || []).filter((j) => j.kind === 'light').length >= 2 && (r.json?.jobs || []).some((j) => j.scene === M && j.kind === 'calibrate'),
  (r.json?.jobs || []).slice(0, 4).map((j) => `${j.kind}:${j.scene === L ? 'L' : j.scene === Bn ? 'B' : j.scene === M ? 'M' : '?'}:${j.status}`))
openGate()
const lDone = await waitFor(async () => { const j = (await api.get(B, `/api/scenes/jobs/${ljob?.id}`)).json; return j?.status === 'done' || j?.status === 'failed' ? j : null }, { timeoutMs: 30000 })
await waitFor(async () => ['done', 'failed'].includes((await api.get(B, `/api/scenes/jobs/${bjob?.id}`)).json?.status), { timeoutMs: 30000 })
gM = await waitScene(B, M || '_')
ev.check('the light job finishes: status done, kind light, message "lighting inferred (… K)", lighting true', lDone?.status === 'done' && lDone?.kind === 'light' && /^lighting inferred \(\d+ K\)$/.test(lDone?.message || '')
  && lDone?.lighting === true, fmt(lDone))
const lightCall = calls().slice(nCallsL).find((c) => c.argv[0] === 'light' && path.resolve(c.cwd, c.argv[1] || '') === Ldir)
ev.check('it ran `<calib> light <scene dir>`', !!lightCall && lightCall.argv.length === 2, fmt(calls().slice(nCallsL).map((c) => c.argv[0])))
gL = (await api.get(B, `/api/scenes/${L}`)).json
ev.check('GET then has lighting = the mock\'s lighting.json, lighting_status done, lighting_error null', same(gL?.lighting, coolLight) && gL?.lighting_status === 'done' && gL?.lighting_error === null,
  fmt({ s: gL?.lighting_status, e: gL?.lighting_error, l: gL?.lighting ? 'object' : gL?.lighting }))
const filesL1 = filesOf(Ldir)
ev.check('calib.json, depth.png, photo.jpg and scene.json are byte for byte unchanged; camera, camera_source and calib_status too',
  same(filesL1, filesL0) && camEq(gL?.camera, sceneL0.camera, 1e-9) && gL?.camera_source === sceneL0.camera_source && gL?.calib_status === 'done',
  Object.keys(filesL0).filter((f) => filesL0[f] !== filesL1[f]).join(', ') || 'unchanged')
ev.check('the queued one ran too: B has its lighting back (lighting_status done)', same((await api.get(B, `/api/scenes/${Bn}`)).json?.lighting, portraitLight), (await api.get(B, `/api/scenes/${Bn}`)).json?.lighting_status)
r = await api.send(B, 'POST', `/api/scenes/${L}/light`)
ev.check('POST …/light again → 200 {lighting_status: done} without a job', r.status === 200 && r.json?.lighting_status === 'done' && !('job' in (r.json || {})), st(r))
// the mock miss: the calibration wrote no lighting.json; the light job finds none either
ev.check('the mock-miss scene calibrated (default) without lighting.json: lighting_status missing', gM?.calib_status === 'done' && gM?.lighting === null && gM?.lighting_status === 'missing'
  && !fs.existsSync(path.join(Mdir, 'lighting.json')), fmt({ c: gM?.calib_status, s: gM?.lighting_status }))
r = await api.send(B, 'POST', `/api/scenes/${M}/light`)
const mjob = r.json?.job
const mDone = await waitFor(async () => { const j = (await api.get(B, `/api/scenes/jobs/${mjob?.id}`)).json; return ['done', 'failed'].includes(j?.status) ? j : null }, { timeoutMs: 30000 })
gM = (await api.get(B, `/api/scenes/${M}`)).json
ev.check('an unknown photo (mock miss): the light job is done with lighting false, "no clear light in the photo"; GET lighting null, lighting_status none',
  r.status === 202 && mDone?.status === 'done' && mDone?.lighting === false && /no clear light/.test(mDone?.message || '') && gM?.lighting === null && gM?.lighting_status === 'none' && gM?.lighting_error === null
  && !fs.existsSync(path.join(Mdir, 'lighting.json')), fmt({ job: mDone, s: gM?.lighting_status }))
// a light job that fails: its sentence becomes lighting_error; calib_status is untouched
closeGate()
r = await api.send(B, 'POST', `/api/scenes/${M}/light`)
const fjob = r.json?.job
await waitFor(async () => (await api.get(B, `/api/scenes/jobs/${fjob?.id}`)).json?.status === 'running', { timeoutMs: 5000 })
const missPhoto = fs.readFileSync(path.join(Mdir, 'photo.jpg'))
fs.rmSync(path.join(Mdir, 'photo.jpg'))
openGate()
const fDone = await waitFor(async () => { const j = (await api.get(B, `/api/scenes/jobs/${fjob?.id}`)).json; return ['done', 'failed'].includes(j?.status) ? j : null }, { timeoutMs: 30000 })
gM = (await api.get(B, `/api/scenes/${M}`)).json
ev.check('a light job that fails (photo.jpg gone): lighting_status failed, lighting_error = the tool\'s sentence, calib_status still done', fjob && fDone?.status === 'failed' && gM?.lighting_status === 'failed'
  && typeof gM?.lighting_error === 'string' && gM.lighting_error.length > 5 && (fDone?.message || '') === gM.lighting_error && gM?.calib_status === 'done', fmt({ job: fDone, s: gM?.lighting_status, e: gM?.lighting_error }))
fs.writeFileSync(path.join(Mdir, 'photo.jpg'), missPhoto)
// while the scene calibrates, …/light is refused; a light job whose scene is deleted while it waits is dropped
closeGate()
r = await api.send(B, 'POST', `/api/scenes/${L}/calibrate`)
const recal = r.json?.job
r = await api.send(B, 'POST', `/api/scenes/${L}/light`)
ev.check('POST …/light while the scene recalibrates → 409 ("its lighting comes with it")', recal && r.status === 409 && /lighting comes with it/.test(r.json?.error || ''), st(r))
const nCallsD = calls().length
r = await api.send(B, 'POST', `/api/scenes/${M}/light`)
const djob = r.json?.job
const dDel = await api.send(B, 'DELETE', `/api/scenes/${M}`)
const djob1 = (await api.get(B, `/api/scenes/jobs/${djob?.id}`)).json
openGate()
await waitFor(async () => (await api.get(B, `/api/scenes/jobs/${recal?.id}`)).json?.status === 'done', { timeoutMs: 30000 })
await sleep(800)
ev.check('a queued light job whose scene is deleted is dropped (failed, "the scene was deleted"), never runs, and leaves no folder behind',
  djob?.status === 'queued' && dDel.status === 200 && djob1?.status === 'failed' && /deleted/.test(djob1?.message || '') && !calls().slice(nCallsD).some((c) => c.argv[0] === 'light')
  && !fs.existsSync(Mdir), fmt({ queued: djob?.status, del: dDel.status, job: djob1?.status, msg: djob1?.message, calls: calls().slice(nCallsD).map((c) => c.argv[0]), dir: fs.existsSync(Mdir) }))
gL = (await api.get(B, `/api/scenes/${L}`)).json
ev.check('the recalibration rewrote lighting.json (lighting_status done)', gL?.lighting_status === 'done' && same(gL?.lighting, coolLight), gL?.lighting_status)
ev.check('POST …/light for an unknown scene → 404', (r = await api.send(B, 'POST', '/api/scenes/scene-19990101-000000/light')).status === 404, st(r))
ev.check('POST …/light for a scene without photo.jpg (its calibration failed) → 409', (r = await api.send(B, 'POST', `/api/scenes/${F}/light`)).status === 409, st(r))
ev.check('POST …/light with a non-slug name → 404', (r = await api.send(B, 'POST', '/api/scenes/..%2Fx/light')).status === 404, st(r))

ev.section('bad uploads')
const before = sceneFolders()
r = await uploadScene(B, livingBytes, { filename: 'x.jpg', chunked: true })
ev.check('an upload without Content-Length → 411', r.status === 411, st(r))
const big = path.join(ev.out, 'big.jpg')
fs.writeFileSync(big, Buffer.concat([livingBytes.subarray(0, 4), Buffer.alloc(26 * 1024 * 1024 - 4, 0)]))
let code413 = ''
try {
  code413 = execFileSync('curl', ['-s', '-o', path.join(ev.out, 'big.json'), '-w', '%{http_code}', '-X', 'POST', '-H', 'X-Midstudy: 1', '-H', 'X-Midstudy-Filename: big.jpg',
    '-H', 'Content-Type: application/octet-stream', '--data-binary', `@${big}`, `${B}/api/scenes`], { encoding: 'utf8', timeout: 60000 })
} catch (e) { code413 = String(e.stdout || e.status || e) }
ev.check('an upload over 25 MB → 413', code413 === '413', code413)
fs.rmSync(big, { force: true })
r = await uploadScene(B, Buffer.from('just some text, not a photo\n'.repeat(50)), { filename: 'notes.jpg' })
ev.check('a body that isn\'t a JPEG, PNG, HEIC or WebP → 400 with one sentence', r.status === 400 && typeof r.json?.error === 'string' && r.json.error.length > 10, st(r))
r = await uploadScene(B, Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;'), { filename: 'anim.gif' })
ev.check('a GIF → 400', r.status === 400, st(r))
r = await uploadScene(B, livingBytes, { filename: null })
ev.check('an upload without X-Midstudy-Filename → 400', r.status === 400, st(r))
r = await raw(B, 'POST', '/api/scenes', { headers: { 'X-Midstudy': '1', 'X-Midstudy-Filename': 'a.jpg', 'X-Midstudy-Meta': '!!not base64 json!!' }, body: livingBytes })
ev.check('a malformed X-Midstudy-Meta → 400', r.status === 400, st(r))
ev.check('refused uploads created no scene', fmt(sceneFolders()) === fmt(before), `${before.length} → ${sceneFolders().length}`)

ev.section('layouts per scene (§2.7)')
const item = (uid, x, rot) => ({ uid, id: 'probe-box', render: 'glb', position: [x, 0, -2.5], rotation_y_deg: rot, dims_cm: { w: 80, d: 50, h: 120 } })
r = await api.send(B, 'PUT', `/api/layouts/one?scene=${A}`, { version: 1, name: 'one', items: [item('u1', 0.5, 30)] })
const l1 = r.json || {}
ev.check('PUT /api/layouts/one?scene=A → 200; the server sets scene_name and updated', r.status === 200 && l1.scene_name === A && ISO.test(l1.updated || ''), st(r))
const lf = path.join(srv.dirs.layouts, A || '_', 'one.json')
const lfj = fs.existsSync(lf) ? JSON.parse(fs.readFileSync(lf, 'utf8')) : null
ev.check('layouts/<A>/one.json is written and validates (layout.schema.json)', lfj && vLayout(lfj) && lfj.scene_name === A, lfj ? errs(vLayout) || 'valid' : 'missing')
await api.send(B, 'PUT', `/api/layouts/two?scene=${A}`, { version: 1, name: 'two', items: [item('u2', 1, 0), item('u3', -1, 90)] })
r = await api.send(B, 'PUT', `/api/layouts/one?scene=${Bn}`, { version: 1, name: 'one', items: [item('b1', -0.25, 180)] })
ev.check('the same layout name in scene B → 200', r.status === 200 && r.json?.scene_name === Bn, st(r))
r = await api.get(B, `/api/layouts?scene=${A}`)
ev.check('GET /api/layouts?scene=A lists A\'s layouts sorted, with details', fmt(r.json?.layouts) === fmt(['one', 'two']) && r.json?.details?.find((d) => d.name === 'two')?.items === 2 && r.json.details.every((d) => d.updated), st(r))
r = await api.get(B, `/api/layouts?scene=${Bn}`)
ev.check('GET /api/layouts?scene=B lists only B\'s layout', fmt(r.json?.layouts) === fmt(['one']) && r.json?.details?.[0]?.items === 1, st(r))
r = await api.get(B, `/api/layouts/two?scene=${Bn}`)
ev.check("A's layout doesn't leak into B (GET two?scene=B → 404)", r.status === 404, st(r))
r = await api.get(B, `/api/layouts/one?scene=${A}`)
ev.check("GET one?scene=A is A's own (rotation 30), not B's", r.status === 200 && r.json?.items?.[0]?.rotation_y_deg === 30 && r.json?.items?.[0]?.uid === 'u1', st(r))
const nl = [(await api.get(B, `/api/scenes/${A}`)).json?.layouts, (await api.get(B, `/api/scenes/${Bn}`)).json?.layouts]
ev.check('the scene object counts its layouts (A 2, B 1)', nl[0] === 2 && nl[1] === 1, `A ${nl[0]}, B ${nl[1]}`)
ev.check('GET /api/layouts without ?scene → 400', (r = await api.get(B, '/api/layouts')).status === 400, st(r))
ev.check('GET /api/layouts?scene=<unknown> → 404', (r = await api.get(B, '/api/layouts?scene=scene-19990101-000000')).status === 404, st(r))
ev.check('PUT a layout in an unknown scene → 404, nothing written', (r = await api.send(B, 'PUT', '/api/layouts/one?scene=scene-19990101-000000', { version: 1, name: 'one', items: [] })).status === 404
  && !fs.existsSync(path.join(srv.dirs.layouts, 'scene-19990101-000000')), st(r))
ev.check('PUT a non-slug layout name → 400', (r = await api.send(B, 'PUT', `/api/layouts/Bad%20Name?scene=${A}`, { version: 1, name: 'x', items: [] })).status === 400, st(r))
ev.check('PUT a layout with ?scene=../x → 400 or 404, nothing written outside', [400, 404].includes((r = await api.send(B, 'PUT', '/api/layouts/one?scene=..%2Fescape', { version: 1, name: 'one', items: [] })).status)
  && !fs.existsSync(path.join(srv.dirs.data, 'escape')), st(r))
r = await api.send(B, 'DELETE', `/api/layouts/two?scene=${A}`)
ev.check('DELETE /api/layouts/two?scene=A → 200 {ok}', r.status === 200 && r.json?.ok === true && !fs.existsSync(path.join(srv.dirs.layouts, A, 'two.json')), st(r))
ev.check('DELETE it again → 404', (r = await api.send(B, 'DELETE', `/api/layouts/two?scene=${A}`)).status === 404, st(r))

ev.section('what /scenes/ serves (§4.4 Static, §2.9 Paths = W4)')
ev.check('/scenes/<A>/photo.jpg?v=1 (cache buster) → 200', (r = await raw(B, 'GET', `/scenes/${A}/photo.jpg?v=1`)).status === 200, `${r.status}`)
ev.check('/scenes/<A>/thumb.jpg → 200', (r = await raw(B, 'GET', `/scenes/${A}/thumb.jpg`)).status === 200, `${r.status}`)
for (const p of [`/scenes/${A}/source.jpg`, `/scenes/${A}/calib.json`, `/scenes/${A}/lighting.json`, `/scenes/${A}/%6Cighting.json`, `/./scenes/${A}/lighting.json`, `/scenes/${A}/scene.json`, `/scenes/${A}/`, `/scenes/${A}`, '/scenes/', '/scenes/.trash/',
  `/scenes/${A}/nothing.jpg`, `/./scenes/${A}/source.jpg`, `/planner/../scenes/${A}/calib.json`, `/%2e/scenes/${A}/source.jpg`, `/scenes/${A}/./source.jpg`,
  `/scenes/${A}/%73ource.jpg`, `/scenes/${A}/photo.jpg/../scene.json`, `/scenes/%2e%2e/scenes/${A}/source.jpg`, `/scenes/${A}/%2e%2e/${A}/calib.json`]) {
  r = await raw(B, 'GET', p)
  ev.check(`GET ${p.replace(A, '<A>').replace(A, '<A>')} → 404`, r.status === 404, `${r.status}`)
}

ev.section('delete (§4.4)')
r = await api.send(B, 'DELETE', `/api/scenes/${A}`)
const trash = r.json?.trash || ''
const trashDir = path.join(path.dirname(scenesDir), trash)
const trashDir2 = path.join(scenesDir, '.trash', path.basename(trash))
const tdir = fs.existsSync(trashDir) ? trashDir : trashDir2
ev.check('DELETE /api/scenes/<A> → 200 {ok, trash: scenes/.trash/<A>-<stamp>}', r.status === 200 && r.json?.ok === true && new RegExp(`^scenes/\\.trash/${A}-\\d{8}-\\d{6}`).test(trash), st(r))
ev.check('the folder moved to the trash with its layouts inside (layouts/one.json); layouts/<A> is gone',
  !fs.existsSync(path.join(scenesDir, A)) && fs.existsSync(path.join(tdir, 'photo.jpg')) && fs.existsSync(path.join(tdir, 'scene.json')) && fs.existsSync(path.join(tdir, 'layouts', 'one.json'))
  && !fs.existsSync(path.join(srv.dirs.layouts, A)), fs.existsSync(tdir) ? fmt(fs.readdirSync(tdir)) : `no ${tdir}`)
r = await api.get(B, `/api/scenes/${A}`)
const listedA = ((await api.get(B, '/api/scenes')).json?.scenes || []).some((s) => s.name === A)
ev.check('GET /api/scenes/<A> → 404 and it is no longer listed', r.status === 404 && !listedA, `${r.status}, listed ${listedA}`)
ev.check('/scenes/.trash/<A>-…/photo.jpg → 404', (r = await raw(B, 'GET', `/scenes/.trash/${path.basename(trash)}/photo.jpg`)).status === 404, `${r.status}`)
ev.check('GET /api/layouts?scene=<A> → 404 now', (r = await api.get(B, `/api/layouts?scene=${A}`)).status === 404, st(r))
ev.check('DELETE it again → 404', (r = await api.send(B, 'DELETE', `/api/scenes/${A}`)).status === 404, st(r))
// a running job's result is ignored once its scene is deleted
closeGate()
r = await uploadScene(B, livingBytes, { filename: 'c.jpg' })
const C = r.json?.scene
await waitFor(async () => (await api.get(B, `/api/scenes/${C}`)).json?.calib_status === 'running', { timeoutMs: 5000 })
r = await api.send(B, 'DELETE', `/api/scenes/${C}`)
ev.check('DELETE a scene while its calibration runs → 200', r.status === 200, st(r))
openGate()
await sleep(2500)
ev.check("the running job's result is ignored: the scene stays deleted", (await api.get(B, `/api/scenes/${C}`)).status === 404 && !((await api.get(B, '/api/scenes')).json?.scenes || []).some((s) => s.name === C)
  && !fs.existsSync(path.join(scenesDir, C || '_', 'scene.json')), fs.existsSync(path.join(scenesDir, C || '_')) ? fmt(fs.readdirSync(path.join(scenesDir, C))) : 'gone')

ev.section('§2.9 W1: forged mutations on every new route')
const sjB = path.join(scenesDir, Bn || '_', 'scene.json')
const snapB = () => [fs.existsSync(sjB) ? fs.readFileSync(sjB, 'utf8') : '', fmt(fs.existsSync(path.join(srv.dirs.layouts, Bn || '_')) ? fs.readdirSync(path.join(srv.dirs.layouts, Bn)) : []),
  fmt(sceneFolders()), fmt(fs.readdirSync(srv.dirs.renders))].join('|')
const snap0 = snapB()
const forgedRoutes = [
  ['POST', '/api/scenes', livingBytes, { 'X-Midstudy-Filename': 'f.jpg', 'Content-Type': 'application/octet-stream' }],
  ['PUT', `/api/scenes/${Bn}`, JSON.stringify({ title: 'forged' }), { 'Content-Type': 'application/json' }],
  ['PUT', `/api/scenes/${Bn}/thumb`, JSON.stringify({ image: dataUri('image/jpeg', livingBytes) }), { 'Content-Type': 'application/json' }],
  ['POST', `/api/scenes/${Bn}/calibrate`, null, {}],
  ['POST', `/api/scenes/${Bn}/light`, null, {}],
  ['DELETE', `/api/scenes/${Bn}`, null, {}],
  ['PUT', `/api/layouts/forged?scene=${Bn}`, JSON.stringify({ version: 1, name: 'forged', items: [] }), { 'Content-Type': 'application/json' }],
  ['DELETE', `/api/layouts/one?scene=${Bn}`, null, {}],
  ['POST', '/api/render', JSON.stringify({ image: dataUri('image/jpeg', portraitBytes), scene: Bn }), { 'Content-Type': 'application/json' }],
]
for (const [m, p, body, h] of forgedRoutes) {
  const noHeader = await raw(B, m, p, { headers: h, body })
  const foreign = await raw(B, m, p, { headers: { ...h, 'X-Midstudy': '1', Origin: 'http://evil.example' }, body })
  ev.check(`W1 ${m} ${p.replace(Bn, '<B>')}: without X-Midstudy → 403, with a foreign Origin → 403`, noHeader.status === 403 && foreign.status === 403
    && /cross-site/i.test(noHeader.json?.error || ''), `${noHeader.status} ${clip(noHeader.json?.error, 60)} / ${foreign.status}`)
}
ev.check('W1 nothing changed (scene.json, layouts, scene list, renders)', snapB() === snap0, snapB() === snap0 ? 'unchanged' : 'changed')
r = await api.send(B, 'PUT', `/api/scenes/${Bn}`, { title: 'Same origin' }, { headers: { Origin: B } })
ev.check('W1 a mutation from the page\'s own Origin is allowed', r.status === 200 && r.json?.title === 'Same origin', st(r))

ev.section('§2.9 W2: Host names')
const port = new URL(B).port
for (const [host, want] of [['evil.example', 403], [`evil.example:${port}`, 403], [`localhost:${port}`, 200], [`127.0.0.1:${port}`, 200], [`[::1]:${port}`, 200]]) {
  r = await raw(B, 'GET', '/api/scenes', { headers: { Host: host } })
  ev.check(`W2 GET /api/scenes with Host ${host} → ${want}`, r.status === want, `${r.status}`)
}
r = await raw(B, 'GET', `/scenes/${Bn}/photo.jpg`, { headers: { Host: 'evil.example' } })
ev.check('W2 /scenes/<B>/photo.jpg with a foreign Host → 403', r.status === 403, `${r.status}`)
r = await raw(B, 'PUT', `/api/scenes/${Bn}`, { headers: { Host: 'evil.example', 'X-Midstudy': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'host' }) })
ev.check('W2 a mutation with a foreign Host → 403', r.status === 403 && (await api.get(B, `/api/scenes/${Bn}`)).json?.title === 'Same origin', `${r.status}`)

ev.section('/api/render with a scene, and the spend cap (§2.9 W2, §4.7)')
r = await api.send(B, 'POST', '/api/render', { image: dataUri('image/jpeg', portraitBytes), scene: Bn })
ev.check('mock render with a scene under a $0 cap → 200 (mock calls cost $0 and count for nothing), reference true', r.status === 200 && r.json?.mock === true && r.json?.cost_usd === 0
  && r.json?.scene === Bn && r.json?.reference === true, st(r))
ev.check('POST /api/render with an unknown scene → 404', (r = await api.send(B, 'POST', '/api/render', { image: dataUri('image/jpeg', portraitBytes), scene: 'scene-19990101-000000' })).status === 404, st(r))
r = await api.get(B, '/api/spend')
ev.check('GET /api/spend → {day, spent_usd 0, reserved_usd 0, cap_usd 0}', r.status === 200 && r.json?.spent_usd === 0 && r.json?.reserved_usd === 0 && r.json?.cap_usd === 0 && /^\d{4}-\d{2}-\d{2}$/.test(r.json?.day || ''), st(r))
await srv.stop()

const srv2 = await startServer(ev, { spendUsd: '0.03', mockCost: true })
ev.check('a second server: --daily-spend-usd 0.03 with MIDSTUDY_FAL_MOCK_COST=1 (mock calls count at their price; still no key, $0)', srv2.up, srv2.up ? srv2.base : srv2.why)
if (srv2.up) {
  const up2 = await uploadScene(srv2.base, livingBytes, { filename: 'cap.jpg' })
  const S2 = up2.json?.scene
  await waitScene(srv2.base, S2 || '_', 30000)
  const costs0 = fs.readFileSync(srv2.dirs.costs, 'utf8')
  for (const model of ['nano-banana', 'kontext', 'qwen', 'gpt-image']) {
    r = await api.send(srv2.base, 'POST', '/api/render', { image: dataUri('image/jpeg', livingBytes), scene: S2, model })
    ev.check(`W2 /api/render ${model} with a scene over the $0.03 cap → 402 {error, spent_usd, cap_usd}`, r.status === 402 && typeof r.json?.error === 'string' && 'spent_usd' in (r.json || {}) && r.json?.cap_usd === 0.03, st(r))
  }
  ev.check('W2 no call was made: no cost row, no render files', fs.readFileSync(srv2.dirs.costs, 'utf8') === costs0 && fs.readdirSync(srv2.dirs.renders).length === 0, fmt(fs.readdirSync(srv2.dirs.renders)))
  r = await api.get(srv2.base, '/api/spend')
  ev.check('W2 GET /api/spend: nothing spent or reserved, cap 0.03', r.json?.spent_usd === 0 && r.json?.reserved_usd === 0 && r.json?.cap_usd === 0.03, st(r))
  r = await api.send(srv2.base, 'POST', '/api/render', { image: dataUri('image/jpeg', livingBytes), scene: S2 })
  ev.check('the 402 for one render that costs more than the whole cap says so (not "used up: $0.00 spent")', r.status === 402 && /costs \$0\.0398, more than the daily fal budget/.test(r.json?.error || ''), st(r))
  r = await api.get(srv2.base, '/api/settings')
  ev.check('with --daily-spend-usd 0.03: GET /api/settings is locked at 0.03', r.status === 200 && r.json?.locked === true && r.json?.daily_spend_usd === 0.03, st(r))
  r = await api.send(srv2.base, 'PUT', '/api/settings', { daily_spend_usd: 50 })
  ev.check('…and PUT /api/settings is 409 (the flag wins), the cap still 0.03', r.status === 409 && (await api.get(srv2.base, '/api/spend')).json?.cap_usd === 0.03, st(r))
  await srv2.stop()
}

// --- Settings: the daily budget (§2.9 Settings) ---------------------------------------------------------------------------------
ev.section('Settings: the daily budget')
const srvB = await startServer(ev, { appBudget: true, mockCost: true })
ev.check('a server without --daily-spend-usd (fal mocked, a temp library)', srvB.up, srvB.up ? srvB.base : srvB.why)
if (srvB.up) {
  r = await api.get(srvB.base, '/api/settings')
  ev.check('GET /api/settings: $2 by default, not locked', r.status === 200 && r.json?.daily_spend_usd === 2 && r.json?.default_usd === 2 && r.json?.locked === false, st(r))
  for (const bad of [-1, 'ten', null, 10001, true]) {
    r = await api.send(srvB.base, 'PUT', '/api/settings', { daily_spend_usd: bad })
    ev.check(`PUT daily_spend_usd ${JSON.stringify(bad)} → 400`, r.status === 400, st(r))
  }
  r = await api.send(srvB.base, 'PUT', '/api/settings', { daily_spend_usd: 25 }, { forged: true })
  ev.check('W1 a forged PUT /api/settings → 403', r.status === 403, st(r))
  r = await api.send(srvB.base, 'PUT', '/api/settings', { daily_spend_usd: 0.01 })
  const cap = (await api.get(srvB.base, '/api/spend')).json?.cap_usd
  ev.check('PUT 0.01 → 200, /api/spend uses it at once', r.status === 200 && r.json?.daily_spend_usd === 0.01 && cap === 0.01, `${st(r)} cap ${cap}`)
  r = await api.send(srvB.base, 'POST', '/api/render', { image: dataUri('image/jpeg', livingBytes) })
  ev.check('…a $0.0398 render is then 402', r.status === 402, st(r))
  r = await api.send(srvB.base, 'PUT', '/api/settings', { daily_spend_usd: 3.14159 })
  const saved = JSON.parse(fs.readFileSync(path.join(srvB.dirs.library, 'settings.json'), 'utf8'))
  ev.check('PUT 3.14159 → 3.14, saved in <library>/settings.json', r.status === 200 && r.json?.daily_spend_usd === 3.14 && saved.daily_spend_usd === 3.14, `${st(r)} ${fmt(saved)}`)
  r = await api.send(srvB.base, 'POST', '/api/render', { image: dataUri('image/jpeg', livingBytes) })
  ev.check('…and the render goes through under the new budget', r.status === 200, st(r))
  await srvB.stop()
}


// --- verify round 1: privacy and HTTP hardening (docs/notes/verify-fix-1.md) ---------------------------------------------------
const META = path.join(ev.out, 'meta')
fs.mkdirSync(META, { recursive: true })
const meta = (...args) => { try { return JSON.parse(execFileSync(path.join(REPO, 'evals/py'), [path.join(REPO, 'evals/lib/metadata.py'), ...args], { cwd: REPO, encoding: 'utf8' }).trim().split('\n').at(-1)) } catch (e) { return { error: String(e.stderr || e).slice(0, 300) } } }
const makeImg = (kind, extra = []) => { const out = path.join(META, `${kind}.jpg`); meta('make', '--kind', kind, '--out', out, ...extra); return out }
// A raw TCP request (for what Node's HTTP client won't send): resolves with the first bytes of the answer, or '' on timeout.
const tcp = (port, text, { waitMs = 4000 } = {}) => new Promise((resolve) => {
  const sock = net.connect(port, '127.0.0.1'), t0 = Date.now()
  let got = ''
  const done = () => { clearTimeout(timer); sock.destroy(); resolve({ text: got, ms: Date.now() - t0 }) }
  const timer = setTimeout(done, waitMs)
  sock.on('data', (d) => { got += d.toString('latin1'); if (/\r\n\r\n/.test(got)) setTimeout(done, 50) })
  sock.on('error', done)
  sock.on('close', done)
  sock.write(text)
})

ev.section('verify round 1: what the server serves (an allowlist, any spelling)')
const srv3 = await startServer(ev)
ev.check('a third server (stub calibration, probe library)', srv3.up, srv3.up ? srv3.base : srv3.why)
if (srv3.up) {
  const B3 = srv3.base
  const gpsJpeg = fs.readFileSync(makeImg('gps-jpeg', ['--from', LIVING.photo]))
  const up = await uploadScene(B3, gpsJpeg, { filename: 'IMG_0001.JPG' })
  const N = up.json?.scene
  await waitScene(B3, N || '_', 30000)
  const rel = path.relative(REPO, srv3.dirs.scenes)
  fs.mkdirSync(path.join(srv3.dirs.library, 'probe-box'), { recursive: true })
  fs.writeFileSync(path.join(srv3.dirs.library, 'probe-box', 'source.jpg'), gpsJpeg) // as midstudy-add keeps an upload
  const denied = [`/Scenes/${N}/source.jpg`, `/SCENES/${N}/calib.json`, `/sCenes/${N}/scene.json`, `/scenes/${N}/source.jpg`, `/scenes/${N}/Photo.JPG/../source.jpg`,
    `/${rel}/${N}/source.jpg`, `/${rel}/${N}/calib.json`, `/${rel.toUpperCase()}/${N}/source.jpg`,
    '/Library/costs.csv', '/library/costs.csv', '/LIBRARY/library.json/../costs.csv', '/library/probe-box/source.jpg', '/library/probe-box/SOURCE.JPG', '/Library/probe-box/source.jpg',
    '/fixtures/photos/notes.md', '/Fixtures/photos/notes.md', '/fixtures/PHOTOS/notes.md', '/fixtures/Photos/private/x.jpg', '/fixtures/scenes/living-wide/truth.json',
    '/README.md', '/CLAUDE.md', '/package.json', '/flake.nix', '/.env', '/%2Eenv', '/contract/CONTRACT.md', '/evals/out/', '/AD9729E1-593E-4443-9BCD-B0519A7265F1_1_201_a', '/IMG_0007.tiff', '/Downloads/IMG_0005.jpeg']
  const leaks = []
  for (const p of denied) { const rr = await raw(B3, 'GET', p); if (rr.status !== 404) leaks.push(`${p} → ${rr.status}`) }
  ev.check(`none of ${denied.length} spellings of private paths is served (source.*, calib.json, scene.json, costs.csv, library sources, fixtures/photos, repo files, scratch scenes)`, leaks.length === 0, leaks.join('; ') || 'all 404')
  r = await raw(B3, 'GET', '/planner/index.html')
  ev.check('the planner itself is still served, with nosniff', r.status === 200 && /nosniff/i.test(r.headers?.['x-content-type-options'] || ''), `${r.status} ${r.headers?.['x-content-type-options']}`)
  r = await raw(B3, 'GET', '/library/library.json')
  ev.check('…and /library/library.json and /scenes/<n>/photo.jpg', r.status === 200 && (await raw(B3, 'GET', `/scenes/${N}/photo.jpg`)).status === 200, `${r.status}`)

  ev.section('verify round 1: no camera metadata in what is served or sent')
  const photoOf = async (bytes, name) => {
    const u = await uploadScene(B3, bytes, { filename: name })
    const s = await waitScene(B3, u.json?.scene || '_', 30000)
    const f = path.join(META, `served-${name}`)
    const g = s?.photo_url ? await raw(B3, 'GET', s.photo_url.split('?')[0]) : null
    if (g?.status === 200) fs.writeFileSync(f, g.buf)
    return { scene: s, info: g?.status === 200 ? meta('inspect', f) : { error: `GET photo ${g?.status}` }, same: g?.buf?.length ? Buffer.compare(g.buf, bytes) === 0 : null }
  }
  for (const kind of ['trailing-gps', 'prog-midscan-gps', 'zero-pad']) {
    const bytes = fs.readFileSync(makeImg(kind))
    const res = await photoOf(bytes, `${kind}.jpg`)
    ev.check(`a JPEG with ${kind === 'trailing-gps' ? 'a GPS-bearing JPEG after its EOI' : kind === 'prog-midscan-gps' ? 'EXIF/GPS between progressive scans' : '64 KB of padding after EOI'}: the served photo.jpg is not passed through and carries nothing`, res.info.clean === true && res.same === false,
      fmt({ calib: res.scene?.calib_status, same: res.same, ...res.info }))
  }
  const gpsData = fs.readFileSync(path.join(META, 'gps-jpeg.jpg'))
  r = await api.send(B3, 'PUT', `/api/scenes/${N}/thumb`, { image: dataUri('image/jpeg', gpsData) })
  const thumbInfo = r.status === 200 ? (fs.writeFileSync(path.join(META, 'thumb.jpg'), (await raw(B3, 'GET', `/scenes/${N}/thumb.jpg`)).buf), meta('inspect', path.join(META, 'thumb.jpg'))) : { error: r.status }
  ev.check('a thumbnail sent with EXIF/GPS is stored and served without it', thumbInfo.clean === true, fmt(thumbInfo))
  r = await api.send(B3, 'POST', '/api/render', { image: dataUri('image/jpeg', gpsData), scene: N })
  const rn = r.json?.name
  const rInfo = rn ? ['', '-input'].map((x) => meta('inspect', path.join(srv3.dirs.renders, `${rn}${x}.jpg`))) : []
  ev.check('a render composite sent with EXIF/GPS: <name>-input.jpg and <name>.jpg (what fal gets, mock) carry none of it', r.status === 200 && rInfo.length === 2 && rInfo.every((x) => x.clean), fmt({ status: r.status, rInfo }))

  ev.section('verify round 1: slugs, framing, Host, early 413, listing order')
  r = await api.send(B3, 'PUT', `/api/layouts/evil%0A?scene=${N}`, { items: [] })
  ev.check('a layout name with a trailing newline (evil%0A) is 400, not written', r.status === 400 && !(await api.get(B3, `/api/layouts?scene=${N}`)).json?.layouts?.some((x) => x.startsWith('evil')), st(r))
  const metaHdr = Buffer.from(JSON.stringify({ name: 'Evil', id: 'evil\n', dims_cm: { w: 1, d: 1, h: 1 } })).toString('base64')
  r = await raw(B3, 'POST', '/api/library/items', { headers: { 'X-Midstudy': '1', 'X-Midstudy-Kind': 'model', 'X-Midstudy-Filename': 'a.glb', 'X-Midstudy-Meta': metaHdr }, body: fs.readFileSync(path.join(srv3.dirs.library, 'probe-box', 'model.glb')) })
  ev.check('a library id with a trailing newline is 400', r.status === 400, st(r))
  let t = await tcp(srv3.port, `POST /api/scenes HTTP/1.1\r\nHost: 127.0.0.1:${srv3.port}\r\nX-Midstudy: 1\r\nX-Midstudy-Filename: a.jpg\r\nContent-Length: 10\r\nContent-Length: ${livingBytes.length}\r\n\r\n`)
  ev.check('two Content-Length headers → 400 (ambiguous framing), nothing created', /^HTTP\/1\.[01] 400/.test(t.text), clip(t.text.split('\r\n')[0], 80))
  for (const host of [`127.0.0.1:${srv3.port}@evil.example`, '[::1]evil.example', `localhost:${srv3.port}.evil.example`]) {
    t = await tcp(srv3.port, `GET /api/scenes HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`)
    ev.check(`Host "${host}" is not loopback → 403`, /^HTTP\/1\.[01] 403/.test(t.text), clip(t.text.split('\r\n')[0], 80))
  }
  t = await tcp(srv3.port, `GET /api/scenes HTTP/1.1\r\nHost: localhost:${srv3.port}\r\nConnection: close\r\n\r\n`)
  ev.check('Host "localhost:<port>" still works', /^HTTP\/1\.[01] 200/.test(t.text), clip(t.text.split('\r\n')[0], 80))
  t = await tcp(srv3.port, `POST /api/scenes HTTP/1.1\r\nHost: 127.0.0.1:${srv3.port}\r\nX-Midstudy: 1\r\nX-Midstudy-Filename: big.jpg\r\nContent-Length: ${25 * 1024 * 1024 + 1}\r\n\r\n`, { waitMs: 3000 })
  ev.check('a 25 MB + 1 byte upload gets its 413 at once, without sending the body, saying "25.1 MB"', /^HTTP\/1\.[01] 413/.test(t.text) && t.ms < 2500 && /25\.1 MB: a scene photo can be at most 25 MB/.test(t.text), `${clip(t.text.split('\r\n')[0], 60)} in ${t.ms} ms; ${clip(t.text.split('\r\n\r\n')[1], 120)}`)
  // ties on `created`: the collision suffix sorts as a number (…-10 before …-9)
  for (const n of [2, 9, 10, 11]) {
    const d = path.join(srv3.dirs.scenes, `scene-19990101-000000${n === 1 ? '' : `-${n}`}`)
    fs.mkdirSync(d, { recursive: true })
    fs.writeFileSync(path.join(d, 'scene.json'), JSON.stringify({ version: 1, title: null, created: '1999-01-01T00:00:00Z', saved: null, camera: DEFAULT_CAMERA, camera_source: 'default' }))
  }
  const order = ((await api.get(B3, '/api/scenes')).json?.scenes || []).map((x) => x.name).filter((x) => x.startsWith('scene-19990101'))
  ev.check('scenes made in the same second list newest first: -11, -10, -9, -2', fmt(order) === fmt(['-11', '-10', '-9', '-2'].map((x) => `scene-19990101-000000${x}`)), fmt(order))

  ev.section('verify round 1: a deleted scene can be restored; a deleted layout is kept')
  r = await api.send(B3, 'PUT', `/api/layouts/phone-a?scene=${N}`, { title: 'Phone A', items: [{ id: 'probe-box', position: [0, 0, -2], rotation_y_deg: 0 }] })
  ev.check('PUT a layout with a title: stored as typed ("Phone A"), listed in details', r.status === 200 && r.json?.title === 'Phone A' && (await api.get(B3, `/api/layouts?scene=${N}`)).json?.details?.[0]?.title === 'Phone A' && vLayout(r.json), `${st(r)} ${errs(vLayout)}`)
  r = await api.send(B3, 'PUT', `/api/layouts/long?scene=${N}`, { title: 'x'.repeat(121), items: [] })
  ev.check('a title over 120 characters is 400', r.status === 400, st(r))
  r = await api.send(B3, 'DELETE', `/api/layouts/phone-a?scene=${N}`)
  const ltrash = path.join(srv3.dirs.layouts, N, '.trash')
  ev.check('DELETE a layout moves it to layouts/<scene>/.trash/ (not listed, not gone)', r.status === 200 && fs.existsSync(ltrash) && fs.readdirSync(ltrash).some((f) => f.startsWith('phone-a-'))
    && !(await api.get(B3, `/api/layouts?scene=${N}`)).json?.layouts?.includes('phone-a'), st(r))
  await api.send(B3, 'PUT', `/api/layouts/kept?scene=${N}`, { items: [] })
  r = await api.send(B3, 'DELETE', `/api/scenes/${N}`)
  let list = (await api.get(B3, '/api/scenes')).json
  ev.check('a deleted scene is listed in GET /api/scenes → trash [{name, title, created, deleted}]', r.status === 200 && list?.trash?.some((x) => x.name === N && x.deleted && 'created' in x) && !list.scenes.some((x) => x.name === N), fmt(list?.trash))
  r = await api.send(B3, 'POST', `/api/scenes/${N}/restore`, null, { forged: true })
  ev.check('W1 POST …/restore without X-Midstudy → 403', r.status === 403, st(r))
  r = await api.send(B3, 'POST', `/api/scenes/${N}/restore`)
  list = (await api.get(B3, '/api/scenes')).json
  ev.check('POST /api/scenes/<name>/restore → 200: back in the list, calibrated, photo served, its layouts back', r.status === 200 && r.json?.name === N && list.scenes.some((x) => x.name === N && x.calib_status === 'done')
    && (await raw(B3, 'GET', `/scenes/${N}/photo.jpg`)).status === 200 && (await api.get(B3, `/api/layouts?scene=${N}`)).json?.layouts?.includes('kept') && !list.trash.some((x) => x.name === N), st(r))
  ev.check('restoring again → 404 (nothing left in the trash)', (r = await api.send(B3, 'POST', `/api/scenes/${N}/restore`)).status === 404, st(r))
  await srv3.stop()
}

// --- verify round 2: privacy and framing (docs/notes/verify-fix-2.md) -----------------------------------------------------------
// A raw TCP exchange that waits for the server to close the connection (or waitMs): {text, ms to the first byte, closedMs}.
const tcpClose = (port, payload, { waitMs = 15000 } = {}) => new Promise((resolve) => {
  const sock = net.connect(port, '127.0.0.1'), t0 = Date.now()
  let got = '', first = null, closed = null
  const timer = setTimeout(() => { sock.destroy(); resolve({ text: got, ms: first, closedMs: closed }) }, waitMs)
  sock.on('data', (d) => { if (first == null) first = Date.now() - t0; got += d.toString('latin1') })
  const end = () => { if (closed == null) closed = Date.now() - t0; clearTimeout(timer); sock.destroy(); resolve({ text: got, ms: first, closedMs: closed }) }
  sock.on('end', end)
  sock.on('close', end)
  sock.on('error', end)
  sock.write(typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload)
})
const line1 = (t) => clip((t.text || '').split('\r\n')[0], 60)

ev.section('verify round 2: APP0 extensions, camera make and model, unreadable sizes')
const srv4 = await startServer(ev, { env: { MIDSTUDY_SOCKET_TIMEOUT: '2' } })
ev.check('a fourth server (stub calibration; MIDSTUDY_SOCKET_TIMEOUT=2 so a stalled body is dropped in 2 s)', srv4.up, srv4.up ? srv4.base : srv4.why)
if (srv4.up) {
  const B4 = srv4.base
  const jfxx = fs.readFileSync(makeImg('jfxx-gps'))
  const up = await uploadScene(B4, jfxx, { filename: 'jfxx.jpg' })
  const s4 = await waitScene(B4, up.json?.scene || '_', 30000)
  const served = s4?.photo_url ? await raw(B4, 'GET', s4.photo_url.split('?')[0]) : null
  if (served?.status === 200) fs.writeFileSync(path.join(META, 'served-jfxx.jpg'), served.buf)
  const sInfo = served?.status === 200 ? meta('inspect', path.join(META, 'served-jfxx.jpg')) : { error: served?.status }
  ev.check('a JPEG with a JFXX APP0 whose thumbnail carries EXIF/GPS: photo.jpg is not passed through and has no APP0 extension (stub ingest)',
    sInfo.clean === true && sInfo.app0_extra === 0 && served && Buffer.compare(served.buf, jfxx) !== 0, fmt(sInfo))
  let r = await api.send(B4, 'PUT', `/api/scenes/${s4?.name}/thumb`, { image: dataUri('image/jpeg', jfxx) })
  const tInfo = r.status === 200 ? (fs.writeFileSync(path.join(META, 'thumb-jfxx.jpg'), (await raw(B4, 'GET', `/scenes/${s4.name}/thumb.jpg`)).buf), meta('inspect', path.join(META, 'thumb-jfxx.jpg'))) : { error: r.status }
  ev.check('…a thumbnail with it is stored and served without the JFXX segment', tInfo.clean === true && tInfo.app0_extra === 0, fmt(tInfo))
  r = await api.send(B4, 'POST', '/api/render', { image: dataUri('image/jpeg', jfxx), scene: s4?.name })
  const rInfo = r.json?.name ? ['', '-input'].map((x) => meta('inspect', path.join(srv4.dirs.renders, `${r.json.name}${x}.jpg`))) : []
  ev.check('…a render composite with it: -input.jpg and the (mock) result carry none of it', r.status === 200 && rInfo.length === 2 && rInfo.every((x) => x.clean && x.app0_extra === 0), fmt({ status: r.status, rInfo }))

  // calib.json keeps the camera's make and model on disk; the API serves neither (the stub's default fallback records them)
  const gps = fs.readFileSync(makeImg('gps-jpeg', ['--from', LIVING.photo]))
  const upG = await uploadScene(B4, gps, { filename: 'IMG_0002.JPG' })
  const G = upG.json?.scene
  await waitScene(B4, G || '_', 30000)
  const disk = (() => { try { return JSON.parse(fs.readFileSync(path.join(srv4.dirs.scenes, G, 'calib.json'), 'utf8')) } catch { return null } })()
  const gotScene = await api.get(B4, `/api/scenes/${G}`)
  const jobsTxt = (await raw(B4, 'GET', '/api/scenes/jobs')).text || ''
  ev.check('the scene API serves no camera make or model (calib.exif without make/model, in GET /api/scenes/<n> and the jobs); calib.json on disk keeps them',
    disk?.exif?.model === 'TestCam GPS' && gotScene.status === 200 && gotScene.json?.calib && !('make' in (gotScene.json.calib.exif || {})) && !('model' in (gotScene.json.calib.exif || {}))
      && !/TestCam/.test(JSON.stringify(gotScene.json)) && !/TestCam/.test(jobsTxt),
    fmt({ disk: disk?.exif, served: gotScene.json?.calib?.exif, jobsLeak: /TestCam/.test(jobsTxt) }))

  // framing
  let t = await tcpClose(srv4.port, `POST /api/scenes HTTP/1.1\r\nHost: 127.0.0.1:${srv4.port}\r\nX-Midstudy: 1\r\nX-Midstudy-Filename: a.jpg\r\nContent-Length: \xb2\r\nConnection: close\r\n\r\n`, { waitMs: 6000 })
  ev.check('Content-Length "²" (a latin-1 digit) → 400 with one sentence, not a 500 with a Python exception', /^HTTP\/1\.[01] 400/.test(t.text) && !/ValueError|invalid literal/.test(t.text), `${line1(t)} ${clip(t.text.split('\r\n\r\n')[1], 100)}`)
  const libMeta = Buffer.from(JSON.stringify({ name: 'Box', dims_cm: { w: 1, d: 1, h: 1 }, engine: 'glb' })).toString('base64')
  t = await tcpClose(srv4.port, `POST /api/library/items HTTP/1.1\r\nHost: 127.0.0.1:${srv4.port}\r\nX-Midstudy: 1\r\nX-Midstudy-Kind: model\r\nX-Midstudy-Filename: a.glb\r\nX-Midstudy-Meta: ${libMeta}\r\nContent-Length: \xb9\r\nConnection: close\r\n\r\n`, { waitMs: 6000 })
  ev.check('…the same on POST /api/library/items ("¹")', /^HTTP\/1\.[01] 400/.test(t.text) && !/ValueError/.test(t.text), line1(t))
  t = await tcpClose(srv4.port, Buffer.concat([Buffer.from(`POST /api/scenes HTTP/1.1\r\nHost: 127.0.0.1:${srv4.port}\r\nX-Midstudy: 1\r\nX-Midstudy-Filename: a.jpg\r\nContent-Length: 1000\r\n\r\n`), livingBytes.subarray(0, 10)]), { waitMs: 8000 })
  ev.check('an upload that stalls (10 of 1000 bytes) is dropped after the socket timeout with a 408 sentence, not a 500', /^HTTP\/1\.[01] 408/.test(t.text) && !/TimeoutError/.test(t.text) && t.closedMs != null && t.closedMs < 6000,
    `${line1(t)} after ${t.ms} ms, closed at ${t.closedMs} ms; ${clip(t.text.split('\r\n\r\n')[1], 100)}`)
  t = await tcpClose(srv4.port, 'GET /api/spend HTTP/1.0\r\n\r\n', { waitMs: 4000 })
  ev.check('a request with no Host header → 403', /^HTTP\/1\.[01] 403/.test(t.text), line1(t))
  await srv4.stop()
}

const srv5 = await startServer(ev, { spendUsd: '0.05', mockCost: true })
ev.check('a fifth server: --daily-spend-usd 0.05, MIDSTUDY_FAL_MOCK_COST=1 (mocked, $0 really), default 30 s socket timeout', srv5.up, srv5.up ? srv5.base : srv5.why)
if (srv5.up) {
  const B5 = srv5.base
  const costs0 = fs.readFileSync(srv5.dirs.costs, 'utf8')
  const big = fs.readFileSync(makeImg('big12mp')), bigRst = fs.readFileSync(makeImg('big12mp-rst'))
  let r = await api.send(B5, 'POST', '/api/render', { image: dataUri('image/jpeg', big), model: 'qwen' })
  ev.check('qwen on a 4000 × 3000 composite costs $0.36: more than the $0.05 cap → 402', r.status === 402 && /0\.36/.test(r.json?.error || ''), st(r))
  r = await api.send(B5, 'POST', '/api/render', { image: dataUri('image/jpeg', bigRst), model: 'qwen' })
  ev.check('…the same JPEG with a parameterless RST0 after SOI is still read as 12 MP → 402 (not priced at 1 MP)', r.status === 402 && /0\.36/.test(r.json?.error || ''), st(r))
  const noSof = Buffer.from(big)
  const sof = noSof.indexOf(Buffer.from([0xff, 0xc0]))
  noSof[sof + 1] = 0xe5 // the frame header becomes an APP5 segment, which the server drops: no size to read
  r = await api.send(B5, 'POST', '/api/render', { image: dataUri('image/jpeg', noSof), model: 'qwen' })
  ev.check('a composite whose size can\'t be read from its frame header → 400, no call', r.status === 400 && /size/.test(r.json?.error || ''), st(r))
  ev.check('no cost rows, no render files from these', fs.readFileSync(srv5.dirs.costs, 'utf8') === costs0 && fs.readdirSync(srv5.dirs.renders).length === 0, fmt(fs.readdirSync(srv5.dirs.renders)))
  const t = await tcpClose(srv5.port, `POST /api/scenes HTTP/1.1\r\nHost: 127.0.0.1:${srv5.port}\r\nX-Midstudy: 1\r\nX-Midstudy-Filename: big.jpg\r\nContent-Length: ${25 * 1024 * 1024 + 1}\r\n\r\n`, { waitMs: 20000 })
  ev.check('after an early 413 to a client that then sends nothing, the server closes within the 5 s drain (not the 30 s socket timeout)',
    /^HTTP\/1\.[01] 413/.test(t.text) && t.ms < 2500 && t.closedMs != null && t.closedMs < 7500, `${line1(t)} at ${t.ms} ms, closed at ${t.closedMs} ms`)
  await srv5.stop()
}

// the server's command (the harness's), as startServer runs it
const badCmd = serverCommand(['--port', '0', '--daily-spend-usd', '0', '--allowed-host', 'https://midstudy.example.com', '--calib', 'python3 fixtures/stub_calib.py'])
const bad = spawnSync(badCmd.cmd, badCmd.args,
  { cwd: REPO, encoding: 'utf8', timeout: 15000, env: { ...process.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'), FAL_KEY: '' } })
ev.check('a malformed --allowed-host (a URL) is refused at startup (it would have allowed a missing or malformed Host)', bad.status !== 0 && bad.signal == null && /allowed-host/.test(bad.stderr || ''),
  `exit ${bad.status ?? bad.signal}: ${clip((bad.stderr || '').trim().split('\n').at(-1), 200)}`)

ev.section('verify round 1: the spend cap reads the file midstudy-add writes')
const other = path.join(ev.out, 'other-costs.csv')
const runCmd = serverCommand(['--port', '0', '--daily-spend-usd', '0', '--costs-file', other, '--calib', 'python3 fixtures/stub_calib.py'])
const run = spawnSync(runCmd.cmd, runCmd.args,
  { cwd: REPO, encoding: 'utf8', timeout: 15000, env: { ...process.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'), FAL_KEY: '' } })
ev.check('--costs-file that isn\'t <library-dir>/costs.csv is refused even without --library-dir (adds would be uncapped)', run.status !== 0 && run.signal == null && /costs-file/.test(run.stderr || ''),
  `exit ${run.status ?? run.signal}: ${clip((run.stderr || '').trim(), 200)}`)
await ev.finish()
