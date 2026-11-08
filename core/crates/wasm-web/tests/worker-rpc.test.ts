// serveKernels / KernelWorker when things go wrong: a failed load is retried, and no request is left waiting when a
// message cannot be sent or read. The first test needs this process unloaded (each test file is its own process).
// Usage (repo root, after a build): nix develop -c npm run test:kernels-web
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import * as k from '../../../js/web.ts'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const goodBytes = new Uint8Array(fs.readFileSync(path.join(REPO, 'build/wasm/web/midstudy_wasm_web_bg.wasm')))
const png = new Uint8Array(fs.readFileSync(path.join(REPO, 'fixtures/scenes/steep-roll/depth.png')))
const pngBuffer = (): ArrayBuffer => png.slice().buffer

/** A KernelPort the test drives: records what is posted, can throw from postMessage, dispatches events. */
function fakePort() {
  const listeners: Record<string, ((e: { data: unknown }) => void)[]> = { message: [], messageerror: [] }
  const port = {
    posted: [] as unknown[],
    throwNext: null as Error | null,
    postMessage(message: unknown) {
      if (port.throwNext) {
        const err = port.throwNext
        port.throwNext = null
        throw err
      }
      port.posted.push(message)
    },
    addEventListener(type: string, listener: (e: { data: unknown }) => void) { listeners[type]?.push(listener) },
    dispatch(type: string, data?: unknown) { for (const l of listeners[type] ?? []) l({ data }) },
  }
  return port
}

/** Rejects (fails the test) if `p` is still pending after a second: a request left hanging. */
function settles<T>(p: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error('still pending after 1 s')) }, 1000) })
  return Promise.race([p, late]).finally(() => { clearTimeout(timer) })
}

const fake = (port: ReturnType<typeof fakePort>) => new k.KernelWorker(port as unknown as k.KernelPort)

test('a request after a failed load is served once the load succeeds', async (t) => {
  const { port1, port2 } = new MessageChannel()
  t.after(() => { port1.close(); port2.close() }) // also when an assertion fails: an open port keeps the process alive
  k.serveKernels(port2) // no source: in Node the glue's fetch of its file: URL rejects
  const worker = new k.KernelWorker(port1)
  await assert.rejects(settles(worker.decodeDepth(pngBuffer())))
  assert.equal(k.kernelsLoaded(), false)
  await k.loadKernels(goodBytes)
  const viaWorker = await settles(worker.decodeDepth(pngBuffer()))
  assert.deepEqual(viaWorker.data, k.decodeDepth(png).data)
})

test('a request that cannot be posted rejects, and a later reply with its id is ignored', async (t) => {
  const { port1, port2 } = new MessageChannel()
  t.after(() => { port1.close(); port2.close() })
  const real = new k.KernelWorker(port1)
  const detached = pngBuffer()
  structuredClone(detached, { transfer: [detached] })
  await assert.rejects(settles(real.decodeDepth(detached)), /DataClone|detached|neutered/i)

  const port = fakePort()
  const worker = fake(port)
  port.throwNext = new Error('could not post')
  await assert.rejects(settles(worker.decodeDepth(pngBuffer())), /could not post/)
  port.dispatch('message', { id: 1, ok: false, error: 'late' }) // no entry left: nothing to settle, nothing thrown
  const next = worker.decodeDepth(pngBuffer())
  port.dispatch('message', { id: 2, ok: false, error: 'the next one' })
  await assert.rejects(settles(next), /the next one/)
})

test('a reply that cannot be read rejects everything in flight', async () => {
  const port = fakePort()
  const worker = fake(port)
  const calls = [worker.decodeDepth(pngBuffer()), worker.keepRoomMask(new ArrayBuffer(4), 1, 1)]
  port.dispatch('messageerror')
  for (const c of calls) await assert.rejects(settles(c), /a reply could not be read/)
})

test('a reply with no id rejects everything in flight', async () => {
  const port = fakePort()
  const worker = fake(port)
  const calls = [worker.decodeDepth(pngBuffer()), worker.decodeDepth(pngBuffer())]
  port.dispatch('message', { ok: true })
  for (const c of calls) await assert.rejects(settles(c), /malformed reply/)
})

test('a reply with an unknown id leaves the others waiting', async () => {
  const port = fakePort()
  const worker = fake(port)
  const call = worker.decodeDepth(pngBuffer())
  port.dispatch('message', { id: 99, ok: false, error: 'not yours' })
  port.dispatch('message', { id: 1, ok: false, error: 'yours' })
  await assert.rejects(settles(call), /^Error: yours$/)
})

test('close() rejects what is in flight and every later call', async () => {
  const port = fakePort()
  const worker = fake(port)
  const pending = worker.decodeDepth(pngBuffer())
  worker.close('it crashed')
  await assert.rejects(settles(pending), /it crashed/)
  await assert.rejects(settles(worker.decodeDepth(pngBuffer())), /it crashed/)
  assert.equal(port.posted.length, 1)
  const defaulted = fake(fakePort())
  defaulted.close()
  await assert.rejects(settles(defaulted.decodeDepth(pngBuffer())), /the kernel worker stopped/)
})

test('a request the worker cannot read is answered with an id-less failure', async () => {
  const port = fakePort()
  k.serveKernels(port as unknown as k.KernelPort)
  port.dispatch('messageerror')
  assert.deepEqual(port.posted, [{ ok: false, error: 'midstudy kernels: a request could not be read' }])
  // end to end: that answer fails the client's calls
  const client = fakePort()
  const worker = fake(client)
  const call = worker.decodeDepth(pngBuffer())
  client.dispatch('message', port.posted[0])
  await assert.rejects(settles(call), /malformed reply/)
})
