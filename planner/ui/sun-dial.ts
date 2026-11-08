// The light direction control of Scene › Look (contract §4.8, handle `light-dir`): a round dial seen from above.
// The centre is straight overhead (90°), the rim 5° above the horizon; the top of the dial is ahead (into the photo,
// −Z), the right is +X and the bottom is the camera's side (a small camera mark there looks up into the room). The sun
// handle sits at x = sin(az)·r, y = −cos(az)·r with r = (90 − el)/85 of the radius. With a mouse or pen, pressing
// anywhere on the dial and dragging sets azimuth and elevation from the pointer. By touch the dial sits in a scrolling
// sheet, so a vertical swipe across it scrolls the sheet (touch-action: pan-y) and changes nothing; the sun itself (a
// 48 px grip, touch-action: none) drags in any direction, and a sideways drag or a tap elsewhere on the dial moves the
// light there. Reported at most once per animation frame. Keyboard: ←/→ azimuth ∓/±5°, ↑/↓ elevation ±5° (Shift:
// 15°), Page Up/Down elevation ±15°, Home overhead, End low. The inferred light can show as a faint dashed marker.
// Styles: styles/scenes.css (.sd-*). The maths: logic/sundial.ts.
//   sunDial({ onChange({ az, el }) }) → wrap element; wrap.dial (the focusable control), wrap.set({ az, el, inferred })
import { h } from './kit.js'
import { boxPercent, dialKey, DIAL_HALF, DIAL_R, fromPointer, lightValueText, lightWords, r1, ringRadius, spot, sunRays, touchIntent, type AzEl, type DialMath } from './logic/sundial.js'
import { clampLook, wrapDeg } from './seam.js'

/** The dial's maths: Math's trigonometry, the kernels' azimuth wrap and the Look's elevation range. */
const M: DialMath = {
  sin: (x) => Math.sin(x), cos: (x) => Math.cos(x), atan2: (y, x) => Math.atan2(y, x),
  wrapDeg, clampEl: (e) => clampLook('light_elevation_deg', e) ?? e,
}

const NS = 'http://www.w3.org/2000/svg'
function svg(tag: string, attrs: Readonly<Record<string, string | number>> = {}): SVGElement {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}

interface DialState {
  readonly az?: number
  readonly el?: number
  readonly inferred?: AzEl | null
}
export type SunDial = HTMLDivElement & { readonly dial: HTMLDivElement; readonly set: (s?: DialState) => void }

let uid = 0
export function sunDial({ onChange, label = 'Light direction' }: { readonly onChange?: (v: AzEl) => void; readonly label?: string } = {}): SunDial {
  const id = `sd-${String(++uid)}`
  const s = svg('svg', { viewBox: `${String(-DIAL_HALF)} ${String(-DIAL_HALF)} ${String(2 * DIAL_HALF)} ${String(2 * DIAL_HALF)}`, 'aria-hidden': 'true', focusable: 'false' })
  const defs = svg('defs')
  const grad = svg('radialGradient', { id: `${id}-sky`, cx: 0, cy: 0, r: DIAL_R, gradientUnits: 'userSpaceOnUse' })
  grad.append(svg('stop', { offset: 0, class: 'sd-sky-0' }), svg('stop', { offset: 1, class: 'sd-sky-1' }))
  const clip = svg('clipPath', { id: `${id}-clip` })
  clip.append(svg('circle', { cx: 0, cy: 0, r: DIAL_R }))
  defs.append(grad, clip)
  const disk = svg('circle', { class: 'sd-disk', cx: 0, cy: 0, r: DIAL_R })
  const sky = svg('circle', { class: 'sd-sky', cx: 0, cy: 0, r: DIAL_R, fill: `url(#${id}-sky)` })
  // the photo's view: a faint wedge from the camera into the room, under everything else
  const cone = svg('path', { class: 'sd-cone', d: `M0 ${String(DIAL_R)}L-46 4Q0 -14 46 4Z`, 'clip-path': `url(#${id}-clip)` })
  const rings = [30, 60].map((e) => svg('circle', { class: 'sd-ring', cx: 0, cy: 0, r: ringRadius(e) }))
  const axes = svg('path', { class: 'sd-axis', d: `M0 ${String(-DIAL_R)}V${String(DIAL_R)}M${String(-DIAL_R)} 0H${String(DIAL_R)}` })
  const zenith = svg('circle', { class: 'sd-zenith', cx: 0, cy: 0, r: 2.5 })
  // the camera, at the bottom rim, looking up (into the photo)
  const cam = svg('g', { class: 'sd-cam', transform: `translate(0 ${String(DIAL_R + 1)})` })
  cam.append(svg('path', { d: 'M-6 -3L6 -3L9.5 -11L-9.5 -11Z' }), svg('rect', { x: -10.5, y: -3, width: 21, height: 13, rx: 3 }))
  const inferred = svg('circle', { class: 'sd-inf', cx: 0, cy: 0, r: 9 })
  const ray = svg('line', { class: 'sd-ray', x1: 0, y1: 0, x2: 0, y2: 0 })
  const sun = svg('g', { class: 'sd-sun' })
  const rays = svg('path', { class: 'sd-sun-rays', d: sunRays(Math) })
  sun.append(svg('circle', { class: 'sd-sun-halo', cx: 0, cy: 0, r: 22 }), rays, svg('circle', { class: 'sd-sun-core', cx: 0, cy: 0, r: 9 }))
  s.append(defs, disk, sky, cone, ...rings, axes, zenith, cam, inferred, ray, sun)

  const grip = h('div.sd-grip', { 'aria-hidden': 'true' })
  const dial = h('div.sd', { tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': -180, 'aria-valuemax': 180, title: 'Drag the sun to move the light', dataset: { midstudy: 'light-dir' } }, s, grip)
  const readout = h('p.sd-readout.tnum')
  const wrap = h('div.sd-wrap', dial, readout)

  let az = 0
  let el = 45
  let inf: AzEl | null = null
  let dragId: number | null = null
  let touch: { readonly id: number; readonly x: number; readonly y: number } | null = null // a touch that started on the dial but not on the sun, until it shows what it is
  let pending: AzEl | null = null
  let raf = 0

  function draw(): void {
    const [x, y] = spot(az, el, M)
    sun.setAttribute('transform', `translate(${String(r1(x))} ${String(r1(y))})`)
    grip.style.left = `${String(boxPercent(x))}%`
    grip.style.top = `${String(boxPercent(y))}%`
    ray.setAttribute('x2', String(r1(x)))
    ray.setAttribute('y2', String(r1(y)))
    readout.textContent = `From ${lightWords(az, el, M)}`
    dial.setAttribute('aria-valuenow', String(Math.round(az)))
    dial.setAttribute('aria-valuetext', lightValueText(az, el, M))
  }
  function drawInferred(): void {
    inferred.style.display = inf ? '' : 'none'
    if (!inf) return
    const [x, y] = spot(inf.az, inf.el, M)
    inferred.setAttribute('cx', String(r1(x)))
    inferred.setAttribute('cy', String(r1(y)))
  }
  function emit(): void {
    pending = { az: r1(az), el: r1(el) }
    if (!raf) raf = requestAnimationFrame(flush)
  }
  function flush(): void {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    if (!pending) return
    const p = pending
    pending = null
    onChange?.(p)
  }
  function moveTo(e: PointerEvent): void {
    const b = dial.getBoundingClientRect()
    if (!b.width) return
    const next = fromPointer(e.clientX - (b.left + b.width / 2), e.clientY - (b.top + b.height / 2), b.width, az, M, Math.hypot)
    az = next.az
    el = next.el
    draw()
    emit()
  }
  function end(e?: PointerEvent): void {
    if (dragId === null || (e && e.pointerId !== dragId)) return
    try { dial.releasePointerCapture(dragId) } catch { /* already released */ }
    dragId = null
    dial.classList.remove('is-dragging')
    flush()
  }
  function start(e: PointerEvent): void {
    if (dragId !== null) return // the first pointer keeps the drag
    dragId = e.pointerId
    try { dial.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    dial.classList.add('is-dragging')
    dial.focus({ preventScroll: true })
    moveTo(e)
  }
  dial.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    if (e.pointerType === 'touch' && dragId !== null) return
    if (e.pointerType === 'touch' && !(e.target instanceof Node && grip.contains(e.target))) { touch = { id: e.pointerId, x: e.clientX, y: e.clientY }; return }
    e.preventDefault()
    start(e)
  })
  dial.addEventListener('pointermove', (e) => {
    if (touch?.id === e.pointerId) {
      const intent = touchIntent(e.clientX - touch.x, e.clientY - touch.y, Math.hypot)
      if (intent === 'wait') return
      touch = null
      if (intent === 'drag') start(e) // sideways: a drag of the light; up or down: the sheet scrolls
      return
    }
    if (e.pointerId === dragId) moveTo(e)
  })
  dial.addEventListener('pointerup', (e) => {
    if (touch?.id === e.pointerId) { touch = null; moveTo(e); flush(); return } // a tap: the light goes there
    if (e.pointerId === dragId) { moveTo(e); end(e) }
  })
  dial.addEventListener('pointercancel', (e) => { if (touch?.id === e.pointerId) touch = null; end(e) })
  dial.addEventListener('lostpointercapture', (e) => { end(e) })
  dial.addEventListener('keydown', (e) => {
    const next = dialKey(e.key, e.shiftKey, az, el, M)
    if (!next) return
    az = next.az
    el = next.el
    e.preventDefault()
    draw()
    emit()
  })

  // From the engine (every 'look' event): moves the handle unless it is being dragged (then the pointer leads).
  const set = ({ az: a, el: e, inferred: i = null }: DialState = {}): void => {
    inf = i && Number.isFinite(i.az) && Number.isFinite(i.el) ? { az: i.az, el: i.el } : null
    drawInferred()
    if (dragId !== null || pending) return
    if (a !== undefined && Number.isFinite(a)) az = M.wrapDeg(a)
    if (e !== undefined && Number.isFinite(e)) el = M.clampEl(e)
    draw()
  }
  drawInferred()
  draw()
  return Object.assign(wrap, { dial, set })
}
