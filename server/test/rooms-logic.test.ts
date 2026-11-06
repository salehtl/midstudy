// The rooms' pure rules (server/src/rooms/logic/, contract §4.9): clamps, the pose composition, PUT's members,
// membership on delete and restore, the anchor, applying an answer (manual, origin, stale photos, overwrite_manual,
// reset), the request checks and align_status.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  alignOrder, anchorIndex, answerFrame, applyAnswer, firstMembers, putMembers, reinsertMember, removeMember, rescaleMembers, sameMembers, waitingFor,
  type AnswerMember, type Member,
} from '../src/rooms/logic/members.ts'
import { clampPose, clampScale, composePose, effectiveCamera, wrapYaw } from '../src/rooms/logic/pose.ts'
import { alignStatus, checkAlignRequest, checkRoomCreate, checkRoomPut, readAnswer, readRoom, roomBase, waitingMessage } from '../src/rooms/logic/room.ts'

const turn = (deg: number): { cos: number; sin: number } => ({ cos: Math.cos((deg * Math.PI) / 180), sin: Math.sin((deg * Math.PI) / 180) })
const near = (a: number, b: number, eps = 1e-6): void => {
  assert.ok(Math.abs(a - b) <= eps, String(a) + ' ≠ ' + String(b))
}

void test('clamps: yaw into (−180, 180], positions −50…50, scale 0.25–4, the effective camera', () => {
  assert.equal(wrapYaw(180), 180)
  assert.equal(wrapYaw(-180), 180)
  assert.equal(wrapYaw(190), -170)
  assert.equal(wrapYaw(-190), 170)
  assert.equal(wrapYaw(540), 180)
  assert.equal(wrapYaw(-179.9999999), 180)
  assert.equal(wrapYaw(0), 0)
  assert.deepEqual(clampPose(99, -99, 360), { x_m: 50, z_m: -50, yaw_deg: 0 })
  assert.equal(clampScale(10), 4)
  assert.equal(clampScale(0.01), 0.25)
  assert.equal(clampScale(Number.NaN), 1)
  const cam = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 1 }
  assert.deepEqual(effectiveCamera(cam, 1.5), { fov_y_deg: 55, height_m: 2.1, pitch_deg: -10, roll_deg: 1 })
  assert.equal(effectiveCamera(cam, 4).height_m, 3)
  assert.equal(effectiveCamera({ ...cam, height_m: 0.3 }, 0.25).height_m, 0.2)
  assert.equal(roomBase(Date.UTC(2026, 10, 6, 10, 15, 30)), 'room-20261106-101530')
})

void test('composition: an answer relative to the anchor lands in the room frame (§4.9 Align)', () => {
  // Anchor at (1, 2) turned 90°, scale 2: the answer's (1, 0) is 2 m along the anchor's +X, which Ry(90°) turns to −Z.
  const p = composePose({ x_m: 1, z_m: 2, yaw_deg: 90 }, 2, turn(90), { x_m: 1, z_m: 0, yaw_deg: 10 }, 0.5)
  near(p.pose.x_m, 1)
  near(p.pose.z_m, 0)
  assert.equal(p.pose.yaw_deg, 100)
  assert.equal(p.scale, 1)
  // The identity anchor changes nothing.
  assert.deepEqual(composePose({ x_m: 0, z_m: 0, yaw_deg: 0 }, 1, turn(0), { x_m: -1.15, z_m: 0.45, yaw_deg: -22 }, 1).pose, { x_m: -1.15, z_m: 0.45, yaw_deg: -22 })
  // Round trip: a pose re-expressed relative to an anchor (the mock's rule) and composed back is the same pose.
  const A = { x_m: 1.35, z_m: -4.55, yaw_deg: 152 }
  const K = { x_m: -1.95, z_m: -0.35, yaw_deg: -55 }
  const a = (A.yaw_deg * Math.PI) / 180
  const dx = K.x_m - A.x_m
  const dz = K.z_m - A.z_m
  const rel = { x_m: Math.cos(a) * dx - Math.sin(a) * dz, z_m: Math.sin(a) * dx + Math.cos(a) * dz, yaw_deg: wrapYaw(K.yaw_deg - A.yaw_deg) }
  const back = composePose(A, 1, turn(A.yaw_deg), rel, 1)
  near(back.pose.x_m, K.x_m)
  near(back.pose.z_m, K.z_m)
  assert.equal(back.pose.yaw_deg, K.yaw_deg)
})

const m = (scene: string, source: Member['pose_source'], pose: Member['pose'] = null, scale = 1): Member => ({ scene, pose: source === 'unplaced' ? null : pose ?? { x_m: 0, z_m: 0, yaw_deg: 0 }, scale, pose_source: source })

void test('a new room, PUT members, leaving and rejoining, Set scale', () => {
  assert.deepEqual(firstMembers(['a', 'b']), [m('a', 'origin'), m('b', 'unplaced')])
  const cur = [m('a', 'origin'), m('b', 'solver', { x_m: 1, z_m: 1, yaw_deg: 5 }, 1.1), m('c', 'unplaced')]
  const next = putMembers(cur, [
    { scene: 'c', poseGiven: true, pose: { x_m: 2, z_m: 0, yaw_deg: 0 }, scale: null }, // placed by hand: manual
    { scene: 'a', poseGiven: true, pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: null }, // unchanged pose: stays origin
    { scene: 'b', poseGiven: false, pose: null, scale: 2 }, // scale only: source unchanged
    { scene: 'd', poseGiven: false, pose: null, scale: null }, // joins unplaced
  ])
  assert.deepEqual(next, [
    m('c', 'manual', { x_m: 2, z_m: 0, yaw_deg: 0 }), m('a', 'origin'), m('b', 'solver', { x_m: 1, z_m: 1, yaw_deg: 5 }, 2), m('d', 'unplaced'),
  ])
  assert.deepEqual(putMembers(cur, [{ scene: 'b', poseGiven: true, pose: null, scale: null }]), [m('b', 'unplaced', null, 1.1)])
  assert.deepEqual(putMembers([], [{ scene: 'e', poseGiven: true, pose: { x_m: 1, z_m: 2, yaw_deg: 3 }, scale: 3 }]), [m('e', 'manual', { x_m: 1, z_m: 2, yaw_deg: 3 }, 3)])
  const removed = removeMember(cur, 'b')
  assert.ok(removed !== null)
  assert.equal(removed.index, 1)
  assert.deepEqual(removed.members.map((x) => x.scene), ['a', 'c'])
  assert.equal(removeMember(cur, 'zz'), null)
  assert.deepEqual(reinsertMember(removed.members, removed.index, removed.member).map((x) => x.scene), ['a', 'b', 'c'])
  assert.deepEqual(reinsertMember([m('a', 'origin')], 5, removed.member).map((x) => x.scene), ['a', 'b'])
  assert.deepEqual(reinsertMember(cur, 0, removed.member), cur) // already a member
  const big = rescaleMembers([m('a', 'origin'), m('b', 'manual', { x_m: 1, z_m: -2, yaw_deg: 30 }, 1.5), m('c', 'unplaced')], 2)
  assert.deepEqual(big, [m('a', 'origin', { x_m: 0, z_m: 0, yaw_deg: 0 }, 2), m('b', 'manual', { x_m: 2, z_m: -4, yaw_deg: 30 }, 3), m('c', 'unplaced', null, 2)])
  assert.ok(sameMembers(cur, [...cur]))
  assert.ok(!sameMembers(cur, next))
  assert.deepEqual(waitingFor(cur, [false, true, true]), ['b', 'c'])
  assert.equal(waitingMessage(['b']), 'waiting for 1 photo to calibrate')
})

void test('the anchor and the order align-room gets', () => {
  const ms = [m('a', 'unplaced'), m('b', 'solver'), m('c', 'manual'), m('d', 'origin')]
  assert.equal(anchorIndex(ms, [true, true, true, true], false), 2) // the first origin or manual
  assert.equal(anchorIndex(ms, [true, true, true, true], true), 1) // overwrite_manual: any placed member
  assert.equal(anchorIndex(ms, [true, true, false, false], false), 1) // else the first placed
  assert.equal(anchorIndex(ms, [true, false, false, false], false), 0) // else the first
  assert.equal(anchorIndex(ms, [false, false, false, false], false), -1)
  assert.deepEqual(alignOrder(ms, [true, false, true, true], 2), ['c', 'a', 'd'])
})

void test('applying an answer: origin and manual kept, stale photos ignored, overwrite_manual, reset', () => {
  const ms = [m('a', 'origin'), m('b', 'manual', { x_m: 9, z_m: 9, yaw_deg: 9 }), m('c', 'unplaced'), m('d', 'solver'), m('e', 'solver'), m('f', 'solver')]
  const shas = ['sa', 'sb', 'sc', 'sd', 'NEW', null]
  const pose = { x_m: 1, z_m: 0, yaw_deg: 90 }
  const answer: AnswerMember[] = [
    { scene: 'a', photo_sha256: 'sa', pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1 },
    { scene: 'b', photo_sha256: 'sb', pose, scale: 1 },
    { scene: 'c', photo_sha256: 'sc', pose, scale: 2 },
    { scene: 'd', photo_sha256: 'sd', pose: null, scale: null },
    { scene: 'e', photo_sha256: 'se', pose, scale: 1 }, // its photo was replaced since
  ]
  const frame = answerFrame(ms, answer)
  assert.deepEqual(frame, { pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1 })
  const out = applyAnswer(ms, shas, answer, frame, turn(0), { kind: 'align', overwriteManual: false })
  assert.deepEqual(out, [ms[0], ms[1], m('c', 'solver', pose, 2), m('d', 'unplaced'), ms[4], ms[5]])
  const over = applyAnswer(ms, shas, answer, frame, turn(0), { kind: 'align', overwriteManual: true })
  assert.deepEqual(over[1], m('b', 'solver', pose))
  assert.deepEqual(over[0], ms[0])
  const reset = applyAnswer(ms, shas, answer, frame, turn(0), { kind: 'reset', scenes: ['a', 'b', 'e', 'f'] })
  assert.deepEqual(reset, [ms[0], m('b', 'solver', pose), ms[2], ms[3], m('e', 'unplaced'), m('f', 'unplaced')])
  // An anchor that moved since: the answer follows it.
  const moved = [m('a', 'manual', { x_m: 1, z_m: 2, yaw_deg: 90 }, 2), m('c', 'unplaced')]
  const f2 = answerFrame(moved, answer)
  assert.ok(f2 !== null)
  const out2 = applyAnswer(moved, ['sa', 'sc'], answer, f2, turn(90), { kind: 'align', overwriteManual: false })
  const placed = out2[1]
  assert.ok(placed?.pose)
  near(placed.pose.x_m, 1)
  near(placed.pose.z_m, 0)
  assert.equal(placed.pose.yaw_deg, 180)
  assert.equal(placed.scale, 4)
  assert.deepEqual(answerFrame([m('x', 'origin')], answer), { pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1 })
  assert.equal(answerFrame(ms, []), null)
})

void test('request checks', () => {
  const e = (o: Record<string, unknown>): [string, unknown][] => Object.entries(o)
  assert.deepEqual(checkRoomCreate(e({ title: '  Lounge ', scenes: ['a', 'b'] })), { ok: true, value: { title: 'Lounge', scenes: ['a', 'b'] } })
  assert.deepEqual(checkRoomCreate(e({ title: '   ', scenes: ['a'] })), { ok: true, value: { title: null, scenes: ['a'] } })
  for (const bad of [{}, { scenes: [] }, { scenes: ['a', 'a'] }, { scenes: ['A'] }, { scenes: 'a' }, { scenes: ['a'], extra: 1 }, { scenes: ['a'], title: 5 }, { scenes: ['a'], title: 'x'.repeat(201) },
    { scenes: Array.from({ length: 33 }, (_, i) => 's' + String(i)) }]) {
    assert.equal(checkRoomCreate(e(bad)).ok, false, JSON.stringify(bad))
  }
  assert.equal(checkRoomCreate(null).ok, false)
  const put = checkRoomPut(e({ members: [{ scene: 'a', pose: { x_m: 99, z_m: 0, yaw_deg: 190 }, scale: 3 }, { scene: 'b', pose: null }, { scene: 'c' }], rescale: 1.5, reset: ['a'], title: null }))
  assert.deepEqual(put, {
    ok: true,
    value: {
      title: { value: null }, rescale: 1.5, reset: ['a'],
      members: [
        { scene: 'a', poseGiven: true, pose: { x_m: 50, z_m: 0, yaw_deg: -170 }, scale: 3 },
        { scene: 'b', poseGiven: true, pose: null, scale: null },
        { scene: 'c', poseGiven: false, pose: null, scale: null },
      ],
    },
  })
  for (const bad of [{}, { foo: 1 }, { rescale: 0 }, { rescale: -1 }, { rescale: 'x' }, { reset: [] }, { reset: ['a', 'a'] }, { members: 'x' }, { members: [{ scene: 'a' }, { scene: 'a' }] },
    { members: [{ scene: 'a', pose: { x_m: 1, z_m: 1 } }] }, { members: [{ scene: 'a', pose: { x_m: 1, z_m: 1, yaw_deg: 1, w: 1 } }] }, { members: [{ scene: 'a', scale: 0 }] },
    { members: [{ scene: 'a', other: 1 }] }, { members: [{}] }]) {
    assert.equal(checkRoomPut(e(bad)).ok, false, JSON.stringify(bad))
  }
  assert.deepEqual(checkAlignRequest(null, true), { ok: true, value: { solver: null, overwriteManual: false } })
  assert.deepEqual(checkAlignRequest(e({ solver: 'manhattan', overwrite_manual: true }), false), { ok: true, value: { solver: 'manhattan', overwriteManual: true } })
  assert.deepEqual(checkAlignRequest(e({}), false), { ok: true, value: { solver: null, overwriteManual: false } })
  for (const bad of [{ solver: 'Bad Name' }, { overwrite_manual: 1 }, { other: true }]) assert.equal(checkAlignRequest(e(bad), false).ok, false)
  assert.equal(checkAlignRequest(null, false).ok, false)
})

void test('reading room.json and answers back; align_status', () => {
  const r = readRoom({ title: ' ', created: 'c', saved: null, aligned: { solver: 'truth', finished: 'f' }, members: [
    { scene: 'a', pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1, pose_source: 'origin' },
    { scene: 'a', pose: null, scale: 1, pose_source: 'unplaced' },
    { scene: 'b', pose: null, scale: 9, pose_source: 'manual' },
    { scene: 'c', pose: { x_m: 1, z_m: 1, yaw_deg: 1 }, scale: 'x', pose_source: 'unplaced' },
    { scene: 'BAD' },
  ] }, 'room-x')
  assert.deepEqual(r, {
    version: 1, name: 'room-x', title: null, created: 'c', saved: null, aligned: { solver: 'truth', finished: 'f' },
    members: [m('a', 'origin'), m('b', 'unplaced', null, 4), m('c', 'manual', { x_m: 1, z_m: 1, yaw_deg: 1 })],
  })
  assert.equal(readRoom([], 'x'), null)
  assert.deepEqual(readAnswer({ solver: 'truth', members: [{ scene: 'a', photo_sha256: 'h', pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1 }, { scene: 'b', photo_sha256: 'g', pose: null, scale: null }] }), {
    solver: 'truth', members: [{ scene: 'a', photo_sha256: 'h', pose: { x_m: 0, z_m: 0, yaw_deg: 0 }, scale: 1 }, { scene: 'b', photo_sha256: 'g', pose: null, scale: null }],
  })
  assert.equal(readAnswer({ solver: 'x', members: [] }), null)
  assert.equal(readAnswer(null), null)
  assert.deepEqual(alignStatus(null, false), { status: 'none', error: null })
  assert.deepEqual(alignStatus(null, true), { status: 'done', error: null })
  assert.deepEqual(alignStatus({ status: 'queued', message: '' }, true), { status: 'pending', error: null })
  assert.deepEqual(alignStatus({ status: 'running', message: '' }, true), { status: 'running', error: null })
  assert.deepEqual(alignStatus({ status: 'failed', message: 'boom' }, true), { status: 'failed', error: 'boom' })
  assert.deepEqual(alignStatus({ status: 'done', message: '' }, true), { status: 'done', error: null })
})
