// fal (contract §2.6, §3.3): the key, mock mode, and the one synchronous call `https://fal.run/<endpoint>`, as v1's
// serve.py (`fal_key`, `fal_mock`, `mock_cost`, `counts_against_cap`, `fal_call`, `download`) and midstudy-add read
// them. Shared by the server and midstudy-add.
//
// Money and secrets: FAL_KEY comes from the environment, else from `<repo>/.env` unless MIDSTUDY_NO_DOTENV is set;
// it is never logged or answered. With MIDSTUDY_FAL_MOCK=<dir> nothing reaches the network: a mock answer is a file
// under <dir> (or, for a render, the input itself), and MIDSTUDY_FAL_MOCK_LOG=<file> records each call's arguments.
import fs from 'node:fs'
import path from 'node:path'
import { dotenvValue, flagOn, mockOn, mockSlug } from './logic/env.ts'

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

/** MIDSTUDY_FAL_MOCK_LOG=<file> (evals only): in mock mode, one JSON line per call with the endpoint and the exact
 *  arguments that would have been sent (v1's product reader wrote `{"endpoint", "args"}`). */
export function logMockCall(endpoint: string, args: unknown, env: NodeJS.ProcessEnv = process.env): void {
  const log = env['MIDSTUDY_FAL_MOCK_LOG']
  if (log === undefined || log === '') return
  fs.appendFileSync(log, JSON.stringify({ endpoint, args }) + '\n', 'utf8')
}

/** A mock answer file: `<mock dir>/<endpoint slug>/<name>` parsed as JSON (contract §3.3: `response.json`; the product
 *  reader's `<page slug>.json`). Null when the file is missing; throws FalError when it isn't JSON. */
export function readMockAnswer(endpoint: string, name = 'response.json', env: NodeJS.ProcessEnv = process.env): unknown {
  const dir = falMockDir(env)
  if (dir === null) throw new FalError('MIDSTUDY_FAL_MOCK is not set')
  const file = path.join(dir, mockSlug(endpoint), name)
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch (e) {
    throw new FalError('fal ' + endpoint + " mock answer isn't JSON (" + (e instanceof Error ? e.message : String(e)) + ')')
  }
}

/** @public The mock copy of a file a mock answer links (contract §3.3): `<mock dir>/<endpoint slug>/files/<name>`, the
 *  name being the URL path's last segment as fixtures/capture_fal.py saved it, else its percent-decoded spelling (v1
 *  midstudy-add's MockFal.fetch); null when neither exists. */
export function mockFilePath(endpoint: string, url: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const dir = falMockDir(env)
  if (dir === null) return null
  let raw: string
  try {
    raw = path.posix.basename(new URL(url).pathname)
  } catch {
    return null
  }
  let decoded = raw
  try {
    decoded = decodeURIComponent(raw)
  } catch {
    // keep the spelling as sent
  }
  const files = path.join(dir, mockSlug(endpoint), 'files')
  for (const name of [raw, decoded === '' ? 'download' : decoded]) {
    const candidate = path.join(files, name)
    if (name !== '' && fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate
  }
  return null
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
 *  occasional 422 "did not generate the expected output" as "returned no image this time"; unreachable; not JSON). */
export async function falCall(endpoint: string, args: unknown, key: string, options: FalCallOptions = {}): Promise<unknown> {
  const url = (options.baseUrl ?? 'https://fal.run') + '/' + endpoint
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

/** v1 `download`: a `data:` URI's base64, else a GET (`User-Agent: midstudy`, 120 s); an HTTP error throws. For a
 *  result URL fal itself returned. */
export async function download(url: string, timeoutMs = 120 * 1000): Promise<Uint8Array> {
  if (url.startsWith('data:')) {
    const comma = url.indexOf(',')
    return new Uint8Array(Buffer.from(url.slice(comma + 1), 'base64'))
  }
  const res = await fetch(url, { headers: { 'User-Agent': 'midstudy' }, signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error('HTTP Error ' + String(res.status) + ': ' + res.statusText)
  return new Uint8Array(await res.arrayBuffer())
}
