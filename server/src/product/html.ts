// The HTML of a product page (contract §2.11 layers 2 and 3): parse5's spec-compliant tokenizer, driven as a SAX parser
// (start tags, end tags, text), with v1's `_Page` handlers on top: visible text lines (page text inside header, footer,
// nav, aside or a "related products" block kept apart), JSON-LD blocks, inline scripts, metas, <title>, the first <h1>,
// links, <img>s and microdata items.
//
// The tokenizer is switched into raw text where the tree builder would switch it (script, style, title, textarea,
// xmp, iframe, noembed, noframes, plaintext; foreign content for svg and math), as parse5-sax-parser does, but with
// scripting disabled, so <noscript> content is markup (v1 saw the <img> a lazy-loading shop puts there).
// Differences from v1's html.parser are the spec's: attribute values decode entities by the spec's rules, a repeated
// attribute keeps its first value, <title> and <textarea> hold text only, CR LF is LF.
import { Tokenizer, TokenizerMode, foreignContent, html, type Token, type TokenHandler } from 'parse5'
import { pyStrip } from '../../../common/logic/pyfmt.ts'
import { urljoin } from '../logic/url.ts'
import { ProductError } from './errors.ts'
import { squash } from './logic/text.ts'

/** A microdata item: its itemtype and its properties (text, links, or nested items) in document order. */
export interface MicroItem {
  readonly type: string
  readonly props: Map<string, (string | MicroItem)[]>
}

/** A microdata text capture: the item it fills, the properties, the text seen so far. */
interface Capture {
  readonly item: MicroItem
  readonly props: readonly string[]
  readonly buf: string[]
}

type Closer = 'title' | 'h1' | 'skip' | 'out' | 'item' | Capture

/** A link (<base href> or a microdata src) Python's urljoin refused: v1's parse stopped there (its ValueError). */
export class ParseStopped extends Error {
  constructor() {
    super('the page stopped parsing at a link urljoin refused')
    this.name = 'ParseStopped'
  }
}

const BLOCK = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'button', 'caption', 'dd', 'details', 'dialog', 'div', 'dl', 'dt',
  'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'label', 'legend', 'li', 'main',
  'nav', 'ol', 'option', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'thead', 'tfoot', 'tr', 'ul', 'select', 'body', 'html', 'head'])
const CELL = new Set(['td', 'th'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'])
const SKIP = new Set(['script', 'style', 'template', 'noscript', 'svg', 'title', 'math', 'iframe', 'object'])
const OUT_TAGS = new Set(['header', 'footer', 'nav', 'aside'])

// v1's _OUT_CLASS with Python's \s, \w and re.I (whose `i` also matches ı and İ)
const PY_S = '\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}'
const PY_W = '[\\p{L}\\p{N}_]'
const pyI = (words: string): string => words.replace(/i/g, '[i\\u{131}\\u{130}]')
const OUT_CLASS = new RegExp(`(?:^|[${PY_S}_-])(?:${pyI(`related|recommend${PY_W}*|upsells?|up-sell|cross-?sells?|similar|you-may${PY_W}*|also-${PY_W}+|recently${PY_W}*|footer|mega-?menu|menus?|nav|navigation|drawer|mini-?cart|cart|reviews?|testimonials?|instagram|blog|look|shop-?the-?look|complete-?the-?look|bundles?`)})(?:$|[${PY_S}_-])`, 'iu')

/** Python's `str.split()` (whitespace runs, no empty pieces). */
function pySplit(s: string): string[] {
  return pyStrip(s).split(/[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/u).filter((x) => x !== '')
}

/** Python's `re.sub(r"\s+", " ", s).strip()`. */
function spaced(s: string): string {
  return pyStrip(s.replace(/[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/gu, ' '))
}

function same(a: Capture, b: Capture): boolean {
  // Python's list equality of [item, props, buf]: v1 compared captures with ==
  return sameItem(a.item, b.item) && a.props.length === b.props.length && a.props.every((p, i) => p === b.props[i])
    && a.buf.length === b.buf.length && a.buf.every((t, i) => t === b.buf[i])
}

function sameItem(a: MicroItem, b: MicroItem): boolean {
  if (a === b) return true
  if (a.type !== b.type || a.props.size !== b.props.size) return false
  for (const [k, va] of a.props) {
    const vb = b.props.get(k)
    if (vb?.length !== va.length) return false
    for (let i = 0; i < va.length; i++) {
      const x = va[i]
      const y = vb[i]
      if (typeof x === 'string' || typeof y === 'string' ? x !== y : x === undefined || y === undefined || !sameItem(x, y)) return false
    }
  }
  return true
}

/** v1's `_Page`: one pass over a page. */
export class Page {
  base: string
  readonly lines: string[] = []
  /** Text inside header, footer, nav, aside or "related products" blocks. */
  readonly outLines: string[] = []
  readonly ld: string[] = []
  /** Inline scripts: [type, text]. */
  readonly scripts: [string, string][] = []
  readonly metas: [string, string][] = []
  title: string | null = null
  h1: string | null = null
  readonly links: [string, string][] = []
  /** <img> attributes, outside "related" blocks. */
  readonly imgs: ReadonlyMap<string, string>[] = []
  /** Top-level microdata items. */
  readonly items: MicroItem[] = []
  #cur: string[] = []
  #skip = 0
  #script: { kind: string; buf: string[]; hasSrc: boolean } | null = null
  #title: string[] | null = null
  #h1: string[] | null = null
  #stack: [string, Closer[]][] = []
  #out = 0
  #captures: Capture[] = []
  #openItems: MicroItem[] = []

  constructor(baseUrl: string) {
    this.base = baseUrl
  }

  #nl(): void {
    if (this.#cur.length === 0) return
    const line = squash(this.#cur.join(''))
    if (line !== '') (this.#out > 0 ? this.outLines : this.lines).push(line)
    this.#cur = []
  }

  #in(tag: string): boolean {
    return this.#stack.slice(-64).some((e) => e[0] === tag)
  }

  #join(url: string): string {
    const joined = urljoin(this.base, url)
    if (joined === null) throw new ParseStopped()
    return joined
  }

  start(tag: string, a: ReadonlyMap<string, string>): void {
    const closers: Closer[] = []
    if (tag === 'script') {
      this.#script = { kind: pyStrip(a.get('type') ?? '').toLowerCase(), buf: [], hasSrc: a.has('src') }
    } else if (tag === 'base' && (a.get('href') ?? '') !== '') {
      this.base = this.#join(pyStrip(a.get('href') ?? ''))
    } else if (tag === 'meta') {
      const key = pyStrip(firstSet(a.get('property'), a.get('name'))).toLowerCase()
      const content = a.get('content')
      if (key !== '' && content !== undefined) this.metas.push([key, content])
    } else if (tag === 'link') {
      this.links.push([(a.get('rel') ?? '').toLowerCase(), a.get('href') ?? ''])
    } else if (tag === 'img' && !(this.#in('svg') || this.#in('template'))) {
      if (this.#out === 0) this.imgs.push(a)
    } else if (tag === 'title' && this.title === null && this.#title === null && !this.#in('svg')) {
      this.#title = []
      closers.push('title')
    } else if (tag === 'h1' && this.h1 === null && this.#h1 === null) {
      this.#h1 = []
      closers.push('h1')
    }
    if (SKIP.has(tag) && tag !== 'script') {
      this.#skip += 1
      closers.push('skip')
    }
    if (!VOID.has(tag) && (OUT_TAGS.has(tag) || OUT_CLASS.test((a.get('class') ?? '') + ' ' + (a.get('id') ?? '')))) {
      this.#nl() // the text before it is the page's own
      this.#out += 1
      closers.push('out')
    }
    if (BLOCK.has(tag)) this.#nl()
    else if (CELL.has(tag)) this.#cur.push('\t')
    this.#microdata(tag, a, closers)
    if (!VOID.has(tag)) {
      this.#stack.push([tag, closers])
      if (this.#stack.length > 4000) this.#pop(1, true) // malformed markup that never closes: keep it bounded
    }
  }

  end(tag: string): void {
    if (tag === 'script' && this.#script !== null) {
      const text = this.#script.buf.join('')
      if (this.#script.kind.includes('ld+json')) this.ld.push(text)
      else if (!this.#script.hasSrc && pyStrip(text) !== '') this.scripts.push([this.#script.kind, text])
      this.#script = null
    }
    const n = this.#stack.length
    for (let i = n - 1; i > Math.max(-1, n - 65); i--) {
      if (this.#stack[i]?.[0] === tag) {
        this.#pop(n - i, false)
        break
      }
    }
    if (BLOCK.has(tag)) this.#nl()
    else if (CELL.has(tag)) this.#cur.push('\t')
  }

  #pop(n: number, bottom: boolean): void {
    for (let k = 0; k < n; k++) {
      const entry = bottom ? this.#stack.shift() : this.#stack.pop()
      if (entry === undefined) return
      for (const c of entry[1]) {
        if (c === 'skip') {
          this.#skip = Math.max(0, this.#skip - 1)
        } else if (c === 'out') {
          this.#nl() // the block's last text is still the block's
          this.#out = Math.max(0, this.#out - 1)
        } else if (c === 'title') {
          if (this.#title !== null) {
            this.title = spaced(this.#title.join(''))
            this.#title = null
          }
        } else if (c === 'h1') {
          if (this.#h1 !== null) {
            this.h1 = spaced(this.#h1.join(''))
            this.#h1 = null
          }
        } else if (c === 'item') {
          this.#openItems.pop()
        } else {
          // v1 found the capture by equality (`c in self._captures`), removed the first equal one, and filled in c's text
          const at = this.#captures.findIndex((x) => x === c || same(x, c))
          if (at >= 0) {
            this.#captures.splice(at, 1)
            const text = spaced(c.buf.join(''))
            for (const p of c.props) addProp(c.item, p, text)
          }
        }
      }
    }
  }

  text(data: string): void {
    if (this.#script !== null) {
      this.#script.buf.push(data)
      return
    }
    this.#title?.push(data)
    this.#h1?.push(data)
    for (const c of this.#captures) c.buf.push(data)
    if (this.#skip === 0) this.#cur.push(data)
  }

  close(): void {
    while (this.#stack.length > 0) this.#pop(1, false)
    this.#nl()
  }

  #microdata(tag: string, a: ReadonlyMap<string, string>, closers: Closer[]): void {
    const props = pySplit(a.get('itemprop') ?? '')
    const parent = this.#openItems.at(-1)
    if (a.has('itemscope')) {
      const item: MicroItem = { type: a.get('itemtype') ?? '', props: new Map() }
      if (props.length > 0 && parent !== undefined) {
        for (const p of props) addProp(parent, p, item)
      } else {
        this.items.push(item)
      }
      if (!VOID.has(tag)) {
        this.#openItems.push(item)
        closers.push('item')
      }
      return
    }
    if (props.length === 0 || parent === undefined) return
    let value: string
    if (tag === 'meta') {
      value = a.get('content') ?? ''
    } else if (['img', 'source', 'video', 'audio', 'embed', 'iframe'].includes(tag)) {
      const src = a.get('src') ?? ''
      value = src !== '' ? this.#join(src) : a.get('content') ?? ''
    } else if (['a', 'link', 'area'].includes(tag)) {
      value = a.get('href') ?? ''
    } else if (tag === 'data' || tag === 'meter') {
      value = a.get('value') ?? ''
    } else if (a.has('content')) {
      value = a.get('content') ?? ''
    } else if (VOID.has(tag)) {
      value = ''
    } else {
      const cap: Capture = { item: parent, props, buf: [] }
      this.#captures.push(cap)
      closers.push(cap)
      return
    }
    for (const p of props) addProp(parent, p, value)
  }
}

/** Python's `a or b or ""` over attribute values. */
function firstSet(...values: (string | undefined)[]): string {
  return values.find((v) => v !== undefined && v !== '') ?? ''
}

function addProp(item: MicroItem, name: string, value: string | MicroItem): void {
  const list = item.props.get(name)
  if (list === undefined) item.props.set(name, [value])
  else list.push(value)
}

// --- the tokenizer, driven as a SAX parser -------------------------------------------------------------------------------

const { TAG_ID, NS } = html

/** Feeds parse5's tokenizer and hands start tags, end tags and text to a Page, switching the tokenizer's state where the
 *  tree builder would (parse5-sax-parser's feedback simulator, scripting off). */
class Driver implements TokenHandler {
  readonly tokenizer: Tokenizer
  readonly #page: Page
  #ns: html.NS[] = [NS.HTML]
  #foreign = false
  #skipNewLine = false

  constructor(page: Page) {
    this.#page = page
    this.tokenizer = new Tokenizer({ sourceCodeLocationInfo: false }, this)
  }

  #enter(ns: html.NS): void {
    this.#ns.unshift(ns)
    this.#foreign = ns !== NS.HTML
    this.tokenizer.inForeignNode = this.#foreign
  }

  #leave(): void {
    this.#ns.shift()
    this.#foreign = this.#ns[0] !== NS.HTML
    this.tokenizer.inForeignNode = this.#foreign
  }

  #rawText(tn: html.TAG_ID): boolean {
    switch (tn) {
      case TAG_ID.TEXTAREA:
      case TAG_ID.TITLE:
        this.tokenizer.state = TokenizerMode.RCDATA
        return true
      case TAG_ID.PLAINTEXT:
        this.tokenizer.state = TokenizerMode.PLAINTEXT
        return true
      case TAG_ID.SCRIPT:
        this.tokenizer.state = TokenizerMode.SCRIPT_DATA
        return true
      case TAG_ID.STYLE:
      case TAG_ID.IFRAME:
      case TAG_ID.XMP:
      case TAG_ID.NOEMBED:
      case TAG_ID.NOFRAMES:
        this.tokenizer.state = TokenizerMode.RAWTEXT
        return true
      default:
        return false
    }
  }

  onStartTag(token: Token.TagToken): void {
    this.#skipNewLine = false
    let raw = false
    if (token.tagID === TAG_ID.SVG) this.#enter(NS.SVG)
    else if (token.tagID === TAG_ID.MATH) this.#enter(NS.MATHML)
    if (this.#foreign) {
      if (foreignContent.causesExit(token)) {
        this.#leave()
      } else {
        const ns = this.#ns[0] ?? NS.HTML
        if (ns === NS.MATHML) foreignContent.adjustTokenMathMLAttrs(token)
        else if (ns === NS.SVG) {
          foreignContent.adjustTokenSVGTagName(token)
          foreignContent.adjustTokenSVGAttrs(token)
        }
        foreignContent.adjustTokenXMLAttrs(token)
        if (!token.selfClosing && foreignContent.isIntegrationPoint(token.tagID, ns, token.attrs)) this.#enter(NS.HTML)
      }
    } else {
      if (token.tagID === TAG_ID.PRE || token.tagID === TAG_ID.TEXTAREA || token.tagID === TAG_ID.LISTING) this.#skipNewLine = true
      raw = this.#rawText(token.tagID)
    }
    const tag = token.tagName.toLowerCase()
    const attrs = new Map<string, string>()
    for (const at of token.attrs) attrs.set(at.name.toLowerCase(), at.value)
    this.#page.start(tag, attrs)
    // v1 (html.parser) read <x/> as a start and an end tag; a raw text element stays open, as the tokenizer is now in it
    if (token.selfClosing && !VOID.has(tag) && !raw) this.#page.end(tag)
  }

  onEndTag(token: Token.TagToken): void {
    this.#skipNewLine = false
    if (!this.#foreign) {
      const previous = this.#ns[1]
      if (previous !== undefined && foreignContent.isIntegrationPoint(token.tagID, previous, token.attrs)) this.#leave()
    } else if ((token.tagID === TAG_ID.SVG && this.#ns[0] === NS.SVG) || (token.tagID === TAG_ID.MATH && this.#ns[0] === NS.MATHML)) {
      this.#leave()
    }
    this.#page.end(token.tagName.toLowerCase())
  }

  onCharacter(token: Token.CharacterToken): void {
    this.#skipNewLine = false
    this.#page.text(token.chars)
  }

  onNullCharacter(token: Token.CharacterToken): void {
    this.#skipNewLine = false
    this.#page.text(this.#foreign ? '\u{fffd}' : token.chars)
  }

  onWhitespaceCharacter(token: Token.CharacterToken): void {
    let chars = token.chars
    if (this.#skipNewLine && chars.startsWith('\n')) {
      this.#skipNewLine = false
      chars = chars.slice(1)
      if (chars === '') return
    }
    this.#page.text(chars)
  }

  onComment(): void {
    this.#skipNewLine = false
  }

  onDoctype(): void {
    this.#skipNewLine = false
  }

  onEof(): void {
    this.#skipNewLine = false
  }
}

/** v1's `_parse_page`: parses `text` into a Page in chunks of 65,536 characters, calling `tick` before each (the 10 s
 *  limit, and a turn of the event loop for other requests). Anything that stops the parse but the deadline (a link
 *  urljoin refuses, say) leaves what was read so far, without close(), as v1's `except Exception: pass` did. */
export async function parsePage(text: string, url: string, tick: () => Promise<void>): Promise<Page> {
  const page = new Page(url)
  const driver = new Driver(page)
  try {
    for (let i = 0; i < text.length; i += 1 << 16) {
      await tick()
      driver.tokenizer.write(text.slice(i, i + (1 << 16)), false)
    }
    driver.tokenizer.write('', true)
    page.close()
  } catch (e) {
    if (e instanceof ProductError) throw e
  }
  return page
}

/** v1's `_text_lines`: the visible text lines of an HTML fragment (a feed's description). */
export function textLines(fragment: string): string[] {
  const page = new Page('http://x/')
  const driver = new Driver(page)
  try {
    driver.tokenizer.write(fragment, true)
    page.close()
  } catch {
    // a broken fragment gives what was read (v1)
  }
  return page.lines
}
