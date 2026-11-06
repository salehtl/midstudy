// File times as v1 read them (Python's os.stat and datetime): `st_mtime` as CPython computes the float, `int(st_mtime)`
// for the scene assets' `?v=` cache buster, and `iso_utc(st_mtime)` (datetime.fromtimestamp rounds to the
// microsecond, half to even, before the seconds are printed) for a layout's `updated` and a legacy trash folder's
// `deleted`. Pure (TScert).
import { isoUtc } from '../../../../common/logic/time.ts'

/** CPython's `st_mtime`: `sec + nsec * 1e-9` in double precision (posixmodule.c fill_time). */
export function pyTimestamp(sec: number, nsec: number): number {
  return sec + nsec * 1e-9
}

/** Python's `int(t)` for a float: toward zero. */
export function pyInt(t: number): number {
  return t < 0 ? -Math.floor(-t) : Math.floor(t)
}

/** `round(x)` half to even (CPython's _PyTime_ROUND_HALF_EVEN). */
function roundHalfEven(x: number): number {
  const f = Math.floor(x)
  const d = x - f
  if (d > 0.5) return f + 1
  if (d < 0.5) return f
  return f % 2 === 0 ? f : f + 1
}

/** v1 `iso_utc(t)` for a float timestamp: `datetime.fromtimestamp(t, utc).isoformat(timespec="seconds")`, the
 *  fraction first rounded to whole microseconds (half to even), which can carry into the next second. */
export function isoFromTimestamp(t: number): string {
  const whole = pyInt(t)
  const us = roundHalfEven((t - whole) * 1e6)
  let seconds = whole
  if (us >= 1e6) seconds += 1
  else if (us < 0) seconds -= 1
  return isoUtc(seconds * 1000)
}
