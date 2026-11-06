// The scenes logic (server/src/scenes/logic/): direct cases for the statuses, names, values, render choices, worker
// lines and job sentences. (Until the v2 cutover this file also compared the logic with v1's own Python on seeded random
// inputs, through an oracle that imported planner/serve.py; that went with v1, see docs/notes/cutover.md.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DEFAULT_CAMERA } from '../../src/scenes/logic/camera.ts'
import { timedOut, notInstalled } from '../../src/scenes/logic/jobs.ts'
import { layoutSummary } from '../../src/scenes/logic/layout.ts'
import { LOOK_HELP, mergeLook } from '../../src/scenes/logic/look.ts'
import { compareTrashed } from '../../src/scenes/logic/names.ts'
import { DEFAULT_RENDER_PROMPT, REFERENCE_RENDER_PROMPT, alignResult, maskSizeProblem, modelChoice, renderPrice, renderPrompt } from '../../src/scenes/logic/render.ts'
import { BAD_META, TITLE_TOO_LONG, metaTitle, uploadFilename, storedFilename } from '../../src/scenes/logic/scene.ts'
import { LOST_CALIBRATION, calibStatus, lightingStatus } from '../../src/scenes/logic/status.ts'
import { cmpCodePoints, codePointLength, collapseSpaces, pyStr, pyTruthy, sortedStrings } from '../../src/scenes/logic/values.ts'
import { readWorkerLine } from '../../src/scenes/logic/worker.ts'

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
  assert.deepEqual(modelChoice(true), { kind: 'refused', error: 'unknown model True (choose from kontext, nano-banana, qwen, gpt-image)' })
  assert.deepEqual(modelChoice(1.5), { kind: 'refused', error: 'unknown model 1.5 (choose from kontext, nano-banana, qwen, gpt-image)' })
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
