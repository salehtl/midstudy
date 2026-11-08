// planner-ui-workspace's checks (docs/notes/state-machines-plan.md): ⌘Z never crosses into another scene, is one channel
// with In the scene's Remove and restores once, and survives a room's photo switch; the height button's repeat stops with
// its piece and a held-off press doesn't swallow the next key; the chip counts overlapping renders; the horizon and ruler
// drags end with their mode; Looks right and Set scale run once and say nothing after the user left.
const PROBE = 'probe-box'
const UNDO = process.platform === 'darwin' ? 'Meta+z' : 'Control+z'

export async function run({ ev, H, open, phone, seedScene, goldenRoom }) {
  const { ensureScene, hook, sleep, waitFor } = H
  const sceneA = await seedScene('living-wide', 'Workspace A')
  const sceneB = await seedScene('living-wide', 'Workspace B')
  ev.check('workspace: scenes of their own seeded', !!sceneA && !!sceneB, `${sceneA} ${sceneB}`)
  const items = async (page) => (await hook(page, 'getState')).value?.items ?? []
  const uids = async (page) => (await items(page)).map((i) => i.uid)
  const add = async (page) => { await hook(page, 'addItem', [PROBE]); return (await uids(page)).at(-1) }
  const select = (page, uid) => page.evaluate((u) => { window.midstudyCtx.engine.select(u) }, uid)
  const elev = (page, uid) => page.evaluate((u) => window.midstudyCtx.engine.getElevation(u), uid)
  const toastsText = (page) => page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].map((t) => t.textContent))
  const centre = (page, sel) => page.evaluate((s) => { const r = document.querySelector(s)?.getBoundingClientRect(); return r ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null }, sel)
  const clear = async (page) => { for (const u of await uids(page)) await page.evaluate((x) => { window.midstudyCtx.engine.removeItemWithUndo(x) }, u) }

  // --- Undo -----------------------------------------------------------------------------------------------------------
  {
    const P = await open({ scene: sceneA })
    const page = P.page
    ev.check('workspace: the planner opens the scene', P.hookOk && (await ensureScene(page, sceneA)).ok, P.why)

    // (c) ⌘Z, then the toast it just closed: one copy
    const uid = await add(page)
    await select(page, uid)
    await page.keyboard.press('Delete')
    await page.waitForSelector('#toasts .toast-action')
    await page.evaluate(() => { window.__wsAction = document.querySelector('#toasts .toast-action') })
    await page.keyboard.press(UNDO)
    await page.evaluate(() => { window.__wsAction?.click() })
    await sleep(500)
    ev.check('undo: ⌘Z then a click on the leaving toast restores one copy', (await items(page)).length === 1, String((await items(page)).length))

    // (b) one channel: In the scene's Remove is what ⌘Z undoes, not an older removal
    await clear(page)
    const older = await add(page)
    const newer = await add(page)
    await select(page, older)
    await page.keyboard.press('Delete')
    await sleep(100)
    await page.evaluate(() => { window.midstudyCtx.shell.openPanel('inroom') })
    await page.waitForSelector(`.ir-row[data-uid="${newer}"] .ir-del`)
    await page.click(`.ir-row[data-uid="${newer}"] .ir-del`)
    await sleep(100)
    await page.evaluate(() => { document.activeElement?.blur?.() })
    await page.keyboard.press(UNDO)
    await sleep(500)
    const back = await uids(page)
    ev.check('undo: ⌘Z after In the scene\'s Remove restores that piece, not an older removal', back.length === 1 && back[0] === newer, back.join(','))

    // (a) Del, open another scene, ⌘Z: nothing lands there, and the toast is gone with its piece's scene
    await clear(page)
    await select(page, await add(page))
    await page.keyboard.press('Delete')
    await sleep(100)
    await ensureScene(page, sceneB)
    await sleep(200)
    const before = (await items(page)).length
    await page.keyboard.press(UNDO)
    await sleep(2000) // long enough for a wrong restore to land
    ev.check('undo: ⌘Z after opening another scene restores nothing there', (await items(page)).length === before, `${before} -> ${(await items(page)).length}`)
    const left = await toastsText(page)
    ev.check('undo: the removal\'s toast does not outlive its scene', !left.some((t) => t.includes('removed')), left.join(' | ') || 'none')

    // --- Height button --------------------------------------------------------------------------------------------------
    await ensureScene(page, sceneA)
    await clear(page)
    const p1 = await add(page)
    const p2 = await add(page)
    await select(page, p1)
    await sleep(150)
    const up = await centre(page, '[data-midstudy="elev-up"]')
    ev.check('hold: the + button is there', !!up, JSON.stringify(up))
    if (up) {
      await page.mouse.move(up.x, up.y)
      await page.mouse.down()
      await sleep(600) // the repeat has started
      await select(page, p2)
      await sleep(100)
      const a0 = await elev(page, p1)
      const b0 = await elev(page, p2)
      await sleep(1500)
      const a1 = await elev(page, p1)
      const b1 = await elev(page, p2)
      await page.mouse.up()
      ev.check('hold: a press whose button is rebuilt stops: the next piece is unchanged, the first stopped', a1 === a0 && b1 === b0 && b1 === 0, `first ${a0} -> ${a1}; second ${b0} -> ${b1}`)

      // pointer down, pointer away without a click, then Enter: the key nudges once
      await page.evaluate(([a, b]) => { const e = window.midstudyCtx.engine; e.setElevation(a, 0); e.setElevation(b, 0); e.select(a) }, [p1, p2])
      await sleep(150)
      const up2 = await centre(page, '[data-midstudy="elev-up"]')
      await page.mouse.move(up2.x, up2.y)
      await page.mouse.down()
      await page.mouse.move(up2.x, up2.y - 90)
      await page.mouse.up()
      await sleep(100)
      const e0 = await elev(page, p1)
      await page.focus('[data-midstudy="elev-up"]')
      await page.keyboard.press('Enter')
      await sleep(150)
      const e1 = await elev(page, p1)
      ev.check('hold: after a press that left the button, Enter nudges once', Math.abs(e1 - e0 - 0.01) < 1e-6, `${e0} -> ${e1}`)
      await sleep(700)
      ev.check('hold: leaving the button stopped the repeat', Math.abs((await elev(page, p1)) - e1) < 1e-6, String(await elev(page, p1)))
    }
    ev.check('workspace: no page errors (undo, hold)', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
    await page.context().close()
  }

  // phone: one tap is one step
  {
    const P = await phone({ viewport: { width: 375, height: 812 }, scene: sceneB })
    const page = P.page
    ev.check('hold (phone): the planner opens', P.hookOk && (await ensureScene(page, sceneB)).ok, `${P.why}; ${P.errors.page.join(' | ')}`)
    await clear(page)
    const uid = await add(page)
    await select(page, uid)
    await sleep(200)
    const up = await centre(page, '[data-midstudy="elev-up"]')
    ev.check('hold (phone): the + button is there', !!up, JSON.stringify(up))
    if (up) {
      await page.touchscreen.tap(up.x, up.y)
      await sleep(700)
      const e = await elev(page, uid)
      ev.check('hold (phone): one tap raises one step', Math.abs(e - 0.01) < 1e-6, String(e))
    }
    await page.context().close()
  }

  // --- The rendering chip ----------------------------------------------------------------------------------------------
  {
    const held = []
    const scene = await seedScene('living-wide', 'Workspace render')
    const P = await open({ scene, setup: (c) => c.route(/\/api\/render(\?|$)/, async (route) => { if (route.request().method() !== 'POST') { await route.continue(); return } held.push(route) }) })
    const page = P.page
    await ensureScene(page, scene)
    await page.evaluate(() => {
      const e = window.midstudyCtx.engine
      window.__wsR = [e.renderViewInternal({}).catch(() => null), e.renderViewInternal({}).catch(() => null)]
    })
    await waitFor(async () => (held.length === 2 ? true : null), { timeoutMs: 30000 }).catch(() => null)
    const chips = () => page.locator('.ws-chip').count()
    ev.check('chip: two renders held', held.length === 2 && (await chips()) === 1, `${held.length} held, ${await chips()} chip`)
    await held[0]?.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"held"}' })
    await sleep(400)
    ev.check('chip: stays while the second render runs', (await chips()) === 1, String(await chips()))
    await held[1]?.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"held"}' })
    await waitFor(async () => ((await chips()) === 0 ? true : null), { timeoutMs: 5000 }).catch(() => null)
    ev.check('chip: goes when the last render ends', (await chips()) === 0, String(await chips()))
  }

  // --- Overlay drags ----------------------------------------------------------------------------------------------------
  const floorPoints = async (page) => {
    const a = (await hook(page, 'floorToPhoto', [[-0.5, 0, -2.0]])).value
    const b = (await hook(page, 'floorToPhoto', [[0.5, 0, -2.0]])).value
    await page.evaluate(([p, q]) => {
      const e = window.midstudyCtx.engine
      e.setRulerActive(true)
      for (const v of [p, q]) { const [x, y] = e.photoToClient(v[0], v[1]); e.tap(x, y) }
    }, [a, b])
    await sleep(150)
  }
  const ruler = (page) => page.evaluate(() => JSON.stringify(window.midstudyCtx.engine.getRuler().points))
  {
    const scene = await seedScene('living-wide', 'Workspace overlay')
    const gate = { hold: false, release: () => {}, puts: 0 }
    const P = await open({ scene, setup: (c) => c.route(/\/api\/scenes\/[^/?]+$/, async (route) => {
      if (route.request().method() === 'PUT') {
        gate.puts++
        if (gate.hold) await new Promise((r) => { gate.release = r })
      }
      await route.continue().catch(() => {})
    }) })
    const page = P.page
    await ensureScene(page, scene)
    await page.evaluate(() => { window.midstudyCtx.workspace.setAdjust(true) })
    await sleep(200)
    const pitch = () => page.evaluate(() => window.midstudyCtx.engine.getCamera().pitch_deg)
    const hz = await centre(page, '[data-midstudy="horizon"]')
    ev.check('drag: the horizon handle is there', !!hz, JSON.stringify(hz))
    if (hz) {
      await page.mouse.move(hz.x, hz.y)
      await page.mouse.down()
      await page.mouse.move(hz.x, hz.y + 10)
      await page.keyboard.press('Escape')
      await sleep(100)
      const p0 = await pitch()
      await page.mouse.move(hz.x, hz.y + 90, { steps: 4 })
      const p1 = await pitch()
      await page.mouse.up()
      ev.check('drag: the horizon stops setting the pitch once Adjust floor is left', p0 === p1 && !(await page.evaluate(() => window.midstudyCtx.engine.getAdjustFloor())), `${p0} -> ${p1}`)
    }
    await page.evaluate(() => { window.midstudyCtx.workspace.setAdjust(true) })
    await sleep(150)
    await floorPoints(page)
    const h0 = await centre(page, '.ws-handle[data-i="0"]')
    ev.check('drag: the ruler handle is there', !!h0, JSON.stringify(h0))
    if (h0) {
      await page.mouse.move(h0.x, h0.y)
      await page.mouse.down()
      await page.mouse.move(h0.x + 5, h0.y)
      await page.keyboard.press('Escape') // leaves the ruler (and clears its points)
      await sleep(100)
      await floorPoints(page) // the ruler back on, the old press still down: its handle must not move these
      const r0 = await ruler(page)
      await page.mouse.move(h0.x + 60, h0.y + 40, { steps: 4 })
      const r1 = await ruler(page)
      await page.mouse.up()
      ev.check('drag: a ruler handle stops once the ruler is switched off', r0 === r1 && r0 !== '[]', `${r0} -> ${r1}`)
    }

    // Looks right: left during the save, no word; pressed twice, one save
    await page.evaluate(() => { window.midstudyCtx.workspace.setAdjust(false) })
    await page.evaluate(() => { window.midstudyCtx.workspace.setAdjust(true) })
    await page.waitForSelector('[data-midstudy="floor-ok"]')
    gate.hold = true
    gate.puts = 0
    await page.click('[data-midstudy="floor-ok"]')
    await waitFor(async () => (gate.puts === 1 ? true : null), { timeoutMs: 5000 }).catch(() => null)
    await page.keyboard.press('Escape')
    await sleep(100)
    gate.hold = false
    gate.release()
    await sleep(600)
    const t1 = await toastsText(page)
    ev.check('floor: leaving Adjust floor during the save means no "Floor saved"', !t1.some((t) => t.includes('Floor saved')), t1.join(' | ') || 'none')

    await page.evaluate(() => { window.midstudyCtx.workspace.setAdjust(true) })
    await page.waitForSelector('[data-midstudy="floor-ok"]')
    gate.puts = 0
    await page.evaluate(() => { const b = document.querySelector('[data-midstudy="floor-ok"]'); b.click(); b.click() })
    await sleep(800)
    ev.check('floor: Looks right pressed twice saves once', gate.puts === 1, `${gate.puts} PUT`)
    ev.check('floor: no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
  }

  // --- The golden room: Undo across a photo switch, Set scale once ------------------------------------------------------
  {
    const { room, names } = await goldenRoom()
    ev.check('workspace: the golden room is there', !!room, String(room))
    const P = await open({})
    const page = P.page
    const writes = []
    page.on('request', (r) => { if (r.method() !== 'GET' && r.url().includes(`/api/rooms/${room}`) && !r.url().includes('/layouts')) writes.push(`${r.method()} ${r.url()}`) })
    await hook(page, 'openRoom', [room, names['living-wide']])
    await clear(page)
    const uid = await add(page)
    await select(page, uid)
    await page.keyboard.press('Delete')
    await sleep(150)
    await hook(page, 'setRoomPhoto', [names['room-1']])
    await sleep(300)
    await page.keyboard.press(UNDO)
    await sleep(600)
    ev.check('undo (room): ⌘Z after a photo switch restores the piece', (await uids(page)).includes(uid), (await uids(page)).join(','))
    await clear(page)

    await hook(page, 'setRoomPhoto', [names['living-wide']])
    await hook(page, 'setAdjustFloor', [true])
    await sleep(200)
    await floorPoints(page)
    await page.fill('[data-midstudy="ruler-true"]', '200')
    writes.length = 0
    await page.evaluate(() => {
      document.querySelector('[data-midstudy="ruler-true"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
      document.querySelector('[data-midstudy="room-scale"]').click()
    })
    await sleep(1200)
    ev.check('floor (room): Enter and a click on Set scale write the room once', writes.length === 1, writes.join(' | ') || 'none')
    ev.check('workspace: no page errors (room)', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
  }
}
