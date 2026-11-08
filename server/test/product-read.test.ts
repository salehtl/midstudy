// The product reader's two clocks (contract §2.11): the feeds' time belongs to the 20 s Budget, not the 10 s Deadline,
// and a model's answer that is paid for and recorded is never thrown away by the Deadline. Clocks are driven, not slept.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import type { ServerDeps } from '../src/deps.ts'
import { Deadline, EXTRACT_MS, ProductError, TOO_LONG } from '../src/product/errors.ts'
import { readProduct, type ProductAnswer } from '../src/product/read.ts'
import { SpendCap } from '../src/spend.ts'
import { REPO, SCRATCH } from './helpers.ts'

const DIR = path.join(SCRATCH, 'product-read-' + String(process.pid))
const COSTS = path.join(DIR, 'costs.csv')
const LATE_MS = 11_000

const SHOP_PAGE = '<!doctype html><html><head><title>Bench</title><script src="https://cdn.shopify.com/s.js"></script></head><body><h1>Bench</h1></body></html>'
const FEED = JSON.stringify({ title: 'Bench', options: [{ name: 'Size', values: ['120 x 40 x 45 cm', '150 x 40 x 45 cm'] }], variants: [{ id: 1 }] })
const PASTED_PAGE = '<!doctype html><html><head><title>Teak cabinet</title></head><body><p>This cabinet stands 120 tall, 90 across and 40 deep, all in centimetres.</p></body></html>'

const depsWith = (spend: SpendCap): ServerDeps => ({
  config: {
    repo: REPO, host: '127.0.0.1', port: 0,
    scenesDir: path.join(DIR, 'scenes'), roomsDir: path.join(DIR, 'rooms'), layoutsDir: path.join(DIR, 'layouts'), rendersDir: path.join(DIR, 'renders'), libraryDir: DIR,
    costsFile: COSTS, calib: ['true'], midstudyAdd: ['true'], dailySpendUsd: 1, allowedHosts: [], socketTimeoutSeconds: 30,
  },
  spend,
  onShutdown: () => undefined,
})

/** A fake clock's reading and a way to move it. */
class Clock {
  t = 0
  readonly now = (): number => this.t
}

const layers = (a: ProductAnswer): readonly string[] => ('source_layers_used' in a.body ? a.body.source_layers_used : [])

void describe('the product reader\'s clocks', () => {
  let server: http.Server
  let port = 0
  let onFeed: () => void = () => undefined

  before(async () => {
    if (!fs.existsSync(path.join(REPO, 'build/wasm/product'))) throw new Error('build/wasm/product is missing: run npm run build')
    fs.rmSync(DIR, { recursive: true, force: true })
    fs.mkdirSync(DIR, { recursive: true })
    process.env['MIDSTUDY_FAL_MOCK'] = 'fixtures/fal'
    process.env['MIDSTUDY_NO_DOTENV'] = '1'
    process.env['NOOK_NO_DOTENV'] = '1'
    server = http.createServer((req, res) => {
      if (req.url === '/products/x.js') {
        onFeed()
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(FEED)
        return
      }
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(SHOP_PAGE)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address !== null && typeof address !== 'string')
    port = (address satisfies AddressInfo).port
    process.env['MIDSTUDY_FETCH_ALLOW'] = '127.0.0.1:' + String(port)
  })

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => { resolve() }))
  })

  void test('a feed that takes 11 s does not use up the 10 s for the work after the download', async () => {
    const clock = new Clock()
    onFeed = () => { clock.t += LATE_MS }
    const got = await readProduct(`http://127.0.0.1:${String(port)}/products/x`, false, null, depsWith(new SpendCap(COSTS, 1)), { now: clock.now })
    assert.equal(got.status, 200, JSON.stringify(got.body))
    assert.ok(layers(got).includes('shopify'), layers(got).join())
  })

  void test('a model answer that is paid for and recorded is kept past the deadline', async () => {
    const clock = new Clock()
    class SlowSpend extends SpendCap {
      override reserve(key: string, amount: number): ReturnType<SpendCap['reserve']> {
        clock.t += LATE_MS
        return super.reserve(key, amount)
      }
    }
    const got = await readProduct('https://shop.example/p/teak-cabinet-prose', true, PASTED_PAGE, depsWith(new SlowSpend(COSTS, 1)), { now: clock.now })
    assert.equal(got.status, 200, JSON.stringify(got.body))
    assert.ok(layers(got).includes('llm'), layers(got).join())
    assert.match(fs.readFileSync(COSTS, 'utf8'), /product:llm/)
  })
})

void describe('Deadline', () => {
  const tooLong = (e: unknown): boolean => e instanceof ProductError && e.status === 422 && e.message === TOO_LONG

  void test('before start, remaining is the whole extract time', () => {
    assert.equal(new Deadline(() => 5).remaining(), EXTRACT_MS)
  })

  void test('suspend moves the deadline later by the time the work took', async () => {
    const clock = new Clock()
    const d = new Deadline(clock.now)
    d.start(100)
    clock.t = 40
    const v = await d.suspend(() => {
      clock.t += 500
      return Promise.resolve('done')
    })
    assert.equal(v, 'done')
    assert.equal(d.remaining(), 60)
    clock.t += 60
    d.check()
    clock.t += 1
    assert.throws(() => { d.check() }, tooLong)
  })

  void test('suspend moves the deadline when the work throws too', async () => {
    const clock = new Clock()
    const d = new Deadline(clock.now)
    d.start(100)
    await assert.rejects(d.suspend(() => {
      clock.t += 500
      return Promise.reject(new Error('feed failed'))
    }))
    assert.equal(d.remaining(), 100)
  })

  void test('settle stops check and pins remaining', async () => {
    const clock = new Clock()
    const d = new Deadline(clock.now)
    d.start(100)
    clock.t = 1000
    assert.throws(() => { d.check() }, tooLong)
    assert.equal(d.remaining(), 0)
    d.settle()
    d.check()
    await d.tick()
    assert.equal(d.remaining(), EXTRACT_MS)
  })
})
