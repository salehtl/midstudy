// Library manager sheets (§2.8): Add furniture (a product page (§2.11, panels/productsrc.js), a photo from the phone,
// an image link, or a 3D file) with the price shown before you confirm and today's remaining fal budget, and Edit
// (name, category, size, turn, shows as, wall).
// Both are ui/sheet.js sheets; the jobs they start show in the Library panel. Styles: styles/manage.css.
import { h, segmented } from '../kit.js'
import { openSheet, formRow, textInput } from '../sheet.js'
import { pic } from './common.js'
import { estimateCost, LIB_PRICE, DEFAULT_IMAGE_ENGINE } from '../../data.js'
import { productSource } from './productsrc.js'
import { fmtUsd } from '../../engine.js'

const usd = (v) => (v > 0 ? fmtUsd(v) : 'free')
// The Add form's Model choice (contract §4.6 lib-engine), in this order; Idol is the default.
const ENGINES = [{ value: 'idol', label: 'Idol' }, { value: 'sam3d', label: 'SAM 3D' }, { value: 'trellis2', label: 'TRELLIS 2' }, { value: 'rug', label: 'Flat rug' }]
const num = (v) => { const x = parseFloat(String(v ?? '').replace(',', '.').replace('−', '-')); return Number.isFinite(x) ? x : null }
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64)

// W × D × H in cm: three fields in a row.
function dimsFields(dims, onInput) {
  const f = (k, label) => {
    const input = textInput({ value: dims?.[k] ?? '', inputmode: 'decimal', label: `${label} in cm`, onInput })
    return h('label.ms-dim', h('span.ms-dim-k', label), input, h('span.ms-dim-u', 'cm'))
  }
  const fields = { w: f('w', 'Width'), d: f('d', 'Depth'), h: f('h', 'Height') }
  const el = h('div.ms-dims', fields.w, h('span.ms-x', '×'), fields.d, h('span.ms-x', '×'), fields.h)
  el.value = () => {
    const v = Object.fromEntries(Object.entries(fields).map(([k, x]) => [k, num(x.querySelector('input').value)]))
    return ['w', 'd', 'h'].every((k) => v[k] > 0) ? v : null
  }
  return el
}

function budgetLine(spend, cost) {
  if (!spend || !Number.isFinite(spend.cap_usd)) return h('span.ms-budget', 'Today’s budget: checking…')
  const used = (spend.spent_usd || 0) + (spend.reserved_usd || 0)
  const left = Math.max(0, spend.cap_usd - used)
  const over = cost > 0 && cost > left + 1e-9
  return h(`span.ms-budget${over ? '.is-over' : ''}`, over
    ? `Over today’s fal budget: ${fmtUsd(left)} of ${fmtUsd(spend.cap_usd)} left. Try a cheaper model, or tomorrow.`
    : `Today: ${fmtUsd(used)} of ${fmtUsd(spend.cap_usd)} used · ${fmtUsd(left)} left`)
}

// --- Add furniture ---------------------------------------------------------------------------------------------
export function openAddSheet(ctx, { onAdded } = {}) {
  const { shell, lib } = ctx
  const st = { source: 'product', file: null, model: null, engine: DEFAULT_IMAGE_ENGINE, resolution: 1024, mount: false, busy: false, error: '' }
  let preview = null

  const photoInput = h('input.ms-file-input', { type: 'file', accept: 'image/*', onchange: (e) => { st.file = e.target.files?.[0] || null; showFile(); sync() } })
  const modelInput = h('input.ms-file-input', { type: 'file', accept: '.glb,.zip,model/gltf-binary,application/zip', onchange: (e) => { st.model = e.target.files?.[0] || null; showFile(); sync() } })
  const fileName = h('span.ms-file-name')
  const fileThumb = h('span.ms-file-thumb', pic('image', { size: 20 }))
  const photoPick = h('label.ms-file', photoInput, fileThumb, h('span.ms-file-text', h('b.ms-file-cta', 'Choose a photo'), fileName))
  const modelName = h('span.ms-file-name')
  const modelPick = h('label.ms-file', modelInput, h('span.ms-file-thumb', pic('cube3', { size: 20 })), h('span.ms-file-text', h('b.ms-file-cta', 'Choose a 3D file'), modelName))
  const urlInput = textInput({ placeholder: 'https://… .jpg', type: 'url', inputmode: 'url', label: 'Image link', onInput: () => sync() })
  const photoBox = h('div.ms-src', photoPick, h('span.ms-hint', 'A clear photo of the piece on its own: the phone’s camera or library works. JPEG, PNG, HEIC or WebP, up to 20 MB.'))
  const linkBox = h('div.ms-src', formRow('Image link', urlInput, 'The image’s own link: right-click the picture on the shop page, Copy Image Address.'))
  const modelBox = h('div.ms-src', modelPick, h('span.ms-hint', 'A .glb, or a .zip with one .obj, its .mtl and textures (up to 200 MB). .gltf or .usdz: convert to GLB first.'))
  const source = segmented([{ value: 'product', label: 'Product page' }, { value: 'photo', label: 'Photo' }, { value: 'link', label: 'Image link' }, { value: 'model', label: '3D file' }], st.source,
    (v) => setSource(v), { label: 'Add from' })
  source.classList.add('ms-seg', 'ms-src-seg')
  for (const b of source.children) b.dataset.midstudy = `lib-src-${b.dataset.value}` // lib-src-product, -photo, -link, -model
  source.firstChild.setAttribute('aria-label', 'Product page')
  source.firstChild.firstChild.replaceChildren('Product', h('span.ms-seg-long', ' page')) // "Product" on a phone
  const setSource = (v) => { st.source = v; source.set(v); showSource(); sync() }

  const name = textInput({ placeholder: 'Oak reading chair', maxLength: 120, label: 'Name', onInput: () => sync() })
  const dims = dimsFields(null, () => sync())
  const category = textInput({ placeholder: 'chair, lamp, shelf…', maxLength: 40, label: 'Category' })
  // Names only (all four fit on one row on a phone); the price box below shows what the chosen one costs.
  const engineSeg = segmented(ENGINES.map(({ value, label }) => ({ value, label })), st.engine,
    (v) => { st.engine = v; rugDefaults(); sync() }, { label: 'Model' })
  engineSeg.classList.add('ms-seg', 'ms-seg-engine')
  engineSeg.dataset.midstudy = 'lib-engine'
  const resSeg = segmented(Object.entries(LIB_PRICE.trellis2).map(([r, p]) => ({ value: r, label: `${r} · ${usd(p)}` })), String(st.resolution),
    (v) => { st.resolution = Number(v); sync() }, { label: 'Detail' })
  resSeg.classList.add('ms-seg')
  const product = productSource({ lib, form: { name, dims, category, getEngine: () => st.engine, setEngine: (v) => { st.engine = v; engineSeg.set(v); rugDefaults(); sync() } },
    onChange: () => sync(), onUseLink: (img) => { if (img && !urlInput.value.trim()) urlInput.value = img; setSource('link'); urlInput.focus() } })
  const engineHint = h('span.ms-hint')
  const engineRow = h('div.ms-row', h('span.ms-label', 'Model'), engineSeg, engineHint)
  const resRow = h('div.ms-row', h('span.ms-label', 'Detail'), resSeg)
  const costBig = h('b.ms-cost-big.tnum', { dataset: { midstudy: 'lib-cost' } })
  const costWord = h('span.ms-cost-word')
  const budget = h('div.ms-budget-slot')
  const cost = h('div.ms-cost', h('div.ms-cost-head', costWord, costBig), budget)
  const errEl = h('p.ms-error', { role: 'alert', hidden: true })
  const replaceEl = h('p.ms-note', { hidden: true }, pic('info', { size: 16 }), h('span'))

  const body = h('div.ms-form',
    source, product.el, photoBox, linkBox, modelBox,
    formRow('Name', name),
    h('div.ms-row', h('span.ms-label', 'Real size · W × D × H'), product.sizesEl, dims, h('span.ms-hint', 'Measure the piece, or take it from the product page: the model is fitted to exactly this.'), product.notesEl),
    formRow('Category', category, 'Optional'),
    engineRow, resRow, cost, replaceEl, errEl)
  const cancel = h('button.btn.btn-secondary.ms-btn', { type: 'button', onclick: () => sheet.close() }, 'Cancel')
  const go = h('button.btn.btn-primary.ms-btn.ms-primary', { type: 'button', onclick: () => submit() })
  const sheet = openSheet(shell, { title: 'Add furniture', sub: 'Made at its real size from a product page, a photo, an image link or a 3D file.', body, actions: [cancel, go], cls: 'ms-add', onClose: () => { if (preview) URL.revokeObjectURL(preview) } })

  function showSource() {
    product.setActive(st.source === 'product')
    photoBox.hidden = st.source !== 'photo'
    linkBox.hidden = st.source !== 'link'
    modelBox.hidden = st.source !== 'model'
  }
  function showFile() {
    if (preview) { URL.revokeObjectURL(preview); preview = null }
    if (st.file) {
      preview = URL.createObjectURL(st.file)
      fileThumb.replaceChildren(h('img', { src: preview, alt: '' }))
      fileName.textContent = st.file.name
    } else { fileThumb.replaceChildren(pic('image', { size: 20 })); fileName.textContent = '' }
    modelName.textContent = st.model ? `${st.model.name} · ${(st.model.size / 1e6).toFixed(1)} MB` : ''
    // a name from the file, if none yet
    const f = st.source === 'model' ? st.model : st.file
    if (f && !name.value.trim()) name.value = f.name.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 120)
  }
  const kind = () => (st.source === 'model' ? 'model' : 'image')
  const meta = () => {
    const m = { name: name.value.trim(), dims_cm: dims.value() }
    // a shop that sells several sizes: each size made is its own piece (the same id would replace the other size)
    const d = m.dims_cm
    const id = slug(st.source === 'product' && product.multiSize() && d ? `${m.name} ${+d.w.toFixed(1)}x${+d.d.toFixed(1)}` : m.name)
    if (id) m.id = id
    if (category.value.trim()) m.category = category.value.trim()
    if (kind() === 'image') { m.engine = st.engine; if (st.engine === 'trellis2') m.resolution = st.resolution }
    return m
  }
  const price = () => estimateCost(meta(), kind())
  function problem() {
    if (st.source === 'product') { const why = product.problem(); if (why) return why }
    if (st.source === 'photo' && !st.file) return 'Choose a photo'
    if (st.source === 'model' && !st.model) return 'Choose a 3D file'
    if (st.source === 'link' && !/^https?:\/\/\S+$/i.test(urlInput.value.trim())) return 'Paste an image link'
    if (!name.value.trim()) return 'Give it a name'
    if (!dims.value()) return 'Enter its size in cm'
    return null
  }
  // Flat rug: H is the thickness, so fill in 1 cm (and the category) when they're still empty. Switching to another
  // model takes back what it filled in, if it's still as filled (a paid Idol add mustn't come out 1 cm tall).
  const prefilled = { h: null, category: null }
  function rugDefaults() {
    const hIn = dims.querySelectorAll('input')[2]
    if (st.engine !== 'rug') {
      if (hIn && prefilled.h != null && hIn.value === prefilled.h) hIn.value = ''
      if (prefilled.category != null && category.value === prefilled.category) category.value = ''
      prefilled.h = prefilled.category = null
      return
    }
    if (hIn && !hIn.value.trim()) { hIn.value = '1'; prefilled.h = '1' }
    if (!category.value.trim()) { category.value = 'rug'; prefilled.category = 'rug' }
  }
  function sync() {
    const isModel = st.source === 'model'
    const isRug = !isModel && st.engine === 'rug'
    engineHint.textContent = isRug
      ? 'For a rug seen from straight above, like a shop’s picture: laid flat at W × D, H is its thickness (about 1 cm). No model call.'
      : `Idol (${usd(LIB_PRICE.idol)}) looks the most like your photo: it's made of soft coloured points rather than solid surfaces. `
        + `SAM 3D (${usd(LIB_PRICE.sam3d)}) is quick and cheap. TRELLIS 2 (from ${usd(LIB_PRICE.trellis2[512])}) makes a solid model with fine detail. `
        + `Flat rug (free) is for a rug pictured from above.`
    engineRow.hidden = isModel
    resRow.hidden = isModel || st.engine !== 'trellis2'
    const p = price()
    costWord.textContent = isModel ? 'Your own model' : isRug ? 'Flat rug from the picture' : st.engine === 'trellis2' ? `TRELLIS 2 at ${st.resolution}`
      : `${ENGINES.find((e) => e.value === st.engine)?.label || st.engine} from the photo`
    costBig.textContent = p > 0 ? fmtUsd(p) : 'Free'
    const spend = lib.getState().spend
    budget.replaceChildren(isModel ? h('span.ms-budget', 'No model call: it’s normalized to its size and added. $0.')
      : isRug ? h('span.ms-budget', 'No model call: the picture is laid on the floor at its size. $0.') : budgetLine(spend, p))
    const used = spend ? (spend.spent_usd || 0) + (spend.reserved_usd || 0) : 0
    const over = !isModel && !isRug && spend && p > Math.max(0, spend.cap_usd - used) + 1e-9
    const why = problem()
    go.disabled = st.busy || !!why || !!over
    go.textContent = st.busy ? 'Sending…' : why || (p > 0 ? `Make it · ${fmtUsd(p)}` : 'Add · free')
    errEl.hidden = !st.error
    errEl.textContent = st.error
    // re-adding an id replaces that piece (§2.8): say so before Make
    const m = meta()
    const existing = m.id && (ctx.engine?.getLibrary?.() || []).find((it) => it.id === m.id)
    replaceEl.hidden = !existing
    if (existing) replaceEl.lastChild.textContent = `“${existing.name || existing.id}” is already in your library: this replaces it.`
  }
  async function submit() {
    if (problem() || st.busy) return
    st.busy = true
    st.error = ''
    sync()
    const m = meta()
    try {
      const job = st.source === 'link' ? await lib.addFromUrl(urlInput.value.trim(), m)
        : st.source === 'product' ? await lib.addFromUrl(product.pictureUrl(), m) // the chosen picture, as an image-link add
        : await lib.addFromFile(st.source === 'model' ? st.model : st.file, m)
      sheet.close()
      onAdded?.(job, m)
    } catch (e) {
      st.busy = false
      st.error = e.message
      sync()
    }
  }
  const onSpend = () => { if (sheet.isOpen()) sync() }
  lib.events.addEventListener('spend', onSpend)
  lib.spend().catch(() => {})
  showSource()
  sync()
  return sheet
}

// --- Edit a library item -----------------------------------------------------------------------------------------
export function openEditSheet(ctx, item, { onRemove } = {}) {
  const { shell, lib } = ctx
  const st = { turn: 0, render: item.default_render || 'glb', mount: item.mount === 'wall', busy: false, error: '' }
  const name = textInput({ value: item.name || item.id, maxLength: 120, label: 'Name', onInput: () => sync() })
  const category = textInput({ value: item.category || '', placeholder: 'chair, lamp, shelf…', maxLength: 40, label: 'Category' })
  const dims = dimsFields(item.dims_cm, () => sync())
  const turn = segmented([0, 90, 180, 270].map((d) => ({ value: String(d), label: d ? `${d}°` : 'As is' })), '0', (v) => { st.turn = Number(v); sync() }, { label: 'Turn the model' })
  turn.classList.add('ms-seg')
  const refit = h('p.ms-note', { hidden: true }, pic('info', { size: 16 }), h('span', 'A new size or turn refits the model to it on the server. No model call, $0. Pieces already placed update when it’s done.'))
  const errEl = h('p.ms-error', { role: 'alert', hidden: true })
  // Shows as (§4.5): only for a piece with a splat and a real mesh (SAM 3D). An Idol piece's model.glb is a stand-in
  // box that is never drawn, and a piece without a splat has nothing to switch to.
  const assets = item.assets || {}
  const canSwitch = !!(assets.spz || assets.splat) && !!assets.glb && item.source?.engine !== 'idol'
  const showsAs = canSwitch ? segmented([{ value: 'splat', label: 'Splat' }, { value: 'glb', label: 'Mesh' }], st.render, (v) => { st.render = v; sync() }, { label: 'Shows as' }) : null
  if (showsAs) { showsAs.classList.add('ms-seg'); showsAs.dataset.midstudy = 'lib-shows-as' }
  const body = h('div.ms-form',
    formRow('Name', name),
    formRow('Category', category),
    h('div.ms-row', h('span.ms-label', 'Real size · W × D × H'), dims),
    h('div.ms-row', h('span.ms-label', 'Turn the model'), turn, h('span.ms-hint', 'If its front doesn’t face you when placed: turns it for good, relative to now.')),
    showsAs ? h('div.ms-row', h('span.ms-label', 'Shows as'), showsAs, h('span.ms-hint', 'Splat: the photo-real points the model made. Mesh: its solid 3D model. Pieces already placed switch at once.')) : null,
    refit, errEl)
  const remove = h('button.btn.btn-quiet.ms-btn.ms-remove', { type: 'button', dataset: { midstudy: 'lib-remove' }, onclick: () => { sheet.close(); onRemove?.(item) } }, pic('trash', { size: 18 }), h('span', 'Remove'))
  const cancel = h('button.btn.btn-secondary.ms-btn', { type: 'button', onclick: () => sheet.close() }, 'Cancel')
  const save = h('button.btn.btn-primary.ms-btn.ms-primary', { type: 'button', onclick: () => submit() }, 'Save')
  const sheet = openSheet(shell, { title: `Edit ${item.name || item.id}`, sub: item.id, body, actions: [remove, h('span.ws-spacer'), cancel, save], cls: 'ms-edit' })

  function patch() {
    const p = {}
    const n = name.value.trim()
    if (n && n !== item.name) p.name = n
    const c = category.value.trim()
    if (c !== (item.category || '')) p.category = c || null
    const d = dims.value()
    if (d && ['w', 'd', 'h'].some((k) => Math.abs(d[k] - (item.dims_cm?.[k] ?? 0)) > 1e-6)) p.dims_cm = d
    if (st.turn) p.yaw = st.turn
    if (showsAs && st.render !== (item.default_render || 'glb')) p.default_render = st.render
    return p
  }
  function sync() {
    const p = patch()
    refit.hidden = !(p.dims_cm || p.yaw)
    save.disabled = st.busy || !Object.keys(p).length || !name.value.trim() || !dims.value()
    save.textContent = st.busy ? 'Saving…' : p.dims_cm || p.yaw ? 'Save and refit · free' : 'Save'
    errEl.hidden = !st.error
    errEl.textContent = st.error
  }
  async function submit() {
    const p = patch()
    if (!Object.keys(p).length || st.busy) return
    st.busy = true
    st.error = ''
    sync()
    try {
      const res = await lib.edit(item.id, p)
      sheet.close()
      shell.toast(res?.kind === 'rescale' ? `Refitting ${p.name || item.name}…` : `${p.name || item.name} saved`, { kind: 'ok', id: `lib-edit-${item.id}` })
    } catch (e) {
      st.busy = false
      st.error = e.message
      sync()
    }
  }
  sync()
  return sheet
}
