// The library API, v1 and v2 side by side: planner/serve.py and node server/src/main.ts (strict mode) each get their
// own scratch library and the same stand-in midstudy-add (fake_add.py), and the same script of requests: every upload
// refusal in v1's order, adds and failed adds (job objects), from-URL adds against a local web server (refusals,
// fetch errors, a download), PATCH (every rule, in place, the rescale job), thumbnails, DELETE and restore, the trash's
// order, and the spend cap (402s, reservations held by running jobs). Every answer must have the same status and the
// same JSON (job ids, times and trash stamps normalized), and the files they leave (library.json byte for byte,
// entry.json, the argument lists midstudy-add got, the thumbnail) must be the same. Skipped when planner/serve.py is gone.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { mockEnv, REPO, request, SCRATCH, tcp, type Answer } from '../helpers.ts'
import { skipV1 } from './oracle.ts'

const FAKE_ADD = 'python3 server/test/library/fake_add.py'
const JPEG = fs.readFileSync(path.join(REPO, 'fixtures/fal/sam-3-3d-objects/input.jpg'))
const GLB = fs.readFileSync(path.join(REPO, 'fixtures/models/arrow.glb'))
const CUBE_ZIP = fs.readFileSync(path.join(REPO, 'fixtures/models/cube-obj.zip'))

interface Server {
  readonly base: string
  readonly port: number
  readonly library: string
  stop(): Promise<void>
}

/** Starts v1 or v2 with scratch folders and the stand-in midstudy-add; resolves once it prints its address. */
async function launch(which: 'v1' | 'v2', name: string, args: readonly string[], env: Readonly<Record<string, string>>): Promise<Server> {
  const dir = path.join(SCRATCH, 'library-routes-' + String(process.pid) + '-' + name + '-' + which)
  fs.rmSync(dir, { recursive: true, force: true })
  const library = path.join(dir, 'library')
  fs.mkdirSync(library, { recursive: true })
  const common = ['--port', '0', '--host', '127.0.0.1', '--scenes-dir', path.join(dir, 'scenes'), '--layouts-dir', path.join(dir, 'layouts'),
    '--renders-dir', path.join(dir, 'renders'), '--library-dir', library, '--costs-file', path.join(library, 'costs.csv'),
    '--calib', 'python3 fixtures/stub_calib.py', '--midstudy-add', FAKE_ADD, ...args]
  const child: ChildProcess = which === 'v1'
    ? spawn('python3', ['-I', 'planner/serve.py', ...common], { cwd: REPO, env: mockEnv(env), stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, ['server/src/main.ts', ...common], { cwd: REPO, env: mockEnv({ ...env, MIDSTUDY_STRICT: '1' }), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  child.stderr?.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(which + ' did not start: ' + out))
    }, 20000)
    child.stdout?.on('data', () => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/planner\//.exec(out)
      if (m?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(which + ' exited (' + String(code) + '): ' + out))
    })
  })
  return {
    base: 'http://127.0.0.1:' + String(port),
    port,
    library,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve()
        })
      })
      child.kill('SIGTERM')
      await exited
    },
  }
}

// --- the stand-in web (from-URL adds) -------------------------------------------------------------------------------
let web: http.Server | null = null
let webPort = 0
const webHits: string[] = []

function startWeb(): Promise<void> {
  web = http.createServer((req, res) => {
    const url = req.url ?? '/'
    webHits.push(url)
    if (url === '/chair.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      res.end(JPEG)
    } else if (url === '/redir') {
      res.writeHead(302, { Location: '/chair.jpg' })
      res.end()
    } else if (url === '/loop') {
      res.writeHead(302, { Location: '/loop' })
      res.end()
    } else if (url === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<html><img src="chair.jpg"></html>')
    } else if (url === '/notes.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('hello')
    } else if (url === '/fake.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      res.end('this is not a jpeg at all')
    } else if (url === '/empty.jpg') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' })
      res.end()
    } else {
      res.writeHead(404, { 'Content-Type': 'text/plain' })
      res.end('nope')
    }
  })
  return new Promise((resolve) => {
    web?.listen(0, '127.0.0.1', () => {
      const a = web?.address()
      webPort = typeof a === 'object' && a !== null ? a.port : 0
      resolve()
    })
  })
}

// --- requests -------------------------------------------------------------------------------------------------------
const b64 = (s: string | Buffer): string => (typeof s === 'string' ? Buffer.from(s, 'utf8') : s).toString('base64')

function upload(s: Server, kind: string | null, filename: string | null, meta: string | null, body: Buffer, extra: Readonly<Record<string, string>> = {}): Promise<Answer> {
  const headers: Record<string, string> = { 'X-Midstudy': '1', 'Content-Type': 'application/octet-stream', ...extra }
  if (kind !== null) headers['X-Midstudy-Kind'] = kind
  if (filename !== null) headers['X-Midstudy-Filename'] = filename
  if (meta !== null) headers['X-Midstudy-Meta'] = meta
  return request(s.base, 'POST', '/api/library/items', { headers, body })
}

function call(s: Server, method: string, target: string, body?: string): Promise<Answer> {
  return request(s.base, method, target, { headers: { 'X-Midstudy': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, ...(body === undefined ? {} : { body }) })
}

/** A raw exchange's status and JSON body (an early 411 or 413). */
async function raw(s: Server, head: string): Promise<{ readonly status: number; readonly body: unknown }> {
  const r = await tcp(s.port, head, { waitMs: 8000, untilClose: false })
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(r.text)
  const at = r.text.indexOf('\r\n\r\n')
  let body: unknown = null
  try {
    body = JSON.parse(r.text.slice(at + 4))
  } catch {
    body = r.text.slice(at + 4)
  }
  return { status: m?.[1] === undefined ? 0 : Number(m[1]), body }
}

function jobIdOf(a: Answer): string {
  const j = a.json
  if (typeof j === 'object' && j !== null && 'job' in j && typeof j.job === 'object' && j.job !== null && 'id' in j.job && typeof j.job.id === 'string') return j.job.id
  return ''
}

async function waitJob(s: Server, id: string): Promise<Answer> {
  for (let i = 0; i < 200; i++) {
    const a = await call(s, 'GET', '/api/library/jobs/' + id)
    const j = a.json
    if (typeof j === 'object' && j !== null && 'status' in j && (j.status === 'done' || j.status === 'failed')) return a
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error('job ' + id + ' never ended')
}

/** Answers with what differs from run to run (job ids, times, trash stamps, the library's path) normalized. */
function norm(v: unknown, lib: string): unknown {
  if (typeof v === 'string') {
    return v.split(lib).join('LIB')
      .replace(/l-\d{8}-\d{6}-[0-9a-f]{4}/g, 'l-ID')
      .replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ/g, 'TIME')
      .replace(/-\d{8}-\d{6}(-\d+)?/g, '-STAMP')
      // The JSON parser's own words after v1's prefix are JavaScript's (server-core's readJson, a documented deviation).
      .replace(/^body is not valid JSON: (?!it is nested too deeply).*$/s, 'body is not valid JSON: <the parser\'s words>')
  }
  if (Array.isArray(v)) return v.map((x: unknown) => norm(x, lib))
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, norm(x, lib)]))
  return v
}

type Record_ = Map<string, unknown>

/** One server's run of the script: every answer by step name, plus the files it left. */
async function script(s: Server): Promise<Record_> {
  const rec: Record_ = new Map()
  const lib = s.library
  const put = (name: string, a: Answer | { readonly status: number; readonly body: unknown }): void => {
    rec.set(name, norm({ status: a.status, body: 'json' in a ? (a.json ?? a.text) : a.body }, lib))
  }
  const good = (name: string, extra = ''): string => b64('{"name": "' + name + '", "dims_cm": {"w": 60, "d": 65, "h": 85}' + extra + '}')
  const job = async (name: string, a: Answer): Promise<void> => {
    put(name, a)
    const id = jobIdOf(a)
    if (id !== '') put(name + ':job', await waitJob(s, id))
  }

  put('lib0', await call(s, 'GET', '/api/library'))
  // --- refusals of a raw-body add, in v1's order ---
  put('kind-missing', await upload(s, null, 'a.glb', good('X'), GLB))
  put('kind-bad', await upload(s, 'photo', 'a.glb', good('X'), GLB))
  put('filename-missing', await upload(s, 'model', null, good('X'), GLB))
  put('filename-root', await upload(s, 'model', '/', good('X'), GLB))
  put('filename-windows-usdz', await upload(s, 'model', 'C:\\Users\\me\\Thing.USDZ', good('X'), GLB))
  put('meta-missing', await upload(s, 'model', 'a.glb', null, GLB))
  put('meta-not-base64', await upload(s, 'model', 'a.glb', '%%%', GLB))
  put('meta-not-json', await upload(s, 'model', 'a.glb', b64('{"name"'), GLB))
  put('meta-array', await upload(s, 'model', 'a.glb', b64('[1]'), GLB))
  put('meta-bad-utf8', await upload(s, 'model', 'a.glb', b64(Buffer.from([0x7b, 0xff, 0x7d])), GLB))
  put('ext-gltf', await upload(s, 'model', 'a.gltf', good('X'), GLB))
  put('ext-obj', await upload(s, 'model', 'a.obj', good('X'), GLB))
  put('ext-none', await upload(s, 'model', 'glb', good('X'), GLB))
  put('ext-image-gif', await upload(s, 'image', 'a.gif', good('X'), JPEG))
  put('meta-before-ext', await upload(s, 'model', 'a.usd', b64('{"name": "X"}'), GLB))
  put('meta-no-dims', await upload(s, 'model', 'a.glb', b64('{"name": "X"}'), GLB))
  put('meta-model-idol', await upload(s, 'model', 'a.glb', good('X', ', "engine": "idol"'), GLB))
  put('meta-image-foo', await upload(s, 'image', 'a.jpg', good('X', ', "engine": "foo"'), JPEG))
  put('meta-yaw-float', await upload(s, 'image', 'a.jpg', good('X', ', "yaw": 45.0'), JPEG))
  const head = (h: string): string => 'POST /api/library/items HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Midstudy: 1\r\n' + h + '\r\n'
  put('411-chunked', await raw(s, head('X-Midstudy-Kind: model\r\nX-Midstudy-Filename: a.glb\r\nX-Midstudy-Meta: ' + good('X') + '\r\nTransfer-Encoding: chunked\r\n') + '5\r\nhello\r\n0\r\n\r\n'))
  put('413-model', await raw(s, head('X-Midstudy-Kind: model\r\nX-Midstudy-Filename: a.glb\r\nX-Midstudy-Meta: ' + good('X') + '\r\nContent-Length: 209715201\r\n')))
  put('413-image', await raw(s, head('X-Midstudy-Kind: image\r\nX-Midstudy-Filename: a.jpg\r\nX-Midstudy-Meta: ' + good('X') + '\r\nContent-Length: 22020096\r\n')))
  put('empty', await upload(s, 'model', 'a.glb', good('X'), Buffer.alloc(0)))
  put('not-image', await upload(s, 'image', 'a.png', good('X'), Buffer.from('not an image at all')))
  put('not-glb', await upload(s, 'model', 'a.glb', good('X'), Buffer.from('not a glb')))
  put('zip-unreadable', await upload(s, 'model', 'a.zip', good('X'), Buffer.from('not a zip at all, but long enough to look')))
  // --- adds and their jobs ---
  await job('add-glb', await upload(s, 'model', 'SheenChair.glb', good('Sheen Chair', ', "category": " chair "'), GLB))
  await job('add-zip', await upload(s, 'model', 'cube-obj.zip', b64('{"name": "Cube", "dims_cm": {"w": 40, "d": 40, "h": 40}, "mount": "wall", "yaw": 90}'), CUBE_ZIP))
  await job('add-sam', await upload(s, ' IMAGE ', 'IMG_1.HEIC', good('SAM Chair', ', "engine": "sam3d", "prompt": " the chair "'), JPEG))
  await job('add-idol', await upload(s, 'image', 'idol.jpg', good('Idol Chair', ', "prompt": "ignored"'), JPEG))
  await job('add-trellis', await upload(s, 'image', 't.png', good('Trellis', ', "engine": "trellis2", "resolution": 1536.0'), JPEG))
  await job('add-rug', await upload(s, 'image', 'r.webp', b64('{"name": "Flat Rug", "dims_cm": {"w": 100.5, "d": 70, "h": 1}, "engine": "rug", "category": "rug"}'), JPEG))
  await job('add-upsert', await upload(s, 'model', 'SheenChair.glb', b64('{"name": "Sheen Chair", "dims_cm": {"w": 62, "d": 65, "h": 85}}'), GLB))
  await job('add-dash', await upload(s, 'model', 'arrow.glb', b64('{"name": "-Shelf", "id": "dash-shelf", "dims_cm": {"w": 40, "d": 20, "h": 10}}'), GLB))
  for (const id of ['fail-a', 'noise-a', 'quiet-a', 'nosummary-a', 'listsummary-a', 'nullsummary-a']) {
    await job('add-' + id, await upload(s, 'model', 'x.glb', b64('{"name": "X", "id": "' + id + '", "dims_cm": {"w": 1, "d": 1, "h": 1}}'), GLB))
  }
  put('jobs', await call(s, 'GET', '/api/library/jobs'))
  put('job-404', await call(s, 'GET', '/api/library/jobs/nope'))
  put('job-404-empty', await call(s, 'GET', '/api/library/jobs/'))
  // --- from-URL adds ---
  const web = 'http://127.0.0.1:' + String(webPort)
  const url = (u: string, extra = ''): string => '{"image_url": "' + u + '", "name": "Web Chair", "dims_cm": {"w": 75, "d": 80, "h": 95}' + extra + '}'
  put('url-empty-body', await call(s, 'POST', '/api/library/items/from-url'))
  put('url-bad-json', await call(s, 'POST', '/api/library/items/from-url', '{"image_url": '))
  put('url-array', await call(s, 'POST', '/api/library/items/from-url', '[]'))
  put('url-missing', await call(s, 'POST', '/api/library/items/from-url', '{"name": "X"}'))
  put('url-blank', await call(s, 'POST', '/api/library/items/from-url', '{"image_url": " \\u3000 "}'))
  put('url-meta', await call(s, 'POST', '/api/library/items/from-url', '{"image_url": "http://example.com/a.jpg", "name": "X"}'))
  put('url-model-engine', await call(s, 'POST', '/api/library/items/from-url', url('http://example.com/a.jpg', ', "engine": "glb"')))
  put('url-private', await call(s, 'POST', '/api/library/items/from-url', url('http://127.0.0.1:1/a.jpg')))
  put('url-file', await call(s, 'POST', '/api/library/items/from-url', url('file:///etc/passwd')))
  put('url-no-host', await call(s, 'POST', '/api/library/items/from-url', url('http:///a.jpg')))
  put('url-page', await call(s, 'POST', '/api/library/items/from-url', url(web + '/page.html')))
  put('url-text', await call(s, 'POST', '/api/library/items/from-url', url(web + '/notes.txt')))
  put('url-fake', await call(s, 'POST', '/api/library/items/from-url', url(web + '/fake.jpg')))
  put('url-empty', await call(s, 'POST', '/api/library/items/from-url', url(web + '/empty.jpg')))
  put('url-404', await call(s, 'POST', '/api/library/items/from-url', url(web + '/missing.jpg')))
  put('url-loop', await call(s, 'POST', '/api/library/items/from-url', url(web + '/loop')))
  await job('url-ok', await call(s, 'POST', '/api/library/items/from-url', url(' ' + web + '/redir ', ', "engine": "trellis2", "id": "web-chair"')))
  // --- PATCH ---
  const patch = (id: string, body?: string): Promise<Answer> => call(s, 'PATCH', '/api/library/items/' + id, body)
  put('patch-no-body', await patch('cube'))
  put('patch-bad-json', await patch('cube', '{'))
  put('patch-array', await patch('cube', '[]'))
  put('patch-empty', await patch('cube', '{}'))
  put('patch-unknown', await patch('cube', '{"zeta": 1, "Alpha": 2, "name": "x"}'))
  put('patch-404', await patch('nope', '{"name": "x"}'))
  put('patch-404-not-slug', await patch('Bad%20Id', '{"name": "x"}'))
  put('patch-name-blank', await patch('cube', '{"name": "  "}'))
  put('patch-category', await patch('cube', '{"category": 5}'))
  put('patch-mount', await patch('cube', '{"mount": "ceiling"}'))
  put('patch-render-bad', await patch('cube', '{"default_render": "mesh"}'))
  put('patch-render-splat-glb-only', await patch('cube', '{"default_render": "splat"}'))
  put('patch-render-glb-idol', await patch('idol-chair', '{"default_render": "glb"}'))
  put('patch-render-glb-sam', await patch('sam-chair', '{"default_render": "glb"}'))
  put('patch-render-splat-sam', await patch('sam-chair', '{"default_render": "splat"}'))
  put('patch-yaw-bad', await patch('cube', '{"yaw": 45}'))
  put('patch-dims-bad', await patch('cube', '{"dims_cm": {"w": 0, "d": 1, "h": 1}}'))
  put('patch-order', await patch('cube', '{"dims_cm": {}, "yaw": 1, "mount": "x", "name": ""}'))
  put('patch-in-place', await patch('cube', '{"name": " Wall cube ", "category": "  ", "mount": "floor"}'))
  put('patch-same', await patch('cube', '{"name": "Wall cube", "yaw": 0, "dims_cm": {"w": 40, "d": 40, "h": 40}}'))
  put('patch-null-category', await patch('dash-shelf', '{"category": null}'))
  await job('patch-yaw', await patch('cube', '{"yaw": 90.0, "name": "Turned"}'))
  await job('patch-dims', await patch('sheen-chair', '{"dims_cm": {"w": 70, "d": 65.5, "h": 85}}'))
  // --- thumbnails ---
  const exif = Buffer.concat([JPEG.subarray(0, 2), Buffer.from([0xff, 0xe1, 0x00, 0x12]), Buffer.from('Exif\0\0GPS-canary'), JPEG.subarray(2)])
  const thumb = (id: string, body: string): Promise<Answer> => call(s, 'PUT', '/api/library/items/' + id + '/thumb', body)
  put('thumb-bad-json', await thumb('cube', '{'))
  put('thumb-no-image', await thumb('cube', '{"img": 1}'))
  put('thumb-png', await thumb('cube', '{"image": "data:image/png;base64,' + b64(JPEG) + '"}'))
  put('thumb-garbage', await thumb('cube', '{"image": "data:image/jpeg;base64,AAAA"}'))
  put('thumb-truncated', await thumb('cube', '{"image": "data:image/jpeg;base64,' + b64(JPEG.subarray(0, 600)) + '"}'))
  put('thumb-big', await thumb('cube', '{"image": "data:image/jpeg;base64,' + b64(Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)])) + '"}'))
  put('thumb-404', await thumb('nope', '{"image": "data:image/jpeg;base64,' + b64(exif) + '"}'))
  put('thumb-ok', await thumb('cube', '{"image": "data:image/jpg;base64,' + b64(exif).replace(/(.{76})/g, '$1\\n') + '"}'))
  fs.rmSync(path.join(lib, 'trellis'), { recursive: true, force: true })
  put('thumb-no-folder', await thumb('trellis', '{"image": "data:image/jpeg;base64,' + b64(exif) + '"}'))
  // --- DELETE, restore, the trash ---
  put('del-404', await call(s, 'DELETE', '/api/library/items/nope'))
  put('del-not-slug', await call(s, 'DELETE', '/api/library/items/..%2Fx'))
  put('del-sheen', await call(s, 'DELETE', '/api/library/items/sheen-chair'))
  put('del-trellis', await call(s, 'DELETE', '/api/library/items/trellis'))
  put('lib-trash', await call(s, 'GET', '/api/library'))
  put('restore-not-slug', await call(s, 'POST', '/api/library/items/Bad/restore'))
  put('restore-409', await call(s, 'POST', '/api/library/items/cube/restore'))
  put('restore-404', await call(s, 'POST', '/api/library/items/never/restore'))
  put('restore-sheen', await call(s, 'POST', '/api/library/items/sheen-chair/restore'))
  put('restore-trellis', await call(s, 'POST', '/api/library/items/trellis/restore'))
  put('restore-again', await call(s, 'POST', '/api/library/items/sheen-chair/restore'))
  // crafted trash folders: v1 orders them by (str(deleted), folder name), newest first, and skips what it can't read
  const tr = path.join(lib, '.trash')
  const crafted: readonly (readonly [string, string])[] = [
    ['a-20260101-000000', '{"deleted": "2026-01-01T00:00:00Z", "entry": {"id": "a", "name": "A"}}'],
    ['b-20260101-000000', '{"deleted": "2026-01-01T00:00:00Z", "entry": {"id": "b", "name": "B"}}'],
    ['c-20250101-000000', '{"deleted": "2025-01-01T00:00:00Z", "entry": {"id": "c", "name": "C"}}'],
    ['d-20270101-000000', '{"deleted": "2027-01-01T00:00:00.5Z", "entry": {"id": "d", "name": "D"}}'],
    ['e-20260101-000000', '{"deleted": "2026-06-01T00:00:00Z", "entry": "not an object"}'],
    ['f-20260101-000000', 'not json'],
  ]
  for (const [dir, text] of crafted) {
    fs.mkdirSync(path.join(tr, dir), { recursive: true })
    fs.writeFileSync(path.join(tr, dir, 'entry.json'), text)
  }
  fs.writeFileSync(path.join(tr, 'stray-file'), 'x')
  put('lib-crafted-trash', await call(s, 'GET', '/api/library'))
  put('lib-final', await call(s, 'GET', '/api/library'))
  // --- the files left behind ---
  const file = (p: string, encoding: 'utf8' | 'base64'): string | null => (fs.existsSync(path.join(lib, p)) ? fs.readFileSync(path.join(lib, p)).toString(encoding) : null)
  rec.set('file:library.json', file('library.json', 'utf8'))
  for (const id of ['sheen-chair', 'cube', 'sam-chair', 'idol-chair', 'flat-rug', 'dash-shelf', 'web-chair']) rec.set('argv:' + id, file(id + '/raw/argv.json', 'utf8'))
  rec.set('file:cube/thumb.jpg', file('cube/thumb.jpg', 'base64'))
  rec.set('trash-left', norm(fs.readdirSync(tr).sort(), lib))
  const thumbBytes = file('cube/thumb.jpg', 'base64')
  rec.set('thumb stored without its EXIF', thumbBytes !== null && !Buffer.from(thumbBytes, 'base64').includes('GPS-canary'))
  return rec
}

/** The spend cap's script ($0.05 cap, mock calls priced: MIDSTUDY_FAL_MOCK_COST=1). */
async function spendScript(s: Server): Promise<Record_> {
  const rec: Record_ = new Map()
  const put = (name: string, a: Answer): void => {
    rec.set(name, norm({ status: a.status, body: a.json ?? a.text }, s.library))
  }
  const add = (id: string, engine: string, extra = ''): Promise<Answer> => upload(s, 'image', 'a.jpg', b64('{"name": "Paid", "id": "' + id + '", "engine": "' + engine + '", "dims_cm": {"w": 1, "d": 1, "h": 1}' + extra + '}'), JPEG)
  put('spend0', await call(s, 'GET', '/api/spend'))
  const first = await add('paid-one', 'sam3d')
  put('paid-one', first)
  put('paid-one:job', await waitJob(s, jobIdOf(first)))
  const slow = await add('slow-paid', 'sam3d')
  put('slow-paid', slow)
  put('while-reserved', await add('paid-two', 'sam3d'))
  put('spend-reserved', await call(s, 'GET', '/api/spend'))
  put('slow-paid:job', await waitJob(s, jobIdOf(slow)))
  put('used-up', await add('paid-three', 'sam3d'))
  put('over-cap', await add('paid-big', 'trellis2', ', "resolution": 1536'))
  const hits = webHits.length
  put('url-over-cap', await call(s, 'POST', '/api/library/items/from-url', '{"image_url": "http://127.0.0.1:' + String(webPort) + '/chair.jpg", "name": "X", "engine": "idol", "dims_cm": {"w": 1, "d": 1, "h": 1}}'))
  rec.set('url-over-cap fetched nothing', webHits.length === hits)
  put('free', await add('free-rug', 'rug'))
  put('spend1', await call(s, 'GET', '/api/spend'))
  return rec
}

let v1: Server | null = null
let v2: Server | null = null

before(async () => {
  if (skipV1 !== false) return
  await startWeb()
  const env = { MIDSTUDY_FETCH_ALLOW: '127.0.0.1:' + String(webPort) }
  v1 = await launch('v1', 'main', ['--daily-spend-usd', '0'], env)
  v2 = await launch('v2', 'main', ['--daily-spend-usd', '0'], env)
})

after(async () => {
  await v1?.stop()
  await v2?.stop()
  for (const d of fs.readdirSync(SCRATCH)) if (d.startsWith('library-routes-' + String(process.pid) + '-')) fs.rmSync(path.join(SCRATCH, d), { recursive: true, force: true })
  await new Promise<void>((resolve) => {
    if (web === null) resolve()
    else web.close(() => {
      resolve()
    })
  })
})

function compare(a: Record_, b: Record_): void {
  const diffs: string[] = []
  for (const [k, x] of a) {
    try {
      assert.deepStrictEqual(b.get(k), x)
    } catch {
      diffs.push(k + '\n  v1: ' + JSON.stringify(x).slice(0, 1500) + '\n  v2: ' + JSON.stringify(b.get(k)).slice(0, 1500))
    }
  }
  assert.deepEqual([...b.keys()], [...a.keys()])
  assert.equal(diffs.length, 0, String(diffs.length) + ' of ' + String(a.size) + ' differ:\n' + diffs.join('\n'))
}

/** The status (and a job's end) of the steps that must succeed or fail in a given way, so that two servers failing
 *  alike can't pass for agreeing. */
const EXPECTED: Readonly<Record<string, number | string>> = {
  'lib0': 200, 'kind-missing': 400, 'meta-not-base64': 400, 'ext-gltf': 400, '411-chunked': 411, '413-model': 413, '413-image': 413, 'empty': 400,
  'not-image': 400, 'not-glb': 400, 'zip-unreadable': 400, 'add-glb': 202, 'add-glb:job': 'done', 'add-zip:job': 'done', 'add-sam:job': 'done',
  'add-idol:job': 'done', 'add-trellis:job': 'done', 'add-rug:job': 'done', 'add-upsert:job': 'done', 'add-dash:job': 'done', 'add-fail-a:job': 'failed',
  'add-noise-a:job': 'failed', 'add-quiet-a:job': 'failed', 'add-nosummary-a:job': 'failed', 'add-listsummary-a:job': 'failed',
  'add-nullsummary-a:job': 'failed', 'jobs': 200, 'job-404': 404, 'url-empty-body': 400, 'url-private': 400, 'url-page': 400, 'url-ok': 202,
  'url-ok:job': 'done', 'patch-404': 404, 'patch-render-glb-idol': 400, 'patch-render-glb-sam': 200, 'patch-in-place': 200, 'patch-same': 200,
  'patch-yaw': 202, 'patch-yaw:job': 'done', 'patch-dims': 202, 'patch-dims:job': 'done', 'thumb-big': 413, 'thumb-404': 404, 'thumb-ok': 200,
  'thumb-no-folder': 409, 'del-404': 404, 'del-sheen': 200, 'restore-not-slug': 404, 'restore-409': 409, 'restore-404': 404, 'restore-sheen': 200,
  'restore-trellis': 200, 'lib-crafted-trash': 200,
}

function outcome(v: unknown): number | string | null {
  if (typeof v !== 'object' || v === null || !('status' in v) || !('body' in v)) return null
  const body = v.body
  if (typeof body === 'object' && body !== null && 'status' in body && typeof body.status === 'string') return body.status
  return typeof v.status === 'number' ? v.status : null
}

void test('the library API answers as v1 and leaves the same files (uploads, jobs, from-URL, PATCH, thumbnails, trash)', { skip: skipV1, timeout: 240000 }, async () => {
  assert.ok(v1 !== null && v2 !== null)
  const a = await script(v1)
  const b = await script(v2)
  assert.ok(a.size > 120, String(a.size))
  compare(a, b)
  for (const [step, want] of Object.entries(EXPECTED)) assert.equal(outcome(b.get(step)), want, step + ': ' + JSON.stringify(b.get(step)).slice(0, 300))
  assert.equal(b.get('thumb stored without its EXIF'), true)
})

void test('the spend cap: 402s with v1 sentences, reservations held by running jobs, no download over the cap', { skip: skipV1, timeout: 120000 }, async () => {
  const env = { MIDSTUDY_FETCH_ALLOW: '127.0.0.1:' + String(webPort), MIDSTUDY_FAL_MOCK_COST: '1' }
  const s1 = await launch('v1', 'spend', ['--daily-spend-usd', '0.05'], env)
  const s2 = await launch('v2', 'spend', ['--daily-spend-usd', '0.05'], env)
  try {
    const a = await spendScript(s1)
    const b = await spendScript(s2)
    compare(a, b)
    assert.equal(a.get('url-over-cap fetched nothing'), true)
  } finally {
    await s1.stop()
    await s2.stop()
  }
})
