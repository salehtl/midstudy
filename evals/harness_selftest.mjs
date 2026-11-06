// Harness self-test: checks the eval machinery itself against the fixtures, without the planner or midstudy-calib.
// If this fails, the evals are wrong, not the app. It covers: this repo's §4.1 projection and inverse against
// truth.json (all three golden scenes), the expected drop point, the probe library (validate_library.py), the PNG
// mask encoder, the occlusion judge on composites this test draws itself (occlusion on, off), the align
// measurement (0 px, 3 px, unaligned), the E2 comparator (calib_eval.py --self-test), the calib stub through
// gated_calib.py (gate and log), and that a scene photo with an unknown SHA misses the calib mock. Rooms (E18–E20,
// eval:real-room; evals/lib/rooms.mjs, evals/lib/room_images.py): the calib mock's key against the fixture folders, the
// §4.9 maps against the golden room's truth, the anchor and re-expression formulas against each other, the oriented-box
// occlusion and id-mask judges on composites drawn here, and eval:real-room's measurements through the true poses.
// Usage: node evals/harness_selftest.mjs   (or npm run eval:selftest)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, GOLDEN, createEval, golden, project, photoToFloor, projectBox, expectedDrop, writeProbeLibrary, maskPng, pyHelper, unknownPhoto, fmt,
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
await ev.finish()
