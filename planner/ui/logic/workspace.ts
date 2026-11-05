// The workspace's decisions (ui/workspace.ts): the rendering chip, the scene switcher's state, the height field, the
// horizon drag, where the rotate grip, the piece's label and the horizon handle go, the photo's clip and stage, the
// keys it takes, and its sentences. Pure, TScert-checked. Trigonometry comes in as parameters (Math.tan, Math.hypot
// from the shell), so each result is the v1 expression's, bit for bit.

import type { Mode } from './chrome.js'

const PI = 3.141592653589793 // Math.PI
const HORIZON_FINE = 0.12 // ° of tilt per CSS px, at most, when dragging the horizon
const RENDER_ABOUT_S = 25 // seconds a render usually takes

export interface Pt {
  readonly x: number
  readonly y: number
}
export interface Rect {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}
export interface Insets {
  readonly left: number
  readonly top: number
  readonly right: number
  readonly bottom: number
}

/** The rendering chip: its ring's progress and its words, from the seconds since the render started. */
export interface RenderChip {
  readonly progress: number
  readonly text: string
}
export function renderChip(elapsedS: number): RenderChip {
  const left = Math.max(0, RENDER_ABOUT_S - elapsedS)
  return {
    progress: Math.min(0.95, elapsedS / RENDER_ABOUT_S),
    text: left > 3 ? `Rendering… · about ${String(Math.ceil(left / 5) * 5)} s` : 'Rendering…',
  }
}

/** The scene switcher: opening or calibrating, no scene, unsaved changes, a floor to check, or ready. */
type SwitcherState = 'loading' | 'none' | 'unsaved' | 'check' | 'ready'
export interface SwitcherFacts {
  readonly loading: boolean
  readonly calibrating: boolean
  readonly open: boolean
  readonly noScenesYet: boolean
  readonly dirty: boolean
  readonly checkFloor: boolean
}
export interface Switcher {
  readonly state: SwitcherState
  readonly word: string
}
export function switcher(f: SwitcherFacts): Switcher {
  if (f.loading) return { state: 'loading', word: f.calibrating ? 'Calibrating…' : 'Opening…' }
  if (!f.open) return { state: 'none', word: f.noScenesYet ? 'None yet' : '' }
  if (f.dirty) return { state: 'unsaved', word: 'Unsaved' }
  if (f.checkFloor) return { state: 'check', word: 'Check the floor' }
  return { state: 'ready', word: '' }
}
/** The switcher's accessible name: "Living room, Unsaved. Open scenes". */
export function switcherLabel(title: string, word: string): string {
  return `${title}${word ? `, ${word}` : ''}. Open scenes`
}

/** A piece's height above the floor in whole cm (none: 0). */
export function elevCm(y: number | null): number {
  return Math.round(((y ?? 0) || 0) * 100)
}
/** A typed height in cm as meters: rounded to the cm, kept within 0 and the highest a piece may hang. */
export function elevMeters(cm: number, maxM: number): number {
  return Math.min(maxM * 100, Math.max(0, Math.round(cm))) / 100
}
/** A held + or − button: cm per repeat (5 after 14 repeats) and the delay to the next one (50 ms after 8). */
export function repeatCm(n: number): number {
  return n > 14 ? 5 : 1
}
export function repeatDelayMs(n: number): number {
  return n > 8 ? 50 : 100
}

/** The row a horizon drag asks for. The line follows the finger, except on a small photo (the phone at Fit: about
 *  0.4° a pixel), where the tilt moves at most HORIZON_FINE degrees per CSS pixel, so it can be set finely. */
export function horizonDragRow(py0: number, dyClient: number, scale: number, fovDeg: number, rectH: number, tan: (x: number) => number): number {
  const degPerPx = ((360 / PI) * tan((fovDeg * PI) / 360)) / Math.max(1, rectH) // 1 / focal, in ° per CSS px
  const gain = Math.min(1, HORIZON_FINE / degPerPx)
  return py0 + (dyClient / scale) * gain
}

/** The footprint's front-right corner on screen and the unit direction from the footprint's centre to it. */
export interface FrontCorner {
  readonly fr: Pt
  readonly dx: number
  readonly dy: number
}
export function frontCorner(s: readonly Pt[], hypot: (x: number, y: number) => number): FrontCorner | null {
  const fr = s[1]
  if (fr === undefined) return null
  let cx = 0
  let cy = 0
  for (const p of s) {
    cx = cx + p.x / 4
    cy = cy + p.y / 4
  }
  const dx = fr.x - cx
  const dy = fr.y - cy
  const len = hypot(dx, dy) || 1
  return { fr, dx: dx / len, dy: dy / len }
}

/** The rotate grip off the front-right corner, but always on the visible photo and clear of the selection bar and the
 *  phone's lift column, so it can be grabbed when the piece is close to the camera (its corner off the photo).
 *  liftLeft: the lift column's left edge, or null when it is not shown. */
export function gripSpot(f: FrontCorner, vr: Rect, vw: number, vh: number, barTop: number, liftLeft: number | null): Pt {
  const maxX = Math.min(vr.x + vr.w, vw, liftLeft === null ? Infinity : liftLeft - 4) - 46
  const maxY = Math.min(vr.y + vr.h, vh, barTop - 6) - 46
  return {
    x: Math.max(Math.max(vr.x, 0) + 2, Math.min(maxX, f.fr.x + f.dx * 24 - 22)),
    y: Math.max(Math.max(vr.y, 0) + 2, Math.min(maxY, f.fr.y + f.dy * 24 - 22)),
  }
}

/** The piece's label: under its footprint, clear of the grip; above the piece's top when there is no room above the
 *  selection bar; left of the phone's lift column; 8 px inside the window. boxTop is asked only when needed. */
export function labelSpot(s: readonly Pt[], grip: Pt, lw: number, lh: number, barTop: number, vw: number, vh: number, liftLeft: number | null, boxTop: () => number): Pt {
  const lx = Math.min(s[0]?.x ?? 0, s[1]?.x ?? 0)
  let ly = Math.max(...s.map((p) => p.y)) + 10
  if (lx < grip.x + 40 && lx + lw > grip.x + 4 && ly < grip.y + 38) ly = grip.y + 38 // keep the grip clear
  if (ly + lh > barTop - 8) ly = boxTop() - lh - 10 // no room below: above the piece's top instead
  const rightEdge = liftLeft === null ? vw - 8 : Math.min(vw - 8, liftLeft - 8)
  return { x: Math.max(8, Math.min(rightEdge - lw, lx)), y: Math.max(8, Math.min(vh - lh - 8, ly)) }
}

/** "120 cm up" for a raised piece, else "". */
export function upText(y: number): string {
  const up = Math.round(y * 100)
  return up > 0 ? `${String(up)} cm up` : ''
}

/** The horizon handle at the photo's centre column, kept 24 px inside the visible photo, and its tag. */
export interface HorizonHandle {
  readonly x: number
  readonly y: number
  readonly off: '' | 'above' | 'below'
  readonly text: string
}
export function horizonHandle(cx: number, cy: number, st: Rect): HorizonHandle {
  const off = cy < st.y + 24 ? 'above' : cy > st.y + st.h - 24 ? 'below' : ''
  return {
    x: Math.max(st.x + 24, Math.min(st.x + st.w - 24, cx)),
    y: Math.max(st.y + 24, Math.min(st.y + st.h - 24, cy)),
    off,
    text: off ? `Horizon ${off} the photo` : 'Horizon',
  }
}

/** The overlay's clip to the visible photo: CSS inset() in whole px. */
export function clipInset(r: Rect, vw: number, vh: number): string {
  return `inset(${String(Math.round(r.y))}px ${String(Math.round(vw - r.x - r.w))}px ${String(Math.round(vh - r.y - r.h))}px ${String(Math.round(r.x))}px)`
}

/** The part of the window the photo may use. Desktop: right of the side panel, under the bar, above the Adjust floor
 *  card. Phone: under the top bar; above the sheet (unless it is full), else the Adjust floor card, else the tool row
 *  and the dock. adjustH: the Adjust floor card's height, or null when it is hidden. */
export function stageInsets(mode: Mode, chromeLeft: number, safeTop: number, safeBottom: number, sheetH: number, sheetOpenNotFull: boolean, adjustH: number | null): Insets {
  if (mode === 'desktop') return { left: chromeLeft, top: 52, right: 0, bottom: adjustH === null ? 0 : adjustH + 24 }
  const bottom = sheetOpenNotFull ? sheetH : adjustH === null ? safeBottom + 8 + 64 + 8 + 56 + 8 : adjustH + safeBottom + 16
  return { left: 0, top: safeTop + 60, right: 0, bottom }
}

/** What a key does in the workspace (before the engine's own keys): Delete or Backspace removes the selected piece,
 *  ⌘Z / Ctrl+Z puts the last one back, Esc leaves Adjust floor (when the ruler is off). Nothing while typing. */
export type WorkspaceKey = 'remove' | 'undo' | 'leave-adjust' | null
export interface KeyFacts {
  readonly key: string
  readonly meta: boolean
  readonly ctrl: boolean
  readonly shift: boolean
  readonly typing: boolean
  readonly selected: boolean
  readonly canUndo: boolean
  readonly adjusting: boolean
  readonly rulerActive: boolean
}
export function workspaceKey(k: KeyFacts): WorkspaceKey {
  if (k.typing) return null
  if ((k.key === 'Delete' || k.key === 'Backspace') && k.selected && !k.meta && !k.ctrl) return 'remove'
  if ((k.meta || k.ctrl) && !k.shift && k.key.toLowerCase() === 'z' && k.canUndo) return 'undo'
  if (k.key === 'Escape' && k.adjusting && !k.rulerActive) return 'leave-adjust'
  return null
}

/** The phone's bottom bar: Adjust floor's card, the selection bar, or none (data-ws-bar). */
export function bottomBar(phone: boolean, adjusting: boolean, open: boolean, selecting: boolean): string {
  return phone ? (adjusting && open ? 'adjust' : selecting ? 'select' : '') : ''
}

/** Why a piece shows as a box: no GLB (only a splat), or gone from the library. */
export function missingText(name: string | null, noGlb: boolean): string {
  if (name !== null && noGlb) return `${name} has no GLB model (only a splat), so it shows as a box at its size.`
  const who = name === null || name === '' ? 'This piece' : name
  return `${who} isn't in the library any more, so it shows as a box at its size. Restore it from Library › Recently removed, or Remove it here.`
}

/** Adjust floor's note: the floor's warning (unless the camera was set by hand), else how to line it up. */
export function adjustNote(floorNote: string | null, manual: boolean): string {
  return floorNote && !manual ? floorNote : 'Line the grid up with the floor: tiles, a rug, the foot of the walls. Drag the horizon line to tilt.'
}

/** The ruler's instruction until both ends are down ("" after). */
export function rulerHint(active: boolean, measured: boolean, points: number, phone: boolean): string {
  const tap = phone ? 'Tap' : 'Click'
  return active && !measured ? (points ? `${tap} the other end` : `${tap} two points on the floor, the ends of something you can measure`) : ''
}

/** After Set scale: the new camera height, or that it hit its limit. */
export function scaleText(exact: boolean, cm: number, heightCm: number): string {
  return exact
    ? `Scale set from ${String(Math.round(cm))} cm: camera height ${String(heightCm)} cm. Looks right saves it.`
    : `Camera height is at its limit (${String(heightCm)} cm): measure a longer length.`
}

/** After Looks right: says so when the hand-set camera is used from now on. */
export function floorSavedText(manualNow: boolean, manualBefore: boolean): string {
  return manualNow && !manualBefore ? 'Floor saved: your camera is used from now on.' : 'Floor saved.'
}

/** A range input's filled part, as the CSS --fill percentage. */
export function fillPercent(v: number, min: number, max: number): string {
  return `${String(((v - min) / (max - min)) * 100)}%`
}
