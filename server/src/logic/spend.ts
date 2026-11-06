// The daily spend cap (contract §2.9, v1 LibraryService.reserve): whether a paid call fits under today's (UTC) cap
// with what costs.csv says was spent and what running calls hold, and v1's 402 sentences. Pure (TScert);
// server/src/spend.ts keeps the reservations and reads costs.csv.
import { fmtCost, pyFixed } from '../../../common/logic/pyfmt.ts'

/** The 402 body (spend-refused.schema.json). */
export interface SpendRefusal {
  readonly error: string
  readonly spent_usd: number
  readonly cap_usd: number
}

/** v1 `reserve`'s decision for `amount` (> 0): null when it fits, else the 402 body. `spent` is today's total from
 *  costs.csv (rounded to 6 places), `reserved` the sum of what running calls hold. */
export function refusal(amount: number, spent: number, reserved: number, cap: number): SpendRefusal | null {
  const used = spent + reserved
  if (!(used + amount > cap + 1e-9)) return null
  const held = used - spent
  let error: string
  if (amount > cap + 1e-9) {
    error = 'this call costs $' + fmtCost(amount) + ', more than the daily fal budget ($' + pyFixed(cap, 2) + ') allows'
  } else {
    error = "today's fal budget ($" + pyFixed(cap, 2) + ') is used up: $' + pyFixed(spent, 2) + ' spent'
      + (held > 1e-9 ? ' and $' + pyFixed(held, 2) + ' reserved by calls still running' : '')
      + ', and this call costs $' + fmtCost(amount)
  }
  return { error, spent_usd: spent, cap_usd: cap }
}

/** The key a timed-out paid job's reservation is kept under until the end of its UTC day (v1 `hold_for_today`). */
export function heldKey(day: string, key: string): string {
  return 'held:' + day + ':' + key
}

/** A held reservation from another day, dropped before the cap is read (v1 `_expire_held`). */
export function heldExpired(key: string, day: string): boolean {
  if (!key.startsWith('held:')) return false
  return key.split(':')[1] !== day
}

// --- Settings: the daily budget (contract §2.9 Settings, main fc82c5c) --------------------------------------------------
/** The budget without --daily-spend-usd and without a saved setting. */
export const DEFAULT_CAP_USD = 2
/** The highest budget the flag or Settings may set. */
export const MAX_CAP_USD = 10000

/** A budget Settings or <library>/settings.json may hold: a finite number from 0 to MAX_CAP_USD (not a boolean). */
function validCap(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= MAX_CAP_USD
}

/** The budget at startup: the flag's (fixed), else settings.json's daily_spend_usd when valid, else the default. */
export function startCap(flag: number | null, stored: unknown): { readonly cap: number; readonly locked: boolean } {
  if (flag !== null) return { cap: flag, locked: true }
  const saved: unknown = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? Reflect.get(stored, 'daily_spend_usd') : undefined
  return { cap: validCap(saved) ? saved : DEFAULT_CAP_USD, locked: false }
}

/** PUT /api/settings's body: the budget to save (rounded to cents), or the 400 sentence. */
export function budgetPut(body: unknown): { readonly ok: true; readonly usd: number } | { readonly ok: false; readonly error: string } {
  if (typeof body !== 'object' || body === null || Array.isArray(body) || !('daily_spend_usd' in body)) return { ok: false, error: 'send {"daily_spend_usd": <dollars>}' }
  const usd: unknown = Reflect.get(body, 'daily_spend_usd')
  if (!validCap(usd)) return { ok: false, error: 'daily_spend_usd must be a number from 0 to ' + String(MAX_CAP_USD) }
  return { ok: true, usd: Math.round(usd * 100) / 100 }
}

/** PUT /api/settings's 409 while --daily-spend-usd fixes the budget. */
export function budgetLocked(cap: number): string {
  return "the daily budget is set by the server's --daily-spend-usd ($" + cap.toFixed(2) + '): restart it without that flag to set it here'
}
