// The shell's sizes and places (ui/shell.ts): phone or desktop, the phone sheet's detents and where a drag or a fling
// settles, the chrome's metrics, the dock's split under More, toasts' lifetimes, and where a menu or a tooltip goes.
// Pure, TScert-checked.

export type Mode = 'phone' | 'desktop'
export type Detent = 'peek' | 'half' | 'full'
export type ToastKind = 'info' | 'ok' | 'error'

const PEEK = 176 // the Paper detents at 390 × 844 (usable height 696)
const HALF = 422
const FULL = 696

/** Phone at 760 px wide or less, or with a coarse pointer. */
export function modeFor(width: number, coarse: boolean): Mode {
  return width <= 760 || coarse ? 'phone' : 'desktop'
}

export function isDetent(v: string | null | undefined): v is Detent {
  return v === 'peek' || v === 'half' || v === 'full'
}

/** The window's height less the safe areas, at least 240 px. */
export function usableHeight(height: number, safeTop: number, safeBottom: number): number {
  return Math.max(240, height - safeTop - safeBottom)
}

/** A detent's height (without the bottom safe area), scaled from the Paper detents to the usable height. */
export function detentPx(d: Detent, usable: number): number {
  const half = Math.round((usable * HALF) / FULL)
  if (d === 'full') return usable
  if (d === 'half') return Math.min(half, usable)
  return Math.min(PEEK, half)
}

/** A tap on the grabber grows the sheet: peek → half → full → half. */
export function tapDetent(d: Detent | null): Detent {
  return d === 'peek' ? 'half' : d === 'half' ? 'full' : 'half'
}

/** The sheet's height while the finger drags it: the start height less the drag, kept within 0 and the usable height. */
export function dragSheetHeight(h0: number, dy: number, usable: number): number {
  return Math.max(0, Math.min(usable, h0 - dy))
}

/** Where a released drag settles: the nearest detent to where a fling carries it (up to about 360 px), or null (close)
 *  when that is below 55 % of the peek height. v is the last speed in px/ms (positive downwards). */
export function settleDetent(height: number, v: number, usable: number): Detent | null {
  const projected = height - Math.max(-2, Math.min(2, v)) * 180
  if (projected < detentPx('peek', usable) * 0.55) return null
  // v1's reduce over peek, half, full: a later detent wins only when strictly nearer
  const toPeek = Math.abs(detentPx('peek', usable) - projected)
  const toHalf = Math.abs(detentPx('half', usable) - projected)
  const toFull = Math.abs(detentPx('full', usable) - projected)
  const nearer = toHalf < toPeek ? toHalf : toPeek
  if (toFull < nearer) return 'full'
  return toHalf < toPeek ? 'half' : 'peek'
}

/** The chrome's sizes the CSS and the stage read: the phone sheet's height, the chrome along the bottom and the left. */
export interface ChromeMetrics {
  readonly sheetH: number
  readonly chromeBottom: number
  readonly chromeLeft: number
}
export function chromeMetrics(mode: Mode, detent: Detent | null, usable: number, safeBottom: number, hasPanels: boolean, collapsed: boolean): ChromeMetrics {
  if (mode === 'phone') {
    const sheetH = detent ? detentPx(detent, usable) + safeBottom : 0
    return { sheetH, chromeBottom: detent ? sheetH : safeBottom + 8 + 64, chromeLeft: 0 }
  }
  return { sheetH: 0, chromeBottom: 0, chromeLeft: hasPanels ? (collapsed ? 56 : 320) : 0 }
}

/** The phone dock: up to five panels, else the first four and the rest under More. */
export interface DockSplit<T> {
  readonly main: readonly T[]
  readonly rest: readonly T[]
}
export function dockSplit<T>(list: readonly T[]): DockSplit<T> {
  const main = list.length <= 5 ? list : list.slice(0, 4)
  return { main, rest: list.slice(main.length) }
}

/** How long a toast stays (0: until closed): errors stay, info and ok leave after 4 s, 8 s with an action. */
export function toastLife(kind: ToastKind, hasAction: boolean, ms: number | undefined): number {
  return ms ?? (kind === 'error' ? 0 : hasAction ? 8000 : 4000)
}

/** A toast's icon: the one given, else by kind. */
export function toastIcon(kind: ToastKind, given: string | undefined): string {
  return (given ?? '') || (kind === 'ok' ? 'check' : kind === 'error' ? 'warning' : 'info')
}

/** On the phone a new toast closes the others, except an error, which only a new error closes. */
export function phoneToastCloses(other: ToastKind, incoming: ToastKind): boolean {
  return other !== 'error' || incoming === 'error'
}

/** A client rectangle (a DOMRect's edges and size). */
export interface Edges {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
  readonly width: number
  readonly height: number
}
export interface Spot {
  readonly x: number
  readonly y: number
}

/** A menu under its anchor (aligned to its end or start), or above it when asked or when it would not fit below; kept
 *  8 px inside the window. */
export function menuSpot(r: Edges, w: number, h: number, viewW: number, viewH: number, alignEnd: boolean, above: boolean): Spot {
  const x0 = alignEnd ? r.right - w : r.left
  const x = Math.max(8, Math.min(viewW - w - 8, x0))
  const y = above || r.bottom + 4 + h > viewH - 8 ? r.top - 4 - h : r.bottom + 4
  return { x, y: Math.max(8, y) }
}

/** A tooltip centred under its element (above when there is no room below), 6 px inside the window; for the side
 *  rail's tabs, to the right of the tab instead. */
export function tipSpot(r: Edges, w: number, h: number, viewW: number, viewH: number, rail: boolean): Spot {
  if (rail) return { x: r.right + 6, y: r.top + r.height / 2 - h / 2 }
  const below = r.bottom + 6 + h < viewH
  return {
    x: Math.max(6, Math.min(viewW - w - 6, r.left + r.width / 2 - w / 2)),
    y: below ? r.bottom + 6 : r.top - 6 - h,
  }
}

/** Whether an element moved more than 2 px from where its tooltip was placed. */
export function movedAway(left: number, top: number, x: number, y: number): boolean {
  return Math.abs(left - x) > 2 || Math.abs(top - y) > 2
}

/** The phone keyboard's height over the layout viewport (0 without a visual viewport). */
export function keyboardInset(innerHeight: number, vvHeight: number | null, vvOffsetTop: number): number {
  return vvHeight === null ? 0 : Math.max(0, innerHeight - vvHeight - vvOffsetTop)
}
