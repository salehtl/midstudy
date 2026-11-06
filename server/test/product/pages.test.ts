// v1 (planner/serve.py) and v2 (server/src/main.ts) side by side on every synthetic shop page the evals use
// (fixtures/product-pages/manifest.json, served by evals/lib/pages_server.mjs), on refused links, on pasted pages and on
// llm: false: the same status and the same JSON body, key for key (numbers exactly), and the same cost rows. fal is
// mocked; nothing leaves this machine. The slow and trickling pages (20 s each) run once, together, at the end.
//
// node --test server/test/product/pages.test.ts      (needs npm run build and the dev shell's Python 3.12)
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL } from 'node:url'
import { REPO, oracleAvailable, same } from './oracle.ts'

const OUT = path.join(REPO, 'evals/out/product-pages-diff')

interface Server {
  readonly base: string
  readonly costs: string
  readonly stop: () => Promise<void>
  readonly log: () => string
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.listen(0, '127.0.0.1', () => {
      const a = s.address()
      const port = typeof a === 'object' && a !== null ? a.port : 0
      s.close(() => {
        resolve(port)
      })
    })
    s.on('error', reject)
  })
}

async function startServer(which: 'v1' | 'v2', env: Readonly<Record<string, string>>, cap = '0'): Promise<Server> {
  const dir = path.join(OUT, `${which}-${String(Date.now())}-${String(Math.random()).slice(2, 8)}`)
  for (const d of ['scenes', 'layouts', 'renders', 'library']) fs.mkdirSync(path.join(dir, d), { recursive: true })
  const costs = path.join(dir, 'library/costs.csv')
  fs.writeFileSync(costs, 'date,id,engine,cost_usd,mock,input\n')
  const port = await freePort()
  const cmd = which === 'v2' ? ['node', 'server/src/main.ts'] : ['python3', 'planner/serve.py']
  const childEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined && k !== 'FAL_KEY' && k !== 'MIDSTUDY_FAL_MOCK_COST') childEnv[k] = v
  Object.assign(childEnv, { MIDSTUDY_NO_DOTENV: '1', NOOK_NO_DOTENV: '1', MIDSTUDY_FAL_MOCK: path.join(REPO, 'fixtures/fal'), MIDSTUDY_STRICT: which === 'v2' ? '1' : '0' }, env)
  const args = [...cmd.slice(1), '--port', String(port), '--host', '127.0.0.1', '--scenes-dir', path.join(dir, 'scenes'), '--layouts-dir', path.join(dir, 'layouts'),
    '--renders-dir', path.join(dir, 'renders'), '--library-dir', path.join(dir, 'library'), '--costs-file', costs, '--calib', 'python3 fixtures/stub_calib.py',
    '--daily-spend-usd', cap]
  const proc: ChildProcess = spawn(cmd[0] ?? 'node', args, { cwd: REPO, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  proc.stdout?.on('data', (d: Buffer) => { log += d.toString() })
  proc.stderr?.on('data', (d: Buffer) => { log += d.toString() })
  const base = `http://127.0.0.1:${String(port)}`
  for (let i = 0; i < 200; i++) {
    try {
      const r = await fetch(base + '/planner/')
      if (r.status > 0) break
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  return {
    base,
    costs,
    log: () => log,
    stop: async () => {
      proc.kill('SIGTERM')
      await new Promise((resolve) => setTimeout(resolve, 200))
    },
  }
}

interface Answer {
  readonly status: number
  readonly body: unknown
}

async function read(base: string, body: unknown): Promise<Answer> {
  const r = await fetch(base + '/api/library/product', { method: 'POST', headers: { 'X-Midstudy': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(90_000) })
  const text = await r.text()
  let parsed: unknown = text
  try {
    parsed = JSON.parse(text)
  } catch {
    // not JSON: compared as text
  }
  return { status: r.status, body: parsed }
}

/** `o[k]` of an object the eval's plain JS gave. */
function prop(o: unknown, k: string): unknown {
  return typeof o === 'object' && o !== null ? Reflect.get(o, k) : undefined
}

/** The pages server, through the eval's own module (plain JS, so its values are checked as they come). */
async function pagesServer(): Promise<{ base: string; port: number; cases: [string, string][]; refused: string[]; stop: () => Promise<void> }> {
  const mod: unknown = await import(pathToFileURL(path.join(REPO, 'evals/lib/pages_server.mjs')).href)
  const synthetic: unknown = prop(mod, 'syntheticPages')
  const start: unknown = prop(mod, 'startPagesServer')
  if (typeof synthetic !== 'function' || typeof start !== 'function') throw new Error('evals/lib/pages_server.mjs changed')
  const synth: unknown = Reflect.apply(synthetic, undefined, [])
  const filler = Array.from({ length: 600 }, (_, i) => `<p>Paragraph ${String(i + 1)} of the maker's story: oak from the hills, dried slowly, planed by hand and oiled twice.</p>`).join('\n')
  const longPage = '<!doctype html><html><head><meta charset="utf-8"><title>Long Oak Bench</title><meta property="og:image" content="/media/long-oak-bench.jpg"></head>' +
    `<body><h1>Long Oak Bench</h1>${filler}<p>Dimensions are on the drawing we send with the order.</p></body></html>`
  const routes: unknown = prop(synth, 'routes')
  const dir: unknown = prop(synth, 'dir')
  const routeList: unknown[] = Array.isArray(routes) ? routes.map((r: unknown) => r) : []
  const server: unknown = await Reflect.apply(start, undefined, [{ routes: [...routeList, { path: '/products/long-oak-bench-story', body: longPage }], dir }])
  const casesObj: unknown = prop(synth, 'cases')
  const cases: [string, string][] = []
  for (const [id, c] of Object.entries(typeof casesObj === 'object' && casesObj !== null ? casesObj : {})) {
    const p: unknown = prop(c, 'path')
    if (typeof p === 'string') cases.push([id, p])
  }
  cases.push(['long-page', '/products/long-oak-bench-story'])
  const refusedRaw: unknown = prop(synth, 'refused')
  const port: unknown = prop(server, 'port')
  const base: unknown = prop(server, 'base')
  const stop: unknown = prop(server, 'stop')
  if (typeof port !== 'number' || typeof base !== 'string' || typeof stop !== 'function') throw new Error('pages server shape')
  return {
    base, port, cases,
    refused: Array.isArray(refusedRaw) ? refusedRaw.filter((x): x is string => typeof x === 'string') : [],
    stop: async () => {
      await Reflect.apply(stop, server, [])
    },
  }
}

/** The cost rows without their dates (the two servers ran at different moments). */
function costRows(file: string): string[] {
  return fs.readFileSync(file, 'utf8').trim().split('\n').slice(1).map((l) => l.split(',').slice(1).join(','))
}

void test('v1 and v2 answer every synthetic shop page alike', { skip: !oracleAvailable(), timeout: 600_000 }, async () => {
  fs.rmSync(OUT, { recursive: true, force: true })
  const pages = await pagesServer()
  const env = { MIDSTUDY_FETCH_ALLOW: `127.0.0.1:${String(pages.port)}` }
  const v1 = await startServer('v1', env)
  const v2 = await startServer('v2', env)
  const diffs: string[] = []
  const statuses = new Map<number, number>()
  const compare = (what: string, a: Answer, b: Answer): void => {
    statuses.set(a.status, (statuses.get(a.status) ?? 0) + 1)
    if (a.status !== b.status || !same(a.body, b.body)) diffs.push(`${what}\n  v1 ${String(a.status)} ${JSON.stringify(a.body)}\n  v2 ${String(b.status)} ${JSON.stringify(b.body)}`)
  }
  let n = 0
  try {
    const slow = ['slow', 'trickle']
    for (const [id, p] of pages.cases.filter(([id]) => !slow.includes(id))) {
      for (const extra of [{}, { llm: false }]) {
        const body = { url: pages.base + p, ...extra }
        compare(`${id} ${JSON.stringify(extra)}`, await read(v1.base, body), await read(v2.base, body))
        n++
      }
    }
    // pasted pages: each fixture page with a link, with the bookmarklet's first line, and with neither
    const dir = path.join(REPO, 'fixtures/product-pages/pages')
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.html')).sort()) {
      const html = fs.readFileSync(path.join(dir, f), 'utf8')
      for (const body of [{ url: `https://shop.example/p/${f}`, html }, { html: `<!-- midstudy-page: https://me:pw@marked.example/p/x?variant=2#top -->\n${html}` }, { html }]) {
        compare(`pasted ${f} ${JSON.stringify(Object.keys(body))}`, await read(v1.base, body), await read(v2.base, body))
        n++
      }
    }
    for (const u of pages.refused) {
      const url = u.replaceAll('{pages_port}', String(pages.port)).replaceAll('{serve_port}', '1')
      compare(`refused ${url}`, await read(v1.base, { url }), await read(v2.base, { url }))
      n++
    }
    for (const body of [{}, { url: 5 }, { url: 'x', llm: 'no' }, { html: 5 }, { html: '  ' }, { url: '  ' }, { url: 'https://a.example/' + 'x'.repeat(5000) }, [1], 'text', null,
      { url: 'https://shop.example/p', html: 'Oak desk 120 x 60 x 75 cm' }, { url: 'ftp://shop.example/p', html: '<html><title>x</title></html>' }]) {
      compare(`body ${JSON.stringify(body).slice(0, 60)}`, await read(v1.base, body), await read(v2.base, body))
      n++
    }
    const slowCases = pages.cases.filter(([id]) => slow.includes(id))
    const answers = await Promise.all(slowCases.flatMap(([, p]) => [read(v1.base, { url: pages.base + p }), read(v2.base, { url: pages.base + p })]))
    slowCases.forEach(([id], i) => {
      const a = answers[2 * i]
      const b = answers[2 * i + 1]
      if (a !== undefined && b !== undefined) compare(id, a, b)
      n++
    })
    const rows1 = costRows(v1.costs)
    const rows2 = costRows(v2.costs)
    if (!same(rows1, rows2)) diffs.push(`cost rows\n  v1 ${JSON.stringify(rows1)}\n  v2 ${JSON.stringify(rows2)}`)
  } finally {
    await v1.stop()
    await v2.stop()
    await pages.stop()
  }
  console.log(`pages: ${String(n)} reads compared (v1's statuses: ${[...statuses].sort((x, y) => x[0] - y[0]).map(([k, v]) => `${String(k)} \u{d7}${String(v)}`).join(', ')}), ${String(diffs.length)} differences`)
  assert.equal(diffs.length, 0, diffs.slice(0, 6).join('\n'))
})
