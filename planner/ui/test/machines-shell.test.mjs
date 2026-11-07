// The shell's state machines, pure parts (planner-ui-shell, docs/notes/state-machines-plan.md): which layer one Esc
// cancels (logic/layers.ts escTarget), when the phone sheet may change detent (logic/chrome.ts detentAllowed), and the
// UI epochs (ui/epoch.ts: now() moves on every change of the shown photo, items() only when the pieces are cleared).
// The modules are bundled with esbuild (their `.js` specifiers name `.ts` files), as logic-vs-v1.mjs does; no wasm.
// Run: nix develop -c node --test planner/ui/test/machines-shell.test.mjs   (npm run test:ui-machines runs every machines-*.test.mjs)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-machines-shell-'))
const entry = path.join(dir, 'entry.ts')
fs.writeFileSync(entry, [
  `export * as layers from ${JSON.stringify(path.join(ROOT, 'planner/ui/logic/layers.ts'))}`,
  `export * as chrome from ${JSON.stringify(path.join(ROOT, 'planner/ui/logic/chrome.ts'))}`,
  `export * as epoch from ${JSON.stringify(path.join(ROOT, 'planner/ui/epoch.ts'))}`,
].join('\n'))
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'm.mjs'), logLevel: 'error' })
const M = await import(path.join(dir, 'm.mjs'))
fs.rmSync(dir, { recursive: true, force: true })

test('escTarget: the one layer an Esc cancels', () => {
  const { escTarget } = M.layers
  assert.equal(escTarget(['page'], false), 0)
  assert.equal(escTarget(['page'], true), null) // Esc in a field leaves the page open (the field blurs)
  assert.equal(escTarget(['page', 'sheet'], true), 1)
  assert.equal(escTarget(['sheet', 'confirm'], false), 1)
  assert.equal(escTarget([], false), null)
  assert.equal(escTarget([], true), null)
  assert.equal(escTarget(['sheet', 'modal'], true), 1)
  assert.equal(escTarget(['page', 'menu'], true), 1)
  assert.equal(escTarget(['sheet', 'page'], true), null)
})

test('detentAllowed: the sheet changes detent only while it is open on the phone', () => {
  const { detentAllowed } = M.chrome
  assert.equal(detentAllowed('phone', 'library', null), false)
  assert.equal(detentAllowed('phone', 'library', 'half'), true)
  assert.equal(detentAllowed('desktop', 'library', 'half'), false)
  assert.equal(detentAllowed('phone', null, 'half'), false)
  assert.equal(detentAllowed(null, 'library', 'peek'), false)
})

// A stand-in for engine.events: addEventListener / emit by name.
function fakeEngine() {
  const ls = new Map()
  return {
    events: {
      addEventListener: (t, f) => { if (!ls.has(t)) ls.set(t, new Set()); ls.get(t).add(f) },
      removeEventListener: (t, f) => { ls.get(t)?.delete(f) },
    },
    emit: (t, detail) => { for (const f of ls.get(t) ?? []) f({ detail }) },
  }
}

test('uiEpoch: now() moves on every shown-photo change, items() only when the pieces go', () => {
  const eng = fakeEngine()
  const ep = M.epoch.uiEpoch(eng)
  const seen = { now: 0, items: 0 }
  const offNow = ep.on('now', () => { seen.now++ })
  ep.on('items', () => { seen.items++ })
  const n0 = ep.now(), i0 = ep.items()
  eng.emit('scene', { phase: 'calibrating', name: 'a' })
  eng.emit('scene', { phase: 'saved', name: 'a' })
  eng.emit('scene', { phase: 'title', name: 'a' })
  assert.equal(ep.now(), n0)
  assert.equal(ep.items(), i0)
  eng.emit('scene', { phase: 'loading', name: 'a' })
  assert.notEqual(ep.now(), n0)
  assert.notEqual(ep.items(), i0)
  // a room photo switch: 'opened' with no 'loading' (engine.ts openSceneAs) keeps the pieces
  const n1 = ep.now(), i1 = ep.items()
  eng.emit('scene', { phase: 'opened', name: 'b' })
  assert.notEqual(ep.now(), n1)
  assert.equal(ep.items(), i1)
  const n2 = ep.now()
  eng.emit('scene', { phase: 'failed', name: 'c' })
  assert.notEqual(ep.now(), n2)
  assert.equal(ep.items(), i1)
  eng.emit('scene', { phase: 'closed', name: null })
  assert.notEqual(ep.items(), i1)
  assert.deepEqual(seen, { now: 4, items: 2 })
  offNow()
  eng.emit('scene', { phase: 'closed', name: null })
  assert.deepEqual(seen, { now: 4, items: 3 })
})

test('uiEpoch without an engine stays at its start', () => {
  const ep = M.epoch.uiEpoch(null)
  assert.equal(ep.now(), ep.now())
  assert.equal(typeof ep.items(), 'number')
})
