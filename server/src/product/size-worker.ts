// The size reader's worker thread (sizes.ts runs the reads over a large page here): one op at a time, JSON text in and
// out, through the same wasm as the main thread.
import { parentPort } from 'node:worker_threads'
import { callText } from './sizes.ts'

parentPort?.on('message', (m: unknown) => {
  if (typeof m !== 'object' || m === null) return
  const id: unknown = Reflect.get(m, 'id')
  const op: unknown = Reflect.get(m, 'op')
  const input: unknown = Reflect.get(m, 'input')
  if (typeof id !== 'number' || typeof op !== 'string' || typeof input !== 'string') return
  let out: string
  try {
    out = callText(op, input)
  } catch (e) {
    out = JSON.stringify({ error: `wasm: ${e instanceof Error ? e.message : String(e)}` })
  }
  parentPort?.postMessage({ id, out })
})
