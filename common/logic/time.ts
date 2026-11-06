// UTC timestamps in v1's formats, from milliseconds since the epoch (pure: no Date, so TScert can read it).
// iso_utc() `2026-11-05T21:36:09Z`, a render's `created` `2026-11-05T21:36:09.987Z`, job and scene stamps
// `20261105-213609`, the spend cap's day `2026-11-05`.

/** A UTC calendar time. */
interface UtcParts {
  readonly year: number
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
  readonly second: number
  readonly ms: number
}

/** The UTC calendar fields of `epochMs` (proleptic Gregorian; H. Hinnant's civil_from_days). */
function utcParts(epochMs: number): UtcParts {
  const t = Math.floor(epochMs)
  const days = Math.floor(t / 86400000)
  const msOfDay = t - days * 86400000
  const z = days + 719468
  const era = Math.floor(z / 146097)
  const doe = z - era * 146097
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365)
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100))
  const mp = Math.floor((5 * doy + 2) / 153)
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1
  const month = mp < 10 ? mp + 3 : mp - 9
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0)
  const hour = Math.floor(msOfDay / 3600000)
  const minute = Math.floor((msOfDay - hour * 3600000) / 60000)
  const second = Math.floor((msOfDay - hour * 3600000 - minute * 60000) / 1000)
  const ms = msOfDay - hour * 3600000 - minute * 60000 - second * 1000
  return { year, month, day, hour, minute, second, ms }
}

function two(n: number): string {
  return String(n).padStart(2, '0')
}

/** `YYYY-MM-DD` (UTC): the spend cap's day, `strftime("%Y-%m-%d")`. */
export function utcDay(epochMs: number): string {
  const p = utcParts(epochMs)
  return String(p.year).padStart(4, '0') + '-' + two(p.month) + '-' + two(p.day)
}

/** v1's `iso_utc`: `YYYY-MM-DDTHH:MM:SSZ`, the seconds truncated (`isoformat(timespec="seconds")`). */
export function isoUtc(epochMs: number): string {
  const p = utcParts(epochMs)
  return utcDay(epochMs) + 'T' + two(p.hour) + ':' + two(p.minute) + ':' + two(p.second) + 'Z'
}

/** `YYYY-MM-DDTHH:MM:SS.mmmZ` (`isoformat(timespec="milliseconds")`, a render's `created`). */
export function isoUtcMs(epochMs: number): string {
  const p = utcParts(epochMs)
  return isoUtc(epochMs).slice(0, 19) + '.' + String(p.ms).padStart(3, '0') + 'Z'
}

/** `YYYYMMDD-HHMMSS` (UTC): job ids, scene and render names, trash stamps (`f"{now:%Y%m%d-%H%M%S}"`). */
export function utcStamp(epochMs: number): string {
  const p = utcParts(epochMs)
  return String(p.year).padStart(4, '0') + two(p.month) + two(p.day) + '-' + two(p.hour) + two(p.minute) + two(p.second)
}
