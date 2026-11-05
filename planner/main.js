// midstudy planner entry: the engine (engine.js) and its input (input.js), the scenes and library stores (data.js), the
// shell (ui/shell.js) and the area modules that fill it, plus the window.midstudy test hook. Spec: contract/CONTRACT.md
// §2.4 and §4.6. Every UI module exports mount(ctx), ctx = { engine, scenes, lib, shell, icons, kit }.
import { engine } from './engine.js'
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

engine.input = installInput(engine)
const shell = createShell({ engine })
engine.mount(shell.mounts.view)
const scenes = createScenes({ engine })
const lib = createLibrary({ engine })
const ctx = { engine, scenes, lib, shell, icons, kit }
window.midstudyCtx = ctx // for manual checks from the console; evals use window.midstudy only

// Panels register in rail/dock order: Library, In scene, Layouts, Scene, Renders.
for (const [name, mod] of Object.entries({ workspace, library, inscene, layouts, scene: scenePanel, renders, scenes: scenesPage })) {
  try { mod.mount(ctx) } catch (e) { engine.reportError(`Could not set up the ${name} UI`, e) }
}

// Engine messages become toasts (errors stay until closed).
engine.events.addEventListener('toast', (e) => shell.toast(e.detail.text, { kind: e.detail.kind, ms: e.detail.kind === 'error' ? 0 : e.detail.ms }))
engine.events.addEventListener('error', (e) => shell.toast(e.detail.text, { kind: 'error' }))

// Unsaved camera, look or layout: ask before leaving the page.
window.addEventListener('beforeunload', (e) => {
  if (!engine.isSceneDirty() && !engine.isLayoutDirty()) return
  e.preventDefault()
  e.returnValue = ''
})

let readyResolve
const ready = new Promise((r) => { readyResolve = r })
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => r()))

// --- window.midstudy test hook (contract §2.4, §4.6) ----------------------------------------------------------------
window.midstudy = {
  ready,
  errors: engine.errors,
  // library and items (§2.4)
  getLibrary: () => engine.getLibrary(),
  addItem: (id, opts) => {
    const o = opts || {}
    return engine.addItemInternal(id, { position: o.position, rotation_y_deg: o.rotation_y_deg })
  },
  moveItem: (uid, opts) => engine.moveItemInternal(uid, opts),
  selectItem: (uid) => engine.select(uid ?? null),
  removeItem: (uid) => engine.removeItemInternal(uid),
  clearItems: () => engine.clearItemsInternal(),
  // layouts (per scene, §2.7)
  saveLayout: (name, opts) => engine.saveLayoutInternal(name, opts), // opts.title: the name as typed (optional)
  loadLayout: (name) => engine.loadLayoutInternal(name),
  listLayouts: () => engine.listLayoutsInternal().catch((e) => { throw engine.reportError('Could not list layouts', e) }),
  getState: () => engine.getState(),
  // look and renders (§2.6, §4.7)
  getRenderSettings: () => engine.getRenderSettings(),
  setRenderSettings: (s) => {
    if (!s || typeof s !== 'object') { engine.reportError('setRenderSettings needs an object'); return }
    if (s.exposure !== undefined || s.warmth !== undefined) engine.setLook(s)
    if (typeof s.contactShadows === 'boolean') engine.setContactShadows(s.contactShadows)
  },
  renderView: (opts) => engine.renderViewInternal(opts),
  listRenders: () => engine.listRendersInternal(),
  compare: (a, b) => engine.compare(a, b),
  // the library manager (§2.8)
  libraryJobs: () => lib.jobs(),
  addItemFromFile: (file, meta) => lib.addFromFile(file, meta),
  addItemFromUrl: (url, meta) => lib.addFromUrl(url, meta),
  readProductPage: (url, opts) => lib.readProduct(url, opts), // §2.11: the 200 body; adds nothing
  editLibraryItem: (id, patch) => lib.edit(id, patch),
  removeLibraryItem: (id) => lib.remove(id).then(() => {}),
  restoreLibraryItem: (id) => lib.restore(id),
  // scenes (§4.6)
  listScenes: () => engine.listScenesInternal(),
  createScene: (file, meta) => engine.createScene(file, meta),
  waitForScene: (name) => engine.waitForScene(name),
  openScene: async (name) => {
    shell.closePage()
    await engine.openScene(name)
    await nextFrame()
  },
  deleteScene: (name) => engine.deleteScene(name),
  getCamera: () => engine.getCamera(),
  setCamera: (partial) => engine.setCamera(partial),
  resetCamera: () => engine.resetCamera(),
  saveScene: () => engine.saveScene(),
  setAdjustFloor: (on) => engine.setAdjustFloor(!!on),
  setOcclusion: (on) => engine.setOcclusion(!!on),
  getScreenRect: (uid) => engine.getScreenRect(uid),
  photoToFloor: (px, py) => engine.photoToFloor(px, py),
  floorToPhoto: (p) => engine.floorToPhoto(p),
}

// First state (§4.5): ?scene=<name>, else the scene last opened on this device, else the Scenes page.
engine.init()
  .then((opened) => { if (!opened) shell.openPage('scenes') })
  .catch((e) => engine.reportError('Startup failed', e))
  .finally(async () => { await nextFrame(); readyResolve() })
scenes.start().catch(() => {})
lib.start().catch(() => {})
