// Pictures (contract §2.8 Privacy, §3.1; v1's cli.py `check_image`, `engine_input`, `make_thumb` and rug.py
// `foreground_mask`), through the imaging kernels (core/js/pipeline.ts), which make them exactly as v1's Pillow did.
// HEIC/HEIF is decoded by libheif-js (as pillow-heif decodes it with libheif) and handed over as pixels.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

import { sniff } from '../../core/js/node.ts'
import { imageEngineInput, imageMask, imageProbe, imageThumb, pixelsEngineInput } from '../../core/js/pipeline.ts'
import type { EngineInput, KernelError } from '../../core/js/pipeline.ts'
import { MidstudyError, UnexpectedError } from './errors.ts'
import { MESSAGES } from './logic/inputs.ts'
import { percent } from './logic/pyformat.ts'
import { osErrorType } from './pytext.ts'

// --- HEIC through libheif-js --------------------------------------------------------------------------------------

interface HeifImage {
  get_width(): number
  get_height(): number
  is_primary(): boolean
  has_alpha_channel(): boolean
  display(target: { data: Uint8ClampedArray; width: number; height: number }, done: (out: { data: Uint8ClampedArray } | null) => void): void
}

interface HeifDecoder {
  decode(bytes: Uint8Array): unknown
}

function isObject(v: unknown): v is object {
  return typeof v === 'object' && v !== null
}

function isHeifImage(v: unknown): v is HeifImage {
  return isObject(v) && ['get_width', 'get_height', 'is_primary', 'has_alpha_channel', 'display'].every((k) => typeof Reflect.get(v, k) === 'function')
}

let heifDecoder: (() => HeifDecoder) | null = null

function newHeifDecoder(): HeifDecoder {
  if (heifDecoder === null) {
    const mod: unknown = createRequire(import.meta.url)('libheif-js/wasm-bundle.js')
    const ctor: unknown = isObject(mod) ? Reflect.get(mod, 'HeifDecoder') : undefined
    if (typeof ctor !== 'function') throw new UnexpectedError('ImportError', 'libheif-js has no HeifDecoder')
    heifDecoder = () => {
      const d: unknown = Reflect.construct(ctor, [])
      const decode: unknown = isObject(d) ? Reflect.get(d, 'decode') : undefined
      if (typeof decode !== 'function') throw new UnexpectedError('ImportError', 'libheif-js HeifDecoder has no decode')
      return {
        decode: (b: Uint8Array): unknown => {
          const images: unknown = Reflect.apply(decode, d, [b])
          return images
        },
      }
    }
  }
  return heifDecoder()
}

/** The primary image of a HEIC/HEIF, or null when libheif finds none. */
function heifPrimary(bytes: Uint8Array): HeifImage | null {
  const images: unknown = newHeifDecoder().decode(bytes)
  if (!Array.isArray(images)) return null
  const all = images.filter(isHeifImage)
  return all.find((im) => im.is_primary()) ?? all[0] ?? null
}

async function heifPixels(im: HeifImage): Promise<Uint8Array> {
  const width = im.get_width()
  const height = im.get_height()
  const target = { data: new Uint8ClampedArray(width * height * 4), width, height }
  return new Promise((resolve, reject) => {
    im.display(target, (out) => {
      if (out === null) reject(new UnexpectedError('ValueError', 'Decoder plugin generated an error: HEIF decoding failed'))
      else resolve(new Uint8Array(out.data.buffer, out.data.byteOffset, out.data.byteLength))
    })
  })
}

function isHeif(bytes: Uint8Array): boolean {
  const k = sniff(bytes)
  return k === 'heic' || k === 'heif'
}

// --- v1's functions ------------------------------------------------------------------------------------------------

/** Pillow's exception type for a picture the kernels refuse. */
function pilErrorType(e: KernelError): string {
  if (e.code === 'unidentified') return 'UnidentifiedImageError'
  if (e.code === 'too-large') return 'DecompressionBombError'
  return e.offset === 1 ? 'SyntaxError' : 'OSError'
}

/** v1's `check_image`: Pillow's format name for a readable picture, so a bad file fails before any paid call. */
export function checkImage(file: string): string {
  let bytes: Uint8Array
  try {
    bytes = new Uint8Array(fs.readFileSync(file))
  } catch (e) {
    throw new MidstudyError(MESSAGES.notImage(file, osErrorType(e)))
  }
  if (isHeif(bytes)) {
    try {
      if (heifPrimary(bytes) !== null) return 'HEIF'
    } catch {
      // below
    }
    throw new MidstudyError(MESSAGES.notImage(file, 'UnidentifiedImageError'))
  }
  const r = imageProbe(bytes)
  if (!r.ok) throw new MidstudyError(MESSAGES.notImage(file, pilErrorType(r.error)))
  return r.value.format
}

function picture(r: { readonly ok: true; readonly value: EngineInput } | { readonly ok: false; readonly error: KernelError }): EngineInput {
  if (r.ok) return r.value
  throw new UnexpectedError(pilErrorType(r.error), r.error.detail === '' ? r.error.code : r.error.detail)
}

/** v1's `engine_input`: the picture the engines get (and so what is uploaded to fal), upright, at most 4,096 px, a
 *  JPEG (a PNG with transparency), no EXIF, GPS, XMP, IPTC or comments, the ICC profile kept; written to `destDir`
 *  (the item's raw/, never served) as engine-input.<ext>. */
export async function engineInput(src: string, destDir: string): Promise<string> {
  fs.mkdirSync(destDir, { recursive: true })
  const bytes = new Uint8Array(fs.readFileSync(src))
  let out: EngineInput
  if (isHeif(bytes)) {
    const im = heifPrimary(bytes)
    if (im === null) throw new UnexpectedError('UnidentifiedImageError', `cannot identify image file ${src}`)
    const rgba = await heifPixels(im)
    out = picture(pixelsEngineInput(rgba, im.get_width(), im.get_height(), im.has_alpha_channel(), new Uint8Array(0)))
  } else {
    out = picture(imageEngineInput(bytes))
  }
  const file = path.join(destDir, out.png ? 'engine-input.png' : 'engine-input.jpg')
  fs.writeFileSync(file, out.bytes)
  return file
}

/** v1's `make_thumb`: 256 × 256, center-cropped, JPEG q88. */
export function makeThumb(image: string, out: string): void {
  const r = imageThumb(new Uint8Array(fs.readFileSync(image)))
  if (!r.ok) throw new UnexpectedError(pilErrorType(r.error), r.error.detail === '' ? r.error.code : r.error.detail)
  fs.writeFileSync(out, r.value)
}

/** v1's `foreground_mask`: SAM 3D's mask of the piece, written to `out`; returns what it covers, for the log. */
export function foregroundMask(image: string, out: string): string {
  const r = imageMask(new Uint8Array(fs.readFileSync(image)))
  if (!r.ok) throw new UnexpectedError(pilErrorType(r.error), r.error.detail === '' ? r.error.code : r.error.detail)
  fs.writeFileSync(out, r.value.png)
  switch (r.value.kind) {
    case 'no-margin': return 'the whole picture (it has no plain margin)'
    case 'no-piece': return 'the whole picture (no piece stood out from the margin)'
    case 'piece': return `the piece (${percent(r.value.share, 0)} of the picture, the plain margin left out)`
  }
}
