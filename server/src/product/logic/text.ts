// Text as v1's product reader handled it: Python's whitespace (`\s` adds U+001C–U+001F and U+0085 to JS's `\s`, and
// leaves out U+FEFF), and lengths and slices counted in code points, as Python indexes strings. Pure (TScert).
import { pyStrip } from '../../../../common/logic/pyfmt.ts'

// v1's `_WS = [\s\u00a0\u200b]+` with Python's `\s`.
const WS_RUN = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200b}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/gu
// Python's `\s+`.
const PY_WS_RUN = /[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/gu

function squashCell(cell: string): string {
  return pyStrip(cell.replace(WS_RUN, ' '))
}

/** v1's `_squash`: whitespace runs to one space, table cells kept apart by one tab (empty cells dropped). */
export function squash(text: string): string {
  const cells = text.split('\t').map(squashCell)
  if (cells.length > 1) return cells.filter((c) => c !== '').join('\t')
  return cells[0] ?? ''
}

/** Python's `re.sub(r"\s+", " ", s)`. */
export function collapseWs(s: string): string {
  return s.replace(PY_WS_RUN, ' ')
}

/** v1's `_collapse`: whitespace runs to one space, stripped, lowercased. */
export function collapse(s: string): string {
  return pyStrip(collapseWs(s)).toLowerCase()
}

/** The number of code points in `s` (Python's `len`). */
export function cpLength(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    // a high surrogate followed by a low one is one code point
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      if (d >= 0xdc00 && d <= 0xdfff) i++
    }
    n++
  }
  return n
}

/** The UTF-16 index where code point `n` starts (s.length when s has fewer). */
function cpIndex(s: string, n: number): number {
  let i = 0
  let seen = 0
  while (i < s.length && seen < n) {
    const c = s.charCodeAt(i)
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1)
      i += d >= 0xdc00 && d <= 0xdfff ? 2 : 1
    } else {
      i += 1
    }
    seen++
  }
  return i
}

/** Python's `s[:n]` (n ≥ 0), by code points. */
export function cpPrefix(s: string, n: number): string {
  if (s.length <= n) return s
  return s.slice(0, cpIndex(s, n))
}

const ND = /\p{Nd}/u

/** The value of a run of Python `\d` digits in any script (Python's `int()`): each Unicode Nd block is a run of tens
 *  starting at a zero, so a digit's value is its distance from the block's start, modulo 10. */
export function digitsValue(s: string): number {
  let v = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 48
    let start = cp
    while (start > 0 && ND.test(String.fromCodePoint(start - 1))) start--
    v = v * 10 + ((cp - start) % 10)
  }
  return v
}
