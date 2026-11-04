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
import { RENDER_MODELS, renderPrice, quiet } from '../../engine.js'
import { pic, withIcon, emptyState, dayDate, clock, money, modelShort, imageShot } from './common.js'

const ABOUT = 25 // seconds a render usually takes
const MODEL_NOTE = { 'nano-banana': 'Uses the photo as a reference', kontext: 'Freer light, may move things', qwen: 'Restyles more, slower' }
// The server's default prompts (planner/serve.py): shown as "the default", not as a custom prompt.
const DEFAULT_PROMPTS = [/^Image 1 is a photo of a room with 3D models of furniture/, /^Turn this 3D planning render into a photorealistic/]

export function mount(ctx) {
  const { engine, shell, kit } = ctx
  const { h, button, segmented, toggle } = kit
  const events = new EventTarget()
  const emit = (name, detail) => events.dispatchEvent(new CustomEvent(name, { detail }))
  let pending = [] // { id, model, prompt, shot, started, state, error, at, keepRoom }
  let seq = 0
  let tick = null
  let modal = null // { kind: 'confirm'|'viewer'|'compare', close(), rerender() }
  let picking = null // [names] while choosing two renders for Compare

  const panel = shell.registerPanel({ id: 'renders', label: 'Renders', icon: 'renders', phoneDetent: 'half', mount: () => {} })
  panel.body.classList.add('rn')
  const compareBtn = h('button.btn.btn-secondary.rn-compare', { type: 'button', dataset: { midstudy: 'compare', tip: 'Pick two renders to compare' }, onclick: () => togglePicking() }, pic('sliders', { size: 16 }), h('span', 'Compare'))
  panel.actions.append(compareBtn)
  const summary = h('div.rn-summary')
  const pickBar = h('div.rn-pickbar', { hidden: true })
  const list = h('div.rn-list', { role: 'list' })
  const empty = emptyState({
    icon: 'render', title: 'No renders yet',
    body: 'A render turns the photo with your furniture into a photoreal image, about $0.04 each. You see the price before anything is sent.',
    action: button({ label: 'Render…', kind: 'primary', onClick: () => quiet(openConfirm()) }),
  })
  panel.body.append(summary, pickBar, list, empty)

  const real = (p) => (p && !DEFAULT_PROMPTS.some((re) => re.test(p)) ? p : '')
  const layoutOf = (m) => (m.layout ? engine.layoutDisplayName(m.layout) : '')
  // The layout is what tells two renders apart, so it leads (the title line), then the time, model and keep-room.
  const titleLine = (m) => layoutOf(m) || dayDate(m.created)
  const metaLine = (m) => [layoutOf(m) ? dayDate(m.created) : null, modelShort(m.model), m.keep_room ? (m.aligned?.applied ? 'room kept' : 'keep room not applied') : null].filter(Boolean).join(' · ')
  const cost = (m) => (m.mock ? '$0' : money(m.cost_usd))
  const byName = (n) => engine.getRenders().find((r) => r.name === n)

  // --- list ------------------------------------------------------------------------------------------------------
  function togglePicking() {
    if (picking) { picking = null; render(); return }
    if (engine.getRenders().length < 2) { shell.toast('Make two renders first, then compare them.', { id: 'compare-need-two' }); return }
    picking = []
    render()
  }
  function pickRow(m) {
    const i = picking.indexOf(m.name)
    if (i >= 0) picking.splice(i, 1); else picking.push(m.name)
    if (picking.length === 2) { const [a, b] = picking; picking = null; render(); openCompare(a, b); return }
    render()
  }
  function render() {
    const renders = engine.getRenders()
    const phone = shell.isPhone()
    panel.setCount(String(renders.length + pending.filter((p) => p.state === 'rendering').length))
    const spent = renders.reduce((s, m) => s + (m.mock ? 0 : Number(m.cost_usd) || 0), 0)
    summary.hidden = !renders.length && !pending.length
    summary.replaceChildren(h('span', engine.getSceneName() ? 'This scene · newest first' : 'Newest first'), h('span.rn-spent.tnum', `${money(spent)} spent`))
    compareBtn.setAttribute('aria-pressed', String(!!picking))
    compareBtn.lastChild.textContent = picking ? 'Cancel' : 'Compare'
    pickBar.hidden = !picking
    if (picking) pickBar.replaceChildren(pic('info', { size: 16 }), h('span', picking.length ? 'Now pick the second render' : `${phone ? 'Tap' : 'Click'} two renders to compare them`))
    const rows = []
    for (const p of pending) {
      const going = p.state === 'rendering'
      const left = Math.max(0, ABOUT - (Date.now() - p.started) / 1000)
      rows.push(h(`div.rn-row.is-${p.state}`, { role: 'listitem' },
        h(`span.rn-thumb.is-${p.state}`, going ? h('span', ctx.icons.ring(null, { size: 18 })) : pic('warning', { size: 18 })),
        h('span.rn-text',
          h('span.rn-title', going ? 'Rendering…' : `Failed${p.reason ? ` · ${p.reason}` : ''}`),
          h('span.rn-meta.tnum', going ? `${modelShort(p.model)}${p.keepRoom ? ' · keep room' : ''} · ${left > 2 ? `about ${Math.ceil(left / 5) * 5} s` : 'any moment'}` : `Not charged · ${clock(p.at)}`)),
        going
          ? h('span.rn-cost.is-pending.tnum', engine.isRenderMock() ? '$0' : money(renderPrice(p.model, p.shot)))
          : h('button.rn-retry', { type: 'button', onclick: () => quiet(openConfirm({ retry: p })) }, 'Retry…'),
        going ? null : h('button.rn-dismiss', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { pending = pending.filter((x) => x !== p); changed() } }, pic('close', { size: 16 }))))
    }
    renders.forEach((m) => {
      const chosen = picking?.includes(m.name)
      rows.push(h(`button.rn-row${chosen ? '.is-picked' : ''}`, { type: 'button', role: 'listitem', dataset: { render: m.name }, 'aria-pressed': picking ? String(!!chosen) : null, onclick: () => (picking ? pickRow(m) : openViewer(m)) },
        picking ? h('span.rn-check', chosen ? pic('check', { size: 16 }) : null) : null,
        h('img.rn-thumb', { src: m.url, alt: '', loading: 'lazy', draggable: false }),
        h('span.rn-text', h('span.rn-title.tnum', { title: layoutOf(m) || null }, titleLine(m)), h('span.rn-meta', metaLine(m))),
        h('span.rn-cost.tnum', cost(m)),
        phone && !picking ? h('span.rn-chev', pic('chevron-right', { size: 18 })) : null))
    })
    list.replaceChildren(...rows)
    empty.hidden = rows.length > 0 || !engine.getSceneName()
  }
  function changed() {
    render()
    const going = pending.some((p) => p.state === 'rendering')
    if (going && !tick) tick = setInterval(render, 5000)
    if (!going && tick) { clearInterval(tick); tick = null }
    emit('state', { pending: getPending() })
  }
  const getPending = () => pending.map(({ id, model, started, state, error }) => ({ id, model, started, state, error }))

  // --- modal plumbing (dialog on desktop, full-height sheet on the phone) ------------------------------------------
  function openModal(kind, build) {
    modal?.close()
    const els = []
    const close = () => {
      if (modal?.els !== els) return
      modal.onClose?.()
      for (const e of els) e.remove()
      modal = null
    }
    const rerender = () => {
      for (const e of els.splice(0)) e.remove()
      const phone = shell.isPhone()
      const content = build({ phone, close })
      const scrim = h('div.scrim', { onclick: close })
      const box = h(`div.rn-modal.is-${kind}.is-${phone ? 'phone' : 'desktop'}`, { role: 'dialog', 'aria-modal': 'true', 'aria-label': content.label }, content.el)
      els.push(scrim, box)
      shell.mounts.layer.append(scrim, box)
      if (!phone) requestAnimationFrame(() => (box.querySelector('[data-autofocus]') || box.querySelector('button'))?.focus())
    }
    modal = { kind, els, close, rerender }
    rerender()
    return modal
  }
  shell.addKeyFilter((e) => {
    if (!modal) return false
    if (e.key === 'Escape') { e.preventDefault(); modal.close() } else if ((modal.kind === 'viewer' || modal.kind === 'compare') && (e.key === 'ArrowLeft' || e.key === 'ArrowRight') && !e.target.closest?.('input, textarea')) {
      e.preventDefault(); modal.step?.(e.key === 'ArrowRight' ? 1 : -1)
    }
    return true
  })
  shell.events.addEventListener('mode', () => { render(); modal?.rerender() })

  // --- confirm ---------------------------------------------------------------------------------------------------
  async function openConfirm({ from = null, retry = null } = {}) {
    if (!engine.getSceneName()) { shell.toast('Open a scene first.', { id: 'no-scene' }); return }
    let shot = retry?.shot || null
    let model = retry?.model || (from && RENDER_MODELS[from.model] ? from.model : Object.keys(RENDER_MODELS)[0])
    let prompt = retry ? retry.prompt || '' : real(from?.prompt)
    let keepRoom = retry ? !!retry.keepRoom : false
    const current = !from && !retry?.fromPast
    const items = engine.getItems().length
    let loadError = null
    if (!shot && !from) {
      try { shot = engine.captureComposite({ maxPx: 1024, quality: 0.85 }); const ph = engine.getPhotoSize(); shot.sentW = ph.w; shot.sentH = ph.h } catch (e) { engine.reportError('Could not capture the scene', e); return }
    }
    const m = openModal('confirm', ({ phone, close }) => {
      const title = from ? 'Render again' : retry ? 'Try the render again' : 'Render'
      const sub = from ? `From ${dayDate(from.created)} · the same picture, change anything` : retry ? 'Nothing was charged' : 'Photoreal, paid'
      const sizeShot = shot ? { width: shot.sentW || shot.width, height: shot.sentH || shot.height } : null
      const price = () => (engine.isRenderMock() ? 0 : renderPrice(model, sizeShot))
      const goLabel = () => (engine.isRenderMock() ? 'Render · $0 (mock)' : `Render · ${money(price())}`)
      const go = withIcon(button({ label: goLabel(), kind: 'primary', block: phone, disabled: !shot, onClick: () => submit() }), 'render')
      go.dataset.autofocus = ''
      go.dataset.midstudy = 'render-go'
      const setGo = () => { go.lastChild.textContent = goLabel(); go.disabled = !shot }
      const models = h('div.rc-models', { role: 'radiogroup', 'aria-label': 'Model' }, Object.entries(RENDER_MODELS).map(([key, def]) => {
        const b = h('button.rc-model', { type: 'button', role: 'radio', 'aria-checked': String(key === model),
          onclick: () => { model = key; for (const x of models.children) x.setAttribute('aria-checked', String(x === b)); setGo() } },
        h('span.rc-radio'), h('span.rc-model-text', h('span.rc-model-name', def.label), h('span.rc-model-note', MODEL_NOTE[key] || '')),
        h('span.rc-price.tnum', { dataset: { model: key } }, engine.isRenderMock() ? '$0' : money(renderPrice(key, sizeShot))))
        return b
      }))
      const promptEl = h(phone ? 'input.input.rc-prompt' : 'textarea.input.rc-prompt', { placeholder: phone ? 'Add a prompt (optional)' : 'Say what to change, if anything: "evening light, lamps on"', rows: 3, spellcheck: true, 'aria-label': 'Prompt (optional)',
        oninput: (e) => { prompt = e.target.value } })
      promptEl.value = prompt
      const keep = toggle({ label: 'Keep room exact', hint: 'Only the furniture changes; the rest stays the photo, aligned to it', checked: keepRoom, onChange: (v) => { keepRoom = v } })
      keep.classList.add('rc-keep')
      keep.input.dataset.midstudy = 'keep-room'
      if (!current) { keep.input.disabled = true; keep.querySelector('.toggle-hint').textContent = 'Only for the scene as it is now' }
      const preview = h('div.rc-preview', shot ? h('img', { src: shot.dataUrl, alt: 'The picture that gets sent' }) : h('span.rc-preview-wait', loadError ? `Could not load that picture: ${loadError}` : 'Loading that picture…'))
      const sizeText = sizeShot ? `${sizeShot.width} × ${sizeShot.height} JPEG` : '…'
      const whatText = from ? "That render's picture" : `The photo with ${items} ${items === 1 ? 'piece' : 'pieces'}`
      if (!phone) preview.append(h('span.rc-caption.tnum', `${whatText} · ${sizeText}${model === 'nano-banana' ? ' · plus the photo as a reference' : ''}`))
      const facts = h('div.rc-facts',
        h('span.caps', 'What gets sent'),
        h('p', h('strong', whatText), h('span', 'At the photo’s size')),
        h('p.tnum', h('strong', sizeText), h('span', 'Nano Banana also gets the photo')),
        h('p', h('strong', 'To fal, via the server'), h('span', `The key stays there. About ${ABOUT} s.`)))
      const mockNote = engine.isRenderMock() ? h('p.rc-mock', 'Mock mode: nothing goes to fal and nothing is charged.') : null
      const closeBtn = h('button.btn.btn-icon.btn-quiet.rc-close', { type: 'button', 'aria-label': 'Close', onclick: close }, pic('close', { size: 16 }))
      const head = h('header.rc-head', h('h2.rc-title', title), h('span.rc-sub', sub), closeBtn)
      function submit() {
        if (!shot) return
        close()
        quiet(run({ shot: current ? null : shot, preview: shot, model, prompt: prompt.trim(), keepRoom: current && keepRoom }))
      }
      if (phone) {
        return { label: title, el: h('div.rc-sheet', h('div.sheet-grab', { 'aria-hidden': 'true' }), head,
          h('div.rc-body', h('div.rc-top', preview, facts), h('span.caps.rc-label', 'Model'), models, keep, h('label.rc-prompt-wrap', pic('pencil', { size: 16 }), promptEl), mockNote),
          h('div.rc-foot', go, h('button.rc-cancel', { type: 'button', onclick: close }, 'Cancel'))) }
      }
      return { label: title, el: h('div.rc-dialog', head,
        h('div.rc-body', preview, h('span.caps.rc-label', 'Model'), models, keep, h('span.caps.rc-label', 'Prompt · optional'), promptEl, mockNote),
        h('footer.rc-foot', h('p.rc-note', `Goes to fal via the server; the key stays there. About ${ABOUT} s.`), button({ label: 'Cancel', kind: 'secondary', onClick: close }), go)) }
    })
    if (from && !shot) {
      try { shot = await imageShot(from.input_url) } catch (e) { loadError = e.message }
      if (modal === m) m.rerender()
    }
  }

  // shot: a past picture to send again, or null for the scene as it is now (captured at the photo's size).
  async function run({ shot, preview, model, prompt, keepRoom }) {
    const p = { id: `r${++seq}`, model, prompt, shot: preview, started: Date.now(), state: 'rendering', keepRoom, fromPast: !!shot }
    pending.unshift(p)
    changed()
    try {
      const meta = shot ? await engine.postRender(shot, { model, prompt: prompt || undefined }) : await engine.renderViewInternal({ model, prompt: prompt || undefined, keepRoom })
      pending = pending.filter((x) => x !== p)
      changed()
      emit('done', { meta })
      if (meta.keep_room && meta.aligned && !meta.aligned.applied) shell.toast(`Keep room wasn't applied: ${meta.aligned.reason || 'the render could not be aligned to the photo'}. The render is shown as it came.`, { id: `align-${meta.name}`, ms: 9000 })
    } catch (e) {
      const msg = e.message || ''
      Object.assign(p, { state: 'failed', at: Date.now(), error: msg, reason: /timed? ?out/i.test(msg) ? 'timed out' : /FAL_KEY/.test(msg) ? 'no fal key' : /budget/i.test(msg) ? "today's budget is used up" : /isn't answering|could not reach/i.test(msg) ? "the server isn't answering" : '' })
      changed()
      emit('failed', { error: msg })
    }
  }

  // --- viewer ----------------------------------------------------------------------------------------------------
  function openViewer(which) {
    const all = () => engine.getRenders()
    let idx = Math.max(0, all().findIndex((r) => r.name === (typeof which === 'string' ? which : which?.name)))
    let side = 'render'
    const m = openModal('viewer', ({ phone, close }) => {
      const rs = all()
      const r = rs[idx] || (typeof which === 'object' ? which : null)
      if (!r) return { label: 'Render', el: h('p.p-note', 'That render is gone.') }
      const step = (k) => { if (rs.length < 2) return; idx = (idx + k + rs.length) % rs.length; m.rerender() }
      const of = rs.length > 1 ? `${idx + 1} of ${rs.length}` : ''
      const again = withIcon(button({ label: 'Render again…', kind: 'secondary', onClick: () => quiet(openConfirm({ from: r })) }), 'render')
      const cmp = rs.length > 1 ? button({ label: 'Compare…', kind: 'secondary', onClick: () => { close(); picking = [r.name]; shell.openPanel('renders'); render() } }) : null
      const p = real(r.prompt)
      const promptEl = p ? h('p.rv-prompt', pic('pencil', { size: 14 }), h('span', p)) : null
      const closeBtn = h('button.btn.btn-icon.rv-close', { type: 'button', 'aria-label': 'Close', onclick: close }, pic('close', { size: 16 }))
      const sides = [{ value: 'input', label: 'Sent' }, { value: 'render', label: 'Render' }, ...(r.raw_url ? [{ value: 'raw', label: 'Raw' }] : [])]
      const srcOf = (v) => (v === 'input' ? r.input_url : v === 'raw' ? r.raw_url : r.url)
      const alignNote = r.keep_room ? h('span.rv-align', r.aligned?.applied ? `Room kept · ${r.aligned.inliers ?? '?'} matches, ${r.aligned.residual_px != null ? `${r.aligned.residual_px.toFixed(1)} px` : ''}` : `Keep room not applied${r.aligned?.reason ? `: ${r.aligned.reason}` : ''}`) : null
      if (phone) {
        const img = h('img.rv-img', { src: srcOf(side), alt: side === 'render' ? 'The render' : side === 'raw' ? "The model's own output" : 'What was sent' })
        const seg = segmented(sides, side, (v) => { side = v; img.src = srcOf(v) }, { small: true, label: 'Show' })
        let x0 = null
        const stage = h('div.rv-stage', { onpointerdown: (e) => { x0 = e.clientX }, onpointerup: (e) => { if (x0 != null && Math.abs(e.clientX - x0) > 60) step(e.clientX < x0 ? 1 : -1); x0 = null } }, img)
        return { label: `Render, ${dayDate(r.created)}`, el: h('div.rv-phone',
          h('header.rv-head', closeBtn, h('div.rv-titles', h('h2.rv-title.tnum', layoutOf(r) || dayDate(r.created)), h('span.rv-sub.tnum', [layoutOf(r) ? dayDate(r.created) : null, of, modelShort(r.model), cost(r)].filter(Boolean).join(' · ')))),
          h('div.rv-seg', seg), stage,
          h('footer.rv-foot', alignNote, promptEl, h('div.rv-actions', cmp, again))) }
      }
      const size = h('span.tnum', r.out_w ? `${r.out_w} × ${r.out_h}` : '')
      const right = h('img', { src: side === 'raw' ? r.raw_url : r.url, alt: 'The render', onload: (e) => { size.textContent = `${e.target.naturalWidth} × ${e.target.naturalHeight}` } })
      const which2 = r.raw_url ? segmented([{ value: 'render', label: 'Render' }, { value: 'raw', label: 'Raw' }], side === 'raw' ? 'raw' : 'render', (v) => { side = v; right.src = v === 'raw' ? r.raw_url : r.url }, { small: true, label: 'Show' }) : null
      const nav = rs.length > 1 ? h('div.rv-nav',
        h('button.btn.btn-icon.btn-quiet', { type: 'button', 'aria-label': 'Newer', dataset: { tip: 'Newer', kbd: '←' }, onclick: () => step(-1) }, pic('chevron-left', { size: 16 })),
        h('span.tnum', of),
        h('button.btn.btn-icon.btn-quiet', { type: 'button', 'aria-label': 'Older', dataset: { tip: 'Older', kbd: '→' }, onclick: () => step(1) }, pic('chevron-right', { size: 16 }))) : null
      return { label: `Render, ${dayDate(r.created)}`, el: h('div.rv-desk',
        h('header.rv-head', h('h2.rv-title.tnum', `Render · ${dayDate(r.created)}`),
          h('span.rv-sub.tnum', [layoutOf(r) || null, RENDER_MODELS[r.model]?.label || r.model, cost(r)].filter(Boolean).join(' · ')),
          h('span.rv-spacer'),
          h('a.btn.btn-quiet', { href: side === 'raw' ? r.raw_url : r.url, target: '_blank', rel: 'noopener' }, 'Open image'), nav, h('span.rv-sep'), closeBtn),
        h('div.rv-pair',
          h('figure', h('div.rv-frame', h('img', { src: r.input_url, alt: 'What was sent' })), h('figcaption', h('span.caps', 'Sent'), h('span', 'The photo with the furniture'))),
          h('figure', h('div.rv-frame', right), h('figcaption', h('span.caps', 'Render'), which2, size))),
        h('footer.rv-foot', h('div.rv-prompt-block', alignNote, h('span.caps', 'Prompt'), p ? h('p', p) : h('p.muted', r.reference ? 'The default, with the photo as a reference: keep the room, make the furniture look photographed in it.' : 'The default: keep everything, make it a photograph.')),
          h('div.rv-actions', cmp, again))) }
    })
    m.step = (k) => { const n = all().length; if (n < 2) return; idx = (idx + k + n) % n; m.rerender() }
  }

  // --- compare (§4.5): side by side (desktop), a draggable split (both), swipe (phone) -----------------------------
  async function openCompare(a, b) {
    let ra = byName(a), rb = byName(b)
    if (!ra || !rb) {
      try { await engine.listRendersInternal() } catch { /* reported */ }
      ra = byName(a); rb = byName(b)
    }
    if (!ra || !rb) { engine.reportError(`Can't compare: ${!ra ? a : b} isn't a render of this scene`); return }
    let mode = null
    let split = 50
    let shown = 0 // swipe: which one
    const m = openModal('compare', ({ phone, close }) => {
      const modes = phone ? [{ value: 'split', label: 'Split' }, { value: 'swipe', label: 'Swipe' }] : [{ value: 'side', label: 'Side by side' }, { value: 'split', label: 'Split' }]
      if (!modes.some((x) => x.value === mode)) mode = modes[0].value
      const pair = [ra, rb]
      // A and B are told apart by their layout first (two renders of the same minute differ only there); the phone drops
      // the model to keep the caption readable.
      const tag = (r, i) => h('span.cv-tag', { title: [layoutOf(r), dayDate(r.created), modelShort(r.model)].filter(Boolean).join(' · ') }, h('b', i ? 'B' : 'A'),
        h('span.tnum', [layoutOf(r) || null, dayDate(r.created), phone ? null : modelShort(r.model)].filter(Boolean).join(' · ')))
      const closeBtn = h('button.btn.btn-icon.rv-close', { type: 'button', 'aria-label': 'Close', onclick: close }, pic('close', { size: 16 }))
      const seg = segmented(modes, mode, (v) => { mode = v; m.rerender() }, { small: true, label: 'Compare as' })
      // Swap A and B: a labelled button on the desktop, an icon button (44 px) in the phone's narrower header.
      const doSwap = () => { [ra, rb] = [rb, ra]; m.rerender() }
      const swap = phone
        ? h('button.btn.btn-icon.btn-quiet.cv-swap.is-icon', { type: 'button', 'aria-label': 'Swap A and B', dataset: { midstudy: 'compare-swap' }, onclick: doSwap }, pic('swap', { size: 20 }))
        : h('button.btn.btn-quiet.cv-swap', { type: 'button', dataset: { midstudy: 'compare-swap' }, onclick: doSwap }, 'Swap A and B')
      let stage
      if (mode === 'side') {
        stage = h('div.cv-side', pair.map((r, i) => h('figure', h('div.cv-frame', h('img', { src: r.url, alt: `Render ${i ? 'B' : 'A'}` })), h('figcaption', tag(r, i)))))
      } else if (mode === 'split') {
        const top = h('img.cv-top', { src: rb.url, alt: 'Render B', style: { clipPath: `inset(0 0 0 ${split}%)` } })
        const bar = h('div.cv-bar', { style: { left: `${split}%` } }, h('span.cv-knob', pic('chevron-left', { size: 14 }), pic('chevron-right', { size: 14 })))
        const range = h('input.cv-range', { type: 'range', min: 0, max: 100, step: 0.5, value: split, 'aria-label': 'Split between A and B' })
        const under = h('img.cv-under', { src: ra.url, alt: 'Render A' })
        const box = h('div.cv-split', under, top, bar, range)
        // The box has the render's own shape, so the split line and its handle run over the image, not the black bars.
        const setAr = (w, hh) => { if (w > 0 && hh > 0) box.style.setProperty('--ar', String(w / hh)) }
        setAr(ra.out_w || ra.width, ra.out_h || ra.height)
        under.addEventListener('load', () => setAr(under.naturalWidth, under.naturalHeight))
        const setSplit = (v) => { split = Math.max(0, Math.min(100, v)); top.style.clipPath = `inset(0 0 0 ${split}%)`; bar.style.left = `${split}%`; range.value = split }
        range.addEventListener('input', () => setSplit(Number(range.value)))
        let dragging = false
        const at = (e) => { const r = box.getBoundingClientRect(); setSplit(((e.clientX - r.left) / r.width) * 100) }
        box.addEventListener('pointerdown', (e) => { if (e.target === range) return; dragging = true; box.setPointerCapture?.(e.pointerId); at(e) })
        box.addEventListener('pointermove', (e) => { if (dragging) at(e) })
        box.addEventListener('pointerup', () => { dragging = false })
        box.addEventListener('pointercancel', () => { dragging = false })
        stage = h('div.cv-splitwrap', h('div.cv-splitarea', box), h('div.cv-tags', tag(ra, 0), tag(rb, 1)))
      } else {
        const r = pair[shown]
        let x0 = null
        const img = h('img.cv-swipe-img', { src: r.url, alt: `Render ${shown ? 'B' : 'A'}` })
        const box = h('div.cv-swipe', { onpointerdown: (e) => { x0 = e.clientX }, onpointerup: (e) => { if (x0 != null && Math.abs(e.clientX - x0) > 40) { shown = shown ? 0 : 1; m.rerender() } x0 = null } }, img)
        stage = h('div.cv-swipewrap', box,
          h('div.cv-dots', [0, 1].map((i) => h(`button.cv-dot${i === shown ? '.is-on' : ''}`, { type: 'button', 'aria-label': `Show ${i ? 'B' : 'A'}`, onclick: () => { shown = i; m.rerender() } }, i ? 'B' : 'A'))),
          h('div.cv-tags', tag(r, shown)))
      }
      return { label: 'Compare renders', el: h(`div.cv.is-${mode}`,
        h('header.cv-head', h('h2.cv-title', 'Compare'), seg, h('span.rv-spacer'), swap, closeBtn), stage) }
    })
    m.step = () => { if (mode === 'swipe') { shown = shown ? 0 : 1; m.rerender() } }
  }

  engine.events.addEventListener('renders', () => { render(); if (modal?.kind === 'viewer') modal.rerender() })
  engine.events.addEventListener('scene', (e) => { if (e.detail.phase === 'opened' || e.detail.phase === 'closed') { picking = null; pending = []; modal?.close(); changed() } })
  engine.events.addEventListener('compare', (e) => quiet(openCompare(e.detail.a, e.detail.b)))
  shell.events.addEventListener('render-request', (e) => { e.preventDefault(); quiet(openConfirm()) })
  shell.events.addEventListener('open-render', (e) => { e.preventDefault(); openViewer(e.detail?.meta) })
  render()
  ctx.renders = { openConfirm, openViewer, openCompare, getPending, events }
}
