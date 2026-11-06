// The library's sentences and small decisions (contract §2.8; v1 planner/serve.py LibraryService and its handlers):
// not-found and conflict answers, a job's status lines, the trash's names and order. Pure (TScert).
import { fmtCost, pyRepr } from '../../../../common/logic/pyfmt.ts'
import { utcStamp } from '../../../../common/logic/time.ts'
import { pyCompare } from './pyvalue.ts'

export const THUMB_TOO_LARGE = 'thumbnail is over 2 MB: send a smaller JPEG'
export const THUMB_NOT_JPEG = 'image must be a JPEG data URI (data:image/jpeg;base64,...)'
export const NO_SUMMARY = 'midstudy-add finished without its JSON summary line'
/** A job's first status line. */
export const QUEUED = 'waiting for the queue'

/** 404 of PATCH, PUT thumb and DELETE. */
export function noItem(id: string): string {
  return 'no library item ' + pyRepr(id) + ': GET /api/library lists them'
}

/** 404 of GET /api/library/jobs/<id>. */
export function noJob(id: string): string {
  return 'no library job ' + pyRepr(id) + ': GET /api/library/jobs lists them'
}

/** 404 of a restore whose id isn't a slug. */
export function noTrashed(id: string): string {
  return 'no trashed item ' + pyRepr(id)
}

/** 409 of a restore whose id is in the library (or has a folder) again. */
export function existsAgain(id: string): string {
  return 'an item ' + pyRepr(id) + ' exists again: remove it (or rename the new one) first'
}

/** 404 of a restore with no trashed copy. */
export function notInTrash(id: string): string {
  return pyRepr(id) + " isn't in the library's trash"
}

/** 409 of a thumbnail for an item whose folder is gone. */
export function noFolder(id: string): string {
  return 'library item ' + pyRepr(id) + ' has no folder: add it again'
}

/** An add's first status line: an upsert says what it replaces. */
export function queuedMessage(exists: boolean, id: string): string {
  return exists ? QUEUED + '; replaces the existing ' + id : QUEUED
}

/** The status line of a running job. */
export function runningMessage(kind: 'add' | 'rescale', itemId: string, engine: string): string {
  return kind === 'rescale' ? 'refitting ' + itemId : 'making ' + itemId + ' (' + engine + ')'
}

/** A job whose command doesn't exist (v1's FileNotFoundError). */
export function notInstalled(command: string): string {
  return "midstudy-add isn't installed here (" + command + ' not found): set --midstudy-add'
}

/** A job stopped at its timeout; a paid one's estimate stays reserved for the rest of the UTC day (§2.9). */
export function timedOut(seconds: number, held: number): string {
  const head = 'midstudy-add ran for more than ' + String(Math.floor(seconds / 60)) + ' minutes and was stopped'
  if (held <= 0) return head
  return head + '; fal may have charged for it, so its $' + fmtCost(held) + " estimate stays reserved against today's (UTC) budget"
}

/** A job the server itself failed to run (v1's `f"... ({type(e).__name__}: {e})"`). */
export function serverFailed(errorName: string, message: string): string {
  return 'the server failed to run midstudy-add (' + errorName + ': ' + message + ')'
}

/** The trash folder's name for an item deleted at `epochMs`: `<id>-YYYYMMDD-HHMMSS`, then `-2`, `-3`, … when taken. */
export function trashName(id: string, epochMs: number, n: number): string {
  const base = id + '-' + utcStamp(epochMs)
  return n <= 1 ? base : base + '-' + String(n)
}

/** What orders the trash: `str(deleted)` and the folder's name. */
export interface TrashKey {
  readonly deleted: string
  readonly dir: string
}

/** v1's trash order, newest first: by (`str(deleted)`, folder name), descending, ties kept in listing order. */
export function trashOrder(a: TrashKey, b: TrashKey): number {
  const byDeleted = pyCompare(b.deleted, a.deleted)
  return byDeleted !== 0 ? byDeleted : pyCompare(b.dir, a.dir)
}
