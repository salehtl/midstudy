// POST /api/library/product's work (contract §2.11, §2.9 Page fetches): v1's `read`, `_read` (fetch the page, refuse
// what isn't a product page, parse, the robot check, the feeds, extract) and `_read_pasted` (a page the user's own
// browser copied: nothing is fetched). Never throws: every way a read can end is (status, body), as v1 answered.
import { pyStrip } from '../../../common/logic/pyfmt.ts'
import type { ServerDeps } from '../deps.ts'
import { Budget } from '../fetch.ts'
import { Doc, unescape } from './doc.ts'
import { BLOCKED, COULD_NOT_READ, Deadline, PageTimeout, ProductError, TIMEOUT } from './errors.ts'
import { extract, isRobotCheck, pageText, readFeeds, PY_B, type ProductResult } from './extract.ts'
import { parsePage } from './html.ts'
import { cpLength, cpPrefix } from './logic/text.ts'
import { BUDGET_MS, PAGE_MAX, contentTypeOf, fetchPage } from './pagefetch.ts'
import { PyRaised } from './sizes.ts'
import { publicUrl, target } from './urls.ts'

/** v1's EXTRACT_S: the work after the download. */
const EXTRACT_MS = 10 * 1000

/** A read's answer. */
export interface ProductAnswer {
  readonly status: number
  readonly body: ProductResult | { readonly error: string; readonly blocked?: true }
}

const OVER_10MB = 'the page is over 10 MB: only its first 10 MB were read'

/** v1's `_read`: a page fetched from its link. */
async function readFetched(url: string, llm: boolean, deps: ServerDeps, deadline: Deadline): Promise<ProductResult> {
  const budget = new Budget(BUDGET_MS)
  const warnings: string[] = []
  target(url) // the 400s before anything else
  const r = await fetchPage(url, budget)
  if ([401, 403, 429, 503].includes(r.status)) {
    throw new ProductError(422, r.status === 429 ? BLOCKED.slice(0, -1) + ', or try again in a minute.' : BLOCKED, true)
  }
  if (r.status !== 200) {
    if (r.status === 404 || r.status === 410) throw new ProductError(422, "the shop says this page doesn't exist: check the link opens in a browser")
    throw new ProductError(422, `the shop couldn't show this page (error ${String(r.status)}): check the link opens in a browser`)
  }
  const ctype = contentTypeOf(r)
  if (ctype.startsWith('image/')) throw new ProductError(422, "that's a picture, not a product page: use Image link for it")
  const head = Buffer.from(r.body.subarray(0, 512)).toString('latin1').replace(/^[ \t\n\r\v\f]+/, '').toLowerCase()
  if (ctype !== 'text/html' && ctype !== 'application/xhtml+xml' && !(ctype === '' && (head.startsWith('<!doctype html') || head.startsWith('<html')))) {
    throw new ProductError(422, "that link isn't a web page: paste the product page's link")
  }
  if (r.cut) warnings.push(OVER_10MB)
  const raw = pageText(r.body, r.headers['content-type'] ?? '')
  deadline.start(EXTRACT_MS) // the work after the download is bounded too
  const doc = new Doc(await parsePage(raw, publicUrl(r.url), () => deadline.tick()), publicUrl(r.url))
  if (isRobotCheck(doc, raw)) throw new ProductError(422, BLOCKED, true)
  await readFeeds(doc, raw, budget, warnings)
  return extract(doc, warnings, llm, deps, deadline)
}

const PY_S = '[\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}]'
const PY_NOT_S = '[^\\t\\n\\v\\f\\r\\x1c-\\x1f \\x85\\xa0\\u{1680}\\u{2000}-\\u{200a}\\u{2028}\\u{2029}\\u{202f}\\u{205f}\\u{3000}]'
// "Copy page for midstudy" (the planner's bookmarklet) puts this line before the page it copies.
const PASTE_MARK = new RegExp(`^${PY_S}*<!--${PY_S}*midstudy-page:${PY_S}*(${PY_NOT_S}+)${PY_S}*-->`, 'u')
const LOOKS_HTML = new RegExp(`<(?:!doctype${PY_S}+html|html|head|body|meta|t[i\\u{131}\\u{130}]tle)${PY_B}`, 'iu')
const TAG = new RegExp(`<(?:l[i\\u{131}\\u{130}]nk|meta)${PY_B}[^>]{0,2000}>`, 'giu')
const CANONICAL = new RegExp(`rel${PY_S}*=${PY_S}*["']?canonical${PY_B}`, 'u')
const OG_URL = new RegExp(`property${PY_S}*=${PY_S}*["']?og:url${PY_B}`, 'u')
const HREF = new RegExp(`(?:href|content)${PY_S}*=${PY_S}*(?:"([^"]*)"|'([^']*)'|(${PY_NOT_S.slice(0, -1)}>]+))`, 'iu')

/** v1's `_canonical`: the page's own address from its <link rel=canonical> or og:url. */
function canonical(raw: string): string | null {
  for (const m of cpPrefix(raw, 2_000_000).matchAll(TAG)) {
    const tag = m[0]
    const t = tag.toLowerCase()
    if (CANONICAL.test(t) || OG_URL.test(t)) {
      const h = HREF.exec(tag)
      const u = h === null ? '' : unescape(pyStrip(h[1] ?? h[2] ?? h[3] ?? ''))
      if (/^https?:\/\//iu.test(u)) return u
    }
  }
  return null
}

/** v1's `_read_pasted`: a page the user's browser already showed them; nothing is fetched, not even the feeds. */
async function readPasted(urlIn: string | null, rawIn: string, llm: boolean, deps: ServerDeps, deadline: Deadline): Promise<ProductResult> {
  const warnings: string[] = []
  let url = urlIn
  let raw = rawIn
  const m = PASTE_MARK.exec(raw)
  if (m !== null) {
    url = m[1] ?? null
    raw = raw.slice(m[0].length)
  }
  if (!LOOKS_HTML.test(cpPrefix(raw, 200_000))) {
    throw new ProductError(400, "that isn't a web page's source: copy the page with Copy page for midstudy, or from View Source")
  }
  url = url !== null && url !== '' ? url : canonical(raw)
  if (url === null) throw new ProductError(400, "the pasted page doesn't say its address: paste its link in Product page link too")
  target(url) // an http(s) address; never resolved or fetched
  if (cpLength(raw) > PAGE_MAX) {
    raw = cpPrefix(raw, PAGE_MAX)
    warnings.push(OVER_10MB)
  }
  deadline.start(EXTRACT_MS)
  const doc = new Doc(await parsePage(raw, publicUrl(url), () => deadline.tick()), publicUrl(url))
  if (isRobotCheck(doc, raw)) {
    throw new ProductError(422, "that's the shop's robot check, not the product: copy the page once the product shows in your browser")
  }
  return extract(doc, warnings, llm, deps, deadline)
}

/** v1's `read`: POST /api/library/product's answer; never throws. With `html` (Paste the page), nothing is fetched and
 *  `url`, if any, only says where the page came from. */
export async function readProduct(url: string | null, llm: boolean, html: string | null, deps: ServerDeps): Promise<ProductAnswer> {
  const deadline = new Deadline()
  try {
    if (html !== null) return { status: 200, body: await readPasted(url, html, llm, deps, deadline) }
    return { status: 200, body: await readFetched(url ?? '', llm, deps, deadline) }
  } catch (e) {
    if (e instanceof ProductError) return { status: e.status, body: e.body() }
    if (e instanceof PageTimeout) return { status: 422, body: { error: TIMEOUT } }
    // a page this reader can't handle is a 422, never a 500 (v1's `except Exception`, which v1's own exceptions in its
    // size rules, PyRaised here, also reached)
    if (!(e instanceof PyRaised)) logUnexpected(e)
    return { status: 422, body: { error: COULD_NOT_READ } }
  }
}

/** A failure v1 would also have answered with its generic 422, logged for whoever reads the server log. */
function logUnexpected(e: unknown): void {
  process.stderr.write(`product page reader: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`)
}
