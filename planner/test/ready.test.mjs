// The startup hook (planner/ready.ts) without a browser: ready.ts is bundled and run against a window that is a plain
// EventTarget. A failed start (module evaluation failing, the renderer not coming up) must settle `ready` and show in
// the one errors array. docs/notes/state-machines-plan.md, planner-core-startup.
// Usage (repo root): nix develop -c npm run test:planner
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '../..')
const bundled = await build({ entryPoints: [path.join(ROOT, 'planner/ready.ts')], bundle: true, format: 'esm', platform: 'browser', write: false, logLevel: 'silent' })
const source = bundled.outputFiles[0].text

let runs = 0
/** A fresh ready.ts on a fresh window. */
async function load() {
  const win = new EventTarget()
  globalThis.window = win
  const code = `${source}\n// run ${String(++runs)}`
  const mod = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  let settled = false
  void mod.ready.then(() => { settled = true })
  return { mod, win, isSettled: () => settled }
}
const tick = () => new Promise((r) => { setTimeout(r, 0) })
const twoTicks = async () => { await tick(); await tick() }
const failure = (message) => Object.assign(new Event('error'), { message })

test('a window error before the hook is whole settles ready with one Startup failed line in the shared array', async () => {
  const { mod, win, isSettled } = await load()
  assert.equal(win.midstudy.errors, mod.startErrors, 'the placeholder hook holds the exported array')
  win.dispatchEvent(failure('no adapter'))
  await twoTicks()
  assert.equal(isSettled(), true)
  assert.deepEqual(mod.startErrors, ['Startup failed: no adapter'])
})

test('a line the engine already reported is not repeated', async () => {
  const { mod, win, isSettled } = await load()
  win.dispatchEvent(failure('no adapter'))
  mod.startErrors.push('Unexpected error: no adapter') // the engine's own listener, after ready.ts's on the same event
  await twoTicks()
  assert.equal(isSettled(), true)
  assert.deepEqual(mod.startErrors, ['Unexpected error: no adapter'])
})

test('an unhandled rejection alone does not settle ready', async () => {
  const { mod, win, isSettled } = await load()
  win.dispatchEvent(new Event('unhandledrejection'))
  await twoTicks()
  assert.equal(isSettled(), false)
  assert.deepEqual(mod.startErrors, [])
})

test('after startupDone a window error is the engine\'s alone', async () => {
  const { mod, win, isSettled } = await load()
  mod.startupDone()
  win.dispatchEvent(failure('later'))
  await twoTicks()
  assert.equal(isSettled(), false)
  assert.deepEqual(mod.startErrors, [])
})

test('a second error during the wait adds nothing', async () => {
  const { mod, win } = await load()
  win.dispatchEvent(failure('first'))
  win.dispatchEvent(failure('second'))
  await twoTicks()
  assert.deepEqual(mod.startErrors, ['Startup failed: first'])
})
