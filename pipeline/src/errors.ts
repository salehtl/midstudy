// midstudy-add's failures (v1's MidstudyError and its top-level handler, contract §3.1): one actionable line on
// stderr prefixed `midstudy-add: `, exit 1; anything else is an "unexpected error" named as v1's Python would name it.
import { isOsError, osError, osErrorType } from './pytext.ts'

/** A failure the user can act on: its message is the one line printed. */
export class MidstudyError extends Error {
  override readonly name: string = 'MidstudyError'
}

/** SAM 3D's text detector found nothing (fal answers 422 before running, so the call isn't charged). */
export class NoMasks extends MidstudyError {
  override readonly name: string = 'NoMasks'
}

/** A live paid run stopped by SIGINT/SIGTERM (LiveFal's stop signal): the cost is recorded and the outputs kept
 *  before it reaches main(), which exits 130 (docs/notes/state-machines-plan.md, wave 1). */
export class Interrupted extends MidstudyError {
  override readonly name: string = 'Interrupted'

  constructor() {
    super('interrupted')
  }
}

/** A failure v1 didn't word: printed as `unexpected error (<type>: <message>)`, `type` named as Python names it. */
export class UnexpectedError extends Error {
  readonly pyType: string

  constructor(pyType: string, message: string) {
    super(message)
    this.pyType = pyType
  }
}

/** `f"{type(e).__name__}: {e}"` for a thrown value (a Node file-system error as the OSError Python raises). */
export function describe(e: unknown): string {
  if (e instanceof UnexpectedError) return `${e.pyType}: ${e.message}`
  if (isOsError(e)) return `${osErrorType(e)}: ${osError(e)}`
  if (e instanceof Error) return `${e.name}: ${e.message}`
  return `Error: ${String(e)}`
}
