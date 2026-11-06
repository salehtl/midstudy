// The library lock from the routes' side (contract §2.8 One writer; PUT thumb "503 while a job holds the library"):
// while another process holds `<library>/.lock.d` (as midstudy-add does for a whole run), PATCH, DELETE, restore and
// a thumbnail wait 60 s, then answer 503 with v1's sentence and change nothing; GET /api/library doesn't wait; and a
// write that is waiting goes through as soon as the holder is gone (a killed holder's lock is reclaimed at once).
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LIBRARY_BUSY } from '../../src/logic/http.ts'
import { api, errorOf, REPO, startServer } from '../helpers.ts'

const JPEG = fs.readFileSync(path.join(REPO, 'fixtures/fal/sam-3-3d-objects/input.jpg'))
const THUMB = { image: 'data:image/jpeg;base64,' + JPEG.toString('base64') }

function hold(library: string): { readonly child: ChildProcess; readonly held: Promise<void> } {
  const child = spawn(process.execPath, [path.join(REPO, 'server/test/library/hold-lock.ts'), library], { cwd: REPO, stdio: ['ignore', 'pipe', 'inherit'] })
  const held = new Promise<void>((resolve) => {
    child.stdout.on('data', (d: Buffer) => {
      if (d.toString('utf8').includes('held')) resolve()
    })
  })
  return { child, held }
}

void test('library writes wait 60 s for a held lock, then answer 503 and change nothing; reads never wait; a freed lock lets the write through', { timeout: 150000 }, async () => {
  const s = await startServer({ name: 'library-lock' })
  try {
    const item = { id: 'chair', name: 'Chair', dims_cm: { w: 80.0, d: 85, h: 95 }, assets: { glb: 'chair/model.glb' }, default_render: 'glb', source: { engine: 'glb', input: 'chair.glb', cost_usd: 0, created: '2026-11-05T12:00:00Z' } }
    const libraryJson = JSON.stringify({ version: 1, items: [item] }, null, 2).replace('"w": 80', '"w": 80.0') + '\n'
    fs.writeFileSync(path.join(s.library, 'library.json'), libraryJson)
    fs.mkdirSync(path.join(s.library, 'chair'))
    fs.writeFileSync(path.join(s.library, 'chair', 'model.glb'), 'glTF')
    const trashed = path.join(s.library, '.trash', 'gone-20261105-120000')
    fs.mkdirSync(trashed, { recursive: true })
    fs.writeFileSync(path.join(trashed, 'entry.json'), JSON.stringify({ deleted: '2026-11-05T12:00:00Z', entry: { ...item, id: 'gone', name: 'Gone' } }))

    const first = hold(s.library)
    await first.held
    const t0 = Date.now()
    const writes = Promise.all([
      api(s.base, 'PATCH', '/api/library/items/chair', { name: 'Renamed' }),
      api(s.base, 'DELETE', '/api/library/items/chair'),
      api(s.base, 'POST', '/api/library/items/gone/restore'),
      api(s.base, 'PUT', '/api/library/items/chair/thumb', THUMB),
    ])
    const read = await api(s.base, 'GET', '/api/library')
    assert.equal(read.status, 200)
    assert.ok(Date.now() - t0 < 5000, 'GET /api/library does not wait for the lock')
    const answers = await writes
    const ms = Date.now() - t0
    for (const a of answers) {
      assert.equal(a.status, 503)
      assert.equal(errorOf(a), LIBRARY_BUSY)
    }
    assert.ok(ms >= 59000 && ms < 80000, 'they waited the 60 s: ' + String(ms))
    assert.equal(fs.readFileSync(path.join(s.library, 'library.json'), 'utf8'), libraryJson, 'nothing written')
    assert.ok(fs.existsSync(path.join(s.library, 'chair', 'model.glb')) && !fs.existsSync(path.join(s.library, 'chair', 'thumb.jpg')))
    assert.ok(fs.existsSync(path.join(trashed, 'entry.json')))
    first.child.kill('SIGKILL')

    const second = hold(s.library)
    await second.held
    const t1 = Date.now()
    const waiting = api(s.base, 'PUT', '/api/library/items/chair/thumb', THUMB)
    setTimeout(() => second.child.kill('SIGKILL'), 1500)
    const done = await waiting
    assert.equal(done.status, 200, done.text)
    assert.ok(Date.now() - t1 < 10000, 'the thumbnail went through once the holder was gone')
    assert.ok(fs.existsSync(path.join(s.library, 'chair', 'thumb.jpg')))
    const after = fs.readFileSync(path.join(s.library, 'library.json'), 'utf8')
    assert.ok(after.includes('"w": 80.0') && after.includes('"thumb": "chair/thumb.jpg"'), after)
  } finally {
    await s.stop()
  }
})
