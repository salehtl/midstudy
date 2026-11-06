// The product's pictures (contract §2.11 images): v1's `_Images`, `_private_host`, `_copy_size`, `_px` and
// `_jsonld_images`. Links only (the server never downloads a picture): absolute http(s), no data:, never a private,
// loopback or .local host, one per picture (the same host and path with other size parameters is one; its largest
// copy, https over http, is kept), at most 12.
import { pyStrip } from '../../../common/logic/pyfmt.ts'
import { addressBlocked, fetchAllowed, parseIpv4, parseIpv6 } from '../logic/address.ts'
import { urljoin, urlHostname, urlPort, urlsplit, type SplitUrl } from '../logic/url.ts'
import { unescape } from './doc.ts'
import { asList, has, isDict, isList, isNumber, or, toFloat, type PyDict } from './logic/py.ts'
import type { PyValue } from './logic/pyjson.ts'
import { cpLength, digitsValue } from './logic/text.ts'

const MAX_IMAGES = 12

/** One picture of the answer. */
export interface ImageOut {
  url: string
  w: number | null
  h: number | null
  readonly kind: 'product' | 'variant' | 'og' | 'page'
}

/** A width or height as v1's `_px` read it: an attribute, a JSON number. */
export type PxValue = PyValue | undefined

const PX = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*(\p{Nd}{1,6})(?:\.\p{Nd}+)?[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*(?:px)?[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*$/u

/** v1's `_px`: a positive whole number of pixels, or null. */
export function px(v: PxValue): number | null {
  if (typeof v === 'boolean') return null
  if (isNumber(v)) {
    const f = toFloat(v)
    return f > 0 && Number.isFinite(f) ? Math.trunc(f) : null
  }
  if (typeof v === 'string') {
    const m = PX.exec(v)
    const n = m?.[1] === undefined ? 0 : digitsValue(m[1])
    return n > 0 ? n : null
  }
  return null
}

const SIZE_QUERY = /(?:^|&)(?:width|w|size|imwidth)=(\p{Nd}{2,5})(?:&|$)/u
const SIZE_SUFFIX = /_(\p{Nd}{2,5})x\p{Nd}{0,5}(?:@\p{Nd}x)?\.[A-Za-z0-9]+$/u

/** v1's `_copy_size`: how big this copy of a picture is (a width or size parameter, a Shopify-style `_600x600`
 *  suffix, or its width). */
function copySize(url: string, w: number | null): number | null {
  const p = urlsplit(url)
  const q = SIZE_QUERY.exec(p?.query ?? '')
  if (q?.[1] !== undefined) return digitsValue(q[1])
  const s = SIZE_SUFFIX.exec(p?.path ?? '')
  if (s?.[1] !== undefined) return digitsValue(s[1])
  return px(w)
}

/** v1's `_private_host`: a picture link to a private, loopback or local address (the user's browser would request it);
 *  the evals' exempt address (MIDSTUDY_FETCH_ALLOW) is allowed, as for page fetches. */
function privateHost(p: SplitUrl, allow: string): boolean {
  const host = (urlHostname(p) ?? '').toLowerCase().replace(/\.+$/, '')
  const port = urlPort(p)
  if (port === 'invalid') return true
  const effective = port !== null && port !== 0 ? port : p.scheme.toLowerCase() === 'https' ? 443 : 80
  if (fetchAllowed(allow, host, effective)) return false
  if (host === 'localhost' || ['.localhost', '.local', '.internal', '.lan', '.home.arpa'].some((s) => host.endsWith(s))) return true
  const bare = host.replace(/^[[\]]+/, '').replace(/[[\]]+$/, '')
  const ip = bare.split('%')[0] ?? ''
  if (parseIpv4(ip) === null && parseIpv6(ip) === null) return false // a name: the browser resolves it (and from-url checks it at Make)
  return addressBlocked(bare)
}

const SCHEME_PREFIX = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*(?:data|javascript|blob|about):/iu
const ANY_SPACE = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]/u
const ICONISH = /(?:^|[/_-])(?:logo|[i\u{131}\u{130}]con|spr[i\u{131}\u{130}]te|placeholder|sp[i\u{131}\u{130}]nner|badge)s?[._-]/iu
const SIZE_IN_NAME = /_(?:\p{Nd}+x\p{Nd}*|x\p{Nd}+|\p{Nd}+x)(?:@\p{Nd}x)?(?=\.[A-Za-z0-9]+$)/gu

/** v1's `_Images`. */
export class Images {
  readonly list: ImageOut[] = []
  readonly #keys = new Map<string, ImageOut>()
  readonly #base: string
  readonly #used: Set<string>
  readonly #allow: string

  constructor(base: string, used: Set<string>, allow: string) {
    this.#base = base
    this.#used = used
    this.#allow = allow
  }

  /** v1's `_Images.key`: host and path without a size suffix. */
  static key(url: string): string {
    const p = urlsplit(url)
    const path = (p?.path ?? '').replace(SIZE_IN_NAME, '')
    return (p === null ? '' : urlHostname(p) ?? '').toLowerCase() + path
  }

  #absolute(raw: PyValue | undefined): string | null {
    if (typeof raw !== 'string') return null
    let s = pyStrip(unescape(raw))
    if (s === '' || cpLength(s) > 2048 || SCHEME_PREFIX.test(s)) return null
    if (s.startsWith('//')) s = 'https:' + s
    const u = urljoin(this.#base, s)
    if (u === null) throw new Error(`urljoin refused ${s}`) // v1's ValueError
    const p = urlsplit(u)
    if (p === null) throw new Error(`urlsplit refused ${u}`)
    const scheme = p.scheme.toLowerCase()
    if ((scheme !== 'http' && scheme !== 'https') || urlHostname(p) === null || ANY_SPACE.test(u)) return null
    if (/\.svg$/i.test(p.path) || ICONISH.test(p.path)) return null
    if (privateHost(p, this.#allow)) return null
    return u
  }

  /** v1's `_Images.add`: true when it is a new picture. */
  add(raw: PyValue | undefined, kind: ImageOut['kind'], layer: string | null, wIn: PxValue = null, hIn: PxValue = null): boolean {
    if (this.list.length >= MAX_IMAGES) return false
    const u = this.#absolute(raw)
    if (u === null) return false
    const w = px(wIn)
    const h = px(hIn)
    if ((w !== null && w < 100) || (h !== null && h < 100)) return false
    const k = Images.key(u)
    const old = this.#keys.get(k)
    if (old !== undefined) {
      // one picture: keep its largest copy, and https over http
      const newSize = copySize(u, w) ?? 0
      const oldSize = copySize(old.url, old.w) ?? 0
      if (newSize > oldSize || (newSize === oldSize && u.startsWith('https:') && old.url.startsWith('http:'))) {
        old.url = u
        if ((w !== null && w !== 0) || (h !== null && h !== 0)) {
          old.w = w
          old.h = h
        }
      }
      return false
    }
    const entry: ImageOut = { url: u, w, h, kind }
    this.#keys.set(k, entry)
    this.list.push(entry)
    if (layer !== null) this.#used.add(layer)
    return true
  }
}

const IMAGE_ID = /\.(?:jpe?g|png|webp|avif|gif)(?:\?|$)/i

/** v1's `_jsonld_images`: (url, width, height) of a JSON-LD image value (a string, a list, an ImageObject's contentUrl
 *  or url, an @id reference to a node, an @id that is itself a picture link). */
export function jsonldImages(v: PyValue | undefined, ids: ReadonlyMap<string, PyDict>): [string, PyValue | undefined, PyValue | undefined][] {
  const out: [string, PyValue | undefined, PyValue | undefined][] = []
  for (const item of asList(v)) {
    if (typeof item === 'string') {
      out.push([item, null, null])
      continue
    }
    if (!isDict(item)) continue
    let x: PyDict = item
    if (x.size === 1 && x.has('@id')) {
      const id = x.get('@id')
      if (isList(id) || isDict(id)) throw new Error('unhashable @id') // v1's TypeError (`x["@id"] in ids`)
      const node = typeof id === 'string' ? ids.get(id) : undefined
      if (node !== undefined) x = node
    }
    let u = or(x.get('contentUrl'), x.get('url'))
    if (isList(u)) u = u[0]
    if (typeof u === 'string') {
      out.push([u, x.get('width'), x.get('height')])
    } else {
      const id = x.get('@id')
      if (has(x, '@id') && typeof id === 'string' && IMAGE_ID.test(id)) out.push([id, x.get('width'), x.get('height')])
    }
  }
  return out
}

