// Panel (area C): Layouts, the saved arrangements of furniture for the open scene (contract §2.7, per scene). A "Now in
// the scene" card (Save layout, Save as new… with a name check, the save-failed state with Retry), then the scene's
// layouts: item count, saved date, the current one marked, Load (asks first when the furniture has unsaved changes),
// and a "…" menu with Save current over it and Delete…. Frames C3 (phone) and C6 sections.
import { SLUG, quiet } from '../../engine.js'
import { pic, withIcon, shortDate, isOffline, OFFLINE_BODY } from './common.js'
import { sceneTitle } from '../../data.js'

export const slugify = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, '')
// "evening-two-chairs" → "Evening two chairs"
export const pretty = (name) => { const s = String(name || '').replace(/-/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }

export function mount({ engine, scenes, shell, kit, icons }) {
  const { h, button } = kit
  const panel = shell.registerPanel({ id: 'layouts', label: 'Layouts', icon: 'layouts', phoneDetent: 'half', mount: () => {} })
  let asking = false   // the Save as new form is open
  let draft = ''
  let failure = null   // { message, offline, retry }
  let busy = false
  const card = h('section.p-card.ly-card')
  const note = h('p.p-note.ly-note')
  const list = h('div.ly-list', { role: 'list' })
  const none = h('p.p-note.ly-none')
  panel.body.classList.add('ly')
  panel.body.append(card, note, list, none)

  const current = () => engine.getLayoutName().trim()
  const names = () => engine.getLayoutDetails().map((d) => d.name)
  // The name as the user typed it ("Phone A"), else the slug made readable ("two-chairs" → "Two chairs").
  const show = (name) => engine.layoutDisplayName(name) || pretty(name)

  async function save(name, { quietly = false, title = null } = {}) {
    if (busy) return false
    busy = true
    failure = null
    render()
    try {
      await engine.saveLayoutInternal(name, { title })
      asking = false
      draft = ''
      if (!quietly) shell.toast(`Layout saved as ${show(name)}`, { kind: 'ok', id: 'layout-saved' })
      return true
    } catch (e) {
      failure = { message: e.message, offline: isOffline(e), retry: () => quiet(save(name, { title })) }
      return false
    } finally {
      busy = false
      render()
    }
  }

  async function load(name) {
    const cur = current()
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const acts = [
        { label: cur ? 'Save, then load' : 'Save as new first', value: 'save', kind: 'primary', default: true },
        { label: "Load, don't save", value: 'discard', kind: 'secondary' },
        { label: 'Cancel', value: null, kind: 'secondary', cancel: true },
      ]
      const v = await shell.confirm({
        title: `Load ${show(name)}?`, icon: 'warning',
        body: cur ? `The furniture has changes that aren't saved to ${show(cur)}. Loading replaces it.` : "The furniture in the scene isn't saved as a layout. Loading replaces it.",
        actions: shell.isPhone() ? acts : [acts[2], acts[1], acts[0]],
      })
      if (v == null) return
      if (v === 'save') {
        if (!cur) { openForm(); return }
        if (!(await save(cur, { quietly: true }))) return
      }
    }
    try { await engine.loadLayoutInternal(name) } catch { return } // reported
    shell.toast(`Loaded ${show(name)}`, { kind: 'ok', id: 'layout-loaded' })
  }

  async function del(name) {
    const label = show(name)
    const ok = await shell.confirm({ title: `Delete ${label}?`, icon: 'trash', danger: true, confirm: 'Delete',
      body: 'The furniture in the scene stays as it is. You can undo this for a few seconds.' })
    if (!ok) return
    let doc
    try { doc = await engine.deleteLayoutInternal(name) } catch { return }
    // Undo puts it back as it was; the server also keeps a copy in layouts/<scene>/.trash.
    const t = shell.toast(`${label} deleted`, { id: 'layout-deleted', icon: 'trash', ms: 10000,
      action: doc ? { label: 'Undo', onClick: () => quiet(engine.restoreLayoutInternal(doc).then(() => shell.toast(`${label} is back`, { kind: 'ok', id: 'layout-deleted' }))) } : undefined })
    t.el.querySelector('.toast-action')?.setAttribute('data-midstudy', 'layout-undo')
  }

  function openForm() {
    asking = true
    draft = ''
    failure = null
    if (shell.isPhone() && shell.getOpenPanel()?.detent === 'peek') shell.setDetent('half')
    if (!panel.isOpen()) shell.openPanel('layouts')
    render()
    requestAnimationFrame(() => card.querySelector('input')?.focus())
  }

  function formCheck(text) {
    const slug = slugify(text)
    if (!text.trim()) return { slug, error: null, hint: 'Letters, numbers and spaces.' }
    if (!slug || !SLUG.test(slug)) return { slug, error: 'Use letters or numbers in the name.' }
    if (names().includes(slug)) return { slug, error: `${show(slug)} already exists. Pick another name, or use its … menu to save over it.` }
    return { slug, error: null, hint: '' }
  }

  function cardView() {
    const n = engine.getItems().length
    const cur = current()
    const dirty = engine.isLayoutDirty()
    const title = cur ? show(cur) : n ? 'Not saved as a layout' : 'Nothing placed'
    const metaText = `${n} ${n === 1 ? 'item' : 'items'} · ${cur ? (dirty ? 'changed since saved' : 'saved') : n ? 'not saved yet' : 'add furniture first'}`
    const head = [
      h('span.caps', 'Now in the scene'),
      h('h3.ly-card-title', { title: cur || null }, title),
      h('span.ly-card-meta.tnum', dirty && n ? icons.unsavedGlyph(14) : null, h('span', metaText)),
    ]
    if (failure) {
      return [head,
        h('div.p-fail', { role: 'alert' }, h('span.p-fail-title', pic('warning', { size: 16 }), h('span', failure.offline ? "Not saved · the server isn't answering" : 'Not saved')),
          h('span.p-fail-body', failure.offline ? OFFLINE_BODY : failure.message)),
        h('div.ly-actions', withIcon(button({ label: 'Retry', kind: 'primary', block: true, disabled: busy, onClick: () => failure?.retry() }), 'retry'),
          shell.isPhone() ? null : button({ label: 'Cancel', kind: 'quiet', onClick: () => { failure = null; render() } }))]
    }
    if (asking) {
      const check = formCheck(draft)
      const msg = h(`span.ly-form-msg${check.error ? '.is-error' : ''}`, check.error || check.hint || '')
      const go = button({ label: 'Save as new', kind: 'primary', disabled: busy || !!check.error || !draft.trim() })
      const submit = (e) => {
        e?.preventDefault()
        const c = formCheck(draft)
        if (c.error || !draft.trim()) return
        quiet(save(c.slug, { title: draft.trim() }))
      }
      go.type = 'submit'
      const input = h('input.input', { type: 'text', value: draft, placeholder: 'Evening, lamp by the window', spellcheck: false, autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'New layout name',
        oninput: () => {
          draft = input.value
          const c = formCheck(draft)
          msg.textContent = c.error || c.hint || ''
          msg.classList.toggle('is-error', !!c.error)
          go.disabled = busy || !!c.error || !draft.trim()
        },
        onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); asking = false; render() } } })
      return [head, h('form.ly-form', { onsubmit: submit },
        h('label.field', h('span.field-label', 'New layout name'), input), msg,
        h('div.ly-form-actions', button({ label: 'Cancel', kind: 'quiet', onClick: () => { asking = false; render() } }), go))]
    }
    const btns = cur
      ? [button({ label: busy ? 'Saving…' : 'Save layout', kind: 'primary', disabled: busy || !n && !dirty, onClick: () => quiet(save(cur)) }),
        button({ label: 'Save as new…', kind: 'secondary', disabled: busy, onClick: openForm })]
      : [button({ label: 'Save layout…', kind: 'primary', disabled: busy || !n, onClick: openForm })]
    return [head, h('div.ly-actions', btns)]
  }

  function rowView(d, cur) {
    const isCur = d.name === cur
    const count = Number.isFinite(d.items) ? `${d.items} ${d.items === 1 ? 'item' : 'items'}` : null
    const meta = [isCur && !shell.isPhone() ? h('span.ly-cur-word', 'Current') : null, [count, d.updated ? shortDate(d.updated) : null].filter(Boolean).join(' · ') || null]
      .filter(Boolean).flatMap((x, i) => (i ? [' · ', x] : [x]))
    const more = h('button.ly-more', { type: 'button', 'aria-label': `More for ${show(d.name)}`, 'aria-haspopup': 'menu', dataset: { nodrag: '' },
      onclick: (e) => {
        e.stopPropagation()
        shell.menu(e.currentTarget, [
          ...(isCur ? [] : [{ label: 'Load', icon: 'layouts', onSelect: () => quiet(load(d.name)) }]),
          { label: 'Save current over it', icon: 'bookmark', onSelect: async () => {
            if (!isCur && !(await shell.confirm({ title: `Save over ${show(d.name)}?`, body: `It becomes the furniture in the scene now (${engine.getItems().length} items).`, confirm: 'Save over it' }))) return
            quiet(save(d.name))
          } },
          '-', { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => quiet(del(d.name)) },
        ], { align: 'end' })
      } }, pic('more', { size: 18 }))
    const trail = isCur
      ? (shell.isPhone() ? h('span.ly-current.caps', 'Current') : null)
      : h('button.btn.btn-secondary.ly-load', { type: 'button', onclick: (e) => { e.stopPropagation(); quiet(load(d.name)) } }, 'Load')
    return h(`div.ly-row${isCur ? '.is-current' : ''}`, { role: 'listitem', title: d.name },
      h('span.ly-mark', pic(isCur ? 'bookmark-fill' : 'bookmark', { size: 18 })),
      h('span.ly-text', h('span.ly-name', show(d.name)),
        h('span.ly-meta.tnum', meta)),
      trail, more)
  }

  function render() {
    const cur = current()
    const details = engine.getLayoutDetails().slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || a.name.localeCompare(b.name))
    panel.setCount(String(details.length))
    card.classList.toggle('is-failed', !!failure)
    const typing = asking && card.contains(document.activeElement) && document.activeElement.tagName === 'INPUT'
    if (!typing) card.replaceChildren(...cardView().flat())
    const name = engine.getSceneName()
    const title = name ? sceneTitle(scenes.getScene(name) || engine.getScene()) : null
    note.hidden = !name
    note.replaceChildren(h('span.dot'), h('span', title ? `Saved with ${title}. Other scenes keep their own.` : ''))
    list.replaceChildren(...details.map((d) => rowView(d, cur)))
    none.hidden = details.length > 0
    none.textContent = name ? 'No layouts for this scene yet. Place some furniture, then Save layout.' : 'Open a scene to see its layouts.'
  }

  engine.events.addEventListener('layouts', render)
  engine.events.addEventListener('dirty', render)
  engine.events.addEventListener('items', (e) => { if (e.detail.change !== 'move') render() })
  engine.events.addEventListener('scene', (e) => { if (['opened', 'closed', 'title'].includes(e.detail.phase)) { failure = null; asking = false; render() } })
  scenes.events.addEventListener('scenes', render)
  shell.events.addEventListener('mode', render)
  render()
}
