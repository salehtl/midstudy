// A stand-in for `midstudy-calib` in the rooms tests (server/test/rooms.test.ts): `align-room` answers exactly as the
// contract's mock does (§4.9 Mock: MIDSTUDY_CALIB_MOCK=<dir> looks up <dir>/rooms/<key>/align.json, renames its members
// to the folders given, re-expresses the poses relative to the first one; no match: solver "none", the first folder
// the frame, every other one unplaced); every other command is fixtures/stub_calib.py's (JPEG pass-through ingest and
// the mock fit). Server: `--calib "node server/test/rooms-calib.ts"`.
//
//   ROOMS_CALIB_LOG=<file>          each start is logged as one JSON line {argv, pid} (and each worker request {request})
//   ROOMS_CALIB_DELAY_MS=<n>        run and fit wait this long first (to keep a member calibrating)
//   ROOMS_CALIB_ALIGN_DELAY_MS=<n>  align-room waits this long first
//   ROOMS_CALIB_ALIGN_FAIL=1        align-room fails: {"ok": false, "error": "the photos don't overlap"}, exit 1
//   ROOMS_CALIB_ALIGN_OFF_CONTRACT=1   align-room's answer lacks `solver` (breaks calib-cli.schema.json)
//   ROOMS_CALIB_SERVE=1             `serve` answers requests as the worker (default: exits 2, as the stub)
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'

const REPO = path.resolve(import.meta.dirname, '../..')
const log = process.env['ROOMS_CALIB_LOG'] ?? ''
function note(entry: unknown): void {
  if (log !== '') fs.appendFileSync(log, JSON.stringify(entry) + '\n')
}

function sleep(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

type Rec = Record<string, unknown>
function isRec(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

interface Result {
  readonly code: number
  readonly line: Rec
  readonly stderr: string
}

/** fixtures/stub_calib.py's answer to `cmd args`. */
function stub(cmd: string, args: readonly string[]): Result {
  if (cmd === 'run' || cmd === 'fit') sleep(Number(process.env['ROOMS_CALIB_DELAY_MS'] ?? '0'))
  const r = spawnSync('python3', ['fixtures/stub_calib.py', cmd, ...args], { cwd: REPO, encoding: 'utf8', env: process.env })
  const lines = r.stdout.trim().split('\n')
  let line: Rec = { ok: false, error: 'the stub printed no result' }
  try {
    const v: unknown = JSON.parse(lines[lines.length - 1] ?? '')
    if (isRec(v)) line = v
  } catch {
    // keep the error line
  }
  return { code: r.status ?? 1, line, stderr: r.stderr }
}

function fail(error: string): Result {
  return { code: 1, line: { ok: false, error }, stderr: 'midstudy-calib: ' + error + '\n' }
}

function sha256(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function round6(x: number): number {
  const r = Math.round(x * 1e6) / 1e6
  return r === 0 ? 0 : r
}

function wrap(yaw: number): number {
  const w = round6((((yaw + 180) % 360) + 360) % 360 - 180)
  return w <= -180 ? 180 : w
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

/** `align-room <dirs> --out <room-dir> [--solver s] [--device d]` with the §4.9 mock. */
function alignRoom(args: readonly string[]): Result {
  sleep(Number(process.env['ROOMS_CALIB_ALIGN_DELAY_MS'] ?? '0'))
  if (process.env['ROOMS_CALIB_ALIGN_FAIL'] === '1') return fail("the photos don't overlap")
  const dirs: string[] = []
  let out = ''
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? ''
    if (a === '--out') out = args[++i] ?? ''
    else if (a === '--solver' || a === '--device') i++
    else dirs.push(a)
  }
  if (out === '') return fail('--out is required')
  if (dirs.length < 2) return fail('align-room needs at least two scene folders')
  for (const d of dirs) if (!fs.existsSync(path.join(d, 'photo.jpg'))) return fail(path.basename(d) + ' has no photo.jpg')
  const shas = dirs.map((d) => sha256(path.join(d, 'photo.jpg')))
  const key = createHash('sha256').update([...shas].sort().join('\n'), 'utf8').digest('hex')
  const mock = process.env['MIDSTUDY_CALIB_MOCK'] ?? ''
  const file = path.join(path.resolve(REPO, mock), 'rooms', key, 'align.json')
  const created = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')
  let answer: Rec
  if (mock !== '' && fs.existsSync(file)) {
    const fixture: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!isRec(fixture) || !Array.isArray(fixture['members'])) return fail('the mock answer is unreadable')
    const bySha = new Map<string, Rec>()
    for (const m of fixture['members']) if (isRec(m) && typeof m['photo_sha256'] === 'string') bySha.set(m['photo_sha256'], m)
    const first = bySha.get(shas[0] ?? '')
    const fp = first === undefined ? null : first['pose']
    if (first === undefined || !isRec(fp)) return fail('the mock answer leaves the first photo unplaced')
    const ax = num(fp['x_m'])
    const az = num(fp['z_m'])
    const ayaw = num(fp['yaw_deg'])
    const as = num(first['scale'])
    const a = (ayaw * Math.PI) / 180
    const members = dirs.map((d, i) => {
      const m = bySha.get(shas[i] ?? '') ?? {}
      const p = m['pose']
      const base = { scene: path.basename(d), photo_sha256: shas[i] }
      if (!isRec(p) || typeof m['scale'] !== 'number') return { ...base, pose: null, scale: null, confidence: 0, residual_cm: null }
      const dx = num(p['x_m']) - ax
      const dz = num(p['z_m']) - az
      // Ry(−a) · (dx, 0, dz) / s_a
      const x = (Math.cos(a) * dx - Math.sin(a) * dz) / as
      const z = (Math.sin(a) * dx + Math.cos(a) * dz) / as
      const pose = i === 0 ? { x_m: 0, z_m: 0, yaw_deg: 0 } : { x_m: round6(x), z_m: round6(z), yaw_deg: wrap(num(p['yaw_deg']) - ayaw) }
      return { ...base, pose, scale: i === 0 ? 1 : round6(m['scale'] / as), confidence: i === 0 ? 1 : num(m['confidence']), residual_cm: i === 0 ? null : m['residual_cm'] ?? null }
    })
    answer = { ...fixture, created, members, unplaced: members.filter((m) => m.pose === null).map((m) => m.scene) }
  } else {
    const members = dirs.map((d, i) => ({
      scene: path.basename(d), photo_sha256: shas[i], pose: i === 0 ? { x_m: 0, z_m: 0, yaw_deg: 0 } : null, scale: i === 0 ? 1 : null,
      confidence: i === 0 ? 1 : 0, residual_cm: null,
    }))
    answer = { version: 1, solver: 'none', created, elapsed_s: 0, device: null, loop_residual_cm: null, members, unplaced: members.slice(1).map((m) => m.scene) }
  }
  if (process.env['ROOMS_CALIB_ALIGN_OFF_CONTRACT'] === '1') Reflect.deleteProperty(answer, 'solver')
  fs.mkdirSync(out, { recursive: true })
  const tmp = path.join(out, '.align.json.tmp')
  fs.writeFileSync(tmp, JSON.stringify(answer, null, 2) + '\n')
  fs.renameSync(tmp, path.join(out, 'align.json'))
  return { code: 0, line: { ...answer, ok: true }, stderr: 'midstudy-calib: aligned ' + String(dirs.length) + ' photos (mock)\n' }
}

function answer(cmd: string, args: readonly string[]): Result {
  return cmd === 'align-room' ? alignRoom(args) : stub(cmd, args)
}

const [cmd = '', ...args] = process.argv.slice(2)
note({ argv: [cmd, ...args], pid: process.pid })

if (cmd !== 'serve') {
  const r = answer(cmd, args)
  process.stderr.write(r.stderr)
  process.stdout.write(JSON.stringify(r.line) + '\n')
  process.exit(r.code)
}
if (process.env['ROOMS_CALIB_SERVE'] !== '1') {
  process.stderr.write("usage: midstudy-calib [-h] {run,ingest,fit,light,align,align-room} ...\nmidstudy-calib: error: argument cmd: invalid choice: 'serve'\n")
  process.exit(2)
}
const rl = readline.createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const req: unknown = JSON.parse(line)
  note({ request: req })
  if (!isRec(req)) return
  const reqArgs = Array.isArray(req['args']) ? req['args'].filter((a): a is string => typeof a === 'string') : []
  const r = answer(typeof req['cmd'] === 'string' ? req['cmd'] : '', reqArgs)
  process.stderr.write(r.stderr)
  process.stdout.write(JSON.stringify({ id: req['id'], ...r.line }) + '\n')
})
rl.on('close', () => {
  process.exit(0)
})
