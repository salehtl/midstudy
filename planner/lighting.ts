// midstudy planner: the furniture's light (contract §4.8). The engine owns the Look and the scene; this module draws it.
//
// With the scene's lighting.json ("photo" mode):
//   - a LightProbe with its ambient SH turned from the camera frame to the world frame (the diffuse ambient light);
//   - an environment map for reflections only: the photo itself baked around the room (engine.passes.ts createEnvBake),
//     an SH-made one only while the photo can't be (never in practice: the photo is in before lighting.json is read).
//     The image-based diffuse term is switched off in lit materials (the MIDSTUDY_PROBE_DIFFUSE define), so the probe
//     alone gives the diffuse light and nothing is counted twice;
//   - one key DirectionalLight from the key's world direction, its colour and intensity × light_strength;
//   - its shadow on an invisible floor at y = 0 (the catcher): soft (PCSS from the key's shadow map, the penumbra
//     growing with the distance to the piece that casts it) and black with an alpha, so the photo is only darkened
//     where a piece's shadow falls. The occlusion pre-pass hides it behind real things like the furniture.
// Without lighting.json ("default" mode): the v1 lights exactly (RoomEnvironment at 0.8, the key from (−1.5, 4, 2.5)
// at 1.1, the hemisphere light at 0.35), with the same controls on them.
//
// The maths is the kernels' (core/js/web.ts: SH rotation and refit, irradiance, band scaling, the turn between two
// directions, the splats' colour level, azimuth and elevation) and planner/logic/look.ts's (the catcher's numbers). The
// environment maps are built when a frame needs them (fitShadow), once per photo and camera, not on every change.
//
// API: createLighting({ renderer, scene, photo }) → {
//   setData(lightingJson | null), setCamera(R: Matrix3 camera→world, fovY), setLook(resolved), prepare(object3d),
//   forget(object3d), fitShadow(box3 | null), inferred() → the key in the world frame or null, inUse() → the key in use,
//   mode() 'photo' | 'default', splatGain() → [r, g, b] (colour-matching splats), caster(object3d) → a shadow-only copy,
//   maskMode(on) }
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { azElOf, irradianceAt, maxBandScale, rotateSh, scaleBands, splatGain, turnBetween } from '../core/js/web.js'
import { createCatcher, createEnvBake, noRaycast } from './engine.passes.js'
import type { ScreenUniforms, Uniform } from './engine.passes.js'
import { keepPhoto, keepV1, penumbraTan, shadowFit } from './logic/look.js'
import type { InferredKey, KeyInUse, Vec3 } from './logic/look.js'
import type { JsonObject } from './logic/num.js'

const DEG = Math.PI / 180
const V1 = { key: 1.1, hemi: 0.35, env: 0.8, softness: 0.5 } as const
const V1_KEY_POS: Vec3 = [-1.5, 4, 2.5]
const v1Dir = new THREE.Vector3(V1_KEY_POS[0], V1_KEY_POS[1], V1_KEY_POS[2]).normalize()
/** v1's key light direction (towards the light, world frame) and softness: the scene's light without lighting.json. */
export const V1_KEY_DIR: Vec3 = Object.freeze([v1Dir.x, v1Dir.y, v1Dir.z])
export const V1_SOFTNESS = V1.softness

type Rgb = readonly [number, number, number]
type Sh = readonly Rgb[]

// The diffuse image-based light of lit materials can be switched off per material (the probe replaces it). Patched
// once, before any program compiles; materials without the define are exactly as before.
const IBL_LINE = 'iblIrradiance += getIBLIrradiance( geometryNormal );'
if (THREE.ShaderChunk.lights_fragment_maps.includes(IBL_LINE)) {
  THREE.ShaderChunk.lights_fragment_maps = THREE.ShaderChunk.lights_fragment_maps.replace(IBL_LINE,
    `#ifndef MIDSTUDY_PROBE_DIFFUSE\n\t\t${IBL_LINE}\n\t\t#endif`)
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
function shEquirect(sh: Sh, w = 64, h = 32): THREE.DataTexture {
  const S = new THREE.SphericalHarmonics3()
  sh.forEach((c, i) => { S.coefficients[i]?.set(c[0], c[1], c[2]) })
  const data = new Float32Array(w * h * 4)
  const v = new THREE.Vector3()
  const out = new THREE.Vector3()
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
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat, THREE.FloatType)
  tex.mapping = THREE.EquirectangularReflectionMapping
  tex.colorSpace = THREE.LinearSRGBColorSpace
  tex.magFilter = THREE.LinearFilter
  tex.needsUpdate = true
  return tex
}

// A splat item's GLB or stand-in box is invisible (Spark draws the splat): this copy of it draws nothing in the
// furniture pass (no colour, no depth) but casts its shadow, since the shadow pass draws every visible caster.
const casterMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })

/** The look as the lights take it: the engine's resolved Look (logic/look.ts resolveLook). */
export interface LightLook {
  readonly light_strength: number
  readonly ambient: number
  readonly cast_shadows: boolean
  readonly light_softness: number
  readonly dir: Vec3
}

/** Measures one step as `midstudy:<step>` (E17 reads them). */
function measure(step: string, t0: number): void {
  try { performance.measure(`midstudy:${step}`, { start: t0, end: performance.now() }) } catch { /* no User Timing */ }
}

export function createLighting({ renderer, scene, photo }: { renderer: THREE.WebGLRenderer; scene: THREE.Scene; photo: { tPhoto: Uniform<THREE.Texture | null>; screen: ScreenUniforms } }) {
  const catcher = createCatcher(photo.tPhoto, photo.screen)
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  const pmrem = new THREE.PMREMGenerator(renderer)
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  let shEnv: THREE.WebGLRenderTarget | null = null

  const key = new THREE.DirectionalLight(0xffffff, V1.key)
  key.position.set(V1_KEY_POS[0], V1_KEY_POS[1], V1_KEY_POS[2])
  key.shadow.mapSize.set(2048, 2048)
  key.shadow.bias = -0.0004
  key.shadow.normalBias = 0.01
  key.castShadow = false
  const hemi = new THREE.HemisphereLight(0xffffff, 0x8a7a66, V1.hemi)
  const probe = new THREE.LightProbe()
  probe.visible = false
  scene.add(key, key.target, hemi, probe)
  scene.environment = roomEnv
  scene.environmentIntensity = V1.env

  const catcherMesh = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), catcher.material)
  catcherMesh.name = 'shadow-catcher'
  catcherMesh.renderOrder = 1
  catcherMesh.raycast = noRaycast
  catcherMesh.visible = false
  catcherMesh.frustumCulled = false
  catcherMesh.onBeforeRender = () => {
    catcher.tShadow.value = key.shadow.map?.texture ?? null
    catcher.uShadowMatrix.value.copy(key.shadow.matrix)
  }
  scene.add(catcherMesh)

  let data: LightData | null = null // lighting.json
  let R = new THREE.Matrix3()
  let fovY = 55
  let worldSH: Sh | null = null // lighting.json's ambient in the world frame
  let turned: { key: string; sh: Sh } | null = null // worldSH turned with the light when its direction is changed
  let effSH: Sh | null = null // the ambient in use: turned, its directional part scaled by Strength
  let camVersion = 0

  const envBake = createEnvBake()
  let photoEnv: THREE.WebGLRenderTarget | null = null
  let photoEnvKey = ''
  // The reflections from the photo, baked again when the photo or the camera changes (null until the photo is in).
  function ensurePhotoEnv(): THREE.Texture | null {
    const tex = photo.tPhoto.value
    const img: unknown = tex?.image
    const size = img instanceof HTMLImageElement ? [img.naturalWidth || img.width, img.naturalHeight || img.height] : [0, 0]
    const w = size[0] ?? 0
    const h = size[1] ?? 0
    if (!data || !tex || !w || !h) return null
    const k = `${tex.uuid}|${String(camVersion)}|${String(w)}x${String(h)}`
    if (k === photoEnvKey && photoEnv) return photoEnv.texture
    const t0 = performance.now()
    envBake.tPhoto.value = tex
    envBake.uWorldToCam.value.copy(R).transpose()
    envBake.uTanY.value = Math.tan((fovY * DEG) / 2)
    envBake.uAspect.value = w / h
    envBake.render(renderer)
    photoEnv?.dispose()
    photoEnv = pmrem.fromEquirectangular(envBake.target.texture)
    photoEnvKey = k
    measure('envmap', t0)
    return photoEnv.texture
  }
  // The SH-made map: only while the photo's can't be made.
  function ensureShEnv(sh: Sh): THREE.Texture {
    if (!shEnv) {
      const eq = shEquirect(sh)
      shEnv = pmrem.fromEquirectangular(eq)
      eq.dispose()
    }
    return shEnv.texture
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
  const prepared = new Set<THREE.Object3D>() // the items' roots, to switch their materials' define when the mode changes
  const mode = (): 'photo' | 'default' => (data ? 'photo' : 'default')

  // lighting.json's key turned to the world frame (R · direction, normalized).
  function keyWorld(d: LightData): Vec3 {
    const v = new THREE.Vector3(d.direction[0], d.direction[1], d.direction[2]).applyMatrix3(R).normalize()
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

  function setMaterials(root: THREE.Object3D): void {
    const on = !!data
    const placeholder = root.name === 'missing-item' // a layout's piece the library lacks: outlined, casts nothing
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh) || o.name === 'contact-shadow') return
      const mat: unknown = o.material
      // v1 read these off `o.material` as is: an array of materials counts as lit and visible
      const lit = Array.isArray(mat) || (mat instanceof THREE.Material && !(mat instanceof THREE.MeshBasicMaterial) && !(mat instanceof THREE.ShaderMaterial))
      o.castShadow = !placeholder && !(mat instanceof THREE.Material && !mat.visible)
      o.receiveShadow = lit && !placeholder
      const mats: unknown[] = Array.isArray(mat) ? mat : [mat]
      for (const m of mats) {
        if (!(m instanceof THREE.MeshStandardMaterial)) continue // MeshPhysicalMaterial is one too
        // `defines` is three's (MeshStandardMaterial sets { STANDARD: '' }); @types/three declares it on ShaderMaterial only
        const d: unknown = Reflect.get(m, 'defines')
        const defines: Readonly<Record<string, unknown>> = typeof d === 'object' && d !== null ? Object.fromEntries(Object.entries(d)) : {}
        const has = typeof d === 'object' && d !== null && 'MIDSTUDY_PROBE_DIFFUSE' in d
        if (has === on) continue
        Reflect.set(m, 'defines', on ? { ...defines, MIDSTUDY_PROBE_DIFFUSE: '' } : Object.fromEntries(Object.entries(defines).filter(([k]) => k !== 'MIDSTUDY_PROBE_DIFFUSE')))
        m.needsUpdate = true
      }
    })
  }
  function prepare(root: THREE.Object3D): void { prepared.add(root); setMaterials(root) }
  function forget(root: THREE.Object3D): void { prepared.delete(root) }

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
      if (new THREE.Vector3(inf[0], inf[1], inf[2]).angleTo(new THREE.Vector3(look.dir[0], look.dir[1], look.dir[2])) > 0.002) {
        const tk = look.dir.map((v) => v.toFixed(5)).join()
        if (turned?.key !== tk) turned = { key: tk, sh: rotateSh(worldSH, turnBetween(inf, look.dir)) }
        sh = turned.sh
      }
      const eff = scaleBands(sh, Math.min(s, maxBandScale(sh)))
      effSH = eff
      eff.forEach((c, i) => { probe.sh.coefficients[i]?.set(c[0], c[1], c[2]) })
      probe.intensity = a
      hemi.visible = false
      key.color.setRGB(data.color[0], data.color[1], data.color[2], THREE.LinearSRGBColorSpace)
      key.intensity = data.intensity * s
      scene.environmentIntensity = a // reflections: the photo itself once it is in (syncEnv, before the next frame)
    } else {
      effSH = null
      probe.visible = false
      hemi.visible = true
      hemi.intensity = V1.hemi * a
      key.color.set(0xffffff)
      key.intensity = V1.key * s
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
      catcher.uKeep.value.set(keep[0], keep[1], keep[2])
    } else {
      const k = keepV1(a, s, ly)
      catcher.uKeep.value.set(k, k, k)
    }
    catcher.uTan.value = penumbraTan(look.light_softness)
  }

  // The key's shadow camera around the pieces (box3 in the world frame, or null): an orthographic box looking along
  // the light, wide enough for the pieces and deep enough to reach the floor behind them.
  const sc = key.shadow.camera
  const tmp = new THREE.Vector3()
  function fitShadow(box: THREE.Box3 | null): void {
    syncEnv() // every frame: cheap unless the photo or the camera changed
    catcherMesh.visible = key.castShadow && !!box && !box.isEmpty() // no pieces: no shadow map to read
    if (!catcherMesh.visible || !box) return
    const c = box.getCenter(new THREE.Vector3())
    const radius = box.getBoundingSphere(new THREE.Sphere()).radius
    const d = tmp.set(look.dir[0], look.dir[1], look.dir[2]).normalize()
    const f = shadowFit(radius, box.max.y, d.y, catcher.uTan.value)
    key.target.position.copy(c)
    key.position.copy(c).addScaledVector(d, f.back)
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
    sc.left = -f.half; sc.right = f.half; sc.top = f.half; sc.bottom = -f.half
    sc.near = f.near
    sc.far = f.far
    sc.updateProjectionMatrix()
    catcher.uRange.value = f.range
    catcher.uWidth.value = f.width
    catcher.uSearch.value = f.search
    catcher.uBias.value = f.bias
  }

  return {
    key, probe, hemi, catcher: catcherMesh,
    mode, inferred, inUse, prepare, forget, fitShadow,
    /** The keep-room mask takes in the cast shadow (§4.7). */
    maskMode(on: boolean): void { catcher.uMask.value = on ? 1 : 0 },
    setData(lj: JsonObject | null): void {
      data = lightData(lj)
      worldSH = null
      turned = null
      dropShEnv()
      photoEnvKey = ''
      for (const r of prepared) setMaterials(r)
      apply()
    },
    setCamera(m: THREE.Matrix3, fovYDeg: number): void {
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
    caster(root: THREE.Object3D): THREE.Object3D {
      const c = root.clone(true)
      c.name = 'shadow-caster'
      c.traverse((o) => {
        o.visible = true
        o.raycast = noRaycast
        if (o instanceof THREE.Mesh) { o.material = casterMat; o.castShadow = true; o.receiveShadow = false }
      })
      return c
    },
  }
}

