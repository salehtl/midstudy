// URLs as v1 read them (Python's urllib.parse): `urlsplit` with `hostname` and `port`, `urljoin` for redirects,
// `unquote` and `parse_qs` for request targets. The server must route, check and connect to exactly what v1 did, so
// these follow CPython 3.12 step by step rather than WHATWG URL. Pure (TScert).
import { parseIpv4, parseIpv6 } from './address.ts'

/** `urllib.parse.SplitResult`. */
export interface SplitUrl {
  readonly scheme: string
  readonly netloc: string
  readonly path: string
  readonly query: string
  readonly fragment: string
}

const SCHEME_CHARS = /^[A-Za-z][A-Za-z0-9+.-]*$/
// _WHATWG_C0_CONTROL_OR_SPACE, stripped from the start only
const LEADING_C0 = /^[\x00-\x20]+/

/** CPython's `_check_bracketed_netloc` (called when the netloc holds both `[` and `]`). */
function bracketedOk(netloc: string): boolean {
  const at = netloc.lastIndexOf('@')
  const hostPort = at < 0 ? netloc : netloc.slice(at + 1)
  const open = hostPort.indexOf('[')
  let host: string
  if (open >= 0) {
    if (open > 0) return false
    const close = hostPort.indexOf(']')
    host = hostPort.slice(1, close < 0 ? hostPort.length : close)
    const port = close < 0 ? '' : hostPort.slice(close + 1)
    if (port !== '' && !port.startsWith(':')) return false
  } else {
    const c = hostPort.indexOf(':')
    host = c < 0 ? hostPort : hostPort.slice(0, c)
  }
  if (host.startsWith('v')) return /^v[a-fA-F0-9]+\..+$/.test(host)
  // ipaddress.ip_address(host) must be an IPv6 address (an IPv4 one in brackets is refused)
  if (parseIpv4(host) !== null) return false
  const pct = host.indexOf('%')
  return parseIpv6(pct < 0 ? host : host.slice(0, pct)) !== null
}

/** Python's `urlsplit(url, scheme)`; null where it raises ValueError (a malformed bracketed host). */
export function urlsplit(url: string, defaultScheme = ''): SplitUrl | null {
  let rest = url.replace(LEADING_C0, '').replace(/[\t\r\n]/g, '')
  let scheme = defaultScheme
  let netloc = ''
  let query = ''
  let fragment = ''
  const colon = rest.indexOf(':')
  if (colon > 0 && SCHEME_CHARS.test(rest.slice(0, colon))) {
    scheme = rest.slice(0, colon).toLowerCase()
    rest = rest.slice(colon + 1)
  }
  if (rest.startsWith('//')) {
    let end = rest.length
    for (const c of ['/', '?', '#']) {
      const at = rest.indexOf(c, 2)
      if (at >= 0 && at < end) end = at
    }
    netloc = rest.slice(2, end)
    rest = rest.slice(end)
    const open = netloc.includes('[')
    const close = netloc.includes(']')
    if (open !== close) return null
    if (open && !bracketedOk(netloc)) return null
  }
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    fragment = rest.slice(hash + 1)
    rest = rest.slice(0, hash)
  }
  const q = rest.indexOf('?')
  if (q >= 0) {
    query = rest.slice(q + 1)
    rest = rest.slice(0, q)
  }
  return { scheme, netloc, path: rest, query, fragment }
}

/** Python's `urlunsplit` (3.12). */
export function urlunsplit(p: SplitUrl): string {
  let url = p.path
  if (p.netloc !== '' || (p.scheme !== '' && USES_NETLOC.includes(p.scheme) && !url.startsWith('//'))) {
    if (url !== '' && !url.startsWith('/')) url = '/' + url
    url = '//' + p.netloc + url
  }
  if (p.scheme !== '') url = p.scheme + ':' + url
  if (p.query !== '') url = url + '?' + p.query
  if (p.fragment !== '') url = url + '#' + p.fragment
  return url
}

/** The host and port text of a netloc (`_hostinfo`): after the last `@`; a bracketed host without its brackets. */
function hostinfo(netloc: string): { readonly host: string; readonly port: string } {
  const at = netloc.lastIndexOf('@')
  const info = at < 0 ? netloc : netloc.slice(at + 1)
  const open = info.indexOf('[')
  if (open >= 0) {
    const bracketed = info.slice(open + 1)
    const close = bracketed.indexOf(']')
    const host = close < 0 ? bracketed : bracketed.slice(0, close)
    const after = close < 0 ? '' : bracketed.slice(close + 1)
    const c = after.indexOf(':')
    return { host, port: c < 0 ? '' : after.slice(c + 1) }
  }
  const c = info.indexOf(':')
  return c < 0 ? { host: info, port: '' } : { host: info.slice(0, c), port: info.slice(c + 1) }
}

/** `SplitResult.hostname`: lowercased (an IPv6 zone keeps its case), null when empty. */
export function urlHostname(p: SplitUrl): string | null {
  const { host } = hostinfo(p.netloc)
  if (host === '') return null
  const pct = host.indexOf('%')
  return pct < 0 ? host.toLowerCase() : host.slice(0, pct).toLowerCase() + host.slice(pct)
}

/** `SplitResult.port`: null without one; `invalid` where Python raises (not ASCII digits, or above 65535). */
export function urlPort(p: SplitUrl): number | null | 'invalid' {
  const { port } = hostinfo(p.netloc)
  if (port === '') return null
  if (!/^[0-9]+$/.test(port)) return 'invalid'
  const n = parseInt(port, 10)
  return n > 65535 ? 'invalid' : n
}

const USES_RELATIVE = ['', 'ftp', 'http', 'gopher', 'nntp', 'imap', 'wais', 'file', 'https', 'shttp', 'mms', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'sftp', 'svn', 'svn+ssh', 'ws', 'wss']
const USES_NETLOC = ['', 'ftp', 'http', 'gopher', 'nntp', 'telnet', 'imap', 'wais', 'file', 'mms', 'https', 'shttp', 'snews', 'prospero', 'rtsp', 'rtsps', 'rtspu', 'rsync', 'svn', 'svn+ssh', 'sftp', 'nfs', 'git', 'git+ssh', 'ws', 'wss', 'itms-services']
const USES_PARAMS = ['', 'ftp', 'hdl', 'prospero', 'http', 'imap', 'https', 'shttp', 'rtsp', 'rtsps', 'rtspu', 'sip', 'sips', 'mms', 'sftp', 'tel']

interface ParsedUrl extends SplitUrl {
  readonly params: string
}

function urlparse(url: string, scheme: string): ParsedUrl | null {
  const s = urlsplit(url, scheme)
  if (s === null) return null
  if (USES_PARAMS.includes(s.scheme) && s.path.includes(';')) {
    const slash = s.path.lastIndexOf('/')
    const semi = slash >= 0 ? s.path.indexOf(';', slash) : s.path.indexOf(';')
    if (semi >= 0) return { ...s, path: s.path.slice(0, semi), params: s.path.slice(semi + 1) }
  }
  return { ...s, params: '' }
}

function urlunparse(p: ParsedUrl): string {
  const path = p.params !== '' ? p.path + ';' + p.params : p.path
  return urlunsplit({ scheme: p.scheme, netloc: p.netloc, path, query: p.query, fragment: p.fragment })
}

/** Python's `urljoin(base, url)` (3.12): how v1 followed a redirect's `Location`. Null where urlsplit would raise. */
export function urljoin(base: string, url: string): string | null {
  if (base === '') return url
  if (url === '') return base
  const b = urlparse(base, '')
  if (b === null) return null
  const u = urlparse(url, b.scheme)
  if (u === null) return null
  if (u.scheme !== b.scheme || !USES_RELATIVE.includes(u.scheme)) return url
  let netloc = u.netloc
  if (USES_NETLOC.includes(u.scheme)) {
    if (u.netloc !== '') return urlunparse(u)
    netloc = b.netloc
  }
  if (u.path === '' && u.params === '') {
    return urlunparse({ scheme: u.scheme, netloc, path: b.path, params: b.params, query: u.query !== '' ? u.query : b.query, fragment: u.fragment })
  }
  const baseParts = b.path.split('/')
  if (baseParts.at(-1) !== '') baseParts.pop()
  let segments: string[]
  if (u.path.startsWith('/')) {
    segments = u.path.split('/')
  } else {
    const joined = [...baseParts, ...u.path.split('/')]
    const first = joined[0] ?? ''
    const lastSeg = joined.at(-1) ?? ''
    const middle = joined.slice(1, joined.length - 1).filter((x) => x !== '')
    segments = joined.length > 1 ? [first, ...middle, lastSeg] : joined
  }
  const resolved: string[] = []
  for (const seg of segments) {
    if (seg === '..') {
      resolved.pop()
    } else if (seg !== '.') {
      resolved.push(seg)
    }
  }
  const lastSegment = segments.at(-1)
  if (lastSegment === '.' || lastSegment === '..') resolved.push('')
  const path = resolved.join('/')
  return urlunparse({ scheme: u.scheme, netloc, path: path === '' ? '/' : path, params: u.params, query: u.query, fragment: u.fragment })
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 97 && c <= 102) return c - 87
  if (c >= 65 && c <= 70) return c - 55
  return -1
}

/** UTF-8 bytes to text, each maximal ill-formed subsequence one U+FFFD (Python's and WHATWG's "replace"). */
export function utf8Decode(bytes: readonly number[]): string {
  let out = ''
  let i = 0
  while (i < bytes.length) {
    const b0 = bytes[i] ?? 0
    if (b0 < 0x80) {
      out += String.fromCharCode(b0)
      i += 1
      continue
    }
    let need: number
    let cp: number
    let lower = 0x80
    let upper = 0xbf
    if (b0 >= 0xc2 && b0 <= 0xdf) {
      need = 1
      cp = b0 - 0xc0
    } else if (b0 >= 0xe0 && b0 <= 0xef) {
      need = 2
      cp = b0 - 0xe0
      if (b0 === 0xe0) lower = 0xa0
      if (b0 === 0xed) upper = 0x9f
    } else if (b0 >= 0xf0 && b0 <= 0xf4) {
      need = 3
      cp = b0 - 0xf0
      if (b0 === 0xf0) lower = 0x90
      if (b0 === 0xf4) upper = 0x8f
    } else {
      out += '\ufffd'
      i += 1
      continue
    }
    let j = 1
    let ok = true
    while (j <= need) {
      const b = bytes[i + j]
      if (b === undefined || b < lower || b > upper) {
        ok = false
        break
      }
      cp = cp * 64 + (b - 0x80)
      lower = 0x80
      upper = 0xbf
      j += 1
    }
    if (!ok) {
      out += '\ufffd'
      i += j
      continue
    }
    out += String.fromCodePoint(cp)
    i += need + 1
  }
  return out
}

function unquoteAscii(run: string): string {
  const bytes: number[] = []
  let i = 0
  while (i < run.length) {
    const c = run.charCodeAt(i)
    if (c === 37 && i + 2 < run.length && hexValue(run.charCodeAt(i + 1)) >= 0 && hexValue(run.charCodeAt(i + 2)) >= 0) {
      bytes.push(hexValue(run.charCodeAt(i + 1)) * 16 + hexValue(run.charCodeAt(i + 2)))
      i += 3
      continue
    }
    bytes.push(c)
    i += 1
  }
  return utf8Decode(bytes)
}

/** Python's `urllib.parse.unquote(s)` (UTF-8, errors "replace"): each run of ASCII is percent-decoded and decoded as
 *  UTF-8; other characters pass through. */
export function unquote(s: string): string {
  if (!s.includes('%')) return s
  let out = ''
  let run = ''
  for (const ch of s) {
    if (ch.charCodeAt(0) < 0x80) {
      run += ch
    } else {
      if (run !== '') out += unquoteAscii(run)
      run = ''
      out += ch
    }
  }
  if (run !== '') out += unquoteAscii(run)
  return out
}

/** Python's `parse_qs(query)` read as v1 read it (`.get(key)[0]`): the first value given for `key`, with `+` as a
 *  space, percent-decoded; pairs without `=` and empty values are left out (keep_blank_values is off). */
export function queryValue(query: string, key: string): string | null {
  for (const pair of query.split('&')) {
    if (pair === '') continue
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const value = pair.slice(eq + 1)
    if (value === '') continue
    const name = unquote(pair.slice(0, eq).replace(/\+/g, ' '))
    if (name === key) return unquote(value.replace(/\+/g, ' '))
  }
  return null
}
