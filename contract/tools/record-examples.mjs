// Records contract/examples/<route>.json: real requests and answers of every /api route, from the server the eval
// harness starts (node server/src/main.ts in strict mode), with the eval mocks (fal mocked, $0; the calib
// stub with MIDSTUDY_CALIB_MOCK; the made-up shop pages of fixtures/product-pages). Only fixtures go in: the golden
// scenes, fixtures/models, fixtures/fal; never fixtures/photos/. Each answer is checked against the schema
// contract/api/routes.json names for it, and the run fails when one doesn't match.
//
// Usage: nix develop -c node contract/tools/record-examples.mjs [--check]
//   --check: record and validate into evals/out/contract-examples/examples/, leaving contract/examples/ as it is.
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  createEval, startServer, waitScene, waitFor, raw, api, b64json, dataUri, maskPng, golden, sleep, clip, SERVER_CMD, ADD_CMD,
} from '../../evals/lib/harness.mjs'
import { syntheticPages, startPagesServer } from '../../evals/lib/pages_server.mjs'
import { makeAjv, loadRoutes, matchRoute, responseSchema, errorText, REPO, CONTRACT } from './schemas.mjs'
import { schemaTypeNames } from '../../scripts/gen-contract.mjs'

const CHECK = process.argv.includes('--check')
const ev = createEval('X1', 'contract-examples', { timeoutS: 600 })
const OUT_DIR = CHECK ? path.join(ev.out, 'examples') : path.join(CONTRACT, 'examples')
const ajv = makeAjv()
const routes = loadRoutes()
const TYPES = schemaTypeNames()
const files = new Map() // file name → {route, contract, examples}
let problems = 0

// A small JPEG (from a golden photo, through Pillow) for request bodies: the examples stay readable.
const tinyJpeg = (() => {
  const out = path.join(ev.out, 'tiny.jpg')
  execFileSync(path.join(REPO, 'evals/py'), ['-c', `from PIL import Image; Image.open(${JSON.stringify(golden('living-wide').photo)}).resize((32, 24)).save(${JSON.stringify(out)}, quality=60)`])
  return fs.readFileSync(out)
})()
const TINY = dataUri('image/jpeg', tinyJpeg)

const fileFor = (route) => `${route.method.toLowerCase()}${route.path.replace(/[{}]/g, '').replace(/\//g, '-')}.json`

// A file or stdout line that has a schema but no route: checked like an answer, kept in <file>.
function keep(file, title, kind, schema, body, note) {
  const v = ajv.getSchema(schema)
  const ok = v(body)
  if (!ok) problems++
  ev.check(`${kind} matches ${schema}${note ? ` (${note})` : ''}`, ok, ok ? 'valid' : errorText(v.errors))
  if (!ok) return
  if (!files.has(file)) files.set(file, { route: title, contract: null, examples: [] })
  files.get(file).examples.push({ kind, schema, type: TYPES[schema], note: note || null, body })
}
const trashed = (dir, file) => fs.readdirSync(path.join(dir, '.trash')).map((d) => path.join(dir, '.trash', d, file)).filter((f) => fs.existsSync(f))

// One call; the answer (and, for a 2xx, the JSON request) becomes an example of its route.
async function call(method, p, body, { note, headers = {}, forged = false, meta, rawBody, keep = true, timeoutMs = 60000 } = {}) {
  const h = { ...(forged ? {} : { 'X-Midstudy': '1' }), ...headers }
  if (meta !== undefined) h['X-Midstudy-Meta'] = b64json(meta)
  let r
  if (rawBody) r = await raw(B, method, p, { headers: { 'Content-Type': 'application/octet-stream', ...h }, body: rawBody, timeoutMs })
  else if (body !== undefined) r = await raw(B, method, p, { headers: { 'Content-Type': 'application/json', ...h }, body, timeoutMs })
  else r = await raw(B, method, p, { headers: h, timeoutMs })
  const m = matchRoute(routes, method, p)
  if (!m) { problems++; ev.check(`${method} ${p} has a route in routes.json`, false, `${r.status}`); return r }
  const schema = responseSchema(routes, m.route, r.status)
  const ok = schema && r.json !== null && ajv.getSchema(schema)(r.json)
  const why = !schema ? `status ${r.status} isn't one the contract allows` : r.json === null ? `not JSON: ${clip(r.text, 120)}` : ok ? 'valid' : errorText(ajv.getSchema(schema).errors)
  if (!ok) problems++
  ev.check(`${method} ${p.split('?')[0]} → ${r.status} matches ${schema || '(no schema)'}${note ? ` (${note})` : ''}`, ok, why)
  if (!keep || !ok) return r
  const file = fileFor(m.route)
  if (!files.has(file)) files.set(file, { route: `${m.route.method} ${m.route.path}`, contract: m.route.contract, examples: [] })
  const exs = files.get(file).examples
  const reqSchema = m.route.request?.body
  if (r.status < 300 && reqSchema && reqSchema !== 'raw' && body !== undefined) {
    const v = ajv.getSchema(reqSchema)
    if (!v(body)) { problems++; ev.check(`the request of ${method} ${p} matches ${reqSchema}`, false, errorText(v.errors)) }
    else exs.push({ kind: 'request', schema: reqSchema, type: TYPES[reqSchema], note: note || null, body })
  }
  const metaSchema = m.route.request?.headers?.['X-Midstudy-Meta']
  if (r.status < 300 && metaSchema && meta !== undefined) {
    const v = ajv.getSchema(metaSchema)
    if (!v(meta)) { problems++; ev.check(`the X-Midstudy-Meta of ${method} ${p} matches ${metaSchema}`, false, errorText(v.errors)) }
    else exs.push({ kind: 'header X-Midstudy-Meta', schema: metaSchema, type: TYPES[metaSchema], note: note || null, body: meta })
  }
  exs.push({ kind: 'response', status: r.status, schema, type: TYPES[schema], note: note || null, body: r.json })
  return r
}

// --- servers --------------------------------------------------------------------------------------------------------
const synth = syntheticPages()
const pages = await startPagesServer({ routes: synth.routes, dir: synth.dir })
ev.onCleanup(pages.stop)
const srv = await startServer(ev, { env: { MIDSTUDY_FETCH_ALLOW: `127.0.0.1:${pages.port}` } })
ev.check(`the server starts (${SERVER_CMD.join(' ')}, furniture CLI ${ADD_CMD})`, srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish(1)
let B = srv.base
const LW = golden('living-wide'), PT = golden('portrait')
const photoW = LW.truth.image.w, photoH = LW.truth.image.h
const jobDone = (p) => waitFor(async () => { const r = await api.get(B, p); return ['done', 'failed'].includes(r.json?.status) ? r.json : null }, { timeoutMs: 120000, intervalMs: 300 })

ev.section('money')
await call('GET', '/api/spend')

ev.section('scenes (§4.4)')
await call('GET', '/api/scenes', undefined, { note: 'no scenes yet' })
let r = await call('POST', '/api/scenes', undefined, { rawBody: fs.readFileSync(LW.photo), headers: { 'X-Midstudy-Filename': 'living-wide.jpg' }, meta: { title: 'Living room' }, note: 'a golden photo' })
const A = r.json?.scene
await call('POST', '/api/scenes', undefined, { rawBody: Buffer.from('not a photo'), headers: { 'X-Midstudy-Filename': 'notes.txt' }, note: 'not an image' })
await waitScene(B, A)
await call('GET', `/api/scenes/${A}`, undefined, { note: 'calibrated (calib mock: the true camera), lighting.json from the mock' })
await call('GET', '/api/scenes/scene-20000101-000000', undefined, { note: 'unknown scene' })
await call('GET', '/api/scenes/jobs')
await call('GET', `/api/scenes/jobs/${r.json?.job?.id}`, undefined, { note: 'a finished calibration' })
await call('GET', '/api/scenes/jobs/c-nope', undefined, { note: 'unknown job' })
await call('PUT', `/api/scenes/${A}`, { title: 'Living room, morning', camera: { height_m: 1.45, pitch_deg: -11 }, camera_source: 'manual', look: { exposure: 1.2, warmth: 0.1, light_azimuth_deg: 30, auto_light: false, cast_shadows: true } }, { note: 'rename, camera, look' })
await call('PUT', `/api/scenes/${A}`, { look: { exposure: 9, light_azimuth_deg: null } }, { note: 'a look number clamped, a key removed' })
await call('PUT', `/api/scenes/${A}`, { zoom: 2 }, { note: 'an unknown key' })
await call('PUT', `/api/scenes/${A}/thumb`, { image: TINY }, { note: 'the planner\'s thumbnail' })
await call('PUT', `/api/scenes/${A}/thumb`, { image: 'data:image/png;base64,AAAA' }, { note: 'not a JPEG' })
await call('POST', `/api/scenes/${A}/light`, undefined, { note: 'lighting.json is there: no job' })
fs.rmSync(path.join(srv.dirs.scenes, A, 'lighting.json'), { force: true })
r = await call('POST', `/api/scenes/${A}/light`, undefined, { note: 'a scene calibrated before lighting.json (backfill)' })
const lightJob = r.json?.job?.id
if (lightJob) {
  await jobDone(`/api/scenes/jobs/${lightJob}`)
  await call('GET', `/api/scenes/jobs/${lightJob}`, undefined, { note: 'a finished light job' })
}
r = await call('POST', `/api/scenes/${A}/calibrate`, undefined, { note: 'recalibrate' })
const again = await call('POST', `/api/scenes/${A}/calibrate`, undefined, { note: 'while one is queued or running', keep: true })
if (again.status !== 409) ev.note(`the second calibrate answered ${again.status} (the first had finished): no 409 example`)
if (r.json?.job?.id) await jobDone(`/api/scenes/jobs/${r.json.job.id}`)
await call('GET', '/api/scenes/jobs', undefined, { note: 'calibration and light jobs' })
r = await call('POST', '/api/scenes', undefined, { rawBody: fs.readFileSync(PT.photo), headers: { 'X-Midstudy-Filename': 'portrait.jpg' }, note: 'no title' })
const P = r.json?.scene
await waitScene(B, P)
await call('DELETE', `/api/scenes/${P}`, undefined, { note: 'to the trash' })
for (const f of trashed(srv.dirs.scenes, 'trash.json')) keep('files-trash.json', 'files beside a deleted scene or library item', 'file scenes/.trash/<name>-<stamp>/trash.json', 'midstudy/trash.schema.json#/$defs/scene', JSON.parse(fs.readFileSync(f, 'utf8')), 'a deleted scene')
await call('GET', '/api/scenes', undefined, { note: 'one scene, one in the trash' })
await call('POST', `/api/scenes/${P}/restore`, undefined, { note: 'back from the trash' })
await call('POST', `/api/scenes/${P}/restore`, undefined, { note: 'none left in the trash' })
await call('GET', '/api/scenes', undefined, { note: 'two scenes' })

ev.section('layouts (§2.7)')
const layout = { version: 1, name: 'front', title: 'Front', scene_name: A, library: '/library/library.json', items: [
  { uid: 'probe-box-1', id: 'probe-box', render: 'glb', position: [0.4, 0, -2.6], rotation_y_deg: 15, dims_cm: { w: 80, d: 50, h: 120 } },
  { uid: 'gone-1', id: 'deleted-chair', render: 'glb', position: [-0.8, 0.45, -3.1], rotation_y_deg: -90, dims_cm: { w: 60, d: 60, h: 80 } }] }
await call('PUT', `/api/layouts/front?scene=${A}`, layout, { note: 'as the planner saves it' })
await call('PUT', `/api/layouts/corner?scene=${A}`, { items: [{ id: 'probe-box', position: [1, 0, -2] }] }, { note: 'the least v1 takes: uid, render, rotation filled in' })
await call('PUT', `/api/layouts/Bad%20Name?scene=${A}`, { items: [] }, { note: 'not a slug' })
await call('GET', `/api/layouts?scene=${A}`)
await call('GET', '/api/layouts', undefined, { note: 'no scene' })
await call('GET', `/api/layouts/front?scene=${A}`)
await call('GET', `/api/layouts/nope?scene=${A}`, undefined, { note: 'no such layout' })
await call('DELETE', `/api/layouts/corner?scene=${A}`)

ev.section('render (§2.6, §4.7)')
await call('POST', '/api/render', { image: TINY, scene: A, layout: 'front' }, { note: 'nano-banana with the scene photo as reference (mock: the result is the input)' })
await call('POST', '/api/render', { image: TINY, model: 'kontext', prompt: 'Make it photoreal.', scene: A }, { note: 'kontext, a given prompt' })
const mask = maskPng(photoW, photoH, [[600, 500, 1000, 1000]])
await call('POST', '/api/render', { image: TINY, scene: A, layout: 'front', keep_room: true, mask: dataUri('image/png', mask) }, { note: 'keep room (the calib stub\'s align never applies)' })
await call('POST', '/api/render', { image: 'data:image/jpeg;base64,AAAA' }, { note: 'not a JPEG' })
await call('POST', '/api/render', { image: TINY, scene: 'scene-20000101-000000' }, { note: 'unknown scene' })
await call('POST', '/api/render', { image: TINY }, { forged: true, note: 'no X-Midstudy: refused (§2.9)' })
await call('GET', '/api/renders')
await call('GET', `/api/renders?scene=${A}`)

ev.section('rooms (§4.9)')
{
  const R1 = golden('room-1'), R2 = golden('room-2')
  await call('GET', '/api/rooms', undefined, { note: 'no rooms yet' })
  const up = async (g, file) => (await raw(B, 'POST', '/api/scenes', { headers: { 'X-Midstudy': '1', 'Content-Type': 'application/octet-stream', 'X-Midstudy-Filename': file }, body: fs.readFileSync(g.photo) })).json?.scene
  const S1 = await up(R1, 'room-1.jpg')
  await waitScene(B, S1)
  const S2 = await up(R2, 'room-2.jpg')
  // the golden pair (living-wide, room-1) has a recorded answer in fixtures/calib/rooms/: the calib mock gives the true pose
  r = await call('POST', '/api/rooms', { title: 'Living room', scenes: [A, S1] }, { note: 'two photos: the first is the origin, the other unplaced' })
  const RM = r.json?.name
  await call('POST', '/api/rooms', { scenes: [S2, S2] }, { note: 'a scene twice' })
  await call('POST', '/api/rooms', { scenes: ['scene-20000101-000000'] }, { note: 'an unknown scene' })
  await call('POST', '/api/rooms', { scenes: [S1] }, { note: 'a scene in another room' })
  r = await call('POST', `/api/rooms/${RM}/align`, undefined, { note: 'as the planner asks after New room' })
  const al1 = r.json?.job?.id
  const busy = await call('POST', `/api/rooms/${RM}/align`, {}, { note: 'while one is queued or running' })
  if (busy.status !== 409) ev.note(`the second align answered ${busy.status} (the first had finished): no 409 example`)
  if (al1) { await jobDone(`/api/rooms/jobs/${al1}`); await call('GET', `/api/rooms/jobs/${al1}`, undefined, { note: 'done: the calib mock\'s true pose' }) }
  await call('GET', '/api/rooms/jobs/a-nope', undefined, { note: 'unknown job' })
  await call('GET', `/api/rooms/${RM}`, undefined, { note: 'aligned' })
  await call('GET', '/api/rooms/room-20000101-000000', undefined, { note: 'unknown room' })
  const roomDir = path.join(srv.dirs.data, 'rooms', RM)
  for (const [f, schema] of [['room.json', 'midstudy/room.schema.json'], ['align.json', 'midstudy/align.schema.json']]) {
    const p = path.join(roomDir, f)
    if (fs.existsSync(p)) keep(`files-${f}`, `rooms/<room>/${f}`, `file rooms/<room>/${f}`, schema, JSON.parse(fs.readFileSync(p, 'utf8')), f === 'align.json' ? 'the calib mock\'s answer for the golden pair' : 'an aligned room')
  }
  await call('PUT', `/api/rooms/${RM}`, { members: [{ scene: A }, { scene: S1, pose: { x_m: 1.2, z_m: 0.4, yaw_deg: 25 } }] }, { note: 'Align photos: the second photo dragged and turned' })
  await call('PUT', `/api/rooms/${RM}`, { title: 'Living room, both ends' }, { note: 'rename' })
  await call('PUT', `/api/rooms/${RM}`, { reset: [S1] }, { note: 'Align photos\' Reset' })
  await call('PUT', `/api/rooms/${RM}`, { rescale: 1.04 }, { note: 'Set scale: the tape says 4 % longer' })
  await call('PUT', `/api/rooms/${RM}`, { zoom: 2 }, { note: 'an unknown key' })
  await waitScene(B, S2)
  await call('PUT', `/api/rooms/${RM}`, { members: [{ scene: A }, { scene: S2 }, { scene: S1 }] }, { note: 'add a photo (unplaced) and reorder' })
  r = await call('POST', `/api/rooms/${RM}/align`, { overwrite_manual: false }, { note: 'align again, keeping poses moved by hand' })
  if (r.json?.job?.id) await jobDone(`/api/rooms/jobs/${r.json.job.id}`)
  await call('GET', '/api/rooms/jobs', undefined, { note: 'two align jobs' })

  ev.section('room layouts (§2.7 with ?room=) and render with a room (§4.7)')
  await call('PUT', `/api/layouts/plan?room=${RM}`, { items: [{ uid: 'probe-box-1', id: 'probe-box', render: 'glb', position: [0.3, 0, -2.5], rotation_y_deg: 10, dims_cm: { w: 80, d: 50, h: 120 } }] }, { note: 'a room layout: positions in the room frame' })
  await call('GET', `/api/layouts?room=${RM}`, undefined, { note: 'a room\'s layouts' })
  await call('GET', `/api/layouts/plan?room=${RM}`, undefined, { note: 'a room layout' })
  await call('GET', `/api/layouts?scene=${A}&room=${RM}`, undefined, { note: 'both scene and room' })
  await call('POST', '/api/render', { image: TINY, scene: S1, room: RM, layout: 'plan' }, { note: 'a room view: the current photo, the room and its layout' })
  await call('GET', `/api/renders?room=${RM}`, undefined, { note: 'a room\'s renders' })
  await call('PUT', `/api/layouts/spare?room=${RM}`, { items: [] }, { note: 'an empty room layout' })
  await call('DELETE', `/api/layouts/spare?room=${RM}`, undefined, { note: 'a room layout to the room\'s layout trash' })

  ev.section('a member scene deleted and restored; rooms in the trash')
  await call('DELETE', `/api/scenes/${S2}`, undefined, { note: 'a photo of a room: it leaves the room' })
  for (const f of trashed(srv.dirs.scenes, 'trash.json')) {
    const t = JSON.parse(fs.readFileSync(f, 'utf8'))
    if (t.room) keep('files-trash.json', 'files beside a deleted scene or library item', 'file scenes/.trash/<name>-<stamp>/trash.json', 'midstudy/trash.schema.json#/$defs/scene', t, 'a deleted scene that was in a room')
  }
  await call('POST', `/api/scenes/${S2}/restore`, undefined, { note: 'back into its room at its place' })
  r = await call('POST', '/api/rooms', { scenes: [P] }, { note: 'one photo' })
  const RB = r.json?.name
  await call('PUT', `/api/rooms/${RB}`, { reset: [P] }, { note: 'reset before any alignment' })
  await call('POST', `/api/rooms/${RB}/align`, undefined, { note: 'fewer than two photos' })
  await call('DELETE', `/api/rooms/${RB}`, undefined, { note: 'to the trash; the scenes stay' })
  for (const f of trashed(path.join(srv.dirs.data, 'rooms'), 'trash.json')) keep('files-trash.json', 'files beside a deleted scene or library item', 'file rooms/.trash/<room>-<stamp>/trash.json', 'midstudy/trash.schema.json#/$defs/room', JSON.parse(fs.readFileSync(f, 'utf8')), 'a deleted room')
  await call('GET', '/api/rooms', undefined, { note: 'one room, one in the trash' })
  await call('POST', `/api/rooms/${RB}/restore`, undefined, { note: 'back from the trash' })
  await call('POST', `/api/rooms/${RB}/restore`, undefined, { note: 'none left in the trash' })
}

ev.section('library (§2.8)')
await call('GET', '/api/library', undefined, { note: 'the probe library' })
r = await call('POST', '/api/library/items', undefined, { rawBody: fs.readFileSync(path.join(REPO, 'fixtures/models/arrow.glb')), headers: { 'X-Midstudy-Kind': 'model', 'X-Midstudy-Filename': 'arrow.glb' }, meta: { name: 'Arrow sign', dims_cm: { w: 100, d: 40, h: 30 }, category: 'decor' }, note: 'a GLB' })
const arrowJob = r.json?.job?.id
await call('POST', '/api/library/items', undefined, { rawBody: fs.readFileSync(path.join(REPO, 'fixtures/models/arrow.glb')), headers: { 'X-Midstudy-Kind': 'model', 'X-Midstudy-Filename': 'arrow.glb' }, meta: { name: 'Arrow' }, note: 'no dims_cm' })
if (arrowJob) { await jobDone(`/api/library/jobs/${arrowJob}`); await call('GET', `/api/library/jobs/${arrowJob}`, undefined, { note: 'a GLB add, done' }) }
r = await call('POST', '/api/library/items', undefined, { rawBody: fs.readFileSync(path.join(REPO, 'fixtures/fal/sam-3-3d-objects/input.jpg')), headers: { 'X-Midstudy-Kind': 'image', 'X-Midstudy-Filename': 'chair.jpg' }, meta: { name: 'Morris chair', dims_cm: { w: 80, d: 90, h: 95 }, category: 'chair' }, note: 'a photo: Idol, the default engine' })
const idolJob = r.json?.job?.id
r = await call('POST', '/api/library/items/from-url', { image_url: `${pages.base}/media/cane-chair.jpg`, name: 'Cane chair', dims_cm: { w: 75, d: 80, h: 95 }, engine: 'sam3d', prompt: 'chair' }, { note: 'an image link, SAM 3D' })
const urlJob = r.json?.job?.id
await call('POST', '/api/library/items/from-url', { image_url: 'http://127.0.0.1:9/x.jpg', name: 'X', dims_cm: { w: 1, d: 1, h: 1 } }, { note: 'a private address' })
await call('GET', '/api/library/jobs', undefined, { note: 'queued and running jobs' })
if (idolJob) { await jobDone(`/api/library/jobs/${idolJob}`); await call('GET', `/api/library/jobs/${idolJob}`, undefined, { note: 'an Idol add, done: splat, spz, stand-in box' }) }
if (urlJob) { await jobDone(`/api/library/jobs/${urlJob}`); await call('GET', `/api/library/jobs/${urlJob}`, undefined, { note: 'a SAM 3D add from a link, done' }) }
await call('GET', '/api/library/jobs/l-nope', undefined, { note: 'unknown job' })
await call('PATCH', '/api/library/items/arrow-sign', { name: 'Arrow', category: null, mount: 'wall' }, { note: 'edits in place' })
r = await call('PATCH', '/api/library/items/arrow-sign', { dims_cm: { w: 120, d: 40, h: 30 } }, { note: 'new dims: a rescale job ($0)' })
if (r.json?.job?.id) { await jobDone(`/api/library/jobs/${r.json.job.id}`); await call('GET', `/api/library/jobs/${r.json.job.id}`, undefined, { note: 'a rescale, done' }) }
await call('PATCH', '/api/library/items/morris-chair', { default_render: 'glb' }, { note: 'an Idol piece has no mesh to show' })
await call('PATCH', '/api/library/items/no-such-item', { name: 'x' }, { note: 'unknown item' })
await call('PUT', '/api/library/items/arrow-sign/thumb', { image: TINY }, { note: 'the planner\'s render of a 3D-file piece' })
await call('DELETE', '/api/library/items/arrow-sign', undefined, { note: 'to the trash' })
for (const f of trashed(srv.dirs.library, 'entry.json')) keep('files-trash.json', 'files beside a deleted scene or library item', 'file library/.trash/<id>-<stamp>/entry.json', 'midstudy/trash.schema.json#/$defs/item', JSON.parse(fs.readFileSync(f, 'utf8')), 'a deleted GLB piece')
await call('GET', '/api/library', undefined, { note: 'items and the trash' })
await call('POST', '/api/library/items/arrow-sign/restore', undefined, { note: 'back from the trash' })
await call('POST', '/api/library/items/arrow-sign/restore', undefined, { note: 'it exists again' })
await call('POST', '/api/library/items/never-there/restore', undefined, { note: 'never deleted' })

ev.section('product page (§2.11)')
await call('POST', '/api/library/product', { url: `${pages.base}/products/oak-writing-desk` }, { note: 'JSON-LD in cm' })
await call('POST', '/api/library/product', { url: `${pages.base}/products/moss-wool-rug`, llm: false }, { note: 'a Shopify rug with size variants' })
await call('POST', '/api/library/product', { url: `${pages.base}/products/teak-cabinet-prose` }, { note: 'only the (mocked) language model finds the size' })
await call('POST', '/api/library/product', { html: `<!-- midstudy-page: https://shop.example/products/oak-desk -->\n${fs.readFileSync(path.join(REPO, 'fixtures/product-pages/pages/jsonld-cm.html'), 'utf8')}` }, { note: 'a pasted page' })
await call('POST', '/api/library/product', { url: `${pages.base}/blocked` }, { note: 'the shop refuses (403)' })
await call('POST', '/api/library/product', { url: `${pages.base}/picture.jpg` }, { note: 'a picture, not a page' })
await call('POST', '/api/library/product', { llm: true }, { note: 'neither url nor html' })

ev.section('midstudy-add (§3.1): the summary line')
{
  // The furniture CLI the harness gives the server, with the environment the server gives it; a relative --library,
  // so the paths in the line are repo-relative.
  const lib = path.relative(REPO, path.join(ev.out, 'cli-library'))
  const [cmd, ...pre] = ADD_CMD.split(' ')
  const env = { ...process.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'), MIDSTUDY_STRICT: '1' }
  delete env.FAL_KEY
  delete env.MIDSTUDY_FAL_MOCK_COST
  const add = (args, note) => {
    let last = ''
    try { last = execFileSync(cmd, [...pre, ...args, `--library=${lib}`], { cwd: REPO, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 300000 }).trim().split('\n').at(-1) } catch (e) { last = `${e.stderr || e}`.trim().split('\n').at(-1) }
    let body = null
    try { body = JSON.parse(last) } catch { problems++; ev.check(`midstudy-add ${note} prints its summary line`, false, clip(last, 200)); return }
    keep('cli-midstudy-add.json', 'midstudy-add: the last stdout line on success', 'stdout (last line)', 'midstudy/add-summary.schema.json', body, note)
  }
  add(['fixtures/models/arrow.glb', '--engine=glb', '--name=Arrow', '--id=cli-arrow', '--dims=100x40x30'], 'a GLB')
  add(['fixtures/fal/sam-3-3d-objects/input.jpg', '--name=Morris chair', '--id=cli-chair', '--dims=80x90x95'], 'a photo, Idol')
  add(['--rescale=cli-arrow', '--dims=120x40x30'], '--rescale')
}

ev.section('settings (§2.9)')
await call('GET', '/api/settings', undefined, { note: "an agent's server: --daily-spend-usd 0" })
await call('PUT', '/api/settings', { daily_spend_usd: 5 }, { note: 'fixed by --daily-spend-usd' })
const app = await startServer(ev, { appBudget: true })
if (app.up) {
  const save = B
  B = app.base
  await call('GET', '/api/settings', undefined, { note: "the app's budget (no --daily-spend-usd)" })
  await call('PUT', '/api/settings', { daily_spend_usd: 5 }, { note: 'raise the budget' })
  await call('PUT', '/api/settings', { daily_spend_usd: -1 }, { note: 'out of range' })
  B = save
  await app.stop()
}

ev.section('the spend cap (§2.9)')
const capped = await startServer(ev, { spendUsd: '0.03', mockCost: true })
if (capped.up) {
  const save = B
  B = capped.base
  await call('POST', '/api/render', { image: TINY, model: 'kontext' }, { note: 'costs $0.04, more than the $0.03 cap (MIDSTUDY_FAL_MOCK_COST=1)' })
  await call('GET', '/api/spend', undefined, { note: 'a $0.03 cap' })
  B = save
  await capped.stop()
}

// --- write -------------------------------------------------------------------------------------------------------------
fs.mkdirSync(OUT_DIR, { recursive: true })
const leak = /\/Users\/|\/home\/|fixtures\/photos/
for (const [file, doc] of [...files.entries()].sort()) {
  const text = `${JSON.stringify({ ...doc, recorded: `${SERVER_CMD.join(' ')}, contract/tools/record-examples.mjs` }, null, 2)}\n`
  if (leak.test(text)) { problems++; ev.check(`${file} holds no local path or photo`, false, text.match(leak)[0]); continue }
  fs.writeFileSync(path.join(OUT_DIR, file), text)
}
const covered = new Set([...files.values()].map((d) => d.route))
const missing = routes.routes.map((rt) => `${rt.method} ${rt.path}`).filter((k) => !covered.has(k))
ev.check('every route in routes.json has an example', missing.length === 0, missing.length ? missing.join(', ') : `${routes.routes.length} routes (and ${files.size - routes.routes.length} files and stdout lines), ${[...files.values()].reduce((n, d) => n + d.examples.length, 0)} examples in ${path.relative(REPO, OUT_DIR)}`)
ev.check('every answer matched its schema', problems === 0, `${problems} problem(s)`)
await sleep(10)
await ev.finish()
