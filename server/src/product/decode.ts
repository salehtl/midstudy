// A page's bytes as text, as v1 decoded them (`_charset`, `_decode`): the charset from the Content-Type header, else
// from a <meta> in the first 4 KB, looked up as Python's codecs.lookup does (its aliases and normalization; anything
// unknown, not a text encoding, or idna is UTF-8), then decoded with errors="replace". UTF-8, Latin-1, ASCII and every
// single-byte codec use Python's own tables (charsets.ts); UTF-16/32 are decoded here; the multi-byte East Asian codecs
// go through the WHATWG decoder of the same name, the one place where a byte the two disagree on can read differently.
import { CHARMAPS, PY_CODECS } from './charsets.ts'

const HEADER_CHARSET = /charset[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*=[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*["']?([A-Za-z0-9._:-]+)/iu
// a bytes pattern: \s is ASCII whitespace
const META_CHARSET = /<meta[^>]+charset[ \t\n\r\f\v]*=[ \t\n\r\f\v]*["']?([A-Za-z0-9._:-]+)/i

/** Python's `encodings.normalize_encoding` after codecs.lookup lowercased the name. */
function normalizeEncoding(name: string): string {
  let out = ''
  let punct = false
  for (const c of name.toLowerCase()) {
    if (/[\p{L}\p{N}]/u.test(c) || c === '.') {
      if (punct && out !== '') out += '_'
      if (c.charCodeAt(0) < 0x80) out += c
      punct = false
    } else {
      punct = true
    }
  }
  return out
}

/** `codecs.lookup(name)`: [codec name, a text encoding], or null (LookupError). */
function lookup(name: string): readonly [string, boolean] | null {
  const norm = normalizeEncoding(name)
  return PY_CODECS.get(norm) ?? PY_CODECS.get(norm.replace(/\./g, '_')) ?? null
}

/** v1's `_charset`: the codec to decode the page with. */
export function charsetOf(contentType: string, body: Uint8Array): string {
  let cs = HEADER_CHARSET.exec(contentType)?.[1] ?? null
  if (cs === null || cs === '') {
    const head = Buffer.from(body.subarray(0, 4096)).toString('latin1')
    cs = META_CHARSET.exec(head)?.[1] ?? null
  }
  if (cs === null || cs === '') return 'utf-8'
  const info = lookup(cs)
  if (info === null) return 'utf-8'
  return info[1] && info[0] !== 'idna' ? info[0] : 'utf-8'
}

/** The WHATWG decoder for Python's multi-byte codecs. */
const WHATWG: ReadonlyMap<string, string> = new Map([
  ['shift_jis', 'shift_jis'], ['cp932', 'shift_jis'], ['euc_jp', 'euc-jp'], ['iso2022_jp', 'iso-2022-jp'], ['gbk', 'gbk'], ['gb2312', 'gbk'],
  ['gb18030', 'gb18030'], ['big5', 'big5'], ['big5hkscs', 'big5'], ['cp950', 'big5'], ['euc_kr', 'euc-kr'], ['cp949', 'euc-kr'],
])

function utf32(body: Uint8Array, little: boolean | null): string {
  let le = little ?? true
  let i = 0
  if (little === null && body.length >= 4) {
    if (body[0] === 0xff && body[1] === 0xfe && body[2] === 0 && body[3] === 0) i = 4
    else if (body[0] === 0 && body[1] === 0 && body[2] === 0xfe && body[3] === 0xff) {
      le = false
      i = 4
    }
  }
  let out = ''
  for (; i + 4 <= body.length; i += 4) {
    const b0 = body[i] ?? 0
    const b1 = body[i + 1] ?? 0
    const b2 = body[i + 2] ?? 0
    const b3 = body[i + 3] ?? 0
    const cp = le ? b0 + b1 * 0x100 + b2 * 0x10000 + b3 * 0x1000000 : b3 + b2 * 0x100 + b1 * 0x10000 + b0 * 0x1000000
    out += cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff) ? '\u{fffd}' : String.fromCodePoint(cp)
  }
  if (i < body.length) out += '\u{fffd}'
  return out
}

/** v1's `_decode`: the bytes in `codec` with errors="replace" (UTF-8 for a codec this reader doesn't have). */
export function decodeBody(body: Uint8Array, codec: string): string {
  switch (codec) {
    case 'utf-8':
      return new TextDecoder('utf-8', { ignoreBOM: true }).decode(body)
    case 'utf-8-sig':
      return new TextDecoder('utf-8').decode(body)
    case 'iso8859-1':
      return Buffer.from(body).toString('latin1')
    case 'ascii': {
      let out = ''
      for (const b of body) out += b < 0x80 ? String.fromCharCode(b) : '\u{fffd}'
      return out
    }
    case 'utf-16': {
      if (body[0] === 0xfe && body[1] === 0xff) return new TextDecoder('utf-16be', { ignoreBOM: true }).decode(body.subarray(2))
      if (body[0] === 0xff && body[1] === 0xfe) return new TextDecoder('utf-16le', { ignoreBOM: true }).decode(body.subarray(2))
      return new TextDecoder('utf-16le', { ignoreBOM: true }).decode(body)
    }
    case 'utf-16-le':
      return new TextDecoder('utf-16le', { ignoreBOM: true }).decode(body)
    case 'utf-16-be':
      return new TextDecoder('utf-16be', { ignoreBOM: true }).decode(body)
    case 'utf-32':
      return utf32(body, null)
    case 'utf-32-le':
      return utf32(body, true)
    case 'utf-32-be':
      return utf32(body, false)
    default:
      break
  }
  const table = CHARMAPS.get(codec)
  if (table !== undefined) {
    const chars = Array.from(table)
    let out = ''
    for (const b of body) {
      const c = chars[b] ?? '\u{fffd}'
      out += c === '\u{fffe}' ? '\u{fffd}' : c
    }
    return out
  }
  const label = WHATWG.get(codec)
  if (label !== undefined) {
    try {
      return new TextDecoder(label).decode(body)
    } catch {
      // not in this Node's ICU: as v1 did on a codec error, UTF-8
    }
  }
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(body)
}
