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
