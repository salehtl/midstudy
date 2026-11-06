// Capability probe for the WebGPU spike: which backend three.js picked, the adapter, and whether the TSL compute
// features the GPU radix sort needs work here (workgroup atomics, barriers, storage atomics, a WGSL helper, readback).
// Results land on window.probeResult (read by planner/gpu/demo/check.mjs).
import { StorageBufferAttribute, WebGPURenderer } from 'three/webgpu'
import { Fn, If, Loop, atomicAdd, atomicLoad, atomicOr, atomicStore, instanceIndex, invocationLocalIndex, storage, uint, wgslFn, workgroupArray, workgroupBarrier, workgroupId } from 'three/tsl'

type ProbeResult = { ok: boolean, backend: string, adapter: string, checks: Record<string, string>, error?: string }

declare global { interface Window { probeResult?: ProbeResult } }

const popc = wgslFn('fn popc(x: u32) -> u32 { return countOneBits(x); }')

async function run(): Promise<ProbeResult> {
  const forceWebGL = new URLSearchParams(location.search).get('webgl') === '1'
  const checks: Record<string, string> = {}
  let adapter = 'n/a'
  if ('gpu' in navigator) {
    const a = await navigator.gpu.requestAdapter()
    adapter = a ? `${a.info.vendor}/${a.info.architecture}/${a.info.device}/${a.info.description}` : 'no adapter'
    if (a) checks['limits'] = `wgStorage=${a.limits.maxComputeWorkgroupStorageSize} invocations=${a.limits.maxComputeInvocationsPerWorkgroup} tex2d=${a.limits.maxTextureDimension2D} storageBuf=${a.limits.maxStorageBufferBindingSize}`
    if (a) checks['features'] = [...a.features].join(',')
  }
  const renderer = new WebGPURenderer({ forceWebGL })
  await renderer.init()
  const backend = Reflect.get(renderer.backend, 'isWebGPUBackend') === true ? 'webgpu' : 'webgl2'
  if (backend !== 'webgpu') return { ok: true, backend, adapter, checks }

  // 4 workgroups of 256 threads: each counts its keys' low 4 bits in workgroup atomics, ORs a bit per thread into a
  // shared mask, then adds its counts to global atomics.
  const N = 1024
  const keys = new Uint32Array(N)
  for (let i = 0; i < N; i++) keys[i] = (i * 2654435761) >>> 0
  const keyAttr = new StorageBufferAttribute(keys, 1)
  const histAttr = new StorageBufferAttribute(new Uint32Array(16), 1)
  const rankAttr = new StorageBufferAttribute(new Uint32Array(N), 1)
  const keyBuf = storage(keyAttr, 'uint', N)
  const histBuf = storage(histAttr, 'uint', 16).toAtomic()
  const rankBuf = storage(rankAttr, 'uint', N)
  const localHist = workgroupArray('atomic<u32>', 16)
  const masks = workgroupArray('atomic<u32>', 16 * 8)
  const kernel = Fn(() => {
    const t = invocationLocalIndex
    If(t.lessThan(uint(16)), () => { atomicStore(localHist.element(t), uint(0)) })
    Loop({ start: uint(0), end: uint(8), type: 'uint', condition: '<' }, ({ i }) => {
      If(t.lessThan(uint(16)), () => { atomicStore(masks.element(t.mul(8).add(i)), uint(0)) })
    })
    workgroupBarrier()
    const key = keyBuf.element(instanceIndex)
    const d = key.bitAnd(uint(15))
    atomicAdd(localHist.element(d), uint(1))
    atomicOr(masks.element(d.mul(8).add(t.shiftRight(uint(5)))), uint(1).shiftLeft(t.bitAnd(uint(31))))
    workgroupBarrier()
    // rank of this key among the same digit in the workgroup, below this thread
    const rank = uint(0).toVar()
    const w = t.shiftRight(uint(5))
    Loop({ start: uint(0), end: w, type: 'uint', condition: '<' }, ({ i }) => {
      rank.addAssign(popc({ x: atomicLoad(masks.element(d.mul(8).add(i))) }))
    })
    const below = uint(1).shiftLeft(t.bitAnd(uint(31))).sub(uint(1))
    rank.addAssign(popc({ x: atomicLoad(masks.element(d.mul(8).add(w))).bitAnd(below) }))
    rankBuf.element(instanceIndex).assign(rank.add(workgroupId.x.mul(uint(0))))
    If(t.lessThan(uint(16)), () => { atomicAdd(histBuf.element(t), atomicLoad(localHist.element(t))) })
  })().compute(N, [256])
  const t0 = performance.now()
  await renderer.computeAsync(kernel)
  const hist = new Uint32Array(await renderer.getArrayBufferAsync(histAttr))
  const ranks = new Uint32Array(await renderer.getArrayBufferAsync(rankAttr))
  checks['computeMs'] = (performance.now() - t0).toFixed(1)
  const want = new Uint32Array(16)
  for (const k of keys) want[k & 15] = (want[k & 15] ?? 0) + 1
  checks['hist'] = hist.join(',') === want.join(',') ? 'ok' : `got ${hist.join(',')} want ${want.join(',')}`
  let bad = 0
  for (let g = 0; g < N / 256; g++) {
    const seen = new Uint32Array(16)
    for (let t = 0; t < 256; t++) {
      const i = g * 256 + t
      const d = (keys[i] ?? 0) & 15
      if (ranks[i] !== seen[d]) bad++
      seen[d] = (seen[d] ?? 0) + 1
    }
  }
  checks['ranks'] = bad === 0 ? 'ok' : `${bad} wrong`
  return { ok: checks['hist'] === 'ok' && checks['ranks'] === 'ok', backend, adapter, checks }
}

run().then((r) => { window.probeResult = r }, (e: unknown) => {
  window.probeResult = { ok: false, backend: 'error', adapter: 'n/a', checks: {}, error: e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e) }
})
