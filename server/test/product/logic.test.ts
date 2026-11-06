// The TypeScript halves of the reader against v1's own Python, on generated input: html.unescape, _squash, json.loads
// (strict and not, with Python's int/float, key order, NaN and its nesting limit), _loads_lenient, _literals,
// _js_unescape, and the model's system prompt word for word.
//
// node --test server/test/product/logic.test.ts      (needs the dev shell's Python 3.12)
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { pyFloatRepr } from '../../../common/logic/pyfmt.ts'
import { unescape } from '../../src/product/doc.ts'
import { SYSTEM_PROMPT } from '../../src/product/llm.ts'
import { isDict, isList } from '../../src/product/logic/py.ts'
import { PyJsonError, loadsLenient, pyLoads, type PyValue } from '../../src/product/logic/pyjson.ts'
import { squash } from '../../src/product/logic/text.ts'
import { jsUnescape, literals } from '../../src/product/scripts.ts'
import { askV1, oracleAvailable, prng, same } from './oracle.ts'

const CASES = Number(process.env['MIDSTUDY_PRODUCT_CASES'] ?? 3000)
const SEED = Number(process.env['MIDSTUDY_PRODUCT_SEED'] ?? 20261106)

function pick<T>(r: () => number, xs: readonly T[]): T {
  const v = xs[Math.floor(r() * xs.length)]
  if (v === undefined) throw new Error('empty list')
  return v
}

/** A PyValue in the oracle's tagged form. */
function tagged(v: PyValue): unknown {
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'bigint') return { int: v.toString() }
  if (typeof v === 'number') return { float: pyFloatRepr(v) }
  if (isList(v)) return v.map(tagged)
  if (isDict(v)) return { dict: [...v.entries()].map(([k, x]) => [k, tagged(x)]) }
  return null
}

const ENTITY_BITS = ['&amp;', '&amp', '&AMP;', '&lt', '&notit;', '&not', '&#65;', '&#65', '&#x41;', '&#X1F600;', '&#0;', '&#128;', '&#x80;', '&#55296;',
  '&#1114112;', '&#xFFFF;', '&#1;', '&nbsp;', '&times', '&copy=', '&#;', '&#x;', '&;', '& ', '&&', '&zz;', '&ThickSpace;', '&frac12',
  '&' + 'a'.repeat(40) + ';', 'x', ' ', '\u{1f600}', '<', '#', ';', '\t', '\u{a0}', '\u{200b}', '\u{1c}', 'W 80 cm', '\n']
const JSON_BITS = ['{', '}', '[', ']', ',', ':', '"a"', '"a\\u0041"', '"\\ud83d\\ude00"', '"\\ud83d"', '"\\x"', '"\t"', '"\u{1}"', '1', '-0', '1.0',
  '1e400', '-1.5e-3', '01', '.5', 'NaN', 'Infinity', '-Infinity', 'true', 'false', 'null', ' ', '\n', '"\\""', '"k"', '1E2', '123456789012345678901234567890',
  '\u{feff}', 'nul', '"\\/"', '"\\b\\f\\n\\r\\t"']
const SCRIPT_BITS = ['"', "'", '\\"', "\\'", '\\\\', '\\n', '\\u0041', '\\x41', '\\u12', '\\', '\n', 'abc', ' 80 x 40 cm ', 'x', '\u{1f600}', 'var s = ']

void test('the TypeScript parts read as v1 read', { skip: !oracleAvailable() }, async () => {
  const r = prng(SEED)
  const reqs: Record<string, unknown>[] = []
  for (let i = 0; i < CASES; i++) {
    const n = 1 + Math.floor(r() * 10)
    const html = Array.from({ length: n }, () => pick(r, ENTITY_BITS)).join('')
    reqs.push({ op: 'unescape', text: html }, { op: 'squash', text: html })
    // JSON: mostly well formed (a random nested value), sometimes broken
    const parts: string[] = []
    const depth = Math.floor(r() * 4)
    for (let d = 0; d < depth; d++) parts.push(pick(r, ['[', '{"k": ']))
    parts.push(pick(r, JSON_BITS))
    for (let d = depth - 1; d >= 0; d--) parts.push(parts[d] === '[' ? ']' : '}')
    if (r() < 0.3) parts.splice(Math.floor(r() * parts.length), 0, pick(r, JSON_BITS))
    const json = parts.join(r() < 0.5 ? '' : ' ')
    reqs.push({ op: 'loads', text: json, strict: r() < 0.5 }, { op: 'loads_lenient', text: (r() < 0.2 ? '<!--' : '') + json + pick(r, ['', ';', ',]', '-->', ', }']) })
    const script = Array.from({ length: n }, () => pick(r, SCRIPT_BITS)).join('')
    reqs.push({ op: 'literals', text: script }, { op: 'js_unescape', text: script })
  }
  // Python's C recursion limit: v1's json.loads gave up near 10,000 levels (RecursionError); the exact level moves by a
  // few with the caller's own depth, so the oracle is asked well inside and well outside it (only ok-or-not compared)
  reqs.push({ op: 'loads', text: '['.repeat(9000) + ']'.repeat(9000), strict: true, deep: true }, { op: 'loads', text: '{"a":'.repeat(9000) + '1' + '}'.repeat(9000), strict: true, deep: true },
    { op: 'loads', text: '['.repeat(10100) + ']'.repeat(10100), strict: true, deep: true }, { op: 'loads', text: '['.repeat(200000) + ']'.repeat(200000), strict: false, deep: true })
  reqs.push({ op: 'system_prompt' })
  const want = await askV1(reqs)
  const diffs: string[] = []
  reqs.forEach((req, i) => {
    const text = typeof req['text'] === 'string' ? req['text'] : ''
    let got: unknown
    switch (req['op']) {
      case 'unescape': got = { ok: unescape(text) }; break
      case 'squash': got = { ok: squash(text) }; break
      case 'loads':
        try {
          const v = pyLoads(text, req['strict'] === true)
          got = { ok: req['deep'] === true ? 'parsed' : tagged(v) }
        } catch (e) {
          got = { raised: e instanceof PyJsonError ? 'error' : String(e) }
        }
        break
      case 'loads_lenient': got = { ok: tagged(loadsLenient(text)) }; break
      case 'literals': got = { ok: literals(text) }; break
      case 'js_unescape': got = { ok: jsUnescape(text) }; break
      case 'system_prompt': got = { ok: SYSTEM_PROMPT }; break
      default: got = null
    }
    const exp = want[i]
    // v1 raised JSONDecodeError (a ValueError) or RecursionError: both are "not JSON" to its callers
    const expV = exp !== undefined && 'ok' in exp ? { ok: req['deep'] === true ? 'parsed' : exp.ok } : { raised: 'error' }
    if (!same(got, expV)) diffs.push(`#${String(i)} ${String(req['op'])} ${JSON.stringify(text).slice(0, 120)}\n  v1: ${JSON.stringify(expV).slice(0, 300)}\n  v2: ${JSON.stringify(got).slice(0, 300)}`)
  })
  console.log(`logic: ${String(reqs.length)} requests, ${String(diffs.length)} differences`)
  assert.equal(diffs.length, 0, diffs.slice(0, 8).join('\n'))
})
