// Panel (area C): Library, the furniture you can add. One list at every detent (bigger thumbnails at full height):
// thumbnail or monogram, name, W × D × H cm and an "In the scene" check. Search plus filter chips All / In the scene · n.
// Tapping a row adds the piece on the floor in front of the camera (contract §4.5), selects it, drops the phone sheet to
// peek and toasts "<name> added · Undo". Frames C1 (phone), C6.
// v4 library manager (§2.8), with a library API on the server: Add (a photo from the phone, an image link or a 3D
// file; the price and today's budget before you confirm: panels/libsheets.ts), the jobs making pieces (progress,
// Place when ready, failures), "…" per row (Edit, Remove with Undo = restore) and Recently removed (Restore).
// The lists' rules and words: logic/library.ts.
import { dimsText, fmtUsd, quiet, type LibraryEntry, type LibraryJob, type TrashedItem, type UiContext } from '../seam.js'
import type { ToastHandle } from '../shell.js'
import { pic, itemThumb } from './common.js'
import { ring } from '../icons.js'
import { openAddSheet, openEditSheet } from './libsheets.js'
import { countBy, uniqueBy } from '../logic/lists.js'
import {
  addLabel, inRoomTip, inRoomWord, itemName, jobFailedText, jobKind, jobLine, makingText, nextFilter, nothingShown, placedCount,
  searchPlaceholder, searchQuery, shownItems, shownJobs, type LibraryFilter,
} from '../logic/library.js'

/** @public planner/main.js mounts every area: mod.mount(ctx). */
export function mount(ctx: UiContext): void {
  const { engine, shell, kit, lib } = ctx
  const { h, chip } = kit
  let query = ''
  let filter: LibraryFilter = 'all'
  let lastAdded: string | null = null // library id of the piece just added (marked; the peek sheet shows it)
  let trashOpen = false
  const dismissed = new Set<string>() // job ids hidden from the list on this page
  const ready = new Set<string>()     // job ids that finished while this page was open (offer Place)

  const panel = shell.registerPanel({ id: 'library', label: 'Library', icon: 'library', phoneDetent: 'half', mount: () => { /* filled below */ } })

  // --- head: Add -------------------------------------------------------------------------------------------------
  const addBtn = h('button.btn.btn-secondary.lib-addbtn', { type: 'button', dataset: { midstudy: 'lib-add', tip: 'Add furniture from a photo, a link or a 3D file' }, hidden: true, onclick: () => { openAdd() } },
    pic('plus', { size: 16, stroke: 1.9 }), h('span', 'Add'))
  panel.actions.append(addBtn)

  const input: HTMLInputElement = h('input.p-search-input', { type: 'search', placeholder: 'Search furniture', spellcheck: false, autocomplete: 'off', enterkeyhint: 'search', 'aria-label': 'Search furniture',
    oninput: () => { query = searchQuery(input.value); render() } })
  const clear = h('button.p-search-clear', { type: 'button', 'aria-label': 'Clear the search', hidden: true, onclick: () => { input.value = ''; query = ''; render(); input.focus() } }, pic('close', { size: 16 }))
  const search = h('label.p-search', pic('search', { size: 16, stroke: 1.6 }), input, clear)
  input.addEventListener('keydown', (e) => { if (e.key === 'Escape' && input.value) { e.stopPropagation(); clear.click() } })
  const chips = {
    all: chip({ label: 'All', onClick: () => { setFilter('all') } }),
    inroom: chip({ label: 'In the scene', onClick: () => { setFilter('inroom') } }),
  }
  const tools = h('div.p-tools.lib-tools', search, h('div.p-chips', { role: 'group', 'aria-label': 'Filter' }, chips.all, chips.inroom))
  const jobsEl = h('section.lib-jobs', { 'aria-label': 'Being made', hidden: true })
  const list = h('div.lib-list', { role: 'list' })
  const none = h('p.p-note.lib-none')
  const trashEl = h('section.lib-trash', { hidden: true })
  panel.body.classList.add('lib')
  panel.body.append(jobsEl, tools, list, none, trashEl)

  function setFilter(f: LibraryFilter): void { filter = nextFilter(filter, f); render() }

  const counts = (): Map<string, number> => countBy(engine.getItems(), (it) => it.id)

  async function add(item: LibraryEntry): Promise<void> {
    if (!engine.getSceneName()) { shell.toast('Open a scene first, then add furniture to it.', { id: 'no-scene' }); shell.openPage('scenes'); return }
    let uid: string
    const name = itemName(item)
    // A splat can take a few seconds to download and set up: say so if it isn't there at once.
    const loading: { toast: ToastHandle | null } = { toast: null }
    const slow = setTimeout(() => { loading.toast = shell.toast(`Placing ${name}…`, { ms: 60000 }) }, 400)
    try { uid = await engine.addItemInternal(item.id) } catch { return } finally { clearTimeout(slow); loading.toast?.close() } // reported (toast)
    engine.select(uid)
    lastAdded = item.id
    shell.toast(`${name} added`, { kind: 'ok', id: `added:${uid}`, action: { label: 'Undo', onClick: () => { engine.removeItemInternal(uid) } } })
    if (shell.isPhone()) shell.setDetent('peek')
    render()
    showAdded()
  }
  function showAdded(): void {
    const row = lastAdded ? list.querySelector(`[data-id="${CSS.escape(lastAdded)}"]`) : null
    if (row) requestAnimationFrame(() => { row.scrollIntoView({ block: 'nearest' }) })
  }

  // --- manager actions -------------------------------------------------------------------------------------------
  function openAdd(): void {
    openAddSheet(ctx, {
      onAdded: (job, meta) => {
        shell.toast(makingText(meta.name, job?.cost_usd_estimate, fmtUsd), { kind: 'info', id: `lib-job-${String(job?.id)}`, ms: 6000 })
        if (!panel.isOpen()) shell.openPanel('library')
        render()
      },
    })
  }
  function itemMenu(item: LibraryEntry, anchor: Element | null): void {
    shell.menu(anchor, [
      { label: 'Place in the scene', icon: 'plus', onSelect: () => { quiet(add(item)) } },
      { label: 'Edit…', icon: 'pencil', onSelect: () => { openEditSheet(ctx, item, { onRemove: (it) => { quiet(removeFromLibrary(it)) } }) } },
      '-',
      { label: 'Remove from library', icon: 'trash', danger: true, midstudy: 'lib-remove', onSelect: () => { quiet(removeFromLibrary(item)) } },
    ], { align: 'end' })
  }
  async function removeFromLibrary(item: LibraryEntry): Promise<void> {
    const name = itemName(item)
    try { await lib.remove(item.id) } catch { return } // reported
    const t = shell.toast(`${name} removed from the library`, { id: `lib-removed:${item.id}`, icon: 'trash', ms: 10000, action: { label: 'Undo', onClick: () => { quiet(restore(item)) } } })
    t.el.querySelector('.toast-action')?.setAttribute('data-midstudy', 'lib-undo')
  }
  async function restore(item: LibraryEntry | TrashedItem): Promise<void> {
    try { await lib.restore(item.id) } catch { return }
    shell.toast(`${itemName(item)} is back in the library`, { kind: 'ok', id: `lib-restored:${item.id}` })
  }

  // --- rows --------------------------------------------------------------------------------------------------------
  function row(item: LibraryEntry, n: number, selectedId: string | undefined, manage: boolean): HTMLElement {
    const name = itemName(item)
    const inRoom = n > 0
    const meta = [h('span.lib-dims.tnum', dimsText(item.dims_cm))]
    if (!item.assets?.glb) meta.push(h('span.p-tag', { dataset: { tip: 'No GLB: shown as a box' } }, 'No GLB'))
    const roomMark = inRoom ? h('span.lib-inroom', { dataset: { tip: inRoomTip(n) } }, pic('check', { size: 14, stroke: 2.2 }), h('span.lib-inroom-word', inRoomWord(n))) : null
    const main = h(`button.lib-row${lastAdded === item.id || selectedId === item.id ? '.is-marked' : ''}`, {
      type: 'button', dataset: { id: item.id }, 'aria-label': addLabel(name, inRoom),
      onclick: () => { quiet(add(item)) },
    },
    itemThumb(engine, item, 'lib-thumb'),
    h('span.lib-text', h('span.lib-title', h('span.lib-name', name), roomMark), h('span.lib-meta', meta)),
    h('span.lib-add', { 'aria-hidden': 'true' }, h('span', pic('plus', { size: 16, stroke: 1.9 }))))
    if (!manage) { main.setAttribute('role', 'listitem'); return main }
    const more = h('button.lib-more', { type: 'button', 'aria-label': `More for ${name}`, 'aria-haspopup': 'menu', dataset: { tip: 'Edit or remove' }, onclick: (e) => { itemMenu(item, e.currentTarget instanceof Element ? e.currentTarget : null) } }, pic('more', { size: 18 }))
    return h('div.lib-item', { role: 'listitem' }, main, more)
  }

  // Jobs: what's being made, what just finished (Place), what failed (its message).
  function jobsList(): void {
    const st = lib.getState()
    const shown = shownJobs(st.jobs, dismissed, ready)
    jobsEl.hidden = !shown.length
    if (!shown.length) { jobsEl.replaceChildren(); return }
    const libItems = engine.getLibrary()
    jobsEl.replaceChildren(h('div.lib-jobs-head', h('span.caps', 'Being made'), h('span.lib-jobs-note', 'One at a time on the server')),
      ...shown.map((j: LibraryJob) => {
        const item = j.item ?? libItems.find((l) => l.id === j.item_id)
        const title = (item?.name ?? '') || j.item_id
        const kind = jobKind(j.status)
        const glyph = kind === 'running' ? ring(null, { size: 20 }) : kind === 'queued' ? pic('clock', { size: 20 }) : kind === 'ready' ? pic('check', { size: 20, stroke: 2 }) : pic('warning', { size: 20 })
        const placeable = kind === 'ready' && item && !item.missing ? libItems.find((l) => l.id === item.id) : undefined
        const act = placeable
          ? h('button.btn.btn-primary.lib-job-btn', { type: 'button', onclick: () => { ready.delete(j.id); quiet(add(placeable)); jobsList() } }, 'Place')
          : kind === 'failed' || kind === 'ready'
            ? h('button.lib-job-x', { type: 'button', 'aria-label': 'Dismiss', onclick: () => { dismissed.add(j.id); ready.delete(j.id); jobsList() } }, pic('close', { size: 16 }))
            : null
        return h(`div.lib-job.is-${kind}`, h('span.lib-job-glyph', glyph), h('span.lib-job-text', h('b', title), h('span', jobLine(j, kind, fmtUsd))), act)
      }))
  }

  function trashList(): void {
    const st = lib.getState()
    const items = st.api ? st.trash : []
    trashEl.hidden = !items.length
    if (!items.length) { trashEl.replaceChildren(); return }
    const head = h('button.lib-trash-head', { type: 'button', 'aria-expanded': String(trashOpen), onclick: () => { trashOpen = !trashOpen; trashList() } },
      h('span.caps', `Recently removed · ${String(items.length)}`), pic(trashOpen ? 'chevron-down' : 'chevron-right', { size: 16 }))
    const rows = trashOpen ? uniqueBy([...items].reverse(), (t) => t.id).map((t) => h('div.lib-trash-row',
      h('span.lib-trash-name', itemName(t)), h('button.btn.btn-secondary.lib-job-btn', { type: 'button', onclick: () => { quiet(restore(t)) } }, 'Restore'))) : []
    trashEl.replaceChildren(head, ...rows)
  }

  function render(): void {
    const all = engine.getLibrary()
    const manage = lib.getState().api === true
    addBtn.hidden = !manage
    const n = counts()
    const sel = engine.getItem(engine.getSelected())
    const inRoomCount = placedCount(all, n) // pieces placed, not kinds of piece
    panel.setCount(all.length ? String(all.length) : '')
    input.placeholder = searchPlaceholder(all.length, shell.isPhone())
    clear.hidden = !input.value
    chips.all.set(filter === 'all')
    chips.inroom.set(filter === 'inroom')
    const word = chips.inroom.lastChild
    if (word) word.textContent = `In the scene · ${String(inRoomCount)}`
    const shown = shownItems(all, filter, query, n)
    list.replaceChildren(...shown.map((l) => row(l, n.get(l.id) ?? 0, sel?.id, manage)))
    tools.hidden = !all.length
    none.hidden = shown.length > 0
    if (!all.length) {
      none.replaceChildren(h('strong', 'The library is empty.'), manage ? ' Add furniture from a photo, a product image link or a 3D file.' : ' Add furniture with midstudy-add (a photo, a product link or a 3D file), then reload.')
      if (manage) none.append(h('span.lib-none-cta', h('button.btn.btn-primary', { type: 'button', onclick: () => { openAdd() } }, 'Add furniture')))
    } else if (!shown.length) {
      none.replaceChildren(nothingShown(query, input.value.trim()))
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
    const title = (item?.name ?? '') || j.item_id
    if (j.kind === 'rescale') { shell.toast(`${title} refitted to its new size`, { kind: 'ok', id: `lib-job-${j.id}` }); return }
    // Same id as the "Making …" toast, so this one replaces it instead of stacking under it.
    shell.toast(`${title} is in the library`, { kind: 'ok', id: `lib-job-${j.id}`, ms: 10000,
      action: item ? { label: 'Place', onClick: () => { ready.delete(j.id); const l = engine.getLibrary().find((x) => x.id === item.id); if (l) quiet(add(l)) } } : undefined })
  })
  lib.events.addEventListener('job-failed', (e) => {
    const j = e.detail.job
    shell.toast(jobFailedText((j.item?.name ?? '') || j.item_id, j.message), { kind: 'error', id: `lib-job-${j.id}` })
  })
  shell.events.addEventListener('mode', render)
  shell.events.addEventListener('panel', (e) => {
    if (e.detail.id !== 'library' || !e.detail.open) return
    if (e.detail.detent === 'peek') showAdded()
    else if (!engine.getSelected()) lastAdded = null
  })
  // "/" focuses the search on desktop while the Library is open
  shell.addKeyFilter((e) => {
    if (e.key !== '/' || shell.isPhone() || !panel.isOpen() || (e.target instanceof Element && e.target.closest('input, textarea'))) return false
    e.preventDefault()
    input.focus()
    return true
  })
  render()
}
