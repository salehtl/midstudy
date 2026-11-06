// depth.png (contract §4.2: 16-bit grayscale PNG, mm along the view axis) → metres, as engine.js loadDepth does
// (browsers decode PNGs to 8 bits). Demo-only: v2's engine gets this from the Rust depth-decode kernel (k-geom).
export interface DepthMap { w: number, h: number, data: Float32Array }

export async function decodeDepthPng(bytes: Uint8Array): Promise<DepthMap> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const sig = [137, 80, 78, 71, 13, 10, 26, 10]
  if (!sig.every((v, i) => bytes[i] === v)) throw new Error('depth.png is not a PNG')
  let w = 0, h = 0, bitDepth = 0, colorType = 0, interlace = 0
  const idat: Uint8Array[] = []
  for (let o = 8; o + 8 <= bytes.length;) {
    const n = dv.getUint32(o)
    const type = String.fromCharCode(bytes[o + 4] ?? 0, bytes[o + 5] ?? 0, bytes[o + 6] ?? 0, bytes[o + 7] ?? 0)
    const data = bytes.subarray(o + 8, o + 8 + n)
    if (type === 'IHDR') { w = dv.getUint32(o + 8); h = dv.getUint32(o + 12); bitDepth = data[8] ?? 0; colorType = data[9] ?? 0; interlace = data[12] ?? 0 }
    else if (type === 'IDAT') idat.push(data)
    else if (type === 'IEND') break
    o += 12 + n
  }
  if (!w || !h || colorType !== 0 || interlace || (bitDepth !== 16 && bitDepth !== 8)) throw new Error(`depth.png must be a 16-bit grayscale PNG (colour type ${colorType}, ${bitDepth} bits)`)
  const parts = idat.map((d) => { const c = new Uint8Array(d.byteLength); c.set(d); return c })
  const raw = new Uint8Array(await new Response(new Blob(parts).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer())
  const bpp = bitDepth / 8
  const stride = w * bpp
  const out = new Float32Array(w * h)
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride)
  for (let y = 0; y < h; y++) {
    const off = y * (stride + 1)
    const ft = raw[off] ?? 0
    for (let i = 0; i < stride; i++) {
      const x = raw[off + 1 + i] ?? 0
      const a = i >= bpp ? (cur[i - bpp] ?? 0) : 0, b = prev[i] ?? 0, c = i >= bpp ? (prev[i - bpp] ?? 0) : 0
      let v: number
      if (ft === 0) v = x
      else if (ft === 1) v = x + a
      else if (ft === 2) v = x + b
      else if (ft === 3) v = x + ((a + b) >> 1)
      else { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) }
      cur[i] = v & 255
    }
    for (let x = 0; x < w; x++) out[y * w + x] = (bpp === 2 ? ((cur[2 * x] ?? 0) << 8) | (cur[2 * x + 1] ?? 0) : (cur[x] ?? 0)) / 1000
    const t = prev; prev = cur; cur = t
  }
  return { w, h, data: out }
}
