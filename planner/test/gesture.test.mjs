// The canvas gesture's guards (planner/logic/input.ts), without a browser: whether the canvas still owns the engine's
// drag, which two fingers carry a pinch on after one lifts, and what the finger left over from a pinch does.
// planner/ui/test/sections/gesture.mjs drives the same guards with real touches. docs/notes/state-machines-plan.md.
// Usage (repo root): nix develop -c npm run test:planner
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '../..')
const bundled = await build({ entryPoints: [path.join(ROOT, 'planner/logic/input.ts')], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
const L = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

test('sameDrag: only the drag the canvas began, still running', () => {
  const mine = { uid: 'a', mode: 'move' }
  assert.equal(L.sameDrag(mine, { uid: 'a', mode: 'move' }), true)
  assert.equal(L.sameDrag(mine, { uid: 'a', mode: 'rotate' }), false)
  assert.equal(L.sameDrag(mine, { uid: 'b', mode: 'move' }), false)
  assert.equal(L.sameDrag(mine, null), false)
  assert.equal(L.sameDrag(null, { uid: 'a', mode: 'move' }), false)
  assert.equal(L.sameDrag(null, null), false)
})

test('nextPinchPair: the fingers left, oldest first', () => {
  assert.deepEqual(L.nextPinchPair([1, 2, 3], 1), { a: 2, b: 3 })
  assert.deepEqual(L.nextPinchPair([1, 2, 3], 2), { a: 1, b: 3 })
  assert.deepEqual(L.nextPinchPair([2, 3], 1), { a: 2, b: 3 }, 'the lifted finger may be gone from the list already')
  assert.deepEqual(L.nextPinchPair([1, 2, 3, 4], 1), { a: 2, b: 3 })
  assert.equal(L.nextPinchPair([1, 2], 1), null)
  assert.equal(L.nextPinchPair([], 1), null)
})

test('residualKind: the finger left over pans only a zoomed view', () => {
  assert.equal(L.residualKind(1), 'other')
  assert.equal(L.residualKind(1.001), 'other')
  assert.equal(L.residualKind(2), 'pan')
})

test('residualPans: pans though the gesture was multi-finger, which pans() refuses', () => {
  assert.equal(L.residualPans(true, L.residualKind(1), 1), false)
  assert.equal(L.residualPans(true, L.residualKind(2), 2), true)
  assert.equal(L.residualPans(true, 'other', 2), true, 'zoomed in after the hand-off')
  assert.equal(L.residualPans(false, 'pan', 2), false)
  assert.equal(L.residualPans(true, 'item', 2), false)
  assert.equal(L.pans(true, true, 'pan', 2), false, 'pans() keeps v1: multi never pans')
})
