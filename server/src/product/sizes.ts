// The size reader (core/crates/product, contract §2.11 Mapping, Units, Rugs), built by scripts/build.mjs into
// build/wasm/product/ (Node ESM, loaded through require() as core/js/node.ts loads the media kernels). This is its
// typed face: every answer from the wasm is checked before it is typed (no casts), and v1's exceptions inside the
// size rules (a KeyError on an order key `re.I` matched) come back as PyRaised, which the reader answers as v1 did
// (its generic 422).
//
// Lines of page text cross as one string joined by "\n" (squashed lines never hold one).
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

/** A unit a page measures in. */
export type Unit = 'cm' | 'mm' | 'm' | 'in' | 'ft'
const UNITS: readonly Unit[] = ['cm', 'mm', 'm', 'in', 'ft']

/** What the size rules know about the page (v1's `_Ctx`, without its warnings, which the caller keeps). */
export interface SizeCtx {
  readonly is_rug: boolean
  readonly hint: Unit | null
  readonly is_bed: boolean
}

/** One size reading in cm (v1's `Reading`); `notes` and `h` change after it is made (link variants, rugs). */
export interface Reading {
  readonly w: number
  readonly d: number
  h: number | null
  readonly unit: Unit
  label: string | null
  readonly unit_note: string | null
  notes: string[]
  quote: string
  readonly source: string
}

/** One part of a size: v1's `(axis, value, unit, text[, to])`. */
export interface Part {
  readonly axis: string | null
  readonly value: number
  readonly unit: Unit | null
  readonly text: string
  readonly to?: number | null
}

/** A reading attempt: the reading, and whether v1 would have warned that a size without a unit was left out. */
export interface Made {
  readonly reading: Reading | null
  readonly dropped_unitless: boolean
}

/** One `dims_candidates` entry (v1's `Reading.out()`). */
export interface ReadingOut {
  readonly w: number
  readonly d: number
  readonly h: number | null
  readonly unit: Unit
  readonly label: string | null
  readonly unit_note: string | null
  readonly notes: readonly string[]
  readonly quote: string
  readonly source: string
}

/** The answer's sizes. */
export interface Finished {
  readonly dims_candidates: readonly ReadingOut[]
  readonly variant_index: readonly (number | null)[]
  readonly thickness_used: boolean
}

/** One measurement on a line (for tests). */
export interface ItemView {
  readonly start: number
  readonly end: number
  readonly value: number
  readonly unit: Unit | null
  readonly axis: string | null
  readonly num_text: string
  readonly to: number | null
}

/** An exception v1 raised inside its size rules (v1's read() answered its generic 422). */
export class PyRaised extends Error {
  constructor(name: string) {
    super(name)
    this.name = 'PyRaised'
  }
}

// --- loading ---------------------------------------------------------------------------------------------------------

interface Raw {
  call(op: string, input: string): string
  has_size(text: string): boolean
  matches(kind: string, text: string): boolean
  category_of(text: string): string | undefined
}

function isRaw(m: unknown): m is Raw {
  if (typeof m !== 'object' || m === null) return false
  return ['call', 'has_size', 'matches', 'category_of'].every((k) => typeof Reflect.get(m, k) === 'function')
}

/** Where the build puts the module (repo root /build/wasm/product/), relative to this file. */
const WASM_MODULE = fileURLToPath(new URL('../../../build/wasm/product/midstudy_wasm_product.js', import.meta.url))

let loaded: Raw | null = null

function raw(): Raw {
  if (loaded !== null) return loaded
  const mod: unknown = createRequire(import.meta.url)(WASM_MODULE)
  if (!isRaw(mod)) throw new Error(`server/src/product/sizes.ts: ${WASM_MODULE} doesn't export the size reader: run npm run build`)
  loaded = mod
  return mod
}

// --- checking what comes back ------------------------------------------------------------------------------------------

function field(o: unknown, k: string): unknown {
  return typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined
}

function isUnit(v: unknown): v is Unit {
  return typeof v === 'string' && UNITS.some((u) => u === v)
}

function str(v: unknown): string {
  if (typeof v !== 'string') throw new Error('size reader: expected a string')
  return v
}

function num(v: unknown): number {
  if (typeof v !== 'number') throw new Error('size reader: expected a number')
  return v
}

function optNum(v: unknown): number | null {
  return v === null || v === undefined ? null : num(v)
}

function optStr(v: unknown): string | null {
  return v === null || v === undefined ? null : str(v)
}

function unit(v: unknown): Unit {
  if (!isUnit(v)) throw new Error('size reader: expected a unit')
  return v
}

function optUnit(v: unknown): Unit | null {
  return v === null || v === undefined ? null : unit(v)
}

function strings(v: unknown): string[] {
  if (!Array.isArray(v)) throw new Error('size reader: expected a list')
  return v.map(str)
}

function list(v: unknown): readonly unknown[] {
  if (!Array.isArray(v)) throw new Error('size reader: expected a list')
  const out: unknown[] = v
  return out
}

function reading(v: unknown): Reading {
  return {
    w: num(field(v, 'w')), d: num(field(v, 'd')), h: optNum(field(v, 'h')), unit: unit(field(v, 'unit')),
    label: optStr(field(v, 'label')), unit_note: optStr(field(v, 'unit_note')), notes: strings(field(v, 'notes')),
    quote: str(field(v, 'quote')), source: str(field(v, 'source')),
  }
}

function item(v: unknown): ItemView {
  return {
    start: num(field(v, 'start')), end: num(field(v, 'end')), value: num(field(v, 'value')), unit: optUnit(field(v, 'unit')),
    axis: optStr(field(v, 'axis')), num_text: str(field(v, 'num_text')), to: optNum(field(v, 'to')),
  }
}

/** One op; v1's exceptions as PyRaised, anything else (a bug here) as an Error. */
function call(op: string, input: unknown): unknown {
  const out: unknown = JSON.parse(raw().call(op, JSON.stringify(input)))
  const err = field(out, 'error')
  if (typeof err === 'string') {
    if (err === 'KeyError') throw new PyRaised(err)
    throw new Error(`size reader ${op}: ${err}`)
  }
  return out
}

function made(v: unknown): Made {
  const r = field(v, 'reading')
  return { reading: r === null || r === undefined ? null : reading(r), dropped_unitless: field(v, 'dropped_unitless') === true }
}

const joinLines = (lines: readonly string[]): string => lines.join('\n')

// --- the reader ------------------------------------------------------------------------------------------------------

/** v1's `_HAS_SIZE.search(text)`. */
export function hasSize(text: string): boolean {
  return raw().has_size(text)
}

/** One of v1's word patterns, with Python's `\b`: distractors (box, seat…), introductions (overall…), samples, size
 *  options, size words (the model's text), robot checks. */
export function matches(kind: 'distract' | 'intro' | 'sample' | 'size_opt' | 'size_words' | 'robot', text: string): boolean {
  return raw().matches(kind, text)
}

/** v1's `_category_of`. */
export function categoryOf(text: string): string | null {
  return raw().category_of(text) ?? null
}

/** v1's `_parse_size_text` on text already unescaped, cut to 2000 characters and squashed. */
export function parseSizeText(text: string, ctx: SizeCtx, source: string, label: string | null, pairOk: boolean, warnUnitless: boolean): Made {
  return made(call('parse_size_text', { text, ctx, source, label, pair_ok: pairOk, warn_unitless: warnUnitless }))
}

/** v1's `_make_reading`. */
export function makeReading(parts: readonly Part[], ctx: SizeCtx, source: string, quote: string, label: string | null, pairOk: boolean, warnUnitless: boolean): Made {
  return made(call('make_reading', { parts, ctx, source, quote, label, pair_ok: pairOk, warn_unitless: warnUnitless }))
}

/** The first measurement of a squashed structured value (v1's `_single` on a string): [value, unit, the number as
 *  written], or null. */
export function firstItem(text: string): readonly [number, Unit | null, string] | null {
  const v = call('first_item', { text })
  if (v === null) return null
  const [value, u, t] = list(v)
  return [num(value), optUnit(u), str(t)]
}

/** v1's `_text_readings`. */
export function textReadings(lines: readonly string[], ctx: SizeCtx): Reading[] {
  return list(field(call('text_readings', { lines: joinLines(lines), ctx }), 'readings')).map(reading)
}

/** v1's `_unit_hint`. */
export function unitHint(lines: readonly string[]): Unit | null {
  return optUnit(call('unit_hint', { lines: joinLines(lines) }))
}

/** A rug's thickness from the page: [cm, v1's note], or null. */
export function thickness(lines: readonly string[], hint: Unit | null): readonly [number, string] | null {
  const v = call('thickness', { lines: joinLines(lines), hint })
  if (v === null) return null
  const [cm, note] = list(v)
  return [num(cm), str(note)]
}

/** v1's `_llm_text`. */
export function llmText(lines: readonly string[]): string {
  return str(call('llm_text', { lines: joinLines(lines) }))
}

/** v1's `_quote_numbers`. */
export function quoteNumbers(quote: string): number[] {
  return list(call('quote_numbers', { text: quote })).map(num)
}

/** The end of v1's `_extract`: a rug's thickness, the merge, `out()`, each option's `dims_index`. */
export function finish(variants: readonly (Reading | null)[], cands: readonly Reading[], isRug: boolean, thick: readonly [number, string] | null): Finished {
  const v = call('finish', { variants, cands, is_rug: isRug, thick })
  return {
    dims_candidates: list(field(v, 'dims_candidates')).map(reading),
    variant_index: list(field(v, 'variant_index')).map(optNum),
    thickness_used: field(v, 'thickness_used') === true,
  }
}

/** v1's `_num`. */
export function pyNum(text: string): number | null {
  return optNum(call('num', { text }))
}

/** v1's `_unit`. */
export function unitOf(text: string): Unit | null {
  return optUnit(call('unit', { text }))
}

/** v1's `_axis`. */
export function axisOf(text: string): string | null {
  return optStr(call('axis', { text }))
}

/** v1's `_fmt`. */
export function fmtNum(value: number): string {
  return str(call('fmt', { value }))
}

/** v1's `_line_chains` (tests and diagnostics). */
export function lineChains(text: string): ItemView[][] {
  return list(field(call('line_chains', { text }), 'chains')).map((c) => list(c).map(item))
}

/** v1's `_items` (tests and diagnostics). */
export function items(text: string): ItemView[] {
  return list(call('items', { text })).map(item)
}
