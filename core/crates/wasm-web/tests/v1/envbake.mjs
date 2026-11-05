// The environment-map bake of planner/lighting.js (makeEnvBakeMat's fragment shader, v1 at 0d40ff5) transcribed to JS
// in float64, the photo sampled bilinearly at level 0 with clamp-to-edge (the GPU sampled a mipmapped texture with
// anisotropy 4: that filtering was the GPU's, not v1's code, so the differential test compares the geometry and the
// colour maths here, and the mipmapped path is checked by its own properties). Constants as the shader writes them.
import * as THREE from 'three'
import { ACES_IN, ACES_OUT } from './lighting.mjs'

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
const step = (edge, x) => (x < edge ? 0 : 1)
const mix = (a, b, t) => a * (1 - t) + b * t
// vec3 toLinear(vec3 c) { return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c)); }
const toLinear = (c) => c.map((v) => mix(v / 12.92, Math.pow((v + 0.055) / 1.055, 2.4), step(0.04045, v)))
// vec3 acesInv(vec3 d) { … }
function acesInv(d, inInv, outInv) {
  const y = new THREE.Vector3(...d.map((v) => clamp(v, 0, 0.985))).applyMatrix3(outInv).toArray()
  const v = y.map((yy) => {
    const qa = 1.0 - 0.983729 * yy, qb = 0.0245786 - 0.4329510 * yy, qc = -(0.000090537 + 0.238081 * yy)
    return (-qb + Math.sqrt(Math.max(qb * qb - 4.0 * qa * qc, 0.0))) / (2.0 * qa)
  })
  return new THREE.Vector3(...v).applyMatrix3(inInv).toArray().map((c) => Math.max(c * 0.6, 0.0))
}
// texture2D with LINEAR filtering and CLAMP_TO_EDGE at level 0 (flipY false: t = 0 is the photo's top row).
function bilinear({ width: w, height: h, data }, s, t) {
  const x = s * w - 0.5, y = t * h - 0.5
  const x0 = Math.floor(x), y0 = Math.floor(y), fx = x - x0, fy = y - y0
  const ix = (v) => clamp(v, 0, w - 1), iy = (v) => clamp(v, 0, h - 1)
  const at = (i, j, c) => data[(iy(j) * w + ix(i)) * 4 + c]
  return [0, 1, 2].map((c) => {
    const top = at(x0, y0, c) + (at(x0 + 1, y0, c) - at(x0, y0, c)) * fx
    const bottom = at(x0, y0 + 1, c) + (at(x0 + 1, y0 + 1, c) - at(x0, y0 + 1, c)) * fx
    return (top + (bottom - top) * fy) / 255
  })
}

/** The bake into a W × H RGBA Float32Array, row j at vUv.y = (j + ½) / H (row 0 looking down). R: THREE.Matrix3. */
export function envBakeV1(photo, R, fovYDeg, W = 512, H = 256, { exactPi = false } = {}) {
  const uWorldToCam = R.clone().transpose()
  const uTanY = Math.tan((fovYDeg * Math.PI / 180) / 2)
  const uAspect = photo.width / photo.height
  const uInInv = ACES_IN.clone().invert(), uOutInv = ACES_OUT.clone().invert()
  const out = new Float32Array(W * H * 4)
  for (let j = 0; j < H; j++) {
    for (let i = 0; i < W; i++) {
      const u = (i + 0.5) / W, v = (j + 0.5) / H
      const phi = (u - 0.5) * (exactPi ? 2 * Math.PI : 6.28318531), th = (v - 0.5) * (exactPi ? Math.PI : 3.14159265)
      const c = new THREE.Vector3(Math.cos(th) * Math.cos(phi), Math.sin(th), Math.cos(th) * Math.sin(phi)).applyMatrix3(uWorldToCam)
      c.z = -Math.max(Math.abs(c.z), 1e-3)
      const nx = clamp(c.x / (-c.z) / (uTanY * uAspect), -1.0, 1.0), ny = clamp(c.y / (-c.z) / uTanY, -1.0, 1.0)
      const p = bilinear(photo, nx * 0.5 + 0.5, 0.5 - ny * 0.5)
      out.set([...acesInv(toLinear(p), uInInv, uOutInv), 1], (j * W + i) * 4)
    }
  }
  return out
}
