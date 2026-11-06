// The media kernels for Node (docs/REFACTOR.md, track k-media): the typed face of build/wasm/node/, which
// core/crates/wasm-node builds (wasm-bindgen --target nodejs). Every fallible function returns a Result instead of
// throwing; the error carries a kebab-case code, the byte offset when there is one, and the kernel's sentence.
//
// Contract sections: sniff §4.3/§4.4; stripJpeg §2.6/§2.8; jpegFrame §2.6; jpegIsClean/jpegPassthrough §4.3;
// stripPng §2.8; pngSize §4.7; stripGlb §2.8; decodeImageDataUri §2.6/§2.8/§4.4/§4.7; decodeMeta §2.8/§4.4;
// normalizePath/staticRoute §2.1/§2.8/§2.9/§4.4; isSlug/isSceneName/isRenderName/compareNames §2.7/§4.2/§2.6;
// contentLength/hostName/checkHost/originOk §2.9; zipPlan §2.8.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

// --- loading -----------------------------------------------------------------------------------------------------

/** The raw wasm-bindgen exports (core/crates/wasm-node/src/api.rs documents each envelope). */
interface Raw {
  sniff(bytes: Uint8Array): string
  jpeg_strip(bytes: Uint8Array): Uint8Array
  jpeg_strip_plan(bytes: Uint8Array): Uint8Array
  jpeg_frame(bytes: Uint8Array): Uint8Array
  jpeg_is_clean(bytes: Uint8Array): boolean
  jpeg_passthrough(bytes: Uint8Array): Uint8Array
  png_strip(bytes: Uint8Array): Uint8Array
  png_strip_plan(bytes: Uint8Array): Uint8Array
  png_size(bytes: Uint8Array): Uint8Array
  glb_strip(bytes: Uint8Array, inPlace: boolean): Uint8Array
  data_uri_image(value: string, png: boolean): Uint8Array
  meta_decode(header: string, maxLength: number): Uint8Array
  path_normalize(target: string): string | undefined
  reduce_leading_slashes(target: string): string
  static_route(target: string): Uint8Array
  is_slug(s: string): boolean
  is_scene_name(s: string): boolean
  is_render_name(s: string): boolean
  cmp_names(a: string, b: string): number
  content_length(values: string[]): Uint8Array
  host_name(value: string): string | undefined
  check_host(values: string[], allowed: string[]): string
  origin_ok(xMidstudy?: string | null, origin?: string | null, host?: string | null): boolean
  zip_plan(packed: Uint8Array): Uint8Array
}

const RAW_FUNCTIONS = [
  'sniff', 'jpeg_strip', 'jpeg_strip_plan', 'jpeg_frame', 'jpeg_is_clean', 'jpeg_passthrough', 'png_strip', 'png_strip_plan',
  'png_size', 'glb_strip',
  'data_uri_image', 'meta_decode', 'path_normalize', 'reduce_leading_slashes', 'static_route', 'is_slug',
  'is_scene_name', 'is_render_name', 'cmp_names', 'content_length', 'host_name', 'check_host', 'origin_ok', 'zip_plan',
] as const satisfies readonly (keyof Raw)[]

function isRaw(m: unknown): m is Raw {
  if (typeof m !== 'object' || m === null) return false
  return RAW_FUNCTIONS.every((name) => {
    const value: unknown = Reflect.get(m, name)
    return typeof value === 'function'
  })
}

/** Where the build puts the module (repo root /build/wasm/node/), relative to this file (core/js/). */
export const WASM_MODULE = fileURLToPath(new URL('../../build/wasm/node/midstudy_wasm_node.js', import.meta.url))

let loaded: Raw | null = null

/** The wasm module, loaded once on first use (it reads its .wasm synchronously). */
function raw(): Raw {
  if (loaded !== null) return loaded
  const require = createRequire(import.meta.url)
  const mod: unknown = require(WASM_MODULE)
  if (!isRaw(mod)) {
    throw new Error(`core/js/node.ts: ${WASM_MODULE} doesn't export the media API: rebuild it (nix develop -c npm run build)`)
  }
  loaded = mod
  return mod
}

// --- results and envelopes ---------------------------------------------------------------------------------------

/** A kernel's answer: a value, or an error it explains. */
export type Result<T, E> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E }

/** Why a kernel refused its input. */
export interface MediaError<C extends string> {
  /** What went wrong, as a kebab-case code (each function lists its codes). */
  readonly code: C
  /** The byte offset (or entry, or image index) it concerns, when there is one. */
  readonly offset: number | null
  /** One sentence. */
  readonly message: string
}

const NO_OFFSET = 0xffff_ffff
const utf8 = new TextDecoder('utf-8', { fatal: false })

function isOneOf<C extends string>(value: string, codes: readonly C[]): value is C {
  return codes.some((c) => c === value)
}

/** Reads the little-endian u32 fields of an ok envelope's payload, then the rest. */
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

  /** A u64 written as two u32s, low first (exact below 2^53, which every length here is). */
  u64(): number {
    const low = this.u32()
    return this.u32() * 2 ** 32 + low
  }

  flag(): boolean {
    return this.u32() !== 0
  }

  /** The rest of the envelope (a view: the envelope is never reused). */
  rest(): Uint8Array {
    return this.#bytes.subarray(this.#at)
  }

  /** The next `n` bytes (a view). */
  bytes(n: number): Uint8Array {
    const v = this.#bytes.subarray(this.#at, this.#at + n)
    this.#at += n
    return v
  }

  /** A plan's pieces (api.rs `pieces`): views of `input` for its ranges, views of the envelope for its own bytes. */
  pieces(input: Uint8Array): { pieces: Uint8Array[]; length: number } {
    const count = this.u32()
    const pieces: Uint8Array[] = []
    let length = 0
    for (let k = 0; k < count; k++) {
      const a = this.u32()
      const b = this.u32()
      const piece = a === NO_OFFSET ? this.bytes(b) : input.subarray(a, b)
      pieces.push(piece)
      length += piece.length
    }
    return { pieces, length }
  }
}

/** The pieces are exactly `input`: one view of all of it. */
function isWhole(pieces: readonly Uint8Array[], input: Uint8Array): boolean {
  const [only] = pieces
  return pieces.length === 1 && only?.buffer === input.buffer && only.byteOffset === input.byteOffset && only.length === input.length
}

/** The pieces joined into one new buffer (the input is never handed back: callers may change either). */
function join(pieces: readonly Uint8Array[], length: number): Uint8Array {
  const out = new Uint8Array(length)
  let at = 0
  for (const p of pieces) {
    out.set(p, at)
    at += p.length
  }
  return out
}

function decode<T, C extends string>(env: Uint8Array, codes: readonly C[], read: (p: Payload) => T): Result<T, MediaError<C>> {
  if (env[0] === 0) return { ok: true, value: read(new Payload(env)) }
  const view = new DataView(env.buffer, env.byteOffset, env.byteLength)
  const offset = view.getUint32(1, true)
  const codeLength = env[5] ?? 0
  const code = utf8.decode(env.subarray(6, 6 + codeLength))
  if (!isOneOf(code, codes)) throw new Error(`core/js/node.ts: the media kernel answered an unknown code ${JSON.stringify(code)}`)
  return { ok: false, error: { code, offset: offset === NO_OFFSET ? null : offset, message: utf8.decode(env.subarray(6 + codeLength)) } }
}

// --- sniff -------------------------------------------------------------------------------------------------------

export const FILE_KINDS = ['jpeg', 'png', 'heic', 'heif', 'webp', 'glb', 'zip', 'unknown'] as const
/** What a file is by its magic bytes (contract §4.3, §4.4). */
export type FileKind = (typeof FILE_KINDS)[number]

/** The file type from its first 64 bytes, as v1's ingest decided it (HEIC: an HEVC major brand; HEIF: a generic one). */
export function sniff(bytes: Uint8Array): FileKind {
  const kind = raw().sniff(bytes)
  return isOneOf(kind, FILE_KINDS) ? kind : 'unknown'
}

/** The `ext` a photo upload is stored with (`source.<ext>`), or null when the kind isn't an accepted photo. */
export function photoExt(kind: FileKind): 'jpg' | 'png' | 'heic' | 'webp' | null {
  switch (kind) {
    case 'jpeg': return 'jpg'
    case 'png': return 'png'
    case 'heic':
    case 'heif': return 'heic'
    case 'webp': return 'webp'
    case 'glb':
    case 'zip':
    case 'unknown': return null
  }
}

// --- JPEG --------------------------------------------------------------------------------------------------------

export const JPEG_ERRORS = ['not-jpeg', 'expected-marker', 'bad-marker', 'bad-length', 'truncated', 'no-end-of-image'] as const
export type JpegErrorCode = (typeof JPEG_ERRORS)[number]

/** What stripJpeg removed. */
export interface JpegRemoved {
  /** APP1–APP15 segments (EXIF, GPS, XMP, ICC, MPF, …). */
  readonly appSegments: number
  /** APP0 segments dropped whole (JFXX, other APP0s, short JFIF headers). */
  readonly app0Segments: number
  /** JFIF headers cut back to a plain 16-byte header. */
  readonly jfifTrimmed: number
  /** COM segments. */
  readonly comments: number
  /** Fill bytes before markers. */
  readonly fillBytes: number
  /** Bytes after the end-of-image marker. */
  readonly trailingBytes: number
}

export interface Stripped<R> {
  readonly bytes: Uint8Array
  readonly removed: R
}

/** A stripped file as pieces, without copying it: views of the input (and the few bytes the strip writes itself, such
 *  as a rewritten JFIF header), in order. Write them in order (`fs.writev`, a stream) or join them. The views share
 *  the input's memory: they are only valid while the input isn't changed. */
export interface StrippedPieces<R> {
  readonly pieces: readonly Uint8Array[]
  /** The output's length in bytes. */
  readonly length: number
  /** The output is the input, byte for byte (one piece: all of it). */
  readonly unchanged: boolean
  readonly removed: R
}

function jpegRemoved(p: Payload): JpegRemoved {
  return { appSegments: p.u32(), app0Segments: p.u32(), jfifTrimmed: p.u32(), comments: p.u32(), fillBytes: p.u32(), trailingBytes: p.u32() }
}

/** The JPEG without its metadata, its image data untouched (contract §2.6, §2.8). */
export function stripJpeg(bytes: Uint8Array): Result<Stripped<JpegRemoved>, MediaError<JpegErrorCode>> {
  const r = stripJpegPieces(bytes)
  return r.ok ? { ok: true, value: { removed: r.value.removed, bytes: join(r.value.pieces, r.value.length) } } : r
}

/** stripJpeg's output as pieces of the input: only the plan crosses the wasm boundary, not the bytes. */
export function stripJpegPieces(bytes: Uint8Array): Result<StrippedPieces<JpegRemoved>, MediaError<JpegErrorCode>> {
  return decode(raw().jpeg_strip_plan(bytes), JPEG_ERRORS, (p) => {
    const removed = jpegRemoved(p)
    const { pieces, length } = p.pieces(bytes)
    return { removed, pieces, length, unchanged: isWhole(pieces, bytes) }
  })
}

export const FRAME_ERRORS = [
  'not-jpeg', 'expected-marker', 'scan-before-frame', 'end-before-frame', 'truncated', 'bad-length', 'zero-size', 'no-frame',
] as const
export type FrameErrorCode = (typeof FRAME_ERRORS)[number]

/** A JPEG's frame header. */
export interface JpegFrame {
  readonly width: number
  readonly height: number
  /** 1 grey, 3 colour, 4 CMYK. */
  readonly components: number
  /** Bits per sample. */
  readonly precision: number
  /** The SOF marker (0xC0 baseline, 0xC2 progressive, …). */
  readonly marker: number
}

function frame(p: Payload): JpegFrame {
  return { width: p.u32(), height: p.u32(), components: p.u32(), precision: p.u32(), marker: p.u32() }
}

/** The JPEG's size from its frame header, never guessed (contract §2.6: qwen is priced by it). */
export function jpegFrame(bytes: Uint8Array): Result<JpegFrame, MediaError<FrameErrorCode>> {
  return decode(raw().jpeg_frame(bytes), FRAME_ERRORS, frame)
}

/** No metadata anywhere and well formed (contract §4.3 Pass-through, the structural part). */
export function jpegIsClean(bytes: Uint8Array): boolean {
  return raw().jpeg_is_clean(bytes)
}

export const PASSTHROUGH_ERRORS = ['not-clean', 'frame', 'precision', 'components', 'too-large'] as const
export type PassthroughCode = (typeof PASSTHROUGH_ERRORS)[number]

/** Whether ingest may copy the JPEG byte for byte (§4.3): clean, 8-bit, 3 components, long side ≤ 2048. The caller
 *  still has to decode it once (v1 refused uploads that didn't decode). */
export function jpegPassthrough(bytes: Uint8Array): Result<JpegFrame, MediaError<PassthroughCode>> {
  return decode(raw().jpeg_passthrough(bytes), PASSTHROUGH_ERRORS, frame)
}

// --- PNG ---------------------------------------------------------------------------------------------------------

export const PNG_ERRORS = ['not-png', 'truncated', 'no-end'] as const
export type PngErrorCode = (typeof PNG_ERRORS)[number]

/** What stripPng removed. */
export interface PngRemoved {
  readonly exif: number
  /** tEXt, iTXt and zTXt chunks. */
  readonly text: number
  readonly time: number
  readonly trailingBytes: number
}

/** The PNG without eXIf, tEXt, iTXt, zTXt and tIME, and nothing after IEND (contract §2.8). */
export function stripPng(bytes: Uint8Array): Result<Stripped<PngRemoved>, MediaError<PngErrorCode>> {
  const r = stripPngPieces(bytes)
  return r.ok ? { ok: true, value: { removed: r.value.removed, bytes: join(r.value.pieces, r.value.length) } } : r
}

/** stripPng's output as pieces of the input (every kept chunk is a range of it): only the plan crosses the boundary. */
export function stripPngPieces(bytes: Uint8Array): Result<StrippedPieces<PngRemoved>, MediaError<PngErrorCode>> {
  return decode(raw().png_strip_plan(bytes), PNG_ERRORS, (p) => {
    const removed: PngRemoved = { exif: p.u32(), text: p.u32(), time: p.u32(), trailingBytes: p.u32() }
    const { pieces, length } = p.pieces(bytes)
    return { removed, pieces, length, unchanged: isWhole(pieces, bytes) }
  })
}

/** Width and height from IHDR, or null (contract §4.7: the keep-room mask is checked against the photo). */
export function pngSize(bytes: Uint8Array): { readonly width: number; readonly height: number } | null {
  const r = decode(raw().png_size(bytes), ['no-ihdr'] as const, (p) => ({ width: p.u32(), height: p.u32() }))
  return r.ok ? r.value : null
}

// --- GLB ---------------------------------------------------------------------------------------------------------

export const GLB_ERRORS = [
  'not-glb', 'version', 'length', 'chunk-truncated', 'first-chunk-not-json', 'duplicate-chunk', 'json', 'not-object',
  'not-gltf2', 'field', 'bin-missing', 'bin-short', 'image-outside-bin', 'image-source', 'bad-image', 'overlap', 'too-large',
] as const
export type GlbErrorCode = (typeof GLB_ERRORS)[number]

/** Compact removes the bytes a cleaned texture frees (later bufferViews move down by multiples of 16); in place
 *  zeroes them (v1). Compact falls back to in place when a bufferView has extensions (meshopt). */
export type GlbLayout = 'compact' | 'in-place'

export interface GlbImage {
  /** Its index in `images`. */
  readonly image: number
  readonly source: 'buffer-view' | 'data-uri' | 'uri'
  /** Its bufferView, for a buffer-view image. */
  readonly view: number | null
  readonly kind: 'jpeg' | 'png' | 'other' | 'external'
  readonly bytesBefore: number
  readonly bytesAfter: number
  /** Metadata was removed. */
  readonly changed: boolean
}

export interface GlbReport {
  readonly layout: GlbLayout
  /** Unknown chunks, and a binary chunk no buffer refers to. */
  readonly droppedChunks: number
  readonly trailingBytes: number
  readonly slackBytes: number
  /** The output differs from the input. */
  readonly changed: boolean
  readonly images: readonly GlbImage[]
}

const IMAGE_SOURCES = ['buffer-view', 'data-uri', 'uri'] as const
const IMAGE_KINDS = ['jpeg', 'png', 'other', 'external'] as const

/** The GLB with every embedded JPEG and PNG texture stripped of its metadata (contract §2.8 Privacy). */
export function stripGlb(bytes: Uint8Array, options: { readonly layout?: GlbLayout } = {}): Result<{ readonly bytes: Uint8Array; readonly report: GlbReport }, MediaError<GlbErrorCode>> {
  return decode(raw().glb_strip(bytes, options.layout === 'in-place'), GLB_ERRORS, (p) => {
    const layout: GlbLayout = p.u32() === 1 ? 'in-place' : 'compact'
    const droppedChunks = p.u32()
    const trailingBytes = p.u32()
    const slackBytes = p.u32()
    const changed = p.flag()
    const count = p.u32()
    const images: GlbImage[] = []
    for (let k = 0; k < count; k++) {
      const image = p.u32()
      const source = IMAGE_SOURCES[p.u32()] ?? 'uri'
      const view = p.u32()
      const kind = IMAGE_KINDS[p.u32()] ?? 'other'
      images.push({ image, source, view: view === NO_OFFSET ? null : view, kind, bytesBefore: p.u32(), bytesAfter: p.u32(), changed: p.flag() })
    }
    return { bytes: p.rest(), report: { layout, droppedChunks, trailingBytes, slackBytes, changed, images } }
  })
}

// --- data URIs and X-Midstudy-Meta -------------------------------------------------------------------------------

export const DATA_URI_ERRORS = ['not-data-uri', 'base64'] as const
export type DataUriCode = (typeof DATA_URI_ERRORS)[number]

/** The bytes of `data:image/jpeg;base64,…` (or `jpg`; `png` for a mask), whitespace allowed in the base64, decoded
 *  strictly (contract §2.6, §2.8, §4.4, §4.7; v1's decode_data_uri). */
export function decodeImageDataUri(value: string, type: 'jpeg' | 'png'): Result<Uint8Array, MediaError<DataUriCode>> {
  return decode(raw().data_uri_image(value, type === 'png'), DATA_URI_ERRORS, (p) => p.rest())
}

export const META_ERRORS = ['too-long', 'not-ascii', 'base64', 'not-utf8'] as const
export type MetaCode = (typeof META_ERRORS)[number]
/** The default cap on X-Midstudy-Meta, in bytes of base64. */
export const MAX_META_HEADER = 16 * 1024

/** The JSON text inside an X-Midstudy-Meta header (strict base64 of UTF-8); the caller parses the JSON. */
export function decodeMeta(header: string, maxLength: number = MAX_META_HEADER): Result<string, MediaError<MetaCode>> {
  return decode(raw().meta_decode(header, Math.max(1, Math.min(maxLength, 0xffff_ffff))), META_ERRORS, (p) => utf8.decode(p.rest()))
}

// --- paths -------------------------------------------------------------------------------------------------------

/** A request target's path, percent-decoded once and resolved, or null for a NUL or backslash (contract §2.9 Paths).
 *  Never decode the result again. */
export function normalizePath(target: string): string | null {
  return raw().path_normalize(target) ?? null
}

/** `//x` → `/x`, as Python's http.server did before routing anything (API routes included). */
export function reduceLeadingSlashes(target: string): string {
  return raw().reduce_leading_slashes(target)
}

/** What a static GET serves (contract §2.1, §2.8, §4.4): everything not listed is not found, in any spelling or case. */
export type StaticRoute =
  | { readonly kind: 'redirect-to-planner' }
  | { readonly kind: 'planner'; readonly path: string; readonly trailingSlash: boolean }
  | { readonly kind: 'library-json' }
  | { readonly kind: 'library'; readonly id: string; readonly file: 'model.glb' | 'splat.ply' | 'splat.spz' | 'thumb.jpg' }
  | { readonly kind: 'scene'; readonly name: string; readonly file: 'photo.jpg' | 'depth.png' | 'thumb.jpg' }
  | { readonly kind: 'render'; readonly file: string }
  | { readonly kind: 'not-found' }

const LIBRARY_FILES = ['model.glb', 'splat.ply', 'splat.spz', 'thumb.jpg'] as const
const SCENE_FILES = ['photo.jpg', 'depth.png', 'thumb.jpg'] as const

/** The static route for a request target as it arrived (API paths are routed by the server before this). */
export function staticRoute(target: string): StaticRoute {
  const r = decode(raw().static_route(target), [] as const, (p) => {
    const kind = p.u32()
    const sub = p.u32()
    const text = utf8.decode(p.rest())
    return { kind, sub, text }
  })
  if (!r.ok) return { kind: 'not-found' }
  const { kind, sub, text } = r.value
  switch (kind) {
    case 0: return { kind: 'redirect-to-planner' }
    case 1: return { kind: 'planner', path: text, trailingSlash: sub === 1 }
    case 2: return { kind: 'library-json' }
    case 3: {
      const file = LIBRARY_FILES[sub]
      return file === undefined ? { kind: 'not-found' } : { kind: 'library', id: text, file }
    }
    case 4: {
      const file = SCENE_FILES[sub]
      return file === undefined ? { kind: 'not-found' } : { kind: 'scene', name: text, file }
    }
    case 5: return { kind: 'render', file: text }
    default: return { kind: 'not-found' }
  }
}

// --- names -------------------------------------------------------------------------------------------------------

/** `^[a-z0-9][a-z0-9-]{0,63}$` over the whole string (no trailing newline). */
export function isSlug(s: string): boolean {
  return raw().is_slug(s)
}

/** `scene-YYYYMMDD-HHMMSS` or `…-N`, and a slug (contract §4.2). */
export function isSceneName(s: string): boolean {
  return raw().is_scene_name(s)
}

/** `render-YYYYMMDD-HHMMSS` or `…-N` (contract §2.6). */
export function isRenderName(s: string): boolean {
  return raw().is_render_name(s)
}

/** Orders names as v1 sorted scenes after `created`: collision suffixes as numbers (`-10` after `-9`). */
export function compareNames(a: string, b: string): -1 | 0 | 1 {
  const c = raw().cmp_names(a, b)
  return c < 0 ? -1 : c > 0 ? 1 : 0
}

// --- HTTP framing ------------------------------------------------------------------------------------------------

export const CONTENT_LENGTH_ERRORS = ['multiple', 'not-digits'] as const
export type ContentLengthCode = (typeof CONTENT_LENGTH_ERRORS)[number]

/** The body length from every Content-Length value the request carried (null without one); more than one, or one
 *  that isn't 1–15 ASCII digits, is an error (a 400, contract §2.9 Framing). */
export function contentLength(values: readonly string[]): Result<number | null, MediaError<ContentLengthCode>> {
  return decode(raw().content_length([...values]), CONTENT_LENGTH_ERRORS, (p) => {
    const present = p.flag()
    const n = p.u64()
    return present ? n : null
  })
}

/** A Host value's name without its port, lowercased, or null when it isn't exactly `name[:port]` (§2.9). */
export function hostName(value: string): string | null {
  return raw().host_name(value) ?? null
}

export const HOST_DECISIONS = ['allowed', 'missing', 'multiple', 'malformed', 'unknown'] as const
/** Only `allowed` may be served (v1 answered 403 to the rest). */
export type HostDecision = (typeof HOST_DECISIONS)[number]

/** Whether every Host header value names this server: loopback, or a name in `allowed` (hostName of each
 *  --allowed-host, checked at startup). */
export function checkHost(values: readonly string[], allowed: readonly string[]): HostDecision {
  const d = raw().check_host([...values], [...allowed])
  return isOneOf(d, HOST_DECISIONS) ? d : 'malformed'
}

/** §2.9 Forged requests: `X-Midstudy: 1`, and an Origin absent or `http(s)://<Host>`. */
export function originOk(headers: { readonly xMidstudy?: string | undefined; readonly origin?: string | undefined; readonly host?: string | undefined }): boolean {
  return raw().origin_ok(headers.xMidstudy, headers.origin, headers.host)
}

// --- zips --------------------------------------------------------------------------------------------------------

/** One central-directory entry, as the zip reader that will extract it lists it. */
export interface ZipEntry {
  /** The raw name bytes (the Info-ZIP Unicode Path field's, with flag 0x800, if the reader honours it as Python did). */
  readonly name: Uint8Array
  /** General-purpose flags (bit 11, 0x800: the name is UTF-8; else code page 437). */
  readonly flags: number
  /** The uncompressed size (zip64's when the 32-bit field is 0xFFFFFFFF). */
  readonly uncompressedSize: number | bigint
  /** External attributes (Unix mode in the upper 16 bits). */
  readonly externalAttributes: number
}

/** The entries to extract (positions in the list given). Extract exactly these, each stopped at its declared size. */
export interface ZipPlan {
  /** The one .obj. */
  readonly obj: number
  readonly totalBytes: number
  readonly extract: readonly number[]
  /** Directories, __MACOSX/ and .DS_Store. */
  readonly skip: readonly number[]
}

export const ZIP_ERRORS = ['too-many-entries', 'bad-name', 'absolute', 'climbs', 'link', 'not-allowed', 'too-big', 'obj-count', 'bad-input'] as const
export type ZipCode = (typeof ZIP_ERRORS)[number]

function u32le(n: number): Uint8Array {
  const b = new Uint8Array(4)
  new DataView(b.buffer).setUint32(0, n, true)
  return b
}

function sizeWords(size: number | bigint): [number, number] | null {
  if (typeof size === 'bigint') {
    if (size < 0n || size > 0xffff_ffff_ffff_ffffn) return null
    return [Number(size & 0xffff_ffffn), Number(size >> 32n)]
  }
  if (!Number.isSafeInteger(size) || size < 0) return null
  return [size % 2 ** 32, Math.floor(size / 2 ** 32)]
}

/** Which entries of an OBJ zip to extract, or the first rule it breaks (contract §2.8; v1's sentences). */
export function zipPlan(entries: readonly ZipEntry[]): Result<ZipPlan, MediaError<ZipCode>> {
  const parts: Uint8Array[] = []
  for (const e of entries) {
    const words = sizeWords(e.uncompressedSize)
    const valid = words !== null && Number.isInteger(e.flags) && e.flags >= 0 && e.flags <= 0xffff_ffff
      && Number.isInteger(e.externalAttributes) && e.externalAttributes >= 0 && e.externalAttributes <= 0xffff_ffff
    if (!valid) return { ok: false, error: { code: 'bad-input', offset: parts.length, message: 'a zip entry has a size, flags or attributes out of range' } }
    parts.push(u32le(e.name.length), e.name, u32le(e.flags), u32le(words[0]), u32le(words[1]), u32le(e.externalAttributes))
  }
  const packed = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    packed.set(p, at)
    at += p.length
  }
  return decode(raw().zip_plan(packed), ZIP_ERRORS, (p) => {
    const obj = p.u32()
    const totalBytes = p.u64()
    const extract = Array.from({ length: p.u32() }, () => p.u32())
    const skip = Array.from({ length: p.u32() }, () => p.u32())
    return { obj, totalBytes, extract, skip }
  })
}
