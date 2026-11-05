// Every render pass the planner draws (planner/engine.ts draws through these): the photo as it is, the occlusion
// depth pre-pass, the furniture composite (Look, ACES, sRGB), the splat composite (plain multiplier), the floor grid,
// the keep-room mask material, the lights' environment bake and floor shadow catcher (planner/lighting.ts), the render
// targets they share, the one helper every clear goes through, a frame's pass order, the full-frame capture setup and
// the read-backs (which return Promises: WebGPU reads back asynchronously). Spec: contract §4.5, §4.7, §4.8.
//
// Kept in one module for the WebGPU swap (docs/notes/webgpu-spike.md on branch v2-webgpu-spike: "the render passes in
// one module, so the Phase 4 swap replaces materials, not structure"; "route every clear through one helper"). The
// meshes of placed pieces are on DEPTH_LAYER too, so a splat pass can draw their depth alone.
import * as THREE from 'three'

/** Spark's splats: camera layer 1 only (never in the furniture pass or the mask; the raycaster, on 0, skips them). */
export const SPLAT_LAYER = 1
/** The placed pieces' own meshes (also on layer 0): what a splat pass that draws its own depth draws depth-only. */
export const DEPTH_LAYER = 2

/** Every mesh and line that must not be picked by the raycaster. */
export const noRaycast = (): undefined => undefined

/** A uniform the engine keeps a typed handle on (three's IUniform<any> is untyped). */
export interface Uniform<T> {
  value: T
}

const OCCLUSION_TOLERANCE = 0.03 // m (§4.5)
const BAR = new THREE.Color(0x0e0f11) // letterbox bars (v1 writes the Color's linear components: see the spike notes)

// Full-screen triangle for the screen-space passes.
const triGeo = new THREE.BufferGeometry()
triGeo.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3))
const fsVert = 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }'
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)

function fsMesh(material: THREE.Material, renderOrder = 0): THREE.Mesh {
  const m = new THREE.Mesh(triGeo, material)
  m.frustumCulled = false
  m.renderOrder = renderOrder
  m.raycast = noRaycast
  return m
}

/** The photo's rectangle in the target's pixels (top-left origin) → uv with v down; outside the photo: false. */
const PHOTO_UV = `
uniform vec4 uRect;
uniform vec2 uTarget;
vec2 photoUv() {
  vec2 p = vec2(gl_FragCoord.x, uTarget.y - gl_FragCoord.y);
  return (p - uRect.xy) / uRect.zw;
}
bool inPhoto(vec2 uv) { return uv.x >= 0.0 && uv.y >= 0.0 && uv.x <= 1.0 && uv.y <= 1.0; }
`

/** The photo's rectangle and the target's size, shared by the passes that look up the photo. */
export interface ScreenUniforms {
  readonly uRect: Uniform<THREE.Vector4>
  readonly uTarget: Uniform<THREE.Vector2>
}

function screenUniforms(): ScreenUniforms {
  return { uRect: { value: new THREE.Vector4(0, 0, 1, 1) }, uTarget: { value: new THREE.Vector2(1, 1) } }
}

// three.js's ACES Filmic, as its two matrices (column-major, as GLSL's mat3(vec3 …) reads them).
function colMat(c0: readonly number[], c1: readonly number[], c2: readonly number[]): THREE.Matrix3 {
  const at = (c: readonly number[], i: number): number => c[i] ?? 0
  return new THREE.Matrix3().set(at(c0, 0), at(c1, 0), at(c2, 0), at(c0, 1), at(c1, 1), at(c2, 1), at(c0, 2), at(c1, 2), at(c2, 2))
}
const ACES_IN = colMat([0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777])
const ACES_OUT = colMat([1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602])

/** The planner's passes and the targets they share. */
export interface Passes {
  /** 1. the photo, as its bytes are (NoColorSpace texture, no tone mapping, no colour conversion) */
  readonly photo: {
    readonly scene: THREE.Scene
    readonly tPhoto: Uniform<THREE.Texture | null>
    readonly uHas: Uniform<number>
    readonly screen: ScreenUniforms
  }
  /** 2. the furniture composited over the photo: un-premultiply, warmth tint, exposure + ACES Filmic, sRGB */
  readonly comp: {
    readonly scene: THREE.Scene
    readonly uTint: Uniform<THREE.Vector3>
    readonly uExposure: Uniform<number>
    readonly screen: ScreenUniforms
  }
  /** 3. the splats over that: un-premultiply, the plain Look multiplier, sRGB (uRect and uTarget are comp's) */
  readonly splatComp: {
    readonly scene: THREE.Scene
    readonly uGain: Uniform<THREE.Vector3>
  }
  /** The occlusion pre-pass (§4.5): the photo's depth (+ 3 cm) into the depth buffer, colour writes off. Depth 0 never
   * occludes. A mesh of the furniture scene, drawn first (renderOrder −1000). */
  readonly depth: {
    readonly mesh: THREE.Mesh
    readonly tDepth: Uniform<THREE.Texture | null>
    readonly uProj: Uniform<THREE.Matrix4>
    readonly uScale: Uniform<number>
    readonly screen: ScreenUniforms
  }
  /** The floor grid (§4.5): 50 cm lines on y = 0 out to 8 m, fading with distance; 1 m lines a little stronger. */
  readonly grid: THREE.Mesh
  /** The furniture pass's half-float MSAA target; its depth (the pre-pass, then the meshes) is resolved into a texture
   * the splat target shares, so splats test against the photo's depth and the meshes. */
  readonly furnRT: THREE.WebGLRenderTarget
  readonly splatRT: THREE.WebGLRenderTarget
  /** The splat pass is the expensive one (hundreds of thousands of splats; seconds per frame in software rendering),
   * and most frames change nothing it draws, so it is redrawn only when its key changes: `drawn` is the key of the
   * picture splatRT holds (null: none; a new size drops the target's contents). */
  readonly splat: { drawn: string | null }
  /** The keep-room mask (§4.7): every piece white. */
  readonly maskMat: THREE.MeshBasicMaterial
}

export function createPasses(): Passes {
  const photoScreen = screenUniforms()
  const tPhoto: Uniform<THREE.Texture | null> = { value: null }
  const uHas: Uniform<number> = { value: 0 }
  const photoMat = new THREE.ShaderMaterial({
    uniforms: { tPhoto, uHas, uRect: photoScreen.uRect, uTarget: photoScreen.uTarget, uBar: { value: new THREE.Vector3(BAR.r, BAR.g, BAR.b) } },
    vertexShader: fsVert,
    fragmentShader: `${PHOTO_UV}
uniform sampler2D tPhoto;
uniform float uHas;
uniform vec3 uBar;
void main() {
  vec2 uv = photoUv();
  if (uHas < 0.5 || !inPhoto(uv)) { gl_FragColor = vec4(uBar, 1.0); return; }
  gl_FragColor = vec4(texture2D(tPhoto, uv).rgb, 1.0);
}`,
    depthTest: false, depthWrite: false, toneMapped: false,
  })
  const photoScene = new THREE.Scene()
  photoScene.add(fsMesh(photoMat))

  const furnDepth = new THREE.DepthTexture(1, 1)
  const furnRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true, depthTexture: furnDepth })
  const splatRT = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthBuffer: true, depthTexture: furnDepth })
  const compScreen = screenUniforms()
  const uTint: Uniform<THREE.Vector3> = { value: new THREE.Vector3(1, 1, 1) }
  const uExposure: Uniform<number> = { value: 1 }
  const compMat = new THREE.ShaderMaterial({
    uniforms: { tFurn: { value: furnRT.texture }, uRect: compScreen.uRect, uTarget: compScreen.uTarget, uTint, uExposure },
    vertexShader: fsVert,
    fragmentShader: `${PHOTO_UV}
uniform sampler2D tFurn;
uniform vec3 uTint;
uniform float uExposure;
vec3 RRTAndODTFit(vec3 v) {
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 aces(vec3 color) { // three.js ACESFilmicToneMapping, same constants
  const mat3 ACESInputMat = mat3(vec3(0.59719, 0.07600, 0.02840), vec3(0.35458, 0.90834, 0.13383), vec3(0.04823, 0.01566, 0.83777));
  const mat3 ACESOutputMat = mat3(vec3(1.60475, -0.10208, -0.00327), vec3(-0.53108, 1.10813, -0.07276), vec3(-0.07367, -0.00605, 1.07602));
  color *= uExposure / 0.6;
  color = ACESInputMat * color;
  color = RRTAndODTFit(color);
  color = ACESOutputMat * color;
  return clamp(color, 0.0, 1.0);
}
vec3 srgb(vec3 c) { return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
void main() {
  if (!inPhoto(photoUv())) discard; // the furniture is part of the photo's frame, never the letterbox bars
  vec4 c = texture2D(tFurn, gl_FragCoord.xy / uTarget);
  if (c.a <= 0.002) discard;
  vec3 rgb = srgb(aces(max(c.rgb / c.a, 0.0) * uTint));
  gl_FragColor = vec4(rgb, min(c.a, 1.0));
}`,
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  })
  const compScene = new THREE.Scene()
  compScene.add(fsMesh(compMat))

  // Spark wrote the splats linear and premultiplied (a render target's colour space is linear), so un-premultiply, then
  // the plain Look multiplier (exposure × warmth tint × the room's light), then sRGB: at the default Look a splat shows
  // its own colour, the photo's.
  const uGain: Uniform<THREE.Vector3> = { value: new THREE.Vector3(1, 1, 1) }
  const splatCompMat = new THREE.ShaderMaterial({
    uniforms: { tSplat: { value: splatRT.texture }, uRect: compScreen.uRect, uTarget: compScreen.uTarget, uGain },
    vertexShader: fsVert,
    fragmentShader: `${PHOTO_UV}
uniform sampler2D tSplat;
uniform vec3 uGain;
vec3 srgb(vec3 c) { return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
void main() {
  if (!inPhoto(photoUv())) discard;
  vec4 c = texture2D(tSplat, gl_FragCoord.xy / uTarget);
  if (c.a <= 0.002) discard;
  vec3 rgb = srgb(clamp(c.rgb / c.a * uGain, 0.0, 1.0));
  gl_FragColor = vec4(rgb, min(c.a, 1.0));
}`,
    transparent: true, depthTest: false, depthWrite: false, toneMapped: false,
  })
  const splatCompScene = new THREE.Scene()
  splatCompScene.add(fsMesh(splatCompMat))

  const depthScreen = screenUniforms()
  const tDepth: Uniform<THREE.Texture | null> = { value: null }
  const uProj: Uniform<THREE.Matrix4> = { value: new THREE.Matrix4() }
  const uScale: Uniform<number> = { value: 1 }
  const depthMat = new THREE.ShaderMaterial({
    uniforms: { tDepth, uRect: depthScreen.uRect, uTarget: depthScreen.uTarget, uTol: { value: OCCLUSION_TOLERANCE }, uProj, uScale },
    vertexShader: fsVert,
    fragmentShader: `${PHOTO_UV}
uniform sampler2D tDepth;
uniform float uTol;
uniform float uScale;
uniform mat4 uProj;
void main() {
  vec2 uv = photoUv();
  if (!inPhoto(uv)) discard;
  float d = texture2D(tDepth, uv).r * uScale;
  if (d <= 0.0) discard;
  vec4 clip = uProj * vec4(0.0, 0.0, -(d + uTol), 1.0);
  gl_FragDepth = clamp(0.5 * clip.z / clip.w + 0.5, 0.0, 1.0);
  gl_FragColor = vec4(0.0);
}`,
    colorWrite: false, depthWrite: true, depthTest: true, depthFunc: THREE.AlwaysDepth, toneMapped: false,
  })
  const depthPass = fsMesh(depthMat, -1000)
  depthPass.name = 'depth-prepass'
  depthPass.visible = false

  const gridMat = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0xf3d27a) }, uOpacity: { value: 1 } },
    vertexShader: 'varying vec3 vWorld;\nvoid main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `
varying vec3 vWorld;
uniform vec3 uColor;
uniform float uOpacity;
float lines(vec2 p) { vec2 w = max(fwidth(p), vec2(1e-5)); vec2 a = abs(fract(p - 0.5) - 0.5) / w; return 1.0 - min(min(a.x, a.y), 1.0); }
void main() {
  float minor = lines(vWorld.xz / 0.5);
  float major = lines(vWorld.xz);
  float dist = length(vWorld.xz);
  float fade = 1.0 - smoothstep(5.0, 8.0, dist);
  float a = max(minor * 0.5, major * 0.85) * fade * uOpacity;
  if (a < 0.01) discard;
  gl_FragColor = vec4(uColor * a, a);
}`,
    transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
    blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
    blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
  })
  const grid = new THREE.Mesh(new THREE.PlaneGeometry(16.5, 16.5).rotateX(-Math.PI / 2), gridMat)
  grid.position.y = 0.001
  grid.renderOrder = 5
  grid.raycast = noRaycast
  grid.name = 'floor-grid'
  grid.visible = false

  return {
    photo: { scene: photoScene, tPhoto, uHas, screen: photoScreen },
    comp: { scene: compScene, uTint, uExposure, screen: compScreen },
    splatComp: { scene: splatCompScene, uGain },
    depth: { mesh: depthPass, tDepth, uProj, uScale, screen: depthScreen },
    grid,
    furnRT,
    splatRT,
    splat: { drawn: null },
    maskMat: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide, toneMapped: false }),
  }
}

/** The photo's rectangle (target px, top-left origin) and the target's size, into every pass that reads them. */
export function setScreen(p: Passes, rect: readonly [number, number, number, number], target: THREE.Vector2): void {
  for (const s of [p.photo.screen, p.depth.screen, p.comp.screen]) {
    s.uRect.value.set(rect[0], rect[1], rect[2], rect[3])
    s.uTarget.value.copy(target)
  }
}

/** The furniture and splat targets share one depth texture, so they always change size together. */
export function sizeTargets(p: Passes, w: number, h: number): void {
  if (p.splatRT.width !== w || p.splatRT.height !== h) p.splat.drawn = null // a new size drops the target's contents
  p.furnRT.setSize(w, h)
  p.splatRT.setSize(w, h)
}

/** The one place a target is cleared (the WebGPU swap's clear workarounds go here). */
function clearTarget(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null, color: THREE.ColorRepresentation, alpha: number, bits: { color: boolean; depth: boolean; stencil: boolean }): void {
  renderer.setRenderTarget(target)
  renderer.setClearColor(color, alpha)
  renderer.clear(bits.color, bits.depth, bits.stencil)
}

const ALL = { color: true, depth: true, stencil: true }

/** What one frame draws (v1's drawTo). */
export interface Frame {
  readonly renderer: THREE.WebGLRenderer
  /** the furniture scene (pieces, lights, the depth pre-pass, the grid, the catcher, Spark) */
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  /** false without a scene: the photo pass alone (the bars) */
  readonly furniture: boolean
  /** the splat pass's redraw key now (v1's splatKey), or null without splat items (no splat pass) */
  readonly splatKey: (() => string) | null
}

/** Draws a frame into `target` (null: the canvas): v1's drawTo. */
export function drawFrame(p: Passes, target: THREE.WebGLRenderTarget | null, f: Frame): void {
  const r = f.renderer
  clearTarget(r, p.furnRT, 0x000000, 0, ALL)
  if (f.furniture) r.render(f.scene, f.camera)
  // The splats, alone (camera layer SPLAT_LAYER), over the depth the furniture pass left in the shared depth texture
  // (resolved from its MSAA buffer when that render ended): colour cleared, depth kept, Spark writes no depth.
  // Skipped when nothing it draws changed: splatRT still holds that picture.
  const key = f.furniture && f.splatKey !== null ? f.splatKey : null
  if (key !== null && key() !== p.splat.drawn) {
    clearTarget(r, p.splatRT, 0x000000, 0, { color: true, depth: false, stencil: false })
    f.camera.layers.set(SPLAT_LAYER)
    try {
      r.render(f.scene, f.camera)
    } catch (e) {
      p.splat.drawn = null
      throw e
    } finally {
      f.camera.layers.set(0)
    }
    // The key after the render: a generate Spark ran in it (bumping the splat epoch) is already in this picture; the
    // sort it started bumps the epoch again when it lands, and that redraws.
    p.splat.drawn = key()
  }
  clearTarget(r, target, BAR, 1, ALL)
  r.render(p.photo.scene, orthoCam)
  if (f.furniture) r.render(p.comp.scene, orthoCam)
  if (key !== null) r.render(p.splatComp.scene, orthoCam)
}

/** The full photo frame at w × h (no view offset, no grid): the passes set for it while `fn` runs, then restored
 * by `restore` (the engine's updateView). */
export function withFullFrame<T>(p: Passes, renderer: THREE.WebGLRenderer, camera: THREE.PerspectiveCamera, aspect: number, w: number, h: number, fn: () => T, restore: () => void): T {
  const gridWas = p.grid.visible
  const furn: [number, number] = [p.furnRT.width, p.furnRT.height]
  p.grid.visible = false
  camera.clearViewOffset()
  camera.aspect = aspect
  camera.updateProjectionMatrix()
  setScreen(p, [0, 0, w, h], new THREE.Vector2(w, h))
  p.depth.uProj.value.copy(camera.projectionMatrix)
  sizeTargets(p, w, h)
  try {
    return fn()
  } finally {
    p.grid.visible = gridWas
    sizeTargets(p, furn[0], furn[1])
    renderer.setRenderTarget(null)
    restore()
  }
}

/** Reads a target back as RGBA rows, bottom-up (GL order). WebGL reads synchronously; the engine's captures return
 * Promises around it, because WebGPU's read-back (readRenderTargetPixelsAsync) is asynchronous (the Phase 4 swap). */
export function readPixels(renderer: THREE.WebGLRenderer, rt: THREE.WebGLRenderTarget, w: number, h: number): Uint8Array<ArrayBuffer> {
  const buf = new Uint8Array(w * h * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf)
  return buf
}

/** A capture target for the composite (8-bit, no depth). */
export function captureTarget(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: false })
}

/** The mask's target (8-bit, with depth: the pieces hide each other's backs, and the pre-pass hides them). */
export function maskTarget(w: number, h: number): THREE.WebGLRenderTarget {
  return new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType, depthBuffer: true })
}

/** Draws the furniture scene with its pieces' materials swapped to `p.maskMat` (white), black elsewhere. */
export function drawMask(p: Passes, renderer: THREE.WebGLRenderer, scene: THREE.Scene, camera: THREE.PerspectiveCamera, rt: THREE.WebGLRenderTarget): void {
  clearTarget(renderer, rt, 0x000000, 1, ALL)
  renderer.render(scene, camera)
}

// --- the lights' passes (planner/lighting.ts) ---------------------------------------------------------------------

/** The photo as an environment map for reflections (§4.8): every direction around the room, turned into the camera's
 * frame and projected into the photo (directions behind the camera see the front mirrored, directions past the frame's
 * edge its nearest edge), its pixel taken back to radiance the way lighting.json's fit did (sRGB → linear, ACES undone).
 * Metals then reflect the room itself; PMREM blurs it for rough materials. */
export interface EnvBake {
  readonly target: THREE.WebGLRenderTarget
  readonly tPhoto: Uniform<THREE.Texture | null>
  readonly uWorldToCam: Uniform<THREE.Matrix3>
  readonly uTanY: Uniform<number>
  readonly uAspect: Uniform<number>
  render(renderer: THREE.WebGLRenderer): void
}

export function createEnvBake(): EnvBake {
  const target = new THREE.WebGLRenderTarget(512, 256, { type: THREE.HalfFloatType, depthBuffer: false })
  target.texture.mapping = THREE.EquirectangularReflectionMapping
  target.texture.colorSpace = THREE.LinearSRGBColorSpace
  const tPhoto: Uniform<THREE.Texture | null> = { value: null }
  const uWorldToCam: Uniform<THREE.Matrix3> = { value: new THREE.Matrix3() }
  const uTanY: Uniform<number> = { value: 0.5 }
  const uAspect: Uniform<number> = { value: 1.5 }
  const mat = new THREE.ShaderMaterial({
    uniforms: {
      tPhoto, uWorldToCam, uTanY, uAspect,
      uIn: { value: ACES_IN }, uOut: { value: ACES_OUT }, uInInv: { value: ACES_IN.clone().invert() }, uOutInv: { value: ACES_OUT.clone().invert() },
    },
    vertexShader: 'varying vec2 vUv;\nvoid main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: `
varying vec2 vUv;
uniform sampler2D tPhoto;
uniform mat3 uWorldToCam;
uniform float uTanY, uAspect;
uniform mat3 uIn, uOut, uInInv, uOutInv;
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 acesInv(vec3 d) {
  vec3 y = uOutInv * clamp(d, 0.0, 0.985);
  vec3 qa = 1.0 - 0.983729 * y, qb = 0.0245786 - 0.4329510 * y, qc = -(0.000090537 + 0.238081 * y);
  vec3 v = (-qb + sqrt(max(qb * qb - 4.0 * qa * qc, 0.0))) / (2.0 * qa);
  return max(uInInv * v * 0.6, 0.0);
}
void main() {
  // three.js's equirect convention: u = atan(z, x) / 2π + 0.5, v = asin(y) / π + 0.5
  float phi = (vUv.x - 0.5) * 6.28318531, th = (vUv.y - 0.5) * 3.14159265;
  vec3 c = uWorldToCam * vec3(cos(th) * cos(phi), sin(th), cos(th) * sin(phi));
  c.z = -max(abs(c.z), 1e-3);
  vec2 ndc = clamp(vec2(c.x / (-c.z) / (uTanY * uAspect), c.y / (-c.z) / uTanY), -1.0, 1.0);
  vec3 p = texture2D(tPhoto, vec2(ndc.x * 0.5 + 0.5, 0.5 - ndc.y * 0.5)).rgb; // the photo texture has flipY false
  gl_FragColor = vec4(acesInv(toLinear(p)), 1.0);
}`,
    depthTest: false, depthWrite: false, toneMapped: false,
  })
  const scene = new THREE.Scene()
  scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat))
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  return {
    target, tPhoto, uWorldToCam, uTanY, uAspect,
    render(renderer) {
      const prev = renderer.getRenderTarget()
      renderer.setRenderTarget(target)
      renderer.render(scene, cam)
      renderer.setRenderTarget(prev)
    },
  }
}

// The floor catcher: the key's shadow on y = 0 as black with an alpha (PCSS: blocker search, then a filter whose
// width grows with the distance from the blocker, so the shadow is sharp where a leg meets the floor and soft away).
const POISSON: readonly (readonly [number, number])[] = [[-0.94201624, -0.39906216], [0.94558609, -0.76890725], [-0.094184101, -0.92938870], [0.34495938, 0.29387760],
  [-0.91588581, 0.45771432], [-0.81544232, -0.87912464], [-0.38277543, 0.27676845], [0.97484398, 0.75648379],
  [0.44323325, -0.97511554], [0.53742981, -0.47373420], [-0.26496911, -0.41893023], [0.79197514, 0.19090188],
  [-0.24188840, 0.99706507], [-0.81409955, 0.91437590], [0.19984126, 0.78641367], [0.14383161, -0.14100790]]

/** The catcher's uniforms the lights set. */
export interface Catcher {
  readonly material: THREE.ShaderMaterial
  readonly tShadow: Uniform<THREE.Texture | null>
  readonly uShadowMatrix: Uniform<THREE.Matrix4>
  /** the share of the floor's light a full shadow keeps (ambient / (ambient + key)), per channel */
  readonly uKeep: Uniform<THREE.Vector3>
  /** tan of the light's angular radius */
  readonly uTan: Uniform<number>
  /** shadow camera far − near (m), to turn depth differences into meters */
  readonly uRange: Uniform<number>
  /** shadow camera frustum width (m), to turn meters into shadow-map uv */
  readonly uWidth: Uniform<number>
  /** blocker search radius (uv) */
  readonly uSearch: Uniform<number>
  readonly uBias: Uniform<number>
  /** 1 while the engine draws the keep-room mask: the visible shadow in white */
  readonly uMask: Uniform<number>
}

/** `photo`: the photo pass's texture and screen uniforms (the catcher reads the photo's pixels under the shadow). */
export function createCatcher(tPhoto: Uniform<THREE.Texture | null>, screen: ScreenUniforms): Catcher {
  const tShadow: Uniform<THREE.Texture | null> = { value: null }
  const uShadowMatrix: Uniform<THREE.Matrix4> = { value: new THREE.Matrix4() }
  const uKeep: Uniform<THREE.Vector3> = { value: new THREE.Vector3(1, 1, 1) }
  const uTan: Uniform<number> = { value: 0.05 }
  const uRange: Uniform<number> = { value: 10 }
  const uWidth: Uniform<number> = { value: 4 }
  const uSearch: Uniform<number> = { value: 0.02 }
  const uBias: Uniform<number> = { value: 0.002 }
  const uMask: Uniform<number> = { value: 0 }
  const material = new THREE.ShaderMaterial({
    uniforms: {
      tPhoto, uRect: screen.uRect, uTarget: screen.uTarget,
      tShadow, uShadowMatrix, uKeep, uTan, uRange, uWidth, uSearch, uBias, uMask,
      uIn: { value: ACES_IN }, uOut: { value: ACES_OUT }, uInInv: { value: ACES_IN.clone().invert() }, uOutInv: { value: ACES_OUT.clone().invert() },
    },
    vertexShader: 'varying vec3 vWorld;\nvoid main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `
#include <packing>
${PHOTO_UV}
varying vec3 vWorld;
uniform sampler2D tPhoto;
uniform sampler2D tShadow;
uniform mat4 uShadowMatrix;
uniform vec3 uKeep;     // the share of the floor's light a full shadow keeps (ambient / (ambient + key)), per channel
uniform float uTan;     // tan of the light's angular radius
uniform float uRange;   // shadow camera far − near (m), to turn depth differences into meters
uniform float uWidth;   // shadow camera frustum width (m), to turn meters into shadow-map uv
uniform float uSearch;  // blocker search radius (uv)
uniform float uBias;
uniform float uMask;    // 1 while the engine draws the keep-room mask: the visible shadow in white
uniform mat3 uIn, uOut, uInInv, uOutInv;
const vec2 P[16] = vec2[16](${POISSON.map(([a, b]) => `vec2(${String(a)}, ${String(b)})`).join(', ')});
float depthAt(vec2 uv) { return unpackRGBAToDepth(texture2D(tShadow, uv)); }
vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
vec3 toSrgb(vec3 c) { return mix(c * 12.92, pow(c, vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c)); }
vec3 rrt(vec3 v) { return (v * (v + 0.0245786) - 0.000090537) / (v * (0.983729 * v + 0.4329510) + 0.238081); }
vec3 aces(vec3 x) { return clamp(uOut * rrt(uIn * (x / 0.6)), 0.0, 1.0); }
vec3 acesInv(vec3 d) {
  vec3 y = uOutInv * clamp(d, 0.0, 0.985);
  vec3 qa = 1.0 - 0.983729 * y, qb = 0.0245786 - 0.4329510 * y, qc = -(0.000090537 + 0.238081 * y);
  vec3 v = (-qb + sqrt(max(qb * qb - 4.0 * qa * qc, 0.0))) / (2.0 * qa);
  return max(uInInv * v * 0.6, 0.0);
}
void main() {
  vec4 sc = uShadowMatrix * vec4(vWorld, 1.0);
  sc.xyz /= sc.w;
  if (sc.x <= 0.0 || sc.x >= 1.0 || sc.y <= 0.0 || sc.y >= 1.0 || sc.z >= 1.0) discard;
  float z = sc.z - uBias;
  float sum = 0.0, n = 0.0;
  for (int i = 0; i < 16; i++) { float d = depthAt(sc.xy + P[i] * uSearch); if (d < z) { sum += d; n += 1.0; } }
  if (n < 0.5) discard;
  float blocker = sum / n;
  float pen = max((z - blocker) * uRange * uTan * 2.0 / uWidth, 0.6 / ${String(2048)}.0);
  float lit = 0.0;
  for (int i = 0; i < 16; i++) {
    lit += step(z, depthAt(sc.xy + P[i] * pen));
    lit += step(z, depthAt(sc.xy + vec2(P[i].y, -P[i].x) * pen * 0.55));
  }
  float occ = 1.0 - lit / 32.0;
  if (occ < 0.004) discard;
  if (uMask > 0.5) { if (occ < 0.1) discard; gl_FragColor = vec4(1.0); return; }
  // The photo's pixel taken back to radiance (ACES undone, as lighting.json's fit did), the key's share taken away
  // where it is blocked, then the tone curve again: the alpha of black over the photo's bytes that gives that pixel.
  vec3 photo = texture2D(tPhoto, photoUv()).rgb;
  vec3 shaded = toSrgb(aces(acesInv(toLinear(photo)) * (1.0 - occ * (1.0 - uKeep))));
  const vec3 Y = vec3(0.2126, 0.7152, 0.0722);
  float a = clamp(1.0 - dot(shaded, Y) / max(dot(photo, Y), 1e-3), 0.0, 1.0);
  if (a < 0.003) discard;
  gl_FragColor = vec4(0.0, 0.0, 0.0, a);
}`,
    transparent: true, depthWrite: false, depthTest: true, toneMapped: false,
  })
  return { material, tShadow, uShadowMatrix, uKeep, uTan, uRange, uWidth, uSearch, uBias, uMask }
}
