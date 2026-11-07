// The splat sort for the WebGL2 fallback (no compute shaders there), off the main thread (bundled to
// planner/dist/sort.worker.js by scripts/build.mjs): the layer sends the splat set once ('set': centers and item slots),
// then one 'sort' per camera or transform change (the item rows, near and the depth range); each reply carries the
// back-to-front order (transferred) and how long the sort took. The kernel is sort-cpu.ts; a Rust/WASM kernel can
// replace it behind the same messages. A failure answers with a fatal 'error' (a failed 'set' is remembered and
// answers every later sort so), and the layer then sorts on the main thread.
import { newScratch, sortSplats } from './sort-cpu.js'
import type { SortScratch } from './sort-cpu.js'
import type { FromWorker, ToWorker } from './sort-messages.js'

let set: { version: number; centers: Float32Array; slots: Uint16Array; count: number } | null = null
let scratch: SortScratch = newScratch(0)
let broken: string | null = null // why the last 'set' failed

// `self` is this worker's scope (typed as Window under the planner's DOM lib): only what both offer is used.
const reply = (m: FromWorker, transfer: Transferable[] = []): void => { self.postMessage(m, { transfer }) }
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e))

self.addEventListener('message', (e: MessageEvent<ToWorker>) => {
  const m = e.data
  if (m.type === 'set') {
    try {
      set = { version: m.version, centers: m.centers, slots: m.slots, count: m.count }
      if (scratch.keys.length < m.count) scratch = newScratch(m.count)
      broken = null
    } catch (err) {
      set = null
      broken = `the splat set failed: ${messageOf(err)}`
    }
    return
  }
  if (broken !== null) { reply({ type: 'error', id: m.id, message: broken, fatal: true }); return }
  if (set?.version !== m.version) {
    reply({ type: 'error', id: m.id, message: `no splat set ${String(m.version)} (have ${set ? String(set.version) : 'none'})`, fatal: false })
    return
  }
  try {
    const t0 = performance.now()
    const order = new Uint32Array(Math.max(1, set.count))
    const visible = sortSplats({ centers: set.centers, slots: set.slots, rows: m.rows, near: m.near, dmin: m.dmin, dmax: m.dmax, count: set.count }, order, scratch)
    reply({ type: 'sorted', id: m.id, version: m.version, order, visible, ms: performance.now() - t0 }, [order.buffer])
  } catch (err) {
    reply({ type: 'error', id: m.id, message: `the sort failed: ${messageOf(err)}`, fatal: true })
  }
})
