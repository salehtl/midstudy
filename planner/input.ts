// midstudy planner input: pointer (mouse, pen, touch), wheel and keyboard handling on top of the engine API (engine.ts).
// installInput(engine) → { enabled: { pointer, keyboard }, setKeyFilter(fn), dispose() }
//   enabled.pointer / enabled.keyboard   set false to switch these handlers off
//   setKeyFilter(fn)                     fn(keydownEvent) → true to swallow the key (e.g. while a dialog is open)
// The camera never moves (contract §4.5): zoom and pan are 2D, inside the photo.
// Pointer, one gesture at a time: a drag that starts on the selected item (its box on screen, plus 16 px on touch), or
// with a mouse or pen on any piece, moves it so the grabbed point stays under the pointer (Shift+drag: up and down,
// §2.10); two fingers pinch-zoom and pan; the middle button (or any drag on the photo once zoomed in) pans. A tap (no
// drag, one finger) selects, deselects or sets a ruler point.
// Wheel / trackpad pinch: zoom at the pointer, 1× to 4×.
// Keys: R / Shift+R rotate 15°, Delete/Backspace remove, Esc deselects or leaves the ruler, PageUp / PageDown raise and
// lower 1 cm (Shift 10 cm), F or 0 fit the photo, + / − zoom.
// What each gesture and key means is planner/logic/input.ts.
import type { Engine, InputHandle } from './engine.js'
import * as decide from './logic/input.js'
import type { GestureKind } from './logic/input.js'

interface Gesture {
  id: number
  kind: GestureKind
  x0: number
  y0: number
  lx: number
  ly: number
  t0: number
  type: string
  moved: boolean
  multi: boolean
}

export function installInput(engine: Engine): InputHandle {
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
  let pinch: { d0: number; z0: number; mx: number; my: number } | null = null
  const mid = (): { x: number; y: number; d: number } => {
    const [a, b] = [...ptrs.values()]
    if (!a || !b) return { x: 0, y: 0, d: 0 }
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) }
  }
  on('pointerdown', (e) => {
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
    const gesture: Gesture = { id: e.pointerId, kind: 'other', x0: e.clientX, y0: e.clientY, lx: e.clientX, ly: e.clientY, t0: performance.now(), type: e.pointerType, moved: false, multi: false }
    g = gesture
    const sel = engine.getSelected()
    const pad = decide.grabPad(e.pointerType)
    const ruler = engine.getRuler().active
    if (e.button === 1) gesture.kind = 'pan'
    else if (sel && !ruler && engine.hitItemAt(sel, e.clientX, e.clientY, pad) && engine.beginItemDrag(sel, e.clientX, e.clientY, { lift: e.shiftKey })) gesture.kind = 'item'
    else if (!ruler && !engine.getAdjustFloor() && e.pointerType !== 'touch') {
      // Mouse and pen: press on any piece and drag it straight away (it gets selected). Touch keeps "tap, then drag",
      // so a finger on the photo can still pan a zoomed view without moving furniture by accident.
      const hit = engine.itemAt(e.clientX, e.clientY)
      if (hit && engine.beginItemDrag(hit, e.clientX, e.clientY, { lift: e.shiftKey })) gesture.kind = 'item'
    }
    canvas.setPointerCapture(e.pointerId)
  }, true)
  on('pointermove', (e) => {
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
    if (g?.id !== e.pointerId) return
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > decide.tapSlop(g.type)) g.moved = true
    if (g.kind === 'item') engine.dragTo(e.clientX, e.clientY)
    else if (decide.pans(g.moved, g.multi, g.kind, engine.getView().zoom)) {
      g.kind = 'pan'
      engine.panBy(e.clientX - g.lx, e.clientY - g.ly)
    }
    g.lx = e.clientX
    g.ly = e.clientY
  }, true)
  const up = (e: PointerEvent): void => {
    if (!ptrs.delete(e.pointerId)) return
    if (ptrs.size < 2) pinch = null
    if (!g || ptrs.size) return
    const d = g
    g = null
    if (d.kind === 'item') engine.endItemDrag()
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
    const k = e.key.toLowerCase()
    if (k === 'shift') engine.setSnap(true)
    if (keyFilter?.(e)) return
    const field = typing(e)
    if (field) {
      if (e.key === 'Escape') field.blur()
      return
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return
    const selected = engine.getSelected()
    const c = decide.keyCommand(k, e.shiftKey)
    switch (c.kind) {
      case 'escape':
        if (engine.getRuler().active) engine.setRulerActive(false)
        else engine.select(null)
        break
      case 'remove':
        if (selected) { e.preventDefault(); engine.removeItemInternal(selected) }
        break
      case 'rotate':
        engine.rotateSelected(c.deg)
        break
      case 'nudge':
        if (selected) { e.preventDefault(); engine.nudgeElevation(selected, c.dy) }
        break
      case 'fit':
        engine.fitView()
        break
      case 'zoom':
        engine.zoomBy(c.factor)
        break
      case 'none':
        break
    }
  })
  on('keyup', (e) => { if (e.key.toLowerCase() === 'shift') engine.setSnap(false) })
  on('blur', () => { engine.setSnap(false) })

  return {
    enabled,
    setKeyFilter: (fn) => { keyFilter = typeof fn === 'function' ? fn : null },
    dispose: () => { for (const f of off.splice(0)) f() },
  }
}
