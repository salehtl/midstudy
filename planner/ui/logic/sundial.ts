// The light direction dial's maths (ui/sun-dial.ts, contract §4.8): azimuth and elevation to a spot on the dial and
// back from a pointer, the keys, and the words for where the light comes from. The dial is seen from above: the centre
// is overhead (90°), the rim 5° above the horizon, the top ahead (−Z), the right +X. Pure, TScert-checked; sin, cos and
// atan2 come in from the shell (Math's), so each result is v1's bit for bit.

const PI = 3.141592653589793 // Math.PI
export const DIAL_R = 100 // the disk's radius in viewBox units
export const DIAL_HALF = 112 // the viewBox is ±112, so the handle and the camera fit
const MIN_EL = 5
const MAX_EL = 90

/** sin, cos and atan2: the shell passes Math. */
export interface Trig {
  sin(x: number): number
  cos(x: number): number
  atan2(y: number, x: number): number
}

// Where the light comes from, in words (seen from the camera): 45° sectors.
const SIDES = ['ahead', 'ahead on the right', 'the right', 'behind on the right', 'behind the camera', 'behind on the left', 'the left', 'ahead on the left'] as const

export function clampEl(e: number): number {
  return Math.min(MAX_EL, Math.max(MIN_EL, e))
}

/** An azimuth in (−180, 180]. */
export function wrapAz(a: number): number {
  const w = ((((a + 180) % 360) + 360) % 360) - 180
  return w === -180 ? 180 : w
}

/** One decimal (what the dial reports and draws). */
export function r1(v: number): number {
  return Math.round(v * 10) / 10
}

/** "the left", "ahead on the right", … */
function lightSide(az: number): string {
  return SIDES[Math.round(((wrapAz(az) + 360) % 360) / 45) % 8] ?? ''
}

/** "the left · 35° up", or "overhead" from 82° up. */
export function lightWords(az: number, el: number): string {
  if (el >= 82) return 'overhead'
  return `${lightSide(az)} · ${String(Math.round(el))}° up`
}

/** The dial's aria-valuetext. */
export function lightValueText(az: number, el: number): string {
  return el >= 82 ? 'Light from overhead' : `Light from ${lightSide(az)}, ${String(Math.round(el))}° up`
}

/** The radius (viewBox units) of an elevation's ring. */
export function ringRadius(el: number): number {
  return ((MAX_EL - el) / (MAX_EL - MIN_EL)) * DIAL_R
}

/** The sun's spot in viewBox units: x = sin(az)·r, y = −cos(az)·r, r = (90 − el)/85 of the radius. */
export function spot(az: number, el: number, trig: Trig): readonly [number, number] {
  const r = ringRadius(clampEl(el))
  const a = (az * PI) / 180
  return [trig.sin(a) * r, -trig.cos(a) * r]
}

/** A viewBox coordinate as a percentage of the dial's box (the grip's left and top). */
export function boxPercent(v: number): number {
  return r1(((v + DIAL_HALF) / (2 * DIAL_HALF)) * 100)
}

/** The sun's eight rays as one path. */
export function sunRays(trig: Trig): string {
  let d = ''
  for (let i = 0; i < 8; i++) {
    const a = (i * PI) / 4
    d += `M${String(r1(trig.sin(a) * 13.5))} ${String(r1(-trig.cos(a) * 13.5))}L${String(r1(trig.sin(a) * 18))} ${String(r1(-trig.cos(a) * 18))}`
  }
  return d
}

/** The light under a pointer. dx, dy: the pointer from the dial's centre in CSS px; width: the dial's width in CSS px.
 *  Within 3 % of the centre the azimuth stays as it was. */
export interface AzEl {
  readonly az: number
  readonly el: number
}
export function fromPointer(dx: number, dy: number, width: number, az: number, trig: Trig, hypot: (x: number, y: number) => number): AzEl {
  const k = (2 * DIAL_HALF) / width / DIAL_R // CSS px → disk radii
  const x = dx * k
  const y = dy * k
  const d = Math.min(1, hypot(x, y))
  return {
    az: d > 0.03 ? wrapAz((trig.atan2(x, -y) * 180) / PI) : az,
    el: clampEl(MAX_EL - d * (MAX_EL - MIN_EL)),
  }
}

/** A key on the dial: ←/→ azimuth ∓/±5° (Shift 15°), ↑/↓ elevation ±5° (Shift 15°), Page Up/Down elevation ±15°,
 *  Home overhead, End low. null: not the dial's key. */
export function dialKey(key: string, shift: boolean, az: number, el: number): AzEl | null {
  const step = shift ? 15 : 5
  if (key === 'ArrowLeft') return { az: wrapAz(az - step), el }
  if (key === 'ArrowRight') return { az: wrapAz(az + step), el }
  if (key === 'ArrowUp') return { az, el: clampEl(el + step) }
  if (key === 'ArrowDown') return { az, el: clampEl(el - step) }
  if (key === 'PageUp') return { az, el: clampEl(el + 15) }
  if (key === 'PageDown') return { az, el: clampEl(el - 15) }
  if (key === 'Home') return { az, el: MAX_EL }
  if (key === 'End') return { az, el: MIN_EL }
  return null
}

/** A touch that started on the dial but not on the sun: wait (under 8 px), a sideways drag of the light, or a scroll of
 *  the sheet (up or down). */
export type TouchIntent = 'wait' | 'drag' | 'scroll'
export function touchIntent(dx: number, dy: number, hypot: (x: number, y: number) => number): TouchIntent {
  if (hypot(dx, dy) < 8) return 'wait'
  return Math.abs(dx) > Math.abs(dy) ? 'drag' : 'scroll'
}
