// Panel (area C): Renders, the paid photoreal passes of the open scene (contract §4.7). The list (newest first, with
// cost; a "Rendering…" row while one runs, a failed row "Not charged · Retry…"), Compare (pick two), the empty state,
// the Render confirm (the composite that gets sent, model and price, optional prompt, Keep room exact, "Render ·
// $0.04"), the Render viewer (desktop: what was sent and the render side by side; phone: full screen with a toggle)
// and Compare (full screen: side by side on the desktop, a draggable split on both, swipe between them on the phone).
//
// The workspace's Render button sends shell event 'render-request' and its "Render ready · View" toast 'open-render'
// { meta }; this panel takes both (preventDefault). engine.compare(a, b) (the hook) opens Compare. Also on ctx.renders:
//   openConfirm({ from?: RenderMeta, retry?: failedEntry }) → Promise    openViewer(name | RenderMeta)
//   openCompare(a, b)    getPending() → [{ id, model, started, state, error? }]    events: 'state' 'done' 'failed'
// The words: logic/renders.ts.
import { RENDER_MODELS, renderPrice, quiet, type PendingRender, type RenderMeta, type Shot, type UiContext } from '../seam.js'
import type { SegOption } from '../kit.js'
import { pic, withIcon, emptyState, dayDate, clock, money, modelShort, imageShot, messageOf } from './common.js'
import { dots } from '../logic/text.js'
import {
  ABOUT_S, alignNote, confirmSub, confirmTitle, defaultPromptText, failedTitle, failureReason, goText, modelNote, notAlignedText, ofText, ownPrompt,
  pickHint, renderCost, renderMeta, runningMeta, sentCaption, sentSize, sentWhat, spentOn, stepIndex,
} from '../logic/renders.js'

/** A capture with the photo's size it is sent at (the price and the "what gets sent" line use it). */
interface SentShot extends Shot {
  readonly sentW?: number
  readonly sentH?: number
}
interface Pending {
  readonly id: string
  readonly model: string
  readonly prompt: string
  readonly shot: SentShot | null
  readonly started: number
  readonly keepRoom: boolean
  readonly fromPast: boolean
  state: 'rendering' | 'failed'
  at: number | undefined
  error: string | undefined
  reason: string | undefined
}
type ModalKind = 'confirm' | 'viewer' | 'compare'
interface Modal {
  readonly kind: ModalKind
  readonly els: Element[]
  readonly close: () => void
  readonly rerender: () => void
  step?: (k: number) => void
}
interface ModalContent {
  readonly label: string
  readonly el: HTMLElement
}
type CompareMode = 'side' | 'split' | 'swipe'

export function mount(ctx: UiContext): void {
  const { engine, shell, kit } = ctx
  const { h, button, segmented, toggle } = kit
  const events = new EventTarget()
  const emit = (name: string, detail: unknown): void => { events.dispatchEvent(new CustomEvent(name, { detail })) }
  let pending: Pending[] = []
  let seq = 0
  let tick: ReturnType<typeof setInterval> | null = null
  let modal: Modal | null = null
  let picking: string[] | null = null // names while choosing two renders for Compare

  const panel = shell.registerPanel({ id: 'renders', label: 'Renders', icon: 'renders', phoneDetent: 'half', mount: () => { /* filled below */ } })
  panel.body.classList.add('rn')
  const compareWord = h('span', 'Compare')
  const compareBtn = h('button.btn.btn-secondary.rn-compare', { type: 'button', dataset: { midstudy: 'compare', tip: 'Pick two renders to compare' }, onclick: () => { togglePicking() } }, pic('sliders', { size: 16 }), compareWord)
  panel.actions.append(compareBtn)
  const summary = h('div.rn-summary')
  const pickBar = h('div.rn-pickbar', { hidden: true })
  const list = h('div.rn-list', { role: 'list' })
  const empty = emptyState({
    icon: 'render', title: 'No renders yet',
    body: 'A render turns the photo with your furniture into a photoreal image, about $0.04 each. You see the price before anything is sent.',
    action: button({ label: 'Render…', kind: 'primary', onClick: () => { quiet(openConfirm()) } }),
  })
  panel.body.append(summary, pickBar, list, empty)

  const layoutOf = (m: RenderMeta): string => (m.layout ? engine.layoutDisplayName(m.layout) : '')
  // The layout is what tells two renders apart, so it leads (the title line), then the time, model and keep-room.
  const titleLine = (m: RenderMeta): string => layoutOf(m) || dayDate(m.created)
  const metaLine = (m: RenderMeta): string => renderMeta(layoutOf(m), dayDate(m.created), modelShort(m.model), m)
  const byName = (n: string): RenderMeta | undefined => engine.getRenders().find((r) => r.name === n)
  const focusable = (el: Element | null): HTMLElement | null => (el instanceof HTMLElement ? el : null)

  // --- list ------------------------------------------------------------------------------------------------------
  function togglePicking(): void {
    if (picking) { picking = null; render(); return }
    if (engine.getRenders().length < 2) { shell.toast('Make two renders first, then compare them.', { id: 'compare-need-two' }); return }
    picking = []
    render()
  }
  function pickRow(m: RenderMeta): void {
    if (!picking) return
    const i = picking.indexOf(m.name)
    if (i >= 0) picking.splice(i, 1); else picking.push(m.name)
    const [a, b] = picking
    if (a !== undefined && b !== undefined) { picking = null; render(); void openCompare(a, b); return }
    render()
  }
  function render(): void {
    const renders = engine.getRenders()
    const phone = shell.isPhone()
    panel.setCount(String(renders.length + pending.filter((p) => p.state === 'rendering').length))
    summary.hidden = !renders.length && !pending.length
    summary.replaceChildren(h('span', engine.getSceneName() ? 'This scene · newest first' : 'Newest first'), h('span.rn-spent.tnum', `${money(spentOn(renders))} spent`))
    compareBtn.setAttribute('aria-pressed', String(!!picking))
    compareWord.textContent = picking ? 'Cancel' : 'Compare'
    pickBar.hidden = !picking
    if (picking) pickBar.replaceChildren(pic('info', { size: 16 }), h('span', pickHint(picking.length, phone)))
    const rows: HTMLElement[] = []
    for (const p of pending) {
      const going = p.state === 'rendering'
      rows.push(h(`div.rn-row.is-${p.state}`, { role: 'listitem' },
        h(`span.rn-thumb.is-${p.state}`, going ? h('span', ctx.icons.ring(null, { size: 18 })) : pic('warning', { size: 18 })),
        h('span.rn-text',
          h('span.rn-title', going ? 'Rendering…' : failedTitle(p.reason ?? '')),
          h('span.rn-meta.tnum', going ? runningMeta(modelShort(p.model), p.keepRoom, (Date.now() - p.started) / 1000) : `Not charged · ${clock(p.at)}`)),
        going
          ? h('span.rn-cost.is-pending.tnum', engine.isRenderMock() ? '$0' : money(renderPrice(p.model, p.shot)))
          : h('button.rn-retry', { type: 'button', onclick: () => { quiet(openConfirm({ retry: p })) } }, 'Retry…'),
        going ? null : h('button.rn-dismiss', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { pending = pending.filter((x) => x !== p); changed() } }, pic('close', { size: 16 }))))
    }
    for (const m of renders) {
      const chosen = !!picking?.includes(m.name)
      rows.push(h(`button.rn-row${chosen ? '.is-picked' : ''}`, { type: 'button', role: 'listitem', dataset: { render: m.name }, 'aria-pressed': picking ? String(chosen) : null, onclick: () => { if (picking) pickRow(m); else openViewer(m) } },
        picking ? h('span.rn-check', chosen ? pic('check', { size: 16 }) : null) : null,
        h('img.rn-thumb', { src: m.url, alt: '', loading: 'lazy', draggable: false }),
        h('span.rn-text', h('span.rn-title.tnum', { title: layoutOf(m) || null }, titleLine(m)), h('span.rn-meta', metaLine(m))),
        h('span.rn-cost.tnum', renderCost(m)),
        phone && !picking ? h('span.rn-chev', pic('chevron-right', { size: 18 })) : null))
    }
    list.replaceChildren(...rows)
    empty.hidden = rows.length > 0 || !engine.getSceneName()
  }
  function changed(): void {
    render()
    const going = pending.some((p) => p.state === 'rendering')
    if (going && !tick) tick = setInterval(render, 5000)
    if (!going && tick) { clearInterval(tick); tick = null }
    emit('state', { pending: getPending() })
  }
  const getPending = (): PendingRender[] => pending.map(({ id, model, started, state, error }) => ({ id, model, started, state, error }))

  // --- modal plumbing (dialog on desktop, full-height sheet on the phone) ------------------------------------------
  function openModal(kind: ModalKind, build: (o: { readonly phone: boolean; readonly close: () => void }) => ModalContent): Modal {
    modal?.close()
    const els: Element[] = []
    const close = (): void => {
      if (modal?.els !== els) return
      for (const e of els) e.remove()
      modal = null
    }
    const rerender = (): void => {
      for (const e of els.splice(0)) e.remove()
      const phone = shell.isPhone()
      const content = build({ phone, close })
      const scrim = h('div.scrim', { onclick: () => { close() } })
      const box = h(`div.rn-modal.is-${kind}.is-${phone ? 'phone' : 'desktop'}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': content.label }, content.el)
      els.push(scrim, box)
      shell.mounts.layer.append(scrim, box)
      if (!phone) requestAnimationFrame(() => { (focusable(box.querySelector('[data-autofocus]')) ?? focusable(box.querySelector('button')))?.focus() })
    }
    const m: Modal = { kind, els, close, rerender }
    modal = m
    rerender()
    return m
  }
  shell.addKeyFilter((e) => {
    if (!modal) return false
    if (e.key === 'Escape') { e.preventDefault(); modal.close() } else if ((modal.kind === 'viewer' || modal.kind === 'compare') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !(e.target instanceof Element && e.target.closest('input, textarea'))) {
      e.preventDefault()
      modal.step?.(e.key === 'ArrowRight' ? 1 : -1)
    }
    return true
  })
  shell.events.addEventListener('mode', () => { render(); modal?.rerender() })

  // --- confirm ---------------------------------------------------------------------------------------------------
  async function openConfirm({ from = null, retry = null }: { readonly from?: RenderMeta | null; readonly retry?: Pending | null } = {}): Promise<void> {
    if (!engine.getSceneName()) { shell.toast('Open a scene first.', { id: 'no-scene' }); return }
    let shot: SentShot | null = retry?.shot ?? null
    let model = (retry?.model ?? '') || (from && RENDER_MODELS[from.model] ? from.model : Object.keys(RENDER_MODELS)[0] ?? '')
    let prompt = retry ? retry.prompt : ownPrompt(from?.prompt)
    const current = !from && !retry?.fromPast
    // On by default since the live check (PLAN.md §8, 2026-11-05): the room stays the photo at full size, sharp.
    let keepRoom = retry ? retry.keepRoom : current
    const items = engine.getItems().length
    let loadError: string | null = null
    if (!shot && !from) {
      try {
        const captured = await engine.captureComposite({ maxPx: 1024, quality: 0.85 })
        const ph = engine.getPhotoSize()
        shot = { ...captured, sentW: ph.w, sentH: ph.h }
      } catch (e) { engine.reportError('Could not capture the scene', e); return }
    }
    const m = openModal('confirm', ({ phone, close }) => {
      const title = confirmTitle(!!from, !!retry)
      const sub = confirmSub(from ? dayDate(from.created) : null, !!retry)
      const sizeShot = shot ? { width: (shot.sentW ?? 0) || shot.width, height: (shot.sentH ?? 0) || shot.height } : null
      const price = (): number => (engine.isRenderMock() ? 0 : renderPrice(model, sizeShot))
      const goLabel = (): string => goText(engine.isRenderMock(), price())
      const go = withIcon(button({ label: goLabel(), kind: 'primary', block: phone, disabled: !shot, onClick: () => { submit() } }), 'render')
      go.dataset['autofocus'] = ''
      go.dataset['midstudy'] = 'render-go'
      const setGo = (): void => {
        const word = go.lastChild
        if (word) word.textContent = goLabel()
        go.disabled = !shot
      }
      const models = h('div.rc-models', { role: 'radiogroup', 'aria-label': 'Model' })
      for (const [key, def] of Object.entries(RENDER_MODELS)) {
        const b: HTMLButtonElement = h('button.rc-model', { type: 'button', role: 'radio', 'aria-checked': String(key === model),
          onclick: () => { model = key; for (const x of models.children) x.setAttribute('aria-checked', String(x === b)); setGo() } },
        h('span.rc-radio'), h('span.rc-model-text', h('span.rc-model-name', def.label), h('span.rc-model-note', modelNote(key))),
        h('span.rc-price.tnum', { dataset: { model: key } }, engine.isRenderMock() ? '$0' : money(renderPrice(key, sizeShot))))
        models.append(b)
      }
      const promptEl = h(phone ? 'input.input.rc-prompt' : 'textarea.input.rc-prompt', { placeholder: phone ? 'Add a prompt (optional)' : 'Say what to change, if anything: "evening light, lamps on"', rows: 3, spellcheck: true, 'aria-label': 'Prompt (optional)',
        oninput: () => { prompt = promptEl.value } })
      promptEl.value = prompt
      const keep = toggle({ label: 'Keep room exact', hint: 'Only the furniture changes; the rest stays the photo, aligned to it', checked: keepRoom, onChange: (v) => { keepRoom = v } })
      keep.classList.add('rc-keep')
      keep.input.dataset['midstudy'] = 'keep-room'
      if (!current) {
        keep.input.disabled = true
        const hint = keep.querySelector('.toggle-hint')
        if (hint) hint.textContent = 'Only for the scene as it is now'
      }
      const preview = h('div.rc-preview', shot ? h('img', { src: shot.dataUrl, alt: 'The picture that gets sent' }) : h('span.rc-preview-wait', loadError ? `Could not load that picture: ${loadError}` : 'Loading that picture…'))
      const sizeText = sizeShot ? sentSize(sizeShot.width, sizeShot.height) : '…'
      const whatText = sentWhat(!!from, items)
      if (!phone) preview.append(h('span.rc-caption.tnum', sentCaption(whatText, sizeText, model)))
      const facts = h('div.rc-facts',
        h('span.caps', 'What gets sent'),
        h('p', h('strong', whatText), h('span', 'At the photo’s size')),
        h('p.tnum', h('strong', sizeText), h('span', 'Nano Banana also gets the photo')),
        h('p', h('strong', 'To fal, via the server'), h('span', `The key stays there. About ${String(ABOUT_S)} s.`)))
      const mockNote = engine.isRenderMock() ? h('p.rc-mock', 'Mock mode: nothing goes to fal and nothing is charged.') : null
      const closeBtn = h('button.btn.btn-icon.btn-quiet.rc-close', { type: 'button', 'aria-label': 'Close', onclick: () => { close() } }, pic('close', { size: 16 }))
      const head = h('header.rc-head', h('h2.rc-title', title), h('span.rc-sub', sub), closeBtn)
      function submit(): void {
        if (!shot) return
        close()
        quiet(run({ shot: current ? null : shot, preview: shot, model, prompt: prompt.trim(), keepRoom: current && keepRoom }))
      }
      if (phone) {
        return { label: title, el: h('div.rc-sheet', h('div.sheet-grab', { 'aria-hidden': 'true' }), head,
          h('div.rc-body', h('div.rc-top', preview, facts), h('span.caps.rc-label', 'Model'), models, keep, h('label.rc-prompt-wrap', pic('pencil', { size: 16 }), promptEl), mockNote),
          h('div.rc-foot', go, h('button.rc-cancel', { type: 'button', onclick: () => { close() } }, 'Cancel'))) }
      }
      return { label: title, el: h('div.rc-dialog', head,
        h('div.rc-body', preview, h('span.caps.rc-label', 'Model'), models, keep, h('span.caps.rc-label', 'Prompt · optional'), promptEl, mockNote),
        h('footer.rc-foot', h('p.rc-note', `Goes to fal via the server; the key stays there. About ${String(ABOUT_S)} s.`), button({ label: 'Cancel', kind: 'secondary', onClick: () => { close() } }), go)) }
    })
    if (from && !shot) {
      try { shot = await imageShot(from.input_url) } catch (e) { loadError = messageOf(e) }
      if (modal === m) m.rerender()
    }
  }

  // shot: a past picture to send again, or null for the scene as it is now (captured at the photo's size).
  async function run({ shot, preview, model, prompt, keepRoom }: { readonly shot: SentShot | null; readonly preview: SentShot; readonly model: string; readonly prompt: string; readonly keepRoom: boolean }): Promise<void> {
    const p: Pending = { id: `r${String(++seq)}`, model, prompt, shot: preview, started: Date.now(), state: 'rendering', keepRoom, fromPast: !!shot, at: undefined, error: undefined, reason: undefined }
    pending.unshift(p)
    changed()
    try {
      const meta = shot ? await engine.postRender(shot, { model, prompt: prompt || undefined }) : await engine.renderViewInternal({ model, prompt: prompt || undefined, keepRoom })
      pending = pending.filter((x) => x !== p)
      changed()
      emit('done', { meta })
      if (meta.keep_room && meta.aligned && !meta.aligned.applied) shell.toast(notAlignedText(meta.aligned.reason), { id: `align-${meta.name}`, ms: 9000 })
    } catch (e) {
      const msg = messageOf(e)
      p.state = 'failed'
      p.at = Date.now()
      p.error = msg
      p.reason = failureReason(msg)
      changed()
      emit('failed', { error: msg })
    }
  }

  // --- viewer ----------------------------------------------------------------------------------------------------
  function openViewer(which: string | RenderMeta | null | undefined): void {
    const all = (): readonly RenderMeta[] => engine.getRenders()
    const wanted = typeof which === 'string' ? which : which?.name
    let idx = Math.max(0, all().findIndex((r) => r.name === wanted))
    let side = 'render'
    const m = openModal('viewer', ({ phone, close }) => {
      const rs = all()
      const r = rs[idx] ?? (typeof which === 'object' ? which : null)
      if (!r) return { label: 'Render', el: h('p.p-note', 'That render is gone.') }
      const step = (k: number): void => { if (rs.length < 2) return; idx = stepIndex(idx, k, rs.length); m.rerender() }
      const of = ofText(idx, rs.length)
      const again = withIcon(button({ label: 'Render again…', kind: 'secondary', onClick: () => { quiet(openConfirm({ from: r })) } }), 'render')
      const cmp = rs.length > 1 ? button({ label: 'Compare…', kind: 'secondary', onClick: () => { close(); picking = [r.name]; shell.openPanel('renders'); render() } }) : null
      const p = ownPrompt(r.prompt)
      const promptEl = p ? h('p.rv-prompt', pic('pencil', { size: 14 }), h('span', p)) : null
      const closeBtn = h('button.btn.btn-icon.rv-close', { type: 'button', 'aria-label': 'Close', onclick: () => { close() } }, pic('close', { size: 16 }))
      const sides: SegOption<string>[] = [{ value: 'input', label: 'Sent' }, { value: 'render', label: 'Render' }, ...(r.raw_url ? [{ value: 'raw', label: 'Raw' }] : [])]
      const srcOf = (v: string): string | undefined => (v === 'input' ? r.input_url : v === 'raw' ? r.raw_url ?? undefined : r.url)
      const note = alignNote(r)
      const alignEl = note ? h('span.rv-align', note) : null
      if (phone) {
        const img = h('img.rv-img', { src: srcOf(side), alt: side === 'render' ? 'The render' : side === 'raw' ? "The model's own output" : 'What was sent' })
        const seg = segmented(sides, side, (v) => { side = v; img.src = srcOf(v) ?? '' }, { small: true, label: 'Show' })
        let x0: number | null = null
        const stage = h('div.rv-stage', { onpointerdown: (e) => { x0 = e.clientX }, onpointerup: (e) => { if (x0 !== null && Math.abs(e.clientX - x0) > 60) step(e.clientX < x0 ? 1 : -1); x0 = null } }, img)
        return { label: `Render, ${dayDate(r.created)}`, el: h('div.rv-phone',
          h('header.rv-head', closeBtn, h('div.rv-titles', h('h2.rv-title.tnum', layoutOf(r) || dayDate(r.created)), h('span.rv-sub.tnum', dots([layoutOf(r) ? dayDate(r.created) : null, of, modelShort(r.model), renderCost(r)])))),
          h('div.rv-seg', seg), stage,
          h('footer.rv-foot', alignEl, promptEl, h('div.rv-actions', cmp, again))) }
      }
      const size = h('span.tnum', r.out_w ? `${String(r.out_w)} × ${String(r.out_h)}` : '')
      const right: HTMLImageElement = h('img', { src: (side === 'raw' ? r.raw_url : r.url) ?? undefined, alt: 'The render', onload: () => { size.textContent = `${String(right.naturalWidth)} × ${String(right.naturalHeight)}` } })
      const which2 = r.raw_url ? segmented<string>([{ value: 'render', label: 'Render' }, { value: 'raw', label: 'Raw' }], side === 'raw' ? 'raw' : 'render', (v) => { side = v; right.src = (v === 'raw' ? r.raw_url : r.url) ?? '' }, { small: true, label: 'Show' }) : null
      const nav = rs.length > 1 ? h('div.rv-nav',
        h('button.btn.btn-icon.btn-quiet', { type: 'button', 'aria-label': 'Newer', dataset: { tip: 'Newer', kbd: '←' }, onclick: () => { step(-1) } }, pic('chevron-left', { size: 16 })),
        h('span.tnum', of),
        h('button.btn.btn-icon.btn-quiet', { type: 'button', 'aria-label': 'Older', dataset: { tip: 'Older', kbd: '→' }, onclick: () => { step(1) } }, pic('chevron-right', { size: 16 }))) : null
      return { label: `Render, ${dayDate(r.created)}`, el: h('div.rv-desk',
        h('header.rv-head', h('h2.rv-title.tnum', `Render · ${dayDate(r.created)}`),
          h('span.rv-sub.tnum', dots([layoutOf(r) || null, (RENDER_MODELS[r.model]?.label ?? '') || r.model, renderCost(r)])),
          h('span.rv-spacer'),
          h('a.btn.btn-quiet', { href: (side === 'raw' ? r.raw_url : r.url) ?? undefined, target: '_blank', rel: 'noopener' }, 'Open image'), nav, h('span.rv-sep'), closeBtn),
        h('div.rv-pair',
          h('figure', h('div.rv-frame', h('img', { src: r.input_url, alt: 'What was sent' })), h('figcaption', h('span.caps', 'Sent'), h('span', 'The photo with the furniture'))),
          h('figure', h('div.rv-frame', right), h('figcaption', h('span.caps', 'Render'), which2, size))),
        h('footer.rv-foot', h('div.rv-prompt-block', alignEl, h('span.caps', 'Prompt'), p ? h('p', p) : h('p.muted', defaultPromptText(!!r.reference))),
          h('div.rv-actions', cmp, again))) }
    })
    m.step = (k: number) => { const n = all().length; if (n < 2) return; idx = stepIndex(idx, k, n); m.rerender() }
  }

  // --- compare (§4.5): side by side (desktop), a draggable split (both), swipe (phone) -----------------------------
  async function openCompare(a: string, b: string): Promise<void> {
    let ra = byName(a)
    let rb = byName(b)
    if (!ra || !rb) {
      try { await engine.listRendersInternal() } catch { /* reported */ }
      ra = byName(a)
      rb = byName(b)
    }
    if (!ra || !rb) { engine.reportError(`Can't compare: ${!ra ? a : b} isn't a render of this scene`); return }
    let ma: RenderMeta = ra
    let mb: RenderMeta = rb
    let mode: CompareMode | null = null
    let split = 50
    let shown: 0 | 1 = 0 // swipe: which one
    const m = openModal('compare', ({ phone, close }) => {
      const modes: SegOption<CompareMode>[] = phone ? [{ value: 'split', label: 'Split' }, { value: 'swipe', label: 'Swipe' }] : [{ value: 'side', label: 'Side by side' }, { value: 'split', label: 'Split' }]
      const now: CompareMode = mode !== null && modes.some((x) => x.value === mode) ? mode : phone ? 'split' : 'side'
      mode = now
      const A = ma
      const B = mb
      // A and B are told apart by their layout first (two renders of the same minute differ only there); the phone drops
      // the model to keep the caption readable.
      const tag = (r: RenderMeta, i: 0 | 1): HTMLSpanElement => h('span.cv-tag', { title: dots([layoutOf(r), dayDate(r.created), modelShort(r.model)]) }, h('b', i ? 'B' : 'A'),
        h('span.tnum', dots([layoutOf(r) || null, dayDate(r.created), phone ? null : modelShort(r.model)])))
      const closeBtn = h('button.btn.btn-icon.rv-close', { type: 'button', 'aria-label': 'Close', onclick: () => { close() } }, pic('close', { size: 16 }))
      const seg = segmented(modes, now, (v) => { mode = v; m.rerender() }, { small: true, label: 'Compare as' })
      // Swap A and B: a labelled button on the desktop, an icon button (44 px) in the phone's narrower header.
      const doSwap = (): void => { [ma, mb] = [mb, ma]; m.rerender() }
      const swap = phone
        ? h('button.btn.btn-icon.btn-quiet.cv-swap.is-icon', { type: 'button', 'aria-label': 'Swap A and B', dataset: { midstudy: 'compare-swap' }, onclick: doSwap }, pic('swap', { size: 20 }))
        : h('button.btn.btn-quiet.cv-swap', { type: 'button', dataset: { midstudy: 'compare-swap' }, onclick: doSwap }, 'Swap A and B')
      let stage: HTMLElement
      if (now === 'side') {
        stage = h('div.cv-side', ([A, B] as const).map((r, i) => h('figure', h('div.cv-frame', h('img', { src: r.url, alt: `Render ${i ? 'B' : 'A'}` })), h('figcaption', tag(r, i ? 1 : 0)))))
      } else if (now === 'split') {
        const top = h('img.cv-top', { src: B.url, alt: 'Render B', style: { clipPath: `inset(0 0 0 ${String(split)}%)` } })
        const bar = h('div.cv-bar', { style: { left: `${String(split)}%` } }, h('span.cv-knob', pic('chevron-left', { size: 14 }), pic('chevron-right', { size: 14 })))
        const range = h('input.cv-range', { type: 'range', min: 0, max: 100, step: 0.5, value: split, 'aria-label': 'Split between A and B' })
        const under = h('img.cv-under', { src: A.url, alt: 'Render A' })
        const box = h('div.cv-split', under, top, bar, range)
        // The box has the render's own shape, so the split line and its handle run over the image, not the black bars.
        const setAr = (w: number | null | undefined, hh: number | null | undefined): void => { if (typeof w === 'number' && typeof hh === 'number' && w > 0 && hh > 0) box.style.setProperty('--ar', String(w / hh)) }
        setAr((A.out_w ?? 0) || A.width, (A.out_h ?? 0) || A.height)
        under.addEventListener('load', () => { setAr(under.naturalWidth, under.naturalHeight) })
        const setSplit = (v: number): void => {
          split = Math.max(0, Math.min(100, v))
          top.style.clipPath = `inset(0 0 0 ${String(split)}%)`
          bar.style.left = `${String(split)}%`
          range.value = String(split)
        }
        range.addEventListener('input', () => { setSplit(Number(range.value)) })
        let dragging = false
        const at = (e: PointerEvent): void => { const r = box.getBoundingClientRect(); setSplit(((e.clientX - r.left) / r.width) * 100) }
        box.addEventListener('pointerdown', (e) => { if (e.target === range) return; dragging = true; box.setPointerCapture(e.pointerId); at(e) })
        box.addEventListener('pointermove', (e) => { if (dragging) at(e) })
        box.addEventListener('pointerup', () => { dragging = false })
        box.addEventListener('pointercancel', () => { dragging = false })
        stage = h('div.cv-splitwrap', h('div.cv-splitarea', box), h('div.cv-tags', tag(A, 0), tag(B, 1)))
      } else {
        const r = shown ? B : A
        let x0: number | null = null
        const img = h('img.cv-swipe-img', { src: r.url, alt: `Render ${shown ? 'B' : 'A'}` })
        const box = h('div.cv-swipe', { onpointerdown: (e) => { x0 = e.clientX }, onpointerup: (e) => { if (x0 !== null && Math.abs(e.clientX - x0) > 40) { shown = shown ? 0 : 1; m.rerender() } x0 = null } }, img)
        stage = h('div.cv-swipewrap', box,
          h('div.cv-dots', ([0, 1] as const).map((i) => h(`button.cv-dot${i === shown ? '.is-on' : ''}`, { type: 'button', 'aria-label': `Show ${i ? 'B' : 'A'}`, onclick: () => { shown = i; m.rerender() } }, i ? 'B' : 'A'))),
          h('div.cv-tags', tag(r, shown)))
      }
      return { label: 'Compare renders', el: h(`div.cv.is-${now}`,
        h('header.cv-head', h('h2.cv-title', 'Compare'), seg, h('span.rv-spacer'), swap, closeBtn), stage) }
    })
    m.step = () => { if (mode === 'swipe') { shown = shown ? 0 : 1; m.rerender() } }
  }

  engine.events.addEventListener('renders', () => { render(); if (modal?.kind === 'viewer') modal.rerender() })
  engine.events.addEventListener('scene', (e) => { if (e.detail.phase === 'opened' || e.detail.phase === 'closed') { picking = null; pending = []; modal?.close(); changed() } })
  engine.events.addEventListener('compare', (e) => { quiet(openCompare(e.detail.a, e.detail.b)) })
  shell.events.addEventListener('render-request', (e) => { e.preventDefault(); quiet(openConfirm()) })
  shell.events.addEventListener('open-render', (e) => { e.preventDefault(); openViewer(e.detail.meta) })
  render()
  ctx.renders = { openConfirm, openViewer, openCompare, getPending, events }
}
