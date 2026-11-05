// Splat files → the arrays the splat renderer draws (contract §1 "splat.spz", "splat.ply"). Pure: no DOM, no three.js,
// so it runs in a worker or Node too. Positions stay in the item frame (no runtime transform beyond placement, §1).
//
// SPZ version 2 (nianticlabs/spz, what midstudy-add writes): gzip around a 16-byte little-endian header (magic
// 0x5053474e "NGSP", version, count, SH degree, fractional bits, flags, reserved), then per-attribute blocks:
// positions (count × 3 × 24-bit signed fixed point, value / 2^fractionalBits), alphas (count bytes, sigmoid(opacity) ×
// 255), colours (count × 3, f_dc × 0.15 × 255 + 127.5), scales (count × 3, (ln scale + 10) × 16), rotations (count × 3,
// the unit quaternion's x y z with w ≥ 0, v × 127.5 + 127.5), then SH bands (ignored: midstudy writes degree 0).
// PLY: binary little-endian 3DGS (x y z f_dc_0..2 opacity scale_0..2 rot_0..3 with rot_0 = w, float32), as E13 and E16
// write their probes and as splat.ply is stored.

export interface SplatData {
  readonly count: number
  /** item-frame centers, m: x y z per splat */
  readonly centers: Float32Array
  /** item-frame covariance Σ = R S² Rᵀ, m²: xx xy xz yy yz zz per splat */
  readonly covariances: Float32Array
  /** 0–255: r g b (the splat's own colour, sRGB-encoded as 3DGS trains it: 0.5 + C0·f_dc) and alpha */
  readonly colors: Uint8Array
  /** the centers' axis-aligned bounds (item frame) */
  readonly min: readonly [number, number, number]
  readonly max: readonly [number, number, number]
}

export const SPZ_MAGIC = 0x5053474e
const C0 = 0.28209479177387814
const SPZ_COLOR_SCALE = 0.15

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v)
const toByte = (v: number): number => Math.round(clamp01(v) * 255)

// Σ = R diag(s²) Rᵀ for the unit quaternion (w, x, y, z), written at covs[6i..6i+5].
function writeCovariance(covs: Float32Array, i: number, w: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void {
  const n = Math.hypot(w, x, y, z) || 1
  w /= n; x /= n; y /= n; z /= n
  const r00 = 1 - 2 * (y * y + z * z), r01 = 2 * (x * y - w * z), r02 = 2 * (x * z + w * y)
  const r10 = 2 * (x * y + w * z), r11 = 1 - 2 * (x * x + z * z), r12 = 2 * (y * z - w * x)
  const r20 = 2 * (x * z - w * y), r21 = 2 * (y * z + w * x), r22 = 1 - 2 * (x * x + y * y)
  const a = sx * sx, b = sy * sy, c = sz * sz
  const o = 6 * i
  covs[o] = r00 * r00 * a + r01 * r01 * b + r02 * r02 * c
  covs[o + 1] = r00 * r10 * a + r01 * r11 * b + r02 * r12 * c
  covs[o + 2] = r00 * r20 * a + r01 * r21 * b + r02 * r22 * c
  covs[o + 3] = r10 * r10 * a + r11 * r11 * b + r12 * r12 * c
  covs[o + 4] = r10 * r20 * a + r11 * r21 * b + r12 * r22 * c
  covs[o + 5] = r20 * r20 * a + r21 * r21 * b + r22 * r22 * c
}

function bounds(centers: Float32Array, count: number): { min: [number, number, number], max: [number, number, number] } {
  if (count === 0) return { min: [0, 0, 0], max: [0, 0, 0] }
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity
  for (let i = 0; i < count; i++) {
    const x = centers[3 * i] ?? 0, y = centers[3 * i + 1] ?? 0, z = centers[3 * i + 2] ?? 0
    if (x < x0) x0 = x
    if (x > x1) x1 = x
    if (y < y0) y0 = y
    if (y > y1) y1 = y
    if (z < z0) z0 = z
    if (z > z1) z1 = z
  }
  return { min: [x0, y0, z0], max: [x1, y1, z1] }
}

/** Decodes an SPZ v2 payload that is already gunzipped. */
export function decodeSpzRaw(raw: Uint8Array): SplatData {
  if (raw.byteLength < 16) throw new Error('splat.spz is too short for its header')
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const magic = dv.getUint32(0, true), version = dv.getUint32(4, true), count = dv.getUint32(8, true)
  const shDegree = dv.getUint8(12), frac = dv.getUint8(13)
  if (magic !== SPZ_MAGIC) throw new Error(`not an SPZ file (magic 0x${magic.toString(16)})`)
  if (version !== 2) throw new Error(`SPZ version ${version} is not supported (midstudy writes version 2)`)
  if (shDegree > 3) throw new Error(`SPZ SH degree ${shDegree} is not valid`)
  const need = 16 + count * 19
  if (raw.byteLength < need) throw new Error(`splat.spz holds ${raw.byteLength} bytes, ${need} needed for ${count} splats`)
  const pos = 16, alp = pos + 9 * count, col = alp + count, scl = col + 3 * count, rot = scl + 3 * count
  const centers = new Float32Array(3 * count)
  const covariances = new Float32Array(6 * count)
  const colors = new Uint8Array(4 * count)
  const step = 1 / (1 << frac)
  for (let i = 0; i < count; i++) {
    for (let k = 0; k < 3; k++) {
      const o = pos + 9 * i + 3 * k
      let v = (raw[o] ?? 0) | ((raw[o + 1] ?? 0) << 8) | ((raw[o + 2] ?? 0) << 16)
      if (v & 0x800000) v -= 0x1000000
      centers[3 * i + k] = v * step
    }
    for (let k = 0; k < 3; k++) colors[4 * i + k] = toByte(0.5 + C0 * (((raw[col + 3 * i + k] ?? 0) - 127.5) / (SPZ_COLOR_SCALE * 255)))
    colors[4 * i + 3] = raw[alp + i] ?? 0
    const sx = Math.exp((raw[scl + 3 * i] ?? 0) / 16 - 10), sy = Math.exp((raw[scl + 3 * i + 1] ?? 0) / 16 - 10), sz = Math.exp((raw[scl + 3 * i + 2] ?? 0) / 16 - 10)
    const qx = (raw[rot + 3 * i] ?? 0) / 127.5 - 1, qy = (raw[rot + 3 * i + 1] ?? 0) / 127.5 - 1, qz = (raw[rot + 3 * i + 2] ?? 0) / 127.5 - 1
    const qw = Math.sqrt(Math.max(0, 1 - qx * qx - qy * qy - qz * qz))
    writeCovariance(covariances, i, qw, qx, qy, qz, sx, sy, sz)
  }
  return { count, centers, covariances, colors, ...bounds(centers, count) }
}

/** Gunzips with the platform's DecompressionStream (browsers, workers, Node ≥ 18). */
export async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const stream = new Blob([copy]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

const PLY_PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3'] as const
type PlyProp = typeof PLY_PROPS[number]
const SIZES: Record<string, number> = { char: 1, uchar: 1, int8: 1, uint8: 1, short: 2, ushort: 2, int16: 2, uint16: 2, int: 4, uint: 4, int32: 4, uint32: 4, float: 4, float32: 4, double: 8, float64: 8 }

/** Decodes a binary little-endian 3DGS PLY (float32 for the properties used). */
export function decodePly(bytes: Uint8Array): SplatData {
  const headEnd = (() => {
    const tag = [0x65, 0x6e, 0x64, 0x5f, 0x68, 0x65, 0x61, 0x64, 0x65, 0x72, 0x0a] // "end_header\n"
    outer: for (let i = 0; i < Math.min(bytes.length, 65536); i++) {
      for (let k = 0; k < tag.length; k++) if (bytes[i + k] !== tag[k]) continue outer
      return i + tag.length
    }
    throw new Error('PLY header has no end_header')
  })()
  const header = new TextDecoder().decode(bytes.subarray(0, headEnd))
  if (!/^ply\n/.test(header) || !/format binary_little_endian 1\.0/.test(header)) throw new Error('only binary little-endian PLY splats are supported')
  let count = 0
  const offsets = new Map<string, { offset: number, type: string }>()
  let stride = 0
  let inVertex = false
  for (const line of header.split('\n')) {
    const p = line.trim().split(/\s+/)
    if (p[0] === 'element') { inVertex = p[1] === 'vertex'; if (inVertex) count = Number(p[2]) }
    else if (p[0] === 'property' && inVertex) {
      if (p[1] === 'list') throw new Error('PLY list properties are not supported in a splat')
      const type = p[1] ?? '', name = p[2] ?? '', size = SIZES[type]
      if (size === undefined) throw new Error(`PLY property type ${type} is not supported`)
      offsets.set(name, { offset: stride, type })
      stride += size
    }
  }
  for (const name of PLY_PROPS) {
    const o = offsets.get(name)
    if (!o) throw new Error(`the splat PLY has no ${name}`)
    if (o.type !== 'float' && o.type !== 'float32') throw new Error(`the splat PLY's ${name} is ${o.type}, not float`)
  }
  if (bytes.length < headEnd + count * stride) throw new Error('the splat PLY is shorter than its header says')
  const dv = new DataView(bytes.buffer, bytes.byteOffset + headEnd, count * stride)
  const at = (name: PlyProp): number => offsets.get(name)?.offset ?? 0
  const o = PLY_PROPS.map(at) // in PLY_PROPS order
  const centers = new Float32Array(3 * count)
  const covariances = new Float32Array(6 * count)
  const colors = new Uint8Array(4 * count)
  const v = new Float64Array(PLY_PROPS.length)
  for (let i = 0; i < count; i++) {
    const b = i * stride
    for (let k = 0; k < o.length; k++) v[k] = dv.getFloat32(b + (o[k] ?? 0), true)
    const [x = 0, y = 0, z = 0, d0 = 0, d1 = 0, d2 = 0, op = 0, s0 = 0, s1 = 0, s2 = 0, qw = 1, qx = 0, qy = 0, qz = 0] = v
    centers[3 * i] = x; centers[3 * i + 1] = y; centers[3 * i + 2] = z
    colors[4 * i] = toByte(0.5 + C0 * d0)
    colors[4 * i + 1] = toByte(0.5 + C0 * d1)
    colors[4 * i + 2] = toByte(0.5 + C0 * d2)
    colors[4 * i + 3] = toByte(1 / (1 + Math.exp(-op)))
    writeCovariance(covariances, i, qw, qx, qy, qz, Math.exp(s0), Math.exp(s1), Math.exp(s2))
  }
  return { count, centers, covariances, colors, ...bounds(centers, count) }
}

/** splat.spz (gzip) or splat.ply, told apart by their first bytes. */
export async function decodeSplat(bytes: Uint8Array): Promise<SplatData> {
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return decodeSpzRaw(await gunzip(bytes))
  if (bytes[0] === 0x70 && bytes[1] === 0x6c && bytes[2] === 0x79) return decodePly(bytes)
  if (bytes.byteLength >= 4 && new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === SPZ_MAGIC) return decodeSpzRaw(bytes)
  throw new Error('not a splat file (neither gzipped SPZ nor PLY)')
}
