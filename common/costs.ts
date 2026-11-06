// costs.csv (contract §1, §2.9): one row per paid or mock call, appended under the costs lock (never the library's:
// a render never waits for a running midstudy-add), in v1's exact format. Shared by the server and midstudy-add.
import fs from 'node:fs'
import { atomicWrite } from './files.ts'
import { costsLockDir, withLock } from './lock.ts'
import { costsText, type CostRow } from './logic/csv.ts'

export type { CostRow } from './logic/csv.ts'

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null
    throw e
  }
}

/** v1 `append_cost`: the row appended to `costsFile` (the header first when the file is missing or blank), the whole
 *  file replaced atomically, under `<costs file>.lock.d`, waiting as long as it takes (a billed call's row must not be
 *  lost). `cmd` names the writer in the lock's owner.json. */
export async function appendCost(costsFile: string, row: CostRow, cmd = 'midstudy'): Promise<void> {
  await withLock(costsLockDir(costsFile), { waitMs: null, cmd }, async () => {
    await atomicWrite(costsFile, costsText(readText(costsFile), row))
  })
}
