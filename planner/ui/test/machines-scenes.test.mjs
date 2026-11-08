// The Scenes page's state machines, pure parts (planner-ui-scenes, docs/notes/state-machines-plan.md): the room poll's
// backoff and the words of a New room that stopped part-way. Bundled with esbuild as logic-vs-v1.mjs does; no wasm.
// Run: nix develop -c node --test planner/ui/test/machines-scenes.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-machines-scenes-'))
await build({ entryPoints: [path.join(ROOT, 'planner/ui/logic/scenes.ts')], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'm.mjs'), logLevel: 'error' })
const M = await import(path.join(dir, 'm.mjs'))
fs.rmSync(dir, { recursive: true, force: true })

test('nextPollMs: 1.5 s, doubling to 30 s', () => {
  assert.equal(M.nextPollMs(0), 1500)
  assert.equal(M.nextPollMs(1), 3000)
  assert.equal(M.nextPollMs(2), 6000)
  assert.equal(M.nextPollMs(4), 24000)
  assert.equal(M.nextPollMs(5), 30000)
  assert.equal(M.nextPollMs(10), 30000)
  assert.equal(M.nextPollMs(5000), 30000)
})

test('New room stopped part-way: the words, and what can resume', () => {
  assert.equal(M.roomResumeLabel(2), 'Make the room from 2 photos')
  assert.equal(M.roomResumeLabel(1), 'Make the room from 1 photo')
  assert.match(M.roomStoppedText('upload', 0), /No photo uploaded/)
  assert.match(M.roomStoppedText('upload', 2), /2 photos uploaded/)
  assert.match(M.roomStoppedText('room', 3), /3 photos are uploaded/)
  assert.match(M.roomAlignStoppedText('Den'), /^Den is made/)
})
