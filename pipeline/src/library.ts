// library.json upserts and costs.csv rows (contract §1, §3.4; v1's library.py), written exactly as v1 writes them
// (Python's json.dumps(indent=2, ensure_ascii=False), csv rows), atomically, under the v2 locks (lock.ts). With
// MIDSTUDY_STRICT=1 library.json is validated against library.schema.json before it is written (contract §0).
import fs from 'node:fs'
import path from 'node:path'

import { MidstudyError, UnexpectedError } from './errors.ts'
import { atomicWrite, exists } from './fsx.ts'
import { out } from './io.ts'
import { withLock } from './lock.ts'
import { costText, csvRow, strip } from './logic/pyformat.ts'
import { dict, dumps, entry, equal, get, int, list, numeric, parse, plain, str } from './logic/pyjson.ts'
import type { PyValue } from './logic/pyjson.ts'
import { decodeUtf8, osError } from './pytext.ts'

const COSTS_HEADER = 'date,id,engine,cost_usd,mock,input'

function strict(): boolean {
  const v = process.env['MIDSTUDY_STRICT']
  return v !== undefined && v !== '' && v !== '0'
}

/** Strict mode's check (contract §0): throws `contract violation: <schema> <path>` when `data` breaks the schema. */
export async function validate(schema: 'midstudy/library.schema.json' | 'midstudy/add-summary.schema.json', data: unknown): Promise<void> {
  if (!strict()) return
  const { violation } = await import('../../contract/gen/validate.js')
  const v = violation(schema, data)
  if (v !== null) throw new MidstudyError(`contract violation: ${v.schema} ${v.path}`)
}

/** The library lock (`<library>/.lock.d`) around `fn`, saying so when another write holds it. */
export async function locked<T>(libDir: string, fn: () => Promise<T>): Promise<T> {
  fs.mkdirSync(libDir, { recursive: true })
  return withLock(path.join(libDir, '.lock.d'), {
    onWait: () => {
      out('midstudy-add: waiting for another library write to finish (<library>/.lock)')
    },
  }, fn)
}

/** v1's `load`: the library (empty when there's none); a file that isn't a version 1 library is refused, never
 *  clobbered. */
export function load(libDir: string): PyValue {
  const file = path.join(libDir, 'library.json')
  if (!exists(file)) return dict([entry('version', int(1)), entry('items', list([]))])
  let text: string
  try {
    const d = decodeUtf8(fs.readFileSync(file))
    if (!d.ok) throw new MidstudyError(`${file} can't be read (${d.error}); fix or move it first`)
    text = d.text
  } catch (e) {
    if (e instanceof MidstudyError) throw e
    throw new MidstudyError(`${file} can't be read (${osError(e, file)}); fix or move it first`)
  }
  const parsed = parse(text)
  if (!parsed.ok) throw new MidstudyError(`${file} can't be read (${parsed.error}); fix or move it first`)
  const data = parsed.value
  const version = get(data, 'version')
  const items = get(data, 'items')
  if (data.kind !== 'dict' || version === undefined || numeric(version) !== 1 || items?.kind !== 'list') {
    throw new MidstudyError(`${file} isn't a version 1 library ({"version": 1, "items": [...]}); fix or move it first`)
  }
  return data
}

/** The library.json text v1 writes. */
function libraryText(data: PyValue): string {
  const d = dumps(data, { indent: 2, ensureAscii: false })
  if (!d.ok) throw new UnexpectedError('ValueError', d.error)
  return `${d.text}\n`
}

/** v1's `upsert`: replaces the item with the entry's id (the first one; later duplicates go) or appends it, writes
 *  library.json, and says whether it replaced one. */
export async function upsert(libDir: string, data: PyValue, item: PyValue): Promise<{ readonly data: PyValue; readonly replaced: boolean }> {
  const id = get(item, 'id') ?? str('')
  const items = get(data, 'items')
  const old = items?.kind === 'list' ? items.items : []
  const matches = old.map((it, i) => (it.kind === 'dict' && equal(get(it, 'id') ?? { kind: 'null' }, id) ? i : -1)).filter((i) => i >= 0)
  const first = matches[0]
  const next = first === undefined ? [...old, item] : old.flatMap((it, i) => (i === first ? [item] : matches.includes(i) ? [] : [it]))
  const out: PyValue = data.kind === 'dict'
    ? dict(data.entries.map((e) => (e.key === 'items' ? entry('items', list(next)) : e)))
    : data
  await validate('midstudy/library.schema.json', plain(out))
  atomicWrite(path.join(libDir, 'library.json'), libraryText(out))
  return { data: out, replaced: first !== undefined }
}

/** v1's `append_cost`: one row (`date,id,engine,cost_usd,mock,input`) under `costs.csv.lock.d`; a missing or blank
 *  file gets the header first. */
export async function appendCost(libDir: string, date: string, id: string, engine: string, cost: number, mock: boolean, source: string): Promise<void> {
  fs.mkdirSync(libDir, { recursive: true })
  const file = path.join(libDir, 'costs.csv')
  await withLock(`${file}.lock.d`, {}, () => {
    let text = ''
    if (exists(file)) {
      const d = decodeUtf8(fs.readFileSync(file))
      if (!d.ok) throw new UnexpectedError('UnicodeDecodeError', d.error)
      text = d.text
    }
    if (strip(text) === '') text = `${COSTS_HEADER}\n`
    else if (!text.endsWith('\n')) text += '\n'
    atomicWrite(file, text + csvRow([date, id, engine, costText(cost), mock ? 'true' : 'false', source]))
    return Promise.resolve()
  })
}
