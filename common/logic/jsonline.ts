// One JSON value as Python's `json.dumps(value)` writes it with its defaults: `", "` and `": "` between items,
// `ensure_ascii` (every character outside space…`~` escaped, `\u` with lower-case hex, astral ones as surrogate
// pairs), NaN and ±Infinity as `NaN` / `Infinity`, keys in insertion order. For the fal request log
// (MIDSTUDY_FAL_MOCK_LOG), whose lines v1's tools wrote this way. Integral numbers print as ints and others as
// Python's float repr (an integral float can't be told from an int in JavaScript). Pure (TScert).
import { pyFloatRepr } from './pyfmt.ts'

/** A JSON-able value. */
export type JsonLineValue = null | boolean | number | string | readonly JsonLineValue[] | { readonly [key: string]: JsonLineValue }

const NAMED: Readonly<Record<string, string>> = { '"': '\\"', '\\': '\\\\', '\b': '\\b', '\f': '\\f', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** A string as `json.dumps` (ensure_ascii) quotes it. */
function jsonString(s: string): string {
  let out = '"'
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charAt(i)
    const named = NAMED[c]
    if (named !== undefined) {
      out += named
      continue
    }
    const code = s.charCodeAt(i)
    out += code >= 0x20 && code <= 0x7e ? c : '\\u' + code.toString(16).padStart(4, '0')
  }
  return out + '"'
}

/** A number as `json.dumps` writes it. */
function jsonNumber(n: number): string {
  if (Number.isNaN(n)) return 'NaN'
  if (n === Infinity) return 'Infinity'
  if (n === -Infinity) return '-Infinity'
  if (Number.isInteger(n) && Math.abs(n) < 2 ** 53) return String(n)
  return pyFloatRepr(n)
}

/** Whether a JSON value is a list (Array.isArray, typed for a readonly list). */
function isList(value: JsonLineValue): value is readonly JsonLineValue[] {
  return Array.isArray(value)
}

/** `json.dumps(value)`. */
export function jsonLine(value: JsonLineValue): string {
  if (value === null) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return jsonNumber(value)
  if (typeof value === 'string') return jsonString(value)
  if (isList(value)) {
    const items: string[] = []
    for (const v of value) items.push(jsonLine(v))
    return '[' + items.join(', ') + ']'
  }
  const entries: string[] = []
  for (const [k, v] of Object.entries(value)) entries.push(jsonString(k) + ': ' + jsonLine(v))
  return '{' + entries.join(', ') + '}'
}
