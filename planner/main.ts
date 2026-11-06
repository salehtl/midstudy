// midstudy planner entry: the engine (engine.ts) and its input (input.ts), the scenes and library stores (data.ts), the
// shell (ui/shell.ts) and the area modules that fill it, plus the window.midstudy test hook. Spec: contract/CONTRACT.md
// §2.4 and §4.6. Every UI module exports mount(ctx), ctx: UiContext = { engine, scenes, lib, shell, icons, kit }
// (ui/seam.ts).
import { engine } from './engine.js'
import type { PlannerState, RenderSettings } from './engine.js'
import { installInput } from './input.js'
import { createScenes, createLibrary } from './data.js'
import { createShell } from './ui/shell.js'
import * as icons from './ui/icons.js'
import * as kit from './ui/kit.js'
import * as workspace from './ui/workspace.js'
import * as library from './ui/panels/library.js'
import * as inscene from './ui/panels/inroom.js'
import * as layouts from './ui/panels/layouts.js'
import * as scenePanel from './ui/panels/scene.js'
import * as renders from './ui/panels/renders.js'
import * as scenesPage from './ui/scenes.js'
import type { UiContext } from './ui/seam.js'
import { renderSettingsArgs } from './logic/messages.js'

engine.input = installInput(engine)
const shell = createShell({ engine })
engine.mount(shell.mounts.view)
const scenes = createScenes({ engine })
const lib = createLibrary({ engine })
const ctx: UiContext = { engine, scenes, lib, shell, icons, kit }

declare global {
  interface Window {
    /** for manual checks from the console; evals use window.midstudy only (and read the photo rect from here) */
    midstudyCtx: UiContext
    /** the test hook (contract §2.4, §4.6) */
    midstudy: typeof hook
  }
}
window.midstudyCtx = ctx

// Panels register in rail/dock order: Library, In scene, Layouts, Scene, Renders.
const areas: [string, { mount: (c: UiContext) => void }][] = [
  ['workspace', workspace], ['library', library], ['inscene', inscene], ['layouts', layouts], ['scene', scenePanel], ['renders', renders], ['scenes', scenesPage],
]
for (const [name, mod] of areas) {
  try { mod.mount(ctx) } catch (e) { engine.reportError(`Could not set up the ${name} UI`, e) }
}

// Engine messages become toasts (errors stay until closed).
engine.events.addEventListener('toast', (e) => {
  const { text, kind, ms } = e.detail
  shell.toast(text, { kind, ms: kind === 'error' ? 0 : ms })
})
engine.events.addEventListener('error', (e) => { shell.toast(e.detail.text, { kind: 'error' }) })

// Unsaved camera, look or layout: ask before leaving the page.
window.addEventListener('beforeunload', (e) => {
  if (!engine.isSceneDirty() && !engine.isLayoutDirty()) return
  e.preventDefault()
  Reflect.set(e, 'returnValue', '') // v1 set it too (the legacy way some browsers still ask with)
})

let readyResolve: () => void = () => undefined
const ready = new Promise<void>((r) => { readyResolve = r })
const nextFrame = (): Promise<void> => new Promise((r) => { requestAnimationFrame(() => { r() }) })
const isObject = (x: unknown): x is Readonly<Record<string, unknown>> => typeof x === 'object' && x !== null

// --- window.midstudy test hook (contract §2.4, §4.6) ----------------------------------------------------------------
const hook = {
  ready,
  errors: engine.errors,
  // library and items (§2.4)
  getLibrary: () => engine.getLibrary(),
  addItem: (id: unknown, opts?: unknown) => {
    const o = isObject(opts) ? opts : {}
    return engine.addItemInternal(id, { position: o['position'], rotation_y_deg: o['rotation_y_deg'] })
  },
  moveItem: (uid: unknown, opts: unknown) => { engine.moveItemInternal(uid, opts) },
  selectItem: (uid: unknown) => { engine.select(uid ?? null) },
  removeItem: (uid: unknown) => { engine.removeItemInternal(uid) },
  clearItems: () => { engine.clearItemsInternal() },
  // layouts (per scene, §2.7)
  saveLayout: (name: unknown, opts?: unknown) => engine.saveLayoutInternal(name, opts), // opts.title: the name as typed (optional)
  loadLayout: (name: unknown) => engine.loadLayoutInternal(name),
  listLayouts: () => engine.listLayoutsInternal().catch((e: unknown) => { throw engine.reportError('Could not list layouts', e) }),
  getState: (): PlannerState => engine.getState(),
  // look and renders (§2.6, §4.7)
  getRenderSettings: (): RenderSettings => engine.getRenderSettings(),
  setRenderSettings: (s: unknown) => {
    if (!isObject(s)) { engine.reportError('setRenderSettings needs an object'); return }
    const a = renderSettingsArgs(s['exposure'], s['warmth'], s['contactShadows'])
    if (a.look) engine.setLook(s)
    if (a.contactShadows !== null) engine.setContactShadows(a.contactShadows)
  },
  // lighting inferred from the photo (§4.8)
  getLighting: () => engine.getLighting(),
  setLighting: (partial: unknown) => { engine.setLighting(partial) },
  resetLighting: () => { engine.resetLighting() },
  renderView: (opts?: unknown) => engine.renderViewInternal(opts),
  listRenders: () => engine.listRendersInternal(),
  compare: (a: unknown, b: unknown) => { engine.compare(a, b) },
  // the library manager (§2.8)
  libraryJobs: () => lib.jobs(),
  addItemFromFile: (file: unknown, meta?: unknown) => lib.addFromFile(file, meta),
  addItemFromUrl: (url: unknown, meta?: unknown) => lib.addFromUrl(url, meta),
  readProductPage: (url: unknown, opts?: unknown) => lib.readProduct(url, opts), // §2.11: the 200 body; adds nothing
  editLibraryItem: (id: unknown, patch?: unknown) => lib.edit(id, patch),
  removeLibraryItem: (id: unknown) => lib.remove(id).then(() => undefined),
  restoreLibraryItem: (id: unknown) => lib.restore(id),
  // scenes (§4.6)
  listScenes: () => engine.listScenesInternal(),
  createScene: (file: unknown, meta?: unknown) => engine.createScene(file, meta),
  waitForScene: (name: unknown) => engine.waitForScene(name),
  openScene: async (name: unknown) => {
    shell.closePage()
    await engine.openScene(name)
    await nextFrame()
  },
  deleteScene: (name: unknown) => engine.deleteScene(name),
  getCamera: () => engine.getCamera(),
  setCamera: (partial: unknown) => { engine.setCamera(partial) },
  resetCamera: () => { engine.resetCamera() },
  saveScene: () => engine.saveScene(),
  setAdjustFloor: (on: unknown) => { engine.setAdjustFloor(!!on) },
  setOcclusion: (on: unknown) => { engine.setOcclusion(!!on) },
  getScreenRect: (uid: unknown) => engine.getScreenRect(uid),
  photoToFloor: (px: unknown, py: unknown) => engine.photoToFloor(px, py),
  floorToPhoto: (p: unknown) => engine.floorToPhoto(pointOf(p)),
}
/** The hook's floorToPhoto takes [x, y, z] (or {x, y, z}); anything else projects as NaN, as v1's did. */
function pointOf(p: unknown): readonly number[] | { x: number; y: number; z: number } {
  if (Array.isArray(p)) return p.map((v: unknown) => (typeof v === 'number' ? v : Number(v)))
  if (isObject(p)) {
    const n = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN)
    return { x: n(p['x']), y: n(p['y']), z: n(p['z']) }
  }
  return [Number.NaN, Number.NaN, Number.NaN]
}
window.midstudy = hook

// First state (§4.5): ?scene=<name>, else the scene last opened on this device, else the Scenes page.
engine.init()
  .then((opened) => { if (!opened) shell.openPage('scenes') })
  .catch((e: unknown) => engine.reportError('Startup failed', e))
  .finally(async () => { await nextFrame(); readyResolve() })
scenes.start().catch(() => undefined)
lib.start().catch(() => undefined)
