// The Settings sheet's budget field (ui/settings.ts, main fc82c5c): what was typed, read as dollars. Pure, TScert-checked.
import { fmtUsd } from '../../logic/text.js'

/** The typed budget (a leading $ allowed), rounded to cents, or why it can't be saved. */
export function budgetInput(typed: string, maxUsd: number): { readonly value: number; readonly error: null } | { readonly value: null; readonly error: string } {
  const t = typed.trim().replace(/^\$/, '')
  const v = Number(t)
  if (!t || !Number.isFinite(v) || v < 0) return { value: null, error: 'Enter an amount in dollars, like 10' }
  if (v > maxUsd) return { value: null, error: `At most ${fmtUsd(maxUsd)} a day` }
  return { value: Math.round(v * 100) / 100, error: null }
}
