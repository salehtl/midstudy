// Golden scenes (PLAN.md §6.1, contract §5.1): a textured room rendered with three.js 0.180.0 in headless Helium from a
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
// Usage: node fixtures/make_scene.mjs [--only <id>]      (then: evals/py fixtures/check_scenes.py)
// Browser: MIDSTUDY_BROWSER, default /Applications/Helium.app/Contents/MacOS/Helium (software GL, swiftshader).
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { chromium } from 'playwright-core'

const REPO = path.resolve(import.meta.dirname, '..')
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d }
const ONLY = arg('only', null)
const BROWSER = process.env.MIDSTUDY_BROWSER || '/Applications/Helium.app/Contents/MacOS/Helium'

// The three scenes of PLAN.md §6.1. Depth maps are at most 1024 px on the long side, same aspect (contract §4.2).
export const SCENES = [
  { id: 'living-wide', w: 1600, h: 1200, camera: { fov_y_deg: 55.0, height_m: 1.40, pitch_deg: -10.0, roll_deg: 0.0 } },
  { id: 'steep-roll', w: 1600, h: 1200, camera: { fov_y_deg: 65.0, height_m: 1.60, pitch_deg: -25.0, roll_deg: 2.0 } },
  { id: 'portrait', w: 1200, h: 1600, camera: { fov_y_deg: 70.0, height_m: 1.25, pitch_deg: -8.0, roll_deg: -1.0 } },
]

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
function fabricTex(seams) {
  const rnd = seeded(31), S = 1024, c = canvas(S, S), g = c.getContext('2d')
  g.fillStyle = '#5f7270'; g.fillRect(0, 0, S, S)
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

// Light: soft sky fill from the window side plus a sun patch; the lamp gives a warm accent.
scene.add(new THREE.HemisphereLight(0xfff6ea, 0xb9a48c, 1.9))
const sun = new THREE.DirectionalLight(0xfff1df, 2.2); sun.position.set(3.2, 5.0, 1.5); sun.target.position.set(-0.4, 0, -3.0)
sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); sun.shadow.radius = 6; sun.shadow.bias = -0.0004
Object.assign(sun.shadow.camera, { left: -5, right: 5, top: 5, bottom: -5, near: 0.5, far: 15 })
scene.add(sun, sun.target)
const lampLight = new THREE.PointLight(0xffd9a0, 1.6, 4, 2); lampLight.position.set(1.95, 1.5, -3.9); scene.add(lampLight)

// --- renders -----------------------------------------------------------------------------------------------------
function camera(cam, W, H) {
  const c = new THREE.PerspectiveCamera(cam.fov_y_deg, W / H, 0.05, 50)
  c.position.set(0, cam.height_m, 0)
  c.rotation.set(cam.pitch_deg * Math.PI / 180, 0, cam.roll_deg * Math.PI / 180, 'YXZ')   // contract §4.1
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
  renderer.setSize(W, H, false)
  const c = camera(cam, W, H)
  renderer.setRenderTarget(null); renderer.render(scene, c)
  const photo = renderer.domElement.toDataURL('image/jpeg', 0.92)

  // Depth along the view axis at DW x DH (pixel centers), floor (world y < 4 cm) masked to 0.
  const rt = new THREE.WebGLRenderTarget(DW, DH, { type: THREE.FloatType, format: THREE.RGBAFormat, depthBuffer: true })
  const dc = camera(cam, DW, DH)
  const bg = scene.background; scene.background = null
  scene.overrideMaterial = depthMat; renderer.setRenderTarget(rt); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, dc)
  const buf = new Float32Array(DW * DH * 4); renderer.readRenderTargetPixels(rt, 0, 0, DW, DH, buf)
  renderer.setRenderTarget(null); scene.overrideMaterial = null; scene.background = bg; rt.dispose()
  const mm = new Uint8Array(DW * DH * 2); let floorPx = 0, hit = 0
  for (let v = 0; v < DH; v++) for (let u = 0; u < DW; u++) {
    const o = ((DH - 1 - v) * DW + u) * 4, d = buf[o], wy = buf[o + 1], k = (v * DW + u) * 2   // render targets are bottom-up
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
  return { photo, depth: b64(mm), ids: b64(rg), floorRatio: floorPx / (DW * DH), hitRatio: hit / (DW * DH) }
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

async function main() {
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] })
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

    for (const s of SCENES) {
      if (ONLY && s.id !== ONLY) continue
      const long = Math.max(s.w, s.h), k = Math.min(1, 1024 / long), DW = Math.round(s.w * k), DH = Math.round(s.h * k)
      const t0 = Date.now()
      const r = await page.evaluate((cfg) => window.renderScene(cfg), { W: s.w, H: s.h, DW, DH, cam: s.camera })
      if (errors.length) throw new Error(`render of ${s.id} failed: ${errors.join(' | ')}`)
      const dir = path.join(REPO, 'fixtures/scenes', s.id)
      fs.mkdirSync(dir, { recursive: true })
      const oldPhoto = path.join(dir, 'photo.jpg')
      if (fs.existsSync(oldPhoto)) fs.rmSync(path.join(REPO, 'fixtures/calib', sha256(fs.readFileSync(oldPhoto))), { recursive: true, force: true })
      const photo = stripJpeg(Buffer.from(r.photo.split(',')[1], 'base64'))
      const depth = png16(DW, DH, Buffer.from(r.depth, 'base64'))
      fs.writeFileSync(oldPhoto, photo)
      fs.writeFileSync(path.join(dir, 'depth.png'), depth)
      fs.writeFileSync(path.join(dir, 'ids.png'), idsPng(s.w, s.h, Buffer.from(r.ids, 'base64')))

      const objects = {}
      for (const [name, o] of Object.entries(OBJECTS)) {
        const corners = boxCorners(o.center, o.rotation_y_deg, [0, o.size.h / 2, 0], [o.size.w, o.size.h, o.size.d])
        objects[name] = {
          kind: name === 'sofa' ? 'box' : 'table', center: o.center, size_m: o.size, rotation_y_deg: o.rotation_y_deg,
          corner_names: CORNER_NAMES, corners,
          corner_px: corners.map((p) => { const q = project(s.camera, s.w, s.h, p); return [+q.px.toFixed(3), +q.py.toFixed(3)] }),
          parts: o.parts.map((p) => ({ name: p.name, center: yawed(o.center, o.rotation_y_deg, p.center).map(r6), size: p.size, rotation_y_deg: o.rotation_y_deg, corners: boxCorners(o.center, o.rotation_y_deg, p.center, p.size) })),
        }
      }
      const truth = {
        version: 1, id: s.id, image: { w: s.w, h: s.h }, camera: s.camera,
        projection: 'contract §4.1: f = H / (2 tan(fov_y / 2)), px = W/2 + f x_c / d, py = H/2 - f y_c / d, d = -z_c',
        depth: { file: 'depth.png', w: DW, h: DH, units: 'mm along the view axis', floor_masked: true },
        ids: { file: 'ids.png', r: 'sofa', g: 'table', note: 'each object rendered alone (no occlusion), antialiased: threshold at 128' },
        objects,
        floor_points: FLOOR_POINTS.map((p) => { const q = project(s.camera, s.w, s.h, p); return { world: p, px: [+q.px.toFixed(3), +q.py.toFixed(3)] } }),
      }
      fs.writeFileSync(path.join(dir, 'truth.json'), json(truth))
      const calib = {
        version: 1, source: 'truth', model: null, image: { w: s.w, h: s.h }, camera: s.camera, principal: [0.5, 0.5],
        floor: { found: true, inlier_ratio: +r.floorRatio.toFixed(4), rmse_m: 0 },
        depth: { file: 'depth.png', w: DW, h: DH, floor_masked: true },
        exif: null, device: null, elapsed_s: 0,
      }
      fs.writeFileSync(path.join(dir, 'calib.json'), json(calib))
      const mock = path.join(REPO, 'fixtures/calib', sha256(photo))
      fs.mkdirSync(mock, { recursive: true })
      fs.writeFileSync(path.join(mock, 'calib.json'), json(calib))
      fs.writeFileSync(path.join(mock, 'depth.png'), depth)
      console.log(`${s.id}: ${s.w}x${s.h}, depth ${DW}x${DH}, floor ${(r.floorRatio * 100).toFixed(1)} %, ${((Date.now() - t0) / 1000).toFixed(1)} s -> fixtures/scenes/${s.id}, fixtures/calib/${sha256(photo).slice(0, 12)}…`)
    }
  } finally {
    await browser.close()
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  main().catch((e) => { console.error(`make_scene: ${e.message}`); process.exit(1) })
}
