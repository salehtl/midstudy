// The pure ports against v1 itself: every case is computed by the TypeScript function and by v1's own Python
// (planner/serve.py's functions, or the standard library v1 called) through server/test/v1_oracle.py, and the two must
// be equal. Skipped when planner/serve.py is gone (after the cutover) or the dev shell's Python 3.12 isn't on PATH.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hostName } from '../../core/js/node.ts'
import { costsText, csvLine, parseCsv, pyFloat, spentOn } from '../../common/logic/csv.ts'
import { dotenvValue } from '../../common/logic/env.ts'
import { fmtCost, mbText, numText, pyFixed, pyFloatRepr, pyFormatG, pyRepr, pyRound, pySplitlines, pyStrip } from '../../common/logic/pyfmt.ts'
import { shlexSplit } from '../../common/logic/shlex.ts'
import { posixName, slugify } from '../../common/logic/slug.ts'
import { isoUtc, isoUtcMs, utcDay, utcStamp } from '../../common/logic/time.ts'
import { addError, lastJsonLine, toolError } from '../../common/logic/tool.ts'
import { addressBlocked, fetchAllowed, parseIpv4, parseIpv6 } from '../src/logic/address.ts'
import { parseCli, pyInt } from '../src/logic/cli.ts'
import { apiPathOf, folderLocation, htmlErrorPage, targetParts } from '../src/logic/http.ts'
import { mimeType } from '../src/logic/mime.ts'
import { refusal } from '../src/logic/spend.ts'
import { queryValue, unquote, urlHostname, urljoin, urlPort, urlsplit } from '../src/logic/url.ts'
import { REPO } from './helpers.ts'

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json }

interface Case {
  readonly fn: string
  readonly args: readonly Json[]
  /** What the TypeScript port answers (JSON-able, as the oracle would print it). */
  readonly mine: () => unknown
}

const ch = (...codes: number[]): string => String.fromCodePoint(...codes)

function asJson(v: unknown): unknown {
  if (typeof v === 'number' && !Number.isFinite(v)) return { float: Number.isNaN(v) ? 'nan' : v > 0 ? 'inf' : '-inf' }
  if (Array.isArray(v)) return v.map(asJson)
  if (typeof v === 'object' && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, asJson(x)]))
  return v
}

const cases: Case[] = []
const add = (fn: string, args: readonly Json[], mine: () => unknown): void => {
  cases.push({ fn, args, mine })
}

// --- numbers ---------------------------------------------------------------------------------------------------------
const numbers = [0, 0.125, 0.375, 2.5, 0.5, 1.5, 3.5, 0.0398, 0.02, 0.1, 0.36, 1e-7, 123456.789, -0.125, 0.005, 0.015, 0.025, 1.005, 2.675,
  0.03, 0.04, 0.0001, 0.00025, 0.00008, 30, 2, 1e16, 1.5e16, 1e-5, 1.234e-7, 1234567.0, 0.1 + 0.2, 99.995, 1e21, 5e-324, 1.7976931348623157e308,
  0.045, 0.055, 1.0000005, 2 ** 53 + 2, 7.0, 80, 80.5, 1999.99, 0.3, 25.000001, 0.0005]
for (const x of numbers) {
  for (const d of [0, 1, 2, 4, 6]) add('pyFixed', [x, d], () => pyFixed(x, d))
  add('pyRound', [x, 2], () => pyRound(x, 2))
  add('pyRound', [x, 6], () => pyRound(x, 6))
  add('fmtCost', [x], () => fmtCost(x))
  add('pyFloatRepr', [x], () => pyFloatRepr(x))
  add('pyFormatG', [x], () => pyFormatG(x))
  add('numText', [x], () => numText(x))
}
for (const n of [0, 1, 1048576, 25 * 1048576, 25 * 1048576 + 1, 20 * 1048576 + 7, 123456789, 2 ** 31]) add('mbText', [n], () => mbText(n))
for (const s of ['8765', ' 42 ', '+7', '-3', '1_000', '1__0', '_1', '', 'x', '0x10', '12a']) add('pyInt', [s], () => pyInt(s))
for (const s of ['1', ' 2.5 ', '1e3', '.5', '5.', '1_000.5', 'inf', '-Infinity', 'nan', '+NaN', 'x', '', '1e', '.', '1._5', '0.0398', ' 0.02\n']) {
  add('pyFloat', [s], () => asJson(pyFloat(s)))
}

// --- text ------------------------------------------------------------------------------------------------------------
const texts = ['plain', "it's", 'say "hi"', 'both \' and "', 'back\\slash', 'tab\there', 'line\nbreak', 'cr\rhere', ch(0) + 'nul', 'del' + ch(0x7f),
  'caf\u00e9', 'nbsp' + ch(0xa0), 'ls' + ch(0x2028), 'soft' + ch(0xad), 'emoji ' + ch(0x1f600), 'zw' + ch(0x200b), ch(0x85) + 'nel', 'ideo' + ch(0x3000) + 'sp',
  '  padded \t', ch(0x1c) + 'fs' + ch(0x1f), ch(0xfeff) + 'bom', 'a\r\nb\rc\nd' + ch(0x0b) + 'e' + ch(0x0c) + 'f' + ch(0x1e) + 'g' + ch(0x2029) + 'h\n', '', '\n', 'x\n\n']
for (const s of texts) {
  add('pyRepr', [s], () => pyRepr(s))
  add('pyStrip', [s], () => pyStrip(s))
  add('pySplitlines', [s], () => pySplitlines(s))
}
for (const s of ['uv run --project calib midstudy-calib', 'python3 fixtures/stub_calib.py', '  a   b  ', "a 'b c' d", 'a "b c" d', 'a"b c"d', "''", 'x "" y',
  'a\\ b', '"a\\"b"', '"a\\xb"', "'a\\b'", 'unclosed "q', "unclosed 'q", 'trailing\\', 'tab\tsep', 'new\nline', '"\\\\"', 'mid"dle"', '#notcomment x', '']) {
  add('shlexSplit', [s], () => {
    const r = shlexSplit(s)
    return r.ok ? { ok: r.value } : { error: r.error }
  })
}
for (const s of ['Reading chair', 'Caf\u00e9 Cr\u00e8me', '\u00c6\u00d8\u00c5 \u00fc', '  --hello--  ', '', '!!!', 'x'.repeat(70), 'a-'.repeat(40), '\uff21\uff22\uff23 wide', '\u00bd cup', '\u216b roman']) {
  add('slugify', [s], () => slugify(s))
}
for (const s of ['IMG_0042.HEIC', 'a/b/c.jpg', 'a/b/', '/', '', '..', 'a/..', 'a/.', './x', '//x//y']) add('posixName', [s], () => posixName(s))

// --- csv and costs ---------------------------------------------------------------------------------------------------
const csvTexts = ['date,id,engine,cost_usd,mock,input\n2026-11-05T10:00:00Z,a,idol,0.10,false,x.jpg\n', 'a,"b,c",d\r\n"q""uote",,\n\n', '"multi\nline",x\n', 'x,"ab"cd,e\n',
  'no newline', '"open quote', ',\n', '""\n', 'a\rb\r\nc', 'a,b\n\nc,d\n']
for (const t of csvTexts) add('parseCsv', [t], () => parseCsv(t))
for (const f of [['a', 'b'], ['has,comma', 'has"quote', 'has\nnl', 'has\rcr', ''], ['https://x.example/a?b=1,2', 'scene-1']]) add('csvLine', [f], () => csvLine(f))
const row = { date: '2026-11-05T21:36:09Z', id: 'render-20261105-213609', engine: 'render:nano-banana', costUsd: 0.0398, mock: false, input: 'scene-20261105-1' }
for (const existing of [null, '', '   \n', 'date,id,engine,cost_usd,mock,input\n', 'date,id,engine,cost_usd,mock,input\nx,y,z,0.10,true,i']) {
  add('costsText', [existing, row], () => costsText(existing, row))
}
add('costsText', [null, { ...row, costUsd: 0.36, mock: true, input: 'a,b' }], () => costsText(null, { ...row, costUsd: 0.36, mock: true, input: 'a,b' }))
const costsCsv = 'date,id,engine,cost_usd,mock,input\n2026-11-05T10:00:00Z,a,idol,0.10,false,x\n2026-11-05T11:00:00Z,b,sam3d,0.02,true,"y,z"\n'
  + '2026-11-04T23:59:59Z,c,idol,0.10,false,x\n2026-11-05T12:00:00Z,d,render:qwen,,false,s\n2026-11-05T13:00:00Z,e,x,abc,false,s\nshort,row\n\n'
for (const day of ['2026-11-05', '2026-11-04', '2026-11-06', '2026']) add('spentOn', [costsCsv, day], () => pyRound(spentOn(costsCsv, day), 6))
add('spentOn', ['', '2026-11-05'], () => pyRound(spentOn('', '2026-11-05'), 6))
add('spentOn', ['cost_usd,date\n0.5,2026-11-05\n', '2026-11-05'], () => pyRound(spentOn('cost_usd,date\n0.5,2026-11-05\n', '2026-11-05'), 6))

// --- the spend cap's 402 -----------------------------------------------------------------------------------------------
for (const [amount, spent, reserved, cap] of [[0.0398, 0, 0, 0.03], [0.02, 0.02, 0, 0.03], [0.02, 0, 0.02, 0.03], [0.02, 0.01, 0.005, 0.03], [0.36, 0, 0, 0.05],
  [0.1, 1.95, 0, 2], [0.1, 1.9, 0, 2], [0.002, 0, 0, 0], [0.25, 0.125, 0.125, 0.375]] as const) {
  add('refusal', [amount, spent, reserved, cap], () => refusal(amount, spent, reserved, cap))
}

// --- URLs ------------------------------------------------------------------------------------------------------------
const urls = ['https://example.com/a/b?c=1#f', 'HTTP://Example.COM:8080/x', 'http://user:pw@host:99/p', 'http://[::1]:8765/x', 'http://[::ffff:127.0.0.1]:1/x',
  'http://[fe80::1%25eth0]/x', 'http://[::1', 'http://::1]/', 'http://[1.2.3.4]/', 'http://[v1.x]/', 'http://a[::1]/', 'http://[::1]x/', 'file:///etc/passwd',
  'ftp://x/y', '//no-scheme/x', '/just/path?q#f', 'path:80', 'http://host:port/x', 'http://host:99999/x', 'http://host:/x', 'http://host:0080/x', ' http://lead/x',
  'http://ta\tb/x', 'mailto:a@b', 'http://h/a;p?q', 'http://h?x', 'http://h#y', 'http:no-netloc', 'https://shop.example/products/Chair?variant=1&x=a+b%20c']
for (const u of urls) {
  add('urlsplit', [u], () => urlsplit(u))
  add('urlHostname', [u], () => {
    const p = urlsplit(u)
    return p === null ? 'ValueError' : urlHostname(p)
  })
  add('urlPort', [u], () => {
    const p = urlsplit(u)
    return p === null ? 'ValueError' : urlPort(p)
  })
}
const bases = ['http://a/b/c/d;p?q', 'https://shop.example/products/chair', 'http://127.0.0.1:9/redir-ok', 'http://h']
const refs = ['g', './g', 'g/', '/g', '//g', '?y', 'g?y', '#s', 'g#s', ';x', 'g;x', '', '.', './', '..', '../', '../g', '../..', '../../g', '../../../g',
  'http://other/x', 'https://shop.example/y', 'ftp://f/x', 'g/../h', '/./g', 'g/.', 'http:g', 'http:/abs']
for (const b of bases) for (const r of refs) add('urljoin', [b, r], () => urljoin(b, r))
for (const s of ['plain', '%41%42', '%2e%2E', '%zz', '%', '%4', 'caf%C3%A9', '%C3', '%E2%82', '%FF%FE', '%F0%9F%98%80', '%ED%A0%80', '\u00e9%41', '%C0%AF', '%E0%80%AF', '%F4%90%80%80', '+plus']) {
  add('unquote', [s], () => unquote(s))
}
for (const [qs, key] of [['scene=a', 'scene'], ['scene=', 'scene'], ['scene', 'scene'], ['x=1&scene=b&scene=c', 'scene'], ['scene=a+b%20c', 'scene'], ['s%63ene=d', 'scene'],
  ['&&scene=e', 'scene'], ['scene=f;g', 'scene'], ['', 'scene'], ['scene==h', 'scene']] as const) {
  add('queryValue', [qs, key], () => queryValue(qs, key))
}
for (const t of ['/api', '/api/', '/api/scenes', '/apix', '/api/scenes/a%2Fb', '/%61pi/spend', '/api/x?y=1', 'http://h/api/spend', '/api/%E2%82']) {
  add('apiPathOf', [t], () => apiPathOf(targetParts(t)))
}
for (const t of ['/planner', '/planner?scene=x', '/./planner', '/planner#f', 'http://h/planner?q']) {
  add('folderLocation', [t], () => {
    const p = targetParts(t)
    return p === null ? null : folderLocation(p)
  })
}

// --- addresses -------------------------------------------------------------------------------------------------------
const addrs = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.32.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.128.0.1', '100.100.100.100', '224.0.0.1',
  '240.0.0.1', '255.255.255.255', '0.0.0.0', '8.8.8.8', '93.184.216.34', '01.2.3.4', '1.2.3', '1.2.3.4.5', '256.1.1.1', '::1', '::', '::ffff:127.0.0.1', '::ffff:8.8.8.8',
  '::127.0.0.1', '::8.8.8.8', '64:ff9b::7f00:1', '64:ff9b::808:808', '64:ff9b:1::1', '2002:7f00:1::', '2002:808:808::1', 'fe80::1', 'fe80::1%en0', 'fc00::1', 'fd7a:115c:a1e0::1',
  'ff02::1', 'fec0::1', '2606:4700::1111', '2001:db8::1', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:7::', '::2:3:4:5:6:7:8', '1::8', '1:2:3:4:5:6:1.2.3.4', '::ffff:0:7f00:1',
  ':1::2', '1::2::3', '1:2:3:4:5:6:7:8:9', '12345::', 'g::1', '', 'localhost', '1:2:3:4:5:6:7', '::1.2.3.4', '1::1.2.3.4']
for (const a of addrs) {
  add('parseIpv4', [a], () => parseIpv4(a))
  add('parseIpv6', [a], () => parseIpv6(a))
  add('addressBlocked', [a], () => addressBlocked(a))
}
for (const [allow, host, port] of [['127.0.0.1:9', '127.0.0.1', 9], ['127.0.0.1:9', '127.0.0.1', 10], ['[::1]:9', '::1', 9], ['LOCALHOST:9', 'localhost', 9], ['127.0.0.1', '127.0.0.1', 9],
  ['', '127.0.0.1', 9], ['h:x', 'h', 9], [':9', '', 9]] as const) {
  add('fetchAllowed', [allow, host, port], () => fetchAllowed(allow, host, port))
}
for (const h of ['127.0.0.1', 'localhost:8765', '[::1]:8765', '127.0.0.1:80@evil.example', '[::1]evil.example', 'EXAMPLE.com', 'midstudy.example.com:443', 'https://x', '', 'a b',
  'host:', 'host:123456', ' 127.0.0.1 ']) {
  add('hostName', [h], () => hostName(h) ?? '')
}

// --- tools -----------------------------------------------------------------------------------------------------------
for (const out of ['{"ok": true}\n', 'progress\n{"ok": false, "error": "x"}\n\n', 'not json\n', '', '{"a": 1}\nlast line\n', '  {"ok": true}  \n', 'null\n', '[1, 2]\n']) {
  add('lastJsonLine', [out], () => lastJsonLine(out))
}
for (const [error, stderr, code] of [['the photo is unreadable', '', 1], [null, 'midstudy-calib: one\nmidstudy-calib:  two  \n', 1], [null, 'warn\nlast\n', 2], [null, '', 3], ['  ', 'x\n', 1],
  [null, 'Traceback\nmidstudy-calib:\n', -9]] as const) {
  add('toolError', [error, stderr, code, 'midstudy-calib'], () => toolError(error ?? undefined, stderr, code, 'midstudy-calib'))
}
for (const [stderr, code] of [['midstudy-add: no dims\n', 1], ['x\nmidstudy-add: a\nmidstudy-add: b\ny\n', 1], ['oops\n', 2], ['', 137]] as const) add('addError', [stderr, code], () => addError(stderr, code))
for (const t of ['FAL_KEY=abc', 'export FAL_KEY="q"', "FAL_KEY = 'x' ", 'FAL_KEY=\nFAL_KEY=second', '# FAL_KEY=no', 'OTHER=1\nFAL_KEY=k=v', 'FAL_KEY=""', 'FAL_KEYX=1']) {
  add('dotenvValue', [t, 'FAL_KEY'], () => dotenvValue(t, 'FAL_KEY'))
}

// --- time, MIME, HTML ------------------------------------------------------------------------------------------------
for (const ms of [0, 1762378569987, 1762378569000, 951782400000, 4102444799999, 1709251199999, 86399999, 1762300800000]) {
  add('isoUtc', [ms], () => isoUtc(ms))
  add('isoUtcMs', [ms], () => isoUtcMs(ms))
  add('utcStamp', [ms], () => utcStamp(ms))
  add('utcDay', [ms], () => utcDay(ms))
}
for (const p of ['/x/index.html', '/x/app.js', '/x/app.js.map', '/x/a.WASM', '/x/s.spz', '/x/m.glb', '/x/noext', '/x/.hidden', '/x/..x', '/x/a.tar.gz', '/x/f.woff2', '/x/i.ico',
  '/x/t.LEGAL.txt', '/x/m.webmanifest', '/x/a.Z', '/x/a.z', '/x/p.JPG', '/x/k.ksplat']) {
  add('mimeType', [p], () => mimeType(p))
}
for (const [code, message] of [[404, 'File not found'], [501, "Unsupported method ('OPTIONS')"], [400, 'Bad <request> & syntax'], [431, 'Line too long']] as const) {
  add('htmlErrorPage', [code, message], () => htmlErrorPage(code, message))
}

// --- the command line ------------------------------------------------------------------------------------------------
const argvs: readonly (readonly string[])[] = [[], ['--port', '9'], ['--port=9', '--host', '0.0.0.0'], ['--po', '9'], ['--l', 'x'], ['--lib', 'L'], ['--port', 'x'], ['--port'],
  ['--calib', '-x'], ['--calib', '-x y'], ['--calib', ''], ['--calib='], ['--daily-spend-usd', '-1'], ['--daily-spend-usd', 'nan'], ['--allowed-host', 'a', '--allowed-host=b'],
  ['extra'], ['--nope'], ['-p', '80'], ['--', '--port', '1'], ['--port', '1', '--port', '2'], ['-h'], ['--help'], ['--he'], ['--port', '-5'], ['--costs-file', 'c.csv', '--library-dir', 'l'],
  ['--port', 'x', '--calib'], ['--calib', '--port', 'x'], ['--midstudy-add', 'node pipeline/src/cli.ts'], ['-'], ['--scenes-dir', '-'], ['--port=', '1']]
for (const argv of argvs) {
  add('parseCli', [argv], () => {
    const r = parseCli(argv)
    if (r.kind === 'error') return { error: r.message }
    if (r.kind === 'help') return { error: 'exit' }
    return { options: asJson(r.options) }
  })
}

void test('the pure ports answer as v1 does (planner/serve.py and the Python it called)', { skip: !fs.existsSync(path.join(REPO, 'planner/serve.py')) && 'planner/serve.py is gone' }, () => {
  const run = spawnSync('python3', ['-I', path.join(REPO, 'server/test/v1_oracle.py')], {
    input: JSON.stringify(cases.map((c) => ({ fn: c.fn, args: c.args }))), encoding: 'utf8', cwd: REPO, maxBuffer: 64 << 20,
  })
  if (run.error !== undefined || run.status !== 0) assert.fail('v1_oracle.py failed: ' + (run.error?.message ?? run.stderr))
  const answers: unknown = JSON.parse(run.stdout)
  assert.ok(Array.isArray(answers) && answers.length === cases.length)
  const problems: string[] = []
  cases.forEach((c, i) => {
    const want: unknown = answers[i]
    const v1 = typeof want === 'object' && want !== null && 'ok' in want ? want.ok : want
    const mine: unknown = JSON.parse(JSON.stringify(asJson(c.mine()) ?? null))
    try {
      assert.deepStrictEqual(mine, v1)
    } catch {
      problems.push(c.fn + '(' + JSON.stringify(c.args) + '): v2 ' + JSON.stringify(mine) + ', v1 ' + JSON.stringify(v1))
    }
  })
  assert.deepStrictEqual(problems, [], String(problems.length) + ' of ' + String(cases.length) + ' differ:\n' + problems.join('\n'))
})
