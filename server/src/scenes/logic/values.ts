// Python's view of JSON values and text, as v1's scene, layout and render handlers judged them (planner/serve.py
// `is_num`, `isinstance(v, dict)`, truthiness, `str(v)`, `sorted(...)`, `len(s)`, `" ".join(s.split())`). Pure
// (TScert): no Node, no DOM.
import { pyFloatRepr, pyRepr } from '../../../../common/logic/pyfmt.ts'

/** v1 `is_num`: an int or float that isn't a bool and is finite (JSON `true` is never a number). */
export function isNum(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** `isinstance(v, dict)` for a parsed JSON value: an object that isn't an array (or null). TScert can't prove the
 *  predicate from the checks (docs/notes/server-scenes.md); its callers are certified against this signature. */
export function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** Python's `bool(v)` of a parsed JSON value: false for null, false, 0, '', [] and {} (NaN is true). */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return v !== ''
  if (Array.isArray(v)) return v.length > 0
  if (isRecord(v)) return Object.keys(v).length > 0
  return true
}

/** Python's text of a JSON number: an integral value as an int (JSON can't tell `5` from `5.0` once parsed), any other
 *  as `repr(float)`. */
function numberText(n: number): string {
  return Number.isInteger(n) ? BigInt(n).toString() : pyFloatRepr(n)
}

/** Python's `repr(v)` of a parsed JSON value (inside a list or dict). */
function pyValueRepr(v: unknown): string {
  if (typeof v === 'string') return pyRepr(v)
  return pyStr(v)
}

/** Python's `str(v)` of a parsed JSON value: a string as it is, `None`, `True`, `False`, numbers as Python prints them,
 *  lists and dicts as their repr. */
export function pyStr(v: unknown): string {
  if (typeof v === 'string') return v
  if (v === null || v === undefined) return 'None'
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (typeof v === 'number') return numberText(v)
  if (Array.isArray(v)) return '[' + v.map((x: unknown) => pyValueRepr(x)).join(', ') + ']'
  if (isRecord(v)) return '{' + Object.entries(v).map(([k, x]) => pyRepr(k) + ': ' + pyValueRepr(x)).join(', ') + '}'
  return typeof v === 'bigint' ? v.toString() : ''
}

/** A UTF-16 code unit moved so that code-unit order is code-point order (surrogates above U+FFFF's BMP tail). */
function orderUnit(c: number): number {
  if (c >= 0xd800 && c <= 0xdfff) return c + 0x2000
  if (c >= 0xe000) return c - 0x800
  return c
}

/** Python's `str` comparison (by code point): -1, 0 or 1. JavaScript's `<` compares UTF-16 code units, which puts
 *  U+E000–U+FFFF above every character outside the BMP. */
export function cmpCodePoints(a: string, b: string): number {
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = orderUnit(a.charCodeAt(i))
    const y = orderUnit(b.charCodeAt(i))
    if (x !== y) return x < y ? -1 : 1
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/** Python's `sorted(strings)`: a sorted copy, by code point. */
export function sortedStrings(xs: readonly string[]): string[] {
  return [...xs].sort(cmpCodePoints)
}

/** Python's `len(s)`: code points (a character outside the BMP is one, not two). */
export function codePointLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c >= 0xdc00 && c <= 0xdfff && i > 0) {
      const p = s.charCodeAt(i - 1)
      if (p >= 0xd800 && p <= 0xdbff) continue
    }
    n += 1
  }
  return n
}

/** Python's `s[:n]` for a string: the first `n` code points. */
export function codePointPrefix(s: string, n: number): string {
  let count = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const low = c >= 0xdc00 && c <= 0xdfff && i > 0 && s.charCodeAt(i - 1) >= 0xd800 && s.charCodeAt(i - 1) <= 0xdbff
    if (!low) {
      if (count === n) return s.slice(0, i)
      count += 1
    }
  }
  return s
}

// Python's str.isspace() characters (Unicode White_Space with bidi WS/B/S, and Zs), as common/logic/pyfmt.ts pyStrip.
const PY_SPACES = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/

/** Python's `" ".join(s.split())`: every run of Python whitespace one space, none at either end. */
export function collapseSpaces(s: string): string {
  return s.split(PY_SPACES).filter((w) => w !== '').join(' ')
}
