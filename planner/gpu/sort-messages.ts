// Messages between SplatLayer and the CPU sort worker (sort.worker.ts).
export type ToWorker =
  | { type: 'set', version: number, centers: Float32Array, slots: Uint16Array, count: number }
  | { type: 'sort', id: number, version: number, rows: Float32Array, near: number, dmin: number, dmax: number }
export type FromWorker =
  | { type: 'sorted', id: number, version: number, order: Uint32Array, visible: number, ms: number }
  | { type: 'error', id: number, message: string }
