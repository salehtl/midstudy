// The structured size layers (contract §2.11 layer 2, Order, Mapping): v1's `_jsonld_sizes`, `_explicit`, `_single`,
// `_microdata_sizes`, `_shopify_sizes`, `_woo_sizes` and `_link_variant`. The size rules themselves are the Rust reader's
// (sizes.ts); these read the structured values and decide which text is a size option.
import { pyStrip } from '../../../common/logic/pyfmt.ts'
import { unquote, urlsplit } from '../logic/url.ts'
import { type Doc, mprop, textOf, unescape } from './doc.ts'
import type { MicroItem } from './html.ts'
import { asList, isDict, isList, isNumber, or, pyStr, toFloat, truthy, type PyDict } from './logic/py.ts'
import type { PyValue } from './logic/pyjson.ts'
import { collapseWs, cpPrefix, squash } from './logic/text.ts'
import * as sizes from './sizes.ts'
import type { Part, Reading, Unit } from './sizes.ts'

/** v1's `_Ctx`: the page's rug and bed flags and unit hint, and its warnings (shared with the answer). */
export class Ctx {
  readonly size: sizes.SizeCtx
  readonly warnings: string[]
  #unitlessDropped = false

  constructor(isRug: boolean, hint: Unit | null, warnings: string[], isBed = false) {
    this.size = { is_rug: isRug, hint, is_bed: isBed }
    this.warnings = warnings
  }

  /** v1's `drop_unitless`: the warning, once. */
  dropUnitless(): void {
    if (!this.#unitlessDropped) {
      this.#unitlessDropped = true
      this.warnings.push("a size without a unit was left out: the page doesn't say what it measures in")
    }
  }

  /** What a reading attempt gave, with its unitless warning. */
  took(made: sizes.Made): Reading | null {
    if (made.dropped_unitless) this.dropUnitless()
    return made.reading
  }
}

/** v1's `_parse_size_text`: a structured size string ("W 48 x D 55 x H 82 cm", "7' 6\" x 9' 6\"", "3*4"). */
function parseSize(text: string, ctx: Ctx, source: string, label: string | null = null, pairOk = true, warnUnitless = true): Reading | null {
  const prepared = squash(cpPrefix(unescape(text), 2000))
  return ctx.took(sizes.parseSizeText(prepared, ctx.size, source, label, pairOk, warnUnitless))
}

/** v1's `_make_reading` (warnings on). */
function make(parts: readonly Part[], ctx: Ctx, source: string, quote: string): Reading | null {
  return ctx.took(sizes.makeReading(parts, ctx.size, source, quote, null, true, true))
}

const UNIT_CODE: ReadonlyMap<string, Unit> = new Map([
  ['cmt', 'cm'], ['mmt', 'mm'], ['mtr', 'm'], ['inh', 'in'], ['fot', 'ft'], ['cm', 'cm'], ['mm', 'mm'], ['m', 'm'], ['in', 'in'],
  ['inch', 'in'], ['inches', 'in'], ['ft', 'ft'], ['feet', 'ft'], ['foot', 'ft'], ['centimeters', 'cm'], ['centimetres', 'cm'],
  ['millimeters', 'mm'], ['millimetres', 'mm'], ['meters', 'm'], ['metres', 'm'],
])

/** One structured measurement: [value, unit, the number as written]. */
type Single = readonly [number, Unit | null, string]

/** v1's `_single`: "80 cm", "31 1/2 \"", 120 with a unitCode, a QuantitativeValue (its value, @value or minValue). */
function single(value: PyValue | undefined, unitHint: Unit | null = null): Single | null {
  if (isDict(value)) {
    let v = value.get('value')
    if ((v === undefined || v === null) && value.has('@value')) v = value.get('@value')
    v ??= value.get('minValue')
    const code = pyStrip(pyStr(or(or(value.get('unitCode'), value.get('unitText')), ''))).toLowerCase()
    const unit = UNIT_CODE.get(code) ?? unitHint
    const got = single(v, unit)
    if (got === null) return null
    return [got[0], got[1] ?? unit, got[2]]
  }
  if (typeof value === 'boolean') return null
  if (isNumber(value)) {
    const f = toFloat(value)
    return f > 0 && Number.isFinite(f) ? [f, unitHint, sizes.fmtNum(f)] : null
  }
  if (typeof value === 'string') {
    const got = sizes.firstItem(squash(cpPrefix(unescape(value), 2000)))
    if (got === null) return null
    return [got[0], got[1] ?? unitHint, got[2]]
  }
  if (isList(value) && value.length > 0) return single(value[0], unitHint)
  return null
}

function quotePart(key: string, got: Single): string {
  return `${key}: ${got[2]}${got[1] !== null ? ' ' + got[1] : ''}`
}

/** The axis key of width / depth / height / length (v1's `_axis` of those words). */
function axisKey(word: string): string {
  const w = word.toLowerCase()
  return w === 'width' ? 'w' : w === 'depth' ? 'd' : w === 'height' ? 'h' : 'l'
}

/** v1's `_explicit`: width / depth / height (and length) as text or QuantitativeValue. */
function explicit(node: PyDict, ctx: Ctx, source: string): Reading | null {
  const parts: Part[] = []
  const quote: string[] = []
  for (const key of ['width', 'depth', 'height', 'length']) {
    if (key === 'length' && !isNone(node.get('width')) && !isNone(node.get('depth'))) continue
    const got = single(node.get(key))
    if (got !== null) {
      parts.push({ axis: axisKey(key), value: got[0], unit: got[1], text: got[2] })
      quote.push(quotePart(key, got))
    }
  }
  if (parts.length === 0) return null
  return make(parts, ctx, source, quote.join(', '))
}

function isNone(v: PyValue | undefined): boolean {
  return v === undefined || v === null
}

/** Python's `d.get(key, default)`: the default only when the key is missing (a JSON null stays None). */
function getOr(d: PyDict, key: string, dflt: PyValue): PyValue {
  return d.has(key) ? d.get(key) ?? null : dflt
}

/** The shop's size options and the other readings, as v1's `_Sizes` held them. */
export class Sizes {
  /** The shop's size options in its order: [label, reading or null]. */
  variants: [string, Reading | null][] = []
  /** JSON-LD and microdata, then text, then llm. */
  readonly cands: Reading[] = []
  /** The feeds' own sizes (WooCommerce dimensions). */
  readonly feed: Reading[] = []
}

const PY_S = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}]'
const I = '[i\\u{131}\\u{130}]'
const SIZE_NAME = new RegExp(`^${PY_S}*s${I}ze${PY_S}*$`, 'iu')
const OFFER_TAIL = new RegExp(`${PY_S}+[-\\u{2013}\\u{2014}/|]${PY_S}+`, 'u')
const SIZE_PROP = new RegExp(`^${PY_S}*(?:overall${PY_S}+|product${PY_S}+)?(?:s${I}ze|d${I}mens${I}ons?)${PY_S}*$`, 'iu')
const AXIS_PROP = new RegExp(`^${PY_S}*(?:overall${PY_S}+|product${PY_S}+|${I}tem${PY_S}+)?(w${I}dth|depth|he${I}ght|length)${PY_S}*(?:\\(${PY_S}*(cm|mm|m|${I}n|${I}nch|${I}nches|ft|feet)${PY_S}*\\)|${I}n${PY_S}+(cm|mm|${I}nches))?${PY_S}*:?${PY_S}*$`, 'iu')

/** Python's `re.split(r"\s+[-–—/|]\s+", s)[-1]`: the last part of an offer or variant name. */
function lastPart(s: string): string {
  return s.split(OFFER_TAIL).at(-1) ?? ''
}

/** v1's `_jsonld_sizes`: hasVariant sizes or offer names as the shop's options, explicit width/depth/height, `size`,
 *  and additionalProperty sizes and singles. */
export function jsonldSizes(doc: Doc, ctx: Ctx, sz: Sizes, used: Set<string>): void {
  const p = doc.product
  if (p === null) return
  if (sz.variants.length === 0) {
    const vs: [string, Reading | null][] = []
    for (const v of asList(p.get('hasVariant'))) {
      if (!isDict(v)) continue
      const size = textOf(v.get('size'))
      let label = size
      let r = size !== null ? parseSize(size, ctx, 'jsonld') : null
      if (r === null) {
        r = explicit(v, ctx, 'jsonld')
        if (r !== null && label === null) label = textOf(v.get('name'))
      }
      if (label !== null) vs.push([label, r])
    }
    if (vs.length === 0) {
      const offers: PyDict[] = []
      for (const o of asList(p.get('offers'))) {
        if (isDict(o) && o.has('offers')) {
          for (const x of asList(o.get('offers'))) if (isDict(x)) offers.push(x)
        } else if (isDict(o)) {
          offers.push(o)
        }
      }
      for (const o of offers) {
        let size: string | null = null
        for (const prop of asList(o.get('additionalProperty'))) {
          if (isDict(prop) && SIZE_NAME.test(pyStr(getOr(prop, 'name', '')))) size = textOf(prop.get('value'))
        }
        const name = textOf(o.get('name'))
        if (size === null && name !== null) {
          const tail = lastPart(name)
          if (parseSize(tail, new Ctx(ctx.size.is_rug, ctx.size.hint, []), 'jsonld', null, true, false) !== null) size = tail
        }
        if (size !== null) vs.push([size, parseSize(size, ctx, 'jsonld', size)])
      }
    }
    const seen = new Set<string>()
    const uniq: [string, Reading | null][] = []
    for (const [label, r] of vs) {
      const k = collapseWs(label.toLowerCase())
      if (sizes.matches('sample', label)) continue
      if (!seen.has(k)) {
        seen.add(k)
        uniq.push([label, r])
      }
    }
    if (uniq.length > 1 || (uniq.length > 0 && uniq[0]?.[1] !== null)) {
      sz.variants = uniq
      used.add('jsonld')
    }
  }
  const r = explicit(p, ctx, 'jsonld')
  if (r !== null) {
    sz.cands.push(r)
    used.add('jsonld')
  }
  for (const s of asList(p.get('size'))) {
    const t = textOf(s)
    const got = t !== null ? parseSize(t, ctx, 'jsonld') : null
    if (got !== null) {
      sz.cands.push(got)
      used.add('jsonld')
    }
  }
  const singles: Part[] = []
  const quotes: string[] = []
  for (const prop of asList(p.get('additionalProperty'))) {
    if (!isDict(prop)) continue
    const name = textOf(prop.get('name')) ?? ''
    if (sizes.matches('distract', name)) continue
    if (SIZE_PROP.test(name)) {
      const got = parseSize(textOf(prop.get('value')) ?? '', ctx, 'jsonld')
      if (got !== null) {
        sz.cands.push(got)
        used.add('jsonld')
      }
    } else {
      const m = AXIS_PROP.exec(name)
      if (m !== null) {
        const unitWord = m[2] ?? m[3]
        const got = single(prop, unitWord !== undefined ? sizes.unitOf(unitWord) : null)
        if (got !== null) {
          const axis = sizes.axisOf(m[1] ?? '')
          singles.push({ axis, value: got[0], unit: got[1], text: got[2] })
          quotes.push(pyStrip(`${axis ?? 'None'} ${got[2]} ${got[1] ?? ''}`))
        }
      }
    }
  }
  if (singles.length > 0) {
    const got = make(singles, ctx, 'jsonld', quotes.join('; '))
    if (got !== null) {
      sz.cands.push(got)
      used.add('jsonld')
    }
  }
}

/** v1's `_microdata_sizes`: itemprop width/depth/height (text or a QuantitativeValue item) and size. */
export function microdataSizes(doc: Doc, ctx: Ctx, sz: Sizes, used: Set<string>): void {
  const it = doc.micro
  if (it === null) return
  const parts: Part[] = []
  const quote: string[] = []
  for (const key of ['width', 'depth', 'height', 'length']) {
    const vals = mprop(it, key)
    if (vals.length === 0 || (key === 'length' && mprop(it, 'width').length > 0)) continue
    const v = vals[0]
    let got: Single | null = null
    if (v !== undefined && typeof v !== 'string') {
      const val = firstOf(v.props.get('value'))
      const codeList = v.props.get('unitCode')
      const code = firstOf(codeList !== undefined && codeList.length > 0 ? codeList : v.props.get('unitText')) ?? ''
      if (typeof val === 'string') got = single(new Map<string, PyValue>([['value', val], ['unitCode', typeof code === 'string' ? code : '']]))
    } else if (typeof v === 'string') {
      got = single(v)
    }
    if (got !== null) {
      parts.push({ axis: axisKey(key), value: got[0], unit: got[1], text: got[2] })
      quote.push(quotePart(key, got))
    }
  }
  if (parts.length > 0) {
    const r = ctx.took(sizes.makeReading(parts, ctx.size, 'microdata', quote.join(', '), null, true, true))
    if (r !== null) {
      sz.cands.push(r)
      used.add('microdata')
    }
  }
  for (const s of mprop(it, 'size')) {
    if (typeof s === 'string') {
      const r = parseSize(s, ctx, 'microdata')
      if (r !== null) {
        sz.cands.push(r)
        used.add('microdata')
      }
    }
  }
}

/** `(props.get(k) or [None])[0]`. */
function firstOf(list: readonly (string | MicroItem)[] | undefined): string | MicroItem | undefined {
  return list !== undefined && list.length > 0 ? list[0] : undefined
}

/** v1's `_shopify_sizes`: the feed's options named Size/Dimensions as the shop's size options. */
export function shopifySizes(doc: Doc, ctx: Ctx, sz: Sizes, used: Set<string>): void {
  const f = doc.shopify
  if (f === null) return
  for (const opt of asList(f.get('options'))) {
    if (isDict(opt) && sizes.matches('size_opt', pyStr(getOr(opt, 'name', '')))) {
      const values: string[] = []
      for (const v of asList(opt.get('values'))) {
        if ((typeof v === 'string' || isNumber(v) || typeof v === 'boolean') && !sizes.matches('sample', pyStr(v))) values.push(pyStr(v))
      }
      const vs: [string, Reading | null][] = values.map((v) => [v, parseSize(v, ctx, 'shopify', v)])
      if (vs.length > 1 || (vs.length > 0 && vs[0]?.[1] !== null)) {
        sz.variants = vs
        used.add('shopify')
      }
      break
    }
  }
}

const WOO_UNIT = new RegExp(`(cm|mm|m|${I}n|${I}nch(?:es)?|ft)${PY_S}*$`, 'iu')

/** v1's `_woo_sizes`: size attributes' terms (the default first) as the shop's options, and `dimensions` (length ×
 *  width × height, read as W × D × H). */
export function wooSizes(doc: Doc, ctx: Ctx, sz: Sizes, used: Set<string>): void {
  const f = doc.woo
  if (f === null) return
  if (sz.variants.length === 0) {
    for (const att of asList(f.get('attributes'))) {
      if (!isDict(att) || !sizes.matches('size_opt', pyStr(getOr(att, 'name', '')) + ' ' + pyStr(getOr(att, 'taxonomy', '')))) continue
      const terms = asList(att.get('terms')).filter((t): t is PyDict => isDict(t) && truthy(t.get('name')) && !sizes.matches('sample', pyStr(t.get('name'))))
      const ordered = [...terms].sort((a, b) => (truthy(a.get('default')) ? 0 : 1) - (truthy(b.get('default')) ? 0 : 1))
      const vs: [string, Reading | null][] = ordered.map((t) => {
        const name = pyStr(t.get('name'))
        return [unescape(name), parseSize(name, ctx, 'woocommerce', unescape(name))]
      })
      if (vs.length > 1 || (vs.length > 0 && vs[0]?.[1] !== null)) {
        sz.variants = vs
        used.add('woocommerce')
      }
      break
    }
  }
  const dims = f.get('dimensions')
  if (!isDict(dims)) return
  const vals = ['length', 'width', 'height'].map((k) => sizes.pyNum(pyStr(or(dims.get(k), ''))))
  const [l, w, h] = vals
  if (l === null || l === undefined || l === 0 || w === null || w === undefined || w === 0) return
  const fmt = unescape(pyStr(or(f.get('formatted_dimensions'), '')))
  const m = WOO_UNIT.exec(pyStrip(fmt))
  const unit = m?.[1] !== undefined ? sizes.unitOf(m[1]) : null
  const parts: Part[] = [{ axis: null, value: l, unit, text: sizes.fmtNum(l) }, { axis: null, value: w, unit, text: sizes.fmtNum(w) }]
  if (h !== null && h !== undefined && h !== 0) parts.push({ axis: null, value: h, unit, text: sizes.fmtNum(h) })
  const quote = fmt !== '' ? fmt : `length ${pyStr(dims.get('length'))}, width ${pyStr(dims.get('width'))}, height ${pyStr(dims.get('height'))}`
  const r = make(parts, ctx, 'woocommerce', quote)
  if (r !== null) {
    r.notes = [...r.notes.filter((n) => !n.startsWith('read as')), 'WooCommerce length \u{d7} width \u{d7} height read as W \u{d7} D \u{d7} H']
    sz.feed.push(r)
    used.add('woocommerce')
  }
}

/** Python's `re.escape`. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

function norm(s: string): string {
  return pyStrip(collapseWs(s)).toLowerCase()
}

/** v1's `_link_variant`: the size option the link names (Shopify `?variant=<id>`, JSON-LD variant or offer urls,
 *  WooCommerce `?attribute_pa_<size>=<slug>`) moves to the front, with a note. */
export function linkVariant(doc: Doc, sz: Sizes): void {
  if (sz.variants.length < 2) return
  const q = new Map<string, string>()
  for (const part of (urlsplit(doc.url)?.query ?? '').split('&')) {
    const eq = part.indexOf('=')
    const k = eq < 0 ? part : part.slice(0, eq)
    const v = eq < 0 ? '' : part.slice(eq + 1)
    if (k !== '' && v !== '') {
      const key = unquote(k).toLowerCase()
      if (!q.has(key)) q.set(key, unquote(v.replace(/\+/g, ' ')))
    }
  }
  let label: PyValue | undefined = undefined
  const none = (): boolean => label === undefined || label === null
  const vid = q.get('variant')
  if (vid !== undefined && vid !== '' && doc.shopify !== null) {
    const options = asList(doc.shopify.get('options'))
    let pos = 0
    for (let i = 0; i < options.length; i++) {
      const o = options[i]
      if (isDict(o) && sizes.matches('size_opt', pyStr(getOr(o, 'name', '')))) {
        pos = i + 1
        break
      }
    }
    for (const v of asList(doc.shopify.get('variants'))) {
      if (isDict(v) && pyStr(v.get('id')) === vid && pos !== 0) label = v.get(`option${String(pos)}`)
    }
  }
  if (vid !== undefined && vid !== '' && none() && doc.product !== null) {
    const linked = new RegExp(`[?&]variant=${reEscape(vid)}(?:&|(?=\\n?$)|#)`, 'u')
    for (const v of [...asList(doc.product.get('hasVariant')), ...asList(doc.product.get('offers'))]) {
      if (isDict(v) && linked.test(pyStr(or(or(v.get('url'), v.get('@id')), '')))) {
        label = textOf(v.get('size')) ?? (lastPart(textOf(v.get('name')) ?? '') || null)
        break
      }
    }
  }
  if (none() && doc.woo !== null) {
    for (const att of asList(doc.woo.get('attributes'))) {
      if (!isDict(att)) continue
      const slug = or(q.get(`attribute_${pyStr(getOr(att, 'taxonomy', ''))}`.toLowerCase()), q.get(`attribute_${pyStr(getOr(att, 'name', '')).toLowerCase()}`))
      for (const term of asList(att.get('terms'))) {
        if (truthy(slug) && isDict(term) && pyStr(term.get('slug')) === slug) label = unescape(pyStr(term.get('name')))
      }
    }
  }
  if (typeof label !== 'string') return
  const want = norm(label)
  for (let i = 0; i < sz.variants.length; i++) {
    const entry = sz.variants[i]
    if (entry === undefined) continue
    const lab = norm(entry[0])
    if (lab === want || want.startsWith(lab) || lab.startsWith(want)) {
      if (i > 0) {
        sz.variants.splice(i, 1)
        sz.variants.unshift(entry)
      }
      entry[1]?.notes.push('the size picked in the link')
      return
    }
  }
}

