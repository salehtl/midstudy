// v1's pure functions from planner/engine.js (v1 at 0d40ff5), lifted verbatim: the reference for the differential
// tests (../diff.mjs). Each `// <<v1 …` … `// v1>>` block is v1's own text, around hand-written harnesses that supply
// the state v1 keeps; frozen since the v2 cutover (planner/*.js is gone; lift.py and v1-sync.mjs are in git history).
// makeV1() supplies the module state v1 keeps around them (the camera block, the photo size, R, the view, the items),
// set up as v1's applyCamera() does, with stubs for the parts that need a page (lights, toasts, the mesh raycast).
import * as THREE from 'three'

// <<v1 planner/engine.js:77-77
const DEG = Math.PI / 180
// v1>>
// <<v1 planner/engine.js:83-83
export const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n
// v1>>
// <<v1 planner/engine.js:85-85
export const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
// v1>>
// <<v1 planner/engine.js:88-88
export const wrapDeg = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x }
// v1>>
// <<v1 planner/engine.js:96-98
export const MAX_ELEVATION = 4 // m (§2.10)
const clampElev = (y) => Math.min(MAX_ELEVATION, Math.max(0, y))
const clampNum = (v, lo, hi, dflt) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : dflt)
// v1>>
// <<v1 planner/engine.js:101-108
export const CAMERA_RANGE = { fov_y_deg: [20, 110], height_m: [0.2, 3.0], pitch_deg: [-80, 30], roll_deg: [-20, 20] }
export const DEFAULT_CAMERA = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }
export function clampCamera(c, base = DEFAULT_CAMERA) {
  const out = {}
  for (const [k, [lo, hi]] of Object.entries(CAMERA_RANGE)) out[k] = round(clampNum(c?.[k], lo, hi, base[k]), 6)
  return out
}
const sameCamera = (a, b) => !!a && !!b && Object.keys(CAMERA_RANGE).every((k) => Math.abs(a[k] - b[k]) < 1e-6)
// v1>>
// <<v1 planner/engine.js:113-123
const LOOK_NUM = { exposure: [0.25, 4, 1], warmth: [-1, 1, 0], light_azimuth_deg: [-180, 180, null], light_elevation_deg: [5, 90, null], light_softness: [0, 1, null], light_strength: [0, 3, 1], ambient: [0, 3, 1] }
const LOOK_BOOL = { contact_shadows: true, auto_light: true, cast_shadows: null }
const LOOK_KEYS = [...Object.keys(LOOK_NUM), ...Object.keys(LOOK_BOOL)]
const wrapAz = (a) => { const w = ((((a + 180) % 360) + 360) % 360) - 180; return w === -180 && a > 0 ? 180 : w }
function lookFrom(l) {
  const src = l && typeof l === 'object' ? l : {}
  const out = {}
  for (const [k, [lo, hi, d]] of Object.entries(LOOK_NUM)) out[k] = isNum(src[k]) ? Math.min(hi, Math.max(lo, k === 'light_azimuth_deg' ? wrapAz(src[k]) : src[k])) : d
  for (const [k, d] of Object.entries(LOOK_BOOL)) out[k] = typeof src[k] === 'boolean' ? src[k] : d
  return out
}
// v1>>
// <<v1 planner/engine.js:1125-1151
function convexHull(ps) {
  const p = ps.map((q) => [q.x, q.y]).sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return p
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lo = [], hi = []
  for (const q of p) { while (lo.length >= 2 && cross(lo.at(-2), lo.at(-1), q) <= 0) lo.pop(); lo.push(q) }
  for (const q of [...p].reverse()) { while (hi.length >= 2 && cross(hi.at(-2), hi.at(-1), q) <= 0) hi.pop(); hi.push(q) }
  return lo.slice(0, -1).concat(hi.slice(0, -1))
}
function pointInHull(h, x, y) {
  if (h.length < 3) return false
  for (let i = 0; i < h.length; i++) {
    const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length]
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) return false
  }
  return true
}
function distToHull(h, x, y) {
  let best = Infinity
  for (let i = 0; i < h.length; i++) {
    const [ax, ay] = h[i], [bx, by] = h[(i + 1) % h.length]
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy
    const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy))
  }
  return best
}
// v1>>
// <<v1 planner/engine.js:2186-2203
function dilate(src, w, h, left, right, up, down) {
  const a = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const row = y * w
    let last = -1e9
    for (let x = 0; x < w; x++) { if (src[row + x]) last = x; if (x - last <= right) a[row + x] = 1 }
    last = 1e9
    for (let x = w - 1; x >= 0; x--) { if (src[row + x]) last = x; if (last - x <= left) a[row + x] = 1 }
  }
  const b = new Uint8Array(w * h)
  for (let x = 0; x < w; x++) {
    let last = -1e9
    for (let y = 0; y < h; y++) { if (a[y * w + x]) last = y; if (y - last <= down) b[y * w + x] = 1 }
    last = 1e9
    for (let y = h - 1; y >= 0; y--) { if (a[y * w + x]) last = y; if (last - y <= up) b[y * w + x] = 1 }
  }
  return b
}
// v1>>
// <<v1 planner/engine.js:1907-1910
function warmthTint(w) {
  const t = new THREE.Vector3(1 + 0.14 * w, 1 + 0.015 * w, 1 - 0.14 * w)
  return t.multiplyScalar(1 / (0.2126 * t.x + 0.7152 * t.y + 0.0722 * t.z))
}
// v1>>

export { DEG, clampElev, clampNum, sameCamera, LOOK_NUM, LOOK_BOOL, wrapAz, lookFrom, convexHull, pointInHull, distToHull, dilate, warmthTint }

// The keep-room mask after the render (captureMask): the readback to a dilated 0/1 mask, and its coverage.
export function maskFromPixels(pixels, w, h) {
  // <<v1 planner/engine.js:2166-2173
  // binary, top-down rows
  let on = new Uint8Array(w * h)
  for (let y = 0; y < h; y++) {
    const src = (h - 1 - y) * w * 4
    for (let x = 0; x < w; x++) on[y * w + x] = pixels[src + x * 4] > 127 ? 1 : 0
  }
  const r = Math.max(1, Math.round(0.03 * w))
  on = dilate(on, w, h, r, r, r, 2 * r)
// v1>>
  let count = 0
  for (let i = 0; i < w * h; i++) count += on[i]
  return { on, coverage: count / (w * h) }
}

export function makeV1({ camera: camIn, w, h, view = { s: 1, ox: 0, oy: 0 }, visible = null, calib = null }) {
  // --- v1's module state, as applyCamera() and the view leave it ---
  let cam = { ...camIn }
  const photo = { w, h }
  const camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.05, 200)
  camera.rotation.order = 'YXZ'
  const R = new THREE.Matrix3()
  function applyCamera() {
    camera.fov = cam.fov_y_deg
    camera.position.set(0, cam.height_m, 0)
    camera.rotation.set(cam.pitch_deg * DEG, 0, cam.roll_deg * DEG, 'YXZ')
    camera.updateMatrixWorld(true)
    R.setFromMatrix4(camera.matrixWorld)
  }
  applyCamera()
  const viewParams = () => ({ s: view.s, ox: view.ox, oy: view.oy })
  const visiblePhotoRect = () => visible
  const sceneData = calib ? { calib } : null
  const scene = new THREE.Scene()
  const items = new Map()
  const emitted = []
  const emit = (name, detail = {}) => { emitted.push([name, detail]) }
  const reportError = (msg) => new Error(msg)
  const syncShadow = () => {}
  let lastSet = null // the last partial v1 passed to setCamera (e.g. setPitchFromHorizon's raw pitch)
  const setCamera = (partial) => {
    lastSet = { ...partial }
    const next = clampCamera({ ...cam, ...Object.fromEntries(Object.entries(partial).filter(([k, v]) => k in CAMERA_RANGE && isNum(v))) }, cam)
    if (sameCamera(next, cam)) return
    cam = next
    applyCamera()
  }
  let grab = null // what v1's grabPointOn returns (it raycasts the piece's mesh): set by the test
  function grabPointOn() { return grab ? new THREE.Vector3(...grab) : null }
  const fetchBytes = async (bytes) => bytes

  // <<v1 planner/engine.js:394-398
function depthScale() {
  const c = sceneData?.calib
  const h0 = c?.floor?.found && (c.source === 'moge-2' || c.source === 'truth') ? Number(c.camera?.height_m) : NaN
  return h0 > 0 ? cam.height_m / h0 : 1
}
// v1>>
  // <<v1 planner/engine.js:437-444
function clientToPhoto(x, y) {
  const { s, ox, oy } = viewParams()
  return [(x - ox) / s, (y - oy) / s]
}
function photoToClient(px, py) {
  const { s, ox, oy } = viewParams()
  return [ox + s * px, oy + s * py]
}
// v1>>
  // <<v1 planner/engine.js:491-541
const focalPx = () => (photo.h / 2) / Math.tan((cam.fov_y_deg * DEG) / 2)
const tmpV = new THREE.Vector3()
// World point → [px, py, d] in photo px; d = depth along the view axis (> 0 in front).
function projectPhoto(p) {
  tmpV.set(p[0] ?? p.x, (p[1] ?? p.y) - cam.height_m, p[2] ?? p.z)
  const e = R.elements // column-major; Rᵀ·v
  const xc = e[0] * tmpV.x + e[1] * tmpV.y + e[2] * tmpV.z
  const yc = e[3] * tmpV.x + e[4] * tmpV.y + e[5] * tmpV.z
  const zc = e[6] * tmpV.x + e[7] * tmpV.y + e[8] * tmpV.z
  const d = -zc
  const f = focalPx()
  return [photo.w / 2 + (f * xc) / d, photo.h / 2 - (f * yc) / d, d]
}
// The world ray through a photo pixel: { origin, dir } (dir normalized).
function photoRay(px, py) {
  const f = focalPx()
  const dir = new THREE.Vector3((px - photo.w / 2) / f, -(py - photo.h / 2) / f, -1).applyMatrix3(R).normalize()
  return { origin: new THREE.Vector3(0, cam.height_m, 0), dir }
}
function photoToFloor(px, py) {
  if (!isNum(px) || !isNum(py)) return null
  const { origin, dir } = photoRay(px, py)
  if (dir.y >= -1e-9) return null
  const t = -origin.y / dir.y
  return [origin.x + t * dir.x, 0, origin.z + t * dir.z]
}
function floorToPhoto(p) {
  const [px, py] = projectPhoto(p)
  return [px, py]
}
// Client px of a world point; visible is false behind the camera.
function worldToScreen(p) {
  const [px, py, d] = projectPhoto(Array.isArray(p) ? p : [p.x, p.y, p.z])
  const [x, y] = photoToClient(px, py)
  return { x, y, visible: d > 1e-4 }
}
// The horizon (where the floor plane vanishes) at photo column px: the row py, or null when it's vertical.
function horizonAt(px) {
  // sin(roll)·x_c + cos(roll)·y_c = −tan(pitch), x_c = (px − W/2)/f, y_c = −(py − H/2)/f
  const f = focalPx(), sr = Math.sin(cam.roll_deg * DEG), cr = Math.cos(cam.roll_deg * DEG), tp = Math.tan(cam.pitch_deg * DEG)
  if (Math.abs(cr) < 1e-6) return null
  const yc = (-tp - sr * ((px - photo.w / 2) / f)) / cr
  return photo.h / 2 - yc * f
}
// Dragging the horizon line: its middle (at the photo's centre column) to row py sets the pitch.
function setPitchFromHorizon(py) {
  if (!isNum(py)) return
  const f = focalPx(), cr = Math.cos(cam.roll_deg * DEG)
  const yc = -(py - photo.h / 2) / f
  setCamera({ pitch_deg: -Math.atan(cr * yc) / DEG })
}
// v1>>
  // <<v1 planner/engine.js:544-567
const raycaster = new THREE.Raycaster()
function setRay(clientX, clientY) {
  scene.updateMatrixWorld()
  const [px, py] = clientToPhoto(clientX, clientY)
  const { origin, dir } = photoRay(px, py)
  raycaster.ray.set(origin, dir)
  raycaster.camera = camera
}
function uidOf(obj) {
  for (let o = obj; o; o = o.parent) if (o.userData?.uid) return o.userData.uid
  return null
}
function hitItems() {
  const hits = raycaster.intersectObjects([...items.values()].map((r) => r.group), true)
  for (const h of hits) { const uid = uidOf(h.object); if (uid && h.object.name !== 'contact-shadow') return { uid, point: h.point.clone(), distance: h.distance } }
  return null
}
function planePointAt(plane, clientX, clientY) {
  setRay(clientX, clientY)
  const p = raycaster.ray.intersectPlane(plane, new THREE.Vector3())
  return p && p.distanceTo(raycaster.ray.origin) < 60 ? p : null
}
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
const floorPointAt = (x, y) => planePointAt(floorPlane, x, y)
// v1>>
  // <<v1 planner/engine.js:949-970
function landingSpot() {
  const v = visiblePhotoRect()
  let base = null
  for (const fy of [0.5, 5 / 6]) {
    const [px, py] = clientToPhoto(v.x + v.w / 2, v.y + v.h * fy)
    const p = photoToFloor(px, py)
    if (!p) continue
    const dist = Math.hypot(p[0], cam.height_m, p[2])
    if (dist >= 1 && dist <= 6) { base = p; break }
  }
  if (!base) base = [0, 0, -2.5]
  const taken = [...items.values()].map((r) => new THREE.Vector2(r.group.position.x, r.group.position.z))
  const step = 0.6
  for (let ring = 0; ring < 6; ring++) {
    for (let k = 0; k < Math.max(1, ring * 8); k++) {
      const a = (k / Math.max(1, ring * 8)) * Math.PI * 2
      const p = new THREE.Vector2(base[0] + Math.cos(a) * ring * step, base[2] + Math.sin(a) * ring * step)
      if (p.y < -0.6 && taken.every((q) => q.distanceTo(p) > 0.45)) return [round(p.x, 6), 0, round(p.y, 6)]
    }
  }
  return [round(base[0], 6), 0, round(base[2], 6)]
}
// v1>>
  // <<v1 planner/engine.js:1015-1031
function moveItemInternal(uid, opts = {}) {
  const rec = items.get(uid)
  if (!rec) { reportError(`moveItem: no placed item "${uid}"`); return }
  opts = opts || {}
  if (Array.isArray(opts.position)) {
    if (isNum(opts.position[0])) rec.group.position.x = opts.position[0]
    if (isNum(opts.position[1])) rec.group.position.y = clampElev(opts.position[1])
    if (isNum(opts.position[2])) rec.group.position.z = opts.position[2]
  }
  if (isNum(opts.rotation_y_deg)) {
    rec.rotationDeg = opts.rotation_y_deg
    rec.group.rotation.set(0, opts.rotation_y_deg * DEG, 0)
  }
  rec.group.updateMatrixWorld(true)
  syncShadow(rec)
  emit('items', { change: 'move', uid })
}
// v1>>
  // <<v1 planner/engine.js:1044-1047
function rotateSelected(deg) {
  const rec = selected && items.get(selected)
  if (rec) moveItemInternal(rec.uid, { rotation_y_deg: round(wrapDeg(rec.rotationDeg + deg), 6) })
}
// v1>>
  // <<v1 planner/engine.js:1063-1091
function worldBounds(rec) {
  rec.group.updateMatrixWorld(true)
  return rec.localBox.clone().applyMatrix4(rec.group.matrixWorld)
}
function itemInfo(r) {
  return {
    uid: r.uid, id: r.id, name: r.lib.name || r.id, lib: r.lib, render: r.render,
    position: [r.group.position.x, r.group.position.y, r.group.position.z], rotation_y_deg: r.rotationDeg,
    missing: !!r.missing, noGlb: !!r.noGlb,
  }
}
// The 8 corners of the item's box in world space (its own frame, turned with it).
function boxCorners(rec) {
  rec.group.updateMatrixWorld(true)
  const { min, max } = rec.localBox
  const out = []
  for (const y of [min.y, max.y]) for (const [x, z] of [[min.x, min.z], [max.x, min.z], [max.x, max.z], [min.x, max.z]]) out.push(new THREE.Vector3(x, y, z).applyMatrix4(rec.group.matrixWorld))
  return out
}
// §4.6 getScreenRect: the item's projected bounds in photo px (its box's 8 corners; corners behind the camera ignored).
function getScreenRect(uid) {
  const rec = items.get(uid)
  if (!rec?.localBox) return null
  const pts = boxCorners(rec).map((p) => projectPhoto(p)).filter((p) => p[2] > 1e-4)
  if (!pts.length) return null
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1])
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }
}
// v1>>
  // <<v1 planner/engine.js:1094-1124
let selected = null
let snap = false // Shift on desktop: lift drags, 15° grip
const drag = { mode: null, uid: null, off: new THREE.Vector3(), a0: 0, rot0: 0, plane: new THREE.Plane() }
function select(uid) {
  const next = uid && items.has(uid) ? uid : null
  if (drag.mode && drag.uid !== next) endItemDrag()
  selected = next
  emit('selection', { uid: selected })
}
function setSnap(on) { snap = !!on }
// Footprint corners [front-left, front-right, back-right, back-left] on the floor (front faces +Z), centre, box, height.
function getFootprint(uid) {
  const rec = items.get(uid)
  if (!rec?.localBox) return null
  rec.group.updateMatrixWorld(true)
  const { min, max } = rec.localBox
  const m = rec.group.matrixWorld
  const pt = (x, y, z) => new THREE.Vector3(x, y, z).applyMatrix4(m)
  const floor = [[min.x, max.z], [max.x, max.z], [max.x, min.z], [min.x, min.z]].map(([x, z]) => pt(x, 0, z))
  const box = boxCorners(rec)
  const center = floor.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(0.25)
  return { corners: floor.map((v) => v.toArray()), center: center.toArray(), box: box.map((v) => v.toArray()), height: max.y }
}
function hitItemAt(uid, clientX, clientY, pad = 16) {
  const f = getFootprint(uid)
  if (!f) return false
  const pts = f.box.map((p) => worldToScreen(p))
  if (pts.some((p) => !p.visible)) { setRay(clientX, clientY); return hitItems()?.uid === uid }
  const hull = convexHull(pts)
  return pointInHull(hull, clientX, clientY) || distToHull(hull, clientX, clientY) <= pad
}
// v1>>
  // <<v1 planner/engine.js:1162-1229
function dragHeight(rec, clientX, clientY) {
  const b = worldBounds(rec)
  const p = grabPointOn(rec, clientX, clientY)
  let y = p ? p.y : (b.min.y + b.max.y) / 2 // grabbed beside the piece (the touch pad): its middle
  y = Math.max(b.min.y, Math.min(b.max.y, y))
  const eye = cam.height_m
  if (Math.abs(y - eye) < 0.15) y = eye - 0.15 >= b.min.y ? eye - 0.15 : Math.min(b.max.y, eye + 0.15)
  return y
}
// Drag to move: the grabbed point of the piece stays under the finger: the piece slides on the horizontal plane
// through that point (its elevation doesn't change), so farther away it shrinks with perspective, closer it grows.
// With `lift` (Shift) it moves up and down only.
function beginItemDrag(uid, clientX, clientY, { lift = snap } = {}) {
  const rec = items.get(uid)
  if (!rec) return false
  let mode = 'move'
  const plane = new THREE.Plane()
  if (lift) {
    mode = 'lift'
    const n = new THREE.Vector3(-rec.group.position.x, 0, -rec.group.position.z) // faces the camera (at x = z = 0)
    if (n.lengthSq() < 1e-6) n.set(0, 0, 1)
    plane.setFromNormalAndCoplanarPoint(n.normalize(), rec.group.position)
  } else plane.set(new THREE.Vector3(0, 1, 0), -dragHeight(rec, clientX, clientY))
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  if (selected !== uid) select(uid)
  Object.assign(drag, { mode, uid, off: rec.group.position.clone().sub(p) })
  drag.plane.copy(plane)
  emit('drag', { mode, uid, phase: 'start' })
  return true
}
function beginRotateDrag(uid, clientX, clientY) {
  const rec = items.get(uid)
  if (!rec) return false
  const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -rec.group.position.y)
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  const c = rec.group.position
  Object.assign(drag, { mode: 'rotate', uid, a0: Math.atan2(p.x - c.x, p.z - c.z), rot0: rec.rotationDeg })
  drag.plane.copy(plane)
  emit('drag', { mode: 'rotate', uid, phase: 'start' })
  return true
}
function dragTo(clientX, clientY, { snapTo = false } = {}) {
  const rec = drag.mode && items.get(drag.uid)
  if (!rec) return
  const p = planePointAt(drag.plane, clientX, clientY)
  if (!p) return
  const g = rec.group.position
  if (drag.mode === 'move') {
    moveItemInternal(drag.uid, { position: [round(p.x + drag.off.x, 6), g.y, round(p.z + drag.off.z, 6)] })
  } else if (drag.mode === 'lift') {
    let y = clampElev(p.y + drag.off.y)
    if (snap) y = Math.round(y / 0.01) * 0.01
    moveItemInternal(drag.uid, { position: [g.x, round(y, 6), g.z] })
  } else {
    let deg = drag.rot0 + (Math.atan2(p.x - g.x, p.z - g.z) - drag.a0) / DEG
    if (snapTo || snap) deg = Math.round(deg / 15) * 15
    moveItemInternal(drag.uid, { rotation_y_deg: round(wrapDeg(deg), 6) })
  }
}
function endItemDrag() {
  if (!drag.mode) return
  const d = { mode: drag.mode, uid: drag.uid }
  drag.mode = null
  drag.uid = null
  emit('drag', { ...d, phase: 'end' })
}
// v1>>
  // <<v1 planner/engine.js:1244-1271
const ruler = { active: false, points: [] }
function getRuler() {
  const [a, b] = ruler.points
  return { active: ruler.active, points: ruler.points.map((p) => p.slice()), meters: a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : null }
}
function setRulerActive(on) {
  ruler.active = !!on
  if (!on) ruler.points = []
  else select(null)
  emit('ruler', getRuler())
}
function clearRuler() { ruler.points = []; emit('ruler', getRuler()) }
// The ruler measured a known length (a rug, a tile, a sofa's width): scale the camera height so it reads `meters`.
// Every floor point under a pixel scales with the height (the angles don't change), so this fixes the scene's scale,
// and with it the size every piece is drawn at, from one length the user knows (MoGe's metric scale is often off by
// 5–15 %). The ruler's points move with the floor and keep their place in the photo.
function setRulerTrueLength(meters) {
  const r = getRuler()
  if (!isNum(meters) || meters <= 0 || !r.meters || r.meters < 1e-3) return false
  const k = meters / r.meters
  const [lo, hi] = CAMERA_RANGE.height_m
  const h = Math.min(hi, Math.max(lo, cam.height_m * k))
  const kk = h / cam.height_m
  ruler.points = ruler.points.map((p) => [p[0] * kk, 0, p[2] * kk])
  setCamera({ height_m: h })
  emit('ruler', getRuler())
  return Math.abs(kk - k) < 1e-9
}
// v1>>
  // <<v1 planner/engine.js:1401-1442
async function loadDepth(url) {
  const bytes = await fetchBytes(url)
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!sig.every((v, i) => bytes[i] === v)) throw new Error('depth.png is not a PNG')
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat = []
  for (let o = 8; o + 8 <= bytes.length;) {
    const n = dv.getUint32(o)
    const type = String.fromCharCode(bytes[o + 4], bytes[o + 5], bytes[o + 6], bytes[o + 7])
    const data = bytes.subarray(o + 8, o + 8 + n)
    if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); bitDepth = data[8]; colorType = data[9]; interlace = data[12] }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    o += 12 + n
  }
  if (!w || !h || colorType !== 0 || interlace || (bitDepth !== 16 && bitDepth !== 8)) throw new Error(`depth.png must be a 16-bit grayscale PNG (got colour type ${colorType}, ${bitDepth} bits)`)
  const zipped = new Blob(idat)
  const raw = new Uint8Array(await new Response(zipped.stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
  const bpp = bitDepth / 8
  const stride = w * bpp
  const out = new Float32Array(w * h)
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const off = y * (stride + 1)
    const ft = raw[off]
    for (let i = 0; i < stride; i++) {
      const x = raw[off + 1 + i]
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      let v
      if (ft === 0) v = x
      else if (ft === 1) v = x + a
      else if (ft === 2) v = x + b
      else if (ft === 3) v = x + ((a + b) >> 1)
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) }
      cur[i] = v & 255
    }
    for (let x = 0; x < w; x++) out[y * w + x] = (bpp === 2 ? (cur[2 * x] << 8) | cur[2 * x + 1] : cur[x]) / 1000
    const t = prev; prev = cur; cur = t
  }
  return { w, h, data: out }
}
// v1>>

  // A placed piece as v1 keeps it: a group (rotation order YXZ) and its local box.
  function addItem(uid, position, rotationDeg, min, max) {
    const group = new THREE.Group()
    group.rotation.order = 'YXZ'
    group.position.set(...position)
    group.rotation.set(0, rotationDeg * DEG, 0)
    group.userData.uid = uid
    scene.add(group)
    const rec = { uid, id: uid, lib: { name: uid }, group, localBox: new THREE.Box3(new THREE.Vector3(...min), new THREE.Vector3(...max)), rotationDeg, missing: false }
    items.set(uid, rec)
    return rec
  }
  return {
    get cam() { return cam }, get lastSet() { return lastSet }, R, items, addItem, setGrab(p) { grab = p }, getDrag: () => ({ ...drag, off: drag.off.toArray(), plane: { normal: drag.plane.normal.toArray(), constant: drag.plane.constant } }),
    setSelected(uid) { selected = uid }, setSnap, ruler,
    depthScale, clientToPhoto, photoToClient, focalPx, projectPhoto, photoRay, photoToFloor, floorToPhoto, worldToScreen, horizonAt, setPitchFromHorizon,
    planePointAt, landingSpot, moveItemInternal, rotateSelected, worldBounds, boxCorners, getScreenRect, getFootprint, hitItemAt,
    dragHeight, beginItemDrag, beginRotateDrag, dragTo, endItemDrag, getRuler, setRulerTrueLength, loadDepth,
  }
}
