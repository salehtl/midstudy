// A room's members (contract §4.9 Membership, Changes, Align): a new room's list, PUT's whole new list, a scene that
// leaves (deleted) and comes back (restored), Set scale, the align job's anchor and order, and an align answer applied
// (also by Reset). Pure (TScert); server/src/rooms/service.ts reads and writes room.json around them.
import { ORIGIN_POSE, clampScale, composePose, rescaled, samePose, type Placed, type Pose, type Turn } from './pose.ts'

/** room.schema.json $defs/poseSource. */
export type PoseSource = 'origin' | 'solver' | 'manual' | 'unplaced'

/** One member as room.json stores it (room.schema.json $defs/member): `pose` is null exactly when `pose_source` is
 *  `unplaced`. */
export interface Member {
  readonly scene: string
  readonly pose: Pose | null
  readonly scale: number
  readonly pose_source: PoseSource
}

/** At most this many members. */
export const MAX_MEMBERS = 32

/** A new room's members (POST /api/rooms): the first is the origin (pose {0, 0, 0}), the others unplaced; scales 1. */
export function firstMembers(scenes: readonly string[]): Member[] {
  return scenes.map((scene, i) => (i === 0 ? { scene, pose: ORIGIN_POSE, scale: 1, pose_source: 'origin' } : { scene, pose: null, scale: 1, pose_source: 'unplaced' }))
}

/** One entry of PUT's `members`, checked and clamped: `pose` absent (`poseGiven` false: keep the stored one), null
 *  (unplaced) or a pose; `scale` absent (null) or a number above 0. */
export interface MemberPut {
  readonly scene: string
  readonly poseGiven: boolean
  readonly pose: Pose | null
  readonly scale: number | null
}

/** PUT's `members` (contract §4.9 Changes): the whole new list, in order. A scene not listed leaves; a new one joins
 *  (unplaced, scale 1, unless it carries a pose: then manual); a pose that differs from the stored one is stored as
 *  manual, null makes it unplaced, an absent pose keeps the stored one; a scale is stored and doesn't change
 *  pose_source. */
export function putMembers(current: readonly Member[], entries: readonly MemberPut[]): Member[] {
  return entries.map((e) => {
    const old = current.find((m) => m.scene === e.scene)
    const scale = e.scale === null ? (old === undefined ? 1 : old.scale) : clampScale(e.scale)
    if (!e.poseGiven) {
      return old === undefined ? { scene: e.scene, pose: null, scale, pose_source: 'unplaced' } : { scene: e.scene, pose: old.pose, scale, pose_source: old.pose_source }
    }
    const pose = e.pose
    if (pose === null) return { scene: e.scene, pose: null, scale, pose_source: 'unplaced' }
    if (old !== undefined && samePose(pose, old.pose)) return { scene: e.scene, pose: old.pose, scale, pose_source: old.pose_source }
    return { scene: e.scene, pose, scale, pose_source: 'manual' }
  })
}

/** A member taken out of the list (a deleted scene): the list without it, its 0-based index and its record. */
export interface Removed {
  readonly members: readonly Member[]
  readonly index: number
  readonly member: Member
}

/** The list without `scene`, or null when it isn't a member. */
export function removeMember(members: readonly Member[], scene: string): Removed | null {
  const index = members.findIndex((m) => m.scene === scene)
  const member = members[index]
  if (index < 0 || member === undefined) return null
  return { members: members.filter((m) => m.scene !== scene), index, member }
}

/** A restored scene back in the list at `min(index, number of members)` with its record (contract §4.9
 *  Membership); the list as it is when the scene is already in it or the room is full. */
export function reinsertMember(members: readonly Member[], index: number, member: Member): Member[] {
  if (members.some((m) => m.scene === member.scene) || members.length >= MAX_MEMBERS) return [...members]
  const at = Math.max(0, Math.min(index, members.length))
  return [...members.slice(0, at), member, ...members.slice(at)]
}

/** Set scale (`rescale: k`): every scale and every pose's x_m and z_m times k, clamped; pose_source unchanged. */
export function rescaleMembers(members: readonly Member[], k: number): Member[] {
  return members.map((m) => {
    const r = rescaled(m.pose, m.scale, k)
    return { scene: m.scene, pose: r.pose, scale: r.scale, pose_source: m.pose_source }
  })
}

/** Whether an align answer can't change this member's pose (the anchor's test): `origin` or `manual`, or any placed
 *  member with `overwrite_manual`. */
function fixed(m: Member, overwriteManual: boolean): boolean {
  return m.pose !== null && (m.pose_source === 'origin' || m.pose_source === 'manual' || overwriteManual)
}

/** The align job's anchor among the members that have a photo (`hasPhoto`, parallel to `members`): the first (in room
 *  order) that has a pose the result can't change, else the first placed one, else the first; -1 when none has a
 *  photo (contract §4.9 Align). */
export function anchorIndex(members: readonly Member[], hasPhoto: readonly boolean[], overwriteManual: boolean): number {
  let placed = -1
  let any = -1
  for (let i = 0; i < members.length; i++) {
    const m = members[i]
    if (m === undefined || hasPhoto[i] !== true) continue
    if (fixed(m, overwriteManual)) return i
    if (placed < 0 && m.pose !== null) placed = i
    if (any < 0) any = i
  }
  return placed >= 0 ? placed : any
}

/** The scenes `align-room` gets, in order: the anchor first, then the other members that have a photo, in room order. */
export function alignOrder(members: readonly Member[], hasPhoto: readonly boolean[], anchor: number): string[] {
  const a = members[anchor]
  if (a === undefined) return []
  return [a.scene, ...members.filter((m, i) => i !== anchor && hasPhoto[i] === true).map((m) => m.scene)]
}

/** One member of an align answer (align.schema.json $defs/member), as far as applying it needs. */
export interface AnswerMember {
  readonly scene: string
  readonly photo_sha256: string
  readonly pose: Pose | null
  readonly scale: number | null
}

/** The room pose and scale the answer is relative to: its first member's (the anchor's) as the room has it now,
 *  `{0, 0, 0}` when it has none, scale 1 when it is no longer a member. Null for an empty answer. */
export function answerFrame(members: readonly Member[], answer: readonly AnswerMember[]): Placed | null {
  const first = answer[0]
  if (first === undefined) return null
  const m = members.find((x) => x.scene === first.scene)
  if (m === undefined) return { pose: ORIGIN_POSE, scale: 1 }
  return { pose: m.pose ?? ORIGIN_POSE, scale: m.scale }
}

/** How an answer is applied: as an align job's result, or as PUT's `reset` of some members. */
export type ApplyMode =
  | { readonly kind: 'align'; readonly overwriteManual: boolean }
  | { readonly kind: 'reset'; readonly scenes: readonly string[] }

function unplaced(m: Member): Member {
  return { scene: m.scene, pose: null, scale: m.scale, pose_source: 'unplaced' }
}

/** The answer's pose for `m` in the room frame, or null when the answer doesn't place it (not listed, listed for a
 *  photo since replaced, or unplaced). `sha` is the member's photo.jpg's SHA-256 now (null without one). */
function answerFor(m: Member, sha: string | null, answer: readonly AnswerMember[], frame: Placed, turn: Turn): Member | null {
  const a = answer.find((x) => x.scene === m.scene)
  if (a === undefined || sha === null || a.photo_sha256 !== sha || a.pose === null || a.scale === null) return null
  const p = composePose(frame.pose, frame.scale, turn, a.pose, a.scale)
  return { scene: m.scene, pose: p.pose, scale: p.scale, pose_source: 'solver' }
}

/** Whether the answer speaks about `m` at all: it lists it, for the photo it has now. */
function current(m: Member, sha: string | null, answer: readonly AnswerMember[]): boolean {
  const a = answer.find((x) => x.scene === m.scene)
  return a !== undefined && sha !== null && a.photo_sha256 === sha
}

/** An align answer applied to the room as it is now (contract §4.9 Align, Changes `reset`). `shas` is each member's
 *  photo.jpg SHA-256 now (parallel to `members`, null without a photo); `frame` is `answerFrame`'s and `turn` the cos
 *  and sin of its yaw.
 *  - align: every member the answer places, for the photo it has now, takes the composed pose (`solver`) unless it is
 *    `origin`, or `manual` without `overwrite_manual`; one it lists as unplaced becomes unplaced unless it is
 *    `manual` or `origin`; members the answer doesn't mention (or lists for another photo) keep theirs.
 *  - reset: the listed members take the answer again (`solver`), or become unplaced when it doesn't place them; an
 *    `origin` member is left as it is. */
export function applyAnswer(members: readonly Member[], shas: readonly (string | null)[], answer: readonly AnswerMember[], frame: Placed, turn: Turn, mode: ApplyMode): Member[] {
  const out: Member[] = []
  for (let i = 0; i < members.length; i++) {
    const m = members[i]
    if (m === undefined) continue
    const sha = i < shas.length ? shas[i] ?? null : null
    out.push(mode.kind === 'reset' ? resetOne(m, sha, answer, frame, turn, mode.scenes) : alignOne(m, sha, answer, frame, turn, mode.overwriteManual))
  }
  return out
}

/** `applyAnswer` on one member as Reset. */
function resetOne(m: Member, sha: string | null, answer: readonly AnswerMember[], frame: Placed, turn: Turn, scenes: readonly string[]): Member {
  if (m.pose_source === 'origin' || !scenes.includes(m.scene)) return m
  const placed = answerFor(m, sha, answer, frame, turn)
  return placed ?? unplaced(m)
}

/** `applyAnswer` on one member as an align result. */
function alignOne(m: Member, sha: string | null, answer: readonly AnswerMember[], frame: Placed, turn: Turn, overwriteManual: boolean): Member {
  if (m.pose_source === 'origin' || !current(m, sha, answer)) return m
  if (m.pose_source === 'manual' && !overwriteManual) return m
  const placed = answerFor(m, sha, answer, frame, turn)
  if (placed !== null) return placed
  return m.pose_source === 'manual' ? m : unplaced(m)
}

/** The members a queued align job waits for: those whose calibration is queued or running (`busy`, parallel). */
export function waitingFor(members: readonly Member[], busy: readonly boolean[]): string[] {
  return members.filter((m, i) => busy[i] === true).map((m) => m.scene)
}

/** Two member lists are the same (scenes, order, poses, scales, sources). */
export function sameMembers(a: readonly Member[], b: readonly Member[]): boolean {
  if (a.length !== b.length) return false
  return a.every((m, i) => {
    const n = b[i]
    return m.scene === n?.scene && samePose(m.pose, n.pose) && m.scale === n.scale && m.pose_source === n.pose_source
  })
}
