// An add's meta (contract §2.8 Meta; v1 planner/serve.py `check_dims`, `check_meta`, `ENGINE_PRICE`, `add_command`):
// validated with v1's Python semantics and its exact sentences, then turned into midstudy-add's argument list. Pure
// (TScert).
import { numText, pyRepr, pyStrip } from '../../../../common/logic/pyfmt.ts'
import { isSlug, slugify } from '../../../../common/logic/slug.ts'
import { dictGet, inNumbers, noneOrEmpty, numberOf, pyTruthy, pyValueRepr, type PyValue } from './pyvalue.ts'

/** A validation's result: the value, or v1's one sentence (a 400). */
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: string }

/** The image engines (§3.2), idol the default. */
export type ImageEngine = 'idol' | 'sam3d' | 'trellis2' | 'rug'
/** Every engine a job can name: a model upload is `glb`. */
export type Engine = ImageEngine | 'glb'
/** What an upload is (X-Midstudy-Kind). */
export type UploadKind = 'model' | 'image'

/** dims_cm in centimetres, each as v1 kept it for `--dims` (`num_text`: `80`, `80.5`). */
export interface CheckedDims {
  readonly w: number
  readonly d: number
  readonly h: number
  /** The `--dims=` value: `<w>x<d>x<h>`. */
  readonly arg: string
}

/** A validated meta (v1 `check_meta`'s dict), with the id and engine filled in. */
export interface AddMeta {
  /** Stripped. */
  readonly name: string
  readonly dims: CheckedDims
  readonly id: string
  /** Stripped, or null when missing or blank. */
  readonly category: string | null
  /** Stripped, or null when missing or blank. */
  readonly prompt: string | null
  readonly mount: 'floor' | 'wall' | null
  readonly yaw: number
  readonly engine: Engine
  readonly resolution: number
  /** The engine's price (§3.2): what the add reserves against the cap. */
  readonly estimate: number
}

/** v1's `check_dims` sentence. */
export const DIMS_REQUIRED = 'dims_cm is required: {"w": ..., "d": ..., "h": ...} in cm, all greater than 0'
const NAME_REQUIRED = 'name is required, e.g. "Reading chair"'
const META_OBJECT = 'the meta must be a JSON object with at least name and dims_cm'
const YAWS: readonly number[] = [0, 90, 180, 270]
const RESOLUTIONS: readonly number[] = [512, 1024, 1536]

function fail<T>(error: string): Checked<T> {
  return { ok: false, error }
}

/** One dimension: an int or float (never a bool) above 0. */
function positive(v: PyValue | undefined): number | null {
  if (v === undefined) return null
  const n = numberOf(v)
  return n !== null && n > 0 ? n : null
}

/** v1 `num_text` of a dimension: an int's own digits, a float's integral value without `.0`, else its repr. */
function dimText(v: PyValue | undefined, n: number): string {
  if (v?.kind === 'int') return v.digits
  return numText(n)
}

/** v1 `check_dims`: `{w, d, h}`, each a number above 0. */
export function checkDims(dims: PyValue | undefined): Checked<CheckedDims> {
  if (dims?.kind !== 'dict') return fail(DIMS_REQUIRED)
  const wv = dictGet(dims, 'w')
  const dv = dictGet(dims, 'd')
  const hv = dictGet(dims, 'h')
  const w = positive(wv)
  const d = positive(dv)
  const h = positive(hv)
  if (w === null || d === null || h === null) return fail(DIMS_REQUIRED)
  return { ok: true, value: { w, d, h, arg: dimText(wv, w) + 'x' + dimText(dv, d) + 'x' + dimText(hv, h) } }
}

/** Whether a text names an image engine. */
export function isImageEngine(s: string): s is ImageEngine {
  return s === 'idol' || s === 'sam3d' || s === 'trellis2' || s === 'rug'
}

/** v1 `ENGINE_PRICE`: idol $0.10, sam3d $0.02, trellis2 $0.25/$0.30/$0.35 by resolution, glb and rug $0. */
export function enginePrice(engine: Engine, resolution: number): number {
  switch (engine) {
    case 'idol': return 0.1
    case 'sam3d': return 0.02
    case 'trellis2': return resolution === 1024 ? 0.3 : resolution === 1536 ? 0.35 : 0.25
    case 'glb': return 0
    case 'rug': return 0
  }
}

/** category or prompt: text (stripped, null when blank) or missing/null; anything else is v1's "<key> must be text". */
function optionalText(v: PyValue | undefined, key: string): Checked<string | null> {
  if (v === undefined || v.kind === 'none') return { ok: true, value: null }
  if (v.kind !== 'str') return fail(key + ' must be text')
  const s = pyStrip(v.value)
  return { ok: true, value: s === '' ? null : s }
}

/** mount: floor, wall, or missing/null. */
function mountOf(v: PyValue | undefined): Checked<'floor' | 'wall' | null> {
  if (v === undefined || v.kind === 'none') return { ok: true, value: null }
  if (v.kind === 'str' && v.value === 'floor') return { ok: true, value: 'floor' }
  if (v.kind === 'str' && v.value === 'wall') return { ok: true, value: 'wall' }
  return fail('mount must be floor or wall, got ' + pyValueRepr(v))
}

/** One of `allowed` (by value, never a bool), with `None`, `""` and a missing key meaning `fallback`. */
function choice(v: PyValue | undefined, allowed: readonly number[], fallback: number): number | PyValue {
  if (v === undefined || noneOrEmpty(v)) return fallback
  if (v.kind === 'bool' || !inNumbers(v, allowed)) return v
  return sameNumber(numberOf(v), allowed, fallback)
}

/** The element of `allowed` equal to `n` (v1's `int(v)`: `90.0` is 90, `-0.0` is 0), else `fallback`. */
export function sameNumber(n: number | null, allowed: readonly number[], fallback: number): number {
  for (const a of allowed) if (a === n) return a
  return fallback
}

/** The engine: a model's is glb (any other but None or "" is v1's 400); an image's is idol when missing or falsy. */
function engineOf(v: PyValue | undefined, kind: UploadKind): Checked<Engine> {
  if (kind === 'model') {
    if (v === undefined || noneOrEmpty(v) || (v.kind === 'str' && v.value === 'glb')) return { ok: true, value: 'glb' }
    return fail('engine must be glb for a 3D model (or left out), got ' + pyValueRepr(v))
  }
  if (v === undefined || !pyTruthy(v)) return { ok: true, value: 'idol' }
  if (v.kind === 'str' && isImageEngine(v.value)) return { ok: true, value: v.value }
  return fail('engine must be idol, sam3d, trellis2 or rug for an image, got ' + pyValueRepr(v))
}

/** v1 `check_meta`: the validated meta of an add, or the first rule it breaks in v1's order (name, dims_cm, id,
 *  category, prompt, mount, yaw, engine, resolution) with v1's sentence. */
export function checkMeta(meta: PyValue, kind: UploadKind): Checked<AddMeta> {
  if (meta.kind !== 'dict') return fail(META_OBJECT)
  const nameV = dictGet(meta, 'name')
  if (nameV?.kind !== 'str' || pyStrip(nameV.value) === '') return fail(NAME_REQUIRED)
  const dims = checkDims(dictGet(meta, 'dims_cm'))
  if (!dims.ok) return fail(dims.error)
  const idV = dictGet(meta, 'id')
  let id: string
  if (idV === undefined || noneOrEmpty(idV)) {
    id = slugify(nameV.value)
    if (!isSlug(id)) return fail("can't make an id from the name " + pyRepr(nameV.value) + ': add an id like "reading-chair"')
  } else if (idV.kind === 'str' && isSlug(idV.value)) {
    id = idV.value
  } else {
    return fail('id must be a slug (lowercase letters, digits and dashes, up to 64), got ' + pyValueRepr(idV))
  }
  const category = optionalText(dictGet(meta, 'category'), 'category')
  if (!category.ok) return fail(category.error)
  const prompt = optionalText(dictGet(meta, 'prompt'), 'prompt')
  if (!prompt.ok) return fail(prompt.error)
  const mount = mountOf(dictGet(meta, 'mount'))
  if (!mount.ok) return fail(mount.error)
  const yaw = choice(dictGet(meta, 'yaw'), YAWS, 0)
  if (typeof yaw !== 'number') return fail('yaw must be 0, 90, 180 or 270 (degrees), got ' + pyValueRepr(yaw))
  const engine = engineOf(dictGet(meta, 'engine'), kind)
  if (!engine.ok) return fail(engine.error)
  const resolution = choice(dictGet(meta, 'resolution'), RESOLUTIONS, 512)
  if (typeof resolution !== 'number') return fail('resolution must be 512, 1024 or 1536, got ' + pyValueRepr(resolution))
  return {
    ok: true,
    value: {
      name: pyStrip(nameV.value),
      dims: dims.value,
      id,
      category: category.value,
      prompt: prompt.value,
      mount: mount.value,
      yaw,
      engine: engine.value,
      resolution,
      estimate: enginePrice(engine.value, resolution),
    },
  }
}

/** v1 `add_command`: midstudy-add's argument list for an add. Every value is `--opt=<v>` and the input an absolute
 *  path, so a name like `-Shelf` is never read as a flag; `src` and `library` are already resolved. */
export function addArgv(base: readonly string[], src: string, library: string, label: string, m: AddMeta): string[] {
  let argv = base.concat([src, '--name=' + m.name, '--id=' + m.id, '--dims=' + m.dims.arg, '--engine=' + m.engine, '--library=' + library, '--source-input=' + label])
  if (m.category !== null) argv = argv.concat(['--category=' + m.category])
  if (m.mount !== null) argv = argv.concat(['--mount=' + m.mount])
  if (m.yaw !== 0) argv = argv.concat(['--yaw=' + String(m.yaw)])
  if (m.engine === 'sam3d' && m.prompt !== null) argv = argv.concat(['--prompt=' + m.prompt])
  if (m.engine === 'trellis2') argv = argv.concat(['--resolution=' + String(m.resolution)])
  return argv
}

/** midstudy-add's argument list for a rescale (v1 `patch_library_item`): new dims and/or a turn relative to now. */
export function rescaleArgv(base: readonly string[], itemId: string, library: string, dims: CheckedDims | null, yaw: number): string[] {
  let argv = base.concat(['--rescale=' + itemId, '--library=' + library])
  if (dims !== null) argv = argv.concat(['--dims=' + dims.arg])
  if (yaw !== 0) argv = argv.concat(['--yaw=' + String(yaw)])
  return argv
}
