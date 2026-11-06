// Panel (area C): Scene, the open photo's camera and how the furniture sits in it. A camera card (where the camera
// came from: the automatic calibration, your own Adjust floor, or a default guess; its height, field of view, tilt and
// roll; Adjust floor… and Calibrate again), then the view toggles (occlusion from the photo's depth, the floor grid) and
// Light & look (contract §4.8): where the light comes from (the photo's lighting.json, the backfill while it runs, or
// the default lights), Auto lighting, the light direction dial (ui/sun-dial.ts), strength, softness, ambient, exposure
// and warmth, the floor and contact shadows, Save scene when anything changed and Reset. All of it applies to the
// furniture only, never the photo (§4.5). Styles: styles/scenes.css (.sp-*, .sd-*). The words: logic/look.ts.
import { friendlyDate, quiet, sceneTitle, type LightingReport, type UiContext } from '../seam.js'
import type { Slider } from '../kit.js'
import { pic, withIcon } from './common.js'
import { ring } from '../icons.js'
import { sunDial } from '../sun-dial.js'
import { signed1, times } from '../logic/text.js'
import { touchIntent } from '../logic/sundial.js'
import {
  autoHint, calibFacts, cameraBadge, cameraFrom, cssColor, lightSource, lookIsDefault, photoFacts, recalibratedText, slideValue, softnessText, warmthWord,
} from '../logic/look.js'

// By touch (the phone's sheet scrolls), a Look slider's native input takes no touches (scenes.css): a vertical swipe
// across it scrolls the sheet and changes nothing, a sideways drag anywhere on the row moves the value by how far the
// finger went (no jump to where it landed). Mouse and keyboard use the native input.
function touchSlide(row: Slider, { min, max, step }: { readonly min: number; readonly max: number; readonly step: number }): void {
  let t: { readonly id: number; readonly x: number; readonly y: number; readonly v0: number; on: boolean } | null = null
  const input = row.input
  row.addEventListener('pointerdown', (e) => { if (e.pointerType === 'touch') t = { id: e.pointerId, x: e.clientX, y: e.clientY, v0: Number(input.value), on: false } })
  row.addEventListener('pointermove', (e) => {
    if (t?.id !== e.pointerId) return
    const dx = e.clientX - t.x
    const dy = e.clientY - t.y
    if (!t.on) {
      const intent = touchIntent(dx, dy, Math.hypot)
      if (intent === 'wait') return
      if (intent === 'scroll') { t = null; return } // up or down: the sheet scrolls
      t.on = true
      try { row.setPointerCapture(e.pointerId) } catch { /* synthetic pointer */ }
    }
    const w = input.getBoundingClientRect().width || 1
    const v = slideValue(t.v0, dx, w, min, max, step)
    if (v !== Number(input.value)) { input.value = String(v); input.dispatchEvent(new Event('input', { bubbles: true })) }
  })
  const end = (e: PointerEvent): void => {
    if (t?.id !== e.pointerId) return
    if (t.on) input.dispatchEvent(new Event('change', { bubbles: true }))
    t = null
  }
  row.addEventListener('pointerup', end)
  row.addEventListener('pointercancel', end)
}

const mark = <E extends HTMLElement>(el: E, handle: string): E => { el.dataset['midstudy'] = handle; return el }
const setHint = (row: Element, words: string): void => {
  const hint = row.querySelector('.toggle-hint')
  if (hint) hint.textContent = words
}

/** @public planner/main.ts mounts every area: mod.mount(ctx) (knip does not follow the areas list). */
export function mount(ctx: UiContext): void {
  const { engine, scenes, shell, kit } = ctx
  const { h, button, toggle, slider } = kit
  let saving = false
  let calibrating = false
  const panel = shell.registerPanel({ id: 'scene', label: 'Scene', icon: 'room', phoneDetent: 'half', mount: () => { /* filled below */ } })
  panel.body.classList.add('sp')

  const camCard = h('section.p-card.sp-cam')
  const toggles = h('section.sp-toggles')
  const occl = toggle({ label: 'Occlusion', hint: 'Things in the photo hide furniture behind them', checked: true, onChange: (v) => { engine.setOcclusion(v) } })
  const gridT = toggle({ label: 'Floor grid', hint: '50 cm squares on the floor', checked: true, onChange: (v) => { engine.setGridVisible(v) } })
  toggles.append(h('span.caps', 'View'), occl, gridT)

  // --- Light & look (§4.8): every control keeps its element; renderLook() only sets values, so a drag isn't broken
  const srcGlyph = h('span.sp-lsrc-glyph')
  const srcText = h('span.sp-lsrc-text')
  const srcDetail = h('span.sp-lsrc-detail')
  const inferB = withIcon(button({ label: 'Infer lighting', kind: 'secondary', onClick: () => { quiet(engine.inferLighting()) } }), 'retry')
  const src = h('div.sp-lsrc', { role: 'status' }, srcGlyph, h('span.sp-lsrc-words', srcText, srcDetail), inferB)
  const auto = mark(toggle({ label: 'Auto lighting', hint: 'Follows the light in the photo', checked: true, onChange: (v) => { engine.setLighting({ auto_light: v }) } }), 'light-auto')
  const dial = sunDial({ onChange: ({ az, el }) => { engine.setLighting({ light_azimuth_deg: az, light_elevation_deg: el }) } })
  const range = (handle: string, opts: Parameters<typeof slider>[0] & { readonly min: number; readonly max: number; readonly step: number }): Slider => {
    const r = slider(opts)
    mark(r.input, handle)
    touchSlide(r, opts)
    return r
  }
  const strength = range('light-strength', { label: 'Strength', min: 0, max: 3, step: 0.05, value: 1, format: times, onInput: (v) => { engine.setLighting({ light_strength: v }) } })
  const softness = range('light-softness', { label: 'Softness', min: 0, max: 1, step: 0.01, value: 0.35, format: softnessText, onInput: (v) => { engine.setLighting({ light_softness: v }) } })
  const ambient = range('light-ambient', { label: 'Ambient', min: 0, max: 3, step: 0.05, value: 1, format: times, onInput: (v) => { engine.setLighting({ ambient: v }) } })
  const exposure = range('look-exposure', { label: 'Exposure', min: 0.25, max: 4, step: 0.05, value: 1, format: times, onInput: (v) => { engine.setLighting({ exposure: v }) } })
  const warmth = range('look-warmth', { label: 'Warmth', min: -1, max: 1, step: 0.05, value: 0, format: warmthWord, onInput: (v) => { engine.setLighting({ warmth: v }) } })
  const floorShadow = mark(toggle({ label: 'Floor shadow', hint: "The light's shadow on the floor", checked: true, onChange: (v) => { engine.setLighting({ cast_shadows: v }) } }), 'light-shadows')
  const contact = mark(toggle({ label: 'Contact shadows', hint: 'A soft shadow under each piece', checked: true, onChange: (v) => { engine.setLighting({ contact_shadows: v }) } }), 'contact-shadows')
  const saveB = button({ label: 'Save scene', kind: 'primary', onClick: () => { quiet(save()) } })
  const resetB = mark(withIcon(button({ label: 'Reset', kind: 'secondary', title: 'Back to the light from the photo, and a neutral look', onClick: () => { engine.resetLighting() } }), 'revert'), 'light-reset')
  const look = h('section.sp-look',
    h('div.sp-look-head', h('span.caps', 'Light & look · furniture only'), h('span.sp-look-note', 'The photo is never changed')),
    src, auto, dial,
    h('div.sp-sliders', strength, softness, ambient, exposure, warmth),
    h('div.sp-shadows', floorShadow, contact),
    h('div.sp-look-actions', saveB, resetB))
  const info = h('p.p-note.sp-info')
  const none = h('p.p-note.sp-none', 'Open a scene to see its camera and look.')
  panel.body.append(camCard, toggles, look, info, none)

  async function save(): Promise<void> {
    saving = true
    renderLook()
    try { await engine.saveScene(); shell.toast('Scene saved', { kind: 'ok', id: 'scene-saved', ms: 2500 }) } catch { /* reported */ } finally { saving = false; render() }
  }
  async function recalibrate(): Promise<void> {
    calibrating = true
    render()
    try {
      const d = await engine.recalibrate()
      if (d?.calib_status === 'done') shell.toast(recalibratedText(engine.getCameraSource() === 'manual'), { kind: 'ok', id: 'recal' })
    } catch { /* reported */ } finally { calibrating = false; render() }
  }

  function camView(): Node[] {
    const s = engine.getScene()
    if (!s) return []
    const c = engine.getCamera()
    const source = engine.getCameraSource()
    const calib = s.calib
    const warn = engine.getFloorNote()
    const cell = (k: string, v: string): HTMLDivElement => h('div.sp-cell', h('span.sp-k', k), h('span.sp-v.tnum', v))
    const nodes: Node[] = [
      h('div.sp-cam-head', h('span.caps', 'Camera'), h(`span.sp-src.is-${source}`, cameraBadge(source))),
      h('p.sp-from', cameraFrom(source, calib?.source ?? null, calib?.device ?? null)),
    ]
    if (warn && source !== 'manual') nodes.push(h('p.sp-warn', pic('warning', { size: 16 }), h('span', warn)))
    nodes.push(
      h('div.sp-grid', cell('Height', `${String(Math.round(c.height_m * 100))} cm`), cell('Field of view', `${signed1(c.fov_y_deg)}°`), cell('Tilt', `${signed1(c.pitch_deg)}°`), cell('Roll', `${signed1(c.roll_deg)}°`)),
      h('div.sp-actions',
        withIcon(button({ label: engine.getAdjustFloor() ? 'Adjusting…' : 'Adjust floor…', kind: 'primary', disabled: engine.getAdjustFloor(), onClick: () => { ctx.workspace?.setAdjust(true) } }), 'pick-floor'),
        withIcon(button({ label: calibrating ? 'Calibrating…' : 'Calibrate again', kind: 'secondary', disabled: calibrating, onClick: () => { quiet(recalibrate()) } }), 'retry')),
    )
    return nodes
  }

  // Where the light comes from (§4.8): lighting.json's source, else the backfill's status. Rebuilt only when it changes.
  let srcKey = ''
  function renderSource(l: LightingReport): void {
    const inf = l.inferred
    const sun = (tone: string, color: string | null = null): SVGSVGElement => {
      const g = pic('sun', { size: 18 })
      g.classList.add(`is-${tone}`)
      if (color) g.style.color = color
      return g
    }
    const s = lightSource({ source: l.source, status: l.status, error: l.error, cctK: inf?.cct_k ?? null, softness: inf?.softness ?? null })
    const glyph = s.glyph === 'photo' ? sun('photo', cssColor(inf?.color)) : s.glyph === 'busy' ? ring(null, { size: 16 }) : s.glyph === 'default' ? sun('default') : pic('warning', { size: 18 })
    const key = [s.text, s.detail, String(s.failed), glyph.style.color].join('|')
    if (key === srcKey) return
    srcKey = key
    srcGlyph.replaceChildren(glyph)
    srcText.textContent = s.text
    srcDetail.textContent = s.detail
    srcDetail.hidden = !s.detail
    src.classList.toggle('is-failed', s.failed === true)
    inferB.hidden = !s.failed
    const word = inferB.querySelector('span')
    if (word) word.textContent = s.failed === 'none' ? 'Try again' : 'Infer lighting'
  }

  // The Look's values (every 'look' and 'lighting' event, so many times a second while the dial is dragged).
  function renderLook(): void {
    if (!engine.getScene()) return
    let l: LightingReport
    try { l = engine.getLighting() } catch { return }
    renderSource(l)
    auto.input.checked = l.auto_light
    setHint(auto, autoHint(l.auto_light, l.source))
    const inf = l.inferred
    dial.set({ az: l.light_azimuth_deg, el: l.light_elevation_deg, inferred: !l.auto_light && inf ? { az: inf.azimuth_deg, el: inf.elevation_deg } : null })
    strength.set(l.light_strength)
    softness.set(l.light_softness)
    ambient.set(l.ambient)
    exposure.set(l.exposure)
    warmth.set(l.warmth)
    floorShadow.input.checked = l.cast_shadows
    contact.input.checked = l.contact_shadows
    const dirty = engine.isSceneDirty()
    saveB.hidden = !dirty && !saving
    saveB.disabled = saving
    const word = saveB.querySelector('span')
    if (word) word.textContent = saving ? 'Saving…' : 'Save scene'
    resetB.disabled = lookIsDefault(l)
    panel.setStatus(dirty ? h('span.sp-dirty', 'Unsaved') : null)
  }

  function render(): void {
    const s = engine.getScene()
    none.hidden = !!s
    camCard.hidden = !s
    toggles.hidden = !s
    look.hidden = !s
    info.hidden = !s
    panel.setStatus(s && engine.isSceneDirty() ? h('span.sp-dirty', 'Unsaved') : null)
    if (!s) return
    camCard.replaceChildren(...camView())
    occl.input.checked = engine.getOcclusion() && s.hasDepth
    occl.input.disabled = !s.hasDepth
    setHint(occl, s.hasDepth ? 'Things in the photo hide furniture behind them' : 'This photo has no depth map')
    gridT.input.checked = engine.getGridVisible()
    renderLook()
    const c = s.calib
    info.textContent = photoFacts({
      title: sceneTitle(scenes.getScene(s.name) ?? s),
      w: s.w, h: s.h,
      depth: s.hasDepth && c?.depth ? `depth ${String(c.depth.w)} × ${String(c.depth.h)}` : null,
      calib: c?.device ? calibFacts(c.source, c.device, c.elapsed_s) : null,
      made: s.created ? `made ${friendlyDate(s.created)}` : null,
    })
  }

  for (const ev of ['scene', 'camera', 'occlusion', 'grid', 'adjust'] as const) engine.events.addEventListener(ev, () => { if (panel.isOpen() || ev === 'scene') render() })
  for (const ev of ['look', 'lighting'] as const) engine.events.addEventListener(ev, () => { if (panel.isOpen()) renderLook() })
  engine.events.addEventListener('dirty', () => { if (panel.isOpen()) renderLook(); else panel.setStatus(engine.getScene() && engine.isSceneDirty() ? h('span.sp-dirty', 'Unsaved') : null) })
  shell.events.addEventListener('panel', (e) => { if (e.detail.id === 'scene' && e.detail.open) render() })
  shell.events.addEventListener('mode', render)
  render()
}
