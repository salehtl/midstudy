// A WebGL call trace of the demo on three.js's WebGL2 fallback: every framebuffer bind, clear, draw, blit, texture
// bind and colour-mask change of one view frame and one capture, with stable ids for GL objects. This is how both
// WebGL2-backend clear bugs in docs/notes/webgpu-spike.md were found (a clear on the wrong framebuffer, a clear
// under a false colour mask). Usage: node planner/gpu/demo/gltrace.mjs  → evals/out/webgpu-gltrace/trace.txt
import fs from 'node:fs'
import path from 'node:path'
import { build, serve, REPO } from './tools.mjs'
import { writeProbes } from './assets.mjs'
import { BROWSER, BROWSER_ARGS } from '../../../evals/lib/harness.mjs'

const out = path.join(REPO, 'evals/out/webgpu-gltrace')
fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'lib'), { recursive: true })
writeProbes(path.join(out, 'lib'))
build(path.join(out, 'bundle'))
const srv = await serve({ '/demo/': path.join(REPO, 'planner/gpu/demo'), '/bundle/': path.join(out, 'bundle'), '/scene/': path.join(REPO, 'fixtures/scenes/living-wide'), '/lib/': path.join(out, 'lib') })
const { chromium } = await import('playwright-core')
const browser = await chromium.launch({ executablePath: BROWSER, headless: true, args: BROWSER_ARGS })
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
  await page.addInitScript(() => {
    const P = WebGL2RenderingContext.prototype
    const ids = new WeakMap()
    let next = 1
    const id = (o) => (o == null ? 0 : (ids.has(o) ? ids.get(o) : (ids.set(o, next++), next - 1)))
    const log = []
    const bound = { draw: 0, read: 0 }
    let unit = 0
    window.__gl = { log, on: false }
    const wrap = (name, fn) => { const orig = P[name]; P[name] = function (...a) { if (window.__gl.on) fn.call(this, a); return orig.apply(this, a) } }
    wrap('bindFramebuffer', function (a) { const t = a[0] === this.READ_FRAMEBUFFER ? 'R' : a[0] === this.DRAW_FRAMEBUFFER ? 'D' : 'F'; if (t !== 'R') bound.draw = id(a[1]); if (t !== 'D') bound.read = id(a[1]); log.push(`bind${t} fb${id(a[1])}`) })
    wrap('clearBufferfv', function (a) { log.push(`clearBufferfv(${a[0] === this.COLOR ? 'color' : 'depth'}) on fb${bound.draw}`) })
    wrap('clearBufferfi', function () { log.push(`clearBufferfi(depth+stencil) on fb${bound.draw}`) })
    wrap('clear', function () { log.push(`clear on fb${bound.draw}`) })
    wrap('drawElements', function () { log.push(`draw on fb${bound.draw}`) })
    wrap('drawArrays', function () { log.push(`draw on fb${bound.draw}`) })
    wrap('drawElementsInstanced', function () { log.push(`drawInstanced on fb${bound.draw}`) })
    wrap('blitFramebuffer', function () { log.push(`blit fb${bound.read} -> fb${bound.draw}`) })
    wrap('readPixels', function () { log.push(`readPixels from fb${bound.read}`) })
    wrap('activeTexture', function (a) { unit = a[0] - this.TEXTURE0 })
    wrap('bindTexture', function (a) { if (a[0] === this.TEXTURE_2D) log.push(`  bindTex unit${unit} tex${id(a[1])}`) })
    wrap('useProgram', function (a) { log.push(`  program p${id(a[0])}`) })
    wrap('colorMask', function (a) { log.push(`  colorMask ${a.join(',')}`) })
  })
  await page.goto(`${srv.base}/demo/index.html?backend=webgl`)
  const log = await page.evaluate(async () => {
    const d = window.gpuDemo
    await d.ready
    await d.openScene('/scene')
    await d.addItem({ uid: 'lit', glb: '/lib/probe-lit/model.glb', position: [1.3, 0, -3.1] })
    await d.draw()
    window.__gl.on = true
    window.__gl.log.push('==== a view frame')
    await d.draw()
    window.__gl.log.push('==== a capture')
    await d.capture()
    window.__gl.on = false
    return window.__gl.log
  })
  fs.writeFileSync(path.join(out, 'trace.txt'), log.join('\n'))
  console.log(`${log.length} calls → ${path.join(out, 'trace.txt')}`)
} finally {
  await browser.close()
  await srv.stop()
}
