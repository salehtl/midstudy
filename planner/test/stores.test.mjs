// The scenes and library stores (planner/data.ts) as state machines, without a browser: data.ts is bundled with
// './engine.js' swapped for a stub, the engine, fetch and XMLHttpRequest are fakes, and the poll delays run on
// node:test's mock timers. docs/notes/state-machines-plan.md, planner-core.
// Usage (repo root): nix develop -c npm run test:planner
import { afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '../..')
const STUB = `
export class RequestError extends Error {
  constructor(message, status, offline, body) { super(message); this.status = status; this.offline = offline; this.body = body }
}
export function quiet(p) { Promise.resolve(p).catch(() => undefined) }
export function withMidstudy(o = {}) { return o }
`
const stubEngine = { name: 'stub-engine', setup(b) {
  b.onResolve({ filter: /^\.\/engine\.js$/ }, () => ({ path: 'engine', namespace: 'stub' }))
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: STUB, loader: 'js' }))
} }
const entry = `export * from './planner/data.ts'
export { Bus } from './planner/bus.ts'
export * as scenes from './planner/logic/scenes.ts'
export * as library from './planner/logic/library.ts'
export * as msg from './planner/logic/messages.ts'`
const bundled = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'js' }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', plugins: [stubEngine] })
const D = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`)

function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}
/** Lets every promise chain that can move, move (setImmediate is not mocked). */
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => { setImmediate(r) }) }
const scene = (name, calib_status) => ({ name, calib_status })
const job = (id, status) => ({ id, item_id: id, status })
const json = (body, status = 200) => new Response(JSON.stringify(body), { status })

function fakeEngine() {
  const e = {
    events: new D.Bus(), errors: [], asks: [], reloads: 0,
    reportError(m) { e.errors.push(m); return new Error(m) },
    listScenesInternal(opts) { const d = deferred(); e.asks.push({ opts, d }); return d.promise },
    reloadLibrary() { e.reloads++ },
    listed(...scenes) { e.events.emit('scenes', { scenes }) },
  }
  return e
}
function collect(events, ...names) {
  const got = []
  for (const n of names) events.addEventListener(n, (e) => { got.push({ type: n, ...e.detail }) })
  return got
}

let realFetch, realXhr, gets
/** fetch answers from a list of deferreds, oldest first; `gets` is every request. */
function fakeFetch() {
  gets = []
  globalThis.fetch = (url, opts) => {
    const d = deferred()
    gets.push({ url, method: opts?.method ?? 'GET', d })
    return d.promise
  }
}
const pendingOf = (url) => gets.filter((g) => g.url === url && !g.done)
function answer(g, res) { g.done = true; if (res instanceof Error) g.d.reject(res); else g.d.resolve(res) }
const answerNext = (url, res) => { const g = pendingOf(url)[0]; assert.ok(g, `a pending ${url}`); answer(g, res) }

/** An XMLHttpRequest that holds until the test calls its onload or onabort. */
function fakeXhr() {
  const made = []
  globalThis.XMLHttpRequest = class {
    upload = {}
    status = 0
    responseText = ''
    open() {}
    setRequestHeader() {}
    send() { made.push(this) }
  }
  return made
}
async function uploaded(store, xhrs, name) {
  const p = store.upload(new Blob(['x'], { type: 'image/jpeg' }))
  const x = xhrs.at(-1)
  x.status = 202
  x.responseText = JSON.stringify({ job: 'j1', scene: name })
  x.onload()
  await p
  await flush()
}

beforeEach(() => {
  realFetch = globalThis.fetch
  realXhr = globalThis.XMLHttpRequest
  mock.timers.enable({ apis: ['setTimeout'] })
  fakeFetch()
})
afterEach(() => {
  mock.timers.reset()
  globalThis.fetch = realFetch
  if (realXhr) globalThis.XMLHttpRequest = realXhr
  else delete globalThis.XMLHttpRequest
})

// --- the pure steps -----------------------------------------------------------------------------------------------

test('freshAnswer: only an answer newer than the applied one', () => {
  for (const [n, applied, want] of [[1, 0, true], [2, 1, true], [1, 1, false], [1, 2, false], [0, 0, false]]) assert.equal(D.scenes.freshAnswer(n, applied), want, `${n}, ${applied}`)
})
test('pollDelay: offline wins, then busy, else no poll', () => {
  assert.equal(D.scenes.pollDelay(false, false), null)
  assert.equal(D.scenes.pollDelay(true, false), 1500)
  assert.equal(D.scenes.pollDelay(true, true), 10000)
  assert.equal(D.scenes.pollDelay(false, true), 10000)
})
test('jobsPollMs: 1.5 s, and 10 s from the fourth failure in a row', () => {
  for (const [f, want] of [[0, 1500], [1, 1500], [2, 1500], [3, 1500], [4, 10000], [50, 10000]]) assert.equal(D.library.jobsPollMs(f), want, String(f))
})
test('jobChange: only a busy job can finish', () => {
  const rows = [['running', 'done', 'done'], ['queued', 'failed', 'failed'], ['queued', 'running', null], ['running', 'running', null],
    ['failed', 'done', null], ['done', 'failed', null], [undefined, 'done', null], ['done', 'done', null]]
  for (const [a, b, want] of rows) assert.equal(D.library.jobChange(a, b), want, `${a} -> ${b}`)
})
test('mergeJobs: an answer that may predate a tracked job keeps it; a fresh one without a busy job has lost it', () => {
  const m = D.library.mergeJobs
  assert.deepEqual(m([], 1, [{ id: 'x', at: 1 }], ['x']), { keep: ['x'], lost: [] })
  assert.deepEqual(m([], 2, [{ id: 'x', at: 1 }], ['x']), { keep: [], lost: ['x'] })
  assert.deepEqual(m(['x'], 1, [{ id: 'x', at: 1 }], ['x']), { keep: [], lost: [] })
  assert.deepEqual(m(['x'], 9, [], ['x']), { keep: [], lost: [] })
  assert.deepEqual(m([], 3, [], ['y']), { keep: [], lost: ['y'] })
  assert.deepEqual(m(['y'], 3, [{ id: 'x', at: 3 }], ['x', 'y', 'z']), { keep: ['x'], lost: ['z'] })
  assert.deepEqual(m([], 1, [{ id: 'x', at: 1 }], []), { keep: ['x'], lost: [] }) // a tracked job already finished: still shown
})

// --- the scenes store ---------------------------------------------------------------------------------------------

test('scenes: a failure after a newer success does not go offline or drop the 1.5 s poll', async () => {
  const engine = fakeEngine()
  const store = D.createScenes({ engine })
  const older = store.refresh().catch(() => undefined)
  engine.listed(scene('s', 'running')) // a newer listing's answer
  engine.asks[0].d.reject(new Error('older request failed'))
  await older
  assert.equal(store.getState().offline, false)
  mock.timers.tick(1500)
  assert.equal(engine.asks.length, 2, 'the 1.5 s poll is still there')
})
test('scenes: a failure with nothing fresher goes offline and retries in 10 s', async () => {
  const engine = fakeEngine()
  const store = D.createScenes({ engine })
  const p = store.refresh().catch(() => undefined)
  engine.asks[0].d.reject(new Error('down'))
  await p
  assert.equal(store.getState().offline, true)
  mock.timers.tick(9999)
  assert.equal(engine.asks.length, 1)
  mock.timers.tick(1)
  assert.equal(engine.asks.length, 2)
})
test('scenes: only the first failure of an outage is reported', async () => {
  const engine = fakeEngine()
  const store = D.createScenes({ engine })
  quietly(store.refresh())
  for (let i = 0; i < 5; i++) {
    engine.asks[i].d.reject(new Error('down'))
    await flush()
    mock.timers.tick(10000)
    await flush()
  }
  assert.deepEqual(engine.asks.slice(0, 5).map((a) => a.opts?.report), [true, false, false, false, false])
})
function quietly(p) { p.catch(() => undefined) }
test('scenes: an upload answered after the listing saw it finish gives no second ready', async () => {
  const engine = fakeEngine()
  const xhrs = fakeXhr()
  const store = D.createScenes({ engine })
  const got = collect(store.events, 'ready', 'failed')
  engine.listed(scene('s', 'pending'))
  engine.listed(scene('s', 'done'))
  assert.equal(got.length, 1)
  await uploaded(store, xhrs, 's')
  engine.listed(scene('s', 'done'))
  assert.deepEqual(got.map((g) => g.type), ['ready'])
})
test('scenes: a first listing already done, then the upload answer: one ready', async () => {
  const engine = fakeEngine()
  const xhrs = fakeXhr()
  const store = D.createScenes({ engine })
  const got = collect(store.events, 'ready', 'failed')
  engine.listed(scene('s', 'done'))
  assert.equal(got.length, 0)
  await uploaded(store, xhrs, 's')
  engine.listed(scene('s', 'done'))
  assert.deepEqual(got.map((g) => [g.type, g.scene.name]), [['ready', 's']])
})
test('scenes: the usual upload, seeded pending, finishes once; a recalibration announces again', async () => {
  const engine = fakeEngine()
  const xhrs = fakeXhr()
  const store = D.createScenes({ engine })
  const got = collect(store.events, 'ready', 'failed')
  await uploaded(store, xhrs, 's')
  engine.listed(scene('s', 'done'))
  assert.equal(got.length, 1)
  engine.listed(scene('s', 'running'))
  engine.listed(scene('s', 'failed'))
  assert.deepEqual(got.map((g) => g.type), ['ready', 'failed'])
})
test('scenes: a listing without a finished scene forgets it; restored, it says nothing', async () => {
  const engine = fakeEngine()
  const xhrs = fakeXhr()
  const store = D.createScenes({ engine })
  const got = collect(store.events, 'ready', 'failed')
  engine.listed(scene('s', 'pending'))
  engine.listed(scene('s', 'done'))
  engine.listed()
  engine.listed(scene('s', 'done')) // restored
  assert.equal(got.length, 1)
  engine.listed() // and forgotten again, so a new start under that name is announced
  await uploaded(store, xhrs, 's')
  engine.listed(scene('s', 'done'))
  assert.equal(got.length, 2)
})
test('scenes: a busy scene missing from the listing keeps its shadow', async () => {
  const engine = fakeEngine()
  const xhrs = fakeXhr()
  const store = D.createScenes({ engine })
  const got = collect(store.events, 'ready', 'failed')
  await uploaded(store, xhrs, 's')
  engine.listed() // the upload's seed, not listed yet
  engine.listed(scene('s', 'done'))
  assert.deepEqual(got.map((g) => g.type), ['ready'])
})
test('upload: an aborted request rejects and is reported', async () => {
  const engine = fakeEngine()
  const xhrs = fakeXhr()
  const store = D.createScenes({ engine })
  let out = null
  store.upload(new Blob(['x'])).catch((e) => { out = e })
  xhrs[0].onabort?.()
  await flush()
  const message = "Couldn't upload the photo: the upload stopped"
  assert.ok(out, 'settled')
  assert.equal(out.message, message)
  assert.deepEqual(engine.errors, [message])
})

// --- the library's jobs -------------------------------------------------------------------------------------------

const JOBS = '/api/library/jobs'
const SPEND = '/api/spend'
const FROM_URL = '/api/library/items/from-url'

test('jobs: an answer from before the add does not erase the tracked job or stop the poll', async () => {
  const engine = fakeEngine()
  const lib = D.createLibrary({ engine })
  const a = lib.jobs()
  const add = lib.addFromUrl('https://x/y.jpg')
  answerNext(FROM_URL, json({ job: job('x', 'queued') }))
  await add
  answerNext(JOBS, json({ jobs: [] }))
  await a
  assert.deepEqual(lib.getState().jobs.map((j) => j.id), ['x'])
  mock.timers.tick(1500)
  assert.equal(pendingOf(JOBS).length, 1, 'still polling')
})
test('jobs: answers out of order: one job-done and one reload', async () => {
  const engine = fakeEngine()
  const lib = D.createLibrary({ engine })
  const got = collect(lib.events, 'job-done', 'job-failed')
  const seed = lib.jobs()
  answerNext(JOBS, json({ jobs: [job('x', 'running')] }))
  await seed
  const a = lib.jobs()
  const b = lib.jobs()
  const c = lib.jobs()
  const [A, B, C] = pendingOf(JOBS)
  answer(B, json({ jobs: [job('x', 'done')] }))
  await b
  answer(A, json({ jobs: [job('x', 'running')] }))
  await a
  answer(C, json({ jobs: [job('x', 'done')] }))
  await c
  assert.equal(got.filter((g) => g.type === 'job-done').length, 1)
  assert.equal(engine.reloads, 1)
})
test('jobs: a busy job gone from a fresh answer fails as lost, once, with a reload and the spend', async () => {
  const engine = fakeEngine()
  const lib = D.createLibrary({ engine })
  const got = collect(lib.events, 'job-done', 'job-failed')
  const seed = lib.jobs()
  answerNext(JOBS, json({ jobs: [job('x', 'running')] }))
  await seed
  const p = lib.jobs()
  answerNext(JOBS, json({ jobs: [] }))
  await p
  assert.equal(got.length, 1)
  assert.equal(got[0].type, 'job-failed')
  assert.equal(got[0].job.id, 'x')
  assert.equal(got[0].job.status, 'failed')
  assert.equal(got[0].job.message, D.msg.jobLostText())
  assert.equal(engine.reloads, 1)
  assert.equal(pendingOf(SPEND).length, 1)
  assert.deepEqual(lib.getState().jobs, [])
  const again = lib.jobs()
  answerNext(JOBS, json({ jobs: [] }))
  await again
  assert.equal(got.length, 1, 'once')
})
test('jobs: failures in a row: one reported error, the poll goes on and backs off from the fourth', async () => {
  const engine = fakeEngine()
  const lib = D.createLibrary({ engine })
  const seed = lib.jobs()
  answerNext(JOBS, json({ jobs: [job('x', 'running')] }))
  await seed
  const delays = []
  for (let i = 0; i < 5; i++) {
    mock.timers.tick(1500)
    if (pendingOf(JOBS).length === 0) { mock.timers.tick(8500); delays.push(10000) } else delays.push(1500)
    answerNext(JOBS, new TypeError('fetch failed'))
    await flush()
  }
  assert.deepEqual(delays, [1500, 1500, 1500, 1500, 10000])
  assert.equal(engine.errors.length, 1)
  mock.timers.tick(10000)
  assert.equal(pendingOf(JOBS).length, 1)
  answerNext(JOBS, json({ jobs: [job('x', 'running')] }))
  await flush()
  mock.timers.tick(1500)
  assert.equal(pendingOf(JOBS).length, 1, 'back to 1.5 s once answered')
})

// --- is there a library API? --------------------------------------------------------------------------------------

const LIBRARY = '/api/library'
test('library: a probe that fails at start is tried again, and then the jobs and spend are read', async () => {
  const engine = fakeEngine()
  const lib = D.createLibrary({ engine })
  const p = lib.start()
  answerNext(LIBRARY, new TypeError('fetch failed'))
  await p
  assert.equal(lib.getState().api, null)
  assert.equal(pendingOf(JOBS).length, 0)
  mock.timers.tick(10000)
  answerNext(LIBRARY, json({ items: [], trash: [] }))
  await flush()
  assert.equal(lib.getState().api, true)
  assert.equal(pendingOf(JOBS).length, 1)
  assert.equal(pendingOf(SPEND).length, 1)
})
test('library: the probe gives up after five retries', async () => {
  const lib = D.createLibrary({ engine: fakeEngine() })
  const p = lib.start()
  answerNext(LIBRARY, new TypeError('fetch failed'))
  await p
  for (let i = 0; i < 5; i++) {
    mock.timers.tick(10000)
    answerNext(LIBRARY, new TypeError('fetch failed'))
    await flush()
  }
  mock.timers.tick(100000)
  assert.equal(pendingOf(LIBRARY).length, 0)
})
test('library: a decisive 404 at start says no API and is not retried', async () => {
  const lib = D.createLibrary({ engine: fakeEngine() })
  const p = lib.start()
  answerNext(LIBRARY, json({ error: 'no' }, 404))
  await p
  assert.equal(lib.getState().api, false)
  mock.timers.tick(100000)
  assert.equal(pendingOf(LIBRARY).length, 0)
})
test('library: a 404 after the API answered leaves it true', async () => {
  const engine = fakeEngine()
  const lib = D.createLibrary({ engine })
  const p = lib.start()
  answerNext(LIBRARY, json({ items: [], trash: [] }))
  await flush()
  answerNext(JOBS, json({ jobs: [] }))
  answerNext(SPEND, json({}))
  await p
  const r = lib.remove('a')
  answerNext('/api/library/items/a', json({}))
  await flush()
  answerNext(LIBRARY, json({ error: 'gone' }, 404))
  await r
  assert.equal(lib.getState().api, true)
})
