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
import { REPO, BROWSER, BROWSER_ARGS, PROBE, boxGlb, golden, api, clip, fmt, sleep, waitFor, openPlanner, seedScene, project, photoToFloor } from './harness.mjs'
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
// A poll ends on a 200 whose status is a string outside the in-progress ones (as harness.mjs's waitScene): a status added
// later ends it instead of running it to its timeout, and a body without one keeps it polling.
const JOB_IN_PROGRESS = ['pending', 'queued', 'running']
export async function waitJob(base, id, timeoutMs = 60000) {
  return waitFor(async () => {
    const r = await api.get(base, `/api/rooms/jobs/${id}`)
    if (r.status !== 200) throw new Error(`GET /api/rooms/jobs/${id} answered ${r.status} ${r.error ?? ''}`)
    const status = r.json?.status
    return typeof status === 'string' && !JOB_IN_PROGRESS.includes(status) ? r.json : null
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
  const q = new URLSearchParams()
  if (room) q.set('room', room)
  if (photo) q.set('photo', photo)
  if (!webgpu) q.set('webgpu', '0')
  return openPlanner(browser, base, { device, viewport, query: [q.toString(), query].filter(Boolean).join('&'), readyMs: 90000 })
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

// --- eval:real-room measurements -----------------------------------------------------------------------------------------------------
// A photo position (fractions of its width and height) → the room-frame floor point, through the member's effective
// camera (its scene.json camera with height_m × scale) and its pose; null for an unplaced photo or above the horizon.
export function uvToRoom(member, uv) {
  if (!member?.pose || !member.w) return null
  const cam = effectiveCamera(member.camera, member.scale ?? 1)
  const q = photoToFloor(cam, member.w, member.h, uv[0] * member.w, uv[1] * member.h)
  return q ? sceneToRoom(member.pose, q) : null
}
// measurements.json (evals/real_room.mjs) read through members {<photo file>: {pose, scale, camera, w, h}}: the scale
// segment's measured length, the walls' lines in the room frame, and each spot's distances to them per photo.
export function measureSpots(meas, members) {
  const a = uvToRoom(members[meas.scale.photo], meas.scale.a), b = uvToRoom(members[meas.scale.photo], meas.scale.b)
  const walls = Object.fromEntries(Object.entries(meas.walls).map(([name, pts]) => {
    const [p, q] = pts.map((pt) => uvToRoom(members[pt.photo], pt.uv))
    if (!p || !q) return [name, null]
    const L = Math.hypot(q[0] - p[0], q[2] - p[2])
    return [name, { p: p.map((v) => +v.toFixed(4)), n: [-(q[2] - p[2]) / L, 0, (q[0] - p[0]) / L].map((v) => +v.toFixed(5)) }]
  }))
  const spots = meas.spots.map((s) => {
    const rows = Object.entries(s.seen).map(([photo, uv]) => {
      const q = uvToRoom(members[photo], uv)
      const row = { photo, room: q && q.map((v) => +v.toFixed(3)) }
      for (const [wn, w] of Object.entries(walls)) row[wn] = q && w ? +Math.abs((q[0] - w.p[0]) * w.n[0] + (q[2] - w.p[2]) * w.n[2]).toFixed(4) : null
      row.err_cm = Math.max(...Object.keys(s.from).map((wn) => (row[wn] == null ? Infinity : Math.abs(row[wn] - s.from[wn]) * 100)))
      return row
    })
    const placed = rows.filter((x) => x.room)
    let spread = 0
    for (const p of placed) for (const q of placed) spread = Math.max(spread, Math.hypot(p.room[0] - q.room[0], p.room[2] - q.room[2]))
    return { name: s.name, from: s.from, rows, spread_cm: +(spread * 100).toFixed(1) }
  })
  return { scale_measured_m: a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : null, walls, spots }
}
// The golden room as eval:real-room input (its --golden self-check): copies of the seven photos, named in room order,
// and measurements.json from truth.json: the scale on two of living-wide's open-floor points, the back wall (from room-1's
// wall_check) and the left wall (room-4's) by two floor points each, and the table's four legs as spots.
export function goldenMeasurements(dir) {
  const photos = path.join(dir, 'photos')
  fs.mkdirSync(photos, { recursive: true })
  const G = ROOM_IDS.map((id, i) => { const g = golden(id); const file = `${i + 1}-${id}.jpg`; fs.copyFileSync(g.photo, path.join(photos, file)); return { id, file, g, pose: g.truth.pose_in_room || { x_m: 0, z_m: 0, yaw_deg: 0 } } })
  const uvOf = (m, pRoom) => {
    const { w: W, h: H } = m.g.truth.image
    const p = project(m.g.truth.camera, W, H, roomToScene(m.pose, pRoom))
    return p.d > 0.3 && p.px > 1 && p.px < W - 1 && p.py > 1 && p.py < H - 1 && photoToFloor(m.g.truth.camera, W, H, p.px, p.py) ? [p.px / W, p.py / H] : null
  }
  const wallLine = (id) => {
    const m = G.find((x) => x.id === id), w = m.g.truth.wall_check
    const p = sceneToRoom(m.pose, [w.point[0], 0, w.point[2]]), n = sceneToRoom({ ...m.pose, x_m: 0, z_m: 0 }, w.normal)
    return { p, n, dir: [-n[2], 0, n[0]] }
  }
  const walls = { back: wallLine('room-1'), left: wallLine('room-4') }
  const annotate = (pRoom) => { for (const m of G) { const uv = uvOf(m, pRoom); if (uv) return { photo: m.file, uv } } return null }
  const wallsOut = {}
  for (const [k, w] of Object.entries(walls)) {
    const pts = []
    for (const t of [-1.5, -1, -0.5, 0, 0.5, 1, 1.5]) { const a = annotate([w.p[0] + t * w.dir[0], 0, w.p[2] + t * w.dir[2]]); if (a) pts.push(a); if (pts.length === 2) break }
    wallsOut[k] = pts
  }
  const dist = (q, w) => Math.abs((q[0] - w.p[0]) * w.n[0] + (q[2] - w.p[2]) * w.n[2])
  const lwT = G[0].g.truth
  const spots = lwT.objects.table.parts.filter((p) => p.name.startsWith('leg')).map((leg) => {
    const q = [leg.center[0], 0, leg.center[2]]
    const seen = Object.fromEntries(G.map((m) => [m.file, uvOf(m, q)]).filter(([, uv]) => uv))
    return { name: `table ${leg.name}`, from: { back: +dist(q, walls.back).toFixed(4), left: +dist(q, walls.left).toFixed(4) }, seen }
  })
  const fa = lwT.floor_points[0], fb = lwT.floor_points.at(-1), W = lwT.image.w, H = lwT.image.h
  const meas = { scale: { photo: G[0].file, a: [fa.px[0] / W, fa.px[1] / H], b: [fb.px[0] / W, fb.px[1] / H], length_m: +Math.hypot(fa.world[0] - fb.world[0], fa.world[2] - fb.world[2]).toFixed(4) }, walls: wallsOut, spots }
  fs.writeFileSync(path.join(dir, 'measurements.json'), JSON.stringify(meas, null, 2))
  // The members as the truth has them (for the self-test): file → {pose, scale 1, camera, w, h}.
  const truthMembers = Object.fromEntries(G.map((m) => [m.file, { pose: m.pose, scale: 1, camera: m.g.truth.camera, w: m.g.truth.image.w, h: m.g.truth.image.h }]))
  return { photos, measurements: path.join(dir, 'measurements.json'), meas, truthMembers }
}
export { fmt }
