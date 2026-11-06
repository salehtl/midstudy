// The pure logic of midstudy-add (pipeline/src/logic/) against what v1's Python does: every expected value below was
// printed by Python 3.12 (json, argparse, str formatting, csv) or by v1's own functions on 2026-11-06.
//
//   nix develop -c node --test pipeline/test/logic.test.ts
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { HELP, parseArgs } from '../src/logic/args.ts'
import { itemEntry, summary } from '../src/logic/entry.ts'
import { errorsPct, glbSelfCheck, itemFrame, spzLine, splatSelfCheck } from '../src/logic/fit.ts'
import { IDENTITY, mul3, orientation, quatXyzw, sam3dSplatToGlb, yawRotation } from '../src/logic/frames.ts'
import { costUsd, engineArguments, isSlug, mockSlug, parseDims, quote, slugify, urlPath, withMask, withThreshold } from '../src/logic/inputs.ts'
import { isStale, ownerFrom, sameOwner } from '../src/logic/lock.ts'
import { costText, csvRow, fixed, general, oneLine, percent, pyFloat, pyRound, repr, strip, thousands } from '../src/logic/pyformat.ts'
import { NULL, dumps, float, floatRepr, parse, str } from '../src/logic/pyjson.ts'
import type { PyValue } from '../src/logic/pyjson.ts'
import { join, name, normalize, parent, suffix, withName } from '../src/logic/pypath.ts'

const MATH = { sqrt: Math.sqrt, cos: Math.cos, sin: Math.sin }

function text(v: PyValue, indent: number | null = null, ensureAscii = true): string {
  const d = dumps(v, { indent, ensureAscii, allowNan: true })
  assert.ok(d.ok)
  return d.text
}

function parsed(s: string): PyValue {
  const p = parse(s)
  assert.ok(p.ok, s)
  return p.value
}

void test('floats print as Python repr', () => {
  const vals = [0.0, -0.0, 1.0, 0.1, 0.30000000000000004, 1e16, 1.5e16, 1e-5, 0.0001, 123456789.123, 2.5, 0.5, 1.25, -1.005, 1e22, 5e-324]
  const want = ['0.0', '-0.0', '1.0', '0.1', '0.30000000000000004', '1e+16', '1.5e+16', '1e-05', '0.0001', '123456789.123', '2.5', '0.5', '1.25', '-1.005', '1e+22', '5e-324']
  assert.deepEqual(vals.map(floatRepr), want)
})

void test('%.Nf, :.N%, :g, round(), :, and str.strip() as Python', () => {
  assert.deepEqual([0.125, 0.375, 2.675, 1.005, 0.1, -0.5, 0.5, 1.5, 2.5, 1e20, 3.14159].map((v) => fixed(v, 2)),
    ['0.12', '0.38', '2.67', '1.00', '0.10', '-0.50', '0.50', '1.50', '2.50', '100000000000000000000.00', '3.14'])
  assert.deepEqual([0.0123, 0.05, 0.12345, 1.0].map((v) => percent(v, 1)), ['1.2%', '5.0%', '12.3%', '100.0%'])
  assert.deepEqual([160.0, 75.5, 0.0001, 123456.0, 1234567.0, 1e-5, 2.5, 100.0, 0.1, 1e16].map(general),
    ['160', '75.5', '0.0001', '123456', '1.23457e+06', '1e-05', '2.5', '100', '0.1', '1e+16'])
  assert.deepEqual([0.0005, 0.0015, 1.2345, 2.675, -0.0005].map((v) => pyRound(v, 3)), [0.001, 0.002, 1.234, 2.675, -0.001])
  assert.deepEqual([0, 999, 1000, 262144, 1234567].map(thousands), ['0', '999', '1,000', '262,144', '1,234,567'])
  assert.deepEqual(['  x  ', '\x1c y \x1f', ' ​ z'].map(strip), ['x', 'y', '​ z'])
  assert.equal(oneLine('a b  c\n d'), 'a b c d')
  assert.deepEqual([0.1, 0.02, 0.0398, 0, 0.25].map(costText), ['0.1', '0.02', '0.0398', '0', '0.25'])
  assert.deepEqual(['1_000', ' 12 ', 'inf', '-Infinity', '1e3', '1__0', '_1', 'x'].map(pyFloat), [1000, 12, Infinity, -Infinity, 1000, null, null, null])
})

void test('repr(str) and csv rows as Python', () => {
  assert.deepEqual(["it's", 'say "hi"', 'both \' and "', 'tab\there', 'nl\n', 'é', '\x7f', '​', '😀'].map(repr),
    ['"it\'s"', '\'say "hi"\'', '\'both \\\' and "\'', "'tab\\there'", "'nl\\n'", "'é'", "'\\x7f'", "'\\u200b'", "'😀'"])
  assert.equal(csvRow(['2026-01-01T00:00:00Z', 'id', 'idol', '0.1', 'true', 'a,b']), '2026-01-01T00:00:00Z,id,idol,0.1,true,"a,b"\n')
  assert.equal(csvRow(['x', 'q"uote', 'line\nbreak']), 'x,"q""uote","line\nbreak"\n')
  assert.equal(csvRow(['']), '""\n')
})

void test('json.dumps and json.loads as Python (ints, floats, key order, escapes, errors)', () => {
  const v = parsed('{"a": 1, "b": 1.0, "c": [true, null, "é\\u2028"], "d": {}, "e": []}')
  assert.equal(text(v), '{"a": 1, "b": 1.0, "c": [true, null, "\\u00e9\\u2028"], "d": {}, "e": []}')
  assert.equal(text(parsed('{"a": [1, {"b": "x"}], "c": "é"}'), 2, false), '{\n  "a": [\n    1,\n    {\n      "b": "x"\n    }\n  ],\n  "c": "é"\n}')
  const errors: [string, string][] = [
    ['{"a": 1,}', 'Expecting property name enclosed in double quotes: line 1 column 9 (char 8)'],
    ['[1, 2', "Expecting ',' delimiter: line 1 column 6 (char 5)"],
    ['{"a" 1}', "Expecting ':' delimiter: line 1 column 6 (char 5)"],
    ['', 'Expecting value: line 1 column 1 (char 0)'],
    ['  ', 'Expecting value: line 1 column 3 (char 2)'],
    ['{"a": "\\u12"}', 'Invalid \\uXXXX escape: line 1 column 9 (char 8)'],
    ['nul', 'Expecting value: line 1 column 1 (char 0)'],
    ['[1] x', 'Extra data: line 1 column 5 (char 4)'],
    ['{"a": 01}', "Expecting ',' delimiter: line 1 column 8 (char 7)"],
    ['"abc', 'Unterminated string starting at: line 1 column 1 (char 0)'],
    ['{"a":\n 1 x}', "Expecting ',' delimiter: line 2 column 4 (char 9)"],
  ]
  for (const [s, msg] of errors) {
    const p = parse(s)
    assert.ok(!p.ok, s)
    assert.equal(p.error, msg)
  }
  assert.deepEqual(['1e400', '-0.0', '1E5', '0.1e1'].map((s) => {
    const x = parsed(s)
    return x.kind === 'float' ? (Number.isFinite(x.value) ? floatRepr(x.value) : 'inf') : '?'
  }), ['inf', '-0.0', '100000.0', '1.0'])
  const big = parsed('123456789012345678901234567890')
  assert.equal(text(big), '123456789012345678901234567890')
  assert.equal(text(float(Number.NaN)), 'NaN')
  const strictNan = dumps(float(Number.NaN), { indent: 2, ensureAscii: false })
  assert.ok(!strictNan.ok && strictNan.error === 'Out of range float values are not JSON compliant: nan')
})

void test('argparse: values, prefixes, = forms, -- and the messages v1 printed', () => {
  const ok = (argv: string[]) => {
    const r = parseArgs(argv)
    if (r.kind !== 'ok') assert.fail(`${JSON.stringify(argv)}: ${r.kind}`)
    return r.options
  }
  const err = (argv: string[]) => {
    const r = parseArgs(argv)
    if (r.kind !== 'error') assert.fail(`${JSON.stringify(argv)}: ${r.kind}`)
    return r.message
  }
  assert.equal(err(['--n', 'x']), 'ambiguous option: --n could match --name, --notes')
  assert.equal(ok(['--na', 'x', 'a.jpg']).name, 'x')
  assert.equal(ok(['--name=x', 'a.jpg']).input, 'a.jpg')
  assert.equal(err(['--dims']), 'argument --dims: expected one argument')
  assert.equal(err(['--yaw', 'abc']), "argument --yaw: invalid int value: 'abc'")
  assert.equal(err(['--yaw', '45']), "argument --yaw: invalid choice: '45' (choose from 0, 90, 180, 270)")
  assert.equal(err(['--engine', 'x']), "argument --engine: invalid choice: 'x' (choose from idol, sam3d, trellis2, glb, rug)")
  assert.equal(err(['a', 'b']), 'unrecognized arguments: b')
  assert.equal(err(['--frob']), 'unrecognized arguments: --frob')
  assert.equal(err(['-x']), 'unrecognized arguments: -x')
  assert.equal(err(['--resolution', '2048']), "argument --resolution: invalid choice: '2048' (choose from 512, 1024, 1536)")
  assert.equal(err(['--mount', 'ceiling']), "argument --mount: invalid choice: 'ceiling' (choose from floor, wall)")
  assert.equal(ok(['--', '--name']).input, '--name')
  assert.equal(err(['--name', '--dims']), 'argument --name: expected one argument')
  assert.equal(ok(['--name', '-5']).name, '-5')
  assert.equal(err(['--yaw', '-90']), "argument --yaw: invalid choice: '-90' (choose from 0, 90, 180, 270)")
  assert.equal(ok(['--yaw', ' 90 ']).yaw, 90)
  assert.equal(err(['--yaw', '0x10']), "argument --yaw: invalid int value: '0x10'")
  assert.equal(ok(['--yaw', '٩٠']).yaw, 90)
  assert.equal(err(['--rescale']), 'argument --rescale: expected one argument')
  assert.equal(ok(['--library', 'x', '--library', 'y', '--name', 'n', 'a.jpg']).library, 'y')
  assert.equal(ok(['--source', 's', 'a.jpg']).sourceInput, 's')
  assert.equal(parseArgs(['-h', '--frob']).kind, 'help')
  assert.equal(parseArgs(['--frob', '-h']).kind, 'help')
  assert.ok(HELP.startsWith('usage: midstudy-add [-h] [--name NAME]') && HELP.endsWith('of an upload\n'))
})

void test('--dims, slugs, URLs and the engine tables', () => {
  assert.deepEqual(parseDims('75x80x95'), { ok: true, w: 75, d: 80, h: 95 })
  assert.deepEqual(parseDims(' 80 x 90 x 95.5 '), { ok: true, w: 80, d: 90, h: 95.5 })
  assert.deepEqual(parseDims('.5×1X2'), { ok: true, w: 0.5, d: 1, h: 2 })
  assert.deepEqual(parseDims('75x80'), { ok: false, error: "--dims must look like 75x80x95 (cm), got '75x80'" })
  assert.deepEqual(parseDims('0x80x90'), { ok: false, error: "--dims values must all be greater than 0 cm, got '0x80x90'" })
  assert.deepEqual(parseDims('1.x2x3'), { ok: false, error: "--dims must look like 75x80x95 (cm), got '1.x2x3'" })
  assert.deepEqual(parseDims(null), { ok: false, error: '--dims is required: W x D x H in cm, e.g. --dims 75x80x95' })
  const nfkd = (s: string): string => s.normalize('NFKD')
  assert.equal(slugify('Strandmon Wing-Chair (Ikea)', nfkd), 'strandmon-wing-chair-ikea')
  assert.equal(slugify('Café Ñandú', nfkd), 'cafe-nandu')
  assert.equal(slugify('!!!', nfkd), '')
  assert.equal(slugify('a'.repeat(63) + ' bcd', nfkd), 'a'.repeat(63))
  assert.ok(isSlug('reading-chair') && !isSlug('Bad_Id') && !isSlug('-x') && !isSlug('x\n') && !isSlug('a'.repeat(65)))
  assert.equal(urlPath('https://ex.com/a/b.JPG?x=1#y'), '/a/b.JPG')
  assert.equal(urlPath('https://ex.com/p;params/q;r'), '/p;params/q')
  assert.equal(urlPath('https://ex.com'), '')
  assert.equal(quote('engine input é.jpg'), 'engine%20input%20%C3%A9.jpg')
  assert.equal(mockSlug('fal-ai/sam-3/3d-objects'), 'sam-3-3d-objects')
  assert.equal(mockSlug('speridlabs/idol'), 'speridlabs-idol')
  assert.deepEqual([costUsd('idol', 512), costUsd('sam3d', 512), costUsd('trellis2', 1024), costUsd('trellis2', 777), costUsd('rug', 512)], [0.1, 0.02, 0.3, 0, 0])
  const sam = engineArguments('sam3d', 'U', 'chair', 512)
  assert.equal(text(sam), '{"image_url": "U", "prompt": "chair", "export_textured_glb": true}')
  assert.equal(text(withThreshold(sam)), '{"image_url": "U", "prompt": "chair", "export_textured_glb": true, "detection_threshold": 0.2}')
  assert.equal(text(withMask(withThreshold(sam), 'M')), '{"image_url": "U", "prompt": "chair", "export_textured_glb": true, "mask_urls": ["M"]}')
  assert.equal(text(engineArguments('idol', 'U', 'x', 512)), '{"image_url": "U", "image_type": "real", "num_gaussians": 262144}')
  assert.equal(text(engineArguments('trellis2', 'U', 'x', 1536)), '{"image_url": "U", "resolution": 1536}')
})

void test('PurePosixPath', () => {
  assert.deepEqual(['a//b/./c/', '/', '//x', '///x', '', '.', 'a/..'].map(normalize), ['a/b/c', '/', '//x', '/x', '.', '.', 'a/..'])
  assert.equal(join('lib', '/abs/x'), '/abs/x')
  assert.equal(join('.', 'x'), 'x')
  assert.deepEqual(['a/b.tar.gz', '.bashrc', 'x.', 'dir/', '/'].map(suffix), ['.gz', '', '', '', ''])
  assert.deepEqual(['a/b', 'a', '/a', '/'].map(parent), ['a', '.', '/', '/'])
  assert.equal(name('a/b/'), 'b')
  assert.equal(withName('item/splat.ply', 'splat.spz'), 'item/splat.spz')
})

void test('frames: quarter turns are exact, the engines\' frames and SAM 3D\'s splat pose', () => {
  assert.deepEqual(yawRotation(90, MATH), [[0, 0, 1], [0, 1, 0], [-1, 0, 0]])
  assert.deepEqual(yawRotation(180, MATH), [[-1, 0, 0], [0, 1, 0], [-0, 0, -1]]) // -sin as v1: -0.0
  assert.deepEqual(orientation('glb', 'glb', 0, MATH), IDENTITY)
  assert.equal(orientation('trellis2', 'splat', 0, MATH), null)
  // idol's splat: up -Y, front +X (NOTES.md) → up +Y, front +Z
  const r = orientation('idol', 'splat', 0, MATH)
  assert.ok(r !== null)
  // the columns of the second matrix are the engine's up (-Y) and front (+X): they land on +Y and +Z
  const moved = mul3(r, [[0, 1, 0], [-1, 0, 0], [0, 0, 0]])
  assert.deepEqual(moved.map((row) => row[0] + 0), [0, 1, 0])
  assert.deepEqual(moved.map((row) => row[1] + 0), [0, 0, 1])
  assert.deepEqual(quatXyzw(yawRotation(90, MATH), MATH), [0, 0.7071067811865475, 0, 0.7071067811865476])
  assert.deepEqual(sam3dSplatToGlb(parsed('{"metadata": []}'), MATH), IDENTITY)
  assert.deepEqual(sam3dSplatToGlb(parsed('{"metadata": [{"rotation": [[1, 0, 0, 0]]}]}'), MATH), [[1, 0, 0], [0, 0, 1], [0, -1, 0]])
})

void test('the §1 self-checks and fit errors', () => {
  const dims: [number, number, number] = [0.75, 0.95, 0.8]
  const b = { lo: [-0.375, 0, -0.4] as const, hi: [0.375, 0.95, 0.4] as const }
  assert.equal(text(errorsPct(b, dims)), '{"w": 0.0, "d": 0.0, "h": 0.0}')
  assert.equal(glbSelfCheck(b, dims), null)
  assert.equal(glbSelfCheck({ lo: [-0.4, 0, -0.4], hi: [0.4, 0.95, 0.4] }, dims), 'self-check failed: GLB w is 80.0 cm, expected 75.0 cm (6.7% off, max 2%)')
  assert.equal(glbSelfCheck({ lo: [-0.375, 0.01, -0.4], hi: [0.375, 0.96, 0.4] }, dims), 'self-check failed: GLB min y is 0.010 m, max 0.5 cm from 0')
  assert.equal(splatSelfCheck(b, false, dims, [0.1, 99.9]), 'self-check failed: splat has non-finite (NaN/inf) positions; the splat is corrupt')
  assert.equal(splatSelfCheck({ lo: [-0.3, 0, -0.4], hi: [0.45, 0.95, 0.4] }, true, dims, [1, 99]), 'self-check failed: splat footprint center is (0.075, 0.000) m, max 1 cm from the origin')
  const f = itemFrame({ lo: [1, 2, 3], hi: [3, 4, 7] }, [1, 1, 1])
  assert.deepEqual(f, { scale: [0.5, 0.5, 0.25], translation: [-1, -1, -1.25] })
  assert.equal(spzLine(262144, 3118822, 0), 'splat.spz: 262,144 splats, 3.1 MB')
  assert.equal(spzLine(262144, 3050000, 137856), 'splat.spz: 262,144 splats, 3.0 MB (dropped the 137,856 that cover the least)')
})

void test('the library entry and the summary line, key for key', () => {
  const entry = itemEntry({
    id: 'c', name: 'C', category: null, w: 75, d: 80, h: 95.5, splat: true, thumb: true, engine: 'sam3d', sourceInput: 'p.jpg',
    prompt: 'chair', cost: 0.0, mock: true, created: '2026-11-06T00:00:00Z', glbFit: parsed('{"w": 0.0, "d": 0.0, "h": 0.0}'),
    splatFit: null, notes: null, mount: 'wall',
  })
  assert.equal(text(entry), '{"id": "c", "name": "C", "category": null, "dims_cm": {"w": 75, "d": 80, "h": 95.5}, "assets": {"glb": "c/model.glb", "splat": "c/splat.ply", "spz": "c/splat.spz", "thumb": "c/thumb.jpg"}, "default_render": "splat", "source": {"engine": "sam3d", "input": "p.jpg", "prompt": "chair", "cost_usd": 0.0, "mock": true, "created": "2026-11-06T00:00:00Z"}, "fit": {"glb_error_pct": {"w": 0.0, "d": 0.0, "h": 0.0}, "splat_error_pct": null}, "notes": null, "mount": "wall"}')
  const s = summary('c', 'rescale', 'int-zero', false, { library: 'l', item: 'i', glb: 'g', splat: null, spz: null, thumb: null, source: null, raw: null, costs: 'k' }, NULL)
  assert.equal(text(s), '{"id": "c", "engine": "rescale", "cost_usd": 0, "mock": false, "paths": {"library": "l", "item": "i", "glb": "g", "splat": null, "spz": null, "thumb": null, "source": null, "raw": null, "costs": "k"}, "fit": null}')
  assert.equal(text(str('é')), '"\\u00e9"')
})

void test('the lock\'s rules: a dead owner or an old lock is stale, a fresh unreadable one is not', () => {
  const owner = ownerFrom({ pid: 12, host: 'h', cmd: 'midstudy-add x', started: '2026-11-06T00:00:00.000Z' })
  assert.ok(owner !== null)
  assert.equal(ownerFrom({ pid: 0, host: 'h', cmd: '', started: '' }), null)
  assert.equal(ownerFrom({ pid: 1.5, host: 'h', cmd: '', started: '' }), null)
  assert.equal(isStale({ owner, alive: false, ageMs: 10 }), true)
  assert.equal(isStale({ owner, alive: true, ageMs: 10 }), false)
  assert.equal(isStale({ owner, alive: null, ageMs: 3600 * 1000 + 1 }), true)
  assert.equal(isStale({ owner: null, alive: null, ageMs: 5 }), false)
  assert.equal(isStale({ owner: null, alive: null, ageMs: null }), false)
  assert.ok(sameOwner(owner, { ...owner }) && !sameOwner(owner, null) && sameOwner(null, null))
})
