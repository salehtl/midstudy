// costs.csv (contract §1, §2.9): v1's exact header and rows (Python's csv module, excel dialect, `\n` line ends), and
// the day's total the spend cap reads back (csv.DictReader). Pure (TScert).
import { fmtCost, pyStrip } from './pyfmt.ts'

/** The header v1 and midstudy-add write. */
export const COSTS_HEADER: readonly string[] = ['date', 'id', 'engine', 'cost_usd', 'mock', 'input']

/** One cost row: what was paid (or mocked) for what. */
export interface CostRow {
  /** UTC, `YYYY-MM-DDTHH:MM:SSZ`. */
  readonly date: string
  /** The item, render or page it was for. */
  readonly id: string
  /** `idol`, `render:<model>`, `product:llm`, … */
  readonly engine: string
  readonly costUsd: number
  readonly mock: boolean
  /** What was sent (a scene name, a URL without its query, a file name). */
  readonly input: string
}

/** A field as Python's `csv.writer` (QUOTE_MINIMAL) writes it: quoted when it holds `,`, `"`, `\r` or `\n`, quotes
 *  doubled. */
export function csvField(v: string): string {
  if (!/[,"\r\n]/.test(v)) return v
  return '"' + v.replace(/"/g, '""') + '"'
}

/** One record, `\n`-terminated (`csv.writer(..., lineterminator="\n").writerow`). */
export function csvLine(fields: readonly string[]): string {
  return fields.map(csvField).join(',') + '\n'
}

/** The fields of a cost row as v1 wrote them: `fmt_cost` for the amount, `true`/`false` for mock. */
export function costFields(row: CostRow): string[] {
  return [row.date, row.id, row.engine, fmtCost(row.costUsd), row.mock ? 'true' : 'false', row.input]
}

/** costs.csv after appending `row` (v1 `_append_cost`): a missing or blank file gets the header first, and a file
 *  whose last line has no line end gets one. `existing` is null when the file doesn't exist. */
export function costsText(existing: string | null, row: CostRow): string {
  let text = existing ?? ''
  if (pyStrip(text) === '') text = csvLine(COSTS_HEADER)
  else if (!text.endsWith('\n')) text += '\n'
  return text + csvLine(costFields(row))
}

/** Python's `csv.reader` (excel dialect, not strict) over a whole text: records end at `\r\n`, `\n` or `\r` outside
 *  quotes; `""` inside quotes is a quote; text after a closing quote joins the field; an empty line is `[]`. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let afterQuote = false
  let started = false
  let i = 0
  while (i < text.length) {
    const c = text.charAt(i)
    if (quoted) {
      if (c === '"') {
        if (text.charAt(i + 1) === '"') {
          field += '"'
          i += 2
          continue
        }
        quoted = false
        afterQuote = true
        i += 1
        continue
      }
      field += c
      i += 1
      continue
    }
    if (c === ',') {
      row.push(field)
      field = ''
      afterQuote = false
      started = true
      i += 1
      continue
    }
    if (c === '\r' || c === '\n') {
      if (started || field !== '' || afterQuote) row.push(field)
      rows.push(row)
      row = []
      field = ''
      afterQuote = false
      started = false
      i += c === '\r' && text.charAt(i + 1) === '\n' ? 2 : 1
      continue
    }
    if (c === '"' && field === '' && !afterQuote) {
      quoted = true
      started = true
      i += 1
      continue
    }
    field += c
    started = true
    i += 1
  }
  if (quoted || started || field !== '' || afterQuote) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

const PY_FLOAT = /^[+-]?(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?$/
const PY_FLOAT_SPECIAL = /^([+-]?)(inf|infinity|nan)$/i

/** Python's `float(s)` for ASCII text (surrounding whitespace, `_` between digits, `inf`, `nan`), or null where
 *  Python raises ValueError. */
export function pyFloat(s: string): number | null {
  const t = pyStrip(s)
  const special = PY_FLOAT_SPECIAL.exec(t)
  if (special !== null) {
    const name = (special[2] ?? '').toLowerCase()
    if (name === 'nan') return NaN
    return special[1] === '-' ? -Infinity : Infinity
  }
  if (!PY_FLOAT.test(t)) return null
  return parseFloat(t.replace(/_/g, ''))
}

/** The day's total in costs.csv (v1 `spent`): csv.DictReader rows whose `date` starts with `day`, their `cost_usd`
 *  summed in file order (an empty one is 0, an unreadable or non-finite one is skipped). Not rounded. */
export function spentOn(text: string, day: string): number {
  const rows = parseCsv(text)
  const header = rows[0]
  if (header === undefined) return 0
  const dateAt = header.lastIndexOf('date')
  const costAt = header.lastIndexOf('cost_usd')
  let total = 0
  for (const row of rows.slice(1)) {
    if (row.length === 0) continue
    const date = dateAt < 0 ? undefined : row[dateAt]
    if (!(date ?? '').startsWith(day)) continue
    const raw = costAt < 0 ? undefined : row[costAt]
    const cost = raw === undefined || raw === '' ? 0 : pyFloat(raw)
    if (cost === null || !Number.isFinite(cost)) continue
    total += cost
  }
  return total
}
