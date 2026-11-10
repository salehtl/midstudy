#!/usr/bin/env node
// The planner engine's races (docs/notes/state-machines-plan.md, planner-engine): overlapping work driven through
// window.midstudyCtx.engine in headless Chrome against the real server (fal mocked, $0), with playwright's page.route
// for the server answers a race needs (a held, failed or forgotten request). Each section is one machine:
//   capture   two overlapping exports equal the same exports one after the other, the grid and the view come back;
//             two overlapping keep-room captures leave the pieces their own colours (not the mask's white)
//   align     the alignment is followed by its job id: a job the server forgot (404) ends in 'align-failed'
//   loop      a render failure is reported once per scene opened, not once per session
//   room view, placed pieces, captures, drag, library   the placement chain, uids, rebuilds, no attach or thumbnail
//             render inside a capture, guards, latest wins (--items stops after these)
//   scene …   open/close tokens, layouts by scope, dirty baselines, ruler, Look autosave, renders, camera, lists, startup
// Usage (repo root, through the lock): nix develop -c node scripts/eval-lock.mjs -- npm run eval:engine-races
import fs from 'node:fs'
import path from 'node:path'
import {
  PROBE, boxGlb, createEval, startServer, seedScene, uploadScene, unknownPhoto, waitScene, launchBrowser, openPlanner, ensureScene, hook, fmt, raw, sleep, waitFor, project,
} from '../../../evals/lib/harness.mjs'

const ev = createEval('ENGINE-RACES', 'engine-races', { timeoutS: 600 })
const srv = await startServer(ev)
ev.check('the server starts (calib stub + MIDSTUDY_CALIB_MOCK, scratch dirs, probe library)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const A = await seedScene(srv, 'living-wide')
const B = await seedScene(srv, 'steep-roll')
ev.check('two golden scenes calibrated', !A.why && !B.why, A.why || B.why || `${A.name}, ${B.name}`)
const browser = await launchBrowser(ev)
const P = await openPlanner(browser, srv.base, { scene: A.name })
ev.check('the planner opens the scene', P.hookOk, P.why || P.url)
if (!P.hookOk) await ev.finish()
const page = P.page
await ensureScene(page, A.name)
const added = await hook(page, 'addItem', [PROBE.id, { position: [0, 0, -2.6], rotation_y_deg: 0 }])
const uid = added.value?.uid ?? added.value
ev.check('a probe box is placed', typeof uid === 'string', added.error || fmt(added.value))
await page.evaluate(() => {
  const e = window.midstudyCtx.engine
  window.__races = { errors: [], room: [] }
  e.events.addEventListener('error', (x) => window.__races.errors.push(x.detail.text))
  e.events.addEventListener('room', (x) => window.__races.room.push(x.detail))
})

// --- capture ------------------------------------------------------------------------------------------------------------
ev.section('capture: the capture mutex (holding, withFullFrame, the mask swap)')
// an export as {w, h, px}: its size and a 32 × 18 downscale of it (RGB), to compare two exports by
const exportsOf = (overlap) => page.evaluate(async ({ overlap }) => {
  const e = window.midstudyCtx.engine
  const digest = (shot) => {
    const c = document.createElement('canvas')
    c.width = 32; c.height = 18
    const g = c.getContext('2d')
    g.drawImage(shot.canvas, 0, 0, 32, 18)
    return { w: shot.width, h: shot.height, px: Array.from(g.getImageData(0, 0, 32, 18).data) }
  }
  const asks = [{ encode: false }, { encode: false, longEdge: 800 }]
  const shots = overlap ? await Promise.all(asks.map((o) => e.exportImage(o))) : [await e.exportImage(asks[0]), await e.exportImage(asks[1])]
  return shots.map(digest)
}, { overlap })
const diff = (a, b) => (a.w !== b.w || a.h !== b.h ? Infinity : Math.max(...a.px.map((v, i) => Math.abs(v - b.px[i]))))
const one = await exportsOf(false)
const both = await exportsOf(true)
const d = [diff(one[0], both[0]), diff(one[1], both[1])]
ev.check('two overlapping exports equal the same exports one after the other (size, 32 × 18 downscale within 2 levels)', d.every((x) => x <= 2),
  `full ${both[0].w}×${both[0].h} vs ${one[0].w}×${one[0].h} (max |Δ| ${d[0]}); 800 px ${both[1].w}×${both[1].h} vs ${one[1].w}×${one[1].h} (max |Δ| ${d[1]})`)
const after = await page.evaluate((uid) => { const e = window.midstudyCtx.engine; return { grid: e.getGridVisible(), capturing: e.isCapturing(), rect: e.getScreenRect(uid) } }, uid)
ev.check('the grid is visible again afterwards, and no capture is left queued', after.grid === true && after.capturing === false, fmt(after))
const rectNow = await page.evaluate(async (uid) => { await new Promise((r) => requestAnimationFrame(() => r())); return window.midstudyCtx.engine.getScreenRect(uid) }, uid)
const fresh = await exportsOf(false)
ev.check('the view frames as before: getScreenRect unchanged and a later export equals the first', JSON.stringify(rectNow) === JSON.stringify(after.rect) && diff(fresh[0], one[0]) <= 2,
  `rect ${fmt(rectNow)}; later export max |Δ| ${diff(fresh[0], one[0])}`)

// two overlapping keep-room captures: the POST is refused here (nothing is sent to fal, nothing paid), the captures ran
await page.route('**/api/render', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'held by the race eval' }) }))
const twice = await page.evaluate(async () => {
  const e = window.midstudyCtx.engine
  const rs = await Promise.allSettled([e.renderViewInternal({ keepRoom: true }), e.renderViewInternal({ keepRoom: true })])
  return rs.map((r) => r.status)
})
await page.unroute('**/api/render')
const probe = await page.evaluate(async (uid) => {
  const e = window.midstudyCtx.engine
  const r = e.getScreenRect(uid)
  const shot = await e.exportImage({ encode: false })
  const g = shot.canvas.getContext('2d')
  const p = g.getImageData(Math.round(r.x + r.w / 2), Math.round(r.y + r.h / 2), 1, 1).data
  return [p[0], p[1], p[2]]
}, uid)
ev.check('after two overlapping keep-room captures the probe keeps its own colour (magenta, not the mask\'s white)', probe[1] < 128 && probe[0] > 128, `renders ${fmt(twice)}; pixel at the probe's centre ${fmt(probe)}`)

// --- loop ---------------------------------------------------------------------------------------------------------------
ev.section('loop: renderErrorReported is per scene')
const failures = () => page.evaluate(() => window.__races.errors.filter((t) => t.startsWith('Rendering failed')).length)
const base0 = await failures()
await page.evaluate(() => {
  window.__races.off = window.midstudyCtx.engine.onFrame(() => { throw new Error('a frame callback threw (race eval)') })
  window.dispatchEvent(new Event('pointermove'))
})
await sleep(600)
const n1 = (await failures()) - base0
const opened = await hook(page, 'openScene', [B.name])
await page.evaluate(() => window.dispatchEvent(new Event('pointermove')))
await sleep(600)
const n2 = (await failures()) - base0
await page.evaluate(() => window.__races.off())
ev.check('a throwing frame is reported once, then once more after another scene opens', n1 === 1 && n2 === 2, `${opened.error || 'opened'}; reports ${n1} then ${n2}`)

// --- align ----------------------------------------------------------------------------------------------------------------
ev.section('align: followAlign follows the job by its id')
const api = async (method, p, body) => { const r = await raw(srv.base, method, p, { headers: { 'X-Midstudy': '1', 'content-type': 'application/json' }, body: body === undefined ? null : JSON.stringify(body) }); return { status: r.status, json: r.json } }
const made = await api('POST', '/api/rooms', { title: 'Race room', scenes: [A.name, B.name] })
const ROOM = made.json?.name
ev.check('POST /api/rooms makes a room of the two scenes', made.status === 201 && !!ROOM, `${made.status} ${ROOM}`)
await waitFor(async () => !['pending', 'running'].includes((await api('GET', `/api/rooms/${ROOM}`)).json?.align_status), { timeoutMs: 30000 })
const op = await hook(page, 'openRoom', [ROOM])
ev.check('the planner opens the room', !op.error, op.error || 'opened')
let polls = 0
await page.route('**/api/rooms/jobs/*', (r) => {
  polls++
  const id = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop())
  if (polls === 1) return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id, kind: 'align', room: ROOM, status: 'running', created: new Date().toISOString(), started: new Date().toISOString(), finished: null, message: 'running', waiting_for: [], align: null }) })
  return r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: `no job ${id}` }) })
})
await page.evaluate(() => { window.__races.room.length = 0 })
const job = await page.evaluate(async (room) => { try { return { job: await window.midstudyCtx.engine.alignRoom(room) } } catch (e) { return { error: String(e?.message || e) } } }, ROOM)
ev.check('alignRoom is accepted with a job id', !!job.job?.id, job.error || fmt(job.job))
const ended = await waitFor(() => page.evaluate(() => window.__races.room.find((x) => x.phase === 'aligned' || x.phase === 'align-failed') ?? null), { timeoutMs: 20000 })
const seen = await page.evaluate(() => window.__races.room.map((x) => x.phase))
ev.check('a job the server forgot (one "running", then 404) ends in a "room" event with phase align-failed', ended?.phase === 'align-failed' && polls >= 2, `phases ${fmt(seen)}; job polls ${polls}`)
await page.unroute('**/api/rooms/jobs/*')

// --- the scene-scoped machines (planner-engine-scene) ---------------------------------------------------------------------
await waitFor(async () => !['pending', 'running'].includes((await api('GET', `/api/rooms/${ROOM}`)).json?.align_status), { timeoutMs: 30000 })
const C = await seedScene(srv, 'portrait')
const D = await seedScene(srv, 'living-cool')
ev.check('two more scenes for the scene sections', !C.why && !D.why, C.why || D.why || `${C.name}, ${D.name}`)
await page.evaluate(() => {
  const e = window.midstudyCtx.engine, R = window.__races
  R.scene = []; R.roomAll = []; R.ruler = []; R.render = []; R.lastScenes = null
  e.events.addEventListener('scene', (x) => R.scene.push(x.detail))
  e.events.addEventListener('room', (x) => R.roomAll.push(x.detail))
  e.events.addEventListener('ruler', (x) => R.ruler.push(x.detail))
  e.events.addEventListener('render', (x) => R.render.push(x.detail))
  e.events.addEventListener('scenes', (x) => { R.lastScenes = x.detail.scenes.map((s) => s.name) })
})
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const sceneRe = (n) => new RegExp(`/api/scenes/${esc(n)}(\\?.*)?$`)
const jsonOf = (r) => { try { return JSON.parse(r.postData() ?? 'null') } catch { return null } }
// Holds the requests `when` picks (the first `count`) until release(); the others go through. hits = how many were held.
async function hold(re, { method = 'GET', count = 1, when = () => true, ctx = page } = {}) {
  const parked = []
  let released = false
  const h = { hits: 0, release: () => { released = true; for (const go of parked.splice(0)) go() }, off: () => ctx.unroute(re, handler) }
  async function handler(route) {
    const req = route.request()
    if (req.method() !== method || h.hits >= count || released || !when(req)) return route.fallback()
    h.hits++
    await new Promise((go) => parked.push(go))
    return route.fallback()
  }
  await ctx.route(re, handler)
  return h
}
const hit = (h) => waitFor(() => h.hits > 0, { timeoutMs: 20000, intervalMs: 20 })

// --- resources ----------------------------------------------------------------------------------------------------------
ev.section('resources: the lighting backfill, the kernel worker, the occlusion flag')
{
  const json = (status, body) => ({ status, contentType: 'application/json', body: JSON.stringify(body) })
  const events = (p) => p.evaluate(() => { window.__lit = []; window.midstudyCtx.engine.events.addEventListener('lighting', (x) => window.__lit.push(x.detail)) })
  const scenePage = async (ctx) => {
    const p = await ctx.newPage()
    await p.goto(`${srv.base}/planner/`, { waitUntil: 'load' })
    await p.waitForFunction(() => !!window.midstudyCtx?.engine, null, { timeout: 30000 })
    await p.evaluate(() => window.midstudy.ready)
    return p
  }
  // the scene as a page sees it once its lighting is gone: `over` says what lighting_status the polls read
  const noLighting = (p, name, over) => p.route(sceneRe(name), async (r) => {
    if (r.request().method() !== 'GET') return r.fallback()
    const res = await r.fetch()
    const body = await res.json()
    return r.fulfill(json(200, { ...body, lighting: null, lighting_error: null, lighting_status: over() }))
  })
  {
    // a light job lost to a restart: POST answers 202 and the scene goes back to 'missing'
    const ctx = await browser.newContext()
    const p = await scenePage(ctx)
    await events(p)
    let posts = 0
    await p.route(new RegExp(`/api/scenes/${esc(B.name)}/light$`), (r) => { posts++; return r.fulfill(json(202, { job: { id: 'lost', kind: 'light', scene: B.name, status: 'queued' } })) })
    await noLighting(p, B.name, () => 'missing')
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, B.name)
    await waitFor(() => p.evaluate(() => window.__lit.at(-1)?.status === 'failed'), { timeoutMs: 8000, intervalMs: 100 })
    const lit = await p.evaluate(() => window.__lit)
    ev.check("a light job the server forgot ends in 'failed' with a reason", lit.at(-1)?.status === 'failed' && /lost/.test(lit.at(-1)?.error ?? ''), fmt(lit))
    ev.check('the autostart posted once', posts === 1, `${posts} POST(s)`)
    // leaving and coming back: the same 'missing' is not posted again (the backfill autostarts once per scene per page)
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, A.name)
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, B.name)
    await sleep(1500)
    ev.check('reopening the scene does not start the backfill again', posts === 1, `${posts} POST(s)`)
    const back = await p.evaluate(() => ({ status: window.midstudyCtx.engine.getLighting().status, last: window.__lit.at(-1) }))
    ev.check("reopening after the autostart reads 'failed', not a busy 'missing' nothing follows (the panel offers Infer lighting)", back.status === 'failed' && back.last?.status === 'failed' && !!back.last.error, fmt(back))
    await ctx.close()
  }
  {
    // a job in flight is followed when a recalibration or a reopen reads it
    const ctx = await browser.newContext()
    const p = await scenePage(ctx)
    let status = 'none'
    await noLighting(p, B.name, () => status)
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, B.name)
    await events(p)
    const follows = async (what, act) => {
      status = 'pending'
      await p.evaluate(() => { window.__lit.length = 0 })
      await act()
      await waitFor(() => p.evaluate(() => window.__lit.at(-1)?.status === 'pending'), { timeoutMs: 20000, intervalMs: 50 })
      status = 'none'
      await waitFor(() => p.evaluate(() => window.__lit.at(-1)?.status === 'none'), { timeoutMs: 8000, intervalMs: 100 }).catch(() => undefined)
      const lit = await p.evaluate(() => window.__lit)
      ev.check(`${what} reading 'pending' polls until the job ends`, lit.at(-1)?.status === 'none', fmt(lit))
    }
    await follows('a recalibration', () => p.evaluate(() => window.midstudyCtx.engine.recalibrate()))
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, A.name)
    await follows('a reopen', () => p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, B.name))
    await ctx.close()
  }
  {
    // the POST failing after a newer run of the same scene (left and came back) leaves that run's status
    const ctx = await browser.newContext()
    const p = await scenePage(ctx)
    await p.route(new RegExp(`/api/scenes/${esc(B.name)}/light$`), (r) => r.fulfill(json(500, { error: { code: 'INTERNAL', message: 'failed on purpose' } })))
    const light = await hold(new RegExp(`/api/scenes/${esc(B.name)}/light$`), { method: 'POST', ctx: p })
    await noLighting(p, B.name, () => 'none')
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, B.name)
    await events(p)
    void p.evaluate(() => window.midstudyCtx.engine.inferLighting().catch(() => undefined))
    await hit(light)
    await p.evaluate(async (n) => { const e = window.midstudyCtx.engine; await e.openScene(n[0]); await e.openScene(n[1]) }, [A.name, B.name])
    light.release()
    await sleep(400)
    const seen = await p.evaluate(() => ({ lit: window.__lit, status: window.midstudyCtx.engine.getLighting().status }))
    ev.check("a POST /light failing after the same scene was reopened leaves the newer status", seen.status === 'none' && !seen.lit.some((x) => x.status === 'failed'), fmt(seen))
    await ctx.close()
  }
  {
    // two calls while one runs share it; the POST failing after the scene changed leaves the newer status alone
    const ctx = await browser.newContext()
    const p = await scenePage(ctx)
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, B.name)
    await events(p)
    let posts = 0
    let status = 'pending'
    await p.route(new RegExp(`/api/scenes/${esc(B.name)}/light$`), (r) => { posts++; return r.fulfill(json(202, { job: { id: 'j', kind: 'light', scene: B.name, status: 'queued' } })) })
    await noLighting(p, B.name, () => status)
    const both = p.evaluate(async () => { const e = window.midstudyCtx.engine; const a = e.inferLighting(); const b = e.inferLighting(); await Promise.all([a, b]); return true })
    await sleep(900)
    status = 'none'
    await both
    ev.check('two overlapping inferLighting calls post once', posts === 1, `${posts} POST(s)`)
    await ctx.close()
  }
  {
    const ctx = await browser.newContext()
    const p = await scenePage(ctx)
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, B.name)
    await events(p)
    await p.route(new RegExp(`/api/scenes/${esc(B.name)}/light$`), (r) => r.fulfill(json(500, { error: { code: 'INTERNAL', message: 'failed on purpose' } })))
    const light = await hold(new RegExp(`/api/scenes/${esc(B.name)}/light$`), { method: 'POST', ctx: p }) // on top of the 500
    await noLighting(p, B.name, () => 'missing')
    void p.evaluate(() => window.midstudyCtx.engine.inferLighting().catch(() => undefined))
    await hit(light)
    await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n) }, A.name)
    const before = await p.evaluate(() => window.midstudyCtx.engine.getLighting().status ?? null)
    light.release()
    await sleep(400)
    const seen = await p.evaluate(() => ({ lit: window.__lit, status: window.midstudyCtx.engine.getLighting().status ?? null }))
    ev.check('a POST /light failing after the scene changed leaves the new scene\'s status', !seen.lit.some((x) => x.status === 'failed') && seen.status === before, fmt(seen))
    await ctx.close()
  }
  {
    // a kernel worker that never answers: depth falls back to the main thread instead of hanging the open
    const ctx = await browser.newContext()
    await ctx.route(/engine\.worker\.js(\?.*)?$/, (r) => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'self.onmessage = () => undefined' }))
    const p = await scenePage(ctx)
    const t0 = Date.now()
    const r = await Promise.race([
      p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n); return window.midstudy.getState().scene }, A.name),
      sleep(40000).then(() => null),
    ])
    ev.check('a hung kernel worker: the scene still opens with its depth (main thread, within 20 s + the decode)', r?.hasDepth === true, `${Date.now() - t0} ms; ${fmt(r)}`)
    if (r !== null) {
      const t1 = Date.now()
      const again = await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n); return window.midstudy.getState().scene.hasDepth }, B.name)
      ev.check('the next depth decode does not wait for the worker again', again === true && Date.now() - t1 < 15000, `${Date.now() - t1} ms`)
    }
    await ctx.close()
  }
  {
    // occlusion reports what is drawn
    const up = await uploadScene(srv.base, unknownPhoto(), { filename: 'no-depth.jpg', title: 'no depth' })
    const name = up.json?.scene
    const sN = await waitScene(srv.base, name)
    ev.check('a scene without depth', sN?.calib_status === 'done' && sN.depth_url === null, fmt({ status: sN?.calib_status, depth_url: sN?.depth_url }))
    const ctx = await browser.newContext()
    const p = await scenePage(ctx)
    const seen = await p.evaluate(async (n) => {
      const e = window.midstudyCtx.engine
      await e.openScene(n)
      const on = []
      e.events.addEventListener('occlusion', (x) => on.push(x.detail.on))
      e.setOcclusion(true)
      return { on, state: window.midstudy.getState().scene.occlusion, get: e.getOcclusion() }
    }, name)
    ev.check('setOcclusion(true) without depth reports occlusion off (state, getter, event)', seen.state === false && seen.get === false && seen.on.at(-1) === false, fmt(seen))
    // recalibrate answers with no depth any more: occlusion goes off
    const q = await p.evaluate(async (n) => { await window.midstudyCtx.engine.openScene(n); return window.midstudy.getState().scene }, A.name)
    await p.route(new RegExp(`/api/scenes/${esc(A.name)}/calibrate$`), (r) => r.fulfill(json(202, { job: { id: 'j2', kind: 'calibrate', scene: A.name, status: 'done' } })))
    await p.route(/\/api\/scenes\/jobs\/j2$/, (r) => r.fulfill(json(200, { id: 'j2', status: 'done' })))
    await p.route(sceneRe(A.name), async (r) => {
      if (r.request().method() !== 'GET') return r.fallback()
      const res = await r.fetch()
      return r.fulfill(json(200, { ...(await res.json()), depth_url: null }))
    })
    const after = await p.evaluate(async () => {
      const e = window.midstudyCtx.engine
      const on = []
      e.events.addEventListener('occlusion', (x) => on.push(x.detail.on))
      await e.recalibrate()
      return { on, scene: window.midstudy.getState().scene }
    })
    ev.check('a recalibration that loses the depth turns occlusion off', q.occlusion === true && after.scene.hasDepth === false && after.scene.occlusion === false && after.on.at(-1) === false, fmt(after))
    await ctx.close()
  }
  if (process.argv.includes('--resources')) await ev.finish()
}
// Serves the scene's own answer with calib_status replaced while `busy()` holds; counts GETs.
async function busyScene(n, busy) {
  const re = sceneRe(n)
  const c = { gets: 0, off: () => page.unroute(re, handler) }
  async function handler(route) {
    if (route.request().method() !== 'GET') return route.fallback()
    c.gets++
    if (!busy()) return route.fallback()
    const res = await route.fetch()
    return route.fulfill({ response: res, json: { ...(await res.json()), calib_status: 'running' } })
  }
  await page.route(re, handler)
  return c
}
const E = (fn, arg) => page.evaluate(fn, arg)
const openS = (n) => E(async (n) => { await window.midstudyCtx.engine.openScene(n) }, n)
const clearLog = () => E(() => { const R = window.__races; R.scene.length = 0; R.roomAll.length = 0; R.ruler.length = 0; R.render.length = 0 })

const addProbeHere = (at) => E(async ({ id, at }) => window.midstudyCtx.engine.addItemInternal(id, { position: at, rotation_y_deg: 0 }), { id: PROBE.id, at })
// --- the pieces and the room view (planner-engine-items); `--items` stops after these ------------------------------------
{
  const libFile = path.join(srv.dirs.library, 'library.json')
  const readLib = () => JSON.parse(fs.readFileSync(libFile, 'utf8'))
  const writeLib = (l) => fs.writeFileSync(libFile, JSON.stringify(l, null, 2))
  const baseGlb = path.join(srv.dirs.library, PROBE.id, 'model.glb')
  // a new library entry (the planner's GLB cache hasn't seen its URL, so a held GET really holds its load)
  const fresh = (id, { thumb = true } = {}) => {
    const lib = readLib()
    const base = lib.items[0]
    const dir = path.join(srv.dirs.library, id)
    fs.mkdirSync(dir, { recursive: true })
    fs.copyFileSync(baseGlb, path.join(dir, 'model.glb'))
    const assets = { ...base.assets, glb: `${id}/model.glb` }
    delete assets.thumb
    if (thumb) { fs.writeFileSync(path.join(dir, 'thumb.jpg'), 'x'); assets.thumb = `${id}/thumb.jpg` }
    lib.items.push({ ...base, id, name: id, assets })
    writeLib(lib)
  }
  // the entry's GLB moves to model2.glb (a re-add, as far as the planner can tell)
  const repoint = (id) => {
    fs.copyFileSync(baseGlb, path.join(srv.dirs.library, id, 'model2.glb'))
    const lib = readLib()
    lib.items.find((x) => x.id === id).assets.glb = `${id}/model2.glb`
    writeLib(lib)
  }
  // the server only serves the file names the contract knows: the moved GLB is answered here
  await page.route(/\/model2\.glb/, (r) => r.fulfill({ path: baseGlb, contentType: 'model/gltf-binary' }))
  const reload = () => E(async () => { await window.midstudyCtx.engine.reloadLibrary() })
  const glbOf = (id, file = 'model.glb') => new RegExp(`/${esc(id)}/${esc(file)}`)
  const trio = async (tag) => { const ids = [0, 1, 2].map((i) => `race-${tag}${i}`); ids.forEach((id) => fresh(id)); await reload(); return { ids, re: new RegExp(`/race-${tag}\\d/model\\.glb`) } }
  const layoutCount = () => E(() => window.midstudyCtx.engine.getLayoutItems().length)
  const roomOf = () => E(() => { const s = window.midstudyCtx.engine.getRoomState(); return { photo: s.photo, unplaced: s.unplaced, alignPhotos: s.alignPhotos, floorPlan: s.floorPlan } })
  const preview = (scene, pose) => E(({ scene, pose }) => window.midstudyCtx.engine.previewPose(scene, pose), { scene, pose })
  const settled = (n, unplaced) => waitFor(async () => (await layoutCount()) === n && (await roomOf()).unplaced === unplaced, { timeoutMs: 6000, intervalMs: 50 })
  const clear = () => E(() => { window.midstudyCtx.engine.clearItemsInternal() })
  await E(() => {
    const e = window.midstudyCtx.engine, R = window.__races
    R.drag = []; R.renders = []
    e.events.addEventListener('drag', (x) => R.drag.push(x.detail.phase))
    e.events.addEventListener('items', (x) => { if (x.detail.change === 'render') R.renders.push(x.detail.uid) })
  })

  ev.section('room view: the placement chain')
  const POSE_A = { x_m: 0, z_m: 0, yaw_deg: 0 }, POSE_B = { x_m: 0.5, z_m: 0, yaw_deg: 10 }
  await E(async ({ r, a, b, pa, pb }) => {
    const e = window.midstudyCtx.engine
    await e.openRoom(r, a)
    e.clearItemsInternal()
    await e.setPose(a, { ...pa, scale: 1 })
    await e.setPose(b, { ...pb, scale: 1 })
  }, { r: ROOM, a: A.name, b: B.name, pa: POSE_A, pb: POSE_B })
  await addProbeHere([0, 0, -2.6])
  await E(async () => { await window.midstudyCtx.engine.saveLayoutInternal('race-tpl') })
  const tpl = (await api('GET', `/api/layouts/race-tpl?room=${ROOM}`)).json
  await clear()
  const putThree = async (name, ids) => {
    const items = ids.map((id, i) => ({ ...tpl.items[0], uid: `${name}-${i}`, id, position: [i * 0.9 - 0.9, 0, -2.6], rotation_y_deg: 0 }))
    const res = await api('PUT', `/api/layouts/${name}?room=${ROOM}`, { ...tpl, name, items })
    if (res.status !== 200) ev.check(`layout ${name} stored`, false, `${res.status} ${fmt(res.json)}`)
    return items
  }
  const load = (name) => E((n) => window.midstudyCtx.engine.loadLayoutInternal(n), name)
  {
    const { ids, re } = await trio('a')
    await putThree('race-a', ids)
    await preview(A.name, null)
    await load('race-a')
    const h = await hold(re, { count: 99 })
    await preview(A.name, POSE_A)
    await hit(h)
    await preview(A.name, null)
    await sleep(300)
    h.release()
    const ok = await settled(3, true)
    await h.off()
    ev.check('a park during an unpark loses no piece (3 parked)', !!ok, `layout pieces ${await layoutCount()}; ${fmt(await roomOf())}`)
    await preview(A.name, POSE_A)
    await settled(3, false)
    await clear()
  }
  {
    const { ids, re } = await trio('b')
    const items = await putThree('race-b', ids)
    await preview(A.name, null)
    await load('race-b')
    const h = await hold(re, { count: 99 })
    const moved = { x_m: 0.3, z_m: -0.2, yaw_deg: 8 }
    await preview(A.name, POSE_A)
    await hit(h)
    await preview(A.name, moved)
    await sleep(300)
    h.release()
    await settled(3, false)
    await sleep(300)
    await h.off()
    const got = await E((uids) => { const e = window.midstudyCtx.engine; return { cam: e.getCamera(), size: e.getPhotoSize(), rects: uids.map((u) => e.getScreenRect(u)) } }, items.map((x) => x.uid))
    const a = moved.yaw_deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
    const toScene = (p) => { const x = p[0] - moved.x_m, z = p[2] - moved.z_m; return [c * x - s * z, p[1], s * x + c * z] }
    const { w: bw, h: bh, d: bd } = PROBE.dims_cm
    const errs = items.map((it, i) => {
      const pts = []
      for (const lx of [-bw / 200, bw / 200]) for (const ly of [0, bh / 100]) for (const lz of [-bd / 200, bd / 200]) pts.push(toScene([it.position[0] + lx, ly, it.position[2] + lz]))
      const q = pts.map((p) => project(got.cam, got.size.w, got.size.h, p))
      const xs = q.map((v) => v.px), ys = q.map((v) => v.py)
      const r = got.rects[i]
      return r ? Math.max(Math.abs(r.x - Math.min(...xs)), Math.abs(r.y - Math.min(...ys)), Math.abs(r.w - (Math.max(...xs) - Math.min(...xs))), Math.abs(r.h - (Math.max(...ys) - Math.min(...ys)))) : Infinity
    })
    ev.check('a pose moved during an unpark: every piece lands where the final pose sees it (3 px)', errs.length === 3 && errs.every((x) => x <= 3), fmt(errs))
    await preview(A.name, POSE_A)
    await sleep(100)
    await clear()
  }
  {
    const { ids, re } = await trio('c')
    await putThree('race-c', ids)
    await preview(B.name, null)
    const h = await hold(re, { count: 99 })
    await E(() => { window.__races.ld = window.midstudyCtx.engine.loadLayoutInternal('race-c').catch((x) => String(x)) })
    await hit(h)
    await E((b) => { window.__races.sw = window.midstudyCtx.engine.setRoomPhoto(b).catch((x) => String(x)) }, B.name)
    await sleep(300)
    h.release()
    await E(() => Promise.all([window.__races.ld, window.__races.sw]))
    const ok = await settled(3, true)
    await h.off()
    ev.check('a switch to an unplaced photo during a room layout load parks every piece', !!ok && (await roomOf()).photo === B.name, `layout pieces ${await layoutCount()}; ${fmt(await roomOf())}`)
    await E(({ a }) => window.midstudyCtx.engine.setRoomPhoto(a), { a: A.name })
    await preview(B.name, POSE_B)
    await settled(3, false)
    await clear()
  }
  {
    const u = await addProbeHere([0, 0, -2.6])
    const res = await E(async ({ u, a, pa }) => {
      const e = window.midstudyCtx.engine
      const [x, y] = e.floorToPhoto([0, 0, -2.6]); const s = e.getPhotoSize(), r = e.getPhotoRect()
      const cx = r.x + (x / s.w) * r.w, cy = r.y + (y / s.h) * r.h
      const at0 = e.getLayoutItems().find((i) => i.uid === u).at
      const began = e.beginItemDrag(u, cx, cy)
      await e.setPose(a, { x_m: 0.4, z_m: 0, yaw_deg: 0, scale: 1 })
      const during = e.getDrag()
      e.dragTo(cx + 120, cy)
      const at1 = e.getLayoutItems().find((i) => i.uid === u).at
      e.endItemDrag()
      await e.setPose(a, { ...pa, scale: 1 })
      return { began, during, at0, at1 }
    }, { u, a: A.name, pa: POSE_A })
    ev.check('a pose saved during a drag ends the drag; the piece stays put in the room', res.began && res.during === null && Math.abs(res.at0.x - res.at1.x) < 1e-6 && Math.abs(res.at0.z - res.at1.z) < 1e-6, fmt(res))
    const plan = await E(() => {
      const e = window.midstudyCtx.engine
      const toggle = () => document.querySelector('[data-midstudy=floor-plan-toggle]').click()
      if (!e.getRoomState().floorPlan) toggle()
      const shown = e.getRoomState().floorPlan
      e.setAlignPhotos(true)
      const onShown = e.getRoomState().alignPhotos
      const uid = e.getItems()[0].uid
      const rect = e.getPhotoRect()
      const drag = e.beginItemDrag(uid, rect.x + rect.w / 2, rect.y + rect.h / 2)
      e.setAlignPhotos(false)
      toggle()
      const hidden = e.getRoomState().floorPlan
      e.setAlignPhotos(true)
      const onHidden = e.getRoomState().alignPhotos
      e.setAlignPhotos(false)
      toggle()
      return { shown, onShown, drag, hidden, onHidden }
    })
    ev.check('Align photos needs the floor plan shown, and refuses piece drags', plan.shown && plan.onShown && !plan.drag && !plan.hidden && !plan.onHidden, fmt(plan))
    await clear()
  }
  {
    // an add started on photo A whose model lands after a switch to photo B (both placed): the piece keeps the room place
    // it was given on A, so B draws it where B sees that place, not at A's scene position
    fresh('race-sw'); await reload()
    const at = [0.3, 0, -2.4]
    const want = await E(({ at, a, b }) => { const e = window.midstudyCtx.engine; return e.roomToSceneHook(e.sceneToRoomHook(at, a), b) }, { at, a: A.name, b: B.name })
    const h = await hold(glbOf('race-sw'), { count: 99 })
    await E((at) => { window.__races.swAdd = window.midstudyCtx.engine.addItemInternal('race-sw', { position: at, rotation_y_deg: 0 }).catch((x) => String(x)) }, at)
    await hit(h)
    await E((b) => window.midstudyCtx.engine.setRoomPhoto(b), B.name)
    h.release()
    const u = await E(() => window.__races.swAdd)
    await h.off()
    const s = await E((u) => { const e = window.midstudyCtx.engine; return { photo: e.getRoomState().photo, pos: e.getItem(u)?.position ?? null } }, u)
    const off = (p, q) => Math.max(...p.map((v, i) => Math.abs(v - q[i])))
    ev.check('an add started before a room photo switch lands where the new photo sees its room place, not at the old scene position',
      s.photo === B.name && !!s.pos && !!want && off(s.pos, want) < 1e-4 && off(s.pos, at) > 0.05, `${fmt(s)}; want ${fmt(want)}; started at ${fmt(at)}`)
    await E((a) => window.midstudyCtx.engine.setRoomPhoto(a), A.name)
    await clear()
  }
  for (const n of ['race-tpl', 'race-a', 'race-b', 'race-c']) await E((n) => window.midstudyCtx.engine.deleteLayoutInternal(n).catch(() => undefined), n)
  await E(() => window.midstudyCtx.engine.closeScene())
  await openS(A.name)

  ev.section('placed pieces: uids, rebuilds')
  {
    fresh('race-dup'); await reload()
    const h = await hold(glbOf('race-dup'), { count: 99 })
    await E(() => { window.__races.dup = window.midstudyCtx.engine.restoreItems([0, 1].map(() => ({ uid: 'dup-1', id: 'race-dup', name: 'dup', position: [0, 0, -2.6], rotation_y_deg: 0 }))).catch((x) => String(x)) })
    await hit(h)
    await sleep(200)
    h.release()
    await E(() => window.__races.dup)
    await h.off()
    const s = await E(() => { const e = window.midstudyCtx.engine; return { uids: e.getItems().map((i) => i.uid), groups: e.getItemGroupCount() } })
    ev.check('two adds with one uid: two pieces, distinct uids, nothing orphaned in the scene', s.uids.length === 2 && new Set(s.uids).size === 2 && s.groups === 2, fmt(s))
    await clear()
  }
  const newest = (id) => E((id) => window.midstudyCtx.engine.getItems().find((i) => i.id === id)?.lib?.assets?.glb ?? null, id)
  const rendersOf = () => E(() => window.__races.renders.length)
  {
    fresh('race-rb'); await reload()
    await E(() => window.midstudyCtx.engine.addItemInternal('race-rb', { position: [0, 0, -2.6], rotation_y_deg: 0 }))
    repoint('race-rb')
    const r0 = await rendersOf()
    let fails = 0
    const re = glbOf('race-rb', 'model2.glb')
    const gone = (r) => { fails++; return r.fulfill({ status: 404, body: 'gone' }) }
    await page.route(re, gone)
    await reload()
    await waitFor(() => fails > 0, { timeoutMs: 6000, intervalMs: 30 })
    await sleep(300)
    await page.unroute(re, gone)
    await reload()
    await waitFor(async () => (await rendersOf()) > r0, { timeoutMs: 6000, intervalMs: 30 })
    const g = await newest('race-rb')
    ev.check('a rebuild that failed is tried again on the next library read', g === 'race-rb/model2.glb' && (await rendersOf()) > r0, `glb ${g}; 404s ${fails}; rebuilds ${(await rendersOf()) - r0}; errors ${fmt(await E(() => window.__races.errors.slice(-3)))}`)
    await clear()
  }
  {
    fresh('race-late'); await reload()
    const r0 = await rendersOf()
    const h = await hold(glbOf('race-late'), { count: 99 })
    await E(() => { window.__races.add = window.midstudyCtx.engine.addItemInternal('race-late', { position: [0, 0, -2.6], rotation_y_deg: 0 }).catch((x) => String(x)) })
    await hit(h)
    repoint('race-late')
    await reload()
    h.release()
    await E(() => window.__races.add)
    await h.off()
    await waitFor(async () => (await rendersOf()) > r0, { timeoutMs: 6000, intervalMs: 30 })
    const g = await newest('race-late')
    ev.check('a library change during a piece\'s load: the piece ends on the new asset', g === 'race-late/model2.glb', `glb ${g}; rebuilds ${(await rendersOf()) - r0}; errors ${fmt(await E(() => window.__races.errors.slice(-3)))}`)
    await clear()
  }
  {
    // an add whose model lands after another scene opened is cancelled (itemsGen): nothing of it in the new scene
    fresh('race-gone'); await reload()
    const h = await hold(glbOf('race-gone'), { count: 99 })
    await E(() => { window.__races.gone = window.midstudyCtx.engine.addItemInternal('race-gone', { position: [0, 0, -2.6], rotation_y_deg: 0 }).then((u) => u, (x) => `rejected: ${String(x?.message ?? x)}`) })
    await hit(h)
    await openS(C.name)
    h.release()
    const r = await E(() => window.__races.gone)
    await h.off()
    const s = await E(() => { const e = window.midstudyCtx.engine; return { scene: e.getSceneName(), ids: e.getItems().map((i) => i.id), groups: e.getItemGroupCount() } })
    ev.check('an add started before another scene opened does not land in it (rejected, nothing in the new scene)', r.startsWith('rejected') && s.scene === C.name && !s.ids.includes('race-gone') && s.groups === s.ids.length, `${r}; ${fmt(s)}`)
    await openS(A.name)
    await clear()
  }

  ev.section('captures: nothing attaches, and no thumbnail renders, while one runs')
  await E(() => {
    const e = window.midstudyCtx.engine, R = window.__races
    R.att = [] // every attach (an add, a rebuild), and whether a capture was queued or running at that moment
    e.events.addEventListener('items', (x) => { if (x.detail.change === 'add' || x.detail.change === 'render') R.att.push({ change: x.detail.change, uid: x.detail.uid, capturing: e.isCapturing() }) })
    R.digest = (c) => { const k = document.createElement('canvas'); k.width = 32; k.height = 18; const g = k.getContext('2d'); g.drawImage(c, 0, 0, 32, 18); return Array.from(g.getImageData(0, 0, 32, 18).data) }
    // captures kept queued back to back (the next one always waiting behind the running one), until R.stop or `ms`: the
    // capture mutex never empties meanwhile. R.pumped: every capture's result.
    R.pump = (make, ms) => {
      R.stop = false
      R.pumped = (async () => {
        const out = [], until = performance.now() + ms
        let prev = make()
        while (!R.stop && performance.now() < until) { const next = make(); out.push(await prev); prev = next }
        out.push(await prev)
        return out
      })()
    }
  })
  const exportPump = (ms) => E((ms) => { const e = window.midstudyCtx.engine, R = window.__races; R.pump(() => e.exportImage({ encode: false, longEdge: 480 }).then((s) => R.digest(s.canvas)), ms) }, ms)
  const shot = () => E(async () => window.__races.digest((await window.midstudyCtx.engine.exportImage({ encode: false, longEdge: 480 })).canvas))
  const pxDiff = (a, b) => Math.max(...a.map((v, i) => Math.abs(v - b[i])))
  const attOf = (u, change) => E(({ u, change }) => window.__races.att.filter((x) => x.uid === u && x.change === change), { u, change })
  {
    await clear()
    fresh('race-cap'); await reload()
    const base = await shot()
    const h = await hold(glbOf('race-cap'), { count: 99 })
    await E(() => { window.__races.capAdd = window.midstudyCtx.engine.addItemInternal('race-cap', { position: [0, 0, -2.6], rotation_y_deg: 0 }).catch((x) => String(x)) })
    await hit(h)
    await exportPump(2500)
    h.release()
    const shots = await E(() => window.__races.pumped)
    const u = await E(() => window.__races.capAdd)
    await h.off()
    const att = await attOf(u, 'add')
    const drawn = await shot()
    const worst = Math.max(...shots.map((s) => pxDiff(s, base)))
    ev.check('an add whose model loads during a run of captures: in none of them, attached once they end (and drawn then)',
      typeof u === 'string' && shots.length >= 3 && worst <= 2 && att.length === 1 && att[0].capturing === false && pxDiff(drawn, base) > 40,
      `${shots.length} captures, max |Δ| from before the add ${worst}; attach ${fmt(att)}; after the run |Δ| ${pxDiff(drawn, base)}`)
    await clear()
  }
  {
    // a rebuild (the entry re-pointed to a bigger green box) whose model loads during a run of captures
    fresh('race-capr'); await reload()
    const u = await E(() => window.midstudyCtx.engine.addItemInternal('race-capr', { position: [0, 0, -2.6], rotation_y_deg: 0 }))
    const base = await shot()
    const re = glbOf('race-capr', 'model2.glb')
    const green = (r) => r.fulfill({ body: boxGlb(1.6, 1.4, 0.6, [0, 1, 0, 1]), contentType: 'model/gltf-binary' })
    await page.route(re, green)
    const h = await hold(re, { count: 99 })
    repoint('race-capr')
    await reload()
    await hit(h)
    await exportPump(2500)
    h.release()
    const shots = await E(() => window.__races.pumped)
    await h.off()
    await waitFor(async () => (await attOf(u, 'render')).length > 0, { timeoutMs: 6000, intervalMs: 30 })
    const att = await attOf(u, 'render')
    const drawn = await shot()
    await page.unroute(re, green)
    const worst = Math.max(...shots.map((s) => pxDiff(s, base)))
    const g = await newest('race-capr')
    ev.check('a rebuild whose model loads during a run of captures: in none of them, attached once they end (and drawn then)',
      g === 'race-capr/model2.glb' && shots.length >= 3 && worst <= 2 && att.length === 1 && att[0].capturing === false && pxDiff(drawn, base) > 40,
      `glb ${g}; ${shots.length} captures, max |Δ| from before the rebuild ${worst}; attach ${fmt(att)}; after the run |Δ| ${pxDiff(drawn, base)}`)
    await clear()
  }
  {
    // A thumbnail (a GLB add's, made by the planner) whose model loads during a run of keep-room renders (composite, then
    // mask). The GPU read-backs are logged (WebGPU: copyTextureToBuffer → mapAsync; WebGL2: readPixels into a pack
    // buffer → getBufferSubData) and a capture's read is held 200 ms longer (WebGPU): a 256 × 256 read is the
    // thumbnail's, `busy` how many capture reads were in flight when it started (the capture mutex: none).
    await addProbeHere([0, 0, -2.6]) // a piece for the masks to draw
    await E(() => {
      const S = window.__gpuSpy = { on: false, busy: 0, log: [], q: [] }
      const thumb = (w, h) => w === 256 && h === 256
      if (window.GPUCommandEncoder) {
        const copy = GPUCommandEncoder.prototype.copyTextureToBuffer
        GPUCommandEncoder.prototype.copyTextureToBuffer = function (src, dst, size) {
          const w = size.width ?? size[0], h = size.height ?? size[1] ?? 1
          if (S.on) { S.log.push({ w, h, busy: S.busy }); if (!thumb(w, h)) { S.busy++; dst.buffer.__cap = true } }
          return copy.call(this, src, dst, size)
        }
        const map = GPUBuffer.prototype.mapAsync
        GPUBuffer.prototype.mapAsync = async function (...a) {
          const r = await map.apply(this, a)
          if (this.__cap) { this.__cap = false; await new Promise((ok) => setTimeout(ok, 200)); S.busy-- }
          return r
        }
      }
      const gl = window.WebGL2RenderingContext?.prototype
      if (gl) {
        const rp = gl.readPixels, sub = gl.getBufferSubData
        gl.readPixels = function (...a) {
          if (S.on && this.getParameter(this.PIXEL_PACK_BUFFER_BINDING)) { const [, , w, h] = a; S.log.push({ w, h, busy: S.busy }); S.q.push(!thumb(w, h)); if (!thumb(w, h)) S.busy++ }
          return rp.apply(this, a)
        }
        gl.getBufferSubData = function (...a) {
          if (a[0] === this.PIXEL_PACK_BUFFER && S.q.length && S.q.shift()) S.busy--
          return sub.apply(this, a)
        }
      }
    })
    fresh('race-thm', { thumb: false })
    let puts = 0
    const thmRe = /\/api\/library\/items\/race-thm\/thumb$/
    const countPut = (r) => { if (r.request().method() === 'PUT') puts++; return r.fallback() }
    await page.route(thmRe, countPut)
    const refuse = (r) => r.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'held by the race eval' }) })
    await page.route('**/api/render', refuse)
    const h = await hold(glbOf('race-thm'), { count: 99 })
    await reload()
    await hit(h)
    await E(() => { const e = window.midstudyCtx.engine, R = window.__races; window.__gpuSpy.on = true; R.pump(() => e.renderViewInternal({ keepRoom: true }).then(() => 0, () => 0), 8000) })
    await sleep(300)
    h.release()
    await waitFor(() => puts > 0, { timeoutMs: 8000, intervalMs: 50 })
    await E(() => { window.__races.stop = true })
    const renders = (await E(() => window.__races.pumped)).length
    const spy = await E(() => { const S = window.__gpuSpy; S.on = false; return { reads: S.log.length, thumbs: S.log.filter((x) => x.w === 256 && x.h === 256) } })
    await h.off(); await page.unroute('**/api/render', refuse); await page.unroute(thmRe, countPut)
    ev.check('a thumbnail made during a run of keep-room renders renders between their captures, never inside one',
      puts === 1 && spy.thumbs.length >= 1 && spy.thumbs.every((x) => x.busy === 0),
      `thumb PUTs ${puts}; ${renders} renders; ${spy.reads} read-backs; the thumbnail's ${fmt(spy.thumbs)}`)
    await clear()
  }

  ev.section('drag: guards')
  {
    const u = await addProbeHere([0, 0, -2.6])
    const s = await E((u) => {
      const e = window.midstudyCtx.engine, R = window.__races
      R.drag.length = 0
      const [x, y] = e.floorToPhoto([0, 0, -2.6]); const z = e.getPhotoSize(), r = e.getPhotoRect()
      const cx = r.x + (x / z.w) * r.w, cy = r.y + (y / z.h) * r.h
      e.select(u)
      const a = e.beginItemDrag(u, cx, cy), b = e.beginItemDrag(u, cx, cy)
      e.endItemDrag()
      const log = [...R.drag]
      e.setAdjustFloor(true); e.setRulerActive(true)
      const ruler = e.getRuler().active
      const refused = [e.beginItemDrag(u, cx, cy), e.beginRotateDrag(u, cx, cy)]
      e.setRulerActive(false); e.setAdjustFloor(false)
      return { a, b, log, ruler, refused, primary: e.getSelected() }
    }, u)
    ev.check('a second begin ends the first drag (start,end,start,end)', s.a && s.b && fmt(s.log) === fmt(['start', 'end', 'start', 'end']), fmt(s))
    ev.check('the ruler refuses piece drags', s.ruler && s.refused.every((x) => x === false), fmt(s))
    await clear()
  }

  ev.section('library: latest wins, a failed read, thumbnails')
  const libUrl = '**/library/library.json'
  {
    const full = readLib().items.length
    let reads = 0
    const older = async (route) => {
      reads++
      if (reads !== 1) return route.fallback()
      const res = await route.fetch()
      const j = await res.json()
      await sleep(1500)
      return route.fulfill({ response: res, json: { ...j, items: j.items.slice(0, 1) } })
    }
    await page.route(libUrl, older)
    const n = await E(async () => { const e = window.midstudyCtx.engine; await Promise.all([e.reloadLibrary(), e.reloadLibrary()]); return e.getLibrary().length })
    await page.unroute(libUrl, older)
    ev.check('an older library answer landing last doesn\'t replace the newer', n === full && reads === 2, `library ${n} of ${full}; reads ${reads}`)
  }
  {
    await addProbeHere([0, 0, -2.6])
    await E(async () => { await window.midstudyCtx.engine.saveLayoutInternal('race-kept') })
    const bad = (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"on purpose"}' })
    await page.route(libUrl, bad)
    await reload()
    await page.unroute(libUrl, bad)
    await E(() => window.midstudyCtx.engine.loadLayoutInternal('race-kept'))
    const s = await E(() => { const e = window.midstudyCtx.engine; return { lib: e.getLibrary().length, missing: e.getItems().map((i) => i.missing) } })
    ev.check('a failed re-read keeps the list: the next layout has no missing pieces', s.lib > 0 && s.missing.length === 1 && s.missing[0] === false, fmt(s))
    await E(() => window.midstudyCtx.engine.deleteLayoutInternal('race-kept'))
    await clear()
  }
  {
    fresh('race-thumb', { thumb: false })
    const re = /\/api\/library\/items\/race-thumb\/thumb$/
    let puts = 0
    const busy = (r) => { if (r.request().method() !== 'PUT') return r.fallback(); puts++; return puts === 1 ? r.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"busy"}' }) : r.fallback() }
    await page.route(re, busy)
    await reload()
    await waitFor(() => puts === 1, { timeoutMs: 15000, intervalMs: 50 })
    await sleep(300)
    await reload()
    await waitFor(() => puts >= 2, { timeoutMs: 8000, intervalMs: 50 })
    const got = await waitFor(() => E(() => window.midstudyCtx.engine.getLibrary().find((x) => x.id === 'race-thumb')?.assets?.thumb ?? null), { timeoutMs: 8000, intervalMs: 50 })
    await page.unroute(re, busy)
    ev.check('a thumbnail PUT answered 503 is sent again on the next library read, and the thumb lands', puts === 2 && !!got, `PUTs ${puts}; thumb ${fmt(got)}`)
  }
  await E(() => window.midstudyCtx.engine.closeScene())
  if (process.argv.includes('--items')) { ev.check('no page errors', P.errors.page.length === 0, P.errors.page.slice(0, 3).join(' | ') || 'none'); await ev.finish() }
}

ev.section('scene: open and close')
await E(async ({ r, a }) => { await window.midstudyCtx.engine.openRoom(r, a) }, { r: ROOM, a: A.name })
{
  const t0 = Date.now()
  const c = await busyScene(B.name, () => Date.now() - t0 < 2000)
  const s = await E(async (b) => {
    const e = window.midstudyCtx.engine
    const samples = []
    const iv = setInterval(() => samples.push(e.getSceneLoad()), 40)
    await e.setRoomPhoto(b)
    clearInterval(iv)
    return samples
  }, B.name)
  await c.off()
  const phased = s.filter((x) => x.phase)
  ev.check('a room photo switch onto a calibrating photo: every load sample with a phase names the target, and loading stays false', phased.length > 0 && phased.every((x) => x.name === B.name) && s.every((x) => !x.loading), `${s.length} samples, ${phased.length} with a phase; names ${fmt([...new Set(phased.map((x) => x.name))])}; loading ${fmt([...new Set(s.map((x) => x.loading))])}`)
}
{
  await clearLog()
  const photo = new RegExp(`/${esc(A.name)}/photo`)
  let photos = 0
  const count = (r) => { photos++; return r.fallback() }
  await page.route(photo, count)
  const c = await busyScene(A.name, () => false)
  const h = await hold(photo)
  await E((a) => { const e = window.midstudyCtx.engine; window.__races.sw = Promise.all([e.setRoomPhoto(a), e.setRoomPhoto(a), e.setRoomPhoto(a)]) }, A.name)
  await sleep(400)
  h.release()
  await E(() => window.__races.sw)
  await h.off(); await page.unroute(photo, count); await c.off()
  const rooms = await E(() => window.__races.roomAll.filter((x) => x.phase === 'photo').length)
  ev.check('three presses on the photo being opened: one open (one GET of the scene, one photo event)', c.gets === 1 && rooms === 1 && photos <= 1, `GET scene ${c.gets}, GET photo ${photos}, 'photo' events ${rooms}`)
}
await E(() => window.midstudyCtx.engine.closeScene())
{
  const c = await busyScene(A.name, () => true)
  await E((a) => { window.__races.opening = window.midstudyCtx.engine.openScene(a).catch(() => undefined) }, A.name)
  await sleep(700)
  await openS(C.name)
  const g0 = c.gets
  await sleep(3000)
  await c.off()
  ev.check('a superseded open stops polling (no GET of A in 3 s after C opened)', c.gets === g0 && g0 > 0, `GETs before ${g0}, after ${c.gets}`)
}
await openS(A.name)
{
  await clearLog()
  const job = /\/api\/scenes\/jobs\//
  const h = await hold(sceneRe(A.name))
  await E(() => { window.__races.rec = window.midstudyCtx.engine.recalibrate().catch((e) => String(e)) })
  await hit(h)
  await E(() => window.midstudyCtx.engine.closeScene())
  await openS(A.name)
  const cam0 = await E(() => window.midstudyCtx.engine.getScene().camera)
  h.release()
  await sleep(1500)
  await h.off()
  const res = await E(() => ({ cam: window.midstudyCtx.engine.getScene().camera, phases: window.__races.scene.map((x) => x.phase) }))
  ev.check('a recalibrate started before close and reopen does not land on the new open', fmt(res.cam) === fmt(cam0) && !res.phases.includes('recalibrated'), `phases ${fmt(res.phases)}`)
  await waitFor(async () => !['pending', 'running', 'queued'].includes((await api('GET', `/api/scenes/${A.name}`)).json?.calib_status), { timeoutMs: 30000 })
  await clearLog()
  const gone = (r) => r.fulfill({ status: 404, contentType: 'application/json', body: JSON.stringify({ error: 'no such job' }) })
  await page.route(job, gone)
  const lostResult = await E(() => window.midstudyCtx.engine.recalibrate().catch((e) => String(e)))
  await page.unroute(job, gone)
  const ph = await E(() => window.__races.scene.map((x) => x.phase))
  ev.check('a recalibration whose job the server forgot does not resolve to a "done" summary (the panel\'s success toast)', lostResult?.calib_status !== 'done', fmt(lostResult))
  ev.check('a recalibration whose job the server forgot (404) ends in recalibrate-failed, not recalibrated', ph.includes('recalibrate-failed') && !ph.includes('recalibrated'), fmt(ph))
  await waitFor(async () => !['pending', 'running', 'queued'].includes((await api('GET', `/api/scenes/${A.name}`)).json?.calib_status), { timeoutMs: 30000 })
}
{
  await openS(A.name)
  const h = await hold(sceneRe(A.name), { method: 'PUT' })
  await E(async () => { const e = window.midstudyCtx.engine; e.setCamera({ height_m: e.getCamera().height_m + 0.2 }); window.__races.save = e.saveScene().catch((x) => String(x)) })
  await hit(h)
  await openS(B.name)
  const before = await E(() => window.midstudyCtx.engine.getCamera())
  h.release()
  await E(() => window.__races.save)
  await h.off()
  const after = await E(() => ({ cam: window.midstudyCtx.engine.getCamera(), dirty: window.midstudyCtx.engine.isSceneDirty(), saved: window.midstudyCtx.engine.getSavedScene()?.camera }))
  ev.check('saveScene\'s late answer does not land on the scene opened meanwhile', fmt(after.cam) === fmt(before) && fmt(after.saved) === fmt(before) && !after.dirty, fmt(after))
}

ev.section('layouts: by scope')
const addProbe = (at) => E(async ({ id, at }) => window.midstudyCtx.engine.addItemInternal(id, { position: at, rotation_y_deg: 0 }), { id: PROBE.id, at })
const layoutRe = (name, scene) => new RegExp(`/api/layouts/${esc(name)}\\?scene=${esc(scene)}$`)
const namesIn = async (scene) => (await api('GET', `/api/layouts?scene=${scene}`)).json?.layouts ?? []
const saveL = (n) => E(async (n) => { await window.midstudyCtx.engine.saveLayoutInternal(n) }, n)
const ls = (k) => E((k) => localStorage.getItem(k), k)
await openS(A.name)
await addProbe([0, 0, -2.6])
await saveL('pick')
{
  await openS(C.name)
  const h = await hold(layoutRe('pick', A.name))
  await E((a) => { window.__races.op = window.midstudyCtx.engine.openScene(a).catch(() => undefined) }, A.name)
  await hit(h)
  await openS(B.name)
  const lsB = await ls(`midstudy.layout.${B.name}`)
  h.release()
  await E(() => window.__races.op)
  await h.off()
  await sleep(500)
  const s = await E(() => { const e = window.midstudyCtx.engine; return { scene: e.getSceneName(), items: e.getItems().length, name: e.getLayoutName() } })
  const lsA = await ls(`midstudy.layout.${A.name}`)
  ev.check("A's layout answering after B opened: no pieces in B, B's memory unchanged, A's still names it", s.scene === B.name && s.items === 0 && s.name === '' && (await ls(`midstudy.layout.${B.name}`)) === lsB && !!lsA?.includes('pick'), `${fmt(s)}; B ${lsB}; A ${lsA}`)
}
{
  await addProbe([0, 0, -2.6]); await saveL('same')
  await openS(A.name)
  await saveL('same')
  const h = await hold(layoutRe('same', A.name))
  await E(() => { window.__races.del = window.midstudyCtx.engine.deleteLayoutInternal('same').catch((x) => String(x)) })
  await hit(h)
  await openS(B.name)
  h.release()
  await E(() => window.__races.del)
  await h.off()
  const [a, b] = [await namesIn(A.name), await namesIn(B.name)]
  ev.check("a delete started in A deletes A's layout, even with B open by then", a.includes('same') === false && b.includes('same'), `A ${fmt(a)}; B ${fmt(b)}`)
}
{
  // a save started in A whose PUT answers after B opened: stored in A (and A's memory names it), but B's current layout,
  // its unsaved edit and its memory stay B's
  await openS(A.name)
  await addProbe([0.3, 0, -2.6])
  const h = await hold(layoutRe('late-save', A.name), { method: 'PUT' })
  await E(() => { window.__races.ls = window.midstudyCtx.engine.saveLayoutInternal('late-save').catch((x) => String(x)) })
  await hit(h)
  await openS(B.name)
  await addProbe([-0.3, 0, -2.6])
  const st = () => E(() => { const e = window.midstudyCtx.engine; return { scene: e.getSceneName(), name: e.getLayoutName(), dirty: e.isLayoutDirty() } })
  const before = await st()
  const lsB = await ls(`midstudy.layout.${B.name}`)
  h.release()
  await E(() => window.__races.ls)
  await h.off()
  await sleep(300)
  const after = await st()
  const lsB2 = await ls(`midstudy.layout.${B.name}`)
  const lsA = await ls(`midstudy.layout.${A.name}`)
  const inA = await namesIn(A.name)
  ev.check("a layout PUT answering after B opened: saved in A, B's layout name, unsaved edit and memory unchanged",
    after.scene === B.name && before.dirty && after.dirty && after.name === before.name && lsB2 === lsB && inA.includes('late-save') && !!lsA?.includes('late-save'),
    `before ${fmt(before)}; after ${fmt(after)}; B ${lsB} → ${lsB2}; A ${lsA}; A's layouts ${fmt(inA)}`)
}
{
  // a layouts list asked in A answering after B opened (and after B's own list): B keeps its list
  await openS(A.name)
  const listRe = new RegExp(`/api/layouts\\?scene=${esc(A.name)}$`)
  const names = () => E(() => window.midstudyCtx.engine.getLayoutDetails().map((d) => d.name).sort())
  const h = await hold(listRe)
  await E(() => { window.__races.ll = window.midstudyCtx.engine.listLayoutsInternal().catch((x) => String(x)) })
  await hit(h)
  await openS(B.name)
  const before = await names()
  h.release()
  const got = await E(() => window.__races.ll)
  await h.off()
  await sleep(200)
  const after = await names()
  const inA = await namesIn(A.name), inB = (await namesIn(B.name)).slice().sort()
  ev.check("A's late layouts list does not replace B's", fmt(after) === fmt(before) && fmt(after) === fmt(inB) && inA.some((n) => !inB.includes(n)),
    `B's list ${fmt(before)} → ${fmt(after)}; A's answer ${fmt(got)}; on the server A ${fmt(inA)}, B ${fmt(inB)}`)
  // the same, the scene closed instead (no newer list is asked for: only the scope guard stands between)
  await openS(A.name)
  const h2 = await hold(listRe)
  await E(() => { window.__races.ll = window.midstudyCtx.engine.listLayoutsInternal().catch((x) => String(x)) })
  await hit(h2)
  await E(() => window.midstudyCtx.engine.closeScene())
  h2.release()
  await E(() => window.__races.ll)
  await h2.off()
  await sleep(200)
  const closed = await names()
  ev.check("A's late layouts list after the scene closed leaves the list empty", closed.length === 0, `list ${fmt(closed)}`)
}

ev.section('dirty: explicit baselines')
{
  await openS(C.name)
  const u = await addProbe([0.2, 0, -2.6])
  const h = await hold(layoutRe('dirty-save', C.name), { method: 'PUT' })
  await E(() => { window.__races.sv = window.midstudyCtx.engine.saveLayoutInternal('dirty-save') })
  await hit(h)
  await E((u) => window.midstudyCtx.engine.moveItemInternal(u, { position: [0.7, 0, -2.6] }), u)
  h.release()
  await E(() => window.__races.sv)
  await h.off()
  const d1 = await E(() => window.midstudyCtx.engine.isLayoutDirty())
  ev.check('a piece moved during the layout PUT stays unsaved', d1, `dirty ${d1}`)
  // a second library entry whose GLB is held, so one piece of the layout lands first
  const libFile = path.join(srv.dirs.library, 'library.json')
  const lib = JSON.parse(fs.readFileSync(libFile, 'utf8'))
  const second = 'probe-two'
  fs.mkdirSync(path.join(srv.dirs.library, second), { recursive: true })
  fs.copyFileSync(path.join(srv.dirs.library, PROBE.id, 'model.glb'), path.join(srv.dirs.library, second, 'model.glb'))
  lib.items.push({ ...lib.items[0], id: second, name: 'Probe two', assets: { ...lib.items[0].assets, glb: `${second}/model.glb` } })
  fs.writeFileSync(libFile, JSON.stringify(lib, null, 2))
  const doc = (await api('GET', `/api/layouts/dirty-save?scene=${C.name}`)).json
  doc.name = 'two-pieces'
  doc.items = [{ ...doc.items[0], uid: 'p-one', position: [0, 0, -2.6] }, { ...doc.items[0], uid: 'p-two', id: second, position: [0.9, 0, -2.6] }]
  const put = await api('PUT', `/api/layouts/two-pieces?scene=${C.name}`, doc)
  ev.check('a two-piece layout is stored', put.status === 200, `${put.status} ${fmt(put.json)}`)
  const glb = new RegExp(`/${second}/model\\.glb`)
  const hg = await hold(glb, { count: 99 })
  await E(async () => { const e = window.midstudyCtx.engine; await e.reloadLibrary(); window.__races.ld = e.loadLayoutInternal('two-pieces') })
  const landed = await waitFor(() => E(() => window.midstudyCtx.engine.getItems().some((i) => i.uid === 'p-one')), { timeoutMs: 15000, intervalMs: 30 })
  await E(() => window.midstudyCtx.engine.moveItemInternal('p-one', { position: [-0.5, 0, -2.6] }))
  hg.release()
  await E(() => window.__races.ld)
  await hg.off()
  const d2 = await E(() => window.midstudyCtx.engine.isLayoutDirty())
  ev.check('a piece moved while its layout loads counts as unsaved after the load', landed && d2, `landed ${landed}; dirty ${d2}`)
  await E(() => window.midstudyCtx.engine.loadLayoutInternal('two-pieces'))
  const d3 = await E(() => window.midstudyCtx.engine.isLayoutDirty())
  ev.check('the same layout loaded with no edit is clean', !d3, `dirty ${d3}`)
}

ev.section('ruler')
const rulerTwo = () => E(() => {
  const e = window.midstudyCtx.engine
  const client = (p) => { const [x, y] = e.floorToPhoto(p); const s = e.getPhotoSize(), r = e.getPhotoRect(); return [r.x + (x / s.w) * r.w, r.y + (y / s.h) * r.h] }
  e.setAdjustFloor(true); e.setRulerActive(true)
  for (const p of [[-0.4, 0, -2.4], [0.5, 0, -2.4]]) { const [cx, cy] = client(p); e.tap(cx, cy) }
  return e.getRuler()
})
{
  await openS(A.name)
  const r0 = await rulerTwo()
  ev.check('two ruler points set', r0.points.length === 2 && r0.active, fmt(r0))
  await clearLog()
  await openS(B.name)
  const evs = await E(() => window.__races.ruler)
  ev.check("opening another scene resets the ruler with one 'ruler' event, inactive", evs.length === 1 && evs[0].active === false && evs[0].points.length === 0, fmt(evs))
  const off = await E(() => { const e = window.midstudyCtx.engine; e.setAdjustFloor(false); e.setRulerActive(true); return e.getRuler().active })
  ev.check('the ruler does not turn on outside Adjust floor', off === false, `active ${off}`)
  await E(async ({ r, a }) => { await window.midstudyCtx.engine.openRoom(r, a) }, { r: ROOM, a: A.name })
  const r1 = await rulerTwo()
  const h = await hold(new RegExp(`/api/rooms/${esc(ROOM)}$`), { method: 'PUT' })
  await E((m) => { window.__races.scale = window.midstudyCtx.engine.setRoomScale(m).catch((x) => String(x)) }, r1.meters * 1.1)
  await hit(h)
  const moved = await E(() => {
    const e = window.midstudyCtx.engine
    const [x, y] = e.floorToPhoto([0.1, 0, -2.1]); const s = e.getPhotoSize(), r = e.getPhotoRect()
    e.setRulerPointAt(0, r.x + (x / s.w) * r.w, r.y + (y / s.h) * r.h)
    return e.getRuler().points[0]
  })
  h.release()
  await E(() => window.__races.scale)
  await h.off()
  const pt = await E(() => window.midstudyCtx.engine.getRuler().points[0])
  ev.check('a ruler point moved during setRoomScale\'s PUT keeps its place', fmt(pt) === fmt(moved), `moved ${fmt(moved)}; after ${fmt(pt)}`)
  await E(() => window.midstudyCtx.engine.closeScene())
}

ev.section('look: autosave')
{
  await openS(A.name)
  const bodies = { [A.name]: [], [B.name]: [] }
  let first = true
  const recd = (n) => async (route) => {
    const req = route.request()
    if (req.method() !== 'PUT') return route.fallback()
    const b = jsonOf(req)
    if (n === A.name && first) { first = false; await sleep(1000) }
    bodies[n].push(b?.look?.light_strength)
    return route.fallback()
  }
  const hA = recd(A.name), hB = recd(B.name)
  await page.route(sceneRe(A.name), hA); await page.route(sceneRe(B.name), hB)
  await E(() => window.midstudyCtx.engine.setLighting({ light_strength: 1.11 }))
  await sleep(800)
  await E(() => window.midstudyCtx.engine.setLighting({ light_strength: 1.37 }))
  await openS(B.name)
  await waitFor(() => bodies[A.name].length >= 2, { timeoutMs: 5000, intervalMs: 50 })
  ev.check('two Look saves land in order: A\'s last body has the newer Look', bodies[A.name].at(-1) === 1.37, fmt(bodies[A.name]))
  await sleep(1000)
  await openS(A.name)
  bodies[A.name].length = 0; bodies[B.name].length = 0
  const h = await hold(sceneRe(B.name))
  await E((b) => { window.__races.op = window.midstudyCtx.engine.openScene(b) }, B.name)
  await hit(h)
  await E(() => window.midstudyCtx.engine.setLighting({ light_strength: 1.73 }))
  await sleep(100)
  h.release()
  await E(() => window.__races.op)
  await h.off()
  await sleep(1200)
  await page.unroute(sceneRe(A.name), hA); await page.unroute(sceneRe(B.name), hB)
  ev.check('a Look change made while B loads goes to A, and B gets no PUT', bodies[A.name].at(-1) === 1.73 && bodies[B.name].length === 0, `A ${fmt(bodies[A.name])}; B ${fmt(bodies[B.name])}`)
}

ev.section('renders: ids, list, a lost request')
{
  await openS(A.name)
  await clearLog()
  const pair = await E(async () => { const e = window.midstudyCtx.engine; const r = await Promise.allSettled([e.renderViewInternal({}), e.renderViewInternal({})]); return { st: r.map((x) => x.status), log: window.__races.render.map((x) => ({ phase: x.phase, id: x.id })) } })
  const idsOf = (ph) => pair.log.filter((x) => x.phase === ph).map((x) => x.id).sort()
  ev.check('two renders at once: start and done pair up by id', pair.st.every((s) => s === 'fulfilled') && typeof idsOf('start')[0] === 'number' && new Set(idsOf('start')).size === 2 && fmt(idsOf('start')) === fmt(idsOf('done')), fmt(pair))
  await openS(C.name)
  const listRe = new RegExp(`/api/renders\\?scene=${esc(A.name)}$`)
  const h = await hold(listRe)
  await openS(A.name)
  await hit(h)
  await openS(B.name)
  await sleep(300)
  h.release()
  await sleep(800)
  await h.off()
  const leaked = await E((a) => window.midstudyCtx.engine.getRenders().filter((r) => r.scene === a).length, A.name)
  ev.check("A's late renders list does not replace B's", leaked === 0, `${leaked} of A's renders listed in B`)
  await openS(A.name)
  await sleep(500)
  await clearLog()
  const count0 = await E(() => window.midstudyCtx.engine.getRenders().length)
  await E(() => { window.__races.errors.length = 0 })
  const drop = async (route) => { await route.fetch(); return route.abort('connectionreset') }
  await page.route('**/api/render', drop)
  const failed = await E(() => window.midstudyCtx.engine.renderViewInternal({}).then(() => 'resolved', (x) => String(x)))
  await page.unroute('**/api/render', drop)
  const lostText = await E(() => window.__races.errors.join(' | '))
  const fev = await E(() => window.__races.render.find((x) => x.phase === 'failed'))
  ev.check('a dropped render request says it may still finish', lostText.includes('may still finish') && fev?.lost === true, `${failed}; errors ${lostText}; event ${fmt(fev)}`)
  const got = await waitFor(() => E((n) => window.midstudyCtx.engine.getRenders().length > n, count0), { timeoutMs: 7000, intervalMs: 100 })
  ev.check('and it shows in the list within 6 s', !!got, `count before ${count0}, after ${await E(() => window.midstudyCtx.engine.getRenders().length)}`)
}

ev.section('camera: reset')
{
  await openS(A.name)
  await E(async () => { const e = window.midstudyCtx.engine; e.resetCamera(); await e.saveScene() }) // saved = the calibrated camera, source auto/default
  const s = await E(async () => {
    const e = window.midstudyCtx.engine
    const auto = e.getCamera()
    e.setCamera({ height_m: auto.height_m + 0.3 }); await e.saveScene() // saved = a hand-set camera (manual)
    const saved = e.getSavedScene()
    e.resetCamera() // away from it
    const away = { src: e.getCameraSource(), dirty: e.isSceneDirty() }
    const calibrated = e.getCamera()
    e.setCamera({ height_m: calibrated.height_m + 0.1 }); e.setCamera(calibrated); await e.saveScene() // saved: that camera, by hand
    e.setCamera({ height_m: calibrated.height_m + 0.1 })
    e.resetCamera() // back onto the saved camera
    return { saved: saved.camera_source, away, back: { src: e.getCameraSource(), want: e.getSavedScene().camera_source, dirty: e.isSceneDirty() } }
  })
  ev.check('a reset away from the saved camera is the calibration\'s source; back onto it, the saved source and clean', s.saved === 'manual' && s.away.src !== 'manual' && s.away.dirty && s.back.want === 'manual' && s.back.src === s.back.want && !s.back.dirty, fmt(s))
}

ev.section('lists: latest wins')
{
  const h = await hold(/\/api\/scenes$/)
  await E(() => { window.__races.l1 = window.midstudyCtx.engine.listScenesInternal() })
  await hit(h)
  await E(async (d) => { const e = window.midstudyCtx.engine; await e.deleteScene(d); await e.listScenesInternal() }, D.name)
  h.release()
  await E(() => window.__races.l1)
  await h.off()
  await sleep(200)
  const last = await E(() => window.__races.lastScenes)
  ev.check('an older scene list landing last does not resurrect a deleted scene', Array.isArray(last) && !last.includes(D.name), fmt(last))
}

ev.section('startup')
{
  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await p2.addInitScript((r) => { localStorage.setItem('midstudy.lastRoom', r) }, ROOM)
  const h = await hold(/\/api\/rooms$/, { count: 99, ctx: p2 })
  await p2.goto(`${srv.base}/planner/`, { waitUntil: 'load' })
  await p2.waitForFunction(() => !!window.midstudyCtx?.engine, null, { timeout: 30000 })
  await p2.evaluate(async (c) => { await window.midstudyCtx.engine.openScene(c) }, C.name)
  h.release()
  await sleep(2000)
  const s = await p2.evaluate(() => ({ scene: window.midstudyCtx.engine.getSceneName(), room: window.midstudyCtx.engine.getRoomState()?.name ?? null }))
  ev.check("the user's open made during startup stays open", s.scene === C.name && s.room === null, fmt(s))
  await ctx.close()
}
{
  // the same, one step later: the room is chosen and its GET is in flight when the user opens a scene
  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await p2.addInitScript((r) => { localStorage.setItem('midstudy.lastRoom', r) }, ROOM)
  const h = await hold(new RegExp(`/api/rooms/${esc(ROOM)}$`), { ctx: p2 })
  await p2.goto(`${srv.base}/planner/`, { waitUntil: 'load' })
  await p2.waitForFunction(() => !!window.midstudyCtx?.engine, null, { timeout: 30000 })
  await hit(h)
  await p2.evaluate(async (c) => { await window.midstudyCtx.engine.openScene(c) }, C.name)
  h.release()
  await sleep(2000)
  const s = await p2.evaluate(() => ({ scene: window.midstudyCtx.engine.getSceneName(), room: window.midstudyCtx.engine.getRoomState()?.name ?? null }))
  ev.check("the user's open made while startup reads the room stays open", s.scene === C.name && s.room === null, fmt(s))
  await ctx.close()
}
{
  // the last room's photo can't be opened: startup goes on to the last scene, as v1 did
  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await p2.addInitScript(({ r, c }) => { localStorage.setItem('midstudy.lastRoom', r); localStorage.setItem('midstudy.lastScene', c) }, { r: ROOM, c: C.name })
  for (const n of [A.name, B.name]) await p2.route(sceneRe(n), (r) => (r.request().method() === 'GET' ? r.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":"INTERNAL","message":"failed on purpose"}}' }) : r.fallback()))
  await p2.goto(`${srv.base}/planner/`, { waitUntil: 'load' })
  await p2.waitForFunction(() => !!window.midstudyCtx?.engine, null, { timeout: 30000 })
  await p2.evaluate(() => window.midstudy.ready)
  const s = await p2.evaluate(() => ({ scene: window.midstudyCtx.engine.getSceneName(), room: window.midstudyCtx.engine.getRoomState()?.name ?? null }))
  ev.check('a last room whose photo fails to open lands on the last scene', s.scene === C.name && s.room === null, fmt(s))
  await ctx.close()
}
{
  // the user's open still in flight when startup gives way: no Scenes page over it
  const ctx = await browser.newContext()
  const p2 = await ctx.newPage()
  await p2.addInitScript((r) => { localStorage.setItem('midstudy.lastRoom', r) }, ROOM)
  const h = await hold(/\/api\/rooms$/, { count: 99, ctx: p2 })
  const held = await hold(sceneRe(C.name), { count: 99, ctx: p2 })
  await p2.goto(`${srv.base}/planner/`, { waitUntil: 'load' })
  await p2.waitForFunction(() => !!window.midstudyCtx?.engine, null, { timeout: 30000 })
  await p2.evaluate((c) => { void window.midstudyCtx.engine.openScene(c).catch(() => undefined) }, C.name)
  await hit(held)
  h.release()
  await p2.evaluate(() => window.midstudy.ready)
  const page0 = await p2.evaluate(() => window.midstudyCtx.shell.getOpenPage())
  held.release()
  await p2.waitForFunction((c) => window.midstudyCtx.engine.getSceneName() === c, C.name, { timeout: 15000 }).catch(() => undefined)
  const s = await p2.evaluate(() => window.midstudyCtx.engine.getSceneName())
  ev.check("startup leaves the user's open in flight alone (no Scenes page over it)", page0 === null && s === C.name, fmt({ page0, s }))
  await ctx.close()
}

ev.check('no page errors', P.errors.page.length === 0, P.errors.page.slice(0, 3).join(' | ') || 'none')
await ev.finish()
