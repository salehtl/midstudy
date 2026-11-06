// Golden scenes (PLAN.md §6.1, contract §5.1): a textured room rendered with three.js 0.180.0 in headless Chrome from a
// known camera (contract §4.1), so calibration, projection and occlusion can be checked against exact geometry.
// Adapted from nook's fixtures/make_capture.mjs.
//
// Writes, per scene:
//   fixtures/scenes/<id>/photo.jpg     the "phone photo" (no metadata; JPEG q92 from the canvas)
//   fixtures/scenes/<id>/truth.json    camera block, object boxes with world corners and their photo pixels
//   fixtures/scenes/<id>/depth.png     exact depth along the view axis, 16-bit mm, floor (≤ 4 cm) masked to 0
//   fixtures/scenes/<id>/calib.json    calib.schema.json with source "truth"
//   fixtures/scenes/<id>/ids.png       id masks rendered alone, no occlusion: R = sofa, G = table (8-bit RGB)
//   fixtures/calib/<sha256 of photo.jpg>/{calib.json,depth.png}   what MIDSTUDY_CALIB_MOCK serves for that photo
//
//   fixtures/scenes/<id>/lighting.json the scene's known lights as lighting.json (contract §4.8, source "truth"), also
//                                      copied into the mock folder below
//
// The golden room (contract §4.9, §5.1; docs/ROOMS.md §5 A1): six more photos of the same room, room-1 … room-6, taken
// from around it (ROOM_SCENES), each a scene in its own frame (camera at x = z = 0, facing −Z) with truth.json's
// `pose_in_room` saying where it stands in living-wide's frame (the room frame). Their truth.json is in the scene's own
// frame (objects, floor points, lights), plus `pose_in_room`, `room` and `wall_check`. With them:
//   fixtures/calib/rooms/<key>/align.json   the calib mock's align-room answer (contract §4.9 Mock): the true poses of
//                                           the golden room (living-wide + room-1…6) and of the pair living-wide + room-1
//
// Usage: node fixtures/make_scene.mjs [--only <id>[,<id>…]] [--rooms] [--lights-only] [--out <dir>]
//   (then: evals/py fixtures/check_scenes.py)
//   --only renders those scenes; --rooms renders the golden room's six photos (room-*) and its align.json answers,
//   leaving the five original scenes as they are; with neither, every scene is rendered.
//   --lights-only rewrites truth.json's `lights` and lighting.json without rendering (photos unchanged).
//   --out writes <dir>/scenes/<id>/ and <dir>/calib/ instead of fixtures/ (to compare a re-render with the fixtures).
// Browser: MIDSTUDY_BROWSER, default $PUPPETEER_EXECUTABLE_PATH (headless Chrome; software GL, swiftshader).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { chromium } from 'playwright-core'

const REPO = path.resolve(import.meta.dirname, '..')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const ONLY_ARG = arg('only', null)
const ROOMS_ONLY = process.argv.includes('--rooms')
const LIGHTS_ONLY = process.argv.includes('--lights-only')
const OUT = path.resolve(arg('out', path.join(REPO, 'fixtures')))
const BROWSER = process.env.MIDSTUDY_BROWSER || process.env.PUPPETEER_EXECUTABLE_PATH || ''
if (!BROWSER) throw new Error('make_scene: no headless browser: set PUPPETEER_EXECUTABLE_PATH (or MIDSTUDY_BROWSER)')

// The lights (world frame, three.js 0.180 units; colours are sRGB hex, which three.js turns linear). `sun` is a
// DirectionalLight from `position` towards `target`; `hemi` a HemisphereLight (sky from +Y); `lamp` a PointLight.
// DAYLIGHT is what the first three scenes were rendered with (their photos predate per-scene lights and are unchanged).
export const DAYLIGHT = {
  hemi: { sky: 0xfff6ea, ground: 0xb9a48c, intensity: 1.9 },
  sun: { color: 0xfff1df, intensity: 2.2, position: [3.2, 5.0, 1.5], target: [-0.4, 0, -3.0], shadow_radius: 6 },
  lamp: { color: 0xffd9a0, intensity: 1.6, position: [1.95, 1.5, -3.9], distance: 4, decay: 2 },
}
// Contract §5.1: the same room and camera as living-wide under other lights, for the lighting evals (contract §4.8).
const COOL_LEFT = { // cool daylight from the far left, in front of the camera: shadows fall towards the camera and right
  hemi: { sky: 0xdfe9ff, ground: 0x8e8a84, intensity: 1.6 },
  sun: { color: 0xd6e4ff, intensity: 2.4, position: [-4.0, 3.0, -6.0], target: [0.4, 0, -2.5], shadow_radius: 6 },
  lamp: { color: 0xffd9a0, intensity: 0, position: [1.95, 1.5, -3.9], distance: 4, decay: 2 },
}
const WARM_RIGHT = { // a warm evening key from the right, high; a dimmer warm fill; the lamp off (one key light)
  hemi: { sky: 0xffe2bf, ground: 0x6e5a48, intensity: 1.2 },
  sun: { color: 0xffc68a, intensity: 2.6, position: [3.5, 4.0, -3.0], target: [-0.5, 0, -2.5], shadow_radius: 6 },
  lamp: { color: 0xffc070, intensity: 0, position: [1.95, 1.5, -3.9], distance: 4, decay: 2 },
}

// The scenes of PLAN.md §6.1. Depth maps are at most 1024 px on the long side, same aspect (contract §4.2).
const LIVING = { fov_y_deg: 55.0, height_m: 1.40, pitch_deg: -10.0, roll_deg: 0.0 }
export const SCENES = [
  { id: 'living-wide', w: 1600, h: 1200, camera: LIVING, lights: DAYLIGHT },
  { id: 'steep-roll', w: 1600, h: 1200, camera: { fov_y_deg: 65.0, height_m: 1.60, pitch_deg: -25.0, roll_deg: 2.0 }, lights: DAYLIGHT },
  { id: 'portrait', w: 1200, h: 1600, camera: { fov_y_deg: 70.0, height_m: 1.25, pitch_deg: -8.0, roll_deg: -1.0 }, lights: DAYLIGHT },
  { id: 'living-cool', w: 1600, h: 1200, camera: LIVING, lights: COOL_LEFT },
  { id: 'living-warm', w: 1600, h: 1200, camera: LIVING, lights: WARM_RIGHT },
]
// The golden room (contract §5.1, §4.9): living-wide's frame is the room frame; six more photos of the same room under
// DAYLIGHT, each with its pose in the room frame (p_room = Ry(yaw) · p_scene + (x_m, 0, z_m)). Heights 1.22–1.58 m,
// pitch −6…−18°, rolls within ±1.5°. The hard cases: room-6 faces the bare right wall (no sofa, no table, little but
// floor and plaster), and room-4 (behind the sofa, facing the front wall) shares little with living-wide and room-1
// (truth.json `room.overlap` has the measured share of each photo's points that another photo sees).
export const ROOM_FRAME = 'living-wide'
export const ROOM_SCENES = [
  { id: 'room-1', w: 1600, h: 1200, camera: { fov_y_deg: 58.0, height_m: 1.52, pitch_deg: -12.0, roll_deg: 1.2 }, pose: { x_m: -1.15, z_m: 0.45, yaw_deg: -22.0 }, lights: DAYLIGHT },
  { id: 'room-2', w: 1600, h: 1200, camera: { fov_y_deg: 60.0, height_m: 1.36, pitch_deg: -14.0, roll_deg: -1.4 }, pose: { x_m: 1.9, z_m: 0.3, yaw_deg: 35.0 }, lights: DAYLIGHT },
  { id: 'room-3', w: 1600, h: 1200, camera: { fov_y_deg: 52.0, height_m: 1.58, pitch_deg: -9.0, roll_deg: 0.6 }, pose: { x_m: -1.95, z_m: -0.35, yaw_deg: -55.0 }, lights: DAYLIGHT },
  { id: 'room-4', w: 1600, h: 1200, camera: { fov_y_deg: 65.0, height_m: 1.45, pitch_deg: -16.0, roll_deg: -0.8 }, pose: { x_m: 1.35, z_m: -4.55, yaw_deg: 152.0 }, lights: DAYLIGHT, hard_case: 'little-overlap' },
  { id: 'room-5', w: 1200, h: 1600, camera: { fov_y_deg: 66.0, height_m: 1.22, pitch_deg: -6.0, roll_deg: -0.5 }, pose: { x_m: 1.9, z_m: -1.3, yaw_deg: 62.0 }, lights: DAYLIGHT },
  { id: 'room-6', w: 1600, h: 1200, camera: { fov_y_deg: 55.0, height_m: 1.45, pitch_deg: -19.0, roll_deg: 1.5 }, pose: { x_m: 0.55, z_m: -0.7, yaw_deg: -90.0 }, lights: DAYLIGHT, hard_case: 'blank-wall' },
]
const ALL = [...SCENES, ...ROOM_SCENES]
// The calib mock's align-room answers (contract §4.9 Mock): which photo sets get one, the room frame's photo first.
const ROOM_SETS = [
  { name: 'golden-room', ids: [ROOM_FRAME, ...ROOM_SCENES.map((s) => s.id)] },
  { name: 'golden-pair', ids: [ROOM_FRAME, 'room-1'] },
]

// --- poses (contract §4.9): room frame <-> a scene's frame ----------------------------------------------------------
// Ry(a) = [[cos a, 0, sin a], [0, 1, 0], [−sin a, 0, cos a]]; p_room = Ry(yaw) · p_scene + t; p_scene = Ry(−yaw) · (p_room − t)
const ryApply = (deg, [x, y, z]) => { const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a); return [c * x + s * z, y, -s * x + c * z] }
export const roomToScene = (pose, p) => (pose ? ryApply(-pose.yaw_deg, [p[0] - pose.x_m, p[1], p[2] - pose.z_m]) : p)
export const sceneToRoom = (pose, p) => { if (!pose) return p; const q = ryApply(pose.yaw_deg, p); return [q[0] + pose.x_m, q[1], q[2] + pose.z_m] }
const dirToScene = (pose, v) => (pose ? ryApply(-pose.yaw_deg, v) : v)
const wrapDeg = (d) => { let y = ((d + 180) % 360 + 360) % 360 - 180; if (y <= -180) y += 360; return y }
// A scene's lights in its own frame (positions and targets through the pose; identity without one).
function sceneLights(s) {
  if (!s.pose) return s.lights
  const r6l = (v) => v.map((x) => Math.round(x * 1e6) / 1e6)
  return { ...s.lights,
    sun: { ...s.lights.sun, position: r6l(roomToScene(s.pose, s.lights.sun.position)), target: r6l(roomToScene(s.pose, s.lights.sun.target)) },
    lamp: { ...s.lights.lamp, position: r6l(roomToScene(s.pose, s.lights.lamp.position)) } }
}

// --- lighting truth (contract §4.8) -------------------------------------------------------------------------------
// lighting.json for a scene's known lights, in the camera frame of its true camera: the hemisphere light is exactly
// L2 spherical harmonics (bands 0 and 1), the sun is the key light. The lamp is a local light and is left out.
const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export const hexLinear = (hex) => [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255].map((v) => srgbToLinear(v / 255))
const norm3 = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l) }
// World vector → the camera frame of a contract §4.1 camera: v_c = Rᵀ v, R = Rx(pitch) · Rz(roll).
export function worldToCamera(cam, v) {
  const p = cam.pitch_deg * Math.PI / 180, r = cam.roll_deg * Math.PI / 180
  const cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r)
  const R = [[cr, -sr, 0], [cp * sr, cp * cr, -sp], [sp * sr, sp * cr, cp]]
  return [0, 1, 2].map((j) => R[0][j] * v[0] + R[1][j] * v[1] + R[2][j] * v[2])
}
// Correlated colour temperature (K) of a linear sRGB colour: CIE xy, then McCamy's approximation.
export function cct([r, g, b]) {
  const X = 0.4124 * r + 0.3576 * g + 0.1805 * b, Y = 0.2126 * r + 0.7152 * g + 0.0722 * b, Z = 0.0193 * r + 0.1192 * g + 0.9505 * b
  const x = X / (X + Y + Z), y = Y / (X + Y + Z), n = (x - 0.3320) / (0.1858 - y)
  return Math.min(40000, Math.max(1000, 449 * n ** 3 + 3525 * n ** 2 + 6823.3 * n + 5520.33))
}
export function truthLighting(s) {
  const L = s.lights, cam = s.camera
  const S = hexLinear(L.hemi.sky), G = hexLinear(L.hemi.ground), I = L.hemi.intensity
  // three.js: E(n) = I · mix(G, S, 0.5 + 0.5 n·up) = I (S+G)/2 + I (S−G)/2 (n·up); shGetIrradianceAt gives
  // E = 0.886227 L00 + 1.023328 (L1−1 y + L10 z + L11 x) + …, with coefficients ordered [L00, L1−1(y), L10(z), L11(x), …].
  const up = worldToCamera(cam, [0, 1, 0])
  const sh = Array.from({ length: 9 }, () => [0, 0, 0])
  for (let c = 0; c < 3; c++) {
    sh[0][c] = I * (S[c] + G[c]) / 2 / 0.886227
    const k = I * (S[c] - G[c]) / 2 / (2 * 0.511664)
    sh[1][c] = k * up[1]; sh[2][c] = k * up[2]; sh[3][c] = k * up[0]
  }
  const dirW = norm3(dirToScene(s.pose, L.sun.position.map((v, i) => v - L.sun.target[i])))   // the scene's frame
  const col = hexLinear(L.sun.color), m = Math.max(...col)
  const r6 = (v) => Math.round(v * 1e6) / 1e6
  // white balance: the mean irradiance over the normals a placed piece shows the camera (up, the sides, the front)
  const refN = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [1, 0, 1], [-1, 0, 1]].map(norm3)
  const tot = [0, 1, 2].map((c) => refN.reduce((acc, n) => acc + I * (G[c] + (S[c] - G[c]) * (0.5 + 0.5 * n[1]))
    + L.sun.intensity * col[c] * Math.max(0, n[0] * dirW[0] + n[1] * dirW[1] + n[2] * dirW[2]), 0) / refN.length)
  const Y = 0.2126 * tot[0] + 0.7152 * tot[1] + 0.0722 * tot[2]
  return {
    version: 1, source: 'truth', frame: 'camera', image: { w: s.w, h: s.h }, camera: cam,
    ambient: { sh: sh.map((c) => c.map(r6)) },
    key: { direction: norm3(worldToCamera(cam, dirW)).map(r6), color: col.map((v) => r6(v / m)), intensity: r6(L.sun.intensity * m), softness: 0.15, confidence: 1 },
    white_balance: { rgb: tot.map((v) => r6(v / Y)), cct_k: Math.round(cct(tot)) },
    world: { key_direction: dirW.map(r6), note: s.pose ? "truth only: the key direction in the scene's own frame (its world), for evals" : 'truth only: the key direction in the world frame, for evals' },
  }
}

// The room (meters, Y-up, floor y = 0; the camera stands at x = z = 0 and looks along -Z). Same for every scene.
const ROOM = { x0: -2.6, x1: 2.6, z0: -5.0, z1: 1.2, h: 2.7 }
// Measured objects: footprint center on the floor, size (w along local X, h, d along local Z), yaw like
// rotation_y_deg (counterclockwise seen from above). Parts are boxes in the object's local frame
// (center of the part box), so the checker can rasterize the exact silhouette.
const OBJECTS = {
  sofa: { center: [-0.3, 0, -3.3], size: { w: 2.0, h: 0.82, d: 0.9 }, rotation_y_deg: 0,
    parts: [{ name: 'body', center: [0, 0.41, 0], size: [2.0, 0.82, 0.9] }] },
  table: { center: [0.25, 0, -2.25], size: { w: 1.0, h: 0.42, d: 0.55 }, rotation_y_deg: 12,
    parts: [
      { name: 'top', center: [0, 0.40, 0], size: [1.0, 0.04, 0.55] },
      ...[[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([sx, sz], i) => ({ name: `leg-${i}`, center: [sx * 0.475, 0.19, sz * 0.25], size: [0.05, 0.38, 0.05] })),
    ] },
}
// Open floor, clear of objects and the rug, visible in every scene: depth.png is 0 there.
const FLOOR_POINTS = [[1.2, 0, -3.0], [1.6, 0, -3.4], [1.4, 0, -4.4], [2.2, 0, -4.6]]

// --- geometry shared with the checker -------------------------------------------------------------------------
const rad = (d) => d * Math.PI / 180
const yawed = (c, deg, [x, y, z]) => { const a = rad(deg); return [c[0] + Math.cos(a) * x + Math.sin(a) * z, c[1] + y, c[2] - Math.sin(a) * x + Math.cos(a) * z] }
const r6 = (v) => Math.round(v * 1e6) / 1e6
// Box corners in a fixed order: bottom ring then top ring, each back-left, back-right, front-right, front-left
// (back = local -Z, front = local +Z).
const CORNER_NAMES = ['bottom-back-left', 'bottom-back-right', 'bottom-front-right', 'bottom-front-left', 'top-back-left', 'top-back-right', 'top-front-right', 'top-front-left']
function boxCorners(center, deg, [cx, cy, cz], [w, h, d]) {
  const ring = [[-1, -1], [1, -1], [1, 1], [-1, 1]]
  return [-1, 1].flatMap((sy) => ring.map(([sx, sz]) => yawed(center, deg, [cx + sx * w / 2, cy + sy * h / 2, cz + sz * d / 2]).map(r6)))
}
// Contract §4.1: world point -> photo pixel (continuous, origin at the top-left corner of the top-left pixel).
export function project(cam, W, H, p) {
  const pt = rad(cam.pitch_deg), rl = rad(cam.roll_deg)
  // R = Ry(0) · Rx(pitch) · Rz(roll) (three.js Euler 'YXZ'); camera = R^T (p - C)
  const cp = Math.cos(pt), sp = Math.sin(pt), cr = Math.cos(rl), sr = Math.sin(rl)
  const R = [[cr, -sr, 0], [cp * sr, cp * cr, -sp], [sp * sr, sp * cr, cp]]
  const v = [p[0], p[1] - cam.height_m, p[2]]
  const c = [0, 1, 2].map((j) => R[0][j] * v[0] + R[1][j] * v[1] + R[2][j] * v[2])
  const depth = -c[2], f = (H / 2) / Math.tan(rad(cam.fov_y_deg) / 2)
  return { px: W / 2 + f * c[0] / depth, py: H / 2 - f * c[1] / depth, depth }
}

// --- the page ---------------------------------------------------------------------------------------------------
const PAGE = `<!doctype html><html><body style="margin:0;background:#000">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">
import * as THREE from 'three'
const { ROOM, OBJECTS } = window.CFG
const seeded = (s) => { let x = s >>> 0; return () => (x = (Math.imul(x, 1664525) + 1013904223) >>> 0) / 4294967296 }
const canvas = (w, h) => { const c = document.createElement('canvas'); c.width = w; c.height = h; return c }
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
renderer.setPixelRatio(1)
renderer.outputColorSpace = THREE.SRGBColorSpace
renderer.toneMapping = THREE.ACESFilmicToneMapping
renderer.toneMappingExposure = 1.0
renderer.shadowMap.enabled = true
renderer.shadowMap.type = THREE.PCFSoftShadowMap
document.body.appendChild(renderer.domElement)
const ANISO = renderer.capabilities.getMaxAnisotropy()
function tex(c, repeat = [1, 1]) {
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); t.anisotropy = ANISO
  return t
}
function speckle(g, w, h, rnd, n, alpha, size = 3) {
  for (let i = 0; i < n; i++) {
    g.fillStyle = (rnd() < 0.5 ? 'rgba(0,0,0,' : 'rgba(255,255,255,') + (rnd() * alpha) + ')'
    const s = 0.5 + rnd() * size; g.fillRect(rnd() * w, rnd() * h, s, s)
  }
}
function blotches(g, w, h, rnd, n, rgb, alpha, rmin, rmax) {
  for (let i = 0; i < n; i++) {
    const x = rnd() * w, y = rnd() * h, r = rmin + rnd() * (rmax - rmin)
    const gr = g.createRadialGradient(x, y, 0, x, y, r)
    gr.addColorStop(0, 'rgba(' + rgb + ',' + (alpha * rnd()) + ')'); gr.addColorStop(1, 'rgba(' + rgb + ',0)')
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r)
  }
}

// Oak floor: 15 cm planks running along Z, staggered butt joints, grain, the odd knot. One tile = 2.4 m square.
function floorTex() {
  const rnd = seeded(11), S = 2048, n = 16, pw = S / n, c = canvas(S, S), g = c.getContext('2d')
  for (let i = 0; i < n; i++) {
    let y = -rnd() * S * 0.6
    while (y < S) {
      const len = S * (0.32 + rnd() * 0.42), t = rnd()
      const base = [150 + t * 55, 104 + t * 40, 62 + t * 26]
      const x0 = i * pw
      const grad = g.createLinearGradient(x0, 0, x0 + pw, 0)
      grad.addColorStop(0, 'rgb(' + base.map((v) => v * 0.94).join(',') + ')')
      grad.addColorStop(0.5, 'rgb(' + base.join(',') + ')')
      grad.addColorStop(1, 'rgb(' + base.map((v) => v * 0.9).join(',') + ')')
      g.fillStyle = grad; g.fillRect(x0, y, pw, len)
      for (let k = 0; k < 34; k++) {
        const gx = x0 + 3 + rnd() * (pw - 6), amp = 1 + rnd() * 4, ph = rnd() * 6.28, fr = 2 + rnd() * 4
        g.strokeStyle = 'rgba(' + (70 + rnd() * 30) + ',' + (40 + rnd() * 20) + ',18,' + (0.06 + rnd() * 0.16) + ')'
        g.lineWidth = 0.5 + rnd() * 1.8
        g.beginPath(); g.moveTo(gx, y)
        for (let s = 0; s <= 1.0001; s += 0.04) g.lineTo(gx + Math.sin(ph + s * fr * 6.28) * amp, y + s * len)
        g.stroke()
      }
      if (rnd() < 0.3) {
        const kx = x0 + pw * (0.25 + rnd() * 0.5), ky = y + len * rnd()
        for (let r = 9; r > 1; r -= 2) { g.strokeStyle = 'rgba(60,32,12,' + (0.12 + (9 - r) * 0.05) + ')'; g.lineWidth = 1.2; g.beginPath(); g.ellipse(kx, ky, r * 0.8, r * 2.2, 0, 0, 7); g.stroke() }
      }
      g.fillStyle = 'rgba(38,20,8,0.85)'; g.fillRect(x0, y, pw, 3)
      y += len
    }
    g.fillStyle = 'rgba(38,20,8,0.9)'; g.fillRect(i * pw, 0, 3, S)
  }
  speckle(g, S, S, rnd, 9000, 0.05, 2)
  return tex(c, [(ROOM.x1 - ROOM.x0) / 2.4, (ROOM.z1 - ROOM.z0) / 2.4])
}
// Plaster: warm off-white, cloudy trowel marks, fine sand. One tile = 2 m square.
function plasterTex(base, seed) {
  const rnd = seeded(seed), S = 1024, c = canvas(S, S), g = c.getContext('2d')
  g.fillStyle = base; g.fillRect(0, 0, S, S)
  blotches(g, S, S, rnd, 140, '255,255,255', 0.10, 40, 180)
  blotches(g, S, S, rnd, 140, '120,100,80', 0.045, 40, 200)
  for (let i = 0; i < 260; i++) {
    const x = rnd() * S, y = rnd() * S, a = rnd() * 6.28, l = 30 + rnd() * 120
    g.strokeStyle = 'rgba(' + (rnd() < 0.5 ? '255,255,255' : '110,95,80') + ',' + (0.012 + rnd() * 0.02) + ')'
    g.lineWidth = 6 + rnd() * 18; g.lineCap = 'round'
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + Math.cos(a + 1) * l, y + Math.sin(a + 1) * l, x + Math.cos(a) * l * 1.6, y + Math.sin(a) * l * 1.6); g.stroke()
  }
  speckle(g, S, S, rnd, 60000, 0.07, 1.5)
  return c
}
function rugTex() {
  const rnd = seeded(23), W = 1440, H = 1020, c = canvas(W, H), g = c.getContext('2d')
  g.fillStyle = '#7d2a26'; g.fillRect(0, 0, W, H)
  const band = (m, w, col) => { g.strokeStyle = col; g.lineWidth = w; g.strokeRect(m, m, W - 2 * m, H - 2 * m) }
  band(40, 46, '#1f2e4a'); band(40, 8, '#e3c98e'); band(86, 6, '#e3c98e'); band(120, 22, '#c7843c')
  for (let i = 0; i < 70; i++) { // border motifs
    const t = i / 70, per = 2 * (W + H - 4 * 63), d = t * per
    let x, y
    if (d < W - 126) { x = 63 + d; y = 63 } else if (d < W - 126 + H - 126) { x = W - 63; y = 63 + d - (W - 126) } else if (d < 2 * (W - 126) + H - 126) { x = W - 63 - (d - (W - 126) - (H - 126)); y = H - 63 } else { x = 63; y = H - 63 - (d - 2 * (W - 126) - (H - 126)) }
    g.fillStyle = i % 2 ? '#e3c98e' : '#9c3b2c'; g.beginPath(); g.moveTo(x, y - 12); g.lineTo(x + 12, y); g.lineTo(x, y + 12); g.lineTo(x - 12, y); g.fill()
  }
  for (let r = 300; r > 20; r -= 28) { // medallion
    g.fillStyle = ['#1f2e4a', '#e3c98e', '#9c3b2c', '#c7843c', '#2f5a52'][(r / 28 | 0) % 5]
    g.beginPath(); for (let k = 0; k <= 16; k++) { const a = k / 16 * 6.283, rr = r * (k % 2 ? 0.82 : 1); g.lineTo(W / 2 + Math.cos(a) * rr * 1.25, H / 2 + Math.sin(a) * rr * 0.85) } g.fill()
  }
  for (let i = 0; i < 160; i++) { // field motifs
    const x = 170 + rnd() * (W - 340), y = 170 + rnd() * (H - 340)
    if (Math.hypot((x - W / 2) / 1.25, (y - H / 2) / 0.85) < 320) continue
    g.fillStyle = ['#e3c98e', '#1f2e4a', '#c7843c', '#2f5a52'][i % 4]; g.globalAlpha = 0.85
    g.beginPath(); g.arc(x, y, 6 + rnd() * 9, 0, 7); g.fill(); g.globalAlpha = 1
  }
  speckle(g, W, H, rnd, 70000, 0.22, 2.5)
  return tex(c)
}
function fabricTex(seams, base = '#5f7270', seed = 31) {
  const rnd = seeded(seed), S = 1024, c = canvas(S, S), g = c.getContext('2d')
  g.fillStyle = base; g.fillRect(0, 0, S, S)
  for (let y = 0; y < S; y += 3) { g.fillStyle = 'rgba(0,0,0,' + (0.04 + rnd() * 0.05) + ')'; g.fillRect(0, y, S, 1) }
  for (let x = 0; x < S; x += 3) { g.fillStyle = 'rgba(255,255,255,' + (0.02 + rnd() * 0.04) + ')'; g.fillRect(x, 0, 1, S) }
  blotches(g, S, S, rnd, 40, '0,0,0', 0.08, 60, 200)
  for (const s of seams) { g.fillStyle = 'rgba(25,32,32,0.75)'; s(g, S) }
  speckle(g, S, S, rnd, 20000, 0.08, 2)
  return tex(c)
}
function walnutTex() {
  const rnd = seeded(41), S = 512, c = canvas(S, S), g = c.getContext('2d')
  g.fillStyle = '#5a3a22'; g.fillRect(0, 0, S, S)
  for (let k = 0; k < 120; k++) {
    const y0 = rnd() * S, amp = 2 + rnd() * 8, ph = rnd() * 6.28
    g.strokeStyle = 'rgba(' + (rnd() < 0.5 ? '30,16,8' : '120,80,50') + ',' + (0.1 + rnd() * 0.2) + ')'; g.lineWidth = 0.6 + rnd() * 2
    g.beginPath(); for (let x = 0; x <= S; x += 8) g.lineTo(x, y0 + Math.sin(ph + x / 60) * amp); g.stroke()
  }
  return tex(c)
}
function skyTex() {
  const rnd = seeded(51), W = 1024, H = 1024, c = canvas(W, H), g = c.getContext('2d')
  const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#7fb1e3'); sky.addColorStop(0.65, '#d9e9f5'); sky.addColorStop(1, '#eef4f4')
  g.fillStyle = sky; g.fillRect(0, 0, W, H)
  blotches(g, W, H * 0.5, rnd, 40, '255,255,255', 0.6, 40, 140)
  g.fillStyle = '#c9c2b6'; g.fillRect(560, 520, 300, 300); g.fillStyle = '#9a8f80'; for (let y = 545; y < 800; y += 50) for (let x = 580; x < 840; x += 55) g.fillRect(x, y, 30, 30)
  for (let i = 0; i < 26; i++) { g.fillStyle = 'hsl(' + (95 + rnd() * 40) + ',' + (25 + rnd() * 25) + '%,' + (22 + rnd() * 18) + '%)'; g.beginPath(); g.arc(rnd() * W, 700 + rnd() * 260, 50 + rnd() * 90, 0, 7); g.fill() }
  g.fillStyle = '#5d6b4a'; g.fillRect(0, 930, W, 94)
  return tex(c)
}
function doorTex() {
  const rnd = seeded(61), W = 512, H = 1200, c = canvas(W, H), g = c.getContext('2d')
  g.fillStyle = '#ece8df'; g.fillRect(0, 0, W, H)
  const panel = (x, y, w, h) => {
    g.fillStyle = '#e2ddd2'; g.fillRect(x, y, w, h)
    g.strokeStyle = 'rgba(0,0,0,0.25)'; g.lineWidth = 6; g.beginPath(); g.moveTo(x, y + h); g.lineTo(x, y); g.lineTo(x + w, y); g.stroke()
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.beginPath(); g.moveTo(x + w, y); g.lineTo(x + w, y + h); g.lineTo(x, y + h); g.stroke()
  }
  for (const [x, y, w, h] of [[60, 60, 170, 330], [282, 60, 170, 330], [60, 450, 170, 330], [282, 450, 170, 330], [60, 840, 170, 300], [282, 840, 170, 300]]) panel(x, y, w, h)
  speckle(g, W, H, rnd, 8000, 0.04, 2)
  return tex(c)
}
function artTex() {
  const rnd = seeded(71), W = 900, H = 600, c = canvas(W, H), g = c.getContext('2d')
  g.fillStyle = '#efe6d2'; g.fillRect(0, 0, W, H)
  for (let i = 0; i < 18; i++) { g.fillStyle = 'hsla(' + (10 + rnd() * 50 + (i % 3) * 90) + ',55%,' + (35 + rnd() * 30) + '%,0.85)'; g.fillRect(rnd() * W * 0.8, rnd() * H * 0.8, 80 + rnd() * 260, 40 + rnd() * 200) }
  g.strokeStyle = '#1c1c1c'; g.lineWidth = 7; g.beginPath(); g.moveTo(80, 500); g.bezierCurveTo(300, 100, 600, 600, 820, 140); g.stroke()
  return tex(c)
}

const scene = new THREE.Scene(); scene.background = new THREE.Color(0x000000)
const lam = (opts) => new THREE.MeshLambertMaterial(opts)
const std = (opts) => new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, ...opts })
function mesh(geo, mat, pos, rotY = 0, parent = scene) {
  const m = new THREE.Mesh(geo, mat); m.position.set(...pos); m.rotation.y = rotY; m.castShadow = true; m.receiveShadow = true; parent.add(m); return m
}
const box = (w, h, d, mat, pos, rotY = 0, parent) => mesh(new THREE.BoxGeometry(w, h, d), mat, pos, rotY, parent)

// Room shell
const RW = ROOM.x1 - ROOM.x0, RD = ROOM.z1 - ROOM.z0, cx = (ROOM.x0 + ROOM.x1) / 2, cz = (ROOM.z0 + ROOM.z1) / 2
const floor = new THREE.Mesh(new THREE.PlaneGeometry(RW, RD), std({ map: floorTex(), roughness: 0.55 }))
floor.rotation.x = -Math.PI / 2; floor.position.set(cx, 0, cz); floor.receiveShadow = true; scene.add(floor)
const ceil = new THREE.Mesh(new THREE.PlaneGeometry(RW, RD), lam({ map: tex(plasterTex('#f3f1ec', 81), [RW / 2, RD / 2]) }))
ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, ROOM.h, cz); scene.add(ceil)
function wall(len, pos, rotY, base, seed) {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(len, ROOM.h), lam({ map: tex(plasterTex(base, seed), [len / 2, ROOM.h / 2]) }))
  m.position.set(...pos); m.rotation.y = rotY; m.receiveShadow = true; scene.add(m)
  return m
}
wall(RW, [cx, ROOM.h / 2, ROOM.z0], 0, '#e9e1d3', 91)                    // back wall, faces +Z
wall(RD, [ROOM.x0, ROOM.h / 2, cz], Math.PI / 2, '#e4ddd0', 92)          // left wall, faces +X
wall(RD, [ROOM.x1, ROOM.h / 2, cz], -Math.PI / 2, '#e6dfd2', 93)         // right wall, faces -X
wall(RW, [cx, ROOM.h / 2, ROOM.z1], Math.PI, '#e9e1d3', 94)              // behind the camera
const white = lam({ color: 0xf4f2ee })
box(RW, 0.09, 0.015, white, [cx, 0.045, ROOM.z0 + 0.0075])               // baseboards
box(0.015, 0.09, RD, white, [ROOM.x0 + 0.0075, 0.045, cz])
box(0.015, 0.09, RD, white, [ROOM.x1 - 0.0075, 0.045, cz])
box(RW, 0.05, 0.03, white, [cx, ROOM.h - 0.025, ROOM.z0 + 0.015])         // crown molding

// Door in the back wall (left): slab, casing, handle
const doorX = -1.75, doorW = 0.86, doorH = 2.05, zb = ROOM.z0
const slab = new THREE.Mesh(new THREE.PlaneGeometry(doorW, doorH), lam({ map: doorTex() })); slab.position.set(doorX, doorH / 2, zb + 0.004); slab.receiveShadow = true; scene.add(slab)
const casing = lam({ color: 0xf6f4ef })
box(0.075, doorH + 0.075, 0.025, casing, [doorX - doorW / 2 - 0.0375, (doorH + 0.075) / 2, zb + 0.0125])
box(0.075, doorH + 0.075, 0.025, casing, [doorX + doorW / 2 + 0.0375, (doorH + 0.075) / 2, zb + 0.0125])
box(doorW + 0.15, 0.075, 0.025, casing, [doorX, doorH + 0.0375, zb + 0.0125])
mesh(new THREE.SphereGeometry(0.03, 16, 12), std({ color: 0xb8a067, metalness: 0.8, roughness: 0.3 }), [doorX + doorW / 2 - 0.08, 1.0, zb + 0.06])

// Window in the back wall (right): sky behind glass, frame, mullions, sill
const winX = 1.25, winW = 1.4, winY0 = 0.9, winH = 1.3
const glass = new THREE.Mesh(new THREE.PlaneGeometry(winW, winH), new THREE.MeshBasicMaterial({ map: skyTex() })); glass.position.set(winX, winY0 + winH / 2, zb + 0.004); scene.add(glass)
const frameM = lam({ color: 0xf7f6f2 })
box(winW + 0.12, 0.06, 0.05, frameM, [winX, winY0 + winH + 0.03, zb + 0.025])
box(winW + 0.12, 0.06, 0.05, frameM, [winX, winY0 - 0.03, zb + 0.025])
box(0.06, winH, 0.05, frameM, [winX - winW / 2 - 0.03, winY0 + winH / 2, zb + 0.025])
box(0.06, winH, 0.05, frameM, [winX + winW / 2 + 0.03, winY0 + winH / 2, zb + 0.025])
box(0.035, winH, 0.03, frameM, [winX, winY0 + winH / 2, zb + 0.015])
box(winW, 0.035, 0.03, frameM, [winX, winY0 + winH * 0.62, zb + 0.015])
box(winW + 0.26, 0.035, 0.16, frameM, [winX, winY0 - 0.075, zb + 0.08])

// Painting above the sofa, rug, floor lamp
const art = new THREE.Mesh(new THREE.PlaneGeometry(1.05, 0.7), lam({ map: artTex() })); art.position.set(-0.3, 1.62, zb + 0.032); scene.add(art)
box(1.13, 0.78, 0.025, lam({ color: 0x2a211a }), [-0.3, 1.62, zb + 0.0125])
const rug = new THREE.Mesh(new THREE.PlaneGeometry(2.4, 1.7), lam({ map: rugTex(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
rug.rotation.x = -Math.PI / 2; rug.position.set(-0.1, 0.003, -2.45); rug.receiveShadow = true; scene.add(rug)
const black = std({ color: 0x1b1b1b, roughness: 0.4, metalness: 0.6 })
mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 32), black, [1.95, 0.015, -3.9])
mesh(new THREE.CylinderGeometry(0.012, 0.012, 1.45, 12), black, [1.95, 0.75, -3.9])
const shade = mesh(new THREE.CylinderGeometry(0.17, 0.23, 0.3, 40, 1, true), lam({ color: 0xf1e3c6, side: THREE.DoubleSide }), [1.95, 1.55, -3.9])

// --- furnishings for the golden room's other photos (contract §5.1) ---------------------------------------------------
// Outside every original camera's view (living-wide, steep-roll, portrait never see them, and they cast no shadow, so
// re-rendering those scenes gives the same pixels as without them: docs/notes/rooms-foundation.md): a bookshelf, a
// console with a poster above it and a second door on the front wall (z = 1.2), an armchair near it, a sideboard with
// a print and a plant on the left wall's front half, a pendant lamp (no light of its own). The right wall stays bare.
function booksTex() {
  const rnd = seeded(101), W = 768, H = 1280, c = canvas(W, H), g = c.getContext('2d')
  g.fillStyle = '#4a3220'; g.fillRect(0, 0, W, H)
  const rows = 5, rh = H / rows
  for (let r = 0; r < rows; r++) {
    const y1 = (r + 1) * rh - 18
    g.fillStyle = '#2b1c10'; g.fillRect(24, r * rh + 8, W - 48, rh - 26)
    let x = 30
    while (x < W - 40) {
      const bw = 14 + rnd() * 30, bh = rh * (0.55 + rnd() * 0.35)
      if (rnd() < 0.08) { x += bw * 1.5; continue }
      g.fillStyle = 'hsl(' + Math.floor(rnd() * 360) + ',' + (30 + rnd() * 45) + '%,' + (22 + rnd() * 40) + '%)'
      g.fillRect(x, y1 - bh, bw - 2, bh)
      g.fillStyle = 'rgba(255,240,200,' + (0.25 + rnd() * 0.4) + ')'
      for (let k = 0; k < 2; k++) g.fillRect(x + 3, y1 - bh + 14 + k * (bh * 0.55), bw - 8, 3)
      x += bw
    }
    g.fillStyle = '#6a4a30'; g.fillRect(0, y1, W, 18)
  }
  g.fillStyle = '#6a4a30'; g.fillRect(0, 0, 24, H); g.fillRect(W - 24, 0, 24, H); g.fillRect(0, 0, W, 10)
  speckle(g, W, H, rnd, 9000, 0.08, 2)
  return tex(c)
}
function posterTex() {
  const rnd = seeded(111), W = 880, H = 600, c = canvas(W, H), g = c.getContext('2d')
  g.fillStyle = '#f2ead8'; g.fillRect(0, 0, W, H)
  for (let i = 0; i < 9; i++) {
    g.fillStyle = ['#d0542c', '#2c5d8a', '#e3b23c', '#3e7d5a', '#1d1d1d'][i % 5]
    g.beginPath(); g.arc(120 + rnd() * (W - 240), 100 + rnd() * (H - 200), 30 + rnd() * 110, 0, 7); g.fill()
  }
  g.strokeStyle = '#1d1d1d'; g.lineWidth = 10
  for (let i = 0; i < 4; i++) { g.beginPath(); g.moveTo(rnd() * W, 0); g.lineTo(rnd() * W, H); g.stroke() }
  g.fillStyle = '#1d1d1d'; g.font = 'bold 54px sans-serif'; g.fillText('MIDSTUDY 26', 40, H - 40)
  return tex(c)
}
function printTex() {
  const rnd = seeded(121), W = 600, H = 760, c = canvas(W, H), g = c.getContext('2d')
  const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#f6c88a'); sky.addColorStop(0.55, '#e98b6d'); sky.addColorStop(1, '#5a3d5c')
  g.fillStyle = sky; g.fillRect(0, 0, W, H)
  for (let k = 0; k < 4; k++) {
    g.fillStyle = ['#3d2c4e', '#2c2240', '#211a33', '#16121f'][k]; g.beginPath(); g.moveTo(0, H)
    for (let x = 0; x <= W; x += 20) g.lineTo(x, H * (0.5 + k * 0.12) + Math.sin(x / (60 + k * 30) + k) * 40 + rnd() * 10)
    g.lineTo(W, H); g.fill()
  }
  g.fillStyle = '#fff3d6'; g.beginPath(); g.arc(W * 0.7, H * 0.28, 50, 0, 7); g.fill()
  return tex(c)
}
function drawersTex() {
  const rnd = seeded(131), W = 1100, H = 840, c = canvas(W, H), g = c.getContext('2d')
  g.fillStyle = '#7a5434'; g.fillRect(0, 0, W, H)
  for (let k = 0; k < 160; k++) {
    const y0 = rnd() * H, amp = 2 + rnd() * 6, ph = rnd() * 6.28
    g.strokeStyle = 'rgba(' + (rnd() < 0.5 ? '40,24,12' : '150,110,70') + ',' + (0.1 + rnd() * 0.2) + ')'; g.lineWidth = 0.6 + rnd() * 2
    g.beginPath(); for (let x = 0; x <= W; x += 10) g.lineTo(x, y0 + Math.sin(ph + x / 70) * amp); g.stroke()
  }
  g.strokeStyle = 'rgba(25,14,6,0.9)'; g.lineWidth = 6
  for (const [x, y, w, h] of [[30, 30, 500, 240], [570, 30, 500, 240], [30, 300, 1040, 240], [30, 570, 1040, 240]]) {
    g.strokeRect(x, y, w, h); g.fillStyle = '#c9b48a'; g.fillRect(x + w / 2 - 40, y + h / 2 - 7, 80, 14)
  }
  return tex(c)
}
function rugTex2() {
  const rnd = seeded(141), W = 800, H = 1200, c = canvas(W, H), g = c.getContext('2d')
  g.fillStyle = '#d9d2c3'; g.fillRect(0, 0, W, H)
  for (let y = 0; y < H; y += 60) { g.fillStyle = (y / 60) % 2 ? '#3b4d63' : '#b5603f'; g.fillRect(0, y, W, 22) }
  speckle(g, W, H, rnd, 40000, 0.18, 2)
  return tex(c)
}
const beforeDecor = new Set(scene.children)
const walnut2 = std({ map: walnutTex(), roughness: 0.5 })
// bookshelf (front wall, left)
box(1.2, 2.0, 0.32, [walnut2, walnut2, walnut2, walnut2, walnut2, lam({ map: booksTex() })], [-1.85, 1.0, 1.2 - 0.16])   // books on its -Z face
// console, its things, the poster above it
const consoleTop = std({ map: drawersTex(), roughness: 0.5 })   // BoxGeometry faces: +x, -x, +y, -y, +z, -z
box(1.3, 0.5, 0.4, [walnut2, walnut2, walnut2, walnut2, walnut2, consoleTop], [-0.3, 0.29, 1.2 - 0.2])   // drawers on its -Z face
for (const sx of [-0.6, 0.6]) for (const sz of [-0.15, 0.15]) box(0.04, 0.04, 0.04, black, [-0.3 + sx, 0.02, 1.0 + sz])
mesh(new THREE.CylinderGeometry(0.07, 0.1, 0.32, 24), std({ color: 0x2f6d8c, roughness: 0.3 }), [-0.75, 0.70, 1.02])
box(0.28, 0.06, 0.2, lam({ color: 0xc23b22 }), [0.05, 0.57, 1.0]); box(0.24, 0.05, 0.18, lam({ color: 0xe8d9b0 }), [0.05, 0.625, 1.0])
const poster = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.75), lam({ map: posterTex() })); poster.rotation.y = Math.PI; poster.position.set(-0.3, 1.55, 1.2 - 0.03); scene.add(poster)
box(1.16, 0.81, 0.02, lam({ color: 0xe8e4dc }), [-0.3, 1.55, 1.2 - 0.012])
// a second door (front wall, right), casing, handle
const door2 = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 2.05), lam({ map: doorTex() })); door2.rotation.y = Math.PI; door2.position.set(1.75, 2.05 / 2, 1.2 - 0.004); scene.add(door2)
box(0.075, 2.125, 0.025, casing, [1.75 - 0.43 - 0.0375, 2.125 / 2, 1.2 - 0.0125]); box(0.075, 2.125, 0.025, casing, [1.75 + 0.43 + 0.0375, 2.125 / 2, 1.2 - 0.0125])
box(1.01, 0.075, 0.025, casing, [1.75, 2.05 + 0.0375, 1.2 - 0.0125])
mesh(new THREE.SphereGeometry(0.03, 16, 12), std({ color: 0xb8a067, metalness: 0.8, roughness: 0.3 }), [1.75 - 0.35, 1.0, 1.2 - 0.06])
// armchair (mustard), turned to face the room
const chair = new THREE.Group(); chair.position.set(0.95, 0, 0.35); chair.rotation.y = Math.PI + 0.35; scene.add(chair)
const mustard = lam({ map: fabricTex([], '#b8892c', 33) })
box(0.85, 0.2, 0.8, mustard, [0, 0.32, 0.02], 0, chair); box(0.85, 0.5, 0.16, mustard, [0, 0.62, -0.34], 0, chair)
for (const sx of [-1, 1]) box(0.12, 0.32, 0.8, mustard, [sx * 0.365, 0.52, 0.02], 0, chair)
for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(0.04, 0.22, 0.04, walnut2, [sx * 0.36, 0.11, sz * 0.33], 0, chair)
// a small striped rug in front of the console
const rug2 = new THREE.Mesh(new THREE.PlaneGeometry(1.0, 1.5), lam({ map: rugTex2(), polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }))
rug2.rotation.x = -Math.PI / 2; rug2.rotation.z = Math.PI / 2; rug2.position.set(-0.6, 0.003, 0.45); rug2.receiveShadow = true; scene.add(rug2)
// sideboard, print and plant on the left wall (x = -2.6), front half
box(0.45, 0.72, 1.1, [lam({ map: drawersTex() }), walnut2, walnut2, walnut2, walnut2, walnut2], [-2.6 + 0.225, 0.48, -1.2])
for (const sz of [-0.5, 0.5]) for (const sx of [-0.18, 0.18]) box(0.04, 0.12, 0.04, black, [-2.375 + sx, 0.06, -1.2 + sz])
mesh(new THREE.CylinderGeometry(0.09, 0.09, 0.22, 24), std({ color: 0xe9e4da, roughness: 0.25 }), [-2.42, 0.95, -1.5])
mesh(new THREE.SphereGeometry(0.11, 20, 14), std({ color: 0x9c3b2c, roughness: 0.5 }), [-2.4, 0.95, -0.9])
const print = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 0.76), lam({ map: printTex() })); print.rotation.y = Math.PI / 2; print.position.set(-2.6 + 0.03, 1.55, -1.2); scene.add(print)
box(0.02, 0.84, 0.68, lam({ color: 0x1f1a16 }), [-2.6 + 0.012, 1.55, -1.2])
const pot = std({ color: 0xb4633a, roughness: 0.8 }), leaf = std({ color: 0x3f6b35, roughness: 0.7 })
mesh(new THREE.CylinderGeometry(0.2, 0.15, 0.38, 28), pot, [-2.2, 0.19, 0.55])
{ const rl = seeded(151); for (let i = 0; i < 9; i++) mesh(new THREE.SphereGeometry(0.13 + rl() * 0.09, 16, 12), leaf, [-2.2 + (rl() - 0.5) * 0.35, 0.55 + rl() * 0.65, 0.55 + (rl() - 0.5) * 0.35]) }
// pendant lamp over the front of the room (no light)
mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.45, 8), black, [0.0, 2.7 - 0.225, -0.55])
mesh(new THREE.CylinderGeometry(0.06, 0.22, 0.22, 36, 1, true), std({ color: 0x2b2b2b, roughness: 0.4, metalness: 0.5, side: THREE.DoubleSide }), [0.0, 2.7 - 0.56, -0.55])
// The furnishings cast no sun shadow: DAYLIGHT's sun comes from behind the original cameras, and their shadows would
// reach the floor those photos show (measured: living-wide, steep-roll and portrait changed; with this they don't).
for (const o of scene.children) if (!beforeDecor.has(o)) o.traverse((m) => { m.castShadow = false })

// Measured objects (truth.json): the sofa box and the table
const groups = {}
const sofaFront = fabricTex([(g, S) => { for (const x of [S / 3, 2 * S / 3]) g.fillRect(x - 2, S * 0.38, 4, S * 0.62) ; g.fillRect(0, S * 0.36, S, 5) }])
const sofaTop = fabricTex([(g, S) => { for (const x of [S / 3, 2 * S / 3]) g.fillRect(x - 2, 0, 4, S) ; g.fillRect(0, S * 0.22, S, 5) }])
const sofaSide = fabricTex([])
for (const [name, o] of Object.entries(OBJECTS)) {
  const grp = new THREE.Group(); grp.position.set(...o.center); grp.rotation.y = o.rotation_y_deg * Math.PI / 180; scene.add(grp); groups[name] = grp
  for (const p of o.parts) {
    let mat
    if (name === 'sofa') { const side = lam({ map: sofaSide }); mat = [side, side, lam({ map: sofaTop }), side, lam({ map: sofaFront }), side] }
    else mat = std({ map: walnutTex(), roughness: 0.45 })
    box(...p.size, mat, p.center, 0, grp)
  }
}

// Light: soft sky fill plus a sun patch; the lamp gives a warm accent. Set per scene from cfg.lights (DAYLIGHT for the
// first three scenes: hemisphere 0xfff6ea/0xb9a48c 1.9, sun 0xfff1df 2.2 from (3.2, 5, 1.5) to (−0.4, 0, −3), lamp 1.6).
const hemi = new THREE.HemisphereLight(0xffffff, 0xffffff, 1); scene.add(hemi)
const sun = new THREE.DirectionalLight(0xffffff, 1)
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.bias = -0.0004
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 15 })
scene.add(sun, sun.target)
const lampLight = new THREE.PointLight(0xffffff, 1, 4, 2); scene.add(lampLight)
function setLights(L) {
  hemi.color.setHex(L.hemi.sky); hemi.groundColor.setHex(L.hemi.ground); hemi.intensity = L.hemi.intensity
  sun.color.setHex(L.sun.color); sun.intensity = L.sun.intensity; sun.position.set(...L.sun.position); sun.target.position.set(...L.sun.target)
  sun.shadow.radius = L.sun.shadow_radius; sun.target.updateMatrixWorld(); sun.shadow.needsUpdate = true
  lampLight.color.setHex(L.lamp.color); lampLight.intensity = L.lamp.intensity; lampLight.position.set(...L.lamp.position)
  lampLight.distance = L.lamp.distance; lampLight.decay = L.lamp.decay
}

// --- renders -----------------------------------------------------------------------------------------------------
// A photo's camera in the room (world) frame: contract §4.1 in its own frame, moved by its pose (§4.9): at
// (x_m, height_m, z_m), turned by yaw about Y; three.js Euler 'YXZ' gives R = Ry(yaw) · Rx(pitch) · Rz(roll).
function camera(cam, W, H, pose) {
  const c = new THREE.PerspectiveCamera(cam.fov_y_deg, W / H, 0.05, 50)
  c.position.set(pose ? pose.x_m : 0, cam.height_m, pose ? pose.z_m : 0)
  c.rotation.set(cam.pitch_deg * Math.PI / 180, pose ? pose.yaw_deg * Math.PI / 180 : 0, cam.roll_deg * Math.PI / 180, 'YXZ')   // contract §4.1
  c.updateProjectionMatrix(); c.updateMatrixWorld(true)
  return c
}
const depthMat = new THREE.ShaderMaterial({
  side: THREE.DoubleSide,
  vertexShader: 'varying float vz; varying float wy; void main(){ vec4 wp = modelMatrix * vec4(position, 1.0); wy = wp.y; vec4 mv = viewMatrix * wp; vz = -mv.z; gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'varying float vz; varying float wy; void main(){ gl_FragColor = vec4(vz, wy, 0.0, 1.0); }',
})
const b64 = (u8) => { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s) }

window.renderScene = (cfg) => {
  const { W, H, DW, DH, cam } = cfg
  setLights(cfg.lights)
  renderer.setSize(W, H, false)
  const c = camera(cam, W, H, cfg.pose)
  renderer.setRenderTarget(null); renderer.render(scene, c)
  const photo = renderer.domElement.toDataURL('image/jpeg', 0.92)

  // Depth along the view axis at DW x DH (pixel centers), floor (world y < 4 cm) masked to 0.
  const rt = new THREE.WebGLRenderTarget(DW, DH, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true })
  const dc = camera(cam, DW, DH, cfg.pose)
  const bg = scene.background; scene.background = null
  scene.overrideMaterial = depthMat; renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, dc)
  const buf = new Float32Array(DW * DH * 4); renderer.readRenderTargetPixels(rt, 0, 0, DW, DH, buf)
  renderer.setRenderTarget(null); scene.overrideMaterial = null; scene.background = bg; rt.dispose()
  const mm = new Uint8Array(DW * DH * 2), raw = new Float32Array(DW * DH); let floorPx = 0, hit = 0
  for (let v = 0; v < DH; v++) for (let u = 0; u < DW; u++) {
    const o = ((DH - 1 - v) * DW + u) * 4, d = buf[o], wy = buf[o + 1], k = (v * DW + u) * 2   // render targets are bottom-up
    raw[v * DW + u] = d > 0 ? d : 0   // unmasked view-axis depth (m), for the room's overlap measure only
    let val = 0
    if (d > 0) { hit++; if (wy < 0.04) floorPx++; else val = Math.min(65535, Math.round(d * 1000)) }
    mm[k] = val >> 8; mm[k + 1] = val & 255
  }

  // Id masks, each object alone (no occlusion), antialiased like the photo: R = sofa, G = table.
  const visible = new Map(); scene.traverse((o) => { if (o.isMesh || o.isLight) visible.set(o, o.visible) })
  const out = canvas(W, H), og = out.getContext('2d', { willReadFrequently: true }); og.fillStyle = '#000'; og.fillRect(0, 0, W, H); og.globalCompositeOperation = 'lighter'
  const tm = renderer.toneMapping; renderer.toneMapping = THREE.NoToneMapping
  for (const [name, color] of [['sofa', 0xff0000], ['table', 0x00ff00]]) {
    for (const o of visible.keys()) o.visible = false
    groups[name].traverse((o) => { o.visible = true })
    scene.overrideMaterial = new THREE.MeshBasicMaterial({ color })
    renderer.render(scene, c); og.drawImage(renderer.domElement, 0, 0)
  }
  scene.overrideMaterial = null; renderer.toneMapping = tm
  for (const [o, v] of visible) o.visible = v
  const px = og.getImageData(0, 0, W, H).data, rg = new Uint8Array(W * H * 2)
  for (let i = 0; i < W * H; i++) { rg[2 * i] = px[4 * i]; rg[2 * i + 1] = px[4 * i + 1] }
  return { photo, depth: b64(mm), raw: b64(new Uint8Array(raw.buffer)), ids: b64(rg), floorRatio: floorPx / (DW * DH), hitRatio: hit / (DW * DH) }
}
window.READY = true
</script></body></html>`

// PNG writer: 16-bit grayscale (depth) or 8-bit RGB (ids), no filtering, deflate level 9.
function png(width, height, rows, bitDepth, colorType) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
    const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td))
    return Buffer.concat([len, td, crc])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = bitDepth; ihdr[9] = colorType
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows, { level: 9 })), chunk('IEND', Buffer.alloc(0))])
}
function idsPng(width, height, rg) {
  const stride = width * 3 + 1, raw = Buffer.alloc(stride * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) { const o = y * stride + 1 + x * 3, i = (y * width + x) * 2; raw[o] = rg[i]; raw[o + 1] = rg[i + 1] }
  return png(width, height, raw, 8, 2)
}
// The canvas JPEG carries an sRGB ICC profile (APP2). Keep only JFIF (APP0) and the image segments, so photo.jpg has
// no metadata at all and an ingest that passes clean JPEGs through unchanged keeps its SHA-256 (contract §4.3).
function stripJpeg(buf) {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) throw new Error('not a JPEG')
  const out = [buf.subarray(0, 2)]
  let i = 2
  while (i < buf.length) {
    if (buf[i] !== 0xff) throw new Error(`bad JPEG marker at ${i}`)
    const m = buf[i + 1]
    if (m === 0xda) { out.push(buf.subarray(i)); break }
    const len = buf.readUInt16BE(i + 2)
    const drop = (m >= 0xe1 && m <= 0xef) || m === 0xfe
    if (!drop) out.push(buf.subarray(i, i + 2 + len))
    i += 2 + len
  }
  return Buffer.concat(out)
}
function png16(width, height, bytes) {
  const raw = Buffer.alloc((width * 2 + 1) * height)
  for (let y = 0; y < height; y++) bytes.copy(raw, y * (width * 2 + 1) + 1, y * width * 2, (y + 1) * width * 2)
  return png(width, height, raw, 16, 0)
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex')
const json = (o) => JSON.stringify(o, null, 2) + '\n'

// lighting.json (truth) next to the photo and in the calib mock folder (contract §4.8, §5.1).
function writeLighting(s, photo) {
  const body = json(truthLighting(s))
  fs.writeFileSync(path.join(OUT, 'scenes', s.id, 'lighting.json'), body)
  const mock = path.join(OUT, 'calib', sha256(photo))
  fs.mkdirSync(mock, { recursive: true })
  fs.writeFileSync(path.join(mock, 'lighting.json'), body)
}
const selected = () => {
  if (ONLY_ARG) { const ids = ONLY_ARG.split(','); for (const id of ids) if (!ALL.some((s) => s.id === id)) throw new Error(`no scene ${id}`); return ALL.filter((s) => ids.includes(s.id)) }
  return ROOMS_ONLY ? ROOM_SCENES : ALL
}
// --lights-only: add `lights` to truth.json and write lighting.json for scenes already rendered, without rendering
// (the photos, and so their SHA-256 and the mock folders, stay as they are).
function lightsOnly() {
  for (const s of selected()) {
    const dir = path.join(OUT, 'scenes', s.id)
    const truth = JSON.parse(fs.readFileSync(path.join(dir, 'truth.json'), 'utf8'))
    fs.writeFileSync(path.join(dir, 'truth.json'), json({ ...truth, lights: sceneLights(s) }))
    writeLighting(s, fs.readFileSync(path.join(dir, 'photo.jpg')))
    console.log(`${s.id}: lights and lighting.json written (no render)`)
  }
}

// --- the golden room's truth (contract §4.9, §5.1) -------------------------------------------------------------------
// Camera-to-world rotation of a §4.1 camera (its own frame) and the focal length in pixels.
const camR = (cam) => { const pt = rad(cam.pitch_deg), rl = rad(cam.roll_deg), cp = Math.cos(pt), sp = Math.sin(pt), cr = Math.cos(rl), sr = Math.sin(rl); return [[cr, -sr, 0], [cp * sr, cp * cr, -sp], [sp * sr, sp * cr, cp]] }
const focal = (cam, H) => (H / 2) / Math.tan(rad(cam.fov_y_deg) / 2)
// Where everything in the room isn't open floor: the measured objects, the rugs, the lamp and the furnishings (room
// frame, x0 x1 z0 z1, with a margin). Floor points are picked outside these, and only where depth.png is 0 around them.
const NOT_OPEN = [[-1.45, 0.85, -3.95, -2.65], [-0.45, 0.95, -2.75, -1.75], [-1.45, 1.25, -3.45, -1.45], [1.55, 2.35, -4.3, -3.5],
  [-2.6, -1.1, 0.7, 1.2], [-1.1, 0.5, 0.6, 1.2], [-1.5, 0.3, -0.5, 1.2], [0.3, 1.6, -0.3, 1.0], [-2.6, -1.95, -1.95, -0.45], [-2.6, -1.75, 0.15, 0.95]]
function pickFloorPoints(s, r, DW, DH, mm) {
  const cand = []
  for (let x = -2.3; x <= 2.3001; x += 0.1) for (let z = -4.7; z <= 0.9001; z += 0.1) {
    const p = [+x.toFixed(2), 0, +z.toFixed(2)]
    if (NOT_OPEN.some(([x0, x1, z0, z1]) => p[0] > x0 - 0.15 && p[0] < x1 + 0.15 && p[2] > z0 - 0.15 && p[2] < z1 + 0.15)) continue
    const q = project(s.camera, DW, DH, roomToScene(s.pose, p))
    if (!(q.depth > 0.3) || q.px < 16 || q.py < 16 || q.px > DW - 16 || q.py > DH - 16) continue
    let open = true
    for (let dv = -3; dv <= 3 && open; dv++) for (let du = -3; du <= 3 && open; du++) { const k = ((Math.floor(q.py) + dv) * DW + Math.floor(q.px) + du) * 2; if (mm[k] || mm[k + 1]) open = false }
    if (open) cand.push({ p, q })
  }
  if (!cand.length) return []
  // four points spread over the photo: the one nearest its center, then each time the farthest from those chosen
  const chosen = [cand.reduce((a, b) => (Math.hypot(a.q.px - DW / 2, a.q.py - DH / 2) <= Math.hypot(b.q.px - DW / 2, b.q.py - DH / 2) ? a : b))]
  while (chosen.length < 4 && chosen.length < cand.length) {
    chosen.push(cand.reduce((best, c) => { const d = Math.min(...chosen.map((o) => Math.hypot(o.q.px - c.q.px, o.q.py - c.q.py))); return d > best.d ? { c, d } : best }, { c: null, d: -1 }).c)
  }
  return chosen.map(({ p }) => p)
}
// A bare stretch of wall the photo sees, for the self-check's view-axis depth test (the original scenes use the back
// wall at (2.2, 0.6, −5)): candidates on each wall, the first whose depth.png pixel and its neighbours are the plane's.
const WALLS = [
  { wall: 'back', point: (a, y) => [a, y, ROOM.z0], normal: [0, 0, 1], range: [ROOM.x0 + 0.2, ROOM.x1 - 0.2] },
  { wall: 'right', point: (a, y) => [ROOM.x1, y, a], normal: [-1, 0, 0], range: [ROOM.z0 + 0.2, ROOM.z1 - 0.2] },
  { wall: 'left', point: (a, y) => [ROOM.x0, y, a], normal: [1, 0, 0], range: [ROOM.z0 + 0.2, ROOM.z1 - 0.2] },
  { wall: 'front', point: (a, y) => [a, y, ROOM.z1], normal: [0, 0, -1], range: [ROOM.x0 + 0.2, ROOM.x1 - 0.2] },
]
function pickWall(s, DW, DH, mm) {
  const R = camR(s.camera), f = focal(s.camera, DH), C = [0, s.camera.height_m, 0]
  const planeMm = (u, v, P, n) => {
    const dc = [(u + 0.5 - DW / 2) / f, -(v + 0.5 - DH / 2) / f, -1], dir = [0, 1, 2].map((i) => R[i][0] * dc[0] + R[i][1] * dc[1] + R[i][2] * dc[2])
    const t = ((P[0] - C[0]) * n[0] + (P[1] - C[1]) * n[1] + (P[2] - C[2]) * n[2]) / (dir[0] * n[0] + dir[1] * n[1] + dir[2] * n[2])
    return t * 1000
  }
  let best = null
  for (const w of WALLS) {
    for (let a = w.range[0]; a <= w.range[1] + 1e-9; a += 0.1) for (const y of [0.9, 1.2, 1.5, 1.8, 2.1]) {
      const P = roomToScene(s.pose, w.point(+a.toFixed(2), y)), n = dirToScene(s.pose, w.normal)
      const q = project(s.camera, DW, DH, P)
      if (!(q.depth > 0.3) || q.px < 4 || q.py < 4 || q.px > DW - 4 || q.py > DH - 4) continue
      const u = Math.floor(q.px), v = Math.floor(q.py)
      let ok = true
      for (let dv = -2; dv <= 2 && ok; dv++) for (let du = -2; du <= 2 && ok; du++) { const k = ((v + dv) * DW + u + du) * 2, got = (mm[k] << 8) | mm[k + 1]; if (!got || Math.abs(got - planeMm(u + du, v + dv, P, n)) > 1.5) ok = false }
      const score = Math.hypot(q.px - DW / 2, q.py - DH / 2)
      if (ok && (!best || score < best.score)) best = { score, wall: w.wall, point: P.map(r6), normal: n.map(r6) }
    }
    if (best) break
  }
  return best && { wall: best.wall, point: best.point, normal: best.normal, note: "a bare stretch of that wall, in this scene's frame: depth.png there is the plane's view-axis depth" }
}
// The share of photo a's points (its unmasked depth, floor included, every 6th pixel) that photo b sees: lifted to the
// room frame through a's pose, into b's frame, projected, and within 3 cm + 2 % of b's own depth there.
function overlapShare(a, b) {
  const Ra = camR(a.s.camera), fa = focal(a.s.camera, a.DH), Rb = camR(b.s.camera), fb = focal(b.s.camera, b.DH)
  let n = 0, seen = 0
  for (let v = 3; v < a.DH; v += 6) for (let u = 3; u < a.DW; u += 6) {
    const d = a.raw[v * a.DW + u]; if (!(d > 0)) continue
    n++
    const pc = [d * (u + 0.5 - a.DW / 2) / fa, -d * (v + 0.5 - a.DH / 2) / fa, -d]
    const pa = [0, 1, 2].map((i) => Ra[i][0] * pc[0] + Ra[i][1] * pc[1] + Ra[i][2] * pc[2] + (i === 1 ? a.s.camera.height_m : 0))
    const pb = roomToScene(b.s.pose, sceneToRoom(a.s.pose, pa))
    const w = [pb[0], pb[1] - b.s.camera.height_m, pb[2]], c = [0, 1, 2].map((j) => Rb[0][j] * w[0] + Rb[1][j] * w[1] + Rb[2][j] * w[2])
    const db = -c[2]; if (!(db > 0.05)) continue
    const x = b.DW / 2 + fb * c[0] / db, y = b.DH / 2 - fb * c[1] / db
    if (x < 0 || y < 0 || x >= b.DW || y >= b.DH) continue
    const got = b.raw[Math.floor(y) * b.DW + Math.floor(x)]
    if (got > 0 && Math.abs(got - db) < 0.03 + 0.02 * db) seen++
  }
  return n ? seen / n : 0
}
// The calib mock's key for a set of photos (contract §4.9 Mock): sha256 of the photos' sha256s (lowercase hex),
// sorted, joined with "\n" (no trailing newline).
export const roomMockKey = (photoShas) => sha256(Buffer.from([...photoShas].sort().join('\n'), 'utf8'))
const ALIGN_CREATED = '2026-11-06T00:00:00Z'   // fixed, so re-rendering changes only what the photos change
function writeRoomAnswers(shaOf) {
  const dir = path.join(OUT, 'calib', 'rooms')
  fs.rmSync(dir, { recursive: true, force: true })
  for (const set of ROOM_SETS) {
    const members = set.ids.map((id, i) => {
      const s = ALL.find((x) => x.id === id)
      return { scene: id, photo_sha256: shaOf(id), pose: s.pose ? { ...s.pose } : { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1, confidence: 1, residual_cm: i === 0 ? null : 0 }
    })
    const key = roomMockKey(members.map((m) => m.photo_sha256))
    const align = {
      version: 1, solver: 'truth', created: ALIGN_CREATED, elapsed_s: 0, device: null, loop_residual_cm: set.ids.length >= 3 ? 0 : null, members, unplaced: [],
      fixture: { name: set.name, note: 'the true poses of the golden room fixtures (fixtures/scenes/<scene>/truth.json pose_in_room), in living-wide\'s frame; scene is the fixture id, which the mock replaces with the scene folder whose photo.jpg has photo_sha256' },
    }
    fs.mkdirSync(path.join(dir, key), { recursive: true })
    fs.writeFileSync(path.join(dir, key, 'align.json'), json(align))
    console.log(`fixtures/calib/rooms/${key.slice(0, 12)}…: ${set.name} (${set.ids.join(', ')})`)
  }
}

async function main() {
  if (LIGHTS_ONLY) return lightsOnly()
  const todo = selected()
  const rooms = todo.some((s) => s.pose)
  // the room's overlap measure needs the room frame's photo too: render it without writing anything
  const renderAlso = rooms && !todo.some((s) => s.id === ROOM_FRAME) ? [ALL.find((s) => s.id === ROOM_FRAME)] : []
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
  const rendered = new Map()   // id -> {s, DW, DH, raw}
  try {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1600 } })
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.route('http://midstudy.local/**', (route) => {
      const p = new URL(route.request().url()).pathname
      if (p === '/gen.html') return route.fulfill({ contentType: 'text/html', body: PAGE })
      if (p.startsWith('/three/')) return route.fulfill({ path: path.join(REPO, 'node_modules', p), contentType: 'text/javascript' })
      return route.fulfill({ status: 404, body: 'not found' })
    })
    await page.addInitScript((cfg) => { window.CFG = cfg }, { ROOM, OBJECTS })
    await page.goto('http://midstudy.local/gen.html')
    await page.waitForFunction(() => window.READY || window.__failed, null, { timeout: 120000 }).catch(() => {})
    if (errors.length || !(await page.evaluate(() => !!window.READY))) throw new Error(`the scene page failed: ${errors.join(' | ') || 'timed out'}`)

    for (const s of [...todo, ...renderAlso]) {
      const write = todo.includes(s)
      const long = Math.max(s.w, s.h), k = Math.min(1, 1024 / long), DW = Math.round(s.w * k), DH = Math.round(s.h * k)
      const t0 = Date.now()
      const r = await page.evaluate((cfg) => window.renderScene(cfg), { W: s.w, H: s.h, DW, DH, cam: s.camera, lights: s.lights, pose: s.pose || null })
      if (errors.length) throw new Error(`render of ${s.id} failed: ${errors.join(' | ')}`)
      const rawBuf = Buffer.from(r.raw, 'base64')
      rendered.set(s.id, { s, DW, DH, raw: new Float32Array(rawBuf.buffer, rawBuf.byteOffset, DW * DH) })
      if (!write) { console.log(`${s.id}: rendered for the room's overlap only (nothing written)`); continue }
      const dir = path.join(OUT, 'scenes', s.id)
      fs.mkdirSync(dir, { recursive: true })
      const oldPhoto = path.join(dir, 'photo.jpg')
      if (fs.existsSync(oldPhoto)) fs.rmSync(path.join(OUT, 'calib', sha256(fs.readFileSync(oldPhoto))), { recursive: true, force: true })
      const photo = stripJpeg(Buffer.from(r.photo.split(',')[1], 'base64'))
      const mm = Buffer.from(r.depth, 'base64')
      const depth = png16(DW, DH, mm)
      fs.writeFileSync(oldPhoto, photo)
      fs.writeFileSync(path.join(dir, 'depth.png'), depth)
      fs.writeFileSync(path.join(dir, 'ids.png'), idsPng(s.w, s.h, Buffer.from(r.ids, 'base64')))

      // truth.json is in the scene's own frame (contract §4.1): the room's objects through its pose (none: identity)
      const toS = (p) => roomToScene(s.pose, p)
      const yawS = (deg) => (s.pose ? +wrapDeg(deg - s.pose.yaw_deg).toFixed(6) : deg)
      const objects = {}
      for (const [name, o] of Object.entries(OBJECTS)) {
        const corners = boxCorners(o.center, o.rotation_y_deg, [0, o.size.h / 2, 0], [o.size.w, o.size.h, o.size.d]).map((p) => toS(p).map(r6))
        objects[name] = {
          kind: name === 'sofa' ? 'box' : 'table', center: toS(o.center).map(r6), size_m: o.size, rotation_y_deg: yawS(o.rotation_y_deg),
          corner_names: CORNER_NAMES, corners,
          corner_px: corners.map((p) => { const q = project(s.camera, s.w, s.h, p); return [+q.px.toFixed(3), +q.py.toFixed(3)] }),
          parts: o.parts.map((p) => ({ name: p.name, center: toS(yawed(o.center, o.rotation_y_deg, p.center)).map(r6), size: p.size, rotation_y_deg: yawS(o.rotation_y_deg), corners: boxCorners(o.center, o.rotation_y_deg, p.center, p.size).map((c) => toS(c).map(r6)) })),
        }
      }
      const floorPoints = s.pose ? pickFloorPoints(s, r, DW, DH, mm).map((p) => toS(p).map(r6)) : FLOOR_POINTS
      const truth = {
        version: 1, id: s.id, image: { w: s.w, h: s.h }, camera: s.camera,
        projection: 'contract §4.1: f = H / (2 tan(fov_y / 2)), px = W/2 + f x_c / d, py = H/2 - f y_c / d, d = -z_c',
        depth: { file: 'depth.png', w: DW, h: DH, units: 'mm along the view axis', floor_masked: true },
        ids: { file: 'ids.png', r: 'sofa', g: 'table', note: 'each object rendered alone (no occlusion), antialiased: threshold at 128' },
        objects,
        floor_points: floorPoints.map((p) => { const q = project(s.camera, s.w, s.h, p); return { world: p, px: [+q.px.toFixed(3), +q.py.toFixed(3)] } }),
        lights: sceneLights(s),
        ...(s.pose ? {
          pose_in_room: s.pose,
          room: { frame: ROOM_FRAME, note: "pose_in_room maps this scene's frame into the room frame (living-wide's): p_room = Ry(yaw) · p_scene + (x_m, 0, z_m) (contract §4.9); everything else in this file is in this scene's own frame", hard_case: s.hard_case || null, overlap: null },
          wall_check: pickWall(s, DW, DH, mm),
        } : {}),
      }
      fs.writeFileSync(path.join(dir, 'truth.json'), json(truth))
      writeLighting(s, photo)
      const calib = {
        version: 1, source: 'truth', model: null, image: { w: s.w, h: s.h }, camera: s.camera, principal: [0.5, 0.5],
        floor: { found: true, inlier_ratio: +r.floorRatio.toFixed(4), rmse_m: 0 },
        depth: { file: 'depth.png', w: DW, h: DH, floor_masked: true },
        exif: null, device: null, elapsed_s: 0,
      }
      fs.writeFileSync(path.join(dir, 'calib.json'), json(calib))
      const mock = path.join(OUT, 'calib', sha256(photo))
      fs.mkdirSync(mock, { recursive: true })
      fs.writeFileSync(path.join(mock, 'calib.json'), json(calib))
      fs.writeFileSync(path.join(mock, 'depth.png'), depth)
      console.log(`${s.id}: ${s.w}x${s.h}, depth ${DW}x${DH}, floor ${(r.floorRatio * 100).toFixed(1)} %, ${((Date.now() - t0) / 1000).toFixed(1)} s -> ${path.relative(REPO, dir)}, ${path.relative(REPO, mock).slice(0, 30)}…`)
    }
  } finally {
    await browser.close()
  }
  if (!rooms) return
  // the room: each room photo's overlap with the others (truth.json room.overlap), then the mock's align.json answers
  const members = [ROOM_FRAME, ...ROOM_SCENES.map((s) => s.id)]
  if (members.every((id) => rendered.has(id))) {
    for (const s of ROOM_SCENES.filter((x) => todo.includes(x))) {
      const file = path.join(OUT, 'scenes', s.id, 'truth.json'), truth = JSON.parse(fs.readFileSync(file, 'utf8'))
      truth.room.overlap = Object.fromEntries(members.filter((id) => id !== s.id).map((id) => [id, +overlapShare(rendered.get(s.id), rendered.get(id)).toFixed(3)]))
      fs.writeFileSync(file, json(truth))
      console.log(`${s.id}: sees ${Object.entries(truth.room.overlap).map(([id, v]) => `${id} ${Math.round(v * 100)} %`).join(', ')}`)
    }
  }
  const photoOf = (id) => { const own = path.join(OUT, 'scenes', id, 'photo.jpg'); return fs.existsSync(own) ? own : path.join(REPO, 'fixtures/scenes', id, 'photo.jpg') }
  writeRoomAnswers((id) => sha256(fs.readFileSync(photoOf(id))))
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`make_scene: ${e.message}`); process.exit(1) })
}
