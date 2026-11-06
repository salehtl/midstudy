// Scenes (contract §4.2, §4.4): v1's sentences, the upload's headers, the scene object and what a calibration that
// ends does to the scene (planner/serve.py SceneService, post_scene, no_scene, restore_scene). Pure (TScert).
import { mbText, pyRepr, pyStrip } from '../../../../common/logic/pyfmt.ts'
import { isSlug, posixName } from '../../../../common/logic/slug.ts'
import { codePointLength, codePointPrefix, isRecord, pyStr, pyTruthy } from './values.ts'

/** v1 MAX_SCENE_UPLOAD: a scene photo can be 25 MiB. */
export const MAX_SCENE_UPLOAD = 25 * 1024 * 1024
/** v1 NOT_IMAGE (400). */
export const NOT_IMAGE = "that file isn't a JPEG, PNG, HEIC or WebP image"
/** v1's 411 for an upload without a length. */
export const LENGTH_REQUIRED = 'Content-Length is required: send the photo as the request body'
/** v1's 400 without X-Midstudy-Filename. */
export const FILENAME_REQUIRED = "X-Midstudy-Filename is required (the photo's name, e.g. IMG_0042.HEIC)"
/** v1's 400 for an X-Midstudy-Meta that isn't base64 of a JSON object with a text (or null) title. */
export const BAD_META = 'X-Midstudy-Meta must be base64 of a JSON object like {"title": "Lounge"}'
/** v1's 400 for a title over 200 characters. */
export const TITLE_TOO_LONG = 'the title can be at most 200 characters'
/** v1's 400 when the body ended before Content-Length. */
export const UPLOAD_STOPPED = 'the upload stopped before the end: try again'
/** v1 MAX_THUMB: a thumbnail can be 2 MiB. */
export const MAX_THUMB = 2 * 1024 * 1024
/** v1's 413 for a thumbnail over 2 MiB. */
export const THUMB_TOO_BIG = 'thumbnail is over 2 MB: send a smaller JPEG'

/** v1 `no_scene`: 404 for a name that isn't a slug, or one that isn't a scene. */
export function noScene(name: string): string {
  if (!isSlug(name)) return 'no scene named ' + pyRepr(name) + ' (scene names are slugs: a-z, 0-9, -)'
  return 'no scene named ' + pyRepr(name) + ': GET /api/scenes lists them'
}

/** v1's 404 for an unknown calibration job. */
export function noJob(id: string): string {
  return 'no calibration job ' + pyRepr(id) + ': GET /api/scenes/jobs lists them'
}

/** v1's 404 for POST …/restore with a name that isn't a slug. */
export function noDeletedScene(name: string): string {
  return 'no deleted scene named ' + pyRepr(name)
}

/** v1's 404 for POST …/restore when the trash holds no copy. */
export function notInTrash(name: string): string {
  return pyRepr(name) + " isn't in the scenes' trash"
}

/** v1's 409 for POST …/restore when the name is taken again. */
export function existsAgain(name: string): string {
  return 'a scene ' + pyRepr(name) + ' (or its layouts) exists again: delete it first'
}

/** v1's 413 for an upload over 25 MiB. */
export function uploadTooLarge(length: number): string {
  return 'that photo is ' + mbText(length) + ': a scene photo can be at most 25 MB'
}

/** The photo's name from X-Midstudy-Filename (v1: backslashes as slashes, the last path component, trimmed), at most
 *  200 characters when stored; '' when there is none. */
export function uploadFilename(header: string | undefined): string {
  return pyStrip(posixName((header ?? '').replace(/\\/g, '/')))
}

/** The stored filename: at most 200 characters (v1 `filename[:200]`). */
export function storedFilename(filename: string): string {
  return codePointPrefix(filename, 200)
}

/** The title an upload's meta gives (trimmed; null when blank or absent), or v1's refusal. `meta` is the header's JSON,
 *  or undefined when it didn't decode or parse. */
export function metaTitle(meta: unknown): { readonly ok: true; readonly title: string | null } | { readonly ok: false; readonly error: string } {
  if (!isRecord(meta)) return { ok: false, error: BAD_META }
  const title = meta['title']
  if (title !== undefined && title !== null && typeof title !== 'string') return { ok: false, error: BAD_META }
  const t = pyStrip(typeof title === 'string' ? title : '')
  if (codePointLength(t) > 200) return { ok: false, error: TITLE_TOO_LONG }
  return { ok: true, title: t === '' ? null : t }
}

/** A scene's title as the scene object shows it: text that isn't blank, else null. */
export function shownTitle(title: unknown): string | null {
  return typeof title === 'string' && pyStrip(title) !== '' ? title : null
}

/** The scene object (contract §4.4), in v1's key order. */
export interface SceneObject {
  readonly name: string
  readonly title: string | null
  readonly created: unknown
  readonly saved: unknown
  readonly photo_url: string | null
  readonly thumb_url: string | null
  readonly depth_url: string | null
  readonly w: number | null
  readonly h: number | null
  readonly camera_source: unknown
  readonly floor_found: boolean | null
  readonly layouts: number
  readonly calib_status: 'pending' | 'running' | 'done' | 'failed'
  readonly calib_error: string | null
  /** The room the scene is a member of, or null (contract §4.9); a server with rooms always sends it. */
  readonly room?: string | null
}

/** A scene asset's URL with its cache buster (`?v=<int(mtime)>`), or null without the file. */
export function assetUrl(name: string, file: string, mtimeSeconds: number | null): string | null {
  return mtimeSeconds === null ? null : '/scenes/' + name + '/' + file + '?v=' + pyStr(mtimeSeconds)
}

/** `camera_source` as listed: scene.json's when it is truthy (v1 `or "default"`). */
export function listedCameraSource(v: unknown): unknown {
  return pyTruthy(v) ? v : 'default'
}

/** What a successful calibration does to scene.json's camera (contract §4.4 When a calibration job ends): `auto` and
 *  `default` (or a scene.json without one) take calib.json's camera and become `auto`; `manual` is never overwritten. */
export function takesCalibratedCamera(cameraSource: unknown): boolean {
  return cameraSource === 'auto' || cameraSource === 'default' || cameraSource === null || cameraSource === undefined
}
