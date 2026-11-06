// What a page says (contract §2.11): v1's `_extract` (name, category and rug, pictures, sizes layer by layer, the
// language model when nothing else gave a size, the merged candidates), `_feeds` (the Shopify `.js` and WooCommerce
// Store API feeds, origin only) and `_is_robot_check`.
import { pyRound, pySplitlines, pyStrip } from '../../../common/logic/pyfmt.ts'
import type { ServerDeps } from '../deps.ts'
import { originOf, type Budget } from '../fetch.ts'
import { unquote, urlHostname, urlsplit } from '../logic/url.ts'
import { charsetOf, decodeBody } from './decode.ts'
import { Doc, mprop, textOf, typesOf, unescape } from './doc.ts'
import { ProductError, PageTimeout, type Deadline } from './errors.ts'
import { textLines } from './html.ts'
import { Images, jsonldImages, px, type ImageOut } from './images.ts'
import { Ctx, Sizes, jsonldSizes, linkVariant, microdataSizes, shopifySizes, wooSizes } from './layers.ts'
import { runLlm } from './llm.ts'
import { asList, isDict, isList, pyStr, truthy } from './logic/py.ts'
import { pyLoads, type PyValue } from './logic/pyjson.ts'
import { collapse, collapseWs, cpLength, cpPrefix, digitsValue, squash } from './logic/text.ts'
import { contentTypeOf, fetchFeed } from './pagefetch.ts'
import { scriptStrings } from './scripts.ts'
import * as sizes from './sizes.ts'
import type { ReadingOut } from './sizes.ts'

/** The 200 body (product-result.schema.json). */
export interface ProductResult {
  readonly url: string
  readonly name: string | null
  readonly category: string | null
  readonly is_rug: boolean
  readonly dims_candidates: readonly ReadingOut[]
  readonly variants: readonly { readonly label: string; readonly dims_index: number | null }[]
  readonly images: readonly ImageOut[]
  readonly source_layers_used: readonly string[]
  readonly cost_usd: number
  readonly mock: boolean
  readonly warnings: readonly string[]
}

const PY_S = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}]'
const PY_W = '[\\p{L}\\p{N}_]'
/** Python's `\b` (on `\w` = letters, numbers and _). */
export const PY_B = `(?:(?<=${PY_W})(?!${PY_W})|(?<!${PY_W})(?=${PY_W}))`
const TITLE_SEP = new RegExp(`${PY_S}+(?:-|\\||\\u{2013}|\\u{2014}|:|::|\\u{b7}|\\u{2022})${PY_S}+`, 'u')

/** Python's `re.escape` for a JS pattern in unicode mode. */
function reEscape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
}

/** v1's `_strip_site`: a shop name at the end of the product name (" - Zennova Carpets") left out, twice over. */
function stripSite(nameIn: string, sites: readonly string[]): string {
  let name = nameIn
  for (let pass = 0; pass < 2; pass++) {
    for (const raw of sites) {
      const s = pyStrip(raw)
      if (s === '' || cpLength(s) >= cpLength(name)) continue
      const m = new RegExp(`${PY_S}+(?:-|\\||\\u{2013}|\\u{2014}|:|::|\\u{b7}|\\u{2022})${PY_S}+${reEscape(s)}${PY_S}*$`, 'iu').exec(name)
      if (m !== null && m.index > 0) name = pyStrip(name.slice(0, m.index))
    }
  }
  return name
}

const REFINES: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['chair', new Set(['armchair'])],
  ['table', new Set(['bedside table', 'coffee table', 'side table', 'dining table', 'desk'])],
  ['shelf', new Set(['bookcase'])],
  ['cabinet', new Set(['sideboard', 'tv stand', 'wardrobe', 'bedside table'])],
])

const SRCSET_W = /^\p{Nd}+w$/u
const COMMON_WORDS = new Set(['the', 'and', 'for', 'with', 'products', 'product', 'html', 'www', 'com'])

/** v1's `_feed_json`: a feed's JSON, or null with a warning. */
async function feedJson(url: string, origin: string, budget: Budget, warnings: string[], shop: string): Promise<PyValue> {
  const what = `the ${shop} product feed`
  if (budget.over()) {
    warnings.push(`${what} wasn't read: the 20 s for reading the page ran out`)
    return null
  }
  let r
  try {
    r = await fetchFeed(url, budget, origin)
  } catch (e) {
    if (e instanceof PageTimeout) {
      warnings.push(`${what} didn't answer within the page's 20 s, so it was skipped`)
      return null
    }
    if (e instanceof ProductError) {
      warnings.push(`${what} was skipped: ${e.message}`)
      return null
    }
    throw e
  }
  if (r.status !== 200) {
    warnings.push(`${what} answered HTTP ${String(r.status)}, so it was skipped` + (r.status === 429 ? " (the shop limits how often it's read)" : ''))
    return null
  }
  const ctype = contentTypeOf(r)
  if (!['application/json', 'text/javascript', 'application/javascript', 'text/json', 'application/x-javascript'].includes(ctype)) {
    warnings.push(`${what} isn't JSON (${ctype !== '' ? ctype : 'untyped'}), so it was skipped`)
    return null
  }
  if (r.cut) {
    warnings.push(`${what} is over 2 MB, so it was skipped`)
    return null
  }
  try {
    return pyLoads(decodeBody(r.body, charsetOf(r.headers['content-type'] ?? '', r.body)).replace(/^\u{feff}+/u, ''), true)
  } catch {
    warnings.push(`${what} isn't valid JSON, so it was skipped`)
    return null
  }
}

/** Python's `quote(s, safe='')`: everything but letters, digits and `_.-~` percent-encoded (UTF-8). */
function pyQuote(s: string): string {
  let out = ''
  for (const b of Buffer.from(s, 'utf8')) {
    const c = String.fromCharCode(b)
    out += /^[A-Za-z0-9_.\-~]$/.test(c) ? c : '%' + b.toString(16).toUpperCase().padStart(2, '0')
  }
  return out
}

/** v1's `_feeds`: the Shopify and WooCommerce feeds, when the page shows it is one. */
export async function readFeeds(doc: Doc, raw: string, budget: Budget, warnings: string[]): Promise<void> {
  const origin = originOf(doc.url)
  const p = urlsplit(doc.url)
  const pathOnly = (p?.path ?? '').replace(/\/+$/, '') || '/'
  if (raw.includes('cdn.shopify.com') || raw.includes('Shopify.')) {
    if (pathOnly !== '/' && !pathOnly.endsWith('.js')) {
      const data = await feedJson(origin + pathOnly + '.js', origin, budget, warnings, 'Shopify')
      if (isDict(data) && (truthy(data.get('title')) || truthy(data.get('variants')))) doc.shopify = data
    }
  }
  if (raw.toLowerCase().includes('woocommerce') || raw.includes('/wp-json/')) {
    const slug = (p?.path ?? '').split('/').filter((s) => s !== '').at(-1)
    if (slug !== undefined) {
      let data = await feedJson(`${origin}/wp-json/wc/store/v1/products?slug=${pyQuote(unquote(slug))}`, origin, budget, warnings, 'WooCommerce')
      if (isList(data)) {
        const want = unquote(slug)
        const first = data[0]
        data = data.find((x) => isDict(x) && unquote(pyStr(x.has('slug') ? x.get('slug') : '')) === want) ?? (first !== undefined && isDict(first) ? first : null)
      }
      if (isDict(data) && truthy(data.get('name'))) doc.woo = data
    }
  }
}

/** v1's `_is_robot_check`: no product data, and robot-check words in the title, the first lines or the source. */
export function isRobotCheck(doc: Doc, raw: string): boolean {
  if (doc.product !== null || doc.micro !== null || (doc.meta.get('og:title') ?? '') !== '' || (doc.meta.get('og:image') ?? '') !== '') return false
  const probe = [doc.page.title ?? '', ...doc.page.lines.slice(0, 40)].join(' ') + ' ' + cpPrefix(raw, 20000)
  return sizes.matches('robot', probe)
}

/** The page's bytes as text (v1: `_decode(r.body, _charset(...))`). */
export function pageText(body: Uint8Array, contentType: string): string {
  return decodeBody(body, charsetOf(contentType, body))
}

/** v1's `_extract`: the answer for a parsed page. */
export async function extract(doc: Doc, warnings: string[], llm: boolean, deps: ServerDeps, deadline: Deadline): Promise<ProductResult> {
  const used = new Set<string>()
  const { product: p, micro, page, meta } = doc
  // --- name
  const sites: string[] = [meta.get('og:site_name') ?? '']
  for (const n of doc.nodes) {
    if (typesOf(n).some((t) => t === 'organization' || t === 'website' || t === 'store' || t === 'onlinestore')) sites.push(textOf(n.get('name')) ?? '')
  }
  const title = page.title ?? ''
  const tparts = title.split(TITLE_SEP)
  const suffix = tparts.at(-1) ?? ''
  if (tparts.length > 1 && cpLength(suffix) <= 40) {
    const squashed = suffix.toLowerCase().replace(/[^a-z0-9]/gu, '')
    const hostParts = urlsplit(doc.url)
    const host = (hostParts === null ? '' : urlHostname(hostParts) ?? '').toLowerCase().replace(/[^a-z0-9]/gu, '')
    const inHost = squashed !== '' && host.includes(squashed)
    if ((page.h1 !== null && page.h1 !== '' && !page.h1.toLowerCase().endsWith(suffix.toLowerCase())) || inHost) sites.push(suffix)
  }
  const siteNames = sites.filter((s) => s !== '')
  let name: string | null = null
  let nameLayer: string | null = null
  const microName = mprop(micro, 'name')[0]
  const candidates: [string, PyValue | undefined][] = [
    ['shopify', doc.shopify?.get('title')],
    ['woocommerce', doc.woo?.get('name')],
    ['jsonld', p?.get('name')],
    ['microdata', typeof microName === 'string' ? microName : null],
    ['opengraph', meta.get('og:title')],
    ['title', title],
  ]
  for (const [layer, v] of candidates) {
    const t = textOf(v)
    if (t !== null) {
      name = stripSite(t, siteNames) || t
      nameLayer = layer
      break
    }
  }
  if (nameLayer !== null) used.add(nameLayer)
  // --- category and rug
  const texts: string[] = []
  if (name !== null) texts.push(name)
  for (const v of asList(p?.get('category'))) {
    const t = textOf(v)
    if (t !== null) texts.push(t)
  }
  for (const n of doc.nodes) {
    if (!typesOf(n).includes('breadcrumblist')) continue
    const crumbs: (string | null)[] = []
    for (const li of asList(n.get('itemListElement'))) {
      if (!isDict(li)) continue
      const item = li.get('item')
      crumbs.push(textOf(li.get('name')) ?? (isDict(item) ? textOf(item.get('name')) : null))
    }
    for (const c of [...crumbs].reverse()) if (c !== null && c !== '') texts.push(c)
  }
  if (doc.shopify !== null) texts.push(textOf(doc.shopify.get('type')) ?? '')
  if (doc.woo !== null) {
    for (const c of asList(doc.woo.get('categories'))) if (isDict(c)) texts.push(textOf(c.get('name')) ?? '')
  }
  for (const v of mprop(micro, 'category')) if (typeof v === 'string') texts.push(v)
  const cats = texts.filter((t) => t !== '').map((t) => sizes.categoryOf(t))
  const isRug = cats.includes('rug')
  let category: string | null = null
  if (isRug) {
    category = 'rug'
  } else {
    const found = cats.filter((c): c is string => c !== null)
    category = found[0] ?? null
    for (const c of found.slice(1)) {
      if (category !== null && REFINES.get(category)?.has(c) === true) {
        category = c
        break
      }
    }
  }
  // --- pictures
  const imgs = new Images(page.base, used, process.env['MIDSTUDY_FETCH_ALLOW'] ?? '')
  if (p !== null) {
    for (const [u, w, h] of jsonldImages(p.get('image'), doc.ids)) imgs.add(u, 'product', 'jsonld', w, h)
    for (const v of asList(p.get('hasVariant'))) {
      if (isDict(v)) for (const [u, w, h] of jsonldImages(v.get('image'), doc.ids)) imgs.add(u, 'variant', 'jsonld', w, h)
    }
  }
  for (const v of mprop(micro, 'image')) {
    if (typeof v === 'string') {
      imgs.add(v, 'product', 'microdata')
    } else {
      const contentUrl = v.props.get('contentUrl')
      const list = contentUrl !== undefined && contentUrl.length > 0 ? contentUrl : v.props.get('url') ?? []
      for (const u of list) imgs.add(typeof u === 'string' ? u : null, 'product', 'microdata')
    }
  }
  if (doc.shopify !== null) {
    for (const u of asList(doc.shopify.get('images'))) imgs.add(typeof u === 'string' ? u : isDict(u) ? u.get('src') : null, 'product', 'shopify')
    for (const v of asList(doc.shopify.get('variants'))) {
      const fi = isDict(v) ? v.get('featured_image') : undefined
      if (isDict(fi)) imgs.add(fi.get('src'), 'variant', 'shopify', fi.get('width'), fi.get('height'))
    }
  }
  if (doc.woo !== null) {
    for (const im of asList(doc.woo.get('images'))) if (isDict(im)) imgs.add(im.get('src'), 'product', 'woocommerce')
  }
  const og: { url: string; w: string | null; h: string | null }[] = []
  for (const [k, v] of page.metas) {
    const last = og.at(-1)
    if (k === 'og:image' || k === 'og:image:url') og.push({ url: v, w: null, h: null })
    else if (last !== undefined && k === 'og:image:secure_url' && pyStrip(v).toLowerCase().startsWith('https:')) last.url = v
    else if (last !== undefined && k === 'og:image:width') last.w = v
    else if (last !== undefined && k === 'og:image:height') last.h = v
  }
  for (const o of og) imgs.add(o.url, 'og', 'opengraph', o.w, o.h)
  const urlPath = urlsplit(doc.url)?.path ?? ''
  const words = new Set((((name ?? '').toLowerCase() + ' ' + urlPath.toLowerCase()).match(/[a-z0-9]{3,}/g) ?? []).filter((w) => !COMMON_WORDS.has(w)))
  for (const a of page.imgs) {
    const pick = (...keys: string[]): string | null => {
      for (const k of keys) {
        const v = a.get(k)
        if (v !== undefined && v !== '') return v
      }
      return null
    }
    let src = pick('data-large_image', 'data-zoom-image', 'data-src', 'data-original', 'src')
    let w = px(pick('data-large_image_width', 'width'))
    let h = px(pick('data-large_image_height', 'height'))
    let best: [string, number] | null = null
    for (const part of (pick('srcset', 'data-srcset') ?? '').split(',')) {
      const bits = pyStrip(part).split(/[\t\n\v\f\r\x1c-\x1f \x85\xa0\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}]+/u).filter((b) => b !== '')
      const size = bits[1]
      const first = bits[0]
      if (bits.length === 2 && first !== undefined && size !== undefined && SRCSET_W.test(size)) {
        const n = digitsValue(size.slice(0, -1))
        if (best === null || n > best[1]) best = [first, n]
      }
    }
    if (best !== null && (w === null || w === 0 || best[1] > w)) {
      src = src ?? best[0]
      w = best[1]
      h = null
    }
    if (src === null || Math.max(w ?? 0, h ?? 0) < 500 || !/[/.]/.test(src)) continue
    const srcParts = urlsplit(unescape(src))
    if (srcParts === null) throw new Error(`urlsplit refused ${src}`) // v1's ValueError
    const srcPath = srcParts.path
    const fname = (srcPath.split('/').at(-1) ?? '').toLowerCase() + ' ' + (a.get('alt') ?? '').toLowerCase()
    if (words.size > 0 && [...words].some((wd) => fname.includes(wd))) imgs.add(src, 'page', null, w, h)
  }
  if (name === null && imgs.list.length === 0) throw new ProductError(422, 'that page holds no product: no name and no picture were found on it')
  // --- sizes
  const extra: string[] = []
  for (const f of [doc.shopify, doc.woo]) {
    if (f === null) continue
    for (const k of ['description', 'short_description', 'body_html']) {
      const v = f.get(k)
      if (typeof v === 'string') extra.push(...textLines(v))
    }
  }
  for (const k of ['og:description', 'description']) {
    const v = meta.get(k)
    if (v !== undefined && v !== '') extra.push(squash(unescape(v)))
  }
  for (const v of mprop(micro, 'description')) {
    if (typeof v === 'string') extra.push(...pySplitlines(unescape(v)).filter((ln) => pyStrip(ln) !== '').map(squash))
  }
  const desc = p?.get('description')
  if (typeof desc === 'string') extra.push(...textLines(desc))
  const scriptLines = await scriptStrings(page.scripts, deadline)
  const allLines = [...page.lines, ...extra, ...scriptLines]
  await deadline.tick()
  const hint = await sizes.unitHintAsync([...allLines, ...page.outLines], deadline.remaining())
  const ctx = new Ctx(isRug, hint, warnings, category === 'bed')
  const sz = new Sizes()
  shopifySizes(doc, ctx, sz, used)
  wooSizes(doc, ctx, sz, used)
  jsonldSizes(doc, ctx, sz, used)
  microdataSizes(doc, ctx, sz, used)
  linkVariant(doc, sz)
  sz.cands.push(...sz.feed)
  const anyVariant = (): boolean => sz.variants.some(([, r]) => r !== null)
  if (!anyVariant() && sz.cands.length === 0) {
    await deadline.tick()
    let text = await sizes.textReadingsAsync(allLines, ctx.size, deadline.remaining())
    if (text.length === 0 && page.outLines.length > 0) text = await sizes.textReadingsAsync(page.outLines, ctx.size, deadline.remaining())
    if (text.length > 0) {
      sz.cands.push(...text)
      used.add('text')
    }
  }
  if (sz.variants.length > 0 && !anyVariant()) {
    const labels = sz.variants.slice(0, 4).map(([lab]) => lab).join(', ') + (sz.variants.length > 4 ? ', \u{2026}' : '')
    warnings.push(`the shop's sizes (${labels}) couldn't be read as sizes: pick yours and type it`)
  }
  let cost = 0
  let mock = false
  if (!anyVariant() && sz.cands.length === 0) {
    if (llm) {
      const got = await runLlm(doc.url, allLines, ctx, deps, deadline)
      cost = got.cost
      mock = got.mock
      if (got.asked) used.add('llm')
      sz.cands.push(...got.sizes)
      const llmName = got.name
      if (llmName !== null && llmName.size > 0 && name === null) {
        const value = llmName.get('value')
        const quote = llmName.get('quote')
        if (typeof value === 'string' && typeof quote === 'string') {
          const v = collapse(value)
          const q = collapse(quote)
          if (v !== '' && q.includes(v) && collapse(allLines.join('\n')).includes(q)) name = cpPrefix(pyStrip(collapseWs(value)), 200)
        }
      }
      if (got.sizes.length === 0) warnings.push('no size was found on the page: measure the piece or type its size')
    } else {
      warnings.push("no size was found on the page, and the language model wasn't asked: type the size")
    }
  }
  // --- candidates: the shop's sizes first, then the layers in order; rugs get their thickness
  await deadline.tick()
  const thick = isRug ? await sizes.thicknessAsync(allLines, hint, deadline.remaining()) : null
  const fin = sizes.finish(sz.variants.map(([, r]) => r), sz.cands, isRug, thick)
  if (fin.thickness_used) used.add('text')
  const variants = sz.variants.length > 1 ? sz.variants.map(([label], i) => ({ label, dims_index: fin.variant_index[i] ?? null })) : []
  const layers = ['jsonld', 'microdata', 'opengraph', 'title', 'shopify', 'woocommerce', 'text', 'llm'].filter((x) => used.has(x))
  return {
    url: doc.url,
    name,
    category,
    is_rug: isRug,
    dims_candidates: fin.dims_candidates,
    variants,
    images: imgs.list,
    source_layers_used: layers,
    cost_usd: pyRound(cost, 6),
    mock,
    warnings,
  }
}

