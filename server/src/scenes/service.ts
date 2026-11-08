// Scenes on disk and their calibration queue (contract §4.2, §4.4, §4.8 backfill): v1's SceneService
// (planner/serve.py) on Node. One queue, one job at a time, in memory, separate from the library's queue; it also
// runs light jobs (lighting.json alone), which never touch scene.json, the camera or calib_status. Every change to a
// scene folder happens synchronously (files.ts), so it is atomic for this server as v1's lock made it.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isoUtc } from '../../../common/logic/time.ts'
import { isSlug } from '../../../common/logic/slug.ts'
import { jpegFrame } from '../../../core/js/node.ts'
import type { Camera, SceneTrashRoom } from '../../../contract/gen/types.ts'
import { JobStore, SerialQueue, newJobId } from '../jobs.ts'
import { toolError } from '../../../common/tools.ts'
import { CalibRunner, type CalibOutcome, type CalibRequest } from './calib.ts'
import { listDir, makeDir, makeDirs, mtimeOf, readHead, readJson, readRecord, writeBytesSync, writeJsonSync } from './files.ts'
import { exists, isDir, isFile, move, removeTree, resolvePath } from '../../../common/files.ts'
import { DEFAULT_CAMERA, clampCamera, mergeCamera } from './logic/camera.ts'
import {
  ALREADY_CALIBRATING, LIGHT_WHILE_CALIBRATING, LIGHT_WITHOUT_PHOTO, NO_PHOTO_TO_CALIBRATE, NO_RESULT_LINE, QUEUED, SCENE_DELETED,
  calibratedMessage, lightMessage, notInstalled, runningMessage, serverFailed, timedOut, type CalibCommand,
} from './logic/jobs.ts'
import { mergeLook } from './logic/look.ts'
import { compareTrashed, numbered, sceneBase, trashBase, trashedSceneName, type TrashedScene } from './logic/names.ts'
import { assetUrl, listedCameraSource, noScene, shownTitle, takesCalibratedCamera, type SceneObject } from './logic/scene.ts'
import { stampsSaved, type ScenePatch } from './logic/sceneput.ts'
import { calibStatus, lightingStatus, type CalibStatus, type LightingStatus } from './logic/status.ts'
import { isoFromTimestamp, pyInt } from './logic/time.ts'
import { cmpCodePoints, isRecord, pyStr, pyTruthy } from './logic/values.ts'

/** v1 CALIB_TIMEOUT: one calibration (or light) job, 600 s. */
const CALIB_TIMEOUT_SECONDS = 600
/** The calibration worker's stdin is closed after this long idle. */
const WORKER_IDLE_MS = 10 * 60 * 1000
/** v1 TRASH_META: {name, title, deleted} in a trashed scene's folder. */
const TRASH_META = 'trash.json'
/** Server-private (§4.2): the id of the calibration job writing this folder; never served. */
const CALIBRATING = '.calibrating'

/** A job of the calibration queue as the API serves it (scene-job.schema.json), in v1's key order. */
export interface JobView {
  readonly id: string
  readonly kind: 'calibrate' | 'light'
  readonly scene: string
  readonly status: 'queued' | 'running' | 'done' | 'failed'
  readonly created: string
  readonly started: string | null
  readonly finished: string | null
  readonly message: string
  readonly calib: Readonly<Record<string, unknown>> | null
  /** Light jobs only: true when lighting.json was written, false when the photo shows no clear light, null until then. */
  readonly lighting?: boolean | null
}

/** What a job runs (v1 `private`): the command, its arguments, and a temp folder to remove afterwards. */
interface JobWork {
  readonly cmd: CalibCommand
  readonly args: readonly string[]
  readonly cleanup: string | null
}

/** What the rooms (contract §4.9, server/src/rooms/service.ts) do for the scenes: say which room each scene is in
 *  (the scene object's `room`), take a deleted scene out of its room (its member record goes into the scene's
 *  trash.json) and put a restored one back. */
export interface RoomHooks {
  /** scene → the room it is a member of. */
  readonly index: () => ReadonlyMap<string, string>
  /** Takes `scene` out of its room; its record for trash.json, or null when it is in none. */
  readonly leave: (scene: string) => SceneTrashRoom | null
  /** Puts a restored scene back into the room its trash.json names, when it can (§4.9 Membership). */
  readonly rejoin: (scene: string, record: unknown) => void
}

/** Work of another kind on the calibration queue (a room's align job, §4.9 Align): it runs in its turn, one job at a
 *  time with the calibrations. `run` resolves false when the job isn't ready (members still calibrating): it goes to
 *  the back of the queue, so the calibrations queued behind it pass it. */
export interface QueueTask {
  readonly run: () => Promise<boolean>
  readonly failed: (error: unknown) => void
}

/** A refusal of a scene request: the status and v1's sentence. */
export interface Refusal {
  readonly status: number
  readonly error: string
}

/** v1 `public_calib`: calib.json as the API serves it, without exif.make and exif.model (they stay on disk). */
export function publicCalib(calib: Readonly<Record<string, unknown>> | null): Readonly<Record<string, unknown>> | null {
  if (calib === null) return null
  const exif = calib['exif']
  if (!isRecord(exif)) return calib
  const kept = Object.fromEntries(Object.entries(exif).filter(([k]) => k !== 'make' && k !== 'model'))
  return { ...calib, exif: kept }
}

/** The camera block of a value (a record), clamped; the default for anything else (v1 `clamp_camera(x or {})`). */
function cameraOf(v: unknown): Camera {
  return clampCamera(isRecord(v) ? v : null)
}

export interface SceneServiceOptions {
  readonly scenesDir: string
  readonly layoutsDir: string
  /** --calib, split. */
  readonly calib: readonly string[]
  /** The repository: the tools' working directory. */
  readonly repo: string
  readonly log: (line: string) => void
  readonly now?: () => number
  /** Tests: a shorter job timeout, worker idle time and kill grace. */
  readonly timeoutMs?: number
  readonly workerIdleMs?: number
  readonly killGraceMs?: number
}

export class SceneService {
  readonly dir: string
  readonly layoutsDir: string
  readonly calib: readonly string[]
  readonly #now: () => number
  readonly #timeoutMs: number
  readonly #jobs = new JobStore<JobView>()
  readonly #work = new Map<string, JobWork>()
  /** Jobs whose scene was deleted while they were queued or running (v1's `dropped`; kept after they end). */
  readonly #dropped = new Set<string>()
  /** scene → its newest calibration job id. */
  readonly #last = new Map<string, string>()
  /** scene → its newest light job id (never in #last). */
  readonly #lightLast = new Map<string, string>()
  /** The job #run has started and #after hasn't reached: its tool may still write under the scene's folder. */
  #current: string | null = null
  /** Jobs that ended because the server stopped under them: they keep their marker for the next run (§4.2). */
  readonly #stopped = new Set<string>()
  readonly #queue: SerialQueue
  readonly #runner: CalibRunner
  /** Queued work that isn't a calibration or light job (align jobs), by id. */
  readonly #tasks = new Map<string, QueueTask>()
  /** Tasks sent to the back of the queue by their last turn (their `after` must not forget them). */
  readonly #requeued = new Set<string>()
  #rooms: RoomHooks | null = null

  constructor(options: SceneServiceOptions) {
    this.dir = options.scenesDir
    this.layoutsDir = options.layoutsDir
    this.calib = options.calib
    this.#now = options.now ?? Date.now
    this.#timeoutMs = options.timeoutMs ?? CALIB_TIMEOUT_SECONDS * 1000
    this.#runner = new CalibRunner({
      calib: options.calib,
      cwd: options.repo,
      timeoutMs: this.#timeoutMs,
      idleMs: options.workerIdleMs ?? WORKER_IDLE_MS,
      killGraceMs: options.killGraceMs ?? 5000,
      log: options.log,
    })
    this.#queue = new SerialQueue((id) => this.#run(id), (id, e) => {
      this.#failed(id, e)
    }, (id) => this.#after(id))
  }

  /** The rooms (§4.9): from now on scene objects carry `room`, and delete and restore keep the rooms in step. */
  setRooms(hooks: RoomHooks): void {
    this.#rooms = hooks
  }

  /** Queues work of another kind on the calibration queue (§4.9 Align); `id` must be unique among the queue's jobs (a
   *  repeat is a programming error, and throws). */
  queueTask(id: string, task: QueueTask): void {
    if (this.#tasks.has(id) || this.#work.has(id)) throw new Error('queueTask: job id already queued: ' + id)
    this.#tasks.set(id, task)
    this.#queue.push(id)
  }

  /** How many jobs wait in the calibration queue (not counting the one running). */
  get queued(): number {
    return this.#queue.waiting
  }

  /** One step of a queue task through the calibration tool (the warm worker when it answers, else one-shot), with
   *  the job timeout. */
  runCalib(req: CalibRequest): Promise<CalibOutcome> {
    return this.#runner.run(req)
  }

  /** The job timeout, in seconds. */
  get timeoutSeconds(): number {
    return this.#timeoutMs / 1000
  }

  /** Stops the calibration worker (the server is shutting down). */
  shutdown(): Promise<void> {
    return this.#runner.shutdown()
  }

  /** Resolves when the queue has nothing left to run (tests). */
  drained(): Promise<void> {
    return this.#queue.drained()
  }

  // --- files ---------------------------------------------------------------------------------------------------------

  path(name: string): string {
    return path.join(this.dir, name)
  }

  /** v1 `exists`: a slug with a scene.json. */
  exists(name: string): boolean {
    return isSlug(name) && isFile(path.join(this.dir, name, 'scene.json'))
  }

  /** v1 `read`: scene.json as an object, or null. */
  read(name: string): Readonly<Record<string, unknown>> | null {
    return isSlug(name) ? readRecord(path.join(this.dir, name, 'scene.json')) : null
  }

  #write(name: string, data: unknown): void {
    writeJsonSync(path.join(this.dir, name, 'scene.json'), data, 'midstudy/scene.schema.json')
  }

  /** v1 `names`: the folders that are scenes (a slug with a scene.json). */
  names(): string[] {
    if (!isDir(this.dir)) return []
    return listDir(this.dir).filter((n) => isSlug(n) && isFile(path.join(this.dir, n, 'scene.json')))
  }

  calibJson(name: string): Readonly<Record<string, unknown>> | null {
    return readRecord(path.join(this.dir, name, 'calib.json'))
  }

  lightingJson(name: string): Readonly<Record<string, unknown>> | null {
    return readRecord(path.join(this.dir, name, 'lighting.json'))
  }

  /** v1 `layout_count`: `<slug>.json` files in layouts/<name>/. */
  layoutCount(name: string): number {
    const d = path.join(this.layoutsDir, name)
    if (!isDir(d)) return 0
    return listDir(d).filter((f) => f.endsWith('.json') && isSlug(f.slice(0, -'.json'.length)) && isFile(path.join(d, f))).length
  }

  // --- the scene object (§4.4) ------------------------------------------------------------------------------------------

  /** v1 `status`. */
  status(name: string, hasCalib: boolean): CalibStatus {
    return calibStatus(this.#jobs.get(this.#last.get(name) ?? ''), hasCalib, isFile(path.join(this.dir, name, CALIBRATING)), this.#hasInput(name))
  }

  /** The scene has something to calibrate from: photo.jpg or source.*. */
  #hasInput(name: string): boolean {
    const d = path.join(this.dir, name)
    return isFile(path.join(d, 'photo.jpg')) || listDir(d).some((f) => f.startsWith('source.'))
  }

  #assetUrl(name: string, file: string): string | null {
    const p = path.join(this.dir, name, file)
    if (!isFile(p)) return null
    const t = mtimeOf(p)
    return assetUrl(name, file, t === null ? null : pyInt(t))
  }

  /** photo.jpg's size from its frame header (the first 512 KB: it carries no metadata), or null. */
  #photoSize(name: string): { readonly w: number; readonly h: number } | null {
    const p = path.join(this.dir, name, 'photo.jpg')
    if (!isFile(p)) return null
    const head = readHead(p, 512 * 1024)
    if (head === null) return null
    const f = jpegFrame(head)
    return f.ok ? { w: f.value.width, h: f.value.height } : null
  }

  /** v1 `scene_object`: the scene object of scene.json `data` (read when not given), or null without one. */
  sceneObject(name: string, given?: Readonly<Record<string, unknown>> | null, roomIndex?: ReadonlyMap<string, string>): SceneObject | null {
    const data = given ?? this.read(name)
    if (data === null) return null
    const size = this.#photoSize(name)
    const calib = this.calibJson(name)
    const floor = calib === null ? undefined : calib['floor']
    const found = isRecord(floor) ? floor['found'] : undefined
    const st = this.status(name, calib !== null)
    const index = roomIndex ?? this.#rooms?.index() ?? null
    const obj: SceneObject = {
      name,
      title: shownTitle(data['title']),
      created: data['created'] ?? null,
      saved: data['saved'] ?? null,
      photo_url: this.#assetUrl(name, 'photo.jpg'),
      thumb_url: this.#assetUrl(name, 'thumb.jpg'),
      depth_url: this.#assetUrl(name, 'depth.png'),
      w: size === null ? null : size.w,
      h: size === null ? null : size.h,
      camera_source: listedCameraSource(data['camera_source']),
      floor_found: typeof found === 'boolean' ? found : null,
      layouts: this.layoutCount(name),
      calib_status: st.status,
      calib_error: st.error,
    }
    return index === null ? obj : { ...obj, room: index.get(name) ?? null }
  }

  /** v1 `lighting_status`. */
  lightingStatus(name: string, hasLighting: boolean): LightingStatus {
    const lightId = this.#lightLast.get(name) ?? ''
    const calibId = this.#last.get(name) ?? ''
    const lj = this.#jobs.get(lightId)
    const cj = this.#jobs.get(calibId)
    const light = lj === null ? null : { status: lj.status, message: lj.message, lighting: lj.lighting ?? null, dropped: this.#dropped.has(lightId) }
    const newer = lj !== null && cj !== null && this.#jobs.position(calibId) > this.#jobs.position(lightId)
    return lightingStatus(hasLighting, light, cj, newer)
  }

  /** v1 `full`: GET /api/scenes/<name>. scene.json, the scene object's fields over it, the camera clamped, `calib` (public),
   *  `lighting` (as it is, or null), `lighting_status` and `lighting_error`. */
  full(name: string): Readonly<Record<string, unknown>> | null {
    const data = this.read(name)
    if (data === null) return null
    const obj = this.sceneObject(name, data)
    if (obj === null) return null
    const lighting = this.lightingJson(name)
    const st = this.lightingStatus(name, lighting !== null)
    return {
      ...data,
      ...obj,
      camera: cameraOf(data['camera']),
      calib: publicCalib(this.calibJson(name)),
      lighting,
      lighting_status: st.status,
      lighting_error: st.error,
    }
  }

  /** v1 `all`: newest first by `created`, ties by the name's collision suffix as a number (-10 before -9). */
  all(nameOrder: (a: string, b: string) => number): SceneObject[] {
    const out: SceneObject[] = []
    const index = this.#rooms?.index()
    for (const n of this.names()) {
      const s = this.sceneObject(n, null, index)
      if (s !== null) out.push(s)
    }
    const createdText = (s: SceneObject): string => (pyTruthy(s.created) ? pyStr(s.created) : '')
    return out.sort((a, b) => {
      const byCreated = cmpCodePoints(createdText(b), createdText(a))
      return byCreated !== 0 ? byCreated : nameOrder(b.name, a.name)
    })
  }

  // --- create, update, delete -------------------------------------------------------------------------------------------

  /** v1 `create`: makes scenes/<name>/scene.json and queues `<calib> run <upload> --out scenes/<name>`. The job owns
   *  `tmp` (removed when it ends). */
  create(upload: string, tmp: string, filename: string, ext: string, size: number, title: string | null): { readonly name: string; readonly job: JobView } {
    const now = this.#now()
    const base = sceneBase(now)
    makeDirs(this.dir)
    let n = 1
    let name = base
    while (exists(path.join(this.dir, name)) || !makeDir(path.join(this.dir, name))) {
      n += 1
      name = numbered(base, n)
    }
    this.#write(name, {
      version: 1, title, created: isoUtc(now), saved: null, camera: DEFAULT_CAMERA, camera_source: 'default',
      upload: { filename, ext, bytes: size },
    })
    const job = this.#queueJob(name, 'run', [upload, '--out', resolvePath(path.join(this.dir, name))], tmp, 'calibrate')
    return { name, job }
  }

  #queueJob(name: string, cmd: CalibCommand, args: readonly string[], cleanup: string | null, kind: 'calibrate' | 'light'): JobView {
    const now = this.#now()
    const prefix = kind === 'light' ? 'l' : 'c'
    let id = newJobId(prefix, now)
    while (this.#jobs.get(id) !== null) id = newJobId(prefix, now)
    if (kind === 'calibrate') writeBytesSync(path.join(this.dir, name, CALIBRATING), Buffer.from(id))
    const base = { id, kind, scene: name, status: 'queued', created: isoUtc(now), started: null, finished: null, message: QUEUED, calib: null } as const
    const job: JobView = kind === 'light' ? { ...base, lighting: null } : base
    const snapshot = this.#jobs.add(job)
    this.#work.set(id, { cmd, args, cleanup })
    if (kind === 'light') this.#lightLast.set(name, id)
    else this.#last.set(name, id)
    this.#queue.push(id)
    return snapshot
  }

  /** v1 `busy`: the scene's newest calibration job is queued or running. */
  busy(name: string): boolean {
    const job = this.#jobs.get(this.#last.get(name) ?? '')
    return job !== null && (job.status === 'queued' || job.status === 'running')
  }

  /** v1 `calibrate`: `fit` on photo.jpg, or `run` on a copy of source.<ext> (in a private temp folder) when photo.jpg is
   *  missing. */
  calibrate(name: string): { readonly job: JobView } | Refusal {
    if (!this.exists(name)) return { status: 404, error: noScene(name) }
    if (this.busy(name)) return { status: 409, error: ALREADY_CALIBRATING }
    const d = path.join(this.dir, name)
    if (isFile(path.join(d, 'photo.jpg'))) return { job: this.#queueJob(name, 'fit', [resolvePath(d)], null, 'calibrate') }
    const sources = listDir(d).filter((f) => f.startsWith('source.')).map((f) => path.join(d, f)).sort(cmpCodePoints)
    const source = sources[0]
    if (source === undefined) return { status: 409, error: NO_PHOTO_TO_CALIBRATE }
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'midstudy-scene-'))
    const copy = path.join(tmp, 'upload' + suffixOf(path.basename(source)).toLowerCase())
    try {
      fs.copyFileSync(source, copy)
    } catch (e) {
      removeTree(tmp)
      throw e
    }
    return { job: this.#queueJob(name, 'run', [copy, '--out', resolvePath(d)], tmp, 'calibrate') }
  }

  /** v1 `light` (§4.8 backfill): queue `<calib> light <scene-dir>` for a scene without lighting.json. */
  light(name: string): { readonly status: 200; readonly body: { readonly lighting_status: 'done' } } | { readonly status: 202; readonly body: { readonly job: JobView } } | Refusal {
    if (!this.exists(name)) return { status: 404, error: noScene(name) }
    if (this.busy(name)) return { status: 409, error: LIGHT_WHILE_CALIBRATING }
    const d = path.join(this.dir, name)
    if (!isFile(path.join(d, 'photo.jpg'))) return { status: 409, error: LIGHT_WITHOUT_PHOTO }
    if (this.lightingJson(name) !== null) return { status: 200, body: { lighting_status: 'done' } }
    const lightId = this.#lightLast.get(name) ?? ''
    const job = this.#jobs.get(lightId)
    if (job !== null && (job.status === 'queued' || job.status === 'running') && !this.#dropped.has(lightId)) return { status: 202, body: { job } }
    return { status: 202, body: { job: this.#queueJob(name, 'light', [resolvePath(d)], null, 'light') } }
  }

  /** v1 `update` (PUT /api/scenes/<name>, checked by the handler): merge, clamp, stamp `saved` unless only the title
   *  came. False when the scene is gone. */
  update(name: string, patch: ScenePatch): boolean {
    const data = this.read(name)
    if (data === null) return false
    const out = new Map<string, unknown>(Object.entries(data))
    if (patch.title !== null) out.set('title', patch.title.value)
    if (patch.camera !== null) out.set('camera', mergeCamera(cameraOf(data['camera']), patch.camera))
    if (patch.cameraSource !== null) out.set('camera_source', patch.cameraSource)
    if (patch.look !== null) {
      const current = data['look']
      out.set('look', Object.fromEntries(mergeLook(isRecord(current) ? Object.entries(current) : [], patch.look)))
    }
    if (stampsSaved(patch)) out.set('saved', isoUtc(this.#now()))
    if (!out.has('version')) out.set('version', 1)
    this.#write(name, Object.fromEntries(out))
    return true
  }

  /** PUT /api/scenes/<name>/thumb: thumb.jpg (already without metadata). False when the scene is gone. */
  writeThumb(name: string, jpeg: Uint8Array): boolean {
    if (!this.exists(name)) return false
    writeBytesSync(path.join(this.dir, name, 'thumb.jpg'), jpeg)
    return true
  }

  /** The scene's thumb_url. */
  thumbUrl(name: string): string | null {
    return this.#assetUrl(name, 'thumb.jpg')
  }

  /** v1 `delete`: scenes/<name>/ (and layouts/<name>/ inside it as layouts/) to scenes/.trash/<name>-<stamp>/; a queued
   *  job for it is dropped, a running one's result ignored. Returns the trash path as v1 answered it, or null when the
   *  scene is gone. */
  delete(name: string): string | null {
    if (!this.exists(name)) return null
    const now = this.#now()
    for (const job of this.#jobs.list().reverse()) {
      if (job.scene !== name || (job.status !== 'queued' && job.status !== 'running')) continue
      this.#dropped.add(job.id)
      if (job.status !== 'queued') continue // a running job's marker goes to the trash with the folder its tool may have half-written
      this.#jobs.update(job.id, { status: 'failed', finished: isoUtc(now), message: SCENE_DELETED })
      if (job.kind === 'calibrate') this.#removeMarker(name, job.id) // it never started: a restored scene reads from its files
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
    const title = this.read(name)?.['title']
    const room = this.#rooms?.leave(name) ?? null
    // trash.json before the moves: if one throws, the room record is still on disk (a later delete overwrites it).
    const meta = { name, title: typeof title === 'string' ? title : null, deleted: isoUtc(now) }
    writeJsonSync(path.join(this.dir, name, TRASH_META), room === null ? meta : { ...meta, room }, 'midstudy/trash.schema.json#/$defs/scene')
    const moved = move(path.join(this.dir, name), trash)
    const layouts = path.join(this.layoutsDir, name)
    if (isDir(layouts)) move(layouts, path.join(moved, 'layouts'))
    return path.basename(this.dir) + '/.trash/' + path.basename(moved)
  }

  /** v1 `trash`: every deleted scene in scenes/.trash/, newest first. */
  trash(): TrashedScene[] {
    const root = path.join(this.dir, '.trash')
    const out: TrashedScene[] = []
    if (!isDir(root)) return out
    for (const entry of listDir(root)) {
      const d = path.join(root, entry)
      if (!isDir(d) || !isFile(path.join(d, 'scene.json'))) continue
      const meta = readJson(path.join(d, TRASH_META))
      const metaName = isRecord(meta) ? meta['name'] : undefined
      let name: string
      let deleted: unknown
      let title: unknown
      if (isRecord(meta) && typeof metaName === 'string' && isSlug(metaName)) {
        name = metaName
        deleted = meta['deleted']
        title = meta['title']
      } else {
        // trashed before trash.json existed: <name>-<UTC stamp>[-n]
        const fromDir = trashedSceneName(entry)
        if (fromDir === null) continue
        const t = mtimeOf(d)
        name = fromDir
        deleted = t === null ? null : isoFromTimestamp(t)
        title = readRecord(path.join(d, 'scene.json'))?.['title']
      }
      const created = readRecord(path.join(d, 'scene.json'))?.['created']
      out.push({
        name,
        title: typeof title === 'string' ? title : null,
        created: typeof created === 'string' ? created : null,
        deleted: pyTruthy(deleted) ? pyStr(deleted) : '',
        dir: entry,
      })
    }
    return out.sort(compareTrashed)
  }

  /** v1 `restore`: the newest trashed copy of `name` back to scenes/<name>/, its layouts back to layouts/<name>/. */
  restore(name: string): { readonly scene: SceneObject | null } | 'none' | 'exists' {
    const copy = this.trash().find((t) => t.name === name)
    if (copy === undefined) return 'none'
    // A dropped job still running may yet re-make the folder; it is over at #after.
    if (this.#current !== null && this.#dropped.has(this.#current) && this.#jobs.get(this.#current)?.scene === name) return 'exists'
    const dest = path.join(this.dir, name)
    if (exists(dest) || exists(path.join(this.layoutsDir, name))) return 'exists'
    const moved = move(path.join(this.dir, '.trash', copy.dir), dest)
    const meta = readJson(path.join(moved, TRASH_META))
    // The delete's dropped jobs say nothing about the restored scene: its status comes from its files again.
    for (const last of [this.#last, this.#lightLast]) {
      if (this.#dropped.has(last.get(name) ?? '')) last.delete(name)
    }
    if (isDir(path.join(moved, 'layouts'))) {
      makeDirs(this.layoutsDir)
      move(path.join(moved, 'layouts'), path.join(this.layoutsDir, name))
    }
    const room = isRecord(meta) ? meta['room'] : undefined
    if (room !== undefined) this.#rooms?.rejoin(name, room)
    fs.rmSync(path.join(moved, TRASH_META), { force: true }) // last: until here it is the only record of the room
    return { scene: this.sceneObject(name) }
  }

  // --- jobs --------------------------------------------------------------------------------------------------------------

  listJobs(): JobView[] {
    return this.#jobs.list()
  }

  getJob(id: string): JobView | null {
    return this.#jobs.get(id)
  }

  /** The leftover of a dropped job: the tool may have re-made the scene folder after the delete moved it. */
  #removeLeftover(name: string): void {
    const left = path.join(this.dir, name)
    if (isDir(left) && !exists(path.join(left, 'scene.json'))) removeTree(left)
  }

  /** Removes the scene's marker when it is this job's (another job may have written its own since). */
  #removeMarker(name: string, id: string): void {
    const file = path.join(this.dir, name, CALIBRATING)
    if (isFile(file) && fs.readFileSync(file, 'utf8') === id) fs.rmSync(file, { force: true })
  }

  /** v1 `finish`: a job that ended without a result to apply. */
  #finish(id: string, ok: boolean, message: string): void {
    const job = this.#jobs.get(id)
    if (job === null) return
    let m = message
    if (this.#dropped.has(id)) {
      this.#removeLeftover(job.scene)
      m = SCENE_DELETED
    }
    this.#jobs.update(id, { status: ok ? 'done' : 'failed', finished: isoUtc(this.#now()), message: m })
  }

  async #run(id: string): Promise<void> {
    const task = this.#tasks.get(id)
    if (task !== undefined) {
      const done = await task.run()
      if (!done) {
        this.#requeued.add(id)
        this.#queue.push(id)
      }
      return
    }
    const job = this.#jobs.get(id)
    const work = this.#work.get(id)
    if (job === null || work === undefined || job.status !== 'queued') return // dropped while it waited
    this.#jobs.update(id, { status: 'running', started: isoUtc(this.#now()), message: runningMessage(job.kind) })
    this.#current = id
    const outcome = await this.#runner.run({ id, cmd: work.cmd, args: work.args })
    this.#ended(id, job.kind, outcome)
  }

  // Reads scene.json, merges the camera and writes it back below: this must stay in one synchronous turn, or a manual
  // PUT during the calibration could be overwritten.
  #ended(id: string, kind: 'calibrate' | 'light', outcome: CalibOutcome): void {
    switch (outcome.kind) {
      case 'not-found':
        this.#finish(id, false, notInstalled(outcome.command))
        return
      case 'timeout':
        this.#finish(id, false, timedOut(kind, this.#timeoutMs / 1000))
        return
      case 'spawn-error':
        this.#finish(id, false, serverFailed('OSError', outcome.message))
        return
      case 'stopped':
        this.#stopped.add(id)
        this.#finish(id, false, 'the server stopped')
        return
      case 'violation':
        this.#finish(id, false, outcome.message)
        return
      case 'result':
        break
    }
    const out = outcome.line
    if (outcome.returnCode !== 0 || !isRecord(out) || out['ok'] !== true) {
      if (outcome.returnCode === 0 && !isRecord(out)) {
        this.#finish(id, false, NO_RESULT_LINE)
        return
      }
      this.#finish(id, false, toolError(isRecord(out) ? out['error'] : undefined, outcome.stderr, outcome.returnCode, 'midstudy-calib'))
      return
    }
    if (kind === 'light') {
      this.#lightDone(id, out)
      return
    }
    const job = this.#jobs.get(id)
    if (job === null) return
    const name = job.scene
    if (this.#dropped.has(id)) {
      this.#removeLeftover(name)
      this.#jobs.update(id, { status: 'failed', finished: isoUtc(this.#now()), message: SCENE_DELETED })
      return
    }
    const calib = this.calibJson(name) ?? Object.fromEntries(Object.entries(out).filter(([k]) => k !== 'ok'))
    const data = this.read(name)
    if (data !== null && takesCalibratedCamera(data['camera_source'])) {
      const next = new Map<string, unknown>(Object.entries(data))
      next.set('camera', cameraOf(calib['camera']))
      next.set('camera_source', 'auto')
      this.#write(name, Object.fromEntries(next))
    }
    const floor = calib['floor']
    const message = calibratedMessage(calib['source'], isRecord(floor) ? floor['found'] : undefined)
    this.#jobs.update(id, { status: 'done', finished: isoUtc(this.#now()), calib: publicCalib(calib), message })
  }

  /** v1 `light_done`: a light job that ran; never touches scene.json, the camera or calib_status (§4.8). */
  #lightDone(id: string, out: Readonly<Record<string, unknown>>): void {
    const job = this.#jobs.get(id)
    if (job === null) return
    if (this.#dropped.has(id)) {
      this.#removeLeftover(job.scene)
      this.#jobs.update(id, { status: 'failed', finished: isoUtc(this.#now()), message: SCENE_DELETED })
      return
    }
    const found = out['lighting'] === true
    this.#jobs.update(id, { status: 'done', finished: isoUtc(this.#now()), lighting: found, message: lightMessage(found, out['cct_k']) })
  }

  /** The queue's catch-all (v1 `worker`): one bad job never stops the queue. */
  #failed(id: string, e: unknown): void {
    const task = this.#tasks.get(id)
    if (task !== undefined) {
      task.failed(e)
      return
    }
    const name = e instanceof Error ? e.name : 'Error'
    const message = e instanceof Error ? e.message : String(e)
    this.#jobs.update(id, { status: 'failed', finished: isoUtc(this.#now()), message: serverFailed(name, message) })
  }

  #after(id: string): Promise<void> {
    if (this.#tasks.has(id)) {
      if (this.#requeued.has(id)) this.#requeued.delete(id)
      else this.#tasks.delete(id)
      return Promise.resolve()
    }
    if (this.#current === id) this.#current = null
    const job = this.#jobs.get(id)
    if (job?.kind === 'calibrate' && !this.#stopped.has(id)) this.#removeMarker(job.scene, id)
    this.#stopped.delete(id)
    const work = this.#work.get(id)
    this.#work.delete(id)
    if (work?.cleanup !== null && work?.cleanup !== undefined) removeTree(work.cleanup)
    return Promise.resolve()
  }
}

/** Python's `Path(name).suffix`: the last `.ext` of a file name ('' for none, a leading dot or a trailing one). */
function suffixOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i > 0 && i < name.length - 1 ? name.slice(i) : ''
}
