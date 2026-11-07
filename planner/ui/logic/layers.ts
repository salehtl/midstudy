// The shell's overlay stack (ui/shell.ts pushLayer): confirms, menus, the Scenes page, form sheets (ui/sheet.ts) and the
// renders modal, innermost last. One Esc cancels one layer and goes no further. Pure, TScert-checked.

export type LayerKind = 'confirm' | 'menu' | 'page' | 'sheet' | 'modal'

/** The index of the one layer an Esc cancels: the innermost, except that an Esc typed in a field leaves a page open (it
 *  only blurs the field there); a sheet, modal, confirm or menu closes from a field too. null: Esc is not the shell's. */
export function escTarget(kinds: readonly LayerKind[], inField: boolean): number | null {
  const i = kinds.length - 1
  const top = kinds[i]
  if (top === undefined) return null
  if (top === 'page' && inField) return null
  return i
}
