// Harness self-test: checks the eval machinery itself against the fixtures, without the planner or midstudy-calib.
// If this fails, the evals are wrong, not the app. It covers: this repo's §4.1 projection and inverse against
// truth.json (all three golden scenes), the expected drop point, the probe library (validate_library.py), the PNG
// mask encoder, the occlusion judge on composites this test draws itself (occlusion on, off), the align
// measurement (0 px, 3 px, unaligned), the E2 comparator (calib_eval.py --self-test), the calib stub through
// gated_calib.py (gate and log), and that a scene photo with an unknown SHA misses the calib mock. Rooms (E18–E20,
// eval:real-room; evals/lib/rooms.mjs, evals/lib/room_images.py): the calib mock's key against the fixture folders, the
// §4.9 maps against the golden room's truth, the anchor and re-expression formulas against each other, the oriented-box
// occlusion and id-mask judges on composites drawn here, and eval:real-room's measurements through the true poses.
// The harness's own state machines: startServer (the server's own port, up cleared on a crash, a clean stop), createEval's
// bounded cleanups and signal debounce, the build memo, the job polls, the out-folder lock.
// Usage: node evals/harness_selftest.mjs   (or npm run eval:selftest)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  REPO, GOLDEN, createEval, golden, project, photoToFloor, projectBox, expectedDrop, writeProbeLibrary, maskPng, pyHelper, unknownPhoto, fmt, startServer, waitScene, api, sleep,
} from './lib/harness.mjs'
import {
  ROOM_IDS, goldenRoom, roomSofa, mockKey, roomToScene, sceneToRoom, rotRoomToScene, boxCornersOriented, applyAnchor, reexpress, poseErr, normYaw,
  goldenMeasurements, measureSpots,
} from './lib/rooms.mjs'

const ev = createEval('H0', 'harness-selftest', { timeoutS: 300 })

ev.section('§4.1 projection (evals/lib/harness.mjs) against truth.json')
for (const id of GOLDEN) {
  const g = golden(id), { w: W, h: H } = g.truth.image, cam = g.truth.camera
  let maxErr = 0, maxInv = 0
  for (const o of ['sofa', 'table']) {
    g.truth.objects[o].corners.forEach((c, i) => {
      const p = project(cam, W, H, c)
      maxErr = Math.max(maxErr, Math.hypot(p.px - g.truth.objects[o].corner_px[i][0], p.py - g.truth.objects[o].corner_px[i][1]))
    })
  }
  for (const fp of g.truth.floor_points) {
    const q = photoToFloor(cam, W, H, fp.px[0], fp.px[1])
    maxInv = Math.max(maxInv, Math.hypot(q[0] - fp.world[0], q[2] - fp.world[2]))
  }
  ev.check(`${id}: project() reproduces corner_px`, maxErr < 0.01, `max ${maxErr.toFixed(4)} px`)
  ev.check(`${id}: photoToFloor() inverts floor_points`, maxInv < 0.001, `max ${(1000 * maxInv).toFixed(3)} mm`)
  const flipped = project({ ...cam, roll_deg: -cam.roll_deg, pitch_deg: cam.pitch_deg + 0.5 }, W, H, g.truth.objects.sofa.corners[6])
  ev.check(`${id}: a wrong camera (pitch + 0.5°, roll negated) misses by > 3 px`, Math.hypot(flipped.px - g.truth.objects.sofa.corner_px[6][0], flipped.py - g.truth.objects.sofa.corner_px[6][1]) > 3,
    `${Math.hypot(flipped.px - g.truth.objects.sofa.corner_px[6][0], flipped.py - g.truth.objects.sofa.corner_px[6][1]).toFixed(1)} px`)
}
const lw = golden('living-wide')
const drop = expectedDrop(lw.truth.camera, 1600, 1200)
ev.check('expectedDrop on living-wide: the center ray hits 7.9 m out (too far), the lower third 2.51 m ahead', Math.abs(drop[0].point[2] + 2.511) < 0.01 && Math.abs(drop[0].point[0]) < 1e-9, fmt(drop))
const r = projectBox(lw.truth.camera, 1600, 1200, [-1.3, 0, -3.75], [0.7, 0.82, -2.85])
const cpx = lw.truth.objects.sofa.corner_px
ev.check('projectBox of the sofa box spans its corner_px', Math.abs(r.x - Math.min(...cpx.map((c) => c[0]))) < 0.01 && Math.abs(r.y + r.h - Math.max(...cpx.map((c) => c[1]))) < 0.01, fmt(r))

ev.section('probe library and PNG encoder')
const lib = path.join(ev.out, 'library')
writeProbeLibrary(lib)
const v = spawnSync(path.join(REPO, 'evals/py'), [path.join(REPO, 'evals/validate_library.py'), path.join(lib, 'library.json')], { cwd: REPO, encoding: 'utf8' })
ev.check('the probe library passes evals/validate_library.py (schema, normalized GLB bounds = dims_cm)', v.status === 0, (v.stdout + v.stderr).trim().split('\n').slice(-3).join(' | '))
const mpath = path.join(ev.out, 'mask.png')
fs.writeFileSync(mpath, maskPng(64, 48, [[8, 4, 40, 20]]))
const chk = spawnSync(path.join(REPO, 'evals/py'), ['-c', `import numpy as np; from PIL import Image; a = np.asarray(Image.open('${mpath}')); print(a.shape, a.dtype, int(a.sum() // 255), int(a[4, 8]), int(a[20, 8]), int(a[4, 40]))`], { encoding: 'utf8' })
ev.check('maskPng writes an 8-bit gray PNG Pillow reads back (white rect only)', chk.stdout.trim() === '(48, 64) uint8 512 255 0 0', chk.stdout.trim() + chk.stderr.trim().slice(-200))

ev.section('occlusion judge (images.py) on composites drawn here')
const cam = JSON.stringify(lw.truth.camera), box = JSON.stringify([[-0.7, 0, -4.55], [0.1, 1.2, -4.05]])
for (const mode of ['on', 'off']) {
  const out = path.join(ev.out, `synth-${mode}.jpg`)
  const s = pyHelper(['synth-composite', '--photo', lw.photo, '--depth', lw.depth, '--camera', cam, '--box', box, '--mode', mode, '--out', out])
  const a = pyHelper(['occlusion', '--composite', out, '--photo', lw.photo, '--depth', lw.depth, '--camera', cam, '--box', box, '--debug', path.join(ev.out, `judge-${mode}.png`)])
  if (mode === 'on') ev.check('a correctly occluded composite: hidden pixels match the photo (≥ 95 %), the rest shows the box', a.hidden_match >= 0.95 && a.visible_magenta >= 0.9 && a.n_hidden > 5000, s.error || a.error || fmt(a))
  else ev.check('a composite without occlusion is caught (hidden pixels show the box)', a.hidden_match < 0.05 && a.hidden_magenta >= 0.9, s.error || a.error || fmt(a))
}

ev.section('align measurement (images.py)')
const al = pyHelper(['align-selftest', '--out', path.join(ev.out, 'align')])
ev.check('a perfect composite measures 0 px', al.perfect?.shift_px < 0.05, al.error || fmt(al.perfect))
ev.check('a composite shifted by 3 px inside the mask measures 3 px (so the 2 px rule fails it)', Math.abs(al.three?.shift_px - 3) < 0.1, al.error || fmt(al.three))
ev.check('pasting the unaligned output measures the 2 % shift (~32 px at the photo\'s size)', Math.abs(al.unaligned?.shift_px - 32.1) < 1.5, al.error || fmt(al.unaligned))

ev.section('E2 comparator')
const e2 = spawnSync(path.join(REPO, 'evals/py'), [path.join(REPO, 'evals/calib_eval.py'), '--self-test'], { cwd: REPO, encoding: 'utf8' })
ev.check('calib_eval.py --self-test passes', e2.status === 0, (e2.stdout.trim().split('\n').at(-1) || '') + e2.stderr.slice(-200))

ev.section('calib stub through gated_calib.py')
const scene = path.join(ev.out, 'gated-scene'), gate = path.join(ev.out, 'gate'), log = path.join(ev.out, 'calls.jsonl')
const env = { ...process.env, MIDSTUDY_CALIB_MOCK: path.join(REPO, 'fixtures/calib'), MIDSTUDY_EVAL_CALIB_GATE: gate, MIDSTUDY_EVAL_CALIB_LOG: log, MIDSTUDY_EVAL_CALIB_TARGET: `python3 ${path.join(REPO, 'fixtures/stub_calib.py')}` }
const t0 = Date.now()
setTimeout(() => fs.writeFileSync(gate, 'open'), 1200)
const child = await new Promise((resolve) => {
  const p = spawn('python3', [path.join(REPO, 'evals/lib/gated_calib.py'), 'run', lw.photo, '--out', scene], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  p.stdout.on('data', (d) => { out += d })
  p.on('exit', (code) => resolve({ code, out }))
})
const waited = Date.now() - t0
const last = JSON.parse(child.out.trim().split('\n').at(-1) || '{}')
ev.check('the wrapper waits for its gate, logs the call, and runs the stub (mock hit: the truth camera)', child.code === 0 && waited >= 1100 && last.source === 'truth'
  && JSON.parse(fs.readFileSync(log, 'utf8').trim().split('\n')[0]).argv[0] === 'run', `exit ${child.code}, waited ${waited} ms, source ${last.source}`)
const unk = path.join(ev.out, 'unknown.jpg')
fs.writeFileSync(unk, unknownPhoto())
const u = spawnSync('python3', [path.join(REPO, 'fixtures/stub_calib.py'), 'run', unk, '--out', path.join(ev.out, 'unknown-scene')], { env, encoding: 'utf8' })
const uj = JSON.parse(u.stdout.trim().split('\n').at(-1) || '{}')
ev.check('unknownPhoto(): same pixels, a SHA the calib mock lacks → default fallback, no depth', u.status === 0 && uj.source === 'default' && uj.depth === null, `${uj.source} ${fmt(uj.camera)}`)

ev.section('rooms (evals/lib/rooms.mjs, evals/lib/room_images.py)')
const GR = goldenRoom()
const keyRoom = mockKey(GR.map((m) => m.sha)), keyPair = mockKey(GR.slice(0, 2).map((m) => m.sha))
ev.check('mockKey: the golden room\'s and golden pair\'s keys are the folders in fixtures/calib/rooms/', fs.existsSync(path.join(REPO, 'fixtures/calib/rooms', keyRoom, 'align.json')) && fs.existsSync(path.join(REPO, 'fixtures/calib/rooms', keyPair, 'align.json')), `${keyRoom.slice(0, 12)}… ${keyPair.slice(0, 12)}…`)
let worstM = 0, worstPx = 0, worstRot = 0
const lwT = golden('living-wide').truth
for (const m of GR) {
  for (const o of ['sofa', 'table']) {
    const ro = lwT.objects[o], so = m.truth.objects[o]
    ro.corners.forEach((c, i) => { const q = roomToScene(m.pose, c); worstM = Math.max(worstM, Math.hypot(q[0] - so.corners[i][0], q[1] - so.corners[i][1], q[2] - so.corners[i][2])) })
    worstRot = Math.max(worstRot, Math.abs(normYaw(rotRoomToScene(m.pose, ro.rotation_y_deg) - so.rotation_y_deg)))
    so.corners.forEach((c, i) => { const p = project(m.cam, m.W, m.H, c); if (p.d > 0) worstPx = Math.max(worstPx, Math.hypot(p.px - so.corner_px[i][0], p.py - so.corner_px[i][1])) })
  }
}
ev.check('roomToScene carries the room\'s sofa and table into each room photo\'s own truth (corners ≤ 1e-5 m, rotation_y_deg = room − yaw)', worstM < 1e-5 && worstRot < 1e-6, `${worstM.toExponential(2)} m, ${worstRot.toExponential(2)}°`)
ev.check('…and project() lands them on corner_px (≤ 0.01 px, corners in front)', worstPx < 0.01, `${worstPx.toFixed(4)} px`)
const S0 = roomSofa(), sc = boxCornersOriented(S0.center, S0.size, S0.rotation_y_deg)
ev.check('boxCornersOriented reproduces truth\'s corner order (bottom then top; back-left, back-right, front-right, front-left)', sc.every((c, i) => Math.hypot(...c.map((v, k) => v - lwT.objects.sofa.corners[i][k])) < 1e-5), fmt(sc[0]))
let rt = 0
for (const m of GR) for (const p of [[0.3, 0.2, -1], [2, 1, 3]]) { const q = sceneToRoom(m.pose, roomToScene(m.pose, p)); rt = Math.max(rt, Math.hypot(q[0] - p[0], q[1] - p[1], q[2] - p[2])) }
const A = { x_m: 1, z_m: 2, yaw_deg: 30 }, P = { x_m: -1.15, z_m: 0.45, yaw_deg: -22 }
const comp = applyAnchor(A, 1.5, P, 1.2), back = reexpress(A, 1.5, comp.pose, comp.scale)
ev.check('sceneToRoom ∘ roomToScene is the identity; reexpress undoes applyAnchor (pose and scale)', rt < 1e-12 && poseErr(back.pose, P).pos_m < 1e-12 && poseErr(back.pose, P).yaw_deg < 1e-9 && Math.abs(back.scale - 1.2) < 1e-12, `${rt.toExponential(1)}; ${fmt(back)}`)
ev.check('normYaw brings any yaw into (−180, 180] (−180 → 180, 540 → 180, −190.5 → 169.5)', normYaw(-180) === 180 && normYaw(540) === 180 && Math.abs(normYaw(-190.5) - 169.5) < 1e-12 && normYaw(180) === 180 && normYaw(-179) === -179, fmt([normYaw(-180), normYaw(540), normYaw(-190.5)]))
const r1 = GR.find((m) => m.id === 'room-1')
const obb = JSON.stringify({ center: roomToScene(r1.pose, S0.center), size: [S0.size.w, S0.size.h, S0.size.d], rotation_y_deg: rotRoomToScene(r1.pose, S0.rotation_y_deg) })
const roomPy = (args) => { const p = spawnSync(path.join(REPO, 'evals/py'), [path.join(REPO, 'evals/lib/room_images.py'), ...args], { cwd: REPO, encoding: 'utf8' }); try { return JSON.parse(p.stdout.trim().split('\n').at(-1)) } catch { return { error: (p.stderr || p.stdout).slice(-300) } } }
for (const mode of ['on', 'off']) {
  const out = path.join(ev.out, `room-synth-${mode}.jpg`)
  const sy = roomPy(['obb-synth', '--photo', r1.photo, '--camera', JSON.stringify(r1.cam), '--obb', obb, '--depth', r1.depth, '--mode', mode, '--out', out])
  const a = roomPy(['obb-occlusion', '--composite', out, '--photo', r1.photo, '--camera', JSON.stringify(r1.cam), '--obb', obb, '--depth', r1.depth])
  if (mode === 'on') ev.check('room-1, the turned sofa probe: a correctly occluded composite passes the oriented-box judge (hidden pixels match the photo ≥ 95 %)', a.hidden_match >= 0.95 && a.n_hidden > 5000, sy.error || a.error || fmt(a))
  else {
    ev.check('…and one drawn without occlusion is caught (hidden pixels show the probe)', a.hidden_match < 0.05 && a.hidden_magenta >= 0.9, sy.error || a.error || fmt(a))
    const ov = roomPy(['ids-overlap', '--composite', out, '--ids', path.join(r1.dir, 'ids.png')])
    ev.check('ids-overlap: the sofa probe drawn at the true sofa covers room-1\'s sofa id mask (IoU ≥ 0.99)', ov.iou >= 0.99, ov.error || fmt(ov))
    const off = roomPy(['ids-overlap', '--composite', r1.photo, '--ids', path.join(r1.dir, 'ids.png')])
    ev.check('ids-overlap: the photo alone (no probe) scores IoU 0', off.iou === 0, off.error || fmt({ iou: off.iou }))
  }
}
const gm = goldenMeasurements(path.join(ev.out, 'real-room-golden'))
const ms = measureSpots(gm.meas, gm.truthMembers)
ev.check('eval:real-room --golden: its measurements, read through the true poses, give every spot within 1 mm in every photo, and the scale its length', ms.spots.length === 4 && ms.spots.every((sp) => sp.rows.length >= 4 && sp.rows.every((x) => x.err_cm < 0.1)) && Math.abs(ms.scale_measured_m - gm.meas.scale.length_m) < 1e-3,
  fmt(ms.spots.map((sp) => [sp.name, sp.rows.length, Math.max(...sp.rows.map((x) => x.err_cm))])))

ev.section('startServer: the server\'s own port, up cleared on a crash, a clean stop')
const decoy = http.createServer((_q, a) => { a.statusCode = 418; a.end('a foreign server') })
await new Promise((res) => { decoy.listen(0, '127.0.0.1', res) })
ev.onCleanup(() => decoy.close())
const srvA = await startServer(ev)
const printed = /midstudy planner: http:\/\/127\.0\.0\.1:(\d+)\/planner\//.exec(srvA.log())?.[1]
const scenesA = await api.get(srvA.base, '/api/scenes')
ev.check('the server is told --port 0, and srv.port is the port in its own stdout line', /--port 0 /.test(srvA.log()) && srvA.up && String(srvA.port) === printed && srvA.base === `http://127.0.0.1:${printed}`, `srv.port ${srvA.port}, printed ${printed}`)
ev.check('srv.base answers as the server (GET /api/scenes 200 JSON), not a foreign listener', scenesA.status === 200 && scenesA.json !== null, `status ${scenesA.status}`)
const t0Stop = Date.now()
await srvA.stop()
const stopMs = Date.now() - t0Stop
ev.check('srv.stop() on an idle server ends it under 8 s, without SIGKILL, and is not recorded as a crash', stopMs < 8000 && srvA.exited !== null && srvA.exited.sig !== 'SIGKILL' && srvA.why === '', `${stopMs} ms, ${fmt(srvA.exited)}, why '${srvA.why}'`)
const srvB = await startServer(ev)
const copyB = { ...srvB }
const aliveBefore = typeof srvB.alive === 'function' && srvB.alive()
srvB.proc.kill('SIGKILL')
for (let i = 0; i < 100 && srvB.exited == null; i++) await sleep(50)
ev.check('a server killed after start: up false, alive() false (also on a spread copy), why names the exit', aliveBefore && srvB.up === false && srvB.alive() === false && copyB.alive() === false && /exited after start/.test(srvB.why), `up ${srvB.up}, why '${srvB.why}'`)

ev.section('createEval, ensureBuilt and the out-folder lock, in child evals')
const HARNESS = pathToFileURL(path.join(REPO, 'evals/lib/harness.mjs')).href
const scratch = path.join(ev.out, 'children')
fs.mkdirSync(scratch, { recursive: true })
const childSlugs = new Set()
// A child eval that gets `limitMs` to exit, then SIGKILL (its result has killed: true).
function childEval(slug, body, { env: extra = {}, limitMs = 60000 } = {}) {
  childSlugs.add(slug)
  const src = `import fs from 'node:fs'\nimport { createEval, ensureBuilt, startServer, sleep, raw } from ${JSON.stringify(HARNESS)}\nconst ev = createEval('C', ${JSON.stringify(slug)}, { timeoutS: 120 })\n${body}`
  const p = spawn(process.execPath, ['--input-type=module', '-e', src], { cwd: REPO, env: { ...process.env, ...extra }, stdio: ['ignore', 'pipe', 'pipe'] })
  const c = { p, out: '', err: '', t0: Date.now(), killed: false, done: null, secs: () => ((Date.now() - c.t0) / 1000).toFixed(1) }
  p.stdout.on('data', (d) => { c.out += d })
  p.stderr.on('data', (d) => { c.err += d })
  const limit = setTimeout(() => { c.killed = true; p.kill('SIGKILL') }, limitMs)
  c.done = new Promise((res) => { p.on('close', (code, sig) => { clearTimeout(limit); c.ms = Date.now() - c.t0; res({ code, sig, killed: c.killed }) }) })
  c.saw = async (text, ms = 20000) => { const end = Date.now() + ms; while (!c.out.includes(text) && Date.now() < end) await sleep(20); return c.out.includes(text) }
  return c
}
const HOLD = 'setInterval(() => {}, 1000)'
const HUNG = `ev.onCleanup(() => new Promise(() => { ${HOLD} }))`
async function hungCleanup() {
  const c = childEval('h0-child-hung', `${HUNG}\nawait ev.finish()`)
  const r = await c.done
  ev.check('a cleanup that never resolves: the eval exits 1 in about 15–20 s with a failing "cleanup 1 finished"', r.code === 1 && c.ms < 30000 && /FAIL \S+ cleanup 1 finished/.test(c.out), `${fmt(r)} in ${c.secs()} s`)
}
async function secondSignal() {
  const c = childEval('h0-child-signal', `${HUNG}\nconsole.log('IN CLEANUP')\nawait ev.finish()`)
  await c.saw('IN CLEANUP'); await sleep(300)
  c.p.kill('SIGTERM'); await sleep(3000)
  const t = Date.now()
  c.p.kill('SIGTERM')
  const r = await c.done
  ev.check('hung in cleanup: a SIGTERM 3 s after the first exits 130 at once', r.code === 130 && Date.now() - t < 2000, `${fmt(r)}, ${Date.now() - t} ms after the second`)
}
async function signalBurst() {
  const marker = path.join(scratch, 'burst-cleaned')
  const c = childEval('h0-child-burst', `ev.onCleanup(async () => { await sleep(300); fs.writeFileSync(${JSON.stringify(marker)}, 'x') })\nconsole.log('READY')\n${HOLD}`)
  await c.saw('READY'); await sleep(300)
  c.p.kill('SIGTERM'); await sleep(50); c.p.kill('SIGTERM')
  const r = await c.done
  ev.check('two SIGTERMs 50 ms apart count as one: the cleanups still run, exit 1', r.code === 1 && fs.existsSync(marker), `${fmt(r)}, cleaned ${fs.existsSync(marker)}`)
}
async function buildRetry() {
  const marker = path.join(scratch, 'build-marker')
  const cmd = ['node', '-e', "const fs=require('fs');const m=process.argv[1];if(!fs.existsSync(m)){fs.writeFileSync(m,'');console.error('no marker');process.exit(3)}", marker]
  const c = childEval('h0-child-build', `console.log('MEMO ' + JSON.stringify([ensureBuilt(ev).ok, ensureBuilt(ev).ok, ensureBuilt(ev).ok]))\nprocess.exit(0)`, { env: { MIDSTUDY_EVAL_BUILD_CMD: JSON.stringify(cmd) } })
  await c.done
  const builds = (c.out.match(/^(PASS|FAIL) \S+ .*builds the planner/gm) || []).map((l) => l.slice(0, 4))
  ev.check('ensureBuilt: a failed build is retried, a success is memoized, and each attempt is its own check', c.out.includes('MEMO [false,true,true]') && fmt(builds) === '["FAIL","PASS"]', `${/MEMO .*/.exec(c.out)?.[0]}; ${fmt(builds)}`)
}
async function buildBroken() {
  const count = path.join(scratch, 'build-count')
  const cmd = ['node', '-e', "require('fs').appendFileSync(process.argv[1],'x\\n');console.error('the build is broken');process.exit(3)", count]
  const c = childEval('h0-child-nobuild', `ensureBuilt(ev); ensureBuilt(ev)\nconst s = await startServer(ev)\nconsole.log('SRV ' + JSON.stringify({ up: s.up, why: s.why, proc: s.proc ?? null, alive: s.alive() }))\nawait s.stop()\nprocess.exit(0)`, { env: { MIDSTUDY_EVAL_BUILD_CMD: JSON.stringify(cmd) } })
  await c.done
  const j = JSON.parse(/SRV (.*)/.exec(c.out)?.[1] ?? '{}')
  const n = fs.existsSync(count) ? fs.readFileSync(count, 'utf8').trim().split('\n').length : 0
  ev.check('a build that always fails: two attempts per process, then startServer is up:false "the build failed" and spawns nothing', n === 2 && j.up === false && /^the build failed/.test(j.why ?? '') && j.proc === null && j.alive === false, `${n} attempts, ${fmt(j)}`)
}
async function outDirLock() {
  const go = path.join(scratch, 'lock-go')
  const first = childEval('h0-child-lock', `fs.writeFileSync(ev.out + '/mine', 'x')\nconsole.log('HOLDING')\nwhile (!fs.existsSync(${JSON.stringify(go)})) await sleep(50)\nconsole.log('STILL ' + fs.existsSync(ev.out + '/mine'))\nawait ev.finish()`)
  await first.saw('HOLDING')
  const second = childEval('h0-child-lock', `console.log('RAN')\nawait ev.finish()`, { limitMs: 30000 })
  const r2 = await second.done
  const dir = path.join(REPO, 'evals/out/h0-child-lock')
  const intact = fs.existsSync(path.join(dir, 'mine'))
  fs.writeFileSync(go, 'x')
  const r1 = await first.done
  ev.check('a second run of the same eval exits 75 and says who holds it, leaving the first\'s folder alone', r2.code === 75 && /another run of h0-child-lock is in progress in this worktree \(pid \d+/.test(second.err) && !second.out.includes('RAN') && intact, `${fmt(r2)}, intact ${intact}, ${second.err.trim().slice(0, 160)}`)
  ev.check('…and the first finishes with its results.json', r1.code === 0 && first.out.includes('STILL true') && fs.existsSync(path.join(dir, 'results.json')), fmt(r1))
  const third = childEval('h0-child-lock', `process.exit(0)`, { limitMs: 30000 })
  const r3 = await third.done
  ev.check('…and the lock is free afterwards', r3.code === 0, fmt(r3))
}
async function recordFiles() {
  const dir = path.join(scratch, 'record')
  const stub = http.createServer((_q, a) => { a.setHeader('Content-Type', 'application/json'); a.end('{}') })
  await new Promise((res) => { stub.listen(0, '127.0.0.1', res) })
  const b = `http://127.0.0.1:${stub.address().port}`
  childSlugs.add('h0-child-rec2')
  const c = childEval('h0-child-rec1', `await raw(${JSON.stringify(b)}, 'GET', '/api/a')\ncreateEval('D', 'h0-child-rec2', { timeoutS: 120 })\nawait raw(${JSON.stringify(b)}, 'GET', '/api/b')\nprocess.exit(0)`, { env: { MIDSTUDY_RECORD_API: dir } })
  await c.done
  stub.close()
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).map((f) => f.replace(/-\d+\.jsonl$/, '')).sort() : []
  ev.check('MIDSTUDY_RECORD_API: a second createEval in a process records to its own file', fmt(files) === '["h0-child-rec1","h0-child-rec2"]', fmt(files))
}
await Promise.all([hungCleanup(), secondSignal(), signalBurst(), buildRetry(), buildBroken(), outDirLock(), recordFiles()])
for (const s of childSlugs) { fs.rmSync(path.join(REPO, 'evals/out', s), { recursive: true, force: true }); fs.rmSync(path.join(REPO, 'evals/out', `${s}.lock`), { recursive: true, force: true }) }

ev.section('job polls: end on any status outside the contract\'s in-progress values')
const jobs = http.createServer((q, a) => {
  const name = q.url.split('/').pop()
  a.setHeader('Content-Type', 'application/json')
  if (name === 'boom') { a.statusCode = 500; a.end('{"error":"boom"}'); return }
  a.end(JSON.stringify(name === 'weird' ? { calib_status: 'weird' } : name === 'running' ? { calib_status: 'running' } : {}))
})
await new Promise((res) => { jobs.listen(0, '127.0.0.1', res) })
ev.onCleanup(() => jobs.close())
const jb = `http://127.0.0.1:${jobs.address().port}`
const timed = async (name, ms) => { const t = Date.now(); const v = await waitScene(jb, name, ms); return { v, ms: Date.now() - t } }
const w1 = await timed('weird', 3000)
ev.check('waitScene returns at once on a status it doesn\'t know', w1.v?.calib_status === 'weird' && w1.ms < 1000, `${w1.ms} ms`)
const [w2, w3] = await Promise.all([timed('nofield', 800), timed('running', 800)])
ev.check('a body without calib_status, and "running", keep waitScene polling to its timeout', w2.v === null && w2.ms >= 750 && w3.v === null && w3.ms >= 750, `${w2.ms} ms, ${w3.ms} ms`)
const stderrWrite = process.stderr.write
let captured = ''
process.stderr.write = (chunk) => { captured += chunk; return true }
const w4 = await timed('boom', 600).finally(() => { process.stderr.write = stderrWrite })
ev.check('waitFor returns null on a timeout and its stderr line names the last answer (500)', w4.v === null && /waitFor timed out after 600 ms; last: .*500/.test(captured), captured.trim().slice(0, 200))
await ev.finish()
