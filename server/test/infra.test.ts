// The rest of the server's infrastructure: the tool runner (server/src/tools.ts), job queues (jobs.ts), the spend cap
// (spend.ts), fal (common/fal.ts: the key's sources, mock mode, the call and its sentences against a local stand-in,
// downloads) and files (common/files.ts). fal is never reached: falCall goes to a local server, keys are fakes.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { countsAgainstCap, download, falCall, FalError, falKey, falMock, falMockDir, falQueueUrl, falRunUrl, logFal, mockCost, mockSlug, uploadRecord } from '../../common/fal.ts'
import { atomicWrite, jsonText, makeTempDir, readJsonFile } from '../../common/files.ts'
import { utcDay } from '../../common/logic/time.ts'
import { JobStore, newJobId, SerialQueue } from '../src/jobs.ts'
import { jobStep } from '../src/logic/jobs.ts'
import { SpendCap } from '../src/spend.ts'
import { addError, addMessage, lastJsonLine, outputLines, runTool, splitCommand, summaryOf, toolError } from '../../common/tools.ts'
import { decodeImageDataUri } from '../../core/js/node.ts'
import { REPO, SCRATCH } from './helpers.ts'

const DIR = path.join(SCRATCH, 'infra-' + String(process.pid))
before(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
  fs.mkdirSync(DIR, { recursive: true })
})
after(() => {
  fs.rmSync(DIR, { recursive: true, force: true })
})

void describe('the tool runner', () => {
  void test('an argument list, no shell; stdout, stderr and the exit code; the last JSON line; v1\'s error wording', async () => {
    const r = await runTool(['python3', '-c', 'import sys; print("progress", file=sys.stderr); print("x"); print(\'{"ok": false, "error": "it broke"}\'); sys.exit(3)'], { cwd: REPO, timeoutMs: 20000 })
    if (r.kind !== 'exited') assert.fail(r.kind)
    assert.equal(r.returnCode, 3)
    const out = lastJsonLine(r.stdout)
    assert.deepEqual(out, { ok: false, error: 'it broke' })
    assert.equal(toolError(out.error, r.stderr, r.returnCode, 'midstudy-calib'), 'it broke')
    const shell = await runTool(['echo', '$HOME', '&&', 'false'], { cwd: REPO, timeoutMs: 5000 })
    assert.ok(shell.kind === 'exited' && shell.stdout === '$HOME && false\n')
  })
  void test('a missing executable is not-found (v1: "… isn\'t installed here"); a killed tool reports minus the signal', async () => {
    assert.deepEqual(await runTool(['midstudy-no-such-tool', 'x'], { cwd: REPO, timeoutMs: 5000 }), { kind: 'not-found', command: 'midstudy-no-such-tool' })
    const killed = await runTool(['sh', '-c', 'kill -9 $$'], { cwd: REPO, timeoutMs: 5000 })
    assert.ok(killed.kind === 'exited' && killed.returnCode === -9)
  })
  void test('a tool past its timeout is killed with its whole process group', async () => {
    const marker = path.join(DIR, 'grandchild-alive')
    const t0 = Date.now()
    const r = await runTool(['sh', '-c', '(sleep 1.5; touch ' + marker + ') & sleep 30'], { cwd: REPO, timeoutMs: 300 })
    assert.equal(r.kind, 'timeout')
    assert.ok(Date.now() - t0 < 2000)
    await new Promise((resolve) => setTimeout(resolve, 2000))
    assert.equal(fs.existsSync(marker), false, 'the grandchild was killed too')
  })
  void test('commands split as shlex.split; midstudy-add\'s messages', () => {
    assert.deepEqual(splitCommand('uv run --project calib midstudy-calib'), { ok: true, argv: ['uv', 'run', '--project', 'calib', 'midstudy-calib'] })
    assert.deepEqual(splitCommand('python3 "a b"'), { ok: true, argv: ['python3', 'a b'] })
    assert.deepEqual(splitCommand('x "open'), { ok: false, error: 'No closing quotation' })
    assert.equal(addError('midstudy-add: no dims\n', 1), 'midstudy-add: no dims')
    const lines = outputLines('step\nmidstudy-add: replaced existing item chair\n\n{"id": "chair", "cost_usd": 0}\n')
    assert.deepEqual(summaryOf(lines), { id: 'chair', cost_usd: 0 })
    assert.equal(summaryOf(['not json']), undefined)
    assert.equal(addMessage(lines, 'add', 'chair'), 'replaced existing item chair')
    assert.equal(addMessage(['{}'], 'add', 'chair'), 'added chair')
    assert.equal(addMessage(lines, 'rescale', 'chair'), 'refit chair ($0)')
  })
})

interface Job { readonly id: string; readonly status: 'queued' | 'running' | 'done' | 'failed'; readonly message: string }

void describe('job queues', () => {
  void test('ids as v1 made them', () => {
    assert.match(newJobId('l'), /^l-\d{8}-\d{6}-[0-9a-f]{4}$/)
    assert.match(newJobId('c', Date.UTC(2026, 10, 4, 20, 15, 0)), /^c-20261104-201500-[0-9a-f]{4}$/)
  })
  void test('one job at a time in the order queued, listed newest first; a failing job never stops the queue; copies only', async () => {
    const store = new JobStore<Job>()
    const ran: string[] = []
    let running = 0
    let most = 0
    const queue = new SerialQueue(async (id) => {
      running += 1
      most = Math.max(most, running)
      ran.push(id)
      store.update(id, { status: 'running' })
      await new Promise((resolve) => setTimeout(resolve, 10))
      running -= 1
      if (id === 'b') throw new Error('boom')
      store.update(id, { status: 'done' })
    }, (id, e) => {
      store.update(id, { status: 'failed', message: 'the server failed to run it (' + (e instanceof Error ? e.message : '') + ')' })
    }, async (id) => {
      ran.push('after ' + id)
      await Promise.resolve()
    })
    for (const id of ['a', 'b', 'c']) {
      const snap = store.add({ id, status: 'queued', message: '' })
      queue.push(snap.id)
    }
    await queue.drained()
    assert.equal(most, 1)
    assert.deepEqual(ran, ['a', 'after a', 'b', 'after b', 'c', 'after c'])
    assert.deepEqual(store.list().map((j) => j.id + ':' + j.status), ['c:done', 'b:failed', 'a:done'])
    assert.equal(store.get('b')?.message, 'the server failed to run it (boom)')
    const copy = store.get('a')
    assert.ok(copy !== null)
    assert.notEqual(copy, store.get('a'))
    assert.equal(store.get('nope'), null)
    assert.equal(store.position('c'), 2)
  })
  void test('an ended job keeps its first terminal status: a late status patch is refused, a message-only one applies', () => {
    const store = new JobStore<Job>()
    store.add({ id: 'd', status: 'running', message: 'working' })
    assert.equal(store.update('d', { status: 'done', message: 'added chair' })?.status, 'done')
    assert.equal(store.update('d', { status: 'failed', message: 'late failure' }), null)
    assert.equal(store.update('d', { status: 'running' }), null)
    assert.deepEqual(store.get('d'), { id: 'd', status: 'done', message: 'added chair' })
    assert.equal(store.update('d', { message: 'added chair (note)' })?.message, 'added chair (note)')
    assert.equal(store.update('d', { status: 'done', message: 'again' })?.message, 'again')
  })
  void test('a job dropped while queued (failed) refuses a late running or done', () => {
    const store = new JobStore<Job>()
    store.add({ id: 'q', status: 'queued', message: '' })
    assert.equal(store.update('q', { status: 'failed', message: 'the scene was deleted' })?.status, 'failed')
    assert.equal(store.update('q', { status: 'running', message: 'calibrating' }), null)
    assert.equal(store.update('q', { status: 'done', message: 'calibrated' }), null)
    assert.deepEqual(store.get('q'), { id: 'q', status: 'failed', message: 'the scene was deleted' })
  })
  void test('non-terminal moves still apply: queued -> done (rooms #end), running -> running with a new message', () => {
    const store = new JobStore<Job>()
    store.add({ id: 'r', status: 'queued', message: '' })
    assert.equal(store.update('r', { status: 'done', message: 'aligned' })?.status, 'done')
    store.add({ id: 's', status: 'running', message: 'aligning' })
    assert.equal(store.update('s', { status: 'running', message: 'aligning again' })?.message, 'aligning again')
    store.add({ id: 't', status: 'queued', message: '' })
    assert.equal(store.update('t', { status: 'failed', message: 'lost' })?.status, 'failed')
  })
  void test('jobStep: only an ended job is guarded, and only against a different status', () => {
    const all = ['queued', 'running', 'done', 'failed'] as const
    for (const from of all) {
      for (const to of all) {
        const ended = from === 'done' || from === 'failed'
        assert.equal(jobStep(from, to), !ended || from === to, from + ' -> ' + to)
      }
    }
  })
})

void describe('the spend cap', () => {
  void test('reserve against today\'s costs.csv and what runs; release; hold a timed-out job\'s estimate for the day; GET /api/spend\'s view', () => {
    const costs = path.join(DIR, 'costs.csv')
    let now = Date.UTC(2026, 10, 5, 12, 0, 0)
    const day = utcDay(now)
    fs.writeFileSync(costs, 'date,id,engine,cost_usd,mock,input\n' + day + 'T01:00:00Z,a,sam3d,0.02,true,x\n2026-11-04T23:00:00Z,b,idol,0.1,false,y\n')
    const cap = new SpendCap(costs, 0.03, () => now)
    assert.deepEqual(cap.view(), { day, spent_usd: 0.02, reserved_usd: 0, cap_usd: 0.03 })
    assert.equal(cap.reserve('free', 0), null)
    assert.equal(cap.reserve('j1', 0.005), null)
    assert.deepEqual(cap.view().reserved_usd, 0.005)
    const refused = cap.reserve('j2', 0.02)
    assert.deepEqual(refused, { error: "today's fal budget ($0.03) is used up: $0.02 spent and $0.01 reserved by calls still running, and this call costs $0.02", spent_usd: 0.02, cap_usd: 0.03 })
    assert.deepEqual(cap.reserve('j3', 0.0398)?.error, 'this call costs $0.0398, more than the daily fal budget ($0.03) allows')
    assert.equal(cap.holdForToday('j1'), 0.005)
    assert.equal(cap.view().reserved_usd, 0.005)
    cap.release('j1')
    assert.equal(cap.view().reserved_usd, 0.005, 'a held reservation isn\'t released by its old key')
    now += 24 * 3600 * 1000
    assert.deepEqual(cap.view(), { day: utcDay(now), spent_usd: 0, reserved_usd: 0, cap_usd: 0.03 })
    assert.equal(new SpendCap(path.join(DIR, 'missing.csv'), 2).spent(day), 0)
  })
})

void describe('fal', () => {
  let stub: http.Server
  let base = ''
  const seen: { auth: string; body: string; path: string }[] = []
  before(async () => {
    stub = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c: Buffer) => {
        body += c.toString('utf8')
      })
      req.on('end', () => {
        seen.push({ auth: req.headers.authorization ?? '', body, path: req.url ?? '' })
        if (req.url === '/fal-ai/ok') res.writeHead(200, { 'Content-Type': 'application/json' }).end('{"images": [{"url": "x"}]}')
        else if (req.url === '/fal-ai/nano-banana/edit') res.writeHead(422).end('{"detail": "did not generate the expected output"}')
        else if (req.url === '/fal-ai/broken') res.writeHead(500).end('x'.repeat(1000))
        else if (req.url === '/fal-ai/notjson') res.writeHead(200).end('<html>')
        else if (req.url === '/file.jpg') res.writeHead(200).end('jpegbytes')
        else res.writeHead(404, 'Not Found').end()
      })
    })
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve))
    const a = stub.address()
    base = 'http://127.0.0.1:' + String(typeof a === 'object' && a !== null ? a.port : 0)
  })
  after(async () => {
    stub.closeAllConnections()
    await new Promise((resolve) => stub.close(resolve))
  })
  void test('mock mode and its cost switch, as v1 read them', () => {
    assert.equal(falMock({ MIDSTUDY_FAL_MOCK: 'fixtures/fal' }), true)
    assert.equal(falMock({ MIDSTUDY_FAL_MOCK: '' }), false)
    assert.equal(falMockDir({}), null)
    assert.equal(mockCost({ MIDSTUDY_FAL_MOCK_COST: '1' }), true)
    assert.equal(mockCost({ MIDSTUDY_FAL_MOCK_COST: '0' }), false)
    assert.equal(countsAgainstCap({ MIDSTUDY_FAL_MOCK: 'x' }), false)
    assert.equal(countsAgainstCap({ MIDSTUDY_FAL_MOCK: 'x', MIDSTUDY_FAL_MOCK_COST: '1' }), true)
    assert.equal(countsAgainstCap({}), true)
    assert.equal(mockSlug('fal-ai/sam-3/3d-objects'), 'sam-3-3d-objects')
    assert.equal(mockSlug('speridlabs/idol'), 'speridlabs-idol')
  })
  void test('the key: the environment first, then <repo>/.env unless MIDSTUDY_NO_DOTENV (a scratch repo here, never the real .env)', async () => {
    const repo = await makeTempDir('midstudy-falkey-')
    try {
      fs.writeFileSync(path.join(repo, '.env'), '# fake\nexport FAL_KEY="test-not-a-key"\n')
      assert.equal(falKey(repo, { FAL_KEY: 'from-env-not-a-key' }), 'from-env-not-a-key')
      assert.equal(falKey(repo, {}), 'test-not-a-key')
      assert.equal(falKey(repo, { MIDSTUDY_NO_DOTENV: '1' }), null)
      assert.equal(falKey(repo, { MIDSTUDY_NO_DOTENV: '0' }), 'test-not-a-key')
      fs.rmSync(path.join(repo, '.env'))
      assert.equal(falKey(repo, {}), null)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
  void test('the request log: one line per upload, call and fetch, as Python\'s json.dumps writes it; falCall logs its call', async () => {
    const log = path.join(DIR, 'mock.jsonl')
    const env = { MIDSTUDY_FAL_MOCK_LOG: log }
    logFal({ op: 'call', endpoint: 'openrouter/router', url: falRunUrl('openrouter/router'), args: { prompt: 'é ‹/page› 😀', n: 1, t: 0.2, ok: true, none: null, list: [1, 'x'] } }, env)
    logFal(uploadRecord('/tmp/x/engine-input.jpg', Buffer.from('abc'), 'image/jpeg', 'https://mock.fal.invalid/uploads/engine-input.jpg'), env)
    logFal({ op: 'fetch', url: 'https://v3.fal.media/files/a/model.glb', file: 'model.glb' }, env)
    logFal({ op: 'fetch', url: 'u', file: 'f' }, {})
    const text = fs.readFileSync(log, 'utf8')
    assert.equal(text, [
      '{"op": "call", "endpoint": "openrouter/router", "url": "https://fal.run/openrouter/router", "args": {"prompt": "\\u00e9 \\u2039/page\\u203a \\ud83d\\ude00", "n": 1, "t": 0.2, "ok": true, "none": null, "list": [1, "x"]}}',
      '{"op": "upload", "file": "engine-input.jpg", "content_type": "image/jpeg", "bytes": 3, "sha256": "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", "url": "https://mock.fal.invalid/uploads/engine-input.jpg"}',
      '{"op": "fetch", "url": "https://v3.fal.media/files/a/model.glb", "file": "model.glb"}',
      '',
    ].join('\n'))
    assert.equal(falQueueUrl('fal-ai/sam-3/3d-objects', {}), 'https://queue.fal.run/fal-ai/sam-3/3d-objects')
    assert.equal(falQueueUrl('speridlabs/idol', { FAL_RUN_HOST: 'example.invalid' }), 'https://queue.example.invalid/speridlabs/idol')
    // a live call is logged too (before it is sent)
    process.env['MIDSTUDY_FAL_MOCK_LOG'] = log
    try {
      await falCall('fal-ai/ok', { prompt: 'p' }, 'test-not-a-key', { baseUrl: base })
    } finally {
      delete process.env['MIDSTUDY_FAL_MOCK_LOG']
    }
    const last: unknown = JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n').at(-1) ?? '')
    assert.deepEqual(last, { op: 'call', endpoint: 'fal-ai/ok', url: base + '/fal-ai/ok', args: { prompt: 'p' } })
    assert.doesNotMatch(fs.readFileSync(log, 'utf8'), /test-not-a-key/)
  })
  void test('falCall: POST <base>/<endpoint>, Key auth, the JSON arguments; v1\'s FalError sentences', async () => {
    assert.deepEqual(await falCall('fal-ai/ok', { image_url: 'data:x', prompt: 'p' }, 'test-not-a-key', { baseUrl: base }), { images: [{ url: 'x' }] })
    assert.deepEqual(seen.at(-1), { auth: 'Key test-not-a-key', body: '{"image_url":"data:x","prompt":"p"}', path: '/fal-ai/ok' })
    const message = async (endpoint: string, baseUrl = base): Promise<string> => {
      try {
        await falCall(endpoint, {}, 'test-not-a-key', { baseUrl, timeoutMs: 3000 })
        return 'ok'
      } catch (e) {
        return e instanceof FalError ? e.message : 'not a FalError'
      }
    }
    assert.equal(await message('fal-ai/nano-banana/edit'), 'fal-ai/nano-banana/edit returned no image this time. Try the render again.')
    assert.equal(await message('fal-ai/broken'), 'fal fal-ai/broken returned HTTP 500: ' + 'x'.repeat(400))
    assert.match(await message('fal-ai/notjson'), /^fal fal-ai\/notjson returned something that isn't JSON \(/)
    assert.match(await message('fal-ai/ok', 'http://127.0.0.1:1'), /^could not reach fal \(fal-ai\/ok\): /)
  })
  void test('download: a data: URI or a GET', async () => {
    assert.equal(Buffer.from(await download('data:image/jpeg;base64,' + Buffer.from('abc').toString('base64'))).toString(), 'abc')
    assert.equal(Buffer.from(await download(base + '/file.jpg')).toString(), 'jpegbytes')
    await assert.rejects(download(base + '/missing'), { name: 'HTTPError', message: 'HTTP Error 404: Not Found' })
  })
})

void describe('files', () => {
  void test('atomic writes (mode 0600, no temp file left), v1\'s JSON layouts, tolerant reads', async () => {
    const f = path.join(DIR, 'sub', 'x.json')
    await atomicWrite(f, jsonText({ a: 'é', b: [1, 2.5, { c: null }], d: {} }, 'ascii'))
    assert.equal(fs.readFileSync(f, 'utf8'), '{\n  "a": "\\u00e9",\n  "b": [\n    1,\n    2.5,\n    {\n      "c": null\n    }\n  ],\n  "d": {}\n}\n')
    assert.equal(fs.statSync(f).mode & 0o777, 0o600)
    assert.deepEqual(fs.readdirSync(path.dirname(f)), ['x.json'])
    assert.equal(jsonText({ a: 'é' }, 'utf8'), '{\n  "a": "é"\n}\n')
    assert.throws(() => jsonText({ a: NaN }, 'utf8'), /Out of range float values are not JSON compliant/)
    assert.deepEqual(readJsonFile(f), { a: 'é', b: [1, 2.5, { c: null }], d: {} })
    assert.equal(readJsonFile(path.join(DIR, 'missing.json')), null)
    fs.writeFileSync(path.join(DIR, 'bad.json'), '{')
    assert.equal(readJsonFile(path.join(DIR, 'bad.json')), null)
  })
})

void describe('image data URIs (core/js/node.ts)', () => {
  // The face decodes a canonical payload itself (Node's base64: one that re-encodes to itself) and leaves everything
  // else to the media kernel. The kernel drops whitespace before its strict decode, so a payload with a space put in is
  // the kernel's answer for the same base64: the two must agree on every payload (odd trailing bits, both padding
  // lengths).
  void test('the canonical fast path decodes exactly as the kernel; anything else is the kernel\'s', () => {
    let seed = 20261106
    const rnd = (n: number): number => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const ALPHA = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
    const cases: string[] = ['AAAA', 'AA==', 'AB==', 'AAA=', 'AAB=', '////', '+/+/', 'QUJD', 'QUI=', 'QQ==', 'Qf==', 'Qh==', 'QUJ=']
    for (let i = 0; i < 3000; i++) {
      const quads = 1 + rnd(40)
      let s = ''
      for (let j = 0; j < quads * 4; j++) s += ALPHA.charAt(rnd(64))
      const pad = rnd(3)
      cases.push(s.slice(0, s.length - pad) + '='.repeat(pad))
    }
    // and canonical by construction (the fast path's case), every length mod 3
    for (let i = 0; i < 3000; i++) cases.push(Buffer.from(Array.from({ length: 1 + rnd(300) }, () => rnd(256))).toString('base64'))
    for (const payload of cases) {
      for (const [prefix, type] of [['data:image/jpeg;base64,', 'jpeg'], ['data:image/jpg;base64,', 'jpeg'], ['data:image/png;base64,', 'png']] as const) {
        const fast = decodeImageDataUri(prefix + payload, type)
        const at = 1 + rnd(payload.length - 1)
        const kernel = decodeImageDataUri(prefix + payload.slice(0, at) + ' ' + payload.slice(at), type)
        assert.deepEqual(fast, kernel, payload)
      }
    }
    // not canonical: the kernel decides (whitespace, misplaced or excess padding, foreign characters, the wrong type)
    const kernelOnly: [string, 'jpeg' | 'png', boolean][] = [['data:image/jpeg;base64,AA=A', 'jpeg', false], ['data:image/jpeg;base64,=AAA', 'jpeg', false],
      ['data:image/jpeg;base64,A===', 'jpeg', false], ['data:image/jpeg;base64,AAA', 'jpeg', false], ['data:image/jpeg;base64,AA-_', 'jpeg', false],
      ['data:image/png;base64,AAAA', 'jpeg', false], ['data:image/jpeg;base64,AAAA', 'png', false], ['data:image/jpeg;base64,AA AA', 'jpeg', true],
      ['data:image/jpeg;base64,AA\nAA', 'jpeg', true], ['data:image/JPEG;base64,AAAA', 'jpeg', false], ['data:image/jpeg;base64,', 'jpeg', false]]
    for (const [uri, type, ok] of kernelOnly) assert.equal(decodeImageDataUri(uri, type).ok, ok, uri)
  })
})
