// Rooms helpers for E18–E20 and eval:real-room (contract §4.9, docs/ROOMS.md). Written from the contract and its schemas
// only: never from planner/, server/ or calib/ source. evals/lib/harness.mjs (foundation's) stays as it is; this file
// adds what rooms need on top of it:
// - the §4.9 frames in plain JS: Ry, room ↔ scene, rotation_y_deg, yaw into (−180, 180], the effective camera, the
//   server's way of applying an align answer through an anchor, the calib mock's re-expression and its key;
// - the golden room (living-wide + room-1 … room-6, truth.json pose_in_room) and the sofa's corners in every photo;
// - every /api answer checked against contract/api/routes.json with the generated validators (contract/gen/);
// - a guard on the repo's own rooms/ (harness.mjs guards scenes/, layouts/, renders/, library/);
// - a library with the probe box and a magenta "sofa probe" the size of the golden sofa (2.0 × 0.9 × 0.82 m);
// - the browser: a room page (?room=&photo=, and ?webgpu=0 for the WebGL2 fallback), a launcher for either backend.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { REPO, BROWSER, BROWSER_ARGS, PHONE, DESKTOP, PROBE, boxGlb, golden, api, clip, fmt, sleep, waitFor, seedScene } from './harness.mjs'
import { matchRoute, responseSchema } from '../../contract/gen/routes.js'
import { violation } from '../../contract/gen/validate.js'

export const ROOM_IDS = ['living-wide', 'room-1', 'room-2', 'room-3', 'room-4', 'room-5', 'room-6']
export const ROOM_NAME_RE = /^room-\d{8}-\d{6}(-\d+)?$/
export const ALIGN_JOB_RE = /^a-[0-9a-z-]+$/
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]00:?00)$/
export const SOFA_PROBE = { id: 'sofa-probe', name: 'Sofa probe', dims_cm: { w: 200, d: 90, h: 82 } }
export const TARGETS = { pos_cm: 5, yaw_deg: 1.5, scale_pct: 2 } // docs/ROOMS.md §5 Phase A targets

// --- numbers -----------------------------------------------------------------------------------------------------------------
const rad = (d) => (d * Math.PI) / 180
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
export const sha256File = (p) => sha256(fs.readFileSync(p))
// The calib mock's key (§4.9 Mock): SHA-256 of the members' photo SHA-256s, sorted, joined with "\n", no trailing newline.
export const mockKey = (shas) => sha256(Buffer.from([...shas].sort().join('\n'), 'utf8'))
// Into (−180, 180]: ((y + 180) mod 360) − 180, then −180 becomes 180.
export function normYaw(y) {
  let v = ((y + 180) % 360 + 360) % 360 - 180
  if (v <= -180) v = 180
  return v
}
export const yawDiff = (a, b) => Math.abs(normYaw(a - b))
export const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// Ry(a) = [[cos a, 0, sin a], [0, 1, 0], [−sin a, 0, cos a]] on (x, y, z)
export function ry(deg, p) {
  const c = Math.cos(rad(deg)), s = Math.sin(rad(deg))
  return [c * p[0] + s * p[2], p[1], -s * p[0] + c * p[2]]
}
export const sceneToRoom = (pose, p) => { const q = ry(pose.yaw_deg, p); return [q[0] + pose.x_m, q[1], q[2] + pose.z_m] }
export const roomToScene = (pose, p) => ry(-pose.yaw_deg, [p[0] - pose.x_m, p[1], p[2] - pose.z_m])
export const rotRoomToScene = (pose, r) => normYaw(r - pose.yaw_deg)
export const rotSceneToRoom = (pose, r) => normYaw(r + pose.yaw_deg)
// The effective camera: the scene's camera with height_m × scale, clamped to 0.2–3.0.
export const effectiveCamera = (cam, scale) => ({ ...cam, height_m: clamp(cam.height_m * scale, 0.2, 3.0) })
// The view direction of a member on the floor: Ry(yaw) · (0, 0, −1) = (−sin yaw, −cos yaw).
export const viewDir = (yaw) => [-Math.sin(rad(yaw)), -Math.cos(rad(yaw))]
// The clamps of every writer (§4.9 Ranges).
export const clampPose = (p) => ({ x_m: clamp(p.x_m, -50, 50), z_m: clamp(p.z_m, -50, 50), yaw_deg: normYaw(p.yaw_deg) })
export const clampScale = (s) => clamp(s, 0.25, 4)
// The server applies an answer pose P_k (relative to the anchor) with the anchor's room pose A and scale s_a (§4.9 Align):
// yaw = yaw_a + yaw_k, (x, z) = (x_a, z_a) + s_a · Ry(yaw_a) · (x_k, z_k), scale = s_a · s_k, then clamped.
export function applyAnchor(A, sa, P, sk) {
  const q = ry(A.yaw_deg, [P.x_m, 0, P.z_m])
  return { pose: clampPose({ x_m: A.x_m + sa * q[0], z_m: A.z_m + sa * q[2], yaw_deg: A.yaw_deg + P.yaw_deg }), scale: clampScale(sa * sk) }
}
// The mock re-expresses an answer relative to the first argument a (§4.9 Mock):
// yaw'_k = yaw_k − yaw_a, (x'_k, z'_k) = Ry(−yaw_a) · ((x_k, z_k) − (x_a, z_a)) / s_a, s'_k = s_k / s_a.
export function reexpress(a, sa, k, sk) {
  const q = ry(-a.yaw_deg, [k.x_m - a.x_m, 0, k.z_m - a.z_m])
  return { pose: { x_m: q[0] / sa, z_m: q[2] / sa, yaw_deg: normYaw(k.yaw_deg - a.yaw_deg) }, scale: sk / sa }
}
export const poseErr = (p, q) => (p && q ? { pos_m: Math.hypot(p.x_m - q.x_m, p.z_m - q.z_m), yaw_deg: yawDiff(p.yaw_deg, q.yaw_deg) } : { pos_m: Infinity, yaw_deg: Infinity })
export const poseEq = (p, q, tolM = 1e-6, tolDeg = 1e-6) => { const e = poseErr(p, q); return e.pos_m <= tolM && e.yaw_deg <= tolDeg }
export const r6 = (p) => (p ? { x_m: +p.x_m.toFixed(4), z_m: +p.z_m.toFixed(4), yaw_deg: +p.yaw_deg.toFixed(3) } : p)

// The 8 corners of an item's box (item frame: footprint center on the floor, width X, depth Z, front +Z), in the order of
// truth.json's corner_names: bottom then top; back-left, back-right, front-right, front-left.
export function boxCornersOriented(center, size, rotDeg) {
  const { w, d, h } = size
  const ring = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]
  const out = []
  for (const y of [0, h]) for (const [x, z] of ring) { const q = ry(rotDeg, [x, 0, z]); out.push([center[0] + q[0], center[1] + y, center[2] + q[2]]) }
  return out
}
export const rectOf = (pts) => {
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
export const rectDiff = (a, b) => (a && b ? Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y), Math.abs(a.x + a.w - b.x - b.w), Math.abs(a.y + a.h - b.y - b.h)) : Infinity)

// --- the golden room -----------------------------------------------------------------------------------------------------------
// Every photo of the golden room with its truth; pose_in_room is null for living-wide (the room frame).
export function goldenRoom(ids = ROOM_IDS) {
  return ids.map((id) => {
    const g = golden(id)
    const pose = g.truth.pose_in_room || { x_m: 0, z_m: 0, yaw_deg: 0 }
    return { ...g, pose, sha: sha256File(g.photo), W: g.truth.image.w, H: g.truth.image.h, cam: g.truth.camera }
  })
}
// The golden sofa in the room frame (living-wide's frame is the room frame): center, size and rotation.
export function roomSofa() {
  const s = golden('living-wide').truth.objects.sofa
  return { center: s.center, size: { w: s.size_m.w, d: s.size_m.d, h: s.size_m.h }, rotation_y_deg: s.rotation_y_deg }
}
// Is every truth sofa corner of this photo in front of the camera and inside the photo (so its rect is unambiguous)?
export function sofaFullyInPhoto(m) {
  const o = m.truth.objects.sofa
  if (!o?.corner_px) return false
  return o.corner_px.every((c) => c && Number.isFinite(c[0]) && c[0] >= 0 && c[0] <= m.W && c[1] >= 0 && c[1] <= m.H)
}

// --- the contract ----------------------------------------------------------------------------------------------------------------
// The first way an /api answer breaks contract/api/routes.json, or '' when it conforms (or isn't an /api route).
export function apiViolation(method, p, res) {
  const m = matchRoute(method, p)
  if (!m) return `no route in routes.json for ${method} ${p}`
  const uri = responseSchema(m.route, res.status)
  if (!uri) return `status ${res.status} is not one routes.json lists for ${method} ${m.route.path}`
  if (res.json === null) return `the ${res.status} answer is not JSON: ${clip(res.text, 80)}`
  const v = violation(uri, res.json)
  return v ? `${v.schema} ${v.path} ${v.message}` : ''
}
export const fileViolation = (uri, data) => { const v = violation(uri, data); return v ? `${v.schema} ${v.path} ${v.message}` : '' }
// A client that records every answer's contract violation (strict mode on our side too).
export function contractClient(base) {
  const seen = [], fiveXX = []
  const wrap = async (method, p, res) => {
    if (res.status >= 500) fiveXX.push(`${method} ${p} → ${res.status} ${clip(res.text, 160)}`)
    if (res.status) { const v = apiViolation(method, p, res); if (v) seen.push(`${method} ${p} → ${res.status}: ${v}`) }
    return res
  }
  return {
    violations: seen, fiveXX,
    get: async (p, o) => wrap('GET', p, await api.get(base, p, o)),
    send: async (method, p, body, o) => wrap(method, p, await api.send(base, method, p, body, o)),
  }
}

// --- the repo's own rooms/ ------------------------------------------------------------------------------------------------------
export function roomsGuard() {
  const root = path.join(REPO, 'rooms')
  const snap = () => {
    const m = new Map()
    const walk = (p) => {
      let st
      try { st = fs.lstatSync(p) } catch { return }
      if (st.isDirectory()) { for (const c of fs.readdirSync(p)) walk(path.join(p, c)) } else m.set(path.relative(REPO, p), `${st.size}:${st.mtimeMs}`)
    }
    walk(root)
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
// Registers the rooms/ guard as a check at the end of the eval.
export function guardRooms(ev) {
  const g = roomsGuard()
  ev.onCleanup(() => { const d = g(); ev.check("the repo's own rooms/ was not touched", d.length === 0, d.length ? d.slice(0, 8).join(', ') : 'unchanged') })
}

// --- library --------------------------------------------------------------------------------------------------------------------
// The probe box (harness.mjs) and the sofa probe: magenta, unlit boxes whose silhouettes are their bounding boxes.
export function writeRoomLibrary(dir) {
  const items = []
  for (const it of [PROBE, SOFA_PROBE]) {
    const { w, d, h } = it.dims_cm
    fs.mkdirSync(path.join(dir, it.id), { recursive: true })
    fs.writeFileSync(path.join(dir, it.id, 'model.glb'), boxGlb(w / 100, h / 100, d / 100))
    items.push({
      id: it.id, name: it.name, category: 'test', dims_cm: { w, d, h },
      assets: { glb: `${it.id}/model.glb`, splat: null, thumb: null }, default_render: 'glb',
      source: { engine: 'fixture', input: 'generated by evals/lib/rooms.mjs', prompt: null, cost_usd: 0, mock: false, created: '2026-11-06T00:00:00Z' },
      notes: 'Eval probe: magenta unlit box, exact bounds.',
    })
  }
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 1, items }, null, 2))
}

// --- server helpers -----------------------------------------------------------------------------------------------------------
// Uploads golden photos one at a time and waits for each calibration (stub + mock: the true camera and depth).
export async function seedGoldenScenes(srv, ids) {
  const out = {}
  for (const id of ids) out[id] = await seedScene(srv, id, id)
  return out
}
export async function waitAlignDone(base, room, timeoutMs = 60000) {
  return waitFor(async () => {
    const r = await api.get(base, `/api/rooms/${room}`)
    return r.status === 200 && ['done', 'failed', 'none'].includes(r.json?.align_status) ? r.json : null
  }, { timeoutMs, intervalMs: 250 })
}
export async function waitJob(base, id, timeoutMs = 60000) {
  return waitFor(async () => {
    const r = await api.get(base, `/api/rooms/jobs/${id}`)
    return r.status === 200 && ['done', 'failed'].includes(r.json?.status) ? r.json : null
  }, { timeoutMs, intervalMs: 200 })
}
export const memberOf = (detail, scene) => detail?.members?.find((m) => m.scene === scene) || null

// --- browser --------------------------------------------------------------------------------------------------------------------
// BROWSER_ARGS without the WebGPU flags: the WebGL2 fallback (as MIDSTUDY_WEBGPU=0 does for the harness).
export const WEBGL_ARGS = BROWSER_ARGS.filter((a) => !/webgpu/i.test(a))
export async function launchBackend(ev, { webgpu = true } = {}) {
  const { chromium } = await import('playwright-core')
  const args = webgpu ? (BROWSER_ARGS.some((a) => /webgpu/.test(a)) ? BROWSER_ARGS : [...BROWSER_ARGS, '--enable-unsafe-webgpu', '--use-webgpu-adapter=swiftshader']) : WEBGL_ARGS
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true, args })
  ev.onCleanup(() => browser.close())
  return browser
}
// openPlanner (harness.mjs) for a room: ?room=<room>[&photo=<scene>][&webgpu=0]. Returns {page, context, errors, hookOk, why, url}.
export async function openRoomPage(browser, base, { room = null, photo = null, device = 'desktop', viewport = null, webgpu = true, query = '' } = {}) {
  const ctxOpts = device === 'phone' ? { ...PHONE, ...(viewport ? { viewport } : {}) } : { ...DESKTOP, ...(viewport ? { viewport } : {}) }
  const context = await browser.newContext(ctxOpts)
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  const errors = { page: [], console: [], refused: [] }
  page.on('console', (m) => { if (m.type() === 'error') errors.console.push(clip(`${m.text()} ${m.location()?.url || ''}`, 300)) })
  page.on('pageerror', (e) => errors.page.push(clip(e.stack || String(e), 500)))
  page.on('response', (r) => { if (r.status() === 403) errors.refused.push(`${r.request().method()} ${r.url()}`) })
  page.on('dialog', (d) => d.accept(d.type() === 'prompt' ? 'eval-layout' : undefined).catch(() => {}))
  await page.addInitScript(() => addEventListener('DOMContentLoaded', () => {
    const s = document.createElement('style')
    s.textContent = '*,*::before,*::after{animation-duration:0s!important;transition-duration:0s!important;animation-delay:0s!important;transition-delay:0s!important}'
    document.head.append(s)
  }))
  const q = new URLSearchParams()
  if (room) q.set('room', room)
  if (photo) q.set('photo', photo)
  if (!webgpu) q.set('webgpu', '0')
  const qs = [q.toString(), query].filter(Boolean).join('&')
  const url = `${base}/planner/${qs ? `?${qs}` : ''}`
  let why = ''
  try { await page.goto(url, { waitUntil: 'load', timeout: 30000 }) } catch (e) { why = `page load failed: ${String(e).split('\n')[0]}` }
  const ok = !why && await page.waitForFunction(() => !!window.midstudy, null, { timeout: 30000 }).then(() => true, () => false)
  if (!ok && !why) why = `hook missing: window.midstudy${errors.page.length || errors.console.length ? ` (page errors: ${clip([...errors.page, ...errors.console].slice(0, 3).join(' | '), 400)})` : ''}`
  let ready = ''
  if (ok) ready = await page.evaluate(() => Promise.race([Promise.resolve(window.midstudy.ready).then(() => ''), new Promise((r) => setTimeout(() => r('window.midstudy.ready did not resolve in 90 s'), 90000))]).catch((e) => `window.midstudy.ready rejected: ${e}`))
  return { page, context, errors, hookOk: ok && !ready, why: why || ready, url }
}
// Waits until the room view shows this photo (getState().room.photo and getState().scene.name), then a short settle.
export async function waitPhoto(page, scene, timeoutMs = 30000) {
  const ok = await page.waitForFunction((scene) => {
    try { const s = window.midstudy?.getState?.(); return s?.room?.photo === scene && s?.scene?.name === scene } catch { return false }
  }, scene, { timeout: timeoutMs }).then(() => true, () => false)
  if (ok) await sleep(400)
  return ok
}
export const roomState = async (page) => page.evaluate(() => { try { return JSON.parse(JSON.stringify(window.midstudy?.getState?.() ?? null)) } catch (e) { return { error: String(e) } } }).catch((e) => ({ error: String(e) }))
export const fmtPose = (p) => (p ? `(${p.x_m.toFixed(3)}, ${p.z_m.toFixed(3)}, ${p.yaw_deg.toFixed(2)}°)` : 'null')
export { fmt }
