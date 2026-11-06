// E20 eval:align — `midstudy-calib align-room` (contract §4.3, §4.9 Align and Mock; docs/ROOMS.md §5 Phase B). No server.
// Written from the contract only (it never reads calib/ source). Two modes:
//
//   node evals/align_eval.mjs --mock [--cli "CMD"]   the plumbing, $0 and seconds (in eval:all). CMD defaults to the stub
//       (python3 fixtures/stub_calib.py); --cli "uv run --project calib midstudy-calib" checks the real CLI's mock.
//       With MIDSTUDY_CALIB_MOCK: the key, the rename to the scene folders, argument order, every pose and scale
//       re-expressed relative to the first argument (yaw wrap, scales, positions ÷ s_a), copied fields, a mock miss
//       (solver none), an unplaced first argument (a failure) and an unplaced other member, the failures (one folder, a
//       folder without photo.jpg), the output contract (last stdout line = align.json + ok, stderr's last line), the
//       files (only <out>/align.json, created when missing, replaced atomically; the scenes untouched), the schemas;
//       the worker command ({"cmd": "align-room"} through `serve`), or, for the stub, that it has no `serve` (exit 2).
//   node evals/align_eval.mjs [--cli "CMD"] [--solver auto] [--expect-solver mast3r]   the real solver (in eval:calib):
//       the same plumbing against the real CLI, then the golden room fixtures' own photo.jpg, calib.json and depth.png
//       (no MoGe) with MIDSTUDY_CALIB_MOCK unset: the seven photos (living-wide first) at the Phase A targets (each
//       placed photo within 5 cm, 1.5°, 2 % of truth, at most one unplaced, none placed wrong with confidence ≥ 0.5),
//       `--solver auto` picks the learned solver chosen at Gate A (MASt3R), the hard pairs (little overlap, a bare
//       wall) are never placed wrong with confidence ≥ 0.5, and `--solver manhattan` answers without ML. Run times are
//       reported (Gate A measured ~1 min for 7 photos on MPS).
// Output: evals/out/align-mock/ or evals/out/align/. Nothing from fixtures/photos/ is read.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { REPO, createEval, golden, fmt, clip } from './lib/harness.mjs'
import { ISO_RE, sha256File, mockKey, reexpress, poseErr, fileViolation, TARGETS } from './lib/rooms.mjs'

const argv = process.argv.slice(2)
const MOCK_MODE = argv.includes('--mock')
const opt = (name, dflt) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt }
const STUB = 'python3 fixtures/stub_calib.py'
const REAL = 'uv run --project calib midstudy-calib'
const CLI = opt('--cli', MOCK_MODE ? STUB : REAL)
const IS_STUB = /stub_calib\.py/.test(CLI)
const SOLVER = opt('--solver', 'auto')
const EXPECT_SOLVER = opt('--expect-solver', 'mast3r') // Gate A, docs/ROOMS.md §2
const ev = createEval('E20', MOCK_MODE ? 'align-mock' : 'align', { timeoutS: MOCK_MODE ? 300 : 1800 })
ev.note(`align-room through: ${CLI}${MOCK_MODE ? ' (mock mode)' : ` (real solver, --solver ${SOLVER})`}`)

// --- inputs -----------------------------------------------------------------------------------------------------------------------
const IDS = ['living-wide', 'room-1', 'room-2', 'room-3', 'room-4', 'room-5', 'room-6']
const T = Object.fromEntries(IDS.map((id) => { const g = golden(id); return [id, { ...g, pose: g.truth.pose_in_room || { x_m: 0, z_m: 0, yaw_deg: 0 }, sha: sha256File(g.photo) }] }))
// Scene folders named unlike the fixtures (the mock must rename), with the files align-room reads.
const SCENES = path.join(ev.out, 'scenes')
const folder = (id) => path.join(SCENES, `photo-${id}`)
for (const id of IDS) {
  fs.mkdirSync(folder(id), { recursive: true })
  for (const f of ['photo.jpg', 'calib.json', 'depth.png']) fs.copyFileSync(path.join(T[id].dir, f), path.join(folder(id), f))
}
fs.mkdirSync(path.join(SCENES, 'no-photo'), { recursive: true })
fs.copyFileSync(path.join(T['living-wide'].dir, 'calib.json'), path.join(SCENES, 'no-photo', 'calib.json'))
const snapshot = () => Object.fromEntries(fs.readdirSync(SCENES).flatMap((d) => fs.readdirSync(path.join(SCENES, d)).map((f) => [`${d}/${f}`, sha256File(path.join(SCENES, d, f))])))
const scenesBefore = snapshot()

// A mock dir of our own: the golden answers plus crafted ones (scales ≠ 1, an unplaced member, extra keys).
const MOCK = path.join(ev.out, 'calib-mock')
fs.cpSync(path.join(REPO, 'fixtures/calib/rooms'), path.join(MOCK, 'rooms'), { recursive: true })
const crafted = (ids, members, extra = {}) => {
  const dir = path.join(MOCK, 'rooms', mockKey(ids.map((id) => T[id].sha)))
  fs.mkdirSync(dir, { recursive: true })
  const body = { version: 1, solver: 'mast3r', created: '2026-11-06T00:00:00Z', elapsed_s: 12.5, device: 'mps', loop_residual_cm: 1.25, members, unplaced: members.filter((m) => !m.pose).map((m) => m.scene), ...extra }
  fs.writeFileSync(path.join(dir, 'align.json'), JSON.stringify(body, null, 2))
  return body
}
const SCALED = crafted(['living-wide', 'room-5'], [
  { scene: 'living-wide', photo_sha256: T['living-wide'].sha, pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1, confidence: 1, residual_cm: null },
  { scene: 'room-5', photo_sha256: T['room-5'].sha, pose: { x_m: 1.9, z_m: -1.3, yaw_deg: 62 }, scale: 1.1, confidence: 0.8, residual_cm: 2.5 }], { diagnostics: { note: 'kept' } })
crafted(['living-wide', 'room-3'], [
  { scene: 'living-wide', photo_sha256: T['living-wide'].sha, pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1, confidence: 1, residual_cm: null },
  { scene: 'room-3', photo_sha256: T['room-3'].sha, pose: null, scale: null, confidence: 0, residual_cm: null }])

// --- running the CLI ------------------------------------------------------------------------------------------------------------
const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
let outN = 0
const freshOut = () => path.join(ev.out, 'rooms', `r${++outN}`, 'nested')
function run(args, { mock = MOCK, timeoutMs = 120000 } = {}) {
  const env = { ...process.env, MIDSTUDY_STRICT: '1' }
  delete env.FAL_KEY
  if (mock) env.MIDSTUDY_CALIB_MOCK = mock
  else delete env.MIDSTUDY_CALIB_MOCK
  const t0 = Date.now()
  const p = spawnSync('sh', ['-c', `${CLI} ${args.map(q).join(' ')}`], { cwd: REPO, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 << 20 })
  const lines = (p.stdout || '').trim().split('\n').filter(Boolean)
  let last = null
  try { last = JSON.parse(lines.at(-1) || 'null') } catch { /* not JSON */ }
  const errLast = (p.stderr || '').trim().split('\n').filter(Boolean).at(-1) || ''
  return { code: p.status, signal: p.signal, last, errLast, stderr: p.stderr || '', secs: (Date.now() - t0) / 1000, why: p.error ? String(p.error) : '' }
}
const alignRoom = (ids, out, extra = [], o) => run(['align-room', ...ids.map(folder), '--out', out, ...extra], o)
const fileOf = (out) => { try { return JSON.parse(fs.readFileSync(path.join(out, 'align.json'), 'utf8')) } catch { return null } }
const desc = (res) => `exit ${res.code}${res.signal ? ` (${res.signal})` : ''}${res.last ? ` ${clip(fmt(res.last), 260)}` : ''}${res.code ? ` | ${clip(res.errLast || res.stderr, 200)}` : ''}${res.why ? ` | ${res.why}` : ''}`
const stripOk = (o) => { if (!o) return o; const { ok, ...rest } = o; return rest }
// The expected answer for ids (first = frame), from truth poses (or given poses/scales), re-expressed relative to ids[0].
const expectFrom = (ids, poses, scales = {}) => ids.map((id) => {
  if (!poses[id]) return null
  if (id === ids[0]) return { pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1 }
  return reexpress(poses[ids[0]], scales[ids[0]] ?? 1, poses[id], scales[id] ?? 1)
})
const TRUTH = Object.fromEntries(IDS.map((id) => [id, T[id].pose]))
function worstAgainst(answer, ids, exp) {
  let pos = 0, yaw = 0, scale = 0
  answer?.members?.forEach((m, i) => {
    if (!exp[i] || !m.pose) return
    const e = poseErr(m.pose, exp[i].pose)
    pos = Math.max(pos, e.pos_m); yaw = Math.max(yaw, e.yaw_deg); scale = Math.max(scale, Math.abs(m.scale - exp[i].scale))
  })
  return { pos, yaw, scale }
}
const contractOk = (res, out) => {
  const f = fileOf(out)
  const vFile = f ? fileViolation('midstudy/align.schema.json', f) : 'no align.json'
  const vOut = res.last ? fileViolation('midstudy/calib-cli.schema.json#/$defs/align_room', res.last) : 'no JSON last line'
  const same = f && res.last && fmt(stripOk(res.last)) === fmt(f) && res.last.ok === true && !('ok' in f)
  const only = fs.existsSync(out) ? fs.readdirSync(out) : []
  return { ok: res.code === 0 && !vFile && !vOut && same && fmt(only) === '["align.json"]', why: [vFile, vOut, same ? '' : 'stdout ≠ align.json + ok', fmt(only) === '["align.json"]' ? '' : `files: ${fmt(only)}`].filter(Boolean).join('; ') || 'ok', f }
}

// ======================================================================================================================================
ev.section('the mock (§4.9 Mock): the golden room')
const fresh = (ms) => { const t = Date.parse(ms || ''); return ISO_RE.test(ms || '') && Math.abs(Date.now() - t) < 10 * 60 * 1000 }
let out = freshOut()
let res = alignRoom(IDS, out)
let c = contractOk(res, out)
ev.check('the seven golden photos (living-wide first) → exit 0; the last stdout line is align.json plus ok: true; only <out>/align.json, its folders created', c.ok, `${c.why} | ${desc(res)}`)
let a = c.f
ev.check('align.json validates (align.schema.json) and so does the stdout line (calib-cli.schema.json align_room)', a && !fileViolation('midstudy/align.schema.json', a) && res.last && !fileViolation('midstudy/calib-cli.schema.json#/$defs/align_room', res.last),
  a ? fileViolation('midstudy/align.schema.json', a) || fileViolation('midstudy/calib-cli.schema.json#/$defs/align_room', res.last) || 'ok' : 'none')
ev.check('members renamed to the scene folders (their names, not the fixture ids), in argument order, with their photos\' SHA-256s', a && fmt(a.members?.map((m) => m.scene)) === fmt(IDS.map((id) => `photo-${id}`)) && a.members.every((m, i) => m.photo_sha256 === T[IDS[i]].sha), fmt(a?.members?.map((m) => [m.scene, m.photo_sha256?.slice(0, 8)])))
let w = worstAgainst(a, IDS, expectFrom(IDS, TRUTH))
ev.check('every pose is the true pose (truth.json pose_in_room) relative to the first argument (1e-6), scale 1', a && a.members?.every((m) => m.pose && m.scale !== null) && w.pos <= 1e-6 && w.yaw <= 1e-6 && w.scale <= 1e-9, fmt(w))
ev.check('copied: solver truth, confidence, residual_cm, loop_residual_cm, unplaced []; created is now', a?.solver === 'truth' && a.members?.slice(1).every((m) => m.confidence === 1 && m.residual_cm === 0) && a.loop_residual_cm === 0 && fmt(a.unplaced) === '[]' && fresh(a.created),
  fmt({ solver: a?.solver, conf: a?.members?.map((m) => m.confidence), res: a?.members?.map((m) => m.residual_cm), loop: a?.loop_residual_cm, created: a?.created }))
ev.check('members[0] is the frame: pose {0, 0, 0}, scale 1, confidence 1, residual null', a && fmt(a.members?.[0]?.pose) === fmt({ x_m: 0, z_m: 0, yaw_deg: 0 }) && a.members[0].scale === 1 && a.members[0].confidence === 1 && a.members[0].residual_cm === null, fmt(a?.members?.[0]))

const SHUF = ['room-4', 'living-wide', 'room-6', 'room-1', 'room-2', 'room-3', 'room-5']
out = freshOut()
res = alignRoom(SHUF, out)
a = contractOk(res, out).f
const expS = expectFrom(SHUF, TRUTH)
w = worstAgainst(a, SHUF, expS)
ev.check('the same photos with room-4 first: re-expressed relative to room-4 (yaw\' = yaw − 152° into (−180, 180], positions turned by Ry(−152°)), 1e-6', res.code === 0 && a && w.pos <= 1e-6 && w.yaw <= 1e-6 && a.members?.every((m) => m.pose.yaw_deg > -180 && m.pose.yaw_deg <= 180),
  `${fmt(w)}; yaws ${fmt(a?.members?.map((m) => m.pose?.yaw_deg))} want ${fmt(expS.map((e) => e.pose.yaw_deg))}`)
ev.check('…in argument order, and room-4 is now the frame (pose {0, 0, 0}, scale 1, confidence 1, residual null)', a && fmt(a.members?.map((m) => m.scene)) === fmt(SHUF.map((id) => `photo-${id}`)) && fmt(a.members[0].pose) === fmt({ x_m: 0, z_m: 0, yaw_deg: 0 }) && a.members[0].residual_cm === null && a.members[0].confidence === 1, fmt(a?.members?.[0]))
const keyOf = (ids) => mockKey(ids.map((id) => T[id].sha))
ev.check('(eval) the key is order-free: SHA-256 of the sorted photo SHA-256s joined with "\\n" (the golden-room and golden-pair folders exist under it)',
  keyOf(IDS) === keyOf(SHUF) && fs.existsSync(path.join(REPO, 'fixtures/calib/rooms', keyOf(IDS), 'align.json')) && fs.existsSync(path.join(REPO, 'fixtures/calib/rooms', keyOf(['room-1', 'living-wide']), 'align.json')), `${keyOf(IDS).slice(0, 12)}…, pair ${keyOf(['living-wide', 'room-1']).slice(0, 12)}…`)

ev.section('the mock: pairs, scales, unplaced members, a miss')
out = freshOut()
res = alignRoom(['room-1', 'living-wide'], out)
a = contractOk(res, out).f
w = worstAgainst(a, ['room-1', 'living-wide'], expectFrom(['room-1', 'living-wide'], TRUTH))
ev.check('golden-pair given as (room-1, living-wide): living-wide comes out relative to room-1 (1e-6)', res.code === 0 && a?.solver === 'truth' && w.pos <= 1e-6 && w.yaw <= 1e-6, `${fmt(w)} ${desc(res)}`)
out = freshOut()
res = alignRoom(['room-5', 'living-wide'], out, ['--solver', 'manhattan'])
a = contractOk(res, out).f
const expSc = reexpress(SCALED.members[1].pose, 1.1, SCALED.members[0].pose, 1)
const lw = a?.members?.[1]
ev.check('scales: an answer with room-5 at scale 1.1, given room-5 first → living-wide\'s scale 1/1.1 and its position ÷ 1.1 (1e-6)',
  res.code === 0 && lw && poseErr(lw.pose, expSc.pose).pos_m <= 1e-6 && poseErr(lw.pose, expSc.pose).yaw_deg <= 1e-6 && Math.abs(lw.scale - 1 / 1.1) <= 1e-6, `${fmt(lw)} want ${fmt(expSc)} ${res.code ? desc(res) : ''}`)
ev.check('…confidence and residual copied per member, the answer\'s extra top-level keys kept, solver copied; --solver doesn\'t matter under the mock',
  a?.members?.[1]?.confidence === 1 && a?.members?.[1]?.residual_cm === null && fmt(a?.diagnostics) === fmt({ note: 'kept' }) && a?.solver === 'mast3r' && a?.elapsed_s === 12.5 && a?.device === 'mps' && a?.loop_residual_cm === 1.25,
  fmt({ m1: a?.members?.[1], diagnostics: a?.diagnostics, solver: a?.solver, elapsed_s: a?.elapsed_s, device: a?.device, loop: a?.loop_residual_cm }))
out = freshOut()
res = alignRoom(['living-wide', 'room-3'], out)
a = contractOk(res, out).f
ev.check('an answer leaving room-3 unplaced: pose and scale null, confidence 0, unplaced [its folder], exit 0', res.code === 0 && a?.members?.[1]?.pose === null && a.members[1].scale === null && a.members[1].confidence === 0 && fmt(a.unplaced) === fmt(['photo-room-3']), desc(res))
out = freshOut()
res = alignRoom(['room-3', 'living-wide'], out)
ev.check('the same answer with the unplaced photo first is a failure: exit 1, {"ok": false, "error"} last on stdout, "midstudy-calib: <it>" last on stderr, nothing written',
  res.code === 1 && res.last?.ok === false && typeof res.last?.error === 'string' && res.errLast === `midstudy-calib: ${res.last.error}` && !fs.existsSync(path.join(out, 'align.json')) && !fileViolation('midstudy/calib-cli.schema.json#/$defs/error', res.last), desc(res))
out = freshOut()
res = alignRoom(['living-wide', 'room-2'], out)
a = contractOk(res, out)
ev.check('a set the mock has no answer for (living-wide, room-2): exit 0, solver none, the first the frame, the other unplaced (confidence 0), loop null', a.ok && a.f?.solver === 'none' && a.f.members?.[0]?.pose && a.f.members[1].pose === null && a.f.members[1].confidence === 0 && a.f.loop_residual_cm === null && fmt(a.f.unplaced) === fmt(['photo-room-2']),
  `${a.why} ${fmt(a.f && { solver: a.f.solver, members: a.f.members, loop: a.f.loop_residual_cm })}`)

ev.section('failures and files')
out = freshOut()
res = alignRoom(['living-wide'], out)
ev.check('one scene folder → exit 1 with the output contract, nothing written', res.code === 1 && res.last?.ok === false && res.errLast === `midstudy-calib: ${res.last?.error}` && !fs.existsSync(path.join(out, 'align.json')), desc(res))
out = freshOut()
res = run(['align-room', folder('living-wide'), path.join(SCENES, 'no-photo'), '--out', out])
ev.check('a folder without photo.jpg → exit 1 with the output contract, nothing written', res.code === 1 && res.last?.ok === false && res.errLast === `midstudy-calib: ${res.last?.error}` && !fs.existsSync(path.join(out, 'align.json')), desc(res))
out = freshOut()
alignRoom(['living-wide', 'room-1'], out)
const first = fileOf(out)
await new Promise((r) => setTimeout(r, 30))
res = alignRoom(['living-wide', 'room-1'], out)
c = contractOk(res, out)
ev.check('a second run into the same --out replaces align.json (a newer created), no temp file left behind', c.ok && first && c.f && c.f.created >= first.created && fs.readdirSync(out).length === 1, `${c.why}; created ${first?.created} → ${c.f?.created}`)
ev.check('the scene folders are untouched (photo.jpg, calib.json, depth.png byte for byte; nothing added)', fmt(snapshot()) === fmt(scenesBefore), 'compared SHA-256s')

ev.section('the worker (§4.3 Worker)')
if (IS_STUB) {
  const p = spawnSync('sh', ['-c', `${CLI} serve`], { cwd: REPO, encoding: 'utf8', input: '', timeout: 10000 })
  ev.check('the stub has no worker: `serve` exits 2 at once (the server falls back to the one-shot command)', p.status === 2, `exit ${p.status}`)
} else {
  out = freshOut()
  const wres = await new Promise((resolve) => {
    const env = { ...process.env, MIDSTUDY_STRICT: '1', MIDSTUDY_CALIB_MOCK: MOCK }
    delete env.FAL_KEY
    const p = spawn('sh', ['-c', `${CLI} serve`], { cwd: REPO, env, stdio: ['pipe', 'pipe', 'pipe'] })
    let so = ''
    const timer = setTimeout(() => p.kill('SIGKILL'), 300000)
    p.stdout.on('data', (d) => { so += d; if (so.includes('\n')) p.stdin.end() })
    p.on('exit', (code) => { clearTimeout(timer); resolve({ code, so }) })
    p.stdin.write(`${JSON.stringify({ id: 'e20-worker-1', cmd: 'align-room', args: [folder('living-wide'), folder('room-1'), '--out', out] })}\n`)
  })
  let ans = null
  try { ans = JSON.parse(wres.so.trim().split('\n')[0]) } catch { /* not JSON */ }
  const { id, ...restAns } = ans || {}
  ev.check('the worker answers {"cmd": "align-room"} with the request\'s id and the one-shot answer (align_room schema), writes align.json, exits 0 at end of input',
    wres.code === 0 && id === 'e20-worker-1' && restAns.ok === true && !fileViolation('midstudy/calib-cli.schema.json#/$defs/align_room', restAns) && fmt(stripOk(restAns)) === fmt(fileOf(out)),
    `exit ${wres.code}; ${clip(wres.so, 300)}`)
}

// ======================================================================================================================================
if (!MOCK_MODE) {
  ev.section(`the real solver on the golden room (no MoGe: the fixtures' own calib.json and depth.png; --solver ${SOLVER})`)
  const realRun = (ids, extra = []) => { const o = freshOut(); const r = alignRoom(ids, o, ['--solver', SOLVER, ...extra], { mock: null, timeoutMs: 900000 }); return { res: r, out: o, c: contractOk(r, o) } }
  const judge = (ids, a) => {
    const exp = expectFrom(ids, TRUTH)
    const rows = (a?.members || []).map((m, i) => {
      if (!m.pose) return { id: ids[i], unplaced: true, confidence: m.confidence }
      const e = poseErr(m.pose, exp[i].pose)
      const scaleErr = Math.abs(m.scale / exp[i].scale - 1) * 100
      const within = e.pos_m * 100 <= TARGETS.pos_cm && e.yaw_deg <= TARGETS.yaw_deg && scaleErr <= TARGETS.scale_pct
      return { id: ids[i], pos_cm: +(e.pos_m * 100).toFixed(2), yaw_deg: +e.yaw_deg.toFixed(3), scale_pct: +scaleErr.toFixed(2), confidence: m.confidence, within }
    })
    return { rows, placed: rows.filter((r) => !r.unplaced), unplaced: rows.filter((r) => r.unplaced), confidentWrong: rows.filter((r) => !r.unplaced && !r.within && r.confidence >= 0.5) }
  }
  const all = realRun(IDS)
  const j = judge(IDS, all.c.f)
  fs.writeFileSync(path.join(ev.out, 'golden-room.json'), JSON.stringify({ answer: all.c.f, rows: j.rows, secs: all.res.secs }, null, 2))
  ev.check('the seven photos → exit 0, align.json and stdout valid, only align.json written', all.c.ok, `${all.c.why} | ${desc(all.res)}`)
  ev.check(`--solver ${SOLVER} answered with ${SOLVER === 'auto' ? `the learned solver chosen at Gate A (${EXPECT_SOLVER})` : SOLVER}`, all.c.f?.solver === (SOLVER === 'auto' ? EXPECT_SOLVER : SOLVER), fmt({ solver: all.c.f?.solver, device: all.c.f?.device }))
  ev.check(`every placed photo within the Phase A targets (${TARGETS.pos_cm} cm, ${TARGETS.yaw_deg}°, ${TARGETS.scale_pct} %) of truth`, j.placed.length >= 6 && j.placed.every((r) => r.within), fmt(j.rows))
  ev.check('at most one photo unplaced', j.unplaced.length <= 1, fmt(j.unplaced.map((r) => r.id)))
  ev.check('no photo placed wrong with confidence ≥ 0.5', j.confidentWrong.length === 0, fmt(j.confidentWrong))
  ev.check('members[0] is the frame; residual_cm and loop_residual_cm are reported', all.c.f?.members?.[0]?.confidence === 1 && all.c.f.members[0].residual_cm === null && (all.c.f.loop_residual_cm === null || all.c.f.loop_residual_cm >= 0),
    fmt({ loop: all.c.f?.loop_residual_cm, residuals: all.c.f?.members?.map((m) => m.residual_cm) }))
  ev.check('run time for seven photos (one-shot, cold) within 300 s (Gate A: ~1 min on MPS)', all.res.code === 0 && all.res.secs <= 300, `${all.res.secs.toFixed(1)} s wall, elapsed_s ${all.c.f?.elapsed_s}, device ${all.c.f?.device}`)
  for (const [name, ids] of [['little overlap (room-1, room-4)', ['room-1', 'room-4']], ['little overlap (living-wide, room-4)', ['living-wide', 'room-4']], ['a bare wall (room-3, room-6)', ['room-3', 'room-6']], ['a bare wall (living-wide, room-6)', ['living-wide', 'room-6']]]) {
    const p = realRun(ids)
    const jj = judge(ids, p.c.f)
    ev.check(`${name}: exit 0, valid, and the hard photo is unplaced, placed with confidence < 0.5, or within the targets (never confidently wrong)`, p.c.ok && jj.confidentWrong.length === 0, `${fmt(jj.rows)} ${p.c.ok ? '' : p.c.why} (${p.res.secs.toFixed(1)} s)`)
  }
  const man = realRun(IDS, [])
  const manRes = alignRoom(IDS, freshOut(), ['--solver', 'manhattan'], { mock: null, timeoutMs: 600000 })
  ev.check('--solver manhattan (no ML) answers for the seven photos: exit 0, solver manhattan', manRes.code === 0 && manRes.last?.solver === 'manhattan', `${desc(manRes)} (${manRes.secs.toFixed(1)} s)`)
  if (man.c.f) ev.note(`second ${SOLVER} run (warm cache): ${man.res.secs.toFixed(1)} s`)
  const bad = alignRoom(['living-wide', 'room-1'], freshOut(), ['--solver', 'no-such-solver'], { mock: null })
  ev.check('a solver that isn\'t installed is a failure (exit 1, the output contract)', bad.code === 1 && bad.last?.ok === false && bad.errLast === `midstudy-calib: ${bad.last?.error}`, desc(bad))
}
await ev.finish()
