// Add furniture › Product page (contract §2.11): paste a shop's product link and Read asks the server what the page
// says (lib.readProduct → POST /api/library/product; it adds nothing). The sheet's own fields are then prefilled: Name,
// W × D × H (with a size picker when the page has several), Category when empty, the Flat rug engine for a rug, plus a
// strip of the page's pictures to make it from (the first chosen) and notes on how the page was read. Make
// (libsheets.js) sends the chosen picture through the image-link add, exactly like the Image link source.
// A re-read replaces what the last read filled in, but keeps every field the user typed in since.
// A shop that blocks automatic reading: "Paste the page instead". The user's own browser copies the page it shows them
// (the Copy page for midstudy bookmark, or View Source) and the server reads that copy without fetching anything.
//
//   productSource({ lib, form: { name, dims, category, getEngine(), setEngine(v) }, onChange(), onUseLink(imageUrl|null) })
//     → { el, sizesEl, notesEl, setActive(on), problem() → string | null, pictureUrl() → string | null, read() → Promise }
//   el: the link field, Read, status, error and the picture strip; sizesEl and notesEl go in the sheet's size row.
// Handles: product-url, product-read, product-status, product-error, product-use-link, product-pic, product-size,
// product-notes, product-paste-open (the Paste the page section), product-paste, product-bookmarklet and
// product-bookmarklet-copy. Styles: styles/manage.css (Product page section).
import { h } from '../kit.js'
import { textInput } from '../sheet.js'
import { ring } from '../icons.js'
import { pic } from './common.js'
import { fmtUsd } from '../../engine.js'

const LINK = /^https?:\/\/\S+$/i
const IMAGE_LINK = /\.(jpe?g|png|webp|heic|heif|avif|gif)(\?.*)?$/i
const WHERE = {
  jsonld: 'the page’s structured data', microdata: 'the page’s structured data', opengraph: 'the page’s structured data',
  og: 'the page’s structured data', meta: 'the page’s structured data', title: 'the page’s title',
  shopify: 'the Shopify feed', woocommerce: 'the WooCommerce shop data', text: 'the page text', llm: 'a language model',
}
// The Copy page for midstudy bookmark: copies the page the browser shows, after a line saying where it came from
// (<!-- midstudy-page: <address> -->, read by the server). execCommand first: it runs inside the click, which the
// clipboard needs; navigator.clipboard is the fallback.
const COPY_PAGE = `(()=>{const t='<!-- midstudy-page: '+location.href+' -->\\n'+document.documentElement.outerHTML;`
  + `const ok=()=>alert('Copied this page for midstudy. Paste it in Add furniture, Product page, Paste the page.');`
  + `const bad=()=>alert('midstudy could not copy this page: open View Source, select all and copy instead.');`
  + `const a=document.createElement('textarea');a.value=t;a.setAttribute('readonly','');a.style.cssText='position:fixed;top:0;left:0;opacity:0';`
  + `document.body.appendChild(a);a.select();let done=false;try{done=document.execCommand('copy')}catch(e){}a.remove();`
  + `if(done)ok();else if(navigator.clipboard)navigator.clipboard.writeText(t).then(ok,bad);else bad()})()`
export const BOOKMARKLET = `javascript:${encodeURIComponent(COPY_PAGE)}`
const fmtSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
const cm = (v) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : '')
const cap = (s) => String(s || '').replace(/^\s*\S/, (c) => c.toUpperCase())
const sentence = (s) => { const t = cap(String(s || '').trim()); return /[.!?…:”"')]$/.test(t) ? t : `${t}.` } // server notes come without a full stop
const clipText = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s }
const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] || '')
export const dimsLabel = (c) => (c.h > 0 ? `${cm(c.w)} × ${cm(c.d)} × ${cm(c.h)} cm` : `${cm(c.w)} × ${cm(c.d)} cm, no height`)
// the layers the server says it used, plus where each size came from
// the layers that gave something: the model counts only when one of the sizes is its own
const layersOf = (d) => {
  const cands = Array.isArray(d?.dims_candidates) ? d.dims_candidates : []
  const layers = (Array.isArray(d?.source_layers_used) ? d.source_layers_used : []).filter((k) => k !== 'llm' || cands.some((c) => c.source === 'llm'))
  return [...layers, ...cands.map((c) => c.source).filter(Boolean)]
}
export function whereText(layers) {
  const out = []
  for (const k of Array.isArray(layers) ? layers : []) { const w = WHERE[k] || 'the page'; if (!out.includes(w)) out.push(w) }
  return andList(out)
}

export function productSource({ lib, form, onChange, onUseLink }) {
  const st = { busy: false, data: null, readUrl: '', size: 0, picture: -1, failed: new Set(), error: null, seq: 0, active: true }
  // what the last prefill put in each field: a field still holding it (or empty) is ours to replace
  const last = { name: '', w: '', d: '', h: '', category: '', rug: false, engineBefore: null }
  const changed = () => onChange?.()

  const url = textInput({ type: 'url', inputmode: 'url', placeholder: 'https://shop.example/products/…', label: 'Product page link', onInput: () => changed() })
  url.dataset.midstudy = 'product-url'
  url.setAttribute('autocapitalize', 'off')
  url.setAttribute('autocorrect', 'off')
  url.setAttribute('enterkeyhint', 'go')
  url.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing) return
    e.preventDefault()
    if (window.matchMedia?.('(pointer: coarse)').matches) url.blur() // the phone's keyboard closes, so the result shows
    read()
  })
  const readBtn = h('button.btn.btn-secondary.ms-prod-read', { type: 'button', dataset: { midstudy: 'product-read' }, onclick: () => read() })
  const status = h('p.ms-prod-status', { 'aria-live': 'polite', dataset: { midstudy: 'product-status' }, hidden: true })
  const errText = h('p.ms-prod-err-text', { dataset: { midstudy: 'product-error' } })
  const useLink = h('button.btn.btn-secondary.ms-prod-uselink', { type: 'button', dataset: { midstudy: 'product-use-link' }, onclick: () => onUseLink?.(IMAGE_LINK.test(url.value.trim()) ? url.value.trim() : null) },
    pic('link', { size: 16 }), h('span', 'Use Image link instead'))
  const errBox = h('div.ms-prod-error', { role: 'alert', hidden: true }, errText, useLink)
  const picWarn = h('div.ms-prod-picwarn', { hidden: true },
    h('p.ms-prod-err-text', 'None of the page’s pictures would load.'),
    h('button.btn.btn-secondary.ms-prod-uselink', { type: 'button', onclick: () => onUseLink?.(null) }, pic('link', { size: 16 }), h('span', 'Use Image link instead')))
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
  const bmCopy = h('button.btn.btn-secondary.ms-prod-bmcopy', { type: 'button', dataset: { midstudy: 'product-bookmarklet-copy' }, onclick: () => copyBookmarklet() }, h('span', 'Copy its address'))
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
  async function copyBookmarklet() {
    let ok = false
    try { await navigator.clipboard.writeText(BOOKMARKLET); ok = true } catch { /* below */ }
    bmCopy.replaceChildren(h('span', ok ? 'Copied' : 'Couldn’t copy: drag the button instead'))
    setTimeout(() => bmCopy.replaceChildren(h('span', 'Copy its address')), 2500)
  }
  function takePasted(text) {
    pasteBox.value = ''
    pasteBox.placeholder = `Pasted a page (${fmtSize(text.length)}): reading it…`
    read({ html: text })
  }

  const el = h('div.ms-src.ms-prod',
    h('div.ms-row', h('span.ms-label', 'Product page link'), h('div.ms-prod-field', url, readBtn),
      h('span.ms-hint', 'Free to read. When the size is only in the page’s words, a small language model reads it (under $0.001).')),
    status, errBox, pasteEl, picWarn, picRow)

  const dimInputs = () => [...form.dims.querySelectorAll('input')]
  // a field the user typed in since the last prefill keeps its value
  function put(input, key, value) {
    if (!input) return
    if (input.value.trim() !== '' && input.value !== last[key]) return
    input.value = value
    last[key] = value
  }
  function setDims(c, { force = false } = {}) {
    const [w, d, hh] = dimInputs()
    const vals = { w: cm(c?.w), d: cm(c?.d), h: c?.h > 0 ? cm(c.h) : '' }
    for (const [k, input] of [['w', w], ['d', d], ['h', hh]]) {
      if (force && input) { input.value = vals[k]; last[k] = vals[k] } else put(input, k, vals[k])
    }
  }

  function prefill(d) {
    st.size = 0
    st.failed = new Set()
    st.picture = d.images.length ? 0 : -1
    put(form.name, 'name', d.name || '')
    setDims(d.dims_candidates[0] || null)
    put(form.category, 'category', d.category || (d.is_rug ? 'rug' : ''))
    // the Flat rug engine for a rug; otherwise the engine the user (or the default) had before the last rug
    const eng = form.getEngine()
    if (d.is_rug) {
      if (eng !== 'rug') { last.engineBefore = eng; form.setEngine('rug') }
      last.rug = true
    } else {
      if (last.rug && eng === 'rug' && last.engineBefore) form.setEngine(last.engineBefore)
      last.rug = false
      last.engineBefore = null
    }
  }

  // another page failed to read: the last page's name, size, category and Flat rug go (typed values stay)
  function clearPrefill() {
    put(form.name, 'name', '')
    setDims(null)
    put(form.category, 'category', '')
    if (last.rug && form.getEngine() === 'rug' && last.engineBefore) form.setEngine(last.engineBefore)
    last.rug = false
    last.engineBefore = null
  }

  function foundText(d) {
    const parts = []
    if (d.name) parts.push('the name')
    const n = d.dims_candidates.length
    if (n === 1) parts.push('the size'); else if (n > 1) parts.push(`${n} sizes`)
    const p = d.images.length
    if (p) parts.push(p === 1 ? '1 picture' : `${p} pictures`)
    const where = whereText(layersOf(d))
    let s = parts.length ? `Found ${andList(parts)}${where ? ` (from ${where})` : ''}.` : 'Read the page, but found nothing to use.'
    const skipped = (d.warnings || []).some((w) => /language model (was skipped|is off)/i.test(w))
    if (!n) s += skipped ? ' No size in the page’s data, and the language model was skipped: enter it below.' : ' No size on the page: enter it below.'
    else if (!(d.dims_candidates[st.size]?.h > 0)) s += ' No height on the page: enter it below.'
    if (!p) s += ' No picture on the page: use Image link instead.'
    return s
  }
  const allPicturesFailed = () => !!st.data?.images.length && st.failed.size >= st.data.images.length

  async function read({ html = null } = {}) {
    if (st.busy) return
    // a link shared from a phone app often comes with its title around it: keep just the link
    let link = url.value.trim()
    const found = !LINK.test(link) && link.match(/https?:\/\/[^\s<>"'“”]+/i)
    if (found) { link = found[0]; url.value = link }
    if (html != null && !LINK.test(link)) link = '' // a pasted page says where it came from itself
    else if (!LINK.test(link)) {
      st.error = { text: link ? 'That isn’t a web link: paste the address of the shop’s product page (https://…).' : 'Paste the product page’s link first.', local: true }
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
      const d = await lib.readProduct(link, html != null ? { html } : undefined)
      if (seq !== st.seq) return
      if (html != null && typeof d?.url === 'string' && LINK.test(d.url)) { url.value = d.url; link = d.url } // the page that was read
      st.data = {
        ...d,
        dims_candidates: Array.isArray(d?.dims_candidates) ? d.dims_candidates.filter((c) => c && c.w > 0 && c.d > 0) : [],
        images: Array.isArray(d?.images) ? d.images.filter((im) => im && LINK.test(String(im.url || ''))) : [],
        variants: Array.isArray(d?.variants) ? d.variants : [],
        warnings: Array.isArray(d?.warnings) ? d.warnings : [],
      }
      st.readUrl = link
      prefill(st.data)
    } catch (e) {
      if (seq !== st.seq) return
      if (st.data) clearPrefill()
      st.data = null
      st.readUrl = ''
      st.picture = -1
      st.error = { text: sentence(e?.message || 'Couldn’t read that page.'), blocked: !!e?.blocked }
      if (st.error.blocked) pasteEl.open = true
    } finally {
      if (html != null) pasteBox.placeholder = 'Paste the copied page here'
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
  function render() {
    readBtn.disabled = st.busy // focus that falls to <body> meanwhile is put back on Read (or Use Image link) after
    readBtn.setAttribute('aria-busy', String(st.busy))
    readBtn.replaceChildren(...(st.busy ? [ring(null, { size: 16 }), h('span', 'Reading…')] : [h('span', 'Read')]))
    if (st.busy) setStatus('busy', 'Reading the page…')
    else if (st.data) setStatus(st.data.dims_candidates.length && st.data.images.length && st.data.dims_candidates[st.size]?.h > 0 && !allPicturesFailed() ? 'ok' : 'warn', foundText(st.data))
    else setStatus(null, '')
    errBox.hidden = !st.error || st.busy
    errText.textContent = st.error?.text || ''
    useLink.hidden = !st.error || !!st.error.local
    picWarn.hidden = !allPicturesFailed()
    renderPics()
    renderSizes()
    renderNotes()
  }
  function setStatus(kind, text) {
    status.hidden = !kind
    status.className = `ms-prod-status${kind ? ` is-${kind}` : ''}`
    const glyph = kind === 'busy' ? ring(null, { size: 16 }) : kind === 'ok' ? pic('check', { size: 16 }) : kind === 'warn' ? pic('info', { size: 16 }) : null
    status.replaceChildren(...(glyph ? [glyph] : []), h('span', text))
  }

  let drawn = null // the answer the strip shows: rebuilt only for a new one
  function renderPics() {
    const data = st.data
    if (data === drawn) return
    drawn = data
    const imgs = data?.images || []
    picRow.hidden = !imgs.length
    const name = data?.name || 'the piece'
    strip.scrollLeft = 0
    strip.replaceChildren(...imgs.map((im, i) => {
      const img = document.createElement('img')
      img.referrerPolicy = 'no-referrer' // before src: the shop never learns where its picture is shown
      img.loading = 'lazy'
      img.decoding = 'async'
      img.draggable = false
      img.alt = `${cap(name)}, picture ${i + 1} of ${imgs.length}`
      img.addEventListener('error', () => { if (st.data === data) pictureFailed(i) })
      img.src = im.url
      return h('button.ms-prod-pic', { type: 'button', dataset: { midstudy: 'product-pic', index: String(i) }, hidden: st.failed.has(i), title: im.url, onclick: () => pickPicture(i) },
        img, h('span.ms-prod-tick', { 'aria-hidden': 'true' }, pic('check', { size: 14, stroke: 2.2 })))
    }))
    markPicture()
  }
  function markPicture() {
    for (const b of strip.children) b.setAttribute('aria-pressed', String(Number(b.dataset.index) === st.picture))
    const chosen = strip.querySelector('[aria-pressed="true"]')
    if (chosen && (chosen.offsetLeft < strip.scrollLeft || chosen.offsetLeft + chosen.offsetWidth > strip.scrollLeft + strip.clientWidth)) {
      strip.scrollLeft = Math.max(0, chosen.offsetLeft - 8)
    }
  }
  function pickPicture(i) {
    if (st.failed.has(i)) return
    st.picture = i
    markPicture()
    changed()
  }
  function pictureFailed(i) {
    if (!st.data || st.failed.has(i)) return
    st.failed.add(i)
    const b = strip.querySelector(`[data-index="${i}"]`)
    if (b) b.hidden = true
    const n = st.data.images.length
    if (st.picture === i) {
      st.picture = -1
      for (let k = 1; k < n; k++) { const j = (i + k) % n; if (!st.failed.has(j)) { st.picture = j; break } }
      markPicture()
    }
    picRow.hidden = st.failed.size >= n
    picWarn.hidden = !allPicturesFailed()
    if (allPicturesFailed()) setStatus('warn', foundText(st.data))
    renderNotes()
    changed()
  }

  const sameDims = (c, v) => !!v && ['w', 'd', 'h'].every((k) => (c[k] > 0 ? Math.abs(c[k] - (v[k] ?? NaN)) < 0.05 : !(v[k] > 0)))
  function currentDims() {
    const [w, d, hh] = dimInputs().map((x) => parseFloat(String(x.value).replace(',', '.')))
    return { w, d, h: hh }
  }
  function renderSizes() {
    const cands = st.data?.dims_candidates || []
    sizesEl.hidden = !st.active || cands.length < 2
    const label = (i) => st.data.variants.find((v) => v.dims_index === i)?.label || cands[i].label || `Size ${i + 1}`
    sizesEl.replaceChildren(...(cands.length < 2 ? [] : cands.map((c, i) => h('button.ms-prod-size', { type: 'button', title: `${label(i)}: ${dimsLabel(c)}`, 'aria-label': `${label(i)}: ${dimsLabel(c)}`, dataset: { midstudy: 'product-size', index: String(i) }, onclick: () => pickSize(i) },
      h('b', clipText(label(i), 60)), h('span.tnum', dimsLabel(c))))))
    markSizes()
  }
  function markSizes() {
    const cands = st.data?.dims_candidates || []
    const now = currentDims()
    for (const b of sizesEl.children) b.setAttribute('aria-pressed', String(sameDims(cands[Number(b.dataset.index)], now)))
  }
  function pickSize(i) {
    const c = st.data?.dims_candidates?.[i]
    if (!c) return
    st.size = i
    setDims(c, { force: true })
    markSizes()
    renderNotes()
    changed()
  }
  form.dims.addEventListener('input', () => markSizes())

  function renderNotes() {
    const d = st.data
    const lines = []
    if (d) {
      const c = d.dims_candidates[st.size]
      if (c) {
        if (c.source === 'llm') lines.push(['warn', 'A language model found this size in the page’s words: check it.'])
        if (c.unit_note) lines.push(['info', sentence(c.unit_note)])
        for (const n of Array.isArray(c.notes) ? c.notes : []) lines.push(['info', sentence(n)])
        if (c.quote && (c.source === 'text' || c.source === 'llm')) lines.push(['quote', `On the page: “${clipText(c.quote, 140)}”`])
      }
      for (const v of d.variants) if (v && v.dims_index == null && v.label) lines.push(['info', `The shop also has ${clipText(v.label, 40)}, but its size couldn’t be read.`])
      for (const w of d.warnings) lines.push(['warn', sentence(w)])
      if (c && !(c.h > 0)) lines.push(['warn', 'No height on the page: enter it in Height.'])
      if (st.failed.size && !allPicturesFailed()) lines.push(['info', `${st.failed.size} of the page’s pictures wouldn’t load, so ${st.failed.size === 1 ? 'it’s' : 'they’re'} left out.`])
      const where = whereText(layersOf(d))
      if (where) lines.push(['info', `Read from ${where}.`])
      const askedLlm = (d.source_layers_used || []).includes('llm')
      if (askedLlm && !d.dims_candidates.some((x) => x.source === 'llm')) lines.push(['info', 'A language model looked for the size in the page’s words and found none.'])
      if (d.cost_usd > 0) lines.push(['info', `The language model cost ${fmtUsd(d.cost_usd)}.`])
      else if (askedLlm && d.mock) lines.push(['info', 'The language model was a test stand-in: no charge.'])
    }
    notesEl.hidden = !st.active || !lines.length
    notesEl.replaceChildren(...lines.map(([kind, text]) => h(`li.is-${kind}`, pic(kind === 'warn' ? 'warning' : kind === 'quote' ? 'search' : 'info', { size: 14 }), h('span', text))))
  }

  render()
  return {
    el, sizesEl, notesEl, read,
    multiSize: () => (st.data?.dims_candidates?.length || 0) > 1,
    setActive(on) {
      st.active = !!on
      el.hidden = !on
      renderSizes()
      renderNotes()
    },
    pictureUrl: () => (st.data && st.picture >= 0 && !st.failed.has(st.picture) ? st.data.images[st.picture]?.url || null : null),
    problem() {
      if (st.busy) return 'Reading the page…'
      if (!st.data) return url.value.trim() ? 'Read the page first' : 'Paste a product page link'
      if (url.value.trim() !== st.readUrl) return 'Read this link first'
      if (!st.data.images.length) return 'No picture on the page'
      if (allPicturesFailed()) return 'No picture would load: use Image link'
      if (st.picture < 0) return 'Choose a picture'
      return null
    },
  }
}
