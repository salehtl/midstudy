// v1 and v2 side by side on the scenes, layouts and render routes: planner/serve.py and node server/src/main.ts (strict
// mode on) each get their own scratch folders and the same sequence of requests (uploads good and bad, every PUT
// refusal, looks, thumbnails, calibrate, light, layouts, renders, delete and restore), and must answer each with the
// same status and the same JSON once names, ids and times are replaced by placeholders. The files they write
// (scene.json, layouts, render metadata, trash.json) are compared the same way. Skipped when planner/serve.py is gone.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request, tcp, statusOf, bodyOf, type Answer } from '../helpers.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')
const SCRATCH = path.join(REPO, 'evals/out/server-scenes-tests/http-diff')
const V1 = path.join(REPO, 'planner/serve.py')
const skip = !fs.existsSync(V1) && 'planner/serve.py is gone'
const golden = (id: string, f: string): Buffer => fs.readFileSync(path.join(REPO, 'fixtures/scenes', id, f))
const LIVING = golden('living-wide', 'photo.jpg')
const PORTRAIT = golden('portrait', 'photo.jpg')
const IDS = golden('living-wide', 'ids.png') // 1600 × 1200, the photo's size: a keep-room mask
const DEPTH = golden('living-wide', 'depth.png') // 1024 × 768: a mask of the wrong size, and a PNG upload

interface Server {
  readonly which: 'v1' | 'v2'
  readonly base: string
  readonly port: number
  readonly dir: string
  log(): string
  stop(): Promise<void>
}

async function start(which: 'v1' | 'v2'): Promise<Server> {
  const dir = path.join(SCRATCH, which + '-' + String(process.pid))
  fs.rmSync(dir, { recursive: true, force: true })
  const lib = path.join(dir, 'library')
  for (const d of ['scenes', 'layouts', 'renders', 'library']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  fs.writeFileSync(path.join(lib, 'costs.csv'), 'date,id,engine,cost_usd,mock,input\n')
  const flags = ['--port', '0', '--host', '127.0.0.1', '--scenes-dir', path.join(dir, 'scenes'), '--layouts-dir', path.join(dir, 'layouts'),
    '--renders-dir', path.join(dir, 'renders'), '--library-dir', lib, '--costs-file', path.join(lib, 'costs.csv'),
    '--calib', 'python3 fixtures/stub_calib.py', '--daily-spend-usd', '0']
  const env: NodeJS.ProcessEnv = {
    ...process.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'),
    MIDSTUDY_CALIB_MOCK: path.join(REPO, 'fixtures/calib'), ...(which === 'v2' ? { MIDSTUDY_STRICT: '1' } : {}),
  }
  delete env['FAL_KEY']
  delete env['MIDSTUDY_FAL_MOCK_COST']
  const child: ChildProcess = which === 'v1'
    ? spawn('python3', ['-I', V1, ...flags], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
    : spawn(process.execPath, ['server/src/main.ts', ...flags], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
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
  })
  return {
    which, base: 'http://127.0.0.1:' + String(port), port, dir, log: () => out,
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

/** One recorded exchange. */
interface Step {
  readonly label: string
  readonly status: number
  readonly body: unknown
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64')
const jpegUri = (b: Buffer): string => 'data:image/jpeg;base64,' + b.toString('base64')
const pngUri = (b: Buffer): string => 'data:image/png;base64,' + b.toString('base64')
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function parseJson(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text)
    return v
  } catch {
    return text
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Runs the scenario against one server and records every answer. `names` collects the scene names in the order the
 *  server made them (for the placeholders). */
async function scenario(s: Server): Promise<{ readonly steps: Step[]; readonly names: string[] }> {
  const steps: Step[] = []
  const names: string[] = []
  const rec = async (label: string, a: Promise<Answer>): Promise<Answer> => {
    const r = await a
    steps.push({ label, status: r.status, body: r.json ?? r.text })
    return r
  }
  const get = (label: string, target: string): Promise<Answer> => rec(label, request(s.base, 'GET', target))
  const send = (label: string, method: string, target: string, body?: unknown, raw?: string): Promise<Answer> => rec(label, request(s.base, method, target, {
    headers: { 'X-Midstudy': '1', 'Content-Type': 'application/json' },
    ...(raw !== undefined ? { body: raw } : body === undefined ? {} : { body: JSON.stringify(body) }),
  }))
  const upload = async (label: string, bytes: Buffer, headers: Readonly<Record<string, string>>): Promise<string | null> => {
    const r = await rec(label, request(s.base, 'POST', '/api/scenes', { headers: { 'X-Midstudy': '1', 'Content-Type': 'application/octet-stream', ...headers }, body: bytes }))
    const name = isObj(r.json) && typeof r.json['scene'] === 'string' ? r.json['scene'] : null
    if (name !== null) names.push(name)
    return name
  }
  const settle = async (name: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const r = await request(s.base, 'GET', '/api/scenes/' + name)
      const st = isObj(r.json) ? r.json['calib_status'] : null
      if (r.status === 200 && (st === 'done' || st === 'failed')) return
      await sleep(100)
    }
    throw new Error(name + ' did not settle on ' + s.which)
  }
  const settleJob = async (id: string): Promise<void> => {
    for (let i = 0; i < 200; i++) {
      const r = await request(s.base, 'GET', '/api/scenes/jobs/' + id)
      const st = isObj(r.json) ? r.json['status'] : null
      if (st === 'done' || st === 'failed') return
      await sleep(100)
    }
    throw new Error(id + ' did not end on ' + s.which)
  }
  const jobId = (r: Answer): string => {
    const job = isObj(r.json) ? r.json['job'] : null
    return isObj(job) && typeof job['id'] === 'string' ? job['id'] : ''
  }
  const sceneDir = (name: string): string => path.join(s.dir, 'scenes', name)

  // --- uploads ------------------------------------------------------------------------------------------------------
  await get('list, empty', '/api/scenes')
  const A = await upload('upload living, a title with spaces', LIVING, { 'X-Midstudy-Filename': 'C:\\photos\\IMG_0042.JPG', 'X-Midstudy-Meta': b64('{"title": "  Lounge A  "}') })
  if (A === null) throw new Error('no scene A on ' + s.which)
  await settle(A)
  const Bn = await upload('upload portrait, no meta', PORTRAIT, { 'X-Midstudy-Filename': 'portrait.jpg' })
  if (Bn === null) throw new Error('no scene B on ' + s.which)
  await settle(Bn)
  const F = await upload('upload a truncated JPEG', LIVING.subarray(0, 100), { 'X-Midstudy-Filename': 'broken.jpg' })
  if (F !== null) await settle(F)
  const P = await upload('upload a PNG (the stub refuses it)', DEPTH, { 'X-Midstudy-Filename': 'depth.png', 'X-Midstudy-Meta': b64('{"title": null}') })
  if (P !== null) await settle(P)
  const T = await upload('upload, a blank title', PORTRAIT, { 'X-Midstudy-Filename': 'a/b/' + 'x'.repeat(250) + '.jpg', 'X-Midstudy-Meta': b64('{"title": " \\t "}') })
  if (T !== null) await settle(T)
  await upload('no filename', LIVING, {})
  await upload('a blank filename', LIVING, { 'X-Midstudy-Filename': '  /  ' })
  await upload('meta not base64', LIVING, { 'X-Midstudy-Filename': 'a.jpg', 'X-Midstudy-Meta': '!!not base64!!' })
  await upload('meta a list', LIVING, { 'X-Midstudy-Filename': 'a.jpg', 'X-Midstudy-Meta': b64('[1]') })
  await upload('meta title a number', LIVING, { 'X-Midstudy-Filename': 'a.jpg', 'X-Midstudy-Meta': b64('{"title": 5}') })
  await upload('meta title 201 characters', LIVING, { 'X-Midstudy-Filename': 'a.jpg', 'X-Midstudy-Meta': b64('{"title": "' + 'é'.repeat(201) + '"}') })
  await upload('meta with a byte order mark', LIVING, { 'X-Midstudy-Filename': 'a.jpg', 'X-Midstudy-Meta': Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"title": "x"}')]).toString('base64') })
  await upload('an empty body', Buffer.alloc(0), { 'X-Midstudy-Filename': 'a.jpg' })
  await upload('a GIF', Buffer.from('GIF89a\x01\x00\x01\x00\x00\x00\x00;'), { 'X-Midstudy-Filename': 'a.gif' })
  await upload('text', Buffer.from('just text\n'.repeat(20)), { 'X-Midstudy-Filename': 'a.jpg' })
  const big = await tcp(s.port, 'POST /api/scenes HTTP/1.1\r\nHost: 127.0.0.1:' + String(s.port) + '\r\nX-Midstudy: 1\r\nX-Midstudy-Filename: big.jpg\r\nContent-Length: ' + String(25 * 1024 * 1024 + 1) + '\r\n\r\n', { waitMs: 3000, untilClose: false })
  steps.push({ label: 'an upload over 25 MB', status: statusOf(big.text), body: parseJson(bodyOf(big.text)) })
  const chunked = await tcp(s.port, 'POST /api/scenes HTTP/1.1\r\nHost: 127.0.0.1:' + String(s.port) + '\r\nX-Midstudy: 1\r\nX-Midstudy-Filename: a.jpg\r\nTransfer-Encoding: chunked\r\n\r\n', { waitMs: 3000, untilClose: false })
  steps.push({ label: 'a chunked upload', status: statusOf(chunked.text), body: parseJson(bodyOf(chunked.text)) })

  await get('list', '/api/scenes')
  for (const n of [A, Bn, F, P, T]) if (n !== null) await get('GET scene', '/api/scenes/' + n)
  await get('GET an unknown scene', '/api/scenes/scene-19990101-000000')
  await get('GET a non-slug scene', '/api/scenes/Lounge%20A')
  await get('GET jobs', '/api/scenes/jobs')
  await get('GET an unknown job', '/api/scenes/jobs/c-19990101-000000-zzzz')
  await get('GET jobs/ (empty id)', '/api/scenes/jobs/')

  // --- PUT /api/scenes/<name> ------------------------------------------------------------------------------------------
  const put = (label: string, body: unknown, raw?: string): Promise<Answer> => send('PUT ' + label, 'PUT', '/api/scenes/' + A, body, raw)
  await put('{}', {})
  await put('[]', [])
  await put('5', 5)
  await put('unknown keys', { zzz: 1, bogus: 2, title: 'x', aaa: 3 })
  await put('title a number', { title: 5 })
  await put('title 201 characters', { title: '\u{1F600}'.repeat(201) })
  await put('title with spaces', { title: '  Upper lounge  ' })
  await put('title null', { title: null })
  await put('title blank', { title: '   ' })
  await put('camera a list', { camera: [] })
  await put('camera empty', { camera: {} })
  await put('camera unknown fields', { camera: { zoom: 1, fov: 2, height_m: 1 } })
  await put('camera not numbers', { camera: { fov_y_deg: 'wide', height_m: true, roll_deg: null } })
  await put('camera clamped', { camera: { fov_y_deg: 200, pitch_deg: -100.123456789 } })
  await put('camera rounded', { camera: { height_m: 1.23456789, roll_deg: 1e-7 } })
  await put('camera_source magic', { camera_source: 'magic' })
  await put('camera_source null', { camera_source: null })
  await put('camera_source manual', { camera_source: 'manual' })
  await put('look a number', { look: 5 })
  await put('look null', { look: null })
  await put('look unknown keys', { look: { x: 1, a: 2, exposure: 1 } })
  await put('look wrong types', { look: { exposure: true, auto_light: 1, ambient: '1', cast_shadows: null } })
  await put('look clamped', { look: { exposure: 1.23456789, light_azimuth_deg: 270, warmth: -5, contact_shadows: false, light_softness: 0.5 } })
  await put('look null removes', { look: { light_softness: null, exposure: null } })
  await put('look merges', { look: { ambient: 2, auto_light: false } })
  await put('title then camera errors', { title: 5, camera: [] })
  await put('camera then look errors', { look: 5, camera: [] })
  await put('camera_source then look errors', { look: 5, camera_source: 'x' })
  await put('everything', { title: 'All', camera: { fov_y_deg: 61.5 }, camera_source: 'auto', look: { warmth: 0.25 } })
  await send('PUT an unknown scene', 'PUT', '/api/scenes/scene-19990101-000000', { title: 'x' })
  await send('PUT a non-slug scene', 'PUT', '/api/scenes/Bad%20Name', { title: 'x' })
  await send('PUT /api/scenes/jobs', 'PUT', '/api/scenes/jobs', { title: 'x' })

  // --- thumbnails -------------------------------------------------------------------------------------------------------
  const thumb = (label: string, body: unknown, name: string = A): Promise<Answer> => send('thumb ' + label, 'PUT', '/api/scenes/' + name + '/thumb', body)
  await thumb('a JPEG', { image: jpegUri(PORTRAIT) })
  await thumb('data:image/jpg', { image: 'data:image/jpg;base64,' + PORTRAIT.toString('base64') })
  await thumb('over 2 MB', { image: jpegUri(Buffer.concat([LIVING, Buffer.alloc(2_300_000 - LIVING.length)])) })
  await thumb('text data URI', { image: 'data:text/plain;base64,aGVsbG8=' })
  await thumb('a PNG data URI', { image: pngUri(DEPTH) })
  await thumb('not JPEG bytes', { image: jpegUri(Buffer.from('not a jpeg at all')) })
  await thumb('a broken JPEG', { image: jpegUri(LIVING.subarray(0, 1000)) })
  await thumb('a list body', [1])
  await thumb('image a number', { image: 5 })
  await thumb('an unknown scene', { image: jpegUri(PORTRAIT) }, 'scene-19990101-000000')

  // --- calibrate, light ---------------------------------------------------------------------------------------------------
  let r = await send('calibrate A', 'POST', '/api/scenes/' + A + '/calibrate')
  await settleJob(jobId(r))
  await get('the calibrate job', '/api/scenes/jobs/' + jobId(r))
  await send('calibrate an unknown scene', 'POST', '/api/scenes/scene-19990101-000000/calibrate')
  await send('calibrate a non-slug', 'POST', '/api/scenes/Bad/calibrate')
  fs.rmSync(path.join(sceneDir(Bn), 'photo.jpg'))
  r = await send('calibrate B without photo.jpg (run on source.jpg)', 'POST', '/api/scenes/' + Bn + '/calibrate')
  await settleJob(jobId(r))
  await get('that job', '/api/scenes/jobs/' + jobId(r))
  if (F !== null) await send('calibrate a scene with neither photo nor source', 'POST', '/api/scenes/' + F + '/calibrate')
  await send('light A (has lighting.json)', 'POST', '/api/scenes/' + A + '/light')
  fs.rmSync(path.join(sceneDir(A), 'lighting.json'))
  await get('A without lighting.json', '/api/scenes/' + A)
  r = await send('light A (backfill)', 'POST', '/api/scenes/' + A + '/light')
  await settleJob(jobId(r))
  await get('the light job', '/api/scenes/jobs/' + jobId(r))
  await get('A with its light back', '/api/scenes/' + A)
  if (F !== null) await send('light a scene without photo.jpg', 'POST', '/api/scenes/' + F + '/light')
  await send('light an unknown scene', 'POST', '/api/scenes/scene-19990101-000000/light')
  await send('light a non-slug', 'POST', '/api/scenes/..%2Fx/light')
  if (P !== null) {
    // living-wide with another JFIF density: the same pixels, a SHA-256 the calib mock doesn't know
    const miss = Buffer.from(LIVING)
    miss.writeUInt16BE(97, 14)
    miss.writeUInt16BE(97, 16)
    fs.writeFileSync(path.join(sceneDir(P), 'photo.jpg'), miss)
    r = await send('light a photo the mock has no light for', 'POST', '/api/scenes/' + P + '/light')
    await settleJob(jobId(r))
    await get('that light job', '/api/scenes/jobs/' + jobId(r))
  }

  // --- layouts ------------------------------------------------------------------------------------------------------------
  const lay = (label: string, method: string, target: string, body?: unknown): Promise<Answer> => send('layout ' + label, method, target, body)
  await lay('list without ?scene', 'GET', '/api/layouts')
  await lay('list ?scene=', 'GET', '/api/layouts?scene=')
  await lay('list ?scene=Bad', 'GET', '/api/layouts?scene=Bad')
  await lay('list an unknown scene', 'GET', '/api/layouts?scene=scene-19990101-000000')
  await lay('list, none yet', 'GET', '/api/layouts?scene=' + A)
  const q = '?scene=' + A
  const item = { id: 'probe-box', position: [0.5, 0, -2.5] }
  await lay('PUT a list', 'PUT', '/api/layouts/one' + q, [])
  await lay('PUT items not a list', 'PUT', '/api/layouts/one' + q, { items: {} })
  await lay('PUT an item not an object', 'PUT', '/api/layouts/one' + q, { items: [item, 5] })
  await lay('PUT an item without id', 'PUT', '/api/layouts/one' + q, { items: [{ position: [0, 0, 0] }] })
  await lay('PUT an item id not a slug', 'PUT', '/api/layouts/one' + q, { items: [{ id: 'Probe', position: [0, 0, 0] }] })
  await lay('PUT a position of two', 'PUT', '/api/layouts/one' + q, { items: [{ id: 'probe-box', position: [0, 0] }] })
  await lay('PUT a position with text', 'PUT', '/api/layouts/one' + q, { items: [{ id: 'probe-box', position: [0, '0', 0] }] })
  await lay('PUT rotation text', 'PUT', '/api/layouts/one' + q, { items: [{ ...item, rotation_y_deg: '90' }] })
  await lay('PUT rotation null', 'PUT', '/api/layouts/one' + q, { items: [{ ...item, rotation_y_deg: null }] })
  await lay('PUT title a number', 'PUT', '/api/layouts/one' + q, { items: [], title: 5 })
  await lay('PUT title 121 characters', 'PUT', '/api/layouts/one' + q, { items: [], title: ' ' + 'x'.repeat(121) + ' ' })
  await lay('PUT a non-slug name', 'PUT', '/api/layouts/Bad%20Name' + q, { items: [] })
  await lay('PUT a name with a newline', 'PUT', '/api/layouts/evil%0A' + q, { items: [] })
  await lay('PUT in an unknown scene', 'PUT', '/api/layouts/one?scene=scene-19990101-000000', { items: [] })
  await lay('PUT ?scene=../x', 'PUT', '/api/layouts/one?scene=..%2Fx', { items: [] })
  await lay('PUT one', 'PUT', '/api/layouts/one' + q, {
    version: 1, name: 'ignored', scene_name: 'ignored', updated: 'ignored', title: '  Phone \t  A ', library: '/library/library.json', notes: 'n',
    items: [
      item,
      { uid: '', id: 'probe-box', render: 'splat', position: [1, 0.25, -3], rotation_y_deg: 90, mounted: 'wall', dims_cm: { w: 80, d: 50, h: 120, x: 1 } },
      { uid: 'u3', id: 'chair', render: 'mesh', position: [1e-7, 0, 2], mounted: 'ceiling', dims_cm: { w: 1, d: 2 } },
    ],
  })
  await lay('PUT two', 'PUT', '/api/layouts/two' + q, { items: [item], library: 5, notes: 7, title: null })
  await lay('PUT a-b (sorts before a)', 'PUT', '/api/layouts/a-b' + q, { items: [] })
  await lay('PUT a', 'PUT', '/api/layouts/a' + q, { items: [] })
  await lay('list', 'GET', '/api/layouts' + q)
  await lay('GET one', 'GET', '/api/layouts/one' + q)
  await lay('GET an unknown layout', 'GET', '/api/layouts/nope' + q)
  await lay('GET in another scene', 'GET', '/api/layouts/one?scene=' + Bn)
  await lay('GET a non-slug name', 'GET', '/api/layouts/Bad%20Name' + q)
  await lay('DELETE two', 'DELETE', '/api/layouts/two' + q)
  await lay('DELETE two again', 'DELETE', '/api/layouts/two' + q)
  await lay('list after the delete', 'GET', '/api/layouts' + q)
  fs.writeFileSync(path.join(s.dir, 'layouts', A, 'broken.json'), '{not json')
  fs.writeFileSync(path.join(s.dir, 'layouts', A, 'list.json'), '[1, 2]')
  await lay('list with an unreadable file', 'GET', '/api/layouts' + q)
  await lay('GET an unreadable layout', 'GET', '/api/layouts/broken' + q)
  await get('A counts its layouts', '/api/scenes/' + A)

  // --- renders --------------------------------------------------------------------------------------------------------------
  const render = (label: string, body: unknown): Promise<Answer> => send('render ' + label, 'POST', '/api/render', body)
  const image = jpegUri(LIVING)
  await render('a list body', [])
  await render('no image', { scene: A })
  await render('a PNG image', { image: pngUri(IDS) })
  await render('an unknown model', { image, model: 'dalle' })
  await render('a model number', { image, model: 5 })
  await render('a model list', { image, model: [1] })
  await render('a model dict', { image, model: { a: 1 } })
  await render('a prompt number', { image, prompt: 5 })
  await render('an unknown scene', { image, scene: 'scene-19990101-000000' })
  await render('a scene number', { image, scene: 5 })
  await render('an empty scene', { image, scene: '' })
  await render('keep_room without scene', { image, keep_room: true })
  await render('keep_room without mask', { image, scene: A, keep_room: true })
  await render('keep_room with a JPEG mask', { image, scene: A, keep_room: true, mask: jpegUri(LIVING) })
  await render('keep_room with a mask of the wrong size', { image, scene: A, keep_room: true, mask: pngUri(DEPTH) })
  await render('a composite without a frame header', { image: jpegUri(Buffer.from([0xff, 0xd8, 0xff, 0xd9])) })
  await render('nano-banana with a scene', { image, scene: A, layout: 'one' })
  await render('kontext with a scene and a blank prompt', { image, scene: A, model: 'kontext', prompt: '   ' })
  await render('qwen without a scene, layout not a slug', { image, model: 'qwen', layout: 'Not A Slug' })
  await render('a model that is falsy', { image, model: '', prompt: 'Make it real.', scene: Bn })
  await render('keep room', { image, scene: A, keep_room: true, mask: pngUri(IDS) })
  await get('renders', '/api/renders')
  await get('renders of A', '/api/renders?scene=' + A)
  await get('renders of ?scene=', '/api/renders?scene=')
  await get('renders of an unknown scene', '/api/renders?scene=scene-19990101-000000')

  // --- delete and restore ---------------------------------------------------------------------------------------------------
  await send('DELETE B', 'DELETE', '/api/scenes/' + Bn)
  await get('list with B in the trash', '/api/scenes')
  await send('DELETE B again', 'DELETE', '/api/scenes/' + Bn)
  await send('DELETE a non-slug', 'DELETE', '/api/scenes/Bad')
  await send('DELETE /api/scenes/jobs', 'DELETE', '/api/scenes/jobs')
  // a folder trashed before trash.json existed: its name says what it was, its mtime when
  const trashRoot = path.join(s.dir, 'scenes', '.trash')
  for (const d of fs.readdirSync(trashRoot)) fs.rmSync(path.join(trashRoot, d, 'trash.json'), { force: true })
  await get('list with a legacy trash folder', '/api/scenes')
  await send('restore B', 'POST', '/api/scenes/' + Bn + '/restore')
  await send('restore B again', 'POST', '/api/scenes/' + Bn + '/restore')
  await send('restore a non-slug', 'POST', '/api/scenes/Bad%20Name/restore')
  await send('DELETE A (with its layouts)', 'DELETE', '/api/scenes/' + A)
  fs.mkdirSync(path.join(s.dir, 'layouts', A), { recursive: true })
  await send('restore A while layouts/<A> exists', 'POST', '/api/scenes/' + A + '/restore')
  fs.rmSync(path.join(s.dir, 'layouts', A), { recursive: true })
  await send('restore A', 'POST', '/api/scenes/' + A + '/restore')
  await lay('A\'s layouts are back', 'GET', '/api/layouts' + q)
  await get('jobs at the end', '/api/scenes/jobs')
  await get('list at the end', '/api/scenes')
  return { steps, names }
}

/** Replaces what legitimately differs between the two runs: scene names (by the order the server made them), job and
 *  render ids (by first appearance), times, stamps, cache busters and the stub's elapsed time. */
function normalizer(names: readonly string[]): (v: unknown) => unknown {
  const sceneOf = new Map<string, string>()
  names.forEach((n, i) => sceneOf.set(n, '<S' + String(i + 1) + '>'))
  const known = [...sceneOf.keys()].sort((a, b) => b.length - a.length)
  const ids = new Map<string, string>()
  const idOf = (s: string, kind: string): string => {
    const k = kind + s
    let v = ids.get(k)
    if (v === undefined) {
      v = '<' + kind + String(ids.size + 1) + '>'
      ids.set(k, v)
    }
    return v
  }
  const text = (s0: string): string => {
    let s = s0
    // a name is replaced only where no digit follows it: scene-…-2 is a prefix of scene-…-20261106-001027 (a trash name)
    for (const n of known) s = s.replace(new RegExp(n.replace(/-/g, '\\-') + '(?![0-9])', 'g'), sceneOf.get(n) ?? n)
    s = s.replace(/\b[cl]-\d{8}-\d{6}-[0-9a-f]{4}\b/g, (m) => idOf(m, 'J'))
    s = s.replace(/render-\d{8}-\d{6}(?:-\d+)?/g, (m) => idOf(m, 'R'))
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g, '<Tms>')
    s = s.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/g, '<T>')
    s = s.replace(/\d{8}-\d{6}(-\d+)?/g, '<STAMP>')
    s = s.replace(/\?v=\d+/g, '?v=<V>')
    return s
  }
  const walk = (v: unknown, key: string): unknown => {
    if (key === 'elapsed_s' && typeof v === 'number') return 0
    if (typeof v === 'string') return text(v)
    if (Array.isArray(v)) return v.map((x: unknown) => walk(x, ''))
    if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [text(k), walk(x, k)]))
    return v
  }
  return (v) => walk(v, '')
}

/** Every JSON file the server wrote under its scratch folder, by normalized relative path. */
function writtenFiles(dir: string, norm: (v: unknown) => unknown): Map<string, unknown> {
  const out = new Map<string, unknown>()
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (e.name.endsWith('.json') && !e.name.startsWith('.') && e.name !== 'calib.json' && e.name !== 'lighting.json') {
        let v: unknown
        try {
          v = JSON.parse(fs.readFileSync(p, 'utf8'))
        } catch {
          v = '<unreadable>'
        }
        out.set(String(norm(path.relative(dir, p))), norm(v))
      }
    }
  }
  walk(dir)
  return out
}

void test('v1 and v2 answer the scenes, layouts and render routes the same way', { skip, timeout: 600_000 }, async () => {
  const v1 = await start('v1')
  const v2 = await start('v2')
  try {
    const a = await scenario(v1)
    const b = await scenario(v2)
    const n1 = normalizer(a.names)
    const n2 = normalizer(b.names)
    assert.equal(a.steps.length, b.steps.length)
    const diffs: string[] = []
    for (let i = 0; i < a.steps.length; i++) {
      const x = a.steps[i]
      const y = b.steps[i]
      if (x === undefined || y === undefined) continue
      const bx = n1(x.body)
      const by = n2(y.body)
      if (x.status !== y.status || JSON.stringify(bx) !== JSON.stringify(by)) {
        diffs.push('#' + String(i) + ' ' + x.label + ':\n  v1 ' + String(x.status) + ' ' + JSON.stringify(bx) + '\n  v2 ' + String(y.status) + ' ' + JSON.stringify(by))
      }
    }
    const f1 = writtenFiles(v1.dir, n1)
    const f2 = writtenFiles(v2.dir, n2)
    for (const k of new Set([...f1.keys(), ...f2.keys()])) {
      if (JSON.stringify(f1.get(k)) !== JSON.stringify(f2.get(k))) diffs.push('file ' + k + ':\n  v1 ' + JSON.stringify(f1.get(k)) + '\n  v2 ' + JSON.stringify(f2.get(k)))
    }
    assert.ok(!v2.log().includes('contract violation'), 'strict mode found a contract violation:\n' + v2.log().split('\n').filter((l) => l.includes('contract violation')).join('\n'))
    assert.equal(diffs.length, 0, String(diffs.length) + ' of ' + String(a.steps.length) + ' exchanges or files differ:\n' + diffs.join('\n'))
    fs.writeFileSync(path.join(SCRATCH, 'steps.json'), JSON.stringify(b.steps.map((x) => ({ label: x.label, status: x.status, body: n2(x.body) })), null, 1))
    process.stdout.write('# compared ' + String(a.steps.length) + ' exchanges and ' + String(f1.size) + ' files\n')
  } finally {
    await v1.stop()
    await v2.stop()
  }
})
