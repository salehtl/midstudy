// The daily spend cap (contract §2.9; v1 LibraryService's spent/spend/reserve/release/hold_for_today): before a paid
// call, its estimate is reserved against today's (UTC) total in costs.csv plus what running calls hold; a call that
// would cross the cap is refused with v1's 402 body and never made. Node runs one request at a time between awaits,
// and every method here is synchronous, so a reservation is atomic for this server as v1's mutex made it.
import fs from 'node:fs'
import { pyRound } from '../../common/logic/pyfmt.ts'
import { spentOn } from '../../common/logic/csv.ts'
import { utcDay } from '../../common/logic/time.ts'
import { heldExpired, heldKey, refusal, type SpendRefusal } from './logic/spend.ts'
import type { Spend } from '../../contract/gen/types.ts'

export type { SpendRefusal } from './logic/spend.ts'

/** The cap, the reservations and the costs file it reads. */
export class SpendCap {
  readonly costsFile: string
  readonly capUsd: number
  readonly #now: () => number
  readonly #reserved = new Map<string, number>()

  constructor(costsFile: string, capUsd: number, now: () => number = Date.now) {
    this.costsFile = costsFile
    this.capUsd = capUsd
    this.#now = now
  }

  /** Today's (UTC) day, `YYYY-MM-DD`. */
  today(): string {
    return utcDay(this.#now())
  }

  /** v1 `spent`: the day's total in costs.csv (0 when it can't be read), rounded to 6 places. */
  spent(day: string): number {
    let text: string
    try {
      text = fs.readFileSync(this.costsFile, 'utf8')
    } catch {
      return 0
    }
    return pyRound(spentOn(text, day), 6)
  }

  #expireHeld(day: string): void {
    for (const key of [...this.#reserved.keys()]) {
      if (heldExpired(key, day)) this.#reserved.delete(key)
    }
  }

  #reservedTotal(): number {
    let total = 0
    for (const v of this.#reserved.values()) total += v
    return total
  }

  /** GET /api/spend: `{day, spent_usd, reserved_usd, cap_usd}`. */
  view(): Spend {
    const day = this.today()
    this.#expireHeld(day)
    return { day, spent_usd: this.spent(day), reserved_usd: pyRound(this.#reservedTotal(), 6), cap_usd: this.capUsd }
  }

  /** Reserves `amount` under `key` against today's cap: null when it fits (nothing is held for an amount ≤ 0), else
   *  the 402 body and nothing reserved. */
  reserve(key: string, amount: number): SpendRefusal | null {
    if (amount <= 0) return null
    const day = this.today()
    this.#expireHeld(day)
    const refused = refusal(amount, this.spent(day), this.#reservedTotal(), this.capUsd)
    if (refused !== null) return refused
    this.#reserved.set(key, amount)
    return null
  }

  /** Gives back `key`'s reservation (when its call ended, paid or not). */
  release(key: string): void {
    this.#reserved.delete(key)
  }

  /** Keeps `key`'s reservation until the end of the UTC day instead of releasing it (a paid job stopped at its timeout
   *  may still have been charged). Returns the amount held. */
  holdForToday(key: string): number {
    const day = this.today()
    const amount = this.#reserved.get(key) ?? 0
    this.#reserved.delete(key)
    if (amount > 0) this.#reserved.set(heldKey(day, key), amount)
    return amount
  }
}
