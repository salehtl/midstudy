// Every material the planner's renderer draws with, as TSL node materials for three.js's WebGPURenderer: the same code
// compiles to WGSL on its WebGPU backend and to GLSL on its WebGL2 fallback. No frame logic here: planner/engine.passes.ts
// orders the passes, planner/lighting.ts drives the light's two (the environment bake and the floor catcher).
//
//   frame             the uniform every screen pass shares: the photo's rectangle in the target (x, y, w, h, top-left
//                     origin, the target's pixels). photoUv(): the fragment's photo uv (v down), from TSL's
//                     screenCoordinate (top-left on both backends; v1 flipped gl_FragCoord with the target's height).
//   photo             the photo exactly as its bytes are (a NoColorSpace texture, no tone mapping or colour conversion:
//                     the renderer's output colour space is linear, so nothing converts it), letterbox bars outside it.
//   depth pre-pass    the photo's depth (depth.png, × the height scale, + 3 cm) into the depth buffer, colour writes
//                     off, depth test always; depth 0 never occludes (contract §4.5 Occlusion).
//   furniture         the furniture target over the photo: un-premultiply, warmth tint, exposure and ACES Filmic, sRGB,
//                     alpha as drawn; only inside the photo.
//   splats            the splat target over that: un-premultiply, the colour multiplier (§4.5, §4.8), sRGB, no ACES.
//   grid              the floor grid of Adjust floor (§4.5).
//   environment bake  the photo around the room as an equirectangular radiance map (§4.8 reflections).
//   catcher           the key's shadow on the floor as black with an alpha over the photo (§4.8).
// clearTarget() is the one place a target is cleared (three 0.180's WebGL2 backend needs two workarounds there).
import {
  AlwaysDepth, Color, CustomBlending, DataTexture, FloatType, LinearFilter, LinearMipmapLinearFilter, Matrix3, Matrix4, NearestFilter,
  NodeMaterial, NoColorSpace, NormalBlending, OneFactor, OneMinusSrcAlphaFactor, RedFormat, Texture, Vector3, Vector4,
} from 'three/webgpu'
import type { Camera, Node, Object3D, TextureNode, UniformNode, WebGPURenderer } from 'three/webgpu'
import {
  Discard, Fn, If, abs, cameraFar, cameraNear, clamp, dot, float, fract, fwidth, length, max, min, mix, positionGeometry, positionWorld, pow,
  screenCoordinate, screenUV, select, smoothstep, sqrt, step, texture, uniform, uv, vec2, vec3, vec4, viewZToPerspectiveDepth,
} from 'three/tsl'
import type { ShaderNodeObject } from 'three/tsl'

type N = ShaderNodeObject<Node>
/** A uniform node (its `value` is what the engine sets). */
export type U<T> = ShaderNodeObject<UniformNode<T>>
/** A texture node (its `value` is the texture it samples). */
export type T = ShaderNodeObject<TextureNode>

const OCCLUSION_TOLERANCE = 0.03 // m (§4.5)
/** The letterbox bars: 0x0e0f11, written as the Color's linear components (a v1 quirk kept on purpose: (1, 1, 1)). */
export const BAR = new Color(0x0e0f11)

/** Whether three.js picked its WebGPU backend (else the WebGL2 fallback). */
export const isWebGPU = (r: WebGPURenderer): boolean => Reflect.get(r.backend, 'isWebGPUBackend') === true

/** renderer.render(): it returns a Promise only when called before init(), which the planner always awaits first. */
export function render(r: WebGPURenderer, scene: Object3D, camera: Camera): void {
  void r.render(scene, camera)
}

// --- the screen ------------------------------------------------------------------------------------------------------

export interface Frame {
  /** the photo's rectangle in the target: x, y, w, h (target px, top-left origin) */
  readonly rect: U<Vector4>
  /** the fragment's photo uv (v down; 0–1 inside the photo) */
  photoUv(): N
  inPhoto(uv: N): N
}

export function createFrame(): Frame {
  const rect = uniform(new Vector4(0, 0, 1, 1))
  return {
    rect,
    photoUv: () => screenCoordinate.sub(rect.xy).div(rect.zw),
    inPhoto: (p: N) => p.x.greaterThanEqual(0).and(p.y.greaterThanEqual(0)).and(p.x.lessThanEqual(1)).and(p.y.lessThanEqual(1)),
  }
}

/** Sets a frame to the photo's rectangle `rect` (x, y, w, h, target px). */
export function setFrame(f: Frame, rect: readonly [number, number, number, number]): void {
  f.rect.value.set(rect[0], rect[1], rect[2], rect[3])
}

// --- colour ----------------------------------------------------------------------------------------------------------

const srgbToLinear = (c: N): N => mix(c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)), c.greaterThan(vec3(0.04045)))
const linearToSrgb = (c: N): N => mix(c.mul(12.92), pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055), c.greaterThan(vec3(0.0031308)))

type V3 = [number, number, number]
// three.js's ACES Filmic: its input and output matrices, row by row (what multiplies a colour on the left).
const ACES_IN = new Matrix3().set(0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777)
const ACES_OUT = new Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602)
const rowsOf = (m: Matrix3): [V3, V3, V3] => {
  const e = m.elements
  const at = (i: number): number => e[i] ?? 0
  return [[at(0), at(3), at(6)], [at(1), at(4), at(7)], [at(2), at(5), at(8)]]
}
const mulRows = (rows: [V3, V3, V3], v: N): N => vec3(dot(vec3(...rows[0]), v), dot(vec3(...rows[1]), v), dot(vec3(...rows[2]), v))
const IN_ROWS = rowsOf(ACES_IN), OUT_ROWS = rowsOf(ACES_OUT)
const IN_INV_ROWS = rowsOf(ACES_IN.clone().invert()), OUT_INV_ROWS = rowsOf(ACES_OUT.clone().invert())
const rrtOdt = (v: N): N => v.mul(v.add(0.0245786)).sub(0.000090537).div(v.mul(v.mul(0.983729).add(0.4329510)).add(0.238081))

/** three.js's ACESFilmicToneMapping (the same constants), with the exposure applied first. */
function aces(color: N, exposure: N | U<number>): N {
  return clamp(mulRows(OUT_ROWS, rrtOdt(mulRows(IN_ROWS, color.mul(exposure).div(0.6)))), 0, 1)
}
/** The tone curve undone (v1's acesInv): a displayed value back to the radiance that gives it, at exposure 1. */
function acesInverse(d: N): N {
  const y = mulRows(OUT_INV_ROWS, clamp(d, 0, 0.985))
  const qa = float(1).sub(y.mul(0.983729)), qb = float(0.0245786).sub(y.mul(0.4329510)), qc = y.mul(0.238081).add(0.000090537).negate()
  const v = qb.negate().add(sqrt(max(qb.mul(qb).sub(qa.mul(qc).mul(4)), vec3(0)))).div(qa.mul(2))
  return max(mulRows(IN_INV_ROWS, v).mul(0.6), vec3(0))
}

function screenMaterial(name: string): NodeMaterial {
  const m = new NodeMaterial()
  m.name = name
  m.depthTest = false
  m.depthWrite = false
  m.toneMapped = false
  return m
}

// --- textures ----------------------------------------------------------------------------------------------------------

/** The photo as a texture: its bytes as they are (NoColorSpace), not flipped, mipmapped (anisotropy 4). */
export function photoTexture(img: HTMLImageElement): Texture {
  const t = new Texture(img)
  t.flipY = false
  t.colorSpace = NoColorSpace
  t.minFilter = LinearMipmapLinearFilter
  t.magFilter = LinearFilter
  t.generateMipmaps = true
  t.anisotropy = 4
  t.needsUpdate = true
  return t
}

/** depth.png decoded (metres, rows top to bottom) as a float texture, read texel by texel. */
export function depthTexture(data: Float32Array, w: number, h: number): DataTexture {
  const dt = new DataTexture(data, w, h, RedFormat, FloatType)
  dt.flipY = false
  dt.minFilter = dt.magFilter = NearestFilter
  dt.generateMipmaps = false
  dt.needsUpdate = true
  return dt
}

// --- the passes ----------------------------------------------------------------------------------------------------------

export interface PhotoPass {
  readonly material: NodeMaterial
  /** the photo's texture node (an empty texture without a photo): the catcher and the environment bake read it */
  readonly node: T
  setPhoto(t: Texture | null): void
}

export function createPhotoPass(frame: Frame): PhotoPass {
  const empty = new Texture()
  const node = texture(empty)
  const has = uniform(0)
  const bar = uniform(new Vector3(BAR.r, BAR.g, BAR.b))
  const m = screenMaterial('photo')
  m.fragmentNode = Fn(() => {
    const p = frame.photoUv()
    return select(frame.inPhoto(p).and(has.greaterThan(0.5)), vec4(node.sample(p).rgb, 1), vec4(bar, 1))
  })()
  return { material: m, node, setPhoto(t) { node.value = t ?? empty; has.value = t ? 1 : 0 } }
}

export interface DepthPrepass {
  readonly material: NodeMaterial
  readonly scale: U<number>
  setDepth(t: DataTexture | null): void
}

/** Drawn on a 2 × 2 plane whose vertices are taken as clip-space positions (a full-screen pass inside a scene). */
export function createDepthPrepass(frame: Frame): DepthPrepass {
  const empty = depthTexture(new Float32Array([0]), 1, 1)
  const depth = texture(empty)
  const scale = uniform(1)
  const tol = uniform(OCCLUSION_TOLERANCE)
  const m = new NodeMaterial()
  m.name = 'depth-prepass'
  const d = Fn(() => depth.sample(frame.photoUv()).r.mul(scale))()
  m.fragmentNode = Fn(() => {
    If(frame.inPhoto(frame.photoUv()).not(), () => { Discard() })
    If(d.lessThanEqual(0), () => { Discard() })
    return vec4(0)
  })()
  m.vertexNode = vec4(positionGeometry.xy, 0, 1)
  m.depthNode = viewZToPerspectiveDepth(d.add(tol).negate(), cameraNear, cameraFar)
  m.colorWrite = false
  m.depthWrite = true
  m.depthTest = true
  m.depthFunc = AlwaysDepth
  m.toneMapped = false
  return { material: m, scale, setDepth(t) { depth.value = t ?? empty } }
}

export interface FurnitureComposite {
  readonly material: NodeMaterial
  readonly exposure: U<number>
  readonly tint: U<Vector3>
}

/** The furniture (linear, premultiplied) over what the target holds: un-premultiply, tint, exposure + ACES, sRGB. */
export function createFurnitureComposite(frame: Frame, source: Texture): FurnitureComposite {
  const exposure = uniform(1)
  const tint = uniform(new Vector3(1, 1, 1))
  const tex = texture(source)
  const m = screenMaterial('furniture-composite')
  m.fragmentNode = Fn(() => {
    If(frame.inPhoto(frame.photoUv()).not(), () => { Discard() })
    const c = tex.sample(screenUV)
    If(c.a.lessThanEqual(0.002), () => { Discard() })
    return vec4(linearToSrgb(aces(max(c.rgb.div(c.a), vec3(0)).mul(tint), exposure)), min(c.a, float(1)))
  })()
  m.transparent = true
  m.blending = NormalBlending
  return { material: m, exposure, tint }
}

/** The splats (linear, premultiplied) over that: un-premultiply, × gain (the Look and the room's light), sRGB. */
export function createSplatComposite(frame: Frame, source: Texture, gain: U<Vector3>): NodeMaterial {
  const tex = texture(source)
  const m = screenMaterial('splat-composite')
  m.fragmentNode = Fn(() => {
    If(frame.inPhoto(frame.photoUv()).not(), () => { Discard() })
    const c = tex.sample(screenUV)
    If(c.a.lessThanEqual(0.002), () => { Discard() })
    return vec4(linearToSrgb(clamp(c.rgb.div(c.a).mul(gain), 0, 1)), min(c.a, float(1)))
  })()
  m.transparent = true
  m.blending = NormalBlending
  return m
}

/** The floor grid (§4.5): 50 cm lines on y = 0 out to 8 m, fading with distance, 1 m lines a little stronger;
 * premultiplied. */
export function createGridMaterial(): NodeMaterial {
  const color = uniform(new Color(0xf3d27a))
  const lines = (p: N): N => {
    const w = max(fwidth(p), vec2(1e-5))
    const a = fract(p.sub(0.5)).sub(0.5).abs().div(w)
    return float(1).sub(min(min(a.x, a.y), float(1)))
  }
  const m = new NodeMaterial()
  m.name = 'floor-grid'
  m.fragmentNode = Fn(() => {
    const xz = positionWorld.xz
    const fade = float(1).sub(smoothstep(5, 8, length(xz)))
    const a = max(lines(xz.div(0.5)).mul(0.5), lines(xz).mul(0.85)).mul(fade).toVar()
    If(a.lessThan(0.01), () => { Discard() })
    return vec4(color.mul(a), a)
  })()
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

// --- the light's passes (planner/lighting.ts) ------------------------------------------------------------------------------

export interface EnvBake {
  readonly material: NodeMaterial
  /** world → camera rotation (Rᵀ) */
  readonly worldToCam: U<Matrix3>
  /** tan(fov_y / 2) and the photo's aspect */
  readonly tanY: U<number>
  readonly aspect: U<number>
}

/** The photo as an environment map for reflections (§4.8), drawn on a full-screen quad into an equirectangular target:
 * every direction around the room turned into the camera's frame and projected into the photo (directions behind the
 * camera see the front mirrored, directions past the frame's edge its nearest edge), its pixel taken back to radiance
 * the way lighting.json's fit did (sRGB → linear, ACES undone). */
export function createEnvBake(photo: T): EnvBake {
  const worldToCam = uniform(new Matrix3())
  const tanY = uniform(0.5)
  const aspect = uniform(1.5)
  const m = screenMaterial('environment-bake')
  m.fragmentNode = Fn(() => {
    // three.js's equirect convention: u = atan(z, x) / 2π + 0.5, v = asin(y) / π + 0.5, in the quad's own uv (TSL keeps
    // a render target's uv as drawn on both backends)
    const q = uv()
    const phi = q.x.sub(0.5).mul(6.28318531), th = q.y.sub(0.5).mul(3.14159265)
    const c = worldToCam.mul(vec3(th.cos().mul(phi.cos()), th.sin(), th.cos().mul(phi.sin()))).toVar()
    const cz = max(abs(c.z), float(1e-3))
    const ndc = clamp(vec2(c.x.div(cz).div(tanY.mul(aspect)), c.y.div(cz).div(tanY)), -1, 1)
    const p = photo.sample(vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)))).rgb
    return vec4(acesInverse(srgbToLinear(p)), 1)
  })()
  return { material: m, worldToCam, tanY, aspect }
}

// The catcher's blocker search and filter taps (a Poisson disc).
const POISSON: readonly (readonly [number, number])[] = [[-0.94201624, -0.39906216], [0.94558609, -0.76890725], [-0.094184101, -0.92938870], [0.34495938, 0.29387760],
  [-0.91588581, 0.45771432], [-0.81544232, -0.87912464], [-0.38277543, 0.27676845], [0.97484398, 0.75648379],
  [0.44323325, -0.97511554], [0.53742981, -0.47373420], [-0.26496911, -0.41893023], [0.79197514, 0.19090188],
  [-0.24188840, 0.99706507], [-0.81409955, 0.91437590], [0.19984126, 0.78641367], [0.14383161, -0.14100790]]

export interface Catcher {
  readonly material: NodeMaterial
  /** the share of the floor's light a full shadow keeps (ambient / (ambient + key)), per channel */
  readonly keep: U<Vector3>
  /** tan of the light's angular radius */
  readonly tan: U<number>
  /** shadow camera far − near (m), to turn depth differences into metres */
  readonly range: U<number>
  /** shadow camera frustum width (m), to turn metres into shadow-map uv */
  readonly width: U<number>
  /** blocker search radius (uv) */
  readonly search: U<number>
  readonly bias: U<number>
  /** the shadow camera's view and projection (world → its clip space) */
  readonly view: U<Matrix4>
  readonly proj: U<Matrix4>
  /** 1 while the keep-room mask is drawn: the visible shadow in white */
  readonly mask: U<number>
}

/** The key's shadow on the floor (an invisible plane at y = 0) as black with an alpha (PCSS: a blocker search, then a
 * filter whose width grows with the distance from the blocker, so the shadow is sharp where a leg meets the floor and
 * soft away). `shadow`: the catcher's own shadow map (depth, the light's view); `depthRange01`: false when the map holds
 * WebGL's window depth of [−1, 1] clip z (the WebGL2 fallback), true for WebGPU's [0, 1]. */
export function createCatcher(frame: Frame, photo: T, shadow: Texture, shadowSize: number, depthRange01: boolean): Catcher {
  const u = {
    keep: uniform(new Vector3(1, 1, 1)), tan: uniform(0.05), range: uniform(10), width: uniform(4), search: uniform(0.02), bias: uniform(0.002),
    view: uniform(new Matrix4()), proj: uniform(new Matrix4()), mask: uniform(0),
  }
  const map = texture(shadow)
  const m = new NodeMaterial()
  m.name = 'shadow-catcher'
  m.fragmentNode = Fn(() => {
    const clip = u.proj.mul(u.view.mul(vec4(positionWorld, 1)))
    const ndc = clip.xyz.div(clip.w)
    const sx = ndc.x.mul(0.5).add(0.5), sy = ndc.y.mul(-0.5).add(0.5)
    const z0 = depthRange01 ? ndc.z : ndc.z.mul(0.5).add(0.5)
    If(sx.lessThanEqual(0).or(sx.greaterThanEqual(1)).or(sy.lessThanEqual(0)).or(sy.greaterThanEqual(1)).or(z0.greaterThanEqual(1)), () => { Discard() })
    const p = vec2(sx, sy).toVar()
    const z = z0.sub(u.bias).toVar()
    const sum = float(0).toVar(), n = float(0).toVar()
    for (const [a, b] of POISSON) {
      const d = map.sample(p.add(vec2(a, b).mul(u.search))).r.toVar()
      If(d.lessThan(z), () => { sum.addAssign(d); n.addAssign(1) })
    }
    If(n.lessThan(0.5), () => { Discard() })
    const blocker = sum.div(n)
    const pen = max(z.sub(blocker).mul(u.range).mul(u.tan).mul(2).div(u.width), float(0.6 / shadowSize)).toVar()
    const lit = float(0).toVar()
    for (const [a, b] of POISSON) {
      lit.addAssign(step(z, map.sample(p.add(vec2(a, b).mul(pen))).r))
      lit.addAssign(step(z, map.sample(p.add(vec2(b, -a).mul(pen).mul(0.55))).r))
    }
    const occ = float(1).sub(lit.div(32)).toVar()
    If(occ.lessThan(0.004), () => { Discard() })
    // the keep-room mask (§4.7) takes the visible shadow in: white where it is more than faint
    If(u.mask.greaterThan(0.5).and(occ.lessThan(0.1)), () => { Discard() })
    // the photo's pixel back to radiance (ACES undone, as lighting.json's fit did), the key's share taken away where it
    // is blocked, the tone curve again: the alpha of black over the photo's bytes that gives that pixel
    const px = photo.sample(frame.photoUv()).rgb
    const shaded = linearToSrgb(aces(acesInverse(srgbToLinear(px)).mul(float(1).sub(occ.mul(vec3(1).sub(u.keep)))), float(1)))
    const Y = vec3(0.2126, 0.7152, 0.0722)
    const a = clamp(float(1).sub(dot(shaded, Y).div(max(dot(px, Y), float(1e-3)))), 0, 1).toVar()
    If(u.mask.lessThan(0.5).and(a.lessThan(0.003)), () => { Discard() })
    return select(u.mask.greaterThan(0.5), vec4(1), vec4(0, 0, 0, a))
  })()
  m.transparent = true
  m.depthWrite = false
  m.depthTest = true
  m.toneMapped = false
  return { material: m, ...u }
}

// --- clears ------------------------------------------------------------------------------------------------------------------

/** renderer.clear() that clears what it should on both backends. three.js 0.180's WebGL2 backend has two bugs here
 * (WebGPU clears with load ops and has neither), found with a GL call trace (planner/gpu/demo/gltrace.mjs):
 *  - it forces the depth mask on before a clear but not the colour mask, so a colour clear right after a
 *    colorWrite: false draw (the depth pre-pass, a shadow map) did nothing: the previous frame's furniture stayed in
 *    the target (a removed piece showed up in the next capture);
 *  - clearing the canvas (no render target) doesn't bind the default framebuffer, so the clear hit whatever was bound
 *    last (the furniture target's resolve framebuffer after its MSAA blit): the composite then painted the clear colour
 *    over the whole photo (a black view at Fit).
 * So: the colour mask on, and the default framebuffer bound when the target is the canvas. */
export function clearTarget(renderer: WebGPURenderer, color = true, depth = true, stencil = true): void {
  const state: unknown = Reflect.get(renderer.backend, 'state')
  const gl: unknown = Reflect.get(renderer.backend, 'gl')
  if (state && typeof state === 'object') {
    const setMask: unknown = Reflect.get(state, 'setColorMask')
    if (color && typeof setMask === 'function') Reflect.apply(setMask, state, [true])
    const bind: unknown = Reflect.get(state, 'bindFramebuffer')
    if (renderer.getRenderTarget() === null && typeof bind === 'function' && typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext) {
      Reflect.apply(bind, state, [gl.FRAMEBUFFER, null])
    }
  }
  void renderer.clear(color, depth, stencil) // a Promise only before init()
}
