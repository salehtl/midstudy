#!/usr/bin/env node
// The planner engine's races (docs/notes/state-machines-plan.md, planner-engine): overlapping work driven through
// window.midstudyCtx.engine in headless Chrome against the real server (fal mocked, $0), with playwright's page.route
// for the server answers a race needs (a held, failed or forgotten request). Each section is one machine:
//   capture   two overlapping exports equal the same exports one after the other, the grid and the view come back;
//             two overlapping keep-room captures leave the pieces their own colours (not the mask's white)
//   align     the alignment is followed by its job id: a job the server forgot (404) ends in 'align-failed'
//   loop      a render failure is reported once per scene opened, not once per session
// Usage (repo root, through the lock): nix develop -c node scripts/eval-lock.mjs -- npm run eval:engine-races
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

ev.check('no page errors', P.errors.page.length === 0, P.errors.page.slice(0, 3).join(' | ') || 'none')
await ev.finish()
