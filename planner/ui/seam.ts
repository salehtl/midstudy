// The UI's seam with the rest of the planner: the engine (engine.js), the scenes and library stores (data.js) and the
// helpers the UI imports from them, typed as the UI uses them (planner/main.js builds the context and passes it to each
// area's mount). Until the engine track's TypeScript replaces those modules, they are untyped JavaScript; this file is
// the one place the UI states what it relies on from them, and tsc checks every use in the UI against it. When
// engine.ts and data.ts land (Phase 3), tsc checks these declarations against the real ones.
//
// The data types are loose on purpose: they say what the UI tolerates (v1 reads the server's JSON defensively, `?.`
// and `||`), not what contract/gen promises.

import * as engineJs from '../engine.js'
import * as dataJs from '../data.js'
import type { Events } from './bus.js'
import type * as Icons from './icons.js'
import type * as Kit from './kit.js'
import type { Shell } from './shell.js'
import type { AddMeta, EditPatch } from './logic/libforms.js'

export type Vec3 = readonly [number, number, number]
export type Vec2 = readonly [number, number]

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
export interface Dims {
  readonly w: number
  readonly d: number
  readonly h: number
}
/** The scene camera block (contract §4.1). */
export interface Camera {
  readonly fov_y_deg: number
  readonly height_m: number
  readonly pitch_deg: number
  readonly roll_deg: number
}
export type CameraKey = keyof Camera
export type CameraPatch = Partial<Camera>

// --- data the UI reads ----------------------------------------------------------------------------------------------------

export interface LibAssets {
  readonly glb?: string | null
  readonly splat?: string | null
  readonly spz?: string | null
  readonly thumb?: string | null
}
/** A library item (library.json, §2.8), or a missing piece's stand-in. */
export interface LibItem {
  readonly id: string
  readonly name?: string | null
  readonly category?: string | null
  readonly dims_cm?: Dims | null
  readonly mount?: string | null
  readonly default_render?: string | null
  readonly assets?: LibAssets | null
  readonly source?: { readonly engine?: string | null } | null
  readonly missing?: boolean | null
}
/** A placed piece (engine.getItems()). */
export interface PlacedItem {
  readonly uid: string
  readonly id: string
  readonly name: string
  readonly lib: LibItem | null
  readonly position: Vec3
  readonly rotation_y_deg: number
  readonly missing: boolean
  readonly noGlb: boolean
}
/** What engine.removeItemWithUndo() keeps for Undo (engine.restoreItem takes it back as it is). */
export interface RemovedItem {
  readonly uid: string
  readonly id: string
  readonly name: string
}
export interface Footprint {
  readonly corners: readonly Vec3[]
  readonly center: Vec3
  readonly box: readonly Vec3[]
  readonly height: number
}
export interface ScreenPoint {
  readonly x: number
  readonly y: number
  readonly visible: boolean
}
export interface Ruler {
  readonly active: boolean
  readonly points: readonly Vec3[]
  readonly meters: number | null
}
export interface PhotoSize {
  readonly w: number
  readonly h: number
  readonly has: boolean
}
export interface View {
  readonly zoom: number
  readonly cx: number
  readonly cy: number
  readonly fit: boolean
}
export interface DragState {
  readonly mode: string
  readonly uid: string
}

/** calib.json's public part (§4.4), as far as the Scene panel reads it. */
export interface CalibInfo {
  readonly source?: string | null
  readonly device?: string | null
  readonly elapsed_s?: number | null
  readonly depth?: { readonly w: number; readonly h: number } | null
}
/** A scene of GET /api/scenes (§4.4). */
export interface SceneSummary {
  readonly name: string
  readonly title?: string | null
  readonly created?: string | null
  readonly photo_url?: string | null
  readonly thumb_url?: string | null
  readonly w?: number | null
  readonly h?: number | null
  readonly layouts?: number | null
  readonly calib_status?: string | null
  readonly calib_error?: string | null
  readonly floor_found?: boolean | null
  readonly camera_source?: string | null
}
/** The open scene (engine.getScene()): the scene object with the photo's size, the camera source and depth. */
export interface SceneInfo extends SceneSummary {
  readonly w: number
  readonly h: number
  readonly hasDepth: boolean
  readonly calib?: CalibInfo | null
}
export interface SceneLoad {
  readonly loading: boolean
  readonly phase: string | null
  readonly name: string | null
  readonly scene: SceneSummary | null
}
/** A deleted scene the server keeps (scenes/.trash). */
export interface TrashedScene {
  readonly name: string
  readonly title?: string | null
  readonly created?: string | null
  readonly deleted?: string | null
}
/** A layout of the open scene (GET /api/layouts details). */
export interface LayoutDetail {
  readonly name: string
  readonly title?: string | null
  readonly items?: number | null
  readonly updated?: string | null
}
/** A deleted layout as it was (engine.deleteLayoutInternal), for Undo. */
export interface DeletedLayout {
  readonly name: string
}
export interface AlignResult {
  readonly applied?: boolean | null
  readonly inliers?: number | null
  readonly residual_px?: number | null
  readonly reason?: string | null
}
/** A render's metadata (§2.6, §4.7). */
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
  readonly layout?: string | null
  readonly reference?: boolean | null
  readonly keep_room?: boolean | null
  readonly aligned?: AlignResult | null
  readonly width?: number | null
  readonly height?: number | null
  readonly out_w?: number | null
  readonly out_h?: number | null
}
/** A capture (engine.captureComposite): a JPEG data URL and its size. */
export interface Shot {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}
export interface InferredLight {
  readonly azimuth_deg: number
  readonly elevation_deg: number
  readonly softness?: number | null
  readonly color?: readonly number[] | null
  readonly cct_k?: number | null
}
/** The Look and the light in use (engine.getLighting(), §4.8). */
export interface Lighting {
  readonly exposure: number
  readonly warmth: number
  readonly contact_shadows: boolean
  readonly auto_light: boolean
  readonly light_azimuth_deg: number
  readonly light_elevation_deg: number
  readonly light_softness: number
  readonly light_strength: number
  readonly ambient: number
  readonly cast_shadows: boolean
  readonly source: string
  readonly inferred: InferredLight | null
  readonly status: string
  readonly error: string | null
}
export interface LightingPatch {
  readonly auto_light?: boolean
  readonly light_azimuth_deg?: number
  readonly light_elevation_deg?: number
  readonly light_strength?: number
  readonly light_softness?: number
  readonly ambient?: number
  readonly exposure?: number
  readonly warmth?: number
  readonly cast_shadows?: boolean
  readonly contact_shadows?: boolean
}

// --- the engine ------------------------------------------------------------------------------------------------------------

/** The engine's events the UI listens to, with the details it reads (engine.js header). */
export interface EngineEvents {
  scene: { readonly phase: string; readonly name?: string | null }
  scenes: unknown
  camera: unknown
  adjust: { readonly on: boolean }
  occlusion: unknown
  grid: unknown
  view: unknown
  dirty: unknown
  items: { readonly change: string; readonly uid?: string | null }
  selection: { readonly uid: string | null }
  look: unknown
  lighting: unknown
  library: unknown
  layouts: unknown
  renders: unknown
  render: { readonly phase: string; readonly meta?: RenderMeta | null }
  compare: { readonly a: string; readonly b: string }
  ruler: unknown
}

/** engine.input (input.js): the shell swallows keys while a dialog, a menu or a page is open. */
export interface KeyInput {
  setKeyFilter(fn: (e: KeyboardEvent) => boolean): void
}

/** The engine (engine.js `engine`): the members the UI uses. */
export interface Engine {
  readonly events: Events<EngineEvents>
  readonly input?: KeyInput | null
  // state
  readonly getScene: () => SceneInfo | null
  readonly getSceneName: () => string | null
  readonly getSceneLoad: () => SceneLoad
  readonly getCamera: () => Camera
  readonly getCameraSource: () => string
  readonly getSavedScene: () => { readonly camera_source?: string | null } | null
  readonly getAdjustFloor: () => boolean
  readonly getFloorNote: () => string | null
  readonly getOcclusion: () => boolean
  readonly getGridVisible: () => boolean
  readonly getView: () => View
  readonly getPhotoRect: () => Rect
  readonly getVisiblePhotoRect: () => Rect
  readonly getPhotoSize: () => PhotoSize
  readonly isSceneDirty: () => boolean
  readonly isLayoutDirty: () => boolean
  readonly getItems: () => readonly PlacedItem[]
  readonly getItem: (uid: string | null) => PlacedItem | null
  readonly getSelected: () => string | null
  readonly getDrag: () => DragState | null
  readonly getFootprint: (uid: string) => Footprint | null
  readonly getElevation: (uid: string) => number | null
  readonly getLibrary: () => readonly LibItem[]
  readonly assetUrl: (rel: string) => string
  readonly getLayoutDetails: () => readonly LayoutDetail[]
  readonly getLayoutName: () => string
  readonly layoutDisplayName: (name: string) => string
  readonly getScenesTrash: () => readonly TrashedScene[]
  readonly getRenders: () => readonly RenderMeta[]
  readonly isRenderMock: () => boolean
  readonly getRuler: () => Ruler
  readonly horizonAt: (px: number) => number | null
  readonly getLighting: () => Lighting
  // scenes and the camera
  readonly setStageInsets: (insets: Insets) => void
  readonly openScene: (name: string) => Promise<unknown>
  readonly closeScene: () => void
  readonly restoreScene: (name: string) => Promise<unknown>
  readonly saveScene: () => Promise<unknown>
  readonly recalibrate: () => Promise<{ readonly calib_status?: string | null } | null | undefined>
  readonly setCamera: (patch: CameraPatch) => void
  readonly resetCamera: () => void
  readonly setAdjustFloor: (on: boolean) => void
  readonly setOcclusion: (on: boolean) => void
  readonly setGridVisible: (on: boolean) => void
  readonly setPitchFromHorizon: (py: number) => void
  readonly fitView: () => void
  // items
  readonly addItemInternal: (id: string) => Promise<string>
  readonly removeItemInternal: (uid: string) => void
  readonly select: (uid: string | null) => void
  readonly rotateSelected: (deg: number) => void
  readonly beginRotateDrag: (uid: string, clientX: number, clientY: number) => boolean
  readonly dragTo: (clientX: number, clientY: number, opts: { readonly snapTo: boolean }) => void
  readonly endItemDrag: () => void
  readonly removeItemWithUndo: (uid: string) => RemovedItem | null
  readonly restoreItem: (snapshot: RemovedItem) => Promise<string>
  readonly setElevation: (uid: string, meters: number) => void
  readonly nudgeElevation: (uid: string, dMeters: number) => void
  readonly dropToFloor: (uid: string) => void
  // the ruler
  readonly setRulerActive: (on: boolean) => void
  readonly setRulerPointAt: (i: number, clientX: number, clientY: number) => boolean
  readonly setRulerTrueLength: (meters: number) => boolean
  // look and lighting
  readonly setLighting: (patch: LightingPatch) => void
  readonly resetLighting: () => void
  readonly inferLighting: () => Promise<unknown>
  // layouts
  readonly saveLayoutInternal: (name: string, opts: { readonly title: string | null }) => Promise<unknown>
  readonly loadLayoutInternal: (name: string) => Promise<unknown>
  readonly deleteLayoutInternal: (name: string) => Promise<DeletedLayout | null>
  readonly restoreLayoutInternal: (doc: DeletedLayout) => Promise<unknown>
  // renders: captureComposite resolves (the engine track makes it a Promise for WebGPU; a value works too)
  readonly captureComposite: (opts: { readonly maxPx: number; readonly quality: number }) => Shot | Promise<Shot>
  readonly postRender: (shot: Shot, opts: { readonly model: string; readonly prompt: string | undefined }) => Promise<RenderMeta>
  readonly renderViewInternal: (opts: { readonly model?: string; readonly prompt?: string | undefined; readonly keepRoom?: boolean }) => Promise<RenderMeta>
  readonly listRendersInternal: () => Promise<unknown>
  // errors, frames, projection
  readonly reportError: (msg: string, err?: unknown) => Error
  readonly onFrame: (fn: (dt: number) => void) => () => void
  readonly worldToScreen: (p: Vec3) => ScreenPoint
  readonly photoToClient: (px: number, py: number) => Vec2
}

// --- the stores (data.js) ---------------------------------------------------------------------------------------------------

export interface ScenesEvents {
  scenes: unknown
  ready: { readonly scene: SceneSummary }
  failed: { readonly scene: SceneSummary }
}
export interface ScenesStore {
  readonly events: Events<ScenesEvents>
  readonly refresh: () => Promise<unknown>
  readonly upload: (file: File, opts: { readonly onProgress: (loaded: number, total: number) => void }) => Promise<{ readonly scene: string }>
  readonly rename: (name: string, title: string) => Promise<unknown>
  readonly remove: (name: string) => Promise<unknown>
  readonly getScenes: () => readonly SceneSummary[]
  readonly getScene: (name: string | null) => SceneSummary | null
  readonly getState: () => { readonly loaded: boolean; readonly offline: boolean }
}

/** A job of the library manager (§2.8 Jobs). */
export interface LibJob {
  readonly id: string
  readonly kind?: string | null
  readonly item_id: string
  readonly status?: string | null
  readonly message?: string | null
  readonly cost_usd?: number | null
  readonly cost_usd_estimate?: number | null
  readonly mock?: boolean | null
  readonly item?: LibItem | null
}
export interface TrashedItem {
  readonly id: string
  readonly name?: string | null
}
export interface Spend {
  readonly spent_usd?: number | null
  readonly reserved_usd?: number | null
  readonly cap_usd?: number | null
}
export interface LibState {
  readonly api: boolean | null
  readonly jobs: readonly LibJob[]
  readonly trash: readonly TrashedItem[]
  readonly spend: Spend | null
}
export interface LibEvents {
  jobs: unknown
  'job-done': { readonly job: LibJob }
  'job-failed': { readonly job: LibJob }
  spend: unknown
  trash: unknown
}
export interface LibraryStore {
  readonly events: Events<LibEvents>
  readonly getState: () => LibState
  readonly spend: () => Promise<unknown>
  readonly addFromFile: (file: File, meta: AddMeta) => Promise<LibJob | null>
  readonly addFromUrl: (url: string, meta: AddMeta) => Promise<LibJob | null>
  /** §2.11: the server's answer (untyped JSON: productsrc parses it); rejects with the server's sentence, plus blocked. */
  readonly readProduct: (url: string, opts: { readonly html: string } | undefined) => Promise<unknown>
  readonly edit: (id: string, patch: EditPatch) => Promise<{ readonly kind?: string | null } | null | undefined>
  readonly remove: (id: string) => Promise<unknown>
  readonly restore: (id: string) => Promise<unknown>
}

// --- what each area adds to the context, and the context --------------------------------------------------------------------

export interface WorkspaceApi {
  readonly requestRender: () => void
  readonly setAdjust: (on: boolean) => void
}
export interface ScenesPageApi {
  readonly open: () => void
  readonly pick: () => void
  readonly upload: (file: File) => Promise<void>
}
export interface LibraryPanelApi {
  readonly openAdd: () => void
}
export interface PendingRender {
  readonly id: string
  readonly model: string
  readonly started: number
  readonly state: 'rendering' | 'failed'
  readonly error: string | undefined
}
export interface RendersApi {
  readonly openConfirm: (opts?: { readonly from?: RenderMeta | null }) => Promise<void>
  readonly openViewer: (which: string | RenderMeta | null | undefined) => void
  readonly openCompare: (a: string, b: string) => Promise<void>
  readonly getPending: () => PendingRender[]
  readonly events: EventTarget
}

/** ctx: what planner/main.js passes to every area's mount(ctx); the areas add their own APIs to it. */
export interface UiContext {
  readonly engine: Engine
  readonly scenes: ScenesStore
  readonly lib: LibraryStore
  readonly shell: Shell
  readonly icons: typeof Icons
  readonly kit: typeof Kit
  workspace?: WorkspaceApi
  scenesPage?: ScenesPageApi
  library?: LibraryPanelApi
  renders?: RendersApi
}

// --- helpers and constants from engine.js and data.js -------------------------------------------------------------------------

export interface RenderModel {
  readonly label: string
  readonly price: (megapixels: number) => number
}
/** Something with a title, a creation date or a name (sceneTitle reads them in that order). */
export interface Titled {
  readonly title?: string | null
  readonly created?: string | null
  readonly name?: string | null
}
export interface LibPrice {
  readonly idol: number
  readonly sam3d: number
  readonly trellis2: { readonly 512: number; readonly 1024: number; readonly 1536: number }
}

/** "80 × 50 × 120 cm" ("" without a size). */
export const dimsText: (d: Dims | null | undefined) => string = engineJs.dimsText
/** Lets a promise go: its rejection was reported already. */
export const quiet: (p: unknown) => void = engineJs.quiet
/** The highest a piece may hang, in meters (§2.10). */
export const MAX_ELEVATION: number = engineJs.MAX_ELEVATION
/** The camera block's ranges (§4.1). */
export const CAMERA_RANGE: Readonly<Record<CameraKey, readonly number[]>> = engineJs.CAMERA_RANGE
export const SLUG: RegExp = engineJs.SLUG
/** The render models, the default first (§4.7). */
export const RENDER_MODELS: Readonly<Record<string, RenderModel>> = engineJs.RENDER_MODELS
export const renderPrice: (model: string, shot: { readonly width: number; readonly height: number } | null) => number = engineJs.renderPrice
export const fmtUsd: (v: number) => string = engineJs.fmtUsd
export const sceneTitle: (s: Titled | null | undefined) => string = dataJs.sceneTitle
export const relDate: (when: string | null | undefined) => string = dataJs.relDate
export const friendlyDate: (when: string | null | undefined) => string = dataJs.friendlyDate
export const fmtBytes: (n: number) => string = dataJs.fmtBytes
export const estimateCost: (meta: AddMeta, kind: 'image' | 'model') => number = dataJs.estimateCost
export const LIB_PRICE: LibPrice = dataJs.LIB_PRICE
export const DEFAULT_IMAGE_ENGINE: string = dataJs.DEFAULT_IMAGE_ENGINE
