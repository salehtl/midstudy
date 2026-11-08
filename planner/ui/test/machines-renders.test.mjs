// The Renders panel's state machines, pure parts (planner-ui-renders, docs/notes/state-machines-plan.md): the viewer
// follows a render by name, Compare's picks drop deleted renders, and a request with no answer is told apart from a
// failure that charged nothing. Bundled with esbuild as logic-vs-v1.mjs does; no wasm.
// Run: nix develop -c node --test planner/ui/test/machines-renders.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-machines-renders-'))
const entry = path.join(dir, 'entry.ts')
fs.writeFileSync(entry, `export * from ${JSON.stringify(path.join(ROOT, 'planner/ui/logic/renders.ts'))}\nexport { renderLostText } from ${JSON.stringify(path.join(ROOT, 'planner/logic/messages.ts'))}`)
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'm.mjs'), logLevel: 'error' })
const M = await import(path.join(dir, 'm.mjs'))
fs.rmSync(dir, { recursive: true, force: true })

test('viewerIndex: the render shown, by name', () => {
  assert.equal(M.viewerIndex(['c', 'b', 'a'], 'b', 0), 1)
  assert.equal(M.viewerIndex(['d', 'c', 'b', 'a'], 'b', 1), 2) // a new render arrived above it
  assert.equal(M.viewerIndex(['c', 'a'], 'b', 1), 1) // removed: the old index
  assert.equal(M.viewerIndex(['c', 'a'], 'b', 5), 1) // removed: clamped
  assert.equal(M.viewerIndex([], 'b', 3), 0)
})

test('prunePicks: only renders that still exist', () => {
  assert.deepEqual(M.prunePicks(['x', 'b'], ['b']), ['b'])
  assert.deepEqual(M.prunePicks([], ['b']), [])
  assert.equal(M.prunePicks(null, ['b']), null)
})

test('a request with no answer may still finish; a refused one charged nothing', () => {
  const lost = M.failureReason(M.renderLostText())
  assert.equal(lost, 'the connection dropped')
  assert.equal(M.failureReason(`${M.renderLostText()} (timed out)`), lost) // whatever the transport's detail says
  assert.equal(M.mayStillFinish(lost), true)
  assert.equal(M.mayStillFinish("the server isn't answering"), true)
  assert.equal(M.mayStillFinish(undefined), false)
  assert.equal(M.mayStillFinish("today's budget is used up"), false)
  assert.equal(M.failedMeta(lost, '10:30'), 'May still finish · 10:30')
  assert.equal(M.failedMeta('timed out', '10:30'), 'Not charged · 10:30')
  assert.match(M.lostRetrySub(), /may have finished/)
})
