#!/usr/bin/env node
// The differential test of the room maps (contract §4.9): the Lean model (`lake exe roommodel`, Midstudy/RoomModel.lean:
// the expressions Midstudy/Room.lean proves things about, run over Float) against the TypeScript the planner uses, on
// the same seeded random inputs, passed as the exact bits of each double. Run by proofs/diff/room/run.sh.
//
//   node proofs/diff/room/harness.mjs --lean <roommodel> --out <dir> [--n N] [--seed S] [--module <path>]
//
// Checked, per input: sceneToRoom and roomToScene (each component within TOL · max(1, |value|)), rotationToScene and
// rotationToRoom (in (−180, 180], within TOL of the model's mod 360), and, on the TypeScript alone, the round trips the
// Lean proves exactly over ℝ (`Pose.roomToScene_sceneToRoom`, `rotationToRoom_rotationToScene`, …) within TOL.
// One line per check; exit 1 on any failure (the first mismatches are written to <out>/mismatches.txt).
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '../../..')

// The module under test: the app's planner/logic/room.ts since Phase C (proofs/diff/room/room_ref.mjs is §4.9 literally,
// with the same names and signatures: sceneToRoom, roomToScene, rotationToScene, rotationToRoom). MIDSTUDY_ROOM_MODULE or
// --module overrides it for one run.
const ROOM_MODULE = 'planner/logic/room.ts'

const args = process.argv.slice(2)
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : dflt
}
const LEAN = path.resolve(opt('lean', path.join(ROOT, 'proofs/.lake/build/bin/roommodel')))
const OUT = path.resolve(opt('out', path.join(ROOT, 'evals/out/proofs-diff-room')))
const N = Number(opt('n', process.env.N ?? 20000))
const SEED = Number(opt('seed', process.env.SEED ?? 20261107)) >>> 0
const MODULE = opt('module', process.env.MIDSTUDY_ROOM_MODULE ?? ROOM_MODULE)
const TOL = Number(process.env.MIDSTUDY_ROOM_TOL ?? 1e-9)

// --- the module under test, bundled (the planner's .js specifiers name .ts files; esbuild resolves them) -------------
const bundled = await build({
  stdin: { contents: `export { sceneToRoom, roomToScene, rotationToScene, rotationToRoom } from './${MODULE}'`, resolveDir: ROOT, loader: 'js' },
  bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent',
})
fs.mkdirSync(OUT, { recursive: true })
const bundlePath = path.join(OUT, 'room-bundle.mjs')
fs.writeFileSync(bundlePath, bundled.outputFiles[0].text)
const M = await import(bundlePath)

// --- seeded inputs ---------------------------------------------------------------------------------------------------
let state = SEED || 1
function rnd() { // mulberry32
  state = (state + 0x6d2b79f5) >>> 0
  let t = state
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
const uni = (lo, hi) => lo + (hi - lo) * rnd()
const SPECIAL_DEG = [0, -0, 90, -90, 180, -180, 45, -45, 179.999999, -179.999999, 180.000001, -180.000001, 1e-9, -1e-9,
  360, -360, 540, -540, 720.5, -720.5, 30, 1e6 + 0.25, -1e6 - 0.25, 359.9999999999, 0.1 + 0.2]
function deg() {
  const r = rnd()
  if (r < 0.2) return pick(SPECIAL_DEG)
  if (r < 0.35) return Math.round(uni(-720, 720))
  if (r < 0.85) return uni(-180, 180)
  return uni(-5000, 5000)
}
function coord(lim) {
  const r = rnd()
  if (r < 0.1) return pick([0, -0, 1, -1, 0.5, lim, -lim, 1e-12])
  if (r < 0.2) return uni(-1e-3, 1e-3)
  if (r < 0.3) return uni(-1000, 1000)
  return uni(-lim, lim)
}
const pose = () => ({ x_m: coord(50), z_m: coord(50), yaw_deg: deg() })
const point = () => [coord(60), rnd() < 0.3 ? 0 : uni(-1, 3.5), coord(60)]

const buf = new DataView(new ArrayBuffer(8))
const bits = (x) => { buf.setFloat64(0, x); return buf.getBigUint64(0).toString(16).padStart(16, '0') }
const unbits = (h) => { buf.setBigUint64(0, BigInt(`0x${h}`)); return buf.getFloat64(0) }

const cases = []
for (let i = 0; i < N; i++) {
  const P = pose()
  cases.push({ op: 's2r', p: point(), P }, { op: 'r2s', p: point(), P: pose() }, { op: 'rts', d: deg(), P }, { op: 'rtr', d: deg(), P: pose() })
}
const lines = cases.map((c, i) => {
  const nums = c.op === 's2r' || c.op === 'r2s' ? [...c.p, c.P.x_m, c.P.z_m, c.P.yaw_deg] : [c.d, c.P.yaw_deg]
  return `${String(i)}\t${c.op}\t${nums.map(bits).join(',')}`
})
const corpus = path.join(OUT, 'corpus.tsv')
fs.writeFileSync(corpus, `${lines.join('\n')}\n`)

// --- the Lean model --------------------------------------------------------------------------------------------------
const lean = spawnSync(LEAN, [corpus], { encoding: 'utf8', maxBuffer: 1 << 30 })
if (lean.status !== 0) {
  console.error(`roommodel failed (${String(lean.status)}): ${lean.stderr}`)
  process.exit(1)
}
const leanOut = lean.stdout.trim().split('\n').map((l) => l.split('\t')[2].split(',').map(unbits))
if (leanOut.length !== cases.length) {
  console.error(`roommodel answered ${String(leanOut.length)} lines for ${String(cases.length)} inputs`)
  process.exit(1)
}
fs.writeFileSync(path.join(OUT, 'lean.tsv'), lean.stdout)

// --- compare -----------------------------------------------------------------------------------------------------------
const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= TOL * Math.max(1, Math.abs(a), Math.abs(b))
const inRange = (a) => a > -180 && a <= 180
const angleClose = (a, b) => {
  const d = Math.abs(a - b)
  return d <= TOL * Math.max(1, Math.abs(a)) || Math.abs(d - 360) <= TOL * 360
}
const groups = new Map()
const mismatches = []
function tally(name, ok, detail) {
  const g = groups.get(name) ?? { n: 0, bad: 0, exact: 0, maxErr: 0 }
  g.n++
  if (!ok) { g.bad++; if (mismatches.length < 200) mismatches.push(`${name}\t${detail}`) }
  groups.set(name, g)
  return g
}
const fmt = (xs) => JSON.stringify(xs)
for (let i = 0; i < cases.length; i++) {
  const c = cases[i]
  const want = leanOut[i]
  if (c.op === 's2r' || c.op === 'r2s') {
    const f = c.op === 's2r' ? M.sceneToRoom : M.roomToScene
    const back = c.op === 's2r' ? M.roomToScene : M.sceneToRoom
    const got = f(c.p, c.P)
    const ok = got.length === 3 && got.every((g, k) => close(g, want[k]))
    const g = tally(c.op === 's2r' ? 'sceneToRoom' : 'roomToScene', ok, `p=${fmt(c.p)} pose=${fmt(c.P)} ts=${fmt(got)} lean=${fmt(want)}`)
    if (ok && got.every((v, k) => Object.is(v, want[k]))) g.exact++
    if (ok) g.maxErr = Math.max(g.maxErr, ...got.map((v, k) => Math.abs(v - want[k]) / Math.max(1, Math.abs(want[k]))))
    // the round trip the Lean proves exactly (Pose.roomToScene_sceneToRoom / sceneToRoom_roomToScene), here in floats;
    // the error of a round trip grows with the distance between the point and the pose's origin
    const rt = back(got, c.P)
    const scale = Math.max(1, ...c.p.map(Math.abs), Math.abs(c.P.x_m), Math.abs(c.P.z_m))
    tally(`${c.op === 's2r' ? 'roomToScene∘sceneToRoom' : 'sceneToRoom∘roomToScene'} = id`,
      rt.every((v, k) => Math.abs(v - c.p[k]) <= TOL * scale), `p=${fmt(c.p)} pose=${fmt(c.P)} back=${fmt(rt)}`)
    tally('height unchanged', Object.is(got[1], c.p[1]) || got[1] === c.p[1], `p=${fmt(c.p)} pose=${fmt(c.P)} got=${fmt(got)}`)
  } else {
    const f = c.op === 'rts' ? M.rotationToScene : M.rotationToRoom
    const back = c.op === 'rts' ? M.rotationToRoom : M.rotationToScene
    const got = f(c.d, c.P)
    const ok = inRange(got) && angleClose(got, want[0])
    const g = tally(c.op === 'rts' ? 'rotationToScene' : 'rotationToRoom', ok, `d=${String(c.d)} pose=${fmt(c.P)} ts=${String(got)} lean=${String(want[0])}`)
    if (ok && Object.is(got, want[0])) g.exact++
    // rotationToRoom_rotationToScene / rotationToScene_rotationToRoom: back to wrapDeg(d)
    const rt = back(got, c.P)
    const wd = c.d - 360 * Math.round(c.d / 360)
    tally(`${c.op === 'rts' ? 'rotationToRoom∘rotationToScene' : 'rotationToScene∘rotationToRoom'} = wrapDeg`,
      inRange(rt) && angleClose(rt, wd), `d=${String(c.d)} pose=${fmt(c.P)} back=${String(rt)}`)
  }
}
fs.writeFileSync(path.join(OUT, 'mismatches.txt'), mismatches.join('\n') + (mismatches.length ? '\n' : ''))
let failed = false
console.log(`room maps: ${MODULE} against lake exe roommodel, ${String(N)} cases per map, seed ${String(SEED)}, tolerance ${String(TOL)}`)
for (const [name, g] of groups) {
  const exact = name === 'sceneToRoom' || name === 'roomToScene' || name.startsWith('rotationTo') && !name.includes('∘')
    ? `, ${String(g.exact)} bit for bit${g.maxErr > 0 ? `, largest difference ${g.maxErr.toExponential(1)} (relative to max(1, |value|))` : ''}` : ''
  console.log(`  ${g.bad === 0 ? 'ok  ' : 'FAIL'} ${name}: ${String(g.n - g.bad)}/${String(g.n)}${exact}`)
  if (g.bad) failed = true
}
if (failed) console.log(`  mismatches: ${path.join(OUT, 'mismatches.txt')}`)
process.exit(failed ? 1 : 0)
