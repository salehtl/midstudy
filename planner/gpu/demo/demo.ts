// The WebGPU spike's demo: a golden scene drawn the way engine.js draws it, on three.js's WebGPURenderer (WebGPU, or
// its WebGL2 fallback with ?backend=webgl), with SplatLayer for splat items. Driven by planner/gpu/demo/check.mjs
// through window.gpuDemo. URL: ?backend=webgpu|webgl&sort=gpu|cpu&keyBits=16|24|32
import {
  Box3, CanvasTexture, Group, HalfFloatType, LinearSRGBColorSpace, Matrix3, Mesh, MeshBasicMaterial, PerspectiveCamera, PlaneGeometry, QuadMesh, RenderTarget,
  SRGBColorSpace, Scene, Texture, UnsignedByteType, Vector3, WebGPURenderer, BoxGeometry, MeshBasicNodeMaterial,
} from 'three/webgpu'
import type { Object3D } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { texture } from 'three/tsl'
import { decodeSplat } from '../splat-data.ts'
import type { SplatData } from '../splat-data.ts'
import { SplatLayer, isWebGPU } from '../splat-layer.ts'
import type { SortMode } from '../splat-layer.ts'
import { BAR, createDepthPrepass, createFrame, createFurnitureComposite, createPhotoPass, createSplatComposite, depthTexture, photoTexture, warmthTint } from '../passes.ts'
import { CASTER_LAYER, createLightRig } from '../light-rig.ts'
import type { LightingJson } from '../light-rig.ts'
import { decodeDepthPng } from './depth-png.ts'

const DEG = Math.PI / 180
const DEPTH_LAYER = 2 // meshes whose depth hides splats (the splat pass draws them depth-only)
const params = new URLSearchParams(location.search)
const forceWebGL = params.get('backend') === 'webgl'
const sortParam = params.get('sort')
const keyBitsParam = Number(params.get('keyBits') || 16)

interface Camera { fov_y_deg: number, height_m: number, pitch_deg: number, roll_deg: number }
interface ItemSpec { uid: string, glb?: string, splat?: string, dims_cm?: { w: number, d: number, h: number }, position: [number, number, number], rotation_y_deg?: number }
interface ItemRec { uid: string, group: Group, child: Object3D, box: Box3, splat: SplatData | null, caster: Object3D | null, shadow: Mesh }
interface Timing { fetchMs: number, decodeMs: number, firstFrameMs: number, splats: number }

const renderer = new WebGPURenderer({ forceWebGL, antialias: false, alpha: false, trackTimestamp: true })
renderer.setPixelRatio(1)
renderer.setSize(window.innerWidth, window.innerHeight)
renderer.autoClear = false
renderer.outputColorSpace = LinearSRGBColorSpace // no output conversion: the canvas gets the passes' bytes as they are
document.body.appendChild(renderer.domElement)

const frame = createFrame()
const photoPass = createPhotoPass(frame)
const depthPre = createDepthPrepass(frame)
const furnRT = new RenderTarget(1, 1, { type: HalfFloatType, samples: 4, depthBuffer: true })
const furnComp = createFurnitureComposite(frame, furnRT)
const furnScene = new Scene()
const depthScene = new Scene()
const photoQuad = new QuadMesh(photoPass.material)
const furnQuad = new QuadMesh(furnComp.material)
const prepassMesh = new Mesh(new PlaneGeometry(2, 2), depthPre.material)
prepassMesh.frustumCulled = false
prepassMesh.renderOrder = -1000
prepassMesh.visible = false
const prepassMesh2 = new Mesh(prepassMesh.geometry, depthPre.material)
prepassMesh2.frustumCulled = false
prepassMesh2.visible = false
furnScene.add(prepassMesh)
depthScene.add(prepassMesh2)
const depthOnly = new MeshBasicNodeMaterial()
depthOnly.colorWrite = false

const camera = new PerspectiveCamera(55, 4 / 3, 0.05, 200)
camera.rotation.order = 'YXZ'
const photoNode = { node: texture(new Texture()) } // the photo, for the catcher and the reflections
const rig = createLightRig({ renderer, scene: furnScene, frame, photo: photoNode })
let splats: SplatLayer | null = null
let splatQuad: QuadMesh | null = null
const items = new Map<string, ItemRec>()
const gltf = new GLTFLoader()
const photo = { w: 1600, h: 1200, texture: null as Texture | null }
let cam: Camera = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }
let occlusion = true
let contactShadows = true
let hasDepth = false

function applyCamera(): void {
  camera.fov = cam.fov_y_deg
  camera.position.set(0, cam.height_m, 0)
  camera.rotation.set(cam.pitch_deg * DEG, 0, cam.roll_deg * DEG, 'YXZ')
  camera.updateMatrixWorld(true)
}

// contain-fit the photo in the window (zoom 1), as engine.js updateView
function updateView(w = renderer.domElement.width, h = renderer.domElement.height): void {
  const s = Math.min(w / photo.w, h / photo.h)
  const ox = (w - s * photo.w) / 2, oy = (h - s * photo.h) / 2
  camera.aspect = photo.w / photo.h
  camera.setViewOffset(s * photo.w, s * photo.h, -ox, -oy, w, h)
  camera.updateProjectionMatrix()
  frame.rect.value.set(ox, oy, s * photo.w, s * photo.h)
  frame.target.value.set(w, h)
}

function fullFrame(w: number, h: number): void {
  camera.clearViewOffset()
  camera.aspect = photo.w / photo.h
  camera.updateProjectionMatrix()
  frame.rect.value.set(0, 0, w, h)
  frame.target.value.set(w, h)
}

const shadowTex = (() => {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const g = c.getContext('2d')
  if (g) {
    const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
    grd.addColorStop(0, 'rgba(0,0,0,0.95)'); grd.addColorStop(0.45, 'rgba(0,0,0,0.85)'); grd.addColorStop(0.65, 'rgba(0,0,0,0.55)')
    grd.addColorStop(0.82, 'rgba(0,0,0,0.2)'); grd.addColorStop(1, 'rgba(0,0,0,0)')
    g.fillStyle = grd
    g.fillRect(0, 0, 128, 128)
  }
  const t = new CanvasTexture(c)
  t.colorSpace = SRGBColorSpace
  return t
})()
const shadowGeo = new PlaneGeometry(1, 1).rotateX(-Math.PI / 2)
const shadowMat = new MeshBasicMaterial({ color: 0x000000, map: shadowTex, transparent: true, depthWrite: false, opacity: 0.75 })

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return new Uint8Array(await r.arrayBuffer())
}

async function openScene(dir: string): Promise<{ w: number, h: number, hasDepth: boolean, lighting: boolean }> {
  const calib = await (await fetch(`${dir}/calib.json`)).json() as { camera: Camera, floor?: { found?: boolean } }
  cam = calib.camera
  const img = new Image()
  img.src = `${dir}/photo.jpg`
  await img.decode()
  photo.w = img.naturalWidth
  photo.h = img.naturalHeight
  photo.texture = photoTexture(img)
  photoPass.setPhoto(photo.texture)
  photoNode.node.value = photo.texture
  const dres = await fetch(`${dir}/depth.png`)
  hasDepth = false
  if (dres.ok) {
    const d = await decodeDepthPng(new Uint8Array(await dres.arrayBuffer()))
    depthPre.setDepth(depthTexture(d.data, d.w, d.h))
    hasDepth = true
  }
  const lres = await fetch(`${dir}/lighting.json`)
  const lj = lres.ok ? await lres.json() as LightingJson : null
  applyCamera()
  rig.setData(lj, new Matrix3().setFromMatrix4(camera.matrixWorld), cam.fov_y_deg)
  rig.setPhoto(photo.texture, photo.w / photo.h)
  syncLook()
  updateView()
  return { w: photo.w, h: photo.h, hasDepth, lighting: !!lj }
}

function syncLook(): void {
  const g = rig.splatGain()
  const t = warmthTint(0)
  splats?.setColorMultiplier(t.x * g[0], t.y * g[1], t.z * g[2])
  furnComp.exposure.value = 1
  furnComp.tint.value.copy(t)
}

function ensureSplats(): SplatLayer {
  if (splats) return splats
  const sort: SortMode | undefined = sortParam === 'cpu' || sortParam === 'gpu' ? sortParam : undefined
  const keyBits = keyBitsParam === 24 || keyBitsParam === 32 ? keyBitsParam : 16
  splats = new SplatLayer({ renderer, ...(sort ? { sort } : {}), keyBits, workerUrl: new URL('../bundle/sort-worker.js', location.href), debug: params.get('splatDebug') ?? '' })
  splatQuad = new QuadMesh(createSplatComposite(frame, splats.target, splats.gain))
  syncLook()
  return splats
}

function boxChild(d: { w: number, d: number, h: number }): { obj: Object3D, box: Box3 } {
  const w = d.w / 100, dd = d.d / 100, h = d.h / 100
  const m = new Mesh(new BoxGeometry(w, h, dd).translate(0, h / 2, 0), new MeshBasicMaterial({ color: 0xffffff }))
  return { obj: m, box: new Box3(new Vector3(-w / 2, 0, -dd / 2), new Vector3(w / 2, h, dd / 2)) }
}

function prepareMeshes(root: Object3D, drawn: boolean): void {
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const lit = !(o.material instanceof MeshBasicMaterial)
    o.castShadow = true
    o.receiveShadow = lit
    if (drawn) { o.layers.enable(DEPTH_LAYER); o.layers.enable(CASTER_LAYER) }
  })
}

async function addItem(spec: ItemSpec): Promise<{ uid: string, splats: number | null, timing: Timing | null }> {
  const t0 = performance.now()
  const group = new Group()
  group.name = spec.uid
  group.position.set(...spec.position)
  group.rotation.y = (spec.rotation_y_deg ?? 0) * DEG
  let child: { obj: Object3D, box: Box3 }
  if (spec.glb) {
    const g = await gltf.loadAsync(spec.glb)
    const root = g.scene
    root.updateMatrixWorld(true)
    child = { obj: root, box: new Box3().setFromObject(root, true) }
  } else if (spec.dims_cm) child = boxChild(spec.dims_cm)
  else throw new Error('an item needs a glb or dims_cm')
  let data: SplatData | null = null
  let timing: Timing | null = null
  let caster: Object3D | null = null
  if (spec.splat) {
    const bytes = await fetchBytes(spec.splat)
    const t1 = performance.now()
    data = await decodeSplat(bytes)
    const t2 = performance.now()
    timing = { fetchMs: t1 - t0, decodeMs: t2 - t1, firstFrameMs: 0, splats: data.count }
    child.obj.visible = false // never drawn: it picks, bounds and casts (§4.5 Splats)
    caster = child.obj.clone(true)
    caster.visible = true
    caster.traverse((o) => { o.visible = true; o.layers.set(CASTER_LAYER) })
  }
  prepareMeshes(child.obj, !data)
  group.add(child.obj)
  if (caster) group.add(caster)
  const size = child.box.getSize(new Vector3()), c = child.box.getCenter(new Vector3())
  const shadow = new Mesh(shadowGeo, shadowMat)
  shadow.name = 'contact-shadow'
  shadow.position.set(c.x, 0.004, c.z)
  shadow.scale.set(size.x * 1.45 + 0.06, 1, size.z * 1.45 + 0.06)
  shadow.renderOrder = 2
  shadow.visible = contactShadows
  group.add(shadow)
  furnScene.add(group)
  group.updateMatrixWorld(true)
  items.set(spec.uid, { uid: spec.uid, group, child: child.obj, box: child.box, splat: data, caster, shadow })
  if (data) ensureSplats().add(spec.uid, data, group)
  if (timing) {
    await draw(null)
    await gpuSync()
    timing.firstFrameMs = performance.now() - t0
  }
  return { uid: spec.uid, splats: data?.count ?? null, timing }
}

function removeItem(uid: string): void {
  const r = items.get(uid)
  if (!r) return
  furnScene.remove(r.group)
  if (r.splat) splats?.remove(uid)
  items.delete(uid)
}

function shadowBox(): Box3 | null {
  const b = new Box3()
  for (const r of items.values()) b.union(r.box.clone().applyMatrix4(r.group.matrixWorld))
  return b.isEmpty() ? null : b
}

function drawDepth(): void {
  if (prepassMesh2.visible) renderer.render(depthScene, camera)
  const prev = furnScene.overrideMaterial
  furnScene.overrideMaterial = depthOnly
  camera.layers.set(DEPTH_LAYER)
  try { renderer.render(furnScene, camera) } finally { camera.layers.set(0); furnScene.overrideMaterial = prev }
}

// One frame into target (null: the canvas) at w × h: the furniture pass, the splat pass, then the screen.
async function draw(target: RenderTarget | null, w = renderer.domElement.width, h = renderer.domElement.height): Promise<void> {
  prepassMesh.visible = prepassMesh2.visible = occlusion && hasDepth
  for (const r of items.values()) r.shadow.visible = contactShadows && r.group.position.y <= 0.02
  furnScene.updateMatrixWorld()
  rig.fitShadow(shadowBox(), furnScene)
  if (furnRT.width !== w || furnRT.height !== h) furnRT.setSize(w, h)
  renderer.setRenderTarget(furnRT)
  renderer.setClearColor(0x000000, 0)
  renderer.clear(true, true, true)
  renderer.render(furnScene, camera)
  const withSplats = !!splats && splats.splats > 0
  if (withSplats && splats) splats.render(camera, w, h, drawDepth)
  renderer.setRenderTarget(target)
  renderer.setClearColor(BAR, 1)
  renderer.clear(true, true, true)
  photoQuad.render(renderer)
  furnQuad.render(renderer)
  if (withSplats && splatQuad) splatQuad.render(renderer)
  await Promise.resolve()
}

async function gpuSync(): Promise<void> {
  const b = renderer.backend as { device?: GPUDevice, gl?: WebGL2RenderingContext }
  if (b.device) { await b.device.queue.onSubmittedWorkDone(); return }
  if (b.gl) { const px = new Uint8Array(4); b.gl.readPixels(0, 0, 1, 1, b.gl.RGBA, b.gl.UNSIGNED_BYTE, px) }
}

// The full photo frame at its own resolution, splats sorted for the capture camera first (§4.7): PNG.
async function capture(): Promise<{ dataUrl: string, width: number, height: number, ms: number, flipped: boolean }> {
  const t0 = performance.now()
  const w = photo.w, h = photo.h
  const out = new RenderTarget(w, h, { type: UnsignedByteType, depthBuffer: false })
  try {
    fullFrame(w, h)
    if (splats && splats.splats > 0) await splats.settle(camera)
    await draw(out, w, h)
    await draw(out, w, h) // the catcher's material and the shadow map exist from the first
    const px = await renderer.readRenderTargetPixelsAsync(out, 0, 0, w, h)
    const c = document.createElement('canvas')
    c.width = w; c.height = h
    const g = c.getContext('2d')
    if (!g) throw new Error('no 2d context')
    const img = g.createImageData(w, h)
    const src = px instanceof Uint8Array ? px : new Uint8Array(px.buffer, px.byteOffset, px.byteLength)
    // WebGL reads rows bottom-up, WebGPU top-down: the photo's top-left corner tells which
    const flipped = !isWebGPU(renderer)
    for (let y = 0; y < h; y++) {
      const row = flipped ? h - 1 - y : y
      img.data.set(src.subarray(row * w * 4, (row + 1) * w * 4), y * w * 4)
    }
    g.putImageData(img, 0, 0)
    return { dataUrl: c.toDataURL('image/png'), width: w, height: h, ms: performance.now() - t0, flipped }
  } finally {
    out.dispose()
    updateView()
  }
}

// n frames to the canvas; moveSplats nudges every splat item by ±1 mm so each frame re-sorts and redraws.
async function timeFrames(n: number, opts: { moveSplats?: boolean } = {}): Promise<{ frames: number[], sorts: number[], median: number }> {
  const frames: number[] = [], sorts: number[] = []
  for (let i = 0; i < n; i++) {
    if (opts.moveSplats) for (const r of items.values()) if (r.splat) { r.group.position.x += i % 2 ? -0.001 : 0.001; r.group.updateMatrixWorld(true) }
    const t0 = performance.now()
    await draw(null)
    await gpuSync()
    frames.push(performance.now() - t0)
    const s = splats?.stats()
    if (s?.lastSortMs != null) sorts.push(s.lastSortMs)
  }
  const sorted = [...frames].sort((a, b) => a - b)
  return { frames, sorts, median: sorted[Math.floor(sorted.length / 2)] ?? 0 }
}

// GPU sort only: the radix sort against a stable CPU sort of the same keys.
async function debugSort(): Promise<{ ok: boolean, count: number, mismatches: number, firstBad: number, keyRange: [number, number] } | null> {
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

let running = false
function loop(): void {
  if (!running) return
  void draw(null).then(() => requestAnimationFrame(loop))
}

declare global {
  interface Window {
    gpuDemo?: unknown
    gpuDemoError?: string
  }
}

const ready = (async () => {
  await renderer.init()
  return { backend: isWebGPU(renderer) ? 'webgpu' : 'webgl2', canvas: [renderer.domElement.width, renderer.domElement.height] }
})()

window.gpuDemo = {
  ready,
  openScene,
  addItem,
  removeItem,
  clearItems: () => { for (const uid of [...items.keys()]) removeItem(uid) },
  setOcclusion: (on: boolean) => { occlusion = on },
  setContactShadows: (on: boolean) => { contactShadows = on },
  setCastShadows: (on: boolean) => { rig.catcherMaterial.visible = on; rig.key.castShadow = on },
  capture,
  draw: async () => { await draw(null); await gpuSync() },
  timeFrames,
  debugSort,
  // debug: how much the splat pass drew (alpha > 0 pixels in its target) at the canvas size
  debugSplatTarget: async () => {
    if (!splats) return null
    await draw(null)
    const t = splats.target
    const px = await renderer.readRenderTargetPixelsAsync(t, 0, 0, t.width, t.height)
    const n = t.width * t.height
    let drawn = 0, maxA = 0
    const samples: number[][] = []
    const half = (h: number): number => { const e = (h >> 10) & 31, m = h & 1023, sg = h >> 15 ? -1 : 1; return e === 0 ? sg * m * 2 ** -24 : e === 31 ? (m ? NaN : sg * Infinity) : sg * (1 + m / 1024) * 2 ** (e - 15) }
    for (let i = 0; i < n; i++) {
      const a = Number(px[4 * i + 3] ?? 0)
      if (a > 0) { drawn++; if (samples.length < 6 && i % 7 === 0) samples.push([0, 1, 2, 3].map((k) => half(Number(px[4 * i + k] ?? 0)))) }
      if (a > maxA) maxA = a
    }
    return { w: t.width, h: t.height, drawn, maxA, samples, type: px.constructor.name, instances: splats.stats() }
  },
  debugShaders: () => splats?.debugShaders(camera) ?? null,
  start: () => { running = true; loop() },
  stop: () => { running = false },
  stats: () => ({ splats: splats?.stats() ?? null, info: { calls: renderer.info.render.calls, triangles: renderer.info.render.triangles, compute: renderer.info.compute.calls }, heap: heapUsed() }),
}
ready.catch((e: unknown) => { window.gpuDemoError = e instanceof Error ? e.message : String(e) })
