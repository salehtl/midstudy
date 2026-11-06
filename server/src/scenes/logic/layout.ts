// Layouts per scene (contract §2.7): v1's checks of PUT /api/layouts/<layout>?scene=<name>, the layout it stores, and
// the summary GET /api/layouts lists (planner/serve.py put_layout, list_layouts). Pure (TScert); the shell parses the
// JSON and narrows each object to a record first.
import { pyRepr, pyStrip } from '../../../../common/logic/pyfmt.ts'
import { isSlug } from '../../../../common/logic/slug.ts'
import { codePointLength, collapseSpaces, isNum, isRecord } from './values.ts'

/** v1 MAX_LAYOUT_TITLE. */
const MAX_LAYOUT_TITLE = 120

/** One stored layout item, in v1's key order. */
interface StoredItem {
  readonly uid: string
  readonly id: string
  readonly render: 'glb' | 'splat'
  readonly position: readonly number[]
  readonly rotation_y_deg: number
  readonly mounted?: 'floor' | 'wall'
  readonly dims_cm?: { readonly w: number; readonly d: number; readonly h: number }
}

/** The stored layout (layout.schema.json), in v1's key order. */
interface StoredLayout {
  readonly version: 1
  readonly name: string
  readonly title: string | null
  readonly scene_name: string
  readonly library: string | null
  readonly updated: string
  readonly items: readonly StoredItem[]
  readonly notes?: string
}

export type LayoutCheck = { readonly ok: true; readonly layout: StoredLayout } | { readonly ok: false; readonly error: string }

/** v1 `layout_scene`'s refusal of `?scene=` (400), or null when it is a slug (whether that scene exists is the
 *  shell's question: 404). `scene` is the query value, null when absent or blank. */
export function layoutSceneProblem(scene: string | null): string | null {
  if (scene === null || scene === '') return 'add ?scene=<name>: layouts belong to a scene'
  if (!isSlug(scene)) return 'scene must be a slug (a-z, 0-9, -): ' + pyRepr(scene)
  return null
}

/** v1 `bad_layout_name`'s refusal (400), or null for a slug. */
export function layoutNameProblem(name: string): string | null {
  return isSlug(name) ? null : 'layout name must be a slug like "reading-corner" (a-z, 0-9, -): ' + pyRepr(name)
}

/** v1's 404 for a layout the scene doesn't have. */
export function noLayout(scene: string, name: string): string {
  return 'scene ' + pyRepr(scene) + ' has no layout named ' + pyRepr(name)
}

/** v1's 500 for a layout file that can't be read. */
export function unreadableLayout(scene: string, name: string): string {
  return 'layout ' + pyRepr(name) + ' of scene ' + pyRepr(scene) + ' is unreadable: fix or delete it'
}

/** The three numbers of a position, or null when it isn't a list of exactly three finite numbers. */
function positionOf(v: unknown): number[] | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const out: number[] = []
  for (const x of v) {
    if (!isNum(x)) return null
    out.push(x)
  }
  return out
}

/** `dims_cm` when it is an object with numbers w, d and h (other keys dropped), else null. */
function dimsOf(v: unknown): { readonly w: number; readonly d: number; readonly h: number } | null {
  if (!isRecord(v)) return null
  const w = v['w']
  const d = v['d']
  const h = v['h']
  return isNum(w) && isNum(d) && isNum(h) ? { w, d, h } : null
}

function renderOf(v: unknown): 'glb' | 'splat' {
  return v === 'splat' ? 'splat' : 'glb'
}

function mountedOf(v: unknown): 'floor' | 'wall' | null {
  return v === 'floor' || v === 'wall' ? v : null
}

/** One item as v1 stores it, or its refusal. `i` is its index in `items`. */
function itemOf(it: unknown, i: number): { readonly ok: true; readonly item: StoredItem } | { readonly ok: false; readonly error: string } {
  if (!isRecord(it)) return { ok: false, error: 'item ' + String(i) + " needs an id (a library item's slug)" }
  const id = it['id']
  if (typeof id !== 'string' || !isSlug(id)) return { ok: false, error: 'item ' + String(i) + " needs an id (a library item's slug)" }
  const position = positionOf(it['position'])
  if (position === null) return { ok: false, error: 'item ' + String(i) + ' (' + id + ') needs a position [x, elevation, z] in meters' }
  const rot = it['rotation_y_deg'] === undefined ? 0 : it['rotation_y_deg']
  if (!isNum(rot)) return { ok: false, error: 'item ' + String(i) + ' (' + id + '): rotation_y_deg must be a number' }
  const uidValue = it['uid']
  const uid = typeof uidValue === 'string' && uidValue !== '' ? uidValue : id + '-' + String(i + 1)
  const render = renderOf(it['render'])
  const mounted = mountedOf(it['mounted'])
  const dims = dimsOf(it['dims_cm'])
  if (mounted !== null) {
    return dims === null
      ? { ok: true, item: { uid, id, render, position, rotation_y_deg: rot, mounted } }
      : { ok: true, item: { uid, id, render, position, rotation_y_deg: rot, mounted, dims_cm: dims } }
  }
  return dims === null
    ? { ok: true, item: { uid, id, render, position, rotation_y_deg: rot } }
    : { ok: true, item: { uid, id, render, position, rotation_y_deg: rot, dims_cm: dims } }
}

/** v1 `put_layout`: the layout to store from the request body, or the first refusal (400). `name` and `scene` come
 *  from the URL (checked), `updated` is now. The body's `name`, `scene_name` and `updated` are ignored. */
export function checkLayout(body: unknown, name: string, scene: string, updated: string): LayoutCheck {
  if (!isRecord(body)) return { ok: false, error: 'a layout must be a JSON object with an "items" array' }
  const rawItems = body['items']
  if (!Array.isArray(rawItems)) return { ok: false, error: 'a layout must be a JSON object with an "items" array' }
  const items: StoredItem[] = []
  let i = 0
  for (const it of rawItems) {
    const r = itemOf(it, i)
    if (!r.ok) return { ok: false, error: r.error }
    items.push(r.item)
    i += 1
  }
  const lib = body['library']
  const notes = body['notes']
  const title = body['title']
  if (title !== undefined && title !== null && typeof title !== 'string') return { ok: false, error: "title must be text (the layout's name as typed) or null" }
  const t = collapseSpaces(typeof title === 'string' ? title : '')
  if (codePointLength(t) > MAX_LAYOUT_TITLE) return { ok: false, error: 'the title can be at most ' + String(MAX_LAYOUT_TITLE) + ' characters' }
  const library = typeof lib === 'string' ? lib : null
  const layout: StoredLayout = typeof notes === 'string'
    ? { version: 1, name, title: t === '' ? null : t, scene_name: scene, library, updated, items, notes }
    : { version: 1, name, title: t === '' ? null : t, scene_name: scene, library, updated, items }
  return { ok: true, layout }
}

/** One entry of GET /api/layouts' `details`. */
export interface LayoutSummary {
  readonly name: string
  readonly title: string | null
  readonly items: number
  readonly updated: string
}

/** v1 `list_layouts`' entry for `<name>.json`: its title when it is non-blank text, how many items it places (0 when
 *  `items` isn't a list), and its `updated` when that is text, else `mtimeIso` (the file's modification time).
 *  `data` is the parsed file (null when unreadable). */
export function layoutSummary(name: string, data: unknown, mtimeIso: string): LayoutSummary {
  const doc = isRecord(data) ? data : null
  const title = doc === null ? undefined : doc['title']
  const items = doc === null ? undefined : doc['items']
  const updated = doc === null ? undefined : doc['updated']
  return {
    name,
    title: typeof title === 'string' && pyStrip(title) !== '' ? title : null,
    items: Array.isArray(items) ? items.length : 0,
    updated: typeof updated === 'string' ? updated : mtimeIso,
  }
}
