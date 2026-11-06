// Sizes in inline scripts (contract §2.11 layer 3): shops that render the page in the browser keep "Dimensions
// (Overall): 71.18 Inches (H) x …" in a JSON blob or a string literal. v1's `_script_strings`, `_literals` (one linear
// pass over the string literals, an unterminated or escaped-quote run skipped past, never rescanned) and
// `_js_unescape`.
import { pySplitlines, pyStrip } from '../../../common/logic/pyfmt.ts'
import { unescape } from './doc.ts'
import type { Deadline } from './errors.ts'
import { textLines } from './html.ts'
import { isDict, isList } from './logic/py.ts'
import { loadsLenient, type PyValue } from './logic/pyjson.ts'
import { cpLength, squash } from './logic/text.ts'
import { hasSize } from './sizes.ts'

/** v1's `_literals`: the contents of the "…" and '…' string literals (4 to 200,000 characters) in `text`. */
export function literals(text: string): string[] {
  const out: string[] = []
  const n = text.length
  let i = 0
  let nextDouble = text.indexOf('"')
  let nextSingle = text.indexOf("'")
  for (;;) {
    if (nextDouble >= 0 && nextDouble < i) nextDouble = text.indexOf('"', i)
    if (nextSingle >= 0 && nextSingle < i) nextSingle = text.indexOf("'", i)
    const cands = [nextDouble, nextSingle].filter((p) => p >= 0)
    if (cands.length === 0) return out
    const j = Math.min(...cands)
    const q = text.charAt(j)
    // (?:[^q\\\n]|\\.)* from j + 1 (`.` is anything but a newline)
    let end = j + 1
    while (end < n) {
      const c = text.charAt(end)
      if (c === q || c === '\n') break
      if (c === '\\') {
        if (end + 1 >= n || text.charAt(end + 1) === '\n') break
        end += 2
        // a backslash before a surrogate pair takes the whole code point, as `.` does
        const hi = text.charCodeAt(end - 1)
        if (hi >= 0xd800 && hi <= 0xdbff && end < n) {
          const lo = text.charCodeAt(end)
          if (lo >= 0xdc00 && lo <= 0xdfff) end += 1
        }
        continue
      }
      end += 1
    }
    if (end < n && text.charAt(end) === q) {
      const body = text.slice(j + 1, end)
      const len = cpLength(body)
      if (len >= 4 && len <= 200000) out.push(body)
    }
    i = end + 1
  }
}

const JS_ESCAPE = /\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[^\n])/gu

/** v1's `_js_unescape`: a script string literal's escapes read (\n, \t and \r as line breaks, \b \f \v \0 dropped). */
export function jsUnescape(s: string): string {
  return s.replace(JS_ESCAPE, (_m: string, e: string) => {
    if (e.startsWith('u') && e.length === 5) return String.fromCharCode(parseInt(e.slice(1), 16))
    if (e.startsWith('x') && e.length === 3) return String.fromCharCode(parseInt(e.slice(1), 16))
    switch (e) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\n'
      case 'b': case 'f': case 'v': case '0': return ''
      default: return e
    }
  })
}

const SKIP_KEYS = /recommend|related|s[i\u{131}\u{130}]m[i\u{131}\u{130}]lar|upsell|cross.?sell|also.?(?:bought|v[i\u{131}\u{130}]ewed|l[i\u{131}\u{130}]ke)|sponsor|carousel|bundle|complete.?the.?look|you.?may|accessor/iu
const LINK_START = /^[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]*(?:https?:)?\/\//u

/** v1's `_script_strings`: the string values in inline scripts that mention a size, as text lines (HTML in them
 *  stripped), each once, at most about 400. */
export async function scriptStrings(scripts: readonly (readonly [string, string])[], deadline: Deadline): Promise<string[]> {
  const out: string[] = []
  const seen = new Set<string>()
  const take = (s: string): void => {
    if (!hasSize(s) || LINK_START.test(s) || (!pyStrip(s).includes(' ') && cpLength(s) > 40)) return
    const lines = s.includes('<') && s.includes('>') ? textLines(s) : pySplitlines(s).map((x) => squash(unescape(x)))
    for (const ln of lines) {
      if (ln !== '' && cpLength(ln) <= 2000 && !seen.has(ln) && hasSize(ln)) {
        seen.add(ln)
        out.push(ln)
      }
    }
  }
  const walk = async (x: PyValue, depth: number): Promise<void> => {
    if (depth > 40 || out.length > 400) return
    await deadline.pause()
    if (typeof x === 'string') {
      const st = pyStrip(x)
      if ((st === '' || st.startsWith('{') || st.startsWith('[')) && cpLength(st) > 20) {
        const inner = loadsLenient(st)
        if (inner !== null) {
          await walk(inner, depth + 1)
          return
        }
      }
      take(x)
    } else if (isList(x)) {
      for (const y of x) await walk(y, depth + 1)
    } else if (isDict(x)) {
      for (const [k, v] of x) {
        if (SKIP_KEYS.test(k)) continue
        await walk(v, depth + 1)
      }
    }
  }
  for (const [kind, text] of scripts) {
    if (!hasSize(text)) continue
    if (kind.includes('json')) {
      const data = loadsLenient(text)
      if (data !== null) {
        await walk(data, 0)
        continue
      }
    }
    for (const lit of literals(text)) {
      await deadline.pause()
      if (!hasSize(lit)) continue
      await walk(jsUnescape(lit), 0)
    }
  }
  return out
}
