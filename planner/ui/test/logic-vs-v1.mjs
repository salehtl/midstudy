#!/usr/bin/env node
// Differential test of planner/ui/logic/*.ts against v1: each `v1.*` below is the expression the v1 UI used (planner/ui/
// *.js at the fork, 979677c), copied as it was and wrapped as a function of the same inputs. Seeded random inputs (and the
// edge cases listed), every output compared with Object.is / JSON. The logic modules are bundled with esbuild first (their
// `.js` specifiers name `.ts` files), with the kernels' face (core/js/web.ts): what v1 computed in the UI and the
// kernels now own (the horizon drag, the elevation's range, the dial's azimuth wrap and elevation range) is checked
// through them, as the shells call them. Needs `npm run build` (the wasm).
// Run: nix develop -c node planner/ui/test/logic-vs-v1.mjs [--seed N] [--n N]
import { build } from 'esbuild'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const arg = (k, d) => { const i = process.argv.indexOf(k); return i >= 0 ? Number(process.argv[i + 1]) : d }
const SEED = arg('--seed', 7)
const N = arg('--n', 4000)

// --- the logic, bundled ---------------------------------------------------------------------------------------------------
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-logic-'))
const entry = path.join(dir, 'entry.ts')
const mods = ['text', 'chrome', 'workspace', 'sundial', 'scenes', 'layouts', 'library', 'look', 'libforms', 'product', 'renders', 'lists', 'glyphs', 'rooms']
fs.writeFileSync(entry, [...mods.map((m) => `export * as ${m} from ${JSON.stringify(path.join(ROOT, 'planner/ui/logic', `${m}.ts`))}`), `export * as k from ${JSON.stringify(path.join(ROOT, 'core/js/web.ts'))}`].join('\n'))
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', outfile: path.join(dir, 'logic.mjs'), logLevel: 'error' })
const L = await import(path.join(dir, 'logic.mjs'))
fs.rmSync(dir, { recursive: true, force: true })
const K = L.k
K.loadKernelsSync(fs.readFileSync(path.join(ROOT, 'build/wasm/web/midstudy_wasm_web_bg.wasm')))
/** The dial's maths as ui/sun-dial.ts builds it. */
const M = { sin: Math.sin, cos: Math.cos, atan2: Math.atan2, wrapDeg: K.wrapDeg, clampEl: (e) => K.clampLook('light_elevation_deg', e) ?? e }

// --- seeded random inputs -------------------------------------------------------------------------------------------------
let s = SEED >>> 0
const rnd = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
const pick = (xs) => xs[Math.floor(rnd() * xs.length)]
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1))
const num = () => pick([0, -0, 1, -1, 0.5, 1e-7, -1e-7, 0.04999, 0.05, 1e21, -1e21, NaN, Infinity, -Infinity, 2.5, -2.5, 0.25, 82, 90, 5]).valueOf() * (rnd() < 0.5 ? 1 : 0) + (rnd() - 0.5) * pick([1, 10, 100, 1000, 1e6])
const word = () => pick(['', ' ', 'a', 'Oak', 'oak reading lamp', '  bookcase 80 ', 'Bookcase_80', '-x-', 'Évening, lamp by the window', 'naïve café', '日本', '😀 emoji', 'x'.repeat(130), 'tab\tand\nnewline', 'Ä', '  ', 'already.', 'ends!', 'quote”', 'a-b_c d'])
const maybe = (f) => (rnd() < 0.2 ? pick([null, undefined]) : f())
const cmText = () => pick(['', '80', '80,5', '−12', '-3', '1e3', ' 7 ', 'abc', '12cm', '0', '−', ',', '1,2,3', '2−3', '1e−5'])

let checks = 0
const failures = []
function same(name, a, b, input) {
  checks++
  const ok = typeof a === 'number' || typeof b === 'number' ? Object.is(a, b) : JSON.stringify(a) === JSON.stringify(b)
  if (!ok && failures.length < 30) failures.push(`${name}(${JSON.stringify(input)}): v1 ${JSON.stringify(a)} ≠ ts ${JSON.stringify(b)}`)
}

function near(name, a, b, rel, input) {
  checks++
  const ok = Object.is(a, b) || (Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= rel * Math.max(1, Math.abs(a)))
  if (!ok && failures.length < 30) failures.push(`${name}(${JSON.stringify(input)}): v1 ${JSON.stringify(a)} ≠ ts ${JSON.stringify(b)}`)
}

// --- v1, as it was ----------------------------------------------------------------------------------------------------------
const v1 = {
  fmt1: (v) => (Math.round(v * 10) / 10).toFixed(1).replace('-', '−'),
  plural: (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`,
  money: (v) => `$${(Number(v) || 0).toFixed(2)}`,
  times: (v) => `${v.toFixed(2)}×`,
  monogram(name) {
    const words = String(name || '?').trim().split(/[\s_-]+/).filter(Boolean)
    const a = words[0]?.[0] || '?'
    const b = words.length > 1 ? words[1][0] : words[0]?.[1] || ''
    return (a + b).toUpperCase()
  },
  clipText: (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? `${s.slice(0, n - 1)}…` : s },
  cap: (s) => String(s || '').replace(/^\s*\S/, (c) => c.toUpperCase()),
  sentence(s) { const t = v1.cap(String(s || '').trim()); return /[.!?…:”"')]$/.test(t) ? t : `${t}.` },
  andList: (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0] || ''),
  fmtSize: (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`),
  cm: (v) => (Number.isFinite(v) ? String(Math.round(v * 10) / 10) : ''),
  dimsLabel: (c) => (c.h > 0 ? `${v1.cm(c.w)} × ${v1.cm(c.d)} × ${v1.cm(c.h)} cm` : `${v1.cm(c.w)} × ${v1.cm(c.d)} cm, no height`),
  elevParse: (t) => parseFloat(String(t).replace(',', '.').replace('−', '-')),
  rulerParse: (t) => parseFloat(String(t).replace(',', '.')),
  num: (v) => { const x = parseFloat(String(v ?? '').replace(',', '.').replace('−', '-')); return Number.isFinite(x) ? x : null },
  isOffline: (msg) => /isn't answering|could not reach|Failed to fetch|NetworkError/i.test(msg),
  // shell.js
  detentPx(d, usable) { const half = Math.round(usable * 422 / 696); if (d === 'full') return usable; if (d === 'half') return Math.min(half, usable); return Math.min(176, half) },
  settle(hgt, v, usable) {
    const projected = hgt - Math.max(-2, Math.min(2, v)) * 180
    if (projected < v1.detentPx('peek', usable) * 0.55) return null
    return ['peek', 'half', 'full'].reduce((a, b) => (Math.abs(v1.detentPx(b, usable) - projected) < Math.abs(v1.detentPx(a, usable) - projected) ? b : a))
  },
  menu(r, w, hgt, mw, mh, align, above) {
    let x = align === 'end' ? r.right - w : r.left
    x = Math.max(8, Math.min(mw - w - 8, x))
    let y = above || r.bottom + 4 + hgt > mh - 8 ? r.top - 4 - hgt : r.bottom + 4
    y = Math.max(8, y)
    return { x, y }
  },
  tip(r, tw, th, mw, mh, rail) {
    const below = r.bottom + 6 + th < mh
    let o = { x: Math.max(6, Math.min(mw - tw - 6, r.left + r.width / 2 - tw / 2)), y: below ? r.bottom + 6 : r.top - 6 - th }
    if (rail) o = { x: r.right + 6, y: r.top + r.height / 2 - th / 2 }
    return o
  },
  // workspace.js
  chip(el) { const leftS = Math.max(0, 25 - el); return { progress: Math.min(0.95, el / 25), text: leftS > 3 ? `Rendering… · about ${Math.ceil(leftS / 5) * 5} s` : 'Rendering…' } },
  elevCm: (y) => Math.round((y || 0) * 100),
  elevM: (v, max) => Math.min(max * 100, Math.max(0, Math.round(v))) / 100,
  hzRow(py0, dy, s, fov, rectH) { const degPerPx = (360 / Math.PI) * Math.tan((fov * Math.PI) / 360) / Math.max(1, rectH); const gain = Math.min(1, 0.12 / degPerPx); return py0 + (dy / s) * gain },
  grip(s, vr, vw, vh, barTop0, liftR) {
    const c = s.reduce((a, p) => ({ x: a.x + p.x / 4, y: a.y + p.y / 4 }), { x: 0, y: 0 })
    const fr = s[1]
    let dx = fr.x - c.x, dy = fr.y - c.y
    const len = Math.hypot(dx, dy) || 1
    dx /= len; dy /= len
    const maxX = Math.min(vr.x + vr.w, vw, liftR && liftR.width ? liftR.left - 4 : Infinity) - 46
    const maxY = Math.min(vr.y + vr.h, vh, barTop0 - 6) - 46
    const gx = Math.max(Math.max(vr.x, 0) + 2, Math.min(maxX, fr.x + dx * 24 - 22))
    const gy = Math.max(Math.max(vr.y, 0) + 2, Math.min(maxY, fr.y + dy * 24 - 22))
    return { stem: [fr.x + dx * 11, fr.y + dy * 11], gx, gy }
  },
  label(s, gx, gy, lw, lh, barTop, vw, vh, liftR, boxTop) {
    const lx = Math.min(s[0].x, s[1].x)
    let ly = Math.max(...s.map((p) => p.y)) + 10
    if (lx < gx + 40 && lx + lw > gx + 4 && ly < gy + 38) ly = gy + 38
    if (ly + lh > barTop - 8) ly = boxTop - lh - 10
    const rightEdge = liftR && liftR.width ? Math.min(vw - 8, liftR.left - 8) : vw - 8
    return { x: Math.max(8, Math.min(rightEdge - lw, lx)), y: Math.max(8, Math.min(vh - lh - 8, ly)) }
  },
  handle(c, st) {
    const cy = Math.max(st.y + 24, Math.min(st.y + st.h - 24, c[1]))
    const cx = Math.max(st.x + 24, Math.min(st.x + st.w - 24, c[0]))
    const off = c[1] < st.y + 24 ? 'above' : c[1] > st.y + st.h - 24 ? 'below' : ''
    return { x: cx, y: cy, off, text: off ? `Horizon ${off} the photo` : 'Horizon' }
  },
  clip: (r, vw, vh) => `inset(${Math.round(r.y)}px ${Math.round(vw - r.x - r.w)}px ${Math.round(vh - r.y - r.h)}px ${Math.round(r.x)}px)`,
  missing: (it) => (it?.noGlb ? `${it.name} has no GLB model (only a splat), so it shows as a box at its size.` : `${it?.name || 'This piece'} isn't in the library any more, so it shows as a box at its size. Restore it from Library › Recently removed, or Remove it here.`),
  // sun-dial.js
  wrapAz: (a) => { const w = ((((a + 180) % 360) + 360) % 360) - 180; return w === -180 ? 180 : w },
  lightSide: (az) => ['ahead', 'ahead on the right', 'the right', 'behind on the right', 'behind the camera', 'behind on the left', 'the left', 'ahead on the left'][Math.round((((v1.wrapAz(az) + 360) % 360)) / 45) % 8],
  lightWords: (az, el) => (el >= 82 ? 'overhead' : `${v1.lightSide(az)} · ${Math.round(el)}° up`),
  spot(az, el) { const r = ((90 - Math.min(90, Math.max(5, el))) / 85) * 100; const rad = (d) => (d * Math.PI) / 180; return [Math.sin(rad(az)) * r, -Math.cos(rad(az)) * r] },
  fromPointer(dx0, dy0, width, az0) {
    const k = (2 * 112) / width / 100
    const dx = dx0 * k, dy = dy0 * k
    const d = Math.min(1, Math.hypot(dx, dy))
    let az = az0
    if (d > 0.03) az = v1.wrapAz((Math.atan2(dx, -dy) * 180) / Math.PI)
    return { az, el: Math.min(90, Math.max(5, 90 - d * 85)) }
  },
  rays: () => Array.from({ length: 8 }, (_, i) => { const a = (i * Math.PI) / 4; const r1 = (v) => Math.round(v * 10) / 10; return `M${r1(Math.sin(a) * 13.5)} ${r1(-Math.cos(a) * 13.5)}L${r1(Math.sin(a) * 18)} ${r1(-Math.cos(a) * 18)}` }).join(''),
  // layouts.js
  slugify: (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64).replace(/-+$/, ''),
  pretty: (name) => { const s = String(name || '').replace(/-/g, ' '); return s.charAt(0).toUpperCase() + s.slice(1) },
  sortLayouts: (details) => details.slice().sort((a, b) => String(b.updated || '').localeCompare(String(a.updated || '')) || a.name.localeCompare(b.name)),
  // scene.js (panel)
  warmthWord: (w) => (Math.abs(w) < 0.005 ? 'Neutral' : `${w > 0 ? 'Warm' : 'Cool'} ${Math.abs(w).toFixed(2)}`),
  cssColor: (rgb) => (Array.isArray(rgb) && rgb.length === 3 ? `rgb(${rgb.map((c) => Math.round(255 * Math.min(1, Math.max(0, c)) ** (1 / 2.2))).join(' ')})` : null),
  slide(v0, dx, w, min, max, step) { const snap = (v) => Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min)); return Number(snap(v0 + (dx / w) * (max - min)).toFixed(4)) },
  // libsheets.js
  slug: (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64),
  nameFromFile: (n) => n.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/^./, (c) => c.toUpperCase()).slice(0, 120),
  meta(f) {
    const m = { name: f.name.trim(), dims_cm: f.dims }
    const d = m.dims_cm
    const id = v1.slug(f.productSizes && d ? `${m.name} ${+d.w.toFixed(1)}x${+d.d.toFixed(1)}` : m.name)
    if (id) m.id = id
    if (f.category.trim()) m.category = f.category.trim()
    if (f.image) { m.engine = f.engine; if (f.engine === 'trellis2') m.resolution = f.resolution }
    return m
  },
  patch(item, f) {
    const p = {}
    const n = f.name.trim()
    if (n && n !== item.name) p.name = n
    const c = f.category.trim()
    if (c !== (item.category || '')) p.category = c || null
    const d = f.dims
    if (d && ['w', 'd', 'h'].some((k) => Math.abs(d[k] - (item.dims_cm?.[k] ?? 0)) > 1e-6)) p.dims_cm = d
    if (f.turn) p.yaw = f.turn
    if (f.canSwitch && f.render !== (item.default_render || 'glb')) p.default_render = f.render
    return p
  },
  overBudget: (spend, p) => { const used = spend ? (spend.spent_usd || 0) + (spend.reserved_usd || 0) : 0; return !!(spend && p > Math.max(0, spend.cap_usd - used) + 1e-9) },
  // renders.js
  reason: (msg) => (/timed? ?out/i.test(msg) ? 'timed out' : /FAL_KEY/.test(msg) ? 'no fal key' : /budget/i.test(msg) ? "today's budget is used up" : /isn't answering|could not reach/i.test(msg) ? "the server isn't answering" : ''),
  real: (p) => (p && ![/^Image 1 is a photo of a room with 3D models of furniture/, /^Turn this 3D planning render into a photorealistic/].some((re) => re.test(p)) ? p : ''),
  // productsrc.js
  sameDims: (c, v) => !!v && ['w', 'd', 'h'].every((k) => (c[k] > 0 ? Math.abs(c[k] - (v[k] ?? NaN)) < 0.05 : !(v[k] > 0))),
}

// --- comparisons --------------------------------------------------------------------------------------------------------------
const T = L.text, C = L.chrome, W = L.workspace, D = L.sundial
for (let i = 0; i < N; i++) {
  const v = num()
  same('fmt1', v1.fmt1(v), T.signed1(v), v)
  same('times', v1.times(v), T.times(v), v)
  const n = int(-2, 1e6)
  same('plural', v1.plural(n, 'layout'), T.plural(n, 'layout'), n)
  const mv = maybe(num)
  same('money', v1.money(mv), T.money(mv), mv)
  const w = maybe(word)
  same('monogram', v1.monogram(w), T.monogram(w), w)
  same('clipText', v1.clipText(w, 40), T.clipText(w, 40), w)
  same('cap', v1.cap(w), T.cap(w), w)
  same('sentence', v1.sentence(w), T.sentence(w), w)
  const xs = Array.from({ length: int(0, 4) }, word)
  same('andList', v1.andList(xs), T.andList(xs), xs)
  const size = Math.abs(num())
  same('fmtSize', v1.fmtSize(size), T.pageSize(size), size)
  const c = { w: Math.abs(num()), d: Math.abs(num()), h: maybe(num) }
  same('dimsLabel', v1.dimsLabel(c), T.dimsLabel(c), c)
  const t = cmText()
  same('elevParse', v1.elevParse(t), T.readSigned(t), t)
  same('rulerParse', v1.rulerParse(t), T.readDecimal(t), t)
  same('num', v1.num(t), T.readSize(t), t)
  same('isOffline', v1.isOffline(w ?? ''), T.isOfflineText(w ?? ''), w)

  const usable = int(240, 1400)
  for (const d of ['peek', 'half', 'full']) same('detentPx', v1.detentPx(d, usable), C.detentPx(d, usable), [d, usable])
  const hgt = rnd() * 1500 - 100, vel = (rnd() - 0.5) * 8
  same('settle', v1.settle(hgt, vel, usable), C.settleDetent(hgt, vel, usable), [hgt, vel, usable])
  const r = { left: rnd() * 1400 - 50, top: rnd() * 900 - 50, width: rnd() * 300, height: rnd() * 80 }
  const R = { ...r, right: r.left + r.width, bottom: r.top + r.height }
  const mw = int(300, 1500), mh = int(300, 1000), ww = rnd() * 300, hh = rnd() * 300
  for (const align of ['end', 'start']) for (const above of [false, true]) same('menu', v1.menu(R, ww, hh, mw, mh, align, above), C.menuSpot(R, ww, hh, mw, mh, align === 'end', above), [R, ww, hh, mw, mh, align, above])
  for (const rail of [false, true]) same('tip', v1.tip(R, ww, hh, mw, mh, rail), C.tipSpot(R, ww, hh, mw, mh, rail), [R, rail])

  const el = rnd() * 40
  same('chip', v1.chip(el), W.renderChip(el), el)
  const y = maybe(num)
  same('elevCm', v1.elevCm(y), W.elevCm(y ?? null), y)
  // the height field: v1 clamped in the UI, then setElevation stored round(clampElev(y), 6); now the kernels clamp
  same('elevM', Math.round(v1.elevM(v, 4) * 1e6) / 1e6, K.roundTo(K.clampElevation(W.elevMeters(v)), 6), v)
  const py0 = rnd() * 1200, dy = (rnd() - 0.5) * 400, sc = rnd() * 2 + 0.01, fov = 20 + rnd() * 90, rh = rnd() * 1000
  // the kernels' tan (Rust's, in wasm) and V8's Math.tan can differ in the last bit: the row agrees to 1e-12 relative
  near('hzRow', v1.hzRow(py0, dy, sc, fov, rh), K.horizonDragRow(py0, dy, sc, K.horizonDragGain(fov, rh)), 1e-12, [py0, dy, sc, fov, rh])
  const pts = Array.from({ length: 4 }, () => ({ x: rnd() * 1400 - 100, y: rnd() * 900 - 100 }))
  const vr = { x: rnd() * 300, y: rnd() * 100, w: rnd() * 1200, h: rnd() * 800 }
  const lift = rnd() < 0.5 ? null : { left: rnd() * 1400, width: rnd() < 0.2 ? 0 : 56 }
  const barTop = rnd() * 900
  const g1 = v1.grip(pts, vr, mw, mh, barTop, lift)
  const fc = W.frontCorner(pts, Math.hypot)
  const liftLeft = lift && lift.width ? lift.left : null
  const g2 = W.gripSpot(fc, vr, mw, mh, barTop, liftLeft)
  same('grip', { stem: g1.stem, x: g1.gx, y: g1.gy }, { stem: [fc.fr.x + fc.dx * 11, fc.fr.y + fc.dy * 11], x: g2.x, y: g2.y }, [pts, vr, lift])
  const lw = rnd() * 200, lh = rnd() * 60, boxTop = rnd() * 900
  same('label', v1.label(pts, g1.gx, g1.gy, lw, lh, barTop, mw, mh, lift, boxTop), W.labelSpot(pts, g2, lw, lh, barTop, mw, mh, liftLeft, () => boxTop), [pts, lw, lh])
  const hc = [rnd() * 1400, rnd() * 1200 - 200]
  same('handle', v1.handle(hc, vr), W.horizonHandle(hc[0], hc[1], vr), [hc, vr])
  same('clip', v1.clip(vr, mw, mh), W.clipInset(vr, mw, mh), [vr, mw, mh])
  const it = rnd() < 0.2 ? null : { name: pick(['', 'Oak chair', 'x']), noGlb: rnd() < 0.5 }
  same('missing', v1.missing(it), W.missingText(it ? it.name : null, !!it?.noGlb), it)

  const az = (rnd() - 0.5) * 2000, elv = rnd() * 120 - 10
  same('wrapAz', v1.wrapAz(az), M.wrapDeg(az), az)
  same('lightWords', v1.lightWords(az, elv), D.lightWords(az, elv, M), [az, elv])
  same('spot', v1.spot(az, elv), D.spot(az, elv, M), [az, elv])
  const dx0 = (rnd() - 0.5) * 400, dy0 = (rnd() - 0.5) * 400, width = rnd() * 300 + 1
  same('fromPointer', v1.fromPointer(dx0, dy0, width, az), D.fromPointer(dx0, dy0, width, az, M, Math.hypot), [dx0, dy0, width, az])

  const nameCheck = L.layouts.checkName(w ?? '', ['oak', 'evening-lamp-by-the-window'], (x) => v1.pretty(x))
  same('checkName.slug', v1.slugify(w ?? ''), nameCheck.slug, w)
  const details = Array.from({ length: int(0, 6) }, () => ({ name: pick(['a', 'b', 'two-chairs', 'Z', 'é']), updated: maybe(() => pick(['2026-11-05T10:00:00Z', '2026-11-05T09:00:00Z', '', '2025-01-01T00:00:00Z'])) }))
  same('sortLayouts', v1.sortLayouts(details), L.layouts.sortLayouts(details), details)

  same('warmthWord', v1.warmthWord(v), L.look.warmthWord(v), v)
  const rgb = maybe(() => Array.from({ length: pick([2, 3, 3, 3, 4]) }, () => rnd() * 1.4 - 0.2))
  same('cssColor', v1.cssColor(rgb), L.look.cssColor(rgb), rgb)
  const [mn, mx, st] = pick([[0, 3, 0.05], [0, 1, 0.01], [0.25, 4, 0.05], [-1, 1, 0.05]])
  const v0 = mn + rnd() * (mx - mn), sdx = (rnd() - 0.5) * 600, sw = rnd() * 300 || 1
  same('slide', v1.slide(v0, sdx, sw, mn, mx, st), L.look.slideValue(v0, sdx, sw, mn, mx, st), [v0, sdx, sw])

  const dims = rnd() < 0.3 ? null : { w: Math.abs(num()), d: Math.abs(num()), h: Math.abs(num()) }
  const f = { name: word(), dims, category: word(), productSizes: rnd() < 0.5, image: rnd() < 0.7, engine: pick(['idol', 'sam3d', 'trellis2', 'rug']), resolution: pick([512, 1024, 1536]) }
  same('addMeta', v1.meta(f), L.libforms.addMeta(f), f) // JSON: the bytes the server gets
  const item = { name: maybe(word), category: maybe(word), dims_cm: maybe(() => ({ w: Math.abs(num()), d: Math.abs(num()), h: Math.abs(num()) })), default_render: maybe(() => pick(['glb', 'splat', ''])) }
  const ef = { name: word(), category: word(), dims, turn: pick([0, 90, 180, 270]), render: pick(['glb', 'splat']), canSwitch: rnd() < 0.5 }
  const tsPatch = L.libforms.editPatch({ ...ef, itemName: item.name ?? null, itemCategory: item.category ?? null, itemDims: item.dims_cm ?? null, itemRender: item.default_render || 'glb' })
  const v1Patch = v1.patch(item, ef)
  same('editPatch', v1Patch, tsPatch, [item, ef])
  same('editPatch.changes', Object.keys(v1Patch).length > 0, L.libforms.changes(tsPatch), [item, ef])
  const spend = rnd() < 0.2 ? null : { spent_usd: maybe(num), reserved_usd: maybe(num), cap_usd: pick([maybe(num), 0, 5, 0.1]) }
  same('overBudget', v1.overBudget(spend, v), L.libforms.overBudget(spend, v), [spend, v])
  const fileName = pick(['chair.glb', 'oak_reading-chair.final.JPG', '.hidden', 'x', '-y_z.png', 'é.heic'])
  same('nameFromFile', v1.nameFromFile(fileName), L.libforms.nameFromFile(fileName), fileName)

  const msg = pick(['Request timed out', 'time out', 'FAL_KEY missing', "today's budget", "the server isn't answering", 'could not reach x', 'other', ''])
  same('reason', v1.reason(msg), L.renders.failureReason(msg), msg)
  const prompt = maybe(() => pick(['', 'evening light', 'Image 1 is a photo of a room with 3D models of furniture …', 'Turn this 3D planning render into a photorealistic photo', ' Image 1 is a photo of a room with 3D models of furniture']))
  same('ownPrompt', v1.real(prompt), L.renders.ownPrompt(prompt), prompt)

  const cand = { w: Math.abs(num()) + 1, d: Math.abs(num()) + 1, h: maybe(num) ?? null }
  const now = { w: maybe(num) ?? NaN, d: maybe(num) ?? NaN, h: maybe(num) ?? NaN }
  if (rnd() < 0.3) { now.w = cand.w; now.d = cand.d; now.h = cand.h ?? NaN }
  same('sameDims', v1.sameDims(cand, now), L.product.sameDims({ ...cand, label: null, unit_note: null, notes: [], quote: null, source: null }, now), [cand, now])
}
same('rays', v1.rays(), D.sunRays(Math), 'rays')

// --- rooms (contract §4.9; no v1): ui/logic/rooms.ts against the words the contract and docs/ROOMS.md §7 give -----------
{
  const RM = L.rooms
  const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`
  for (let i = 0; i < N; i++) {
    const photos = int(0, 12), calibrating = rnd() < 0.3 ? int(0, photos) : 0, placed = int(0, photos), layouts = int(0, 3)
    const alignStatus = pick(['none', 'pending', 'running', 'done', 'failed'])
    const f = { photos, calibrating, placed, layouts, alignStatus, alignError: rnd() < 0.5 ? null : 'no solver' }
    const busy = calibrating > 0 ? `Calibrating ${plural(calibrating, 'photo')}…` : alignStatus === 'pending' || alignStatus === 'running' ? 'Aligning…' : null
    same('roomBusyText', busy, RM.roomBusyText(f), f)
    const date = pick(['', 'Today, 09:36'])
    same('roomMeta', [date || null, plural(photos, 'photo'), placed < photos ? `${placed} placed` : null, layouts ? plural(layouts, 'layout') : null].filter(Boolean).join(' · '), RM.roomMeta(f, date), [f, date])
    const flag = alignStatus === 'failed' ? 'Alignment failed' : photos > 1 && placed < 2 && calibrating === 0 && alignStatus !== 'pending' && alignStatus !== 'running' ? 'Place the photos' : null
    same('roomFlag', flag, RM.roomFlag(f), f)
    const placedP = rnd() < 0.5, src = pick(['origin', 'solver', 'manual', 'unplaced']), conf = pick([null, 0, 0.2, 0.49, 0.5, 0.9, 1]), solverUnplaced = rnd() < 0.5
    const note = !placedP ? (solverUnplaced ? "The alignment couldn't place this photo: place it on the floor plan" : 'Place this photo on the floor plan')
      : src === 'solver' && conf !== null && conf < 0.5 ? 'This photo may be misplaced: check it on the floor plan' : null
    same('photoNote', note, RM.photoNote(placedP, src, conf, solverUnplaced), [placedP, src, conf, solverUnplaced])
    const title = maybe(word), created = pick(['', 'Sun 26 Oct, 09:36'])
    const t = (title ?? '').trim()
    same('roomTitleText', t || (created ? `Room, ${created}` : '') || 'room-20261106-101530', RM.roomTitleText(title, created, 'room-20261106-101530'), [title, created])
    const k = pick([1, 1.1, 0.9, 1.0004, 0.5, 2.25])
    const pct = Math.round((k - 1) * 1000) / 10
    same('roomScaleText', pct === 0 ? 'The room already reads that length' : `Room scaled ${pct > 0 ? 'up' : 'down'} ${Math.abs(pct)} %: every photo now reads it`, RM.roomScaleText(k), k)
    const idx = int(0, 40)
    same('photoHue', [205, 150, 280, 20, 330, 95, 250, 175, 50][idx % 9], RM.photoHue(idx), idx)
  }
  same('newRoomHelp', 3, RM.newRoomHelp().length, 'help')
  same('newRoomStep', ['Uploading photo 2 of 7…', 'Making the room…', 'Aligning the photos…'], [RM.newRoomStep('upload', 2, 7), RM.newRoomStep('room', 0, 7), RM.newRoomStep('align', 0, 7)], 'steps')
}
for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', 'x']) {
  for (const shift of [false, true]) {
    let az = 170, el = 87
    const step = shift ? 15 : 5
    let handled = true
    if (k === 'ArrowLeft') az = v1.wrapAz(az - step); else if (k === 'ArrowRight') az = v1.wrapAz(az + step); else if (k === 'ArrowUp') el = Math.min(90, Math.max(5, el + step)); else if (k === 'ArrowDown') el = Math.min(90, Math.max(5, el - step)); else if (k === 'PageUp') el = Math.min(90, Math.max(5, el + 15)); else if (k === 'PageDown') el = Math.min(90, Math.max(5, el - 15)); else if (k === 'Home') el = 90; else if (k === 'End') el = 5; else handled = false
    same('dialKey', handled ? { az, el } : null, D.dialKey(k, shift, 170, 87, M), [k, shift])
  }
}

if (failures.length) { console.log(failures.join('\n')); console.log(`logic-vs-v1: FAIL — ${failures.length} difference(s) in ${checks} checks (seed ${SEED})`); process.exit(1) }
console.log(`logic-vs-v1: ok — ${checks} checks, no difference from v1 (seed ${SEED}, ${N} rounds)`)
