// Panel (area C): Library, the furniture you can add. One list at every detent (bigger thumbnails at full height):
// thumbnail or monogram, name, W × D × H cm and an "In the scene" check. Search plus filter chips All / In the scene · n.
// Tapping a row adds the piece on the floor in front of the camera (contract §4.5), selects it, drops the phone sheet to
// peek and toasts "<name> added · Undo". Frames C1 (phone), C6.
// v4 library manager (§2.8), with a library API on the server: Add (a photo from the phone, an image link or a 3D
// file; the price and today's budget before you confirm: panels/libsheets.js), the jobs making pieces (progress,
// Place when ready, failures), "…" per row (Edit, Remove with Undo = restore) and Recently removed (Restore).
import { dimsText, quiet, fmtUsd } from '../../engine.js'
import { pic, itemThumb } from './common.js'
import { ring } from '../icons.js'
import { openAddSheet, openEditSheet } from './libsheets.js'

export function mount(ctx) {
  const { engine, shell, kit, lib } = ctx
  const { h, chip } = kit
  let query = ''
  let filter = 'all'
  let lastAdded = null // library id of the piece just added (marked; the peek sheet shows it)
  let trashOpen = false
  const dismissed = new Set() // job ids hidden from the list on this page
  const ready = new Set()     // job ids that finished while this page was open (offer Place)

  const panel = shell.registerPanel({ id: 'library', label: 'Library', icon: 'library', phoneDetent: 'half', mount: () => {} })

  // --- head: Add -------------------------------------------------------------------------------------------------
  const addBtn = h('button.btn.btn-secondary.lib-addbtn', { type: 'button', dataset: { midstudy: 'lib-add', tip: 'Add furniture from a photo, a link or a 3D file' }, hidden: true, onclick: () => openAdd() },
    pic('plus', { size: 16, stroke: 1.9 }), h('span', 'Add'))
  panel.actions.append(addBtn)

  const input = h('input.p-search-input', { type: 'search', placeholder: 'Search furniture', spellcheck: false, autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search furniture',
    oninput: () => { query = input.value.trim().toLowerCase(); render() } })
  const clear = h('button.p-search-clear', { type: 'button', 'aria-label': 'Clear the search', hidden: true, onclick: () => { input.value = ''; query = ''; render(); input.focus() } }, pic('close', { size: 16 }))
  const search = h('label.p-search', pic('search', { size: 16, stroke: 1.6 }), input, clear)
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); clear.click() } })
  const chips = {
    all: chip({ label: 'All', onClick: () => setFilter('all') }),
    inroom: chip({ label: 'In the scene', onClick: () => setFilter('inroom') }),
  }
  const tools = h('div.p-tools.lib-tools', search, h('div.p-chips', { role: 'group', 'aria-label': 'Filter' }, Object.values(chips)))
  const jobsEl = h('section.lib-jobs', { 'aria-label': 'Being made', hidden: true })
  const list = h('div.lib-list', { role: 'list' })
  const none = h('p.p-note.lib-none')
  const trashEl = h('section.lib-trash', { hidden: true })
  panel.body.classList.add('lib')
  panel.body.append(jobsEl, tools, list, none, trashEl)

  function setFilter(f) { filter = filter === f && f !== 'all' ? 'all' : f; render() }

  function counts() {
    const n = new Map()
    for (const it of engine.getItems()) n.set(it.id, (n.get(it.id) || 0) + 1)
    return n
  }

  async function add(item) {
    if (!engine.getSceneName()) { shell.toast('Open a scene first, then add furniture to it.', { id: 'no-scene' }); shell.openPage('scenes'); return }
    let uid
    const name = item.name || item.id
    // A splat can take a few seconds to download and set up: say so if it isn't there at once.
    let loading = null
    const slow = setTimeout(() => { loading = shell.toast(`Placing ${name}…`, { ms: 60000 }) }, 400)
    try { uid = await engine.addItemInternal(item.id) } catch { return } finally { clearTimeout(slow); loading?.close(true) } // reported (toast)
    engine.select(uid)
    lastAdded = item.id
    shell.toast(`${name} added`, { kind: 'ok', id: `added:${uid}`, action: { label: 'Undo', onClick: () => engine.removeItemInternal(uid) } })
    if (shell.isPhone()) shell.setDetent('peek')
    render()
    showAdded()
  }
  function showAdded() {
    const row = lastAdded && list.querySelector(`[data-id="${CSS.escape(lastAdded)}"]`)
    if (row) requestAnimationFrame(() => row.scrollIntoView({ block: 'nearest' }))
  }

  // --- manager actions -------------------------------------------------------------------------------------------
  function openAdd() {
    openAddSheet(ctx, {
      onAdded: (job, meta) => {
        const cost = job?.cost_usd_estimate
        shell.toast(`Making ${meta.name}${cost > 0 ? ` · ${fmtUsd(cost)}` : ''}. It shows up here when it's ready.`, { kind: 'info', id: `lib-job-${job?.id}`, ms: 6000 })
        if (!panel.isOpen()) shell.openPanel('library')
        render()
      },
    })
  }
  function itemMenu(item, anchor) {
    shell.menu(anchor, [
      { label: 'Place in the scene', icon: 'plus', onSelect: () => quiet(add(item)) },
      { label: 'Edit…', icon: 'pencil', onSelect: () => openEditSheet(ctx, item, { onRemove: removeFromLibrary }) },
      '-',
      { label: 'Remove from library', icon: 'trash', danger: true, midstudy: 'lib-remove', onSelect: () => quiet(removeFromLibrary(item)) },
    ], { align: 'end' })
  }
  async function removeFromLibrary(item) {
    const name = item.name || item.id
    try { await lib.remove(item.id) } catch { return } // reported
    const t = shell.toast(`${name} removed from the library`, { id: `lib-removed:${item.id}`, icon: 'trash', ms: 10000, action: { label: 'Undo', onClick: () => quiet(restore(item)) } })
    t.el.querySelector('.toast-action')?.setAttribute('data-midstudy', 'lib-undo')
  }
  async function restore(item) {
    try { await lib.restore(item.id) } catch { return }
    shell.toast(`${item.name || item.id} is back in the library`, { kind: 'ok', id: `lib-restored:${item.id}` })
  }

  // --- rows --------------------------------------------------------------------------------------------------------
  function row(item, n, selectedId, manage) {
    const name = item.name || item.id
    const inRoom = n > 0
    const meta = [h('span.lib-dims.tnum', dimsText(item.dims_cm))]
    if (!item.assets?.glb) meta.push(h('span.p-tag', { dataset: { tip: 'No GLB: shown as a box' } }, 'No GLB'))
    const roomMark = inRoom ? h('span.lib-inroom', { dataset: { tip: n > 1 ? `In the scene · ${n}` : 'In the scene' } }, pic('check', { size: 14, stroke: 2.2 }), h('span.lib-inroom-word', n > 1 ? `In scene · ${n}` : 'In scene')) : null
    const main = h(`button.lib-row${lastAdded === item.id || selectedId === item.id ? '.is-marked' : ''}`, {
      type: 'button', dataset: { id: item.id }, 'aria-label': `Add ${name}${inRoom ? ' (in the scene)' : ''}`,
      onclick: () => quiet(add(item)),
    },
    itemThumb(engine, item, 'lib-thumb'),
    h('span.lib-text', h('span.lib-title', h('span.lib-name', name), roomMark), h('span.lib-meta', meta)),
    h('span.lib-add', { 'aria-hidden': 'true' }, h('span', pic('plus', { size: 16, stroke: 1.9 }))))
    if (!manage) { main.setAttribute('role', 'listitem'); return main }
    const more = h('button.lib-more', { type: 'button', 'aria-label': `More for ${name}`, 'aria-haspopup': 'menu', dataset: { tip: 'Edit or remove' }, onclick: (e) => itemMenu(item, e.currentTarget) }, pic('more', { size: 18 }))
    return h('div.lib-item', { role: 'listitem' }, main, more)
  }

  // Jobs: what's being made, what just finished (Place), what failed (its message).
  function jobsList() {
    const st = lib.getState()
    const shown = st.jobs.filter((j) => !dismissed.has(j.id) && (j.status === 'queued' || j.status === 'running' || j.status === 'failed' || ready.has(j.id)))
    jobsEl.hidden = !shown.length
    if (!shown.length) { jobsEl.replaceChildren(); return }
    const libItems = engine.getLibrary()
    jobsEl.replaceChildren(h('div.lib-jobs-head', h('span.caps', 'Being made'), h('span.lib-jobs-note', 'One at a time on the server')),
      ...shown.map((j) => {
        const item = j.item || libItems.find((l) => l.id === j.item_id)
        const title = item?.name || j.item_id
        const kind = j.status === 'done' ? 'ready' : j.status === 'failed' ? 'failed' : j.status === 'running' ? 'running' : 'queued'
        const glyph = kind === 'running' ? ring(null, { size: 20 }) : kind === 'queued' ? pic('clock', { size: 20 }) : kind === 'ready' ? pic('check', { size: 20, stroke: 2 }) : pic('warning', { size: 20 })
        const cost = j.cost_usd ?? j.cost_usd_estimate
        const what = j.kind === 'rescale' ? 'Refitting to its new size' : kind === 'queued' ? 'Waiting its turn' : kind === 'running' ? (j.message ? j.message[0].toUpperCase() + j.message.slice(1) : 'Making the model') : kind === 'ready' ? 'In the library' : (j.message || 'It stopped on the server')
        const line = [what, cost > 0 && kind !== 'failed' ? (j.mock ? `${fmtUsd(cost)} (mock, $0)` : fmtUsd(cost)) : null].filter(Boolean).join(' · ')
        const act = kind === 'ready' && item && !item.missing && libItems.some((l) => l.id === item.id)
          ? h('button.btn.btn-primary.lib-job-btn', { type: 'button', onclick: () => { ready.delete(j.id); quiet(add(libItems.find((l) => l.id === item.id))); jobsList() } }, 'Place')
          : kind === 'failed' || kind === 'ready'
            ? h('button.lib-job-x', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { dismissed.add(j.id); ready.delete(j.id); jobsList() } }, pic('close', { size: 16 }))
            : null
        return h(`div.lib-job.is-${kind}`, h('span.lib-job-glyph', glyph), h('span.lib-job-text', h('b', title), h('span', line)), act)
      }))
  }

  function trashList() {
    const st = lib.getState()
    const items = st.api ? st.trash : []
    trashEl.hidden = !items.length
    if (!items.length) { trashEl.replaceChildren(); return }
    const head = h('button.lib-trash-head', { type: 'button', 'aria-expanded': String(trashOpen), onclick: () => { trashOpen = !trashOpen; trashList() } },
      h('span.caps', `Recently removed · ${items.length}`), pic(trashOpen ? 'chevron-down' : 'chevron-right', { size: 16 }))
    const seen = new Set()
    const rows = trashOpen ? items.slice().reverse().filter((t) => !seen.has(t.id) && seen.add(t.id)).map((t) => h('div.lib-trash-row',
      h('span.lib-trash-name', t.name || t.id), h('button.btn.btn-secondary.lib-job-btn', { type: 'button', onclick: () => quiet(restore(t)) }, 'Restore'))) : []
    trashEl.replaceChildren(head, ...rows)
  }

  function render() {
    const all = engine.getLibrary()
    const manage = lib.getState().api === true
    addBtn.hidden = !manage
    const n = counts()
    const sel = engine.getItem(engine.getSelected())
    const inRoomCount = all.reduce((sum, l) => sum + (n.get(l.id) || 0), 0) // pieces placed, not kinds of piece
    panel.setCount(all.length ? String(all.length) : '')
    input.placeholder = all.length ? (shell.isPhone() ? `Search ${all.length} ${all.length === 1 ? 'item' : 'items'}` : 'Search furniture') : 'Search furniture'
    clear.hidden = !input.value
    chips.all.set(filter === 'all')
    chips.inroom.set(filter === 'inroom')
    chips.inroom.lastChild.textContent = `In the scene · ${inRoomCount}`
    const shown = all.filter((l) => {
      if (filter === 'inroom' && !n.get(l.id)) return false
      if (!query) return true
      return [l.name, l.id, l.category].some((s) => String(s || '').toLowerCase().includes(query))
    })
    list.replaceChildren(...shown.map((l) => row(l, n.get(l.id) || 0, sel?.id, manage)))
    tools.hidden = !all.length
    none.hidden = shown.length > 0
    if (!all.length) {
      none.replaceChildren(h('strong', 'The library is empty.'), manage ? ' Add furniture from a photo, a product image link or a 3D file.' : ' Add furniture with midstudy-add (a photo, a product link or a 3D file), then reload.')
      if (manage) none.append(h('span.lib-none-cta', h('button.btn.btn-primary', { type: 'button', onclick: () => openAdd() }, 'Add furniture')))
    } else if (!shown.length) {
      none.replaceChildren(query ? `Nothing matches "${input.value.trim()}".` : 'Nothing from the library is in this scene yet.')
    }
    jobsList()
    trashList()
  }

  engine.events.addEventListener('library', render)
  engine.events.addEventListener('items', (e) => { if (e.detail.change !== 'move') render() })
  engine.events.addEventListener('selection', (e) => { if (!e.detail.uid) lastAdded = null; render() })
  lib.events.addEventListener('jobs', jobsList)
  lib.events.addEventListener('trash', render)
  lib.events.addEventListener('job-done', (e) => {
    const j = e.detail.job
    ready.add(j.id)
    const item = j.item
    const title = item?.name || j.item_id
    if (j.kind === 'rescale') { shell.toast(`${title} refitted to its new size`, { kind: 'ok', id: `lib-job-${j.id}` }); return }
    // Same id as the "Making …" toast, so this one replaces it instead of stacking under it.
    shell.toast(`${title} is in the library`, { kind: 'ok', id: `lib-job-${j.id}`, ms: 10000,
      action: item ? { label: 'Place', onClick: () => { ready.delete(j.id); const l = engine.getLibrary().find((x) => x.id === item.id); if (l) quiet(add(l)) } } : undefined })
  })
  lib.events.addEventListener('job-failed', (e) => {
    const j = e.detail.job
    shell.toast(`Couldn't make ${j.item?.name || j.item_id}: ${j.message || 'it stopped on the server'}`, { kind: 'error', id: `lib-job-${j.id}` })
  })
  shell.events.addEventListener('mode', render)
  shell.events.addEventListener('panel', (e) => {
    if (e.detail.id !== 'library' || !e.detail.open) return
    if (e.detail.detent === 'peek') showAdded()
    else if (e.detail.detent !== 'peek' && !engine.getSelected()) lastAdded = null
  })
  // "/" opens the Library (desktop) and focuses its search
  ctx.keys.register({
    id: 'library.search', group: 'Panels', label: 'Search the library', keys: ['/'], repeat: false, when: () => !shell.isPhone(),
    run: () => { if (!panel.isOpen()) shell.openPanel('library'); requestAnimationFrame(() => input.focus()) },
  })
  ctx.library = { openAdd }
  render()
}
