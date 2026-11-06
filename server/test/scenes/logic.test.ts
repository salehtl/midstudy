// The scenes logic (server/src/scenes/logic/) against v1's own Python (v1_oracle.py imports planner/serve.py): seeded
// random PUT /api/scenes bodies and the scene.json they leave, random layouts, camera clamps, file times, names, and
// the job sentences; plus direct cases for what the oracle can't reach. Skipped when planner/serve.py is gone.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pyFloatRepr } from '../../../common/logic/pyfmt.ts'
import { compareNames } from '../../../core/js/node.ts'
import { mtimeOf } from '../../src/scenes/files.ts'
import { clampCamera, DEFAULT_CAMERA } from '../../src/scenes/logic/camera.ts'
import { calibratedMessage, lightMessage, timedOut, notInstalled } from '../../src/scenes/logic/jobs.ts'
import { checkLayout, layoutSummary } from '../../src/scenes/logic/layout.ts'
import { LOOK_HELP, mergeLook } from '../../src/scenes/logic/look.ts'
import { trashedSceneName, compareTrashed } from '../../src/scenes/logic/names.ts'
import { DEFAULT_RENDER_PROMPT, REFERENCE_RENDER_PROMPT, alignResult, maskSizeProblem, modelChoice, renderPrice, renderPrompt } from '../../src/scenes/logic/render.ts'
import { BAD_META, TITLE_TOO_LONG, metaTitle, noScene, uploadFilename, storedFilename } from '../../src/scenes/logic/scene.ts'
import { checkScenePut, type ScenePatch } from '../../src/scenes/logic/sceneput.ts'
import { LOST_CALIBRATION, calibStatus, lightingStatus } from '../../src/scenes/logic/status.ts'
import { isoFromTimestamp, pyInt } from '../../src/scenes/logic/time.ts'
import { cmpCodePoints, codePointLength, collapseSpaces, isRecord, pyStr, pyTruthy, sortedStrings } from '../../src/scenes/logic/values.ts'
import { readWorkerLine } from '../../src/scenes/logic/worker.ts'
import { SceneService, publicCalib } from '../../src/scenes/service.ts'

const REPO = path.resolve(import.meta.dirname, '../../..')
const SCRATCH = path.join(REPO, 'evals/out/server-scenes-tests/logic')
const skipOracle = !fs.existsSync(path.join(REPO, 'planner/serve.py')) && 'planner/serve.py is gone'

/** v1's answers to the cases, in order. */
function oracle(cases: readonly { readonly fn: string; readonly args: readonly unknown[] }[]): unknown[] {
  const r = spawnSync('python3', ['-I', path.join(REPO, 'server/test/scenes/v1_oracle.py')], { input: JSON.stringify(cases), encoding: 'utf8', maxBuffer: 256 << 20 })
  if (r.status !== 0) throw new Error('the oracle failed: ' + r.stderr)
  const out: unknown = JSON.parse(r.stdout)
  if (!Array.isArray(out)) throw new Error('the oracle answered ' + r.stdout.slice(0, 200))
  return out.map((a: unknown) => (isRecord(a) && 'ok' in a ? a['ok'] : a))
}

// --- a seeded generator of JSON values --------------------------------------------------------------------------------
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const NUMBERS = [0, 1, -1, 0.5, 2.675, -0.125, 1e-7, 123456789.123456789, 55, 270, -400, 4, 0.25, 1e20, -1e-300, 3.0000004999]
const STRINGS = ['', ' ', 'x', '  Lounge  ', 'auto', 'manual', 'default', 'glb', 'splat', 'wall', 'floor', 'probe-box', 'Probe', 'a-b', 'é', '\u{1F600}', 'x'.repeat(121), ' \t\n ']

function pick<T>(r: () => number, xs: readonly T[]): T {
  const v = xs[Math.floor(r() * xs.length)]
  if (v === undefined) throw new Error('empty')
  return v
}

function scalar(r: () => number): unknown {
  const k = r()
  if (k < 0.35) return pick(r, NUMBERS)
  if (k < 0.65) return pick(r, STRINGS)
  if (k < 0.8) return r() < 0.5
  return null
}

function value(r: () => number, depth: number): unknown {
  const k = r()
  if (depth <= 0 || k < 0.6) return scalar(r)
  if (k < 0.8) return Array.from({ length: Math.floor(r() * 4) }, () => value(r, depth - 1))
  return objectOf(r, ['a', 'b', 'x'], depth - 1)
}

function objectOf(r: () => number, keys: readonly string[], depth: number, val: (r: () => number) => unknown = (q) => value(q, depth)): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const n = Math.floor(r() * (keys.length + 1))
  for (let i = 0; i < n; i++) out[pick(r, keys)] = val(r)
  return out
}

const CAMERA_KEYS = ['fov_y_deg', 'height_m', 'pitch_deg', 'roll_deg']
const LOOK_KEYS = ['exposure', 'warmth', 'light_azimuth_deg', 'light_elevation_deg', 'light_softness', 'light_strength', 'ambient', 'contact_shadows', 'auto_light', 'cast_shadows']

function sceneBody(r: () => number): unknown {
  if (r() < 0.05) return value(r, 2)
  const body: Record<string, unknown> = {}
  for (const key of ['title', 'camera', 'camera_source', 'look', 'zz']) {
    if (r() < (key === 'zz' ? 0.05 : 0.4)) {
      if (key === 'camera') body[key] = r() < 0.85 ? objectOf(r, r() < 0.9 ? CAMERA_KEYS : [...CAMERA_KEYS, 'zoom'], 0, (q) => (q() < 0.9 ? pick(q, NUMBERS) : scalar(q))) : value(r, 1)
      else if (key === 'look') body[key] = r() < 0.85 ? objectOf(r, r() < 0.9 ? LOOK_KEYS : [...LOOK_KEYS, 'sparkle'], 0, (q) => (q() < 0.5 ? pick(q, NUMBERS) : q() < 0.7 ? q() < 0.5 : q() < 0.8 ? null : scalar(q))) : value(r, 1)
      else if (key === 'camera_source') body[key] = r() < 0.7 ? pick(r, ['auto', 'manual', 'default']) : scalar(r)
      else body[key] = r() < 0.8 ? pick(r, STRINGS) : scalar(r)
    }
  }
  return body
}

/** A ScenePatch in v1's shape (the dict put_scene passes to update). */
function v1Patch(p: ScenePatch): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  if (p.title !== null) out['title'] = p.title.value
  if (p.camera !== null) out['camera'] = p.camera
  if (p.cameraSource !== null) out['camera_source'] = p.cameraSource
  if (p.look !== null) out['look'] = Object.fromEntries(p.look)
  return out
}

function putBody(body: unknown): Parameters<typeof checkScenePut>[0] {
  const rec = isRecord(body) ? body : null
  const camera = rec?.['camera']
  const look = rec?.['look']
  return {
    entries: rec === null ? null : Object.entries(rec),
    camera: isRecord(camera) ? camera : null,
    cameraEntries: isRecord(camera) ? Object.entries(camera) : null,
    lookEntries: isRecord(look) ? Object.entries(look) : null,
  }
}

void test('PUT /api/scenes/<name>: 3000 random bodies get v1\'s refusal or v1\'s patch', { skip: skipOracle }, () => {
  const r = rng(7)
  const bodies = Array.from({ length: 3000 }, () => sceneBody(r))
  const v1 = oracle(bodies.map((b) => ({ fn: 'put_scene', args: [b] })))
  let refused = 0
  bodies.forEach((body, i) => {
    const want = v1[i]
    const got = checkScenePut(putBody(body))
    const mine = got.ok ? { status: 200, patch: v1Patch(got.patch) } : { status: 400, error: got.error }
    if (!got.ok) refused += 1
    assert.deepEqual(mine, want, 'body ' + JSON.stringify(body))
  })
  assert.ok(refused > 300 && refused < 2700, String(refused) + ' refused: the corpus has both kinds')
})

void test('SceneService.update: the scene.json v1 writes for 1500 random accepted patches over odd scene.json files', { skip: skipOracle }, () => {
  const r = rng(11)
  const cases: { readonly scene: Record<string, unknown>; readonly body: unknown; readonly patch: ScenePatch }[] = []
  while (cases.length < 1500) {
    const body = sceneBody(r)
    const check = checkScenePut(putBody(body))
    if (!check.ok) continue
    const scene: Record<string, unknown> = { title: null, created: '2026-11-05T12:00:00Z', saved: null }
    if (r() < 0.9) scene['version'] = 1
    scene['camera'] = r() < 0.7 ? objectOf(r, CAMERA_KEYS, 0, (q) => pick(q, NUMBERS)) : value(r, 1)
    scene['camera_source'] = pick(r, ['auto', 'manual', 'default'])
    if (r() < 0.6) scene['look'] = r() < 0.8 ? objectOf(r, [...LOOK_KEYS, 'old'], 0, (q) => (q() < 0.5 ? pick(q, NUMBERS) : q() < 0.5)) : value(r, 1)
    cases.push({ scene, body, patch: check.patch })
  }
  const v1 = oracle(cases.map((c) => ({ fn: 'update', args: [c.scene, v1Patch(c.patch)] })))
  const dir = path.join(SCRATCH, 'update-' + String(process.pid))
  fs.rmSync(dir, { recursive: true, force: true })
  const name = 'scene-20261105-120000'
  const svc = new SceneService({ scenesDir: dir, layoutsDir: path.join(dir, 'layouts'), calib: ['false'], repo: REPO, log: () => undefined })
  cases.forEach((c, i) => {
    fs.mkdirSync(path.join(dir, name), { recursive: true })
    fs.writeFileSync(path.join(dir, name, 'scene.json'), JSON.stringify(c.scene))
    assert.ok(svc.update(name, c.patch))
    const file: unknown = JSON.parse(fs.readFileSync(path.join(dir, name, 'scene.json'), 'utf8'))
    assert.ok(isRecord(file))
    const mine = { ...file, saved: file['saved'] !== c.scene['saved'] }
    const want = v1[i]
    assert.ok(isRecord(want) && want['returned_matches_file'] === true)
    // JSON as JavaScript writes it: v1 wrote round(-1e-300, 6) as -0.0, v2 as 0 (the same number; server-core's notes)
    const plain = (v: unknown): unknown => JSON.parse(JSON.stringify(v))
    assert.deepEqual(plain(mine), plain(want['file']), 'scene.json ' + JSON.stringify(c.scene) + ' with ' + JSON.stringify(c.body))
    assert.deepEqual(Object.keys(mine), Object.keys(isRecord(want['file']) ? want['file'] : {}), 'key order')
  })
})

function layoutBody(r: () => number): unknown {
  if (r() < 0.05) return value(r, 2)
  const body: Record<string, unknown> = {}
  if (r() < 0.95) {
    body['items'] = r() < 0.95
      ? Array.from({ length: Math.floor(r() * 4) }, () => {
        if (r() < 0.05) return value(r, 1)
        const it: Record<string, unknown> = {}
        if (r() < 0.95) it['id'] = r() < 0.85 ? pick(r, ['probe-box', 'chair', 'a', 'Probe', 'x y']) : scalar(r)
        if (r() < 0.95) it['position'] = r() < 0.85 ? Array.from({ length: r() < 0.9 ? 3 : Math.floor(r() * 5) }, () => (r() < 0.95 ? pick(r, NUMBERS) : scalar(r))) : value(r, 1)
        if (r() < 0.6) it['rotation_y_deg'] = r() < 0.85 ? pick(r, NUMBERS) : scalar(r)
        if (r() < 0.4) it['uid'] = r() < 0.7 ? pick(r, ['u1', '', 'x']) : scalar(r)
        if (r() < 0.4) it['render'] = pick(r, ['glb', 'splat', 'mesh', 5])
        if (r() < 0.3) it['mounted'] = pick(r, ['floor', 'wall', 'ceiling', null])
        if (r() < 0.4) it['dims_cm'] = r() < 0.8 ? objectOf(r, ['w', 'd', 'h', 'x'], 0, (q) => (q() < 0.9 ? pick(q, NUMBERS) : scalar(q))) : value(r, 1)
        return it
      })
      : value(r, 1)
  }
  for (const key of ['title', 'library', 'notes', 'name', 'scene_name', 'updated', 'version']) if (r() < 0.3) body[key] = r() < 0.7 ? pick(r, STRINGS) : scalar(r)
  return body
}

void test('PUT /api/layouts/<layout>: 3000 random bodies get v1\'s refusal or v1\'s stored layout', { skip: skipOracle }, () => {
  const r = rng(13)
  const bodies = Array.from({ length: 3000 }, () => layoutBody(r))
  const v1 = oracle(bodies.map((b) => ({ fn: 'put_layout', args: [b, 'reading-corner'] })))
  let stored = 0
  bodies.forEach((body, i) => {
    const got = checkLayout(body, 'reading-corner', 'scene-20261105-120000', '2026-11-05T12:00:00Z')
    const mine = got.ok ? { status: 200, data: got.layout } : { status: 400, error: got.error }
    if (got.ok) stored += 1
    assert.deepEqual(JSON.parse(JSON.stringify(mine)), v1[i], 'body ' + JSON.stringify(body))
  })
  assert.ok(stored > 300 && stored < 2700, String(stored) + ' stored: the corpus has both kinds')
})

void test('clamp_camera, public_calib, name order, trashed folder names, no_scene: as v1', { skip: skipOracle }, () => {
  const r = rng(17)
  const cams = Array.from({ length: 500 }, () => (r() < 0.9 ? objectOf(r, [...CAMERA_KEYS, 'x'], 0, (q) => (q() < 0.8 ? pick(q, NUMBERS) : scalar(q))) : value(r, 1)))
  const calibs = [null, {}, { exif: null }, { exif: { make: 'A', model: 'B', focal_35mm: 26 }, source: 'moge-2' }, { exif: [1] }, { a: 1, exif: { model: 'x' }, z: 2 }]
  const names = ['scene-20261104-201500', 'scene-20261104-201500-2', 'scene-20261104-201500-10', 'scene-20261104-201500-', 'lounge', 'scene-x-20261104-201500',
    'scene-20261104-201500-007', 'a20261104-201500', '20261104-201500-3']
  const trashedNames = ['scene-20261104-201500-20261105-101010', 'scene-20261104-201500-2-20261105-101010-3', 'lounge-20261105-101010', 'scene-20261104-201500',
    'scene-٢٠٢٦١١٠٤-201500-20261105-101010', 'Scene-20261104-201500-20261105-101010', 'scene-20261104-201500-20261105-101010\n']
  const notSlugs = ['', 'Bad Name', 'evil\n', '..', 'é', 'x'.repeat(65), "it's", 'a"b\'c']
  const cases = [
    ...cams.map((c) => ({ fn: 'clamp_camera', args: [c] })),
    ...calibs.map((c) => ({ fn: 'public_calib', args: [c] })),
    ...trashedNames.map((n) => ({ fn: 'trashed', args: [n] })),
    ...notSlugs.map((n) => ({ fn: 'no_scene', args: [n] })),
    ...names.map((n) => ({ fn: 'name_order', args: [n] })),
  ]
  const v1 = oracle(cases)
  let i = 0
  for (const c of cams) assert.deepEqual(clampCamera(isRecord(c) ? c : null), v1[i++], JSON.stringify(c))
  for (const c of calibs) assert.deepEqual(publicCalib(isRecord(c) ? c : null), v1[i++], JSON.stringify(c))
  for (const n of trashedNames) assert.equal(trashedSceneName(n), v1[i++], JSON.stringify(n))
  for (const n of notSlugs) assert.deepEqual({ status: 404, error: noScene(n) }, v1[i++], JSON.stringify(n))
  const orders = names.map(() => v1[i++])
  // compareNames is the kernel's (k-media): the order v1's (prefix, number) keys give
  for (let a = 0; a < names.length; a++) {
    for (let b = 0; b < names.length; b++) {
      const ka = orders[a]
      const kb = orders[b]
      assert.ok(Array.isArray(ka) && Array.isArray(kb))
      const want = cmpCodePoints(String(ka[0]), String(kb[0])) || Math.sign(Number(ka[1]) - Number(kb[1]))
      assert.equal(compareNames(names[a] ?? '', names[b] ?? ''), want, (names[a] ?? '') + ' vs ' + (names[b] ?? ''))
    }
  }
})

void test('file times: st_mtime, int(st_mtime) and iso_utc(st_mtime) as CPython computes them, near second boundaries', { skip: skipOracle }, () => {
  const dir = path.join(SCRATCH, 'mtime-' + String(process.pid))
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
  const nsecs = [0, 1, 499_999, 500_000, 500_001, 999_999_499, 999_999_500, 999_999_501, 999_999_999, 123_456_789, 999_000_000, 499_999_999]
  const secs = [1_793_922_941, 1_700_000_000, 1_000_000_000, 86_400, 1_234_567_890]
  const ns: bigint[] = []
  for (const s of secs) for (const n of nsecs) ns.push(BigInt(s) * 1_000_000_000n + BigInt(n))
  const v1 = oracle(ns.map((n) => ({ fn: 'mtime', args: [n.toString(), dir] })))
  ns.forEach((_, i) => {
    const want = v1[i]
    assert.ok(isRecord(want) && typeof want['path'] === 'string', JSON.stringify(want))
    const t = mtimeOf(want['path'])
    assert.ok(t !== null)
    assert.equal(pyFloatRepr(t), want['repr'])
    assert.equal(pyInt(t), want['int'])
    assert.equal(isoFromTimestamp(t), want['iso'])
  })
})

void test('job sentences: light and calibrated messages as v1', { skip: skipOracle }, () => {
  const ccts: unknown[] = [4500.5, 4501.5, 4700, 4700.4999, 0.5, -0.5, 1e300, null, '4500', true, 1e-9]
  const calibs: Record<string, unknown>[] = [
    { source: 'moge-2', floor: { found: true } }, { source: 'truth', floor: { found: 1 } }, { source: 'moge-2', floor: { found: false } },
    { source: 'exif', floor: { found: true } }, { source: 'default' }, {}, { source: '' }, { source: 5 }, { source: 'moge-2', floor: [true] },
    { source: 'truth', floor: { found: [] } }, { source: true }, { source: [1, 'a'] }, { source: { a: 1 } },
  ]
  const cases = [
    ...ccts.flatMap((c) => [{ fn: 'light_message', args: [true, c] }, { fn: 'light_message', args: [false, c] }]),
    ...calibs.map((c) => ({ fn: 'calibrated_message', args: [c] })),
  ]
  const v1 = oracle(cases)
  let i = 0
  for (const c of ccts) {
    assert.equal(lightMessage(true, c), v1[i++], 'cct ' + JSON.stringify(c))
    assert.equal(lightMessage(false, c), v1[i++])
  }
  for (const c of calibs) {
    const floor = c['floor']
    assert.equal(calibratedMessage(c['source'], isRecord(floor) ? floor['found'] : undefined), v1[i++], JSON.stringify(c))
  }
})

void test('direct cases: statuses, names, values, render choices, worker lines', () => {
  assert.deepEqual(calibStatus(null, false), { status: 'failed', error: LOST_CALIBRATION })
  assert.deepEqual(calibStatus({ status: 'done', message: 'x' }, true), { status: 'done', error: null })
  assert.deepEqual(calibStatus({ status: 'done', message: 'x' }, false), { status: 'failed', error: LOST_CALIBRATION })
  assert.deepEqual(calibStatus({ status: 'failed', message: 'no' }, true), { status: 'failed', error: 'no' })
  const light = { status: 'done' as const, message: 'm', lighting: false, dropped: false }
  assert.deepEqual(lightingStatus(false, light, null, false), { status: 'none', error: null })
  assert.deepEqual(lightingStatus(false, { ...light, lighting: true }, null, false), { status: 'missing', error: null })
  assert.deepEqual(lightingStatus(false, { ...light, status: 'failed', message: '' }, null, false), { status: 'failed', error: 'inferring the light failed' })
  assert.deepEqual(lightingStatus(false, light, { status: 'running', message: '' }, true), { status: 'running', error: null })
  assert.deepEqual(lightingStatus(false, { ...light, dropped: true }, { status: 'queued', message: '' }, false), { status: 'pending', error: null })
  assert.deepEqual(lightingStatus(true, light, null, false), { status: 'done', error: null })

  assert.equal(compareTrashed({ name: 'a', title: null, created: null, deleted: '2026', dir: 'a' }, { name: 'b', title: null, created: null, deleted: '2026', dir: 'b' }), 1)
  assert.equal(cmpCodePoints('\u{1F600}', '\uffff'), 1, 'code points, not UTF-16 units')
  assert.deepEqual(sortedStrings(['b', '\u{1F600}', '\uffff', 'a']), ['a', 'b', '\uffff', '\u{1F600}'])
  assert.equal(codePointLength('\u{1F600}x'), 2)
  assert.equal(collapseSpaces('  a \u3000\t b\u2028c  '), 'a b c')
  assert.equal(collapseSpaces('\ufeffa'), '\ufeffa', 'Python\'s whitespace has no U+FEFF')
  assert.equal(pyStr([1, 'a', null, true, { k: 2.5 }]), "[1, 'a', None, True, {'k': 2.5}]")
  assert.equal(pyTruthy({}), false)
  assert.equal(pyTruthy(Number.NaN), true)

  assert.equal(uploadFilename('C:\\photos\\IMG_0042.HEIC '), 'IMG_0042.HEIC')
  assert.equal(uploadFilename('a/b/'), 'b')
  assert.equal(storedFilename('é'.repeat(250)), 'é'.repeat(200))
  assert.deepEqual(metaTitle({ title: 5 }), { ok: false, error: BAD_META })
  assert.deepEqual(metaTitle({ title: 'x'.repeat(201) }), { ok: false, error: TITLE_TOO_LONG })
  assert.deepEqual(metaTitle({}), { ok: true, title: null })

  assert.deepEqual(modelChoice(''), { kind: 'model', model: 'nano-banana' })
  assert.deepEqual(modelChoice(0), { kind: 'model', model: 'nano-banana' })
  assert.deepEqual(modelChoice(true), { kind: 'refused', error: 'unknown model True (choose from kontext, nano-banana, qwen)' })
  assert.deepEqual(modelChoice(1.5), { kind: 'refused', error: 'unknown model 1.5 (choose from kontext, nano-banana, qwen)' })
  assert.equal(renderPrice('qwen', 4000, 3000), 0.36)
  assert.equal(renderPrice('qwen', 1600, 1200), 0.0576)
  assert.equal(renderPrompt(null, true), REFERENCE_RENDER_PROMPT)
  assert.equal(renderPrompt(' \u3000 ', false), DEFAULT_RENDER_PROMPT)
  assert.equal(maskSizeProblem(10, 10, null, null), null)
  assert.deepEqual(alignResult({ applied: true, inliers: 50, residual_px: 1.5 }, false), { applied: false, inliers: 50, residual_px: 1.5, reason: 'align said it applied but wrote no image' })
  assert.deepEqual(alignResult({ applied: false, inliers: true }, false), { applied: false, inliers: null, residual_px: null, reason: 'align did not apply' })

  assert.deepEqual(readWorkerLine('{"id": "c-1", "ok": true, "x": 1}', 'c-1'), { kind: 'answer', ok: true, result: [['ok', true], ['x', 1]] })
  assert.equal(readWorkerLine('{"id": "c-2", "ok": true}', 'c-1').kind, 'garbled')
  assert.equal(readWorkerLine('[1]', 'c-1').kind, 'garbled')
  assert.equal(readWorkerLine('NaN', 'c-1').kind, 'garbled')
  assert.deepEqual(readWorkerLine('{"id": "c-1", "ok": false, "error": "e"}', 'c-1'), { kind: 'answer', ok: false, result: [['ok', false], ['error', 'e']] })

  assert.equal(timedOut('calibrate', 600), 'the calibration ran for more than 10 minutes and was stopped')
  assert.equal(timedOut('light', 600), 'inferring the light ran for more than 10 minutes and was stopped')
  assert.equal(notInstalled('uv'), "the calibration tool isn't installed here (uv not found): set --calib")
  assert.ok(LOOK_HELP.startsWith('look takes exposure (0.25 to 4)'))
  assert.deepEqual(mergeLook([['exposure', 1], ['old', 'x']], [['exposure', null], ['warmth', 9], ['auto_light', false]]), [['old', 'x'], ['warmth', 1], ['auto_light', false]])
  assert.deepEqual(DEFAULT_CAMERA, { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 })
  assert.deepEqual(layoutSummary('a', { title: ' \t', items: [1, 2], updated: 5 }, 'T'), { name: 'a', title: null, items: 2, updated: 'T' })
})
