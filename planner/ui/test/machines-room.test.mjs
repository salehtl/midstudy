// The floor plan's state machines, pure parts (planner-ui-room, docs/notes/state-machines-plan.md): what a pointer down
// starts, what a drag's end does, and which photo Align photos works on. Bundled with esbuild as logic-vs-v1.mjs does; no
// wasm. Run: nix develop -c node --test planner/ui/test/machines-room.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-machines-room-'))
await build({ entryPoints: [path.join(ROOT, 'planner/ui/logic/rooms.ts')], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'm.mjs'), logLevel: 'error' })
const M = await import(path.join(dir, 'm.mjs'))
fs.rmSync(dir, { recursive: true, force: true })

test('planDown: one finger starts, the second pinches, anything more is only recorded', () => {
  assert.equal(M.planDown(1, false), 'start')
  assert.equal(M.planDown(2, false), 'pinch')
  assert.equal(M.planDown(3, true), 'ignore')
  assert.equal(M.planDown(3, false), 'ignore')
  assert.equal(M.planDown(2, true), 'ignore')
  assert.equal(M.planDown(1, true), 'ignore')
})

test('planEnd: a moved photo or handle commits only while Align photos is on', () => {
  assert.equal(M.planEnd('photo', true, true), 'commit')
  assert.equal(M.planEnd('handle', true, true), 'commit')
  assert.equal(M.planEnd('photo', true, false), 'revert')
  assert.equal(M.planEnd('handle', true, false), 'revert')
  assert.equal(M.planEnd('photo', false, true), 'none')
  assert.equal(M.planEnd('handle', false, false), 'none')
})

test('planEnd: an unmoved pan is a tap; pieces are saved as they move', () => {
  for (const on of [true, false]) {
    assert.equal(M.planEnd('pan', false, on), 'tap')
    assert.equal(M.planEnd('pan', true, on), 'none')
    assert.equal(M.planEnd('item', true, on), 'none')
    assert.equal(M.planEnd('turn', true, on), 'none')
  }
})

test('alignTarget: the grabbed photo only while it is a member, else the current one', () => {
  assert.equal(M.alignTarget('gone', ['room-1', 'room-2'], 'room-1'), 'room-1')
  assert.equal(M.alignTarget('room-2', ['room-1', 'room-2'], 'room-1'), 'room-2')
  assert.equal(M.alignTarget(null, ['room-1', 'room-2'], 'room-1'), 'room-1')
  assert.equal(M.alignTarget(null, ['room-1', 'room-2'], null), null)
  assert.equal(M.alignTarget('gone', [], null), null)
})
