// Typed arrays (depth maps, masks, pixels).
export function maxDepth(depth: Uint16Array): number {
  let m = 0
  for (let i = 0; i < depth.length; i++) {
    const v = depth[i]
    if (v !== undefined && v > m) m = v
  }
  return m
}

export function scaled(src: Float32Array, k: number): Float32Array {
  const out = new Float32Array(src.length)
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v !== undefined) out[i] = v * k
  }
  return out
}

export function redAt(px: Uint8ClampedArray, w: number, x: number, y: number): number {
  return px[(y * w + x) * 4] ?? 0
}

export function maskCount(mask: Uint8Array): number {
  let n = 0
  for (const v of mask) if (v > 127) n++
  return n
}
