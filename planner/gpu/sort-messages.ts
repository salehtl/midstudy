// Messages between SplatLayer and the CPU sort worker (sort.worker.ts). An 'error' is fatal when the worker can no
// longer sort (its catch: the layer marks it down for good and sorts on the main thread); a non-fatal one (the set
// version it has is not the request's) only drops that request.
export type ToWorker =
  | { type: 'set', version: number, centers: Float32Array, slots: Uint16Array, count: number }
  | { type: 'sort', id: number, version: number, rows: Float32Array, near: number, dmin: number, dmax: number }
export type FromWorker =
  | { type: 'sorted', id: number, version: number, order: Uint32Array, visible: number, ms: number }
  | { type: 'error', id: number, message: string, fatal: boolean }
