// Type-level check (tsc only, never run): a Worker, a MessagePort and a worker's global scope are KernelPorts, so
// `new KernelWorker(new Worker(url, { type: 'module' }))` and `serveKernels(self)` type-check without casts.
import type { KernelPort } from '../../../js/web.ts'

declare const worker: Worker
declare const port: MessagePort
declare const scope: { postMessage(message: unknown, transfer: Transferable[]): void; addEventListener(type: 'message', listener: (e: MessageEvent) => void): void }
export const ports: KernelPort[] = [worker, port, scope]
