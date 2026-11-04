// Panel (area C): Scene, the open photo's camera and how the furniture sits in it. A camera card (where the camera
// came from: the automatic calibration, your own Adjust floor, or a default guess; its height, field of view, tilt and
// roll; Adjust floor… and Calibrate again), then the view toggles (occlusion from the photo's depth, the floor grid,
// contact shadows) and the Look (exposure and warmth, applied to the furniture only, never the photo: contract §4.5),
// with Save when the Look changed. Styles: styles/scenes.css (.sp-*).
import { quiet } from '../../engine.js'
import { pic, withIcon } from './common.js'
import { sceneTitle, friendlyDate } from '../../data.js'

const warmthWord = (w) => (Math.abs(w) < 0.005 ? 'Neutral' : `${w > 0 ? 'Warm' : 'Cool'} ${Math.abs(w).toFixed(2)}`)
const f1 = (v) => (Math.round(v * 10) / 10).toFixed(1).replace('-', '−')

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
  const shadows = toggle({ label: 'Contact shadows', hint: 'A soft shadow under each piece on the floor', checked: true, onChange: (v) => engine.setContactShadows(v) })
  toggles.append(h('span.caps', 'View'), occl, gridT, shadows)
  const exposure = slider({ label: 'Exposure', min: 0.25, max: 2.5, step: 0.05, value: 1, format: (v) => `${v.toFixed(2)}×`, onInput: (v) => engine.setLook({ exposure: v }) })
  const warmth = slider({ label: 'Warmth', min: -1, max: 1, step: 0.05, value: 0, format: warmthWord, onInput: (v) => engine.setLook({ warmth: v }) })
  const lookSave = h('div.sp-look-actions')
  const look = h('section.sp-look', h('div.sp-look-head', h('span.caps', 'Look · furniture only'), h('span.sp-look-note', 'The photo is never changed')), exposure, warmth, lookSave)
  const info = h('p.p-note.sp-info')
  const none = h('p.p-note.sp-none', 'Open a scene to see its camera and look.')
  panel.body.append(camCard, toggles, look, info, none)

  async function save() {
    saving = true
    render()
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
    const l = engine.getLook()
    shadows.input.checked = l.contactShadows
    exposure.set(l.exposure)
    warmth.set(l.warmth)
    const dirty = engine.isSceneDirty()
    lookSave.replaceChildren(...(dirty ? [
      button({ label: saving ? 'Saving…' : 'Save scene', kind: 'primary', disabled: saving, onClick: () => quiet(save()) }),
      button({ label: 'Neutral look', kind: 'quiet', onClick: () => engine.setLook({ exposure: 1, warmth: 0 }) }),
    ] : [button({ label: 'Neutral look', kind: 'quiet', disabled: Math.abs(l.exposure - 1) < 1e-3 && Math.abs(l.warmth) < 1e-3, onClick: () => engine.setLook({ exposure: 1, warmth: 0 }) })]))
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

  for (const ev of ['scene', 'camera', 'occlusion', 'grid', 'look', 'dirty', 'adjust']) engine.events.addEventListener(ev, () => { if (panel.isOpen() || ev === 'scene' || ev === 'dirty') render() })
  shell.events.addEventListener('panel', (e) => { if (e.detail.id === 'scene' && e.detail.open) render() })
  shell.events.addEventListener('mode', render)
  render()
}
