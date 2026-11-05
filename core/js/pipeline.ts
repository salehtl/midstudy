// The pipeline kernels for Node (docs/REFACTOR.md, track pipeline): the typed face of build/wasm/pipeline/, which
// core/crates/wasm-pipeline builds (scripts/build.mjs). Every function returns a Result instead of throwing; an error
// carries the kernel's kebab-case code, an offset when there is one, and a detail.
//
// Contract sections: splatNormalize §1 (splat.ply, the per-axis fit); spzEncode/spzCheck §1 (splat.spz);
// imageProbe/imageEngineInput/pixelsEngineInput §2.8 Privacy (the engine input); imageThumb §2.3 (thumb.jpg);
// imageRug §3.2 rug; imageMask §3.2 sam3d.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** The raw wasm-bindgen exports (core/crates/wasm-pipeline/src/api.rs documents each envelope). */
interface Raw {
  splat_normalize(ply: Uint8Array, params: Float64Array): Uint8Array
  spz_encode(ply: Uint8Array): Uint8Array
  spz_check(payload: Uint8Array, ply: Uint8Array): Uint8Array
  image_probe(bytes: Uint8Array): Uint8Array
  image_engine_input(bytes: Uint8Array): Uint8Array
  pixels_engine_input(rgba: Uint8Array, width: number, height: number, alpha: boolean, icc: Uint8Array): Uint8Array
  image_thumb(bytes: Uint8Array): Uint8Array
  image_rug(bytes: Uint8Array, wCm: number, dCm: number): Uint8Array
  image_mask(bytes: Uint8Array): Uint8Array
}

const RAW_FUNCTIONS = [
  'splat_normalize', 'spz_encode', 'spz_check', 'image_probe', 'image_engine_input', 'pixels_engine_input', 'image_thumb',
  'image_rug', 'image_mask',
] as const satisfies readonly (keyof Raw)[]

function isRaw(m: unknown): m is Raw {
  if (typeof m !== 'object' || m === null) return false
  return RAW_FUNCTIONS.every((name) => typeof Reflect.get(m, name) === 'function')
}

/** Where the build puts the module (repo root /build/wasm/pipeline/), relative to this file (core/js/). */
export const WASM_MODULE = fileURLToPath(new URL('../../build/wasm/pipeline/midstudy_wasm_pipeline.js', import.meta.url))

let loaded: Raw | null = null

/** The wasm module, loaded once on first use (it reads its .wasm synchronously). */
function raw(): Raw {
  if (loaded !== null) return loaded
  const require = createRequire(import.meta.url)
  const mod: unknown = require(WASM_MODULE)
  if (!isRaw(mod)) throw new Error(`core/js/pipeline.ts: ${WASM_MODULE} doesn't export the pipeline API: run \`npm run build\``)
  loaded = mod
  return mod
}

// --- results and envelopes ---------------------------------------------------------------------------------------

/** A kernel's answer: a value, or why not. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }

/** Why a kernel refused its input. */
export interface KernelError {
  /** A kebab-case code (core/crates/wasm-pipeline/src/api.rs lists them). */
  readonly code: string
  readonly offset: number | null
  readonly detail: string
}

const NO_OFFSET = 0xffff_ffff
const utf8 = new TextDecoder('utf-8', { fatal: false })

class Payload {
  readonly #bytes: Uint8Array
  readonly #view: DataView
  #at = 1

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  u32(): number {
    const v = this.#view.getUint32(this.#at, true)
    this.#at += 4
    return v
  }

  flag(): boolean {
    return this.u32() !== 0
  }

  f64(): number {
    const v = this.#view.getFloat64(this.#at, true)
    this.#at += 8
    return v
  }

  rest(): Uint8Array {
    return this.#bytes.subarray(this.#at)
  }
}

function decode<T>(env: Uint8Array, read: (p: Payload) => T): Result<T, KernelError> {
  if (env[0] === 0) return { ok: true, value: read(new Payload(env)) }
  const view = new DataView(env.buffer, env.byteOffset, env.byteLength)
  const offset = view.getUint32(1, true)
  const codeLength = env[5] ?? 0
  return {
    ok: false,
    error: { code: utf8.decode(env.subarray(6, 6 + codeLength)), offset: offset === NO_OFFSET ? null : offset, detail: utf8.decode(env.subarray(6 + codeLength)) },
  }
}

// --- splats ------------------------------------------------------------------------------------------------------

/** The fitted splat. */
export interface SplatFit {
  /** splat.ply. */
  readonly ply: Uint8Array
  /** How many f_rest_* properties were dropped. */
  readonly droppedRest: number
  readonly rotated: boolean
  readonly stretched: boolean
  /** Whether every written center is finite, and their percentile extent. */
  readonly finite: boolean
  readonly lo: readonly [number, number, number]
  readonly hi: readonly [number, number, number]
}

/** Fits a 3DGS PLY to the dims (contract §1): `rotation` row major (9), `dims` in metres (x = w, y = h, z = d), the
 *  engine's percentiles. Errors: the PLY codes, `non-finite`, `flat` (offset: the axis). */
export function splatNormalize(ply: Uint8Array, rotation: readonly number[], dims: readonly [number, number, number], pct: readonly [number, number]): Result<SplatFit, KernelError> {
  const params = Float64Array.from([...rotation, ...dims, ...pct])
  return decode(raw().splat_normalize(ply, params), (p) => {
    const droppedRest = p.u32()
    const rotated = p.flag()
    const stretched = p.flag()
    const finite = p.flag()
    const lo: [number, number, number] = [p.f64(), p.f64(), p.f64()]
    const hi: [number, number, number] = [p.f64(), p.f64(), p.f64()]
    return { droppedRest, rotated, stretched, finite, lo, hi, ply: p.rest() }
  })
}

/** splat.spz before gzip, from the written splat.ply. Errors: the PLY codes, `too-large`. */
export function spzEncode(ply: Uint8Array): Result<{ readonly payload: Uint8Array; readonly count: number; readonly dropped: number }, KernelError> {
  return decode(raw().spz_encode(ply), (p) => {
    const count = p.u32()
    const dropped = p.u32()
    return { count, dropped, payload: p.rest() }
  })
}

/** What reading splat.spz (gunzipped) back finds, against its splat.ply. */
export interface SpzCheck {
  readonly magic: number
  readonly version: number
  readonly count: number
  readonly shDegree: number
  readonly fractionalBits: number
  readonly flags: number
  readonly length: number
  readonly valid: boolean
  readonly expected: number
  readonly maxOffset: number
}

/** Decodes splat.spz's positions and compares them with splat.ply's. Errors: `short`, the PLY codes. */
export function spzCheck(payload: Uint8Array, ply: Uint8Array): Result<SpzCheck, KernelError> {
  return decode(raw().spz_check(payload, ply), (p) => ({
    magic: p.u32(), version: p.u32(), count: p.u32(), shDegree: p.u32(), fractionalBits: p.u32(), flags: p.u32(),
    length: p.u32(), valid: p.flag(), expected: p.u32(), maxOffset: p.f64(),
  }))
}

// --- pictures ----------------------------------------------------------------------------------------------------

export const IMAGE_FORMATS = ['JPEG', 'PNG', 'WEBP'] as const
export type ImageFormat = (typeof IMAGE_FORMATS)[number]

/** What Pillow's `Image.open` learns. Errors: `unidentified`, `broken` (offset: the format), `too-large`. */
export function imageProbe(bytes: Uint8Array): Result<{ readonly format: ImageFormat; readonly width: number; readonly height: number }, KernelError> {
  return decode(raw().image_probe(bytes), (p) => {
    const format = IMAGE_FORMATS[p.u32()] ?? 'JPEG'
    return { format, width: p.u32(), height: p.u32() }
  })
}

/** The picture an engine gets (contract §2.8): upright, at most 4,096 px, no metadata but its ICC profile. */
export interface EngineInput {
  /** A PNG (it has transparency), else a JPEG. */
  readonly png: boolean
  readonly width: number
  readonly height: number
  readonly bytes: Uint8Array
}

function engineInput(p: Payload): EngineInput {
  const png = p.flag()
  const width = p.u32()
  const height = p.u32()
  return { png, width, height, bytes: p.rest() }
}

/** The engine input of a JPEG, PNG or WebP. */
export function imageEngineInput(bytes: Uint8Array): Result<EngineInput, KernelError> {
  return decode(raw().image_engine_input(bytes), engineInput)
}

/** The engine input of decoded RGBA pixels already upright (a HEIC decoded by libheif). */
export function pixelsEngineInput(rgba: Uint8Array, width: number, height: number, alpha: boolean, icc: Uint8Array): Result<EngineInput, KernelError> {
  return decode(raw().pixels_engine_input(rgba, width, height, alpha, icc), engineInput)
}

/** The 256 px thumbnail (JPEG q88) of an engine input. */
export function imageThumb(bytes: Uint8Array): Result<Uint8Array, KernelError> {
  return decode(raw().image_thumb(bytes), (p) => p.rest())
}

/** The rug's texture and what its notes say. Errors: the picture codes, `plain-colour`. */
export interface RugTexture {
  readonly crop: readonly [number, number, number, number] | null
  readonly turned: boolean
  readonly have: number
  readonly want: number
  /** The rim's mean colour, linear, unrounded. */
  readonly edge: readonly [number, number, number]
  readonly width: number
  readonly height: number
  /** JPEG q90. */
  readonly jpeg: Uint8Array
}

export function imageRug(bytes: Uint8Array, wCm: number, dCm: number): Result<RugTexture, KernelError> {
  return decode(raw().image_rug(bytes, wCm, dCm), (p) => {
    const cropped = p.flag()
    const box: [number, number, number, number] = [p.u32(), p.u32(), p.u32(), p.u32()]
    const turned = p.flag()
    const have = p.f64()
    const want = p.f64()
    const edge: [number, number, number] = [p.f64(), p.f64(), p.f64()]
    const width = p.u32()
    const height = p.u32()
    return { crop: cropped ? box : null, turned, have, want, edge, width, height, jpeg: p.rest() }
  })
}

export const MASK_KINDS = ['no-margin', 'no-piece', 'piece'] as const
export type MaskKind = (typeof MASK_KINDS)[number]

/** SAM 3D's foreground mask (PNG) and what it covers. */
export function imageMask(bytes: Uint8Array): Result<{ readonly kind: MaskKind; readonly share: number; readonly png: Uint8Array }, KernelError> {
  return decode(raw().image_mask(bytes), (p) => {
    const kind = MASK_KINDS[p.u32()] ?? 'piece'
    const share = p.f64()
    return { kind, share, png: p.rest() }
  })
}
