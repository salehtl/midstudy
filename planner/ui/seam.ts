// The UI's seam with the rest of the planner: the context planner/main.ts passes to every area's mount(ctx), and what
// the UI uses of the engine (engine.ts), the scenes and library stores (data.ts) and the server's JSON (wire.ts),
// re-exported from where it is defined. Nothing here is declared twice: tsc checks the UI against the real engine and
// stores, and main.ts builds the context as a UiContext.
import type { Engine } from '../engine.js'
import type { Library, Scenes } from '../data.js'
import type { Camera } from '../logic/camera.js'
import type * as Icons from './icons.js'
import type * as Kit from './kit.js'
import type { Shell } from './shell.js'
import type { Keymap } from '../keymap.js'

export type { DeletedLayout, Engine, ItemInfo, ItemSnapshot, LightingReport, Shot } from '../engine.js'
export type { Library } from '../data.js'
export type { LayoutSummary, LibraryEntry, LibraryJob, RenderMeta, RoomInfo, SceneSummary, Spend, TrashedItem, TrashedRoom, TrashedScene } from '../wire.js'
export type { DimsCm } from '../logic/text.js'
export { CAMERA_RANGE, MAX_ELEVATION, RENDER_MODELS, dimsText, fmtUsd, quiet, renderPrice, upscalePrice } from '../engine.js'
export { DEFAULT_IMAGE_ENGINE, LIB_PRICE, clock, estimateCost, fmtBytes, friendlyDate, relDate, sceneTitle, shortDate } from '../data.js'
export { isLibraryJob } from '../wire.js'
export { isRenderModel } from '../logic/money.js'
export { clampLook, horizonDragGain, horizonDragRow, wrapDeg } from '../../core/js/web.js'

/** A field of the camera block (contract §4.1), and a change to some of them (engine.setCamera). */
export type CameraKey = keyof Camera
export type CameraPatch = Partial<Camera>

/** What the workspace adds to the context (ui/workspace.ts): the Scene panel opens Adjust floor through it. */
interface WorkspaceApi {
  readonly setAdjust: (on: boolean) => void
  /** the stage (the part of the window the photo uses) again: a room view's strip or floor plan changed (ui/room.ts) */
  readonly syncStage: () => void
}

/** What the Shortcuts sheet adds (ui/shortcuts.ts). */
interface ShortcutsApi {
  readonly open: () => void
  readonly close: () => void
  readonly toggle: () => void
  readonly isOpen: () => boolean
}
/** What Export adds (ui/export.ts): the sheet, and an export without it (E17). */
export interface ExportOptions {
  readonly size?: string
  readonly format?: string
  readonly layout?: string
  readonly quality?: number
}
interface ExporterApi {
  readonly open: () => void
  readonly exportNow: (opts?: ExportOptions) => Promise<{ blob: Blob; name: string; width: number; height: number }>
}
/** What Settings adds (ui/settings.ts). */
interface SettingsApi {
  readonly open: () => void
}
/** What the room view adds (ui/room.ts): the floor plan's page point of a room-frame floor point (CSS px; null while
 *  the plan is hidden), and showing it. */
interface FloorPlanApi {
  readonly pointOf: (p: unknown) => { readonly x: number; readonly y: number } | null
  readonly show: (on: boolean) => void
  /** what the photo strip (top) and the plan (right on desktop; bottom on the phone, from the window's bottom) cover, CSS px */
  readonly insets: () => { readonly top: number; readonly right: number; readonly bottom: number }
}

/** ctx: what planner/main.ts passes to every area's mount(ctx); the workspace, the Shortcuts sheet, Export and Settings
 *  add their APIs to it. keys: the keymap every shortcut registers in (keymap.ts). */
export interface UiContext {
  readonly engine: Engine
  readonly scenes: Scenes
  readonly lib: Library
  readonly shell: Shell
  readonly icons: typeof Icons
  readonly kit: typeof Kit
  readonly keys: Keymap
  workspace?: WorkspaceApi
  shortcuts?: ShortcutsApi
  exporter?: ExporterApi
  settings?: SettingsApi
  floorPlan?: FloorPlanApi
}
