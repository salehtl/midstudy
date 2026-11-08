// midstudy planner input: pointer (mouse, pen, touch), wheel and keyboard handling on top of the engine API (engine.ts).
// installInput(engine, keys) → { enabled: { pointer, keyboard }, setKeyFilter(fn), dispose() }
//   keys                                 the keymap (keymap.ts): the engine's own shortcuts register into it here, the
//                                        UI's in their modules; one keydown listener here dispatches them all
//   enabled.pointer / enabled.keyboard   set false to switch these handlers off
//   setKeyFilter(fn)                     fn(keydownEvent) → true to swallow the key (e.g. while a dialog is open)
// The camera never moves (contract §4.5): zoom and pan are 2D, inside the photo.
// Pointer, one gesture at a time: a drag that starts on the selected item (its box on screen, plus 16 px on touch), or
// with a mouse or pen on any piece, moves it so the grabbed point stays under the pointer (Shift+drag: up and down,
// §2.10); a drag on a piece of a multi-selection moves the whole selection. Shift+click on a piece adds it to the
// selection or takes it out (Shift+click on the photo keeps the selection); two fingers pinch-zoom and pan; the middle button (or any drag on the photo once zoomed in) pans. A tap (no
// drag, one finger) selects, deselects or sets a ruler point. The canvas only drives a drag it began: a finger pressed
// while the rotate grip holds a drag does nothing, and one whose drag was taken over stops. A pinch is one pair of
// fingers; when one of them lifts it goes on with the next pair, or the finger left over pans a zoomed view.
// Wheel / trackpad pinch: zoom at the pointer, 1× to 4×.
// Keys (registered in the keymap, listed in the Shortcuts sheet): ⌘A select all, Esc deselects or leaves the ruler,
// arrows move the selection 1 cm on the floor (Shift 10 cm; ↑ away from the camera), R / Shift+R rotate 15°,
// PageUp / PageDown raise and lower 1 cm (Shift 10 cm), ⌘D duplicates, F or 0 fit the photo, + / − zoom. Delete and
// ⌘Z (with their Undo toast) are the workspace's (ui/workspace.ts).
// What each gesture and key means is planner/logic/input.ts.
import type { Engine, InputHandle } from './engine.js'
import * as decide from './logic/input.js'
import type { GestureKind } from './logic/input.js'
import { arrowStep } from './logic/keymap.js'
import type { Keymap } from './keymap.js'

interface Gesture {
  id: number
  kind: GestureKind | 'shift'
  /** Shift on a piece: a click toggles it in the selection, a drag lifts it (decided once the pointer moves) */
  hit: string | null
  x0: number
  y0: number
  lx: number
  ly: number
  t0: number
  type: string
  moved: boolean
  multi: boolean
  /** the drag this gesture began; the canvas drives or ends the engine's drag only while it is still this one */
  drag: { uid: string; mode: string } | null
  /** the finger left over from a pinch: pans a zoomed view, never taps */
  residual: boolean
  /** the scene it was pressed on: a release on another scene does nothing */
  scene: string | null
}

export function installInput(engine: Engine, keys: Keymap): InputHandle {
  const canvas = engine.canvas
  const enabled = { pointer: true, keyboard: true }
  let keyFilter: ((e: KeyboardEvent) => unknown) | null = null
  const off: (() => void)[] = []
  function on<K extends keyof WindowEventMap>(type: K, fn: (e: WindowEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): void {
    window.addEventListener(type, fn, opts)
    off.push(() => { window.removeEventListener(type, fn, opts) })
  }
  function onCanvas<K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, opts?: boolean | AddEventListenerOptions): void {
    canvas.addEventListener(type, fn, opts)
    off.push(() => { canvas.removeEventListener(type, fn, opts) })
  }

  // --- pointer (capture phase on window: the overlays above the canvas handle their own pointers)
  const ptrs = new Map<number, { x: number; y: number }>()
  let g: Gesture | null = null // the gesture
  let pinch: { a: number; b: number; d0: number; z0: number; mx: number; my: number } | null = null
  const mid = (ids: { a: number; b: number }): { x: number; y: number; d: number } => {
    const a = ptrs.get(ids.a)
    const b = ptrs.get(ids.b)
    if (!a || !b) return { x: 0, y: 0, d: 0 }
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }
  }
  const seedPinch = (ids: { a: number; b: number }): void => {
    const m = mid(ids)
    pinch = { ...ids, d0: Math.max(1, m.d), z0: engine.getView().zoom, mx: m.x, my: m.y }
  }
  const beginDrag = (gesture: Gesture, uid: string, x: number, y: number, lift: boolean): boolean => {
    if (!engine.beginItemDrag(uid, x, y, { lift })) return false
    gesture.kind = 'item'
    gesture.drag = engine.getDrag()
    return true
  }
  /** Someone else's drag now (or none): the gesture lets it be and does nothing more, its release included. */
  const letGo = (gesture: Gesture): void => {
    gesture.kind = 'other'
    gesture.drag = null
    gesture.multi = true
  }
  on('pointerdown', (e) => {
    if (!enabled.pointer || e.target !== canvas || !engine.getSceneName()) return
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 1) return
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (ptrs.size === 2) {
      if (g?.kind === 'item' && decide.sameDrag(g.drag, engine.getDrag())) engine.endItemDrag()
      if (g) { g.multi = true; g.kind = 'pinch'; g.drag = null }
      const [a, b] = [...ptrs.keys()]
      if (a !== undefined && b !== undefined) seedPinch({ a, b })
      return
    }
    if (ptrs.size > 2) return
    e.preventDefault()
    const gesture: Gesture = { id: e.pointerId, kind: 'other', x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), type: e.pointerType, moved: false, multi: false, hit: null, drag: null, residual: false, scene: engine.getSceneName() }
    g = gesture
    const sel = engine.getSelected()
    const pad = decide.grabPad(e.pointerType)
    const ruler = engine.getRuler().active
    if (engine.getDrag()) gesture.multi = true // the rotate grip holds a drag: this finger begins nothing and taps nothing
    else if (e.button === 1) gesture.kind = 'pan'
    else if (e.shiftKey && !ruler && !engine.getAdjustFloor()) {
      gesture.kind = 'shift'
      const onSel = sel && engine.hitItemAt(sel, e.clientX, e.clientY, pad) ? sel : null
      gesture.hit = onSel ?? engine.itemAt(e.clientX, e.clientY)
      if (gesture.hit && !engine.isSelected(gesture.hit)) gesture.hit = engine.itemAt(e.clientX, e.clientY) // the pad only counts for a selected piece
    } else if (sel && !ruler && engine.hitItemAt(sel, e.clientX, e.clientY, pad) && beginDrag(gesture, sel, e.clientX, e.clientY, e.shiftKey)) { /* the item drag has begun */ }
    else if (!ruler && !engine.getAdjustFloor() && e.pointerType !== 'touch') {
      // Mouse and pen: press on any piece and drag it straight away (it gets selected). Touch keeps "tap, then drag",
      // so a finger on the photo can still pan a zoomed view without moving furniture by accident.
      const hit = engine.itemAt(e.clientX, e.clientY)
      if (hit) beginDrag(gesture, hit, e.clientX, e.clientY, e.shiftKey)
    }
    canvas.setPointerCapture(e.pointerId)
  }, true)
  on('pointermove', (e) => {
    if (!ptrs.has(e.pointerId)) return
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pinch && ptrs.size >= 2) {
      const m = mid(pinch)
      engine.zoomAt(m.x, m.y, pinch.z0 * (m.d / pinch.d0))
      engine.panBy(m.x - pinch.mx, m.y - pinch.my)
      pinch.mx = m.x
      pinch.my = m.y
      return
    }
    if (g?.id !== e.pointerId) return
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > decide.tapSlop(g.type)) g.moved = true
    if (g.kind === 'shift' && g.moved) {
      g.kind = 'other'
      if (g.hit && !engine.getDrag() && engine.getSceneName() === g.scene) beginDrag(g, g.hit, g.x0, g.y0, true)
    }
    if (g.kind === 'item' && !decide.sameDrag(g.drag, engine.getDrag())) letGo(g)
    const zoom = engine.getView().zoom
    if (g.kind === 'item') engine.dragTo(e.clientX, e.clientY)
    else if (g.kind !== 'shift' && (g.residual ? decide.residualPans(g.moved, g.kind, zoom) : decide.pans(g.moved, g.multi, g.kind, zoom))) {
      g.kind = 'pan'
      engine.panBy(e.clientX - g.lx, e.clientY - g.ly)
    }
    g.lx = e.clientX
    g.ly = e.clientY
  }, true)
  /** A pinch is down to one finger: the gesture becomes that finger's, moved and multi, so it never taps. */
  const handOff = (): void => {
    const [left] = [...ptrs]
    if (!left || !g) return
    const [id, p] = left
    g = { ...g, id, kind: decide.residualKind(engine.getView().zoom), x0: p.x, y0: p.y, lx: p.x, ly: p.y, moved: true, multi: true, drag: null, residual: true }
  }
  const up = (e: PointerEvent): void => {
    if (!ptrs.delete(e.pointerId)) return
    if (pinch && (e.pointerId === pinch.a || e.pointerId === pinch.b)) {
      const next = decide.nextPinchPair([...ptrs.keys()], e.pointerId)
      pinch = null
      if (next) seedPinch(next)
      else handOff()
    }
    if (!g || ptrs.size) return
    const d = g
    g = null
    if (d.kind === 'item') {
      if (decide.sameDrag(d.drag, engine.getDrag())) engine.endItemDrag()
      else d.multi = true // not ours any more: no tap either
    }
    if (engine.getSceneName() !== d.scene) return // pressed on a scene that has gone: nothing on this one is what was pressed
    if (d.kind === 'shift') { if (e.type === 'pointerup' && d.hit) engine.select(d.hit, { toggle: true }); return }
    if (!decide.isTap(e.type === 'pointerup', d.moved, d.multi, d.type, performance.now() - d.t0, d.kind)) return
    try { engine.tap(e.clientX, e.clientY) } catch (err) { engine.reportError('Tap failed', err) }
  }
  on('pointerup', up, true)
  on('pointercancel', up, true)
  onCanvas('auxclick', (e) => { e.preventDefault() })

  // --- wheel: zoom at the pointer (a trackpad pinch arrives as a wheel with ctrlKey)
  onCanvas('wheel', (e) => {
    if (!enabled.pointer || !engine.getSceneName()) return
    e.preventDefault()
    engine.zoomBy(decide.wheelFactor(e.deltaY, e.deltaMode, e.ctrlKey, Math.exp), e.clientX, e.clientY)
  }, { passive: false })

  // --- keyboard
  const typing = (e: KeyboardEvent): HTMLElement | null => {
    const t = e.target
    return t instanceof HTMLElement && decide.isTypingTarget(t.tagName, t.isContentEditable) ? t : null
  }
  on('keydown', (e) => {
    if (!enabled.keyboard) return
    if (e.key === 'Shift') engine.setSnap(true)
    if (keyFilter?.(e)) return
    const field = typing(e)
    if (field && e.key === 'Escape') { field.blur(); return }
    keys.handle(e)
  })
  registerEngineKeys(engine, keys)
  on('keyup', (e) => { if (e.key.toLowerCase() === 'shift') engine.setSnap(false) })
  on('blur', () => { engine.setSnap(false) })

  return {
    enabled,
    setKeyFilter: (fn) => { keyFilter = typeof fn === 'function' ? fn : null },
    dispose: () => { for (const f of off.splice(0)) f() },
  }
}

// The engine's shortcuts (the keymap's 'Selection', 'Move and turn' and 'View' groups; the UI adds its own).
function registerEngineKeys(engine: Engine, keys: Keymap): void {
  const open = (): boolean => !!engine.getSceneName() && !engine.getSceneLoad().loading
  const any = (): boolean => open() && engine.getSelection().length > 0
  const shiftWord = keys.isMac ? '⇧' : 'Shift'
  const step = (e: KeyboardEvent): number => (e.shiftKey ? 0.1 : 0.01)
  // Selection
  keys.describe({ id: 'select.click', group: 'Selection', label: 'Select a piece', keys: ['click'] })
  keys.describe({ id: 'select.shift', group: 'Selection', label: 'Add a piece to the selection, or take it out', keys: ['shift+click'] })
  keys.register({ id: 'select.all', group: 'Selection', label: 'Select every piece', keys: ['mod+a'], when: () => open() && engine.getItems().length > 0 && !engine.getAdjustFloor(), run: () => { engine.selectAll() } })
  keys.register({ id: 'ruler.leave', group: 'Selection', label: 'Leave the ruler', keys: ['escape'], priority: 20, repeat: false, hidden: true, when: () => engine.getRuler().active, run: () => { engine.setRulerActive(false) } })
  keys.register({ id: 'select.none', group: 'Selection', label: 'Deselect', keys: ['escape'], repeat: false, when: () => engine.getSelection().length > 0, run: () => { engine.select(null) } })
  // Move and turn
  keys.describe({ id: 'item.drag', group: 'Move and turn', label: 'Move on the floor (a selected group moves together)', keys: ['drag'] })
  keys.describe({ id: 'item.lift', group: 'Move and turn', label: 'Raise or lower', keys: ['shift+drag'] })
  const arrows = ['arrowup', 'arrowdown', 'arrowleft', 'arrowright']
  keys.register({
    id: 'item.move', group: 'Move and turn', label: `Move 1 cm on the floor (${shiftWord} 10 cm; ↑ is away from the camera)`,
    keys: arrows.flatMap((k) => [k, `shift+${k}`]), display: ['arrows'], when: any,
    run: (e) => { const a = arrowStep(e.key.toLowerCase()); if (a) engine.nudgeSelected([a[0] * step(e), 0, a[1] * step(e)]) },
  })
  keys.register({ id: 'item.raise', group: 'Move and turn', label: `Raise 1 cm (${shiftWord} 10 cm)`, keys: ['pageup', 'shift+pageup'], display: ['pageup'], when: any, run: (e) => { engine.nudgeSelected([0, step(e), 0]) } })
  keys.register({ id: 'item.lower', group: 'Move and turn', label: `Lower 1 cm (${shiftWord} 10 cm)`, keys: ['pagedown', 'shift+pagedown'], display: ['pagedown'], when: any, run: (e) => { engine.nudgeSelected([0, -step(e), 0]) } })
  keys.register({ id: 'item.rotate', group: 'Move and turn', label: 'Turn 15° (several: as a group)', keys: ['r'], when: any, run: () => { engine.rotateSelected(15) } })
  keys.register({ id: 'item.rotate-back', group: 'Move and turn', label: 'Turn back 15°', keys: ['shift+r'], when: any, run: () => { engine.rotateSelected(-15) } })
  keys.register({ id: 'item.duplicate', group: 'Move and turn', label: 'Duplicate', keys: ['mod+d'], repeat: false, when: any, run: () => { engine.duplicateSelected().catch(() => undefined) } })
  // View
  keys.register({ id: 'view.fit', group: 'View', label: 'Fit the photo', keys: ['f', '0'], when: open, run: () => { engine.fitView() } })
  keys.register({ id: 'view.zoom-in', group: 'View', label: 'Zoom in', keys: ['=', 'shift+=', '+'], display: ['shift+='], when: open, run: () => { engine.zoomBy(1.25) } })
  keys.register({ id: 'view.zoom-out', group: 'View', label: 'Zoom out', keys: ['-', 'shift+-'], display: ['-'], when: open, run: () => { engine.zoomBy(0.8) } })
  keys.describe({ id: 'view.wheel', group: 'View', label: 'Zoom at the pointer', keys: ['scroll'] })
  keys.describe({ id: 'view.pan', group: 'View', label: 'Pan when zoomed in (or middle-drag)', keys: ['drag'] })
}
