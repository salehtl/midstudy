// The server's stop (SIGTERM/SIGINT): no tool outlives it (the running midstudy-add and its grandchild are ended, the
// queued one is never started), it exits within its limit, and a request already in flight still gets its answer.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { describe, test } from 'node:test'
import { REPO, api, request, startServer, statusOf, type Running } from './helpers.ts'

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const PHOTO = fs.readFileSync(path.join(REPO, 'fixtures/scenes/living-wide/photo.jpg'))

function exists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until<T>(what: string, get: () => T | null | Promise<T | null>, ms = 15000): Promise<T> {
  const end = Date.now() + ms
  for (;;) {
    const v = await get()
    if (v !== null) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await sleep(50)
  }
}

/** Sends SIGTERM (the helper's stop()) and resolves with how long the server took to exit, failing past 20 s. */
function stopTimed(s: Running): Promise<number> {
  const t0 = Date.now()
  const stopped = s.stop().then(() => Date.now() - t0)
  let timer: NodeJS.Timeout | undefined
  const limit = new Promise<number>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('the server did not exit in 20 s'))
    }, 20000)
  })
  return Promise.race([stopped, limit]).finally(() => {
    clearTimeout(timer)
  })
}

/** A field of a JSON object answer. */
function field(v: unknown, key: string): unknown {
  return v !== null && typeof v === 'object' ? Reflect.get(v, key) : undefined
}

function pidFiles(library: string): string[] {
  return fs.readdirSync(library).filter((f) => /^sleepy-add-\d+\.json$/.test(f))
}

void describe('server stop', () => {
  void test('SIGTERM ends the running midstudy-add and its grandchild, never starts the queued one, and exits in time', async () => {
    const s = await startServer({ name: 'shutdown-tools', args: ['--midstudy-add', 'node server/test/fixtures/sleepy-add.mjs'] })
    const meta = Buffer.from(JSON.stringify({ name: 'Chair', dims_cm: { w: 50, d: 50, h: 80 }, engine: 'sam3d' })).toString('base64')
    for (const n of [1, 2]) {
      const r = await request(s.base, 'POST', '/api/library/items', {
        headers: { 'X-Midstudy': '1', 'X-Midstudy-Kind': 'image', 'X-Midstudy-Filename': 'chair' + String(n) + '.jpg', 'X-Midstudy-Meta': meta },
        body: PHOTO,
      })
      assert.equal(r.status, 202, r.text)
    }
    const file = await until('sleepy-add to start', () => pidFiles(s.library)[0] ?? null)
    const started: unknown = JSON.parse(fs.readFileSync(path.join(s.library, file), 'utf8'))
    assert.ok(started !== null && typeof started === 'object')
    const pids = [Reflect.get(started, 'pid'), Reflect.get(started, 'grandchild')].map(Number)
    for (const p of pids) assert.ok(exists(p), 'pid ' + String(p) + ' runs before the stop')
    const ms = await stopTimed(s)
    assert.ok(ms < 12000, 'the server exited in ' + String(ms) + ' ms')
    for (const p of pids) assert.ok(await until('pid ' + String(p) + ' to go', () => (exists(p) ? null : true), 3000), 'pid ' + String(p) + ' is gone')
    await sleep(500)
    assert.deepEqual(pidFiles(s.library), [file], 'the queued add never started')
  })

  void test('a layout PUT whose body arrives after SIGTERM still gets its 200, and its keep-alive connection does not hold the exit', async () => {
    const s = await startServer({ name: 'shutdown-inflight', args: ['--calib', 'python3 fixtures/stub_calib.py'] })
    const up = await request(s.base, 'POST', '/api/scenes', { headers: { 'X-Midstudy': '1', 'X-Midstudy-Filename': 'living-wide.jpg' }, body: PHOTO })
    assert.equal(up.status, 202, up.text)
    const scene = String(field(up.json, 'scene'))
    await until('the scene to calibrate', async () => {
      const st = field((await api(s.base, 'GET', '/api/scenes/' + scene)).json, 'calib_status')
      return st === 'done' || st === 'failed' ? true : null
    })
    const body = Buffer.from(JSON.stringify({ version: 1, name: 'one', items: [{ uid: 'u1', id: 'probe-box', render: 'glb', position: [0.5, 0, -2.5], rotation_y_deg: 30 }] }))
    const head = 'PUT /api/layouts/one?scene=' + scene + ' HTTP/1.1\r\nHost: 127.0.0.1:' + String(s.port) + '\r\nX-Midstudy: 1\r\nContent-Type: application/json\r\n' +
      'Content-Length: ' + String(body.length) + '\r\n\r\n'
    const sock = net.connect(s.port, '127.0.0.1')
    let text = ''
    sock.on('data', (d: Buffer) => {
      text += d.toString('latin1')
    })
    const closed = new Promise<void>((resolve) => {
      sock.on('close', () => {
        resolve()
      })
    })
    await new Promise<void>((resolve) => sock.once('connect', resolve))
    sock.write(head)
    await sleep(300)
    const exited = stopTimed(s)
    await sleep(500)
    sock.write(body)
    await closed
    assert.equal(statusOf(text), 200, text)
    assert.ok(fs.readdirSync(s.layouts, { recursive: true }).some((f) => String(f).endsWith('one.json')), 'the layout was written')
    assert.ok((await exited) < 3000, 'the keep-alive connection was closed once its request ended')
  })
})
