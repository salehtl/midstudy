// planner-ui-renders' checks (docs/notes/state-machines-plan.md): the viewer stays on its render when another arrives;
// a render that settles after the scene changed leaves the new scene alone and reports a failure once, by the old
// scene's title; a Render… whose capture spans a scene change opens nothing; a request with no answer reads "may still
// finish" and warns on Retry; the modal is a shell layer and its arrows act only when on top; Compare's picks drop a
// render that is gone. POST /api/render is held with page.route; fal stays mocked.
const TOASTS = () => [...document.querySelectorAll('#toasts .toast:not(.is-leaving) .toast-text')].map((t) => t.textContent)
const render = (page) => page.evaluate(() => { window.midstudyCtx.shell.events.emit('render-request', {}, true) })

export async function run({ ev, H, open, seedScene }) {
  const { ensureScene, hook, sleep, waitFor } = H
  const scene = await seedScene('living-wide', 'Renders check')
  const other = await seedScene('room-1', 'Renders other')
  ev.check('renders: two scenes of their own seeded', !!scene && !!other, `${scene} ${other}`)
  let gate = null // a promise: while set, POST /api/render waits on it
  let answer = async (route) => { await route.continue() }
  let hide = null // a render's name GET /api/renders leaves out
  const gets = []
  const setup = async (c) => {
    await c.route(/\/api\/render(\?|$)/, async (route) => {
      if (route.request().method() !== 'POST') { await route.continue(); return }
      if (gate) await gate
      await answer(route)
    })
    await c.route(/\/api\/renders\?/, async (route) => {
      gets.push(Date.now())
      if (!hide) { await route.continue(); return }
      const r = await route.fetch()
      const j = await r.json()
      j.renders = j.renders.filter((x) => x.name !== hide)
      await route.fulfill({ response: r, json: j })
    })
  }
  const P = await open({ scene, setup })
  const page = P.page
  ev.check('renders: the planner opens the scene', P.hookOk && (await ensureScene(page, scene)).ok, P.why)
  const shown = () => page.evaluate(() => document.querySelector('.rn-modal.is-viewer .rv-pair figure:nth-child(2) img')?.getAttribute('src') ?? null)
  const top = () => page.evaluate(() => window.midstudyCtx.shell.topLayer())
  const opened = (sel) => page.locator(sel).count()
  const confirmGo = async () => {
    await render(page)
    await page.waitForSelector('.rn-modal.is-confirm [data-midstudy="render-go"]:not([disabled])', { timeout: 30000 })
    await page.click('.rn-modal.is-confirm [data-midstudy="render-go"]')
  }
  const held = () => { let release = () => {}; gate = new Promise((r) => { release = r }); return () => { gate = null; release() } }
  const rowText = () => page.evaluate(() => [...document.querySelectorAll('.rn-row.is-failed')].map((e) => e.textContent).join(' | '))
  const sawPost = () => page.waitForFunction(() => document.querySelector('.rn-row.is-rendering') !== null, null, { timeout: 30000 })
  await page.evaluate(() => { window.midstudyCtx.shell.openPanel('renders') })

  // --- the viewer stays on its render, and is a shell layer ------------------------------------------------------------
  for (let i = 0; i < 3; i++) { const r = await hook(page, 'renderView', [], 120000); if (r.error) ev.check('renders: a mock render', false, r.error) }
  const names = await page.evaluate(() => window.midstudyCtx.engine.getRenders().map((r) => r.name))
  const oldest = names.at(-1)
  await page.click(`.rn-row[data-render="${oldest}"]`)
  await page.waitForSelector('.rn-modal.is-viewer')
  const before = await shown()
  ev.check('renders: the open viewer is the top shell layer', (await top()) === 'modal', String(await top()))
  await hook(page, 'renderView', [], 120000)
  await sleep(300)
  ev.check('renders: a new render leaves the viewer on the same render', before?.includes(oldest) && (await shown()) === before, `${before} → ${await shown()}`)

  // a layer over the modal takes the arrows' place and the Esc
  await page.evaluate(() => { window.__over = window.midstudyCtx.shell.pushLayer('sheet', () => { window.__over.remove(); window.__overGone = true }) })
  await page.keyboard.press('ArrowLeft')
  await sleep(100)
  ev.check('renders: the arrows do nothing under another layer', (await shown()) === before, String(await shown()))
  await page.keyboard.press('Escape')
  await sleep(100)
  ev.check('renders: one Esc closes the layer on top, the viewer stays', (await page.evaluate(() => window.__overGone === true)) && (await opened('.rn-modal.is-viewer')) === 1, `viewers ${await opened('.rn-modal.is-viewer')}`)
  await page.keyboard.press('ArrowLeft')
  await sleep(100)
  ev.check('renders: the arrows step when the viewer is on top', (await shown()) !== before, String(await shown()))
  await page.keyboard.press('Escape')
  await sleep(100)
  ev.check('renders: Esc closes the viewer and removes its layer', (await opened('.rn-modal.is-viewer')) === 0 && (await top()) === null, String(await top()))

  // --- Compare's picks drop a render that is gone -----------------------------------------------------------------------
  const [n0, n1, n2] = await page.evaluate(() => window.midstudyCtx.engine.getRenders().map((r) => r.name))
  await page.click('[data-midstudy="compare"]')
  await page.click(`.rn-row[data-render="${n0}"]`)
  hide = n0
  await page.evaluate(() => window.midstudyCtx.engine.listRendersInternal())
  hide = null
  await page.click(`.rn-row[data-render="${n1}"]`)
  await sleep(200)
  const noCompare = await opened('.rn-modal.is-compare')
  ev.check('renders: a picked render that left the list is no longer a pick (one more pick needed)', noCompare === 0, `compare modals ${noCompare}`)
  if (noCompare) await page.keyboard.press('Escape') // the check above failed: the rest still runs
  else await page.click(`.rn-row[data-render="${n2}"]`)
  await page.waitForSelector('.rn-modal.is-compare', { timeout: 5000 }).catch(() => null)
  ev.check('renders: Compare opens on the two picks that exist', (await opened('.rn-modal.is-compare')) === 1, (await page.evaluate(TOASTS)).join(' | '))
  await page.keyboard.press('Escape')
  await page.evaluate(() => window.midstudyCtx.engine.listRendersInternal())

  // --- a request with no answer -----------------------------------------------------------------------------------------
  {
    const release = held()
    answer = async (route) => { await route.abort('connectionreset') }
    await confirmGo()
    await sawPost()
    release()
    await waitFor(async () => ((await rowText()) ? true : null), { timeoutMs: 15000 }).catch(() => null)
    const row = await rowText()
    const t0 = Date.now()
    ev.check('renders: a request with no answer reads failed, may still finish, not "Not charged"', /Failed · the connection dropped/.test(row) && /May still finish/.test(row) && !/Not charged/.test(row), row)
    await waitFor(async () => (gets.some((t) => t > t0 - 500) ? true : null), { timeoutMs: 8000 }).catch(() => null)
    ev.check('renders: the list is asked again after a lost request', gets.some((t) => t > t0 - 500), `${gets.length} GETs`)
    await page.click('.rn-row.is-failed .rn-retry')
    await page.waitForSelector('.rn-modal.is-confirm')
    const sub = await page.evaluate(() => document.querySelector('.rn-modal.is-confirm .rc-sub')?.textContent ?? '')
    ev.check('renders: Retry\'s confirm warns the first may have finished', /may have finished/.test(sub), sub)
    await page.keyboard.press('Escape')
    await page.click('.rn-row.is-failed .rn-dismiss')
    answer = async (route) => { await route.continue() }
  }

  // --- a render that settles in another scene ------------------------------------------------------------------------
  for (const [what, respond, expect] of [
    ['succeeds', async (route) => { const r = await route.fetch(); const j = await r.json(); j.keep_room = true; j.aligned = { applied: false, reason: 'test' }; await route.fulfill({ response: r, json: j }) }, null],
    ['fails', async (route) => { await route.fulfill({ status: 500, json: { error: 'held and failed' } }) }, 'A render of Renders check failed'],
  ]) {
    await ensureScene(page, scene)
    await sleep(200)
    const release = held()
    answer = respond
    await confirmGo()
    await sawPost()
    await ensureScene(page, other)
    await sleep(200)
    const shownBefore = (await page.evaluate(TOASTS)).length
    release()
    await sleep(1500)
    const toasts = await page.evaluate(TOASTS)
    const failedRows = await page.locator('.rn-row.is-failed').count()
    const pendingRows = await page.locator('.rn-row.is-rendering').count()
    const aligned = toasts.some((t) => /applied/i.test(t))
    ev.check(`renders: a render that ${what} after a scene change: no row, ${expect ? 'one named toast' : 'no not-aligned toast'}`,
      failedRows === 0 && pendingRows === 0 && (expect ? toasts.filter((t) => t === expect).length === 1 : !aligned), `failed ${failedRows}, pending ${pendingRows}; toasts before ${shownBefore}: ${toasts.join(' | ')}`)
    answer = async (route) => { await route.continue() }
  }

  // --- Render… whose capture spans a scene change -----------------------------------------------------------------------
  {
    await page.evaluate(() => {
      const e = window.midstudyCtx.engine
      const real = e.captureComposite
      window.__capture = { held: false, release: () => {} }
      e.captureComposite = async (...a) => {
        const shot = await real(...a)
        window.__capture.held = true
        await new Promise((r) => { window.__capture.release = r })
        e.captureComposite = real
        return shot
      }
    })
    await render(page)
    await waitFor(async () => (await page.evaluate(() => window.__capture.held) ? true : null), { timeoutMs: 20000 }).catch(() => null)
    const switched = await ensureScene(page, scene)
    await page.evaluate(() => { window.__capture.release() })
    await sleep(500)
    ev.check('renders: a capture that spans a scene change opens no confirm', switched.ok && (await opened('.rn-modal.is-confirm')) === 0, `confirms ${await opened('.rn-modal.is-confirm')}`)
  }
}
