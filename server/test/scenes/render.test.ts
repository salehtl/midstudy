// The billed render path (contract §2.6, §2.9), offline: RenderService with a stand-in for fal (no network, no key in
// the environment). What is sent (the data URIs, the reference photo, the arguments), the cost row written once fal
// has answered, even when the download fails, v1's 502 and 503 sentences, and the spend cap before any call.
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FalError } from '../../../common/fal.ts'
import { RenderService, type FalAccess, type RenderJob } from '../../src/scenes/render.ts'
import { renderPrice } from '../../src/scenes/logic/render.ts'
import { SpendCap } from '../../src/spend.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')
const SCRATCH = path.join(REPO, 'evals/out/server-scenes-tests/render')
const LIVING = fs.readFileSync(path.join(REPO, 'fixtures/scenes/living-wide/photo.jpg'))
const PORTRAIT = fs.readFileSync(path.join(REPO, 'fixtures/scenes/portrait/photo.jpg'))
const HEADER = 'date,id,engine,cost_usd,mock,input\n'

interface Call {
  readonly endpoint: string
  readonly args: unknown
  readonly key: string
}

let count = 0

function rig(options: { readonly cap?: number; readonly key?: string | null; readonly answer?: (endpoint: string) => unknown; readonly download?: (url: string) => Promise<Uint8Array> } = {}): {
  readonly renders: RenderService; readonly dir: string; readonly costs: string; readonly calls: Call[]; readonly spend: SpendCap
} {
  count += 1
  const dir = path.join(SCRATCH, String(process.pid) + '-' + String(count))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(path.join(dir, 'renders'), { recursive: true })
  const costs = path.join(dir, 'costs.csv')
  fs.writeFileSync(costs, HEADER)
  const calls: Call[] = []
  const fal: FalAccess = {
    mock: () => false,
    mockCost: () => false,
    key: () => (options.key === undefined ? 'test-key' : options.key),
    call: (endpoint, args, key) => {
      calls.push({ endpoint, args, key })
      const a = options.answer ?? (() => ({ images: [{ url: 'https://fal.example/result.jpg' }] }))
      const v = a(endpoint)
      return v instanceof Error ? Promise.reject(v) : Promise.resolve(v)
    },
    download: options.download ?? (() => Promise.resolve(new Uint8Array(PORTRAIT))),
  }
  const spend = new SpendCap(costs, options.cap ?? 2)
  const renders = new RenderService({
    rendersDir: path.join(dir, 'renders'), costsFile: costs, repo: REPO, calib: ['false'], spend,
    scenePhoto: () => path.join(REPO, 'fixtures/scenes/living-wide/photo.jpg'), fal,
  })
  return { renders, dir, costs, calls, spend }
}

function job(model: RenderJob['model'], extra: Partial<RenderJob> = {}): RenderJob {
  return {
    image: new Uint8Array(LIVING), width: 1600, height: 1200, model, prompt: 'P', scene: 'scene-20261105-120000', layout: null,
    reference: model === 'nano-banana' || model === 'gpt-image' ? new Uint8Array(LIVING) : null, keepRoom: false, mask: null, price: renderPrice(model, 1600, 1200), ...extra,
  }
}

const uri = (b: Buffer): string => 'data:image/jpeg;base64,' + b.toString('base64')
const rows = (costs: string): string[] => fs.readFileSync(costs, 'utf8').slice(HEADER.length).split('\n').filter((l) => l !== '')

void test('gpt-image with the scene: both images, quality medium and image_size auto, an estimated $0.07', async () => {
  const r = rig()
  const out = await r.renders.render(job('gpt-image'))
  assert.equal(out.kind, 'done')
  assert.deepEqual(r.calls, [{ endpoint: 'openai/gpt-image-2/edit', key: 'test-key', args: { image_urls: [uri(LIVING), uri(LIVING)], prompt: 'P', output_format: 'jpeg', quality: 'medium', image_size: 'auto' } }])
  assert.equal(out.meta.cost_usd, 0.07)
})

void test('nano-banana with the scene: both images as data URIs, the result downloaded, the meta and a billed cost row', async () => {
  const r = rig()
  const out = await r.renders.render(job('nano-banana'))
  assert.equal(out.kind, 'done')
  assert.deepEqual(r.calls, [{ endpoint: 'fal-ai/nano-banana/edit', key: 'test-key', args: { image_urls: [uri(LIVING), uri(LIVING)], prompt: 'P', output_format: 'jpeg' } }])
  assert.equal(out.meta.cost_usd, 0.0398)
  assert.equal(out.meta.mock, false)
  assert.equal(out.meta.reference, true)
  assert.deepEqual([out.meta.out_w, out.meta.out_h], [1200, 1600], 'the result\'s own size')
  assert.deepEqual(fs.readFileSync(path.join(r.dir, 'renders', out.meta.name + '.jpg')), PORTRAIT)
  assert.deepEqual(fs.readFileSync(path.join(r.dir, 'renders', out.meta.name + '-input.jpg')), LIVING)
  const [row] = rows(r.costs)
  assert.match(row ?? '', new RegExp('^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z,' + out.meta.name + ',render:nano-banana,0.0398,false,scene-20261105-120000$'))
  assert.equal(r.spend.view().reserved_usd, 0, 'the reservation is released')
})

void test('kontext gets the composite alone (image_url); qwen is priced by the composite\'s megapixels', async () => {
  const r = rig()
  await r.renders.render(job('kontext'))
  const out = await r.renders.render(job('qwen', { scene: null }))
  assert.deepEqual(r.calls.map((c) => c.args), [
    { image_url: uri(LIVING), prompt: 'P', output_format: 'jpeg' },
    { image_url: uri(LIVING), prompt: 'P', output_format: 'jpeg' },
  ])
  assert.ok(out.kind === 'done' && out.meta.cost_usd === 0.0576)
  assert.deepEqual(rows(r.costs).map((l) => l.split(',').slice(2).join(',')), ['render:kontext,0.04,false,scene-20261105-120000', 'render:qwen,0.0576,false,'])
})

void test('a fal failure is a 502 with its sentence, before anything is billed or written', async () => {
  const r = rig({ answer: () => new FalError('fal fal-ai/nano-banana/edit returned HTTP 500: boom') })
  const out = await r.renders.render(job('nano-banana'))
  assert.deepEqual(out, { kind: 'error', status: 502, error: 'fal fal-ai/nano-banana/edit returned HTTP 500: boom' })
  assert.deepEqual(rows(r.costs), [])
  assert.deepEqual(fs.readdirSync(path.join(r.dir, 'renders')), [])
  assert.equal(r.spend.view().reserved_usd, 0)
})

void test('fal answered without an image: 502, and the billed call is recorded', async () => {
  const r = rig({ answer: () => ({ images: [] }) })
  const out = await r.renders.render(job('nano-banana'))
  assert.deepEqual(out, { kind: 'error', status: 502, error: 'fal fal-ai/nano-banana/edit returned no image ($0.0398 recorded)' })
  assert.equal(rows(r.costs).length, 1)
})

void test('the download fails after fal answered: 502 with the reason, and the cost row is written anyway', async () => {
  const r = rig({ download: () => Promise.reject(new Error('HTTP Error 404: Not Found')) })
  const out = await r.renders.render(job('kontext'))
  assert.deepEqual(out, { kind: 'error', status: 502, error: 'could not download the render (HTTP Error 404: Not Found); $0.04 recorded' })
  assert.equal(rows(r.costs).length, 1)
  const odd = rig({ answer: () => ({ images: [{ url: 5 }] }) })
  assert.deepEqual(await odd.renders.render(job('kontext')), { kind: 'error', status: 502, error: "could not download the render ('int' object has no attribute 'startswith'); $0.04 recorded" })
})

void test('no key outside mock mode: 503 with v1\'s sentence, nothing reserved or called', async () => {
  const r = rig({ key: null })
  assert.deepEqual(await r.renders.render(job('nano-banana')), { kind: 'error', status: 503, error: 'FAL_KEY not set: add FAL_KEY=... to midstudy/.env' })
  assert.equal(r.calls.length, 0)
})

void test('the spend cap refuses a render that would cross it, before any call', async () => {
  const r = rig({ cap: 0.03 })
  const out = await r.renders.render(job('nano-banana'))
  assert.deepEqual(out, { kind: 'refused', body: { error: 'this call costs $0.0398, more than the daily fal budget ($0.03) allows', spent_usd: 0, cap_usd: 0.03 } })
  assert.equal(r.calls.length, 0)
  assert.deepEqual(rows(r.costs), [])
})
