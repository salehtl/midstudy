// midstudy planner engine: the photo, the locked scene camera registered to it, the furniture drawn over it, and the
// API calls. No DOM UI lives here: UI modules (planner/ui/) read state through getters, call actions, and listen to
// `engine.events`. Spec: contract/CONTRACT.md §2 (carried from nook) and §4 (scenes). Units are meters, Y-up, the floor
// is y = 0, the camera stands at (0, height, 0) and looks along −Z (contract §4.1). Items are stored in their item frame.
//
// v2: a strict TypeScript shell around three things. The pure decisions are planner/logic/*.ts (TScert-certified:
// the Look's merge and report, the view maths, layouts' dirty state, the landing choice, messages, prices). The maths is the
// Rust kernels (core/js/web.ts: the §4.1 projection and its inverse, the horizon, landing, hit hulls, bounds, screen
// rects, drags, the ruler, SH rotation, the splats' colour level and the warmth tint, and the small maths the contract's
// rules are made of: the camera block's ranges, default and clamp, the Look's clamps, the angle wraps, v1's round, the
// elevation range, the rotate step and the occlusion depth's scale), with depth.png decoded in a worker
// (planner/engine.worker.ts). three.js stays where three needs it (rendering, loading, raycasting meshes).
//
// The renderer is three.js's WebGPURenderer: WebGPU where the browser has it, its WebGL2 backend otherwise (no
// adapter, or ?webgpu=0). Every pass is TSL (planner/gpu/passes.ts), so one code path compiles to both; the frame's
// order is planner/engine.passes.ts. The output colour space is linear and there is no tone mapping at the output: the
// passes write sRGB bytes themselves.
//
// Drawing (each frame, on demand; engine.passes.ts drawFrame):
//   1. furniture pass, into a half-float MSAA target: an optional depth pre-pass writes the photo's depth (depth.png,
//      + 3 cm) into the depth buffer with colour writes off, then the pieces, their contact shadows and the floor grid
//      draw on top of it (so the real sofa hides a piece behind it);
//   2. splat pass (only while splat items are placed, §4.5 Splats): planner/gpu/splat-layer.ts draws every placed
//      splat into its own half-float target over the photo's depth and the pieces' meshes (depth only), so splats test
//      against both (3 cm tolerance, like meshes) and write none; sorted back to front on the GPU (WebGPU: a compute
//      radix sort) or in a worker (planner/gpu/sort.worker.ts). Their GLB (the stand-in box for idol) is in the scene but
//      invisible: it picks, drags, bounds and casts the contact shadow.
//   3. the screen: the photo, drawn exactly as its bytes are (no tone mapping, exposure or warmth), contain-fit in the
//      uncovered part of the window (letterbox bars), then the furniture pass composited over it with the Look
//      (exposure, warmth), ACES Filmic and sRGB applied to the furniture only, then the splat pass over that: splat
//      colours are photo colours, so only exposure × warmth applies to them, as a plain multiplier (no ACES). Contact
//      shadows live in the furniture pass, so they never darken a splat.
//   Zoom and pan are 2D (camera.setViewOffset over the photo's rectangle); the camera block never changes for them.
//   Renders capture the same passes at the photo's own resolution (no view offset, no UI), splats sorted first; the
//   read-back is asynchronous on both backends, so the view holds still meanwhile.
//
// Coordinates: "photo px" are contract §4.1 pixels on photo.jpg at its full size; "client px" are CSS pixels in the
// window. photoToFloor() and floorToPhoto() implement §4.1 exactly (the kernels); picking uses the same rays.
//
// The engine object (Engine = typeof engine; the UI's types come from here and planner/wire.ts, through ui/seam.ts)
// State getters
//   getScene()          SceneInfo: the scene object, calib (calib.json's public part), w, h, camera, camera_source,
//                       hasDepth | null
//   getSceneLoad()      { loading, phase: 'calibrating'|'photo'|null, name, scene (the §4.4 object while it calibrates) }
//   getCamera(), getCameraSource(), getSavedScene()   the camera block in use (§4.1), its source, the scene as saved
//   getAdjustFloor(), getOcclusion(), getGridVisible(), getFloorNote() (the "Check the floor" reason, or null)
//   getView()           { zoom, cx, cy, fit } zoom 1–4; cx, cy the photo px at the stage centre
//   getPhotoRect(), getVisiblePhotoRect()   the photo's rectangle in client px (beyond the window when zoomed), cut to
//                       the stage; getPhotoSize() { w, h, has }
//   isSceneDirty() / isLayoutDirty()
//   getSelection() (every selected piece, the primary last) / isSelected(uid) / selectMany(uids) / selectAll() /
//   nudgeSelected([dx, dy, dz]) / duplicateSelected() / restoreItems(snaps) / exportImage({ longEdge, type, quality, encode })
//   getItems() / getItem(uid) / getSelected() (the primary) / getDrag() / getFootprint(uid) / getElevation(uid) / getScreenRect(uid)
//   hitItemAt(uid, x, y, pad), itemAt(x, y)   the placed piece under a client point
//   getLibrary(), assetUrl(rel), getLayoutDetails(), getLayoutName(), layoutDisplayName(slug), getRenders(), isRenderMock()
//   getScenesTrash()    deleted scenes the server keeps
//   getRuler()          { active, points: [[x,0,z]…], meters|null };   horizonAt(px)
//   getLighting(), getState(), getRenderSettings()   the window.midstudy shapes (contract §2.4, §4.6, §4.8)
// Actions (async ones return Promises that reject with a reported error)
//   init(), mount(el), setStageInsets({ left, right, top, bottom }) (client px the chrome covers)
//   listScenesInternal(), openScene(name) (also loads the layout last open there on this device), closeScene(),
//   waitForScene(name), createScene(file, meta), deleteScene(name), restoreScene(name), renameScene(name, title),
//   saveScene(), recalibrate()
//   setCamera(partial), resetCamera(), setAdjustFloor(on), setOcclusion(on), setGridVisible(on), setPitchFromHorizon(py)
//   zoomAt(clientX, clientY, zoom), zoomBy(factor, clientX?, clientY?), panBy(dxClient, dyClient), fitView()
//   addItemInternal(id, opts), moveItemInternal(uid, opts), removeItemInternal(uid), clearItemsInternal(), select(uid|null),
//   rotateSelected(deg), setSnap(on), beginItemDrag / beginRotateDrag / dragTo / endItemDrag, removeItemWithUndo(uid),
//   restoreItem(snapshot), setElevation(uid, m), nudgeElevation(uid, dm), dropToFloor(uid), reloadLibrary()
//   tap(clientX, clientY), setRulerActive(on), setRulerPointAt(i, x, y), setRulerTrueLength(m) (scales the camera height)
//   setLook({exposure, warmth}), setContactShadows(on), setLighting(partial), resetLighting(), inferLighting()
//   saveLayoutInternal(name, { title }), loadLayoutInternal(name), deleteLayoutInternal(name) → the doc (for Undo),
//   restoreLayoutInternal(doc), listLayoutsInternal()
//   captureComposite({ maxPx, quality }) → Promise<Shot>, postRender(shot, opts), renderViewInternal(opts),
//   listRendersInternal(), compare(a, b)
//   reportError(msg, err) → Error, onFrame(fn), worldToScreen(p) → { x, y, visible } (client px), photoToFloor(px, py),
//   floorToPhoto(p), photoToClient(px, py)
// Events (engine.events: a typed Bus, planner/bus.ts; e.detail is EngineEvents[name])
//   'scene'  { phase: 'loading'|'calibrating'|'opened'|'failed'|'closed'|'saved'|'title'|'deleted', name }
//   'scenes' { scenes }   'camera' { camera, source }   'adjust' { on }   'occlusion' { on }   'grid' { visible }
//   'view' getView()      'dirty' { scene, layout }     'items' { change, uid }   'selection' { uid, uids }   'drag' { mode, uid, phase }
//   'look' { exposure, warmth, contactShadows }   'library' { items }   'layouts' { names?, details?, name? }   'renders' { renders }
//   'render' { phase: 'start'|'done'|'failed', model, meta? }   'compare' { a, b }   'ruler' getRuler()
//   'error' { text }      'toast' { text, kind, ms }   'lighting' { status, error }
// Performance marks (E17): performance.measure 'midstudy:<step>' for scene-open, photo, depth-decode, envmap (lighting.ts),
// item-add, render-capture and mask-build.
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import {
  DEFAULT_CAMERA, KernelWorker, SceneCamera, azElOf, boxCorners as kBoxCorners, clampCamera as kClampCamera, clampElevation,
  clampLook, decodeDepth, depthScale as kDepthScale, dirOf, dragHeight as kDragHeight, dragLift, dragMove, dragRotate,
  footprint as kFootprint, gripAngle, kernelsLoaded, keepRoomMask, liftPlane, loadKernels, rotateBy, roundTo, rulerRescale, splatMultiplier,
  worldBounds as kWorldBounds, wrapAz, wrapDeg,
} from '../core/js/web.js'
import type { DepthMap, ItemBox, KeepRoomMask, Plane, Rect } from '../core/js/web.js'
import { V1_KEY_DIR, V1_SOFTNESS, createLighting } from './lighting.js'
import {
  SHADOW_Y, captureTarget, createPasses, drawFrame, drawMask, makeContactShadow, maskTarget, noRaycast, onDepthLayer, readRgba, setScreen,
  setSplatSource, sizeTargets, withFullFrame,
} from './engine.passes.js'
import { clearTarget, createFrame, createFurnitureComposite, depthTexture, photoTexture, render, setFrame } from './gpu/passes.js'
import { decodeSplat } from './gpu/splat-data.js'
import type { SplatData } from './gpu/splat-data.js'
import { SplatLayer } from './gpu/splat-layer.js'
import * as cameraLogic from './logic/camera.js'
import type { Camera } from './logic/camera.js'
import * as layoutLogic from './logic/layout.js'
import type { LayoutDetail, LayoutDocItem, Recalled } from './logic/layout.js'
import * as libLogic from './logic/library.js'
import type { LibView } from './logic/library.js'
import * as lookLogic from './logic/look.js'
import type { LightingReport, LightingStatus, LookState, LookView, ResolvedLook } from './logic/look.js'
import * as msg from './logic/messages.js'
import * as money from './logic/money.js'
import type { RenderModel } from './logic/money.js'
import * as num from './logic/num.js'
import * as selLogic from './logic/selection.js'
import type { JsonObject, Kernels } from './logic/num.js'
import * as sceneLogic from './logic/scenes.js'
import * as roomLogic from './logic/room.js'
import type { Pose } from './logic/room.js'
import * as text from './logic/text.js'
import type { DimsCm } from './logic/text.js'
import * as viewLogic from './logic/view.js'
import type { Box, ViewReport, ViewState, Xform } from './logic/view.js'
import { Bus } from './bus.js'
import type { Events } from './bus.js'
import { alignJob, layoutSummaries, libraryEntries, libraryEntry, renderMeta, renderMetas, roomInfo, roomInfos, sceneCreated, sceneSummaries, sceneSummary, trashedRooms, trashedScenes, calibInfo } from './wire.js'
import type { AlignJobInfo, CalibInfo, LayoutSummary, LibraryEntry, RenderMeta, RoomInfo, SceneSummary, TrashedRoom, TrashedScene } from './wire.js'

/** The engine's value types (planner/logic/, planner/wire.ts). */
export type { Camera, LightingReport, LibraryEntry, RenderMeta }
type Vec3 = [number, number, number]

/** The slug every id, layout and scene name is (CLAUDE.md conventions). */
const SLUG = layoutLogic.SLUG
const DEG = Math.PI / 180

/** A non-empty string, else null. */
const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null)

const params = new URLSearchParams(location.search)
/** §2.2: ?library=<url>, default /library/library.json. */
const LIBRARY_URL = str(params.get('library')) ?? '/library/library.json'
const libraryBase = new URL(LIBRARY_URL, location.href)

/** A deep copy of plain JSON data (v1's clone). */
function clone<T>(o: T): T {
  return o === null || o === undefined ? o : structuredClone(o)
}
const isNum = num.isNum
/** "W × D × H cm" (v1's dimsText). */
export const dimsText = (d: DimsCm | null | undefined): string => text.dimsText(d)
/** Fire-and-forget wrapper for UI handlers: failures are already reported, never thrown. */
export function quiet(p: unknown): void {
  Promise.resolve(p).catch(() => undefined)
}

/** A request's options as the planner makes them (plain-object headers). */
export interface Req {
  method?: string
  headers?: Record<string, string>
  body?: BodyInit
  keepalive?: boolean
}
/** §2.9: every POST, PUT, PATCH and DELETE the page makes carries X-Midstudy: 1 (the server refuses it otherwise). */
export function withMidstudy(opts: Req = {}): Req {
  if (!msg.needsMidstudyHeader(str(opts.method) ?? 'GET')) return opts
  return { ...opts, headers: { ...(opts.headers ?? {}), 'X-Midstudy': '1' } }
}
/** §2.10: an item's bottom at most this far above the floor (m). */
export const MAX_ELEVATION = num.MAX_ELEVATION

// --- the kernels' small maths (core/js/web.ts): the logic takes them as parameters (logic/num.ts Kernels) ----------
const K: Kernels = { roundTo, wrapDeg, wrapAz, clampLook }

// --- the camera block (contract §4.1): the ranges, the default and the clamp are the kernels' -----------------------
/** Every writer clamps to these (§4.1), [lo, hi]. */
export { CAMERA_RANGE } from '../core/js/web.js'
/** v1's clampCamera(c, base) on JSON: the kernels' clamp (each field clamped and rounded to 6 decimals); a field that
 * isn't a finite number takes base's. */
function clampCamera(c: unknown, base: Camera = DEFAULT_CAMERA): Camera {
  const o = rec(c)
  const field = (k: keyof Camera): number => { const v = o?.[k]; return typeof v === 'number' ? v : Number.NaN }
  return kClampCamera({ fov_y_deg: field('fov_y_deg'), height_m: field('height_m'), pitch_deg: field('pitch_deg'), roll_deg: field('roll_deg') }, base)
}

// --- small typed helpers for JSON from the server -------------------------------------------------------------------
function isRecord(x: unknown): x is JsonObject {
  return typeof x === 'object' && x !== null
}
// three's classes narrowed with their default type parameters (instanceof would give Mesh<any, any, any>).
const isMesh = (o: unknown): o is THREE.Mesh => o instanceof THREE.Mesh
const isLine = (o: unknown): o is THREE.Line => o instanceof THREE.Line
const isObject3D = (o: unknown): o is THREE.Object3D => o instanceof THREE.Object3D
/** A JSON object the engine keeps and updates in place, as v1 did (library entries, the scenes list). */
const rec = (x: unknown): JsonObject | null => (isRecord(x) ? x : null)
/** v1 interpolated values into its messages as they were (`${x}`). */
function asText(x: unknown): string {
  if (typeof x === 'string') return x
  if (typeof x === 'number' || typeof x === 'boolean' || typeof x === 'bigint' || x === null || x === undefined) return String(x)
  if (Array.isArray(x)) return x.map((v) => (v === null || v === undefined ? '' : asText(v))).join(',')
  if (x instanceof Error) return `${x.name}${x.message ? `: ${x.message}` : ''}`
  return '[object Object]'
}

/** A request that failed: its HTTP status (null when the server didn't answer) and the server's JSON answer. */
export class RequestError extends Error {
  readonly status: number | null
  readonly offline: boolean
  readonly body: unknown
  constructor(message: string, status: number | null, offline: boolean, body: unknown) {
    super(message)
    this.status = status
    this.offline = offline
    this.body = body
  }
}
const statusOf = (e: unknown): number | null => (e instanceof RequestError ? e.status : null)

/** One step of E17's timeline: performance.measure('midstudy:<step>'). */
function measure(step: string, t0: number): void {
  try { performance.measure(`midstudy:${step}`, { start: t0, end: performance.now() }) } catch { /* no User Timing */ }
}

// --- events, errors + toasts ------------------------------------------------
/** What each engine event carries (engine.events, CustomEvent.detail). */
interface EngineEvents {
  scene: { phase: string; name: string | null }
  scenes: { scenes: SceneSummary[] }
  camera: { camera: Camera; source: string }
  adjust: { on: boolean; note?: string | null }
  occlusion: { on: boolean }
  grid: { visible: boolean }
  view: ViewReport
  dirty: { scene: boolean; layout: boolean }
  items: { change: 'add' | 'move' | 'remove' | 'render'; uid: string }
  selection: { uid: string | null; uids: string[] }
  drag: { mode: DragMode; uid: string; phase: 'start' | 'end' }
  look: LookView
  library: { items: LibraryEntry[] }
  layouts: { names?: string[]; details?: LayoutSummary[]; name?: string }
  renders: { renders: RenderMeta[] }
  render: { phase: 'start' | 'done' | 'failed'; model: string; meta?: RenderMeta; error?: string }
  compare: { a: string; b: string }
  ruler: RulerState
  error: { text: string }
  toast: { text: string; kind: msg.ToastKind; ms: number }
  lighting: LightingStatus
  /** the room view (§4.9): opened, photo (switched), members (poses or scales changed), pose (live, Align photos),
   *  aligning, aligned, align-failed, title, align-photos, floor-plan, deleted, restored, closed */
  room: { phase: string; name: string | null }
  rooms: { rooms: RoomInfo[] }
}
const events = new Bus<EngineEvents>()
function emit<K extends keyof EngineEvents>(name: K, detail: EngineEvents[K]): void {
  wake()
  events.emit(name, detail)
}
// On-demand rendering: draw while something changes (input, any engine event) and for a short tail after. A wake
// always gets at least one frame, however late the browser's next frame comes (a slow GPU, or software rendering
// where one frame can take longer than the tail): otherwise a change made just before a slow frame (Set scale, a
// toast, a layout loading) stayed undrawn until the pointer moved.
let awakeUntil = 0
let framePending = false
let holdFrames = 0 // > 0 while a capture holds the view (captureShot, captureMask)
function wake(ms = 400): void {
  awakeUntil = Math.max(awakeUntil, performance.now() + ms)
  framePending = true
}
for (const t of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'keyup', 'resize', 'touchmove']) window.addEventListener(t, () => { wake() }, { passive: true, capture: true })
const errors: string[] = []
function toast(textLine: string, kind: msg.ToastKind = 'info', ms = 6000): void {
  emit('toast', { text: textLine, kind, ms })
}
/** An error's own text (v1: err.message, else String(err)). */
function detailOf(err: unknown): string {
  if (!err) return ''
  const m: unknown = err instanceof Error ? err.message : isRecord(err) ? err['message'] : undefined
  return m ? asText(m) : asText(err)
}
function reportError(message: string, err?: unknown): Error {
  const line = text.errorLine(message, detailOf(err))
  errors.push(line)
  emit('error', { text: line })
  console.warn('[midstudy]', line)
  return new Error(line)
}
window.addEventListener('error', (e) => { if (e.error || e.message) reportError(`Unexpected error: ${e.message}`) })
window.addEventListener('unhandledrejection', (e) => {
  e.preventDefault()
  reportError('Unexpected error', e.reason)
})
const store = {
  get: (k: string): string | null => { try { return localStorage.getItem(k) } catch { return null } },
  set: (k: string, v: string | null): void => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v) } catch { /* private mode */ } },
}
const LAST_SCENE_KEY = 'midstudy.lastScene'

// --- the kernels (core/js/web.ts) ------------------------------------------------------------------------------------
// The wasm loads while the renderer and the lights are set up; the module waits for it before its first kernel call.
const kernelsReady = loadKernels()
// depth.png's decode goes to a worker (planner/engine.worker.ts); the main thread is the fallback when the worker can't
// start, dies, or fails (a damaged file then fails again here, with the decoder's own words).
let kernelWorker: KernelWorker | null = null
let workerDown: Promise<never> | null = null
function worker(): { k: KernelWorker; down: Promise<never> } | null {
  if (kernelWorker && workerDown) return { k: kernelWorker, down: workerDown }
  if (workerDown) return null
  try {
    const w = new Worker(new URL('./engine.worker.js', import.meta.url), { type: 'module' })
    workerDown = new Promise<never>((_resolve, reject) => {
      w.addEventListener('error', (e) => { e.preventDefault(); kernelWorker = null; reject(new Error(e.message || 'the kernel worker stopped')) })
    })
    workerDown.catch(() => undefined)
    kernelWorker = new KernelWorker(w)
    return { k: kernelWorker, down: workerDown }
  } catch {
    workerDown = Promise.reject(new Error('no kernel worker'))
    workerDown.catch(() => undefined)
    return null
  }
}
/** A heavy kernel in the worker, or on the main thread when there is none (or it failed). */
async function inWorker<T>(call: (k: KernelWorker) => Promise<T>, here: () => T): Promise<T> {
  const w = worker()
  if (!w) return here()
  try {
    return await Promise.race([call(w.k), w.down])
  } catch {
    return here()
  }
}

// --- renderer -------------------------------------------------------------------------------------------------------
// WebGPU, or the WebGL2 backend three falls back to by itself when the browser has no WebGPU adapter (?webgpu=0 forces
// it). init() picks the backend; everything below that makes GPU objects waits for it (the kernels load meanwhile).
const renderer = new THREE.WebGPURenderer({ antialias: false, alpha: false, forceWebGL: params.get('webgpu') === '0' })
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.autoClear = false
renderer.toneMapping = THREE.NoToneMapping
renderer.outputColorSpace = THREE.LinearSRGBColorSpace // no output conversion: the passes write sRGB bytes themselves
const canvas = renderer.domElement
await renderer.init()
const drawSize = new THREE.Vector2()
const P = createPasses(renderer)

// The furniture scene: lights, the depth pre-pass, the grid, the pieces.
const scene = new THREE.Scene()
// The lights (planner/lighting.ts, contract §4.8): lighting.json's probe, key and floor shadow, or the v1 lights. The
// catcher reads the photo through the photo pass's texture and the frame's rectangle.
const lights = createLighting({ renderer, scene, photo: { node: P.photo.node, frame: P.frame } })
scene.add(P.depth.mesh)
const grid = P.grid
scene.add(grid)

// --- the room view (contract §4.9): several photos of one room, one layout in the room frame -------------------------
/** A member photo as the room view keeps it (the room detail's member; `confidence` from align.json). */
interface RoomMember {
  readonly scene: string
  pose: Pose | null
  scale: number
  pose_source: string
  readonly camera: Camera | null
  readonly effective_camera: Camera | null
  readonly scene_object: SceneSummary | null
  readonly confidence: number | null
}
/** The open room: its detail as last read (or changed locally while a photo is dragged on the plan). */
interface RoomState {
  readonly name: string
  title: string | null
  members: RoomMember[]
  info: RoomInfo
}
let room: RoomState | null = null
let alignPhotos = false
let floorPlanShown = false
/** The current photo's member (null outside a room, or while it isn't one). */
function curMember(): RoomMember | null {
  if (!room || !sceneName) return null
  const n = sceneName
  return room.members.find((m) => m.scene === n) ?? null
}
/** The current photo's pose: null outside a room or while the photo is unplaced. */
function curPose(): Pose | null { return curMember()?.pose ?? null }
/** The current photo's scale (1 outside a room). */
function roomScale(): number { const m = curMember(); return m ? roomLogic.clampScale(m.scale) : 1 }
/** In a room view whose photo has no pose: room layouts aren't drawn (the pieces wait, parked, in the room frame). */
const roomUnplaced = (): boolean => !!room && !!sceneName && curPose() === null

// --- the scene camera (contract §4.1) --------------------------------------------------------------------------------
const camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.05, 200)
camera.rotation.order = 'YXZ'
let cam: Camera = cameraLogic.cameraCopy(DEFAULT_CAMERA)
// In a room view (§4.9) the photo is drawn through its member's effective camera: the scene's camera with height_m ×
// scale (clamped). The world the furniture is drawn in is that camera's scene frame; outside a room it is `cam` itself.
// `cam` stays the scene.json camera (Adjust floor, getCamera, Save scene).
function drawCam(): Camera {
  const s = roomScale()
  return s === 1 ? cam : roomLogic.effectiveCamera(cam, s)
}
const R = new THREE.Matrix3() // camera-to-world rotation, Ry(0)·Rx(pitch)·Rz(roll)
function applyCamera(): void {
  const dc = drawCam()
  camera.fov = dc.fov_y_deg
  camera.position.set(0, dc.height_m, 0)
  camera.rotation.set(dc.pitch_deg * DEG, 0, dc.roll_deg * DEG, 'YXZ')
  camera.updateMatrixWorld(true)
  R.setFromMatrix4(camera.matrixWorld)
  lights.setCamera(R, dc.fov_y_deg)
  lights.setLook(resolvedLook()) // the inferred key turns with the camera (§4.8: lighting.json is in its frame)
  updateView()
}
// The kernels' camera for the block and photo size in use (made again when either changes).
let kc: SceneCamera | null = null
function kcam(): SceneCamera {
  const b = kc?.block
  const dc = drawCam()
  if (kc && b && kc.width === photo.w && kc.height === photo.h && b.fov_y_deg === dc.fov_y_deg && b.height_m === dc.height_m && b.pitch_deg === dc.pitch_deg && b.roll_deg === dc.roll_deg) return kc
  kc?.dispose()
  kc = new SceneCamera(dc, photo.w, photo.h)
  return kc
}

// --- the photo and the view (letterbox, zoom, pan) -----------------------------------------------------------------
interface PhotoState {
  w: number
  h: number
  has: boolean
  image: HTMLImageElement | null
  texture: THREE.Texture | null
  depth: DepthMap | null
  depthTexture: THREE.DataTexture | null
}
const photo: PhotoState = { w: 1600, h: 1200, has: false, image: null, texture: null, depth: null, depthTexture: null }
let stageInsets = viewLogic.insetsFrom(0, 0, 0, 0)
let view: ViewState = { zoom: 1, cx: 800, cy: 600 }
function canvasRect(): Box {
  const r = canvas.getBoundingClientRect()
  return { x: r.left, y: r.top, w: r.width, h: r.height }
}
function stageRect(): Box {
  return viewLogic.stageOf(canvasRect(), stageInsets)
}
// Photo → client: client = o + s · photo px
function viewParams(): Xform & { st: Box } {
  const st = stageRect()
  return { ...viewLogic.xformOf(st, photo, view), st }
}
function clampCenter(): void {
  view = viewLogic.clampedView(stageRect(), photo, view)
}
function updateView(): void {
  renderer.getDrawingBufferSize(drawSize)
  const r = canvasRect()
  const k = r.w > 0 ? drawSize.x / r.w : renderer.getPixelRatio()
  clampCenter()
  const t = viewParams()
  camera.aspect = photo.w / photo.h
  // The canvas is a window onto the photo's rectangle (s·W × s·H, its top-left at o): a sub-view of the full frame.
  const off = viewLogic.viewOffset(t, photo, r)
  camera.setViewOffset(off.fullWidth, off.fullHeight, off.x, off.y, off.width, off.height)
  camera.updateProjectionMatrix()
  setScreen(P, viewLogic.bufferRect(t, photo, r, k))
  wake()
}
// depth.png is metric in the calibration's frame, where the camera stood calib.json's height_m above the floor it found.
// When Adjust floor changes the height, the furniture's world is that frame scaled by height / calib height, so the
// photo's depth is scaled the same way (otherwise a piece just in front of the sofa would hide behind it). Without a
// measured floor (floor.found false, or a fallback) the calibration's height is a guess and the depth stays as it is.
function depthScale(): number {
  const c = rec(sceneData?.['calib'])
  const floor = rec(c?.['floor'])
  const source = c?.['source']
  const measured = !!floor?.['found'] && (source === 'moge-2' || source === 'truth')
  return kDepthScale(drawCam().height_m, Number(rec(c?.['camera'])?.['height_m']), measured)
}
// The view's report rounds with the kernels. A resize while the page starts (before they have loaded) has no listener
// to tell yet: the UI mounts after the kernels and reads the view then.
function emitView(): void { if (kernelsLoaded()) emit('view', getView()) }
function getView(): ViewReport { return viewLogic.viewReport(view, K) }
function setStageInsets(ins: unknown = {}): void {
  const o = rec(ins) ?? {}
  stageInsets = viewLogic.insetsFrom(o['left'], o['right'], o['top'], o['bottom'])
  updateView()
  emitView()
}
function fitView(): void {
  view = viewLogic.fitState(photo)
  updateView()
  emitView()
}
// Zoom to `zoom` (1–4) keeping the photo point under (clientX, clientY) where it is.
function zoomAt(clientX: number, clientY: number, zoom: number): void {
  const before = clientToPhoto(clientX, clientY)
  view = viewLogic.zoomedView(stageRect(), photo, view, clientX, clientY, zoom, before)
  updateView()
  emitView()
}
function zoomBy(factor: number, clientX?: number, clientY?: number): void {
  const st = stageRect()
  zoomAt(isNum(clientX) ? clientX : st.x + st.w / 2, isNum(clientY) ? clientY : st.y + st.h / 2, view.zoom * factor)
}
function panBy(dx: number, dy: number): void {
  view = viewLogic.pannedView(view, viewParams().s, dx, dy)
  updateView()
  emitView()
}
function clientToPhoto(x: number, y: number): [number, number] {
  return viewLogic.clientToPhoto(viewParams(), x, y)
}
function photoToClient(px: number, py: number): [number, number] {
  return viewLogic.photoToClient(viewParams(), px, py)
}
function getPhotoRect(): Box {
  return viewLogic.photoRect(viewParams(), photo)
}
// The visible part of the photo (client px): the photo rectangle cut to the stage.
function visiblePhotoRect(): Box {
  return viewLogic.visibleRect(getPhotoRect(), stageRect())
}

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight)
  resizeTargets()
  updateView()
  emitView()
})
function resizeTargets(): void {
  renderer.getDrawingBufferSize(drawSize)
  sizeTargets(P, Math.max(1, drawSize.x), Math.max(1, drawSize.y))
}
// The splat pass is redrawn only when its key changes: the camera and view, the target size, the occlusion depth,
// every placed piece's transform (meshes hide splats), and splatEpoch, which a landed worker sort (the layer's
// onChange) and every rebuilt piece bump.
let splatEpoch = 0
function splatKey(): string {
  const k: (string | number)[] = [splatEpoch, P.furnRT.width, P.furnRT.height, P.depth.mesh.visible ? 1 : 0, P.depth.pass.scale.value, photo.depthTexture?.id ?? -1, ...camera.projectionMatrix.elements, ...camera.matrixWorld.elements]
  for (const r of items.values()) k.push(r.uid, ...r.group.matrixWorld.elements)
  return k.join(',')
}
resizeTargets()

function mount(el: HTMLElement): void {
  el.appendChild(canvas)
  updateView()
}

// --- projection (contract §4.1, exactly: the kernels) --------------------------------------------------------------------
/** A world point as [x, y, z] or {x, y, z} (v1 took both). */
type PointLike = readonly number[] | { readonly x: number; readonly y: number; readonly z: number }
function xyz(p: PointLike): Vec3 {
  if (Array.isArray(p)) {
    const a: readonly unknown[] = p
    const at = (i: number): number => { const v = a[i]; return typeof v === 'number' ? v : Number(v) }
    return [at(0), at(1), at(2)]
  }
  if ('x' in p) return [p.x, p.y, p.z]
  return [Number.NaN, Number.NaN, Number.NaN]
}
// World point → [px, py, d] in photo px; d = depth along the view axis (> 0 in front).
function projectPhoto(p: PointLike): Vec3 {
  return kcam().project(xyz(p))
}
// The world ray through a photo pixel: { origin, dir } (dir normalized).
function photoRay(px: number, py: number): { origin: THREE.Vector3; dir: THREE.Vector3 } {
  const r = kcam().ray(px, py)
  return { origin: new THREE.Vector3(r.origin[0], r.origin[1], r.origin[2]), dir: new THREE.Vector3(r.dir[0], r.dir[1], r.dir[2]) }
}
function photoToFloor(px: unknown, py: unknown): Vec3 | null {
  if (!isNum(px) || !isNum(py)) return null
  return kcam().photoToFloor(px, py)
}
function floorToPhoto(p: PointLike): [number, number] {
  return kcam().floorToPhoto(xyz(p))
}
// Client px of a world point; visible is false behind the camera.
function worldToScreen(p: PointLike): { x: number; y: number; visible: boolean } {
  const [px, py, d] = projectPhoto(p)
  const [x, y] = photoToClient(px, py)
  return { x, y, visible: d > 1e-4 }
}
// The horizon (where the floor plane vanishes) at photo column px: the row py, or null when it's vertical.
function horizonAt(px: number): number | null {
  return kcam().horizonAt(px)
}
// Dragging the horizon line: its middle (at the photo's centre column) to row py sets the pitch.
function setPitchFromHorizon(py: unknown): void {
  if (!isNum(py)) return
  const pitch = kcam().pitchFromHorizon(py)
  if (pitch !== null) setCamera({ pitch_deg: pitch })
}

// --- raycasting -------------------------------------------------------------------------------------------------------
const raycaster = new THREE.Raycaster()
function setRay(clientX: number, clientY: number): void {
  scene.updateMatrixWorld()
  const [px, py] = clientToPhoto(clientX, clientY)
  const { origin, dir } = photoRay(px, py)
  raycaster.ray.set(origin, dir)
  raycaster.camera = camera
}
function uidOf(obj: THREE.Object3D): string | null {
  for (let o: THREE.Object3D | null = obj; o; o = o.parent) {
    const uid: unknown = o.userData['uid']
    if (typeof uid === 'string' && uid) return uid
  }
  return null
}
function hitItems(): { uid: string; point: THREE.Vector3; distance: number } | null {
  const hits = raycaster.intersectObjects([...items.values()].map((r) => r.group), true)
  for (const h of hits) {
    const uid = uidOf(h.object)
    if (uid && h.object.name !== 'contact-shadow') return { uid, point: h.point.clone(), distance: h.distance }
  }
  return null
}
/** Where the ray through a client point meets a plane, within 60 m (the kernels' planePointAt). */
function planePointAt(plane: Plane, clientX: number, clientY: number): Vec3 | null {
  const [px, py] = clientToPhoto(clientX, clientY)
  return kcam().planePointAt(px, py, plane)
}

// --- contact shadows (contract §2.6.3, as nook) -------------------------------------------------------------------------
function setContactShadows(on: unknown): void {
  setLighting({ contact_shadows: !!on })
}
// The blob stays on the floor (a child of the item, shifted down by the elevation); a raised item (its bottom more
// than 2 cm up, §2.10) has none.
function syncShadow(r: ItemRec): void {
  const y = r.group.position.y
  if (r.shadow) { r.shadow.visible = look.contact_shadows && y <= 0.02; r.shadow.position.y = SHADOW_Y - y }
}

// --- library + items --------------------------------------------------------------------------------------------------
// A library entry (planner/wire.ts LibraryEntry) is library.json's as it is (§2.4 getLibrary: "items from library.json,
// as-is"), or a placeholder the planner made for a piece the library lost (missing: true).
/** The fields of an entry the engine decides on (logic/library.ts). */
function libView(l: LibraryEntry): LibView {
  const a = l.assets
  return {
    id: l.id, name: str(l.name), glb: str(a?.glb), spz: str(a?.spz), splat: str(a?.splat), thumb: str(a?.thumb),
    defaultRender: l.default_render, engine: l.source?.engine, missing: !!l.missing,
  }
}
type Render = 'glb' | 'splat'
interface ItemRec {
  readonly uid: string
  readonly id: string
  lib: LibraryEntry
  sig: string
  readonly group: THREE.Group
  child: THREE.Object3D | null
  splat: SplatData | null
  render: Render
  localBox: THREE.Box3 | null
  rotationDeg: number
  shadow: THREE.Mesh | null
  caster: THREE.Object3D | null
  readonly missing: boolean
  noGlb: boolean
  build: number
  /** In a room view (§4.9): where the piece stands in the room frame, kept as it was placed (the scene transform is
   *  derived from it through the current photo's pose, so switching photos never drifts it); null outside a room. */
  roomAt: RoomXf | null
}
/** A piece's place in the room frame: position (y the elevation) and rotation_y_deg. */
interface RoomXf {
  readonly x: number
  readonly y: number
  readonly z: number
  readonly rot: number
}
/** The piece's room-frame place from its scene transform, through the current photo's pose (null outside a room). */
function syncRoomAt(r: ItemRec): void {
  const pose = curPose()
  if (!room || !pose) { r.roomAt = null; return }
  const g = r.group.position
  const p = roomLogic.sceneToRoom([g.x, g.y, g.z], pose)
  r.roomAt = { x: p[0], y: g.y, z: p[2], rot: roomLogic.rotationToRoom(r.rotationDeg, pose) }
}
/** A room-frame place in the current photo's scene frame (null when the photo isn't placed). */
function roomToSceneXf(x: RoomXf): RoomXf | null {
  const pose = curPose()
  if (!pose) return null
  const p = roomLogic.roomToScene([x.x, x.y, x.z], pose)
  return { x: p[0], y: x.y, z: p[2], rot: roomLogic.rotationToScene(x.rot, pose) }
}
/** Where a piece stands in its layout's frame: the room frame in a room view, else the scene frame. */
function layoutXf(r: ItemRec): RoomXf {
  if (room && r.roomAt) return r.roomAt
  const g = r.group.position
  return { x: g.x, y: g.y, z: g.z, rot: r.rotationDeg }
}
let library: LibraryEntry[] = []
let libraryLoading: Promise<void> = Promise.resolve() // the library read in flight (a layout waits for it, or its pieces look missing)
const items = new Map<string, ItemRec>()
let itemsGen = 0
let uidCounter = 0
// three's Draco and Basis decoders, beside the bundle (scripts/build.mjs copies them to planner/dist/libs/): no CDN.
const THREE_LIBS = new URL('libs/', import.meta.url).href
const gltfLoader = new GLTFLoader()
  .setDRACOLoader(new DRACOLoader().setDecoderPath(`${THREE_LIBS}draco/gltf/`))
  .setKTX2Loader(new KTX2Loader().setTranscoderPath(`${THREE_LIBS}basis/`).detectSupport(renderer))
  .setMeshoptDecoder(MeshoptDecoder)
const glbCache = new Map<string, Promise<{ scene: THREE.Object3D; box: THREE.Box3 }>>()
const assetUrl = (rel: string): string => new URL(rel, libraryBase).href

async function fetchBytes(url: string): Promise<Uint8Array<ArrayBuffer>> {
  let res: Response
  try { res = await fetch(url) } catch (e) { throw new RequestError(msg.unfetchableText(url, detailOf(e)), null, true, null) }
  if (!res.ok) throw new RequestError(msg.httpErrorText(url, res.status, null), res.status, false, null)
  return new Uint8Array(await res.arrayBuffer())
}

function loadLibrary(): Promise<void> {
  libraryLoading = readLibrary()
  return libraryLoading
}
async function readLibrary(): Promise<void> {
  let list: LibraryEntry[] = []
  try {
    const res = await fetch(LIBRARY_URL)
    if (res.status !== 404) {
      if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
      const data: unknown = await res.json()
      const raw = rec(data)?.['items']
      if (!Array.isArray(raw)) throw new Error('missing "items" array')
      list = libraryEntries(raw)
    }
  } catch (e) {
    reportError(`Could not read library ${LIBRARY_URL}`, e)
  }
  library = list
  syncPlaced()
  emit('library', { items: library.slice() })
  quiet(makeMissingThumbs())
}

// What a placed copy depends on in its library entry: when this changes (Shows as, a rescale, a re-add), the copy is
// rebuilt in place (reloadLibrary).
const libSig = (l: LibraryEntry): string => JSON.stringify([l.default_render ?? null, l.assets ?? null, l.dims_cm ?? null, l.source?.created ?? null, l.fit ?? null])
// After a library change (Shows as, a rescale, a re-add: data.ts reloads the library), placed copies whose entry
// changed what they draw are rebuilt in place: same uid, group (position, rotation, elevation) and selection. A copy
// whose entry is gone keeps drawing what it has; renames just take the new entry.
function syncPlaced(): void {
  for (const r of items.values()) {
    if (r.missing) continue
    const l = library.find((x) => x.id === r.id)
    if (!l) continue
    const sig = libSig(l)
    if (sig === r.sig) { r.lib = l; continue }
    const was: unknown = JSON.parse(r.sig)
    const now: unknown = JSON.parse(sig)
    const tail = (v: unknown): string => JSON.stringify(Array.isArray(v) ? v.slice(1) : null)
    if (tail(was) !== tail(now)) {
      // the files may have been rewritten at the same paths (a rescale or a re-add): read them again
      const a = libView(r.lib)
      const b = libView(l)
      for (const relPath of [a.glb, a.spz, a.splat, b.glb, b.spz, b.splat]) {
        if (relPath) { glbCache.delete(assetUrl(relPath)); splatFiles.delete(assetUrl(relPath)) }
      }
    }
    r.sig = sig
    quiet(rebuildItem(r, l))
  }
}
async function rebuildItem(r: ItemRec, l: LibraryEntry): Promise<void> {
  const token = ++r.build
  let built: Built
  try { built = await buildChild(l) } catch (e) { throw reportError(`Could not reload "${libLogic.libName(libView(l))}"`, e) }
  if (token !== r.build || items.get(r.uid) !== r) { disposeChild(built.obj); return }
  detachBuilt(r)
  r.lib = l
  attachBuilt(r, built)
  r.group.updateMatrixWorld(true)
  emit('items', { change: 'render', uid: r.uid })
}

// --- thumbnails for pieces added from a 3D file ----------------------------------------------------------------------
// A GLB or OBJ add has no photo, so midstudy-add writes no thumb.jpg and the library showed initials. The planner
// renders one (front three-quarter view, the room's lighting, 256 px), and PUT /api/library/items/<id>/thumb stores it
// next to the model, so every device gets it. One at a time, once per item per page load; only for the server's own
// library (a ?library= elsewhere is read-only). Drawn by the planner's own renderer into targets of its own, so the
// photo view is never disturbed.
const OWN_LIBRARY = ((): boolean => { const u = new URL(LIBRARY_URL, location.href); return u.origin === location.origin && u.pathname === '/library/library.json' })()
const thumbTried = new Set<string>()
let thumbsRunning = false
async function makeMissingThumbs(): Promise<void> {
  if (!OWN_LIBRARY || thumbsRunning) return
  thumbsRunning = true
  try {
    for (;;) {
      // never from a GLB that isn't what's drawn: a splat item's (an idol item's is a stand-in box, §1); their adds
      // made a thumbnail from the photo anyway
      const l = library.find((x) => libLogic.needsThumb(libView(x), thumbTried))
      if (!l) break
      thumbTried.add(l.id)
      let image: string
      try { image = await modelThumbnail(l) } catch (e) { console.warn('[midstudy] no thumbnail for', l.id, e); continue }
      try {
        const item = libraryEntry(await apiJson(`/api/library/items/${encodeURIComponent(l.id)}/thumb`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image }) }))
        const thumb = item?.assets?.thumb
        const cur = library.find((x) => x.id === l.id)
        if (cur && thumb) { cur.assets = { ...(cur.assets ?? {}), thumb }; emit('library', { items: library.slice() }) }
      } catch (e) { console.warn('[midstudy] could not store the thumbnail of', l.id, e) }
    }
  } finally { thumbsRunning = false }
}
// v1's look: the model lit by RoomEnvironment and a key light, ACES Filmic and sRGB (the furniture composite, as the
// renderer's output does no conversion), over a plain 0xe7e4df background, antialiased (4× MSAA).
const THUMB_BG = new THREE.Color().setRGB(0xe7 / 255, 0xe4 / 255, 0xdf / 255, THREE.LinearSRGBColorSpace) // written as is: e7e4df
let thumbPass: { size: number; model: THREE.RenderTarget; out: THREE.RenderTarget; quad: THREE.QuadMesh } | null = null
function thumbTargets(size: number): NonNullable<typeof thumbPass> {
  if (thumbPass?.size === size) return thumbPass
  const model = new THREE.RenderTarget(size, size, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true })
  const out = new THREE.RenderTarget(size, size, { type: THREE.UnsignedByteType, depthBuffer: false })
  const frame = createFrame()
  setFrame(frame, [0, 0, size, size])
  thumbPass = { size, model, out, quad: new THREE.QuadMesh(createFurnitureComposite(frame, model.texture).material) }
  return thumbPass
}
async function modelThumbnail(l: LibraryEntry, size = 256): Promise<string> {
  const glb = libView(l).glb
  if (!glb) throw new Error('no GLB')
  const t = await loadGlbTemplate(assetUrl(glb))
  const th = thumbTargets(size)
  const sc = new THREE.Scene()
  sc.environment = lights.roomEnvironment
  const key = new THREE.DirectionalLight(0xffffff, 1.2)
  key.position.set(2, 4, 3)
  sc.add(key, t.scene.clone(true))
  // the item frame: footprint centre at the origin, on the floor, front +Z; seen from front-right, a little above
  const b = t.box
  const c = b.getCenter(new THREE.Vector3())
  const radius = Math.max(1e-3, b.getSize(new THREE.Vector3()).length() / 2)
  const thumbCam = new THREE.PerspectiveCamera(30, 1, radius / 100, radius * 100)
  const dir = new THREE.Vector3(0.55, 0.42, 1).normalize()
  thumbCam.position.copy(c).addScaledVector(dir, (radius / Math.sin((30 * DEG) / 2)) * 1.02)
  thumbCam.lookAt(c)
  lights.withDiffuseIbl(() => {
    try {
      renderer.setRenderTarget(th.model)
      renderer.setClearColor(0x000000, 0)
      clearTarget(renderer)
      render(renderer, sc, thumbCam)
      renderer.setRenderTarget(th.out)
      renderer.setClearColor(THUMB_BG, 1)
      clearTarget(renderer)
      th.quad.render(renderer)
    } finally { renderer.setRenderTarget(null) }
  })
  const px = await readRgba(renderer, th.out, size, size)
  const cv = document.createElement('canvas')
  cv.width = cv.height = size
  const g = cv.getContext('2d')
  if (!g) throw new Error('no 2D canvas')
  g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), size, size), 0, 0)
  return cv.toDataURL('image/jpeg', 0.88)
}

function loadGlbTemplate(url: string): Promise<{ scene: THREE.Object3D; box: THREE.Box3 }> {
  const cached = glbCache.get(url)
  if (cached) return cached
  const p = (async () => {
    const bytes = await fetchBytes(url)
    const base = url.slice(0, url.lastIndexOf('/') + 1)
    const gltf = await gltfLoader.parseAsync(bytes.buffer, base)
    const first: unknown = gltf.scene
    const root = isObject3D(first) ? first : gltf.scenes[0]
    if (!root) throw new Error('GLB has no scene')
    root.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(root, true)
    if (box.isEmpty()) throw new Error('GLB has no geometry')
    return { scene: root, box }
  })()
  glbCache.set(url, p)
  p.catch(() => glbCache.delete(url))
  return p
}

// --- splats (contract §4.5 Splats): planner/gpu/splat-layer.ts, made on the first splat item ------------------------
// A splat item is its GLB (or a box at its dims), invisible, plus its splats in the layer, placed by the item's group:
// position, rotation and elevation move them together. The layer draws in the splat pass only; the furniture pass and
// the keep-room mask never draw it, and the raycaster picks the GLB, not the splat. The layer sorts on the GPU
// (WebGPU) or in a worker (the WebGL2 fallback); a worker sort that lands wakes the on-demand render loop
// (onChange), so a splat appears without the pointer moving.
let splatLayer: SplatLayer | null = null
function splats(): SplatLayer {
  if (!splatLayer) {
    splatLayer = new SplatLayer({ renderer, onChange: () => { splatEpoch++; wake(50) } })
    setSplatSource(P, splatLayer.target.texture)
  }
  return splatLayer
}
// url -> the decoded splats (splat.spz or splat.ply), shared by every placed copy of an item (the layer copies them).
const splatFiles = new Map<string, Promise<SplatData>>()
function loadSplatFile(url: string): Promise<SplatData> {
  const cached = splatFiles.get(url)
  if (cached) return cached
  const p = fetchBytes(url).then(decodeSplat)
  splatFiles.set(url, p)
  p.catch(() => splatFiles.delete(url))
  return p
}
async function loadSplat(l: LibView): Promise<SplatData> {
  const rel = libLogic.splatAsset(l)
  if (!rel) throw new Error('the item has no splat')
  const data = await loadSplatFile(assetUrl(rel))
  if (!(data.count > 0)) throw new Error('the splat has no points')
  return data
}
// Splat items in the scene (their splat drawn): the splat pass runs only while there are some.
function splatItemCount(): number {
  let n = 0
  for (const r of items.values()) if (r.splat) n++
  return n
}
const sleep = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms) })
// The order the splats are drawn in is for the camera as it is now and every placed piece (a capture reads the frame
// right after). The view offset (zoom, pan) doesn't change the order: it depends on the camera's position and
// direction only. The layer reads each piece's world matrix with its parents' (updateWorldMatrix(true, false)) when it
// prepares a sort, so a piece added since the last frame sorts where it stands (v2's E13.24 race was Spark's stale one).
async function settleSplats(): Promise<void> {
  if (!splatLayer || !splatItemCount()) return
  try { await splatLayer.settle(camera) } catch (e) { reportError('The splats were still sorting when the render was captured; try rendering again', e) }
}

// A piece the library doesn't have any more (§2.8), or one without a GLB (v1 draws GLB only): a dashed box at its dims.
const missingFill = new THREE.MeshBasicMaterial({ color: 0xe8735a, transparent: true, opacity: 0.14, depthWrite: false })
const missingEdge = new THREE.LineDashedMaterial({ color: 0xe8735a, dashSize: 0.05, gapSize: 0.035, transparent: true, opacity: 0.95 })
interface Child {
  obj: THREE.Object3D
  box: THREE.Box3
}
function missingChild(dims: DimsCm): Child {
  const w = dims.w / 100, d = dims.d / 100, hgt = dims.h / 100
  const geo = new THREE.BoxGeometry(w, hgt, d).translate(0, hgt / 2, 0)
  const g = new THREE.Group()
  g.name = 'missing-item'
  const fillMesh = new THREE.Mesh(geo, missingFill)
  fillMesh.renderOrder = 3
  const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), missingEdge)
  edges.computeLineDistances()
  edges.raycast = noRaycast
  g.add(fillMesh, edges)
  return { obj: g, box: new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, hgt, d / 2)) }
}

// A splat item without a GLB: a plain box at its dims stands in for it (never drawn, like the idol stand-in).
const boxMat = new THREE.MeshBasicMaterial({ color: 0xffffff })
function boxChild(dims: DimsCm): Child {
  const w = dims.w / 100, d = dims.d / 100, hgt = dims.h / 100
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d).translate(0, hgt / 2, 0), boxMat)
  m.name = 'splat-box'
  return { obj: m, box: new THREE.Box3(new THREE.Vector3(-w / 2, 0, -d / 2), new THREE.Vector3(w / 2, hgt, d / 2)) }
}
async function glbChild(glb: string): Promise<Child> {
  const t = await loadGlbTemplate(assetUrl(glb))
  return { obj: t.scene.clone(true), box: t.box.clone() }
}
interface Built extends Child {
  splat: SplatData | null
  render: Render
}
// → { obj, box, splat, render }: obj is what picks, drags, bounds and shadows (the GLB, a box, or the missing box); with
// render 'splat', obj is invisible and `splat` (the decoded splats, drawn by the layer) is what's drawn. A splat that
// won't load falls back to the GLB (for idol, its stand-in box), with a non-blocking error.
async function buildChild(l: LibraryEntry): Promise<Built> {
  const v = libView(l)
  const dims = libLogic.validDims(l.dims_cm ?? null) ?? libLogic.MISSING_DIMS
  if (v.missing) return { ...missingChild(dims), splat: null, render: 'glb' }
  if (libLogic.pickRender(v) === 'splat') {
    const [base, splat] = await Promise.allSettled([v.glb ? glbChild(v.glb) : Promise.resolve(boxChild(dims)), loadSplat(v)])
    if (base.status === 'rejected') throw base.reason
    if (splat.status === 'fulfilled') {
      base.value.obj.visible = false
      return { ...base.value, splat: splat.value, render: 'splat' }
    }
    reportError(`Could not load the splat of "${libLogic.libName(v)}"; showing ${libLogic.isStandIn(v) ? 'its box' : 'its mesh'} instead`, splat.reason)
    if (!v.glb) { disposeChild(base.value.obj); return { ...missingChild(dims), splat: null, render: 'glb' } }
    return { ...base.value, splat: null, render: 'glb' }
  }
  if (!v.glb) return { ...missingChild(dims), splat: null, render: 'glb' }
  return { ...(await glbChild(v.glb)), splat: null, render: 'glb' }
}
// GLB clones share geometry and materials with the cached template, and splats their decoded file (the layer holds its
// own copy); the boxes are the item's own.
function disposeChild(obj: THREE.Object3D | null): void {
  if (obj?.name === 'missing-item' || obj?.name === 'splat-box') obj.traverse((c) => { if (isMesh(c) || isLine(c)) c.geometry.dispose() })
}
// Puts a built child (buildChild) into the item's group, with its contact shadow; detachBuilt takes it out again.
function attachBuilt(r: ItemRec, b: Built): void {
  r.child = b.obj
  r.localBox = b.box
  r.splat = b.splat
  r.render = b.render
  r.noGlb = libLogic.hasNoGlb(r.missing, libView(r.lib).glb, r.render)
  r.group.add(b.obj)
  lights.prepare(b.obj)
  if (r.splat) {
    splats().add(r.uid, r.splat, r.group)
    r.caster = lights.caster(b.obj) // the hidden GLB or box casts the splat's floor shadow (§4.8)
    r.group.add(r.caster)
  }
  onDepthLayer(b.obj)
  r.shadow = makeContactShadow(b.box)
  r.group.add(r.shadow)
  syncShadow(r)
  splatEpoch++
}
function detachBuilt(r: ItemRec): void {
  splatEpoch++
  for (const o of [r.child, r.shadow, r.caster]) if (o) r.group.remove(o)
  if (r.splat) splatLayer?.remove(r.uid)
  r.caster = null
  disposeChild(r.child)
  r.child = null
  r.splat = null
  r.shadow = null
}

/** The kernels' view of a placed piece: its pose and its local box. */
function itemBox(r: ItemRec, box: THREE.Box3): ItemBox {
  const p = r.group.position
  return { position: [p.x, p.y, p.z], rotation_y_deg: r.rotationDeg, min: [box.min.x, box.min.y, box.min.z], max: [box.max.x, box.max.y, box.max.z] }
}

// Where a new piece lands (§4.5): the ray through the middle of the visible photo, else through the middle of its lower
// third, when that floor point is 1–6 m from the camera; else 2.5 m straight ahead. Then the nearest free spot.
function landingSpot(): Vec3 {
  const taken = [...items.values()].map((r): [number, number] => [r.group.position.x, r.group.position.z])
  const t = viewParams()
  return kcam().landingSpot({ s: t.s, ox: t.ox, oy: t.oy }, visiblePhotoRect(), taken)
}

function newUid(id: string): string {
  uidCounter += 1
  return `${id}-${Date.now().toString(36)}${uidCounter.toString(36)}`
}

/** opts: { position: [x, elevation, z], rotation_y_deg, uid, missing: dims_cm (a layout's piece the library doesn't
 * have: a placeholder box at those dims, §2.8) } */
async function addItemInternal(id: unknown, opts: unknown = {}): Promise<string> {
  const t0 = performance.now()
  const o = rec(opts) ?? {}
  let l = library.find((x) => x.id === id) ?? null
  const missingDims = o['missing']
  if (!l && missingDims && typeof id === 'string' && id) {
    l = { id, name: layoutLogic.prettyLayout(id), dims_cm: libLogic.validDims(rec(missingDims)) ?? { ...libLogic.MISSING_DIMS }, assets: {}, missing: true }
  }
  if (!l) throw reportError(`Unknown library item "${asText(id)}"`)
  if (!sceneName) throw reportError('Open a scene first, then add furniture')
  if (roomUnplaced()) throw reportError('Place this photo on the floor plan first (Align photos), then add furniture')
  const pos = o['position']
  const pa: readonly unknown[] = Array.isArray(pos) ? pos : []
  const p0 = pa[0], p1 = pa[1], p2 = pa[2]
  const given = pa.length >= 3 && isNum(p0) && isNum(p2)
  const at: readonly unknown[] = given ? pa : landingSpot()
  const rotIn = o['rotation_y_deg']
  const rot = isNum(rotIn) ? rotIn : 0
  const uidIn = o['uid']
  const uid = typeof uidIn === 'string' && uidIn && !items.has(uidIn) ? uidIn : newUid(l.id)
  const gen = itemsGen
  const group = new THREE.Group()
  group.rotation.order = 'YXZ'
  const x = at[0], z = at[2]
  group.position.set(typeof x === 'number' ? x : 0, given && isNum(p1) ? clampElevation(p1) : 0, typeof z === 'number' ? z : 0)
  group.rotation.set(0, rot * DEG, 0)
  group.userData['uid'] = uid
  group.name = `item:${uid}`
  const r: ItemRec = { uid, id: l.id, lib: l, sig: libSig(l), group, child: null, splat: null, render: 'glb', localBox: null, rotationDeg: rot, shadow: null, caster: null, missing: !!l.missing, noGlb: false, build: 0, roomAt: null }
  syncRoomAt(r)
  try {
    attachBuilt(r, await buildChild(l)) // a splat item: its GLB and its splat have both loaded
  } catch (e) {
    throw reportError(`Could not load "${libLogic.libName(libView(l))}"`, e)
  }
  if (gen !== itemsGen) {
    detachBuilt(r)
    throw new Error(`adding "${l.id}" was cancelled because the items were cleared`)
  }
  scene.add(group)
  items.set(uid, r)
  emit('items', { change: 'add', uid })
  measure('item-add', t0)
  return uid
}

// position[1] is the elevation (§2.10): the item's bottom above the floor, clamped to 0..4 m.
function moveItemInternal(uid: unknown, opts: unknown = {}): void {
  const r = typeof uid === 'string' ? items.get(uid) : undefined
  if (!r) { reportError(`moveItem: no placed item "${asText(uid)}"`); return }
  const o = rec(opts) ?? {}
  const pos = o['position']
  if (Array.isArray(pos)) {
    const pa: readonly unknown[] = pos
    const [x, y, z] = pa
    if (isNum(x)) r.group.position.x = x
    if (isNum(y)) r.group.position.y = clampElevation(y)
    if (isNum(z)) r.group.position.z = z
  }
  const rot = o['rotation_y_deg']
  if (isNum(rot)) {
    r.rotationDeg = rot
    r.group.rotation.set(0, rot * DEG, 0)
  }
  r.group.updateMatrixWorld(true)
  syncShadow(r)
  syncRoomAt(r)
  emit('items', { change: 'move', uid: r.uid })
}

function getElevation(uid: string): number | null {
  const r = items.get(uid)
  return r ? r.group.position.y : null
}
function setElevation(uid: string, y: unknown): void {
  const r = items.get(uid)
  if (!r || !isNum(y)) return
  moveItemInternal(uid, { position: [r.group.position.x, roundTo(clampElevation(y), 6), r.group.position.z] })
}
function nudgeElevation(uid: string, dy: number): void {
  const y = getElevation(uid)
  if (y !== null) setElevation(uid, num.nudged(y, dy))
}
function dropToFloor(uid: string): void {
  const r = items.get(uid)
  if (r) moveItemInternal(uid, { position: [r.group.position.x, 0, r.group.position.z] })
}
const floorXZ = (r: ItemRec): readonly [number, number] => [r.group.position.x, r.group.position.z]
// Several selected pieces turn as one group, around the middle of their positions (each turns by the same angle).
function rotateSelected(deg: number): void {
  const recs = selRecs()
  if (!recs.length || !isNum(deg)) return
  const c = recs.length > 1 ? selLogic.centreOf(recs.map(floorXZ)) : null
  for (const r of recs) {
    const p = r.group.position
    const [x, z] = c ? selLogic.turnAbout(c, p.x, p.z, deg) : [p.x, p.z]
    moveItemInternal(r.uid, { position: [roundTo(x, 6), p.y, roundTo(z, 6)], rotation_y_deg: rotateBy(r.rotationDeg, deg) })
  }
}
// Move every selected piece by [dx, dy, dz] m (dy: its elevation, clamped 0–4 m, to the millimetre).
function nudgeSelected(d: readonly number[]): void {
  const [dx = 0, dy = 0, dz = 0] = d.map((v) => (isNum(v) ? v : 0))
  for (const r of selRecs()) {
    const p = r.group.position
    moveItemInternal(r.uid, { position: [roundTo(p.x + dx, 6), clampElevation(num.nudged(p.y, dy)), roundTo(p.z + dz, 6)] })
  }
}
// A copy of each selected piece, 30 cm to the right (+X), same turn and height; the copies become the selection.
async function duplicateSelected(): Promise<string[]> {
  const recs = selRecs()
  if (!recs.length) return []
  const uids = await Promise.all(recs.map((r) => {
    const p = r.group.position
    return addItemInternal(r.id, { position: [p.x + 0.3, p.y, p.z], rotation_y_deg: r.rotationDeg, missing: r.missing ? { ...(r.lib.dims_cm ?? {}) } : undefined })
  }))
  selectMany(uids)
  return uids
}
function removeItemInternal(uid: unknown): void {
  const r = typeof uid === 'string' ? items.get(uid) : undefined
  if (!r) return
  if (sel.uids.includes(r.uid)) {
    sel = selLogic.without(sel, r.uid)
    selected = sel.primary
    if (drag.mode && drag.uid === r.uid) endItemDrag()
    emit('selection', selectionDetail())
  }
  scene.remove(r.group)
  r.build++ // a rebuild in flight (reloadLibrary) drops its result
  detachBuilt(r)
  items.delete(r.uid)
  emit('items', { change: 'remove', uid: r.uid })
}
function clearItemsInternal(): void {
  itemsGen += 1
  select(null)
  for (const uid of [...items.keys()]) removeItemInternal(uid)
}
/** The piece's box in the world (the kernels' worldBounds of v1's localBox under the group's transform). */
function worldBounds(r: ItemRec): THREE.Box3 {
  if (!r.localBox) return new THREE.Box3()
  const b = kWorldBounds(itemBox(r, r.localBox))
  return new THREE.Box3(new THREE.Vector3(b.min[0], b.min[1], b.min[2]), new THREE.Vector3(b.max[0], b.max[1], b.max[2]))
}
/** A placed piece as the UI sees it (getItems / getItem). */
export interface ItemInfo {
  uid: string
  id: string
  name: string
  lib: LibraryEntry
  render: Render
  position: Vec3
  rotation_y_deg: number
  missing: boolean
  noGlb: boolean
}
function itemInfo(r: ItemRec): ItemInfo {
  return {
    uid: r.uid, id: r.id, name: libLogic.libName(r.lib), lib: r.lib, render: r.render,
    position: [r.group.position.x, r.group.position.y, r.group.position.z], rotation_y_deg: r.rotationDeg,
    missing: r.missing, noGlb: r.noGlb,
  }
}
// §4.6 getScreenRect: the item's projected bounds in photo px (its box's 8 corners; corners behind the camera ignored).
function getScreenRect(uid: unknown): Rect | null {
  const r = typeof uid === 'string' ? items.get(uid) : undefined
  if (!r?.localBox) return null
  return kcam().screenRect(itemBox(r, r.localBox))
}

// --- selection: drag the item itself on the floor, a grip on its footprint rotates it (contract §2.3) -----------------
type DragMode = 'move' | 'lift' | 'rotate'
// The selection is a set (logic/selection.ts); `selected` is its primary (picked last), which the label, the grip and
// the height controls follow. One piece selected is the common case and behaves exactly as before.
let sel: selLogic.Selection = selLogic.NO_SELECTION
let selected: string | null = null
let snap = false // Shift on desktop: lift drags, 15° grip
/** A selected piece as it was when a drag began. */
interface DragStart { readonly uid: string; readonly pos: Vec3; readonly rot: number }
// group: the selection when the drag began; centre: what a rotate drag turns around
const drag: { mode: DragMode | null; uid: string | null; off: Vec3; a0: number; rot0: number; plane: Plane; group: DragStart[]; centre: readonly [number, number] } = { mode: null, uid: null, off: [0, 0, 0], a0: 0, rot0: 0, plane: { normal: [0, 1, 0], constant: 0 }, group: [], centre: [0, 0] }
const selectionDetail = (): { uid: string | null; uids: string[] } => ({ uid: selected, uids: [...sel.uids] })
const selRecs = (): ItemRec[] => sel.uids.flatMap((u) => { const r = items.get(u); return r ? [r] : [] })
function setSelection(next: selLogic.Selection): void {
  sel = next
  selected = next.primary
  if (drag.mode && (drag.uid === null || !sel.uids.includes(drag.uid))) endItemDrag()
  emit('selection', selectionDetail())
}
/** select(uid | null, { toggle, add }): toggle (Shift+click) puts a piece in or out of the selection; add keeps the
 *  others and makes it the primary. */
function select(uid: unknown, opts: { toggle?: boolean; add?: boolean } = {}): void {
  const u = typeof uid === 'string' ? uid : null
  const how = opts.toggle ? 'toggle' : opts.add ? 'add' : 'set'
  const next = selLogic.selectStep(sel, u, u !== null && items.has(u), how)
  if (how !== 'set' && next === sel) return
  setSelection(next)
}
function selectMany(uids: readonly string[]): void { setSelection(selLogic.selectMany(uids, (u) => items.has(u))) }
function selectAll(): void { selectMany([...items.keys()]) }
const groupStart = (): DragStart[] => selRecs().map((r) => ({ uid: r.uid, pos: [r.group.position.x, r.group.position.y, r.group.position.z], rot: r.rotationDeg }))
function setSnap(on: unknown): void { snap = !!on }
/** Footprint corners [front-left, front-right, back-right, back-left] on the floor (front faces +Z), centre, box, height.
 */
interface Footprint {
  corners: Vec3[]
  center: Vec3
  box: Vec3[]
  height: number
}
function getFootprint(uid: string): Footprint | null {
  const r = items.get(uid)
  if (!r?.localBox) return null
  r.group.updateMatrixWorld(true)
  const it = itemBox(r, r.localBox)
  const f = kFootprint(it)
  return { corners: f.corners, center: f.center, box: kBoxCorners(it), height: f.height }
}
function hitItemAt(uid: string, clientX: number, clientY: number, pad = 16): boolean {
  const r = items.get(uid)
  if (!r?.localBox) return false
  const t = viewParams()
  const hit = kcam().hitBox(itemBox(r, r.localBox), { s: t.s, ox: t.ox, oy: t.oy }, clientX, clientY, pad)
  if (hit !== 'behind') return hit === 'hit'
  setRay(clientX, clientY)
  return hitItems()?.uid === uid
}
// The point of a placed piece under a client point: where the ray first meets its mesh, else its box, else null.
function grabPointOn(r: ItemRec, clientX: number, clientY: number): THREE.Vector3 | null {
  setRay(clientX, clientY)
  const hit = raycaster.intersectObject(r.group, true).find((h) => h.object.name !== 'contact-shadow')
  if (hit) return hit.point.clone()
  return raycaster.ray.intersectBox(worldBounds(r), new THREE.Vector3())
}
// The height of the horizontal plane a move-drag slides on: the grabbed point's own height, so that point stays under
// the pointer (a plane at the floor would amplify the motion with depth when the seat or the back is grabbed). Kept
// at least 15 cm from the eye height (where that plane is seen edge-on) and within the piece.
function dragHeight(r: ItemRec, clientX: number, clientY: number): number {
  const b = worldBounds(r)
  const p = grabPointOn(r, clientX, clientY)
  return kDragHeight(p ? p.y : null, b.min.y, b.max.y, drawCam().height_m)
}
// Drag to move: the grabbed point of the piece stays under the finger: the piece slides on the horizontal plane
// through that point (its elevation doesn't change), so farther away it shrinks with perspective, closer it grows.
// With `lift` (Shift) it moves up and down only.
function beginItemDrag(uid: string, clientX: number, clientY: number, opts: { lift?: boolean } = {}): boolean {
  const r = items.get(uid)
  if (!r) return false
  const lift = opts.lift ?? snap
  const pos: Vec3 = [r.group.position.x, r.group.position.y, r.group.position.z]
  const mode: DragMode = lift ? 'lift' : 'move'
  const plane: Plane = lift ? liftPlane(pos) : { normal: [0, 1, 0], constant: -dragHeight(r, clientX, clientY) }
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  if (!sel.uids.includes(uid)) select(uid)
  else if (selected !== uid) select(uid, { add: true }) // grabbing one piece of a group: the group moves, it leads
  drag.mode = mode
  drag.uid = uid
  drag.off = [pos[0] - p[0], pos[1] - p[1], pos[2] - p[2]]
  drag.plane = plane
  drag.group = groupStart()
  emit('drag', { mode, uid, phase: 'start' })
  return true
}
function beginRotateDrag(uid: string, clientX: number, clientY: number): boolean {
  const r = items.get(uid)
  if (!r) return false
  const plane: Plane = { normal: [0, 1, 0], constant: -r.group.position.y }
  const p = planePointAt(plane, clientX, clientY)
  if (!p) return false
  if (!sel.uids.includes(uid)) select(uid)
  drag.group = groupStart()
  const [cx, cz] = drag.group.length > 1 ? selLogic.centreOf(selRecs().map(floorXZ)) : [r.group.position.x, r.group.position.z]
  const c: Vec3 = [cx, r.group.position.y, cz]
  drag.centre = [cx, cz]
  drag.mode = 'rotate'
  drag.uid = uid
  drag.a0 = gripAngle(p, c)
  drag.rot0 = r.rotationDeg
  drag.plane = plane
  emit('drag', { mode: 'rotate', uid, phase: 'start' })
  return true
}
function dragTo(clientX: number, clientY: number, opts: { snapTo?: boolean } = {}): void {
  const r = drag.mode && drag.uid ? items.get(drag.uid) : undefined
  if (!r || !drag.mode) return
  const p = planePointAt(drag.plane, clientX, clientY)
  if (!p) return
  const g = r.group.position
  const lead = drag.group.find((s) => s.uid === r.uid)
  const others = drag.group.filter((s) => s !== lead && items.has(s.uid))
  if (!lead) return
  if (drag.mode === 'move') {
    const [x, z] = dragMove(p, drag.off)
    const dx = x - lead.pos[0], dz = z - lead.pos[2]
    moveItemInternal(r.uid, { position: [x, g.y, z] })
    for (const s of others) moveItemInternal(s.uid, { position: [roundTo(s.pos[0] + dx, 6), s.pos[1], roundTo(s.pos[2] + dz, 6)] })
  } else if (drag.mode === 'lift') {
    const y = dragLift(p[1], drag.off[1], snap)
    const dy = y - lead.pos[1]
    moveItemInternal(r.uid, { position: [lead.pos[0], y, lead.pos[2]] })
    for (const s of others) moveItemInternal(s.uid, { position: [s.pos[0], roundTo(clampElevation(s.pos[1] + dy), 6), s.pos[2]] })
  } else {
    const c = drag.centre
    const deg = dragRotate(drag.rot0, gripAngle(p, [c[0], g.y, c[1]]), drag.a0, !!opts.snapTo || snap)
    const d = deg - drag.rot0
    if (!others.length) { moveItemInternal(r.uid, { rotation_y_deg: deg }); return }
    for (const s of [lead, ...others]) {
      const [x, z] = selLogic.turnAbout(c, s.pos[0], s.pos[2], d)
      moveItemInternal(s.uid, { position: [roundTo(x, 6), s.pos[1], roundTo(z, 6)], rotation_y_deg: rotateBy(s.rot, d) })
    }
  }
}
function endItemDrag(): void {
  if (!drag.mode || !drag.uid) return
  const d = { mode: drag.mode, uid: drag.uid }
  drag.mode = null
  drag.uid = null
  drag.group = []
  emit('drag', { ...d, phase: 'end' })
}
/** What Undo puts back (removeItemWithUndo → restoreItem). */
export interface ItemSnapshot {
  uid: string
  id: string
  name: string
  position: Vec3
  rotation_y_deg: number
  missing: JsonObject | undefined
  /** in a room view: where it stood in the room frame (Undo puts it back there, whichever photo is open then) */
  roomAt?: RoomXf | null
}
function removeItemWithUndo(uid: string): ItemSnapshot | null {
  const r = items.get(uid)
  if (!r) return null
  const snapItem: ItemSnapshot = { uid, id: r.id, name: libLogic.libName(r.lib), position: [r.group.position.x, r.group.position.y, r.group.position.z], rotation_y_deg: r.rotationDeg, missing: r.missing ? { ...(r.lib.dims_cm ?? {}) } : undefined, roomAt: r.roomAt }
  removeItemInternal(uid)
  return snapItem
}
/** Where a snapshot goes back to: its room-frame place through the current photo's pose, else as it was. */
function snapPlace(s: ItemSnapshot): { position: Vec3; rotation_y_deg: number } {
  const x = room && s.roomAt ? roomToSceneXf(s.roomAt) : null
  return x ? { position: [x.x, x.y, x.z], rotation_y_deg: x.rot } : { position: s.position, rotation_y_deg: s.rotation_y_deg }
}
async function restoreItem(s: ItemSnapshot): Promise<string> {
  const uid = await addItemInternal(s.id, { uid: s.uid, ...snapPlace(s), missing: s.missing })
  select(uid)
  return uid
}
// Undo of removing several pieces: all of them back, selected together.
async function restoreItems(snaps: readonly ItemSnapshot[]): Promise<string[]> {
  const uids = await Promise.all(snaps.map((s) => addItemInternal(s.id, { uid: s.uid, ...snapPlace(s), missing: s.missing })))
  selectMany(uids)
  return uids
}

// --- the ruler (Adjust floor): two taps on the floor, the distance between them -------------------------------------
/** getRuler() and the 'ruler' event. */
interface RulerState {
  active: boolean
  points: Vec3[]
  meters: number | null
}
const ruler: { active: boolean; points: Vec3[] } = { active: false, points: [] }
function getRuler(): RulerState {
  const [a, b] = ruler.points
  return { active: ruler.active, points: ruler.points.map((p): Vec3 => [p[0], p[1], p[2]]), meters: a && b ? Math.hypot(a[0] - b[0], a[2] - b[2]) : null }
}
function setRulerActive(on: unknown): void {
  ruler.active = !!on
  if (!on) ruler.points = []
  else select(null)
  emit('ruler', getRuler())
}
function clearRuler(): void { ruler.points = []; emit('ruler', getRuler()) }
// The ruler measured a known length (a rug, a tile, a sofa's width): scale the camera height so it reads `meters`.
// Every floor point under a pixel scales with the height (the angles don't change), so this fixes the scene's scale,
// and with it the size every piece is drawn at, from one length the user knows (MoGe's metric scale is often off by
// 5–15 %). The ruler's points move with the floor and keep their place in the photo.
function setRulerTrueLength(meters: unknown): boolean {
  const r = getRuler()
  if (!isNum(meters) || r.meters === null) return false
  const s = rulerRescale(cam.height_m, r.meters, meters)
  if (!s) return false
  ruler.points = ruler.points.map((p): Vec3 => [p[0] * s.k, 0, p[2] * s.k])
  setCamera({ height_m: s.height_m })
  emit('ruler', getRuler())
  return s.exact
}
// Move ruler point i to the floor under a client point (after a camera change the points stay in the photo's place).
function setRulerPointAt(i: number, clientX: number, clientY: number): boolean {
  const [px, py] = clientToPhoto(clientX, clientY)
  const p = photoToFloor(px, py)
  if (!p || !ruler.points[i]) return false
  ruler.points[i] = p
  emit('ruler', getRuler())
  return true
}

// The placed piece under a client point (its mesh, not its shadow), or null.
function itemAt(clientX: number, clientY: number): string | null {
  if (!sceneName) return null
  setRay(clientX, clientY)
  return hitItems()?.uid ?? null
}
// A click/tap at a client point: a ruler point, or (de)selecting an item.
function tap(clientX: number, clientY: number): void {
  if (!sceneName) return
  if (ruler.active) {
    const [px, py] = clientToPhoto(clientX, clientY)
    const p = photoToFloor(px, py)
    if (!p) { toast('That point is above the horizon: tap the floor.', 'info', 3000); return }
    if (ruler.points.length >= 2) ruler.points = []
    ruler.points.push(p)
    emit('ruler', getRuler())
    return
  }
  setRay(clientX, clientY)
  const hit = hitItems()
  select(hit ? hit.uid : null)
}

// --- scenes (contract §4.4) ------------------------------------------------------------------------------------------
async function apiJson(url: string, opts?: Req): Promise<unknown> {
  let res: Response
  try { res = await fetch(url, withMidstudy(opts)) } catch (e) { throw new RequestError(msg.unreachableText(url, detailOf(e)), null, true, null) }
  let data: unknown = null
  try { data = await res.json() } catch { /* non-JSON */ }
  if (!res.ok) throw new RequestError(msg.httpErrorText(url, res.status, str(rec(data)?.['error'])), res.status, false, data)
  return data
}
const sceneUrl = (name: string): string => `/api/scenes/${encodeURIComponent(name)}`
let sceneName: string | null = null
let sceneData: JsonObject | null = null // GET /api/scenes/<name> as opened
/** The scene as last read or saved: { title, camera, camera_source, look }. */
export interface SavedScene {
  title: string | null
  camera: Camera
  camera_source: string
  look: LookState
}
let savedScene: SavedScene | null = null
let cameraSource = 'default'
let look: LookState = lookLogic.defaultLook()
let lightingData: JsonObject | null = null // lighting.json (GET /api/scenes/<name> `lighting`), or null: the v1 lights
let lightingStatus: LightingStatus = { status: 'missing', error: null } // §4.8 backfill: done | missing | pending | running | none | failed
let lightingToken = 0
let adjustFloor = false
let occlusion = true
let floorNote: string | null = null
let scenesList: SceneSummary[] = []
let scenesTrash: TrashedScene[] = [] // deleted scenes the server keeps (scenes/.trash)
let sceneToken = 0
/** What the Scenes page shows while a scene opens. */
export interface SceneLoad {
  loading: boolean
  phase: 'calibrating' | 'photo' | null
  name: string | null
  scene: SceneSummary | null
}
const sceneLoad: SceneLoad = { loading: false, phase: null, name: null, scene: null }
function setLoad(loading: boolean, phase: SceneLoad['phase'], name: string | null, scn: JsonObject | null): void {
  sceneLoad.loading = loading
  sceneLoad.phase = phase
  sceneLoad.name = name
  sceneLoad.scene = scn && sceneSummary(scn)
}
const dirty = { scene: false, layout: false }
let quietItems = 0
function setDirty(next: { scene: boolean; layout: boolean }): void {
  if (next.scene === dirty.scene && next.layout === dirty.layout) return
  dirty.scene = next.scene
  dirty.layout = next.layout
  emit('dirty', { ...dirty })
}
const sceneSig = (): string => cameraLogic.sceneSig(cam) // the Look saves itself (saveLookSoon), so only the camera waits for Save scene
let sceneBaseline = ''
const touchScene = (): void => { setDirty({ ...dirty, scene: !!sceneName && sceneSig() !== sceneBaseline }) }
// The layout is dirty when the placed pieces differ from the ones last saved or loaded (not merely when something
// happened: Remove then Undo puts back the same layout). Pieces compare by library id, position (to 0.1 mm) and turn.
// In a room view the pieces compare in the room frame (switching photos changes nothing), parked ones included.
const layoutSig = (): string => layoutLogic.layoutSig(parked ? parked.map((p) => ({ id: p.id, x: p.at.x, y: p.at.y, z: p.at.z, rotation_y_deg: p.at.rot })) : [...items.values()].map((r) => { const x = layoutXf(r); return { id: r.id, x: x.x, y: x.y, z: x.z, rotation_y_deg: x.rot } }), K)
let layoutBaseline = layoutLogic.EMPTY_SIG
const markLayoutClean = (): void => { layoutBaseline = layoutSig(); setDirty({ ...dirty, layout: false }) }
events.addEventListener('items', () => { if (!quietItems) setDirty({ ...dirty, layout: layoutSig() !== layoutBaseline }) })
async function quietly<T>(fn: () => T | Promise<T>): Promise<T> {
  quietItems++
  try { return await fn() } finally { quietItems-- }
}
async function listScenesInternal(): Promise<SceneSummary[]> {
  let data: JsonObject | null
  try { data = rec(await apiJson('/api/scenes')) } catch (e) { throw reportError('Could not list the scenes', e) }
  scenesList = sceneSummaries(data?.['scenes'])
  scenesTrash = trashedScenes(data?.['trash'])
  emit('scenes', { scenes: scenesList.slice() })
  return scenesList.slice()
}
async function getSceneInternal(name: string): Promise<JsonObject> {
  return rec(await apiJson(sceneUrl(name))) ?? {}
}
// Resolves with the scene when its calibration is done or failed (§4.6).
async function waitForScene(name: unknown, opts: { every?: number; onTick?: ((s: JsonObject) => void) | null } = {}): Promise<JsonObject> {
  if (!msg.isSceneName(name)) throw reportError(msg.sceneNameText(asText(name)))
  const every = opts.every ?? 500
  const t0 = performance.now()
  for (;;) {
    let s: JsonObject
    try { s = await getSceneInternal(name) } catch (e) {
      if (statusOf(e) === 404) throw reportError(`There's no scene "${name}"`, e)
      if (performance.now() - t0 > 15 * 60e3) throw reportError(`Gave up waiting for "${name}"`, e)
      await sleep(2000)
      continue
    }
    opts.onTick?.(s)
    if (sceneLogic.calibFinished(s['calib_status'])) return s
    await sleep(every)
  }
}

function b64json(o: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(o))
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s)
}
// POST /api/scenes with the photo; resolves when the upload is accepted (202) with { job, scene }.
async function createScene(file: unknown, meta: unknown = {}): Promise<unknown> {
  if (!(file instanceof Blob)) throw reportError('createScene needs a File')
  const t = rec(meta)?.['title']
  const title = typeof t === 'string' && t.trim() ? t.trim() : null
  const name = text.uploadName(file instanceof File ? file.name : '', 'photo.jpg')
  let res: unknown
  try {
    res = await apiJson('/api/scenes', { method: 'POST', body: file, headers: { 'content-type': file.type || 'application/octet-stream', 'X-Midstudy-Filename': name, ...(title ? { 'X-Midstudy-Meta': b64json({ title }) } : {}) } })
  } catch (e) {
    throw reportError(msg.createSceneText(statusOf(e)), e)
  }
  quiet(listScenesInternal())
  return res
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const img = new Image()
  img.decoding = 'async'
  img.src = url
  try { await img.decode() } catch { throw new Error(`could not load ${url.split('?')[0] ?? url}`) }
  return img
}

// depth.png: 16-bit grayscale PNG, mm along the view axis (§4.2), decoded by the kernels in the worker (browsers decode
// PNGs to 8 bits). v1's two refusals are checked here first, with v1's words; the decoder refuses anything else broken.
function checkDepthHeader(b: Uint8Array): void {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!sig.every((v, i) => b[i] === v)) throw new Error('depth.png is not a PNG')
  const at = (i: number): number => b[i] ?? 0
  const isIhdr = at(12) === 73 && at(13) === 72 && at(14) === 68 && at(15) === 82
  if (!isIhdr || b.length < 29) return // the decoder says what is wrong
  const w = ((at(16) << 24) | (at(17) << 16) | (at(18) << 8) | at(19)) >>> 0
  const h = ((at(20) << 24) | (at(21) << 16) | (at(22) << 8) | at(23)) >>> 0
  const bitDepth = at(24)
  const colorType = at(25)
  const interlace = at(28)
  if (!w || !h || colorType !== 0 || interlace || (bitDepth !== 16 && bitDepth !== 8)) throw new Error(`depth.png must be a 16-bit grayscale PNG (got colour type ${String(colorType)}, ${String(bitDepth)} bits)`)
}
async function loadDepth(url: string): Promise<DepthMap> {
  const bytes = await fetchBytes(url)
  checkDepthHeader(bytes)
  const t0 = performance.now()
  const copy = bytes.slice() // the worker takes the buffer; the copy is the main thread's fallback
  const d = await inWorker((k) => k.decodeDepth(bytes.buffer), () => decodeDepth(copy))
  measure('depth-decode', t0)
  return d
}

function setPhoto(img: HTMLImageElement, depth: DepthMap | null): void {
  photo.texture?.dispose()
  photo.depthTexture?.dispose()
  photo.image = img
  photo.w = img.naturalWidth
  photo.h = img.naturalHeight
  photo.texture = photoTexture(img)
  photo.has = true
  P.photo.setPhoto(photo.texture)
  photo.depth = depth
  photo.depthTexture = depth ? depthTexture(depth.data, depth.width, depth.height) : null
  P.depth.pass.setDepth(photo.depthTexture)
  syncOcclusion()
}
function clearPhoto(): void {
  photo.texture?.dispose()
  photo.depthTexture?.dispose()
  photo.has = false
  photo.image = null
  photo.texture = null
  photo.depth = null
  photo.depthTexture = null
  P.photo.setPhoto(null)
  P.depth.pass.setDepth(null)
  syncOcclusion()
}
const syncOcclusion = (): void => { P.depth.mesh.visible = occlusion && !!photo.depthTexture }

const nextFrame = (): Promise<void> => new Promise((r) => { requestAnimationFrame(() => { r() }) })
function floorNoteFor(data: JsonObject | null): string | null {
  const c = data?.['calib']
  const floor = rec(rec(c)?.['floor'])
  const err = data?.['calib_error']
  return cameraLogic.floorNote({ has: !!c, floorNotFound: floor !== null && floor['found'] === false, source: rec(c)?.['source'], status: data?.['calib_status'], error: err ? asText(err) : '' })
}

// Opens a scene by name: its photo, depth and camera, and its layouts and renders. Placed items are cleared. A scene
// that's still calibrating opens when it's done. Outside a room view (a room view's photos: openSceneAs).
function openScene(name: unknown): Promise<void> {
  return openSceneAs(name, null)
}
// With `inRoom` (§4.9): opens that room's member photo `name` in the room view. The first photo of a room clears the
// pieces and loads the room layout (as a scene's); every later one keeps the pieces (each in its room-frame place) and
// shows them through its own pose. The photo's own layouts are never loaded in a room view.
async function openSceneAs(name: unknown, inRoom: RoomInfo | null): Promise<void> {
  if (!msg.isSceneName(name)) throw reportError(msg.sceneNameText(asText(name)))
  const t0 = performance.now()
  const switching = !!inRoom && room?.name === inRoom.name // another photo of the open room
  flushLook()
  const token = ++sceneToken
  if (!switching) { // switching photos is a cut: the last photo stays until the next one is ready
    setLoad(true, 'photo', name, null)
    emit('scene', { phase: 'loading', name })
  }
  let data: JsonObject
  try {
    data = await getSceneInternal(name)
    if (sceneLogic.sceneBusy(data['calib_status'])) {
      setLoad(sceneLoad.loading, 'calibrating', sceneLoad.name, data)
      emit('scene', { phase: 'calibrating', name })
      await waitForScene(name, { onTick: (s) => { if (token === sceneToken) { sceneLoad.scene = sceneSummary(s); emit('scene', { phase: 'calibrating', name }) } } })
      if (token !== sceneToken) return
      data = await getSceneInternal(name)
    }
    if (token !== sceneToken) return
    const photoUrl = str(data['photo_url'])
    if (!photoUrl) throw new Error(str(data['calib_error']) ?? 'the scene has no photo')
    setLoad(sceneLoad.loading, 'photo', sceneLoad.name, data)
    const depthUrl = str(data['depth_url'])
    const tPhoto = performance.now()
    const [img, depth] = await Promise.all([
      loadImage(photoUrl).then((i) => { measure('photo', tPhoto); return i }),
      depthUrl ? loadDepth(depthUrl).catch((e: unknown) => { reportError('Could not read depth.png; occlusion is off', e); return null }) : null,
    ])
    if (token !== sceneToken) return
    if (!switching) {
      await quietly(() => { clearItemsInternal() })
      parked = null
      alignPhotos = false
      room = inRoom ? { name: inRoom.name, title: inRoom.title ?? null, members: membersOf(inRoom), info: inRoom } : null
    }
    clearRuler()
    ruler.active = false
    setPhoto(img, depth)
    sceneName = name
    sceneData = data
    cam = clampCamera(data['camera'])
    cameraSource = str(data['camera_source']) ?? 'default'
    look = lookLogic.lookFrom(rec(data['look']), K)
    lightingToken++
    setLightingData(data)
    const title = data['title']
    savedScene = { title: typeof title === 'string' ? title : null, camera: cameraLogic.cameraCopy(cam), camera_source: cameraSource, look: lookLogic.lookCopy(look) }
    sceneBaseline = sceneSig()
    occlusion = !!depth
    syncOcclusion()
    floorNote = floorNoteFor(data)
    adjustFloor = !!floorNote
    grid.visible = true
    view = viewLogic.fitState(photo)
    applyCamera()
    applyLook()
    if (switching) {
      await placeRoomItems() // the pieces where this photo sees them (parked on an unplaced one)
      if (token !== sceneToken) return
      setDirty({ scene: false, layout: dirty.layout })
    } else {
      setLayoutName('')
      layoutDetails = []
      layoutBaseline = layoutLogic.EMPTY_SIG
      setDirty({ scene: false, layout: false })
    }
    renders = []
    if (room) {
      store.set(LAST_ROOM_KEY, room.name)
      store.set(roomPhotoKey(room.name), name)
    } else {
      store.set(LAST_ROOM_KEY, null)
      store.set(LAST_SCENE_KEY, name)
    }
    syncUrl(name)
    setLoad(false, null, null, null)
    emit('camera', { camera: cameraLogic.cameraCopy(cam), source: cameraSource })
    emit('adjust', { on: adjustFloor, note: floorNote })
    emit('occlusion', { on: occlusion })
    emit('grid', { visible: true })
    emitView()
    emit('scene', { phase: 'opened', name })
    if (room) emit('room', { phase: switching ? 'photo' : 'opened', name: room.name })
    if (lightingStatus.status === 'missing' && data['calib_status'] === 'done') quiet(inferLighting())
    // The scene comes back with its layout (layoutToOpen: what this device had open, or the one saved last on any
    // device), so the furniture isn't lost on a reload or on the other device; then the renders list. The library
    // must be read first, or the pieces would load as missing. A room view: the room's layout, once, on its first photo.
    if (!switching) {
      if (room && roomUnplaced()) parkItems() // nothing placed yet: the room layout loads into the parked list
      await Promise.all([refreshLayouts(), libraryLoading.catch(() => undefined)])
      if (token !== sceneToken) return
      const scope = layoutScope()
      const pick = scope ? layoutToOpen(scope) : null
      if (pick) {
        try { await loadLayoutInternal(pick) } catch { /* reported */ }
        if (token !== sceneToken) return
      }
    }
    quiet(listRendersInternal())
    wake(1500)
    await nextFrame()
    await nextFrame()
    measure('scene-open', t0)
    if (!data['thumb_url']) quiet(saveThumbnail())
  } catch (e) {
    if (token !== sceneToken) return
    setLoad(false, null, null, null)
    emit('scene', { phase: 'failed', name })
    throw reportError(msg.openSceneText(name, statusOf(e)), e)
  }
}

function syncUrl(name: string | null): void {
  try {
    const u = new URL(location.href)
    if (room && name) { u.searchParams.set('room', room.name); u.searchParams.set('photo', name); u.searchParams.delete('scene') } else {
      u.searchParams.delete('room')
      u.searchParams.delete('photo')
      if (name) u.searchParams.set('scene', name); else u.searchParams.delete('scene')
    }
    history.replaceState(history.state, '', u)
  } catch { /* ignore */ }
}

function closeScene(): void {
  flushLook()
  sceneToken++
  setLoad(false, null, null, null)
  quiet(quietly(() => { clearItemsInternal() }))
  clearPhoto()
  sceneName = null
  sceneData = null
  savedScene = null
  lightingToken++
  look = lookLogic.defaultLook()
  setLightingData(null)
  applyLook()
  adjustFloor = false
  floorNote = null
  ruler.active = false
  ruler.points = []
  grid.visible = false
  layoutDetails = []
  renders = []
  setLayoutName('')
  layoutBaseline = layoutLogic.EMPTY_SIG
  setDirty({ scene: false, layout: false })
  const wasRoom = room
  room = null
  parked = null
  alignPhotos = false
  syncUrl(null)
  emit('adjust', { on: false })
  emit('scene', { phase: 'closed', name: null })
  if (wasRoom) emit('room', { phase: 'closed', name: wasRoom.name })
}

async function deleteScene(name: unknown): Promise<void> {
  if (!msg.isSceneName(name)) throw reportError(msg.sceneSlugText(asText(name)))
  try { await apiJson(sceneUrl(name), { method: 'DELETE' }) } catch (e) { throw reportError(`Could not delete the scene "${name}"`, e) }
  if (store.get(LAST_SCENE_KEY) === name) store.set(LAST_SCENE_KEY, null)
  const inOpenRoom = !!room && room.members.some((m) => m.scene === name)
  if (name === sceneName) closeScene()
  else if (inOpenRoom && room) { const rn = room.name; quiet(getRoomInternal(rn).then(setRoomInfo).catch(() => undefined)) } // it left its room (§4.9 Membership)
  emit('scene', { phase: 'deleted', name })
  quiet(listScenesInternal())
  if (inOpenRoom || roomsList.some((r) => r.members.some((m) => m.scene === name))) quiet(listRoomsInternal().catch(() => undefined))
}

// Undo of a delete: POST /api/scenes/<name>/restore puts the scene (and its layouts) back; its renders show again.
async function restoreScene(name: unknown): Promise<void> {
  if (!msg.isSceneName(name)) throw reportError(msg.sceneSlugText(asText(name)))
  try { await apiJson(`${sceneUrl(name)}/restore`, { method: 'POST' }) } catch (e) {
    throw reportError(msg.restoreSceneText(name, statusOf(e)), e)
  }
  emit('scene', { phase: 'restored', name })
  await listScenesInternal()
}

async function renameScene(name: string, title: unknown): Promise<void> {
  const t = typeof title === 'string' && title.trim() ? title.trim() : null
  try { await apiJson(sceneUrl(name), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: t }) }) } catch (e) {
    throw reportError('Could not rename the scene', e)
  }
  if (name === sceneName) {
    if (sceneData) sceneData = { ...sceneData, title: t }
    if (savedScene) savedScene.title = t
  }
  emit('scene', { phase: 'title', name })
  quiet(listScenesInternal())
}

// PUT /api/scenes/<name>: the camera (with its source), the Look and the title.
async function saveScene(): Promise<void> {
  if (!sceneName) throw reportError('No scene is open')
  const body = { title: sceneData?.['title'] ?? null, camera: cameraLogic.cameraCopy(cam), camera_source: cameraSource, look: lookLogic.lookToSave(look) }
  let res: unknown
  try { res = await apiJson(sceneUrl(sceneName), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) } catch (e) {
    throw reportError(msg.saveSceneText(statusOf(e)), e)
  }
  const r = rec(res)
  if (r) {
    sceneData = { ...sceneData, ...r, lighting: sceneData?.['lighting'] ?? null, lighting_status: sceneData?.['lighting_status'], lighting_error: sceneData?.['lighting_error'] }
    const rc = r['camera']
    cam = rc ? clampCamera(rc) : clampCamera(cam)
    cameraSource = str(r['camera_source']) ?? cameraSource
  }
  const title = sceneData?.['title']
  savedScene = { title: typeof title === 'string' ? title : null, camera: cameraLogic.cameraCopy(cam), camera_source: cameraSource, look: lookLogic.lookCopy(look) }
  sceneBaseline = sceneSig()
  touchScene()
  emit('scene', { phase: 'saved', name: sceneName })
  quiet(listScenesInternal())
}

// A small JPEG of the photo for the Scenes page: PUT /api/scenes/<name>/thumb.
async function saveThumbnail(): Promise<string | null> {
  const name = sceneName
  if (!name || !photo.image) return null
  const k = Math.min(1, 480 / Math.max(photo.w, photo.h))
  const c = document.createElement('canvas')
  c.width = Math.max(1, Math.round(photo.w * k))
  c.height = Math.max(1, Math.round(photo.h * k))
  c.getContext('2d')?.drawImage(photo.image, 0, 0, c.width, c.height)
  let res: JsonObject | null
  try {
    res = rec(await apiJson(`${sceneUrl(name)}/thumb`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image: c.toDataURL('image/jpeg', 0.82) }) }))
  } catch (e) { throw reportError('Could not save the scene thumbnail', e) }
  const url = str(res?.['thumb_url'])
  const entry = scenesList.find((s) => s.name === name)
  if (entry && url !== null) entry.thumb_url = url
  emit('scenes', { scenes: scenesList.slice() })
  return url
}

// Calibrate again (POST …/calibrate): waits for the job, then takes the new calibration (and depth) without touching
// the placed furniture. The server replaces the camera only when it wasn't set by hand.
async function recalibrate(): Promise<SceneSummary | null> {
  const name = sceneName
  if (!name) throw reportError('No scene is open')
  try { await apiJson(`${sceneUrl(name)}/calibrate`, { method: 'POST' }) } catch (e) { throw reportError(msg.recalibrateText(statusOf(e)), e) }
  emit('scene', { phase: 'recalibrating', name })
  const done = await waitForScene(name)
  if (name !== sceneName) return sceneSummary(done)
  const data = await getSceneInternal(name)
  const depthUrl = str(data['depth_url'])
  const depth = depthUrl ? await loadDepth(depthUrl).catch(() => null) : null
  if (name !== sceneName || !photo.image) return sceneSummary(data)
  setPhoto(photo.image, depth)
  sceneData = data
  lightingToken++
  setLightingData(data)
  applyLook()
  floorNote = floorNoteFor(data)
  if (!dirty.scene && cameraSource !== 'manual') {
    cam = clampCamera(data['camera'])
    cameraSource = str(data['camera_source']) ?? cameraSource
    if (savedScene) savedScene = { ...savedScene, camera: cameraLogic.cameraCopy(cam), camera_source: cameraSource }
    sceneBaseline = sceneSig()
    applyCamera()
    emit('camera', { camera: cameraLogic.cameraCopy(cam), source: cameraSource })
  }
  if (!occlusion && depth) setOcclusion(true)
  const failed = data['calib_status'] === 'failed'
  emit('scene', { phase: failed ? 'recalibrate-failed' : 'recalibrated', name })
  emit('adjust', { on: adjustFloor, note: floorNote })
  if (failed) toast(`Calibration failed: ${str(data['calib_error']) ?? 'see the server log'}`, 'error')
  return sceneSummary(data)
}

// --- the camera: Adjust floor (§4.5) ----------------------------------------------------------------------------------
function setCamera(partial: unknown = {}): void {
  const p = rec(partial)
  if (!p) return
  const next = clampCamera(p, cam) // v1's merge: the numbers p has over cam, clamped
  if (cameraLogic.sameCamera(next, cam)) return
  cam = next
  cameraSource = cameraLogic.sourceAfterChange(cam, savedScene ? savedScene.camera : null, savedScene ? savedScene.camera_source : 'manual')
  applyCamera()
  touchScene()
  emit('camera', { camera: cameraLogic.cameraCopy(cam), source: cameraSource })
}
function resetCamera(): void {
  const c = rec(rec(sceneData?.['calib'])?.['camera'])
  cam = clampCamera(c)
  cameraSource = c ? 'auto' : 'default'
  applyCamera()
  touchScene()
  emit('camera', { camera: cameraLogic.cameraCopy(cam), source: cameraSource })
}
function setAdjustFloor(on: unknown): void {
  adjustFloor = !!on && !!sceneName
  if (adjustFloor) select(null)
  else { ruler.active = false; ruler.points = [] }
  emit('adjust', { on: adjustFloor, note: floorNote })
  emit('ruler', getRuler())
}
function setOcclusion(on: unknown): void {
  occlusion = !!on
  syncOcclusion()
  emit('occlusion', { on: occlusion })
}
function setGridVisible(on: unknown): void {
  grid.visible = !!on
  emit('grid', { visible: grid.visible })
}

// --- layouts (per scene, contract §2.7) --------------------------------------------------------------------------------
let layoutDetails: LayoutSummary[] = []
let layoutName = ''
let layoutTitle = '' // the name as typed ("Phone A"), shown instead of the slug
function setLayoutName(name: unknown, title: unknown = null): void {
  layoutName = name === null || name === undefined ? '' : asText(name)
  layoutTitle = layoutLogic.currentTitle(layoutName, title)
}
/** The listing's details as the layout logic reads them. */
function details(): LayoutDetail[] {
  return layoutDetails.map((d) => {
    const ms = Date.parse(d.updated ?? '')
    return { name: d.name, title: d.title ?? null, updatedMs: Number.isNaN(ms) ? 0 : ms }
  })
}
function layoutDisplayName(name: unknown): string {
  return typeof name === 'string' ? layoutLogic.displayName(name, layoutName, layoutTitle, details()) : name ? layoutLogic.prettyLayout(asText(name)) : ''
}
// Which layout a scene opens with (§4.5). This device remembers the layout it last had open in each scene, with when
// it chose it ({name, at}: saved, loaded, or none after deleting it). The scene reopens with that layout, unless a
// layout was saved after that moment on another device (the server's `updated`), or this device has never had the
// scene open: then it opens with the most recently saved layout. So a reload keeps what this device had, and the
// phone opens a scene with the layout the desktop just saved, and the other way round.
const layoutKey = (s: string): string => `midstudy.layout.${s}`
/** Whose layouts are open: the scene's, or in a room view the room's (`@<room>`, as its layouts folder; a slug never
 *  starts with @, so a room's never collides with a scene's). */
function layoutScope(): string | null {
  return room ? `@${room.name}` : sceneName
}
function rememberLayout(name: string | null, at: unknown = null): void {
  const scope = layoutScope()
  if (!scope) return
  const parsed = Date.parse(typeof at === 'string' ? at : '')
  const t = parsed || Date.now()
  store.set(layoutKey(scope), JSON.stringify({ name: str(name), at: new Date(t).toISOString() }))
}
function recalledLayout(s: string): Recalled | null {
  const raw = store.get(layoutKey(s))
  if (!raw) return null
  const plain = layoutLogic.recalledFromSlug(raw)
  if (plain) return plain // the plain name stored before round 2: any later save wins
  try {
    const v: unknown = JSON.parse(raw)
    if (isRecord(v)) return layoutLogic.recalledFromObject(v, Date.parse(asText(v['at'])))
  } catch { /* unreadable: as if nothing were remembered */ }
  return null
}
function layoutToOpen(s: string): string | null { // s: the scene, or @<room>
  return layoutLogic.layoutToOpen(recalledLayout(s), details())
}
const layoutQuery = (): string => (room ? `?room=${encodeURIComponent(room.name)}` : `?scene=${encodeURIComponent(sceneName ?? '')}`)
type DocItem = LayoutDocItem | (LayoutDocItem & { dims_cm: JsonObject })
interface LayoutDoc {
  version: 1
  name: string
  title: string | null
  scene_name?: string | null
  room_name?: string
  library: string
  items: DocItem[]
}
function layoutDoc(name: string, title: string | null = null): LayoutDoc {
  // a room layout (§4.9 Layouts) is in the room frame and names the room instead of the scene
  const owner = room ? { room_name: room.name } : { scene_name: sceneName }
  const placed: DocItem[] = parked ? parked.map((p) => p.doc) : [...items.values()].map((r) => {
    const x = layoutXf(r)
    const it = layoutLogic.docItem({ uid: r.uid, id: r.id, render: r.render, x: x.x, y: x.y, z: x.z, rotation_y_deg: x.rot }, K)
    const dims = r.lib.dims_cm ?? null
    // a placeholder's size if the piece goes missing (§2.8)
    return dims && libLogic.validDims(dims) ? { ...it, dims_cm: { ...dims } } : it
  })
  return { version: 1, name, title: str(title), ...owner, library: LIBRARY_URL, items: placed }
}
// opts.title: the name as the user typed it; saving over a layout keeps its title unless a new one is given.
async function saveLayoutInternal(name: unknown, opts: unknown = {}): Promise<void> {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(msg.saveLayoutNameText(asText(name)))
  if (!sceneName) throw reportError('Open a scene first, then save a layout')
  const kept = name === layoutName ? layoutTitle : layoutDetails.find((d) => d.name === name)?.title
  const title = layoutLogic.layoutTitle(rec(opts)?.['title'], kept)
  let stored: JsonObject | null
  try {
    stored = rec(await apiJson(`/api/layouts/${name}${layoutQuery()}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(layoutDoc(name, title)) }))
  } catch (e) {
    throw reportError(msg.saveLayoutText(name, statusOf(e)), e)
  }
  setLayoutName(name, title)
  rememberLayout(name, stored?.['updated']) // the server's clock, as other devices compare against it
  markLayoutClean()
  emit('layouts', { name })
  await refreshLayouts()
}
async function loadLayoutInternal(name: unknown): Promise<void> {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(msg.loadLayoutNameText(asText(name)))
  if (!sceneName) throw reportError('Open a scene first, then load a layout')
  let doc: JsonObject | null
  try { doc = rec(await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`)) } catch (e) {
    throw reportError(msg.loadLayoutText(name, statusOf(e)), e)
  }
  const docItems = doc?.['items']
  if (!doc || !Array.isArray(docItems)) throw reportError(`Layout "${name}" has no items array`)
  const list: unknown[] = docItems
  const lib = doc['library']
  if (lib && lib !== LIBRARY_URL) toast(`Layout "${name}" was made with library ${asText(lib)}`, 'info')
  await quietly(async () => {
    clearItemsInternal()
    const missing = list.filter((it) => isRecord(it) && typeof it['id'] === 'string' && !library.some((l) => l.id === it['id']))
    const missingOf = (it: unknown): JsonObject | undefined => {
      const dims = rec(rec(it)?.['dims_cm'])
      return missing.includes(it) ? (dims && libLogic.validDims(dims) ? dims : { ...libLogic.MISSING_DIMS }) : undefined
    }
    if (room && parked) {
      // an unplaced photo is open (§4.9): the room layout waits, in the room frame, until a placed photo shows it
      parked = list.flatMap((it) => { const pk = parkedOf(it, missingOf(it)); return pk ? [pk] : [] })
      return
    }
    const results = await Promise.allSettled(list.map(async (it) => {
      const o = rec(it)
      const at = room ? roomXfOf(o) : null
      const x = at ? roomToSceneXf(at) : null
      const uid = await addItemInternal(o?.['id'], {
        uid: o?.['uid'], position: x ? [x.x, x.y, x.z] : o?.['position'], rotation_y_deg: x ? x.rot : o?.['rotation_y_deg'],
        missing: missingOf(it),
      })
      const r = items.get(uid)
      if (r && at && x) r.roomAt = { ...at, y: r.group.position.y } // exactly as saved (the elevation as clamped)
      return uid
    }))
    const failed = results.filter((r) => r.status === 'rejected').length
    if (failed) toast(layoutLogic.failedText(name, failed, list.length), 'error')
    if (missing.length) toast(layoutLogic.missingText(name, missing.length), 'info', 9000)
  })
  setLayoutName(name, doc['title'])
  rememberLayout(name)
  markLayoutClean()
  emit('layouts', { name })
}
/** A deleted layout as it was, plus whether it was the current one: what restoreLayoutInternal puts back (Undo). */
export type DeletedLayout = JsonObject
// Deletes a layout (the server keeps it in layouts/<scene>/.trash). Resolves with the layout as it was, for Undo.
async function deleteLayoutInternal(name: string): Promise<DeletedLayout | null> {
  let doc: JsonObject | null = null
  try { doc = rec(await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`)) } catch { /* deleted below anyway */ }
  try { await apiJson(`/api/layouts/${encodeURIComponent(name)}${layoutQuery()}`, { method: 'DELETE' }) } catch (e) { throw reportError(`Could not delete layout "${name}"`, e) }
  const wasCurrent = layoutName === name
  if (wasCurrent) { setLayoutName(''); rememberLayout(null) }
  await refreshLayouts()
  return doc ? { ...doc, wasCurrent } : null
}
// Undo of a delete: puts the layout back as it was (same items and title). It becomes the current layout again if it
// was, without touching the pieces in the scene.
async function restoreLayoutInternal(docIn: unknown): Promise<void> {
  const doc = rec(docIn)
  const name = doc?.['name']
  if (!doc || typeof name !== 'string' || !SLUG.test(name) || !Array.isArray(doc['items'])) throw reportError('Nothing to restore')
  const scn = doc['scene_name']
  const rn = doc['room_name']
  if (room ? (rn && rn !== room.name) || (!rn && scn) : !sceneName || (scn && scn !== sceneName) || rn) throw reportError(room ? 'That layout belongs to another room' : 'That layout belongs to another scene')
  const notes = doc['notes']
  const owner = room ? { room_name: room.name } : { scene_name: sceneName }
  const body = { version: 1, name, title: doc['title'] ?? null, ...owner, library: doc['library'] ?? LIBRARY_URL, items: doc['items'], ...(typeof notes === 'string' ? { notes } : {}) }
  let stored: JsonObject | null
  try {
    stored = rec(await apiJson(`/api/layouts/${name}${layoutQuery()}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))
  } catch (e) { throw reportError(`Could not restore layout "${name}"`, e) }
  if (doc['wasCurrent'] && !layoutName) { setLayoutName(name, doc['title']); rememberLayout(name, stored?.['updated']); emit('layouts', { name }) }
  await refreshLayouts()
}
async function listLayoutsInternal(): Promise<string[]> {
  if (!sceneName && !room) return []
  const data = rec(await apiJson(`/api/layouts${layoutQuery()}`))
  const raw = data?.['layouts']
  const all: unknown[] = Array.isArray(raw) ? raw : []
  const names = all.filter((n): n is string => typeof n === 'string')
  const det = data?.['details']
  layoutDetails = Array.isArray(det) ? layoutSummaries(det) : names.map((n) => ({ name: n }))
  return names
}
async function refreshLayouts(): Promise<void> {
  let names: string[] = []
  try { names = await listLayoutsInternal() } catch (e) { reportError('Could not list layouts', e); return }
  emit('layouts', { names: names.slice(), details: layoutDetails.slice() })
}

// --- rooms (contract §4.9) ---------------------------------------------------------------------------------------------
// A room view is a scene view of one member photo (its photo, effective camera, depth, Look, lighting, renders) whose
// pieces are a room layout: each piece keeps its place in the room frame (ItemRec.roomAt) and is drawn in the photo's
// scene frame through the photo's pose. Switching photos is a cut: the next photo opens (openSceneAs with the room) and
// the pieces are put where that photo sees them. On a photo without a pose the pieces wait, parked, in the room frame.
/** A piece of a room layout while an unplaced photo is open: its room-frame place and the layout entry it saves as. */
interface Parked {
  readonly uid: string
  readonly id: string
  readonly at: RoomXf
  readonly doc: DocItem
  readonly missing: JsonObject | undefined
}
let parked: Parked[] | null = null
let roomsList: RoomInfo[] = []
let roomsTrash: TrashedRoom[] = []
const LAST_ROOM_KEY = 'midstudy.lastRoom'
const roomPhotoKey = (r: string): string => `midstudy.roomPhoto.${r}`
const roomUrl = (name: string): string => `/api/rooms/${encodeURIComponent(name)}`
/** A layout entry's room-frame place (position, rotation_y_deg), or null when it has none. */
function roomXfOf(o: JsonObject | null): RoomXf | null {
  const pos = o?.['position']
  const pa: readonly unknown[] = Array.isArray(pos) ? pos : []
  const [x, y, z] = pa
  const rot = o?.['rotation_y_deg']
  if (!isNum(x) || !isNum(z)) return null
  return { x, y: isNum(y) ? clampElevation(y) : 0, z, rot: isNum(rot) ? rot : 0 }
}
function parkedOf(it: unknown, missing: JsonObject | undefined): Parked | null {
  const o = rec(it)
  const id = o?.['id']
  const at = roomXfOf(o)
  if (!o || typeof id !== 'string' || !id || !at) return null
  const uidIn = o['uid']
  const uid = typeof uidIn === 'string' && uidIn ? uidIn : newUid(id)
  const render = o['render'] === 'splat' ? 'splat' : 'glb'
  const base = layoutLogic.docItem({ uid, id, render, x: at.x, y: at.y, z: at.z, rotation_y_deg: at.rot }, K)
  const dims = rec(o['dims_cm'])
  return { uid, id, at, doc: dims && libLogic.validDims(dims) ? { ...base, dims_cm: { ...dims } } : base, missing }
}
// The pieces into the parked list (the photo just opened has no pose).
function parkItems(): void {
  if (parked) return
  parked = [...items.values()].map((r) => {
    const at = layoutXf(r)
    const it = layoutLogic.docItem({ uid: r.uid, id: r.id, render: r.render, x: at.x, y: at.y, z: at.z, rotation_y_deg: at.rot }, K)
    const dims = r.lib.dims_cm ?? null
    const doc: DocItem = dims && libLogic.validDims(dims) ? { ...it, dims_cm: { ...dims } } : it
    return { uid: r.uid, id: r.id, at, doc, missing: r.missing ? { ...(r.lib.dims_cm ?? {}) } : undefined }
  })
  quietItems++
  try { clearItemsInternal() } finally { quietItems-- }
}
// The parked pieces back into the scene, where the (now placed) photo sees them.
async function unparkItems(): Promise<void> {
  const list = parked
  if (!list) return
  parked = null
  await quietly(async () => {
    await Promise.allSettled(list.map(async (p) => {
      const x = roomToSceneXf(p.at)
      if (!x) return
      const uid = await addItemInternal(p.id, { uid: p.uid, position: [x.x, x.y, x.z], rotation_y_deg: x.rot, missing: p.missing })
      const r = items.get(uid)
      if (r) r.roomAt = p.at
    }))
  })
}
// The pieces put where the current photo sees them (after a switch, or when its pose or scale changed). Placed →
// placed is a re-projection in place (same uids, selection, splats); placed → unplaced parks them; back unparks them.
function placeRoomItems(): Promise<void> {
  if (!room) return Promise.resolve()
  if (roomUnplaced()) { parkItems(); return Promise.resolve() }
  if (parked) return unparkItems()
  quietItems++
  try {
    for (const r of items.values()) {
      const at = r.roomAt
      const x = at ? roomToSceneXf(at) : null
      if (!at || !x) { syncRoomAt(r); continue }
      r.group.position.set(x.x, x.y, x.z)
      r.rotationDeg = x.rot
      r.group.rotation.set(0, x.rot * DEG, 0)
      r.group.updateMatrixWorld(true)
      syncShadow(r)
      emit('items', { change: 'move', uid: r.uid })
    }
  } finally { quietItems-- }
  return Promise.resolve()
}
/** The room detail as the room view keeps it. */
function membersOf(info: RoomInfo): RoomMember[] {
  const align = info.align
  return info.members.map((m) => {
    const a = align?.members.find((x) => x.scene === m.scene)
    const unplacedByAlign = !!align?.unplaced?.includes(m.scene)
    const conf = a && isNum(a.confidence) ? a.confidence : unplacedByAlign ? 0 : null
    return {
      scene: m.scene, pose: m.pose ? roomLogic.clampPose(m.pose) : null, scale: roomLogic.clampScale(m.scale), pose_source: m.pose_source,
      camera: m.camera ? clampCamera(m.camera) : null, effective_camera: m.effective_camera ? clampCamera(m.effective_camera) : null,
      scene_object: m.scene_object ?? null, confidence: conf,
    }
  })
}
/** Takes a new room detail (an answer of the server): the members, their poses and scales. When the current photo's
 *  pose or scale changed, its camera and the pieces follow (the room frame doesn't move). */
function setRoomInfo(info: RoomInfo): void {
  if (room?.name !== info.name) return
  const before = curMember()
  const was = before ? { pose: before.pose, scale: before.scale } : null
  room.info = info
  room.title = info.title ?? null
  room.members = membersOf(info)
  const now = curMember()
  if (now && (!was || !roomLogic.samePose(was.pose, now.pose) || was.scale !== now.scale)) {
    applyCamera()
    quiet(placeRoomItems())
  }
  emit('room', { phase: 'members', name: info.name })
}
/** Live, without saving: a photo's pose (and scale) while it is dragged on the plan (Align photos). */
function previewPose(scene: unknown, pose: unknown, scale?: unknown): void {
  if (!room || typeof scene !== 'string') return
  const m = room.members.find((x) => x.scene === scene)
  const p = rec(pose)
  if (!m) return
  const before = { pose: m.pose, scale: m.scale }
  if (p) {
    const base = m.pose ?? { x_m: 0, z_m: 0, yaw_deg: 0 }
    const n = (k: 'x_m' | 'z_m' | 'yaw_deg'): number => { const v = p[k]; return isNum(v) ? v : base[k] }
    m.pose = roomLogic.clampPose({ x_m: n('x_m'), z_m: n('z_m'), yaw_deg: n('yaw_deg') })
  } else if (pose === null) m.pose = null
  if (isNum(scale)) m.scale = roomLogic.clampScale(scale)
  if (scene === sceneName && (!roomLogic.samePose(before.pose, m.pose) || before.scale !== m.scale)) {
    applyCamera()
    quiet(placeRoomItems())
  }
  emit('room', { phase: 'pose', name: room.name })
}

async function listRoomsInternal(): Promise<RoomInfo[]> {
  let data: JsonObject | null
  try { data = rec(await apiJson('/api/rooms')) } catch (e) { throw reportError('Could not list the rooms', e) }
  roomsList = roomInfos(data?.['rooms'])
  roomsTrash = trashedRooms(data?.['trash'])
  emit('rooms', { rooms: roomsList.slice() })
  return roomsList.slice()
}
async function getRoomInternal(name: string): Promise<RoomInfo> {
  const info = roomInfo(await apiJson(roomUrl(name)))
  if (!info) throw new Error("the server's answer isn't a room")
  return info
}
async function putRoom(name: string, body: JsonObject, what: string): Promise<RoomInfo> {
  let info: RoomInfo | null
  try { info = roomInfo(await apiJson(roomUrl(name), { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })) } catch (e) {
    throw reportError(`Could not ${what}`, e)
  }
  if (!info) throw reportError(`Could not ${what}`, new Error("the server's answer isn't a room"))
  setRoomInfo(info)
  quiet(listRoomsInternal().catch(() => undefined))
  return info
}
/** POST /api/rooms: a room of existing scenes, in this order (the first is the room frame). */
async function createRoomFromScenes(scenes: readonly string[], title: string | null): Promise<RoomInfo> {
  let info: RoomInfo | null
  try { info = roomInfo(await apiJson('/api/rooms', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title, scenes }) })) } catch (e) {
    throw reportError('Could not make the room', e)
  }
  if (!info) throw reportError('Could not make the room', new Error("the server's answer isn't a room"))
  quiet(listRoomsInternal().catch(() => undefined))
  quiet(listScenesInternal().catch(() => undefined))
  return info
}
/** POST /api/rooms/<room>/align (§4.9 Align): queues an alignment; resolves with the job when it is accepted. */
async function alignRoom(name: unknown, opts: unknown = {}): Promise<AlignJobInfo> {
  const r = typeof name === 'string' && name ? name : room?.name
  if (!r) throw reportError('No room is open')
  const o = rec(opts) ?? {}
  const body = { ...(typeof o['solver'] === 'string' ? { solver: o['solver'] } : {}), ...(o['overwrite_manual'] === true ? { overwrite_manual: true } : {}) }
  let job: AlignJobInfo | null
  try { job = alignJob(rec(await apiJson(`${roomUrl(r)}/align`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }))?.['job']) } catch (e) {
    throw reportError(statusOf(e) === 409 ? 'An alignment is already running for this room, or it has fewer than two photos' : 'Could not start the alignment', e)
  }
  if (!job) throw reportError('Could not start the alignment', new Error("the server's answer has no job"))
  emit('room', { phase: 'aligning', name: r })
  quiet(followAlign(r))
  return job
}
// Polls the room while its alignment is pending or running, then takes the result (the open room's poses).
const following = new Set<string>()
async function followAlign(name: string): Promise<void> {
  if (following.has(name)) return
  following.add(name)
  try {
    for (let i = 0; i < 2400; i++) {
      await sleep(i < 10 ? 500 : 1500)
      let info: RoomInfo
      try { info = await getRoomInternal(name) } catch (e) { if (statusOf(e) === 404) return; continue }
      const st = info.align_status ?? 'none'
      if (st === 'pending' || st === 'running') continue
      setRoomInfo(info)
      quiet(listRoomsInternal().catch(() => undefined))
      emit('room', { phase: st === 'failed' ? 'align-failed' : 'aligned', name })
      if (st === 'failed') toast(`Alignment failed: ${info.align_error ?? 'see the server log'}`, 'error')
      return
    }
  } finally { following.delete(name) }
}
/** New room (§4.9 hook createRoom): each photo uploaded (POST /api/scenes), the room made in that order, then an
 *  alignment asked for; resolves when all three are accepted. */
async function createRoom(files: unknown, meta: unknown = {}): Promise<{ room: string; scenes: string[]; job: AlignJobInfo | null }> {
  const list: unknown[] = Array.isArray(files) ? files : []
  if (!list.length || !list.every((f) => f instanceof Blob)) throw reportError('createRoom needs a list of photo files')
  const t = rec(meta)?.['title']
  const title = typeof t === 'string' && t.trim() ? t.trim() : null
  const scenes: string[] = []
  for (const f of list) {
    const res = sceneCreated(await createScene(f, {}))
    if (!res) throw reportError("Could not make the room: the server didn't name the new scene")
    scenes.push(res.scene)
  }
  const info = await createRoomFromScenes(scenes, title)
  const job = scenes.length >= 2 ? await alignRoomWhenReady(info.name) : null
  return { room: info.name, scenes, job }
}
/** POST …/align right after New room: the server refuses an alignment while fewer than two members have a photo.jpg
 *  (§4.9: 409), and a just-uploaded photo has none until its calibration job has started (ingest). So wait until two
 *  members show a photo (photo_url), then ask (docs/notes/rooms-app.md: the contract's createRoom expects 202 at once). */
async function alignRoomWhenReady(name: string): Promise<AlignJobInfo | null> {
  for (let i = 0; i < 600; i++) {
    let info: RoomInfo | null = null
    try { info = await getRoomInternal(name) } catch { /* try again */ }
    if (info && info.members.filter((m) => !!m.scene_object?.photo_url).length >= 2) return alignRoom(name)
    await sleep(i < 20 ? 250 : 1000)
  }
  throw reportError('Could not start the alignment: the photos never arrived')
}
/** Resolves when every member has finished calibrating and the alignment isn't pending or running (§4.9 hook). */
async function waitForRoom(name: unknown): Promise<RoomInfo> {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`"${asText(name)}" isn't a room name`)
  const t0 = performance.now()
  for (;;) {
    let info: RoomInfo
    try { info = await getRoomInternal(name) } catch (e) {
      if (statusOf(e) === 404) throw reportError(`There's no room "${name}"`, e)
      if (performance.now() - t0 > 15 * 60e3) throw reportError(`Gave up waiting for "${name}"`, e)
      await sleep(2000)
      continue
    }
    const calibrated = info.members.every((m) => sceneLogic.calibFinished(m.scene_object?.calib_status ?? 'done'))
    const st = info.align_status ?? 'none'
    if (calibrated && st !== 'pending' && st !== 'running') { setRoomInfo(info); return info }
    await sleep(700)
  }
}
/** Opens a room (§4.9 Room view) on a member photo: `photo`, else the one this device last had open there, else the
 *  first placed one. Resolves when the photo (and depth) are shown and the room layout loaded. */
async function openRoom(name: unknown, photoWanted?: unknown): Promise<void> {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`"${asText(name)}" isn't a room name`)
  let info: RoomInfo
  try { info = await getRoomInternal(name) } catch (e) { throw reportError(statusOf(e) === 404 ? `There's no room "${name}"` : `Could not open the room "${name}"`, e) }
  const lite = info.members.map((m) => ({ scene: m.scene, placed: !!m.pose }))
  const pick = roomLogic.photoToOpen(lite, typeof photoWanted === 'string' ? photoWanted : null, store.get(roomPhotoKey(name)))
  if (!pick) throw reportError(`The room "${info.title ?? name}" has no photos yet: add some on the Scenes page`)
  await openSceneAs(pick, info)
}
/** Switches the room view to another member photo (the photo strip, keys 1–9). */
async function setRoomPhoto(scene: unknown): Promise<void> {
  if (!room) throw reportError('No room is open')
  if (typeof scene !== 'string' || !room.members.some((m) => m.scene === scene)) throw reportError(`"${asText(scene)}" isn't a photo of this room`)
  if (scene === sceneName && !sceneLoad.loading) return
  await openSceneAs(scene, room.info)
}
/** Align photos and setPose (§4.9): a member's new pose (and scale), saved (PUT members: pose_source manual). */
async function setPose(scene: unknown, partial: unknown = {}): Promise<RoomInfo> {
  if (!room) throw reportError('No room is open')
  const m = typeof scene === 'string' ? room.members.find((x) => x.scene === scene) : undefined
  if (!m) throw reportError(`"${asText(scene)}" isn't a photo of this room`)
  const o = rec(partial) ?? {}
  const base = m.pose ?? { x_m: 0, z_m: 0, yaw_deg: 0 }
  const n = (k: 'x_m' | 'z_m' | 'yaw_deg'): number => { const v = o[k]; return isNum(v) ? v : base[k] }
  const pose = partial === null ? null : roomLogic.clampPose({ x_m: n('x_m'), z_m: n('z_m'), yaw_deg: n('yaw_deg') })
  const sc = o['scale']
  const body = { members: roomLogic.membersWithPose(room.members.map((x) => x.scene), m.scene, pose, isNum(sc) ? sc : null) }
  return putRoom(room.name, body, 'save the photo\'s place')
}
/** Align photos' Reset (§4.9): the photo back to the solver's answer (PUT {reset: [scene]}). */
function resetPose(scene: unknown): Promise<RoomInfo> {
  if (!room) return Promise.reject(reportError('No room is open'))
  if (typeof scene !== 'string' || !room.members.some((m) => m.scene === scene)) return Promise.reject(reportError(`"${asText(scene)}" isn't a photo of this room`))
  return putRoom(room.name, { reset: [scene] }, 'reset the photo to the alignment')
}
/** Set scale for the room (§4.9, room-scale): the ruler's measured length made `meters`: every member's scale and
 *  every pose's position × k (PUT {rescale: k}); the scene's camera is left as it is. */
async function setRoomScale(meters: unknown): Promise<number | null> {
  if (!room) throw reportError('No room is open')
  const r = getRuler()
  const k = r.meters !== null && isNum(meters) ? roomLogic.rescaleFactor(r.meters, meters) : null
  if (k === null) return null
  const before = ruler.points
  await putRoom(room.name, { rescale: k }, 'set the room\'s scale')
  // the ruler's points stay on the same photo pixels: the floor under them scaled with the effective camera
  ruler.points = before.map((p): Vec3 => [p[0] * k, 0, p[2] * k])
  emit('ruler', getRuler())
  return k
}
async function renameRoom(name: string, title: unknown): Promise<void> {
  const t = typeof title === 'string' && title.trim() ? title.trim() : null
  await putRoom(name, { title: t }, 'rename the room')
  if (room?.name === name) room.title = t
  emit('room', { phase: 'title', name })
}
/** A room's member scenes as the planner knows them (the open room's, else the list's). */
async function memberScenes(name: string): Promise<string[]> {
  if (room?.name === name) return room.members.map((m) => m.scene)
  const info = roomsList.find((r) => r.name === name) ?? await getRoomInternal(name)
  return info.members.map((m) => m.scene)
}
async function addSceneToRoom(name: string, scene: string): Promise<RoomInfo> {
  return putRoom(name, { members: roomLogic.membersAdding(await memberScenes(name), scene) }, 'add the photo to the room')
}
async function removeSceneFromRoom(name: string, scene: string): Promise<RoomInfo> {
  const info = await putRoom(name, { members: roomLogic.membersRemoving(await memberScenes(name), scene) }, 'take the photo out of the room')
  if (room?.name === name && sceneName === scene) {
    const next = room.members[0]
    if (next) await openSceneAs(next.scene, info)
    else closeScene()
  }
  quiet(listScenesInternal().catch(() => undefined))
  return info
}
async function deleteRoom(name: unknown): Promise<void> {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`"${asText(name)}" isn't a room name`)
  try { await apiJson(roomUrl(name), { method: 'DELETE' }) } catch (e) { throw reportError(`Could not delete the room "${name}"`, e) }
  if (store.get(LAST_ROOM_KEY) === name) store.set(LAST_ROOM_KEY, null)
  if (room?.name === name) closeScene()
  emit('room', { phase: 'deleted', name })
  quiet(listRoomsInternal().catch(() => undefined))
  quiet(listScenesInternal().catch(() => undefined))
}
async function restoreRoom(name: unknown): Promise<void> {
  if (typeof name !== 'string' || !SLUG.test(name)) throw reportError(`"${asText(name)}" isn't a room name`)
  try { await apiJson(`${roomUrl(name)}/restore`, { method: 'POST' }) } catch (e) {
    throw reportError(statusOf(e) === 409 ? `A room named "${name}" exists again` : `Could not restore the room "${name}"`, e)
  }
  emit('room', { phase: 'restored', name })
  await listRoomsInternal()
  quiet(listScenesInternal().catch(() => undefined))
}
function setAlignPhotos(on: unknown): void {
  alignPhotos = !!on && !!room
  if (alignPhotos) select(null)
  emit('room', { phase: 'align-photos', name: room?.name ?? null })
}
function setFloorPlanShown(on: unknown): void {
  floorPlanShown = !!on
  if (!floorPlanShown && alignPhotos) alignPhotos = false
  emit('room', { phase: 'floor-plan', name: room?.name ?? null })
}
/** getRoom() (§4.9 hook): the open room, its current photo and every member's pose, scale and cameras. */
interface RoomReport {
  name: string
  title: string | null
  photo: string
  members: { scene: string; index: number; pose: Pose | null; scale: number; pose_source: string; camera: Camera | null; effective_camera: Camera | null; confidence: number | null }[]
}
function getRoom(): RoomReport | null {
  if (!room || !sceneName) return null
  const cur = sceneName
  return {
    name: room.name, title: room.title, photo: cur,
    members: room.members.map((m, index) => {
      const own = m.scene === cur
      const camera = own ? cameraLogic.cameraCopy(cam) : m.camera
      const eff = own ? cameraLogic.cameraCopy(drawCam()) : m.effective_camera ?? (m.camera ? roomLogic.effectiveCamera(m.camera, m.scale) : null)
      return { scene: m.scene, index, pose: m.pose ? { ...m.pose } : null, scale: m.scale, pose_source: m.pose_source, camera, effective_camera: eff, confidence: m.confidence }
    }),
  }
}
/** A member's pose: the scene given, else the current photo's (null when it isn't placed or isn't a member). */
function poseOf(scene: unknown): Pose | null {
  if (!room) return null
  const n = typeof scene === 'string' ? scene : sceneName
  return room.members.find((m) => m.scene === n)?.pose ?? null
}
function roomToSceneHook(p: unknown, scene?: unknown): Vec3 | null {
  const pose = poseOf(scene)
  return pose ? roomLogic.roomToScene(xyz(pointLike(p)), pose) : null
}
function sceneToRoomHook(p: unknown, scene?: unknown): Vec3 | null {
  const pose = poseOf(scene)
  return pose ? roomLogic.sceneToRoom(xyz(pointLike(p)), pose) : null
}
/** A hook point ([x, y, z] or {x, y, z}); anything else is NaN. */
function pointLike(p: unknown): PointLike {
  if (Array.isArray(p)) { const a: readonly unknown[] = p; return a.map((v) => (typeof v === 'number' ? v : Number(v))) }
  const o = rec(p)
  if (o) { const n = (v: unknown): number => (typeof v === 'number' ? v : Number.NaN); return { x: n(o['x']), y: n(o['y']), z: n(o['z']) } }
  return [Number.NaN, Number.NaN, Number.NaN]
}

/** The occlusion depth's scale for a scene's calib.json at camera height `height_m` (§4.5 Occlusion): the floor plan
 *  lifts every member's depth.png with its effective camera. */
function depthScaleFor(calib: unknown, height: number): number {
  const c = rec(calib)
  const floor = rec(c?.['floor'])
  const source = c?.['source']
  const measured = !!floor?.['found'] && (source === 'moge-2' || source === 'truth')
  return kDepthScale(height, Number(rec(c?.['camera'])?.['height_m']), measured)
}
/** Every piece of the open layout in its layout frame (the room frame in a room view; parked ones too), with its local
 *  box (the item frame; a parked piece's from its dims): what the floor plan draws. */
function layoutItems(): { uid: string; at: RoomXf; box: { min: Vec3; max: Vec3 } | null }[] {
  if (parked) {
    return parked.map((p) => {
      const own = 'dims_cm' in p.doc ? rec(p.doc.dims_cm) : null
      const d = libLogic.validDims(own) ?? libLogic.validDims(library.find((l) => l.id === p.id)?.dims_cm ?? null)
      const min: Vec3 = d ? [-d.w / 200, 0, -d.d / 200] : [0, 0, 0]
      const max: Vec3 = d ? [d.w / 200, d.h / 100, d.d / 200] : [0, 0, 0]
      return { uid: p.uid, at: p.at, box: d ? { min, max } : null }
    })
  }
  return [...items.values()].map((r) => ({
    uid: r.uid, at: layoutXf(r),
    box: r.localBox ? { min: [r.localBox.min.x, r.localBox.min.y, r.localBox.min.z], max: [r.localBox.max.x, r.localBox.max.y, r.localBox.max.z] } : null,
  }))
}

// The hook's item and projection calls (§2.4, §4.6) in a room view take and give room-frame places (§4.9 Hook);
// outside a room they are the scene calls as they were.
function addItemHook(id: unknown, position: unknown, rotation: unknown): Promise<string> {
  const pose = curPose()
  if (!room || !pose) return addItemInternal(id, { position, rotation_y_deg: rotation })
  const pa: readonly unknown[] = Array.isArray(position) ? position : []
  const [x, y, z] = pa
  const given = pa.length >= 3 && isNum(x) && isNum(z)
  const p = given ? roomLogic.roomToScene([x, isNum(y) ? y : 0, z], pose) : null
  const rot = isNum(rotation) ? roomLogic.rotationToScene(rotation, pose) : rotation
  return addItemInternal(id, { position: p ? [p[0], y, p[2]] : position, rotation_y_deg: rot })
}
function moveItemHook(uid: unknown, opts: unknown): void {
  const r = typeof uid === 'string' ? items.get(uid) : undefined
  const pose = curPose()
  if (!room || !pose || !r) { moveItemInternal(uid, opts); return }
  const o = rec(opts) ?? {}
  const at = r.roomAt ?? layoutXf(r)
  const pos = o['position']
  const pa: readonly unknown[] = Array.isArray(pos) ? pos : []
  const [x, y, z] = pa
  const out: { position?: unknown[]; rotation_y_deg?: number } = {}
  if (Array.isArray(pos)) {
    const p = roomLogic.roomToScene([isNum(x) ? x : at.x, 0, isNum(z) ? z : at.z], pose)
    out.position = [p[0], y, p[2]]
  }
  const rot = o['rotation_y_deg']
  if (isNum(rot)) out.rotation_y_deg = roomLogic.rotationToScene(rot, pose)
  moveItemInternal(uid, out)
  // exactly the room place asked for (the round trip through the scene frame is only good to ~1e-15)
  if (r.roomAt) r.roomAt = { x: isNum(x) ? x : r.roomAt.x, y: r.group.position.y, z: isNum(z) ? z : r.roomAt.z, rot: isNum(rot) ? rot : r.roomAt.rot }
}
function photoToFloorHook(px: unknown, py: unknown): Vec3 | null {
  const p = photoToFloor(px, py)
  if (!room || !p) return p
  const pose = curPose()
  return pose ? roomLogic.sceneToRoom(p, pose) : null
}
function floorToPhotoHook(p: PointLike): [number, number] {
  if (!room) return floorToPhoto(p)
  const pose = curPose()
  if (!pose) return [Number.NaN, Number.NaN]
  return floorToPhoto(roomLogic.roomToScene(xyz(p), pose))
}

// --- look and lighting (contract §4.8) --------------------------------------------------------------------------------
function getLook(): LookView { return lookLogic.lookView(look) }
function emitLook(): void { emit('look', getLook()) }
// The values in use: with Auto lighting on, the inferred direction and softness (lighting.json's key turned to the
// world, or the v1 key light); off, the stored ones (each falling back to the inferred one).
function resolvedLook(): ResolvedLook {
  const inf = lights.inferred()
  const dir = inf ? inf.direction : V1_KEY_DIR
  const ae = azElOf(dir)
  const auto = { dir, softness: inf ? inf.softness : V1_SOFTNESS, azimuth_deg: ae.azimuth_deg, elevation_deg: ae.elevation_deg }
  return lookLogic.resolveLook(look, auto, !!lightingData, dirOf)
}
function applyLook(): void {
  P.comp.exposure.value = look.exposure
  const tint = splatMultiplier(look.warmth, 1, [1, 1, 1]) // the kernels' warmth tint (× exposure 1 × gain 1, exactly)
  P.comp.tint.value.set(tint[0], tint[1], tint[2])
  lights.setLook(resolvedLook())
  // splats (§4.5, §4.8): a plain multiplier, the Look's exposure × warmth times the room's light colour and level
  const g = splatMultiplier(look.warmth, look.exposure, lights.splatGain())
  P.splatGain.value.set(g[0], g[1], g[2])
  for (const r of items.values()) syncShadow(r)
  emitLook()
}
// getLighting() (hook, §4.8): the Look's values in use, where the light comes from, and the key in the world frame.
function getLighting(): LightingReport {
  const src = lightingData ? lightingData['source'] : null
  return lookLogic.lightingReport(look, resolvedLook(), lights.inferred(), lights.inUse(), lookLogic.lightingSourceOf(!!lightingData, src), lightingStatus, K)
}
// setLighting(partial) (hook, §4.8): live. A direction or softness turns Auto lighting off unless auto_light is given.
// The Look saves itself: PUT /api/scenes/<name> {look} 0.7 s after the last change (and at once when the scene is
// closed or another opens, or the page hides), so a lighting tweak is never lost and never waits for Save scene.
let lookTimer: ReturnType<typeof setTimeout> | null = null
function saveLookSoon(): void {
  if (!sceneName) return
  if (lookTimer !== null) clearTimeout(lookTimer)
  lookTimer = setTimeout(flushLook, 700)
}
function flushLook(): void {
  if (lookTimer === null) return
  clearTimeout(lookTimer)
  lookTimer = null
  const name = sceneName
  if (!name) return
  const saved = lookLogic.lookCopy(look)
  quiet(apiJson(sceneUrl(name), { method: 'PUT', keepalive: true, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ look: lookLogic.lookToSave(look) }) })
    .then(() => { if (name === sceneName && savedScene) savedScene.look = saved })
    .catch((e: unknown) => { throw reportError(msg.lookSaveText(statusOf(e)), e) }))
}
addEventListener('pagehide', flushLook)
addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushLook() })
function setLighting(p: unknown = {}): void {
  const o = rec(p)
  if (!o) { reportError('setLighting needs an object like { light_strength: 1.2 }'); return }
  let inUse: lookLogic.InUse | null = null
  if (lookLogic.needsFreeze(look, o)) {
    const r = resolvedLook()
    inUse = { light_azimuth_deg: r.light_azimuth_deg, light_elevation_deg: r.light_elevation_deg, light_softness: r.light_softness }
  }
  const before = look
  look = lookLogic.patchLook(look, o, inUse, K)
  applyLook()
  if (lookLogic.lookChanged(before, look)) saveLookSoon()
}
// resetLighting() (hook, Reset): Auto lighting, strength, ambient, exposure and warmth back; the shadows to their
// defaults; the stored direction and softness gone.
function resetLighting(): void {
  look = lookLogic.defaultLook()
  applyLook()
  saveLookSoon()
}
function setLook(s: unknown = {}): void {
  const o = rec(s) ?? {}
  const e = o['exposure']
  const w = o['warmth']
  setLighting({ ...(isNum(e) ? { exposure: e } : {}), ...(isNum(w) ? { warmth: w } : {}) })
}
function setLightingData(data: JsonObject | null): void {
  lightingData = rec(data?.['lighting'])
  lightingStatus = lookLogic.lightingStatusOf(data?.['lighting_status'], !!lightingData, data?.['lighting_error'])
  lights.setData(lightingData)
}
function emitLighting(): void { emit('lighting', { status: lightingStatus.status, error: lightingStatus.error }); emitLook() }
// A scene calibrated before lighting.json existed (§4.8 backfill): POST …/light runs only the lighting step on the
// server; this polls the scene until it is there (or the server found none), then lights the furniture with it.
// Opening such a scene starts it; the Look panel's "Infer lighting" starts it again after a failure.
async function inferLighting(): Promise<LightingReport | null> {
  const name = sceneName
  if (!name) throw reportError('No scene is open')
  const token = ++lightingToken
  try {
    await apiJson(`${sceneUrl(name)}/light`, { method: 'POST' })
  } catch (e) {
    const st = statusOf(e)
    if (name === sceneName) { lightingStatus = { status: 'failed', error: msg.lightWhyText(st) }; emitLighting() }
    throw reportError(msg.lightStartText(st), e)
  }
  lightingStatus = { status: 'pending', error: null }
  emitLighting()
  for (let i = 0; i < 600; i++) {
    await sleep(sceneLogic.lightPollMs(i))
    if (name !== sceneName || token !== lightingToken) return null
    let data: JsonObject
    try { data = await getSceneInternal(name) } catch { continue }
    if (name !== sceneName || token !== lightingToken) return null
    const st = lookLogic.lightingStatusOf(data['lighting_status'], !!data['lighting'], null).status
    if (st === 'pending' || st === 'running') {
      if (st !== lightingStatus.status) { lightingStatus = { status: st, error: null }; emitLighting() }
      continue
    }
    sceneData = { ...sceneData, lighting: data['lighting'] ?? null, lighting_status: st, lighting_error: data['lighting_error'] ?? null }
    setLightingData(sceneData)
    applyLook()
    emitLighting()
    if (st === 'done') toast('Lighting inferred from the photo', 'ok', 3500)
    else if (st === 'failed') toast(`Couldn't infer the light: ${lightingStatus.error ?? 'see the server log'}`, 'error')
    return getLighting()
  }
  return null
}

// --- drawing ------------------------------------------------------------------------------------------------------------
// The pieces that cast the key's shadow, as one world box (null without any): the shadow camera is fitted to it.
function shadowBox(): THREE.Box3 | null {
  if (!lights.castsShadow() || !items.size) return null
  const b = new THREE.Box3()
  for (const r of items.values()) if (r.child && !r.missing) b.union(worldBounds(r))
  return b.isEmpty() ? null : b
}
function drawTo(target: THREE.RenderTarget | null, furniture = true): void {
  P.depth.pass.scale.value = depthScale() // every frame: the camera or calib.json (Calibrate again) may have changed
  if (furniture) lights.fitShadow(shadowBox())
  drawFrame(P, target, { scene, camera, furniture, splats: splatLayer && splatItemCount() > 0 ? { layer: splatLayer, key: splatKey } : null })
}
function renderFrame(): void { drawTo(null, !!sceneName) }

/** A capture of the full photo frame (§4.7): a JPEG data URL and its size. */
export interface Shot {
  readonly dataUrl: string
  readonly width: number
  readonly height: number
}

// The view draws nothing while a capture holds it (holdFrames): a capture changes the camera, the targets and (the
// mask) the pieces' materials, and waits for its read-back and the splats' sort in between.
async function holding<T>(fn: () => Promise<T>): Promise<T> {
  holdFrames++
  try { return await fn() } finally { holdFrames--; wake() }
}

// The full photo frame at the photo's resolution (or scaled to maxPx): photo + furniture + splats, no view offset, no
// grid; the splats sorted for it first.
// The view as a 2D canvas: the photo's own size times k (no view offset, no grid, no UI).
function captureCanvas(k: number): Promise<HTMLCanvasElement> {
  if (!photo.has) return Promise.reject(new Error('no photo is open'))
  const w = Math.max(1, Math.round(photo.w * k)), h = Math.max(1, Math.round(photo.h * k))
  return holding(async () => {
    const pixels = await withFullFrame(P, camera, photo.w / photo.h, w, h, async () => {
      await settleSplats()
      const out = captureTarget(P, w, h)
      drawTo(out)
      return readRgba(renderer, out, w, h)
    }, updateView)
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx2 = c.getContext('2d')
    if (!ctx2) throw new Error('no 2D canvas')
    ctx2.putImageData(new ImageData(new Uint8ClampedArray(pixels.buffer), w, h), 0, 0)
    return c
  })
}
async function captureShot(maxPx: number | null, quality: number): Promise<Shot> {
  const t0 = performance.now()
  const c = await captureCanvas(maxPx ? Math.min(1, maxPx / Math.max(photo.w, photo.h)) : 1)
  const shot = { dataUrl: c.toDataURL('image/jpeg', quality), width: c.width, height: c.height }
  measure('render-capture', t0)
  return shot
}
/** exportImage's result: the image (null with encode: false), the canvas it came from, its size and type. */
interface ExportShot {
  readonly blob: Blob | null
  readonly canvas: HTMLCanvasElement
  readonly width: number
  readonly height: number
  readonly type: string
}
// Export (no AI, free, nothing leaves the device): the scene as drawn, at `longEdge` px on its longer side (default the
// photo's own size; up to 2× it), as a JPEG or PNG blob, and the canvas. encode: false skips the blob (the caller
// composes the canvas itself, as Before and after does).
async function exportImage(opts: { longEdge?: number | null; type?: string; quality?: number; encode?: boolean } = {}): Promise<ExportShot> {
  const type = opts.type ?? 'image/jpeg'
  if (!sceneName || !photo.has) throw reportError('Open a scene first, then export it')
  if (type !== 'image/jpeg' && type !== 'image/png') throw reportError(`Can't export as ${type} (JPEG or PNG)`)
  const long = Math.max(photo.w, photo.h)
  const le = opts.longEdge
  const k = isNum(le) && le > 0 ? Math.min(2, le / long) : 1
  let canvas: HTMLCanvasElement
  try { canvas = await captureCanvas(k) } catch (e) { throw reportError('Could not capture the view', e) }
  if (opts.encode === false) return { blob: null, canvas, width: canvas.width, height: canvas.height, type }
  const blob = await new Promise<Blob | null>((res) => { canvas.toBlob(res, type, type === 'image/jpeg' ? (opts.quality ?? 0.92) : undefined) })
  if (!blob) throw reportError('Could not encode the image')
  return { blob, canvas, width: canvas.width, height: canvas.height, type }
}
// A Promise: the read-back is asynchronous on both backends; a capture that can't be made rejects.
function captureComposite(opts: { maxPx?: number | null; quality?: number } = {}): Promise<Shot> {
  return captureShot(opts.maxPx ?? null, opts.quality ?? 0.92)
}
// The keep-room mask (§4.7): items white on black at the photo's size (what the photo hides of them stays black),
// dilated by 3 % of the photo's width, and twice that below each piece for its shadow, and its PNG: the kernels, here
// (a few ms at 2048 × 1152: the worker's copy and round trip would cost more than they free).
// → { dataUrl, width, height, coverage }
interface MaskShot {
  dataUrl: string
  width: number
  height: number
  coverage: number
}
async function captureMask(): Promise<MaskShot> {
  if (!photo.has) throw new Error('no photo is open')
  const t0 = performance.now()
  const w = photo.w, h = photo.h
  const pixels = await holding(async () => {
    const swapped: [THREE.Mesh | THREE.Line, THREE.Material | THREE.Material[], boolean][] = []
    const shown: THREE.Object3D[] = [] // a splat item's invisible GLB (or box) stands for its splat here (the mask is dilated anyway)
    for (const r of items.values()) {
      if (r.splat && r.child && !r.child.visible) { r.child.visible = true; shown.push(r.child) }
      r.group.traverse((o) => {
        if (isMesh(o) || isLine(o)) {
          swapped.push([o, o.material, o.visible])
          o.material = P.maskMat
          if (isLine(o)) o.visible = false
        }
      })
    }
    lights.maskMode(true) // the pieces' cast shadow on the floor is part of what the render may change
    try {
      return await withFullFrame(P, camera, photo.w / photo.h, w, h, () => {
        lights.fitShadow(shadowBox())
        const rt = maskTarget(P, w, h)
        drawMask(P, scene, camera, rt)
        return readRgba(renderer, rt, w, h)
      }, updateView)
    } finally {
      lights.maskMode(false)
      for (const [o, m, v] of swapped) { o.material = m; o.visible = v }
      for (const o of shown) o.visible = false
    }
  })
  const m: KeepRoomMask = keepRoomMask(pixels, w, h, { png: true, bottomUp: false })
  if (!m.png) throw new Error('the mask has no PNG')
  const dataUrl = await pngDataUrl(m.png)
  measure('mask-build', t0)
  return { dataUrl, width: w, height: h, coverage: m.coverage }
}
function pngDataUrl(png: Uint8Array): Promise<string> {
  const bytes = new Uint8Array(png) // a Blob takes bytes on their own ArrayBuffer
  return new Promise((resolve, reject) => {
    const fr = new FileReader()
    fr.onload = () => { resolve(typeof fr.result === 'string' ? fr.result : '') }
    fr.onerror = () => { reject(fr.error ?? new Error('could not read the mask PNG')) }
    fr.readAsDataURL(new Blob([bytes], { type: 'image/png' }))
  })
}

// --- render (contract §2.6, §4.7) ---------------------------------------------------------------------------------------
/** The render models, the default first (Nano Banana takes the scene photo as a reference, image 2; GPT Image gets the scene alone). */
export const RENDER_MODELS: Readonly<Record<RenderModel, { readonly label: string; readonly price: (megapixels: number) => number }>> = {
  'nano-banana': { label: money.renderLabel('nano-banana'), price: (mp) => money.renderModelPrice('nano-banana', mp) },
  kontext: { label: money.renderLabel('kontext'), price: (mp) => money.renderModelPrice('kontext', mp) },
  qwen: { label: money.renderLabel('qwen'), price: (mp) => money.renderModelPrice('qwen', mp) },
  'gpt-image': { label: money.renderLabel('gpt-image'), price: (mp) => money.renderModelPrice('gpt-image', mp) },
}
export const fmtUsd = (v: number): string => text.fmtUsd(v)
/** A render's price before asking: qwen by the capture's megapixels (1 MP without a capture). */
export function renderPrice(model: string, shot: { width: number; height: number } | null | undefined): number {
  if (!money.isRenderModel(model)) throw new TypeError("Cannot read properties of undefined (reading 'price')")
  return RENDER_MODELS[model].price(shot ? money.megapixels(shot.width, shot.height) : 1)
}
let renders: RenderMeta[] = []
let renderMock = false
// opts: { model, prompt, keepRoom, mask (from captureMask, when keepRoom) }
async function postRender(shot: Shot, opts: { model?: string; prompt?: string | null | undefined; keepRoom?: boolean; mask?: MaskShot | null } = {}): Promise<RenderMeta> {
  const model = str(opts.model) ?? 'nano-banana'
  const layout = layoutName.trim()
  const scn = sceneName
  let answer: unknown
  emit('render', { phase: 'start', model })
  try {
    answer = await apiJson('/api/render', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        image: shot.dataUrl, model, prompt: str(opts.prompt) ?? undefined, scene: str(scn) ?? undefined,
        ...(room ? { room: room.name } : {}), // §4.7 Room: the capture is the current photo's; layout names the room layout
        layout: SLUG.test(layout) ? layout : undefined,
        ...(opts.keepRoom ? { keep_room: true, mask: opts.mask?.dataUrl } : {}),
      }),
    })
  } catch (e) {
    emit('render', { phase: 'failed', model, error: detailOf(e) })
    throw reportError(msg.renderFailText(statusOf(e)), e)
  }
  const meta = renderMeta(answer)
  if (!meta) {
    emit('render', { phase: 'failed', model, error: 'not a render' })
    throw reportError(msg.renderFailText(null), new Error("the server's answer isn't a render"))
  }
  emit('render', { phase: 'done', model, meta })
  if (room ? meta.room === room.name : meta.scene === sceneName) {
    renders = [meta, ...renders.filter((r) => r.name !== meta.name)]
    emit('renders', { renders: renders.slice() })
  }
  return meta
}
async function renderViewInternal(opts: unknown = {}): Promise<RenderMeta> {
  const o = rec(opts) ?? {}
  const model = o['model']
  const a = msg.renderArgs(model, asText(model), o['prompt'], !!o['keepRoom'], Object.keys(RENDER_MODELS))
  if (!a.ok) throw reportError(a.error)
  if (!sceneName) throw reportError('Open a scene first, then render it')
  // §4.7: the composite (the splats sorted for its camera first), then the keep-room mask; the view holds still meanwhile.
  let shot: Shot
  let mask: MaskShot | null = null
  try {
    shot = await captureComposite()
    if (a.keepRoom) mask = await captureMask()
  } catch (e) { throw reportError('Could not capture the view', e) }
  return postRender(shot, { model: a.model, prompt: a.prompt, keepRoom: a.keepRoom, mask })
}
async function listRendersInternal(): Promise<RenderMeta[]> {
  let data: JsonObject | null
  // a room view lists the room's renders (every photo, §4.7 Room); a scene its own
  const q = room ? `?room=${encodeURIComponent(room.name)}` : sceneName ? `?scene=${encodeURIComponent(sceneName)}` : ''
  try { data = rec(await apiJson(`/api/renders${q}`)) } catch (e) { throw reportError('Could not list renders', e) }
  renders = renderMetas(data?.['renders'])
  renderMock = data?.['mock'] === true
  emit('renders', { renders: renders.slice() })
  return renders.slice()
}
function compare(a: unknown, b: unknown): void {
  const nameOf = (x: unknown): unknown => (typeof x === 'string' ? x : rec(x)?.['name'])
  const na = nameOf(a)
  const nb = nameOf(b)
  if (typeof na !== 'string' || typeof nb !== 'string' || !msg.bothNamed(na, nb)) { reportError('compare needs two render names'); return }
  emit('compare', { a: na, b: nb })
}

// --- render loop + overlay hooks ----------------------------------------------------------------------------------------
const frameFns = new Set<(dt: number) => void>()
function onFrame(fn: (dt: number) => void): () => boolean {
  frameFns.add(fn)
  return () => frameFns.delete(fn)
}
try { await kernelsReady } catch (e) { reportError('Could not load the planner kernels', e) }
applyCamera()
const clock = new THREE.Clock()
let renderErrorReported = false
void renderer.setAnimationLoop(() => {
  try {
    const dt = Math.min(clock.getDelta(), 0.1)
    if (holdFrames) return
    if (performance.now() > awakeUntil && !framePending) return
    framePending = false
    renderFrame()
    for (const fn of frameFns) fn(dt)
  } catch (e) {
    if (!renderErrorReported) reportError('Rendering failed', e)
    renderErrorReported = true
  }
})

// --- state for window.midstudy (contract §2.4, §4.6) --------------------------------------------------------------------
/** getState().scene (§4.6). */
interface SceneState {
  name: string
  title: unknown
  camera: Camera
  camera_source: string
  floor_found: unknown
  hasDepth: boolean
  occlusion: boolean
  adjustFloor: boolean
}
function getSceneState(): SceneState | null {
  if (!sceneName) return null
  return {
    name: sceneName, title: sceneData?.['title'] ?? null, camera: cameraLogic.cameraCopy(cam), camera_source: cameraSource,
    floor_found: rec(rec(sceneData?.['calib'])?.['floor'])?.['found'] ?? null, hasDepth: !!photo.depthTexture, occlusion, adjustFloor,
  }
}
/** getState().items[] (§4.6). */
interface StateItem {
  uid: string
  id: string
  render: Render
  splats?: number
  position: Vec3
  rotation_y_deg: number
  missing?: true
  worldBounds: { min: Vec3; max: Vec3 }
}
/** getState().room (§4.9 hook). */
interface RoomStateReport {
  name: string
  title: string | null
  photo: string
  alignPhotos: boolean
  floorPlan: boolean
}
/** window.midstudy.getState() (§4.6, §4.9). */
export interface PlannerState {
  scene: SceneState | null
  items: StateItem[]
  layout: string | null
  dirty: boolean
  room: RoomStateReport | null
}
// In a room view every position the hook gives is in the room frame (§4.9 Hook): a piece's room place, and its bounds
// as its box stands there.
function stateItem(r: ItemRec): StateItem {
  const at = room ? r.roomAt : null
  const b = at && r.localBox ? kWorldBounds({ position: [at.x, at.y, at.z], rotation_y_deg: at.rot, min: [r.localBox.min.x, r.localBox.min.y, r.localBox.min.z], max: [r.localBox.max.x, r.localBox.max.y, r.localBox.max.z] }) : null
  const wb = b ? { min: b.min, max: b.max } : ((): { min: Vec3; max: Vec3 } => { const w = worldBounds(r); return { min: [w.min.x, w.min.y, w.min.z], max: [w.max.x, w.max.y, w.max.z] } })()
  return {
    uid: r.uid, id: r.id, render: r.render, ...(r.splat ? { splats: r.splat.count } : {}),
    position: at ? [at.x, at.y, at.z] : [r.group.position.x, r.group.position.y, r.group.position.z], rotation_y_deg: at ? at.rot : r.rotationDeg,
    ...(r.missing ? { missing: true as const } : {}),
    worldBounds: wb,
  }
}
function getState(): PlannerState {
  return {
    scene: getSceneState(),
    items: [...items.values()].map(stateItem),
    layout: layoutName || null,
    dirty: dirty.layout,
    room: room && sceneName ? { name: room.name, title: room.title, photo: sceneName, alignPhotos, floorPlan: floorPlanShown } : null,
  }
}
/** window.midstudy.getRenderSettings() (§2.4). */
export interface RenderSettings {
  toneMapping: 'aces'
  exposure: number
  warmth: number
  contactShadows: boolean
  shadowCount: number
}
function getRenderSettings(): RenderSettings {
  return {
    toneMapping: 'aces', exposure: look.exposure, warmth: look.warmth, contactShadows: look.contact_shadows,
    shadowCount: [...items.values()].filter((r) => r.shadow?.visible).length,
  }
}

/** The open scene as the UI reads it (getScene()): its scene object, calib.json's public part, and the photo size,
 * camera and depth in use. */
interface SceneInfo extends SceneSummary {
  readonly name: string
  readonly w: number
  readonly h: number
  readonly camera: Camera
  readonly camera_source: string
  readonly hasDepth: boolean
  readonly calib: CalibInfo | null
}

// The first page state (§4.5): ?scene=<name>; else the scene last opened on this device, if it still exists; else none
// (the UI shows the Scenes page). → the scene name opened, or null
async function startScene(): Promise<string | null> {
  // §2.2: ?room=<room>[&photo=<scene>] wins over ?scene=; without either, the room last opened on this device (when it
  // was the last thing opened: opening a scene on its own forgets it)
  const want = params.get('room')
  const lastRoom = store.get(LAST_ROOM_KEY)
  if (want || (!params.get('scene') && lastRoom)) {
    const target = want ?? lastRoom ?? ''
    const rooms = await listRoomsInternal().catch(() => null)
    if (rooms?.some((r) => r.name === target)) {
      await openRoom(target, params.get('photo') ?? undefined).catch(() => undefined)
      if (sceneName) return sceneName
    } else if (want) {
      reportError(`There's no room "${want}"`)
      syncUrl(null)
      return null
    } else store.set(LAST_ROOM_KEY, null)
  }
  const list = await listScenesInternal().catch(() => null)
  const names = list ? list.map((s) => s.name) : null
  const go = sceneLogic.landing(params.get('scene'), store.get(LAST_SCENE_KEY), names)
  if (go.kind === 'open') { await openScene(go.name).catch(() => undefined); return sceneName }
  if (go.kind === 'missing') {
    reportError(`There's no scene "${go.name}"`)
    syncUrl(null)
  }
  return null
}
async function init(): Promise<string | null> {
  const [, first] = await Promise.allSettled([loadLibrary(), startScene()])
  return first.status === 'fulfilled' ? first.value : null
}


/** What planner/input.ts installs (installInput). */
export interface InputHandle {
  enabled: { pointer: boolean; keyboard: boolean }
  /** fn(keydown) → truthy swallows the key (a dialog, a menu or a page is open) */
  setKeyFilter(fn: ((e: KeyboardEvent) => unknown) | null): void
  dispose(): void
}
const noInput = (): InputHandle | null => null

/** engine.events: what the UI listens to (only the engine emits). */
const engineEvents: Events<EngineEvents> = events
export const engine = {
  events: engineEvents, errors, canvas,
  /** planner/input.ts's handle, set by main.ts (ui/shell.ts gives it its key filter) */
  input: noInput(),
  // setup
  init, mount, setStageInsets,
  // state
  getScene: (): SceneInfo | null => (sceneName ? { ...(sceneSummary(sceneData) ?? { name: sceneName }), name: sceneName, w: photo.w, h: photo.h, camera: cameraLogic.cameraCopy(cam), camera_source: cameraSource, hasDepth: !!photo.depthTexture, calib: calibInfo(sceneData?.['calib']) } : null),
  getSceneName: (): string | null => sceneName,
  getSceneLoad: (): SceneLoad => ({ ...sceneLoad }),
  getCamera: (): Camera => cameraLogic.cameraCopy(cam),
  getCameraSource: (): string => cameraSource,
  getSavedScene: (): SavedScene | null => clone(savedScene),
  getAdjustFloor: (): boolean => adjustFloor,
  getFloorNote: (): string | null => floorNote,
  getOcclusion: (): boolean => occlusion,
  getGridVisible: (): boolean => grid.visible,
  getView, getPhotoRect, getVisiblePhotoRect: visiblePhotoRect,
  getPhotoSize: (): { w: number; h: number; has: boolean } => ({ w: photo.w, h: photo.h, has: photo.has }),
  isSceneDirty: (): boolean => dirty.scene,
  isLayoutDirty: (): boolean => dirty.layout,
  getItems: (): ItemInfo[] => [...items.values()].map(itemInfo),
  getItem: (uid: string | null): ItemInfo | null => { const r = uid === null ? undefined : items.get(uid); return r ? itemInfo(r) : null },
  getSelected: (): string | null => selected,
  /** every selected piece, in the order picked (the primary last) */
  getSelection: (): string[] => [...sel.uids],
  isSelected: (uid: string): boolean => sel.uids.includes(uid),
  getDrag: (): { mode: DragMode; uid: string } | null => (drag.mode && drag.uid ? { mode: drag.mode, uid: drag.uid } : null),
  getFootprint, hitItemAt, itemAt, getScreenRect, getElevation,
  getLibrary: (): LibraryEntry[] => library.slice(), assetUrl,
  getLayoutDetails: (): LayoutSummary[] => layoutDetails.map((d) => ({ ...d })), getLayoutName: (): string => layoutName,
  layoutDisplayName, getScenesTrash: (): TrashedScene[] => scenesTrash.map((t) => ({ ...t })),
  getRenders: (): RenderMeta[] => renders.slice(), isRenderMock: (): boolean => renderMock,
  getRuler, getState, getRenderSettings, horizonAt,
  // scenes
  listScenesInternal, openScene, closeScene, waitForScene, createScene, deleteScene, restoreScene, renameScene, saveScene, recalibrate,
  // rooms (§4.9)
  getRoomState: (): { name: string; title: string | null; photo: string | null; members: readonly RoomMember[]; info: RoomInfo; alignPhotos: boolean; floorPlan: boolean; unplaced: boolean } | null =>
    (room ? { name: room.name, title: room.title, photo: sceneName, members: room.members.map((m) => ({ ...m })), info: room.info, alignPhotos, floorPlan: floorPlanShown, unplaced: roomUnplaced() } : null),
  getRooms: (): RoomInfo[] => roomsList.slice(), getRoomsTrash: (): TrashedRoom[] => roomsTrash.map((t) => ({ ...t })),
  getRoom, listRoomsInternal, getRoomInternal, createRoom, createRoomFromScenes, alignRoom, alignRoomWhenReady, waitForRoom, openRoom, setRoomPhoto,
  setPose, previewPose, resetPose, setRoomScale, renameRoom, addSceneToRoom, removeSceneFromRoom, deleteRoom, restoreRoom,
  setAlignPhotos, setFloorPlanShown, roomToSceneHook, sceneToRoomHook, addItemHook, moveItemHook, photoToFloorHook, floorToPhotoHook,
  loadDepthMap: (url: string): Promise<DepthMap> => loadDepth(url), depthScaleFor,
  getLayoutItems: (): { uid: string; at: RoomXf; box: { min: Vec3; max: Vec3 } | null }[] => layoutItems(),
  setCamera, resetCamera, setAdjustFloor, setOcclusion, setGridVisible, setPitchFromHorizon,
  // view
  zoomAt, zoomBy, panBy, fitView,
  // items + selection
  addItemInternal, moveItemInternal, removeItemInternal, clearItemsInternal, select, selectMany, selectAll, rotateSelected,
  nudgeSelected, duplicateSelected, setSnap,
  beginItemDrag, beginRotateDrag, dragTo, endItemDrag, removeItemWithUndo, restoreItem, restoreItems,
  setElevation, nudgeElevation, dropToFloor, reloadLibrary: (): Promise<void> => loadLibrary(),
  tap, setRulerActive, setRulerPointAt, setRulerTrueLength,
  // look and lighting (§4.8)
  setLook, setContactShadows, getLighting, setLighting, resetLighting, inferLighting,
  // layouts
  saveLayoutInternal, loadLayoutInternal, deleteLayoutInternal, restoreLayoutInternal, listLayoutsInternal,
  // renders
  captureComposite, postRender, renderViewInternal, listRendersInternal, compare, exportImage,
  // errors + overlays + projection
  reportError, onFrame, worldToScreen, photoToFloor, floorToPhoto, photoToClient,
}
export type Engine = typeof engine
