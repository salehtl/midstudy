// The Rust size reader (core/crates/product through build/wasm/product) against v1's own Python (planner/product_page.py)
// on generated size strings: every item, chain, reading, hint, thickness, number, unit and word pattern must be the same,
// including v1's exceptions. The strings are built from the pieces shops write (numbers, fractions, units, labels in six
// languages, order keys, ranges, distractors) and the characters where Python's `re` differs from other engines (\u{17f}, K,
// \u{131}, \u{130}, \u{b2}, Arabic-Indic digits, U+001C, NBSP). Seeded: a failure prints its seed and string.
//
// node --test server/test/product/sizes.test.ts      (MIDSTUDY_PRODUCT_CASES=n for more; needs npm run build)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as sizes from '../../src/product/sizes.ts'
import { squash } from '../../src/product/logic/text.ts'
import { askV1, oracleAvailable, prng, same } from './oracle.ts'

const CASES = Number(process.env['MIDSTUDY_PRODUCT_CASES'] ?? 3000)
const SEED = Number(process.env['MIDSTUDY_PRODUCT_SEED'] ?? 20261106)

const NUMS = ['80', '120', '7', '0', '00', '3', '31 1/2', '41 \u{be}', '1/2', '\u{bd}', '80,5', '80.5', '1,200', '12345678', '\u{668}\u{660}',
  '2.', '3-1/2', '200', '90', '85', '12 / 3', '1 \u{2044} 4', '0.25', '9999', '160', '230', '5', '6', '10', '11', '62.25', '1.5', '7\u{a0}\u{bd}',
  '1234', '45', '55', '2000', '2001', '0.1', '0,5', '33 1/3', '6 1/2', '100', '1,5', '12.3456', '12.34567', '7 1/0']
const UNITS = ['cm', 'cms', 'CM', 'mm', 'm', 'M', 'metres', 'meter', 'Meters', 'in', 'in.', 'inch', 'inches', 'Inches', '"', '\u{2033}', '\u{201d}',
  "''", "'", '\u{2032}', '\u{2019}', '\u{2032}\u{2032}', 'ft', 'ft.', 'feet', 'foot', 'm\u{b2}', 'cmx', 'Cm', 'centimetres', 'millimeters', 'inchs', 'mtr']
const SEPS = [' x ', 'x', ' X ', ' \u{d7} ', '\u{d7}', '*', ' by ', ' x B ', ' x T: ', ' - ', ', ', ' / ', '; ', '  ', ' to ', '\u{2013}', '\u{2014}',
  '-', ' ', ' ', ' ', '\t', ' x\u{a0}', ' x W ', ' and ']
const LABELS = ['W', 'D', 'H', 'L', 'w', 'h', 'd', 'l', 'Width', 'Depth:', 'Height =', 'Length', 'Overall Width', 'overall  depth', 'Dia', 'Dia.',
  'diam', '\u{d8}', '\u{f8}', 'diameter', 'Breite', 'H\u{f6}he', 'HOEHE', 'Tiefe', 'profondit\u{e0}', 'largeur', 'Hauteur', 'ancho', 'alto',
  'altura', 'fondo', 'w\u{131}dth', 'W:', 'H.', 'D=', 'Width: ', 'Overall Height:']
const POSTS = ['W', 'D', 'H', 'L', '(W)', '( D )', 'wide', 'deep', 'high', 'tall', 'long', 'H:', 'Dia', 'w.', 'H ', ' W', 'h)', 'width']
const WORDS = ['Dimensions:', 'Overall', 'Box', 'Seat height', 'Package', 'Assembled', 'Product size', 'approx', 'Approx.', 'Thickness:',
  'Pile height:', 'pile', 'thick', 'in thickness', 'rug', 'Size', 'in cm', '(cm)', '(m)', '(in)', 'en cm', 'shelf depth', 'drawer', 'and',
  'the', 'Oak', 'Sofa', '\u{212a}', '\u{131}', '\u{b2}', '.', ';', '!', '\u{2022}', '\u{b7}', ':', '(', ')', 'W x D x H', '(H x W x D)',
  'HxWxD:', 'L x W x H in cm', 'B x T x H', '(W x D)', '\u{a0}', 'dimension', 'Total height', 'rug height', 'Height:', '\u{17f}ize', 'seat',
  'Arms', 'interior', 'per shelf', 'cushions', 'Box:', 'Gr\u{f6}\u{df}e', 'size', 'Measurements', 'x', '\u001c', '/', '\\', '_', '\u{2019}s',
  'Ships in', 'Dimensions (Overall):', 'Inches (H)', 'Inches (W)', 'IN', 'from', 'up to', 'BEDSIDE TABLE', 'sofa bed', 'Desk Lamp']

function pick<T>(r: () => number, xs: readonly T[]): T {
  const v = xs[Math.floor(r() * xs.length)]
  if (v === undefined) throw new Error('empty list')
  return v
}

/** One generated line: a few sizes-like runs among words. */
function line(r: () => number): string {
  let s = ''
  const n = 1 + Math.floor(r() * 9)
  for (let i = 0; i < n; i++) {
    const k = r()
    if (k < 0.3) {
      // a size: [label] num [unit] [post] (sep num ...)
      const parts = 1 + Math.floor(r() * 3)
      for (let j = 0; j < parts; j++) {
        if (j > 0) s += pick(r, SEPS)
        if (r() < 0.3) s += pick(r, LABELS) + (r() < 0.5 ? ' ' : '')
        if (r() < 0.12) s += pick(r, NUMS) + pick(r, ["' ", "'", '\u{2032} ', ' ft ']) + pick(r, NUMS) + pick(r, ['"', '\u{2033}', ' in', 'in'])
        else s += pick(r, NUMS)
        if (r() < 0.15) s += pick(r, ['\u{2013}', ' to ', '-', ' - ']) + pick(r, NUMS)
        if (r() < 0.5) s += (r() < 0.6 ? ' ' : '') + pick(r, UNITS)
        if (r() < 0.25) s += (r() < 0.5 ? ' ' : '') + pick(r, POSTS)
      }
    } else if (k < 0.85) {
      s += pick(r, WORDS)
    } else {
      s += pick(r, NUMS)
    }
    s += pick(r, [' ', ' ', ' ', '', ': ', ', ', '. ', '  '])
  }
  return s
}

const CTXS: readonly sizes.SizeCtx[] = [
  { is_rug: false, hint: null, is_bed: false },
  { is_rug: true, hint: null, is_bed: false },
  { is_rug: false, hint: 'm', is_bed: false },
  { is_rug: false, hint: 'in', is_bed: true },
  { is_rug: true, hint: 'cm', is_bed: false },
]

/** v2's answer for one request, in the oracle's shape ({ok} or {raised}). */
function v2(req: Readonly<Record<string, unknown>>): unknown {
  try {
    const text = String(req['text'] ?? '')
    const lines = Array.isArray(req['lines']) ? req['lines'].map(String) : []
    const ctxIndex = Number(req['ctxIndex'] ?? 0)
    const ctx = CTXS[ctxIndex] ?? { is_rug: false, hint: null, is_bed: false }
    switch (req['op']) {
      case 'line_chains': return { ok: sizes.lineChains(text) }
      case 'items': return { ok: sizes.items(text) }
      case 'has_size': return { ok: sizes.hasSize(text) }
      case 'quote_numbers': return { ok: sizes.quoteNumbers(text) }
      case 'category': return { ok: sizes.categoryOf(text) }
      case 'matches': return { ok: sizes.matches(String(req['kind']) === 'robot' ? 'robot' : String(req['kind']) === 'intro' ? 'intro' : String(req['kind']) === 'sample' ? 'sample' : String(req['kind']) === 'size_opt' ? 'size_opt' : String(req['kind']) === 'size_words' ? 'size_words' : 'distract', text) }
      case 'num': return { ok: sizes.pyNum(text) }
      case 'unit': return { ok: sizes.unitOf(text) }
      case 'axis': return { ok: sizes.axisOf(text) }
      case 'parse_size_text': {
        const m = sizes.parseSizeText(squash(text), ctx, 'jsonld', null, req['pair_ok'] === true, req['warn_unitless'] === true)
        return { ok: m }
      }
      case 'text_readings': return { ok: sizes.textReadings(lines.map(squash), ctx) }
      case 'unit_hint': return { ok: sizes.unitHint(lines.map(squash)) }
      case 'thickness': return { ok: sizes.thickness(lines.map(squash), ctx.hint) }
      case 'llm_text': return { ok: sizes.llmText(lines) }
      default: throw new Error(`op ${String(req['op'])}`)
    }
  } catch (e) {
    if (e instanceof sizes.PyRaised) return { raised: e.message }
    throw e
  }
}

/** The oracle's request for one v2 request (contexts as v1's `_Ctx` fields). */
function forV1(req: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const ctx = CTXS[Number(req['ctxIndex'] ?? 0)]
  const out: Record<string, unknown> = { ...req, ctx }
  if (req['op'] === 'thickness') out['hint'] = ctx?.hint ?? null
  if (req['op'] === 'text_readings' || req['op'] === 'unit_hint' || req['op'] === 'thickness') {
    out['lines'] = Array.isArray(req['lines']) ? req['lines'].map((l) => squash(String(l))) : []
  }
  if (req['op'] === 'parse_size_text') {
    out['source'] = 'jsonld'
    out['label'] = null
  }
  return out
}

test('generated size strings: v2 reads exactly what v1 read', { skip: !oracleAvailable() }, async () => {
  const r = prng(SEED)
  const reqs: Record<string, unknown>[] = []
  for (let i = 0; i < CASES; i++) {
    const s = line(r)
    const ctxIndex = Math.floor(r() * CTXS.length)
    reqs.push({ op: 'line_chains', text: s }, { op: 'items', text: s }, { op: 'has_size', text: s }, { op: 'quote_numbers', text: s })
    reqs.push({ op: 'parse_size_text', text: s, ctxIndex, pair_ok: r() < 0.5, warn_unitless: r() < 0.5 })
    reqs.push({ op: 'category', text: s }, { op: 'matches', kind: pick(r, ['distract', 'intro', 'sample', 'size_opt', 'size_words', 'robot']), text: s })
    if (i % 3 === 0) {
      const lines = Array.from({ length: 1 + Math.floor(r() * 6) }, () => line(r))
      reqs.push({ op: 'text_readings', lines, ctxIndex }, { op: 'unit_hint', lines }, { op: 'thickness', lines, ctxIndex }, { op: 'llm_text', lines })
    }
  }
  for (const t of [...NUMS, ...UNITS, ...LABELS, ...POSTS, ' 80 ', '\u{a0}80\u{a0}', '1/0', 'x', '', ' in. ', 'Metre.', 'OVERALL  WIDTH']) {
    reqs.push({ op: 'num', text: t }, { op: 'unit', text: t }, { op: 'axis', text: t })
  }
  const want = await askV1(reqs.map(forV1))
  const diffs: string[] = []
  const counts = new Map<string, number>()
  // how much of it says something (not vacuous): chains found, readings made, v1 exceptions
  const said = new Map<string, number>()
  const note = (k: string): void => {
    said.set(k, (said.get(k) ?? 0) + 1)
  }
  reqs.forEach((req, i) => {
    const op = String(req['op'])
    counts.set(op, (counts.get(op) ?? 0) + 1)
    const answer = want[i]
    if (answer !== undefined && 'raised' in answer) note(`raised ${answer.raised}`)
    else if (answer !== undefined) {
      const v = answer.ok
      if (op === 'line_chains' && Array.isArray(v) && v.some((c) => Array.isArray(c) && c.length >= 2)) note('lines with a chain of 2-3')
      if (op === 'parse_size_text' && typeof v === 'object' && v !== null && Reflect.get(v, 'reading') !== null) note('size texts read')
      if (op === 'parse_size_text' && typeof v === 'object' && v !== null && Reflect.get(v, 'dropped_unitless') === true) note('unitless warnings')
      if (op === 'text_readings' && Array.isArray(v) && v.length > 0) note('line groups with text readings')
      if (op === 'thickness' && v !== null) note('thicknesses')
      if (op === 'has_size' && v === true) note('has_size true')
    }
    const got = v2(req)
    const exp = want[i]
    const expV = exp !== undefined && 'ok' in exp ? { ok: exp.ok } : { raised: exp?.raised }
    if (!same(got, expV)) diffs.push(`seed ${String(SEED)} #${String(i)} ${op} ${JSON.stringify(req)}\n  v1: ${JSON.stringify(expV)}\n  v2: ${JSON.stringify(got)}`)
  })
  console.log(`size strings: ${String(reqs.length)} requests (${[...counts].map(([k, v]) => `${k} ${String(v)}`).join(', ')}), ${String(diffs.length)} differences`)
  console.log(`  of which: ${[...said].map(([k, v]) => `${k} ${String(v)}`).join(', ')}`)
  assert.equal(diffs.length, 0, diffs.slice(0, 8).join('\n'))
})
