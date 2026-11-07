// node:test of the splat layer's pure decisions (planner/logic/splats.ts): the CPU sort's state machine and the sort key.
// .mjs: tsconfig.planner.json has no node types; Node strips the types of the import-free .ts module it loads.
import test from 'node:test'
import assert from 'node:assert/strict'
import { cpuReplyVerdict, cpuSortAction, cpuSortStart, sortKey } from '../../logic/splats.ts'

const up = (over = {}) => ({ ...cpuSortStart(), worker: 'up', sortedKey: 'K0', ...over })
const pend = (over = {}) => ({ id: 1, key: 'K1', version: 3, superseded: false, ...over })

test('cpuSortAction: nothing when the drawn order is the wanted one', () => {
  assert.equal(cpuSortAction(up(), 'K0', false), 'none')
  assert.equal(cpuSortAction(up({ worker: 'down', pending: pend() }), 'K0', true), 'none')
})

test('cpuSortAction: a down worker with a request left pending sorts here, never waits (the deadlock)', () => {
  assert.equal(cpuSortAction(up({ worker: 'down', pending: pend() }), 'K2', false), 'here')
  assert.equal(cpuSortAction(up({ worker: 'down' }), 'K2', false), 'here')
})

test('cpuSortAction: a set change sorts here (no blank frame), also with a request in flight', () => {
  assert.equal(cpuSortAction(up({ sortedKey: '', setChanged: true }), 'K1', false), 'here')
  assert.equal(cpuSortAction(up({ sortedKey: '', setChanged: true, pending: pend() }), 'K1', false), 'here')
  assert.equal(cpuSortAction({ ...cpuSortStart(), setChanged: true }, 'K1', false), 'here')
})

test('cpuSortAction: settling sorts here even with a request in flight (a capture never waits on the worker)', () => {
  assert.equal(cpuSortAction(up({ pending: pend() }), 'K2', true), 'here')
  assert.equal(cpuSortAction(up(), 'K2', true), 'here')
})

test('cpuSortAction: a camera move posts, or waits behind the request in flight', () => {
  assert.equal(cpuSortAction(up(), 'K2', false), 'post')
  assert.equal(cpuSortAction(cpuSortStart(), 'K2', false), 'post') // worker 'none': the first post makes it
  assert.equal(cpuSortAction(up({ pending: pend() }), 'K2', false), 'wait')
})

test('cpuReplyVerdict: a reply that is not the request in flight is ignored', () => {
  assert.equal(cpuReplyVerdict(up(), { id: 1, version: 3 }, 3, 'K1'), 'ignore')
  assert.equal(cpuReplyVerdict(up({ pending: pend({ id: 2 }) }), { id: 1, version: 3 }, 3, 'K1'), 'ignore')
})

test('cpuReplyVerdict: a stale-version reply is dropped, and the next action for a fresh key moves on', () => {
  const s = up({ pending: pend({ version: 3 }) })
  assert.equal(cpuReplyVerdict(s, { id: 1, version: 3 }, 4, 'K2'), 'drop')
  const after = { ...s, pending: null } // the layer clears pending on drop
  assert.ok(['post', 'here'].includes(cpuSortAction(after, 'K2', false)))
  assert.equal(cpuSortAction({ ...after, setChanged: true }, 'K2', false), 'here')
})

test('cpuReplyVerdict: a reply for K1 after a main-thread sort of K2 and a move to K3 is dropped (superseded)', () => {
  // posted K1; a settle sorted K2 here (marks the request superseded); the camera moved to K3
  const s = up({ sortedKey: 'K2', pending: pend({ key: 'K1', superseded: true }) })
  assert.equal(cpuReplyVerdict(s, { id: 1, version: 3 }, 3, 'K3'), 'drop')
  assert.equal(cpuSortAction({ ...s, pending: null }, 'K3', false), 'post')
})

test('cpuReplyVerdict: a reply after a settle sort is dropped', () => {
  // posted K1, the camera moved to K2, a capture settled K2 here: the K1 answer must not overwrite it
  const s = up({ sortedKey: 'K2', pending: pend({ key: 'K1', superseded: true }) })
  assert.equal(cpuReplyVerdict(s, { id: 1, version: 3 }, 3, 'K2'), 'drop')
})

test('cpuReplyVerdict: an answer that is no longer needed is dropped; a current one is applied', () => {
  assert.equal(cpuReplyVerdict(up({ sortedKey: 'K1', pending: pend() }), { id: 1, version: 3 }, 3, 'K1'), 'drop')
  assert.equal(cpuReplyVerdict(up({ pending: pend() }), { id: 1, version: 3 }, 3, 'K1'), 'apply')
  // the camera moved on meanwhile: still applied (newer than what is drawn), then the layer decides again
  assert.equal(cpuReplyVerdict(up({ pending: pend() }), { id: 1, version: 3 }, 3, 'K2'), 'apply')
})

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
const M = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0.5, 0, -2, 1]

test('sortKey: near is part of the key', () => {
  assert.notEqual(sortKey(1, I, 0.05, [M]), sortKey(1, I, 0.1, [M]))
})

test('sortKey: identical inputs give identical keys', () => {
  assert.equal(sortKey(1, I, 0.05, [M]), sortKey(1, [...I], 0.05, [[...M]]))
})

test('sortKey: the version, the view and the items are part of the key', () => {
  assert.notEqual(sortKey(1, I, 0.05, [M]), sortKey(2, I, 0.05, [M]))
  assert.notEqual(sortKey(1, I, 0.05, [M]), sortKey(1, M, 0.05, [M]))
  assert.notEqual(sortKey(1, I, 0.05, [M]), sortKey(1, I, 0.05, [I]))
  assert.notEqual(sortKey(1, I, 0.05, [M]), sortKey(1, I, 0.05, [M, M]))
})
