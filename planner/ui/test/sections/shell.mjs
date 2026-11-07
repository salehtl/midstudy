// planner-ui-shell's checks (docs/notes/state-machines-plan.md): the phone sheet stays closed when an awaited Place
// settles or a drag ends after it closed; a mode change reports the panel it closes; one Esc cancels one layer (page,
// form sheet, confirm) and never reaches the keymap below; a mode change cancels a confirm; addKeyFilter's remover is
// idempotent; a closed toast's action does nothing and onGone fires once; no desktop tooltip shows after a switch to
// the phone.
const PROBE = 'probe-box'

export async function run({ ev, H, open, phone, seedScene }) {
  const { ensureScene, hook, sleep, waitFor } = H
  // a scene of its own: no saved layout whose pieces would load the held GLB at start-up
  const scene = await seedScene('living-wide', 'Shell check')
  ev.check('shell: a scene of its own seeded', !!scene, String(scene))
  const sheetState = (page) => page.evaluate(() => `${document.documentElement.dataset.sheet ?? ''}|${document.getElementById('sheet')?.classList.contains('is-open') ? 'open' : 'closed'}`)
  const items = async (page) => (await hook(page, 'getState')).value?.items?.length ?? -1

  // --- phone: an awaited Place, then a closed sheet --------------------------------------------------------------------
  {
    // the probe's GLB is held from the first load on (the Library's thumbnails load it too): the Place waits on it
    let release = () => {}
    const held = new Promise((r) => { release = r })
    let hits = 0
    const P = await phone({ viewport: { width: 375, height: 812 }, scene, setup: (c) => c.route(/model\.glb/, async (route) => { hits++; await held; await route.continue().catch(() => {}) }) })
    const page = P.page
    ev.check('shell: the phone planner opens the scene', P.hookOk && (await ensureScene(page, scene)).ok, P.why)
    await page.evaluate(() => { window.midstudyCtx.shell.openPanel('library') })
    await page.waitForSelector(`.lib-row[data-id="${PROBE}"]`)
    await page.evaluate((id) => { document.querySelector(`.lib-row[data-id="${id}"]`)?.click() }, PROBE)
    await waitFor(async () => (hits > 0 ? true : null), { timeoutMs: 10000 }).catch(() => null)
    await page.evaluate(() => { window.midstudyCtx.shell.closePanel() })
    const closed = await sheetState(page)
    release()
    await waitFor(async () => ((await items(page)) === 1 ? true : null), { timeoutMs: 15000 }).catch(() => null)
    await sleep(300)
    ev.check('shell (phone): a Place that settles after the sheet closed leaves it closed (data-sheet "", no is-open)', hits > 0 && closed === '|closed' && (await sheetState(page)) === '|closed' && (await items(page)) === 1, `GLB GETs ${hits}; closed ${closed}; after ${await sheetState(page)}; items ${await items(page)}`)

    // a drag that is still down when the sheet closes ends with the sheet closed
    await page.evaluate(() => { window.midstudyCtx.shell.openPanel('library', { detent: 'half' }) })
    await sleep(200)
    const grab = await page.evaluate(() => { const r = document.querySelector('#sheet .sheet-grab')?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null })
    if (grab) {
      await page.mouse.move(grab.x, grab.y)
      await page.mouse.down()
      await page.mouse.move(grab.x, grab.y - 40, { steps: 4 })
      await page.evaluate(() => { window.midstudyCtx.shell.closePanel() })
      await page.mouse.move(grab.x, grab.y - 80, { steps: 4 })
      await page.mouse.up()
      await sleep(200)
    }
    const afterDrag = await page.evaluate(() => `${document.documentElement.dataset.sheet ?? ''}|${document.getElementById('sheet')?.classList.contains('is-dragging') ? 'dragging' : 'still'}`)
    ev.check('shell (phone): a drag that ends after closePanel leaves the sheet closed', !!grab && afterDrag === '|still', `grabber ${grab ? 'found' : 'missing'}; ${afterDrag}`)

    // a public setDetent on a closed sheet does nothing
    await page.evaluate(() => { window.midstudyCtx.shell.setDetent('peek') })
    ev.check('shell (phone): setDetent on a closed sheet does nothing', (await sheetState(page)) === '|closed', await sheetState(page))
    ev.check('shell (phone): no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
  }

  // --- desktop: layers, Esc, mode changes, toasts, tooltips -----------------------------------------------------------
  const P = await open({ scene })
  const page = P.page
  ev.check('shell: the desktop planner opens the scene', P.hookOk && (await ensureScene(page, scene)).ok, P.why)
  const add = await hook(page, 'addItem', [PROBE])
  const uid = (await hook(page, 'getState')).value?.items?.[0]?.uid
  ev.check('shell: a piece placed', !add.error, add.error || JSON.stringify(add.value))
  const select = () => page.evaluate((u) => { window.midstudyCtx.engine.select(u) }, uid)
  const selection = () => page.evaluate(() => window.midstudyCtx.engine.getSelection().length)
  const blur = () => page.evaluate(() => { document.activeElement?.blur?.() })
  // between checks: no form sheet, page or confirm left from a failed one
  const reset = () => page.evaluate(() => {
    for (const b of document.querySelectorAll('#layer .ms .ms-close')) b.click()
    for (const b of document.querySelectorAll('#layer .dialog-actions .btn-secondary')) b.click()
    window.midstudyCtx.shell.closePage()
  })

  // Esc over the Scenes page closes the page and nothing else
  await select()
  await page.evaluate(() => { window.midstudyCtx.shell.openPage('scenes') })
  await page.waitForSelector('[data-midstudy="scene-card"]')
  await blur()
  await page.keyboard.press('Escape')
  await sleep(150)
  ev.check('shell: Esc over the Scenes page closes it and the selection stays', (await page.evaluate(() => window.midstudyCtx.shell.getOpenPage())) === null && (await selection()) === 1,
    `page ${await page.evaluate(() => window.midstudyCtx.shell.getOpenPage())}; selected ${await selection()}`)

  await reset()
  // Rename over the page: Esc in its field closes the sheet only; again with no field focused, the same
  await page.evaluate(() => { window.midstudyCtx.shell.openPage('scenes') })
  await page.waitForSelector('[data-midstudy="scene-card"]')
  await page.click('[data-midstudy="scene-card"] .sc-act:not(.is-danger)')
  await page.waitForSelector('.ms.sc-rename')
  await page.focus('.sc-rename input')
  await page.keyboard.press('Escape')
  await sleep(150)
  const r1 = await page.evaluate(() => `${document.querySelector('.ms.sc-rename') ? 'sheet' : 'no sheet'}|${window.midstudyCtx.shell.getOpenPage()}`)
  ev.check('shell: Esc in the Rename field over the page closes the sheet only', r1 === 'no sheet|scenes', r1)
  await reset()
  await page.evaluate(() => { window.midstudyCtx.shell.openPage('scenes') })
  await page.waitForSelector('[data-midstudy="scene-card"]')
  await page.click('[data-midstudy="scene-card"] .sc-act:not(.is-danger)')
  await page.waitForSelector('.ms.sc-rename')
  await blur()
  await page.keyboard.press('Escape')
  await sleep(150)
  const r2 = await page.evaluate(() => `${document.querySelector('.ms.sc-rename') ? 'sheet' : 'no sheet'}|${window.midstudyCtx.shell.getOpenPage()}`)
  ev.check('shell: Esc (no field) with Rename over the page closes the sheet only', r2 === 'no sheet|scenes', r2)
  await page.evaluate(() => { window.midstudyCtx.shell.closePage() })

  await reset()
  // a confirm over a form sheet: Esc cancels the confirm, the sheet stays
  await page.evaluate(() => {
    window.midstudyCtx.shortcuts.open()
    window.__smConfirm = window.midstudyCtx.shell.confirm({ title: 'Check', body: 'A confirm over a sheet' })
  })
  await page.waitForSelector('.dialog')
  await page.keyboard.press('Escape')
  await sleep(150)
  const c1 = await page.evaluate(async () => `${String(await window.__smConfirm)}|${document.querySelector('.dialog') ? 'dialog' : 'no dialog'}|${window.midstudyCtx.shortcuts.isOpen() ? 'sheet' : 'no sheet'}`)
  ev.check('shell: Esc over a confirm on a sheet cancels the confirm (false) and the sheet stays', c1 === 'false|no dialog|sheet', c1)
  // the Shortcuts sheet's own key still closes it (the key filters run before the any-layer swallow)
  await blur()
  const helpKey = await page.evaluate(() => window.midstudyCtx.keys.lookup('help.shortcuts'))
  await page.keyboard.press('Shift+Slash')
  await sleep(150)
  const shortcutsOpen = await page.evaluate(() => window.midstudyCtx.shortcuts.isOpen())
  if (shortcutsOpen) await page.evaluate(() => { window.midstudyCtx.shortcuts.close() })
  ev.check('shell: the Shortcuts key closes its own sheet while it is a layer', !shortcutsOpen, `key ${helpKey}; open ${shortcutsOpen}`)

  await reset()
  // Adjust floor and a confirm: Esc cancels the confirm, Adjust floor stays on
  await page.evaluate(() => { window.midstudyCtx.workspace.setAdjust(true) })
  await sleep(150)
  const adj0 = await page.evaluate(() => window.midstudyCtx.engine.getAdjustFloor())
  await page.evaluate(() => { window.__smConfirm = window.midstudyCtx.shell.confirm({ title: 'Check', body: 'A confirm over Adjust floor' }) })
  await page.waitForSelector('.dialog')
  await page.keyboard.press('Escape')
  await sleep(150)
  const adj1 = await page.evaluate(async () => `${String(await window.__smConfirm)}|${String(window.midstudyCtx.engine.getAdjustFloor())}`)
  ev.check('shell: Esc over a confirm leaves Adjust floor on', adj0 === true && adj1 === 'false|true', `before ${adj0}; after ${adj1}`)
  await page.evaluate(() => { window.midstudyCtx.workspace.setAdjust(false) })

  await reset()
  // a selection and a menu: Esc closes the menu, the selection stays
  await select()
  await page.evaluate(() => { window.midstudyCtx.shell.menu(null, [{ label: 'One', onSelect: () => {} }]) })
  await page.waitForSelector('.menu')
  await page.keyboard.press('Escape')
  await sleep(150)
  ev.check('shell: Esc over a menu closes it and the selection stays', (await page.locator('.menu').count()) === 0 && (await selection()) === 1, `menus ${await page.locator('.menu').count()}; selected ${await selection()}`)

  // shell.topLayer() and pushLayer's idempotent remove()
  const tl = await page.evaluate(() => {
    const s = window.midstudyCtx.shell
    const a = s.topLayer()
    const l = s.pushLayer('modal', () => {})
    const b = s.topLayer()
    l.remove(); l.remove()
    return `${a}|${b}|${s.topLayer()}`
  }).catch((e) => String(e).split("\n")[0])
  ev.check('shell: topLayer() names the innermost layer; remove() twice is safe', tl === 'null|modal|null', tl)

  // addKeyFilter's remover, called twice, removes only its own filter
  const kf = await page.evaluate(async () => {
    const s = window.midstudyCtx.shell
    let a = 0, b = 0
    const offA = s.addKeyFilter((e) => { if (e.key === 'F8') a++; return false })
    const offB = s.addKeyFilter((e) => { if (e.key === 'F8') b++; return false })
    offA(); offA()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F8', bubbles: true }))
    offB()
    return `${a}|${b}`
  })
  ev.check('shell: addKeyFilter remover twice leaves the other filter', kf === '0|1', kf)

  await reset()
  // a mode change cancels an open confirm (its cancel value) and menus
  await page.evaluate(() => { window.__smConfirm = window.midstudyCtx.shell.confirm({ title: 'Check', body: 'A confirm across a mode change' }) })
  await page.waitForSelector('.dialog')
  const panelEvents = await page.evaluate(() => {
    window.__smPanel = []
    window.midstudyCtx.shell.openPanel('scene')
    window.midstudyCtx.shell.events.addEventListener('panel', (e) => { window.__smPanel.push(e.detail) })
    return window.midstudyCtx.shell.getOpenPanel()?.id ?? null
  })
  await page.setViewportSize({ width: 375, height: 812 })
  await page.waitForFunction(() => window.midstudyCtx.shell.mode === 'phone', null, { timeout: 5000 }).catch(() => {})
  await sleep(200)
  const mc = await page.evaluate(async () => {
    const r = await Promise.race([window.__smConfirm, new Promise((res) => setTimeout(() => res('still open'), 500))])
    return `${String(r)}|${document.querySelector('.dialog, .actionsheet') ? 'shown' : 'gone'}`
  })
  ev.check('shell: a mode change cancels an open confirm (false) and removes it', mc === 'false|gone', mc)
  const ev1 = await page.evaluate(() => JSON.stringify(window.__smPanel))
  ev.check('shell: 1440 → 375 with the Scene panel open sends a \'panel\' event, open: false', panelEvents === 'scene' && (await page.evaluate(() => window.__smPanel.some((d) => d.id === 'scene' && d.open === false))), `open before: ${panelEvents}; events ${ev1}`)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForFunction(() => window.midstudyCtx.shell.mode === 'desktop', null, { timeout: 5000 }).catch(() => {})
  await sleep(200)
  const ev2 = await page.evaluate(() => JSON.stringify(window.__smPanel))
  ev.check('shell: 375 → 1440 sends a \'panel\' event, open: true, for the side panel it shows', await page.evaluate(() => window.__smPanel.some((d) => d.open === true) && window.midstudyCtx.shell.getOpenPanel() !== null), ev2)

  await reset()
  // toasts: a closed toast's action does nothing; onGone once on a same-key replacement
  const t1 = await page.evaluate(async () => {
    const s = window.midstudyCtx.shell
    let ran = 0
    const t = s.toast('Toast check', { action: { label: 'Do it', onClick: () => { ran++ } } })
    t.close()
    t.el.querySelector('.toast-action')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    t.el.querySelector('.toast-action')?.click()
    const pe = getComputedStyle(t.el).pointerEvents
    await new Promise((r) => setTimeout(r, 50))
    return `${ran}|${pe}`
  })
  ev.check('shell: a closed toast\'s action runs 0 times and the leaving toast takes no pointer', t1 === '0|none', t1)
  const t2 = await page.evaluate(() => {
    const s = window.midstudyCtx.shell
    let gone = 0
    const a = s.toast('First', { id: 'sm-toast', onGone: () => { gone++ } })
    const before = gone
    const b = s.toast('Second', { id: 'sm-toast' })
    a.close(); a.update('changed')
    const text = a.el.querySelector('.toast-text')?.textContent
    b.close()
    return `${before}|${gone}|${text}`
  })
  ev.check('shell: a same-key replacement calls the first toast\'s onGone once; its handle is then inert', t2 === '0|1|First', t2)

  await reset()
  // tooltip: hover a [data-tip], switch to the phone before it shows, no tooltip after
  // (a button of the test's own, fixed in the corner, so it stays shown and hovered in both modes: the chrome's own
  // [data-tip] buttons hide on the phone, which would hide the race)
  await blur()
  await page.evaluate(() => {
    const b = document.createElement('button')
    b.id = 'sm-tip'
    b.dataset.tip = 'Tip check'
    b.textContent = 'tip'
    Object.assign(b.style, { position: 'fixed', left: '120px', top: '120px', width: '80px', height: '40px', zIndex: '99999' })
    document.body.append(b)
  })
  await page.hover('#sm-tip')
  await sleep(100)
  await page.setViewportSize({ width: 375, height: 812 })
  await sleep(600)
  const tips = await page.locator('#layer .tooltip').count()
  const hovered = await page.evaluate(() => document.getElementById('sm-tip')?.matches(':hover') ?? false)
  ev.check('shell: a tooltip hovered before a switch to the phone never shows', tips === 0, `still hovered ${hovered}; tooltips ${tips}`)
  await page.evaluate(() => { document.getElementById('sm-tip')?.remove() })
  await page.setViewportSize({ width: 1440, height: 900 })

  ev.check('shell: no page errors (desktop)', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
}
