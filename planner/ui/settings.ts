// Settings (contract §2.9 Settings, main fc82c5c): the daily fal budget, saved by the server in <library>/settings.json
// and used for every paid call (library adds and renders). When the server was started with --daily-spend-usd the
// budget is fixed there, and the sheet only shows it. Opened from the Scenes page (Settings button) and ⌘,.
// Styles: styles/manage.css. ctx.settings = { open() }
import { isSheetOpen, openSheet, type Sheet } from './sheet.js'
import { fmtUsd, quiet, type UiContext } from './seam.js'
import { budgetInput } from './logic/settings.js'

/** @public planner/main.ts mounts every area: mod.mount(ctx) (knip does not follow the areas list). */
export function mount(ctx: UiContext): void {
  const { lib, shell, keys, kit } = ctx
  const { h, button } = kit
  let sheet: Sheet | null = null

  async function open(): Promise<void> {
    if (sheet?.isOpen()) return
    let s: Awaited<ReturnType<typeof lib.settings>>
    try { s = await lib.settings() } catch { return } // reported
    let spend = null
    try { spend = await lib.spend() } catch { /* reported; the sheet still works */ }
    if (isSheetOpen()) return // never close a sheet that opened meanwhile
    const phone = shell.isPhone()
    let saving = false // Enter and the button share it
    const input = h('input.ms-input.tnum', {
      type: 'text', inputmode: 'decimal', enterkeyhint: 'done', autocomplete: 'off', spellcheck: false,
      value: String(s.daily_spend_usd), disabled: s.locked, 'aria-label': 'Daily fal budget in US dollars',
      dataset: { midstudy: 'budget-input' },
      oninput: () => { sync() },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); quiet(save()) } },
    })
    const err = h('span.ms-hint.is-error', { hidden: true })
    const used = spend ? (spend.spent_usd ?? 0) + (spend.reserved_usd ?? 0) : null
    const hint = s.locked
      ? "Fixed by the server's --daily-spend-usd. Restart it without that flag to set it here."
      : 'Paid calls (adding furniture, renders) stop for the day once this is reached. 0 blocks them all. Resets at midnight UTC.'
    const go = button({ label: 'Save', kind: 'primary', block: phone, onClick: () => { quiet(save()) } })
    go.classList.add('ms-primary')
    go.dataset['midstudy'] = 'budget-save'
    function sync(): void {
      const p = budgetInput(input.value, s.max_usd)
      err.hidden = p.error === null || !input.value.trim()
      err.textContent = p.error ?? ''
      go.disabled = saving || s.locked || p.error !== null || p.value === s.daily_spend_usd
    }
    async function save(): Promise<void> {
      if (saving) return
      const p = budgetInput(input.value, s.max_usd)
      if (s.locked || p.error !== null) return
      saving = true
      sync()
      try { s = await lib.setBudget(p.value) } catch { return } finally { saving = false; sync() } // reported
      shell.toast(`Daily fal budget: ${fmtUsd(s.daily_spend_usd)}`, { kind: 'ok', id: 'budget-saved', ms: 4000 })
      mine.close()
    }
    const body = h('div.ms-form',
      h('label.ms-row', h('span.ms-label', 'Daily fal budget (USD)'), input, h('span.ms-hint', hint), err),
      used !== null ? h('p.ms-note.tnum', ctx.icons.icon('info', { size: 14 }), h('span', `Today so far: ${fmtUsd(used)}. Default ${fmtUsd(s.default_usd)}.`)) : null)
    const mine = openSheet(shell, {
      title: 'Settings', label: 'Settings', cls: 'st-sheet', body,
      actions: [phone ? null : button({ label: s.locked ? 'Close' : 'Cancel', kind: 'secondary', onClick: () => { mine.close() } }), s.locked ? null : go],
      onClose: () => { if (sheet === mine) sheet = null },
    })
    sheet = mine
    sync()
    if (!s.locked && !phone) requestAnimationFrame(() => { input.focus(); input.select() })
  }

  keys.register({ id: 'app.settings', group: 'Help', label: 'Settings', keys: ['mod+,'], repeat: false, run: () => { quiet(open()) } })
  ctx.settings = { open: () => { quiet(open()) } }
}
