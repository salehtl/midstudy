// One request and its answer, with v1's framing (contract §2.9; planner/serve.py Handler.send_json, discard_body,
// read_json_body, body_stalled): JSON answers, a 411 or 413 sent before the body is read (then a drain of at most
// 5 s and a close), an unread body read and dropped before any other answer (at most 256 MiB, 60 s), a body that stops
// arriving answered 408 after the socket timeout, and strict mode's check of every /api answer.
import type { IncomingMessage, ServerResponse } from 'node:http'
import { STATUS_CODES } from 'node:http'
import fs from 'node:fs'
import { apiPathOf, htmlErrorPage, isEarly, stalledMessage, targetParts, type TargetParts } from '../logic/http.ts'
import { queryValue } from '../logic/url.ts'
import { answerViolation } from '../strict.ts'

/** v1 MAX_BODY: a JSON body may be 32 MiB. */
const MAX_BODY = 32 * 1024 * 1024
/** v1 MAX_DRAIN: an early error reads (and drops) a body up to this, so the client sees the answer. */
const MAX_DRAIN = 256 * 1024 * 1024
/** v1 DRAIN_SECONDS. */
const DRAIN_MS = 60 * 1000
/** v1 EARLY_DRAIN_SECONDS: after a 411 or 413 that was already sent. */
const EARLY_DRAIN_MS = 5 * 1000

/** A handler's way to answer `{"error": message}` with a status (v1 raised ValueError for its 400s). */
export class HttpError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** The request body stopped arriving (`timeout`: nothing for the socket timeout, answered 408) or the client went
 *  away while sending it (`gone`: nothing can be answered). */
export class BodyStalled extends Error {
  readonly reason: 'timeout' | 'gone'
  constructor(reason: 'timeout' | 'gone') {
    super(reason === 'timeout' ? 'the request body stopped arriving' : 'the client went away while sending the body')
    this.name = 'BodyStalled'
    this.reason = reason
  }
}

/** What every answer carries (v1 `end_headers`): no caching, no sniffing. */
export const NO_CACHE: readonly (readonly [string, string])[] = [
  ['Cache-Control', 'no-store, must-revalidate'],
  ['Pragma', 'no-cache'],
  ['Expires', '0'],
  ['X-Content-Type-Options', 'nosniff'],
]

/** The server-wide settings a request needs. */
export interface RequestSettings {
  /** MIDSTUDY_SOCKET_TIMEOUT (default 30 s), in seconds as given. */
  readonly socketTimeoutSeconds: number
}

type ReadEnd = 'end' | 'stopped' | 'timeout' | 'gone'

/** One request: its parts as v1 routed them, its body, and its answer (exactly one). */
export class RequestContext {
  readonly req: IncomingMessage
  readonly res: ServerResponse
  /** The method as sent. */
  readonly method: string
  /** The request target with leading `//` reduced to `/` (Python's http.server did that before anything). */
  readonly target: string
  /** `urlsplit(target)`, or null where Python raises. */
  readonly parts: TargetParts | null
  /** The percent-decoded path when it is `/api` or under it (v1 `api_path`), else null. */
  readonly apiPath: string | null
  /** Content-Length, already checked (one value, ASCII digits), or null without one. */
  readonly contentLength: number | null
  /** Transfer-Encoding names chunked (v1 `chunked()`). */
  readonly chunked: boolean
  /** The status of the answer, once sent (for the log). */
  status = 0
  readonly #settings: RequestSettings
  readonly #expectsContinue: boolean
  #continueSent = false
  #bodyDone = false
  #closeAfter = false
  #answered = false

  constructor(req: IncomingMessage, res: ServerResponse, target: string, contentLength: number | null, settings: RequestSettings, expectsContinue: boolean) {
    this.req = req
    this.res = res
    this.method = req.method ?? ''
    this.target = target
    this.parts = targetParts(target)
    this.apiPath = apiPathOf(this.parts)
    this.contentLength = contentLength
    this.chunked = (this.header('transfer-encoding') ?? '').toLowerCase().includes('chunked')
    this.#settings = settings
    this.#expectsContinue = expectsContinue
  }

  /** The first value of a header (Python's `headers.get`), or undefined. */
  header(name: string): string | undefined {
    return this.req.headersDistinct[name.toLowerCase()]?.[0]
  }

  /** Every value of a header, in order. */
  headerValues(name: string): readonly string[] {
    return this.req.headersDistinct[name.toLowerCase()] ?? []
  }

  /** The first non-empty `?key=` value (v1 `query`: parse_qs, `+` a space, percent-decoded), or null. */
  query(key: string): string | null {
    return queryValue(this.parts?.query ?? '', key)
  }

  /** The body has been read, dropped or given up on (v1 `body_done`). */
  get bodyDone(): boolean {
    return this.#bodyDone
  }

  /** Whether an answer has been sent. */
  get answered(): boolean {
    return this.#answered
  }

  /** Close the connection after the answer (v1 `close_connection = True`). */
  closeConnection(): void {
    this.#closeAfter = true
  }

  /** Mark the body as handled without reading it (v1 sets `body_done` before its framing 400s). */
  markBodyDone(): void {
    this.#bodyDone = true
  }

  #sendContinue(): void {
    if (this.#expectsContinue && !this.#continueSent) {
      this.#continueSent = true
      this.res.writeContinue()
    }
  }

  /** Reads the body chunk by chunk until it ends, `onChunk` returns false, the socket timeout passes with nothing, or
   *  the client goes away. */
  #consume(onChunk: (chunk: Buffer) => boolean, deadlineMs: number | null): Promise<ReadEnd> {
    const req = this.req
    if (req.readableEnded) return Promise.resolve('end')
    const idleMs = this.#settings.socketTimeoutSeconds * 1000
    return new Promise((resolve) => {
      let finished = false
      let idle: NodeJS.Timeout | undefined
      let overall: NodeJS.Timeout | undefined
      const finish = (why: ReadEnd): void => {
        if (finished) return
        finished = true
        clearTimeout(idle)
        clearTimeout(overall)
        req.off('data', onData)
        req.off('end', onEnd)
        req.off('aborted', onGone)
        req.off('error', onGone)
        req.off('close', onClose)
        if (why !== 'end') req.pause()
        resolve(why)
      }
      const arm = (): void => {
        clearTimeout(idle)
        idle = setTimeout(() => {
          finish('timeout')
        }, idleMs)
      }
      const onData = (chunk: Buffer): void => {
        arm()
        if (!onChunk(chunk)) finish('stopped')
      }
      const onEnd = (): void => {
        finish('end')
      }
      const onGone = (): void => {
        finish('gone')
      }
      const onClose = (): void => {
        finish(req.complete ? 'end' : 'gone')
      }
      if (deadlineMs !== null) {
        overall = setTimeout(() => {
          finish('stopped')
        }, deadlineMs)
      }
      req.on('data', onData)
      req.on('end', onEnd)
      req.on('aborted', onGone)
      req.on('error', onGone)
      req.on('close', onClose)
      arm()
      req.resume()
    })
  }

  /** v1 `read_json_body`: the Content-Length bytes parsed as JSON. HttpError(400) with v1's sentences for an empty
   *  or over-32-MiB body and for text that isn't JSON; BodyStalled when it stops arriving. */
  async readJson(): Promise<unknown> {
    const length = this.contentLength ?? 0
    if (length <= 0) throw new HttpError(400, 'empty request body')
    if (length > MAX_BODY) throw new HttpError(400, 'request body too large')
    const raw = await this.readBody(length)
    let text: string
    try {
      text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(raw)
    } catch (e) {
      throw new HttpError(400, 'body is not valid JSON: ' + (e instanceof Error ? e.message : String(e)))
    }
    if (jsonTooDeep(text)) throw new HttpError(400, 'body is not valid JSON: it is nested too deeply')
    try {
      const value: unknown = JSON.parse(text)
      return value
    } catch (e) {
      throw new HttpError(400, 'body is not valid JSON: ' + (e instanceof Error ? e.message : String(e)))
    }
  }

  /** Up to `length` bytes of the body (fewer when the client ends early), then the body counts as read. */
  async readBody(length: number): Promise<Buffer> {
    this.#sendContinue()
    const parts: Buffer[] = []
    let got = 0
    const why = await this.#consume((chunk) => {
      const take = Math.min(chunk.length, length - got)
      if (take > 0) parts.push(take === chunk.length ? chunk : chunk.subarray(0, take))
      got += take
      return got < length
    }, null)
    this.#bodyDone = true
    if (why === 'timeout' || why === 'gone') {
      this.#closeAfter = true
      throw new BodyStalled(why)
    }
    return Buffer.concat(parts)
  }

  /** Streams up to `length` body bytes into `file` (v1's upload loop): resolves with the bytes written (fewer than
   *  `length` when the client ended early: v1's "the upload stopped before the end"); BodyStalled when it stops
   *  arriving. */
  async readBodyTo(file: string, length: number): Promise<number> {
    this.#sendContinue()
    const fd = fs.openSync(file, 'w', 0o600)
    let got = 0
    const write: { failure: Error | null } = { failure: null }
    let why: ReadEnd
    try {
      why = await this.#consume((chunk) => {
        const take = Math.min(chunk.length, length - got)
        try {
          if (take > 0) fs.writeSync(fd, chunk, 0, take)
        } catch (e) {
          write.failure = e instanceof Error ? e : new Error(String(e))
          return false
        }
        got += take
        return got < length
      }, null)
    } finally {
      fs.closeSync(fd)
    }
    this.#bodyDone = true
    if (write.failure !== null) {
      this.#closeAfter = true
      throw write.failure
    }
    if (why === 'timeout' || why === 'gone') {
      this.#closeAfter = true
      throw new BodyStalled(why)
    }
    return got
  }

  /** v1 `discard_body`: reads and drops an unread body (at most 256 MiB, for at most `ms`), so an error reaches the
   *  client instead of a reset; a body that doesn't arrive in time closes the connection. */
  async #discardBody(ms: number): Promise<void> {
    if (this.#bodyDone || this.method === 'GET' || this.method === 'HEAD') return
    this.#bodyDone = true
    if (!this.chunked) {
      const left = this.contentLength ?? 0
      if (left === 0) return
      if (left > MAX_DRAIN) {
        this.#closeAfter = true
        return
      }
    }
    if (this.#expectsContinue && !this.#continueSent) {
      // The client waits for 100 Continue before it sends the body; an answer now means it never will.
      this.#closeAfter = true
      return
    }
    let total = 0
    const why = await this.#consume((chunk) => {
      total += chunk.length
      return total <= MAX_DRAIN
    }, ms)
    if (why !== 'end') this.#closeAfter = true
  }

  /** v1 `send_json`: `data` as JSON with `status`. Strict mode replaces an /api answer that breaks its schema with
   *  500 `contract violation: …`. A 411 or 413 before the body was read goes out at once, with `Connection: close`,
   *  then a drain of at most 5 s and the close; any other answer first drops an unread body. */
  async send(status: number, data: unknown): Promise<void> {
    if (this.#answered) return
    let code = status
    let body = data
    if (this.apiPath !== null) {
      const v = answerViolation(this.method, this.target, code, body)
      if (v !== null) {
        code = 500
        body = { error: v.message }
      }
    }
    const waitingForContinue = this.#expectsContinue && !this.#continueSent && (this.chunked || (this.contentLength ?? 0) > 0)
    if (isEarly(code, this.#bodyDone) || (!this.#bodyDone && waitingForContinue)) {
      await this.#sendEarly(code, JSON.stringify(body))
      return
    }
    await this.#discardBody(DRAIN_MS)
    this.#write(code, 'application/json; charset=utf-8', JSON.stringify(body), [])
  }

  /** `{"error": message}` with `status` (v1 `error_json`). */
  error(status: number, message: string): Promise<void> {
    return this.send(status, { error: message })
  }

  /** v1 `body_stalled`: the body stopped arriving (408 and one sentence, if the client can still read it) or the
   *  client went away (nothing); the connection closes. Never a 500. */
  async stalled(e: BodyStalled): Promise<void> {
    this.#bodyDone = true
    this.#closeAfter = true
    if (e.reason === 'timeout' && !this.#answered) {
      await this.send(408, { error: stalledMessage(this.#settings.socketTimeoutSeconds) })
      return
    }
    this.#answered = true
    this.req.socket.destroy()
  }

  /** Python's `send_error` page (static 404s, unsupported methods): text/html, `Connection: close`, no drain. */
  sendHtmlError(status: number, message: string): void {
    if (this.#answered) return
    this.#closeAfter = true
    this.#bodyDone = true
    this.#write(status, 'text/html;charset=utf-8', htmlErrorPage(status, message), [])
  }

  /** A body-less answer with headers (v1's redirects: `Location`, `Content-Length: 0`). */
  sendEmpty(status: number, headers: readonly (readonly [string, string])[]): void {
    if (this.#answered) return
    this.#bodyDone = this.#bodyDone || this.method === 'GET' || this.method === 'HEAD'
    this.#write(status, null, '', headers)
  }

  /** Starts a file answer (static): the headers now, then the caller pipes the body (none for HEAD). */
  beginFile(status: number, headers: readonly (readonly [string, string])[]): ServerResponse {
    this.#answered = true
    this.status = status
    const res = this.res
    res.statusCode = status
    for (const [k, v] of headers) res.setHeader(k, v)
    for (const [k, v] of NO_CACHE) res.setHeader(k, v)
    if (this.#closeAfter) res.setHeader('Connection', 'close')
    return res
  }

  #write(status: number, contentType: string | null, text: string, headers: readonly (readonly [string, string])[]): void {
    if (this.#answered) return
    this.#answered = true
    this.status = status
    const res = this.res
    if (res.destroyed || res.headersSent) return
    res.statusCode = status
    if (contentType !== null) {
      res.setHeader('Content-Type', contentType)
      res.setHeader('Content-Length', Buffer.byteLength(text))
    }
    for (const [k, v] of headers) res.setHeader(k, v)
    for (const [k, v] of NO_CACHE) res.setHeader(k, v)
    if (this.#closeAfter) res.setHeader('Connection', 'close')
    res.end(this.method === 'HEAD' ? undefined : text)
  }

  /** The early answer: written to the socket at once (the body still unread), `Connection: close`, then the body read
   *  and dropped for at most 5 s (256 MiB), then the close. */
  async #sendEarly(status: number, json: string): Promise<void> {
    this.#answered = true
    this.status = status
    const socket = this.req.socket
    const head = 'HTTP/1.1 ' + String(status) + ' ' + (STATUS_CODES[status] ?? '') + '\r\n'
      + 'Date: ' + new Date().toUTCString() + '\r\n'
      + 'Content-Type: application/json; charset=utf-8\r\n'
      + 'Content-Length: ' + String(Buffer.byteLength(json)) + '\r\n'
      + 'Connection: close\r\n'
      + NO_CACHE.map(([k, v]) => k + ': ' + v + '\r\n').join('')
      + '\r\n'
    if (!socket.writable) {
      socket.destroy()
      return
    }
    socket.write(head + (this.method === 'HEAD' ? '' : json))
    this.#bodyDone = true
    const tooBig = !this.chunked && (this.contentLength ?? 0) > MAX_DRAIN
    if (!tooBig) {
      let total = 0
      await this.#consume((chunk) => {
        total += chunk.length
        return total <= MAX_DRAIN
      }, EARLY_DRAIN_MS)
    }
    socket.end()
    setTimeout(() => {
      socket.destroy()
    }, 1000).unref()
  }
}

/** JSON nested deeper than Python's json module reads (its recursion limit, about 1000): v1 answered "it is nested
 *  too deeply". Brackets inside strings don't count. */
function jsonTooDeep(text: string, limit = 990): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inString) {
      if (c === 92) i += 1
      else if (c === 34) inString = false
      continue
    }
    if (c === 34) inString = true
    else if (c === 91 || c === 123) {
      depth += 1
      if (depth > limit) return true
    } else if (c === 93 || c === 125) depth -= 1
  }
  return false
}
