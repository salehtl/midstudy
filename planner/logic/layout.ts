// Layouts (contract §2.7, §4.5): when the pieces count as unsaved, the names shown, which layout a scene opens with,
// the document a save writes, and the messages a load gives. v1's layoutSig, prettyLayout, layoutDisplayName,
// recalledLayout, layoutToOpen, layoutDoc and the load toasts. Pure, for TScert (tscert/README.md): v1's round and
// wrapDeg are the kernels' and come in as parameters (Kernels).
import type { JsonObject, Kernels } from './num.js'

/** The slug every id, layout and scene name is (CLAUDE.md conventions). */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/

export function isSlug(s: string): boolean {
  return SLUG.test(s)
}

/** A placed piece as the layout's dirty test sees it. */
export interface PlacedPose {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly z: number
  readonly rotation_y_deg: number
}

/** One piece as v1's layoutSig row read as text: the id, the position in 0.1 mm and the turn in 0.01°, comma-joined
 * (the numbers have no commas, so the row is unambiguous). */
function poseText(p: PlacedPose, k: Kernels): string {
  return `${p.id},${String(Math.round(p.x * 1e4))},${String(Math.round(p.y * 1e4))},${String(Math.round(p.z * 1e4))},${String(Math.round(k.wrapDeg(p.rotation_y_deg) * 100))}`
}

function byCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/** v1's layoutSig: the placed pieces by library id, position (to 0.1 mm) and turn (to 0.01°), in a fixed order, so
 * "unsaved" means the pieces differ from the layout as saved or loaded (Remove then Undo is not). v1 sorted its rows
 * by this same text (Array.prototype.sort's default order); two signatures are equal exactly when v1's were. */
export function layoutSig(pieces: readonly PlacedPose[], k: Kernels): string {
  const rows: string[] = []
  for (const p of pieces) rows.push(poseText(p, k))
  return JSON.stringify([...rows].sort(byCodeUnits))
}

/** The signature of no pieces: what a scene opens with before its layout loads. */
export const EMPTY_SIG = '[]'

/** v1's prettyLayout: "two-chairs" → "Two chairs". */
export function prettyLayout(name: string): string {
  const s = name.replace(/-/g, ' ')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A layout's listing entry as the planner keeps it (GET /api/layouts `details`). */
export interface LayoutDetail {
  readonly name: string
  readonly title: string | null
  /** Date.parse of `updated`, 0 when it has none (or it doesn't parse) */
  readonly updatedMs: number
}

/** v1's layoutDisplayName: the name as typed ("Phone A") when the layout has one, else the slug made readable. */
export function displayName(name: string, current: string, currentTitle: string, details: readonly LayoutDetail[]): string {
  if (!name) return ''
  if (name === current && currentTitle) return currentTitle
  const d = details.find((x) => x.name === name)
  const t = d?.title?.trim() ?? ''
  return t || prettyLayout(name)
}

/** What this device remembers of a scene's layout (v1's recalledLayout): the name (null: none, after deleting it)
 * and when it was chosen (ms, 0 when unknown). */
export interface Recalled {
  readonly name: string | null
  readonly at: number
}

/** v1's recalledLayout, after the shell has read the stored text: a plain slug (stored before round 2: any later
 * save wins), or the JSON object `{name, at}` (`atMs` = Date.parse(at), NaN when it doesn't parse). */
export function recalledFromSlug(raw: string): Recalled | null {
  return SLUG.test(raw) ? { name: raw, at: 0 } : null
}

export function recalledFromObject(v: JsonObject, atMs: number): Recalled {
  const n = v['name']
  return { name: typeof n === 'string' && SLUG.test(n) ? n : null, at: Number.isNaN(atMs) ? 0 : atMs }
}

/** v1's layoutToOpen (contract §4.5): this device's choice unless a layout was saved after it on any device (or the
 * device never had the scene open); then the most recently saved layout. */
export function layoutToOpen(mine: Recalled | null, details: readonly LayoutDetail[]): string | null {
  let newest: LayoutDetail | null = null
  for (const d of details) if (newest === null || d.updatedMs > newest.updatedMs) newest = d
  if (mine !== null && (newest === null || mine.at >= newest.updatedMs)) {
    if (mine.name === null) return null
    const name = mine.name
    if (details.some((d) => d.name === name)) return name
  }
  return newest === null ? null : newest.name
}

/** One item of a saved layout (layout.schema.json); the shell adds the library entry's dims_cm as they are (a
 * placeholder's size if the piece goes missing, §2.8). */
export interface LayoutDocItem {
  readonly uid: string
  readonly id: string
  readonly render: 'glb' | 'splat'
  readonly position: [number, number, number]
  readonly rotation_y_deg: number
}

/** A placed piece as a save writes it. */
export interface PlacedForSave {
  readonly uid: string
  readonly id: string
  readonly render: 'glb' | 'splat'
  readonly x: number
  readonly y: number
  readonly z: number
  readonly rotation_y_deg: number
}

/** v1's layoutDoc items: positions and the turn rounded to 6 decimals; render is what was drawn. */
export function docItem(p: PlacedForSave, k: Kernels): LayoutDocItem {
  const position: [number, number, number] = [k.roundTo(p.x, 6), k.roundTo(p.y, 6), k.roundTo(p.z, 6)]
  return { uid: p.uid, id: p.id, render: p.render, position, rotation_y_deg: k.roundTo(p.rotation_y_deg, 6) }
}

/** v1's saveLayoutInternal title: the one given (trimmed, at most 120 characters), else the one kept for that name. */
export function layoutTitle(given: unknown, kept: unknown): string | null {
  if (typeof given === 'string' && given.trim()) return given.trim().slice(0, 120)
  return typeof kept === 'string' && kept.trim() ? kept.trim() : null
}

/** v1's setLayoutName: the current name and title (a title only with a name). */
export function currentTitle(name: string, title: unknown): string {
  return name && typeof title === 'string' ? title.trim() : ''
}

/** v1's load toasts: pieces that could not be placed. */
export function failedText(name: string, failed: number, total: number): string {
  return `Layout "${name}": ${String(failed)} of ${String(total)} items could not be placed.`
}

/** v1's load toasts: pieces the library no longer has (shown as boxes). */
export function missingText(name: string, n: number): string {
  return `${n === 1 ? 'One piece in' : `${String(n)} pieces in`} "${name}" ${n === 1 ? "isn't" : "aren't"} in the library any more: shown as ${n === 1 ? 'a box' : 'boxes'}.`
}
