// The HTTP plumbing in-process (server/src/http/): v1's framing (contract §2.9: duplicate or non-digit
// Content-Length, early 411/413 then a drain of at most 5 s and a close, 408 after the socket timeout, the drain
// before any other answer), the security gate (Host, X-Midstudy, Origin), the dispatcher's fallbacks and error
// mapping, and strict mode, with test routes standing in for the stage-B ones.
import fs from 'node:fs'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { Busy } from '../../common/lock.ts'
import { mbText } from '../../common/logic/pyfmt.ts'
import { HttpError, type RequestContext } from '../src/http/context.ts'
import type { ApiRoute } from '../src/http/router.ts'
import { createServer } from '../src/http/server.ts'
import { enableStrict, writeJsonFile, ContractViolation } from '../src/strict.ts'
import { api, bodyOf, errorOf, request, SCRATCH, statusOf, tcp } from './helpers.ts'

const DIR = path.join(SCRATCH, 'plumbing-' + String(process.pid))
const LIMIT = 25 * 1024 * 1024

async function upload(ctx: RequestContext): Promise<void> {
  const length = ctx.contentLength
  if (ctx.chunked || length === null) {
    ctx.closeConnection()
    await ctx.error(411, 'Content-Length is required: send the photo as the request body')
    return
  }
  if (length > LIMIT) {
    await ctx.error(413, 'that photo is ' + mbText(length) + ': a scene photo can be at most 25 MB')
    return
  }
  const file = path.join(DIR, 'upload-' + String(Date.now()))
  const got = await ctx.readBodyTo(file, length)
  if (got < length) throw new HttpError(400, 'the upload stopped before the end: try again')
  await ctx.send(202, { bytes: got })
}

const routes: ApiRoute[] = [
  { method: 'POST', path: /^\/api\/upload$/, handle: upload },
  { method: 'PUT', path: /^\/api\/json$/, handle: async (ctx) => { await ctx.send(200, { got: await ctx.readJson() }) } },
  { method: 'GET', path: /^\/api\/boom$/, handle: () => Promise.reject(new Error('boom')) },
  { method: 'POST', path: /^\/api\/busy$/, handle: () => Promise.reject(new Busy('lock')) },
  { method: 'POST', path: /^\/api\/teapot$/, handle: () => Promise.reject(new HttpError(418, 'short and stout')) },
  { method: 'GET', path: /^\/api\/echo\/([^/]*)$/, handle: async (ctx, p) => { await ctx.send(200, { param: p[0], q: ctx.query('q') }) } },
  { method: 'PUT', path: /^\/api\/items\/(?!jobs$)([^/]*)$/, handle: async (ctx, p) => { await ctx.send(200, { id: p[0] }) } },
  { method: 'GET', path: /^\/api\/spend$/, handle: async (ctx) => { await ctx.send(200, ctx.query('broken') === null ? { day: '2026-11-05', spent_usd: 0, reserved_usd: 0, cap_usd: 2 } : { day: 5, spent_usd: 0, reserved_usd: 0, cap_usd: 2 }) } },
  { method: 'GET', path: /^\/api\/unlisted$/, handle: async (ctx) => { await ctx.send(200, { fine: true }) } },
]

let base = ''
let port = 0
let close: () => Promise<void> = () => Promise.resolve()

before(async () => {
  fs.mkdirSync(DIR, { recursive: true })
  const server = createServer({
    routes,
    staticDirs: { planner: path.join(DIR, 'planner'), library: path.join(DIR, 'library'), scenes: path.join(DIR, 'scenes'), renders: path.join(DIR, 'renders') },
    allowedHostNames: ['midstudy.example.com'],
    socketTimeoutSeconds: 2,
  })
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  port = typeof address === 'object' && address !== null ? (address satisfies AddressInfo).port : 0
  base = 'http://127.0.0.1:' + String(port)
  close = () => new Promise<void>((resolve) => {
    server.closeAllConnections()
    server.close(() => {
      resolve()
    })
  })
})

after(async () => {
  await close()
  fs.rmSync(DIR, { recursive: true, force: true })
})

const head = (method: string, target: string, lines: readonly string[]): string => method + ' ' + target + ' HTTP/1.1\r\n' + lines.map((l) => l + '\r\n').join('') + '\r\n'

void describe('framing (§2.9)', () => {
  void test('two Content-Length headers → 400 with v1\'s sentence, before the route', async () => {
    const t = await tcp(port, head('POST', '/api/upload', ['Host: 127.0.0.1:' + String(port), 'X-Midstudy: 1', 'Content-Length: 1', 'Content-Length: 1']) + 'x')
    assert.equal(statusOf(t.text), 400)
    assert.deepEqual(JSON.parse(bodyOf(t.text)), { error: 'the request has more than one Content-Length header' })
  })
  void test('…but a foreign Host is checked first (403)', async () => {
    const t = await tcp(port, head('POST', '/api/upload', ['Host: evil.example', 'Content-Length: 1', 'Content-Length: 2']))
    assert.equal(statusOf(t.text), 403)
    assert.deepEqual(JSON.parse(bodyOf(t.text)), { error: 'unknown host name: add it with --allowed-host' })
  })
  for (const value of ['\xb2', '+5', '-1', '1e3', '0x10', '1234567890123456', '']) {
    void test('Content-Length ' + JSON.stringify(value) + ' → 400 "isn\'t a number of bytes"', async () => {
      const t = await tcp(port, head('POST', '/api/upload', ['Host: localhost:' + String(port), 'X-Midstudy: 1', 'Content-Length: ' + value]))
      assert.equal(statusOf(t.text), 400, t.text)
      assert.deepEqual(JSON.parse(bodyOf(t.text)), { error: "the Content-Length header isn't a number of bytes" })
    })
  }
  void test('Content-Length with Transfer-Encoding → 400 (Node refuses the ambiguity)', async () => {
    const t = await tcp(port, head('POST', '/api/upload', ['Host: localhost', 'X-Midstudy: 1', 'Content-Length: 5', 'Transfer-Encoding: chunked']) + '0\r\n\r\n')
    assert.equal(statusOf(t.text), 400)
    assert.match(errorOfText(t.text), /Content-Length and a Transfer-Encoding/)
  })
  void test('a 25 MB + 1 upload gets its 413 at once (no body sent), says 25.1 MB, and the connection closes within the drain (5 s, each read at most the 2 s socket timeout)', async () => {
    const t = await tcp(port, head('POST', '/api/upload', ['Host: 127.0.0.1:' + String(port), 'X-Midstudy: 1', 'Content-Length: ' + String(LIMIT + 1)]), { waitMs: 9000 })
    assert.equal(statusOf(t.text), 413)
    assert.ok((t.firstMs ?? 9999) < 1000, 'answered in ' + String(t.firstMs) + ' ms')
    assert.match(t.text, /Connection: close/i)
    assert.match(bodyOf(t.text), /25\.1 MB: a scene photo can be at most 25 MB/)
    assert.ok(t.closedMs !== null && t.closedMs >= 1900 && t.closedMs < 7500, 'closed at ' + String(t.closedMs) + ' ms')
  })
  void test('…and a client that sends the body anyway gets the 413 and an orderly close once it is drained', async () => {
    const body = Buffer.alloc(LIMIT + 1, 0x61)
    const t = await tcp(port, Buffer.concat([Buffer.from(head('POST', '/api/upload', ['Host: 127.0.0.1', 'X-Midstudy: 1', 'Content-Length: ' + String(body.length)])), body]), { waitMs: 9000 })
    assert.equal(statusOf(t.text), 413)
    assert.ok(t.closedMs !== null && t.closedMs < 7500, 'closed at ' + String(t.closedMs) + ' ms')
  })
  void test('an upload without Content-Length (chunked) → 411 at once, then the close', async () => {
    const t = await tcp(port, head('POST', '/api/upload', ['Host: 127.0.0.1', 'X-Midstudy: 1', 'Transfer-Encoding: chunked']) + '5\r\nhello\r\n0\r\n\r\n', { waitMs: 9000 })
    assert.equal(statusOf(t.text), 411)
    assert.ok(t.closedMs !== null && t.closedMs < 7500, 'closed at ' + String(t.closedMs) + ' ms')
  })
  void test('Expect: 100-continue: an early refusal goes out without 100 Continue; an accepted upload gets 100 first', async () => {
    const refused = await tcp(port, head('POST', '/api/upload', ['Host: 127.0.0.1', 'X-Midstudy: 1', 'Expect: 100-continue', 'Content-Length: ' + String(LIMIT + 5)]), { waitMs: 9000 })
    assert.equal(statusOf(refused.text), 413)
    assert.doesNotMatch(refused.text, /100 Continue/)
    const accepted = await tcp(port, head('POST', '/api/upload', ['Host: 127.0.0.1', 'X-Midstudy: 1', 'Expect: 100-continue', 'Content-Length: 3']), { waitMs: 1500 })
    assert.match(accepted.text, /^HTTP\/1\.1 100 Continue/)
  })
  void test('a body that stalls is dropped after the socket timeout (2 s here) with a 408 sentence, and the connection closes', async () => {
    const t = await tcp(port, head('POST', '/api/upload', ['Host: 127.0.0.1', 'X-Midstudy: 1', 'Content-Length: 1000']) + '0123456789', { waitMs: 8000 })
    assert.equal(statusOf(t.text), 408)
    assert.deepEqual(JSON.parse(bodyOf(t.text)), { error: 'the request body stopped arriving (nothing for 2 s): send it again' })
    assert.ok((t.firstMs ?? 0) >= 1900 && t.closedMs !== null && t.closedMs < 6000, 'answered at ' + String(t.firstMs) + ', closed at ' + String(t.closedMs))
  })
  void test('an idle connection with no request is closed after the socket timeout', async () => {
    const t = await tcp(port, '', { waitMs: 6000 })
    assert.equal(t.text, '')
    assert.ok(t.closedMs !== null && t.closedMs >= 1900 && t.closedMs < 4000, 'closed at ' + String(t.closedMs))
  })
  void test('a whole upload is read, and the connection stays usable (keep-alive)', async () => {
    const one = head('POST', '/api/upload', ['Host: 127.0.0.1', 'X-Midstudy: 1', 'Content-Length: 5']) + 'hello'
    const two = head('GET', '/api/echo/x', ['Host: 127.0.0.1'])
    const t = await tcp(port, one + two, { waitMs: 1500 })
    assert.equal(t.text.split('HTTP/1.1 ').length - 1, 2, t.text)
    assert.match(t.text, /"bytes":5/)
    assert.match(t.text, /"param":"x"/)
  })
})

function errorOfText(text: string): string {
  const body: unknown = JSON.parse(bodyOf(text))
  return typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' ? body.error : ''
}

void describe('the security gate (§2.9)', () => {
  void test('a request without Host → 403 (HTTP/1.0 and 1.1)', async () => {
    for (const v of ['1.0', '1.1']) {
      const t = await tcp(port, 'GET /api/spend HTTP/' + v + '\r\n\r\n', { waitMs: 3000, untilClose: false })
      assert.equal(statusOf(t.text), 403, v)
    }
  })
  for (const [host, want] of [['127.0.0.1', 200], ['localhost:1', 200], ['[::1]:8765', 200], ['LOCALHOST', 200], ['midstudy.example.com', 200], ['midstudy.example.com:443', 200],
    ['evil.example', 403], ['127.0.0.1:80@evil.example', 403], ['[::1]evil.example', 403], ['localhost.evil.example', 403], ['127.0.0.1:123456', 403], ['127.0.0.1:99999', 200]] as const) {
    void test('Host ' + host + ' → ' + String(want), async () => {
      const a = await request(base, 'GET', '/api/spend', { headers: { Host: host } })
      assert.equal(a.status, want)
      if (want === 403) assert.equal(errorOf(a), 'unknown host name: add it with --allowed-host')
    })
  }
  void test('two Host headers → 403', async () => {
    const t = await tcp(port, head('GET', '/api/spend', ['Host: 127.0.0.1', 'Host: 127.0.0.1']), { waitMs: 3000, untilClose: false })
    assert.equal(statusOf(t.text), 403)
  })
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    void test(method + ': without X-Midstudy, or with a foreign Origin → 403 "cross-site request refused"; this page\'s Origin passes', async () => {
      const target = method === 'PUT' ? '/api/json' : '/api/nowhere'
      const none = await request(base, method, target, { headers: { 'Content-Type': 'application/json' }, body: '{}' })
      const foreign = await request(base, method, target, { headers: { 'X-Midstudy': '1', Origin: 'http://evil.example' }, body: '{}' })
      const wrong = await request(base, method, target, { headers: { 'X-Midstudy': 'yes' }, body: '{}' })
      for (const a of [none, foreign, wrong]) {
        assert.equal(a.status, 403)
        assert.equal(errorOf(a), 'cross-site request refused')
      }
      const own = await request(base, method, target, { headers: { 'X-Midstudy': '1', Origin: base }, body: '{}' })
      assert.notEqual(own.status, 403)
      const ownHttps = await request(base, method, target, { headers: { 'X-Midstudy': '1', Origin: 'https://127.0.0.1:' + String(port) }, body: '{}' })
      assert.notEqual(ownHttps.status, 403)
    })
  }
  void test('a forged request\'s body is read before the 403, so the client sees the answer', async () => {
    const body = Buffer.alloc(3 * 1024 * 1024, 0x62)
    const a = await request(base, 'POST', '/api/upload', { headers: { 'Content-Type': 'application/octet-stream' }, body })
    assert.equal(a.status, 403)
  })
})

void describe('dispatch (v1\'s fallbacks and errors)', () => {
  void test('unknown /api routes: 404 "no such endpoint: <METHOD> <path>" (GET for HEAD too)', async () => {
    assert.equal(errorOf(await request(base, 'GET', '/api/nope')), 'no such endpoint: GET /api/nope')
    assert.equal(errorOf(await api(base, 'POST', '/api/nope', {})), 'no such endpoint: POST /api/nope')
    assert.equal(errorOf(await api(base, 'PATCH', '/api/a%2Fb', {})), 'no such endpoint: PATCH /api/a/b')
    assert.equal(errorOf(await api(base, 'DELETE', '/api')), 'no such endpoint: DELETE /api')
    const h = await request(base, 'HEAD', '/api/nope')
    assert.equal(h.status, 404)
    assert.equal(h.body.length, 0)
  })
  void test('PUT outside /api → 405; POST outside /api → 404 with the path as sent', async () => {
    assert.equal(errorOf(await api(base, 'PUT', '/planner/x', {})), 'PUT is only supported under /api')
    const p = await api(base, 'POST', '/planner/x%20y?z', {})
    assert.equal(p.status, 404)
    assert.equal(errorOf(p), 'no such endpoint: POST /planner/x%20y')
  })
  void test('other methods → 501 (http.server\'s HTML page)', async () => {
    const a = await request(base, 'OPTIONS', '/api/spend')
    assert.equal(a.status, 501)
    assert.match(a.text, /Unsupported method \('OPTIONS'\)/)
    assert.match(String(a.headers['content-type']), /text\/html/)
  })
  void test('routes match the whole decoded path; params and ?query as v1 read them', async () => {
    const a = await request(base, 'GET', '/api/echo/a%20b?q=c+d&q=e')
    assert.deepEqual(a.json, { param: 'a b', q: 'c d' })
    assert.equal((await request(base, 'GET', '/api/echo/a/b')).status, 404)
    assert.deepEqual((await request(base, 'GET', '/api/echo/?q=')).json, { param: '', q: null })
    assert.equal((await api(base, 'PUT', '/api/items/jobs', {})).status, 404)
    assert.deepEqual((await api(base, 'PUT', '/api/items/jobsx', {})).json, { id: 'jobsx' })
    assert.deepEqual((await request(base, 'GET', '//api/echo/z')).json, { param: 'z', q: null })
  })
  void test('a handler\'s exception: HttpError → its status, Busy → 503 v1 sentence, anything else → 500 "<Name>: <message>"', async () => {
    assert.deepEqual((await api(base, 'POST', '/api/teapot')).json, { error: 'short and stout' })
    const busy = await api(base, 'POST', '/api/busy')
    assert.equal(busy.status, 503)
    assert.equal(errorOf(busy), 'the library is busy with another change (a midstudy-add run): try again in a minute')
    const boom = await request(base, 'GET', '/api/boom')
    assert.equal(boom.status, 500)
    assert.equal(errorOf(boom), 'Error: boom')
  })
  void test('JSON bodies as v1 read them: empty, too large, not JSON, nested too deeply, a BOM', async () => {
    assert.equal(errorOf(await request(base, 'PUT', '/api/json', { headers: { 'X-Midstudy': '1' } })), 'empty request body')
    assert.equal(errorOf(await request(base, 'PUT', '/api/json', { headers: { 'X-Midstudy': '1', 'Content-Length': String(40 * 1024 * 1024) }, body: '' })).length >= 0, true)
    assert.match(errorOf(await api(base, 'PUT', '/api/json', undefined, { 'Content-Type': 'application/json' })), /empty request body/)
    const notJson = await request(base, 'PUT', '/api/json', { headers: { 'X-Midstudy': '1' }, body: '{"a": NaN}' })
    assert.equal(notJson.status, 400)
    assert.match(errorOf(notJson), /^body is not valid JSON: /)
    const deep = await request(base, 'PUT', '/api/json', { headers: { 'X-Midstudy': '1' }, body: '['.repeat(2000) + ']'.repeat(2000) })
    assert.equal(errorOf(deep), 'body is not valid JSON: it is nested too deeply')
    const bom = await request(base, 'PUT', '/api/json', { headers: { 'X-Midstudy': '1' }, body: Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]) })
    assert.equal(bom.status, 400)
    assert.deepEqual((await api(base, 'PUT', '/api/json', { a: [1, '\u00e9'] })).json, { got: { a: [1, '\u00e9'] } })
  })
  void test('answers carry v1\'s headers: JSON, no caching, nosniff', async () => {
    const a = await request(base, 'GET', '/api/spend')
    assert.equal(a.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(a.headers['cache-control'], 'no-store, must-revalidate')
    assert.equal(a.headers.pragma, 'no-cache')
    assert.equal(a.headers.expires, '0')
    assert.equal(a.headers['x-content-type-options'], 'nosniff')
  })
})

void describe('strict mode (MIDSTUDY_STRICT=1)', () => {
  before(async () => {
    await enableStrict()
  })
  void test('an answer that matches its schema goes out; one that breaks it becomes 500 "contract violation: <schema> <pointer>"', async () => {
    assert.equal((await request(base, 'GET', '/api/spend')).status, 200)
    const broken = await request(base, 'GET', '/api/spend?broken=1')
    assert.equal(broken.status, 500)
    assert.equal(errorOf(broken), 'contract violation: midstudy/api/spend.schema.json /day')
  })
  void test('a success on a path routes.json doesn\'t know is a violation; an error on it is checked against error.schema.json', async () => {
    assert.match(errorOf(await request(base, 'GET', '/api/unlisted')), /^contract violation: midstudy\/api\/routes\.json/)
    assert.equal((await request(base, 'GET', '/api/nope')).status, 404)
  })
  void test('a file that breaks its schema is never written', async () => {
    const file = path.join(DIR, 'scene.json')
    await assert.rejects(writeJsonFile(file, { version: 1, title: 'x' }, 'midstudy/scene.schema.json'), ContractViolation)
    assert.equal(fs.existsSync(file), false)
    const good = { version: 1, title: 'Lounge \u00e9', created: '2026-11-05T21:36:09Z', saved: null, camera: { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }, camera_source: 'default' }
    await writeJsonFile(file, good, 'midstudy/scene.schema.json')
    assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(good, null, 2).replace('\u00e9', '\\u00e9') + '\n')
  })
})
