// E3 eval:planner — the planner on the golden scenes (PLAN.md §6.2 E3; contract §4.1, §4.5, §4.6, §2.5).
// Opens each golden scene (calib stub + MIDSTUDY_CALIB_MOCK, so the camera is truth.json's): floorToPhoto of the sofa
// and table corners lands within 3 px of truth.json's corner_px (which fixtures/check_scenes.py matched to the rendered
// photo), photoToFloor inverts it, the photo is drawn as is, zoom is 2D and Fit resets it. Then adds the probe box: it
// sits on y = 0 inside the frame where §4.5 drops it; moving it from 2 m to 4 m shrinks getScreenRect by the projected
// ratio ±5 %; rotating 90° swaps its extents; a saved layout restores after a reload; a missing item loads as a
// placeholder. Expectations come from this eval's own §4.1 code (evals/lib/harness.mjs), never from the planner.
// Usage: node evals/planner_scene.mjs   (or npm run eval:planner). Screenshots: evals/out/planner/.
import fs from 'node:fs'
import path from 'node:path'
import Ajv2020 from 'ajv/dist/2020.js'
import {
  REPO, GOLDEN, PROBE, createEval, startServer, seedScene, launchBrowser, openPlanner, hook, hookAll, missingHook, state, ensureScene,
  itemOf, extents, golden, fmt, camEq, camDiff, project, photoToFloor, projectBox, expectedDrop, findPhotoOnScreen, control, sleep,
} from './lib/harness.mjs'

const ev = createEval('E3', 'planner', { timeoutS: 480 })
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false })
const vLayout = ajv.compile(JSON.parse(fs.readFileSync(path.join(REPO, 'contract/layout.schema.json'), 'utf8')))
const HOOK = ['listScenes', 'createScene', 'waitForScene', 'openScene', 'deleteScene', 'getCamera', 'setCamera', 'resetCamera', 'saveScene', 'setAdjustFloor',
  'setOcclusion', 'getScreenRect', 'photoToFloor', 'floorToPhoto', 'renderView', 'compare', 'getState', 'addItem', 'moveItem', 'selectItem', 'removeItem',
  'clearItems', 'saveLayout', 'loadLayout', 'listLayouts', 'getLibrary', 'listRenders', 'getRenderSettings', 'setRenderSettings']
const shot = (page, name) => page.screenshot({ path: path.join(ev.out, `${name}.png`) }).catch(() => {})

const srv = await startServer(ev)
ev.check('serve.py starts (calib stub + MIDSTUDY_CALIB_MOCK, scratch dirs, probe library)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const names = {}
for (const id of GOLDEN) {
  const s = await seedScene(srv, id)
  names[id] = s.name
  ev.check(`seed ${id} through POST /api/scenes: calibrated with the golden camera`, s.name && !s.why && camEq(s.scene?.camera, golden(id).truth.camera), s.why || fmt(s.scene?.camera))
}
const browser = await launchBrowser(ev)
let P = await openPlanner(browser, srv.base, { scene: names['living-wide'] })
ev.check('the planner loads ?scene=<living-wide> and window.midstudy.ready resolves', P.hookOk, P.why || P.url)
const missing = await missingHook(P.page, HOOK)
ev.check('window.midstudy has the §2.4 and §4.6 methods', missing.length === 0, missing.length ? `hook missing: ${missing.join(', ')}` : 'all present')

// --- projection on each golden scene ---------------------------------------------------------------------------------------
for (const id of GOLDEN) {
  ev.section(`${id}: camera and projection`)
  const g = golden(id), { w: W, h: H } = g.truth.image, cam = g.truth.camera
  const o = await ensureScene(P.page, names[id])
  ev.check(`${id}: openScene() shows it`, o.ok, o.why)
  const s = (await state(P.page))?.scene
  ev.check(`${id}: getState().scene has the truth camera, camera_source auto, floor_found, hasDepth, occlusion on`, s && s.name === names[id] && camEq(s.camera, cam)
    && s.camera_source === 'auto' && s.floor_found === true && s.hasDepth === true && s.occlusion === true, fmt(s))
  const gc = await hook(P.page, 'getCamera')
  ev.check(`${id}: getCamera() is truth.json's camera`, camEq(gc.value, cam), gc.error || fmt(gc.value))
  const corners = [...g.truth.objects.sofa.corners, ...g.truth.objects.table.corners]
  const want = [...g.truth.objects.sofa.corner_px, ...g.truth.objects.table.corner_px]
  const mine = corners.map((c) => project(cam, W, H, c))
  ev.check(`${id}: (harness) this eval's §4.1 code reproduces truth.json's corner_px`, mine.every((p, i) => Math.hypot(p.px - want[i][0], p.py - want[i][1]) < 0.01),
    `max ${Math.max(...mine.map((p, i) => Math.hypot(p.px - want[i][0], p.py - want[i][1]))).toFixed(4)} px`)
  const fp = await hookAll(P.page, 'floorToPhoto', corners.map((c) => [c]))
  const errsPx = fp.value ? fp.value.map((p, i) => (Array.isArray(p) ? Math.hypot(p[0] - want[i][0], p[1] - want[i][1]) : Infinity)) : []
  ev.check(`${id}: floorToPhoto() of the sofa and table corners within 3 px of the rendered photo's`, fp.value && Math.max(...errsPx) <= 3,
    fp.error || `max ${Math.max(...errsPx).toFixed(2)} px, mean ${(errsPx.reduce((a, b) => a + b, 0) / errsPx.length).toFixed(2)} px`)
  const pts = g.truth.floor_points
  const pf = await hookAll(P.page, 'photoToFloor', pts.map((p) => p.px))
  const ferr = pf.value ? pf.value.map((q, i) => (Array.isArray(q) ? Math.hypot(q[0] - pts[i].world[0], q[1], q[2] - pts[i].world[2]) : Infinity)) : []
  ev.check(`${id}: photoToFloor() of truth.json's floor points within 1 cm, y = 0`, pf.value && Math.max(...ferr) <= 0.01, pf.error || `max ${(100 * Math.max(...ferr)).toFixed(2)} cm`)
  const above = await hookAll(P.page, 'photoToFloor', [[W / 2, 5], [W / 2, 0.5]])
  ev.check(`${id}: photoToFloor() above the horizon is null`, photoToFloor(cam, W, H, W / 2, 5) === null && above.value?.every((v) => v === null), above.error || fmt(above.value))
}

// --- the view: photo as is, 2D zoom, Fit (living-wide, desktop 1280 × 800) ------------------------------------------------------
ev.section('living-wide: the photo on screen, zoom and Fit')
const LW = golden('living-wide'), { w: W, h: H } = LW.truth.image, CAM = LW.truth.camera
await ensureScene(P.page, names['living-wide'])
await sleep(500)
const sceneObj = (await (await fetch(`${srv.base}/api/scenes/${names['living-wide']}`)).json())
const m0 = await findPhotoOnScreen(P.page, sceneObj.photo_url, W, H)
await shot(P.page, 'desktop-living-wide')
ev.check('the photo is drawn as is, contain-fit (screen vs photo.jpg at 576 samples: median max-channel difference ≤ 8)', m0.rect && m0.median <= 8,
  `${m0.how}: median ${m0.median}, photo at ${fmt(m0.rect)}`)
const fitOk = m0.rect && (Math.abs(m0.rect.w - 1280) < 2 || m0.rect.w < 1280)
ev.check('contain-fit: the whole photo is inside the viewport', fitOk && m0.rect.x >= -1 && m0.rect.y >= -1 && m0.rect.x + m0.rect.w <= 1281 && m0.rect.y + m0.rect.h <= 801, fmt(m0.rect))
if (m0.rect) {
  const sofaPx = LW.truth.objects.sofa.corner_px[0]
  const before = await hookAll(P.page, 'floorToPhoto', [[LW.truth.objects.sofa.corners[0]]])
  await P.page.mouse.move(m0.rect.x + m0.rect.w / 2, m0.rect.y + m0.rect.h / 2)
  for (let i = 0; i < 4; i++) { await P.page.mouse.wheel(0, -400); await sleep(120) }
  await sleep(400)
  const mz = await findPhotoOnScreen(P.page, sceneObj.photo_url, W, H)
  await shot(P.page, 'desktop-zoomed')
  const camZ = (await hook(P.page, 'getCamera')).value
  const after = await hookAll(P.page, 'floorToPhoto', [[LW.truth.objects.sofa.corners[0]]])
  ev.check('wheel zoom changes the view (the fit mapping no longer matches the screen)', mz.how !== m0.how || mz.median > 20 || Math.abs(mz.rect?.w - m0.rect.w) > 5, `median at fit ${mz.median} (${mz.how})`)
  ev.check('zoom is 2D: the camera and photo-pixel projection are unchanged', camEq(camZ, CAM) && after.value && Math.hypot(after.value[0][0] - sofaPx[0], after.value[0][1] - sofaPx[1]) < 0.5
    && Math.hypot(after.value[0][0] - before.value[0][0], after.value[0][1] - before.value[0][1]) < 1e-6, `camera ${fmt(camZ)} corner ${fmt(after.value?.[0])}`)
  const fit = await control(P.page, 'zoom-fit', [/^fit$/i])
  if (fit.loc) { await fit.loc.click().catch(() => {}); await sleep(500) }
  const mf = await findPhotoOnScreen(P.page, sceneObj.photo_url, W, H)
  ev.check('Fit (zoom-fit) resets the zoom', !!fit.loc && mf.median <= 8 && Math.abs(mf.rect.w - m0.rect.w) < 2, `${fit.how}: median ${mf.median} rect ${fmt(mf.rect)}`)
}

// --- items -----------------------------------------------------------------------------------------------------------------------
ev.section('items on the floor (probe box 80 × 50 × 120 cm)')
const lib = await hook(P.page, 'getLibrary')
ev.check('getLibrary() lists the probe box from the scratch library', Array.isArray(lib.value) && lib.value.some((i) => i.id === PROBE.id), lib.error || fmt(lib.value?.map((i) => i.id)))
const add = await hook(P.page, 'addItem', [PROBE.id])
const uid = add.value
let st = await state(P.page)
let it = itemOf(st, uid)
ev.check('addItem() resolves with a uid listed in getState().items', typeof uid === 'string' && !!it, add.error || fmt(st?.items))
const size = extents(it?.worldBounds)
const dims = [PROBE.dims_cm.w / 100, PROBE.dims_cm.h / 100, PROBE.dims_cm.d / 100]
ev.check('it sits on the floor: position y = 0 and worldBounds min y = 0 (±1 cm)', it && Math.abs(it.position[1]) < 1e-6 && Math.abs(it.worldBounds.min[1]) <= 0.01, fmt(it))
ev.check('its worldBounds size matches dims_cm within 2 % (§2.5)', size && size.every((v, i) => Math.abs(v - dims[i]) / dims[i] <= 0.02), `${fmt(size)} vs ${fmt(dims)}`)
const drops = expectedDrop(CAM, W, H)
const dropErr = it ? Math.min(...drops.map((d) => Math.hypot(it.position[0] - d.point[0], it.position[2] - d.point[2]))) : Infinity
ev.check('§4.5: it lands where the center (else lower-third) ray meets the floor 1–6 m out, else 2.5 m ahead (≤ 5 cm)', dropErr <= 0.05,
  `at ${fmt(it?.position)}; expected ${drops.map((d) => `${d.metric} ${fmt(d.point)}`).join(' or ')}; off by ${(100 * dropErr).toFixed(1)} cm`)
let rect = await hook(P.page, 'getScreenRect', [uid])
const r0 = rect.value
ev.check('getScreenRect() is inside the photo frame (photo pixels)', r0 && r0.x >= -1 && r0.y >= -1 && r0.x + r0.w <= W + 1 && r0.y + r0.h <= H + 1 && r0.w > 10 && r0.h > 10, rect.error || fmt(r0))

const placeAt = async (z) => {
  await hook(P.page, 'moveItem', [uid, { position: [0, 0, z] }])
  await sleep(150)
  const s = await state(P.page), i = itemOf(s, uid)
  const rr = await hook(P.page, 'getScreenRect', [uid])
  return { item: i, rect: rr.value, error: rr.error, exp: i ? projectBox(CAM, W, H, i.worldBounds.min, i.worldBounds.max) : null }
}
const at2 = await placeAt(-2), at4 = await placeAt(-4)
const dRect = (a) => (a.rect && a.exp ? Math.max(Math.abs(a.rect.x - a.exp.x), Math.abs(a.rect.y - a.exp.y), Math.abs(a.rect.w - a.exp.w), Math.abs(a.rect.h - a.exp.h)) : Infinity)
ev.check('moveItem() to 2 m: position and worldBounds follow', at2.item && Math.abs(at2.item.position[2] + 2) < 1e-6 && Math.abs((at2.item.worldBounds.min[2] + at2.item.worldBounds.max[2]) / 2 + 2) < 0.01, fmt(at2.item?.position))
ev.check('getScreenRect() at 2 m is the projection of its bounds (each side within 3 px)', dRect(at2) <= 3, at2.error || `rect ${fmt(at2.rect)} expected ${fmt(at2.exp)}`)
ev.check('getScreenRect() at 4 m is the projection of its bounds (each side within 3 px)', dRect(at4) <= 3, at4.error || `rect ${fmt(at4.rect)} expected ${fmt(at4.exp)}`)
const ratio = at2.rect && at4.rect ? at4.rect.h / at2.rect.h : NaN, eratio = at2.exp && at4.exp ? at4.exp.h / at2.exp.h : NaN
ev.check('moving it from 2 m to 4 m shrinks its screen height by the projected ratio ±5 %', Math.abs(ratio / eratio - 1) <= 0.05, `h ${at2.rect?.h?.toFixed(1)} → ${at4.rect?.h?.toFixed(1)} px: ratio ${ratio.toFixed(3)}, projected ${eratio.toFixed(3)}`)
await hook(P.page, 'moveItem', [uid, { rotation_y_deg: 90 }])
st = await state(P.page)
it = itemOf(st, uid)
const ext90 = extents(it?.worldBounds)
ev.check('rotating 90° swaps the X and Z extents, around Y only (§2.5)', it && Math.abs(it.rotation_y_deg - 90) < 0.1 && ext90 && Math.abs(ext90[0] - dims[2]) / dims[2] <= 0.02
  && Math.abs(ext90[2] - dims[0]) / dims[0] <= 0.02 && Math.abs(ext90[1] - dims[1]) / dims[1] <= 0.02, `rot ${it?.rotation_y_deg} extents ${fmt(ext90)}`)
await hook(P.page, 'moveItem', [uid, { position: [0.4, 0, -3.1] }])
await shot(P.page, 'desktop-item')
const saveR = await hook(P.page, 'saveLayout', ['e3-layout'])
const lfile = path.join(srv.dirs.layouts, names['living-wide'], 'e3-layout.json')
const lj = fs.existsSync(lfile) ? JSON.parse(fs.readFileSync(lfile, 'utf8')) : null
ev.check('saveLayout() writes layouts/<scene>/e3-layout.json (layout.schema.json, scene_name)', !saveR.error && lj && vLayout(lj) && lj.scene_name === names['living-wide'] && lj.items?.length === 1,
  saveR.error || (lj ? `${(vLayout.errors || []).map((e) => e.message).join('; ') || 'valid'} ${fmt(lj.items)}` : 'no file'))
st = await state(P.page)
ev.check('getState(): layout e3-layout, not dirty', st?.layout === 'e3-layout' && st?.dirty === false, fmt({ layout: st?.layout, dirty: st?.dirty }))
const before = itemOf(st, uid)

// --- reload: everything restores -------------------------------------------------------------------------------------------------
ev.section('reload')
const errs1 = P.errors
await P.context.close()
P = await openPlanner(browser, srv.base, { scene: names['living-wide'] })
ev.check('a fresh page with ?scene= opens the scene again', P.hookOk && (await state(P.page))?.scene?.name === names['living-wide'], P.why || fmt((await state(P.page))?.scene?.name))
const ll = await hook(P.page, 'listLayouts')
ev.check('listLayouts() has e3-layout', Array.isArray(ll.value) && ll.value.includes('e3-layout'), ll.error || fmt(ll.value))
const lo = await hook(P.page, 'loadLayout', ['e3-layout'])
st = await state(P.page)
const restored = st?.items?.filter((i) => i.id === PROBE.id) || []
const rr = restored[0]
ev.check('loadLayout() restores the item: position within 1 mm, rotation within 0.1°', !lo.error && restored.length === 1 && before && rr.position.every((v, i) => Math.abs(v - before.position[i]) <= 0.001)
  && Math.abs(rr.rotation_y_deg - before.rotation_y_deg) <= 0.1, lo.error || `${fmt(rr)} vs ${fmt(before)}`)
ev.check('…and the camera, layout name and clean state', camEq(st?.scene?.camera, CAM) && st?.layout === 'e3-layout' && st?.dirty === false, fmt({ cam: st?.scene?.camera, layout: st?.layout, dirty: st?.dirty }))
await sleep(300)
await shot(P.page, 'desktop-reloaded')

const errs2 = { page: [...P.errors.page], console: [...P.errors.console], refused: [...P.errors.refused] }
// --- a missing library item ------------------------------------------------------------------------------------------------------
fs.mkdirSync(path.join(srv.dirs.layouts, names['living-wide']), { recursive: true })
fs.writeFileSync(path.join(srv.dirs.layouts, names['living-wide'], 'with-missing.json'), JSON.stringify({ version: 1, name: 'with-missing', scene_name: names['living-wide'],
  items: [{ uid: 'm1', id: 'gone-armchair', render: 'glb', position: [-0.5, 0, -2.6], rotation_y_deg: 0, dims_cm: { w: 90, d: 80, h: 100 } }] }))
const lm = await hook(P.page, 'loadLayout', ['with-missing'])
st = await state(P.page)
const mi = st?.items?.find((i) => i.id === 'gone-armchair')
const mext = extents(mi?.worldBounds)
ev.check('a layout placing a deleted item loads it as a missing placeholder at its dims_cm', !lm.error && mi?.missing === true && mext && Math.abs(mext[0] - 0.9) <= 0.02 && Math.abs(mext[1] - 1.0) <= 0.02 && Math.abs(mext[2] - 0.8) <= 0.02,
  lm.error || fmt(mi))
if (mi) await hook(P.page, 'selectItem', [mi.uid])
await sleep(300)
ev.check('selecting it shows [data-midstudy=missing-item]', await P.page.locator('[data-midstudy="missing-item"]').first().isVisible().catch(() => false), `${await P.page.locator('[data-midstudy="missing-item"]').count()} element(s)`)
await shot(P.page, 'desktop-missing')

ev.section('errors (both pages)')
const pageErrs = [...errs1.page, ...P.errors.page], consoleErrs = [...errs1.console, ...errs2.console], refused = [...errs1.refused, ...P.errors.refused]
ev.check('no page errors (uncaught exceptions)', pageErrs.length === 0, pageErrs.join(' | ') || 'none')
ev.check('no console errors in normal use (before the missing-item layout)', consoleErrs.length === 0, consoleErrs.join(' | ') || 'none')
ev.check('no request refused as cross-site (every mutation sends X-Midstudy)', refused.length === 0, refused.join(' | ') || 'none')
await ev.finish()
