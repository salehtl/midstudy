// The tools the server runs (midstudy-calib, midstudy-add; contract §2.8, §4.3, §4.4): --calib and --midstudy-add are
// split once at startup like a shell would (shlex), and always run as an argument list, never through a shell;
// nothing a client sends becomes part of a command except paths the server made and values passed as `--opt=<v>`.
// As v1's `subprocess.run(cmd, cwd=REPO, capture_output=True, text=True, timeout=…, stdin=DEVNULL)`, with the
// timeout killing the tool's whole process group (v1 killed only the direct child).
import { spawn } from 'node:child_process'
import os from 'node:os'
import { shlexSplit } from '../../common/logic/shlex.ts'
import { pyReturnCode } from '../../common/logic/tool.ts'

export { addError, addMessage, lastJsonLine, outputLines, summaryOf, toolError } from '../../common/logic/tool.ts'

/** A command line split as v1's `shlex.split`, or the sentence Python's ValueError said. */
export function splitCommand(text: string): { readonly ok: true; readonly argv: readonly string[] } | { readonly ok: false; readonly error: string } {
  const r = shlexSplit(text)
  return r.ok ? { ok: true, argv: r.value } : { ok: false, error: r.error }
}

/** What running a tool came to. */
export type ToolRun =
  /** It ran and exited (or was killed by a signal it didn't get from us): `returnCode` as Python reports it. */
  | { readonly kind: 'exited'; readonly returnCode: number; readonly stdout: string; readonly stderr: string }
  /** The executable wasn't found (v1's FileNotFoundError: "… isn't installed here (<argv0> not found)"). */
  | { readonly kind: 'not-found'; readonly command: string }
  /** It ran past the timeout and was killed (v1's TimeoutExpired). */
  | { readonly kind: 'timeout'; readonly stdout: string; readonly stderr: string }
  /** It couldn't be started for another reason (permissions, a bad working directory). */
  | { readonly kind: 'spawn-error'; readonly message: string }

/** How to run a tool. */
export interface ToolOptions {
  /** The working directory (v1: the repository). */
  readonly cwd: string
  readonly timeoutMs: number
  readonly env?: NodeJS.ProcessEnv
  /** The most of each stream kept (the end is kept). Default 64 MiB. */
  readonly maxOutput?: number
}

function signalNumber(signal: NodeJS.Signals | null): number | null {
  if (signal === null) return null
  const n: unknown = Reflect.get(os.constants.signals, signal)
  return typeof n === 'number' ? n : null
}

function errorCode(e: unknown): string {
  return e instanceof Error && 'code' in e && typeof e.code === 'string' ? e.code : ''
}

/** Runs `argv` (no shell), stdin closed, stdout and stderr captured as UTF-8; resolves when it exits or the timeout
 *  kills its process group. Never rejects. */
export function runTool(argv: readonly string[], options: ToolOptions): Promise<ToolRun> {
  const [command, ...args] = argv
  if (command === undefined) return Promise.resolve({ kind: 'spawn-error', message: 'empty command' })
  const max = options.maxOutput ?? 64 * 1024 * 1024
  return new Promise((resolve) => {
    let settled = false
    const done = (r: ToolRun): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
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
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'], detached: true, shell: false })
    } catch (e) {
      resolve({ kind: 'spawn-error', message: e instanceof Error ? e.message : String(e) })
      return
    }
    const timer = setTimeout(() => {
      if (child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGKILL')
        } catch {
          child.kill('SIGKILL')
        }
      }
      done({ kind: 'timeout', stdout: text(out), stderr: text(err) })
    }, options.timeoutMs)
    child.stdout?.on('data', (c: Buffer) => {
      outLength = keep(out, c, outLength)
    })
    child.stderr?.on('data', (c: Buffer) => {
      errLength = keep(err, c, errLength)
    })
    child.on('error', (e) => {
      const code = errorCode(e)
      if (code === 'ENOENT') done({ kind: 'not-found', command })
      else done({ kind: 'spawn-error', message: e.message })
    })
    child.on('close', (code, signal) => {
      done({ kind: 'exited', returnCode: pyReturnCode(code, signalNumber(signal)), stdout: text(out), stderr: text(err) })
    })
  })
}
