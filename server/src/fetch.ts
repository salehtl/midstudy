// §2.9 URL fetches (from-URL adds) and Page fetches (the product page reader): the server downloads only from
// public addresses. Each hop's host is resolved once, every address checked (v1 BLOCKED_NETS, in any IPv4-in-IPv6
// form), the connection pinned to the first (a second DNS answer can't swap in a private address), every redirect
// re-checked as a new hop, with a total time budget and a size limit; MIDSTUDY_FETCH_ALLOW=<host>:<port> (evals
// only) exempts exactly one URL host and port. URLs are read as v1 read them (Python's urlsplit and urljoin).
//
// `safeFetch` is the general reader (product: 5 redirects, 10 MB cut with a warning, gzip/deflate within the limit,
// 2 MB feeds kept to the page's origin, typed failures to word itself); `fetchImage` is v1's `fetch_image` with its
// sentences (3 redirects, 20 s, 20 MB, image/* only).
import dns from 'node:dns'
import fsp from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import path from 'node:path'
import { domainToASCII } from 'node:url'
import zlib from 'node:zlib'
import { addressBlocked, fetchAllowed } from './logic/address.ts'
import { urljoin, urlHostname, urlPort, urlsplit } from './logic/url.ts'

/** A shared deadline (a page and its feeds share 20 s). */
export class Budget {
  readonly deadline: number
  constructor(ms: number) {
    this.deadline = performance.now() + ms
  }

  left(): number {
    return this.deadline - performance.now()
  }

  over(): boolean {
    return performance.now() >= this.deadline
  }
}

/** Why a fetch stopped, for the caller to word (v1's image fetch and page reader say it differently). */
export type FetchFailure =
  | { readonly kind: 'bad-url' }
  | { readonly kind: 'scheme' }
  | { readonly kind: 'no-host' }
  | { readonly kind: 'bad-port' }
  | { readonly kind: 'dns'; readonly host: string }
  | { readonly kind: 'private'; readonly host: string }
  | { readonly kind: 'cross-origin' }
  | { readonly kind: 'redirect-without-location'; readonly status: number }
  | { readonly kind: 'too-many-redirects'; readonly max: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'tls'; readonly host: string; readonly reason: string }
  | { readonly kind: 'network'; readonly host: string; readonly error: string }
  | { readonly kind: 'too-large' }
  | { readonly kind: 'encoding'; readonly encoding: string }
  | { readonly kind: 'decode'; readonly message: string }
  | { readonly kind: 'refused'; readonly message: string }

/** A fetch that stopped (see `failure`). */
export class FetchFailed extends Error {
  readonly failure: FetchFailure
  constructor(failure: FetchFailure) {
    super('fetch failed: ' + failure.kind)
    this.name = 'FetchFailed'
    this.failure = failure
  }
}

/** What came back: the final URL (after redirects), its status and headers (lowercased names; a repeated header's
 *  last value), and for a 200 the body (decoded, at most maxBytes) and whether it was cut. */
export interface FetchResult {
  readonly url: string
  readonly status: number
  readonly headers: Readonly<Record<string, string>>
  readonly body: Buffer
  readonly cut: boolean
}

/** How to fetch. */
export interface SafeFetchOptions {
  readonly budget: Budget
  /** Redirects followed before `too-many-redirects` (v1: 3 for images, 5 for pages). */
  readonly maxRedirects: number
  /** The most body bytes kept (decoded when `decode`). */
  readonly maxBytes: number
  /** Over maxBytes: `error` (`too-large`) or `cut` (the first maxBytes, `cut: true`). The wire bytes count too. */
  readonly overflow: 'error' | 'cut'
  /** Decode a gzip or deflate Content-Encoding within the limit (page fetches); else the bytes as sent. */
  readonly decode: boolean
  /** Request headers (User-Agent, Accept, …). Host comes from the URL. */
  readonly headers: Readonly<Record<string, string>>
  /** Every hop must stay on this origin (`scheme://netloc`, lowercased: see originOf), else `cross-origin`. */
  readonly sameOrigin?: string
  /** Before a 200's body is read: a reason to stop instead (a content type, a declared length). */
  readonly check?: (status: number, headers: Readonly<Record<string, string>>) => FetchFailure | null
  /** The exemption (default: MIDSTUDY_FETCH_ALLOW). */
  readonly allow?: string
  /** Node's lenient parser for the answer (shops send odd headers). */
  readonly insecureHTTPParser?: boolean
}

/** Python's `f"{scheme.lower()}://{netloc.lower()}"` of a URL (the product reader's `_origin`); '' when it can't be
 *  split. */
export function originOf(url: string): string {
  const p = urlsplit(url)
  return p === null ? '' : p.scheme.toLowerCase() + '://' + p.netloc.toLowerCase()
}

const REDIRECTS = [301, 302, 303, 307, 308]

function errorCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

function isTlsError(e: unknown): boolean {
  const code = errorCode(e)
  return code.startsWith('ERR_TLS') || code.startsWith('ERR_SSL') || code.includes('CERT') || code === 'EPROTO'
    || code.startsWith('UNABLE_TO') || code === 'HOSTNAME_MISMATCH'
}

/** The Python exception class name v1 printed for a failed connection. */
function pythonErrorName(e: unknown): string {
  switch (errorCode(e)) {
    case 'ECONNREFUSED': return 'ConnectionRefusedError'
    case 'ECONNRESET': return e instanceof Error && e.message === 'socket hang up' ? 'RemoteDisconnected' : 'ConnectionResetError'
    case 'EPIPE': return 'BrokenPipeError'
    case 'ECONNABORTED': return 'ConnectionAbortedError'
    case 'ETIMEDOUT': return 'TimeoutError'
    case 'ERR_UNESCAPED_CHARACTERS':
    case 'ERR_INVALID_URL': return 'InvalidURL'
    default: return errorCode(e).startsWith('HPE_') ? 'BadStatusLine' : 'OSError'
  }
}

function lastValues(headers: http.IncomingHttpHeaders, distinct: NodeJS.Dict<string[]>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, values] of Object.entries(distinct)) {
    const last = values?.at(-1)
    if (last !== undefined) out[k] = last
  }
  for (const [k, v] of Object.entries(headers)) {
    if (!(k in out) && typeof v === 'string') out[k] = v
  }
  return out
}

/** The addresses of `host` (getaddrinfo, as Python's socket.getaddrinfo), within the budget. */
async function lookup(host: string, budget: Budget): Promise<string[] | 'timeout' | 'error'> {
  const name = net.isIP(host) !== 0 ? host : domainToASCII(host)
  if (name === '') return 'error'
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => {
      resolve('timeout')
    }, Math.max(1, budget.left()))
  })
  try {
    const found = dns.promises.lookup(name, { all: true }).then((list) => list.map((a) => a.address), () => 'error' as const)
    return await Promise.race([found, timeout])
  } finally {
    clearTimeout(timer)
  }
}

interface Hop {
  readonly scheme: 'http' | 'https'
  readonly host: string
  readonly port: number
  readonly target: string
}

function hopOf(url: string): Hop {
  const p = urlsplit(url)
  if (p === null) throw new FetchFailed({ kind: 'bad-url' })
  const scheme = p.scheme.toLowerCase()
  if (scheme !== 'http' && scheme !== 'https') throw new FetchFailed({ kind: 'scheme' })
  const host = urlHostname(p)
  if (host === null) throw new FetchFailed({ kind: 'no-host' })
  const port = urlPort(p)
  if (port === 'invalid') throw new FetchFailed({ kind: 'bad-port' })
  return { scheme, host, port: port ?? (scheme === 'https' ? 443 : 80), target: (p.path === '' ? '/' : p.path) + (p.query !== '' ? '?' + p.query : '') }
}

/** One GET to the pinned address; resolves with the response (body unread). */
function get(hop: Hop, ip: string, options: SafeFetchOptions, signal: AbortSignal): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const family = net.isIP(ip)
    const pinned: net.LookupFunction = (_hostname, opts, cb) => {
      if (opts.all === true) cb(null, [{ address: ip, family }])
      else cb(null, ip, family)
    }
    const common = {
      host: hop.host,
      port: hop.port,
      path: hop.target,
      method: 'GET',
      headers: { 'Accept-Encoding': 'identity', ...options.headers },
      agent: false,
      lookup: pinned,
      insecureHTTPParser: options.insecureHTTPParser === true,
      signal,
    }
    let req: http.ClientRequest
    try {
      req = hop.scheme === 'https' ? https.request(common) : http.request(common)
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)))
      return
    }
    req.on('response', resolve)
    req.on('error', reject)
    req.end()
  })
}

async function readBody(res: http.IncomingMessage, options: SafeFetchOptions, budget: Budget): Promise<{ readonly body: Buffer; readonly cut: boolean }> {
  const enc = options.decode ? (res.headers['content-encoding'] ?? '').trim().toLowerCase() : ''
  if (enc !== '' && enc !== 'identity' && enc !== 'gzip' && enc !== 'x-gzip' && enc !== 'deflate') {
    throw new FetchFailed({ kind: 'encoding', encoding: enc })
  }
  const max = options.maxBytes
  const out: Buffer[] = []
  let outLength = 0
  let wire = 0
  let over = false
  const collect = (b: Buffer): void => {
    const take = Math.min(b.length, max + 1 - outLength)
    if (take > 0) {
      out.push(b.subarray(0, take))
      outLength += take
    }
  }
  let inflater: zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | null = null
  const feed = (z: zlib.Gunzip | zlib.Inflate | zlib.InflateRaw, chunk: Buffer): Promise<void> => new Promise((resolve, reject) => {
    z.write(chunk, (err) => {
      if (err) reject(err)
      else resolve()
    })
  })
  const pieces: AsyncIterable<unknown> = res
  try {
    for await (const piece of pieces) {
      if (!Buffer.isBuffer(piece)) continue
      const chunk = piece
      if (budget.over()) throw new FetchFailed({ kind: 'timeout' })
      wire += chunk.length
      if (enc === '' || enc === 'identity') {
        collect(chunk)
      } else {
        if (inflater === null) {
          const zlibWrapped = chunk.length >= 2 && ((chunk[0] ?? 0) & 0x0f) === 8 && ((chunk[0] ?? 0) * 256 + (chunk[1] ?? 0)) % 31 === 0
          inflater = enc === 'deflate' ? (zlibWrapped ? zlib.createInflate() : zlib.createInflateRaw()) : zlib.createGunzip()
          inflater.on('data', collect)
          inflater.on('error', () => undefined)
        }
        await feed(inflater, chunk)
      }
      if (outLength > max || wire > max) {
        over = true
        break
      }
    }
    if (!over && inflater !== null) {
      const z = inflater
      await new Promise<void>((resolve) => {
        z.once('end', resolve)
        z.once('error', () => {
          resolve()
        })
        z.end()
      })
    }
  } catch (e) {
    if (e instanceof FetchFailed) throw e
    if (budget.over()) throw new FetchFailed({ kind: 'timeout' })
    if (inflater !== null && errorCode(e).startsWith('Z_')) throw new FetchFailed({ kind: 'decode', message: e instanceof Error ? e.message : String(e) })
    throw e
  } finally {
    const z: zlib.Gunzip | zlib.Inflate | zlib.InflateRaw | null = inflater
    z?.destroy()
  }
  if (outLength > max) over = true
  if (over && options.overflow === 'error') throw new FetchFailed({ kind: 'too-large' })
  const body = Buffer.concat(out)
  return { body: body.length > max ? body.subarray(0, max) : body, cut: over }
}

/** GETs `url` under §2.9's address rules (see the file comment). Throws FetchFailed. */
export async function safeFetch(url: string, options: SafeFetchOptions): Promise<FetchResult> {
  const allow = options.allow ?? process.env['MIDSTUDY_FETCH_ALLOW'] ?? ''
  const budget = options.budget
  let current = url
  for (let hopNumber = 0; hopNumber <= options.maxRedirects; hopNumber++) {
    if (options.sameOrigin !== undefined && originOf(current) !== options.sameOrigin) throw new FetchFailed({ kind: 'cross-origin' })
    const hop = hopOf(current)
    const addrs = await lookup(hop.host, budget)
    if (addrs === 'timeout') throw new FetchFailed({ kind: 'timeout' })
    if (addrs === 'error') throw new FetchFailed({ kind: 'dns', host: hop.host })
    const first = addrs[0]
    if (first === undefined || (!fetchAllowed(allow, hop.host, hop.port) && addrs.some(addressBlocked))) {
      throw new FetchFailed({ kind: 'private', host: hop.host })
    }
    if (budget.over()) throw new FetchFailed({ kind: 'timeout' })
    const controller = new AbortController()
    const watchdog = setTimeout(() => {
      controller.abort()
    }, Math.max(1, budget.left()))
    try {
      const res = await get(hop, first, options, controller.signal)
      const headers = lastValues(res.headers, res.headersDistinct)
      if (REDIRECTS.includes(res.statusCode ?? 0)) {
        const location = (headers['location'] ?? '').trim()
        res.destroy()
        if (location === '') throw new FetchFailed({ kind: 'redirect-without-location', status: res.statusCode ?? 0 })
        const next = urljoin(current, location)
        if (next === null) throw new FetchFailed({ kind: 'bad-url' })
        current = next
        continue
      }
      const status = res.statusCode ?? 0
      if (status !== 200) {
        res.destroy()
        return { url: current, status, headers, body: Buffer.alloc(0), cut: false }
      }
      const stop = options.check?.(status, headers) ?? null
      if (stop !== null) {
        res.destroy()
        throw new FetchFailed(stop)
      }
      const { body, cut } = await readBody(res, options, budget)
      return { url: current, status, headers, body, cut }
    } catch (e) {
      if (e instanceof FetchFailed) throw e
      if (controller.signal.aborted || budget.over()) throw new FetchFailed({ kind: 'timeout' })
      if (isTlsError(e)) throw new FetchFailed({ kind: 'tls', host: hop.host, reason: errorCode(e) || (e instanceof Error ? e.message : String(e)) })
      throw new FetchFailed({ kind: 'network', host: hop.host, error: pythonErrorName(e) })
    } finally {
      clearTimeout(watchdog)
    }
  }
  throw new FetchFailed({ kind: 'too-many-redirects', max: options.maxRedirects })
}

// --- v1's image fetch (from-URL adds, §2.9 URL fetches) ---------------------------------------------------------------

/** v1's sentence for a refused address. */
export const PRIVATE = 'that address is on a private network'
/** v1's sentence for a link to a web page. */
export const WEB_PAGE = "that's a web page: paste the image's own link (right-click the image, Copy Image Address)"
const FETCH_MS = 20 * 1000
const FETCH_MAX = 20 * 1024 * 1024
const FETCH_REDIRECTS = 3
const IMAGE_SUFFIX: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'], ['image/jpg', '.jpg'], ['image/png', '.png'], ['image/webp', '.webp'], ['image/heic', '.heic'], ['image/heif', '.heif'],
])

/** A from-URL add's download that failed, with v1's sentence (400). */
export class FetchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FetchError'
  }
}

function contentType(headers: Readonly<Record<string, string>>): string {
  return (headers['content-type'] ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

/** v1's sentence for each way an image download stops. */
function imageFetchMessage(f: FetchFailure): string {
  switch (f.kind) {
    case 'bad-url': return "that link isn't a valid web address: paste the image's web address"
    case 'scheme': return "only http and https links work: paste the image's web address"
    case 'no-host': return 'that link has no host name'
    case 'bad-port': return "that link's port isn't a number"
    case 'dns': return "couldn't find " + f.host + ': check the link'
    case 'private': return PRIVATE
    case 'cross-origin': return "the link left the image's site"
    case 'redirect-without-location': return 'the link redirects (HTTP ' + String(f.status) + ') without saying where'
    case 'too-many-redirects': return 'the link redirects more than ' + String(f.max) + " times: paste the image's own link"
    case 'timeout': return 'the image took more than 20 s to download: try another link'
    case 'tls': return "couldn't connect securely to " + f.host + ' (' + f.reason + ')'
    case 'network': return "couldn't download from " + f.host + ' (' + f.error + '): check the link'
    case 'too-large': return 'that image is over 20 MB: use a smaller one'
    case 'encoding': return 'the image came in an encoding this server can\'t decode (' + f.encoding + ')'
    case 'decode': return "the image couldn't be decoded (" + f.message + ')'
    case 'refused': return f.message
  }
}

/** v1 `fetch_image`: downloads an image link into `destDir` as `download.<ext>` (by its Content-Type) and returns the
 *  path; FetchError with v1's sentence otherwise (http/https only, 3 redirects, 20 s, 20 MB, image/* only). */
export async function fetchImage(url: string, destDir: string, allow?: string): Promise<string> {
  let result: FetchResult
  try {
    result = await safeFetch(url, {
      budget: new Budget(FETCH_MS),
      maxRedirects: FETCH_REDIRECTS,
      maxBytes: FETCH_MAX,
      overflow: 'error',
      decode: false,
      headers: { 'User-Agent': 'midstudy (image fetch)', Accept: 'image/*' },
      ...(allow === undefined ? {} : { allow }),
      check: (_status, headers) => {
        const ctype = contentType(headers)
        if (ctype === 'text/html' || ctype === 'application/xhtml+xml') return { kind: 'refused', message: WEB_PAGE }
        if (!ctype.startsWith('image/')) return { kind: 'refused', message: "that link isn't an image (it's " + (ctype === '' ? 'untyped' : ctype) + "): paste the image's own link" }
        const length = headers['content-length'] ?? ''
        if (/^[0-9]+$/.test(length) && Number(length) > FETCH_MAX) return { kind: 'too-large' }
        return null
      },
    })
  } catch (e) {
    if (e instanceof FetchFailed) throw new FetchError(imageFetchMessage(e.failure))
    throw e
  }
  if (result.status !== 200) throw new FetchError('the link answered HTTP ' + String(result.status) + ': check it opens the image in a browser')
  if (result.body.length === 0) throw new FetchError('the link returned an empty file')
  const dest = path.join(destDir, 'download' + (IMAGE_SUFFIX.get(contentType(result.headers)) ?? '.img'))
  await fsp.writeFile(dest, result.body)
  return dest
}
