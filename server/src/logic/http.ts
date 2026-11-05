// v1's HTTP decisions and sentences (planner/serve.py Handler, contract §2.1 and §2.9), as pure functions: what a
// request target routes to, which answers are sent before the body, the error sentences and Python's HTML error
// page. Pure (TScert); server/src/http/ does the I/O.
import { pyFormatG } from '../../../common/logic/pyfmt.ts'
import { unquote, urlsplit, urlunsplit } from './url.ts'

/** §2.9 Host names: a request whose Host isn't loopback or an --allowed-host. */
export const UNKNOWN_HOST = 'unknown host name: add it with --allowed-host'
/** §2.9 Forged requests. */
export const FORGED = 'cross-site request refused'
/** §2.9 Framing: two Content-Length headers (even equal ones). */
export const DUPLICATE_LENGTH = 'the request has more than one Content-Length header'
/** §2.9 Framing: a Content-Length that isn't 1–15 ASCII digits. */
export const BAD_LENGTH = "the Content-Length header isn't a number of bytes"
/** Node refuses a request with both Content-Length and Transfer-Encoding (v1 had no rule; Python read either). */
export const LENGTH_AND_CHUNKED = 'the request has both a Content-Length and a Transfer-Encoding header'
/** §2.8 One writer: a library write that waited 60 s for a running midstudy-add. */
export const LIBRARY_BUSY = 'the library is busy with another change (a midstudy-add run): try again in a minute'
/** The routes the server doesn't implement yet (v2 stage A: stage-B tracks replace them). */
export const NOT_IMPLEMENTED = 'not implemented in v2 yet'
/** v1's PUT outside /api. */
export const PUT_ONLY_API = 'PUT is only supported under /api'

/** v1's 408 (`body_stalled`): `{SOCKET_TIMEOUT:g}` seconds. */
export function stalledMessage(seconds: number): string {
  return 'the request body stopped arriving (nothing for ' + pyFormatG(seconds) + ' s): send it again'
}

/** v1's 404 for an unknown route: `no such endpoint: <METHOD> <path>`. */
export function noEndpoint(method: string, path: string): string {
  return 'no such endpoint: ' + method + ' ' + path
}

/** v1 `send_json`: a 411 or 413 sent before the body was read goes out at once, then a short drain and a close. */
export function isEarly(status: number, bodyDone: boolean): boolean {
  return (status === 411 || status === 413) && !bodyDone
}

/** The parts of a request target v1 routed on (Python's `urlsplit(self.path)`); a target urlsplit refuses has none. */
export interface TargetParts {
  /** The path as it arrived (not decoded). */
  readonly rawPath: string
  /** The query, without `?`. */
  readonly query: string
  readonly fragment: string
  readonly scheme: string
  readonly netloc: string
}

/** `urlsplit(target)`, or null where Python raises (a malformed bracketed host in an absolute-form target). */
export function targetParts(target: string): TargetParts | null {
  const p = urlsplit(target)
  if (p === null) return null
  return { rawPath: p.path, query: p.query, fragment: p.fragment, scheme: p.scheme, netloc: p.netloc }
}

/** v1 `api_path`: the target's path percent-decoded when it is `/api` or under `/api/`, else null. */
export function apiPathOf(parts: TargetParts | null): string | null {
  if (parts === null) return null
  const path = unquote(parts.rawPath)
  return path === '/api' || path.startsWith('/api/') ? path : null
}

/** Where v1 redirected a folder asked for without its slash (SimpleHTTPRequestHandler: the target's own parts with
 *  `/` added to the path). */
export function folderLocation(parts: TargetParts): string {
  return urlunsplit({ scheme: parts.scheme, netloc: parts.netloc, path: parts.rawPath + '/', query: parts.query, fragment: parts.fragment })
}

/** Python's `html.escape(s, quote=False)`. */
export function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** http.server's long explanation of a status (`BaseHTTPRequestHandler.responses[code][1]`). */
export function explainStatus(code: number): string {
  switch (code) {
    case 400: return 'Bad request syntax or unsupported method'
    case 403: return 'Request forbidden -- authorization will not help'
    case 404: return 'Nothing matches the given URI'
    case 405: return 'Specified method is invalid for this resource'
    case 408: return 'Request timed out; try again later'
    case 413: return 'Entity is too large'
    case 414: return 'URI is too long'
    case 431: return 'The server is unwilling to process the request because its header fields are too large'
    case 500: return 'Server got itself in trouble'
    case 501: return 'Server does not support this operation'
    case 505: return 'Cannot fulfill request'
    default: return ''
  }
}

/** The body of Python's `send_error` (http.server's DEFAULT_ERROR_MESSAGE), which v1 sent for static 404s,
 *  unsupported methods and requests it couldn't parse. */
export function htmlErrorPage(code: number, message: string): string {
  return '<!DOCTYPE HTML>\n<html lang="en">\n    <head>\n        <meta charset="utf-8">\n'
    + '        <title>Error response</title>\n    </head>\n    <body>\n        <h1>Error response</h1>\n'
    + '        <p>Error code: ' + String(code) + '</p>\n'
    + '        <p>Message: ' + htmlEscape(message) + '.</p>\n'
    + '        <p>Error code explanation: ' + String(code) + ' - ' + htmlEscape(explainStatus(code)) + '.</p>\n'
    + '    </body>\n</html>\n'
}

/** The Host values of a raw request head (the bytes Node's parser refused, read as latin-1): every `Host:` header
 *  line's value without surrounding spaces, in order. Folded continuation lines join the header before them. */
export function rawHeadHosts(head: string): string[] {
  const end = head.search(/\r?\n\r?\n/)
  const block = end < 0 ? head : head.slice(0, end)
  const lines = block.split(/\r?\n/).slice(1)
  const hosts: string[] = []
  let lastWasHost = false
  for (const line of lines) {
    if (line.startsWith(' ') || line.startsWith('\t')) {
      const prev = lastWasHost ? hosts.pop() : undefined
      if (prev !== undefined) hosts.push((prev + ' ' + line.trim()).trim())
      continue
    }
    lastWasHost = false
    const colon = line.indexOf(':')
    if (colon <= 0) continue
    if (line.slice(0, colon).trim().toLowerCase() !== 'host') continue
    hosts.push(line.slice(colon + 1).trim())
    lastWasHost = true
  }
  return hosts
}

/** Python's log line for a request (`log_request`): `"<request line>" <status> -`. */
export function requestLogLine(method: string, url: string, version: string, status: number): string {
  return '"' + method + ' ' + url + ' HTTP/' + version + '" ' + String(status) + ' -'
}
