// Python's formatting as midstudy-add's messages and library entries use it, beyond common/logic/pyfmt.ts (which has
// `%.Nf`, `round`, `:g`, `repr(float)`, `repr(str)`, `str.strip()` and v1's `num_text`, shared with the server): `:.N%`,
// `:,`, v1's `num()`, `' '.join(s.split())`, and `str()` / `repr()` / `type().__name__` of a parsed JSON value. Pure
// (functional core).

import { pyFixed, pyFloatRepr, pyRepr } from '../../../common/logic/pyfmt.ts'
import type { PyValue } from './pyjson.ts'

/** `f'{x:.{d}%}'`. */
export function percent(x: number, d: number): string {
  return `${pyFixed(x * 100, d)}%`
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

/** Python's `str.isspace()` characters. */
export function isPySpace(c: number): boolean {
  return (c >= 9 && c <= 13) || (c >= 0x1c && c <= 0x20) || c === 0x85 || c === 0xa0 || c === 0x1680
    || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000
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

/** Python's `repr()` of a parsed JSON value. */
function reprValue(v: PyValue): string {
  switch (v.kind) {
    case 'null': return 'None'
    case 'bool': return v.value ? 'True' : 'False'
    case 'int': return v.text
    case 'float': return pyFloatRepr(v.value)
    case 'str': return pyRepr(v.value)
    case 'list': return `[${v.items.map(reprValue).join(', ')}]`
    case 'dict': return `{${v.entries.map((e) => `${pyRepr(e.key)}: ${reprValue(e.value)}`).join(', ')}}`
  }
}

/** Python's `str()` of a parsed JSON value: a str as is, anything else as its repr. */
export function pyStr(v: PyValue): string {
  return v.kind === 'str' ? v.value : reprValue(v)
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
