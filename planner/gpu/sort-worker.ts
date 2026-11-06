// The splat sort for the WebGL2 fallback (no compute shaders there), off the main thread: the layer sends the splat
// set once ('set': centers and item slots), then one 'sort' per camera or transform change (the item rows, near and
// the depth range); each reply carries the back-to-front order (transferred) and how long the sort took.
// The kernel is sort-cpu.ts; a Rust/WASM kernel can replace it behind the same messages.
import { newScratch, sortSplats } from './sort-cpu.ts'
import type { SortScratch } from './sort-cpu.ts'
import type { FromWorker, ToWorker } from './sort-messages.ts'

declare const self: DedicatedWorkerGlobalScope

let set: { version: number, centers: Float32Array, slots: Uint16Array, count: number } | null = null
let scratch: SortScratch = newScratch(0)

self.onmessage = (e: MessageEvent<ToWorker>) => {
  const m = e.data
  if (m.type === 'set') {
    set = { version: m.version, centers: m.centers, slots: m.slots, count: m.count }
    if (scratch.keys.length < m.count) scratch = newScratch(m.count)
    return
  }
  if (!set || set.version !== m.version) {
    const reply: FromWorker = { type: 'error', id: m.id, message: `no splat set ${m.version} (have ${set ? set.version : 'none'})` }
    self.postMessage(reply)
    return
  }
  const t0 = performance.now()
  const order = new Uint32Array(Math.max(1, set.count))
  const visible = sortSplats({ centers: set.centers, slots: set.slots, rows: m.rows, near: m.near, dmin: m.dmin, dmax: m.dmax, count: set.count }, order, scratch)
  const reply: FromWorker = { type: 'sorted', id: m.id, version: m.version, order, visible, ms: performance.now() - t0 }
  self.postMessage(reply, [order.buffer])
}
