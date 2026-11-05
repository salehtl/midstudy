// The calibration worker's protocol, the server's side (contract §4.3 Worker): what a response line means and when
// the server gives up on the worker. Pure (TScert); server/src/scenes/calib.ts runs the process.
//
// A request is one JSON line `{"id", "cmd", "args"}`; the response is `{"id": <the request's>, …}`, the rest being
// exactly the one-shot command's last stdout line. Anything else (not JSON, not an object, another id) means the
// worker is broken: it is killed and that job runs one-shot. After 3 such failures in a row the server uses the
// one-shot command for the rest of its life. An `ok: false` answer is the job's failure, not the worker's.
import { isRecord } from './values.ts'

/** What one stdout line of the worker says about the request in flight. */
export type WorkerLine =
  /** The answer: the one-shot result line (the response without its `id`) and whether it says `ok: true`. */
  | { readonly kind: 'answer'; readonly ok: boolean; readonly result: readonly (readonly [string, unknown])[] }
  /** Not an answer to this request: the worker is broken. */
  | { readonly kind: 'garbled'; readonly why: string }

/** Reads one response line (without its newline) for the request `id`. */
export function readWorkerLine(line: string, id: string): WorkerLine {
  let value: unknown
  try {
    value = JSON.parse(line)
  } catch {
    return { kind: 'garbled', why: "its answer isn't JSON" }
  }
  if (!isRecord(value)) return { kind: 'garbled', why: "its answer isn't a JSON object" }
  if (value['id'] !== id) return { kind: 'garbled', why: "its answer doesn't carry the request's id" }
  const result = Object.entries(value).filter(([k]) => k !== 'id')
  return { kind: 'answer', ok: value['ok'] === true, result }
}

/** One request line: `{"id", "cmd", "args"}` and a newline. */
export function requestLine(id: string, cmd: string, args: readonly string[]): string {
  return JSON.stringify({ id, cmd, args }) + '\n'
}

/** How many worker failures in a row make the server stop using it. */
export const MAX_WORKER_FAILURES = 3

/** The failures in a row after one more (`failed`) or after an answer (`answered`: the count starts again). A timeout
 *  is neither: the job fails, the worker is replaced, the count stays. */
export function failuresAfter(failures: number, event: 'failed' | 'answered' | 'timeout'): number {
  if (event === 'answered') return 0
  if (event === 'failed') return failures + 1
  return failures
}

/** Whether the server should still use the worker after `failures` failures in a row. */
export function workerUsable(failures: number): boolean {
  return failures < MAX_WORKER_FAILURES
}
