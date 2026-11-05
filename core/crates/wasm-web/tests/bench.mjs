// Benchmarks in Node: v1's JavaScript (lifted verbatim, ./v1/) against the wasm kernels, built with SIMD128
// (build/wasm/web/) and without (build/wasm/web-nosimd/, `build-web.sh --no-simd`), on the planner's sizes:
// depth.png 1024 × 768 (the golden file, filter 0, and the same samples Paeth-filtered), the keep-room mask at
// 2048 × 1152, 10⁶ projections, and the environment map at v1's 512 × 256 from a 2048 × 1536 photo (v1 baked it on the
// GPU; the JS transcription of its shader is timed only as a reference for a JS loop). Median of 7 after a warm-up;
// results in evals/out/k-geom/bench.json. Each wasm timing includes copying the result out of wasm memory.
// Usage (repo root, a quiet machine): nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/wasm-web/tests/bench.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import os from 'node:os'
import * as V from './v1/engine.mjs'
import { envBakeV1 } from './v1/envbake.mjs'
import * as k from '../../../js/web.ts'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const ONLY = process.env.ONLY || '' // depth | mask | project | env: one section
const run = (name) => !ONLY || ONLY === name
const builds = {}
for (const [name, dir] of [['simd', 'build/wasm/web'], ['nosimd', 'build/wasm/web-nosimd']]) {
  const glue = path.join(REPO, dir, 'midstudy_wasm_web.js')
  if (!fs.existsSync(glue)) { console.log(`(no ${dir}: skipping the ${name} build)`); continue }
  const m = await import(glue)
  const exports = m.initSync({ module: fs.readFileSync(path.join(REPO, dir, 'midstudy_wasm_web_bg.wasm')) })
  builds[name] = { m, memory: exports.memory, size: fs.statSync(path.join(REPO, dir, 'midstudy_wasm_web_bg.wasm')).size }
}
k.loadKernelsSync(fs.readFileSync(path.join(REPO, 'build/wasm/web/midstudy_wasm_web_bg.wasm')))

async function median(fn, runs = 7) {
  await fn()
  const t = []
  for (let i = 0; i < runs; i++) { const s = performance.now(); await fn(); t.push(performance.now() - s) }
  t.sort((a, b) => a - b)
  return t[Math.floor(runs / 2)]
}
const results = []
const row = (task, impl, ms, extra = '') => { results.push({ task, impl, ms: +ms.toFixed(3) }); console.log(`${task.padEnd(44)} ${impl.padEnd(26)} ${ms.toFixed(2).padStart(9)} ms ${extra}`) }

// --- depth.png ---------------------------------------------------------------------------------------------------------
const golden = fs.readFileSync(path.join(REPO, 'fixtures/scenes/living-wide/depth.png'))
const decoded = k.decodeDepth(golden)
function paethPng(w, h, mm) {
  const stride = w * 2, raw = Buffer.alloc((stride + 1) * h)
  const row16 = (y) => { const b = Buffer.alloc(stride); for (let x = 0; x < w; x++) b.writeUInt16BE(mm[y * w + x], 2 * x); return b }
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const cur = row16(y), o = y * (stride + 1)
    raw[o] = 4
    for (let i = 0; i < stride; i++) {
      const a = i >= 2 ? cur[i - 2] : 0, b = prev[i], c = i >= 2 ? prev[i - 2] : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      raw[o + 1 + i] = (cur[i] - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
    }
    prev = cur
  }
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([l, td, c]) }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 16
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))])
}
const mm = Array.from(decoded.data, (v) => Math.round(v * 1000))
const paeth = paethPng(decoded.width, decoded.height, mm)
const v1 = V.makeV1({ camera: { fov_y_deg: 65, height_m: 1.6, pitch_deg: -25, roll_deg: 2 }, w: 1600, h: 1200 })
for (const [label, bytes] of run('depth') ? [['depth.png 1024x768 decode, filter 0', golden], ['depth.png 1024x768 decode, Paeth', paeth]] : []) {
  row(label, 'v1 JS (DecompressionStream)', await median(() => v1.loadDepth(new Uint8Array(bytes))))
  for (const [name, b] of Object.entries(builds)) {
    row(label, `wasm ${name}`, await median(() => { const r = b.m.decodeDepth(bytes, 1); new Float32Array(b.memory.buffer, r.ptr(), r.len()).slice(); r.free() }))
  }
}

// --- the keep-room mask --------------------------------------------------------------------------------------------------
const [MW, MH] = [2048, 1152]
const readback = new Uint8Array(MW * MH * 4)
for (let y = 300; y < 800; y++) for (let x = 600; x < 1300; x++) readback[(y * MW + x) * 4] = 255
for (let y = 900; y < 1000; y++) for (let x = 100; x < 400; x++) readback[(y * MW + x) * 4] = 200
if (run('mask')) row('keep-room mask 2048x1152 (threshold, dilate, coverage)', 'v1 JS', await median(() => V.maskFromPixels(readback, MW, MH)))
for (const [name, b] of run('mask') ? Object.entries(builds) : []) {
  row('keep-room mask 2048x1152 (threshold, dilate, coverage)', `wasm ${name}`, await median(() => { const r = b.m.keepRoomMask(readback, MW, MH, true); new Uint8Array(b.memory.buffer, r.ptr(), r.len()).slice(); r.free() }))
}
if (run('mask')) {
  const r = builds.simd.m.keepRoomMask(readback, MW, MH, true)
  row('keep-room mask PNG 2048x1152 (zlib level 6)', 'wasm simd', await median(() => r.toPng(MW, MH, 6)))
  row('keep-room mask PNG 2048x1152 (zlib level 1)', 'wasm simd', await median(() => r.toPng(MW, MH, 1)))
  r.free()
}

// --- 10^6 projections ----------------------------------------------------------------------------------------------------
const N = 1_000_000
const pts = new Float64Array(3 * N)
for (let i = 0; i < N; i++) { pts[3 * i] = (i % 1000) * 0.01 - 5; pts[3 * i + 1] = (i % 7) * 0.3; pts[3 * i + 2] = -1 - (i % 997) * 0.02 }
if (run('project')) row('10^6 projections', 'v1 JS projectPhoto', await median(() => { let a = 0; for (let i = 0; i < N; i++) a += v1.projectPhoto([pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]])[0]; return a }))
for (const [name, b] of run('project') ? Object.entries(builds) : []) {
  const cam = new b.m.Camera(65, 1.6, -25, 2, 1600, 1200)
  const src = new b.m.F64Buf(3 * N), dst = new b.m.F64Buf(3 * N)
  row('10^6 projections', `wasm ${name} projectMany`, await median(() => {
    new Float64Array(b.memory.buffer, src.ptr(), 3 * N).set(pts)
    cam.projectMany(src, dst)
    return new Float64Array(b.memory.buffer, dst.ptr(), 3 * N).slice()
  }))
  src.free(); dst.free(); cam.free()
}
if (run('project')) {
  const sc = new k.SceneCamera({ fov_y_deg: 65, height_m: 1.6, pitch_deg: -25, roll_deg: 2 }, 1600, 1200)
  row('10^6 projections', 'wasm simd, one call each (face)', await median(() => { let a = 0; for (let i = 0; i < N; i++) a += sc.project([pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]])[0]; return a }))
  sc.dispose()
}

// --- the on-screen hit test (v1's hitItemAt: 8 corners projected, hull, inside or within 16 px) -----------------------------
if (run('hit')) {
  const vw = { s: 0.6, ox: 40, oy: 30 }
  const hv1 = V.makeV1({ camera: { fov_y_deg: 65, height_m: 1.6, pitch_deg: -25, roll_deg: 2 }, w: 1600, h: 1200, view: vw })
  const item = { position: [0.4, 0, -3.2], rotation_y_deg: 30, min: [-0.9, 0, -0.45], max: [0.9, 0.82, 0.45] }
  hv1.addItem('sofa', item.position, item.rotation_y_deg, item.min, item.max)
  const sc = new k.SceneCamera({ fov_y_deg: 65, height_m: 1.6, pitch_deg: -25, roll_deg: 2 }, 1600, 1200)
  const M = 100_000
  const xs = Float64Array.from({ length: M }, (_, i) => 300 + (i * 7919) % 700), ys = Float64Array.from({ length: M }, (_, i) => 300 + (i * 104729) % 500)
  let hitsA = 0, hitsB = 0
  row('10^5 hit tests (hitItemAt on screen)', 'v1 JS', await median(() => { hitsA = 0; for (let i = 0; i < M; i++) if (hv1.hitItemAt('sofa', xs[i], ys[i], 16)) hitsA++ }))
  row('10^5 hit tests (hitItemAt on screen)', 'wasm simd, one call each (face)', await median(() => { hitsB = 0; for (let i = 0; i < M; i++) if (sc.hitBox(item, vw, xs[i], ys[i], 16) === 'hit') hitsB++ }), `(${hitsA} hits in v1, ${hitsB} in wasm)`)
  sc.dispose()
}

// --- the environment map -------------------------------------------------------------------------------------------------
const [PW, PH] = [2048, 1536]
const photo = new Uint8Array(PW * PH * 4)
for (let i = 0; i < PW * PH; i++) { const x = i % PW, y = (i / PW) | 0; photo.set([(x * 255 / PW) | 0, (y * 255 / PH) | 0, (x ^ y) & 255, 255], 4 * i) }
const R = v1.R.elements
if (run('env')) row('env map 512x256 from 2048x1536', 'JS transcription (bilinear)', await median(() => envBakeV1({ width: PW, height: PH, data: photo }, v1.R, 65), 3))
for (const [name, b] of run('env') ? Object.entries(builds) : []) {
  row('env map 512x256 from 2048x1536', `wasm ${name} mipmapped, aniso 4`, await median(() => { const r = b.m.envMap(photo, PW, PH, Float64Array.from(R), 65, 512, 256, 4, true); new Uint16Array(b.memory.buffer, r.f16Ptr(), r.f16Len()).slice(); r.free() }))
  row('env map 512x256 from 2048x1536', `wasm ${name} bilinear`, await median(() => { const r = b.m.envMap(photo, PW, PH, Float64Array.from(R), 65, 512, 256, 0, false); new Float32Array(b.memory.buffer, r.f32Ptr(), r.f32Len()).slice(); r.free() }))
}

const out = path.join(REPO, 'evals/out/k-geom')
fs.mkdirSync(out, { recursive: true })
const meta = { node: process.version, load: os.loadavg(), cpus: os.cpus().length, wasm_bytes: Object.fromEntries(Object.entries(builds).map(([n, b]) => [n, b.size])), date: new Date().toISOString() }
if (!ONLY) fs.writeFileSync(path.join(out, 'bench.json'), JSON.stringify({ meta, results }, null, 1))
console.log(`load ${meta.load.map((v) => v.toFixed(1)).join(' ')}; wasm ${JSON.stringify(meta.wasm_bytes)}; ${ONLY ? `ONLY=${ONLY}: nothing written` : 'written to evals/out/k-geom/bench.json'}`)
