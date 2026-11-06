// E10 eval:all — runs E1 and E3–E9 one after another (PLAN.md §6.2), then E11 and E12 (the verify round 1 and 2 UX regressions), E13 (v1.1 splats), E14 and E15 (product page reader and form),
// E16 (lighting inferred from the photo), E17 (shortcuts, multi-select, Export),
// and E2 (real MoGe, then --mock) only with --with-calib. Each eval starts and stops its own server on a free port. Prints a summary; exits 1 if any failed.
// Usage: node evals/all.mjs [--with-calib] [--only E3,E4]   (or npm run eval:all [-- --with-calib])
import { spawn } from 'node:child_process'
import path from 'node:path'

const REPO = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const withCalib = args.includes('--with-calib')
const onlyArg = args.find((a) => a.startsWith('--only'))
const only = onlyArg ? (onlyArg.includes('=') ? onlyArg.split('=')[1] : args[args.indexOf(onlyArg) + 1] || '').split(',').map((s) => s.trim().toUpperCase()) : null
const steps = [
  ['E1', 'scenes-api', 'node', ['evals/scenes_api.mjs']],
  ...(withCalib ? [['E2', 'calib (real MoGe)', 'evals/py', ['evals/calib_eval.py']], ['E2', 'calib --mock', 'evals/py', ['evals/calib_eval.py', '--mock']]] : []),
  ['E3', 'planner', 'node', ['evals/planner_scene.mjs']],
  ['E4', 'occlusion', 'node', ['evals/occlusion.mjs']],
  ['E5', 'floor', 'node', ['evals/floor.mjs']],
  ['E6', 'render', 'node', ['evals/render.mjs']],
  ['E7', 'library', 'bash', ['evals/library_api.sh']],
  ['E8', 'pipeline', 'bash', ['evals/pipeline_offline.sh']],
  ['E9', 'phone', 'node', ['evals/phone.mjs']],
  ['E11', 'ux', 'node', ['evals/ux_fixes.mjs']],
  ['E12', 'ux2', 'node', ['evals/ux_round2.mjs']],
  ['E13', 'splat', 'node', ['evals/splat.mjs']],
  ['E14', 'product', 'node', ['evals/product_extract.mjs']],
  ['E15', 'product-ui', 'node', ['evals/product_ui.mjs']],
  ['E16', 'lighting', 'node', ['evals/lighting.mjs']],
  ['E17', 'keys', 'node', ['evals/keys_export.mjs']],
].filter(([id]) => !only || only.includes(id))

const run = (cmd, argv) => new Promise((resolve) => {
  const t0 = Date.now()
  let tail = ''
  const p = spawn(cmd, argv, { cwd: REPO, stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  const onData = (stream) => (d) => { stream.write(d); tail = (tail + d).slice(-4000) }
  p.stdout.on('data', onData(process.stdout))
  p.stderr.on('data', onData(process.stderr))
  p.on('error', (e) => resolve({ code: 127, secs: 0, line: String(e) }))
  p.on('exit', (code, sig) => {
    const line = tail.split('\n').reverse().find((l) => /(checks passed|checks passed in|\d+\/\d+)/.test(l)) || ''
    resolve({ code: code ?? (sig ? 1 : 0), secs: ((Date.now() - t0) / 1000).toFixed(0), line: line.trim() })
  })
})

const summary = []
for (const [id, name, cmd, argv] of steps) {
  console.log(`\n=================== ${id} eval:${name} (${[cmd, ...argv].join(' ')})`)
  const r = await run(cmd, argv)
  summary.push({ id, name, ...r })
}
console.log('\n=================== summary')
for (const s of summary) console.log(`${s.code === 0 ? 'PASS' : 'FAIL'} ${s.id} ${s.name.padEnd(20)} ${String(s.secs).padStart(4)} s  ${s.line}`)
if (!withCalib && !only) console.log('     (E2 eval:calib not run: add --with-calib for real MoGe and the ingest checks)')
process.exit(summary.every((s) => s.code === 0) ? 0 : 1)
