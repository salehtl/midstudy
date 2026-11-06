// E9 eval:phone — the planner at 390 × 844, touch only (PLAN.md §6.2 E9; contract §2.3 Desktop and phone, §4.5, §4.6).
// A fresh phone (no scenes, no last scene) starts on the Scenes page. Through touch alone: New scene (file picker)
// → the scene opens; a library item is added by a tap; the item is dragged closer on the floor; turned; raised and
// lowered with Up / Down and dropped; a layout is saved; a render is made (twice) and two renders are compared.
// At every stage: every visible target ≥ 44 × 44 CSS px and no horizontal page scroll. The hook is used only to read
// state (and as a fallback that is reported, never counted as reachability). fal and calibration are mocked, $0.
// Usage: node evals/phone.mjs   (or npm run eval:phone). Screenshots: evals/out/phone/.
import path from 'node:path'
import {
  PROBE, createEval, startServer, launchBrowser, openPlanner, hook, state, itemOf, golden, fmt, api, waitFor, waitScene, control, sleep,
  smallTargets, horizontalScroll, findPhotoOnScreen, photoToCss, touchDrag, inspectCompare,
} from './lib/harness.mjs'

const ev = createEval('E9', 'phone', { timeoutS: 600 })
const LW = golden('living-wide'), { w: W, h: H } = LW.truth.image
const srv = await startServer(ev)
ev.check('the server starts (calib stub + MIDSTUDY_CALIB_MOCK, empty scenes dir)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const browser = await launchBrowser(ev)
const P = await openPlanner(browser, srv.base, { device: 'phone' })
const page = P.page
ev.check('the planner loads at 390 × 844 (touch, no scene)', P.hookOk, P.why || P.url)
const shot = (name) => page.screenshot({ path: path.join(ev.out, `${name}.png`) }).catch(() => {})
async function audit(label) {
  await sleep(300)
  await shot(label.replace(/\W+/g, '-'))
  const small = await smallTargets(page).catch((e) => [`(audit failed: ${e})`])
  ev.check(`${label}: every visible target ≥ 44 × 44 px`, small.length === 0, small.length ? small.join('; ') : 'all ≥ 44')
  const hs = await horizontalScroll(page)
  ev.check(`${label}: no horizontal page scroll`, hs.scrollWidth <= hs.innerWidth + 1 && hs.bodyScrollWidth <= hs.innerWidth + 1, fmt(hs))
}
const tap = async (c) => { if (!c.loc) return false; await c.loc.scrollIntoViewIfNeeded().catch(() => {}); return c.loc.tap({ timeout: 5000 }).then(() => true, () => false) }
const items = async () => (await state(page))?.items || []

// --- Scenes page and New scene -------------------------------------------------------------------------------------------------
ev.section('Scenes page → New scene')
const sp = await state(page)
ev.check('with no scenes and no last scene, the Scenes page shows (no scene open)', sp && sp.scene === null, fmt(sp?.scene))
const newBtn = await control(page, 'scene-new', [/new scene/i])
ev.check('New scene is reachable ([data-midstudy=scene-new])', !!newBtn.loc, newBtn.how)
await audit('Scenes page')
const fileInput = page.locator('[data-midstudy="scene-file"]')
const accept = (await fileInput.count()) ? await fileInput.first().getAttribute('accept') : null
ev.check('the file input ([data-midstudy=scene-file]) accepts camera-roll photos (accept="image/*")', /image\/\*/.test(accept || ''), `accept ${accept}`)
let chooser = null
if (newBtn.loc) [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null), tap(newBtn)])
if (chooser) await chooser.setFiles(LW.photo)
else if (await fileInput.count()) await fileInput.first().setInputFiles(LW.photo).catch(() => {})
const created = await waitFor(async () => ((await api.get(srv.base, '/api/scenes')).json?.scenes || [])[0], { timeoutMs: 15000 })
ev.check('tapping New scene and picking a photo uploads it', !!created, chooser ? 'file chooser opened' : 'no file chooser; set the input directly')
const NAME = created?.name
const done = NAME ? await waitScene(srv.base, NAME) : null
let opened = NAME ? await waitFor(async () => (await state(page))?.scene?.name === NAME, { timeoutMs: 20000 }) : null
let how = 'opened by itself when calibrated'
if (NAME && !opened) {
  const card = page.locator(`[data-midstudy="scene-card"][data-scene="${NAME}"]`)
  if (await card.count()) { await card.first().tap().catch(() => {}); how = 'tapped its scene-card' }
  opened = await waitFor(async () => (await state(page))?.scene?.name === NAME, { timeoutMs: 20000 })
}
ev.check('the new scene calibrates and opens', done?.calib_status === 'done' && !!opened, `${done?.calib_status}; ${opened ? how : 'not open'}`)
await audit('scene open')
const m = await findPhotoOnScreen(page, done?.photo_url || '/none', W, H)
ev.check('the photo is on screen (contain-fit, as is)', m.rect && m.median <= 10, `${m.how} median ${m.median} rect ${fmt(m.rect)}`)

// Closes open sheets, dialogs and coach marks (a person would before touching the photo): buttons named exactly
// Close / Done / Got it, up to 4 times.
async function closeSheets() {
  const closed = []
  for (let i = 0; i < 4; i++) {
    let hit = false
    for (const re of [/^close$/i, /^done$/i, /^got it$/i]) {
      const loc = page.getByRole('button', { name: re })
      const n = await loc.count().catch(() => 0)
      for (let k = 0; k < n && !hit; k++) {
        const b = loc.nth(k)
        if (!(await b.isVisible().catch(() => false))) continue
        hit = await b.tap({ timeout: 3000 }).then(() => true, () => false)
        if (hit) closed.push(String(re))
      }
    }
    if (!hit) break
    await sleep(350)
  }
  return closed
}
// A dock tab or toolbar button by its exact accessible name (anchored), else its handle.
const named = (handle, re) => control(page, handle, [re])

// --- add from the library -------------------------------------------------------------------------------------------------
ev.section('add from the library')
await closeSheets()
let entry = page.getByText(PROBE.name, { exact: false })
let libHow = 'library list already visible'
if (!(await entry.first().isVisible().catch(() => false))) {
  const lib = await named('library', /^library$/i)
  await tap(lib)
  libHow = lib.how
  await sleep(500)
  entry = page.getByText(PROBE.name, { exact: false })
}
await audit('library open')
const n0 = (await items()).length
const tapped = await entry.first().tap({ timeout: 5000 }).then(() => true, () => false)
const added = await waitFor(async () => (await items()).length > n0, { timeoutMs: 15000 })
ev.check('tapping a library item adds it to the scene', tapped && !!added, `${libHow}; tapped ${tapped}; items ${n0} → ${(await items()).length}`)
const uid = (await items()).at(-1)?.uid
const closed1 = await closeSheets()
ev.note(`closed: ${closed1.join(', ') || 'nothing'}`)
const covered = async (pt) => page.evaluate(([x, y]) => { const el = document.elementFromPoint(x, y); return el ? el.tagName.toLowerCase() !== 'canvas' : true }, pt)
const centerOf = async () => {
  const r = (await hook(page, 'getScreenRect', [uid])).value
  return r && m.rect ? photoToCss(m, r.x + r.w / 2, r.y + r.h * 0.6) : null
}

// --- select, drag, rotate, Up / Down -----------------------------------------------------------------------------------------
ev.section('select, drag, rotate, Up / Down')
const c0 = await centerOf()
const it0 = itemOf(await state(page), uid)
let dragged = false, it1 = null, r0 = null
if (c0) {
  r0 = (await hook(page, 'getScreenRect', [uid])).value
  await page.touchscreen.tap(c0[0], c0[1])
  await sleep(400)
  const selUp = await control(page, 'elev-up')
  ev.check('tapping the item selects it (its Up / Down controls appear)', !!selUp.loc, selUp.how)
  await touchDrag(page, c0, [c0[0], c0[1] + 30])
  await sleep(400)
  it1 = itemOf(await state(page), uid)
  dragged = it0 && it1 && it1.position[2] > it0.position[2] + 0.05
}
ev.check('a touch drag on the item moves it across the floor (closer, still at y = 0)', dragged && it1.position[1] === 0, c0 ? `${fmt(it0?.position)} → ${fmt(it1?.position)} (drag at ${fmt(c0)}, ${await covered(c0) ? 'covered by UI' : 'on the canvas'})` : 'no screen rect for the item')
const r1 = (await hook(page, 'getScreenRect', [uid])).value
ev.check('…and it grows on screen as it comes closer', dragged && r0 && r1 && r1.h > r0.h, `h ${r0?.h?.toFixed?.(1)} → ${r1?.h?.toFixed?.(1)} photo px`)
await audit('item selected')
const rot0 = itemOf(await state(page), uid)?.rotation_y_deg ?? NaN
const rot = await control(page, 'rotate', [/^\+\s*15°?$/, /\+\s*15/, /15°/, /^turn/i, /rotate/i]) // the ±15° buttons (§2.3), before a drag grip
await tap(rot)
await sleep(300)
const rot1 = itemOf(await state(page), uid)?.rotation_y_deg ?? NaN
const dRot = Math.abs((((rot1 - rot0) % 360) + 540) % 360 - 180)
ev.check('a touch control turns the selected item (15°)', !!rot.loc && Math.abs(dRot - 15) < 0.5, `${rot.how}: ${rot0} → ${rot1}`)
const up = await control(page, 'elev-up'), down = await control(page, 'elev-down')
for (let i = 0; i < 3; i++) await tap(up)
await sleep(200)
const e3 = itemOf(await state(page), uid)?.position?.[1]
await tap(down)
await sleep(200)
const e2 = itemOf(await state(page), uid)?.position?.[1]
const val = await control(page, 'elev-value')
const valText = val.loc ? await val.loc.evaluate((el) => el.value ?? el.textContent).catch(() => '') : ''
ev.check('Up × 3 then Down raise the item to 2 cm (elev-up, elev-down)', !!up.loc && !!down.loc && Math.abs(e3 - 0.03) < 1e-3 && Math.abs(e2 - 0.02) < 1e-3, `${up.how} ${down.how}: ${e3} → ${e2}`)
ev.check('elev-value shows the height in cm', /\b2(\.0+)?\b/.test(String(valText)), `${val.how}: "${String(valText).trim()}"`)
const drop = await control(page, 'drop')
await tap(drop)
await sleep(200)
ev.check('Drop to floor (drop) puts it back at 0', !!drop.loc && itemOf(await state(page), uid)?.position?.[1] === 0, `${drop.how}: ${itemOf(await state(page), uid)?.position?.[1]}`)

// --- save a layout -------------------------------------------------------------------------------------------------------
ev.section('save a layout')
await closeSheets()
const nl0 = (await hook(page, 'listLayouts')).value?.length ?? 0
const lay = await named('layouts', /^layouts$/i)
await tap(lay)
await sleep(500)
await audit('layouts open')
const steps = [lay.how]
const field = page.getByRole('textbox')
let fi = -1
for (let k = 0; k < await field.count(); k++) if (await field.nth(k).isVisible().catch(() => false)) { fi = k; break }
let save = await control(page, 'layout-save', [/^save( layout)?( as)?…?$/i, /^save as new/i, /^new layout$/i])
if (fi < 0 && save.loc) { await tap(save); steps.push(save.how); await sleep(400); for (let k = 0; k < await field.count(); k++) if (await field.nth(k).isVisible().catch(() => false)) { fi = k; break } }
if (fi >= 0) {
  await field.nth(fi).fill('phone-layout').catch(() => {})
  steps.push('typed a name')
  save = await control(page, 'layout-save', [/^save( layout)?$/i, /^ok$/i])
  if (save.loc) { await tap(save); steps.push(save.how) } else { await field.nth(fi).press('Enter').catch(() => {}); steps.push('Enter') }
}
const saved = await waitFor(async () => ((await hook(page, 'listLayouts')).value?.length ?? 0) > nl0, { timeoutMs: 8000 })
ev.check('a layout can be saved by touch (Layouts → name → Save)', !!saved, `${steps.join(' → ')}; layouts ${nl0} → ${(await hook(page, 'listLayouts')).value?.length}`)
await closeSheets()

// --- render twice, compare -----------------------------------------------------------------------------------------------
ev.section('render and compare')
for (const k of [1, 2]) {
  const nr0 = (await hook(page, 'listRenders')).value?.length ?? 0
  const rb = await named('render', /^render$/i)
  await tap(rb)
  await sleep(500)
  if (k === 1) {
    await audit('render dialog')
    const keep = await control(page, 'keep-room', [/keep room/i])
    ev.check('the render dialog shows Keep room exact (keep-room)', !!keep.loc, keep.how)
  }
  const go = await control(page, 'render-go', [/^render$/i, /^render \(/i])
  await tap(go)
  const ok = await waitFor(async () => ((await hook(page, 'listRenders')).value?.length ?? 0) > nr0, { timeoutMs: 60000 })
  ev.check(`render ${k} by touch (render → render-go)`, !!ok, `${rb.how}; ${go.how}`)
  await sleep(500)
  await closeSheets()
}
const lr = (await hook(page, 'listRenders')).value || []
const rp = await named('renders', /^renders$/i)
await tap(rp)
await sleep(600)
await audit('renders panel')
const cmpSteps = [rp.how]
let cmp = await control(page, 'compare', [/^compare/i])
// the spec: select two renders in the panel, then Compare (the order of the two steps is the app's choice)
if (cmp.loc) { await tap(cmp); cmpSteps.push(cmp.how); await sleep(400) }
for (const r of lr.slice(0, 2)) {
  const th = page.locator(`img[src*="${r.name}"]`)
  for (let k = 0; k < await th.count(); k++) if (await th.nth(k).isVisible().catch(() => false)) { await th.nth(k).tap().catch(() => {}); cmpSteps.push(`tap ${r.name}`); break }
  await sleep(250)
}
let cv = lr.length >= 2 ? await inspectCompare(page, lr[0].name, lr[1].name, { tryToggle: false }) : { error: 'fewer than two renders' }
if (!(cv.cover >= 0.85)) {
  const again = await control(page, 'compare', [/^compare/i])
  if (again.loc) { await tap(again); cmpSteps.push(`${again.how} again`); await sleep(600) }
  cv = lr.length >= 2 ? await inspectCompare(page, lr[0].name, lr[1].name) : cv
}
ev.check('Compare is reachable by touch and shows the two renders full-screen', cv.cover >= 0.85 && cv.aOn >= 0.5 && cv.bOn >= 0.5, `${cmpSteps.join(' → ')}; ${fmt(cv)}`)
if (!(cv.cover >= 0.85) && lr.length >= 2) {
  await hook(page, 'compare', [lr[0].name, lr[1].name])
  await sleep(600)
  cv = await inspectCompare(page, lr[0].name, lr[1].name)
  ev.note(`(hook fallback, not counted) compare(a, b): ${fmt(cv)}`)
}
ev.check('the phone Compare has the split slider', cv.slider > 0, fmt({ slider: cv.slider, toggled: cv.toggled ?? null }))
await audit('compare')
// Verify round 1: A and B must be told apart on the phone (their layout, whole), and the split must cover the image only.
const tags = await page.evaluate(() => [...document.querySelectorAll('.cv-tag span')].filter((e) => e.checkVisibility()).map((e) => ({ text: e.textContent, cut: e.scrollWidth > e.clientWidth + 1 }))).catch(() => [])
ev.check('Compare captions on the phone name the layout and are not cut off', tags.length >= 2 && tags.every((t) => /phone.layout/i.test(t.text) && !t.cut), fmt(tags))
const split = await page.evaluate(() => {
  const box = document.querySelector('.cv-split'), img = box?.querySelector('img')
  if (!box || !img?.naturalWidth) return null
  const r = box.getBoundingClientRect()
  return { boxAr: r.width / r.height, imgAr: img.naturalWidth / img.naturalHeight, h: r.height }
}).catch(() => null)
ev.check('the split box has the render\'s own shape (the line and handle stay on the image, not the bars)', !!split && Math.abs(split.boxAr / split.imgAr - 1) < 0.02, fmt(split))
await closeSheets()
await sleep(300)
// the render viewer (tap a render in the panel)
const rp2 = await named('renders', /^renders$/i)
await tap(rp2)
await sleep(500)
const row = page.locator('button[data-render]')
let viewerOpen = false
for (let k = 0; k < await row.count(); k++) if (await row.nth(k).isVisible().catch(() => false)) { viewerOpen = await row.nth(k).tap({ timeout: 5000 }).then(() => true, () => false); break }
await sleep(500)
ev.check('a render opens in the viewer by touch', viewerOpen && await page.locator('.rv-phone').first().isVisible().catch(() => false), `tapped ${viewerOpen}`)
await audit('render viewer')
const head = await page.locator('.rv-phone .rv-titles').first().innerText().catch(() => '')
ev.check('the phone viewer header names the layout', /phone.layout/i.test(head), JSON.stringify(head))
await closeSheets()

ev.section('errors')
ev.check('no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
ev.check('no console errors', P.errors.console.length === 0, P.errors.console.join(' | ') || 'none')
ev.check('no request refused as cross-site', P.errors.refused.length === 0, P.errors.refused.join(' | ') || 'none')
await ev.finish()
