// Python's `html.unescape`, which v1 applied to JSON-LD text, metas, feed fields, picture links and names: numeric
// references (the HTML5 replacements for 0x80–0x9F, NUL and CR; U+FFFD for surrogates and anything past U+10FFFF;
// nothing for the code points it drops), named ones with and without `;`, and the longest known prefix of an unknown
// name (`&notit;` is "¬it;"). The tables are Python's (server/src/product/entities.ts), passed in. Pure (TScert).

/** html.unescape's tables. */
export interface EntityTables {
  /** html.entities.html5. */
  readonly names: ReadonlyMap<string, string>
  /** html._invalid_charrefs. */
  readonly charrefs: ReadonlyMap<number, string>
  /** html._invalid_codepoints. */
  readonly dropped: ReadonlySet<number>
}

/** The value of a run of digits in `radix`, or Infinity when it can't be a code point (more than 7 significant
 *  digits). */
function codeOf(digits: string, radix: number): number {
  const significant = digits.replace(/^0+/, '')
  if (significant.length > 7) return Number.POSITIVE_INFINITY
  return significant === '' ? 0 : parseInt(significant, radix)
}

function replaceRef(ref: string, t: EntityTables): string {
  if (ref.startsWith('#')) {
    const hex = ref.charAt(1) === 'x' || ref.charAt(1) === 'X'
    const digits = (hex ? ref.slice(2) : ref.slice(1)).replace(/;+$/, '')
    const num = codeOf(digits, hex ? 16 : 10)
    const fixed = t.charrefs.get(num)
    if (fixed !== undefined) return fixed
    if ((num >= 0xd800 && num <= 0xdfff) || num > 0x10ffff) return '\u{fffd}'
    if (t.dropped.has(num)) return ''
    return String.fromCodePoint(num)
  }
  const whole = t.names.get(ref)
  if (whole !== undefined) return whole
  const cps = Array.from(ref)
  for (let x = cps.length - 1; x > 1; x--) {
    const value = t.names.get(cps.slice(0, x).join(''))
    if (value !== undefined) return value + cps.slice(x).join('')
  }
  return '&' + ref
}

function isDigit(c: string): boolean {
  return c >= '0' && c <= '9'
}

function isHex(c: string): boolean {
  return isDigit(c) || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}

/** The reference after an `&` at `i` (v1's `&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)`, the name counted
 *  in code points): its text, or '' when nothing matches there. */
function refAt(s: string, i: number): string {
  if (s.charAt(i) === '#') {
    const hex = s.charAt(i + 1) === 'x' || s.charAt(i + 1) === 'X'
    let j = hex ? i + 2 : i + 1
    const from = j
    while (j < s.length && (hex ? isHex(s.charAt(j)) : isDigit(s.charAt(j)))) j++
    if (j === from) return ''
    if (s.charAt(j) === ';') j++
    return s.slice(i, j)
  }
  let j = i
  let n = 0
  while (j < s.length && n < 32) {
    const c = s.charAt(j)
    if (c === '\t' || c === '\n' || c === '\f' || c === ' ' || c === '<' || c === '&' || c === '#' || c === ';') break
    const code = s.charCodeAt(j)
    const pair = code >= 0xd800 && code <= 0xdbff && j + 1 < s.length && s.charCodeAt(j + 1) >= 0xdc00 && s.charCodeAt(j + 1) <= 0xdfff
    j += pair ? 2 : 1
    n++
  }
  if (n === 0) return ''
  if (s.charAt(j) === ';') j++
  return s.slice(i, j)
}

/** Python's `html.unescape(s)`. */
export function pyUnescape(s: string, t: EntityTables): string {
  if (!s.includes('&')) return s
  let out = ''
  let i = 0
  for (;;) {
    const amp = s.indexOf('&', i)
    if (amp < 0) break
    const ref = refAt(s, amp + 1)
    if (ref === '') {
      out += s.slice(i, amp + 1)
      i = amp + 1
      continue
    }
    out += s.slice(i, amp) + replaceRef(ref, t)
    i = amp + 1 + ref.length
  }
  return out + s.slice(i)
}
