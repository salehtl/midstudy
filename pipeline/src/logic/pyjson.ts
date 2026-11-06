// JSON exactly as v1's Python reads and writes it (json.loads / json.dumps), so that library.json, raw/request.json,
// raw/response.json and the summary line come out byte for byte as v1 wrote them. Python keeps ints and floats apart
// (`0` vs `0.0`) and a JS number doesn't, so values are a tagged tree: an int keeps its digits, a float its value
// (printed with Python's repr), a dict its key order. Pure (functional core, tscert/README.md).

export type PyValue =
  | { readonly kind: 'null' }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'int'; readonly text: string }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'str'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly PyValue[] }
  | { readonly kind: 'dict'; readonly entries: readonly PyEntry[] }

export interface PyEntry {
  readonly key: string
  readonly value: PyValue
}

export type Parsed = { readonly ok: true; readonly value: PyValue } | { readonly ok: false; readonly error: string }

export const NULL: PyValue = { kind: 'null' }

export function str(value: string): PyValue {
  return { kind: 'str', value }
}

export function float(value: number): PyValue {
  return { kind: 'float', value }
}

export function bool(value: boolean): PyValue {
  return { kind: 'bool', value }
}

/** An int from a safe integer. */
export function int(value: number): PyValue {
  return { kind: 'int', text: String(value) }
}

export function dict(entries: readonly PyEntry[]): PyValue {
  return { kind: 'dict', entries }
}

export function list(items: readonly PyValue[]): PyValue {
  return { kind: 'list', items }
}

export function entry(key: string, value: PyValue): PyEntry {
  return { key, value }
}

/** `d.get(key)`: the value, or undefined when `v` isn't a dict or lacks the key. */
export function get(v: PyValue, key: string): PyValue | undefined {
  if (v.kind !== 'dict') return undefined
  return v.entries.find((e) => e.key === key)?.value
}

/** `d[key] = value`: an existing key keeps its place, a new one goes last. */
export function set(v: PyValue, key: string, value: PyValue): PyValue {
  if (v.kind !== 'dict') return v
  if (v.entries.some((e) => e.key === key)) {
    return { kind: 'dict', entries: v.entries.map((e) => (e.key === key ? { key, value } : e)) }
  }
  return { kind: 'dict', entries: [...v.entries, { key, value }] }
}

/** Python truthiness. */
export function truthy(v: PyValue | undefined): boolean {
  if (v === undefined) return false
  switch (v.kind) {
    case 'null': return false
    case 'bool': return v.value
    case 'int': return !/^-?0$/.test(v.text)
    case 'float': return v.value !== 0
    case 'str': return v.value.length > 0
    case 'list': return v.items.length > 0
    case 'dict': return v.entries.length > 0
  }
}

/** Python `==` between two parsed values of the kinds a library holds (ints, floats and bools compare as numbers). */
export function equal(a: PyValue, b: PyValue): boolean {
  const an = numeric(a)
  const bn = numeric(b)
  if (an !== null && bn !== null) return an === bn
  if (a.kind === 'str' && b.kind === 'str') return a.value === b.value
  if (a.kind === 'null' && b.kind === 'null') return true
  if (a.kind === 'list' && b.kind === 'list') {
    return a.items.length === b.items.length && a.items.every((x, i) => {
      const y = b.items[i]
      return y !== undefined && equal(x, y)
    })
  }
  if (a.kind === 'dict' && b.kind === 'dict') {
    return a.entries.length === b.entries.length && a.entries.every((e) => {
      const other = get(b, e.key)
      return other !== undefined && equal(e.value, other)
    })
  }
  return false
}

/** The number a bool, int or float stands for (ints beyond 2^53 lose precision), else null. */
export function numeric(v: PyValue): number | null {
  if (v.kind === 'bool') return v.value ? 1 : 0
  if (v.kind === 'int') return Number(v.text)
  if (v.kind === 'float') return v.value
  return null
}

// --- parsing (json.loads, with the C scanner's error messages) ------------------------------------------------------

interface Cursor {
  readonly text: string
  pos: number
}

type Step = { readonly ok: true; readonly value: PyValue } | { readonly ok: false; readonly msg: string; readonly pos: number }

/** The message of a JSONDecodeError: `<msg>: line L column C (char P)`, P counting code points. */
function decodeError(text: string, msg: string, pos: number): string {
  const before = text.slice(0, pos)
  const lineno = before.split('\n').length
  const lastNl = before.lastIndexOf('\n')
  const chars = codePoints(before)
  const colno = lastNl < 0 ? chars + 1 : chars - codePoints(text.slice(0, lastNl))
  return `${msg}: line ${String(lineno)} column ${String(colno)} (char ${String(chars)})`
}

function codePoints(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    const d = i + 1 < s.length ? s.charCodeAt(i + 1) : 0
    if (c >= 0xd800 && c <= 0xdbff && d >= 0xdc00 && d <= 0xdfff) i++
    n++
  }
  return n
}

function skipWs(c: Cursor): void {
  while (c.pos < c.text.length) {
    const ch = c.text.charCodeAt(c.pos)
    if (ch === 32 || ch === 9 || ch === 10 || ch === 13) c.pos++
    else break
  }
}

function fail(msg: string, pos: number): Step {
  return { ok: false, msg, pos }
}

function isDigit(ch: number): boolean {
  return ch >= 48 && ch <= 57
}

function hexValue(s: string): number {
  let v = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    const d = ch >= 48 && ch <= 57 ? ch - 48 : ch >= 97 && ch <= 102 ? ch - 87 : ch >= 65 && ch <= 70 ? ch - 55 : -1
    if (d < 0) return -1
    v = v * 16 + d
  }
  return v
}

/** scanstring(s, end) with strict=True: `c.pos` is just past the opening quote. */
function scanString(c: Cursor): Step {
  const start = c.pos - 1
  let out = ''
  for (;;) {
    let i = c.pos
    while (i < c.text.length) {
      const ch = c.text.charCodeAt(i)
      if (ch === 34 || ch === 92 || ch < 32) break
      i++
    }
    out += c.text.slice(c.pos, i)
    if (i >= c.text.length) return fail('Unterminated string starting at', start)
    const ch = c.text.charCodeAt(i)
    if (ch === 34) {
      c.pos = i + 1
      return { ok: true, value: { kind: 'str', value: out } }
    }
    if (ch < 32) return fail('Invalid control character at', i)
    // a backslash
    if (i + 1 >= c.text.length) return fail('Unterminated string starting at', start)
    const esc = c.text.charAt(i + 1)
    if (esc === 'u') {
      // _json.c scanstring: the error points at the 'u'; four digits must leave a character after them
      if (i + 6 >= c.text.length) return fail('Invalid \\uXXXX escape', i + 1)
      const v = hexValue(c.text.slice(i + 2, i + 6))
      if (v < 0) return fail('Invalid \\uXXXX escape', i + 1)
      let code = v
      let next = i + 6
      if (v >= 0xd800 && v <= 0xdbff && next + 6 < c.text.length && c.text.charAt(next) === '\\' && c.text.charAt(next + 1) === 'u') {
        const lo = hexValue(c.text.slice(next + 2, next + 6))
        if (lo < 0) return fail('Invalid \\uXXXX escape', next + 1)
        if (lo >= 0xdc00 && lo <= 0xdfff) {
          code = 0x10000 + ((v - 0xd800) * 1024) + (lo - 0xdc00)
          next += 6
        }
      }
      out += String.fromCodePoint(code)
      c.pos = next
      continue
    }
    const simple = esc === '"' ? '"' : esc === '\\' ? '\\' : esc === '/' ? '/' : esc === 'b' ? '\b' : esc === 'f' ? '\f' : esc === 'n' ? '\n' : esc === 'r' ? '\r' : esc === 't' ? '\t' : null
    if (simple === null) return fail('Invalid \\escape', i)
    out += simple
    c.pos = i + 2
  }
}

function scanNumber(c: Cursor): Step | null {
  const t = c.text
  const start = c.pos
  const negative = t.charAt(start) === '-'
  let i = negative ? start + 1 : start
  if (i >= t.length || !isDigit(t.charCodeAt(i))) return null
  if (t.charAt(i) === '0') i++
  else while (i < t.length && isDigit(t.charCodeAt(i))) i++
  const intEnd = i
  let isFloat = false
  if (t.charAt(i) === '.' && i + 1 < t.length && isDigit(t.charCodeAt(i + 1))) {
    i += 2
    while (i < t.length && isDigit(t.charCodeAt(i))) i++
    isFloat = true
  }
  if (t.charAt(i) === 'e' || t.charAt(i) === 'E') {
    let j = i + 1
    if (t.charAt(j) === '+' || t.charAt(j) === '-') j++
    if (j < t.length && isDigit(t.charCodeAt(j))) {
      j++
      while (j < t.length && isDigit(t.charCodeAt(j))) j++
      i = j
      isFloat = true
    }
  }
  c.pos = i
  if (isFloat) return { ok: true, value: { kind: 'float', value: Number(t.slice(start, i)) } }
  const digits = t.slice(negative ? start + 1 : start, intEnd)
  return { ok: true, value: { kind: 'int', text: normalizeInt(negative, digits) } }
}

function normalizeInt(negative: boolean, digits: string): string {
  return negative && digits !== '0' ? `-${digits}` : digits
}

function scanValue(c: Cursor, depth: number): Step {
  if (depth > 900) return fail('maximum recursion depth exceeded', c.pos)
  const t = c.text
  const ch = t.charAt(c.pos)
  if (ch === '"') {
    c.pos++
    return scanString(c)
  }
  if (ch === '{') return scanObject(c, depth)
  if (ch === '[') return scanArray(c, depth)
  if (ch === 'n' && t.startsWith('null', c.pos)) {
    c.pos += 4
    return { ok: true, value: NULL }
  }
  if (ch === 't' && t.startsWith('true', c.pos)) {
    c.pos += 4
    return { ok: true, value: { kind: 'bool', value: true } }
  }
  if (ch === 'f' && t.startsWith('false', c.pos)) {
    c.pos += 5
    return { ok: true, value: { kind: 'bool', value: false } }
  }
  const num = scanNumber(c)
  if (num !== null) return num
  if (ch === 'N' && t.startsWith('NaN', c.pos)) {
    c.pos += 3
    return { ok: true, value: { kind: 'float', value: Number.NaN } }
  }
  if (ch === 'I' && t.startsWith('Infinity', c.pos)) {
    c.pos += 8
    return { ok: true, value: { kind: 'float', value: Number.POSITIVE_INFINITY } }
  }
  if (ch === '-' && t.startsWith('-Infinity', c.pos)) {
    c.pos += 9
    return { ok: true, value: { kind: 'float', value: Number.NEGATIVE_INFINITY } }
  }
  return fail('Expecting value', c.pos)
}

function scanObject(c: Cursor, depth: number): Step {
  c.pos++
  const entries: PyEntry[] = []
  skipWs(c)
  if (c.text.charAt(c.pos) === '}') {
    c.pos++
    return { ok: true, value: { kind: 'dict', entries } }
  }
  for (;;) {
    if (c.text.charAt(c.pos) !== '"') return fail('Expecting property name enclosed in double quotes', c.pos)
    c.pos++
    const key = scanString(c)
    if (!key.ok) return key
    const k = key.value.kind === 'str' ? key.value.value : ''
    skipWs(c)
    if (c.text.charAt(c.pos) !== ':') return fail("Expecting ':' delimiter", c.pos)
    c.pos++
    skipWs(c)
    const v = scanValue(c, depth + 1)
    if (!v.ok) return v
    const at = entries.findIndex((e) => e.key === k)
    if (at >= 0) entries[at] = { key: k, value: v.value }
    else entries.push({ key: k, value: v.value })
    skipWs(c)
    const ch = c.text.charAt(c.pos)
    if (ch === '}') {
      c.pos++
      return { ok: true, value: { kind: 'dict', entries } }
    }
    if (ch !== ',') return fail("Expecting ',' delimiter", c.pos)
    c.pos++
    skipWs(c)
  }
}

function scanArray(c: Cursor, depth: number): Step {
  c.pos++
  const items: PyValue[] = []
  skipWs(c)
  if (c.text.charAt(c.pos) === ']') {
    c.pos++
    return { ok: true, value: { kind: 'list', items } }
  }
  for (;;) {
    const v = scanValue(c, depth + 1)
    if (!v.ok) return v
    items.push(v.value)
    skipWs(c)
    const ch = c.text.charAt(c.pos)
    if (ch === ']') {
      c.pos++
      return { ok: true, value: { kind: 'list', items } }
    }
    if (ch !== ',') return fail("Expecting ',' delimiter", c.pos)
    c.pos++
    skipWs(c)
  }
}

/** `json.loads(text)`: the value, or the JSONDecodeError's message. */
export function parse(text: string): Parsed {
  if (text.startsWith('﻿')) return { ok: false, error: decodeError(text, 'Unexpected UTF-8 BOM (decode using utf-8-sig)', 0) }
  const c: Cursor = { text, pos: 0 }
  skipWs(c)
  const v = scanValue(c, 0)
  if (!v.ok) return { ok: false, error: decodeError(text, v.msg, v.pos) }
  skipWs(c)
  if (c.pos !== text.length) return { ok: false, error: decodeError(text, 'Extra data', c.pos) }
  return { ok: true, value: v.value }
}

// --- writing (json.dumps) ----------------------------------------------------------------------------------------

/** Python's `repr(float)` for a finite value: the shortest round-trip digits, `1e-05`/`1e+16` past 1e-4 and 1e16,
 *  and always a `.0` on a whole number. */
export function floatRepr(x: number): string {
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const sign = x < 0 ? '-' : ''
  const s = String(x < 0 ? -x : x)
  // digits and the decimal point's position (value = 0.d1d2… × 10^decpt)
  let digits: string
  let decpt: number
  const e = s.indexOf('e')
  if (e >= 0) {
    const mant = s.slice(0, e)
    const exp = Number(s.slice(e + 1))
    digits = mant.replace('.', '')
    decpt = exp + 1
  } else {
    const dot = s.indexOf('.')
    const intPart = dot < 0 ? s : s.slice(0, dot)
    const frac = dot < 0 ? '' : s.slice(dot + 1)
    if (intPart === '0') {
      let z = 0
      while (z < frac.length && frac.charAt(z) === '0') z++
      digits = frac.slice(z)
      decpt = -z
    } else {
      digits = intPart + frac
      decpt = intPart.length
    }
  }
  digits = digits.replace(/0+$/, '')
  if (digits === '') digits = '0'
  if (decpt <= -4 || decpt > 16) {
    const exp = decpt - 1
    const mant = digits.length > 1 ? `${digits.charAt(0)}.${digits.slice(1)}` : digits
    const abs = exp < 0 ? -exp : exp
    return `${sign}${mant}e${exp < 0 ? '-' : '+'}${abs < 10 ? '0' : ''}${String(abs)}`
  }
  if (decpt <= 0) return `${sign}0.${'0'.repeat(-decpt)}${digits}`
  if (digits.length <= decpt) return `${sign}${digits}${'0'.repeat(decpt - digits.length)}.0`
  return `${sign}${digits.slice(0, decpt)}.${digits.slice(decpt)}`
}

export interface DumpOptions {
  /** `indent=` (null: one line). */
  readonly indent: number | null
  readonly ensureAscii: boolean
  /** `separators=(",", ":")` instead of the defaults. */
  readonly compact?: boolean
  /** Python's default `allow_nan=True` (NaN, Infinity, -Infinity); library.json passes False, the default here. */
  readonly allowNan?: boolean
}

export type Dumped = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly error: string }

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0')
}

/** A Python string literal in JSON: `py_encode_basestring(_ascii)`. */
function quote(s: string, ensureAscii: boolean): string {
  let out = '"'
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    if (ch === 34) out += '\\"'
    else if (ch === 92) out += '\\\\'
    else if (ch === 10) out += '\\n'
    else if (ch === 13) out += '\\r'
    else if (ch === 9) out += '\\t'
    else if (ch === 8) out += '\\b'
    else if (ch === 12) out += '\\f'
    else if (ch < 32) out += `\\u${hex4(ch)}`
    else if (ensureAscii && ch > 126) out += `\\u${hex4(ch)}`
    else out += s.charAt(i)
  }
  return `${out}"`
}

function dumpInto(v: PyValue, o: DumpOptions, level: number, parts: string[]): string | null {
  switch (v.kind) {
    case 'null':
      parts.push('null')
      return null
    case 'bool':
      parts.push(v.value ? 'true' : 'false')
      return null
    case 'int':
      parts.push(v.text)
      return null
    case 'float':
      if (!Number.isFinite(v.value)) {
        if (o.allowNan === true) {
          parts.push(Number.isNaN(v.value) ? 'NaN' : v.value > 0 ? 'Infinity' : '-Infinity')
          return null
        }
        const r = Number.isNaN(v.value) ? 'nan' : v.value > 0 ? 'inf' : '-inf'
        return `Out of range float values are not JSON compliant: ${r}`
      }
      parts.push(floatRepr(v.value))
      return null
    case 'str':
      parts.push(quote(v.value, o.ensureAscii))
      return null
    case 'list': {
      if (v.items.length === 0) {
        parts.push('[]')
        return null
      }
      const inner = o.indent === null ? '' : `\n${' '.repeat(o.indent * (level + 1))}`
      const sep = o.indent === null ? (o.compact === true ? ',' : ', ') : `,${inner}`
      parts.push(`[${inner}`)
      let first = true
      for (const item of v.items) {
        if (!first) parts.push(sep)
        first = false
        const err = dumpInto(item, o, level + 1, parts)
        if (err !== null) return err
      }
      parts.push(o.indent === null ? ']' : `\n${' '.repeat(o.indent * level)}]`)
      return null
    }
    case 'dict': {
      if (v.entries.length === 0) {
        parts.push('{}')
        return null
      }
      const inner = o.indent === null ? '' : `\n${' '.repeat(o.indent * (level + 1))}`
      const sep = o.indent === null ? (o.compact === true ? ',' : ', ') : `,${inner}`
      parts.push(`{${inner}`)
      let first = true
      for (const e of v.entries) {
        if (!first) parts.push(sep)
        first = false
        parts.push(`${quote(e.key, o.ensureAscii)}${o.compact === true ? ':' : ': '}`)
        const err = dumpInto(e.value, o, level + 1, parts)
        if (err !== null) return err
      }
      parts.push(o.indent === null ? '}' : `\n${' '.repeat(o.indent * level)}}`)
      return null
    }
  }
}

/** `json.dumps(v, indent=…, ensure_ascii=…, allow_nan=…)` (default separators unless compact). */
export function dumps(v: PyValue, o: DumpOptions): Dumped {
  const parts: string[] = []
  const err = dumpInto(v, o, 0, parts)
  return err === null ? { ok: true, text: parts.join('') } : { ok: false, error: err }
}

/** The plain JSON value (for the schema validators): ints and floats become numbers. */
export function plain(v: PyValue): unknown {
  switch (v.kind) {
    case 'null': return null
    case 'bool': return v.value
    case 'int': return Number(v.text)
    case 'float': return v.value
    case 'str': return v.value
    case 'list': return v.items.map(plain)
    case 'dict': {
      const out = new Map<string, unknown>()
      for (const e of v.entries) out.set(e.key, plain(e.value))
      return Object.fromEntries(out)
    }
  }
}
