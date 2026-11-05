// The fal engines (contract §3.2) and the MIDSTUDY_FAL_MOCK replay (§3.3), as v1's engines.py ran them. The live
// client speaks fal-client 1.0.3's protocol exactly (what v1's `fal_client.upload_file` and `fal_client.subscribe`
// send: the CDN v3 upload with its storage fallback, the queue's submit, status polls with logs, the result, retries
// and backup domains). With MIDSTUDY_FAL_MOCK_LOG=<file>, every upload, call and fetch is appended there as one JSON
// line, the same lines v1 writes through pipeline/test/v1_mock_log.py, so the two can be diffed.
import { createHash, randomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { MidstudyError, NoMasks, UnexpectedError } from './errors.ts'
import { copy2, isFile } from './fsx.ts'
import { out } from './io.ts'
import { foregroundMask } from './images.ts'
import { type FalEngine, endpoint, engineArguments, mockSlug, quote, urlPath, withMask, withThreshold } from './logic/inputs.ts'
import { IDENTITY, sam3dSplatToGlb } from './logic/frames.ts'
import type { Mat3 } from './logic/frames.ts'
import { dict, dumps, entry, get, int, parse, plain, str, truthy } from './logic/pyjson.ts'
import type { PyValue } from './logic/pyjson.ts'
import { pyStr, pyTypeName, repr, strip } from './logic/pyformat.ts'
import { join, name as pathName } from './logic/pypath.ts'
import { decodeUtf8 } from './pytext.ts'

export interface Fal {
  readonly mock: boolean
  /** Set once a call has returned, i.e. once it has been paid for. */
  charged: boolean
  upload(file: string): Promise<string>
  call(ep: string, args: PyValue): Promise<PyValue>
  fetch(url: string, destDir: string): Promise<string>
}

const MATH = { sqrt: Math.sqrt, cos: Math.cos, sin: Math.sin }

/** `mimetypes.guess_type` for the files midstudy-add uploads. */
function guessType(file: string): string | null {
  const ext = path.extname(file).toLowerCase()
  const known: Readonly<Record<string, string>> = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.heic': 'image/heic', '.gif': 'image/gif' }
  return Object.entries(known).find(([k]) => k === ext)?.[1] ?? null
}

/** Python's `urllib.parse.unquote` (UTF-8, invalid bytes replaced). */
function unquote(s: string): string {
  return s.replace(/(%[0-9A-Fa-f]{2})+/g, (run) => new TextDecoder('utf-8').decode(Uint8Array.from(run.match(/%[0-9A-Fa-f]{2}/g) ?? [], (h) => Number.parseInt(h.slice(1), 16))))
}

/** v1's `url_basename`: the URL path's last segment, percent-decoded, or "download". */
export function urlBasename(url: string): string {
  return pathName(unquote(urlPath(url))) || 'download'
}

function log(record: PyValue): void {
  const file = process.env['MIDSTUDY_FAL_MOCK_LOG']
  if (file === undefined || file === '') return
  const d = dumps(record, { indent: null, ensureAscii: true, allowNan: true })
  if (d.ok) fs.appendFileSync(file, `${d.text}\n`)
}

function uploadRecord(file: string, url: string): PyValue {
  const data = fs.readFileSync(file)
  return dict([
    entry('op', str('upload')),
    entry('file', str(pathName(file))),
    entry('content_type', str(guessType(file) ?? 'application/octet-stream')),
    entry('bytes', int(data.length)),
    entry('sha256', str(createHash('sha256').update(data).digest('hex'))),
    entry('url', str(url)),
  ])
}

/** The queue URL fal-client submits to (FAL_RUN_HOST / FAL_QUEUE_RUN_HOST as it reads them). */
function queueUrl(ep: string): string {
  const run = process.env['FAL_RUN_HOST'] ?? 'fal.run'
  return `https://${process.env['FAL_QUEUE_RUN_HOST'] ?? `queue.${run}`}/${ep}`
}

// --- the mock --------------------------------------------------------------------------------------------------------

/** Replays <dir>/<slug>/response.json and copies <dir>/<slug>/files/<basename>; never touches the network. */
export class MockFal implements Fal {
  readonly mock = true
  charged = false
  readonly #root: string
  #slug = ''
  #noMasks: number

  constructor(root: string) {
    this.#root = root
    const raw = process.env['MIDSTUDY_FAL_MOCK_NO_MASKS'] ?? ''
    if (raw === '') this.#noMasks = 0
    else {
      const n = /^\s*[+-]?\d+\s*$/.test(raw) ? Number(raw) : Number.NaN
      if (!Number.isInteger(n)) throw new UnexpectedError('ValueError', `invalid literal for int() with base 10: ${repr(raw)}`)
      this.#noMasks = n
    }
  }

  upload(file: string): Promise<string> {
    const url = `https://mock.fal.invalid/uploads/${quote(pathName(file))}`
    log(uploadRecord(file, url))
    return Promise.resolve(url)
  }

  call(ep: string, args: PyValue): Promise<PyValue> {
    this.#slug = mockSlug(ep)
    log(dict([entry('op', str('call')), entry('endpoint', str(ep)), entry('url', str(queueUrl(ep))), entry('arguments', args)]))
    // evals: MIDSTUDY_FAL_MOCK_NO_MASKS=N makes the first N sam3d calls answer "no masks", as live fal does
    if (ep === endpoint('sam3d') && this.#noMasks > 0) {
      this.#noMasks -= 1
      return Promise.reject(new NoMasks('mock: Auto-segmentation produced no masks'))
    }
    const resp = join(join(this.#root, this.#slug), 'response.json')
    if (!isFile(resp)) return Promise.reject(new MidstudyError(`MIDSTUDY_FAL_MOCK: no recorded response at ${resp}`))
    const text = decodeUtf8(fs.readFileSync(resp))
    if (!text.ok) return Promise.reject(new UnexpectedError('UnicodeDecodeError', text.error))
    const parsed = parse(text.text)
    if (!parsed.ok) return Promise.reject(new MidstudyError(`MIDSTUDY_FAL_MOCK: ${resp} is not valid JSON (${parsed.error})`))
    return Promise.resolve(parsed.value)
  }

  fetch(url: string, destDir: string): Promise<string> {
    const files = join(join(this.#root, this.#slug), 'files')
    let src = join(files, pathName(urlPath(url)))
    if (!isFile(src)) src = join(files, urlBasename(url))
    if (!isFile(src)) return Promise.reject(new MidstudyError(`MIDSTUDY_FAL_MOCK: the response links ${url}, but ${src} doesn't exist`))
    const out = path.join(destDir, pathName(src))
    copy2(src, out)
    log(dict([entry('op', str('fetch')), entry('url', str(url)), entry('file', str(pathName(src)))]))
    return Promise.resolve(out)
  }
}

// --- the live client (fal-client 1.0.3's protocol) ------------------------------------------------------------------

const USER_AGENT = 'fal-client/1.0.3 (python)'
const REST_URL = 'https://rest.fal.ai'
const CDN_URL = 'https://v3.fal.media'
const BACKUP: ReadonlyMap<string, string> = new Map([['fal.run', 'falrun.com'], ['queue.fal.run', 'queue.falrun.com']])
const MAX_ATTEMPTS = 10

/** fal-client's FalClientHTTPError: the response's `detail` (or its text). */
class FalClientHTTPError extends Error {
  override readonly name: string = 'FalClientHTTPError'
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

export type FetchFn = (url: string, init: RequestInit) => Promise<Response>

/** Real fal calls with the key loadFalKey found, sent as fal-client sends FAL_KEY. */
export class LiveFal implements Fal {
  readonly mock = false
  charged = false
  readonly #key: string
  readonly #fetch: FetchFn
  readonly #sleep: (ms: number) => Promise<void>

  constructor(key: string, fetchFn: FetchFn = fetch, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {
    this.#key = key
    this.#fetch = fetchFn
    this.#sleep = sleep
  }

  /** One request with fal-client's retries (408, 409, 429, nginx's 502–504, transport errors) and its backup
   *  domains for fal.run and queue.fal.run. */
  async #request(url: string, init: RequestInit, timeoutMs: number | null): Promise<Response> {
    for (let attempt = 1; ; attempt++) {
      let res: Response | null = null
      let error: unknown = null
      try {
        res = await this.#send(url, init, timeoutMs)
      } catch (e) {
        error = e
      }
      if (res !== null) {
        if (res.ok) return res
        const text = await res.text()
        const retry = [408, 409, 429].includes(res.status)
          || ([502, 503, 504].includes(res.status) && !res.headers.has('x-fal-request-id') && text.includes('nginx'))
        if (!retry || attempt >= MAX_ATTEMPTS) throw this.#httpError(res.status, text)
      } else if (attempt >= MAX_ATTEMPTS) {
        throw error
      }
      const delay = Math.min(0.1 * 2 ** (attempt - 1), 30) * (0.5 + randomInt(0, 1_000_001) / 1_000_000)
      await this.#sleep(Math.min(delay, 30) * 1000)
    }
  }

  async #send(url: string, init: RequestInit, timeoutMs: number | null): Promise<Response> {
    const signal = timeoutMs === null ? null : AbortSignal.timeout(timeoutMs)
    try {
      return await this.#fetch(url, { ...init, signal })
    } catch (e) {
      const u = new URL(url)
      const backup = BACKUP.get(u.hostname)
      if (backup === undefined) throw e
      u.hostname = backup
      return this.#fetch(u.toString(), { ...init, signal })
    }
  }

  #httpError(status: number, text: string): FalClientHTTPError {
    const parsed = parse(text)
    const detail = parsed.ok && parsed.value.kind === 'dict' ? get(parsed.value, 'detail') : undefined
    const msg = detail === undefined ? text : pyStr(detail)
    return new FalClientHTTPError(msg, status)
  }

  #authHeaders(): Record<string, string> {
    return { Authorization: `Key ${this.#key}`, 'User-Agent': USER_AGENT }
  }

  async #json(res: Response): Promise<PyValue> {
    const parsed = parse(await res.text())
    if (!parsed.ok) throw new UnexpectedError('JSONDecodeError', parsed.error)
    return parsed.value
  }

  async upload(file: string): Promise<string> {
    try {
      const data = new Uint8Array(fs.readFileSync(file))
      const mime = guessType(file) ?? 'application/octet-stream'
      const fileName = path.basename(file)
      let url: string
      try {
        const token = await this.#json(await this.#fetch(`${REST_URL}/storage/auth/token?storage_type=fal-cdn-v3`, {
          method: 'POST',
          headers: { Authorization: `Key ${this.#key}`, Accept: 'application/json', 'Content-Type': 'application/json' },
          body: '{}',
        }))
        const tokenType = get(token, 'token_type')
        const tokenValue = get(token, 'token')
        const res = await this.#request(`${CDN_URL}/files/upload`, {
          method: 'POST',
          headers: {
            Authorization: `${tokenType?.kind === 'str' ? tokenType.value : ''} ${tokenValue?.kind === 'str' ? tokenValue.value : ''}`,
            'User-Agent': USER_AGENT,
            'Content-Type': mime,
            'X-Fal-File-Name': fileName,
          },
          body: data,
        }, 120_000)
        const access = get(await this.#json(res), 'access_url')
        if (access?.kind !== 'str') throw new UnexpectedError('KeyError', "'access_url'")
        url = access.value
      } catch {
        // fal-client's fallback repository: the storage upload
        const init = await this.#json(await this.#request(`${REST_URL}/storage/upload/initiate?storage_type=gcs`, {
          method: 'POST',
          headers: { ...this.#authHeaders(), Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ file_name: fileName, content_type: mime }),
        }, 120_000))
        const uploadUrl = get(init, 'upload_url')
        const fileUrl = get(init, 'file_url')
        if (uploadUrl?.kind !== 'str' || fileUrl?.kind !== 'str') throw new UnexpectedError('KeyError', "'upload_url'")
        await this.#request(uploadUrl.value, { method: 'PUT', headers: { ...this.#authHeaders(), 'Content-Type': mime }, body: data }, null)
        url = fileUrl.value
      }
      log(uploadRecord(file, url))
      return url
    } catch (e) {
      const what = e instanceof UnexpectedError ? `${e.pyType}: ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e)
      throw new MidstudyError(`fal upload of ${file} failed (${what}); check FAL_KEY and your credit`)
    }
  }

  async call(ep: string, args: PyValue): Promise<PyValue> {
    log(dict([entry('op', str('call')), entry('endpoint', str(ep)), entry('url', str(queueUrl(ep))), entry('arguments', args)]))
    try {
      const submitted = await this.#json(await this.#request(queueUrl(ep), {
        method: 'POST',
        headers: { ...this.#authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify(plain(args)),
      }, 120_000))
      const statusUrl = get(submitted, 'status_url')
      const responseUrl = get(submitted, 'response_url')
      if (statusUrl?.kind !== 'str' || responseUrl?.kind !== 'str') throw new UnexpectedError('KeyError', "'status_url'")
      // on_queue_update: the logs of every status, until it is completed; then get(): one more poll and the result
      for (const withLogs of [true, false]) {
        for (;;) {
          const status = await this.#json(await this.#request(`${statusUrl.value}?logs=${withLogs ? 'true' : 'false'}`, { method: 'GET', headers: this.#authHeaders() }, 120_000))
          const s = get(status, 'status')
          const name = s?.kind === 'str' ? s.value : ''
          if (name !== 'IN_QUEUE' && name !== 'IN_PROGRESS' && name !== 'COMPLETED') throw new UnexpectedError('ValueError', `Unknown status: ${name}`)
          const logs = get(status, 'logs')
          if (withLogs && name !== 'IN_QUEUE' && logs?.kind === 'list') {
            for (const l of logs.items) {
              const m = l.kind === 'dict' ? (get(l, 'message') ?? l) : l
              out(`  fal: ${pyStr(m)}`)
            }
          }
          if (name === 'COMPLETED') break
          await this.#sleep(100)
        }
      }
      return await this.#json(await this.#request(responseUrl.value, { method: 'GET', headers: this.#authHeaders() }, 120_000))
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e)
      const msg = raw.replace(/\n/g, ' ')
      if (msg.includes('produced no masks')) throw new NoMasks(msg)
      const type = e instanceof UnexpectedError ? e.pyType : e instanceof Error ? e.name : 'Error'
      throw new MidstudyError(`fal call to ${ep} failed (${type}: ${msg})`)
    }
  }

  async fetch(url: string, destDir: string): Promise<string> {
    const out = await download(url, path.join(destDir, urlBasename(url)), this.#fetch)
    log(dict([entry('op', str('fetch')), entry('url', str(url)), entry('file', str(pathName(out)))]))
    return out
  }
}

/** v1's `download`: a plain HTTP(S) download (live mode only), redirects followed. */
export async function download(url: string, dest: string, fetchFn: FetchFn = fetch): Promise<string> {
  try {
    const res = await fetchFn(url, { headers: { 'User-Agent': 'midstudy-add/0.1' }, redirect: 'follow', signal: AbortSignal.timeout(300_000) })
    if (!res.ok) throw new UnexpectedError('HTTPError', `HTTP Error ${String(res.status)}: ${res.statusText}`)
    fs.writeFileSync(dest, new Uint8Array(await res.arrayBuffer()))
  } catch (e) {
    const what = e instanceof UnexpectedError ? `${e.pyType}: ${e.message}` : e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    throw new MidstudyError(`download failed for ${url} (${what})`)
  }
  return dest
}

// --- running an engine -------------------------------------------------------------------------------------------------

/** What an engine made: its GLB (none for idol), its splat, and the splat's rotation into the GLB's frame. */
export interface Outputs {
  readonly glb: string | null
  readonly splat: string | null
  readonly splatToGlb: Mat3
}

/** v1's `_file_url`: the URL of resp[key], else of the first of resp[listKey]. */
function fileUrl(resp: PyValue, key: string, listKey: string | null = null): string | null {
  const obj = get(resp, key)
  const url = obj?.kind === 'dict' ? get(obj, 'url') : undefined
  if (url !== undefined && truthy(url)) return pyStr(url)
  const items = listKey === null ? undefined : get(resp, listKey)
  const first = items?.kind === 'list' ? items.items[0] : undefined
  const u = first?.kind === 'dict' ? get(first, 'url') : undefined
  if (u !== undefined && truthy(u)) return pyStr(u)
  return null
}

function say(line: string): void {
  out(line)
}

/** v1's `run`: one image engine, with SAM 3D's two retries when it finds nothing; its untouched outputs in rawDir. */
export async function run(fal: Fal, engine: FalEngine, image: string, prompt: string, resolution: number, rawDir: string): Promise<Outputs> {
  const ep = endpoint(engine)
  fs.mkdirSync(rawDir, { recursive: true })
  const imageUrl = await fal.upload(image)
  let args = engineArguments(engine, imageUrl, prompt, resolution)
  let resp: PyValue | null = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const shown = dumps(args, { indent: null, ensureAscii: true, allowNan: true })
    say(`midstudy-add: calling ${ep}${fal.mock ? ' (mock)' : ''} with ${shown.ok ? shown.text : ''}`)
    try {
      resp = await fal.call(ep, args)
      break
    } catch (e) {
      if (!(e instanceof NoMasks)) throw e
      if (engine !== 'sam3d') throw new MidstudyError(`fal call to ${ep} failed (${e.message})`)
      if (attempt === 2) {
        throw new MidstudyError(`SAM 3D found no ${prompt} in the picture, even with a mask of the piece. Use a photo of the piece on its own against a plain background, or try TRELLIS 2. For a rug seen from above, choose Flat rug (free)`)
      }
      if (attempt === 0) {
        say(`midstudy-add: SAM 3D found no '${prompt}' in the picture; trying again with a lower detection threshold (a refused call isn't charged)`)
        args = withThreshold(args)
      } else {
        const mask = path.join(rawDir, 'mask.png')
        const how = foregroundMask(image, mask)
        say(`midstudy-add: still nothing; trying again with a mask of ${how}`)
        args = withMask(args, await fal.upload(mask))
      }
    }
  }
  fal.charged = true
  if (resp?.kind !== 'dict') {
    throw new MidstudyError(`${ep} returned ${resp === null ? 'NoneType' : pyTypeName(resp)}, expected a JSON object`)
  }
  const pretty = (v: PyValue): string => {
    const d = dumps(v, { indent: 2, ensureAscii: true, allowNan: true })
    if (!d.ok) throw new UnexpectedError('ValueError', d.error)
    return `${d.text}\n`
  }
  fs.writeFileSync(path.join(rawDir, 'response.json'), pretty(resp))
  fs.writeFileSync(path.join(rawDir, 'request.json'), pretty(args))

  if (engine === 'idol') {
    // model_mesh is the splat (a PLY, despite the name), the only file fetched (contract §3.2)
    const splatUrl = fileUrl(resp, 'model_mesh')
    if (splatUrl === null) throw new MidstudyError(`${ep} returned no model_mesh (the splat)`)
    return { glb: null, splat: await fal.fetch(splatUrl, rawDir), splatToGlb: IDENTITY }
  }
  const glbUrl = engine === 'sam3d' ? fileUrl(resp, 'model_glb', 'individual_glbs') : fileUrl(resp, 'model_glb')
  const splatUrl = engine === 'sam3d' ? fileUrl(resp, 'gaussian_splat', 'individual_splats') : null
  if (glbUrl === null) throw new MidstudyError(`${ep} returned no model_glb (live runs keep the response in <library>/_failed/)`)
  const glb = await fal.fetch(glbUrl, rawDir)
  if (splatUrl !== null) {
    return { glb, splat: await fal.fetch(splatUrl, rawDir), splatToGlb: sam3dSplatToGlb(resp, MATH) }
  }
  if (engine === 'sam3d') say('midstudy-add: warning: sam3d returned no gaussian_splat; the item will be GLB only')
  return { glb, splat: null, splatToGlb: IDENTITY }
}

/** v1's `load_fal_key`: FAL_KEY from the environment, else from <repo>/.env (unless MIDSTUDY_NO_DOTENV=1); null when
 *  there's none. Never printed, and never written to the environment: the caller hands it to LiveFal. */
export function loadFalKey(repo: string): string | null {
  const env = process.env['FAL_KEY']
  if (env !== undefined && env !== '') return env
  const no = process.env['MIDSTUDY_NO_DOTENV'] ?? ''
  if (no !== '' && no !== '0') return null
  let text: string
  try {
    text = fs.readFileSync(path.join(repo, '.env'), 'utf8')
  } catch {
    return null
  }
  for (const raw of text.split(/\r\n|\r|\n/)) {
    let line = strip(raw)
    if (line.startsWith('export ')) line = strip(line.slice(7))
    const eq = line.indexOf('=')
    if (eq < 0 || strip(line.slice(0, eq)) !== 'FAL_KEY') continue
    const value = strip(line.slice(eq + 1)).replace(/^['"]+|['"]+$/g, '')
    if (value !== '') return value
  }
  return null
}
