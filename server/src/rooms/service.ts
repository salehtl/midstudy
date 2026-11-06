// Rooms on disk and their align jobs (contract §4.9): rooms/<room>/room.json (written by the server only, atomically,
// checked against room.schema.json in strict mode), rooms/<room>/align.json (written by midstudy-calib align-room,
// never by the server), rooms/.trash/<room>-<stamp>/ (the deleted room with its layouts and trash.json) and
// layouts/@<room>/ (room layouts: server/src/routes/layouts.ts). Align jobs run on the scenes' calibration queue
// (SceneService.queueTask): one at a time with the calibrations, the warm worker when it answers. A queued align job
// lets the calibrations of its members pass it, and runs once none is queued or running. Every change to a room folder
// happens synchronously in one turn of the event loop, so it is atomic for this server (as the scenes').
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { isSlug } from '../../../common/logic/slug.ts'
import { isoUtc } from '../../../common/logic/time.ts'
import { toolError } from '../../../common/tools.ts'
import { exists, isDir, isFile, move, removeTree, resolvePath } from '../../../common/files.ts'
import { compareNames } from '../../../core/js/node.ts'
import type { Camera, SceneTrashRoom } from '../../../contract/gen/types.ts'
import { JobStore, newJobId } from '../jobs.ts'
import { conforms } from '../strict.ts'
import type { CalibOutcome } from '../scenes/calib.ts'
import { listDir, makeDir, makeDirs, mtimeOf, readJson, writeJsonSync } from '../scenes/files.ts'
import { clampCamera } from '../scenes/logic/camera.ts'
import { notInstalled, serverFailed } from '../scenes/logic/jobs.ts'
import { numbered, trashBase } from '../scenes/logic/names.ts'
import type { SceneObject } from '../scenes/logic/scene.ts'
import { isoFromTimestamp } from '../scenes/logic/time.ts'
import { cmpCodePoints, isRecord, pyStr, pyTruthy } from '../scenes/logic/values.ts'
import type { SceneService } from '../scenes/service.ts'
import {
  alignOrder, anchorIndex, answerFrame, applyAnswer, firstMembers, putMembers, reinsertMember, removeMember, rescaleMembers, sameMembers, waitingFor,
  type ApplyMode, type Member,
} from './logic/members.ts'
import { effectiveCamera, type Turn } from './logic/pose.ts'
import {
  ALIGN_BUSY, ALIGN_NEEDS_PHOTOS, ALIGN_NO_RESULT, ALIGN_QUEUED, ALIGN_RUNNING, ALIGN_TOO_FEW, RESET_WITHOUT_ALIGN, ROOM_DELETED, alignStatus, alignTimedOut,
  alignedMessage, inAnotherRoom, noRoom, notAMember, readAnswer, readMember, readRoom, roomBase, waitingMessage, type AlignRequest, type AlignStatus, type RoomData,
  type RoomPut,
} from './logic/room.ts'
import { noScene } from '../scenes/logic/scene.ts'

/** trash.json beside a deleted room (trash.schema.json $defs/room). */
const TRASH_META = 'trash.json'

/** An align job as the API serves it (api/room-job.schema.json). */
export interface AlignJobView {
  readonly id: string
  readonly kind: 'align'
  readonly room: string
  readonly status: 'queued' | 'running' | 'done' | 'failed'
  readonly created: string
  readonly started: string | null
  readonly finished: string | null
  readonly message: string
  readonly waiting_for: readonly string[]
  readonly align: Readonly<Record<string, unknown>> | null
}

/** A member as the room object lists it. */
interface MemberObject extends Member {
  readonly scene_object: SceneObject
}

/** The room object (api/room-object.schema.json). */
export interface RoomObject {
  readonly name: string
  readonly title: string | null
  readonly created: string
  readonly saved: string | null
  readonly aligned: RoomData['aligned']
  readonly members: readonly MemberObject[]
  readonly layouts: number
  readonly align_status: AlignStatus
  readonly align_error: string | null
}

/** A deleted room as GET /api/rooms lists it, plus its folder's name. */
interface TrashedRoom {
  readonly name: string
  readonly title: string | null
  readonly created: string | null
  readonly deleted: string
  readonly dir: string
}

/** A refusal: the status and its sentence. */
export interface Refusal {
  readonly status: number
  readonly error: string
}

/** cos and sin of a yaw in degrees (the pure logic can't call Math.cos). */
function turnOf(yawDeg: number): Turn {
  const a = (yawDeg * Math.PI) / 180
  return { cos: Math.cos(a), sin: Math.sin(a) }
}

/** The SHA-256 (lowercase hex) of a file, or null when it can't be read. */
function sha256Of(file: string): string | null {
  try {
    return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  } catch {
    return null
  }
}

/** room.json as written: room.schema.json's key order. */
function roomFile(r: RoomData): Readonly<Record<string, unknown>> {
  return { version: 1, name: r.name, title: r.title, created: r.created, saved: r.saved, members: r.members.map(memberFile), aligned: r.aligned }
}

function memberFile(m: Member): Readonly<Record<string, unknown>> {
  return { scene: m.scene, pose: m.pose, scale: m.scale, pose_source: m.pose_source }
}

export interface RoomServiceOptions {
  readonly roomsDir: string
  readonly layoutsDir: string
  readonly scenes: SceneService
  readonly now?: () => number
}

export class RoomService {
  readonly dir: string
  readonly layoutsDir: string
  readonly #scenes: SceneService
  readonly #now: () => number
  readonly #jobs = new JobStore<AlignJobView>()
  /** job id → what it was asked (`--solver`, `overwrite_manual`). */
  readonly #requests = new Map<string, AlignRequest>()
  /** Jobs whose room was deleted while they were queued or running. */
  readonly #dropped = new Set<string>()
  /** room → its newest align job id. */
  readonly #last = new Map<string, string>()

  constructor(options: RoomServiceOptions) {
    this.dir = options.roomsDir
    this.layoutsDir = options.layoutsDir
    this.#scenes = options.scenes
    this.#now = options.now ?? Date.now
    this.#scenes.setRooms({
      index: () => this.index(),
      leave: (scene) => this.leave(scene),
      rejoin: (scene, record) => {
        this.rejoin(scene, record)
      },
    })
  }

  // --- files ---------------------------------------------------------------------------------------------------------

  path(name: string): string {
    return path.join(this.dir, name)
  }

  /** layouts/@<room>/: the room's layouts. */
  layoutsPath(name: string): string {
    return path.join(this.layoutsDir, '@' + name)
  }

  /** A slug with a room.json. */
  exists(name: string): boolean {
    return isSlug(name) && isFile(path.join(this.dir, name, 'room.json'))
  }

  /** room.json, read tolerantly, or null. */
  read(name: string): RoomData | null {
    if (!isSlug(name)) return null
    return readRoom(readJson(path.join(this.dir, name, 'room.json')), name)
  }

  #write(r: RoomData): void {
    writeJsonSync(path.join(this.dir, r.name, 'room.json'), roomFile(r), 'midstudy/room.schema.json')
  }

  /** The folders that are rooms. */
  names(): string[] {
    if (!isDir(this.dir)) return []
    return listDir(this.dir).filter((n) => this.exists(n))
  }

  /** scene → the room it is a member of (the first room, by name, when a hand-edited file lists it twice). */
  index(): Map<string, string> {
    const out = new Map<string, string>()
    for (const n of this.names().sort(cmpCodePoints)) {
      for (const m of this.read(n)?.members ?? []) {
        if (!out.has(m.scene)) out.set(m.scene, n)
      }
    }
    return out
  }

  /** align.json as it is, or null when there is none or it can't be read as an answer (in strict mode: it breaks
   *  align.schema.json; the tool that wrote it is to blame, and the room stays usable). */
  alignJson(name: string): Readonly<Record<string, unknown>> | null {
    const v = readJson(path.join(this.dir, name, 'align.json'))
    return isRecord(v) && readAnswer(v) !== null && conforms('midstudy/align.schema.json', v) ? v : null
  }

  /** How many room layouts (`<slug>.json` in layouts/@<room>/). */
  layoutCount(name: string): number {
    const d = this.layoutsPath(name)
    if (!isDir(d)) return 0
    return listDir(d).filter((f) => f.endsWith('.json') && isSlug(f.slice(0, -'.json'.length)) && isFile(path.join(d, f))).length
  }

  #photo(scene: string): string {
    return path.join(this.#scenes.path(scene), 'photo.jpg')
  }

  // --- answers --------------------------------------------------------------------------------------------------------

  /** The newest align job of the room since the server started, unless the room was deleted under it. */
  #lastJob(name: string): AlignJobView | null {
    const id = this.#last.get(name) ?? ''
    if (this.#dropped.has(id)) return null
    return this.#jobs.get(id)
  }

  #status(name: string): { readonly status: AlignStatus; readonly error: string | null } {
    return alignStatus(this.#lastJob(name), this.alignJson(name) !== null)
  }

  /** The room object (GET /api/rooms entries, restore). Members whose scene is gone (removed by hand) are left out. */
  object(name: string, given?: RoomData | null): RoomObject | null {
    const r = given ?? this.read(name)
    if (r === null) return null
    const index = this.index()
    const members: MemberObject[] = []
    for (const m of r.members) {
      const so = this.#scenes.sceneObject(m.scene, null, index)
      if (so !== null) members.push({ scene: m.scene, pose: m.pose, scale: m.scale, pose_source: m.pose_source, scene_object: so })
    }
    const st = this.#status(name)
    return {
      name: r.name, title: r.title, created: r.created, saved: r.saved, aligned: r.aligned, members, layouts: this.layoutCount(name),
      align_status: st.status, align_error: st.error,
    }
  }

  /** The room detail (GET /api/rooms/<room>, and the answer of POST and PUT). */
  detail(name: string): Readonly<Record<string, unknown>> | null {
    const r = this.read(name)
    if (r === null) return null
    const obj = this.object(name, r)
    if (obj === null) return null
    const members = obj.members.map((m) => {
      const camera: Camera = clampCamera(this.#cameraOf(m.scene))
      return {
        scene: m.scene, pose: m.pose, scale: m.scale, pose_source: m.pose_source, scene_object: m.scene_object, camera,
        effective_camera: effectiveCamera(camera, m.scale),
      }
    })
    return {
      version: 1, name: obj.name, title: obj.title, created: obj.created, saved: obj.saved, aligned: obj.aligned, members, layouts: obj.layouts,
      align: this.alignJson(name), align_status: obj.align_status, align_error: obj.align_error,
    }
  }

  #cameraOf(scene: string): Readonly<Record<string, unknown>> | null {
    const c = this.#scenes.read(scene)?.['camera']
    return isRecord(c) ? c : null
  }

  /** GET /api/rooms: newest first by `created`, ties by the collision suffix as a number (as scenes). */
  all(): RoomObject[] {
    const out: RoomObject[] = []
    for (const n of this.names()) {
      const o = this.object(n)
      if (o !== null) out.push(o)
    }
    return out.sort((a, b) => {
      const byCreated = cmpCodePoints(b.created, a.created)
      return byCreated !== 0 ? byCreated : compareNames(b.name, a.name)
    })
  }

  // --- create and change -----------------------------------------------------------------------------------------------

  /** The first refusal of `scenes` as members of room `self` (null: a new room): 404 a scene that doesn't exist, 409
   *  one in another room. */
  #membersProblem(scenes: readonly string[], self: string | null): Refusal | null {
    const index = this.index()
    for (const s of scenes) {
      if (!this.#scenes.exists(s)) return { status: 404, error: noScene(s) }
    }
    for (const s of scenes) {
      const room = index.get(s)
      if (room !== undefined && room !== self) return { status: 409, error: inAnotherRoom(s, room) }
    }
    return null
  }

  /** POST /api/rooms (checked): a new room of these scenes, in this order. */
  create(title: string | null, scenes: readonly string[]): { readonly name: string } | Refusal {
    const problem = this.#membersProblem(scenes, null)
    if (problem !== null) return problem
    const now = this.#now()
    const base = roomBase(now)
    makeDirs(this.dir)
    let n = 1
    let name = base
    while (exists(path.join(this.dir, name)) || exists(this.layoutsPath(name)) || this.#inTrash(name) || !makeDir(path.join(this.dir, name))) {
      n += 1
      name = numbered(base, n)
    }
    this.#write({ version: 1, name, title, created: isoUtc(now), saved: null, members: firstMembers(scenes), aligned: null })
    return { name }
  }

  /** Whether a deleted room by this name is in the trash (a new room never takes its name: restore would collide). */
  #inTrash(name: string): boolean {
    return this.trash().some((t) => t.name === name)
  }

  /** PUT /api/rooms/<room> (checked): title, members, reset, rescale, in that order. */
  update(name: string, put: RoomPut): { readonly ok: true } | Refusal {
    const r = this.read(name)
    if (r === null) return { status: 404, error: noRoom(name) }
    if (put.members !== null) {
      const problem = this.#membersProblem(put.members.map((m) => m.scene), name)
      if (problem !== null) return problem
    }
    let members: readonly Member[] = put.members === null ? r.members : putMembers(r.members, put.members)
    if (put.reset !== null) {
      for (const s of put.reset) {
        if (!members.some((m) => m.scene === s)) return { status: 400, error: notAMember(s, name) }
      }
      const answer = readAnswer(this.alignJson(name))
      if (answer === null) return { status: 409, error: RESET_WITHOUT_ALIGN }
      members = this.#applied(members, answer.members, { kind: 'reset', scenes: put.reset })
    }
    if (put.rescale !== null) members = rescaleMembers(members, put.rescale)
    const changed = !sameMembers(members, r.members)
    const title = put.title === null ? r.title : put.title.value
    if (!changed && title === r.title) return { ok: true }
    this.#write({ ...r, title, members, saved: changed ? isoUtc(this.#now()) : r.saved })
    return { ok: true }
  }

  /** An answer applied to `members` as the room has them now (their photos' SHA-256 read now). */
  #applied(members: readonly Member[], answer: Parameters<typeof applyAnswer>[2], mode: ApplyMode): Member[] {
    const frame = answerFrame(members, answer)
    if (frame === null) return [...members]
    const shas = members.map((m) => sha256Of(this.#photo(m.scene)))
    return applyAnswer(members, shas, answer, frame, turnOf(frame.pose.yaw_deg), mode)
  }

  // --- membership hooks (scene delete and restore, §4.9 Membership) ----------------------------------------------------

  /** A scene being deleted leaves its room: its record for the scene's trash.json, or null when it was in none. */
  leave(scene: string): SceneTrashRoom | null {
    const room = this.index().get(scene)
    if (room === undefined) return null
    const r = this.read(room)
    if (r === null) return null
    const removed = removeMember(r.members, scene)
    if (removed === null) return null
    this.#write({ ...r, members: removed.members, saved: isoUtc(this.#now()) })
    const m = removed.member
    return { name: room, index: removed.index, member: { scene: m.scene, pose: m.pose, scale: m.scale, pose_source: m.pose_source } }
  }

  /** A restored scene rejoins the room its trash.json names, when that room exists (not in the trash) and the scene is
   *  in no other room; otherwise it stays on its own. */
  rejoin(scene: string, record: unknown): void {
    if (!isRecord(record)) return
    const room = record['name']
    const index = record['index']
    const member = readMember(record['member'])
    if (typeof room !== 'string' || typeof index !== 'number' || !Number.isInteger(index) || member?.scene !== scene) return
    const r = this.read(room)
    if (r === null || this.index().has(scene)) return
    const members = reinsertMember(r.members, index, member)
    if (sameMembers(members, r.members)) return
    this.#write({ ...r, members, saved: isoUtc(this.#now()) })
  }

  // --- delete and restore ----------------------------------------------------------------------------------------------

  /** DELETE /api/rooms/<room>: the folder and layouts/@<room>/ to rooms/.trash/<room>-<stamp>/ (trash.json beside them);
   *  a queued align job is dropped, a running one's result ignored. The scenes stay, in no room. Null when unknown. */
  delete(name: string): string | null {
    const r = this.read(name)
    if (r === null) return null
    const now = this.#now()
    for (const job of this.#jobs.list()) {
      if (job.room !== name || (job.status !== 'queued' && job.status !== 'running')) continue
      this.#dropped.add(job.id)
      if (job.status === 'queued') this.#jobs.update(job.id, { status: 'failed', finished: isoUtc(now), message: ROOM_DELETED, waiting_for: [] })
    }
    const base = trashBase(name, now)
    const trashRoot = path.join(this.dir, '.trash')
    let n = 1
    let trash = path.join(trashRoot, base)
    while (exists(trash)) {
      n += 1
      trash = path.join(trashRoot, numbered(base, n))
    }
    makeDirs(trashRoot)
    const moved = move(path.join(this.dir, name), trash)
    const layouts = this.layoutsPath(name)
    if (isDir(layouts)) move(layouts, path.join(moved, 'layouts'))
    writeJsonSync(path.join(moved, TRASH_META), { name, title: r.title, created: r.created === '' ? null : r.created, deleted: isoUtc(now) }, 'midstudy/trash.schema.json#/$defs/room')
    return path.basename(this.dir) + '/.trash/' + path.basename(moved)
  }

  /** The deleted rooms, newest first (by `deleted`, then the folder name). */
  trash(): TrashedRoom[] {
    const root = path.join(this.dir, '.trash')
    const out: TrashedRoom[] = []
    if (!isDir(root)) return out
    for (const entry of listDir(root)) {
      const d = path.join(root, entry)
      if (!isDir(d) || !isFile(path.join(d, 'room.json'))) continue
      const meta = readJson(path.join(d, TRASH_META))
      const metaName = isRecord(meta) ? meta['name'] : undefined
      if (!isRecord(meta) || typeof metaName !== 'string' || !isSlug(metaName)) continue
      const deleted = meta['deleted']
      const t = mtimeOf(d)
      const title = meta['title']
      const created = meta['created']
      out.push({
        name: metaName,
        title: typeof title === 'string' ? title : null,
        created: typeof created === 'string' ? created : null,
        deleted: pyTruthy(deleted) ? pyStr(deleted) : t === null ? '' : isoFromTimestamp(t),
        dir: entry,
      })
    }
    return out.sort((a, b) => {
      const byDeleted = cmpCodePoints(b.deleted, a.deleted)
      return byDeleted !== 0 ? byDeleted : cmpCodePoints(b.dir, a.dir)
    })
  }

  /** POST /api/rooms/<room>/restore: the newest trashed copy and its layouts back; members whose scene is gone or now in
   *  another room are dropped. */
  restore(name: string): { readonly room: RoomObject | null } | 'none' | 'exists' {
    const copy = this.trash().find((t) => t.name === name)
    if (copy === undefined) return 'none'
    const dest = path.join(this.dir, name)
    if (exists(dest) || exists(this.layoutsPath(name))) return 'exists'
    const others = this.index()
    const moved = move(path.join(this.dir, '.trash', copy.dir), dest)
    fs.rmSync(path.join(moved, TRASH_META), { force: true })
    if (isDir(path.join(moved, 'layouts'))) {
      makeDirs(this.layoutsDir)
      move(path.join(moved, 'layouts'), this.layoutsPath(name))
    }
    const r = this.read(name)
    if (r !== null) {
      const kept = r.members.filter((m) => this.#scenes.exists(m.scene) && !others.has(m.scene))
      if (kept.length !== r.members.length) this.#write({ ...r, members: kept, saved: isoUtc(this.#now()) })
    }
    return { room: this.object(name) }
  }

  // --- align jobs (§4.9 Align) -----------------------------------------------------------------------------------------

  /** A job as the API serves it: a queued one lists the members it waits for (calibrations queued or running). */
  #view(job: AlignJobView): AlignJobView {
    if (job.status !== 'queued') return job
    const r = this.read(job.room)
    const members = r === null ? [] : r.members
    const waiting = waitingFor(members, members.map((m) => this.#scenes.busy(m.scene)))
    return { ...job, waiting_for: waiting, message: waitingMessage(waiting) }
  }

  listJobs(): AlignJobView[] {
    return this.#jobs.list().map((j) => this.#view(j))
  }

  getJob(id: string): AlignJobView | null {
    const job = this.#jobs.get(id)
    return job === null ? null : this.#view(job)
  }

  /** POST /api/rooms/<room>/align (checked): an align job on the calibration queue. */
  align(name: string, req: AlignRequest): { readonly job: AlignJobView } | Refusal {
    const r = this.read(name)
    if (r === null) return { status: 404, error: noRoom(name) }
    const last = this.#lastJob(name)
    if (last !== null && (last.status === 'queued' || last.status === 'running')) return { status: 409, error: ALIGN_BUSY }
    // A member still calibrating counts: its photo.jpg comes with its calibration, which the job waits for (New room
    // asks for the alignment right after the uploads, §4.9 Planner).
    if (r.members.filter((m) => isFile(this.#photo(m.scene)) || this.#scenes.busy(m.scene)).length < 2) return { status: 409, error: ALIGN_NEEDS_PHOTOS }
    const now = this.#now()
    const id = newJobId('a', now)
    const job: AlignJobView = { id, kind: 'align', room: name, status: 'queued', created: isoUtc(now), started: null, finished: null, message: ALIGN_QUEUED, waiting_for: [], align: null }
    this.#jobs.add(job)
    this.#requests.set(id, req)
    this.#last.set(name, id)
    this.#scenes.queueTask(id, {
      run: () => this.#run(id),
      failed: (e) => {
        this.#end(id, false, serverFailed(e instanceof Error ? e.name : 'Error', e instanceof Error ? e.message : String(e)))
      },
    })
    return { job: this.#view(job) }
  }

  /** A job that ended without a result to apply. */
  #end(id: string, ok: boolean, message: string): void {
    const job = this.#jobs.get(id)
    if (job === null) return
    let m = message
    if (this.#dropped.has(id)) {
      this.#removeLeftover(job.room)
      m = ROOM_DELETED
    }
    this.#jobs.update(id, { status: ok ? 'done' : 'failed', finished: isoUtc(this.#now()), message: m, waiting_for: [] })
    this.#requests.delete(id)
  }

  /** The tool may have re-made the room folder (with align.json) after a delete moved it. */
  #removeLeftover(name: string): void {
    const left = path.join(this.dir, name)
    if (isDir(left) && !exists(path.join(left, 'room.json'))) removeTree(left)
  }

  /** One turn of an align job; false when members still calibrate (it goes to the back of the queue). */
  async #run(id: string): Promise<boolean> {
    const job = this.#jobs.get(id)
    const req = this.#requests.get(id)
    if (job === null || req === undefined || job.status !== 'queued' || this.#dropped.has(id)) return true
    const r = this.read(job.room)
    if (r === null) {
      this.#end(id, false, ROOM_DELETED)
      return true
    }
    // Calibrations of members queued behind this job pass it; with nothing else queued it would wait forever, so
    // it runs (a member's calibration can't be running while this job has its turn).
    if (r.members.some((m) => this.#scenes.busy(m.scene)) && this.#scenes.queued > 0) return false
    const hasPhoto = r.members.map((m) => isFile(this.#photo(m.scene)))
    if (hasPhoto.filter((h) => h).length < 2) {
      this.#end(id, false, ALIGN_TOO_FEW)
      return true
    }
    const order = alignOrder(r.members, hasPhoto, anchorIndex(r.members, hasPhoto, req.overwriteManual))
    this.#jobs.update(id, { status: 'running', started: isoUtc(this.#now()), message: ALIGN_RUNNING, waiting_for: [] })
    const args = [...order.map((s) => resolvePath(this.#scenes.path(s))), '--out', resolvePath(path.join(this.dir, job.room))]
    if (req.solver !== null) args.push('--solver', req.solver)
    const outcome = await this.#scenes.runCalib({ id, cmd: 'align-room', args })
    this.#ended(id, outcome, req)
    return true
  }

  #ended(id: string, outcome: CalibOutcome, req: AlignRequest): void {
    switch (outcome.kind) {
      case 'not-found':
        this.#end(id, false, notInstalled(outcome.command))
        return
      case 'timeout':
        this.#end(id, false, alignTimedOut(this.#scenes.timeoutSeconds))
        return
      case 'spawn-error':
        this.#end(id, false, serverFailed('OSError', outcome.message))
        return
      case 'stopped':
        this.#end(id, false, 'the server stopped')
        return
      case 'violation':
        this.#end(id, false, outcome.message)
        return
      case 'result':
        break
    }
    const out = outcome.line
    if (outcome.returnCode !== 0 || !isRecord(out) || out['ok'] !== true) {
      if (outcome.returnCode === 0 && !isRecord(out)) this.#end(id, false, ALIGN_NO_RESULT)
      else this.#end(id, false, toolError(isRecord(out) ? out['error'] : undefined, outcome.stderr, outcome.returnCode, 'midstudy-calib'))
      return
    }
    const job = this.#jobs.get(id)
    if (job === null) return
    if (this.#dropped.has(id)) {
      this.#end(id, false, ROOM_DELETED)
      return
    }
    const result = Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'ok'))
    const answer = readAnswer(result)
    const r = this.read(job.room)
    if (answer === null || r === null) {
      this.#end(id, false, answer === null ? ALIGN_NO_RESULT : ROOM_DELETED)
      return
    }
    const finished = isoUtc(this.#now())
    const members = this.#applied(r.members, answer.members, { kind: 'align', overwriteManual: req.overwriteManual })
    this.#write({ ...r, members, aligned: { solver: answer.solver, finished }, saved: finished })
    const placed = answer.members.filter((m) => m.pose !== null).length
    this.#jobs.update(id, { status: 'done', finished, message: alignedMessage(answer.solver, placed, answer.members.length), waiting_for: [], align: result })
    this.#requests.delete(id)
  }
}
