#!/usr/bin/env node
// The planner engine's races (docs/notes/state-machines-plan.md, planner-engine): overlapping work driven through
// window.midstudyCtx.engine in headless Chrome against the real server (fal mocked, $0), with playwright's page.route
// for the server answers a race needs (a held, failed or forgotten request). Each section is one machine:
//   capture   two overlapping exports equal the same exports one after the other, the grid and the view come back;
//             two overlapping keep-room captures leave the pieces their own colours (not the mask's white)
//   align     the alignment is followed by its job id: a job the server forgot (404) ends in 'align-failed'
//   loop      a render failure is reported once per scene opened, not once per session
//   scene …   open/close tokens, layouts by scope, dirty baselines, ruler, Look autosave, renders, camera, lists, startup
// Usage (repo root, through the lock): nix develop -c node scripts/eval-lock.mjs -- npm run eval:engine-races
import fs from 'node:fs'
import path from 'node:path'
import {
  PROBE, createEval, startServer, seedScene, launchBrowser, openPlanner, ensureScene, hook, fmt, raw, sleep, waitFor,
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
