// E16 eval:lighting — lighting inferred from the photo (contract §4.8). Written from the spec only.
//
// The golden scenes living-wide, living-cool and living-warm are the same room and camera under three known lights; the
// calib mock gives each its truth lighting.json (the lights the photo was rendered with). A lit grey box (albedo 0.5,
// roughness 1) placed on open floor must then look the way those lights make it look: every visible face's radiance
// (ACES undone) within 12 % of what lighting.json predicts, so the frame, the SH units and the tone mapping are all
// right. Its floor shadow must fall on the side away from the light and where the box's hard shadow would be, and move
// when the light is moved. The Look controls change the lighting live and are saved per scene; Reset goes back to
// the inferred light. A scene without lighting.json keeps the v1 lights (the box looks as it did in v1); one calibrated
// before lighting.json existed gets it on first open (the backfill) and is then lit by it. Unlit pieces
// (the magenta probe, a flat unlit "rug") keep their colours whatever the lighting. Splat pieces are colour-matched
// to the room and cast a shadow (checked when the library has a splat item to place). Desktop and phone controls.
//
// Usage: node evals/lighting.mjs            (npm run eval:lighting; ~3 min)
//        node evals/lighting.mjs --baseline  prints the lit box's faces under the v1 lights (to refresh V1_FACES)
// Debug images: evals/out/lighting/*.png (red: darker than the photo; cyan: the box's hard shadow; yellow: faces).
import fs from 'node:fs'
import path from 'node:path'
import {
  REPO, createEval, startServer, seedScene, launchBrowser, openPlanner, hook, state, ensureScene, itemOf, golden, fmt, boxGlb,
  pyHelper, uploadScene, waitScene, unknownPhoto, control, setField, sleep, smallTargets, horizontalScroll, touchDrag, waitFor, api,
} from './lib/harness.mjs'

const BASELINE = process.argv.includes('--baseline')
const ev = createEval('E16', BASELINE ? 'lighting-baseline' : 'lighting', { timeoutS: 1200 })
const LIT = { id: 'probe-lit', name: 'Lit probe', dims_cm: { w: 45, d: 45, h: 45 }, albedo: 0.5 }
const UNLIT = { id: 'probe-unlit', name: 'Unlit probe', dims_cm: { w: 40, d: 40, h: 40 }, rgba: [1, 0, 1, 1] }
const RUG = { id: 'probe-rug', name: 'Unlit rug', dims_cm: { w: 70, d: 50, h: 1 }, rgba: [0.1, 0.55, 0.25, 1] }
const SPLAT = { id: 'probe-splat', name: 'Splat probe', dims_cm: { w: 45, d: 45, h: 45 }, grey: 0.6 }
// points on the faces of a w × h × d box, 1 cm apart, opaque, one grey (as E13's splat probe, evals/splat.mjs)
function splatBoxPly({ w, h, d }, grey, step = 0.01) {
  const pts = []
  const faces = [[0, w, 1, h, 2, d], [2, d, 1, h, 0, w], [0, w, 2, d, 1, h]]
  for (const [ua, us, va, vs, fa, fs_] of faces) {
    const nu = Math.round(us / step), nv = Math.round(vs / step)
    for (const side of [0, 1]) for (let i = 0; i <= nu; i++) for (let j = 0; j <= nv; j++) {
      const p = [0, 0, 0]
      p[ua] = (i / nu) * us; p[va] = (j / nv) * vs; p[fa] = side * fs_
      pts.push([p[0] - w / 2, p[1], p[2] - d / 2])
    }
  }
  const props = ['x', 'y', 'z', 'f_dc_0', 'f_dc_1', 'f_dc_2', 'opacity', 'scale_0', 'scale_1', 'scale_2', 'rot_0', 'rot_1', 'rot_2', 'rot_3']
  const C0 = 0.28209479177387814
  const dc = [0, 1, 2].map(() => (grey - 0.5) / C0)
  const ls = Math.log(0.006)
  const body = new Float32Array(pts.length * props.length)
  pts.forEach((p, k) => body.set([...p, ...dc, 5.3, ls, ls, ls, 1, 0, 0, 0], k * props.length))
  const header = `ply\nformat binary_little_endian 1.0\nelement vertex ${pts.length}\n${props.map((n) => `property float ${n}\n`).join('')}end_header\n`
  return Buffer.concat([Buffer.from(header, 'ascii'), Buffer.from(body.buffer)])
}
const LIT_POS = [1.2, 0, -2.6]     // open floor right of the table, clear of the sofa; its shadow has room all round
// living-wide's light comes from behind the camera, so the shadow runs away from it: at LIT_POS it would fall under the
// real coffee table (rightly hidden). Right of the sofa it lands on open floor beside the box.
const LIT_AT = { 'living-wide': [1.3, 0, -3.1] }
const UNLIT_POS = [-1.45, 0, -2.2] // left, in front of the sofa
const RUG_POS = [-0.65, 0, -2.25]  // flat on the floor left of the table
// The lit box under the v1 lights (no lighting.json), measured on the v1 planner with --baseline on 2026-11-05.
const V1_FACES = { left: [175, 175, 175], top: [222, 222, 222], front: [215, 215, 215] }
const FACE_TOL = 0.12              // radiance within ±12 % of lighting.json's prediction
const SHADOW_TOL_DEG = 35          // the shadow's offset within 35° of straight away from the light, seen from above

function writeLibrary(dir) {
  const items = []
  const add = (it, glb, notes) => {
    fs.mkdirSync(path.join(dir, it.id), { recursive: true })
    fs.writeFileSync(path.join(dir, it.id, 'model.glb'), glb)
    items.push({ id: it.id, name: it.name, category: 'test', dims_cm: it.dims_cm, assets: { glb: `${it.id}/model.glb`, splat: null, thumb: null }, default_render: 'glb',
      source: { engine: 'fixture', input: 'generated by evals/lighting.mjs', prompt: null, cost_usd: 0, mock: false, created: '2026-11-05T00:00:00Z' }, notes })
  }
  const g = LIT.albedo
  add(LIT, boxGlb(LIT.dims_cm.w / 100, LIT.dims_cm.h / 100, LIT.dims_cm.d / 100, [g, g, g, 1], { unlit: false }), 'Eval probe: lit grey box, albedo 0.5, roughness 1.')
  add(UNLIT, boxGlb(UNLIT.dims_cm.w / 100, UNLIT.dims_cm.h / 100, UNLIT.dims_cm.d / 100, UNLIT.rgba), 'Eval probe: unlit magenta box.')
  add(RUG, boxGlb(RUG.dims_cm.w / 100, RUG.dims_cm.h / 100, RUG.dims_cm.d / 100, RUG.rgba), 'Eval probe: a flat unlit slab, like the Flat rug.')
  // a splat item (§4.5 Splats): a grey splat box (PLY, like E13's probe) drawn by Spark, with a green stand-in GLB that
  // must never show; its stand-in casts the floor shadow
  const { w, d, h } = SPLAT.dims_cm
  fs.mkdirSync(path.join(dir, SPLAT.id), { recursive: true })
  fs.writeFileSync(path.join(dir, SPLAT.id, 'model.glb'), boxGlb(w / 100, h / 100, d / 100, [0, 1, 0, 1]))
  fs.writeFileSync(path.join(dir, SPLAT.id, 'splat.ply'), splatBoxPly({ w: w / 100, h: h / 100, d: d / 100 }, SPLAT.grey))
  items.push({ id: SPLAT.id, name: SPLAT.name, category: 'test', dims_cm: { w, d, h }, assets: { glb: `${SPLAT.id}/model.glb`, splat: `${SPLAT.id}/splat.ply`, spz: null, thumb: null },
    default_render: 'splat', source: { engine: 'fixture', input: 'generated by evals/lighting.mjs', prompt: null, cost_usd: 0, mock: false, created: '2026-11-05T00:00:00Z' },
    notes: 'Eval probe: a grey splat box (PLY), green stand-in GLB that must never be drawn.', splat: true })
  fs.writeFileSync(path.join(dir, 'library.json'), JSON.stringify({ version: 1, items: items.map(({ splat, ...it }) => it) }, null, 2))
  return items
}
const boxOf = (pos, dims) => [[pos[0] - dims.w / 200, pos[1], pos[2] - dims.d / 200], [pos[0] + dims.w / 200, pos[1] + dims.h / 100, pos[2] + dims.d / 200]]
const deg = (r) => r * 180 / Math.PI
const rad = (d) => d * Math.PI / 180
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l) }
const angle = (a, b) => deg(Math.acos(Math.max(-1, Math.min(1, norm(a).reduce((s, x, i) => s + x * norm(b)[i], 0)))))
const azEl = (d) => ({ az: deg(Math.atan2(d[0], -d[2])), el: deg(Math.asin(Math.max(-1, Math.min(1, norm(d)[1])))) })
const dirOf = (az, el) => [Math.cos(rad(el)) * Math.sin(rad(az)), Math.sin(rad(el)), -Math.cos(rad(el)) * Math.cos(rad(az))]
const wrap = (a) => ((a + 540) % 360) - 180
// contract §4.1: camera-to-world R = Rx(pitch) · Rz(roll)
function camToWorld(cam, v) {
  const p = rad(cam.pitch_deg), r = rad(cam.roll_deg)
  const cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r)
  const R = [[cr, -sr, 0], [cp * sr, cp * cr, -sp], [sp * sr, sp * cr, cp]]
  return R.map((row) => row[0] * v[0] + row[1] * v[1] + row[2] * v[2])
}
const lum = (rgb) => 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]

// --- setup ------------------------------------------------------------------------------------------------------------------
const srv = await startServer(ev, { library: 'custom' })
ev.check('serve.py starts (calib stub + MIDSTUDY_CALIB_MOCK)', srv.up, srv.up ? srv.base : srv.why)
if (!srv.up) await ev.finish()
const libItems = writeLibrary(srv.dirs.library)
const splatItem = libItems.find((i) => i.splat) || null
const S = {}
for (const id of ['living-wide', 'living-cool', 'living-warm']) {
  const r = await seedScene(srv, id)
  const g = golden(id)
  S[id] = { ...r, g, lj: JSON.parse(fs.readFileSync(path.join(g.dir, 'lighting.json'), 'utf8')), cam: g.truth.camera }
}
const up = await uploadScene(srv.base, unknownPhoto('living-wide'), { filename: 'no-light.jpg', title: 'no lighting' })
const N = up.json?.scene ? await waitScene(srv.base, up.json.scene) : null

if (!BASELINE) {
  ev.section('server: lighting.json reaches the planner (§4.4)')
  const got = {}
  for (const id of Object.keys(S)) got[id] = (await api.get(srv.base, `/api/scenes/${S[id].name}`)).json?.lighting ?? 'missing'
  const gN = N ? (await api.get(srv.base, `/api/scenes/${N.name}`)).json : null
  ev.check('GET /api/scenes/<name> carries `lighting`: the truth lighting.json for the golden scenes, null without one',
    Object.keys(S).every((id) => got[id]?.source === 'truth' && fmt(got[id]?.key) === fmt(S[id].lj.key)) && gN && gN.lighting === null,
    fmt({ ...Object.fromEntries(Object.entries(got).map(([k, v]) => [k, v?.source ?? v])), 'no-light': gN ? gN.lighting : 'no scene' }))
  const st = await api.get(srv.base, `/scenes/${S['living-wide'].name}/lighting.json`)
  ev.check('lighting.json itself is not served statically (404; the API serves it)', st.status === 404, st.status)
}

const browser = await launchBrowser(ev)
let P = null
async function open(name) {
  // leave the page as a closing tab does (pagehide), so a Look change made just before is saved (it saves itself
  // 0.7 s after a change, at once on pagehide); closing the browser context alone would drop it
  if (P) { await P.page.evaluate(() => dispatchEvent(new Event('pagehide'))).catch(() => {}); await sleep(400); await P.context.close().catch(() => {}) }
  P = await openPlanner(browser, srv.base, { scene: name })
  const o = await ensureScene(P.page, name)
  return o.ok ? '' : (P.why || o.why)
}
const L = async () => (await hook(P.page, 'getLighting')).value ?? null
async function place(id, pos) {
  const r = await hook(P.page, 'addItem', [id, { position: pos, rotation_y_deg: 0 }])
  return r.value || null
}
async function measure(tag, scene, lightingArgs = {}, box = boxOf(LIT_POS, LIT.dims_cm), exclude = []) {
  await sleep(300)
  const m = await hook(P.page, 'renderView', [{ model: 'nano-banana' }], 120000)
  const name = m.value?.name
  const input = name ? path.join(srv.dirs.renders, `${name}-input.jpg`) : ''
  if (!name || !fs.existsSync(input)) return { error: `no composite (${m.error || fmt(m.value)})` }
  const args = ['lighting', '--composite', input, '--photo', scene.g.photo, '--camera', JSON.stringify(scene.cam), '--box', JSON.stringify(box), '--debug', path.join(ev.out, `${tag}.png`)]
  if (fs.existsSync(path.join(scene.g.dir, 'depth.png'))) args.push('--depth', path.join(scene.g.dir, 'depth.png')) // real things in front of the probe aren't measured
  if (lightingArgs.lighting !== false) args.push('--lighting', lightingArgs.lighting || path.join(scene.g.dir, 'lighting.json'))
  for (const k of ['strength', 'ambient']) if (lightingArgs[k] != null) args.push(`--${k}`, String(lightingArgs[k]))
  if (lightingArgs.light) args.push('--light', JSON.stringify(lightingArgs.light))
  if (exclude.length) args.push('--exclude', JSON.stringify(exclude))
  return pyHelper(args)
}
const faceSummary = (r) => Object.fromEntries(Object.entries(r?.faces || {}).map(([k, f]) => [k, { rgb: f.rgb, exp: f.expected_rgb, ratio: f.ratio }]))
const facesOk = (r) => { const f = Object.values(r?.faces || {}); return f.length >= 2 && f.every((x) => Math.abs(x.ratio - 1) <= FACE_TOL) }

// --- v1 baseline (no lighting.json) ------------------------------------------------------------------------------------------
if (BASELINE) {
  const why = await open(N.name)
  await place(LIT.id, LIT_POS)
  const r = await measure('baseline-v1', { g: golden('living-wide'), cam: golden('living-wide').truth.camera }, { lighting: false })
  console.log(`V1_FACES = ${JSON.stringify(Object.fromEntries(Object.entries(r.faces || {}).map(([k, f]) => [k, f.rgb])))}  ${why} ${r.error || ''}`)
  await ev.finish()
}

// --- meshes lit by lighting.json --------------------------------------------------------------------------------------------
const perScene = {}
for (const id of ['living-cool', 'living-warm', 'living-wide']) {
  ev.section(`${id}: the lit box under the scene's lights`)
  const sc = S[id]
  const why = await open(sc.name)
  const lg = await L()
  const truthDir = norm(camToWorld(sc.cam, sc.lj.key.direction))
  const inf = lg?.inferred
  ev.check(`${id}: getLighting(): source truth, Auto lighting on, the inferred key in the world frame of the scene's camera (≤ 0.5°), in use`,
    !why && lg?.source === 'truth' && lg.auto_light === true && inf && angle(inf.direction, truthDir) <= 0.5 && angle(lg.key.direction, truthDir) <= 0.5
      && lg.cast_shadows === true && lg.light_strength === 1 && lg.ambient === 1,
    why || fmt({ source: lg?.source, auto: lg?.auto_light, inferred: inf && azEl(inf.direction), truth: azEl(truthDir), key: lg?.key && azEl(lg.key.direction), cast: lg?.cast_shadows }))
  const at = LIT_AT[id] || LIT_POS
  const uid = await place(LIT.id, at)
  await hook(P.page, 'setLighting', [{ contact_shadows: false }])
  const r = await measure(`${id}-auto`, sc, { light: truthDir }, boxOf(at, LIT.dims_cm))
  perScene[id] = r
  ev.check(`${id}: every visible face of the lit box within ${FACE_TOL * 100} % of lighting.json's prediction (mesh lit by the inferred light)`, facesOk(r), r.error || fmt(faceSummary(r)))
  const sh = r.shadow || {}
  ev.check(`${id}: its floor shadow falls away from the light (offset within ${SHADOW_TOL_DEG}° of −light, seen from above) and where the box's shadow is (≥ 60 % of the darkened floor)`,
    sh.n_dark > 300 && sh.offset_vs_light_deg <= SHADOW_TOL_DEG && sh.dark_inside_expected >= 0.6,
    r.error || fmt({ n_dark: sh.n_dark, offset: sh.offset, vs_light: sh.offset_vs_light_deg, inside: sh.dark_inside_expected, expected_darkened: sh.expected_darkened, expected_px: sh.expected_px, light: azEl(truthDir) }))
  if (id === 'living-cool') perScene.uid = uid
}
const fl = (r, k) => r?.faces?.[k] ? lum(r.faces[k].rgb) : NaN
const cool = perScene['living-cool'], warm = perScene['living-warm']
ev.check('two lights, two looks: the box\'s left face against its top is much brighter in living-cool (light from the left) than in living-warm (from the right)',
  fl(cool, 'left') / fl(cool, 'top') > 1.5 * (fl(warm, 'left') / fl(warm, 'top')),
  fmt({ cool: fl(cool, 'left') / fl(cool, 'top'), warm: fl(warm, 'left') / fl(warm, 'top') }))
const cwr = (r) => r?.faces?.top ? r.faces.top.rgb[0] / r.faces.top.rgb[2] : NaN
ev.check('…and warmer in living-warm: the top face\'s red/blue ratio higher than in living-cool', cwr(warm) > 1.15 * cwr(cool), fmt({ cool: cwr(cool), warm: cwr(warm) }))

// --- controls -----------------------------------------------------------------------------------------------------------------
ev.section('living-cool: the Look controls')
const C = S['living-cool']
await open(C.name)
await hook(P.page, 'clearItems')
await place(LIT.id, LIT_POS)
await hook(P.page, 'setLighting', [{ contact_shadows: false }])
let lg = await L()
const auto = lg?.inferred ? azEl(lg.inferred.direction) : { az: 0, el: 40 }
const newAz = wrap(auto.az + 180), newEl = 35
await hook(P.page, 'setLighting', [{ light_azimuth_deg: newAz, light_elevation_deg: newEl }])
lg = await L()
const newDir = dirOf(newAz, newEl)
ev.check('setLighting({light_azimuth_deg, light_elevation_deg}) turns Auto lighting off and moves the key there', lg?.auto_light === false && angle(lg.key.direction, newDir) <= 1
  && Math.abs(lg.light_azimuth_deg - newAz) <= 0.5 && Math.abs(lg.light_elevation_deg - newEl) <= 0.5, fmt({ auto: lg?.auto_light, key: lg?.key && azEl(lg.key.direction), want: { az: newAz, el: newEl } }))
// what lighting.json would say with the key turned: rewrite the key direction (camera frame) for the helper
const turned = path.join(ev.out, 'cool-turned.json')
const Rt = (v) => { // world -> camera: Rᵀ v
  const p = rad(C.cam.pitch_deg), r = rad(C.cam.roll_deg), cp = Math.cos(p), sp = Math.sin(p), cr = Math.cos(r), sr = Math.sin(r)
  const R = [[cr, -sr, 0], [cp * sr, cp * cr, -sp], [sp * sr, sp * cr, cp]]
  return [0, 1, 2].map((j) => R[0][j] * v[0] + R[1][j] * v[1] + R[2][j] * v[2])
}
fs.writeFileSync(turned, JSON.stringify({ ...C.lj, key: { ...C.lj.key, direction: Rt(newDir) } }))
let r = await measure('cool-turned', C, { lighting: turned, light: newDir })
ev.check('…the box is lit from there (faces within 12 % of the prediction) and its shadow moves to the other side', facesOk(r) && r.shadow?.offset_vs_light_deg <= SHADOW_TOL_DEG,
  r.error || fmt({ faces: faceSummary(r), vs_light: r.shadow?.offset_vs_light_deg, offset: r.shadow?.offset }))
const darkTurned = r.shadow?.n_dark ?? 0
await hook(P.page, 'setLighting', [{ light_strength: 0 }])
r = await measure('cool-strength0', C, { lighting: turned, strength: 0, light: newDir })
ev.check('light_strength 0: ambient light only (faces within 12 % of the ambient-only prediction), no cast shadow', facesOk(r) && (r.shadow?.n_dark ?? 0) <= Math.max(50, 0.05 * darkTurned),
  r.error || fmt({ faces: faceSummary(r), n_dark: r.shadow?.n_dark, before: darkTurned }))
await hook(P.page, 'setLighting', [{ light_strength: 1, ambient: 0.5 }])
r = await measure('cool-ambient05', C, { lighting: turned, ambient: 0.5, light: newDir })
ev.check('ambient 0.5: the ambient part halved (faces within 12 % of that prediction)', facesOk(r), r.error || fmt(faceSummary(r)))
await hook(P.page, 'setLighting', [{ ambient: 1, light_softness: 0 }])
const hard = await measure('cool-soft0', C, { lighting: turned, light: newDir })
await hook(P.page, 'setLighting', [{ light_softness: 1 }])
const soft = await measure('cool-soft1', C, { lighting: turned, light: newDir })
ev.check('light_softness 0 → 1 softens the shadow: its edge spreads (more floor touched by ≥ 2 %) and its core is lighter',
  (soft.shadow?.n_dark_2pct ?? 0) > 1.15 * (hard.shadow?.n_dark_2pct ?? Infinity) && (soft.shadow?.mean_ratio_dark ?? 0) > (hard.shadow?.mean_ratio_dark ?? 1),
  fmt({ hard: hard.shadow && { n2: hard.shadow.n_dark_2pct, core: hard.shadow.mean_ratio_dark }, soft: soft.shadow && { n2: soft.shadow.n_dark_2pct, core: soft.shadow.mean_ratio_dark } }))
await hook(P.page, 'setLighting', [{ light_softness: 0.3, cast_shadows: false }])
r = await measure('cool-noshadow', C, { lighting: turned, light: newDir })
ev.check('cast_shadows false: no floor shadow', (r.shadow?.n_dark ?? Infinity) <= Math.max(50, 0.05 * darkTurned), r.error || fmt({ n_dark: r.shadow?.n_dark, before: darkTurned }))
await hook(P.page, 'setLighting', [{ cast_shadows: true, light_strength: 1.5, exposure: 1.2, warmth: 0.3 }])
const want = { auto_light: false, light_azimuth_deg: newAz, light_elevation_deg: newEl, light_softness: 0.3, light_strength: 1.5, ambient: 1, cast_shadows: true, contact_shadows: false, exposure: 1.2, warmth: 0.3 }
const sv = await hook(P.page, 'saveScene')
const look = (await api.get(srv.base, `/api/scenes/${C.name}`)).json?.look || {}
const same = (a, b) => Object.entries(want).every(([k, v]) => typeof v === 'number' ? Math.abs((a?.[k] ?? NaN) - v) <= 0.01 : a?.[k] === v)
ev.check('saveScene() stores the Look in scene.json (auto_light, direction, softness, strength, ambient, shadows, exposure, warmth)', !sv.error && same(look, want), sv.error || fmt(look))
await open(C.name)
lg = await L()
ev.check('after a reload the scene opens with the same lighting settings', same(lg, want) && angle(lg?.key?.direction || [0, 0, 0], newDir) <= 1, fmt(lg && Object.fromEntries(Object.keys(want).map((k) => [k, lg[k]]))))
await hook(P.page, 'setLighting', [{ light_strength: 1.25 }])
await sleep(1500)
const auto1 = (await api.get(srv.base, `/api/scenes/${C.name}`)).json?.look || {}
ev.check('a Look change saves itself without Save scene (scene.json has it within 1.5 s)', Math.abs((auto1.light_strength ?? 0) - 1.25) <= 1e-6, fmt({ stored: auto1.light_strength }))
await hook(P.page, 'setLighting', [{ light_strength: 1.5 }])
await hook(P.page, 'openScene', [S['living-warm'].name]) // in the app, at once, before the 0.7 s save: switching saves it first
lg = await L()
const auto2 = (await api.get(srv.base, `/api/scenes/${C.name}`)).json?.look || {}
ev.check('…and switching scenes right after a change keeps it (saved on the way out)', Math.abs((auto2.light_strength ?? 0) - 1.5) <= 1e-6, fmt({ stored: auto2.light_strength }))
ev.check('…and another scene keeps its own (living-warm still on Auto lighting)', lg?.auto_light === true && lg.light_strength === 1, fmt(lg && { auto: lg.auto_light, strength: lg.light_strength }))
await open(C.name)
await hook(P.page, 'resetLighting')
lg = await L()
ev.check('resetLighting(): Auto lighting on, strength and ambient 1, exposure 1, warmth 0, the inferred key back', lg?.auto_light === true && lg.light_strength === 1 && lg.ambient === 1
  && lg.exposure === 1 && lg.warmth === 0 && lg.inferred && angle(lg.key.direction, lg.inferred.direction) <= 0.5, fmt(lg && { auto: lg.auto_light, s: lg.light_strength, a: lg.ambient, e: lg.exposure, w: lg.warmth }))
await hook(P.page, 'saveScene')
const look2 = (await api.get(srv.base, `/api/scenes/${C.name}`)).json?.look || {}
ev.check('…saved: scene.json says auto_light true and keeps no stale direction', look2.auto_light !== false && look2.light_azimuth_deg == null && look2.light_elevation_deg == null, fmt(look2))

// --- unlit pieces --------------------------------------------------------------------------------------------------------------
ev.section('unlit pieces keep their colours')
const unlitBox = boxOf(UNLIT_POS, UNLIT.dims_cm), rugBox = boxOf(RUG_POS, RUG.dims_cm)
const unlitLooks = []
for (const [id, settings] of [['living-cool', {}], ['living-cool', { light_strength: 3, ambient: 3 }], ['living-cool', { light_strength: 0, ambient: 0 }], ['living-warm', {}]]) {
  await open(S[id].name)
  await hook(P.page, 'clearItems')
  await place(UNLIT.id, UNLIT_POS)
  await place(RUG.id, RUG_POS)
  await hook(P.page, 'setLighting', [{ contact_shadows: false, ...settings }])
  const a = await measure(`unlit-${id}-${Object.keys(settings).length ? 'extreme' : 'auto'}${settings.light_strength === 0 ? '0' : ''}`, S[id], { lighting: false }, unlitBox, [rugBox])
  const b = await measure(`rug-${id}`, S[id], { lighting: false }, rugBox, [unlitBox])
  unlitLooks.push({ id, settings, box: a.faces, rug: b.faces?.top?.rgb })
  await hook(P.page, 'resetLighting')
}
const spread = (vals) => Math.max(...[0, 1, 2].map((c) => Math.max(...vals.map((v) => v[c])) - Math.min(...vals.map((v) => v[c]))))
const boxTops = unlitLooks.map((u) => u.box?.top?.rgb).filter(Boolean), boxFronts = unlitLooks.map((u) => u.box?.front?.rgb).filter(Boolean), rugs = unlitLooks.map((u) => u.rug).filter(Boolean)
ev.check('an unlit box looks the same under every lighting (two scenes, strength and ambient 0 to 3: ≤ 4 levels per channel)', boxTops.length === 4 && boxFronts.length === 4 && spread(boxTops) <= 4 && spread(boxFronts) <= 4,
  fmt({ top: boxTops, front: boxFronts }))
ev.check('a flat unlit slab (the Flat rug) looks the same too (≤ 4 levels)', rugs.length === 4 && spread(rugs) <= 4, fmt(rugs))

// --- no lighting.json: the v1 lights ---------------------------------------------------------------------------------------------
ev.section('a scene without lighting.json keeps the v1 lights')
if (N) {
  await open(N.name)
  lg = await L()
  ev.check('getLighting(): source default, no inferred light, no cast shadow by default', lg?.source === 'default' && lg.inferred === null && lg.cast_shadows === false,
    fmt(lg && { source: lg.source, inferred: lg.inferred, cast: lg.cast_shadows }))
  await place(LIT.id, LIT_POS)
  const nScene = { g: golden('living-wide'), cam: N.camera }
  r = await measure('nolight-v1', nScene, { lighting: false })
  const d = V1_FACES ? Math.max(...Object.entries(V1_FACES).map(([k, v]) => r.faces?.[k] ? Math.max(...v.map((x, i) => Math.abs(x - r.faces[k].rgb[i]))) : Infinity)) : null
  if (V1_FACES) ev.check('the lit box looks as it did in v1 (each face within 4 levels of the v1 measurement)', d <= 4, fmt({ max_diff: d, now: faceSummary(r), v1: V1_FACES }))
  else ev.skip('the lit box looks as it did in v1', 'V1_FACES not recorded yet (run with --baseline on v1)')
  await hook(P.page, 'setLighting', [{ light_strength: 2 }])
  const r2 = await measure('nolight-strength2', nScene, { lighting: false })
  const brighter = Object.keys(r.faces || {}).some((k) => r2.faces?.[k] && lum(r2.faces[k].rgb) > lum(r.faces[k].rgb) + 6)
  ev.check('…the controls still work on the v1 lights (strength 2 brightens the lit side)', brighter, fmt({ before: faceSummary(r), after: faceSummary(r2) }))
} else ev.check('scene without lighting.json uploaded', false, fmt(up.json || up.status))

// --- old scenes: the backfill ----------------------------------------------------------------------------------------------------
ev.section('an old scene gets its light on first open (§4.8 backfill)')
const O = await seedScene(srv, 'living-cool', 'old scene')
const oDir = path.join(srv.dirs.scenes, O.name || 'none')
const oOk = !!O.name && fs.existsSync(path.join(oDir, 'lighting.json'))
if (oOk) fs.rmSync(path.join(oDir, 'lighting.json')) // as if it was calibrated before lighting.json existed
const calibBytes = oOk ? fs.readFileSync(path.join(oDir, 'calib.json')) : null
const g0 = O.name ? (await api.get(srv.base, `/api/scenes/${O.name}`)).json : null
ev.check('a scene calibrated before lighting.json existed: GET says lighting null, lighting_status "missing"', oOk && g0?.lighting === null && g0?.lighting_status === 'missing',
  fmt({ why: O.why, lighting: g0?.lighting, status: g0?.lighting_status }))
async function settle(timeoutS = 30) {
  const seen = new Set(), t0 = Date.now()
  let lo = null
  while ((Date.now() - t0) / 1000 < timeoutS) {
    lo = await L()
    if (lo?.status) seen.add(lo.status)
    if (lo?.source !== 'default' || ['none', 'failed'].includes(lo?.status)) break
    await sleep(250)
  }
  return { lo, seen: [...seen], secs: (Date.now() - t0) / 1000 }
}
if (oOk) {
  const why = await open(O.name)
  const { lo, seen, secs } = await settle()
  const truthDir = norm(camToWorld(C.cam, C.lj.key.direction))
  ev.check('opening it infers the light with no other step: within 30 s getLighting() has source truth (the mock\'s lighting.json), Auto lighting on, the key is the scene\'s light, cast shadows on',
    !why && lo?.source === 'truth' && lo.status === 'done' && lo.auto_light === true && angle(lo.key.direction, truthDir) <= 0.5 && lo.cast_shadows === true,
    fmt({ why, statuses: seen, source: lo?.source, status: lo?.status, secs, key: lo?.key && azEl(lo.key.direction), truth: azEl(truthDir) }))
  const lp = path.join(oDir, 'lighting.json')
  const g1 = (await api.get(srv.base, `/api/scenes/${O.name}`)).json
  ev.check('…lighting.json is now in the scene folder (the mock\'s, byte for byte); calib.json, the camera and calib_status are unchanged',
    fs.existsSync(lp) && fs.readFileSync(lp, 'utf8') === fs.readFileSync(path.join(C.g.dir, 'lighting.json'), 'utf8') && fs.readFileSync(path.join(oDir, 'calib.json')).equals(calibBytes)
      && g1?.calib_status === 'done' && g1?.lighting_status === 'done' && fmt(g1?.camera) === fmt(g0?.camera),
    fmt({ file: fs.existsSync(lp), status: g1?.lighting_status, calib_status: g1?.calib_status, camera: g1?.camera, before: g0?.camera }))
  await place(LIT.id, LIT_POS)
  await hook(P.page, 'setLighting', [{ contact_shadows: false }])
  r = await measure('old-scene', C, { light: truthDir })
  ev.check('…and the furniture is lit by it (the lit box\'s faces within 12 % of the prediction, its shadow away from the light)', facesOk(r) && r.shadow?.offset_vs_light_deg <= SHADOW_TOL_DEG,
    r.error || fmt({ faces: faceSummary(r), vs_light: r.shadow?.offset_vs_light_deg }))
  await hook(P.page, 'setLighting', [{ light_strength: 1.4 }])
  lg = await L()
  ev.check('…its controls work on the inferred light (strength 1.4 → key intensity 1.4 × lighting.json\'s)', Math.abs((lg?.key?.intensity ?? 0) - 1.4 * C.lj.key.intensity) <= 1e-3,
    fmt({ intensity: lg?.key?.intensity, want: 1.4 * C.lj.key.intensity }))
}
if (N) {
  await open(N.name)
  const { lo, seen } = await settle(30)
  const gN = (await api.get(srv.base, `/api/scenes/${N.name}`)).json
  ev.check('a photo with no light to find (calib mock miss): the backfill ends "none", the v1 lights stay, nothing is written', lo?.status === 'none' && lo.source === 'default' && gN?.lighting === null
    && gN?.lighting_status === 'none' && !fs.existsSync(path.join(srv.dirs.scenes, N.name, 'lighting.json')), fmt({ statuses: seen, status: lo?.status, source: lo?.source, server: gN?.lighting_status }))
}

// --- splats ------------------------------------------------------------------------------------------------------------------------
ev.section('splats are colour-matched and cast a shadow')
if (splatItem) {
  const sp = {}
  for (const id of ['living-cool', 'living-warm']) {
    await open(S[id].name)
    await hook(P.page, 'clearItems')
    const sDims = splatItem.dims_cm
    const pos = [1.1, 0, -2.6]
    const uid = await place(splatItem.id, pos)
    const it = itemOf(await state(P.page), uid)
    await hook(P.page, 'setLighting', [{ contact_shadows: false }])
    const box = it?.worldBounds ? [it.worldBounds.min, it.worldBounds.max] : boxOf(pos, sDims)
    sp[id] = await measure(`splat-${id}`, S[id], { lighting: false, light: norm(camToWorld(S[id].cam, S[id].lj.key.direction)) }, box)
    sp[id].render = it?.render
  }
  const mean = (r) => { const f = Object.values(r?.faces || {}); return f.length ? [0, 1, 2].map((c) => f.reduce((s, x) => s + x.rgb[c] * x.n_px, 0) / f.reduce((s, x) => s + x.n_px, 0)) : null }
  const mc = mean(sp['living-cool']), mw = mean(sp['living-warm'])
  ev.check('the splat item is drawn as a splat (getState render "splat"), lit grey (mean ≥ 60 levels), never its green stand-in', sp['living-cool'].render === 'splat' && mc && mw
    && [mc, mw].every((m) => m[1] < 1.15 * Math.max(m[0], m[2]) && lum(m) >= 60), fmt({ render: sp['living-cool'].render, cool: mc, warm: mw }))
  ev.check('a splat is colour-matched: warmer in living-warm than in living-cool (red/blue ratio ≥ 1.1× higher)', mc && mw && (mw[0] / mw[2]) > 1.1 * (mc[0] / mc[2]), fmt({ cool: mc, warm: mw }))
  ev.check('its hidden box casts a floor shadow away from the light', ['living-cool', 'living-warm'].every((id) => sp[id].shadow?.n_dark > 200 && sp[id].shadow?.offset_vs_light_deg <= SHADOW_TOL_DEG),
    fmt(Object.fromEntries(Object.entries(sp).map(([k, v]) => [k, v.shadow && { n: v.shadow.n_dark, vs: v.shadow.offset_vs_light_deg }]))))
} else ev.check('the splat probe is in the library', false, 'missing')

// --- the controls in the UI ---------------------------------------------------------------------------------------------------------
const HANDLES = ['light-auto', 'light-reset', 'light-dir', 'light-strength', 'light-softness', 'light-ambient', 'look-exposure', 'look-warmth', 'light-shadows', 'contact-shadows']
async function openScenePanel(page, touch) {
  for (let i = 0; i < 2; i++) {
    const c = await control(page, 'light-auto')
    if (c.loc) return 'already open'
    const tab = await control(page, 'panel-scene', [/^scene$/i])
    if (!tab.loc) return tab.how
    if (touch) await tab.loc.tap().catch(() => {}); else await tab.loc.click().catch(() => {})
    await sleep(600)
  }
  return 'opened'
}
async function uiChecks(device) {
  ev.section(`Scene › Look on the ${device}`)
  if (P) await P.context.close().catch(() => {})
  P = await openPlanner(browser, srv.base, { scene: C.name, device })
  await ensureScene(P.page, C.name)
  const touch = device === 'phone'
  const how = await openScenePanel(P.page, touch)
  const found = {}
  for (const hnd of HANDLES) {
    const c = await control(P.page, hnd)
    if (c.loc && touch) await c.loc.scrollIntoViewIfNeeded().catch(() => {})
    found[hnd] = c
  }
  const missing = HANDLES.filter((k) => !found[k].loc)
  ev.check(`${device}: Scene › Look shows every lighting control (${HANDLES.join(', ')})`, !missing.length, missing.length ? `missing ${missing.join(', ')} (${how})` : how)
  const act = (loc) => (touch ? loc.tap() : loc.click())
  if (found['light-strength'].loc) {
    await found['light-strength'].loc.scrollIntoViewIfNeeded().catch(() => {})
    const s = await setField(found['light-strength'].loc, 2)
    await sleep(200)
    ev.check(`${device}: the strength slider sets light_strength`, Math.abs(((await L())?.light_strength ?? 0) - 2) <= 0.05, fmt({ set: s, now: (await L())?.light_strength }))
  }
  if (found['light-dir'].loc) {
    const before = await L()
    await found['light-dir'].loc.scrollIntoViewIfNeeded().catch(() => {})
    const bb = await found['light-dir'].loc.boundingBox()
    if (bb) {
      const from = [bb.x + bb.width * 0.5, bb.y + bb.height * 0.5], to = [bb.x + bb.width * 0.15, bb.y + bb.height * 0.35]
      if (touch) await touchDrag(P.page, from, to)
      else { await P.page.mouse.move(...from); await P.page.mouse.down(); await P.page.mouse.move(...to, { steps: 8 }); await P.page.mouse.up() }
      await sleep(300)
    }
    const after = await L()
    ev.check(`${device}: dragging the light direction moves the key and turns Auto lighting off`, after?.auto_light === false && before?.key && after?.key && angle(before.key.direction, after.key.direction) >= 5,
      fmt({ bb, before: before?.key && azEl(before.key.direction), after: after?.key && azEl(after.key.direction), auto: after?.auto_light }))
  }
  if (found['light-reset'].loc) {
    await found['light-reset'].loc.scrollIntoViewIfNeeded().catch(() => {})
    await act(found['light-reset'].loc).catch(() => {})
    await sleep(300)
    const l2 = await L()
    ev.check(`${device}: Reset goes back to the inferred light (Auto lighting on, strength 1)`, l2?.auto_light === true && l2.light_strength === 1, fmt(l2 && { auto: l2.auto_light, s: l2.light_strength }))
  }
  if (found['light-shadows'].loc) {
    const c0 = (await L())?.cast_shadows
    await act(found['light-shadows'].loc).catch(() => {})
    await sleep(200)
    ev.check(`${device}: the floor shadow toggle flips cast_shadows`, (await L())?.cast_shadows === !c0, fmt({ before: c0, after: (await L())?.cast_shadows }))
    await act(found['light-shadows'].loc).catch(() => {})
  }
  if (touch) {
    const small = await smallTargets(P.page)
    const hs = await horizontalScroll(P.page)
    ev.check('phone: every target in the Scene sheet is at least 44 × 44 px, no sideways scroll', !small.length && hs.scrollWidth <= 390, fmt({ small: small.slice(0, 6), scroll: hs }))
  }
  ev.check(`${device}: no page errors or console errors`, !P.errors.page.length && !P.errors.console.length, fmt([...P.errors.page, ...P.errors.console].slice(0, 4)))
}
await uiChecks('desktop')
await uiChecks('phone')
await ev.finish()
