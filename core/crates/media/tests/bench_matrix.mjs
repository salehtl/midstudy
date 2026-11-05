// The media benchmark matrix (docs/notes/kernels-hardening.md): v1's Python, the native Rust and the wasm kernels in
// Node through core/js/node.ts, on the files tests/bench_inputs.py writes. Rounds are interleaved (each round runs every
// implementation on every file once, each run a median of RUNS strips after a warm-up), so an A/B of two builds sees
// the same machine load; the result is the median of the rounds' medians, in ms, the input already in memory.
//
//   nix develop -c evals/py core/crates/media/tests/bench_inputs.py
//   nix develop -c node scripts/eval-lock.mjs --exclusive -- node core/crates/media/tests/bench_matrix.mjs \
//       [--rounds 3] [--runs 15] [--no-default] [--impl name=cmd ...] [--only op:file] [--out evals/out/kh/media-bench.json]
//
// Default implementations: v1 (evals/py tests/bench_v1.py), native (core/target/release/examples/bench-media) and wasm
// (node core/crates/wasm-node/js-test/bench.ts); --no-default keeps only v1. `--impl name=cmd` adds one (a command taking `<op> <file> <runs>` and
// printing bench.ts's JSON line), e.g. `--impl wasm-before=node evals/out/kh/before/core/crates/wasm-node/js-test/bench.ts`.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '../../../..')
const IN = path.join(REPO, 'evals/out/kh/bench-inputs')
const argv = process.argv.slice(2)
const opt = (k, d) => (argv.includes(k) ? argv[argv.indexOf(k) + 1] : d)
const ROUNDS = Number(opt('--rounds', 3))
const RUNS = Number(opt('--runs', 15))
const OUT = path.resolve(REPO, opt('--out', 'evals/out/kh/media-bench.json'))
const ONLY = opt('--only', '')

const impls = [
  ['v1', ['evals/py', 'core/crates/media/tests/bench_v1.py']],
  ...(argv.includes('--no-default') ? [] : [
    ['native', ['core/target/release/examples/bench-media']],
    ['wasm', ['node', 'core/crates/wasm-node/js-test/bench.ts']],
  ]),
]
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--impl') continue
  const [name, ...cmd] = (argv[i + 1] ?? '').split(/[= ]/)
  if (name && cmd.length) impls.push([name, cmd])
}
const cases = [
  ['jpeg', 'big12mp.jpg', 'smooth 12 MP JPEG (metadata.py big12mp)'],
  ['jpeg', 'prog12mp-gps.jpg', 'smooth progressive 12 MP JPEG + EXIF/GPS'],
  ['jpeg', 'photo12mp-gps.jpg', 'photo-like 12 MP JPEG q92 + EXIF/GPS'],
  ['jpeg', 'photo12mp-trailer.jpg', 'the same + 200 KB after EOI'],
  ['png', 'png3mp-exif.png', 'noisy 3 MP PNG + eXIf'],
  ['glb', 'glb-photo.glb', 'GLB textured with the 12 MP photo (compact)'],
  ['glb-in-place', 'glb-photo.glb', 'the same, in place'],
  ['glb', 'SheenChair.glb', 'SheenChair.glb (7 PNG textures, nothing to strip)'],
  ['glb', 'gps.glb', "metadata.py's gps-glb (2.7 KB)"],
].filter(([op, file]) => !ONLY || `${op}:${file}`.includes(ONLY))

for (const [, file] of cases) {
  if (!fs.existsSync(path.join(IN, file))) {
    console.error(`bench_matrix: ${path.join(IN, file)} is missing: run core/crates/media/tests/bench_inputs.py first`)
    process.exit(2)
  }
}
const samples = new Map()
for (let r = 0; r < ROUNDS; r++) {
  for (const [op, file] of cases) {
    for (const [name, cmd] of impls) {
      const v1op = name === 'v1' && op === 'glb-in-place' ? 'glb' : op // v1 only had the in-place layout
      const p = spawnSync(cmd[0], [...cmd.slice(1), v1op, path.join(IN, file), String(RUNS)], { cwd: REPO, encoding: 'utf8' })
      const line = (p.stdout || '').trim().split('\n').at(-1) ?? ''
      let ms = null
      try { ms = JSON.parse(line).median_ms } catch { console.error(`${name} ${op} ${file}: ${(p.stderr || line).slice(-400)}`) }
      const key = `${op}\t${file}\t${name}`
      if (!samples.has(key)) samples.set(key, [])
      if (ms !== null) samples.get(key).push(ms)
    }
  }
}
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const rows = []
console.log(`${'case'.padEnd(52)} ${impls.map(([n]) => n.padStart(13)).join(' ')}`)
for (const [op, file, label] of cases) {
  const row = { op, file, label, ms: {} }
  for (const [name] of impls) row.ms[name] = med(samples.get(`${op}\t${file}\t${name}`) ?? [])
  rows.push(row)
  console.log(`${`${label} [${op}]`.slice(0, 52).padEnd(52)} ${impls.map(([n]) => (row.ms[n] === null ? '-' : row.ms[n].toFixed(3)).padStart(13)).join(' ')}`)
}
const meta = { date: new Date().toISOString(), node: process.version, load: os.loadavg(), cpus: os.cpus().length, rounds: ROUNDS, runs: RUNS, impls: Object.fromEntries(impls) }
fs.mkdirSync(path.dirname(OUT), { recursive: true })
fs.writeFileSync(OUT, JSON.stringify({ meta, rows }, null, 1))
console.log(`load ${meta.load.map((v) => v.toFixed(1)).join(' ')}; written to ${path.relative(REPO, OUT)}`)
