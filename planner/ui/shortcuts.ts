// The Shortcuts sheet (main a292ee2): every shortcut and gesture in the keymap (keymap.ts), by group, built from the
// registry itself, so a module that registers a shortcut has it listed here with nothing else to update. ⌘? (also ⌘/
// and ?) opens it; the same keys and Esc close it. Styles: styles/manage.css (.ks-*).
// ctx.shortcuts: { open(), close(), toggle(), isOpen() }
import { openSheet, type Sheet } from './sheet.js'
import type { UiContext } from './seam.js'

const HELP_KEYS = ['mod+shift+/', 'mod+/', 'shift+/'] as const

/** @public planner/main.ts mounts every area: mod.mount(ctx) (knip does not follow the areas list). */
export function mount(ctx: UiContext): void {
  const { shell, keys, kit } = ctx
  const { h, kbd, button } = kit
  let sheet: Sheet | null = null
  const isOpen = (): boolean => sheet?.isOpen() ?? false

  function build(): HTMLElement {
    return h('div.ks', { dataset: { midstudy: 'shortcuts' } }, keys.list().map(({ group, items }) =>
      h('section.ks-group', h('h3.ks-head', group),
        h('dl.ks-list', items.map((it) => h('div.ks-row', { dataset: { id: it.id } },
          h('dt.ks-label', it.label),
          h('dd.ks-keys', it.keys.map((k, i) => [i ? h('span.ks-or', 'or') : null, kbd(k)]))))))))
  }
  function open(): void {
    if (isOpen()) return
    sheet = openSheet(shell, {
      title: 'Keyboard shortcuts', sub: `${keys.format(HELP_KEYS[0])} or ${keys.format(HELP_KEYS[2])} shows this list`, label: 'Keyboard shortcuts', cls: 'ks-sheet',
      body: build(), actions: [button({ label: 'Close', kind: 'secondary', onClick: () => { sheet?.close() } })],
      onClose: () => { sheet = null },
    })
  }
  const close = (): void => { sheet?.close() }
  const toggle = (): void => { if (isOpen()) close(); else open() }

  keys.register({ id: 'help.shortcuts', group: 'Help', label: 'Show these shortcuts', keys: HELP_KEYS, display: [HELP_KEYS[0], HELP_KEYS[2]], repeat: false, run: open })
  // While a sheet is open the shell swallows every key; let the same keys close this one.
  shell.addKeyFilter((e) => {
    const c = keys.comboOf(e)
    if (!isOpen() || !HELP_KEYS.some((k) => k === c)) return false
    e.preventDefault()
    close()
    return true
  })
  keys.events.addEventListener('change', () => { if (sheet?.isOpen()) sheet.body.replaceChildren(build()) })
  ctx.shortcuts = { open, close, toggle, isOpen }
}
