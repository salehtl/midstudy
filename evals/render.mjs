// E6 eval:render — render, keep-room, align, the Renders panel and Compare (PLAN.md §6.2 E6; contract §4.7, §4.3 Align).
// Part A runs `midstudy-calib align` directly on a synthetic pair: the golden photo's middle 1600 × 900 as the
// "photo", the same resized to 1344 × 768 (nano-banana's size) and shifted by 2 % of the width as the "model output",
// a mask around the sofa and table. It must apply and register within 2 px (measured here by searching the residual
// shift inside the mask, not only by trusting residual_px), keep the photo outside the mask, refuse an unrelated image
// and apply on an identical one. Part B: the planner in mock mode: renderView() writes the files, the request carried
// the scene photo as the reference for nano-banana (meta.reference, the default prompt), keep-room writes -raw.jpg and
// an applied composite (mock = identity), the render lists in the panel, and Compare opens with two renders.
// Calibration of scenes uses the stub (+ MIDSTUDY_CALIB_MOCK); `align` goes to the real midstudy-calib
// (MIDSTUDY_EVAL_ALIGN_CMD overrides it), through evals/lib/gated_calib.py. fal is mocked, $0.
// Usage: node evals/render.mjs   (or npm run eval:render). Output: evals/out/render/.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, PROBE, REAL_CALIB, createEval, startServer, seedScene, launchBrowser, openPlanner, hook, state, ensureScene, golden, fmt, clip, api,
  pyHelper, jpegSize, dataUri, maskPng, control, sleep, waitFor, inspectCompare,
} from './lib/harness.mjs'

const ev = createEval('E6', 'render', { timeoutS: 900 })
const DEFAULT_PROMPT = 'Image 1 is a photo of a room with 3D models of furniture placed in it. Image 2 is the same room as photographed. Make the furniture in image 1 look like it was photographed in this room: realistic materials, lighting, reflections and contact shadows that match the room\'s light. Keep the camera, the room and everything already in it exactly as in image 2. Keep each piece of furniture\'s position, size, shape and color. Do not add, remove or move anything.'
const ALIGN_CMD = process.env.MIDSTUDY_EVAL_ALIGN_CMD || `uv run --project ${path.join(REPO, 'calib')} midstudy-calib`
const calibBuilt = !!process.env.MIDSTUDY_EVAL_ALIGN_CMD || fs.existsSync(path.join(REPO, 'calib/pyproject.toml'))
const LW = golden('living-wide')
const exists = (p) => fs.existsSync(p)

// --- A: align on a synthetic pair ------------------------------------------------------------------------------------------------
ev.section(`A: ${ALIGN_CMD} align`)
const syn = pyHelper(['align-synth', '--scene-dir', LW.dir, '--out', path.join(ev.out, 'align')])
ev.check('(harness) synthetic pair: photo 1600 × 900, output 1344 × 768 shifted by 2 % (27 px), mask around the sofa and table', !syn.error && syn.shift_px === 27 && syn.mask_frac > 0.1 && syn.mask_frac < 0.6,
  syn.error || fmt({ rect: syn.rect, shift_px: syn.shift_px, mask_frac: syn.mask_frac }))
const align = (raw, out) => {
  if (!calibBuilt) return { error: 'calib/ missing: midstudy-calib align is not built yet' }
  fs.rmSync(out, { force: true })
  const argv = [...ALIGN_CMD.split(' '), 'align', syn.photo, raw, syn.mask, '--out', out]
  const env = { ...process.env }
  delete env.VIRTUAL_ENV
  try {
    const stdout = execFileSync(argv[0], argv.slice(1), { cwd: REPO, encoding: 'utf8', timeout: 900000, env, stdio: ['ignore', 'pipe', 'pipe'] })
    return JSON.parse(stdout.trim().split('\n').at(-1))
  } catch (e) {
    const last = String(e.stdout || '').trim().split('\n').at(-1)
    try { return { ...JSON.parse(last), exit: e.status } } catch { return { error: `exit ${e.status}: ${clip(String(e.stderr || e.message).trim().split('\n').slice(-2).join(' '), 300)}` } }
  }
}
if (!syn.error) {
  const fShift = path.join(ev.out, 'align', 'final-shifted.jpg')
  const a1 = align(syn.raw, fShift)
  ev.check('the shifted, resized output: exit 0, applied, ≥ 40 inliers, residual_px ≤ 2', a1.ok === true && a1.applied === true && a1.inliers >= 40 && a1.residual_px <= 2, fmt(a1))
  const meas = exists(fShift) ? pyHelper(['align-measure', '--photo', syn.photo, '--final', fShift, '--rect', syn.rect.join(',')]) : { error: 'no final image written' }
  ev.check('the composite is the photo\'s size and registers within 2 px inside the mask (measured)', !meas.error && fmt(meas.final_size) === fmt([1600, 900]) && meas.shift_px <= 2 && !meas.at_search_edge,
    meas.error || `residual shift ${meas.shift_px.toFixed(2)} px (dx ${meas.dx.toFixed(2)}, dy ${meas.dy.toFixed(2)}), mean |Δ| inside ${meas.inside_diff_best.toFixed(2)}; size ${fmt(meas.final_size)}`)
  ev.check('outside the mask the composite keeps the photo (mean |Δ| ≤ 3 levels)', !meas.error && meas.outside_diff <= 3, meas.error || `mean |Δ| ${meas.outside_diff?.toFixed(2)}`)
  const fUn = path.join(ev.out, 'align', 'final-unrelated.jpg')
  const a2 = align(syn.unrelated, fUn)
  ev.check('an unrelated image: exit 0, applied false with a reason, nothing written', a2.ok === true && a2.applied === false && typeof a2.reason === 'string' && a2.reason.length > 3 && !exists(fUn), fmt(a2) + (exists(fUn) ? ' (wrote a file)' : ''))
  const fId = path.join(ev.out, 'align', 'final-identical.jpg')
  const a3 = align(syn.identical, fId)
  const mId = exists(fId) ? pyHelper(['align-measure', '--photo', syn.photo, '--final', fId, '--rect', syn.rect.join(',')]) : { error: 'no final image' }
  ev.check('an identical image is the identity and applies (≤ 0.5 px)', a3.applied === true && !mId.error && mId.shift_px <= 0.5, `${fmt(a3)} ${mId.error || `shift ${mId.shift_px?.toFixed(2)} px`}`)
}

// --- B: the planner ------------------------------------------------------------------------------------------------------------
ev.section('B: renderView() in mock mode')
const srv = await startServer(ev, {
  calib: `python3 ${path.join(REPO, 'evals/lib/gated_calib.py')}`,
  env: { MIDSTUDY_EVAL_CALIB_TARGET: `python3 ${path.join(REPO, 'fixtures/stub_calib.py')}`, ...(calibBuilt ? { MIDSTUDY_EVAL_ALIGN_TARGET: ALIGN_CMD } : {}) },
})
ev.check('the server starts (stub calibration, real align)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const S = await seedScene(srv, 'living-wide')
ev.check('golden living-wide calibrated', S.name && !S.why, S.why || S.name)
const browser = await launchBrowser(ev)
const P = await openPlanner(browser, srv.base, { scene: S.name })
ev.check('the planner opens the scene', P.hookOk, P.why || P.url)
await ensureScene(P.page, S.name)
await hook(P.page, 'addItem', [PROBE.id, { position: [0.9, 0, -2.6], rotation_y_deg: 0 }]) // axis-aligned: its silhouette is its worldBounds
await hook(P.page, 'saveLayout', ['e6'])
const R = srv.dirs.renders
const files = (n) => ['.jpg', '-input.jpg', '.json', '-raw.jpg'].map((x) => exists(path.join(R, `${n}${x}`)))
const rv = await hook(P.page, 'renderView', [], 120000)
const m1 = rv.value || {}
ev.check('renderView() resolves with the meta: mock, $0, nano-banana by default', !rv.error && m1.mock === true && m1.cost_usd === 0 && m1.model === 'nano-banana' && /^\/renders\/[^/]+\.jpg/.test(m1.url || ''), rv.error || clip(fmt(m1), 400))
ev.check('meta: scene, layout (the one open), reference true, keep_room false, aligned null, raw_url null', m1.scene === S.name && m1.layout === 'e6' && m1.reference === true && m1.keep_room === false
  && m1.aligned === null && m1.raw_url === null, fmt({ scene: m1.scene, layout: m1.layout, reference: m1.reference, keep_room: m1.keep_room, aligned: m1.aligned, raw_url: m1.raw_url }))
ev.check('the reference request used the default prompt (Image 1 … Image 2 …)', m1.prompt === DEFAULT_PROMPT, m1.prompt == null ? 'no meta' : clip(m1.prompt, 160))
const f1 = m1.name ? files(m1.name) : []
ev.check('files written: <name>.jpg, -input.jpg, .json, and no -raw.jpg without keep-room', f1[0] && f1[1] && f1[2] && !f1[3], fmt(f1))
const inSize = m1.name && f1[1] ? jpegSize(fs.readFileSync(path.join(R, `${m1.name}-input.jpg`))) : null
ev.check('the capture is the full photo frame at the photo\'s resolution (1600 × 1200); out_w/out_h are the result\'s size', fmt(inSize) === fmt({ h: 1200, w: 1600 }) && m1.out_w === 1600 && m1.out_h === 1200,
  `input ${fmt(inSize)}, out ${m1.out_w}×${m1.out_h}`)
const st1 = await state(P.page)
const box = st1?.items?.[0]?.worldBounds
const comp = box && f1[1] ? pyHelper(['occlusion', '--composite', path.join(R, `${m1.name}-input.jpg`), '--photo', LW.photo, '--camera', JSON.stringify(LW.truth.camera),
  '--box', JSON.stringify([box.min, box.max]), '--depth', LW.depth]) : { error: 'no composite or item' }
ev.check('the capture is photo plus furniture, registered: the probe box is drawn where §4.1 projects it', comp.visible_magenta >= 0.9 && comp.outside_magenta < 0.002,
  comp.error || `box pixels showing it ${(100 * comp.visible_magenta).toFixed(1)} %, box colour elsewhere ${(100 * comp.outside_magenta).toFixed(2)} %`)
const metaFile = m1.name && f1[2] ? JSON.parse(fs.readFileSync(path.join(R, `${m1.name}.json`), 'utf8')) : null
ev.check('<name>.json holds the same meta', metaFile && metaFile.name === m1.name && metaFile.reference === true && metaFile.scene === S.name, clip(fmt(metaFile), 200))
const costs = fs.readFileSync(srv.dirs.costs, 'utf8')
ev.check('a mock cost row: render:nano-banana, $0, mock true', costs.split('\n').some((l) => l.includes(m1.name) && l.includes('render:nano-banana') && /,true,/.test(l)), clip(costs.trim().split('\n').slice(-2).join(' | '), 300))

ev.section('keep room exact')
const rk = await hook(P.page, 'renderView', [{ keepRoom: true }], 600000)
const m2 = rk.value || {}
const f2 = m2.name ? files(m2.name) : []
ev.check('renderView({keepRoom: true}): keep_room true, raw_url, <name>-raw.jpg and <name>.jpg written', !rk.error && m2.keep_room === true && /-raw\.jpg/.test(m2.raw_url || '') && f2[0] && f2[3], rk.error || fmt({ keep_room: m2.keep_room, raw_url: m2.raw_url, files: f2 }))
ev.check('mock mode is the identity, so align applies: aligned {applied: true, inliers, residual_px}', m2.aligned?.applied === true && m2.aligned.inliers >= 40 && m2.aligned.residual_px <= 3,
  fmt(m2.aligned) + (calibBuilt ? '' : ' (calib/ not built: align ran on the stub)'))
const comp2 = m2.name && f2[0] && box ? pyHelper(['occlusion', '--composite', path.join(R, `${m2.name}.jpg`), '--photo', LW.photo, '--camera', JSON.stringify(LW.truth.camera),
  '--box', JSON.stringify([box.min, box.max]), '--depth', LW.depth]) : { error: 'no result' }
ev.check('the keep-room result is the photo plus the furniture (the box where it was)', comp2.visible_magenta >= 0.9, comp2.error || `box pixels ${(100 * comp2.visible_magenta).toFixed(1)} %`)

ev.section('POST /api/render directly')
const photo = fs.readFileSync(LW.photo)
const mine = [m1.name, m2.name].filter(Boolean)
let r = await api.send(srv.base, 'POST', '/api/render', { image: dataUri('image/jpeg', photo), scene: S.name, model: 'kontext' })
if (r.json?.name) mine.push(r.json.name)
ev.check('kontext with a scene: the composite only (reference false)', r.status === 200 && r.json?.reference === false && r.json?.model === 'kontext', `${r.status} reference ${r.json?.reference}`)
r = await api.send(srv.base, 'POST', '/api/render', { image: dataUri('image/jpeg', photo), scene: S.name, model: 'gpt-image' })
if (r.json?.name) mine.push(r.json.name)
ev.check('gpt-image with a scene: the composite alone (reference false) with its own prompt, openai/gpt-image-2/edit', r.status === 200 && r.json?.reference === false && r.json?.model === 'gpt-image' && r.json?.endpoint === 'openai/gpt-image-2/edit' && /^This is a photo of a room with 3D models/.test(r.json?.prompt || ''), `${r.status} reference ${r.json?.reference} ${r.json?.endpoint} ${r.json?.prompt}`)
r = await api.send(srv.base, 'POST', '/api/render', { image: dataUri('image/jpeg', photo) })
const sceneless = r.json?.name
ev.check('nano-banana without a scene: no reference', r.status === 200 && r.json?.reference === false && r.json?.scene == null, `${r.status} reference ${r.json?.reference} scene ${r.json?.scene}`)
r = await api.send(srv.base, 'POST', '/api/render', { image: dataUri('image/jpeg', photo), scene: S.name, prompt: 'Make it look real.' })
if (r.json?.name) mine.push(r.json.name)
ev.check('a given prompt is kept (reference still sent)', r.status === 200 && r.json?.prompt === 'Make it look real.' && r.json?.reference === true, `${r.status} ${clip(r.json?.prompt, 60)} ${r.json?.reference}`)
const mask = maskPng(1600, 1200, [[700, 650, 1100, 1000]])
r = await api.send(srv.base, 'POST', '/api/render', { image: dataUri('image/jpeg', photo), scene: S.name, keep_room: true, mask: dataUri('image/png', mask) })
if (r.json?.name) mine.push(r.json.name)
ev.check('keep_room with a mask through the API: aligned applied, raw_url set', r.status === 200 && r.json?.keep_room === true && r.json?.aligned?.applied === true && !!r.json?.raw_url, `${r.status} ${fmt(r.json?.aligned)}`)
r = await api.get(srv.base, `/api/renders?scene=${S.name}`)
const listed = r.json?.renders || []
const names = listed.map((x) => x.name)
ev.check('GET /api/renders?scene= lists exactly this scene\'s renders, newest first', mine.length >= 3 && mine.every((n) => names.includes(n)) && !names.includes(sceneless)
  && listed.every((x) => x.scene === S.name) && listed.every((x, i) => i === 0 || listed[i - 1].created >= x.created), `listed ${names.length}, made with the scene ${mine.length}, scene-less listed ${names.includes(sceneless)}`)

ev.section('UI: Render dialog, Renders panel, Compare')
const before = (await hook(P.page, 'listRenders')).value?.length ?? 0
const btn = await control(P.page, 'render', [/^render/i])
if (btn.loc) await btn.loc.click().catch(() => {})
await sleep(500)
const keep = await control(P.page, 'keep-room', [/keep room/i])
const keepOn = keep.loc ? await keep.loc.evaluate((el) => {
  const i = el.matches('input') ? el : el.querySelector('input')
  return i ? i.checked : ['true'].includes(el.getAttribute('aria-checked') || el.getAttribute('aria-pressed') || '')
}).catch(() => null) : null
ev.check('Render opens the dialog with Keep room exact, on by default (PLAN.md §8 live check)', !!btn.loc && !!keep.loc && keepOn === true, `${btn.how}; ${keep.how}; on ${keepOn}`)
await P.page.screenshot({ path: path.join(ev.out, 'render-dialog.png') }).catch(() => {})
const go = await control(P.page, 'render-go', [/^render$/i])
if (go.loc) await go.loc.click().catch(() => {})
const grew = await waitFor(async () => ((await hook(P.page, 'listRenders')).value?.length ?? 0) > before, { timeoutMs: 60000 })
ev.check('render-go makes a render (listRenders() grows)', !!go.loc && !!grew, `${go.how}; ${before} → ${(await hook(P.page, 'listRenders')).value?.length}`)
const lr = (await hook(P.page, 'listRenders')).value || []
const newest = lr[0]?.name
await sleep(800)
let inPanel = newest ? await P.page.locator(`img[src*="${newest}"]`).count() : 0
if (!inPanel) {
  const panel = await control(P.page, 'renders', [/renders/i])
  if (panel.loc) { await panel.loc.click().catch(() => {}); await sleep(600) }
  inPanel = newest ? await P.page.locator(`img[src*="${newest}"]`).count() : 0
}
ev.check('the new render lists in the Renders panel (an image of it on the page)', inPanel > 0, `${newest}: ${inPanel} img`)
const cmpBtn = await P.page.locator('[data-midstudy="compare"]').count()
ev.check('the panel has a Compare control ([data-midstudy=compare])', cmpBtn > 0, `${cmpBtn}`)
await P.page.screenshot({ path: path.join(ev.out, 'renders-panel.png') }).catch(() => {})
const a = lr[0]?.name, b = lr[1]?.name
const cmp = await hook(P.page, 'compare', [a, b])
await sleep(800)
await P.page.screenshot({ path: path.join(ev.out, 'compare-opened.png') }).catch(() => {})
const cv = a && b ? await inspectCompare(P.page, a, b) : { error: 'fewer than two renders' }
ev.check('compare(a, b) opens a full-screen view (≥ 85 % of the viewport) with both renders on screen', !cmp.error && cv.cover >= 0.85 && cv.aOn >= 0.9 && cv.bOn >= 0.9, cmp.error || fmt(cv))
ev.check('on the desktop the two renders sit side by side', cv.sideBySide === true || cv.sideBySideBefore === true, fmt({ a: cv.a, b: cv.b, sideBySide: cv.sideBySide, before: cv.sideBySideBefore }))
ev.check('Compare has a draggable split slider', cv.slider > 0, fmt({ slider: cv.slider, toggled: cv.toggled ?? null }))
await P.page.screenshot({ path: path.join(ev.out, 'compare.png') }).catch(() => {})

ev.section('Upscale (§4.7 Upscale)')
r = await api.send(srv.base, 'POST', `/api/renders/${mine[0]}/upscale`, {})
const upUrl = r.json?.upscaled?.url
const served = upUrl ? await fetch(srv.base + upUrl) : null
const upBytes = served?.ok ? Buffer.from(await served.arrayBuffer()) : Buffer.alloc(0)
ev.check('POST /api/renders/<name>/upscale: 200, upscaled 2× at $0 (mock), the image served as a JPEG', r.status === 200 && r.json?.upscaled?.scale === 2 && r.json?.upscaled?.cost_usd === 0 && r.json?.upscaled?.mock === true
  && upBytes[0] === 0xff && upBytes[1] === 0xd8, `${r.status} ${fmt(r.json?.upscaled ?? r.json)}; served ${served?.status} ${upBytes.length} B`)
r = await api.send(srv.base, 'POST', `/api/renders/${mine[0]}/upscale`, { scale: 3 })
const r404 = await api.send(srv.base, 'POST', '/api/renders/render-20000101-000000/upscale', {})
ev.check('upscale refuses a scale that isn\'t 2 or 4 (400) and an unknown render (404)', r.status === 400 && r404.status === 404, `${r.status} ${r404.status}`)
await P.page.keyboard.press('Escape').catch(() => {})
await sleep(400)
let row = newest ? P.page.locator(`button[data-render="${newest}"]`) : null
if (row && !(await row.isVisible().catch(() => false))) {
  const panel = await control(P.page, 'renders', [/renders/i])
  if (panel.loc) { await panel.loc.click().catch(() => {}); await sleep(600) }
  row = P.page.locator(`button[data-render="${newest}"]`)
}
if (row) await row.click().catch(() => {})
await sleep(600)
const upBtn = await control(P.page, 'upscale', [/^upscale/i])
const upLabel = upBtn.loc ? (await upBtn.loc.textContent().catch(() => '')) ?? '' : ''
if (upBtn.loc) await upBtn.loc.click().catch(() => {})
const upDone = await waitFor(async () => ((await hook(P.page, 'listRenders')).value || []).find((x) => x.name === newest)?.upscaled?.scale === 2, { timeoutMs: 60000 })
await sleep(600)
const tab = await P.page.getByRole('radio', { name: /^upscaled$/i }).count().catch(() => 0) + await P.page.getByRole('button', { name: /^upscaled$/i }).count().catch(() => 0) + await P.page.getByRole('tab', { name: /^upscaled$/i }).count().catch(() => 0)
const shownUp = newest ? await P.page.locator(`img[src*="${newest}-upscaled.jpg"]`).count() : 0
ev.check('the viewer\'s Upscale button ("Upscale 2× · $0") upscales the render; the viewer then shows it under Upscaled', !!upBtn.loc && /2×/.test(upLabel) && !!upDone && tab > 0 && shownUp > 0, `${upBtn.how}; "${upLabel.trim()}"; done ${!!upDone}; tab ${tab}; shown ${shownUp}`)
const next = await control(P.page, 'upscale', [/^upscale/i])
const nextLabel = next.loc ? (await next.loc.textContent().catch(() => '')) ?? '' : ''
ev.check('after 2× the viewer offers 4×', /4×/.test(nextLabel), `"${nextLabel.trim()}"`)
await P.page.screenshot({ path: path.join(ev.out, 'upscaled.png') }).catch(() => {})
await P.page.keyboard.press('Escape').catch(() => {})

ev.section('errors')
ev.check('no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
ev.check('no console errors', P.errors.console.length === 0, P.errors.console.join(' | ') || 'none')
ev.check('no request refused as cross-site', P.errors.refused.length === 0, P.errors.refused.join(' | ') || 'none')
await ev.finish()
