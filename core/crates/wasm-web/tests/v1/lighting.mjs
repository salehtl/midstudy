// v1's pure functions from planner/lighting.js (v1 at 0d40ff5), lifted verbatim: the reference for the differential
// tests (../diff.mjs). Each `// <<v1 …` … `// v1>>` block is v1's own text, around hand-written harnesses that supply
// the state v1 keeps; frozen since the v2 cutover (planner/*.js is gone; lift.py and v1-sync.mjs are in git history).
import * as THREE from 'three'

// <<v1 planner/lighting.js:24-33
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
// v1>>
// <<v1 planner/lighting.js:44-110
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
// v1>>
// <<v1 planner/lighting.js:149-151
const colMat = (c0, c1, c2) => new THREE.Matrix3().set(c0[0], c1[0], c2[0], c0[1], c1[1], c2[1], c0[2], c1[2], c2[2])
const ACES_IN = colMat([0.59719, 0.07600, 0.02840], [0.35458, 0.90834, 0.13383], [0.04823, 0.01566, 0.83777])
const ACES_OUT = colMat([1.60475, -0.10208, -0.00327], [-0.53108, 1.10813, -0.07276], [-0.07367, -0.00605, 1.07602])
// v1>>
// <<v1 planner/lighting.js:156-187
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
// v1>>

export { DEG, V1, lum, irrBasis, FIB, solve, ACES_IN, ACES_OUT, makeEnvBakeMat }

// splatGain() lives in createLighting's closure: the state it reads (lighting.json as `data`, the Look, R).
export function makeSplatGain({ data, look, R }) {
  let worldSH = null
  const lighting = {
    // <<v1 planner/lighting.js:468-476
    splatGain() {
      const a = look.ambient, s = look.light_strength
      if (!data) return [1, 1, 1].map(() => (V1.hemi + V1.env) * a / (V1.hemi + V1.env + 0.5 * V1.key) + 0.5 * V1.key * s / (V1.hemi + V1.env + 0.5 * V1.key))
      const wb = data.white_balance?.rgb || [1, 1, 1]
      const A = Math.max(1e-4, lum(irradianceAt(worldSH || rotateSH(data.ambient.sh, R), [0, 1, 0]))) // at the defaults
      const K = 0.5 * lum(data.key.color) * data.key.intensity
      const level = (A * a + K * s) / (A + K)
      return wb.map((v) => v * level)
    },
// v1>>
  }
  return () => lighting.splatGain()
}
