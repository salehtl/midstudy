// The library entry and the summary line of an add or a refit (contract §3.1, §3.4; add-summary.schema.json), built
// as v1 built them, key for key and with Python's ints and floats. Pure (functional core).

import { NULL, bool, dict, entry, float, int, str } from './pyjson.ts'
import type { PyEntry, PyValue } from './pyjson.ts'
import { num } from './pyformat.ts'

export interface ItemFields {
  readonly id: string
  readonly name: string
  readonly category: string | null
  readonly w: number
  readonly d: number
  readonly h: number
  readonly splat: boolean
  readonly thumb: boolean
  readonly engine: string
  readonly sourceInput: string
  readonly prompt: string | null
  readonly cost: number
  readonly mock: boolean
  readonly created: string
  readonly glbFit: PyValue
  readonly splatFit: PyValue | null
  readonly notes: string | null
  readonly mount: string | null
}

function opt(s: string | null): PyValue {
  return s === null ? NULL : str(s)
}

/** `{"w": num(w), "d": num(d), "h": num(h)}`. */
export function dimsCm(w: number, d: number, h: number): PyValue {
  return dict([entry('w', num(w)), entry('d', num(d)), entry('h', num(h))])
}

/** `{"glb_error_pct": …, "splat_error_pct": … | None}`. */
export function fitValue(glbFit: PyValue, splatFit: PyValue | null): PyValue {
  return dict([entry('glb_error_pct', glbFit), entry('splat_error_pct', splatFit ?? NULL)])
}

/** v1's library entry for an add. */
export function itemEntry(f: ItemFields): PyValue {
  const entries: PyEntry[] = [
    entry('id', str(f.id)),
    entry('name', str(f.name)),
    entry('category', opt(f.category)),
    entry('dims_cm', dimsCm(f.w, f.d, f.h)),
    entry('assets', dict([
      entry('glb', str(`${f.id}/model.glb`)),
      entry('splat', f.splat ? str(`${f.id}/splat.ply`) : NULL),
      entry('spz', f.splat ? str(`${f.id}/splat.spz`) : NULL),
      entry('thumb', f.thumb ? str(`${f.id}/thumb.jpg`) : NULL),
    ])),
    entry('default_render', str(f.splat ? 'splat' : 'glb')),
    entry('source', dict([
      entry('engine', str(f.engine)),
      entry('input', str(f.sourceInput)),
      entry('prompt', f.engine === 'sam3d' ? opt(f.prompt) : NULL),
      entry('cost_usd', float(f.cost)),
      entry('mock', bool(f.mock)),
      entry('created', str(f.created)),
    ])),
    entry('fit', fitValue(f.glbFit, f.splatFit)),
    entry('notes', opt(f.notes)),
  ]
  if (f.mount !== null && f.mount !== '') entries.push(entry('mount', str(f.mount)))
  return dict(entries)
}

export interface SummaryPaths {
  readonly library: string
  readonly item: string
  readonly glb: string
  readonly splat: string | null
  readonly spz: string | null
  readonly thumb: string | null
  readonly source: string | null
  readonly raw: string | null
  readonly costs: string
}

/** The last stdout line (add-summary.schema.json): `cost` is v1's float for an add and its int 0 for a refit. */
export function summary(id: string, engine: string, cost: number | 'int-zero', mock: boolean, p: SummaryPaths, fit: PyValue): PyValue {
  return dict([
    entry('id', str(id)),
    entry('engine', str(engine)),
    entry('cost_usd', cost === 'int-zero' ? int(0) : float(cost)),
    entry('mock', bool(mock)),
    entry('paths', dict([
      entry('library', str(p.library)),
      entry('item', str(p.item)),
      entry('glb', str(p.glb)),
      entry('splat', opt(p.splat)),
      entry('spz', opt(p.spz)),
      entry('thumb', opt(p.thumb)),
      entry('source', opt(p.source)),
      entry('raw', opt(p.raw)),
      entry('costs', str(p.costs)),
    ])),
    entry('fit', fit),
  ])
}
