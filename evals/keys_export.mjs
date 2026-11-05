// E17 eval:keys — keyboard shortcuts, Shift multi-select, arrow-key moves and Export (no AI), on golden living-wide at
// 1440 × 900 (desktop) and 390 × 844 (phone, Export only). fal and calibration mocked, $0. Real key presses and mouse
// clicks throughout (Playwright), read back through window.midstudy and window.midstudyCtx (the keymap, the engine's
// selection and the exporter have no hook of their own).
//   keymap     the registry formats combos (⌘?, ⇧R, ←), lists every group, and each command it lists is in the sheet
//   select     click selects; Shift+click adds and takes out; two footprints and "2 selected"; ⌘A; Esc
//   move       arrows move every selected piece 1 cm (Shift 10 cm, ↑ away from the camera); PageUp raises them; R turns
//              the pair about its middle (centre and spacing kept); a mouse drag on one moves both by the same amount;
//              Shift+drag lifts both; ⌘D duplicates the pair 30 cm right and selects the copies; Delete removes both and
//              ⌘Z brings them back selected
//   typing     keys typed in the library search don't reach the pieces ("/" opens and focuses it)
//   help       ⌘? opens the Shortcuts sheet and closes it; ? opens it; Esc closes it
//   export     exportNow at Full matches the render capture pixel for pixel (JPEG noise only), 1280 px and PNG sizes,
//              Before and after (the photo above the scene for a wide photo); ⌘E → the sheet → Save image downloads a
//              PNG of the chosen size, and nothing is POSTed; the phone's Export tool opens the sheet, 44 px targets, no
//              sideways scroll
// Usage: node evals/keys_export.mjs (npm run eval:keys). Screenshots: evals/out/keys/.
import fs from 'node:fs'
import path from 'node:path'
import {
  PROBE, createEval, startServer, launchBrowser, openPlanner, hook, state, itemOf, golden, fmt, sleep, seedScene, ensureScene,
  smallTargets, horizontalScroll,
} from './lib/harness.mjs'

const ev = createEval('E17', 'keys', { timeoutS: 600 })
const LW = golden('living-wide'), { w: W, h: H } = LW.truth.image
const shot = (page, name) => page.screenshot({ path: path.join(ev.out, `${name}.png`) }).catch(() => {})
const near = (a, b, tol = 1e-4) => Math.abs(a - b) <= tol

const srv = await startServer(ev)
ev.check('serve.py starts (stub calibration + MIDSTUDY_CALIB_MOCK)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const S = await seedScene(srv, 'living-wide', 'Living room')
ev.check('golden living-wide calibrated', S.name && !S.why, S.why || S.name)
const browser = await launchBrowser(ev)
const P = await openPlanner(browser, srv.base, { scene: S.name, viewport: { width: 1440, height: 900 } })
const page = P.page
ev.check('the planner opens the scene at 1440 × 900', P.hookOk && (await ensureScene(page, S.name)).ok, P.why || P.url)
const posts = []
page.on('request', (r) => { if (r.method() !== 'GET') posts.push(`${r.method()} ${new URL(r.url()).pathname}`) })

const eng = (fn, arg) => page.evaluate(fn, arg)
const selection = () => eng(() => window.midstudyCtx.engine.getSelection())
const items = async () => Object.fromEntries(((await state(page))?.items || []).map((i) => [i.uid, i]))
// the centre of a piece on screen (client px), from its projected box (photo px) and the photo's rectangle
async function centreOf(uid, up = 0.5) {
  return eng(({ uid, up }) => {
    const e = window.midstudyCtx.engine
    const r = e.getScreenRect(uid), rect = e.getPhotoRect(), sz = e.getPhotoSize()
    const k = rect.w / sz.w
    return [rect.x + (r.x + r.w / 2) * k, rect.y + (r.y + r.h * up) * k]
  }, { uid, up })
}
async function click(pt, { shift = false } = {}) {
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.click(pt[0], pt[1])
  if (shift) await page.keyboard.up('Shift')
  await sleep(150)
}
async function drag(from, to, { shift = false, steps = 12 } = {}) {
  if (shift) await page.keyboard.down('Shift')
  await page.mouse.move(from[0], from[1])
  await page.mouse.down()
  for (let i = 1; i <= steps; i++) await page.mouse.move(from[0] + ((to[0] - from[0]) * i) / steps, from[1] + ((to[1] - from[1]) * i) / steps)
  await page.mouse.up()
  if (shift) await page.keyboard.up('Shift')
  await sleep(200)
}
const press = async (k, n = 1) => { for (let i = 0; i < n; i++) await page.keyboard.press(k); await sleep(120) }

// --- keymap -----------------------------------------------------------------------------------------------------------------
ev.section('keymap')
const km = await eng(() => {
  const k = window.midstudyCtx.keys
  return { isMac: k.isMac, f: ['mod+shift+/', 'shift+r', 'arrowleft', 'shift+=', 'escape', 'mod+z', 'shift+click'].map((c) => k.format(c)), list: k.list() }
})
const want = km.isMac ? ['⌘?', '⇧R', '←', '+', 'Esc', '⌘Z', '⇧Click'] : ['Ctrl+?', 'Shift+R', '←', '+', 'Esc', 'Ctrl+Z', 'Shift+Click']
ev.check('combos format as the keys read (⌘? not ⌘⇧/, + not ⇧=)', fmt(km.f) === fmt(want), `${fmt(km.f)} (want ${fmt(want)})`)
const groups = km.list.map((g) => g.group)
ev.check('the registry lists Selection, Move and turn, View, Tools, Panels and Help, in that order', fmt(groups) === fmt(['Selection', 'Move and turn', 'View', 'Tools', 'Panels', 'Help']), fmt(groups))
const ids = km.list.flatMap((g) => g.items.map((i) => i.id))
const needIds = ['select.all', 'select.shift', 'select.none', 'item.move', 'item.raise', 'item.rotate', 'item.duplicate', 'item.remove', 'edit.undo', 'view.fit', 'tool.export', 'tool.occlusion', 'library.search', 'help.shortcuts']
ev.check('every shortcut asked for is registered (select, move, turn, duplicate, remove, undo, fit, export, help …)', needIds.every((i) => ids.includes(i)), `missing: ${fmt(needIds.filter((i) => !ids.includes(i)))}`)

// --- select ----------------------------------------------------------------------------------------------------------------
ev.section('select (Shift+click)')
const a = (await hook(page, 'addItem', [PROBE.id, { position: [-0.7, 0, -3.3], rotation_y_deg: 0 }])).value
const b = (await hook(page, 'addItem', [PROBE.id, { position: [0.8, 0, -3.7], rotation_y_deg: 0 }])).value
ev.check('two probe boxes placed', !!a && !!b, fmt({ a, b }))
await hook(page, 'selectItem', [null])
await sleep(200)
await click(await centreOf(a))
ev.check('a click on a piece selects only it', fmt(await selection()) === fmt([a]), fmt(await selection()))
await click(await centreOf(b), { shift: true })
let sel = await selection()
ev.check('Shift+click on a second piece adds it (both selected, the new one primary)', fmt(sel) === fmt([a, b]) && (await eng(() => window.midstudyCtx.engine.getSelected())) === b, fmt(sel))
// the overlay draws on the next frame (software rendering can take a while): wait for it
await page.waitForFunction(() => [...document.querySelectorAll('.ws-svg polygon.ws-fp')].filter((p) => p.style.display !== 'none' && p.getAttribute('points')).length === 2 && /more/.test(document.querySelector('.ws-label')?.textContent || ''), null, { timeout: 5000 }).catch(() => {})
const ui = await eng(() => ({
  fps: [...document.querySelectorAll('.ws-svg polygon.ws-fp')].filter((p) => p.style.display !== 'none' && p.getAttribute('points')).length,
  count: document.querySelector('[data-midstudy="selection-count"]')?.textContent || null,
  label: document.querySelector('.ws-label')?.textContent || '',
}))
ev.check('two footprints on screen, the bar says "2 selected", the label "+ 1 more"', ui.fps === 2 && ui.count === '2 selected' && /\+ 1 more/.test(ui.label), fmt(ui))
await shot(page, 'two-selected')
await click(await centreOf(a), { shift: true })
ev.check('Shift+click on a selected piece takes it out', fmt(await selection()) === fmt([b]), fmt(await selection()))
await click(await centreOf(a), { shift: true })
ev.check('…and Shift+click adds it back', fmt(await selection()) === fmt([b, a]), fmt(await selection()))
const photoPt = await eng(() => { const r = window.midstudyCtx.engine.getVisiblePhotoRect(); return [r.x + r.w * 0.5, r.y + r.h * 0.12] })
await click(photoPt, { shift: true })
ev.check('Shift+click on the photo (no piece) keeps the selection', (await selection()).length === 2, fmt(await selection()))
await press('Escape')
ev.check('Esc deselects everything', (await selection()).length === 0, fmt(await selection()))
await press('ControlOrMeta+a')
ev.check('⌘A selects every piece', (await selection()).length === 2, fmt(await selection()))

// --- move ------------------------------------------------------------------------------------------------------------------
ev.section('move and turn (keys and drags)')
let s0 = await items()
await press('ArrowRight', 3)
await press('Shift+ArrowUp')
let s1 = await items()
const moved = [a, b].map((u) => [s1[u].position[0] - s0[u].position[0], s1[u].position[1] - s0[u].position[1], s1[u].position[2] - s0[u].position[2]])
ev.check('→ ×3 and Shift+↑ move both pieces +3 cm in x and 10 cm away (−z), not up', moved.every((d) => near(d[0], 0.03) && near(d[1], 0) && near(d[2], -0.1)), fmt(moved))
s0 = s1
await press('PageUp', 2)
s1 = await items()
ev.check('PageUp ×2 raises both 2 cm', [a, b].every((u) => near(s1[u].position[1] - s0[u].position[1], 0.02)), fmt([a, b].map((u) => s1[u].position[1])))
await press('Shift+PageDown')
s1 = await items()
ev.check('Shift+PageDown lowers them 10 cm, stopping at the floor', [a, b].every((u) => s1[u].position[1] === 0), fmt([a, b].map((u) => s1[u].position[1])))
s0 = s1
await press('r')
s1 = await items()
const mid = (s) => [(s[a].position[0] + s[b].position[0]) / 2, (s[a].position[2] + s[b].position[2]) / 2]
const gap = (s) => Math.hypot(s[a].position[0] - s[b].position[0], s[a].position[2] - s[b].position[2])
const turned = [a, b].map((u) => s1[u].rotation_y_deg - s0[u].rotation_y_deg)
ev.check('R turns the pair 15° as a group: each piece +15°, their middle and spacing unchanged, positions moved',
  turned.every((d) => near(d, 15, 1e-6)) && near(mid(s1)[0], mid(s0)[0], 1e-5) && near(mid(s1)[1], mid(s0)[1], 1e-5) && near(gap(s1), gap(s0), 1e-5) && !near(s1[a].position[0], s0[a].position[0], 1e-3),
  fmt({ turned, mid0: mid(s0), mid1: mid(s1), gap0: gap(s0), gap1: gap(s1) }))
await press('Shift+r')
s0 = await items()
const from = await centreOf(b)
await drag(from, [from[0] + 60, from[1] + 20])
s1 = await items()
const da = [s1[a].position[0] - s0[a].position[0], s1[a].position[2] - s0[a].position[2]], db = [s1[b].position[0] - s0[b].position[0], s1[b].position[2] - s0[b].position[2]]
ev.check('a mouse drag on one selected piece moves both by the same amount (and keeps both selected)',
  Math.hypot(...db) > 0.05 && near(da[0], db[0], 1e-5) && near(da[1], db[1], 1e-5) && (await selection()).length === 2, fmt({ da, db, sel: await selection() }))
s0 = s1
const up0 = await centreOf(a, 0.3)
await drag(up0, [up0[0], up0[1] - 40], { shift: true })
s1 = await items()
const lifts = [a, b].map((u) => s1[u].position[1] - s0[u].position[1])
ev.check('Shift+drag up on a selected piece lifts both by the same height, without moving them on the floor',
  lifts[0] > 0.02 && near(lifts[0], lifts[1], 1e-5) && [a, b].every((u) => near(s1[u].position[0], s0[u].position[0], 1e-6) && near(s1[u].position[2], s0[u].position[2], 1e-6)) && (await selection()).length === 2,
  fmt({ lifts, sel: await selection() }))
await shot(page, 'pair-lifted')
s0 = s1
await press('ControlOrMeta+d')
await page.waitForFunction(() => window.midstudy.getState().items.length === 4, null, { timeout: 15000 }).catch(() => {})
s1 = await items()
sel = await selection()
const copies = sel.map((u) => s1[u]).filter(Boolean)
ev.check('⌘D duplicates the pair 30 cm to the right (same height and turn) and selects the copies',
  Object.keys(s1).length === 4 && sel.length === 2 && !sel.includes(a) && !sel.includes(b)
  && copies.every((c) => [a, b].some((u) => near(c.position[0], s0[u].position[0] + 0.3, 1e-5) && near(c.position[1], s0[u].position[1], 1e-5) && near(c.position[2], s0[u].position[2], 1e-5) && near(c.rotation_y_deg, s0[u].rotation_y_deg, 1e-5))),
  fmt({ n: Object.keys(s1).length, sel, copies: copies.map((c) => c.position) }))
await press('Delete')
s1 = await items()
ev.check('Delete removes both selected copies (one toast)', Object.keys(s1).length === 2 && !!s1[a] && !!s1[b] && (await eng(() => document.querySelectorAll('.toast').length)) >= 1, fmt(Object.keys(s1)))
await press('ControlOrMeta+z')
await page.waitForFunction(() => window.midstudy.getState().items.length === 4, null, { timeout: 15000 }).catch(() => {})
ev.check('⌘Z brings both back, selected together', Object.keys(await items()).length === 4 && fmt((await selection()).sort()) === fmt([...sel].sort()), fmt({ n: Object.keys(await items()).length, sel: await selection() }))

// --- typing --------------------------------------------------------------------------------------------------------------
ev.section('typing in a field')
await hook(page, 'selectItem', [a])
await sleep(150)
s0 = await items()
await press('/')
const focused = await eng(() => ({ tag: document.activeElement?.tagName, inLib: !!document.activeElement?.closest?.('#panel, .panel, [class*="lib"]') }))
ev.check('"/" opens the Library and focuses its search', focused.tag === 'INPUT', fmt(focused))
await page.keyboard.type('rr')
await press('ArrowRight')
await press('Backspace', 2)
s1 = await items()
ev.check('R, → and Backspace typed in the search leave the selected piece alone', Object.keys(s1).length === 4 && near(s1[a].rotation_y_deg, s0[a].rotation_y_deg, 1e-9) && near(s1[a].position[0], s0[a].position[0], 1e-9), fmt({ rot: [s0[a].rotation_y_deg, s1[a].rotation_y_deg], x: [s0[a].position[0], s1[a].position[0]] }))
await press('Escape')
ev.check('Esc in the search leaves the field (the piece stays selected)', (await eng(() => document.activeElement?.tagName)) !== 'INPUT' && (await selection()).includes(a), fmt(await eng(() => document.activeElement?.tagName)))

// --- help -------------------------------------------------------------------------------------------------------------------
ev.section('Shortcuts sheet')
const sheetState = () => eng(() => {
  const el = document.querySelector('[data-midstudy="shortcuts"]')
  return { open: !!el, rows: el ? [...el.querySelectorAll('.ks-row')].map((r) => r.dataset.id) : [], heads: el ? [...el.querySelectorAll('.ks-head')].map((x) => x.textContent) : [] }
})
await press('ControlOrMeta+Shift+Slash')
let sh = await sheetState()
ev.check('⌘? opens the Shortcuts sheet, with every group and every listed command', sh.open && fmt(sh.heads) === fmt(groups) && ids.every((i) => sh.rows.includes(i)), fmt({ heads: sh.heads, missing: ids.filter((i) => !sh.rows.includes(i)) }))
await shot(page, 'shortcuts-sheet')
await press('ControlOrMeta+Shift+Slash')
ev.check('⌘? again closes it', !(await sheetState()).open, fmt(await sheetState()))
await press('Shift+Slash')
ev.check('? opens it too', (await sheetState()).open, fmt(await sheetState()))
await press('r')
ev.check('…and while it is open, R doesn\'t turn the piece', near((await items())[a].rotation_y_deg, s1[a].rotation_y_deg, 1e-9), fmt((await items())[a].rotation_y_deg))
await press('Escape')
ev.check('Esc closes it', !(await sheetState()).open, fmt(await sheetState()))

// --- export -----------------------------------------------------------------------------------------------------------------
ev.section('export (no AI)')
const postsBefore = posts.length
const ex = await eng(async () => {
  const { exporter, engine } = window.midstudyCtx
  const decode = async (blob) => { const bm = await createImageBitmap(blob); const c = new OffscreenCanvas(bm.width, bm.height); const g = c.getContext('2d'); g.drawImage(bm, 0, 0); return { w: bm.width, h: bm.height, d: g.getImageData(0, 0, bm.width, bm.height).data } }
  const diff = (p, q, y0 = 0) => { let s = 0, n = 0; for (let y = 0; y < q.h; y += 3) for (let x = 0; x < q.w; x += 3) { const i = (y * q.w + x) * 4, j = ((y + y0) * p.w + x) * 4; s += Math.abs(p.d[j] - q.d[i]) + Math.abs(p.d[j + 1] - q.d[i + 1]) + Math.abs(p.d[j + 2] - q.d[i + 2]); n += 3 } return s / n }
  const full = await exporter.exportNow({ size: 'full', format: 'jpeg' })
  const cap = engine.captureComposite()
  const capImg = await decode(await (await fetch(cap.dataUrl)).blob())
  const fullImg = await decode(full.blob)
  const m = await exporter.exportNow({ size: 'm', format: 'png' })
  const mImg = await decode(m.blob)
  const pair = await exporter.exportNow({ size: 's', format: 'jpeg', layout: 'pair' })
  const pImg = await decode(pair.blob)
  // the pair's halves against the photo and the scene at 800 px
  const photo = await decode(await (await fetch(engine.getScene().photo_url)).blob())
  const pc = new OffscreenCanvas(pImg.w, pImg.h / 2); const pg = pc.getContext('2d'); pg.drawImage(await createImageBitmap(await (await fetch(engine.getScene().photo_url)).blob()), 0, 0, pc.width, pc.height)
  const photoS = { w: pc.width, h: pc.height, d: pg.getImageData(0, 0, pc.width, pc.height).data }
  const sceneS = await decode((await exporter.exportNow({ size: 's', format: 'png' })).blob)
  // skip the corner tag: compare below it
  const cut = (img, y0) => ({ w: img.w, h: img.h - y0, d: img.d.slice(y0 * img.w * 4) })
  const tagH = 60
  return {
    full: { name: full.name, type: full.blob.type, w: fullImg.w, h: fullImg.h, vsCapture: diff(capImg, fullImg) },
    m: { name: m.name, type: m.blob.type, w: mImg.w, h: mImg.h },
    pair: { name: pair.name, w: pImg.w, h: pImg.h, topVsPhoto: diff(pImg, cut(photoS, tagH), tagH), bottomVsScene: diff(pImg, cut(sceneS, tagH), pImg.h / 2 + tagH), bottomVsPhoto: diff(pImg, cut(photoS, tagH), pImg.h / 2 + tagH) },
    photoW: photo.w,
  }
})
ev.check('Full exports a JPEG at the photo\'s size that matches the render capture (mean |Δ| < 1.5 levels)', ex.full.type === 'image/jpeg' && ex.full.w === W && ex.full.h === H && ex.full.vsCapture < 1.5 && /\.jpg$/.test(ex.full.name), fmt(ex.full))
ev.check('1280 px as PNG: 1280 × 960, image/png, .png', ex.m.type === 'image/png' && ex.m.w === 1280 && ex.m.h === 960 && /-1280x960\.png$/.test(ex.m.name), fmt(ex.m))
ev.check('Before and after (a wide photo): the photo above the scene, 800 × 1200; the top is the photo, the bottom the scene with furniture',
  ex.pair.w === 800 && ex.pair.h === 1200 && ex.pair.topVsPhoto < 3 && ex.pair.bottomVsScene < 3 && ex.pair.bottomVsPhoto > ex.pair.bottomVsScene + 1 && /before-after/.test(ex.pair.name), fmt(ex.pair))
ev.check('exporting sent nothing to the server (no POST, PUT or DELETE)', posts.length === postsBefore, fmt(posts.slice(postsBefore)))

// the sheet: ⌘E, choose 800 px and PNG, Save image → a download
await press('ControlOrMeta+e')
const exSheet = page.locator('.ex-sheet')
ev.check('⌘E opens the Export sheet', await exSheet.isVisible().catch(() => false), '')
await exSheet.locator('[data-midstudy="export-size"] button', { hasText: '800 px' }).click().catch(() => {})
await exSheet.locator('[data-midstudy="export-format"] button', { hasText: 'PNG' }).click().catch(() => {})
await exSheet.locator('[data-midstudy="export-layout"] button', { hasText: /^Scene$/ }).click().catch(() => {})
const info = await exSheet.locator('.ex-info').textContent().catch(() => '')
ev.check('the sheet says what it will save: 800 × 600 PNG', /800 × 600 PNG/.test(info), info)
await shot(page, 'export-sheet')
const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }).catch(() => null), exSheet.locator('[data-midstudy="export-go"]').click()])
let dlInfo = null
if (dl) {
  const p = path.join(ev.out, dl.suggestedFilename())
  await dl.saveAs(p)
  const buf = fs.readFileSync(p)
  dlInfo = { name: dl.suggestedFilename(), png: buf.subarray(1, 4).toString() === 'PNG', w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), bytes: buf.length }
}
ev.check('Save image downloads a PNG of 800 × 600 named after the scene', dlInfo?.png && dlInfo.w === 800 && dlInfo.h === 600 && /^living-room-.*800x600\.png$/.test(dlInfo.name), fmt(dlInfo))
await sleep(300)
ev.check('…the sheet closes, a "Saved …" toast shows, still nothing POSTed', !(await exSheet.isVisible().catch(() => false)) && /Saved/.test(await eng(() => document.querySelector('.toast')?.textContent || '')) && posts.length === postsBefore, fmt(posts.slice(postsBefore)))
ev.check('the choices are remembered on this device', (await eng(() => localStorage.getItem('midstudy.export'))) === JSON.stringify({ size: 's', format: 'png', layout: 'scene' }), await eng(() => localStorage.getItem('midstudy.export')))
const deskErrors = await hook(page, 'getState').then(() => eng(() => window.midstudy.errors.slice()))
ev.check('no planner errors on the desktop', !deskErrors.length && !P.errors.page.length, fmt({ errors: deskErrors, page: P.errors.page }))

// --- phone ------------------------------------------------------------------------------------------------------------------
ev.section('phone: Export')
const Q = await openPlanner(browser, srv.base, { device: 'phone', scene: S.name })
const ph = Q.page
ev.check('the planner opens the scene on the phone', Q.hookOk && (await ensureScene(ph, S.name)).ok, Q.why)
await hook(ph, 'addItem', [PROBE.id, { position: [0, 0, -3.4] }])
await sleep(300)
const tool = ph.locator('[data-midstudy="export"]:visible')
ev.check('the phone\'s tool row has Export', (await tool.count()) === 1, String(await tool.count()))
await tool.tap().catch(() => {})
await sleep(400)
const pSheet = ph.locator('.ex-sheet')
ev.check('tapping it opens the Export sheet', await pSheet.isVisible().catch(() => false), '')
await shot(ph, 'phone-export')
const small = await smallTargets(ph)
ev.check('every target in it is at least 44 px', !small.length, fmt(small))
const hs = await horizontalScroll(ph)
ev.check('no sideways scroll', hs.scrollWidth <= hs.innerWidth && hs.bodyScrollWidth <= hs.innerWidth, fmt(hs))
await ph.keyboard.press('Escape')
await sleep(300)
const pb = (await hook(ph, 'addItem', [PROBE.id, { position: [0.9, 0, -3.8] }])).value
await ph.evaluate(() => window.midstudyCtx.engine.selectAll())
await sleep(500)
const bar = await ph.evaluate(() => {
  const done = [...document.querySelectorAll('.ws-selbar .ws-done')].find((b) => b.checkVisibility())
  const r = done?.getBoundingClientRect()
  return { count: document.querySelector('[data-midstudy="selection-count"]')?.textContent || null, doneRight: r ? Math.round(r.right) : null, vw: innerWidth }
})
ev.check('two pieces selected on the phone: "2 selected" and the whole bar fits (Done on screen)', !!pb && bar.count === '2 selected' && bar.doneRight != null && bar.doneRight <= bar.vw, fmt(bar))
const small2 = await smallTargets(ph)
ev.check('…every target in the group bar is at least 44 px', !small2.length, fmt(small2))
await shot(ph, 'phone-two-selected')
const phErrors = await ph.evaluate(() => window.midstudy.errors.slice())
ev.check('no planner errors on the phone', !phErrors.length && !Q.errors.page.length, fmt({ errors: phErrors, page: Q.errors.page }))

await ev.finish()
