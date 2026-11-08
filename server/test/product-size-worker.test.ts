// SizeWorker (server/src/product/sizes.ts): one job in the worker at a time, a queued job's deadline leaves the worker
// alone, and events from a replaced worker do nothing. Driven through a fake worker and mocked timers; no wasm.
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { SizeWorker, WorkerTimeout, type WorkerLike } from '../src/product/sizes.ts'

class FakeWorker extends EventEmitter implements WorkerLike {
  readonly posted: unknown[] = []
  terminated = 0

  postMessage(m: unknown): void {
    this.posted.push(Reflect.get(Object(m), 'id'))
  }

  terminate(): Promise<number> {
    this.terminated++
    return Promise.resolve(1)
  }

  unref(): void {
    // nothing holds the test's process
  }

  answer(id: number, out: string): void {
    this.emit('message', { id, out })
  }
}

function harness(): { readonly sizes: SizeWorker; readonly at: (i: number) => FakeWorker; readonly spawned: readonly FakeWorker[] } {
  const spawned: FakeWorker[] = []
  const sizes = new SizeWorker(() => {
    const w = new FakeWorker()
    spawned.push(w)
    return w
  })
  const at = (i: number): FakeWorker => {
    const w = spawned[i]
    assert.ok(w, `worker ${String(i)} was never spawned`)
    return w
  }
  return { sizes, at, spawned }
}

beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout'] })
})

afterEach(() => {
  mock.timers.reset()
})

void test('a queued job that times out is dropped and the running job carries on', async () => {
  const { sizes, at, spawned } = harness()
  const a = sizes.run('op', 'a', 1000)
  const b = sizes.run('op', 'b', 50)
  assert.deepEqual(at(0).posted, [1], 'only the running job is in the worker')

  const late = assert.rejects(b, WorkerTimeout)
  mock.timers.tick(50)
  await late
  assert.equal(at(0).terminated, 0)
  assert.equal(spawned.length, 1)

  at(0).answer(1, 'A')
  assert.equal(await a, 'A')
})

void test('the next job is posted only after the running one answers', async () => {
  const { sizes, at } = harness()
  const a = sizes.run('op', 'a', 1000)
  const b = sizes.run('op', 'b', 1000)
  at(0).answer(1, 'A')
  assert.equal(await a, 'A')
  assert.deepEqual(at(0).posted, [1, 2])
  at(0).answer(2, 'B')
  assert.equal(await b, 'B')
})

void test('a running job that times out replaces the worker; the old worker can no longer touch the next job', async () => {
  const { sizes, at, spawned } = harness()
  const a = sizes.run('op', 'a', 50)
  const b = sizes.run('op', 'b', 1000)

  const late = assert.rejects(a, WorkerTimeout)
  mock.timers.tick(50)
  await late
  assert.equal(at(0).terminated, 1)
  assert.equal(spawned.length, 2)
  assert.deepEqual(at(1).posted, [2])

  at(0).emit('error', new Error('late'))
  at(0).emit('exit', 1)
  at(0).answer(2, 'from the old worker')
  assert.equal(spawned.length, 2)
  assert.equal(at(1).terminated, 0)

  at(1).answer(2, 'B')
  assert.equal(await b, 'B')
})

void test('an error fails only the running job; the queued job moves to a new worker', async () => {
  const { sizes, at } = harness()
  const a = sizes.run('op', 'a', 1000)
  const b = sizes.run('op', 'b', 1000)
  const failed = assert.rejects(a, /boom/)
  at(0).emit('error', new Error('boom'))
  await failed
  assert.equal(at(0).terminated, 1)
  assert.deepEqual(at(1).posted, [2])
  at(1).answer(2, 'B')
  assert.equal(await b, 'B')
})

void test('a worker that exits without an error fails the running job at once', async () => {
  const { sizes, at } = harness()
  const a = sizes.run('op', 'a', 1000)
  const b = sizes.run('op', 'b', 1000)
  const failed = assert.rejects(a, /the size reader stopped \(exit 3\)/)
  at(0).emit('exit', 3)
  await failed
  assert.deepEqual(at(1).posted, [2])
  at(1).answer(2, 'B')
  assert.equal(await b, 'B')
})

void test('a message with a stale id is ignored', async () => {
  const { sizes, at } = harness()
  const a = sizes.run('op', 'a', 1000)
  at(0).answer(99, 'stale')
  let settled = false
  void a.then(() => {
    settled = true
  })
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(settled, false)
  at(0).answer(1, 'A')
  assert.equal(await a, 'A')
})

void test('a worker that cannot be started fails the jobs instead of leaving them waiting', async () => {
  const sizes = new SizeWorker(() => {
    throw new Error('no threads')
  })
  await assert.rejects(sizes.run('op', 'a', 1000), /no threads/)
})
