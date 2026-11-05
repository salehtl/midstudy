// Differential tests: the wasm kernels, through their TS face (core/js/web.ts), against v1's JavaScript lifted verbatim
// into ./v1/ (planner/engine.js, planner/lighting.js), the env-bake shader transcribed (./v1/envbake.mjs), and the
// independent §4.1 maths of evals/lib/harness.mjs. Thousands of random cameras, points, pixels, items, masks, PNGs,
// probes and photos from a seeded generator (SEED=<n> to reproduce; N=<cases> to scale).
//
// Floats agree within 1e-9 relative (|a − b| ≤ 1e-9 · max(|a|, |b|, floor), the floor a natural scale: 1 m, the photo
// size in px, the SH's largest coefficient), integers, masks and decoded depth exactly. Known, explained differences
// (v1 accepting malformed PNGs; photoToFloor's null within rounding of its −1e-9 threshold) are counted, not failed.
//
// Usage (repo root): core/crates/wasm-web/build-web.sh && nix develop -c node core/crates/wasm-web/tests/diff.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import * as THREE from 'three'
import * as k from '../../../js/web.ts'
import * as V from './v1/engine.mjs'
import * as L from './v1/lighting.mjs'
import { envBakeV1 } from './v1/envbake.mjs'
import * as harness from '../../../../evals/lib/harness.mjs'

const REPO = path.resolve(import.meta.dirname, '../../../..')
k.loadKernelsSync(fs.readFileSync(process.env.MIDSTUDY_WASM || path.join(REPO, 'build/wasm/web/midstudy_wasm_web_bg.wasm')))

const SEED = Number(process.env.SEED ?? 20261105) >>> 0
const N = Number(process.env.N ?? 3000)
let s = SEED || 1
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
const uni = (a, b) => a + (b - a) * rnd()
const int = (a, b) => Math.floor(uni(a, b + 1))
const pick = (xs) => xs[int(0, xs.length - 1)]

// --- bookkeeping ------------------------------------------------------------------------------------------------------
const groups = new Map()
function group(name) {
  if (!groups.has(name)) groups.set(name, { cases: 0, worst: 0, fails: [], notes: new Map() })
  return groups.get(name)
}
const rel = (a, b, floor) => (a === b ? 0 : Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), floor))
function close(name, a, b, floor, tol = 1e-9, ctx = '') {
  const g = group(name)
  const xs = Array.isArray(a) || ArrayBuffer.isView(a) ? Array.from(a) : [a]
  const ys = Array.isArray(b) || ArrayBuffer.isView(b) ? Array.from(b) : [b]
  if (xs.length !== ys.length) { g.fails.push(`${ctx} length ${xs.length} vs ${ys.length}`); return false }
  let ok = true
  xs.forEach((x, i) => {
    const y = ys[i]
    if (Number.isNaN(x) && Number.isNaN(y)) return
    const e = rel(x, y, floor)
    g.worst = Math.max(g.worst, e)
    if (!(e <= tol)) { ok = false; if (g.fails.length < 5) g.fails.push(`${ctx} [${i}] v1 ${x} vs ${y} (rel ${e.toExponential(2)})`) }
  })
  return ok
}
function same(name, a, b, ctx = '') {
  const g = group(name)
  const ok = Object.is(a, b) || a === b || (Number.isNaN(a) && Number.isNaN(b))
  if (!ok && g.fails.length < 5) g.fails.push(`${ctx} v1 ${a} vs ${b}`)
  return ok
}
const count = (name) => { group(name).cases++ }
const note = (name, what) => { const n = group(name).notes; n.set(what, (n.get(what) || 0) + 1) }

// --- generators -------------------------------------------------------------------------------------------------------
const camera = () => ({
  fov_y_deg: rnd() < 0.05 ? pick([20, 110]) : uni(20, 110),
  height_m: rnd() < 0.05 ? pick([0.2, 3]) : uni(0.2, 3),
  pitch_deg: rnd() < 0.05 ? pick([-80, 30, 0]) : uni(-80, 30),
  roll_deg: rnd() < 0.05 ? pick([-20, 20, 0]) : uni(-20, 20),
})
const size = () => (rnd() < 0.3 ? pick([[1600, 1200], [1200, 1600], [2048, 1536], [2048, 1152], [4032, 3024]]) : [int(64, 4096), int(64, 4096)])
const block = (c) => [c.fov_y_deg, c.height_m, c.pitch_deg, c.roll_deg]
const item = () => {
  const w = uni(0.05, 3), d = uni(0.05, 3), h = uni(0.02, 2.5)
  const off = rnd() < 0.5 ? [0, 0] : [uni(-0.1, 0.1), uni(-0.1, 0.1)]
  return {
    position: [uni(-5, 5), rnd() < 0.7 ? 0 : uni(0, 4), uni(-12, rnd() < 0.1 ? 3 : -0.5)],
    rotation_y_deg: rnd() < 0.2 ? pick([0, 90, -90, 180, 45, 12]) : uni(-720, 720),
    min: [-w / 2 + off[0], rnd() < 0.8 ? 0 : uni(-0.05, 0.05), -d / 2 + off[1]],
    // 2 % of boxes are empty in three.js's sense (min > max on y), which v1's worldBounds returns untransformed
    max: [w / 2 + off[0], rnd() < 0.02 ? -0.06 : h + 0.05, d / 2 + off[1]],
  }
}
const view = (W, H) => { const sc = uni(0.08, 2); return { s: sc, ox: uni(-200, 400), oy: uni(-200, 300) } }
const v1For = (cam, W, H, extra = {}) => V.makeV1({ camera: cam, w: W, h: H, ...extra })

// === 1. the camera maps (contract §4.1) ======================================================================================
for (let n = 0; n < N; n++) {
  const cam = camera(), [W, H] = size()
  const v1 = v1For(cam, W, H)
  const sc = new k.SceneCamera(cam, W, H)
  try {
    close('focal length', v1.focalPx(), sc.focal(), 1)
    // R: three.js composes it from a quaternion; the kernel multiplies Rx·Rz out.
    close('R (camera to world)', v1.R.elements, sc.rotation(), 1, 1e-15)
    count('focal length'); count('R (camera to world)')
    for (let i = 0; i < 4; i++) {
      const p = [uni(-10, 10), uni(-1, 4), uni(-30, 5)]
      const a = v1.projectPhoto(p), b = sc.project(p)
      count('projectPhoto')
      close('projectPhoto', a[2], b[2], 1, 1e-9, `d of ${p}`)
      if (Math.abs(a[2]) > 1e-3) close('projectPhoto', a.slice(0, 2), b.slice(0, 2), Math.max(W, H), 1e-9, `px of ${p}`)
      else note('projectPhoto', 'px skipped where |d| ≤ 1 mm (ill-conditioned)')
      close('floorToPhoto', v1.floorToPhoto(p), sc.floorToPhoto(p), Math.max(W, H), 1e-9 * (Math.abs(a[2]) > 1e-3 ? 1 : Infinity))
      count('floorToPhoto')
    }
    for (let i = 0; i < 4; i++) {
      const px = uni(-0.5 * W, 1.5 * W), py = uni(-0.5 * H, 1.5 * H)
      const a = v1.photoToFloor(px, py), b = sc.photoToFloor(px, py)
      count('photoToFloor')
      if ((a === null) !== (b === null)) {
        // Only within rounding of v1's threshold (unit direction y ≥ −1e-9) may they differ.
        const dy = sc.ray(px, py).dir[1]
        if (Math.abs(dy + 1e-9) < 1e-15) note('photoToFloor', 'null-ness differs within 1e-15 of the −1e-9 threshold')
        else same('photoToFloor', a === null, b === null, `null-ness at (${px}, ${py}), dir.y ${dy}`)
      } else if (a && b) close('photoToFloor', a, b, 1, 1e-9, `(${px}, ${py})`)
      const ra = v1.photoRay(px, py), rb = sc.ray(px, py)
      close('photoRay', [...ra.origin.toArray(), ...ra.dir.toArray()], [...rb.origin, ...rb.dir], 1)
      count('photoRay')
      close('horizonAt', v1.horizonAt(px), sc.horizonAt(px), H)
      count('horizonAt')
      // setPitchFromHorizon: the raw pitch v1 hands to setCamera (which then clamps and rounds, as clampCamera does).
      // A fresh v1 each time: its setCamera changes (and rounds) the camera the other maps read.
      const v1p = v1For(cam, W, H)
      v1p.setPitchFromHorizon(py)
      close('setPitchFromHorizon', v1p.lastSet.pitch_deg, sc.pitchFromHorizon(py), 1, 1e-9, `py ${py}`)
      count('setPitchFromHorizon')
    }
    // The 0.12°/px horizon drag (planner/ui/workspace.js), its expression as v1 writes it.
    const rectH = uni(50, 3000), fov = cam.fov_y_deg
    const degPerPx = (360 / Math.PI) * Math.tan((fov * Math.PI) / 360) / Math.max(1, rectH)
    close('horizon drag gain', Math.min(1, 0.12 / degPerPx), k.horizonDragGain(fov, rectH), 1, 1e-15)
    count('horizon drag gain')
  } finally { sc.dispose() }
}

// The harness's own §4.1 (evals/lib/harness.mjs, written from the contract alone) on the golden scenes and at random.
for (const id of ['living-wide', 'steep-roll', 'portrait', 'living-cool', 'living-warm']) {
  const t = JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures/scenes', id, 'truth.json'), 'utf8'))
  const sc = new k.SceneCamera(t.camera, t.image.w, t.image.h)
  for (const o of Object.values(t.objects)) {
    for (const c of [...o.corners, ...o.parts.flatMap((p) => p.corners)]) {
      const h = harness.project(t.camera, t.image.w, t.image.h, c), m = sc.project(c)
      group('golden corners vs harness (px)').worst = Math.max(group('golden corners vs harness (px)').worst, Math.abs(h.px - m[0]), Math.abs(h.py - m[1]))
      same('golden corners vs harness (px)', Math.abs(h.px - m[0]) <= 1e-6 && Math.abs(h.py - m[1]) <= 1e-6, true, `${id} ${c}`)
      count('golden corners vs harness (px)')
    }
  }
  for (const fp of t.floor_points) {
    const [px, py] = sc.floorToPhoto(fp.world)
    close('golden floor points: harness photoToFloor', harness.photoToFloor(t.camera, t.image.w, t.image.h, px, py), sc.photoToFloor(px, py), 1)
    count('golden floor points: harness photoToFloor')
  }
  sc.dispose()
}
for (let n = 0; n < N; n++) {
  const cam = camera(), [W, H] = size(), sc = new k.SceneCamera(cam, W, H)
  const p = [uni(-8, 8), uni(0, 3), uni(-25, -0.5)]
  const h = harness.project(cam, W, H, p), m = sc.project(p)
  if (h.d > 1e-2) close('random points vs harness', [h.px, h.py, h.d], m, Math.max(W, H))
  const px = uni(0, W), py = uni(0, H)
  const a = harness.photoToFloor(cam, W, H, px, py), b = sc.photoToFloor(px, py)
  if (a && b) close('random points vs harness', a, b, 1)
  else if (!a !== !b) note('random points vs harness', 'null-ness differs: the harness tests y ≥ 0, v1 and v2 y ≥ −1e-9 (unit)')
  count('random points vs harness')
  sc.dispose()
}

// === 2. clamps, wraps, rounding ==========================================================================================
const wild = () => pick([NaN, Infinity, -Infinity, -0, 0, uni(-1e6, 1e6), uni(-200, 200), uni(-5, 5), 1e-300, -1e-300, 180, -180, 540, -540])
for (let n = 0; n < N; n++) {
  const c = { fov_y_deg: wild(), height_m: wild(), pitch_deg: wild(), roll_deg: wild() }
  const base = rnd() < 0.5 ? V.DEFAULT_CAMERA : camera()
  const a = V.clampCamera(c, base), b = k.clampCamera(c, base)
  for (const key of Object.keys(V.CAMERA_RANGE)) same('clampCamera', a[key], b[key], `${key} ${c[key]}`)
  count('clampCamera')
  const look = Object.fromEntries(k.LOOK_KEYS.map((key) => [key, wild()]))
  const lf = V.lookFrom(look)
  for (const key of k.LOOK_KEYS) same('lookFrom (Look clamps)', lf[key], k.clampLook(key, look[key]), `${key} ${look[key]}`)
  count('lookFrom (Look clamps)')
  const d = wild()
  same('wrapDeg', V.wrapDeg(d), k.wrapDeg(d), `${d}`)
  same('wrapAz', V.wrapAz(d), k.wrapAz(d), `${d}`)
  for (const digits of [4, 6]) same('round(v, n)', V.round(d, digits), k.roundTo(d, digits), `${d}, ${digits}`)
  same('clampElev', V.clampElev(d), k.clampElevation(d), `${d}`)
  count('wrapDeg'); count('wrapAz'); count('round(v, n)'); count('clampElev')
  const calib = { floor: { found: rnd() < 0.8 }, source: pick(['moge-2', 'truth', 'exif', 'default']), camera: { height_m: rnd() < 0.9 ? uni(0.2, 3) : pick([0, -1, NaN, undefined]) } }
  const v1 = v1For({ ...camera() }, 100, 100, { calib })
  const measured = !!calib.floor.found && (calib.source === 'moge-2' || calib.source === 'truth')
  same('depthScale', v1.depthScale(), k.depthScale(v1.cam.height_m, Number(calib.camera.height_m), measured), JSON.stringify(calib))
  count('depthScale')
}

// === 3. items: corners, bounds, screen rect, footprint, rotation =========================================================
for (let n = 0; n < N; n++) {
  const cam = camera(), [W, H] = size(), v1 = v1For(cam, W, H), sc = new k.SceneCamera(cam, W, H)
  const it = item()
  v1.addItem('a', it.position, it.rotation_y_deg, it.min, it.max)
  const rec = v1.items.get('a')
  close('boxCorners', v1.boxCorners(rec).flatMap((p) => p.toArray()), k.boxCorners(it).flat(), 1)
  const wb = v1.worldBounds(rec)
  const kb = k.worldBounds(it)
  close('worldBounds', [...wb.min.toArray(), ...wb.max.toArray()], [...kb.min, ...kb.max], 1)
  const fa = v1.getFootprint('a'), fb = k.footprint(it)
  close('getFootprint', [...fa.corners.flat(), ...fa.center, fa.height], [...fb.corners.flat(), ...fb.center, fb.height], 1)
  const ra = v1.getScreenRect('a'), rb = sc.screenRect(it)
  if (!ra || !rb) same('getScreenRect', ra === null, rb === null, 'null-ness')
  else close('getScreenRect', [ra.x, ra.y, ra.w, ra.h], [rb.x, rb.y, rb.w, rb.h], Math.max(W, H))
  for (const name of ['boxCorners', 'worldBounds', 'getFootprint', 'getScreenRect']) count(name)
  // rotateSelected: round(wrapDeg(rot + deg), 6)
  v1.setSelected('a')
  const step = pick([15, -15, 90, 45, uni(-400, 400)])
  v1.rotateSelected(step)
  same('rotateSelected', v1.items.get('a').rotationDeg, k.rotateBy(it.rotation_y_deg, step), `${it.rotation_y_deg} + ${step}`)
  count('rotateSelected')
  sc.dispose()
}

// === 4. hulls and the on-screen hit test ======================================================================================
for (let n = 0; n < N; n++) {
  const m = int(0, 12)
  const base = Array.from({ length: m }, () => ({ x: Math.round(uni(0, 2000) * (rnd() < 0.3 ? 1 : 1000)) / (rnd() < 0.3 ? 1 : 1000), y: uni(0, 1500) }))
  if (m > 2 && rnd() < 0.2) base.push({ ...base[0] }, { x: (base[0].x + base[1].x) / 2, y: (base[0].y + base[1].y) / 2 }) // duplicates, collinear
  const ha = V.convexHull(base), hb = k.convexHull(base.map((p) => [p.x, p.y]))
  same('convexHull', JSON.stringify(ha), JSON.stringify(hb), `${JSON.stringify(base)}`)
  count('convexHull')
  for (let i = 0; i < 4; i++) {
    const x = uni(-100, 2100), y = uni(-100, 1600)
    same('pointInHull', V.pointInHull(ha, x, y), k.pointInHull(hb, x, y), `(${x}, ${y})`)
    close('distToHull', V.distToHull(ha, x, y), k.distToHull(hb, x, y), 1, 1e-12)
    count('pointInHull'); count('distToHull')
  }
}
for (let n = 0; n < N; n++) {
  const cam = camera(), [W, H] = size(), vw = view(W, H)
  const v1 = v1For(cam, W, H, { view: vw }), sc = new k.SceneCamera(cam, W, H)
  const it = item()
  v1.addItem('a', it.position, it.rotation_y_deg, it.min, it.max)
  const rect = sc.screenRect(it)
  const cx = rect ? vw.ox + vw.s * (rect.x + rect.w * uni(-0.3, 1.3)) : uni(0, 1000), cy = rect ? vw.oy + vw.s * (rect.y + rect.h * uni(-0.3, 1.3)) : uni(0, 800)
  const pad = pick([0, 16, 4])
  const visible = v1.getFootprint('a').box.every((p) => v1.worldToScreen(p).visible)
  const b = sc.hitBox(it, vw, cx, cy, pad)
  if (!visible) same('hitItemAt (on screen)', b, 'behind', 'a corner behind the camera')
  else same('hitItemAt (on screen)', v1.hitItemAt('a', cx, cy, pad), b === 'hit', `(${cx}, ${cy})`)
  count('hitItemAt (on screen)')
  sc.dispose()
}

// === 5. landing, planes, drags, the ruler =====================================================================================
for (let n = 0; n < N; n++) {
  const cam = camera(), [W, H] = size(), vw = view(W, H)
  const vis = { x: vw.ox + vw.s * uni(0, W * 0.3), y: vw.oy + vw.s * uni(0, H * 0.3), w: vw.s * W * uni(0.2, 0.7), h: vw.s * H * uni(0.2, 0.7) }
  const v1 = v1For(cam, W, H, { view: vw, visible: vis }), sc = new k.SceneCamera(cam, W, H)
  const base = sc.landingSpot(vw, vis, [])
  const taken = []
  for (let i = int(0, 9); i > 0; i--) {
    const p = [base[0] + uni(-1.5, 1.5), 0, base[2] + uni(-1.5, 1.5)]
    taken.push([p[0], p[2]])
    v1.addItem(`t${i}`, p, 0, [-0.2, 0, -0.2], [0.2, 0.5, 0.2])
  }
  close('landingSpot', v1.landingSpot(), sc.landingSpot(vw, vis, taken), 1, 1e-9)
  count('landingSpot')
  sc.dispose()
}
for (let n = 0; n < N; n++) {
  const cam = camera(), [W, H] = size(), vw = view(W, H)
  const v1 = v1For(cam, W, H, { view: vw }), sc = new k.SceneCamera(cam, W, H)
  const it = item()
  it.position[2] = Math.min(it.position[2], -0.8)
  v1.addItem('a', it.position, it.rotation_y_deg, it.min, it.max)
  const rect = sc.screenRect(it) || { x: W / 2, y: H / 2, w: 10, h: 10 }
  const at = () => [vw.ox + vw.s * (rect.x + rect.w * uni(0, 1)), vw.oy + vw.s * (rect.y + rect.h * uni(0, 1))]
  const photoOf = ([x, y]) => [(x - vw.ox) / vw.s, (y - vw.oy) / vw.s] // v1's clientToPhoto
  // planePointAt on a random plane
  const plane = rnd() < 0.5 ? new THREE.Plane(new THREE.Vector3(0, 1, 0), -uni(0, 2)) : new THREE.Plane().setFromNormalAndCoplanarPoint(new THREE.Vector3(uni(-1, 1), 0, uni(-1, 1)).normalize(), new THREE.Vector3(...it.position))
  const c0 = at()
  const pa = v1.planePointAt(plane, ...c0)
  const pb = sc.planePointAt(...photoOf(c0), { normal: plane.normal.toArray(), constant: plane.constant })
  if (!pa || !pb) same('planePointAt', pa === null, pb === null, 'null-ness')
  else close('planePointAt', pa.toArray(), pb, 1)
  count('planePointAt')
  // dragHeight with a grabbed point (or beside the piece)
  const wb = k.worldBounds(it)
  const grab = rnd() < 0.8 ? [0, uni(wb.min[1] - 0.2, wb.max[1] + 0.2), 0] : null
  v1.setGrab(grab)
  same('dragHeight', v1.dragHeight(v1.items.get('a'), ...c0), k.dragHeight(grab ? grab[1] : null, wb.min[1], wb.max[1], cam.height_m), `grab ${grab}, kernel bounds y ${wb.min[1]}..${wb.max[1]}, v1 bounds y ${v1.worldBounds(v1.items.get('a')).min.y}..${v1.worldBounds(v1.items.get('a')).max.y}, eye ${cam.height_m} / ${v1.cam.height_m}`)
  count('dragHeight')
  // a whole drag: v1's beginItemDrag/beginRotateDrag + dragTo against the kernel's steps
  const mode = pick(['move', 'lift', 'rotate'])
  const snap = rnd() < 0.3
  const c1 = at(), c2 = [c1[0] + uni(-80, 80), c1[1] + uni(-80, 80)]
  const pos0 = [...it.position]
  let ok
  if (mode === 'rotate') ok = v1.beginRotateDrag('a', ...c1)
  else { v1.setSnap(snap && mode === 'lift'); ok = v1.beginItemDrag('a', ...c1, { lift: mode === 'lift' }) }
  if (!ok) { note('drags', `${mode}: the start point missed its plane (both sides checked below)`) }
  // the kernel's version of the same drag
  const kPlane = mode === 'move'
    ? { normal: [0, 1, 0], constant: -k.dragHeight(grab ? grab[1] : null, wb.min[1], wb.max[1], cam.height_m) }
    : mode === 'lift' ? k.liftPlane(pos0) : { normal: [0, 1, 0], constant: -pos0[1] }
  const p1 = sc.planePointAt(...photoOf(c1), kPlane)
  same('drags', ok, !!p1, `${mode} start`)
  if (ok && p1) {
    v1.dragTo(...c2, { snapTo: snap && mode === 'rotate' })
    const p2 = sc.planePointAt(...photoOf(c2), kPlane)
    const after = v1.items.get('a')
    if (!p2) note('drags', 'the end point missed its plane: v1 leaves the piece (both)')
    else if (mode === 'move') {
      const off = [pos0[0] - p1[0], pos0[1] - p1[1], pos0[2] - p1[2]]
      close('drags', [after.group.position.x, after.group.position.z], k.dragMove(p2, off), 1, 1e-9, 'move')
    } else if (mode === 'lift') {
      close('drags', after.group.position.y, k.dragLift(p2[1], pos0[1] - p1[1], snap), 1, 1e-9, 'lift')
    } else {
      const a0 = k.gripAngle(p1, pos0)
      const deg = k.dragRotate(it.rotation_y_deg, k.gripAngle(p2, pos0), a0, snap)
      close('drags', after.rotationDeg, deg, 1, 1e-9, 'rotate')
    }
  }
  count('drags')
  v1.endItemDrag()
  // the ruler
  const pts = [sc.photoToFloor(uni(0, W), uni(H * 0.6, H)), sc.photoToFloor(uni(0, W), uni(H * 0.6, H))]
  if (pts[0] && pts[1]) {
    v1.ruler.points = pts.map((p) => [...p])
    const measured = Math.hypot(pts[0][0] - pts[1][0], pts[0][2] - pts[1][2])
    close('ruler length', v1.getRuler().meters, measured, 1, 0)
    const trueLen = pick([uni(0.1, 5), measured * uni(0.8, 1.2), -1, 0, NaN])
    const h0 = v1.cam.height_m
    const r = k.rulerRescale(h0, measured, trueLen)
    const exact = v1.setRulerTrueLength(trueLen)
    if (!r) same('setRulerTrueLength', exact, false, 'refused')
    else {
      same('setRulerTrueLength', exact, r.exact, `${trueLen}`)
      close('setRulerTrueLength', v1.cam.height_m, k.clampCamera({ ...v1.cam, height_m: r.height_m }, v1.cam).height_m, 1, 1e-9)
    }
    count('setRulerTrueLength'); count('ruler length')
  }
  sc.dispose()
}

// === 6. depth.png ==============================================================================================================
function pngGray(w, h, depth, samples, filters, split = 1 << 30) {
  const bpp = depth / 8, stride = w * bpp
  const rows = []
  for (let y = 0; y < h; y++) {
    const r = Buffer.alloc(stride)
    for (let x = 0; x < w; x++) { if (bpp === 2) r.writeUInt16BE(samples[y * w + x], 2 * x); else r[x] = samples[y * w + x] }
    rows.push(r)
  }
  const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c }
  const raw = []
  rows.forEach((row, y) => {
    const prev = y ? rows[y - 1] : Buffer.alloc(stride), ft = filters[y % filters.length]
    raw.push(Buffer.from([ft]))
    raw.push(Buffer.from(row.map((x, i) => {
      const a = i >= bpp ? row[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0
      return (x - [0, a, b, (a + b) >> 1, paeth(a, b, c)][ft]) & 255
    })))
  })
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = depth
  const z = zlib.deflateSync(Buffer.concat(raw), { level: int(0, 9) })
  const idats = []
  for (let o = 0; o < z.length; o += split) idats.push(chunk('IDAT', z.subarray(o, o + split)))
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('tEXt', Buffer.from('Software\0k-geom')), ...idats, chunk('IEND', Buffer.alloc(0))])
}
async function depthCase(name, bytes) {
  const v1 = v1For(V.DEFAULT_CAMERA, 1, 1)
  let a = null, b = null, ea = null, eb = null
  try { a = await v1.loadDepth(new Uint8Array(bytes)) } catch (e) { ea = e }
  try { b = k.decodeDepth(new Uint8Array(bytes)) } catch (e) { eb = e }
  count(name)
  if (ea || eb) {
    if (ea && eb) return
    note(name, ea ? `v1 refuses, v2 decodes` : `v1 decodes, v2 refuses (${eb.message.slice(0, 50)})`)
    return
  }
  same(name, `${a.w}x${a.h}`, `${b.width}x${b.height}`, 'size')
  const ua = new Uint32Array(a.data.buffer, a.data.byteOffset, a.data.length), ub = new Uint32Array(b.data.buffer, b.data.byteOffset, b.data.length)
  let diff = 0
  for (let i = 0; i < ua.length; i++) if (ua[i] !== ub[i]) diff++
  same(name, diff, 0, 'f32 values differing bit for bit')
}
for (const id of ['living-wide', 'steep-roll', 'portrait', 'living-cool', 'living-warm']) await depthCase('depth.png: golden scenes', fs.readFileSync(path.join(REPO, 'fixtures/scenes', id, 'depth.png')))
for (let n = 0; n < Math.max(200, N / 10); n++) {
  const w = int(1, 260), h = int(1, 260), depth = pick([8, 16])
  const samples = Array.from({ length: w * h }, () => (depth === 16 ? (rnd() < 0.3 ? 0 : int(0, 65535)) : int(0, 255)))
  const filters = rnd() < 0.3 ? [int(0, 4)] : Array.from({ length: int(1, 6) }, () => int(0, 4))
  await depthCase('depth.png: random (all filters, 8/16 bit)', pngGray(w, h, depth, samples, filters, rnd() < 0.5 ? int(1, 500) : 1 << 30))
}
for (let n = 0; n < Math.max(200, N / 10); n++) {
  // damaged files: v1 and v2 may differ (v2 is strict); counted as notes
  const w = int(1, 40), h = int(1, 40), depth = pick([8, 16])
  const good = pngGray(w, h, depth, Array.from({ length: w * h }, () => int(0, 255)), [int(0, 4)])
  const bad = Buffer.from(good)
  const kind = pick(['flip', 'cut', 'filter'])
  if (kind === 'flip') bad[int(8, bad.length - 1)] ^= 1 << int(0, 7)
  await depthCase('depth.png: damaged (notes only)', kind === 'cut' ? bad.subarray(0, int(8, bad.length - 1)) : bad)
}

// === 7. the keep-room mask ======================================================================================================
function readback(w, h) {
  const px = new Uint8Array(w * h * 4)
  for (let i = 0; i < px.length; i++) px[i] = rnd() < 0.02 ? int(0, 255) : 0
  for (let b = int(0, 6); b > 0; b--) {
    const x0 = int(0, w - 1), y0 = int(0, h - 1), x1 = Math.min(w, x0 + int(1, w / 2 + 1)), y1 = Math.min(h, y0 + int(1, h / 2 + 1))
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * w + x) * 4] = int(100, 255)
  }
  return px
}
const maskSizes = [...Array.from({ length: Math.max(300, N / 10) }, () => [int(1, 300), int(1, 300)]), [2048, 1152], [1152, 2048], [1600, 1200]]
for (const [w, h] of maskSizes) {
  const px = readback(w, h)
  const a = V.maskFromPixels(px, w, h), b = k.keepRoomMask(px, w, h, { bottomUp: true })
  let diff = 0
  for (let i = 0; i < a.on.length; i++) if (a.on[i] !== b.mask[i]) diff++
  same('keep-room mask', diff, 0, `${w}x${h}: pixels differing`)
  same('keep-room mask', a.coverage, b.coverage, `${w}x${h}: coverage`)
  count('keep-room mask')
  const src = new Uint8Array(w * h).map(() => (rnd() < 0.05 ? 1 : 0))
  const r = [int(0, 9), int(0, 9), int(0, 9), int(0, 20)]
  const da = V.dilate(src, w, h, ...r), db = k.dilate(src, w, h, ...r)
  same('dilate', Buffer.compare(Buffer.from(da), Buffer.from(db)), 0, `${w}x${h} reach ${r}`)
  count('dilate')
}

// === 8. the light: SH, directions, splats ========================================================================================
const unit = () => { const v = new THREE.Vector3(uni(-1, 1), uni(-1, 1), uni(-1, 1)); return v.lengthSq() < 1e-6 ? [0, 1, 0] : v.normalize().toArray() }
const shRand = (band2) => Array.from({ length: 9 }, (_, i) => (i >= 4 && !band2 ? [0, 0, 0] : [uni(-1, 2), uni(-1, 2), uni(-1, 2)]))
for (let n = 0; n < N; n++) {
  const cam = camera(), v1 = v1For(cam, 100, 100)
  const R = rnd() < 0.7 ? v1.R : new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...unit()), new THREE.Vector3(...unit()))))
  const sh = shRand(rnd() < 0.5)
  const scale = Math.max(...sh.flat().map(Math.abs), 1e-9)
  const ra = L.rotateSH(sh, R), rb = k.rotateSh(sh, R.elements)
  close('rotateSH', ra.flat(), rb.flat(), scale, 1e-9)
  const d = unit()
  close('irradianceAt', L.irradianceAt(sh, d), k.irradianceAt(sh, d), scale, 1e-12)
  const kk = uni(0, 3)
  close('scaleBands', L.scaleBands(sh, kk).flat(), k.scaleBands(sh, kk).flat(), scale, 0)
  const ma = L.maxBandScale(sh), mb = k.maxBandScale(sh)
  if (ma === Infinity || mb === Infinity) same('maxBandScale', ma, mb)
  else close('maxBandScale', ma, mb, 1e-9, 1e-9)
  const [a, b] = rnd() < 0.1 ? (() => { const u = unit(); return [u, u.map((x) => -x + uni(-1e-9, 1e-9))] })() : [unit(), unit()]
  close('turnBetween', L.turnBetween(a, b).elements, k.turnBetween(a, b), 1, 1e-12)
  const dir = unit()
  const ae = L.azElOf(dir), be = k.azElOf(dir)
  close('azElOf', [ae.azimuth_deg, ae.elevation_deg], [be.azimuth_deg, be.elevation_deg], 1, 1e-12)
  const az = uni(-180, 180), el = uni(5, 90)
  close('dirOf', L.dirOf(az, el), k.dirOf(az, el), 1, 1e-12)
  // splatGain: with lighting.json (world SH from v1's own rotateSH) and without
  const data = { ambient: { sh }, key: { direction: unit(), color: [1, uni(0.6, 1), uni(0.5, 1)], intensity: uni(0.5, 4), softness: uni(0, 1) }, white_balance: rnd() < 0.8 ? { rgb: [uni(0.8, 1.2), uni(0.8, 1.2), uni(0.8, 1.2)] } : undefined }
  const look = { ambient: uni(0, 3), light_strength: uni(0, 3) }
  const ga = L.makeSplatGain({ data, look, R })()
  const gb = k.splatGain({ worldSh: k.rotateSh(sh, R.elements), keyColor: data.key.color, keyIntensity: data.key.intensity, whiteBalance: data.white_balance?.rgb ?? null }, look.ambient, look.light_strength)
  close('splatGain', ga, gb, 1, 1e-9)
  close('splatGain', L.makeSplatGain({ data: null, look, R })(), k.splatGain(null, look.ambient, look.light_strength), 1, 1e-12)
  const w = uni(-1, 1)
  close('warmthTint', V.warmthTint(w).toArray(), k.splatMultiplier(w, 1, [1, 1, 1]), 1, 1e-12)
  for (const name of ['rotateSH', 'irradianceAt', 'scaleBands', 'maxBandScale', 'turnBetween', 'azElOf', 'dirOf', 'splatGain', 'warmthTint']) count(name)
}

// === 9. the environment map (the shader's maths) =================================================================================
for (let n = 0; n < Math.max(40, N / 75); n++) {
  const cam = camera(), pw = int(4, 64), ph = int(4, 64)
  const data = new Uint8Array(pw * ph * 4).map(() => int(0, 255))
  const v1 = v1For(cam, pw, ph)
  const a = envBakeV1({ width: pw, height: ph, data }, v1.R, cam.fov_y_deg, 64, 32, { exactPi: true })
  const b = k.envMap({ width: pw, height: ph, data }, { rotation: v1.R.elements, fov_y_deg: cam.fov_y_deg }, { width: 64, height: 32, anisotropy: 0, half: false })
  // The kernel uses π exactly; the shader wrote 3.14159265 and 6.28318531 (directions off by < 4e-9 rad). With the
  // same π the f32 outputs agree to f32 rounding; with the shader's constants, steep pixels move by up to ~1e-3.
  close('env map (bilinear) vs the shader', a, b.data, 1e-3, 1e-6)
  const c = envBakeV1({ width: pw, height: ph, data }, v1.R, cam.fov_y_deg, 64, 32)
  let w = 0
  for (let i = 0; i < c.length; i++) w = Math.max(w, rel(c[i], b.data[i], 1e-3))
  group('env map (bilinear) vs the shader').notes.set(`with the shader's own π constants: worst ${w.toExponential(1)} so far`, 1)
  count('env map (bilinear) vs the shader')
}

// --- report ------------------------------------------------------------------------------------------------------------------------
let failed = 0
console.log(`k-geom differential tests: seed ${SEED}, N ${N}`)
for (const [name, g] of groups) {
  const ok = g.fails.length === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${g.cases} cases, worst ${g.worst === 0 ? '0 (exact)' : g.worst.toExponential(2)}${[...g.notes].map(([w, c]) => `; note: ${w} ×${c}`).join('')}`)
  for (const f of g.fails) console.log(`     ${f}`)
}
console.log(`${groups.size - failed}/${groups.size} groups pass`)
process.exit(failed ? 1 : 0)
