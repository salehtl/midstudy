// Job ids (contract §2.8 Jobs, §4.4 Job object): `<prefix>-YYYYMMDD-HHMMSS-<4 hex>`, UTC, as v1 made them
// (`f"l-{now:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"`). Pure (TScert).
import { utcStamp } from '../../../common/logic/time.ts'

/** A job id: `c` calibration, `l` library or light job; `hex` is 4 random lowercase hex digits. */
export function jobId(prefix: 'c' | 'l', epochMs: number, hex: string): string {
  return prefix + '-' + utcStamp(epochMs) + '-' + hex
}
