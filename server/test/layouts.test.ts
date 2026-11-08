// PUT /api/layouts/{layout} against the delete of its owner: the scene or room is tested again once the body has
// arrived, so a PUT that was waiting for its body neither recreates the deleted owner's layouts folder (which would
// block the owner's restore with "exists") nor answers 200 for a layout nobody can open.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { after, before, describe, test } from 'node:test'
import { REPO, api, bodyOf, errorOf, request, startServer, statusOf, type Running } from './helpers.ts'

const PHOTO = fs.readFileSync(path.join(REPO, 'fixtures/scenes/living-wide/photo.jpg'))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function text(v: unknown, key: string): string {
  const got: unknown = typeof v === 'object' && v !== null ? Reflect.get(v, key) : undefined
  assert.equal(typeof got, 'string', key + ' in ' + JSON.stringify(v))
  return String(got)
}

async function newScene(s: Running): Promise<string> {
  const a = await request(s.base, 'POST', '/api/scenes', { headers: { 'X-Midstudy': '1', 'X-Midstudy-Filename': 'living.jpg' }, body: PHOTO })
  assert.equal(a.status, 202, a.text)
  const scene = text(a.json, 'scene')
  const end = Date.now() + 30000
  for (;;) {
    const st = text((await api(s.base, 'GET', '/api/scenes/' + scene)).json, 'calib_status')
    if (st === 'done') return scene
    assert.notEqual(st, 'failed')
    assert.ok(Date.now() < end, 'the scene did not calibrate')
    await sleep(50)
  }
}

/** A PUT whose head is sent now and whose body waits for `send()`; `answer` is the raw response. */
async function headFirst(s: Running, target: string, body: string): Promise<{ readonly send: () => void; readonly answer: Promise<string> }> {
  const sock = net.connect(s.port, '127.0.0.1')
  await new Promise<void>((resolve, reject) => {
    sock.once('connect', resolve)
    sock.once('error', reject)
  })
  const answer = new Promise<string>((resolve, reject) => {
    let got = ''
    sock.on('data', (d: Buffer) => {
      got += d.toString('utf8')
      const at = got.indexOf('\r\n\r\n')
      const m = /content-length: (\d+)/i.exec(got)
      if (at >= 0 && m?.[1] !== undefined && Buffer.byteLength(got.slice(at + 4)) >= Number(m[1])) {
        sock.destroy()
        resolve(got)
      }
    })
    sock.on('error', reject)
  })
  sock.write('PUT ' + target + ' HTTP/1.1\r\nHost: 127.0.0.1:' + String(s.port) + '\r\nX-Midstudy: 1\r\nContent-Type: application/json\r\nContent-Length: ' + String(Buffer.byteLength(body)) + '\r\n\r\n')
  // The route has to have run its first check and be waiting for the body.
  await sleep(150)
  return {
    send: () => {
      sock.write(body)
    },
    answer,
  }
}

const LAYOUT = JSON.stringify({ items: [] })

void describe('PUT /api/layouts re-checks its owner after the body', () => {
  let s: Running
  before(async () => {
    s = await startServer({ name: 'layouts', env: { MIDSTUDY_STRICT: '1' } })
  })
  after(async () => {
    await s.stop()
  })

  void test('a scene deleted while the body is on its way: 404, no folder, and the scene restores', async () => {
    const scene = await newScene(s)
    const put = await headFirst(s, '/api/layouts/late?scene=' + scene, LAYOUT)
    assert.equal((await api(s.base, 'DELETE', '/api/scenes/' + scene)).status, 200)
    put.send()
    const raw = await put.answer
    assert.equal(statusOf(raw), 404, raw)
    const fromPut: unknown = JSON.parse(bodyOf(raw))
    const fresh = await api(s.base, 'GET', '/api/layouts?scene=' + scene)
    assert.equal(fresh.status, 404)
    assert.equal(text(fromPut, 'error'), errorOf(fresh), 'the same refusal as the first check')
    assert.equal(fs.existsSync(path.join(s.layouts, scene)), false, 'layouts/<scene>/ was recreated')
    const back = await api(s.base, 'POST', '/api/scenes/' + scene + '/restore')
    assert.equal(back.status, 200, back.text)
  })

  void test('a room deleted while the body is on its way: 404 and no layouts/@<room>/ folder', async () => {
    const scene = await newScene(s)
    const made = await api(s.base, 'POST', '/api/rooms', { title: 'Late room', scenes: [scene] })
    assert.equal(made.status, 201, made.text)
    const room = text(made.json, 'name')
    const put = await headFirst(s, '/api/layouts/late?room=' + room, LAYOUT)
    assert.equal((await api(s.base, 'DELETE', '/api/rooms/' + room)).status, 200)
    put.send()
    const raw = await put.answer
    assert.equal(statusOf(raw), 404, raw)
    assert.equal(fs.existsSync(path.join(s.layouts, '@' + room)), false, 'layouts/@<room>/ was recreated')
  })

  void test('an owner still there: the PUT writes as before', async () => {
    const scene = await newScene(s)
    const put = await headFirst(s, '/api/layouts/kept?scene=' + scene, LAYOUT)
    put.send()
    const raw = await put.answer
    assert.equal(statusOf(raw), 200, raw)
    assert.ok(fs.existsSync(path.join(s.layouts, scene, 'kept.json')))
  })
})
