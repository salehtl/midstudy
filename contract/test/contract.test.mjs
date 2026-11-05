// The contract's own tests (node --test contract/test/): the schemas compile in strict mode, routes.json names only
// real schemas, contract/gen/ is what scripts/gen-contract.mjs makes of them, every recorded example passes its
// generated validator (and the source schema), and the validators refuse what the contract refuses.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { CONTRACT, loadRoutes, loadSchemas, makeAjv, matchRoute, responseSchema } from '../tools/schemas.mjs'
import { generate, schemaTypeNames } from '../../scripts/gen-contract.mjs'
import * as gen from '../gen/validate.js'

const ajv = makeAjv()
const routes = loadRoutes()
const TYPES = schemaTypeNames()
const examples = fs.readdirSync(path.join(CONTRACT, 'examples')).filter((f) => f.endsWith('.json')).sort()
  .flatMap((f) => JSON.parse(fs.readFileSync(path.join(CONTRACT, 'examples', f), 'utf8')).examples.map((e, i) => ({ ...e, file: f, i })))

test('every schema compiles in strict mode, with an $id that is its path', () => {
  for (const { schema } of loadSchemas()) assert.ok(ajv.getSchema(schema.$id), schema.$id)
})

test('routes.json names only schemas that exist, and every route has a success answer', () => {
  for (const r of routes.routes) {
    const uris = [...Object.values(r.responses), r.request?.body, ...Object.values(r.request?.headers || {})].filter((u) => u && u !== 'raw')
    for (const u of uris) assert.ok(ajv.getSchema(u), `${r.method} ${r.path}: ${u}`)
    assert.ok(Object.keys(r.responses).some((s) => /^2/.test(s)), `${r.method} ${r.path} has no 2xx`)
  }
  assert.ok(ajv.getSchema(routes.errors))
})

test('routes match the paths the planner and evals use, first match wins', () => {
  const at = (m, p) => matchRoute(routes, m, p)?.route.path
  assert.equal(at('GET', '/api/scenes/jobs'), '/api/scenes/jobs')
  assert.equal(at('GET', '/api/scenes/jobs/c-1'), '/api/scenes/jobs/{id}')
  assert.equal(at('GET', '/api/scenes/scene-20261104-201500'), '/api/scenes/{name}')
  assert.equal(at('POST', '/api/library/items/from-url'), '/api/library/items/from-url')
  assert.equal(at('PUT', '/api/layouts/front?scene=scene-1'), '/api/layouts/{layout}')
  assert.equal(at('GET', '/api/nope'), undefined)
  const product = matchRoute(routes, 'POST', '/api/library/product').route
  assert.equal(responseSchema(routes, product, 422), 'midstudy/api/product-error.schema.json')
  assert.equal(responseSchema(routes, product, 500), routes.errors)
  assert.equal(responseSchema(routes, product, 201), null)
})

test('contract/gen/ and the Rust bundle are up to date (node scripts/gen-contract.mjs)', () => {
  for (const [file, text] of Object.entries(generate())) assert.equal(fs.readFileSync(file, 'utf8'), text, `${file} is out of date`)
})

test('there are examples of every route', () => {
  const seen = new Set(examples.map((e) => e.file))
  for (const r of routes.routes) assert.ok(seen.has(`${r.method.toLowerCase()}${r.path.replace(/[{}]/g, '').replace(/\//g, '-')}.json`), `${r.method} ${r.path}`)
})

test('every example passes its generated validator and its source schema, and names its type', () => {
  assert.ok(examples.length > 80, `${examples.length} examples`)
  for (const e of examples) {
    const where = `${e.file} #${e.i} (${e.kind} ${e.status ?? ''} ${e.schema})`
    const v = gen.validators[e.schema]
    assert.ok(v, `${where}: no generated validator`)
    assert.ok(v(e.body), `${where}: ${JSON.stringify(v.errors)}`)
    assert.ok(ajv.getSchema(e.schema)(e.body), where)
    assert.equal(e.type, TYPES[e.schema], where)
    assert.equal(gen[`is${e.type}`], v, `${where}: is${e.type} is that validator`)
  }
})

// The source schemas whose root is a closed object (additionalProperties: false).
const closed = (uri) => {
  let s = ajv.getSchema(uri).schema
  return s && s.type === 'object' && s.additionalProperties === false
}
test('the validators refuse an unknown key and a missing required key on every closed answer', () => {
  let n = 0
  for (const e of examples.filter((x) => x.body && typeof x.body === 'object' && !Array.isArray(x.body) && closed(x.schema))) {
    const v = gen.validators[e.schema]
    assert.equal(v({ ...e.body, zz_unknown: 1 }), false, `${e.file} #${e.i}: an unknown key passed`)
    for (const k of ajv.getSchema(e.schema).schema.required || []) {
      const { [k]: _, ...rest } = e.body
      assert.equal(v(rest), false, `${e.file} #${e.i}: without ${k} it passed`)
    }
    n++
  }
  assert.ok(n > 60, `${n} closed examples`)
})

const first = (file, pred = () => true) => structuredClone(examples.find((e) => e.file === file && e.kind === 'response' && pred(e)).body)
test('the validators refuse what the contract refuses', () => {
  const detail = first('get-api-scenes-name.json', (e) => e.status === 200)
  const calib = detail.calib
  assert.ok(gen.isPublicCalib(calib))
  assert.ok(gen.isCalib({ ...calib, exif: { focal_35mm: 26, make: 'Apple' } }), 'calib.json may hold the make')
  assert.equal(gen.isPublicCalib({ ...calib, exif: { focal_35mm: 26, make: 'Apple' } }), false, 'the API never serves the make')
  assert.equal(gen.isPublicCalib({ ...calib, exif: { model: 'iPhone' } }), false, 'nor the model')
  assert.ok(gen.isPublicCalib({ ...calib, exif: { focal_35mm: 26, fov_y_deg: 51.2 } }))
  assert.equal(gen.isPublicCalib({ ...calib, ok: true }), false, 'ok is stdout only')
  assert.equal(gen.isSceneDetail({ ...detail, calib: { ...calib, exif: { make: 'Apple' } } }), false)
  assert.equal(gen.isSceneDetail({ ...detail, lighting_status: 'unknown' }), false)
  assert.equal(gen.isSceneDetail({ ...detail, camera: { ...detail.camera, fov_y_deg: 140 } }), false, 'camera ranges')
  assert.equal(gen.isSceneDetail({ ...detail, photo_url: '/scenes/x/source.jpg' }), false)
  assert.equal(gen.isSceneDetail({ ...detail, created: '05/11/2026' }), false, 'date-time')
  assert.equal(gen.isSceneObject({ ...first('get-api-scenes.json', (e) => e.body.scenes.length).scenes[0], calib_status: 'ok' }), false)
  const job = first('get-api-scenes-jobs-id.json', (e) => e.body?.kind === 'light')
  assert.ok(gen.isLightJob(job) && gen.isSceneJob(job) && !gen.isCalibrationJob(job))
  assert.equal(gen.isLightJob({ ...job, calib: calib }), false, 'a light job never carries calib')
  const meta = first('post-api-render.json', (e) => e.status === 200)
  assert.equal(gen.isRenderMeta({ ...meta, model: 'dall-e' }), false)
  assert.equal(gen.isRenderMeta({ ...meta, cost_usd: -1 }), false)
  assert.equal(gen.isRenderRequest({ image: 'data:image/png;base64,AAAA' }), false, 'a render is a JPEG')
  assert.equal(gen.isRenderRequest({ image: 'data:image/jpeg;base64,AAAA', size: 2 }), false)
  const spend = first('get-api-spend.json')
  assert.equal(gen.isSpend({ ...spend, day: '2026-11-5' }), false)
  assert.equal(gen.isSpendRefused({ error: 'over', spent_usd: 0 }), false, '402 names the cap')
  assert.equal(gen.isApiError({ error: '' }), false, 'one sentence')
  assert.equal(gen.isProductRequest({ llm: true }), false, 'url or html')
  assert.ok(gen.isProductRequest({ html: '<html>', llm: false }))
  const product = first('post-api-library-product.json', (e) => e.status === 200)
  assert.equal(gen.isProductResult({ ...product, images: Array(13).fill(product.images[0] ?? { url: 'https://a/b.jpg', w: null, h: null, kind: 'og' }) }), false, 'at most 12 pictures')
  assert.equal(gen.isProductResult({ ...product, category: 'futon' }), false, 'the listed categories')
  assert.equal(gen.isProductError({ error: 'x', blocked: false }), false, 'blocked is only ever true')
  assert.equal(gen.isLibraryMeta({ name: ' ', dims_cm: { w: 1, d: 1, h: 1 } }), false, 'a blank name')
  assert.equal(gen.isLibraryMeta({ name: 'x', dims_cm: { w: 0, d: 1, h: 1 } }), false, 'dims > 0')
  assert.equal(gen.isLibraryPatch({}), false, 'a patch changes something')
  assert.equal(gen.isLibraryPatch({ yaw: 45 }), false)
  assert.equal(gen.isScenePut({ look: { exposure: 'bright' } }), false)
  assert.ok(gen.isScenePut({ look: { exposure: 9, warmth: null } }), 'numbers are clamped, null removes')
  assert.equal(gen.isLayoutList({ layouts: ['Bad Name'], details: [] }), false)
})

test('violation() names the schema and the path, for strict mode', () => {
  assert.equal(gen.violation('midstudy/api/spend.schema.json', first('get-api-spend.json')), null)
  const v = gen.violation('midstudy/api/spend.schema.json', { day: '2026-11-05', spent_usd: 0, reserved_usd: 0, cap_usd: -2 })
  assert.deepEqual([v.schema, v.path], ['midstudy/api/spend.schema.json', '/cap_usd'])
  assert.match(gen.violation('midstudy/api/error.schema.json', { error: 'x', extra: 1 }).message, /extra/)
  assert.equal(gen.violation('midstudy/nope.schema.json', {}).message, 'no such schema')
})

test('the file schemas still accept the golden fixtures and the probe library', () => {
  for (const id of ['living-wide', 'steep-roll', 'portrait', 'living-cool', 'living-warm']) {
    const dir = path.join(CONTRACT, '../fixtures/scenes', id)
    assert.ok(gen.isCalib(JSON.parse(fs.readFileSync(path.join(dir, 'calib.json'), 'utf8'))), `${id} calib.json`)
    assert.ok(gen.isLighting(JSON.parse(fs.readFileSync(path.join(dir, 'lighting.json'), 'utf8'))), `${id} lighting.json`)
  }
  assert.ok(gen.isLibrary(JSON.parse(fs.readFileSync(path.join(CONTRACT, '../fixtures/library/library.json'), 'utf8'))))
})
