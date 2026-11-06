// A scene's calib_status and lighting_status (contract §4.4, §4.8), from its newest calibration job, its newest light
// job and the files it has, as v1's SceneService.status and lighting_status decided them. Pure (TScert).

/** A job's state as the status rules read it. */
export interface JobState {
  readonly status: 'queued' | 'running' | 'done' | 'failed'
  readonly message: string
}

/** A light job's state: also whether it found light (null until it ran) and whether its scene was deleted while it was
 *  queued or running (v1's `dropped`). */
export interface LightJobState extends JobState {
  readonly lighting: boolean | null
  readonly dropped: boolean
}

/** The scene's calib_status and calib_error. */
export interface CalibStatus {
  readonly status: 'pending' | 'running' | 'done' | 'failed'
  readonly error: string | null
}

/** v1's sentence for a scene without calib.json and without a job in this server run. */
export const LOST_CALIBRATION = "the calibration didn't finish (the server restarted): calibrate it again"

/** v1 `status`: pending or running while the newest calibration job waits or runs; failed with its message when it
 *  failed; else done with calib.json, failed without (a calibration lost to a restart). */
export function calibStatus(job: JobState | null, hasCalib: boolean): CalibStatus {
  if (job !== null && job.status === 'queued') return { status: 'pending', error: null }
  if (job !== null && job.status === 'running') return { status: 'running', error: null }
  if (job !== null && job.status === 'failed') return { status: 'failed', error: job.message }
  if (hasCalib) return { status: 'done', error: null }
  return { status: 'failed', error: LOST_CALIBRATION }
}

/** The scene's lighting_status and lighting_error. */
export interface LightingStatus {
  readonly status: 'done' | 'pending' | 'running' | 'failed' | 'none' | 'missing'
  readonly error: string | null
}

/** v1 `lighting_status`: done with lighting.json; else what the newest light job says (pending, running, failed with its
 *  message, none when it found no light, else missing), unless its scene was deleted meanwhile or a calibration came
 *  after it (`calibrationIsNewer`): then pending or running while that calibration waits or runs; else missing. */
export function lightingStatus(hasLighting: boolean, light: LightJobState | null, calibration: JobState | null, calibrationIsNewer: boolean): LightingStatus {
  if (hasLighting) return { status: 'done', error: null }
  const lj = light === null || light.dropped || (calibration !== null && calibrationIsNewer) ? null : light
  if (lj !== null) {
    if (lj.status === 'queued') return { status: 'pending', error: null }
    if (lj.status === 'running') return { status: 'running', error: null }
    if (lj.status === 'failed') return { status: 'failed', error: lj.message === '' ? 'inferring the light failed' : lj.message }
    return { status: lj.lighting === false ? 'none' : 'missing', error: null }
  }
  if (calibration !== null && calibration.status === 'queued') return { status: 'pending', error: null }
  if (calibration !== null && calibration.status === 'running') return { status: 'running', error: null }
  return { status: 'missing', error: null }
}
