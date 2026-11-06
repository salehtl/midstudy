// scene.json's `look` (contract §4.8): v1's LOOK_RANGE, LOOK_BOOL and LOOK_HELP, the checks of PUT /api/scenes/<name>
// and how a look patch merges (numbers clamped, booleans as given, null removes a key). Pure (TScert).
//
// v1 clamps light_azimuth_deg to −180…180 like every other number (270 → 180); the planner wraps an azimuth into
// that range before it sends it, so the server never sees one outside it from the planner. Kept as v1.
import { pyRound } from '../../../../common/logic/pyfmt.ts'
import { isNum, sortedStrings } from './values.ts'

/** A look number's range. */
interface Range {
  readonly lo: number
  readonly hi: number
}

/** v1 LOOK_RANGE, in its order. */
const LOOK_RANGES: ReadonlyMap<string, Range> = new Map([
  ['exposure', { lo: 0.25, hi: 4 }],
  ['warmth', { lo: -1, hi: 1 }],
  ['light_azimuth_deg', { lo: -180, hi: 180 }],
  ['light_elevation_deg', { lo: 5, hi: 90 }],
  ['light_softness', { lo: 0, hi: 1 }],
  ['light_strength', { lo: 0, hi: 3 }],
  ['ambient', { lo: 0, hi: 3 }],
])

/** v1 LOOK_BOOL. */
const LOOK_BOOLS: ReadonlySet<string> = new Set(['contact_shadows', 'auto_light', 'cast_shadows'])

/** v1 LOOK_HELP: every look refusal ends with it. */
export const LOOK_HELP = 'look takes exposure (0.25 to 4), warmth (-1 to 1), light_azimuth_deg (-180 to 180), light_elevation_deg '
  + '(5 to 90), light_softness (0 to 1), light_strength (0 to 3) and ambient (0 to 3) as numbers, contact_shadows, '
  + 'auto_light and cast_shadows as true or false, and null for any of them to remove it'

/** A look key's value as a patch carries it: a number, a boolean, or null (remove the key). */
export type LookValue = number | boolean | null

/** Whether `v` has the type a look key takes (v1: a boolean never passes as a number, nor 0/1 as a boolean). */
function rightType(key: string, v: unknown): boolean {
  if (v === null) return true
  if (LOOK_RANGES.has(key)) return isNum(v)
  return typeof v === 'boolean'
}

/** v1's refusal of a `look` value in PUT /api/scenes/<name> (400), or null when it may be applied. `entries` are the
 *  look object's entries; `isObject` is false when `look` wasn't a JSON object. */
export function lookProblem(isObject: boolean, entries: readonly (readonly [string, unknown])[]): string | null {
  if (!isObject) return 'look must be an object: ' + LOOK_HELP
  const unknown = entries.map(([k]) => k).filter((k) => !LOOK_RANGES.has(k) && !LOOK_BOOLS.has(k))
  if (unknown.length > 0) return 'look has unknown keys (' + sortedStrings([...new Set(unknown)]).join(', ') + '): ' + LOOK_HELP
  const wrong = entries.filter(([k, v]) => !rightType(k, v)).map(([k]) => k)
  if (wrong.length > 0) return 'look ' + sortedStrings([...new Set(wrong)]).join(', ') + ' has the wrong type: ' + LOOK_HELP
  return null
}

/** A checked look value as v1 stores it: a number clamped to its range and rounded to 6 places, a boolean as is. */
function storedValue(key: string, v: number | boolean): number | boolean {
  const range = LOOK_RANGES.get(key)
  if (range === undefined || typeof v === 'boolean') return v
  return pyRound(Math.min(range.hi, Math.max(range.lo, v)), 6)
}

/** v1 `update`'s look merge: the current look's entries (in their order), then each patch entry in order: null removes
 *  the key, a number is clamped, a boolean set; a new key goes last. `current` is empty when scene.json has no look
 *  object. The patch was checked by lookProblem. */
export function mergeLook(current: readonly (readonly [string, unknown])[], patch: readonly (readonly [string, LookValue])[]): (readonly [string, unknown])[] {
  const out = new Map<string, unknown>()
  for (const [k, v] of current) out.set(k, v)
  for (const [k, v] of patch) {
    if (v === null) out.delete(k)
    else out.set(k, storedValue(k, v))
  }
  return [...out.entries()]
}
