// E14 eval:product-ui — Add furniture's Product page source (contract §2.11 Planner, §2.4 readProductPage), desktop
// 1280 × 800 and phone 390 × 844 (touch: taps). The synthetic shop pages (fixtures/product-pages/) are served by
// evals/lib/pages_server.mjs on one local port, which serve.py may fetch through MIDSTUDY_FETCH_ALLOW. fal is mocked, $0.
// On each device: Product page is the default source; reading the rug page shows the loading state, then 3 sizes, Flat
// rug, H 0.8 and 3 pictures; picking size 2 fills 200 × 300 and picking picture 2 marks it; the notes say where it came
// from; nothing is added and no picture is fetched by the server before Make; Make sends the chosen picture and size
// through the image-link add and the job ends done. Then the chair page (76 × 84 × 98, not a rug), a typed name that
// survives re-reads, the blocked page (the contract's sentence, Use Image link instead), the prose page (a language
// model, mocked), the model's cost in the notes, a picture that fails to load, and the readProductPage hook.
// Phone: the 44 px audit and the no-horizontal-scroll check at each stage. Screenshots: evals/out/product-ui/.
// Usage: node evals/product_ui.mjs [--stub]   (npm run eval:product-ui)
//   --stub answers POST /api/library/product inside the browser (playwright page.route) with contract-shaped bodies
//   written from the manifest's expectations, to check the form before the server's route exists. The default mode
//   uses the real server; Make always goes to the real server's from-URL add.
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, createEval, startServer, launchBrowser, openPlanner, hook, fmt, api, waitFor, sleep, seedScene, control,
  smallTargets, horizontalScroll,
} from './lib/harness.mjs'
import { syntheticPages, startPagesServer } from './lib/pages_server.mjs'

const STUB = process.argv.includes('--stub')
const ev = createEval('E14', 'product-ui', { timeoutS: 900 })
const SYN = syntheticPages()
const C = SYN.cases
const MEDIA_JPEG = fs.readFileSync(path.join(REPO, 'fixtures/fal/sam-3-3d-objects/input.jpg'))
const BLOCKED = C.blocked.expect.error
const near = (a, b, tol = 0.05) => Number.isFinite(+a) && Math.abs(+a - b) <= tol
ev.note(`mode: ${STUB ? '--stub (POST /api/library/product answered in the browser)' : 'real server route'}`)

const pages = await startPagesServer(SYN)
ev.onCleanup(() => pages.stop())
const P = pages.base
const URLS = {
  rug: `${P}${C['ui-rug'].path}`, chair: `${P}${C['ui-chair'].path}`, prose: `${P}${C['prose-llm'].path}`, blocked: `${P}${C.blocked.path}`,
}
const RUG = C['ui-rug'].expect, CHAIR = C['ui-chair'].expect
const rugPics = RUG.images.map((s) => s.replace('{base}', P))

const srv = await startServer(ev, { env: { MIDSTUDY_FETCH_ALLOW: `127.0.0.1:${pages.port}` } })
ev.check('serve.py starts (fal mocked, MIDSTUDY_FETCH_ALLOW = the pages server)', srv.up, srv.up ? `${srv.base}; pages ${P}` : srv.why)
if (!srv.up) await ev.finish()
if (!STUB) {
  const r = await api.send(srv.base, 'POST', '/api/library/product', { url: URLS.chair })
  ev.check('the server answers POST /api/library/product (real mode)', r.status === 200 && r.json?.name, `${r.status} ${fmt(r.json ?? r.text).slice(0, 200)}`)
  if (r.status === 404 || r.status === 405 || r.status === 0) ev.note('the route is missing: run with --stub to check the form alone')
}
const S = await seedScene(srv, 'living-wide', 'Living room')
ev.check('a scene to work in (golden living-wide, stub calibration)', S.name && !S.why, S.why || S.name)
const browser = await launchBrowser(ev)

// --- the contract-shaped answers for --stub (contract §2.11 200 body: every key present) -------------------------------------------
function stubAnswer(pageUrl) {
  let u
  try { u = new URL(pageUrl) } catch { return { status: 400, json: { error: 'that isn’t a link: paste the page’s https:// address' } } }
  const base = u.origin
  const cands = (dims, f = () => ({})) => dims.map(([w, d, h], i) => ({ w, d, h, unit: 'cm', label: null, unit_note: null, notes: [], quote: '', source: 'jsonld', ...f(i) }))
  const imgs = (list) => list.map((s) => ({ url: s.replace('{base}', base), w: null, h: null, kind: 'product' }))
  const body = (o) => ({ url: pageUrl, name: null, category: null, is_rug: false, dims_candidates: [], variants: [], images: [], source_layers_used: [], cost_usd: 0, mock: false, warnings: [], ...o })
  if (u.pathname === C['ui-rug'].path) {
    return { status: 200, json: body({ name: RUG.name, category: RUG.category, is_rug: true,
      dims_candidates: cands(RUG.dims, (i) => ({ label: RUG.variants[i], quote: RUG.variants[i] })),
      variants: RUG.variants.map((label, i) => ({ label, dims_index: i })), images: imgs(RUG.images), source_layers_used: ['jsonld', 'text'] }) }
  }
  if (u.pathname === C['ui-chair'].path) {
    return { status: 200, json: body({ name: CHAIR.name, category: CHAIR.category, dims_candidates: cands(CHAIR.dims, () => ({ quote: '"width":"76 cm"' })), images: imgs(CHAIR.images), source_layers_used: ['jsonld'] }) }
  }
  if (u.pathname === C['prose-llm'].path) {
    const e = C['prose-llm'].expect
    return { status: 200, json: body({ name: e.name, category: e.category,
      dims_candidates: cands(e.dims, () => ({ source: 'llm', quote: 'stands 120 tall, 90 across and 40 deep, all in centimetres' })),
      images: [{ url: 'https://oldharbour.example/stock/teak-cabinet.jpg', w: null, h: null, kind: 'og' }], source_layers_used: ['opengraph', 'llm'], mock: true }) }
  }
  if (u.pathname === C.blocked.path) return { status: 422, json: { error: BLOCKED, blocked: true } }
  return { status: 422, json: { error: 'that page answered 404 Not Found' } }
}

// --- page helpers ------------------------------------------------------------------------------------------------------------------
async function setup(device) {
  const O = await openPlanner(browser, srv.base, device === 'phone' ? { device, scene: S.name } : { scene: S.name })
  const page = O.page
  const ctl = { calls: [], delayMs: 0, patch: null }
  await page.route('**/api/library/product', async (route) => {
    let req = {}
    try { req = JSON.parse(route.request().postData() || '{}') } catch { /* not JSON */ }
    ctl.calls.push(req)
    const delay = ctl.delayMs
    ctl.delayMs = 0
    if (delay) await sleep(delay)
    const patch = ctl.patch
    if (STUB) {
      const a = stubAnswer(req.url)
      return route.fulfill({ status: a.status, contentType: 'application/json', body: JSON.stringify(a.status === 200 && patch ? patch(a.json) : a.json) })
    }
    if (!patch) return route.continue()
    const resp = await route.fetch()
    let json = null
    try { json = await resp.json() } catch { /* not JSON */ }
    return route.fulfill({ response: resp, json: resp.status() === 200 && json ? patch(json) : json })
  })
  // the browser stays on this machine: picture links to made-up shops (*.example) get the fixture picture
  await page.route(/^https?:\/\/[^/]*\.example\//, (route) => route.fulfill({ status: 200, contentType: 'image/jpeg', body: MEDIA_JPEG }))
  // a picture that fails to load (the broken-picture check)
  await page.route(`${P}/media/missing-picture.jpg`, (route) => route.fulfill({ status: 404, contentType: 'text/plain', body: 'gone' }))
  return { ...O, page, ctl, device }
}
const press = async (D, loc) => {
  if (!loc) return 'no control'
  await loc.scrollIntoViewIfNeeded().catch(() => {})
  return (D.device === 'phone' ? loc.tap({ timeout: 5000 }) : loc.click({ timeout: 5000 })).then(() => true, (e) => String(e).split('\n')[0])
}
const handle = (D, name, extra = '') => D.page.locator(`.ms-add [data-midstudy="${name}"]${extra}`).first()
const shot = (D, name) => D.page.screenshot({ path: path.join(ev.out, `${D.device}-${name}.png`) }).catch(() => {})
async function stage(D, label, name) {
  await sleep(250)
  await shot(D, name)
  const hs = await horizontalScroll(D.page)
  ev.check(`${D.device} ${label}: no horizontal page scroll`, hs.scrollWidth <= hs.innerWidth + 1 && hs.bodyScrollWidth <= hs.innerWidth + 1, fmt(hs))
  if (D.device === 'phone') {
    const small = await smallTargets(D.page).catch((e) => [`(audit failed: ${e})`])
    ev.check(`${D.device} ${label}: every visible target ≥ 44 × 44 px`, small.length === 0, small.length ? small.join('; ') : 'all ≥ 44')
  }
}
// Everything the form shows, in one round trip.
const form = (D) => D.page.evaluate(() => {
  const sheet = document.querySelector('.ms-add')
  if (!sheet) return null
  const $ = (sel) => sheet.querySelector(sel)
  const vis = (el) => !!el && !el.closest('[hidden]') && el.getClientRects().length > 0
  const val = (label) => sheet.querySelector(`input[aria-label="${label}"]`)?.value ?? null
  const pressed = (group) => sheet.querySelector(`[role="group"][aria-label="${group}"] > button[aria-pressed="true"]`)?.dataset.value ?? null
  const text = (sel) => (vis($(sel)) ? $(sel).innerText.trim().replace(/\s+/g, ' ') : '')
  const rb = $('[data-midstudy="product-read"]'), url = $('[data-midstudy="product-url"]'), go = $('.ms-foot .ms-primary')
  const st = $('[data-midstudy="product-status"]')
  const sheetRect = sheet.getBoundingClientRect(), strip = $('[data-midstudy="product-pic"]')?.parentElement
  return {
    source: pressed('Add from'), engine: pressed('Model'),
    name: val('Name'), w: val('Width in cm'), d: val('Depth in cm'), h: val('Height in cm'), category: val('Category'),
    url: url ? { visible: vis(url), type: url.type, inputmode: url.inputMode, value: url.value } : null,
    read: rb ? { visible: vis(rb), busy: rb.disabled, text: rb.textContent.trim(), spinner: !!rb.querySelector('svg.spin') } : null,
    status: text('[data-midstudy="product-status"]'), statusLive: st?.getAttribute('aria-live') ?? null,
    error: text('[data-midstudy="product-error"]'), useLink: vis($('[data-midstudy="product-use-link"]')),
    linkField: vis(sheet.querySelector('input[aria-label="Image link"]')), productBox: vis(url),
    sizes: [...sheet.querySelectorAll('[data-midstudy="product-size"]')].filter(vis).map((b) => ({ index: +b.dataset.index, pressed: b.getAttribute('aria-pressed') === 'true', text: b.innerText.trim().replace(/\s+/g, ' ') })),
    pics: [...sheet.querySelectorAll('[data-midstudy="product-pic"]')].map((b) => {
      const img = b.querySelector('img')
      return { index: +b.dataset.index, visible: vis(b), pressed: b.getAttribute('aria-pressed') === 'true', src: img?.getAttribute('src') ?? null,
        ref: img?.getAttribute('referrerpolicy') ?? null, alt: img?.alt ?? '', loading: img?.getAttribute('loading') ?? null, loaded: !!img && img.complete && img.naturalWidth > 0 }
    }),
    strip: strip ? (() => { const r = strip.getBoundingClientRect(); return { left: r.left, right: r.right, sheetLeft: sheetRect.left, sheetRight: sheetRect.right, scrolls: getComputedStyle(strip).overflowX } })() : null,
    notes: text('[data-midstudy="product-notes"]'),
    segs: [...sheet.querySelectorAll('[role="group"][aria-label="Add from"] > button')].map((b) => {
      const r = b.getBoundingClientRect()
      return { value: b.dataset.value, handle: b.dataset.midstudy, label: b.innerText.trim(), cut: b.scrollWidth > b.clientWidth + 1, h: Math.round(r.height), inside: r.left >= sheetRect.left - 0.5 && r.right <= sheetRect.right + 0.5 }
    }),
    go: go ? { text: go.textContent.trim(), disabled: go.disabled } : null,
  }
})
const waitRead = (D) => waitFor(async () => { const f = await form(D); return f?.read && !f.read.busy ? f : null }, { timeoutMs: 45000, intervalMs: 150 })
async function readLink(D, link, { enter = false } = {}) {
  const u = handle(D, 'product-url')
  await u.fill(link)
  if (enter) await u.press('Enter')
  else await press(D, handle(D, 'product-read'))
}
const media = () => pages.hits.filter((x) => x.path.startsWith('/media/'))
const serverMedia = () => media().filter((x) => /^midstudy/i.test(x.headers['user-agent'] || ''))
const jobs = async () => (await api.get(srv.base, '/api/library/jobs')).json?.jobs || []
async function openAdd(D) {
  await D.page.evaluate(() => window.midstudyCtx?.shell.openPanel('library')).catch(() => {})
  const add = await waitFor(async () => { const c = await control(D.page, 'lib-add', [/^add$/i]); return c.loc ? c : null }, { timeoutMs: 10000 })
  const hit = add ? await press(D, add.loc) : 'no lib-add'
  const f = await waitFor(() => form(D), { timeoutMs: 5000 })
  return { hit, f }
}

// --- the flow, once per device ---------------------------------------------------------------------------------------------------------
async function flow(device) {
  ev.section(`${device}: Add furniture › Product page`)
  const D = await setup(device)
  const { page, ctl } = D
  ev.check(`${device}: the planner opens the scene`, D.hookOk, D.why || D.url)
  let { hit, f } = await openAdd(D)
  ev.check(`${device}: Add (lib-add) opens Add furniture`, hit === true && !!f, `${hit}; sheet ${!!f}`)
  if (!f) return D
  ev.check(`${device}: Product page is the first source and the default (lib-src-product pressed, its link field shown)`,
    f.segs[0]?.handle === 'lib-src-product' && f.source === 'product' && f.productBox && !f.linkField, fmt({ segs: f.segs.map((s) => s.label), source: f.source }))
  ev.check(`${device}: the four sources fit the sheet, labels whole`, f.segs.length === 4 && f.segs.every((s) => s.inside && !s.cut) && (device !== 'phone' || f.segs.every((s) => s.h >= 44)),
    fmt(f.segs.map((s) => `${s.label} ${s.h}px${s.cut ? ' CUT' : ''}${s.inside ? '' : ' OUTSIDE'}`)))
  ev.check(`${device}: the link field is type url, inputmode url; Read next to it; the status is aria-live polite`,
    f.url?.type === 'url' && f.url?.inputmode === 'url' && f.read?.visible && f.statusLive === 'polite', fmt({ url: f.url, read: f.read?.text, live: f.statusLive }))
  ev.check(`${device}: Make waits for a read ("Read the page first" or similar)`, f.go?.disabled && /paste|read/i.test(f.go.text), f.go?.text)
  const engine0 = f.engine
  await stage(D, 'sheet open', '1-open')

  // read the rug page: the loading state, then 3 sizes, Flat rug, H 0.8, 3 pictures
  const jobs0 = (await jobs()).length
  const callsBefore = ctl.calls.length
  ctl.delayMs = 1500
  await readLink(D, URLS.rug, { enter: device === 'desktop' })
  await sleep(250)
  const busy = await form(D)
  ev.check(`${device}: while reading, Read is disabled with a spinner and "Reading…", the status says "Reading the page…"`,
    busy?.read?.busy && busy.read.spinner && /Reading…/.test(busy.read.text) && /Reading the page…/.test(busy.status), fmt({ read: busy?.read, status: busy?.status }))
  if (device === 'desktop') ev.check('desktop: Enter in the link field reads', ctl.calls.length === callsBefore + 1 && ctl.calls.at(-1)?.url === URLS.rug, fmt(ctl.calls.at(-1)))
  await shot(D, '2-reading')
  f = await waitRead(D)
  await waitFor(async () => { const x = await form(D); return x?.pics.filter((p) => p.visible).every((p) => p.loaded) ? x : null }, { timeoutMs: 8000 })
  f = await form(D)
  ev.check(`${device}: the status says what was found and where`, /the name/.test(f?.status) && /3 sizes/.test(f?.status) && /3 pictures/.test(f?.status) && /structured data/.test(f?.status), f?.status)
  ev.check(`${device}: prefilled from the rug page: name, ${RUG.dims[0].join(' × ')} cm, category rug`,
    f?.name === RUG.name && near(f.w, RUG.dims[0][0]) && near(f.d, RUG.dims[0][1]) && near(f.h, RUG.dims[0][2]) && f.category === 'rug', fmt({ name: f?.name, w: f?.w, d: f?.d, h: f?.h, category: f?.category }))
  ev.check(`${device}: is_rug picks the Flat rug engine`, f?.engine === 'rug', `engine ${engine0} → ${f?.engine}`)
  ev.check(`${device}: 3 size choices (product-size, data-index 0–2), labelled by the shop's sizes, the first chosen`,
    f?.sizes.length === 3 && f.sizes.every((s, i) => s.index === i && s.text.includes(RUG.variants[i])) && f.sizes[0].pressed && !f.sizes[1].pressed,
    fmt(f?.sizes))
  ev.check(`${device}: 3 pictures from the pages server's /media/, the first chosen, no-referrer, lazy, alt text, loaded`,
    f?.pics.length === 3 && f.pics.every((p, i) => p.src === rugPics[i] && p.ref === 'no-referrer' && p.loading === 'lazy' && p.alt && p.loaded && p.visible) && f.pics[0].pressed && !f.pics[1].pressed,
    fmt(f?.pics.map((p) => ({ src: p.src?.replace(P, '{P}'), pressed: p.pressed, ref: p.ref, loaded: p.loaded }))))
  ev.check(`${device}: the picture strip stays inside the sheet (it scrolls sideways itself)`, f?.strip && f.strip.left >= f.strip.sheetLeft - 4 && f.strip.right <= f.strip.sheetRight + 4 && /auto|scroll/.test(f.strip.scrolls), fmt(f?.strip))
  ev.check(`${device}: the notes say where it came from`, /structured data/.test(f?.notes), f?.notes)
  ev.check(`${device}: Make is ready (rug: free)`, f?.go && !f.go.disabled, f?.go?.text)
  await stage(D, 'rug read', '3-rug')
  await handle(D, 'product-notes').scrollIntoViewIfNeeded().catch(() => {})
  await stage(D, 'rug read, scrolled to the notes', '3b-rug-notes')

  // pick size 2 and picture 2
  await press(D, handle(D, 'product-size', '[data-index="1"]'))
  await press(D, handle(D, 'product-pic', '[data-index="1"]'))
  f = await form(D)
  ev.check(`${device}: picking size 2 fills ${RUG.dims[1].join(' × ')} and marks it`, near(f?.w, RUG.dims[1][0]) && near(f.d, RUG.dims[1][1]) && near(f.h, RUG.dims[1][2]) && f.sizes[1]?.pressed && !f.sizes[0]?.pressed,
    fmt({ w: f?.w, d: f?.d, h: f?.h, pressed: f?.sizes.map((s) => s.pressed) }))
  ev.check(`${device}: picking picture 2 marks it (and only it)`, f?.pics[1]?.pressed && !f.pics[0].pressed && !f.pics[2].pressed, fmt(f?.pics.map((p) => p.pressed)))
  const jobsBefore = await jobs()
  ev.check(`${device}: Read added nothing (no new library job)`, jobsBefore.length === jobs0, `${jobs0} → ${jobsBefore.length} jobs`)
  ev.check(`${device}: no picture was fetched by the server before Make (pages server: /media/ hits with a midstudy User-Agent)`, serverMedia().length === 0,
    `${serverMedia().length} server fetches; ${media().length} browser picture loads`)
  const withReferer = media().filter((x) => !/^midstudy/i.test(x.headers['user-agent'] || '') && x.headers.referer)
  ev.check(`${device}: the browser's picture requests carry no Referer`, withReferer.length === 0, withReferer.length ? withReferer.map((x) => x.headers.referer).join(', ') : `${media().length} loads, none with a Referer`)
  await stage(D, 'size 2 and picture 2 chosen', '4-picked')

  // Make: the chosen picture through the image-link add
  const make = D.page.locator('.ms-add .ms-foot .ms-primary').first()
  const reqP = page.waitForRequest((r) => r.url().endsWith('/api/library/items/from-url') && r.method() === 'POST', { timeout: 10000 }).catch(() => null)
  const madeHit = await press(D, make)
  const req = await reqP
  let sent = null
  try { sent = JSON.parse(req?.postData() || 'null') } catch { /* not JSON */ }
  ev.check(`${device}: Make posts the chosen picture and size to from-url (engine rug, the name; a shop with several sizes: the slug of the name and that size)`,
    madeHit === true && sent?.image_url === rugPics[1] && near(sent.dims_cm?.w, 200) && near(sent.dims_cm?.d, 300) && near(sent.dims_cm?.h, 0.8) && sent.engine === 'rug' && sent.name === RUG.name && sent.id === 'dune-flatweave-rug-200x300',
    `${madeHit}; ${fmt(sent)?.replaceAll(P, '{P}')}`)
  const job = await waitFor(async () => (await jobs()).find((j) => !jobsBefore.some((b) => b.id === j.id)), { timeoutMs: 10000 })
  ev.check(`${device}: one library job, engine rug`, job && (await jobs()).length === jobsBefore.length + 1 && job.engine === 'rug', fmt(job && { id: job.id, engine: job.engine, status: job.status }))
  const doneJob = job ? await waitFor(async () => { const j = (await api.get(srv.base, `/api/library/jobs/${job.id}`)).json; return ['done', 'failed'].includes(j?.status) ? j : null }, { timeoutMs: 240000, intervalMs: 500 }) : null
  const item = ((await api.get(srv.base, '/api/library')).json?.items || []).find((i) => i.id === 'dune-flatweave-rug-200x300')
  ev.check(`${device}: the job ends done; the item has the chosen size and picture link`,
    doneJob?.status === 'done' && near(item?.dims_cm?.w, 200) && near(item?.dims_cm?.d, 300) && near(item?.dims_cm?.h, 0.8) && item?.source?.input === rugPics[1],
    `${doneJob?.status ?? 'no answer'} ${doneJob?.status === 'failed' ? doneJob.message : ''}; item ${fmt(item && { dims: item.dims_cm, input: item.source?.input?.replace(P, '{P}'), engine: item.source?.engine })}`)
  const sm = serverMedia()
  ev.check(`${device}: the server fetched exactly the chosen picture, once (from-url)`, sm.length === 1 && sm[0].path === new URL(rugPics[1]).pathname, fmt(sm.map((x) => `${x.path} (${x.headers['user-agent']})`)))
  pages.hits.length = 0
  ev.check(`${device}: Make closed the sheet`, !(await form(D)), (await form(D)) ? 'still open' : 'closed')
  await shot(D, '5-made')

  // the chair: 76 × 84 × 98, not a rug; a typed name survives re-reads; the engine goes back after a rug
  ;({ hit, f } = await openAdd(D))
  ev.check(`${device}: Add again opens on Product page`, f?.source === 'product', f?.source)
  await readLink(D, URLS.chair)
  f = await waitRead(D)
  ev.check(`${device}: the chair page prefills ${CHAIR.dims[0].join(' × ')}, its name and category; one size, no size picker; 2 pictures`,
    f?.name === CHAIR.name && near(f.w, 76) && near(f.d, 84) && near(f.h, 98) && f.category === CHAIR.category && f.sizes.length === 0 && f.pics.length === 2 && f.pics[0].pressed,
    fmt({ name: f?.name, w: f?.w, d: f?.d, h: f?.h, category: f?.category, sizes: f?.sizes.length, pics: f?.pics.length, status: f?.status }))
  ev.check(`${device}: not a rug, so the engine stays as it was`, f?.engine && f.engine !== 'rug' && f.engine === engine0, `${engine0} → ${f?.engine}`)
  await stage(D, 'chair read', '6-chair')
  const typed = 'Window reading chair'
  await page.locator('.ms-add input[aria-label="Name"]').fill(typed)
  await readLink(D, URLS.rug)
  f = await waitRead(D)
  ev.check(`${device}: re-reading (the rug) keeps the typed name and replaces the rest (dims, category, Flat rug)`,
    f?.name === typed && near(f.w, 160) && near(f.d, 230) && near(f.h, 0.8) && f.category === 'rug' && f.engine === 'rug', fmt({ name: f?.name, w: f?.w, d: f?.d, h: f?.h, category: f?.category, engine: f?.engine }))
  await readLink(D, `Morris Reading Chair – have a look ${URLS.chair}`) // shared from an app: a title around the link
  f = await waitRead(D)
  ev.check(`${device}: a link pasted with text around it: just the link is read (and left in the field)`, ctl.calls.at(-1)?.url === URLS.chair && f?.url?.value === URLS.chair,
    fmt({ sent: ctl.calls.at(-1)?.url?.replace(P, '{P}'), field: f?.url?.value?.replace(P, '{P}') }))
  ev.check(`${device}: reading the chair again: the typed name still there, 76 × 84 × 98, the engine back to ${engine0}`,
    f?.name === typed && near(f.w, 76) && near(f.d, 84) && near(f.h, 98) && f.category === CHAIR.category && f.engine === engine0, fmt({ name: f?.name, w: f?.w, d: f?.d, h: f?.h, category: f?.category, engine: f?.engine }))

  // the readProductPage hook: the 200 body, nothing added
  const j0 = (await jobs()).length
  const lib0 = ((await api.get(srv.base, '/api/library')).json?.items || []).length
  const hk = await hook(page, 'readProductPage', [URLS.chair])
  const b = hk.value
  ev.check(`${device}: readProductPage(chair) resolves with the 200 body (every §2.11 key) and adds nothing`,
    b?.name === CHAIR.name && near(b.dims_candidates?.[0]?.w, 76) && near(b.dims_candidates?.[0]?.d, 84) && near(b.dims_candidates?.[0]?.h, 98) && b.images?.length === 2
      && ['url', 'name', 'category', 'is_rug', 'dims_candidates', 'variants', 'images', 'source_layers_used', 'cost_usd', 'mock', 'warnings'].every((k) => k in b)
      && (await jobs()).length === j0 && ((await api.get(srv.base, '/api/library')).json?.items || []).length === lib0,
    hk.error || fmt({ name: b?.name, dims: b?.dims_candidates?.[0], images: b?.images?.length, keys: Object.keys(b || {}).length }))
  const hkBad = await hook(page, 'readProductPage', [URLS.blocked])
  ev.check(`${device}: readProductPage(blocked) rejects with the contract's sentence`, hkBad.error?.includes(BLOCKED), hkBad.error || fmt(hkBad.value))

  // blocked: the sentence and Use Image link instead
  await readLink(D, URLS.blocked)
  f = await waitRead(D)
  ev.check(`${device}: a blocked shop shows the contract's sentence (product-error) and Use Image link instead`, f?.error === BLOCKED && f.useLink, fmt({ error: f?.error, useLink: f?.useLink }))
  ev.check(`${device}: after the error, Make waits for a good read`, f?.go?.disabled, f?.go?.text)
  // verify round (2026-11-05): the last page's size and category don't stay behind for another product
  ev.check(`${device}: a failed read clears the last page's size and category (the typed name stays)`,
    f?.w === '' && f?.d === '' && f?.h === '' && f?.category === '' && f?.name === typed, fmt({ name: f?.name, w: f?.w, d: f?.d, h: f?.h, category: f?.category }))
  await stage(D, 'blocked', '7-blocked')
  await press(D, handle(D, 'product-use-link'))
  f = await form(D)
  ev.check(`${device}: Use Image link instead switches to Image link (lib-src-link pressed, its field shown, the typed name kept)`,
    f?.source === 'link' && f.linkField && !f.productBox && f.name === typed, fmt({ source: f?.source, linkField: f?.linkField, name: f?.name }))
  await stage(D, 'switched to Image link', '8-image-link')
  await press(D, D.page.locator('.ms-add [data-midstudy="lib-src-product"]').first())

  // the prose page: a language model read it (mocked); then the model's cost in the notes
  await page.locator('.ms-add input[aria-label="Name"]').fill('')
  await readLink(D, URLS.prose)
  f = await waitRead(D)
  ev.check(`${device}: the prose page: a language model read it (status and notes say so), 90 × 40 × 120, no charge (mock)`,
    /language model/.test(f?.status) && /language model/.test(f?.notes) && /check it/.test(f?.notes) && near(f.w, 90) && near(f.d, 40) && near(f.h, 120) && f.name === 'Teak Cabinet' && !/cost \$/.test(f.notes),
    fmt({ status: f?.status, notes: f?.notes, w: f?.w, d: f?.d, h: f?.h }))
  await stage(D, 'prose page (language model)', '9-prose')
  await handle(D, 'product-notes').scrollIntoViewIfNeeded().catch(() => {})
  await stage(D, 'prose page, scrolled to the notes', '9b-prose-notes')
  ctl.patch = (json) => ({ ...json, cost_usd: 0.0009, mock: false })
  await readLink(D, URLS.prose)
  f = await waitRead(D)
  ctl.patch = null
  ev.check(`${device}: a model that cost money says so in the notes (answer patched to cost_usd 0.0009)`, /The language model cost \$0\.0009/.test(f?.notes), f?.notes)

  // a picture that doesn't load is hidden, and the next one is chosen
  ctl.patch = (json) => ({ ...json, images: [{ ...json.images[0], url: `${P}/media/missing-picture.jpg` }, ...json.images.slice(1)] })
  await readLink(D, URLS.rug)
  f = await waitRead(D)
  ctl.patch = null
  f = await waitFor(async () => { const x = await form(D); return x && !x.pics[0]?.visible ? x : null }, { timeoutMs: 8000 }) || await form(D)
  ev.check(`${device}: a picture that fails to load is hidden and the next one is chosen`, !f?.pics[0]?.visible && f?.pics[1]?.visible && f.pics[1].pressed && f.go && !f.go.disabled,
    fmt({ pics: f?.pics.map((p) => ({ visible: p.visible, pressed: p.pressed })), go: f?.go?.text }))
  await stage(D, 'broken picture skipped', '10-broken-picture')

  // nothing went wrong in the page
  const errs = await page.evaluate(() => window.midstudy?.errors?.slice() || ['no window.midstudy'])
  const expected = (m) => /Failed to load resource/.test(m) && (/missing-picture\.jpg/.test(m) || /\/api\/library\/product/.test(m))
  const cons = D.errors.console.filter((m) => !expected(m))
  ev.check(`${device}: no console errors, no page errors, nothing in window.midstudy.errors`, cons.length === 0 && D.errors.page.length === 0 && errs.length === 0,
    `console ${cons.join(' | ') || 'none'} (${D.errors.console.length - cons.length} expected resource errors: the 422 of the blocked page, the broken picture); page ${D.errors.page.join(' | ') || 'none'}; midstudy.errors ${errs.join(' | ') || 'none'}`)
  await D.context.close()
  return D
}

await flow('desktop')
await flow('phone')
await ev.finish()
