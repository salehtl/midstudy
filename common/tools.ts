// Running a tool (the server runs midstudy-calib and midstudy-add; contract §2.8, §4.3, §4.4): a command line is split
// once like a shell would (shlex), and always run as an argument list, never through a shell; nothing a client sends
// becomes part of a command except paths the server made and values passed as `--opt=<v>`. As v1's
// `subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=…, stdin=DEVNULL)`, with the timeout killing
// the tool's whole process group (v1 killed only the direct child): SIGTERM first, SIGKILL after 5 s (the worker's
// rule, contract §4.3 Crash), and the run settles once the tool has exited, as v1's subprocess.run killed the child
// and then waited on it. Every live tool is tracked: killAllTools() ends them all at the server's stop and latches
// (nothing is spawned after it), and an 'exit' handler SIGKILLs any group still live, so no tool outlives the server.
// The calibration worker (server/src/scenes/calib.ts) keeps its own long-lived process and uses this for its one-shot
// fallback.
import { spawn, type ChildProcess } from 'node:child_process'
import os from 'node:os'
import { shlexSplit } from './logic/shlex.ts'
import { pyReturnCode } from './logic/tool.ts'

export { addError, addMessage, lastJsonLine, outputLines, summaryOf, toolError } from './logic/tool.ts'

/** A command line split as v1's `shlex.split`, or the sentence Python's ValueError said. */
export function splitCommand(text: string): { readonly ok: true; readonly argv: readonly string[] } | { readonly ok: false; readonly error: string } {
  const r = shlexSplit(text)
  return r.ok ? { ok: true, argv: r.value } : { ok: false, error: r.error }
}

/** What running a tool came to. */
export type ToolRun =
  /** It ran and exited (or was killed by a signal, an abort's included): `returnCode` as Python reports it. */
  | { readonly kind: 'exited'; readonly returnCode: number; readonly stdout: string; readonly stderr: string }
  /** The executable wasn't found (v1's FileNotFoundError: "… isn't installed here (<argv0> not found)"). */
  | { readonly kind: 'not-found'; readonly command: string }
  /** It ran past the timeout and was ended (v1's TimeoutExpired); resolved once it has exited. */
  | { readonly kind: 'timeout'; readonly stdout: string; readonly stderr: string }
  /** It couldn't be started for another reason (permissions, a bad working directory, the server stopping), or it
   *  failed after it started (then it was ended first). */
  | { readonly kind: 'spawn-error'; readonly message: string }

/** How to run a tool. */
export interface ToolOptions {
  /** The working directory (v1: the repository). */
  readonly cwd: string
  readonly timeoutMs: number
  readonly env?: NodeJS.ProcessEnv
  /** The most of each stream kept (the end is kept). Default 64 MiB. */
  readonly maxOutput?: number
  /** Aborting ends the run (SIGTERM to the tool's group, SIGKILL after the grace), which then resolves as the
   *  'exited' it really is (returnCode -15, or -9 after SIGKILL); the caller knows it asked from `signal.aborted`.
   *  Already aborted: nothing is spawned ('spawn-error'). */
  readonly signal?: AbortSignal
  /** How long a tool has between SIGTERM and SIGKILL. Default 5 s. */
  readonly killGraceMs?: number
}

/** SIGTERM to SIGKILL: the calibration worker's rule (contract §4.3 Crash), for every tool. */
const KILL_GRACE_MS = 5000
/** After the SIGKILL, how long a run waits for 'close' before it settles anyway (a grandchild that left the group
 *  can hold the pipes open). */
const CLOSE_CAP_MS = 5000

/** Every tool spawned and not yet 'close'd, with a promise that resolves on its 'close'. */
const live = new Map<ChildProcess, Promise<void>>()
/** Set by killAllTools: no tool is spawned after it. */
let stopping = false
let exitHooked = false

/** `sig` to the tool's whole process group (it was spawned detached), else to the tool alone. */
function signalGroup(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    process.kill(-pid, sig)
  } catch {
    try {
      child.kill(sig)
    } catch {
      // already gone
    }
  }
}

/** SIGTERM to the group, SIGKILL after `graceMs` unless it has closed; resolves on its 'close', or at `capMs`. */
function killGroup(child: ChildProcess, closed: Promise<void>, graceMs: number, capMs: number): Promise<void> {
  signalGroup(child, 'SIGTERM')
  return new Promise((resolve) => {
    let ended = false
    const end = (): void => {
      if (ended) return
      ended = true
      clearTimeout(kill)
      clearTimeout(cap)
      resolve()
    }
    const kill = setTimeout(() => {
      signalGroup(child, 'SIGKILL')
    }, graceMs)
    const cap = setTimeout(end, capMs)
    void closed.then(end)
  })
}

/** Ends every running tool (SIGTERM to each group, SIGKILL after `graceMs`) and latches: every later runTool resolves
 *  {kind: 'spawn-error', message: 'the server is stopping'} without spawning. Resolves when they have all closed, at
 *  most `graceMs` + 1 s from now. For the server's stop. */
export function killAllTools(graceMs = KILL_GRACE_MS): Promise<void> {
  stopping = true
  return Promise.all([...live].map(([child, closed]) => killGroup(child, closed, graceMs, graceMs + 1000))).then(() => undefined)
}

/** The pids of the tools still running (the server's stop names them when it gives up waiting). */
export function liveToolPids(): number[] {
  return [...live.keys()].flatMap((c) => (c.pid === undefined ? [] : [c.pid]))
}

/** On every exit, the forced one included: SIGKILL each group still live (synchronous, as an 'exit' handler is). */
function hookExit(): void {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    for (const child of live.keys()) signalGroup(child, 'SIGKILL')
  })
}

function signalNumber(signal: NodeJS.Signals | null): number | null {
  if (signal === null) return null
  const n: unknown = Reflect.get(os.constants.signals, signal)
  return typeof n === 'number' ? n : null
}

function errorCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

/** Runs `argv` (no shell), stdin closed, stdout and stderr captured as UTF-8; resolves once it has exited ('close'),
 *  on its own or after the timeout or the signal ended its process group (SIGTERM, SIGKILL after the grace; settled
 *  at the latest 5 s after the SIGKILL). Never rejects. */
export function runTool(argv: readonly string[], options: ToolOptions): Promise<ToolRun> {
  const [command, ...args] = argv
  if (command === undefined) return Promise.resolve({ kind: 'spawn-error', message: 'empty command' })
  if (stopping) return Promise.resolve({ kind: 'spawn-error', message: 'the server is stopping' })
  const signal = options.signal
  if (signal?.aborted === true) return Promise.resolve({ kind: 'spawn-error', message: 'the run was cancelled before it started' })
  const max = options.maxOutput ?? 64 * 1024 * 1024
  const grace = options.killGraceMs ?? KILL_GRACE_MS
  return new Promise((resolve) => {
    let settled = false
    /** Set when we end the tool for a reason of our own: its 'close' then settles as that, not as 'exited'. */
    let ending: 'timeout' | 'error' | 'abort' | null = null
    /** What 'exit' said, for an aborted run that settles at the cap before 'close'. */
    let exitStatus: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | null = null
    const out: Buffer[] = []
    const err: Buffer[] = []
    let outLength = 0
    let errLength = 0
    const keep = (list: Buffer[], chunk: Buffer, length: number): number => {
      list.push(chunk)
      let total = length + chunk.length
      while (total > max && list.length > 1) total -= list.shift()?.length ?? 0
      return total
    }
    const text = (list: readonly Buffer[]): string => Buffer.concat(list).toString('utf8')
    const exited = (code: number | null, sig: NodeJS.Signals | null): ToolRun => ({ kind: 'exited', returnCode: pyReturnCode(code, signalNumber(sig)), stdout: text(out), stderr: text(err) })
    let child: ChildProcess
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })
    } catch (e) {
      resolve({ kind: 'spawn-error', message: e instanceof Error ? e.message : String(e) })
      return
    }
    let markClosed: () => void = () => undefined
    const closed = new Promise<void>((r) => {
      markClosed = r
    })
    /** Ends the tool for `why`, then settles with `then()` (on 'close', or at the cap). */
    const end = (why: 'timeout' | 'error' | 'abort', then: () => ToolRun): void => {
      if (child.pid === undefined || ending !== null || settled) return
      ending = why
      void killGroup(child, closed, grace, grace + CLOSE_CAP_MS).then(() => {
        done(then())
      })
    }
    const onAbort = (): void => {
      end('abort', () => (exitStatus === null ? exited(null, 'SIGKILL') : exited(exitStatus.code, exitStatus.signal)))
    }
    const done = (r: ToolRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(r)
    }
    if (child.pid !== undefined) {
      live.set(child, closed)
      hookExit()
    }
    const timer = setTimeout(() => {
      end('timeout', () => ({ kind: 'timeout', stdout: text(out), stderr: text(err) }))
    }, options.timeoutMs)
    signal?.addEventListener('abort', onAbort, { once: true })
    child.stdout?.on('data', (c: Buffer) => {
      outLength = keep(out, c, outLength)
    })
    child.stderr?.on('data', (c: Buffer) => {
      errLength = keep(err, c, errLength)
    })
    child.on('error', (e) => {
      if (child.pid === undefined) {
        if (errorCode(e) === 'ENOENT') done({ kind: 'not-found', command })
        else done({ kind: 'spawn-error', message: e.message })
        return
      }
      // An error after a successful spawn: the tool is ended before the run settles, never left running.
      end('error', () => ({ kind: 'spawn-error', message: e.message }))
    })
    child.on('exit', (code, sig) => {
      exitStatus = { code, signal: sig }
    })
    child.on('close', (code, sig) => {
      live.delete(child)
      markClosed()
      if (ending === null || ending === 'abort') done(exited(code, sig))
    })
  })
}
