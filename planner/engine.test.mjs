#!/usr/bin/env node
// Differential test of the planner's pure logic (planner/logic/*.ts, the engine track's functional core) against v1's
// JavaScript: each v1 function below is copied verbatim from planner/{engine,lighting,input,data}.js at 979677c (v2 at
// the start of Phase 2; the lines are cited), with the module state it read passed in as arguments. Random inputs from a
// seeded generator, including the junk the hook can be given (strings, null, NaN, arrays, objects). The logic must give
// exactly what v1 gave (numbers bit for bit, Object.is). v1's round, the wraps, the camera, Look and elevation clamps,
// the rotate step, the depth scale and the warmth tint are the kernels' (core/js/web.ts): the logic takes them as
// parameters (K below), the engine calls them, and the groups check them against v1 too.
//
// Usage (repo root): nix develop -c node planner/engine.test.mjs        (SEED=<n> N=<cases>; needs `npm run build`)
// Exit 0 when every group passes; one line per group.
import fs from 'node:fs'
import path from 'node:path'
import { build } from 'esbuild'

const ROOT = path.resolve(import.meta.dirname, '..')
const SEED = Number(process.env.SEED ?? 20261106) >>> 0
const N = Number(process.env.N ?? 4000)

// --- the logic modules and the kernels' face, bundled (their .js specifiers name .ts files) --------------------------
const LOGIC = ['num', 'camera', 'look', 'view', 'layout', 'text', 'money', 'messages', 'input', 'library', 'scenes', 'keymap', 'selection']
const entry = [
  ...LOGIC.map((m) => `export * as ${m} from './planner/logic/${m}.ts'`),
  "export * as k from './core/js/web.ts'",
].join('\n')
const bundled = await build({ stdin: { contents: entry, resolveDir: ROOT, loader: 'js' }, bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent', external: [] })
// the kernels' glue loads its .wasm next to itself: put the bundle where import.meta.url finds build/wasm/web
const bundlePath = path.join(ROOT, 'build/wasm/web/.engine-test-bundle.mjs')
fs.writeFileSync(bundlePath, bundled.outputFiles[0].text)
const L = await import(bundlePath)
fs.rmSync(bundlePath, { force: true })
L.k.loadKernelsSync(fs.readFileSync(path.join(ROOT, 'build/wasm/web/midstudy_wasm_web_bg.wasm')))
/** What the engine passes the logic (engine.ts K). */
const K = { roundTo: L.k.roundTo, wrapDeg: L.k.wrapDeg, wrapAz: L.k.wrapAz, clampLook: L.k.clampLook }
/** engine.ts clampCamera: JSON to the kernels' clamp (a field that isn't a number is NaN, so it takes base's). */
function clampJson(c, base) {
  const o = c && typeof c === 'object' ? c : null
  const field = (k) => { const v = o?.[k]; return typeof v === 'number' ? v : Number.NaN }
  return L.k.clampCamera({ fov_y_deg: field('fov_y_deg'), height_m: field('height_m'), pitch_deg: field('pitch_deg'), roll_deg: field('roll_deg') }, base)
}

// --- random inputs -----------------------------------------------------------------------------------------------------
let s = SEED || 1
const rnd = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 }
const uni = (a, b) => a + (b - a) * rnd()
const int = (a, b) => Math.floor(uni(a, b + 1))
const pick = (xs) => xs[int(0, xs.length - 1)]
const junk = () => pick([undefined, null, NaN, Infinity, -Infinity, 0, -0, '', '1.5', 'abc', true, false, [], [1, 2], {}, { x: 1 }])
const number = (lo, hi) => (rnd() < 0.1 ? junk() : rnd() < 0.1 ? pick([lo, hi, lo - 1e-9, hi + 1e-9, (lo + hi) / 2, 0]) : uni(lo - (hi - lo) * 0.3, hi + (hi - lo) * 0.3))
const finite = (lo, hi) => (rnd() < 0.1 ? pick([lo, hi, 0, -0, 180, -180, 360, -360, 540]) : uni(lo, hi))
const maybeObj = (f) => (rnd() < 0.08 ? junk() : f())

// --- bookkeeping ------------------------------------------------------------------------------------------------------
const groups = new Map()
const same = (a, b) => {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b)
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => same(v, b[i]))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a), kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k, i) => k === kb[i] && same(a[k], b[k]))
  }
  return a === b
}
function check(name, got, want, ctx) {
  const g = groups.get(name) ?? { cases: 0, fails: [] }
  groups.set(name, g)
  g.cases++
  if (!same(got, want) && g.fails.length < 3) g.fails.push(`${JSON.stringify(ctx)}: got ${JSON.stringify(got)}, v1 ${JSON.stringify(want)}`)
}
const run = (name, fn) => { for (let i = 0; i < N; i++) fn(i) ; groups.get(name) ?? groups.set(name, { cases: 0, fails: [] }) }

// --- v1 (planner/engine.js at 979677c, verbatim) -----------------------------------------------------------------------
// engine.js:83–98
const round = (v, n = 4) => Math.round(v * 10 ** n) / 10 ** n
const isNum = (v) => typeof v === 'number' && Number.isFinite(v)
const wrapDeg = (d) => { let x = ((d + 180) % 360 + 360) % 360 - 180; if (x === -180) x = 180; return x }
const MAX_ELEVATION = 4 // m (§2.10)
const clampElev = (y) => Math.min(MAX_ELEVATION, Math.max(0, y))
const clampNum = (v, lo, hi, dflt) => (isNum(v) ? Math.min(hi, Math.max(lo, v)) : dflt)
// engine.js:101–123
const CAMERA_RANGE = { fov_y_deg: [20, 110], height_m: [0.2, 3.0], pitch_deg: [-80, 30], roll_deg: [-20, 20] }
const DEFAULT_CAMERA = { fov_y_deg: 55, height_m: 1.4, pitch_deg: -10, roll_deg: 0 }
function clampCamera(c, base = DEFAULT_CAMERA) {
  const out = {}
  for (const [k, [lo, hi]] of Object.entries(CAMERA_RANGE)) out[k] = round(clampNum(c?.[k], lo, hi, base[k]), 6)
  return out
}
const sameCamera = (a, b) => !!a && !!b && Object.keys(CAMERA_RANGE).every((k) => Math.abs(a[k] - b[k]) < 1e-6)
const LOOK_NUM = { exposure: [0.25, 4, 1], warmth: [-1, 1, 0], light_azimuth_deg: [-180, 180, null], light_elevation_deg: [5, 90, null], light_softness: [0, 1, null], light_strength: [0, 3, 1], ambient: [0, 3, 1] }
const LOOK_BOOL = { contact_shadows: true, auto_light: true, cast_shadows: null }
const LOOK_KEYS = [...Object.keys(LOOK_NUM), ...Object.keys(LOOK_BOOL)]
const wrapAz = (a) => { const w = ((((a + 180) % 360) + 360) % 360) - 180; return w === -180 && a > 0 ? 180 : w }
function lookFrom(l) {
  const src = l && typeof l === 'object' ? l : {}
  const out = {}
  for (const [k, [lo, hi, d]] of Object.entries(LOOK_NUM)) out[k] = isNum(src[k]) ? Math.min(hi, Math.max(lo, k === 'light_azimuth_deg' ? wrapAz(src[k]) : src[k])) : d
  for (const [k, d] of Object.entries(LOOK_BOOL)) out[k] = typeof src[k] === 'boolean' ? src[k] : d
  return out
}
// engine.js:1727–1736 (setCamera's merge), with cam passed in
function setCameraV1(cam, partial) {
  if (!partial || typeof partial !== 'object') return cam
  const next = clampCamera({ ...cam, ...Object.fromEntries(Object.entries(partial).filter(([k, v]) => k in CAMERA_RANGE && isNum(v))) }, cam)
  if (sameCamera(next, cam)) return cam
  return next
}
// engine.js:1907–1910
function warmthTint(w) {
  const t = [1 + 0.14 * w, 1 + 0.015 * w, 1 - 0.14 * w]
  const k = 1 / (0.2126 * t[0] + 0.7152 * t[1] + 0.0722 * t[2]) // THREE.Vector3.multiplyScalar(1 / that)
  return [t[0] * k, t[1] * k, t[2] * k]
}
// engine.js:1915–1930 (resolvedLook), with lights.inferred(), azElOf, dirOf and lightingData passed in
function resolvedLookV1(look, inf, azElOf, dirOf, V1_KEY_DIR, V1_SOFTNESS, lightingData) {
  const autoDir = inf ? inf.direction : [...V1_KEY_DIR]
  const autoSoft = inf ? inf.softness : V1_SOFTNESS
  const manual = !look.auto_light
  const ae = azElOf(autoDir)
  const az = manual && look.light_azimuth_deg != null ? look.light_azimuth_deg : ae.azimuth_deg
  const el = manual && look.light_elevation_deg != null ? look.light_elevation_deg : ae.elevation_deg
  return {
    light_azimuth_deg: az, light_elevation_deg: el,
    dir: manual && (look.light_azimuth_deg != null || look.light_elevation_deg != null) ? dirOf(az, el) : autoDir,
    light_softness: manual && look.light_softness != null ? look.light_softness : autoSoft,
    light_strength: look.light_strength, ambient: look.ambient,
    cast_shadows: look.cast_shadows ?? !!lightingData,
  }
}
// engine.js:1957–1962, 1985–1996, 1999–2003, 2009–2013 (freezeAuto, setLighting, resetLighting, lookToSave), on a copy
function setLightingV1(look0, p, resolved) {
  const look = { ...look0 }
  if (!p || typeof p !== 'object') return { look, error: true }
  const before = JSON.stringify(look)
  const manualKeys = ['light_azimuth_deg', 'light_elevation_deg', 'light_softness']
  const goesManual = (manualKeys.some((k) => isNum(p[k])) && typeof p.auto_light !== 'boolean') || p.auto_light === false
  if (goesManual && look.auto_light) { // freezeAuto()
    const r = resolved
    look.light_azimuth_deg = round(wrapAz(r.light_azimuth_deg), 3)
    look.light_elevation_deg = round(Math.min(90, Math.max(5, r.light_elevation_deg)), 3)
    look.light_softness = round(r.light_softness, 4)
  }
  if (goesManual) look.auto_light = false
  for (const [k, [lo, hi]] of Object.entries(LOOK_NUM)) if (isNum(p[k])) look[k] = Math.min(hi, Math.max(lo, k === 'light_azimuth_deg' ? wrapAz(p[k]) : p[k]))
  for (const k of Object.keys(LOOK_BOOL)) if (typeof p[k] === 'boolean' && !(k === 'auto_light' && p[k] === false)) look[k] = p[k]
  return { look, changed: JSON.stringify(look) !== before }
}
function resetLightingV1(look0) {
  const look = { ...look0 }
  Object.assign(look, { auto_light: true, light_strength: 1, ambient: 1, exposure: 1, warmth: 0, cast_shadows: null, contact_shadows: true, light_azimuth_deg: null, light_elevation_deg: null, light_softness: null })
  return look
}
function lookToSaveV1(look) {
  const out = Object.fromEntries(LOOK_KEYS.map((k) => [k, look[k]]))
  if (look.auto_light) out.light_azimuth_deg = out.light_elevation_deg = out.light_softness = null
  return out
}
// engine.js:351–362, 363–369, 400, 402, 415–425, 430–436, 437–444, 445–454 (the view), state passed in
function viewV1(canvas, ins, photo, view0) {
  const view = { ...view0 }
  const stageRect = () => {
    const r = canvas
    const x = ins.left, y = ins.top
    return { x: r.left + x, y: r.top + y, w: Math.max(40, r.width - x - ins.right), h: Math.max(40, r.height - y - ins.bottom) }
  }
  const fitScale = (st = stageRect()) => Math.min(st.w / photo.w, st.h / photo.h)
  const viewParams = () => {
    const st = stageRect()
    const s = fitScale(st) * view.zoom
    return { s, ox: st.x + st.w / 2 - s * view.cx, oy: st.y + st.h / 2 - s * view.cy, st }
  }
  const clampCenter = () => {
    const st = stageRect()
    const s = fitScale(st) * view.zoom
    const lim = (c, len, stageLen) => (s * len <= stageLen + 0.5 ? len / 2 : Math.min(len - stageLen / (2 * s), Math.max(stageLen / (2 * s), c)))
    view.cx = lim(view.cx, photo.w, st.w)
    view.cy = lim(view.cy, photo.h, st.h)
  }
  const clientToPhoto = (x, y) => { const { s, ox, oy } = viewParams(); return [(x - ox) / s, (y - oy) / s] }
  const photoToClient = (px, py) => { const { s, ox, oy } = viewParams(); return [ox + s * px, oy + s * py] }
  const getPhotoRect = () => { const { s, ox, oy } = viewParams(); return { x: ox, y: oy, w: s * photo.w, h: s * photo.h } }
  const visiblePhotoRect = () => {
    const p = getPhotoRect(), st = stageRect()
    const x0 = Math.max(p.x, st.x), y0 = Math.max(p.y, st.y), x1 = Math.min(p.x + p.w, st.x + st.w), y1 = Math.min(p.y + p.h, st.y + st.h)
    return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) }
  }
  const getView = () => ({ zoom: round(view.zoom, 4), cx: round(view.cx, 2), cy: round(view.cy, 2), fit: view.zoom <= 1.0001 })
  const zoomAt = (clientX, clientY, zoom) => {
    const z = Math.min(4, Math.max(1, zoom))
    const before = clientToPhoto(clientX, clientY)
    view.zoom = z
    const { s, st } = viewParams()
    view.cx = (st.x + st.w / 2 - (clientX - s * before[0])) / s
    view.cy = (st.y + st.h / 2 - (clientY - s * before[1])) / s
    clampCenter()
  }
  const panBy = (dx, dy) => { const { s } = viewParams(); view.cx -= dx / s; view.cy -= dy / s; clampCenter() }
  return { view, stageRect, viewParams, clampCenter, clientToPhoto, photoToClient, getPhotoRect, visiblePhotoRect, getView, zoomAt, panBy }
}
// engine.js:1340 (layoutSig), items as {id, x, y, z, rotationDeg}
const layoutSigV1 = (items) => JSON.stringify(items.map((r) => [r.id, ...[r.x, r.y, r.z].map((v) => Math.round(v * 1e4)), Math.round(wrapDeg(r.rotationDeg) * 100)]).sort())
// engine.js:1772
const prettyLayout = (name) => { const s = String(name || '').replace(/-/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) }
const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/
// engine.js:1790–1809 (recalledLayout from the stored text, layoutToOpen)
function recalledLayoutV1(raw) {
  if (!raw) return null
  if (SLUG.test(raw)) return { name: raw, at: 0 }
  try {
    const v = JSON.parse(raw)
    if (v && typeof v === 'object') return { name: typeof v.name === 'string' && SLUG.test(v.name) ? v.name : null, at: Date.parse(v.at) || 0 }
  } catch { /* unreadable */ }
  return null
}
function layoutToOpenV1(raw, details) {
  const saved = (d) => Date.parse(d?.updated || '') || 0
  const newest = details.reduce((a, d) => (!a || saved(d) > saved(a) ? d : a), null)
  const mine = recalledLayoutV1(raw)
  if (mine && (!newest || mine.at >= saved(newest))) {
    if (!mine.name) return null
    if (details.some((d) => d.name === mine.name)) return mine.name
  }
  return newest ? newest.name : null
}
// engine.js:1489–1495
function floorNoteForV1(data) {
  const c = data?.calib
  if (!c) return data?.calib_status === 'failed' ? `Calibration failed${data.calib_error ? ` (${data.calib_error})` : ''}: set the floor by hand.` : 'No calibration yet: set the floor by hand.'
  if (c.floor && c.floor.found === false) return "Check the floor: the photo's floor wasn't found."
  if (c.source !== 'moge-2' && c.source !== 'truth') return `Check the floor: the camera is a guess (${c.source === 'exif' ? 'from the lens' : 'a default'}).`
  return null
}
// engine.js:394–398 (depthScale), calib and the height passed in
function depthScaleV1(calib, height) {
  const c = calib
  const h0 = c?.floor?.found && (c.source === 'moge-2' || c.source === 'truth') ? Number(c.camera?.height_m) : NaN
  return h0 > 0 ? height / h0 : 1
}
// engine.js:86–87, 2207–2213
const fmtCm = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(1))
const dimsText = (d) => (d ? `${fmtCm(d.w)} × ${fmtCm(d.d)} × ${fmtCm(d.h)} cm` : '')
const RENDER_MODELS = {
  'nano-banana': { label: 'Nano Banana edit', price: () => 0.0398 },
  kontext: { label: 'FLUX.1 Kontext [pro]', price: () => 0.04 },
  qwen: { label: 'Qwen Image Edit', price: (mp) => 0.03 * mp },
  'gpt-image': { label: 'GPT Image 2 edit', price: () => 0.07 },
}
const fmtUsd = (v) => `$${Math.abs(v * 100 - Math.round(v * 100)) < 1e-6 ? v.toFixed(2) : v.toFixed(4)}`
function renderPrice(model, shot) { return RENDER_MODELS[model].price(shot ? (shot.width * shot.height) / 1e6 : 1) }
// data.js:33, 125–132
const fmtBytes = (n) => (!(n > 0) ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`)
const LIB_PRICE = { glb: 0, rug: 0, idol: 0.1, sam3d: 0.02, trellis2: { 512: 0.25, 1024: 0.3, 1536: 0.35 } }
function estimateCostV1(meta = {}, kind = 'image') {
  if (kind === 'model') return 0
  const p = LIB_PRICE[meta.engine || 'idol']
  return typeof p === 'object' ? (p[Number(meta.resolution) || 512] ?? p[512]) : p ?? 0
}
// lighting.js:28–29, 402–417 (catcher), 428–446 (fitShadow numbers)
const lum = (c) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))
function keepV1(a, s, ly) { return clamp((0.45 * a) / (0.45 * a + 0.55 * s * ly + 1e-6), 0.08, 1) }
function keepPhotoV1(amb, even, color, intensity, a, s, ly) {
  return [0, 1, 2].map((c) => { const T = Math.max(1e-4, amb[c] * a + color[c] * intensity * s * ly); return clamp(Math.min(even[c] * a, amb[c] * a) / T, 0.08, 1) })
}
function shadowFitV1(radius, maxY, dy, tan) {
  const r = Math.max(0.2, radius)
  const reach = (maxY + 0.05) / Math.max(0.08, dy)
  const back = r + 1
  const half = r + 0.15 + tan * Math.min(reach, 8)
  const near = 0.01, far = back + r + reach + 0.5
  const range = far - near
  return { reach, back, half, near, far, range, width: 2 * half, search: Math.min(0.25, (tan * (reach + 0.2)) / (2 * half) + 1.5 / 2048), bias: 0.004 / range }
}
// input.js:16 (tap slop)
const TAP_PX = { mouse: 4, pen: 6, touch: 10 }
// main a292ee2 keymap.js (parse, comboOf, format), with IS_MAC as a parameter
const MOD_ORDER = ['mod', 'ctrl', 'alt', 'shift']
const CODE_KEY = { Slash: '/', Backslash: '\\', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Minus: '-', Equal: '=', Backquote: '`', NumpadAdd: '+', NumpadSubtract: '-', NumpadMultiply: '*', NumpadDivide: '/', NumpadDecimal: '.', NumpadEnter: 'enter' }
const ALIAS = { esc: 'escape', del: 'delete', space: ' ', cmd: 'mod', meta: 'mod', option: 'alt', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', pgup: 'pageup', pgdn: 'pagedown', plus: '=' }
const MAC_MOD = { mod: '⌘', ctrl: '⌃', alt: '⌥', shift: '⇧' }
const PC_MOD = { mod: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift' }
const KEY_TEXT = { escape: 'Esc', enter: '↵', delete: 'Del', backspace: '⌫', ' ': 'Space', tab: 'Tab', home: 'Home', end: 'End', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', pageup: 'PgUp', pagedown: 'PgDn', click: 'Click', drag: 'Drag', scroll: 'Scroll', pinch: 'Pinch', arrows: '← ↑ → ↓' }
function parseV1(combo) {
  const parts = String(combo).toLowerCase().split('+')
  if (parts.at(-1) === '' && parts.length > 1) { parts.pop(); parts[parts.length - 1] = '+' }
  const key = ALIAS[parts.at(-1)] ?? parts.at(-1)
  const mods = new Set(parts.slice(0, -1).map((m) => ALIAS[m] || m))
  return { mods, key, id: [...MOD_ORDER.filter((m) => mods.has(m)), key].join('+') }
}
function comboOfV1(e, IS_MAC) {
  let key
  if (CODE_KEY[e.code]) key = CODE_KEY[e.code]
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5)
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6)
  else if (/^Key[A-Z]$/.test(e.code) && !/^[a-z]$/i.test(e.key)) key = e.code.slice(3).toLowerCase()
  else key = (e.key === 'Spacebar' ? ' ' : e.key || '').toLowerCase()
  const mods = []
  if (IS_MAC ? e.metaKey : e.ctrlKey) mods.push('mod')
  if (IS_MAC && e.ctrlKey) mods.push('ctrl')
  if (e.altKey) mods.push('alt')
  if (e.shiftKey) mods.push('shift')
  return [...mods, key].join('+')
}
function formatV1(combo, IS_MAC) {
  const { mods, key } = parseV1(combo)
  let k = key
  const shown = new Set(mods)
  if (shown.has('shift') && (k === '/' || k === '=')) { shown.delete('shift'); k = k === '/' ? '?' : '+' }
  const text = KEY_TEXT[k] || (k.length === 1 ? k.toUpperCase() : k[0].toUpperCase() + k.slice(1))
  const ms = MOD_ORDER.filter((m) => shown.has(m)).map((m) => (IS_MAC ? MAC_MOD : PC_MOD)[m])
  return IS_MAC ? ms.join('') + text : [...ms, text].join('+')
}
// main a292ee2 engine.js select(uid, { toggle, add }) on a Set, and turnAbout
function selectV1(uids, uid, known, how) {
  const selection = new Set(uids)
  let selected = uids.at(-1) ?? null
  const ok = !!uid && known
  if (how !== 'set') {
    if (!ok) return { uids: [...selection], primary: selected }
    if (how === 'toggle' && selection.has(uid)) { selection.delete(uid); if (selected === uid) selected = [...selection].at(-1) ?? null }
    else { selection.delete(uid); selection.add(uid); selected = uid }
  } else { selection.clear(); if (ok) selection.add(uid); selected = ok ? uid : null }
  return { uids: [...selection], primary: selected }
}
function turnAboutV1(c, x, z, deg) {
  const t = deg * Math.PI / 180, cs = Math.cos(t), sn = Math.sin(t), dx = x - c.x, dz = z - c.z
  return [c.x + dx * cs + dz * sn, c.z - dx * sn + dz * cs]
}

// --- the comparisons ---------------------------------------------------------------------------------------------------
const cameraIn = () => maybeObj(() => {
  const o = {}
  for (const [k, [lo, hi]] of Object.entries(CAMERA_RANGE)) if (rnd() < 0.9) o[k] = number(lo, hi)
  if (rnd() < 0.05) o.toString = 5
  return o
})
const camera = () => clampCamera({ fov_y_deg: uni(20, 110), height_m: uni(0.2, 3), pitch_deg: uni(-80, 30), roll_deg: uni(-20, 20) })
const rec = (x) => (x && typeof x === 'object' ? x : null) // what the shell passes the logic

run('kernels: roundTo, wrapDeg, wrapAz, clampElevation, setElevation; isNum', () => {
  const v = finite(-1e4, 1e4), n = int(0, 8)
  const name = 'kernels: roundTo, wrapDeg, wrapAz, clampElevation, setElevation; isNum'
  check(name, [L.k.roundTo(v, n), L.k.roundTo(v, 4), L.k.wrapDeg(v), L.k.wrapAz(v), L.k.clampElevation(v / 1000), L.k.roundTo(L.k.clampElevation(v / 1e3), 6)],
    [round(v, n), round(v), wrapDeg(v), wrapAz(v), clampElev(v / 1000), round(clampElev(v / 1e3), 6)], v)
  const j = rnd() < 0.5 ? junk() : number(-2, 2)
  check(name, L.num.isNum(j), isNum(j), String(j))
})
// rotateBy (kernels) and nudged (logic) against v1's exact expressions (rotateSelected, nudgeElevation)
run('rotateSelected and nudgeElevation steps', () => {
  const v = finite(-720, 720), d = pick([15, -15]), y = uni(-1, 5), dy = pick([0.01, -0.01, 0.1, -0.1])
  check('rotateSelected and nudgeElevation steps', [L.k.rotateBy(v, d), L.num.nudged(y, dy)], [round(wrapDeg(v + d), 6), Math.round((y + dy) * 1000) / 1000], { v, d, y, dy })
})
run('camera: clampCamera (kernels, on JSON), setCamera merge, sameCamera, sceneSig', () => {
  const name = 'camera: clampCamera (kernels, on JSON), setCamera merge, sameCamera, sceneSig'
  const c = cameraIn(), base = camera()
  check(name, clampJson(c, base), clampCamera(c, base), c)
  const cam = camera(), p = cameraIn()
  const merged = rec(p) ? clampJson(p, cam) : cam
  const next = L.camera.sameCamera(merged, cam) ? cam : merged
  check(name, next, setCameraV1(cam, p), { cam, p })
  const a = camera(), b = rnd() < 0.5 ? a : { ...a, height_m: a.height_m + pick([1e-7, 2e-6, 0]) }
  check(name, [L.camera.sameCamera(a, b), L.camera.sceneSig(a) === L.camera.sceneSig(b)], [sameCamera(a, b), JSON.stringify([a]) === JSON.stringify([b])], { a, b })
})
run('camera: floor note and depth scale', () => {
  const calib = pick([null, undefined, 0, {}, { floor: { found: false }, source: 'moge-2' }, { floor: { found: true }, source: pick(['moge-2', 'truth', 'exif', 'default', undefined]), camera: { height_m: pick([1.4, 0, -1, '1.2', null]) } }, { source: 'exif' }])
  const data = maybeObj(() => ({ calib, calib_status: pick(['failed', 'done', 'pending', undefined]), calib_error: pick([null, '', 'MoGe crashed', 5]) }))
  const d = rec(data)
  const c = d?.calib
  const floor = rec(rec(c)?.floor)
  const err = d?.calib_error
  check('camera: floor note and depth scale', L.camera.floorNote({ has: !!c, floorNotFound: floor !== null && floor.found === false, source: rec(c)?.source, status: d?.calib_status, error: err ? String(err) : '' }), floorNoteForV1(data), data)
  const h = uni(0.2, 3)
  const cr = rec(calib)
  const measured = !!rec(cr?.floor)?.found && (cr?.source === 'moge-2' || cr?.source === 'truth')
  check('camera: floor note and depth scale', L.k.depthScale(h, Number(rec(cr?.camera)?.height_m), measured), depthScaleV1(calib, h), { calib, h })
})
const lookIn = () => maybeObj(() => {
  const o = {}
  for (const [k, [lo, hi]] of Object.entries(LOOK_NUM)) if (rnd() < 0.7) o[k] = number(lo, hi)
  for (const k of Object.keys(LOOK_BOOL)) if (rnd() < 0.5) o[k] = rnd() < 0.85 ? rnd() < 0.5 : junk()
  return o
})
run('look: lookFrom, setLighting (freeze, merge, changed), resetLighting, lookToSave, warmthTint', () => {
  const l = lookIn()
  const look = lookFrom(l)
  check('look: lookFrom, setLighting (freeze, merge, changed), resetLighting, lookToSave, warmthTint', L.look.lookFrom(rec(l), K), look, l)
  const p = lookIn()
  const resolved = { light_azimuth_deg: finite(-400, 400), light_elevation_deg: finite(-10, 100), light_softness: uni(0, 1) }
  const v1 = setLightingV1(look, p, resolved)
  if (!v1.error) {
    const pr = rec(p)
    const next = L.look.patchLook(L.look.lookFrom(rec(l), K), pr, L.look.needsFreeze(look, pr) ? resolved : null, K)
    check('look: lookFrom, setLighting (freeze, merge, changed), resetLighting, lookToSave, warmthTint', [next, L.look.lookChanged(look, next)], [v1.look, v1.changed], { look, p })
  }
  check('look: lookFrom, setLighting (freeze, merge, changed), resetLighting, lookToSave, warmthTint', [L.look.defaultLook(), L.look.lookToSave(look)], [resetLightingV1(look), lookToSaveV1(look)], look)
  const w = number(-1, 1)
  // the furniture's tint: the kernels' warmth tint, as engine.ts applyLook reads it (splatMultiplier × 1 × [1, 1, 1])
  if (isNum(w)) check('look: lookFrom, setLighting (freeze, merge, changed), resetLighting, lookToSave, warmthTint', L.k.splatMultiplier(w, 1, [1, 1, 1]), warmthTint(w), w)
})
run('look: resolvedLook (with the kernels\' azElOf and dirOf)', () => {
  const look = lookFrom(lookIn())
  const dir = (() => { const v = [uni(-1, 1), uni(0.05, 1), uni(-1, 1)]; const n = Math.hypot(...v); return v.map((x) => x / n) })()
  const inf = rnd() < 0.5 ? { direction: dir, softness: uni(0, 1) } : null
  const V1_KEY_DIR = [-1.5 / Math.hypot(-1.5, 4, 2.5), 4 / Math.hypot(-1.5, 4, 2.5), 2.5 / Math.hypot(-1.5, 4, 2.5)]
  const lightingData = rnd() < 0.5 ? {} : null
  const autoDir = inf ? inf.direction : V1_KEY_DIR
  const ae = L.k.azElOf(autoDir)
  const got = L.look.resolveLook(look, { dir: autoDir, softness: inf ? inf.softness : 0.5, azimuth_deg: ae.azimuth_deg, elevation_deg: ae.elevation_deg }, !!lightingData, L.k.dirOf)
  check('look: resolvedLook (with the kernels\' azElOf and dirOf)', got, resolvedLookV1(look, inf, L.k.azElOf, L.k.dirOf, V1_KEY_DIR, 0.5, lightingData), { look, inf })
})
run('look: the catcher\'s keep, penumbra and shadow camera', () => {
  const a = uni(0, 3), st = uni(0, 3), ly = uni(-0.2, 1)
  const amb = [uni(0, 3), uni(0, 3), uni(0, 3)], even = [uni(0, 3), uni(0, 3), uni(0, 3)], col = [uni(0, 1), uni(0, 1), 1], inten = uni(0, 5)
  const soft = uni(0, 1), tan = 0.006 + 0.6 * soft * soft
  const r = uni(0, 3), maxY = uni(0, 3), dy = uni(-0.2, 1)
  check('look: the catcher\'s keep, penumbra and shadow camera', [L.look.keepV1(a, st, Math.max(0, ly)), L.look.keepPhoto(amb, even, col, inten, a, st, Math.max(0, ly)), L.look.penumbraTan(soft), L.look.shadowFit(r, maxY, dy, tan)],
    [keepV1(a, st, Math.max(0, ly)), keepPhotoV1(amb, even, col, inten, a, st, Math.max(0, ly)), tan, shadowFitV1(r, maxY, dy, tan)], { a, st, ly })
})
run('view: stage, fit, clamp, zoom, pan, client ↔ photo, visible rect, getView', () => {
  const canvas = { left: uni(-50, 50), top: uni(-50, 50), width: pick([0, 1, 390, 1280, uni(10, 3000)]), height: pick([0, 1, 844, 800, uni(10, 2000)]) }
  const insIn = { left: number(0, 400), right: number(0, 400), top: number(0, 200), bottom: number(0, 300) }
  const px = (v) => (isNum(v) && v > 0 ? v : 0)
  const ins = { left: px(insIn.left), right: px(insIn.right), top: px(insIn.top), bottom: px(insIn.bottom) }
  const photo = { w: pick([1600, 1200, 4032, int(10, 5000)]), h: pick([1200, 1600, 3024, int(10, 5000)]) }
  const view0 = { zoom: uni(1, 4), cx: uni(-100, photo.w + 100), cy: uni(-100, photo.h + 100) }
  const v1 = viewV1(canvas, ins, photo, view0)
  const box = { x: canvas.left, y: canvas.top, w: canvas.width, h: canvas.height }
  const name = 'view: stage, fit, clamp, zoom, pan, client ↔ photo, visible rect, getView'
  check(name, L.view.insetsFrom(insIn.left, insIn.right, insIn.top, insIn.bottom), ins, insIn)
  const st = L.view.stageOf(box, ins)
  check(name, st, v1.stageRect(), { canvas, ins })
  let view = L.view.clampedView(st, photo, view0)
  v1.clampCenter()
  check(name, view, v1.view, { view0, photo })
  const t = L.view.xformOf(st, photo, view)
  const x = uni(-100, 3000), y = uni(-100, 2000)
  check(name, [L.view.clientToPhoto(t, x, y), L.view.photoToClient(t, x, y), L.view.photoRect(t, photo), L.view.visibleRect(L.view.photoRect(t, photo), st), L.view.viewReport(view, K)],
    [v1.clientToPhoto(x, y), v1.photoToClient(x, y), v1.getPhotoRect(), v1.visiblePhotoRect(), v1.getView()], { x, y })
  const z = rnd() < 0.1 ? junk() : uni(0.5, 6)
  const before = L.view.clientToPhoto(t, x, y)
  view = L.view.clampedView(st, photo, L.view.zoomedView(st, photo, view, x, y, z, before))
  v1.zoomAt(x, y, z)
  check(name, view, v1.view, { zoom: z, x, y })
  const dx = uni(-300, 300), dy = uni(-300, 300)
  view = L.view.clampedView(st, photo, L.view.pannedView(view, L.view.xformOf(st, photo, view).s, dx, dy))
  v1.panBy(dx, dy)
  check(name, view, v1.view, { dx, dy })
})
const ids = ['sofa', 'chair', 'a,1', 'a', 'lamp-2']
run('layout: dirty state (layoutSig equality), prettyLayout, layoutToOpen', () => {
  const pieces = Array.from({ length: int(0, 4) }, () => ({ id: pick(ids), x: pick([0, 1, -1, uni(-3, 3)]), y: pick([0, uni(0, 2)]), z: pick([-2, uni(-6, 0)]), rotationDeg: pick([0, 90, -270, 450, uni(-720, 720)]) }))
  const other = rnd() < 0.4 ? [...pieces].reverse() : rnd() < 0.5 ? pieces.map((p) => ({ ...p, x: p.x + pick([0, 1e-5, 4e-5, 1e-3]) })) : Array.from({ length: int(0, 4) }, () => ({ id: pick(ids), x: pick([0, 1]), y: 0, z: -2, rotationDeg: pick([0, 360, 90]) }))
  const sig = (ps) => L.layout.layoutSig(ps.map((p) => ({ id: p.id, x: p.x, y: p.y, z: p.z, rotation_y_deg: p.rotationDeg })), K)
  const name = 'layout: dirty state (layoutSig equality), prettyLayout, layoutToOpen'
  check(name, [sig(pieces) === sig(other), sig([]) === L.layout.EMPTY_SIG], [layoutSigV1(pieces) === layoutSigV1(other), layoutSigV1([]) === '[]'], { pieces, other })
  const n = pick(['two-chairs', '', 'a', '-x-', 'Phone A', 'z'])
  check(name, L.layout.prettyLayout(n), prettyLayout(n), n)
  const when = () => pick([undefined, null, '', 'garbage', '2026-11-05T10:00:00Z', '2026-11-05T11:00:00Z', '2026-11-06T10:00:00Z', 5])
  const details = Array.from({ length: int(0, 4) }, () => ({ name: pick(['a', 'b', 'c', 'reading-corner']), updated: when() }))
  const raw = pick([null, '', 'a', 'b', 'Bad Name', '{', JSON.stringify({ name: pick(['a', 'b', null, 'X', 7]), at: when() }), JSON.stringify([1]), 'null'])
  const parsed = (() => {
    if (!raw) return null
    const plain = L.layout.recalledFromSlug(raw)
    if (plain) return plain
    try { const v = JSON.parse(raw); if (v && typeof v === 'object') return L.layout.recalledFromObject(v, Date.parse(String(v.at))) } catch { /* as v1 */ }
    return null
  })()
  const det = details.map((d) => { const u = d.updated; const ms = Date.parse(u ? String(u) : ''); return { name: d.name, title: null, updatedMs: Number.isNaN(ms) ? 0 : ms } })
  check(name, L.layout.layoutToOpen(parsed, det), layoutToOpenV1(raw, details), { raw, details })
})
run('text and money: dimsText, fmtUsd, fmtBytes, renderPrice, estimateCost', () => {
  const d = rnd() < 0.1 ? null : { w: pick([50, 50.25, 0.1, 120, uni(1, 400)]), d: pick([40, 33.333]), h: pick([1, 99.95, uni(1, 300)]) }
  const v = pick([0, 0.0398, 0.04, 0.1, 0.25, 1.5, uni(0, 5), 0.03 * uni(0, 4)])
  const n = pick([0, -1, 1, 999, 1000, 1499, 1500, 1e6 - 1, 1e6, 2.5e6, 1e9, 3.3e9, NaN, uni(0, 5e9)])
  const model = pick(['nano-banana', 'kontext', 'qwen', 'gpt-image'])
  const shot = rnd() < 0.3 ? null : { width: int(1, 4000), height: int(1, 3000) }
  const name = 'text and money: dimsText, fmtUsd, fmtBytes, renderPrice, estimateCost'
  const price = L.money.renderModelPrice(model, shot ? L.money.megapixels(shot.width, shot.height) : 1)
  check(name, [L.text.dimsText(d), L.text.fmtUsd(v), L.text.fmtBytes(n), price, L.money.renderLabel(model)], [dimsText(d), fmtUsd(v), fmtBytes(n), renderPrice(model, shot), RENDER_MODELS[model].label], { d, v, n, model, shot })
  const meta = { engine: pick([undefined, '', 'idol', 'sam3d', 'trellis2', 'rug', 'glb', 'unknown']), resolution: pick([undefined, 512, 1024, 1536, '1024', 999, 'x']) }
  const kind = pick(['image', 'model'])
  check(name, L.money.estimateCost(meta.engine ? String(meta.engine) : '', Number(meta.resolution), kind), estimateCostV1(meta, kind), { meta, kind })
})
run('input: tap slop, grab pad', () => {
  const type = pick(['mouse', 'pen', 'touch', '', 'unknown'])
  check('input: tap slop, grab pad', [L.input.tapSlop(type), L.input.grabPad(type)], [TAP_PX[type] ?? 6, type === 'mouse' ? 6 : 16], { type })
})
run('keymap: combos, keydowns, how they read (main a292ee2)', () => {
  const isMac = rnd() < 0.5
  const mods = ['', 'mod+', 'shift+', 'mod+shift+', 'alt+', 'ctrl+', 'cmd+', 'meta+option+'].map((m) => pick([m, m.toUpperCase()]))
  const combo = pick(mods) + pick(['a', 'z', '/', '=', '-', 'escape', 'esc', 'del', 'space', 'up', 'pgdn', 'plus', 'arrowleft', 'pageup', 'enter', '0', 'click', 'drag', 'arrows', 'scroll', 'home', '+'])
  check('keymap: combos, keydowns, how they read (main a292ee2)', [L.keymap.parseCombo(combo).id, L.keymap.formatCombo(combo, isMac)], [parseV1(combo).id, formatV1(combo, isMac)], { combo, isMac })
  const e = { code: pick(['KeyA', 'KeyZ', 'Slash', 'Equal', 'Minus', 'Digit0', 'Numpad5', 'NumpadAdd', 'Escape', 'ArrowUp', 'Space', 'PageDown', 'Comma', 'Backquote']), key: pick(['a', 'Z', 'å', '/', '?', '=', '+', '-', '0', 'Escape', 'ArrowUp', ' ', 'Spacebar', 'PageDown', 'ж']), metaKey: rnd() < 0.3, ctrlKey: rnd() < 0.3, altKey: rnd() < 0.2, shiftKey: rnd() < 0.4 }
  check('keymap: combos, keydowns, how they read (main a292ee2)', L.keymap.comboOf(e, isMac), comboOfV1(e, isMac), { e, isMac })
})
run('selection: select, toggle, add; a group turns about its middle (main a292ee2)', () => {
  const ids = ['a', 'b', 'c', 'd']
  const uids = ids.filter(() => rnd() < 0.5)
  const uid = pick([null, '', ...ids])
  const known = rnd() < 0.85
  const how = pick(['set', 'toggle', 'add'])
  const got = L.selection.selectStep({ uids, primary: uids.at(-1) ?? null }, uid, known, how)
  check('selection: select, toggle, add; a group turns about its middle (main a292ee2)', { uids: [...got.uids], primary: got.primary }, selectV1(uids, uid, known, how), { uids, uid, known, how })
  const c = [uni(-5, 5), uni(-5, 5)], x = uni(-5, 5), z = uni(-5, 5), deg = uni(-360, 360)
  check('selection: select, toggle, add; a group turns about its middle (main a292ee2)', [...L.selection.turnAbout(c, x, z, deg)], turnAboutV1({ x: c[0], z: c[1] }, x, z, deg), { c, x, z, deg })
})

let failed = 0
for (const [name, g] of groups) {
  const ok = g.fails.length === 0
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}: ${g.cases} cases${ok ? '' : `\n  ${g.fails.join('\n  ')}`}`)
}
console.log(`engine logic vs v1: ${groups.size - failed}/${groups.size} groups pass (seed ${SEED}, N ${N})`)
process.exit(failed ? 1 : 0)
