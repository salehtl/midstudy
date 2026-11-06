// eval:product-live — the product page reader (contract §2.11) on the golden set of real shop pages,
// evals/product_golden.json. Not in eval:all.
//
//   node evals/product_live.mjs                  replay the saved snapshots (fixtures/pages/<id>/, git-ignored) through
//                                                the local pages server: offline, $0, model off (llm: false)
//   node evals/product_live.mjs --live           the real shops over the network, model off, at least 3 s between pages;
//                                                a shop that now answers 429/403 is a WARN (the shop changed), not a FAIL,
//                                                unless the golden set expects it to block
//   MIDSTUDY_LIVE_LLM=1 node evals/product_live.mjs --live --llm
//                                                also lets the language model read the pages without a size: real fal
//                                                calls (about $0.001 a page), the server started WITHOUT the fal mock and
//                                                WITHOUT MIDSTUDY_NO_DOTENV (it reads .env in this checkout) and with
//                                                --daily-spend-usd 0.02. Main session only, with the user's OK. Costs go to
//                                                the scratch library's costs.csv under evals/out/product-live/ and are printed.
// Each check prints "PASS|FAIL <id> <what> — <measured>"; a mismatch measures "expected …, got …".
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { createEval, startServer, api, raw, sleep, fmt, freePort, REPO, STUB_CALIB, serverCommand } from './lib/harness.mjs'
import { snapshotPages, startPagesServer } from './lib/pages_server.mjs'

const args = process.argv.slice(2)
const LIVE = args.includes('--live')
const LLM = args.includes('--llm')
const golden = JSON.parse(fs.readFileSync(path.join(REPO, 'evals/product_golden.json'), 'utf8'))
const ev = createEval('PL', 'product-live', { timeoutS: 900 })
const mode = LIVE ? (LLM ? 'live, model on' : 'live, model off') : 'snapshots, model off'
ev.note(`mode: ${mode}`)

if (LLM && (!LIVE || process.env.MIDSTUDY_LIVE_LLM !== '1')) {
  ev.check('--llm runs only with --live and MIDSTUDY_LIVE_LLM=1 (real fal calls)', false,
    `refused: --live ${LIVE}, MIDSTUDY_LIVE_LLM=${process.env.MIDSTUDY_LIVE_LLM ?? 'unset'}; nothing was started`)
  await ev.finish(1)
}

// The server with the real fal (no mock, .env read), a $0.02 cap and scratch dirs; only for --live --llm.
async function startRealFalServer() {
  const data = path.join(ev.out, 'server-llm')
  const dirs = { scenes: path.join(data, 'scenes'), layouts: path.join(data, 'layouts'), renders: path.join(data, 'renders'), library: path.join(data, 'library') }
  for (const d of Object.values(dirs)) fs.mkdirSync(d, { recursive: true })
  dirs.costs = path.join(dirs.library, 'costs.csv')
  fs.writeFileSync(dirs.costs, 'date,id,engine,cost_usd,mock,input\n')
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const env = { ...process.env }
  for (const k of ['MIDSTUDY_FAL_MOCK', 'NOOK_FAL_MOCK', 'MIDSTUDY_NO_DOTENV', 'NOOK_NO_DOTENV', 'MIDSTUDY_FAL_MOCK_COST', 'MIDSTUDY_FAL_MOCK_LOG', 'MIDSTUDY_FETCH_ALLOW']) delete env[k]
  // the server's command (the harness's)
  const { cmd, args: argv } = serverCommand(['--port', String(port), '--host', '127.0.0.1', '--scenes-dir', dirs.scenes, '--layouts-dir', dirs.layouts,
    '--renders-dir', dirs.renders, '--rooms-dir', path.join(dirs.renders, '..', 'rooms'), '--library-dir', dirs.library, '--calib', STUB_CALIB, '--daily-spend-usd', '0.02'])
  let log = ''
  const proc = spawn(cmd, argv, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] })
  proc.stdout.on('data', (d) => { log += d })
  proc.stderr.on('data', (d) => { log += d })
  const srv = { base, port, dirs, up: false, why: '', exited: null }
  proc.on('exit', (code, sig) => { srv.exited = { code, sig } })
  srv.stop = async () => {
    if (srv.exited == null) { proc.kill('SIGTERM'); for (let i = 0; i < 25 && srv.exited == null; i++) await sleep(100); if (srv.exited == null) proc.kill('SIGKILL') }
    fs.writeFileSync(path.join(data, 'server.log'), log)
  }
  ev.onCleanup(srv.stop)
  for (let i = 0; i < 100 && srv.exited == null; i++) {
    const r = await raw(base, 'GET', '/planner/', { timeoutMs: 2000 })
    if (r.status) { srv.up = true; break }
    await sleep(150)
  }
  if (!srv.up) srv.why = `the server did not start: ${log.trim().split('\n').slice(-3).join(' | ')}`
  return srv
}

let base = null
let srv
const present = golden.pages.filter((g) => LIVE || fs.existsSync(path.join(REPO, 'fixtures/pages', g.id, 'page.html')))
for (const g of golden.pages) if (!present.includes(g)) ev.skip(g.id, `no snapshot in fixtures/pages/${g.id}/ (git-ignored; fetch it again or run --live)`)
if (!LIVE) {
  const pages = await startPagesServer(snapshotPages(golden))
  ev.onCleanup(pages.stop)
  base = pages.base
  srv = await startServer(ev, { env: { MIDSTUDY_FETCH_ALLOW: `127.0.0.1:${pages.port}` } })
} else if (LLM) {
  srv = await startRealFalServer()
} else {
  srv = await startServer(ev)
}
ev.check(`the server starts (${mode})`, srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish(1)

const near = (got, want) => typeof got === 'number' && Math.abs(got - want) <= Math.max(1, Math.abs(want) * 0.015)
const dimsText = (cs) => (cs || []).map((c) => `${c.w}×${c.d}×${c.h ?? '–'} ${c.unit} ${c.source}`).join(', ') || 'none'
const shown = (want, got, pass) => (pass ? fmt(got) : `expected ${fmt(want)}, got ${fmt(got)}`)
let llmCost = 0
let first = true

for (const g of present) {
  const e = g.expect
  const url = LIVE ? g.url : base + new URL(g.url).pathname
  if (LIVE && !first) await sleep(3000) // Shopify rate-limits bursts from one address
  first = false
  ev.section(`${g.id}: ${url}`)
  const t0 = Date.now()
  const r = await api.send(srv.base, 'POST', '/api/library/product', { url, llm: LLM }, { timeoutMs: 120000 })
  const secs = ((Date.now() - t0) / 1000).toFixed(1)
  const j = r.json || {}
  const ok = (what, pass, want, got) => ev.check(`${g.id}: ${what}`, pass, shown(want, got, pass))
  if (e.blocked) {
    ok('the shop blocks: 422 with "blocked": true', r.status === 422 && j.blocked === true, '422 blocked', `${r.status} ${j.blocked ? 'blocked' : ''} in ${secs} s`)
    if (e.error) ok('the blocked sentence', typeof j.error === 'string' && j.error.includes(e.error), e.error, j.error)
    continue
  }
  if (LIVE && r.status === 422 && j.blocked) {
    console.log(`WARN ${g.id}: the shop now refuses automatic reading (${j.error}) — the shop changed; not counted`)
    continue
  }
  if (!ok(`answers 200 (${secs} s)`, r.status === 200, 200, `${r.status} ${r.status !== 200 ? r.text.slice(0, 200) : ''}`)) continue
  const cs = j.dims_candidates || []
  const c0 = cs[0] || {}
  if (e.name) ok(`name contains "${e.name}"`, typeof j.name === 'string' && j.name.includes(e.name), e.name, j.name)
  if (e.name_excludes) ok(`name leaves out "${e.name_excludes}"`, typeof j.name === 'string' && !j.name.includes(e.name_excludes), `no ${e.name_excludes}`, j.name)
  if (e.category !== undefined) ok(`category ${e.category}`, j.category === e.category, e.category, j.category)
  if (e.is_rug !== undefined) ok(`is_rug ${e.is_rug}`, j.is_rug === e.is_rug, e.is_rug, j.is_rug)
  if (e.dims) {
    const pass = e.dims.every(([w, d, h], i) => cs[i] && near(cs[i].w, w) && near(cs[i].d, d) && near(cs[i].h, h))
    ok(`sizes start ${e.dims.map((x) => x.join('×')).join(', ')}`, pass, e.dims.map((x) => x.join('×')).join(', '), dimsText(cs))
  }
  if (e.no_dims) ok('no size candidates', cs.length === 0, 'none', dimsText(cs))
  if (e.not_dims) {
    const hit = cs.filter((c) => e.not_dims.some(([w, d, h]) => near(c.w, w) && near(c.d, d) && near(c.h, h)))
    ok(`leaves out ${e.not_dims.map((x) => x.join('×')).join(', ')}`, hit.length === 0, 'none of them', dimsText(hit))
  }
  if (e.unit) ok(`unit ${e.unit}`, c0.unit === e.unit, e.unit, `${c0.unit} (${c0.unit_note})`)
  if (e.source) ok(`first size from ${e.source}`, c0.source === e.source, e.source, c0.source)
  if (e.variants) {
    const labels = (j.variants || []).map((v) => v.label)
    ok(`variants ${fmt(e.variants)}`, fmt(labels) === fmt(e.variants), e.variants, labels)
  }
  if (e.image0) ok(`first picture is …${e.image0}…`, !!j.images?.[0] && j.images[0].url.includes(e.image0), e.image0, j.images?.[0]?.url)
  if (e.layers) ok(`layers include ${fmt(e.layers)}`, e.layers.every((l) => (j.source_layers_used || []).includes(l)), e.layers, j.source_layers_used)
  if (!LLM) ok('the language model was not asked (llm: false)', !(j.source_layers_used || []).includes('llm') && j.cost_usd === 0, 'no llm, $0', `${fmt(j.source_layers_used)}, $${j.cost_usd}`)
  if ((j.source_layers_used || []).includes('llm')) {
    llmCost += j.cost_usd || 0
    console.log(`COST ${g.id}: the language model cost $${j.cost_usd} (mock ${j.mock}); sizes ${dimsText(cs)}`)
  }
  if ((j.warnings || []).length) ev.note(`warnings: ${fmt(j.warnings)}`)
}

if (LLM) {
  const rows = fs.readFileSync(srv.dirs.costs, 'utf8').trim().split('\n').slice(1)
  console.log(`COST total: $${llmCost.toFixed(6)} over ${rows.length} product:llm row(s) in ${path.relative(REPO, srv.dirs.costs)} (not the repo's library/costs.csv)`)
}
await ev.finish()
