// midstudy planner data: the scenes on the server (GET /api/scenes, contract §4.4), polled while one calibrates, plus
// uploads with progress; and the furniture library manager's store (createLibrary, §2.8).
//
// createScenes({ engine }) → scenes
//   start()                 first refresh, then poll every 1.5 s while a scene is pending or running
//   refresh() → Promise     GET /api/scenes now (through the engine, which emits 'scenes')
//   getScenes()             the §4.4 scene objects, newest first;   getScene(name);   getState() { loaded, offline }
//   upload(file, { title, onProgress(loaded, total) }) → Promise<{ job, scene }>   POST /api/scenes (XHR, for progress)
//   rename(name, title) / remove(name)   PUT title / DELETE (moves it to scenes/.trash on the server)
// Events (scenes.events, ScenesEvents): 'scenes' { scenes }   'ready' { scene } a scene finished calibrating while this
//   page was open   'failed' { scene }
// Helpers: friendlyDate(iso|Date) ("Sun 26 Oct, 09:36"), relDate ("Today, 09:36"), clock, sceneTitle(scene), fmtBytes(n)
// The decisions and the wording are planner/logic/ (text.ts, money.ts, messages.ts, library.ts, scenes.ts).
import { RequestError, quiet, withMidstudy } from './engine.js'
import type { Engine, Req } from './engine.js'
import { Bus } from './bus.js'
import type { Events } from './bus.js'
import { libraryEntry, libraryJob, libraryJobs, sceneCreated, spendOf, trashedItems } from './wire.js'
import type { LibraryEntry, LibraryJob, SceneCreated, SceneSummary, Spend, TrashedItem } from './wire.js'
import * as libLogic from './logic/library.js'
import * as msg from './logic/messages.js'
import * as money from './logic/money.js'
import * as sceneLogic from './logic/scenes.js'
import * as text from './logic/text.js'
import type { JsonObject } from './logic/num.js'

type When = Date | string | number | null | undefined
// v1's new Date(when): null is the epoch, undefined isn't a date.
const asDate = (when: When): Date => (when instanceof Date ? when : when === null ? new Date(0) : when === undefined ? new Date(Number.NaN) : new Date(when))
const parts = (d: Date): text.DateParts => ({ weekday: d.getDay(), day: d.getDate(), month: d.getMonth(), hours: d.getHours(), minutes: d.getMinutes() })
/** "Sun 26 Oct, 09:36" ('' for a date that doesn't parse). */
export function friendlyDate(when: When): string {
  const d = asDate(when)
  if (Number.isNaN(d.getTime())) return ''
  return text.friendlyText(parts(d))
}
/** "09:36". @public (a v1 export name) */
export function clock(when: When): string {
  const d = asDate(when)
  return Number.isNaN(d.getTime()) ? '' : text.clockText(parts(d))
}
/** "Today, 09:36", "Yesterday, 09:36", else friendlyDate. */
export function relDate(when: When): string {
  const d = asDate(when)
  if (Number.isNaN(d.getTime())) return ''
  const day = (x: Date): number => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 864e5)
  return text.relText(diff, parts(d))
}
const isRecord = (x: unknown): x is JsonObject => typeof x === 'object' && x !== null
const whenOf = (x: unknown): When => (x instanceof Date || typeof x === 'string' || typeof x === 'number' || x === null ? x : undefined)
/** A scene's title as typed, else the date it was made, else its name. */
export function sceneTitle(s: unknown): string {
  const o = isRecord(s) ? s : null
  const title = o?.['title']
  const name = o?.['name']
  return text.sceneTitleText(title ? textOf(title) : '', friendlyDate(whenOf(o?.['created'])), name ? textOf(name) : '')
}
/** '' for nothing, else KB, MB or GB. */
export function fmtBytes(n: unknown): string {
  return typeof n === 'number' ? text.fmtBytes(n) : ''
}
function textOf(x: unknown): string {
  return typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : JSON.stringify(x)
}

// §2.9: mutations carry X-Midstudy: 1 (engine.ts withMidstudy).
async function fetchJson(url: string, opts?: Req): Promise<unknown> {
  let res: Response
  try { res = await fetch(url, withMidstudy(opts)) } catch (e) { throw new RequestError(msg.unreachableText(url, e instanceof Error ? e.message : textOf(e)), null, true, null) }
  let body: unknown = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) {
    const err = isRecord(body) ? body['error'] : null
    throw new RequestError(msg.httpErrorText(url, res.status, typeof err === 'string' && err ? err : null), res.status, false, body)
  }
  return body
}
function b64json(o: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(o))
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
const statusOf = (e: unknown): number | null => (e instanceof RequestError ? e.status : null)
const offlineOf = (e: unknown): boolean => e instanceof RequestError && e.offline

/** What the scenes store's events carry (scenes.events). */
export interface ScenesEvents {
  scenes: { scenes: SceneSummary[] }
  ready: { scene: SceneSummary }
  failed: { scene: SceneSummary }
}

/** The scenes store (§4.4, §4.5). */
export function createScenes({ engine }: { engine: Engine }) {
  const events = new Bus<ScenesEvents>()
  const state = { loaded: false, offline: false }
  let list: SceneSummary[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  const seen = new Map<string, unknown>() // name -> last calib_status

  engine.events.addEventListener('scenes', (e) => {
    list = e.detail.scenes.slice()
    state.loaded = true
    state.offline = false
    for (const s of list) {
      const now = s.calib_status
      const fin = sceneLogic.sceneFinished(seen.get(s.name), now)
      if (fin) events.emit(fin, { scene: s })
      seen.set(s.name, now)
    }
    events.emit('scenes', { scenes: list.slice() })
    schedule()
  })
  function schedule(): void {
    clearTimeout(timer)
    if (list.some((s) => sceneLogic.sceneBusy(s.calib_status))) timer = setTimeout(() => { quiet(refresh()) }, 1500)
  }
  async function refresh(): Promise<void> {
    try { await engine.listScenesInternal() } catch (e) {
      state.offline = true
      events.emit('scenes', { scenes: list.slice() })
      clearTimeout(timer)
      timer = setTimeout(() => { quiet(refresh()) }, 10000)
      throw e
    }
  }
  function upload(file: unknown, opts: { title?: string | null; onProgress?: ((loaded: number, total: number) => void) | null } = {}): Promise<SceneCreated> {
    if (!(file instanceof Blob)) return Promise.reject(engine.reportError('Pick a photo first'))
    const title = opts.title ?? null
    const name = text.uploadName(file instanceof File ? file.name : '', 'photo.jpg')
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/scenes')
      xhr.setRequestHeader('X-Midstudy', '1')
      xhr.setRequestHeader('X-Midstudy-Filename', name)
      if (title?.trim()) xhr.setRequestHeader('X-Midstudy-Meta', b64json({ title: title.trim() }))
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
      xhr.upload.onprogress = (e) => { opts.onProgress?.(e.loaded, e.total || file.size) }
      xhr.onerror = () => { reject(engine.reportError("Couldn't upload the photo: the server isn't answering")) }
      xhr.onload = () => {
        let body: unknown = null
        try { body = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
        const created = sceneCreated(body)
        if (xhr.status !== 202 || !created?.scene) {
          const err = isRecord(body) ? body['error'] : null
          const why = err ? textOf(err) : `HTTP ${String(xhr.status)}`
          reject(engine.reportError(msg.uploadErrorText(xhr.status, why)))
          return
        }
        seen.set(created.scene, 'pending')
        quiet(refresh())
        resolve(created)
      }
      xhr.send(file)
    })
  }
  const rename = (name: string, title: unknown): Promise<void> => engine.renameScene(name, title)
  const remove = (name: unknown): Promise<void> => engine.deleteScene(name)
  const listen: Events<ScenesEvents> = events
  return {
    events: listen, start: (): Promise<void> => refresh(), refresh, upload, rename, remove,
    getScenes: (): SceneSummary[] => list.slice(),
    getScene: (name: string | null): SceneSummary | null => list.find((s) => s.name === name) ?? null,
    getState: (): { loaded: boolean; offline: boolean } => ({ ...state }),
  }
}
/** The scenes store (ctx.scenes). @public */
export type Scenes = ReturnType<typeof createScenes>

// --- the library manager's store (§2.8, §2.9) -------------------------------------------------------------------
// createLibrary({ engine }) → lib
//   start()                   ask GET /api/library once (is there a library API?), then the jobs and today's spend
//   getState()                { api: true|false|null, jobs (newest first), trash [{id, name, deleted}], spend {day, spent_usd, reserved_usd, cap_usd} | null }
//   jobs() → Promise<[job]>   GET /api/library/jobs (and polls every 1.5 s while one is queued or running)
//   addFromFile(file, meta)   POST /api/library/items (raw body; X-Midstudy-Kind model|image from the file name) → job
//   addFromUrl(url, meta)     POST /api/library/items/from-url → job
//   readProduct(url, { llm, html }) POST /api/library/product → what the product page (or a pasted copy of it) says (§2.11); adds nothing
//   edit(id, patch)           PATCH → the item, or a rescale job (dims_cm, yaw)
//   remove(id) / restore(id)  DELETE → move to the library's trash / POST …/restore → the item
//   spend() → Promise<spend>  GET /api/spend
//   estimate(meta, kind)      the price an add will reserve ($0 for a model)
// Events (lib.events, LibEvents): 'jobs' { jobs }   'job-done' { job }   'job-failed' { job }   'spend' { spend }   'trash' { trash }
// Actions reject with a reported error; a library change reloads the engine's library.
// idol is the default image engine (contract §2.8, §3.2): $0.10, a splat with a stand-in box.
export const LIB_PRICE = { glb: 0, rug: 0, idol: 0.1, sam3d: 0.02, trellis2: { 512: money.trellisPrice(512), 1024: money.trellisPrice(1024), 1536: money.trellisPrice(1536) } } as const
export const DEFAULT_IMAGE_ENGINE = money.DEFAULT_IMAGE_ENGINE
/** Model file names (v1's MODEL_EXT; money.isModelName decides). @public (a v1 export name) */
export const MODEL_EXT = /\.(glb|zip|gltf|usdz|obj|fbx)$/i
/** The price an add will reserve: $0 for a model file, else the engine's (contract §3.2). */
export function estimateCost(meta: unknown = {}, kind = 'image'): number {
  const m = isRecord(meta) ? meta : {}
  const engineName = m['engine']
  return money.estimateCost(engineName ? textOf(engineName) : '', Number(m['resolution']), kind)
}

/** What readProduct rejects with: the server's sentence, its status, and whether the shop blocks reading (§2.11). */
class ProductReadError extends Error {
  readonly status: number | null
  readonly blocked: boolean
  readonly offline: boolean
  constructor(message: string, status: number | null, blocked: boolean, offline: boolean) {
    super(message)
    this.status = status
    this.blocked = blocked
    this.offline = offline
  }
}

/** What the library store's events carry (lib.events). */
export interface LibEvents {
  jobs: { jobs: LibraryJob[] }
  'job-done': { job: LibraryJob }
  'job-failed': { job: LibraryJob }
  spend: { spend: Spend | null }
  trash: { trash: TrashedItem[] }
}
interface LibState {
  api: boolean | null
  jobs: LibraryJob[]
  trash: TrashedItem[]
  spend: Spend | null
}

export function createLibrary({ engine = null }: { engine?: Engine | null } = {}) {
  const events = new Bus<LibEvents>()
  const report = (m: string, e: unknown): Error => (engine ? engine.reportError(m, e) : new Error(`${m}: ${e instanceof Error ? e.message : textOf(e)}`))
  const custom = typeof location !== 'undefined' && new URLSearchParams(location.search).has('library')
  const state: LibState = { api: custom ? false : null, jobs: [], trash: [], spend: null }
  const status = new Map<string, unknown>() // job id → last status seen
  let timer: ReturnType<typeof setTimeout> | undefined

  const reload = (): Promise<void> | undefined => engine?.reloadLibrary()
  function setJobs(next: LibraryJob[]): void {
    for (const j of next) {
      const change = libLogic.jobChange(status.get(j.id), j.status)
      if (change === 'done') { quiet(reload()); events.emit('job-done', { job: j }); quiet(spend()) }
      if (change === 'failed') { events.emit('job-failed', { job: j }); quiet(spend()) }
      status.set(j.id, j.status)
    }
    state.jobs = next
    events.emit('jobs', { jobs: next.slice() })
    schedule()
  }
  function track(job: LibraryJob | null): LibraryJob | null {
    if (!job?.id) return job
    if (!status.has(job.id)) status.set(job.id, job.status)
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)]
    events.emit('jobs', { jobs: state.jobs.slice() })
    schedule()
    return job
  }
  const busy = (): boolean => state.jobs.some((j) => libLogic.jobBusy(j.status))
  function schedule(): void {
    clearTimeout(timer)
    if (busy()) timer = setTimeout(() => { quiet(jobs()) }, 1500)
  }

  async function jobs(): Promise<LibraryJob[]> {
    let body: unknown
    try { body = await fetchJson('/api/library/jobs') } catch (e) { schedule(); throw report('Could not list the library jobs', e) }
    setJobs(libraryJobs(isRecord(body) ? body['jobs'] : null))
    return state.jobs.slice()
  }
  async function spend(): Promise<Spend | null> {
    let body: unknown
    try { body = await fetchJson('/api/spend') } catch (e) { throw report("Could not read today's spend", e) }
    state.spend = spendOf(body)
    events.emit('spend', { spend: state.spend })
    return state.spend
  }
  async function refreshTrash(): Promise<void> {
    try {
      const body = await fetchJson('/api/library')
      state.api = true
      state.trash = trashedItems(isRecord(body) ? body['trash'] : null)
      events.emit('trash', { trash: state.trash.slice() })
    } catch (e) {
      const st = statusOf(e)
      if (st === 404 || st === 405 || st === 501) state.api = false
      events.emit('trash', { trash: state.trash.slice() })
    }
  }
  async function start(): Promise<void> {
    if (custom) return
    await refreshTrash()
    if (state.api) await Promise.allSettled([jobs(), spend()])
  }

  const jobOf = (body: unknown): LibraryJob | null => {
    const b = isRecord(body) ? body : null
    const inner = b?.['job']
    const job: unknown = isRecord(inner) ? { ...inner } : body
    const estimate = b?.['cost_usd_estimate']
    if (isRecord(job) && estimate !== null && estimate !== undefined && (job['cost_usd_estimate'] === null || job['cost_usd_estimate'] === undefined)) return libraryJob({ ...job, cost_usd_estimate: estimate })
    return libraryJob(job)
  }
  async function addFromFile(file: unknown, meta: unknown = {}): Promise<LibraryJob | null> {
    if (!(file instanceof Blob)) throw report('addItemFromFile needs a File', undefined)
    const name = file instanceof File && file.name ? file.name : 'upload'
    const kind = money.isModelName(name) ? 'model' : 'image'
    let body: unknown
    try {
      body = await fetchJson('/api/library/items', {
        method: 'POST', body: file,
        headers: { 'content-type': file.type || 'application/octet-stream', 'X-Midstudy-Kind': kind, 'X-Midstudy-Filename': text.uploadName(name, 'upload'), 'X-Midstudy-Meta': b64json(meta) },
      })
    } catch (e) { quiet(spend()); throw report(msg.addErrorText(statusOf(e), offlineOf(e)), e) }
    quiet(spend())
    return track(jobOf(body))
  }
  async function addFromUrl(url: unknown, meta: unknown = {}): Promise<LibraryJob | null> {
    let body: unknown
    try {
      body = await fetchJson('/api/library/items/from-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...(isRecord(meta) ? meta : {}), image_url: url }) })
    } catch (e) { quiet(spend()); throw report(msg.addErrorText(statusOf(e), offlineOf(e)), e) }
    quiet(spend())
    return track(jobOf(body))
  }
  // §2.11: what a shop's product page says (the 200 body); adds nothing. Rejects with the server's sentence, plus
  // err.status and err.blocked. A shop that blocks reading or a page without a product is the page's answer, shown in
  // the form, so only a server that isn't answering (or fails) is reported as an error.
  async function readProduct(url: unknown, opts: unknown = {}): Promise<unknown> {
    const o = isRecord(opts) ? opts : {}
    const req: Record<string, unknown> = {}
    const u = url === null || url === undefined ? '' : textOf(url).trim()
    if (u) req['url'] = u
    const html = o['html']
    if (typeof html === 'string') req['html'] = html // a page the user's browser copied: the server fetches nothing
    const llm = o['llm']
    if (typeof llm === 'boolean') req['llm'] = llm
    try {
      return await fetchJson('/api/library/product', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
    } catch (e) {
      const st = statusOf(e)
      const offline = offlineOf(e)
      const body = e instanceof RequestError && isRecord(e.body) ? e.body : null
      const why = body?.['error']
      const reported = msg.productReported(offline, st)
      const base = reported ? report(msg.productErrorText(offline), e) : null
      throw new ProductReadError(base ? base.message : why ? textOf(why) : e instanceof Error ? e.message : textOf(e), st, !!body?.['blocked'], offline)
    }
  }
  /** PATCH: the rescale job (dims_cm or yaw changed), else the item as the server has it now. */
  async function edit(id: unknown, patch: unknown = {}): Promise<LibraryJob | LibraryEntry | null> {
    const sid = textOf(id)
    let body: unknown
    try {
      body = await fetchJson(`/api/library/items/${encodeURIComponent(sid)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    } catch (e) { throw report(msg.editErrorText(sid, offlineOf(e)), e) }
    if (isRecord(body) && body['job']) return track(jobOf(body))
    await reload()
    return libraryEntry(body)
  }
  async function remove(id: unknown): Promise<void> {
    const sid = textOf(id)
    try { await fetchJson(`/api/library/items/${encodeURIComponent(sid)}`, { method: 'DELETE' }) } catch (e) {
      throw report(msg.removeErrorText(sid, offlineOf(e)), e)
    }
    await Promise.allSettled([reload(), refreshTrash()])
  }
  async function restore(id: unknown): Promise<LibraryEntry | null> {
    const sid = textOf(id)
    let item: unknown
    try { item = await fetchJson(`/api/library/items/${encodeURIComponent(sid)}/restore`, { method: 'POST' }) } catch (e) {
      throw report(msg.restoreErrorText(sid, statusOf(e)), e)
    }
    await Promise.allSettled([reload(), refreshTrash()])
    return libraryEntry(item)
  }

  const listen: Events<LibEvents> = events
  return {
    events: listen, start, jobs, spend, addFromFile, addFromUrl, readProduct, edit, remove, restore,
    getState: (): Readonly<LibState> => ({ ...state, jobs: state.jobs.slice(), trash: state.trash.slice() }),
  }
}
/** The library manager's store (ctx.lib). @public */
export type Library = ReturnType<typeof createLibrary>
