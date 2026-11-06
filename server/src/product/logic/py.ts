// Python's view of JSON values (pyjson.ts), as v1's product reader tested and printed them: truthiness, `str()`
// (with `repr` inside lists and dicts), `isinstance`, `_as_list`, `dict.get`. Pure (TScert).
import { pyFloatRepr, pyRepr } from '../../../../common/logic/pyfmt.ts'
import type { PyValue } from './pyjson.ts'

/** A JSON object (a Python dict). */
export type PyDict = ReadonlyMap<string, PyValue>

/** `isinstance(v, dict)`. */
export function isDict(v: PyValue | undefined): v is PyDict {
  return v instanceof Map
}

/** `isinstance(v, list)`. */
export function isList(v: PyValue | undefined): v is readonly PyValue[] {
  return Array.isArray(v)
}

/** `isinstance(v, (int, float)) and not isinstance(v, bool)`. */
export function isNumber(v: PyValue | undefined): v is bigint | number {
  return typeof v === 'bigint' || typeof v === 'number'
}

/** `float(v)` of an int or float. */
export function toFloat(v: bigint | number): number {
  return typeof v === 'bigint' ? Number(v) : v
}

/** `d.get(key)`: undefined when the key is missing (Python's None either way, unless the code asks `key in d`). */
export function get(d: PyValue | undefined, key: string): PyValue | undefined {
  return isDict(d) ? d.get(key) : undefined
}

/** `key in d` for a dict. */
export function has(d: PyValue | undefined, key: string): boolean {
  return isDict(d) && d.has(key)
}

/** Python's truthiness (a NaN is true, 0 and 0.0 are false, empty strings, lists and dicts are false). */
export function truthy(v: PyValue | undefined): boolean {
  if (v === undefined || v === null || v === false) return false
  if (v === true) return true
  if (typeof v === 'bigint') return v !== 0n
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== ''
  if (isList(v)) return v.length > 0
  return v.size > 0
}

/** Python's `a or b`. */
export function or(a: PyValue | undefined, b: PyValue | undefined): PyValue | undefined {
  return truthy(a) ? a : b
}

/** v1's `_as_list`: None is [], a list is itself, anything else a list of one. */
export function asList(v: PyValue | undefined): readonly PyValue[] {
  if (v === undefined || v === null) return []
  if (isList(v)) return v
  return [v]
}

/** Python's `repr` of a JSON value (what `str()` prints inside a list or dict). */
export function pyReprValue(v: PyValue | undefined): string {
  if (v === undefined || v === null) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'bigint') return v.toString()
  if (typeof v === 'number') return pyFloatRepr(v)
  if (typeof v === 'string') return pyRepr(v)
  if (isList(v)) return '[' + v.map(pyReprValue).join(', ') + ']'
  const parts: string[] = []
  for (const [k, x] of v.entries()) parts.push(pyRepr(k) + ': ' + pyReprValue(x))
  return '{' + parts.join(', ') + '}'
}

/** Python's `str(v)`. */
export function pyStr(v: PyValue | undefined): string {
  return typeof v === 'string' ? v : pyReprValue(v)
}
