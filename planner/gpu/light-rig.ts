// The furniture's light (contract §4.8, v1: planner/lighting.js) for WebGPURenderer, at the default Look (auto light,
// strength 1, ambient 1): what the spike needs to compare a lit GLB with v1. With lighting.json:
//   - a LightProbe with the ambient SH turned from the camera frame to the world frame (refit, as v1's rotateSH);
//   - the key DirectionalLight (colour × intensity) from the key's world direction, with three's own shadow on the
//     pieces (receiveShadow) — v1's "MIDSTUDY_PROBE_DIFFUSE" is a material class here: lit materials take their
//     environment as reflections only (ProbeStandardNodeMaterial), so the probe alone gives the diffuse ambient;
//   - reflections from the photo: every direction looked up in the photo, sRGB → linear, ACES undone (v1's env bake),
//     prefiltered by three (PMREM);
//   - the floor catcher: its OWN orthographic shadow map of the casters (CASTER_LAYER, so a splat item's hidden
//     stand-in casts too), read by a PCSS shader on an invisible plane at y = 0 that writes black with the alpha that
//     takes the photo's pixel to its shaded value (v1's maths, sRGB/ACES round trip).
// splatGain(): the splat multiplier's light part, white_balance.rgb × level (level 1 at the defaults).
import {
  DepthTexture, DirectionalLight, EquirectangularReflectionMapping, HalfFloatType, LightProbe, LinearSRGBColorSpace, Matrix3, Matrix4, Mesh,
  MeshBasicNodeMaterial, MeshPhysicalNodeMaterial, MeshStandardNodeMaterial, NodeMaterial, OrthographicCamera, PlaneGeometry, QuadMesh,
  Quaternion, RenderTarget, Vector3, Box3, Sphere, NearestFilter, EnvironmentNode, Node as NodeClass, FrontSide, BackSide, DoubleSide,
} from 'three/webgpu'
import type { Material, NodeBuilder, Object3D, Scene, Texture, TextureNode, WebGPURenderer } from 'three/webgpu'
import { Discard, Fn, If, abs, clamp, dot, float, max, mix, positionWorld, sqrt, step, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import type { Node } from 'three/webgpu'
import type { ShaderNodeObject } from 'three/tsl'
import { aces, linearToSrgb, srgbToLinear } from './passes.ts'
import type { Frame } from './passes.ts'

type N = ShaderNodeObject<Node>
type V3 = [number, number, number]
type SH = V3[]

export const CASTER_LAYER = 3 // objects that cast the floor shadow (meshes, and splat items' hidden stand-ins)
const SHADOW_SIZE = 2048

/** WebGLRenderer's shadow pass draws a caster's back faces (its shadowSide defaults to the flipped side); three's
 * WebGPU shadow pass draws its own side. Setting shadowSide explicitly gives both renderers v1's shadows: a box on the
 * floor doesn't shadow its own footprint (its bottom face is at the floor's depth), as in v1. */
export function flipSides(root: Object3D): void {
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const mats: Material[] = Array.isArray(o.material) ? o.material : [o.material]
    for (const m of mats) if (m.shadowSide == null) m.shadowSide = m.side === FrontSide ? BackSide : m.side === BackSide ? FrontSide : DoubleSide
  })
}

export interface LightingJson {
  ambient: { sh: number[][] }
  key: { direction: number[], color: number[], intensity: number, softness: number }
  white_balance?: { rgb: number[] }
}

// --- SH maths (v1 planner/lighting.js, unchanged) ---------------------------------------------------------------------------
const lum = (c: readonly number[]): number => 0.2126 * (c[0] ?? 0) + 0.7152 * (c[1] ?? 0) + 0.0722 * (c[2] ?? 0)
const irrBasis = (x: number, y: number, z: number): number[] => [0.886227, 1.023328 * y, 1.023328 * z, 1.023328 * x, 0.858086 * x * y, 0.858086 * y * z, 0.743125 * z * z - 0.247708, 0.858086 * x * z, 0.429043 * (x * x - y * y)]
const FIB: V3[] = Array.from({ length: 96 }, (_, i) => {
  const y = 1 - (2 * (i + 0.5)) / 96, r = Math.sqrt(1 - y * y), a = i * Math.PI * (3 - Math.sqrt(5))
  return [Math.cos(a) * r, y, Math.sin(a) * r]
})
function solve(A: number[][], b: number[]): number[] {
  const n = b.length
  const M = A.map((row, i) => [...row, b[i] ?? 0])
  const at = (r: number, c: number): number => M[r]?.[c] ?? 0
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(at(r, c)) > Math.abs(at(p, c))) p = r
    const rc = M[c], rp = M[p]
    if (rc && rp) { M[c] = rp; M[p] = rc }
    const d = at(c, c) || 1e-12
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = at(r, c) / d
      const row = M[r], piv = M[c]
      if (f && row && piv) for (let k = c; k <= n; k++) row[k] = (row[k] ?? 0) - f * (piv[k] ?? 0)
    }
  }
  return M.map((row, i) => (row[n] ?? 0) / (at(i, i) || 1e-12))
}
export function rotateSH(sh: SH, R: Matrix3): SH {
  const e = R.elements
  const toCam = ([x, y, z]: V3): V3 => [(e[0] ?? 0) * x + (e[1] ?? 0) * y + (e[2] ?? 0) * z, (e[3] ?? 0) * x + (e[4] ?? 0) * y + (e[5] ?? 0) * z, (e[6] ?? 0) * x + (e[7] ?? 0) * y + (e[8] ?? 0) * z]
  const rows = FIB.map((d) => irrBasis(...d))
  const AtA = Array.from({ length: 9 }, (_, i) => Array.from({ length: 9 }, (_, j) => rows.reduce((s, r) => s + (r[i] ?? 0) * (r[j] ?? 0), 0)))
  const out: SH = Array.from({ length: 9 }, (): V3 => [0, 0, 0])
  for (let ch = 0; ch < 3; ch++) {
    const t = FIB.map((d) => { const b = irrBasis(...toCam(d)); return b.reduce((s, v, i) => s + v * (sh[i]?.[ch] ?? 0), 0) })
    const Atb = Array.from({ length: 9 }, (_, i) => rows.reduce((s, r, k) => s + (r[i] ?? 0) * (t[k] ?? 0), 0))
    solve(AtA, Atb).forEach((v, i) => { const o = out[i]; if (o) o[ch] = v })
  }
  return out
}
export const irradianceAt = (sh: SH, [x, y, z]: V3): V3 => {
  const b = irrBasis(x, y, z)
  const ch = (c: number): number => b.reduce((s, v, i) => s + v * (sh[i]?.[c] ?? 0), 0)
  return [ch(0), ch(1), ch(2)]
}
export const scaleBands = (sh: SH, k: number): SH => sh.map((c, i): V3 => (i === 0 ? [c[0], c[1], c[2]] : [c[0] * k, c[1] * k, c[2] * k]))
export function maxBandScale(sh: SH): number {
  const dc = lum(irradianceAt(scaleBands(sh, 0), [0, 1, 0]))
  let k = Infinity
  for (const d of FIB) {
    const e1 = lum(irradianceAt(sh, d)) - dc
    if (e1 < -1e-9) k = Math.min(k, (0.95 * dc) / -e1)
  }
  return k
}
const asV3 = (a: readonly number[] | undefined): V3 => [a?.[0] ?? 0, a?.[1] ?? 0, a?.[2] ?? 0]

// --- materials: environment for reflections only ------------------------------------------------------------------------------
/** 1: the environment's diffuse light counts (v1's lights, no lighting.json); 0: it doesn't (the probe is the diffuse
 * ambient, v1's MIDSTUDY_PROBE_DIFFUSE). A uniform, so switching scenes recompiles nothing. */
export const iblDiffuse = uniform(1)
class RadianceEnvironmentNode extends EnvironmentNode {
  override setup(builder: NodeBuilder): void {
    // EnvironmentNode adds its radiance (specular) to context.radiance and its irradiance (diffuse, also the
    // multiscattering term) to context.iblIrradiance: catch the latter in a variable and add it back × iblDiffuse
    const ctx: unknown = Reflect.get(builder, 'context')
    const saved: unknown = ctx && typeof ctx === 'object' ? Reflect.get(ctx, 'iblIrradiance') : null
    if (!ctx || typeof ctx !== 'object' || !(saved instanceof NodeClass)) { super.setup(builder); return }
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
  return env instanceof NodeClass ? env : null
}
export class ProbeStandardNodeMaterial extends MeshStandardNodeMaterial {
  override setupEnvironment(builder: NodeBuilder): EnvironmentNode | null {
    const env = envFor(builder, this.envNode)
    return env ? new RadianceEnvironmentNode(env) : null
  }
}
export class ProbePhysicalNodeMaterial extends MeshPhysicalNodeMaterial {
  override setupEnvironment(builder: NodeBuilder): EnvironmentNode | null {
    const env = envFor(builder, this.envNode)
    return env ? new RadianceEnvironmentNode(env) : null
  }
}

// --- the photo as an environment map (v1 makeEnvBakeMat) ---------------------------------------------------------------------
const OUT_INV = new Matrix3().set(1.60475, -0.53108, -0.07367, -0.10208, 1.10813, -0.00605, -0.00327, -0.07276, 1.07602).invert()
const IN_INV = new Matrix3().set(0.59719, 0.35458, 0.04823, 0.07600, 0.90834, 0.01566, 0.02840, 0.13383, 0.83777).invert()
const rowsOf = (m: Matrix3): [V3, V3, V3] => { const e = m.elements; return [[e[0] ?? 0, e[3] ?? 0, e[6] ?? 0], [e[1] ?? 0, e[4] ?? 0, e[7] ?? 0], [e[2] ?? 0, e[5] ?? 0, e[8] ?? 0]] }
const mulRows = (rows: [V3, V3, V3], v: N): N => vec3(dot(vec3(...rows[0]), v), dot(vec3(...rows[1]), v), dot(vec3(...rows[2]), v))
export function acesInverse(d: N): N {
  const y = mulRows(rowsOf(OUT_INV), clamp(d, 0, 0.985))
  const qa = float(1).sub(y.mul(0.983729)), qb = float(0.0245786).sub(y.mul(0.4329510)), qc = y.mul(0.238081).add(0.000090537).negate()
  const v = qb.negate().add(sqrt(max(qb.mul(qb).sub(qa.mul(qc).mul(4)), vec3(0)))).div(qa.mul(2))
  return max(mulRows(rowsOf(IN_INV), v).mul(0.6), vec3(0))
}

export interface LightRig {
  key: DirectionalLight
  probe: LightProbe
  catcher: Mesh
  catcherMaterial: NodeMaterial
  /** lighting.json (or null: the v1 lights) and the camera (R camera→world, fov) */
  setData(lj: LightingJson | null, R: Matrix3, fovYDeg: number): void
  /** the photo for the reflections (baked once per photo and camera) */
  setPhoto(t: Texture | null, aspect: number): void
  /** per frame, before the furniture pass: fits the key's shadow cameras to the casters and renders the catcher's map */
  fitShadow(box: Box3 | null, casters: Scene): void
  splatGain(): V3
  inferredKeyWorld(): V3 | null
}

const POISSON: Array<[number, number]> = [[-0.94201624, -0.39906216], [0.94558609, -0.76890725], [-0.094184101, -0.92938870], [0.34495938, 0.29387760],
  [-0.91588581, 0.45771432], [-0.81544232, -0.87912464], [-0.38277543, 0.27676845], [0.97484398, 0.75648379],
  [0.44323325, -0.97511554], [0.53742981, -0.47373420], [-0.26496911, -0.41893023], [0.79197514, 0.19090188],
  [-0.24188840, 0.99706507], [-0.81409955, 0.91437590], [0.19984126, 0.78641367], [0.14383161, -0.14100790]]

export function createLightRig(opts: { renderer: WebGPURenderer, scene: Scene, frame: Frame, photo: { node: ShaderNodeObject<TextureNode> } }): LightRig {
  const { renderer, scene, frame } = opts
  const webgpu = Reflect.get(renderer.backend, 'isWebGPUBackend') === true
  renderer.shadowMap.enabled = true
  // three's library refuses to redefine a material: take its own out first
  renderer.library.materialNodes.delete('MeshStandardMaterial')
  renderer.library.materialNodes.delete('MeshPhysicalMaterial')
  renderer.library.addMaterial(ProbeStandardNodeMaterial, 'MeshStandardMaterial')
  renderer.library.addMaterial(ProbePhysicalNodeMaterial, 'MeshPhysicalMaterial')

  const key = new DirectionalLight(0xffffff, 1.1)
  key.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.01
  key.castShadow = false
  const probe = new LightProbe()
  probe.visible = false
  scene.add(key, key.target, probe)

  // the catcher's own shadow map
  const shadowCam = new OrthographicCamera(-1, 1, 1, -1, 0.01, 10)
  shadowCam.layers.set(CASTER_LAYER)
  const shadowRT = new RenderTarget(SHADOW_SIZE, SHADOW_SIZE, { depthBuffer: true })
  shadowRT.depthTexture = new DepthTexture(SHADOW_SIZE, SHADOW_SIZE)
  shadowRT.depthTexture.minFilter = shadowRT.depthTexture.magFilter = NearestFilter
  const depthOnly = new MeshBasicNodeMaterial()
  depthOnly.colorWrite = false
  // as a shadow-pass material, three gives it each caster's shadowSide (or side) per object: flipSides() below sets
  // the casters' shadowSide to WebGL's default (front faces cast from their back faces, as v1's shadow map does)
  Reflect.set(depthOnly, 'isShadowPassMaterial', true)
  const u = {
    keep: uniform(new Vector3(1, 1, 1)), tan: uniform(0.05), range: uniform(10), width: uniform(4), search: uniform(0.02), bias: uniform(0.002),
    view: uniform(new Matrix4()), proj: uniform(new Matrix4()),
  }
  const shadowDepth = texture(shadowRT.depthTexture)
  const catcherMat = new NodeMaterial()
  catcherMat.name = 'shadow-catcher'
  catcherMat.fragmentNode = Fn(() => {
    const clip = u.proj.mul(u.view.mul(vec4(positionWorld, 1)))
    const ndc = clip.xyz.div(clip.w)
    const sx = ndc.x.mul(0.5).add(0.5), sy = ndc.y.mul(-0.5).add(0.5)
    const z0 = webgpu ? ndc.z : ndc.z.mul(0.5).add(0.5)
    If(sx.lessThanEqual(0).or(sx.greaterThanEqual(1)).or(sy.lessThanEqual(0)).or(sy.greaterThanEqual(1)).or(z0.greaterThanEqual(1)), () => { Discard() })
    const p = vec2(sx, sy).toVar()
    const z = z0.sub(u.bias).toVar()
    const sum = float(0).toVar(), n = float(0).toVar()
    for (const [a, b] of POISSON) {
      const d = shadowDepth.sample(p.add(vec2(a, b).mul(u.search))).toVar()
      If(d.lessThan(z), () => { sum.addAssign(d); n.addAssign(1) })
    }
    If(n.lessThan(0.5), () => { Discard() })
    const blocker = sum.div(n)
    const pen = max(z.sub(blocker).mul(u.range).mul(u.tan).mul(2).div(u.width), float(0.6 / SHADOW_SIZE)).toVar()
    const lit = float(0).toVar()
    for (const [a, b] of POISSON) {
      lit.addAssign(step(z, shadowDepth.sample(p.add(vec2(a, b).mul(pen)))))
      lit.addAssign(step(z, shadowDepth.sample(p.add(vec2(b, -a).mul(pen).mul(0.55)))))
    }
    const occ = float(1).sub(lit.div(32)).toVar()
    If(occ.lessThan(0.004), () => { Discard() })
    // the photo's pixel back to radiance (ACES undone), the key's share taken away where it is blocked, the tone
    // curve again: the alpha of black over the photo's bytes that gives that pixel
    const photo = opts.photo.node.sample(frame.photoUv()).rgb
    const shaded = linearToSrgb(aces(acesInverse(srgbToLinear(photo)).mul(float(1).sub(occ.mul(vec3(1).sub(u.keep)))), float(1)))
    const Y = vec3(0.2126, 0.7152, 0.0722)
    const a = clamp(float(1).sub(dot(shaded, Y).div(max(dot(photo, Y), float(1e-3)))), 0, 1).toVar()
    If(a.lessThan(0.003), () => { Discard() })
    return vec4(0, 0, 0, a)
  })()
  catcherMat.transparent = true
  catcherMat.depthWrite = false
  catcherMat.depthTest = true
  catcherMat.toneMapped = false
  const catcher = new Mesh(new PlaneGeometry(60, 60).rotateX(-Math.PI / 2), catcherMat)
  catcher.name = 'shadow-catcher'
  catcher.renderOrder = 1
  catcher.frustumCulled = false
  catcher.visible = false
  scene.add(catcher)

  // the environment from the photo
  const envRT = new RenderTarget(512, 256, { type: HalfFloatType, depthBuffer: false })
  envRT.texture.mapping = EquirectangularReflectionMapping
  envRT.texture.colorSpace = LinearSRGBColorSpace
  const envU = { worldToCam: uniform(new Matrix3()), tanY: uniform(0.5), aspect: uniform(1.5) }
  const envMat = new NodeMaterial()
  envMat.fragmentNode = Fn(() => {
    // three.js's equirect convention: u = atan(z, x) / 2π + 0.5, v = asin(y) / π + 0.5, in the texture coordinates the
    // quad was drawn with (TSL keeps a render target's uv as drawn on both backends)
    const q = uv()
    const phi = q.x.sub(0.5).mul(6.28318531), th = q.y.sub(0.5).mul(3.14159265)
    const c = envU.worldToCam.mul(vec3(th.cos().mul(phi.cos()), th.sin(), th.cos().mul(phi.sin()))).toVar()
    const cz = max(abs(c.z), float(1e-3))
    const ndc = clamp(vec2(c.x.div(cz).div(envU.tanY.mul(envU.aspect)), c.y.div(cz).div(envU.tanY)), -1, 1)
    const p = opts.photo.node.sample(vec2(ndc.x.mul(0.5).add(0.5), float(0.5).sub(ndc.y.mul(0.5)))).rgb
    return vec4(acesInverse(srgbToLinear(p)), 1)
  })()
  envMat.depthTest = envMat.depthWrite = false
  const envQuad = new QuadMesh(envMat)
  let envReady = false

  let data: LightingJson | null = null
  let R = new Matrix3()
  let fovY = 55
  let worldSH: SH | null = null
  let effSH: SH | null = null
  let photo: { t: Texture, aspect: number } | null = null

  const inferredKeyWorld = (): V3 | null => (data ? asV3(new Vector3(...asV3(data.key.direction)).applyMatrix3(R).normalize().toArray()) : null)

  function bakeEnv(): void {
    if (!data || !photo) return
    envU.worldToCam.value.copy(R).transpose()
    envU.tanY.value = Math.tan((fovY * Math.PI) / 180 / 2)
    envU.aspect.value = photo.aspect
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(envRT)
    envQuad.render(renderer)
    renderer.setRenderTarget(prev)
    envReady = true
    scene.environment = envRT.texture
    scene.environmentIntensity = 1
  }

  function apply(): void {
    const V1 = { key: 1.1, hemi: 0.35, env: 0.8, keyPos: [-1.5, 4, 2.5] as const }
    const lj = data
    if (lj) {
      worldSH = rotateSH(lj.ambient.sh.map(asV3), R)
      const dir = inferredKeyWorld() ?? [0, 1, 0]
      key.position.set(...dir).multiplyScalar(10)
      key.color.setRGB(...asV3(lj.key.color), LinearSRGBColorSpace)
      key.intensity = lj.key.intensity
      effSH = scaleBands(worldSH, Math.min(1, maxBandScale(worldSH)))
      effSH.forEach((c, i) => probe.sh.coefficients[i]?.set(c[0], c[1], c[2]))
      probe.intensity = 1
      probe.visible = true
      iblDiffuse.value = 0
      key.castShadow = true
      // what a full shadow keeps of the floor's light, per channel (v1 apply())
      const ly = Math.max(0, dir[1])
      const amb = irradianceAt(effSH, [0, 1, 0]), even = irradianceAt(scaleBands(effSH, 0), [0, 1, 0])
      const kc = asV3(lj.key.color)
      const keepOf = (c: 0 | 1 | 2): number => {
        const T = Math.max(1e-4, amb[c] + kc[c] * lj.key.intensity * ly)
        return Math.min(1, Math.max(0.08, Math.min(even[c], amb[c]) / T))
      }
      u.keep.value.set(keepOf(0), keepOf(1), keepOf(2))
      u.tan.value = 0.006 + 0.6 * lj.key.softness * lj.key.softness
      key.shadow.radius = 1 + 3 * lj.key.softness
      if (photo) bakeEnv()
    } else {
      probe.visible = false
      key.position.set(...V1.keyPos)
      key.color.set(0xffffff)
      key.intensity = V1.key
      key.castShadow = false
      scene.environment = null // v1 uses RoomEnvironment at 0.8 here (not ported in the spike)
      iblDiffuse.value = 1
    }
    key.updateMatrixWorld()
  }

  function fitShadow(box: Box3 | null, casters: Scene): void {
    catcher.visible = !!data && !!box && !box.isEmpty()
    if (!catcher.visible || !box || !data) return
    const dir = new Vector3(...(inferredKeyWorld() ?? [0, 1, 0])).normalize()
    const c = box.getCenter(new Vector3())
    const r = Math.max(0.2, box.getBoundingSphere(new Sphere()).radius)
    const reach = (box.max.y + 0.05) / Math.max(0.08, dir.y)
    const back = r + 1
    const half = r + 0.15 + u.tan.value * Math.min(reach, 8)
    for (const cam of [key.shadow.camera, shadowCam]) {
      cam.left = -half; cam.right = half; cam.top = half; cam.bottom = -half
      cam.near = 0.01
      cam.far = back + r + reach + 0.5
      cam.updateProjectionMatrix()
    }
    key.target.position.copy(c)
    key.position.copy(c).addScaledVector(dir, back)
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
    shadowCam.position.copy(key.position)
    shadowCam.up.set(0, 1, 0)
    if (Math.abs(dir.y) > 0.999) shadowCam.up.set(0, 0, -1)
    shadowCam.lookAt(c)
    shadowCam.updateMatrixWorld()
    u.range.value = shadowCam.far - shadowCam.near
    u.width.value = 2 * half
    u.search.value = Math.min(0.25, (u.tan.value * (reach + 0.2)) / (2 * half) + 1.5 / SHADOW_SIZE)
    u.bias.value = 0.004 / u.range.value
    u.view.value.copy(shadowCam.matrixWorldInverse)
    // the casters' depth from the light (render() sets the camera's coordinate system for this backend first)
    const prev = renderer.getRenderTarget()
    const prevOverride = casters.overrideMaterial
    renderer.setRenderTarget(shadowRT)
    renderer.clear(false, true, false)
    casters.overrideMaterial = depthOnly
    renderer.render(casters, shadowCam)
    casters.overrideMaterial = prevOverride
    renderer.setRenderTarget(prev)
    u.proj.value.copy(shadowCam.projectionMatrix)
  }

  return {
    key, probe, catcher, catcherMaterial: catcherMat,
    setData(lj, m, fov) { data = lj; R = m.clone(); fovY = fov; envReady = false; apply() },
    setPhoto(t, aspect) { photo = t ? { t, aspect } : null; if (data && photo && !envReady) bakeEnv() },
    fitShadow,
    splatGain() {
      if (!data) { const V1 = { key: 1.1, hemi: 0.35, env: 0.8 }; const k = (V1.hemi + V1.env) / (V1.hemi + V1.env + 0.5 * V1.key) + (0.5 * V1.key) / (V1.hemi + V1.env + 0.5 * V1.key); return [k, k, k] }
      const wb = asV3(data.white_balance?.rgb ?? [1, 1, 1])
      return wb // level = 1 at the default Look (strength 1, ambient 1)
    },
    inferredKeyWorld,
  }
}

export { Quaternion }
