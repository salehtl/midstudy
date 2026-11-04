// midstudy planner input: pointer (mouse, pen, touch), wheel and keyboard handling on top of the engine API (engine.js).
// installInput(engine) → { enabled: { pointer, keyboard }, setKeyFilter(fn), dispose() }
//   enabled.pointer / enabled.keyboard   set false to switch these handlers off
//   setKeyFilter(fn)                     fn(keydownEvent) → true to swallow the key (e.g. while a dialog is open)
// The camera never moves (contract §4.5): zoom and pan are 2D, inside the photo.
// Pointer, one gesture at a time: a drag that starts on the selected item (its box on screen, plus 16 px on touch), or
// with a mouse or pen on any piece, moves it so the grabbed point stays under the pointer (Shift+drag: up and down,
// §2.10); two fingers pinch-zoom and pan; the middle
// button (or any drag on the photo once zoomed in) pans. A tap (no drag, one finger) selects, deselects or sets a ruler point.
// Wheel / trackpad pinch: zoom at the pointer, 1× to 4×.
// Keys: R / Shift+R rotate 15°, Delete/Backspace remove, Esc deselects or leaves the ruler, PageUp / PageDown raise and
// lower 1 cm (Shift 10 cm), F or 0 fit the photo, + / − zoom.

const TAP_PX = { mouse: 4, pen: 6, touch: 10 }

export function installInput(engine) {
  const canvas = engine.canvas
  const enabled = { pointer: true, keyboard: true }
  let keyFilter = null
  const off = []
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); off.push(() => target.removeEventListener(type, fn, opts)) }

  // --- pointer (capture phase on window: the overlays above the canvas handle their own pointers)
  const ptrs = new Map() // id -> { x, y }
  let g = null // the gesture: { id, kind: 'item'|'pan'|'other'|'pinch', x0, y0, lx, ly, t0, type, moved, multi }
  let pinch = null // { d0, z0, mx, my }
  const mid = () => { const p = [...ptrs.values()]; return { x: (p[0].x + p[1].x) / 2, y: (p[0].y + p[1].y) / 2, d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) } }
  on(window, 'pointerdown', (e) => {
    if (!enabled.pointer || e.target !== canvas || !engine.getSceneName()) return
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (ptrs.size === 2) {
      if (g?.kind === 'item') engine.endItemDrag()
      if (g) g.multi = true
      const m = mid()
      pinch = { d0: Math.max(1, m.d), z0: engine.getView().zoom, mx: m.x, my: m.y }
      if (g) g.kind = 'pinch'
      return
    }
    if (ptrs.size > 2) return
    e.preventDefault()
    g = { id: e.pointerId, kind: 'other', x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), type: e.pointerType, moved: false, multi: false }
    const sel = engine.getSelected()
    const pad = e.pointerType === 'mouse' ? 6 : 16
    const ruler = engine.getRuler().active
    if (e.button === 1) g.kind = 'pan'
    else if (sel && !ruler && engine.hitItemAt(sel, e.clientX, e.clientY, pad) && engine.beginItemDrag(sel, e.clientX, e.clientY, { lift: e.shiftKey })) g.kind = 'item'
    else if (!ruler && !engine.getAdjustFloor() && e.pointerType !== 'touch') {
      // Mouse and pen: press on any piece and drag it straight away (it gets selected). Touch keeps "tap, then drag",
      // so a finger on the photo can still pan a zoomed view without moving furniture by accident.
      const hit = engine.itemAt(e.clientX, e.clientY)
      if (hit && engine.beginItemDrag(hit, e.clientX, e.clientY, { lift: e.shiftKey })) g.kind = 'item'
    }
    canvas.setPointerCapture?.(e.pointerId)
  }, true)
  on(window, 'pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && ptrs.size >= 2) {
      const m = mid()
      engine.zoomAt(m.x, m.y, pinch.z0 * (m.d / pinch.d0))
      engine.panBy(m.x - pinch.mx, m.y - pinch.my)
      pinch.mx = m.x
      pinch.my = m.y
      return
    }
    if (!g || e.pointerId !== g.id) return
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > (TAP_PX[g.type] ?? 6)) g.moved = true
    if (g.kind === 'item') engine.dragTo(e.clientX, e.clientY)
    else if (g.moved && !g.multi && (g.kind === 'pan' || (g.kind === 'other' && engine.getView().zoom > 1.001))) {
      g.kind = 'pan'
      engine.panBy(e.clientX - g.lx, e.clientY - g.ly)
    }
    g.lx = e.clientX
    g.ly = e.clientY
  }, true)
  const up = (e) => {
    if (!ptrs.delete(e.pointerId)) return
    if (ptrs.size < 2) pinch = null
    if (!g || ptrs.size) return
    const d = g
    g = null
    if (d.kind === 'item') engine.endItemDrag()
    const quick = d.type === 'mouse' || performance.now() - d.t0 < 700
    if (e.type !== 'pointerup' || d.moved || d.multi || !quick || d.kind === 'pan') return
    try { engine.tap(e.clientX, e.clientY) } catch (err) { engine.reportError('Tap failed', err) }
  }
  on(window, 'pointerup', up, true)
  on(window, 'pointercancel', up, true)
  on(canvas, 'auxclick', (e) => e.preventDefault())

  // --- wheel: zoom at the pointer (a trackpad pinch arrives as a wheel with ctrlKey)
  on(canvas, 'wheel', (e) => {
    if (!enabled.pointer || !engine.getSceneName()) return
    e.preventDefault()
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
    const dy = e.deltaY * k
    const factor = Math.exp(-dy * (e.ctrlKey ? 0.01 : 0.0015))
    engine.zoomBy(factor, e.clientX, e.clientY)
  }, { passive: false })

  // --- keyboard
  const typing = (e) => {
    const t = e.target
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  }
  on(window, 'keydown', (e) => {
    if (!enabled.keyboard) return
    const k = e.key.toLowerCase()
    if (k === 'shift') engine.setSnap(true)
    if (keyFilter && keyFilter(e)) return
    if (typing(e)) {
      if (e.key === 'Escape') e.target.blur()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const selected = engine.getSelected()
    if (k === 'escape') {
      if (engine.getRuler().active) engine.setRulerActive(false)
      else engine.select(null)
    } else if (k === 'delete' || k === 'backspace') {
      if (selected) { e.preventDefault(); engine.removeItemInternal(selected) }
    } else if (k === 'r') {
      engine.rotateSelected(e.shiftKey ? -15 : 15)
    } else if (k === 'pageup' || k === 'pagedown') {
      if (selected) { e.preventDefault(); engine.nudgeElevation(selected, (k === 'pageup' ? 1 : -1) * (e.shiftKey ? 0.1 : 0.01)) }
    } else if (k === 'f' || k === '0') {
      engine.fitView()
    } else if (k === '+' || k === '=') {
      engine.zoomBy(1.25)
    } else if (k === '-' || k === '_') {
      engine.zoomBy(0.8)
    }
  })
  on(window, 'keyup', (e) => { if (e.key.toLowerCase() === 'shift') engine.setSnap(false) })
  on(window, 'blur', () => engine.setSnap(false))

  return {
    enabled,
    setKeyFilter: (fn) => { keyFilter = typeof fn === 'function' ? fn : null },
    dispose: () => { for (const f of off.splice(0)) f() },
  }
}
