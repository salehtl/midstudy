// Harness self-test: checks the eval machinery itself against the fixtures, without the planner or midstudy-calib.
// If this fails, the evals are wrong, not the app. It covers: this repo's §4.1 projection and inverse against
// truth.json (all three golden scenes), the expected drop point, the probe library (validate_library.py), the PNG
// mask encoder, the occlusion judge on composites this test draws itself (occlusion on, off), the align
// measurement (0 px, 3 px, unaligned), the E2 comparator (calib_eval.py --self-test), the calib stub through
// gated_calib.py (gate and log), and that a scene photo with an unknown SHA misses the calib mock.
// Usage: node evals/harness_selftest.mjs   (or npm run eval:selftest)
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, GOLDEN, createEval, golden, project, photoToFloor, projectBox, expectedDrop, writeProbeLibrary, maskPng, pyHelper, unknownPhoto, fmt,
} from './lib/harness.mjs'

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
await ev.finish()
