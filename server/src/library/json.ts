// JSON as the library needs it. Two concerns v1 got from Python for free:
//
// - library.json and entry.json keep every number as it was written. midstudy-add (Python) writes `80.0` and `1e-05`;
//   JavaScript would write them back as `80` and `0.00001`. Python reads `80` as an int and `80.0` as a float, so a
//   rewrite would change the entry (E7's L9 "restore brings the item back byte for byte" compares them with Python),
//   and the tracked library/library.json would show diffs nobody made. parseDocument() keeps each number whose
//   JavaScript spelling differs from the file's as a raw JSON text (ES2026 `JSON.rawJSON`, in Node 22), which
//   JSON.stringify writes back unchanged; plain() turns those back into numbers for answers and schema checks.
// - request values keep Python's types (server/src/library/logic/pyvalue.ts): the X-Midstudy-Meta header's JSON is
//   read with each number's own spelling (an int or a float, as Python's json module would), a JSON body parsed by
//   RequestContext.readJson() with integral numbers as ints.
import { pyFloatRepr } from '../../../common/logic/pyfmt.ts'
import { pyInt, type PyValue } from './logic/pyvalue.ts'

const RAW_JSON: unknown = Reflect.get(JSON, 'rawJSON')
const IS_RAW_JSON: unknown = Reflect.get(JSON, 'isRawJSON')

/** A plain object (not an array, not null, not a raw JSON number). */
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && !isRaw(v)
}

/** A raw JSON text made by parseDocument. */
function isRaw(v: unknown): boolean {
  return typeof IS_RAW_JSON === 'function' && Reflect.apply(IS_RAW_JSON, JSON, [v]) === true
}

/** The text of a raw JSON value, or null. */
function rawText(v: unknown): string | null {
  if (!isRaw(v)) return null
  const text: unknown = Reflect.get(Object(v), 'rawJSON')
  return typeof text === 'string' ? text : null
}

/** The source text JSON.parse's reviver gets for a primitive (ES2026 source text access), or null. */
function sourceOf(context: unknown): string | null {
  if (typeof context !== 'object' || context === null) return null
  const source: unknown = Reflect.get(context, 'source')
  return typeof source === 'string' ? source : null
}

/** The reviver of parseDocument: a number JSON.stringify would spell differently becomes a raw JSON text. */
function keepSpelling(_key: string, value: unknown, context?: unknown): unknown {
  if (typeof value !== 'number' || typeof RAW_JSON !== 'function') return value
  const source = sourceOf(context)
  if (source === null || JSON.stringify(value) === source) return value
  const raw: unknown = Reflect.apply(RAW_JSON, JSON, [source])
  return raw
}

/** A JSON file's text with every number as it was spelled (see above). Throws SyntaxError as JSON.parse does. */
export function parseDocument(text: string): unknown {
  const value: unknown = JSON.parse(text, keepSpelling)
  return value
}

/** A copy of a parsed document with raw numbers as numbers: what answers and schema checks see. */
export function plain(v: unknown): unknown {
  const text = rawText(v)
  if (text !== null) return Number(text)
  if (Array.isArray(v)) return v.map((x: unknown) => plain(x))
  if (isRecord(v)) {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) Object.defineProperty(out, k, { value: plain(x), enumerable: true, writable: true, configurable: true })
    return out
  }
  return v
}

/** Python's truthiness of a parsed JSON value (`[]`, `{}`, `''`, `0`, `null` and `false` are false). */
export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0
  if (isRecord(v)) return Object.keys(v).length > 0
  const text = rawText(v)
  if (text !== null) return Number(text) !== 0
  return Boolean(v)
}

/** Python's type name of a parsed JSON value (for v1's AttributeError sentences). */
export function pyTypeName(v: unknown): string {
  if (v === null || v === undefined) return 'NoneType'
  if (typeof v === 'boolean') return 'bool'
  if (typeof v === 'string') return 'str'
  if (Array.isArray(v)) return 'list'
  const text = rawText(v)
  if (typeof v === 'number' || text !== null) {
    const spelled = text ?? JSON.stringify(v)
    return /[.eE]/.test(spelled) ? 'float' : 'int'
  }
  return 'dict'
}

/** A JSON value as Python's json module reads it, from JSON.parse's result: an integral number is an int (the
 *  spelling is gone), any other a float. */
export function pyValue(v: unknown): PyValue {
  if (v === null || v === undefined) return { kind: 'none' }
  if (typeof v === 'boolean') return { kind: 'bool', value: v }
  if (typeof v === 'string') return { kind: 'str', value: v }
  if (typeof v === 'number') return Number.isInteger(v) ? pyInt(v) : { kind: 'float', value: v }
  if (Array.isArray(v)) return { kind: 'list', items: v.map((x: unknown) => pyValue(x)) }
  const entries = new Map<string, PyValue>()
  if (isRecord(v)) for (const [k, x] of Object.entries(v)) entries.set(k, pyValue(x))
  return { kind: 'dict', entries }
}

/** A number token with its spelling (the reviver of pyValueFromText). */
class NumberToken {
  readonly value: number
  readonly text: string
  constructor(value: number, text: string) {
    this.value = value
    this.text = text
  }
}

function tokenize(_key: string, value: unknown, context?: unknown): unknown {
  if (typeof value !== 'number') return value
  return new NumberToken(value, sourceOf(context) ?? JSON.stringify(value))
}

function fromTokens(v: unknown): PyValue {
  if (v instanceof NumberToken) {
    if (/[.eE]/.test(v.text)) return { kind: 'float', value: v.value }
    return { kind: 'int', value: v.value, digits: v.text === '-0' ? '0' : v.text }
  }
  if (Array.isArray(v)) return { kind: 'list', items: v.map((x: unknown) => fromTokens(x)) }
  if (isRecord(v)) {
    const entries = new Map<string, PyValue>()
    for (const [k, x] of Object.entries(v)) entries.set(k, fromTokens(x))
    return { kind: 'dict', entries }
  }
  return pyValue(v)
}

/** JSON nested deeper than Python's json module reads (its recursion limit): v1 failed on it. */
function nestedTooDeep(text: string, limit = 990): boolean {
  let depth = 0
  let inString = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (inString) {
      if (c === 92) i += 1
      else if (c === 34) inString = false
      continue
    }
    if (c === 34) inString = true
    else if (c === 91 || c === 123) {
      depth += 1
      if (depth > limit) return true
    } else if (c === 93 || c === 125) depth -= 1
  }
  return false
}

/** JSON text as Python's json.loads reads it, every number an int or a float as spelled; null when it isn't JSON (or
 *  is nested too deeply to read). */
export function pyValueFromText(text: string): PyValue | null {
  if (nestedTooDeep(text)) return null
  let tree: unknown
  try {
    tree = JSON.parse(text, tokenize)
  } catch {
    return null
  }
  return fromTokens(tree)
}

/** Python's `str()` of a parsed JSON value, as v1 sorted the trash by `str(deleted)` (a string is itself). */
export function pyStrOf(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'boolean') return v ? 'True' : 'False'
  const text = rawText(v)
  if (typeof v === 'number' || text !== null) {
    const n = typeof v === 'number' ? v : Number(text)
    return pyTypeName(v) === 'float' ? pyFloatRepr(n) : String(n)
  }
  return JSON.stringify(plain(v))
}
