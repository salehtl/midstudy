// The HTTP server on node:http (contract §2.1, §2.9), in v1's order (planner/serve.py Handler.parse_request, do_GET,
// do_PUT/POST/PATCH/DELETE):
//
//   1. Host: every Host value loopback or an --allowed-host, exactly `name[:port]` (the media kernel's checkHost),
//      else 403, before anything else (DNS rebinding), also for static files and requests without a Host.
//   2. Framing: more than one Content-Length, or one that isn't 1–15 ASCII digits, is 400 and a close. Node's parser
//      refuses most of these itself; they arrive as clientError and get the same answers (after the same Host check,
//      read from the refused bytes).
//   3. GET and HEAD: /api routes, else static files (static.ts). POST, PUT, PATCH, DELETE: the forged-request check
//      (X-Midstudy: 1 and an Origin absent or this page's own, else 403), then /api routes. Other methods: 501.
//   4. Unmatched: v1's 404 `no such endpoint: …` (405 for PUT outside /api).
//
// Sockets: one read may wait MIDSTUDY_SOCKET_TIMEOUT (30 s); an idle connection is closed after it; a request being
// handled is never cut (a render may take minutes); an answer the client stops reading is cut.
import http from 'node:http'
import type { Duplex } from 'node:stream'
import { checkHost, contentLength, originOk, reduceLeadingSlashes } from '../../../core/js/node.ts'
import { pyRepr } from '../../../common/logic/pyfmt.ts'
import { Busy } from '../../../common/lock.ts'
import { DUPLICATE_LENGTH, BAD_LENGTH, FORGED, LENGTH_AND_CHUNKED, LIBRARY_BUSY, PUT_ONLY_API, UNKNOWN_HOST, htmlErrorPage, noEndpoint, rawHeadHosts, requestLogLine } from '../logic/http.ts'
import { ContractViolation } from '../strict.ts'
import { BodyStalled, HttpError, NO_CACHE, RequestContext, type RequestSettings } from './context.ts'
import { findRoute, type ApiRoute } from './router.ts'
import { serveStatic, type StaticDirs } from './static.ts'

/** How the server answers. */
export interface ServerOptions {
  readonly routes: readonly ApiRoute[]
  readonly staticDirs: StaticDirs
  /** hostName() of each --allowed-host (loopback names are always allowed). */
  readonly allowedHostNames: readonly string[]
  readonly socketTimeoutSeconds: number
  /** One line per request and per refused connection (stderr in main.ts). */
  readonly log?: (line: string) => void
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Python's `log_date_time_string()`: local time, `05/Nov/2026 21:36:09`. */
function logTime(d: Date = new Date()): string {
  const two = (n: number): string => String(n).padStart(2, '0')
  return two(d.getDate()) + '/' + (MONTHS[d.getMonth()] ?? '') + '/' + String(d.getFullYear()) + ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds())
}

function errorCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

/** A JSON or HTML answer written straight to a socket whose request Node's parser refused, then the close. */
function rawAnswer(socket: Duplex, status: number, contentType: string, body: string): void {
  const head = 'HTTP/1.1 ' + String(status) + ' ' + (http.STATUS_CODES[status] ?? '') + '\r\n'
    + 'Date: ' + new Date().toUTCString() + '\r\n'
    + 'Content-Type: ' + contentType + '\r\n'
    + 'Content-Length: ' + String(Buffer.byteLength(body)) + '\r\n'
    + 'Connection: close\r\n'
    + NO_CACHE.map(([k, v]) => k + ': ' + v + '\r\n').join('')
    + '\r\n'
  socket.end(head + body)
  setTimeout(() => {
    socket.destroy()
  }, 1000).unref()
}

/** Creates the server (not listening yet). */
export function createServer(options: ServerOptions): http.Server {
  const settings: RequestSettings = { socketTimeoutSeconds: options.socketTimeoutSeconds }
  const log = options.log ?? ((): void => undefined)
  const inFlight = new WeakMap<Duplex, number>()

  const dispatchApi = async (ctx: RequestContext, method: string, apiPath: string): Promise<void> => {
    const found = findRoute(options.routes, method, apiPath)
    if (found === null) {
      if (method === 'GET' || method === 'HEAD') {
        await ctx.error(404, noEndpoint('GET', apiPath))
      } else {
        await ctx.error(404, noEndpoint(method, apiPath))
      }
      return
    }
    try {
      await found.route.handle(ctx, found.params)
    } catch (e) {
      await failed(ctx, e)
    }
  }

  const failed = async (ctx: RequestContext, e: unknown): Promise<void> => {
    if (ctx.answered) {
      log('midstudy server: after its answer, ' + ctx.method + ' ' + ctx.target + ' failed: ' + (e instanceof Error ? e.stack ?? e.message : String(e)))
      return
    }
    if (e instanceof HttpError) {
      await ctx.error(e.status, e.message)
    } else if (e instanceof Busy) {
      await ctx.error(503, LIBRARY_BUSY)
    } else if (e instanceof BodyStalled) {
      await ctx.stalled(e)
    } else if (e instanceof ContractViolation) {
      await ctx.error(500, e.message)
    } else {
      log('midstudy server: ' + ctx.method + ' ' + ctx.target + ' failed: ' + (e instanceof Error ? e.stack ?? e.message : String(e)))
      await ctx.error(500, e instanceof Error ? e.name + ': ' + e.message : String(e))
    }
  }

  const handle = async (req: http.IncomingMessage, res: http.ServerResponse, expectsContinue: boolean): Promise<void> => {
    const target = reduceLeadingSlashes(req.url ?? '')
    const hostValues = req.headersDistinct['host'] ?? []
    const length = contentLength(req.headersDistinct['content-length'] ?? [])
    const ctx = new RequestContext(req, res, target, length.ok ? length.value : null, settings, expectsContinue)
    const logLine = (): void => {
      log(logTime() + ' ' + requestLogLine(ctx.method, req.url ?? '', req.httpVersion, ctx.status))
    }
    res.on('finish', logLine)
    // An early answer is written to the socket, so its response object never finishes: log it when the socket closes.
    res.on('close', () => {
      if (!res.writableFinished && ctx.status !== 0) logLine()
    })
    try {
      if (checkHost(hostValues, options.allowedHostNames) !== 'allowed') {
        await ctx.error(403, UNKNOWN_HOST)
        return
      }
      if (!length.ok) {
        // Two lengths (even equal ones) frame the body ambiguously; a sign, a space or "²" frames nothing.
        ctx.markBodyDone()
        ctx.closeConnection()
        await ctx.error(400, length.error.code === 'multiple' ? DUPLICATE_LENGTH : BAD_LENGTH)
        return
      }
      const method = ctx.method
      if (method === 'GET' || method === 'HEAD') {
        if (ctx.apiPath !== null) await dispatchApi(ctx, method, ctx.apiPath)
        else await serveStatic(ctx, options.staticDirs)
        return
      }
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        if (!originOk({ xMidstudy: ctx.header('x-midstudy'), origin: ctx.header('origin'), host: ctx.header('host') })) {
          await ctx.error(403, FORGED)
          return
        }
        if (ctx.apiPath === null) {
          if (method === 'PUT') await ctx.error(405, PUT_ONLY_API)
          else await ctx.error(404, noEndpoint(method, ctx.parts?.rawPath ?? target))
          return
        }
        await dispatchApi(ctx, method, ctx.apiPath)
        return
      }
      ctx.sendHtmlError(501, 'Unsupported method (' + pyRepr(method) + ')')
    } catch (e) {
      await failed(ctx, e)
    }
  }

  const server = http.createServer({
    requireHostHeader: false, // a request without Host gets v1's 403, not Node's 400
    requestTimeout: 0, // no limit on a whole request: an upload may take long; one read may wait the socket timeout
    maxHeaderSize: 64 * 1024, // Python read header lines up to 64 KiB
  })

  const start = (req: http.IncomingMessage, res: http.ServerResponse, expectsContinue: boolean): void => {
    const socket = req.socket
    inFlight.set(socket, (inFlight.get(socket) ?? 0) + 1)
    res.on('close', () => {
      inFlight.set(socket, Math.max(0, (inFlight.get(socket) ?? 1) - 1))
    })
    handle(req, res, expectsContinue).catch((e: unknown) => {
      log('midstudy server: ' + (e instanceof Error ? e.stack ?? e.message : String(e)))
      if (!res.headersSent) res.destroy()
    })
  }
  server.on('request', (req, res) => {
    start(req, res, false)
  })
  // Expect: 100-continue: the request is handled at once; 100 Continue goes out only when a handler reads the body,
  // so an early refusal (411, 413, 403, …) reaches the client before it sends the body.
  server.on('checkContinue', (req, res) => {
    start(req, res, true)
  })

  server.on('clientError', (err: Error, socket: Duplex) => {
    const code = errorCode(err)
    if (code === 'ECONNRESET' || !socket.writable) {
      socket.destroy()
      return
    }
    if (code === 'ERR_HTTP_REQUEST_TIMEOUT' || code === 'ERR_HTTP_HEADERS_TIMEOUT') {
      socket.destroy()
      return
    }
    const rawPacket: unknown = Reflect.get(err, 'rawPacket')
    const raw = Buffer.isBuffer(rawPacket) ? rawPacket.toString('latin1') : ''
    const framing = code === 'HPE_UNEXPECTED_CONTENT_LENGTH' || code === 'HPE_INVALID_CONTENT_LENGTH'
      || (code === 'HPE_INVALID_TRANSFER_ENCODING' && /Content-Length/i.test(err.message))
    if (framing) {
      const json = (message: string): string => JSON.stringify({ error: message })
      if (checkHost(rawHeadHosts(raw), options.allowedHostNames) !== 'allowed') {
        rawAnswer(socket, 403, 'application/json; charset=utf-8', json(UNKNOWN_HOST))
      } else if (code === 'HPE_UNEXPECTED_CONTENT_LENGTH') {
        rawAnswer(socket, 400, 'application/json; charset=utf-8', json(DUPLICATE_LENGTH))
      } else if (code === 'HPE_INVALID_CONTENT_LENGTH') {
        rawAnswer(socket, 400, 'application/json; charset=utf-8', json(BAD_LENGTH))
      } else {
        rawAnswer(socket, 400, 'application/json; charset=utf-8', json(LENGTH_AND_CHUNKED))
      }
      log(logTime() + ' refused a request: ' + err.message)
      return
    }
    if (code === 'HPE_HEADER_OVERFLOW') {
      rawAnswer(socket, 431, 'text/html;charset=utf-8', htmlErrorPage(431, 'Line too long'))
      return
    }
    rawAnswer(socket, 400, 'text/html;charset=utf-8', htmlErrorPage(400, 'Bad request syntax'))
    log(logTime() + ' refused a request: ' + err.message)
  })

  // An idle connection (no request in flight) is closed after the socket timeout, and so is one whose client stopped
  // reading an answer; a request still being handled keeps its connection.
  server.setTimeout(options.socketTimeoutSeconds * 1000)
  server.on('timeout', (socket: Duplex) => {
    const busy = inFlight.get(socket) ?? 0
    if (busy === 0 || socket.writableLength > 0) socket.destroy()
  })
  return server
}
