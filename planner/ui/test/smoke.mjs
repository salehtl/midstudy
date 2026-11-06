// A smoke test of the UI's flows the evals do not drive (written with the TypeScript port, ui track): Library remove /
// Undo / Recently removed / Edit (the size fields as properties), Layouts save / Save as new / the name check / Load with
// changes, Del + Ctrl+Z, the Scene panel's camera card, Look and toggles, Renders' Compare with fewer than two, Scenes
// rename, card flags and meta; and resize events while the page starts, before the kernels have loaded. Each expected text
// is v1's. Through the evals' harness (legacy server, fal mocked, $0).
// Usage (repo root): nix develop -c node scripts/eval-lock.mjs -- npm run eval:ui-smoke   (output: evals/out/ui-smoke/)
import { createEval, startServer, launchBrowser, openPlanner, hook, seedScene, ensureScene, sleep, waitFor } from '../../../evals/lib/harness.mjs'

const ev = createEval('UI', 'ui-smoke', { timeoutS: 600 })
const srv = await startServer(ev)
ev.check('server up', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const S = await seedScene(srv, 'living-wide', 'Living room')
ev.check('scene seeded', S.name && !S.why, S.why || S.name)
const browser = await launchBrowser(ev)
const P = await openPlanner(browser, srv.base, { scene: S.name, viewport: { width: 1440, height: 900 } })
const page = P.page
ev.check('planner opens the scene', P.hookOk && (await ensureScene(page, S.name)).ok, P.why)

const toasts = () => page.evaluate(() => [...document.querySelectorAll('#toasts .toast:not(.is-leaving) .toast-text')].map((t) => t.textContent))
const hasToast = async (text) => (await waitFor(async () => ((await toasts()).includes(text) ? true : null), { timeoutMs: 8000 }).catch(() => null)) === true
const openPanel = (id) => page.evaluate((id) => window.midstudyCtx.shell.openPanel(id), id)

// --- Library: remove, Undo, Recently removed, Edit ------------------------------------------------------------------------
await openPanel('library')
await page.waitForSelector('.lib-row[data-id="probe-box"]')
ev.check('the Library lists the probe with its size', await page.evaluate(() => document.querySelector('.lib-row[data-id="probe-box"] .lib-dims')?.textContent), '')
const more = page.locator('.lib-item:has(.lib-row[data-id="probe-box"]) .lib-more')
await more.click()
ev.check('the "…" menu offers Place, Edit…, Remove from library', (await page.locator('.menu .menu-item .label').allTextContents()).join(' | ') === 'Place in the scene | Edit… | Remove from library', (await page.locator('.menu .menu-item .label').allTextContents()).join(' | '))
await page.click('[data-midstudy="lib-remove"]')
ev.check('Remove: "Probe box removed from the library" with Undo (lib-undo)', await hasToast('Probe box removed from the library') && await page.locator('#toasts [data-midstudy="lib-undo"]').count() === 1, (await toasts()).join(' | '))
await page.click('#toasts [data-midstudy="lib-undo"]')
ev.check('Undo: "Probe box is back in the library"', await hasToast('Probe box is back in the library'), (await toasts()).join(' | '))
await page.waitForSelector('.lib-row[data-id="probe-box"]')
await page.locator('.lib-item:has(.lib-row[data-id="probe-box"]) .lib-more').click()
await page.click('[data-midstudy="lib-remove"]')
await page.waitForSelector('.lib-trash-head')
ev.check('Recently removed · 1', (await page.locator('.lib-trash-head .caps').textContent()) === 'Recently removed · 1', await page.locator('.lib-trash-head .caps').textContent())
await page.click('.lib-trash-head')
await page.click('.lib-trash-row button')
ev.check('Restore from Recently removed', await hasToast('Probe box is back in the library'), (await toasts()).join(' | '))
await page.waitForSelector('.lib-row[data-id="probe-box"]')
await page.locator('.lib-item:has(.lib-row[data-id="probe-box"]) .lib-more').click()
await page.click('.menu .menu-item:has-text("Edit…")')
await page.waitForSelector('.ms.ms-edit')
ev.check('Edit sheet: title, sub and Save disabled until a change', await page.evaluate(() => [document.querySelector('.ms-edit .ms-title')?.textContent, document.querySelector('.ms-edit .ms-sub')?.textContent, document.querySelector('.ms-edit .ms-primary')?.disabled, document.querySelector('.ms-edit .ms-primary')?.textContent].join('|')) === 'Edit Probe box|probe-box|true|Save',
  await page.evaluate(() => [document.querySelector('.ms-edit .ms-title')?.textContent, document.querySelector('.ms-edit .ms-sub')?.textContent, document.querySelector('.ms-edit .ms-primary')?.disabled, document.querySelector('.ms-edit .ms-primary')?.textContent].join('|')))
const dimVals = await page.evaluate(() => [...document.querySelectorAll('.ms-edit .ms-dims input')].map((i) => `${i.value}/${i.getAttribute('value')}`).join(' '))
ev.check('Edit sheet: the size fields hold 80 / 50 / 120 as properties (no value attribute, as v1)', dimVals === '80/null 50/null 120/null', dimVals)
await page.fill('.ms-edit input[aria-label="Name"]', 'Probe box 2')
ev.check('a new name enables Save', await page.evaluate(() => document.querySelector('.ms-edit .ms-primary')?.disabled === false), '')
await page.fill('.ms-edit input[aria-label="Width in cm"]', '81')
ev.check('a new size says it refits', await page.evaluate(() => document.querySelector('.ms-edit .ms-primary')?.textContent) === 'Save and refit · free', await page.evaluate(() => document.querySelector('.ms-edit .ms-primary')?.textContent))
await page.fill('.ms-edit input[aria-label="Width in cm"]', '80')
await page.click('.ms-edit .ms-primary')
ev.check('Save: "Probe box 2 saved"', await hasToast('Probe box 2 saved'), (await toasts()).join(' | '))
await waitFor(async () => ((await page.locator('.lib-row[data-id="probe-box"] .lib-name').textContent()) === 'Probe box 2' ? true : null), { timeoutMs: 8000 }).catch(() => null)
ev.check('the row shows the new name', (await page.locator('.lib-row[data-id="probe-box"] .lib-name').textContent()) === 'Probe box 2', await page.locator('.lib-row[data-id="probe-box"] .lib-name').textContent())

// --- Layouts -------------------------------------------------------------------------------------------------------------------
const add = await hook(page, 'addItem', ['probe-box'])
ev.check('a piece placed', !add.error, add.error || add.value)
await openPanel('layouts')
await page.click('.ly-card .btn-primary')
await page.fill('.ly-form input', 'Evening A')
ev.check('the name check is quiet for a new name', (await page.locator('.ly-form-msg').textContent()) === '', await page.locator('.ly-form-msg').textContent())
await page.press('.ly-form input', 'Enter')
ev.check('Save as new: "Layout saved as Evening A"', await hasToast('Layout saved as Evening A'), (await toasts()).join(' | '))
await waitFor(async () => ((await page.locator('.ly-card-meta span').last().textContent()) === '1 item · saved' ? true : null), { timeoutMs: 8000 }).catch(() => null)
ev.check('the card says "1 item · saved"', (await page.locator('.ly-card-meta span').last().textContent()) === '1 item · saved', await page.locator('.ly-card-meta span').last().textContent())
await page.click('.ly-card .btn-secondary')
await page.fill('.ly-form input', 'Evening A')
ev.check('the name check refuses a taken name', (await page.locator('.ly-form-msg').textContent()) === 'Evening A already exists. Pick another name, or use its … menu to save over it.', await page.locator('.ly-form-msg').textContent())
await page.fill('.ly-form input', 'Evening B')
await page.press('.ly-form input', 'Enter')
ev.check('Save as new: "Layout saved as Evening B"', await hasToast('Layout saved as Evening B'), (await toasts()).join(' | '))
const st = await hook(page, 'getState')
const uid = st.value?.items?.[0]?.uid
await hook(page, 'moveItem', [uid, { position: [0.3, 0, -2.5] }])
await waitFor(async () => ((await page.locator('.ly-card-meta span').last().textContent()) === '1 item · changed since saved' ? true : null), { timeoutMs: 8000 }).catch(() => null)
ev.check('a move: "1 item · changed since saved"', (await page.locator('.ly-card-meta span').last().textContent()) === '1 item · changed since saved', await page.locator('.ly-card-meta span').last().textContent())
await page.click('.ly-row:has-text("Evening A") .ly-load')
await page.waitForSelector('.dialog')
const dlg = await page.evaluate(() => [document.querySelector('.dialog-title')?.textContent, document.querySelector('.dialog-body')?.textContent, [...document.querySelectorAll('.dialog-actions button')].map((b) => b.textContent).join('/')].join(' | '))
ev.check('Load with changes asks (desktop: Cancel / Load, don\'t save / Save, then load)', dlg === "Load Evening A? | The furniture has changes that aren't saved to Evening B. Loading replaces it. | Cancel/Load, don't save/Save, then load", dlg)
await page.click(".dialog-actions button:has-text(\"Load, don't save\")")
ev.check('"Loaded Evening A"', await hasToast('Loaded Evening A'), (await toasts()).join(' | '))

// --- keys: Del, then Ctrl+Z ---------------------------------------------------------------------------------------------------
const st2 = await hook(page, 'getState')
const uid2 = st2.value?.items?.[0]?.uid
await hook(page, 'selectItem', [uid2])
await page.locator('#view canvas').hover().catch(() => {})
await page.evaluate(() => { document.activeElement?.blur?.() })
await page.keyboard.press('Delete')
const removed = await hasToast('Probe box 2 removed')
const kbdText = await page.evaluate(() => document.querySelector('#toasts .toast-action .kbd')?.textContent)
ev.check('Del removes the piece: "Probe box 2 removed", Undo with its key', removed && (kbdText === 'Ctrl Z' || kbdText === '⌘Z'), `${(await toasts()).join(' | ')} / ${kbdText}`)
await page.keyboard.press('Control+z')
await sleep(500)
const st3 = await hook(page, 'getState')
ev.check('Ctrl+Z puts it back', st3.value?.items?.length === 1, st3.value?.items?.length)

// --- Scene panel ------------------------------------------------------------------------------------------------------------------
await openPanel('scene')
const cam = await page.evaluate(() => [document.querySelector('.sp-src')?.textContent, document.querySelector('.sp-from')?.textContent, [...document.querySelectorAll('.sp-cell')].map((c) => c.textContent).join(',')].join(' | '))
ev.check('the camera card (source, from, cells)', /^(Automatic|Manual|Default) \| .+ \| Height\d+ cm,Field of view[−\d.]+°,Tilt[−\d.]+°,Roll[−\d.]+°$/.test(cam), cam)
const before = (await hook(page, 'getLighting')).value?.light_strength
await page.evaluate(() => { const i = document.querySelector('[data-midstudy="light-strength"]'); i.value = '1.5'; i.dispatchEvent(new Event('input', { bubbles: true })) })
await sleep(300)
const after = (await hook(page, 'getLighting')).value?.light_strength
ev.check('Strength 1.5 reaches the engine and its readout', after === 1.5 && (await page.evaluate(() => document.querySelector('[data-midstudy="light-strength"]').closest('.slider-row').querySelector('.slider-value').textContent)) === '1.50×', `${before} → ${after}`)
await page.click('[data-midstudy="light-reset"]')
await sleep(300)
ev.check('Reset brings strength back to 1', (await hook(page, 'getLighting')).value?.light_strength === 1, '')
const grid0 = await page.evaluate(() => window.midstudyCtx.engine.getGridVisible())
await page.click('.sp-toggles .toggle-row:has-text("Floor grid")')
ev.check('the Floor grid toggle', (await page.evaluate(() => window.midstudyCtx.engine.getGridVisible())) === !grid0, '')

// --- Renders: Compare needs two ----------------------------------------------------------------------------------------------------
await openPanel('renders')
await page.click('[data-midstudy="compare"]')
ev.check('Compare with fewer than two renders', await hasToast('Make two renders first, then compare them.'), (await toasts()).join(' | '))

// --- Scenes: rename ----------------------------------------------------------------------------------------------------------------------
await page.evaluate(() => window.midstudyCtx.shell.openPage('scenes'))
await page.waitForSelector('[data-midstudy="scene-card"]')
await page.click('[data-midstudy="scene-card"] .sc-act:not(.is-danger)')
await page.waitForSelector('.ms.sc-rename')
ev.check('Rename sheet: the title field holds the title', (await page.inputValue('.sc-rename input')) === 'Living room', await page.inputValue('.sc-rename input'))
await page.fill('.sc-rename input', 'Den')
await page.press('.sc-rename input', 'Enter')
await waitFor(async () => ((await page.locator('[data-midstudy="scene-card"] .sc-title').first().textContent()) === 'Den' ? true : null), { timeoutMs: 8000 }).catch(() => null)
ev.check('the card shows the new title', (await page.locator('[data-midstudy="scene-card"] .sc-title').first().textContent()) === 'Den', await page.locator('[data-midstudy="scene-card"] .sc-title').first().textContent())
const flags = await page.evaluate(() => [...document.querySelectorAll('[data-midstudy="scene-card"] .sc-flag')].map((f) => `${f.className}:${f.textContent}`).join(','))
ev.check('the open scene is flagged "Open now"', flags.includes('sc-flag is-open:Open now'), flags)
const meta = await page.locator('[data-midstudy="scene-card"] .sc-meta').first().textContent()
ev.check('the card meta: date (titled), size, layouts', /^Today, \d\d:\d\d · \d+ × \d+ · 2 layouts$/.test(meta), meta)
await page.keyboard.press('Escape')

ev.check('no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
ev.check('no console errors', P.errors.console.length === 0, P.errors.console.join(' | ') || 'none')

// --- Start-up: resize events before the kernels have loaded (int-planner) --------------------------------------------------------
// The engine's 'view' report rounds with the kernels; a resize while the page starts must not throw (it did once, on a phone
// eval). Resize events every millisecond from the first script on, desktop and phone, 3 loads each.
for (const device of ['desktop', 'phone']) {
  const errs = []
  let ready = 0
  for (let i = 0; i < 3; i++) {
    const ctx = await browser.newContext(device === 'phone' ? { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 3 } : { viewport: { width: 1440, height: 900 } })
    await ctx.addInitScript(() => {
      const t0 = performance.now()
      const tick = () => { window.dispatchEvent(new Event('resize')); if (performance.now() - t0 < 6000) setTimeout(tick, 1) }
      tick()
    })
    const pg = await ctx.newPage()
    pg.on('pageerror', (e) => errs.push(String(e.stack || e).split('\n').slice(0, 3).join(' / ')))
    await pg.goto(`${srv.base}/planner/?scene=${S.name}`, { waitUntil: 'load', timeout: 60000 }).catch((e) => errs.push(`goto: ${e}`))
    if (await pg.waitForFunction(() => window.midstudy?.ready, null, { timeout: 60000 }).then(() => pg.evaluate(() => window.midstudy.ready.then(() => true)), () => false)) ready++
    await ctx.close()
  }
  ev.check(`start-up (${device}): resize events before the kernels load, 3 loads reach midstudy.ready with no page error`, ready === 3 && errs.length === 0, errs.slice(0, 2).join(' | ') || `${ready}/3 ready`)
}
await ev.finish()
