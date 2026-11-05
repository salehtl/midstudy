// midstudy planner input: pointer (mouse, pen, touch), wheel and keyboard handling on top of the engine API (engine.js).
// installInput(engine, { keys }) → { enabled: { pointer, keyboard }, setKeyFilter(fn), dispose() }
//   keys                                 the keymap (keymap.js): the engine's own shortcuts register into it here, the
//                                        UI's in their modules; one keydown listener here dispatches them all
//   enabled.pointer / enabled.keyboard   set false to switch these handlers off
//   setKeyFilter(fn)                     fn(keydownEvent) → true to swallow the key (e.g. while a dialog is open)
// The camera never moves (contract §4.5): zoom and pan are 2D, inside the photo.
// Pointer, one gesture at a time: a drag that starts on the selected item (its box on screen, plus 16 px on touch), or
// with a mouse or pen on any piece, moves it so the grabbed point stays under the pointer (Shift+drag: up and down,
// §2.10); a drag on a piece of a multi-selection moves the whole selection. Shift+click on a piece adds it to the
// selection or takes it out (Shift+click on the photo keeps the selection); two fingers pinch-zoom and pan; the middle
// button (or any drag on the photo once zoomed in) pans. A tap (no drag, one finger) selects, deselects or sets a ruler point.
// Wheel / trackpad pinch: zoom at the pointer, 1× to 4×.
// Keys (registered in the keymap, listed in the Shortcuts sheet): ⌘A select all, Esc deselects or leaves the ruler,
// arrows move the selection 1 cm on the floor (Shift 10 cm; ↑ away from the camera), R / Shift+R rotate 15°,
// PageUp / PageDown raise and lower 1 cm (Shift 10 cm), ⌘D duplicates, F or 0 fit the photo, + / − zoom. Delete and
// ⌘Z (with their Undo toast) are the workspace's (ui/workspace.js).

const TAP_PX = { mouse: 4, pen: 6, touch: 10 }

export function installInput(engine, { keys } = {}) {
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
    else if (e.shiftKey && !ruler && !engine.getAdjustFloor()) {
      // Shift: a click toggles the piece in the selection, a drag lifts it (decided once the pointer moves)
      g.kind = 'shift'
      g.hit = (sel && engine.hitItemAt(sel, e.clientX, e.clientY, pad) ? sel : null) ?? engine.itemAt(e.clientX, e.clientY)
      if (g.hit && !engine.isSelected(g.hit)) g.hit = engine.itemAt(e.clientX, e.clientY) // the pad only counts for a selected piece
    } else if (sel && !ruler && engine.hitItemAt(sel, e.clientX, e.clientY, pad) && engine.beginItemDrag(sel, e.clientX, e.clientY, { lift: e.shiftKey })) g.kind = 'item'
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
    if (g.kind === 'shift' && g.moved) {
      if (g.hit && engine.beginItemDrag(g.hit, g.x0, g.y0, { lift: true })) g.kind = 'item'
      else g.kind = 'other'
    }
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
    if (d.kind === 'shift') { if (e.type === 'pointerup' && d.hit) engine.select(d.hit, { toggle: true }); return }
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

  // --- keyboard: the keymap dispatches; the engine's own commands are registered here -----------------------------------
  const typing = (e) => {
    const t = e.target
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)
  }
  on(window, 'keydown', (e) => {
    if (!enabled.keyboard) return
    if (e.key === 'Shift') engine.setSnap(true)
    if (keyFilter && keyFilter(e)) return
    if (typing(e) && e.key === 'Escape') { e.target.blur(); return }
    keys?.handle(e)
  })
  if (keys) registerEngineKeys(engine, keys)
  on(window, 'keyup', (e) => { if (e.key.toLowerCase() === 'shift') engine.setSnap(false) })
  on(window, 'blur', () => engine.setSnap(false))

  return {
    enabled,
    setKeyFilter: (fn) => { keyFilter = typeof fn === 'function' ? fn : null },
    dispose: () => { for (const f of off.splice(0)) f() },
  }
}

// The engine's shortcuts (the keymap's 'Selection', 'Move and turn' and 'View' groups; the UI adds its own).
function registerEngineKeys(engine, keys) {
  const open = () => !!engine.getSceneName() && !engine.getSceneLoad().loading
  const any = () => open() && engine.getSelection().length > 0
  const shiftWord = keys.isMac ? '⇧' : 'Shift'
  // Selection
  keys.describe({ id: 'select.click', group: 'Selection', label: 'Select a piece', keys: ['click'] })
  keys.describe({ id: 'select.shift', group: 'Selection', label: 'Add a piece to the selection, or take it out', keys: ['shift+click'] })
  keys.register({ id: 'select.all', group: 'Selection', label: 'Select every piece', keys: ['mod+a'], when: () => open() && engine.getItems().length > 0 && !engine.getAdjustFloor(), run: () => engine.selectAll() })
  keys.register({ id: 'ruler.leave', group: 'Selection', label: 'Leave the ruler', keys: ['escape'], priority: 20, repeat: false, hidden: true, when: () => engine.getRuler().active, run: () => engine.setRulerActive(false) })
  keys.register({ id: 'select.none', group: 'Selection', label: 'Deselect', keys: ['escape'], repeat: false, when: () => engine.getSelection().length > 0, run: () => engine.select(null) })
  // Move and turn
  keys.describe({ id: 'item.drag', group: 'Move and turn', label: 'Move on the floor (a selected group moves together)', keys: ['drag'] })
  keys.describe({ id: 'item.lift', group: 'Move and turn', label: 'Raise or lower', keys: ['shift+drag'] })
  const step = (e) => (e.shiftKey ? 0.1 : 0.01)
  const ARROWS = { arrowup: [0, -1], arrowdown: [0, 1], arrowleft: [-1, 0], arrowright: [1, 0] }
  keys.register({
    id: 'item.move', group: 'Move and turn', label: `Move 1 cm on the floor (${shiftWord} 10 cm; ↑ is away from the camera)`,
    keys: Object.keys(ARROWS).flatMap((k) => [k, `shift+${k}`]), display: ['arrows'], when: any,
    run: (e) => { const [x, z] = ARROWS[e.key.toLowerCase()]; engine.nudgeSelected([x * step(e), 0, z * step(e)]) },
  })
  keys.register({ id: 'item.raise', group: 'Move and turn', label: `Raise 1 cm (${shiftWord} 10 cm)`, keys: ['pageup', 'shift+pageup'], display: ['pageup'], when: any, run: (e) => engine.nudgeSelected([0, step(e), 0]) })
  keys.register({ id: 'item.lower', group: 'Move and turn', label: `Lower 1 cm (${shiftWord} 10 cm)`, keys: ['pagedown', 'shift+pagedown'], display: ['pagedown'], when: any, run: (e) => engine.nudgeSelected([0, -step(e), 0]) })
  keys.register({ id: 'item.rotate', group: 'Move and turn', label: 'Turn 15° (several: as a group)', keys: ['r'], when: any, run: () => engine.rotateSelected(15) })
  keys.register({ id: 'item.rotate-back', group: 'Move and turn', label: 'Turn back 15°', keys: ['shift+r'], when: any, run: () => engine.rotateSelected(-15) })
  keys.register({ id: 'item.duplicate', group: 'Move and turn', label: 'Duplicate', keys: ['mod+d'], repeat: false, when: any, run: () => { engine.duplicateSelected().catch(() => {}) } })
  // View
  keys.register({ id: 'view.fit', group: 'View', label: 'Fit the photo', keys: ['f', '0'], when: open, run: () => engine.fitView() })
  keys.register({ id: 'view.zoom-in', group: 'View', label: 'Zoom in', keys: ['=', 'shift+=', '+'], display: ['shift+='], when: open, run: () => engine.zoomBy(1.25) })
  keys.register({ id: 'view.zoom-out', group: 'View', label: 'Zoom out', keys: ['-', 'shift+-'], display: ['-'], when: open, run: () => engine.zoomBy(0.8) })
  keys.describe({ id: 'view.wheel', group: 'View', label: 'Zoom at the pointer', keys: ['scroll'] })
  keys.describe({ id: 'view.pan', group: 'View', label: 'Pan when zoomed in (or middle-drag)', keys: ['drag'] })
}
