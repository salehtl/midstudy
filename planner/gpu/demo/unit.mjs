// Node checks of the spike's pure modules (no browser): node planner/gpu/demo/unit.mjs [splat.spz]
// (Node 22 strips the types of the .ts modules it imports.)
// - SPZ and PLY of the same splats decode to the same centers, colours and covariances (within SPZ's quantization);
// - the covariance is R S² Rᵀ (a rotated, stretched splat);
// - the CPU sort is back to front, stable and equal to a reference sort of its own keys; splats behind the camera
//   are left out;
// - with a splat.spz argument (the Idol chair from the mocked pipeline), its count and bounds.
import fs from 'node:fs'
import zlib from 'node:zlib'
import { decodePly, decodeSpzRaw } from '../splat-data.ts'
import { KEY_LEVELS, depthKey, sortSplats } from '../sort-cpu.ts'

let failed = 0
const check = (name, ok, measured) => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} — ${measured}`)
  if (!ok) failed++
}

// --- the same splats as PLY and SPZ ---------------------------------------------------------------------------------------
const C0 = 0.28209479177387814
const n = 500
const pts = []
let seed = 7
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 2 ** 32 }
for (let i = 0; i < n; i++) {
  const q = [rnd() + 0.2, rnd() - 0.5, rnd() - 0.5, rnd() - 0.5]
  const ql = Math.hypot(...q)
  pts.push({ p: [rnd() * 2 - 1, rnd() * 1.5, rnd() * 2 - 1], rgb: [rnd(), rnd(), rnd()], op: rnd() * 8 - 4, s: [0.002 + rnd() * 0.02, 0.002 + rnd() * 0.02, 0.002 + rnd() * 0.02], q: [q[0] / ql, q[1] / ql, q[2] / ql, q[3] / ql] })
}
const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
const body = new Float32Array(n * props.length)
pts.forEach((t, k) => body.set([...t.p, ...t.rgb.map((c) => (c - 0.5) / C0), t.op, ...t.s.map(Math.log), ...t.q], k * props.length))
const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${n}\n${props.map((p) => `property float ${p}\n`).join('')}end_header\n`
const ply = decodePly(new Uint8Array(Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(body.buffer)])))
const u8 = (v) => Math.max(0, Math.min(255, Math.round(v)))
const head = Buffer.alloc(16)
head.writeUInt32LE(0x5053474e, 0); head.writeUInt32LE(2, 4); head.writeUInt32LE(n, 8); head[13] = 12
const pos = Buffer.alloc(9 * n), alp = Buffer.alloc(n), col = Buffer.alloc(3 * n), scl = Buffer.alloc(3 * n), rot = Buffer.alloc(3 * n)
pts.forEach((t, i) => {
  for (let k = 0; k < 3; k++) {
    const v = Math.round((t.p[k] ?? 0) * 4096) & 0xffffff
    pos[9 * i + 3 * k] = v & 255; pos[9 * i + 3 * k + 1] = (v >> 8) & 255; pos[9 * i + 3 * k + 2] = (v >> 16) & 255
    col[3 * i + k] = u8((((t.rgb[k] ?? 0) - 0.5) / C0) * 0.15 * 255 + 127.5)
    scl[3 * i + k] = u8((Math.log(t.s[k] ?? 1) + 10) * 16)
  }
  const s = t.q[0] < 0 ? -1 : 1
  for (let k = 0; k < 3; k++) rot[3 * i + k] = u8(s * (t.q[k + 1] ?? 0) * 127.5 + 127.5)
  alp[i] = u8(255 / (1 + Math.exp(-t.op)))
})
const spz = decodeSpzRaw(new Uint8Array(Buffer.concat([head, pos, alp, col, scl, rot])))
let dPos = 0, dCol = 0, dCov = 0
for (let i = 0; i < n; i++) {
  for (let k = 0; k < 3; k++) dPos = Math.max(dPos, Math.abs((spz.centers[3 * i + k] ?? 0) - (ply.centers[3 * i + k] ?? 0)))
  for (let k = 0; k < 4; k++) dCol = Math.max(dCol, Math.abs((spz.colors[4 * i + k] ?? 0) - (ply.colors[4 * i + k] ?? 0)))
  const tr = (ply.covariances[6 * i] ?? 0) + (ply.covariances[6 * i + 3] ?? 0) + (ply.covariances[6 * i + 5] ?? 0)
  for (let k = 0; k < 6; k++) dCov = Math.max(dCov, Math.abs((spz.covariances[6 * i + k] ?? 0) - (ply.covariances[6 * i + k] ?? 0)) / tr)
}
check('SPZ v2 and PLY of the same splats: centers within 1/8192 m', dPos <= 1 / 8192 + 1e-7, `max ${dPos.toExponential(2)} m`)
check('…colours and alphas within 2/255', dCol <= 2, `max ${dCol}`)
check('…covariances within 12 % of the trace (SPZ: ln-scale steps of 1/16, rotation bytes)', dCov <= 0.12, `max ${(100 * dCov).toFixed(1)} %`)

// covariance of a splat stretched along x then turned 90° about z: its long axis is y
{
  const w = Math.SQRT1_2, z = Math.SQRT1_2 // 90° about z
  const b2 = Buffer.concat([Buffer.from(`ply\nformat binary_little_endian 1.0\nelement vertex 1\n${props.map((p) => `property float ${p}\n`).join('')}end_header\n`, 'ascii'),
    Buffer.from(new Float32Array([0, 0, 0, 0, 0, 0, 5, Math.log(0.1), Math.log(0.01), Math.log(0.02), w, 0, 0, z]).buffer)])
  const c = decodePly(new Uint8Array(b2)).covariances
  const ok = Math.abs((c[0] ?? 0) - 1e-4) < 1e-9 && Math.abs((c[3] ?? 0) - 1e-2) < 1e-8 && Math.abs((c[5] ?? 0) - 4e-4) < 1e-9 && Math.abs(c[1] ?? 1) < 1e-9
  check('Σ = R S² Rᵀ: a splat 10 × 1 × 2 cm turned 90° about z has σ_y = 10 cm, σ_x = 1 cm', ok, Array.from(c).map((v) => v.toExponential(2)).join(' '))
}

// --- the CPU sort ---------------------------------------------------------------------------------------------------------------
{
  const m = 20000
  const centers = new Float32Array(3 * m)
  const slots = new Uint16Array(m)
  for (let i = 0; i < m; i++) { centers[3 * i] = rnd() * 4 - 2; centers[3 * i + 1] = rnd() * 2; centers[3 * i + 2] = rnd() * 8 - 7; slots[i] = i % 3 }
  // three items: identity, shifted back 1 m, and turned 90° about y; the camera at (0, 1.4, 0) looking along −z
  const rows = new Float32Array(4 * 3)
  rows.set([0, 0, 1, 0], 0)          // z_view = z (V: translate by −1.4 in y only, so the z row is (0, 0, 1, 0))
  rows.set([0, 0, 1, -1], 4)         // item 1: z − 1
  rows.set([-1, 0, 0, 0], 8)         // item 2: Ry(90°) takes x to −z: z_view = −x
  const out = new Uint32Array(m)
  const near = 0.05, dmin = near, dmax = 9
  const visible = sortSplats({ centers, slots, rows, near, dmin, dmax, count: m }, out)
  const depth = (i) => { const s = 4 * (slots[i] ?? 0); return -((rows[s] ?? 0) * (centers[3 * i] ?? 0) + (rows[s + 1] ?? 0) * (centers[3 * i + 1] ?? 0) + (rows[s + 2] ?? 0) * (centers[3 * i + 2] ?? 0) + (rows[s + 3] ?? 0)) }
  let inFront = 0
  for (let i = 0; i < m; i++) if (depth(i) > near) inFront++
  check('the CPU sort leaves out the splats at or behind the near plane', visible === inFront && visible < m, `${visible} of ${m} drawn, ${inFront} in front`)
  let backToFront = true, stable = true
  for (let k = 1; k < visible; k++) {
    const a = out[k - 1] ?? 0, b = out[k] ?? 0
    const ka = depthKey(depth(a), near, dmin, dmax), kb = depthKey(depth(b), near, dmin, dmax)
    if (ka > kb) backToFront = false
    if (ka === kb && a > b) stable = false
  }
  check('…back to front (keys never decrease) and stable (equal keys keep index order)', backToFront && stable, `${backToFront ? 'ordered' : 'NOT ordered'}, ${stable ? 'stable' : 'NOT stable'}`)
  check('…16-bit keys: the far end is 0, the near end 65,534, culled 65,535', depthKey(dmax, near, dmin, dmax) === 0 && depthKey(dmin + 1e-9, near, dmin, dmax) === KEY_LEVELS - 1 && depthKey(0, near, dmin, dmax) === KEY_LEVELS, 'ok')
  const t0 = performance.now()
  const big = 262144
  const bc = new Float32Array(3 * big), bs = new Uint16Array(big), bo = new Uint32Array(big)
  for (let i = 0; i < 3 * big; i++) bc[i] = rnd() * 2 - 1
  const t1 = performance.now()
  sortSplats({ centers: bc, slots: bs, rows: new Float32Array([0, 0, 1, -3]), near, dmin: 1, dmax: 5, count: big }, bo)
  const ms = performance.now() - t1
  check('the CPU sort of 262,144 splats takes under 100 ms in Node (informative)', ms < 100, `${ms.toFixed(1)} ms (setup ${(t1 - t0).toFixed(0)} ms)`)
}

// --- a real splat.spz from the mocked pipeline --------------------------------------------------------------------------------
const file = process.argv[2]
if (file) {
  const raw = new Uint8Array(zlib.gunzipSync(fs.readFileSync(file)))
  const t0 = performance.now()
  const d = decodeSpzRaw(raw)
  const ms = performance.now() - t0
  const size = [0, 1, 2].map((k) => (d.max[k] ?? 0) - (d.min[k] ?? 0))
  check(`${file}: decodes (count, bounds)`, d.count > 0 && size.every((v) => v > 0 && v < 3), `${d.count} splats in ${ms.toFixed(0)} ms (Node), extent ${size.map((v) => v.toFixed(3)).join(' × ')} m, min y ${(d.min[1] ?? 0).toFixed(3)}`)
}
console.log(failed ? `unit: ${failed} failed` : 'unit: all passed')
process.exit(failed ? 1 : 0)
