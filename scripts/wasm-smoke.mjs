#!/usr/bin/env node
// Smoke test of the official wasm builds through their typed faces (gate-1, docs/notes/gate-1.md):
// core/js/node.ts on build/wasm/node/ and core/js/web.ts on build/wasm/web/, in Node, then web.ts again in headless
// Chrome ($PUPPETEER_EXECUTABLE_PATH, the harness's flags), bundled by esbuild into evals/out/wasm-smoke/. Chrome's
// numbers must equal Node's (same wasm). Also reports whether the page gets a WebGPU adapter with those flags.
// Needs `npm run build` first. Usage: nix develop -c node scripts/wasm-smoke.mjs [--no-browser]
// Prints one PASS/FAIL line per check; exit 1 on any FAIL.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '..')
const SCENE = path.join(ROOT, 'fixtures/scenes/living-wide')
const WEB_WASM = path.join(ROOT, 'build/wasm/web/midstudy_wasm_web_bg.wasm')
let failed = 0
const check = (name, ok, detail = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

// --- core/js/node.ts (media kernels, build/wasm/node) ------------------------------------------------------------------
const media = await import('../core/js/node.ts')
const photo = new Uint8Array(fs.readFileSync(path.join(SCENE, 'photo.jpg')))
// The golden photo with an APP1 "Exif" segment planted after SOI: stripJpeg must give back the photo exactly.
const canary = Buffer.from('Exif\0\0midstudy-smoke-canary', 'latin1')
const app1 = Buffer.from([0xff, 0xe1, (canary.length + 2) >> 8, (canary.length + 2) & 0xff])
const dirty = new Uint8Array(Buffer.concat([photo.subarray(0, 2), app1, canary, photo.subarray(2)]))
check('node.ts loads build/wasm/node', fs.existsSync(media.WASM_MODULE), media.WASM_MODULE.replace(`${ROOT}/`, ''))
check('node.ts sniff', media.sniff(dirty) === 'jpeg' && media.photoExt('jpeg') === 'jpg')
check('node.ts jpegIsClean', media.jpegIsClean(photo) && !media.jpegIsClean(dirty))
const stripped = media.stripJpeg(dirty)
check('node.ts stripJpeg', stripped.ok && stripped.value.removed.appSegments === 1 && Buffer.compare(stripped.value.bytes, photo) === 0,
  stripped.ok ? `removed ${JSON.stringify(stripped.value.removed)}` : stripped.error.code)
const frame = media.jpegFrame(photo)
check('node.ts jpegFrame', frame.ok && frame.value.width === 1600 && frame.value.height === 1200, frame.ok ? `${frame.value.width}×${frame.value.height}` : frame.error.code)
check('node.ts slugs and paths', media.isSlug('living-wide') && !media.isSlug('Living') && media.normalizePath('/planner/a/../b.js') === '/planner/b.js')

// --- core/js/web.ts (geometry and raster kernels, build/wasm/web) ------------------------------------------------------
const truth = JSON.parse(fs.readFileSync(path.join(SCENE, 'truth.json'), 'utf8'))
const depthPng = new Uint8Array(fs.readFileSync(path.join(SCENE, 'depth.png')))
const corners = Object.values(truth.objects).flatMap((o) => o.corners)
const cornerPx = Object.values(truth.objects).flatMap((o) => o.corner_px)
// What both runtimes compute: every truth corner projected, and depth.png decoded (size and the sum of its metres).
function measure(k, png) {
  const cam = new k.SceneCamera(truth.camera, truth.image.w, truth.image.h)
  const px = corners.map((c) => cam.floorToPhoto(c))
  const floor = cam.photoToFloor(800, 1100)
  cam.dispose()
  const d = k.decodeDepth(png)
  let sum = 0
  for (const v of d.data) sum += v
  return { px, floor, depth: { width: d.width, height: d.height, sum }, clamp: k.clampCamera({ fov_y_deg: 500 }).fov_y_deg }
}
const web = await import('../core/js/web.ts')
web.loadKernelsSync(fs.readFileSync(WEB_WASM))
check('web.ts loads build/wasm/web (Node)', web.kernelsLoaded())
const inNode = measure(web, depthPng)
const worst = Math.max(...inNode.px.map(([x, y], i) => Math.hypot(x - cornerPx[i][0], y - cornerPx[i][1])))
check('web.ts SceneCamera.floorToPhoto = truth.json corner_px (Node)', worst < 1e-3, `${corners.length} corners, worst ${worst.toExponential(2)} px (the file rounds to 1e-3)`)
check('web.ts photoToFloor round trip (Node)', inNode.floor !== null && Math.abs(inNode.floor[1]) < 1e-12, JSON.stringify(inNode.floor))
check('web.ts decodeDepth (Node)', inNode.depth.width === truth.depth.w && inNode.depth.height === truth.depth.h && inNode.depth.sum > 0,
  `${inNode.depth.width}×${inNode.depth.height}, Σ ${inNode.depth.sum.toFixed(3)} m`)

// --- web.ts in headless Chrome ---------------------------------------------------------------------------------------
if (!process.argv.includes('--no-browser')) {
  const { BROWSER, BROWSER_ARGS, freePort } = await import('../evals/lib/harness.mjs')
  const { chromium } = await import('playwright-core')
  const esbuild = await import('esbuild')
  const OUT = path.join(ROOT, 'evals/out/wasm-smoke')
  fs.mkdirSync(OUT, { recursive: true })
  fs.writeFileSync(path.join(OUT, 'page.ts'), `import * as k from ${JSON.stringify(path.join(ROOT, 'core/js/web.ts'))}
const truth = await (await fetch('/scene/truth.json')).json()
const png = new Uint8Array(await (await fetch('/scene/depth.png')).arrayBuffer())
await k.loadKernels('/wasm/midstudy_wasm_web_bg.wasm')
const corners = Object.values(truth.objects).flatMap((o: any) => o.corners)
const cam = new k.SceneCamera(truth.camera, truth.image.w, truth.image.h)
const px = corners.map((c: any) => cam.floorToPhoto(c))
const floor = cam.photoToFloor(800, 1100)
cam.dispose()
const d = k.decodeDepth(png)
let sum = 0
for (const v of d.data) sum += v
const gpu = (navigator as any).gpu
const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null
;(window as any).__smoke = { px, floor, depth: { width: d.width, height: d.height, sum }, clamp: k.clampCamera({ fov_y_deg: 500 }).fov_y_deg,
  webgpu: adapter ? (adapter.info?.description || adapter.info?.vendor || 'adapter') : gpu ? 'navigator.gpu, no adapter' : 'no navigator.gpu' }
`)
  await esbuild.build({ entryPoints: [path.join(OUT, 'page.ts')], outfile: path.join(OUT, 'page.js'), bundle: true, format: 'esm',
    target: 'es2022', logLevel: 'warning' })
  const files = { '/': [path.join(OUT, 'index.html'), 'text/html'], '/page.js': [path.join(OUT, 'page.js'), 'text/javascript'],
    '/wasm/midstudy_wasm_web_bg.wasm': [WEB_WASM, 'application/wasm'], '/scene/truth.json': [path.join(SCENE, 'truth.json'), 'application/json'],
    '/scene/depth.png': [path.join(SCENE, 'depth.png'), 'image/png'] }
  fs.writeFileSync(files['/'][0], '<!doctype html><meta charset="utf-8"><script type="module" src="/page.js"></script>')
  const server = http.createServer((req, res) => {
    const f = files[new URL(req.url, 'http://x').pathname]
    if (!f) { res.writeHead(404).end(); return }
    res.writeHead(200, { 'content-type': f[1] })
    fs.createReadStream(f[0]).pipe(res)
  })
  const port = await freePort()
  await new Promise((r) => server.listen(port, '127.0.0.1', r))
  const browser = await chromium.launch({ executablePath: BROWSER, headless: true, args: BROWSER_ARGS })
  try {
    const page = await browser.newPage()
    const errors = []
    page.on('pageerror', (e) => errors.push(String(e)))
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
    await page.goto(`http://127.0.0.1:${port}/`)
    await page.waitForFunction(() => window.__smoke, null, { timeout: 60_000 })
    const inChrome = await page.evaluate(() => window.__smoke)
    const version = await browser.version()
    check(`web.ts loads build/wasm/web (Chrome ${version})`, errors.length === 0, errors.join('; '))
    const same = (k) => JSON.stringify(inChrome[k]) === JSON.stringify(inNode[k])
    check('web.ts in Chrome = in Node (projections, photoToFloor, depth, clamp)', ['px', 'floor', 'depth', 'clamp'].every(same),
      ['px', 'floor', 'depth', 'clamp'].filter((k) => !same(k)).join(', '))
    console.log(`info WebGPU in this page (${BROWSER_ARGS.join(' ')}): ${inChrome.webgpu}`)
  } finally {
    await browser.close()
    server.close()
  }
}
console.log(`wasm-smoke: ${failed ? `FAIL (${failed})` : 'ok'}`)
process.exit(failed ? 1 : 0)
