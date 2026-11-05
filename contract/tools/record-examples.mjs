// Records contract/examples/<route>.json: real requests and answers of every /api route, from the server the eval
// harness starts (MIDSTUDY_SERVER: v1's planner/serve.py by default), with the eval mocks (fal mocked, $0; the calib
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
  createEval, startServer, waitScene, waitFor, raw, api, b64json, dataUri, maskPng, golden, sleep, clip, SERVER, ADD,
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
ev.check(`the server starts (${SERVER}, furniture CLI ${ADD})`, srv.up, srv.up ? srv.base : srv.why)
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
  const text = `${JSON.stringify({ ...doc, recorded: `${SERVER === 'next' ? 'node server/src/main.ts' : 'planner/serve.py'} (MIDSTUDY_SERVER=${SERVER}), contract/tools/record-examples.mjs` }, null, 2)}\n`
  if (leak.test(text)) { problems++; ev.check(`${file} holds no local path or photo`, false, text.match(leak)[0]); continue }
  fs.writeFileSync(path.join(OUT_DIR, file), text)
}
const covered = new Set([...files.values()].map((d) => d.route))
const missing = routes.routes.map((rt) => `${rt.method} ${rt.path}`).filter((k) => !covered.has(k))
ev.check('every route in routes.json has an example', missing.length === 0, missing.length ? missing.join(', ') : `${covered.size} routes, ${[...files.values()].reduce((n, d) => n + d.examples.length, 0)} examples in ${path.relative(REPO, OUT_DIR)}`)
ev.check('every answer matched its schema', problems === 0, `${problems} problem(s)`)
await sleep(10)
await ev.finish()
