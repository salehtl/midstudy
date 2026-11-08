// How the calibration queue runs `midstudy-calib` (contract §4.3 Worker, §4.4): through the warm worker
// (`<calib> serve`, MoGe-2 kept loaded) when it works, else the one-shot command, with the same result either way.
//
//   - The worker starts on the first calibration job, not at startup, with the one-shot commands' working directory
//     (the repository) and the server's environment (MIDSTUDY_CALIB_MOCK reaches it), and serves the next jobs.
//   - One request at a time (the queue runs one job at a time), answered within the job's timeout (600 s). Its stderr
//     is read continuously; what it wrote during a request backs a failure's sentence, as a one-shot run's stderr does.
//   - A worker that can't be started, exits, or answers anything but a JSON object with the request's id is killed
//     (SIGTERM, then SIGKILL after 5 s) and that job runs one-shot; the next job starts a new worker. After 3 such
//     failures in a row the one-shot command is used for the rest of the server's life. fixtures/stub_calib.py has no
//     `serve` (it exits 2 at once), so the stub's jobs end up one-shot.
//   - A request still running at the timeout fails its job with the one-shot timeout sentence; the worker is killed.
//   - An idle worker's stdin is closed after 10 minutes (MoGe-2 gives its memory back) and it is killed after 5 s if it
//     hasn't exited; the next job waits for that, so only one model is ever loaded. What it writes to stderr while idle
//     is logged if it then dies by itself. On shutdown its stdin is closed, then it is killed after 5 s.
//   - After shutdown nothing starts (the job ends 'the server stopped'), and a one-shot run in flight is ended.
//   - `align` (renders) never goes through the worker: a render never waits behind a calibration.
//   - In strict mode every result line and worker answer is checked against contract/calib-cli.schema.json (the command's
//     result, or the error result for `ok: false`); one that breaks it fails its job with `contract violation: …`.
import { spawn, type ChildProcess } from 'node:child_process'
import { lastJsonLine, runTool } from '../../../common/tools.ts'
import { conformance } from '../strict.ts'
import type { CalibCommand } from './logic/jobs.ts'
import { isRecord } from './logic/values.ts'
import { calibResultSchema, failuresAfter, readWorkerLine, requestLine, workerUsable } from './logic/worker.ts'

/** What a calibration step came to, as the one-shot command reports it. */
export type CalibOutcome =
  /** It ran: the exit code (the worker's answer counts as 0 for `ok: true`, 1 otherwise), the last stdout line parsed
   *  (null when there is none or it isn't JSON) and stderr. */
  | { readonly kind: 'result'; readonly returnCode: number; readonly line: unknown; readonly stderr: string }
  | { readonly kind: 'not-found'; readonly command: string }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'spawn-error'; readonly message: string }
  /** The server is stopping: the worker was closed under the job, and nothing new is started. */
  | { readonly kind: 'stopped' }
  /** Strict mode: the result (or the worker's answer) breaks contract/calib-cli.schema.json; the job fails with this. */
  | { readonly kind: 'violation'; readonly message: string }

/** One job's step: `<calib> <cmd> <args>` one-shot, or `{"id", "cmd", "args"}` to the worker. */
export interface CalibRequest {
  readonly id: string
  readonly cmd: CalibCommand
  readonly args: readonly string[]
}

export interface CalibRunnerOptions {
  /** --calib, split. */
  readonly calib: readonly string[]
  /** The working directory of the tool (the repository). */
  readonly cwd: string
  readonly timeoutMs: number
  /** An idle worker's stdin is closed after this. */
  readonly idleMs: number
  /** How long a worker gets to exit after SIGTERM or the end of its stdin before SIGKILL. */
  readonly killGraceMs: number
  readonly log: (line: string) => void
}

/** The most of a worker's stderr kept for one request (its end). */
const STDERR_KEEP = 1024 * 1024
/** The longest answer line read (a calib.json is a few kB). */
const MAX_LINE = 64 * 1024 * 1024
/** After the SIGKILL, how long a stop waits for 'close' (a grandchild that left the group can hold the pipes open). */
const CLOSE_CAP_MS = 5000

/** The worker's answer to a request cut by SIGTERM or SIGINT (contract §4.3 Worker). */
const INTERRUPTED = 'interrupted'

type Answer =
  | { readonly kind: 'answer'; readonly ok: boolean; readonly line: Readonly<Record<string, unknown>>; readonly raw: Readonly<Record<string, unknown>>; readonly stderr: string }
  | { readonly kind: 'broken'; readonly why: string }
  | { readonly kind: 'timeout' }

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** One `<calib> serve` process. */
class Worker {
  readonly child: ChildProcess | null
  readonly #options: CalibRunnerOptions
  #pending: { readonly id: string; readonly resolve: (a: Answer) => void; readonly timer: NodeJS.Timeout } | null = null
  #out: Buffer[] = []
  #outLength = 0
  #stderr = ''
  #gone: string | null = null
  #exited: Promise<void>
  #idle: NodeJS.Timeout | null = null
  /** The one stop under way (SIGTERM or the end of stdin, one SIGKILL timer); kill() and close() share it. */
  #stopping: Promise<void> | null = null
  #told = false
  readonly #onGone: (w: Worker) => void

  constructor(options: CalibRunnerOptions, onGone: (w: Worker) => void) {
    this.#options = options
    this.#onGone = onGone
    const [command, ...args] = options.calib
    let child: ChildProcess | null = null
    let markExited = (): void => undefined
    this.#exited = new Promise((resolve) => {
      markExited = resolve
    })
    try {
      if (command === undefined) throw new Error('empty command')
      child = spawn(command, [...args, 'serve'], { cwd: options.cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true })
    } catch (e) {
      this.#gone = "it couldn't be started (" + errorText(e) + ')'
      markExited()
    }
    this.child = child
    if (child === null) return
    child.on('error', (e) => {
      this.#lost("it couldn't be started (" + errorText(e) + ')')
      markExited()
    })
    // 'close', not 'exit': a last answer written just before it exits is read first.
    child.on('close', (code, signal) => {
      this.#logIdleDeath(signal ?? 'code ' + String(code))
      this.#lost('it exited (' + (signal ?? 'code ' + String(code)) + ')')
      markExited()
    })
    child.stdin?.on('error', () => {
      // EPIPE when it is gone: the exit decides what that means
    })
    child.stdout?.on('data', (chunk: Buffer) => {
      this.#read(chunk)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      this.#stderr += chunk.toString('utf8')
      if (this.#stderr.length > STDERR_KEEP) this.#stderr = this.#stderr.slice(-STDERR_KEEP)
    })
  }

  /** Why it can't be used any more, or null while it can. */
  get gone(): string | null {
    return this.#gone
  }

  /** The stop under way, or null: the runner waits for it before starting another worker. */
  get stopping(): Promise<void> | null {
    return this.#stopping
  }

  /** It died by itself with nothing in flight (no answer will say why): what it wrote goes to the log. */
  #logIdleDeath(how: string): void {
    if (this.#pending !== null || this.#gone !== null) return
    this.#options.log('midstudy server: the calibration worker exited while idle (' + how + '): ' + this.#stderr.slice(-4096).trim())
  }

  /** Tells the runner, once, that this worker can't be used any more. */
  #tell(): void {
    if (this.#told) return
    this.#told = true
    this.#onGone(this)
  }

  #lost(why: string): void {
    if (this.#gone === null) this.#gone = why
    this.#clearIdle()
    this.#settle({ kind: 'broken', why })
    this.#tell()
  }

  #settle(a: Answer): void {
    const p = this.#pending
    if (p === null) return
    this.#pending = null
    clearTimeout(p.timer)
    p.resolve(a)
  }

  #read(chunk: Buffer): void {
    let start = 0
    for (let at = chunk.indexOf(10); at >= 0; at = chunk.indexOf(10, start)) {
      this.#out.push(chunk.subarray(start, at))
      const line = Buffer.concat(this.#out).toString('utf8')
      this.#out = []
      this.#outLength = 0
      start = at + 1
      this.#line(line)
    }
    if (start < chunk.length) {
      this.#out.push(chunk.subarray(start))
      this.#outLength += chunk.length - start
      if (this.#outLength > MAX_LINE) {
        this.#out = []
        this.#outLength = 0
        this.#broke('its answer is longer than ' + String(MAX_LINE) + ' bytes')
      }
    }
  }

  #line(line: string): void {
    const p = this.#pending
    if (p === null) {
      if (this.#stopping !== null) return // its answer to our SIGTERM ("interrupted"), after the job has ended
      if (line.trim() !== '') this.#broke('it wrote to stdout with no request in flight')
      return
    }
    if (line.trim() === '') return
    const read = readWorkerLine(line, p.id)
    if (read.kind === 'garbled') {
      this.#broke(read.why)
      return
    }
    const result = Object.fromEntries(read.result)
    this.#settle({ kind: 'answer', ok: read.ok, line: result, raw: { id: p.id, ...result }, stderr: this.#stderr })
    this.#stderr = ''
    this.#armIdle()
  }

  /** The protocol broke: the request in flight (if any) gets `broken`, and the worker is killed. */
  #broke(why: string): void {
    if (this.#gone === null) this.#gone = why
    this.#settle({ kind: 'broken', why })
    void this.kill()
    this.#tell()
  }

  #clearIdle(): void {
    if (this.#idle !== null) clearTimeout(this.#idle)
    this.#idle = null
  }

  #armIdle(): void {
    this.#clearIdle()
    this.#idle = setTimeout(() => {
      if (this.#pending === null && this.#gone === null) {
        this.#gone = 'it was idle'
        void this.close()
        this.#tell()
      }
    }, this.#options.idleMs)
    this.#idle.unref()
  }

  /** Sends one request; resolves with its answer, `broken` (the worker failed: run the job one-shot) or `timeout`. */
  ask(req: CalibRequest, timeoutMs: number): Promise<Answer> {
    if (this.#gone !== null || this.child === null) return Promise.resolve({ kind: 'broken', why: this.#gone ?? "it couldn't be started" })
    this.#clearIdle()
    this.#stderr = ''
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#settle({ kind: 'timeout' })
      }, timeoutMs)
      this.#pending = { id: req.id, resolve, timer }
      const stdin = this.child?.stdin
      if (stdin === null || stdin === undefined || stdin.destroyed) {
        this.#lost('its stdin is closed')
        return
      }
      stdin.write(requestLine(req.id, req.cmd, req.args))
    })
  }

  #signal(sig: NodeJS.Signals): void {
    const pid = this.child?.pid
    if (pid === undefined) return
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        this.child?.kill(sig)
      } catch {
        // already gone
      }
    }
  }

  /** Whether its process is still there. */
  #running(): boolean {
    const c = this.child
    return c?.exitCode === null && c.signalCode === null
  }

  /** Starts the one stop: `begin`, then SIGKILL after the grace period; resolves when it has exited (or at the cap). */
  #stop(begin: () => void): Promise<void> {
    this.#clearIdle()
    this.#stopping ??= this.#stopped(begin)
    return this.#stopping
  }

  async #stopped(begin: () => void): Promise<void> {
    if (!this.#running()) return
    begin()
    const grace = this.#options.killGraceMs
    const timer = setTimeout(() => {
      this.#signal('SIGKILL')
    }, grace)
    let cap: NodeJS.Timeout | undefined
    await Promise.race([this.#exited, new Promise((resolve) => {
      cap = setTimeout(resolve, grace + CLOSE_CAP_MS)
    })])
    clearTimeout(timer)
    clearTimeout(cap)
  }

  /** SIGTERM to its process group, SIGKILL after the grace period; resolves when it has exited. */
  kill(): Promise<void> {
    if (this.#gone === null) this.#gone = 'it was stopped'
    return this.#stop(() => {
      this.#signal('SIGTERM')
    })
  }

  /** Closes its stdin (it exits when it has nothing in flight), then kills it after the grace period. */
  close(): Promise<void> {
    if (this.#gone === null) this.#gone = 'the server stopped'
    return this.#stop(() => {
      this.child?.stdin?.end()
    })
  }
}

/** Strict mode: `outcome` unless the JSON object `checkedLine` (the one-shot result line, or the worker's answer with
 *  its id) breaks contract/calib-cli.schema.json; a line that is no object is left to the job's own rules (v1's "no
 *  result line" and tool_error sentences). */
function checked(req: CalibRequest, checkedLine: unknown, outcome: CalibOutcome): CalibOutcome {
  if (!isRecord(checkedLine)) return outcome
  const v = conformance(calibResultSchema(req.cmd, checkedLine['ok'] === true), checkedLine, 'midstudy-calib ' + req.cmd + ' result (job ' + req.id + ')')
  return v === null ? outcome : { kind: 'violation', message: v.message + ' (' + v.detail + ')' }
}

/** Runs the calibration queue's steps: through the worker while it works, else one-shot. */
export class CalibRunner {
  readonly #options: CalibRunnerOptions
  #worker: Worker | null = null
  #failures = 0
  #closing = false
  /** Workers being stopped apart from a job (idle, or broken while idle), each until it has exited. */
  readonly #retiring = new Map<Worker, Promise<void>>()
  /** The one-shot runs in flight, each with its run's end, for shutdown. */
  readonly #oneShots = new Map<AbortController, Promise<unknown>>()

  constructor(options: CalibRunnerOptions) {
    this.#options = options
  }

  /** Whether jobs still go to the worker (false after 3 failures in a row, or once the server stops). */
  get usesWorker(): boolean {
    return workerUsable(this.#failures) && !this.#closing
  }

  /** The one-shot command: `<calib> <cmd> <args>`, stdin closed, the job's timeout (v1's subprocess.run). */
  async oneShot(req: CalibRequest): Promise<CalibOutcome> {
    const abort = new AbortController()
    const running = runTool([...this.#options.calib, req.cmd, ...req.args], { cwd: this.#options.cwd, timeoutMs: this.#options.timeoutMs, signal: abort.signal, killGraceMs: this.#options.killGraceMs })
    this.#oneShots.set(abort, running)
    const run = await running
    this.#oneShots.delete(abort)
    if (abort.signal.aborted) return { kind: 'stopped' }
    switch (run.kind) {
      case 'exited': {
        const line = lastJsonLine(run.stdout)
        return checked(req, line, { kind: 'result', returnCode: run.returnCode, line, stderr: run.stderr })
      }
      case 'not-found': return { kind: 'not-found', command: run.command }
      case 'timeout': return { kind: 'timeout' }
      case 'spawn-error': return { kind: 'spawn-error', message: run.message }
    }
  }

  /** One job's step. */
  async run(req: CalibRequest): Promise<CalibOutcome> {
    if (this.#stopped()) return { kind: 'stopped' }
    if (this.#retiring.size > 0) {
      await Promise.all(this.#retiring.values()) // one model at a time
      if (this.#stopped()) return { kind: 'stopped' }
    }
    if (!this.usesWorker) return this.oneShot(req)
    let worker = this.#worker
    if (worker?.gone !== null) {
      worker = new Worker(this.#options, (w) => {
        this.#dropped(w)
      })
      this.#worker = worker.gone === null ? worker : null
    }
    const answer = await worker.ask(req, this.#options.timeoutMs)
    if (answer.kind === 'answer') {
      if (this.#stopped() && answer.line['error'] === INTERRUPTED) return { kind: 'stopped' }
      this.#failures = failuresAfter(this.#failures, 'answered')
      return checked(req, answer.raw, { kind: 'result', returnCode: answer.ok ? 0 : 1, line: answer.line, stderr: answer.stderr })
    }
    if (this.#worker === worker) this.#worker = null
    await worker.kill()
    if (this.#stopped()) return { kind: 'stopped' } // no one-shot run that would outlive the server
    if (answer.kind === 'timeout') {
      this.#failures = failuresAfter(this.#failures, 'timeout')
      return { kind: 'timeout' }
    }
    this.#failures = failuresAfter(this.#failures, 'failed')
    const argv = [...this.#options.calib, 'serve'].join(' ')
    const givenUp = !workerUsable(this.#failures)
    this.#options.log('midstudy server: the calibration worker (' + argv + ') failed: ' + answer.why + '; job ' + req.id + ' runs one-shot'
      + (givenUp ? ' (' + String(this.#failures) + ' failures in a row: one-shot from now on)' : ''))
    return this.oneShot(req)
  }

  /** Whether shutdown has begun (a method: it changes across the awaits in run()). */
  #stopped(): boolean {
    return this.#closing
  }

  /** A worker said it can't be used any more; one being stopped is waited for before the next starts. */
  #dropped(w: Worker): void {
    if (this.#worker === w) this.#worker = null
    const stopping = w.stopping
    if (stopping === null) return
    this.#retiring.set(w, stopping)
    void stopping.then(() => {
      this.#retiring.delete(w)
    })
  }

  /** On shutdown: nothing new starts; the workers' stdin closed, then killed after the grace period; one-shot runs ended. */
  async shutdown(): Promise<void> {
    this.#closing = true
    const workers = [...this.#retiring.keys()]
    if (this.#worker !== null) workers.push(this.#worker)
    this.#worker = null
    for (const abort of this.#oneShots.keys()) abort.abort()
    await Promise.all([...workers.map((w) => w.close()), ...this.#oneShots.values()])
  }
}
