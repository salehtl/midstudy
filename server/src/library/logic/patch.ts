// PATCH /api/library/items/<id> (contract §2.8, §4.5 Shows as; v1 planner/serve.py `patch_library_item`): the body's
// shape, each field's rule in v1's order with its sentence, what changes in place, and whether midstudy-add must refit
// the item (new dims_cm, or a turn). Pure (TScert); the route reads the item and writes library.json.
import { pyStrip } from '../../../../common/logic/pyfmt.ts'
import { checkDims, sameNumber, type Checked, type CheckedDims } from './meta.ts'
import { inNumbers, numberOf, pySorted, pyTruthy, type PyValue } from './pyvalue.ts'

/** The keys a PATCH may carry. */
const PATCH_KEYS: readonly string[] = ['name', 'category', 'mount', 'yaw', 'default_render', 'dims_cm']
const PATCH_SHAPE = 'the body must be a JSON object with any of name, category, mount, yaw, default_render, dims_cm'
const YAW_RELATIVE = 'yaw must be 0, 90, 180 or 270 (degrees, relative to now)'
const YAWS: readonly number[] = [0, 90, 180, 270]

/** The keys set in place, in v1's order. */
type PatchKey = 'name' | 'category' | 'mount' | 'default_render'
const SET_KEYS: readonly PatchKey[] = ['name', 'category', 'mount', 'default_render']

/** What the item has, as v1 tested it (Python truthiness of `assets.get(…)`, `source.get("engine") == "idol"`). */
export interface ItemFacts {
  /** `assets.splat` or `assets.spz` is truthy. */
  readonly hasSplat: boolean
  /** `assets.glb` is truthy. */
  readonly hasGlb: boolean
  /** `source.engine` is `idol` (its model.glb is a stand-in box, §4.5 Shows as). */
  readonly idol: boolean
}

/** One key set in place: the value as v1 stored it (text stripped). */
interface PatchSet {
  readonly key: PatchKey
  readonly value: string | null
}

/** A valid PATCH: what to set, the turn (0 for none) and the new dims (null for none). */
export interface PatchPlan {
  readonly sets: readonly PatchSet[]
  readonly yaw: number
  readonly dims: CheckedDims | null
}

/** The body's shape (v1, before the lock): a non-empty object with only PATCH_KEYS; the unknown keys are named sorted. */
export function patchShape(body: PyValue): Checked<ReadonlyMap<string, PyValue>> {
  if (body.kind !== 'dict' || body.entries.size === 0) return { ok: false, error: PATCH_SHAPE }
  const keys: string[] = []
  for (const [key] of body.entries.entries()) if (!PATCH_KEYS.includes(key)) keys.push(key)
  const unknown = pySorted(keys)
  if (unknown.length > 0) return { ok: false, error: unknown.join(', ') + " can't be edited: use name, category, mount, yaw, default_render or dims_cm" }
  return { ok: true, value: body.entries }
}

/** default_render's rule: glb or splat, an asset the item has, and never an Idol piece's stand-in box. */
function defaultRenderProblem(v: PyValue, facts: ItemFacts): string | null {
  if (v.kind !== 'str' || (v.value !== 'glb' && v.value !== 'splat')) return 'default_render must be glb or splat'
  const has = v.value === 'splat' ? facts.hasSplat : facts.hasGlb
  if (!has) return 'this item has no ' + v.value + " asset, so it can't be its default render"
  if (v.value === 'glb' && facts.idol) return 'an Idol piece has no mesh to show: its model.glb is a stand-in box'
  return null
}

/** The first rule a field breaks, in v1's order (name, category, mount, default_render), or null. */
function fieldProblem(patch: ReadonlyMap<string, PyValue>, facts: ItemFacts): string | null {
  const name = patch.get('name')
  if (name !== undefined && (name.kind !== 'str' || pyStrip(name.value) === '')) return 'name must be non-empty text'
  const category = patch.get('category')
  if (category !== undefined && category.kind !== 'none' && category.kind !== 'str') return 'category must be text or null'
  const mount = patch.get('mount')
  if (mount !== undefined && (mount.kind !== 'str' || (mount.value !== 'floor' && mount.value !== 'wall'))) return 'mount must be floor or wall'
  const render = patch.get('default_render')
  return render === undefined ? null : defaultRenderProblem(render, facts)
}

/** The value v1 stored for a key it validated: text stripped, null kept. */
function storedValue(v: PyValue): string | null {
  return v.kind === 'str' ? pyStrip(v.value) : null
}

/** Every key the patch sets, in v1's order. */
function setsOf(patch: ReadonlyMap<string, PyValue>): PatchSet[] {
  const sets: PatchSet[] = []
  for (const key of SET_KEYS) {
    const v = patch.get(key)
    if (v !== undefined) sets.push({ key, value: storedValue(v) })
  }
  return sets
}

/** v1's checks of a PATCH against the item (inside the lock): the plan, or the first broken rule's sentence. yaw is
 *  `patch.get("yaw", 0) or 0`, so any falsy value is no turn. */
export function checkPatch(patch: ReadonlyMap<string, PyValue>, facts: ItemFacts): Checked<PatchPlan> {
  const problem = fieldProblem(patch, facts)
  if (problem !== null) return { ok: false, error: problem }
  const yawV = patch.get('yaw')
  let yaw = 0
  if (yawV !== undefined && pyTruthy(yawV)) {
    if (yawV.kind === 'bool' || !inNumbers(yawV, YAWS)) return { ok: false, error: YAW_RELATIVE }
    yaw = sameNumber(numberOf(yawV), YAWS, 0)
  }
  let dims: CheckedDims | null = null
  if (patch.has('dims_cm')) {
    const checked = checkDims(patch.get('dims_cm'))
    if (!checked.ok) return { ok: false, error: checked.error }
    dims = checked.value
  }
  return { ok: true, value: { sets: setsOf(patch), yaw, dims } }
}

/** Whether midstudy-add must refit the item: a turn, or dims that differ from the item's (each compared as a float;
 *  a missing one counts as 0). */
export function needsRefit(plan: PatchPlan, current: { readonly w: number; readonly d: number; readonly h: number }): boolean {
  if (plan.yaw !== 0) return true
  const dims = plan.dims
  if (dims === null) return false
  return dims.w !== current.w || dims.d !== current.d || dims.h !== current.h
}
