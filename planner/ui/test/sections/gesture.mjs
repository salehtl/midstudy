// planner-core-gesture's checks (docs/notes/state-machines-plan.md), with real touches through CDP: the canvas only
// drives a drag it began, whichever of the canvas and the rotate grip came first; a third finger doesn't disturb a
// pinch; the finger left over from a pinch pans a zoomed view and never taps; a press that outlives its scene does nothing.
const PROBE = 'probe-box'

export async function run({ ev, H, open, phone, seedScene }) {
  const { ensureScene, hook, sleep } = H
  const name = await seedScene('living-wide', 'Gesture A')
  const other = await seedScene('living-wide', 'Gesture B')
  const items = async (page) => (await hook(page, 'getState')).value?.items ?? []
  const add = async (page) => { await hook(page, 'addItem', [PROBE]); return (await items(page)).at(-1).uid }
  const engineDo = (page, fn, arg) => page.evaluate(`(${fn})(window.midstudyCtx.engine, ${JSON.stringify(arg ?? null)})`)
  const rotation = (page, uid) => engineDo(page, '(e, u) => e.getItem(u).rotation_y_deg', uid)
  const position = (page, uid) => engineDo(page, '(e, u) => e.getItem(u).position', uid)
  const dragNow = (page) => engineDo(page, '(e) => e.getDrag()')
  const view = (page) => engineDo(page, '(e) => e.getView()')
  const selection = (page) => engineDo(page, '(e) => e.getSelection()')
  const rectCentre = async (page, uid) => { const r = (await hook(page, 'getScreenRect', [uid])).value; const c = await engineDo(page, '(e, p) => e.photoToClient(p[0], p[1])', [r.x + r.w / 2, r.y + r.h * 0.6]); return { x: Math.round(c[0]), y: Math.round(c[1]) } }
  const gripAt = (page) => page.evaluate(() => { const r = document.querySelector('.ws-grip').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) } })
  const logDrags = (page) => page.evaluate(() => { window.__drags = []; window.midstudyCtx.engine.events.addEventListener('drag', (e) => { window.__drags.push(`${e.detail.mode}:${e.detail.phase}`) }) })
  const drags = (page) => page.evaluate(() => [...window.__drags])
  const near = (a, b) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)
  // every call sends the whole hand, as a real screen does
  const touch = async (page) => {
    const cdp = await page.context().newCDPSession(page)
    const hand = new Map()
    const points = () => [...hand].map(([id, p]) => ({ x: p.x, y: p.y, id, radiusX: 4, radiusY: 4, force: 1 }))
    const send = async (type) => { await cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points() }); await sleep(40) }
    return {
      down: async (id, p) => { hand.set(id, p); await send('touchStart') },
      move: async (id, p) => { hand.set(id, p); await send('touchMove') },
      up: async () => { hand.clear(); await send('touchEnd') }, // all fingers: CDP can't release one of several (a touchMove without it leaves it down)
      close: () => cdp.detach().catch(() => {}),
    }
  }

  // One finger of several lifting: synthetic PointerEvents on the canvas, what input.ts listens to (see touch().up)
  const pointers = (page) => {
    const fire = (type, id, p) => page.evaluate(([t, i, x, y]) => {
      const c = window.midstudyCtx.engine.canvas
      c.setPointerCapture = () => undefined // a synthetic pointer can't be captured
      c.dispatchEvent(new PointerEvent(t, { pointerId: i, pointerType: 'touch', clientX: x, clientY: y, bubbles: true, cancelable: true, button: 0 }))
    }, [type, id, p.x, p.y])
    const at = new Map()
    return {
      down: (id, p) => { at.set(id, p); return fire('pointerdown', id, p) },
      move: (id, p) => { at.set(id, p); return fire('pointermove', id, p) },
      up: (id) => fire('pointerup', id, at.get(id)),
      close: () => undefined,
    }
  }

  // --- (a) a finger on the piece, then a finger on the grip: the grip's, until it lifts --------------------------------
  {
    const P = await phone({ scene: name })
    const page = P.page
    ev.check('gesture: the phone planner opens the scene', P.hookOk && (await ensureScene(page, name)).ok, P.why)
    const uid = await add(page)
    await engineDo(page, '(e, u) => e.select(u)', uid)
    await sleep(200)
    const c = await rectCentre(page, uid)
    const grip = await gripAt(page)
    await logDrags(page)
    const t = await touch(page)
    await t.down(1, c)
    await t.down(2, grip)
    const rot0 = await rotation(page, uid)
    const pos0 = await position(page, uid)
    for (let i = 1; i <= 5; i++) await t.move(1, { x: c.x + i * 8, y: c.y + i * 6 })
    const afterCanvas = { d: await dragNow(page), rot: await rotation(page, uid), pos: await position(page, uid) }
    ev.check('gesture (a): a canvas finger does not drive the grip\'s rotate', afterCanvas.d?.mode === 'rotate' && afterCanvas.rot === rot0 && near(afterCanvas.pos, pos0), JSON.stringify({ afterCanvas, rot0, pos0 }))
    for (let i = 1; i <= 5; i++) await t.move(2, { x: grip.x + i * 12, y: grip.y - i * 4 })
    const turned = await rotation(page, uid)
    ev.check('gesture (a): the grip finger turns the piece', turned !== rot0, `${rot0} -> ${turned}`)
    await t.up()
    await sleep(100)
    ev.check('gesture (a): the drag ends when the fingers lift', (await dragNow(page)) === null && !(await drags(page)).slice(2).includes('move:start'), JSON.stringify(await drags(page)))

    // (a') the grip first, then a finger on the piece: no 'move' begins, and the finger's release taps nothing
    await page.evaluate(() => { window.__drags.length = 0 })
    const grip2 = await gripAt(page)
    const c2 = await rectCentre(page, uid)
    await t.down(2, grip2)
    await t.down(1, c2)
    for (let i = 1; i <= 3; i++) await t.move(1, { x: c2.x + i * 8, y: c2.y })
    const log = await drags(page)
    ev.check('gesture (a\'): a canvas finger during a rotate begins no move', !log.includes('move:start') && (await dragNow(page))?.mode === 'rotate', JSON.stringify(log))
    await t.up()
    await sleep(100)
    ev.check('gesture (a\'): the piece stays selected', (await selection(page)).includes(uid), JSON.stringify(await drags(page)))
    await t.close()
    await engineDo(page, '(e) => e.select(null)')
    await hook(page, 'removeItem', [uid])
  }

  // --- pinches -----------------------------------------------------------------------------------------------------------
  {
    const P = await phone({ scene: other })
    const page = P.page
    ev.check('gesture: the phone planner opens the second scene', P.hookOk && (await ensureScene(page, other)).ok, P.why)
    const box = await page.locator('canvas').first().boundingBox()
    const at = (u, v) => ({ x: Math.round(box.x + box.width * u), y: Math.round(box.y + box.height * v) })
    const t = pointers(page)
    // (b) three fingers; the pinch's first finger lifts, the pair goes on with the other two, no jump
    const A = at(0.5, 0.3), B = at(0.5, 0.5), C = at(0.2, 0.7)
    await t.down(1, A)
    await t.down(2, B)
    await t.move(2, at(0.5, 0.6)) // zoom about 1.5
    await t.down(3, C)
    const z1 = (await view(page)).zoom
    await t.up(1)
    await t.move(3, { x: C.x + 1, y: C.y })
    const z2 = (await view(page)).zoom
    ev.check('gesture (b): lifting a pinch finger with a third down does not jump the zoom', z1 > 1.1 && Math.abs(z2 - z1) / z1 < 0.01, `${z1} -> ${z2}`)
    await t.up(3)
    await t.up(2)
    await engineDo(page, '(e) => e.fitView()')
    await sleep(100)

    // (c) pinch to about 2×, lift one finger (either), the other pans and nothing is tapped
    for (const [lift, keep] of [[1, 2], [2, 1]]) {
      const uid = await add(page)
      await engineDo(page, '(e, u) => e.select(u)', uid)
      const sel0 = await selection(page)
      const p = at(0.5, 0.35), q = at(0.5, 0.45)
      await t.down(1, p)
      await t.down(2, q)
      const d = q.y - p.y
      const pos = { 1: { x: p.x, y: p.y - Math.round(d / 2) }, 2: { x: q.x, y: q.y + Math.round(d / 2) } }
      await t.move(1, pos[1])
      await t.move(2, pos[2]) // twice the distance
      const zoomed = await view(page)
      await t.up(lift)
      const v0 = await view(page)
      for (let i = 1; i <= 4; i++) await t.move(keep, { x: pos[keep].x + i * 10, y: pos[keep].y + i * 6 })
      const v1 = await view(page)
      ev.check(`gesture (c): the finger left over pans (finger ${lift} lifted)`, zoomed.zoom > 1.5 && Math.hypot(v1.cx - v0.cx, v1.cy - v0.cy) > 1 && v1.zoom === v0.zoom, JSON.stringify({ z: zoomed.zoom, v0, v1 }))
      await t.up(keep)
      await sleep(80)
      ev.check(`gesture (c): and its release taps nothing (finger ${lift} lifted)`, JSON.stringify(await selection(page)) === JSON.stringify(sel0), JSON.stringify(await selection(page)))
      await engineDo(page, '(e, u) => { e.select(null); e.removeItemInternal(u); e.fitView() }', uid)
      await sleep(80)
    }
    await t.close()
  }

  // --- a press that outlives its scene does not tap the next one ----------------------------------------------------------
  {
    const P = await open({ scene: other })
    const page = P.page
    ev.check('gesture: the desktop planner opens', P.hookOk && (await ensureScene(page, other)).ok, P.why)
    const first = await add(page)
    await engineDo(page, '(e) => e.select(null)')
    await sleep(150)
    const c = await rectCentre(page, first)
    await hook(page, 'removeItem', [first])
    await ensureScene(page, name)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    await ensureScene(page, other)
    const uid = await add(page)
    await engineDo(page, '(e) => e.select(null)')
    await sleep(150)
    const hit = await engineDo(page, '(e, p) => e.itemAt(p.x, p.y)', c)
    await page.mouse.up()
    await sleep(100)
    ev.check('gesture: a press from the last scene taps nothing on this one', hit === uid && (await selection(page)).length === 0, JSON.stringify({ hit, uid, c, sel: await selection(page) }))
  }
}
