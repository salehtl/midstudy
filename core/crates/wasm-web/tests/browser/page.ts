// The TS face in a real browser (headless Chrome, run.mjs): loadKernels over fetch, a module Web Worker with
// transfers, envMapFromImage (createImageBitmap + OffscreenCanvas in the worker) against the same photo's pixels
// from a canvas, and timings of v1's JS (lifted, ../v1/) against the wasm kernels on the golden scene's files.
import * as THREE from 'three'
import * as k from '../../../../js/web.ts'
import * as V from '../v1/engine.mjs'
import { makeEnvBakeMat } from '../v1/lighting.mjs'

interface Result { name: string; ok: boolean; detail: string }
const results: Result[] = []
const check = (name: string, ok: boolean, detail = ''): void => { results.push({ name, ok, detail }) }
const ms = (t0: number): string => `${(performance.now() - t0).toFixed(1)} ms`
const sameBytes = (a: ArrayBufferView, b: ArrayBufferView): boolean => {
  const x = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), y = new Uint8Array(b.buffer, b.byteOffset, b.byteLength)
  return x.length === y.length && x.every((v, i) => v === y[i])
}

async function main(): Promise<void> {
  let t0 = performance.now()
  await k.loadKernels(new URL('/wasm/midstudy_wasm_web_bg.wasm', location.href))
  check('loadKernels (fetch, instantiateStreaming)', k.kernelsLoaded(), ms(t0))

  const truth = await (await fetch('/scenes/steep-roll/truth.json')).json()
  const cam = new k.SceneCamera(truth.camera, truth.image.w, truth.image.h)
  let worst = 0
  truth.objects.sofa.corners.forEach((c: [number, number, number], i: number) => {
    const p = cam.floorToPhoto(c), q = truth.objects.sofa.corner_px[i]
    worst = Math.max(worst, Math.abs(p[0] - q[0]), Math.abs(p[1] - q[1]))
  })
  check('steep-roll sofa corners project onto corner_px (file rounds to 1e-3)', worst <= 5e-4 + 1e-9, `worst ${worst.toExponential(2)} px`)

  const depthBytes = new Uint8Array(await (await fetch('/scenes/steep-roll/depth.png')).arrayBuffer())
  const v1 = V.makeV1({ camera: truth.camera, w: truth.image.w, h: truth.image.h })
  t0 = performance.now(); const a = await v1.loadDepth(depthBytes); const tv1 = ms(t0)
  t0 = performance.now(); const b = k.decodeDepth(depthBytes); const tk = ms(t0)
  check('decodeDepth equals v1 loadDepth bit for bit (1024x768)', a.w === b.width && sameBytes(a.data, b.data), `v1 ${tv1}, wasm ${tk}`)

  const worker = new k.KernelWorker(new Worker(new URL('./worker.js', import.meta.url), { type: 'module' }))
  const copy = depthBytes.slice().buffer
  t0 = performance.now(); const c = await worker.decodeDepth(copy)
  check('worker decodeDepth equals the main thread and detaches its input', sameBytes(b.data, c.data) && copy.byteLength === 0, `${ms(t0)} round trip (first call loads the wasm in the worker)`)
  t0 = performance.now(); await worker.decodeDepth(depthBytes.slice().buffer)
  check('worker decodeDepth, warm', true, `${ms(t0)} round trip`)

  const blob = await (await fetch('/scenes/steep-roll/photo.jpg')).blob()
  const rotation = cam.rotation()
  t0 = performance.now()
  const e1 = await worker.envMapFromImage(blob, { rotation, fov_y_deg: truth.camera.fov_y_deg }, { maxSide: 4096 })
  const tEnv = ms(t0)
  const img = new Image()
  img.src = URL.createObjectURL(blob)
  await img.decode()
  const cv = document.createElement('canvas')
  cv.width = img.naturalWidth; cv.height = img.naturalHeight
  const ctx = cv.getContext('2d')
  if (!ctx) throw new Error('no 2D context')
  ctx.drawImage(img, 0, 0)
  const px = ctx.getImageData(0, 0, cv.width, cv.height)
  t0 = performance.now()
  const e2 = k.envMap({ width: px.width, height: px.height, data: px.data }, { rotation, fov_y_deg: truth.camera.fov_y_deg })
  const tMain = ms(t0)
  let diff = 0
  const u1 = e1.data, u2 = e2.data
  for (let i = 0; i < u1.length; i++) if (u1[i] !== u2[i]) diff++
  check('envMapFromImage in the worker equals envMap of the canvas pixels (512x256 half floats)', e1.half && diff === 0, `${diff} values differ; worker (decode + map) ${tEnv}, main thread map ${tMain}`)

  // v1's own bake on the GPU (SwiftShader here): engine.js's photo texture (mipmapped, anisotropy 4) through
  // lighting.js's makeEnvBakeMat into a 512 x 256 target (float here, half in v1, to read it back), against the CPU
  // kernel's mipmapped (v1-like) and bilinear lookups.
  try {
    const renderer = new THREE.WebGLRenderer()
    const tex = new THREE.Texture(img)
    tex.flipY = false
    tex.colorSpace = THREE.NoColorSpace
    tex.minFilter = THREE.LinearMipmapLinearFilter
    tex.magFilter = THREE.LinearFilter
    tex.generateMipmaps = true
    tex.anisotropy = 4
    tex.needsUpdate = true
    const envRT = new THREE.WebGLRenderTarget(512, 256, { type: THREE.FloatType, depthBuffer: false })
    const envMat = makeEnvBakeMat()
    const envScene = new THREE.Scene()
    envScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), envMat))
    const envCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    envMat.uniforms.tPhoto.value = tex
    envMat.uniforms.uWorldToCam.value.fromArray(rotation).transpose()
    envMat.uniforms.uTanY.value = Math.tan((truth.camera.fov_y_deg * Math.PI / 180) / 2)
    envMat.uniforms.uAspect.value = px.width / px.height
    const gpu = new Float32Array(512 * 256 * 4)
    const bake = (): void => {
      renderer.setRenderTarget(envRT)
      renderer.render(envScene, envCam)
      renderer.setRenderTarget(null)
      renderer.readRenderTargetPixels(envRT, 0, 0, 512, 256, gpu)
    }
    bake()
    t0 = performance.now(); bake(); const tGpu = ms(t0)
    const cpuMip = k.envMap({ width: px.width, height: px.height, data: px.data }, { rotation, fov_y_deg: truth.camera.fov_y_deg }, { half: false })
    const cpuBil = k.envMap({ width: px.width, height: px.height, data: px.data }, { rotation, fov_y_deg: truth.camera.fov_y_deg }, { half: false, anisotropy: 0 })
    const stats = (cpu: ArrayLike<number>): string => {
      let sumAbs = 0, sumRef = 0
      const rels: number[] = []
      for (let i = 0; i < gpu.length; i++) {
        if (i % 4 === 3) continue
        const g = gpu[i] ?? 0, c = cpu[i] ?? 0
        sumAbs += Math.abs(g - c); sumRef += Math.abs(g)
        rels.push(Math.abs(g - c) / Math.max(Math.abs(g), 0.01))
      }
      rels.sort((x, y) => x - y)
      return `mean |Δ| ${(sumAbs / sumRef * 100).toFixed(2)} % of the mean, median ${(100 * (rels[rels.length >> 1] ?? 0)).toFixed(2)} %, p95 ${(100 * (rels[Math.floor(rels.length * 0.95)] ?? 0)).toFixed(1)} %`
    }
    const sMip = stats(cpuMip.data), sBil = stats(cpuBil.data)
    check('env map vs v1\'s GPU bake (SwiftShader): mipmapped CPU kernel', true, `${sMip}; GPU bake + readback ${tGpu}`)
    check('env map vs v1\'s GPU bake (SwiftShader): bilinear CPU kernel (for contrast)', true, sBil)
    renderer.dispose()
  } catch (e) {
    check('env map vs v1\'s GPU bake (SwiftShader)', false, String(e))
  }

  const [MW, MH] = [2048, 1152]
  const rb = new Uint8Array(MW * MH * 4)
  for (let y = 300; y < 800; y++) for (let x = 600; x < 1300; x++) rb[(y * MW + x) * 4] = 255
  t0 = performance.now(); const m1 = V.maskFromPixels(rb, MW, MH); const tm1 = ms(t0)
  t0 = performance.now(); const m2 = k.keepRoomMask(rb, MW, MH, { png: true }); const tm2 = ms(t0)
  check('keepRoomMask equals v1 (2048x1152) and makes a PNG', m1.coverage === m2.coverage && sameBytes(m1.on, m2.mask) && m2.png !== null, `v1 ${tm1}, wasm with PNG ${tm2}`)
  cam.dispose()
}

declare global { interface Window { __results?: Result[] } }
main().then(() => { window.__results = results }, (e: unknown) => { results.push({ name: 'page', ok: false, detail: String(e) }); window.__results = results })
