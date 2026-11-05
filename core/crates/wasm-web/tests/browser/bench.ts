// Benchmarks in headless Chrome (bench-run.mjs bundles this page once per build under test): v1's JavaScript (lifted
// verbatim, ../v1/) against the kernels through the planner's own face (core/js/web.ts), on the planner's sizes:
// depth.png 1024 × 768 (the golden file, filter 0, and the same samples Paeth-filtered), the keep-room mask at
// 2048 × 1152, 10⁶ projections (one batch), 10⁵ on-screen hit tests, and the environment map at v1's 512 × 256 from a
// 2048 × 1536 photo (v1 baked it on the GPU; its JS transcription is timed only as a reference for a JS loop).
// Median of 7 after a warm-up, ms. `__FACE__` is replaced by bench-run.mjs with the path of the face being measured.
import * as k from '__FACE__'
import * as V from '../v1/engine.mjs'
import { envBakeV1 } from '../v1/envbake.mjs'

interface Row { task: string; impl: string; ms: number }
const rows: Row[] = []

async function median(fn: () => unknown, runs = 7): Promise<number> {
  await fn()
  const t: number[] = []
  for (let i = 0; i < runs; i++) {
    const s = performance.now()
    await fn()
    t.push(performance.now() - s)
  }
  t.sort((a, b) => a - b)
  return t[Math.floor(runs / 2)] ?? 0
}

async function crc32(data: Uint8Array): Promise<number> {
  let c = 0xffffffff
  for (const b of data) {
    c ^= b
    for (let j = 0; j < 8; j++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1))
  }
  return (c ^ 0xffffffff) >>> 0
}

async function deflate(raw: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate'))
  return new Uint8Array(await new Response(s).arrayBuffer())
}

/** The same 16-bit samples with every row Paeth-filtered (what an adaptive encoder often picks). */
async function paethPng(w: number, h: number, mm: Uint16Array): Promise<Uint8Array> {
  const stride = w * 2
  const raw = new Uint8Array((stride + 1) * h)
  let prev = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const cur = new Uint8Array(stride)
    for (let x = 0; x < w; x++) { const v = mm[y * w + x] ?? 0; cur[2 * x] = v >> 8; cur[2 * x + 1] = v & 255 }
    const o = y * (stride + 1)
    raw[o] = 4
    for (let i = 0; i < stride; i++) {
      const a = i >= 2 ? cur[i - 2] ?? 0 : 0, b = prev[i] ?? 0, c = i >= 2 ? prev[i - 2] ?? 0 : 0
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
      raw[o + 1 + i] = ((cur[i] ?? 0) - (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255
    }
    prev = cur
  }
  const chunk = async (t: string, d: Uint8Array): Promise<Uint8Array> => {
    const td = new Uint8Array(4 + d.length)
    td.set(new TextEncoder().encode(t)); td.set(d, 4)
    const out = new Uint8Array(12 + d.length)
    new DataView(out.buffer).setUint32(0, d.length)
    out.set(td, 4)
    new DataView(out.buffer).setUint32(8 + d.length, await crc32(td))
    return out
  }
  const ihdr = new Uint8Array(13)
  new DataView(ihdr.buffer).setUint32(0, w); new DataView(ihdr.buffer).setUint32(4, h); ihdr[8] = 16
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), await chunk('IHDR', ihdr), await chunk('IDAT', await deflate(raw)), await chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) { out.set(p, at); at += p.length }
  return out
}

async function main(): Promise<void> {
  await k.loadKernels(new URL('wasm/midstudy_wasm_web_bg.wasm', location.href))
  const golden = new Uint8Array(await (await fetch('/scenes/living-wide/depth.png')).arrayBuffer())
  const decoded = k.decodeDepth(golden)
  const mm = Uint16Array.from(decoded.data, (v) => Math.round(v * 1000))
  const paeth = await paethPng(decoded.width, decoded.height, mm)
  const v1 = V.makeV1({ camera: { fov_y_deg: 65, height_m: 1.6, pitch_deg: -25, roll_deg: 2 }, w: 1600, h: 1200 })
  for (const [label, bytes] of [['depth.png 1024x768 decode, filter 0', golden], ['depth.png 1024x768 decode, Paeth', paeth]] as const) {
    rows.push({ task: label, impl: 'v1 JS', ms: await median(() => v1.loadDepth(new Uint8Array(bytes))) })
    rows.push({ task: label, impl: 'wasm', ms: await median(() => k.decodeDepth(bytes)) })
  }

  const [MW, MH] = [2048, 1152]
  const rb = new Uint8Array(MW * MH * 4)
  for (let y = 300; y < 800; y++) for (let x = 600; x < 1300; x++) rb[(y * MW + x) * 4] = 255
  for (let y = 900; y < 1000; y++) for (let x = 100; x < 400; x++) rb[(y * MW + x) * 4] = 200
  rows.push({ task: 'keep-room mask 2048x1152', impl: 'v1 JS', ms: await median(() => V.maskFromPixels(rb, MW, MH)) })
  rows.push({ task: 'keep-room mask 2048x1152', impl: 'wasm', ms: await median(() => k.keepRoomMask(rb, MW, MH)) })
  rows.push({ task: 'keep-room mask 2048x1152 + PNG', impl: 'wasm', ms: await median(() => k.keepRoomMask(rb, MW, MH, { png: true })) })

  const N = 1_000_000
  const pts = new Float64Array(3 * N)
  for (let i = 0; i < N; i++) { pts[3 * i] = (i % 1000) * 0.01 - 5; pts[3 * i + 1] = (i % 7) * 0.3; pts[3 * i + 2] = -1 - (i % 997) * 0.02 }
  const cam = new k.SceneCamera({ fov_y_deg: 65, height_m: 1.6, pitch_deg: -25, roll_deg: 2 }, 1600, 1200)
  rows.push({ task: '10^6 projections', impl: 'v1 JS', ms: await median(() => { let a = 0; for (let i = 0; i < N; i++) a += v1.projectPhoto([pts[3 * i], pts[3 * i + 1], pts[3 * i + 2]])[0]; return a }) })
  rows.push({ task: '10^6 projections', impl: 'wasm projectMany', ms: await median(() => cam.projectMany(pts)) })

  const vw = { s: 0.6, ox: 40, oy: 30 }
  const hv1 = V.makeV1({ camera: { fov_y_deg: 65, height_m: 1.6, pitch_deg: -25, roll_deg: 2 }, w: 1600, h: 1200, view: vw })
  const item = { position: [0.4, 0, -3.2] as const, rotation_y_deg: 30, min: [-0.9, 0, -0.45] as const, max: [0.9, 0.82, 0.45] as const }
  hv1.addItem('sofa', item.position, item.rotation_y_deg, item.min, item.max)
  const M = 100_000
  const xs = Float64Array.from({ length: M }, (_, i) => 300 + (i * 7919) % 700)
  const ys = Float64Array.from({ length: M }, (_, i) => 300 + (i * 104729) % 500)
  rows.push({ task: '10^5 hit tests', impl: 'v1 JS', ms: await median(() => { let n = 0; for (let i = 0; i < M; i++) if (hv1.hitItemAt('sofa', xs[i], ys[i], 16)) n++; return n }) })
  rows.push({ task: '10^5 hit tests', impl: 'wasm hitBox', ms: await median(() => { let n = 0; for (let i = 0; i < M; i++) if (cam.hitBox(item, vw, xs[i] ?? 0, ys[i] ?? 0, 16) === 'hit') n++; return n }) })

  const [PW, PH] = [2048, 1536]
  const photo = new Uint8Array(PW * PH * 4)
  for (let i = 0; i < PW * PH; i++) { const x = i % PW, y = (i / PW) | 0; photo.set([(x * 255 / PW) | 0, (y * 255 / PH) | 0, (x ^ y) & 255, 255], 4 * i) }
  const rotation = Array.from(v1.R.elements)
  rows.push({ task: 'env map 512x256 from 2048x1536', impl: 'JS transcription (bilinear)', ms: await median(() => envBakeV1({ width: PW, height: PH, data: photo }, v1.R, 65), 3) })
  const img = { width: PW, height: PH, data: photo }
  rows.push({ task: 'env map 512x256 from 2048x1536', impl: 'wasm mipmapped aniso 4', ms: await median(() => k.envMap(img, { rotation, fov_y_deg: 65 })) })
  rows.push({ task: 'env map 512x256 from 2048x1536', impl: 'wasm bilinear', ms: await median(() => k.envMap(img, { rotation, fov_y_deg: 65 }, { anisotropy: 0, half: false })) })
  cam.dispose()
}

declare global { interface Window { __bench?: { rows: Row[]; error?: string } } }
main().then(() => { window.__bench = { rows } }, (e: unknown) => { window.__bench = { rows, error: String(e) } })
