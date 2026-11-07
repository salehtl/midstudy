// The WebGPU check's demo: a golden scene drawn by the planner's own render code (planner/engine.passes.ts drawFrame,
// planner/lighting.ts, planner/gpu/splat-layer.ts, the kernels' depth decode), without the engine's state and UI, so one
// page can be forced onto either backend and either sort. Driven by planner/gpu/demo/check.mjs through window.gpuDemo.
// URL: ?backend=webgpu|webgl&sort=gpu|cpu&keyBits=16|24|32&sortWorker=throw-load|throw-sort|throw-uncaught
// (sortWorker: a broken CPU sort worker, from a Blob URL: one that throws as it loads, one that answers every sort with
// a fatal error as sort.worker.ts's catch does, one whose sort handler throws uncaught.)
import * as THREE from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { azElOf, decodeDepth, dirOf, loadKernels, splatMultiplier } from '../../../core/js/web.js'
import { V1_KEY_DIR, V1_SOFTNESS, createLighting } from '../../lighting.js'
import { captureTarget, createPasses, drawFrame, makeContactShadow, onDepthLayer, readRgba, setScreen, setSplatSource, sizeTargets, withFullFrame } from '../../engine.passes.js'
import { defaultLook, resolveLook } from '../../logic/look.js'
import type { LookState } from '../../logic/look.js'
import type { JsonObject } from '../../logic/num.js'
import { depthTexture, isWebGPU, photoTexture } from '../passes.js'
import { decodeSplat } from '../splat-data.js'
import type { SplatData } from '../splat-data.js'
import { SplatLayer } from '../splat-layer.js'
import type { SortMode } from '../splat-layer.js'

const DEG = Math.PI / 180
const params = new URLSearchParams(location.search)
const forceWebGL = params.get('backend') === 'webgl'
const sortParam = params.get('sort')
const keyBitsParam = Number(params.get('keyBits') ?? 16)
const sortWorkerParam = params.get('sortWorker')

// A broken sort worker for the failure checks (no bundled file): a module worker from a Blob URL.
function brokenWorkerUrl(kind: string): string | null {
  const body = kind === 'throw-load' ? "throw new Error('the sort worker failed to load (sortWorker=throw-load)')"
    : kind === 'throw-sort' ? "self.addEventListener('message', (e) => { const m = e.data; if (m.type !== 'sort') return; try { throw new Error('the sort failed (sortWorker=throw-sort)') } catch (err) { self.postMessage({ type: 'error', id: m.id, message: String(err), fatal: true }) } })"
      : kind === 'throw-uncaught' ? "self.addEventListener('message', (e) => { if (e.data.type === 'sort') throw new Error('the sort threw (sortWorker=throw-uncaught)') })"
        : null
  return body === null ? null : URL.createObjectURL(new Blob([body], { type: 'text/javascript' }))
}

interface Camera { fov_y_deg: number; height_m: number; pitch_deg: number; roll_deg: number }
interface ItemSpec { uid: string; glb?: string; splat?: string; dims_cm?: { w: number; d: number; h: number }; position: [number, number, number]; rotation_y_deg?: number; settle?: boolean }
interface ItemRec { uid: string; group: THREE.Group; box: THREE.Box3; splat: SplatData | null; shadow: THREE.Mesh }
interface Timing { fetchMs: number; decodeMs: number; firstFrameMs: number; splats: number }

const renderer = new THREE.WebGPURenderer({ forceWebGL, antialias: false, alpha: false, trackTimestamp: true })
renderer.setPixelRatio(1)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.autoClear = false
renderer.outputColorSpace = THREE.LinearSRGBColorSpace // no output conversion: the passes write sRGB bytes themselves
document.body.appendChild(renderer.domElement)
// window.gpuDemo exists at once; its `ready` resolves once the backend and the kernels are up and every call is there.
declare global {
  interface Window {
    gpuDemo?: Record<string, unknown>
  }
}
const api: Record<string, unknown> = {}
window.gpuDemo = api
let started: (v: { backend: string; canvas: number[] }) => void = () => undefined
let failed: (e: unknown) => void = () => undefined
api['ready'] = new Promise((resolve, reject) => { started = resolve; failed = reject })
// an exception anywhere in the module's evaluation rejects ready (failed() on a settled promise does nothing)
window.addEventListener('error', (e) => { failed(e.error) })
window.addEventListener('unhandledrejection', (e) => { failed(e.reason) })
await Promise.all([renderer.init(), loadKernels(new URL('midstudy_wasm_web_bg.wasm', new URL('../bundle/', location.href)))]).catch((e: unknown) => { failed(e); throw e })

const P = createPasses(renderer)
const scene = new THREE.Scene()
const lights = createLighting({ renderer, scene, photo: { node: P.photo.node, frame: P.frame } })
scene.add(P.depth.mesh)
const camera = new THREE.PerspectiveCamera(55, 4 / 3, 0.05, 200)
camera.rotation.order = 'YXZ'
let splats: SplatLayer | null = null
const items = new Map<string, ItemRec>()
const gltf = new GLTFLoader()
const photo = { w: 1600, h: 1200 }
let cam: Camera = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }
let occlusion = true
let hasDepth = false
let hasLighting = false
let look: LookState = defaultLook()
let tick = 0 // the demo draws its splat pass every frame (no redraw cache): its numbers are a whole frame's

// The Look in use (the engine's resolvedLook): Auto lighting, from lighting.json's key or the v1 key.
function applyLook(): void {
  const inf = lights.inferred()
  const dir = inf ? inf.direction : V1_KEY_DIR
  const ae = azElOf(dir)
  lights.setLook(resolveLook(look, { dir, softness: inf ? inf.softness : V1_SOFTNESS, azimuth_deg: ae.azimuth_deg, elevation_deg: ae.elevation_deg }, hasLighting, dirOf))
  const tint = splatMultiplier(look.warmth, 1, [1, 1, 1])
  P.comp.exposure.value = look.exposure
  P.comp.tint.value.set(tint[0], tint[1], tint[2])
  const g = splatMultiplier(look.warmth, look.exposure, lights.splatGain())
  P.splatGain.value.set(g[0], g[1], g[2])
}

function applyCamera(): void {
  camera.fov = cam.fov_y_deg
  camera.position.set(0, cam.height_m, 0)
  camera.rotation.set(cam.pitch_deg * DEG, 0, cam.roll_deg * DEG, 'YXZ')
  camera.updateMatrixWorld(true)
  lights.setCamera(new THREE.Matrix3().setFromMatrix4(camera.matrixWorld), cam.fov_y_deg)
}

// contain-fit the photo in the window (zoom 1), as the engine's view at Fit
function updateView(): void {
  const w = renderer.domElement.width, h = renderer.domElement.height
  const s = Math.min(w / photo.w, h / photo.h)
  const ox = (w - s * photo.w) / 2, oy = (h - s * photo.h) / 2
  camera.aspect = photo.w / photo.h
  camera.setViewOffset(s * photo.w, s * photo.h, -ox, -oy, w, h)
  camera.updateProjectionMatrix()
  setScreen(P, [ox, oy, s * photo.w, s * photo.h])
  sizeTargets(P, w, h)
}

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${String(r.status)}`)
  return new Uint8Array(await r.arrayBuffer())
}
const num = (o: unknown, k: string): number => { const v: unknown = o && typeof o === 'object' ? Reflect.get(o, k) : undefined; if (typeof v !== 'number') throw new Error(`${k} is not a number`); return v }
const isJson = (x: unknown): x is JsonObject => typeof x === 'object' && x !== null && !Array.isArray(x)
async function json(url: string): Promise<JsonObject | null> {
  const r = await fetch(url)
  if (!r.ok) return null
  const v: unknown = await r.json()
  return isJson(v) ? v : null
}

async function openScene(dir: string): Promise<{ w: number; h: number; hasDepth: boolean; lighting: boolean }> {
  const c = (await json(`${dir}/calib.json`))?.['camera']
  cam = { fov_y_deg: num(c, 'fov_y_deg'), height_m: num(c, 'height_m'), pitch_deg: num(c, 'pitch_deg'), roll_deg: num(c, 'roll_deg') }
  const img = new Image()
  img.src = `${dir}/photo.jpg`
  await img.decode()
  photo.w = img.naturalWidth
  photo.h = img.naturalHeight
  P.photo.setPhoto(photoTexture(img))
  const dres = await fetch(`${dir}/depth.png`)
  hasDepth = false
  if (dres.ok) {
    const d = decodeDepth(new Uint8Array(await dres.arrayBuffer()))
    P.depth.pass.setDepth(depthTexture(d.data, d.width, d.height))
    hasDepth = true
  }
  const lj = await json(`${dir}/lighting.json`)
  hasLighting = !!lj
  applyCamera()
  lights.setData(lj)
  look = defaultLook()
  applyLook()
  updateView()
  return { w: photo.w, h: photo.h, hasDepth, lighting: hasLighting }
}

function ensureSplats(): SplatLayer {
  if (splats) return splats
  const sort: SortMode | undefined = sortParam === 'cpu' || sortParam === 'gpu' ? sortParam : undefined
  const keyBits = keyBitsParam === 24 || keyBitsParam === 32 ? keyBitsParam : 16
  const workerUrl = (sortWorkerParam ? brokenWorkerUrl(sortWorkerParam) : null) ?? new URL('../bundle/sort.worker.js', location.href)
  splats = new SplatLayer({ renderer, ...(sort ? { sort } : {}), keyBits, workerUrl })
  setSplatSource(P, splats.target.texture)
  return splats
}

function boxChild(d: { w: number; d: number; h: number }): { obj: THREE.Object3D; box: THREE.Box3 } {
  const w = d.w / 100, dd = d.d / 100, h = d.h / 100
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, dd).translate(0, h / 2, 0), new THREE.MeshBasicMaterial({ color: 0xffffff }))
  return { obj: m, box: new THREE.Box3(new THREE.Vector3(-w / 2, 0, -dd / 2), new THREE.Vector3(w / 2, h, dd / 2)) }
}

// An item as the engine builds one (attachBuilt): its GLB or box, its lights, its depth layer, its splats and their
// shadow-only caster, its contact shadow. settle: false returns at once, without waiting for (or timing) the first
// splat frame.
async function addItem(spec: ItemSpec): Promise<{ uid: string; splats: number | null; timing: Timing | null }> {
  const t0 = performance.now()
  const group = new THREE.Group()
  group.name = spec.uid
  group.position.set(...spec.position)
  group.rotation.y = (spec.rotation_y_deg ?? 0) * DEG
  let child: { obj: THREE.Object3D; box: THREE.Box3 }
  if (spec.glb) {
    const g = await gltf.loadAsync(spec.glb)
    const root = g.scene
    root.updateMatrixWorld(true)
    child = { obj: root, box: new THREE.Box3().setFromObject(root, true) }
  } else if (spec.dims_cm) child = boxChild(spec.dims_cm)
  else throw new Error('an item needs a glb or dims_cm')
  let data: SplatData | null = null
  let timing: Timing | null = null
  if (spec.splat) {
    const bytes = await fetchBytes(spec.splat)
    const t1 = performance.now()
    data = await decodeSplat(bytes)
    timing = { fetchMs: t1 - t0, decodeMs: performance.now() - t1, firstFrameMs: 0, splats: data.count }
    child.obj.visible = false // never drawn: it picks, bounds and casts (§4.5 Splats)
  }
  group.add(child.obj)
  lights.prepare(child.obj)
  if (data) group.add(lights.caster(child.obj))
  onDepthLayer(child.obj)
  const shadow = makeContactShadow(child.box)
  shadow.visible = look.contact_shadows
  group.add(shadow)
  scene.add(group)
  group.updateMatrixWorld(true)
  items.set(spec.uid, { uid: spec.uid, group, box: child.box, splat: data, shadow })
  if (data) ensureSplats().add(spec.uid, data, group)
  if (timing && splats && spec.settle !== false) {
    await splats.settle(camera) // the order for this camera and set (the CPU sort's on the main thread, the GPU's in the draw)
    draw(null)
    await gpuSync()
    timing.firstFrameMs = performance.now() - t0
  }
  return { uid: spec.uid, splats: data?.count ?? null, timing }
}

function removeItem(uid: string): void {
  const r = items.get(uid)
  if (!r) return
  scene.remove(r.group)
  if (r.splat) splats?.remove(uid)
  items.delete(uid)
}

function shadowBox(): THREE.Box3 | null {
  if (!lights.castsShadow()) return null
  const b = new THREE.Box3()
  for (const r of items.values()) b.union(r.box.clone().applyMatrix4(r.group.matrixWorld))
  return b.isEmpty() ? null : b
}

// One frame into target (null: the canvas), as the engine's drawTo.
function draw(target: THREE.RenderTarget | null): void {
  P.depth.mesh.visible = occlusion && hasDepth
  for (const r of items.values()) r.shadow.visible = look.contact_shadows && r.group.position.y <= 0.02
  scene.updateMatrixWorld()
  lights.fitShadow(shadowBox())
  const layer = splats && splats.splats > 0 ? splats : null
  drawFrame(P, target, { scene, camera, furniture: true, splats: layer ? { layer, key: () => String(++tick) } : null })
}

async function gpuSync(): Promise<void> {
  const device: unknown = Reflect.get(renderer.backend, 'device')
  const gl: unknown = Reflect.get(renderer.backend, 'gl')
  if (typeof GPUDevice !== 'undefined' && device instanceof GPUDevice) { await device.queue.onSubmittedWorkDone(); return }
  if (gl instanceof WebGL2RenderingContext) { const px = new Uint8Array(4); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px) }
}

// The full photo frame at its own resolution, splats sorted for the capture camera first (§4.7), as a PNG; settle: false
// draws whatever order the layer has (what the next frame on screen would show).
async function capture(opts: { settle?: boolean } = {}): Promise<{ dataUrl: string; width: number; height: number; ms: number }> {
  const t0 = performance.now()
  const w = photo.w, h = photo.h
  const px = await withFullFrame(P, camera, photo.w / photo.h, w, h, async () => {
    if (splats && splats.splats > 0 && opts.settle !== false) await splats.settle(camera)
    const out = captureTarget(P, w, h)
    draw(out)
    return readRgba(renderer, out, w, h)
  }, updateView)
  const c = document.createElement('canvas')
  c.width = w; c.height = h
  const g = c.getContext('2d')
  if (!g) throw new Error('no 2d context')
  g.putImageData(new ImageData(new Uint8ClampedArray(px.buffer), w, h), 0, 0)
  return { dataUrl: c.toDataURL('image/png'), width: w, height: h, ms: performance.now() - t0 }
}

// GPU timestamps (WebGPU, timestamp-query): what the last frame's compute and render passes took on the device.
async function gpuTimes(): Promise<{ compute: number | null; render: number | null }> {
  if (!isWebGPU(renderer)) return { compute: null, render: null }
  const t = async (type: typeof THREE.TimestampQuery.COMPUTE | typeof THREE.TimestampQuery.RENDER): Promise<number | null> => {
    try { const v: unknown = await renderer.resolveTimestampsAsync(type); return typeof v === 'number' ? v : null } catch { return null }
  }
  return { compute: await t(THREE.TimestampQuery.COMPUTE), render: await t(THREE.TimestampQuery.RENDER) }
}
const median = (v: number[]): number => [...v].sort((a, b) => a - b)[Math.floor(v.length / 2)] ?? 0

// n frames to the canvas; moveSplats nudges every splat item by ±1 mm so each frame re-sorts and redraws.
async function timeFrames(n: number, opts: { moveSplats?: boolean } = {}): Promise<{ frames: number[]; sorts: number[]; median: number; gpuCompute: number[]; gpuRender: number[] }> {
  const frames: number[] = [], sorts: number[] = [], gpuCompute: number[] = [], gpuRender: number[] = []
  await gpuTimes() // drop what earlier frames left
  for (let i = 0; i < n; i++) {
    if (opts.moveSplats) for (const r of items.values()) if (r.splat) { r.group.position.x += i % 2 ? -0.001 : 0.001; r.group.updateMatrixWorld(true) }
    const t0 = performance.now()
    draw(null)
    await gpuSync()
    frames.push(performance.now() - t0)
    const g = await gpuTimes()
    if (g.compute != null) gpuCompute.push(g.compute)
    if (g.render != null) gpuRender.push(g.render)
    const s = splats?.stats()
    if (s?.lastSortMs != null) sorts.push(s.lastSortMs)
  }
  return { frames, sorts, median: median(frames), gpuCompute, gpuRender }
}

// GPU sort only: the radix sort against a stable CPU sort of the same keys.
async function debugSort(): Promise<{ ok: boolean; count: number; mismatches: number; firstBad: number; keyRange: [number, number] } | null> {
  if (!splats) return null
  splats.update(camera)
  const r = await splats.debugReadSort()
  if (!r) return null
  const idx = Array.from({ length: r.count }, (_, i) => i).sort((a, b) => (r.keys[a] ?? 0) - (r.keys[b] ?? 0) || a - b)
  let mismatches = 0, firstBad = -1, lo = Infinity, hi = -Infinity
  for (let i = 0; i < r.count; i++) {
    if (idx[i] !== r.order[i]) { mismatches++; if (firstBad < 0) firstBad = i }
    const k = r.keys[i] ?? 0
    if (k < lo) lo = k
    if (k > hi) hi = k
  }
  return { ok: mismatches === 0, count: r.count, mismatches, firstBad, keyRange: [lo, hi] }
}

function heapUsed(): number | null {
  const m: unknown = Reflect.get(performance, 'memory')
  const v: unknown = m && typeof m === 'object' ? Reflect.get(m, 'usedJSHeapSize') : null
  return typeof v === 'number' ? v : null
}

Object.assign(api, {
  openScene,
  addItem,
  removeItem,
  clearItems: () => { for (const uid of [...items.keys()]) removeItem(uid) },
  setOcclusion: (on: boolean) => { occlusion = on },
  setContactShadows: (on: boolean) => { look = { ...look, contact_shadows: on }; applyLook() },
  setCastShadows: (on: boolean) => { look = { ...look, cast_shadows: on }; applyLook() },
  capture,
  draw: async () => { draw(null); await gpuSync() },
  timeFrames,
  // the splat pass alone (sorted already, no depth), n times, synced: comparable with Spark's own draw
  timeSplatDraw: async (n: number) => {
    if (!splats) return null
    const layer = splats
    const w = renderer.domElement.width, h = renderer.domElement.height
    await layer.settle(camera)
    const t: number[] = [], g: number[] = []
    await gpuTimes()
    for (let i = 0; i < n; i++) {
      const t0 = performance.now()
      layer.render(camera, w, h, () => undefined)
      await gpuSync()
      t.push(performance.now() - t0)
      const gt = await gpuTimes()
      if (gt.render != null) g.push(gt.render)
    }
    return { median: median(t), all: t, gpuRender: g }
  },
  debugSort,
  // how long settle() takes for the current camera, or its error
  settleMs: async () => {
    const t0 = performance.now()
    try { await splats?.settle(camera); return { ms: performance.now() - t0, error: null } } catch (e) { return { ms: performance.now() - t0, error: String(e) } }
  },
  // every splat item nudged by 1 mm and one frame drawn: a change the CPU sort hands to its worker
  nudgeSplats: async () => {
    for (const r of items.values()) if (r.splat) { r.group.position.x += 0.001; r.group.updateMatrixWorld(true) }
    draw(null)
    await gpuSync()
  },
  stats: () => ({ splats: splats?.stats() ?? null, info: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, compute: renderer.info.compute.calls }, heap: heapUsed() }),
})
started({ backend: isWebGPU(renderer) ? 'webgpu' : 'webgl2', canvas: [renderer.domElement.width, renderer.domElement.height] })
