// planner-core-startup's check (docs/notes/state-machines-plan.md): a renderer that cannot start (no WebGPU, no canvas
// context) makes the engine's top-level await reject, main.ts never runs, and `ready` must still settle with the
// failure in window.midstudy.errors.
export async function run({ ev, browser, srv }) {
  const context = await browser.newContext({ viewport: { width: 1024, height: 700 } })
  ev.onCleanup(() => context.close().catch(() => {}))
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true })
    HTMLCanvasElement.prototype.getContext = () => null
  })
  const page = await context.newPage()
  await page.goto(`${srv.base}/planner/`, { waitUntil: 'load', timeout: 30000 })
  await page.waitForFunction(() => !!window.midstudy, null, { timeout: 20000 })
  const got = await page.evaluate(() => Promise.race([
    Promise.resolve(window.midstudy.ready).then(() => ({ settled: true, errors: [...window.midstudy.errors] })),
    new Promise((r) => { setTimeout(() => { r({ settled: false, errors: [...window.midstudy.errors] }) }, 10000) }),
  ]))
  ev.check('startup: a renderer that cannot start settles ready within 10 s, the failure in errors', got.settled && got.errors.length > 0, JSON.stringify(got))
}
