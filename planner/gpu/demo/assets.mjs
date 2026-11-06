// Test assets for the WebGPU spike, written the way the evals write theirs: E13's magenta splat probe (as splat.spz,
// SPZ v2 like midstudy-add writes, and as the PLY E13 itself uses), E4's magenta unlit probe box and E16's lit grey box
// (evals/lib/harness.mjs boxGlb).
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { boxGlb } from '../../../evals/lib/harness.mjs'

const C0 = 0.28209479177387814

// points on the faces of a w × h × d box (m), `step` apart, opaque, one colour, about 6 mm each (E13 splatBoxPly)
export function boxPoints({ w, h, d }, step = 0.01) {
  const pts = []
  const faces = [[0, w, 1, h, 2, d], [2, d, 1, h, 0, w], [0, w, 2, d, 1, h]]
  for (const [ua, us, va, vs, fa, fs_] of faces) {
    const nu = Math.round(us / step), nv = Math.round(vs / step)
    for (const side of [0, 1]) for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const p = [0, 0, 0]
      p[ua] = (i / nu) * us; p[va] = (j / nv) * vs; p[fa] = side * fs_
      pts.push([p[0] - w / 2, p[1], p[2] - d / 2])
    }
  }
  return pts
}

export function plyBytes(pts, rgb, { opacity = 5.3, scale = 0.006 } = {}) {
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
  const dc = rgb.map((c) => (c - 0.5) / C0)
  const ls = Math.log(scale)
  const body = new Float32Array(pts.length * props.length)
  pts.forEach((p, k) => body.set([...p, ...dc, opacity, ls, ls, ls, 1, 0, 0, 0], k * props.length))
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\n${props.map((n) => `property float ${n}\n`).join('')}end_header\n`
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(body.buffer)])
}

// SPZ v2, gzipped, as pipeline/src/midstudy_pipeline/splat.py spz_bytes writes it (12 fractional bits)
export function spzBytes(pts, rgb, { opacity = 5.3, scale = 0.006 } = {}) {
  const n = pts.length
  const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)))
  const head = Buffer.alloc(16)
  head.writeUInt32LE(0x5053474e, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(n, 8)
  head[12] = 0; head[13] = 12; head[14] = 0; head[15] = 0
  const pos = Buffer.alloc(9 * n), alpha = Buffer.alloc(n), col = Buffer.alloc(3 * n), scl = Buffer.alloc(3 * n), rot = Buffer.alloc(3 * n)
  const a = u8(255 / (1 + Math.exp(-opacity)))
  const cb = rgb.map((c) => u8(((c - 0.5) / C0) * 0.15 * 255 + 127.5))
  const sb = u8((Math.log(scale) + 10) * 16)
  pts.forEach((p, i) => {
    for (let k = 0; k < 3; k++) {
      const v = Math.round(p[k] * 4096) & 0xffffff
      pos[9 * i + 3 * k] = v & 255; pos[9 * i + 3 * k + 1] = (v >> 8) & 255; pos[9 * i + 3 * k + 2] = (v >> 16) & 255
      col[3 * i + k] = cb[k]; scl[3 * i + k] = sb; rot[3 * i + k] = u8(127.5) // identity: x y z = 0
    }
    alpha[i] = a
  })
  return zlib.gzipSync(Buffer.concat([head, pos, alpha, col, scl, rot]), { level: 9 })
}

export const SPROBE = { id: 'splat-probe', dims_cm: { w: 80, h: 120, d: 50 } }
export const PROBE = { id: 'probe-box', dims_cm: { w: 80, h: 120, d: 50 } }
export const LIT = { id: 'probe-lit', dims_cm: { w: 45, h: 45, d: 45 }, albedo: 0.5 }

/** Writes the probes into dir: <id>/model.glb, splat-probe/splat.spz + splat.ply. Returns their URLs relative to dir. */
export function writeProbes(dir) {
  const mk = (id) => { fs.mkdirSync(path.join(dir, id), { recursive: true }); return path.join(dir, id) }
  const { w, h, d } = SPROBE.dims_cm
  const pts = boxPoints({ w: w / 100, h: h / 100, d: d / 100 })
  fs.writeFileSync(path.join(mk(SPROBE.id), 'splat.spz'), spzBytes(pts, [1, 0, 1]))
  fs.writeFileSync(path.join(mk(SPROBE.id), 'splat.ply'), plyBytes(pts, [1, 0, 1]))
  fs.writeFileSync(path.join(mk(SPROBE.id), 'model.glb'), boxGlb(w / 100, h / 100, d / 100, [0, 1, 0, 1])) // green: never drawn
  fs.writeFileSync(path.join(mk(PROBE.id), 'model.glb'), boxGlb(PROBE.dims_cm.w / 100, PROBE.dims_cm.h / 100, PROBE.dims_cm.d / 100))
  const g = LIT.albedo
  fs.writeFileSync(path.join(mk(LIT.id), 'model.glb'), boxGlb(LIT.dims_cm.w / 100, LIT.dims_cm.h / 100, LIT.dims_cm.d / 100, [g, g, g, 1], { unlit: false }))
  return { splatProbeCount: pts.length }
}
