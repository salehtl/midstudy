// Shared harness for the midstudy task evals (PLAN.md §6.2). Written from the spec only (PLAN.md §4 and §6,
// contract/CONTRACT.md and its schemas, fixtures/): it never reads planner/ or calib/ source.
//
// What it gives every eval:
// - createEval(): one "PASS|FAIL <id> <name> — <measured>" line per check, a summary, exit code 1 on any FAIL, a
//   watchdog, and cleanup (servers and browsers are always stopped, also on a crash or Ctrl-C).
// - startServer(): planner/serve.py on a free port with its own scenes/layouts/renders/library dirs and costs file under
//   evals/out/<eval>/, fal mocked (MIDSTUDY_FAL_MOCK=fixtures/fal, MIDSTUDY_NO_DOTENV=1, no FAL_KEY,
//   --daily-spend-usd 0 unless an eval tests the cap with mock costs) and the calib stub with MIDSTUDY_CALIB_MOCK.
// - a guard that the repo's own scenes/, layouts/, renders/ and library/ are left untouched.
// - the §4.1 projection (and its inverse) in plain JS, to compute expectations independently of the planner.
// - Helium + playwright-core helpers: open the planner, call window.midstudy methods without crashing when one is
//   missing ("hook missing: getScreenRect"), find the photo on screen, touch drags, 44 px target checks.
// - a probe library: a magenta, unlit 0.8 × 0.5 × 1.2 m box GLB (easy to find in a composite, exact bounds).
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import zlib from 'node:zlib'

export const REPO = path.resolve(import.meta.dirname, '../..')
export const BROWSER = process.env.MIDSTUDY_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium'
export const BROWSER_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']
export const STUB_CALIB = 'python3 fixtures/stub_calib.py'
export const REAL_CALIB = 'uv run --project calib midstudy-calib'
export const GOLDEN = ['living-wide', 'steep-roll', 'portrait']
export const DEFAULT_CAMERA = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }
export const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }
export const DESKTOP = { viewport: { width: 1280, height: 800 } }
export const PROBE = { id: 'probe-box', name: 'Probe box', dims_cm: { w: 80, d: 50, h: 120 } }
export const SCENE_NAME_RE = /^scene-\d{8}-\d{6}(-\d+)?$/
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const fmt = (v) => {
  let s
  try { s = JSON.stringify(v, (k, x) => (typeof x === 'number' && !Number.isInteger(x) ? Math.round(x * 10000) / 10000 : x)) } catch { s = String(v) }
  return s === undefined ? String(v) : s
}
export const clip = (s, n = 400) => { s = String(s ?? ''); return s.length > n ? `${s.slice(0, n)}…` : s }
export const golden = (id) => ({
  id,
  dir: path.join(REPO, 'fixtures/scenes', id),
  photo: path.join(REPO, 'fixtures/scenes', id, 'photo.jpg'),
  depth: path.join(REPO, 'fixtures/scenes', id, 'depth.png'),
  truth: JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures/scenes', id, 'truth.json'), 'utf8')),
})

// --- results ---------------------------------------------------------------------------------------------------------------
export function createEval(id, slug, { timeoutS = 600 } = {}) {
  const out = path.join(REPO, 'evals/out', slug)
  fs.rmSync(out, { recursive: true, force: true })
  fs.mkdirSync(out, { recursive: true })
  const t0 = Date.now()
  const results = []
  const cleanups = []
  let finishing = false
  const guard = repoGuard()
  const ev = {
    id, slug, out, results,
    secs: () => ((Date.now() - t0) / 1000).toFixed(1),
    // One line per check, always with the measured value.
    check(name, ok, measured = '') {
      const n = `${id}.${String(results.length + 1).padStart(2, '0')}`
      results.push({ n, name, ok: !!ok, measured: clip(typeof measured === 'string' ? measured : fmt(measured), 600) })
      console.log(`${ok ? 'PASS' : 'FAIL'} ${n} ${name} — ${results.at(-1).measured || '(no value)'}`)
      return !!ok
    },
    skip(name, why) { console.log(`SKIP ${id}.-- ${name} — ${why}`) },
    note(msg) { console.log(`     ${msg}`) },
    section(title) { console.log(`\n--- ${title}`) },
    onCleanup(fn) { cleanups.push(fn) },
    async finish(extraCode = 0) {
      if (finishing) return
      finishing = true
      clearTimeout(watchdog)
      for (const fn of cleanups.reverse()) { try { await fn() } catch { /* best effort */ } }
      const touched = guard()
      ev.check("the repo's own scenes/, layouts/, renders/ and library/ were not touched", touched.length === 0, touched.length ? touched.slice(0, 8).join(', ') : 'unchanged')
      const failed = results.filter((r) => !r.ok)
      console.log(`\n${id}: ${results.length - failed.length}/${results.length} checks passed in ${ev.secs()} s` + (failed.length ? ` (failed: ${failed.map((f) => f.n).join(' ')})` : ''))
      fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify({ id, results }, null, 2))
      process.exit(failed.length || extraCode ? 1 : 0)
    },
  }
  const watchdog = setTimeout(() => { ev.check('the eval finishes within its time limit', false, `still running after ${timeoutS} s`); ev.finish(1) }, timeoutS * 1000)
  process.on('unhandledRejection', (e) => { ev.check('no harness exception', false, e?.stack || String(e)); ev.finish(1) })
  process.on('uncaughtException', (e) => { ev.check('no harness exception', false, e?.stack || String(e)); ev.finish(1) })
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { ev.check('not interrupted', false, sig); ev.finish(1) })
  return ev
}

// The repo's own user data must never be written by an eval (each server gets its own dirs).
function repoGuard() {
  const roots = ['scenes', 'layouts', 'renders', 'library'].map((d) => path.join(REPO, d))
  const snap = () => {
    const m = new Map()
    const walk = (p) => {
      let st
      try { st = fs.lstatSync(p) } catch { return }
      if (st.isDirectory()) { for (const c of fs.readdirSync(p)) walk(path.join(p, c)) } else m.set(path.relative(REPO, p), `${st.size}:${st.mtimeMs}`)
    }
    roots.forEach(walk)
    return m
  }
  const before = snap()
  return () => {
    const after = snap(), diff = []
    for (const [k, v] of after) if (before.get(k) !== v) diff.push(before.has(k) ? `changed ${k}` : `new ${k}`)
    for (const k of before.keys()) if (!after.has(k)) diff.push(`removed ${k}`)
    return diff
  }
}

// --- ports, HTTP ------------------------------------------------------------------------------------------------------------
export const freePort = () => new Promise((resolve, reject) => {
  const s = net.createServer()
  s.on('error', reject)
  s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) })
})

// A raw HTTP request with full control over headers (Host, Origin, no Content-Length) and the path as written.
// Resolves {status, headers, text, json, buf}; status 0 with `error` when the connection failed before a response.
export function raw(base, method, p, { headers = {}, body = null, chunked = false, timeoutMs = 30000 } = {}) {
  const u = new URL(base)
  return new Promise((resolve) => {
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    const h = { ...headers }
    const buf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))
    if (buf && !chunked && !Object.keys(h).some((k) => k.toLowerCase() === 'content-length')) h['Content-Length'] = buf.length
    if (chunked) h['Transfer-Encoding'] = 'chunked'
    const req = http.request({ host: u.hostname, port: u.port, method, path: p, headers: h, setHost: !Object.keys(h).some((k) => k.toLowerCase() === 'host') }, (res) => {
      const parts = []
      res.on('data', (c) => parts.push(c))
      res.on('end', () => {
        const b = Buffer.concat(parts), text = b.toString('utf8')
        let json = null
        try { json = JSON.parse(text) } catch { /* not JSON */ }
        finish({ status: res.statusCode, headers: res.headers, text, json, buf: b })
      })
      res.on('error', (e) => finish({ status: res.statusCode, headers: res.headers, text: '', json: null, buf: Buffer.alloc(0), error: String(e) }))
    })
    req.setTimeout(timeoutMs, () => { req.destroy(new Error(`timeout after ${timeoutMs} ms`)) })
    req.on('error', (e) => finish({ status: 0, headers: {}, text: '', json: null, buf: Buffer.alloc(0), error: String(e?.code || e) }))
    if (buf) {
      if (chunked) { for (let i = 0; i < buf.length; i += 65536) req.write(buf.subarray(i, i + 65536)) } else req.write(buf)
    }
    req.end()
  })
}
// JSON helpers: every mutation carries X-Midstudy: 1 (§2.9) unless `forged`.
export const api = {
  get: (base, p, o = {}) => raw(base, 'GET', p, o),
  send: (base, method, p, body, { forged = false, headers = {}, ...o } = {}) => raw(base, method, p, {
    headers: { ...(forged ? {} : { 'X-Midstudy': '1' }), ...(body != null ? { 'Content-Type': 'application/json' } : {}), ...headers }, body, ...o }),
}
export const b64json = (o) => Buffer.from(JSON.stringify(o)).toString('base64')
// POST /api/scenes with a raw photo body (§4.4).
export function uploadScene(base, bytes, { filename = 'photo.jpg', title, forged = false, headers = {}, ...o } = {}) {
  const h = { 'Content-Type': 'application/octet-stream', ...(forged ? {} : { 'X-Midstudy': '1' }), ...(filename ? { 'X-Midstudy-Filename': filename } : {}), ...headers }
  if (title !== undefined) h['X-Midstudy-Meta'] = b64json({ title })
  return raw(base, 'POST', '/api/scenes', { headers: h, body: bytes, ...o })
}
export async function waitFor(fn, { timeoutMs = 30000, intervalMs = 200 } = {}) {
  const end = Date.now() + timeoutMs
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last } catch (e) { last = { error: String(e) } }
    await sleep(intervalMs)
  }
  return null
}
// Waits until a scene's calibration job ends; returns the scene object (or null on timeout).
export async function waitScene(base, name, timeoutMs = 60000) {
  return waitFor(async () => {
    const r = await api.get(base, `/api/scenes/${name}`)
    return r.status === 200 && ['done', 'failed'].includes(r.json?.calib_status) ? r.json : null
  }, { timeoutMs, intervalMs: 250 })
}

// --- the server ---------------------------------------------------------------------------------------------------------------
let serverCount = 0
// Starts planner/serve.py with scratch dirs. Returns {base, port, dirs, log(), stop(), exited}. Never throws: when the
// server doesn't come up, `up` is false and `why` says what happened (e.g. an unknown flag before the feature exists).
export async function startServer(ev, { calib = STUB_CALIB, calibMock = true, spendUsd = '0', mockCost = false, env = {}, args = [], library = 'probe' } = {}) {
  const n = ++serverCount
  const data = path.join(ev.out, `server-${n}`)
  const dirs = { data, scenes: path.join(data, 'scenes'), layouts: path.join(data, 'layouts'), renders: path.join(data, 'renders'), library: path.join(data, 'library') }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  dirs.costs = path.join(dirs.library, 'costs.csv')
  fs.writeFileSync(dirs.costs, 'date,id,engine,cost_usd,mock,input\n')
  if (library === 'probe') writeProbeLibrary(dirs.library)
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const childEnv = { ...process.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'), NOOK_FAL_MOCK: path.join(REPO, 'fixtures/fal'), ...env }
  if (calibMock) childEnv.MIDSTUDY_CALIB_MOCK = path.join(REPO, 'fixtures/calib')
  else delete childEnv.MIDSTUDY_CALIB_MOCK
  delete childEnv.FAL_KEY
  if (mockCost) childEnv.MIDSTUDY_FAL_MOCK_COST = '1'
  else delete childEnv.MIDSTUDY_FAL_MOCK_COST
  // Hard limits (CLAUDE.md): never without the fal mock, never without a spend cap flag.
  if (!childEnv.MIDSTUDY_FAL_MOCK || spendUsd == null) throw new Error('refusing to start serve.py without the fal mock and a spend cap')
  const argv = ['planner/serve.py', '--port', String(port), '--host', '127.0.0.1', '--scenes-dir', dirs.scenes, '--layouts-dir', dirs.layouts,
    '--renders-dir', dirs.renders, '--library-dir', dirs.library, '--costs-file', dirs.costs, '--calib', calib, '--daily-spend-usd', String(spendUsd), ...args]
  const logPath = path.join(data, 'server.log')
  let log = `$ python3 ${argv.join(' ')}\n`
  const proc = spawn('python3', argv, { cwd: REPO, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  const srv = { n, base, port, dirs, proc, logPath, up: false, why: '', exited: null, log: () => log }
  proc.stdout.on('data', (d) => { log += d })
  proc.stderr.on('data', (d) => { log += d })
  proc.on('exit', (code, sig) => { srv.exited = { code, sig } })
  srv.stop = async () => {
    if (srv.exited == null) {
      proc.kill('SIGTERM')
      for (let i = 0; i < 25 && srv.exited == null; i++) await sleep(100)
      if (srv.exited == null) proc.kill('SIGKILL')
    }
    fs.writeFileSync(logPath, log)
  }
  ev.onCleanup(srv.stop)
  for (let i = 0; i < 100 && srv.exited == null; i++) {
    const r = await raw(base, 'GET', '/planner/', { timeoutMs: 2000 })
    if (r.status) { srv.up = true; break }
    await sleep(150)
  }
  if (!srv.up) {
    await sleep(200)
    const tail = log.trim().split('\n').slice(-4).join(' | ')
    srv.why = srv.exited ? `serve.py exited (${srv.exited.code ?? srv.exited.sig}): ${tail}` : `serve.py did not answer on ${base}: ${tail}`
  }
  return srv
}

// --- probe library -----------------------------------------------------------------------------------------------------------
// A GLB box in the item frame (footprint center at the origin, min y = 0), magenta and unlit (KHR_materials_unlit),
// so it stands out from every colour in the golden room and its silhouette is exactly its bounding box.
export function boxGlb(w, h, d, rgba = [1, 0, 1, 1]) {
  const x0 = -w / 2, x1 = w / 2, y0 = 0, y1 = h, z0 = -d / 2, z1 = d / 2
  const faces = [ // 4 corners counterclockwise seen from outside, and the normal
    [[[x1, y0, z1], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1]], [1, 0, 0]],
    [[[x0, y0, z0], [x0, y0, z1], [x0, y1, z1], [x0, y1, z0]], [-1, 0, 0]],
    [[[x0, y1, z1], [x1, y1, z1], [x1, y1, z0], [x0, y1, z0]], [0, 1, 0]],
    [[[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]], [0, -1, 0]],
    [[[x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [0, 0, 1]],
    [[[x1, y0, z0], [x0, y0, z0], [x0, y1, z0], [x1, y1, z0]], [0, 0, -1]],
  ]
  const pos = [], nrm = [], idx = []
  faces.forEach(([quad, nn], f) => {
    for (const p of quad) { pos.push(...p); nrm.push(...nn) }
    idx.push(4 * f, 4 * f + 1, 4 * f + 2, 4 * f, 4 * f + 2, 4 * f + 3)
  })
  const posB = Buffer.from(new Float32Array(pos).buffer), nrmB = Buffer.from(new Float32Array(nrm).buffer), idxB = Buffer.from(new Uint16Array(idx).buffer)
  const bin = Buffer.concat([posB, nrmB, idxB, Buffer.alloc((4 - (idxB.length % 4)) % 4)])
  const gltf = {
    asset: { version: '2.0', generator: 'midstudy evals/lib/harness.mjs' },
    extensionsUsed: ['KHR_materials_unlit'],
    scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0, name: 'probe-box' }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [{ name: 'probe-magenta', pbrMetallicRoughness: { baseColorFactor: rgba, metallicFactor: 0, roughnessFactor: 1 }, extensions: { KHR_materials_unlit: {} } }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: posB.length, target: 34962 },
      { buffer: 0, byteOffset: posB.length, byteLength: nrmB.length, target: 34962 },
      { buffer: 0, byteOffset: posB.length + nrmB.length, byteLength: idxB.length, target: 34963 },
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 24, type: 'VEC3', min: [x0, y0, z0], max: [x1, y1, z1] },
      { bufferView: 1, componentType: 5126, count: 24, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, count: 36, type: 'SCALAR' },
    ],
  }
  let json = Buffer.from(JSON.stringify(gltf))
  json = Buffer.concat([json, Buffer.alloc((4 - (json.length % 4)) % 4, 0x20)])
  const header = Buffer.alloc(12), jh = Buffer.alloc(8), bh = Buffer.alloc(8)
  header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(12 + 8 + json.length + 8 + bin.length, 8)
  jh.writeUInt32LE(json.length, 0); jh.writeUInt32LE(0x4e4f534a, 4)
  bh.writeUInt32LE(bin.length, 0); bh.writeUInt32LE(0x004e4942, 4)
  return Buffer.concat([header, jh, json, bh, bin])
}
export function writeProbeLibrary(dir) {
  const { w, d, h } = PROBE.dims_cm
  fs.mkdirSync(path.join(dir, PROBE.id), { recursive: true })
  fs.writeFileSync(path.join(dir, PROBE.id, 'model.glb'), boxGlb(w / 100, h / 100, d / 100))
  const lib = { version: 1, items: [{
    id: PROBE.id, name: PROBE.name, category: 'test', dims_cm: { w, d, h },
    assets: { glb: `${PROBE.id}/model.glb`, splat: null, thumb: null }, default_render: 'glb',
    source: { engine: 'fixture', input: 'generated by evals/lib/harness.mjs', prompt: null, cost_usd: 0, mock: false, created: '2026-11-04T00:00:00Z' },
    notes: 'Eval probe: magenta unlit box, exact bounds.',
  }] }
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify(lib, null, 2))
}

// --- PNG (8-bit gray or RGB), for masks ------------------------------------------------------------------------------------
export function encodePng(w, h, channels, pixels /* Uint8Array w*h*channels */) {
  const rows = Buffer.alloc((w * channels + 1) * h)
  for (let y = 0; y < h; y++) { rows[y * (w * channels + 1)] = 0; Buffer.from(pixels.buffer, pixels.byteOffset + y * w * channels, w * channels).copy(rows, y * (w * channels + 1) + 1) }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data])
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td) >>> 0)
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = channels === 1 ? 0 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}
// A keep-room mask: white rectangles (photo pixels) on black, at the photo's size.
export function maskPng(w, h, rects) {
  const px = new Uint8Array(w * h)
  for (const [x0, y0, x1, y1] of rects) for (let y = Math.max(0, y0 | 0); y < Math.min(h, y1); y++) px.fill(255, y * w + Math.max(0, x0 | 0), y * w + Math.min(w, x1 | 0))
  return encodePng(w, h, 1, px)
}
export const dataUri = (mime, buf) => `data:${mime};base64,${buf.toString('base64')}`
export function jpegSize(buf) {
  let i = 2
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return null
    const m = buf[i + 1]
    if (m === 0xff) { i++; continue }
    const len = buf.readUInt16BE(i + 2)
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) }
    i += 2 + len
  }
  return null
}

// --- §4.1 projection ----------------------------------------------------------------------------------------------------------
const rad = (d) => (d * Math.PI) / 180
export const focalPx = (cam, H) => H / 2 / Math.tan(rad(cam.fov_y_deg) / 2)
// World point → {px, py, d} on a W × H photo (contract §4.1: R = Rx(pitch)·Rz(roll), p_c = Rᵀ(p − C), d = −p_c.z).
export function project(cam, W, H, p) {
  const v = [p[0], p[1] - cam.height_m, p[2]]
  const ca = Math.cos(rad(cam.pitch_deg)), sa = Math.sin(rad(cam.pitch_deg))
  const u = [v[0], ca * v[1] + sa * v[2], -sa * v[1] + ca * v[2]] // Rx(pitch)ᵀ
  const cb = Math.cos(rad(cam.roll_deg)), sb = Math.sin(rad(cam.roll_deg))
  const pc = [cb * u[0] + sb * u[1], -sb * u[0] + cb * u[1], u[2]] // Rz(roll)ᵀ
  const d = -pc[2], f = focalPx(cam, H)
  return { px: W / 2 + (f * pc[0]) / d, py: H / 2 - (f * pc[1]) / d, d }
}
// Photo pixel → floor point [x, 0, z], or null at or above the horizon (contract §4.1 inverse).
export function photoToFloor(cam, W, H, px, py) {
  const f = focalPx(cam, H)
  const c = [(px - W / 2) / f, -(py - H / 2) / f, -1]
  const cb = Math.cos(rad(cam.roll_deg)), sb = Math.sin(rad(cam.roll_deg))
  const z = [cb * c[0] - sb * c[1], sb * c[0] + cb * c[1], c[2]] // Rz(roll)
  const ca = Math.cos(rad(cam.pitch_deg)), sa = Math.sin(rad(cam.pitch_deg))
  const dir = [z[0], ca * z[1] - sa * z[2], sa * z[1] + ca * z[2]] // Rx(pitch)
  if (dir[1] >= 0) return null
  const t = -cam.height_m / dir[1]
  return [t * dir[0], 0, t * dir[2]]
}
export const boxCorners = (min, max) => [0, 1, 2, 3, 4, 5, 6, 7].map((i) => [i & 1 ? max[0] : min[0], i & 2 ? max[1] : min[1], i & 4 ? max[2] : min[2]])
// The projected bounding rect {x, y, w, h} of an axis-aligned box (all corners in front of the camera).
export function projectBox(cam, W, H, min, max) {
  const ps = boxCorners(min, max).map((p) => project(cam, W, H, p))
  const xs = ps.map((p) => p.px), ys = ps.map((p) => p.py)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
// Where §4.5 drops a new item (photo at Fit): the floor hit of the ray through the view center, else through the center
// of the lower third, when 1–6 m from the camera; else 2.5 m straight ahead. Returns every reading of "distance" the
// spec allows (horizontal, or straight-line from the camera), so an eval can accept either.
export function expectedDrop(cam, W, H) {
  const options = []
  for (const metric of ['horizontal', 'euclidean']) {
    let hit = null
    for (const py of [H / 2, (H * 5) / 6]) {
      const p = photoToFloor(cam, W, H, W / 2, py)
      if (!p) continue
      const dist = metric === 'horizontal' ? Math.hypot(p[0], p[2]) : Math.hypot(p[0], cam.height_m, p[2])
      if (dist >= 1 && dist <= 6) { hit = p; break }
    }
    options.push({ metric, point: hit || [0, 0, -2.5] })
  }
  return options
}
export const camDiff = (a, b) => a && b ? Math.max(...['fov_y_deg', 'height_m', 'pitch_deg', 'roll_deg'].map((k) => Math.abs((a[k] ?? NaN) - (b[k] ?? NaN)))) : Infinity
export const camEq = (a, b, tol = 1e-3) => camDiff(a, b) <= tol

// --- python helpers (evals/py: numpy + pillow) ----------------------------------------------------------------------------------
export function pyHelper(args, { timeoutMs = 300000, env = {} } = {}) {
  try {
    const outp = execFileSync(path.join(REPO, 'evals/py'), [path.join(REPO, 'evals/lib/images.py'), ...args],
      { cwd: REPO, encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 << 20 })
    const last = outp.trim().split('\n').at(-1)
    return JSON.parse(last)
  } catch (e) {
    return { error: clip(`${e.stderr || ''}${e.stdout || ''}${e.message || e}`, 600) }
  }
}

// --- browser -----------------------------------------------------------------------------------------------------------------
export async function launchBrowser(ev) {
  const { chromium } = await import('playwright-core')
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true, args: BROWSER_ARGS })
  ev.onCleanup(() => browser.close())
  return browser
}
// Opens the planner in a fresh context and waits for window.midstudy.ready. Returns {page, context, errors, hook}.
// `hook` is null when window.midstudy never appeared (then every hook call fails with "hook missing: window.midstudy").
export async function openPlanner(browser, base, { device = 'desktop', scene = null, viewport = null, recordRefusals = true } = {}) {
  const context = await browser.newContext(device === 'phone' ? PHONE : { ...DESKTOP, ...(viewport ? { viewport } : {}) })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const errors = { page: [], console: [], refused: [] }
  page.on('console', (m) => { if (m.type() === 'error') errors.console.push(clip(`${m.text()} ${m.location()?.url || ''}`, 300)) })
  page.on('pageerror', (e) => errors.page.push(clip(e.stack || String(e), 500)))
  if (recordRefusals) page.on('response', (r) => { if (r.status() === 403) errors.refused.push(`${r.request().method()} ${r.url()}`) })
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'eval-layout' : undefined).catch(() => {}))
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style')
    s.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;animation-delay:0s!important;transition-delay:0s!important}'
    document.head.append(s)
  }))
  const url = `${base}/planner/${scene ? `?scene=${encodeURIComponent(scene)}` : ''}`
  let why = ''
  try { await page.goto(url, { waitUntil: 'load', timeout: 30000 }) } catch (e) { why = `page load failed: ${String(e).split('\n')[0]}` }
  const ok = !why && await page.waitForFunction(() => !!window.midstudy, null, { timeout: 30000 }).then(() => true, () => false)
  if (!ok && !why) why = `hook missing: window.midstudy${errors.page.length || errors.console.length ? ` (page errors: ${clip([...errors.page, ...errors.console].slice(0, 3).join(' | '), 400)})` : ''}`
  let ready = ''
  if (ok) ready = await page.evaluate(() => Promise.race([Promise.resolve(window.midstudy.ready).then(() => ''), new Promise((r) => setTimeout(() => r('window.midstudy.ready did not resolve in 60 s'), 60000))]).catch((e) => `window.midstudy.ready rejected: ${e}`))
  return { page, context, errors, hookOk: ok && !ready, why: why || ready, url }
}
// Calls window.midstudy[method](...args) with a timeout. Returns {value} or {error: 'hook missing: <method>' | ...}.
export async function hook(page, method, args = [], timeoutMs = 60000) {
  try {
    return await page.evaluate(async ({ method, args, timeoutMs }) => {
      const m = window.midstudy
      if (!m) return { error: 'hook missing: window.midstudy' }
      if (typeof m[method] !== 'function') return { error: `hook missing: ${method}` }
      try {
        const v = await Promise.race([Promise.resolve(m[method](...args)), new Promise((_, rej) => setTimeout(() => rej(new Error(`no answer in ${timeoutMs / 1000} s`)), timeoutMs))])
        return { value: v === undefined ? null : JSON.parse(JSON.stringify(v)) }
      } catch (e) { return { error: `${method}() failed: ${e?.message || e}` } }
    }, { method, args, timeoutMs })
  } catch (e) { return { error: `${method}() could not be called: ${String(e).split('\n')[0]}` } }
}
// Calls a synchronous hook method once per argument list, in one round trip: {value: [results]} or {error}.
export async function hookAll(page, method, argsList) {
  try {
    return await page.evaluate(({ method, argsList }) => {
      const m = window.midstudy
      if (!m) return { error: 'hook missing: window.midstudy' }
      if (typeof m[method] !== 'function') return { error: `hook missing: ${method}` }
      try { return { value: JSON.parse(JSON.stringify(argsList.map((a) => m[method](...a) ?? null))) } } catch (e) { return { error: `${method}() failed: ${e?.message || e}` } }
    }, { method, argsList })
  } catch (e) { return { error: `${method}() could not be called: ${String(e).split('\n')[0]}` } }
}
// window.midstudy.createScene(file) needs a File built in the page.
export async function hookCreateScene(page, bytes, filename, meta) {
  try {
    return await page.evaluate(async ({ b64, filename, meta }) => {
      const m = window.midstudy
      if (!m || typeof m.createScene !== 'function') return { error: 'hook missing: createScene' }
      const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
      const file = new File([bin], filename, { type: 'image/jpeg' })
      try { return { value: JSON.parse(JSON.stringify(await m.createScene(file, meta))) } } catch (e) { return { error: `createScene() failed: ${e?.message || e}` } }
    }, { b64: bytes.toString('base64'), filename, meta })
  } catch (e) { return { error: String(e).split('\n')[0] } }
}
export const missingHook = async (page, names) => page.evaluate((names) => names.filter((n) => typeof window.midstudy?.[n] !== 'function'), names).catch(() => names)
export const state = async (page) => (await hook(page, 'getState')).value ?? null
// Opens a scene through the hook unless it's already open; resolves {ok, why}.
export async function ensureScene(page, name) {
  const s = await state(page)
  if (s?.scene?.name === name) return { ok: true, why: 'already open' }
  const r = await hook(page, 'openScene', [name], 90000)
  if (r.error) return { ok: false, why: r.error }
  const s2 = await state(page)
  return s2?.scene?.name === name ? { ok: true, why: 'opened' } : { ok: false, why: `getState().scene is ${fmt(s2?.scene ?? null)}` }
}
export const itemOf = (st, uid) => st?.items?.find((i) => i.uid === uid) || null
export const extents = (wb) => wb ? wb.max.map((v, i) => v - wb.min[i]) : null

// The locator of a control: [data-midstudy=handle] first, then an accessible name.
export async function control(page, handle, names = []) {
  const byHandle = page.locator(`[data-midstudy="${handle}"]`)
  const n = await byHandle.count().catch(() => 0)
  for (let i = 0; i < n; i++) if (await byHandle.nth(i).isVisible().catch(() => false)) return { loc: byHandle.nth(i), how: `[data-midstudy=${handle}]` }
  for (const re of names) {
    for (const role of ['button', 'tab', 'menuitem', 'link', 'switch', 'checkbox']) {
      const loc = page.getByRole(role, { name: re })
      const c = await loc.count().catch(() => 0)
      for (let i = 0; i < c; i++) if (await loc.nth(i).isVisible().catch(() => false)) return { loc: loc.nth(i), how: `${role} named ${re}` }
    }
  }
  return { loc: null, how: n ? `[data-midstudy=${handle}] exists but is hidden` : `no [data-midstudy=${handle}]${names.length ? ` or control named ${names.join(' / ')}` : ''}` }
}
// Sets a slider / number field: an <input> gets its value and input + change events; anything else gets arrow keys.
export async function setField(loc, value) {
  return loc.evaluate((el, value) => {
    const input = el.matches('input, select, textarea') ? el : el.querySelector('input')
    if (!input) return { kind: el.tagName.toLowerCase(), set: false }
    const proto = Object.getPrototypeOf(input)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    setter ? setter.call(input, String(value)) : (input.value = String(value))
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
    return { kind: `input[type=${input.type}]`, set: true, value: input.value, min: input.min, max: input.max, step: input.step }
  }, value)
}

// Where the photo is drawn: candidate rects (visible canvases and images), each contain-fitted to the photo's aspect,
// scored against a screenshot by sampling a 24 × 24 grid of photo pixels (median of the per-sample max channel
// difference). Returns {rect: {x, y, w, h} in CSS px, scale (CSS px per photo px), median, how}.
export async function findPhotoOnScreen(page, photoUrl, W, H) {
  const shot = await page.screenshot({ scale: 'css' })
  return page.evaluate(async ({ shotB64, photoUrl, W, H }) => {
    const toData = async (blob, w, h) => {
      const bmp = await createImageBitmap(blob)
      const c = new OffscreenCanvas(w ?? bmp.width, h ?? bmp.height), g = c.getContext('2d')
      g.drawImage(bmp, 0, 0, c.width, c.height)
      return g.getImageData(0, 0, c.width, c.height)
    }
    const shotBlob = await (await fetch(`data:image/png;base64,${shotB64}`)).blob()
    const shot = await toData(shotBlob)
    const photo = await toData(await (await fetch(photoUrl)).blob(), W, H)
    // The photo is contain-fitted into "the view", which may be any element (the canvas, an img, or a container that
    // leaves room for panels): try every large visible element's box, and score each fit against the screenshot.
    const cands = [], seen = new Set()
    for (const el of document.querySelectorAll('body, body *')) {
      const r = el.getBoundingClientRect()
      if (r.width * r.height < 0.12 * innerWidth * innerHeight || !el.checkVisibility?.({ opacityProperty: true, visibilityProperty: true })) continue
      const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',')
      if (seen.has(key)) continue
      seen.add(key)
      const s = Math.min(r.width / W, r.height / H)
      const id = el.dataset?.midstudy ? `[data-midstudy=${el.dataset.midstudy}]` : el.id ? `#${el.id}` : el.classList?.[0] ? `.${el.classList[0]}` : ''
      cands.push({ how: `${el.tagName.toLowerCase()}${id} ${Math.round(r.width)}×${Math.round(r.height)}`, rect: { x: r.left + (r.width - W * s) / 2, y: r.top + (r.height - H * s) / 2, w: W * s, h: H * s }, scale: s })
    }
    const sx = shot.width / innerWidth
    const score = (c, n = 24) => {
      const diffs = []
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
        const u = (i + 0.5) / n, v = (j + 0.5) / n
        const X = Math.round((c.rect.x + u * c.rect.w) * sx), Y = Math.round((c.rect.y + v * c.rect.h) * sx)
        if (X < 0 || Y < 0 || X >= shot.width || Y >= shot.height) { diffs.push(255); continue }
        const a = (Y * shot.width + X) * 4, b = (Math.floor(v * H) * W + Math.floor(u * W)) * 4
        diffs.push(Math.max(Math.abs(shot.data[a] - photo.data[b]), Math.abs(shot.data[a + 1] - photo.data[b + 1]), Math.abs(shot.data[a + 2] - photo.data[b + 2])))
      }
      diffs.sort((p, q) => p - q)
      return diffs[diffs.length >> 1]
    }
    for (const c of cands) c.median = score(c)
    cands.sort((p, q) => p.median - q.median)
    if (cands[0] && cands[0].median <= 8) return cands[0]
    // No element box fits: register the photo against the screenshot directly (the view rect may be computed in JS).
    // Coarse: every scale that fits on screen (step 0.01) and offset (step 4 px), 10 × 10 samples; then refine.
    const at = (x, y, s) => ({ rect: { x, y, w: W * s, h: H * s }, scale: s })
    let best = { median: 256 }
    for (let s = 0.12; W * s <= innerWidth + 1 && H * s <= innerHeight + 1; s += 0.01) {
      for (let x = 0; x <= innerWidth - W * s + 0.5; x += 4) for (let y = 0; y <= innerHeight - H * s + 0.5; y += 4) {
        const c = at(x, y, s), m = score(c, 10)
        if (m < best.median) best = { ...c, median: m }
      }
    }
    if (best.rect) {
      const b0 = best
      for (let s = b0.scale - 0.012; s <= b0.scale + 0.012; s += 0.001) for (let dx = -5; dx <= 5; dx++) for (let dy = -5; dy <= 5; dy++) {
        const c = at(b0.rect.x + dx, b0.rect.y + dy, s), m = score(c, 16)
        if (m < best.median || best === b0) best = { ...c, median: m }
      }
      // Sub-pixel: coordinate descent on (center x, center y, scale), trimmed mean of luminance differences over
      // 48 × 48 bilinear samples (the worst 25 % dropped, for overlays such as the floor grid or UI).
      const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
      const shotAt = (X, Y) => {
        const x0 = Math.floor(X), y0 = Math.floor(Y), fx = X - x0, fy = Y - y0
        if (x0 < 0 || y0 < 0 || x0 + 1 >= shot.width || y0 + 1 >= shot.height) return null
        const i = (y0 * shot.width + x0) * 4, j = i + shot.width * 4
        return (lum(shot.data, i) * (1 - fx) + lum(shot.data, i + 4) * fx) * (1 - fy) + (lum(shot.data, j) * (1 - fx) + lum(shot.data, j + 4) * fx) * fy
      }
      const N = 48, ref = []
      for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) { const u = (i + 0.5) / N, v = (j + 0.5) / N; ref.push([u, v, lum(photo.data, (Math.floor(v * H) * W + Math.floor(u * W)) * 4)]) }
      const fine = (cx, cy, s) => {
        const d = []
        for (const [u, v, l] of ref) { const q = shotAt((cx + (u - 0.5) * W * s) * sx - 0.5, (cy + (v - 0.5) * H * s) * sx - 0.5); d.push(q == null ? 255 : Math.abs(q - l)) }
        d.sort((a, b) => a - b)
        const k = Math.floor(d.length * 0.75)
        return d.slice(0, k).reduce((a, b) => a + b, 0) / k
      }
      let p = [best.rect.x + best.rect.w / 2, best.rect.y + best.rect.h / 2, best.scale], pc = fine(...p)
      for (const [st, ss] of [[2, 0.004], [1, 0.002], [0.5, 0.001], [0.25, 0.0005], [0.125, 0.00025]]) {
        for (let it = 0, moved = true; moved && it < 40; it++) {
          moved = false
          for (const dlt of [[st, 0, 0], [-st, 0, 0], [0, st, 0], [0, -st, 0], [0, 0, ss], [0, 0, -ss]]) {
            const q = [p[0] + dlt[0], p[1] + dlt[1], p[2] + dlt[2]], c = fine(...q)
            if (c < pc) { p = q; pc = c; moved = true }
          }
        }
      }
      best = { ...at(p[0] - (W * p[2]) / 2, p[1] - (H * p[2]) / 2, p[2]), refined_cost: pc }
      best.median = score(best, 24)
      best.how = `registered on the screenshot (no element box fits; best box ${cands[0]?.how || 'none'} median ${cands[0]?.median ?? 'n/a'})`
      return best
    }
    return cands[0] || { rect: null, median: 255, how: 'nothing on screen matches the photo' }
  }, { shotB64: shot.toString('base64'), photoUrl, W, H })
}
export const photoToCss = (m, px, py) => [m.rect.x + px * m.scale, m.rect.y + py * m.scale]

// The Compare view for renders a and b (§4.5): how much of each image is on screen, how much of the viewport the view
// (the images' closest common ancestor) covers, whether they sit side by side, and whether a split slider is there
// (input[type=range], [role=slider], or a draggable handle: cursor ew-resize / col-resize). If no slider is visible,
// a control named Split / Slider / Overlay inside the view is clicked once and the slider looked for again.
export async function inspectCompare(page, a, b, { tryToggle = true } = {}) {
  const look = () => page.evaluate(([a, b]) => {
    const vw = innerWidth, vh = innerHeight
    const onScreen = (r) => (r.width * r.height > 0 ? (Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))) / (r.width * r.height) : 0)
    const pick = (n) => [...document.querySelectorAll(`img[src*="${n}"]`)].filter((el) => el.checkVisibility({ opacityProperty: true, visibilityProperty: true }))
      .map((el) => ({ el, r: el.getBoundingClientRect() })).filter(({ r }) => r.width > 100).sort((p, q) => onScreen(q.r) * q.r.width - onScreen(p.r) * p.r.width)[0]
    const A = pick(a), B = pick(b)
    if (!A || !B) return { found: [!!A, !!B] }
    let anc = A.el.parentElement
    while (anc && !anc.contains(B.el)) anc = anc.parentElement
    // the view: the common ancestor, grown to its outermost ancestor that is fixed/absolute (the modal itself)
    let view = anc
    for (let p = anc; p && p !== document.body; p = p.parentElement) if (['fixed', 'absolute'].includes(getComputedStyle(p).position)) view = p
    const vr = view.getBoundingClientRect()
    const cover = (Math.max(0, Math.min(vr.right, vw) - Math.max(vr.left, 0)) * Math.max(0, Math.min(vr.bottom, vh) - Math.max(vr.top, 0))) / (vw * vh)
    const sliders = [...view.querySelectorAll('*')].filter((el) => el.checkVisibility() && (el.matches('input[type="range"], [role="slider"]') || ['ew-resize', 'col-resize'].includes(getComputedStyle(el).cursor)))
    const round = (r) => [r.left, r.top, r.width, r.height].map(Math.round)
    return { found: [true, true], aOn: onScreen(A.r), bOn: onScreen(B.r), a: round(A.r), b: round(B.r), view: `${view.tagName.toLowerCase()}.${String(view.className).split(' ')[0]} ${fmtR(round(vr))}`,
      cover, sideBySide: A.r.right <= B.r.left + 2 || B.r.right <= A.r.left + 2, slider: sliders.length }
    function fmtR(r) { return `[${r.join(',')}]` }
  }, [a, b]).catch((e) => ({ error: String(e).split('\n')[0] }))
  let res = await look()
  if (tryToggle && res.found?.every(Boolean) && !res.slider) {
    const t = await control(page, 'compare-split', [/split/i, /slider/i, /overlay/i])
    if (t.loc) {
      const clicked = await t.loc.click({ timeout: 5000 }).then(() => 'clicked', (e) => `click failed: ${String(e).split('\n')[0].slice(0, 80)}`)
      await sleep(400)
      const r2 = await look()
      res = { ...r2, toggled: `${t.how} (${clicked})`, sideBySideBefore: res.sideBySide }
    }
  }
  return res
}

// Touch drag through CDP (playwright's touchscreen only taps).
export async function touchDrag(page, from, to, steps = 12) {
  const cdp = await page.context().newCDPSession(page)
  const pt = (p) => [{ x: p[0], y: p[1], radiusX: 4, radiusY: 4, force: 1, id: 1 }]
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(from) })
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt([from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t]) })
    await sleep(16)
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await cdp.detach().catch(() => {})
}

// Every visible control at least 44 × 44 CSS px (contract §2.3); returns the violations.
export async function smallTargets(page) {
  return page.evaluate(() => {
    const out = []
    const vw = innerWidth, vh = innerHeight
    for (const el of document.querySelectorAll('button, [role="button"], a[href], input:not([type="hidden"]), select, textarea, [role="menuitem"], [role="option"], [role="tab"], [role="slider"], [role="switch"], [role="checkbox"], [data-midstudy]')) {
      if (el.disabled || el.closest('[hidden], [aria-hidden="true"], [inert]')) continue
      if (el.matches('input[type="file"]')) continue // opened by its visible button
      if (!el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue
      if (el.matches('[data-midstudy]') && !el.matches('button, [role], a[href], input, select, textarea, label') && getComputedStyle(el).cursor !== 'pointer') continue // a label or value, not a target
      let p = el, hidden = false
      while (p && p !== document.body) { const cs = getComputedStyle(p); if (cs.pointerEvents === 'none' || +cs.opacity === 0) { hidden = true; break } p = p.parentElement }
      if (hidden) continue
      const r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) continue
      let a = el.parentElement, clipped = false
      while (a && a !== document.body) {
        const cs = getComputedStyle(a)
        if (/(auto|scroll|hidden)/.test(cs.overflowY + cs.overflowX)) { const ar = a.getBoundingClientRect(); if (r.bottom <= ar.top || r.top >= ar.bottom || r.right <= ar.left || r.left >= ar.right) { clipped = true; break } }
        a = a.parentElement
      }
      if (clipped) continue
      let hw = r.width, hh = r.height
      for (const pseudo of ['::before', '::after']) {
        const ps = getComputedStyle(el, pseudo)
        if (ps.content === 'none' || ps.position !== 'absolute') continue
        const px = (v) => (v.endsWith('px') ? parseFloat(v) : 0)
        hw = Math.max(hw, r.width - px(ps.left) - px(ps.right))
        hh = Math.max(hh, r.height - px(ps.top) - px(ps.bottom))
      }
      const lab = el.matches('input, select, textarea') ? el.closest('label') : null
      if (lab) { const lr = lab.getBoundingClientRect(); hw = Math.max(hw, lr.width); hh = Math.max(hh, lr.height) }
      if (hw >= 43.5 && hh >= 43.5) continue
      const name = (el.dataset.midstudy || el.getAttribute('aria-label') || el.textContent || el.className || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 30)
      out.push(`${el.tagName.toLowerCase()} "${name}" ${Math.round(hw)}×${Math.round(hh)}`)
    }
    return out
  })
}
export const horizontalScroll = (page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, bodyScrollWidth: document.body.scrollWidth, innerWidth })).catch((e) => ({ error: String(e) }))

// Uploads a golden photo through the API and waits for its calibration; returns {name, scene, why}.
export async function seedScene(srv, id, title) {
  const bytes = fs.readFileSync(golden(id).photo)
  const r = await uploadScene(srv.base, bytes, { filename: `${id}.jpg`, title: title ?? id })
  if (r.status !== 202 || !r.json?.scene) return { name: null, why: `POST /api/scenes: ${r.status || r.error} ${clip(r.text, 200)}` }
  const scene = await waitScene(srv.base, r.json.scene)
  if (!scene) return { name: r.json.scene, why: 'calibration did not finish in 60 s' }
  return { name: r.json.scene, scene, why: scene.calib_status === 'done' ? '' : `calib_status ${scene.calib_status}: ${scene.calib_error}` }
}
// Writes a copy of a golden photo with a different JFIF density field: same pixels, different SHA-256, so the calib
// mock has no entry for it (default fallback, no depth) and the stub/real ingest still pass it through.
export function unknownPhoto(id = 'living-wide') {
  const b = Buffer.from(fs.readFileSync(golden(id).photo))
  if (b.readUInt16BE(2) !== 0xffe0 || b.toString('latin1', 6, 11) !== 'JFIF\0') throw new Error('golden photo has no JFIF APP0 segment')
  // APP0: FFE0, length, "JFIF\0" (6–10), version (11–12), units (13), X density (14–15), Y density (16–17)
  b.writeUInt16BE(b.readUInt16BE(14) === 72 ? 96 : 72, 14)
  b.writeUInt16BE(b.readUInt16BE(16) === 72 ? 96 : 72, 16)
  return b
}
