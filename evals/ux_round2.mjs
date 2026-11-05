// E12 eval:ux2 — regressions for the verify round 2 UX findings (docs/notes/verify-fix-2.md). Desktop 1440 × 900 and
// phone 390 × 844 on the golden living-wide scene (its true camera), fal and calibration mocked, $0. Sections:
//   scenes     no stray "null" under the Scenes grid (empty, with scenes, after a restore)
//   layouts    a scene opens with its layout on the other device: the newest saved one, unless this device chose
//              one later (save, load, delete); a reload keeps this device's own choice
//   ruler      the photo doesn't move between the two ruler taps; the phone's instruction isn't hidden under Reset;
//              Set scale redraws the ruler's label at once (without a pointer move)
//   phone      the selection label stays left of the lift column when zoomed; toasts with a sheet open sit above
//              the photo, not over it; Compare can swap A and B
//   library    a piece added from a 3D file gets a thumbnail, not initials
// Usage: node evals/ux_round2.mjs (npm run eval:ux2). Screenshots: evals/out/ux2/.
import path from 'node:path'
import fs from 'node:fs'
import {
  REPO, PROBE, createEval, startServer, launchBrowser, openPlanner, hook, state, itemOf, golden, fmt, api, waitFor, sleep,
  seedScene, ensureScene,
} from './lib/harness.mjs'

const ev = createEval('E12', 'ux2', { timeoutS: 900 })
const LW = golden('living-wide'), { w: W, h: H } = LW.truth.image
const shot = (page, name) => page.screenshot({ path: path.join(ev.out, `${name}.png`) }).catch(() => {})
const rectOf = (page, sel) => page.evaluate((sel) => { const e = document.querySelector(sel); if (!e || e.hidden) return null; const r = e.getBoundingClientRect(); return r.width ? { x: r.x, y: r.y, w: r.width, h: r.height } : null }, sel)
const photoRect = (page) => page.evaluate(() => { const r = window.midstudyCtx.engine.getPhotoRect(); return { x: r.x, y: r.y, w: r.w, h: r.h } })
const sameRect = (a, b, tol = 1) => !!a && !!b && ['x', 'y', 'w', 'h'].every((k) => Math.abs(a[k] - b[k]) <= tol)
const overlap = (a, b) => !!a && !!b && a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h
// Text nodes reading exactly "null" anywhere under a selector (replaceChildren(null) makes one).
const nullNodes = (page, sel) => page.evaluate((sel) => {
  const root = document.querySelector(sel)
  if (!root) return -1
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let n = 0
  while (w.nextNode()) if (w.currentNode.nodeValue.trim() === 'null') n++
  return n
}, sel)

const srv = await startServer(ev)
ev.check('serve.py starts (stub calibration + MIDSTUDY_CALIB_MOCK)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const browser = await launchBrowser(ev)

// --- scenes: no "null" under the grid ----------------------------------------------------------------------------------------
ev.section('scenes: nothing under the grid when Recently deleted is empty')
for (const device of ['desktop', 'phone']) {
  const P = await openPlanner(browser, srv.base, device === 'phone' ? { device } : { viewport: { width: 1440, height: 900 } })
  await waitFor(() => P.page.locator('.sc-root .sc-empty').first().isVisible().catch(() => false), { timeoutMs: 8000 })
  const n = await nullNodes(P.page, '.sc-root')
  const txt = await P.page.locator('.sc-root').innerText().catch(() => '')
  ev.check(`${device}: the empty Scenes page (the first screen) has no "null" under "Take or choose a photo"`, n === 0 && !/\bnull\b/.test(txt), `${n} null text nodes; text ${JSON.stringify(txt.slice(-80))}`)
  await shot(P.page, `${device}-scenes-empty`)
  await P.context.close()
}
const S = await seedScene(srv, 'living-wide', 'Living room')
const S2 = await seedScene(srv, 'steep-roll', 'Second room')
ev.check('golden living-wide and steep-roll calibrated', S.name && !S.why && S2.name && !S2.why, `${S.why || S.name} ${S2.why || S2.name}`)
let P = await openPlanner(browser, srv.base, { viewport: { width: 1440, height: 900 } })
let page = P.page
await page.evaluate(() => window.midstudyCtx.shell.openPage('scenes'))
await waitFor(() => page.locator('[data-midstudy="scene-card"]').first().isVisible().catch(() => false), { timeoutMs: 8000 })
ev.check('with scenes: no "null" under the cards', (await nullNodes(page, '.sc-root')) === 0, `${await nullNodes(page, '.sc-root')} null text nodes`)
await api.send(srv.base, 'DELETE', `/api/scenes/${S2.name}`)
await page.evaluate(() => window.midstudyCtx.engine.listScenesInternal())
await waitFor(() => page.locator(`[data-midstudy="scene-restore"][data-scene="${S2.name}"]`).first().isVisible().catch(() => false), { timeoutMs: 5000 })
const restore = page.locator(`[data-midstudy="scene-restore"][data-scene="${S2.name}"]`)
const hadRestore = await restore.first().isVisible().catch(() => false)
if (hadRestore) await restore.first().click()
await waitFor(async () => ((await api.get(srv.base, '/api/scenes')).json?.scenes || []).some((s) => s.name === S2.name), { timeoutMs: 5000 })
await waitFor(async () => !(await page.locator('.sc-trash').count()), { timeoutMs: 5000 })
ev.check('after Recently deleted › Restore (the trash empty again): no "null" under the cards', hadRestore && (await nullNodes(page, '.sc-root')) === 0 && !(await page.locator('.sc-trash').count()),
  `restore shown ${hadRestore}; ${await nullNodes(page, '.sc-root')} null text nodes`)
await shot(page, 'desktop-scenes-restored')
await page.evaluate(() => window.midstudyCtx.shell.closePage())
await P.context.close()

// --- layouts: the other device -----------------------------------------------------------------------------------------------
ev.section('layouts: a scene opens with its layout on the other device')
const desk = await openPlanner(browser, srv.base, { scene: S.name, viewport: { width: 1440, height: 900 } })
ev.check('desktop opens the scene', desk.hookOk && (await ensureScene(desk.page, S.name)).ok, desk.why)
await hook(desk.page, 'clearItems')
await hook(desk.page, 'addItem', [PROBE.id, { position: [-0.6, 0, -3.2] }])
await hook(desk.page, 'saveLayout', ['corner-chair', { title: 'Corner chair' }])
await hook(desk.page, 'addItem', [PROBE.id, { position: [0.7, 0, -2.6] }])
await sleep(1100) // `updated` has whole seconds: keep the saves in different seconds
await hook(desk.page, 'saveLayout', ['two-chairs', { title: 'Two chairs' }])
const phone = await openPlanner(browser, srv.base, { device: 'phone', scene: S.name })
let st = await waitFor(async () => { const s = await state(phone.page); return s?.scene?.name === S.name && s.items?.length === 2 ? s : null }, { timeoutMs: 15000 }) || await state(phone.page)
ev.check('desktop saves "Corner chair" then "Two chairs"; the phone (never opened the scene) opens it with "Two chairs" and its 2 pieces, not an empty room',
  st?.scene?.name === S.name && st.layout === 'two-chairs' && st.items?.length === 2 && st.dirty === false, fmt({ layout: st?.layout, items: st?.items?.length, dirty: st?.dirty }))
await shot(phone.page, 'phone-opens-desktop-layout')
await sleep(1100)
await hook(phone.page, 'clearItems')
await hook(phone.page, 'addItem', [PROBE.id, { position: [0, 0, -2.2] }])
await hook(phone.page, 'saveLayout', ['phone-b', { title: 'Phone B' }])
await desk.page.reload({ waitUntil: 'load' })
await desk.page.evaluate(() => window.midstudy.ready)
st = await waitFor(async () => { const s = await state(desk.page); return s?.layout === 'phone-b' ? s : null }, { timeoutMs: 15000 }) || await state(desk.page)
ev.check('the phone then saves "Phone B": the desktop, reloaded, opens with Phone B (saved after its own Two chairs)', st?.layout === 'phone-b' && st.items?.length === 1 && st.dirty === false,
  fmt({ layout: st?.layout, items: st?.items?.length }))
await sleep(300)
await hook(desk.page, 'loadLayout', ['corner-chair'])
await desk.page.reload({ waitUntil: 'load' })
await desk.page.evaluate(() => window.midstudy.ready)
st = await waitFor(async () => { const s = await state(desk.page); return s?.scene?.name === S.name && s.layout ? s : null }, { timeoutMs: 15000 }) || await state(desk.page)
ev.check('the desktop loads Corner chair (after the phone\'s save): a reload keeps Corner chair, this device\'s later choice', st?.layout === 'corner-chair' && st.items?.length === 1,
  fmt({ layout: st?.layout, items: st?.items?.length }))
await phone.page.reload({ waitUntil: 'load' })
await phone.page.evaluate(() => window.midstudy.ready)
st = await waitFor(async () => { const s = await state(phone.page); return s?.scene?.name === S.name && s.layout ? s : null }, { timeoutMs: 15000 }) || await state(phone.page)
ev.check('…and the phone, reloaded, keeps its own Phone B (a load elsewhere isn\'t a save)', st?.layout === 'phone-b', fmt({ layout: st?.layout, items: st?.items?.length }))
await desk.context.close()

// --- ruler: the photo stays put, the phone's instruction is readable, Set scale redraws ----------------------------------------
ev.section('ruler')
P = await openPlanner(browser, srv.base, { scene: S.name, viewport: { width: 1440, height: 900 } })
page = P.page
await ensureScene(page, S.name)
await hook(page, 'clearItems')
await hook(page, 'setAdjustFloor', [true])
await sleep(300)
const rulerBtn = page.getByRole('button', { name: /^ruler$/i }).first()
await rulerBtn.click()
// Ruler on adds its row and the photo resizes once (an animated layout change, done well within 1.5 s under swiftshader);
// measure after it settles: the check is that the taps don't move it (main session, 2026-11-05: a fixed 300 ms flaked).
{ let prev = null; for (let i = 0; i < 20; i++) { await sleep(150); const r = await photoRect(page); if (prev && sameRect(prev, r) && i >= 3) break; prev = r } }
const fp = LW.truth.floor_points
const far = fp.reduce((best, q) => (Math.hypot(q.world[0] - fp[0].world[0], q.world[2] - fp[0].world[2]) > Math.hypot(best.world[0] - fp[0].world[0], best.world[2] - fp[0].world[2]) ? q : best), fp[1])
const trueM = Math.hypot(fp[0].world[0] - far.world[0], fp[0].world[2] - far.world[2])
const r0 = await photoRect(page)
const hint0 = await page.locator('.ws-adj-rhint').first().innerText().catch(() => '')
const css = (rect, px) => [rect.x + (px[0] / W) * rect.w, rect.y + (px[1] / H) * rect.h]
let c = css(r0, fp[0].px)
await page.mouse.click(c[0], c[1])
await sleep(300)
const r1 = await photoRect(page)
c = css(r1, far.px)
await page.mouse.click(c[0], c[1])
await sleep(400)
const r2 = await photoRect(page)
ev.check('desktop: the photo doesn\'t move or resize between Ruler on, the first tap and the second (the length row was already there)',
  sameRect(r0, r1) && sameRect(r1, r2) && /two points/i.test(hint0), fmt({ r0, r1, r2, hint0 }))
await page.locator('[data-midstudy="ruler-true"]').fill('300')
await page.locator('[data-midstudy="ruler-set"]').click()
const pillAt = async () => page.evaluate(() => { const p = document.querySelector('.ws-dist'); return p && !p.hidden ? p.textContent : null })
await sleep(150)
const pill1 = await pillAt()
await sleep(1200)
const pill2 = await pillAt()
ev.check('desktop: right after Set scale (no pointer move), the ruler\'s label on the photo reads the length typed (300 cm)', pill1 === '300 cm' && pill2 === '300 cm', fmt({ after150ms: pill1, after1350ms: pill2, measuredBefore: `${Math.round(trueM * 100)} cm` }))
await shot(page, 'desktop-ruler-set')
await hook(page, 'resetCamera')
await hook(page, 'setAdjustFloor', [false])
await P.context.close()

// phone
P = await openPlanner(browser, srv.base, { device: 'phone', scene: S.name })
page = P.page
await ensureScene(page, S.name)
await page.evaluate(() => { localStorage.setItem('midstudy.hint.gestures', '1') })
await hook(page, 'clearItems')
await hook(page, 'setAdjustFloor', [true])
await sleep(400)
await page.getByRole('button', { name: /^ruler$/i }).first().tap()
await sleep(400)
const q0 = await photoRect(page)
const hintBox = async () => page.evaluate(() => {
  const e = document.querySelector('.ws-adj-rhint')
  if (!e || e.hidden) return null
  const r = e.getBoundingClientRect(), btns = [...document.querySelectorAll('.ws-adjust .ws-adj-btn')].filter((b) => b.offsetWidth).map((b) => { const q = b.getBoundingClientRect(); return { t: b.textContent.trim(), x: q.x, y: q.y, w: q.width, h: q.height } })
  const hit = (q) => r.x < q.x + q.w && q.x < r.x + r.width && r.y < q.y + q.h && q.y < r.y + r.height
  return { text: e.textContent, w: r.width, scrollW: e.scrollWidth, clipped: e.scrollWidth > e.clientWidth + 1, under: btns.filter(hit).map((q) => q.t), visible: getComputedStyle(e).visibility !== 'hidden' }
})
const hA = await hintBox()
await shot(page, 'phone-ruler-on')
let pc = css(q0, fp[0].px)
await page.touchscreen.tap(pc[0], pc[1])
await sleep(300)
const hB = await hintBox()
const q1 = await photoRect(page)
pc = css(q1, far.px)
await page.touchscreen.tap(pc[0], pc[1])
await sleep(400)
const q2 = await photoRect(page)
ev.check('phone: "Tap two points on the floor…" and "Tap the other end" are whole and clear of Reset and Looks right',
  !!hA && !!hB && /two points/i.test(hA.text) && /other end/i.test(hB.text) && !hA.clipped && !hB.clipped && !hA.under.length && !hB.under.length, fmt({ hA, hB }))
ev.check('phone: the photo doesn\'t move between the two taps', sameRect(q0, q1) && sameRect(q1, q2), fmt({ q0, q1, q2 }))
const setBtn = await rectOf(page, '[data-midstudy="ruler-set"]'), trueField = await rectOf(page, '[data-midstudy="ruler-true"]')
ev.check('phone: once measured, "[Real length] cm · Set scale" sits on one line (44 px targets)', !!setBtn && !!trueField && Math.abs(setBtn.y - trueField.y) < 2 && setBtn.h >= 44 && trueField.h >= 44, fmt({ setBtn, trueField }))
await shot(page, 'phone-ruler-measured')
await hook(page, 'resetCamera')
await hook(page, 'setAdjustFloor', [false])
await sleep(300)

// --- phone: the label and the lift column, toasts with a sheet, Compare swap ------------------------------------------------------
ev.section('phone: label, toasts, Compare')
await hook(page, 'clearItems')
const pu = (await hook(page, 'addItem', [PROBE.id, { position: [0.9, 0, -3.0] }])).value
await hook(page, 'selectItem', [pu])
await sleep(300)
const it = itemOf(await state(page), pu)
const top = await hook(page, 'floorToPhoto', [[it.position[0], 0.6, it.position[2]]])
const pr = await photoRect(page)
const at = [pr.x + (top.value[0] / W) * pr.w, pr.y + (top.value[1] / H) * pr.h]
await page.evaluate(([x, y]) => window.midstudyCtx.engine.zoomAt(x, y, 3), at) // the piece stays right of centre, 3× bigger
await sleep(500)
const lab = await rectOf(page, '.ws-label'), liftR = await rectOf(page, '.ws-lift')
ev.check('zoomed 3× with the piece right of centre, its name and size stay left of the lift column (not cut off under it)',
  !!lab && !!liftR && lab.x + lab.w <= liftR.x + 0.5, fmt({ label: lab, lift: liftR }))
await shot(page, 'phone-zoomed-label')
await page.evaluate(() => window.midstudyCtx.engine.fitView())
await hook(page, 'selectItem', [null])
await sleep(300)

const lb = page.getByRole('button', { name: /^layouts$/i })
for (let i = 0; i < await lb.count(); i++) if (await lb.nth(i).isVisible().catch(() => false)) { await lb.nth(i).tap(); break }
await sleep(500)
await page.evaluate(() => window.midstudyCtx.shell.toast('Layout saved as Phone C', { kind: 'ok' }))
await sleep(300)
const toastR = await rectOf(page, '#toasts .toast:not(.is-leaving)')
const vis = await page.evaluate(() => { const r = window.midstudyCtx.engine.getVisiblePhotoRect(); return { x: r.x, y: r.y, w: r.w, h: r.h } })
const box = await page.evaluate((uid) => window.midstudy.getScreenRect(uid), pu)
const prNow = await photoRect(page) // the sheet made the photo smaller
const boxCss = box ? { x: prNow.x + (box.x / W) * prNow.w, y: prNow.y + (box.y / H) * prNow.h, w: (box.w / W) * prNow.w, h: (box.h / H) * prNow.h } : null
const sheetOpen = await page.evaluate(() => document.documentElement.dataset.sheet)
ev.check('with a sheet open, a toast sits above the photo (not over the piece or the photo\'s lower part)', !!toastR && !!sheetOpen && !overlap(toastR, vis) && !overlap(toastR, boxCss),
  fmt({ sheet: sheetOpen, toast: toastR, photo: vis, piece: boxCss }))
await shot(page, 'phone-toast-sheet')
await page.locator('#toasts .toast-close').first().tap().catch(() => {})
await page.evaluate(() => window.midstudyCtx.shell.closePanel())
await sleep(300)

const ra = (await hook(page, 'renderView', [{}])).value, rb = (await hook(page, 'renderView', [{}])).value
await hook(page, 'compare', [ra?.name, rb?.name])
await sleep(800)
const swap = page.locator('[data-midstudy="compare-swap"]')
const swapR = await rectOf(page, '[data-midstudy="compare-swap"]')
// Split (the phone's first mode): A under, B on top
const pair = async () => page.evaluate(() => [document.querySelector('.cv-under')?.getAttribute('src'), document.querySelector('.cv-top')?.getAttribute('src')])
const before = await pair()
if (swapR) await swap.first().tap()
await sleep(400)
const after = await pair()
ev.check('phone Compare has Swap A and B (44 px), and it swaps the two renders', !!swapR && swapR.w >= 44 && swapR.h >= 44 && !!before[0] && !!before[1] && before[0] !== before[1] && after[0] === before[1] && after[1] === before[0],
  fmt({ swap: swapR, before, after }))
await shot(page, 'phone-compare-swapped')
const phoneErrs = P.errors
await P.context.close()
await phone.context.close()

// --- library: pieces from a 3D file get a thumbnail ---------------------------------------------------------------------------
ev.section('library: a piece added from a 3D file gets a thumbnail')
const metaHdr = Buffer.from(JSON.stringify({ name: 'Sheen chair', dims_cm: { w: 70, d: 75, h: 80 }, engine: 'glb' })).toString('base64')
const addR = await api.send(srv.base, 'POST', '/api/library/items', fs.readFileSync(path.join(REPO, 'fixtures/models/SheenChair.glb')),
  { headers: { 'X-Midstudy-Kind': 'model', 'X-Midstudy-Filename': 'SheenChair.glb', 'X-Midstudy-Meta': metaHdr }, raw: true })
const addJob = addR.json?.job?.id
const jobDone = await waitFor(async () => { const j = (await api.get(srv.base, `/api/library/jobs/${addJob}`)).json; return j?.status === 'done' || j?.status === 'failed' ? j : null }, { timeoutMs: 120000 })
ev.check('SheenChair.glb added through the library API ($0, engine glb), no thumb.jpg from midstudy-add', addR.status === 202 && jobDone?.status === 'done' && !jobDone?.item?.assets?.thumb, fmt({ status: addR.status, job: jobDone?.status, thumb: jobDone?.item?.assets?.thumb, msg: jobDone?.message }))
P = await openPlanner(browser, srv.base, { scene: S.name, viewport: { width: 1440, height: 900 } })
page = P.page
const thumbs = await waitFor(async () => {
  const items = (await api.get(srv.base, '/api/library')).json?.items || []
  const want = items.filter((i) => ['probe-box', 'sheen-chair'].includes(i.id))
  return want.length === 2 && want.every((i) => i.assets?.thumb) ? want : null
}, { timeoutMs: 30000 })
const thumbInfo = []
for (const it2 of thumbs || []) {
  const g = await api.get(srv.base, `/library/${it2.assets.thumb}`, { raw: true })
  const px = await page.evaluate(async (src) => {
    const img = new Image(); img.src = src; await img.decode()
    const c = document.createElement('canvas'); c.width = img.naturalWidth; c.height = img.naturalHeight
    const g2 = c.getContext('2d'); g2.drawImage(img, 0, 0)
    const d = g2.getImageData(0, 0, c.width, c.height).data, bg = [d[0], d[1], d[2]]
    let differs = 0, magenta = 0
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 40) differs++
      if (d[i] > 180 && d[i + 2] > 180 && d[i + 1] < 90) magenta++
    }
    return { w: c.width, h: c.height, model: differs / (d.length / 4), magenta: magenta / (d.length / 4) }
  }, `/library/${it2.assets.thumb}`)
  thumbInfo.push({ id: it2.id, status: g.status, type: g.headers?.['content-type'], ...px })
}
ev.check('the planner renders each one a 256 px thumbnail and stores it (assets.thumb, /library/<id>/thumb.jpg, image/jpeg)',
  thumbInfo.length === 2 && thumbInfo.every((t) => t.status === 200 && /image\/jpeg/.test(t.type || '') && t.w === 256 && t.h === 256), fmt(thumbInfo))
ev.check('…showing the model (it fills 5–90 % of the frame; the magenta probe box is magenta)', thumbInfo.length === 2 && thumbInfo.every((t) => t.model > 0.05 && t.model < 0.9) && (thumbInfo.find((t) => t.id === 'probe-box')?.magenta || 0) > 0.05, fmt(thumbInfo))
const libBtn2 = page.getByRole('button', { name: /^library$/i })
for (let i = 0; i < await libBtn2.count(); i++) if (await libBtn2.nth(i).isVisible().catch(() => false)) { await libBtn2.nth(i).click(); break }
await sleep(600)
const rowsImg = await page.evaluate(() => [...document.querySelectorAll('.lib-row')].map((r) => ({ name: r.querySelector('.lib-name, [class*="name"]')?.textContent, img: !!r.querySelector('img.lib-thumb'), mono: !!r.querySelector('.lib-thumb.is-mono') })))
ev.check('the Library panel shows the thumbnails, not initials', rowsImg.length >= 2 && rowsImg.every((r) => r.img && !r.mono), fmt(rowsImg))
await shot(page, 'desktop-library-thumbs')
const deskErrs = P.errors
await P.context.close()

ev.section('errors')
ev.check('no page errors', phoneErrs.page.length === 0 && deskErrs.page.length === 0, [...phoneErrs.page, ...deskErrs.page].join(' | ') || 'none')
ev.check('no console errors', phoneErrs.console.length === 0 && deskErrs.console.length === 0, [...phoneErrs.console, ...deskErrs.console].join(' | ') || 'none')
await ev.finish()
