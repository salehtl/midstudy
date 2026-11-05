// The server's JSON as the planner reads it: one typed shape per answer the engine, the data stores and the UI share
// (library entries, scenes, layouts, renders, library jobs, trash, today's spend). The shapes are tolerant on purpose,
// as v1 read the answers (`?.` and `||`): a field the planner can do without is optional and may be null. The strict
// shapes are contract/gen/types.ts; the server enforces them (strict mode), the planner doesn't need to.
//
// Each reader narrows a value from the server to its shape. A value that has the shape is kept as it is, so what the
// hook hands back is the server's answer unchanged (contract §2.4: getLibrary() is library.json's items "as-is",
// listRenders() and listScenes() the server's lists). A field of the wrong type is read as absent: the reader then
// returns a copy without it (the engine track's rule for malformed answers, docs/notes/engine.md). An entry without
// what it can't do without (an id, a name, a render's URLs) is left out.
import type { DimsCm } from './logic/text.js'

type Json = Readonly<Record<string, unknown>>
type Check = (v: unknown) => boolean
type Fields = Readonly<Record<string, Check>>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str: Check = (v) => typeof v === 'string'
const num: Check = (v) => typeof v === 'number'
const bool: Check = (v) => typeof v === 'boolean'
const any: Check = () => true
/** Absent, null, or what `c` accepts. */
const opt = (c: Check): Check => (v) => v === undefined || v === null || c(v)
/** An object whose fields pass their checks (other fields are kept, unread). */
const shape = (fields: Fields): Check => (v) => isObject(v) && conforms(v, fields)

function conforms(v: Json, fields: Fields): boolean {
  for (const [k, c] of Object.entries(fields)) if (!c(v[k])) return false
  return true
}
/** `v` as it is when it has the shape, else a copy without the fields of the wrong type (null when that still fails). */
function read<T>(v: unknown, fields: Fields, is: (x: unknown) => x is T): T | null {
  if (is(v)) return v
  if (!isObject(v)) return null
  const copy = Object.fromEntries(Object.entries(v).filter(([k, x]) => fields[k]?.(x) ?? true))
  return is(copy) ? copy : null
}
/** The entries of a list that can be read, each as `read` gives it. */
function readList<T>(v: unknown, one: (x: unknown) => T | null): T[] {
  const out: T[] = []
  if (!Array.isArray(v)) return out
  const all: readonly unknown[] = v
  for (const x of all) {
    const t = one(x)
    if (t !== null) out.push(t)
  }
  return out
}

// --- the library (contract §2.8) ------------------------------------------------------------------------------------

/** A library entry's files, relative to library.json. */
interface LibAssets {
  readonly glb?: string | null
  readonly splat?: string | null
  readonly spz?: string | null
  readonly thumb?: string | null
}
/** A library.json entry (§2.4 getLibrary: as-is), or a placeholder the planner made for a piece the library lost
 * (missing: true, §2.8). */
export interface LibraryEntry {
  readonly id: string
  readonly name?: string | null
  readonly category?: string | null
  readonly dims_cm?: DimsCm | null
  readonly mount?: string | null
  readonly default_render?: string | null
  /** Not readonly: a thumbnail the planner made is set in place (engine.ts makeMissingThumbs), as v1 did. */
  assets?: LibAssets | null
  readonly source?: { readonly engine?: string | null; readonly created?: unknown } | null
  readonly fit?: unknown
  readonly missing?: boolean | null
}
const DIMS: Fields = { w: num, d: num, h: num }
const LIB_ENTRY: Fields = {
  id: str, name: opt(str), category: opt(str), dims_cm: opt(shape(DIMS)), mount: opt(str), default_render: opt(str),
  assets: opt(shape({ glb: opt(str), splat: opt(str), spz: opt(str), thumb: opt(str) })), source: opt(shape({ engine: opt(str), created: any })),
  fit: any, missing: opt(bool),
}
function isLibraryEntry(v: unknown): v is LibraryEntry {
  return isObject(v) && conforms(v, LIB_ENTRY)
}
export const libraryEntry = (v: unknown): LibraryEntry | null => read(v, LIB_ENTRY, isLibraryEntry)
export const libraryEntries = (v: unknown): LibraryEntry[] => readList(v, libraryEntry)

/** A job of the library manager (§2.8 Jobs). */
export interface LibraryJob {
  readonly id: string
  readonly kind?: string | null
  readonly item_id: string
  readonly status?: string | null
  readonly message?: string | null
  readonly cost_usd?: number | null
  readonly cost_usd_estimate?: number | null
  readonly mock?: boolean | null
  readonly item?: LibraryEntry | null
}
const LIB_JOB: Fields = {
  id: str, kind: opt(str), item_id: str, status: opt(str), message: opt(str), cost_usd: opt(num), cost_usd_estimate: opt(num),
  mock: opt(bool), item: opt(isLibraryEntry),
}
export function isLibraryJob(v: unknown): v is LibraryJob {
  return isObject(v) && conforms(v, LIB_JOB)
}
export const libraryJob = (v: unknown): LibraryJob | null => read(v, LIB_JOB, isLibraryJob)
export const libraryJobs = (v: unknown): LibraryJob[] => readList(v, libraryJob)

/** A piece in the library's trash (GET /api/library `trash`). */
export interface TrashedItem {
  readonly id: string
  readonly name?: string | null
  readonly deleted?: string | null
}
const TRASHED_ITEM: Fields = { id: str, name: opt(str), deleted: opt(str) }
function isTrashedItem(v: unknown): v is TrashedItem {
  return isObject(v) && conforms(v, TRASHED_ITEM)
}
export const trashedItems = (v: unknown): TrashedItem[] => readList(v, (x) => read(x, TRASHED_ITEM, isTrashedItem))

/** Today's spend (GET /api/spend, §2.9). */
export interface Spend {
  readonly spent_usd?: number | null
  readonly reserved_usd?: number | null
  readonly cap_usd?: number | null
}
const SPEND: Fields = { spent_usd: opt(num), reserved_usd: opt(num), cap_usd: opt(num) }
function isSpend(v: unknown): v is Spend {
  return isObject(v) && conforms(v, SPEND)
}
export const spendOf = (v: unknown): Spend | null => read(v, SPEND, isSpend)

// --- scenes (contract §4.4) -----------------------------------------------------------------------------------------

/** A scene object (GET /api/scenes; GET /api/scenes/<name> has the same fields and more). */
export interface SceneSummary {
  readonly name: string
  readonly title?: string | null
  readonly created?: string | null
  readonly photo_url?: string | null
  /** Not readonly: a thumbnail the planner saved is set in place (engine.ts saveThumbnail), as v1 did. */
  thumb_url?: string | null
  readonly w?: number | null
  readonly h?: number | null
  readonly layouts?: number | null
  readonly calib_status?: string | null
  readonly calib_error?: string | null
  readonly floor_found?: boolean | null
  readonly camera_source?: string | null
}
const SCENE: Fields = {
  name: str, title: opt(str), created: opt(str), photo_url: opt(str), thumb_url: opt(str), w: opt(num), h: opt(num),
  layouts: opt(num), calib_status: opt(str), calib_error: opt(str), floor_found: opt(bool), camera_source: opt(str),
}
function isScene(v: unknown): v is SceneSummary {
  return isObject(v) && conforms(v, SCENE)
}
export const sceneSummary = (v: unknown): SceneSummary | null => read(v, SCENE, isScene)
export const sceneSummaries = (v: unknown): SceneSummary[] => readList(v, sceneSummary)

/** calib.json's public part (§4.4), as far as the planner shows it. */
export interface CalibInfo {
  readonly source?: string | null
  readonly device?: string | null
  readonly elapsed_s?: number | null
  readonly depth?: { readonly w: number; readonly h: number } | null
}
const CALIB: Fields = { source: opt(str), device: opt(str), elapsed_s: opt(num), depth: opt(shape({ w: num, h: num })) }
function isCalib(v: unknown): v is CalibInfo {
  return isObject(v) && conforms(v, CALIB)
}
export const calibInfo = (v: unknown): CalibInfo | null => read(v, CALIB, isCalib)

/** A deleted scene the server keeps (GET /api/scenes `trash`). */
export interface TrashedScene {
  readonly name: string
  readonly title?: string | null
  readonly created?: string | null
  readonly deleted?: string | null
}
const TRASHED_SCENE: Fields = { name: str, title: opt(str), created: opt(str), deleted: opt(str) }
function isTrashedScene(v: unknown): v is TrashedScene {
  return isObject(v) && conforms(v, TRASHED_SCENE)
}
export const trashedScenes = (v: unknown): TrashedScene[] => readList(v, (x) => read(x, TRASHED_SCENE, isTrashedScene))

/** The 202 of a photo upload (POST /api/scenes): the new scene's name. */
export interface SceneCreated {
  readonly scene: string
  readonly job?: unknown
}
const SCENE_CREATED: Fields = { scene: str, job: any }
function isSceneCreated(v: unknown): v is SceneCreated {
  return isObject(v) && conforms(v, SCENE_CREATED)
}
export const sceneCreated = (v: unknown): SceneCreated | null => read(v, SCENE_CREATED, isSceneCreated)

// --- layouts (contract §2.7) ----------------------------------------------------------------------------------------

/** A layout of the open scene (GET /api/layouts `details`). */
export interface LayoutSummary {
  readonly name: string
  readonly title?: string | null
  readonly items?: number | null
  readonly updated?: string | null
}
const LAYOUT: Fields = { name: str, title: opt(str), items: opt(num), updated: opt(str) }
function isLayout(v: unknown): v is LayoutSummary {
  return isObject(v) && conforms(v, LAYOUT)
}
export const layoutSummaries = (v: unknown): LayoutSummary[] => readList(v, (x) => read(x, LAYOUT, isLayout))

// --- renders (contract §2.6, §4.7) ------------------------------------------------------------------------------------

/** Keep room exact's align result. */
interface AlignResult {
  readonly applied?: boolean | null
  readonly inliers?: number | null
  readonly residual_px?: number | null
  readonly reason?: string | null
}
/** A render's metadata: the answer of POST /api/render and each entry of GET /api/renders. */
export interface RenderMeta {
  readonly name: string
  readonly url: string
  readonly input_url: string
  readonly raw_url?: string | null
  readonly model: string
  readonly cost_usd?: number | null
  readonly mock?: boolean | null
  readonly prompt?: string | null
  readonly created: string
  readonly scene?: string | null
  readonly layout?: string | null
  readonly reference?: boolean | null
  readonly keep_room?: boolean | null
  readonly aligned?: AlignResult | null
  readonly width?: number | null
  readonly height?: number | null
  readonly out_w?: number | null
  readonly out_h?: number | null
}
const RENDER: Fields = {
  name: str, url: str, input_url: str, raw_url: opt(str), model: str, cost_usd: opt(num), mock: opt(bool), prompt: opt(str),
  created: str, scene: opt(str), layout: opt(str), reference: opt(bool), keep_room: opt(bool),
  aligned: opt(shape({ applied: opt(bool), inliers: opt(num), residual_px: opt(num), reason: opt(str) })),
  width: opt(num), height: opt(num), out_w: opt(num), out_h: opt(num),
}
function isRender(v: unknown): v is RenderMeta {
  return isObject(v) && conforms(v, RENDER)
}
export const renderMeta = (v: unknown): RenderMeta | null => read(v, RENDER, isRender)
export const renderMetas = (v: unknown): RenderMeta[] => readList(v, renderMeta)
