// PUT /api/scenes/<name> (contract §4.4, §4.8): v1's checks of the body, in v1's order and with its sentences
// (planner/serve.py `put_scene`), and the patch they leave. Pure (TScert); the shell parses the JSON and narrows
// objects to records first.
import { pyStrip } from '../../../../common/logic/pyfmt.ts'
import { CAMERA_KEYS } from './camera.ts'
import { lookProblem, type LookValue } from './look.ts'
import { codePointLength, isNum, sortedStrings } from './values.ts'

/** The keys PUT /api/scenes/<name> takes. */
const SCENE_KEYS: readonly string[] = ['title', 'camera', 'camera_source', 'look']

/** What a checked body changes; null: the body didn't carry that key. */
export interface ScenePatch {
  /** The title trimmed, null when blank; `{value}` so that "set it to null" differs from "not given". */
  readonly title: { readonly value: string | null } | null
  /** The camera keys given (numbers). */
  readonly camera: Readonly<Record<string, unknown>> | null
  readonly cameraSource: 'auto' | 'manual' | 'default' | null
  /** The look's entries as given (checked: numbers, booleans and nulls of known keys). */
  readonly look: readonly (readonly [string, LookValue])[] | null
}

/** The body as the shell sees it: its entries, each object value already narrowed. */
export interface PutBody {
  /** The body's top-level entries; null when the body isn't a JSON object. */
  readonly entries: readonly (readonly [string, unknown])[] | null
  /** The `camera` value's entries when it is an object, else null. */
  readonly cameraEntries: readonly (readonly [string, unknown])[] | null
  /** The `camera` value when it is an object, else null. */
  readonly camera: Readonly<Record<string, unknown>> | null
  /** The `look` value's entries when it is an object, else null. */
  readonly lookEntries: readonly (readonly [string, unknown])[] | null
}

export type PutCheck = { readonly ok: true; readonly patch: ScenePatch } | { readonly ok: false; readonly error: string }

function refuse(error: string): PutCheck {
  return { ok: false, error }
}

/** The value of `key` among `entries` (the last one, as JSON objects keep the last duplicate). */
function valueOf(entries: readonly (readonly [string, unknown])[], key: string): unknown {
  let found: unknown = undefined
  for (const [k, v] of entries) {
    if (k === key) found = v
  }
  return found
}

function hasKey(entries: readonly (readonly [string, unknown])[], key: string): boolean {
  return entries.some(([k]) => k === key)
}

/** The title as v1 kept it: trimmed, null when blank; or v1's refusal. */
function titleOf(v: unknown): { readonly ok: true; readonly value: string | null } | { readonly ok: false; readonly error: string } {
  if (v !== null && typeof v !== 'string') return { ok: false, error: 'title must be text or null' }
  const t = pyStrip(v ?? '')
  if (codePointLength(t) > 200) return { ok: false, error: 'the title can be at most 200 characters' }
  return { ok: true, value: t === '' ? null : t }
}

function cameraSourceOf(v: unknown): 'auto' | 'manual' | 'default' | null {
  if (v === 'auto' || v === 'manual' || v === 'default') return v
  return null
}

/** A look entry's value as the patch keeps it (lookProblem has checked its type). */
function lookValue(v: unknown): LookValue {
  if (typeof v === 'number' || typeof v === 'boolean') return v
  return null
}

/** v1 `put_scene`'s checks, first refusal wins: the body an object with at least one key, no other keys than title,
 *  camera, camera_source and look; then title, camera, camera_source and look in that order. */
export function checkScenePut(body: PutBody): PutCheck {
  const entries = body.entries
  if (entries === null || entries.length === 0) return refuse('the body must be a JSON object with any of title, camera, camera_source, look')
  const unknown = entries.map(([k]) => k).filter((k) => !SCENE_KEYS.includes(k))
  if (unknown.length > 0) return refuse(sortedStrings([...new Set(unknown)]).join(', ') + " can't be set: use title, camera, camera_source or look")
  let title: { readonly value: string | null } | null = null
  if (hasKey(entries, 'title')) {
    const t = titleOf(valueOf(entries, 'title'))
    if (!t.ok) return refuse(t.error)
    title = { value: t.value }
  }
  let camera: Readonly<Record<string, unknown>> | null = null
  if (hasKey(entries, 'camera')) {
    const cam = body.cameraEntries
    if (cam === null || body.camera === null || cam.length === 0) {
      return refuse('camera must be an object like {"fov_y_deg": 55, "height_m": 1.4, "pitch_deg": -10, "roll_deg": 0}')
    }
    const bad = cam.map(([k]) => k).filter((k) => !CAMERA_KEYS.includes(k))
    if (bad.length > 0) return refuse('camera has unknown fields (' + sortedStrings([...new Set(bad)]).join(', ') + '): use fov_y_deg, height_m, pitch_deg, roll_deg')
    const notNumbers = cam.filter(([, v]) => !isNum(v)).map(([k]) => k)
    if (notNumbers.length > 0) return refuse('camera ' + sortedStrings([...new Set(notNumbers)]).join(', ') + ' must be a number')
    camera = body.camera
  }
  let cameraSource: 'auto' | 'manual' | 'default' | null = null
  if (hasKey(entries, 'camera_source')) {
    cameraSource = cameraSourceOf(valueOf(entries, 'camera_source'))
    if (cameraSource === null) return refuse('camera_source must be auto, manual or default')
  }
  let look: (readonly [string, LookValue])[] | null = null
  if (hasKey(entries, 'look')) {
    const lookEntries = body.lookEntries ?? []
    const problem = lookProblem(body.lookEntries !== null, lookEntries)
    if (problem !== null) return refuse(problem)
    const pairs: (readonly [string, LookValue])[] = []
    for (const [k, v] of lookEntries) pairs.push([k, lookValue(v)])
    look = pairs
  }
  return { ok: true, patch: { title, camera, cameraSource, look } }
}

/** Whether a patch stamps `saved` (v1: unless only the title came). */
export function stampsSaved(patch: ScenePatch): boolean {
  return patch.camera !== null || patch.cameraSource !== null || patch.look !== null
}
