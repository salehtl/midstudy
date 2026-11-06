// Library manager sheets (§2.8): Add furniture (a product page (§2.11, panels/productsrc.ts), a photo from the phone,
// an image link, or a 3D file) with the price shown before you confirm and today's remaining fal budget, and Edit
// (name, category, size, turn, shows as, wall).
// Both are ui/sheet.ts sheets; the jobs they start show in the Library panel. Styles: styles/manage.css. The forms'
// rules and words: logic/libforms.ts.
import { h, segmented } from '../kit.js'
import { openSheet, formRow, textInput, type Sheet } from '../sheet.js'
import { pic, messageOf } from './common.js'
import { estimateCost, fmtUsd, isLibraryJob, DEFAULT_IMAGE_ENGINE, LIB_PRICE, type DimsCm, type LibraryEntry, type LibraryJob, type Spend, type UiContext } from '../seam.js'
import { productSource } from './productsrc.js'
import {
  addMeta, addProblem, budgetLine, changes, costWord, dimsOf, editPatch, editedText, engineHint, ENGINES, goLabel, modelFileText,
  nameFromFile, overBudget, priceWord, refits, replacesText, rugFill, saveLabel, type AddMeta,
} from '../logic/libforms.js'
import { libName } from '../../logic/library.js'

const usd = (v: number): string => priceWord(v, fmtUsd)

/** W × D × H in cm: three fields in a row. value(): the size, when all three are numbers above 0. */
export type DimsFields = HTMLDivElement & {
  readonly value: () => DimsCm | null
  readonly inputs: readonly [HTMLInputElement, HTMLInputElement, HTMLInputElement]
}
function dimsFields(dims: DimsCm | null | undefined, onInput: () => void): DimsFields {
  const f = (k: 'w' | 'd' | 'h', label: string): { readonly row: HTMLLabelElement; readonly input: HTMLInputElement } => {
    const input = textInput({ value: dims?.[k] ?? '', inputmode: 'decimal', label: `${label} in cm`, onInput })
    return { row: h('label.ms-dim', h('span.ms-dim-k', label), input, h('span.ms-dim-u', 'cm')), input }
  }
  const w = f('w', 'Width')
  const d = f('d', 'Depth')
  const ht = f('h', 'Height')
  const el = h('div.ms-dims', w.row, h('span.ms-x', '×'), d.row, h('span.ms-x', '×'), ht.row)
  return Object.assign(el, { value: () => dimsOf(w.input.value, d.input.value, ht.input.value), inputs: [w.input, d.input, ht.input] as const })
}

function budgetEl(spend: Spend | null, cost: number): HTMLSpanElement {
  const b = budgetLine(spend, cost, fmtUsd)
  return h(`span.ms-budget${b.over ? '.is-over' : ''}`, b.text)
}

type Source = 'product' | 'photo' | 'link' | 'model'
interface AddState {
  source: Source
  file: File | null
  model: File | null
  engine: string
  resolution: number
  busy: boolean
  error: string
}

// --- Add furniture ---------------------------------------------------------------------------------------------
export function openAddSheet(ctx: UiContext, { onAdded }: { readonly onAdded?: (job: LibraryJob | null, meta: AddMeta) => void } = {}): Sheet {
  const { shell, lib } = ctx
  const st: AddState = { source: 'product', file: null, model: null, engine: DEFAULT_IMAGE_ENGINE, resolution: 1024, busy: false, error: '' }
  let preview: string | null = null

  const photoInput: HTMLInputElement = h('input.ms-file-input', { type: 'file', accept: 'image/*', onchange: () => { st.file = photoInput.files?.[0] ?? null; showFile(); sync() } })
  const modelInput: HTMLInputElement = h('input.ms-file-input', { type: 'file', accept: '.glb,.zip,model/gltf-binary,application/zip', onchange: () => { st.model = modelInput.files?.[0] ?? null; showFile(); sync() } })
  const fileName = h('span.ms-file-name')
  const fileThumb = h('span.ms-file-thumb', pic('image', { size: 20 }))
  const photoPick = h('label.ms-file', photoInput, fileThumb, h('span.ms-file-text', h('b.ms-file-cta', 'Choose a photo'), fileName))
  const modelName = h('span.ms-file-name')
  const modelPick = h('label.ms-file', modelInput, h('span.ms-file-thumb', pic('cube3', { size: 20 })), h('span.ms-file-text', h('b.ms-file-cta', 'Choose a 3D file'), modelName))
  const urlInput = textInput({ placeholder: 'https://… .jpg', type: 'url', inputmode: 'url', label: 'Image link', onInput: () => { sync() } })
  const photoBox = h('div.ms-src', photoPick, h('span.ms-hint', 'A clear photo of the piece on its own: the phone’s camera or library works. JPEG, PNG, HEIC or WebP, up to 20 MB.'))
  const linkBox = h('div.ms-src', formRow('Image link', urlInput, 'The image’s own link: right-click the picture on the shop page, Copy Image Address.'))
  const modelBox = h('div.ms-src', modelPick, h('span.ms-hint', 'A .glb, or a .zip with one .obj, its .mtl and textures (up to 200 MB). .gltf or .usdz: convert to GLB first.'))
  const source = segmented<Source>([{ value: 'product', label: 'Product page' }, { value: 'photo', label: 'Photo' }, { value: 'link', label: 'Image link' }, { value: 'model', label: '3D file' }], st.source,
    (v) => { setSource(v) }, { label: 'Add from' })
  source.classList.add('ms-seg', 'ms-src-seg')
  for (const b of source.children) if (b instanceof HTMLElement) b.dataset['midstudy'] = `lib-src-${b.dataset['value'] ?? ''}` // lib-src-product, -photo, -link, -model
  const productBtn = source.firstElementChild
  productBtn?.setAttribute('aria-label', 'Product page')
  productBtn?.firstElementChild?.replaceChildren('Product', h('span.ms-seg-long', ' page')) // "Product" on a phone
  const setSource = (v: Source): void => { st.source = v; source.set(v); showSource(); sync() }

  const name = textInput({ placeholder: 'Oak reading chair', maxLength: 120, label: 'Name', onInput: () => { sync() } })
  const dims = dimsFields(null, () => { sync() })
  const category = textInput({ placeholder: 'chair, lamp, shelf…', maxLength: 40, label: 'Category' })
  // Names only (all four fit on one row on a phone); the price box below shows what the chosen one costs.
  const engineSeg = segmented<string>(ENGINES.map(({ value, label }) => ({ value, label })), st.engine,
    (v) => { st.engine = v; rugDefaults(); sync() }, { label: 'Model' })
  engineSeg.classList.add('ms-seg', 'ms-seg-engine')
  engineSeg.dataset['midstudy'] = 'lib-engine'
  const resSeg = segmented<string>(Object.entries(LIB_PRICE.trellis2).map(([r, p]) => ({ value: r, label: `${r} · ${usd(p)}` })), String(st.resolution),
    (v) => { st.resolution = Number(v); sync() }, { label: 'Detail' })
  resSeg.classList.add('ms-seg')
  const product = productSource({ lib, form: { name, dims, category, getEngine: () => st.engine, setEngine: (v) => { st.engine = v; engineSeg.set(v); rugDefaults(); sync() } },
    onChange: () => { sync() }, onUseLink: (img) => { if (img && !urlInput.value.trim()) urlInput.value = img; setSource('link'); urlInput.focus() } })
  const engineHintEl = h('span.ms-hint')
  const engineRow = h('div.ms-row', h('span.ms-label', 'Model'), engineSeg, engineHintEl)
  const resRow = h('div.ms-row', h('span.ms-label', 'Detail'), resSeg)
  const costBig = h('b.ms-cost-big.tnum', { dataset: { midstudy: 'lib-cost' } })
  const costWordEl = h('span.ms-cost-word')
  const budget = h('div.ms-budget-slot')
  const cost = h('div.ms-cost', h('div.ms-cost-head', costWordEl, costBig), budget)
  const errEl = h('p.ms-error', { role: 'alert', hidden: true })
  const replaceText = h('span')
  const replaceEl = h('p.ms-note', { hidden: true }, pic('info', { size: 16 }), replaceText)

  const body = h('div.ms-form',
    source, product.el, photoBox, linkBox, modelBox,
    formRow('Name', name),
    h('div.ms-row', h('span.ms-label', 'Real size · W × D × H'), product.sizesEl, dims, h('span.ms-hint', 'Measure the piece, or take it from the product page: the model is fitted to exactly this.'), product.notesEl),
    formRow('Category', category, 'Optional'),
    engineRow, resRow, cost, replaceEl, errEl)
  const cancel = h('button.btn.btn-secondary.ms-btn', { type: 'button', onclick: () => { sheet.close() } }, 'Cancel')
  const go = h('button.btn.btn-primary.ms-btn.ms-primary', { type: 'button', onclick: () => { void submit() } })
  const sheet = openSheet(shell, { title: 'Add furniture', sub: 'Made at its real size from a product page, a photo, an image link or a 3D file.', body, actions: [cancel, go], cls: 'ms-add', onClose: () => { if (preview) URL.revokeObjectURL(preview) } })

  function showSource(): void {
    product.setActive(st.source === 'product')
    photoBox.hidden = st.source !== 'photo'
    linkBox.hidden = st.source !== 'link'
    modelBox.hidden = st.source !== 'model'
  }
  function showFile(): void {
    if (preview) { URL.revokeObjectURL(preview); preview = null }
    if (st.file) {
      preview = URL.createObjectURL(st.file)
      fileThumb.replaceChildren(h('img', { src: preview, alt: '' }))
      fileName.textContent = st.file.name
    } else { fileThumb.replaceChildren(pic('image', { size: 20 })); fileName.textContent = '' }
    modelName.textContent = st.model ? modelFileText(st.model.name, st.model.size) : ''
    // a name from the file, if none yet
    const f = st.source === 'model' ? st.model : st.file
    if (f && !name.value.trim()) name.value = nameFromFile(f.name)
  }
  const kind = (): 'image' | 'model' => (st.source === 'model' ? 'model' : 'image')
  const meta = (): AddMeta => addMeta({
    name: name.value, dims: dims.value(), category: category.value,
    productSizes: st.source === 'product' && product.multiSize(), image: kind() === 'image', engine: st.engine, resolution: st.resolution,
  })
  const price = (): number => estimateCost(meta(), kind())
  const problem = (): string | null => addProblem({
    source: st.source, productProblem: st.source === 'product' ? product.problem() : null, hasPhoto: !!st.file, hasModel: !!st.model,
    link: urlInput.value, name: name.value, hasDims: !!dims.value(),
  })
  // Flat rug: H is the thickness, so fill in 1 cm (and the category) when they're still empty. Switching to another
  // model takes back what it filled in, if it's still as filled (a paid Idol add mustn't come out 1 cm tall).
  const prefilled: { h: string | null; category: string | null } = { h: null, category: null }
  function rugDefaults(): void {
    const hIn = dims.inputs[2]
    const r = rugFill(st.engine, hIn.value, category.value, prefilled.h, prefilled.category)
    if (hIn.value !== r.h) hIn.value = r.h
    if (category.value !== r.category) category.value = r.category
    prefilled.h = r.filledH
    prefilled.category = r.filledCategory
  }
  function sync(): void {
    const isModel = st.source === 'model'
    const isRug = !isModel && st.engine === 'rug'
    engineHintEl.textContent = engineHint(isRug, { idol: LIB_PRICE.idol, sam3d: LIB_PRICE.sam3d, trellisFrom: LIB_PRICE.trellis2[512] }, fmtUsd)
    engineRow.hidden = isModel
    resRow.hidden = isModel || st.engine !== 'trellis2'
    const p = price()
    costWordEl.textContent = costWord(isModel, isRug, st.engine, st.resolution)
    costBig.textContent = p > 0 ? fmtUsd(p) : 'Free'
    const spend = lib.getState().spend
    budget.replaceChildren(isModel ? h('span.ms-budget', 'No model call: it’s normalized to its size and added. $0.')
      : isRug ? h('span.ms-budget', 'No model call: the picture is laid on the floor at its size. $0.') : budgetEl(spend, p))
    const over = !isModel && !isRug && overBudget(spend, p)
    const why = problem()
    go.disabled = st.busy || !!why || over
    go.textContent = goLabel(st.busy, why, p, fmtUsd)
    errEl.hidden = !st.error
    errEl.textContent = st.error
    // re-adding an id replaces that piece (§2.8): say so before Make
    const m = meta()
    const existing = m.id ? ctx.engine.getLibrary().find((it) => it.id === m.id) : undefined
    replaceEl.hidden = !existing
    if (existing) replaceText.textContent = replacesText(libName(existing))
  }
  async function submit(): Promise<void> {
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
      st.error = messageOf(e)
      sync()
    }
  }
  const onSpend = (): void => { if (sheet.isOpen()) sync() }
  lib.events.addEventListener('spend', onSpend)
  lib.spend().catch(() => { /* reported */ })
  showSource()
  sync()
  return sheet
}

// --- Edit a library item -----------------------------------------------------------------------------------------
export function openEditSheet(ctx: UiContext, item: LibraryEntry, { onRemove }: { readonly onRemove?: (item: LibraryEntry) => void } = {}): Sheet {
  const { shell, lib } = ctx
  const st = { turn: 0, render: (item.default_render ?? '') || 'glb', busy: false, error: '' }
  const name = textInput({ value: libName(item), maxLength: 120, label: 'Name', onInput: () => { sync() } })
  const category = textInput({ value: item.category ?? '', placeholder: 'chair, lamp, shelf…', maxLength: 40, label: 'Category' })
  const dims = dimsFields(item.dims_cm, () => { sync() })
  const turn = segmented<string>([0, 90, 180, 270].map((d) => ({ value: String(d), label: d ? `${String(d)}°` : 'As is' })), '0', (v) => { st.turn = Number(v); sync() }, { label: 'Turn the model' })
  turn.classList.add('ms-seg')
  const refit = h('p.ms-note', { hidden: true }, pic('info', { size: 16 }), h('span', 'A new size or turn refits the model to it on the server. No model call, $0. Pieces already placed update when it’s done.'))
  const errEl = h('p.ms-error', { role: 'alert', hidden: true })
  // Shows as (§4.5): only for a piece with a splat and a real mesh (SAM 3D). An Idol piece's model.glb is a stand-in
  // box that is never drawn, and a piece without a splat has nothing to switch to.
  const assets = item.assets ?? {}
  const canSwitch = !!((assets.spz ?? '') || assets.splat) && !!assets.glb && item.source?.engine !== 'idol'
  const showsAs = canSwitch ? segmented<string>([{ value: 'splat', label: 'Splat' }, { value: 'glb', label: 'Mesh' }], st.render, (v) => { st.render = v; sync() }, { label: 'Shows as' }) : null
  if (showsAs) { showsAs.classList.add('ms-seg'); showsAs.dataset['midstudy'] = 'lib-shows-as' }
  const body = h('div.ms-form',
    formRow('Name', name),
    formRow('Category', category),
    h('div.ms-row', h('span.ms-label', 'Real size · W × D × H'), dims),
    h('div.ms-row', h('span.ms-label', 'Turn the model'), turn, h('span.ms-hint', 'If its front doesn’t face you when placed: turns it for good, relative to now.')),
    showsAs ? h('div.ms-row', h('span.ms-label', 'Shows as'), showsAs, h('span.ms-hint', 'Splat: the photo-real points the model made. Mesh: its solid 3D model. Pieces already placed switch at once.')) : null,
    refit, errEl)
  const remove = h('button.btn.btn-quiet.ms-btn.ms-remove', { type: 'button', dataset: { midstudy: 'lib-remove' }, onclick: () => { sheet.close(); onRemove?.(item) } }, pic('trash', { size: 18 }), h('span', 'Remove'))
  const cancel = h('button.btn.btn-secondary.ms-btn', { type: 'button', onclick: () => { sheet.close() } }, 'Cancel')
  const save = h('button.btn.btn-primary.ms-btn.ms-primary', { type: 'button', onclick: () => { void submit() } }, 'Save')
  const sheet = openSheet(shell, { title: `Edit ${libName(item)}`, sub: item.id, body, actions: [remove, h('span.ws-spacer'), cancel, save], cls: 'ms-edit' })

  const patch = (): ReturnType<typeof editPatch> => editPatch({
    name: name.value, category: category.value, dims: dims.value(), turn: st.turn, render: st.render, canSwitch: !!showsAs,
    itemName: item.name ?? null, itemCategory: item.category ?? null, itemDims: item.dims_cm ?? null, itemRender: (item.default_render ?? '') || 'glb',
  })
  function sync(): void {
    const p = patch()
    refit.hidden = !refits(p)
    save.disabled = st.busy || !changes(p) || !name.value.trim() || !dims.value()
    save.textContent = saveLabel(st.busy, refits(p))
    errEl.hidden = !st.error
    errEl.textContent = st.error
  }
  async function submit(): Promise<void> {
    const p = patch()
    if (!changes(p) || st.busy) return
    st.busy = true
    st.error = ''
    sync()
    try {
      const res = await lib.edit(item.id, p)
      sheet.close()
      shell.toast(editedText(isLibraryJob(res) && res.kind === 'rescale', String((p.name ?? '') || item.name)), { kind: 'ok', id: `lib-edit-${item.id}` })
    } catch (e) {
      st.busy = false
      st.error = messageOf(e)
      sync()
    }
  }
  sync()
  return sheet
}
