// Python's formatting of numbers and text, as v1 (planner/serve.py, the Python midstudy-add) printed them in messages,
// cost rows and argv: `f"{x:.2f}"`, `round(x, n)`, `repr(float)`, `{x:g}`, `repr(str)`, `str.strip()`,
// `str.splitlines()`. Pure: no Node, no DOM (TScert, tscert/README.md).

const HEX = '0123456789abcdef'

/** `n` as `width` lowercase hex digits (n ≥ 0, an integer). */
export function hexDigits(n: number, width: number): string {
  let out = ''
  let v = n
  while (v > 0) {
    out = HEX.charAt(v % 16) + out
    v = Math.floor(v / 16)
  }
  return out.padStart(width, '0')
}

/** The decimal digit string of `x.toFixed(d)` with Python's round-half-even on an exact tie (JS rounds a tie away
 *  from zero). A tie is only possible when x is a dyadic rational with at most d + 1 fractional binary digits, and then
 *  `toFixed(d + 40)` is its exact expansion. */
function fixedHalfEven(a: number, d: number): string {
  const s = a.toFixed(d)
  const exact = a.toFixed(Math.min(100, d + 40))
  const rest = exact.slice(exact.indexOf('.') + 1 + d)
  if (!/^50*$/.test(rest)) return s
  // An exact tie: JS took the neighbour away from zero, Python keeps the even one. When JS's last digit is odd, the
  // even neighbour is one less in that digit (no borrow: an odd digit is at least 1).
  const last = s.charCodeAt(s.length - 1) - 48
  if (last % 2 === 0) return s
  return s.slice(0, s.length - 1) + String(last - 1)
}

/** Python's `f"{x:.{d}f}"` (0 ≤ d ≤ 20): correctly rounded, ties to even, `-0.00` for negative zero, `inf`, `nan`. */
export function pyFixed(x: number, d: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (x === Infinity) return 'inf'
  if (x === -Infinity) return '-inf'
  const negative = x < 0 || Object.is(x, -0)
  const a = negative ? -x : x
  let digits: string
  if (a >= 1e21) {
    digits = BigInt(a).toString() + (d > 0 ? '.' + '0'.repeat(d) : '')
  } else {
    digits = fixedHalfEven(a, d)
  }
  return negative ? '-' + digits : digits
}

/** Python's `round(x, n)` for a float: the nearest multiple of 10^-n, ties to even, computed on the exact value. */
export function pyRound(x: number, n: number): number {
  if (!Number.isFinite(x)) return x
  return parseFloat(pyFixed(x, n))
}

/** v1's `fmt_cost` (planner/serve.py: its cost rows and sentences): two decimals when that is exact to six, else four
 *  (`0.02`, `0.0398`). */
export function fmtCost(cost: number): string {
  return pyRound(cost, 2) === pyRound(cost, 6) ? pyFixed(cost, 2) : pyFixed(cost, 4)
}

/** v1 midstudy-add's `fmt_cost` (its cost rows): `f"{cost:.4f}".rstrip("0").rstrip(".") or "0"`, the shortest plain
 *  decimal to four places (`0.1`, `0.02`, `0.0398`, `0`). */
export function fmtCostShort(cost: number): string {
  const s = pyFixed(cost, 4).replace(/0+$/, '').replace(/\.$/, '')
  return s === '' ? '0' : s
}

/** The shortest round-trip digits and the decimal exponent of a finite, non-zero |x| (`1.5e-7` → "15", -7). */
function shortest(a: number): { readonly digits: string; readonly exp: number } {
  const e = a.toExponential()
  const at = e.indexOf('e')
  const mantissa = e.slice(0, at)
  const exp = parseInt(e.slice(at + 1), 10)
  return { digits: mantissa.replace('.', ''), exp }
}

function expText(exp: number): string {
  const sign = exp < 0 ? '-' : '+'
  const v = exp < 0 ? -exp : exp
  return 'e' + sign + String(v).padStart(2, '0')
}

/** Python's `repr(float)`: the shortest round-trip digits, positional for 1e-4 ≤ |x| < 1e16 (with `.0` when
 *  integral), else `d.ddde±XX`. */
export function pyFloatRepr(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (x === Infinity) return 'inf'
  if (x === -Infinity) return '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0.0' : '0.0'
  const sign = x < 0 ? '-' : ''
  const { digits, exp } = shortest(x < 0 ? -x : x)
  if (exp >= -4 && exp < 16) {
    if (exp < 0) return sign + '0.' + '0'.repeat(-exp - 1) + digits
    const intLen = exp + 1
    if (digits.length <= intLen) return sign + digits + '0'.repeat(intLen - digits.length) + '.0'
    return sign + digits.slice(0, intLen) + '.' + digits.slice(intLen)
  }
  const mant = digits.length > 1 ? digits.charAt(0) + '.' + digits.slice(1) : digits
  return sign + mant + expText(exp)
}

/** Python's `format(x, 'g')` (precision 6): `30`, `2`, `0.5`, `1e-05`, `1.23457e+06`. */
export function pyFormatG(x: number): string {
  if (Number.isNaN(x)) return 'nan'
  if (x === Infinity) return 'inf'
  if (x === -Infinity) return '-inf'
  if (x === 0) return Object.is(x, -0) ? '-0' : '0'
  const sign = x < 0 ? '-' : ''
  const a = x < 0 ? -x : x
  const e = a.toExponential(5)
  const at = e.indexOf('e')
  const exp = parseInt(e.slice(at + 1), 10)
  if (exp >= -4 && exp < 6) {
    const fixed = a.toFixed(5 - exp)
    return sign + (fixed.includes('.') ? fixed.replace(/0+$/, '').replace(/\.$/, '') : fixed)
  }
  const mant = e.slice(0, at).replace(/0+$/, '').replace(/\.$/, '')
  return sign + mant + expText(exp)
}

/** v1's `num_text` (midstudy-add's `str(num(v))`): an integral value without a decimal point (`80`, every digit of
 *  a large one as Python's `str(int(x))` prints it), else Python's repr (`80.5`). */
export function numText(v: number): string {
  if (Number.isInteger(v)) return v >= 2 ** 53 || v <= -(2 ** 53) ? BigInt(v).toString() : String(v === 0 ? 0 : v)
  return pyFloatRepr(v)
}

/** v1's `mb_text`: a size in MB (MiB, as the limits are), rounded up to a tenth (`25.1 MB`). */
export function mbText(n: number): string {
  return pyFixed(Math.ceil((n / 2 ** 20) * 10) / 10, 1) + ' MB'
}

// Python's str.isspace() characters (Unicode White_Space with bidi WS/B/S, and Zs).
const PY_SPACE_START = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/
const PY_SPACE_END = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/

/** Python's `str.strip()`: Python's whitespace (which differs from JS's `trim`: no U+FEFF, plus U+001C–U+001F). */
export function pyStrip(s: string): string {
  return s.replace(PY_SPACE_START, '').replace(PY_SPACE_END, '')
}

const PY_LINE_BREAK = /\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/

/** Python's `str.splitlines()`: no empty last element for a trailing line break, `[]` for `''`. */
export function pySplitlines(s: string): string[] {
  const parts = s.split(PY_LINE_BREAK)
  if (parts.at(-1) === '') parts.pop()
  return parts
}

// Characters Python's repr() escapes: categories Cc, Cf, Cs, Co, Cn, Zl, Zp and Zs (but the space).
const NOT_PRINTABLE = /^[\p{C}\p{Z}]$/u

function reprChar(ch: string, quote: string): string {
  const c = ch.codePointAt(0) ?? 0
  if (ch === quote || ch === '\\') return '\\' + ch
  if (ch === '\t') return '\\t'
  if (ch === '\n') return '\\n'
  if (ch === '\r') return '\\r'
  if (c < 0x20 || c === 0x7f) return '\\x' + hexDigits(c, 2)
  if (c < 0x7f) return ch
  if (ch !== ' ' && NOT_PRINTABLE.test(ch)) {
    if (c <= 0xff) return '\\x' + hexDigits(c, 2)
    if (c <= 0xffff) return '\\u' + hexDigits(c, 4)
    return '\\U' + hexDigits(c, 8)
  }
  return ch
}

/** Python's `repr(str)` (what v1's `{name!r}` printed): single quotes unless the text holds a `'` and no `"`. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = quote
  for (const ch of s) out += reprChar(ch, quote)
  return out + quote
}
