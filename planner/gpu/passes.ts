// The screen-space passes of the planner's renderer (engine.js "Drawing"), as TSL node materials for WebGPURenderer.
// The same code runs on its WebGPU and WebGL2 backends.
//
//   frame         uniforms shared by every pass: the photo's rectangle in the target (x, y, w, h, top-left origin, the
//                 target's pixels) and the target's size. photoUv(): the fragment's photo uv (v down).
//   photoPass     the photo exactly as its bytes are (a NoColorSpace texture, no tone mapping or colour conversion;
//                 the renderer's output colour space is linear, so nothing converts it), letterbox bars outside it.
//   depthPrepass  the photo's depth (depth.png, × the height scale, + 3 cm) into the depth buffer, colour writes off,
//                 depth test always; depth 0 never occludes (contract §4.5 Occlusion).
//   furnitureComposite  the furniture target over the photo: un-premultiply, warmth tint, exposure and ACES Filmic,
//                 sRGB, alpha as drawn; only inside the photo.
//   splatComposite  the splat target over that: un-premultiply, the colour multiplier (§4.8), sRGB, no ACES.
import { AlwaysDepth, Color, DataTexture, FloatType, LinearFilter, NearestFilter, NodeMaterial, NormalBlending, RedFormat, Texture, Vector2, Vector3, Vector4 } from 'three/webgpu'
import type { RenderTarget, UniformNode } from 'three/webgpu'
import { Discard, Fn, If, clamp, dot, float, max, min, mix, positionGeometry, pow, screenCoordinate, screenUV, select, texture, uniform, vec3, vec4, cameraNear, cameraFar, viewZToPerspectiveDepth } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ShaderNodeObject } from 'three/tsl'

type N = ShaderNodeObject<Node>

export const OCCLUSION_TOLERANCE = 0.03 // m (§4.5)
export const BAR = new Color(0x0e0f11)  // letterbox bars

export interface Frame {
  readonly rect: { value: Vector4 }
  readonly target: { value: Vector2 }
  /** the photo's uv of the fragment (v down, 0–1 inside the photo) */
  photoUv(): N
  inPhoto(uv: N): N
}

export function createFrame(): Frame {
  const rect = uniform(new Vector4(0, 0, 1, 1))
  const target = uniform(new Vector2(1, 1))
  return {
    rect, target,
    photoUv: () => screenCoordinate.sub(rect.xy).div(rect.zw),
    inPhoto: (uv: N) => uv.x.greaterThanEqual(0).and(uv.y.greaterThanEqual(0)).and(uv.x.lessThanEqual(1)).and(uv.y.lessThanEqual(1)),
  }
}

export const srgbToLinear = (c: N): N => mix(c.div(12.92), pow(c.add(0.055).div(1.055), vec3(2.4)), c.greaterThan(vec3(0.04045)))
export const linearToSrgb = (c: N): N => mix(c.mul(12.92), pow(c, vec3(1 / 2.4)).mul(1.055).sub(0.055), c.greaterThan(vec3(0.0031308)))

// three.js's ACES Filmic, the same constants as the WebGL composite (engine.js compMat).
const rrtOdt = (v: N): N => v.mul(v.add(0.0245786)).sub(0.000090537).div(v.mul(v.mul(0.983729).add(0.4329510)).add(0.238081))
export function aces(color: N, exposure: N | U<number>): N {
  const c = color.mul(exposure).div(0.6)
  const i = vec3(
    dot(c, vec3(0.59719, 0.35458, 0.04823)),
    dot(c, vec3(0.07600, 0.90834, 0.01566)),
    dot(c, vec3(0.02840, 0.13383, 0.83777)))
  const r = rrtOdt(i)
  return clamp(vec3(
    dot(r, vec3(1.60475, -0.53108, -0.07367)),
    dot(r, vec3(-0.10208, 1.10813, -0.00605)),
    dot(r, vec3(-0.00327, -0.07276, 1.07602))), 0, 1)
}

function fullscreen(m: NodeMaterial, name: string): NodeMaterial {
  m.name = name
  m.depthTest = false
  m.depthWrite = false
  m.toneMapped = false
  return m
}

export interface PhotoPass { material: NodeMaterial, setPhoto(t: Texture | null): void }

export function createPhotoPass(frame: Frame): PhotoPass {
  const empty = new Texture()
  const photo = texture(empty)
  const has = uniform(0)
  const bar = uniform(new Vector3(BAR.r, BAR.g, BAR.b))
  const m = fullscreen(new NodeMaterial(), 'photo')
  m.fragmentNode = Fn(() => {
    const uv = frame.photoUv()
    return select(frame.inPhoto(uv).and(has.greaterThan(0.5)), vec4(photo.sample(uv).rgb, 1), vec4(bar, 1))
  })()
  return {
    material: m,
    setPhoto(t) { photo.value = t ?? empty; has.value = t ? 1 : 0 },
  }
}

/** The photo texture as engine.js makes it: its bytes as they are (NoColorSpace), not flipped, mipmapped. */
export function photoTexture(img: TexImageSource): Texture {
  const t = new Texture(img)
  t.flipY = false
  t.colorSpace = ''
  t.generateMipmaps = true
  t.anisotropy = 4
  t.magFilter = LinearFilter
  t.needsUpdate = true
  return t
}

export function depthTexture(data: Float32Array, w: number, h: number): DataTexture {
  const dt = new DataTexture(data, w, h, RedFormat, FloatType)
  dt.flipY = false
  dt.minFilter = dt.magFilter = NearestFilter
  dt.generateMipmaps = false
  dt.needsUpdate = true
  return dt
}

export interface DepthPrepass { material: NodeMaterial, setDepth(t: DataTexture | null): void, scale: { value: number } }

export function createDepthPrepass(frame: Frame): DepthPrepass {
  const empty = depthTexture(new Float32Array([0]), 1, 1)
  const depth = texture(empty)
  const scale = uniform(1)
  const tol = uniform(OCCLUSION_TOLERANCE)
  const m = new NodeMaterial()
  m.name = 'depth-prepass'
  const d = Fn(() => depth.sample(frame.photoUv()).r.mul(scale))()
  m.fragmentNode = Fn(() => {
    const uv = frame.photoUv()
    If(frame.inPhoto(uv).not(), () => { Discard() })
    If(d.lessThanEqual(0), () => { Discard() })
    return vec4(0)
  })()
  m.vertexNode = vec4(positionGeometry.xy, 0, 1) // a full-screen plane (2 × 2) in clip space
  m.depthNode = viewZToPerspectiveDepth(d.add(tol).negate(), cameraNear, cameraFar)
  m.colorWrite = false
  m.depthWrite = true
  m.depthTest = true
  m.depthFunc = AlwaysDepth
  m.toneMapped = false
  return { material: m, setDepth(t) { depth.value = t ?? empty }, scale }
}

export interface FurnitureComposite { material: NodeMaterial, exposure: { value: number }, tint: { value: Vector3 } }
type U<T> = ShaderNodeObject<UniformNode<T>>

export function createFurnitureComposite(frame: Frame, source: RenderTarget): FurnitureComposite {
  const exposure = uniform(1)
  const tint = uniform(new Vector3(1, 1, 1))
  const tex = texture(source.texture)
  const m = fullscreen(new NodeMaterial(), 'furniture-composite')
  m.fragmentNode = Fn(() => {
    If(frame.inPhoto(frame.photoUv()).not(), () => { Discard() })
    const c = tex.sample(screenUV)
    If(c.a.lessThanEqual(0.002), () => { Discard() })
    const rgb = linearToSrgb(aces(max(c.rgb.div(c.a), vec3(0)).mul(tint), exposure))
    return vec4(rgb, min(c.a, float(1)))
  })()
  m.transparent = true
  m.blending = NormalBlending
  return { material: m, exposure, tint }
}

export function createSplatComposite(frame: Frame, source: RenderTarget, gain: { value: Vector3 }): NodeMaterial {
  const tex = texture(source.texture)
  const g = uniform(gain.value)
  const m = fullscreen(new NodeMaterial(), 'splat-composite')
  m.fragmentNode = Fn(() => {
    If(frame.inPhoto(frame.photoUv()).not(), () => { Discard() })
    const c = tex.sample(screenUV)
    If(c.a.lessThanEqual(0.002), () => { Discard() })
    const rgb = linearToSrgb(clamp(c.rgb.div(c.a).mul(g), 0, 1))
    return vec4(rgb, min(c.a, float(1)))
  })()
  m.transparent = true
  m.blending = NormalBlending
  return m
}

/** warmth tint (engine.js warmthTint): luminance-normalized. */
export function warmthTint(w: number): Vector3 {
  const t = new Vector3(1 + 0.14 * w, 1 + 0.015 * w, 1 - 0.14 * w)
  return t.multiplyScalar(1 / (0.2126 * t.x + 0.7152 * t.y + 0.0722 * t.z))
}
