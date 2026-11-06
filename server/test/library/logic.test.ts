// The library's pure ports against v1 itself: every X-Midstudy-Meta below is validated by the TypeScript checkMeta
// (read with pyValueFromText, as the route reads the header) and by v1's own check_meta (json.loads, planner/serve.py),
// for both kinds, and the answers must be equal: the same fields, or the same sentence. add_command's argument lists
// too. Plus the pure helpers (repr, ordering, the upload rules, PATCH's plan) on their own.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pyValue, pyValueFromText } from '../../src/library/json.ts'
import { addArgv, checkMeta, type AddMeta, type UploadKind } from '../../src/library/logic/meta.ts'
import { trashName, trashOrder } from '../../src/library/logic/messages.ts'
import { checkPatch, needsRefit, patchShape } from '../../src/library/logic/patch.ts'
import { pyCompare, pyValueRepr } from '../../src/library/logic/pyvalue.ts'
import { extProblem, suffixOf, tooLarge, uploadFilename, uploadKind } from '../../src/library/logic/upload.ts'
import { resolvePath as resolved } from '../../../common/files.ts'
import { oracle, skipV1, type OracleAnswer, type OracleCase } from './oracle.ts'

const base = '{"name": "Reading Chair", "dims_cm": {"w": 80, "d": 85, "h": 95}'
const meta = (extra: string): string => base + (extra === '' ? '' : ', ' + extra) + '}'

/** Every X-Midstudy-Meta text the differential test tries (each for both kinds). */
const METAS: string[] = [
  meta(''),
  '{"dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": null, "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": 5, "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": ["a"], "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "   ", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "\\u3000\\u00a0", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "\\ufeff", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": " Chair ", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "Ça va, Élise", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "!!!", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "日本語", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "It\'s \\"quoted\\"\\n\\ttab", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "' + 'Long name '.repeat(12) + '", "dims_cm": {"w": 1, "d": 1, "h": 1}}',
  '{"name": "-Shelf", "dims_cm": {"w": 40, "d": 20, "h": 10}}',
  '{"name": "x", "dims_cm": {"w": 1, "d": 1, "h": 1}, "name": "Last Name Wins"}',
  '{"name": "X"}',
  '{"name": "!!!"}',
  '{"name": "X", "dims_cm": null}',
  '{"name": "X", "dims_cm": []}',
  '{"name": "X", "dims_cm": {}}',
  '{"name": "X", "dims_cm": {"w": 1}}',
  '{"name": "X", "dims_cm": {"w": 0, "d": 1, "h": 1}}',
  '{"name": "X", "dims_cm": {"w": -1, "d": 1, "h": 1}}',
  '{"name": "X", "dims_cm": {"w": true, "d": 1, "h": 1}}',
  '{"name": "X", "dims_cm": {"w": "80", "d": 1, "h": 1}}',
  '{"name": "X", "dims_cm": {"w": null, "d": 1, "h": 1}}',
  '{"name": "X", "dims_cm": {"w": 80.0, "d": 85.5, "h": 1e2}}',
  '{"name": "X", "dims_cm": {"w": 1e-7, "d": 0.1, "h": 2.5e-5}}',
  '{"name": "X", "dims_cm": {"w": 12345678901234567890, "d": 1e21, "h": 1E3}}',
  '{"name": "X", "dims_cm": {"w": 80, "d": 85, "h": 95, "x": "ignored"}}',
  '{"name": "X", "dims_cm": {"w": 1.5e300, "d": 0.000123, "h": 33.333333333333336}}',
  meta('"id": null'),
  meta('"id": ""'),
  meta('"id": "bad id"'),
  meta('"id": "Bad"'),
  meta('"id": "ok-id-2"'),
  meta('"id": "-x"'),
  meta('"id": "' + 'a'.repeat(64) + '"'),
  meta('"id": "' + 'a'.repeat(65) + '"'),
  meta('"id": 5'),
  meta('"id": 5.0'),
  meta('"id": -0'),
  meta('"id": true'),
  meta('"id": []'),
  meta('"id": {"a": [1, 2.5, null, "x"]}'),
  meta('"id": "x\\n"'),
  meta('"id": "é"'),
  meta('"category": null'),
  meta('"category": ""'),
  meta('"category": "  "'),
  meta('"category": " sofa "'),
  meta('"category": 5'),
  meta('"category": true'),
  meta('"category": []'),
  meta('"prompt": " chair "'),
  meta('"prompt": ""'),
  meta('"prompt": 1.5'),
  meta('"mount": null'),
  meta('"mount": "floor"'),
  meta('"mount": "wall"'),
  meta('"mount": "Floor"'),
  meta('"mount": ""'),
  meta('"mount": 0'),
  meta('"mount": 0.0'),
  meta('"mount": false'),
  meta('"mount": []'),
  meta('"mount": {"a": 1}'),
  meta('"yaw": null'),
  meta('"yaw": ""'),
  meta('"yaw": 0'),
  meta('"yaw": 0.0'),
  meta('"yaw": -0.0'),
  meta('"yaw": 90'),
  meta('"yaw": 90.0'),
  meta('"yaw": 9e1'),
  meta('"yaw": 270.0'),
  meta('"yaw": 45'),
  meta('"yaw": 45.0'),
  meta('"yaw": 45.5'),
  meta('"yaw": 360'),
  meta('"yaw": -90'),
  meta('"yaw": "90"'),
  meta('"yaw": true'),
  meta('"yaw": false'),
  meta('"yaw": []'),
  meta('"yaw": 1e400'),
  meta('"engine": null'),
  meta('"engine": ""'),
  meta('"engine": "idol"'),
  meta('"engine": "sam3d"'),
  meta('"engine": "trellis2"'),
  meta('"engine": "rug"'),
  meta('"engine": "glb"'),
  meta('"engine": "GLB"'),
  meta('"engine": "foo"'),
  meta('"engine": 0'),
  meta('"engine": 0.0'),
  meta('"engine": 1'),
  meta('"engine": false'),
  meta('"engine": true'),
  meta('"engine": []'),
  meta('"engine": {}'),
  meta('"engine": ["idol"]'),
  meta('"resolution": null'),
  meta('"resolution": ""'),
  meta('"resolution": 512'),
  meta('"resolution": 1024'),
  meta('"resolution": 1536'),
  meta('"resolution": 1024.0'),
  meta('"resolution": 999'),
  meta('"resolution": "512"'),
  meta('"resolution": true'),
  meta('"resolution": false'),
  meta('"resolution": 0'),
  meta('"engine": "trellis2", "resolution": 1536'),
  meta('"engine": "trellis2", "resolution": 1024.0, "yaw": 180, "mount": "wall", "category": "chair"'),
  meta('"engine": "sam3d", "prompt": "the chair", "yaw": 270'),
  meta('"engine": "idol", "prompt": "ignored for idol"'),
  meta('"engine": "rug", "category": "rug"'),
  meta('"unknown": 1, "also": [1, 2]'),
  '{"name": 5, "dims_cm": null, "id": "Bad"}',
  '{"name": "X", "dims_cm": null, "id": "Bad"}',
  '{"name": "!!!", "dims_cm": {"w": 1, "d": 1, "h": 1}, "category": 5}',
  '{"name": "X", "dims_cm": {"w": 1, "d": 1, "h": 1}, "id": "Bad", "category": 5}',
  '{"name": "X", "dims_cm": {"w": 1, "d": 1, "h": 1}, "category": 5, "prompt": 5}',
  '{"name": "X", "dims_cm": {"w": 1, "d": 1, "h": 1}, "prompt": 5, "mount": 5}',
  '{"name": "X", "dims_cm": {"w": 1, "d": 1, "h": 1}, "mount": 5, "yaw": 5}',
  '{"name": "X", "dims_cm": {"w": 1, "d": 1, "h": 1}, "yaw": 5, "engine": "foo"}',
  '{"name": "X", "dims_cm": {"w": 1, "d": 1, "h": 1}, "engine": "foo", "resolution": 5}',
  '[]',
  '"text"',
  '5',
  'null',
]
const KINDS: readonly UploadKind[] = ['image', 'model']

/** The TypeScript answer in the oracle's shape. */
function mine(text: string, kind: UploadKind): OracleAnswer {
  const v = pyValueFromText(text)
  if (v === null) return { error: 'unparsed' }
  const r = checkMeta(v, kind)
  if (!r.ok) return { error: 'ValueError: ' + r.error }
  const m = r.value
  return {
    ok: {
      name: m.name, dims: m.dims.arg, cm: [m.dims.w, m.dims.d, m.dims.h], id: m.id, category: m.category, prompt: m.prompt, mount: m.mount, yaw: m.yaw,
      engine: m.engine, resolution: m.resolution, estimate: m.estimate,
    },
  }
}

void test('checkMeta equals v1 check_meta on every meta, for images and models', { skip: skipV1 }, () => {
  const cases: OracleCase[] = []
  const ours: OracleAnswer[] = []
  for (const text of METAS) {
    for (const kind of KINDS) {
      cases.push({ fn: 'check_meta', args: [text, kind] })
      ours.push(mine(text, kind))
    }
  }
  const v1 = oracle(cases)
  const diffs: string[] = []
  for (let i = 0; i < cases.length; i++) {
    try {
      assert.deepEqual(ours[i], v1[i])
    } catch {
      diffs.push(JSON.stringify(cases[i]?.args) + '\n  v1: ' + JSON.stringify(v1[i]) + '\n  v2: ' + JSON.stringify(ours[i]))
    }
  }
  assert.equal(diffs.length, 0, String(diffs.length) + ' of ' + String(cases.length) + ' differ:\n' + diffs.join('\n'))
  assert.ok(cases.length >= 260, String(cases.length))
})

void test('addArgv equals v1 add_command (every flag as --opt=<v>, the input and library resolved)', { skip: skipV1 }, () => {
  const argvBase = ['uv', 'run', '--project', 'pipeline', 'midstudy-add']
  const src = '/nonexistent-midstudy-upload/upload.glb'
  const lib = '/nonexistent-midstudy-library'
  const picks: readonly (readonly [string, UploadKind, string])[] = [
    [meta(''), 'model', 'chair.glb'],
    [meta('"category": " sofa ", "mount": "wall", "yaw": 90.0'), 'model', 'Sofa Model.zip'],
    ['{"name": "-Shelf", "id": "dash-shelf", "dims_cm": {"w": 40.5, "d": 2e1, "h": 10}}', 'model', '-x.glb'],
    [meta('"engine": "sam3d", "prompt": " the chair ", "yaw": 270'), 'image', 'IMG_0001.HEIC'],
    [meta('"engine": "sam3d", "prompt": "   "'), 'image', 'a.jpg'],
    [meta('"engine": "idol", "prompt": "never passed"'), 'image', 'https://example.com/a.jpg?x=1'],
    [meta('"engine": "trellis2", "resolution": 1536.0, "mount": "floor"'), 'image', 'a.png'],
    [meta('"engine": "rug", "category": "rug"'), 'image', 'rug.webp'],
  ]
  const cases: OracleCase[] = picks.map(([text, kind, label]) => ({ fn: 'add_command', args: [argvBase, src, lib, label, text, kind] }))
  const v1 = oracle(cases)
  picks.forEach(([text, kind, label], i) => {
    const v = pyValueFromText(text)
    assert.ok(v !== null)
    const r = checkMeta(v, kind)
    assert.ok(r.ok, text)
    const m: AddMeta = r.value
    assert.deepEqual({ ok: addArgv(argvBase, resolved(src), resolved(lib), label, m) }, v1[i], text)
  })
})

void test('pyValueFromText keeps ints and floats apart; pyValue reads JSON.parse results', () => {
  const v = pyValueFromText('{"a": 5, "b": 5.0, "c": -0, "d": 1e2, "e": [true, null, "x"], "f": 12345678901234567890}')
  assert.ok(v !== null)
  assert.equal(pyValueRepr(v), "{'a': 5, 'b': 5.0, 'c': 0, 'd': 100.0, 'e': [True, None, 'x'], 'f': 12345678901234567890}")
  assert.equal(pyValueRepr(pyValue(JSON.parse('{"b": 5.0, "x": [1.5, {}]}'))), "{'b': 5, 'x': [1.5, {}]}")
  assert.equal(pyValueFromText('{"a": NaN}'), null)
  assert.equal(pyValueFromText('['.repeat(2000) + ']'.repeat(2000)), null)
})

void test('Python string order (code points), the trash order and names', () => {
  assert.ok(pyCompare('\u{10000}', '\uffff') > 0, 'an astral character sorts after U+FFFF, as in Python')
  assert.ok(pyCompare('a', 'b') < 0 && pyCompare('b', 'a') > 0 && pyCompare('ab', 'a') > 0 && pyCompare('', '') === 0)
  const keys = [{ deleted: '2026-01-01T00:00:00Z', dir: 'b' }, { deleted: '2026-01-02T00:00:00Z', dir: 'a' }, { deleted: '2026-01-01T00:00:00Z', dir: 'c' }, { deleted: 'None', dir: 'z' }]
  assert.deepEqual([...keys].sort(trashOrder).map((k) => k.dir), ['z', 'a', 'c', 'b'])
  assert.equal(trashName('chair', Date.UTC(2026, 10, 5, 1, 2, 3), 1), 'chair-20261105-010203')
  assert.equal(trashName('chair', Date.UTC(2026, 10, 5, 1, 2, 3), 3), 'chair-20261105-010203-3')
})

void test('the upload rules: X-Midstudy-Kind, the file name, its extension, the limits', () => {
  assert.equal(uploadKind(' Model '), 'model')
  assert.equal(uploadKind('IMAGE'), 'image')
  assert.equal(uploadKind('photo'), null)
  assert.equal(uploadKind(undefined), null)
  assert.equal(uploadFilename('C:\\Users\\me\\chair.glb'), 'chair.glb')
  assert.equal(uploadFilename('dir/'), 'dir')
  assert.equal(uploadFilename('/'), '')
  assert.equal(uploadFilename(undefined), '')
  assert.deepEqual(['a.GLB', '.glb', 'a.', 'a', 'a.tar.gz', '..'].map(suffixOf), ['.glb', '', '', '', '.gz', ''])
  assert.equal(extProblem('model', '.usdz'), ".usdz isn't supported: convert to GLB first (e.g. Reality Converter or Blender)")
  assert.equal(extProblem('model', '.gltf'), 'a .gltf needs its side files: convert it to .glb first, or zip an .obj with its .mtl and textures')
  assert.equal(extProblem('model', '.obj'), 'a model must be a .glb, or a .zip holding one .obj with its .mtl and textures')
  assert.equal(extProblem('model', '.zip'), null)
  assert.equal(extProblem('image', '.heif'), null)
  assert.equal(extProblem('image', '.gif'), 'a photo must be a JPEG, PNG, HEIC or WebP file')
  assert.equal(tooLarge('image', 21 * 1024 * 1024), 'that file is 21.0 MB: photos can be at most 20 MB')
  assert.equal(tooLarge('model', 200 * 1024 * 1024 + 1), 'that file is 200.1 MB: models can be at most 200 MB')
})

void test("PATCH's shape, rules, plan and refit", () => {
  const body = (text: string): ReturnType<typeof patchShape> => patchShape(pyValue(JSON.parse(text)))
  assert.deepEqual(body('[]'), { ok: false, error: 'the body must be a JSON object with any of name, category, mount, yaw, default_render, dims_cm' })
  assert.deepEqual(body('{}'), { ok: false, error: 'the body must be a JSON object with any of name, category, mount, yaw, default_render, dims_cm' })
  assert.deepEqual(body('{"zz": 1, "Z": 1, "é": 1, "name": "x"}'), { ok: false, error: "Z, zz, é can't be edited: use name, category, mount, yaw, default_render or dims_cm" })
  const facts = { hasSplat: true, hasGlb: true, idol: false }
  const plan = (text: string, f = facts): ReturnType<typeof checkPatch> => {
    const shape = body(text)
    assert.ok(shape.ok)
    return checkPatch(shape.value, f)
  }
  assert.deepEqual(plan('{"name": " x ", "category": "  ", "mount": "wall", "default_render": "splat"}'),
    { ok: true, value: { sets: [{ key: 'name', value: 'x' }, { key: 'category', value: '' }, { key: 'mount', value: 'wall' }, { key: 'default_render', value: 'splat' }], yaw: 0, dims: null } })
  assert.deepEqual(plan('{"name": " "}'), { ok: false, error: 'name must be non-empty text' })
  assert.deepEqual(plan('{"category": 5}'), { ok: false, error: 'category must be text or null' })
  assert.deepEqual(plan('{"mount": null}'), { ok: false, error: 'mount must be floor or wall' })
  assert.deepEqual(plan('{"default_render": "mesh"}'), { ok: false, error: 'default_render must be glb or splat' })
  assert.deepEqual(plan('{"default_render": "splat"}', { hasSplat: false, hasGlb: true, idol: false }), { ok: false, error: "this item has no splat asset, so it can't be its default render" })
  assert.deepEqual(plan('{"default_render": "glb"}', { hasSplat: true, hasGlb: true, idol: true }), { ok: false, error: 'an Idol piece has no mesh to show: its model.glb is a stand-in box' })
  assert.deepEqual(plan('{"yaw": 45}'), { ok: false, error: 'yaw must be 0, 90, 180 or 270 (degrees, relative to now)' })
  assert.deepEqual(plan('{"yaw": true}'), { ok: false, error: 'yaw must be 0, 90, 180 or 270 (degrees, relative to now)' })
  assert.deepEqual(plan('{"yaw": false, "name": "x"}'), { ok: true, value: { sets: [{ key: 'name', value: 'x' }], yaw: 0, dims: null } })
  assert.deepEqual(plan('{"dims_cm": {"w": 1}}'), { ok: false, error: 'dims_cm is required: {"w": ..., "d": ..., "h": ...} in cm, all greater than 0' })
  const ok = plan('{"yaw": 180.0, "dims_cm": {"w": 70, "d": 65.5, "h": 85}}')
  assert.ok(ok.ok)
  assert.equal(ok.value.yaw, 180)
  assert.equal(ok.value.dims?.arg, '70x65.5x85')
  assert.equal(needsRefit(ok.value, { w: 70, d: 65.5, h: 85 }), true)
  const same = plan('{"dims_cm": {"w": 70, "d": 65.5, "h": 85}}')
  assert.ok(same.ok)
  assert.equal(needsRefit(same.value, { w: 70, d: 65.5, h: 85 }), false)
  assert.equal(needsRefit(same.value, { w: 70, d: 65, h: 85 }), true)
})
