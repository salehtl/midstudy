// SplatLayer: Gaussian splat furniture for three.js's WebGPURenderer (WebGPU, and its WebGL2 fallback), without
// Spark. Contract §4.5 Splats, §4.8 (the colour multiplier), §1 (splat.spz). Interface (docs/notes/webgpu-spike.md):
//
//   const layer = new SplatLayer({ renderer, workerUrl })      sort 'gpu' on WebGPU (compute radix sort), else 'cpu'
//   layer.add(uid, splatData, itemGroup)                        the group's matrixWorld places the splats (item frame)
//   layer.remove(uid) · layer.has(uid) · layer.count            · layer.items()
//   layer.setColorMultiplier(r, g, b)                           exposure × warmth × white balance × level (§4.8)
//   layer.render(camera, drawDepth)                             sorts if needed, draws into layer.target: colour
//                                                               cleared, depth from drawDepth() (the photo's depth
//                                                               and the meshes, depth only), splats tested, no writes
//   layer.compositeNode(frame)                                  the screen pass: un-premultiply, × multiplier, sRGB
//   await layer.settle(camera)                                  the order is for this camera and set (captures)
//   layer.stats() · layer.dispose()
//
// Drawing follows Spark 2.4 (what v1 draws with), so the two look alike: each splat is an instanced quad around its
// center, its 3D covariance (Σ = R S² Rᵀ, item frame) turned into view space with the item's and the camera's
// rotation and projected with the perspective Jacobian (EWA), a 0.3 px² blur with Spark's opacity compensation, the
// quad spanning √8 standard deviations along the 2D covariance's eigenvectors (at most 512 px), fragments
// a·exp(−r²/2) with alpha below 0.5/255 discarded, colours taken from sRGB to linear and written premultiplied into a
// half-float target with (1, 1 − src α) blending, back to front. Depth: the center's, tested, never written.
//
// Order: one back-to-front order over every placed splat (all items together), by depth along the view axis.
// WebGPU: a key kernel (16-bit depth keys over the frame's depth range) and GpuRadixSort, in one compute submission
// before the draw, re-run only when the camera, a transform or the set changed. WebGL2 (no compute): the same keys
// and a counting sort in a worker (sort-worker.ts); the previous order draws until the new one lands.
import {
  DataTexture, FloatType, HalfFloatType, InstancedBufferAttribute, InstancedBufferGeometry, Float32BufferAttribute, Matrix4, Mesh,
  NearestFilter, NodeMaterial, RGBAFormat, RenderTarget, Scene, Vector2, Vector3, CustomBlending, DoubleSide, OneFactor, OneMinusSrcAlphaFactor,
} from 'three/webgpu'
import type { ComputeNode, Object3D, PerspectiveCamera, StorageInstancedBufferAttribute, UniformNode, WebGPURenderer } from 'three/webgpu'
import {
  Discard, Fn, If, cameraProjectionMatrix, cameraViewMatrix, dot, exp, float, floatBitsToUint, floor, instanceIndex, instancedBufferAttribute,
  int, ivec2, max, min, mix, positionGeometry, pow, select, sqrt, storage, textureLoad, uint, uniform, varyingProperty, vec2, vec3, vec4,
} from 'three/tsl'
import type { ShaderNodeObject } from 'three/tsl'
import { BLOCK, GpuRadixSort, padToBlock } from './radix-sort.ts'
import type { SplatData } from './splat-data.ts'
import type { FromWorker, ToWorker } from './sort-messages.ts'

export const TEX_W = 2048          // data texture width (texels); rows grow with the capacity
export const MAX_ITEMS = 256       // item slots (transform texture rows)
export const MAX_STD_DEV = Math.sqrt(8)
export const MIN_ALPHA = 0.5 / 255
export const BLUR = 0.3            // px², with opacity compensation (Spark's blurAmount)
const MAX_PIXEL_RADIUS = 512
const CLIP_XY = 1.4

export type SortMode = 'gpu' | 'cpu'

export interface SplatLayerOptions {
  renderer: WebGPURenderer
  /** 'gpu' needs the WebGPU backend; default: 'gpu' on WebGPU, 'cpu' on WebGL2 */
  sort?: SortMode
  /** the GPU sort's key width: 16 (two radix passes, the default), 24 or 32 (float bits, exact) */
  keyBits?: 16 | 24 | 32
  /** the bundled sort-worker.js (the CPU sort) */
  workerUrl?: string | URL
  /** debug draws: 'center' (fixed 4 px quads at the centers), 'grid' (one quad per instance on a grid) */
  debug?: string
}

export interface SplatStats {
  sortMode: SortMode, backend: 'webgpu' | 'webgl2', splats: number, items: number, capacity: number, sorts: number,
  lastSortMs: number | null, lastWorkerMs: number | null, gpuBytes: number, keyBits: number
}

interface Item { uid: string, data: SplatData, object: Object3D, slot: number, start: number }

// The 2D-covariance math and its inputs, one vertex per quad corner.
function makeMaterial(tex: { center: DataTexture, cov: DataTexture, cov2: DataTexture, items: DataTexture }, order: InstancedBufferAttribute | StorageInstancedBufferAttribute,
  u: { renderSize: ShaderNodeObject<UniformNode<Vector2>>, focal: ShaderNodeObject<UniformNode<Vector2>>, near: ShaderNodeObject<UniformNode<number>>, far: ShaderNodeObject<UniformNode<number>> }, debug = ''): NodeMaterial {
  const vUv = varyingProperty('vec2', 'vSplatUv')
  const vRgba = varyingProperty('vec4', 'vSplatRgba')
  const vertex = Fn(() => {
    const out = vec4(0, 0, 2, 1).toVar() // outside the clip volume: culled
    vUv.assign(vec2(0, 0))
    vRgba.assign(vec4(0, 0, 0, 0))
    const j = instancedBufferAttribute(order, 'uint')
    const at = ivec2(int(j.mod(uint(TEX_W))), int(j.div(uint(TEX_W))))
    const c = textureLoad(tex.center, at)
    const ca = textureLoad(tex.cov, at)
    const cb = textureLoad(tex.cov2, at)
    const slot = int(c.w)
    const m0 = textureLoad(tex.items, ivec2(int(0), slot)).xyz
    const m1 = textureLoad(tex.items, ivec2(int(1), slot)).xyz
    const m2 = textureLoad(tex.items, ivec2(int(2), slot)).xyz
    const m3 = textureLoad(tex.items, ivec2(int(3), slot)).xyz
    const world = m0.mul(c.x).add(m1.mul(c.y)).add(m2.mul(c.z)).add(m3)
    const view = cameraViewMatrix.mul(vec4(world, 1)).toVar()
    const clip = cameraProjectionMatrix.mul(view).toVar()
    const ok = view.z.lessThan(u.near.negate()).and(view.z.greaterThan(u.far.negate()))
      .and(clip.x.abs().lessThanEqual(clip.w.mul(CLIP_XY))).and(clip.y.abs().lessThanEqual(clip.w.mul(CLIP_XY)))
    if (debug === 'center') {
      If(ok, () => {
        out.assign(vec4(clip.xy.div(clip.w).add(positionGeometry.xy.mul(4).div(u.renderSize)).mul(clip.w), clip.z, clip.w))
        vUv.assign(vec2(0, 0))
        vRgba.assign(vec4(1, 0, 1, 1))
      })
      return out
    }
    if (debug === 'grid') {
      const g = float(instanceIndex.mod(uint(200))).div(100).sub(1)
      out.assign(vec4(positionGeometry.xy.mul(0.004).add(vec2(g, float(j.mod(uint(97))).div(48).sub(1))), 0.5, 1))
      vRgba.assign(vec4(1, 1, 0, 1))
      return out
    }
    If(ok, () => {
      // the item's and the camera's rotation, column by column: T = R_view · R_item
      const t0 = cameraViewMatrix.mul(vec4(m0, 0)).xyz
      const t1 = cameraViewMatrix.mul(vec4(m1, 0)).xyz
      const t2 = cameraViewMatrix.mul(vec4(m2, 0)).xyz
      const invZ = float(1).div(view.z)
      const J1 = u.focal.mul(invZ)
      const J2 = J1.mul(view.xy).mul(invZ).negate()
      const j0 = vec3(J1.x, 0, J2.x), j1 = vec3(0, J1.y, J2.y)
      // rows of the Jacobian taken back to the item frame (Tᵀ j), so cov2D = (Tᵀj)ᵀ Σ (Tᵀj)
      const a0 = vec3(dot(t0, j0), dot(t1, j0), dot(t2, j0)).toVar()
      const a1 = vec3(dot(t0, j1), dot(t1, j1), dot(t2, j1)).toVar()
      const r0 = vec3(ca.x, ca.y, ca.z), r1 = vec3(ca.y, ca.w, cb.x), r2 = vec3(ca.z, cb.x, cb.y)
      const s0 = vec3(dot(r0, a0), dot(r1, a0), dot(r2, a0))
      const s1 = vec3(dot(r0, a1), dot(r1, a1), dot(r2, a1))
      const a = dot(a0, s0).toVar(), b = dot(a1, s0).toVar(), d = dot(a1, s1).toVar()
      const detOrig = a.mul(d).sub(b.mul(b)).toVar()
      a.addAssign(BLUR)
      d.addAssign(BLUR)
      const det = a.mul(d).sub(b.mul(b))
      if (debug === 'cov' || debug === 'tex') {
        out.assign(vec4(clip.xy.div(clip.w).add(positionGeometry.xy.mul(4).div(u.renderSize)).mul(clip.w), clip.z, clip.w))
        vUv.assign(vec2(0, 0))
        vRgba.assign(debug === 'cov' ? vec4(a, b, d, 1) : vec4(cb.z.div(256), cb.w, detOrig.div(det), 1))
        return
      }
      // colour: rgb packed as r + 256 g + 65536 b (exact in a float), alpha 0–255
      const packed = cb.z
      const cB = floor(packed.div(65536))
      const cG = floor(packed.sub(cB.mul(65536)).div(256))
      const cR = packed.sub(cB.mul(65536)).sub(cG.mul(256))
      const srgb = vec3(cR, cG, cB).div(255)
      const linear = mix(srgb.div(12.92), pow(srgb.add(0.055).div(1.055), vec3(2.4)), srgb.greaterThan(vec3(0.04045)))
      const alpha = cb.w.div(255).mul(sqrt(max(float(0), detOrig.div(det))))
      const eAvg = a.add(d).mul(0.5)
      const eHalf = a.sub(d).mul(0.5)
      const eDelta = sqrt(eHalf.mul(eHalf).add(b.mul(b)))
      const e1 = eAvg.add(eDelta)
      const e2 = max(float(0), det.div(e1))
      const v1u = select(eHalf.greaterThanEqual(0), vec2(eDelta.add(eHalf), b), vec2(b, eDelta.sub(eHalf)))
      const len2 = dot(v1u, v1u)
      const v1 = select(len2.greaterThan(0), v1u.div(sqrt(len2)), vec2(1, 0))
      const v2 = vec2(v1.y, v1.x.negate())
      const sc1 = min(float(MAX_PIXEL_RADIUS), sqrt(e1).mul(MAX_STD_DEV))
      const sc2 = min(float(MAX_PIXEL_RADIUS), sqrt(e2).mul(MAX_STD_DEV))
      If(alpha.greaterThanEqual(MIN_ALPHA), () => {
        const corner = positionGeometry.xy
        const px = v1.mul(corner.x).mul(sc1).add(v2.mul(corner.y).mul(sc2))
        const ndc = clip.xy.div(clip.w).add(px.mul(2).div(u.renderSize))
        out.assign(vec4(ndc.mul(clip.w), clip.z, clip.w))
        vUv.assign(corner.mul(MAX_STD_DEV))
        vRgba.assign(vec4(linear, alpha))
      })
    })
    return out
  })
  const fragment = Fn(() => {
    const z2 = dot(vUv, vUv)
    If(z2.greaterThan(MAX_STD_DEV * MAX_STD_DEV), () => { Discard() })
    const a = vRgba.w.mul(exp(z2.mul(-0.5)))
    If(a.lessThan(MIN_ALPHA), () => { Discard() })
    return vec4(vRgba.xyz.mul(a), a)
  })
  const m = new NodeMaterial()
  m.name = 'splats'
  m.vertexNode = vertex()
  m.fragmentNode = fragment()
  m.side = DoubleSide // the second eigenvector turns clockwise, which mirrors the quad
  m.transparent = true
  m.depthWrite = false
  m.depthTest = true
  m.blending = CustomBlending
  m.blendSrc = OneFactor
  m.blendDst = OneMinusSrcAlphaFactor
  m.blendSrcAlpha = OneFactor
  m.blendDstAlpha = OneMinusSrcAlphaFactor
  m.toneMapped = false
  return m
}

function dataTexture(rows: number): DataTexture {
  const t = new DataTexture(new Float32Array(TEX_W * rows * 4), TEX_W, rows, RGBAFormat, FloatType)
  t.minFilter = t.magFilter = NearestFilter
  t.generateMipmaps = false
  t.needsUpdate = true
  return t
}

/** Whether three.js picked its WebGPU backend (else the WebGL2 fallback). */
export const isWebGPU = (r: WebGPURenderer): boolean => Reflect.get(r.backend, 'isWebGPUBackend') === true

export class SplatLayer {
  readonly renderer: WebGPURenderer
  readonly backend: 'webgpu' | 'webgl2'
  readonly sortMode: SortMode
  readonly keyBits: 16 | 24 | 32
  readonly scene = new Scene()
  readonly target: RenderTarget
  readonly gain = uniform(new Vector3(1, 1, 1))
  private items = new Map<string, Item>()
  private capacity = 0
  private count = 0
  private version = 0
  private tex: { center: DataTexture, cov: DataTexture, cov2: DataTexture, items: DataTexture } | null = null
  private mesh: Mesh | null = null
  private geometry: InstancedBufferGeometry | null = null
  private order: InstancedBufferAttribute | StorageInstancedBufferAttribute | null = null
  private sorter: GpuRadixSort | null = null
  private keyKernel: ComputeNode | null = null
  private worker: Worker | null = null
  private workerUrl: string | URL | undefined
  private debug: string
  private sortId = 0
  private pending: { id: number, key: string, resolve: Array<() => void> } | null = null
  private sortedKey = ''      // what the drawn order was sorted for
  private wantKey = ''        // what the last update asked for
  private settleWaiters: Array<{ key: string, resolve: () => void }> = []
  private sorts = 0
  private lastSortMs: number | null = null
  private lastWorkerMs: number | null = null
  private readonly uView = uniform(new Matrix4())
  private readonly uNear = uniform(0.05)
  private readonly uFar = uniform(200)
  private readonly uDmin = uniform(0)
  private readonly uDmax = uniform(1)
  private readonly uCount = uniform(0, 'uint')
  private readonly uRenderSize = uniform(new Vector2(1, 1))
  private readonly uFocal = uniform(new Vector2(1, 1))
  private readonly slotFree: number[] = []

  constructor(opts: SplatLayerOptions) {
    this.renderer = opts.renderer
    this.backend = isWebGPU(this.renderer) ? 'webgpu' : 'webgl2'
    this.sortMode = opts.sort ?? (this.backend === 'webgpu' ? 'gpu' : 'cpu')
    if (this.sortMode === 'gpu' && this.backend !== 'webgpu') throw new Error('the GPU sort needs the WebGPU backend')
    this.keyBits = opts.keyBits ?? 16
    this.workerUrl = opts.workerUrl
    this.debug = opts.debug ?? ''
    this.target = new RenderTarget(1, 1, { type: HalfFloatType, depthBuffer: true })
    this.target.texture.name = 'splat-target'
    for (let s = MAX_ITEMS - 1; s >= 0; s--) this.slotFree.push(s)
  }

  get splats(): number { return this.count }
  has(uid: string): boolean { return this.items.has(uid) }
  itemSplats(uid: string): number { return this.items.get(uid)?.data.count ?? 0 }
  itemIds(): string[] { return [...this.items.keys()] }

  add(uid: string, data: SplatData, object: Object3D): void {
    if (this.items.has(uid)) this.remove(uid)
    const slot = this.slotFree.pop()
    if (slot === undefined) throw new Error(`at most ${MAX_ITEMS} splat items`)
    this.items.set(uid, { uid, data, object, slot, start: 0 })
    this.rebuild()
  }

  remove(uid: string): void {
    const it = this.items.get(uid)
    if (!it) return
    this.items.delete(uid)
    this.slotFree.push(it.slot)
    this.rebuild()
  }

  setColorMultiplier(r: number, g: number, b: number): void { this.gain.value.set(r, g, b) }

  // The combined set: every item's splats back to back, uploaded as data textures; the GPU sort and the draw are
  // rebuilt when the capacity grows.
  private rebuild(): void {
    this.version++
    let n = 0
    for (const it of this.items.values()) { it.start = n; n += it.data.count }
    this.count = n
    if (n > this.capacity) this.allocate(Math.max(padToBlock(n), Math.min(2 * this.capacity, padToBlock(n) * 2)))
    const tex = this.tex
    if (!tex) return
    const center = tex.center.image.data, cov = tex.cov.image.data, cov2 = tex.cov2.image.data
    if (!(center instanceof Float32Array) || !(cov instanceof Float32Array) || !(cov2 instanceof Float32Array)) throw new Error('splat textures are not float')
    center.fill(0); cov.fill(0); cov2.fill(0)
    const slots = new Uint16Array(Math.max(1, n))
    const centers = new Float32Array(Math.max(3, 3 * n))
    for (const it of this.items.values()) {
      const d = it.data
      for (let i = 0; i < d.count; i++) {
        const k = it.start + i
        const x = d.centers[3 * i] ?? 0, y = d.centers[3 * i + 1] ?? 0, z = d.centers[3 * i + 2] ?? 0
        center[4 * k] = x; center[4 * k + 1] = y; center[4 * k + 2] = z; center[4 * k + 3] = it.slot
        centers[3 * k] = x; centers[3 * k + 1] = y; centers[3 * k + 2] = z
        slots[k] = it.slot
        for (let q = 0; q < 4; q++) cov[4 * k + q] = d.covariances[6 * i + q] ?? 0
        cov2[4 * k] = d.covariances[6 * i + 4] ?? 0
        cov2[4 * k + 1] = d.covariances[6 * i + 5] ?? 0
        cov2[4 * k + 2] = (d.colors[4 * i] ?? 0) + 256 * (d.colors[4 * i + 1] ?? 0) + 65536 * (d.colors[4 * i + 2] ?? 0)
        cov2[4 * k + 3] = d.colors[4 * i + 3] ?? 0
      }
    }
    tex.center.needsUpdate = tex.cov.needsUpdate = tex.cov2.needsUpdate = true
    this.uCount.value = n
    if (this.geometry) this.geometry.instanceCount = this.sortMode === 'gpu' ? n : 0
    this.sortedKey = ''
    if (this.sortMode === 'cpu') {
      const w = this.ensureWorker()
      const msg: ToWorker = { type: 'set', version: this.version, centers, slots, count: n }
      w.postMessage(msg, [centers.buffer, slots.buffer])
    }
    if (this.mesh) this.mesh.visible = n > 0
  }

  private allocate(capacity: number): void {
    this.disposeGpu()
    this.capacity = capacity
    const rows = Math.ceil(capacity / TEX_W)
    const items = new DataTexture(new Float32Array(4 * 4 * MAX_ITEMS), 4, MAX_ITEMS, RGBAFormat, FloatType)
    items.minFilter = items.magFilter = NearestFilter
    items.generateMipmaps = false
    items.needsUpdate = true
    this.tex = { center: dataTexture(rows), cov: dataTexture(rows), cov2: dataTexture(rows), items }
    if (this.sortMode === 'gpu') {
      this.sorter = new GpuRadixSort(capacity, this.keyBits)
      this.order = this.sorter.output
      this.keyKernel = this.makeKeyKernel(this.sorter)
    } else {
      this.order = new InstancedBufferAttribute(new Uint32Array(capacity), 1)
    }
    const geo = new InstancedBufferGeometry()
    geo.setAttribute('position', new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0], 3))
    geo.setIndex([0, 1, 2, 0, 2, 3])
    geo.instanceCount = 0
    this.geometry = geo
    const material = makeMaterial(this.tex, this.order, { renderSize: this.uRenderSize, focal: this.uFocal, near: this.uNear, far: this.uFar }, this.debug)
    const mesh = new Mesh(geo, material)
    mesh.frustumCulled = false
    mesh.name = 'splat-layer'
    this.mesh = mesh
    this.scene.add(mesh)
  }

  // keys[0] = the 16/24-bit back-to-front depth key (or the float bits of dmax − d for 32), vals[0] = the index; the
  // padding and splats behind the near plane get the largest key.
  private makeKeyKernel(sorter: GpuRadixSort): ComputeNode {
    const tex = this.tex
    if (!tex) throw new Error('no splat textures')
    const keys = storage(sorter.keys[0], 'uint', sorter.capacity)
    const vals = storage(sorter.vals[0], 'uint', sorter.capacity)
    const bits = this.keyBits
    const maxKey = bits === 32 ? 0xffffffff : 2 ** bits - 1
    const uView = this.uView, uNear = this.uNear, uDmin = this.uDmin, uDmax = this.uDmax, uCount = this.uCount
    const kernel = Fn(() => {
      const i = instanceIndex
      const key = uint(maxKey).toVar()
      If(i.lessThan(uCount), () => {
        const at = ivec2(int(i.mod(uint(TEX_W))), int(i.div(uint(TEX_W))))
        const c = textureLoad(tex.center, at)
        const slot = int(c.w)
        const m0 = textureLoad(tex.items, ivec2(int(0), slot)).xyz
        const m1 = textureLoad(tex.items, ivec2(int(1), slot)).xyz
        const m2 = textureLoad(tex.items, ivec2(int(2), slot)).xyz
        const m3 = textureLoad(tex.items, ivec2(int(3), slot)).xyz
        const world = m0.mul(c.x).add(m1.mul(c.y)).add(m2.mul(c.z)).add(m3)
        const d = uView.mul(vec4(world, 1)).z.negate().toVar()
        If(d.greaterThan(uNear), () => {
          if (bits === 32) {
            key.assign(floatBitsToUint(max(uDmax.sub(d), float(0))))
          } else {
            const q = uDmax.sub(d).div(max(uDmax.sub(uDmin), float(1e-9))).clamp(0, 1)
            key.assign(uint(q.mul(maxKey - 1).add(0.5)))
          }
        })
      })
      keys.element(i).assign(key)
      vals.element(i).assign(i)
    })().compute(sorter.capacity, [256])
    kernel.setName('splat-keys')
    return kernel
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker
    const url = this.workerUrl ?? new URL('./sort-worker.js', import.meta.url)
    const w = new Worker(url, { type: 'module' })
    w.onmessage = (e: MessageEvent<FromWorker>) => this.onWorker(e.data)
    w.onerror = (e) => { console.warn('[splats] sort worker failed', e.message) }
    this.worker = w
    return w
  }

  private onWorker(m: FromWorker): void {
    const p = this.pending
    if (!p || m.id !== p.id) return
    this.pending = null
    if (m.type === 'error') { console.warn('[splats] sort failed:', m.message); for (const r of p.resolve) r(); return }
    if (m.version !== this.version || !this.order || !this.geometry) {
      for (const r of p.resolve) r()
      if (this.wantKey && this.wantKey !== this.sortedKey) this.requestCpuSort(this.wantKey, this.lastRows, this.lastRange) // the set changed meanwhile
      return
    }
    const arr = this.order.array
    if (arr instanceof Uint32Array) arr.set(m.order.subarray(0, m.visible))
    this.order.needsUpdate = true
    this.geometry.instanceCount = m.visible
    this.sortedKey = p.key
    this.sorts++
    this.lastWorkerMs = m.ms
    for (const r of p.resolve) r()
    this.flushWaiters()
    // the camera may have moved while this sort ran
    if (this.wantKey && this.wantKey !== this.sortedKey) this.requestCpuSort(this.wantKey, this.lastRows, this.lastRange)
  }

  private lastRows = new Float32Array(4 * MAX_ITEMS)
  private lastRange = { near: 0.05, dmin: 0, dmax: 1 }

  private requestCpuSort(key: string, rows: Float32Array, range: { near: number, dmin: number, dmax: number }): void {
    if (this.pending) return // one at a time; onWorker starts the next
    const id = ++this.sortId
    this.pending = { id, key, resolve: [] }
    const msg: ToWorker = { type: 'sort', id, version: this.version, rows: rows.slice(), near: range.near, dmin: range.dmin, dmax: range.dmax }
    this.ensureWorker().postMessage(msg)
  }

  private flushWaiters(): void {
    const left: Array<{ key: string, resolve: () => void }> = []
    for (const w of this.settleWaiters) { if (w.key === this.sortedKey) w.resolve(); else left.push(w) }
    this.settleWaiters = left
  }

  // Per frame: the item transforms into their texture rows, the camera's depth range over the items' bounds, and
  // the sort key (camera + transforms + set). Returns that key.
  private prepare(camera: PerspectiveCamera): string {
    const tex = this.tex
    if (!tex) return ''
    camera.updateMatrixWorld()
    const V = camera.matrixWorldInverse
    const ve = V.elements
    const itemsData = tex.items.image.data
    if (!(itemsData instanceof Float32Array)) throw new Error('item texture is not float')
    let dmin = Infinity, dmax = -Infinity
    const parts: string[] = [String(this.version), ...ve.map((v) => v.toFixed(6))]
    const rows = this.lastRows
    const corner = new Vector3()
    for (const it of this.items.values()) {
      it.object.updateWorldMatrix(true, false)
      const e = it.object.matrixWorld.elements
      itemsData.set(e, 16 * it.slot)
      parts.push(...e.map((v) => v.toFixed(6)))
      // the view z row of V·M for the CPU sort: r_j = Σ_k V[2][k] M[k][j]
      for (let j = 0; j < 4; j++) rows[4 * it.slot + j] = (ve[2] ?? 0) * (e[4 * j] ?? 0) + (ve[6] ?? 0) * (e[4 * j + 1] ?? 0) + (ve[10] ?? 0) * (e[4 * j + 2] ?? 0) + (ve[14] ?? 0) * (e[4 * j + 3] ?? 0)
      const { min: lo, max: hi } = it.data
      for (let c = 0; c < 8; c++) {
        corner.set(c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]).applyMatrix4(it.object.matrixWorld).applyMatrix4(V)
        const d = -corner.z
        if (d < dmin) dmin = d
        if (d > dmax) dmax = d
      }
    }
    tex.items.needsUpdate = true
    const near = camera.near
    this.uNear.value = near
    this.uFar.value = camera.far
    this.uView.value.copy(V)
    const lo = Math.max(near, Number.isFinite(dmin) ? dmin : near), hi = Math.max(lo + 1e-6, Number.isFinite(dmax) ? dmax : lo + 1)
    this.uDmin.value = lo
    this.uDmax.value = hi
    this.lastRange = { near, dmin: lo, dmax: hi }
    return parts.join(',')
  }

  /** Sorts for the camera when anything changed since the last sort (WebGPU: now; CPU: in the worker). */
  update(camera: PerspectiveCamera): void {
    if (!this.count || !this.tex) return
    const key = this.prepare(camera)
    this.wantKey = key
    if (key === this.sortedKey) return
    if (this.sortMode === 'gpu') {
      const sorter = this.sorter, keyKernel = this.keyKernel
      if (!sorter || !keyKernel) return
      const t0 = performance.now()
      this.renderer.compute([keyKernel, ...sorter.kernels])
      this.lastSortMs = performance.now() - t0 // CPU-side encode + submit; GPU time: see stats via timestamps
      this.sortedKey = key
      this.sorts++
      this.flushWaiters()
    } else {
      this.requestCpuSort(key, this.lastRows, this.lastRange)
    }
  }

  /** Resolves once the drawn order is for this camera and the current set (a render capture waits for it). */
  settle(camera: PerspectiveCamera, timeoutMs = 30000): Promise<void> {
    this.update(camera)
    if (!this.count || this.sortedKey === this.wantKey) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the splats were still sorting')), timeoutMs)
      this.settleWaiters.push({ key: this.wantKey, resolve: () => { clearTimeout(timer); resolve() } })
    })
  }

  /** Draws the splats into this.target at width × height: colour cleared, depth from drawDepth(), then the splats. */
  render(camera: PerspectiveCamera, width: number, height: number, drawDepth: () => void): void {
    const r = this.renderer
    if (this.target.width !== width || this.target.height !== height) this.target.setSize(width, height)
    this.update(camera)
    const prevTarget = r.getRenderTarget()
    r.setRenderTarget(this.target)
    r.setClearColor(0x000000, 0)
    r.clear(true, true, true)
    drawDepth()
    if (this.mesh && this.count) {
      camera.updateProjectionMatrix()
      const P = camera.projectionMatrix.elements
      this.uRenderSize.value.set(width, height)
      this.uFocal.value.set(0.5 * width * (P[0] ?? 1), 0.5 * height * (P[5] ?? 1))
      r.render(this.scene, camera)
    }
    r.setRenderTarget(prevTarget)
  }

  /** Debug: the generated shaders of the splat draw (WGSL or GLSL). */
  async debugShaders(camera: PerspectiveCamera): Promise<{ vertex: string, fragment: string } | null> {
    if (!this.mesh) return null
    const dbg: unknown = Reflect.get(this.renderer, 'debug')
    const fn: unknown = dbg && typeof dbg === 'object' ? Reflect.get(dbg, 'getShaderAsync') : null
    if (typeof fn !== 'function') return null
    const r: unknown = await Reflect.apply(fn, dbg, [this.scene, camera, this.mesh])
    if (!r || typeof r !== 'object') return null
    return { vertex: String(Reflect.get(r, 'vertexShader')), fragment: String(Reflect.get(r, 'fragmentShader')) }
  }

  stats(): SplatStats {
    const bytes = this.capacity * (16 * 3) + (this.sorter ? this.sorter.capacity * 16 + this.sorter.hist.array.byteLength : this.capacity * 4) + 4 * 4 * MAX_ITEMS * 4
    return { sortMode: this.sortMode, backend: this.backend, splats: this.count, items: this.items.size, capacity: this.capacity, sorts: this.sorts,
      lastSortMs: this.lastSortMs, lastWorkerMs: this.lastWorkerMs, gpuBytes: bytes, keyBits: this.sortMode === 'gpu' ? this.keyBits : 16 }
  }

  /** Debug: the GPU keys and the sorted order, read back (the check compares them with a CPU stable sort). */
  async debugReadSort(): Promise<{ keys: Uint32Array, order: Uint32Array, count: number } | null> {
    const sorter = this.sorter, keyKernel = this.keyKernel
    if (!sorter || !keyKernel) return null
    await this.renderer.computeAsync(keyKernel)
    const keys = new Uint32Array(await this.renderer.getArrayBufferAsync(sorter.keys[0]))
    await this.renderer.computeAsync([keyKernel, ...sorter.kernels])
    const order = new Uint32Array(await this.renderer.getArrayBufferAsync(sorter.output))
    return { keys, order, count: this.count }
  }

  private disposeGpu(): void {
    if (this.mesh) { this.scene.remove(this.mesh); if (this.mesh.material instanceof NodeMaterial) this.mesh.material.dispose() }
    this.geometry?.dispose()
    this.sorter?.dispose()
    this.keyKernel?.dispose()
    if (this.tex) for (const t of Object.values(this.tex)) t.dispose()
    this.mesh = null; this.geometry = null; this.sorter = null; this.keyKernel = null; this.tex = null; this.order = null
  }

  dispose(): void {
    this.disposeGpu()
    this.target.dispose()
    this.worker?.terminate()
    this.worker = null
    this.items.clear()
  }
}

export { BLOCK }
