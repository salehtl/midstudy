// Panel (area C): Scene, the open photo's camera and how the furniture sits in it. A camera card (where the camera
// came from: the automatic calibration, your own Adjust floor, or a default guess; its height, field of view, tilt and
// roll; Adjust floor… and Calibrate again), then the view toggles (occlusion from the photo's depth, the floor grid) and
// Light & look (contract §4.8): where the light comes from (the photo's lighting.json, the backfill while it runs, or
// the default lights), Auto lighting, the light direction dial (ui/sun-dial.js), strength, softness, ambient, exposure
// and warmth, the floor and contact shadows, Save scene when anything changed and Reset. All of it applies to the
// furniture only, never the photo (§4.5). Styles: styles/scenes.css (.sp-*, .sd-*).
import { quiet } from '../../engine.js'
import { pic, withIcon } from './common.js'
import { ring } from '../icons.js'
import { sunDial } from '../sun-dial.js'
import { sceneTitle, friendlyDate } from '../../data.js'

const warmthWord = (w) => (Math.abs(w) < 0.005 ? 'Neutral' : `${w > 0 ? 'Warm' : 'Cool'} ${Math.abs(w).toFixed(2)}`)
const softWord = (v) => (v < 0.25 ? 'Crisp' : v < 0.6 ? 'Soft' : 'Diffuse')
const SOFT_DETAIL = { Crisp: 'Crisp shadows', Soft: 'Soft shadows', Diffuse: 'Diffuse light, faint shadows' }
const times = (v) => `${v.toFixed(2)}×`
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('-', '−')
const near = (a, b) => Math.abs(a - b) < 1e-3
// the key light's linear colour (largest component 1) as a CSS colour, for the readout's sun
const cssColor = (rgb) => (Array.isArray(rgb) && rgb.length === 3 ? `rgb(${rgb.map((c) => Math.round(255 * Math.min(1, Math.max(0, c)) ** (1 / 2.2))).join(' ')})` : null)

// By touch (the phone's sheet scrolls), a Look slider's native input takes no touches (scenes.css): a vertical swipe
// across it scrolls the sheet and changes nothing, a sideways drag anywhere on the row moves the value by how far the
// finger went (no jump to where it landed). Mouse and keyboard use the native input.
function touchSlide(row, { min, max, step }) {
  let t = null
  const input = row.input
  const snap = (v) => Math.min(max, Math.max(min, Math.round((v - min) / step) * step + min))
  row.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') t = { id: e.pointerId, x: e.clientX, y: e.clientY, v0: Number(input.value), on: false } })
  row.addEventListener('pointermove', (e) => {
    if (!t || e.pointerId !== t.id) return
    const dx = e.clientX - t.x, dy = e.clientY - t.y
    if (!t.on) {
      if (Math.hypot(dx, dy) < 8) return
      if (Math.abs(dx) <= Math.abs(dy)) { t = null; return } // up or down: the sheet scrolls
      t.on = true
      try { row.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    }
    const w = input.getBoundingClientRect().width || 1
    const v = Number(snap(t.v0 + (dx / w) * (max - min)).toFixed(4))
    if (v !== Number(input.value)) { input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })) }
  })
  const end = (e) => { if (t && e.pointerId === t.id) { if (t.on) input.dispatchEvent(new Event('change', { bubbles: true })); t = null } }
  row.addEventListener('pointerup', end)
  row.addEventListener('pointercancel', end)
}

export function mount(ctx) {
  const { engine, scenes, shell, kit } = ctx
  const { h, button, toggle, slider } = kit
  let saving = false
  let calibrating = false
  const panel = shell.registerPanel({ id: 'scene', label: 'Scene', icon: 'room', phoneDetent: 'half', mount: () => {} })
  panel.body.classList.add('sp')

  const camCard = h('section.p-card.sp-cam')
  const toggles = h('section.sp-toggles')
  const occl = toggle({ label: 'Occlusion', hint: 'Things in the photo hide furniture behind them', checked: true, onChange: (v) => engine.setOcclusion(v) })
  const gridT = toggle({ label: 'Floor grid', hint: '50 cm squares on the floor', checked: true, onChange: (v) => engine.setGridVisible(v) })
  toggles.append(h('span.caps', 'View'), occl, gridT)

  // --- Light & look (§4.8): every control keeps its element; renderLook() only sets values, so a drag isn't broken
  const mark = (el, handle) => { el.dataset.midstudy = handle; return el }
  const srcGlyph = h('span.sp-lsrc-glyph')
  const srcText = h('span.sp-lsrc-text')
  const srcDetail = h('span.sp-lsrc-detail')
  const inferB = withIcon(button({ label: 'Infer lighting', kind: 'secondary', onClick: () => quiet(engine.inferLighting()) }), 'retry')
  const src = h('div.sp-lsrc', { role: 'status' }, srcGlyph, h('span.sp-lsrc-words', srcText, srcDetail), inferB)
  const auto = mark(toggle({ label: 'Auto lighting', hint: 'Follows the light in the photo', checked: true, onChange: (v) => engine.setLighting({ auto_light: v }) }), 'light-auto')
  const dial = sunDial({ onChange: ({ az, el }) => engine.setLighting({ light_azimuth_deg: az, light_elevation_deg: el }) })
  const range = (handle, opts) => { const r = slider(opts); mark(r.input, handle); touchSlide(r, opts); return r }
  const strength = range('light-strength', { label: 'Strength', min: 0, max: 3, step: 0.05, value: 1, format: times, onInput: (v) => engine.setLighting({ light_strength: v }) })
  const softness = range('light-softness', { label: 'Softness', min: 0, max: 1, step: 0.01, value: 0.35, format: (v) => `${softWord(v)} · ${v.toFixed(2)}`, onInput: (v) => engine.setLighting({ light_softness: v }) })
  const ambient = range('light-ambient', { label: 'Ambient', min: 0, max: 3, step: 0.05, value: 1, format: times, onInput: (v) => engine.setLighting({ ambient: v }) })
  const exposure = range('look-exposure', { label: 'Exposure', min: 0.25, max: 4, step: 0.05, value: 1, format: times, onInput: (v) => engine.setLighting({ exposure: v }) })
  const warmth = range('look-warmth', { label: 'Warmth', min: -1, max: 1, step: 0.05, value: 0, format: warmthWord, onInput: (v) => engine.setLighting({ warmth: v }) })
  const floorShadow = mark(toggle({ label: 'Floor shadow', hint: "The light's shadow on the floor", checked: true, onChange: (v) => engine.setLighting({ cast_shadows: v }) }), 'light-shadows')
  const contact = mark(toggle({ label: 'Contact shadows', hint: 'A soft shadow under each piece', checked: true, onChange: (v) => engine.setLighting({ contact_shadows: v }) }), 'contact-shadows')
  const saveB = button({ label: 'Save scene', kind: 'primary', onClick: () => quiet(save()) })
  const resetB = mark(withIcon(button({ label: 'Reset', kind: 'secondary', title: 'Back to the light from the photo, and a neutral look', onClick: () => engine.resetLighting() }), 'revert'), 'light-reset')
  const look = h('section.sp-look',
    h('div.sp-look-head', h('span.caps', 'Light & look · furniture only'), h('span.sp-look-note', 'The photo is never changed')),
    src, auto, dial,
    h('div.sp-sliders', strength, softness, ambient, exposure, warmth),
    h('div.sp-shadows', floorShadow, contact),
    h('div.sp-look-actions', saveB, resetB))
  const info = h('p.p-note.sp-info')
  const none = h('p.p-note.sp-none', 'Open a scene to see its camera and look.')
  panel.body.append(camCard, toggles, look, info, none)

  async function save() {
    saving = true
    renderLook()
    try { await engine.saveScene(); shell.toast('Scene saved', { kind: 'ok', id: 'scene-saved', ms: 2500 }) } catch { /* reported */ } finally { saving = false; render() }
  }
  async function recalibrate() {
    calibrating = true
    render()
    try {
      const d = await engine.recalibrate()
      if (d?.calib_status === 'done') shell.toast(engine.getCameraSource() === 'manual' ? 'Calibrated again. Your own camera stays: Reset in Adjust floor uses the new one.' : 'Calibrated again.', { kind: 'ok', id: 'recal' })
    } catch { /* reported */ } finally { calibrating = false; render() }
  }

  function camView() {
    const s = engine.getScene()
    if (!s) return []
    const c = engine.getCamera()
    const src = engine.getCameraSource()
    const calib = s.calib
    const fromWhat = src === 'manual' ? 'Set by hand in Adjust floor'
      : src === 'auto' && calib?.source === 'moge-2' ? `Found in the photo by MoGe-2${calib.device ? ` (${calib.device})` : ''}`
        : src === 'auto' && calib?.source === 'truth' ? 'Exact (a test scene)'
          : src === 'auto' && calib?.source === 'exif' ? "From the lens's focal length (EXIF); height and tilt are guesses"
            : 'A default guess: set the floor by hand'
    const warn = engine.getFloorNote()
    const cell = (k, v) => h('div.sp-cell', h('span.sp-k', k), h('span.sp-v.tnum', v))
    return [
      h('div.sp-cam-head', h('span.caps', 'Camera'), h(`span.sp-src.is-${src}`, src === 'manual' ? 'Manual' : src === 'auto' ? 'Automatic' : 'Default')),
      h('p.sp-from', fromWhat),
      warn && src !== 'manual' ? h('p.sp-warn', pic('warning', { size: 16 }), h('span', warn)) : null,
      h('div.sp-grid', cell('Height', `${Math.round(c.height_m * 100)} cm`), cell('Field of view', `${f1(c.fov_y_deg)}°`), cell('Tilt', `${f1(c.pitch_deg)}°`), cell('Roll', `${f1(c.roll_deg)}°`)),
      h('div.sp-actions',
        withIcon(button({ label: engine.getAdjustFloor() ? 'Adjusting…' : 'Adjust floor…', kind: 'primary', disabled: engine.getAdjustFloor(), onClick: () => ctx.workspace?.setAdjust(true) }), 'pick-floor'),
        withIcon(button({ label: calibrating ? 'Calibrating…' : 'Calibrate again', kind: 'secondary', disabled: calibrating, onClick: () => quiet(recalibrate()) }), 'retry')),
    ]
  }

  // Where the light comes from (§4.8): lighting.json's source, else the backfill's status. Rebuilt only when it changes.
  let srcKey = ''
  function renderSource(l) {
    const inf = l.inferred
    const sun = (tone, color) => { const g = pic('sun', { size: 18 }); g.classList.add(`is-${tone}`); if (color) g.style.color = color; return g }
    let glyph, text, detail = '', failed = false
    if (l.source === 'photo') {
      glyph = sun('photo', cssColor(inf?.color))
      text = `From the photo${Number.isFinite(inf?.cct_k) ? ` · ${Math.round(inf.cct_k / 100) * 100} K` : ''}`
      detail = Number.isFinite(inf?.softness) ? SOFT_DETAIL[softWord(inf.softness)] : ''
    } else if (l.source === 'truth') {
      glyph = sun('photo', cssColor(inf?.color))
      text = 'Exact light (a test scene)'
    } else if (['missing', 'pending', 'running'].includes(l.status)) {
      glyph = ring(null, { size: 16 })
      text = 'Inferring the light from the photo…'
    } else if (l.status === 'none') {
      glyph = sun('default')
      text = 'No clear light in this photo · default lights'
      failed = 'none'
    } else if (l.status === 'failed') {
      glyph = pic('warning', { size: 18 })
      text = "Couldn't infer the light"
      detail = l.error || ''
      failed = true
    } else {
      glyph = sun('default')
      text = 'Default lights'
    }
    const key = [text, detail, failed, glyph.style.color].join('|')
    if (key === srcKey) return
    srcKey = key
    srcGlyph.replaceChildren(glyph)
    srcText.textContent = text
    srcDetail.textContent = detail
    srcDetail.hidden = !detail
    src.classList.toggle('is-failed', failed === true)
    inferB.hidden = !failed
    inferB.querySelector('span').textContent = failed === 'none' ? 'Try again' : 'Infer lighting'
  }

  // The Look's values (every 'look' and 'lighting' event, so many times a second while the dial is dragged).
  function renderLook() {
    if (!engine.getScene()) return
    let l
    try { l = engine.getLighting() } catch { return }
    renderSource(l)
    auto.input.checked = !!l.auto_light
    auto.querySelector('.toggle-hint').textContent = !l.auto_light ? 'Off: your own direction'
      : l.source === 'default' ? 'The default light direction' : 'Follows the light in the photo'
    const inf = l.inferred
    dial.set({ az: l.light_azimuth_deg, el: l.light_elevation_deg, inferred: !l.auto_light && inf ? { az: inf.azimuth_deg, el: inf.elevation_deg } : null })
    strength.set(l.light_strength)
    softness.set(l.light_softness)
    ambient.set(l.ambient)
    exposure.set(l.exposure)
    warmth.set(l.warmth)
    floorShadow.input.checked = !!l.cast_shadows
    contact.input.checked = !!l.contact_shadows
    const dirty = engine.isSceneDirty()
    saveB.hidden = !dirty && !saving
    saveB.disabled = saving
    saveB.querySelector('span').textContent = saving ? 'Saving…' : 'Save scene'
    resetB.disabled = l.auto_light && near(l.light_strength, 1) && near(l.ambient, 1) && near(l.exposure, 1) && near(l.warmth, 0) &&
      l.contact_shadows === true && l.cast_shadows === (l.source !== 'default')
    panel.setStatus(dirty ? h('span.sp-dirty', 'Unsaved') : null)
  }

  function render() {
    const s = engine.getScene()
    none.hidden = !!s
    camCard.hidden = toggles.hidden = look.hidden = info.hidden = !s
    panel.setStatus(s && engine.isSceneDirty() ? h('span.sp-dirty', 'Unsaved') : null)
    if (!s) return
    camCard.replaceChildren(...camView().flat().filter(Boolean))
    occl.input.checked = engine.getOcclusion() && s.hasDepth
    occl.input.disabled = !s.hasDepth
    occl.querySelector('.toggle-hint').textContent = s.hasDepth ? 'Things in the photo hide furniture behind them' : 'This photo has no depth map'
    gridT.input.checked = engine.getGridVisible()
    renderLook()
    const c = s.calib
    const bits = [
      `${sceneTitle(scenes.getScene(s.name) || s)}`,
      `${s.w} × ${s.h} photo`,
      s.hasDepth && c?.depth ? `depth ${c.depth.w} × ${c.depth.h}` : 'no depth',
      c?.device ? `${c.source} on ${c.device}${c.elapsed_s ? `, ${Math.round(c.elapsed_s)} s` : ''}` : null,
      s.created ? `made ${friendlyDate(s.created)}` : null,
    ].filter(Boolean)
    info.textContent = bits.join(' · ')
  }

  const on = (ev, fn) => engine.events.addEventListener(ev, fn)
  for (const ev of ['scene', 'camera', 'occlusion', 'grid', 'adjust']) on(ev, () => { if (panel.isOpen() || ev === 'scene') render() })
  for (const ev of ['look', 'lighting']) on(ev, () => { if (panel.isOpen()) renderLook() })
  on('dirty', () => { if (panel.isOpen()) renderLook(); else panel.setStatus(engine.getScene() && engine.isSceneDirty() ? h('span.sp-dirty', 'Unsaved') : null) })
  shell.events.addEventListener('panel', (e) => { if (e.detail.id === 'scene' && e.detail.open) render() })
  shell.events.addEventListener('mode', render)
  render()
}
