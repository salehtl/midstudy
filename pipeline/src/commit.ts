// midstudy-add's file commits (docs/notes/state-machines-plan.md, wave 2): an item folder swapped in with rollback, a
// paid run's outputs kept, and a refit's files replaced together. Everything stays inside the library folder, so the
// renames here are atomic; the one step that can cross file systems is the first move out of the staging folder.
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import { exists, move, removeTree, replace } from '../../common/files.ts'
import { MidstudyError, describe } from './errors.ts'

/** The file operations of a swap, injectable so a test can fail each step in turn. */
export interface SwapOps {
  readonly rename: (from: string, to: string) => void
  readonly move: (from: string, to: string) => void
  readonly exists: (p: string) => boolean
  readonly remove: (p: string) => void
}

const realFs: SwapOps = {
  rename: (from, to) => { fs.renameSync(from, to) },
  move: (from, to) => { move(from, to) },
  exists,
  remove: (p) => { removeTree(p) },
}

/** `.incoming-` and `.replaced-` names start with a dot, so they are never slugs and can't collide with an item id. */
function sibling(libDir: string, kind: 'incoming' | 'replaced', id: string): string {
  return path.join(libDir, `.${kind}-${id}-${randomBytes(4).toString('hex')}`)
}

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e))
}

/** Runs the undo steps, last first. An undo that fails stops there: `stranded` says where the old item was left. */
function rollBack(steps: readonly (() => void)[], stranded: string | null): void {
  for (const step of [...steps].reverse()) {
    try {
      step()
    } catch (e) {
      throw new MidstudyError(`the previous item could not be put back (${describe(e)})${stranded === null ? '' : `; it is in ${stranded}`}`)
    }
  }
}

export type SwapResult =
  /** In place. `undo` puts the old item back and returns where the new outputs are; `finish` drops the old item. */
  | { readonly ok: true; readonly aside: string | null; readonly undo: () => string; readonly finish: () => void }
  /** Nothing changed in the library but `outputs`, the folder now holding the new item (the staging folder or an
   *  `.incoming-` folder): the caller keeps it (a paid run) or removes it. */
  | { readonly ok: false; readonly error: Error; readonly outputs: string }

/** Puts the finished `staging` folder at `itemDir`, replacing any item there. The old item stays whole until the new
 *  one is at its final name; any failure undoes the completed steps. `carryRaw` keeps the old item's raw/ (a re-run on
 *  the item's own raw output). */
export function swapIn(staging: string, itemDir: string, libDir: string, carryRaw: boolean, ops: SwapOps = realFs): SwapResult {
  const id = path.basename(itemDir)
  const incoming = sibling(libDir, 'incoming', id)
  try {
    ops.move(staging, incoming)
  } catch (e) {
    // a copy across file systems that failed leaves a partial folder and the staging folder intact
    if (ops.exists(staging)) {
      ops.remove(incoming)
      return { ok: false, error: asError(e), outputs: staging }
    }
    return { ok: false, error: asError(e), outputs: incoming }
  }
  const undo: (() => void)[] = []
  const hasOld = ops.exists(itemDir)
  const aside = hasOld ? sibling(libDir, 'replaced', id) : null
  try {
    if (aside !== null) {
      ops.rename(itemDir, aside)
      undo.push(() => { ops.rename(aside, itemDir) })
      if (carryRaw) {
        ops.rename(path.join(aside, 'raw'), path.join(incoming, 'raw'))
        undo.push(() => { ops.rename(path.join(incoming, 'raw'), path.join(aside, 'raw')) })
      }
    }
    ops.rename(incoming, itemDir)
  } catch (e) {
    rollBack(undo, aside)
    return { ok: false, error: asError(e), outputs: incoming }
  }
  return {
    ok: true,
    aside,
    undo: () => {
      rollBack([...undo, () => { ops.rename(itemDir, incoming) }], aside)
      return incoming
    },
    finish: () => {
      if (aside !== null) ops.remove(aside)
    },
  }
}

export interface KeptOutputs {
  /** The folder under `_failed/` holding the outputs, or null when there were none to keep or the move failed. */
  readonly kept: string | null
  /** What went wrong while recording, for the failure's one line (empty when nothing did). */
  readonly problems: readonly string[]
}

/** A paid run that failed: its outputs go to `_failed/<id>-<stamp>` first, then the cost row is written. Each step
 *  has its own try, so neither failure costs the other. */
export async function keepPaidOutputs(outputs: string | null, libDir: string, id: string, stamp: string, recordCost: () => Promise<void>, ops: SwapOps = realFs): Promise<KeptOutputs> {
  const problems: string[] = []
  let kept: string | null = null
  fs.mkdirSync(libDir, { recursive: true })
  if (outputs !== null) {
    const target = path.join(libDir, '_failed', `${id}-${stamp.replaceAll(':', '')}`)
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true })
      ops.move(outputs, target)
      kept = target
    } catch (e) {
      problems.push(`the engine outputs could not be kept (${describe(e)})`)
    }
  }
  try {
    await recordCost()
  } catch (e) {
    problems.push(`the cost row could not be written (${describe(e)})`)
  }
  return { kept, problems }
}

export interface FileReplace {
  readonly from: string
  readonly to: string
}

/** A refit's commit, synchronous so no signal lands inside it: each existing file is hard-linked to a sibling
 *  `.<name>.bak-<rand>` (the same folder, so a link always works), the files are replaced, and `then` writes
 *  library.json. Any throw restores every file (a new one with no original is removed) and rethrows. */
export function replaceTogether(files: readonly FileReplace[], then: () => void): void {
  const rand = randomBytes(4).toString('hex')
  const backups = files.map((f) => path.join(path.dirname(f.to), `.${path.basename(f.to)}.bak-${rand}`))
  const had = files.map((f) => exists(f.to))
  const restore = (): void => {
    files.forEach((f, i) => {
      const bak = backups[i]
      if (bak === undefined) return
      if (had[i] === true) {
        if (exists(bak)) {
          fs.renameSync(bak, f.to)
          // a rename between two links of one file does nothing and leaves both names
          fs.rmSync(bak, { force: true })
        }
      } else if (exists(f.to)) {
        fs.rmSync(f.to, { force: true })
      }
    })
  }
  try {
    files.forEach((f, i) => {
      const bak = backups[i]
      if (bak !== undefined && had[i] === true) fs.linkSync(f.to, bak)
    })
    for (const f of files) replace(f.from, f.to)
    then()
  } catch (e) {
    restore()
    throw e
  }
  for (const bak of backups) fs.rmSync(bak, { force: true })
}
