// Names the scenes, layouts and renders code makes or reads (contract §4.2, §2.6, §2.7; v1 planner/serve.py): a new
// scene's name and its collision suffix, a trashed scene's folder, a layout's trash file, render names, and the
// order v1 listed things in. Pure (TScert).
import { utcStamp } from '../../../../common/logic/time.ts'
import { cmpCodePoints } from './values.ts'

/** `<base>` for n = 1, else `<base>-<n>` (v1's collision suffix: the second gets -2). */
export function numbered(base: string, n: number): string {
  return n <= 1 ? base : base + '-' + String(n)
}

/** A new scene's base name: `scene-YYYYMMDD-HHMMSS` (UTC). */
export function sceneBase(epochMs: number): string {
  return 'scene-' + utcStamp(epochMs)
}

/** A render's base name: `render-YYYYMMDD-HHMMSS` (UTC). */
export function renderBase(epochMs: number): string {
  return 'render-' + utcStamp(epochMs)
}

/** A trashed thing's base name: `<name>-YYYYMMDD-HHMMSS` (UTC of the delete). */
export function trashBase(name: string, epochMs: number): string {
  return name + '-' + utcStamp(epochMs)
}

// v1 TRASHED_SCENE: `<name>-<UTC stamp>[-n]`, where the name itself ends in a stamp (a scene trashed before trash.json
// existed). Python's \d is any Unicode decimal digit.
const TRASHED_SCENE = /^([a-z0-9][a-z0-9-]*?\p{Nd}{8}-\p{Nd}{6}(?:-\p{Nd}+)?)-\p{Nd}{8}-\p{Nd}{6}(?:-\p{Nd}+)?$/u

/** The scene name in a trash folder's name written before trash.json existed, or null when it isn't one. */
export function trashedSceneName(dirName: string): string | null {
  const m = TRASHED_SCENE.exec(dirName)
  return m?.[1] ?? null
}

/** A trashed scene as GET /api/scenes lists it (plus its folder's name, the sort's tie-break). */
export interface TrashedScene {
  readonly name: string
  readonly title: string | null
  readonly created: string | null
  readonly deleted: string
  readonly dir: string
}

/** v1 `trash()`'s order: newest `deleted` first, then the folder name, both descending by code point. */
export function compareTrashed(a: TrashedScene, b: TrashedScene): number {
  const byDeleted = cmpCodePoints(b.deleted, a.deleted)
  return byDeleted !== 0 ? byDeleted : cmpCodePoints(b.dir, a.dir)
}

/** A render's metadata as GET /api/renders sorts it: its `created` and `name` as Python's `str()` printed them. */
export interface RenderKey {
  readonly created: string
  readonly name: string
}

/** v1 `list_renders`' order: newest `created` first, then the name, both descending by code point. */
export function compareRenders(a: RenderKey, b: RenderKey): number {
  const byCreated = cmpCodePoints(b.created, a.created)
  return byCreated !== 0 ? byCreated : cmpCodePoints(b.name, a.name)
}
