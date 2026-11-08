// node:test of decodePly's header checks (planner/gpu/splat-data.ts).
// .mjs: tsconfig.planner.json has no node types; Node strips the types of the import-free .ts module it loads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { decodePly } from '../splat-data.ts'

const PROPS = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
const VERTEX_PROPS = PROPS.map((name) => `property float ${name}`)
const headerOf = (lines) => ['ply', 'format binary_little_endian 1.0', ...lines, 'end_header', ''].join('\n')

// One splat at (1, 2, 3): the header, then the vertex floats.
function ply(lines) {
  const head = new TextEncoder().encode(headerOf(lines))
  const body = new Float32Array(PROPS.length)
  body.set([1, 2, 3])
  body[10] = 1 // rot_0 = w
  const out = new Uint8Array(head.length + body.byteLength)
  out.set(head)
  out.set(new Uint8Array(body.buffer), head.length)
  return out
}

test('decodePly: a vertex-only PLY decodes', () => {
  const d = decodePly(ply(['element vertex 1', ...VERTEX_PROPS]))
  assert.equal(d.count, 1)
  assert.deepEqual([...d.centers], [1, 2, 3])
})

test('decodePly: an element after vertex stays fine (the data view covers only the vertices)', () => {
  const d = decodePly(ply(['element vertex 1', ...VERTEX_PROPS, 'element face 0', 'property list uchar int vertex_indices']))
  assert.equal(d.count, 1)
  assert.deepEqual([...d.centers], [1, 2, 3])
})

test('decodePly: an element declared before vertex is refused', () => {
  assert.throws(() => decodePly(ply(['element face 0', 'element vertex 1', ...VERTEX_PROPS])), /must declare its vertex element first/)
})

for (const [label, line] of [['not a number', 'element vertex abc'], ['missing', 'element vertex'], ['fractional', 'element vertex 0.5'], ['negative', 'element vertex -1'], ['past 2^53', 'element vertex 9007199254740993']]) {
  test(`decodePly: a vertex count that is ${label} is refused`, () => {
    assert.throws(() => decodePly(ply([line, ...VERTEX_PROPS])), /vertex count is not a number/)
  })
}
