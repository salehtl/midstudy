// The load lifecycle of core/js/web.ts, which a realm cannot undo: this file is one process and its tests run in order
// (unloaded, a failed load, two sources at once, loaded), then what needs the kernels: the camera across a memory
// growth and envMap's variants.
// Usage (repo root, after a build): nix develop -c npm run test:kernels-web
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import * as k from '../../../js/web.ts'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const goodBytes = new Uint8Array(fs.readFileSync(path.join(REPO, 'build/wasm/web/midstudy_wasm_web_bg.wasm')))
const BLOCK = { fov_y_deg: 60, height_m: 1.4, pitch_deg: -12, roll_deg: 2 }
const ITEM = { position: [0.3, 0, -2.5], rotation_y_deg: 30, min: [-0.4, 0, -0.3], max: [0.4, 0.8, 0.3] } as const

test('before any load, the module-level kernels say to load first', () => {
  assert.equal(k.kernelsLoaded(), false)
  assert.throws(() => k.clampCamera(BLOCK), /call loadKernels\(\) first/)
  assert.throws(() => k.boxCorners(ITEM), /call loadKernels\(\) first/)
  assert.throws(() => k.wrapDeg(10), /call loadKernels\(\) first/)
  assert.throws(() => new k.SceneCamera(BLOCK, 64, 48), /call loadKernels\(\) first/)
})

test('a failed load rejects, and the kernels then name that failure', async () => {
  await assert.rejects(k.loadKernels(new Uint8Array([0, 1, 2])), WebAssembly.CompileError)
  assert.equal(k.kernelsLoaded(), false)
  assert.throws(() => new k.SceneCamera(BLOCK, 64, 48), /last load failed \(.+\); call loadKernels\(\) again/)
  assert.throws(() => k.clampCamera(BLOCK), /last load failed \(.+\); call loadKernels\(\) again/)
})

test('a load from another source is refused while one is in flight; no source joins it; a retry after a failure works', async () => {
  const a = k.loadKernels(goodBytes)
  await assert.rejects(k.loadKernels(goodBytes.slice()), /another source/)
  const joined = k.loadKernels()
  const same = k.loadKernels(goodBytes)
  await Promise.all([a, joined, same])
  assert.equal(k.kernelsLoaded(), true)
})

test('loaded is final: any source resolves, loadKernelsSync is a no-op', async () => {
  await k.loadKernels(new Uint8Array([9, 9, 9]))
  k.loadKernelsSync(new Uint8Array([9, 9, 9]))
  assert.equal(k.clampCamera({ ...BLOCK, fov_y_deg: 500 }).fov_y_deg, 110)
})

test('a camera made before a memory growth answers the same after it', () => {
  const cam = new k.SceneCamera(BLOCK, 640, 480)
  const view = { s: 1, ox: 0, oy: 0 }
  const visible = { x: 0, y: 0, w: 640, h: 480 }
  const taken: [number, number][] = [[0, -2], [0.5, -2.5]]
  const ask = () => ({
    project: cam.project([0.5, 0.2, -3]),
    landing: cam.landingSpot(view, visible, taken),
    rect: cam.screenRect(ITEM),
  })
  const before = ask()
  const points = new Float64Array(3_999_999).map((_, i) => (i % 3 === 2 ? -1 - (i % 7) : i % 5))
  const projected = cam.projectMany(points) // 32 MB in and 32 MB out: past the module's initial memory
  assert.equal(projected.length, points.length)
  assert.deepEqual(ask(), before)
  cam.dispose()
})

function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1
  const exp = (h >> 10) & 0x1f
  const frac = h & 0x3ff
  if (exp === 0) return sign * frac * 2 ** -24
  if (exp === 31) return frac ? Number.NaN : sign * Infinity
  return sign * (1 + frac / 1024) * 2 ** (exp - 15)
}

test('envMap: the variant asked for, at width × height × 4, its half floats matching its floats', () => {
  const [pw, ph] = [64, 48]
  const photo = { width: pw, height: ph, data: new Uint8Array(pw * ph * 4).map((_, i) => (i * 37) & 255) }
  const cam = new k.SceneCamera(BLOCK, pw, ph)
  const pose = { rotation: cam.rotation(), fov_y_deg: BLOCK.fov_y_deg }
  cam.dispose()
  const size = { width: 64, height: 32, anisotropy: 0 }
  const asHalf = k.envMap(photo, pose, { ...size, half: true })
  const asFloat = k.envMap(photo, pose, { ...size, half: false })
  const byDefault = k.envMap(photo, pose, size)
  assert.ok(asHalf.data instanceof Uint16Array)
  assert.equal(asHalf.half, true)
  assert.ok(asFloat.data instanceof Float32Array)
  assert.equal(asFloat.half, false)
  assert.ok(byDefault.data instanceof Uint16Array)
  assert.equal(byDefault.half, true)
  for (const m of [asHalf, asFloat, byDefault]) assert.equal(m.data.length, 64 * 32 * 4)
  assert.deepEqual(byDefault.data, asHalf.data)
  asFloat.data.forEach((v, i) => {
    const h = halfToFloat(asHalf.data[i] ?? Number.NaN)
    assert.ok(Math.abs(h - v) <= Math.max(Math.abs(v) * 2 ** -10, 2 ** -24), `value ${i}: ${h} against ${v}`)
  })
})
