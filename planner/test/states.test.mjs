// The planner's state-machine steps (docs/notes/state-machines-plan.md), pure: each logic step as a table, node:test.
// planner/logic is bundled with esbuild first, as planner/engine.test.mjs does (its .js specifiers name .ts files).
// Usage (repo root): nix develop -c npm run test:planner
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '../..')
const LOGIC = ['jobs', 'camera', 'messages', 'look']
const entry = LOGIC.map((m) => `export * as ${m} from './planner/logic/${m}.ts'`).join('\n')
const bundled = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'js' }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' })
const L = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

test('jobOutcome: a job poll answers wait, done, failed or lost', () => {
  const rows = [
    // [httpStatus, status, outcome]
    [404, undefined, 'lost'], // the job store forgot it: the server restarted
    [404, 'running', 'lost'],
    [200, 'queued', 'wait'],
    [200, 'running', 'wait'],
    [200, 'done', 'done'],
    [200, 'failed', 'failed'],
    [201, 'done', 'done'],
    [null, undefined, 'wait'], // the request didn't reach the server: try again
    [null, 'done', 'wait'],
    [500, 'done', 'wait'], // a server error is transient
    [503, undefined, 'wait'],
    [409, 'failed', 'wait'],
    [304, 'done', 'wait'],
    [200, 'Done', 'wait'], // junk is waited through; the follower's loop limit ends it as lost
    [200, null, 'wait'],
    [200, 42, 'wait'],
    [200, {}, 'wait'],
    [200, '', 'wait'],
  ]
  for (const [h, s, want] of rows) assert.equal(L.jobs.jobOutcome(h, s), want, `jobOutcome(${h}, ${JSON.stringify(s)})`)
})

test('sourceAfterReset: the saved source when the reset lands on the saved camera, else what the calibration says', () => {
  const a = { fov_y_deg: 50, height_m: 1.4, pitch_deg: -5, roll_deg: 0 }
  const b = { ...a, height_m: 1.6 }
  const near = { ...a, height_m: a.height_m + 1e-7 }
  const rows = [
    // [cam, hasCalibCamera, saved, savedSource, want]
    [a, true, a, 'manual', 'manual'],
    [near, true, a, 'manual', 'manual'],
    [a, false, a, 'auto', 'auto'],
    [a, true, b, 'manual', 'auto'],
    [a, false, b, 'manual', 'default'],
    [a, true, null, 'manual', 'auto'],
    [a, false, null, 'manual', 'default'],
  ]
  for (const [c, h, s, src, want] of rows) assert.equal(L.camera.sourceAfterReset(c, h, s, src), want)
})

test('renderLostText says the render may still finish and leaves renderFailText alone', () => {
  assert.match(L.messages.renderLostText(), /may still finish/)
  assert.match(L.messages.renderLostText(), /Renders/)
  assert.equal(L.messages.renderFailText(null), 'Render failed')
})

test('lightingStep: one poll of the lighting backfill', () => {
  const LOST = 'the lighting job was lost (the server restarted?)'
  const GAVE_UP = 'gave up waiting'
  const rows = [
    // [prev, polled, polls, status, terminal, error]
    ['pending', 'pending', 1, 'pending', false, null],
    ['pending', 'running', 1, 'running', false, null],
    ['running', 'pending', 5, 'pending', false, null], // back in the queue: still waiting
    ['pending', 'done', 1, 'done', true, null],
    ['running', 'none', 1, 'none', true, null],
    ['running', 'failed', 1, 'failed', true, null], // the server's own error stands
    ['pending', 'missing', 1, 'failed', true, LOST],
    ['running', 'missing', 7, 'failed', true, LOST],
    ['missing', 'missing', 1, 'missing', true, null], // never saw it run: nothing was lost
    ['done', 'missing', 1, 'missing', true, null],
    ['pending', 'pending', 600, 'failed', true, GAVE_UP],
    ['running', 'running', 601, 'failed', true, GAVE_UP],
    ['pending', 'done', 600, 'done', true, null], // an answer on the last poll is an answer
    ['pending', 'missing', 600, 'failed', true, LOST],
  ]
  for (const [prev, polled, polls, status, terminal, error] of rows) {
    assert.deepEqual(L.look.lightingStep(prev, polled, polls, 600), { status, terminal, error }, `lightingStep(${prev}, ${polled}, ${polls})`)
  }
})
