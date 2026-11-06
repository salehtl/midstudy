// Times the strip kernels through core/js/node.ts (wasm in Node): `node core/crates/wasm-node/js-test/bench.ts <op>
// <file> [runs]`, op jpeg | png | glb | glb-in-place, or jpeg-pieces | png-pieces (the zero-copy pieces, not joined). Median and fastest of `runs` (default 15) after one warm-up, in ms,
// including the copies into and out of wasm memory. Only for docs/notes/k-media.md.
import { readFileSync } from 'node:fs'
import { stripGlb, stripJpeg, stripJpegPieces, stripPng, stripPngPieces } from '../../../js/node.ts'

const [op = '', file = '', runsArg = '15'] = process.argv.slice(2)
const data = new Uint8Array(readFileSync(file))
const run = (): number => {
  if (op === 'jpeg-pieces' || op === 'png-pieces') {
    const p = op === 'jpeg-pieces' ? stripJpegPieces(data) : stripPngPieces(data)
    if (!p.ok) throw new Error(`${op} ${file}: ${p.error.message}`)
    return p.value.length
  }
  const r = op === 'jpeg' ? stripJpeg(data) : op === 'png' ? stripPng(data) : op === 'glb' ? stripGlb(data) : stripGlb(data, { layout: 'in-place' })
  if (!r.ok) throw new Error(`${op} ${file}: ${r.error.message}`)
  return r.value.bytes.length
}
const outBytes = run()
const times: number[] = []
for (let i = 0; i < Math.max(1, Number(runsArg)); i++) {
  const t = performance.now()
  run()
  times.push(performance.now() - t)
}
times.sort((a, b) => a - b)
const median = times[Math.floor(times.length / 2)] ?? 0
const best = times[0] ?? 0
console.log(JSON.stringify({ op, file, bytes: data.length, out_bytes: outBytes, runs: times.length, median_ms: Number(median.toFixed(3)), best_ms: Number(best.toFixed(3)) }))
