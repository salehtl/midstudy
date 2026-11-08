// The library routes around failures: a delete or restore that can't commit leaves the item where it was and the trash
// consistent, a request owns its temp folder and reservation until a job takes them, and a from-URL add keeps its
// reservation across the hand-off. Faults: a library.json that breaks its schema (strict mode refuses the write), a
// TMPDIR that doesn't exist, a SpendCap that throws.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { describe, test } from 'node:test'
import type { ServerDeps } from '../../src/deps.ts'
import { createServer } from '../../src/http/server.ts'
import { routes } from '../../src/routes/library.ts'
import { SpendCap, type SpendRefusal } from '../../src/spend.ts'
import { api, REPO, request, SCRATCH, startServer, type Answer, type Running } from '../helpers.ts'

const PHOTO = fs.readFileSync(path.join(REPO, 'fixtures/scenes/living-wide/photo.jpg'))
const RECORD = ['--midstudy-add', 'node server/test/fixtures/record-add.mjs']
const DIMS = { w: 50, d: 50, h: 80 }
const META = Buffer.from(JSON.stringify({ name: 'Chair', dims_cm: DIMS, engine: 'sam3d' })).toString('base64')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function item(id: string): Record<string, unknown> {
  return {
    id, name: id, dims_cm: DIMS, assets: { glb: id + '/model.glb' }, default_render: 'glb',
    source: { engine: 'glb', input: 'x.glb', cost_usd: 0, created: '2026-11-08T00:00:00Z' },
  }
}

function writeLibrary(s: Running, items: readonly unknown[]): void {
  fs.writeFileSync(path.join(s.library, 'library.json'), JSON.stringify({ version: 1, items }, null, 2) + '\n')
}

function field(v: unknown, key: string): unknown {
  return v !== null && typeof v === 'object' ? Reflect.get(v, key) : undefined
}

function idsOnDisk(s: Running): unknown[] {
  const doc: unknown = JSON.parse(fs.readFileSync(path.join(s.library, 'library.json'), 'utf8'))
  const items = field(doc, 'items')
  return Array.isArray(items) ? items.map((i: unknown) => field(i, 'id')) : []
}

function trashFolders(s: Running): string[] {
  const root = path.join(s.library, '.trash')
  return fs.existsSync(root) ? fs.readdirSync(root) : []
}

function chairFolder(s: Running): string {
  const folder = path.join(s.library, 'chair')
  fs.mkdirSync(folder)
  fs.writeFileSync(path.join(folder, 'model.glb'), 'glTF')
  return folder
}

async function until<T>(what: string, get: () => T | null): Promise<T> {
  const end = Date.now() + 15000
  for (;;) {
    const v = get()
    if (v !== null) return v
    if (Date.now() > end) throw new Error('timed out waiting for ' + what)
    await sleep(25)
  }
}

function scratchTemp(name: string): string {
  const dir = path.join(SCRATCH, 'tmp-' + String(process.pid) + '-' + name)
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function fromUrl(s: Running, url: string): Promise<Answer> {
  return api(s.base, 'POST', '/api/library/items/from-url', { image_url: url, name: 'Chair', dims_cm: DIMS, engine: 'sam3d' })
}

/** A SpendCap whose job reservations throw, so newJob throws after the upload was accepted. */
class ThrowingCap extends SpendCap {
  override reserve(key: string, amount: number): SpendRefusal | null {
    if (key.startsWith('l-')) throw new Error('no reservation')
    return super.reserve(key, amount)
  }
}

void describe('library routes', () => {
  void test('a delete that cannot commit leaves the item and its folder, and no trash copy', async () => {
    const s = await startServer({ name: 'lib-delete', env: { MIDSTUDY_STRICT: '1' } })
    try {
      const folder = chairFolder(s)
      writeLibrary(s, [item('chair'), { id: 'BAD' }])
      const r = await api(s.base, 'DELETE', '/api/library/items/chair')
      assert.equal(r.status, 500, r.text)
      assert.deepEqual(idsOnDisk(s), ['chair', 'BAD'])
      assert.ok(fs.existsSync(path.join(folder, 'model.glb')), 'the folder is back')
      assert.deepEqual(trashFolders(s), [])
    } finally {
      await s.stop()
    }
  })

  void test('a restore that cannot commit stays restorable', async () => {
    const s = await startServer({ name: 'lib-restore', env: { MIDSTUDY_STRICT: '1' } })
    try {
      const folder = chairFolder(s)
      writeLibrary(s, [item('chair')])
      assert.equal((await api(s.base, 'DELETE', '/api/library/items/chair')).status, 200)
      writeLibrary(s, [{ id: 'BAD' }])
      const failed = await api(s.base, 'POST', '/api/library/items/chair/restore')
      assert.equal(failed.status, 500, failed.text)
      assert.ok(!fs.existsSync(folder), 'the folder went back to the trash')
      writeLibrary(s, [])
      const listed = await api(s.base, 'GET', '/api/library')
      const trash = field(listed.json, 'trash')
      assert.ok(Array.isArray(trash) && trash.length === 1, listed.text)
      const again = await api(s.base, 'POST', '/api/library/items/chair/restore')
      assert.equal(again.status, 200, again.text)
      assert.ok(fs.existsSync(path.join(folder, 'model.glb')))
      assert.deepEqual(trashFolders(s), [])
    } finally {
      await s.stop()
    }
  })

  void test('PATCHes that change dims queue their rescales in request order', async () => {
    const s = await startServer({ name: 'lib-patch', args: RECORD })
    try {
      writeLibrary(s, [item('chair')])
      const first = api(s.base, 'PATCH', '/api/library/items/chair', { dims_cm: { ...DIMS, w: 60 } })
      await sleep(20)
      const second = api(s.base, 'PATCH', '/api/library/items/chair', { dims_cm: { ...DIMS, w: 70 } })
      assert.deepEqual([(await first).status, (await second).status], [202, 202])
      const log = path.join(s.library, 'record-add.log')
      const lines = await until('both rescales to run', () => {
        const all = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []
        return all.length >= 2 ? all : null
      })
      assert.deepEqual(lines.map((l) => /--dims=(\d+)/.exec(l)?.[1]), ['60', '70'])
    } finally {
      await s.stop()
    }
  })

  void test('a from-URL add that fails before the download gives its reservation back', async () => {
    const s = await startServer({
      name: 'lib-url-tmp', args: ['--daily-spend-usd', '5'],
      env: { MIDSTUDY_FAL_MOCK_COST: '1', TMPDIR: path.join(SCRATCH, 'no-such-folder-' + String(process.pid)) },
    })
    try {
      const r = await fromUrl(s, 'http://127.0.0.1:9/x.jpg')
      assert.equal(r.status, 500, r.text)
      assert.equal(field((await api(s.base, 'GET', '/api/spend')).json, 'reserved_usd'), 0)
    } finally {
      await s.stop()
    }
  })

  void test('a from-URL add keeps its reservation across the hand-off, even when costs.csv grew during the download', async () => {
    let costs = ''
    const pages = http.createServer((_req, res) => {
      fs.writeFileSync(costs, 'date,id,engine,cost_usd,mock,input\n' + new Date().toISOString() + ',a,sam3d,0.02,false,x\n')
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': PHOTO.length })
      res.end(PHOTO)
    })
    await new Promise<void>((resolve) => {
      pages.listen(0, '127.0.0.1', resolve)
    })
    const address = pages.address()
    assert.ok(address !== null && typeof address === 'object')
    const s = await startServer({
      name: 'lib-url-handoff', args: ['--daily-spend-usd', '0.02', ...RECORD],
      env: { MIDSTUDY_FAL_MOCK_COST: '1', MIDSTUDY_FETCH_ALLOW: '127.0.0.1:' + String(address.port) },
    })
    costs = s.costs
    try {
      const r = await fromUrl(s, 'http://127.0.0.1:' + String(address.port) + '/x.jpg')
      assert.equal(r.status, 202, r.text)
    } finally {
      await s.stop()
      pages.close()
    }
  })

  void test('an upload whose job cannot be queued leaves no temp folder', async () => {
    const temp = scratchTemp('upload')
    const before = process.env['TMPDIR']
    process.env['TMPDIR'] = temp
    const dir = path.join(SCRATCH, 'lib-upload-' + String(process.pid))
    fs.rmSync(dir, { recursive: true, force: true })
    fs.mkdirSync(dir, { recursive: true })
    const costsFile = path.join(dir, 'costs.csv')
    const deps: ServerDeps = {
      config: {
        repo: REPO, host: '127.0.0.1', port: 0, scenesDir: dir, roomsDir: dir, layoutsDir: dir, rendersDir: dir, libraryDir: dir, costsFile,
        calib: ['false'], midstudyAdd: ['false'], dailySpendUsd: 2, allowedHosts: [], socketTimeoutSeconds: 30,
      },
      spend: new ThrowingCap(costsFile, 2),
      onShutdown: () => undefined,
    }
    const server = createServer({
      routes: routes(deps), staticDirs: { planner: dir, library: dir, scenes: dir, renders: dir }, allowedHostNames: [], socketTimeoutSeconds: 30,
    })
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      assert.ok(address !== null && typeof address === 'object')
      const r = await request('http://127.0.0.1:' + String(address.port), 'POST', '/api/library/items', {
        headers: { 'X-Midstudy': '1', 'X-Midstudy-Kind': 'image', 'X-Midstudy-Filename': 'chair.jpg', 'X-Midstudy-Meta': META },
        body: PHOTO,
      })
      assert.equal(r.status, 500, r.text)
      assert.deepEqual(fs.readdirSync(temp).filter((f) => f.startsWith('midstudy-upload-')), [])
    } finally {
      await new Promise((resolve) => {
        server.close(resolve)
        server.closeAllConnections()
      })
      if (before === undefined) delete process.env['TMPDIR']
      else process.env['TMPDIR'] = before
    }
  })

  void test('a scene upload that cannot be created leaves no temp folder', async () => {
    const temp = scratchTemp('scene')
    const s = await startServer({ name: 'scene-tmp', env: { TMPDIR: temp } })
    try {
      fs.rmSync(s.scenes, { recursive: true })
      fs.writeFileSync(s.scenes, 'not a folder')
      const r = await request(s.base, 'POST', '/api/scenes', { headers: { 'X-Midstudy': '1', 'X-Midstudy-Filename': 'room.jpg' }, body: PHOTO })
      assert.equal(r.status, 500, r.text)
      assert.deepEqual(fs.readdirSync(temp).filter((f) => f.startsWith('midstudy-scene-')), [])
    } finally {
      await s.stop()
    }
  })
})
