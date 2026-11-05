// E14 eval:product — the product page reader (contract §2.11, §2.9 Page fetches), no browser, $0.
// The synthetic shop pages in fixtures/product-pages/ are served on one local port by evals/lib/pages_server.mjs, which
// serve.py may reach only through MIDSTUDY_FETCH_ALLOW=127.0.0.1:<port>. The language model is mocked
// (fixtures/fal/openrouter-router/), and MIDSTUDY_FAL_MOCK_LOG records what would have been sent to it.
// Checks: every manifest case against its "expect"; every refused_urls entry is 400 within 3 s with no connection;
// forged requests are 403; what reached the pages server (no pictures, no cookies, the honest User-Agent, feeds only to
// the page's origin); the prompt (markers, cap, neutralized "</page>", no secrets); cost rows; the spend cap (0.0015
// and 0.03 with MIDSTUDY_FAL_MOCK_COST=1); llm:false; GET /api/spend; the server stays responsive during a slow page;
// reads add nothing to the library.
// Usage: node evals/product_extract.mjs   (or npm run eval:product)
import fs from 'node:fs'
import path from 'node:path'
import { createEval, startServer, api, raw, sleep, fmt } from './lib/harness.mjs'
import { syntheticPages, startPagesServer } from './lib/pages_server.mjs'

const UA = 'midstudy/1.0 (product page reader)'
const KEYS = ['url', 'name', 'category', 'is_rug', 'dims_candidates', 'variants', 'images', 'source_layers_used', 'cost_usd', 'mock', 'warnings']
const CAND_KEYS = ['w', 'd', 'h', 'unit', 'label', 'unit_note', 'notes', 'quote', 'source']
const LONG_SLUG = 'long-oak-bench-story'

const ev = createEval('E14', 'product', { timeoutS: 900 })
const synth = syntheticPages()
// One extra page made here (not a fixture): 60,000 characters of prose with the only size word near the end, to check
// the prompt's 20,000-character cap and that the parts around size words come first.
const filler = Array.from({ length: 600 }, (_, i) => `<p>Paragraph ${i + 1} of the maker's story: oak from the hills, dried slowly, planed by hand and oiled twice.</p>`).join('\n')
const longPage = `<!doctype html><html><head><meta charset="utf-8"><title>Long Oak Bench</title><meta property="og:image" content="/media/long-oak-bench.jpg"></head>` +
  `<body><h1>Long Oak Bench</h1>${filler}<p>Dimensions are on the drawing we send with the order.</p></body></html>`
const pages = await startPagesServer({ routes: [...synth.routes, { path: `/products/${LONG_SLUG}`, body: longPage }], dir: synth.dir })
ev.onCleanup(pages.stop)
const allow = `127.0.0.1:${pages.port}`
const mockLog = path.join(ev.out, 'fal-mock-1.jsonl')
const srv = await startServer(ev, { env: { MIDSTUDY_FETCH_ALLOW: allow, MIDSTUDY_FAL_MOCK_LOG: mockLog } })
ev.check('serve.py starts with MIDSTUDY_FETCH_ALLOW for the pages server', srv.up, srv.up ? `${srv.base}, pages ${pages.base}` : srv.why)
if (!srv.up) await ev.finish(1)

const read = (base, url, extra = {}, o = {}) => api.send(base, 'POST', '/api/library/product', url === undefined ? extra : { url, ...extra }, { timeoutMs: 90000, ...o })
const timed = async (fn) => { const t0 = Date.now(); const r = await fn(); return { r, s: (Date.now() - t0) / 1000 } }
const near = (got, want, tol = 0.6) => typeof got === 'number' && Math.abs(got - want) <= Math.max(tol, Math.abs(want) * 0.01)
const dimsText = (cs) => (cs || []).map((c) => `${c.w}×${c.d}×${c.h ?? '–'} ${c.source}`).join(', ') || 'none'
const sub = (s, base) => s.replaceAll('{base}', base)
const csvRows = (file) => {
  if (!fs.existsSync(file)) return []
  const [head, ...rows] = fs.readFileSync(file, 'utf8').trim().split('\n')
  const cols = head.split(',')
  return rows.filter(Boolean).map((line) => {
    const v = line.split(',')
    return Object.fromEntries(cols.map((c, i) => [c, i === cols.length - 1 ? v.slice(i).join(',') : v[i]]))
  })
}
const libState = (dir) => {
  const lib = path.join(dir, 'library.json')
  return { json: fs.existsSync(lib) ? fs.readFileSync(lib, 'utf8') : null, entries: fs.readdirSync(dir).filter((f) => !f.startsWith('costs.csv') && f !== '.lock').sort().join(',') }
}

// Checks one 200 answer has every key and the right shapes (§2.11).
function shapeProblems(j) {
  const bad = []
  for (const k of KEYS) if (!(k in (j || {}))) bad.push(`missing ${k}`)
  if (!j) return bad
  if (!Array.isArray(j.dims_candidates) || j.dims_candidates.length > 16) bad.push('dims_candidates not a list of ≤ 16')
  for (const c of j.dims_candidates || []) {
    for (const k of CAND_KEYS) if (!(k in c)) bad.push(`candidate missing ${k}`)
    if (!(c.w > 0 && c.d > 0) || !(c.h === null || c.h > 0)) bad.push(`bad size ${fmt(c)}`)
    if (!['cm', 'mm', 'm', 'in', 'ft'].includes(c.unit)) bad.push(`unit ${c.unit}`)
    if (!['jsonld', 'microdata', 'shopify', 'woocommerce', 'text', 'llm'].includes(c.source)) bad.push(`source ${c.source}`)
    if (typeof c.quote !== 'string' || c.quote.length > 200) bad.push('quote not ≤ 200 chars')
    if (j.is_rug && c.h === null) bad.push('rug without h')
  }
  if (!Array.isArray(j.images) || j.images.length > 12) bad.push('images not a list of ≤ 12')
  for (const im of j.images || []) {
    if (!/^https?:\/\//.test(im.url)) bad.push(`image ${im.url}`)
    if (!['product', 'variant', 'og', 'page'].includes(im.kind)) bad.push(`kind ${im.kind}`)
    if (!('w' in im && 'h' in im)) bad.push('image w/h missing')
  }
  for (const v of j.variants || []) if (!('label' in v && 'dims_index' in v)) bad.push('variant keys')
  if (typeof j.cost_usd !== 'number' || typeof j.mock !== 'boolean' || !Array.isArray(j.warnings)) bad.push('cost/mock/warnings types')
  return bad
}

function checkCase(id, e, r, secs, base) {
  const j = r.json || {}
  const c0 = (j.dims_candidates || [])[0] || {}
  const ok = (what, pass, measured) => ev.check(`${id}: ${what}`, pass, measured)
  ok(`answers ${e.status}`, r.status === e.status, `HTTP ${r.status} in ${secs.toFixed(1)} s ${r.status !== 200 ? r.text.slice(0, 160) : ''}`)
  if (r.status === 200 && e.status === 200) {
    const bad = shapeProblems(j)
    ok('the answer has every §2.11 key and shape', bad.length === 0, bad.length ? bad.slice(0, 5).join('; ') : 'ok')
  }
  if (e.name !== undefined) ok(`name contains "${e.name}"`, typeof j.name === 'string' && j.name.includes(e.name), j.name)
  if (e.name_excludes) ok(`name leaves out "${e.name_excludes}"`, typeof j.name === 'string' && !j.name.includes(e.name_excludes), j.name)
  if (e.category !== undefined) ok(`category ${e.category}`, j.category === e.category, j.category)
  if (e.is_rug !== undefined) ok(`is_rug ${e.is_rug}`, j.is_rug === e.is_rug, j.is_rug)
  if (e.dims && e.dims.length) {
    const cs = j.dims_candidates || []
    const pass = e.dims.every(([w, d, h], i) => cs[i] && near(cs[i].w, w) && near(cs[i].d, d) && near(cs[i].h, h))
    ok(`sizes start ${e.dims.map((x) => x.join('×')).join(', ')}`, pass, dimsText(cs))
  }
  if (e.no_dims) ok('no size candidates', (j.dims_candidates || []).length === 0, dimsText(j.dims_candidates))
  if (e.not_dims) {
    const hit = (j.dims_candidates || []).filter((c) => e.not_dims.some(([w, d, h]) => near(c.w, w) && near(c.d, d) && near(c.h, h)))
    ok(`leaves out ${e.not_dims.map((x) => x.join('×')).join(', ')}`, hit.length === 0, dimsText(j.dims_candidates))
  }
  if (e.source) ok(`first size from ${e.source}`, c0.source === e.source, c0.source)
  if (e.unit) ok(`unit ${e.unit}`, c0.unit === e.unit, `${c0.unit} (${c0.unit_note})`)
  if (e.note) ok(`a note says "${e.note}"`, (c0.notes || []).some((n) => n.toLowerCase().includes(e.note)), c0.notes)
  if (e.unit_note) ok(`unit_note mentions "${e.unit_note}"`, typeof c0.unit_note === 'string' && c0.unit_note.includes(e.unit_note), c0.unit_note)
  if (e.variants) {
    const labels = (j.variants || []).map((v) => v.label)
    const idx = (j.variants || []).map((v) => v.dims_index)
    ok(`variants ${fmt(e.variants)}, each with its size`, fmt(labels) === fmt(e.variants) && idx.every((x, i) => x === i), `${fmt(labels)} → ${fmt(idx)}`)
  }
  if (e.layer) ok(`layers include ${e.layer}`, (j.source_layers_used || []).includes(e.layer), j.source_layers_used)
  const imgs = j.images || []
  if (e.image0) ok(`first picture is …${e.image0}`, !!imgs[0] && imgs[0].url.includes(sub(e.image0, base)), imgs[0]?.url)
  if (e.image0_size) ok(`first picture's size ${e.image0_size.join('×')}`, imgs[0]?.w === e.image0_size[0] && imgs[0]?.h === e.image0_size[1], `${imgs[0]?.w}×${imgs[0]?.h}`)
  if (e.image0_https) ok('first picture is https', !!imgs[0] && imgs[0].url.startsWith('https://'), imgs[0]?.url)
  if (e.images) {
    const want = e.images.map((s) => sub(s, base))
    ok('pictures in order', want.every((s, i) => imgs[i] && imgs[i].url.includes(s)), imgs.map((x) => x.url))
  }
  if (e.images_count !== undefined) ok(`${e.images_count} pictures`, imgs.length === e.images_count, imgs.length)
  if (e.images_exclude) ok(`no picture link has ${fmt(e.images_exclude)}`, imgs.every((im) => e.images_exclude.every((x) => !im.url.includes(x))), imgs.map((x) => x.url))
  if (e.llm !== undefined) ok(e.llm ? 'the language model was asked' : 'the language model was not asked', (j.source_layers_used || []).includes('llm') === e.llm, j.source_layers_used)
  if (e.mock !== undefined) ok(`mock ${e.mock}`, j.mock === e.mock, j.mock)
  if (e.cost_usd !== undefined) ok(`cost_usd ${e.cost_usd}`, j.cost_usd === e.cost_usd, j.cost_usd)
  if (e.warning) ok(`a warning mentions "${e.warning}"`, (j.warnings || []).some((w) => w.toLowerCase().includes(e.warning.toLowerCase())), j.warnings)
  if (e.url_ends) ok(`url ends ${e.url_ends}`, typeof j.url === 'string' && j.url.endsWith(e.url_ends), j.url)
  if (e.max_s !== undefined) ok(`answers within ${e.max_s} s`, secs <= e.max_s, `${secs.toFixed(1)} s`)
  if (e.blocked !== undefined) ok(`blocked: ${e.blocked}`, (j.blocked === true) === e.blocked, fmt(j))
  if (e.error) ok(`error says "${e.error}"`, typeof j.error === 'string' && j.error.includes(e.error), j.error)
  if (e.no_cookie_sent) {
    const h = pages.hits.filter((x) => x.path === '/cookie-check')
    ok('no Cookie sent after a Set-Cookie', h.length > 0 && h.every((x) => !x.headers.cookie), h.map((x) => x.headers.cookie || 'none'))
  }
}

// --- 1. the manifest cases (slow and trickle together, with the responsiveness check, at the end) -------------------
ev.section('manifest cases (contract §2.11)')
const slowIds = ['slow', 'trickle']
const answers = {}
for (const [id, c] of Object.entries(synth.cases)) {
  if (slowIds.includes(id)) continue
  const { r, s } = await timed(() => read(srv.base, pages.base + c.path))
  answers[id] = r
  checkCase(id, c.expect, r, s, pages.base)
}

ev.section('a slow page never holds the server (§2.9: 20 s for the page)')
const slowRuns = slowIds.map((id) => timed(() => read(srv.base, pages.base + synth.cases[id].path)))
await sleep(1500)
const spendT = await timed(() => api.get(srv.base, '/api/spend', { timeoutMs: 5000 }))
const libT = await timed(() => api.get(srv.base, '/api/library', { timeoutMs: 5000 }))
ev.check('GET /api/spend answers within 1 s while /slow and /trickle are read', spendT.r.status === 200 && spendT.s < 1, `HTTP ${spendT.r.status} in ${spendT.s.toFixed(2)} s`)
ev.check('GET /api/library answers within 1 s meanwhile', libT.r.status === 200 && libT.s < 1, `HTTP ${libT.r.status} in ${libT.s.toFixed(2)} s`)
const slowDone = await Promise.all(slowRuns)
slowIds.forEach((id, i) => checkCase(id, synth.cases[id].expect, slowDone[i].r, slowDone[i].s, pages.base))

// --- 2. refused links ---------------------------------------------------------------------------------------------------
ev.section('refused links: 400 within 3 s, nothing fetched (§2.9)')
const hitsBefore = pages.hits.length
for (const u of synth.refused) {
  const url = u.replaceAll('{pages_port}', String(pages.port)).replaceAll('{serve_port}', String(srv.port))
  const { r, s } = await timed(() => read(srv.base, url, {}, { timeoutMs: 10000 }))
  ev.check(`refused: ${url}`, r.status === 400 && s < 3 && typeof r.json?.error === 'string', `HTTP ${r.status} in ${s.toFixed(2)} s: ${r.json?.error}`)
}
ev.check('the pages server got no request from the refused links', pages.hits.length === hitsBefore, `${pages.hits.length - hitsBefore} requests`)
for (const [what, body] of [['no url', {}], ['url not a string', { url: 5 }], ['llm not a boolean', { url: `${pages.base}/products/oak-writing-desk`, llm: 'no' }]]) {
  const r = await read(srv.base, undefined, body)
  ev.check(`400 for a body with ${what}`, r.status === 400 && typeof r.json?.error === 'string', `HTTP ${r.status}: ${r.json?.error}`)
}
const notJson = await raw(srv.base, 'POST', '/api/library/product', { headers: { 'X-Midstudy': '1', 'Content-Type': 'application/json' }, body: 'not json' })
ev.check('400 for a body that is not JSON', notJson.status === 400, `HTTP ${notJson.status}: ${notJson.json?.error}`)

ev.section('forged requests (§2.9 W1)')
const deskUrl = `${pages.base}/products/oak-writing-desk`
const hitsBeforeForged = pages.hits.length
const forged = await read(srv.base, deskUrl, {}, { forged: true })
ev.check('no X-Midstudy → 403, nothing fetched', forged.status === 403, `HTTP ${forged.status}: ${forged.json?.error}`)
const foreign = await read(srv.base, deskUrl, {}, { headers: { Origin: 'http://evil.example' } })
ev.check('a foreign Origin → 403, nothing fetched', foreign.status === 403, `HTTP ${foreign.status}: ${foreign.json?.error}`)
const badHost = await read(srv.base, deskUrl, {}, { headers: { Host: 'evil.example' } })
ev.check('a foreign Host → 403', badHost.status === 403, `HTTP ${badHost.status}: ${badHost.json?.error}`)
ev.check('the forged requests fetched nothing', pages.hits.length === hitsBeforeForged, `${pages.hits.length - hitsBeforeForged} requests`)
const sameOrigin = await read(srv.base, deskUrl, {}, { headers: { Origin: srv.base } })
ev.check('the page\'s own Origin is fine', sameOrigin.status === 200, `HTTP ${sameOrigin.status}`)

// --- 3. llm: false, the long page --------------------------------------------------------------------------------------
ev.section('llm: false and the prompt cap')
const costsBefore = csvRows(srv.dirs.costs).length
const logBefore = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).length : 0
const noLlm = await read(srv.base, `${pages.base}${synth.cases['prose-llm'].path}`, { llm: false })
ev.check('llm:false on the prose page → 200 without the model', noLlm.status === 200 && !(noLlm.json?.source_layers_used || []).includes('llm') && (noLlm.json?.dims_candidates || []).length === 0,
  `HTTP ${noLlm.status}, layers ${fmt(noLlm.json?.source_layers_used)}, sizes ${dimsText(noLlm.json?.dims_candidates)}`)
ev.check('llm:false → a warning says the size was not found', (noLlm.json?.warnings || []).some((w) => /size/i.test(w)), noLlm.json?.warnings)
ev.check('llm:false → no cost row, no model call', csvRows(srv.dirs.costs).length === costsBefore &&
  (fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).length : 0) === logBefore, `${csvRows(srv.dirs.costs).length - costsBefore} rows`)
const long = await read(srv.base, `${pages.base}/products/${LONG_SLUG}`)
ev.check('a 60,000-character page without a size → 200, the model asked', long.status === 200 && (long.json?.source_layers_used || []).includes('llm'), `HTTP ${long.status}, ${fmt(long.json?.source_layers_used)}`)

// --- 4. what reached the pages server ------------------------------------------------------------------------------------
ev.section('what reached the shop (pages server)')
const pics = pages.hits.filter((h) => /^\/(media|cdn\/files|images)\//.test(h.path))
ev.check('the server never downloaded a picture', pics.length === 0, pics.length ? pics.map((h) => h.path).slice(0, 5) : `${pages.hits.length} requests, none for /media/, /cdn/files/, /images/`)
const cookies = pages.hits.filter((h) => h.headers.cookie)
ev.check('no request carried a Cookie header', cookies.length === 0, cookies.length ? cookies.map((h) => `${h.path}: ${h.headers.cookie}`) : 'none')
const uas = [...new Set(pages.hits.map((h) => h.headers['user-agent']))]
ev.check(`every request said User-Agent: ${UA}`, uas.length === 1 && uas[0] === UA, uas)
const feeds = pages.hits.filter((h) => h.path.endsWith('.js') || h.path.startsWith('/wp-json/')).map((h) => h.path + h.query)
// one request per read of a Shopify or WooCommerce page (the Moss rug is read twice: plain and with ?variant=2)
const wantFeeds = { '/products/moss-wool-rug.js': 2, '/wp-json/wc/store/v1/products?slug=walnut-sideboard': 1, '/wp-json/wc/store/v1/products?slug=silk-carpet-rose': 1,
  '/wp-json/wc/store/v1/products?slug=wool-carpet-sand': 1, '/products/deep-feed-stool.js': 1 }
ev.check('feeds: one request per read, to the page\'s own origin, only for Shopify and WooCommerce pages',
  Object.entries(wantFeeds).every(([f, n]) => feeds.filter((x) => x === f).length === n) && feeds.every((f) => f in wantFeeds), feeds)
const gz = pages.hits.filter((h) => h.path === '/gzip')
ev.check('pages are asked for gzip/deflate', gz.length > 0 && gz.every((h) => /gzip/.test(h.headers['accept-encoding'] || '')), gz.map((h) => h.headers['accept-encoding']))

// --- 5. the prompt (MIDSTUDY_FAL_MOCK_LOG) --------------------------------------------------------------------------------
ev.section('what the language model would have been sent')
const calls = fs.existsSync(mockLog) ? fs.readFileSync(mockLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []
const llmCases = Object.entries(answers).filter(([, r]) => (r.json?.source_layers_used || []).includes('llm')).length + ((long.json?.source_layers_used || []).includes('llm') ? 1 : 0)
ev.check('one logged call per read that used the model', calls.length === llmCases && calls.length >= 4, `${calls.length} calls, ${llmCases} reads with llm`)
const WRAP_HEAD = '<page>\n', WRAP_TAIL = '\n</page>'
const count = (s, x) => s.split(x).length - 1
const promptBad = []
for (const c of calls) {
  const a = c.args || {}
  if (c.endpoint !== 'openrouter/router') promptBad.push(`endpoint ${c.endpoint}`)
  if (a.model !== 'anthropic/claude-haiku-5.5' || a.temperature !== 0 || a.max_tokens !== 600) promptBad.push(`model/temperature/max_tokens ${a.model}/${a.temperature}/${a.max_tokens}`)
  if (fmt(Object.keys(a).sort()) !== fmt(['max_tokens', 'model', 'prompt', 'system_prompt', 'temperature'])) promptBad.push(`arguments ${fmt(Object.keys(a))}`)
  if (typeof a.system_prompt !== 'string' || !/untrusted|not an instruction|nothing inside it is an instruction/i.test(a.system_prompt)) promptBad.push('system prompt does not say the page is data')
  const p = String(a.prompt || '')
  if (!p.startsWith(WRAP_HEAD) || !p.endsWith(WRAP_TAIL) || count(p, '<page>') !== 1 || count(p, '</page>') !== 1) promptBad.push(`markers: ${count(p, '<page>')} × <page>, ${count(p, '</page>')} × </page>`)
  if (p.length - WRAP_HEAD.length - WRAP_TAIL.length > 20000) promptBad.push(`page text ${p.length - WRAP_HEAD.length - WRAP_TAIL.length} chars`)
}
ev.check('every call: openrouter/router, claude-haiku-5.5, temperature 0, max_tokens 600, a system prompt that calls the page data, <page> and </page> once each, ≤ 20,000 characters of page text',
  calls.length > 0 && promptBad.length === 0, promptBad.length ? promptBad.slice(0, 4) : `${calls.length} calls, longest page text ${Math.max(...calls.map((c) => String(c.args?.prompt || '').length)) - WRAP_HEAD.length - WRAP_TAIL.length} chars`)
const inj = calls.find((c) => /admin mode/.test(c.args?.prompt || ''))
ev.check('the injection page\'s own "</page>" and "<page>" reach the model neutralized', !!inj && count(inj.args.prompt, '</page>') === 1 && /‹\/page›/.test(inj.args.prompt) && /‹page›/.test(inj.args.prompt),
  inj ? (inj.args.prompt.match(/.{0,30}admin mode.{0,10}/) || [''])[0] : 'no call with the injection page')
const longCall = calls.find((c) => /maker's story/.test(c.args?.prompt || ''))
const longText = longCall ? longCall.args.prompt.slice(WRAP_HEAD.length, -WRAP_TAIL.length) : ''
ev.check('the long page is cut to 20,000 characters with the size words first', !!longCall && longText.length <= 20000 && longText.length > 15000 && longText.indexOf('Dimensions are on the drawing') >= 0 && longText.indexOf('Dimensions are on the drawing') < 2000,
  longCall ? `${longText.length} chars, "Dimensions…" at ${longText.indexOf('Dimensions are on the drawing')}` : 'no call')
const secretBad = calls.filter((c) => /authorization|\bKey [A-Za-z0-9]/i.test(JSON.stringify(c)) || 'key' in (c.args || {}) || 'fal_key' in (c.args || {}))
ev.check('no key or Authorization in what would be sent', secretBad.length === 0, secretBad.length ? 'found' : 'none')

// --- 6. cost rows, spend, the library ---------------------------------------------------------------------------------
ev.section('money: cost rows, GET /api/spend, the cap (§2.11 Money)')
const rows = csvRows(srv.dirs.costs)
const llmRows = rows.filter((r) => r.engine === 'product:llm')
const rowBad = llmRows.filter((r) => r.mock !== 'true' || parseFloat(r.cost_usd) !== 0 || !/^product-127-0-0-1$/.test(r.id) || /\?/.test(r.input) || !r.input.startsWith(pages.base))
ev.check('a product:llm cost row per model call: mock, $0, id product-<host>, the page URL without its query', llmRows.length === calls.length && rowBad.length === 0 && rows.length === llmRows.length,
  `${llmRows.length} rows for ${calls.length} calls; ${rows.length - llmRows.length} other rows; e.g. ${fmt(llmRows[0])}`)
const spend = await api.get(srv.base, '/api/spend')
ev.check('GET /api/spend: reads cost nothing and leave nothing reserved', spend.status === 200 && spend.json?.spent_usd === 0 && spend.json?.reserved_usd === 0, fmt(spend.json))
const jobs = await api.get(srv.base, '/api/library/jobs')
ev.check('reads start no library job', jobs.status === 200 && (jobs.json?.jobs || []).length === 0, `${(jobs.json?.jobs || []).length} jobs`)

const prosePath = synth.cases['prose-llm'].path
const tight = await startServer(ev, { spendUsd: '0.0015', mockCost: true, env: { MIDSTUDY_FETCH_ALLOW: allow, MIDSTUDY_FAL_MOCK_LOG: path.join(ev.out, 'fal-mock-2.jsonl') } })
if (tight.up) {
  const lib0 = libState(tight.dirs.library)
  const r = await read(tight.base, pages.base + prosePath)
  ev.check('cap $0.0015 (mock costs on): the prose page → 200 with a budget warning, no model', r.status === 200 && (r.json?.warnings || []).some((w) => /budget/i.test(w)) && !(r.json?.source_layers_used || []).includes('llm'),
    `HTTP ${r.status}, ${fmt(r.json?.warnings)}, ${fmt(r.json?.source_layers_used)}`)
  ev.check('cap $0.0015: no cost row, no logged call', csvRows(tight.dirs.costs).length === 0 && !fs.existsSync(path.join(ev.out, 'fal-mock-2.jsonl')), `${csvRows(tight.dirs.costs).length} rows`)
  const desk = await read(tight.base, deskUrl)
  ev.check('cap $0.0015: a page with its size still reads (no model needed)', desk.status === 200 && (desk.json?.dims_candidates || []).length > 0, `HTTP ${desk.status}`)
  const sp = await api.get(tight.base, '/api/spend')
  ev.check('cap $0.0015: nothing spent or held', sp.json?.spent_usd === 0 && sp.json?.reserved_usd === 0, fmt(sp.json))
  const lib1 = libState(tight.dirs.library)
  ev.check('cap $0.0015: the library is untouched by reads', lib0.json === lib1.json && lib0.entries === lib1.entries, lib1.entries)
  await tight.stop()
} else ev.check('second server (cap $0.0015) starts', false, tight.why)

const roomy = await startServer(ev, { spendUsd: '0.03', mockCost: true, env: { MIDSTUDY_FETCH_ALLOW: allow, MIDSTUDY_FAL_MOCK_LOG: path.join(ev.out, 'fal-mock-3.jsonl') } })
if (roomy.up) {
  const lib0 = libState(roomy.dirs.library)
  const r = await read(roomy.base, pages.base + prosePath)
  ev.check('cap $0.03 (mock costs on): the model is asked and finds 90×40×120', r.status === 200 && (r.json?.source_layers_used || []).includes('llm') && near(r.json?.dims_candidates?.[0]?.w, 90) && r.json?.dims_candidates?.[0]?.source === 'llm',
    `HTTP ${r.status}, ${dimsText(r.json?.dims_candidates)}, ${fmt(r.json?.source_layers_used)}`)
  ev.check('cap $0.03: cost_usd 0.001, mock true', r.json?.cost_usd === 0.001 && r.json?.mock === true, `${r.json?.cost_usd}, mock ${r.json?.mock}`)
  const rr = csvRows(roomy.dirs.costs)
  ev.check('cap $0.03: one product:llm row of $0.001, mock true', rr.length === 1 && rr[0].engine === 'product:llm' && parseFloat(rr[0].cost_usd) === 0.001 && rr[0].mock === 'true', fmt(rr))
  const sp = await api.get(roomy.base, '/api/spend')
  ev.check('cap $0.03: GET /api/spend shows the $0.001 and nothing held', Math.abs((sp.json?.spent_usd ?? -1) - 0.001) < 1e-9 && sp.json?.reserved_usd === 0, fmt(sp.json))
  const lib1 = libState(roomy.dirs.library)
  ev.check('cap $0.03: the library is untouched by reads (only costs.csv)', lib0.json === lib1.json && lib0.entries === lib1.entries, lib1.entries)
  await roomy.stop()
} else ev.check('third server (cap $0.03) starts', false, roomy.why)

// --- 7. verify round fixes (2026-11-05): a link's user:password never kept; CPU-heavy pages never hold the server ------
ev.section('verify round: user:password in a link, a CPU-heavy page')
const ogPath = synth.cases['og-only'].path
const withUser = await read(srv.base, `http://shopper:hunter2@127.0.0.1:${pages.port}${ogPath}#frag`)
ev.check('a link with user:password@ reads, and the answer\'s url leaves them out', withUser.status === 200 && typeof withUser.json?.url === 'string' && !/hunter2|shopper@/.test(withUser.json.url),
  `HTTP ${withUser.status}, url ${withUser.json?.url}`)
const lastRow = csvRows(srv.dirs.costs).at(-1)
ev.check('…and its cost row leaves them out too (costs.csv is in git)', !!lastRow && lastRow.engine === 'product:llm' && !/hunter2|shopper/.test(lastRow.input) && lastRow.input.endsWith(ogPath),
  fmt(lastRow))
const heavy = timed(() => read(srv.base, `${pages.base}/products/digits-chair`))
await sleep(150)
const pings = []
for (let i = 0; i < 4; i++) { pings.push(await timed(() => api.get(srv.base, '/api/spend', { timeoutMs: 10000 }))); await sleep(100) }
const heavyDone = await heavy
const worst = Math.max(...pings.map((p) => p.s))
ev.check('a page with a 12,000-digit run and 20,000 escaped quotes reads in under 8 s', heavyDone.r.status === 200 && heavyDone.s < 8, `HTTP ${heavyDone.r.status} in ${heavyDone.s.toFixed(2)} s`)
ev.check('…and GET /api/spend answers within 1 s meanwhile', pings.every((p) => p.r.status === 200) && worst < 1, `slowest ${worst.toFixed(2)} s`)

const lib = libState(srv.dirs.library)
const libJson = JSON.parse(lib.json || '{"items":[]}')
ev.check('the scratch library still holds only the probe box', (libJson.items || []).length === 1 && libJson.items[0].id === 'probe-box', lib.entries)
const log = srv.log()
ev.check('no traceback in the server log', !/Traceback|Exception in thread/.test(log), (log.match(/.*(Traceback|Exception).*/) || ['none'])[0])
await ev.finish()
