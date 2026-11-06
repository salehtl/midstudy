// How the planner draws a frame (planner/engine.ts draws through this): the passes and the targets they share, a
// frame's pass order, the full-frame capture setup and the read-back. The materials themselves are planner/gpu/passes.ts
// (TSL: one code path for WebGPU and the WebGL2 fallback). Spec: contract §4.5, §4.7, §4.8.
//
// A frame (drawFrame):
//   1. the furniture pass, into a half-float MSAA target: the depth pre-pass writes the photo's depth (depth.png, + 3 cm)
//      with colour writes off, then the pieces, their contact shadows, the floor catcher and the grid on top of it (so
//      the real sofa hides a piece behind it);
//   2. the splat pass (only while splat items are placed, §4.5 Splats): planner/gpu/splat-layer.ts draws every placed
//      splat into its own half-float target over a depth buffer of its own: the photo's depth (the pre-pass again) and
//      the pieces' meshes depth-only (DEPTH_LAYER), so splats test against both (3 cm tolerance, like meshes) and write
//      none. It is the expensive pass (seconds a frame in software rendering) and most frames change nothing it draws,
//      so it is redrawn only when its key changes (the engine's splatKey);
//   3. the screen: the photo exactly as its bytes are, contain-fit in the target (letterbox bars), the furniture
//      composited over it (Look, ACES, sRGB), then the splats over that (a plain multiplier, sRGB).
import {
  BackSide, CanvasTexture, DoubleSide, FrontSide, HalfFloatType, Mesh, MeshBasicMaterial, MeshBasicNodeMaterial, PlaneGeometry, QuadMesh, RenderTarget,
  SRGBColorSpace, Scene, UnsignedByteType, Vector2, Vector3,
} from 'three/webgpu'
import type { Box3, Material, Object3D, PerspectiveCamera, Texture, WebGPURenderer } from 'three/webgpu'
import { uniform } from 'three/tsl'
import { BAR, clearTarget, createDepthPrepass, createFrame, createFurnitureComposite, createGridMaterial, createPhotoPass, createSplatComposite, isWebGPU, render, setFrame } from './gpu/passes.js'
import type { DepthPrepass, Frame, FurnitureComposite, PhotoPass, U } from './gpu/passes.js'
import type { SplatLayer } from './gpu/splat-layer.js'

/** The placed pieces' own meshes that write depth (also on layer 0): what the splat pass draws depth-only. */
const DEPTH_LAYER = 2

/** Every mesh and line that must not be picked by the raycaster. */
export const noRaycast = (): undefined => undefined

/** A placed piece's meshes that write depth in the furniture pass go on DEPTH_LAYER too, so the splat pass, which draws
 * its own depth, draws exactly them: not a placeholder's see-through fill, not the contact shadows, not a splat item's
 * hidden stand-in (invisible) or its shadow-only caster (added after this). */
export function onDepthLayer(obj: Object3D): void {
  obj.traverse((o) => {
    if (!isMesh(o)) return
    const mats = Array.isArray(o.material) ? o.material : [o.material]
    if (mats.some((m) => m.depthWrite)) o.layers.enable(DEPTH_LAYER)
  })
}
// three's Mesh narrowed with its default type parameters (instanceof would give Mesh<any, any, any>).
const isMesh = (o: unknown): o is Mesh => o instanceof Mesh

// --- contact shadows (contract §2.6.3, as nook): a soft dark blob on the floor under each piece ---------------------------
/** Its height above the floor (m). */
export const SHADOW_Y = 0.004
let blob: { geo: PlaneGeometry; mat: MeshBasicMaterial } | null = null
/** A piece's contact shadow for its local box: 1.45 × its footprint + 6 cm, in the furniture pass (so never on a splat). */
export function makeContactShadow(box: Box3): Mesh {
  if (!blob) {
    const c = document.createElement('canvas')
    c.width = c.height = 128
    const g = c.getContext('2d')
    if (g) {
      const grd = g.createRadialGradient(64, 64, 0, 64, 64, 64)
      grd.addColorStop(0, 'rgba(0,0,0,0.95)')
      grd.addColorStop(0.45, 'rgba(0,0,0,0.85)')
      grd.addColorStop(0.65, 'rgba(0,0,0,0.55)')
      grd.addColorStop(0.82, 'rgba(0,0,0,0.2)')
      grd.addColorStop(1, 'rgba(0,0,0,0)')
      g.fillStyle = grd
      g.fillRect(0, 0, 128, 128)
    }
    const t = new CanvasTexture(c)
    t.colorSpace = SRGBColorSpace
    blob = { geo: new PlaneGeometry(1, 1).rotateX(-Math.PI / 2), mat: new MeshBasicMaterial({ color: 0x000000, map: t, transparent: true, depthWrite: false, opacity: 0.75 }) }
  }
  const size = box.getSize(new Vector3())
  const c = box.getCenter(new Vector3())
  const shadow = new Mesh(blob.geo, blob.mat)
  shadow.name = 'contact-shadow'
  shadow.position.set(c.x, SHADOW_Y, c.z)
  shadow.scale.set(size.x * 1.45 + 0.06, 1, size.z * 1.45 + 0.06)
  shadow.renderOrder = 2
  shadow.raycast = noRaycast
  return shadow
}

/** A depth-only material per side, so a piece's depth in the splat pass is the depth its own material draws. */
function depthOnly(side: typeof FrontSide | typeof BackSide | typeof DoubleSide): MeshBasicNodeMaterial {
  const m = new MeshBasicNodeMaterial()
  m.colorWrite = false
  m.side = side
  return m
}

/** The planner's passes and the targets they share. */
export interface Passes {
  readonly renderer: WebGPURenderer
  /** the photo's rectangle and the target's size, for every screen pass (the furniture target is the screen's size) */
  readonly frame: Frame
  /** 1. the photo, as its bytes are */
  readonly photo: PhotoPass & { readonly quad: QuadMesh }
  /** 2. the furniture composited over the photo: un-premultiply, warmth tint, exposure + ACES Filmic, sRGB */
  readonly comp: FurnitureComposite & { readonly quad: QuadMesh }
  /** 3. the splats over that: the plain Look multiplier (exposure × warmth × the room's light), sRGB */
  readonly splatGain: U<Vector3>
  /** The occlusion pre-pass (§4.5): `mesh` is in the furniture scene (drawn first), `alone` holds a twin for the
   * splat pass's depth. Depth 0 never occludes. */
  readonly depth: { readonly mesh: Mesh; readonly alone: Scene; readonly pass: DepthPrepass }
  /** The floor grid (§4.5): 50 cm lines on y = 0 out to 8 m, fading with distance; 1 m lines a little stronger. */
  readonly grid: Mesh
  /** the furniture pass's half-float MSAA target */
  readonly furnRT: RenderTarget
  /** what the splat target holds: its key (null: nothing; drawn again when the key changes) */
  readonly splat: { drawn: string | null; quad: QuadMesh | null }
  /** The keep-room mask (§4.7): every piece white. */
  readonly maskMat: MeshBasicMaterial
  readonly depthBySide: Readonly<Record<number, MeshBasicNodeMaterial>>
  /** the capture targets, made on the first capture and resized after */
  readonly targets: { capture: RenderTarget | null; mask: RenderTarget | null }
}

export function createPasses(renderer: WebGPURenderer): Passes {
  const frame = createFrame()
  const photo = createPhotoPass(frame)
  const furnRT = new RenderTarget(1, 1, { type: HalfFloatType, samples: 4, depthBuffer: true })
  const comp = createFurnitureComposite(frame, furnRT.texture)
  const depth = createDepthPrepass(frame)
  const plane = new PlaneGeometry(2, 2)
  const prepass = (): Mesh => {
    const m = new Mesh(plane, depth.material)
    m.name = 'depth-prepass'
    m.frustumCulled = false
    m.renderOrder = -1000
    m.raycast = noRaycast
    return m
  }
  const mesh = prepass()
  mesh.visible = false
  const alone = new Scene()
  alone.add(prepass())
  const grid = new Mesh(new PlaneGeometry(16.5, 16.5).rotateX(-Math.PI / 2), createGridMaterial())
  grid.position.y = 0.001
  grid.renderOrder = 5
  grid.raycast = noRaycast
  grid.name = 'floor-grid'
  grid.visible = false
  return {
    renderer, frame,
    photo: { ...photo, quad: new QuadMesh(photo.material) },
    comp: { ...comp, quad: new QuadMesh(comp.material) },
    splatGain: uniform(new Vector3(1, 1, 1)),
    depth: { mesh, alone, pass: depth },
    grid,
    furnRT,
    splat: { drawn: null, quad: null },
    maskMat: new MeshBasicMaterial({ color: 0xffffff, side: DoubleSide, toneMapped: false }),
    depthBySide: { [FrontSide]: depthOnly(FrontSide), [BackSide]: depthOnly(BackSide), [DoubleSide]: depthOnly(DoubleSide) },
    targets: { capture: null, mask: null },
  }
}

/** The splat layer's target, composited by the screen pass from now on. */
export function setSplatSource(p: Passes, t: Texture): void {
  p.splat.quad = new QuadMesh(createSplatComposite(p.frame, t, p.splatGain))
}

/** The photo's rectangle (target px, top-left origin) and the target's size, into every pass that reads them. */
export function setScreen(p: Passes, rect: readonly [number, number, number, number], size: Vector2): void {
  setFrame(p.frame, rect, size)
}

/** The furniture target follows the drawing buffer (the splat target follows it on its next draw). */
export function sizeTargets(p: Passes, w: number, h: number): void {
  if (p.furnRT.width !== w || p.furnRT.height !== h) p.furnRT.setSize(w, h)
}

/** What one frame draws (v1's drawTo). */
export interface FrameOpts {
  /** the furniture scene (pieces, lights, the depth pre-pass, the grid, the catcher) */
  readonly scene: Scene
  readonly camera: PerspectiveCamera
  /** false without a scene: the photo pass alone (the bars) */
  readonly furniture: boolean
  /** the splat layer and the splat pass's key now, or null without splat items (no splat pass) */
  readonly splats: { readonly layer: SplatLayer; readonly key: () => string } | null
}

/** The splat pass's depth: the photo's (the pre-pass twin), then the pieces' meshes depth-only, each with its side. */
function drawDepth(p: Passes, f: FrameOpts): void {
  const r = p.renderer
  if (p.depth.mesh.visible) render(r, p.depth.alone, f.camera)
  r.setRenderObjectFunction((object, scene, camera, geometry, material: Material, group, lightsNode) => {
    r.renderObject(object, scene, camera, geometry, p.depthBySide[material.side] ?? material, group, lightsNode)
  })
  f.camera.layers.set(DEPTH_LAYER)
  try {
    render(r, f.scene, f.camera)
  } finally {
    f.camera.layers.set(0)
    r.setRenderObjectFunction(null) // three's own (nothing else in the planner sets one)
  }
}

/** Draws a frame into `target` (null: the canvas): v1's drawTo. */
export function drawFrame(p: Passes, target: RenderTarget | null, f: FrameOpts): void {
  const r = p.renderer
  r.setRenderTarget(p.furnRT)
  r.setClearColor(0x000000, 0)
  clearTarget(r)
  if (f.furniture) render(r, f.scene, f.camera)
  const s = f.furniture ? f.splats : null
  if (s && s.key() !== p.splat.drawn) {
    try {
      s.layer.render(f.camera, p.furnRT.width, p.furnRT.height, () => { drawDepth(p, f) })
    } catch (e) {
      p.splat.drawn = null
      throw e
    }
    // The key after the render: a sort it started that lands later changes the key (the layer's onChange), and redraws.
    p.splat.drawn = s.key()
  }
  r.setRenderTarget(target)
  r.setClearColor(BAR, 1)
  clearTarget(r)
  p.photo.quad.render(r)
  if (f.furniture) p.comp.quad.render(r)
  if (s && p.splat.quad) p.splat.quad.render(r)
}

/** The full photo frame at w × h (no view offset, no grid): the passes set for it while `fn` runs, then restored by
 * `restore` (the engine's updateView). The engine holds its frames meanwhile (fn awaits read-backs and sorts). */
export async function withFullFrame<T>(p: Passes, camera: PerspectiveCamera, aspect: number, w: number, h: number, fn: () => Promise<T>, restore: () => void): Promise<T> {
  const gridWas = p.grid.visible
  const furn: [number, number] = [p.furnRT.width, p.furnRT.height]
  p.grid.visible = false
  camera.clearViewOffset()
  camera.aspect = aspect
  camera.updateProjectionMatrix()
  setFrame(p.frame, [0, 0, w, h], new Vector2(w, h))
  sizeTargets(p, w, h)
  try {
    return await fn()
  } finally {
    p.grid.visible = gridWas
    sizeTargets(p, furn[0], furn[1])
    p.renderer.setRenderTarget(null)
    restore()
  }
}

/** Reads an 8-bit RGBA target back as tight rows, top to bottom, on both backends (WebGL reads rows bottom-up; WebGPU
 * pads each row to 256 bytes). */
export async function readRgba(r: WebGPURenderer, rt: RenderTarget, w: number, h: number): Promise<Uint8Array<ArrayBuffer>> {
  const px = await r.readRenderTargetPixelsAsync(rt, 0, 0, w, h)
  const src = new Uint8Array(px.buffer, px.byteOffset, px.byteLength)
  const row = w * 4
  const stride = h > 1 ? (src.length - row) / (h - 1) : row
  const bottomUp = !isWebGPU(r)
  const out = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    const from = (bottomUp ? h - 1 - y : y) * stride
    out.set(src.subarray(from, from + row), y * row)
  }
  return out
}

function sized(rt: RenderTarget, w: number, h: number): RenderTarget {
  if (rt.width !== w || rt.height !== h) rt.setSize(w, h)
  return rt
}
/** The capture target for the composite (8-bit, no depth), kept and resized. */
export function captureTarget(p: Passes, w: number, h: number): RenderTarget {
  p.targets.capture ??= new RenderTarget(w, h, { type: UnsignedByteType, depthBuffer: false })
  return sized(p.targets.capture, w, h)
}
/** The mask's target (8-bit, with depth: the pieces hide each other's backs, and the pre-pass hides them). */
export function maskTarget(p: Passes, w: number, h: number): RenderTarget {
  p.targets.mask ??= new RenderTarget(w, h, { type: UnsignedByteType, depthBuffer: true })
  return sized(p.targets.mask, w, h)
}

/** Draws the furniture scene with its pieces' materials swapped to `p.maskMat` (white), black elsewhere. */
export function drawMask(p: Passes, scene: Scene, camera: PerspectiveCamera, rt: RenderTarget): void {
  const r = p.renderer
  r.setRenderTarget(rt)
  r.setClearColor(0x000000, 1)
  clearTarget(r)
  render(r, scene, camera)
}
