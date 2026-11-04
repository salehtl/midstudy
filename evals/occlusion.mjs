// E4 eval:occlusion — the photo's depth hides furniture behind real things (PLAN.md §6.2 E4; contract §4.5 Occlusion).
// On golden living-wide (depth.png from the calib mock) the magenta probe box stands behind the sofa. The render
// composite (renderView() in mock mode writes <render>-input.jpg: the full photo frame at the photo's resolution, §4.7)
// is judged against geometry this eval computes itself: for every pixel of the box's silhouette, the box's entry depth
// along the view axis vs truth depth.png. Pixels clearly behind the sofa (≥ 10 cm, past the 3 cm tolerance) must match
// the photo (≥ 95 %); pixels clearly in front must show the box. Occlusion off: the hidden part shows. A scene without
// depth (the same photo with an unknown SHA, so the calib fallback: same default camera, no depth) never occludes.
// Usage: node evals/occlusion.mjs   (or npm run eval:occlusion). Debug overlays: evals/out/occlusion/*.png
// (blue = must be hidden, yellow = must show).
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, PROBE, DEFAULT_CAMERA, createEval, startServer, seedScene, launchBrowser, openPlanner, hook, state, ensureScene, itemOf, golden, fmt, camEq,
  pyHelper, uploadScene, waitScene, unknownPhoto, control, sleep,
} from './lib/harness.mjs'

const ev = createEval('E4', 'occlusion', { timeoutS: 480 })
const LW = golden('living-wide')
const CAM = LW.truth.camera
const BEHIND = [-0.3, 0, -4.3] // between the sofa's back (z −3.75) and the back wall (z −5.0); x inside the sofa's span

const srv = await startServer(ev)
ev.check('serve.py starts (calib stub + MIDSTUDY_CALIB_MOCK, probe library)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const D = await seedScene(srv, 'living-wide')
ev.check('scene with depth: golden living-wide, calibrated, depth_url set', D.name && !D.why && !!D.scene?.depth_url, D.why || fmt({ depth_url: D.scene?.depth_url }))
const upN = await uploadScene(srv.base, unknownPhoto(), { filename: 'no-depth.jpg', title: 'no depth' })
const N = upN.json?.scene
const sN = N ? await waitScene(srv.base, N) : null
ev.check('scene without depth: the same pixels with an unknown SHA → default fallback camera (= living-wide\'s), no depth_url', sN?.calib_status === 'done' && sN.depth_url === null
  && camEq(sN.camera, DEFAULT_CAMERA) && camEq(DEFAULT_CAMERA, CAM), fmt({ status: sN?.calib_status, depth_url: sN?.depth_url, camera: sN?.camera, upload: upN.status }))

const browser = await launchBrowser(ev)
const P = await openPlanner(browser, srv.base, { scene: D.name })
ev.check('the planner opens the scene with depth', P.hookOk, P.why || P.url)
let o = await ensureScene(P.page, D.name)
let s = (await state(P.page))?.scene
ev.check('getState().scene: hasDepth true, occlusion on by default', o.ok && s?.hasDepth === true && s?.occlusion === true, o.why + ' ' + fmt(s))
const tog = await control(P.page, 'occlusion', [/occlusion/i])
ev.check('an Occlusion toggle is on the page ([data-midstudy=occlusion])', !!tog.loc, tog.how)

const analyse = async (meta, tag, depth = LW.depth) => {
  const name = meta?.name
  const input = name ? path.join(srv.dirs.renders, `${name}-input.jpg`) : ''
  if (!name || !fs.existsSync(input)) return { error: `no composite (${meta?.error || fmt(meta)})` }
  const it = itemOf(await state(P.page), uidNow)
  if (!it) return { error: 'the item is gone from getState()' }
  return pyHelper(['occlusion', '--composite', input, '--photo', LW.photo, '--camera', JSON.stringify(CAM), '--box', JSON.stringify([it.worldBounds.min, it.worldBounds.max]),
    ...(depth ? ['--depth', depth] : []), '--debug', path.join(ev.out, `${tag}.png`)])
}
const render = async () => { const r = await hook(P.page, 'renderView', [{ model: 'nano-banana' }], 120000); return r.value || { error: r.error } }
const pct = (v) => (v == null ? 'n/a' : `${(100 * v).toFixed(1)} %`)

// --- depth on --------------------------------------------------------------------------------------------------------------------
const add = await hook(P.page, 'addItem', [PROBE.id, { position: BEHIND, rotation_y_deg: 0 }])
let uidNow = add.value
const it = itemOf(await state(P.page), uidNow)
ev.check('the probe box is placed behind the sofa', it && Math.abs(it.position[0] - BEHIND[0]) < 1e-3 && Math.abs(it.position[2] - BEHIND[2]) < 1e-3 && it.position[1] === 0, add.error || fmt(it))
await sleep(400)
await P.page.screenshot({ path: path.join(ev.out, 'view-occlusion-on.png') }).catch(() => {})
const m1 = await render()
const a1 = await analyse(m1, 'occlusion-on')
ev.check('the composite is the full photo frame at the photo\'s resolution (1600 × 1200)', fmt(a1.composite_size) === fmt([1600, 1200]), a1.error || fmt(a1.composite_size))
ev.check('(harness) the geometry gives both hidden and visible pixels of the box', a1.n_hidden > 5000 && a1.n_visible > 5000 && a1.photo_magenta === 0, a1.error || fmt({ hidden: a1.n_hidden, visible: a1.n_visible, photo_magenta: a1.photo_magenta }))
ev.check('occlusion on: the hidden pixels match the photo there (≥ 95 %)', a1.hidden_match >= 0.95, a1.error || `${pct(a1.hidden_match)} match, ${pct(a1.hidden_magenta)} show the box (${a1.n_hidden} px)`)
ev.check('occlusion on: the part above the sofa shows the box (≥ 90 %)', a1.visible_magenta >= 0.9, a1.error || `${pct(a1.visible_magenta)} of ${a1.n_visible} px; box colour outside its silhouette ${pct(a1.outside_magenta)}`)

// --- toggled off ---------------------------------------------------------------------------------------------------------------
const off = await hook(P.page, 'setOcclusion', [false])
s = (await state(P.page))?.scene
ev.check('setOcclusion(false): getState().scene.occlusion false', !off.error && s?.occlusion === false, off.error || fmt(s?.occlusion))
const m2 = await render()
const a2 = await analyse(m2, 'occlusion-off')
ev.check('occlusion off: the item shows where the sofa hid it (≥ 90 % of the hidden pixels)', a2.hidden_magenta >= 0.9, a2.error || `${pct(a2.hidden_magenta)} show the box, ${pct(a2.hidden_match)} match the photo`)
await P.page.screenshot({ path: path.join(ev.out, 'view-occlusion-off.png') }).catch(() => {})
if (tog.loc) {
  await tog.loc.click().catch(() => {})
  await sleep(300)
  s = (await state(P.page))?.scene
  ev.check('clicking the Occlusion toggle turns it back on', s?.occlusion === true, fmt(s?.occlusion))
}

// --- a manual camera height ----------------------------------------------------------------------------------------------------
// An integration addition (not in PLAN.md §6.2): depth.png is metric in the calibration's frame. With the height set 25 %
// higher in Adjust floor, the furniture's world is that frame scaled by 1.25, so the photo's depth must scale with it.
// Judged like the first case, with the manual camera, the box at 1.25 × BEHIND and the truth depth × 1.25 (the scaled
// room). Unscaled, the box would sit behind the photo's back wall (5.0 m) and vanish.
const K = 1.25
await hook(P.page, 'setOcclusion', [true])
await hook(P.page, 'setCamera', [{ height_m: CAM.height_m * K }])
await hook(P.page, 'moveItem', [uidNow, { position: BEHIND.map((v) => v * K) }])
const scaledDepth = path.join(ev.out, 'depth-x1.25.png')
const { execFileSync } = await import('node:child_process')
try {
  execFileSync(path.join(REPO, 'evals/py'), ['-c', `import numpy as np; from PIL import Image; T = np.asarray(Image.open(${JSON.stringify(LW.depth)})).astype(np.float64); Image.fromarray(np.clip(np.round(T * ${K}), 0, 65535).astype(np.uint16)).save(${JSON.stringify(scaledDepth)})`], { stdio: 'ignore' })
} catch { /* the analysis below reports the missing file */ }
await sleep(300)
const m5 = await render()
const camK = { ...CAM, height_m: CAM.height_m * K }
const a5 = await (async () => {
  const input = m5?.name ? path.join(srv.dirs.renders, `${m5.name}-input.jpg`) : ''
  const itK = itemOf(await state(P.page), uidNow)
  if (!input || !fs.existsSync(input) || !itK || !fs.existsSync(scaledDepth)) return { error: `no composite, item or scaled depth (${m5?.error || ''})` }
  return pyHelper(['occlusion', '--composite', input, '--photo', LW.photo, '--camera', JSON.stringify(camK), '--box', JSON.stringify([itK.worldBounds.min, itK.worldBounds.max]),
    '--depth', scaledDepth, '--debug', path.join(ev.out, 'manual-height.png')])
})()
ev.check('camera height × 1.25 (manual), box at 1.25 × the spot: hidden pixels match the photo (≥ 95 %) and the rest shows (≥ 90 %)', a5.hidden_match >= 0.95 && a5.visible_magenta >= 0.9 && a5.n_hidden > 2000 && a5.n_visible > 2000,
  a5.error || `${pct(a5.hidden_match)} of ${a5.n_hidden} hidden px match, ${pct(a5.visible_magenta)} of ${a5.n_visible} visible px show the box`)
await hook(P.page, 'resetCamera')
await hook(P.page, 'moveItem', [uidNow, { position: BEHIND }])

// --- a scene without depth -----------------------------------------------------------------------------------------------------
o = await ensureScene(P.page, N)
s = (await state(P.page))?.scene
ev.check('the scene without depth opens: hasDepth false', o.ok && s?.hasDepth === false, o.why + ' ' + fmt(s))
await hook(P.page, 'clearItems')
const add2 = await hook(P.page, 'addItem', [PROBE.id, { position: BEHIND, rotation_y_deg: 0 }])
uidNow = add2.value
await hook(P.page, 'setOcclusion', [true])
await sleep(400)
const m3 = await render()
const a3 = await analyse(m3, 'no-depth')
ev.check('without depth nothing occludes, even with occlusion on (≥ 90 % of the would-be hidden pixels show the box)', a3.hidden_magenta >= 0.9 && a3.visible_magenta >= 0.9,
  a3.error || `${pct(a3.hidden_magenta)} / ${pct(a3.visible_magenta)} show the box`)

ev.section('errors')
ev.check('no page errors', P.errors.page.length === 0, P.errors.page.join(' | ') || 'none')
ev.check('no console errors', P.errors.console.length === 0, P.errors.console.join(' | ') || 'none')
await ev.finish()
