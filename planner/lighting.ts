// midstudy planner: the furniture's light (contract §4.8). The engine owns the Look and the scene; this module draws it,
// on three.js's WebGPURenderer (WebGPU, or its WebGL2 fallback: the same TSL compiles to both).
//
// With the scene's lighting.json ("photo" mode):
//   - a LightProbe with its ambient SH turned from the camera frame to the world frame (the diffuse ambient light);
//   - an environment map for reflections only: the photo itself baked around the room (planner/gpu/passes.ts
//     createEnvBake, then PMREM), an SH-made one only while the photo can't be (never in practice: the photo is in
//     before lighting.json is read). Lit materials take the environment's specular part only (iblDiffuse 0: the
//     ProbeStandardNodeMaterial / ProbePhysicalNodeMaterial three makes for every MeshStandardMaterial and
//     MeshPhysicalMaterial), so the probe alone gives the diffuse light and nothing is counted twice;
//   - one key DirectionalLight from the key's world direction, its colour and intensity × light_strength, with three's
//     shadow on the pieces;
//   - its shadow on an invisible floor at y = 0 (the catcher): soft (PCSS, the penumbra growing with the distance to
//     the piece that casts it) and black with an alpha, so the photo is only darkened where a piece's shadow falls.
//     The catcher reads its OWN shadow map of the casters (CASTER_LAYER): three's WebGPU renderer draws a light's map
//     only for lit receivers, and a splat item's hidden stand-in must cast too. The occlusion pre-pass hides the shadow
//     behind real things like the furniture.
// Without lighting.json ("default" mode): the v1 lights exactly (RoomEnvironment at 0.8, the key from (−1.5, 4, 2.5)
// at 1.1, the hemisphere light at 0.35), with the same controls on them.
//
// Shadows match WebGLRenderer's (v1): its shadow pass draws a caster's back faces (shadowSide defaults to the flipped
// side), three's WebGPU pass the material's own side, so every caster's material gets the flipped side as its
// shadowSide (without it a box on the floor shadowed its own footprint).
//
// The maths is the kernels' (core/js/web.ts: SH rotation and refit, irradiance, band scaling, the turn between two
// directions, the splats' colour level, azimuth and elevation) and planner/logic/look.ts's (the catcher's numbers). The
// environment maps are built when a frame needs them (fitShadow), once per photo and camera, not on every change.
//
// API: createLighting({ renderer, scene, photo }) → {
//   setData(lightingJson | null), setCamera(R: Matrix3 camera→world, fovY), setLook(resolved), prepare(object3d),
//   fitShadow(box3 | null) (renders the catcher's shadow map), inferred() → the key in the world frame
//   or null, inUse() → the key in use, mode() 'photo' | 'default', splatGain() → [r, g, b] (colour-matching splats),
//   caster(object3d) → a shadow-only copy, maskMode(on), roomEnvironment (the default mode's map, for thumbnails),
//   withDiffuseIbl(fn) (fn with the environment's diffuse light on, whatever the mode) }
import {
  BackSide, DataTexture, DepthTexture, DirectionalLight, DoubleSide, EnvironmentNode, EquirectangularReflectionMapping, FloatType, FrontSide,
  HalfFloatType, HemisphereLight, LightProbe, LinearFilter, LinearSRGBColorSpace, Material, Matrix3, Mesh, MeshBasicMaterial, MeshBasicNodeMaterial,
  MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, NearestFilter, Node, OrthographicCamera, PMREMGenerator, PlaneGeometry, QuadMesh,
  RenderTarget, RGBAFormat, Sphere, SphericalHarmonics3, Vector3,
} from 'three/webgpu'
import type { Box3, NodeBuilder, Object3D, Scene, Texture, WebGPURenderer } from 'three/webgpu'
import { uniform, vec3 } from 'three/tsl'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { azElOf, irradianceAt, maxBandScale, rotateSh, scaleBands, splatGain, turnBetween } from '../core/js/web.js'
import { clearTarget, createCatcher, createEnvBake, isWebGPU, render } from './gpu/passes.js'
import type { Frame, T } from './gpu/passes.js'
import { keepPhoto, keepV1, penumbraTan, shadowFit } from './logic/look.js'
import type { InferredKey, KeyInUse, Vec3 } from './logic/look.js'
import type { JsonObject } from './logic/num.js'

const DEG = Math.PI / 180
const V1 = { key: 1.1, hemi: 0.35, env: 0.8, softness: 0.5 } as const
const V1_KEY_POS: Vec3 = [-1.5, 4, 2.5]
const v1Dir = new Vector3(V1_KEY_POS[0], V1_KEY_POS[1], V1_KEY_POS[2]).normalize()
/** v1's key light direction (towards the light, world frame) and softness: the scene's light without lighting.json. */
export const V1_KEY_DIR: Vec3 = Object.freeze([v1Dir.x, v1Dir.y, v1Dir.z])
export const V1_SOFTNESS = V1.softness
/** The objects that cast the floor shadow (the catcher's own map): every caster mesh, and splat items' stand-in copies. */
const CASTER_LAYER = 3
const SHADOW_SIZE = 2048
const noRaycast = (): undefined => undefined

type Rgb = readonly [number, number, number]
type Sh = readonly Rgb[]

// --- lit materials: the environment's diffuse light can be switched off (the probe replaces it) --------------------------
/** 1: the environment's diffuse light counts (the v1 lights, no lighting.json); 0: it doesn't (the probe is the diffuse
 * ambient, v1's MIDSTUDY_PROBE_DIFFUSE). A uniform, so switching scenes recompiles nothing. */
const iblDiffuse = uniform(1)
class RadianceEnvironmentNode extends EnvironmentNode {
  override setup(builder: NodeBuilder): void {
    // EnvironmentNode adds its radiance (specular) to context.radiance and its irradiance (diffuse, also the
    // multiscattering term) to context.iblIrradiance: catch the latter in a variable and add it back × iblDiffuse
    const ctx: unknown = Reflect.get(builder, 'context')
    const saved: unknown = ctx && typeof ctx === 'object' ? Reflect.get(ctx, 'iblIrradiance') : null
    if (!ctx || typeof ctx !== 'object' || !(saved instanceof Node)) { super.setup(builder); return }
    const sink = vec3(0).toVar()
    Reflect.set(ctx, 'iblIrradiance', sink)
    super.setup(builder)
    Reflect.set(ctx, 'iblIrradiance', saved)
    const add: unknown = Reflect.get(saved, 'addAssign')
    if (typeof add === 'function') Reflect.apply(add, saved, [sink.mul(iblDiffuse)])
  }
}
function envFor(builder: NodeBuilder, own: Node | null): Node | null {
  if (own) return own
  const env: unknown = Reflect.get(builder, 'environmentNode')
  return env instanceof Node ? env : null
}
class ProbeStandardNodeMaterial extends MeshStandardNodeMaterial {
  override setupEnvironment(builder: NodeBuilder): EnvironmentNode | null {
    const env = envFor(builder, this.envNode)
    return env ? new RadianceEnvironmentNode(env) : null
  }
}
class ProbePhysicalNodeMaterial extends MeshPhysicalNodeMaterial {
  override setupEnvironment(builder: NodeBuilder): EnvironmentNode | null {
    const env = envFor(builder, this.envNode)
    return env ? new RadianceEnvironmentNode(env) : null
  }
}

/** lighting.json as the lights use it (contract §4.8), read from the scene's JSON. */
export interface LightData {
  readonly sh: Sh
  /** the key: towards the light, camera frame */
  readonly direction: Rgb
  readonly color: Rgb
  readonly intensity: number
  readonly softness: number
  readonly whiteBalance: Rgb | null
  readonly cctK: number | null
}

function rgbOf(v: unknown): Rgb | null {
  if (!Array.isArray(v) || v.length !== 3) return null
  const arr: readonly unknown[] = v
  const [a, b, c] = arr
  return typeof a === 'number' && typeof b === 'number' && typeof c === 'number' ? [a, b, c] : null
}

const isRecord = (x: unknown): x is JsonObject => typeof x === 'object' && x !== null

/** v1's setData test (ambient.sh 9 rows, key.direction an array), with every number the lights read checked. */
function lightData(lj: JsonObject | null): LightData | null {
  if (lj === null) return null
  const ambient = lj['ambient']
  const key = lj['key']
  if (!isRecord(ambient) || !isRecord(key)) return null
  const shRaw = ambient['sh']
  if (!Array.isArray(shRaw) || shRaw.length !== 9) return null
  const sh: Rgb[] = []
  for (const row of shRaw) {
    const c = rgbOf(row)
    if (!c) return null
    sh.push(c)
  }
  const direction = rgbOf(key['direction'])
  const color = rgbOf(key['color'])
  const intensity = key['intensity']
  const softness = key['softness']
  if (!direction || !color || typeof intensity !== 'number' || typeof softness !== 'number') return null
  const wb = lj['white_balance']
  const cct = isRecord(wb) ? wb['cct_k'] : null
  return { sh, direction, color, intensity, softness, whiteBalance: isRecord(wb) ? rgbOf(wb['rgb']) : null, cctK: typeof cct === 'number' ? cct : null }
}

// The radiance the SH describes, as a small equirectangular image (three.js's equirect convention), for the
// reflections' environment map. Negative lobes are clipped at 0.
function shEquirect(sh: Sh, w = 64, h = 32): DataTexture {
  const S = new SphericalHarmonics3()
  sh.forEach((c, i) => { S.coefficients[i]?.set(c[0], c[1], c[2]) })
  const data = new Float32Array(w * h * 4)
  const v = new Vector3()
  const out = new Vector3()
  for (let j = 0; j < h; j++) {
    const lat = ((j + 0.5) / h - 0.5) * Math.PI
    for (let i = 0; i < w; i++) {
      const phi = ((i + 0.5) / w - 0.5) * 2 * Math.PI
      v.set(Math.cos(phi) * Math.cos(lat), Math.sin(lat), Math.sin(phi) * Math.cos(lat))
      S.getAt(v, out)
      const k = (j * w + i) * 4
      data[k] = Math.max(0, out.x); data[k + 1] = Math.max(0, out.y); data[k + 2] = Math.max(0, out.z); data[k + 3] = 1
    }
  }
  const tex = new DataTexture(data, w, h, RGBAFormat, FloatType)
  tex.mapping = EquirectangularReflectionMapping
  tex.colorSpace = LinearSRGBColorSpace
  tex.magFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}

// A splat item's GLB or stand-in box is invisible (its splats are drawn instead): this copy of it draws nothing in the
// furniture pass (no colour, no depth) but casts its shadow: three's on the pieces, and the catcher's on the floor.
const casterMat = new MeshBasicMaterial({ colorWrite: false, depthWrite: false })
casterMat.shadowSide = BackSide

/** WebGLRenderer's shadow side for a material (the flipped side): what every caster casts with here too. */
function flipSides(mats: readonly Material[]): void {
  for (const m of mats) m.shadowSide ??= m.side === FrontSide ? BackSide : m.side === BackSide ? FrontSide : DoubleSide
}

/** The look as the lights take it: the engine's resolved Look (logic/look.ts resolveLook). */
export interface LightLook {
  readonly light_strength: number
  readonly ambient: number
  readonly cast_shadows: boolean
  readonly light_softness: number
  readonly dir: Vec3
}

// three 0.180's PMREMGenerator (three/webgpu) has fromEquirectangular(texture, renderTarget?); @types/three 0.180
// doesn't declare it.
function fromEquirect(pm: PMREMGenerator, t: Texture, into: RenderTarget | null): RenderTarget {
  const f: unknown = Reflect.get(pm, 'fromEquirectangular')
  const rt: unknown = typeof f === 'function' ? Reflect.apply(f, pm, [t, into]) : null
  if (!isRenderTarget(rt)) throw new Error('PMREMGenerator.fromEquirectangular is missing')
  return rt
}
const isRenderTarget = (x: unknown): x is RenderTarget => x instanceof RenderTarget

/** Measures one step as `midstudy:<step>` (E17 reads them). */
function measure(step: string, t0: number): void {
  try { performance.measure(`midstudy:${step}`, { start: t0, end: performance.now() }) } catch { /* no User Timing */ }
}

/** `photo`: the photo pass's texture node and the furniture pass's frame (the catcher reads the photo's pixels under
 * the shadow). The renderer must be initialized (its environment maps are made here). */
export function createLighting({ renderer, scene, photo }: { renderer: WebGPURenderer; scene: Scene; photo: { node: T; frame: Frame } }) {
  // three refuses to redefine a material in its library: take its own out first
  renderer.library.materialNodes.delete('MeshStandardMaterial')
  renderer.library.materialNodes.delete('MeshPhysicalMaterial')
  renderer.library.addMaterial(ProbeStandardNodeMaterial, 'MeshStandardMaterial')
  renderer.library.addMaterial(ProbePhysicalNodeMaterial, 'MeshPhysicalMaterial')
  renderer.shadowMap.enabled = true
  const pmrem = new PMREMGenerator(renderer)
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  let shEnv: RenderTarget | null = null

  const key = new DirectionalLight(0xffffff, V1.key)
  key.position.set(V1_KEY_POS[0], V1_KEY_POS[1], V1_KEY_POS[2])
  key.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.01
  key.castShadow = false
  const hemi = new HemisphereLight(0xffffff, 0x8a7a66, V1.hemi)
  const probe = new LightProbe()
  probe.visible = false
  scene.add(key, key.target, hemi, probe)
  scene.environment = roomEnv
  scene.environmentIntensity = V1.env

  // The catcher and its own shadow map: the casters' depth seen from the light, drawn before every furniture frame
  // that shows a shadow (fitShadow).
  const shadowRT = new RenderTarget(SHADOW_SIZE, SHADOW_SIZE, { depthBuffer: true })
  shadowRT.depthTexture = new DepthTexture(SHADOW_SIZE, SHADOW_SIZE)
  shadowRT.depthTexture.minFilter = shadowRT.depthTexture.magFilter = NearestFilter
  const shadowCam = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10)
  shadowCam.layers.set(CASTER_LAYER)
  // as a shadow-pass material, three gives it each caster's shadowSide (or side) per object
  const casterDepth = new MeshBasicNodeMaterial()
  casterDepth.colorWrite = false
  Reflect.set(casterDepth, 'isShadowPassMaterial', true)
  const catcher = createCatcher(photo.frame, photo.node, shadowRT.depthTexture, SHADOW_SIZE, isWebGPU(renderer))
  const catcherMesh = new Mesh(new PlaneGeometry(60, 60).rotateX(-Math.PI / 2), catcher.material)
  catcherMesh.name = 'shadow-catcher'
  catcherMesh.renderOrder = 1
  catcherMesh.raycast = noRaycast
  catcherMesh.visible = false
  catcherMesh.frustumCulled = false
  scene.add(catcherMesh)

  let data: LightData | null = null // lighting.json
  let R = new Matrix3()
  let fovY = 55
  let worldSH: Sh | null = null // lighting.json's ambient in the world frame
  let turned: { key: string; sh: Sh } | null = null // worldSH turned with the light when its direction is changed
  let effSH: Sh | null = null // the ambient in use: turned, its directional part scaled by Strength
  let camVersion = 0

  // The reflections from the photo: the bake (an equirectangular half-float map) and its PMREM, made again when the
  // photo or the camera changes (null until the photo is in).
  const bake = createEnvBake(photo.node)
  const bakeQuad = new QuadMesh(bake.material)
  const bakeRT = new RenderTarget(512, 256, { type: HalfFloatType, depthBuffer: false })
  bakeRT.texture.mapping = EquirectangularReflectionMapping
  bakeRT.texture.colorSpace = LinearSRGBColorSpace
  let photoEnv: RenderTarget | null = null
  let photoEnvKey = ''
  function ensurePhotoEnv(): Texture | null {
    const tex: Texture = photo.node.value
    const img: unknown = tex.image
    const w = img instanceof HTMLImageElement ? img.naturalWidth || img.width : 0
    const h = img instanceof HTMLImageElement ? img.naturalHeight || img.height : 0
    if (!data || !w || !h) return null
    const k = `${tex.uuid}|${String(camVersion)}|${String(w)}x${String(h)}`
    if (k === photoEnvKey && photoEnv) return photoEnv.texture
    const t0 = performance.now()
    bake.worldToCam.value.copy(R).transpose()
    bake.tanY.value = Math.tan((fovY * DEG) / 2)
    bake.aspect.value = w / h
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(bakeRT)
    bakeQuad.render(renderer)
    renderer.setRenderTarget(prev)
    const env = fromEquirect(pmrem, bakeRT.texture, photoEnv)
    photoEnv = env
    photoEnvKey = k
    measure('envmap', t0)
    return env.texture
  }
  // The SH-made map: only while the photo's can't be made.
  function ensureShEnv(sh: Sh): Texture {
    if (shEnv) return shEnv.texture
    const eq = shEquirect(sh)
    const env = fromEquirect(pmrem, eq, null)
    eq.dispose()
    shEnv = env
    return env.texture
  }
  function dropShEnv(): void {
    shEnv?.dispose()
    shEnv = null
  }
  // Photo mode's reflections, set before every frame that draws the furniture.
  function syncEnv(): void {
    if (!data || !worldSH) return
    const env = ensurePhotoEnv() ?? ensureShEnv(worldSH)
    if (scene.environment !== env) scene.environment = env
  }

  let look: LightLook = { light_strength: 1, ambient: 1, cast_shadows: false, light_softness: V1.softness, dir: V1_KEY_DIR }
  const mode = (): 'photo' | 'default' => (data ? 'photo' : 'default')

  // lighting.json's key turned to the world frame (R · direction, normalized).
  function keyWorld(d: LightData): Vec3 {
    const v = new Vector3(d.direction[0], d.direction[1], d.direction[2]).applyMatrix3(R).normalize()
    return [v.x, v.y, v.z]
  }
  function inferred(): InferredKey | null {
    if (!data) return null
    const d = keyWorld(data)
    const ae = azElOf(d)
    return { azimuth_deg: ae.azimuth_deg, elevation_deg: ae.elevation_deg, softness: data.softness, direction: d, color: [data.color[0], data.color[1], data.color[2]], intensity: data.intensity, cct_k: data.cctK }
  }
  function inUse(): KeyInUse {
    const color: Vec3 = data ? [data.color[0], data.color[1], data.color[2]] : [1, 1, 1]
    const base = data ? data.intensity : V1.key
    const ae = azElOf(look.dir)
    return { azimuth_deg: ae.azimuth_deg, elevation_deg: ae.elevation_deg, direction: [look.dir[0], look.dir[1], look.dir[2]], color, intensity: base * look.light_strength, softness: look.light_softness }
  }

  // Which meshes cast and receive (v1's rule): every visible mesh casts but a placeholder's; lit meshes receive. The
  // mode needs nothing here (iblDiffuse is a uniform), so a piece is prepared once, when it is built.
  function prepare(root: Object3D): void {
    const placeholder = root.name === 'missing-item' // a layout's piece the library lacks: outlined, casts nothing
    root.traverse((o) => {
      if (!(o instanceof Mesh) || o.name === 'contact-shadow') return
      const mat: unknown = o.material
      // v1 read these off `o.material` as is: an array of materials counts as lit and visible
      const lit = Array.isArray(mat) || (mat instanceof Material && !(mat instanceof MeshBasicMaterial))
      o.castShadow = !placeholder && !(mat instanceof Material && !mat.visible)
      o.receiveShadow = lit && !placeholder
      if (o.castShadow) o.layers.enable(CASTER_LAYER); else o.layers.disable(CASTER_LAYER)
      const mats: unknown[] = Array.isArray(mat) ? mat : [mat]
      flipSides(mats.filter((m): m is Material => m instanceof Material))
    })
  }

  function apply(): void {
    const s = look.light_strength
    const a = look.ambient
    key.position.set(look.dir[0], look.dir[1], look.dir[2]).multiplyScalar(10)
    key.target.position.set(0, 0, 0)
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
    if (data) {
      probe.visible = true
      worldSH ??= rotateSh(data.sh, R.elements)
      // The controls act on the whole directional light, not only the key: a new direction turns the ambient's
      // directional part with the key (so the room's light really moves), and Strength scales that part with the key
      // (so a soft, mostly-ambient room still responds). At the inferred direction and Strength 1 it is lighting.json.
      const inf = keyWorld(data)
      let sh: Sh = worldSH
      if (new Vector3(inf[0], inf[1], inf[2]).angleTo(new Vector3(look.dir[0], look.dir[1], look.dir[2])) > 0.002) {
        const tk = look.dir.map((v) => v.toFixed(5)).join()
        if (turned?.key !== tk) turned = { key: tk, sh: rotateSh(worldSH, turnBetween(inf, look.dir)) }
        sh = turned.sh
      }
      const eff = scaleBands(sh, Math.min(s, maxBandScale(sh)))
      effSH = eff
      eff.forEach((c, i) => { probe.sh.coefficients[i]?.set(c[0], c[1], c[2]) })
      probe.intensity = a
      hemi.visible = false
      key.color.setRGB(data.color[0], data.color[1], data.color[2], LinearSRGBColorSpace)
      key.intensity = data.intensity * s
      iblDiffuse.value = 0
      scene.environmentIntensity = a // reflections: the photo itself once it is in (syncEnv, before the next frame)
    } else {
      effSH = null
      probe.visible = false
      hemi.visible = true
      hemi.intensity = V1.hemi * a
      key.color.set(0xffffff)
      key.intensity = V1.key * s
      iblDiffuse.value = 1
      scene.environment = roomEnv
      scene.environmentIntensity = V1.env * a
    }
    const shadows = look.cast_shadows && s > 0
    key.castShadow = shadows
    key.shadow.radius = 1 + 3 * look.light_softness
    if (!shadows) catcherMesh.visible = false // fitShadow turns it on before a frame with pieces
    // What a full shadow keeps of the floor's light, per channel: ambient / (ambient + key) on an up-facing floor (with
    // lighting.json from its SH and key, so a shadow under a warm sun is cooler; with the v1 lights about half).
    const ly = Math.max(0, look.dir[1])
    if (data && effSH) {
      // A piece blocks the key and the ambient's directional part (bands 1–2: the room's light from above, the windows,
      // the ceiling lights), not its even part (band 0), so a soft room still shows a shadow under a piece.
      const amb = irradianceAt(effSH, [0, 1, 0])
      const even = irradianceAt(scaleBands(effSH, 0), [0, 1, 0])
      const keep = keepPhoto(amb, even, data.color, data.intensity, a, s, ly)
      catcher.keep.value.set(keep[0], keep[1], keep[2])
    } else {
      const k = keepV1(a, s, ly)
      catcher.keep.value.set(k, k, k)
    }
    catcher.tan.value = penumbraTan(look.light_softness)
  }

  // The key's shadow cameras (three's, for the pieces, and the catcher's) around the pieces (box3 in the world frame, or
  // null): an orthographic box looking along the light, wide enough for the pieces and deep enough to reach the floor
  // behind them. Then the catcher's map: the casters' depth from the light.
  const sc = key.shadow.camera
  const tmp = new Vector3()
  function fitShadow(box: Box3 | null): void {
    syncEnv() // every frame: cheap unless the photo or the camera changed
    catcherMesh.visible = key.castShadow && !!box && !box.isEmpty() // no pieces: no shadow map to read
    if (!catcherMesh.visible || !box) return
    const c = box.getCenter(new Vector3())
    const radius = box.getBoundingSphere(new Sphere()).radius
    const d = tmp.set(look.dir[0], look.dir[1], look.dir[2]).normalize()
    const f = shadowFit(radius, box.max.y, d.y, catcher.tan.value)
    key.target.position.copy(c)
    key.position.copy(c).addScaledVector(d, f.back)
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
    for (const cam of [sc, shadowCam]) {
      cam.left = -f.half; cam.right = f.half; cam.top = f.half; cam.bottom = -f.half
      cam.near = f.near
      cam.far = f.far
      cam.updateProjectionMatrix()
    }
    catcher.range.value = f.range
    catcher.width.value = f.width
    catcher.search.value = f.search
    catcher.bias.value = f.bias
    shadowCam.position.copy(key.position)
    shadowCam.up.set(0, 1, 0)
    if (Math.abs(d.y) > 0.999) shadowCam.up.set(0, 0, -1)
    shadowCam.lookAt(c)
    shadowCam.updateMatrixWorld()
    catcher.view.value.copy(shadowCam.matrixWorldInverse)
    const prev = renderer.getRenderTarget()
    const prevOverride = scene.overrideMaterial
    renderer.setRenderTarget(shadowRT)
    clearTarget(renderer, false, true, false)
    scene.overrideMaterial = casterDepth
    try {
      render(renderer, scene, shadowCam) // sets the camera's projection for this backend first
    } finally {
      scene.overrideMaterial = prevOverride
      renderer.setRenderTarget(prev)
    }
    catcher.proj.value.copy(shadowCam.projectionMatrix)
  }

  return {
    key, probe, hemi, catcher: catcherMesh,
    mode, inferred, inUse, prepare, fitShadow,
    /** RoomEnvironment's map (the default mode's environment), for the pieces' thumbnails. */
    roomEnvironment: roomEnv,
    /** Runs fn with the environment's diffuse light counted (a thumbnail is lit by RoomEnvironment, whatever the scene). */
    withDiffuseIbl<V>(fn: () => V): V {
      const was = iblDiffuse.value
      iblDiffuse.value = 1
      try { return fn() } finally { iblDiffuse.value = was }
    },
    /** The keep-room mask takes in the cast shadow (§4.7). */
    maskMode(on: boolean): void { catcher.mask.value = on ? 1 : 0 },
    setData(lj: JsonObject | null): void {
      data = lightData(lj)
      worldSH = null
      turned = null
      dropShEnv()
      photoEnvKey = ''
      apply()
    },
    setCamera(m: Matrix3, fovYDeg: number): void {
      R = m.clone()
      if (fovYDeg) fovY = fovYDeg
      camVersion++
      worldSH = null
      turned = null
      dropShEnv()
      apply()
    },
    setLook(l: LightLook): void { look = l; apply() },
    // Splats carry their source photo's light, so they are colour-matched, not lit (§4.8): the room light's colour
    // (white_balance, luminance 1) times how much of the room's light the controls keep (1 at the defaults: ambient
    // and key weighted by how they light an upright surface on average). No directional term.
    splatGain(): Vec3 {
      const room = data ? { worldSh: worldSH ?? rotateSh(data.sh, R.elements), keyColor: data.color, keyIntensity: data.intensity, whiteBalance: data.whiteBalance } : null
      return splatGain(room, look.ambient, look.light_strength)
    },
    caster(root: Object3D): Object3D {
      const c = root.clone(true)
      c.name = 'shadow-caster'
      c.traverse((o) => {
        o.visible = true
        o.raycast = noRaycast
        o.layers.set(0)
        o.layers.enable(CASTER_LAYER)
        if (o instanceof Mesh) { o.material = casterMat; o.castShadow = true; o.receiveShadow = false }
      })
      return c
    },
  }
}
