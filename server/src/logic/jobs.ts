// Job ids (contract §2.8 Jobs, §4.4 Job object): `<prefix>-YYYYMMDD-HHMMSS-<4 hex>`, UTC, as v1 made them
// (`f"l-{now:%Y%m%d-%H%M%S}-{secrets.token_hex(2)}"`). Pure (TScert).
import { utcStamp } from '../../../common/logic/time.ts'

/** A job id: `c` calibration, `l` library or light job, `a` a room's align job (§4.9); `hex` is 4 random lowercase hex
 *  digits. */
export function jobId(prefix: 'c' | 'l' | 'a', epochMs: number, hex: string): string {
  return prefix + '-' + utcStamp(epochMs) + '-' + hex
}

/** A job's status (contract §4.4 Job object). `done` and `failed` are terminal. */
export type JobStatus = 'queued' | 'running' | 'done' | 'failed'

/** Whether a job may move from `from` to `to`: the first terminal status wins, so an ended job takes only its own status
 *  again (a message-only patch); a queued or running job takes any (rooms end a job from either). */
export function jobStep(from: JobStatus, to: JobStatus): boolean {
  if (from === 'queued' || from === 'running') return true
  return to === from
}
