// A GPU radix sort in three.js compute nodes (TSL, WebGPU backend only): u32 keys with u32 values, ascending,
// stable, least-significant digit first, 8-bit digits, one to four passes (keyBits 8–32). The splat layer sorts every
// placed splat's view depth with it, one order across all splat items (splat-layer.ts).
//
// Per pass, three dispatches in one compute pass (each dispatch sees the previous one's writes):
//   hist     one workgroup per block of BLOCK keys: a 256-bin histogram of the digit in workgroup atomics, written to
//            hist[digit · blocks + block] (digit-major, so one exclusive scan gives every block's start per digit);
//   scan     one workgroup: thread t owns digit t, sums its blocks, a workgroup scan over the 256 totals gives the
//            digit's start, then the thread writes each block's running offset back into hist;
//   scatter  one workgroup per block, four rounds of 256 keys: every key ORs its bit into a per-digit 256-bit mask in
//            workgroup memory, its stable rank within the round is the popcount of the mask bits below it (countOneBits
//            through a WGSL helper), and the destination is the block's offset for the digit + that rank; then each
//            digit's offset moves on by the round's count.
// The input is keys[0] / vals[0]; passes ping-pong, and `output` is the values buffer holding the result. Buffers
// are padded to a multiple of BLOCK: fill the padding with the largest key so it sorts last.
import { StorageBufferAttribute, StorageInstancedBufferAttribute } from 'three/webgpu'
import type { ComputeNode, Node } from 'three/webgpu'
import { Fn, Loop, atomicAdd, atomicLoad, atomicOr, atomicStore, invocationLocalIndex, storage, uint, wgslFn, workgroupArray, workgroupBarrier, workgroupId } from 'three/tsl'
import type { ShaderNodeObject } from 'three/tsl'

export const THREADS = 256
export const PER_THREAD = 4
export const BLOCK = THREADS * PER_THREAD
const RADIX = 256
const WORDS = THREADS / 32 // mask words per digit

const popcount = wgslFn('fn midstudyPopcount(x: u32) -> u32 { return countOneBits(x); }')
const popc = (x: Node): ShaderNodeObject<Node> => popcount(x)

export const padToBlock = (n: number): number => Math.max(BLOCK, Math.ceil(n / BLOCK) * BLOCK)

export class GpuRadixSort {
  readonly capacity: number
  readonly blocks: number
  readonly passes: number
  readonly keys: readonly [StorageBufferAttribute, StorageBufferAttribute]
  readonly vals: readonly [StorageInstancedBufferAttribute, StorageInstancedBufferAttribute]
  readonly hist: StorageBufferAttribute
  /** the dispatches of a full sort, in order (run them in one renderer.compute call, after filling keys[0]/vals[0]) */
  readonly kernels: ComputeNode[]

  constructor(capacity: number, keyBits = 16) {
    this.capacity = padToBlock(capacity)
    this.blocks = this.capacity / BLOCK
    this.passes = Math.max(1, Math.min(4, Math.ceil(keyBits / 8)))
    const n = this.capacity
    this.keys = [new StorageBufferAttribute(new Uint32Array(n), 1), new StorageBufferAttribute(new Uint32Array(n), 1)]
    this.vals = [new StorageInstancedBufferAttribute(new Uint32Array(n), 1), new StorageInstancedBufferAttribute(new Uint32Array(n), 1)]
    this.hist = new StorageBufferAttribute(new Uint32Array(RADIX * this.blocks), 1)
    const keyNodes = this.keys.map((a) => storage(a, 'uint', n))
    const valNodes = this.vals.map((a) => storage(a, 'uint', n))
    const histNode = storage(this.hist, 'uint', RADIX * this.blocks)
    const blocks = this.blocks
    this.kernels = []
    for (let p = 0; p < this.passes; p++) {
      const shift = 8 * p
      const kIn = keyNodes[p % 2], kOut = keyNodes[(p + 1) % 2], vIn = valNodes[p % 2], vOut = valNodes[(p + 1) % 2]
      if (!kIn || !kOut || !vIn || !vOut) throw new Error('radix sort buffers missing')

      const hist = Fn(() => {
        const t = invocationLocalIndex
        const b = workgroupId.x
        const local = workgroupArray('atomic<u32>', RADIX)
        atomicStore(local.element(t), uint(0))
        workgroupBarrier()
        for (let r = 0; r < PER_THREAD; r++) {
          const k = kIn.element(b.mul(uint(BLOCK)).add(uint(r * THREADS)).add(t))
          atomicAdd(local.element(k.shiftRight(uint(shift)).bitAnd(uint(RADIX - 1))), uint(1))
        }
        workgroupBarrier()
        histNode.element(t.mul(uint(blocks)).add(b)).assign(atomicLoad(local.element(t)))
      })().compute(blocks * THREADS, [THREADS])
      hist.setName(`radix-hist-${p}`)

      const scan = Fn(() => {
        const t = invocationLocalIndex
        const sums = workgroupArray('uint', RADIX)
        const total = uint(0).toVar()
        Loop({ start: uint(0), end: uint(blocks), type: 'uint', condition: '<' }, ({ i }) => {
          total.addAssign(histNode.element(t.mul(uint(blocks)).add(i)))
        })
        sums.element(t).assign(total)
        workgroupBarrier()
        for (let off = 1; off < RADIX; off *= 2) { // Hillis–Steele inclusive scan
          const v = sums.element(t).toVar()
          v.addAssign(t.greaterThanEqual(uint(off)).select(sums.element(t.max(uint(off)).sub(uint(off))), uint(0)))
          workgroupBarrier()
          sums.element(t).assign(v)
          workgroupBarrier()
        }
        const run = sums.element(t).sub(total).toVar()
        Loop({ start: uint(0), end: uint(blocks), type: 'uint', condition: '<' }, ({ i }) => {
          const at = t.mul(uint(blocks)).add(i)
          const c = histNode.element(at).toVar()
          histNode.element(at).assign(run)
          run.addAssign(c)
        })
      })().compute(THREADS, [THREADS])
      scan.setName(`radix-scan-${p}`)

      const scatter = Fn(() => {
        const t = invocationLocalIndex
        const b = workgroupId.x
        const masks = workgroupArray('atomic<u32>', RADIX * WORDS)
        const base = workgroupArray('uint', RADIX)
        base.element(t).assign(histNode.element(t.mul(uint(blocks)).add(b)))
        for (let w = 0; w < WORDS; w++) atomicStore(masks.element(t.mul(uint(WORDS)).add(uint(w))), uint(0))
        workgroupBarrier()
        const word = t.shiftRight(uint(5))
        const bit = uint(1).shiftLeft(t.bitAnd(uint(31)))
        for (let r = 0; r < PER_THREAD; r++) {
          const at = b.mul(uint(BLOCK)).add(uint(r * THREADS)).add(t)
          const k = kIn.element(at).toVar()
          const v = vIn.element(at).toVar()
          const d = k.shiftRight(uint(shift)).bitAnd(uint(RADIX - 1)).toVar()
          atomicOr(masks.element(d.mul(uint(WORDS)).add(word)), bit)
          workgroupBarrier()
          const rank = popc(atomicLoad(masks.element(d.mul(uint(WORDS)).add(word))).bitAnd(bit.sub(uint(1)))).toVar()
          Loop({ start: uint(0), end: word, type: 'uint', condition: '<' }, ({ i }) => {
            rank.addAssign(popc(atomicLoad(masks.element(d.mul(uint(WORDS)).add(i)))))
          })
          const dest = base.element(d).add(rank).toVar()
          kOut.element(dest).assign(k)
          vOut.element(dest).assign(v)
          workgroupBarrier()
          const tot = uint(0).toVar()
          for (let w = 0; w < WORDS; w++) {
            const m = masks.element(t.mul(uint(WORDS)).add(uint(w)))
            tot.addAssign(popc(atomicLoad(m)))
            atomicStore(m, uint(0))
          }
          base.element(t).addAssign(tot)
          workgroupBarrier()
        }
      })().compute(blocks * THREADS, [THREADS])
      scatter.setName(`radix-scatter-${p}`)

      this.kernels.push(hist, scan, scatter)
    }
  }

  /** The values buffer holding the sorted order after the kernels ran. */
  get output(): StorageInstancedBufferAttribute {
    const out = this.vals[this.passes % 2]
    if (!out) throw new Error('no output buffer')
    return out
  }

  dispose(): void {
    for (const k of this.kernels) k.dispose()
  }
}
