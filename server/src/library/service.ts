// The library's state (contract §2.8; v1 planner/serve.py LibraryService): library.json and the trash, read as v1 read
// them and written under the v2 library lock (common/lock.ts, contract §2.8 One writer), and the one queue of
// midstudy-add jobs (in memory, one at a time, newest first; a restart forgets them). The spend cap is the server's
// (deps.spend); a paid add reserves its estimate under its job id until the job ends.
import fs from 'node:fs'
import path from 'node:path'
import { falMock } from '../../../common/fal.ts'
import { atomicWrite, isDir, jsonText, removeTree, resolvePath, type JsonStyle } from '../../../common/files.ts'
import { withLibraryLock } from '../../../common/lock.ts'
import { pyFloat } from '../../../common/logic/csv.ts'
import { pyRepr } from '../../../common/logic/pyfmt.ts'
import { isoUtc } from '../../../common/logic/time.ts'
import { addError, addMessage, outputLines, runTool, summaryOf } from '../../../common/tools.ts'
import { decodeUtf8 } from '../../../common/utf8.ts'
import type { SchemaUri } from '../../../contract/gen/validate.js'
import type { ServerDeps } from '../deps.ts'
import { JobStore, newJobId, SerialQueue } from '../jobs.ts'
import type { SpendRefusal } from '../spend.ts'
import { assertConforms } from '../strict.ts'
import { isRecord, parseDocument, plain, pyStrOf, pyTypeName, truthy } from './json.ts'
import type { Engine } from './logic/meta.ts'
import { NO_SUMMARY, notInstalled, runningMessage, serverFailed, timedOut, trashOrder } from './logic/messages.ts'
import type { ItemFacts } from './logic/patch.ts'

/** v1 MIDSTUDY_ADD_TIMEOUT: one midstudy-add run, in seconds. */
const ADD_TIMEOUT_S = 3600
/** v1 LOCK_WAIT: a library edit waits this long for a running midstudy-add, then answers 503. */
const LOCK_WAIT_MS = 60 * 1000
/** How a job the server's stop ended, or never started, reads. */
const SERVER_STOPPED = 'the server stopped'

/** A library job (contract §2.8 Jobs; api/library-job.schema.json), in v1's key order. `cost_usd` and `item` are what
 *  midstudy-add's summary and library.json say, passed on as they are. */
export interface LibraryJob {
  readonly id: string
  readonly kind: 'add' | 'rescale'
  readonly item_id: string
  readonly status: 'queued' | 'running' | 'done' | 'failed'
  readonly engine: Engine
  readonly cost_usd_estimate: number
  readonly cost_usd: unknown
  readonly mock: boolean
  readonly created: string
  readonly started: string | null
  readonly finished: string | null
  readonly message: string
  readonly item: unknown
}

/** A trashed copy (v1 `trash()`): its entry's id and name, when it was deleted, and its folder. */
export interface TrashedCopy {
  readonly id: unknown
  readonly name: unknown
  readonly deleted: unknown
  readonly dir: string
}

/** An exception v1 didn't catch (`TypeError`, `ValueError`, `AttributeError`): the dispatcher answers
 *  `500 "<name>: <message>"`, as v1's handlers did. */
export class PyError extends Error {
  constructor(name: string, message: string) {
    super(message)
    this.name = name
  }
}

/** v1 `read_json_file` as text: the file decoded as strict UTF-8 (a BOM kept, so JSON refuses it as Python did), or
 *  null when it is missing or unreadable. */
function readText(file: string): string | null {
  let bytes: Uint8Array
  try {
    bytes = fs.readFileSync(file)
  } catch {
    return null
  }
  const d = decodeUtf8(bytes)
  return d.ok ? d.text : null
}

/** A JSON file parsed with JSON.parse (for answers), or null. */
function readJson(file: string): unknown {
  const text = readText(file)
  if (text === null) return null
  try {
    const value: unknown = JSON.parse(text)
    return value
  } catch {
    return null
  }
}

/** A JSON file parsed with every number as spelled (for files written back), or null. */
export function readDocument(file: string): unknown {
  const text = readText(file)
  if (text === null) return null
  try {
    return parseDocument(text)
  } catch {
    return null
  }
}

/** `dict.get(key)`: the value, or null (None) when the key is missing. */
export function getOr(r: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.hasOwn(r, key) ? r[key] : null
}

/** library.json's items (a copy of the list; the items themselves are the document's). */
export function itemsOf(doc: Readonly<Record<string, unknown>>): unknown[] {
  const items = doc['items']
  return Array.isArray(items) ? items.map((x: unknown) => x) : []
}

/** v1 `item()`: the first item that is an object with this id, or null. */
export function findItem(items: readonly unknown[], id: string): Record<string, unknown> | null {
  for (const item of items) if (isRecord(item) && item['id'] === id) return item
  return null
}

/** What PATCH's rules need to know about an item (v1 read `assets` and `source` only when default_render was sent;
 *  a value of another type than v1 expected counts as missing here). */
export function itemFacts(item: Readonly<Record<string, unknown>>): ItemFacts {
  const assets = item['assets']
  const source = item['source']
  const a = isRecord(assets) ? assets : {}
  return {
    hasSplat: truthy(getOr(a, 'splat')) || truthy(getOr(a, 'spz')),
    hasGlb: truthy(getOr(a, 'glb')),
    idol: isRecord(source) && source['engine'] === 'idol',
  }
}

/** Python's `float(v)` of a parsed JSON value, raising what Python raised. */
function pyFloatOf(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'boolean') return v ? 1 : 0
  if (typeof v === 'string') {
    const n = pyFloat(v)
    if (n === null) throw new PyError('ValueError', 'could not convert string to float: ' + pyRepr(v))
    return n
  }
  throw new PyError('TypeError', "float() argument must be a string or a real number, not '" + pyTypeName(v) + "'")
}

/** v1's `float((item.get("dims_cm") or {}).get(k, 0))` for w, d and h (a plain item). */
export function currentDims(item: Readonly<Record<string, unknown>>): { readonly w: number; readonly d: number; readonly h: number } {
  const dims = getOr(item, 'dims_cm')
  if (!truthy(dims)) return { w: 0, d: 0, h: 0 }
  if (!isRecord(dims)) throw new PyError('AttributeError', "'" + pyTypeName(dims) + "' object has no attribute 'get'")
  const at = (k: string): number => (Object.hasOwn(dims, k) ? pyFloatOf(dims[k]) : 0)
  return { w: at('w'), d: at('d'), h: at('h') }
}

/** The library (one per server). */
export class LibraryService {
  /** --library-dir, absolute. */
  readonly dir: string
  readonly #deps: ServerDeps
  readonly #jobs = new JobStore<LibraryJob>()
  readonly #runs = new Map<string, { readonly argv: readonly string[]; readonly cleanup: string | null }>()
  readonly #queue: SerialQueue
  /** The running job's way out (one job runs at a time). */
  #running: AbortController | null = null
  /** Set by shutdown(): no job starts after it. */
  #closing = false

  constructor(deps: ServerDeps) {
    this.#deps = deps
    this.dir = deps.config.libraryDir
    this.#queue = new SerialQueue((id) => this.#run(id), (id, e) => {
      this.#fail(id, serverFailed(e instanceof Error ? e.name : typeof e, e instanceof Error ? e.message : String(e)))
    }, (id) => this.#after(id))
  }

  /** The library folder as midstudy-add's `--library=` gets it (v1 `self.library_dir.resolve()`). */
  libraryArg(): string {
    return resolvePath(this.dir)
  }

  /** Runs `fn` holding `<library>/.lock.d`; Busy (503) after 60 s while midstudy-add holds it. */
  locked<T>(fn: () => Promise<T>): Promise<T> {
    return withLibraryLock(this.dir, { waitMs: LOCK_WAIT_MS, cmd: 'midstudy server' }, fn)
  }

  /** v1 `read()` for a write: library.json with every number as spelled, or an empty library when it is missing or
   *  isn't `{…, "items": […]}`. */
  read(): Record<string, unknown> {
    const data = readDocument(path.join(this.dir, 'library.json'))
    if (!isRecord(data) || !Array.isArray(data['items'])) return { version: 1, items: [] }
    return data
  }

  /** The same for an answer (plain numbers). */
  readPlain(): Record<string, unknown> {
    const data = readJson(path.join(this.dir, 'library.json'))
    if (!isRecord(data) || !Array.isArray(data['items'])) return { version: 1, items: [] }
    return data
  }

  /** v1 `write()`: library.json in midstudy-add's layout (indent 2, UTF-8), atomically; strict mode checks it first.
   *  Call under locked(). */
  async write(doc: Readonly<Record<string, unknown>>): Promise<void> {
    await this.writeFile(path.join(this.dir, 'library.json'), doc, 'midstudy/library.schema.json', 'utf8')
  }

  /** A JSON file the library keeps (library.json, a trashed entry.json), numbers as spelled; strict mode checks it. */
  async writeFile(file: string, doc: unknown, schema: SchemaUri, style: JsonStyle): Promise<void> {
    assertConforms(schema, plain(doc), 'writing ' + file)
    await atomicWrite(file, jsonText(doc, style))
  }

  /** v1 `trash()`: every trashed copy with an entry, newest first (by `str(deleted)`, then folder name). */
  trash(): TrashedCopy[] {
    const root = path.join(this.dir, '.trash')
    if (!isDir(root)) return []
    const found: { readonly copy: TrashedCopy; readonly key: { readonly deleted: string; readonly dir: string } }[] = []
    let names: string[]
    try {
      names = fs.readdirSync(root)
    } catch {
      return []
    }
    for (const name of names) {
      const dir = path.join(root, name)
      const meta = isDir(dir) ? readJson(path.join(dir, 'entry.json')) : null
      if (!isRecord(meta)) continue
      const entry = meta['entry']
      if (!isRecord(entry)) continue
      const deleted = getOr(meta, 'deleted')
      found.push({ copy: { id: getOr(entry, 'id'), name: getOr(entry, 'name'), deleted, dir }, key: { deleted: pyStrOf(deleted), dir: name } })
    }
    return found.sort((a, b) => trashOrder(a.key, b.key)).map((f) => f.copy)
  }

  /** Queues a midstudy-add run (v1 `new_job`): the job as queued, or the 402 body when the cap refuses `reserve`
   *  (nothing queued then). The job owns `cleanup` and removes it when it ends. */
  newJob(kind: 'add' | 'rescale', itemId: string, engine: Engine, estimate: number, argv: readonly string[], cleanup: string | null, reserve: number, message: string): { readonly job: LibraryJob } | { readonly refused: SpendRefusal } {
    const now = Date.now()
    const id = newJobId('l', now)
    const refused = this.#deps.spend.reserve(id, reserve)
    if (refused !== null) return { refused }
    const job = this.#jobs.add({
      id, kind, item_id: itemId, status: 'queued', engine, cost_usd_estimate: estimate, cost_usd: null, mock: falMock(), created: isoUtc(now),
      started: null, finished: null, message, item: null,
    })
    this.#runs.set(id, { argv, cleanup })
    this.#queue.push(id)
    return { job }
  }

  /** Every job, newest first. */
  listJobs(): LibraryJob[] {
    return this.#jobs.list()
  }

  /** One job, or null. */
  getJob(id: string): LibraryJob | null {
    return this.#jobs.get(id)
  }

  /** The server's stop: the running midstudy-add ended (SIGTERM to its group: it releases the lock and cleans its
   *  scratch, and a paid run records its cost first), the queued jobs failed without starting; resolves when the
   *  queue has settled. */
  async shutdown(): Promise<void> {
    this.#closing = true
    this.#running?.abort()
    await this.#queue.drained()
  }

  #fail(id: string, message: string): void {
    this.#jobs.update(id, { status: 'failed', finished: isoUtc(Date.now()), message })
  }

  /** v1 `run()`: one midstudy-add run, its outcome recorded on the job. */
  async #run(id: string): Promise<void> {
    const job = this.#jobs.get(id)
    const run = this.#runs.get(id)
    if (job === null || run === undefined) return
    if (this.#closing) {
      this.#fail(id, SERVER_STOPPED)
      return
    }
    this.#jobs.update(id, { status: 'running', started: isoUtc(Date.now()), message: runningMessage(job.kind, job.item_id, job.engine) })
    const abort = new AbortController()
    this.#running = abort
    const out = await runTool(run.argv, { cwd: this.#deps.config.repo, timeoutMs: ADD_TIMEOUT_S * 1000, signal: abort.signal })
    this.#running = null
    if (abort.signal.aborted && !(out.kind === 'exited' && out.returnCode === 0)) {
      this.#fail(id, SERVER_STOPPED)
      return
    }
    switch (out.kind) {
      case 'not-found':
        this.#fail(id, notInstalled(out.command))
        return
      case 'timeout':
        this.#fail(id, timedOut(ADD_TIMEOUT_S, this.#deps.spend.holdForToday(id)))
        return
      case 'spawn-error':
        throw new PyError('OSError', out.message)
      case 'exited':
        break
    }
    const lines = outputLines(out.stdout)
    if (out.returnCode !== 0) {
      this.#fail(id, addError(out.stderr, out.returnCode))
      return
    }
    const summary = summaryOf(lines)
    if (summary === undefined) {
      this.#fail(id, NO_SUMMARY)
      return
    }
    if (!isRecord(summary)) throw new PyError('AttributeError', "'" + pyTypeName(summary) + "' object has no attribute 'get'")
    const item = findItem(itemsOf(this.readPlain()), job.item_id)
    this.#jobs.update(id, {
      status: 'done',
      finished: isoUtc(Date.now()),
      message: addMessage(lines, job.kind, job.item_id),
      item,
      cost_usd: Object.hasOwn(summary, 'cost_usd') ? summary['cost_usd'] : 0,
      mock: truthy(Object.hasOwn(summary, 'mock') ? summary['mock'] : falMock()),
    })
  }

  /** After every job: its reservation released, its upload folder removed. */
  #after(id: string): Promise<void> {
    this.#deps.spend.release(id)
    const run = this.#runs.get(id)
    this.#runs.delete(id)
    if (run !== undefined && run.cleanup !== null) removeTree(run.cleanup)
    return Promise.resolve()
  }
}
