// What was read from the page and its feeds before the size rules (v1's `_Doc`): metas, JSON-LD nodes (arrays and
// @graph unwrapped, a page's mainEntity product included), the product (a ProductGroup first), the microdata product,
// and the Shopify / WooCommerce feeds; plus v1's helpers over JSON values (`_text`, `_types`, `_mprop`).
import { pyStrip } from '../../../common/logic/pyfmt.ts'
import { HTML5_ENTITIES, INVALID_CHARREFS, INVALID_CODEPOINTS } from './entities.ts'
import type { MicroItem, Page } from './html.ts'
import { asList, get, has, isDict, isList, isNumber, or, toFloat, type PyDict } from './logic/py.ts'
import { loadsLenient, type PyValue } from './logic/pyjson.ts'
import { collapseWs } from './logic/text.ts'
import { pyUnescape } from './logic/unescape.ts'
import { fmtNum } from './sizes.ts'

const TABLES = { names: HTML5_ENTITIES, charrefs: INVALID_CHARREFS, dropped: INVALID_CODEPOINTS }

/** Python's `html.unescape`. */
export function unescape(s: string): string {
  return pyUnescape(s, TABLES)
}

/** v1's `_fmt(float(v))` for a JSON number; v1 raised (OverflowError, ValueError) on one that isn't finite. */
export function fmtFloat(v: bigint | number): string {
  const f = toFloat(v)
  if (!Number.isFinite(f)) throw new Error(`cannot round ${String(f)}`)
  return fmtNum(f)
}

/** v1's `_text`: a JSON value as one line of text (a dict's name or @value, a list's first, a number), or null. */
export function textOf(v: PyValue | undefined): string | null {
  if (typeof v === 'string') {
    const s = pyStrip(collapseWs(unescape(v)))
    return s === '' ? null : s
  }
  if (isDict(v)) return textOf(or(v.get('name'), v.get('@value')))
  if (isList(v) && v.length > 0) return textOf(v[0])
  if (isNumber(v)) return fmtFloat(v)
  return null
}

/** v1's `_types`: a node's @type names, lowercased, without their schema.org prefix. */
export function typesOf(node: PyValue | undefined): string[] {
  const t = get(node, '@type')
  const ts = isList(t) ? t : [t]
  const out: string[] = []
  for (const x of ts) {
    if (typeof x === 'string') out.push((x.split('/').at(-1) ?? '').toLowerCase())
  }
  return out
}

const PRODUCT_TYPES = new Set(['product', 'productgroup', 'individualproduct', 'productmodel', 'somethingproducts'])

/** v1's `_jsonld_nodes`: the top-level nodes of every block (arrays and @graph unwrapped, six levels at most; a node's
 *  mainEntity / mainEntityOfPage product included). */
function jsonldNodes(blocks: readonly string[]): PyDict[] {
  const nodes: PyDict[] = []
  const add = (x: PyValue | undefined, depth: number): void => {
    if (depth > 6) return
    if (isList(x)) {
      for (const y of x) add(y, depth + 1)
    } else if (isDict(x)) {
      if (x.has('@graph')) add(x.get('@graph'), depth + 1)
      if (x.has('@type')) {
        nodes.push(x)
        for (const key of ['mainEntity', 'mainEntityOfPage']) {
          const me = x.get(key)
          if (isDict(me) && me.has('@type') && typesOf(me).some((t) => t === 'product' || t === 'productgroup')) nodes.push(me)
        }
      }
    }
  }
  for (const b of blocks) {
    const data = loadsLenient(b)
    if (data !== null) add(data, 0)
  }
  return nodes
}

/** v1's `_walk_items`: every microdata item, depth first, each before its nested ones. */
function* walkItems(items: readonly MicroItem[]): Generator<MicroItem> {
  for (const it of items) {
    yield it
    for (const vals of it.props.values()) {
      for (const v of vals) {
        if (typeof v !== 'string') yield* walkItems([v])
      }
    }
  }
}

/** v1's `_mprop`: a microdata item's values of one property ([] without the item). */
export function mprop(item: MicroItem | null, name: string): readonly (string | MicroItem)[] {
  return item?.props.get(name) ?? []
}

/** v1's `_Doc`. */
export class Doc {
  readonly page: Page
  readonly url: string
  /** The first content of each meta key. */
  readonly meta: ReadonlyMap<string, string>
  readonly nodes: readonly PyDict[]
  /** Nodes by their @id (the last one wins). */
  readonly ids: ReadonlyMap<string, PyDict>
  /** The product node: the first ProductGroup, else the first product. */
  readonly product: PyDict | null
  /** The first microdata product. */
  readonly micro: MicroItem | null
  shopify: PyDict | null = null
  woo: PyDict | null = null

  constructor(page: Page, url: string) {
    this.page = page
    this.url = url
    const meta = new Map<string, string>()
    for (const [k, v] of page.metas) if (!meta.has(k)) meta.set(k, v)
    this.meta = meta
    this.nodes = jsonldNodes(page.ld)
    const ids = new Map<string, PyDict>()
    for (const n of this.nodes) {
      const id = n.get('@id')
      if (typeof id === 'string') ids.set(id, n)
    }
    this.ids = ids
    const products = this.nodes.filter((n) => typesOf(n).some((t) => PRODUCT_TYPES.has(t)))
    const groups = products.filter((n) => typesOf(n).includes('productgroup'))
    this.product = groups[0] ?? products[0] ?? null
    let micro: MicroItem | null = null
    for (const it of walkItems(page.items)) {
      const t = it.type !== '' ? (it.type.split('/').at(-1) ?? '').toLowerCase() : ''
      if (t === 'product' || t === 'productgroup' || t === 'individualproduct') {
        micro = it
        break
      }
    }
    this.micro = micro
  }
}

/** `p.get(key)` on the product node, or undefined without one. */
export function productField(doc: Doc, key: string): PyValue | undefined {
  return doc.product?.get(key)
}

export { asList, get, has }
