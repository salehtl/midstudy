// E11 eval:ux — regressions for the verify round 1 UX findings (docs/notes/verify-fix-1.md). Desktop 1440 × 900 and
// phone 390 × 844 on the golden living-wide scene (its true camera, so expectations are exact), fal and calibration
// mocked, $0. Each section names the finding it pins:
//   CSS        every stylesheet parses whole (a stray "}" dropped .ws-loadcard and .ws-mline before)
//   drag       the grabbed point of a piece stays under the mouse / finger (it overshot toward the camera), and a
//              mouse press on an unselected piece selects and drags it
//   layouts    titles keep their capitals ("Phone A"); Remove + Undo isn't "unsaved"; a reload reopens the scene
//              with its layout; deleting a layout can be undone
//   scenes     a deleted scene comes back with Undo, and from Recently deleted
//   overlay    the rotate grip stays on the photo near the camera; no stale tooltip after a grip drag
//   ruler      a known length sets the scale (the camera height); the phone's horizon drag is fine-grained
//   phone      one toast at a time; "Search 1 item"; "In the scene · n" counts pieces
// It reads layout rects and the photo rectangle from window.midstudyCtx (the app's console handle) where the hook has
// no getter. Usage: node evals/ux_fixes.mjs (npm run eval:ux). Screenshots: evals/out/ux/.
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, PROBE, createEval, startServer, launchBrowser, openPlanner, hook, state, itemOf, golden, fmt, api, waitFor, sleep,
  seedScene, ensureScene, touchDrag, project,
} from './lib/harness.mjs'

const ev = createEval('E11', 'ux', { timeoutS: 900 })
const LW = golden('living-wide'), { w: W, h: H } = LW.truth.image, CAM = LW.truth.camera
const shot = (page, name) => page.screenshot({ path: path.join(ev.out, `${name}.png`) }).catch(() => {})

// --- CSS: every stylesheet parses whole ----------------------------------------------------------------------------------
ev.section('CSS')
const cssDir = path.join(REPO, 'planner/styles')
const braces = []
for (const f of fs.readdirSync(cssDir).filter((f) => f.endsWith('.css'))) {
  const src = fs.readFileSync(path.join(cssDir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""')
  let depth = 0, bad = null, line = 1
  for (const ch of src) {
    if (ch === '\n') line++
    if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) { bad = bad ?? line; depth = 0 }
  }
  braces.push({ f, ok: depth === 0 && bad == null, bad, depth })
}
ev.check('every planner stylesheet has balanced braces (a stray "}" makes the browser drop the next rule)', braces.every((b) => b.ok), fmt(braces.filter((b) => !b.ok)) || 'all balanced')

const srv = await startServer(ev)
ev.check('serve.py starts (stub calibration + MIDSTUDY_CALIB_MOCK)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const S = await seedScene(srv, 'living-wide', 'Living room')
ev.check('golden living-wide calibrated (its true camera)', S.name && !S.why, S.why || S.name)
const browser = await launchBrowser(ev)
let P = await openPlanner(browser, srv.base, { scene: S.name, viewport: { width: 1440, height: 900 } })
let page = P.page
ev.check('the planner opens the scene at 1440 × 900', P.hookOk && (await ensureScene(page, S.name)).ok, P.why || P.url)

const parsed = await page.evaluate(() => {
  const sels = []
  const walk = (rules) => { for (const r of rules) { if (r.selectorText) sels.push(r.selectorText); if (r.cssRules) walk(r.cssRules) } }
  for (const sh of document.styleSheets) { try { walk(sh.cssRules) } catch { /* cross-origin */ } }
  const has = (s) => sels.some((x) => x.split(',').map((y) => y.trim()).includes(s))
  const probe = document.createElement('div')
  probe.className = 'ws-loadcard'
  document.body.append(probe)
  const cs = getComputedStyle(probe), pad = cs.paddingTop, gap = cs.rowGap, display = cs.display
  probe.remove()
  return { loadcard: has('.ws-loadcard'), mline: has('.ws-mline'), pad, gap, display }
})
ev.check('the parsed sheets have .ws-loadcard and .ws-mline, and the card gets its padding, gap and flex column', parsed.loadcard && parsed.mline && parsed.pad === '20px' && parsed.gap === '16px' && parsed.display === 'flex', fmt(parsed))

// --- helpers on the page ---------------------------------------------------------------------------------------------------
// Client (CSS) px of a world point, through the hook's floorToPhoto (§4.1, any point) and the photo's rectangle.
async function toClient(pg, p) {
  const r = await hook(pg, 'floorToPhoto', [p])
  const rect = await pg.evaluate(() => window.midstudyCtx.engine.getPhotoRect())
  const sz = await pg.evaluate(() => window.midstudyCtx.engine.getPhotoSize())
  if (!r.value) return null
  return [rect.x + (r.value[0] / sz.w) * rect.w, rect.y + (r.value[1] / sz.h) * rect.h]
}
// The front face's centre line of the probe box at height y (the box faces +Z; position is its footprint centre).
const frontAt = (it, y) => [it.position[0], it.position[1] + y, it.position[2] + PROBE.dims_cm.d / 200]
async function mouseDrag(pg, from, to, steps = 15) {
  await pg.mouse.move(from[0], from[1])
  await pg.mouse.down()
  for (let i = 1; i <= steps; i++) await pg.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps)
  await pg.mouse.up()
  await sleep(200)
}

// --- drag: the grabbed point follows the pointer ---------------------------------------------------------------------------
ev.section('drag (desktop)')
const add = await hook(page, 'addItem', [PROBE.id, { position: [0.3, 0, -3.4], rotation_y_deg: 0 }])
const uid = add.value
await hook(page, 'selectItem', [uid])
await sleep(200)
let it = itemOf(await state(page), uid)
const grabY = 0.9 // high on the box's front: a floor-plane drag amplified exactly this case
const g0 = await toClient(page, frontAt(it, grabY))
await mouseDrag(page, g0, [g0[0], g0[1] + 30])
let it1 = itemOf(await state(page), uid)
let g1 = await toClient(page, frontAt(it1, grabY))
ev.check('a 30 px mouse drag on the selected piece\'s upper front moves that point 30 px (±2), not more',
  g1 && Math.abs(g1[1] - (g0[1] + 30)) <= 2 && Math.abs(g1[0] - g0[0]) <= 2, `grab ${fmt(g0)} → point now ${fmt(g1)}; z ${it.position[2]} → ${it1?.position?.[2]}`)
ev.check('…and it stays on the floor (elevation 0)', it1?.position?.[1] === 0, fmt(it1?.position))

await hook(page, 'selectItem', [null])
await sleep(150)
it = itemOf(await state(page), uid)
const u0 = await toClient(page, frontAt(it, 0.6))
await mouseDrag(page, u0, [u0[0] + 40, u0[1] + 25])
const st2 = await state(page)
it1 = itemOf(st2, uid)
const sel2 = await page.evaluate(() => window.midstudyCtx.engine.getSelected())
g1 = await toClient(page, frontAt(it1, 0.6))
ev.check('a mouse press-drag on an unselected piece selects it and drags it under the pointer', sel2 === uid && g1 && Math.hypot(g1[0] - u0[0] - 40, g1[1] - u0[1] - 25) <= 3,
  `selected ${sel2 === uid}; point ${fmt(u0)} → ${fmt(g1)} (want +40, +25)`)
await shot(page, 'desktop-drag')

// --- layouts: titles, Remove + Undo, reload, delete + Undo ------------------------------------------------------------------
ev.section('layouts')
const named = async (pg, re) => { const l = pg.getByRole('button', { name: re }); for (let i = 0; i < await l.count(); i++) if (await l.nth(i).isVisible().catch(() => false)) return l.nth(i); return null }
const openLayouts = async () => { const b = await named(page, /^layouts/i); if (b) await b.click(); await sleep(300) }
await openLayouts()
let b = await named(page, /^save layout…$|^save as new…$/i)
if (b) await b.click()
await sleep(200)
const nameField = page.getByRole('textbox', { name: 'New layout name' })
await nameField.fill('Phone A').catch(() => {})
await sleep(100)
b = await named(page, /^save as new$/i)
if (b) await b.click()
await sleep(500)
let st = await state(page)
const ld = await api.get(srv.base, `/api/layouts?scene=${S.name}`)
const rowText = await page.locator('.ly-row .ly-name').allInnerTexts().catch(() => [])
ev.check('a layout saved as "Phone A" keeps its capitals (stored title, the list and the card)', st?.layout === 'phone-a' && ld.json?.details?.find((d) => d.name === 'phone-a')?.title === 'Phone A'
  && rowText.includes('Phone A'), fmt({ layout: st?.layout, details: ld.json?.details, rows: rowText }))

await hook(page, 'selectItem', [uid])
await sleep(150)
await page.keyboard.press('Delete')
await sleep(200)
const removed = (await state(page))?.items?.length === 0
await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z')
await waitFor(async () => ((await state(page))?.items?.length ?? 0) === 1, { timeoutMs: 5000 })
st = await state(page)
ev.check('Remove then Undo leaves the layout unchanged, so it isn\'t marked unsaved', removed && st?.items?.length === 1 && st.dirty === false, fmt({ removed, items: st?.items?.length, dirty: st?.dirty }))

await page.reload({ waitUntil: 'load' })
await page.waitForFunction(() => window.midstudy?.ready, null, { timeout: 30000 }).catch(() => {})
await page.evaluate(() => window.midstudy.ready)
st = await waitFor(async () => { const s = await state(page); return s?.items?.length === 1 ? s : null }, { timeoutMs: 15000 }) || await state(page)
ev.check('a reload reopens the scene with its current layout (Phone A, 1 piece), not an empty room', st?.scene?.name === S.name && st.layout === 'phone-a' && st.items?.length === 1 && st.dirty === false,
  fmt({ scene: st?.scene?.name, layout: st?.layout, items: st?.items?.length, dirty: st?.dirty }))
await shot(page, 'desktop-reloaded')

await openLayouts()
const more = page.getByRole('button', { name: 'More for Phone A' })
if (await more.count()) await more.first().click()
await sleep(200)
const delItem = page.getByRole('menuitem', { name: /delete/i })
if (await delItem.count()) await delItem.first().click()
await sleep(200)
b = await named(page, /^delete$/i)
if (b) await b.click()
await sleep(500)
const trashDir = path.join(srv.dirs.layouts, S.name, '.trash')
const trashed = fs.existsSync(trashDir) ? fs.readdirSync(trashDir) : []
const goneFromList = !((await api.get(srv.base, `/api/layouts?scene=${S.name}`)).json?.layouts || []).includes('phone-a')
const undo = page.locator('[data-midstudy="layout-undo"]')
const hasUndo = await undo.first().isVisible().catch(() => false)
ev.check('deleting a layout keeps a copy in layouts/<scene>/.trash and offers Undo', goneFromList && trashed.some((f) => f.startsWith('phone-a-')) && hasUndo, fmt({ goneFromList, trashed, hasUndo }))
if (hasUndo) await undo.first().click()
const back = await waitFor(async () => ((await api.get(srv.base, `/api/layouts?scene=${S.name}`)).json?.details || []).find((d) => d.name === 'phone-a'), { timeoutMs: 5000 })
const lj = back ? JSON.parse(fs.readFileSync(path.join(srv.dirs.layouts, S.name, 'phone-a.json'), 'utf8')) : null
ev.check('…and Undo brings it back as it was (title, the piece)', back?.title === 'Phone A' && lj?.items?.length === 1, fmt(back))

// --- the rotate grip near the camera, the stale tooltip ---------------------------------------------------------------------
ev.section('overlay')
await hook(page, 'moveItem', [uid, { position: [0.3, 0, -1.5] }])
await hook(page, 'selectItem', [uid])
await sleep(400)
const grip = await page.evaluate(() => {
  const g = document.querySelector('.ws-grip'), r = g?.getBoundingClientRect(), v = window.midstudyCtx.engine.getVisiblePhotoRect()
  const bar = document.querySelector('.ws-selbar')?.getBoundingClientRect()
  if (!r || g.hidden) return null
  const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
  return { r: [r.x, r.y, r.width, r.height], v: [v.x, v.y, v.w, v.h], barTop: bar?.top, hit: !!top && g.contains(top) }
})
ev.check('near the camera the rotate grip stays on the photo, above the selection bar, and can be grabbed', !!grip && grip.hit && grip.r[1] >= grip.v[1] - 1 && grip.r[1] + grip.r[3] <= Math.min(grip.v[1] + grip.v[3], grip.barTop ?? 1e9) + 1,
  fmt(grip))
await shot(page, 'desktop-near-camera')
await hook(page, 'moveItem', [uid, { position: [0.3, 0, -3.0] }])
await sleep(300)
const gr = await page.evaluate(() => { const r = document.querySelector('.ws-grip').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2] })
await page.mouse.move(gr[0], gr[1])
await sleep(700) // the tooltip shows after 450 ms
const tipBefore = await page.locator('.tooltip').count()
await mouseDrag(page, gr, [gr[0] - 150, gr[1] + 40], 20)
await sleep(800)
const tip = await page.evaluate(() => {
  const t = document.querySelector('.tooltip'), g = document.querySelector('.ws-grip').getBoundingClientRect()
  if (!t) return { shown: false }
  const r = t.getBoundingClientRect()
  return { shown: true, dist: Math.hypot(r.x + r.width / 2 - (g.x + g.width / 2), r.y - g.bottom) }
})
ev.check('after a grip drag no tooltip is left behind away from the grip', !tip.shown || tip.dist < 80, fmt({ tipBefore, ...tip }))

// --- the ruler sets the scale ------------------------------------------------------------------------------------------------
ev.section('ruler: a known length sets the scale')
await hook(page, 'selectItem', [null])
await hook(page, 'setCamera', [{ height_m: CAM.height_m * 0.85 }]) // a MoGe-like 15 % low camera
await hook(page, 'setAdjustFloor', [true])
await sleep(300)
const rulerBtn = await named(page, /^ruler$/i)
if (rulerBtn) await rulerBtn.click()
await sleep(200)
const fp = LW.truth.floor_points
const [pa, pb] = [fp[0], fp.reduce((best, q) => (Math.hypot(q.world[0] - fp[0].world[0], q.world[2] - fp[0].world[2]) > Math.hypot(best.world[0] - fp[0].world[0], best.world[2] - fp[0].world[2]) ? q : best), fp[1])]
const trueM = Math.hypot(pa.world[0] - pb.world[0], pa.world[2] - pb.world[2])
const rect = await page.evaluate(() => window.midstudyCtx.engine.getPhotoRect())
const css = (px) => [rect.x + (px[0] / W) * rect.w, rect.y + (px[1] / H) * rect.h]
for (const q of [pa, pb]) { const c = css(q.px); await page.mouse.click(c[0], c[1]); await sleep(150) }
const measured = await page.evaluate(() => window.midstudyCtx.engine.getRuler().meters)
const field = page.locator('[data-midstudy="ruler-true"]')
const fieldShown = await field.isVisible().catch(() => false)
if (fieldShown) { await field.fill(String(Math.round(trueM * 1000) / 10)); await page.locator('[data-midstudy="ruler-set"]').click() }
await sleep(300)
const camAfter = (await hook(page, 'getCamera')).value
const after = await page.evaluate(() => window.midstudyCtx.engine.getRuler().meters)
ev.check('with the camera 15 % low the ruler reads 15 % short; "Really … cm · Set scale" restores the true height (±1 %)',
  fieldShown && Math.abs(measured / trueM - 0.85) < 0.01 && Math.abs(camAfter.height_m / CAM.height_m - 1) < 0.01 && Math.abs(after / trueM - 1) < 0.01,
  fmt({ trueM, measured, after, height: camAfter?.height_m, truth: CAM.height_m, fieldShown }))
await shot(page, 'desktop-ruler')
await hook(page, 'resetCamera')
await hook(page, 'setAdjustFloor', [false])

// --- scenes: delete, Undo, Recently deleted → Restore -------------------------------------------------------------------------
ev.section('scenes: undo and restore a delete')
const S2 = await seedScene(srv, 'steep-roll', 'Second room')
await page.evaluate(() => window.midstudyCtx.shell.openPage('scenes'))
await page.evaluate(() => window.midstudyCtx.engine.listScenesInternal())
await sleep(500)
async function deleteCard(name) {
  const del = page.locator(`[data-midstudy="scene-card"][data-scene="${name}"] [data-midstudy="scene-delete"]`)
  if (!(await del.count())) return false
  await del.first().click()
  await sleep(200)
  const ok = await named(page, /^delete$/i)
  if (ok) await ok.click()
  return waitFor(async () => !((await api.get(srv.base, '/api/scenes')).json?.scenes || []).some((s) => s.name === name), { timeoutMs: 5000 })
}
const gone1 = await deleteCard(S2.name)
const sUndo = page.locator('[data-midstudy="scene-undo"]')
const hasSUndo = await waitFor(() => sUndo.first().isVisible().catch(() => false), { timeoutMs: 3000 })
const toastNow = await page.locator('#toasts .toast-text').allInnerTexts().catch(() => [])
if (hasSUndo) await sUndo.first().click()
const back1 = await waitFor(async () => ((await api.get(srv.base, '/api/scenes')).json?.scenes || []).find((s) => s.name === S2.name), { timeoutMs: 5000 })
ev.check('deleting a scene offers Undo, and Undo brings it back (calibrated, its photo served)', !!gone1 && hasSUndo && back1?.calib_status === 'done' && (await api.get(srv.base, back1.photo_url.split('?')[0])).status === 200,
  fmt({ gone1: !!gone1, hasSUndo, back: back1?.calib_status, toasts: toastNow }))
const gone2 = await deleteCard(S2.name)
await page.evaluate(() => window.midstudyCtx.engine.listScenesInternal())
await sleep(400)
const restoreBtn = page.locator(`[data-midstudy="scene-restore"][data-scene="${S2.name}"]`)
const hasRestore = await restoreBtn.first().isVisible().catch(() => false)
await shot(page, 'desktop-recently-deleted')
if (hasRestore) await restoreBtn.first().click()
const back2 = await waitFor(async () => ((await api.get(srv.base, '/api/scenes')).json?.scenes || []).find((s) => s.name === S2.name), { timeoutMs: 5000 })
ev.check('…and once the toast is gone, Scenes › Recently deleted › Restore brings it back', !!gone2 && hasRestore && !!back2, fmt({ gone2: !!gone2, hasRestore, back: !!back2 }))
await page.evaluate(() => window.midstudyCtx.shell.closePage())
const errsDesk = { ...P.errors }
await P.context.close()

// --- phone ---------------------------------------------------------------------------------------------------------------------
ev.section('phone')
P = await openPlanner(browser, srv.base, { device: 'phone', scene: S.name })
page = P.page
ev.check('the phone opens the scene', P.hookOk && (await ensureScene(page, S.name)).ok, P.why)
await page.evaluate(() => { localStorage.setItem('midstudy.hint.gestures', '1') })
await hook(page, 'clearItems')
const pu = (await hook(page, 'addItem', [PROBE.id, { position: [0.2, 0, -4.2], rotation_y_deg: 0 }])).value
await sleep(300)
// zoom in about 3× around the piece, tap it, then drag from its upper front
let pit = itemOf(await state(page), pu)
const pc = await toClient(page, frontAt(pit, 0.6))
await page.evaluate(([x, y]) => window.midstudyCtx.engine.zoomAt(x, y, 3), pc)
await sleep(300)
pit = itemOf(await state(page), pu)
const p0 = await toClient(page, frontAt(pit, 0.6))
await page.touchscreen.tap(p0[0], p0[1])
await sleep(300)
const target = [p0[0] - 40, p0[1] + 120]
await touchDrag(page, p0, target, 16)
await sleep(300)
const pit1 = itemOf(await state(page), pu)
const p1 = await toClient(page, frontAt(pit1, 0.6))
ev.check('zoomed 3× on the phone, a finger drag keeps the grabbed point under the finger (±6 px)', p1 && Math.hypot(p1[0] - target[0], p1[1] - target[1]) <= 6,
  `from ${fmt(p0)} to ${fmt(target)}: point at ${fmt(p1)}; z ${pit.position[2]} → ${pit1?.position?.[2]}`)
await shot(page, 'phone-zoomed-drag')
await page.evaluate(() => window.midstudyCtx.engine.fitView())

// horizon: fine control at Fit
await hook(page, 'selectItem', [null])
await hook(page, 'setAdjustFloor', [true])
await sleep(400)
const hz = await page.evaluate(() => { const r = document.querySelector('[data-midstudy="horizon"]')?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null })
const pitch0 = (await hook(page, 'getCamera')).value.pitch_deg
if (hz) await touchDrag(page, hz, [hz[0], hz[1] + 20], 10)
await sleep(200)
const pitch1 = (await hook(page, 'getCamera')).value.pitch_deg
const dp = Math.abs(pitch1 - pitch0)
ev.check('at Fit on the phone, a 20 px horizon drag tilts by at most 0.12° a pixel (fine), and does tilt', !!hz && dp > 0.5 && dp <= 20 * 0.12 + 0.05, `Δpitch ${dp.toFixed(2)}° for 20 px`)
await hook(page, 'resetCamera')
await hook(page, 'setAdjustFloor', [false])
await sleep(200)

// toasts: one at a time over the photo
await page.evaluate(() => { const s = window.midstudyCtx.shell; s.toast('First message'); s.toast('Second message') })
await sleep(300)
const toasts = await page.locator('#toasts .toast:not(.is-leaving)').count()
ev.check('the phone shows one toast at a time (a new one replaces the last)', toasts === 1, `${toasts} toasts`)

// a library add: the "Making …" toast is replaced by the done one, not stacked
const glb = fs.readFileSync(path.join(srv.dirs.library, PROBE.id, 'model.glb')).toString('base64')
const job = await page.evaluate(async (b64) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  return window.midstudy.addItemFromFile(new File([bin], 'box.glb', { type: 'model/gltf-binary' }), { name: 'Second box', id: 'second-box', dims_cm: { w: 40, d: 40, h: 40 } })
}, glb).catch((e) => ({ error: String(e) }))
const done = await waitFor(async () => ((await api.get(srv.base, '/api/library/jobs')).json?.jobs || []).find((j) => j.item_id === 'second-box' && j.status === 'done'), { timeoutMs: 60000 })
await sleep(1500)
const toastTexts = await page.locator('#toasts .toast:not(.is-leaving) .toast-text').allInnerTexts()
ev.check('after a library add on the phone: one toast, and no stale "Making …"', !!done && toastTexts.length <= 1 && !toastTexts.some((t) => /^Making/.test(t)), fmt({ job: job?.error || job?.id, toasts: toastTexts }))
await page.locator('#toasts .toast-close').first().click().catch(() => {})

// copy: "Search 2 items" / "Search 1 item", "In the scene · n" counts pieces
await hook(page, 'addItem', [PROBE.id, { position: [-0.8, 0, -3.0] }])
await sleep(300)
const libBtn = page.getByRole('button', { name: /^library$/i })
for (let i = 0; i < await libBtn.count(); i++) if (await libBtn.nth(i).isVisible().catch(() => false)) { await libBtn.nth(i).tap(); break }
await sleep(500)
const ph = await page.locator('.p-search-input').first().getAttribute('placeholder').catch(() => '')
const chip = await page.getByText(/^In the scene · \d+$/).first().innerText().catch(() => '')
const nLib = (await hook(page, 'getLibrary')).value?.length
ev.check('the library search reads "Search N item(s)" with the right plural', ph === `Search ${nLib} ${nLib === 1 ? 'item' : 'items'}`, `${JSON.stringify(ph)} (${nLib} in the library)`)
ev.check('"In the scene · n" counts the pieces placed (2 probe boxes → 2)', chip === 'In the scene · 2', JSON.stringify(chip))
await shot(page, 'phone-library')

ev.section('errors')
const pageErrs = [...errsDesk.page, ...P.errors.page], consoleErrs = [...errsDesk.console, ...P.errors.console]
ev.check('no page errors', pageErrs.length === 0, pageErrs.join(' | ') || 'none')
ev.check('no console errors', consoleErrs.length === 0, consoleErrs.join(' | ') || 'none')
await ev.finish()
