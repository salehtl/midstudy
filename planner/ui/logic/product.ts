// Add furniture › Product page (ui/panels/productsrc.ts, contract §2.11): what the server read from a shop's page, in
// words: where it was read from, what was found, the notes under the size, the size picker's labels, which picture is
// next when one fails, and what Make still needs. Pure, TScert-checked. The shell turns the server's answer into a
// Product first (parseProduct), so everything here is typed.

import { andList, cap, clipText, cmText, sentence } from './text.js'

const LINK = /^https?:\/\/\S+$/i
const IMAGE_LINK = /\.(jpe?g|png|webp|heic|heif|avif|gif)(\?.*)?$/i
const STRUCTURED = 'the page’s structured data'
const WHERE: ReadonlyMap<string, string> = new Map([
  ['jsonld', STRUCTURED], ['microdata', STRUCTURED], ['opengraph', STRUCTURED], ['og', STRUCTURED], ['meta', STRUCTURED],
  ['title', 'the page’s title'], ['shopify', 'the Shopify feed'], ['woocommerce', 'the WooCommerce shop data'],
  ['text', 'the page text'], ['llm', 'a language model'],
])

/** One size reading (cm), as the form uses it. */
export interface Candidate {
  readonly w: number
  readonly d: number
  readonly h: number | null
  readonly label: string | null
  readonly unit_note: string | null
  readonly notes: readonly string[]
  readonly quote: string | null
  readonly source: string | null
}
export interface Picture {
  readonly url: string
}
export interface Variant {
  readonly label: string | null
  readonly dims_index: number | null
}
/** The 200 answer of POST /api/library/product, as the form reads it: sizes with a width and a depth, pictures with an
 *  http(s) link. */
export interface Product {
  readonly url: string | null
  readonly name: string | null
  readonly category: string | null
  readonly is_rug: boolean
  readonly dims_candidates: readonly Candidate[]
  readonly images: readonly Picture[]
  readonly variants: readonly Variant[]
  readonly warnings: readonly string[]
  readonly source_layers_used: readonly string[]
  readonly cost_usd: number
  readonly mock: boolean
}

export function isLink(s: string): boolean {
  return LINK.test(s)
}

/** A link that names a picture file (Use Image link instead takes it along). */
export function isImageLink(s: string): boolean {
  return IMAGE_LINK.test(s)
}

/** A link shared from a phone app often comes with its title around it: the link inside, or null. */
export function linkInside(text: string): string | null {
  if (LINK.test(text)) return null
  const m = /https?:\/\/[^\s<>"'“”]+/i.exec(text)
  return m ? m[0] : null
}

/** Read without a usable link. */
export function linkError(typed: string): string {
  return typed ? 'That isn’t a web link: paste the address of the shop’s product page (https://…).' : 'Paste the product page’s link first.'
}

/** The layers that gave something (the model only when one of the sizes is its own), then where each size came from. */
function layersOf(p: Product): string[] {
  const llmSize = p.dims_candidates.some((c) => c.source === 'llm')
  const out = p.source_layers_used.filter((k) => k !== 'llm' || llmSize)
  for (const c of p.dims_candidates) if (c.source) out.push(c.source)
  return out
}

/** "the page’s structured data and the page text". */
function whereText(layers: readonly string[]): string {
  const out: string[] = []
  for (const k of layers) {
    const w = WHERE.get(k) ?? 'the page'
    if (!out.includes(w)) out.push(w)
  }
  return andList(out)
}

/** The status line after a read: what was found, from where, and what is missing. size: the size shown. */
export function foundText(p: Product, size: number): string {
  const parts: string[] = []
  if (p.name) parts.push('the name')
  const n = p.dims_candidates.length
  if (n === 1) parts.push('the size')
  else if (n > 1) parts.push(`${String(n)} sizes`)
  const pics = p.images.length
  if (pics) parts.push(pics === 1 ? '1 picture' : `${String(pics)} pictures`)
  const where = whereText(layersOf(p))
  let s = parts.length ? `Found ${andList(parts)}${where ? ` (from ${where})` : ''}.` : 'Read the page, but found nothing to use.'
  const skipped = p.warnings.some((w) => /language model (was skipped|is off)/i.test(w))
  if (!n) s += skipped ? ' No size in the page’s data, and the language model was skipped: enter it below.' : ' No size on the page: enter it below.'
  else if (!hasHeight(p.dims_candidates[size])) s += ' No height on the page: enter it below.'
  if (!pics) s += ' No picture on the page: use Image link instead.'
  return s
}

/** A size reading with a height above 0. */
function hasHeight(c: Candidate | undefined): boolean {
  return c !== undefined && c.h !== null && c.h > 0
}

/** The status line's tone: ok when there is a size with a height and a picture that loads. */
export function readTone(p: Product, size: number, allPicturesFailed: boolean): 'ok' | 'warn' {
  return p.dims_candidates.length && p.images.length && hasHeight(p.dims_candidates[size]) && !allPicturesFailed ? 'ok' : 'warn'
}

/** A note under the size: a warning, a plain note, or a quote from the page. */
export interface Note {
  readonly kind: 'warn' | 'info' | 'quote'
  readonly text: string
}
/** The notes on how the page was read, for the size shown. failed: pictures that would not load. */
export function readNotes(p: Product, size: number, failed: number, allPicturesFailed: boolean, usd: (v: number) => string): Note[] {
  const lines: Note[] = []
  const c = p.dims_candidates[size]
  if (c) {
    if (c.source === 'llm') lines.push({ kind: 'warn', text: 'A language model found this size in the page’s words: check it.' })
    if (c.unit_note) lines.push({ kind: 'info', text: sentence(c.unit_note) })
    for (const n of c.notes) lines.push({ kind: 'info', text: sentence(n) })
    if (c.quote && (c.source === 'text' || c.source === 'llm')) lines.push({ kind: 'quote', text: `On the page: “${clipText(c.quote, 140)}”` })
  }
  for (const v of p.variants) {
    if (v.dims_index === null && v.label) lines.push({ kind: 'info', text: `The shop also has ${clipText(v.label, 40)}, but its size couldn’t be read.` })
  }
  for (const w of p.warnings) lines.push({ kind: 'warn', text: sentence(w) })
  if (c && !hasHeight(c)) lines.push({ kind: 'warn', text: 'No height on the page: enter it in Height.' })
  if (failed && !allPicturesFailed) lines.push({ kind: 'info', text: `${String(failed)} of the page’s pictures wouldn’t load, so ${failed === 1 ? 'it’s' : 'they’re'} left out.` })
  const where = whereText(layersOf(p))
  if (where) lines.push({ kind: 'info', text: `Read from ${where}.` })
  const askedLlm = p.source_layers_used.includes('llm')
  if (askedLlm && !p.dims_candidates.some((x) => x.source === 'llm')) lines.push({ kind: 'info', text: 'A language model looked for the size in the page’s words and found none.' })
  if (p.cost_usd > 0) lines.push({ kind: 'info', text: `The language model cost ${usd(p.cost_usd)}.` })
  else if (askedLlm && p.mock) lines.push({ kind: 'info', text: 'The language model was a test stand-in: no charge.' })
  return lines
}

/** A size button's label: the shop's variant name for it, its own label, or "Size n". */
export function sizeLabel(p: Product, i: number): string {
  const variant = p.variants.find((v) => v.dims_index === i)
  return (variant?.label ?? '') || (p.dims_candidates[i]?.label ?? '') || `Size ${String(i + 1)}`
}

/** The size fields' values for a reading (cm, one decimal; no height: empty). */
export interface DimsText {
  readonly w: string
  readonly d: string
  readonly h: string
}
export function dimsText(c: Candidate | null): DimsText {
  return { w: cmText(c?.w), d: cmText(c?.d), h: c && hasHeight(c) ? cmText(c.h) : '' }
}

/** The size fields as numbers (NaN when not one). */
export interface TypedDims {
  readonly w: number
  readonly d: number
  readonly h: number
}
/** Whether the fields hold this reading (to 0.05 cm; a reading without a height matches an empty or 0 height). */
export function sameDims(c: Candidate, v: TypedDims): boolean {
  const near = (want: number | null, have: number): boolean => (want !== null && want > 0 ? Math.abs(want - have) < 0.05 : !(have > 0))
  return near(c.w, v.w) && near(c.d, v.d) && near(c.h, v.h)
}

/** A field the user typed in since the last prefill keeps its value (it is not empty and not what was put there). */
export function keepsTyped(value: string, lastPut: string): boolean {
  return value.trim() !== '' && value !== lastPut
}

/** The next picture after a failed one, in order, that has not failed; -1 when none. */
export function nextPicture(i: number, n: number, failed: ReadonlySet<number>): number {
  for (let k = 1; k < n; k++) {
    const j = (i + k) % n
    if (!failed.has(j)) return j
  }
  return -1
}

/** A picture's alt text: "Oak chair, picture 2 of 5" ("The piece, …" without a name). */
export function pictureAlt(name: string | null, i: number, n: number): string {
  return `${cap((name ?? '') || 'the piece')}, picture ${String(i + 1)} of ${String(n)}`
}

/** What Make still needs from the product page, or null. */
export interface ProductState {
  readonly busy: boolean
  readonly read: boolean
  readonly typed: string
  readonly readUrl: string
  readonly pictures: number
  readonly allPicturesFailed: boolean
  readonly picture: number
}
export function productProblem(s: ProductState): string | null {
  if (s.busy) return 'Reading the page…'
  if (!s.read) return s.typed ? 'Read the page first' : 'Paste a product page link'
  if (s.typed !== s.readUrl) return 'Read this link first'
  if (!s.pictures) return 'No picture on the page'
  if (s.allPicturesFailed) return 'No picture would load: use Image link'
  if (s.picture < 0) return 'Choose a picture'
  return null
}
