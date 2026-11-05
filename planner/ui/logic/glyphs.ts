// The icons' numbers (ui/icons.ts, panels/common.ts): a stroke that keeps the 1.5 px look at small sizes, and the
// progress ring's arc. Pure, TScert-checked; sin and cos come from the shell.

const PI = 3.141592653589793 // Math.PI

/** Three decimals (an SVG attribute's number). */
export function round3(v: number): number {
  return Math.round(v * 1000) / 1000
}

/** Small icons are drawn heavier so they keep the 1.5 px look (the kit uses 1.875 at 16 px, 2 at 14 px). */
export function strokeWidth(size: number, stroke: number): number {
  return round3(size >= 20 ? stroke : Math.min(2.2, (stroke * 20) / size))
}

/** The ring's arc on its 16 px grid, from 12 o'clock: its end point and whether it is the large arc. No progress (null
 *  or not a number) draws a quarter that spins; otherwise it is kept within 2 % and 99.9 %. */
export interface RingArc {
  readonly x: number
  readonly y: number
  readonly large: boolean
}
export function ringArc(progress: number | null, sin: (x: number) => number, cos: (x: number) => number): RingArc {
  const p = progress === null || !Number.isFinite(progress) ? 0.25 : Math.max(0.02, Math.min(0.999, progress))
  const a = p * 2 * PI
  return { x: round3(8 + 6 * sin(a)), y: round3(8 - 6 * cos(a)), large: p > 0.5 }
}
