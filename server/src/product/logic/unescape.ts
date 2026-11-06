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

const CHARREF = /&(#[0-9]+;?|#[xX][0-9a-fA-F]+;?|[^\t\n\f <&#;]{1,32};?)/gu

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

/** Python's `html.unescape(s)`. */
export function pyUnescape(s: string, t: EntityTables): string {
  if (!s.includes('&')) return s
  return s.replace(CHARREF, (_m: string, ref: string) => replaceRef(ref, t))
}
