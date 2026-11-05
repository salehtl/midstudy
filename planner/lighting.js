// midstudy planner: the furniture's light (contract §4.8). The engine owns the Look and the scene; this module draws it.
//
// With the scene's lighting.json ("photo" mode):
//   - a LightProbe with its ambient SH turned from the camera frame to the world frame (the diffuse ambient light);
//   - an environment map made from the same SH, for reflections only: the image-based diffuse term is switched off
//     in lit materials (the MIDSTUDY_PROBE_DIFFUSE define), so the probe alone gives the diffuse light and nothing is
//     counted twice;
//   - one key DirectionalLight from the key's world direction, its colour and intensity × light_strength;
//   - its shadow on an invisible floor at y = 0 (the catcher): soft (PCSS from the key's shadow map, the penumbra
//     growing with the distance to the piece that casts it) and black with an alpha, so the photo is only darkened
//     where a piece's shadow falls. The occlusion pre-pass hides it behind real things like the furniture.
// Without lighting.json ("default" mode): the v1 lights exactly (RoomEnvironment at 0.8, the key from (−1.5, 4, 2.5)
// at 1.1, the hemisphere light at 0.35), with the same controls on them.
//
// API: createLighting({ renderer, scene }) → {
//   setData(lightingJson | null), setCamera(R: Matrix3 camera→world), setLook(resolved), prepare(object3d),
//   fitShadow(box3 | null), inferred() → the key in the world frame or null, inUse() → the key in use,
//   mode() 'photo' | 'default', splatGain() → [r, g, b] (colour-matching splats), caster(object3d) → a shadow-only copy }
// resolved look: { auto_light, light_azimuth_deg, light_elevation_deg, light_softness, light_strength, ambient,
//                  cast_shadows (boolean) } with the direction and softness already chosen (inferred or stored).
import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'

const DEG = Math.PI / 180
const V1 = { key: 1.1, hemi: 0.35, env: 0.8, softness: 0.5, keyPos: [-1.5, 4, 2.5] }
export const V1_KEY_DIR = Object.freeze(new THREE.Vector3(...V1.keyPos).normalize().toArray())
export const V1_SOFTNESS = V1.softness
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
// azimuth: 0 = the light is straight ahead (−Z, the far side of the photo), 90 = on the right (+X); elevation above
// the floor's horizon. Both in degrees, world frame (§4.8).
export const azElOf = (d) => ({ azimuth_deg: Math.atan2(d[0], -d[2]) / DEG, elevation_deg: Math.asin(clamp(d[1], -1, 1)) / DEG })
export const dirOf = (az, el) => [Math.cos(el * DEG) * Math.sin(az * DEG), Math.sin(el * DEG), -Math.cos(el * DEG) * Math.cos(az * DEG)]

// The diffuse image-based light of lit materials can be switched off per material (the probe replaces it). Patched
// once, before any program compiles; materials without the define are exactly as before.
const IBL_LINE = 'iblIrradiance += getIBLIrradiance( geometryNormal );'
if (THREE.ShaderChunk.lights_fragment_maps.includes(IBL_LINE)) {
  THREE.ShaderChunk.lights_fragment_maps = THREE.ShaderChunk.lights_fragment_maps.replace(IBL_LINE,
    `#ifndef MIDSTUDY_PROBE_DIFFUSE\n\t\t${IBL_LINE}\n\t\t#endif`)
}

// shGetIrradianceAt's basis (three.js 0.180), in SphericalHarmonics3 order.
function irrBasis(x, y, z) {
  return [0.886227, 1.023328 * y, 1.023328 * z, 1.023328 * x, 0.858086 * x * y, 0.858086 * y * z, 0.743125 * z * z - 0.247708, 0.858086 * x * z, 0.429043 * (x * x - y * y)]
}
const FIB = (() => {
  const out = []
  const n = 96
  for (let i = 0; i < n; i++) {
    const y = 1 - (2 * (i + 0.5)) / n
    const r = Math.sqrt(1 - y * y)
    const a = i * Math.PI * (3 - Math.sqrt(5))
    out.push([Math.cos(a) * r, y, Math.sin(a) * r])
  }
  return out
})()
function solve(A, b) { // Gaussian elimination with partial pivoting, A n×n (copied)
  const n = b.length
  const M = A.map((row, i) => [...row, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    ;[M[c], M[p]] = [M[p], M[c]]
    const d = M[c][c] || 1e-12
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = M[r][c] / d
      if (f) for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  return M.map((row, i) => row[n] / (M[i][i] || 1e-12))
}
// The probe's coefficients turned from the camera frame to the world frame: evaluate the camera-frame irradiance at
// fixed world directions (each turned back with Rᵀ) and refit. Exact for any SH up to band 2 (bands don't mix).
export function rotateSH(sh, R) {
  const e = R.elements // column-major 3×3: world = R · cam, so cam = Rᵀ · world
  const toCam = ([x, y, z]) => [e[0] * x + e[1] * y + e[2] * z, e[3] * x + e[4] * y + e[5] * z, e[6] * x + e[7] * y + e[8] * z]
  const rows = FIB.map((d) => irrBasis(...d))
  const AtA = Array.from({ length: 9 }, (_, i) => Array.from({ length: 9 }, (_, j) => rows.reduce((s, r) => s + r[i] * r[j], 0)))
  const out = Array.from({ length: 9 }, () => [0, 0, 0])
  for (let ch = 0; ch < 3; ch++) {
    const t = FIB.map((d) => { const b = irrBasis(...toCam(d)); return b.reduce((s, v, i) => s + v * sh[i][ch], 0) })
    const Atb = Array.from({ length: 9 }, (_, i) => rows.reduce((s, r, k) => s + r[i] * t[k], 0))
    solve(AtA, Atb).forEach((v, i) => { out[i][ch] = v })
  }
  return out
}
export function irradianceAt(sh, [x, y, z]) {
  const b = irrBasis(x, y, z)
  return [0, 1, 2].map((ch) => b.reduce((s, v, i) => s + v * sh[i][ch], 0))
}
// The SH with its directional part (bands 1–2) scaled by k; band 0 (the same light from everywhere) kept.
export const scaleBands = (sh, k) => sh.map((c, i) => (i === 0 ? [...c] : c.map((v) => v * k)))
// The largest k for scaleBands that keeps the irradiance in every direction at ≥ 5 % of band 0's (luminance), so a
// strong Strength never makes the side away from the light go black or negative.
export function maxBandScale(sh) {
  const dc = lum(irradianceAt(scaleBands(sh, 0), [0, 1, 0]))
  let k = Infinity
  for (const d of FIB) {
    const e1 = lum(irradianceAt(sh, d)) - dc
    if (e1 < -1e-9) k = Math.min(k, (0.95 * dc) / -e1)
  }
  return k
}
// The rotation (Matrix3) that takes unit direction a to unit direction b, the shortest way.
export function turnBetween(a, b) {
  const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...a).normalize(), new THREE.Vector3(...b).normalize())
  return new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(q))
}

// The radiance the SH describes, as a small equirectangular image (three.js's equirect convention), for the
// reflections' environment map. Negative lobes are clipped at 0.
function shEquirect(sh, w = 64, h = 32) {
  const S = new THREE.SphericalHarmonics3()
  sh.forEach((c, i) => S.coefficients[i].set(c[0], c[1], c[2]))
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

// The floor catcher: the key's shadow on y = 0 as black with an alpha (PCSS: blocker search, then a filter whose
// width grows with the distance from the blocker, so the shadow is sharp where a leg meets the floor and soft away).
const POISSON = [[-0.94201624, -0.39906216], [0.94558609, -0.76890725], [-0.094184101, -0.92938870], [0.34495938, 0.29387760],
  [-0.91588581, 0.45771432], [-0.81544232, -0.87912464], [-0.38277543, 0.27676845], [0.97484398, 0.75648379],
  [0.44323325, -0.97511554], [0.53742981, -0.47373420], [-0.26496911, -0.41893023], [0.79197514, 0.19090188],
  [-0.24188840, 0.99706507], [-0.81409955, 0.91437590], [0.19984126, 0.78641367], [0.14383161, -0.14100790]]
// A splat item's GLB or stand-in box is invisible (Spark draws the splat): this copy of it draws nothing in the
// furniture pass (no colour, no depth) but casts its shadow, since the shadow pass draws every visible caster.
const casterMat = new THREE.MeshBasicMaterial({ colorWrite: false, depthWrite: false })
// three.js's ACES Filmic (the furniture's tone curve, and the one lighting.json's fit took the photo back through), as
// its two matrices and their inverses, for the catcher to work on the photo's pixels in radiance.
const colMat = (c0, c1, c2) => new THREE.Matrix3().set(c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2])
const ACES_IN = colMat([0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777])
const ACES_OUT = colMat([1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602])
// The photo as an environment map for reflections (§4.8): every direction around the room, turned into the camera's
// frame and projected into the photo (directions behind the camera see the front mirrored, directions past the
// frame's edge its nearest edge), its pixel taken back to radiance the way lighting.json's fit did (sRGB → linear,
// ACES undone). Metals then reflect the room itself; PMREM blurs it for rough materials.
function makeEnvBakeMat() {
  return new THREE.ShaderMaterial({
    uniforms: {
      tPhoto: { value: null }, uWorldToCam: { value: new THREE.Matrix3() }, uTanY: { value: 0.5 }, uAspect: { value: 1.5 },
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
}

function makeCatcherMat({ photoUv, photoUniforms }) {
  return new THREE.ShaderMaterial({
    uniforms: {
      ...photoUniforms, // tPhoto (the photo's sRGB bytes), uRect, uTarget: shared with the engine's photo pass
      tShadow: { value: null }, uShadowMatrix: { value: new THREE.Matrix4() }, uKeep: { value: new THREE.Vector3(1, 1, 1) }, uTan: { value: 0.05 },
      uRange: { value: 10 }, uWidth: { value: 4 }, uSearch: { value: 0.02 }, uBias: { value: 0.002 }, uMask: { value: 0 },
      uIn: { value: ACES_IN }, uOut: { value: ACES_OUT }, uInInv: { value: ACES_IN.clone().invert() }, uOutInv: { value: ACES_OUT.clone().invert() },
    },
    vertexShader: 'varying vec3 vWorld;\nvoid main() { vec4 w = modelMatrix * vec4(position, 1.0); vWorld = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }',
    fragmentShader: `
#include <packing>
${photoUv}
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
const vec2 P[16] = vec2[16](${POISSON.map(([a, b]) => `vec2(${a}, ${b})`).join(', ')});
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
  float pen = max((z - blocker) * uRange * uTan * 2.0 / uWidth, 0.6 / ${2048}.0);
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
}

export function createLighting({ renderer, scene, photoUv, photoUniforms }) {
  const catcherMat = makeCatcherMat({ photoUv, photoUniforms })
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFShadowMap
  const pmrem = new THREE.PMREMGenerator(renderer)
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
  let shEnv = null

  const key = new THREE.DirectionalLight(0xffffff, V1.key)
  key.position.set(...V1.keyPos)
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

  const catcher = new THREE.Mesh(new THREE.PlaneGeometry(60, 60).rotateX(-Math.PI / 2), catcherMat)
  catcher.name = 'shadow-catcher'
  catcher.renderOrder = 1
  catcher.raycast = () => {}
  catcher.visible = false
  catcher.frustumCulled = false
  catcher.onBeforeRender = () => {
    catcherMat.uniforms.tShadow.value = key.shadow.map?.texture ?? null
    catcherMat.uniforms.uShadowMatrix.value.copy(key.shadow.matrix)
  }
  scene.add(catcher)

  let data = null          // lighting.json
  let R = new THREE.Matrix3()
  let fovY = 55
  let worldSH = null       // lighting.json's ambient in the world frame
  let turned = null        // { key, sh }: worldSH turned with the light when its direction is changed
  let effSH = null         // the ambient in use: turned, its directional part scaled by Strength
  let camVersion = 0

  const envRT = new THREE.WebGLRenderTarget(512, 256, { type: THREE.HalfFloatType, depthBuffer: false })
  envRT.texture.mapping = THREE.EquirectangularReflectionMapping
  envRT.texture.colorSpace = THREE.LinearSRGBColorSpace
  const envMat = makeEnvBakeMat()
  const envScene = new THREE.Scene()
  envScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), envMat))
  const envCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  let photoEnv = null
  let photoEnvKey = ''
  // The reflections from the photo, baked again when the photo or the camera changes (null until the photo is in).
  function ensurePhotoEnv() {
    const tex = photoUniforms?.tPhoto?.value
    const img = tex?.image
    const w = img?.naturalWidth || img?.width, h = img?.naturalHeight || img?.height
    if (!data || !tex || !w || !h) return null
    const k = `${tex.uuid}|${camVersion}|${w}x${h}`
    if (k === photoEnvKey) return photoEnv
    envMat.uniforms.tPhoto.value = tex
    envMat.uniforms.uWorldToCam.value.copy(R).transpose()
    envMat.uniforms.uTanY.value = Math.tan((fovY * DEG) / 2)
    envMat.uniforms.uAspect.value = w / h
    const prev = renderer.getRenderTarget()
    renderer.setRenderTarget(envRT)
    renderer.render(envScene, envCam)
    renderer.setRenderTarget(prev)
    photoEnv?.dispose?.()
    photoEnv = pmrem.fromEquirectangular(envRT.texture).texture
    photoEnvKey = k
    return photoEnv
  }
  let look = { light_strength: 1, ambient: 1, cast_shadows: false, light_softness: V1.softness, dir: [...V1_KEY_DIR] }
  const prepared = new Set() // the items' roots, to switch their materials' define when the mode changes
  const mode = () => (data ? 'photo' : 'default')

  function inferred() {
    if (!data) return null
    const d = new THREE.Vector3(...data.key.direction).applyMatrix3(R).normalize().toArray()
    return { ...azElOf(d), softness: data.key.softness, direction: d, color: [...data.key.color], intensity: data.key.intensity, cct_k: data.white_balance?.cct_k ?? null }
  }
  function inUse() {
    const color = data ? [...data.key.color] : [1, 1, 1]
    const base = data ? data.key.intensity : V1.key
    return { ...azElOf(look.dir), direction: [...look.dir], color, intensity: base * look.light_strength, softness: look.light_softness }
  }

  function setMaterials(root) {
    const on = !!data
    const placeholder = root.name === 'missing-item' // a layout's piece the library lacks: outlined, casts nothing
    root.traverse((o) => {
      if (!o.isMesh || o.name === 'contact-shadow') return
      const lit = !!o.material && !o.material.isMeshBasicMaterial && !o.material.isShaderMaterial
      o.castShadow = !placeholder && o.material?.visible !== false
      o.receiveShadow = lit && !placeholder
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (!m || !(m.isMeshStandardMaterial || m.isMeshPhysicalMaterial)) continue
        const has = !!m.defines && 'MIDSTUDY_PROBE_DIFFUSE' in m.defines
        if (has === on) continue
        if (on) m.defines = { ...(m.defines || {}), MIDSTUDY_PROBE_DIFFUSE: '' }
        else { const { MIDSTUDY_PROBE_DIFFUSE, ...rest } = m.defines; m.defines = rest }
        m.needsUpdate = true
      }
    })
  }
  function prepare(root) { prepared.add(root); setMaterials(root) }
  function forget(root) { prepared.delete(root) }

  function apply() {
    const s = look.light_strength
    const a = look.ambient
    key.position.set(...look.dir).multiplyScalar(10)
    key.target.position.set(0, 0, 0)
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
    if (data) {
      probe.visible = true
      worldSH = worldSH || rotateSH(data.ambient.sh, R)
      // The controls act on the whole directional light, not only the key: a new direction turns the ambient's
      // directional part with the key (so the room's light really moves), and Strength scales that part with the key
      // (so a soft, mostly-ambient room still responds). At the inferred direction and Strength 1 it is lighting.json.
      const inf = new THREE.Vector3(...data.key.direction).applyMatrix3(R).normalize().toArray()
      let sh = worldSH
      if (new THREE.Vector3(...inf).angleTo(new THREE.Vector3(...look.dir)) > 0.002) {
        const tk = look.dir.map((v) => v.toFixed(5)).join()
        if (turned?.key !== tk) turned = { key: tk, sh: rotateSH(worldSH, turnBetween(inf, look.dir)) }
        sh = turned.sh
      }
      effSH = scaleBands(sh, Math.min(s, maxBandScale(sh)))
      effSH.forEach((c, i) => probe.sh.coefficients[i].set(c[0], c[1], c[2]))
      probe.intensity = a
      hemi.visible = false
      key.color.setRGB(...data.key.color, THREE.LinearSRGBColorSpace)
      key.intensity = data.key.intensity * s
      if (!shEnv) shEnv = pmrem.fromEquirectangular(shEquirect(worldSH)).texture
      scene.environment = ensurePhotoEnv() || shEnv // reflections: the photo itself once it is in, else the SH
      scene.environmentIntensity = a
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
    const shadows = !!look.cast_shadows && s > 0
    key.castShadow = shadows
    key.shadow.radius = 1 + 3 * look.light_softness
    if (!shadows) catcher.visible = false // fitShadow turns it on before a frame with pieces
    // What a full shadow keeps of the floor's light, per channel: ambient / (ambient + key) on an up-facing floor (with
    // lighting.json from its SH and key, so a shadow under a warm sun is cooler; with the v1 lights about half).
    const ly = Math.max(0, look.dir[1])
    const keep = catcherMat.uniforms.uKeep.value
    if (data) {
      // A piece blocks the key and the ambient's directional part (bands 1–2: the room's light from above, the windows,
      // the ceiling lights), not its even part (band 0), so a soft room still shows a shadow under a piece.
      const amb = irradianceAt(effSH, [0, 1, 0])
      const even = irradianceAt(scaleBands(effSH, 0), [0, 1, 0])
      keep.set(...[0, 1, 2].map((c) => { const T = Math.max(1e-4, amb[c] * a + data.key.color[c] * data.key.intensity * s * ly); return clamp(Math.min(even[c] * a, amb[c] * a) / T, 0.08, 1) }))
    } else { const k = clamp((0.45 * a) / (0.45 * a + 0.55 * s * ly + 1e-6), 0.08, 1); keep.set(k, k, k) }
    catcherMat.uniforms.uTan.value = 0.006 + 0.6 * look.light_softness * look.light_softness
  }

  // The key's shadow camera around the pieces (box3 in the world frame, or null): an orthographic box looking along
  // the light, wide enough for the pieces and deep enough to reach the floor behind them.
  const sc = key.shadow.camera
  const tmp = new THREE.Vector3()
  function fitShadow(box) {
    if (data) { const pe = ensurePhotoEnv(); if (pe && scene.environment !== pe) scene.environment = pe } // every frame: cheap unless changed
    catcher.visible = key.castShadow && !!box && !box.isEmpty() // no pieces: no shadow map to read
    if (!catcher.visible) return
    const c = box.getCenter(new THREE.Vector3())
    const r = Math.max(0.2, box.getBoundingSphere(new THREE.Sphere()).radius)
    const d = tmp.set(...look.dir).normalize()
    const reach = (box.max.y + 0.05) / Math.max(0.08, d.y)
    const back = r + 1
    key.target.position.copy(c)
    key.position.copy(c).addScaledVector(d, back)
    key.updateMatrixWorld()
    key.target.updateMatrixWorld()
    const half = r + 0.15 + catcherMat.uniforms.uTan.value * Math.min(reach, 8) // room for the penumbra
    sc.left = -half; sc.right = half; sc.top = half; sc.bottom = -half
    sc.near = 0.01
    sc.far = back + r + reach + 0.5
    sc.updateProjectionMatrix()
    const u = catcherMat.uniforms
    u.uRange.value = sc.far - sc.near
    u.uWidth.value = 2 * half
    u.uSearch.value = Math.min(0.25, (u.uTan.value * (reach + 0.2)) / (2 * half) + 1.5 / 2048)
    u.uBias.value = 0.004 / u.uRange.value
  }

  return {
    key, probe, hemi, catcher,
    mode, inferred, inUse, prepare, forget, fitShadow,
    maskMode(on) { catcherMat.uniforms.uMask.value = on ? 1 : 0 }, // the keep-room mask takes in the cast shadow (§4.7)
    setData(lj) {
      data = lj && Array.isArray(lj.ambient?.sh) && lj.ambient.sh.length === 9 && Array.isArray(lj.key?.direction) ? lj : null
      worldSH = null
      turned = null
      shEnv?.dispose?.()
      shEnv = null
      photoEnvKey = ''
      for (const r of prepared) setMaterials(r)
      apply()
    },
    setCamera(m, fovYDeg) { R = m.clone(); if (fovYDeg) fovY = fovYDeg; camVersion++; worldSH = null; turned = null; shEnv?.dispose?.(); shEnv = null; apply() },
    setLook(l) { look = { ...look, ...l, dir: l.dir ? [...l.dir] : look.dir }; apply() },
    // Splats carry their source photo's light, so they are colour-matched, not lit (§4.8): the room light's colour
    // (white_balance, luminance 1) times how much of the room's light the controls keep (1 at the defaults: ambient
    // and key weighted by how they light an upright surface on average). No directional term.
    splatGain() {
      const a = look.ambient, s = look.light_strength
      if (!data) return [1, 1, 1].map(() => (V1.hemi + V1.env) * a / (V1.hemi + V1.env + 0.5 * V1.key) + 0.5 * V1.key * s / (V1.hemi + V1.env + 0.5 * V1.key))
      const wb = data.white_balance?.rgb || [1, 1, 1]
      const A = Math.max(1e-4, lum(irradianceAt(worldSH || rotateSH(data.ambient.sh, R), [0, 1, 0]))) // at the defaults
      const K = 0.5 * lum(data.key.color) * data.key.intensity
      const level = (A * a + K * s) / (A + K)
      return wb.map((v) => v * level)
    },
    caster(root) {
      const c = root.clone(true)
      c.name = 'shadow-caster'
      c.traverse((o) => {
        o.visible = true
        o.raycast = () => {}
        if (o.isMesh) { o.material = casterMat; o.castShadow = true; o.receiveShadow = false }
      })
      return c
    },
  }
}
