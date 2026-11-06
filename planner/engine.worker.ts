// The planner's kernel worker (bundled to planner/dist/engine.worker.js by scripts/build.mjs): depth.png's decode and
// the keep-room mask (core/js/web.ts serveKernels) run here, off the main thread. planner/engine.ts talks to it through
// KernelWorker and falls back to the main thread when it can't start. The wasm loads as soon as the worker starts,
// from beside the bundle (midstudy_wasm_web_bg.wasm, copied by the build).
import { loadKernels, serveKernels } from '../core/js/web.js'
import type { KernelPort } from '../core/js/web.js'

// `self` is this worker's scope (typed as Window under the planner's DOM lib): an adapter keeps to what both offer.
const port: KernelPort = {
  postMessage: (message, transfer) => { self.postMessage(message, { transfer }) },
  addEventListener: (type, listener) => { self.addEventListener(type, listener) },
}
loadKernels().catch(() => undefined) // a failed early load is retried by the first request
serveKernels(port)
