// The planner's state-machine steps (docs/notes/state-machines-plan.md), pure: each logic step as a table, node:test.
// planner/logic is bundled with esbuild first, as planner/engine.test.mjs does (its .js specifiers name .ts files).
// Usage (repo root): nix develop -c npm run test:planner
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '../..')
const LOGIC = ['jobs']
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
