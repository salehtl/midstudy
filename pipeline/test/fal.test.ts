// The fal client (pipeline/src/fal.ts) without the network: LiveFal against a scripted fetch speaks fal-client
// 1.0.3's protocol (what v1's upload_file and subscribe sent), retries what it retried and words failures as v1 did;
// MockFal replays fixtures/fal and logs every request (common/fal.ts's request log) as v1's
// pipeline/test/v1_mock_log.py does; the key is common/fal.ts's.
//
//   nix develop -c node --test pipeline/test/fal.test.ts
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { falKey as loadFalKey } from '../../common/fal.ts'
import { NoMasks } from '../src/errors.ts'
import { LiveFal, MockFal, download, run } from '../src/fal.ts'
import { parse } from '../src/logic/pyjson.ts'
import type { PyValue } from '../src/logic/pyjson.ts'

const REPO = fileURLToPath(new URL('../../', import.meta.url))
const SCRATCH = path.join(REPO, 'evals/out/pipeline-fal-test')

interface Seen {
  readonly url: string
  readonly method: string
  readonly headers: Record<string, string>
  readonly body: string
}

function fresh(name: string): string {
  const dir = path.join(SCRATCH, name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function headersOf(init: RequestInit): Record<string, string> {
  return Object.fromEntries(Object.entries(init.headers ?? {}).map(([k, v]) => [k, String(v)]))
}

function bodyOf(init: RequestInit): string {
  const b = init.body
  if (typeof b === 'string') return b
  if (b instanceof Uint8Array) return `<${String(b.length)} bytes>`
  return ''
}

/** A fetch that answers from `script` in order (each entry: a URL prefix it must match, and the response). */
function scripted(script: [string, () => Response][]): { fetch: (url: string, init: RequestInit) => Promise<Response>; seen: Seen[] } {
  const seen: Seen[] = []
  let i = 0
  return {
    seen,
    fetch: (url, init) => {
      seen.push({ url, method: init.method ?? 'GET', headers: headersOf(init), body: bodyOf(init) })
      const step = script[i++]
      if (step === undefined) return Promise.reject(new Error(`unexpected request ${url}`))
      assert.ok(url.startsWith(step[0]), `request ${String(i)}: ${url} is not ${step[0]}`)
      return Promise.resolve(step[1]())
    },
  }
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } })

/** The request numbered `i`. */
function nth(seen: readonly Seen[], i: number): Seen {
  const r = seen[i]
  if (r === undefined) assert.fail(`no request ${String(i)}`)
  return r
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function pyval(s: string): PyValue {
  const p = parse(s)
  assert.ok(p.ok)
  return p.value
}

const TOKEN = { token: 'T', token_type: 'Bearer', base_url: 'https://v3.fal.media', expires_at: '2099-01-01T00:00:00+00:00' }

void test('upload: the CDN v3 token (kept until it expires), then the upload, as fal-client sends them', async () => {
  const dir = fresh('upload')
  const file = path.join(dir, 'engine-input.jpg')
  fs.writeFileSync(file, Buffer.from([0xff, 0xd8, 0xff, 0xd9]))
  const s = scripted([
    ['https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3', () => json(TOKEN)],
    ['https://v3.fal.media/files/upload', () => json({ access_url: 'https://v3.fal.media/files/x/engine-input.jpg' })],
    ['https://v3.fal.media/files/upload', () => json({ access_url: 'https://v3.fal.media/files/y/engine-input.jpg' })],
  ])
  const fal = new LiveFal('K', s.fetch, () => Promise.resolve())
  assert.equal(await fal.upload(file), 'https://v3.fal.media/files/x/engine-input.jpg')
  assert.equal(await fal.upload(file), 'https://v3.fal.media/files/y/engine-input.jpg')
  assert.deepEqual(s.seen.map((r) => [r.method, r.url]), [
    ['POST', 'https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3'],
    ['POST', 'https://v3.fal.media/files/upload'],
    ['POST', 'https://v3.fal.media/files/upload'],
  ])
  assert.deepEqual(nth(s.seen, 0).headers, { Authorization: 'Key K', Accept: 'application/json', 'Content-Type': 'application/json' })
  assert.equal(nth(s.seen, 0).body, '{}')
  assert.deepEqual(nth(s.seen, 1).headers, { Authorization: 'Bearer T', 'User-Agent': 'fal-client/1.0.3 (python)', 'Content-Type': 'image/jpeg', 'X-Fal-File-Name': 'engine-input.jpg' })
  assert.equal(nth(s.seen, 1).body, '<4 bytes>')
})

void test('upload: a failed CDN upload falls back to the storage upload (initiate, then PUT); a failed token fails it', async () => {
  const dir = fresh('upload-fallback')
  const file = path.join(dir, 'mask.png')
  fs.writeFileSync(file, Buffer.from([0x89, 0x50]))
  const s = scripted([
    ['https://rest.fal.ai/storage/auth/token', () => json(TOKEN)],
    ['https://v3.fal.media/files/upload', () => json({ detail: 'no' }, 400)],
    ['https://rest.fal.ai/storage/upload/initiate?storage_type=gcs', () => json({ upload_url: 'https://gcs.example/put', file_url: 'https://fal.media/files/mask.png' })],
    ['https://gcs.example/put', () => new Response('', { status: 200 })],
  ])
  assert.equal(await new LiveFal('K', s.fetch, () => Promise.resolve()).upload(file), 'https://fal.media/files/mask.png')
  assert.equal(nth(s.seen, 2).body, '{"file_name":"mask.png","content_type":"image/png"}')
  assert.equal(nth(s.seen, 3).method, 'PUT')
  assert.equal(nth(s.seen, 3).headers['Content-Type'], 'image/png')
  const t = scripted([['https://rest.fal.ai/storage/auth/token', () => json({ detail: 'down' }, 500)]])
  await assert.rejects(new LiveFal('K', t.fetch, () => Promise.resolve()).upload(file), (e) => e instanceof Error && e.message === `fal upload of ${file} failed (HTTPStatusError: Server error '500 Internal Server Error' for url 'https://rest.fal.ai/storage/auth/token?storage_type=fal-cdn-v3'\nFor more information check: https://developer.mozilla.org/en-US/docs/Web/HTTP/Status/500); check FAL_KEY and your credit`)
  assert.equal(t.seen.length, 1)
})

void test('call: submit to the queue, print the logs while it runs, then the result; 429 and nginx 503s retried', async () => {
  const q = 'https://queue.fal.run/fal-ai/trellis-2/requests/R'
  const s = scripted([
    ['https://queue.fal.run/fal-ai/trellis-2', () => json({ request_id: 'R', status_url: `${q}/status`, response_url: q, cancel_url: `${q}/cancel` })],
    [`${q}/status?logs=true`, () => json({ status: 'IN_QUEUE', queue_position: 0 })],
    [`${q}/status?logs=true`, () => json({ detail: 'slow down' }, 429)],
    [`${q}/status?logs=true`, () => json({ status: 'IN_PROGRESS', logs: [{ message: 'step 1' }, { message: 'step 2' }] })],
    [`${q}/status?logs=true`, () => new Response('<html>nginx 503</html>', { status: 503 })],
    [`${q}/status?logs=true`, () => json({ status: 'COMPLETED', logs: [] })],
    [`${q}/status?logs=false`, () => json({ status: 'COMPLETED' })],
    [q, () => json({ model_glb: { url: 'https://fal.media/m.glb' } })],
  ])
  const sleeps: number[] = []
  const fal = new LiveFal('K', s.fetch, (ms) => { sleeps.push(ms); return Promise.resolve() })
  const resp = await fal.call('fal-ai/trellis-2', pyval('{"image_url": "U", "resolution": 1024}'))
  assert.equal(resp.kind, 'dict')
  assert.equal(nth(s.seen, 0).body, '{"image_url":"U","resolution":1024}')
  assert.equal(nth(s.seen, 0).headers['Authorization'], 'Key K')
  assert.equal(nth(s.seen, 0).headers['User-Agent'], 'fal-client/1.0.3 (python)')
  assert.equal(sleeps.filter((ms) => ms === 100).length, 2) // the status polls' 0.1 s
  assert.equal(sleeps.length, 4) // and the two retries' backoff
})

void test('call: SAM 3D finding nothing is NoMasks (not charged); another error is v1\'s sentence', async () => {
  const noMasks = scripted([
    ['https://queue.fal.run/fal-ai/sam-3/3d-objects', () => json({ detail: 'Auto-segmentation produced no masks' }, 422)],
  ])
  await assert.rejects(new LiveFal('K', noMasks.fetch, () => Promise.resolve()).call('fal-ai/sam-3/3d-objects', pyval('{}')), (e) => e instanceof NoMasks && e.message === 'Auto-segmentation produced no masks')
  const broken = scripted([['https://queue.fal.run/speridlabs/idol', () => json({ detail: [{ msg: 'bad image' }] }, 400)]])
  await assert.rejects(new LiveFal('K', broken.fetch, () => Promise.resolve()).call('speridlabs/idol', pyval('{}')), {
    message: "fal call to speridlabs/idol failed (FalClientHTTPError: [{'msg': 'bad image'}])",
  })
})

void test('download: a failed fetch is v1\'s sentence; LiveFal.fetch saves under the URL\'s name', async () => {
  const dir = fresh('download')
  const missing = scripted([['https://ex.com/a.ply', () => new Response('no', { status: 404, statusText: 'Not Found' })]])
  await assert.rejects(download('https://ex.com/a.ply', path.join(dir, 'a.ply'), missing.fetch), { message: 'download failed for https://ex.com/a.ply (HTTPError: HTTP Error 404: Not Found)' })
  const ok = scripted([['https://ex.com/files/x%20y.ply', () => new Response('ply', { status: 200 })]])
  const out = await new LiveFal('K', ok.fetch, () => Promise.resolve()).fetch('https://ex.com/files/x%20y.ply?sig=1', dir)
  assert.equal(path.basename(out), 'x y.ply')
  assert.equal(fs.readFileSync(out, 'utf8'), 'ply')
})

void test('MockFal replays fixtures/fal and logs the requests as v1_mock_log.py does; run() retries SAM 3D', async () => {
  const dir = fresh('mock')
  const log = path.join(dir, 'log.jsonl')
  const image = path.join(dir, 'engine-input.jpg')
  fs.copyFileSync(path.join(REPO, 'fixtures/fal/sam-3-3d-objects/input.jpg'), image)
  process.env['MIDSTUDY_FAL_MOCK_LOG'] = log
  process.env['MIDSTUDY_FAL_MOCK_NO_MASKS'] = '1'
  try {
    const fal = new MockFal(path.join(REPO, 'fixtures/fal'))
    const out = await run(fal, 'sam3d', image, 'chair', 512, path.join(dir, 'raw'))
    assert.ok(out.glb !== null && out.splat !== null && fal.charged)
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l): Record<string, unknown> => {
      const v: unknown = JSON.parse(l)
      return isRecord(v) ? v : {}
    })
    assert.deepEqual(lines.map((l) => l['op']), ['upload', 'call', 'call', 'fetch', 'fetch'])
    assert.equal(fs.readFileSync(log, 'utf8').split('\n')[1], '{"op": "call", "endpoint": "fal-ai/sam-3/3d-objects", "url": "https://queue.fal.run/fal-ai/sam-3/3d-objects", "args": {"image_url": "https://mock.fal.invalid/uploads/engine-input.jpg", "prompt": "chair", "export_textured_glb": true}}')
    const second = lines[2]?.['args']
    assert.ok(isRecord(second) && second['detection_threshold'] === 0.2)
    assert.equal(lines[0]?.['bytes'], fs.statSync(image).size)
    process.env['MIDSTUDY_FAL_MOCK_NO_MASKS'] = 'x1'
    assert.throws(() => new MockFal(path.join(REPO, 'fixtures/fal')), { message: "invalid literal for int() with base 10: 'x1'" })
  } finally {
    delete process.env['MIDSTUDY_FAL_MOCK_LOG']
    delete process.env['MIDSTUDY_FAL_MOCK_NO_MASKS']
  }
})

void test('the key: FAL_KEY first, then <repo>/.env unless MIDSTUDY_NO_DOTENV (a scratch .env here, never the real one)', (t) => {
  // run with FAL_KEY unset (`env -u FAL_KEY`): this test never sets it
  if (process.env['FAL_KEY'] !== undefined) {
    t.skip('FAL_KEY is set in this environment')
    return
  }
  const dir = fresh('key')
  fs.writeFileSync(path.join(dir, '.env'), "# fal\nexport FAL_KEY = 'abc:def'\n")
  const saved = process.env['MIDSTUDY_NO_DOTENV']
  delete process.env['MIDSTUDY_NO_DOTENV']
  try {
    assert.equal(loadFalKey(dir), 'abc:def')
    assert.equal(process.env['FAL_KEY'], undefined)
    process.env['MIDSTUDY_NO_DOTENV'] = '1'
    assert.equal(loadFalKey(dir), null)
    delete process.env['MIDSTUDY_NO_DOTENV']
    assert.equal(loadFalKey(path.join(dir, 'nowhere')), null)
  } finally {
    if (saved === undefined) delete process.env['MIDSTUDY_NO_DOTENV']
    else process.env['MIDSTUDY_NO_DOTENV'] = saved
  }
})
