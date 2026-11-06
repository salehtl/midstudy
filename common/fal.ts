// fal (contract §2.6, §3.3), shared by the server and midstudy-add: the key, mock mode and its flags, the request log,
// the server's one synchronous call `https://fal.run/<endpoint>` (v1 serve.py's `fal_call`) and the download of a
// result URL. midstudy-add's queue client (fal-client's protocol: uploads, submit, status polls) and its mock replay
// are pipeline/src/fal.ts, on top of these.
//
// Money and secrets: FAL_KEY comes from the environment, else from `<repo>/.env` unless MIDSTUDY_NO_DOTENV is set;
// it is never logged or answered. With MIDSTUDY_FAL_MOCK=<dir> nothing reaches the network. MIDSTUDY_FAL_MOCK_LOG=<file>
// (evals) records every upload, call and fetch either tool makes or, under the mock, would make: one JSON line each.
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { dotenvValue, flagOn, mockOn } from './logic/env.ts'
import { jsonLine, type JsonLineValue } from './logic/jsonline.ts'

export { mockSlug } from './logic/env.ts'

/** @public v1's sentence when a paid call needs a key and there is none (503). */
export const NO_KEY = 'FAL_KEY not set: add FAL_KEY=... to midstudy/.env'
/** v1's FAL_TIMEOUT: a synchronous call may take 300 s. */
const FAL_TIMEOUT_MS = 300 * 1000

/** A failed fal call, with the sentence v1 answered (502). */
export class FalError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FalError'
  }
}

/** MIDSTUDY_FAL_MOCK is set: no network calls to fal. */
export function falMock(env: NodeJS.ProcessEnv = process.env): boolean {
  return mockOn(env['MIDSTUDY_FAL_MOCK'])
}

/** The mock folder (MIDSTUDY_FAL_MOCK, as given: relative to the working directory), or null. */
export function falMockDir(env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = env['MIDSTUDY_FAL_MOCK']
  return dir !== undefined && dir !== '' ? dir : null
}

/** MIDSTUDY_FAL_MOCK_COST=1 (evals only): mock calls count at their real price, so the cap can be tested for $0. */
export function mockCost(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env['MIDSTUDY_FAL_MOCK_COST'])
}

/** Live calls count against the daily cap; mock calls count for nothing unless MIDSTUDY_FAL_MOCK_COST=1. */
export function countsAgainstCap(env: NodeJS.ProcessEnv = process.env): boolean {
  return !falMock(env) || mockCost(env)
}

/** v1 `fal_key`: FAL_KEY from the environment, else the first non-empty FAL_KEY line of `<repo>/.env` (unless
 *  MIDSTUDY_NO_DOTENV is on), else null. Never logged. */
export function falKey(repo: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const fromEnv = env['FAL_KEY']
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv
  if (flagOn(env['MIDSTUDY_NO_DOTENV'])) return null
  let text: string
  try {
    text = fs.readFileSync(path.join(repo, '.env'), 'utf8')
  } catch {
    return null
  }
  return dotenvValue(text, 'FAL_KEY')
}

/** One line of the request log (MIDSTUDY_FAL_MOCK_LOG): what was (or, under the mock, would have been) sent, in the
 *  layout v1's tools wrote (Python's `json.dumps`), so a v1 run and a v2 run on the same inputs can be diffed. */
export type FalLogRecord =
  /** A file sent to fal's storage (midstudy-add's engine input or mask): its name, type, size and digest. */
  | { readonly op: 'upload'; readonly file: string; readonly content_type: string; readonly bytes: number; readonly sha256: string; readonly url: string }
  /** An endpoint called (the queue for midstudy-add, fal.run for the server) with its exact arguments. */
  | { readonly op: 'call'; readonly endpoint: string; readonly url: string; readonly args: JsonLineValue }
  /** A result file fetched, and the name it was saved as. */
  | { readonly op: 'fetch'; readonly url: string; readonly file: string }

/** Appends `record` to MIDSTUDY_FAL_MOCK_LOG when it is set (evals only; never holds the key). */
export function logFal(record: FalLogRecord, env: NodeJS.ProcessEnv = process.env): void {
  const log = env['MIDSTUDY_FAL_MOCK_LOG']
  if (log === undefined || log === '') return
  fs.appendFileSync(log, jsonLine(record) + '\n', 'utf8')
}

/** The upload record of `bytes` sent as `file` (its base name is logged). */
export function uploadRecord(file: string, bytes: Uint8Array, contentType: string, url: string): FalLogRecord {
  return { op: 'upload', file: path.basename(file), content_type: contentType, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url }
}

/** v1's synchronous endpoint URL (`https://fal.run/<endpoint>`, serve.py's `fal_call`). */
export function falRunUrl(endpoint: string): string {
  return 'https://fal.run/' + endpoint
}

/** The queue URL fal-client submits to (`https://queue.fal.run/<endpoint>`; FAL_RUN_HOST and FAL_QUEUE_RUN_HOST as
 *  fal-client reads them), midstudy-add's. */
export function falQueueUrl(endpoint: string, env: NodeJS.ProcessEnv = process.env): string {
  const run = env['FAL_RUN_HOST'] ?? 'fal.run'
  return 'https://' + (env['FAL_QUEUE_RUN_HOST'] ?? 'queue.' + run) + '/' + endpoint
}

/** How falCall reaches fal (tests point it at a local server; nothing in the environment can). */
export interface FalCallOptions {
  readonly timeoutMs?: number
  readonly baseUrl?: string
}

function causeText(e: unknown): string {
  if (e instanceof Error) {
    const cause: unknown = e.cause
    if (cause instanceof Error) return cause.message
    return e.message
  }
  return String(e)
}

/** v1 `fal_call`: POST `https://fal.run/<endpoint>` with the JSON arguments and `Authorization: Key <key>`; the JSON
 *  answer, or FalError with v1's sentences (an HTTP error with the first 400 bytes of its body; nano-banana's
 *  occasional 422 "did not generate the expected output" as "returned no image this time"; unreachable; not JSON).
 *  The call goes to the request log first. */
export async function falCall(endpoint: string, args: JsonLineValue, key: string, options: FalCallOptions = {}): Promise<unknown> {
  const url = (options.baseUrl ?? 'https://fal.run') + '/' + endpoint
  logFal({ op: 'call', endpoint, url, args })
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: 'Key ' + key, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(args),
      signal: AbortSignal.timeout(options.timeoutMs ?? FAL_TIMEOUT_MS),
    })
  } catch (e) {
    throw new FalError('could not reach fal (' + endpoint + '): ' + causeText(e))
  }
  let body: Uint8Array
  try {
    body = new Uint8Array(await res.arrayBuffer())
  } catch (e) {
    throw new FalError('could not reach fal (' + endpoint + '): ' + causeText(e))
  }
  if (!res.ok) {
    const detail = new TextDecoder('utf-8', { fatal: false }).decode(body.subarray(0, 400))
    if (res.status === 422 && detail.includes('did not generate the expected output')) {
      throw new FalError(endpoint + ' returned no image this time. Try the render again.')
    }
    throw new FalError('fal ' + endpoint + ' returned HTTP ' + String(res.status) + ': ' + detail)
  }
  try {
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body))
    return value
  } catch (e) {
    throw new FalError('fal ' + endpoint + " returned something that isn't JSON (" + (e instanceof Error ? e.message : String(e)) + ')')
  }
}

/** How a download is made: v1's server sent `User-Agent: midstudy` with 120 s, midstudy-add `midstudy-add/0.1` with
 *  300 s. Tests pass a fetch of their own. */
export interface DownloadOptions {
  readonly userAgent?: string
  readonly timeoutMs?: number
  readonly fetchFn?: (url: string, init: RequestInit) => Promise<Response>
}

/** urllib's HTTPError for a download that wasn't 2xx (`HTTP Error 404: Not Found`). */
class HTTPError extends Error {
  constructor(status: number, reason: string) {
    super('HTTP Error ' + String(status) + ': ' + reason)
    this.name = 'HTTPError'
  }
}

/** v1 `download` (both tools): a `data:` URI's base64, else a GET following redirects; a status that isn't 2xx throws
 *  HTTPError. For a result URL fal itself returned (and midstudy-add's URL input). */
export async function download(url: string, options: DownloadOptions = {}): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    return new Uint8Array(Buffer.from(url.slice(comma + 1), 'base64'))
  }
  const fetchFn = options.fetchFn ?? fetch
  const res = await fetchFn(url, {
    headers: { 'User-Agent': options.userAgent ?? 'midstudy' },
    redirect: 'follow',
    signal: AbortSignal.timeout(options.timeoutMs ?? 120 * 1000),
  })
  if (!res.ok) throw new HTTPError(res.status, res.statusText)
  return new Uint8Array(await res.arrayBuffer())
}
