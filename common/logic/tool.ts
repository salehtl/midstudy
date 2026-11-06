// What the server reads from the tools it runs (contract §3.1, §4.3): the last stdout line as JSON, and the one
// sentence of a failure, worded as v1 (planner/serve.py `last_json_line`, `tool_error`, LibraryService.run). Pure
// (TScert); the shell (server/src/tools.ts) runs the process.
import { pySplitlines, pyStrip } from './pyfmt.ts'

/** v1's `last_json_line`: the last non-empty stdout line parsed as JSON; null when there is none or it isn't JSON
 *  (also for a JSON `null`, as in v1; callers check for an object). Earlier lines are never tried. */
export function lastJsonLine(text: string): unknown {
  const lines = pySplitlines(text).map(pyStrip).filter((l) => l !== '')
  const last = lines.at(-1)
  if (last === undefined) return null
  try {
    const value: unknown = JSON.parse(last)
    return value
  } catch {
    return null
  }
}

/** The exit status as Python's `returncode` reports it: the code, or minus the signal number. */
export function pyReturnCode(code: number | null, signalNumber: number | null): number {
  if (code !== null) return code
  return signalNumber === null ? -1 : -signalNumber
}

/** v1's `tool_error` (midstudy-calib): the JSON result's non-empty `error` (trimmed), else the last
 *  `midstudy-calib: …` stderr line without its prefix, else the last non-empty stderr line, else
 *  `<tool> exited with code <n>`. `error` is the result's `error` field (undefined without one). */
export function toolError(error: unknown, stderr: string, returnCode: number, tool: string): string {
  if (typeof error === 'string' && pyStrip(error) !== '') return pyStrip(error)
  const err = pySplitlines(stderr).map(pyStrip).filter((l) => l !== '')
  const mine = err.filter((l) => l.startsWith('midstudy-calib:')).map((l) => pyStrip(l.slice('midstudy-calib:'.length)))
  const pick = mine.length > 0 ? mine : err.length > 0 ? err : [tool + ' exited with code ' + String(returnCode)]
  return pick.at(-1) ?? ''
}

/** A failed midstudy-add's job message (v1 LibraryService.run): its last `midstudy-add: …` stderr line (prefix kept),
 *  else its last non-empty stderr line, else `midstudy-add exited with code <n>`. */
export function addError(stderr: string, returnCode: number): string {
  const err = pySplitlines(stderr).map(pyStrip).filter((l) => l !== '')
  const mine = err.filter((l) => l.startsWith('midstudy-add:'))
  const pick = mine.length > 0 ? mine : err.length > 0 ? err : ['midstudy-add exited with code ' + String(returnCode)]
  return pick.at(-1) ?? ''
}

/** midstudy-add's non-empty stdout lines, unstripped (`[ln for ln in stdout.splitlines() if ln.strip()]`). */
export function outputLines(stdout: string): string[] {
  return pySplitlines(stdout).filter((l) => pyStrip(l) !== '')
}

/** midstudy-add's summary: its last non-empty stdout line parsed as JSON, or undefined when there is no line or it
 *  isn't JSON (v1: "midstudy-add finished without its JSON summary line"). */
export function summaryOf(lines: readonly string[]): unknown {
  const last = lines.at(-1)
  if (last === undefined) return undefined
  try {
    const value: unknown = JSON.parse(last)
    return value
  } catch {
    return undefined
  }
}

/** The job message of a successful add: the `replaced existing item` line without its `midstudy-add: ` prefix, else
 *  `added <id>`; a rescale says `refit <id> ($0)`. */
export function addMessage(lines: readonly string[], kind: 'add' | 'rescale', itemId: string): string {
  if (kind === 'rescale') return 'refit ' + itemId + ' ($0)'
  const replaced = lines.find((l) => l.includes('replaced existing item'))
  if (replaced === undefined) return 'added ' + itemId
  return replaced.startsWith('midstudy-add: ') ? replaced.slice('midstudy-add: '.length) : replaced
}
