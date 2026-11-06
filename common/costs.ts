// costs.csv (contract §1, §2.9): one row per paid or mock call, appended under the costs lock (never the library's:
// a render never waits for a running midstudy-add), in v1's exact format. Shared by the server (renders, the product
// reader's model) and midstudy-add (its adds): one writer, one lock, one row format per v1 writer (CostRow.format).
import fs from 'node:fs'
import { atomicWrite } from './files.ts'
import { costsLockDir, withLock } from './lock.ts'
import { costsText, type CostRow } from './logic/csv.ts'
import { utf8Text } from './utf8.ts'

export type { CostRow } from './logic/csv.ts'

/** The file's text read strictly as v1 read it (`Path.read_text(encoding="utf-8")`: a UnicodeDecodeError on bad
 *  bytes), or null when it doesn't exist. */
function readText(file: string): string | null {
  let bytes: Uint8Array
  try {
    bytes = fs.readFileSync(file)
  } catch (e) {
    if (e instanceof Error && 'code' in e && e.code === 'ENOENT') return null
    throw e
  }
  return utf8Text(bytes)
}

/** v1 `append_cost`: the row appended to `costsFile` (the header first when the file is missing or blank), the whole
 *  file replaced atomically, under `<costs file>.lock.d`, waiting as long as it takes (a billed call's row must not be
 *  lost). `cmd` names the writer in the lock's owner.json. */
export async function appendCost(costsFile: string, row: CostRow, cmd = 'midstudy'): Promise<void> {
  await withLock(costsLockDir(costsFile), { waitMs: null, cmd }, async () => {
    await atomicWrite(costsFile, costsText(readText(costsFile), row))
  })
}
