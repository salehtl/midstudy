// Test helpers for server/test/*.test.ts: the v2 server started as the evals start it (fal mocked, no .env, a $0
// cap, scratch folders under evals/out/server-core-tests/), raw TCP exchanges for framing, plain HTTP requests.
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

export const REPO = path.resolve(import.meta.dirname, '../..')
export const SCRATCH = path.join(REPO, 'evals/out/server-core-tests')

/** A running server. */
export interface Running {
  readonly base: string
  readonly port: number
  readonly dir: string
  readonly library: string
  readonly scenes: string
  readonly renders: string
  readonly layouts: string
  readonly rooms: string
  readonly costs: string
  log(): string
  stop(): Promise<void>
}

let count = 0

/** The environment every server and tool gets in tests: fal mocked, no .env, no key. */
export function mockEnv(extra: Readonly<Record<string, string>> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'), ...extra }
  delete env['FAL_KEY']
  return env
}

/** Starts `node server/src/main.ts` on a free port with scratch folders; resolves when it prints its address. */
export async function startServer(options: { readonly args?: readonly string[]; readonly env?: Readonly<Record<string, string>>; readonly name?: string } = {}): Promise<Running> {
  count += 1
  const dir = path.join(SCRATCH, (options.name ?? 'server') + '-' + String(process.pid) + '-' + String(count))
  fs.rmSync(dir, { recursive: true, force: true })
  const library = path.join(dir, 'library')
  const scenes = path.join(dir, 'scenes')
  const renders = path.join(dir, 'renders')
  const layouts = path.join(dir, 'layouts')
  const rooms = path.join(dir, 'rooms')
  for (const d of [library, scenes, renders, layouts]) fs.mkdirSync(d, { recursive: true })
  const costs = path.join(library, 'costs.csv')
  const args = ['server/src/main.ts', '--port', '0', '--host', '127.0.0.1', '--scenes-dir', scenes, '--layouts-dir', layouts, '--renders-dir', renders,
    '--rooms-dir', rooms, '--library-dir', library, '--costs-file', costs, '--calib', 'python3 fixtures/stub_calib.py', '--daily-spend-usd', '0', ...(options.args ?? [])]
  const child: ChildProcess = spawn(process.execPath, args, { cwd: REPO, env: mockEnv(options.env), stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  child.stdout?.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  child.stderr?.on('data', (d: Buffer) => {
    out += d.toString('utf8')
  })
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('the server did not start: ' + out))
    }, 15000)
    const look = (): void => {
      const m = /http:\/\/127\.0\.0\.1:(\d+)\/planner\//.exec(out)
      if (m?.[1] !== undefined) {
        clearTimeout(timer)
        resolve(Number(m[1]))
      }
    }
    child.stdout?.on('data', look)
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error('the server exited (' + String(code) + '): ' + out))
    })
  })
  return {
    base: 'http://127.0.0.1:' + String(port),
    port,
    dir,
    library,
    scenes,
    renders,
    layouts,
    rooms,
    costs,
    log: () => out,
    stop: async () => {
      if (child.exitCode !== null) return
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => {
          resolve()
        })
      })
      child.kill('SIGTERM')
      await exited
    },
  }
}

/** What came back from a request. */
export interface Answer {
  readonly status: number
  readonly headers: http.IncomingHttpHeaders
  readonly body: Buffer
  readonly text: string
  /** The body parsed as JSON, or undefined. */
  readonly json: unknown
}

function parse(text: string): unknown {
  try {
    const v: unknown = JSON.parse(text)
    return v
  } catch {
    return undefined
  }
}

/** One HTTP request with full control of the headers and the path as written (no Host unless given or `setHost`). */
export function request(base: string, method: string, target: string, options: { readonly headers?: Readonly<Record<string, string>>; readonly body?: string | Buffer } = {}): Promise<Answer> {
  const u = new URL(base)
  const headers: Record<string, string> = { ...options.headers }
  const body = options.body === undefined ? null : Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)
  if (body !== null && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) headers['Content-Length'] = String(body.length)
  const setHost = !Object.keys(headers).some((k) => k.toLowerCase() === 'host')
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, method, path: target, headers, setHost, agent: false }, (res) => {
      const parts: Buffer[] = []
      res.on('data', (c: Buffer) => {
        parts.push(c)
      })
      res.on('end', () => {
        const b = Buffer.concat(parts)
        const text = b.toString('utf8')
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: b, text, json: parse(text) })
      })
      res.on('error', reject)
    })
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

/** A JSON request as the planner sends it (`X-Midstudy: 1`, JSON body). */
export function api(base: string, method: string, target: string, body?: unknown, headers: Readonly<Record<string, string>> = {}): Promise<Answer> {
  return request(base, method, target, {
    headers: { 'X-Midstudy': '1', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

/** A raw TCP exchange: what the server sent, when its first byte came and when it closed (null: still open at the
 *  end of `waitMs`). Stops early once a whole head arrived when `untilClose` is false. */
export function tcp(port: number, payload: string | Buffer, options: { readonly waitMs?: number; readonly untilClose?: boolean } = {}): Promise<{ readonly text: string; readonly firstMs: number | null; readonly closedMs: number | null }> {
  const waitMs = options.waitMs ?? 4000
  const untilClose = options.untilClose ?? true
  return new Promise((resolve) => {
    const t0 = Date.now()
    const sock = net.connect(port, '127.0.0.1')
    let text = ''
    let firstMs: number | null = null
    let closedMs: number | null = null
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      sock.destroy()
      resolve({ text, firstMs, closedMs })
    }
    const timer = setTimeout(finish, waitMs)
    sock.on('data', (d: Buffer) => {
      firstMs ??= Date.now() - t0
      text += d.toString('latin1')
      if (!untilClose && text.includes('\r\n\r\n')) setTimeout(finish, 100)
    })
    const closed = (): void => {
      closedMs ??= Date.now() - t0
      finish()
    }
    sock.on('end', closed)
    sock.on('close', closed)
    sock.on('error', closed)
    sock.write(typeof payload === 'string' ? Buffer.from(payload, 'latin1') : payload)
  })
}

/** The status code of a raw answer (0 when none). */
export function statusOf(text: string): number {
  const m = /^HTTP\/1\.[01] (\d{3})/.exec(text)
  return m?.[1] === undefined ? 0 : Number(m[1])
}

/** The body of a raw answer. */
export function bodyOf(text: string): string {
  const at = text.indexOf('\r\n\r\n')
  return at < 0 ? '' : text.slice(at + 4)
}

/** `{error}` of a JSON answer, or ''. */
export function errorOf(a: Answer): string {
  const j = a.json
  if (typeof j === 'object' && j !== null && 'error' in j && typeof j.error === 'string') return j.error
  return ''
}
