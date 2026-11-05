// The engines' output frames and the rotations into the item frame (contract §3.2, fixtures/fal/NOTES.md; v1's
// frames.py): each engine's (up, front) axes go to (+Y, +Z), then --yaw turns about +Y (counterclockwise seen from
// above); SAM 3D's splat comes in its photo's camera space and is first rotated into its GLB's frame. Pure: the
// trigonometry and square roots come in as parameters (the shell passes Math).

import type { PyValue } from './pyjson.ts'
import { get, numeric } from './pyjson.ts'
import { pyRound } from './pyformat.ts'

export type Vec3 = readonly [number, number, number]
export type Mat3 = readonly [Vec3, Vec3, Vec3]
export type Quat = readonly [number, number, number, number]

export interface MathFns {
  sqrt(x: number): number
  cos(x: number): number
  sin(x: number): number
}

export const IDENTITY: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

export type Axis = '+X' | '-X' | '+Y' | '-Y' | '+Z' | '-Z'
export type Asset = 'glb' | 'splat'

/** (up, front) of each engine's assets, measured on real captures (NOTES.md). */
export function engineFrame(engine: string, asset: Asset): readonly [Axis, Axis] | null {
  if (asset === 'glb') {
    return engine === 'sam3d' || engine === 'trellis2' || engine === 'idol' || engine === 'glb' || engine === 'rug' ? ['+Y', '+Z'] : null
  }
  if (engine === 'sam3d') return ['+Y', '+Z']
  if (engine === 'idol') return ['-Y', '+X']
  return null
}

function axisVector(a: Axis): Vec3 {
  switch (a) {
    case '+X': return [1, 0, 0]
    case '-X': return [-1, 0, 0]
    case '+Y': return [0, 1, 0]
    case '-Y': return [0, -1, 0]
    case '+Z': return [0, 0, 1]
    case '-Z': return [0, 0, -1]
  }
}

/** The rotation taking `up` to +Y and `front` to +Z: rows (up × front, up, front). */
export function frameRotation(up: Axis, front: Axis): Mat3 | null {
  const u = axisVector(up)
  const f = axisVector(front)
  if (u[0] * f[0] + u[1] * f[1] + u[2] * f[2] !== 0) return null
  const x: Vec3 = [u[1] * f[2] - u[2] * f[1], u[2] * f[0] - u[0] * f[2], u[0] * f[1] - u[1] * f[0]]
  return [x, u, f]
}

/** The rotation about +Y by `deg`, counterclockwise seen from above (+X turns toward −Z); cos and sin rounded to 12
 *  places as v1 rounds them, so quarter turns are exact. */
export function yawRotation(deg: number, m: MathFns): Mat3 {
  const a = deg * 0.017453292519943295
  const c = pyRound(m.cos(a), 12)
  const s = pyRound(m.sin(a), 12)
  return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
}

/** A · B. */
export function mul3(a: Mat3, b: Mat3): Mat3 {
  const row = (r: Vec3): Vec3 => [
    r[0] * b[0][0] + r[1] * b[1][0] + r[2] * b[2][0],
    r[0] * b[0][1] + r[1] * b[1][1] + r[2] * b[2][1],
    r[0] * b[0][2] + r[1] * b[1][2] + r[2] * b[2][2],
  ]
  return [row(a[0]), row(a[1]), row(a[2])]
}

/** v1's `orientation(engine, asset, yaw)`: the engine's frame, then the yaw; null for an engine without that asset. */
export function orientation(engine: string, asset: Asset, yaw: number, m: MathFns): Mat3 | null {
  const f = engineFrame(engine, asset)
  const r = f === null ? null : frameRotation(f[0], f[1])
  return r === null ? null : mul3(yawRotation(yaw, m), r)
}

/** The unit quaternion [x, y, z, w] (glTF order) of a rotation matrix (v1's `quat_xyzw`, Shepperd's method). */
export function quatXyzw(r: Mat3, m: MathFns): Quat {
  const tr = r[0][0] + r[1][1] + r[2][2]
  let w: number
  let x: number
  let y: number
  let z: number
  if (tr > 0) {
    const s = m.sqrt(tr + 1.0) * 2
    w = 0.25 * s
    x = (r[2][1] - r[1][2]) / s
    y = (r[0][2] - r[2][0]) / s
    z = (r[1][0] - r[0][1]) / s
  } else if (r[0][0] > r[1][1] && r[0][0] > r[2][2]) {
    const s = m.sqrt(1.0 + r[0][0] - r[1][1] - r[2][2]) * 2
    w = (r[2][1] - r[1][2]) / s
    x = 0.25 * s
    y = (r[0][1] + r[1][0]) / s
    z = (r[0][2] + r[2][0]) / s
  } else if (r[1][1] > r[2][2]) {
    const s = m.sqrt(1.0 + r[1][1] - r[0][0] - r[2][2]) * 2
    w = (r[0][2] - r[2][0]) / s
    x = (r[0][1] + r[1][0]) / s
    y = 0.25 * s
    z = (r[1][2] + r[2][1]) / s
  } else {
    const s = m.sqrt(1.0 + r[2][2] - r[0][0] - r[1][1]) * 2
    w = (r[1][0] - r[0][1]) / s
    x = (r[0][2] + r[2][0]) / s
    y = (r[1][2] + r[2][1]) / s
    z = 0.25 * s
  }
  const n = m.sqrt(x * x + y * y + z * z + w * w)
  return [x / n, y / n, z / n, w / n]
}

/** The rotation of a quaternion [w, x, y, z] of any length (v1's `quat_wxyz_matrix`). */
export function quatWxyzMatrix(q: Quat, m: MathFns): Mat3 {
  const n = m.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3])
  const w = q[0] / n
  const x = q[1] / n
  const y = q[2] / n
  const z = q[3] / n
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y)],
    [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x)],
    [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)],
  ]
}

const RX_NEG_90: Mat3 = [[1, 0, 0], [0, 0, 1], [0, -1, 0]]

/** The rotation taking a SAM 3D splat from camera space into its GLB's frame: Rx(−90°) · R(metadata[0].rotation[0]),
 *  or the identity when the response has no such pose (v1's `sam3d_splat_to_glb`). */
export function sam3dSplatToGlb(response: PyValue, m: MathFns): Mat3 {
  const meta = get(response, 'metadata')
  const first = meta?.kind === 'list' ? meta.items[0] : undefined
  const rot = first === undefined ? undefined : get(first, 'rotation')
  const q = rot?.kind === 'list' ? rot.items[0] : undefined
  if (q?.kind !== 'list' || q.items.length !== 4) return IDENTITY
  const vals = q.items.map((v) => numeric(v))
  const [a, b, c, d] = vals
  if (a === undefined || b === undefined || c === undefined || d === undefined || a === null || b === null || c === null || d === null) {
    return IDENTITY
  }
  return mul3(RX_NEG_90, quatWxyzMatrix([a, b, c, d], m))
}

/** The percentile range of the splat centers that measures an engine's splat (contract §1). */
export function percentiles(engine: string | null): readonly [number, number] {
  return engine === 'idol' ? [0.1, 99.9] : [1.0, 99.0]
}

/** The 9 numbers of a matrix, row major. */
export function flat(r: Mat3): number[] {
  return [r[0][0], r[0][1], r[0][2], r[1][0], r[1][1], r[1][2], r[2][0], r[2][1], r[2][2]]
}
