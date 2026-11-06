// Rooms (contract §4.9): names, titles, the checks of POST /api/rooms, PUT /api/rooms/<room> and POST …/align, the
// sentences the routes answer with, the align job's messages and a room's align_status. Pure (TScert); the shell
// parses the JSON first.
import { pyRepr, pyStrip } from '../../../../common/logic/pyfmt.ts'
import { isSlug } from '../../../../common/logic/slug.ts'
import { utcStamp } from '../../../../common/logic/time.ts'
import { codePointLength, isNum, isRecord } from '../../scenes/logic/values.ts'
import { MAX_MEMBERS, type AnswerMember, type Member, type MemberPut, type PoseSource } from './members.ts'
import { clampPose, clampScale, type Pose } from './pose.ts'

/** A new room's base name: `room-YYYYMMDD-HHMMSS` (UTC of the POST). */
export function roomBase(epochMs: number): string {
  return 'room-' + utcStamp(epochMs)
}

/** The longest title (code points, after trimming). */
const MAX_TITLE = 200

export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

function refuse<T>(error: string): Checked<T> {
  return { ok: false, error }
}

/** A room title as stored: trimmed, null when blank or null; refused when it isn't text or is over 200 characters. */
export function checkTitle(v: unknown): Checked<string | null> {
  if (v !== null && typeof v !== 'string') return refuse('title must be text or null')
  const t = pyStrip(typeof v === 'string' ? v : '')
  if (codePointLength(t) > MAX_TITLE) return refuse('the title can be at most ' + String(MAX_TITLE) + ' characters')
  return { ok: true, value: t === '' ? null : t }
}

/** A list of scene names: 1–32 slugs, none twice (`what` names the key in the sentences). */
function sceneList(v: unknown, what: string, min: number): Checked<string[]> {
  if (!Array.isArray(v)) return refuse(what + ' must be a list of scene names')
  if (v.length < min || v.length > MAX_MEMBERS) return refuse(what + ' must name ' + String(min) + ' to ' + String(MAX_MEMBERS) + ' scenes')
  const out: string[] = []
  for (const s of v) {
    if (typeof s !== 'string' || !isSlug(s)) return refuse(what + ': ' + (typeof s === 'string' ? pyRepr(s) : 'every entry') + " isn't a scene name (a slug: a-z, 0-9, -)")
    if (out.includes(s)) return refuse(what + ' names ' + pyRepr(s) + ' twice')
    out.push(s)
  }
  return { ok: true, value: out }
}

/** The keys of `entries` that aren't in `allowed`. */
function unknownKeys(entries: readonly (readonly [string, unknown])[], allowed: readonly string[]): string[] {
  return entries.map(([k]) => k).filter((k) => !allowed.includes(k))
}

/** POST /api/rooms, checked: `{title?, scenes}`. */
export interface RoomCreate {
  readonly title: string | null
  readonly scenes: readonly string[]
}

/** POST /api/rooms's body (400 refusals; whether the scenes exist and are free is the shell's question). `entries` is
 *  the body's entries when it is an object, else null. */
export function checkRoomCreate(entries: readonly (readonly [string, unknown])[] | null): Checked<RoomCreate> {
  if (entries === null) return refuse('the body must be a JSON object {"title"?, "scenes": [scene names]}')
  const extra = unknownKeys(entries, ['title', 'scenes'])
  if (extra.length > 0) return refuse('unknown key ' + pyRepr(extra[0] ?? '') + ': a new room takes title and scenes')
  const titleEntry = entries.find(([k]) => k === 'title')
  const title = titleEntry === undefined ? { ok: true as const, value: null } : checkTitle(titleEntry[1])
  if (!title.ok) return refuse(title.error)
  const scenesEntry = entries.find(([k]) => k === 'scenes')
  if (scenesEntry === undefined) return refuse('scenes is required: the room\'s photos (scene names), in order')
  const scenes = sceneList(scenesEntry[1], 'scenes', 1)
  if (!scenes.ok) return refuse(scenes.error)
  return { ok: true, value: { title: title.value, scenes: scenes.value } }
}

/** A pose as a client sends it (room-put.schema.json $defs/posePut), clamped; refused when it isn't one. */
function poseOf(v: unknown, scene: string): Checked<Pose> {
  const bad = 'members: the pose of ' + pyRepr(scene) + ' must be {"x_m", "z_m", "yaw_deg"} (numbers) or null'
  if (!isRecord(v)) return refuse(bad)
  const entries = Object.entries(v)
  if (unknownKeys(entries, ['x_m', 'z_m', 'yaw_deg']).length > 0) return refuse(bad)
  const x = v['x_m']
  const z = v['z_m']
  const yaw = v['yaw_deg']
  if (!isNum(x) || !isNum(z) || !isNum(yaw)) return refuse(bad)
  return { ok: true, value: clampPose(x, z, yaw) }
}

/** One entry of PUT's `members`. */
function memberPutOf(v: unknown): Checked<MemberPut> {
  if (!isRecord(v)) return refuse('members must be a list of {"scene", "pose"?, "scale"?}')
  const sceneValue = v['scene']
  if (typeof sceneValue !== 'string' || !isSlug(sceneValue)) return refuse('members: every entry needs a scene (a scene name)')
  const extra = unknownKeys(Object.entries(v), ['scene', 'pose', 'scale'])
  if (extra.length > 0) return refuse('members: unknown key ' + pyRepr(extra[0] ?? '') + ' (an entry takes scene, pose and scale)')
  const scaleValue = v['scale']
  if (scaleValue !== undefined && (!isNum(scaleValue) || scaleValue <= 0)) return refuse('members: the scale of ' + pyRepr(sceneValue) + ' must be a number above 0')
  const scale = scaleValue ?? null
  const poseValue = v['pose']
  if (poseValue === undefined) return { ok: true, value: { scene: sceneValue, poseGiven: false, pose: null, scale } }
  if (poseValue === null) return { ok: true, value: { scene: sceneValue, poseGiven: true, pose: null, scale } }
  const pose = poseOf(poseValue, sceneValue)
  if (!pose.ok) return refuse(pose.error)
  return { ok: true, value: { scene: sceneValue, poseGiven: true, pose: pose.value, scale } }
}

/** PUT /api/rooms/<room>, checked: each key absent (null) or its value. */
export interface RoomPut {
  readonly title: { readonly value: string | null } | null
  readonly members: readonly MemberPut[] | null
  readonly reset: readonly string[] | null
  readonly rescale: number | null
}

/** PUT /api/rooms/<room>'s body (400 refusals): at least one of title, members, reset and rescale, nothing else. */
export function checkRoomPut(entries: readonly (readonly [string, unknown])[] | null): Checked<RoomPut> {
  if (entries === null || entries.length === 0) return refuse('the body must be a JSON object with any of title, members, reset, rescale')
  const extra = unknownKeys(entries, ['title', 'members', 'reset', 'rescale'])
  if (extra.length > 0) return refuse('unknown key ' + pyRepr(extra[0] ?? '') + ': a room takes title, members, reset and rescale')
  const get = (k: string): { readonly v: unknown } | null => {
    const e = entries.find(([key]) => key === k)
    return e === undefined ? null : { v: e[1] }
  }
  const t = get('title')
  let title: { readonly value: string | null } | null = null
  if (t !== null) {
    const c = checkTitle(t.v)
    if (!c.ok) return refuse(c.error)
    title = { value: c.value }
  }
  const m = get('members')
  let members: MemberPut[] | null = null
  const mv = m === null ? null : m.v
  if (mv !== null) {
    if (!Array.isArray(mv)) return refuse('members must be a list of {"scene", "pose"?, "scale"?}')
    if (mv.length > MAX_MEMBERS) return refuse('a room can have at most ' + String(MAX_MEMBERS) + ' photos')
    const list: MemberPut[] = []
    for (const e of mv) {
      const c = memberPutOf(e)
      if (!c.ok) return refuse(c.error)
      if (list.some((x) => x.scene === c.value.scene)) return refuse('members names ' + pyRepr(c.value.scene) + ' twice')
      list.push(c.value)
    }
    members = list
  }
  const r = get('reset')
  let reset: string[] | null = null
  if (r !== null) {
    const c = sceneList(r.v, 'reset', 1)
    if (!c.ok) return refuse(c.error)
    reset = c.value
  }
  const k = get('rescale')
  let rescale: number | null = null
  if (k !== null) {
    const kv = k.v
    if (!isNum(kv) || kv <= 0) return refuse('rescale must be a number above 0 (the true length over the measured one)')
    rescale = kv
  }
  return { ok: true, value: { title, members, reset, rescale } }
}

/** POST /api/rooms/<room>/align, checked: `--solver` (null: the tool's default) and `overwrite_manual`. */
export interface AlignRequest {
  readonly solver: string | null
  readonly overwriteManual: boolean
}

/** POST …/align's body: none (`entries` null and `empty` true), or `{solver?, overwrite_manual?}`. */
export function checkAlignRequest(entries: readonly (readonly [string, unknown])[] | null, empty: boolean): Checked<AlignRequest> {
  if (empty) return { ok: true, value: { solver: null, overwriteManual: false } }
  if (entries === null) return refuse('the body must be empty or a JSON object {"solver"?, "overwrite_manual"?}')
  const extra = unknownKeys(entries, ['solver', 'overwrite_manual'])
  if (extra.length > 0) return refuse('unknown key ' + pyRepr(extra[0] ?? '') + ': an alignment takes solver and overwrite_manual')
  const s = entries.find(([key]) => key === 'solver')
  const o = entries.find(([key]) => key === 'overwrite_manual')
  const solver: unknown = s === undefined ? null : s[1]
  const overwrite: unknown = o === undefined ? false : o[1]
  if (solver !== null && (typeof solver !== 'string' || !isSlug(solver))) return refuse('solver must be a solver\'s name (a slug, e.g. auto or manhattan)')
  if (typeof overwrite !== 'boolean') return refuse('overwrite_manual must be true or false')
  return { ok: true, value: { solver: typeof solver === 'string' ? solver : null, overwriteManual: overwrite } }
}

// --- sentences --------------------------------------------------------------------------------------------------------

/** 404 for a name that isn't a room. */
export function noRoom(name: string): string {
  if (!isSlug(name)) return 'no room named ' + pyRepr(name) + ' (room names are slugs: a-z, 0-9, -)'
  return 'no room named ' + pyRepr(name) + ': GET /api/rooms lists them'
}

/** 404 for an unknown align job. */
export function noAlignJob(id: string): string {
  return 'no align job ' + pyRepr(id) + ': GET /api/rooms/jobs lists them'
}

/** 409: the scene is a member of another room (a scene is in at most one). */
export function inAnotherRoom(scene: string, room: string): string {
  return 'scene ' + pyRepr(scene) + ' is already in room ' + pyRepr(room) + ': remove it there first'
}

/** 400: `reset` names a scene that isn't a member. */
export function notAMember(scene: string, room: string): string {
  return 'scene ' + pyRepr(scene) + " isn't a photo of room " + pyRepr(room)
}

/** 404 for POST …/restore when the trash holds no copy. */
export function roomNotInTrash(name: string): string {
  return pyRepr(name) + " isn't in the rooms' trash"
}

/** 409 for POST …/restore when the name is taken again. */
export function roomExistsAgain(name: string): string {
  return 'a room ' + pyRepr(name) + ' (or its layouts) exists again: delete it first'
}

/** 409 for an align while one is queued or running for the room. */
export const ALIGN_BUSY = 'this room is already being aligned: wait for it to finish'
/** 409 for an align with fewer than two members that have a photo. */
export const ALIGN_NEEDS_PHOTOS = 'aligning needs at least two photos in the room'
/** 409 for `reset` before any align.json. */
export const RESET_WITHOUT_ALIGN = "this room hasn't been aligned yet: there is no answer to go back to"
/** 400 for render's `room` without `scene`. */
export const RENDER_ROOM_NEEDS_SCENE = 'a render in a room needs scene: the photo it was made in'

/** 400 for render's `room` with a scene that isn't one of its photos. */
export function renderSceneNotMember(scene: string, room: string): string {
  return 'scene ' + pyRepr(scene) + " isn't a photo of room " + pyRepr(room) + ': render in one of its photos'
}

// --- the align job ----------------------------------------------------------------------------------------------------

/** A queued align job's message. */
export const ALIGN_QUEUED = 'waiting for the calibration queue'
/** A running align job's message. */
export const ALIGN_RUNNING = 'aligning the photos'
/** The message of an align job whose room was deleted while it was queued or running. */
export const ROOM_DELETED = 'the room was deleted'
/** An align job that found fewer than two photos when its turn came. */
export const ALIGN_TOO_FEW = 'fewer than two photos of the room are left to align'
/** An align job that ended without a result line (exit 0). */
export const ALIGN_NO_RESULT = 'midstudy-calib finished without its JSON result line'

/** A queued align job's message while members still calibrate. */
export function waitingMessage(scenes: readonly string[]): string {
  if (scenes.length === 0) return ALIGN_QUEUED
  return 'waiting for ' + String(scenes.length) + (scenes.length === 1 ? ' photo' : ' photos') + ' to calibrate'
}

/** A finished align job's message: the solver, and how many photos it placed. */
export function alignedMessage(solver: string, placed: number, total: number): string {
  return 'aligned (' + solver + '): ' + String(placed) + ' of ' + String(total) + ' photos placed'
}

/** An align job that ran past its timeout. */
export function alignTimedOut(timeoutSeconds: number): string {
  return 'aligning the photos ran for more than ' + String(Math.floor(timeoutSeconds / 60)) + ' minutes and was stopped'
}

/** room-object.schema.json $defs/alignStatus. */
export type AlignStatus = 'none' | 'pending' | 'running' | 'done' | 'failed'

/** A room's align_status and align_error (contract §4.9 Room object): from its newest align job since the server
 *  started (null: none) and whether align.json exists. */
export function alignStatus(job: { readonly status: 'queued' | 'running' | 'done' | 'failed'; readonly message: string } | null, hasAlign: boolean): { readonly status: AlignStatus; readonly error: string | null } {
  if (job !== null) {
    if (job.status === 'queued') return { status: 'pending', error: null }
    if (job.status === 'running') return { status: 'running', error: null }
    if (job.status === 'failed') return { status: 'failed', error: job.message }
  }
  return { status: hasAlign ? 'done' : 'none', error: null }
}

/** What applying an align answer needs from it (align.json or align-room's result line): its solver and members. */
export interface Answer {
  readonly solver: string
  readonly members: readonly AnswerMember[]
}

/** A pose read from an answer as it is (the schema's ranges; strict mode checked them), or null. */
function answerPose(v: unknown): Pose | null {
  if (!isRecord(v)) return null
  const x = v['x_m']
  const z = v['z_m']
  const yaw = v['yaw_deg']
  return isNum(x) && isNum(z) && isNum(yaw) ? clampPose(x, z, yaw) : null
}

/** An align answer (align.schema.json), or null when it isn't one: a `solver` text and `members` with a scene, a
 *  photo_sha256 and a pose and scale (both null when unplaced) each. */
export function readAnswer(v: unknown): Answer | null {
  if (!isRecord(v)) return null
  const solver = v['solver']
  const list = v['members']
  if (typeof solver !== 'string' || !Array.isArray(list) || list.length === 0) return null
  const members: AnswerMember[] = []
  for (const m of list) {
    if (!isRecord(m)) return null
    const scene = m['scene']
    const sha = m['photo_sha256']
    const scale = m['scale']
    if (typeof scene !== 'string' || typeof sha !== 'string') return null
    const pose = answerPose(m['pose'])
    const placed = pose !== null && isNum(scale)
    members.push({ scene, photo_sha256: sha, pose: placed ? pose : null, scale: placed ? scale : null })
  }
  return { solver, members }
}

/** room.json (room.schema.json) as the server keeps it. */
export interface RoomData {
  readonly version: 1
  readonly name: string
  readonly title: string | null
  readonly created: string
  readonly saved: string | null
  readonly members: readonly Member[]
  readonly aligned: { readonly solver: string; readonly finished: string } | null
}

/** One stored member read back tolerantly: null when it has no scene name; a pose that isn't one is null; a scale
 *  that isn't a number is 1; `pose_source` follows the pose when the two disagree (null ⇔ unplaced). */
export function readMember(v: unknown): Member | null {
  if (!isRecord(v)) return null
  const scene = v['scene']
  if (typeof scene !== 'string' || !isSlug(scene)) return null
  const pose = answerPose(v['pose'])
  const scaleValue = v['scale']
  const scale = isNum(scaleValue) ? clampScale(scaleValue) : 1
  const source = v['pose_source']
  if (pose === null) return { scene, pose: null, scale, pose_source: 'unplaced' }
  const placedSource: PoseSource = source === 'origin' || source === 'solver' ? source : 'manual'
  return { scene, pose, scale, pose_source: placedSource }
}

/** room.json read back (null when it isn't an object with a list of members); `name` is its folder's. A member listed
 *  twice keeps its first entry; at most 32 are kept. */
export function readRoom(v: unknown, name: string): RoomData | null {
  if (!isRecord(v)) return null
  const list = v['members']
  if (!Array.isArray(list)) return null
  const members: Member[] = []
  for (const x of list) {
    const m = readMember(x)
    if (m !== null && members.length < MAX_MEMBERS && !members.some((y) => y.scene === m.scene)) members.push(m)
  }
  const title = v['title']
  const created = v['created']
  const saved = v['saved']
  const aligned = v['aligned']
  const solver = isRecord(aligned) ? aligned['solver'] : undefined
  const finished = isRecord(aligned) ? aligned['finished'] : undefined
  return {
    version: 1,
    name,
    title: typeof title === 'string' && pyStrip(title) !== '' ? title : null,
    created: typeof created === 'string' ? created : '',
    saved: typeof saved === 'string' ? saved : null,
    members,
    aligned: typeof solver === 'string' && typeof finished === 'string' ? { solver, finished } : null,
  }
}
