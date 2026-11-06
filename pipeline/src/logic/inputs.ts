// What midstudy-add checks before any work, and its tables (contract §3.1–§3.3; v1's cli.py and engines.py): --dims,
// the INPUT's kind, the engines' endpoints, prices and arguments, and the sentences v1 prints for each refusal (slugs
// and the mock folder names are common/logic's). Pure (functional core).

import type { PyValue } from './pyjson.ts'
import { bool, dict, entry, int, list, str } from './pyjson.ts'
import { isPySpace } from './pyformat.ts'
import type { Engine } from './args.ts'

export type DimsResult = { readonly ok: true; readonly w: number; readonly d: number; readonly h: number } | { readonly ok: false; readonly error: string }

/** A Unicode decimal digit's value (Python's `\d` and `float()` take them all), or -1. */
function digit(ch: string): number {
  const c = ch.codePointAt(0) ?? 0
  if (c >= 48 && c <= 57) return c - 48
  if (!/^\p{Nd}$/u.test(ch)) return -1
  let start = c
  while (start > 0 && /^\p{Nd}$/u.test(String.fromCodePoint(start - 1))) start--
  return (c - start) % 10
}

/** v1's `parse_dims`: `W x D x H` in cm (`x`, `×` or `X`; spaces and decimals allowed), all above 0. */
export function parseDims(text: string | null): DimsResult {
  if (text === null) return { ok: false, error: '--dims is required: W x D x H in cm, e.g. --dims 75x80x95' }
  const chars = Array.from(text)
  let i = 0
  const ws = (): void => {
    while (i < chars.length && isPySpace((chars[i] ?? '').charCodeAt(0))) i++
  }
  // (\d+(?:\.\d+)?|\.\d+) as an ASCII number string, or null
  const numberAt = (): string | null => {
    let out = ''
    let n = 0
    while (i < chars.length && digit(chars[i] ?? '') >= 0) {
      out += String(digit(chars[i] ?? ''))
      i++
      n++
    }
    if (chars[i] === '.' && digit(chars[i + 1] ?? '') >= 0) {
      out += '.'
      i++
      while (i < chars.length && digit(chars[i] ?? '') >= 0) {
        out += String(digit(chars[i] ?? ''))
        i++
      }
      return out
    }
    return n > 0 ? out : null
  }
  const nums: number[] = []
  ws()
  for (let k = 0; k < 3; k++) {
    const v = numberAt()
    if (v === null) return { ok: false, error: `--dims must look like 75x80x95 (cm), got '${text}'` }
    nums.push(Number(v))
    ws()
    if (k < 2) {
      const sep = chars[i]
      if (sep !== 'x' && sep !== '×' && sep !== 'X') return { ok: false, error: `--dims must look like 75x80x95 (cm), got '${text}'` }
      i++
      ws()
    }
  }
  if (i !== chars.length) return { ok: false, error: `--dims must look like 75x80x95 (cm), got '${text}'` }
  const [w, d, h] = nums
  if (w === undefined || d === undefined || h === undefined) return { ok: false, error: `--dims must look like 75x80x95 (cm), got '${text}'` }
  if (Math.min(w, d, h) <= 0) return { ok: false, error: `--dims values must all be greater than 0 cm, got '${text}'` }
  return { ok: true, w, d, h }
}

export const MODEL_EXT = ['.glb', '.gltf', '.zip'] as const
export const USD_EXT = ['.usdz', '.usd', '.usda', '.usdc'] as const

/** A fal engine (a paid call). */
export type FalEngine = 'idol' | 'sam3d' | 'trellis2'

export function isFalEngine(e: Engine): e is FalEngine {
  return e === 'idol' || e === 'sam3d' || e === 'trellis2'
}

/** The fal endpoint of each engine (contract §3.2). */
export function endpoint(e: FalEngine): string {
  switch (e) {
    case 'idol': return 'speridlabs/idol'
    case 'sam3d': return 'fal-ai/sam-3/3d-objects'
    case 'trellis2': return 'fal-ai/trellis-2'
  }
}

/** Idol's Gaussians: fal's default and its measured output. */
const IDOL_GAUSSIANS = 262_144

/** v1's `cost_usd(engine, resolution)`. */
export function costUsd(e: Engine, resolution: number): number {
  switch (e) {
    case 'idol': return 0.1
    case 'sam3d': return 0.02
    case 'trellis2': return resolution === 512 ? 0.25 : resolution === 1024 ? 0.3 : resolution === 1536 ? 0.35 : 0.0
    case 'glb':
    case 'rug': return 0.0
  }
}

/** v1's `arguments(engine, image_url, prompt, resolution)`: what each endpoint is called with. */
export function engineArguments(e: FalEngine, imageUrl: string, prompt: string, resolution: number): PyValue {
  switch (e) {
    case 'idol':
      return dict([entry('image_url', str(imageUrl)), entry('image_type', str('real')), entry('num_gaussians', int(IDOL_GAUSSIANS))])
    case 'sam3d':
      return dict([entry('image_url', str(imageUrl)), entry('prompt', str(prompt)), entry('export_textured_glb', bool(true))])
    case 'trellis2':
      return dict([entry('image_url', str(imageUrl)), entry('resolution', int(resolution))])
  }
}

/** `dict(args, detection_threshold=0.2)`: SAM 3D's second try. */
export function withThreshold(args: PyValue): PyValue {
  if (args.kind !== 'dict') return args
  return dict([...args.entries.filter((e) => e.key !== 'detection_threshold'), entry('detection_threshold', { kind: 'float', value: 0.2 })])
}

/** SAM 3D's third try: the threshold dropped, `mask_urls` added. */
export function withMask(args: PyValue, maskUrl: string): PyValue {
  if (args.kind !== 'dict') return args
  return dict([...args.entries.filter((e) => e.key !== 'detection_threshold' && e.key !== 'mask_urls'), entry('mask_urls', list([str(maskUrl)]))])
}

/** Pillow's format names to the extension a URL input without one is stored with. */
export function pilExt(format: string): string {
  switch (format) {
    case 'JPEG': return '.jpg'
    case 'PNG': return '.png'
    case 'WEBP': return '.webp'
    case 'GIF': return '.gif'
    case 'BMP': return '.bmp'
    case 'TIFF': return '.tif'
    case 'HEIF': return '.heic'
    default: return '.img'
  }
}

/** `re.match(r"^https?://", s, re.I)`. */
export function isUrl(s: string): boolean {
  return /^https?:\/\//i.test(s)
}

/** `urllib.parse.urlparse(url).path` (Python 3.12's urlsplit, then `;params` cut off the last segment). */
export function urlPath(url: string): string {
  let u = url
  let start = 0
  while (start < u.length && u.charCodeAt(start) <= 32) start++
  u = u.slice(start).replace(/[\t\r\n]/g, '')
  const colon = u.indexOf(':')
  if (colon > 0 && /^[A-Za-z][A-Za-z0-9+.-]*$/.test(u.slice(0, colon))) u = u.slice(colon + 1)
  if (u.startsWith('//')) {
    let delim = u.length
    for (const c of ['/', '?', '#']) {
      const at = u.indexOf(c, 2)
      if (at >= 0 && at < delim) delim = at
    }
    u = u.slice(delim)
  }
  const hash = u.indexOf('#')
  if (hash >= 0) u = u.slice(0, hash)
  const q = u.indexOf('?')
  if (q >= 0) u = u.slice(0, q)
  if (u.includes(';')) {
    const slash = u.lastIndexOf('/')
    const semi = slash >= 0 ? u.indexOf(';', slash) : u.indexOf(';')
    if (semi >= 0) u = u.slice(0, semi)
  }
  return u
}

function utf8(ch: string): number[] {
  const c = ch.codePointAt(0) ?? 0
  if (c < 0x80) return [c]
  if (c < 0x800) return [0xc0 | (c >> 6), 0x80 | (c & 63)]
  if (c < 0x10000) return [0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)]
  return [0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63)]
}

/** `urllib.parse.quote(s)` (safe `/`, UTF-8, upper-case hex). */
export function quote(s: string): string {
  let out = ''
  for (const ch of s) {
    if (/^[A-Za-z0-9_.~/-]$/.test(ch)) out += ch
    else for (const b of utf8(ch)) out += `%${b.toString(16).toUpperCase().padStart(2, '0')}`
  }
  return out
}

/** The validation sentences of v1's `run()`, in its order. */
export const MESSAGES = {
  needInput: 'INPUT is required: an image path or URL, a .glb, or an OBJ .zip (or use --rescale ID)',
  needName: "--name is required, e.g. --name 'Reading chair'",
  emptyName: "--name can't be empty",
  badId: (id: string): string => `--id must be a slug like 'reading-chair' (a-z, 0-9, '-', max 64), got '${id}'`,
  noId: (name: string): string => `can't make an id from --name '${name}'; pass --id reading-chair or similar`,
  usd: (suffix: string): string => `${suffix} isn't supported: convert to GLB first (e.g. Reality Converter or Blender), then use --engine glb`,
  glbNeedsModel: (raw: string): string => `--engine glb needs a .glb, .gltf or OBJ .zip INPUT, got '${raw}'`,
  modelForImage: (suffix: string): string => `INPUT is a 3D model (${suffix}); use --engine glb`,
  mockNoNetwork: 'MIDSTUDY_FAL_MOCK is set, so midstudy-add makes no network requests: download INPUT to a local file and pass its path',
  notFound: (raw: string): string => `INPUT not found: ${raw}`,
  noKey: (envPath: string): string => `FAL_KEY not set: add FAL_KEY=... to ${envPath} (or set MIDSTUDY_FAL_MOCK=fixtures/fal for a free dry run)`,
  libraryNotDir: (dir: string): string => `--library ${dir} exists but isn't a directory`,
  mockNotDir: (value: string): string => `MIDSTUDY_FAL_MOCK=${value} is not a directory (expected e.g. fixtures/fal)`,
  notImage: (path: string, kind: string): string => `${path} isn't an image midstudy-add can read (${kind}); use a JPEG, PNG, HEIC or WebP`,
} as const
