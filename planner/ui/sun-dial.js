// The light direction control of Scene › Look (contract §4.8, handle `light-dir`): a round dial seen from above.
// The centre is straight overhead (90°), the rim 5° above the horizon; the top of the dial is ahead (into the photo,
// −Z), the right is +X and the bottom is the camera's side (a small camera mark there looks up into the room). The sun
// handle sits at x = sin(az)·r, y = −cos(az)·r with r = (90 − el)/85 of the radius. Pressing anywhere on the dial and
// dragging sets azimuth and elevation from the pointer (mouse, pen or touch; touch-action: none, so a drag on the
// phone doesn't scroll the sheet), reported at most once per animation frame. Keyboard: ←/→ azimuth ∓/±5°, ↑/↓
// elevation ±5° (Shift: 15°). The inferred light can show as a faint dashed marker. Styles: styles/scenes.css (.sd-*).
//   sunDial({ onChange({ az, el }) }) → wrap element; wrap.dial (the focusable control), wrap.set({ az, el, inferred })
//   lightWords(az, el) → "the left · 35° up" style words, lightSide(az) → "the left"
import { h } from './kit.js'

const NS = 'http://www.w3.org/2000/svg'
const R = 100              // the disk's radius in viewBox units (the box is ±112 so the handle and camera fit)
const HALF = 112
const MIN_EL = 5, MAX_EL = 90
const svg = (tag, attrs = {}) => {
  const el = document.createElementNS(NS, tag)
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v))
  return el
}
const rad = (d) => (d * Math.PI) / 180
const deg = (r) => (r * 180) / Math.PI
const clampEl = (e) => Math.min(MAX_EL, Math.max(MIN_EL, e))
export const wrapAz = (a) => { const w = ((((a + 180) % 360) + 360) % 360) - 180; return w === -180 ? 180 : w }
const r1 = (v) => Math.round(v * 10) / 10

// Where the light comes from, in words (seen from the camera): 45° sectors.
const SIDES = ['ahead', 'ahead on the right', 'the right', 'behind on the right', 'behind the camera', 'behind on the left', 'the left', 'ahead on the left']
export function lightSide(az) { return SIDES[Math.round((((wrapAz(az) + 360) % 360)) / 45) % 8] }
export function lightWords(az, el) {
  if (el >= 82) return 'overhead'
  return `${lightSide(az)} · ${Math.round(el)}° up`
}

// The handle's position in viewBox units.
function spot(az, el) {
  const r = ((MAX_EL - clampEl(el)) / (MAX_EL - MIN_EL)) * R
  return [Math.sin(rad(az)) * r, -Math.cos(rad(az)) * r]
}

let uid = 0
export function sunDial({ onChange, label = 'Light direction' } = {}) {
  const id = `sd-${++uid}`
  const s = svg('svg', { viewBox: `${-HALF} ${-HALF} ${2 * HALF} ${2 * HALF}`, 'aria-hidden': 'true', focusable: 'false' })
  const defs = svg('defs')
  const grad = svg('radialGradient', { id: `${id}-sky`, cx: 0, cy: 0, r: R, gradientUnits: 'userSpaceOnUse' })
  grad.append(svg('stop', { offset: 0, class: 'sd-sky-0' }), svg('stop', { offset: 1, class: 'sd-sky-1' }))
  const clip = svg('clipPath', { id: `${id}-clip` })
  clip.append(svg('circle', { cx: 0, cy: 0, r: R }))
  defs.append(grad, clip)
  const disk = svg('circle', { class: 'sd-disk', cx: 0, cy: 0, r: R })
  const sky = svg('circle', { class: 'sd-sky', cx: 0, cy: 0, r: R, fill: `url(#${id}-sky)` })
  // the photo's view: a faint wedge from the camera into the room, under everything else
  const cone = svg('path', { class: 'sd-cone', d: `M0 ${R}L-46 4Q0 -14 46 4Z`, 'clip-path': `url(#${id}-clip)` })
  const rings = [30, 60].map((e) => svg('circle', { class: 'sd-ring', cx: 0, cy: 0, r: ((MAX_EL - e) / (MAX_EL - MIN_EL)) * R }))
  const axes = svg('path', { class: 'sd-axis', d: `M0 ${-R}V${R}M${-R} 0H${R}` })
  const zenith = svg('circle', { class: 'sd-zenith', cx: 0, cy: 0, r: 2.5 })
  // the camera, at the bottom rim, looking up (into the photo)
  const cam = svg('g', { class: 'sd-cam', transform: `translate(0 ${R + 1})` })
  cam.append(svg('path', { d: 'M-6 -3L6 -3L9.5 -11L-9.5 -11Z' }), svg('rect', { x: -10.5, y: -3, width: 21, height: 13, rx: 3 }))
  const inferred = svg('circle', { class: 'sd-inf', cx: 0, cy: 0, r: 9 })
  const ray = svg('line', { class: 'sd-ray', x1: 0, y1: 0, x2: 0, y2: 0 })
  const sun = svg('g', { class: 'sd-sun' })
  const rays = svg('path', {
    class: 'sd-sun-rays',
    d: Array.from({ length: 8 }, (_, i) => { const a = (i * Math.PI) / 4; return `M${r1(Math.sin(a) * 13.5)} ${r1(-Math.cos(a) * 13.5)}L${r1(Math.sin(a) * 18)} ${r1(-Math.cos(a) * 18)}` }).join(''),
  })
  sun.append(svg('circle', { class: 'sd-sun-halo', cx: 0, cy: 0, r: 22 }), rays, svg('circle', { class: 'sd-sun-core', cx: 0, cy: 0, r: 9 }))
  s.append(defs, disk, sky, cone, ...rings, axes, zenith, cam, inferred, ray, sun)

  const dial = h('div.sd', { tabindex: 0, role: 'slider', 'aria-label': label, 'aria-valuemin': -180, 'aria-valuemax': 180, dataset: { midstudy: 'light-dir', tip: 'Drag the sun to move the light' } }, s)
  const readout = h('p.sd-readout.tnum')
  const wrap = h('div.sd-wrap', dial, readout)
  wrap.dial = dial

  let az = 0, el = 45
  let inf = null
  let dragId = null
  let pending = null
  let raf = 0

  function draw() {
    const [x, y] = spot(az, el)
    sun.setAttribute('transform', `translate(${r1(x)} ${r1(y)})`)
    ray.setAttribute('x2', r1(x))
    ray.setAttribute('y2', r1(y))
    const words = lightWords(az, el)
    readout.textContent = `From ${words}`
    dial.setAttribute('aria-valuenow', String(Math.round(az)))
    dial.setAttribute('aria-valuetext', el >= 82 ? 'Light from overhead' : `Light from ${lightSide(az)}, ${Math.round(el)}° up`)
  }
  function drawInferred() {
    inferred.style.display = inf ? '' : 'none'
    if (!inf) return
    const [x, y] = spot(inf.az, inf.el)
    inferred.setAttribute('cx', r1(x))
    inferred.setAttribute('cy', r1(y))
  }
  function emit(now = false) {
    pending = { az: r1(az), el: r1(el) }
    if (now) { flush(); return }
    if (!raf) raf = requestAnimationFrame(flush)
  }
  function flush() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    if (!pending) return
    const p = pending
    pending = null
    onChange?.(p)
  }
  function fromPointer(e) {
    const b = dial.getBoundingClientRect()
    if (!b.width) return
    const k = (2 * HALF) / b.width / R // CSS px → disk radii
    const dx = (e.clientX - (b.left + b.width / 2)) * k
    const dy = (e.clientY - (b.top + b.height / 2)) * k
    const d = Math.min(1, Math.hypot(dx, dy))
    if (d > 0.03) az = wrapAz(deg(Math.atan2(dx, -dy)))
    el = clampEl(MAX_EL - d * (MAX_EL - MIN_EL))
    draw()
    emit()
  }
  function end(e) {
    if (dragId == null || (e && e.pointerId !== dragId)) return
    try { dial.releasePointerCapture?.(dragId) } catch { /* already released */ }
    dragId = null
    dial.classList.remove('is-dragging')
    flush()
  }
  dial.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    e.preventDefault()
    dragId = e.pointerId
    try { dial.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    dial.classList.add('is-dragging')
    dial.focus({ preventScroll: true })
    fromPointer(e)
  })
  dial.addEventListener('pointermove', (e) => { if (e.pointerId === dragId) fromPointer(e) })
  dial.addEventListener('pointerup', (e) => { if (e.pointerId === dragId) { fromPointer(e); end(e) } })
  dial.addEventListener('pointercancel', end)
  dial.addEventListener('lostpointercapture', end)
  dial.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 15 : 5
    if (e.key === 'ArrowLeft') az = wrapAz(az - step)
    else if (e.key === 'ArrowRight') az = wrapAz(az + step)
    else if (e.key === 'ArrowUp') el = clampEl(el + step)
    else if (e.key === 'ArrowDown') el = clampEl(el - step)
    else return
    e.preventDefault()
    draw()
    emit()
  })

  // From the engine (every 'look' event): moves the handle unless it is being dragged (then the pointer leads).
  wrap.set = ({ az: a, el: e, inferred: i = null } = {}) => {
    inf = i && Number.isFinite(i.az) && Number.isFinite(i.el) ? { az: i.az, el: i.el } : null
    drawInferred()
    if (dragId != null || pending) return
    if (Number.isFinite(a)) az = wrapAz(a)
    if (Number.isFinite(e)) el = clampEl(e)
    draw()
  }
  drawInferred()
  draw()
  return wrap
}
