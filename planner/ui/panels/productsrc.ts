// Add furniture › Product page (contract §2.11): paste a shop's product link and Read asks the server what the page
// says (lib.readProduct → POST /api/library/product; it adds nothing). The sheet's own fields are then prefilled: Name,
// W × D × H (with a size picker when the page has several), Category when empty, the Flat rug engine for a rug, plus a
// strip of the page's pictures to make it from (the first chosen) and notes on how the page was read. Make
// (libsheets.ts) sends the chosen picture through the image-link add, exactly like the Image link source.
// A re-read replaces what the last read filled in, but keeps every field the user typed in since.
// A shop that blocks automatic reading: "Paste the page instead". The user's own browser copies the page it shows them
// (the Copy page for midstudy bookmark, or View Source) and the server reads that copy without fetching anything.
//
//   productSource({ lib, form: { name, dims, category, getEngine(), setEngine(v) }, onChange(), onUseLink(imageUrl|null) })
//     → { el, sizesEl, notesEl, setActive(on), problem() → string | null, pictureUrl() → string | null, read() → Promise }
//   el: the link field, Read, status, error and the picture strip; sizesEl and notesEl go in the sheet's size row.
// Handles: product-url, product-read, product-status, product-error, product-use-link, product-pic, product-size,
// product-notes, product-paste-open (the Paste the page section), product-paste, product-bookmarklet and
// product-bookmarklet-copy. Styles: styles/manage.css (Product page section). The words: logic/product.ts.
import { h } from '../kit.js'
import { textInput } from '../sheet.js'
import { ring } from '../icons.js'
import { pic, messageOf } from './common.js'
import { fmtUsd, type Library } from '../seam.js'
import type { DimsFields } from './libsheets.js'
import { clipText, dimsLabel, pageSize, readDecimal, sentence } from '../logic/text.js'
import {
  dimsText, foundText, isImageLink, isLink, keepsTyped, linkError, linkInside, nextPicture, pictureAlt, productProblem, readNotes,
  readTone, sameDims, sizeLabel, type Candidate, type Picture, type Product, type Variant,
} from '../logic/product.js'

// The Copy page for midstudy bookmark: copies the page the browser shows, after a line saying where it came from
// (<!-- midstudy-page: <address> -->, read by the server). execCommand first: it runs inside the click, which the
// clipboard needs; navigator.clipboard is the fallback.
const COPY_PAGE = `(()=>{const t='<!-- midstudy-page: '+location.href+' -->\\n'+document.documentElement.outerHTML;`
  + `const ok=()=>alert('Copied this page for midstudy. Paste it in Add furniture, Product page, Paste the page.');`
  + `const bad=()=>alert('midstudy could not copy this page: open View Source, select all and copy instead.');`
  + `const a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.cssText='position:fixed;top:0;left:0;opacity:0';`
  + `document.body.appendChild(a);a.select();let done=false;try{done=document.execCommand('copy')}catch(e){}a.remove();`
  + `if(done)ok();else if(navigator.clipboard)navigator.clipboard.writeText(t).then(ok,bad);else bad()})()`
const BOOKMARKLET = `javascript:${encodeURIComponent(COPY_PAGE)}`

// --- the server's answer, read as v1 read it ------------------------------------------------------------------------------
const field = (o: unknown, k: string): unknown => (typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined)
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const number = (v: unknown): number | null => (typeof v === 'number' ? v : null)
function list(v: unknown): unknown[] {
  const out: unknown[] = []
  if (Array.isArray(v)) for (const x of v) out.push(x)
  return out
}
function candidate(c: unknown): Candidate | null {
  const w = number(field(c, 'w'))
  const d = number(field(c, 'd'))
  if (w === null || d === null || !(w > 0) || !(d > 0)) return null // sizes need a width and a depth
  return {
    w, d, h: number(field(c, 'h')), label: text(field(c, 'label')), unit_note: text(field(c, 'unit_note')),
    notes: list(field(c, 'notes')).filter((n) => typeof n === 'string'), quote: text(field(c, 'quote')), source: text(field(c, 'source')),
  }
}
function picture(im: unknown): Picture | null {
  const url = text(field(im, 'url'))
  return url !== null && isLink(url) ? { url } : null // pictures need an http(s) link
}
function variant(v: unknown): Variant | null {
  if (typeof v !== 'object' || v === null) return null
  return { label: text(field(v, 'label')), dims_index: number(field(v, 'dims_index')) }
}
const present = <T>(x: T | null): x is T => x !== null
/** The 200 answer of POST /api/library/product as the form uses it (contract §2.11 ProductResult; fields of another
 *  type are left out, as v1's checks left them unused). */
function parseProduct(d: unknown): Product {
  const cost = number(field(d, 'cost_usd'))
  return {
    url: text(field(d, 'url')),
    name: text(field(d, 'name')),
    category: text(field(d, 'category')),
    is_rug: !!field(d, 'is_rug'),
    dims_candidates: list(field(d, 'dims_candidates')).map(candidate).filter(present),
    images: list(field(d, 'images')).map(picture).filter(present),
    variants: list(field(d, 'variants')).map(variant).filter(present),
    warnings: list(field(d, 'warnings')).filter((w) => typeof w === 'string'),
    source_layers_used: list(field(d, 'source_layers_used')).filter((k) => typeof k === 'string'),
    cost_usd: cost ?? 0,
    mock: !!field(d, 'mock'),
  }
}

export interface ProductForm {
  readonly name: HTMLInputElement
  readonly dims: DimsFields
  readonly category: HTMLInputElement
  readonly getEngine: () => string
  readonly setEngine: (v: string) => void
}
export interface ProductSource {
  readonly el: HTMLDivElement
  readonly sizesEl: HTMLDivElement
  readonly notesEl: HTMLUListElement
  readonly read: (opts?: { readonly html?: string | null }) => Promise<void>
  readonly multiSize: () => boolean
  readonly setActive: (on: boolean) => void
  readonly pictureUrl: () => string | null
  readonly problem: () => string | null
}
interface ReadError {
  readonly text: string
  readonly local?: boolean
  readonly blocked?: boolean
}
interface ReadState {
  busy: boolean
  data: Product | null
  readUrl: string
  size: number
  picture: number
  failed: Set<number>
  error: ReadError | null
  seq: number
  active: boolean
}
type PutKey = 'name' | 'w' | 'd' | 'h' | 'category'
type StatusKind = 'busy' | 'ok' | 'warn' | null

export function productSource({ lib, form, onChange, onUseLink }: { readonly lib: Library; readonly form: ProductForm; readonly onChange?: () => void; readonly onUseLink?: (imageUrl: string | null) => void }): ProductSource {
  const st: ReadState = { busy: false, data: null, readUrl: '', size: 0, picture: -1, failed: new Set(), error: null, seq: 0, active: true }
  // what the last prefill put in each field: a field still holding it (or empty) is ours to replace
  const last: Record<PutKey, string> = { name: '', w: '', d: '', h: '', category: '' }
  let lastRug = false
  let engineBefore: string | null = null
  const changed = (): void => { onChange?.() }

  const url = textInput({ type: 'url', inputmode: 'url', placeholder: 'https://shop.example/products/…', label: 'Product page link', onInput: () => { changed() } })
  url.dataset['midstudy'] = 'product-url'
  url.setAttribute('autocapitalize', 'off')
  url.setAttribute('autocorrect', 'off')
  url.setAttribute('enterkeyhint', 'go')
  url.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return
    e.preventDefault()
    if (window.matchMedia('(pointer: coarse)').matches) url.blur() // the phone's keyboard closes, so the result shows
    void read()
  })
  const readBtn = h('button.btn.btn-secondary.ms-prod-read', { type: 'button', dataset: { midstudy: 'product-read' }, onclick: () => { void read() } })
  const status = h('p.ms-prod-status', { 'aria-live': 'polite', dataset: { midstudy: 'product-status' }, hidden: true })
  const errText = h('p.ms-prod-err-text', { dataset: { midstudy: 'product-error' } })
  const useLink = h('button.btn.btn-secondary.ms-prod-uselink', { type: 'button', dataset: { midstudy: 'product-use-link' }, onclick: () => { onUseLink?.(isImageLink(url.value.trim()) ? url.value.trim() : null) } },
    pic('link', { size: 16 }), h('span', 'Use Image link instead'))
  const errBox = h('div.ms-prod-error', { role: 'alert', hidden: true }, errText, useLink)
  const picWarn = h('div.ms-prod-picwarn', { hidden: true },
    h('p.ms-prod-err-text', 'None of the page’s pictures would load.'),
    h('button.btn.btn-secondary.ms-prod-uselink', { type: 'button', onclick: () => { onUseLink?.(null) } }, pic('link', { size: 16 }), h('span', 'Use Image link instead')))
  const strip = h('div.ms-prod-pics', { role: 'group', 'aria-label': 'Pictures on the page' })
  const picRow = h('div.ms-row.ms-prod-picrow', { hidden: true }, h('span.ms-label', 'Picture to make it from'), strip,
    h('span.ms-hint', 'The clearest one of the piece on its own works best (a rug: seen from straight above).'))
  const sizesEl = h('div.ms-prod-sizes', { role: 'group', 'aria-label': 'Sizes on the page', hidden: true })
  const notesEl = h('ul.ms-prod-notes', { dataset: { midstudy: 'product-notes' }, 'aria-label': 'How the page was read', hidden: true })

  // --- Paste the page instead (a shop that blocks automatic reading)
  const pasteBox = h('textarea.ms-input.ms-prod-pastebox', { rows: 2, placeholder: 'Paste the copied page here', spellcheck: false, autocomplete: 'off',
    'aria-label': 'The copied page', dataset: { midstudy: 'product-paste' } })
  pasteBox.setAttribute('autocapitalize', 'off')
  pasteBox.setAttribute('autocorrect', 'off')
  // the page is read straight from the clipboard: megabytes of source never sit in the box
  pasteBox.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text/plain')
    if (!t) return
    e.preventDefault()
    takePasted(t)
  })
  pasteBox.addEventListener('input', () => { if (pasteBox.value.length > 200) takePasted(pasteBox.value) }) // a paste that skipped the event
  const bmHint = h('p.ms-hint', { hidden: true }, 'Drag the button to your bookmarks bar; clicking it here does nothing. Then, on the shop’s product page, click the bookmark.')
  const bookmark = h('a.btn.btn-secondary.ms-prod-bm', { href: BOOKMARKLET, draggable: 'true', title: 'Drag to your bookmarks bar', dataset: { midstudy: 'product-bookmarklet' },
    onclick: (e) => { e.preventDefault(); bmHint.hidden = false } }, pic('link', { size: 16 }), h('span', 'Copy page for midstudy'))
  const bmCopy = h('button.btn.btn-secondary.ms-prod-bmcopy', { type: 'button', dataset: { midstudy: 'product-bookmarklet-copy' }, onclick: () => { void copyBookmarklet() } }, h('span', 'Copy its address'))
  const pasteEl = h('details.ms-prod-paste', { dataset: { midstudy: 'product-paste-open' } },
    h('summary', 'Shop blocks reading? Paste the page instead'),
    h('ol.ms-prod-steps',
      h('li', 'Open the product page in your browser.'),
      h('li', 'Copy the whole page with the bookmark below, or open View Source, select all and copy.'),
      h('li', 'Paste it here. midstudy reads your copy; nothing is fetched from the shop.')),
    h('div.ms-prod-bmrow', bookmark, bmCopy),
    bmHint,
    h('p.ms-hint', 'On a phone: bookmark any page, edit the bookmark, and paste the copied address in place of its own.'),
    pasteBox)
  async function copyBookmarklet(): Promise<void> {
    let ok = false
    try { await navigator.clipboard.writeText(BOOKMARKLET); ok = true } catch { /* below */ }
    bmCopy.replaceChildren(h('span', ok ? 'Copied' : 'Couldn’t copy: drag the button instead'))
    setTimeout(() => { bmCopy.replaceChildren(h('span', 'Copy its address')) }, 2500)
  }
  function takePasted(t: string): void {
    pasteBox.value = ''
    pasteBox.placeholder = `Pasted a page (${pageSize(t.length)}): reading it…`
    void read({ html: t })
  }

  const el = h('div.ms-src.ms-prod',
    h('div.ms-row', h('span.ms-label', 'Product page link'), h('div.ms-prod-field', url, readBtn),
      h('span.ms-hint', 'Free to read. When the size is only in the page’s words, a small language model reads it (under $0.001).')),
    status, errBox, pasteEl, picWarn, picRow)

  // a field the user typed in since the last prefill keeps its value
  function put(input: HTMLInputElement, key: PutKey, value: string): void {
    if (keepsTyped(input.value, last[key])) return
    input.value = value
    last[key] = value
  }
  function setDims(c: Candidate | null, { force = false }: { readonly force?: boolean } = {}): void {
    const vals = dimsText(c)
    const [w, d, hh] = form.dims.inputs
    for (const [k, input] of [['w', w], ['d', d], ['h', hh]] as const) {
      if (force) { input.value = vals[k]; last[k] = vals[k] } else put(input, k, vals[k])
    }
  }

  function prefill(d: Product): void {
    st.size = 0
    st.failed = new Set()
    st.picture = d.images.length ? 0 : -1
    put(form.name, 'name', d.name ?? '')
    setDims(d.dims_candidates[0] ?? null)
    put(form.category, 'category', (d.category ?? '') || (d.is_rug ? 'rug' : ''))
    // the Flat rug engine for a rug; otherwise the engine the user (or the default) had before the last rug
    const eng = form.getEngine()
    if (d.is_rug) {
      if (eng !== 'rug') { engineBefore = eng; form.setEngine('rug') }
      lastRug = true
    } else {
      if (lastRug && eng === 'rug' && engineBefore) form.setEngine(engineBefore)
      lastRug = false
      engineBefore = null
    }
  }

  // another page failed to read: the last page's name, size, category and Flat rug go (typed values stay)
  function clearPrefill(): void {
    put(form.name, 'name', '')
    setDims(null)
    put(form.category, 'category', '')
    if (lastRug && form.getEngine() === 'rug' && engineBefore) form.setEngine(engineBefore)
    lastRug = false
    engineBefore = null
  }

  const allPicturesFailed = (): boolean => !!st.data?.images.length && st.failed.size >= st.data.images.length

  async function read({ html = null }: { readonly html?: string | null } = {}): Promise<void> {
    if (st.busy) return
    // a link shared from a phone app often comes with its title around it: keep just the link
    let link = url.value.trim()
    const found = linkInside(link)
    if (found !== null) { link = found; url.value = link }
    if (html !== null && !isLink(link)) link = '' // a pasted page says where it came from itself
    else if (!isLink(link)) {
      st.error = { text: linkError(link), local: true }
      render()
      url.focus()
      return
    }
    const seq = ++st.seq
    st.busy = true
    st.error = null
    render()
    changed()
    try {
      const answer = await lib.readProduct(link, html !== null ? { html } : undefined)
      if (seq !== st.seq) return
      const d = parseProduct(answer)
      if (html !== null && d.url !== null && isLink(d.url)) { url.value = d.url; link = d.url } // the page that was read
      st.data = d
      st.readUrl = link
      prefill(d)
    } catch (e) {
      if (seq !== st.seq) return
      if (st.data) clearPrefill()
      st.data = null
      st.readUrl = ''
      st.picture = -1
      const blocked: unknown = typeof e === 'object' && e !== null ? Reflect.get(e, 'blocked') : undefined
      st.error = { text: sentence(messageOf(e) || 'Couldn’t read that page.'), blocked: !!blocked }
      if (st.error.blocked) pasteEl.open = true
    } finally {
      if (html !== null) pasteBox.placeholder = 'Paste the copied page here'
      if (seq === st.seq) {
        const hadFocus = document.activeElement === readBtn || document.activeElement === document.body
        st.busy = false
        render()
        changed()
        if (hadFocus) (st.error && !useLink.hidden ? useLink : readBtn).focus({ preventScroll: true }) // focus stays in the sheet
      }
    }
  }

  // --- drawing ---------------------------------------------------------------------------------------------------
  function render(): void {
    readBtn.disabled = st.busy // focus that falls to <body> meanwhile is put back on Read (or Use Image link) after
    readBtn.setAttribute('aria-busy', String(st.busy))
    readBtn.replaceChildren(...(st.busy ? [ring(null, { size: 16 }), h('span', 'Reading…')] : [h('span', 'Read')]))
    if (st.busy) setStatus('busy', 'Reading the page…')
    else if (st.data) setStatus(readTone(st.data, st.size, allPicturesFailed()), foundText(st.data, st.size))
    else setStatus(null, '')
    errBox.hidden = !st.error || st.busy
    errText.textContent = st.error?.text ?? ''
    useLink.hidden = !st.error || !!st.error.local
    picWarn.hidden = !allPicturesFailed()
    renderPics()
    renderSizes()
    renderNotes()
  }
  function setStatus(kind: StatusKind, words: string): void {
    status.hidden = !kind
    status.className = `ms-prod-status${kind ? ` is-${kind}` : ''}`
    const glyph = kind === 'busy' ? ring(null, { size: 16 }) : kind === 'ok' ? pic('check', { size: 16 }) : kind === 'warn' ? pic('info', { size: 16 }) : null
    status.replaceChildren(...(glyph ? [glyph] : []), h('span', words))
  }

  let drawn: Product | null = null // the answer the strip shows: rebuilt only for a new one
  function renderPics(): void {
    const data = st.data
    if (data === drawn) return
    drawn = data
    const imgs = data?.images ?? []
    picRow.hidden = !imgs.length
    strip.scrollLeft = 0
    strip.replaceChildren(...imgs.map((im, i) => {
      const img = document.createElement('img')
      img.referrerPolicy = 'no-referrer' // before src: the shop never learns where its picture is shown
      img.loading = 'lazy'
      img.decoding = 'async'
      img.draggable = false
      img.alt = pictureAlt(data?.name ?? null, i, imgs.length)
      img.addEventListener('error', () => { if (st.data === data) pictureFailed(i) })
      img.src = im.url
      return h('button.ms-prod-pic', { type: 'button', dataset: { midstudy: 'product-pic', index: String(i) }, hidden: st.failed.has(i), title: im.url, onclick: () => { pickPicture(i) } },
        img, h('span.ms-prod-tick', { 'aria-hidden': 'true' }, pic('check', { size: 14, stroke: 2.2 })))
    }))
    markPicture()
  }
  function markPicture(): void {
    for (const b of strip.children) if (b instanceof HTMLElement) b.setAttribute('aria-pressed', String(Number(b.dataset['index']) === st.picture))
    const chosen = strip.querySelector('[aria-pressed="true"]')
    if (chosen instanceof HTMLElement && (chosen.offsetLeft < strip.scrollLeft || chosen.offsetLeft + chosen.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
      strip.scrollLeft = Math.max(0, chosen.offsetLeft - 8)
    }
  }
  function pickPicture(i: number): void {
    if (st.failed.has(i)) return
    st.picture = i
    markPicture()
    changed()
  }
  function pictureFailed(i: number): void {
    if (!st.data || st.failed.has(i)) return
    st.failed.add(i)
    const b = strip.querySelector(`[data-index="${String(i)}"]`)
    if (b instanceof HTMLElement) b.hidden = true
    const n = st.data.images.length
    if (st.picture === i) {
      st.picture = nextPicture(i, n, st.failed)
      markPicture()
    }
    picRow.hidden = st.failed.size >= n
    picWarn.hidden = !allPicturesFailed()
    if (allPicturesFailed()) setStatus('warn', foundText(st.data, st.size))
    renderNotes()
    changed()
  }

  function currentDims(): { readonly w: number; readonly d: number; readonly h: number } {
    const [w, d, hh] = form.dims.inputs
    return { w: readDecimal(w.value), d: readDecimal(d.value), h: readDecimal(hh.value) }
  }
  function renderSizes(): void {
    const data = st.data
    const cands = data?.dims_candidates ?? []
    sizesEl.hidden = !st.active || cands.length < 2
    sizesEl.replaceChildren(...(data === null || cands.length < 2 ? [] : cands.map((c, i) => {
      const label = sizeLabel(data, i)
      return h('button.ms-prod-size', { type: 'button', title: `${label}: ${dimsLabel(c)}`, 'aria-label': `${label}: ${dimsLabel(c)}`, dataset: { midstudy: 'product-size', index: String(i) }, onclick: () => { pickSize(i) } },
        h('b', clipText(label, 60)), h('span.tnum', dimsLabel(c)))
    })))
    markSizes()
  }
  function markSizes(): void {
    const cands = st.data?.dims_candidates ?? []
    const now = currentDims()
    for (const b of sizesEl.children) {
      const c = cands[Number(b instanceof HTMLElement ? b.dataset['index'] : NaN)]
      if (c) b.setAttribute('aria-pressed', String(sameDims(c, now)))
    }
  }
  function pickSize(i: number): void {
    const c = st.data?.dims_candidates[i]
    if (!c) return
    st.size = i
    setDims(c, { force: true })
    markSizes()
    renderNotes()
    changed()
  }
  form.dims.addEventListener('input', () => { markSizes() })

  function renderNotes(): void {
    const lines = st.data ? readNotes(st.data, st.size, st.failed.size, allPicturesFailed(), fmtUsd) : []
    notesEl.hidden = !st.active || !lines.length
    notesEl.replaceChildren(...lines.map((l) => h(`li.is-${l.kind}`, pic(l.kind === 'warn' ? 'warning' : l.kind === 'quote' ? 'search' : 'info', { size: 14 }), h('span', l.text))))
  }

  render()
  return {
    el, sizesEl, notesEl, read,
    multiSize: () => (st.data?.dims_candidates.length ?? 0) > 1,
    setActive(on: boolean) {
      st.active = on
      el.hidden = !on
      renderSizes()
      renderNotes()
    },
    pictureUrl: () => (st.data && st.picture >= 0 && !st.failed.has(st.picture) ? (st.data.images[st.picture]?.url ?? '') || null : null),
    problem: () => productProblem({
      busy: st.busy, read: !!st.data, typed: url.value.trim(), readUrl: st.readUrl,
      pictures: st.data?.images.length ?? 0, allPicturesFailed: allPicturesFailed(), picture: st.picture,
    }),
  }
}
