// The real path, end to end on this Mac (integration check, not part of eval:all): the server with the default --calib
// (real MoGe-2, no MIDSTUDY_CALIB_MOCK), the user's own photo from fixtures/photos/ uploaded through the UI (New scene →
// POST /api/scenes), calibration, the planner, SheenChair.glb through the library API (the real midstudy-add, GLB,
// $0), place, drag, save a layout, two renders in fal mock mode (the second with Keep room exact: align must apply),
// Compare. Also uploads upper-lounge.jpg (the same shot without EXIF) through the API and compares the cameras.
// fal is mocked and capped at $0. Screenshots go to evals/out/integrate/ (git-ignored); look at them.
// Usage: nix develop -c node evals/real_path.mjs   (needs calib/ synced and fixtures/photos/; ~2 min)
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, REAL_CALIB, createEval, startServer, launchBrowser, openPlanner, hook, state, itemOf, fmt, api, waitFor, waitScene, control, sleep,
  photoToCss, inspectCompare, uploadScene,
} from './lib/harness.mjs'

const ev = createEval('R1', 'integrate', { timeoutS: 900 })
// The photo's rect in CSS px from the planner, and how well the screenshot matches photo.jpg there (24 × 24 samples,
// median of the max channel difference; the faint floor grid touches a few samples).
async function photoOnScreen(page, photoUrl, W, H) {
  const shot = await page.screenshot({ scale: 'css' })
  return page.evaluate(async ({ b64, photoUrl, W, H }) => {
    const r = window.midstudyCtx?.engine?.getPhotoRect?.()
    if (!r) return { rect: null, median: 255 }
    const data = async (blob, w, h) => { const b = await createImageBitmap(blob); const c = new OffscreenCanvas(w ?? b.width, h ?? b.height); const g = c.getContext('2d'); g.drawImage(b, 0, 0, c.width, c.height); return g.getImageData(0, 0, c.width, c.height) }
    const sh = await data(await (await fetch(`data:image/png;base64,${b64}`)).blob())
    const ph = await data(await (await fetch(photoUrl)).blob(), W, H)
    const d = []
    for (let i = 0; i < 24; i++) for (let j = 0; j < 24; j++) {
      const u = (i + 0.5) / 24, v = (j + 0.5) / 24, X = Math.floor(r.x + u * r.w), Y = Math.floor(r.y + v * r.h)
      const a = (Y * sh.width + X) * 4, b = (Math.floor(v * H) * W + Math.floor(u * W)) * 4
      d.push(Math.max(...[0, 1, 2].map((k) => Math.abs(sh.data[a + k] - ph.data[b + k]))))
    }
    d.sort((p, q) => p - q)
    return { rect: { x: r.x, y: r.y, w: r.w, h: r.h }, scale: r.w / W, median: d[d.length >> 1] }
  }, { b64: shot.toString('base64'), photoUrl, W, H })
}
const PHOTOS = path.join(REPO, 'fixtures/photos')   // never private/: only the two files named here are read
const MAIN = path.join(PHOTOS, 'upper-lounge-camera.jpeg')
const COPY = path.join(PHOTOS, 'upper-lounge.jpg')
const CHAIR = path.join(REPO, 'fixtures/models/SheenChair.glb')
if (!fs.existsSync(MAIN)) { ev.skip('real path', `${path.relative(REPO, MAIN)} is missing (fixtures/photos/ is local only)`); await ev.finish(1) }

const srv = await startServer(ev, { calib: REAL_CALIB, calibMock: false, library: 'empty' })
ev.check('the server starts with the default --calib (real midstudy-calib, no calib mock), fal mocked, $0 cap', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const browser = await launchBrowser(ev)
const P = await openPlanner(browser, srv.base)
const page = P.page
let shotN = 0
const shot = async (name) => { const f = `${String(++shotN).padStart(2, '0')}-${name}.png`; await page.screenshot({ path: path.join(ev.out, f) }).catch(() => {}); return f }
ev.check('the planner loads (desktop 1280 × 800)', P.hookOk, P.why || P.url)
await shot('scenes-page')

// --- New scene through the UI -------------------------------------------------------------------------------------------
ev.section('New scene: upper-lounge-camera.jpeg through the UI')
const newBtn = await control(page, 'scene-new', [/new scene/i])
let chooser = null
if (newBtn.loc) [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null), newBtn.loc.click().catch(() => {})])
if (chooser) await chooser.setFiles(MAIN)
else await page.locator('[data-midstudy="scene-file"]').first().setInputFiles(MAIN).catch(() => {})
const t0 = Date.now()
const created = await waitFor(async () => ((await api.get(srv.base, '/api/scenes')).json?.scenes || [])[0], { timeoutMs: 30000 })
ev.check('New scene → file picker uploads the photo (POST /api/scenes → 202, scene listed)', !!created, chooser ? `file chooser; ${created?.name} ${created?.calib_status}` : 'no file chooser')
const NAME = created?.name
const withPhoto = NAME ? await waitFor(async () => { const s = (await api.get(srv.base, `/api/scenes/${NAME}`)).json; return s?.photo_url && ['pending', 'running'].includes(s.calib_status) ? s : null }, { timeoutMs: 30000, intervalMs: 100 }) : null
await sleep(400)
await shot('calibrating')
ev.note(`while calibrating: ${withPhoto ? `photo shown (${withPhoto.w} × ${withPhoto.h}), ${withPhoto.calib_status}` : 'calibration ended before the photo was seen'}`)
const done = NAME ? await waitScene(srv.base, NAME, 300000) : null
const wall = (Date.now() - t0) / 1000
const calib = done?.calib || null
ev.check('real MoGe-2 calibrates it: source moge-2, floor found, calib_status done', done?.calib_status === 'done' && calib?.source === 'moge-2' && calib?.floor?.found === true,
  `${done?.calib_status}; ${calib?.source} ${calib?.model}; floor ${fmt(calib?.floor)}; ${calib?.device}; elapsed_s ${calib?.elapsed_s}; upload → done ${wall.toFixed(1)} s`)
const cam = calib?.camera
ev.note(`camera ${fmt(cam)}; EXIF ${fmt(calib?.exif)}; fov_disagreement ${fmt(calib?.fov_disagreement ?? null)}`)
ev.check('the camera is plausible for a hand-held phone: height 1.1–1.6 m, pitch −20…0°, |roll| < 3°, FOV within 8° of the EXIF 69.6°',
  cam && cam.height_m > 1.1 && cam.height_m < 1.6 && cam.pitch_deg < 0 && cam.pitch_deg > -20 && Math.abs(cam.roll_deg) < 3 && Math.abs(cam.fov_y_deg - 69.63) <= 8, fmt(cam))
// verify round 2 (contract §4.3 Fit): the EXIF focal length agrees with MoGe within 8°, so the camera takes the EXIF FOV
// and MoGe's height times k = tan(fov_moge/2) / tan(fov_exif/2); MoGe's own estimates stay in calib.moge.
const mo = calib?.moge || {}
const kExif = mo.fov_y_deg ? Math.tan((mo.fov_y_deg * Math.PI) / 360) / Math.tan((69.63 * Math.PI) / 360) : null
ev.check('the camera uses the EXIF FOV (fov_source exif, 69.63°) and MoGe\'s height corrected by the focal ratio',
  calib?.fov_source === 'exif' && Math.abs(cam.fov_y_deg - 69.63) < 0.05 && kExif && Math.abs(cam.height_m - mo.height_m * kExif) < 0.003,
  `fov_source ${calib?.fov_source}; fov ${cam?.fov_y_deg} (MoGe ${mo.fov_y_deg}); height ${cam?.height_m} = ${mo.height_m} × ${kExif?.toFixed(4)}; depth × ${mo.depth_scale}`)
ev.check('scene.json took the calibrated camera (camera_source auto) and has depth', done?.camera_source === 'auto' && !!done?.depth_url, `${done?.camera_source}; depth ${done?.depth_url}`)
const opened = NAME ? await waitFor(async () => (await state(page))?.scene?.name === NAME, { timeoutMs: 30000 }) : null
let openHow = 'opened by itself when calibrated'
if (NAME && !opened) {
  const card = page.locator(`[data-midstudy="scene-card"][data-scene="${NAME}"]`)
  if (await card.count()) { await card.first().click().catch(() => {}); openHow = 'clicked its card' }
  await waitFor(async () => (await state(page))?.scene?.name === NAME, { timeoutMs: 30000 })
}
await sleep(1500)
const st0 = await state(page)
ev.check('the scene opens in the planner with the auto camera, depth and occlusion on', st0?.scene?.name === NAME && st0.scene.hasDepth && st0.scene.occlusion && st0.scene.camera_source === 'auto',
  `${openHow}; ${fmt(st0?.scene)}`)
await shot('scene-open-grid')
const W = done?.w, H = done?.h
// Where the photo is on screen: the app's own rect (window.midstudyCtx, kept for manual checks; this is an integration
// script, not a black-box eval), checked against the screenshot. (The evals' generic registration can lock onto the
// wrong scale on this photo's repeating curtains.)
const m = await photoOnScreen(page, done?.photo_url || '/none', W, H)
ev.check('the photo is drawn as is: screenshot vs photo.jpg at the app\'s photo rect (median max-channel difference ≤ 10)', m.rect && m.median <= 10, `median ${m.median} rect ${fmt(m.rect)}`)

// Adjust floor on the real scene: the horizon line and the sliders; Looks right without a change keeps auto.
const adj = await control(page, 'adjust-floor', [/adjust floor/i])
if (adj.loc) await adj.loc.click().catch(() => {})
await sleep(600)
await shot('adjust-floor')
const ok = await control(page, 'floor-ok', [/looks right/i])
if (ok.loc) await ok.loc.click().catch(() => {})
await sleep(800)
const sAfter = (await api.get(srv.base, `/api/scenes/${NAME}`)).json
ev.check('Adjust floor opens on it, and Looks right without a change keeps camera_source auto', !!adj.loc && !!ok.loc && sAfter?.camera_source === 'auto' && !(await state(page))?.scene?.adjustFloor,
  `${adj.how} → ${ok.how}; ${sAfter?.camera_source}`)

// --- the copy without EXIF, and the same as HEIC, land on a similar camera -------------------------------------------------------
ev.section('upper-lounge.jpg (no EXIF) and a HEIC of it through POST /api/scenes')
// The copies have no EXIF, so they keep MoGe's own FOV and scale: compare them with the original's MoGe estimate.
const camMoge = cam && calib?.fov_source === 'exif' ? { ...cam, fov_y_deg: mo.fov_y_deg, height_m: mo.height_m } : cam
const near = (c2) => camMoge && c2 ? { fov: c2.fov_y_deg - camMoge.fov_y_deg, height_cm: 100 * (c2.height_m - camMoge.height_m), pitch: c2.pitch_deg - camMoge.pitch_deg, roll: c2.roll_deg - camMoge.roll_deg } : null
const close = (d) => d && Math.abs(d.fov) <= 1.5 && Math.abs(d.height_cm) <= 5 && Math.abs(d.pitch) <= 1.5 && Math.abs(d.roll) <= 1.5
if (fs.existsSync(COPY)) {
  const up = await uploadScene(srv.base, fs.readFileSync(COPY), { filename: 'upper-lounge.jpg', title: 'Lounge (no EXIF)' })
  const n2 = up.json?.scene
  const d2 = n2 ? await waitScene(srv.base, n2, 300000) : null
  const c2 = d2?.calib?.camera
  ev.check('JPEG without EXIF: 202, calibrates with the floor found, exif null', up.status === 202 && d2?.calib_status === 'done' && d2?.calib?.floor?.found === true && d2?.calib?.exif == null,
    `${up.status}; ${d2?.calib_status}; ${d2?.w} × ${d2?.h}; floor ${fmt(d2?.calib?.floor)}; elapsed_s ${d2?.calib?.elapsed_s}`)
  ev.check('…its camera (MoGe\'s own FOV, no EXIF) is within 1.5° and 5 cm of MoGe\'s estimate for the camera original', close(near(c2)), `${fmt(c2)}; Δ ${fmt(near(c2))}`)
  // The phone's own format: HEIC (made here with macOS sips from the metadata-free copy; deleted afterwards).
  const heic = path.join(ev.out, 'upper-lounge.heic')
  const { spawnSync } = await import('node:child_process')
  const sp = spawnSync('/usr/bin/sips', ['-s', 'format', 'heic', COPY, '--out', heic], { encoding: 'utf8' })
  if (sp.status === 0 && fs.existsSync(heic)) {
    const uh = await uploadScene(srv.base, fs.readFileSync(heic), { filename: 'IMG_0001.HEIC', title: 'Lounge (HEIC)' })
    fs.rmSync(heic, { force: true })
    const n3 = uh.json?.scene
    const d3 = n3 ? await waitScene(srv.base, n3, 300000) : null
    const c3 = d3?.calib?.camera
    const src3 = n3 ? fs.readdirSync(path.join(srv.dirs.scenes, n3)).filter((f) => f.startsWith('source.')) : []
    ev.check('HEIC: 202, source.heic kept, photo.jpg written, calibrates with the floor found', uh.status === 202 && d3?.calib_status === 'done' && d3?.calib?.floor?.found === true && src3.includes('source.heic') && d3?.w === 2000,
      `${uh.status}; ${d3?.calib_status}; ${d3?.w} × ${d3?.h}; ${src3.join(',')}; floor ${fmt(d3?.calib?.floor)}; ${d3?.calib_error || ''}`)
    ev.check('…its camera (MoGe\'s own FOV, no EXIF) is within 1.5° and 5 cm of MoGe\'s estimate for the camera original', close(near(c3)), `${fmt(c3)}; Δ ${fmt(near(c3))}`)
  } else ev.skip('HEIC upload', `sips could not make a HEIC: ${sp.stderr || sp.error}`)
} else ev.skip('no-EXIF copy and HEIC', `${path.relative(REPO, COPY)} is missing`)

// --- SheenChair through the library API ---------------------------------------------------------------------------------------
ev.section('SheenChair.glb through the library API (real midstudy-add, GLB, $0)')
const job = await page.evaluate(async ({ b64 }) => {
  const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
  const file = new File([bin], 'SheenChair.glb', { type: 'model/gltf-binary' })
  try { return await window.midstudy.addItemFromFile(file, { name: 'Sheen Chair', dims_cm: { w: 60, d: 65, h: 85 }, category: 'chair', engine: 'glb' }) } catch (e) { return { error: String(e?.message || e) } }
}, { b64: fs.readFileSync(CHAIR).toString('base64') })
const jobDone = job?.id ? await waitFor(async () => { const j = (await api.get(srv.base, `/api/library/jobs/${job.id}`)).json; return ['done', 'failed'].includes(j?.status) ? j : null }, { timeoutMs: 120000, intervalMs: 500 }) : null
ev.check('POST /api/library/items (model, GLB) → job done, $0', jobDone?.status === 'done' && jobDone.cost_usd === 0 && job.cost_usd_estimate === 0,
  job?.error || `${job?.id} estimate ${job?.cost_usd_estimate}; ${jobDone?.status} cost ${jobDone?.cost_usd} mock ${jobDone?.mock}; ${jobDone?.message}`)
const libItem = await waitFor(async () => (await hook(page, 'getLibrary')).value?.find((i) => i.id === 'sheen-chair'), { timeoutMs: 20000 })
ev.check('the planner\'s library has it (dims 60 × 65 × 85, a GLB)', libItem && libItem.assets?.glb && libItem.dims_cm?.h === 85, fmt(libItem && { id: libItem.id, dims: libItem.dims_cm, assets: libItem.assets }))

// --- place by a click in the Library panel ------------------------------------------------------------------------------------
ev.section('place, drag')
let row = page.getByRole('button', { name: /^Add Sheen Chair/ })
if (!(await row.first().isVisible().catch(() => false))) {
  const lib = await control(page, 'library', [/^library$/i])
  if (lib.loc) await lib.loc.click().catch(() => {})
  await sleep(500)
  row = page.getByRole('button', { name: /^Add Sheen Chair/ })
}
await shot('library-panel')
const n0 = (await state(page))?.items?.length ?? 0
await row.first().click({ timeout: 5000 }).catch(() => {})
await waitFor(async () => ((await state(page))?.items?.length ?? 0) > n0, { timeoutMs: 20000 })
await sleep(1200)
const st1 = await state(page)
const uid = st1?.items?.at(-1)?.uid
const it1 = itemOf(st1, uid)
ev.check('a click on the library row places the chair on the floor (y = 0), in the frame', !!it1 && it1.position[1] === 0 && !it1.missing,
  `${fmt(it1?.position)} rot ${it1?.rotation_y_deg}; dist ${it1 ? Math.hypot(it1.position[0], it1.position[2]).toFixed(2) : '?'} m`)
const r1 = uid ? (await hook(page, 'getScreenRect', [uid])).value : null
ev.check('its screen rect is inside the photo', r1 && r1.x >= 0 && r1.y >= 0 && r1.x + r1.w <= W && r1.y + r1.h <= H, fmt(r1))
await shot('chair-placed')
// Drag it with the mouse: from its middle, 200 photo px left and 120 down (closer).
let it2 = null, r2 = null
const keyOf = (r) => r && m.rect ? photoToCss(m, r.x + r.w / 2, r.y + r.h * 0.7) : null
const from = keyOf(r1)
if (from) {
  const to = [from[0] - 200 * m.scale, from[1] + 120 * m.scale]
  await page.mouse.move(from[0], from[1])
  await page.mouse.down()
  for (let i = 1; i <= 15; i++) { await page.mouse.move(from[0] + (to[0] - from[0]) * i / 15, from[1] + (to[1] - from[1]) * i / 15); await sleep(16) }
  await page.mouse.up()
  await sleep(600)
  it2 = itemOf(await state(page), uid)
  r2 = (await hook(page, 'getScreenRect', [uid])).value
}
ev.check('a mouse drag moves it across the floor (still y = 0), closer and bigger on screen', it2 && it2.position[1] === 0 && it2.position[2] > it1.position[2] + 0.1 && r2?.h > r1?.h,
  `${fmt(it1?.position)} → ${fmt(it2?.position)}; h ${r1?.h?.toFixed?.(0)} → ${r2?.h?.toFixed?.(0)} px`)
await shot('chair-dragged')
// A second chair behind the coffee table, to look at occlusion against the real depth map.
const behind = await hook(page, 'addItem', ['sheen-chair', { position: [0.15, 0, -4.6], rotation_y_deg: 180 }])
await sleep(800)
await hook(page, 'selectItem', [null])
await sleep(300)
await shot('second-chair-behind-table')
ev.note(`second chair ${behind.value || behind.error} at (0.15, 0, -4.6), facing the camera`)

// --- save a layout through the Layouts panel ------------------------------------------------------------------------------------
ev.section('save a layout')
const lay = await control(page, 'layouts', [/^layouts$/i])
if (lay.loc) await lay.loc.click().catch(() => {})
await sleep(500)
const saveNew = await control(page, 'layout-save', [/^save layout…$/i, /^save as new…$/i])
if (saveNew.loc) await saveNew.loc.click().catch(() => {})
await sleep(300)
const nameField = page.getByRole('textbox', { name: /new layout name/i })
if (await nameField.count()) await nameField.first().fill('two-chairs').catch(() => {})
const go = page.getByRole('button', { name: /^save as new$/i })
if (await go.count()) await go.first().click().catch(() => {})
const saved = await waitFor(async () => ((await hook(page, 'listLayouts')).value || []).includes('two-chairs'), { timeoutMs: 10000 })
const lst = await state(page)
ev.check('Layouts → Save layout… → name → Save as new saves "two-chairs" for this scene', !!saved && lst.layout === 'two-chairs' && !lst.dirty, `${lay.how} → ${saveNew.how}; layouts ${fmt((await hook(page, 'listLayouts')).value)}; dirty ${lst.dirty}`)
const lj = (await api.get(srv.base, `/api/layouts/two-chairs?scene=${NAME}`)).json
ev.check('the stored layout has both chairs and scene_name', lj?.scene_name === NAME && lj?.items?.length === 2, fmt({ scene_name: lj?.scene_name, items: lj?.items?.length }))
await shot('layout-saved')

// --- render twice (fal mock), keep-room the second time; compare ----------------------------------------------------------------
ev.section('render (fal mock) and compare')
async function renderOnce(keepRoom) {
  const before = (await hook(page, 'listRenders')).value?.length ?? 0
  const btn = await control(page, 'render', [/^render$/i])
  if (btn.loc) await btn.loc.click().catch(() => {})
  await sleep(700)
  const keep = await control(page, 'keep-room', [/keep room/i])
  if (keep.loc) {
    const on = await keep.loc.evaluate((el) => (el.matches('input') ? el : el.querySelector('input'))?.checked ?? null).catch(() => null)
    if (on !== keepRoom) await keep.loc.click().catch(() => {})
  }
  const f = await shot(keepRoom ? 'render-dialog-keep-room' : 'render-dialog')
  const goBtn = await control(page, 'render-go', [/^render$/i])
  if (goBtn.loc) await goBtn.loc.click().catch(() => {})
  await waitFor(async () => ((await hook(page, 'listRenders')).value?.length ?? 0) > before, { timeoutMs: 120000, intervalMs: 500 })
  await sleep(1500)
  await shot(keepRoom ? 'render-result-keep-room' : 'render-result')
  return { meta: (await hook(page, 'listRenders')).value?.[0] || null, how: `${btn.how} → ${keep.how} → ${goBtn.how} (${f})` }
}
const ra = await renderOnce(false)
ev.check('render 1 (keep room off): mock, $0, nano-banana with the scene photo as reference, the layout named', ra.meta?.mock === true && ra.meta.cost_usd === 0 && ra.meta.reference === true && ra.meta.scene === NAME && ra.meta.layout === 'two-chairs' && ra.meta.keep_room === false,
  `${ra.how}; ${fmt(ra.meta && { name: ra.meta.name, model: ra.meta.model, reference: ra.meta.reference, layout: ra.meta.layout, out: [ra.meta.out_w, ra.meta.out_h] })}`)
const rb = await renderOnce(true)
ev.check('render 2 (Keep room exact on): -raw.jpg kept and align applied (real midstudy-calib align)', rb.meta?.keep_room === true && rb.meta.aligned?.applied === true && !!rb.meta.raw_url && fs.existsSync(path.join(srv.dirs.renders, `${rb.meta.name}-raw.jpg`)),
  `${rb.how}; aligned ${fmt(rb.meta?.aligned)}; raw ${rb.meta?.raw_url}`)
ev.check('the capture is at the photo\'s resolution', ra.meta?.width === W && ra.meta?.height === H, `${ra.meta?.width} × ${ra.meta?.height} vs ${W} × ${H}`)
// Compare through the Renders panel: Compare, then pick the two renders.
await page.keyboard.press('Escape').catch(() => {})
const rp = await control(page, 'renders', [/^renders$/i])
if (rp.loc) await rp.loc.click().catch(() => {})
await sleep(600)
await shot('renders-panel')
const steps = [rp.how]
const cmp = await control(page, 'compare', [/^compare/i])
if (cmp.loc) { await cmp.loc.click().catch(() => {}); steps.push(cmp.how); await sleep(400) }
for (const r of [ra.meta, rb.meta].filter(Boolean)) {
  const th = page.locator(`img[src*="${r.name}"]`)
  for (let k = 0; k < await th.count(); k++) if (await th.nth(k).isVisible().catch(() => false)) { await th.nth(k).click().catch(() => {}); steps.push(`click ${r.name}`); break }
  await sleep(250)
}
let cv = ra.meta && rb.meta ? await inspectCompare(page, ra.meta.name, rb.meta.name, { tryToggle: false }) : { error: 'fewer than two renders' }
if (!(cv.cover >= 0.85)) {
  const again = await control(page, 'compare', [/^compare/i])
  if (again.loc) { await again.loc.click().catch(() => {}); steps.push(`${again.how} again`); await sleep(700) }
  cv = ra.meta && rb.meta ? await inspectCompare(page, ra.meta.name, rb.meta.name, { tryToggle: false }) : cv
}
ev.check('Compare from the Renders panel shows both renders full-screen, side by side', cv.cover >= 0.85 && cv.aOn >= 0.9 && cv.bOn >= 0.9 && cv.sideBySide === true, `${steps.join(' → ')}; ${fmt(cv)}`)
await shot('compare-side-by-side')
// The split slider: Compare's Split toggle (inspectCompare presses it), then drag the handle.
const cs = ra.meta && rb.meta ? await inspectCompare(page, ra.meta.name, rb.meta.name) : cv
ev.check('…and Split shows a draggable split slider', cs.slider > 0, fmt({ slider: cs.slider, toggled: cs.toggled ?? null }))
await shot('compare-split')

// The same scene and layout on a phone (390 × 844, touch).
ev.section('phone')
const Ph = await openPlanner(browser, srv.base, { device: 'phone', scene: NAME })
const lp = Ph.hookOk ? await hook(Ph.page, 'loadLayout', ['two-chairs']) : { error: Ph.why }
await sleep(1500)
const sp2 = await state(Ph.page)
const hs = await Ph.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1).catch(() => false)
await Ph.page.screenshot({ path: path.join(ev.out, `${String(++shotN).padStart(2, '0')}-phone-layout.png`) }).catch(() => {})
ev.check('the phone opens the scene and loads the layout (2 chairs), no horizontal scroll', sp2?.scene?.name === NAME && sp2.items?.length === 2 && hs && Ph.errors.page.length === 0 && Ph.errors.console.length === 0,
  lp.error || `${sp2?.items?.length} items; no h-scroll ${hs}; errors ${[...Ph.errors.page, ...Ph.errors.console].join(' | ') || 'none'}`)

ev.section('errors')
ev.check('no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
ev.check('no console errors', P.errors.console.length === 0, P.errors.console.join(' | ') || 'none')
ev.check('no request refused as cross-site', P.errors.refused.length === 0, P.errors.refused.join(' | ') || 'none')
// The user's photo stays local: remove the scenes' source.* copies (camera original with EXIF) from evals/out.
for (const d of fs.readdirSync(srv.dirs.scenes)) for (const f of fs.readdirSync(path.join(srv.dirs.scenes, d)).filter((f) => f.startsWith('source.'))) fs.rmSync(path.join(srv.dirs.scenes, d, f))
await ev.finish()
