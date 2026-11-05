// The view onto the photo (contract §4.5): the stage (the window minus the chrome's insets), contain-fit, 2D zoom up
// to 4× and pan, and the mapping between photo pixels and client (CSS) pixels: client = o + s · photo px. v1's
// stageRect, fitScale, viewParams, clampCenter, zoomAt, panBy, clientToPhoto, photoToClient, visiblePhotoRect, getView,
// setStageInsets. Pure, for TScert (tscert/README.md).
import { isNum, round } from './num.js'

export interface Box {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

export interface Insets {
  readonly left: number
  readonly right: number
  readonly top: number
  readonly bottom: number
}

export interface Size {
  readonly w: number
  readonly h: number
}

/** Zoom (1–4) and the photo point (photo px) at the stage's centre. */
export interface ViewState {
  readonly zoom: number
  readonly cx: number
  readonly cy: number
}

/** client = o + s · photo px. */
export interface Xform {
  readonly s: number
  readonly ox: number
  readonly oy: number
}

/** What getView() and the 'view' event give. */
export interface ViewReport {
  readonly zoom: number
  readonly cx: number
  readonly cy: number
  readonly fit: boolean
}

export const MAX_ZOOM = 4

/** v1's setStageInsets: each inset a positive finite number, else 0. */
export function insetsFrom(left: unknown, right: unknown, top: unknown, bottom: unknown): Insets {
  const px = (v: unknown): number => (isNum(v) && v > 0 ? v : 0)
  return { left: px(left), right: px(right), top: px(top), bottom: px(bottom) }
}

/** v1's stageRect: the canvas's client rect minus the insets, at least 40 × 40. */
export function stageOf(canvas: Box, ins: Insets): Box {
  const x = ins.left
  const y = ins.top
  return { x: canvas.x + x, y: canvas.y + y, w: Math.max(40, canvas.w - x - ins.right), h: Math.max(40, canvas.h - y - ins.bottom) }
}

/** v1's fitScale: the photo contained in the stage. */
export function fitScale(st: Box, photo: Size): number {
  return Math.min(st.w / photo.w, st.h / photo.h)
}

/** v1's viewParams. */
export function xformOf(st: Box, photo: Size, v: ViewState): Xform {
  const s = fitScale(st, photo) * v.zoom
  return { s, ox: st.x + st.w / 2 - s * v.cx, oy: st.y + st.h / 2 - s * v.cy }
}

/** v1's clampCenter lim(): a centre coordinate kept so the photo covers the stage when it is larger than it. */
export function limitCenter(c: number, len: number, stageLen: number, s: number): number {
  if (s * len <= stageLen + 0.5) return len / 2
  return Math.min(len - stageLen / (2 * s), Math.max(stageLen / (2 * s), c))
}

/** v1's clampCenter. */
export function clampedView(st: Box, photo: Size, v: ViewState): ViewState {
  const s = fitScale(st, photo) * v.zoom
  return { zoom: v.zoom, cx: limitCenter(v.cx, photo.w, st.w, s), cy: limitCenter(v.cy, photo.h, st.h, s) }
}

/** v1's fitView: zoom 1, centred. */
export function fitState(photo: Size): ViewState {
  return { zoom: 1, cx: photo.w / 2, cy: photo.h / 2 }
}

/** v1's zoomAt(clientX, clientY, zoom): the zoom clamped to 1–4, keeping the photo point under the pointer
 * (`before`, that point's photo px at the old zoom) where it is. Not clamped yet (updateView does that). */
export function zoomedView(st: Box, photo: Size, v: ViewState, clientX: number, clientY: number, zoom: number, before: readonly [number, number]): ViewState {
  const z = Math.min(MAX_ZOOM, Math.max(1, zoom))
  const s = fitScale(st, photo) * z
  return {
    zoom: z,
    cx: (st.x + st.w / 2 - (clientX - s * before[0])) / s,
    cy: (st.y + st.h / 2 - (clientY - s * before[1])) / s,
  }
}

/** v1's panBy: the photo moves with the pointer. */
export function pannedView(v: ViewState, s: number, dx: number, dy: number): ViewState {
  return { zoom: v.zoom, cx: v.cx - dx / s, cy: v.cy - dy / s }
}

export function clientToPhoto(t: Xform, x: number, y: number): [number, number] {
  return [(x - t.ox) / t.s, (y - t.oy) / t.s]
}

export function photoToClient(t: Xform, px: number, py: number): [number, number] {
  return [t.ox + t.s * px, t.oy + t.s * py]
}

/** v1's getPhotoRect: the photo's rectangle in client px (beyond the window when zoomed). */
export function photoRect(t: Xform, photo: Size): Box {
  return { x: t.ox, y: t.oy, w: t.s * photo.w, h: t.s * photo.h }
}

/** v1's visiblePhotoRect: the photo rectangle cut to the stage (at least 1 × 1). */
export function visibleRect(p: Box, st: Box): Box {
  const x0 = Math.max(p.x, st.x)
  const y0 = Math.max(p.y, st.y)
  const x1 = Math.min(p.x + p.w, st.x + st.w)
  const y1 = Math.min(p.y + p.h, st.y + st.h)
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
}

/** v1's getView(). */
export function viewReport(v: ViewState): ViewReport {
  return { zoom: round(v.zoom, 4), cx: round(v.cx, 2), cy: round(v.cy, 2), fit: v.zoom <= 1.0001 }
}

/** The photo's rectangle in the drawing buffer's pixels (top-left origin) for the screen passes: v1's updateView rect,
 * `k` the drawing buffer's pixels per CSS px. */
export function bufferRect(t: Xform, photo: Size, canvas: Box, k: number): [number, number, number, number] {
  return [(t.ox - canvas.x) * k, (t.oy - canvas.y) * k, t.s * photo.w * k, t.s * photo.h * k]
}

/** camera.setViewOffset's arguments (v1's updateView): the canvas is a window onto the photo's s·W × s·H rectangle. */
export interface ViewOffset {
  readonly fullWidth: number
  readonly fullHeight: number
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
}

export function viewOffset(t: Xform, photo: Size, canvas: Box): ViewOffset {
  return {
    fullWidth: t.s * photo.w,
    fullHeight: t.s * photo.h,
    x: canvas.x - t.ox,
    y: canvas.y - t.oy,
    width: canvas.w || 1,
    height: canvas.h || 1,
  }
}
