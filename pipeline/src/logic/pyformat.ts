// Python's formatting of numbers and strings, as v1's messages, cost rows and library entries use it: `%.Nf` and
// `:.N%` (correctly rounded, ties to even), `:g`, `:,`, `round(x, n)`, `str.strip()`, `repr(str)` and v1's `num()`
// (cost rows and their `fmt_cost` are common/logic/csv.ts). Pure (functional core).

import type { PyValue } from './pyjson.ts'
import { floatRepr } from './pyjson.ts'

/** Whether `a ≥ 0` lies exactly halfway between two multiples of 10^-d (then Python rounds to even). */
function isTie(a: number, d: number): boolean {
  const t = a * 2 ** (d + 1)
  return Number.isInteger(t) && t % 2 === 1 && t < 2 ** 53
}

/** `a ≥ 0` rounded to `d` decimals, ties to even, as digits with a point. */
function fixedAbs(a: number, d: number): string {
  if (!isTie(a, d)) return a.toFixed(d)
  // a·10^d = t·5^d / 2 with t odd: the two neighbours, and the even one
  const m = a * 2 ** (d + 1) * 5 ** d
  const lo = (m - 1) / 2
  const n = lo % 2 === 0 ? lo : lo + 1
  const s = String(n).padStart(d + 1, '0')
  return d === 0 ? s : `${s.slice(0, s.length - d)}.${s.slice(s.length - d)}`
}

/** `'%.{d}f' % x`. */
export function fixed(x: number, d: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  const negative = x < 0 || Object.is(x, -0)
  return `${negative ? '-' : ''}${fixedAbs(negative ? -x : x, d)}`
}

/** `f'{x:.{d}%}'`. */
export function percent(x: number, d: number): string {
  return `${fixed(x * 100, d)}%`
}

/** `round(x, nd)`: the double nearest the correctly rounded decimal, ties to even. */
export function pyRound(x: number, nd: number): number {
  if (!Number.isFinite(x)) return x
  const negative = x < 0 || Object.is(x, -0)
  const a = negative ? -x : x
  const v = isTie(a, nd) ? Number(fixedAbs(a, nd)) : Number(a.toFixed(nd))
  return negative ? -v : v
}

/** `f'{x:g}'` (6 significant digits, trailing zeros dropped; a tie at the 6th digit goes to even). */
export function general(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0' : '0'
  const negative = x < 0
  const a = negative ? -x : x
  const shortest = a.toExponential()
  const e0 = Number(shortest.slice(shortest.indexOf('e') + 1))
  const d = 5 - e0
  const q = d < 0 ? 10 ** -d : 0
  const tie = d >= 0 ? isTie(a, d) : Number.isInteger(a) && a < 2 ** 53 && (a % q) * 2 === q
  let e = a.toExponential(5)
  if (tie) {
    // the exact value has 7 significant digits; keep the first 6 when the 6th is even
    const seven = a.toExponential(6)
    const lastKept = Number(seven.charAt(6))
    if (lastKept % 2 === 0) e = `${seven.slice(0, 7)}${seven.slice(seven.indexOf('e'))}`
  }
  const at = e.indexOf('e')
  const exp = Number(e.slice(at + 1))
  let out: string
  if (exp >= -4 && exp < 6) {
    const mant = e.slice(0, at).replace('.', '')
    const point = exp + 1
    out = point <= 0 ? `0.${'0'.repeat(-point)}${mant}` : point >= mant.length ? mant + '0'.repeat(point - mant.length) : `${mant.slice(0, point)}.${mant.slice(point)}`
    if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '')
  } else {
    let m = e.slice(0, at).replace(/0+$/, '').replace(/\.$/, '')
    if (m === '') m = '0'
    const abs = exp < 0 ? -exp : exp
    out = `${m}e${exp < 0 ? '-' : '+'}${abs < 10 ? '0' : ''}${String(abs)}`
  }
  return `${negative ? '-' : ''}${out}`
}

/** `f'{n:,}'` for an integer. */
export function thousands(n: number): string {
  const s = String(n < 0 ? -n : n)
  let out = ''
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) out += ','
    out += s.charAt(i)
  }
  return n < 0 ? `-${out}` : out
}

/** v1's `num(v)`: an int when the float is whole, else the float. */
export function num(v: number): PyValue {
  if (Number.isInteger(v)) {
    const a = v < 0 ? -v : v
    return { kind: 'int', text: a < 2 ** 53 ? String(v === 0 ? 0 : v) : BigInt(v).toString() }
  }
  return { kind: 'float', value: v }
}

/** `str(num(v))`. */
export function numText(v: number): string {
  const n = num(v)
  return n.kind === 'int' ? n.text : pyRepr(n)
}

/** Python's `str.isspace()` characters. */
export function isPySpace(c: number): boolean {
  return (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
}

/** `s.strip()`. */
export function strip(s: string): string {
  let a = 0
  let b = s.length
  while (a < b && isPySpace(s.charCodeAt(a))) a++
  while (b > a && isPySpace(s.charCodeAt(b - 1))) b--
  return s.slice(a, b)
}

/** `s.split()` (runs of whitespace). */
function splitWs(s: string): string[] {
  const out: string[] = []
  let cur = ''
  for (let i = 0; i < s.length; i++) {
    if (isPySpace(s.charCodeAt(i))) {
      if (cur !== '') out.push(cur)
      cur = ''
    } else cur += s.charAt(i)
  }
  if (cur !== '') out.push(cur)
  return out
}

/** `' '.join(s.split())`: v1's one-line error messages. */
export function oneLine(s: string): string {
  return splitWs(s).join(' ')
}

function hex(n: number, width: number): string {
  return n.toString(16).padStart(width, '0')
}

/** Whether Python prints a code point as is in a repr (an approximation of `str.isprintable` past ASCII). */
function printable(c: number): boolean {
  if (c < 0x20 || c === 0x7f) return false
  if (c < 0x7f) return true
  if (c <= 0xa0 || c === 0xad) return false
  if ((c >= 0x2000 && c <= 0x200f) || (c >= 0x2028 && c <= 0x202f) || (c >= 0x205f && c <= 0x206f)) return false
  if (c === 0x3000 || c === 0xfeff || (c >= 0xd800 && c <= 0xdfff) || (c >= 0xe000 && c <= 0xf8ff)) return false
  if (c >= 0xfff9 && c <= 0xfffb) return false
  return true
}

/** `repr(s)` for a str. */
export function repr(s: string): string {
  const q = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = q
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (ch === '\\') out += '\\\\'
    else if (ch === q) out += `\\${q}`
    else if (ch === '\t') out += '\\t'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (printable(c)) out += ch
    else if (c < 0x100) out += `\\x${hex(c, 2)}`
    else if (c < 0x10000) out += `\\u${hex(c, 4)}`
    else out += `\\U${hex(c, 8)}`
  }
  return out + q
}

/** Python's `float(s)` of a string (`--dims` numbers, a library's `dims_cm` given as text), or null. */
export function pyFloat(s: string): number | null {
  const t = strip(s).replace(/_/g, (m, i: number, all: string) => (i > 0 && /\d/.test(all.charAt(i - 1)) && /\d/.test(all.charAt(i + 1)) ? '' : m))
  if (/^[+-]?(inf|infinity)$/i.test(t)) return t.startsWith('-') ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY
  if (/^[+-]?nan$/i.test(t)) return Number.NaN
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return null
  return Number(t)
}

/** Python's `repr()` of a parsed JSON value. */
function pyRepr(v: PyValue): string {
  switch (v.kind) {
    case 'null': return 'None'
    case 'bool': return v.value ? 'True' : 'False'
    case 'int': return v.text
    case 'float': return Number.isFinite(v.value) ? floatRepr(v.value) : Number.isNaN(v.value) ? 'nan' : v.value > 0 ? 'inf' : '-inf'
    case 'str': return repr(v.value)
    case 'list': return `[${v.items.map(pyRepr).join(', ')}]`
    case 'dict': return `{${v.entries.map((e) => `${repr(e.key)}: ${pyRepr(e.value)}`).join(', ')}}`
  }
}

/** Python's `str()` of a parsed JSON value: a str as is, anything else as its repr. */
export function pyStr(v: PyValue): string {
  return v.kind === 'str' ? v.value : pyRepr(v)
}

/** `type(v).__name__` of a parsed JSON value. */
export function pyTypeName(v: PyValue): string {
  switch (v.kind) {
    case 'null': return 'NoneType'
    case 'bool': return 'bool'
    case 'int': return 'int'
    case 'float': return 'float'
    case 'str': return 'str'
    case 'list': return 'list'
    case 'dict': return 'dict'
  }
}
