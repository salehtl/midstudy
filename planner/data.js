// midstudy planner data: the scenes on the server (GET /api/scenes, contract §4.4), polled while one calibrates, plus
// uploads with progress; and the furniture library manager's store (createLibrary, §2.8).
//
// createScenes({ engine }) → scenes
//   start()                 first refresh, then poll every 1.5 s while a scene is pending or running
//   refresh() → Promise     GET /api/scenes now (through the engine, which emits 'scenes')
//   getScenes()             the §4.4 scene objects, newest first;   getScene(name);   getState() { loaded, offline }
//   upload(file, { title, onProgress(loaded, total) }) → Promise<{ job, scene }>   POST /api/scenes (XHR, for progress)
//   rename(name, title) / remove(name)   PUT title / DELETE (moves it to scenes/.trash on the server)
// Events (scenes.events): 'scenes' { scenes }   'ready' { scene } a scene finished calibrating while this page was open
//   'failed' { scene }   'upload' { loaded, total, name } while a photo uploads
// Helpers: friendlyDate(iso|Date) ("Sun 26 Oct, 09:36"), relDate ("Today, 09:36"), clock, sceneTitle(scene), fmtBytes(n)
import { quiet } from './engine.js'

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad = (n) => String(n).padStart(2, '0')
const asDate = (when) => (when instanceof Date ? when : new Date(when))
export function friendlyDate(when) {
  const d = asDate(when)
  if (Number.isNaN(d.getTime())) return ''
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}, ${pad(d.getHours())}:${pad(d.getMinutes())}`
}
export const clock = (when) => { const d = asDate(when); return Number.isNaN(d.getTime()) ? '' : `${pad(d.getHours())}:${pad(d.getMinutes())}` }
export function relDate(when) {
  const d = asDate(when)
  if (Number.isNaN(d.getTime())) return ''
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 864e5)
  return diff === 0 ? `Today, ${clock(d)}` : diff === 1 ? `Yesterday, ${clock(d)}` : friendlyDate(d)
}
export const sceneTitle = (s) => (s?.title && String(s.title).trim()) || friendlyDate(s?.created) || s?.name || ''
export const fmtBytes = (n) => (!(n > 0) ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)

// §2.9: mutations carry X-Midstudy: 1.
const withMidstudy = (opts = {}) => (/^(POST|PUT|PATCH|DELETE)$/i.test(opts.method || 'GET') ? { ...opts, headers: { ...(opts.headers || {}), 'X-Midstudy': '1' } } : opts)
async function fetchJson(url, opts) {
  let res
  try { res = await fetch(url, withMidstudy(opts)) } catch (e) { const err = new Error(`could not reach ${url} (${e.message})`); err.offline = true; throw err }
  let body = null
  try { body = await res.json() } catch { /* not JSON */ }
  if (!res.ok) { const err = new Error(body?.error || `${url} returned HTTP ${res.status}`); err.status = res.status; err.body = body; throw err }
  return body
}
const b64json = (o) => { const bytes = new TextEncoder().encode(JSON.stringify(o)); let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s) }
const busy = (s) => s?.calib_status === 'pending' || s?.calib_status === 'running'

export function createScenes({ engine }) {
  const events = new EventTarget()
  const emit = (name, detail) => events.dispatchEvent(new CustomEvent(name, { detail }))
  const state = { loaded: false, offline: false }
  let list = []
  let timer = null
  const seen = new Map() // name -> last calib_status

  engine.events.addEventListener('scenes', (e) => {
    list = e.detail.scenes || []
    state.loaded = true
    state.offline = false
    for (const s of list) {
      const was = seen.get(s.name)
      if (busy({ calib_status: was }) && !busy(s)) emit(s.calib_status === 'done' ? 'ready' : 'failed', { scene: s })
      seen.set(s.name, s.calib_status)
    }
    emit('scenes', { scenes: list.slice() })
    schedule()
  })
  function schedule() {
    clearTimeout(timer)
    if (list.some(busy)) timer = setTimeout(() => quiet(refresh()), 1500)
  }
  async function refresh() {
    try { await engine.listScenesInternal() } catch (e) { state.offline = true; emit('scenes', { scenes: list.slice() }); clearTimeout(timer); timer = setTimeout(() => quiet(refresh()), 10000); throw e }
  }
  function upload(file, { title = null, onProgress = null } = {}) {
    if (!(file instanceof Blob)) return Promise.reject(engine.reportError('Pick a photo first'))
    const name = (file.name || 'photo.jpg').replace(/[^\x20-\x7e]/g, '_')
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest()
      xhr.open('POST', '/api/scenes')
      xhr.setRequestHeader('X-Midstudy', '1')
      xhr.setRequestHeader('X-Midstudy-Filename', name)
      if (title && title.trim()) xhr.setRequestHeader('X-Midstudy-Meta', b64json({ title: title.trim() }))
      xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream')
      xhr.upload.onprogress = (e) => { onProgress?.(e.loaded, e.total || file.size); emit('upload', { loaded: e.loaded, total: e.total || file.size, name }) }
      xhr.onerror = () => reject(engine.reportError("Couldn't upload the photo: the server isn't answering"))
      xhr.onload = () => {
        let body = null
        try { body = JSON.parse(xhr.responseText) } catch { /* not JSON */ }
        if (xhr.status !== 202 || !body?.scene) {
          const why = body?.error || `HTTP ${xhr.status}`
          reject(engine.reportError(xhr.status === 413 ? `That photo is too big: ${why}` : `Couldn't make a scene from that photo: ${why}`))
          return
        }
        seen.set(body.scene, 'pending')
        quiet(refresh())
        resolve(body)
      }
      xhr.send(file)
    })
  }
  const rename = (name, title) => engine.renameScene(name, title)
  const remove = (name) => engine.deleteScene(name)
  return {
    events, start: () => refresh(), refresh, upload, rename, remove,
    getScenes: () => list.slice(), getScene: (name) => list.find((s) => s.name === name) || null, getState: () => ({ ...state }),
  }
}

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
// Events (lib.events): 'jobs' { jobs }   'job-done' { job }   'job-failed' { job }   'spend' { spend }   'trash' { trash }
// Actions reject with a reported error; a library change reloads the engine's library.
// idol is the default image engine (contract §2.8, §3.2): $0.10, a splat with a stand-in box.
export const LIB_PRICE = { glb: 0, rug: 0, idol: 0.1, sam3d: 0.02, trellis2: { 512: 0.25, 1024: 0.3, 1536: 0.35 } }
export const DEFAULT_IMAGE_ENGINE = 'idol'
export const MODEL_EXT = /\.(glb|zip|gltf|usdz|obj|fbx)$/i
export function estimateCost(meta = {}, kind = 'image') {
  if (kind === 'model') return 0
  const p = LIB_PRICE[meta.engine || DEFAULT_IMAGE_ENGINE]
  return typeof p === 'object' ? (p[Number(meta.resolution) || 512] ?? p[512]) : p ?? 0
}

export function createLibrary({ engine = null } = {}) {
  const events = new EventTarget()
  const emit = (name, detail) => events.dispatchEvent(new CustomEvent(name, { detail }))
  const report = (msg, e) => (engine ? engine.reportError(msg, e) : new Error(`${msg}: ${e?.message || e}`))
  const custom = typeof location !== 'undefined' && new URLSearchParams(location.search).has('library')
  const state = { api: custom ? false : null, jobs: [], trash: [], spend: null }
  const status = new Map() // job id → last status seen
  let timer = null

  const reload = () => engine?.reloadLibrary?.()
  function setJobs(list) {
    const next = Array.isArray(list) ? list : []
    for (const j of next) {
      const before = status.get(j.id)
      if (before && before !== j.status) {
        if (j.status === 'done') { quiet(reload()); emit('job-done', { job: j }); quiet(spend()) }
        if (j.status === 'failed') { emit('job-failed', { job: j }); quiet(spend()) }
      }
      status.set(j.id, j.status)
    }
    state.jobs = next
    emit('jobs', { jobs: next.slice() })
    schedule()
  }
  function track(job) {
    if (!job?.id) return job
    if (!status.has(job.id)) status.set(job.id, job.status)
    state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)]
    emit('jobs', { jobs: state.jobs.slice() })
    schedule()
    return job
  }
  const busy = () => state.jobs.some((j) => j.status === 'queued' || j.status === 'running')
  function schedule() {
    clearTimeout(timer)
    if (busy()) timer = setTimeout(() => { quiet(jobs()) }, 1500)
  }
  const quiet = (p) => { Promise.resolve(p).catch(() => {}) }

  async function jobs() {
    let body
    try { body = await fetchJson('/api/library/jobs') } catch (e) { schedule(); throw report('Could not list the library jobs', e) }
    setJobs(body?.jobs)
    return state.jobs.slice()
  }
  async function spend() {
    let body
    try { body = await fetchJson('/api/spend') } catch (e) { throw report("Could not read today's spend", e) }
    state.spend = body
    emit('spend', { spend: body })
    return body
  }
  // §2.9 Settings: the daily fal budget. locked when the server was started with --daily-spend-usd.
  async function settings() {
    try { return await fetchJson('/api/settings') } catch (e) { throw report('Could not read the settings', e) }
  }
  async function setBudget(usd) {
    let body
    try {
      body = await fetchJson('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ daily_spend_usd: usd }) })
    } catch (e) { throw report('Could not save the daily budget', e) }
    quiet(spend())
    return body
  }
  async function refreshTrash() {
    try {
      const body = await fetchJson('/api/library')
      state.api = true
      state.trash = Array.isArray(body?.trash) ? body.trash : []
      emit('trash', { trash: state.trash.slice() })
    } catch (e) {
      if (e.status === 404 || e.status === 405 || e.status === 501) state.api = false
      emit('trash', { trash: state.trash.slice() })
    }
  }
  async function start() {
    if (custom) return
    await refreshTrash()
    if (state.api) await Promise.allSettled([jobs(), spend()])
  }

  const jobOf = (body) => {
    const job = body?.job && typeof body.job === 'object' ? { ...body.job } : body
    if (job && body?.cost_usd_estimate != null && job.cost_usd_estimate == null) job.cost_usd_estimate = body.cost_usd_estimate
    return job
  }
  const addError = (e) => (e.status === 402 ? "Not added: today's fal budget is used up" : e.status === 413 ? 'Not added: the file is too big'
    : e.status === 400 ? 'Not added' : e.offline ? "Not added: the server isn't answering" : 'Could not add the piece')
  async function addFromFile(file, meta = {}) {
    if (!(file instanceof Blob)) throw report('addItemFromFile needs a File')
    const name = file.name || 'upload'
    const kind = MODEL_EXT.test(name) ? 'model' : 'image'
    let body
    try {
      body = await fetchJson('/api/library/items', {
        method: 'POST', body: file,
        headers: { 'content-type': file.type || 'application/octet-stream', 'X-Midstudy-Kind': kind, 'X-Midstudy-Filename': name.replace(/[^\x20-\x7e]/g, '_'), 'X-Midstudy-Meta': b64json(meta) },
      })
    } catch (e) { quiet(spend()); throw report(addError(e), e) }
    quiet(spend())
    return track(jobOf(body))
  }
  async function addFromUrl(url, meta = {}) {
    let body
    try {
      body = await fetchJson('/api/library/items/from-url', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...meta, image_url: url }) })
    } catch (e) { quiet(spend()); throw report(addError(e), e) }
    quiet(spend())
    return track(jobOf(body))
  }
  // §2.11: what a shop's product page says (the 200 body); adds nothing. Rejects with the server's sentence, plus
  // err.status and err.blocked. A shop that blocks reading or a page without a product is the page's answer, shown in
  // the form, so only a server that isn't answering (or fails) is reported as an error.
  async function readProduct(url, { llm, html } = {}) {
    const req = {}
    if (String(url ?? '').trim()) req.url = String(url).trim()
    if (typeof html === 'string') req.html = html // a page the user's browser copied: the server fetches nothing
    if (typeof llm === 'boolean') req.llm = llm
    try {
      return await fetchJson('/api/library/product', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) })
    } catch (e) {
      const err = e.offline || e.status >= 500 ? report(e.offline ? "Couldn't read the page: the server isn't answering" : "Couldn't read the page", e)
        : new Error(e.body?.error || e.message)
      Object.assign(err, { status: e.status, blocked: !!e.body?.blocked, offline: !!e.offline })
      throw err
    }
  }
  async function edit(id, patch = {}) {
    let body
    try {
      body = await fetchJson(`/api/library/items/${encodeURIComponent(id)}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) })
    } catch (e) { throw report(e.offline ? "Not changed: the server isn't answering" : `Could not change "${id}"`, e) }
    if (body?.job) return track(jobOf(body))
    await reload()
    return body
  }
  async function remove(id) {
    try { await fetchJson(`/api/library/items/${encodeURIComponent(id)}`, { method: 'DELETE' }) } catch (e) {
      throw report(e.offline ? "Not removed: the server isn't answering" : `Could not remove "${id}" from the library`, e)
    }
    await Promise.allSettled([reload(), refreshTrash()])
  }
  async function restore(id) {
    let item
    try { item = await fetchJson(`/api/library/items/${encodeURIComponent(id)}/restore`, { method: 'POST' }) } catch (e) {
      throw report(e.status === 409 ? `"${id}" is in the library again: remove that one first` : e.status === 404 ? `"${id}" isn't in the library's trash` : `Could not restore "${id}"`, e)
    }
    await Promise.allSettled([reload(), refreshTrash()])
    return item
  }

  return {
    events, start, jobs, spend, settings, setBudget, addFromFile, addFromUrl, readProduct, edit, remove, restore, estimate: estimateCost,
    getState: () => ({ ...state, jobs: state.jobs.slice(), trash: state.trash.slice() }),
    refreshTrash,
  }
}
