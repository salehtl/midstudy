// The workspace's state machines, pure parts (planner-ui-workspace, docs/notes/state-machines-plan.md): whether ⌘Z may
// use the Undo slot (logic/workspace.ts undoUsable) and the rendering chip's counter (renderStarted, renderEnded).
// Bundled with esbuild (their `.js` specifiers name `.ts` files), as logic-vs-v1.mjs does; no wasm.
// Run: nix develop -c node --test planner/ui/test/machines-workspace.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-machines-workspace-'))
await build({ entryPoints: [path.join(ROOT, 'planner/ui/logic/workspace.ts')], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'm.mjs'), logLevel: 'error' })
const M = await import(path.join(dir, 'm.mjs'))
fs.rmSync(dir, { recursive: true, force: true })

test('undoUsable: only a slot from this set of pieces', () => {
  assert.equal(M.undoUsable(null, 1), false)
  assert.equal(M.undoUsable({ ep: 1 }, 2), false)
  assert.equal(M.undoUsable({ ep: 2 }, 2), true)
})

test('the rendering chip counts renders and keeps the earliest start', () => {
  const one = M.renderStarted(null, 100)
  assert.deepEqual(one, { n: 1, t0: 100 })
  const two = M.renderStarted(one, 200)
  assert.deepEqual(two, { n: 2, t0: 100 })
  const left = M.renderEnded(two)
  assert.deepEqual(left, { n: 1, t0: 100 })
  assert.equal(M.renderEnded(left), null)
  assert.equal(M.renderEnded(null), null)
  assert.deepEqual(M.renderStarted({ n: 1, t0: 300 }, 200), { n: 2, t0: 200 })
})
