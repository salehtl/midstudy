// Panel (area C): Layouts, the saved arrangements of furniture for the open scene (contract §2.7, per scene). A "Now in
// the scene" card (Save layout, Save as new… with a name check, the save-failed state with Retry), then the scene's
// layouts: item count, saved date, the current one marked, Load (asks first when the furniture has unsaved changes),
// and a "…" menu with Save current over it and Delete…. Frames C3 (phone) and C6 sections. The rules and words:
// logic/layouts.ts.
import { quiet, sceneTitle, shortDate, type DeletedLayout, type LayoutSummary, type UiContext } from '../seam.js'
import type { ConfirmAction } from '../shell.js'
import { pic, withIcon, isOffline, messageOf, OFFLINE_BODY } from './common.js'
import { cardMeta, cardTitle, checkName, loadBody, noLayoutsText, rowMeta, savedWithText, sortLayouts } from '../logic/layouts.js'

interface Failure {
  readonly message: string
  readonly offline: boolean
  readonly retry: () => void
}

/** @public planner/main.ts mounts every area: mod.mount(ctx) (knip does not follow the areas list). */
export function mount({ engine, scenes, shell, kit, icons }: UiContext): void {
  const { h, button } = kit
  const panel = shell.registerPanel({ id: 'layouts', label: 'Layouts', icon: 'layouts', phoneDetent: 'half', mount: () => { /* filled below */ } })
  let asking = false   // the Save as new form is open
  let draft = ''
  let failure: Failure | null = null
  let busy = false
  const card = h('section.p-card.ly-card')
  const note = h('p.p-note.ly-note')
  const list = h('div.ly-list', { role: 'list' })
  const none = h('p.p-note.ly-none')
  panel.body.classList.add('ly')
  panel.body.append(card, note, list, none)

  const current = (): string => engine.getLayoutName().trim()
  const names = (): string[] => engine.getLayoutDetails().map((d) => d.name)
  // The name as the user typed it ("Phone A"), else the slug made readable ("two-chairs" → "Two chairs").
  const show = (name: string): string => engine.layoutDisplayName(name)
  const formCheck = (text: string): ReturnType<typeof checkName> => checkName(text, names(), show)

  // The load the Save as new form owes: load() asked with no current layout. The form's Cancel or a scene change forgets it.
  let pendingLoad: string | null = null
  let inFlight: Promise<boolean> | null = null

  interface SaveOptions {
    readonly quietly?: boolean
    readonly title?: string | null
    readonly fromForm?: boolean // the Save as new form's own save (or its Retry): it carries out pendingLoad
  }

  async function loadNow(name: string): Promise<void> {
    const ep = shell.epoch.now()
    try { await engine.loadLayoutInternal(name) } catch { return } // reported
    if (ep === shell.epoch.now()) shell.toast(`Loaded ${show(name)}`, { kind: 'ok', id: 'layout-loaded' })
  }

  async function runSave(name: string, { quietly = false, title = null, fromForm = false }: SaveOptions): Promise<boolean> {
    const ep = shell.epoch.now() // an answer after the scene changed says nothing in the new one
    busy = true
    failure = null
    render()
    let ok = false
    let owed: string | null = null
    try {
      await engine.saveLayoutInternal(name, { title })
      if (ep === shell.epoch.now()) {
        ok = true
        asking = false
        draft = ''
        owed = fromForm ? pendingLoad : null
        pendingLoad = null // the form has closed
        if (!quietly) shell.toast(`Layout saved as ${show(name)}`, { kind: 'ok', id: 'layout-saved' })
      }
    } catch (e) {
      if (ep === shell.epoch.now()) failure = { message: messageOf(e), offline: isOffline(e), retry: () => { quiet(save(name, { title, fromForm })) } }
    } finally {
      busy = false
      render()
    }
    if (owed !== null) await loadNow(owed)
    return ok
  }

  function save(name: string, opts: SaveOptions = {}): Promise<boolean> {
    if (busy) return Promise.resolve(false)
    const run = runSave(name, opts).finally(() => { if (inFlight === run) inFlight = null })
    inFlight = run
    return run
  }

  async function load(name: string): Promise<void> {
    const ep = shell.epoch.now()
    if (engine.isLayoutDirty() && engine.getItems().length) {
      const cur = current()
      const saveFirst: ConfirmAction<'save' | 'discard' | null> = { label: cur ? 'Save, then load' : 'Save as new first', value: 'save', kind: 'primary', default: true }
      const discard: ConfirmAction<'save' | 'discard' | null> = { label: "Load, don't save", value: 'discard', kind: 'secondary' }
      const cancel: ConfirmAction<'save' | 'discard' | null> = { label: 'Cancel', value: null, kind: 'secondary', cancel: true }
      const v = await shell.confirm({
        title: `Load ${show(name)}?`, icon: 'warning',
        body: loadBody(cur ? show(cur) : null),
        actions: shell.isPhone() ? [saveFirst, discard, cancel] : [cancel, discard, saveFirst],
      })
      if (v === null) return
      if (v === 'save') {
        while (inFlight) await inFlight // a save already running: wait for it rather than drop this load
        if (ep !== shell.epoch.now()) return
        if (engine.isLayoutDirty()) {
          const now = current() // that save may have named the layout
          if (!now) { pendingLoad = name; openForm(); return }
          if (!(await save(now, { quietly: true }))) return
        }
      }
    }
    pendingLoad = null
    await loadNow(name)
  }

  async function del(name: string): Promise<void> {
    const label = show(name)
    const ok = await shell.confirm({ title: `Delete ${label}?`, icon: 'trash', danger: true, confirm: 'Delete',
      body: 'The furniture in the scene stays as it is. You can undo this for a few seconds.' })
    if (!ok) return
    let deleted: DeletedLayout | null
    try { deleted = await engine.deleteLayoutInternal(name) } catch { return }
    const doc = deleted
    // Undo puts it back as it was; the server also keeps a copy in layouts/<scene>/.trash.
    const t = shell.toast(`${label} deleted`, { id: 'layout-deleted', icon: 'trash', ms: 10000,
      action: doc ? { label: 'Undo', onClick: () => { quiet(engine.restoreLayoutInternal(doc).then(() => shell.toast(`${label} is back`, { kind: 'ok', id: 'layout-deleted' }))) } } : undefined })
    t.el.querySelector('.toast-action')?.setAttribute('data-midstudy', 'layout-undo')
  }

  async function saveOver(d: LayoutSummary, isCur: boolean): Promise<void> {
    if (!isCur && !(await shell.confirm({ title: `Save over ${show(d.name)}?`, body: `It becomes the furniture in the scene now (${String(engine.getItems().length)} items).`, confirm: 'Save over it' }))) return
    quiet(save(d.name))
  }

  function openForm(): void {
    asking = true
    draft = ''
    failure = null
    if (shell.isPhone() && shell.getOpenPanel()?.detent === 'peek') shell.setDetent('half')
    if (!panel.isOpen()) shell.openPanel('layouts')
    render()
    requestAnimationFrame(() => { card.querySelector('input')?.focus() })
  }

  function cardView(): Node[] {
    const n = engine.getItems().length
    const cur = current()
    const dirty = engine.isLayoutDirty()
    const head = [
      h('span.caps', 'Now in the scene'),
      h('h3.ly-card-title', { title: (cur || null) }, cardTitle(cur ? show(cur) : null, n)),
      h('span.ly-card-meta.tnum', dirty && n ? icons.unsavedGlyph(14) : null, h('span', cardMeta(n, !!cur, dirty))),
    ]
    if (failure) {
      const f = failure
      return [...head,
        h('div.p-fail', { role: 'alert' }, h('span.p-fail-title', pic('warning', { size: 16 }), h('span', f.offline ? "Not saved · the server isn't answering" : 'Not saved')),
          h('span.p-fail-body', f.offline ? OFFLINE_BODY : f.message)),
        h('div.ly-actions', withIcon(button({ label: 'Retry', kind: 'primary', block: true, disabled: busy, onClick: () => { failure?.retry() } }), 'retry'),
          shell.isPhone() ? null : button({ label: 'Cancel', kind: 'quiet', onClick: () => { failure = null; render() } }))]
    }
    if (asking) {
      const check = formCheck(draft)
      const msg = h(`span.ly-form-msg${check.error ? '.is-error' : ''}`, (check.error ?? '') || check.hint)
      const go = button({ label: 'Save as new', kind: 'primary', disabled: busy || !!check.error || !draft.trim() })
      const submit = (e: SubmitEvent): void => {
        e.preventDefault()
        const c = formCheck(draft)
        if (c.error || !draft.trim()) return
        quiet(save(c.slug, { title: draft.trim(), fromForm: true }))
      }
      go.type = 'submit'
      const input: HTMLInputElement = h('input.input', { type: 'text', value: draft, placeholder: 'Evening, lamp by the window', spellcheck: false, autocomplete: 'off', enterkeyhint: 'done', 'aria-label': 'New layout name',
        oninput: () => {
          draft = input.value
          const c = formCheck(draft)
          msg.textContent = (c.error ?? '') || c.hint
          msg.classList.toggle('is-error', !!c.error)
          go.disabled = busy || !!c.error || !draft.trim()
        },
        onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); asking = false; pendingLoad = null; render() } } })
      return [...head, h('form.ly-form', { onsubmit: submit },
        h('label.field', h('span.field-label', 'New layout name'), input), msg,
        h('div.ly-form-actions', button({ label: 'Cancel', kind: 'quiet', onClick: () => { asking = false; pendingLoad = null; render() } }), go))]
    }
    const btns = cur
      ? [button({ label: busy ? 'Saving…' : 'Save layout', kind: 'primary', disabled: busy || (!n && !dirty), onClick: () => { quiet(save(cur)) } }),
        button({ label: 'Save as new…', kind: 'secondary', disabled: busy, onClick: () => { openForm() } })]
      : [button({ label: 'Save layout…', kind: 'primary', disabled: busy || !n, onClick: () => { openForm() } })]
    return [...head, h('div.ly-actions', btns)]
  }

  function rowView(d: LayoutSummary, cur: string): HTMLDivElement {
    const isCur = d.name === cur
    const parts = [isCur && !shell.isPhone() ? h('span.ly-cur-word', 'Current') : null, rowMeta(d.items, d.updated ? shortDate(d.updated) : null)]
    const meta: (Node | string)[] = []
    for (const x of parts) if (x !== null) meta.push(...(meta.length ? [' · ', x] : [x]))
    const more = h('button.ly-more', { type: 'button', 'aria-label': `More for ${show(d.name)}`, 'aria-haspopup': 'menu', dataset: { nodrag: '' },
      onclick: (e) => {
        e.stopPropagation()
        shell.menu(e.currentTarget instanceof Element ? e.currentTarget : null, [
          ...(isCur ? [] : [{ label: 'Load', icon: 'layouts', onSelect: () => { quiet(load(d.name)) } }]),
          { label: 'Save current over it', icon: 'bookmark', onSelect: () => { void saveOver(d, isCur) } },
          '-', { label: 'Delete…', icon: 'trash', danger: true, onSelect: () => { quiet(del(d.name)) } },
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

  function render(): void {
    const cur = current()
    const details = sortLayouts(engine.getLayoutDetails())
    panel.setCount(String(details.length))
    card.classList.toggle('is-failed', !!failure)
    const active = document.activeElement
    const typing = asking && card.contains(active) && active?.tagName === 'INPUT'
    if (!typing) card.replaceChildren(...cardView())
    const name = engine.getSceneName()
    const title = name ? sceneTitle(scenes.getScene(name) ?? engine.getScene()) : null
    note.hidden = !name
    note.replaceChildren(h('span.dot'), h('span', savedWithText(title)))
    list.replaceChildren(...details.map((d) => rowView(d, cur)))
    none.hidden = details.length > 0
    none.textContent = noLayoutsText(!!name)
  }

  engine.events.addEventListener('layouts', render)
  engine.events.addEventListener('dirty', render)
  engine.events.addEventListener('items', (e) => { if (e.detail.change !== 'move') render() })
  engine.events.addEventListener('scene', (e) => { if (['opened', 'closed', 'title'].includes(e.detail.phase)) { failure = null; asking = false; pendingLoad = null; render() } })
  scenes.events.addEventListener('scenes', render)
  shell.events.addEventListener('mode', render)
  render()
}
