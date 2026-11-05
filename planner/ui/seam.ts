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

export type { DeletedLayout, Engine, ItemInfo, ItemSnapshot, LightingReport, Shot } from '../engine.js'
export type { Library } from '../data.js'
export type { LayoutSummary, LibraryEntry, LibraryJob, RenderMeta, SceneSummary, Spend, TrashedItem, TrashedScene } from '../wire.js'
export type { DimsCm } from '../logic/text.js'
export { CAMERA_RANGE, MAX_ELEVATION, RENDER_MODELS, SLUG, dimsText, fmtUsd, quiet, renderPrice } from '../engine.js'
export { DEFAULT_IMAGE_ENGINE, LIB_PRICE, estimateCost, fmtBytes, friendlyDate, relDate, sceneTitle } from '../data.js'
export { isLibraryJob } from '../wire.js'
export { isRenderModel } from '../logic/money.js'

/** A field of the camera block (contract §4.1), and a change to some of them (engine.setCamera). */
export type CameraKey = keyof Camera
export type CameraPatch = Partial<Camera>

/** What the workspace adds to the context (ui/workspace.ts): the Scene panel opens Adjust floor through it. */
interface WorkspaceApi {
  readonly setAdjust: (on: boolean) => void
}

/** ctx: what planner/main.ts passes to every area's mount(ctx); the workspace adds its API to it. */
export interface UiContext {
  readonly engine: Engine
  readonly scenes: Scenes
  readonly lib: Library
  readonly shell: Shell
  readonly icons: typeof Icons
  readonly kit: typeof Kit
  workspace?: WorkspaceApi
}
