// E5 eval:floor — Adjust floor (PLAN.md §6.2 E5; contract §4.5 Floor check, §4.6 camera methods, §4.4 PUT).
// On golden living-wide (calibrated camera = truth, camera_source auto): the hook's setCamera clamps and resetCamera
// restores; then through the UI (desktop 1280 × 800, mouse): Adjust floor opens; the horizon line sits on the camera's
// horizon and dragging it sets the pitch; the height, FOV and roll sliders change getCamera(); Looks right saves
// camera_source manual; a reload restores it; Reset brings back the automatic camera and Looks right then saves auto.
// A fallback scene (default calibration) opens in Adjust floor with a "Check the floor" note.
// Usage: node evals/floor.mjs   (or npm run eval:floor). Screenshots: evals/out/floor/.
import fs from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_CAMERA, createEval, startServer, seedScene, launchBrowser, openPlanner, hook, state, ensureScene, golden, fmt, camEq, camDiff,
  focalPx, uploadScene, waitScene, unknownPhoto, control, setField, findPhotoOnScreen, api, sleep, waitFor,
} from './lib/harness.mjs'

const ev = createEval('E5', 'floor', { timeoutS: 420 })
const LW = golden('living-wide'), { w: W, h: H } = LW.truth.image, TRUTH = LW.truth.camera
const shot = (page, name) => page.screenshot({ path: path.join(ev.out, `${name}.png`) }).catch(() => {})
const deg = (r) => (r * 180) / Math.PI

const srv = await startServer(ev)
ev.check('serve.py starts (calib stub + MIDSTUDY_CALIB_MOCK)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const S = await seedScene(srv, 'living-wide')
ev.check('golden living-wide calibrated: camera_source auto, truth camera', S.name && !S.why && S.scene.camera_source === 'auto' && camEq(S.scene.camera, TRUTH), S.why || fmt(S.scene?.camera))
const upN = await uploadScene(srv.base, unknownPhoto(), { filename: 'fallback.jpg' })
const N = upN.json?.scene
const sN = N ? await waitScene(srv.base, N) : null
ev.check('a fallback scene (no mock entry: calib source default, floor not found)', sN?.calib_status === 'done' && sN.floor_found === false, fmt({ status: sN?.calib_status, floor_found: sN?.floor_found }))

const browser = await launchBrowser(ev)
let P = await openPlanner(browser, srv.base, { scene: S.name })
ev.check('the planner opens the scene', P.hookOk, P.why || P.url)
await ensureScene(P.page, S.name)
let st = (await state(P.page))?.scene
ev.check('a moge-2/truth scene with its floor found does not open in Adjust floor', st && st.adjustFloor === false && st.camera_source === 'auto', fmt(st))

ev.section('hook: setCamera clamps, resetCamera restores')
await hook(P.page, 'setCamera', [{ fov_y_deg: 500, height_m: 9, pitch_deg: -100, roll_deg: 45 }])
let cam = (await hook(P.page, 'getCamera')).value
ev.check('setCamera() clamps to fov 110, height 3.0, pitch −80, roll 20', camEq(cam, { fov_y_deg: 110, height_m: 3, pitch_deg: -80, roll_deg: 20 }), fmt(cam))
await hook(P.page, 'resetCamera')
await hook(P.page, 'setCamera', [{ height_m: 1.6 }])
cam = (await hook(P.page, 'getCamera')).value
ev.check('setCamera({height_m}) changes only the height', camEq(cam, { ...TRUTH, height_m: 1.6 }), fmt(cam))
const rs = await hook(P.page, 'resetCamera')
cam = (await hook(P.page, 'getCamera')).value
st = (await state(P.page))?.scene
ev.check('resetCamera() goes back to calib.json\'s camera (camera_source auto)', !rs.error && camEq(cam, TRUTH) && st?.camera_source === 'auto', rs.error || fmt({ cam, src: st?.camera_source }))
const saved0 = (await api.get(srv.base, `/api/scenes/${S.name}`)).json
ev.check('none of that was saved (setCamera is live only)', saved0?.camera_source === 'auto' && camEq(saved0?.camera, TRUTH) && saved0?.saved === null, fmt({ src: saved0?.camera_source, saved: saved0?.saved }))

ev.section('UI: Adjust floor')
const af = await control(P.page, 'adjust-floor', [/adjust floor/i])
if (af.loc) await af.loc.click().catch(() => {})
await sleep(400)
st = (await state(P.page))?.scene
ev.check('Adjust floor ([data-midstudy=adjust-floor]) turns adjustFloor on', !!af.loc && st?.adjustFloor === true, `${af.how}; adjustFloor ${st?.adjustFloor}`)
const handles = {}
for (const h of ['cam-height', 'cam-fov', 'cam-roll', 'horizon', 'floor-ok', 'floor-reset']) handles[h] = await control(P.page, h)
const absent = Object.entries(handles).filter(([, c]) => !c.loc).map(([h]) => h)
ev.check('the Adjust floor controls are visible (cam-height, cam-fov, cam-roll, horizon, floor-ok, floor-reset)', absent.length === 0, absent.length ? `missing: ${absent.join(', ')}` : 'all visible')
await shot(P.page, 'adjust-floor')

// horizon: where it is drawn, and dragging it sets the pitch
const sceneObj = (await api.get(srv.base, `/api/scenes/${S.name}`)).json
const m = await findPhotoOnScreen(P.page, sceneObj.photo_url, W, H)
const f = focalPx(TRUTH, H)
const horizonPy = (pitch) => H / 2 - f * Math.tan((-pitch * Math.PI) / 180)
const hz = handles.horizon.loc ? await handles.horizon.loc.boundingBox().catch(() => null) : null
if (hz && m.rect) {
  const lineY = m.rect.y + horizonPy(TRUTH.pitch_deg) * m.scale
  const cy = hz.y + hz.height / 2
  ev.check('the horizon handle sits on the camera\'s horizon (within 10 CSS px)', Math.abs(cy - lineY) <= 10, `handle center y ${cy.toFixed(1)}, horizon ${lineY.toFixed(1)} (photo row ${horizonPy(TRUTH.pitch_deg).toFixed(1)}; photo on screen ${m.how}, median ${m.median})`)
  const dy = 40
  const x = hz.x + hz.width / 2
  await P.page.mouse.move(x, cy)
  await P.page.mouse.down()
  for (let i = 1; i <= 10; i++) { await P.page.mouse.move(x, cy + (dy * i) / 10); await sleep(16) }
  await P.page.mouse.up()
  await sleep(300)
  const c2 = (await hook(P.page, 'getCamera')).value
  const newRow = horizonPy(TRUTH.pitch_deg) + dy / m.scale
  const expPitch = -deg(Math.atan((H / 2 - newRow) / f))
  ev.check('dragging the horizon down 40 px raises the pitch (looks less down)', c2 && c2.pitch_deg > TRUTH.pitch_deg + 0.5, fmt(c2))
  ev.check('…to where the line follows the pointer (pitch within 1° of the dragged horizon)', c2 && Math.abs(c2.pitch_deg - expPitch) <= 1, `pitch ${c2?.pitch_deg?.toFixed(2)}°, expected ${expPitch.toFixed(2)}°`)
  ev.check('the horizon drag changes only the pitch', c2 && Math.abs(c2.fov_y_deg - TRUTH.fov_y_deg) < 1e-6 && Math.abs(c2.height_m - TRUTH.height_m) < 1e-6 && Math.abs(c2.roll_deg - TRUTH.roll_deg) < 1e-6, fmt(c2))
} else {
  ev.check('the horizon handle sits on the camera\'s horizon (within 10 CSS px)', false, `${handles.horizon.how}; photo on screen: ${m.how} median ${m.median}`)
  ev.check('dragging the horizon down 40 px raises the pitch (looks less down)', false, 'no horizon handle')
}
// sliders: height (cm), FOV (°), roll (°)
for (const [h, key, value, want, tol] of [['cam-height', 'height_m', 150, 1.5, 0.011], ['cam-fov', 'fov_y_deg', 60, 60, 0.6], ['cam-roll', 'roll_deg', 3, 3, 0.11]]) {
  const before = (await hook(P.page, 'getCamera')).value
  let how = handles[h].how, res = null
  if (handles[h].loc) {
    res = await setField(handles[h].loc, value)
    if (!res.set) { await handles[h].loc.focus().catch(() => {}); for (let i = 0; i < 5; i++) await P.page.keyboard.press('ArrowRight'); how += ' (arrow keys)' }
  }
  await sleep(200)
  const after = (await hook(P.page, 'getCamera')).value
  ev.check(`${h} changes getCamera().${key}`, before && after && Math.abs(after[key] - before[key]) > 1e-6, `${how} ${fmt(res)}: ${before?.[key]} → ${after?.[key]}`)
  if (res?.set) ev.check(`${h} = ${value} sets ${key} to ${want}`, after && Math.abs(after[key] - want) <= tol, `${after?.[key]}`)
}
await shot(P.page, 'adjusted')
const live = (await hook(P.page, 'getCamera')).value
ev.check('the adjusted camera differs from the automatic one', camDiff(live, TRUTH) > 0.5, fmt(live))

ev.section('Looks right, reload, Reset')
if (handles['floor-ok'].loc) await handles['floor-ok'].loc.click().catch(() => {})
const savedM = await waitFor(async () => { const r = (await api.get(srv.base, `/api/scenes/${S.name}`)).json; return r?.camera_source === 'manual' ? r : null }, { timeoutMs: 8000 })
ev.check('Looks right (floor-ok) saves the scene: camera_source manual, the adjusted camera', savedM && camEq(savedM.camera, live, 1e-3) && savedM.saved, fmt({ src: savedM?.camera_source, cam: savedM?.camera, live }))
const disk = JSON.parse(fs.readFileSync(path.join(srv.dirs.scenes, S.name, 'scene.json'), 'utf8'))
ev.check('scene.json holds it', disk.camera_source === 'manual' && camEq(disk.camera, live, 1e-3), fmt({ src: disk.camera_source, cam: disk.camera }))
const errs1 = P.errors
await P.context.close()
P = await openPlanner(browser, srv.base, { scene: S.name })
await ensureScene(P.page, S.name)
cam = (await hook(P.page, 'getCamera')).value
st = (await state(P.page))?.scene
ev.check('a reload restores the manual camera', camEq(cam, live, 1e-3) && st?.camera_source === 'manual', fmt({ cam, src: st?.camera_source }))
let af2 = await control(P.page, 'adjust-floor', [/adjust floor/i])
if (!(await state(P.page))?.scene?.adjustFloor && af2.loc) await af2.loc.click().catch(() => {})
await sleep(300)
const reset = await control(P.page, 'floor-reset', [/^reset$/i])
if (reset.loc) await reset.loc.click().catch(() => {})
await sleep(300)
cam = (await hook(P.page, 'getCamera')).value
st = (await state(P.page))?.scene
ev.check('Reset (floor-reset) brings back the automatic camera (camera_source auto)', !!reset.loc && camEq(cam, TRUTH, 1e-3) && st?.camera_source === 'auto', `${reset.how}: ${fmt({ cam, src: st?.camera_source })}`)
const ok2 = await control(P.page, 'floor-ok', [/looks right/i])
if (ok2.loc) await ok2.loc.click().catch(() => {})
const savedA = await waitFor(async () => { const r = (await api.get(srv.base, `/api/scenes/${S.name}`)).json; return r?.camera_source === 'auto' ? r : null }, { timeoutMs: 8000 })
ev.check('Looks right after Reset saves camera_source auto with the automatic camera', savedA && camEq(savedA.camera, TRUTH, 1e-3), fmt({ src: savedA?.camera_source, cam: savedA?.camera }))
// unchanged + Looks right keeps auto
af2 = await control(P.page, 'adjust-floor', [/adjust floor/i])
if (!(await state(P.page))?.scene?.adjustFloor && af2.loc) await af2.loc.click().catch(() => {})
await sleep(300)
const ok3 = await control(P.page, 'floor-ok', [/looks right/i])
if (ok3.loc) await ok3.loc.click().catch(() => {})
await sleep(1000)
const savedU = (await api.get(srv.base, `/api/scenes/${S.name}`)).json
ev.check('Looks right without a change keeps camera_source auto', savedU?.camera_source === 'auto' && camEq(savedU?.camera, TRUTH, 1e-3), fmt({ src: savedU?.camera_source, cam: savedU?.camera }))

ev.section('a fallback calibration opens in Adjust floor')
const o = await ensureScene(P.page, N)
await sleep(400)
st = (await state(P.page))?.scene
const text = await P.page.evaluate(() => document.body.innerText).catch(() => '')
ev.check('the fallback scene opens with adjustFloor on', o.ok && st?.adjustFloor === true, o.why + ' ' + fmt(st))
ev.check('…with a one-line note ("Check the floor")', /check the floor/i.test(text), (text.match(/[^\n]*check the floor[^\n]*/i) || ['no "Check the floor" text on the page'])[0].slice(0, 160))
await shot(P.page, 'fallback')

ev.section('errors')
const pageErrs = [...errs1.page, ...P.errors.page], consoleErrs = [...errs1.console, ...P.errors.console], refused = [...errs1.refused, ...P.errors.refused]
ev.check('no page errors', pageErrs.length === 0, pageErrs.join(' | ') || 'none')
ev.check('no console errors', consoleErrs.length === 0, consoleErrs.join(' | ') || 'none')
ev.check('no request refused as cross-site', refused.length === 0, refused.join(' | ') || 'none')
await ev.finish()
