// A JSON value as v1 saw it: planner/serve.py validated the library's request bodies and X-Midstudy-Meta with
// Python's json module, so a number stays an int or a float as it was written (`repr()` prints `45` or `45.0`), `in`
// compares numbers by value, and truthiness is Python's (`[]` and `{}` are false). The shell
// (server/src/library/json.ts) builds these values; everything here is pure (TScert, tscert/README.md).
import { pyFloatRepr, pyRepr } from '../../../../common/logic/pyfmt.ts'

/** A JSON value with Python's types: `int` keeps its decimal digits (Python's ints are exact), `dict` its key order. */
export type PyValue =
  | { readonly kind: 'none' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'int'; readonly value: number; readonly digits: string }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'str'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly PyValue[] }
  | { readonly kind: 'dict'; readonly entries: ReadonlyMap<string, PyValue> }

/** Python's `None`. */
export const NONE: PyValue = { kind: 'none' }

/** A Python int (from a JS integer). */
export function pyInt(value: number): PyValue {
  return { kind: 'int', value, digits: value >= 1e21 || value <= -1e21 ? BigInt(value).toString() : String(value) }
}

/** A Python str. */
export function pyStr(value: string): PyValue {
  return { kind: 'str', value }
}

/** `repr()` of the items of a list, joined as Python joins them. */
function reprItems(items: readonly PyValue[]): string {
  let out = ''
  for (const item of items) out += (out === '' ? '' : ', ') + pyValueRepr(item)
  return out
}

/** `repr()` of the entries of a dict, joined as Python joins them. */
function reprEntries(entries: ReadonlyMap<string, PyValue>): string {
  let out = ''
  for (const [key, value] of entries.entries()) out += (out === '' ? '' : ', ') + pyRepr(key) + ': ' + pyValueRepr(value)
  return out
}

/** Python's `repr()` (what v1's `{value!r}` printed in its 400 sentences): `None`, `True`, `45`, `45.0`, `'text'`,
 *  `[1, 2]`, `{'a': 1}`. */
export function pyValueRepr(v: PyValue): string {
  switch (v.kind) {
    case 'none': return 'None'
    case 'bool': return v.value ? 'True' : 'False'
    case 'int': return v.digits
    case 'float': return pyFloatRepr(v.value)
    case 'str': return pyRepr(v.value)
    case 'list': return '[' + reprItems(v.items) + ']'
    case 'dict': return '{' + reprEntries(v.entries) + '}'
  }
}

/** Python's truthiness: `None`, `False`, `0`, `0.0`, `''`, `[]` and `{}` are false (a NaN float is true). */
export function pyTruthy(v: PyValue): boolean {
  switch (v.kind) {
    case 'none': return false
    case 'bool': return v.value
    case 'int': return v.value !== 0
    case 'float': return v.value !== 0
    case 'str': return v.value !== ''
    case 'list': return v.items.length > 0
    case 'dict': return v.entries.size > 0
  }
}

/** The number of an int or a float (a bool is not one here: v1 always refused bools before comparing). */
export function numberOf(v: PyValue): number | null {
  if (v.kind === 'int' || v.kind === 'float') return v.value
  return null
}

/** Python's `v in (a, b, …)` for a tuple of numbers: an int, float or bool equal to one of them by value. */
export function inNumbers(v: PyValue, allowed: readonly number[]): boolean {
  const n = v.kind === 'bool' ? (v.value ? 1 : 0) : numberOf(v)
  if (n === null) return false
  return allowed.includes(n)
}

/** Python's `v in (None, "")`, with a missing key read as `None` (`dict.get`). */
export function noneOrEmpty(v: PyValue | undefined): boolean {
  if (v === undefined) return true
  return v.kind === 'none' || (v.kind === 'str' && v.value === '')
}

/** The text of a str, else null. */
export function textOf(v: PyValue | undefined): string | null {
  if (v?.kind !== 'str') return null
  return v.value
}

/** `dict.get(key)` (undefined when missing) of a dict; undefined for anything else. */
export function dictGet(d: PyValue, key: string): PyValue | undefined {
  if (d.kind !== 'dict') return undefined
  return d.entries.get(key)
}

/** A UTF-16 code unit moved so that comparing units gives code point order (surrogates after U+E000–U+FFFF). */
function codePointOrder(unit: number): number {
  if (unit >= 0xd800 && unit <= 0xdfff) return unit + 0x2000
  if (unit >= 0xe000) return unit - 0x800
  return unit
}

/** Python's ordering of two str (by code point; JS's `<` compares UTF-16 units, which differs above U+FFFF):
 *  negative, 0 or positive. */
export function pyCompare(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = codePointOrder(a.charCodeAt(i))
    const y = codePointOrder(b.charCodeAt(i))
    if (x !== y) return x < y ? -1 : 1
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

/** `sorted(keys)` (Python's code point order). */
export function pySorted(keys: readonly string[]): string[] {
  return [...keys].sort(pyCompare)
}
