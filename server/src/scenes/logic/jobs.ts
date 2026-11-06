// The calibration queue's job objects and sentences (contract §4.4 Job object, §4.8 backfill), worded as v1's
// SceneService (planner/serve.py queue_job, run, light_done, finish, delete). Pure (TScert).
import { pyRound } from '../../../../common/logic/pyfmt.ts'
import { isNum, pyStr, pyTruthy } from './values.ts'

/** What a calibration-queue job runs: `<calib> run|fit|light|align-room <args>` (or the same request to the worker;
 *  align-room: a room's align job, contract §4.9). */
export type CalibCommand = 'run' | 'fit' | 'light' | 'align-room'

/** v1's message of a queued job. */
export const QUEUED = 'waiting for the calibration queue'
/** v1's message of a job whose scene was deleted while it was queued or running. */
export const SCENE_DELETED = 'the scene was deleted'
/** v1's message when a calibration ended without a result line (exit 0). */
export const NO_RESULT_LINE = 'midstudy-calib finished without its JSON result line'
/** v1's 409 while a scene's calibration is queued or running. */
export const ALREADY_CALIBRATING = 'this scene is already calibrating: wait for it to finish'
/** v1's 409 for a scene with neither photo.jpg nor source.<ext>. */
export const NO_PHOTO_TO_CALIBRATE = 'this scene has no photo to calibrate: make a new scene from the photo'
/** v1's 409 for POST …/light while the scene calibrates. */
export const LIGHT_WHILE_CALIBRATING = 'this scene is calibrating; its lighting comes with it'
/** v1's 409 for POST …/light without photo.jpg. */
export const LIGHT_WITHOUT_PHOTO = 'this scene has no photo to infer the light from: calibrate it first'

/** v1's message while a job runs. */
export function runningMessage(kind: 'calibrate' | 'light'): string {
  return kind === 'light' ? 'inferring the light' : 'calibrating the photo'
}

/** v1's sentence when the calibration command isn't there (FileNotFoundError). */
export function notInstalled(command: string): string {
  return "the calibration tool isn't installed here (" + command + ' not found): set --calib'
}

/** v1's sentence when a job ran past its timeout (`CALIB_TIMEOUT // 60` minutes). */
export function timedOut(kind: 'calibrate' | 'light', timeoutSeconds: number): string {
  const what = kind === 'light' ? 'inferring the light' : 'the calibration'
  return what + ' ran for more than ' + String(Math.floor(timeoutSeconds / 60)) + ' minutes and was stopped'
}

/** v1's message when running a job threw (the queue's catch-all). */
export function serverFailed(errorName: string, errorMessage: string): string {
  return 'the server failed to run the calibration (' + errorName + ': ' + errorMessage + ')'
}

/** v1's message of a calibration that succeeded: `calibrated (<source>)`, plus ` · check the floor` unless the source
 *  is moge-2 or truth and the floor was found. `source` and `floorFound` are calib.json's `source` and `floor.found`
 *  (undefined when it has no floor object). */
export function calibratedMessage(source: unknown, floorFound: unknown): string {
  const src = pyTruthy(source) ? pyStr(source) : 'unknown'
  const good = (source === 'moge-2' || source === 'truth') && pyTruthy(floorFound)
  return 'calibrated (' + src + ')' + (good ? '' : ' · check the floor')
}

/** Python's `round(x)` of a finite float as an integer's text (ties to even; exact for any size). */
function roundedText(x: number): string {
  return BigInt(pyRound(x, 0)).toString()
}

/** v1 `light_done`'s message: `lighting inferred (<K> K)` when it found light and `cct_k` is a number, `lighting
 *  inferred` without one, `no clear light in the photo` when it found none. */
export function lightMessage(found: boolean, cct: unknown): string {
  if (!found) return 'no clear light in the photo'
  return isNum(cct) ? 'lighting inferred (' + roundedText(cct) + ' K)' : 'lighting inferred'
}
