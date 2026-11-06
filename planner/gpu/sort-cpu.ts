// Back-to-front order of splats by view depth, on the CPU: the WebGL2 fallback's sort (run in a worker,
// sort-worker.ts) and the reference the GPU radix sort (radix-sort.ts) is checked against. Pure: no DOM, no three.js.
//
// Keys are the GPU sort's: the depth along the view axis, d = −(V·M)·c (the camera looks along −z), quantized linearly
// over [dmin, dmax] (the depth range of every placed item's bounds, computed per frame by the layer) to 16 bits with
// the far end at 0, so ascending keys draw back to front. Splats at or behind `near` are left out (the GPU path gives
// them the largest key instead). A counting sort over 65,536 buckets is stable, so equal keys keep their index order,
// as the GPU's stable LSD radix sort does: both give the same order for the same keys.

export interface SortRequest {
  /** item-frame centers, 3 per splat */
  readonly centers: Float32Array
  /** the item slot of each splat (an index into rows) */
  readonly slots: Uint16Array
  /** per item slot: the view-space z row of V·M (4 floats), so z = r·[x y z 1] and d = −z */
  readonly rows: Float32Array
  readonly near: number
  readonly dmin: number
  readonly dmax: number
  readonly count: number
}

export const KEY_LEVELS = 0xffff // 16-bit keys; KEY_LEVELS itself marks a culled splat

/** Quantizes a view depth to the 16-bit back-to-front key (KEY_LEVELS = behind the near plane). */
export function depthKey(d: number, near: number, dmin: number, dmax: number): number {
  if (!(d > near)) return KEY_LEVELS
  const span = dmax - dmin > 1e-9 ? dmax - dmin : 1e-9
  const q = (dmax - d) / span
  return Math.round((q < 0 ? 0 : q > 1 ? 1 : q) * (KEY_LEVELS - 1))
}

export interface SortScratch { keys: Uint16Array, counts: Uint32Array }
export const newScratch = (n: number): SortScratch => ({ keys: new Uint16Array(n), counts: new Uint32Array(KEY_LEVELS + 1) })

/** Writes the visible splats' indices into `out`, back to front; returns how many. */
export function sortSplats(req: SortRequest, out: Uint32Array, scratch: SortScratch = newScratch(req.count)): number {
  const { centers, slots, rows, near, dmin, dmax, count } = req
  if (scratch.keys.length < count) scratch.keys = new Uint16Array(count)
  const { keys, counts } = scratch
  counts.fill(0)
  const span = dmax - dmin > 1e-9 ? dmax - dmin : 1e-9
  const scale = (KEY_LEVELS - 1) / span
  for (let i = 0; i < count; i++) {
    const s = 4 * (slots[i] ?? 0)
    const x = centers[3 * i] ?? 0, y = centers[3 * i + 1] ?? 0, z = centers[3 * i + 2] ?? 0
    const d = -((rows[s] ?? 0) * x + (rows[s + 1] ?? 0) * y + (rows[s + 2] ?? 0) * z + (rows[s + 3] ?? 0))
    let k = KEY_LEVELS
    if (d > near) {
      const q = (dmax - d) * scale
      k = q <= 0 ? 0 : q >= KEY_LEVELS - 1 ? KEY_LEVELS - 1 : Math.round(q)
    }
    keys[i] = k
    counts[k] = (counts[k] ?? 0) + 1
  }
  const visible = count - (counts[KEY_LEVELS] ?? 0)
  let run = 0
  for (let k = 0; k < KEY_LEVELS; k++) { const c = counts[k] ?? 0; counts[k] = run; run += c }
  for (let i = 0; i < count; i++) {
    const k = keys[i] ?? KEY_LEVELS
    if (k === KEY_LEVELS) continue
    const p = counts[k] ?? 0
    out[p] = i
    counts[k] = p + 1
  }
  return visible
}

/** A stable sort of `vals` by u32 `keys` (ascending), the reference for the GPU radix sort's output. */
export function referenceOrder(keys: Uint32Array, count: number): Uint32Array {
  const idx = new Uint32Array(count)
  for (let i = 0; i < count; i++) idx[i] = i
  return idx.sort((a, b) => (keys[a] ?? 0) - (keys[b] ?? 0) || a - b)
}
