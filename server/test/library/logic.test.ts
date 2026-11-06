// The library's pure helpers on their own: Python's values (ints and floats apart, repr, ordering), the trash names
// and order, the upload rules and PATCH's plan. (Until the v2 cutover this file also compared checkMeta and addArgv
// with v1's own check_meta and add_command, through an oracle that imported planner/serve.py; that went with v1, see
// docs/notes/cutover.md.)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pyValue, pyValueFromText } from '../../src/library/json.ts'
import { trashName, trashOrder } from '../../src/library/logic/messages.ts'
import { checkPatch, needsRefit, patchShape } from '../../src/library/logic/patch.ts'
import { pyCompare, pyValueRepr } from '../../src/library/logic/pyvalue.ts'
import { extProblem, suffixOf, tooLarge, uploadFilename, uploadKind } from '../../src/library/logic/upload.ts'

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
