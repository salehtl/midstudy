// The planner's typed face of midstudy's geometry and raster kernels (core/crates/{geom,raster,wasm-web}, built by
// wasm-bindgen --target web into build/wasm/web/). Contract §4.1 (projection, inverse, horizon), §4.5 (landing, drag,
// occlusion depth, keep-room mask), §4.7, §4.8 (SH rotation, key light, splat colour level, the environment map).
//
// Load once, then call synchronously:
//   await loadKernels()                     // fetches midstudy_wasm_web_bg.wasm next to the glue (or pass bytes / a URL)
//   const cam = new SceneCamera(block, W, H) // per camera change; dispose() it (a FinalizationRegistry also frees it)
//   cam.project([x, y, z]) → [px, py, d];  cam.photoToFloor(px, py) → [x, 0, z] | null;  …
// The heavy kernels (depth.png, the environment map, the keep-room mask) also run in a Web Worker:
//   worker entry:   import { serveKernels } from '…/core/js/web.ts'; serveKernels(self)
//   main thread:    const k = new KernelWorker(new Worker(url, { type: 'module' })); await k.decodeDepth(bytes)
// Inputs are transferred to the worker and results transferred back (no copies beyond the one into wasm memory).
//
// Precision: the geometry is f64 throughout and agrees with v1's JavaScript to 1e-9 relative (contract §4.1, checked
// differentially); decisions (null at the horizon, hull hits, the landing ring) take v1's branches. Depth comes back in
// metres as f32, bit-identical to v1's Float32Array; the mask is exact; the environment map is f32 or half floats.
// Matrices are three.js Matrix3.elements (column-major, 9 numbers); SH are 9 [r, g, b] rows in SphericalHarmonics3 order.
import init, * as wasm from '../../build/wasm/web/midstudy_wasm_web.js'
import type { InitInput, InitOutput, SyncInitInput } from '../../build/wasm/web/midstudy_wasm_web.js'

export type Vec3 = [number, number, number]
export type Vec2 = [number, number]
/** three.js Matrix3.elements: column-major. */
export type Mat3Elements = readonly number[]
export type Sh9 = readonly (readonly [number, number, number])[]

export interface CameraBlock {
  fov_y_deg: number
  height_m: number
  pitch_deg: number
  roll_deg: number
}
export const CAMERA_RANGE = {
  fov_y_deg: [20, 110],
  height_m: [0.2, 3.0],
  pitch_deg: [-80, 30],
  roll_deg: [-20, 20],
} as const
export const DEFAULT_CAMERA: Readonly<CameraBlock> = Object.freeze({ fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 })

/** An item on the floor: its pose and its local box (item frame: origin at the footprint's centre, front +Z). */
export interface ItemBox {
  position: Readonly<Vec3>
  rotation_y_deg: number
  min: Readonly<Vec3>
  max: Readonly<Vec3>
}
/** client = o + s · photo px (v1's viewParams). */
export interface ViewXform {
  s: number
  ox: number
  oy: number
}
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}
/** normal · p + constant = 0 (three.js Plane). */
export interface Plane {
  normal: Readonly<Vec3>
  constant: number
}

// --- loading --------------------------------------------------------------------------------------------------------

let exports: InitOutput | null = null
let loading: Promise<void> | null = null

/** Loads the wasm (once; concurrent calls share the load). `source`: the .wasm's URL, a Response, its bytes or a
 * compiled Module; default: fetched next to the glue module. A failed load can be retried. */
export function loadKernels(source?: InitInput): Promise<void> {
  loading ??= (source === undefined ? init() : init({ module_or_path: source })).then(
    (e) => { exports = e },
    (err: unknown) => { loading = null; throw err },
  )
  return loading
}

/** Loads the wasm synchronously from its bytes or a compiled Module (Node, workers that already hold the bytes). */
export function loadKernelsSync(source: SyncInitInput): void {
  if (exports) return
  // A second instance would replace the first under objects already made from it.
  if (loading) throw new Error('midstudy kernels: an asynchronous load is already in progress')
  exports = wasm.initSync({ module: source })
  loading = Promise.resolve()
}

export function kernelsLoaded(): boolean {
  return exports !== null
}

function memory(): WebAssembly.Memory {
  if (!exports) throw new Error('midstudy kernels: call loadKernels() first')
  return exports.memory
}

const f64s = (v: Iterable<number>): Float64Array => Float64Array.from(v)
const vec3 = (a: ArrayLike<number>, at = 0): Vec3 => [num(a, at), num(a, at + 1), num(a, at + 2)]
function num(a: ArrayLike<number>, i: number): number {
  const v = a[i]
  return v === undefined ? Number.NaN : v
}
function triples(a: ArrayLike<number>): Vec3[] {
  const out: Vec3[] = []
  for (let i = 0; i + 2 < a.length; i += 3) out.push(vec3(a, i))
  return out
}
function pairs(a: ArrayLike<number>): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i + 1 < a.length; i += 2) out.push([num(a, i), num(a, i + 1)])
  return out
}
const flatSh = (sh: Sh9): Float64Array => {
  if (sh.length !== 9) throw new Error('an SH is 9 [r, g, b] coefficients')
  return f64s(sh.flat())
}
const shOf = (a: ArrayLike<number>): Vec3[] => triples(a)

// --- the camera ------------------------------------------------------------------------------------------------------

const cameraRegistry = new FinalizationRegistry<wasm.Camera>((c) => { c.free() })

/** The scene camera (contract §4.1) on a W × H photo. Results are read from the camera's scratch in wasm memory. */
export class SceneCamera {
  readonly block: Readonly<CameraBlock>
  readonly width: number
  readonly height: number
  #cam: wasm.Camera | null
  #view: Float64Array | null = null

  constructor(block: Readonly<CameraBlock>, width: number, height: number) {
    memory()
    this.block = Object.freeze({ ...block })
    this.width = width
    this.height = height
    this.#cam = new wasm.Camera(block.fov_y_deg, block.height_m, block.pitch_deg, block.roll_deg, width, height)
    cameraRegistry.register(this, this.#cam, this)
  }

  /** Frees the wasm side now (otherwise the garbage collector does). */
  dispose(): void {
    if (!this.#cam) return
    cameraRegistry.unregister(this)
    this.#cam.free()
    this.#cam = null
    this.#view = null
  }

  #c(): wasm.Camera {
    if (!this.#cam) throw new Error('SceneCamera used after dispose()')
    return this.#cam
  }

  /** The scratch view, re-made when wasm memory has grown (growth detaches the old buffer: its views read length 0). */
  #s(): Float64Array {
    const v = this.#view
    if (v && v.length === 32) return v
    const fresh = new Float64Array(memory().buffer, this.#c().outPtr(), 32)
    this.#view = fresh
    return fresh
  }

  focal(): number {
    return this.#c().focal()
  }

  /** R, camera-to-world, as Matrix3.elements. */
  rotation(): number[] {
    this.#c().rotation()
    return Array.from(this.#s().subarray(0, 9))
  }

  /** v1's projectPhoto: [px, py, d] (d along the view axis, > 0 in front). */
  project(p: Readonly<Vec3>): Vec3 {
    this.#c().project(p[0], p[1], p[2])
    return vec3(this.#s())
  }

  /** v1's floorToPhoto (any point): [px, py]. */
  floorToPhoto(p: Readonly<Vec3>): Vec2 {
    this.#c().project(p[0], p[1], p[2])
    const s = this.#s()
    return [num(s, 0), num(s, 1)]
  }

  /** v1's photoToFloor: [x, 0, z], or null at or above the horizon. */
  photoToFloor(px: number, py: number): Vec3 | null {
    return this.#c().photoToFloor(px, py) ? vec3(this.#s()) : null
  }

  /** v1's photoRay: origin (the eye) and unit direction. */
  ray(px: number, py: number): { origin: Vec3; dir: Vec3 } {
    this.#c().ray(px, py)
    const s = this.#s()
    return { origin: vec3(s), dir: vec3(s, 3) }
  }

  /** v1's horizonAt: the horizon's row at column px, or null when vertical. */
  horizonAt(px: number): number | null {
    return this.#c().horizonAt(px) ?? null
  }

  /** The pitch (degrees, unclamped: pass it through clampCamera) putting the horizon at row py of the centre column. */
  pitchFromHorizon(py: number): number | null {
    return this.#c().pitchFromHorizon(py) ?? null
  }

  /** Projects many points: `points` xyz triples → px, py, d triples (a new array). */
  projectMany(points: Float64Array): Float64Array {
    const c = this.#c()
    const n = points.length
    const src = new wasm.F64Buf(n)
    const dst = new wasm.F64Buf(n)
    try {
      new Float64Array(memory().buffer, src.ptr(), n).set(points)
      c.projectMany(src, dst)
      return new Float64Array(memory().buffer, dst.ptr(), n).slice()
    } finally {
      src.free()
      dst.free()
    }
  }

  #putItem(item: Readonly<ItemBox>): Float64Array {
    const s = this.#s()
    s[0] = item.position[0]
    s[1] = item.position[1]
    s[2] = item.position[2]
    s[3] = item.rotation_y_deg
    s[4] = item.min[0]
    s[5] = item.min[1]
    s[6] = item.min[2]
    s[7] = item.max[0]
    s[8] = item.max[1]
    s[9] = item.max[2]
    return s
  }

  /** v1's getScreenRect: the item's projected bounds in photo px (corners behind the camera ignored), or null. */
  screenRect(item: Readonly<ItemBox>): Rect | null {
    this.#putItem(item)
    if (!this.#c().screenRect()) return null
    const s = this.#s()
    return { x: num(s, 0), y: num(s, 1), w: num(s, 2), h: num(s, 3) }
  }

  /** v1's hitItemAt test on screen: 'behind' when a corner is behind the camera (raycast the mesh instead). */
  hitBox(item: Readonly<ItemBox>, view: Readonly<ViewXform>, x: number, y: number, pad = 16): 'hit' | 'miss' | 'behind' {
    const s = this.#putItem(item)
    s[10] = view.s
    s[11] = view.ox
    s[12] = view.oy
    const r = this.#c().hitBox(x, y, pad)
    return r > 0 ? 'hit' : r < 0 ? 'behind' : 'miss'
  }

  /** v1's landingSpot: `visible` the visible photo rect in client px on `view`; `taken` the placed pieces' (x, z). */
  landingSpot(view: Readonly<ViewXform>, visible: Readonly<Rect>, taken: readonly (readonly [number, number])[]): Vec3 {
    this.#c().landingSpot(f64s([view.s, view.ox, view.oy]), f64s([visible.x, visible.y, visible.w, visible.h]), f64s(taken.flat()))
    return vec3(this.#s())
  }

  /** v1's planePointAt for a photo pixel: the hit within 60 m, or null. */
  planePointAt(px: number, py: number, plane: Readonly<Plane>): Vec3 | null {
    const n = plane.normal
    return this.#c().planePointAt(px, py, n[0], n[1], n[2], plane.constant) ? vec3(this.#s()) : null
  }
}

// --- clamps and small maths -------------------------------------------------------------------------------------------

/** v1's clampCamera(c, base): each field clamped and rounded to 6 decimals; a non-finite or missing one takes base's. */
export function clampCamera(c: Readonly<Partial<CameraBlock>>, base: Readonly<CameraBlock> = DEFAULT_CAMERA): CameraBlock {
  const pick = (v: number | undefined): number => (typeof v === 'number' ? v : Number.NaN)
  const a = wasm.clampCamera(
    f64s([pick(c.fov_y_deg), pick(c.height_m), pick(c.pitch_deg), pick(c.roll_deg)]),
    f64s([base.fov_y_deg, base.height_m, base.pitch_deg, base.roll_deg]),
  )
  return { fov_y_deg: num(a, 0), height_m: num(a, 1), pitch_deg: num(a, 2), roll_deg: num(a, 3) }
}

export const LOOK_KEYS = ['exposure', 'warmth', 'light_azimuth_deg', 'light_elevation_deg', 'light_softness', 'light_strength', 'ambient'] as const
export type LookNumberKey = (typeof LOOK_KEYS)[number]
/** One Look value clamped as v1 does (the azimuth wrapped first); null means the inferred default. */
export function clampLook(key: LookNumberKey, v: number): number | null {
  return wasm.clampLook(LOOK_KEYS.indexOf(key), v) ?? null
}

export const wrapDeg = (d: number): number => wasm.wrapDeg(d)
export const wrapAz = (a: number): number => wasm.wrapAz(a)
/** v1's round(v, n): Math.round(v · 10ⁿ) / 10ⁿ. */
export const roundTo = (v: number, n: number): number => wasm.roundTo(v, n)
export const clampElevation = (y: number): number => wasm.clampElevation(y)
/** v1's rotateSelected step: round(wrapDeg(rot + deg), 6). */
export const rotateBy = (rotationYDeg: number, deg: number): number => wasm.rotateBy(rotationYDeg, deg)
/** v1's depthScale: height / calib height with a measured floor, else 1. */
export const depthScale = (heightM: number, calibHeightM: number, measured: boolean): number => wasm.depthScale(heightM, calibHeightM, measured)
/** The horizon drag's gain: the tilt is capped at 0.12° per CSS px on a small photo (contract §4.5). */
export const horizonDragGain = (fovYDeg: number, rectHCss: number): number => wasm.horizonDragGain(fovYDeg, rectHCss)
/** The row a horizon drag asks for: py0 + (dy / s) · gain. */
export const horizonDragRow = (py0: number, dyCss: number, cssPerPx: number, gain: number): number => wasm.horizonDragRow(py0, dyCss, cssPerPx, gain)

// --- items, hulls, drags ----------------------------------------------------------------------------------------------

const pose = (it: Readonly<ItemBox>): Float64Array => f64s([it.position[0], it.position[1], it.position[2], it.rotation_y_deg])

/** The 8 world corners, v1's order: bottom then top ring, each back-left, back-right, front-right, front-left. */
export function boxCorners(item: Readonly<ItemBox>): Vec3[] {
  return triples(wasm.boxCorners(pose(item), f64s(item.min), f64s(item.max)))
}
/** v1's worldBounds. */
export function worldBounds(item: Readonly<ItemBox>): { min: Vec3; max: Vec3 } {
  const a = wasm.worldBounds(pose(item), f64s(item.min), f64s(item.max))
  return { min: vec3(a), max: vec3(a, 3) }
}
/** v1's getFootprint without the box: corners front-left, front-right, back-right, back-left; centre; height. */
export function footprint(item: Readonly<ItemBox>): { corners: Vec3[]; center: Vec3; height: number } {
  const a = wasm.footprint(pose(item), f64s(item.min), f64s(item.max))
  return { corners: triples(a.subarray(0, 12)), center: vec3(a, 12), height: num(a, 15) }
}
/** v1's convexHull (finite points). */
export function convexHull(points: readonly (readonly [number, number])[]): Vec2[] {
  return pairs(wasm.convexHull(f64s(points.flat())))
}
export const pointInHull = (hull: readonly (readonly [number, number])[], x: number, y: number): boolean => wasm.pointInHull(f64s(hull.flat()), x, y)
export const distToHull = (hull: readonly (readonly [number, number])[], x: number, y: number): number => wasm.distToHull(f64s(hull.flat()), x, y)
/** v1's dragHeight (grabY null when grabbed beside the piece). */
export const dragHeight = (grabY: number | null, minY: number, maxY: number, eye: number): number => wasm.dragHeight(grabY, minY, maxY, eye)
/** v1's lift plane through an item's position, facing the camera. */
export function liftPlane(position: Readonly<Vec3>): Plane {
  const a = wasm.liftPlane(f64s(position))
  return { normal: vec3(a), constant: num(a, 3) }
}
/** A move drag's new [x, z]: round(hit + offset, 6). */
export function dragMove(hit: Readonly<Vec3>, offset: Readonly<Vec3>): Vec2 {
  const a = wasm.dragMove(f64s(hit), f64s(offset))
  return [num(a, 0), num(a, 1)]
}
export const dragLift = (hitY: number, offsetY: number, snap: boolean): number => wasm.dragLift(hitY, offsetY, snap)
export const gripAngle = (hit: Readonly<Vec3>, center: Readonly<Vec3>): number => wasm.gripAngle(f64s(hit), f64s(center))
export const dragRotate = (rot0Deg: number, angle: number, angle0: number, snap: boolean): number => wasm.dragRotate(rot0Deg, angle, angle0, snap)
/** v1's setRulerTrueLength maths: the new height, the scale for the ruler's points, whether it is exact. */
export function rulerRescale(heightM: number, measuredM: number, trueM: number): { height_m: number; k: number; exact: boolean } | null {
  const a = wasm.rulerRescale(heightM, measuredM, trueM)
  return a.length === 3 ? { height_m: num(a, 0), k: num(a, 1), exact: num(a, 2) === 1 } : null
}

// --- the light ----------------------------------------------------------------------------------------------------------

export function azElOf(d: Readonly<Vec3>): { azimuth_deg: number; elevation_deg: number } {
  const a = wasm.azElOf(d[0], d[1], d[2])
  return { azimuth_deg: num(a, 0), elevation_deg: num(a, 1) }
}
export const dirOf = (azDeg: number, elDeg: number): Vec3 => vec3(wasm.dirOf(azDeg, elDeg))
/** v1's turnBetween(a, b): Matrix3.elements. */
export const turnBetween = (a: Readonly<Vec3>, b: Readonly<Vec3>): number[] => Array.from(wasm.turnBetween(f64s(a), f64s(b)))
/** The probe turned by R (camera-to-world): band 1 exactly, band 2 by evaluate-turn-refit as v1. */
export const rotateSh = (sh: Sh9, r: Mat3Elements): Vec3[] => shOf(wasm.rotateSh(flatSh(sh), f64s(r)))
export const irradianceAt = (sh: Sh9, d: Readonly<Vec3>): Vec3 => vec3(wasm.irradianceAt(flatSh(sh), d[0], d[1], d[2]))
export const scaleBands = (sh: Sh9, k: number): Vec3[] => shOf(wasm.scaleBands(flatSh(sh), k))
export const maxBandScale = (sh: Sh9): number => wasm.maxBandScale(flatSh(sh))
/** v1's splatGain(): `room` null for the v1 lights (no lighting.json). */
export function splatGain(
  room: { worldSh: Sh9; keyColor: Readonly<Vec3>; keyIntensity: number; whiteBalance: Readonly<Vec3> | null } | null,
  ambient: number,
  strength: number,
): Vec3 {
  if (!room) return vec3(wasm.splatGain(new Float64Array(0), new Float64Array(0), 0, new Float64Array(0), ambient, strength))
  return vec3(wasm.splatGain(flatSh(room.worldSh), f64s(room.keyColor), room.keyIntensity, f64s(room.whiteBalance ?? [1, 1, 1]), ambient, strength))
}
/** The splat pass multiplier: warmthTint(warmth) · exposure · gain. */
export const splatMultiplier = (warmth: number, exposure: number, gain: Readonly<Vec3>): Vec3 => vec3(wasm.splatMultiplier(warmth, exposure, f64s(gain)))

// --- the heavy kernels ----------------------------------------------------------------------------------------------------

export interface DepthMap {
  width: number
  height: number
  /** metres (× scale), rows top to bottom; 0 = no occluder */
  data: Float32Array
}
export interface KeepRoomMask {
  width: number
  height: number
  /** share of pixels set */
  coverage: number
  /** 0/1 per pixel, rows top to bottom */
  mask: Uint8Array
  /** the mask as an 8-bit grayscale PNG (white on black), when asked for */
  png: Uint8Array | null
}
export interface EnvMap {
  width: number
  height: number
  /** RGBA, row 0 looking down (a DataTexture with flipY false); Uint16Array of half floats when `half` */
  data: Float32Array | Uint16Array
  half: boolean
}
export interface EnvMapOptions {
  /** default 512 × 256 (v1) */
  width?: number
  height?: number
  /** 0: bilinear on the full photo; 1–16: mipmapped with that much anisotropy (v1: 4, the default) */
  anisotropy?: number
  /** half floats for a HalfFloatType texture (default true, as v1's target) */
  half?: boolean
}
export interface RgbaImage {
  width: number
  height: number
  data: Uint8Array | Uint8ClampedArray
}

/** depth.png (contract §4.2) to metres × scale; scale 1 gives v1's values exactly. Throws on anything but an 8- or
 * 16-bit grayscale, non-interlaced, well-formed PNG. */
export function decodeDepth(png: Uint8Array, scale = 1): DepthMap {
  const r = wasm.decodeDepth(png, scale)
  try {
    return { width: r.width(), height: r.height(), data: new Float32Array(memory().buffer, r.ptr(), r.len()).slice() }
  } finally {
    r.free()
  }
}

/** The keep-room mask (contract §4.7) from the mask render's RGBA readback (WebGL rows bottom-up by default). */
export function keepRoomMask(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number, opts: { bottomUp?: boolean; png?: boolean; level?: number } = {}): KeepRoomMask {
  const bytes = rgba instanceof Uint8Array ? rgba : new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  const r = wasm.keepRoomMask(bytes, width, height, opts.bottomUp ?? true)
  try {
    const mask = new Uint8Array(memory().buffer, r.ptr(), r.len()).slice()
    const png = opts.png ? r.toPng(width, height, opts.level ?? 6) : null
    return { width, height, coverage: r.coverage(), mask, png }
  } finally {
    r.free()
  }
}

/** v1's dilate(src, w, h, left, right, up, down). */
export const dilate = (src: Uint8Array, width: number, height: number, left: number, right: number, up: number, down: number): Uint8Array =>
  wasm.dilate(src, width, height, left, right, up, down)

/** The environment map from the photo (contract §4.8): `rotation` the scene camera's R (Matrix3.elements). */
export function envMap(photo: Readonly<RgbaImage>, cam: { rotation: Mat3Elements; fov_y_deg: number }, opts: EnvMapOptions = {}): EnvMap {
  const width = opts.width ?? 512
  const height = opts.height ?? 256
  const half = opts.half ?? true
  const bytes = photo.data instanceof Uint8Array ? photo.data : new Uint8Array(photo.data.buffer, photo.data.byteOffset, photo.data.byteLength)
  const r = wasm.envMap(bytes, photo.width, photo.height, f64s(cam.rotation), cam.fov_y_deg, width, height, opts.anisotropy ?? 4, half)
  try {
    const buf = memory().buffer
    const data = half ? new Uint16Array(buf, r.f16Ptr(), r.f16Len()).slice() : new Float32Array(buf, r.f32Ptr(), r.f32Len()).slice()
    return { width, height, data, half }
  } finally {
    r.free()
  }
}

// --- the worker ---------------------------------------------------------------------------------------------------------

/** What a worker scope, a Worker or a MessagePort offers (a MessagePort is started when it has `start`). */
export interface KernelPort {
  postMessage(message: unknown, transfer: Transferable[]): void
  addEventListener(type: 'message', listener: (e: MessageEvent<unknown>) => void): void
  start?(): void
}

type Request =
  | { id: number; op: 'decodeDepth'; png: ArrayBuffer; scale: number }
  | { id: number; op: 'keepRoomMask'; rgba: ArrayBuffer; width: number; height: number; bottomUp: boolean; png: boolean; level: number }
  | { id: number; op: 'envMap'; photo: ArrayBuffer; width: number; height: number; rotation: number[]; fov: number; opts: EnvMapOptions }
  | { id: number; op: 'envMapFromImage'; image: Blob; maxSide: number; rotation: number[]; fov: number; opts: EnvMapOptions }

type Reply =
  | { id: number; ok: true; op: 'decodeDepth'; value: DepthMap }
  | { id: number; ok: true; op: 'keepRoomMask'; value: KeepRoomMask }
  | { id: number; ok: true; op: 'envMap'; value: EnvMap }
  | { id: number; ok: false; error: string }

const isObj = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null
const isNum = (x: unknown): x is number => typeof x === 'number'
const isNums = (x: unknown): x is number[] => Array.isArray(x) && x.every(isNum)

function envOpts(x: unknown): EnvMapOptions {
  const o: EnvMapOptions = {}
  if (!isObj(x)) return o
  if (isNum(x['width'])) o.width = x['width']
  if (isNum(x['height'])) o.height = x['height']
  if (isNum(x['anisotropy'])) o.anisotropy = x['anisotropy']
  if (typeof x['half'] === 'boolean') o.half = x['half']
  return o
}

function parseRequest(x: unknown): Request | null {
  if (!isObj(x) || !isNum(x['id'])) return null
  const id = x['id']
  const op = x['op']
  if (op === 'decodeDepth' && x['png'] instanceof ArrayBuffer && isNum(x['scale'])) return { id, op, png: x['png'], scale: x['scale'] }
  if (op === 'keepRoomMask' && x['rgba'] instanceof ArrayBuffer && isNum(x['width']) && isNum(x['height'])) {
    return { id, op, rgba: x['rgba'], width: x['width'], height: x['height'], bottomUp: x['bottomUp'] !== false, png: x['png'] === true, level: isNum(x['level']) ? x['level'] : 6 }
  }
  if (op === 'envMap' && x['photo'] instanceof ArrayBuffer && isNum(x['width']) && isNum(x['height']) && isNums(x['rotation']) && isNum(x['fov'])) {
    return { id, op, photo: x['photo'], width: x['width'], height: x['height'], rotation: x['rotation'], fov: x['fov'], opts: envOpts(x['opts']) }
  }
  if (op === 'envMapFromImage' && x['image'] instanceof Blob && isNum(x['maxSide']) && isNums(x['rotation']) && isNum(x['fov'])) {
    return { id, op, image: x['image'], maxSide: x['maxSide'], rotation: x['rotation'], fov: x['fov'], opts: envOpts(x['opts']) }
  }
  return null
}

/** Decodes an image to RGBA in a worker (createImageBitmap + OffscreenCanvas), its long side at most `maxSide`. */
async function imagePixels(image: Blob, maxSide: number): Promise<RgbaImage> {
  if (typeof createImageBitmap !== 'function' || typeof OffscreenCanvas !== 'function') throw new Error('no createImageBitmap/OffscreenCanvas here')
  const probe = await createImageBitmap(image)
  const k = Math.min(1, maxSide / Math.max(probe.width, probe.height))
  const width = Math.max(1, Math.round(probe.width * k))
  const height = Math.max(1, Math.round(probe.height * k))
  const bmp = k < 1 ? await createImageBitmap(image, { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' }) : probe
  const ctx = new OffscreenCanvas(width, height).getContext('2d')
  if (!ctx) throw new Error('no 2D context')
  ctx.drawImage(bmp, 0, 0)
  if (bmp !== probe) bmp.close()
  probe.close()
  return { width, height, data: ctx.getImageData(0, 0, width, height).data }
}

async function run(req: Request): Promise<{ reply: Reply; transfer: Transferable[] }> {
  switch (req.op) {
    case 'decodeDepth': {
      const value = decodeDepth(new Uint8Array(req.png), req.scale)
      return { reply: { id: req.id, ok: true, op: req.op, value }, transfer: [value.data.buffer] }
    }
    case 'keepRoomMask': {
      const value = keepRoomMask(new Uint8Array(req.rgba), req.width, req.height, { bottomUp: req.bottomUp, png: req.png, level: req.level })
      return { reply: { id: req.id, ok: true, op: req.op, value }, transfer: value.png ? [value.mask.buffer, value.png.buffer] : [value.mask.buffer] }
    }
    case 'envMap': {
      const value = envMap({ width: req.width, height: req.height, data: new Uint8Array(req.photo) }, { rotation: req.rotation, fov_y_deg: req.fov }, req.opts)
      return { reply: { id: req.id, ok: true, op: 'envMap', value }, transfer: [value.data.buffer] }
    }
    case 'envMapFromImage': {
      const photo = await imagePixels(req.image, req.maxSide)
      const value = envMap(photo, { rotation: req.rotation, fov_y_deg: req.fov }, req.opts)
      return { reply: { id: req.id, ok: true, op: 'envMap', value }, transfer: [value.data.buffer] }
    }
  }
}

/** Serves the heavy kernels on a worker scope (or a MessagePort): call once in the worker's entry module. The wasm is
 * loaded on the first request (from `source`, or next to the glue). */
export function serveKernels(port: KernelPort, source?: InitInput | SyncInitInput): void {
  let ready: Promise<void> | null = null
  port.addEventListener('message', (e) => {
    const req = parseRequest(e.data)
    const id = isObj(e.data) && isNum(e.data['id']) ? e.data['id'] : -1
    if (!req) {
      port.postMessage({ id, ok: false, error: 'midstudy kernels: malformed request' }, [])
      return
    }
    ready ??= loadKernels(source)
    ready
      .then(() => run(req))
      .then(({ reply, transfer }) => { port.postMessage(reply, transfer) })
      .catch((err: unknown) => { port.postMessage({ id, ok: false, error: err instanceof Error ? err.message : String(err) }, []) })
  })
  port.start?.()
}

function parseReply(x: unknown): Reply | null {
  if (!isObj(x) || !isNum(x['id'])) return null
  const id = x['id']
  if (x['ok'] === false) return { id, ok: false, error: typeof x['error'] === 'string' ? x['error'] : 'failed' }
  const v = x['value']
  if (x['ok'] !== true || !isObj(v) || !isNum(v['width']) || !isNum(v['height'])) return null
  const [width, height] = [v['width'], v['height']]
  if (x['op'] === 'decodeDepth' && v['data'] instanceof Float32Array) return { id, ok: true, op: 'decodeDepth', value: { width, height, data: v['data'] } }
  if (x['op'] === 'keepRoomMask' && v['mask'] instanceof Uint8Array && isNum(v['coverage'])) {
    const png = v['png'] instanceof Uint8Array ? v['png'] : null
    return { id, ok: true, op: 'keepRoomMask', value: { width, height, coverage: v['coverage'], mask: v['mask'], png } }
  }
  const data = v['data']
  if (x['op'] === 'envMap' && (data instanceof Float32Array || data instanceof Uint16Array) && typeof v['half'] === 'boolean') {
    return { id, ok: true, op: 'envMap', value: { width, height, data, half: v['half'] } }
  }
  return null
}

/** The main thread's side of a kernel worker. Buffers given to it are transferred (detached in the caller). */
export class KernelWorker {
  #port: KernelPort
  #next = 1
  #pending = new Map<number, { resolve: (r: Reply) => void; reject: (e: Error) => void }>()

  constructor(port: KernelPort) {
    this.#port = port
    port.addEventListener('message', (e) => {
      const reply = parseReply(e.data)
      const id = isObj(e.data) && isNum(e.data['id']) ? e.data['id'] : -1
      const p = this.#pending.get(reply ? reply.id : id)
      if (!p) return
      this.#pending.delete(reply ? reply.id : id)
      if (!reply) p.reject(new Error('midstudy kernels: malformed reply'))
      else p.resolve(reply)
    })
    port.start?.()
  }

  #call(msg: Record<string, unknown>, transfer: Transferable[]): Promise<Reply> {
    const id = this.#next++
    return new Promise<Reply>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#port.postMessage({ ...msg, id }, transfer)
    })
  }

  static #fail(r: Reply): Error {
    return new Error(r.ok ? `midstudy kernels: unexpected ${r.op} reply` : r.error)
  }

  /** decodeDepth in the worker; `png` is transferred. */
  async decodeDepth(png: ArrayBuffer, scale = 1): Promise<DepthMap> {
    const r = await this.#call({ op: 'decodeDepth', png, scale }, [png])
    if (r.ok && r.op === 'decodeDepth') return r.value
    throw KernelWorker.#fail(r)
  }

  /** keepRoomMask in the worker; `rgba` is transferred. */
  async keepRoomMask(rgba: ArrayBuffer, width: number, height: number, opts: { bottomUp?: boolean; png?: boolean; level?: number } = {}): Promise<KeepRoomMask> {
    const r = await this.#call({ op: 'keepRoomMask', rgba, width, height, bottomUp: opts.bottomUp ?? true, png: opts.png ?? false, level: opts.level ?? 6 }, [rgba])
    if (r.ok && r.op === 'keepRoomMask') return r.value
    throw KernelWorker.#fail(r)
  }

  /** envMap in the worker from RGBA pixels; `photo` is transferred. */
  async envMap(photo: ArrayBuffer, width: number, height: number, cam: { rotation: Mat3Elements; fov_y_deg: number }, opts: EnvMapOptions = {}): Promise<EnvMap> {
    const r = await this.#call({ op: 'envMap', photo, width, height, rotation: Array.from(cam.rotation), fov: cam.fov_y_deg, opts }, [photo])
    if (r.ok && r.op === 'envMap') return r.value
    throw KernelWorker.#fail(r)
  }

  /** envMap in the worker from the photo file itself (decoded there, its long side at most `maxSide`). */
  async envMapFromImage(image: Blob, cam: { rotation: Mat3Elements; fov_y_deg: number }, opts: EnvMapOptions & { maxSide?: number } = {}): Promise<EnvMap> {
    const { maxSide = 2048, ...rest } = opts
    const r = await this.#call({ op: 'envMapFromImage', image, maxSide, rotation: Array.from(cam.rotation), fov: cam.fov_y_deg, opts: rest }, [])
    if (r.ok && r.op === 'envMap') return r.value
    throw KernelWorker.#fail(r)
  }
}
