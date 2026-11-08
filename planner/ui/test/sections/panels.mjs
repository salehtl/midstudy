// planner-ui-panels' checks (docs/notes/state-machines-plan.md). Layouts: "Save as new first" ends in the load the user
// asked for, Cancel forgets it, a Load during a save waits for it, and a save that settles after the scene changed says
// nothing in the new scene. Scene panel: Calibrating… belongs to the scene that asked (its own server, on
// evals/lib/gated_calib.py, holds the job). Sun dial: the first pointer keeps the drag. Layout PUTs are held with page.route.
import fs from 'node:fs'
import path from 'node:path'

const PROBE = 'probe-box'
const TOASTS = () => [...document.querySelectorAll('#toasts .toast:not(.is-leaving) .toast-text')].map((t) => t.textContent)

export async function run({ ev, H, browser, open, seedScene }) {
  const { ensureScene, hook, openPlanner, sleep, startServer, waitFor, REPO } = H

  // --- Layouts ---------------------------------------------------------------------------------------------------------
  {
    const scenes = []
    for (const t of ['Panels A', 'Panels B', 'Panels C', 'Panels D', 'Panels E']) scenes.push(await seedScene('living-wide', t))
    ev.check('layouts: scenes of their own seeded', scenes.every(Boolean), scenes.join(' '))
    const [a, b, c, d, e] = scenes
    let gate = null
    let answer = (route) => route.continue().catch(() => {})
    let seen = 0
    const P = await open({ scene: a, setup: (context) => context.route(/\/api\/layouts\/[^/?]+(\?|$)/, async (route) => {
      if (route.request().method() !== 'PUT' || route.request().headers()['x-panels-seed']) { await route.continue(); return }
      seen++
      if (gate) await gate
      await answer(route)
    }) })
    const page = P.page
    ev.check('layouts: the planner opens the scene', P.hookOk && (await ensureScene(page, a)).ok, P.why)
    await page.evaluate(() => { window.midstudyCtx.shell.openPanel('layouts') })
    const name = () => page.evaluate(() => window.midstudyCtx.engine.getLayoutName())
    const hold = () => { let release = () => {}; gate = new Promise((r) => { release = r }); return () => { gate = null; release() } }
    const until = (fn) => waitFor(async () => ((await fn()) ? true : null), { timeoutMs: 10000 }).catch(() => null)
    // A saved layout `slug`, with the scene's furniture unsaved and (unless saved over) no current layout.
    const prepare = async (scene, slug) => {
      await ensureScene(page, scene)
      await page.evaluate(async ([s, l]) => {
        await fetch(`/api/layouts/${l}?scene=${s}`, { method: 'PUT', headers: { 'content-type': 'application/json', 'X-Midstudy': '1', 'x-panels-seed': '1' }, body: '{"items":[]}' })
        await window.midstudyCtx.engine.listLayoutsInternal()
      }, [scene, slug])
      await hook(page, 'addItem', [PROBE])
      await page.waitForSelector(`.ly-row[title="${slug}"] .ly-load`)
    }
    const clickLoad = (slug) => page.click(`.ly-row[title="${slug}"] .ly-load`)
    const choose = (label) => page.getByRole('button', { name: label, exact: true }).click()
    const fillForm = async (text) => { await page.waitForSelector('.ly-form input'); await page.fill('.ly-form input', text) }
    const submit = () => page.click('.ly-form button[type=submit]')

    // Load, Save as new first, save the form: the load the user asked for happens
    await prepare(a, 'x')
    await clickLoad('x')
    await choose('Save as new first')
    await fillForm('Before x')
    await submit()
    await until(async () => (await name()) === 'x')
    ev.check('layouts: Save as new first, then the form, ends in the load', (await name()) === 'x', await name())

    // the same, and Cancel: the load is forgotten, a later save stays where it is
    await prepare(b, 'y')
    await clickLoad('y')
    await choose('Save as new first')
    await fillForm('Dropped')
    await page.locator('.ly-form').getByRole('button', { name: 'Cancel', exact: true }).click()
    await page.locator('.ly-card').getByRole('button', { name: 'Save layout…', exact: true }).click()
    await fillForm('Kept here')
    await submit()
    await until(async () => (await name()) === 'kept-here')
    await sleep(500)
    ev.check('layouts: Cancel forgets the load', (await name()) === 'kept-here', await name())

    // Load during a save: it waits, and happens
    await prepare(c, 'z')
    await page.evaluate(() => window.midstudyCtx.engine.saveLayoutInternal('cur'))
    await hook(page, 'addItem', [PROBE])
    const release = hold()
    const n0 = seen
    await page.locator('.ly-card').getByRole('button', { name: 'Save layout', exact: true }).click()
    await until(() => seen > n0)
    await clickLoad('z')
    await choose('Save, then load')
    await sleep(300)
    release()
    await until(async () => (await name()) === 'z')
    ev.check('layouts: a Load during a save waits for it and loads', (await name()) === 'z', await name())

    // a save that answers after the scene changed: no toast, no failure row
    const leave = async (scene, to) => {
      await prepare(scene, 'w')
      await page.locator('.ly-card').getByRole('button', { name: 'Save layout…', exact: true }).click()
      await fillForm('Across')
      const rel = hold()
      const n = seen
      await submit()
      await until(() => seen > n)
      await ensureScene(page, to)
      rel()
      await sleep(800)
    }
    await page.evaluate(() => { document.querySelector('#toasts')?.replaceChildren() })
    await leave(d, e)
    let t = await page.evaluate(TOASTS)
    ev.check('layouts: a save across a scene change does not toast in the new scene', !t.some((x) => x.includes('Layout saved as')), t.join(' | ') || 'none')
    ev.check('layouts: and sets no failure there', (await page.locator('.ly-card .p-fail').count()) === 0, String(await page.locator('.ly-card .p-fail').count()))

    answer = (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"held"}' })
    await leave(e, a)
    t = await page.evaluate(TOASTS)
    ev.check('layouts: a save failing across a scene change sets no Retry there', (await page.locator('.ly-card .p-fail').count()) === 0, t.join(' | ') || 'none')
    ev.check('layouts: no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
    await page.context().close()
  }

  // --- Sun dial: the first pointer keeps the drag ------------------------------------------------------------------------
  {
    const scene = await seedScene('living-wide', 'Panels dial')
    const P = await open({ scene })
    const page = P.page
    await ensureScene(page, scene)
    await page.evaluate(() => { window.midstudyCtx.shell.openPanel('scene') })
    await page.waitForSelector('[data-midstudy="light-dir"]')
    const moved = await page.evaluate(() => {
      const dial = document.querySelector('[data-midstudy="light-dir"]')
      const b = dial.getBoundingClientRect()
      const at = (fx, fy) => ({ clientX: b.left + b.width * fx, clientY: b.top + b.height * fy })
      const fire = (type, pointerId, pointerType, xy) => dial.dispatchEvent(new PointerEvent(type, { pointerId, pointerType, button: 0, bubbles: true, cancelable: true, ...xy }))
      const az = () => dial.getAttribute('aria-valuenow')
      fire('pointerdown', 11, 'mouse', at(0.8, 0.5))
      const first = az()
      fire('pointerdown', 12, 'pen', at(0.2, 0.5))
      fire('pointermove', 12, 'pen', at(0.5, 0.2))
      const afterPen = az()
      fire('pointerdown', 13, 'touch', at(0.2, 0.2))
      fire('pointerup', 13, 'touch', at(0.2, 0.2))
      const afterTouch = az()
      fire('pointermove', 11, 'mouse', at(0.5, 0.8))
      const followed = az()
      fire('pointerup', 11, 'mouse', at(0.5, 0.8))
      return { first, afterPen, afterTouch, followed }
    })
    ev.check('dial: a second pointer does not take the drag', moved.afterPen === moved.first, JSON.stringify(moved))
    ev.check('dial: a touch during a drag changes nothing', moved.afterTouch === moved.first, JSON.stringify(moved))
    ev.check('dial: the first pointer still drives it', moved.followed !== moved.first, JSON.stringify(moved))
    await page.context().close()
  }

  // --- Scene panel: Calibrating… is per scene ----------------------------------------------------------------------------
  {
    const gateFile = path.join(ev.out, 'panels-calib-gate')
    fs.writeFileSync(gateFile, 'open') // open while the scenes are seeded
    const srv = await startServer(ev, { calib: `python3 ${path.join(REPO, 'evals/lib/gated_calib.py')}`, env: { MIDSTUDY_EVAL_CALIB_GATE: gateFile, MIDSTUDY_EVAL_CALIB_TARGET: `python3 ${path.join(REPO, 'fixtures/stub_calib.py')}` } })
    ev.check('scene panel: the gated server is up', srv.up, srv.up ? srv.base : srv.why)
    const a = (await H.seedScene(srv, 'living-wide', 'Calib A')).name
    const b = (await H.seedScene(srv, 'room-1', 'Calib B')).name
    ev.check('scene panel: two scenes seeded', !!a && !!b, `${a} ${b}`)
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
    ev.onCleanup(() => context.close().catch(() => {}))
    let held = null // a promise: while set, POST …/calibrate waits on it
    await context.route(/\/calibrate$/, async (route) => { if (held) await held; await route.continue() })
    const P = await openPlanner({ newContext: async () => context }, srv.base, { device: 'desktop', scene: a })
    const page = P.page
    ev.check('scene panel: the planner opens the scene', P.hookOk && (await ensureScene(page, a)).ok, P.why)
    await page.evaluate(() => { window.midstudyCtx.shell.openPanel('scene') })
    const button = page.locator('.sp-actions button').nth(1)
    const state = async () => `${(await button.textContent()).trim()}|${String(await button.isDisabled())}`
    await page.waitForSelector('.sp-actions button')

    // the request itself still on its way when the other scene opens (the engine only notices at its answer)
    let letGo = () => {}
    held = new Promise((r) => { letGo = r })
    await button.click()
    await waitFor(async () => ((await state()) === 'Calibrating…|true' ? true : null), { timeoutMs: 5000 }).catch(() => null)
    await ensureScene(page, b)
    await sleep(200)
    ev.check('scene panel: with the request still out, another scene\'s button is free', (await state()) === 'Calibrate again|false', await state())
    held = null
    letGo()
    await waitFor(async () => { const r = await H.raw(srv.base, 'GET', `/api/scenes/${a}`); return r.json?.calib_status === 'done' ? true : null }, { timeoutMs: 30000 }).catch(() => null)
    await ensureScene(page, a)
    await sleep(500)
    fs.rmSync(gateFile, { force: true })
    await button.click()
    await waitFor(async () => ((await state()) === 'Calibrating…|true' ? true : null), { timeoutMs: 5000 }).catch(() => null)
    ev.check('scene panel: the scene that asked shows Calibrating…', (await state()) === 'Calibrating…|true', await state())
    await sleep(300) // the POST has been answered
    await ensureScene(page, b)
    await sleep(200)
    ev.check('scene panel: another scene\'s button reads Calibrate again and is enabled', (await state()) === 'Calibrate again|false', await state())
    await page.evaluate(() => { document.querySelector('#toasts')?.replaceChildren() })
    fs.writeFileSync(gateFile, 'open')
    await waitFor(async () => { const r = await H.raw(srv.base, 'GET', `/api/scenes/${a}`); return r.json?.calib_status === 'done' ? true : null }, { timeoutMs: 30000 }).catch(() => null)
    await sleep(1500)
    let t = await page.evaluate(TOASTS)
    ev.check('scene panel: no recalibration toast in the other scene', !t.some((x) => x.startsWith('Calibrated again')), t.join(' | ') || 'none')
    await button.click()
    await waitFor(async () => ((await page.evaluate(TOASTS)).some((x) => x.startsWith('Calibrated again')) ? true : null), { timeoutMs: 30000 }).catch(() => null)
    t = await page.evaluate(TOASTS)
    ev.check('scene panel: the scene that stays open still gets its toast', t.some((x) => x.startsWith('Calibrated again')), t.join(' | ') || 'none')
    await waitFor(async () => ((await state()) === 'Calibrate again|false' ? true : null), { timeoutMs: 5000 }).catch(() => null)
    ev.check('scene panel: the button comes back', (await state()) === 'Calibrate again|false', await state())
    ev.check('scene panel: no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
    await context.close()
    await srv.stop()
  }
}
