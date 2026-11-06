// JSON as v1 read it (Python 3.12's `json.loads`), for the product reader's untrusted inputs: JSON-LD blocks, script
// JSON, the shops' feeds, the language model's answer. It differs from JSON.parse where v1's answers depend on it:
// integers stay integers (bigint, as Python's int: `str(8)` is "8", `str(8.0)` is "8.0"), objects keep their key order
// in a Map (no prototype keys), NaN/Infinity/-Infinity are read, `strict: false` accepts raw control characters in
// strings, and nesting deeper than Python's C recursion limit fails as v1's RecursionError did. Iterative, so a deep
// page can't overflow the stack. Pure (TScert).
import { pyStrip } from '../../../../common/logic/pyfmt.ts'

/** A JSON value as Python holds it: int as bigint, float as number, object as a key-ordered Map. */
export type PyValue = null | boolean | bigint | number | string | readonly PyValue[] | ReadonlyMap<string, PyValue>

/** The deepest nesting Python 3.12 parsed in v1's server before raising RecursionError (measured: 9997). */
const MAX_DEPTH = 9997

/** Not JSON to Python (v1 caught JSONDecodeError, ValueError and RecursionError alike). */
export class PyJsonError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PyJsonError'
  }
}

/** A container being filled: its values, or its keys and values. */
interface Frame {
  readonly list: PyValue[] | null
  readonly map: Map<string, PyValue> | null
  key: string | null
}

function isWs(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d
}

function hexValue(c: number): number {
  if (c >= 48 && c <= 57) return c - 48
  if (c >= 97 && c <= 102) return c - 87
  if (c >= 65 && c <= 70) return c - 55
  return -1
}

/** Four hex digits at `i`, or -1. */
function hex4(s: string, i: number): number {
  if (i + 4 > s.length) return -1
  let v = 0
  for (let k = 0; k < 4; k++) {
    const h = hexValue(s.charCodeAt(i + k))
    if (h < 0) return -1
    v = v * 16 + h
  }
  return v
}

/** A JSON string starting after its opening quote at `i`: [value, the index after the closing quote]. */
function readString(s: string, start: number, strict: boolean): readonly [string, number] {
  let out = ''
  let i = start
  let run = i
  for (;;) {
    if (i >= s.length) throw new PyJsonError('Unterminated string')
    const c = s.charCodeAt(i)
    if (c === 0x22) {
      out += s.slice(run, i)
      return [out, i + 1]
    }
    if (c === 0x5c) {
      out += s.slice(run, i)
      const e = s.charAt(i + 1)
      if (e === '') throw new PyJsonError('Unterminated string')
      if (e === 'u') {
        const u = hex4(s, i + 2)
        if (u < 0) throw new PyJsonError('Invalid \\uXXXX escape')
        i += 6
        // a high surrogate followed by an escaped low one is one character (Python joins them; a lone one stays)
        if (u >= 0xd800 && u <= 0xdbff && s.charAt(i) === '\\' && s.charAt(i + 1) === 'u') {
          const v = hex4(s, i + 2)
          if (v >= 0xdc00 && v <= 0xdfff) {
            out += String.fromCharCode(u, v)
            i += 6
            run = i
            continue
          }
        }
        out += String.fromCharCode(u)
        run = i
        continue
      }
      const simple = e === '"' ? '"' : e === '\\' ? '\\' : e === '/' ? '/' : e === 'b' ? '\b' : e === 'f' ? '\f' : e === 'n' ? '\n' : e === 'r' ? '\r' : e === 't' ? '\t' : null
      if (simple === null) throw new PyJsonError('Invalid \\escape')
      out += simple
      i += 2
      run = i
      continue
    }
    if (strict && c < 0x20) throw new PyJsonError('Invalid control character')
    i++
  }
}

const NUMBER = /-?(?:0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?/y

/** A number at `i` (Python's NUMBER_RE; an int without fraction or exponent): [value, end], or null. */
function readNumber(s: string, i: number): readonly [bigint | number, number] | null {
  NUMBER.lastIndex = i
  const m = NUMBER.exec(s)
  if (m === null) return null
  const text = m[0]
  const isFloat = m[1] !== undefined || m[2] !== undefined
  return [isFloat ? Number(text) : BigInt(text), i + text.length]
}

function skipWs(s: string, i: number): number {
  let j = i
  while (j < s.length && isWs(s.charCodeAt(j))) j++
  return j
}

/** A scalar at `i` (not a container): [value, end]. */
function readScalar(s: string, i: number, strict: boolean): readonly [PyValue, number] {
  const c = s.charAt(i)
  if (c === '"') return readString(s, i + 1, strict)
  if (s.startsWith('null', i)) return [null, i + 4]
  if (s.startsWith('true', i)) return [true, i + 4]
  if (s.startsWith('false', i)) return [false, i + 5]
  if (s.startsWith('NaN', i)) return [Number.NaN, i + 3]
  if (s.startsWith('Infinity', i)) return [Number.POSITIVE_INFINITY, i + 8]
  if (s.startsWith('-Infinity', i)) return [Number.NEGATIVE_INFINITY, i + 9]
  const n = readNumber(s, i)
  if (n === null) throw new PyJsonError('Expecting value')
  return n
}

function attach(frame: Frame, value: PyValue): void {
  if (frame.list !== null) {
    frame.list.push(value)
  } else if (frame.map !== null && frame.key !== null) {
    frame.map.set(frame.key, value)
    frame.key = null
  }
}

/** Python's `json.loads(text, strict=strict)`; throws PyJsonError where Python raised. */
export function pyLoads(text: string, strict: boolean): PyValue {
  if (text.startsWith('\u{feff}')) throw new PyJsonError('Unexpected UTF-8 BOM')
  const stack: Frame[] = []
  let i = skipWs(text, 0)
  let result: PyValue = null
  let done = false
  // `expect`: what may come next: a value, or (inside a container) a comma/close
  let wantValue = true
  while (!done) {
    const top = stack.at(-1)
    if (wantValue) {
      // a key first, inside an object that has none
      if (top?.map !== undefined && top.map !== null && top.key === null) {
        if (text.charAt(i) !== '"') throw new PyJsonError('Expecting property name enclosed in double quotes')
        const [key, end] = readString(text, i + 1, strict)
        i = skipWs(text, end)
        if (text.charAt(i) !== ':') throw new PyJsonError("Expecting ':' delimiter")
        i = skipWs(text, i + 1)
        top.key = key
      }
      const c = text.charAt(i)
      if (c === '[' || c === '{') {
        if (stack.length >= MAX_DEPTH) throw new PyJsonError('maximum recursion depth exceeded while decoding a JSON document')
        const frame: Frame = c === '[' ? { list: [], map: null, key: null } : { list: null, map: new Map(), key: null }
        i = skipWs(text, i + 1)
        const close = c === '[' ? ']' : '}'
        if (text.charAt(i) === close) {
          // an empty container is a finished value
          const value: PyValue = frame.list ?? frame.map ?? null
          i = skipWs(text, i + 1)
          if (top === undefined) {
            result = value
            done = true
          } else {
            attach(top, value)
            wantValue = false
          }
          continue
        }
        stack.push(frame)
        continue
      }
      const [value, end] = readScalar(text, i, strict)
      i = skipWs(text, end)
      if (top === undefined) {
        result = value
        done = true
      } else {
        attach(top, value)
        wantValue = false
      }
      continue
    }
    // after a value inside a container: a comma or its close
    if (top === undefined) throw new PyJsonError('Expecting value')
    const c = text.charAt(i)
    const close = top.list !== null ? ']' : '}'
    if (c === ',') {
      i = skipWs(text, i + 1)
      wantValue = true
      continue
    }
    if (c !== close) throw new PyJsonError(top.list !== null ? "Expecting ',' delimiter" : "Expecting ',' delimiter")
    i = skipWs(text, i + 1)
    stack.pop()
    const value: PyValue = top.list ?? top.map ?? null
    const parent = stack.at(-1)
    if (parent === undefined) {
      result = value
      done = true
    } else {
      attach(parent, value)
    }
  }
  if (i !== text.length) throw new PyJsonError('Extra data')
  return result
}

/** v1's `_loads_lenient`: a JSON-LD or script block without `<!-- -->`, trailing `;` and (on a second try) trailing
 *  commas; null when it isn't JSON (v1's None, which a JSON `null` also gave). */
export function loadsLenient(raw: string): PyValue {
  let text = pyStrip(raw)
  if (text.startsWith('<!--')) text = text.slice(4)
  if (text.endsWith('-->')) text = text.slice(0, -3)
  text = pyStrip(text).replace(/;+$/, '')
  try {
    return pyLoads(text, false)
  } catch {
    // v1 then dropped trailing commas and tried once more
  }
  try {
    return pyLoads(text.replace(TRAILING_COMMA, '$1'), false)
  } catch {
    return null
  }
}

// `,\s*([}\]])` with Python's `\s`
const TRAILING_COMMA = /,[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*([}\]])/gu
