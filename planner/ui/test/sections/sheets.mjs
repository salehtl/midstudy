// planner-ui-sheets' checks (docs/notes/state-machines-plan.md): Export and Settings close their own sheet, never one
// reopened or opened meanwhile; Export runs one at a time; Enter twice saves once; a paste during a read stays in the
// box; Add furniture's failure after closing the sheet still shows, the same source can't be paid for twice, and its
// 'spend' listener goes with the sheet; a Library add's Undo and its phone detent stay in their own scene and panel.
// Waiting states: page.route on the HTTP routes, a wrapped ctx.engine method for the two captures. fal stays mocked.
const TOASTS = () => [...document.querySelectorAll('#toasts .toast:not(.is-leaving)')].map((t) => t.textContent)
const held = () => { let release = () => {}; const gate = new Promise((r) => { release = r }); return { gate, release } }

export async function run({ ev, H, open, phone, seedScene }) {
  const { ensureScene, sleep, waitFor } = H
  const scene = await seedScene('living-wide', 'Sheets check')
  const other = await seedScene('room-1', 'Sheets other')
  ev.check('sheets: two scenes of their own seeded', !!scene && !!other, `${scene} ${other}`)

  const settings = { daily_spend_usd: 10, default_usd: 10, max_usd: 100, locked: false } // the eval server's is locked at $0
  let putGate = null, productGate = null, addGate = null
  const puts = [], adds = []
  const setup = async (c) => {
    await c.route(/\/api\/settings(\?|$)/, async (route) => {
      if (route.request().method() === 'GET') { await route.fulfill({ json: settings }); return }
      puts.push(route.request().postData())
      if (putGate) await putGate
      await route.fulfill({ json: settings })
    })
    await c.route(/\/api\/library\/product(\?|$)/, async (route) => {
      if (productGate) await productGate
      await route.fulfill({ json: { url: 'https://shop.example/p', name: 'Read piece', category: null, is_rug: false, dims_candidates: [], images: [], variants: [], warnings: [], source_layers_used: [], cost_usd: 0, mock: true } })
    })
    await c.route(/\/api\/library\/items\/from-url(\?|$)/, async (route) => {
      adds.push(JSON.parse(route.request().postData() ?? '{}').image_url)
      if (addGate) await addGate
      await route.fulfill({ status: 500, json: { error: 'held and refused' } })
    })
  }
  const P = await open({ scene, setup })
  const page = P.page
  ev.check('sheets: the planner opens the scene', P.hookOk && (await ensureScene(page, scene)).ok, P.why)
  const count = (sel) => page.locator(sel).count()
  const esc = async () => { await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur() }); await page.keyboard.press('Escape'); await sleep(100) }
  const toasts = () => page.evaluate(TOASTS)
  const until = (fn, timeoutMs = 15000) => waitFor(async () => ((await fn()) ? true : null), { timeoutMs }).catch(() => null)

  // --- Export ------------------------------------------------------------------------------------------------------
  const wrap = (name) => page.evaluate((name) => {
    const e = window.midstudyCtx.engine
    const orig = e[name]
    window.__holds ??= {}
    const hold = {}
    hold.promise = new Promise((r) => { hold.release = r })
    window.__holds[name] = hold
    e[name] = async (...a) => { await hold.promise; e[name] = orig; return orig(...a) }
  }, name)
  const release = (name) => page.evaluate((name) => { window.__holds[name].release() }, name)
  const openExport = () => page.evaluate(() => { window.midstudyCtx.exporter.open() })
  const openSettings = () => page.evaluate(() => { window.midstudyCtx.settings.open() })
  const goSel = '.ex-sheet [data-midstudy="export-go"]'

  await openExport()
  await page.waitForSelector(goSel, { timeout: 30000 })
  await wrap('exportImage')
  await page.click(goSel)
  await esc()
  await openExport()
  await page.waitForSelector(goSel, { timeout: 30000 })
  ev.check('export: a sheet reopened during a run has Save disabled', await page.locator(goSel).isDisabled(), await page.locator(goSel).textContent())
  await page.evaluate(() => { document.querySelector('.ex-sheet [data-midstudy="export-go"]').click() })
  await release('exportImage')
  await until(async () => (await toasts()).some((t) => t.includes('Saved')), 60000)
  await sleep(200)
  ev.check('export: the first run saves', (await toasts()).some((t) => t.includes('Saved')), (await toasts()).join(' | '))
  ev.check('export: the reopened sheet stays open after the first run ends', (await count('.ex-sheet')) === 1, `sheets ${await count('.ex-sheet')}`)
  ev.check('export: and its Save comes back', await until(async () => count(`${goSel}:not([disabled])`)), await page.locator(goSel).textContent({ timeout: 1000 }).catch(() => 'gone'))
  await esc()

  await wrap('captureComposite')
  await openExport()
  await sleep(100)
  await openSettings()
  await page.waitForSelector('.st-sheet', { timeout: 15000 })
  await release('captureComposite')
  await sleep(600)
  ev.check('export: a sheet opened during the capture stays, no Export appears', (await count('.st-sheet')) === 1 && (await count('.ex-sheet')) === 0, `settings ${await count('.st-sheet')} export ${await count('.ex-sheet')}`)
  await esc()
  await page.evaluate(() => { for (const c of document.querySelectorAll('.ms-close')) c.click() })

  // --- Settings -----------------------------------------------------------------------------------------------------
  const budget = '[data-midstudy="budget-input"]'
  const hold1 = held()
  putGate = hold1.gate
  await openSettings()
  await page.waitForSelector(budget)
  await page.fill(budget, '25')
  await page.focus(budget)
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await sleep(200)
  ev.check('settings: Enter twice sends one save', puts.length === 1, `PUTs ${puts.length}`)
  ev.check('settings: Save is disabled during the save', await page.locator('[data-midstudy="budget-save"]').isDisabled(), '')
  hold1.release()
  putGate = null
  await until(async () => (await count('.st-sheet')) === 0)
  ev.check('settings: the save closes its sheet', (await count('.st-sheet')) === 0, '')

  const hold2 = held()
  putGate = hold2.gate
  await openSettings()
  await page.waitForSelector(budget)
  await page.fill(budget, '30')
  await page.click('[data-midstudy="budget-save"]')
  await sleep(100)
  await esc()
  await openSettings()
  await page.waitForSelector(budget)
  hold2.release()
  putGate = null
  await until(async () => (await toasts()).some((t) => t.includes('Daily fal budget')))
  await sleep(200)
  ev.check('settings: a save across Esc and reopen leaves the reopened sheet open', (await count('.st-sheet')) === 1, `sheets ${await count('.st-sheet')}`)
  await page.evaluate(() => { for (const c of document.querySelectorAll('.ms-close')) c.click() })

  // --- Product page: a paste while a read runs ---------------------------------------------------------------------
  await page.evaluate(() => { window.midstudyCtx.shell.openPanel('library') })
  const openAdd = async () => { await page.click('[data-midstudy="lib-add"]'); await page.waitForSelector('.ms-add') }
  await openAdd()
  const hold3 = held()
  productGate = hold3.gate
  await page.fill('[data-midstudy="product-url"]', 'https://shop.example/p')
  await page.click('[data-midstudy="product-read"]')
  await until(async () => (await page.locator('[data-midstudy="product-status"]').textContent()).includes('Reading'))
  await page.evaluate(() => { document.querySelector('[data-midstudy="product-paste-open"]').open = true })
  const pageText = `<html>${'x'.repeat(400)}</html>`
  const paste = await page.evaluate((t) => {
    const box = document.querySelector('[data-midstudy="product-paste"]')
    const dt = new DataTransfer()
    dt.setData('text/plain', t)
    const e = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })
    box.dispatchEvent(e)
    box.value = t // what the browser does with a paste left alone
    box.dispatchEvent(new Event('input', { bubbles: true }))
    return { prevented: e.defaultPrevented, value: box.value.length, status: document.querySelector('[data-midstudy="product-status"]').textContent }
  }, pageText)
  ev.check('product: a paste during a read is left to the box', !paste.prevented && paste.value === pageText.length, JSON.stringify(paste))
  ev.check('product: the busy note says to paste again', paste.status.includes('Still reading'), paste.status)
  hold3.release()
  productGate = null
  await until(async () => !/Reading|Still reading/.test(await page.locator('[data-midstudy="product-status"]').textContent()))
  ev.check('product: the placeholder is back after the read', (await page.locator('[data-midstudy="product-paste"]').getAttribute('placeholder')) === 'Paste the copied page here', await page.locator('[data-midstudy="product-paste"]').getAttribute('placeholder'))
  await page.evaluate(() => { for (const c of document.querySelectorAll('.ms-close')) c.click() })

  // --- Add furniture ------------------------------------------------------------------------------------------------
  const closeAdd = () => page.evaluate(() => { document.querySelector('.ms-add .ms-close')?.click() })
  const fillLink = async (link) => {
    await page.click('[data-midstudy="lib-src-link"]')
    await page.fill('.ms-add input[aria-label="Image link"]', link)
    await page.fill('.ms-add input[aria-label="Name"]', 'Held rug')
    await page.click('[data-midstudy="lib-engine"] [data-value="rug"]')
    await page.fill('.ms-add input[aria-label="Width in cm"]', '100')
    await page.fill('.ms-add input[aria-label="Depth in cm"]', '100')
    await page.fill('.ms-add input[aria-label="Height in cm"]', '1')
  }
  const go = '.ms-add .ms-primary'
  await openAdd()
  await fillLink('https://shop.example/a.jpg')
  const hold4 = held()
  addGate = hold4.gate
  await page.click(go)
  await until(() => adds.length === 1)
  await esc()
  hold4.release()
  addGate = null
  await until(async () => (await page.evaluate(() => document.querySelectorAll('#toasts .toast-error').length)) > 0)
  await sleep(200)
  const errs = await page.evaluate(() => [...document.querySelectorAll('#toasts .toast-error:not(.is-leaving)')].map((t) => t.textContent))
  ev.check('add: a failure after the sheet closed shows once, as an error toast', errs.length === 1, errs.join(' | '))

  adds.length = 0
  await openAdd()
  await fillLink('https://shop.example/b.jpg')
  const hold5 = held()
  addGate = hold5.gate
  await page.click(go)
  await until(() => adds.length === 1)
  await esc()
  await openAdd()
  await fillLink('https://shop.example/b.jpg')
  await page.click(go)
  await sleep(300)
  const note = await page.locator('.ms-add .ms-error').textContent()
  ev.check('add: the same source in flight is refused, with the note', adds.length === 1 && note.includes('already being added'), `POSTs ${adds.length}: ${note}`)
  await page.fill('.ms-add input[aria-label="Image link"]', 'https://shop.example/c.jpg')
  await page.click(go)
  await until(() => adds.length === 2)
  ev.check('add: a different piece is not blocked', adds.length === 2, `POSTs ${adds.length}`)
  hold5.release()
  addGate = null
  await until(async () => (await count(`${go}:not([disabled])`)) > 0)
  await closeAdd()

  await page.evaluate(() => {
    const e = window.midstudyCtx.lib.events
    window.__spend = 0
    const add = e.addEventListener.bind(e), rem = e.removeEventListener.bind(e)
    e.addEventListener = (k, f) => { if (k === 'spend') window.__spend++; add(k, f) }
    e.removeEventListener = (k, f) => { if (k === 'spend') window.__spend--; rem(k, f) }
  })
  for (let i = 0; i < 3; i++) { await openAdd(); await closeAdd(); await sleep(50) }
  const left = await page.evaluate(() => window.__spend)
  ev.check('add: opening and closing the sheet leaves no spend listener', left === 0, `net ${left}`)

  // --- Library add: Undo stays with its own pieces --------------------------------------------------------------------
  await page.waitForSelector('.lib-row[data-id="probe-box"]')
  const addedToast = '#toasts .toast:has-text("added") button:has-text("Undo")'
  const items = () => page.evaluate(() => window.midstudyCtx.engine.getItems().length)
  const n0 = await items()
  await page.click('.lib-row[data-id="probe-box"]')
  await until(async () => (await count(addedToast)) > 0, 30000)
  await page.click(addedToast)
  await until(async () => (await items()) === n0)
  ev.check('library: Undo in the same scene removes the piece', (await items()) === n0, `items ${await items()}`)

  await page.click('.lib-row[data-id="probe-box"]')
  await until(async () => (await count(addedToast)) > 0, 30000)
  await page.evaluate(() => {
    const e = window.midstudyCtx.engine
    window.__removed = 0
    const orig = e.removeItemInternal
    e.removeItemInternal = (...a) => { window.__removed++; return orig(...a) }
    window.__undo = [...document.querySelectorAll('#toasts .toast')].find((t) => t.textContent.includes('added'))?.querySelector('.toast-action') ?? [...document.querySelectorAll('#toasts button')].find((b) => b.textContent.includes('Undo'))
  })
  // the toast's time can run out during a whole scene load: Undo is clicked as soon as the other scene starts loading
  const live = await page.evaluate(async (other) => {
    const c = window.midstudyCtx
    const ep = c.shell.epoch.items()
    window.__opened = c.engine.openScene(other).catch(() => {})
    for (let i = 0; i < 400 && c.shell.epoch.items() === ep; i++) await new Promise((r) => { setTimeout(r, 5) })
    const on = c.shell.epoch.items() !== ep && window.__undo?.isConnected === true
    window.__undo?.click()
    return on
  }, other)
  ev.check('library: the Undo toast is up when the other scene starts loading', live, '')
  await page.evaluate(() => window.__opened)
  ev.check('library: the other scene opens', (await ensureScene(page, other)).ok, '')
  const removed = await page.evaluate(() => window.__removed)
  ev.check('library: a stale Undo removes nothing in the new scene', removed === 0, `removals ${removed}, items ${await items()}`)

  // --- phone: another panel keeps its detent --------------------------------------------------------------------------
  let glbGate = null
  const Q = await phone({ scene, setup: async (c) => { await c.route(/model\.glb(\?|$)/, async (route) => { if (glbGate) await glbGate; await route.continue() }) } })
  const p2 = Q.page
  ev.check('library (phone): the planner opens', Q.hookOk && (await ensureScene(p2, scene)).ok, Q.why)
  const openOn = (id) => p2.evaluate((id) => { window.midstudyCtx.shell.openPanel(id) }, id)
  const open2 = () => p2.evaluate(() => window.midstudyCtx.shell.getOpenPanel())
  await openOn('library')
  await p2.waitForSelector('.lib-row[data-id="probe-box"]')
  const n1 = await p2.evaluate(() => window.midstudyCtx.engine.getItems().length)
  const hold6 = held()
  glbGate = hold6.gate
  await p2.evaluate(() => { document.querySelector('.lib-row[data-id="probe-box"]').click() })
  await sleep(200)
  await openOn('layouts')
  await sleep(200)
  const was = await open2()
  hold6.release()
  glbGate = null
  await waitFor(async () => ((await p2.evaluate(() => window.midstudyCtx.engine.getItems().length)) > n1 ? true : null), { timeoutMs: 30000 }).catch(() => null)
  await sleep(300)
  const now = await open2()
  ev.check('library (phone): Place finishing under Layouts leaves its detent', now?.id === 'layouts' && now.detent === was?.detent && now.detent !== 'peek', `${JSON.stringify(was)} → ${JSON.stringify(now)}`)
}
