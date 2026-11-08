// Panel (area C): In the scene, the furniture placed on the open scene's photo. Rows: thumbnail, name, W × D × H cm, its
// height above the floor when raised, and Remove (with an Undo toast). Tapping a row selects the piece (the phone sheet
// drops to peek so you can see it); Shift- or ⌘-click adds it to the selection or takes it out. Every selected row is
// highlighted. Below the list (desktop): a few keys and "All shortcuts", which opens the Shortcuts sheet. Frames C2
// (phone) and C6 sections.
import { dimsText, quiet, type ItemInfo, type UiContext } from '../seam.js'
import { pic, itemThumb, emptyState } from './common.js'
import { placedMark } from '../logic/library.js'

/** @public planner/main.ts mounts every area: mod.mount(ctx) (knip does not follow the areas list). */
export function mount(ctx: UiContext): void {
  const { engine, shell, kit, keys } = ctx
  const { h, button } = kit
  const panel = shell.registerPanel({ id: 'inroom', label: 'In the scene', short: 'In scene', icon: 'in-room', phoneDetent: 'half', mount: () => { /* filled below */ } })
  const list = h('div.ir-list', { role: 'list' })
  const empty = emptyState({
    icon: 'sofa', title: 'Nothing placed yet',
    body: 'Add a piece from the Library. It lands on the floor in front of the camera; drag it to place it.',
    action: button({ label: 'Open Library', kind: 'primary', onClick: () => { shell.openPanel('library') } }),
  })
  const hint = h('p.p-hint.ir-hint', pic('info', { size: 16 }), h('span', 'Tap a row to select it; the sheet drops to peek so you can see it.'))
  const keyList = h('div.ir-keys',
    h('span.caps', 'Selected items'),
    h('div.ir-keys-grid', ([['item.rotate', 'Rotate 15°'], ['item.move', 'Move 1 cm'], ['item.remove', 'Remove'], ['select.shift', 'Add to selection']] as const).map(([id, t]) => h('span.ir-key', kit.kbd(keys.lookup(id)), h('span', t)))),
    h('button.ir-allkeys', { type: 'button', dataset: { midstudy: 'all-shortcuts' }, onclick: () => { ctx.shortcuts?.open() } }, h('span', 'All shortcuts'), kit.kbd(keys.lookup('help.shortcuts'))))
  panel.body.classList.add('ir')
  panel.body.append(list, empty, hint, keyList)

  function remove(uid: string): void {
    if (ctx.workspace) { ctx.workspace.removeWithUndo([uid]); return }
    const snap = engine.removeItemWithUndo(uid)
    if (!snap) return
    shell.toast(`${snap.name} removed`, { id: `removed:${uid}`, icon: 'trash', ms: 6000, action: { label: 'Undo', onClick: () => { quiet(engine.restoreItem(snap)) } } })
  }

  function select(uid: string, e?: MouseEvent | KeyboardEvent): void {
    if (e && (e.shiftKey || (keys.isMac ? e.metaKey : e.ctrlKey))) { engine.select(uid, { toggle: true }); return }
    engine.select(uid)
    if (shell.isPhone()) shell.setDetent('peek')
  }

  function row(it: ItemInfo, selected: boolean): HTMLDivElement {
    const mode = h('span.ir-mode', placedMark(it.missing, it.noGlb, it.position[1]))
    const del = h('button.ir-del', { type: 'button', 'aria-label': `Remove ${it.name}`, dataset: { tip: 'Remove', kbd: 'Del' }, onclick: (e) => { e.stopPropagation(); remove(it.uid) } }, pic('trash', { size: 18 }))
    const r: HTMLDivElement = h(`div.ir-row${selected ? '.is-selected' : ''}`, {
      role: 'listitem', tabindex: 0, dataset: { uid: it.uid }, 'aria-current': selected ? 'true' : null,
      onclick: (e) => { select(it.uid, e) },
      onkeydown: (e) => {
        if (e.target !== r) return
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(it.uid, e) }
        if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); e.stopPropagation(); remove(it.uid) }
      },
    },
    itemThumb(engine, it.lib, 'ir-thumb'),
    h('span.ir-text', h('span.ir-name', it.name), h('span.ir-meta.tnum', dimsText(it.lib.dims_cm))),
    h('span.ir-modeslot', mode), del)
    return r
  }

  function render(): void {
    const items = engine.getItems()
    const sel = engine.getSelected()
    panel.setCount(String(items.length))
    list.replaceChildren(...items.map((it) => row(it, engine.isSelected(it.uid))))
    empty.hidden = items.length > 0
    hint.hidden = !items.length
    keyList.hidden = !items.length || shell.isPhone()
    if (sel) requestAnimationFrame(() => { list.querySelector('.is-selected')?.scrollIntoView({ block: 'nearest' }) })
  }

  engine.events.addEventListener('items', (e) => { if (e.detail.change !== 'move') render() })
  engine.events.addEventListener('selection', render)
  engine.events.addEventListener('library', render)
  render()
}
