// The daily spend cap (contract §2.9; v1 LibraryService's spent/spend/reserve/release/hold_for_today): before a paid
// call, its estimate is reserved against today's (UTC) total in costs.csv plus what running calls hold; a call that
// would cross the cap is refused with v1's 402 body and never made. Node runs one request at a time between awaits,
// and every method here is synchronous, so a reservation is atomic for this server as v1's mutex made it.
import fs from 'node:fs'
import { pyRound } from '../../common/logic/pyfmt.ts'
import { spentOn } from '../../common/logic/csv.ts'
import { utcDay } from '../../common/logic/time.ts'
import { DEFAULT_CAP_USD, MAX_CAP_USD, heldExpired, heldKey, refusal, type SpendRefusal } from './logic/spend.ts'
import type { Settings, Spend } from '../../contract/gen/types.ts'
import { atomicWriteSync, readJsonFile } from '../../common/files.ts'

export type { SpendRefusal } from './logic/spend.ts'

/** The cap, the reservations and the costs file it reads. The cap is --daily-spend-usd's (locked), or the app's
 *  Settings, saved in the settings file (<library>/settings.json; contract §2.9 Settings). */
export class SpendCap {
  readonly costsFile: string
  #cap: number
  readonly locked: boolean
  readonly #settingsFile: string | null
  readonly #now: () => number
  readonly #reserved = new Map<string, number>()

  constructor(costsFile: string, capUsd: number, now: () => number = Date.now, settings: { readonly file: string; readonly locked: boolean } | null = null) {
    this.costsFile = costsFile
    this.#cap = capUsd
    this.locked = settings?.locked ?? true
    this.#settingsFile = settings?.file ?? null
    this.#now = now
  }

  get capUsd(): number {
    return this.#cap
  }

  /** GET /api/settings: the budget, its default and maximum, and whether the flag fixes it. */
  settings(): Settings {
    return { daily_spend_usd: this.#cap, default_usd: DEFAULT_CAP_USD, max_usd: MAX_CAP_USD, locked: this.locked }
  }

  /** Saves the app's budget to settings.json (other keys kept) and uses it from now on. Only when not locked. */
  setCap(usd: number): void {
    if (this.locked || this.#settingsFile === null) throw new Error('the daily budget is fixed by --daily-spend-usd')
    const stored = readJsonFile(this.#settingsFile)
    const data: Record<string, unknown> = typeof stored === 'object' && stored !== null && !Array.isArray(stored) ? { ...stored } : {}
    data['daily_spend_usd'] = usd
    atomicWriteSync(this.#settingsFile, JSON.stringify(data, null, 2) + '\n')
    this.#cap = usd
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
